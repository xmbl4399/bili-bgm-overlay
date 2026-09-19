#!/usr/bin/env node
/**
 * 两级白名单构建 + 覆盖率评估（**完全弃用现有白名单**）。
 *
 * 原理：白名单只能从「列表接口 metaTags 的真实词汇表」里筛，不从想象里写。
 *   1) 拉取/读缓存 N 年的列表数据（tools/.e2e-anime-out/tag-cache-{YEAR}.json）
 *   2) 取三年词汇表并集 → 按分类表逐词打标（题材 / 来源 / 受众 / 平台 / 地区 / 形式 / 分级）
 *   3) Tier1 = 题材；Tier2 = 来源 + 受众（+ 可选 Tier3 = 平台 + 地区，用于兜底显示）
 *   4) 在指定年份上评估覆盖率，并拆出「显示覆盖率」与「题材覆盖率」两个口径
 *
 * 用法：node tools/whitelist-tiers.mjs [years=2026,2025,2024] [--eval=2024] [--refresh]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tools/.e2e-anime-out');
const CATS = { 1: 'TV', 5: 'WEB', 2: 'OVA', 3: '剧场版' };
const YEARS = (process.argv.find(a => /^[\d,]+$/.test(a)) || '2026,2025,2024').split(',').map(Number);
const EVAL = Number((process.argv.find(a => a.startsWith('--eval=')) || '').slice(7)) || YEARS[YEARS.length - 1];
const REFRESH = process.argv.includes('--refresh');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ==================================================================== *
 * 1. 分类表 —— 列表词汇表的「语义归类」（唯一人工知识，其余全靠数据）
 *    ⚠️ 只对**真实出现过的词**生效；出现未归类词时脚本会告警
 * ==================================================================== */
const CLS = {
  题材: ['奇幻', '战斗', '恋爱', '喜剧', '日常', '校园', '科幻', '冒险', '玄幻', '音乐',
    '百合', '穿越', '运动', '悬疑', '剧情', '后宫', '职场', '历史', '机战', '美食',
    '推理', '武侠', '萌系', 'BL', '恐怖', '惊悚', '耽美'],
  来源: ['漫画改', '原创', '小说改', '游戏改', '同人', '影视改'],
  受众: ['少年向', '青年向', '子供向', '女性向', '少女向', '乙女'],
  平台: ['TV', 'WEB', 'OVA', '剧场版'],
  地区: ['日本', '中国', '欧美', '美国', '法国', '韩国'],
  形式: ['短片集', '短片'],
  分级: ['R18'],
};
const GROUP_OF = new Map();
for (const [g, ws] of Object.entries(CLS)) for (const w of ws) GROUP_OF.set(w, g);
const TIER_OF = g => (g === '题材' ? 1 : (g === '来源' || g === '受众') ? 2
  : (g === '平台' || g === '地区') ? 3 : 0);   // 0 = 不进白名单（形式/分级）

/* ==================================================================== *
 * 2. 取数（带缓存，与 tag-freq.mjs 共用 ⇒ 已缓存年份零请求）
 * ==================================================================== */
async function loadYear(year) {
  const cache = path.join(OUT, `tag-cache-${year}.json`);
  if (!REFRESH && fs.existsSync(cache)) {
    const items = JSON.parse(fs.readFileSync(cache, 'utf8'));
    console.log(`[${year}] 读缓存 ${path.basename(cache)}：${items.length} 条（零请求）`);
    return items;
  }
  const items = [];
  const skipped = [];
  for (const [cat, label] of Object.entries(CATS)) {
    for (let m = 1; m <= 12; m++) {
      let j = null;
      for (let t = 0; t < 3; t++) {
        try {
          const r = await fetch(`https://next.bgm.tv/p1/subjects?type=2&cat=${cat}&year=${year}&month=${m}&page=1`,
            { headers: { 'User-Agent': 'bili-bgm-overlay/tiers' }, signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          j = await r.json(); break;
        } catch (e) { if (t === 2) skipped.push(`${label}${m}月(${e.message})`); await sleep(800 * (t + 1)); }
      }
      if (!j) continue;
      for (const e of (j.data || [])) {
        items.push({ cat: label, month: m, id: e.id, name: e.nameCN || e.name,
          metaTags: Array.isArray(e.metaTags) ? e.metaTags : [] });
      }
      await sleep(90);
    }
  }
  fs.writeFileSync(cache, JSON.stringify(items));
  console.log(`[${year}] 已请求并缓存 → ${path.basename(cache)}：${items.length} 条${skipped.length ? `，跳过 ${skipped.length} 个月：${skipped.join(' ')}` : ''}`);
  return items;
}

const DATA = {};
for (const y of YEARS) DATA[y] = await loadYear(y);

const vocabOf = items => {
  const f = new Map();
  for (const it of items) for (const t of new Set(it.metaTags)) f.set(t, (f.get(t) || 0) + 1);
  return f;
};
const VOCAB = Object.fromEntries(YEARS.map(y => [y, vocabOf(DATA[y])]));

/* 三年并集词汇表 */
const ALL = new Map();                      // tag → {2024:n, 2025:n, 2026:n, total}
for (const y of YEARS) for (const [t, c] of VOCAB[y]) {
  if (!ALL.has(t)) ALL.set(t, { total: 0 });
  ALL.get(t)[y] = c; ALL.get(t).total += c;
}
const allWords = [...ALL.keys()];
const unclassified = allWords.filter(w => !GROUP_OF.has(w));

/* ==================================================================== *
 * 3. 构造两级白名单（只含真实出现过的词）
 * ==================================================================== */
const TIER1 = allWords.filter(w => TIER_OF(GROUP_OF.get(w)) === 1);
const TIER2 = allWords.filter(w => TIER_OF(GROUP_OF.get(w)) === 2);
const TIER3 = allWords.filter(w => TIER_OF(GROUP_OF.get(w)) === 3);
const EXCLUDED = allWords.filter(w => TIER_OF(GROUP_OF.get(w)) === 0);

const sortByFreq = ws => [...ws].sort((a, b) => (ALL.get(b)?.total || 0) - (ALL.get(a)?.total || 0));

console.log(`\n三年样本：${YEARS.map(y => `${y}=${DATA[y].length}`).join('  ')}  合计 ${YEARS.reduce((s, y) => s + DATA[y].length, 0)} 条`);
console.log(`词汇表并集 ${allWords.length} 词 → 题材 ${TIER1.length} / 来源 ${TIER2.filter(w => GROUP_OF.get(w) === '来源').length} / 受众 ${TIER2.filter(w => GROUP_OF.get(w) === '受众').length} / 平台 ${TIER3.filter(w => GROUP_OF.get(w) === '平台').length} / 地区 ${TIER3.filter(w => GROUP_OF.get(w) === '地区').length} / 排除 ${EXCLUDED.length}`);
if (unclassified.length) console.log(`⚠️ 未归类词（分类表缺这些，需补）：${unclassified.join(' ')}`);

console.log('\n=== ① Tier1 题材（按三年合计次数降序）===');
for (const w of sortByFreq(TIER1)) console.log(`  ${w}\t${ALL.get(w).total}\t（${YEARS.map(y => `${y}:${VOCAB[y].get(w) || 0}`).join(' ')}）`);
console.log('\n=== ② Tier2 来源 + 受众 ===');
for (const w of sortByFreq(TIER2)) console.log(`  [${GROUP_OF.get(w)}] ${w}\t${ALL.get(w).total}\t（${YEARS.map(y => `${y}:${VOCAB[y].get(w) || 0}`).join(' ')}）`);
console.log('\n=== ③ Tier3 平台 + 地区（仅兜底显示用，非题材）===');
for (const w of sortByFreq(TIER3)) console.log(`  [${GROUP_OF.get(w)}] ${w}\t${ALL.get(w).total}`);
console.log(`\n=== ④ 不进白名单 ===\n  ${EXCLUDED.map(w => `${w}[${GROUP_OF.get(w)}]`).join('  ')}`);

/* ==================================================================== *
 * 3.5 边际贡献度 —— 「作为唯一命中词」的条目数
 *     = 0 ⇒ 该词永远与其他白名单词共现，删掉不影响覆盖率（纯装饰）
 * ==================================================================== */
const unionItems = YEARS.flatMap(y => DATA[y]);
const marginal = words => {
  const ws = new Set(words), m = new Map(words.map(w => [w, 0]));
  for (const it of unionItems) {
    const hits = [...new Set(it.metaTags)].filter(t => ws.has(t));
    if (hits.length === 1) m.set(hits[0], m.get(hits[0]) + 1);
  }
  return m;
};
const m1 = marginal(TIER1), m2 = marginal(TIER2);
const isRedundant = w => ((m1.get(w) ?? m2.get(w)) ?? 0) === 0;
const CORE1 = TIER1.filter(w => !isRedundant(w));
const CORE2 = TIER2.filter(w => !isRedundant(w));
const BYE = [...TIER1, ...TIER2].filter(isRedundant);

console.log(`\n=== ⑤ 边际贡献度（三年 ${unionItems.length} 条里「作为唯一命中词」的条目数）===`);
console.log('  Tier1 题材：');
for (const w of sortByFreq(TIER1))
  console.log(`    ${w.padEnd(6)}\t唯一命中 ${String(m1.get(w)).padStart(3)}${m1.get(w) === 0 ? '   ← 零贡献' : ''}`);
console.log('  Tier2 来源/受众：');
for (const w of sortByFreq(TIER2))
  console.log(`    ${w.padEnd(6)}\t唯一命中 ${String(m2.get(w)).padStart(3)}${m2.get(w) === 0 ? '   ← 零贡献' : ''}`);
console.log(`\n  零贡献词 ${BYE.length} 个（删掉不影响覆盖率）：${BYE.join(' ') || '（无）'}`);
console.log(`  核心白名单 = Tier1 ${CORE1.length} 词 + Tier2 ${CORE2.length} 词 = ${CORE1.length + CORE2.length} 词`);

/* ==================================================================== *
 * 4. 覆盖率评估
 * ==================================================================== */
const T1 = new Set(TIER1), T12 = new Set([...TIER1, ...TIER2]), T123 = new Set([...TIER1, ...TIER2, ...TIER3]);
const C12 = new Set([...CORE1, ...CORE2]);
const C123 = new Set([...CORE1, ...CORE2, ...TIER3]);

function evalPlan(items, set) {
  let onlyT1 = 0, onlyT2 = 0, onlyT3 = 0, empty = 0;
  const emptyItems = [];
  const t1set = new Set(TIER1), t2set = new Set(TIER2), t3set = new Set(TIER3);
  for (const it of items) {
    const s = [...new Set(it.metaTags)];
    const has1 = s.some(t => t1set.has(t));
    const has2 = s.some(t => t2set.has(t));
    const has3 = s.some(t => t3set.has(t));
    const inSet = s.some(t => set.has(t));
    if (has1) onlyT1++; else if (has2) onlyT2++; else if (has3) onlyT3++;
    if (!inSet) { empty++; emptyItems.push(it); }
  }
  return { total: items.length, display: items.length - empty, empty, emptyItems, hasT1: onlyT1, hasT2only: onlyT2, hasT3only: onlyT3 };
}

/* 详情补拉触发率 = 没有题材词（Tier1 未命中）的条目占比 */
function detailTrigger(items) {
  const t1set = new Set(TIER1);
  const need = items.filter(it => ![...new Set(it.metaTags)].some(t => t1set.has(t)));
  const salvage = need.filter(it => ALL.size && it.metaTags.length);   // 有 metaTags 但无题材词
  return { need: need.length, total: items.length, salvage: salvage.length };
}

console.log(`\n${'='.repeat(70)}\n覆盖率评估 · 评估年 = ${EVAL}（${DATA[EVAL].length} 条）\n${'='.repeat(70)}`);
const items = DATA[EVAL];
const e1 = evalPlan(items, T1), e12 = evalPlan(items, T12), e123 = evalPlan(items, T123);
const ec = evalPlan(items, C12), ec3 = evalPlan(items, C123);
const pct = n => (n / items.length * 100).toFixed(1) + '%';
console.log(`  仅 Tier1 题材（${TIER1.length} 词）              → 有词 ${e1.display}/${items.length} = ${pct(e1.display)}   空 ${e1.empty}`);
console.log(`  Tier1 + Tier2 来源/受众（${T12.size} 词）        → 有词 ${e12.display}/${items.length} = ${pct(e12.display)}   空 ${e12.empty}`);
console.log(`  Tier1 + Tier2 + Tier3 平台/地区（${T123.size} 词）→ 有词 ${e123.display}/${items.length} = ${pct(e123.display)}   空 ${e123.empty}`);
console.log(`  —— 去零贡献词后的核心白名单 ——`);
console.log(`  核心 T1+T2（${C12.size} 词）                    → 有词 ${ec.display}/${items.length} = ${pct(ec.display)}   空 ${ec.empty}${ec.display === e12.display ? '   ✅ 与全集等同（删词无损）' : '   ⚠️ 有损'}`);
console.log(`  核心 T1+T2+T3（${C123.size} 词）                → 有词 ${ec3.display}/${items.length} = ${pct(ec3.display)}   空 ${ec3.empty}${ec3.display === e123.display ? '   ✅ 与全集等同' : '   ⚠️ 有损'}`);
const dt = detailTrigger(items);
console.log(`\n  卡上会显示什么（Tier1+Tier2 方案）：`);
console.log(`    题材词（Tier1）    ${String(e12.hasT1).padStart(3)} 条 = ${pct(e12.hasT1)}`);
console.log(`    仅来源/受众（T2）  ${String(e12.hasT2only).padStart(3)} 条 = ${pct(e12.hasT2only)}`);
console.log(`  详情补拉触发率（无题材词 → 该去拉详情）= ${dt.need}/${dt.total} = ${pct(dt.need)}`);

console.log(`\n=== ⑥ ${EVAL} 年「Tier1+Tier2」仍为空的条目 ===`);
if (!e12.emptyItems.length) console.log('  （无）');
for (const it of e12.emptyItems) console.log(`  [${it.cat} ${EVAL}-${String(it.month).padStart(2, '0')}] ${String(it.name).slice(0, 30).padEnd(32)} ${it.metaTags.join(' / ') || '（空数组）'}`);

console.log('\n=== ⑦ 其余年份（同口径对照）===');
for (const y of YEARS) {
  if (y === EVAL) continue;
  const es = evalPlan(DATA[y], T12);
  console.log(`  ${y}（${DATA[y].length} 条）  ${es.display}/${DATA[y].length} = ${pct0(es.display, DATA[y].length)}   空 ${es.empty}   题材词命中 ${pct0(es.hasT1, DATA[y].length)}`);
}
function pct0(a, b) { return (a / b * 100).toFixed(1) + '%'; }

/* ==================================================================== *
 * 5. 落盘
 * ==================================================================== */
const tsv = [];
tsv.push('# 两级白名单（完全弃用旧白名单，只从三年列表接口真实词汇表筛选）');
tsv.push(`# 年份：${YEARS.join(', ')}    评估年：${EVAL}`);
tsv.push(`# Tier1 题材 ${TIER1.length} 词 / Tier2 来源·受众 ${TIER2.length} 词 / Tier3 平台·地区 ${TIER3.length} 词（兜底显示）/ 排除 ${EXCLUDED.length} 词`);
tsv.push(`# 覆盖率（${EVAL}）：仅T1 ${pct(e1.display)}   T1+T2 ${pct(e12.display)}   T1+T2+T3 ${pct(e123.display)}`);
tsv.push('');
tsv.push('# ① 三年词汇表（含分类、层级、各年次数、是否入选）');
tsv.push('tag\t分类\t层级\t' + YEARS.join('\t') + '\t三年合计\t入选');
for (const w of [...allWords].sort((a, b) => (ALL.get(b).total - ALL.get(a).total) || a.localeCompare(b, 'zh'))) {
  const g = GROUP_OF.get(w) || '（未归类）';
  const t = TIER_OF(g);
  tsv.push(`${w}\t${g}\t${t === 0 ? '排除' : 'Tier' + t}\t${YEARS.map(y => VOCAB[y].get(w) || 0).join('\t')}\t${ALL.get(w).total}\t${t ? '是' : '否'}`);
}
tsv.push('');
tsv.push('# ② 覆盖率对比（各年 × 各方案；核心 = 去掉零贡献词）');
tsv.push('年份\t方案\t词数\t有词条目\t总条目\t有词率\t题材词条目\t题材词率\t空');
for (const y of YEARS) {
  for (const [name, set] of [['仅 Tier1 题材', T1], ['Tier1 + Tier2 来源/受众', T12], ['Tier1+2+3 平台/地区', T123],
    ['核心 T1+T2（去零贡献）', C12], ['核心 T1+T2+T3', C123]]) {
    const es = evalPlan(DATA[y], set);
    tsv.push(`${y}\t${name}\t${set.size}\t${es.display}\t${es.total}\t${pct0(es.display, es.total)}\t${es.hasT1}\t${pct0(es.hasT1, es.total)}\t${es.empty}`);
  }
}
tsv.push('');
tsv.push('# ③ 边际贡献度（三年 648 条里作为唯一命中词的条目数；0 = 删掉不影响覆盖率）');
tsv.push('tag\t层级\t唯一命中条目数');
const margOf = w => (m1.get(w) ?? m2.get(w)) ?? 0;
for (const w of [...TIER1, ...TIER2].sort((a, b) => margOf(b) - margOf(a) || a.localeCompare(b, 'zh')))
  tsv.push(`${w}\tTier${TIER_OF(GROUP_OF.get(w))}\t${margOf(w)}`);
tsv.push('');
tsv.push(`# ④ ${EVAL} 年 Tier1+Tier2 仍为空的条目（列表只给平台/地区，或空数组）`);
tsv.push('年份\t分类\t放送月\t条目\t列表给的 metaTags');
for (const it of e12.emptyItems)
  tsv.push(`${EVAL}\t${it.cat}\t${EVAL}-${String(it.month).padStart(2, '0')}\t${it.name}\t${it.metaTags.join(' / ') || '（空数组）'}`);
const outTsv = path.join(OUT, `whitelist-tiers-${YEARS.join('-')}.tsv`);
fs.writeFileSync(outTsv, tsv.join('\n'));

/* 可直接贴进脚本的白名单 */
const fmt = ws => {
  const lines = [];
  for (let i = 0; i < ws.length; i += 8) lines.push('    ' + ws.slice(i, i + 8).map(w => `'${w}',`).join(' '));
  return lines.join('\n');
};
const txt = [
  `# 两级白名单方案（数据来源：p1 列表接口真实 metaTags，2026+2025+2024 共 ${unionItems.length} 条）`,
  `# 评估年 ${EVAL}：仅T1 题材 ${pct(e1.display)} ｜ T1+T2 来源/受众 ${pct(e12.display)} ｜ T1+T2+T3 平台/地区 ${pct(e123.display)}`,
  '',
  `// ===== Tier1 题材（${TIER1.length} 词，含 ${BYE.filter(w => TIER_OF(GROUP_OF.get(w)) === 1).length} 个零贡献词）=====`,
  `// 显示优先；同时是「要不要拉详情补拉」的判据`,
  fmt(sortByFreq(TIER1)),
  '',
  `// ===== Tier2 来源 + 受众（${TIER2.length} 词，含 ${BYE.filter(w => TIER_OF(GROUP_OF.get(w)) === 2).length} 个零贡献词）=====`,
  `// 仅当 Tier1 一个都没命中时兜底显示`,
  fmt(sortByFreq(TIER2)),
  '',
  `// ===== Tier3 平台 + 地区（${TIER3.length} 词，可选）=====`,
  `// 只有它能让覆盖率到 100%；代价是卡上会出现 TV / 日本`,
  fmt(sortByFreq(TIER3)),
  '',
  `// ===== 最小核心版（去零贡献词，覆盖率与全集完全相同）=====`,
  `// Tier1 核心 ${CORE1.length} 词：`,
  fmt(sortByFreq(CORE1)),
  `// Tier2 核心 ${CORE2.length} 词：`,
  fmt(sortByFreq(CORE2)),
  '',
  `// 排除（不进白名单）：${EXCLUDED.map(w => `${w}[${GROUP_OF.get(w)}]`).join(' ')}`,
  `// 零贡献词（删掉不影响覆盖率）：${BYE.join(' ') || '（无）'}`,
].join('\n');
const outTxt = path.join(OUT, 'whitelist-tiers-proposed.txt');
fs.writeFileSync(outTxt, txt + '\n');

console.log(`\n表 → ${path.relative(ROOT, outTsv)}\n新白名单 → ${path.relative(ROOT, outTxt)}`);
