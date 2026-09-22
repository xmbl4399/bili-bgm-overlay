/**
 * probe-score-coverage.mjs —— v0 列表的「评分覆盖率」统计
 *
 * 回答的问题：把「隐藏无评分条目」开起来（v1.6.6 起默认开），某个分类/年份**会少掉多少条目**？
 * 直接打 api.bgm.tv/v0 的原始列表逐月统计 `rating.score` 是否存在——不经过页面、不依赖缓存，
 * 所以是这条设置的"影响面上限"（页面上的实际数字还要叠加前端分类过滤，如韩剧的 tag 过滤）。
 *
 * 用法：node tools/probe-score-coverage.mjs [type] [cat] [year]
 *   默认 type=2 cat=1 year=2026（= TV 番剧）
 *   韩剧可试 type=6（真人剧集），cat 传 0 表示不带 cat
 *
 * ⚠️ 本机到 Bangumi 实测固定延迟 ≈ 4.7s、带宽 ≈ 101 KB/s（见 docs/bangumi-list-api-facts.md §8.5），
 *    所以脚本按"每月 1 请求 + 并发 3"来跑；一页不够 100 条时再翻页。
 */
const TYPE = Number(process.argv[2] || 2);
const CAT = Number(process.argv[3] || 1);
const YEAR = Number(process.argv[4] || 2026);
const UA = 'bili-bgm-overlay/score-coverage (https://github.com/xmbl4399/bili-bgm-overlay)';
const PAGE = 100;
const CONC = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchMonth(month) {
  const out = [];
  for (let offset = 0; offset < 1000; offset += PAGE) {
    const url = `https://api.bgm.tv/v0/subjects?type=${TYPE}`
      + (CAT ? `&cat=${CAT}` : '') + `&year=${YEAR}&month=${month}&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status !== 200) throw new Error(`month=${month} HTTP ${r.status}`);
    const j = await r.json();
    const list = Array.isArray(j.data) ? j.data : [];
    out.push(...list);
    const total = Number(j.total) || 0;
    if (list.length < PAGE || offset + PAGE >= total) break;
    await sleep(150);
  }
  const scored = out.filter(o => o && o.rating && Number(o.rating.score) > 0);
  return { month, total: out.length, scored: scored.length, noScore: out.length - scored.length };
}

const months = Array.from({ length: 12 }, (_, i) => i + 1);
const res = [];
for (let i = 0; i < months.length; i += CONC) {
  const batch = months.slice(i, i + CONC);
  res.push(...await Promise.all(batch.map(m => fetchMonth(m).catch(e => ({ month: m, err: String(e.message) })))));
}
res.sort((a, b) => a.month - b.month);

console.log(`\nv0 评分覆盖率（type=${TYPE}${CAT ? ` cat=${CAT}` : ''} year=${YEAR}）`);
console.log('='.repeat(72));
console.log('  月份  条目   有评分  无评分   隐藏后剩余');
let t = 0, s = 0, bad = 0;
for (const r of res) {
  if (r.err) { console.log(`  ${String(r.month).padStart(2)}月  ⚠️ ${r.err}`); bad++; continue; }
  t += r.total; s += r.scored;
  const pct = r.total ? Math.round(r.scored / r.total * 100) : 0;
  console.log(`  ${String(r.month).padStart(2)}月  ${String(r.total).padStart(4)}   `
    + `${String(r.scored).padStart(5)}  ${String(r.noScore).padStart(5)}      ${String(pct).padStart(3)}%`);
}
if (t) {
  console.log('-'.repeat(72));
  console.log(`  合计  ${String(t).padStart(4)}   ${String(s).padStart(5)}  ${String(t - s).padStart(5)}      `
    + `${Math.round(s / t * 100)}%`);
  console.log(`\n⇒ 开启「隐藏无评分条目」后：${t} → ${s} 条（少 ${t - s} 条，−${Math.round((t - s) / t * 100)}%）`);
  console.log('   注：这是 v0 原始列表的口径；页面上还会叠加分类过滤（如韩剧的 tag 过滤），数字会更小。');
}
if (bad) console.log(`\n⚠️ 有 ${bad} 个月请求失败，合计不含这些月份 —— 结论只代表成功的部分。`);
