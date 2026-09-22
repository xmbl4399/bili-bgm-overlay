// ==UserScript==
// @name         B站番剧区 → Bangumi 番剧浏览页
// @name:en      Bilibili Anime Section → Bangumi Browser
// @namespace    https://github.com/xmbl4399/bili-bgm-overlay
// @version      1.6.7
// @description  拦截 www.bilibili.com/anime/，把番剧区换成自制的 Bangumi 浏览页：TV/WEB/OVA/剧场版 + 日剧/欧美剧/华语剧/韩剧/电影 九分类、年份栏 + 月份倒序分组、封面评分/流派徽章；默认保留 B站 自己的顶栏（首页/番剧/搜索/头像），内容区排在它下面；主题跟随 B站 自己的深/浅色开关；在 B站 头像弹层里放一条状态行；点击卡片跳 B站搜索，右键复制标题。数据源以 api.bgm.tv/v0 为主（列表接口自带全量 tags，一次请求即可筛出流派），失败时自动回落 next.bgm.tv/p1。
// @description:en  Replaces Bilibili's anime section with a Bangumi browsing page: TV/WEB/OVA/Movie plus Japanese/Western/Chinese drama and live-action film categories, year bar, month groups in reverse order, and cover badges for score and genre tags. Keeps Bilibili's own header and follows its dark/light switch. Data from api.bgm.tv/v0, falling back to next.bgm.tv/p1.
// @author       xmbl4399
// @homepageURL  https://github.com/xmbl4399/bili-bgm-overlay
// @supportURL   https://github.com/xmbl4399/bili-bgm-overlay/issues
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @match        https://www.bilibili.com/anime/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      next.bgm.tv
// @connect      api.bgm.tv
// @run-at       document-start
// @noframes
// ==/UserScript==

/**
 * 设计规格（1:1 对齐 PiliPlus 的 lib/pages/bangumi_browse/ 与 blbl 的新番表）
 *
 * 页面结构  二级 tab（TV/WEB/OVA/剧场版/日剧/欧美剧/华语剧/韩剧/电影，共 9 个）→ 年份栏（横向 chip）→ 月份倒序分组（{m}月 · N 部）
 * 表头     默认**保留 B站 自己的那排顶栏**（首页/番剧/直播/搜索/头像…），内容区下移到它下面；
 *           做法是给 `.bili-header__bar` 补上 B站 自身的 `slide-down`（实底皮肤），不自己覆盖它的配色。
 *           见下方 §4b —— 侧栏设置里可关掉，关掉就退回"整页铺满、连表头一起藏"。
 * 顶栏适配 9 个分类在 720P 下要挤在一行 ⇒ 尺寸全走 clamp() 连续收缩、tab 行允许横向滚动
 *           （绝不 wrap），品牌文字在窄屏让位只留圆点。见 §5「顶栏」的算例注释。
 * 卡片      封面 3:4；右上角评分徽章（≥7 金色 #FFD54F，否则白 70%）；左上角流派 tag（白名单，最多 2）
 *           左下角集数（仅 TV）；标题 2 行省略
 * 交互      点击卡片 → B站搜索结果页（关键词 name_cn || name）；右键/长按 → 复制关键词
 * 加载      逐月流式：进入视口才拉该月，命中缓存秒出（当年 12h / 历史年 30d）
 *
 * 数据通路（2026-09 实测）
 *   ① next.bgm.tv/p1/subjects?type=&cat=&year=&month=&page=N   ← 每页 24 条，total=页数
 *   ② api.bgm.tv/v0/subjects?type=&cat=&year=&month=&limit=&offset=  ← 每页 100 条
 *   两个接口都无 CORS 头，浏览器必须走 GM_xmlhttpRequest（特权请求）。
 *   2026-09-19 复测：v0 **已恢复 200**（旧记录"带 query 全站 502"作废）⇒ 改为 v0 优先、p1 兜底。
 *
 * 分类枚举（2026-09-20 实测，探针见 tools/probe-*.mjs）
 *   动画 type=2：cat 1=TV 2=OVA 3=剧场版 5=WEB（沿用 PiliPlus）
 *   真人 type=6：cat 1=日剧 2=欧美剧 3=华语剧；**cat≥4 一律 HTTP 400**
 *               电影**无 cat**，必须走"不带 cat + 前端 platform 过滤"
 */

(function () {
  'use strict';

  const VERSION = '1.6.7';
  const NS = 'bgmanime';
  const UA = `bili-anime-replace/${VERSION} (+https://github.com/xmbl4399/bili-bgm-overlay)`;

  /** 年份下限（PiliPlus: kBangumiEarliestYear） */
  const EARLIEST_YEAR = 2006;

  /**
   * 分类定义。两种拉取形态（2026-09-20 实测，脚本与说明见 tools/probe-*.mjs）：
   *
   *   ① `cat` 有值 → `type+cat+year+month`：**月索引生效且平台纯净**
   *      （type=2 的 cat=1 只出 TV；type=6 的 cat=1 只出「日剧」，无杂项）
   *   ② `cat: null` → `type+year+month`：**月索引同样生效**（实测电影 date 全落在所查月），
   *      但会混入该 type 的所有平台 ⇒ 必须**前端按 `platform` 过滤**
   *
   * ★ 真人影视（type=6）实测 platform 全集（**只有这 8 种，没有「韩剧」「美剧」**）：
   *     日剧 / 欧美剧 / 华语剧 / 电影 / 演出 / 其他 / 电视剧 / 综艺
   *   - 韩剧在 Bangumi **没有独立分类**，被归入 `platform="电视剧"`（混合容器，
   *     靠 tag/meta_tags 里的「韩国」区分，与「美剧」等混放）⇒ 只能做**近似**：
   *     `platform=电视剧` + `tagFilter` 命中「韩国」（见 `applyModeFilter` 注释）。
   *   - `演出 / 综艺 / 其他` 不是影视剧，**不纳入**。
   *
   * `filter`: 按 `platform` 做前端过滤（正则，大小写不敏感）
   * `tagFilter`: 按**候选词池** `tagPool` 做前端过滤（正则；与 `filter` 是 **AND** 关系）
   */
  const MODES = [
    // —— 动画 type=2：cat 干净，服务端即分类 ——
    { key: 'tv', label: 'TV', type: 2, cat: 1, showTags: true, showEpisodes: true },
    { key: 'web', label: 'WEB', type: 2, cat: 5, showTags: true, showEpisodes: false },
    { key: 'ova', label: 'OVA', type: 2, cat: 2, showTags: true, showEpisodes: false },
    { key: 'movie', label: '剧场版', type: 2, cat: 3, showTags: true, showEpisodes: false },
    // —— 真人剧集 type=6：cat=1/2/3 = 日剧 / 欧美剧 / 华语剧 ——
    { key: 'jdrama', label: '日剧', type: 6, cat: 1, showTags: true, showEpisodes: false },
    { key: 'wdrama', label: '欧美剧', type: 6, cat: 2, showTags: true, showEpisodes: false },
    { key: 'cdrama', label: '华语剧', type: 6, cat: 3, showTags: true, showEpisodes: false },
    // —— 韩剧：Bangumi 无该 platform，只能 platform=电视剧 + tag 含「韩国」（见 applyModeFilter）——
    { key: 'kdrama', label: '韩剧', type: 6, cat: null, filter: /^电视剧$/, tagFilter: /韩剧|韩国|韩语/, showTags: true, showEpisodes: false },
    // —— 真人电影：不带 cat，按 platform 过滤 ——
    { key: 'film', label: '电影', type: 6, cat: null, filter: /^电影$/, showTags: true, showEpisodes: false },
  ];

  /**
   * 两级（+可选第三级）流媒体 tag 白名单 —— **数据驱动，可整段复制到其他项目**。
   *
   * 由来：Bangumi 的 tag 是**受控小词表**——2023~2026 四年 937 条样本去重后只有 53 个不同词。
   *      所以白名单必须「从这 53 词里筛」，而不是凭直觉写词。
   *
   *   Tier1 题材      27 词 → 卡片**优先显示**；也是「这张卡有没有内容 tag」的判据
   *   Tier2 来源/受众 12 词 → 一级没词时兜底；一级只出 1 个时用来**补满第 2 格**
   *   Tier3 平台/地区 10 词 → 最后兜底，**默认关**（cfg.showTier3）
   *                           只有它能把覆盖率顶到 ~98%，代价是卡上会出现「TV / 日本」
   *                           这类零信息量的词 ⇒ 主人定案：**宁缺毋滥，默认不用兜底**
   *
   * 覆盖率实测（2026 全四类 744 条，口径 meta_tags ∪ tags）：仅 T1 60~83% ｜ T1+T2 79~100%
   *   TV 82.9/92.5 ｜ WEB 70.2/83.2 ｜ OVA 85.7/100 ｜ 剧场版 60.3/79.4
   * 排除在外的词：短片集 / 短片（形式）、R18（分级）—— 它们不是题材，显示出来没信息量。
   * 空白卡片的真实成因：**两个字段都是空的条目**（2026 有 31 条），集中在 WEB 的欧美网络动画 /
   *   短片 / 真人 4D（SEALOOK、史努比露营、Thomas & Friends…）—— Bangumi 上没人投中文 tag，
   *   换通路换词表都救不了，只能空着。
   *
   * ⚠️ 复用注意：换站/换接口时重新跑一遍 `tools/tag-freq.mjs` 得到**真实词汇表与频次**，
   *    再按「题材 / 来源 / 受众 / 平台 / 地区」归类，不要沿用这里的词表。
   */
  const TAG_T1 = [
    '奇幻', '战斗', '恋爱', '日常', '校园', '科幻', '喜剧', '玄幻',
    '冒险', '悬疑', '百合', '穿越', '运动', '音乐', '历史', '剧情',
    '后宫', '武侠', '推理', '职场', '机战', '美食', '萌系', 'BL',
    '恐怖', '惊悚', '耽美',
  ];
  const TAG_T2 = [
    '漫画改', '原创', '小说改', '游戏改', '少年向', '青年向', '子供向', '女性向',
    '少女向', '同人', '影视改', '乙女',
  ];
  const TAG_T3 = [
    '日本', 'TV', 'WEB', '中国', '剧场版', '欧美', '美国', 'OVA', '法国', '韩国',
  ];
  const TAG_T1_SET = new Set(TAG_T1);
  const TAG_T2_SET = new Set(TAG_T2);
  const TAG_T3_SET = new Set(TAG_T3);
  /** 语义分组：只用于设置面板/文档展示，不参与筛选逻辑 */
  const TAG_GROUP = new Map([
    ...TAG_T1.map(t => [t, '题材']),
    ...TAG_T2.map(t => [t, /向|乙女/.test(t) ? '受众' : '来源']),
    ...TAG_T3.map(t => [t, /TV|WEB|OVA|剧场版/.test(t) ? '平台' : '地区']),
  ]);
  /** 扁平表（兼容旧调用/外部工具） */
  const TAG_WHITELIST = [...TAG_T1, ...TAG_T2, ...TAG_T3];

  /**
   * 数据通路：按顺序尝试，失败的会被临时标记冷却。
   *
   * ★ v0 必须排在首位（2026-09-19 实测后定序）。两条通路的**字段能力不对等**：
   *   v0 `api.bgm.tv/v0/subjects`    → 列表项**同时**带 `tags`（≤30 个全量投票词，
   *                                    `{name,count,total_count}`）与 `meta_tags`（服务端摘要）
   *   p1 `next.bgm.tv/p1/subjects`   → 列表项**只有** `metaTags`（0/148 条带 tags），
   *                                    没有内容词 ⇒ 只能靠逐条拉详情补
   * ⇒ v0 优先 = 一次请求拿到全部 tag，**详情补拉整套机制都用不上了**；
   *   v0 挂了再落 p1（能力退化，但页面不崩）。详见 `docs/bangumi-v0-api-guide.md`。
   */
  const SOURCES = [
    { id: 'v0', base: 'https://api.bgm.tv', label: 'v0' },
    { id: 'p1', base: 'https://next.bgm.tv', label: 'p1' },
  ];

  const DEFAULTS = {
    enabled: true,
    mode: 'tv',              // 当前分类
    keepHeader: true,        // 保留 B站 自己那排顶栏（首页/番剧/搜索/头像…），内容区下移到它下面
    showTags: true,
    showEpisodes: true,
    showScore: true,
    hideNoScore: true,       // 隐藏无评分条目（默认开）
    /**
     * Tier3（平台/地区）兜底：列表只给「TV/日本」这类零信息量的词时，是否拿它填卡片槽位。
     *   true  → 覆盖率能顶到 ~98%（2026 四类），代价是卡上出现「TV / 日本」
     *   false → **宁可空着**（约 15~20% 的卡片没有 tag）← 默认，主人定案
     */
    showTier3: false,
    /**
     * 主题：auto = 跟随 B站 自己的深/浅色开关（页面里那个「主题：浅色」）；
     *       light / dark = 强制。auto 失效时才回退系统 prefers-color-scheme。
     */
    theme: 'auto',
    /**
     * 详情补拉（**默认关**，v0 通路下不需要）。
     *
     * 历史：v0 长期被误判为不可用，只能走 p1，而 p1 列表项没有 `tags` ⇒ 内容词天生缺失
     *      （实测约 33% 的卡片筛不出题材词），于是加了「按需拉单条目详情」这套机制。
     * 现状：v0 已恢复可用且列表项就带全量 `tags`，**且详情返回的 tags 与 v0 的 tags 逐字节一致**
     *      ⇒ 补拉 100% 冗余；两字段都空的条目，详情也是空的，补拉救不了。
     * 保留此开关只为「v0 全挂、被迫回落 p1」时手动开回来。
     *   off   = 不补拉 ← 默认
     *   empty = 仅当筛出 0 个时补拉
     *   fill  = 没有题材词就补拉
     */
    tagDetail: 'off',
    source: 'auto',          // auto | p1 | v0
    ttlHoursThisYear: 12,
    ttlDaysPastYear: 30,
    concurrent: 2,           // 每月拉取的并发上限
    maxPages: 12,            // 单月翻页安全上限（24×12=288 条）
    pageSize: 24,            // p1 固定 24；v0 为 100
    /**
     * 封面宽度档位 —— 单位 px，0 = 原图。
     *
     * ⚠️ 只接受 lain.bgm.tv 支持的**离散档位** 100/200/400/600/800（r50/r150/r300 实测 HTTP 400）。
     * 卡片列宽 132px（窄屏 104px）⇒ 1× 屏 100 够、2× 屏 200 紧、3× 屏 400 足。
     * 档位不烘进缓存 URL，改这里**对已缓存月份立刻生效**（见 pickCover / withCoverWidth）。
     */
    coverQuality: 200,
  };

  /* ==================================================================== *
   * 0. 环境探针
   * ==================================================================== */

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const hasGMXhr = typeof GM_xmlhttpRequest === 'function';

  /* ==================================================================== *
   * 1. 存储层（GM_* 优先，降级 localStorage）
   * ==================================================================== */

  const store = {
    get(key, fallback) {
      try {
        const raw = hasGM ? GM_getValue(`${NS}:${key}`, null)
                          : localStorage.getItem(`${NS}:${key}`);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try {
        const raw = JSON.stringify(value);
        if (hasGM) GM_setValue(`${NS}:${key}`, raw);
        else localStorage.setItem(`${NS}:${key}`, raw);
      } catch (e) {}
    },
    del(key) {
      try {
        if (hasGM) { if (typeof GM_deleteValue === 'function') GM_deleteValue(`${NS}:${key}`); }
        else localStorage.removeItem(`${NS}:${key}`);
      } catch (e) {}
    },
    clearCache() {
      const idx = store.get('cacheKeys', []);
      idx.forEach(k => store.del(k));
      store.set('cacheKeys', []);
      return idx.length;
    },
    /**
     * 登记一个缓存键。
     * ⚠️ 索引上限 2000 条，溢出时**必须连同数据一起删掉**被挤出的键：
     *    只做 `slice(-2000)` 的话，那些键会「数据还在、索引没了」，
     *    「清空缓存」永远遍历不到它们 ⇒ **永久泄漏**。
     *    （9 分类 × 12 月 × 约 20 年 ≈ 2100+ 条，已经把 2000 顶到边上。）
     */
    rememberKey(k) {
      const idx = store.get('cacheKeys', []);
      if (idx.includes(k)) return;
      idx.push(k);
      const CAP = 2000;
      if (idx.length > CAP) {
        const evicted = idx.slice(0, idx.length - CAP);
        for (const old of evicted) store.del(old);   // ← 淘汰 = 真删，而不是只丢索引
        idx.splice(0, idx.length - CAP);
      }
      store.set('cacheKeys', idx);
    },
  };

  /**
   * 配置迁移 —— 老版本存在 GM/localStorage 里的配置会**盖掉新默认值**，必须显式纠偏。
   *
   * v2（2026-09-19）v0 通路上位：
   *   数据源从「p1 优先」改为「v0 优先」，而 v0 列表**自带全量 tags**
   *   ⇒ ① 详情补拉变成纯冗余请求 → 关掉（tagDetail='off'）
   *     ② Tier3 兜底关掉（主人定案：卡片上不显示「TV/日本」这类零信息量词）
   *     ③ 通路归位 auto（老配置若锁死 p1，就永远拿不到 tags）
   */
  const CFG_VERSION = 2;
  const cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}));
  if (Number(cfg.cfgV) !== CFG_VERSION) {
    cfg.tagDetail = DEFAULTS.tagDetail;
    cfg.showTier3 = DEFAULTS.showTier3;
    cfg.source = DEFAULTS.source;
    cfg.cfgV = CFG_VERSION;
    store.set('cfg', cfg);
  }
  const saveCfg = () => store.set('cfg', cfg);

  /* ==================================================================== *
   * 2. 纯函数：info 解析 / 标题 / tag 过滤 / 统一模型
   * ==================================================================== */

  const pad2 = n => String(n).padStart(2, '0');

  /**
   * 解析 p1 的 info 字段。
   * 形如 "12话 / 2024年7月13日 / 北村翔太郎 / 雨森たきび…"，也可能没有话数：
   * "2026年4月5日 / 尾田栄一郎"
   */
  function parseInfo(info) {
    const s = String(info == null ? '' : info);
    let episodes = null;
    const em = s.match(/(\d{1,4})\s*话/);
    if (em) episodes = parseInt(em[1], 10);

    let date = '';
    const dm = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (dm) date = `${dm[1]}-${pad2(dm[2])}-${pad2(dm[3])}`;
    else {
      const ym = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      if (ym) date = `${ym[1]}-${pad2(ym[2])}-01`;
      else {
        const y = s.match(/(\d{4})\s*年/);
        if (y) date = `${y[1]}-01-01`;
      }
    }
    return { episodes, date };
  }

  /** 从 p1 / v0 各种形态里抽 tag 名称数组 */
  /**
   * tag 列表 → 纯词数组（字符串与 `{name,…}` 对象都吃），**保持首次出现顺序并去重**。
   *
   * ⚠️ 去重是**必须**的：v0 的 `meta_tags` 有服务端重复 bug（实测 60 条里 21 条，
   *    形如 `["TV","TV","日本","日本","奇幻","奇幻"]`，倍数 2×~6× 不定、不严格相邻成对）。
   *    p1 的 `metaTags` 无此问题，但统一去重无害。
   */
  function rawTagNames(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const t of v) {
      const name = typeof t === 'string' ? t
        : (t && typeof t === 'object' && typeof t.name === 'string') ? t.name : '';
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }

  /**
   * 分级白名单过滤：Tier1 题材 → Tier2 来源/受众 → (可选) Tier3 平台/地区。
   * 一、二级**依次拼接**（题材永远排在前面，二级用来补满槽位）；只有前两级都没词时才用三级。
   * 这样卡片槽位不会因为「只有 1 个题材词」而空一半。
   */
  function pickTags(names, n = 2) {
    const uniq = [...new Set(rawTagNames(names))];
    const pick = set => uniq.filter(t => set.has(t));
    let out = [...pick(TAG_T1_SET), ...pick(TAG_T2_SET)];
    if (out.length < n && cfg.showTier3 !== false) out = out.concat(pick(TAG_T3_SET));
    return out.slice(0, n);
  }

  /** 该条目是否命中「题材词」（Tier1）—— 卡片显示质量 / 要不要拉详情都看它 */
  const hasGenreTag = names => rawTagNames(names).some(t => TAG_T1_SET.has(t));

  /** 标题显示：优先中文名；无中文名且含 " - " 时只取主标题（PiliPlus: displayTitle） */
  function displayTitle(nameCn, name) {
    const source = (nameCn && nameCn.trim()) || (name && name.trim()) || '';
    if (!nameCn && source.includes(' - ')) return source.slice(0, source.indexOf(' - '));
    return source;
  }

  /** 搜索关键词：name_cn 优先，否则原名（PiliPlus: searchKeyword） */
  const searchKeyword = (nameCn, name) => (nameCn && nameCn.trim()) || name || '';

  /** 量化评分：NaN / 0 / 负数 → null（视为无评分） */
  function normScore(raw) {
    const v = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (typeof v !== 'number' || Number.isNaN(v) || v <= 0) return null;
    return v;
  }

  const BGM_WEB = 'https://bgm.tv/subject/';

  /**
   * 封面宽度档位 —— lain.bgm.tv 的 /r/<N>/ 是**离散档位**，不是任意宽度。
   *
   * ★ 实测（2026-09-21 · 2026 年 7 月新番 79 部）：
   *     r50 / r150 / r300 → **HTTP 400**；可用档位只有 100 / 200 / 400 / 600 / 800。
   *     单张字节：r100 6.2 KB ｜ r200 20.5 KB ｜ r400 71.0 KB ｜ r600 147.7 KB ｜ r800 241.7 KB
   *     79 部总体积：r100 0.43 MB ｜ r200 1.3 MB ｜ r400 4.2 MB ｜ r800 12.4 MB（**29 倍**）
   *
   *   卡片列宽 minmax(132px,1fr)（窄屏 104px）⇒ 1× DPR 需约 132px、2× 约 264px、3× 约 396px。
   *   ⇒ r400 覆盖 3× DPR；r200 只够 2× DPR 且偏紧；r100 仅够 1× DPR（高分屏会糊）。
   */
  const COVER_TIERS = [100, 200, 400, 600, 800];

  /** 把封面 URL 改写成指定宽度；w = 0 表示原图（剥掉 r/<N> 段） */
  function withCoverWidth(url, w) {
    if (!url) return '';
    const s = String(url);
    const m = s.match(/^https?:\/\/[^/]+/);
    const origin = m ? m[0] : '';
    const rest = s.slice(origin.length).replace(/^\/r\/\d+(?:x\d+)?/, '');
    return w ? origin + '/r/' + w + rest : origin + rest;
  }

  /** 当前设置的封面宽度（非法值回落 400） */
  const coverWidth = () => {
    const q = Number(cfg.coverQuality);
    return Number.isFinite(q) ? q : 400;
  };

  /**
   * 封面**基准 URL** —— 恒取 common，宽度留给渲染时按设置改写。
   *
   * ★ 为什么不能直接用各档字段：两条通路的档位**命名不对齐**（实测各抽 6 条，映射稳定）——
   *     v0: large=原图 | common=r400 | medium=r800 | small=r200 | grid=r100
   *     p1: large=原图 | common=r400 | medium=r200 | small=r100 | grid=r100x100（方形裁剪）
   *   只有 common 两边都指向 r400。原写法取 medium ⇒ 走 v0 每张多下 6 倍、走 p1 又偏小。
   *   ⚠️ 旧文档曾把 p1 的 grid 记成「原图」—— 那是判档正则里 \d+ 后面接的是 x 不是 /，
   *      匹配不上 r/100x100/ 而落进了「无 r 段 = 原图」分支。实为 100×100 方形裁剪。
   *
   * ⇒ 基准恒为 common，档位在渲染时改写（见 withCoverWidth）。
   *   这样改「封面质量」**对已缓存的月份立刻生效** —— 缓存存的是基准 URL，不是烘死的档位。
   *   接口响应总额才 592 KB，而 79 张封面在 r400 下就有 4.2 MB（r800 则 12.4 MB）
   *   ⇒ 封面始终是接口响应的数倍到数十倍，这一项比换接口值钱得多。
   */
  const pickCover = imgs => { const i = imgs || {}; return i.common || i.medium || i.large || i.small || ''; };

  /** p1 单条 → 统一模型 */
  function fromP1(e) {
    const meta = (e.rating && typeof e.rating === 'object') ? e.rating : {};
    const { episodes, date } = parseInfo(e.info);
    const imgs = (e.images && typeof e.images === 'object') ? e.images : {};
    return {
      id: e.id,
      name: e.name || '',
      nameCn: e.nameCN || '',
      cover: pickCover(imgs),
      score: normScore(meta.score),
      rank: Number(meta.rank) || 0,
      votes: Number(meta.total) || 0,
      tagPool: rawTagNames(e.metaTags),   // ⚠️ p1 列表项**只有** metaTags，拿不到用户投票词
                                          //    ⇒ 走 p1 时「韩剧」这类靠 tagPool 过滤的 tab 会命中大减
      tags: pickTags(e.metaTags),         //    ⇒ 走这条路时内容词天生缺失，只能靠详情补
      episodes,
      date,
      platform: typeof e.platform === 'string' ? e.platform : '',
      info: e.info || '',
    };
  }

  /** v0 单条 → 统一模型（字段名不同：name_cn / rating.score / eps / date / tags） */
  /**
   * v0 列表项 → 内部条目（`api.bgm.tv/v0/subjects`）
   *
   * ★ 核心策略：**两个 tag 字段直接并集，一视同仁**。
   *   `tags`（用户投票全量 ≤30 个）按 `count` 显式降序 → 排在前面；
   *   `meta_tags`（服务端结构化摘要）去重后接在后面。
   *   不区分「这个词来自哪个字段」、不看 `total_count`、不做票数加权 ——
   *   因为白名单本身已经表达了优先级（题材 > 来源/受众 > 平台/地区），
   *   同层级内谁先出现谁赢，而「先出现」= 票数高，于是天然得到「票数高者优先」。
   *
   *   为什么必须并集：`meta_tags` 是**服务端精挑摘要**（非票数 TopN），会漏掉题材词 ——
   *   例：梅比乌斯之尘 `meta_tags` 只给 `TV 日本 原创`，而 `科幻(54)` `战斗(29)` 全在 `tags` 里。
   */
  function fromV0(e) {
    const meta = (e.rating && typeof e.rating === 'object') ? e.rating : {};
    const imgs = (e.images && typeof e.images === 'object') ? e.images : {};

    /* tags 显式按票数降序 —— 不依赖接口「恰好已排序」这个约定 */
    const voted = (Array.isArray(e.tags) ? e.tags : [])
      .filter(t => t && typeof t.name === 'string')
      .slice()
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .map(t => t.name);
    const pool = [...voted, ...rawTagNames(e.meta_tags)];

    const eps = Number(e.eps) || Number(e.total_episodes) || null;
    return {
      id: e.id,
      name: e.name || '',
      nameCn: e.name_cn || '',
      cover: pickCover(imgs),
      score: normScore(meta.score),
      rank: Number(meta.rank) || 0,
      votes: Number(meta.total) || 0,
      tagPool: pool,                    // 候选词全集（未筛白名单，用于判断「有没有题材词」）
      tags: pickTags(pool),
      episodes: eps,
      date: typeof e.date === 'string' ? e.date : '',
      platform: typeof e.platform === 'string' ? e.platform : '',   // 供 MODES.filter 过滤（真人影视分类）
      info: '',
    };
  }

  /** 月份倒序表：当年从当前月递减到 1，历史年固定 12→1 */
  function monthsOf(year, now = new Date()) {
    const cur = now.getFullYear();
    const start = year === cur ? now.getMonth() + 1 : 12;
    const out = [];
    for (let m = start; m >= 1; m--) out.push(m);
    return out;
  }

  /** 排序：评分降序，无评分垫底；同分按放送日期（PiliPlus: _compare） */
  function compareItems(a, b) {
    const sa = a.score == null ? -1 : a.score;
    const sb = b.score == null ? -1 : b.score;
    if (sa !== sb) return sb - sa;
    return String(a.date || '').localeCompare(String(b.date || ''));
  }

  /* ==================================================================== *
   * 3. 网络层：GM_xhr 优先 + 多通路轮询 + 冷却
   * ==================================================================== */

  const netStats = { ok: 0, err: 0, detail: 0, bySource: {}, errBySource: {}, lastErrors: [] };
  const cooling = {};   // base → 冷却到期的 timestamp

  /** 统一记录一次通路失败（列表/详情共用，面板统计行要能说清"哪条通路、错在哪"） */
  function noteNetErr(src, e) {
    netStats.err++;
    const msg = (e && e.message) || String(e);
    netStats.errBySource[src.id] = (netStats.errBySource[src.id] || 0) + 1;
    netStats.lastErrors.push(`${src.id}: ${msg}`);
    if (netStats.lastErrors.length > 8) netStats.lastErrors.shift();   // 只留最近 8 条
  }

  function httpText(url, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (hasGMXhr) {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout,
          headers: { Accept: 'application/json', 'User-Agent': UA },
          onload: r => resolve({ status: r.status, text: r.responseText || '' }),
          onerror: () => reject(new Error('请求失败（网络）')),
          ontimeout: () => reject(new Error('请求超时')),
          onabort: () => reject(new Error('请求中止')),
        });
      } else {
        fetch(url, { headers: { Accept: 'application/json' } })
          .then(async r => resolve({ status: r.status, text: await r.text() }))
          .catch(e => reject(e));
      }
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** 简易并发队列 */
  function makeQueue(limit) {
    let active = 0;
    const waiters = [];
    const next = () => {
      if (active >= limit || !waiters.length) return;
      active++;
      const job = waiters.shift();
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => { active--; next(); });
    };
    return fn => new Promise((resolve, reject) => {
      waiters.push({ fn, resolve, reject });
      next();
    });
  }

  const queue = makeQueue(() => Math.max(1, Math.min(4, Number(cfg.concurrent) || 2))());

  /** 可用通路列表（按配置过滤 + 冷却剔除） */
  function activeSources() {
    const now = Date.now();
    let list = SOURCES.slice();
    if (cfg.source === 'p1') list = list.filter(s => s.id === 'p1');
    else if (cfg.source === 'v0') list = list.filter(s => s.id === 'v0');
    const alive = list.filter(s => !cooling[s.base] || cooling[s.base] < now);
    return alive.length ? alive : list;   // 全部冷却时仍尝试第一个
  }

  function markCooling(base, ms = 60000) {
    cooling[base] = Date.now() + ms;
  }

  /** 拼 type/cat 段：cat 为 null/undefined 时不带该参数（= 拉该 type 全部平台，前端再过滤） */
  function catParam(mode) {
    return (mode.cat == null) ? '' : `&cat=${mode.cat}`;
  }

  /**
   * 按 mode 过滤条目（无 filter / tagFilter 则原样返回）。
   *
   * 两级过滤，都是**前端**做的（Bangumi 没有对应字段）：
   *   - `mode.filter`    : 正则匹配 `platform`（例：电影 = `/^电影$/`）
   *   - `mode.tagFilter` : 正则匹配**候选词池** `tagPool`（例：韩剧 = `/韩国|韩剧/`）
   *
   * ⚠️ 「韩剧」为什么只能这么筛：Bangumi 的 `platform` 全集只有 8 种、**没有韩剧**，
   *    韩剧被扔进 `platform="电视剧"` 这个混合容器。唯一可用的信号是 tag 里的「韩国」。
   *    因此本 tab = `platform=电视剧` + tag 命中「韩国」——这是**近似**，两个已知代价：
   *      ① 漏：tag 池为空 / 没人投「韩国」的条目会被滤掉；
   *      ② 混：tag 含「韩国」但实为合拍/涉韩的条目会进来。
   *    宁可窄也不要混（主人定案走这条），所以是 AND 叠加而非 OR。
   *
   * ★ 实测成色（tools/probe-kdrama-film.mjs / probe-kdrama-miss.mjs）：
   *    2026 年 `platform=电视剧` 14 条 → 命中 **14 条（100%）**；
   *    2025 年 78 条 → 命中 68 条（**87%**）。
   *    2025 那 10 条漏检的成分（全部人眼核过，没有一条是「韩国生产却漏」的）：
   *      - 泰国 BL 剧 2 条（`泰国/泰剧`）—— 本来也不该进韩剧 tab；
   *      - 国产剧 1 条（`国产剧`）、斯巴达克斯（`tag 池空`）、超英《战神金鸿》（`特摄`）、
   *        日本《大叔的爱》（`tag 池空`）、韩国 BL《吾岸》（只有 `同性/BL/小说改`）—— 确实该算漏，但无解；
   *      - **`韩语` 写法 1 条**（清潭国际高中 第二季）—— 唯一**可补**的词，已收进下方正则。
   *    ⇒ 「韩国」是目前能拿到的最强信号，加词空间基本为零（不存在「美剧」这类反向混杂项，
   *      platform=电视剧 里 0 条美剧）。
   */
  function applyModeFilter(mode, items) {
    if (!mode.filter && !mode.tagFilter) return items;
    return items.filter(it => {
      if (mode.filter) {
        mode.filter.lastIndex = 0;        // 带 g 标志的正则会保留 lastIndex，必须重置
        if (!mode.filter.test(it.platform || '')) return false;
      }
      if (mode.tagFilter) {
        mode.tagFilter.lastIndex = 0;
        const pool = Array.isArray(it.tagPool) ? it.tagPool : [];
        if (!pool.some(t => { mode.tagFilter.lastIndex = 0; return mode.tagFilter.test(t); })) return false;
      }
      return true;
    });
  }

  /** p1 单页 */
  async function fetchP1Page(base, mode, year, month, page) {
    const url = `${base}/p1/subjects?type=${mode.type}${catParam(mode)}&year=${year}&month=${month}&page=${page}`;
    const { status, text } = await httpText(url);
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    const list = Array.isArray(data.data) ? data.data : [];
    const totalPages = Number(data.total) || 1;
    return { items: applyModeFilter(mode, list.map(fromP1)), totalPages };
  }

  /** v0 单页（limit/offset 分页） */
  async function fetchV0Page(base, mode, year, month, offset) {
    const limit = 100;
    const url = `${base}/v0/subjects?type=${mode.type}${catParam(mode)}&year=${year}&month=${month}`
      + `&limit=${limit}&offset=${offset}`;
    const { status, text } = await httpText(url);
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    const list = Array.isArray(data.data) ? data.data : [];
    const total = Number(data.total) || 0;
    const items = applyModeFilter(mode, list.map(fromV0));
    // ⚠️ 过滤前的一页可能整页都不匹配（电影只占 y6 全量的 1/6）⇒ 必须按"原始页"判断是否还有更多
    return { items, hasMore: list.length >= limit && offset + limit < total, rawLen: list.length };
  }

  /** 走指定通路拉全某月 */
  async function fetchMonthVia(src, mode, year, month) {
    const seen = new Set();
    const out = [];
    const push = items => {
      for (const it of items) {
        if (it.id == null || seen.has(it.id)) continue;
        seen.add(it.id);
        if (cfg.hideNoScore && it.score == null) continue;
        out.push(it);
      }
    };
    if (src.id === 'p1') {
      const first = await queue(() => fetchP1Page(src.base, mode, year, month, 1));
      push(first.items);
      const pages = Math.min(first.totalPages, cfg.maxPages);
      for (let p = 2; p <= pages; p++) {
        const r = await queue(() => fetchP1Page(src.base, mode, year, month, p));
        const nBefore = out.length;
        push(r.items);
        // ⚠️ 有 filter 时（如"电影"）整页可能都不匹配 ⇒ 不能按"过滤后剩余"判停，
        //    要靠 p1 的 totalPages 自然收尾；无 filter 时保留原来的提前退出（省请求）
        if (!mode.filter && out.length === nBefore) break;
      }
    } else {
      let offset = 0;
      for (let i = 0; i < cfg.maxPages; i++) {
        const r = await queue(() => fetchV0Page(src.base, mode, year, month, offset));
        push(r.items);
        // ⚠️ 同理：必须看**原始页长度**（rawLen），过滤后的空页不代表数据拉完了
        if (!r.hasMore || (r.rawLen !== undefined ? r.rawLen === 0 : r.items.length === 0)) break;
        offset += 100;
      }
    }
    out.sort(compareItems);
    return out;
  }

  /** 缓存键 / 时效 */
  const cacheKeyOf = (mode, year, month) => `m:${mode.key}:${year}:${month}`;
  const ttlOf = year => (year === new Date().getFullYear()
    ? (Number(cfg.ttlHoursThisYear) || 12) * 3600e3
    : (Number(cfg.ttlDaysPastYear) || 30) * 86400e3);

  /** 空结果单独给个短时效。
   *  理由：`writeCache` 对 0 条也照写，若沿用 12h/30d，会把"这时真的还没数据"
   *  （月初新番未录入、某月确实空）钉住很久，期间没有任何自愈机会。
   *  30 分钟后自然过期重试，代价是极少数空月会多一次请求。 */
  const EMPTY_TTL = 30 * 60e3;

  function readCache(mode, year, month) {
    const hit = store.get(cacheKeyOf(mode, year, month), null);
    if (!hit || !Array.isArray(hit.items)) return null;
    const age = Date.now() - hit.t;
    if (hit.items.length === 0) return age > EMPTY_TTL ? null : hit.items;
    return age > ttlOf(year) ? null : hit.items;
  }

  function writeCache(mode, year, month, items) {
    const key = cacheKeyOf(mode, year, month);
    store.set(key, { t: Date.now(), items });
    store.rememberKey(key);
  }

  /**
   * 对外入口：拉某月（缓存优先 → 多通路轮询）
   * @returns {{items:Array, from:'cache'|'net', source?:string, error?:string}}
   */
  async function loadMonth(mode, year, month, { force = false } = {}) {
    if (!force) {
      const cached = readCache(mode, year, month);
      if (cached) return { items: cached, from: 'cache' };
    }
    const sources = activeSources();
    let lastErr = null;
    for (const src of sources) {
      try {
        const items = await fetchMonthVia(src, mode, year, month);
        netStats.ok++;
        netStats.bySource[src.id] = (netStats.bySource[src.id] || 0) + 1;
        writeCache(mode, year, month, items);
        return { items, from: 'net', source: src.id };
      } catch (e) {
        noteNetErr(src, e);
        lastErr = e;
        markCooling(src.base, 60000);
      }
    }
    return { items: [], from: 'net', error: (lastErr && lastErr.message) || '全部通路失败' };
  }

  /* ==================================================================== *
   * 3.5 详情补拉 —— **默认关闭**（cfg.tagDetail = 'off'），仅作应急手段
   *
   * v0 通路下完全用不到：列表项本身就带全量 `tags`（≤30 个），
   * 且**详情接口返回的 tags 与 v0 列表的 tags 逐字节一致**（实测 3/3）⇒ 补拉是纯粹的重复请求。
   * 保留整套代码的唯一理由：p1 列表项没有 `tags`，万一 v0 长期故障、只能回落 p1，
   * 把 cfg.tagDetail 改成 'fill' 即可恢复「按需拉详情」的救急行为。
   * ==================================================================== */

  const DETAIL_GAP = 320;        // 详情补拉间隔（ms）—— 串行 + 间隔，对 Bangumi 友好
  const DETAIL_MAX_PER_MONTH = 24;
  const DETAIL_KEEP = 30;        // 详情缓存保留的 tag 条数

  const detailKeyOf = id => `d:${id}`;
  const detailTtl = () => (Number(cfg.ttlDaysPastYear) || 30) * 86400e3;   // tag 常年不变，按历史年时效缓存

  function readDetailCache(id) {
    const hit = store.get(detailKeyOf(id), null);
    if (!hit || !Array.isArray(hit.tags)) return null;
    if (Date.now() - hit.t > detailTtl()) return null;
    return hit.tags;
  }

  function writeDetailCache(id, tags) {
    const key = detailKeyOf(id);
    store.set(key, { t: Date.now(), tags });
    store.rememberKey(key);
  }

  /** 单条目完整 tag（p1: /p1/subjects/{id}；v0: /v0/subjects/{id}） */
  async function fetchDetailTags(src, id) {
    const url = src.id === 'p1'
      ? `${src.base}/p1/subjects/${id}`
      : `${src.base}/v0/subjects/${id}`;
    const { status, text } = await httpText(url, { timeout: 20000 });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text);
    const raw = src.id === 'p1'
      ? rawTagNames(data.tags)
      : [...rawTagNames(data.tags), ...rawTagNames(data.meta_tags)];
    return raw.slice(0, DETAIL_KEEP);
  }

  /** 卡片上的 tag 槽位就地刷新（不重渲染整月） */
  function refreshTagChip(id, tags) {
    const root = document.getElementById('bgm-anime-root');
    if (!root) return;
    const card = root.querySelector(`.bgm-card[data-bgm-id="${id}"]`);
    const cover = card && card.querySelector('.bgm-cover');
    if (!cover) return;
    let box = cover.querySelector('.bgm-tags');
    if (!box) { box = el('span', 'bgm-tags'); cover.appendChild(box); }
    box.textContent = '';
    tags.slice(0, 2).forEach(t => box.appendChild(el('i', 'bgm-tag', t)));
  }

  /**
   * 对「没有题材词 / 槽位没填满」的条目补拉详情并就地刷新卡片。
   * 串行 + 间隔，避免给本来就抖的 Bangumi 加压；结果按 id 长期缓存。
   */
  async function ensureDetailTags(items, mode) {
    const level = cfg.tagDetail;
    if (level === 'off' || level === false) return;
    if (!cfg.showTags || !mode.showTags) return;
    const min = level === 'empty' ? 1 : 2;

    /* 触发条件只看**题材词**（Tier1）——Tier3 平台/地区是兜底显示，不代表数据够用 */
    const lacking = it => (level === 'empty'
      ? it.tags.length === 0
      : (!hasGenreTag(it.tagPool) || it.tags.length < min));

    /* 详情结果更值得显示？先比「有没有题材词」，再比词数 */
    const better = (a, b) => (hasGenreTag(a) !== hasGenreTag(b) ? hasGenreTag(a) : a.length > b.length);

    const need = items
      .filter(it => it.id != null && lacking(it))
      .slice(0, DETAIL_MAX_PER_MONTH);

    for (const it of need) {
      let tags = readDetailCache(it.id);
      if (tags) {
        const picked = pickTags(tags, 2);
        if (better(picked, it.tags)) { it.tags = picked; refreshTagChip(it.id, picked); }
        continue;
      }
      for (const src of activeSources()) {
        try {
          tags = await fetchDetailTags(src, it.id);
          netStats.detail++;
          break;
        } catch (e) {
          noteNetErr(src, e);
          markCooling(src.base, 60000);
        }
      }
      if (!tags) continue;
      writeDetailCache(it.id, tags);
      const picked = pickTags(tags, 2);
      if (better(picked, it.tags)) { it.tags = picked; refreshTagChip(it.id, picked); }
      await sleep(DETAIL_GAP);
    }
  }

  /* ==================================================================== *
   * 3.6 主题自适应 —— 跟随 **B站 自己** 的深/浅色开关
   *
   * 实测（2026-09-19 /anime/）：B站 的主题不是 html 上的 class/属性 ——
   *   <html> 上没有任何 dark 标记，`prefers-color-scheme` 也不参与，
   *   施加 class="dark" / data-theme="dark" / color-scheme:dark 全都**不生效**。
   *   真正的开关在 <head>：<link id="__css-map__" href=".../bili-theme/light.css">
   *   切深色 = 把这份 CSS 的 href 换成同目录的 dark.css，而 dark.css 只是把 :root 的
   *   调色板（--Ga0/--Ga1/--Wh0/--Lb5 …）整包换成暗色值；map.css 再映射成语义变量
   *   --bg1/--bg2/--text1/--text2/--graph_bg_thick/--brand_pink。
   *
   * ⇒ 自适应的正解分两层：
   *    ① **CSS 桥接**（零 JS）：我们的调色板直接引用 B站 语义变量（见 §4），
   *       B站 换主题时变量本身在变，我们的页面跟着变；
   *    ② **JS 判定**（本段）：只在「要显示状态 / 要设 color-scheme / 桥接变量缺失要兜底」
   *       这三种情况下才需要知道当前是不是深色 ⇒ 多信号判定 + 多观察器兜底。
   *
   * ⚠️ 别只认一种信号：B站 改版过一次实现方式就全瞎（本次实测已证明"猜 class"是错的）。
   * ==================================================================== */

  /** #rgb / #rrggbb / rgb(a) → 感知亮度 0~255；解析不了返回 null */
  function luminance(v) {
    if (!v) return null;
    const s = String(v).trim();
    let r, g, b;
    let m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.replace(/./g, c => c + c);
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else if ((m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s))) {
      r = +m[1]; g = +m[2]; b = +m[3];
    } else return null;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** 当前是否深色。信号按可靠性排序：官方开关 → 语义变量亮度 → 通用标记 → 系统偏好 */
  function detectDark() {
    if (cfg.theme === 'dark') return true;
    if (cfg.theme === 'light') return false;

    /* ① B站 官方开关：主题 CSS 的 link */
    const link = document.getElementById('__css-map__')
      || document.querySelector('link[href*="bili-theme/"]');
    const href = link ? (link.getAttribute('href') || '') : '';
    if (/dark/i.test(href)) return true;
    if (/light/i.test(href)) return false;

    /* ② B站 语义变量（深色 = 这些变量被整包换成暗色值）。
          只取**背景系**变量：--text1 在浅色下本来就是深色，拿它判断会正好判反。 */
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['--bg1', '--Ga0', '--graph_bg_thick', '--bg2']) {
      const lum = luminance(cs.getPropertyValue(k));
      if (lum != null) return lum < 128;
    }

    /* ③ 通用深色标记（B站 哪天改回 class/属性实现时仍能跟上） */
    const h = document.documentElement, bd = document.body;
    const marks = [h.className, bd && bd.className, h.getAttribute('data-theme'),
      h.getAttribute('data-dark'), h.getAttribute('theme')].filter(Boolean).join(' ');
    if (/dark|night/i.test(marks)) return true;

    /* ④ 系统偏好（B站 没给任何信号时的最后兜底） */
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  }

  let themeDark = null;             // 当前判定结果（null = 还没判定过）
  let themeForced = null;           // 是否处于「强制」模式（cfg.theme !== 'auto'）
  const themeSubs = [];

  /** 更新 <html> 的 bgm-dark / bgm-light / bgm-forced 类名；变化时通知订阅者 */
  function applyTheme() {
    const d = detectDark();
    const forced = cfg.theme !== 'auto';
    const html = document.documentElement;
    /* 兜底：即使判定结果没变，「强制 ↔ 跟随」之间切换也要重刷类名（调色板来源不同） */
    const changed = d !== themeDark || forced !== themeForced;
    themeDark = d;
    themeForced = forced;
    if (changed) {
      html.classList.toggle('bgm-dark', d);
      html.classList.toggle('bgm-light', !d);
      html.classList.toggle('bgm-forced', forced);
      /* 也暴露到 data-* 上：外部工具/并存的脚本可以只看 DOM，不必读我们的内部变量 */
      html.dataset.bgmTheme = d ? 'dark' : 'light';
      themeSubs.forEach(fn => { try { fn(d); } catch (e) { /* 订阅者自己的问题，不影响主题 */ } });
    }
    return d;
  }

  /** 订阅主题变化（注册时立即回调一次） */
  function onTheme(fn) {
    themeSubs.push(fn);
    if (themeDark != null) fn(themeDark);
  }

  /** 顶栏那个主题按钮的文案/提示（跟随当前模式与判定结果） */
  const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
  function syncThemeBtn() {
    const b = view && view.themeBtn;
    if (!b) return;
    b.textContent = THEME_ICON[cfg.theme] || '◐';
    b.title = cfg.theme === 'auto'
      ? `主题：跟随 B站（当前判定为${themeDark ? '深色' : '浅色'}）· 点击切换`
      : `主题：强制${cfg.theme === 'dark' ? '深色' : '浅色'} · 点击切换`;
  }

  let themeWatched = false;
  function watchTheme() {
    if (themeWatched) return;
    themeWatched = true;
    const check = () => applyTheme();
    applyTheme();

    /* B站 是「改 link href」实现的 ⇒ 盯 head 的属性/子节点变化最直接 */
    const watchHead = () => {
      if (!document.head) return;
      new MutationObserver(check).observe(document.head,
        { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
    };
    const watchAttrs = b => { if (b) new MutationObserver(check).observe(b, { attributes: true }); };
    if (document.head) watchHead();
    else document.addEventListener('DOMContentLoaded', watchHead, { once: true });
    watchAttrs(document.documentElement);
    if (document.body) watchAttrs(document.body);
    else document.addEventListener('DOMContentLoaded', () => watchAttrs(document.body), { once: true });

    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', check); } catch (e) { /* 老浏览器 */ }

    /* 低频兜底：有些切换路径不触发任何观察器（Vue 复用节点等） */
    setInterval(check, 1500);
  }

  /* ==================================================================== *
   * 3.7 B站 顶栏「头像弹层」里的状态行
   *
   * 位置：`.bili-header .avatar-panel-popover .links-item` —— 点头像后那个下拉面板，
   *       里面本来就有 B站 自己的「主题： 浅色」那一项。
   * 做法：用**和 B站 完全相同的 class 名**（.single-link-item / .link-title / .link-icon）
   *       插一条状态行在同容器里 ⇒ 配色、hover、深浅色全部自动跟随 B站，自己一行 CSS 都不用写。
   * 坑：① 该面板**只有登录后才渲染**，必须 MutationObserver 等它出现，不能只在启动时插一次；
   *     ② 面板内容由 Vue 接管，节点可能被复用/重建 ⇒ 插入要幂等（认 id，不重复插）。
   * ==================================================================== */

  const STATUS_ITEM_ID = 'bgm-anime-status-item';

  /* 半明半暗的圆（呼应「主题」图标），颜色交给 B站 变量 */
  const STATUS_ICON = '<svg class="link-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" '
    + 'xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.2" stroke="var(--text2,#61666d)" stroke-width="1.6"/>'
    + '<path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="var(--text2,#61666d)"/></svg>';
  const STATUS_ARROW = '<svg class="link-icon--right" width="16" height="16" viewBox="0 0 16 16" fill="none" '
    + 'xmlns="http://www.w3.org/2000/svg"><path d="M5.5 3.5 10 8l-4.5 4.5" stroke="var(--text3,#9499a0)" '
    + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function statusLabel() {
    return `Bangumi： 已接管 · ${themeDark ? '深色' : '浅色'}`;
  }

  function statusTip() {
    const used = Object.entries(netStats.bySource).map(([k, v]) => `${k}×${v}`).join('，') || '—';
    const cachedN = (store.get('cacheKeys', []) || []).length;
    return [
      `bili-anime-replace v${VERSION}`,
      `数据通路：${cfg.source === 'auto' ? '自动（p1 → v0）' : cfg.source}　本次使用 ${used}`,
      `请求：成功 ${netStats.ok} / 失败 ${netStats.err}　Tag 补拉 ${netStats.detail} 次`,
      `缓存月份：${cachedN} 条`,
      `主题：${cfg.theme === 'auto' ? `跟随 B站（当前${themeDark ? '深色' : '浅色'}）` : `强制${cfg.theme === 'dark' ? '深色' : '浅色'}`}`,
      '点这里打开设置',
    ].join('\n');
  }

  function panelLinksBox() {
    return document.querySelector('.bili-header .avatar-panel-popover .links-item')
      || document.querySelector('.avatar-panel-popover .links-item');
  }

  /** 幂等插入状态行；返回它（面板不在时返回 null） */
  function ensureStatusItem() {
    const box = panelLinksBox();
    if (!box) return null;

    let node = document.getElementById(STATUS_ITEM_ID);
    if (!node || !box.contains(node)) {
      node = document.createElement('div');
      node.className = 'single-link-item';
      node.id = STATUS_ITEM_ID;
      const title = document.createElement('div');
      title.className = 'link-title';
      title.innerHTML = STATUS_ICON;
      title.appendChild(document.createElement('span'));
      node.appendChild(title);
      node.insertAdjacentHTML('beforeend', STATUS_ARROW);
      node.addEventListener('click', () => {
        if (document.getElementById('bgm-anime-root')) openSettings();
      });
      /* 想插在 B站 自己那条「主题： 浅色」后面；找不到就排最前 */
      const themeItem = [...box.querySelectorAll('.single-link-item')]
        .find(n => /主题/.test(n.textContent || ''));
      if (themeItem) themeItem.after(node); else box.prepend(node);
    }
    updateStatusItem(node);
    return node;
  }

  function updateStatusItem(node = document.getElementById(STATUS_ITEM_ID)) {
    if (!node) return;
    const span = node.querySelector('.link-title > span');
    if (span && span.textContent !== statusLabel()) span.textContent = statusLabel();
    node.title = statusTip();
  }

  let statusWatched = false, lastStatusTick = 0;
  function watchStatusItem() {
    if (statusWatched) return;
    statusWatched = true;
    const tick = () => {
      if (!document.getElementById('bgm-anime-root')) return;   // 没接管就别碰 B站 的面板
      const now = Date.now();
      if (now - lastStatusTick < 400) return;                    // 面板在 body 内，观察器会被卡片渲染刷爆
      lastStatusTick = now;
      ensureStatusItem();
    };
    const start = () => {
      new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
      setInterval(tick, 2000);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  /* ==================================================================== *
   * 4. 样式
   * ==================================================================== */

  const CSS = `
/* 主题变量必须挂在 html 上：设置面板 / toast 是挂在 body 下的浮动层，
   不在 #bgm-anime-root 内部；若只声明在 root 上，浮动层里的 var(--card)
   会解析失败 → 面板背景透明、底下的卡片图直接透出来。 */
/* ===== 主题桥接 =====
   调色板**直接引用 B站 自己的语义变量**：B站 切深色时（= 把 <link id="__css-map__"> 换成
   bili-theme/dark.css，见 §3.6）这些变量本身在变 ⇒ 我们的页面跟着变，零 JS 参与。
   var() 的第二参是「B站 变量不存在时」的兜底字面量，按 JS 判定的 .bgm-dark / .bgm-light 给两套。 */
html.bgm-takeover{
  --bg:var(--bg2,#f6f7f8); --card:var(--bg1,#fff); --text:var(--text1,#18191c);
  --sub:var(--text2,#61666d); --line:var(--graph_bg_thick,#e3e5e7);
  --accent:var(--brand_pink,#fb7299); --accent-soft:var(--brand_pink_thin,#ffeef3);
  --shadow:0 2px 8px rgba(0,0,0,.06);
  /* 接管时的整页底色（§hideCss 也用这个变量，所以它必须声明在 html 上） */
  --bgm-bg:var(--bg2,#f6f7f8);
}
html.bgm-takeover.bgm-dark{
  --bg:var(--bg2,#17181a); --card:var(--bg1,#1f2022); --text:var(--text1,#e3e5e7);
  --sub:var(--text2,#9499a0); --line:var(--graph_bg_thick,#2f3134);
  --accent-soft:var(--brand_pink_thin,#3a2229);
  --shadow:0 2px 8px rgba(0,0,0,.4);
  --bgm-bg:var(--bg2,#17181a);
  color-scheme:dark;      /* 滚动条 / 表单控件（设置面板里的 select）跟随 */
}
html.bgm-takeover.bgm-light{color-scheme:light}
/* 强制模式（设置面板里把主题设成 强制浅/深）必须**绕开桥接**：
   否则在浅色 B站 上"强制深色"会被 B站 的浅色变量覆盖，等于没强制。*/
html.bgm-takeover.bgm-forced.bgm-dark{
  --bg:#17181a; --card:#1f2022; --text:#e3e5e7; --sub:#9499a0; --line:#2f3134;
  --accent-soft:#3a2229; --shadow:0 2px 8px rgba(0,0,0,.4); --bgm-bg:#17181a;
}
html.bgm-takeover.bgm-forced.bgm-light{
  --bg:#f6f7f8; --card:#fff; --text:#18191c; --sub:#61666d; --line:#e3e5e7;
  --accent-soft:#ffeef3; --shadow:0 2px 8px rgba(0,0,0,.06); --bgm-bg:#f6f7f8;
}
#bgm-anime-root{
  /* top 由 --bgm-top 给：保留 B站 表头时 = 表头下沿，否则 0。
     z-index 由 --bgm-z 给：保留表头时要压到表头层叠上下文(1002)之下，否则表头的下拉会被盖住。 */
  position:fixed; left:0; right:0; bottom:0; top:var(--bgm-top,0px);
  z-index:var(--bgm-z,2147482000); display:flex; flex-direction:column;
  background:var(--bg); color:var(--text); overflow:hidden;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
/* 兜底：JS 尚未给 html 打上 .bgm-dark/.bgm-light 时，先跟系统偏好，避免白闪 */
@media (prefers-color-scheme:dark){
  html.bgm-takeover:not(.bgm-light):not(.bgm-dark){
    --bg:#17181a; --card:#1f2022; --text:#e3e5e7; --sub:#9499a0; --line:#2f3134;
    --accent-soft:#3a2229; --shadow:0 2px 8px rgba(0,0,0,.4); --bgm-bg:#17181a;
  }
}
#bgm-anime-root *{box-sizing:border-box}
#bgm-anime-root img{display:block}

/* 保留 B站 表头时：B站 自己的搜索框就在正上方、行为完全一样（都跳 B站 搜索）
   → 收掉重复的那个，避免两排搜索框叠着 */
html.bgm-takeover.bgm-keep-header .bgm-search{display:none}

/* ---- 顶栏 ----
   720P（1280×720，实际视口约 1265）下要同时塞下：品牌 + 9 个分类 tab + 工具区。
   硬约束：分类 tab 是**主交互**，绝不能被挤到换行或缩成省略号；
   可牺牲的是品牌文字和搜索框宽度。故：
     ① 尺寸全部走 clamp()，随视口连续收缩（而不是靠若干断点跳变）；
     ② .bgm-modes 允许压缩（min-width:0）并横向滚动，绝不 wrap；
        滚动条是刻意藏掉的（见下），所以**必须**配套 enableDragScroll()
        —— 否则桌面鼠标用户既没滚动条、又没横向滚轮，等于"看得见滚不动"；
     ③ 品牌文字在窄屏隐藏（只留圆点），圆点是信息的最后一块 —— 见下方 @media。
   算例（viewport 1265）：brand 18 + gap 10 + 9 chips(≈624) + gap 10 + tools(≈102) ≈ 1090 ⇒ 余量约 175px */
.bgm-top{flex:none;background:var(--card);border-bottom:1px solid var(--line)}
.bgm-top-in{display:flex;align-items:center;gap:clamp(8px,1.2vw,16px);max-width:1600px;margin:0 auto;
  padding:0 clamp(10px,1.5vw,20px);height:clamp(46px,6.2vh,56px)}
.bgm-brand{display:flex;align-items:center;gap:8px;font-size:clamp(14px,1.25vw,16px);font-weight:700;white-space:nowrap}
.bgm-brand-dot{width:clamp(8px,0.8vw,10px);height:clamp(8px,0.8vw,10px);border-radius:50%;background:var(--accent);flex:none}
/* 可横向拖拽的条带：藏滚动条 + 拖拽时禁文字选中，配 enableDragScroll() 使用 */
.bgm-modes{display:flex;gap:clamp(3px,0.45vw,8px);flex:1 1 auto;min-width:0;
  overflow-x:auto;scrollbar-width:none;scroll-behavior:smooth;
  -webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;
  user-select:none;-webkit-user-select:none;cursor:grab}
.bgm-modes::-webkit-scrollbar{display:none}
.bgm-modes.bgm-dragging{cursor:grabbing}
.bgm-years-in.bgm-dragging{cursor:grabbing}
.bgm-mode{padding:clamp(4px,0.5vh,6px) clamp(7px,0.85vw,16px);border-radius:20px;
  font-size:clamp(12px,1.05vw,14px);color:var(--sub);cursor:pointer;
  white-space:nowrap;border:1px solid transparent;background:transparent;font-family:inherit;flex:none}
.bgm-mode:hover{color:var(--text);background:var(--bg)}
.bgm-mode.on{background:var(--accent-soft);color:var(--accent);font-weight:600;border-color:var(--accent)}
.bgm-tools{display:flex;align-items:center;gap:clamp(4px,0.5vw,8px);flex:none}
.bgm-search{width:clamp(96px,11vw,170px);height:clamp(28px,3.6vh,32px);padding:0 12px;border-radius:16px;
  border:1px solid var(--line);background:var(--bg);color:var(--text);
  font-size:13px;font-family:inherit;outline:none}
.bgm-search:focus{border-color:var(--accent);width:clamp(140px,16vw,220px)}
.bgm-ibtn{width:clamp(28px,3.6vh,32px);height:clamp(28px,3.6vh,32px);border-radius:8px;
  border:1px solid var(--line);background:var(--bg);color:var(--sub);cursor:pointer;
  font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center;flex:none}
.bgm-ibtn:hover{color:var(--accent);border-color:var(--accent)}

/* 窄屏：品牌文字让位（圆点保留 = 信息不丢），进一步收 tab 与内边距。
   720P 不触发此断点（1265 > 860），窄窗口 / 竖屏手机才会。 */
@media (max-width:860px){
  .bgm-brand-txt{display:none}
  .bgm-top-in{gap:8px;padding:0 10px}
  .bgm-search{width:clamp(80px,18vw,120px)}
}

/* ---- 年份栏 ----
   ⚠️ 年份 chip 从 2026 排到 2006（21 个），整行必然超出任何视口。
   内层容器只是「视口内居中」的壳，**必须 min-width:0**，
   否则 flex 子项的默认 min-width:auto 会让它撑到内容宽度（≈1000px+），
   在 1024/800 宽的视口上直接把整页顶出横向滚动条（实测踩过）。
   配合外层的 flex:none，滚动条只出现在这一行内部。 */
.bgm-years{flex:none;background:var(--card);border-bottom:1px solid var(--line);min-width:0}
/* ★ v1.6.6 紧凑化：行内 padding 8→4，chip 的 padding/gap/字号各降一档、圆角 14→10。
   实测（见 tools/shot-badges-years.mjs）：1280×720 下 21 个 chip 原先**溢出 89px**
   （必须拖动才能看到早年），改造后一行放得下；条高 40px → 30px（720P 竖向能多留半行卡片）。 */
.bgm-years-in{display:flex;gap:clamp(3px,0.45vw,5px);max-width:1600px;margin:0 auto;
  padding:4px clamp(8px,1.2vw,16px);overflow-x:auto;scrollbar-width:none;min-width:0;
  -webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;
  user-select:none;-webkit-user-select:none;cursor:grab}
.bgm-years-in::-webkit-scrollbar{display:none}
.bgm-year{padding:2px clamp(7px,0.8vw,10px);border-radius:10px;line-height:1.4;
  font-size:clamp(11px,0.85vw,12px);color:var(--sub);cursor:pointer;
  white-space:nowrap;background:var(--bg);border:1px solid transparent;font-family:inherit;flex:none}
.bgm-year:hover{color:var(--text)}
.bgm-year.on{background:var(--accent-soft);color:var(--accent);font-weight:700;border-color:var(--accent)}
/* 年份栏同理要自动滚到当前年（21 个 chip，选中的大概率在视野外） */
.bgm-year.on{scroll-margin-inline:80px}

/* ---- 主体 ---- */
.bgm-body{flex:1;overflow-y:auto;overscroll-behavior:contain;min-width:0}
.bgm-body-in{max-width:1600px;margin:0 auto;padding:4px clamp(10px,1.5vw,20px) 80px;min-width:0}
.bgm-month-h{position:sticky;top:0;z-index:5;background:var(--bg);
  padding:14px 2px 8px;font-size:15px;font-weight:600;display:flex;align-items:baseline;gap:8px}
.bgm-month-h em{font-style:normal;font-size:12px;font-weight:400;color:var(--sub)}
.bgm-grid{display:grid;gap:16px 12px;
  grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}
@media (max-width:640px){.bgm-grid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:12px 8px}}

/* ---- 卡片 ---- */
.bgm-card{min-width:0}
.bgm-cover{position:relative;display:block;aspect-ratio:3/4;border-radius:8px;overflow:hidden;
  background:var(--bg);box-shadow:var(--shadow);text-decoration:none}
.bgm-cover img{width:100%;height:100%;object-fit:cover;transition:transform .25s}
.bgm-cover:hover img{transform:scale(1.04)}
/* ---- 封面徽章（评分 / 标签 / 集数）----
   ★ v1.6.6 可读度改造：底色 .54→.74、白字 70%→95%、字重 600、字号各 +1px，
   并加描边 + 投影 + 毛玻璃。旧值（10px 字 / 70% 白 / 半透黑底）在**浅色封面**
   上几乎糊成一片 —— 主人要求「提高 tag、评分、集数的可视度」。
   三个徽章共用同一套基底，各自只写位置与尺寸差异。 */
.bgm-score,.bgm-tag,.bgm-eps{
  background:rgba(0,0,0,.74);color:rgba(255,255,255,.95);font-weight:600;
  text-shadow:0 1px 2px rgba(0,0,0,.55);box-shadow:0 1px 3px rgba(0,0,0,.35);
  border:1px solid rgba(255,255,255,.16);
  backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.bgm-score{position:absolute;top:6px;right:6px;padding:2px 6px;border-radius:5px;
  font-size:12px;line-height:1.25;font-variant-numeric:tabular-nums}
.bgm-score.hot{color:#FFD54F;font-weight:800;background:rgba(0,0,0,.8)}
.bgm-tags{position:absolute;top:6px;left:6px;display:flex;flex-direction:column;gap:3px;
  align-items:flex-start;max-width:calc(100% - 56px)}
.bgm-tag{padding:2px 5px;border-radius:4px;font-size:11px;line-height:1.25;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bgm-eps{position:absolute;bottom:6px;left:6px;padding:2px 6px;border-radius:4px;
  font-size:11px;line-height:1.25;font-variant-numeric:tabular-nums}
.bgm-title{display:block;margin-top:6px;font-size:13px;line-height:1.25;color:var(--text);
  text-decoration:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bgm-title:hover{color:var(--accent)}

/* ---- 占位/空态 ---- */
.bgm-ph{height:180px;display:flex;align-items:center;justify-content:center;color:var(--sub);font-size:13px}
.bgm-sk{display:grid;gap:16px 12px;grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}
.bgm-sk i{display:block;aspect-ratio:3/4;border-radius:8px;background:var(--line);animation:bgmPulse 1.2s infinite}
@keyframes bgmPulse{0%,100%{opacity:.55}50%{opacity:.28}}
.bgm-empty{text-align:center;color:var(--sub);padding:60px 0;font-size:14px}
.bgm-err{color:#e5484d}

/* ---- 设置面板 ---- */
.bgm-mask{position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:2147483000;display:flex;
  align-items:center;justify-content:center}
.bgm-panel{width:min(460px,92vw);max-height:82vh;overflow:auto;background:var(--card);border-radius:12px;
  padding:20px;box-shadow:0 8px 32px rgba(0,0,0,.24)}
.bgm-panel h3{margin:0 0 14px;font-size:16px}
.bgm-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;
  border-bottom:1px solid var(--line);font-size:13px}
.bgm-row:last-of-type{border-bottom:0}
.bgm-row select{font-family:inherit;font-size:13px;padding:4px 8px;border-radius:6px;
  border:1px solid var(--line);background:var(--bg);color:var(--text)}
.bgm-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent)}
.bgm-panel-foot{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.bgm-btn{flex:1;min-width:120px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);
  background:var(--bg);color:var(--text);cursor:pointer;font-size:13px;font-family:inherit}
.bgm-btn:hover{border-color:var(--accent);color:var(--accent)}
.bgm-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.bgm-btn.pri:hover{color:#fff;opacity:.9}
.bgm-stat{margin-top:12px;font-size:12px;color:var(--sub);line-height:1.7;word-break:break-all}
`;

  /**
   * 藏掉 B站原页面（document-start 就生效）。
   * 两个排除项都不能漏：
   *   - `[data-bgm-float]` —— 设置面板/toast 也挂在 body 下，漏掉会让它们被一起隐藏（DOM 在、但看不见）；
   *   - `#biliMainHeader` / `#client-app` —— 保留 B站 表头时，它们是唯二要留下的 body 子元素。
   * ⚠️ 为什么是"重新生成"而不是"再写一条覆盖规则"：`:not(#id)` 每个 id 都按 (1,0,0) 计入权重，
   *    这条规则的实际权重高达 (3,2,3)，后面再补什么规则都压不过它。所以开关保留表头必须重建样式表。
   */
  function hideCss() {
    const keep = cfg.keepHeader !== false
      ? ':not(#biliMainHeader):not(#client-app)'
      : '';
    /* 底色走 --bgm-bg（= B站 --bg2）：主题切换时变量自己变，这份样式表无需重建 */
    return `
html.bgm-takeover, html.bgm-takeover body { background:var(--bgm-bg,#f6f7f8) !important; }
html.bgm-takeover body { margin:0 !important; padding:0 !important; overflow:hidden !important; }
html.bgm-takeover body > *:not(#bgm-anime-root):not([data-bgm-float])${keep} { display:none !important; }
`;
  }

  /* ==================================================================== *
   * 4b. 保留 B站 表头
   *
   * 实测结构（2026-09-19 /anime/）：
   *   body > #biliMainHeader(static, h56, inline height:56px)
   *            > .bili-header(relative, h64)
   *                > .bili-header__bar(fixed, top:0, h64, z-index:1002, .transparent-header)
   *
   * 坑：表头是**白字**（rgb(255,255,255)）+ 顶部深色渐变，那是给番剧区那张大横幅打的底。
   *     一旦藏掉 #app（横幅就在里面），白字压在白底上直接看不见。
   * 解法：不自己写 CSS 覆盖（会连带破坏大会员图标、投稿按钮这些自身配色），
   *     而是给 bar 加上 B站 自己的 `slide-down` 类 —— 那是它滚动后的"实底"皮肤。
   *     实测效果：背景 rgb(255,255,255)、渐变消失、带阴影、文字转 rgb(24,25,28)，高度仍是 64。
   *
   * 另一个坑：bar 因为 fixed+z-index 自成一个层叠上下文，**它内部的下拉浮层也只能待在 1002 这一层**。
   *     内容区若用超高 z-index 压上去，表头的下拉（消息/动态/头像卡）就会被盖住。
   *     所以保留表头时内容区取「表头 z-index - 1」。
   * ==================================================================== */

  const HEADER_BAR = '.bili-header__bar';
  let addedSlide = false;    // slide-down 是我们补上去的（退出接管时若页面没滚动就还给 B站）

  /* B站 表头标准高度。用于「bar 还没渲染出来」时的兜底，避免内容区先按 0 排布再往下跳。
     服务端 HTML 里只有 <div id="biliMainHeader" style="height:56px"> 这个占位，
     真正的 .bili-header__bar（h64）是 B站 的异步 UMD 脚本挂上去的。 */
  const BILI_HEADER_MIN_H = 64;

  function headerBar() {
    return document.querySelector(`#biliMainHeader ${HEADER_BAR}`)
      || document.querySelector(HEADER_BAR);
  }

  /* 给 bar 补 `slide-down`；返回表头下沿 y（内容区该从哪开始）。不保留表头时返回 0。 */
  function applyHeader() {
    if (cfg.keepHeader === false) return 0;
    const bar = headerBar();
    if (bar) {
      if (!bar.classList.contains('slide-down')) {
        bar.classList.add('slide-down');
        addedSlide = true;      // 记下来，退出接管时好还给 B站
      }
      const b = Math.round(bar.getBoundingClientRect().bottom);
      if (b > 0) return b;
    }
    const mh = document.getElementById('biliMainHeader');
    if (mh) {
      const h = Math.round(mh.getBoundingClientRect().height);
      if (h > 0) return Math.max(h, BILI_HEADER_MIN_H);
    }
    return BILI_HEADER_MIN_H;
  }

  let lastTop = -1, lastZ = -1;

  /** 把表头高度 / 层级同步到 <html> 的 CSS 变量（只在变化时改，避免每个 tick 都触发样式重算） */
  function syncHeaderVars() {
    const html = document.documentElement;
    const keep = cfg.keepHeader !== false;
    let top = 0, z = 2147482000;
    if (keep) {
      top = applyHeader();
      const bar = headerBar();
      const raw = bar ? parseInt(getComputedStyle(bar).zIndex, 10) : NaN;
      z = (Number.isFinite(raw) && raw > 1) ? raw - 1 : 1001;
    }
    if (top !== lastTop) { html.style.setProperty('--bgm-top', top + 'px'); lastTop = top; }
    if (z !== lastZ) { html.style.setProperty('--bgm-z', String(z)); lastZ = z; }
    return top;
  }

  /** 配置变化后重建隐藏样式 + 表头布局 */
  function applyShellMode() {
    const html = document.documentElement;
    const keep = cfg.keepHeader !== false;
    html.classList.toggle('bgm-keep-header', keep);
    if (hideStyle) hideStyle.textContent = hideCss();
    lastTop = lastZ = -1;      // 强制重算
    syncHeaderVars();
  }

  /* ==================================================================== *
   * 5. DOM 小工具
   * ==================================================================== */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const biliSearchUrl = kw => `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}`;

  /* ==================================================================== *
   * 6. 视图：容器 / 顶栏 / 年份栏 / 月份分组 / 卡片
   * ==================================================================== */

  const view = {
    root: null,
    body: null,
    bodyIn: null,
    modesBar: null,
    yearsBar: null,
    mode: null,          // 当前 MODES 项
    year: null,          // 当前年份
    loadToken: 0,        // 切换分类/年份时作废旧请求
    observers: [],
  };

  /* ------------------------------------------------------------------
     enableDragScroll(box) —— 给横向溢出的条带补上「用手拖」的能力。
     
     为什么必须有：这两栏都把滚动条藏了（scrollbar-width:none + ::-webkit-scrollbar
     兜底），`overflow-x:auto` 于是只剩**编程式**滚动可用 —— 用户在桌面上
     （720P 窗口、鼠标）既看不到滚动条、又没有横向滚轮，就等于"看得见滚不动"。
     实测：800×600 下在 .bgm-modes 上按住拖 120px，scrollLeft 纹丝不动。
     
     三件事一起做才完整：
       ① 指针拖拽平移（鼠标/触控笔/触摸统一走 Pointer Events，setPointerCapture
          让指针移出元素也不丢手势）
       ② 纵向滚轮 → 横向滚动（鼠标用户最自然的动作；按住 shift 时浏览器已原生横向，不重复处理）
       ③ 拖拽期间临时压掉 scroll-behavior:smooth —— 否则每次改 scrollLeft 都被
          平滑动画拖后腿，手感发飘、拖拽跟手性差。
     
     刻意**不做**的事：
       · 不用 preventDefault 拦 click —— 拖拽后浏览器仍会派发 click，靠 moved 阈值
         在 capture 阶段把这一次 click 吃掉（否则"拖一下"会误触发 tab 切换）。
       · 触摸设备不加任何拦截 —— 原生触摸滚动 + 惯性比 JS 模拟好得多，交给浏览器。 */
  function enableDragScroll(box) {
    if (!box) return;
    const DRAG_THRESHOLD = 4;      // 位移超过 4px 才算"拖"，否则当点击
    let pointerId = null;          // active pointer（null = 没有进行中的手势）
    let startX = 0, startScroll = 0, moved = false;

    const isTouch = e => e.pointerType === 'touch';

    box.addEventListener('pointerdown', e => {
      if (isTouch(e)) return;                  // 触摸交给原生滚动（含惯性）
      if (e.button !== 0) return;              // 只认左键
      if (box.scrollWidth <= box.clientWidth + 1) return;   // 放得下就别拦
      pointerId = e.pointerId;
      startX = e.clientX;
      startScroll = box.scrollLeft;
      moved = false;
      // 拖拽期间禁掉平滑滚动，保证跟手
      box.style.scrollBehavior = 'auto';
      try { box.setPointerCapture(pointerId); } catch (err) { /* 老内核忽略 */ }
    });

    box.addEventListener('pointermove', e => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      moved = true;
      box.scrollLeft = startScroll - dx;
      box.classList.add('bgm-dragging');     // 光标变 grabbing
      // 拖拽中：别让文字被选中、别冒泡给上层
      e.preventDefault();
    });

    const endDrag = e => {
      if (e.pointerId !== pointerId) return;
      try { box.releasePointerCapture(pointerId); } catch (err) { /* 忽略 */ }
      pointerId = null;
      box.classList.remove('bgm-dragging');
      box.style.scrollBehavior = '';           // 交还给 CSS
    };
    box.addEventListener('pointerup', endDrag);
    box.addEventListener('pointercancel', endDrag);

    // 拖过一次之后，浏览器还会补一个 click —— 在 capture 阶段吃掉它，
    // 否则拖拽结束落在某个 tab 上会误切换分类。
    box.addEventListener('click', e => {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);

    // 纵向滚轮 → 横向。shift+滚轮是浏览器原生的横向行为，不重复处理。
    box.addEventListener('wheel', e => {
      if (e.shiftKey || e.ctrlKey) return;
      if (box.scrollWidth <= box.clientWidth + 1) return;
      const dy = e.deltaY;
      if (!dy) return;
      // 优先用像素增量；行/页模式给个折算，避免一格只滚几像素
      const step = e.deltaMode === 0 ? dy : (e.deltaMode === 1 ? dy * 16 : dy * box.clientWidth * 0.9);
      const max = box.scrollWidth - box.clientWidth;
      const next = Math.max(0, Math.min(max, box.scrollLeft + step));
      if (next !== box.scrollLeft) { box.scrollLeft = next; e.preventDefault(); }
    }, { passive: false });
  }

  function buildShell() {
    const root = el('div');
    root.id = 'bgm-anime-root';

    /* 顶栏 */
    const top = el('div', 'bgm-top');
    const topIn = el('div', 'bgm-top-in');
    const brand = el('div', 'bgm-brand');
    brand.appendChild(el('span', 'bgm-brand-dot'));
    // 文字单独给类名：窄屏 CSS 里靠它把文字收掉、只留圆点（不用 :not() 省得跟其他 span 打架）
    brand.appendChild(el('span', 'bgm-brand-txt', 'Bangumi'));
    topIn.appendChild(brand);

    const modesBar = el('div', 'bgm-modes');
    MODES.forEach(m => {
      const b = el('button', 'bgm-mode', m.label);
      b.dataset.mode = m.key;
      b.addEventListener('click', () => selectMode(m.key));
      modesBar.appendChild(b);
    });
    topIn.appendChild(modesBar);
    // 分类条：9 个 tab 在窄屏会溢出 ⇒ 补上指针拖拽 / 滚轮横向（窄屏左右滑动）
    enableDragScroll(modesBar);

    const tools = el('div', 'bgm-tools');
    const search = el('input', 'bgm-search');
    search.type = 'search';
    search.placeholder = '搜索番剧（跳 B站）';
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter' && search.value.trim()) {
        window.open(biliSearchUrl(search.value.trim()), '_blank', 'noopener');
      }
    });
    tools.appendChild(search);
    /* 主题按钮：点一下循环 跟随 B站 → 强制浅色 → 强制深色 */
    const themeBtn = el('button', 'bgm-ibtn', '◐');
    themeBtn.id = 'bgm-theme-btn';
    themeBtn.addEventListener('click', () => {
      cfg.theme = cfg.theme === 'auto' ? 'light' : (cfg.theme === 'light' ? 'dark' : 'auto');
      saveCfg();
      applyTheme();
      syncThemeBtn();
      toast(cfg.theme === 'auto' ? '主题：跟随 B站' : `主题：强制${cfg.theme === 'dark' ? '深色' : '浅色'}`);
    });
    view.themeBtn = themeBtn;
    tools.appendChild(themeBtn);
    const gear = el('button', 'bgm-ibtn', '⚙');
    gear.id = 'bgm-gear-btn';           // 供 E2E / 外部工具定位（.bgm-ibtn 不止一个了）
    gear.title = '设置';
    gear.addEventListener('click', openSettings);
    tools.appendChild(gear);
    topIn.appendChild(tools);
    top.appendChild(topIn);

    /* 年份栏 */
    const years = el('div', 'bgm-years');
    const yearsIn = el('div', 'bgm-years-in');
    years.appendChild(yearsIn);
    // 年份条：21 个 chip 在**任何**视口都溢出（实测 1280×720 也 scrollW 1369 > 1280）
    // ⇒ 它才是最需要"能拖"的一栏
    enableDragScroll(yearsIn);

    /* 主体 */
    const body = el('div', 'bgm-body');
    const bodyIn = el('div', 'bgm-body-in');
    body.appendChild(bodyIn);

    root.append(top, years, body);
    view.root = root;
    view.body = body;
    view.bodyIn = bodyIn;
    view.modesBar = modesBar;
    view.yearsBar = yearsIn;

    return root;
  }

  function syncModeButtons() {
    let active = null;
    view.modesBar.querySelectorAll('.bgm-mode').forEach(b => {
      const on = b.dataset.mode === view.mode.key;
      b.classList.toggle('on', on);
      if (on) active = b;
    });
    // 9 个分类在窄屏会溢出成横向滚动 ⇒ 选中项必须自动滚进视野，
    // 否则用 D-pad / 键盘切换时会「选中了但看不见」（浏览器 resize 后同样受益）。
    if (active && active.scrollIntoView) {
      try { active.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { /* 老内核忽略 */ }
    }
  }

  function buildYearBar() {
    const cur = new Date().getFullYear();
    view.yearsBar.textContent = '';
    for (let y = cur; y >= EARLIEST_YEAR; y--) {
      const b = el('button', 'bgm-year', String(y));
      b.dataset.year = String(y);
      b.addEventListener('click', () => selectYear(y));
      view.yearsBar.appendChild(b);
    }
    syncYearButtons();
  }

  function syncYearButtons() {
    let active = null;
    view.yearsBar.querySelectorAll('.bgm-year').forEach(b => {
      const on = Number(b.dataset.year) === view.year;
      b.classList.toggle('on', on);
      if (on) active = b;
    });
    // 年份 chip 有 21 个（2026…2006），选中的大概率在视野外 —— 与分类 tab 同理
    if (active && active.scrollIntoView) {
      try { active.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { /* 老内核忽略 */ }
    }
  }

  /* ---- 月份区块 ---- */

  function makeMonthSection(month) {
    const sec = el('section', 'bgm-month');
    sec.dataset.month = String(month);
    const h = el('h2', 'bgm-month-h');
    h.appendChild(el('span', null, `${month}月`));
    h.appendChild(el('em', null, '加载中…'));
    sec.appendChild(h);

    const ph = el('div', 'bgm-ph');
    ph.appendChild(el('div', null, '滚动到此处加载'));
    sec.appendChild(ph);
    sec.__pending = { head: h, holder: ph };
    return sec;
  }

  function renderMonthItems(sec, items, meta = {}) {
    const { head } = sec.__pending || {};

    // 调试出口：记录最近一次渲染的条目（验证平台纯度 / 过滤正确性用）。
    // ⚠️ 只留最后一次是**不够**的 —— 一个 tab 每月只 2~5 条，若只看 lastItems 会得到
    //    「平台纯度 {电视剧:2}」这种样本过小的结论。故再**累计**整个 tab 生命周期内的条目。
    if (!meta.error) {
      view.lastItems = items;
      if (!view.allItems) view.allItems = [];
      view.allItems.push(...items);
    }


    // 空月份整体隐藏（对齐 PiliPlus：Success 且非空才渲染）。
    // TV 番集中在 1/4/7/10 月首播，5/6/8/9 月常年是 0 部，留着会白占好几屏。
    if (!meta.error && !items.length) {
      sec.remove();
      return;
    }

    if (head) head.querySelector('em').textContent = meta.error
      ? `加载失败：${meta.error}`
      : `${items.length} 部`;
    const old = sec.__pending && sec.__pending.holder;
    const grid = el('div', 'bgm-grid');
    if (meta.error) {
      const box = el('div', 'bgm-empty bgm-err');
      box.textContent = `加载失败：${meta.error}`;
      const wrap = el('div');
      wrap.style.marginTop = '10px';
      const retry = el('button', 'bgm-btn');
      retry.style.maxWidth = '140px';
      retry.style.margin = '0 auto';
      retry.textContent = '重试';
      retry.addEventListener('click', () => loadMonthInto(sec, sec.dataset.month, true));
      wrap.appendChild(retry);
      box.appendChild(wrap);
      grid.appendChild(box);
    } else {
      items.forEach(it => grid.appendChild(makeCard(it)));
    }
    if (old) old.replaceWith(grid);
    else sec.appendChild(grid);
    sec.__pending = { head, holder: grid };
  }

  function makeCard(it) {
    const card = el('div', 'bgm-card');
    if (it.id != null) card.dataset.bgmId = String(it.id);   // 供 tag 补拉后就地刷新
    const kw = searchKeyword(it.nameCn, it.name);
    const title = displayTitle(it.nameCn, it.name);

    const a = el('a', 'bgm-cover');
    a.href = kw ? biliSearchUrl(kw) : '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = `${kw}${it.score != null ? `　Bangumi ${it.score.toFixed(1)}` : ''}`
      + `${it.rank ? ` #${it.rank}` : ''}`
      + `${it.date ? `　${it.date}` : ''}`;

    if (it.cover) {
      const img = el('img');
      // it.cover 是恒为 common(r400) 的**基准 URL**，宽度在这里按设置改写
      // ⇒ 改「封面质量」不必清缓存，已加载过的月份重渲染即换档
      img.src = withCoverWidth(it.cover, coverWidth());
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = title;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      a.appendChild(img);
    }

    if (cfg.showScore && it.score != null) {
      const s = el('span', 'bgm-score' + (it.score >= 7 ? ' hot' : ''), it.score.toFixed(1));
      a.appendChild(s);
    }

    const mode = view.mode;
    if (cfg.showTags && mode.showTags && it.tags.length) {
      const box = el('span', 'bgm-tags');
      it.tags.slice(0, 2).forEach(t => box.appendChild(el('i', 'bgm-tag', t)));
      a.appendChild(box);
    }

    if (cfg.showEpisodes && mode.showEpisodes && it.episodes) {
      a.appendChild(el('span', 'bgm-eps', `${it.episodes}集`));
    }

    // 右键复制关键词（对齐 PiliPlus 的 onLongPress / onSecondaryTap）
    a.addEventListener('contextmenu', e => {
      e.preventDefault();
      copyText(kw).then(ok => toast(ok ? `已复制「${kw}」` : '复制失败'));
    });

    card.appendChild(a);

    const t = el('a', 'bgm-title', title || kw);
    t.href = a.href;
    t.target = '_blank';
    t.rel = 'noopener noreferrer';
    t.title = title;
    card.appendChild(t);

    // ★ v1.6.7：卡片不再显示首播日期（标题下面那行 `.bgm-meta` 已删，样式一并移除）。
    //   `it.date` 仍保留在数据里：① 月内排序按它排（sortByDate）；② 悬停封面的 title 里仍带放送日期。
    return card;
  }

  /* ==================================================================== *
   * 7. 加载编排（逐月懒加载）
   * ==================================================================== */

  function clearObservers() {
    view.observers.forEach(o => o.disconnect());
    view.observers = [];
  }

  async function loadMonthInto(sec, month, force = false) {
    const token = view.loadToken;
    const mode = view.mode;
    const year = view.year;

    // 先给个骨架，避免空等
    if (sec.__pending && sec.__pending.holder.classList.contains('bgm-ph')) {
      const sk = el('div', 'bgm-sk');
      for (let i = 0; i < 6; i++) sk.appendChild(el('i'));
      const holder = sec.__pending.holder;
      holder.textContent = '';
      holder.classList.remove('bgm-ph');
      holder.style.height = 'auto';
      holder.appendChild(sk);
      sec.__pending.holder = sk;
    }

    const res = await loadMonth(mode, year, Number(month), { force });
    // 期间切换了分类/年份 → 丢弃结果
    if (token !== view.loadToken) return;
    renderMonthItems(sec, res.items, { error: res.error });
    // 详情补拉（默认关；仅 v0 挂掉回落 p1 时手动开）—— 不阻塞渲染，串行 + 间隔 + 长期缓存
    if (res.items.length && !res.error) {
      ensureDetailTags(res.items, mode).catch(() => {});
    }
  }

  /** 渲染某年的全部月份分组，并对每个月挂懒加载 */
  async function renderYear() {
    const token = ++view.loadToken;
    clearObservers();
    view.bodyIn.textContent = '';
    view.allItems = [];          // 换分类/年份 → 累计样本重新开始（调试出口用）

    const year = view.year;
    const mode = view.mode;
    const months = monthsOf(year);

    const sections = months.map(m => {
      const sec = makeMonthSection(m);
      view.bodyIn.appendChild(sec);
      return sec;
    });

    // 命中缓存的月份立即渲染（对齐 PiliPlus 的「先显缓存」步骤）
    let firstUnloaded = null;
    for (const sec of sections) {
      const m = Number(sec.dataset.month);
      const cached = readCache(mode, year, m);
      if (cached) {
        renderMonthItems(sec, cached, {});
      } else if (!firstUnloaded) {
        firstUnloaded = sec;
      }
    }

    view.body.scrollTop = 0;

    // 懒加载：进入视口前 400px 才开始拉
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        const sec = en.target;
        if (!en.isIntersecting || sec.__loaded || sec.dataset.month == null) continue;
        sec.__loaded = true;
        io.unobserve(sec);
        loadMonthInto(sec, sec.dataset.month);
      }
    }, { root: view.body, rootMargin: '400px 0px' });

    view.observers.push(io);
    sections.forEach(sec => {
      if (sec.__pending && sec.__pending.holder.classList.contains('bgm-ph')) io.observe(sec);
    });

    if (token !== view.loadToken) return;
  }

  function selectMode(key) {
    const m = MODES.find(x => x.key === key) || MODES[0];
    if (view.mode && view.mode.key === m.key) return;
    view.mode = m;
    cfg.mode = m.key;
    saveCfg();
    syncModeButtons();
    renderYear();
  }

  function selectYear(y) {
    if (view.year === y) return;
    view.year = y;
    syncYearButtons();
    renderYear();
  }

  /* ==================================================================== *
   * 8. 提示 / 复制 / 设置面板
   * ==================================================================== */

  function toast(msg, ms = 1800) {
    const t = el('div', null, msg);
    t.dataset.bgmFloat = '';       // 标记为浮层，避免被 hideCss 连坐隐藏
    Object.assign(t.style, {
      position: 'fixed', left: '50%', bottom: '48px', transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,.78)', color: '#fff', padding: '8px 16px', borderRadius: '8px',
      fontSize: '13px', zIndex: 2147483600, pointerEvents: 'none',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.dataset.bgmFloat = '';   // 不加会被 hideCss 设成 display:none，隐藏的 textarea 无法 select
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function openSettings() {
    const mask = el('div', 'bgm-mask');
    mask.dataset.bgmFloat = '';    // 同上：面板属于浮层
    const panel = el('div', 'bgm-panel');
    panel.appendChild(el('h3', null, `设置 · v${VERSION}`));

    const rowCheck = (label, key, onChange) => {
      const r = el('div', 'bgm-row');
      r.appendChild(el('span', null, label));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!cfg[key];
      cb.addEventListener('change', () => {
        cfg[key] = cb.checked;
        saveCfg();
        if (onChange) onChange();
      });
      r.appendChild(cb);
      panel.appendChild(r);
    };

    const rowSelect = (label, key, options, onChange) => {
      const r = el('div', 'bgm-row');
      r.appendChild(el('span', null, label));
      const sel = el('select');
      options.forEach(([v, t]) => {
        const o = el('option', null, t);
        o.value = v;
        if (String(cfg[key]) === String(v)) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        cfg[key] = isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
        saveCfg();
        if (onChange) onChange();
      });
      r.appendChild(sel);
      panel.appendChild(r);
    };

    rowCheck('保留 B站 顶栏（内容区下移）', 'keepHeader', () => applyShellMode());
    rowCheck('显示 Bangumi 评分徽章', 'showScore', () => renderYear());
    rowCheck('显示流派 tag（白名单）', 'showTags', () => renderYear());
    rowCheck('无题材/来源词时用平台·地区兜底（Tier3，会显示「TV/日本」）', 'showTier3', () => renderYear());
    rowSelect('主题', 'theme', [
      ['auto', '跟随 B站（推荐）'],
      ['light', '强制浅色'],
      ['dark', '强制深色'],
    ], () => { applyTheme(); syncThemeBtn(); });
    rowSelect('详情补拉（v0 已自带全量 tag，正常不需要）', 'tagDetail', [
      ['off', '关闭（推荐 · 省请求）'],
      ['empty', '仅补完全空白的卡片'],
      ['fill', '没有题材词就补（应急）'],
    ], () => renderYear());
    rowCheck('显示集数（仅 TV）', 'showEpisodes', () => renderYear());
    rowCheck('隐藏无评分条目（默认开 · 改动需清缓存）', 'hideNoScore');
    rowSelect('数据通路', 'source', [
      ['auto', '自动（v0 → p1）'],
      ['v0', '仅 api.bgm.tv/v0（推荐 · 带全量 tag）'],
      ['p1', '仅 next.bgm.tv/p1（无 tag，需开补拉）'],
    ], () => { Object.keys(cooling).forEach(k => delete cooling[k]); renderYear(); });
    rowSelect('并发请求', 'concurrent', [[1, '1（最稳）'], [2, '2'], [3, '3'], [4, '4（最快）']]);
    rowSelect('单月最多翻页', 'maxPages', [[3, '3 页'], [6, '6 页'], [12, '12 页'], [30, '30 页']]);
    // 封面质量：lain.bgm.tv 只有离散档位 —— 实测 r50/r150/r300 均 HTTP 400。
    // 每档字节数按 2026-07 新番抽样实测标注；卡片列宽 132px（窄屏 104px），
    // 1× 屏 r100 够用、2× 屏 r200 合适（默认）、3× 屏 r400 才清晰。
    rowSelect('封面质量（改动即刻生效）', 'coverQuality', [
      [100, '最低 r100（约 6 KB/张 · 1× 屏够用）'],
      [200, '低 r200（约 21 KB/张 · 2× 屏合适·默认）'],
      [400, '标准 r400（约 71 KB/张 · 3× 屏清晰）'],
      [600, '高 r600（约 148 KB/张）'],
      [800, '很高 r800（约 242 KB/张）'],
      [0, '原图（约 864 KB/张 · 慎选）'],
    ], () => renderYear());
    // 缓存时效：这两项原先只存在于 cfg、没有任何 UI ⇒ 名义可配、实际改不了
    rowSelect('缓存时效 · 当年（改动后需清缓存才生效）', 'ttlHoursThisYear', [
      [1, '1 小时（最跟手）'], [6, '6 小时'], [12, '12 小时（默认）'],
      [24, '24 小时'], [72, '3 天'], [168, '7 天'],
    ]);
    rowSelect('缓存时效 · 历史年（改动后需清缓存才生效）', 'ttlDaysPastYear', [
      [1, '1 天'], [7, '7 天'], [30, '30 天（默认）'], [90, '90 天'], [365, '1 年'],
    ]);

    const stat = el('div', 'bgm-stat');
    const cachedN = (store.get('cacheKeys', []) || []).length;
    stat.innerHTML = `通路请求：成功 ${netStats.ok} / 失败 ${netStats.err}<br>`
      + `通路使用：${Object.entries(netStats.bySource).map(([k, v]) => `${k}×${v}`).join('，') || '—'}<br>`
      + (Object.keys(netStats.errBySource).length
        ? `通路失败：${Object.entries(netStats.errBySource).map(([k, v]) => `${k}×${v}`).join('，')}<br>` : '')
      + (netStats.lastErrors.length
        ? `最近错误：${netStats.lastErrors.slice(-2).join('；')}<br>` : '')
      + (cfg.tagDetail === 'off' ? '详情补拉：关<br>' : `详情补拉：${netStats.detail} 次<br>`)
      + `Tag 白名单：T1 题材 ${TAG_T1.length} / T2 来源·受众 ${TAG_T2.length} / T3 平台·地区 ${cfg.showTier3 !== false ? TAG_T3.length : '关'}<br>`
      + `主题：${cfg.theme === 'auto' ? '跟随 B站' : `强制${cfg.theme === 'dark' ? '深色' : '浅色'}`} · 判定为${themeDark ? '深色' : '浅色'}<br>`
      + `缓存月份：${cachedN} 条`;
    panel.appendChild(stat);

    const foot = el('div', 'bgm-panel-foot');
    const bCache = el('button', 'bgm-btn', '清空缓存并重载');
    bCache.addEventListener('click', () => {
      const n = store.clearCache();
      toast(`已清空 ${n} 条缓存`);
      close();
      renderYear();
    });
    const bClose = el('button', 'bgm-btn', '关闭');
    bClose.addEventListener('click', close);
    const bOff = el('button', 'bgm-btn', '恢复 B站原页面');
    bOff.addEventListener('click', () => {
      stopTakeover();
      close();
    });
    foot.append(bCache, bClose, bOff);
    panel.appendChild(foot);

    mask.appendChild(panel);
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.body.appendChild(mask);

    function close() { mask.remove(); }
  }

  /* ==================================================================== *
   * 9. 接管与卸载
   * ==================================================================== */

  const TAKEOVER_RE = /^\/anime(\/|$)/;
  let hideStyle = null;
  let wired = false;

  function shouldTakeOver() {
    return cfg.enabled !== false && TAKEOVER_RE.test(location.pathname);
  }

  function startTakeover() {
    if (!shouldTakeOver()) return;
    const html = document.documentElement;
    html.classList.add('bgm-takeover');
    html.dataset.bgmTakeover = '1';   // 接管中标记：外部脚本/工具（含 E2E）据此判断本脚本是否生效

    /* 主题：先判定并打上 bgm-dark/bgm-light（在注入样式前，避免白闪），
       再挂订阅 → 主题一变，顶栏按钮与 B站 头像弹层里的状态行一起更新 */
    watchTheme();
    onTheme(() => { syncThemeBtn(); updateStatusItem(); });
    watchStatusItem();

    if (!hideStyle) {
      hideStyle = document.createElement('style');
      hideStyle.id = 'bgm-anime-hide';
      (document.head || html).appendChild(hideStyle);
    }
    // 每次都按当前配置重新生成（保留表头与否 = 选择器不同，无法用覆盖规则切换）
    hideStyle.textContent = hideCss();
    html.classList.toggle('bgm-keep-header', cfg.keepHeader !== false);
    lastTop = lastZ = -1;

    if (document.getElementById('bgm-anime-root')) return;

    if (!document.body) {
      // document-start 阶段：先铺纯色遮罩，避免闪出 B站页面
      const cover = document.createElement('div');
      cover.id = 'bgm-anime-cover';
      Object.assign(cover.style, {
        // 跟随 B站 主题底色（此时我们的样式还没注入，故用 B站 的 --bg2 兜底）
        position: 'fixed', inset: '0', zIndex: 2147481000,
        background: 'var(--bg2,#f6f7f8)',
      });
      html.appendChild(cover);
      document.addEventListener('DOMContentLoaded', () => {
        cover.remove();
        mount();
      }, { once: true });
      return;
    }
    mount();
  }

  function mount() {
    if (document.getElementById('bgm-anime-root')) return;
    if (typeof GM_addStyle !== 'function') {
      const s = document.createElement('style');
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    const root = buildShell();
    document.body.appendChild(root);
    syncHeaderVars();          // 量出表头下沿，把内容区放到它下面

    // B站 表头是异步渲染的：量到真值（bar 出现且有高度）之前先用兜底高度，
    // 起来后立刻校正，避免内容区先按 0 排布再往下跳。
    if (cfg.keepHeader !== false) {
      let tries = 0;
      const settle = setInterval(() => {
        tries++;
        syncHeaderVars();
        const bar = headerBar();
        if ((bar && bar.getBoundingClientRect().bottom > 0) || tries >= 20) clearInterval(settle);
      }, 100);
    }

    document.title = 'Bangumi';

    view.mode = MODES.find(m => m.key === cfg.mode) || MODES[0];
    view.year = new Date().getFullYear();
    syncModeButtons();
    syncThemeBtn();
    buildYearBar();
    renderYear();
    wireGlobal();
  }

  function wireGlobal() {
    if (wired) return;
    wired = true;
    // B站番剧区是 hash 路由，pathname 变化才是真跳转
    window.addEventListener('popstate', checkRoute);
    window.addEventListener('hashchange', checkRoute);
    window.addEventListener('resize', syncHeaderVars);
    const tick = setInterval(() => {
      if (!document.getElementById('bgm-anime-root')) { clearInterval(tick); return; }
      checkRoute();
      // 表头是 B站 的 JS 后渲染的，而且它自己可能把 slide-down 摘掉 → 每次兜一遍
      if (cfg.keepHeader !== false) syncHeaderVars();
    }, 1200);
  }

  function checkRoute() {
    if (!shouldTakeOver()) stopTakeover();
  }

  function stopTakeover() {
    clearObservers();
    view.loadToken++;
    const html = document.documentElement;
    html.classList.remove('bgm-takeover', 'bgm-keep-header', 'bgm-dark', 'bgm-light', 'bgm-forced');
    delete html.dataset.bgmTakeover;
    delete html.dataset.bgmTheme;
    const st = document.getElementById(STATUS_ITEM_ID);
    if (st) st.remove();              // 状态行是我们插进 B站 面板的，还给它
    html.style.removeProperty('--bgm-top');
    html.style.removeProperty('--bgm-z');
    lastTop = lastZ = -1;
    // 把 B站 表头还回去：slide-down 是我们补的，且页面确实没滚动过，才摘掉
    //（否则会误摘 B站 自己滚动时才加的那次）
    if (addedSlide) {
      const bar = headerBar();
      if (bar && window.scrollY === 0) bar.classList.remove('slide-down');
      addedSlide = false;
    }
    if (hideStyle) { hideStyle.remove(); hideStyle = null; }
    const root = document.getElementById('bgm-anime-root');
    if (root) root.remove();
    const cover = document.getElementById('bgm-anime-cover');
    if (cover) cover.remove();
    // 恢复原页面时把 B站自己的样式/内容交还（它们只是被 CSS 藏起来，未删除）
  }

  /* ==================================================================== *
   * 10. 启动
   * ==================================================================== */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('恢复 B站原页面（本次会话）', () => stopTakeover());
    GM_registerMenuCommand('清空 Bangumi 缓存', () => {
      const n = store.clearCache();
      alert(`已清空 ${n} 条缓存`);
      if (document.getElementById('bgm-anime-root')) renderYear();
    });
  }

  startTakeover();

  // 调试出口（控制台 / 离线单测 / 端到端验证）
  const API = {
    VERSION, MODES, TAG_WHITELIST, TAG_T1, TAG_T2, TAG_T3, TAG_GROUP, cfg, store, netStats,
    parseInfo, pickTags, hasGenreTag, displayTitle, searchKeyword, normScore,
    COVER_TIERS, pickCover, withCoverWidth, coverWidth,   // 封面档位（E2E 靠它算期望档位）
    fromP1, fromV0, monthsOf, compareItems,
    loadMonth, activeSources, ensureDetailTags, fetchDetailTags, readDetailCache,
    view, renderYear, selectMode, selectYear, startTakeover, stopTakeover,
    lastItems: () => view.lastItems,
    hideCss, applyShellMode, syncHeaderVars, headerBar,
    // 主题 / 状态行（这两块是可移植的独立模块）
    luminance, detectDark, applyTheme, onTheme, syncThemeBtn, themeDark: () => themeDark,
    ensureStatusItem, updateStatusItem, statusLabel, statusTip,
  };
  window.__BGM_ANIME__ = API;
  // ⚠️ 油猴沙箱里的 window 与页面 window 不是同一个对象：
  //    只写 `window.__BGM_ANIME__` 的话，F12 控制台和 CDP 都看不到（它们看的是页面 window）。
  //    要走 unsafeWindow 才能真正挂到页面上（这也是验证工具能读到状态的前提）。
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) unsafeWindow.__BGM_ANIME__ = API;
  } catch (e) { /* 有些环境不给 unsafeWindow，忽略即可 */ }
})();
