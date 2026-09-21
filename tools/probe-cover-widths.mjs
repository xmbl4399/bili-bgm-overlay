#!/usr/bin/env node
/**
 * probe-cover-widths.mjs —— 封面「宽度档位」实测
 *
 * 目的：给「封面质量」设置项定方案。要回答三件事：
 *   ① 两通路（v0/p1）的 images 各字段指向哪个宽度？（复核，防漂移）
 *   ② lain.bgm.tv 的 /r/<N>/ 是不是「任意宽度都能用」的缩放服务？
 *   ③ 各宽度真实下载字节 / 耗时是多少 ⇒ 质量选项该分几档、标注什么数字。
 *
 * 用法：node tools/probe-cover-widths.mjs [year] [month]
 * 零 JSON 输出依赖：只用 fetch，便于给主人看数字。
 */

const YEAR = Number(process.argv[2] || 2026);
const MONTH = Number(process.argv[3] || 7);
const SAMPLE = 5;          // 抽几条算人均/总体积
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) bili-bgm-overlay-diagnostic';

const get = async (url, json, tries = 3) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const t0 = Date.now();
      const r = await fetch(url, {
        headers: Object.assign({ 'User-Agent': UA }, json ? { Accept: 'application/json' } : {}),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, bytes: buf.length, ms: Date.now() - t0, status: r.status, buf };
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 600)); }
  }
  return { ok: false, err: String(last && last.message || last) };
};

const pad = (s, n) => String(s).padEnd(n);
const kb = b => (b / 1024).toFixed(1) + ' KB';

/* ── ① 取样本 ── */
const base = 'https://api.bgm.tv';
// 用 v0 拿一批 id（v0 条目最全，含当月新番）
const list = await get(`${base}/v0/subjects?type=2&cat=1&year=${YEAR}&month=${MONTH}&limit=100`, true);
if (!list.ok) { console.error('取列表失败：', list.err); process.exit(1); }
const lj = JSON.parse(list.buf.toString('utf8'));
// ⚠️ v0 列表返回的是 **{data:[...], total:n}**，不是裸数组（实测复核）
const all = Array.isArray(lj) ? lj : (lj.data || []);
console.log(`\n样本：${YEAR} 年 ${MONTH} 月 TV 番剧，v0 返回 ${all.length} 条（total=${lj.total}）`);
console.log(`响应解包：${Array.isArray(lj) ? '裸数组' : '对象 {data,total}'} ⇒ 该次响应 ${kb(list.bytes)}\n`);

/* ── ② 各字段指向哪个宽度（复核档位映射） ── */
console.log('='.repeat(78));
console.log('① 字段 → 实际宽度（复核：两条通路的 medium 确实差一档吗）');
console.log('='.repeat(78));
const tierOf = u => { const m = String(u || '').match(/\/r\/(\d+)\//); return m ? 'r' + m[1] : (/\/pic\/cover\//.test(u) ? '原图' : '(无)'); };

const one = all[0];
console.log('  v0 条目 #' + one.id);
for (const k of ['large', 'common', 'medium', 'small', 'grid']) {
  console.log(`    images.${pad(k, 7)} → ${pad(tierOf(one.images[k]), 6)}  ${one.images[k] || ''}`);
}
// p1 侧
const p1 = await get(`https://next.bgm.tv/p1/subjects?type=2&cat=1&year=${YEAR}&month=${MONTH}&limit=24&offset=0`, true);
if (p1.ok) {
  const pj = JSON.parse(p1.buf.toString('utf8'));
  const pit = (Array.isArray(pj) ? pj : (pj.data || []))[0];
  if (pit) {
    console.log(`  p1 条目 #${pit.id}`);
    for (const k of ['large', 'common', 'medium', 'small', 'grid']) {
      const u = (pit.images || {})[k];
      console.log(`    images.${pad(k, 7)} → ${pad(tierOf(u), 6)}  ${u || ''}`);
    }
  }
} else console.log('  （p1 取样失败：' + p1.err + '）');

/* ── ③ 任意宽度是否可用 ── */
console.log('\n' + '='.repeat(78));
console.log('② lain.bgm.tv 的 /r/<N>/ 支持任意宽度吗（决定选项能否按数字分档）');
console.log('='.repeat(78));
const commonUrl = String(one.images.common || one.images.large || '');
if (!/\/r\/\d+\//.test(commonUrl)) {
  console.log('  ⚠️ common 里没有 /r/<N>/ 段，无法改写。URL =', commonUrl);
} else {
  const WIDTHS = [50, 100, 150, 200, 300, 400, 600, 800];
  console.log(`  基准 URL：${commonUrl}\n`);
  console.log('  ' + pad('宽度', 8) + pad('HTTP', 7) + pad('字节', 12) + pad('耗时', 9) + '说明');
  const rows = [];
  for (const w of WIDTHS) {
    const u = commonUrl.replace(/\/r\/\d+\//, `/r/${w}/`);
    const r = await get(u, false);
    if (!r.ok) { console.log('  ' + pad('r' + w, 8) + pad('失败', 7) + r.err); rows.push({ w, ok: false }); continue; }
    rows.push({ w, ok: true, bytes: r.bytes, ms: r.ms });
    console.log('  ' + pad('r' + w, 8) + pad(r.status, 7) + pad(kb(r.bytes), 12) + pad(r.ms + ' ms', 9)
      + (w === 400 ? '← 现方案(common)' : ''));
  }
  // 单调性检查：字节应随宽度递减
  const okRows = rows.filter(r => r.ok);
  const mono = okRows.every((r, i) => i === 0 || r.bytes <= okRows[i - 1].bytes);
  console.log(`\n  字节随宽度单调不增：${mono ? '✅ 是（说明是同一套缩放服务）' : '❌ 否（宽高比可能不一致，需留意）'}`);
  const distinct = new Set(okRows.map(r => r.bytes)).size;
  console.log(`  不同宽度给出不同字节数：${distinct}/${okRows.length} ⇒ ${distinct === okRows.length ? '✅ 每档都是真缩放' : '⚠️ 有重复，可能存在档位吸附'}`);
}

/* ── ④ 全样本：各档总体积估算 ── */
console.log('\n' + '='.repeat(78));
console.log('③ 若全量换档，79 部的封面总体积（抽样外推）');
console.log('='.repeat(78));
const urls = all.map(x => String((x.images || {}).common || '')).filter(u => /\/r\/\d+\//.test(u));
console.log(`  可改写 URL 的条目：${urls.length}/${all.length}`);
const pickW = [100, 200, 400, 800];
console.log('  ' + pad('档位', 8) + pad('抽样均张', 12) + '外推 ' + all.length + ' 部');
for (const w of pickW) {
  let sum = 0, n = 0;
  for (const u of urls.slice(0, SAMPLE)) {
    const r = await get(u.replace(/\/r\/\d+\//, `/r/${w}/`), false);
    if (r.ok) { sum += r.bytes; n++; }
  }
  if (!n) { console.log('  ' + pad('r' + w, 8) + '抽样失败'); continue; }
  const avg = sum / n;
  console.log('  ' + pad('r' + w, 8) + pad(kb(avg), 12) + kb(avg * urls.length));
}

/* ── ⑤ 卡片实际渲染尺寸（判断「够不够清晰」的基准） ── */
console.log('\n' + '='.repeat(78));
console.log('④ 卡片渲染尺寸（来自脚本 CSS，供判断清晰度）');
console.log('='.repeat(78));
console.log('  网格：grid-template-columns: repeat(auto-fill, minmax(132px, 1fr))  ← 桌面');
console.log('        窄屏断点 104px');
console.log('  ⇒ 1× DPR 需约 132px；2× DPR 需约 264px；3× DPR 需约 396px');
console.log('  ⇒ r400 覆盖 3× DPR；r200 覆盖 2× DPR（略紧）；r100 仅覆盖 1× DPR');
console.log('');
