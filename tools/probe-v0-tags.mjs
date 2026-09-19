/**
 * 深挖 v0 列表接口：tags 的完整形态、meta_tags 重复规律、limit 上限、分页语义。
 * 用法：node tools/probe-v0-tags.mjs [year] [cat]
 */
const UA = 'bili-bgm-overlay/1.3.0 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const YEAR = process.argv[2] || '2026';
const CAT = process.argv[3] || '1';

const get = async (url) => {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: r.status, ms: Date.now() - t0, j, len: txt.length };
};
const V0 = (q) => `https://api.bgm.tv/v0/subjects?type=2&cat=${CAT}&${q}`;

console.log('=== ① 一整条 tags 元素长什么样（原始） ===');
{
  const r = await get(V0(`year=${YEAR}&month=1&limit=1&offset=1`));
  const it = r.j.data[0];
  console.log('条目:', it.name_cn || it.name);
  console.log('tags[0] 原文:', JSON.stringify(it.tags[0]));
  console.log('tags[1] 原文:', JSON.stringify(it.tags[1]));
  console.log('tags 全部 name:', it.tags.map(t => t.name).join(' | '));
  console.log('count 与 total_count 是否总是相等:', it.tags.every(t => t.count === t.total_count) ? '是' : '否 → 反例 ' + JSON.stringify(it.tags.filter(t => t.count !== t.total_count).slice(0, 3)));
}

console.log('\n=== ② limit 上限探测 ===');
for (const lim of [20, 30, 50, 100]) {
  const r = await get(V0(`year=${YEAR}&month=1&limit=${lim}`));
  console.log(`  limit=${String(lim).padEnd(4)} → HTTP ${r.status}  data=${r.j?.data?.length ?? '?'}  total=${r.j?.total}  body=${(r.len / 1024).toFixed(1)}KB  ${r.ms}ms`);
}

console.log('\n=== ③ 分页语义：offset 是否有效 ===');
{
  const a = await get(V0(`year=${YEAR}&month=1&limit=5&offset=0`));
  const b = await get(V0(`year=${YEAR}&month=1&limit=5&offset=5`));
  console.log('  offset=0 首条:', a.j.data[0].name_cn || a.j.data[0].name);
  console.log('  offset=5 首条:', b.j.data[0].name_cn || b.j.data[0].name);
  console.log('  两组是否重叠:', a.j.data.some(x => b.j.data.find(y => y.id === x.id)) ? '有重叠(offset 无效?)' : '无重叠 ✅');
}

console.log('\n=== ④ meta_tags 重复规律（拉 3 页共 60 条统计） ===');
{
  const all = [];
  for (let off = 0; off < 60; off += 20) {
    const r = await get(V0(`year=${YEAR}&month=1&limit=20&offset=${off}`));
    all.push(...(r.j.data || []));
  }
  const stat = { dupNamed: [], noDup: [], empty: [] };
  for (const it of all) {
    const m = it.meta_tags || [];
    const uniq = [...new Set(m)];
    if (!m.length) stat.empty.push(it);
    else if (uniq.length !== m.length) stat.dupNamed.push({ it, m, uniq });
    else stat.noDup.push({ it, m });
  }
  console.log(`  共 ${all.length} 条：meta_tags 有重复 ${stat.dupNamed.length} 条 ｜ 无重复 ${stat.noDup.length} 条 ｜ 空 ${stat.empty.length} 条`);
  console.log('  —— 有重复者的形态（前 6 条）——');
  for (const { it, m, uniq } of stat.dupNamed.slice(0, 6)) {
    console.log(`    ${String(it.name_cn || it.name).slice(0, 16).padEnd(18)} 原始${String(m.length).padStart(2)}个=${JSON.stringify(m)}`);
    console.log(`    ${''.padEnd(18)} 去重后${String(uniq.length).padStart(2)}个=${JSON.stringify(uniq)}`);
  }
  console.log('  —— 无重复者的形态（前 6 条）——');
  for (const { it, m } of stat.noDup.slice(0, 6)) {
    console.log(`    ${String(it.name_cn || it.name).slice(0, 16).padEnd(18)} ${String(m.length).padStart(2)}个=${JSON.stringify(m)}`);
  }
  console.log('  —— 重复规律判定 ——');
  const dupLens = [...new Set(stat.dupNamed.map(x => x.m.length))].sort((a, b) => a - b);
  console.log('    有重复者的 meta_tags 长度集合:', dupLens.join(','));
  console.log('    无重复者的 meta_tags 长度集合:', [...new Set(stat.noDup.map(x => x.m.length))].sort((a, b) => a - b).join(','));
  const pairDup = stat.dupNamed.every(({ m }) => m.length % 2 === 0 && m.every((v, i) => m[i + 1] === undefined || (i % 2 === 0 ? v === m[i + 1] : true)));
  console.log('    是否「两两相邻成对重复」:', pairDup ? '是 ✅（每词恰好出现 2 次且相邻）' : '否');
}

console.log('\n=== ⑤ 有 tags 没 tags 的条目占比（60 条） ===');
{
  const all = [];
  for (let off = 0; off < 60; off += 20) {
    const r = await get(V0(`year=${YEAR}&month=1&limit=20&offset=${off}`));
    all.push(...(r.j.data || []));
  }
  const withTags = all.filter(x => Array.isArray(x.tags));
  const lens = [...new Set(withTags.map(x => x.tags.length))].sort((a, b) => a - b);
  console.log(`  有 tags 字段: ${withTags.length}/${all.length} ｜ tags 长度取值: ${lens.join(',')}`);
  const m0 = all.filter(x => !(x.meta_tags || []).length).length;
  console.log(`  meta_tags 为空的: ${m0}/${all.length}`);
}

console.log('\n=== ⑥ 列表 tags vs 详情接口 是否同源 ===');
{
  const r = await get(V0(`year=${YEAR}&month=1&limit=3`));
  for (const it of r.j.data) {
    const d = await get(`https://next.bgm.tv/p1/subjects/${it.id}`);
    const dTags = (d.j?.tags || []).map(t => `${t.name}:${t.count}`).join(' ');
    const lTags = (it.tags || []).map(t => `${t.name}:${t.count}`).join(' ');
    console.log(`  [${it.id}] ${String(it.name_cn || it.name).slice(0, 14)}`);
    console.log(`     列表 tags(${(it.tags || []).length}): ${lTags.slice(0, 110)}`);
    console.log(`     详情 tags(${(d.j?.tags || []).length}): ${dTags.slice(0, 110)}`);
    console.log(`     完全一致: ${dTags === lTags ? '✅ 是' : '❌ 否'}`);
  }
}
