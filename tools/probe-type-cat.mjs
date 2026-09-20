/**
 * 探测 Bangumi 各 type / cat 组合的真实含义与数据量
 *   type: 1=书籍 2=动画 3=音乐 4=游戏 6=三次元(真人剧集/电影)
 *   v0 列表：/v0/subjects?type=&cat=&year=&month=&limit=
 *   p1 列表：/p1/subjects?type=&cat=&year=&month=&page=
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const YEAR = process.argv[2] || '2026';

const get = async (url) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const txt = await r.text();
    return { status: r.status, ms: Date.now() - t0, body: txt };
  } catch (e) { return { status: 0, ms: Date.now() - t0, err: String(e) }; }
};

const CASES = [
  // [标签, type, cat]
  ['动画 TV',       2, 1],
  ['动画 WEB',      2, 5],
  ['动画 OVA',      2, 2],
  ['动画 剧场版',   2, 3],
  ['三次元 日剧',   6, 1],
  ['三次元 欧美剧', 6, 2],
  ['三次元 华语剧', 6, 3],
  ['三次元 韩剧',   6, 4],
  ['三次元 电影?',  6, 5],
  ['三次元 电影?',  6, 6],
  ['三次元 电影?',  6, 7],
];

const line = (s) => console.log(s);

(async () => {
  line(`== v0 列表：type/cat 探测（year=${YEAR}） ==`);
  line('cat\t条目数\ttotal\t\t首条样本');
  for (const [label, type, cat] of CASES) {
    const url = `https://api.bgm.tv/v0/subjects?type=${type}&cat=${cat}&year=${YEAR}&month=1&limit=3`;
    const r = await get(url);
    if (r.status !== 200) { line(`${type}/${cat}\tHTTP ${r.status}\t\t${label}  ${r.err || ''}`); continue; }
    let j; try { j = JSON.parse(r.body); } catch (e) { line(`${type}/${cat}\t非JSON\t\t${label}`); continue; }
    const arr = j.data || [];
    const names = arr.slice(0, 2).map(x => x.name_cn || x.name).join(' / ') || '(无)';
    line(`${type}/${cat}\t${arr.length} 条\t${String(j.total).padEnd(7)}\t${label}  →  ${names}`);
  }

  line('');
  line('== 三种三次元 type 常见取值对照（Bangumi 官方 wiki）==');
  line('  type=6 (三次元) cat 1..?  日剧/欧美剧/华剧/韩剧/电影');
  line('  注意 v0 与 p1 对 cat 的定义可能不同，下面用 p1 交叉验证');
  line('');
  line('== p1 列表交叉验证 ==');
  const p1cases = [
    ['动画 TV',       2, 1],
    ['三次元 日剧',   6, 1],
    ['三次元 欧美剧', 6, 2],
    ['三次元 华语剧', 6, 3],
    ['三次元 韩剧',   6, 4],
  ];
  for (const [label, type, cat] of p1cases) {
    const url = `https://next.bgm.tv/p1/subjects?type=${type}&cat=${cat}&year=${YEAR}&month=1&page=1`;
    const r = await get(url);
    if (r.status !== 200) { line(`  ${label} → HTTP ${r.status}`); continue; }
    let j; try { j = JSON.parse(r.body); } catch (e) { line(`  ${label} → 非JSON`); continue; }
    const arr = j.data || [];
    const names = arr.slice(0, 3).map(x => x.name_cn || x.name).join(' / ') || '(无)';
    line(`  ${label}  type=${type} cat=${cat} → total(页)=${j.total}  ${names}`);
  }
})();
