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

    console.log('\n=== 4.5) 真人影视分类：日剧 / 欧美剧 / 华语剧 / 韩剧 / 电影 ===');
    for (const [mode, label] of [['jdrama', '日剧'], ['wdrama', '欧美剧'], ['cdrama', '华语剧'], ['kdrama', '韩剧'], ['film', '电影']]) {
      const ok = await clickSel(`.bgm-mode[data-mode="${mode}"]`);
      await sleep(13000);
      const s = await stat();
      const plat = await evalJs(`JSON.stringify((() => {
        const cards = [...document.querySelectorAll('.bgm-card')];
        return { 卡片数: cards.length,
                 首个标题: (cards[0] && cards[0].querySelector('.bgm-title') || {}).textContent || '—',
                 有剧集数的卡片: cards.filter(c => c.querySelector('.bgm-ep')).length };
      })())`);
      console.log(`[${label}] 点击=${ok} activeMode=${s.activeMode} 卡片=${s.cards} 月份=${s.heads.filter(h => !h.includes('加载中')).length}/${s.heads.length}`);
      console.log(`        详情=${plat}  前3标题=${JSON.stringify(s.titles.slice(0, 3))}`);
      console.log(`        失败月份=${await evalJs(`document.querySelectorAll('#bgm-anime-root .bgm-err').length`)}`);
    }
    // 电影 / 韩剧都是「不带 cat + 前端过滤」，最能暴露分页提前退出 bug。
    // ⚠️ 纯度必须读**累计**的条目（view.allItems）—— 只读 lastItems() 只会看到最后一个月的 2~5 条，
    //    样本太小，会得出「平台纯度 {电视剧:2}」这种看似通过、其实什么都没验的假绿。
    await clickSel('.bgm-mode[data-mode="film"]');
    await sleep(13000);
    await evalJs(`document.querySelector('.bgm-body').scrollTop = 2500`);
    await sleep(6000);
    console.log('电影 tab 平台纯度（累计已加载月份，应为 100% 电影）：' + await evalInScriptWorld(
      `(() => { const v = window.__BGM_ANIME__; if (!v || !v.view) return '取不到 view';
         const acc = v.view.allItems || []; if (!acc.length) return '没攒到（view.allItems 未生效）';
         const ps = {}; for (const x of acc) ps[x.platform || '(空)'] = (ps[x.platform || '(空)'] || 0) + 1;
         return JSON.stringify(ps) + ' 共' + acc.length + '条'; })()`));
    console.log('电影 tab 月份分布：' + await evalJs(`JSON.stringify([...document.querySelectorAll('.bgm-month')]
      .map(m => m.dataset.month + ':' + m.querySelectorAll('.bgm-card').length).filter(s => !s.endsWith(':0')))`));

    // 韩剧：platform=电视剧 + tagPool 命中「韩国」—— 主目的不是数量而是**没有混入非韩剧**
    await clickSel('.bgm-mode[data-mode="kdrama"]');
    await sleep(13000);
    await evalJs(`document.querySelector('.bgm-body').scrollTop = 2500`);
    await sleep(6000);
    console.log('韩剧 tab 平台纯度（累计，应全为「电视剧」）：' + await evalInScriptWorld(
      `(() => { const v = window.__BGM_ANIME__; if (!v || !v.view) return '取不到 view';
         const acc = v.view.allItems || []; if (!acc.length) return '没攒到';
         const ps = {}; for (const x of acc) ps[x.platform || '(空)'] = (ps[x.platform || '(空)'] || 0) + 1;
         return JSON.stringify(ps) + ' 共' + acc.length + '条'; })()`));
    console.log('韩剧 tab 命中词分布（应全是 韩国/韩剧/韩语）：' + await evalInScriptWorld(
      `(() => { const v = window.__BGM_ANIME__; if (!v || !v.view) return '取不到 view';
         const KD = /韩剧|韩国|韩语/; const hits = {};
         for (const x of (v.view.allItems || [])) for (const t of (x.tagPool || []))
           if (KD.test(t)) hits[t] = (hits[t] || 0) + 1;
         return JSON.stringify(hits); })()`));
    console.log('韩剧 tab 卡片（标题 + 命中的 tag）：' + await evalJs(
      `[...document.querySelectorAll('.bgm-card')].slice(0, 8)
        .map(c => (c.querySelector('.bgm-title')||{}).textContent).join(' ; ') || '（空）'`));

    console.log('\n=== 4.7) 720P 适配：9 个分类在同一行、不换行、不溢出 ===');
    // 关键断言（不是"看起来还行"）：
    //   ① tab 行**单行**：所有 .bgm-mode 的 top 相同（换行会让 top 分两组）
    //   ② 顶栏**不纵向溢出**：icon 下沿 + 少量余量 ≤ 顶栏下沿（否则会被压扁/裁切）
    //   ③ 品牌文字在窄屏消失、圆点仍在（信息不丢）
    const topProbe = `JSON.stringify((() => {
      const modes = [...document.querySelectorAll('.bgm-mode')].map(b => {
        const r = b.getBoundingClientRect();
        return { k: b.dataset.mode, t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width) };
      });
      const tops = [...new Set(modes.map(m => m.t))];
      const bar = document.querySelector('.bgm-top');
      const barIn = document.querySelector('.bgm-top-in');
      const barR = bar ? bar.getBoundingClientRect() : null;
      const inR = barIn ? barIn.getBoundingClientRect() : null;
      const gear = document.getElementById('bgm-gear-btn');
      const gR = gear ? gear.getBoundingClientRect() : null;
      const modesBox = document.querySelector('.bgm-modes');
      const brandTxt = document.querySelector('.bgm-brand-txt');
      const dot = document.querySelector('.bgm-brand-dot');
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        tabCount: modes.length,
        rowCount: tops.length,
        tabRowWidth: modes.reduce((s, m) => s + m.w, 0),
        modesBarW: modesBox ? Math.round(modesBox.getBoundingClientRect().width) : 0,
        modesScrollW: modesBox ? Math.round(modesBox.scrollWidth) : 0,
        modesOverflow: modesBox ? modesBox.scrollWidth > modesBox.clientWidth + 1 : null,
        barH: barR ? Math.round(barR.height) : null,
        barBottom: barR ? Math.round(barR.bottom) : null,
        contentBottom: gR ? Math.round(gR.bottom) : null,
        rowBottom: (() => { const r = document.querySelector('.bgm-modes');
          return r ? Math.round(r.getBoundingClientRect().bottom) : null; })(),
        brandTxtHidden: brandTxt ? getComputedStyle(brandTxt).display === 'none' : null,
        dotVisible: dot ? dot.getBoundingClientRect().width > 0 : null,
        gearVisible: gR ? gR.width > 0 && gR.height > 0 : null,
        gearRight: gR ? Math.round(gR.right) : null,
        searchVisible: (() => { const s = document.querySelector('.bgm-search');
          return s ? getComputedStyle(s).display !== 'none' : null; })(),
        docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        // 溢出时必须**归因**：是我们铺满用的 fixed 根容器，还是页面上别的元素。
        // ⚠️ 关键判据不是「元素 right 是否超出视口」，而是「它是否**自己**把页面撑宽了」。
        //    反例（本项目的经典误报）：页面已被 B站 的 .bili-header（min-width:1100）撑到 1100px，
        //    此时 .bgm-year 只是**跟着**被排到 x=1059+，right 自然 > vw，但它并非致因。
        //    正确做法：向上找最近的可横向滚动祖先；若该祖先存在且**祖先内**能滚到它，
        //    说明它没撑破任何东西 ⇒ 不算。
        overflowSources: (() => {
          const vw = document.documentElement.clientWidth;
          const out = [];
          const scrollableAncestor = (el) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              const cs = getComputedStyle(p);
              if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return p;
            }
            return null;
          };
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.right <= vw + 1) continue;
            const cs = getComputedStyle(el);
            const spanning = cs.position === 'fixed' && cs.left !== 'auto' && cs.right !== 'auto';
            if (spanning) continue;          // 铺满型浮层不算（不贡献滚动条）
            const sc = scrollableAncestor(el);
            if (sc) continue;                // 有可滚动祖先兜着 ⇒ 它没撑破页面
            if (out.length >= 6) break;
            out.push((el.id ? '#' + el.id : '') +
              (el.className && typeof el.className === 'string'
                ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
              + '@' + Math.round(r.right));
          }
          return out;
        })(),
        rootIsFixed: (() => { const r = document.getElementById('bgm-anime-root');
          return r ? getComputedStyle(r).position : 'no-root'; })(),
        bodyScrollW: document.body.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        // 自动归因：溢出的元素里有没有我们**会造成横向滚动的**那一类。
        // ⚠️ 判据（连乘三条，缺一不可）：
        //    ① 元素 right 超出视口右沿；
        //    ② 它不是 position:fixed 且 left/right 均非 auto 的铺满型浮层
        //       （我们的 #bgm-anime-root 就是这类，物理上不可能撑出滚动条）；
        //    ③ 它**没有**可横向滚动的祖先 —— 有的话说明它只是被排到框外，
        //       用户能滚过去看到它，它没有把任何东西撑宽。
        //    B站 自己的 .bili-header（硬 min-width）在窄视口确实会超框，与本脚本无关，
        //    所以必须让判据能把它排除出去、而不是见 bgm- 前缀就报我们。
        overflowIsOurs: (() => {
          const vw = document.documentElement.clientWidth;
          const scrollableAncestor = (el) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              const cs = getComputedStyle(p);
              if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return p;
            }
            return null;
          };
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.right <= vw + 1) continue;
            const cs = getComputedStyle(el);
            // fixed + 左右都不 auto ⇒ 铺满型浮层，不贡献横向滚动
            const spanning = cs.position === 'fixed' && cs.left !== 'auto' && cs.right !== 'auto';
            if (spanning) continue;
            if (scrollableAncestor(el)) continue;   // ③ 被可滚动容器兜住 ⇒ 非致因
            const id = el.id || '';
            const cls = (typeof el.className === 'string' ? el.className : '') || '';
            if (id.startsWith('bgm') || /(^|\s)bgm-/.test(cls)) return true;
          }
          return false;
        })(),
      };
    })())`;

    for (const [w, h, label] of [[1280, 720, '720P'], [1366, 768, '768P'], [1024, 768, 'XS'], [800, 600, '窄窗']]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(1600);
      const r = JSON.parse(await evalJs(topProbe));
      const okRow = r.rowCount === 1;
      const okFit = r.contentBottom !== null && r.barBottom !== null && r.contentBottom <= r.barBottom;
      console.log(`[${label} ${w}×${h}] tab ${r.tabCount} 个 / 行数=${r.rowCount}${okRow ? ' ✅' : ' ❌换行'}`
        + ` ｜ tab 行宽 ${r.tabRowWidth} vs 容器 ${r.modesBarW}${r.modesOverflow ? ' (内部滚动)' : ' (放得下)'}`
        + ` ｜ 顶栏 ${r.barH}px 内容底 ${r.contentBottom} ≤ ${r.barBottom}${okFit ? ' ✅' : ' ❌溢出'}`
        + ` ｜ 品牌字${r.brandTxtHidden === null ? '?' : (r.brandTxtHidden ? '隐藏' : '显示')} 圆点${r.dotVisible ? '✅' : '❌'}`
        + ` ｜ 齿轮右 ${r.gearRight}/${r.vw}${r.gearVisible ? '' : ' ❌不可见'}`
        + (r.docOverflowX
          ? ` ｜ 横向溢出${r.overflowIsOurs ? ' ❌来自本脚本' : ' ⚠️非本脚本'} ${JSON.stringify(r.overflowSources)}`
          : ' ｜ ✅无横向溢出'));
      const shotW = path.join(OUT, `layout-${w}x${h}.png`);
      const pngW = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shotW, Buffer.from(pngW.data, 'base64'));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(1200);

    console.log('\n=== 4.9) 封面档位：卡片实际加载的图必须等于「封面质量」设置 ===');
    // 为什么必须守住：v0 与 p1 的档位**命名不对齐**（v0 medium=r800 / p1 medium=r200），
    // 只有 common 两边一致 ⇒ 脚本一律以 common 为基准、在渲染时改写成设置的宽度。
    // 断言**动态读 cfg.coverQuality**（不再写死 400）：默认档位是会变的，
    // 写死会让「改了默认值」和「功能坏了」两种情形混在一起，分不清。
    // 实测事实见 docs/bangumi-list-api-facts.md §8 与主脚本 pickCover() / withCoverWidth() 注释。
    //
    // ⚠️ 读 cfg / 调 withCoverWidth 必须走 **evalInScriptWorld**（隔离世界）：
    //    内容脚本与页面是两个 window，在页面世界读 __BGM_ANIME__ **永远是 undefined**。
    //    本段初版就错用了页面世界的 evalJs ⇒ 期望档位被兜底成 400、而实际是 100，误报「与设置不符」。
    //    （DOM 查询仍然用 evalJs 就行 —— DOM 是两个世界共享的。）
    const apiProbe = await evalInScriptWorld(`JSON.stringify((() => {
      const A = (typeof __BGM_ANIME__ !== 'undefined') ? __BGM_ANIME__ : null;
      if (!A) return { api: false };
      const raw = A.cfg ? A.cfg.coverQuality : null;
      return {
        api: true,
        cfgType: typeof raw,
        cfgRaw: raw,
        want: (typeof A.coverWidth === 'function') ? A.coverWidth() : null,
      };
    })())`);
    let api = null;
    try { api = JSON.parse(apiProbe); } catch (e) { api = null; }
    if (!api || !api.api) {
      console.log('  ❌ 取不到脚本 API（隔离世界求值失败）—— 4.9 段无法判定');
    } else {
      const wantKey = api.want ? String(api.want) : '原图';
      const domProbe = `JSON.stringify((() => {
        const imgs = [...document.querySelectorAll('.bgm-card img')];
        const tierOf = u => { const m = String(u).match(/\\/r\\/(\\d+)(?:x\\d+)?\\//); return m ? m[1] : '原图'; };
        const tiers = {};
        for (const i of imgs) { const t = tierOf(i.currentSrc || i.src); tiers[t] = (tiers[t] || 0) + 1; }
        return {
          cards: document.querySelectorAll('.bgm-card').length,
          imgs: imgs.length,
          tiers,
          samples: imgs.slice(0, 2).map(i => i.currentSrc || i.src),
        };
      })())`;
      const cp = JSON.parse(await evalJs(domProbe));
      const tierKeys = Object.keys(cp.tiers);
      // w=0（原图）时 URL 里没有 r/<N> 段，tierOf 会归到 '原图'
      const allMatch = cp.imgs > 0 && tierKeys.length === 1 && cp.tiers[wantKey] === cp.imgs;
      console.log(`卡片 ${cp.cards} 张 / img ${cp.imgs} 个 ｜ 设置 ${api.cfgType} ${JSON.stringify(api.cfgRaw)}`
        + ` → 期望 ${wantKey} ｜ 实际 ${JSON.stringify(cp.tiers)}`
        + `${allMatch ? ' ✅ 全部符合设置' : (cp.imgs === 0 ? ' ⚠️ 本页无卡片（不影响判定）' : ' ❌ 与设置不符')}`);
      cp.samples.forEach(u => console.log('  ' + u));

      // 附带一致性检查：两份基准 URL 的档位段必须都能被改写（守 catch：p1 的 r/100x100 方形档）
      const shapeRaw = await evalInScriptWorld(`JSON.stringify((() => {
        const A = (typeof __BGM_ANIME__ !== 'undefined') ? __BGM_ANIME__ : null;
        if (!A || typeof A.withCoverWidth !== 'function') return { skipped: true };
        const v0 = 'https://lain.bgm.tv/r/400/pic/cover/l/ce/3a/1.jpg';
        const p1sq = 'https://lain.bgm.tv/r/100x100/pic/cover/l/28/41/2.jpg';
        return {
          a: A.withCoverWidth(v0, 100),
          b: A.withCoverWidth(p1sq, 100),
          c: A.withCoverWidth(v0, 0),
          tiers: JSON.stringify(A.COVER_TIERS || null),
        };
      })())`);
      let shapeChk = null;
      try { shapeChk = JSON.parse(shapeRaw); } catch (e) { shapeChk = null; }
      if (!shapeChk || shapeChk.skipped) {
        console.log('  ❌ withCoverWidth 未暴露到隔离世界，形状检查失败');
      } else {
        const okA = /^https:\/\/lain\.bgm\.tv\/r\/100\/pic\/cover\/l\//.test(shapeChk.a);
        const okB = /^https:\/\/lain\.bgm\.tv\/r\/100\/pic\/cover\/l\//.test(shapeChk.b)
          && !/x\d+\//.test(shapeChk.b);            // 方形档必须被剥掉
        const okC = /^https:\/\/lain\.bgm\.tv\/pic\/cover\/l\//.test(shapeChk.c);
        const okT = shapeChk.tiers === '[100,200,400,600,800]';
        console.log(`  形状检查：普通档 ${okA ? '✅' : '❌'} ｜ 方形档 r/100x100 剥离 ${okB ? '✅' : '❌'}`
          + ` ｜ w=0 还原原图 ${okC ? '✅' : '❌'} ｜ 档位表 ${okT ? '✅' : '❌'} ${shapeChk.tiers}`);
      }
    }

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
