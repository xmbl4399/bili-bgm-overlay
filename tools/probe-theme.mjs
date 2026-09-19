/**
 * 实测 B站（www.bilibili.com）的「深色/浅色」主题机制 + 顶栏头像弹层结构。
 *
 * 方法：不是猜 CSS，而是**逐个施加候选标记，观察页面背景色是否真的变深**，
 *      找出 B站 真正认的那个开关；顺带 dump 头像弹层(.links-item)的实际结构与 CSS 变量。
 *
 * 用法：node tools/probe-theme.mjs [url]     默认 https://www.bilibili.com/anime/
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '.e2e-anime-out');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9231);
const TARGET = process.argv[2] || 'https://www.bilibili.com/anime/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot() {
  const profile = path.join(OUT, 'profile-theme');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return child; } catch {}
    await sleep(500);
  }
  throw new Error('CDP 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 45000);
    });
  }
}

const PROBE = `(() => {
  const rgb = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null;
    const [r,g,b] = m[1].split(',').map(Number); return { r, g, b, lum: +(0.2126*r + 0.7152*g + 0.0722*b).toFixed(1) }; };
  const cs = getComputedStyle(document.documentElement), cb = getComputedStyle(document.body);
  const attrOf = el => [...el.attributes].map(a => a.name + '=' + (a.value || '(empty)')).join(' ');
  return JSON.stringify({
    url: location.href,
    htmlAttrs: attrOf(document.documentElement),
    bodyAttrs: attrOf(document.body),
    htmlInlineStyle: document.documentElement.getAttribute('style') || '(none)',
    bodyBg: rgb(cb.backgroundColor), htmlBg: rgb(cs.backgroundColor),
    vars: Object.fromEntries(['--text1','--text2','--text3','--bg1','--bg2','--bg3','--graph_bg_thick','--brand_blue','--Ga0','--Ga1']
      .map(k => [k, cs.getPropertyValue(k).trim() || cb.getPropertyValue(k).trim() || '(未定义)'])),
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    lsKeys: Object.keys(localStorage).filter(k => /theme|dark|mode|color/i.test(k)).map(k => k + '=' + String(localStorage[k]).slice(0,60)),
    themeTextEls: [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && /主题/.test(e.textContent || ''))
      .slice(0,6).map(e => ({ tag: e.tagName, cls: e.className, txt: e.textContent.trim(),
        path: (() => { const p = []; let n = e; while (n && n.tagName && p.length < 6) { p.unshift(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ').slice(0,2).join('.') : '')); n = n.parentElement; } return p.join('>'); })() })),
    avatarPanel: (() => {
      const p = document.querySelector('.avatar-panel-popover');
      if (!p) return null;
      const li = p.querySelector('.links-item');
      return { panelCls: p.className, linksItemHtml: li ? li.outerHTML.slice(0, 1200) : '(无 .links-item)',
        singleLinkCount: p.querySelectorAll('.single-link-item').length,
        panelDisplay: getComputedStyle(p).display };
    })(),
    headerCandidates: [...document.querySelectorAll('[class*=header],[id*=header]')].slice(0,6)
      .map(e => e.tagName.toLowerCase() + '#' + e.id + '.' + String(e.className).split(' ').slice(0,3).join('.')),
  });
})()`;

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const child = await boot();
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(list.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(6000);
    const j = async (expr) => JSON.parse((await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value);
    const run = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

    console.log('\n=== ① 页面现状（B站 默认主题） ===');
    console.log(JSON.stringify(await j(PROBE), null, 2));

    console.log('\n=== ② 逐候选施加「深色标记」→ 看 body 背景是否真的变深 ===');
    const fmtBg = p => p.bodyBg ? 'rgb(' + p.bodyBg.r + ',' + p.bodyBg.g + ',' + p.bodyBg.b + ')' : 'n/a';
    const trial = async (label, apply, undo) => {
      await run(`(()=>{${apply}})()`);
      await sleep(700);
      const p = await j(PROBE);
      const dark = p.bodyBg && p.bodyBg.lum < 128;
      console.log(`  ${label.padEnd(42)} → bodyBg=${fmtBg(p)} 亮度=${p.bodyBg ? p.bodyBg.lum : '?'}  ${dark ? '✅ 变深' : '❌ 无变化'}`);
      await run(`(()=>{${undo}})()`);
      await sleep(300);
    };
    await trial("html.classList.add('dark')", "document.documentElement.classList.add('dark')", "document.documentElement.classList.remove('dark')");
    await trial("html.setAttribute('data-theme','dark')", "document.documentElement.setAttribute('data-theme','dark')", "document.documentElement.removeAttribute('data-theme')");
    await trial("html.setAttribute('data-dark','')", "document.documentElement.setAttribute('data-dark','')", "document.documentElement.removeAttribute('data-dark')");
    await trial("body.classList.add('dark')", "document.body.classList.add('dark')", "document.body.classList.remove('dark')");
    await trial("html.style.colorScheme='dark'", "document.documentElement.style.colorScheme='dark'", "document.documentElement.style.colorScheme=''");
    await trial("html.setAttribute('dark','')", "document.documentElement.setAttribute('dark','')", "document.documentElement.removeAttribute('dark')");
    await trial("html.setAttribute('theme','dark')", "document.documentElement.setAttribute('theme','dark')", "document.documentElement.removeAttribute('theme')");

    console.log('\n=== ②b 从 B站 样式表里反查「翻 --bg1 的那条规则」的选择器 ===');
    const sheets = JSON.parse(await run(`JSON.stringify([...document.styleSheets].map(s=>s.href||'(inline)'))`));
    console.log('  页面样式表 ' + sheets.length + ' 个（外部 ' + sheets.filter(s => s !== '(inline)').length + '，内联 ' + sheets.filter(s => s === '(inline)').length + '）');
    const hits = [];
    for (const href of sheets) {
      let txt = '';
      try {
        txt = href === '(inline)'
          ? JSON.parse(await run(`JSON.stringify([...document.querySelectorAll('style')].map(s=>s.textContent).join('\\n'))`))
          : await (await fetch(href)).text();
      } catch { continue; }
      for (const chunk of txt.split('}')) {
        if (!/--(bg1|text1)\s*:/.test(chunk)) continue;
        if (!/dark|night|theme/i.test(chunk)) continue;
        const sel = chunk.split('{')[0].trim().split(/[\r\n]/).filter(Boolean).pop() || '';
        const v = (/--(?:bg1|text1)\s*:\s*([^;]+)/.exec(chunk) || [])[1];
        hits.push({ from: href.slice(-70), sel: sel.slice(-140), val: (v || '').trim().slice(0, 40) });
      }
    }
    if (!hits.length) console.log('  （未找到含 dark/theme 字样的变量翻转规则 → B站 可能不用 CSS 变量切换深色）');
    const seen = new Set();
    for (const h of hits) {
      const k = h.sel + h.val;
      if (seen.has(k)) continue; seen.add(k);
      if (seen.size > 14) break;
      console.log(`  [${h.from}]  选择器: ${h.sel}   ${h.val}`);
    }

    console.log('\n=== ③ 强制深色媒体查询（headless 下用 CDP 模拟）===');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(1200);
    const pd = await j(PROBE);
    console.log(`  prefers-color-scheme:dark → bodyBg=${pd.bodyBg ? 'rgb(' + pd.bodyBg.r + ',' + pd.bodyBg.g + ',' + pd.bodyBg.b + ')' : 'n/a'} 亮度=${pd.bodyBg ? pd.bodyBg.lum : '?'}  htmlAttrs=${pd.htmlAttrs}`);

    console.log('\n=== ④ 检测可用的「是否深色」信号汇总 ===');
    console.log(JSON.stringify({ htmlAttrs: pd.htmlAttrs, bodyAttrs: pd.bodyAttrs, vars: pd.vars }, null, 2));
  } finally {
    try { child.kill(); } catch {}
  }
};
main().catch(e => { console.error('失败:', e.message); process.exit(1); });
