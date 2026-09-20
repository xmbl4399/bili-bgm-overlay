/**
 * ★ 关键决策探针：三次元 cat 如何拆出"电影"？
 *
 * 已知：v0 type=6 cat=1/2/3 里混着 platform="日剧/欧美剧/华语剧" 与 platform="电影"，
 *      且没有单独的"电影"cat（cat≥4 全 400）。three-way 方案对比：
 *   A) 日剧=6/1, 欧美剧=6/2, 华语剧=6/3, 电影=6/1+2+3 交集 platform=电影  ← 需逐条过滤
 *   B) 不看 cat，只用 platform 过滤（type=6 全量扫 → 按 platform 分桶）
 *   C) 各 cat 内部 platform 分布（看有无跨类污染）
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

const ALL = async (type, cat, year) => {
  const out = [];
  for (let off = 0; off < 600; off += 100) {
    const u = `https://api.bgm.tv/v0/subjects?type=${type}&cat=${cat}&year=${year}&limit=100&offset=${off}`;
    const r = await get(u);
    if (r.status !== 200) break;
    const j = JSON.parse(r.body);
    const arr = j.data || [];
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out;
};

(async () => {
  const YEAR = 2024;
  console.log(`== 三次元 cat 1/2/3 全年 ${YEAR} 逐条拉取，按 platform 分桶 ==`);

  const buckets = { 1: {}, 2: {}, 3: {} };
  const all = [];
  for (const c of [1, 2, 3]) {
    const arr = await ALL(6, c, YEAR);
    for (const x of arr) {
      const k = x.platform || '(无)';
      buckets[c][k] = (buckets[c][k] || 0) + 1;
      all.push({ ...x, _cat: c });
    }
    const tot = arr.length;
    const top = Object.entries(buckets[c]).sort((a, b) => b[1] - a[1]);
    console.log(`  cat=${c}: 共 ${tot} 条  →  ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }

  console.log(`\n== 合并后 platform 总分布（去重总量 ${all.length}）==`);
  const g = {};
  for (const x of all) { const k = x.platform || '(无)'; g[k] = (g[k] || 0) + 1; }
  for (const [k, v] of Object.entries(g).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  console.log('\n== ★ 结论验证：电影散落在哪些 cat ==');
  for (const c of [1, 2, 3]) {
    const movies = all.filter(x => x._cat === c && x.platform === '电影');
    console.log(`  cat=${c} 里的电影 ${movies.length} 条: ${movies.slice(0, 4).map(x => (x.name_cn || x.name).slice(0, 16)).join(' / ') || '(无)'}`);
  }
  console.log(`  电影合计 ${all.filter(x => x.platform === '电影').length} 条`);

  console.log('\n== 逐月分布验证：电影会不会让某月超 100 条（limit 上限）==');
  for (const c of [1, 2, 3]) {
    const per = {};
    for (const x of all.filter(y => y._cat === c)) {
      const m = (x.date || '').slice(5, 7) || '??';
      per[m] = (per[m] || 0) + 1;
    }
    const max = Object.entries(per).sort((a, b) => b[1] - a[1])[0] || ['-', 0];
    console.log(`  cat=${c} 单月最大 ${max[1]} 条（${max[0]}月）`);
  }
})();
