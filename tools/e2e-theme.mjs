/**
 * 主题专项端到端验证（真实 B站 页面 + 真实油猴脚本注入）。
 *
 * 验证三件事：
 *   ① 主题判定信号链：官方 link(#__css-map__) / B站 语义变量亮度 / dark 标记 / 系统偏好
 *   ② 把 B站 的主题 CSS 真的从 light.css 换成 dark.css（= 用户点「主题： 深色」做的事）
 *      → 我们的页面必须跟着变（html.bgm-dark + --bg/--card 变量变深 + 截图肉眼可辨）
 *   ③ 顶栏头像弹层状态行：插进 .links-item、排在 B站 自己「主题： 」那条之后、点它开设置
 *      ⚠️ 未登录时 B站 不渲染该面板 ⇒ 这里**造一个符合 B站 CSS 契约的容器**当桩，
 *        验证的是我们这段注入逻辑本身（幂等 / 位置 / 文案 / 主题跟随）。
 *
 * 用法：CDP_PORT=9225 node tools/e2e-theme.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modeColor, pixelAt, sizeOf } from './png-pixel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(__dirname, '.e2e-anime-ext');
const OUT = path.join(__dirname, '.e2e-anime-out');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9225);
const TARGET = 'https://www.bilibili.com/anime/';
const DARK_CSS = 'https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/dark.css';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot() {
  const profile = path.join(OUT, 'profile-theme-e2e');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,1200', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return child; } catch {}
    await sleep(500);
  }
  throw new Error('CDP 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
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

/* 一次性读全部观测量（含判定信号链的中间量）。
   ⚠️ 不要读 window.__BGM_ANIME__：油猴沙箱/隔离世界的 window 与页面 window 不是同一个，
      这里断言的对象必须是 **DOM 与计算样式**（脚本真正的输出），不是它的内部变量。 */
const SNAP = `JSON.stringify((() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, k) => (n == null ? '(空)' : n.getPropertyValue(k).trim() || '(空)');
  const root = document.getElementById('bgm-anime-root');
  const rcs = root ? getComputedStyle(root) : null;
  const link = document.getElementById('__css-map__') || document.querySelector('link[href*="bili-theme/"]');
  const btn = document.getElementById('bgm-theme-btn');
  return {
    themeLink: link ? (link.getAttribute('href') || '').slice(-30) : '(无)',
    htmlClasses: document.documentElement.className,
    themeAttr: document.documentElement.dataset.bgmTheme || '(无)',
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    biliVars: { bg1: v(cs, '--bg1'), bg2: v(cs, '--bg2'), text1: v(cs, '--text1') },
    ourVars: { bg: v(cs, '--bgm-bg'), card: v(cs, '--card'), text: v(cs, '--text') },
    rootBg: rcs ? rcs.backgroundColor : '(无 root)',
    rootColor: rcs ? rcs.color : '(无 root)',
    themeBtn: btn ? btn.textContent : '(无按钮)',
    themeBtnTitle: btn ? btn.title : '',
    cards: document.querySelectorAll('.bgm-card').length,
    tagChips: document.querySelectorAll('.bgm-tag').length,
    emptyTagCards: [...document.querySelectorAll('.bgm-card')].filter(c => !c.querySelector('.bgm-tag')).length,
    sampleTags: [...document.querySelectorAll('.bgm-card')].slice(0, 6).map(c =>
      [...c.querySelectorAll('.bgm-tag')].map(t => t.textContent).join('+')),
    statusRow: (() => {
      const n = document.getElementById('bgm-anime-status-item');
      if (!n) return '(未注入)';
      return { text: n.textContent.trim(), cls: n.className, id: n.id,
        prevSibling: (n.previousElementSibling || {}).textContent || '(无)' };
    })(),
  };
})())`;

const main = async () => {
  /* 真像素判据：① 我们顶栏那一条带（y72~112）的底色；② 全图稀疏采样的暗像素占比。
     计算样式说"深色"不代表画出来是深色 —— 必须验像素（本项目就靠截图抓到过浮层透明）。 */
  const bgBand = buf => modeColor(buf, 800, 72, 1100, 112);
  const darkShare = buf => {
    const { w, h } = sizeOf(buf);
    let d = 0, n = 0;
    for (let y = 0; y < h; y += 24) for (let x = 0; x < w; x += 24) {
      n++;
      const p = pixelAt(buf, x, y);
      if (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b < 128) d++;
    }
    return +(d / n).toFixed(2);
  };

  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('先跑一次 tools/e2e-anime.mjs 生成临时扩展');
    process.exit(1);
  }
  fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));
  const child = await boot();
  const fails = [];
  const ok = (cond, label, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
    if (!cond) fails.push(label);
  };
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(9000);
    const ev = async expr => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
    const snap = async () => JSON.parse(await ev(SNAP));

    console.log('\n=== ① B站 默认（浅色）下的判定链 ===');
    let s = await snap();
    console.log(JSON.stringify({ themeLink: s.themeLink, htmlClasses: s.htmlClasses, themeAttr: s.themeAttr,
      prefersDark: s.prefersDark, biliVars: s.biliVars, ourVars: s.ourVars, rootBg: s.rootBg }, null, 1));
    ok(s.themeLink.includes('light'), '主题 CSS 是 light.css');
    ok(/bgm-light/.test(s.htmlClasses), 'html 带 bgm-light');
    ok(s.themeAttr === 'light', 'data-bgm-theme=light（暴露给外部工具的 DOM 信号）');
    ok(!/bgm-forced/.test(s.htmlClasses), '默认不是强制模式');
    ok(/^#f/i.test(s.ourVars.bg), '我们的 --bgm-bg 是浅色', s.ourVars.bg);
    ok(s.rootBg === 'rgb(246, 247, 248)', '内容区底色已落地（B站 --bg2）', s.rootBg);

    console.log('\n=== ② 卡片与 tag 渲染（顺带回归） ===');
    console.log(JSON.stringify({ cards: s.cards, tagChips: s.tagChips, emptyTagCards: s.emptyTagCards,
      sampleTags: s.sampleTags }, null, 1));
    ok(s.cards > 0, '卡片已渲染', `${s.cards} 张`);
    ok(s.tagChips > 0, 'tag 有渲染', `${s.tagChips} 个`);
    ok(s.emptyTagCards / Math.max(s.cards, 1) < 0.12, '无 tag 卡片占比 < 12%（二级+三级白名单）',
      `${s.emptyTagCards}/${s.cards}`);

    await cdp.send('Page.captureScreenshot'); await sleep(250);   // 先踢一帧，避免抓到旧帧
    const shotLight = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const bufLight = Buffer.from(shotLight.data, 'base64');
    fs.writeFileSync(path.join(OUT, 'theme-light.png'), bufLight);
    const bandL = bgBand(bufLight), shareL = darkShare(bufLight);
    console.log(`  像素：顶栏带 ${JSON.stringify(bandL)}　暗像素占比 ${shareL}`);
    ok(bandL.r > 200, '浅色·真像素：我们顶栏底色是浅色', `rgb(${bandL.r},${bandL.g},${bandL.b}) ratio ${bandL.ratio}`);
    ok(shareL < 0.35, '浅色·真像素：整页暗像素占比 < 35%', String(shareL));

    console.log('\n=== ③ 模拟用户在 B站 切到「深色」：把主题 CSS 换成 dark.css ===');
    await ev(`(() => {
      const l = document.getElementById('__css-map__');
      if (l) l.setAttribute('href', ${JSON.stringify(DARK_CSS)});
      return !!l;
    })()`);
    await sleep(2500);
    s = await snap();
    console.log(JSON.stringify({ themeLink: s.themeLink, htmlClasses: s.htmlClasses, themeAttr: s.themeAttr,
      biliVars: s.biliVars, ourVars: s.ourVars, rootBg: s.rootBg, rootColor: s.rootColor,
      themeBtn: s.themeBtn, themeBtnTitle: s.themeBtnTitle }, null, 1));
    ok(s.themeLink.includes('dark'), '主题 CSS 已换成 dark.css');
    ok(s.themeAttr === 'dark' && /bgm-dark/.test(s.htmlClasses), '判定翻转为深色（DOM 信号）');
    ok(!/^#f/i.test(s.ourVars.bg) && s.ourVars.bg !== '(空)', '我们的 --bgm-bg 跟着变深', s.ourVars.bg);
    ok(s.rootBg === 'rgb(16, 16, 17)', '内容区底色 = B站 深色 --bg2', s.rootBg);
    ok(s.themeBtn === '◐', '顶栏主题按钮仍显示「跟随」', s.themeBtn);
    ok(/深色/.test(s.themeBtnTitle), '按钮 hint 已更新为深色', s.themeBtnTitle);
    const shotDark = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const bufDark = Buffer.from(shotDark.data, 'base64');
    fs.writeFileSync(path.join(OUT, 'theme-dark.png'), bufDark);
    const bandD = bgBand(bufDark), shareD = darkShare(bufDark);
    console.log(`  像素：顶栏带 ${JSON.stringify(bandD)}　暗像素占比 ${shareD}`);
    ok(bandD.r < 60, '深色·真像素：我们顶栏底色确实变深', `rgb(${bandD.r},${bandD.g},${bandD.b})`);
    ok(shareD > 0.6, '深色·真像素：整页暗像素占比 > 60%', String(shareD));

    console.log('\n=== ④ 切回浅色（验证双向 + 观察器是否真的在听） ===');
    await ev(`document.getElementById('__css-map__').setAttribute('href', 'https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/light.css')`);
    await sleep(2500);
    s = await snap();
    ok(s.themeAttr === 'light' && /bgm-light/.test(s.htmlClasses), '切回浅色成功', s.ourVars.bg);

    console.log('\n=== ⑤ 顶栏头像弹层状态行（用符合 B站 CSS 契约的容器当桩） ===');
    const before = await ev(`(() => {
      /* 桩：B站 登录后渲染的面板结构 + 它自己的「主题： 浅色」那条 */
      const hdr = document.querySelector('.bili-header') || document.body;
      const pop = document.createElement('div');
      pop.className = 'avatar-panel-popover';
      pop.dataset.bgmFloat = '';                      // 免得被接管时的隐藏规则藏掉
      pop.innerHTML = '<div class="links-item">'
        + '<div class="single-link-item" id="stub-personal"><div class="link-title"><span>个人中心</span></div></div>'
        + '<div class="single-link-item" id="stub-theme"><div class="link-title"><span>主题： 浅色</span></div></div>'
        + '</div>';
      hdr.appendChild(pop);
      return !!document.querySelector('.avatar-panel-popover .links-item');
    })()`);
    ok(before, 'B站 面板桩已就位');
    await sleep(2600);      // 等我们的观察器 + 2s 兜底 tick 跑过
    s = await snap();
    console.log('  状态行：' + JSON.stringify(s.statusRow));
    ok(s.statusRow !== '(未注入)', '状态行已注入 B站 面板');
    if (s.statusRow !== '(未注入)') {
      ok(/已接管/.test(s.statusRow.text), '状态行文案含「已接管」', s.statusRow.text);
      ok(/浅色|深色/.test(s.statusRow.text), '状态行带主题状态');
      ok(s.statusRow.prevSibling.includes('主题'), '排在 B站「主题：」那条之后', s.statusRow.prevSibling.trim());
      ok(/single-link-item/.test(s.statusRow.cls), '沿用 B站 原生 class（配色自动跟随）');
    }
    /* 幂等：再等两轮 tick，仍然只有一条 */
    await sleep(2600);
    const n = await ev(`document.querySelectorAll('#bgm-anime-status-item').length`);
    ok(n === 1, '注入幂等（重复 tick 不叠加）', `找到 ${n} 条`);

    /* 深色下状态行文字应跟着变 */
    await ev(`document.getElementById('__css-map__').setAttribute('href', ${JSON.stringify(DARK_CSS)})`);
    await sleep(2000);
    const darkStatus = await ev(`(document.getElementById('bgm-anime-status-item')||{}).textContent || ''`);
    ok(/深色/.test(darkStatus), '状态行主题文字随 B站 切换更新', darkStatus.trim());

    console.log('\n=== ⑥ 强制深色：B站 仍是浅色，我们的页面必须独立变深（绕开桥接） ===');
    /* 配置键前缀要从实际存在的键里探出来：测试替身 gm-shim 自己又加了一层 'bgmanime:' 前缀，
       所以真实键是 'bgmanime:bgmanime:cfg'（真 Tampermonkey 里根本不落 localStorage，不构成问题） */
    const prefix = await ev(`(() => {
      const k = Object.keys(localStorage).find(k => /cacheKeys$/.test(k)) || 'bgmanime:bgmanime:cacheKeys';
      return k.replace(/cacheKeys$/, '');
    })()`);
    const cfgKey = prefix + 'cfg';
    console.log('  配置键：' + cfgKey);
    await ev(`localStorage.setItem(${JSON.stringify(cfgKey)}, JSON.stringify({ theme: 'dark' }))`);
    await cdp.send('Page.navigate', { url: TARGET });
    await sleep(9000);
    s = await snap();
    console.log(JSON.stringify({ themeLink: s.themeLink, htmlClasses: s.htmlClasses, themeAttr: s.themeAttr,
      biliBg2: s.biliVars.bg2, ourBg: s.ourVars.bg, rootBg: s.rootBg, themeBtn: s.themeBtn }, null, 1));
    ok(s.themeLink.includes('light'), '前提成立：B站 侧仍是浅色');
    ok(/bgm-forced/.test(s.htmlClasses) && s.themeAttr === 'dark', '强制深色生效（bgm-forced + data-bgm-theme=dark）');
    ok(s.rootBg === 'rgb(23, 24, 26)', '内容区独立变深（不被 B站 浅色变量覆盖）', s.rootBg);
    ok(s.themeBtn === '☾', '顶栏按钮显示 ☾', s.themeBtn);
    ok(s.cards > 0, '强制模式下卡片仍正常渲染', `${s.cards} 张`);

    console.log('\n=== 页面未捕获异常 ===');
    const own = cdp.errors.filter(e => !/hdslb\.com|COLS: response timeout|log-reporter/i.test(e));
    console.log(`  全部 ${cdp.errors.length} 条；其中宿主 B站 自身的 ${cdp.errors.length - own.length} 条（log-reporter 的 COLS timeout，非本脚本）`);
    if (own.length) console.log('  本脚本相关：\n   ' + own.slice(0, 4).join('\n   '));
    ok(own.length === 0, '无来自本脚本的未捕获异常');

    console.log(`\n截图：${path.relative(ROOT, path.join(OUT, 'theme-light.png'))} / theme-dark.png`);
    console.log(fails.length ? `\n❌ 失败 ${fails.length} 项：${fails.join('；')}` : '\n✅ 全部通过');
    child.kill();
    process.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('执行失败：', e.message);
    child.kill();
    process.exit(1);
  }
};
main();
