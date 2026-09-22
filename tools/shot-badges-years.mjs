/**
 * shot-badges-years.mjs —— 徽章可读度 / 年份栏紧凑度 前后对比截图
 *
 * 目的：主人要求「提高 tag、评分、集数的可视度」+「年份栏改紧凑些」。
 *   这类改动光说"字号从 10 调到 11"没有意义，必须**同一块区域改动前后各截一次**用眼睛比。
 *
 * 用法：node tools/shot-badges-years.mjs <tag>        # tag 如 before / after
 * 产出：tools/.e2e-anime-out/ui-<tag>-<vp>-years.png   ← 年份栏整条
 *       tools/.e2e-anime-out/ui-<tag>-<vp>-cards.png   ← 第一行卡片（含评分/标签/集数徽章）
 *       <vp> = 720p（1280×720 · 1× DPR，主人的真实观感）｜ hi2x（1440×900 · 2× DPR，放大看细节）
 *
 * ★ 复用主 E2E 的扩展目录：里面除了 manifest 还有 gm-shim.js + background.js 的
 *   GM_xmlhttpRequest 桥（api.bgm.tv 不带 CORS 头），自己造 manifest 会一张卡都取不到。
 *
 * ★ 视口切换只需重设 Emulation.setDeviceMetricsOverride —— 页面不用重载：
 *   脚本内部有 resize 监听（会重算 --bgm-top），CSS 的 clamp()/vw 也自动重排。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(__dirname, '.e2e-anime-ext');
const OUT = path.join(__dirname, '.e2e-anime-out');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9280);
const TAG = process.argv[2] || 'shot';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEWPORTS = [
  { name: '720p', w: 1280, h: 720, dpr: 1, note: '720P · 1× DPR（真实观感）' },
  { name: 'hi2x', w: 1440, h: 900, dpr: 2, note: '1440×900 · 2× DPR（放大看细节）' },
];

if (!fs.existsSync(path.join(EXT, 'gm-shim.js')) || !fs.existsSync(path.join(EXT, 'background.js'))) {
  console.error(`❌ 找不到现成的测试扩展：${EXT}`);
  console.error('   请先跑一次主 E2E（它会构建扩展）：node tools/e2e-anime-cdp.mjs');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));

const profile = path.join(OUT, 'profile-ui');
fs.rmSync(profile, { recursive: true, force: true });

const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', `--remote-debugging-port=${PORT}`, `--remote-allow-origins=*`,
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank'], { stdio: 'ignore' });

let ws;
const jobs = [];
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* 未就绪 */ }
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error('浏览器未就绪');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0; const P = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; P.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (P.has(i)) { P.delete(i); rej(new Error(method + ' 超时')); } }, 60000);
  }).then(m => { if (m.error) throw new Error(`${method} 失败：${m.error.message}`); return m; });

  /** 页面世界求值（DOM 两世界共享，查 DOM 用它就够） */
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面世界求值异常：' + r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable'); await send('Runtime.enable');
  const v0 = VIEWPORTS[0];
  await send('Emulation.setDeviceMetricsOverride',
    { width: v0.w, height: v0.h, deviceScaleFactor: v0.dpr, mobile: false });
  await send('Page.navigate', { url: 'https://www.bilibili.com/anime/' });
  await sleep(12000);

  // 就绪判定只看 DOM：页面世界里 window.__BGM_ANIME__ 永远是 undefined（隔离世界）
  if (!(await ev(`!!document.querySelector('.bgm-mode[data-mode="tv"]')`))) {
    throw new Error('脚本未注入（12s 内没出 .bgm-mode）');
  }
  await ev(`document.querySelector('.bgm-mode[data-mode="tv"]').click()`);
  await sleep(10000);

  console.log(`\nUI 前后对比截图 · tag = ${TAG}`);
  console.log('='.repeat(76));

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr, mobile: false });
    await sleep(1500);   // 等 resize 处理（--bgm-top 重算）+ CSS 重排

    // 两种裁剪区：年份栏整条 / 第一行卡片（含徽章）
    const clip = JSON.parse(await ev(`JSON.stringify((() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = el => { const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const clamp = a => ({ x: Math.max(0, Math.min(vw, a.x)), y: Math.max(0, Math.min(vh, a.y)),
        w: Math.max(1, Math.min(vw - Math.max(0, a.x), a.w)),
        h: Math.max(1, Math.min(vh - Math.max(0, a.y), a.h)) });

      const yearsEl = document.querySelector('.bgm-years');
      const years = yearsEl ? clamp(r(yearsEl)) : null;

      // 第一行卡片：取前 4 张卡的并集，底部留出标题/日期（+46 CSS px）
      const cards = [...document.querySelectorAll('.bgm-card')].slice(0, 4);
      let cardsBox = null;
      if (cards.length) {
        const bs = cards.map(c => c.getBoundingClientRect());
        const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
        const x2 = Math.max(...bs.map(b => b.x + b.width)), y2 = Math.max(...bs.map(b => b.y + b.height));
        cardsBox = clamp({ x: Math.floor(x) - 4, y: Math.floor(y) - 4,
          w: Math.ceil(x2 - x) + 8, h: Math.ceil(y2 - y) + 8 });
      }
      // 年份栏量化的"紧凑度"指标：整条高 + 单 chip 高 + 是否溢出
      const chip = document.querySelector('.bgm-year');
      const yin = document.querySelector('.bgm-years-in');
      const cs = chip ? getComputedStyle(chip) : null;
      const ys = yin ? getComputedStyle(yin) : null;
      return { years, cards: cardsBox,
        meter: { yearsBarH: years ? years.h : null,
                 chipH: chip ? Math.round(chip.getBoundingClientRect().height) : null,
                 chipFont: cs ? cs.fontSize : null,
                 chipPad: cs ? cs.padding : null,
                 rowPad: ys ? ys.padding : null,
                 gap: ys ? ys.gap : null,
                 overflow: yin ? (yin.scrollWidth > yin.clientWidth) : null,
                 overflowPx: yin ? yin.scrollWidth - yin.clientWidth : null,
                 yearN: document.querySelectorAll('.bgm-year').length } };
    })())`));

    const m = clip.meter;
    console.log(`\n[${vp.name}] ${vp.note}`);
    console.log(`  年份栏：高 ${m.yearsBarH}px ｜ chip 高 ${m.chipH}px · 字号 ${m.chipFont} · padding ${m.chipPad}`);
    console.log(`         行 padding ${m.rowPad} · gap ${m.gap} ｜ ${m.yearN} 个 chip ｜ `
      + (m.overflow ? `溢出 ${m.overflowPx}px（需横向滚动）` : '一行放得下 ✅'));

    const full = path.join(OUT, `ui-${TAG}-${vp.name}-full.png`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(full, Buffer.from(shot.result.data, 'base64'));

    for (const kind of ['years', 'cards']) {
      if (!clip[kind]) { console.log(`  ⚠️ ${kind} 未取到裁剪区`); continue; }
      const dest = path.join(OUT, `ui-${TAG}-${vp.name}-${kind}.png`);
      jobs.push({ full, clip: clip[kind], out: dest, dpr: vp.dpr, vw: vp.w,
        label: `${TAG} · ${vp.name} · ${kind}` });
      console.log(`  → ${path.basename(dest)}`);
    }
  }

  // 裁剪：新无头模式下 Page.captureScreenshot 不接受 clip（Invalid parameters）⇒ 全视口截图 + Pillow 裁
  fs.writeFileSync(path.join(OUT, `ui-${TAG}-clips.json`), JSON.stringify(jobs, null, 1));
  const py = process.env.PYTHON || 'C:/Users/ASUS/.workbuddy/binaries/python/versions/3.13.12/python.exe';
  const code = `
import json
from PIL import Image
OUT = r"${OUT}"
d = json.load(open(r"${path.join(OUT, `ui-${TAG}-clips.json`)}", encoding="utf-8"))
for it in d:
    img = Image.open(it["full"])
    k = img.width / float(it["vw"])          # 实际缩放 = 图宽 / 视口 CSS 宽
    c = it["clip"]
    box = (round(c["x"]*k), round(c["y"]*k),
           round((c["x"]+c["w"])*k), round((c["y"]+c["h"])*k))
    im = img.crop(box)
    if it.get("dpr") == 2 and it["out"].endswith("-years.png"):
        im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)   # 年份栏太长，2× 缩回显示宽
    im.save(it["out"])
    print("  裁剪", it["out"].split(chr(92))[-1], "->", (im.width, im.height), "px  源box", box)
`;
  execFileSync(py, ['-c', code], { encoding: 'utf8', stdio: 'inherit' });

  console.log(`\n输出目录：${OUT}`);
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  child.kill();
}
