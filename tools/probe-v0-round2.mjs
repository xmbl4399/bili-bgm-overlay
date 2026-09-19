/**
 * 第二轮：追查三个决定性问题
 *   A. v0 的 limit 真实上限（能否一次拉完一个月甚至一整年）
 *   B. p1 的 metaTags（驼峰）与 v0 的 meta_tags（下划线）是否同源、p1 是否也带重复
 *   C. v0 对 cat=1/2/3/5 与「无 month 只按年」的可用性
 */
const UA = 'bili-bgm-overlay/1.3.0 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const YEAR = process.argv[2] || '2026';
const get = async (url) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: r.status, ms: Date.now() - t0, j, kb: +(txt.length / 1024).toFixed(1) };
  } catch (e) { return { status: 0, err: String(e) }; }
};
const V0 = (q) => `https://api.bgm.tv/v0/subjects?type=2&${q}`;
const P1 = (q) => `https://next.bgm.tv/p1/subjects?type=2&${q}`;

console.log('=== A. limit 真实上限（一个月 total=70） ===');
for (const lim of [50, 100, 200, 500]) {
  const r = await get(V0(`cat=1&year=${YEAR}&month=1&limit=${lim}`));
  console.log(`  limit=${String(lim).padEnd(4)} HTTP ${r.status} data=${r.j?.data?.length ?? '?'} total=${r.j?.total} ${r.kb}KB ${r.ms}ms`);
}
console.log('\n  —— 无 month（只按年 total=?）能否一次拉完 ——');
for (const lim of [100, 400, 1000]) {
  const r = await get(V0(`cat=1&year=${YEAR}&limit=${lim}`));
  console.log(`  limit=${String(lim).padEnd(4)} HTTP ${r.status} data=${r.j?.data?.length ?? '?'} total=${r.j?.total} ${r.kb}KB ${r.ms}ms`);
}

console.log('\n=== B. p1 的 metaTags 形态 / 与 v0 meta_tags 是否一致 ===');
{
  const v = await get(V0(`cat=1&year=${YEAR}&month=1&limit=10`));
  const p = await get(P1(`cat=1&year=${YEAR}&month=1&page=1`));
  console.log('  p1 首条字段:', Object.keys(p.j?.data?.[0] || {}).sort().join(', '));
  const vMap = new Map(v.j.data.map(x => [x.id, x]));
  const pMap = new Map((p.j.data || []).map(x => [x.id, x]));
  console.log('  v0 total=' + v.j.total + ' ｜ p1 total=' + p.j.total + '（p1 语义为总页数，x24 = ' + (p.j.total * 24) + '）');
  console.log('  —— 同 id 逐条比对 ——');
  let same = 0, diff = 0, pDup = 0;
  for (const [id, pi] of pMap) {
    const vi = vMap.get(id);
    if (!vi) continue;
    const pm = pi.metaTags || [], vm = [...new Set(vi.meta_tags || [])];
    const pd = [...new Set(pm)];
    if (pm.length !== pd.length) pDup++;
    const eq = JSON.stringify(pd) === JSON.stringify(vm);
    if (eq) same++; else { diff++; if (diff <= 5) {
      console.log(`    ✗ [${id}] ${String(pi.name_cn || pi.name).slice(0, 14)}`);
      console.log(`       p1 原始(${pm.length})=${JSON.stringify(pm)}`);
      console.log(`       p1 去重(${pd.length})=${JSON.stringify(pd)}`);
      console.log(`       v0 去重(${vm.length})=${JSON.stringify(vm)}`);
    } }
  }
  console.log(`  比对完成：一致 ${same} 条 / 不一致 ${diff} 条 ｜ p1 metaTags 自带重复的 ${pDup} 条`);
}

console.log('\n=== C. v0 各分类 × 有月/无月 可用性 ===');
for (const [cat, label] of [[1, 'TV'], [5, 'WEB'], [2, 'OVA'], [3, '剧场版']]) {
  const a = await get(V0(`cat=${cat}&year=${YEAR}&month=1&limit=5`));
  const b = await get(V0(`cat=${cat}&year=${YEAR}&limit=5`));
  console.log(`  ${label.padEnd(4)} 有月: HTTP ${a.status} total=${a.j?.total} 首条=${a.j?.data?.[0] ? (a.j.data[0].name_cn || a.j.data[0].name).slice(0, 12) : '-'}` +
    ` ｜ 无月: HTTP ${b.status} total=${b.j?.total} 首条=${b.j?.data?.[0] ? (b.j.data[0].name_cn || b.j.data[0].name).slice(0, 12) : '-'}`);
}

console.log('\n=== D. 历史年份（2023）在 v0 上是否也有 tags ===');
{
  const r = await get(V0(`cat=1&year=2023&month=4&limit=3`));
  console.log('  HTTP ' + r.status + ' total=' + r.j?.total);
  for (const it of (r.j?.data || [])) {
    console.log(`    [${it.id}] ${String(it.name_cn || it.name).slice(0, 16).padEnd(18)} tags=${(it.tags || []).length} 个  meta_tags去重后=${[...new Set(it.meta_tags || [])].length} 个`);
    console.log(`       tags Top8: ${(it.tags || []).slice(0, 8).map(t => t.name + ':' + t.count).join(' ')}`);
  }
}
