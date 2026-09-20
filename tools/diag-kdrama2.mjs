/**
 * 用**和脚本完全一致**的取数+过滤逻辑，逐月跑 2024 年的韩剧 tab，看每月到底有几条。
 * 目的：区分「逻辑真的拉到 0 条」和「浏览器里被旧缓存/时序坑了」。
 */
const V0 = 'https://api.bgm.tv/v0/subjects';
const UA = 'diag2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rawTagNames = v => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    const name = typeof t === 'string' ? t : (t && typeof t === 'object' && typeof t.name === 'string') ? t.name : '';
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
};
const fromV0 = e => {
  const voted = (Array.isArray(e.tags) ? e.tags : [])
    .filter(t => t && typeof t.name === 'string')
    .slice().sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map(t => t.name);
  return {
    name: e.name_cn || e.name,
    platform: typeof e.platform === 'string' ? e.platform : '',
    tagPool: [...voted, ...rawTagNames(e.meta_tags)],
  };
};

const mode = { type: 6, cat: null, filter: /^电视剧$/, tagFilter: /韩剧|韩国|韩语/ };
const catParam = m => (m.cat == null) ? '' : `&cat=${m.cat}`;

function applyModeFilter(m, items) {
  if (!m.filter && !m.tagFilter) return items;
  return items.filter(it => {
    if (m.filter) { m.filter.lastIndex = 0; if (!m.filter.test(it.platform || '')) return false; }
    if (m.tagFilter) {
      m.tagFilter.lastIndex = 0;
      const pool = Array.isArray(it.tagPool) ? it.tagPool : [];
      if (!pool.some(t => { m.tagFilter.lastIndex = 0; return m.tagFilter.test(t); })) return false;
    }
    return true;
  });
}

async function fetchV0Page(mode, year, month, offset) {
  const limit = 100;
  const url = `${V0}?type=${mode.type}${catParam(mode)}&year=${year}&month=${month}&limit=${limit}&offset=${offset}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const list = Array.isArray(data.data) ? data.data : [];
  const total = Number(data.total) || 0;
  const items = applyModeFilter(mode, list.map(fromV0));
  return { items, hasMore: list.length >= limit && offset + limit < total, rawLen: list.length };
}

async function fetchMonthVia(mode, year, month) {
  const seen = new Set(); const out = [];
  let offset = 0;
  for (let i = 0; i < 12; i++) {
    const r = await fetchV0Page(mode, year, month, offset);
    for (const it of r.items) { if (!seen.has(it.name)) { seen.add(it.name); out.push(it); } }
    if (!r.hasMore || (r.rawLen !== undefined ? r.rawLen === 0 : r.items.length === 0)) break;
    offset += 100;
    await sleep(200);
  }
  return out;
}

const year = Number(process.argv[2]) || 2024;
let all = 0;
for (const m of [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
  const items = await fetchMonthVia(mode, year, m);
  all += items.length;
  console.log(`${year}-${String(m).padStart(2, '0')}  ${String(items.length).padStart(2)} 条  ${items.slice(0, 3).map(x => x.name).join(' / ')}`);
  await sleep(250);
}
console.log(`\n${year} 年韩剧 tab 合计 ${all} 条`);
