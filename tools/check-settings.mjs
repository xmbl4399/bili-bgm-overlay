/**
 * 小检查：设置面板新增项（Tier3 开关 / 主题选择）与统计块是否渲染正确。
 * 用法：node tools/check-settings.mjs
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
const PORT = 9233;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = path.join(OUT, 'profile-settings');
fs.rmSync(profile, { recursive: true, force: true });
fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank'], { stdio: 'ignore' });
try {
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch {} if (!ready) await sleep(500); }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const P = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { P.get(m.id)(m.result); P.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; P.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.value;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'https://www.bilibili.com/anime/' });
  await sleep(9000);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 0, y: 0, button: 'left', clickCount: 1 });   // 唤醒
  const pt = JSON.parse(await ev(`(()=>{const e=document.querySelector('.bgm-tools .bgm-ibtn:last-child');
    const r=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(900);
  const info = JSON.parse(await ev(`JSON.stringify({
    rows: [...document.querySelectorAll('.bgm-panel .bgm-row')].map(r => r.querySelector('span').textContent
      + ' = ' + (r.querySelector('input') ? (r.querySelector('input').checked ? '☑' : '☐') : r.querySelector('select').value)),
    stat: (document.querySelector('.bgm-stat')||{}).innerText || '(无)',
    panelBg: getComputedStyle(document.querySelector('.bgm-panel')).backgroundColor,
  })`));
  console.log('设置面板行：');
  info.rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r}`));
  console.log('\n统计块：\n  ' + info.stat.split('\n').join('\n  '));
  console.log('\n面板底色：' + info.panelBg);
  const has = s => info.rows.some(r => r.includes(s));
  const statHas = s => info.stat.includes(s);
  const ok = [
    [has('Tier3'), '有 Tier3 兜底开关'],
    [has('主题'), '有主题选择行'],
    [info.rows.some(r => r.startsWith('主题') && r.endsWith('auto')), '主题默认 auto（跟随 B站）'],
    // 缓存时效两项：v1.6.1 前只存在于 cfg、无 UI ⇒ 名义可配实际改不了
    [info.rows.some(r => r.startsWith('缓存时效 · 当年') && r.endsWith('12')), '缓存时效·当年 已暴露且默认 12'],
    [info.rows.some(r => r.startsWith('缓存时效 · 历史年') && r.endsWith('30')), '缓存时效·历史年 已暴露且默认 30'],
    [statHas('Tag 白名单'), '统计块显示白名单词数'],
    [statHas('主题：'), '统计块显示主题判定'],
    [info.panelBg !== 'rgba(0, 0, 0, 0)', '面板底色不透明'],
  ];
  let bad = 0;
  for (const [c, l] of ok) { console.log(`  ${c ? '✅' : '❌'} ${l}`); if (!c) bad++; }
  process.exit(bad ? 1 : 0);
} finally { child.kill(); }
