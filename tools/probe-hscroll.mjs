#!/usr/bin/env node
/**
 * probe-hscroll.mjs — 量两栏（.bgm-modes / .bgm-years-in）在窄屏下的**可滑动性**。
 *
 * 要回答的不是"有没有 overflow-x:auto"（那是源码可读的），而是：
 *   ① 真的溢出吗（scrollWidth > clientWidth）
 *   ② 能不能被**拖动**平移？（现在的短板：没有指针拖拽 JS）
 *   ③ 有没有 touch 惯性 / overscroll 设置
 *   ④ 滚轮（含 shift）能不能横向滚
 *
 * 用法：CDP_PORT=9256 node tools/probe-hscroll.mjs
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
const PORT = Number(process.env.CDP_PORT || 9256);
const PAGE = 'https://www.bilibili.com/anime/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('缺少临时扩展，请先跑一次 tools/e2e-anime.mjs');
  process.exit(1);
}
fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(OUT, 'profile-hscroll');
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1300', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, PAGE,
], { stdio: 'ignore' });

let up = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch {}
  await sleep(500);
}
if (!up) { console.error('CDP 未就绪'); process.exit(1); }

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
await sleep(10000);

const CSS_PROBE = `JSON.stringify((() => {
  const pick = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const cs = getComputedStyle(e);
    return {
      sel,
      scrollW: Math.round(e.scrollWidth),
      clientW: Math.round(e.clientWidth),
      needScroll: e.scrollWidth > e.clientWidth + 1,
      overflowX: cs.overflowX,
      overscrollX: cs.overscrollBehaviorX,
      touchAction: cs.touchAction,
      webkitScrollTouch: cs.webkitOverflowScrolling || '(none)',
      scrollBehavior: cs.scrollBehavior,
      // 用户能否用手指/指针把它拖走：overflow-x 允许 + 内容真的更宽
      draggable: (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1,
    };
  };
  return { modes: pick('.bgm-modes'), yearsIn: pick('.bgm-years-in'), years: pick('.bgm-years') };
})())`;

for (const [w, h] of [[1280, 720], [1024, 768], [800, 600], [420, 800]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(1400);
  const r = JSON.parse(await evalJs(CSS_PROBE));
  console.log(`\n=== ${w}×${h} ===`);
  for (const [k, v] of Object.entries(r)) {
    if (!v) { console.log(`  ${k}: (不存在)`); continue; }
    const tag = v.needScroll ? '需滚动' : '放得下';
    console.log(`  ${k.padEnd(8)} ${tag}  scrollW=${v.scrollW} clientW=${v.clientW}`
      + `  overflow-x=${v.overflowX}  touch=${v.touchAction}  webkitInertia=${v.webkitScrollTouch}`
      + `  smooth=${v.scrollBehavior}  → 可拖=${v.draggable ? '是' : '否'}`);
  }
}

// 拖拽平移实测：在 .bgm-modes 上按住往左拖 200px，看 scrollLeft 有没有变
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
const before = await evalJs(`document.querySelector('.bgm-modes').scrollLeft`);
const box = JSON.parse(await evalJs(`JSON.stringify(document.querySelector('.bgm-modes').getBoundingClientRect())`));
const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
for (const type of ['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', {
    type, x: type === 'mouseMoved' ? cx - 120 : cx, y: cy, button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await sleep(80);
}
await sleep(400);
const after = await evalJs(`document.querySelector('.bgm-modes').scrollLeft`);
console.log(`\n=== 指针拖拽实测（800×600，向左拖 120px）===`);
console.log(`  scrollLeft: ${before} → ${after}  ${after > before ? '✅ 拖得动' : '❌ 拖不动（缺拖拽 JS）'}`);

await send('Emulation.clearDeviceMetricsOverride');
ws.close();
try { child.kill(); } catch {}
process.exit(0);
