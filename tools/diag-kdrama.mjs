/**
 * 直接复现脚本的过滤逻辑（不经过浏览器），定位「韩剧 tab 0 卡」到底卡在哪一步。
 */
const url = 'https://api.bgm.tv/v0/subjects?type=6&year=2026&month=9&limit=100&offset=0';
const r = await fetch(url, { headers: { 'User-Agent': 'diag' } });
const j = await r.json();
const list = j.data || [];

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
  const pool = [...voted, ...rawTagNames(e.meta_tags)];
  return { name: e.name_cn || e.name, platform: typeof e.platform === 'string' ? e.platform : '', tagPool: pool };
};

const filter = /^电视剧$/;
const tagFilter = /韩剧|韩国|韩语/;

console.log('页面总数', list.length);
const items = list.map(fromV0);
const platOk = items.filter(it => { filter.lastIndex = 0; return filter.test(it.platform); });
console.log('① platform 命中「电视剧」:', platOk.length, platOk.map(x => x.name).join(' / '));

for (const it of platOk) {
  const pool = Array.isArray(it.tagPool) ? it.tagPool : [];
  const hit = pool.some(t => { tagFilter.lastIndex = 0; return tagFilter.test(t); });
  console.log(`   ② ${it.name}  tagPool(${pool.length})=${JSON.stringify(pool.slice(0, 8))}  命中=${hit}`);
}

// 关键怀疑：正则对象被前面的 test() 消费后 lastIndex 变了？
// 带 g 才有 lastIndex 问题，这两个都没 g —— 验证一下
console.log('\n正则无 g 标志 → lastIndex 应恒为 0：', filter.global, tagFilter.global);
filter.lastIndex = 0; console.log('test("电视剧") =', filter.test('电视剧'), 'lastIndex=', filter.lastIndex);
tagFilter.lastIndex = 0; console.log('test("韩国") =', tagFilter.test('韩国'), 'lastIndex=', tagFilter.lastIndex);
tagFilter.lastIndex = 0; console.log('test("韩剧2026") =', tagFilter.test('韩剧2026'));
