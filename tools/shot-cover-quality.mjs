/**
 * shot-cover-quality.mjs —— 封面质量对比截图
 *
 * 目的：主人说「改成最低档我看看」⇒ 光给字节数不够，要能**直接用眼睛比**。
 *   依次把 cfg.coverQuality 设成 100 / 200 / 400 / 800，各截同一块卡片区域，
 *   并同时报告该档封面图的真实字节数。
 *
 * ★ 关键一：截图必须用 deviceScaleFactor = 2（模拟 2× 高分屏）。
 *   卡片列宽 132 CSS px ⇒ 2× 屏上占 264 物理 px：
 *     r100 → 放大 2.64×（明显糊）｜ r200 → 放大 1.32×（略糊）｜ r400 → 0.66×（清晰）
 *   在 1× 屏上 r100 与 r400 差别很小，看不出结论，这个脚本刻意模拟高分屏。
 *
 * ★ 关键二：改 cfg / 调 renderYear **必须走隔离世界**（见 evalInScriptWorld）。
 *   内容脚本与页面是两个 JS 上下文：页面世界里 `window.__BGM_ANIME__` 永远是 undefined，
 *   直接写 `window.__BGM_ANIME__.cfg.coverQuality = 100` 会**静默失败**（不抛错、什么也没改）。
 *   DOM 查询（`.bgm-card img`）反而用页面世界就行 —— DOM 两世界共享。
 *
 * 用法：node tools/shot-cover-quality.mjs [year] [month]
 * 产出：tools/.e2e-anime-out/cover-q{100,200,400,800}.png
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
const PORT = Number(process.env.CDP_PORT || 9270);
const YEAR = Number(process.argv[2] || 2026);
const MONTH = Number(process.argv[3] || 7);
const TIERS = [100, 200, 400, 800];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ⚠️ 必须复用主 E2E 建好的扩展目录，**不能自己造 manifest**：
//    真正的扩展里还有 gm-shim.js + background.js 的 GM_xmlhttpRequest 桥（api.bgm.tv 无 CORS 头），
//    少了它页面取不到数据 ⇒ 一张卡都没有。这是本项目第二次踩这个坑（第一次在 diag-attribution.mjs）。
if (!fs.existsSync(path.join(EXT, 'gm-shim.js')) || !fs.existsSync(path.join(EXT, 'background.js'))) {
  console.error(`❌ 找不到现成的测试扩展：${EXT}`);
  console.error('   请先跑一次主 E2E（它会构建扩展）：node tools/e2e-anime-cdp.mjs');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'bili-anime-replace.user.js'), path.join(EXT, 'bgmanime.js'));

const profile = path.join(OUT, 'profile-shot');
fs.rmSync(profile, { recursive: true, force: true });

const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank'], { stdio: 'ignore' });

let ws;
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

  let id = 0; const P = new Map(); const events = [];
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); return; }
    if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; P.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (P.has(i)) { P.delete(i); rej(new Error(method + ' 超时')); } }, 60000);
  }).then(m => { if (m.error) throw new Error(`${method} 失败：${m.error.message}`); return m; });

  /** 页面世界求值（DOM 查询用这个就够 —— DOM 是两世界共享的） */
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面世界求值异常：' + r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  /**
   * 隔离世界求值 —— 内容脚本的 window 在这里。
   * 重载后 context 会重建，所以每次都从事件流里现取；取不到就抛（不静默兜底，
   * 否则「设置没生效」会被伪装成「功能正常」）。
   */
  const evalInScriptWorld = async expr => {
    const ctxs = events
      .filter(e => e.method === 'Runtime.executionContextCreated')
      .map(e => e.params.context)
      .filter(c => c.auxData && c.auxData.isDefault === false);
    for (const c of ctxs) {
      try {
        const r = await send('Runtime.evaluate', {
          expression: expr, contextId: c.id, returnByValue: true, awaitPromise: true,
        });
        if (r.result && r.result.exceptionDetails) continue;
        const v = r.result && r.result.result ? r.result.result.value : undefined;
        if (v !== undefined) return v;
      } catch { /* 换下一个上下文 */ }
    }
    throw new Error('隔离世界求值失败（取不到内容脚本的上下文）');
  };

  await send('Page.enable'); await send('Runtime.enable');
  // ★ 2× DPR：模拟高分屏，否则 r100 与 r400 肉眼分不出
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'https://www.bilibili.com/anime/' });
  await sleep(12000);

  // ⚠️ 就绪判定只看 DOM，**不要**带上 window.__BGM_ANIME__（页面世界永远 undefined，
  //    会把「脚本已注入」误判成未注入 —— 这个坑本次连踩两次）
  const injected = await ev(`!!document.querySelector('.bgm-mode[data-mode="tv"]')`);
  if (!injected) throw new Error('脚本未注入（页面 12s 内没出 .bgm-mode）');

  await ev(`document.querySelector('.bgm-mode[data-mode="tv"]').click()`);
  await sleep(10000);

  console.log(`\n封面质量对比（${YEAR} 年 ${MONTH} 月 · 2× DPR 模拟 · 卡片列宽 132 CSS px）`);
  console.log('='.repeat(78));
  console.log('  ' + '档位'.padEnd(9) + 'URL 档位段'.padEnd(13) + '实测字节'.padEnd(12)
    + '首张原始像素'.padEnd(14) + '加载');
  const rows = [];
  const clips = [];
  for (const q of TIERS) {
    // 只改内存里的 cfg（不 saveCfg），避免污染配置；改完强制重渲染
    await evalInScriptWorld(`(window.__BGM_ANIME__.cfg.coverQuality = ${q}, window.__BGM_ANIME__.renderYear(), 'ok')`);
    await sleep(8000);                             // 等图片按新档位加载

    const stat = JSON.parse(await ev(`JSON.stringify((() => {
      const imgs = [...document.querySelectorAll('.bgm-card img')];
      const one = imgs[0];
      const u = one ? (one.currentSrc || one.src) : '';
      const m = String(u).match(/\\/r\\/(\\d+)(?:x\\d+)?\\//);
      return { n: imgs.length, tier: m ? 'r' + m[1] : (u ? '原图' : '(无)'), url: u,
               nat: one ? (one.naturalWidth + '×' + one.naturalHeight) : '-',
               loaded: !!(one && one.complete && one.naturalWidth > 0) };
    })())`));

    // 真实字节数（node 侧拉一次，与页面缓存无关）
    let bytes = '-';
    if (stat.url) {
      try {
        const rr = await fetch(stat.url, { headers: { 'User-Agent': 'Mozilla/5.0 bili-bgm-overlay-shot' } });
        if (rr.ok) bytes = ((await rr.arrayBuffer()).byteLength / 1024).toFixed(1) + ' KB';
      } catch { /* 忽略 */ }
    }

    const clip = JSON.parse(await ev(`JSON.stringify((() => {
      const b = document.querySelector('.bgm-body');
      if (b) b.scrollTop = 0;
      const g = document.querySelector('.bgm-grid');
      if (!g) return null;
      const r = g.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const x = Math.max(0, Math.min(vw, Math.round(r.x)));
      const y = Math.max(0, Math.min(vh, Math.round(r.y)));
      // 同时取「第一张卡的封面」矩形，供事后拼单卡四档对照图
      const c0 = document.querySelector('.bgm-card .bgm-cover');
      const cr = c0 ? c0.getBoundingClientRect() : null;
      return { x, y,
        width: Math.max(40, Math.min(vw - x, Math.min(460, Math.round(r.width)))),
        height: Math.max(40, Math.min(vh - y, 300)),
        card: cr ? { x: Math.round(cr.x), y: Math.round(cr.y),
                     width: Math.round(cr.width), height: Math.round(cr.height) } : null };
    })())`));

    let full = null, clipFile = null;
    if (clip && clip.width > 0 && clip.height > 0) {
      // ⚠️ new-headless 下 Page.captureScreenshot **不接受 clip**（报 Invalid parameters，
      //    本仓库的 E2E 也都是无参调用）⇒ 先截全视口，再用 Pillow 裁。
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      full = path.join(OUT, `cover-full-q${q}.png`);
      fs.writeFileSync(full, Buffer.from(shot.result.data, 'base64'));
      clipFile = path.join(OUT, `cover-q${q}.png`);
      clips.push({ q, full, out: clipFile, clip });
    } else {
      console.log(`  ⚠️ r${q} 未取到有效裁剪区（clip=${JSON.stringify(clip)}）`);
    }
    rows.push({ q, stat, bytes, full, clipFile });
    console.log('  ' + String('r' + q).padEnd(9) + String(stat.tier).padEnd(13)
      + bytes.padEnd(12) + String(stat.nat).padEnd(14)
      + `${stat.loaded ? '✅' : '❌'}  （${stat.n} 张 img）`);
  }

  // 裁剪：CSS px → 物理 px 乘 DPR（本脚本固定 2）
  if (clips.length) {
    fs.writeFileSync(path.join(OUT, 'cover-clips.json'), JSON.stringify(clips, null, 1));
    const py = process.env.PYTHON || 'C:/Users/ASUS/.workbuddy/binaries/python/versions/3.13.12/python.exe';
    const code = `
import json
from PIL import Image, ImageDraw
OUT = r"${OUT}"
d = json.load(open(r"${path.join(OUT, 'cover-clips.json')}", encoding="utf-8"))

# ① 每档裁出「整块卡片区」（460×300 CSS）
for item in d:
    img = Image.open(item["full"])
    cl = item["clip"]
    k = img.width / 1440.0                    # 实际缩放 = 图宽 / 视口 CSS 宽（本脚本 DPR=2）
    box = (round(cl["x"]*k), round(cl["y"]*k),
           round((cl["x"]+cl["width"])*k), round((cl["y"]+cl["height"])*k))
    img.crop(box).save(item["out"])
    print("  裁剪", item["out"].split(chr(92))[-1], box, "->", (box[2]-box[0], box[3]-box[1]), "px")

# ② 同一张卡 × 4 档，纵向拼成一张对照图
#    ⚠️ Py3 的生成器表达式有自己的作用域，**不会**回写外层的 im ——
#       写成 max(im.width for _, im in cards) 之后再读 im.height 拿到的是全图高度（曾拼出 446x7250）。
#       所以先把宽高各自 max 出来，别依赖那个泄漏的变量。
pairs = []
for item in d:
    cd = item["clip"].get("card")
    if not cd:
        continue
    img = Image.open(item["full"])
    k = img.width / 1440.0
    box = (round(cd["x"]*k), round(cd["y"]*k),
           round((cd["x"]+cd["width"])*k), round((cd["y"]+cd["height"])*k))
    pairs.append((item["q"], img.crop(box)))
if len(pairs) >= 2:
    pad = 10
    w = max(c.width for _, c in pairs)
    h = pad + sum(c.height + pad for _, c in pairs)
    canvas = Image.new("RGB", (pad + 140 + w + pad, h), (250, 250, 250))
    dr = ImageDraw.Draw(canvas)
    y = pad
    for q, c in pairs:
        canvas.paste(c.convert("RGB"), (pad + 140, y))
        dr.text((pad + 6, y + c.height // 2 - 12), "coverQuality", fill=(60, 60, 60))
        dr.text((pad + 6, y + c.height // 2 + 2), "= " + str(q), fill=(180, 40, 40))
        y += c.height + pad
    dest = OUT + chr(92) + "cover-compare.png"
    canvas.save(dest)
    print("  拼合 cover-compare.png ->", canvas.size)
`;
    try {
      const out = execFileSync(py, ['-c', code], { encoding: 'utf8' });
      process.stdout.write(out);
    } catch (e) {
      console.log('  ⚠️ 裁剪失败（'.concat(String(e.message).split('\n')[0], '）—— 全图已保存，可自行放大看'));
    }
  }

  console.log('\n截图（2× DPR 宽高，同一区域，可直接叠着看）：');
  console.log('  cover-compare.png  ← ★ 同一张卡 × 4 档，一眼看出差距');
  for (const r of rows) if (r.clipFile) console.log(`  ${path.basename(r.clipFile)}  ← coverQuality = ${r.q}（整块卡片区）`);
  for (const r of rows) if (r.full) console.log(`  ${path.basename(r.full)}  （全视口原图）`);
  console.log(`\n输出目录：${OUT}`);
  console.log('提示：同一张图 r100 与 r400 的差别，在这几张 PNG 上最直观 —— r100 会明显发虚。');
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  child.kill();
}
