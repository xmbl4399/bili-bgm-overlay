/**
 * 对比 v0 / p1 两个列表接口「**只为拿封面 + 集数**」的速度成本。
 *
 * 背景：选 v0 优先是因为它列表项自带全量 tags；但 v0 响应体积是 p1 的 7 倍。
 * 那么如果**不看 tag 覆盖**、只关心封面图和集数呢？这个脚本量这件事。
 *
 *   v0  https://api.bgm.tv/v0/subjects?type=&cat=&year=&month=&limit=&offset=   100/页
 *   p1  https://next.bgm.tv/p1/subjects?type=&cat=&year=&month=&page=           24/页
 *
 * 量：请求数 / 总字节 / 墙钟耗时 / 封面命中率 / 集数命中率 / 纯封面+集数有效载荷。
 *
 * 用法：node tools/probe-speed-cover-eps.mjs [year] [month] [cat] [rounds]
 *   例：node tools/probe-speed-cover-eps.mjs 2026 7 1 3      # 2026 七月 TV 新番，跑 3 轮
 *       node tools/probe-speed-cover-eps.mjs 2026 7 all 3    # 不带 cat（全类型）
 */
const UA = 'bili-bgm-overlay/1.6.2 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';

const YEAR = Number(process.argv[2]) || 2026;
const MONTH = Number(process.argv[3]) || 7;
const CATARG = process.argv[4] || '1';
const CAT = CATARG === 'all' ? '' : CATARG;
const ROUNDS = Math.max(1, Number(process.argv[5]) || 3);
const CONCURRENT = 2;            // 与脚本 cfg.concurrent 默认值一致

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = n => (n / 1024).toFixed(1) + ' KB';
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** 单请求计时：用 arrayBuffer 拿**真实传输字节**，不是字符串长度 */
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

const v0Url = (off) => `https://api.bgm.tv/v0/subjects?type=2${CAT ? '&cat=' + CAT : ''}`
  + `&year=${YEAR}&month=${MONTH}&limit=100&offset=${off}`;
const p1Url = (page) => `https://next.bgm.tv/p1/subjects?type=2${CAT ? '&cat=' + CAT : ''}`
  + `&year=${YEAR}&month=${MONTH}&page=${page}`;

/* ── 两侧的取数口径：只留「封面 + 集数」 ───────────────────────── */
const slimOfV0 = (e) => ({
  id: e.id,
  cover: (e.images && (e.images.medium || e.images.common || e.images.large)) || '',
  eps: Number(e.eps) || Number(e.total_episodes) || null,
});
const slimOfP1 = (e) => ({
  id: e.id,
  cover: (e.images && (e.images.medium || e.images.common || e.images.large))
    || e.image || e.cover || '',
  eps: Number(e.eps) || Number(e.totalEpisodes) || Number(e.total_episodes) || null,
});

/** 有效载荷 = 只有 id/封面URL/集数 这三个字段时的 JSON 字节数 */
const payloadBytes = (slim) => Buffer.byteLength(JSON.stringify(slim), 'utf8');
const summarize = (slim) => ({
  n: slim.length,
  withCover: slim.filter(x => x.cover).length,
  withEps: slim.filter(x => x.eps != null).length,
  payload: payloadBytes(slim),
});

/* ── v0：单请求（limit=100），只在超过 100 条时才补 offset ── */
async function runV0() {
  const t0 = performance.now();
  let reqs = 0, bytes = 0, all = [], off = 0, total = null;
  for (;;) {
    const res = await timed(v0Url(off));
    reqs++; bytes += res.bytes;
    if (res.status !== 200) return { err: 'HTTP ' + res.status + (res.err ? ' ' + res.err : ''), reqs, bytes, ms: performance.now() - t0 };
    const j = JSON.parse(res.text);
    total = j.total;
    const d = j.data || [];
    all.push(...d);
    off += d.length;
    if (!d.length || all.length >= total || reqs > 20) break;
    await sleep(120);                       // 轻微退避，别把对方打急
  }
  return { ms: performance.now() - t0, reqs, bytes, total, raw: all, slim: all.map(slimOfV0) };
}

/* ── p1：24/页翻页，并发 2（与脚本 makeQueue 行为一致） ── */
async function runP1() {
  const t0 = performance.now();
  const first = await timed(p1Url(1));
  if (first.status !== 200) return { err: 'HTTP ' + first.status + (first.err ? ' ' + first.err : ''), reqs: 1, bytes: first.bytes, ms: performance.now() - t0 };
  let reqs = 1, bytes = first.bytes;
  const j1 = JSON.parse(first.text);
  const pages = j1.total;                    // p1 的 total = **总页数**
  const all = (j1.data || []).slice();

  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);
  for (let i = 0; i < rest.length; i += CONCURRENT) {
    const batch = rest.slice(i, i + CONCURRENT);
    const rs = await Promise.all(batch.map(p => timed(p1Url(p))));
    for (const r of rs) {
      reqs++; bytes += r.bytes;
      try { all.push(...(JSON.parse(r.text).data || [])); } catch { /* 忽略单页解析失败 */ }
    }
  }
  return { ms: performance.now() - t0, reqs, bytes, total: pages, raw: all, slim: all.map(slimOfP1) };
}

/* ── 封面图本身：抽 3 张量真实下载字节与耗时 ── */
async function probeCoverImages(slim) {
  const picks = slim.filter(x => x.cover).slice(0, 3);
  const out = [];
  for (const p of picks) {
    const res = await timed(p.cover);        // 复用 timed：arrayBuffer 计真实字节
    out.push({ id: p.id, url: p.cover, bytes: res.bytes, ms: res.ms, status: res.status });
  }
  return out;
}

/* ════════════════════════ 跑 ════════════════════════ */
console.log('\n' + '█'.repeat(74));
console.log(`  v0 vs p1：只为「封面 + 集数」的速度对比`);
console.log(`  样本：year=${YEAR} month=${MONTH} cat=${CAT || '(全部)'} type=2 ｜ 每侧 ${ROUNDS} 轮 ｜ p1 并发 ${CONCURRENT}`);
console.log('█'.repeat(74));

// 预热：握手 + DNS 各走一次，不计入计时
await timed(v0Url(0)); await timed(p1Url(1)); await sleep(400);

const v0runs = [], p1runs = [];
for (let i = 0; i < ROUNDS; i++) {
  v0runs.push(await runV0());
  await sleep(300);
  p1runs.push(await runP1());
  await sleep(300);
  process.stdout.write(`  第 ${i + 1}/${ROUNDS} 轮完成\n`);
}

const show = (label, runs, slimFn) => {
  const okruns = runs.filter(r => !r.err);
  if (!okruns.length) return console.log(`\n【${label}】全部失败: ${runs[0].err}`);
  const last = okruns[okruns.length - 1];
  const s = summarize(last.slim);
  console.log('\n' + '─'.repeat(74));
  console.log(`【${label}】`);
  console.log('─'.repeat(74));
  console.log(`  命中总数（接口自报）     ${last.total}`);
  console.log(`  实际收到条目             ${s.n}`);
  console.log(`  请求数                   ${okruns.map(r => r.reqs).join(' / ')}   中位 ${med(okruns.map(r => r.reqs))}`);
  console.log(`  总字节                   ${okruns.map(r => kb(r.bytes)).join(' / ')}   中位 ${kb(med(okruns.map(r => r.bytes)))}`);
  console.log(`  ★ 墙钟耗时               ${okruns.map(r => Math.round(r.ms) + 'ms').join(' / ')}   中位 ${Math.round(med(okruns.map(r => r.ms)))}ms`);
  console.log(`  封面命中                 ${s.withCover}/${s.n}`);
  console.log(`  集数命中                 ${s.withEps}/${s.n}`);
  console.log(`  ★ 纯封面+集数有效载荷     ${kb(s.payload)}  （占响应 ${(s.payload / med(okruns.map(r => r.bytes)) * 100).toFixed(1)}%）`);
  return { okruns, s, last };
};

const A = show('v0  api.bgm.tv/v0/subjects （100/页）', v0runs);
const B = show('p1  next.bgm.tv/p1/subjects （24/页，并发 2）', p1runs);

/* ── 字段形态 dump ── */
console.log('\n' + '─'.repeat(74));
console.log('【字段形态】');
console.log('─'.repeat(74));
for (const [lab, r] of [['v0', v0runs.find(x => !x.err)], ['p1', p1runs.find(x => !x.err)]]) {
  if (!r || !r.raw.length) { console.log(`  ${lab}: 无数据`); continue; }
  const it = r.raw[0];
  console.log(`  ${lab} item 键      ${Object.keys(it).sort().join(', ')}`);
  const imgs = it.images || (it.image ? { image: it.image } : null);
  console.log(`  ${lab} 封面字段    ${imgs ? JSON.stringify(imgs).slice(0, 220) : '(无)'}`);
}

/* ── 关键判定 ── */
if (A && B && !A.okruns[0]?.err && !B.okruns[0]?.err) {
  const mv = med(A.okruns.map(r => r.ms)), mp = med(B.okruns.map(r => r.ms));
  const bv = med(A.okruns.map(r => r.bytes)), bp = med(B.okruns.map(r => r.bytes));
  console.log('\n' + '█'.repeat(74));
  console.log('  结论');
  console.log('█'.repeat(74));
  console.log(`  请求数    v0 ${med(A.okruns.map(r => r.reqs))}  vs  p1 ${med(B.okruns.map(r => r.reqs))}`);
  console.log(`  传输字节  v0 ${kb(bv)}  vs  p1 ${kb(bp)}      （v0 / p1 = ${(bv / bp).toFixed(2)}×）`);
  console.log(`  墙钟耗时  v0 ${Math.round(mv)}ms  vs  p1 ${Math.round(mp)}ms`);
  console.log(`  ⇒ 快的是  ${mv <= mp ? '★ v0' : '★ p1'}（快 ${Math.abs(mv - mp)}ms，${(Math.max(mv, mp) / Math.min(mv, mp)).toFixed(2)}×）`);
  console.log(`  数据量     v0 ${A.s.n} 条  vs  p1 ${B.s.n} 条${A.s.n === B.s.n ? '  ✅ 一致' : '  ⚠️ 不一致'}`);
  console.log(`  有效载荷   v0 ${kb(A.s.payload)}  vs  p1 ${kb(B.s.payload)}   （纯封面+集数，不含 tag）`);
}

/* ── 封面图实测 ── */
console.log('\n' + '─'.repeat(74));
console.log('【封面图本体】（v0 侧抽 3 张，量真实下载体积）');
console.log('─'.repeat(74));
if (A) {
  const imgs = await probeCoverImages(A.last.slim);
  for (const c of imgs) console.log(`  #${c.id}  HTTP ${c.status}  ${kb(c.bytes)}  ${Math.round(c.ms)}ms  ${c.url}`);
  const avg = imgs.length ? imgs.reduce((s, c) => s + c.bytes, 0) / imgs.length : 0;
  if (avg) console.log(`  平均 ${kb(avg)} / 张 ⇒ ${A.s.n} 张合计约 ${kb(avg * A.s.n)}`);
}

console.log('\n完成。\n');
