/**
 * v0 可用性/稳定性/UA 要求 快测 —— 判断能否把 v0 提到数据源首位
 */
const UA = 'bili-bgm-overlay/1.3.0 (https://github.com/xmbl4399; contact: m18735714399@gmail.com)';
const P1U = 'https://next.bgm.tv/p1/subjects?type=2&cat=1&year=2026&month=1&page=1';
const V0U = 'https://api.bgm.tv/v0/subjects?type=2&cat=1&year=2026&month=1&limit=24';

const hit = async (url, headers, label) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers });
    const txt = await r.text();
    let n = '?'; try { n = (JSON.parse(txt).data || []).length; } catch {}
    return { label, status: r.status, ms: Date.now() - t0, n, kb: +(txt.length / 1024).toFixed(1) };
  } catch (e) { return { label, status: 0, err: String(e).slice(0, 60) }; }
};

console.log('=== ① UA 要求 ===');
console.log(JSON.stringify(await hit(V0U, { 'User-Agent': UA, Accept: 'application/json' }, 'v0 + UA')));
console.log(JSON.stringify(await hit(V0U, { Accept: 'application/json' }, 'v0 无 UA')));
console.log(JSON.stringify(await hit(V0U, {}, 'v0 裸请求')));
console.log(JSON.stringify(await hit(V0U, { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, 'v0 + UA + B站 Referer')));

console.log('\n=== ② p1 vs v0 耗时/体积（同一个月 TV）===');
for (let i = 0; i < 3; i++) {
  const a = await hit(P1U, { 'User-Agent': UA }, 'p1 #' + (i + 1));
  const b = await hit(V0U, { 'User-Agent': UA }, 'v0 #' + (i + 1));
  console.log(`  p1: ${String(a.status).padEnd(4)} ${String(a.ms).padStart(5)}ms ${String(a.kb).padStart(6)}KB ${a.n}条   │   v0: ${String(b.status).padEnd(4)} ${String(b.ms).padStart(5)}ms ${String(b.kb).padStart(6)}KB ${b.n}条`);
  await new Promise(r => setTimeout(r, 800));
}

console.log('\n=== ③ v0 连续 8 次稳定性（模拟翻月份）===');
let ok = 0, fail = 0;
for (let m = 1; m <= 8; m++) {
  const r = await hit(`https://api.bgm.tv/v0/subjects?type=2&cat=1&year=2026&month=${m}&limit=24`, { 'User-Agent': UA }, 'm' + m);
  const good = r.status === 200;
  good ? ok++ : fail++;
  process.stdout.write(`  ${m}月:${r.status}(${r.ms}ms,${r.n}条)  `);
  await new Promise(r2 => setTimeout(r2, 400));
}
console.log(`\n  → 成功 ${ok} / 失败 ${fail}`);

console.log('\n=== ④ 一年 TV 全量要几次请求（v0 limit=100 vs p1 24/页）===');
{
  const r = await hit('https://api.bgm.tv/v0/subjects?type=2&cat=1&year=2026&limit=1', { 'User-Agent': UA }, 'v0 total');
  const total = Number((await (await fetch('https://api.bgm.tv/v0/subjects?type=2&cat=1&year=2026&limit=1', { headers: { 'User-Agent': UA } })).json()).total);
  console.log(`  2026 TV 全年 total=${total} ⇒ v0: ${Math.ceil(total / 100)} 次请求 ｜ p1: ${Math.ceil(total / 24)} 次请求（且 p1 无 tags，需补拉）`);
}
