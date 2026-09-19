#!/usr/bin/env node
/**
 * 空 tag 条目深挖：对「列表 metaTags 筛不出 tag」的条目拉单条目详情（30 个完整 tag），
 * 回答两个问题：
 *   ① 这些条目**真实**有没有内容 tag？（→ 决定是「补白名单」还是「拉详情」）
 *   ② 全量 30 tag 里出现过、但白名单没有的高频内容词有哪些？（→ 针对性补词）
 *
 * ⚠️ metaTags 是「票数 Top ~6」，元信息(TV/日本/漫画改)票数最高会挤掉内容 tag —— 这是根因。
 *
 * 用法：node tools/tag-audit-detail.mjs [year=2026] [--top=20]
 */
import fs from 'node:fs';
import path from 'node:path';

const YEAR = Number(process.argv.find(a => /^\d{4}$/.test(a)) || 2026);
const TOP = Number((process.argv.find(a => a.startsWith('--top=')) || '').split('=')[1]) || 20;
const CATS = [1, 5, 2, 3];
const CAT_LABEL = { 1: 'TV', 5: 'WEB', 2: 'OVA', 3: '剧场版' };
const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const WHITELIST = src.match(/const TAG_WHITELIST = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g).map(s => s.slice(1, -1));
const WL = new Set(WHITELIST);

/** 元信息类 tag（地区/媒介/来源/受众）—— 不适合当「流派」展示 */
const META = new Set(['日本', '中国', '韩国', '美国', '欧美', '法国', 'TV', 'WEB', 'OVA', '剧场版',
  '漫画改', '小说改', '原创', '游戏改', '同人', '轻小说改', '子供向', '少年向', '少女向', '青年向',
  '女性向', '男性向', '乙女', '短片集', '泡面番']);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'bili-bgm-overlay/tag-audit' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(600 * (i + 1)); }
  }
}
const rawTags = v => !Array.isArray(v) ? [] : v.map(t => typeof t === 'string' ? t : (t && t.name) || '').filter(Boolean);
const pick = (names, n = 2) => { const o = []; for (const t of rawTags(names)) { if (!WL.has(t) || o.includes(t)) continue; o.push(t); if (o.length >= n) break; } return o; };

/* ---- 取列表 ---- */
const all = [];
for (const cat of CATS) {
  for (let m = 1; m <= 12; m++) {
    try {
      const j = await getJson(`https://next.bgm.tv/p1/subjects?type=2&cat=${cat}&year=${YEAR}&month=${m}&page=1`);
      if (Array.isArray(j.data)) all.push(...j.data.map(e => ({ ...e, _cat: cat, _month: m })));
    } catch (e) { console.log(`  [跳过] ${CAT_LABEL[cat]} ${m}月 ${e.message}`); }
    await sleep(80);
  }
}
console.log(`总条目 ${all.length}`);

const empty = all.filter(e => !pick(e.metaTags).length);
console.log(`列表 metaTags 筛不出 tag：${empty.length}\n`);

/* ---- 逐个拉详情 ---- */
console.log(`拉 ${empty.length} 条详情（top ${TOP} tag）...\n`);
const detailFilled = [], detailStillEmpty = [];
const detailTagFreq = new Map();     // 详情里有、白名单没有的内容词
const allTagFreq = new Map();        // 详情里出现的**全部** tag（含白名单词与元信息）
const detailHitFreq = new Map();     // 详情里命中的白名单词
const filledByMetaOnly = new Map();  // 若只靠「白名单已有的词」，救回来的是哪些

for (let i = 0; i < empty.length; i++) {
  const it = empty[i];
  let tags = [];
  try {
    const d = await getJson(`https://next.bgm.tv/p1/subjects/${it.id}`);
    tags = rawTags(d.tags).slice(0, TOP);
  } catch (e) { console.log(`  [ERR] ${it.id} ${e.message}`); continue; }
  const hit = tags.filter(t => WL.has(t));
  const contentTags = tags.filter(t => !META.has(t) && !WL.has(t));
  const rec = { ...it, _tags: tags, _hit: hit, _contentNotInWl: contentTags };
  if (hit.length) { detailFilled.push(rec); hit.forEach(t => detailHitFreq.set(t, (detailHitFreq.get(t) || 0) + 1)); }
  else detailStillEmpty.push(rec);
  contentTags.forEach(t => detailTagFreq.set(t, (detailTagFreq.get(t) || 0) + 1));
  new Set(tags).forEach(t => allTagFreq.set(t, (allTagFreq.get(t) || 0) + 1));
  await sleep(140);
}

const sorted = m => [...m.entries()].sort((a, b) => b[1] - a[1]);

console.log(`\n=== ① 拉详情后能筛出 tag 的：${detailFilled.length} / ${empty.length} ===`);
console.log(`   仍然筛不出：${detailStillEmpty.length}（这些是真的没内容 tag，只能靠元信息兜底）`);

console.log('\n=== ② 救回来的条目，命中的白名单词（→ 白名单本身够用）===');
for (const [t, c] of sorted(detailHitFreq)) console.log(`  ${t} × ${c}`);

console.log(`\n=== ③ 详情 Top${TOP} 里出现、白名单没有的「内容词」Top 30（→ 该补这些）===`);
for (const [t, c] of sorted(detailTagFreq).slice(0, 30)) console.log(`  ${t} × ${c}`);

/* ③-b 用户点名词在「完整详情 tag」里的命中情况 —— 判断该不该加 */
const ASKED = ['搞笑', '奇幻', '恐怖', '灵异', '战斗', '冒险', '百合', '后宫', '女性向', '科幻'];
console.log(`\n=== ③-b 主人点名的 10 个词，在详情 Top${TOP} 里的出现次数（样本：${empty.length} 条空条目）===`);
for (const w of ASKED) {
  const inWl = WL.has(w);
  const c = allTagFreq.get(w) || 0;
  console.log(`  ${w}\t白名单：${inWl ? '已有' : '无'}\t详情出现 ${c} 次${!inWl && c ? ' ★值得加' : !inWl ? '（2026 数据支持不足）' : ''}`);
}
console.log('\n=== ③-c 高频「内容词」补词候选（白名单没有、非元信息、非日期/人名）Top 20 ===');
const NOISE = /^\d|^20\d\d|月$|^[A-Z]|动画$|电影|剧场版|SP|TVSP|番外|续作|短片|^3D$|^[a-z]/;
for (const [t, c] of sorted(detailTagFreq).slice(0, 60)) {
  if (NOISE.test(t) || META.has(t)) continue;
  if (t.length > 5) continue;
  console.log(`  ${t} × ${c}`);
}

console.log('\n=== ④ 拉详情也救不回（需元信息兜底/留空）===');
for (const r of detailStillEmpty) {
  console.log(`  ${CAT_LABEL[r._cat]} ${YEAR}-${String(r._month).padStart(2, '0')} | ${r.nameCN || r.name} | detail=[${r._tags.slice(0, 8).join(', ')}]`);
}

/* ---- ⑤ 全量：详情能否带来 metaTags 之外的**新内容词** ---- */
console.log('\n=== ⑤ 非空条目：详情里还能挖出多少「列表没有的内容词」===');
const nonEmpty = all.filter(e => pick(e.metaTags).length).slice(0, 40);
let extra = 0, extraWords = new Map();
for (const it of nonEmpty) {
  try {
    const d = await getJson(`https://next.bgm.tv/p1/subjects/${it.id}`);
    const tags = rawTags(d.tags).slice(0, TOP);
    const listWl = new Set(pick(it.metaTags, 2));
    const newContent = tags.filter(t => WL.has(t) && !listWl.has(t));
    if (newContent.length) { extra++; newContent.forEach(t => extraWords.set(t, (extraWords.get(t) || 0) + 1)); }
    // 一并累计「非元信息、且不在白名单」的词，扩大候选池
    tags.filter(t => !META.has(t) && !WL.has(t)).forEach(t => detailTagFreq.set(t, (detailTagFreq.get(t) || 0) + 1));
    tags.filter(t => WL.has(t)).forEach(t => detailHitFreq.set(t, (detailHitFreq.get(t) || 0) + 1));
    new Set(tags).forEach(t => allTagFreq.set(t, (allTagFreq.get(t) || 0) + 1));
    new Set(tags).forEach(t => allTagFreq.set(t, (allTagFreq.get(t) || 0) + 1));
  } catch { }
  await sleep(120);
}
console.log(`  抽查 ${nonEmpty.length} 条：${extra} 条的详情能给出「列表没显示出来的白名单内容词」`);
console.log(`  这些词：${sorted(extraWords).slice(0, 15).map(([t, c]) => `${t}×${c}`).join('，') || '—'}`);
