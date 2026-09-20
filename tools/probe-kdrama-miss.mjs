/**
 * 看 platform="电视剧" 里**没**命中「韩国」的条目是谁 —— 判断方案 2 的漏检代价。
 * 另外验证：这些漏检是不是靠 tag 池为空造成的（若是 → 无解；若 tag 里有别的写法 → 可补词）。
 */
const V0 = 'https://api.bgm.tv/v0/subjects';
const UA = 'bili-anime-replace/probe-kdrama-miss';
const KD = /韩剧|韩国/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function month(year, month) {
  const out = []; let offset = 0;
  for (let i = 0; i < 8; i++) {
    const j = await get(`${V0}?type=6&year=${year}&month=${month}&limit=100&offset=${offset}`);
    const list = j.data || [];
    out.push(...list);
    if (list.length < 100 || offset + 100 >= (j.total || 0)) break;
    offset += 100; await sleep(250);
  }
  return out;
}
const tagNames = e => [...new Set([
  ...(Array.isArray(e.tags) ? e.tags : []).map(t => t && t.name).filter(Boolean),
  ...(Array.isArray(e.meta_tags) ? e.meta_tags : []),
])];

const main = async () => {
  const year = Number(process.argv[2]) || 2025;
  let miss = 0, total = 0;
  for (const m of [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const items = await month(year, m);
    for (const e of items.filter(x => x.platform === '电视剧')) {
      total++;
      const names = tagNames(e);
      if (names.some(n => KD.test(n))) continue;
      miss++;
      console.log(`✗ ${year}-${String(m).padStart(2, '0')} ${e.name_cn || e.name}`);
      console.log(`    tag 池(${names.length})：${names.slice(0, 12).join(' / ') || '（空）'}`);
    }
    await sleep(200);
  }
  console.log(`\n${year} 全年 platform=电视剧 ${total} 条，漏检 ${miss} 条 (${total ? Math.round(miss / total * 100) : 0}%)`);
};
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
