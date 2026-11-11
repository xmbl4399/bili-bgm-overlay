# Bangumi 周历接口（`/calendar`）完整方案

> 面向"把当前在播番剧按星期分组展示"这类需求。本文覆盖：两个端点的结构对比、字段语义、实测边界、排序与分组的正确处理方式、以及一份可直接搬走的最小实现。
>
> 抓取时间：**2026-11-11**（周三）。所有数字都是当天实测，不是文档抄来的。
>
> 关联：[`bangumi-v0-api-guide.md`](bangumi-v0-api-guide.md)（按年/月浏览的列表接口）、[`bangumi-list-api-facts.md`](bangumi-list-api-facts.md)（字段事实对照）。

---

## 1. 为什么需要单独一个接口

按年/月浏览用的是 `v0/subjects?type=&cat=&year=&month=`，它回答的是"**某年某月有哪些番**"。
但"**今天播什么**"用这套索引答不了 —— 得先选年、再翻到当月，而周历天生跨月：本周的周一可能在上个月，周日可能在下个月。

`GET /calendar` 就是为这个问题设计的：**一次请求拿回全部 7 天的在播条目**，与年份、月份完全无关。

| 维度 | `v0/subjects`（年/月） | `/calendar`（周历） |
|---|---|---|
| 组织单位 | 一条 = 一个月份的条目 | 一条 = 一个星期的条目 |
| 时间语义 | 首播日期落在该月 | **当前正在播**（`air_weekday` 落在该星期） |
| 是否含完结番 | 含（历史年份整月都是） | **只含在播** |
| 请求数 | 每月 1~N 次 | **全周 1 次** |
| 条目量 | 单月 0~100+ | 全周约 **112** |

---

## 2. 两个端点

```
GET https://next.bgm.tv/p1/calendar      ← 推荐（99 KB，信息更全）
GET https://api.bgm.tv/calendar          ← 兜底（85 KB）
```

两者**都返回全部 7 天**，不需要带任何参数。

| 响应头 | 值 |
|---|---|
| `access-control-allow-origin` | `*` |
| `cache-control` | `max-age=3600` |
| `content-type` | `application/json` |

> 虽然带 CORS 头，如果运行在 Tampermonkey 里，仍建议走 `GM_xmlhttpRequest` 统一处理超时/重试/错误分类。

---

## 3. 结构对比（这是最容易踩的地方）

### 3.1 顶层：数组 vs 对象

```
v0  /calendar     →  [ {weekday:{…}, items:[…]}, ×7 ]      ← 数组
p1  /p1/calendar  →  { "1":[…], "2":[…], …, "7":[…] }      ← 对象，键就是星期 id
```

**不要写死一种形态**。判"是不是数组"分流即可，见 §6 的 `normalizeCalendar()`。

### 3.2 v0 条目

```json
{
  "id": 412008,
  "url": "https://bgm.tv/subject/412008",
  "type": 2,
  "name": "転生したら剣でした 第2期",
  "name_cn": "转生就是剑 第二季",
  "summary": "…",
  "air_date": "2026-10-01",
  "air_weekday": 3,
  "rating": { "total": 512, "count": { "1":3, … }, "score": 6.7 },
  "images": {
    "large":  "http://lain.bgm.tv/pic/cover/l/ee/ed/412008_2PmNb.jpg",
    "common": "http://lain.bgm.tv/r/400/pic/cover/l/…",
    "medium": "http://lain.bgm.tv/r/800/pic/cover/l/…",
    "small":  "http://lain.bgm.tv/r/200/pic/cover/l/…",
    "grid":   "http://lain.bgm.tv/r/100x100/pic/cover/l/…"
  },
  "collection": { "doing": 1194 }
}
```

> ⚠️ **`images` 全是 `http://`**（不是 https）。https 版实测 200，渲染前统一升级即可，否则 https 页面会出混合内容。

**v0 周历项没有的东西**：`tags`、`meta_tags`、话数、`platform`、`date`。
所以**用 v0 做周历拿不到内容 tag，也拿不到集数** —— 这是本文推荐 p1 优先的原因。

> ⚠️ **但 p1 也没有 `eps` 字段**：它的 `subject` 是 `{id,name,nameCN,type,series,info,metaTags,rating,locked,nsfw,platform,images}`，
> 没有 `eps` / `total_episodes`。集数只能从 `info` 文本里正则抠，**实测只覆盖 61.6%**（见 §8 第 11 条）。
> 想要 100% 的集数，只能对每个条目再打一次 `next.bgm.tv/p1/subjects/{id}` 拿 `eps` —— 但那 43 条实测 `eps` 全是 `0`，补了也没有。

### 3.3 p1 条目

```json
{
  "watchers": 1194,
  "subject": {
    "id": 412008,
    "name": "転生したら剣でした 第2期",
    "nameCN": "转生就是剑 第二季",
    "type": 2,
    "series": false,
    "info": "12话 / 2026年10月1日 / …",
    "metaTags": ["奇幻", "战斗", "日本", "小说改", "TV"],
    "rating": { "rank": 1234, "count": [3,2,…], "score": 6.7, "total": 512 },
    "platform": { "id": 1, "type": "TV", "typeCN": "TV", "alias": "TV", … },
    "images": {
      "large":  "https://lain.bgm.tv/pic/cover/l/…",
      "common": "https://lain.bgm.tv/r/400/pic/cover/l/…",
      "medium": "https://lain.bgm.tv/r/200/pic/cover/l/…",
      "small":  "https://lain.bgm.tv/r/100/pic/cover/l/…",
      "grid":   "https://lain.bgm.tv/r/100x100/pic/cover/l/…"
    },
    "locked": false,
    "nsfw": false
  }
}
```

比 v0 多三样有用的东西：

| 字段 | 用途 |
|---|---|
| `subject.metaTags` | 内容 tag 池（实测覆盖 **86~96%** 条目）——卡片左上角徽章的来源 |
| `subject.info` | `"12话 / 2026年10月1日 / 导演 / …"` → 正则反解**放送日期**；**话数只覆盖 61.6%**（没有 `eps` 字段） |
| `subject.platform.typeCN` | `TV` / `WEB` / `OVA` / `剧场版`…（周历里几乎全是 `TV`，因为"在播"就是 TV） |

> 注意 p1 的 `images.medium` 是 **r200**，v0 的 `medium` 是 **r800** —— 两个端点档位命名不对齐。
> **只有 `common` 两边都指向 r400**，所以封面基准恒取 `common`，宽度在渲染时改写。

### 3.4 每日条数（2026-11-11）

| 端点 | 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 | 合计 |
|---|---|---|---|---|---|---|---|---|
| v0 | 14 | 10 | 12 | 11 | 14 | 24 | 27 | **112** |
| p1 | 14 | 11 | 12 | 11 | 14 | 23 | 27 | **112** |

周末明显多（周六/周日各 20+），工作日 10~14。**全部 `type=2`（动画）**，不会有真人影视混进来。

数量会随季度变化（1/4/7/10 月换季时最热闹），但 7 天**永远都有数据**，不存在空天。

---

## 4. 排序：必须自己排，别信原序

接口返回的顺序**不严格等于**在看人数降序。实测周三那天的 `collection.doing` 序列开头是：

```
6, 1194, 1, 2234, …
```

直接吃原序，首屏会出现"在看人数 1"的条目排在"2234"前面。

正确的排序依据是**在看人数**（`collection.doing` / `watchers`），不是评分：

| 排序依据 | 问题 |
|---|---|
| 评分降序 | 新番开播才 1~2 周，评分极不稳定；**约 1/4 条目 `score = 0`**（还没开分），全被压到底 |
| 首播日期 | 周历内所有条目本来就是同一个星期，日期信息量≈0 |
| **在看人数降序** ✅ | 直接反映"现在有多少人真在看"，新番老番同一标尺 |

实测 `doing` 跨度极大：**个位数 ~ 16 000**，排序区分度很好。

```js
const doing = it => (it.doing == null ? -1 : it.doing);
arr.sort((a, b) => doing(b) - doing(a) || (b.score || 0) - (a.score || 0) || a.title.localeCompare(b.title));
```

---

## 5. 分组顺序：今天在最前

**不要用"周一 → 周日"**。周历的价值在"今天"，把它放在第一个才不用滚。

公式（`today` 取值 1=周一 … 7=周日）：

```js
function orderFrom(today = todayWeekday()) {
  const out = [];
  for (let off = 0; off < 7; off++) {
    out.push(((today - 1 - off) % 7 + 7) % 7 + 1);
  }
  return out;
}
```

`+ 7) % 7` 是关键 —— JS 的 `%` 对负数返回负数，不修就得到 `-1`、`-2` 这种非法 id。

| 今天是 | `orderFrom()` |
|---|---|
| 周三 (3) | `[3, 2, 1, 7, 6, 5, 4]`（周三 → 周二 → 周一 → **周日** → 周六 → 周五 → 周四） |
| 周一 (1) | `[1, 7, 6, 5, 4, 3, 2]` |
| 周日 (7) | `[7, 6, 5, 4, 3, 2, 1]` |

语义上这其实是"**往前回溯 7 天**"：今天、昨天、前天……刚好覆盖一整周、不重不漏。

`todayWeekday()` 注意 **JS 的 `getDay()` 里周日是 0**，要映射成 7：

```js
const todayWeekday = (now = new Date()) => now.getDay() || 7;
```

### 5.1 空分组要保留

月份视图里 0 部 → 整块隐藏（TV 常年 5/6/8/9 月为空，留着白占几屏）。
但周历不同：**"今天没有可显示的番剧"本身就是有效信息**，删掉会让人以为页面没加载完。

所以周历分组**数量恒为 7**，空的只把内容区换成一句说明（今天用「今天没有可显示的番剧」，其它天用「没有可显示的番剧」）。

---

## 6. 最小实现（可直接搬）

```js
const WEEKDAYS = [
  { id: 1, cn: '星期一', short: '周一' },
  { id: 2, cn: '星期二', short: '周二' },
  { id: 3, cn: '星期三', short: '周三' },
  { id: 4, cn: '星期四', short: '周四' },
  { id: 5, cn: '星期五', short: '周五' },
  { id: 6, cn: '星期六', short: '周六' },
  { id: 7, cn: '星期日', short: '周日' },
];

const todayWeekday = (now = new Date()) => now.getDay() || 7;

function orderFrom(today = todayWeekday()) {
  const out = [];
  for (let off = 0; off < 7; off++) out.push(((today - 1 - off) % 7 + 7) % 7 + 1);
  return out;
}

const toHttps = u => (u && u.startsWith('http://') ? 'https://' + u.slice(7) : u);

// p1 → 内部条目
// ⚠️ episodes 是「猜」出来的：p1 没有 eps 字段，只能从 info 抠，覆盖约 61.6%。
//    本仓库脚本因此在新番表里不显示集数徽章（MODES.calendar.showEpisodes = false）。
function fromCalP1(e) {
  const s = e.subject || {};
  const info = String(s.info || '');
  const epsM = info.match(/(\d{1,4})\s*话/);
  const img = s.images || {};
  return {
    id: s.id,
    title: s.nameCN || s.name || '',
    cover: toHttps(img.common || img.large || img.medium || ''),
    score: s.rating && s.rating.score ? s.rating.score : null,
    rank: (s.rating && s.rating.rank) || null,
    platform: (s.platform && s.platform.typeCN) || '',
    episodes: epsM ? Number(epsM[1]) : null,
    date: (info.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) || null),
    tagPool: (s.metaTags || []).map(String),
    doing: e.watchers == null ? null : e.watchers,
  };
}

// v0 → 内部条目（注意：没有 tags、没有话数、images 是 http）
function fromCalV0(e) {
  const img = e.images || {};
  return {
    id: e.id,
    title: e.name_cn || e.name || '',
    cover: toHttps(img.common || img.large || img.medium || ''),
    score: e.rating && e.rating.score ? e.rating.score : null,
    rank: null,
    platform: '',
    episodes: null,
    date: e.air_date || null,
    tagPool: [],
    doing: (e.collection && e.collection.doing) == null ? null : e.collection.doing,
  };
}

/** 同时吃 v0 数组 / p1 对象，返回 Map<weekdayId, items[]>，保留空分组 */
function normalizeCalendar(payload, { hideNoScore = false } = {}) {
  const byDay = new Map(WEEKDAYS.map(w => [w.id, []]));
  const push = (day, it) => {
    if (it.id == null) return;
    if (hideNoScore && it.score == null) return;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(it);
  };

  if (Array.isArray(payload)) {
    for (const grp of payload) {
      const day = (grp.weekday && grp.weekday.id) || 0;
      for (const e of grp.items || []) push(day, fromCalV0(e));
    }
  } else if (payload && typeof payload === 'object') {
    for (const [k, list] of Object.entries(payload)) {
      const day = Number(k);
      for (const e of Array.isArray(list) ? list : []) push(day, fromCalP1(e));
    }
  } else {
    throw new Error('周历响应格式不认识');
  }
  return byDay;
}

const compareCalendar = (a, b) =>
  (b.doing == null ? -1 : b.doing) - (a.doing == null ? -1 : a.doing) ||
  (b.score || 0) - (a.score || 0) ||
  String(a.title || '').localeCompare(String(b.title || ''));

const CAL_ENDPOINTS = [
  { id: 'p1', url: 'https://next.bgm.tv/p1/calendar' },   // 优先：有 metaTags / info
  { id: 'v0', url: 'https://api.bgm.tv/calendar' },        // 兜底
];

async function loadCalendar(fetchText, { hideNoScore = false } = {}) {
  let lastErr = null;
  for (const ep of CAL_ENDPOINTS) {
    try {
      const { status, text } = await fetchText(ep.url, { timeout: 20000 });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return { byDay: normalizeCalendar(JSON.parse(text), { hideNoScore }), source: ep.id };
    } catch (e) {
      lastErr = e;
    }
  }
  return { byDay: new Map(WEEKDAYS.map(w => [w.id, []])), source: null, error: String(lastErr && lastErr.message || '全部通路失败') };
}
```

渲染侧只要按 `orderFrom()` 遍历、每组 `sort(compareCalendar)` 即可：

```js
for (const day of orderFrom()) {
  const items = (byDay.get(day) || []).slice().sort(compareCalendar);
  renderWeekSection(day, items);   // items.length === 0 也要渲染标题 + 一句说明
}
```

---

## 7. 缓存建议

| 项 | 建议值 | 理由 |
|---|---|---|
| 键 | `w:calendar`（与逐月键 `m:{cat}:{year}:{month}` 分开） | 周历不是月份维度，混用会互相挤掉 |
| 时效 | **60 分钟** | 与接口自己的 `max-age=3600` 对齐；周历变化慢 |
| 粒度 | 一个键装全周（约 112 条） | 逐日缓存纯属浪费，7 天总是一个整体变化 |
| 失败时 | 也写缓存（同 60 分钟） | 避免失败后每次进页面都重打 |

`hideNoScore` 这类**数据层过滤**发生在写缓存之前 ⇒ **改完要清缓存**。
封面宽度之类**渲染层改写**不带进缓存 ⇒ 改完立刻生效。

---

## 8. 踩坑清单

| 坑 | 现象 | 解法 |
|---|---|---|
| **v0 顶层是数组、p1 是对象** | 按一种形态解析，切通路就崩 | 判 `Array.isArray()` 分流 |
| **v0 的 `images` 全是 `http://`** | https 页面出混合内容警告 / 图不显示 | `toHttps()` 统一升级 |
| **p1 的 `medium` 是 r200，v0 是 r800** | 换通路后封面大小突变 | 基准恒取 `common`（两边都 r400），宽度渲染时改写 |
| **`getDay()` 周日是 0** | 周日那天算成"第 0 天"，分组错位 | `now.getDay() \|\| 7` |
| **JS 负数取模** | `(3-1-4) % 7` = `-2`，得到非法 weekday | `((x % 7) + 7) % 7` |
| **直接吃接口原序** | "在看 1 人"排在"在看 2234 人"前面 | 自己按 `doing` 降序排 |
| **用评分排序** | 约 1/4 条目 `score=0`，新番全沉底 | 用 doing，评分只作次序键 |
| **v0 没有 tags** | 卡片 tag 徽章全空 | p1 优先（`metaTags`） |
| **空分组删掉** | 页面像没加载完 | 周历分组**恒 7 个**，空的给一句说明 |
| **拿月份视图的"删空组"逻辑套过来** | 周历突然只剩 3 组 | 两套逻辑分开：月份删空、周历保留 |
| **以为 p1 带集数字段** | 想直接读 `subject.eps`，读不到 | p1 的 `subject` **没有 `eps`**；只能从 `info` 抠，且只覆盖 **61.6%**（112 条里 69 条） |
| **给缺集数的条目补拉详情** | 以为能补全，实际白花 43 个请求 | 那 43 条 `p1/subjects/{id}` 的 `eps` 全是 `0`、`infobox`「话数」是 `*` ⇒ **零收益**，直接不显示集数徽章 |

---

## 9. 实测结果（2026-11-11，本仓库 `tools/e2e-calendar.mjs`）

无头 Edge + 临时 MV3 扩展注入真实 `www.bilibili.com/anime/` 页面，CDP 派真实鼠标点击：

| 断言 | 结果 |
|---|---|
| tab 总数 / 第一项 / 第二项 | 10 / `新番表(calendar)` / `TV(tv)` |
| 星期分组数 / 月份分组残留 | 7 / 0 |
| 首组是今天 / `今天` 徽标只 1 个 | ✅ / ✅ |
| `orderFrom()` 与 DOM 顺序一致 | `[3,2,1,7,6,5,4]` |
| 卡片数 / 封面全 https | **97** / ✅ |
| 评分徽章 / tag 徽章 | ✅ / ✅ |
| 集数徽章 | **0 个**（刻意关掉，周历无 `eps` 字段） |
| 年份栏在周历下隐藏（`display:none` 且高 0） | ✅ |
| 切回 TV：年份栏恢复、星期分组清零、月份分组回来 | 32px / 0 / 11 |
| 720P~800×600 顶栏 tab 仍只有一行 | ✅（4 个视口） |
| console 报错 | **0** |

当日每星期在播：周三 8 · 周二 10 · 周一 11 · 周日 26 · 周六 18 · 周五 14 · 周四 10。
