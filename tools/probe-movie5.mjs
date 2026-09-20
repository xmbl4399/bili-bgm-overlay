/**
 * ★ 收尾验证：加"电影"标签页的可行路径
 *   发现：type=6 + year（不带 cat）= 全量真人影视（含电影/演出/综艺/其他），
 *        而带 cat=1/2/3 时被"净化"成纯剧集。
 *   要做的：确认不带 cat 时能否用 month 过滤，以及"电影"在无 cat 下的年量。
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

const scanYear = async (year, want = '电影') => {
  const hits = [];
  let total = null;
  for (let off = 0; off < 2000; off += 100) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&year=${year}&limit=100&offset=${off}`);
    if (r.status !== 200) break;
    const j = JSON.parse(r.body);
    if (total == null) total = j.total;
    const arr = j.data || [];
    for (const x of arr) if (x.platform === want) hits.push(x);
    if (arr.length < 100 || off + 100 >= total) break;
  }
  return { hits, total };
};

(async () => {
  console.log('== ① 不带 cat 时 month 参数是否生效（type=6 year=2026 month=1）==');
  for (const q of ['', '&month=1', '&month=1&cat=1']) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&year=2026${q}&limit=100`);
    if (r.status !== 200) { console.log(`  "${q}" → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    const dist = {};
    for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
    console.log(`  year=2026${q || ' (无cat无month)'} → total=${String(j.total).padEnd(6)} ${Object.entries(dist).map(([k,v])=>`${k}×${v}`).join(' ')}`);
  }

  console.log('\n== ② 各年"电影"量（type=6 不带 cat 全扫）==');
  for (const y of [2026, 2025, 2024, 2023]) {
    const { hits, total } = await scanYear(y, '电影');
    const months = {};
    for (const m of hits) { const mm = (m.date || '').slice(5, 7) || '??'; months[mm] = (months[mm] || 0) + 1; }
    const mstr = Object.keys(months).sort().map(k => `${k}月:${months[k]}`).join(' ');
    console.log(`  ${y}: 电影 ${String(hits.length).padEnd(4)} 条 / 全类型 ${total} 条   ${mstr}`);
  }

  console.log('\n== ③ 电影样例（2026）==');
  const { hits } = await scanYear(2026, '电影');
  for (const x of hits.slice(0, 6)) {
    console.log(`  [${x.id}] ${(x.name_cn||x.name).slice(0,26).padEnd(28)} date=${x.date} score=${x.rating?.score ?? '-'} tags=${(x.tags||[]).length}`);
  }

  console.log('\n== ④ 电影在"逐月请求"模式下能否拿到（month 是否过滤）==');
  for (const m of [1, 6, 9]) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&year=2026&month=${m}&limit=100`);
    const j = JSON.parse(r.body);
    const dist = {};
    for (const x of (j.data || [])) { const k = x.platform || '(无)'; dist[k] = (dist[k] || 0) + 1; }
    console.log(`  month=${m} → total=${String(j.total).padEnd(5)} ${Object.entries(dist).map(([k,v])=>`${k}×${v}`).join(' ')}`);
  }
})();
