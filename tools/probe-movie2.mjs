/** 用详情接口反查分类：拿几个"确定是电影"的条目，看官方给它什么 type */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

(async () => {
  console.log('== 详情接口反查 type（v0 /v0/subjects/{id}）==');
  const ids = [
    [274128, '流浪地球'], [320871, '流浪地球2'],
    [484686, '丰臣兄弟！(日剧)'], [535567, '雪煙チェイス(日剧SP)'],
  ];
  for (const [id, name] of ids) {
    const r = await get(`https://api.bgm.tv/v0/subjects/${id}`);
    if (r.status !== 200) { console.log(`  [${id}] ${name} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    console.log(`  [${id}] ${name}`);
    console.log(`      type=${j.type}  platform=${JSON.stringify(j.platform)}  date=${j.date}  eps=${j.eps}`);
    console.log(`      附带分类字段: ${Object.keys(j).filter(k=>/type|platform|series|category/i.test(k)).join(', ')}`);
  }

  console.log('\n== 用 search 看 type 分布：搜"流浪地球"类型不限 ==');
  for (const t of [2, 6]) {
    const r = await get(`https://api.bgm.tv/search/subject/${encodeURIComponent('流浪地球')}?type=${t}&responseGroup=small&max_results=3`);
    if (r.status !== 200) { console.log(`  type=${t} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    console.log(`  type=${t}: ${(j.list||[]).map(x=>`${x.name_cn||x.name}(id=${x.id})`).join(' ｜ ')}`);
  }

  console.log('\n== 三次元 year 参数对电影是否生效：查 2023 年 type=6 cat=1/2/3 ==');
  for (const c of [1, 2, 3]) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=${c}&year=2023&month=1&limit=3`);
    if (r.status !== 200) { console.log(`  6/${c} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    console.log(`  6/${c} 2023-01 total=${String(j.total).padEnd(4)} ${(j.data||[]).map(x=>x.name_cn||x.name).join(' / ')||'(无)'}`);
  }
})();
