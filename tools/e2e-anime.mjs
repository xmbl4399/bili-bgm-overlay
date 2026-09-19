/**
 * 端到端验证：把「B站番剧区替换」脚本注入真实 www.bilibili.com/anime/ 页面。
 *
 * 关键点：p1 / v0 接口都不带 CORS 头，页面内 fetch 必失败 ——
 * 所以扩展必须实现 GM_xmlhttpRequest 的**真实**语义：由 background 发请求。
 * 这里用 MV3 service worker + runtime.sendMessage 桥接，等价于 Tampermonkey 的做法。
 *
 * 用法：node tools/e2e-anime.mjs [url] [--budget=40000]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(__dirname, '.e2e-anime-ext');
const OUT = path.join(__dirname, '.e2e-anime-out');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--')) || 'https://www.bilibili.com/anime/';
const budget = Number((args.find(a => a.startsWith('--budget=')) || '--budget=40000').split('=')[1]);

/* ---------- 1. 生成临时扩展 ---------- */
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
    const fail = (m) => { if (done) return; done = true; console.debug('[gm-xhr-fail] ' + m + ' :: ' + opts.url); opts.onerror && opts.onerror(new Error(m)); };
    try {
      chrome.runtime.sendMessage({ type: 'gm-xhr', url: opts.url, method: opts.method || 'GET' }, r => {
        if (done) return;
        if (chrome.runtime.lastError || !r) return fail('bridge error');
        if (r.error) return fail(r.error);
        done = true;
        console.debug('[gm-xhr-ok] ' + r.status + ' ' + opts.url);
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
  name: 'bgmanime-e2e-probe',
  version: '1.0.0',
  background: { service_worker: 'background.js' },
  content_scripts: [{
    matches: ['https://www.bilibili.com/*'],
    js: ['gm-shim.js', 'bgmanime.js'],
    run_at: 'document_start',
    all_frames: false,
  }],
  host_permissions: [
    'https://next.bgm.tv/*',
    'https://api.bgm.tv/*',
    'https://lain.bgm.tv/*',
  ],
}, null, 2));

/* ---------- 2. 跑无头 Edge ---------- */
const slug = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const domFile = path.join(OUT, `${slug}.dom.html`);
const shot = path.join(OUT, `${slug}.png`);
[domFile, shot].forEach(f => fs.rmSync(f, { force: true }));

const profile = path.join(OUT, 'profile');
fs.rmSync(profile, { recursive: true, force: true });

const common = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1300',
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--virtual-time-budget=${budget}`,
];

console.log(`▶ 目标：${url}`);
console.log(`▶ 注入：bili-anime-replace.user.js（含 GM_xhr 背景页桥接）`);

const res = spawnSync(EDGE, [...common, '--enable-logging=stderr', '--v=1', '--dump-dom', url], {
  encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024,
});
const dom = res.stdout || '';
const stderrLog = res.stderr || '';
fs.writeFileSync(domFile, dom, 'utf8');
fs.writeFileSync(path.join(OUT, 'console.log'), stderrLog, 'utf8');

/* 第二遍复用同 profile（缓存生效）出图 */
spawnSync(EDGE, [...common, `--screenshot=${shot}`, url], { stdio: 'ignore', timeout: 240000 });

/* ---------- 3. 页面内日志 ---------- */
const lines = stderrLog.split(/\r?\n/).filter(l => /bgm|gm-xhr/i.test(l));
console.log(`\n=== 页面内日志（${lines.length} 行，取前 40）===`);
lines.slice(0, 40).forEach(l => console.log('  ' + l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 240)));

/* ---------- 4. DOM 统计 ---------- */
const count = (re) => [...dom.matchAll(re)].length;
const grab = (re, n = 10) => [...dom.matchAll(re)].slice(0, n).map(m => m[1]);

const takeover = /<html[^>]*class="[^"]*bgm-takeover/.test(dom);
const rootExist = /id="bgm-anime-root"/.test(dom);
const modes = grab(/class="bgm-mode[^"]*"[^>]*>([^<]*)</g, 6);
const years = grab(/class="bgm-year[^"]*"[^>]*data-year="(\d+)"/g, 8);
const months = grab(/class="bgm-month"[^>]*data-month="(\d+)"/g, 14);
const monthHeads = grab(/class="bgm-month-h"[^>]*><span>([^<]*)<\/span><em>([^<]*)<\/em>/g, 0);
const headTexts = [...dom.matchAll(/class="bgm-month-h"[^>]*>(?:<span[^>]*>([^<]*)<\/span>)?(?:<em[^>]*>([^<]*)<\/em>)?/g)]
  .slice(0, 14).map(m => `${m[1] || ''} ${m[2] || ''}`.trim()).filter(Boolean);
const cards = count(/class="bgm-card"/g);
const scores = grab(/class="bgm-score[^"]*">([0-9.]+)</g, 30);
const tags = grab(/class="bgm-tag">([^<]*)</g, 12);
const eps = grab(/class="bgm-eps">([^<]*)</g, 10);
const titles = grab(/class="bgm-title"[^>]*title="([^"]*)"/g, 12);
const hrefs = grab(/class="bgm-cover" href="([^"]*)"/g, 6);
const imgs = grab(/<img src="https:\/\/([^/"]+)/g, 6);
const biliHidden = /html\.bgm-takeover body > \*/.test(dom);

console.log('\n=== 结果 ===');
console.log(`接管生效(html.bgm-takeover)：${takeover}`);
console.log(`自制容器 #bgm-anime-root：${rootExist}`);
console.log(`分类 tab：${modes.join(' | ') || '(无)'}`);
console.log(`年份 chip（前 8）：${years.join(', ') || '(无)'}`);
console.log(`月份分组（${months.length}）：${months.join(', ')}`);
console.log(`月份表头：${headTexts.slice(0, 6).join(' / ') || '(无)'}`);
console.log(`卡片数 .bgm-card：${cards}`);
console.log(`评分徽章（${scores.length}）：${scores.join(', ') || '(无)'}`);
console.log(`流派 tag：${tags.join(', ') || '(无)'}`);
console.log(`集数徽章：${eps.join(', ') || '(无)'}`);
console.log(`封面域名：${[...new Set(imgs)].join(', ') || '(无)'}`);
console.log(`卡片链接样例：`);
hrefs.forEach(h => console.log('  → ' + decodeURIComponent(h).slice(0, 110)));
console.log(`标题样例：`);
titles.slice(0, 8).forEach(t => console.log('  · ' + t));
console.log(`\nDOM：${domFile}`);
console.log(`截图：${shot}（${fs.existsSync(shot) ? (fs.statSync(shot).size / 1024).toFixed(0) + ' KB' : '未生成'}）`);
