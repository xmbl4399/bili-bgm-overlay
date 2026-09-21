/**
 * 把「传输成本」拆开：
 *   ① v0 的极限序列（limit=1/10/50/100）⇒ 分离「延迟(RTT+服务端)」与「带宽」
 *   ② v0 单条 payload 的字段体积分解 ⇒ 592 KB 到底谁占的
 *
 * 用法：node tools/probe-transfer-cost.mjs [year] [month] [cat]
 */
const UA = 'bili-bgm-overlay/1.6.2 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const YEAR = Number(process.argv[2]) || 2026;
const MONTH = Number(process.argv[3]) || 7;
const CAT = process.argv[4] || '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = n => (n / 1024).toFixed(1) + ' KB';
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function timed(url) {
  const t0 = performance.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { ms: performance.now() - t0, bytes: buf.length, text: buf.toString('utf8') };
}

const base = `https://api.bgm.tv/v0/subjects?type=2&cat=${CAT}&year=${YEAR}&month=${MONTH}`;

/* 预热：把 DNS/TLS 握手成本排除掉 */
await timed(`${base}&limit=1`); await sleep(400);

console.log('\n' + '█'.repeat(72));
console.log('① v0 传输极限：延迟 vs 带宽');
console.log('█'.repeat(72));

const rows = [];
for (const lim of [1, 10, 50, 100]) {
  const ms = [], by = [];
  for (let i = 0; i < 2; i++) {
    const r = await timed(`${base}&limit=${lim}`);
    ms.push(r.ms); by.push(r.bytes);
    await sleep(350);
  }
  const row = { lim, ms: med(ms), bytes: med(by) };
  rows.push(row);
  console.log(`  limit=${String(lim).padStart(3)}   ${kb(row.bytes).padStart(10)}   ${String(Math.round(row.ms)).padStart(6)}ms`);
}

// 线性拟合 t = a + b*bytes ⇒ a 为固定延迟，1/b 为带宽
const n = rows.length;
const sx = rows.reduce((s, r) => s + r.bytes, 0);
const sy = rows.reduce((s, r) => s + r.ms, 0);
const sxy = rows.reduce((s, r) => s + r.bytes * r.ms, 0);
const sxx = rows.reduce((s, r) => s + r.bytes * r.bytes, 0);
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const a = (sy - b * sx) / n;
const bwKBs = 1 / b / 1024 * 1000;

console.log(`\n  线性拟合 t = ${Math.round(a)}ms + ${(b * 1000).toFixed(4)} ms/KB`);
console.log(`  ⇒ ★ 固定延迟（DNS+TLS+RTT+服务端处理）约 ${Math.round(a)} ms`);
console.log(`  ⇒ ★ 传输速率 约 ${bwKBs.toFixed(0)} KB/s`);

const v0Batch = rows.find(r => r.lim === 100);
console.log(`\n  用该模型解释 7 月 v0 单请求（${kb(v0Batch.bytes)}）：`);
console.log(`     延迟 ${Math.round(a)}ms + 传输 ${kb(v0Batch.bytes)} ÷ ${bwKBs.toFixed(0)}KB/s = ${Math.round(v0Batch.bytes / 1024 / bwKBs * 1000)}ms`);
console.log(`     合计约 ${Math.round(a + v0Batch.bytes / 1024 / bwKBs * 1000)}ms（与实测 ${Math.round(v0Batch.ms)}ms 对照）`);

/* ② 字段体积分解 */
console.log('\n' + '█'.repeat(72));
console.log('② v0 单条 payload 字段体积分解（592 KB 的大头在哪）');
console.log('█'.repeat(72));

const one = await timed(`${base}&limit=100`);
const j = JSON.parse(one.text);
const items = j.data || [];
console.log(`  ${items.length} 条 / 共 ${kb(one.bytes)} ⇒ 平均 ${(one.bytes / items.length / 1024).toFixed(2)} KB/条`);

// 累计各字段在所有条目里的总字节
const totals = new Map();
for (const it of items) {
  for (const k of Object.keys(it)) {
    const v = Buffer.byteLength(JSON.stringify(it[k] ?? null), 'utf8');
    totals.set(k, (totals.get(k) || 0) + v);
  }
}
const sum = [...totals.values()].reduce((a, b2) => a + b2, 0);
const sorted = [...totals.entries()].sort((x, y) => y[1] - x[1]);

console.log(`\n  ${'字段'.padEnd(18)}${'总字节'.padStart(12)}${'占比'.padStart(9)}   用得上？`);
const useful = new Set(['id', 'name', 'name_cn', 'images', 'eps', 'total_episodes', 'date', 'platform', 'tags', 'meta_tags', 'rating']);
for (const [k, v] of sorted) {
  const pct = v / sum * 100;
  const mark = k === 'tags' || k === 'meta_tags' ? '★ 仅 tag 需要'
    : useful.has(k) ? '是（卡片要用）' : '✗ 用不上';
  console.log(`  ${k.padEnd(18)}${kb(v).padStart(12)}${pct.toFixed(1).padStart(8)}%   ${mark}`);
}
console.log(`  ${'—'.repeat(18)}${kb(sum).padStart(12)}`);
console.log(`  JSON 结构开销（括号/引号/逗号等）约 ${kb(one.bytes - sum)}`);

const unused = sorted.filter(([k]) => !useful.has(k)).reduce((s, [, v]) => s + v, 0);
const tagBytes = (totals.get('tags') || 0) + (totals.get('meta_tags') || 0);
console.log(`\n  ★ 用不上的字段合计      ${kb(unused)}  (${(unused / one.bytes * 100).toFixed(1)}%)`);
console.log(`  ★ tags + meta_tags 合计 ${kb(tagBytes)}  (${(tagBytes / one.bytes * 100).toFixed(1)}%)`);
console.log(`  ⇒ 即便完全不要 tag，v0 也只能省下 ${(tagBytes / one.bytes * 100).toFixed(1)}%`);
console.log(`  ⇒ 真正的大头是：${sorted.filter(([k]) => !['tags', 'meta_tags'].includes(k)).slice(0, 3).map(([k]) => k).join(' / ')}`);

console.log('\n完成。\n');
