/**
 * 交互验证：CDP 驱动真实点击，验证分类 tab / 年份栏切换、空月份隐藏、设置面板。
 *
 * 注意：用户脚本的 window 在 isolated world，主 world 取不到它的变量；
 * 但 DOM 与事件监听器是共享的 —— 所以这里「查 DOM + 派发真实鼠标事件」即可，
 * 无需跨 world 通信（顺带也验证了事件委托本身是好的）。
 *
 * 用法：CDP_PORT=9224 node tools/e2e-anime-cdp.mjs [url]
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
const PORT = Number(process.env.CDP_PORT || 9224);
const URL_TARGET = process.argv[2] || 'https://www.bilibili.com/anime/';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot() {
  const profile = path.join(OUT, 'profile-cdp');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,1300', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank',
  ], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return child;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.events = [];      // CDP 推送的事件（未捕获异常 / console 错误）—— 收错误必须靠这个
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        if (this.events.length < 5000) this.events.push(m);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 60000);
    });
  }
}

const STAT_EXPR = `JSON.stringify({
  months: [...document.querySelectorAll('.bgm-month')].map(s => s.dataset.month),
  heads: [...document.querySelectorAll('.bgm-month-h')].map(h => h.textContent.replace(/\\s+/g,' ').trim()),
  cards: document.querySelectorAll('.bgm-card').length,
  scores: [...document.querySelectorAll('.bgm-score')].slice(0,8).map(e=>e.textContent),
  titles: [...document.querySelectorAll('.bgm-title')].slice(0,5).map(e=>e.textContent),
  activeMode: (document.querySelector('.bgm-mode.on')||{}).textContent || null,
  activeYear: (document.querySelector('.bgm-year.on')||{}).dataset ? document.querySelector('.bgm-year.on').dataset.year : null,
  panel: !!document.querySelector('.bgm-panel'),
  root: !!document.getElementById('bgm-anime-root'),
})`;

const main = async () => {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('先跑一次 tools/e2e-anime.mjs 以生成临时扩展');
    process.exit(1);
  }
  // 每次都从源码同步脚本副本，避免测到上一次的旧版本
  fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
  fs.mkdirSync(OUT, { recursive: true });
  const child = await boot();
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    const cdp = new Cdp(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');   // 收 console.error / 网络错误（Runtime 只报未捕获异常）
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: URL_TARGET });
    await sleep(14000);

    const evalJs = async expr => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      const ex = r.exceptionDetails;
      if (ex) throw new Error(ex.text + ' ' + JSON.stringify(ex.exception || {}));
      return r.result && r.result.value;
    };
    const stat = async () => JSON.parse(await evalJs(STAT_EXPR));

    /**
     * 在「内容脚本的隔离世界」里求值。
     * 油猴/扩展脚本的 window 与页面 window 是两个世界 —— 页面里读 `__BGM_ANIME__` 永远是 undefined，
     * 必须用 CDP 的隔离世界 contextId 才读得到脚本内部状态（netStats / cfg / view …）。
     */
    const scriptWorld = () => cdp.events
      .filter(e => e.method === 'Runtime.executionContextCreated')
      .map(e => e.params.context)
      .filter(c => c.auxData && c.auxData.isDefault === false);

    const evalInScriptWorld = async expr => {
      const ctxs = scriptWorld();
      for (const c of ctxs) {
        try {
          const r = await cdp.send('Runtime.evaluate', {
            expression: expr, contextId: c.id, returnByValue: true, awaitPromise: true,
          });
          if (r.exceptionDetails || !r.result) continue;
          if (r.result.value !== undefined) return r.result.value;
        } catch (e) { /* 换下一个上下文 */ }
      }
      return '（隔离世界上下文里取不到）';
    };

    const clickSel = async sel => {
      const pt = JSON.parse(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(!e) return 'null'; const r=e.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
      if (!pt) return false;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      }
      return true;
    };

    console.log('=== 1) 初始状态（TV / 当前年）===');
    console.log(JSON.stringify(await stat(), null, 1));
    console.log('执行上下文（隔离世界 = 内容脚本）：' + JSON.stringify(scriptWorld()
      .map(c => ({ id: c.id, name: c.name || '', origin: c.origin || '' }))));
    console.log('脚本世界自检 版本/白名单数：' + await evalInScriptWorld(
      `window.__BGM_ANIME__ ? window.__BGM_ANIME__.VERSION + ' / ' + window.__BGM_ANIME__.TAG_WHITELIST.length : 'no __BGM_ANIME__'`));
    console.log('页面世界（F12 控制台视角）能读到吗：' + await evalJs(
      `typeof window.__BGM_ANIME__ + (window.__BGM_ANIME__ ? ' v' + window.__BGM_ANIME__.VERSION : '')`));

    console.log('\n=== 2) 点击「剧场版」tab ===');
    console.log('点击：' + await clickSel('.bgm-mode[data-mode="movie"]'));
    await sleep(9000);
    console.log(JSON.stringify(await stat(), null, 1));

    console.log('\n=== 3) 点击年份 2024 ===');
    console.log('点击：' + await clickSel('.bgm-year[data-year="2024"]'));
    await sleep(11000);
    const s3 = await stat();
    console.log(JSON.stringify(s3, null, 1));

    console.log('\n=== 4) 切回 TV tab（2024 年）===');
    await clickSel('.bgm-mode[data-mode="tv"]');
    await sleep(11000);
    const s4 = await stat();
    console.log(JSON.stringify({ activeMode: s4.activeMode, activeYear: s4.activeYear, cards: s4.cards, heads: s4.heads.slice(0, 12), titles: s4.titles }, null, 1));

    console.log('\n=== 5) 滚动触发懒加载 ===');
    const before = (await stat()).cards;
    for (const y of [1200, 2600, 4200, 6000]) {
      await evalJs(`document.querySelector('.bgm-body').scrollTop = ${y}`);
      await sleep(4500);
    }
    const after = await stat();
    console.log(`卡片：${before} → ${after.cards}；已加载月份：${after.heads.filter(h => !h.includes('加载中')).length}/${after.heads.length}`);
    console.log('表头：' + after.heads.join(' | '));

    console.log('\n=== 5.5) tag 覆盖率（v0 列表自带全量 tags，无需任何补拉）===');
    // 补拉默认关闭 ⇒ 不再轮询等待；只给渲染一点稳定时间
    await sleep(3000);
    console.log('tag 覆盖：' + await evalJs(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.bgm-card')];
      const n = c => cards.filter(x => x.querySelectorAll('.bgm-tag').length === c).length;
      return { 卡片总数: cards.length, '0个tag': n(0), '1个tag': n(1), '2个tag': n(2),
               '覆盖率': cards.length ? Math.round((cards.length - n(0)) / cards.length * 100) + '%' : '—' };
    })())`));
    const detailReqs = cdp.events.filter(e => e.method === 'Network.requestWillBeSent'
      && /\/(p1|v0)\/subjects\/\d+/.test((e.params.request || {}).url || ''));
    // ⚠️ 这里的 0 不代表没发请求：GM_xmlhttpRequest 走扩展后台，不经过页面网络栈，页面级 CDP 抓不到。
    console.log('详情请求数（页面 CDP 视野，GM_xhr 抓不到，仅作参考）：' + detailReqs.length);
    // 真信号 ①：脚本自己的计数器（读隔离世界，GM_xhr 的成败都在这里）
    console.log('脚本内 netStats：' + await evalInScriptWorld(
      `window.__BGM_ANIME__ ? JSON.stringify(window.__BGM_ANIME__.netStats) : 'no __BGM_ANIME__'`));
    // 真信号 ②：剩余空 tag 的卡片是谁（看是白名单缺词，还是补拉没跑到）
    console.log('剩余无 tag 卡片：' + await evalJs(`[...document.querySelectorAll('.bgm-card')]
      .filter(c => c.querySelectorAll('.bgm-tag').length === 0).slice(0, 10)
      .map(c => (c.querySelector('.bgm-title')||{}).textContent).join(' ; ') || '（无）'`));
    console.log('只有 1 个 tag 的卡片：' + await evalJs(`[...document.querySelectorAll('.bgm-card')]
      .filter(c => c.querySelectorAll('.bgm-tag').length === 1).slice(0, 10)
      .map(c => (c.querySelector('.bgm-title')||{}).textContent + '[' + c.querySelector('.bgm-tag').textContent + ']').join(' ; ') || '（无）'`));
    console.log('带 tag 的卡片样例：' + await evalJs(`[...document.querySelectorAll('.bgm-card')]
      .filter(c => c.querySelector('.bgm-tags')).slice(0, 8)
      .map(c => (c.querySelector('.bgm-title')||{}).textContent + ' [' +
        [...c.querySelectorAll('.bgm-tag')].map(t => t.textContent).join('/') + ']').join(' ; ')`));

    console.log('\n=== 6) 打开设置面板 ===');
    await clickSel('#bgm-gear-btn');
    await sleep(1200);
    const s5 = await stat();
    console.log('面板已打开：' + s5.panel);
    console.log('面板行：' + await evalJs(`[...document.querySelectorAll('.bgm-panel .bgm-row')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`));
    console.log('统计：' + await evalJs(`(document.querySelector('.bgm-stat')||{}).textContent`));

    const shot = path.join(OUT, 'interact-final.png');
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    console.log('\n截图：' + shot);

    console.log('\n=== 7) 图片加载统计（滚回顶部后等图）===');
    await evalJs(`document.querySelector('.bgm-body').scrollTop = 0`);
    await sleep(1500);
    const imgExpr = `JSON.stringify({
      total: document.querySelectorAll('.bgm-card img').length,
      ok: [...document.querySelectorAll('.bgm-card img')].filter(i => i.complete && i.naturalWidth > 0).length,
      broken: [...document.querySelectorAll('.bgm-card img')].filter(i => i.complete && i.naturalWidth === 0).length,
      pending: [...document.querySelectorAll('.bgm-card img')].filter(i => !i.complete).length,
      panelVisible: (() => { const p = document.querySelector('.bgm-panel');
        if (!p) return 'no-panel'; const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(p.closest('.bgm-mask') || p).display !== 'none'; })(),
      // 面板背景若解析成全透明，说明主题变量没传到浮层上（见 README 的 bug 记录）
      panelBg: (() => { const p = document.querySelector('.bgm-panel');
        return p ? getComputedStyle(p).backgroundColor : 'no-panel'; })(),
    })`;
    let imgStat = JSON.parse(await evalJs(imgExpr));
    for (let i = 0; i < 25 && imgStat.pending > 0; i++) {
      await sleep(1000);
      imgStat = JSON.parse(await evalJs(imgExpr));
    }
    console.log(JSON.stringify(imgStat, null, 1));

    const shotTop = path.join(OUT, 'interact-top.png');
    const png2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotTop, Buffer.from(png2.data, 'base64'));
    console.log('首屏截图：' + shotTop);

    console.log('\n=== 8) 浮层可见性自检（HIDE_CSS 是否误伤 + 主题变量是否传到浮层）===');
    const floatProbe = `JSON.stringify((() => {
      const out = {};
      // (a) 带 data-bgm-float 标记的浮层不能被 HIDE_CSS 设成 display:none
      const probe = document.createElement('div');
      probe.dataset.bgmFloat = '';
      probe.style.position = 'fixed';
      document.body.appendChild(probe);
      out.flaggedFloatDisplay = getComputedStyle(probe).display;
      probe.remove();
      // (b) 没标记的普通 body 子元素应当被藏掉（证明 hide 规则本身生效）
      const bare = document.createElement('div');
      document.body.appendChild(bare);
      out.bareDisplay = getComputedStyle(bare).display;
      bare.remove();
      // (c) 浮层能否解析到主题变量
      const cs = getComputedStyle(document.documentElement);
      out.varCard = cs.getPropertyValue('--card').trim() || '(empty)';
      const p = document.querySelector('.bgm-panel');
      out.panelBackgroundColor = p ? getComputedStyle(p).backgroundColor : 'no-panel';
      return out;
    })())`;
    console.log(JSON.stringify(JSON.parse(await evalJs(floatProbe)), null, 1));

    console.log('\n=== 9) 保留 B站 表头：几何 + 皮肤 + 下拉层叠 ===');
    console.log('面板统计：' + await evalJs(`(document.querySelector('.bgm-stat')||{textContent:'(无)'}).textContent.replace(/\\s+/g,' ')`));
    console.log('面板按钮：' + await evalJs(`[...document.querySelectorAll('.bgm-panel .bgm-btn')]
      .map((b,i) => (i+1) + ':' + b.textContent).join(' | ')`));
    // 先关掉设置面板，免得挡住表头
    await clickSel('.bgm-panel .bgm-btn:nth-child(2)');
    await sleep(900);
    console.log('失败月份=' + await evalJs(`[...document.querySelectorAll('#bgm-anime-root .bgm-err')].length`)
      + ' / 月份总数=' + await evalJs(`document.querySelectorAll('#bgm-anime-root .bgm-month').length`));
    const hdr = JSON.parse(await evalJs(`JSON.stringify((() => {
      const bar = document.querySelector('.bili-header__bar');
      const mh = document.getElementById('biliMainHeader');
      const root = document.getElementById('bgm-anime-root');
      const cs = bar ? getComputedStyle(bar) : null;
      const b = bar ? bar.getBoundingClientRect() : null;
      const rr = root ? root.getBoundingClientRect() : null;
      const search = document.querySelector('#bgm-anime-root .bgm-search');
      return {
        headerExists: !!mh,
        headerDisplay: mh ? getComputedStyle(mh).display : 'no-header',
        barExists: !!bar,
        barClasses: bar ? String(bar.className) : '',
        barOpaque: cs ? cs.backgroundColor : '',
        barHasGradient: cs ? cs.backgroundImage.slice(0, 20) : '',
        barZ: cs ? cs.zIndex : '',
        headerBottom: b ? Math.round(b.bottom) : null,
        rootTop: rr ? Math.round(rr.top) : null,
        // 关键断言：内容区必须严格排在表头下沿之下，不能压住表头
        noOverlap: !!(b && rr && rr.top >= b.bottom - 1),
        cssVarTop: getComputedStyle(document.documentElement).getPropertyValue('--bgm-top').trim(),
        cssVarZ: getComputedStyle(document.documentElement).getPropertyValue('--bgm-z').trim(),
        ourSearchHidden: search ? getComputedStyle(search).display === 'none' : 'no-search',
        titleColor: (() => { const t = document.querySelector('.left-entry .entry-title span');
          return t ? getComputedStyle(t).color : '?'; })(),
      };
    })())`));
    console.log(JSON.stringify(hdr, null, 1));

    // 真实 hover 一个带下拉的表头项，验证 B站 自己的浮层没被内容区盖住
    const hovered = JSON.parse(await evalJs(`(() => {
      const wrap = [...document.querySelectorAll('#biliMainHeader .v-popover-wrap')]
        .find(w => w.querySelector(':scope > .v-popover'));
      if (!wrap) return 'null';
      const r = wrap.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cls: String(wrap.className) });
    })()`));
    if (hovered) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hovered.x, y: hovered.y });
      await sleep(1400);
      console.log('hover 目标：' + hovered.cls + ' @ (' + hovered.x + ',' + hovered.y + ')');
      // 只看真正的浮层本体 .v-popover，别把常显的包裹层 .v-popover-wrap 算进来
      console.log('表头浮层：' + await evalJs(`JSON.stringify((() => {
        const pops = [...document.querySelectorAll('#biliMainHeader .v-popover')]
          .filter(p => getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 10);
        const root = document.getElementById('bgm-anime-root');
        const rz = root ? getComputedStyle(root).zIndex : '-';
        return { visible: pops.length,
                 rects: pops.slice(0, 3).map(p => { const r = p.getBoundingClientRect();
                   return Math.round(r.top) + '..' + Math.round(r.bottom); }),
                 rootZ: rz, barZ: (() => { const b = document.querySelector('.bili-header__bar');
                   return b ? getComputedStyle(b).zIndex : '-'; })() };
      })())`));
      const shotHd = path.join(OUT, 'header-hover.png');
      const pngH = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shotHd, Buffer.from(pngH.data, 'base64'));
      console.log('表头 hover 截图：' + shotHd);
    }

    console.log('\n=== 10) 关掉「保留 B站 顶栏」→ 应退回整页铺满 ===');
    await clickSel('#bgm-gear-btn');                 // 重新打开设置面板
    await sleep(800);
    await clickSel('.bgm-panel .bgm-row input[type=checkbox]');   // 第一行 = 保留 B站 顶栏
    await sleep(1000);
    console.log(JSON.stringify(JSON.parse(await evalJs(`JSON.stringify((() => {
      const mh = document.getElementById('biliMainHeader');
      const root = document.getElementById('bgm-anime-root');
      const rr = root ? root.getBoundingClientRect() : null;
      const search = document.querySelector('#bgm-anime-root .bgm-search');
      return {
        keepHeaderChecked: (() => { const c = document.querySelector('.bgm-panel .bgm-row input[type=checkbox]');
          return c ? c.checked : '?'; })(),
        headerDisplay: mh ? getComputedStyle(mh).display : 'no-header',
        rootTop: rr ? Math.round(rr.top) : null,
        rootZ: root ? getComputedStyle(root).zIndex : '-',
        ourSearchShown: search ? getComputedStyle(search).display !== 'none' : 'no-search',
        htmlClasses: String(document.documentElement.className),
      };
    })())`)), null, 1));

    // 再勾回来，确认可逆（别把用户留在半路状态）
    await clickSel('.bgm-panel .bgm-row input[type=checkbox]');
    await sleep(1000);
    console.log('勾回后：' + await evalJs(`JSON.stringify({
      headerDisplay: (() => { const mh = document.getElementById('biliMainHeader');
        return mh ? getComputedStyle(mh).display : 'no-header'; })(),
      rootTop: Math.round(document.getElementById('bgm-anime-root').getBoundingClientRect().top),
    })`));

    console.log('\n=== 页面错误（CDP 原生事件，不是页面变量）===');
    // 之前这里是读 `window.__bgmErrors` —— 那个变量脚本里根本不存在，
    // 于是 `undefined || []` 永远打印 []，"0 错误"是个假绿。改成收 CDP 自己的事件。
    const ours = e => /bili-anime-replace|bili-anime-root|bgm-anime/.test(
      ((e.params.exceptionDetails || {}).url || (e.params.entry || {}).url || '')
      + ((e.params.exceptionDetails || {}).text || '')
      + (((e.params.exceptionDetails || {}).exception || {}).description || '')
      + ((e.params.entry || {}).text || ''));

    const thrown = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown');
    const logs = cdp.events.filter(e => e.method === 'Log.entryAdded'
      && e.params.entry && e.params.entry.level === 'error');

    const fmt = e => e.method === 'Runtime.exceptionThrown'
      ? ((e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text || '?')
      : `[${e.params.entry.source}] ${e.params.entry.text}`;

    console.log(`未捕获异常：${thrown.length} 条（其中来自本脚本：${thrown.filter(ours).length}）`);
    thrown.slice(0, 6).forEach(e => console.log('  ! ' + String(fmt(e)).split('\n')[0].slice(0, 160)));
    console.log(`console.error / 网络错误：${logs.length} 条（其中来自本脚本：${logs.filter(ours).length}）`);
    logs.slice(0, 8).forEach(e => console.log('  - ' + String(fmt(e)).split('\n')[0].slice(0, 160)));
    // 502 是本轮 Bangumi 侧的真实情况，单独点出来，别和脚本 bug 混在一起
    const net502 = logs.filter(e => /502/.test((e.params.entry || {}).text || '')).length;
    console.log(`其中含 502 的：${net502} 条（Bangumi 侧问题，非脚本异常）`);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
};

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
