/**
 * 用 v0 列表的「全量 tags」重算两级白名单覆盖率，与旧口径（p1 的 metaTags）对比。
 * 词表从 bili-anime-replace.user.js 实时解析，保证与脚本一致。
 * 用法：node tools/coverage-with-full-tags.mjs [year] [limit]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERJS = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const YEAR = process.argv[2] || '2026';
const LIMIT = Number(process.argv[3]) || 100;
const UA = 'bili-bgm-overlay/1.3.0 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';

// —— 从脚本解析词表（容忍注释/换行）——
const grab = (name) => {
  const m = USERJS.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (!m) throw new Error('未找到 ' + name);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
};
const T1 = grab('TAG_T1'), T2 = grab('TAG_T2'), T3 = grab('TAG_T3');
console.log(`词表（从脚本解析）：T1 ${T1.length} 词 / T2 ${T2.length} 词 / T3 ${T3.length} 词`);
console.log(`  T1: ${T1.join(' ')}`);
console.log(`  T2: ${T2.join(' ')}`);
console.log(`  T3: ${T3.join(' ')}`);

const get = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  return r.status === 200 ? await r.json() : null;
};

// —— 拉该年 TV 全部条目（limit≤100，offset 翻页）——
const cats = [[1, 'TV'], [5, 'WEB'], [2, 'OVA'], [3, '剧场版']];
const all = [];
for (const [cat, label] of cats) {
  let off = 0, total = null;
  for (;;) {
    const j = await get(`https://api.bgm.tv/v0/subjects?type=2&cat=${cat}&year=${YEAR}&limit=${LIMIT}&offset=${off}`);
    if (!j || !j.data?.length) break;
    total = j.total;
    all.push(...j.data.map(x => ({ ...x, _cat: label })));
    off += j.data.length;
    if (off >= total) break;
  }
  console.log(`  ${label} 拉取 ${off} 条（total=${total}）`);
}

const S1 = new Set(T1), S2 = new Set(T2), S3 = new Set(T3);
const tagNames = (it, field) => {
  const v = it[field];
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => (typeof x === 'object' ? x.name : x)))];  // 去重！v0 的 meta_tags 带重复
};

const stat = { noTags: 0, t1: 0, onlyT2: 0, onlyT3: 0, none: 0, noTagsField: 0 };
const missAll = [];
const hitT1Count = new Map(T1.map(t => [t, 0]));
const hitT2Count = new Map(T2.map(t => [t, 0]));

for (const it of all) {
  const full = tagNames(it, 'tags');
  if (!full.length) { stat.noTagsField++; }
  const t1 = full.filter(x => S1.has(x));
  const t2 = full.filter(x => S2.has(x));
  const t3 = full.filter(x => S3.has(x));
  for (const x of t1) hitT1Count.set(x, hitT1Count.get(x) + 1);
  for (const x of t2) hitT2Count.set(x, hitT2Count.get(x) + 1);
  if (t1.length) stat.t1++;
  else if (t2.length) stat.onlyT2++;
  else if (t3.length) stat.onlyT3++;
  else { stat.none++; if (missAll.length < 25) missAll.push({ it, full }); }
}
const N = all.length;
const p = (n) => ((n / N) * 100).toFixed(1) + '%';
console.log(`\n=== v0 全量 tags 口径 · ${YEAR} 年 ${N} 条 ===`);
console.log(`  tags 字段为空的: ${stat.noTagsField}`);
console.log(`  命中 Tier1（题材）      : ${String(stat.t1).padStart(4)}  ${p(stat.t1)}`);
console.log(`  仅命中 Tier2（来源/受众）: ${String(stat.onlyT2).padStart(4)}  ${p(stat.onlyT2)}`);
console.log(`  仅命中 Tier3（平台/地区）: ${String(stat.onlyT3).padStart(4)}  ${p(stat.onlyT3)}`);
console.log(`  三级全未命中            : ${String(stat.none).padStart(4)}  ${p(stat.none)}`);
console.log(`  ── 覆盖率：T1 = ${p(stat.t1)} ｜ T1+T2 = ${p(stat.t1 + stat.onlyT2)} ｜ T1+T2+T3 = ${p(stat.t1 + stat.onlyT2 + stat.onlyT3)}`);

console.log('\n  未命中任何白名单词的条目（全量 tags 原文，最多 25 条）：');
for (const { it, full } of missAll) {
  console.log(`    [${it._cat}] ${String(it.name_cn || it.name).slice(0, 20)}`);
  console.log(`        ${full.join(' | ')}`);
}

console.log('\n  Tier1 命中 Top12：' + [...hitT1Count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ':' + v).join(' '));
console.log('  Tier2 命中 Top12：' + [...hitT2Count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ':' + v).join(' '));
console.log('  Tier1 零命中词：' + [...hitT1Count.entries()].filter(([, v]) => v === 0).map(([k]) => k).join(' ') || '（无）');
console.log('  Tier2 零命中词：' + [...hitT2Count.entries()].filter(([, v]) => v === 0).map(([k]) => k).join(' ') || '（无）');

fs.writeFileSync(path.join(ROOT, 'tools/.e2e-anime-out', `full-tags-${YEAR}.json`), JSON.stringify(all));
console.log(`\n缓存 → tools/.e2e-anime-out/full-tags-${YEAR}.json（${N} 条）`);
