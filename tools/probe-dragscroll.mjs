#!/usr/bin/env node
/**
 * probe-dragscroll.mjs — 专测 enableDragScroll() 是否真的生效。
 *
 * ⚠️ probe-hscroll.mjs 里用 Input.dispatchMouseEvent 造的合成鼠标事件
 *    在 headless 下**不一定派发 Pointer Events**（取决于内核版本），
 *    所以那里报 "拖不动" 可能是**测试手段的问题**而非功能没做。
 * 本脚本改用三条独立证据交叉验证：
 *   ① 直接派发 PointerEvent（在页面内 new PointerEvent，最贴近真实）
 *   ② 走 mouse 事件路径（兼容性）
 *   ③ 滚轮路径（wheel → 横向滚动）
 * 用法：CDP_PORT=9258 node tools/probe-dragscroll.mjs
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
const PORT = Number(process.env.CDP_PORT || 9258);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
fs.mkdirSync(OUT, { recursive: true });
const profile = path.join(OUT, 'profile-drag');
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1300', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank',
], { stdio: 'ignore' });

for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
  await sleep(500);
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
// 关键：先从 about:blank 启动（保证扩展已加载），再导航过去 —— 否则内容脚本可能没注入
await send('Page.navigate', { url: 'https://www.bilibili.com/anime/' });
await sleep(12000);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(1500);

// 先确认 handlers 挂上了（enableDragScroll 是否被调用）
console.log('== 前置检查 ==');
console.log('  .bgm-modes 存在        :', await evalJs(`!!document.querySelector('.bgm-modes')`));
console.log('  溢出（可拖前提）        :', await evalJs(
  `(() => { const b = document.querySelector('.bgm-modes');
     return b ? (b.scrollWidth + ' > ' + b.clientWidth + ' ⇒ ' + (b.scrollWidth > b.clientWidth + 1)) : '无'; })()`));

// ① 页面内 new PointerEvent 派发（最贴近真实指针）
const viaPointer = await evalJs(`(() => {
  const b = document.querySelector('.bgm-modes');
  if (!b) return '无元素';
  const r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const mk = (type, x) => new PointerEvent(type, {
    pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: cy, bubbles: true, cancelable: true, isPrimary: true,
  });
  const before = b.scrollLeft;
  b.dispatchEvent(mk('pointerdown', cx));
  b.dispatchEvent(mk('pointermove', cx - 60));
  b.dispatchEvent(mk('pointermove', cx - 120));
  b.dispatchEvent(mk('pointerup', cx - 120));
  return JSON.stringify({ before, after: b.scrollLeft, moved: b.scrollLeft !== before });
})()`);
console.log('\n== ① PointerEvent 路径 ==');
console.log('  ', viaPointer);

// ② 滚轮路径
await evalJs(`document.querySelector('.bgm-modes').scrollLeft = 0`);
const viaWheel = await evalJs(`(() => {
  const b = document.querySelector('.bgm-modes');
  if (!b) return '无元素';
  const r = b.getBoundingClientRect();
  const before = b.scrollLeft;
  b.dispatchEvent(new WheelEvent('wheel', {
    deltaY: 150, deltaMode: 0, bubbles: true, cancelable: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
  return JSON.stringify({ before, after: b.scrollLeft, moved: b.scrollLeft !== before });
})()`);
console.log('\n== ② 滚轮（deltaY→横向）路径 ==');
console.log('  ', viaWheel);

// ③ 拖拽后是否误触发 tab 切换（moved 时 click 应被吃掉）
const clickGuard = await evalJs(`(() => {
  const b = document.querySelector('.bgm-modes');
  const before = document.querySelector('.bgm-mode.on').dataset.mode;
  const r = b.getBoundingClientRect(); const cy = r.top + r.height / 2;
  const cx = r.left + 20;
  const mk = (type, x) => new PointerEvent(type, {
    pointerId: 9, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: cy, bubbles: true, cancelable: true, isPrimary: true,
  });
  b.dispatchEvent(mk('pointerdown', cx));
  b.dispatchEvent(mk('pointermove', cx - 100));   // 明确拖出阈值
  b.dispatchEvent(mk('pointerup', cx - 100));
  // 模拟浏览器补发的 click（落在被拖过的位置上）
  const target = document.elementFromPoint(cx - 100, cy) || b;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx - 100, clientY: cy }));
  return JSON.stringify({ before, after: document.querySelector('.bgm-mode.on').dataset.mode,
    unchanged: before === document.querySelector('.bgm-mode.on').dataset.mode });
})()`);
console.log('\n== ③ 拖拽后不误触发 tab 切换 ==');
console.log('  ', clickGuard);

// ④ 年份栏同样测
const yearsDrag = await evalJs(`(() => {
  const b = document.querySelector('.bgm-years-in');
  if (!b) return '无元素';
  const r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const mk = (type, x) => new PointerEvent(type, {
    pointerId: 11, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: cy, bubbles: true, cancelable: true, isPrimary: true,
  });
  const before = b.scrollLeft;
  b.dispatchEvent(mk('pointerdown', cx));
  b.dispatchEvent(mk('pointermove', cx - 80));
  b.dispatchEvent(mk('pointermove', cx - 160));
  b.dispatchEvent(mk('pointerup', cx - 160));
  return JSON.stringify({ before, after: b.scrollLeft, moved: b.scrollLeft !== before });
})()`);
console.log('\n== ④ 年份栏拖拽 ==');
console.log('  ', yearsDrag);

await send('Emulation.clearDeviceMetricsOverride');
ws.close();
try { child.kill(); } catch {}
process.exit(0);
