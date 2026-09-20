#!/usr/bin/env node
/**
 * diag-attribution.mjs — 单点验证「横向溢出归因」判据是否修对了。
 *
 * 背景：完整 E2E 的 4.7 段曾在 1024/800 视口报「横向溢出 ❌来自本脚本」，
 * 但 diag-overflow.mjs 的开/关对照实验证明真正来源是 B站 自己的
 * `.bili-header.fixed-header`（硬 min-width，right:1100）。
 * 误报根因：旧判据只看「元素 right > vw」，于是把**跟着**被排到框外的
 * `.bgm-year`（有 .bgm-years-in 这个 overflow-x:auto 祖先兜着）也算成致因。
 *
 * 本脚本在**真实注入脚本**的页面上，把「新判据 vs 旧判据」并排打印，
 * 一屏即可确认修复生效、且不会把真问题漏判。
 * 用法：CDP_PORT=9254 node tools/diag-attribution.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', '.e2e-anime-out');
const EXT = path.join(ROOT, 'tools', '.e2e-anime-ext');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9254);
const PAGE = 'https://www.bilibili.com/anime/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('缺少临时扩展，请先跑一次 tools/e2e-anime.mjs');
  process.exit(1);
}
fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(OUT, 'profile-attrib');
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1300', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, PAGE,
], { stdio: 'ignore' });

let ok = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ok = true; break; } } catch {}
  await sleep(500);
}
if (!ok) { console.error('CDP 未就绪'); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

await send('Runtime.enable');
await sleep(10000);   // 等脚本接管 + 首批卡片

const probe = (w) => `JSON.stringify((() => {
  const vw = document.documentElement.clientWidth;
  const scrollableAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return p;
    }
    return null;
  };
  const scan = (useNewRule) => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.right <= vw + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && cs.left !== 'auto' && cs.right !== 'auto') continue;
      if (useNewRule && scrollableAncestor(el)) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      out.push((el.id ? '#' + el.id : '')
        + (cls ? '.' + cls.trim().split(/\\s+/).slice(0, 2).join('.') : '')
        + '@' + Math.round(r.right)
        + (el.id.startsWith('bgm') || /(^|\\s)bgm-/.test(cls) ? ' 【bgm】' : ''));
    }
    return out;
  };
  const ours = (arr) => arr.some(s => s.indexOf('【bgm】') >= 0);
  const oldList = scan(false), newList = scan(true);
  return {
    vw, scrollW: document.documentElement.scrollWidth,
    docOverflowX: document.documentElement.scrollWidth > vw + 1,
    bgmCount: document.querySelectorAll('.bgm-mode').length,
    oldRule: { isOurs: ours(oldList), sources: oldList.slice(0, 6) },
    newRule: { isOurs: ours(newList), sources: newList.slice(0, 6) },
  };
})())`;

for (const [w, h] of [[1280, 720], [1024, 768], [800, 600]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);
  const r = JSON.parse(await evalJs(probe(w)));
  console.log(`\n=== ${w}×${h} ===  tab=${r.bgmCount} 个  scrollWidth=${r.scrollW} 视口=${r.vw} 溢出=${r.docOverflowX}`);
  console.log(`  旧判据（只看 right>vw）      ：isOurs=${r.oldRule.isOurs ? '❌是' : '否'}  ${JSON.stringify(r.oldRule.sources)}`);
  console.log(`  新判据（排除可滚动祖先兜底） ：isOurs=${r.newRule.isOurs ? '❌是' : '✅否'}  ${JSON.stringify(r.newRule.sources)}`);
}

await send('Emulation.clearDeviceMetricsOverride');
ws.close();
try { child.kill(); } catch { /* 已退出 */ }
process.exit(0);
