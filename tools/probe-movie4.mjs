/**
 * ★ 最后一次确认：month=1 为什么能捞出电影？（无 year 的 month=1，语义可能是"1月首播"全量）
 *   如果 month 能独立用，那"电影"就能靠 cat=1+month 拉；否则电影只能另想办法。
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};
const probe = async (label, u) => {
  const r = await get(u);
  if (r.status !== 200) { console.log(`  ${label} → HTTP ${r.status}`); return null; }
  const j = JSON.parse(r.body);
  const arr = j.data || [];
  const dist = {};
  for (const x of arr) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
  console.log(`  ${label} → total=${String(j.total).padEnd(6)} 本页 ${arr.length} 条 | ${Object.entries(dist).map(([k,v])=>`${k}×${v}`).join(' ')}`);
  return arr;
};

(async () => {
  console.log('== A. no year + month=1（type=6, cat=1/2/3）==');
  for (const c of [1, 2, 3]) await probe(`6/${c} month=1`, `https://api.bgm.tv/v0/subjects?type=6&cat=${c}&month=1&limit=20`);

  console.log('\n== B. no year + month 1..12 的 total（cat=1）==');
  for (let m = 1; m <= 12; m++) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=1&month=${m}&limit=1`);
    const j = JSON.parse(r.body);
    process.stdout.write(`${m}月:${j.total}  `);
  }
  console.log('');

  console.log('\n== C. 电影到底在哪：type=6 不加 cat，逐页扫 platform ==');
  for (let off = 0; off < 300; off += 100) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&year=2026&limit=100&offset=${off}`);
    if (r.status !== 200) { console.log(`  offset=${off} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    const dist = {};
    for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
    console.log(`  offset=${off} total=${j.total} → ${Object.entries(dist).map(([k,v])=>`${k}×${v}`).join(' ')}`);
  }

  console.log('\n== D. 2024 年 type=6 无 cat 全量扫，看电影量 ==');
  for (let off = 0; off < 500; off += 100) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&year=2024&limit=100&offset=${off}`);
    if (r.status !== 200) { console.log(`  offset=${off} → HTTP ${r.status}`); break; }
    const j = JSON.parse(r.body);
    const dist = {};
    for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
    console.log(`  offset=${off} total=${j.total} → ${Object.entries(dist).map(([k,v])=>`${k}×${v}`).join(' ')}`);
  }

  console.log('\n== E. month + year 同时给时平台分布（2026 month=1, cat=1）==');
  await probe('6/1 year+month', 'https://api.bgm.tv/v0/subjects?type=6&cat=1&year=2026&month=1&limit=50');
})();
