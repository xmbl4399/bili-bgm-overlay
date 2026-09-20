const r = await fetch('https://api.bgm.tv/v0/subjects?type=6&year=2026&month=9&limit=100&offset=0', { headers: { 'User-Agent': 'chk' } });
const j = await r.json();
for (const e of (j.data || []).filter(x => x.platform === '电视剧')) {
  console.log(JSON.stringify(e.platform), '|', e.name_cn || e.name, '| tags:', (e.tags || []).map(t => t.name).slice(0, 8).join(','));
}
