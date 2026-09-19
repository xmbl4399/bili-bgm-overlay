#!/usr/bin/env node
/**
 * 把「列表筛不出 tag」的条目逐个拉详情，**原样打印 API 输出的 tag 名**（带票数）。
 * 不做任何白名单判断的结论，只呈现数据。
 *
 * 用法：node tools/dump-empty-tags.mjs [year=2026] [--cat=1] [--limit=15]
 *   --cat=0 表示四个分类全取
 */
import fs from 'node:fs';
import path from 'node:path';

const YEAR = Number(process.argv.find(a => /^\d{4}$/.test(a)) || 2026);
const CAT_ARG = Number((process.argv.find(a => a.startsWith('--cat=')) || '').split('=')[1]);
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 15;
const CATS = CAT_ARG ? [CAT_ARG] : [1, 5, 2, 3];
const CAT_LABEL = { 1: 'TV', 5: 'WEB', 2: 'OVA', 3: '剧场版' };
const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 白名单直接从脚本里读，保证与线上行为一致
const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const WL = new Set(src.match(/const TAG_WHITELIST = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g).map(s => s.slice(1, -1)));
console.log(`白名单 ${WL.size} 词（读自 bili-anime-replace.user.js）\n`);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'bili-bgm-overlay/tag-dump' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(700 * (i + 1)); }
  }
}
const names = v => !Array.isArray(v) ? [] : v.map(t => typeof t === 'string' ? t : (t && t.name) || '').filter(Boolean);
/** 详情 tags 可能是 [{name,count}] 或 string[] —— 统一成 [{name,count}]，count 未知则 null */
const pairs = v => !Array.isArray(v) ? [] :
  v.map(t => typeof t === 'string' ? { name: t, count: null } : { name: (t && t.name) || '', count: t && typeof t.count === 'number' ? t.count : null })
    .filter(x => x.name);

/* ---- 1) 取列表，找出列表层筛不出白名单词的条目 ---- */
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
const listHits = e => names(e.metaTags).filter(t => WL.has(t));
const empty = all.filter(e => !listHits(e).length);
console.log(`总条目 ${all.length}；列表 metaTags 筛不出 tag：${empty.length}\n`);

/* ---- 2) 逐个拉详情，原样打印 ---- */
const dump = [];
const wlFreq = new Map(), nonWlFreq = new Map();

for (let i = 0; i < empty.length; i++) {
  const it = empty[i];
  let tags = [];
  try {
    const d = await getJson(`https://next.bgm.tv/p1/subjects/${it.id}`);
    tags = pairs(d.tags);
  } catch (e) { console.log(`  [ERR] ${it.id} ${e.message}`); continue; }
  dump.push({ ...it, _tags: tags });
  for (const t of tags) {
    const box = WL.has(t.name) ? wlFreq : nonWlFreq;
    box.set(t.name, (box.get(t.name) || 0) + 1);
  }
  await sleep(130);
}

console.log('='.repeat(78));
console.log(`【明细】前 ${Math.min(LIMIT, dump.length)} 条：列表 metaTags vs 详情完整 tags`);
console.log('（★ = 该词已在白名单里，列表却没给出来）');
console.log('='.repeat(78));
for (const r of dump.slice(0, LIMIT)) {
  console.log(`\n[${CAT_LABEL[r._cat]} ${YEAR}-${String(r._month).padStart(2, '0')}] id=${r.id}  ${r.nameCN || r.name}`);
  if (r.nameCN && r.name) console.log(`  原名: ${r.name}`);
  console.log(`  列表 metaTags (${names(r.metaTags).length}): ${names(r.metaTags).join(' / ') || '（空）'}`);
  const hit = r._tags.filter(t => WL.has(t.name)).map(t => t.name);
  console.log(`  详情 tags (${r._tags.length}): ` + r._tags.map(t => {
    const c = t.count != null ? `(${t.count})` : '';
    return WL.has(t.name) ? `★${t.name}${c}` : `${t.name}${c}`;
  }).join('  '));
  console.log(`  → 详情里命中白名单的：${hit.length ? hit.join('、') : '无'}`);
}

const sorted = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
console.log('\n' + '='.repeat(78));
console.log(`【汇总】${dump.length} 条空条目的详情 tag 里，白名单词 vs 非白名单词`);
console.log('='.repeat(78));
console.log('\n--- 命中白名单的词（列表没给，详情给了）---');
for (const [t, c] of sorted(wlFreq)) console.log(`  ★${t}\t× ${c}`);
console.log('\n--- 不在白名单的词 Top 40（元信息+内容词混排）---');
for (const [t, c] of sorted(nonWlFreq).slice(0, 40)) console.log(`  ${t}\t× ${c}`);
