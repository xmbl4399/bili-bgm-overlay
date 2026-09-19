/**
 * 空卡构成审计 —— 回答「Tier3 关掉之后，那些没有 tag 的卡片到底是什么情况」。
 *
 * 用法：node tools/empty-card-audit.mjs [year=2026]
 *
 * 词表**从 bili-anime-replace.user.js 里现抽**（不在这里复制一份），保证与脚本永远一致。
 * 判定逻辑也与脚本一致：tags 按 count 降序 ++ meta_tags 去重 → T1 ++ T2 →（不足 2 个）T3
 * 只是这里把 Tier3 当作「可救/不可救」的开关来对照统计。
 *
 * 空卡分三类：
 *   A  池空        —— tags 与 meta_tags 都是空数组。**任何词表/通路都救不了**（数据缺失）
 *   B1 池非空、只有平台/地区词 —— 开 Tier3 即可填满；不开就空着（主人的取舍点）
 *   B2 池非空、白名单外词 —— **唯一值得补词的一类**，脚本会把未命中词频次打出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', '.e2e-anime-out');
const YEAR = process.argv[2] || '2026';

/* —— 词表与脚本同源 —— */
const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const grab = name => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
  if (!m) throw new Error(`抽不到 ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
};
const T1 = new Set(grab('TAG_T1'));
const T2 = new Set(grab('TAG_T2'));
const T3 = new Set(grab('TAG_T3'));
const KNOWN = new Set([...T1, ...T2, ...T3]);
const EXCLUDED = new Set(['短片集', '短片', 'R18']);   // 形式/分级：故意不收

const CATNAME = { 1: 'TV', 2: 'OVA', 3: '剧场版', 5: 'WEB' };

/* —— 与脚本 fromV0 + pickTags 同构 —— */
const norm = v => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    const n = typeof t === 'string' ? t : (t && typeof t === 'object' && typeof t.name === 'string' ? t.name : '');
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
};
const poolOf = e => [
  ...(Array.isArray(e.tags) ? e.tags.slice()
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map(t => t.name) : []),
  ...norm(e.meta_tags),
];
const hitIn = (pool, set) => [...new Set(pool)].filter(t => set.has(t));

const file = path.join(OUT, `full-tags-${YEAR}.json`);
const items = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`数据：${path.relative(ROOT, file)} · ${items.length} 条 · 词表 T1 ${T1.size}/T2 ${T2.size}/T3 ${T3.size}\n`);

const rows = [];
for (const e of items) {
  const pool = poolOf(e);
  const t1 = hitIn(pool, T1), t2 = hitIn(pool, T2), t3 = hitIn(pool, T3);
  const two = [...t1, ...t2].slice(0, 2);                 // 不开 Tier3 的最终结果
  const withT3 = [...t1, ...t2, ...t3].slice(0, 2);       // 开 Tier3 的结果
  let kind = 'C';
  if (two.length) kind = 'C';
  else if (!pool.length) kind = 'A';
  else if (t3.length) kind = 'B1';
  else kind = 'B2';
  rows.push({ id: e.id, name: e.name_cn || e.name, cat: CATNAME[e._cat] || e.platform || '?',
    pool, t1, t2, t3, two, withT3, kind });
}

const cnt = k => rows.filter(r => r.kind === k).length;
const total = rows.length;
const pct = n => (n / total * 100).toFixed(1) + '%';

console.log('=== 总览（Tier3 = 关，即脚本当前行为）===');
console.log(`有 tag 卡片   C   : ${String(cnt('C')).padStart(4)}  ${pct(cnt('C'))}`);
console.log(`空卡 · 池空   A   : ${String(cnt('A')).padStart(4)}  ${pct(cnt('A'))}   ← 两字段皆空，无解`);
console.log(`空卡 · 只有平台/地区 B1 : ${String(cnt('B1')).padStart(4)}  ${pct(cnt('B1'))}   ← 开 Tier3 可填`);
console.log(`空卡 · 白名单外词   B2 : ${String(cnt('B2')).padStart(4)}  ${pct(cnt('B2'))}   ← 唯一值得补词的一类`);
console.log(`\n空卡合计：${cnt('A') + cnt('B1') + cnt('B2')} / ${total} = ${pct(cnt('A') + cnt('B1') + cnt('B2'))}`);
console.log(`若开 Tier3 后覆盖率：${pct(cnt('C') + cnt('B1'))}`);
console.log(`只有 1 个 tag 的：${rows.filter(r => r.two.length === 1).length}  ${pct(rows.filter(r => r.two.length === 1).length)}`);

console.log('\n=== 分类型 ===');
const cats = [...new Set(rows.map(r => r.cat))].sort();
console.log('类型'.padEnd(8) + '总数'.padStart(6) + '有tag'.padStart(8) + '池空A'.padStart(7) + '仅地区B1'.padStart(10) + '白名单外B2'.padStart(11) + '覆盖率'.padStart(9));
for (const c of cats) {
  const g = rows.filter(r => r.cat === c);
  const n = g.length;
  const p = k => g.filter(r => r.kind === k).length;
  console.log(String(c).padEnd(8) + String(n).padStart(6) + String(p('C')).padStart(8)
    + String(p('A')).padStart(7) + String(p('B1')).padStart(10) + String(p('B2')).padStart(11)
    + ((p('C') / n * 100).toFixed(1) + '%').padStart(9));
}

/* —— B2：值得补词的判据 —— */
const b2 = rows.filter(r => r.kind === 'B2');
console.log(`\n=== B2（白名单外词）共 ${b2.length} 条，未命中词频次 ===`);
const freq = new Map();
for (const r of b2) for (const t of new Set(r.pool)) {
  if (!KNOWN.has(t) && !EXCLUDED.has(t)) freq.set(t, (freq.get(t) || 0) + 1);
}
console.log([...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`).join('  ') || '（无）');
if (b2.length) {
  console.log('\nB2 逐条：');
  for (const r of b2.slice(0, 40)) {
    console.log(`  [${r.cat}] ${String(r.name).slice(0, 22).padEnd(24)} 池: ${r.pool.join(' ')}`);
  }
  if (b2.length > 40) console.log(`  …另 ${b2.length - 40} 条`);
}

/* —— A：池空条目（数据缺失，多为欧美网络动画/短片） —— */
console.log(`\n=== A（池空）共 ${cnt('A')} 条，逐条 ===`);
for (const r of rows.filter(x => x.kind === 'A').slice(0, 40)) {
  console.log(`  [${r.cat}] ${r.name}`);
}

/* —— 开启 Tier3 会往卡上写什么词 —— */
console.log('\n=== 若开 Tier3，B1 卡片将显示 ===');
const t3freq = new Map();
for (const r of rows.filter(x => x.kind === 'B1')) for (const w of r.withT3) t3freq.set(w, (t3freq.get(w) || 0) + 1);
console.log([...t3freq.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`).join('  ') || '（无）');
