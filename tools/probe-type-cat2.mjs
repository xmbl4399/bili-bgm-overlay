/**
 * 第二轮：确定 v0 的 cat 上限 + "电影"归属 + 各分类样本量
 *   - v0 limit 上限（之前对动画测过 ≤100，验证三次元是否一致）
 *   - cat=5..12 逐个试（找电影）
 *   - 无 year 时各 cat 总量
 */
const UA = 'bili-bgm-overlay-probe/1.4.0';
const get = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, err: String(e) }; }
};

(async () => {
  console.log('== ① v0 三次元 cat 5..14 逐个试（year=2026 month=1）==');
  for (let cat = 5; cat <= 14; cat++) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=${cat}&year=2026&month=1&limit=3`);
    if (r.status !== 200) { console.log(`  6/${cat} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    const arr = j.data || [];
    console.log(`  6/${cat} → total=${String(j.total).padEnd(5)} ${arr.slice(0,2).map(x=>x.name_cn||x.name).join(' / ') || '(无)'}`);
  }

  console.log('');
  console.log('== ② v0 三次元 cat 无 year 限制（看全量）==');
  for (const cat of [1,2,3,4,5,6]) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=${cat}&limit=1`);
    if (r.status !== 200) { console.log(`  6/${cat} → HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.body);
    console.log(`  6/${cat} → total=${j.total}`);
  }

  console.log('');
  console.log('== ③ v0 limit 上限（三次元 cat=1）==');
  for (const limit of [24, 50, 100, 101, 200]) {
    const r = await get(`https://api.bgm.tv/v0/subjects?type=6&cat=1&year=2026&month=1&limit=${limit}`);
    console.log(`  limit=${String(limit).padEnd(4)} → HTTP ${r.status}`);
  }

  console.log('');
  console.log('== ④ 各分类 2026 全年逐月总量（v0, limit=100 分页）==');
  for (const [label, type, cat] of [['日剧',6,1],['欧美剧',6,2],['华语剧',6,3],['动画TV',2,1],['动画WEB',2,5],['动画剧场版',2,3]]) {
    let total = 0; const months = [];
    for (let m = 1; m <= 12; m++) {
      const r = await get(`https://api.bgm.tv/v0/subjects?type=${type}&cat=${cat}&year=2026&month=${m}&limit=1`);
      if (r.status !== 200) continue;
      const j = JSON.parse(r.body);
      const n = j.total || 0;
      total += n; months.push(`${m}月:${n}`);
    }
    console.log(`  ${label.padEnd(10)} 2026 全年 ${String(total).padEnd(4)} 条   ${months.join(' ')}`);
  }

  console.log('');
  console.log('== ⑤ 三次元是否带 tags/meta_tags 字段（决定 tag 方案能否复用）==');
  const r = await get('https://api.bgm.tv/v0/subjects?type=6&cat=1&year=2026&month=1&limit=3');
  const j = JSON.parse(r.body);
  for (const it of (j.data || [])) {
    console.log(`  [${it.id}] ${(it.name_cn||it.name).slice(0,20)}`);
    console.log(`      tags      = ${Array.isArray(it.tags) ? it.tags.length + ' 个 → ' + it.tags.slice(0,8).map(t=>t.name+':'+t.count).join(' ') : String(it.tags)}`);
    console.log(`      meta_tags = ${JSON.stringify((it.meta_tags||[]).slice(0,12))}`);
  }
})();
