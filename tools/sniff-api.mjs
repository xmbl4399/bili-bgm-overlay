/**
 * 用 CDP 抓真实网页发出的 XHR —— 目的是拿到 B站番剧索引页筛选参数的确切名字。
 * 启动方式（见 run 注释）：先起带 --remote-debugging-port 的无头 Edge，再跑本脚本。
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const TARGET_URL = process.argv[2] || 'https://www.bilibili.com/anime/index/';
const MATCH = process.argv[3] || 'pgc/season';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForCdp(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

const main = async () => {
  if (!(await waitForCdp())) {
    console.error('CDP 未就绪，检查 Edge 是否带 --remote-debugging-port 启动');
    process.exit(1);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) { console.error('未找到 page target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

  const hits = new Map();
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Network.requestWillBeSent') {
      const url = msg.params?.request?.url || '';
      if (url.includes(MATCH)) hits.set(url, msg.params.request.method || 'GET');
    }
  });

  await new Promise(r => ws.addEventListener('open', r));
  send('Network.enable');
  send('Page.enable');
  send('Page.navigate', { url: TARGET_URL });

  await sleep(Number(process.env.WAIT_MS || 20000));

  console.log(`=== 命中 ${hits.size} 条含「${MATCH}」的请求 ===`);
  for (const [url, method] of hits) {
    console.log(`\n[${method}] ${decodeURIComponent(url)}`);
    try {
      const u = new URL(url);
      console.log('  参数：');
      for (const [k, v] of u.searchParams) console.log(`    ${k} = ${v}`);
    } catch {}
  }
  ws.close();
  process.exit(0);
};

main();
