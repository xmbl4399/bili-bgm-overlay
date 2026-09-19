#!/usr/bin/env node
/**
 * 2026 列表接口（p1，只取列表、不碰详情）给出的**全部 tag** 频次统计。
 *   - 按出现次数降序；每行标注是否在白名单
 *   - 末尾给「白名单里在 2026 列表中一次都没出现过」的词
 *   - 列表原始响应落盘缓存（tools/.e2e-anime-out/tag-cache-{YEAR}.json），后续直接读缓存，不再请求
 *
 * 用法：node tools/tag-freq.mjs [year=2026] [--refresh]
 */
import fs from 'node:fs';
import path from 'node:path';

const YEAR = Number(process.argv.find(a => /^\d{4}$/.test(a)) || 2026);
const REFRESH = process.argv.includes('--refresh');
const CATS = { 1: 'TV', 5: 'WEB', 2: 'OVA', 3: '剧场版' };
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, `tools/.e2e-anime-out/tag-cache-${YEAR}.json`);
const OUT_TSV = path.join(ROOT, `tools/.e2e-anime-out/tag-freq-${YEAR}.tsv`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const WL = src.match(/const TAG_WHITELIST = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g).map(s => s.slice(1, -1));
const WLSET = new Set(WL);
/** 白名单里是「注释说明」还是真词，逐词带上（用于最后那张表） */
const WL_ORDER = WL;

let items = null;
if (!REFRESH && fs.existsSync(CACHE)) {
  items = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log(`读缓存 ${path.relative(ROOT, CACHE)}（${items.length} 条，未发起请求）`);
} else {
  items = [];
  for (const [cat, label] of Object.entries(CATS)) {
    for (let m = 1; m <= 12; m++) {
      let j = null;
      for (let t = 0; t < 3; t++) {
        try {
          const r = await fetch(`https://next.bgm.tv/p1/subjects?type=2&cat=${cat}&year=${YEAR}&month=${m}&page=1`,
            { headers: { 'User-Agent': 'bili-bgm-overlay/tag-freq' }, signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          j = await r.json(); break;
        } catch (e) { if (t === 2) console.log(`  [跳过] ${label} ${m}月 ${e.message}`); await sleep(700 * (t + 1)); }
      }
      if (!j) continue;
      for (const e of (j.data || [])) {
        items.push({ cat: label, month: m, id: e.id, name: e.nameCN || e.name,
          metaTags: Array.isArray(e.metaTags) ? e.metaTags : [] });
      }
      await sleep(80);
    }
  }
  fs.writeFileSync(CACHE, JSON.stringify(items));
  console.log(`已请求列表接口并缓存 → ${path.relative(ROOT, CACHE)}（${items.length} 条）`);
}

/* ---- 聚合：列表给出的全部 tag 频次 ---- */
const freq = new Map();            // tag → 出现次数（按条目计）
const byCat = new Map();           // tag → 出现在哪些分类
for (const it of items) {
  for (const t of new Set(it.metaTags)) {
    freq.set(t, (freq.get(t) || 0) + 1);
    if (!byCat.has(t)) byCat.set(t, new Set());
    byCat.get(t).add(it.cat);
  }
}
const rows = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
const wlHit = rows.filter(([t]) => WLSET.has(t));
const notWl = rows.filter(([t]) => !WLSET.has(t));

console.log(`\n条目 ${items.length} 条 · 列表共给出 ${rows.length} 个不同 tag`);
console.log(`  其中在白名单：${wlHit.length} 个    不在白名单：${notWl.length} 个`);

console.log('\n=== ① 列表给出的全部 tag（按次数降序，第三列 = 是否在白名单）===');
console.log('tag\t出现次数\t在白名单');
for (const [t, c] of rows) console.log(`${t}\t${c}\t${WLSET.has(t) ? '✅ 是' : '— 否'}`);

console.log(`\n=== ② 白名单 ${WL.length} 词里，在 2026 列表**一次都没出现**的 ===`);
const zero = WL_ORDER.filter(w => !freq.has(w));
for (const w of zero) console.log(`  ${w}`);
console.log(`\n共 ${zero.length} / ${WL.length} 个白名单词零命中`);
console.log('\n=== ③ 白名单里出现过的（按次数降序）===');
for (const [t, c] of wlHit.sort((a, b) => b[1] - a[1])) console.log(`  ${t} × ${c}`);

const tsv = ['tag\t出现次数\t在白名单\t出现分类']
  .concat(rows.map(([t, c]) => `${t}\t${c}\t${WLSET.has(t) ? '是' : '否'}\t${[...(byCat.get(t) || [])].join(',')}`))
  .concat(['', '—— 白名单零命中 ——', ...zero])
  .join('\n');
fs.writeFileSync(OUT_TSV, tsv);
console.log(`\n表已写入 ${path.relative(ROOT, OUT_TSV)}`);
