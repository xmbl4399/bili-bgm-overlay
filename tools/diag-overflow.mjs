/**
 * 归因实验：窄视口下的横向溢出，是本脚本造成的，还是 B站 页面本来就有的？
 *
 * 做法：同一视口宽度跑两次 ——
 *   ① 加载扩展（脚本接管）
 *   ② 不加载扩展（B站 原页面）
 * 若两次都有溢出，且来源是 B站 自己的元素 ⇒ 与本脚本无关。
 *
 * 用法：node tools/diag-overflow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, '.e2e-anime-ext');
const OUT = path.join(__dirname, '.e2e-anime-out');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROBE = `JSON.stringify((() => {
  const vw = document.documentElement.clientWidth;
  const scrollW = document.documentElement.scrollWidth;
  const bodyW = document.body.scrollWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.right <= vw + 1) continue;
    const cs = getComputedStyle(el);
    const spanning = cs.position === 'fixed' && cs.left !== 'auto' && cs.right !== 'auto';
    if (out.length >= 8) break;
    out.push({ sel: (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
      right: Math.round(r.right), pos: cs.position, spanning });
  }
  return { vw, scrollW, bodyW, overflow: scrollW > vw + 1, ours: out.filter(o => /bgm/i.test(o.sel)),
    bili: out.filter(o => !/bgm/i.test(o.sel)).slice(0, 5) };
})())`;

async function run(label, withExt, width) {
  const port = 9300 + Math.floor(Math.random() * 100);
  const profile = path.join(OUT, 'profile-of-' + (withExt ? 'on' : 'off'));
  fs.rmSync(profile, { recursive: true, force: true });
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--window-size=${width},800`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, 'about:blank'];
  if (withExt) args.splice(args.length - 1, 0, `--load-extension=${EXT}`);
  const child = spawn(EDGE, args, { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
      await sleep(500);
    }
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async e => { const r = await send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result && r.result.value; };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'https://www.bilibili.com/anime/' });
    await sleep(withExt ? 15000 : 10000);
    console.log(`\n[${label} @ ${width}px] ` + await evalJs(PROBE));
  } finally { try { child.kill('SIGKILL'); } catch {} }
}

const W = Number(process.argv[2]) || 1024;
await run('脚本开启', true, W);
await sleep(800);
await run('脚本关闭（B站 原页面）', false, W);
