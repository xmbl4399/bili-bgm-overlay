/**
 * 新番表（周历）端到端验证 —— CDP 驱动真实点击，断言：
 *
 *   1. 「新番表」是**第一个** tab（data-mode=calendar 在 .bgm-modes 的首位）
 *   2. 点它之后：`.bgm-week` 恰好 7 个、首组是**今天**、年份栏**整条隐藏**
 *   3. 分组标题形如「星期三 · 今天 · N 部」，且 orderFrom() 与 DOM 顺序一致
 *   4. 空分组**保留**（不是 .remove()），文字是「今天没有可显示的番剧」之类
 *   5. 卡片能出封面/评分/tag（p1 通路有 metaTags）；封面的 img.src 必须是 https
 *   6. 页脚有「本周 N 部在播 · 数据来自 …」
 *   7. 切回 TV 后年份栏又回来（`.bgm-cal-mode` 被摘掉）
 *   8. 无 console.error / 未捕获异常
 *
 * 用法：node tools/e2e-calendar.mjs [url]
 * 浏览器取 $EDGE，否则按平台猜（Linux /usr/bin/microsoft-edge，Windows 装 Edge 的默认路径）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(__dirname, '.e2e-cal-ext');
const OUT = path.join(__dirname, '.e2e-cal-out');
const PORT = Number(process.env.CDP_PORT || 9331);
const URL_TARGET = process.argv[2] || 'https://www.bilibili.com/anime/';

const EDGE = process.env.EDGE || (
  fs.existsSync('/usr/bin/microsoft-edge') ? '/usr/bin/microsoft-edge'
  : fs.existsSync('/usr/bin/microsoft-edge-stable') ? '/usr/bin/microsoft-edge-stable'
  : fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. 生成临时扩展（与 e2e-anime.mjs 同款 shim，只为让 GM_* 存在） ---------- */
function buildExt() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));

  fs.writeFileSync(path.join(EXT, 'gm-shim.js'), `(function(){
  const P = 'bgmanime:';
  window.GM_getValue = (k, d) => { try { const v = localStorage.getItem(P + k); return v == null ? d : v; } catch(e){ return d; } };
  window.GM_setValue = (k, v) => { try { localStorage.setItem(P + k, v); } catch(e){} };
  window.GM_deleteValue = (k) => { try { localStorage.removeItem(P + k); } catch(e){} };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (opts) => {
    let done = false;
    const fail = (m) => { if (done) return; done = true; opts.onerror && opts.onerror(new Error(m)); };
    try {
      chrome.runtime.sendMessage({ type: 'gm-xhr', url: opts.url, method: opts.method || 'GET' }, r => {
        if (done) return;
        if (chrome.runtime.lastError || !r) return fail('bridge error');
        if (r.error) return fail(r.error);
        done = true;
        opts.onload && opts.onload({ status: r.status, responseText: r.text || '', responseHeaders: '' });
      });
    } catch (e) { fail(String(e)); }
  };
})();\n`);

  fs.writeFileSync(path.join(EXT, 'background.js'), `chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'gm-xhr') {
    fetch(msg.url, { method: msg.method || 'GET', headers: { 'Accept': 'application/json' }, redirect: 'follow' })
      .then(async r => sendResponse({ status: r.status, text: await r.text() }))
      .catch(e => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
  return false;
});\n`);

  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'bgmanime-cal-probe',
    version: '1.0.0',
    background: { service_worker: 'background.js' },
    content_scripts: [{
      matches: ['https://www.bilibili.com/*'],
      js: ['gm-shim.js', 'bgmanime.js'],
      run_at: 'document_start',
      all_frames: false,
    }],
    host_permissions: ['https://next.bgm.tv/*', 'https://api.bgm.tv/*', 'https://lain.bgm.tv/*'],
  }, null, 2));
}

/* ---------- 2. CDP ---------- */
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 60000);
    });
  }
}

async function boot() {
  const profile = path.join(OUT, 'profile');
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

/* ---------- 3. 断言小工具 ---------- */
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : `　→ ${JSON.stringify(detail)}`}`); }
};

const main = async () => {
  buildExt();
  const child = await boot();
  let cdp;
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    cdp = new Cdp(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: URL_TARGET });
    await sleep(12000);

    const evalJs = async expr => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
      return r.result && r.result.value;
    };
    const evalInScriptWorld = async expr => {
      const ctxs = cdp.events
        .filter(e => e.method === 'Runtime.executionContextCreated')
        .map(e => e.params.context)
        .filter(c => c.auxData && c.auxData.isDefault === false);
      for (const c of ctxs) {
        try {
          const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: c.id, returnByValue: true, awaitPromise: true });
          if (r.exceptionDetails || !r.result) continue;
          if (r.result.value !== undefined) return r.result.value;
        } catch (e) { /* 下一个 */ }
      }
      return '（隔离世界取不到）';
    };
    const shoot = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT, name);
      fs.writeFileSync(p, Buffer.from(data, 'base64'));
      return `${p}（${(fs.statSync(p).size / 1024).toFixed(0)} KB）`;
    };

    const clickSel = async sel => {
      const raw = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(!e) return 'null'; const r=e.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`);
      if (raw === 'null') return false;
      const pt = JSON.parse(raw);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      }
      return true;
    };

    console.log(`▶ 浏览器：${EDGE}`);
    console.log(`▶ 目标：${URL_TARGET}`);

    /* ---- A. tab 顺序 ---- */
    console.log('\n=== A) 分类 tab 顺序（新番表必须是第一项） ===');
    const tabs = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.bgm-mode')]
      .map(b => ({ key: b.dataset.mode, label: b.textContent.trim(), on: b.classList.contains('on') })))`));
    console.log('  tab：' + tabs.map(t => `${t.label}(${t.key})`).join(' | '));
    check('tab 总数 = 10', tabs.length === 10, tabs.length);
    check('第一项是「新番表」', tabs[0] && tabs[0].key === 'calendar' && tabs[0].label === '新番表', tabs[0]);
    check('第二项是 TV（新番表排在 tv 前面）', tabs[1] && tabs[1].key === 'tv', tabs[1]);

    /* ---- B. 点击新番表 ---- */
    console.log('\n=== B) 点击「新番表」 ===');
    check('点击成功', await clickSel('.bgm-mode[data-mode="calendar"]'));
    await sleep(3000);

    let s = JSON.parse(await evalJs(`JSON.stringify({
      active: (document.querySelector('.bgm-mode.on')||{}).dataset ? document.querySelector('.bgm-mode.on').dataset.mode : null,
      calModeClass: document.getElementById('bgm-anime-root').classList.contains('bgm-cal-mode'),
      yearsDisplay: getComputedStyle(document.querySelector('.bgm-years')).display,
      yearsH: Math.round(document.querySelector('.bgm-years').getBoundingClientRect().height),
      weeks: [...document.querySelectorAll('.bgm-week')].map(w => w.dataset.weekday),
      heads: [...document.querySelectorAll('.bgm-week-h')].map(h => h.textContent.replace(/\\s+/g,' ').trim()),
      todayBadge: document.querySelector('.bgm-week-today') ? document.querySelector('.bgm-week-today').textContent : null,
      todayElWeekday: document.querySelector('.bgm-week-today') ? document.querySelector('.bgm-week-today').closest('.bgm-week').dataset.weekday : null,
      emptyTexts: [...document.querySelectorAll('.bgm-week-empty')].map(e => e.textContent.trim()),
      cards: document.querySelectorAll('.bgm-card').length,
      imgs: [...document.querySelectorAll('.bgm-card img')].slice(0,5).map(i => i.src),
      scores: [...document.querySelectorAll('.bgm-score')].slice(0,6).map(e => e.textContent),
      tags: [...document.querySelectorAll('.bgm-tag')].slice(0,6).map(e => e.textContent),
      epsCount: document.querySelectorAll('.bgm-eps').length,
      titles: [...document.querySelectorAll('.bgm-title')].slice(0,6).map(e => e.textContent),
      foot: (document.querySelector('.bgm-cal-foot')||{}).textContent || null,
      errs: document.querySelectorAll('#bgm-anime-root .bgm-err').length,
      months: document.querySelectorAll('.bgm-month').length,
    })`));

    console.log('  ' + JSON.stringify(s, null, 2).split('\n').join('\n  '));

    check('当前分类 = calendar', s.active === 'calendar', s.active);
    check('根节点挂上 bgm-cal-mode', s.calModeClass === true);
    check('年份栏整条隐藏（display:none 且高度 0）', s.yearsDisplay === 'none' && s.yearsH === 0, { d: s.yearsDisplay, h: s.yearsH });
    check('恰好 7 个星期分组', s.weeks.length === 7, s.weeks);
    check('没有月份分组残留', s.months === 0, s.months);
    check('「今天」徽标只出现一次', s.heads.filter(h => h.includes('今天')).length === 1, s.heads);
    check('首组就是今天', s.todayElWeekday === s.weeks[0], { badge: s.todayElWeekday, first: s.weeks[0] });
    check('卡片数 > 0（真的拉到数据了）', s.cards > 0, s.cards);
    check('封面全部 https', s.imgs.length > 0 && s.imgs.every(u => u.startsWith('https://')), s.imgs);
    check('有评分徽章', s.scores.length > 0, s.scores);
    check('有 tag 徽章（p1 通路 metaTags）', s.tags.length > 0, s.tags);
    // 周历接口没有集数字段，p1 的 info 文本只覆盖 61.6%，补齐率为 0 ⇒ 整列关掉
    check('不显示集数徽章（周历无 eps 字段）', s.epsCount === 0, s.epsCount);
    check('页脚有「本周 N 部在播」', !!s.foot && /本周 \d+ 部在播/.test(s.foot), s.foot);
    check('没有加载失败区块', s.errs === 0, s.errs);

    // 空分组必须保留（而不是被 .remove()）
    check('空分组也保留（.bgm-week 恒为 7）', s.weeks.length === 7);

    // 截图：先滚回顶部再拍，留一张「新番表首屏」给人工复核
    await evalJs(`document.querySelector('.bgm-body').scrollTop = 0`);
    await sleep(400);
    const shotCal = await shoot('calendar.png');
    console.log(`  截图：${shotCal}`);

    /* ---- C. 周日序与 orderFrom 一致 ---- */
    console.log('\n=== C) 分组顺序 = orderFrom(今天) ===');
    const order = await evalInScriptWorld(`(() => { const v = window.__BGM_ANIME__; return v && v.orderFrom ? JSON.stringify({ today: v.todayWeekday(), order: v.orderFrom() }) : '取不到'; })()`);
    console.log('  orderFrom：' + order);
    if (order !== '取不到') {
      const o = JSON.parse(order);
      check('DOM 星期顺序 === orderFrom()', JSON.stringify(o.order) === JSON.stringify(s.weeks.map(Number)), { dom: s.weeks, fn: o.order });
      check('orderFrom 首元素 = 今天', o.order[0] === o.today, o);
      check('orderFrom 是 1..7 的排列', new Set(o.order).size === 7, o.order);
    }

    /* ---- D. 缓存与通路 ---- */
    console.log('\n=== D) 数据通路 / 缓存 ===');
    const net = await evalInScriptWorld(`(() => { const v = window.__BGM_ANIME__;
      if (!v) return '取不到';
      const c = v.readCalendarCache();
      return JSON.stringify({ bySource: v.netStats.bySource, errBySource: v.netStats.errBySource,
        lastErrors: v.netStats.lastErrors.slice(-3), cached: !!c, cachedSource: c && c.source }); })()`);
    console.log('  ' + net);
    if (net !== '取不到') {
      const n = JSON.parse(net);
      check('走了 p1 通路（或已缓存）', (n.bySource.p1 || 0) > 0 || n.cached, n);
      check('没有通路失败', !n.errBySource.p1 && !n.errBySource.v0, n.errBySource);
      check('周历缓存已写入', n.cached === true, n);
    }

    /* ---- E. 切回 TV，年份栏回来 ---- */
    console.log('\n=== E) 切回 TV：年份栏应恢复 ===');
    check('点击 TV', await clickSel('.bgm-mode[data-mode="tv"]'));
    await sleep(6000);
    const t = JSON.parse(await evalJs(`JSON.stringify({
      active: (document.querySelector('.bgm-mode.on')||{}).dataset.mode,
      calModeClass: document.getElementById('bgm-anime-root').classList.contains('bgm-cal-mode'),
      yearsDisplay: getComputedStyle(document.querySelector('.bgm-years')).display,
      yearsH: Math.round(document.querySelector('.bgm-years').getBoundingClientRect().height),
      weeks: document.querySelectorAll('.bgm-week').length,
      months: document.querySelectorAll('.bgm-month').length,
    })`));
    console.log('  ' + JSON.stringify(t));
    check('当前分类 = tv', t.active === 'tv', t.active);
    check('bgm-cal-mode 已摘掉', t.calModeClass === false);
    check('年份栏恢复显示', t.yearsDisplay !== 'none' && t.yearsH > 0, { d: t.yearsDisplay, h: t.yearsH });
    check('星期分组已清空', t.weeks === 0, t.weeks);
    check('月份分组已回来', t.months > 0, t.months);

    /* ---- F. 720P 顶栏：加了第 10 个 tab 之后仍然不许换行 ---- */
    console.log('\n=== F) 720P 适配（10 个 tab 挤一行） ===');
    const rowCheck = async (w, h) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
      return JSON.parse(await evalJs(`(()=>{
        const bar = document.querySelector('.bgm-modes');
        const top = document.querySelector('.bgm-top');
        const r = bar.getBoundingClientRect();
        const one = [...bar.querySelectorAll('.bgm-mode')].map(b => Math.round(b.getBoundingClientRect().top));
        return JSON.stringify({
          tabRowH: Math.round(r.height),
          rows: new Set(one).size,               // 所有 tab 的 top 相同 = 只有一行
          scrollW: bar.scrollWidth, clientW: bar.clientWidth,
          topH: Math.round(top.getBoundingClientRect().height),
          brandTxt: getComputedStyle(document.querySelector('.bgm-brand-txt')).display,
        });
      })()`));
    };
    for (const [w, h] of [[1280, 720], [1366, 768], [1024, 768], [800, 600]]) {
      const rc = await rowCheck(w, h);
      console.log(`  ${w}×${h}：tab 行数=${rc.rows} 行高=${rc.tabRowH} 横向=${rc.scrollW}/${rc.clientW} 顶栏高=${rc.topH} 品牌文字=${rc.brandTxt}`);
      check(`${w}×${h} tab 只有一行`, rc.rows === 1, rc);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    /* ---- G. 控制台错误 ---- */
    console.log('\n=== G) 控制台 / 异常 ===');
    const errs = cdp.events.filter(e =>
      (e.method === 'Runtime.exceptionThrown') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    // 过滤与本脚本无关的（B站 自己的广告/AB 上报）
    const mine = errs.filter(e => {
      const txt = JSON.stringify(e.params).slice(0, 400);
      return /bgm|__BGM_ANIME__|bgmanime/.test(txt);
    });
    console.log(`  总报错 ${errs.length} 条，其中涉及本脚本 ${mine.length} 条`);
    mine.slice(0, 5).forEach(e => console.log('   · ' + JSON.stringify(e.params).slice(0, 300)));
    check('本脚本没有抛错', mine.length === 0, mine.length);

    // 截图留档：收尾状态（TV 视图）
    console.log(`  截图：${await shoot('tv.png')}`);
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
  }

  console.log(`\n================  ${pass} 通过 / ${fail} 失败  ================`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试崩了：', e); process.exit(2); });
