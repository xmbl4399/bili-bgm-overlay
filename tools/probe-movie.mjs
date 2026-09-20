/** 找"电影"：试 p1 的 cat 扩展、v0 不带 cat 的全量、以及搜索接口反查归类 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};
const show = async (label, url) => {
  const r = await get(url);
  if (r.status !== 200) { console.log(`  ${label} → HTTP ${r.status}`); return; }
  let j; try { j = JSON.parse(r.body); } catch (e) { console.log(`  ${label} → 非JSON`); return; }
  const arr = j.data || [];
  const names = arr.slice(0, 4).map(x => x.name_cn || x.name).join(' / ') || '(无)';
  console.log(`  ${label} → total=${String(j.total).padEnd(6)} ${names}`);
};

(async () => {
  console.log('== ① p1 三次元 cat 1..10 ==');
  for (let c = 1; c <= 10; c++) await show(`p1 6/${c}`, `https://next.bgm.tv/p1/subjects?type=6&cat=${c}&year=2026&month=1&page=1`);

  console.log('\n== ② v0 type=6 不带 cat（全量前三类合并？）==');
  await show('v0 6/-', 'https://api.bgm.tv/v0/subjects?type=6&year=2026&month=1&limit=5');

  console.log('\n== ③ 反查归类：奥本海默 / 流浪地球（真人电影）==');
  for (const kw of ['奥本海默', '流浪地球']) {
    const r = await get(`https://api.bgm.tv/search/subject/${encodeURIComponent(kw)}?type=6&responseGroup=small&max_results=3`);
    if (r.status !== 200) { console.log(`  ${kw} → HTTP ${r.status}`); continue; }
    let j; try { j = JSON.parse(r.body); } catch (e) { console.log(`  ${kw} → 非JSON`); continue; }
    const list = (j.list || []).slice(0, 3);
    console.log(`  ${kw}: ${list.map(x => `${x.name_cn || x.name}(type=${x.type} id=${x.id})`).join(' ｜ ') || '(无结果)'}`);
  }

  console.log('\n== ④ 各 cat 的无年份总量（三次元 1/2/3 vs 动画 1/2/3/5）==');
  await show('v0 6/1 全量', 'https://api.bgm.tv/v0/subjects?type=6&cat=1&limit=1');
  await show('v0 6/2 全量', 'https://api.bgm.tv/v0/subjects?type=6&cat=2&limit=1');
  await show('v0 6/3 全量', 'https://api.bgm.tv/v0/subjects?type=6&cat=3&limit=1');
})();
