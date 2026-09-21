/**
 * 追查三个点的「确认轮」：
 *   ① 封面档位映射：v0 与 p1 的 images 五档**命名不一致**？多抽几条确认是否稳定。
 *   ② p1 少 16 条的原因：是不是按「收藏数」设了门槛？
 *   ③ 集数口径对比：v0 的 (eps, total_episodes) vs p1 的 info 字符串解析，谁更全更准？
 *
 * 用法：node tools/probe-tier-map-and-diff.mjs [year] [month] [cat]
 */
const UA = 'bili-bgm-overlay/1.6.2 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const YEAR = Number(process.argv[2]) || 2026;
const MONTH = Number(process.argv[3]) || 7;
const CAT = process.argv[4] || '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stat = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] } : null; };

async function jget(u) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const t = await r.text();
    return { status: r.status, j: JSON.parse(t) };
  } catch (e) { return { status: 0, j: null }; }
}

const v0Base = `https://api.bgm.tv/v0/subjects?type=2&cat=${CAT}&year=${YEAR}&month=${MONTH}`;
const p1Base = `https://next.bgm.tv/p1/subjects?type=2&cat=${CAT}&year=${YEAR}&month=${MONTH}`;

/* ═══ 全量拉两侧 ═══ */
const v0all = [];
for (let off = 0; ; off += 100) {
  const r = await jget(`${v0Base}&limit=100&offset=${off}`);
  if (!r.j || !(r.j.data || []).length) break;
  v0all.push(...r.j.data);
  if (v0all.length >= (r.j.total || 0)) break;
  await sleep(200);
}
const p1all = [];
for (let p = 1; p <= 10; p++) {
  const r = await jget(`${p1Base}&page=${p}`);
  if (!r.j) break;
  const d = r.j.data || [];
  if (!d.length) break;
  p1all.push(...d);
  await sleep(250);
}

/* ═══ ① 档位映射 ═══ */
console.log('\n' + '█'.repeat(72));
console.log('① 封面档位映射（v0 vs p1，各抽 4 条确认稳定性）');
console.log('█'.repeat(72));

const tiersOf = (im) => {
  const out = {};
  for (const k of ['large', 'common', 'medium', 'small', 'grid']) {
    const v = im && im[k];
    out[k] = v ? ('r/' + (v.match(/\/r\/(\d+)\//)?.[1] || '原图')) : '空';
  }
  return out;
};

for (const [lab, arr] of [['v0', v0all], ['p1', p1all]]) {
  console.log(`\n  ── ${lab} ──`);
  const seen = new Map();
  for (const it of arr.slice(0, 6)) {
    const t = tiersOf(it.images);
    const key = JSON.stringify(t);
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) === 1) console.log(`    #${it.id}  ${JSON.stringify(t)}`);
  }
  const uniq = [...seen.keys()];
  console.log(`    ⇒ 前 6 条里出现 ${uniq.length} 种档位映射${uniq.length === 1 ? '（完全稳定 ✅）' : '（不稳定 ⚠️）'}`);
}

console.log('\n  ★ 脚本取值 `imgs.medium || imgs.common || ...` 在两条通路上的实际命中：');
const pickV0 = tiersOf(v0all[0]?.images).medium;
const pickP1 = tiersOf(p1all[0]?.images).medium;
console.log(`    v0 通路 → ${pickV0}`);
console.log(`    p1 通路 → ${pickP1}`);
console.log(`    ${pickV0 === pickP1 ? '一致' : '★ 不一致 —— 同一行代码在两条通路上取到不同尺寸！'}`);

/* ═══ ② p1 少 16 条的原因 ═══ */
console.log('\n' + '█'.repeat(72));
console.log('② p1 条目缺口：是不是按收藏数设了门槛');
console.log('█'.repeat(72));

const sv0 = new Set(v0all.map(x => x.id));
const sp1 = new Set(p1all.map(x => x.id));
const onlyV0Arr = v0all.filter(x => !sp1.has(x.id));
const both = v0all.filter(x => sp1.has(x.id));

const votes = (it) => Number(it.rating && it.rating.total) || 0;
const vOnly = onlyV0Arr.map(votes).sort((a, b) => a - b);
const vBoth = both.map(votes).sort((a, b) => a - b);

console.log(`  v0 共 ${v0all.length} 条 ｜ p1 共 ${p1all.length} 条 ｜ 交集 ${both.length} ｜ 仅 v0 有 ${onlyV0Arr.length} 条`);
console.log(`\n  收藏数（rating.total）分布：`);
console.log(`    仅 v0 有 (${vOnly.length} 条):  min=${vOnly[0]}  中位=${stat(vOnly).med}  max=${vOnly[vOnly.length - 1]}`);
console.log(`    两边都有 (${vBoth.length} 条):  min=${vBoth[0]}  中位=${stat(vBoth).med}  max=${vBoth[vBoth.length - 1]}`);
console.log(`\n  仅 v0 有的条目按收藏数排序（全部 ${vOnly.length} 条）:`);
console.log('    ' + vOnly.join(', '));
console.log(`\n  ★ 门槛判定：两边都有的最小收藏数 = ${vBoth[0]}；仅 v0 有的最大收藏数 = ${vOnly[vOnly.length - 1]}`);
if (vOnly[vOnly.length - 1] < vBoth[0]) {
  console.log(`    ⇒ 两个区间**完全不重叠** ✅ 坐实：p1 存在隐藏的收藏数门槛 ≈ ${vBoth[0]}`);
} else {
  console.log(`    ⇒ 区间有重叠 ⚠️ 不能单纯用收藏数解释，另有原因`);
}

/* ═══ ③ 集数口径对比 ═══ */
console.log('\n' + '█'.repeat(72));
console.log('③ 集数口径：v0 的 eps/total_episodes vs p1 的 info 解析');
console.log('█'.repeat(72));

const parseEps = (info) => {
  const m = String(info || '').match(/^\s*(\d+)\s*(话|話|集)/);
  return m ? Number(m[1]) : null;
};

const p1byId = new Map(p1all.map(x => [x.id, x]));
let v0Has = 0, p1Has = 0, bothHave = 0, nV0Only = 0, nP1Only = 0, same = 0, diff = 0;
const diffSamples = [];

for (const it of v0all) {
  const p = p1byId.get(it.id);
  const vEps = Number(it.eps) || Number(it.total_episodes) || null;
  const pEps = p ? parseEps(p.info) : null;
  const vOK = vEps != null, pOK = pEps != null;
  if (vOK) v0Has++;
  if (p && pOK) p1Has++;
  if (vOK && pOK) { bothHave++; if (vEps === pEps) same++; else { diff++; if (diffSamples.length < 8) diffSamples.push(`#${it.id} v0(eps=${it.eps},total=${it.total_episodes})=${vEps} vs p1 info="${String(p.info).slice(0, 20)}..."=${pEps}`); } }
  else if (vOK && !pOK) nV0Only++;
  else if (!vOK && pOK) { nP1Only++; if (diffSamples.length < 12) diffSamples.push(`#${it.id} v0无(p1 info 给了 ${pEps})`); }
}

console.log(`  样本：v0 ${v0all.length} 条（其中 p1 也有 ${both.length} 条）`);
console.log(`\n  v0 侧有集数（eps 或 total_episodes 非 0）   ${v0Has}/${v0all.length}`);
console.log(`  p1 侧 info 可解析出集数                    ${p1Has}/${both.length}（仅统计交集）`);
console.log(`\n  两边都能给出：${bothHave}`);
console.log(`    ├ 数值一致      ${same}  (${bothHave ? (same / bothHave * 100).toFixed(0) : 0}%)`);
console.log(`    └ ★ 数值不一致  ${diff}`);
console.log(`  仅 v0 给得出：${nV0Only}   仅 p1 给得出：${nP1Only}`);
if (diffSamples.length) {
  console.log('\n  差异样例：');
  diffSamples.forEach(s => console.log('    ' + s));
}

/* p1 全量的 info 覆盖率 */
const p1InfoOK = p1all.filter(x => parseEps(x.info) != null).length;
console.log(`\n  p1 全量 ${p1all.length} 条的 info 可解析率：${p1InfoOK}/${p1all.length} (${(p1InfoOK / p1all.length * 100).toFixed(0)}%)`);
const badInfo = p1all.filter(x => parseEps(x.info) == null).slice(0, 5);
if (badInfo.length) {
  console.log('  解析不出的样例：');
  badInfo.forEach(x => console.log(`    #${x.id} ${x.nameCN || x.name}  info=${JSON.stringify(x.info)}`));
}

console.log('\n完成。\n');
