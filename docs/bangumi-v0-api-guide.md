# Bangumi v0 列表接口 —— 番剧 tag 提取完整方案

> 目标：**用 Bangumi 列表接口一次请求拿到条目 + 全量流派 tag**，不拉详情、不逐条补拉。
> 本文是可直接移植到其他项目（油猴脚本 / 浏览器扩展 / 服务端 / 移动端）的落地方案，
> 接口字段的原始事实见 [`bangumi-list-api-facts.md`](./bangumi-list-api-facts.md)。
>
> 本方案的代码已在本仓库 `bili-anime-replace.user.js` v1.4.0 中实装并跑过 E2E。

---

## 一、为什么是 v0 而不是 p1

Bangumi 有两个「按年+月列番剧」的列表端点，**字段能力不对等**，这是整个方案的前提：

| | `api.bgm.tv/v0/subjects` | `next.bgm.tv/p1/subjects` |
|---|---|---|
| 列表项带 `tags`（用户投票全量词，≤30 个） | ✅ **有** | ❌ **没有**（实测 0/148） |
| 列表项带 `meta_tags` / `metaTags` | ✅ `meta_tags` | ✅ `metaTags`（驼峰） |
| 分页 | `limit`（**≤100**）+ `offset` | `page`（固定 24/页） |
| `total` 含义 | **总条数** | **总页数** |
| 单请求体积 / 耗时 | 112 KB / 3.4~8.8 s（24 条） | ~16 KB / 快 |
| TV 全年 334 条需要 | **4 个请求** | 14 个请求 + 逐条补详情 |

⇒ **结论：v0 优先。** 体积大但请求数少一个数量级，而且省掉了整套「详情补拉」机制。
p1 只作为 v0 故障时的降级通路（能力退化：拿不到内容词）。

⚠️ 注意：`api.bgm.tv/v0/subjects` **裸请求即可**（实测不校验 UA），
但**浏览器页面内直接 `fetch` 会被 CORS 拦**（接口不返回 `Access-Control-Allow-Origin`）。
落地时必须走下面三条路之一：

1. 油猴脚本：`GM_xmlhttpRequest`（真背景页语义，无 CORS 限制）
2. 浏览器扩展：MV3 service worker 里 `fetch` + 消息转发
3. 服务端 / 本地代理：随便 `fetch`

---

## 二、请求

```
GET https://api.bgm.tv/v0/subjects
      ?type=2            # 2 = 动画
      &cat=1             # 1=TV / 5=WEB / 2=OVA / 3=剧场版
      &year=2026
      &month=1
      &limit=100         # ★ 上限就是 100，传 200 会 HTTP 400
      &offset=0
```

翻页：`offset += 100`，直到 `data.length < limit` 或 `offset + limit >= total`。

**实测边界**

| 参数 | 结论 |
|---|---|
| `limit` | **≤ 100**（`200` → `HTTP 400`） |
| `offset` | 有效 |
| `total` | 总条数（不是页数） |
| `year` / `month` | 都生效；单月条数一般 < 100，所以多数月份**一个请求就完事** |
| 鉴权 | 不需要 |

> 顺带排除的一条路：`api.bilibili.com/pgc/season/index/result` 只认 `season_month`(1/4/7/10)，
> `year` 完全不生效 ⇒ 做不了按年浏览，不要选它。

---

## 三、响应里真正要用的字段

```jsonc
{
  "id": 443446,
  "name": "地獄楽 第二季",
  "name_cn": "地狱乐 第二季",
  "date": "2026-01-11",
  "eps": 12,
  "images": { "large": "...", "common": "...", "medium": "...", "small": "...", "grid": "..." },
  "rating": { "score": 6.8, "rank": 2345, "total": 1203 },
  "tags":      [ { "name": "战斗", "count": 524, "total_count": 38921 }, ... ],  // ★ 全量投票词，≤30
  "meta_tags": [ "TV", "TV", "日本", "日本", "奇幻", "奇幻", ... ]                // ★ 服务端摘要，会重复
}
```

| 字段 | 怎么用 |
|---|---|
| `tags[].name` | **候选词主力**。数组本身按 `count` **降序**（但仍建议显式排序，别赌接口顺序） |
| `tags[].count` | 该条目上这个词的票数 → 用来排序 = 「票数高者优先」的天然依据 |
| `tags[].total_count` | 全站总票数。**本方案不用** |
| `meta_tags[]` | 服务端摘要（平台/地区/来源/偶尔一个题材词）。**会被 `new Set()` 去重**，见下 |
| `rating.score` | 评分。注意：**无评分时 score 是 `0`，不是 `null`** |
| `eps` | 话数（TV 用） |
| `images.medium` | 封面（列表用中等尺寸足够） |

---

## 四、数据处理：四步（本方案的核心）

```
① 取名字    tags[]（对象）与 meta_tags[]（字符串）统一成纯词数组
② 去重      new Set() —— ★ 必须，见坑 ①
③ 拼接      [...tags按票数降序, ...meta_tags]  → 得到「候选词池」
④ 过筛      白名单分级 → 取前 2
```

### ③ 为什么要**并集**，而不是只信 `meta_tags`

`meta_tags` 不是「票数 Top N」，而是服务端**精挑的结构化摘要**，
它为了塞进平台/地区/来源，会**把题材词挤掉**。最典型的一条：

| 条目 | `meta_tags`（去重后） | `tags` 票数 Top 8 |
|---|---|---|
| **[276787] 梅比乌斯之尘** | `TV 日本 原创` | `原创:105` `2026年7月:93` `动画工房:80` `TV:59` **`科幻:54`** `2026:35` **`战斗:29`** |

→ 只吃 `meta_tags` 就只能显示「原创」；**并集后才有「科幻 / 战斗」**。
反例同样存在：`meta_tags` 里也有票数不高的词（服务端认定重要），所以**两边都要，一视同仁**。

### ④ 分级白名单（不是「票数排序」而是「品类排序」）

先按**语义层级**取，再在同层级内按票数先后：

```
候选词池（已去重）
   ├─ 命中 Tier1 题材      → 优先，按票数先后
   ├─ 命中 Tier2 来源/受众 → 次之，用来补满第 2 格
   └─ 命中 Tier3 平台/地区 → 默认**不用**（见下）
结果：上面三类依次拼接，取前 2 个
```

**为什么不是"票数 Top 2"**：票数最高永远是 `2026年1月`、`MAPPA`、`TV`、`日本`、`漫画改` 这类元信息，
内容词（题材）票数天然低 —— 按票数取 2 个，卡片上会全是「TV / 日本」。所以必须**先按品类筛，再按票数排**。

---

## 五、白名单（四年 937 条真实 tag 数据驱动）

Bangumi 的 tag 是**受控小词表**：2023~2026 四年 937 条样本、去重后**只有 53 个不同词**。
所以白名单必须从这里筛，**不要凭直觉写词**。

```js
const TAG_T1 = [   // 题材 27
  '奇幻','战斗','恋爱','日常','校园','科幻','喜剧','玄幻',
  '冒险','悬疑','百合','穿越','运动','音乐','历史','剧情',
  '后宫','武侠','推理','职场','机战','美食','萌系','BL',
  '恐怖','惊悚','耽美',
];
const TAG_T2 = [   // 来源 / 受众 12
  '漫画改','原创','小说改','游戏改','少年向','青年向','子供向','女性向',
  '少女向','同人','影视改','乙女',
];
const TAG_T3 = [   // 平台 / 地区 10 —— 兜底用，默认关
  '日本','TV','WEB','中国','剧场版','欧美','美国','OVA','法国','韩国',
];
// 刻意排除：短片集、短片（形式）、R18（分级）—— 不是题材，显示出来没信息量
```

### Tier3 为什么默认关（**建议其他项目也关**）

关掉 Tier3 后 2026 全四类的空卡构成（744 条实测）：

| 类别 | 条数 | 占比 | 说明 |
|---|---|---|---|
| 有 tag | 646 | **86.8%** | |
| 空卡 · **池空**（两字段都是空数组） | 13 | 1.7% | **无解**，数据就是没有 |
| 空卡 · **池里只有平台/地区词** | 82 | 11.0% | 开 Tier3 就能填 —— 但填进去是 `WEB ×33 / 剧场版 ×28 / 中国 ×22 / 日本 ×20 / TV ×20` |
| 空卡 · **池里有白名单外词** | 3 | 0.4% | 唯一的"可补词"候选 |

**那 3 条 B2 的未命中词是**：`Albert.Birney`、`三浦莉希`、`宫崎创`、`山下清悟`、`未保存` ——
**全是人名/垃圾词**。⇒ **补词收益为零，且加人名只会污染词表。**

而 11% 的 B1 卡片，开 Tier3 填进去的是「WEB / 剧场版 / 中国 / 日本」——
**比空着更没信息量**。所以：**宁缺毋滥，Tier3 默认关。**

（分类型覆盖率，Tier3 关：TV 92.5% / OVA 100% / WEB 83.2% / 剧场版 79.4%；
开 Tier3：97.8%。这 11% 就是取舍点。）

### 空卡是真无解吗？

池空的 13 条（TV 5 / WEB 7 / 剧场版 1）长这样：
`SEALOOK`、`吃豆人：零食时间`、`Thomas & Friends: Railway Stories`、
`Stitch & Angel's Perfect Summer Day`、`Lilo & Scratch`、`屁屁侦探 第11季`……

→ **欧美网络动画 / 短片 / 真人 4D**。Bangumi 上没人给它们投中文 tag，
**换通路、换词表、拉详情都救不了**。认清这一点，就不会在词表上白费功夫。

---

## 六、可复制的最小实现

零依赖，Node 18+ / 现代浏览器通用（浏览器需替换成 `GM_xmlhttpRequest` 或后台代理）。

```js
const T1 = new Set(TAG_T1), T2 = new Set(TAG_T2);   // 词表见上一节

const CAT = { tv: 1, web: 5, ova: 2, movie: 3 };    // type 固定 2

/** 日期/公司/人名这类噪声词不参与显示，但保留在池里不影响判定 */

const names = v => {                                 // 取纯词 + 去重（保序）
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    const n = typeof t === 'string' ? t
      : (t && typeof t === 'object' && typeof t.name === 'string') ? t.name : '';
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
};

/** 拉某年某月某分类的全部条目（自动翻页，limit 上限 100） */
async function fetchMonth(cat, year, month, http) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://api.bgm.tv/v0/subjects?type=2&cat=${CAT[cat]}&year=${year}&month=${month}`
              + `&limit=100&offset=${offset}`;
    const json = await http(url);                    // http 返回已解析的 JSON
    const list = Array.isArray(json.data) ? json.data : [];
    out.push(...list);
    if (list.length < 100 || out.length >= (Number(json.total) || 0)) break;
  }
  return out.map(normalize);
}

function normalize(e) {
  // ① tags 显式按票数降序（别赌接口已排序）
  const voted = (Array.isArray(e.tags) ? e.tags : [])
    .filter(t => t && typeof t.name === 'string')
    .slice()
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map(t => t.name);

  // ② 并集（tags 在前 = 票数高的在前）
  const pool = [...voted, ...names(e.meta_tags)];

  // ③ 分级筛：T1 优先 → T2 补位 → 取前 2（Tier3 关掉）
  const uniq = [...new Set(pool)];
  const tags = [
    ...uniq.filter(t => T1.has(t)),
    ...uniq.filter(t => T2.has(t)),
  ].slice(0, 2);

  const rating = e.rating || {};
  const img = e.images || {};
  return {
    id: e.id,
    name: e.name_cn || e.name || '',
    date: e.date || '',
    eps: Number(e.eps) || null,
    score: Number(rating.score) || 0,          // 无评分时接口给 0，按 0 处理
    votes: Number(rating.total) || 0,
    cover: img.medium || img.common || img.large || '',
    tags,                                       // ← 卡片上显示这两个
    pool,                                       // 候选词池，留着做调试/统计
  };
}

// 浏览器/油猴版 http：GM_xmlhttpRequest 包成 Promise
const httpViaGM = url => new Promise((ok, no) => {
  GM_xmlhttpRequest({ method: 'GET', url, timeout: 20000,
    onload: r => { try { ok(JSON.parse(r.responseText)); } catch (e) { no(e); } },
    onerror: no, ontimeout: no });
});
```

用法：

```js
const items = await fetchMonth('tv', 2026, 1, httpViaGM);
console.log(items.filter(x => x.tags.length === 0).length + ' 条无 tag');
```

### 千万不要做的一件事：逐条拉详情

很多人（包括本仓库 v1.3.0 之前的版本）会想「列表的 tag 不够，那就逐条拉 `/v0/subjects/{id}` 吧」。
**实测证明这是纯浪费**：

- 详情接口返回的 `tags` 与 v0 **列表项**的 `tags` **逐字节一致**（实测 3/3）
- 也就是说：列表已经给了全量 30 个词，详情一个字节都没多
- 而且两字段都空的条目，详情也是空的 ⇒ 补拉**救不了任何一个空卡**，只增加 N 倍请求

本仓库早期版本为此实现了「按需补拉」（约 33% 的卡片会触发），v0 通路上位后整套删掉不用。

---

## 七、坑清单（全部实测，按踩到顺序）

| # | 坑 | 表现 | 解法 |
|---|---|---|---|
| ① | **`meta_tags` 带重复** | `["TV","TV","日本","日本","奇幻","奇幻"]`，60 条里 21 条中招，倍数 2×~6× 不定、**不严格相邻成对** | **必须 `new Set()` 去重**。p1 的 `metaTags` 无此问题，但统一去重无害 |
| ② | `limit` 上限是 100 | 传 200 → `HTTP 400` | 用 100 + `offset` 翻页 |
| ③ | **p1 列表项没有 `tags`** | 只吃 `metaTags` ⇒ 约 33% 的卡片筛不出题材词，逼你去做详情补拉 | 用 v0 |
| ④ | `meta_tags` 不是票数 TopN | 票数第 2 的制作公司不在里面，题材词反而被挤掉 | 与 `tags` **取并集**，别只信任一个 |
| ⑤ | `meta_tags` 里会出现**人名** | 如 `Albert.Birney`、`三浦莉希`、`山下清悟` | 别把人名加进白名单（会污染），只当噪声忽略 |
| ⑥ | 无评分时 `rating.score` 是 **0** 而不是 null | 直接显示会变成「0.0 分」 | 判断 `> 0` 再显示 |
| ⑦ | **两字段皆空是常态**（2026 有 13 条） | 卡片没有 tag 可显示 | 接受它。这类是欧美网络动画/短片，任何方案都救不了 |
| ⑧ | 浏览器 `fetch` 被 CORS 拦 | `TypeError: Failed to fetch` | 走 `GM_xmlhttpRequest` / 扩展后台 / 服务端代理 |
| ⑨ | 白名单「加词」容易上瘾但**没用** | 想补 `后宫/百合/女性向`… 结果四年数据里它们本来就在；唯一没命中的 3 条是**人名** | 先跑频次统计再决定；**覆盖率的天花板是数据缺失，不是词表** |

---

## 八、移植清单

1. 抄 [`第五节`](#五白名单四年937条真实-tag-数据驱动) 的三张词表（或按目标站重新统计）
2. 抄 [`第六节`](#六可复制的最小实现) 的 `normalize()` —— **核心只有 15 行**
3. 把 `http` 换成目标环境的无 CORS 请求器
4. **不要**实现详情补拉
5. **不要**打开 Tier3 兜底（除非产品明确要"每张卡都有标签"）
6. 换站/换接口时：先跑一遍频次统计（本仓库 `tools/tag-freq.mjs`），
   按「题材 / 来源 / 受众 / 平台 / 地区」重新归类，**不要沿用这份词表**

### 本仓库里的对照实现

| 文件 | 作用 |
|---|---|
| `bili-anime-replace.user.js` §3.2–3.4 | `fromV0()` / `fromP1()` / `pickTags()` —— 正式实装 |
| `tools/coverage-union.mjs` | 三口径（仅 meta_tags / 仅 tags / 并集）× 分类型覆盖率 |
| `tools/empty-card-audit.mjs` | **空卡构成审计**：池空 / 只有地区词 / 白名单外词 三分类 + 未命中词频次 |
| `tools/probe-v0-tags.mjs` | tags 形态、`meta_tags` 重复规律、limit 上限 |
| `tools/probe-list-fields.mjs` | v0 与 p1 字段并排对比 |

---

*最后更新：2026-09-19 · 数据样本：2023~2026 四年 937 条（2026 全量 744 条，四分类全覆盖）*
