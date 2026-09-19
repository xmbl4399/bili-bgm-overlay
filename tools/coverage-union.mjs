/**
 * 三种口径 × 两级白名单 覆盖率对比（读 full-tags-*.json 缓存，零网络请求）
 *   口径A meta_tags only  —— 服务端结构化摘要（几乎总有值，题材词少）
 *   口径B tags only       —— 用户投票全量（题材词丰富，冷门条目可能空）
 *   口径C union(A,B)      —— 并集（预期最优：题材靠 B、兜底靠 A）
 * 用法：node tools/coverage-union.mjs [2026,2025,...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools/.e2e-anime-out');
const USERJS = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const grab = (n) => [...USERJS.match(new RegExp(n + '\\s*=\\s*\\[([\\s\\S]*?)\\]'))[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
const T1 = new Set(grab('TAG_T1')), T2 = new Set(grab('TAG_T2')), T3 = new Set(grab('TAG_T3'));

const years = (process.argv[2] || '2026').split(',').map(s => s.trim());
const names = (it, f) => {
  const v = it[f];
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => (typeof x === 'object' ? x.name : x)))];
};

const rows = [];
for (const y of years) {
  const f = path.join(OUT, `full-tags-${y}.json`);
  if (!fs.existsSync(f)) { console.log(`（跳过 ${y}：无缓存 ${path.basename(f)}）`); continue; }
  const all = JSON.parse(fs.readFileSync(f, 'utf8'));
  const calc = (pick) => {
    const s = { empty: 0, t1: 0, onlyT2: 0, onlyT3: 0, none: 0 };
    const miss = [];
    for (const it of all) {
      const list = names(it, 'meta_tags').concat(pick(it)).filter((v, i, a) => a.indexOf(v) === i);
      if (!list.length) s.empty++;
      const h1 = list.filter(x => T1.has(x)), h2 = list.filter(x => T2.has(x)), h3 = list.filter(x => T3.has(x));
      if (h1.length) s.t1++; else if (h2.length) s.onlyT2++; else if (h3.length) s.onlyT3++;
      else { s.none++; if (miss.length < 40) miss.push({ it, list }); }
    }
    return { s, miss, n: all.length };
  };
  const A = calc(() => []);
  const B = calc(it => names(it, 'tags'));
  const C = calc(it => names(it, 'tags'));
  const pct = (x, n) => ((x / n) * 100).toFixed(1).padStart(5) + '%';
  console.log(`\n${'='.repeat(78)}\n=== ${y} 年 · ${all.length} 条（TV+WEB+OVA+剧场版） ===\n${'='.repeat(78)}`);
  console.log('口径'.padEnd(22) + '空字段  T1命中   仅T2    仅T3   全未中  │ T1     T1+T2   T1+T2+T3');
  for (const [label, r] of [['A  meta_tags only', A], ['B  tags only', B], ['C  meta_tags ∪ tags', C]]) {
    const { s, n } = r;
    console.log(label.padEnd(22) + String(s.empty).padStart(4) + String(s.t1).padStart(7) + String(s.onlyT2).padStart(7) + String(s.onlyT3).padStart(7) + String(s.none).padStart(7)
      + '  │ ' + pct(s.t1, n) + ' ' + pct(s.t1 + s.onlyT2, n) + ' ' + pct(s.t1 + s.onlyT2 + s.onlyT3, n));
  }
  const emptyInB = all.filter(it => !names(it, 'tags').length);
  if (emptyInB.length) {
    console.log(`\n  tags 为空的条目 ${emptyInB.length} 条 —— 其 meta_tags（去重后）: ` +
      [...new Set(emptyInB.map(it => names(it, 'meta_tags').join('+') || '(空)'))].slice(0, 8).join(' ｜ '));
  }
  if (A.s.none) {
    console.log(`\n  ★ 口径A 仍全未命中的 ${A.s.none} 条（这才是真正的盲区）:`);
    for (const { it, list } of A.miss.slice(0, 15)) console.log(`    [${it._cat || '?'}] ${String(it.name_cn || it.name).slice(0, 22).padEnd(24)} ${list.join(' | ') || '(两级皆空)'}`);
  }
  // —— 分类型（TV/WEB/OVA/剧场版）逐个算，这是关键：之前「100%」只是 TV 一类的结论 ——
  console.log(`\n  ── ${y} 年 · 分类型明细（口径 C = meta_tags ∪ tags）──`);
  console.log('  类型'.padEnd(10) + '条数  │  T1     T1+T2   T1+T2+T3  全未中  仅T3');
  for (const cat of ['TV', 'WEB', 'OVA', '剧场版']) {
    const sub = all.filter(it => (it._cat || 'TV') === cat);
    if (!sub.length) continue;
    const t = { t1: 0, o2: 0, o3: 0, none: 0 };
    for (const it of sub) {
      const list = [...new Set(names(it, 'meta_tags').concat(names(it, 'tags')))];
      const h1 = list.some(x => T1.has(x)), h2 = list.some(x => T2.has(x)), h3 = list.some(x => T3.has(x));
      if (h1) t.t1++; else if (h2) t.o2++; else if (h3) t.o3++; else t.none++;
    }
    const n = sub.length, pc = (x) => ((x / n) * 100).toFixed(1).padStart(5) + '%';
    console.log(`  ${cat.padEnd(8)}${String(n).padStart(4)}  │ ${pc(t.t1)} ${pc(t.t1 + t.o2)} ${pc(t.t1 + t.o2 + t.o3)} ${pc(t.none)} ${pc(t.o3)}`);
  }
  // meta_tags 为空 vs tags 为空 的类型分布
  const eA = all.filter(it => !names(it, 'meta_tags').length);
  const eB = all.filter(it => !names(it, 'tags').length);
  const dist = (arr) => ['TV', 'WEB', 'OVA', '剧场版'].map(c => c + ' ' + arr.filter(x => (x._cat || 'TV') === c).length).join(' / ');
  console.log(`\n  meta_tags 空条目 ${eA.length} 条 类型分布: ${dist(eA)}`);
  console.log(`  tags      空条目 ${eB.length} 条 类型分布: ${dist(eB)}`);
  console.log(`  ★ meta_tags 的词是否 100% 落在 T1∪T2∪T3 内: ${A.s.none === A.s.empty ? '是（全未中 ≡ 空字段）' : '否（有非空却全未中的）'}`);

  rows.push({ y, A, B, C });
}

console.log('\n' + '='.repeat(78));
console.log('结论速览（T1+T2+T3 覆盖率）：');
for (const { y, A, B, C } of rows) {
  const pc = (r) => (((r.s.t1 + r.s.onlyT2 + r.s.onlyT3) / r.n) * 100).toFixed(1) + '%';
  const pc1 = (r) => ((r.s.t1 / r.n) * 100).toFixed(1) + '%';
  console.log(`  ${y}: A ${pc(A)} (T1 ${pc1(A)}) ｜ B ${pc(B)} (T1 ${pc1(B)}) ｜ C ${pc(C)} (T1 ${pc1(C)})`);
}
