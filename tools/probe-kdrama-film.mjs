/**
 * 韩剧 tab 的可行性/成色实测。
 *
 * 背景：Bangumi 没有「韩剧」platform，韩剧被扔进 platform="电视剧" 混合容器。
 * 方案 2 = platform=电视剧 + tagPool 命中 /韩剧|韩国/。
 * 这里要回答三个问题：
 *   ① platform="电视剧" 每月有多少条（候选池多大）
 *   ② 其中 tag 命中「韩国」的比例是多少（= 过滤后能剩多少）
 *   ③ 滤出来的到底是不是韩剧（抽标题人眼核）
 */
const V0 = 'https://api.bgm.tv/v0/subjects';
const UA = 'bili-anime-replace/probe-kdrama-film';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

/** 拉某年某月 type=6 不带 cat 的全部条目（limit=100 分页） */
async function month(year, month) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 8; i++) {
    const j = await get(`${V0}?type=6&year=${year}&month=${month}&limit=100&offset=${offset}`);
    const list = j.data || [];
    out.push(...list);
    if (list.length < 100 || offset + 100 >= (j.total || 0)) break;
    offset += 100;
    await sleep(250);
  }
  return out;
}

const tagNames = e => {
  const voted = (Array.isArray(e.tags) ? e.tags : []).map(t => t && t.name).filter(Boolean);
  const meta = Array.isArray(e.meta_tags) ? e.meta_tags : [];
  return [...new Set([...voted, ...meta])];
};

const KD = /韩剧|韩国/;

const main = async () => {
  const years = [Number(process.argv[2]) || 2025];
  const months = process.argv[3] ? [Number(process.argv[3])] : [12, 11, 10, 9, 8, 7];

  let totTv = 0, totKd = 0, noPool = 0, platCount = {};

  for (const y of years) {
    for (const m of months) {
      const items = await month(y, m);
      const tv = items.filter(e => e.platform === '电视剧');
      const pool = items.filter(e => e.platform === '电视剧' || true);
      for (const e of items) platCount[e.platform || '(空)'] = (platCount[e.platform || '(空)'] || 0) + 1;
      const kd = tv.filter(e => {
        const names = tagNames(e);
        if (!names.length) noPool++;
        return names.some(n => KD.test(n));
      });
      totTv += tv.length; totKd += kd.length;
      console.log(`${y}-${String(m).padStart(2, '0')}  type6 全量 ${String(items.length).padStart(4)} ｜ platform=电视剧 ${String(tv.length).padStart(3)} ｜ 命中韩 ${String(kd.length).padStart(3)}  (${tv.length ? Math.round(kd.length / tv.length * 100) : 0}%)`);
      for (const e of kd.slice(0, 6)) {
        console.log(`      · ${e.name_cn || e.name}  [${tagNames(e).filter(n => KD.test(n)).join('/')}]`);
      }
      await sleep(250);
    }
  }
  console.log('\nplatform 分布：' + JSON.stringify(platCount, null, 1));
  console.log(`\n合计 platform=电视剧 ${totTv} 条 → 命中韩 ${totKd} 条  (${totTv ? Math.round(totKd / totTv * 100) : 0}%)；电视剧里 tag 池为空 ${noPool} 条`);
};

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
