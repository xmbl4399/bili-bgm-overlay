// 探针：看 p1 列表项到底带了哪些 tag 字段、是否被截断
const id = process.argv[2] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch('https://next.bgm.tv/p1/subjects?type=2&cat=1&year=2026&month=1&page=1',
  { headers: { 'User-Agent': 'probe' } })).json();

const sample = list.data.slice(0, 3);
for (const e of sample) {
  console.log('---', e.id, e.nameCN || e.name);
  console.log('  顶层字段:', Object.keys(e).join(', '));
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (Array.isArray(v)) console.log(`  ${k}: [${JSON.stringify(v).slice(0, 300)}]`);
  }
  console.log('  metaTags:', JSON.stringify(e.metaTags));
}

// 全量统计：metaTags 长度分布
let byLen = {}, tagCount = new Map();
const all = [];
for (const cat of [1, 5, 2, 3]) {
  for (let m = 1; m <= 12; m++) {
    try {
      const j = await (await fetch(`https://next.bgm.tv/p1/subjects?type=2&cat=${cat}&year=2026&month=${m}&page=1`,
        { headers: { 'User-Agent': 'probe' } })).json();
      if (Array.isArray(j.data)) all.push(...j.data);
    } catch (e) { }
    await sleep(80);
  }
}
for (const e of all) {
  const n = Array.isArray(e.metaTags) ? e.metaTags.length : -1;
  byLen[n] = (byLen[n] || 0) + 1;
}
console.log('\nmetaTags 长度分布（-1 = 字段缺失）:', JSON.stringify(byLen));

// 单条目详情端点探测
const target = id || all[0].id;
console.log('\n单条目探测 id =', target);
for (const u of [
  `https://api.bgm.tv/v0/subjects/${target}`,
  `https://next.bgm.tv/p1/subjects/${target}`,
  `https://next.bgm.tv/p1/subjects/${target}/tags`,
  `https://api.bgm.tv/subject/${target}?responseGroup=large`,
]) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'probe' }, signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    let tip = '';
    try {
      const j = JSON.parse(txt);
      const t = j.tags || j.metaTags || j.data?.tags || j.data?.metaTags;
      tip = t ? `tags(${Array.isArray(t) ? t.length : '?'})=${JSON.stringify(t).slice(0, 260)}` : `keys=${Object.keys(j.data || j).slice(0, 12).join(',')}`;
    } catch { tip = txt.slice(0, 120).replace(/\s+/g, ' '); }
    console.log(`  ${r.status} ${u}\n     ${tip}`);
  } catch (e) { console.log(`  ERR ${u} → ${e.message}`); }
}
