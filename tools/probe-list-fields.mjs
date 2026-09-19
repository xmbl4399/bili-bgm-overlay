/**
 * 并排实测 Bangumi 两个列表接口的字段差异：
 *   - v0: https://api.bgm.tv/v0/subjects?type=2&cat=1&year=&month=&limit=&offset=
 *   - p1: https://next.bgm.tv/p1/subjects?type=2&cat=1&year=&month=&page=
 * 关注点：列表项到底有没有 tags（全量投票词）？meta_tags 是什么？
 *
 * 用法：node tools/probe-list-fields.mjs [year] [cat] [count]
 */
const UA = 'bili-bgm-overlay/1.3.0 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const YEAR = process.argv[2] || '2026';
const CAT = process.argv[3] || '1';
const N = Math.min(Number(process.argv[4]) || 6, 20);

const get = async (url) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const txt = await r.text();
    return { status: r.status, ms: Date.now() - t0, ct: r.headers.get('content-type'), body: txt };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, err: String(e), body: '' };
  }
};

const norm = (it) => ({
  id: it.id,
  name: it.name,
  nameCN: it.name_cn ?? it.nameCN ?? '',
  tags: it.tags,
  meta: it.meta_tags ?? it.metaTags,
  rating: it.rating,
  info: it.info ?? it.meta_info,
});

const report = (label, res) => {
  console.log('\n' + '='.repeat(72));
  console.log('=== ' + label + ' ===');
  console.log('='.repeat(72));
  if (res.err) return console.log('  网络错误: ' + res.err);
  console.log('  HTTP ' + res.status + '  ' + res.ms + 'ms  ' + res.ct);
  console.log('  响应头 200 字: ' + res.body.slice(0, 200).replace(/\s+/g, ' '));
  if (res.status !== 200) return;
  let j;
  try { j = JSON.parse(res.body); } catch { return console.log('  非 JSON'); }
  console.log('  顶层键: ' + Object.keys(j).join(', ') + '  | total=' + j.total + ' limit=' + j.limit + ' offset=' + j.offset);
  const arr = (j.data || []).slice(0, N);
  if (!arr.length) return console.log('  （空数组）');
  console.log('  ★ 列表项字段: ' + Object.keys(arr[0]).sort().join(', '));

  const hasTags = arr.filter(x => Array.isArray((norm(x)).tags)).length;
  const hasMeta = arr.filter(x => Array.isArray(norm(x).meta)).length;
  console.log('  —— 字段存在率（本页 ' + arr.length + ' 条）: tags ' + hasTags + '/' + arr.length + ' ｜ meta_tags ' + hasMeta + '/' + arr.length);

  for (const raw of arr) {
    const it = norm(raw);
    console.log('\n  [' + it.id + '] ' + it.nameCN + ' / ' + it.name);
    const t = it.tags, m = it.meta;
    console.log('    meta_tags  ' + (Array.isArray(m) ? '(' + m.length + ') ' + JSON.stringify(m) : String(m)));
    if (Array.isArray(t)) {
      console.log('    tags       (' + t.length + ') ' + JSON.stringify(t.slice(0, 12).map(x => typeof x === 'object' ? x.name + ':' + x.count : x)) + (t.length > 12 ? ' …' : ''));
      if (t.length && typeof t[0] === 'object') {
        console.log('    tags 元素键 ' + Object.keys(t[0]).join(', '));
        const top = t.filter(x => x && typeof x === 'object').sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5);
        console.log('    tags 票数 Top5 ' + top.map(x => x.name + '(' + x.count + ')').join(' '));
      }
    } else {
      console.log('    tags       ' + String(t));
    }
    console.log('    rating     ' + (it.rating ? 'score=' + it.rating.score + ' total=' + it.rating.total + ' rank=' + it.rating.rank : '(无)'));
    if (it.info) console.log('    info       ' + String(it.info).slice(0, 80));
  }
  return arr.map(norm);
};

const v0 = await get(`https://api.bgm.tv/v0/subjects?type=2&cat=${CAT}&year=${YEAR}&month=1&limit=${N}`);
report(`v0（api.bgm.tv/v0/subjects）  year=${YEAR} cat=${CAT} month=1 limit=${N}`, v0);

const v0q = await get(`https://api.bgm.tv/v0/subjects?type=2&cat=${CAT}&year=${YEAR}&limit=${N}&offset=0`);
report(`v0（去掉 month，只按年）  year=${YEAR} cat=${CAT} limit=${N}`, v0q);

const p1 = await get(`https://next.bgm.tv/p1/subjects?type=2&cat=${CAT}&year=${YEAR}&month=1&page=1`);
report(`p1（next.bgm.tv/p1/subjects）  year=${YEAR} cat=${CAT} month=1 page=1`, p1);

console.log('\n' + '='.repeat(72));
console.log('汇总：v0 列表项含 tags 的比例 / p1 列表项含 tags 的比例');
