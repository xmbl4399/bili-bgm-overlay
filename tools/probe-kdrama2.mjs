/** 韩剧在 Bangumi 归到哪个 platform？（查知名韩剧详情） */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

const IDS = [
  [349534, '鱿鱼游戏'], [387237, '鱿鱼游戏2'], [413687, '黑暗荣耀'],
  [104824, '海军罪案调查处：新奥尔良'], [461345, '鱿鱼游戏：真人挑战赛'],
];

(async () => {
  console.log('== 知名韩剧的 platform / type / meta_tags ==');
  for (const [id, name] of IDS) {
    const r = await get(`https://api.bgm.tv/v0/subjects/${id}`);
    if (r.status !== 200) { console.log(`  [${id}] ${name} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    const mt = (j.meta_tags || []).map(t => t.name || t).join(',');
    console.log(`  [${id}] ${(j.name_cn || j.name).slice(0, 20).padEnd(22)} type=${j.type} platform=${JSON.stringify(j.platform)}`);
    console.log(`        meta_tags: ${mt}`);
    const tp = (j.tags || []).slice(0, 8).map(t => `${t.name}:${t.count}`).join(' ');
    console.log(`        tags: ${tp}`);
  }

  console.log('\n== 抽样 1000 条 type=6，统计 platform 前缀含"韩"的 ==');
  const dist = {};
  const korean = [];
  for (let off = 0; off < 1000; off += 100) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&limit=100&offset=${off}`);
    if (r.status !== 200) break;
    const j = JSON.parse(r.body);
    for (const x of (j.data || [])) {
      const k = x.platform || '(无)';
      dist[k] = (dist[k] || 0) + 1;
      if (/韩/.test(k) || /韩/.test((x.meta_tags||[]).join(','))) korean.push(`${x.name_cn || x.name}(${x.platform})`);
    }
  }
  console.log('  platform 取值:', Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
  console.log('  含"韩"的条目:', korean.slice(0, 10).join(' ｜ ') || '(0 条)');
})();
