#!/usr/bin/env node
/**
 * Tag 白名单审计：拉某年全量 Bangumi 数据，统计
 *   ① 当前白名单下「筛不出 tag」的条目占比
 *   ② 这些空条目实际带的高频 tag 是什么（→ 该补哪些词）
 *   ③ 全量 tag 频次分布（→ 看还有哪些高频词没进白名单）
 *
 * 用法：node tools/tag-audit.mjs [year=2026] [--dump]
 *   --dump  额外打印空条目清单（标题 + 原始 tag）
 */
import fs from 'node:fs';
import path from 'node:path';

const YEAR = Number(process.argv.find(a => /^\d{4}$/.test(a)) || 2026);
const DUMP = process.argv.includes('--dump');
const CATS = [1, 5, 2, 3];                       // TV / WEB / OVA / 剧场版
const CAT_LABEL = { 1: 'TV', 5: 'WEB', 2: 'OVA', 3: '剧场版' };
const MAX_TAGS = 2;                              // pickTags 的 n
const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------- 从脚本里读白名单（单一事实来源） ---------- */
const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const m = src.match(/const TAG_WHITELIST = \[([\s\S]*?)\];/);
if (!m) { console.error('没找到 TAG_WHITELIST'); process.exit(1); }
const WHITELIST = m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));

/* ---------- 与脚本内 pickTags 等价 ---------- */
const rawTagNames = v => !Array.isArray(v) ? []
  : v.map(t => typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : null)).filter(Boolean);
function pickTags(names, n = MAX_TAGS) {
  const out = [];
  for (const name of rawTagNames(names)) {
    if (!WHITELIST.includes(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length >= n) break;
  }
  return out;
}

/* ---------- 取数 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'bili-bgm-overlay/tag-audit' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(700 * (i + 1));
    }
  }
}

async function fetchMonth(cat, month) {
  const out = [];
  let page = 1, totalPages = 1;
  do {
    const url = `https://next.bgm.tv/p1/subjects?type=2&cat=${cat}&year=${YEAR}&month=${month}&page=${page}`;
    const j = await getJson(url);
    if (Array.isArray(j.data)) out.push(...j.data);
    totalPages = Math.min(Number(j.total) || 1, 12);
    page++;
    await sleep(120);
  } while (page <= totalPages);
  return out;
}

console.log(`审计年份：${YEAR}｜白名单 ${WHITELIST.length} 词｜每卡最多 ${MAX_TAGS} 个 tag\n`);

const all = [];
for (const cat of CATS) {
  for (let month = 1; month <= 12; month++) {
    let items = [];
    try { items = await fetchMonth(cat, month); }
    catch (e) { console.log(`  [跳过] ${CAT_LABEL[cat]} ${month}月：${e.message}`); continue; }
    for (const it of items) all.push({ ...it, _cat: cat, _month: month });
  }
  console.log(`  ${CAT_LABEL[cat]} 累计 ${all.filter(x => x._cat === cat).length} 条`);
}

console.log(`\n总条目：${all.length}`);

/* ---------- ① 空 tag 统计 ---------- */
const empty = [], nonEmpty = [];
for (const it of all) {
  (pickTags(it.metaTags).length ? nonEmpty : empty).push(it);
}
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
console.log(`筛不出 tag：${empty.length} / ${all.length}（${pct(empty.length, all.length)}）`);

/* 白名单命中数分布：决定「补拉详情」的触发阈值 */
const hitDist = { 0: 0, 1: 0, '2+': 0 };
for (const it of all) {
  const n = pickTags(it.metaTags, 99).length;
  hitDist[n === 0 ? 0 : n === 1 ? 1 : '2+']++;
}
console.log(`命中数分布：0 个 = ${hitDist[0]}（${pct(hitDist[0], all.length)}），`
  + `1 个 = ${hitDist[1]}（${pct(hitDist[1], all.length)}），2+ 个 = ${hitDist['2+']}`);
console.log(`⇒ 若「命中 <2 就补拉详情」，需补拉 ${hitDist[0] + hitDist[1]} / ${all.length} 条（${pct(hitDist[0] + hitDist[1], all.length)}）`);

/* 无 tag 字段（metaTags 缺失/为空）单独拎出来 —— 那是数据源问题，不是白名单问题 */
const noField = empty.filter(it => !rawTagNames(it.metaTags).length);
console.log(`  └ 其中「接口压根没返回 tag」：${noField.length}（白名单加词也救不了）`);
console.log(`  └ 其中「有 tag 但全被白名单滤掉」：${empty.length - noField.length}（这部分加词有效）`);

/* ---------- ② 空条目的高频 tag ---------- */
const freqEmpty = new Map(), freqAll = new Map(), freqNoField = new Map();
for (const it of all) {
  for (const t of new Set(rawTagNames(it.metaTags))) freqAll.set(t, (freqAll.get(t) || 0) + 1);
}
for (const it of empty) {
  for (const t of new Set(rawTagNames(it.metaTags))) freqEmpty.set(t, (freqEmpty.get(t) || 0) + 1);
}
for (const it of noField) {
  for (const t of new Set(rawTagNames(it.metaTags))) freqNoField.set(t, (freqNoField.get(t) || 0) + 1);
}

const sorted = m => [...m.entries()].sort((a, b) => b[1] - a[1]);

console.log('\n=== 空条目带的 tag（Top 40）===');
console.log('tag\t出现次数\t是否已在白名单');
for (const [t, c] of sorted(freqEmpty).slice(0, 40)) {
  console.log(`${t}\t${c}\t${WHITELIST.includes(t) ? '已在小名单' : '★缺'}`);
}

console.log('\n=== 全量 tag 频次（Top 50）===');
console.log('tag\t出现次数\t是否已在白名单');
for (const [t, c] of sorted(freqAll).slice(0, 50)) {
  console.log(`${t}\t${c}\t${WHITELIST.includes(t) ? '在' : '★缺'}`);
}

/* ---------- ③ 补词模拟：加哪些词能把多少空条目救回来 ---------- */
const cands = sorted(freqEmpty).filter(([t]) => !WHITELIST.includes(t));
console.log('\n=== 候选补词（按"能救回多少空条目"排序）===');
console.log('tag\t救回条目\t救回后剩余空条目');
for (const [t, c] of cands.slice(0, 25)) {
  const next = empty.filter(it => !rawTagNames(it.metaTags).includes(t)).length;
  console.log(`${t}\t+${c}\t${next}`);
}

/* ---------- ④ 组合收益：贪心地看 Top N 组合效果 ---------- */
const tokens = [];
let rest = empty.filter(it => rawTagNames(it.metaTags).length);   // 只考虑有 tag 可救的
const pool = [...freqEmpty.keys()].filter(t => !WHITELIST.includes(t));
const cover = new Map();
for (const t of pool) cover.set(t, rest.filter(it => rawTagNames(it.metaTags).includes(t)).length);
const chosen = [];
while (chosen.length < 8) {
  const best = [...cover.entries()].filter(([t]) => !chosen.includes(t)).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] === 0) break;
  chosen.push(best[0]);
  rest = rest.filter(it => !rawTagNames(it.metaTags).includes(best[0]));
  console.log(`加「${best[0]}」→ 累计救回，剩余空 ${rest.length}/${empty.length}`);
}

/* ---------- ⑤ dump ---------- */
if (DUMP) {
  console.log('\n=== 空条目明细 ===');
  for (const it of empty) {
    console.log(`${CAT_LABEL[it._cat]} ${YEAR}-${String(it._month).padStart(2, '0')} | ${it.nameCN || it.name} | raw=[${rawTagNames(it.metaTags).join(', ')}]`);
  }
}
