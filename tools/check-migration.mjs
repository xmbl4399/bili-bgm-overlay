/**
 * 配置迁移验证 —— v1.3.0 → v1.4.0 升级时，老配置里存着 `tagDetail:'fill'` /
 * `showTier3:true` / `source:'p1'`，会**盖掉新默认值**，让「不补拉 / 不兜底 / v0 优先」全部失效。
 *
 * 本脚本模拟一个真实老用户：先塞一份 v1.3.0 时代的配置，再加载页面，
 * 断言配置被迁移机制纠正、并且页面的网络行为真的跟着变（v0 通路 + 0 次补拉）。
 *
 * 用法：node tools/check-migration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '.e2e-anime-out');
const EXT = path.join(__dirname, '.e2e-anime-ext');
const TARGET = 'https://www.bilibili.com/anime/';
const PORT = 9281;
const NS = 'bgmanime';

/* 替身 gm-shim 会自己再加一层前缀 ⇒ 真实键是双层。测试**从已有键反推**，不写死。 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(OUT, 'profile-mig');
  fs.rmSync(profile, { recursive: true, force: true });

  const c = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, `--load-extension=${EXT}`, 'about:blank',
  ], { stdio: 'ignore' });

  const errors = [];
  let ws, id = 0; const waiters = new Map();
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waiters.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { up = true; break; } } catch {}
      await sleep(500);
    }
    if (!up) throw new Error('CDP 没起来');

    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text || '');
    });
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
    const j = async expr => JSON.parse(await ev(`JSON.stringify(${expr})`));

    console.log('=== ① 先加载一次页面，好让 localStorage 落在正确的源上 ===');
    await send('Page.navigate', { url: TARGET });
    await sleep(9000);

    /* 反推键前缀（替身环境是双前缀） */
    const keys = await j(`Object.keys(localStorage)`);
    console.log('  localStorage 键：' + keys.join(' | '));
    const cfgKey = keys.find(k => k.endsWith(':cfg'));
    if (!cfgKey) throw new Error('找不到配置键，页面可能没跑起来');
    console.log('  配置键 = ' + cfgKey);

    console.log('\n=== ② 塞一份 v1.3.0 时代的老配置（会盖掉新默认值） ===');
    const legacy = {
      enabled: true, mode: 'tv', keepHeader: true, showTags: true, showEpisodes: true,
      showScore: true, hideNoScore: false,
      showTier3: true,            // 老默认：开
      theme: 'auto',
      tagDetail: 'fill',          // 老默认：没题材词就补拉
      source: 'p1',               // 老优先级：p1 优先（拿不到 tags！）
      ttlHoursThisYear: 12, ttlDaysPastYear: 30, concurrent: 2, maxPages: 12, pageSize: 24,
    };
    await ev(`localStorage.setItem(${JSON.stringify(cfgKey)}, ${JSON.stringify(JSON.stringify(legacy))})`);
    console.log('  已写入：' + JSON.stringify({ showTier3: true, tagDetail: 'fill', source: 'p1', cfgV: '(无)' }));

    console.log('\n=== ③ 重新加载页面 → 迁移应自动纠偏 ===');
    await send('Page.navigate', { url: TARGET });
    await sleep(12000);

    const after = await j(`JSON.parse(localStorage.getItem(${JSON.stringify(cfgKey)}) || '{}')`);
    console.log('  迁移后：' + JSON.stringify({ cfgV: after.cfgV, showTier3: after.showTier3, tagDetail: after.tagDetail, source: after.source }));

    let pass = 0, fail = 0;
    const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✅ ' + label + (extra ? ' → ' + extra : '')); } else { fail++; console.log('  ❌ ' + label + (extra ? ' → ' + extra : '')); } };
    ok(after.cfgV === 2, 'cfgV 打上版本号', String(after.cfgV));
    ok(after.tagDetail === 'off', 'tagDetail 被纠正为 off（不再补拉）', String(after.tagDetail));
    ok(after.showTier3 === false, 'showTier3 被纠正为 false（不兜底）', String(after.showTier3));
    ok(after.source === 'auto', 'source 归位 auto（v0 优先）', String(after.source));

    /* 再写一份「迁移后用户手动改回来」的配置，断言**不会**被再次重置 */
    console.log('\n=== ④ 迁移后用户手动打开 Tier3 → 不能被再次重置 ===');
    await ev(`(() => { const k = ${JSON.stringify(cfgKey)};
      const v = JSON.parse(localStorage.getItem(k)); v.showTier3 = true; v.tagDetail = 'empty';
      localStorage.setItem(k, JSON.stringify(v)); })()`);
    await send('Page.navigate', { url: TARGET });
    await sleep(10000);
    const kept = await j(`JSON.parse(localStorage.getItem(${JSON.stringify(cfgKey)}) || '{}')`);
    ok(kept.showTier3 === true && kept.tagDetail === 'empty',
      '用户手改的配置被保留（迁移只跑一次）', JSON.stringify({ showTier3: kept.showTier3, tagDetail: kept.tagDetail }));

    /* 网络行为验证：v0 通路 + 0 次补拉 */
    console.log('\n=== ⑤ 网络行为（迁移后应走 v0、零补拉） ===');
    const net = await j(`(() => { const k = window.__BGM_ANIME__;
      return k && k.netStats ? { ok: k.netStats.ok, err: k.netStats.err, detail: k.netStats.detail, bySource: k.netStats.bySource } : null; })()`);
    if (net) {
      console.log('  netStats = ' + JSON.stringify(net));
      ok(net.detail === 0, '详情补拉 0 次');
      ok((net.bySource.v0 || 0) > 0, '请求走的是 v0', JSON.stringify(net.bySource));
    } else {
      console.log('  （拿不到 netStats —— 沙箱隔离，跳过网络断言）');
    }

    const cards = await j(`(() => { const c = [...document.querySelectorAll('.bgm-card')];
      return { total: c.length, noTag: c.filter(x => !x.querySelector('.bgm-tag')).length }; })()`);
    console.log('  卡片：' + JSON.stringify(cards));

    console.log('\n=== 页面异常 ===');
    console.log('  未捕获异常：' + errors.length + ' 条' + (errors.length ? '\n  ' + errors.slice(0, 3).join('\n  ') : ''));
    ok(errors.length === 0, '无未捕获异常');

    console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}：${pass} 通过 / ${fail} 失败`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('运行失败：' + e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    c.kill();
  }
};

main();
