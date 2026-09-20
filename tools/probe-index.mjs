/**
 * ★ 决定性验证：各 platform 能否靠 (year, month) 定位
 *   怀疑：只有 cat=1/2/3（日剧/欧美剧/华语剧）走"首播年月"索引，
 *        其他 platform（电影/电视剧/演出/综艺/其他）是"无日期索引"，year/month 过滤不生效
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

const distOf = async (q, label) => {
  const r = await get(`https://api.bgm.tv/v0/subjects?type=6${q}&limit=100`);
  if (r.status !== 200) { console.log(`  ${label} → HTTP ${r.status}`); return; }
  const j = JSON.parse(r.body);
  const dist = {};
  for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
  console.log(`  ${label.padEnd(28)} total=${String(j.total).padEnd(6)} ${Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k}×${v}`).join(' ')}`);
};

(async () => {
  console.log('== ① 同一 platform，换 year 看 total 是否变 ==');
  for (const y of [2026, 2024, 2020]) {
    await distOf(`&year=${y}&month=6`, `year=${y} month=6（无 cat）`);
  }
  console.log('  ↑ 若 total 随 year 变化 = year 生效；若恒定 = 被忽略\n');

  console.log('== ② 电影：带 year 与不带 year 的 total 对比 ==');
  for (const q of ['', '&year=2026&month=6', '&year=2024&month=6']) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6${q}&limit=1`);
    const j = JSON.parse(r.body);
    console.log(`  "${q || '(无 year/month)'}" → total=${j.total}`);
  }

  console.log('\n== ③ 检查"电视剧"（韩剧容器）是否有 year 索引 ==');
  for (const q of ['', '&year=2026', '&year=2026&month=1', '&year=2020&month=1']) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6${q}&limit=100`);
    const j = JSON.parse(r.body);
    const tv = (j.data || []).filter(x => x.platform === '电视剧');
    console.log(`  "${q || '(无)'}" total=${String(j.total).padEnd(6)} 本页含电视剧 ${tv.length} 条`);
  }

  console.log('\n== ④ 电影的 date 与 year 参数是否一致（抽查 2026 month=6 的电影）==');
  const r = await get('https://api.bgm.tv/v0/subjects?type=6&year=2026&month=6&limit=100');
  const j = JSON.parse(r.body);
  const films = (j.data || []).filter(x => x.platform === '电影');
  console.log(`  month=6 命中电影 ${films.length} 条，date 分布:`);
  for (const f of films.slice(0, 12)) console.log(`    ${(f.name_cn || f.name).slice(0, 22).padEnd(24)} date=${f.date}`);
})();
