#!/usr/bin/env node
/**
 * 合并 2026 + 2025 的「列表接口 metaTags」频次总表（不碰详情）。
 * 列：tag | 2026 次数 | 2025 次数 | 合计 | 在现白名单 | 在方案②白名单 | 出现分类
 * 数据源：tools/.e2e-anime-out/tag-cache-{year}.json（零请求，由 tag-freq.mjs / whitelist-coverage.mjs 落盘）
 *
 * 用法：node tools/tag-freq-merged.mjs [2026,2025]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tools/.e2e-anime-out');
const YEARS = (process.argv.find(a => /^[\d,]+$/.test(a)) || '2026,2025').split(',').map(Number);

const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const CUR = src.match(/const TAG_WHITELIST = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g).map(s => s.slice(1, -1));
const CURSET = new Set(CUR);

/* 方案②：删「两年都零命中」的词 + 加 7 词 */
const VOCAB = {}, DATA = {};
for (const y of YEARS) {
  const items = JSON.parse(fs.readFileSync(path.join(OUT, `tag-cache-${y}.json`), 'utf8'));
  DATA[y] = items;
  const f = new Map();
  for (const it of items) for (const t of new Set(it.metaTags)) f.set(t, (f.get(t) || 0) + 1);
  VOCAB[y] = f;
  console.log(`[${y}] ${items.length} 条（读缓存）`);
}
const ADD7 = ['漫画改', '原创', '子供向', '游戏改', '小说改', '少女向', '少年向'];
const PLAN2 = new Set([...CUR.filter(w => !YEARS.every(y => !VOCAB[y].has(w))), ...ADD7]);

/* 合并频次 */
const total = new Map(), byCat = new Map();
for (const y of YEARS) {
  for (const it of DATA[y]) {
    for (const t of new Set(it.metaTags)) {
      total.set(t, (total.get(t) || 0) + 1);
      if (!byCat.has(t)) byCat.set(t, new Set());
      byCat.get(t).add(it.cat);
    }
  }
}
const rows = [...total.entries()].sort((a, b) =>
  (b[1] - a[1]) || (VOCAB[YEARS[0]].get(b[0]) || 0) - (VOCAB[YEARS[0]].get(a[0]) || 0) || a[0].localeCompare(b[0], 'zh'));

const N = YEARS.reduce((s, y) => s + DATA[y].length, 0);
console.log(`\n合并样本 ${N} 条（${YEARS.map(y => `${y}:${DATA[y].length}`).join(' + ')}）· 列表共给出 ${rows.length} 个不同 tag`);
console.log(`  在现白名单：${rows.filter(([t]) => CURSET.has(t)).length} 个    在方案②白名单：${rows.filter(([t]) => PLAN2.has(t)).length} 个`);
console.log(`\n=== 合并频次总表（按合计降序）===`);
console.log('排名\ttag\t2026\t2025\t合计\t现白名单\t方案②白名单\t出现分类');
rows.forEach(([t, c], i) => {
  console.log([i + 1, t, VOCAB[2026]?.get(t) || 0, VOCAB[2025]?.get(t) || 0, c,
    CURSET.has(t) ? '✅' : '—', PLAN2.has(t) ? '✅' : '—', [...byCat.get(t)].join(',')].join('\t'));
});

/* 白名单里两年都零命中的 */
const zero = CUR.filter(w => !total.has(w));
console.log(`\n=== 现白名单 ${CUR.length} 词里，两年列表都没出现过的 ${zero.length} 个 ===`);
console.log(zero.join('  '));

const tsv = [`# 列表接口 metaTags 合并频次（${YEARS.join(' + ')}），样本 ${N} 条`]
  .concat(['排名\ttag\t' + YEARS.join('\t') + '\t合计\t在现白名单\t在方案②白名单\t出现分类'])
  .concat(rows.map(([t, c], i) => [i + 1, t, ...YEARS.map(y => VOCAB[y].get(t) || 0), c,
    CURSET.has(t) ? '是' : '否', PLAN2.has(t) ? '是' : '否', [...byCat.get(t)].join(',')].join('\t')))
  .concat(['', `# 现白名单两年零命中（${zero.length}）`, zero.join('\t'), '',
    `# 现白名单（${CUR.length} 词）`, CUR.join('\t'), '',
    `# 方案②白名单（${PLAN2.size} 词）`, [...PLAN2].join('\t')]).join('\n');
const outTsv = path.join(OUT, `tag-freq-merged-${YEARS.join('-')}.tsv`);
fs.writeFileSync(outTsv, tsv);
console.log(`\n表 → ${path.relative(ROOT, outTsv)}`);
