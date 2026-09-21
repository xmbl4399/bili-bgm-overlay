/**
 * 追查 probe-speed-cover-eps.mjs 暴露的三个疑点：
 *   ① 封面档位：v0 / p1 的 images 各档实际指向哪一档？各档真实下载字节/耗时？
 *      （起因：脚本原先取 medium，后发现两通路档位命名不一致 —— 见主脚本 pickCover()）
 *   ② p1 的集数去哪了？列表项没有 eps/total_episodes，那 info 字符串里是什么？
 *   ③ p1 为什么比 v0 少 16 条？（同口径 year/cat/month）
 *
 * 用法：node tools/probe-cover-tiers.mjs [year] [month] [cat]
 */
const UA = 'bili-bgm-overlay/1.6.2 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const YEAR = Number(process.argv[2]) || 2026;
const MONTH = Number(process.argv[3]) || 7;
const CAT = process.argv[4] || '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = n => (n / 1024).toFixed(1) + ' KB';

async function timed(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ms: performance.now() - t0, bytes: buf.length, text: buf.toString('utf8') };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, bytes: 0, text: '', err: String(e) };
  }
}
const jget = async (u) => { const r = await timed(u); try { return JSON.parse(r.text); } catch { return null; } };

const v0Base = `https://api.bgm.tv/v0/subjects?type=2&cat=${CAT}&year=${YEAR}&month=${MONTH}`;
const p1Base = `https://next.bgm.tv/p1/subjects?type=2&cat=${CAT}&year=${YEAR}&month=${MONTH}`;

/* ══════ ① 封面档位 ══════ */
console.log('\n' + '█'.repeat(72));
console.log('① 封面档位：v0 的 images 五档到底指向什么');
console.log('█'.repeat(72));

const v0j = await jget(`${v0Base}&limit=100&offset=0`);
const v0items = v0j.data || [];
console.log(`  v0 共 ${v0items.length} 条 / total=${v0j.total}`);

for (const it of v0items.slice(0, 2)) {
  console.log(`\n  ── #${it.id} ${it.name_cn || it.name} ──`);
  const im = it.images || {};
  for (const k of ['large', 'common', 'medium', 'small', 'grid']) {
    const v = im[k];
    const tier = (v || '').match(/\/r\/(\d+)\//)?.[1] || (v ? '原图' : '');
    console.log(`    ${k.padEnd(7)} ${(v ? '[' + tier + ']' : '[空]').padEnd(8)} ${v || '(空字符串)'}`);
  }
  console.log(`    ★ 脚本实际取用（pickCover：common 优先）→ ${im.common || im.medium || im.large || im.small || '(无)'}`);
}

console.log('\n  —— 各档真实下载实测（第 1 条，串行）——');
const sample = v0items[0];
const tiers = ['large', 'common', 'medium', 'small', 'grid'];
for (const k of tiers) {
  const u = (sample.images || {})[k];
  if (!u) { console.log(`    ${k.padEnd(7)} (空，跳过)`); continue; }
  const r = await timed(u);
  await sleep(150);
  console.log(`    ${k.padEnd(7)} HTTP ${r.status}  ${kb(r.bytes).padStart(9)}  ${String(Math.round(r.ms)).padStart(6)}ms  ${u}`);
}

/* ══════ ② p1 的集数去哪了 ══════ */
console.log('\n' + '█'.repeat(72));
console.log('② p1 列表项的完整形态（集数是不是藏在 info 里）');
console.log('█'.repeat(72));

const p1j = await jget(`${p1Base}&page=1`);
const p1items = p1j.data || [];
console.log(`  p1 page1 共 ${p1items.length} 条 / total(页数)=${p1j.total}`);
for (const it of p1items.slice(0, 3)) {
  console.log(`\n  ── #${it.id} ${it.nameCN || it.name} ──`);
  console.log(`    全部键: ${Object.keys(it).sort().join(', ')}`);
  console.log(`    eps          ${it.eps ?? '(无此字段)'}`);
  console.log(`    totalEpisodes ${it.totalEpisodes ?? '(无此字段)'}`);
  console.log(`    info         ${JSON.stringify(it.info)}`);
  console.log(`    metaTags     ${JSON.stringify(it.metaTags)}`);
  console.log(`    rating       ${JSON.stringify(it.rating)}`);
}

console.log('\n  —— p1 集数能否从 info 解析？全页扫描 ——');
let infoHasEps = 0, infoSamples = [];
for (const it of p1items) {
  const s = String(it.info || '');
  if (/\d+\s*(话|話|集)/.test(s)) { infoHasEps++; if (infoSamples.length < 6) infoSamples.push(`#${it.id} ${JSON.stringify(s)}`); }
}
console.log(`    info 里含「N话/集」的：${infoHasEps}/${p1items.length}`);
infoSamples.forEach(s => console.log('      ' + s));

console.log('\n  —— 对照：v0 同期的 eps 字段 ——');
const v0Eps = v0items.filter(x => Number(x.eps) || Number(x.total_episodes)).length;
console.log(`    v0 有 eps/total_episodes 的：${v0Eps}/${v0items.length}`);
console.log(`    样例：${v0items.slice(0, 6).map(x => `#${x.id} eps=${x.eps} total=${x.total_episodes}`).join(' ｜ ')}`);

/* ══════ ③ p1 为什么少 16 条 ══════ */
console.log('\n' + '█'.repeat(72));
console.log('③ p1 vs v0 条目数差异（同 cat/year/month）');
console.log('█'.repeat(72));

// v0 全量
const v0all = [];
for (let off = 0; ; off += 100) {
  const j = await jget(`${v0Base}&limit=100&offset=${off}`);
  if (!j || !(j.data || []).length) break;
  v0all.push(...j.data);
  if (v0all.length >= (j.total || 0)) break;
  await sleep(200);
}
// p1 全量（多翻几页，看 total 页数是否可信）
const p1all = [];
let p1Pages = null;
for (let p = 1; p <= 8; p++) {
  const j = await jget(`${p1Base}&page=${p}`);
  if (!j) break;
  if (p === 1) p1Pages = j.total;
  const d = j.data || [];
  console.log(`    p1 page${p}: ${d.length} 条`);
  p1all.push(...d);
  if (!d.length) break;
  await sleep(250);
}
console.log(`\n  v0 total=${v0j.total} 实收 ${v0all.length} 条`);
console.log(`  p1 total(自报页数)=${p1Pages} 实收 ${p1all.length} 条`);
console.log(`  ⇒ ${v0all.length === p1all.length ? '✅ 条数一致' : `⚠️ 差 ${Math.abs(v0all.length - p1all.length)} 条（v0 多/少）`}`);

const sv0 = new Set(v0all.map(x => x.id));
const sp1 = new Set(p1all.map(x => x.id));
const onlyV0 = [...sv0].filter(x => !sp1.has(x));
const onlyP1 = [...sp1].filter(x => !sv0.has(x));
console.log(`  只有 v0 有：${onlyV0.length} 条`);
console.log(`  只有 p1 有：${onlyP1.length} 条`);
if (onlyV0.length) {
  console.log('  —— v0 独有（前 20）——');
  for (const id of onlyV0.slice(0, 20)) {
    const it = v0all.find(x => x.id === id);
    console.log(`    #${id} ${(it.name_cn || it.name || '').slice(0, 30)}  platform=${it.platform}  eps=${it.eps}  date=${it.date}  rating=${it.rating && it.rating.total}`);
  }
}
if (onlyP1.length) {
  console.log('  —— p1 独有 ——');
  for (const id of onlyP1.slice(0, 20)) {
    const it = p1all.find(x => x.id === id);
    console.log(`    #${id} ${(it.nameCN || it.name || '').slice(0, 30)}  rating=${JSON.stringify(it.rating)}`);
  }
}

console.log('\n完成。\n');
