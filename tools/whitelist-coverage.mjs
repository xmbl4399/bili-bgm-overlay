#!/usr/bin/env node
/**
 * 白名单覆盖率实测 —— 数据源只用「列表接口 metaTags」，不碰详情。
 *
 * 对比多个候选白名单方案在指定年份的覆盖率，并给出达成 99% / 100% 所需的最少补词。
 * 缓存：tools/.e2e-anime-out/tag-cache-{YEAR}.json（与 tag-freq.mjs 共用 ⇒ 已缓存的年份零请求）
 *
 * 用法：node tools/whitelist-coverage.mjs [years=2026,2025] [--refresh]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tools/.e2e-anime-out');
const CATS = { 1: 'TV', 5: 'WEB', 2: 'OVA', 3: '剧场版' };
const YEARS = (process.argv.find(a => /^[\d,]+$/.test(a)) || '2026,2025').split(',').map(Number);
const REFRESH = process.argv.includes('--refresh');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- 当前白名单：直接从脚本里读，保证两边一致 ---- */
const src = fs.readFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), 'utf8');
const CUR = src.match(/const TAG_WHITELIST = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g).map(s => s.slice(1, -1));

/* ---- 取数（带缓存） ---- */
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
            { headers: { 'User-Agent': 'bili-bgm-overlay/coverage' }, signal: AbortSignal.timeout(20000) });
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
  console.log(`[${year}] 已请求并缓存 → ${path.basename(cache)}：${items.length} 条${skipped.length ? `，跳过 ${skipped.length} 个月：${skipped.join(',')}` : ''}`);
  return items;
}

const DATA = {};
for (const y of YEARS) DATA[y] = await loadYear(y);

/* ---- 词频（按年） ---- */
const vocabOf = items => {
  const f = new Map();
  for (const it of items) for (const t of new Set(it.metaTags)) f.set(t, (f.get(t) || 0) + 1);
  return f;
};
const VOCAB = Object.fromEntries(YEARS.map(y => [y, vocabOf(DATA[y])]));

/* ---- 方案：全部基于「列表接口的词汇表」 ---- */
const ADD7 = ['漫画改', '原创', '子供向', '游戏改', '小说改', '少女向', '少年向'];
const PLATFORM = ['TV', 'WEB', 'OVA', '剧场版'];
const REGION = ['日本', '欧美', '中国', '美国', '韩国', '法国'];

/** 在 2026 列表里零命中的词（= 主人说的"从未命中"，以 2026 审计为准） */
const zero2026 = CUR.filter(w => !VOCAB[2026]?.has(w));
/** 在两年列表里都零命中的词（更保守的"从未命中"） */
const zeroAll = CUR.filter(w => YEARS.every(y => !VOCAB[y].has(w)));

const PLANS = {
  '① 当前白名单': CUR,
  '② 删2026零命中 + 加7词': [...CUR.filter(w => VOCAB[2026]?.has(w)), ...ADD7],
  '③ 删两年零命中 + 加7词': [...CUR.filter(w => YEARS.every(y => VOCAB[y].has(w))), ...ADD7],
  '④ 方案③ + 重置半段': null,   // 见下（2026 审计只认 2026，故用 ③ 口径）
};
PLANS['④ 方案② + 平台/地区词'] = [...PLANS['② 删2026零命中 + 加7词'], ...PLATFORM, ...REGION];
delete PLANS['④ 方案③ + 重置半段'];

/* ---- 覆盖率计算 ---- */
const hitTags = (it, set) => [...new Set(it.metaTags)].filter(t => set.has(t));
function coverage(items, words) {
  const set = new Set(words);
  const zero = items.filter(it => hitTags(it, set).length === 0);
  return { total: items.length, hit: items.length - zero.length, zero, set };
}

/* ---- 贪心：从列表词汇表里最少补几个词 → 零命中降到 N 以下 ---- */
function greedy(items, words, targetRate) {
  const set = new Set(words);
  let zero = items.filter(it => hitTags(it, set).length === 0);
  const allow = Math.floor(items.length * (1 - targetRate));
  const picked = [];
  while (zero.length > allow) {
    let best = null, bestN = 0;
    for (const [w, c] of VOCAB[YEARS[0]]) {
      if (set.has(w)) continue;
      const n = zero.filter(it => it.metaTags.includes(w)).length;
      if (n > bestN) { bestN = n; best = w; }
    }
    if (!best) break;
    picked.push([best, bestN]);
    set.add(best);
    zero = items.filter(it => hitTags(it, set).length === 0);
  }
  return { picked, zeroLeft: zero.length, allow };
}

/* ---- 输出 ---- */
console.log(`\n当前白名单 ${CUR.length} 词；2026 零命中 ${zero2026.length} 词；两年都零命中 ${zeroAll.length} 词`);
console.log(`新增 7 词：${ADD7.join(' ')}`);

for (const y of YEARS) {
  const items = DATA[y];
  console.log(`\n${'='.repeat(66)}\n${y} 年列表样本：${items.length} 条\n${'='.repeat(66)}`);
  for (const [name, words] of Object.entries(PLANS)) {
    if (!words) continue;
    const c = coverage(items, words);
    const rate = (c.hit / c.total * 100).toFixed(1);
    console.log(`  ${name.padEnd(24)} 白名单 ${String(new Set(words).size).padStart(2)} 词 → 有 tag ${String(c.hit).padStart(3)}/${c.total} = ${rate}%   空 ${c.zero.length}`);
  }
  /* 空条目明细（方案②口径） */
  const c2 = coverage(items, PLANS['② 删2026零命中 + 加7词']);
  if (c2.zero.length) {
    console.log(`\n  —— 方案② 仍为空的 ${c2.zero.length} 条 ——`);
    for (const it of c2.zero) console.log(`  [${it.cat} ${y}-${String(it.month).padStart(2, '0')}] ${String(it.name).slice(0, 30).padEnd(32)} ${it.metaTags.join(' / ')}`);
  }
  /* 补词建议 */
  const g1 = greedy(items, PLANS['② 删2026零命中 + 加7词'], 0.99);
  console.log(`\n  —— 方案② 想达 99%：再补 ${g1.picked.map(([w, n]) => `${w}(+${n})`).join(' ') || '—'} → 剩 ${g1.zeroLeft} 空`);
  const g2 = greedy(items, PLANS['② 删2026零命中 + 加7词'], 1.0);
  console.log(`  —— 方案② 想达 100%：再补 ${g2.picked.map(([w, n]) => `${w}(+${n})`).join(' ') || '—'} → 剩 ${g2.zeroLeft} 空`);
}

/* ---- 落盘：方案对比 + 2025 词频 ---- */
const tsv = [];
tsv.push(`# 白名单覆盖率实测（数据源：p1 列表 metaTags，不含详情）`);
tsv.push(`# 年份：${YEARS.join(', ')}`);
tsv.push(`# 新增7词：${ADD7.join(' / ')}`);
tsv.push('');
tsv.push('年份\t方案\t白名单词数\t有tag条目\t总条目\t覆盖率');
for (const y of YEARS) {
  for (const [name, words] of Object.entries(PLANS)) {
    if (!words) continue;
    const c = coverage(DATA[y], words);
    tsv.push(`${y}\t${name}\t${new Set(words).size}\t${c.hit}\t${c.total}\t${(c.hit / c.total * 100).toFixed(1)}%`);
  }
}
tsv.push('');
tsv.push('# 方案② 仍为空的条目（列表只给了平台/地区词，或什么都没给）');
tsv.push('年份\t分类\t放送月\t条目\t列表给的 metaTags');
for (const y of YEARS) {
  for (const it of coverage(DATA[y], PLANS['② 删2026零命中 + 加7词']).zero)
    tsv.push(`${y}\t${it.cat}\t${y}-${String(it.month).padStart(2, '0')}\t${it.name}\t${it.metaTags.join(' / ') || '（空数组）'}`);
}
tsv.push('');
for (const y of YEARS) {
  tsv.push(`# ${y} 列表词汇表（${VOCAB[y].size} 词）`);
  tsv.push('tag\t出现次数\t在【方案②】白名单');
  const s2 = new Set(PLANS['② 删2026零命中 + 加7词']);
  for (const [t, c] of [...VOCAB[y].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')))
    tsv.push(`${t}\t${c}\t${s2.has(t) ? '是' : '否'}`);
  tsv.push('');
}
const outTsv = path.join(OUT, `whitelist-coverage-${YEARS.join('-')}.tsv`);
fs.writeFileSync(outTsv, tsv.join('\n'));

/* 新白名单落盘，方便直接贴进脚本 */
const newWl = [...new Set(PLANS['② 删2026零命中 + 加7词'])];
const outTxt = path.join(OUT, `whitelist-proposed.txt`);
fs.writeFileSync(outTxt, newWl.map(w => `'${w}',`).join(' ') + `\n\n// 共 ${newWl.length} 词\n`);
console.log(`\n表 → ${path.relative(ROOT, outTsv)}\n新白名单 → ${path.relative(ROOT, outTxt)}（${newWl.length} 词）`);
