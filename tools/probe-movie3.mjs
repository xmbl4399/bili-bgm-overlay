/**
 * ★ 决定性问题：电影怎么拉？
 *   猜想：cat=1/2/3 只在"date 落在该年"时命中；电影条目 date 常为未来/空 ⇒ 被年份过滤掉
 *   验证：① 2026 三个 cat 里的电影数量  ② 电影条目 date 分布  ③ v0 是否支持无 year 只分页
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};
const ALL = async (type, cat, year) => {
  const out = [];
  for (let off = 0; off < 700; off += 100) {
    const u = `https://api.bgm.tv/v0/subjects?type=${type}&cat=${cat}${year ? `&year=${year}` : ''}&limit=100&offset=${off}`;
    const r = await get(u);
    if (r.status !== 200) break;
    const j = JSON.parse(r.body);
    const arr = j.data || [];
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out;
};

(async () => {
  console.log('== ① 2026 三个 cat 的 platform 分布 ==');
  const buckets = {};
  for (const c of [1, 2, 3]) {
    const arr = await ALL(6, c, 2026);
    for (const x of arr) { const k = x.platform || '(无)'; buckets[k] = (buckets[k] || 0) + 1; }
    const s = {};
    for (const x of arr) { const k = x.platform || '(无)'; s[k] = (s[k] || 0) + 1; }
    console.log(`  cat=${c}: ${arr.length} 条 → ${Object.entries(s).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}×${v}`).join('  ')}`);
  }
  console.log('  合计:', Object.entries(buckets).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}×${v}`).join('  '));

  console.log('\n== ② 电影条目 date 分布（2026 抽样）==');
  const all26 = [];
  for (const c of [1, 2, 3]) all26.push(...(await ALL(6, c, 2026)));
  const movies = all26.filter(x => x.platform === '电影');
  console.log(`  2026 电影命中 ${movies.length} 条`);
  for (const m of movies.slice(0, 8)) console.log(`    [${m.id}] ${(m.name_cn||m.name).slice(0,22).padEnd(24)} date=${m.date} cat?`);
  const dates = movies.map(m => m.date || '(空)');
  console.log(`  样例 date: ${dates.slice(0,12).join(' ')}`);

  console.log('\n== ③ 无 year 时 v0 是否可用（分页取全量 type=6，找电影总量）==');
  const noYear = await ALL(6, 1, null);
  console.log(`  type=6 cat=1 无 year → 拉到 ${noYear.length} 条（分页上限内）`);
  const dist = {};
  for (const x of noYear) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
  console.log(`  platform 分布: ${Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}×${v}`).join('  ')}`);

  console.log('\n== ④ 电影能否通过 cat=1 无 year 拉到、且 date 落在 2024？抽查 ==');
  const y24 = await ALL(6, 1, 2024);
  console.log(`  cat=1 year=2024 → ${y24.length} 条, 非日剧的: ${JSON.stringify(y24.filter(x=>x.platform!=='日剧').map(x=>x.platform))}`);
})();
