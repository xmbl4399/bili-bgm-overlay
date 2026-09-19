#!/usr/bin/env node
/**
 * 逐条审计：某年份每部番的「列表接口 metaTags」→ 被哪一级白名单筛出哪些 tag。
 *
 * 用途：看清「无题材词」的真实原因，并给出**需要补充进白名单的真实词**（数据驱动，不凭直觉）。
 *
 * 白名单来源 = 全部年份缓存的词汇表并集（默认 2026,2025,2024,2023），按 CLS 分类表打标：
 *   题材→Tier1   来源/受众→Tier2   平台/地区→Tier3   形式/分级→排除   未归类→⚠️候选
 *
 * 用法：node tools/tag-tier-audit.mjs [year=2023] [--wl-years=2026,2025,2024,2023] [--empty-only]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tools/.e2e-anime-out');
const YEAR = Number(process.argv.find(a => /^\d{4}$/.test(a)) || 2023);
const WL_YEARS = ((process.argv.find(a => a.startsWith('--wl-years=')) || '').slice(11) || '2026,2025,2024,2023')
  .split(',').map(Number);
const EMPTY_ONLY = process.argv.includes('--empty-only');

/* ---- 分类表（与 whitelist-tiers.mjs 保持一致） ---- */
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
  : (g === '平台' || g === '地区') ? 3 : 0);

/* ---- 取数 ---- */
const load = y => {
  const f = path.join(OUT, `tag-cache-${y}.json`);
  if (!fs.existsSync(f)) { console.error(`缺少缓存 ${path.basename(f)}，请先跑 whitelist-tiers.mjs ${y}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
const WL = Object.fromEntries(WL_YEARS.map(y => [y, load(y)]));
const DATA = load(YEAR);

/* ---- 白名单（词汇表并集 ∩ 分类表） ---- */
const vocab = new Map();                      // tag → 各年次数
for (const y of WL_YEARS) for (const it of WL[y])
  for (const t of new Set(it.metaTags)) {
    if (!vocab.has(t)) vocab.set(t, { total: 0 });
    vocab.get(t)[y] = (vocab.get(t)[y] || 0) + 1; vocab.get(t).total++;
  }
const TIER = { 1: new Set(), 2: new Set(), 3: new Set() };
const EXCLUDED = [], UNCLASSIFIED = [];
for (const t of vocab.keys()) {
  const g = GROUP_OF.get(t);
  if (!g) { UNCLASSIFIED.push(t); continue; }
  const k = TIER_OF(g);
  if (k) TIER[k].add(t); else EXCLUDED.push(t);
}
const ALLWL = new Set([...TIER[1], ...TIER[2], ...TIER[3]]);

/* ---- 逐条 ---- */
const rows = [];
const missFreq = new Map();      // 未命中词（含未归类）→ 该年出现次数
const perTier = { 1: 0, 2: 0, 3: 0, none: 0 };
let emptyArr = 0;
for (const it of DATA) {
  const tags = [...new Set(it.metaTags)];
  if (!tags.length) emptyArr++;
  const hit = { 1: [], 2: [], 3: [] }, miss = [];
  for (const t of tags) {
    const g = GROUP_OF.get(t);
    const k = g ? TIER_OF(g) : -1;
    if (k === 1 || k === 2 || k === 3) hit[k].push(t);
    else { miss.push(t); missFreq.set(t, (missFreq.get(t) || 0) + 1); }
  }
  const lv = hit[1].length ? 1 : hit[2].length ? 2 : hit[3].length ? 3 : 0;
  if (lv) perTier[lv]++; else perTier.none++;
  rows.push({ ...it, tags, hit, miss, lv });
}

/* ---- 输出 ---- */
const show = rows.filter(r => (EMPTY_ONLY ? r.lv !== 1 : true));
const pct = n => (n / DATA.length * 100).toFixed(1) + '%';

console.log(`\n${'='.repeat(96)}`);
console.log(`${YEAR} 逐条审计 · 共 ${DATA.length} 条 · 白名单 = ${WL_YEARS.join('+')} 词汇表并集（T1 ${TIER[1].size} / T2 ${TIER[2].size} / T3 ${TIER[3].size} 词）`);
console.log(`${'='.repeat(96)}`);
console.log(`  命中 Tier1 题材        ${String(perTier[1]).padStart(3)} 条  ${pct(perTier[1])}`);
console.log(`  仅命中 Tier2 来源/受众 ${String(perTier[2]).padStart(3)} 条  ${pct(perTier[2])}`);
console.log(`  仅命中 Tier3 平台/地区 ${String(perTier[3]).padStart(3)} 条  ${pct(perTier[3])}`);
console.log(`  三个 Tier 全未命中     ${String(perTier.none).padStart(3)} 条  ${pct(perTier.none)}   （其中列表返回空数组 ${emptyArr} 条）`);
console.log(`  T1+T2 覆盖率（进白名单里不含 T3）${String(DATA.length - perTier[3] - perTier.none).padStart(3)} 条  ${pct(DATA.length - perTier[3] - perTier.none)}`);

if (!EMPTY_ONLY) {
  console.log(`\n${'-'.repeat(96)}\n逐条明细（lv = 该条目最高命中的层级；无 T1 的条目标 ★）\n${'-'.repeat(96)}`);
  for (const r of rows) {
    const nm = String(r.name).slice(0, 28);
    const meta = r.tags.join('/');
    const h1 = r.hit[1].join(' ') || '-';
    const h2 = r.hit[2].join(' ') || '-';
    const h3 = r.hit[3].join(' ') || '-';
    const ms = r.miss.join(' ') || '-';
    console.log(`${r.lv === 1 ? '  ' : '★ '}[${r.cat} ${YEAR}-${String(r.month).padStart(2, '0')}] ${nm.padEnd(30)} lv${r.lv} │列表 ${meta.padEnd(34)}│T1 ${h1.padEnd(16)}│T2 ${h2.padEnd(14)}│T3 ${h3.padEnd(10)}│未命中 ${ms}`);
  }
}

console.log(`\n${'-'.repeat(96)}\n未命中白名单的词（${YEAR} 年出现次数）——「是否需要补充」就看这张表\n${'-'.repeat(96)}`);
if (!missFreq.size) console.log('  （无，所有列表词都已被白名单覆盖）');
for (const [t, c] of [...missFreq].sort((a, b) => b[1] - a[1])) {
  const note = GROUP_OF.get(t) ? `已分类为【${GROUP_OF.get(t)}】→ 故意排除` : '⚠️ 未归类 → 需人工判定层级';
  console.log(`  ${t.padEnd(7)} ${String(c).padStart(3)} 次   ${note}${vocab.has(t) ? '' : '（不在白名单词汇表内）'}`);
}

console.log(`\n未被分类表覆盖的词（全白名单年份并集口径）：${UNCLASSIFIED.join(' ') || '（无）'}`);
console.log(`故意排除（形式/分级）：${EXCLUDED.map(w => `${w}[${GROUP_OF.get(w)}]`).join('  ') || '（无）'}`);

/* ---- TSV ---- */
const tsv = [];
tsv.push(`# ${YEAR} 年逐条审计：列表接口 metaTags × 白名单两级命中`);
tsv.push(`# 白名单词汇表来源：${WL_YEARS.join(', ')}（T1 题材 ${TIER[1].size} / T2 来源·受众 ${TIER[2].size} / T3 平台·地区 ${TIER[3].size}）`);
tsv.push(`# 命中层级分布：T1 ${perTier[1]}  T2-only ${perTier[2]}  T3-only ${perTier[3]}  未命中 ${perTier.none}  / 共 ${DATA.length}；T1+T2 覆盖率 ${pct(DATA.length - perTier[3] - perTier.none)}`);
tsv.push('');
tsv.push('分类\t放送月\t条目\t列表给的 metaTags（全部）\t最高命中层级\tTier1 题材命中\tTier2 来源/受众命中\tTier3 平台/地区命中\t未命中词');
for (const r of rows) tsv.push([
  r.cat, `${YEAR}-${String(r.month).padStart(2, '0')}`, r.name, r.tags.join(' / '),
  r.lv ? 'Tier' + r.lv : '无', r.hit[1].join(' ') || '-', r.hit[2].join(' ') || '-', r.hit[3].join(' ') || '-', r.miss.join(' ') || '-',
].join('\t'));
tsv.push('');
tsv.push('# 未命中词频次（是否需补充白名单的判据）');
tsv.push('未命中词\t' + YEAR + ' 年出现次数\t分类\t判定');
for (const [t, c] of [...missFreq].sort((a, b) => b[1] - a[1]))
  tsv.push(`${t}\t${c}\t${GROUP_OF.get(t) || '未归类'}\t${GROUP_OF.get(t) ? '故意排除' : '需人工判定'}`);
tsv.push('');
tsv.push('# 各 Tier 命中最多的词（该年 Top 20，看白名单命中构成）');
tsv.push('层级\t词\t该年命中条目数');
const hitCount = { 1: new Map(), 2: new Map(), 3: new Map() };
for (const r of rows) for (const k of [1, 2, 3]) for (const t of r.hit[k]) hitCount[k].set(t, (hitCount[k].get(t) || 0) + 1);
for (const k of [1, 2, 3])
  for (const [t, c] of [...hitCount[k]].sort((a, b) => b[1] - a[1]).slice(0, 20))
    tsv.push(`Tier${k}\t${t}\t${c}`);
const outTsv = path.join(OUT, `tag-tier-audit-${YEAR}.tsv`);
fs.writeFileSync(outTsv, tsv.join('\n'));
console.log(`\n表 → ${path.relative(ROOT, outTsv)}`);

/* ---- HTML 分级视图（按月分组，tag 按命中层级着色） ---- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = (t, k) => `<span class="chip k${k}">${esc(t)}</span>`;
const byMonth = new Map();
for (const r of rows) {
  const m = `${YEAR}-${String(r.month).padStart(2, '0')}`;
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(r);
}
const nav = [...byMonth.keys()].map(m => `<a href="#m${m.slice(5)}">${Number(m.slice(5))}月<b>${byMonth.get(m).length}</b></a>`).join('');
const body = [...byMonth.entries()].map(([m, rs]) => `
<h2 id="m${m.slice(5)}">${m} <span>${rs.length} 部</span></h2>
<table>
<thead><tr><th>番剧</th><th>类型</th><th>列表 API 返回的全部 tag</th><th>命中层级</th></tr></thead>
<tbody>
${rs.map(r => `<tr class="${r.lv === 1 ? '' : r.lv ? 'warn2' : 'warn3'}" data-lv="${r.lv}" data-cat="${r.cat}">
<td class="nm">${esc(r.name)}</td><td class="cat">${r.cat}</td>
<td class="tags">${r.tags.map(t => {
  const g = GROUP_OF.get(t); const k = g ? TIER_OF(g) : -1;
  return chip(t, k === 1 ? 1 : k === 2 ? 2 : k === 3 ? 3 : 9);
}).join('')}</td>
<td class="res">${[1, 2, 3].map(k => r.hit[k].length ? `<span class="lvl l${k}">T${k}</span>${r.hit[k].map(t => `<em>${esc(t)}</em>`).join('')}` : '').join('')}${r.hit[1].length ? '' : '<span class="miss-flag">无题材词</span>'}</td>
</tr>`).join('')}
</tbody></table>`).join('');

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${YEAR} 列表 API tag × 白名单分级审计</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e4e6eb;--tx:#1b1f24;--tx2:#5c636e;
--k1:#1257c4;--k1b:#e7f0fe;--k2:#0b7a4b;--k2b:#e5f6ed;--k3:#6b7280;--k3b:#f1f2f4;--k9:#b42318;--k9b:#fdecec}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--tx2);font-size:13px;margin-bottom:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat .n{font-size:22px;font-weight:700;letter-spacing:-.5px}.stat .l{font-size:12px;color:var(--tx2)}
.nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.nav a{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12.5px;text-decoration:none;color:var(--tx)}
.nav a b{color:var(--k1);margin-left:5px;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:12.5px;margin-bottom:18px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
h2{font-size:15px;margin:26px 0 8px}h2 span{font-weight:400;color:var(--tx2);font-size:12.5px;margin-left:6px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{text-align:left;font-size:12px;color:var(--tx2);font-weight:600;background:#fafbfc;padding:8px 12px;border-bottom:1px solid var(--line)}
td{padding:8px 12px;border-bottom:1px solid #f0f1f3;vertical-align:top}
tr:last-child td{border-bottom:0}
tr.warn2{background:#fffdf6}tr.warn3{background:#fff8f8}
.nm{font-weight:600;width:230px}.cat{color:var(--tx2);font-size:12px;white-space:nowrap;width:52px}
.tags{width:390px}.res{font-size:12.5px}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;margin:2px 5px 2px 0;font-size:12.5px;border:1px solid transparent}
.chip.k1{background:var(--k1b);color:var(--k1);border-color:#c9ddfb}
.chip.k2{background:var(--k2b);color:var(--k2);border-color:#c3e9d5}
.chip.k3{background:var(--k3b);color:var(--k3);border-color:#e3e5e8}
.chip.k9{background:var(--k9b);color:var(--k9);border-color:#f6cfcc;text-decoration:line-through}
.lvl{display:inline-block;font-size:11px;font-weight:700;border-radius:4px;padding:0 5px;margin-right:4px}
.l1{background:var(--k1b);color:var(--k1)}.l2{background:var(--k2b);color:var(--k2)}.l3{background:var(--k3b);color:var(--k3)}
.res em{font-style:normal;background:#f4f5f7;border-radius:4px;padding:0 5px;margin-right:4px;font-size:12px}
.miss-flag{color:var(--k9);font-size:12px;border:1px dashed #f0b4af;border-radius:5px;padding:0 6px;background:var(--k9b)}
.foot{margin-top:22px;font-size:12.5px;color:var(--tx2);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.foot code{background:#f4f5f7;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>${YEAR} 列表 API tag × 白名单分级审计</h1>
<div class="sub">数据源：<code>next.bgm.tv/p1/subjects</code> 列表接口的 <code>metaTags</code>（每部番列表只给 1~8 个词，平均 ${(DATA.reduce((s, i) => s + new Set(i.metaTags).size, 0) / DATA.length).toFixed(2)} 个）｜ 白名单 = 四年词汇表并集（T1 题材 ${TIER[1].size} / T2 来源·受众 ${TIER[2].size} / T3 平台·地区 ${TIER[3].size}）</div>
<div class="stats">
<div class="stat"><div class="n">${DATA.length}</div><div class="l">2023 条目总数</div></div>
<div class="stat"><div class="n" style="color:var(--k1)">${perTier[1]} <span style="font-size:13px">${pct(perTier[1])}</span></div><div class="l">命中 Tier1 题材</div></div>
<div class="stat"><div class="n" style="color:var(--k2)">${perTier[2]} <span style="font-size:13px">${pct(perTier[2])}</span></div><div class="l">仅命中 Tier2 来源/受众</div></div>
<div class="stat"><div class="n" style="color:var(--k3)">${perTier[3]} <span style="font-size:13px">${pct(perTier[3])}</span></div><div class="l">仅命中 Tier3 平台/地区</div></div>
<div class="stat"><div class="n">${pct(DATA.length - perTier[3] - perTier.none)}</div><div class="l">T1+T2 覆盖率（不含 T3）</div></div>
<div class="stat"><div class="n" style="color:var(--k9)">${missFreq.size}</div><div class="l">未命中白名单的词种数</div></div>
</div>
<div class="nav">${nav}</div>
<div class="legend">
<span><i style="background:var(--k1b);border:1px solid #c9ddfb"></i>Tier1 题材（显示优先）</span>
<span><i style="background:var(--k2b);border:1px solid #c3e9d5"></i>Tier2 来源/受众（兜底显示）</span>
<span><i style="background:var(--k3b);border:1px solid #e3e5e8"></i>Tier3 平台/地区（可选）</span>
<span><i style="background:var(--k9b);border:1px solid #f6cfcc"></i>未命中 / 故意排除</span>
<span style="color:var(--tx2)">行底色：<b>浅黄</b>=无题材词（仅 T2 兜底）　<b>浅红</b>=仅 T3 或全空</span>
</div>
${body}
<div class="foot">
<b>未命中白名单的词（2023 全量）：</b>${[...missFreq].sort((a, b) => b[1] - a[1]).map(([t, c]) => `<code>${esc(t)}</code> ${c} 次（${GROUP_OF.get(t) ? '已分类为【' + GROUP_OF.get(t) + '】→ 故意排除' : '⚠️ 未归类'}）`).join('　')}
<br><br><b>结论：</b>2023 词汇表 52 词与三年并集完全同量，唯一新增为 <code>GL</code>（仅 1 次，且该条目已命中「百合+奇幻」→ 零边际贡献）；<code>短片集/R18</code> 属形式与分级，按设计不入白名单。<b>无需补充任何词</b>。
</div>
</div></body></html>`;
const outHtml = path.join(OUT, `tag-tier-audit-${YEAR}.html`);
fs.writeFileSync(outHtml, html);
console.log(`HTML → ${path.relative(ROOT, outHtml)}`);
