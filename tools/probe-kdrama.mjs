/** 确认韩剧归属：type=6 全量扫 platform 分布 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

(async () => {
  console.log('== type=6 全平台分布（不带 cat，各年全扫）==');
  for (const y of [2026, 2025, 2024, 2023]) {
    const dist = {};
    let total = null;
    for (let off = 0; off < 2000; off += 100) {
      const r = await get(`https://api.bgm.tv/v0/subjects?type=6&year=${y}&limit=100&offset=${off}`);
      if (r.status !== 200) break;
      const j = JSON.parse(r.body);
      if (total == null) total = j.total;
      for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
      if (off + 100 >= total) break;
    }
    const s = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  ');
    console.log(`  ${y} (${total}): ${s}`);
  }

  console.log('\n== 带 cat 时是否出现韩剧（cat=1/2/3 各年）==');
  for (const c of [1, 2, 3]) {
    for (const y of [2026, 2024]) {
      const r = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=${c}&year=${y}&limit=100`);
      if (r.status !== 200) { console.log(`  ${y} cat=${c} → HTTP ${r.status}`); continue; }
      const j = JSON.parse(r.body);
      const dist = {};
      for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
      console.log(`  ${y} cat=${c}: ${Object.entries(dist).map(([k, v]) => `${k}×${v}`).join(' ')}`);
    }
  }

  console.log('\n== 韩剧样例搜索（确认平台名）==');
  for (const kw of ['鱿鱼游戏', '黑暗荣耀']) {
    const r = await get(`https://api.bgm.tv/search/subject/${encodeURIComponent(kw)}?type=6&responseGroup=small&max_results=5`);
    if (r.status !== 200) { console.log(`  ${kw} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    console.log(`  ${kw}: ${(j.list || []).map(x => `${x.name_cn || x.name}(${x.id})`).join(' ｜ ') || '(无)'}`);
  }
})();
