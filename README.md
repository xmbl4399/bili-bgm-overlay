# B站番剧区 → Bangumi 番剧浏览页

一个 Tampermonkey 脚本（`bili-anime-replace.user.js`）：打开 `www.bilibili.com/anime/*` 时，把 B站 那套番剧区**整页换成自制的 Bangumi 番剧浏览页** —— 数据全部来自 [Bangumi](https://bgm.tv)，只保留最上面那排 B站 顶栏。

**➡️ [Greasy Fork 一键安装](https://greasyfork.org/zh-CN/scripts/596516-b%E7%AB%99%E7%95%AA%E5%89%A7%E5%8C%BA-bangumi-%E7%95%AA%E5%89%A7%E6%B5%8F%E8%A7%88%E9%A1%B5)** ｜ 源码与反馈：[GitHub](https://github.com/xmbl4399/bili-bgm-overlay)

> **v1.4.0**：数据源改为 **`api.bgm.tv/v0` 优先** —— 该列表接口**自带全量用户投票 tag**（≤30 个）⇒ **整套「详情补拉」机制关闭**（TV 全年：14 请求 + 33% 补拉 → **4 请求、0 补拉**），题材命中率 57.3% → **74.2%**；同时 Tier3 兜底默认关。完整接口方案见 **[docs/bangumi-v0-api-guide.md](docs/bangumi-v0-api-guide.md)**（可移植到其他项目）。
>
> **v1.3.0**：① 主题**跟随 B站 自己的深/浅色开关**（不是跟随系统）；② B站 顶栏头像弹层里的**状态行**；③ tag 白名单重做成**数据驱动的二级 + 可选第三级** —— 设计方法与词表见 **[docs/tier-whitelist-design.md](docs/tier-whitelist-design.md)**（可移植到其他项目）。

## 安装

**一键安装：[Greasy Fork · B站番剧区 → Bangumi 番剧浏览页](https://greasyfork.org/zh-CN/scripts/596516-b%E7%AB%99%E7%95%AA%E5%89%A7%E5%8C%BA-bangumi-%E7%95%AA%E5%89%A7%E6%B5%8F%E8%A7%88%E9%A1%B5)**

1. 浏览器装 **Tampermonkey**（Edge / Chrome 商店均有）。
2. 装脚本任选一种：
   - 打开上面的 **Greasy Fork** 链接 → **安装此脚本**（推荐，之后能自动收到更新）；
   - 或把 `bili-anime-replace.user.js` **直接拖到浏览器窗口**里，Tampermonkey 会拦下并弹出安装页；
   - 或 Tampermonkey 面板 → **实用工具 → 从文件导入**；
   - 或 Tampermonkey 面板 → 新建脚本 → 把文件内容整段粘进去 → Ctrl+S。
3. 打开 <https://www.bilibili.com/anime/> 即可看到自制的番剧浏览页。

> **必须给 `GM_xmlhttpRequest` 权限。** Bangumi 的 `api.bgm.tv` 与 `next.bgm.tv` **都没有 CORS 响应头**，只有 Tampermonkey 的后台请求能取到数据。若脚本被装在"无 GM 权限"的环境（例如当普通 content script 注入），页面里 `fetch` 必被浏览器拦死，会显示「加载失败 + 重试」——这是环境限制，不是脚本 bug。
>
> 文件直连（`file://`）导入时若 Edge 没反应，去 `edge://extensions` 给 Tampermonkey 打开「允许访问文件 URL」。

### 卸载 / 临时关掉

| 想做什么 | 怎么做 |
|---|---|
| 临时看回 B站原页面（不卸载） | 页面顶栏 ⚙ → **恢复 B站原页面**，或 Tampermonkey 菜单 → 恢复 B站原页面（仅本次会话，刷新即回来） |
| 彻底不替换 | Tampermonkey 面板里把该脚本的开关关掉 / 删除 |

---

## 一、脚本做什么

### 效果

![番剧浏览页](docs/shot-anime-replace.png)

打开 `https://www.bilibili.com/anime/`（或 `/anime/index/`、`/anime/timeline/` 等任意子页），**B站 那套番剧区被换成这个页面 —— 只留最上面那排 B站 顶栏**（要连顶栏一起藏掉也行，设置里一键切）。

> 上图里的"登录后你可以"卡片是 **B站 自己的访客提示**（headless 未登录所以弹了），不是本脚本画的 —— 它正好演示了表头浮层浮在内容之上。

### 页面构成（1:1 对齐 PiliPlus 的 `lib/pages/bangumi_browse/`）

| 区域 | 形态 |
|---|---|
| **B站 顶栏（保留）** | 首页 / 番剧 / 直播 / 游戏中心 / 会员购 / 漫画 / 赛事 / **搜索框** / 登录 / 大会员 / 消息 / 动态 / 收藏 / 历史 / 创作中心 / 投稿 —— 原封不动留在最上面，能点能搜 |
| 顶栏（自有） | `● 番剧库 Bangumi数据` + 二级分类 tab `TV / WEB / OVA / 剧场版`（胶囊选中）+ 主题按钮 `◐/☀/☾` + 设置 ⚙ |
| 年份栏 | `2026 → 2006` 横向 chip，默认当前年 |
| 主体 | **月份倒序分组**，每组标题 `{m}月 · {N} 部`，下面是响应式网格 |
| 卡片 | 封面 3:4；**右上角评分徽章**（≥7 金色 `#FFD54F`，否则白 70%）；**左上角流派 tag**（二级白名单，最多 2 个）；**左下角集数**（仅 TV）；标题 2 行省略 |

### 保留 B站 顶栏（v1.1.0 起，默认开）

内容区排在 B站 表头**下面**，表头照常工作。设置面板里可一键关掉，关掉就退回"整页铺满、连表头一起藏"。实现上有两个非显然的点：

| 坑 | 现象 | 解法 |
|---|---|---|
| **表头是白字** | 表头 `color` 是 `rgb(255,255,255)` + 顶部深色渐变 —— 那是给番剧区那张**大横幅**打的底。藏掉 `#app`（横幅在里面）后，白字压白底 = **完全看不见** | 不自己覆盖配色（会连带毁掉大会员图标、投稿按钮的自身配色），而是给 `.bili-header__bar` 补上 B站 自己的 **`slide-down`** 类 —— 那是它滚动后的"实底"皮肤：背景转白、渐变消失、文字转深色，高度仍是 64 |
| **表头自成一"层"** | `.bili-header__bar` 是 `position:fixed; z-index:1002`，**它内部的下拉浮层也只能待在 1002 这一层**。内容区若用超高 z-index 压上去，表头的下拉（消息/动态/头像卡）就会被整片盖住 | 保留表头时内容区取 `--bgm-z = 表头 z-index − 1`（实测 1001）；自有设置面板/toast 仍用 21 亿，压在表头之上 |
| **表头是异步渲染的** | 服务端 HTML 里只有 `<div id="biliMainHeader" style="height:56px">` 占位，真正的 `.bili-header__bar`（h64）由 B站 的异步 UMD 脚本挂上去 | 量到真值前先用兜底 64px，起来后立刻校正（100ms×20 次 + 常驻 1.2s 兜底）——否则内容区会先按 0 排布再往下跳 |

> 表头保留时，**自有搜索框会自动收起** —— B站 那个就在正上方、行为完全一样（都跳 B站 搜索），两个叠着太多余。

### 主题：跟随 **B站 自己的** 深/浅色（v1.3.0）

B站 新版有个「主题：浅色/深色」开关（在头像弹层里）。本页面**跟随它**，而不是跟随操作系统。实测的机制如下 —— 这也是最容易猜错的一处：

| 猜想 | 实测结果 |
|---|---|
| `<html>` 上有 `class="dark"` | ❌ 页面 `<html>` 上**没有任何**主题标记 |
| `data-theme="dark"` / `data-dark` / `color-scheme` | ❌ 逐个施加到页面上，背景色**纹丝不动** |
| `prefers-color-scheme` | ❌ 不参与（系统深色 + B站 浅色时，B站 仍是浅色） |
| **`<link id="__css-map__" href="…/bili-theme/light.css">`** | ✅ **这才是真开关**：切深色 = 把 href 换成同目录的 `dark.css` |

`dark.css` 只是把 `:root` 的调色板（`--Ga0/--Ga1/--Wh0/--Lb5…`）整包换成暗色值，`map.css` 再把它们映射成语义变量（`--bg1/--bg2/--text1/--text2/--graph_bg_thick/--brand_pink`）。于是自适应分两层：

1. **CSS 桥接（零 JS）** —— 本页面的调色板**直接引用 B站 语义变量**：
   `--bg: var(--bg2, #f6f7f8)`、`--card: var(--bg1, #fff)`、`--line: var(--graph_bg_thick, #e3e5e7)`……
   B站 切主题时这些变量自己在变 ⇒ 本页面跟着变，不需要我们做任何事。
2. **JS 判定** —— 只在三处需要知道"当前是不是深色"：状态文字、`color-scheme`（滚动条/下拉控件）、以及 B站 变量缺失时的兜底调色板。判定按可靠性排序：**官方 link → 背景系语义变量亮度 → 通用 dark 标记 → 系统偏好**（*注意别拿 `--text1` 判断亮度，它在浅色下本来就是深色，会正好判反*）。监听用 `MutationObserver`（盯 `head` 的 href 变化）+ `matchMedia` + 1.5s 低频兜底。

设置面板里可切「跟随 B站（默认）/ 强制浅色 / 强制深色」；**强制模式会加 `.bgm-forced` 绕开桥接**（否则在浅色 B站 上"强制深色"会被 B站 的浅色变量顶掉，等于没强制）。顶栏那个 `◐/☀/☾` 按钮点一下循环切换。

同时把结果写到 `<html data-bgm-theme="dark|light">`，外部工具只看 DOM 即可，不必读本脚本内部状态。

### B站 顶栏头像弹层里的状态行（v1.3.0）

点 B站 右上角头像弹出的面板里，本来有一项「主题： 浅色」。我们**用和 B站 完全相同的 class 名**（`.single-link-item` / `.link-title` / `.link-icon`）在同容器插一条状态行：

```
◐ 番剧库： 已接管 · 浅色        ›
```

- 位置：紧跟在 B站 自己那条「主题：」之后（找不到就排最前）
- **一行自定义 CSS 都不用写**：配色、hover、深浅色全部继承 B站 的样式
- 鼠标悬停显示详情（版本 / 数据通路与本次使用情况 / 请求成败 / 缓存月份数 / 当前主题）
- 点它 = 打开设置面板
- 该面板**只有登录后才渲染**，所以插入靠 `MutationObserver` 等它出现，并且**认 id 幂等**（Vue 会复用节点，重复 tick 不会叠加）

### tag 提取：两个字段并集 + 两级白名单（v1.4.0）

Bangumi 的 tag 是**受控小词表**（2023–2026 四年 937 条样本，去重后**只有 53 个词**），所以白名单只能从真实数据里筛，不能凭直觉写。

**v0 列表项给两个 tag 字段 —— 直接并集、一视同仁**：

```
tags      [{name,count} × ≤30]   按票数降序  ┐
                                             ├→ 去重 → 候选词池 → 过白名单取前 2
meta_tags ["TV","日本","原创" × ≤10]  摘要   ┘
```

`meta_tags` 是服务端**精挑摘要**（不是票数 TopN），为了塞进平台/地区会**把题材词挤掉**；`tags` 才是用户投票全量。**只吃任何一个都会漏** —— 例：梅比乌斯之尘的 `meta_tags` 只给 `原创`，而 `科幻(54)` `战斗(29)` 全在 `tags` 里。

| 层 | 词数 | 作用 |
|---|---|---|
| **Tier1 题材** | 27 | 优先显示，同层内按票数先后 |
| **Tier2 来源/受众** | 12 | 一级不够 2 个时补位 |
| **Tier3 平台/地区** | 10 | 兜底，**默认关** |

**为什么 Tier3 默认关**（2026 全四类 744 条实测）：

| 类别 | 条数 | 占比 |
|---|---|---|
| 有 tag | 646 | **86.8%** |
| 空卡 · 两字段都是空数组 | 13 | 1.7% ← 无解 |
| 空卡 · 词池里只有平台/地区词 | 82 | 11.0% ← 开 Tier3 可填，但填进去是 `WEB / 剧场版 / 中国 / 日本` |
| 空卡 · 词池里有白名单外词 | **3** | 0.4% ← 唯一"可补词"候选，而这 3 条的未命中词是 `Albert.Birney`、`三浦莉希`、`山下清悟` —— **全是人名** |

⇒ **补词收益为零**（加人名只会污染词表），而 11% 的兜底词比空着更没信息量。**宁缺毋滥：Tier3 关。**
分类型覆盖率（Tier3 关）：TV 92.5% / OVA 100% / WEB 83.2% / 剧场版 79.4%；开 Tier3 = 97.8%。
那 1.7% "池空"的条目是 `SEALOOK`、`Thomas & Friends`、`吃豆人：零食时间` 这类**欧美网络动画 / 短片** —— Bangumi 上没人投中文 tag，换通路换词表都救不了。

完整方法、词表、频次、陷阱清单见 **[docs/tier-whitelist-design.md](docs/tier-whitelist-design.md)**，接口调用方案见 **[docs/bangumi-v0-api-guide.md](docs/bangumi-v0-api-guide.md)**。

### 交互

| 操作 | 结果 |
|---|---|
| 点卡片 / 标题 | 打开 **B站搜索结果页** `search.bilibili.com/all?keyword=<name_cn 优先>…` |
| 卡片上右键 | 复制该关键词 |
| 顶栏搜索框回车 | 直接跳 B站搜索（保留 B站 表头时用 B站 自己那个搜索框） |
| 悬停封面 | 浮出完整信息：中文名 / Bangumi 评分 / 排名 / 放送日期 |
| ⚙ | 设置面板：**保留 B站 顶栏**、评分/tag/集数开关、**Tier3 兜底开关（默认关）**、**主题（跟随/强制）**、**详情补拉（默认关）**、隐藏无评分、**数据通路（v0 优先）**、并发、单月翻页上限、清缓存、恢复 B站 原页面 |
| Tampermonkey 菜单 | 恢复 B站 原页面（本次会话）、清空 Bangumi 缓存 |

### 加载策略

- **逐月流式 + 懒加载**：进入视口前 400px 才拉该月，其余月份只占位 —— 首屏只发 1–2 个请求。
- **缓存**：命中缓存秒出（当年 12h、历史年份 30d）。
- **空月份直接隐藏**：TV 番集中在 1/4/7/10 月首播，5/6/8/9 月常年 0 部，留着会白占几屏。
- **分类/年份切换**用 `loadToken` 作废旧请求，避免串台。

---

## 二、数据通路（这节是全部坑的所在，务必看）

选数据源的过程比写页面难得多。**v1.4.0 的结论是「v0 优先」**，这一节同时记下走过的弯路。

> ⚠️ **本节推翻 v1.3.0 之前的两条结论**（都是"只测了一个端点就下结论"造成的）：
> ① 「v0 带 query 参数全站 502」——**已恢复**，实测 `HTTP 200 / 3.4~8.8s`，裸请求即可（不校验 UA）；
> ② 「列表接口拿不到内容 tag，必须逐条拉详情」——**只对 p1 成立**。v0 的列表项**自带全量 `tags`**。

### ① `api.bgm.tv/v0/subjects` —— 主力通路（v1.4.0 起）

```
GET https://api.bgm.tv/v0/subjects?type=2&cat=1&year=2026&month=1&limit=100&offset=0
```

列表项**同时**给两个 tag 字段，这正是能拿到内容词的关键：

| 字段 | 是什么 | 形态 |
|---|---|---|
| `tags` | **用户投票的全量词** | ≤30 个 `{name,count,total_count}`，按票数降序；`count` = 该条目上这个词的票数 |
| `meta_tags` | **服务端结构化摘要** | 平台 / 地区 / 来源 / 偶尔一个题材词；⚠️ **带重复，必须 `new Set()` 去重** |

其它实测边界：

| 项 | 结论 |
|---|---|
| `limit` | **≤ 100**（传 200 → `HTTP 400`） |
| `offset` / `total` | `offset` 有效；`total` 是**总条数**（不是页数） |
| UA / CORS | 不校验 UA；**没有 CORS 响应头** ⇒ 仍必须走 `GM_xmlhttpRequest` |
| 体积 / 耗时 | 112 KB / 3.4~8.8 s（24 条）；但 TV 全年 334 条只要 **4 个请求**（p1 要 14 个 + 逐条补拉） |
| 稳定性 | 连续 8 次请求 8/8 成功 |

> 历史插曲：2026-09-19 白天这套端点还全线 502（`/v0/subjects`、`/v0/episodes` 都挂，只有不带参数的详情 / 日历正常，
> 所有社区镜像同源回源失败，`api.bgm.icu` 只是个 "Coming Soon" 占位页）——所以当时只好选了 p1。
> 同日晚间再测已完全恢复。**教训：别用一个端点推断全局，也别把"当时挂了"写死成"这接口不行"。**

### ② `next.bgm.tv/p1/subjects` —— 降级通路

```
GET https://next.bgm.tv/p1/subjects?type=2&cat=1&year=2024&month=7&page=1
```

- **分页参数是 `page`**（`limit` / `offset` / `perPage` / `pageSize` 传了全被忽略）；每页固定 **24** 条，返回的 `total` 是**总页数**
- 不校验 UA / Origin，同样**没有 CORS 响应头** → 必须走 `GM_xmlhttpRequest`
- ⚠️ **列表项只有 `metaTags`（驼峰），没有 `tags`** —— 内容词天生缺失，这是它降为备胎的唯一原因

| p1 字段 | 说明 | 映射到 |
|---|---|---|
| `id` / `name` / `nameCN` | 条目 id、原名、中文名 | 同名字段 |
| `info` | `"12话 / 2024年7月13日 / 北村翔太郎 / …"` | 正则解析出**话数**与**放送日期** |
| `metaTags` | `["校园","TV","恋爱","日本","小说改"]` | 候选词池（没有内容词时也就没得筛） |
| `rating.score` / `.rank` / `.total` | 评分 / 排名 / 评分人数 | 评分徽章与悬停信息 |
| `images.medium`（回退 common/large/small） | 封面 | 卡片封面 |

### ③ 图床 `lain.bgm.tv` 无防盗链

`/r/400/pic/cover/…`、`/r/200/…`、原图都直接 200，带 `Referer: bilibili.com` 也 200 —— 不需要图片代理。卡片仍然加了 `referrerpolicy="no-referrer"` 兜底。

### ④ 脚本的应对：v0 优先 + 零补拉

**v0 优先，p1 兜底**，通路失败自动冷却 60s 换下一个；设置面板可强制指定通路。

由于 v0 列表项已经带全量 `tags`，**整套「详情补拉」机制默认关闭**（`cfg.tagDetail = 'off'`）——
实测详情接口返回的 `tags` 与 v0 列表的 `tags` **逐字节一致**，补拉是纯冗余请求；
而且**两个字段都空的条目，详情也是空的**，补拉救不了任何一张空卡。代码保留，只在 v0 全部挂掉、被迫落 p1 时手动开回来。

> 升级到 v1.4.0 会**自动迁移老配置**：你之前若调过「Tag 补拉 / Tier3 兜底 / 数据通路」，
> 这三项会被重置为新默认（关 / 关 / 自动），否则老配置会一直压着新行为不放。迁移只跑一次，之后你手动改的不会被重置。

顺带纠正两个容易搞错的 B站接口事实（写在这里省得再踩）：`api.bilibili.com/pgc/*` 系列对 `Origin: www.bilibili.com` **放行 CORS**（同域，普通 fetch 可用）；但它的番剧索引 `pgc/season/index/result` **只认 `season_month`（1/4/7/10），`year` 参数不生效** —— 所以它做不了"按年份浏览"，这也是最后没选它当数据源的原因。

---

## 三、已验证结果（2026-09-19）

全部在**真实 `www.bilibili.com/anime/` 页面**上跑通（无头 Edge + 临时 MV3 扩展注入，扩展里实现了 `GM_xmlhttpRequest` 的真背景页语义，见 `tools/e2e-anime.mjs`）。

**首屏（TV / 2026）**

| 指标 | 结果 |
|---|---|
| 接管生效 `html.bgm-takeover` | ✅ |
| 自制容器 `#bgm-anime-root` | ✅ |
| 分类 tab | `TV \| WEB \| OVA \| 剧场版` ✅ |
| 年份 chip | `2026 … 2006` ✅ |
| 月份分组（当年） | `8月1部 / 7月63部 / 6月1部 / 5月2部 / 4月64部 / 3月2部 / 2月2部 / 1月`（**9月 0 部已自动隐藏**）✅ |
| 卡片数 | 135 ✅ |
| 评分徽章 | `7.7 / 8.0 / 8.0 / 7.9 / 7.8 / 7.8 / 7.5 / 7.5 …`（真实 Bangumi 评分）✅ |
| 流派 tag | `冒险 / 奇幻 / 历史 / 战斗 / 后宫 / 校园 / 恋爱` ✅ |
| 集数徽章 | `8集 / 12集 / 10集 / 14集 / 13集` ✅ |
| 封面 | 全部 `lain.bgm.tv` ✅ |
| 卡片链接 | `search.bilibili.com/all?keyword=…` ✅ |

**点击交互（CDP 派发真实鼠标事件）**

| 操作 | 结果 |
|---|---|
| 点「剧场版」tab | 切换成功，打出 2026 剧场版列表（20 张） |
| 点年份「2024」 | 切换成功 |
| 回 TV + 2024 | **116 张卡片**：`12月1部 / 11月2部 / 10月59部 / 9月2部 / 8月2部 / 7月50部` ✅ |
| 剧场版 + 2024 | 35 张：`雄狮少年2`、`指环王：洛汗之战`、`剧场版 进击的巨人 完结篇` ✅ |
| 滚动触发懒加载 | ✅ 卡片 **116 → 225**，11 个月份全部加载（`6月 0 部` 已隐藏） |
| 卡片封面图 | **225 张：ok 214~223 / broken 0 / pending 2~11**（pending 是懒加载、尚未进视口的）✅ |
| 打开设置面板 | ✅ `panelVisible: true`，`panelBg: rgb(255,255,255)`（不透明），统计块正常渲染 |
| 浮层自检（第 8 步） | ✅ 带 `data-bgm-float` 的探针 `display: block`（未被 hide 规则误伤）；无标记探针 `display: none`（hide 规则本身生效）；`--card` 可解析为 `#fff` |
| 保留 B站 顶栏（第 9 步） | ✅ `#biliMainHeader` `display:block`；bar 类名含 `slide-down`、底色 `rgb(255,255,255)`、无渐变、文字 `rgb(24,25,28)`；`headerBottom=64` 且 `rootTop=64`（`noOverlap: true`）；`--bgm-top=64px`、`--bgm-z=1001`（表头 1002）；自有搜索框已收起 |
| B站 表头下拉层叠（第 9 步） | ✅ 真实 hover 一个有下拉的表头项 → 浮层可见、范围 `50..306`（**伸到表头下方 242px**），证明它确实浮在内容区之上、没被 `z-index:1001` 的容器盖住 |
| 关掉保留顶栏（第 10 步） | ✅ 取消勾选后 `#biliMainHeader display:none`、`rootTop=0`、`--bgm-z` 回 21 亿、自有搜索框回来；勾回来又恢复 `rootTop=64`（**可逆**） |
| 页面 JS 错误 | ✅ 来自**本脚本 0 条**（见下方关于"假绿"的说明） |

> ⚠️ **上一版这里写着"JS 错误 0 条"，那是个假绿。** 当时的验证脚本读的是 `window.__bgmErrors`，而**这个变量脚本里从来没定义过** —— `undefined \|\| []` 于是一直打印 `[]`，等于什么都没验。
> 现在改成收 **CDP 原生事件**（`Runtime.exceptionThrown` + `Log.entryAdded`）：本轮实测未捕获异常 4~7 条，**全部是 B站 自家采集 SDK 的 `Error: COLS: response timeout`**，归到本脚本的 **0 条**；`console.error` / 网络错误 0 条。
> 顺带修了同一类问题的另一处：`window.__BGM_ANIME__` 之前只写在油猴沙箱的 `window` 上，**F12 控制台和 CDP 都读不到**（那和页面 `window` 不是同一个对象）。现已加 `@grant unsafeWindow` 真正挂到页面上，"控制台可调试"这才成立。

> 验证时靠截图抓到过一个真实 bug：隐藏 B站页面的 CSS 写的是 `body > *:not(#bgm-anime-root)`，把我自己挂在 body 下的**设置面板和 toast 一起隐藏了**（DOM 存在、点击有效、但看不见）。已改为排除 `[data-bgm-float]` 浮层标记。
>
> 第二次截图又抓到同源的另一个 bug：主题变量（`--card` / `--text` / `--line` …）原本只声明在 `#bgm-anime-root` 上，而设置面板和 toast 是挂在 `document.body` 下的**浮动层**（在 root 之外）⇒ 面板内的 `var(--card)` 解析失败，**背景变成完全透明**，底下的番剧封面直接透过面板显示出来（DOM 和点击都正常，纯视觉缺陷）。已把变量上移到 `html.bgm-takeover`，浮动层靠继承取到变量。
>
> 顺带修掉一个更隐蔽的：复制回退路径的临时 `<textarea>` 也挂在 body 下，会被 `hideCss()` 设成 `display:none !important`，而**隐藏的 textarea 无法 `select()`** ⇒ 在非安全上下文里右键复制会静默失败。已加 `data-bgm-float` 标记。
>
> 这三个是**同一族**：全都是"挂在共同祖先之外的东西，拿不到只声明在容器里的规则/变量/层叠顺序"。规律记一下 —— **凡是会"逃出容器"的浮层（设置面板、toast、临时节点），它需要的 CSS 变量、z-index 层级、以及"别把我藏起来"的排除标记，都必须定义在两边的公共祖先上。**

保留 B站 表头后，B站 自己的下拉浮层正常浮在我的内容之上（下图里是它的访客登录提示卡，压在我的月份网格上）：

![表头浮层压在我的内容之上](docs/shot-anime-header-popover.png)

修复后的设置面板（不透明、浮层未被误伤、第一行就是「保留 B站 顶栏」）：

![设置面板](docs/shot-anime-settings.png)

> 为避免这类"只有肉眼能发现"的缺陷再次溜过，`tools/e2e-anime-cdp.mjs` 现在会自动跑第 8 步**浮层可见性自检**：插入一个带 `data-bgm-float` 的探针（应 `display: block`）+ 一个无标记探针（应 `display: none`），并断言面板 `backgroundColor` 不是全透明、`--card` 能解析出值。以后 UI 改动跑一遍就知道有没有踩同一类坑。
>
> 第 9 / 10 步则是**保留 B站 顶栏**的专项断言（几何 / 皮肤 / 层叠 / 可逆），见上表。

### v1.4.0 专项验证（v0 通路 / 零补拉 / 配置迁移）

`node tools/e2e-anime-cdp.mjs`（全量回归）+ `node tools/check-migration.mjs`（配置迁移）全绿：

| 断言 | 结果 |
|---|---|
| 通路使用 | `netStats.bySource = { v0: 32 }` —— **全部走 v0**，0 失败 ✅ |
| 详情补拉次数 | **0 次**（v1.3.0 时约 33% 的卡片会触发）✅ |
| tag 覆盖率（混合采样 279 张） | 2 个 tag 202 / 1 个 20 / 0 个 57 = **80%**（离线权威口径：2026 全四类 744 条 **86.8%**）✅ |
| 设置面板统计块 | `通路使用：v0×32` / `详情补拉：关` / `T3 平台·地区 关` / `主题：跟随 B站 · 判定为浅色` ✅ |
| 空卡构成审计 | `node tools/empty-card-audit.mjs`：池空 13 条 (1.7%) / 仅平台·地区词 82 条 (11.0%) / 白名单外词 **3 条 (0.4%，且全是人名)** ⇒ 补词收益为零 ✅ |
| 配置迁移 | 塞一份 v1.3.0 老配置（`tagDetail:'fill'` / `showTier3:true` / `source:'p1'`）→ 重载后自动纠成 `off / false / auto` + `cfgV:2` ✅ |
| 迁移只跑一次 | 迁移后手动打开 Tier3 → 重载**不被重置** ✅ |
| 本脚本 JS 异常 | 0 条 ✅ |

> 顺带修了两处**测试自身**的问题（都不是产品 bug）：
> ① v1.3.0 给工具栏加了主题按钮，它和齿轮共用 `.bgm-ibtn` 且**排在前面** ⇒ E2E 的 `clickSel('.bgm-ibtn')` 点到的是主题按钮，造成「设置面板打不开」「第 10 步 checkbox 读不到」两个假失败（还顺带把主题切成了强制深色，`htmlClasses` 里多出 `bgm-forced bgm-dark`）。已给齿轮加 `#bgm-gear-btn`，测试改按 id 定位。
> ② `tagDetail` 关掉后，E2E 第 5.5 步还在傻等 28 秒"等补拉跑完"。已删掉这段空转。

### v1.3.0 专项验证（主题 / 状态行 / 两级白名单）

`node tools/e2e-theme.mjs` —— 在真实 B站 页面注入真实脚本，**并真的把 B站 的主题 CSS 从 `light.css` 换成 `dark.css`**（= 用户点「主题： 深色」做的事），全绿：

| 断言 | 结果 |
|---|---|
| B站 默认浅色下的判定链 | `themeLink=…/light.css`、`html.bgm-light`、`data-bgm-theme=light`、非强制模式 ✅ |
| **浅色·真像素** | 我们顶栏那条带 `rgb(255,255,255)`（众数占比 0.97）、整页暗像素占比 **0.20** ✅ |
| 切到 dark.css 后 | `html.bgm-dark`、`data-bgm-theme=dark`、`--bgm-bg: #101011`（= B站 `--bg2`）、内容区底色 `rgb(16,16,17)` ✅ |
| **深色·真像素** | 顶栏带 `rgb(36,38,40)`、整页暗像素占比 **0.75** ✅ |
| 切回浅色 | 双向都跟得上（证明观察器真的在听，不是只在启动时判一次）✅ |
| 主题按钮 | 跟随模式显示 `◐` 且 title 写明"当前判定为深色" ✅ |
| **强制深色（B站 仍浅色）** | `bgm-forced` 生效、内容区 `rgb(23,24,26)`、按钮 `☾`、卡片照常渲染 ✅ |
| 状态行注入 | 插进 B站 头像弹层、文案「番剧库： 已接管 · 浅色」、**排在 B站「主题：」那条之后**、沿用 `single-link-item`、**重复 tick 不叠加**（找到 1 条）、主题切换时文字跟着变「深色」✅ |
| 卡片回归 | 133 张卡片 / 266 个 tag chip / **空 tag 卡片 0 张**（当时 Tier3 兜底是开的；v1.4.0 默认关掉后约 11% 的卡会空着，见上）✅ |
| 本脚本 JS 异常 | **0 条**（宿主 B站 自己的 `COLS: response timeout` 已按来源过滤）✅ |

> 这一轮又复用了同一条教训：**计算样式说"深色"不等于画出来是深色**。所以 `tools/png-pixel.mjs`（零依赖 PNG 解码）被引入，E2E 现在直接断言**真像素**的 rgb —— 颜色/可见性类改动一律如此验，不再只看 `getComputedStyle`。

---

## 四、开发者

```
bili-anime-replace.user.js                脚本本体（单文件，v1.4.0，含 __BGM_ANIME__ 调试钩子）
docs/bangumi-v0-api-guide.md              ★ v0 列表接口完整方案（请求/字段/清洗四步/词表/坑清单/最小实现，可移植）
docs/tier-whitelist-design.md             二级白名单设计方案（可移植：方法 + 词表 + 陷阱清单）
docs/bangumi-list-api-facts.md            接口字段事实（tags vs meta_tags 真实样本 + 参数语义对照）
tools/e2e-anime.mjs                       E2E：临时 MV3 扩展（含 GM_xhr 背景页桥接）+ 无头 Edge + DOM 统计
tools/e2e-anime-cdp.mjs                   交互 E2E：CDP 派真实鼠标事件 + ✓/✗ 断言；第 1~7 步功能、第 8 步浮层可见性、
                                          第 9 步保留表头（几何/皮肤/层叠）、第 10 步可逆性；错误靠 CDP 原生事件收
tools/e2e-theme.mjs                       主题 E2E：真把 B站 主题 CSS 换成 dark.css → 验判定链/桥接变量/真像素/状态行
tools/check-settings.mjs                  设置面板自检：新增项（Tier3 开关 / 主题）与统计块是否渲染、面板底色是否不透明
tools/check-migration.mjs                 ★ 配置迁移验证：塞 v1.3.0 老配置 → 断言被纠正、且只跑一次
tools/png-pixel.mjs                       零依赖 PNG 像素读取（断言"画出来是什么颜色"，不只信计算样式）
tools/probe-theme.mjs                     主题机制探针：逐个施加 candidate 标记看背景是否变深 + 反查 B站 样式表里的暗色规则
tools/probe-list-fields.mjs               v0 / p1 列表接口字段并排对比
tools/probe-v0-tags.mjs                   v0 `tags` 形态 + `meta_tags` 重复规律 + limit 上限
tools/probe-v0-round2.mjs                 limit 上限 / p1↔v0 同源性 / 各分类可用性
tools/probe-v0-health.mjs                 v0 稳定性、UA 要求、耗时体积
tools/coverage-union.mjs                  三口径（仅 meta_tags / 仅 tags / 并集）× 分类型覆盖率
tools/coverage-with-full-tags.mjs         用全量 tags 重算覆盖率
tools/empty-card-audit.mjs                ★ 空卡构成审计：池空 / 只有平台·地区词 / 白名单外词 三分类 + 未命中词频次
                                          （词表从 .user.js 现抽，永远与脚本同源）
tools/whitelist-tiers.mjs                 两级白名单构建 + 边际贡献度 + 覆盖率评估
tools/tag-tier-audit.mjs                  逐条审计：每条命中哪级哪些 tag + 未命中词频次（附 HTML 分级视图）
tools/tag-freq.mjs  tag-freq-merged.mjs   列表 tag 频次（带年份缓存，二次零请求）
tools/whitelist-coverage.mjs              多候选白名单方案的 99%/100% 补词贪心
tools/tag-audit.mjs  tag-audit-detail.mjs 白名单命中分布审计
tools/probe-tags.mjs  dump-empty-tags.mjs 空条目逐条详情原样打印
tools/sniff-api.mjs                       CDP 抓包：拿真实网页发出的 XHR 参数
```

```bash
node tools/e2e-anime.mjs "https://www.bilibili.com/anime/" --budget=45000
node tools/e2e-anime-cdp.mjs "https://www.bilibili.com/anime/"
node tools/e2e-theme.mjs                              # 主题 + 状态行 + 白名单回归
node tools/check-migration.mjs                        # 配置迁移（塞老配置 → 断言纠偏 + 只跑一次）
node tools/empty-card-audit.mjs 2026                  # 空卡构成 + 补词判据（读缓存，零请求）
node tools/whitelist-tiers.mjs 2026,2025,2024,2023 --eval=2024
node tools/tag-tier-audit.mjs 2023                    # 逐条审计（读缓存，零请求）
```

**GM_xhr 未就绪时的降级**：脚本在无 `GM_xmlhttpRequest` 的环境里会退回 `fetch`，但 `api.bgm.tv` / `next.bgm.tv` 都没有 CORS 头，**此时页面内必然取不到数据**（会显示"加载失败 + 重试"）。这是环境限制，不是脚本 bug —— 正常装在 Tampermonkey 里不会遇到。

**调试钩子**：页面 F12 控制台里 `__BGM_ANIME__` 暴露 `parseInfo / pickTags / hasGenreTag / displayTitle / searchKeyword / normScore / fromP1 / fromV0 / monthsOf / compareItems / loadMonth / activeSources / netStats / view / selectMode / selectYear / startTakeover / stopTakeover / applyShellMode / syncHeaderVars / headerBar / hideCss`，以及主题与状态行模块 `luminance / detectDark / applyTheme / onTheme / themeDark() / syncThemeBtn / ensureStatusItem / updateStatusItem / statusLabel / statusTip`。白名单数据 `TAG_T1 / TAG_T2 / TAG_T3 / TAG_GROUP / TAG_WHITELIST` 也在上面，可直接在控制台调 `pickTags(['TV','日本','奇幻'], 2)` 验证分级效果。
（⚠️ 必须经 `unsafeWindow` 挂到页面 window 才算数 —— 油猴沙箱里的 `window` 和页面 `window` 不是同一个对象，只写沙箱那份的话控制台里读不到。）

**待办**：`WEB/OVA/剧场版` 在历史年份的覆盖抽查；**登录态下实机确认 B站 头像弹层里的状态行**（E2E 用的是符合 B站 CSS 契约的桩容器，未登录时该面板不渲染）；**GitHub 改动后同步 Greasy Fork**（Greasy Fork 不会自动拉本仓库，手动上传 `bili-anime-replace.user.js` 或配 Webhook）。

> **Greasy Fork 提交注意**：脚本元数据同时给了 `@name` / `@name:en` / `@description` / `@description:en`。**只要出现了任一带语言后缀的键（如 `@name:en`），Greasy Fork 就会为该语言建一个本地化条目，此时该语言的 `@description:xx` 也必须有值**，否则报「@description:en 不能为空字符」。若不想维护英文描述，直接删掉 `@name:en` 即可。

---

## 五、声明

数据来自 [Bangumi 番组计划](https://bgm.tv) 公开 API，仅供个人浏览参考；评分版权归 Bangumi 及其用户所有。脚本只在你本地隐藏 B站番剧区的展示并渲染自有内容，不修改 B站任何数据、不伪造请求、不绕过会员或付费限制。B站搜索完全是普通搜索跳转。
