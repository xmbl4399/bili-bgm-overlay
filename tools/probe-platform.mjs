/** 确认 platform 字段：列表接口是否返回 + 各值分布 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

(async () => {
  console.log('== ① 三次元列表项是否带 platform ==');
  const r = await get('https://api.bgm.tv/v0/subjects?type=6&year=2026&month=1&limit=20');
  const j = JSON.parse(r.body);
  const it = j.data[0];
  console.log('  列表项全部字段:', Object.keys(it).sort().join(', '));
  console.log('  有 platform 字段吗:', 'platform' in it ? '✅ 有' : '❌ 没有（只有详情接口有）');
  console.log('');
  for (const x of j.data.slice(0, 10)) {
    console.log(`    [${x.id}] ${(x.name_cn||x.name||'').slice(0,26).padEnd(28)} platform=${JSON.stringify(x.platform)}  meta_tags=${JSON.stringify((x.meta_tags||[]).slice(0,5))}`);
  }

  console.log('\n== ② 三次元各 cat 的 platform 分布（抽样 100 条/cat，看有无"电影"）==');
  for (const c of [1, 2, 3]) {
    const counts = {};
    for (let p = 0; p < 4; p++) {
      const rr = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=${c}&year=2024&limit=50&offset=${p * 50}`);
      if (rr.status !== 200) break;
      const jj = JSON.parse(rr.body);
      for (const x of (jj.data || [])) {
        const k = x.platform || '(无)';
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`  6/${c}: ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }

  console.log('\n== ③ 动画 type=2 的 platform 分布（对照）==');
  for (const c of [1, 2, 3, 5]) {
    const counts = {};
    const rr = await get(`https://api.bgm.tv/v0/subjects?type=2&cat=${c}&year=2024&limit=100`);
    if (rr.status !== 200) { console.log(`  2/${c} → HTTP ${rr.status}`); continue; }
    const jj = JSON.parse(rr.body);
    for (const x of (jj.data || [])) { const k = x.platform || '(无)'; counts[k] = (counts[k] || 0) + 1; }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  2/${c}: ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }
})();
