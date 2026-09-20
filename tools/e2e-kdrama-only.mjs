/**
 * 单点验：只切到「韩剧」tab，给足时间，看它到底能不能出卡片。
 * 排除"点在别的 tab 上、年份没同步、时间不够"这类时序噪声。
 *
 * 用法：CDP_PORT=9250 node tools/e2e-kdrama-only.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(__dirname, '.e2e-anime-ext');
const OUT = path.join(__dirname, '.e2e-anime-out');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9250);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const boot = async () => {
  const profile = path.join(OUT, 'profile-kd');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,1300', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return child; } catch {}
    await sleep(500);
  }
  throw new Error('CDP 未就绪');
};

const main = async () => {
  fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
  fs.mkdirSync(OUT, { recursive: true });
  const child = await boot();
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result && r.result.value;
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'https://www.bilibili.com/anime/' });
    await sleep(15000);

    const click = async sel => {
      const pt = JSON.parse(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(!e) return 'null'; const r=e.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
      if (!pt) return false;
      for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      return true;
    };

    console.log('点「韩剧」tab：' + await click('.bgm-mode[data-mode="kdrama"]'));
    // 给足 40s：12 个月 × 逐月懒加载
    for (const t of [15000, 15000, 10000]) {
      await sleep(t);
      console.log(await evalJs(`JSON.stringify({
        activeMode: (document.querySelector('.bgm-mode.on')||{}).textContent,
        activeYear: (document.querySelector('.bgm-year.on')||{}).dataset?.year,
        cards: document.querySelectorAll('.bgm-card').length,
        heads: [...document.querySelectorAll('.bgm-month-h')].map(h=>h.textContent.replace(/\\s+/g,' ').trim()).slice(0,6),
        errs: document.querySelectorAll('#bgm-anime-root .bgm-err').length,
      })`));
    }

    // 累计平台纯度
    const ctxs = [];
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.executionContextCreated') ctxs.push(m.params.context); });
    await sleep(500);
    console.log('累计条目平台分布：' + await (async () => {
      for (const c of ctxs.filter(x => x.auxData && x.auxData.isDefault === false)) {
        try {
          const r = await send('Runtime.evaluate', {
            expression: `(() => { const v = window.__BGM_ANIME__; if (!v || !v.view) return null;
              const acc = v.view.allItems || []; const ps = {};
              for (const x of acc) ps[x.platform||'(空)'] = (ps[x.platform||'(空)']||0)+1;
              return JSON.stringify(ps) + ' 共' + acc.length + '条'; })()`,
            contextId: c.id, returnByValue: true });
          if (r.result && r.result.value) return r.result.value;
        } catch {}
      }
      return '取不到';
    })());

    const shot = path.join(OUT, 'kdrama-only.png');
    const png = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    console.log('截图：' + shot);
  } finally { try { child.kill('SIGKILL'); } catch {} }
};
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
