/**
 * sidecar ⇄ Swift 的协议，以及引擎内部模型。
 * Swift 只做展示：吃 `state` 快照、按 `new_token` 弹卡、替 sidecar 代发 gmgn 请求（rpc）。
 */

import type { Erc20Verdict } from "./erc20.js";
import type { HoneypotVerdict } from "./honeypot.js";

// ---------- 行情 ----------

/** 行情快照（DexScreener / gmgn 都归一到这里） */
export interface Market {
  symbol?: string;
  name?: string;
  logo?: string; // 头像 URL（gmgn logo / DexScreener info.imageUrl）
  chain?: string; // gmgn 口径：bsc / eth / base / sol / robinhood …
  price?: number;
  mc?: number;
  liq?: number;
  change5m?: number;
  change1h?: number;
  change24h?: number;
  holders?: number;
  /** gmgn 的历史价桶：key = 多少秒前（60/300/3600/21600/86400）。回灌喊单没有当时价，取最近的桶近似 */
  priceAgo?: Record<number, number>;
  source: "gmgn" | "dex";
  updatedAt: number; // unix 秒
}

/** 一次喊单 */
export interface Mention {
  sender: string;
  time: number; // unix 秒
  text: string;
  /** 来源群：微信 username，或 feishu:oc_xxx。 */
  group: string;
  /** 喊单时刻的价：live 喊单 = 首次拉到的现价；回灌 = gmgn 分钟蜡烛 */
  price?: number;
  mc?: number;
  approx: boolean;
}

/** 代币的社交链接（gmgn multi_token_full_info.link） */
export interface Links {
  twitter?: string; // 完整 URL
  website?: string;
  telegram?: string;
}

export interface TwitterUser {
  name: string;
  screen: string;
  avatar: string;
  followers: number;
  verified: boolean;
  bio?: string;
  joined?: number; // unix 秒
  following?: number;
  location?: string;
  banner?: string;
}

/** 一条推文（官方推特内容 / 提到该代币的推文） */
export interface Tweet {
  id: string;
  url: string;
  time: number; // unix 秒
  kind: string; // tweet / reply / quote / retweet
  user: TwitterUser;
  text: string;
  likes?: number;
  image?: string;
  /** 中文译文（sidecar 翻译，见 translate.ts）；原文已是中文 / 还没翻 / 翻译失败 → null */
  translation: string | null;
  /** 引用/回复的原推（gmgn `source_*` 字段）。只嵌一层：quoted.quoted 恒为 null */
  quoted: Tweet | null;
}
export interface Ath {
  price: number;
  mc: number;
  time: number;
}
export interface Sample {
  time: number; // unix 秒
  price: number;
  /** 市值：对 decimals 抖动免疫（新币刚收录时 price/supply 常反向错一个数量级，mc 不变），涨跌/K 线优先用它 */
  mc?: number;
}

/** 引擎内的代币状态 */
export interface TokenState {
  address: string; // 小写
  chainHint: string | null;
  market: Market | null;
  mentions: Mention[];
  history: Sample[]; // 自首次喊单起的价格采样（内存里最多 MAX_HISTORY 点，全量在 Store）
  links: Links | null;
  ath: Ath | null;
  /** 官方推特账号资料（gmgn 悬浮卡那种：头像/名/简介/粉丝/注册时间） */
  profile: TwitterUser | null;
  /** 官方推特内容：links.twitter 指向的推文，或该账号本人提到该币的推文 */
  official: Tweet[];
  /** 社区提到该代币的推文（gmgn 搜索） */
  tweets: Tweet[];
  tweetsAt: number; // 上次拉推文的 unix 秒，0 = 没拉过
  /**
   * 行情源（Dex / gmgn）都查不到时的链上 ERC20 探测结论（erc20.ts）；checkedAt = unix 秒。
   * 只在 `market === null` 时有意义：确定的 non-erc20 且未过期（Engine.ERC20_TTL）→ 面板 / dashboard 都不显示（记录仍在库里）；行情一旦到达就清掉
   */
  erc20Check?: { verdict: Erc20Verdict; checkedAt: number };
  /** 貔貅探测结论（honeypot.ts）；`honeypot` → 面板不显示、dashboard 不计入（记录仍在库里） */
  honeypotCheck?: { verdict: HoneypotVerdict; checkedAt: number };
}

/** 官方推特本次请求状态（仅进程内，不把 loading/error 落库）。 */
export interface TwitterRequest {
  status: "idle" | "waiting_chain" | "no_link" | "unsupported" | "loading" | "ready" | "empty" | "error";
  error: string | null;
}

// ---------- 给 Swift 的展示快照 ----------

export interface TokenView {
  address: string;
  chainHint: string | null;
  market: Omit<Market, "priceAgo"> | null;
  mentions: Mention[];
  /** 归一化 0..1 的折线点（≤48）；不足 2 点时是平线 */
  spark: number[];
  /** 有 ≥2 个真实采样点（K 线不是占位） */
  live: boolean;
  trend: 1 | -1;
  /** 自首次喊单到现在的涨跌 %（跟单收益视角，不是市场 1h） */
  change: number | null;
  changeApprox: boolean;
  kol: number;
  firstSeen: number;
  links: Links | null;
  ath: Ath | null;
  profile: TwitterUser | null;
  official: Tweet[];
  twitterRequest: TwitterRequest;
  tweets: Tweet[];
  /** fomo.family 代币页（链映射不了就 null，按钮不显示） */
  fomoURL: string | null;
  /** fomo.family 上「我关注的人」对该币的动向（fomo.ts）；未登录 / 该链 fomo 不支持 → null */
  fomo: FomoView | null;
  /** 本机 burner 钱包对该币的持仓（trade.ts：链上余额 × 引擎现价）；没持有 / 还没读到 → null */
  position: TradePosition | null;
  /** true = 不在追踪列表里的「当前持仓」临时快照（`token_detail`）；`state` 里的代币不带 */
  holdingOnly?: boolean;
}

/** 弹卡右栏契约：关注者买卖/Thesis 明细 + 去重买入人数 + 当前持有人数 */
export interface FomoView {
  /** 关注者中买过该币的去重人数（swap_buy / thesis 的 authorTrade 买入 / transfer_in 都算买） */
  buyers: number;
  /** POST /hodlers/friends 的「关注者当前持有人数」，没拿到 null */
  holders: number | null;
  /** 按 ts 降序，≤30 条；thesis 的 comment 必有 */
  activity: FomoActivity[];
  /** 「fomo 前排比例」快照（焦点币每 15s 刷；主面板显示行经 `front_rank_visible` 串行队列 ≥45s 刷）；还没拉过 / 快照过期（>60s）→ null */
  frontRank: FomoFrontRank | null;
}

/**
 * fomo 前排比例 = fomo 全站前 n（≤50）名持有人代币数合计 ÷ gmgn 前排（**仅排除 pool**，`addr_type === 2`；燃烧地址 / 交易所钱包 / dev 保留）前 n（≤50）名代币数合计。
 * 两边都是人类单位代币数，同一供应量约掉。两源必须同一轮都成功才出数：任一侧失败 / 字段缺失 / gmgn 前 100 名里非 pool 不足 50 → `ratio = null` + `why`。
 */
export interface FomoFrontRank {
  /** fomo Σ / gmgn Σ；fomo 列表真为空 → 0；不可用 → null */
  ratio: number | null;
  /** fomo 侧：Σ humanAmount 与实际行数（服务端最多 50） */
  fomo: { amount: number; n: number } | null;
  /** gmgn 侧：排除 pool 后前 n 名 Σ balance、n、被排除的 pool 行数 */
  gmgn: { amount: number; n: number; pools: number } | null;
  /** 快照时间（秒） */
  at: number;
  /** 不可用原因（ratio 为 null 时必有） */
  why: string | null;
}

// ---------- 一键买卖（trade.ts：本地 burner 热钱包签名 + OKX DEX 路由） ----------

export type TradeChain = "eth" | "bsc" | "base" | "monad" | "robinhood" | "sol";
/** 原生币符号：买入按它计价、快捷额按它分组（eth/base/robinhood 都是 ETH） */
export type NativeSymbol = "ETH" | "BNB" | "SOL" | "MON";
export const NATIVE_SYMBOLS: readonly NativeSymbol[] = ["ETH", "BNB", "SOL", "MON"];
export const NATIVE_SYMBOL: Record<TradeChain, NativeSymbol> = { eth: "ETH", bsc: "BNB", base: "ETH", monad: "MON", robinhood: "ETH", sol: "SOL" };
/** 买入快捷额（原生币数量）按原生币分组 */
export type BuyPresets = Record<NativeSymbol, number[]>;

export interface TradePosition {
  /** 代币数量（人类单位，链上余额 ÷ 10^decimals） */
  amount: number;
  /** amount × 引擎现价（gmgn 20s 刷新 / 焦点币 WS tick）；没有现价 → null */
  usd: number | null;
}

/** 交易模块状态（启动、余额变化、设置变化、成交后推） */
export interface TradeStateEvent {
  t: "trade_state";
  /** 钱包已生成（OKX 出口固定，没有别的门禁） */
  ready: boolean;
  /** 不 ready 的人话原因；ready 时 null */
  reason: string | null;
  evmAddress: string | null;
  solAddress: string | null;
  /**
   * 各链原生币余额（人类单位）。price = 该原生币美元价（native-price.ts 后台 60s 从 DexScreener 拉，只做显示与限额校验，报价路径不等它）；
   * 还没拉到 → null，usd 跟着 null
   */
  balances: Record<TradeChain, { native: number; symbol: NativeSymbol; price: number | null; usd: number | null }>;
  presets: { buy: BuyPresets; sell: number[] };
  /** perTrade/perDay 来自设置；dayUsed = 最近 24h 内 status ∈ {submitted, confirmed, unknown} 的**买入** usd 合计 */
  limits: { perTrade: number; perDay: number; dayUsed: number };
  at: number;
}

/**
 * 一份只读展示报价（OKX `/quote`）。只在用户输入金额 / 点快捷额时问**一次**，没有周期刷新、没有过期时间：
 * 点执行时 `/swap` 现取新路由 + 未签名交易，成交保护靠 autoSlippage（≤15%）与 priceImpactProtection，与展示价无关。
 * `id` 是执行意图要钉住的那份（防重放、防金额与报价不一致）。
 */
export interface TradeQuoteEvent {
  t: "trade_quote";
  id: string;
  address: string;
  chain: string;
  side: "buy" | "sell";
  /** buy：请求的原生币数量（人类单位，Swift 原样回传给 `trade` 意图）；sell：0（按 pct） */
  amount: number;
  /** sell：持仓比例 1–100；buy：null */
  pct: number | null;
  /** 估值（只做显示）：buy = amount × 原生币缓存价；sell = 卖出数量 × 现价（引擎价，退 OKX 给的价）；没有价 → null */
  usd: number | null;
  ok: boolean;
  outAmount: number | null;
  outSymbol: string | null;
  outUsd: number | null;
  networkFeeUsd: number | null;
  priceImpactPct: number | null;
  /** OKX 对代币的标记 */
  honeypot: boolean;
  /** 买入税 / 卖出税（%），OKX taxRate ×100；0 → 0 */
  taxPct: number | null;
  /** 本地最低额（USD；有原生币价时才判） */
  minUsd: number;
  error: string | null;
  at: number;
}

type TradeStatus = "validating" | "submitting" | "submitted" | "confirmed" | "failed" | "unknown";

/**
 * 一次下单的生命周期（按地址一条最新）。validating → submitting（签名/广播前；sell 可能先授权）→ submitted（拿到 hash）→ confirmed | failed。
 * 广播后等回执超时 → unknown，由对账（轮询 receipt）改终态；绝不自动重发。
 */
export interface TradeEvent {
  t: "trade";
  id: string;
  address: string;
  chain: string;
  side: "buy" | "sell";
  /** 账本估值（USD）：buy = 原生币数量 × 缓存价（没价拒单）；sell = 卖出数量 × 现价 */
  usd: number;
  /** sell 的持仓比例整数 1–100；buy 为 null */
  pct: number | null;
  status: TradeStatus;
  txHash: string | null;
  error: string | null;
  /** 人话细节（授权中 / 等待确认 / 拒绝原因） */
  detail: string | null;
  ts: number;
}

/**
 * 主面板「当前持仓」一行：burner 钱包在该链对该币的链上余额（只跟踪账本里 confirmed 过的币 + 当前焦点币；外部转入的币不会出现）。
 * 估值用引擎现价；累计买卖与均价按我们自己的账本算（confirmed 记录），不掺任何第三方口径。
 */
export interface TradeHolding {
  /** 规范化地址（EVM 小写） */
  address: string;
  chain: string;
  symbol: string;
  name: string | null;
  logo: string | null;
  amount: number;
  price: number | null;
  usd: number | null;
  /** 账本累计（confirmed 买 / 卖的 usd 合计） */
  boughtUsd: number;
  soldUsd: number;
  /** usd + soldUsd − boughtUsd；usd 缺 → null。pnlPct = pnlUsd / boughtUsd ×100，boughtUsd 0 → null */
  pnlUsd: number | null;
  pnlPct: number | null;
  /** 第一笔 confirmed 买入的 ts；没有 → null */
  heldSince: number | null;
  /** K 线买卖线：账本均价（USD/枚）= Σusd / Σ数量；该侧没有 → null；两侧都没有 → null */
  tradePrices: { buy: number | null; sell: number | null } | null;
}

export interface FomoActivity {
  handle: string;
  avatar: string | null;
  kind: "buy" | "sell" | "thesis";
  usd: number | null;
  mc: number | null;
  /** unix 秒 */
  ts: number;
  comment: string | null;
}

/** fomo 代币页「Thesis」列的一条（`GET /feed/token/thesis`，全站用户，不限关注者） */
export interface FomoThesis {
  /** 服务端 alert id（翻页 lastId / 去重键） */
  id: string;
  handle: string;
  /** 显示名（与 handle 不同才有意义） */
  name: string;
  avatar: string | null;
  verified: boolean;
  /** unix 秒 */
  ts: number;
  comment: string;
  likes: number;
  replies: number;
  /** 作者对该币的持仓（`authorTrade`）：数量 > 0 才有 */
  position: { usd: number; unrealizedPct: number | null } | null;
  isDev: boolean;
}

export type FomoThesisError = "not_logged_in" | "unsupported_chain" | "chain_unknown" | "fetch_failed" | "schema";

/** 弹卡「fomo Thesis」列：某币（chain+address）的 Thesis 快照（按 ts 降序、已翻到的全部页） */
export interface FomoThesisEvent {
  t: "fomo_thesis";
  address: string;
  chain: string | null;
  items: FomoThesis[];
  /** 服务端给的总数（未知 null） */
  count: number | null;
  hasNext: boolean;
  /** 快照时间（秒）；error 时为失败时刻 */
  at: number;
  /** 非 null 时 items 只是已有缓存（可能为空） */
  error: FomoThesisError | null;
  /** 正在拉（首页或下一页） */
  loading: boolean;
}

/** gmgn 代币页「喊单 → GMGN喊单」一条（`GET /api/v1/token/{chain}/{addr}/community/messages`，公开接口） */
export interface GmgnCall {
  /** `ulid`（翻页/去重键） */
  id: string;
  /** X 用户名（`username`）；`url` = user_twitter_url */
  handle: string;
  name: string;
  url: string | null;
  avatar: string | null;
  followers: number;
  verified: boolean;
  kol: boolean;
  /** unix 秒 */
  ts: number;
  text: string;
  image: string | null;
  likes: number;
  replies: number;
  /** 喊单后市值倍数（`multiplier`）；解析不出 null */
  multiplier: number | null;
  /** 是「喊回」别人的一条（`callback_to_ulid`） */
  replyTo: string | null;
}

/**
 * 弹卡「GMGN 喊单」列：原生 GMGN喊单（community/messages，cursor 翻页）+ 同页签下的「X喊单」（`tweets`，即 `/vas/api/v1/twitter/token/search` 前 100 条，按时间降序）。
 * 官方推特 / 群内喊单是别的列，不混。
 */
export interface GmgnCallsEvent {
  t: "gmgn_calls";
  address: string;
  chain: string | null;
  items: GmgnCall[];
  hasNext: boolean;
  /** 上次成功拉取（秒）；0 = 还没拉到 */
  at: number;
  /** 拉取失败原因（有旧缓存时 items 仍给缓存）；链未知 → "chain_unknown" */
  error: string | null;
  loading: boolean;
  tweets: Tweet[];
  tweetsAt: number;
  tweetsLoading: boolean;
  /** X喊单 最近一次拉取失败原因；成功后 null */
  tweetsError: string | null;
}

/** 一键买卖（OKX DEX + 本地 burner 热钱包）的本机配置。OKX 出口固定（okx.ts OKX_API_BASE），本机没有凭据相关设置 */
export interface TradeSettings {
  /** RPC 覆盖（默认公共节点；Robinhood 建议 Alchemy、Solana 建议 Helius 之类） */
  rpc: Partial<Record<TradeChain, string>>;
  /** 单笔买入上限（USD） */
  maxUsdPerTrade: number;
  /** 滚动 24h 买入合计上限（USD），≥ maxUsdPerTrade */
  maxUsdPerDay: number;
  /** 快捷额：买 = 原生币数量，按 ETH / BNB / SOL / MON 分组（每组 1–6 个、>0）；卖 = 持仓百分比整数（1–6 个、1–100） */
  presets: { buy: BuyPresets; sell: number[] };
}

export interface Settings {
  /** 监听的微信群 username 列表 */
  groups: string[];
  /** 监听的飞书群原始 chat_id（oc_xxx），与微信独立保存。 */
  feishuGroups: string[];
  /** 监听的 QQ 群 ID（OneBot group_id），与微信 / 飞书独立保存。 */
  qqGroups: string[];
  /** 悬浮窗尺寸与背景不透明度（0–1）；x / y / compact 是 Windows 壳记住的位置与收起态（macOS 不读） */
  panel: { width: number; height: number; backgroundOpacity: number; x?: number | null; y?: number | null; compact?: boolean };
  /** 新币自动弹卡（Windows 壳）：card = 弹详情卡，notify = 只发系统提醒，off = 都不弹；seconds = 自动卡停留秒数 */
  popup: PopupSettings;
  /** QQ OneBot 连接：enabled 后才去连本机桥接；url / token 留空时回退到环境变量与默认地址 */
  qq: QQSettings;
  /** 用户在悬浮窗里选了「不再显示」的代币地址（喊单记录照常保留，只是不上面板 / dashboard 代币页） */
  mutedTokens: string[];
  trade: TradeSettings;
}

export type PopupMode = "card" | "notify" | "off";
export interface PopupSettings { mode: PopupMode; seconds: number }
export interface QQSettings { enabled: boolean; url: string; token: string }

export const DEFAULT_SETTINGS: Settings = {
  groups: [], // 首启没有群：dashboard「群组」页引导配好来源后再勾选
  feishuGroups: [],
  qqGroups: [],
  panel: { width: 326, height: 592, backgroundOpacity: 1 },
  popup: { mode: "card", seconds: 6 },
  // 老用户按 README 设过 FOMOMO_ONEBOT_ENABLED=1：界面里还没存过 QQ 设置时沿用它，存过以后以界面为准
  qq: { enabled: process.env.FOMOMO_ONEBOT_ENABLED === "1", url: "", token: "" },
  mutedTokens: [],
  trade: {
    rpc: {},
    maxUsdPerTrade: 200,
    maxUsdPerDay: 1000,
    // 2026-09-11 按当日价凑到 ≈$5 / 25 / 50 / 250（ETH $2469、BNB $716、SOL $100、MON $0.024）
    presets: { buy: { ETH: [0.002, 0.01, 0.02, 0.1], BNB: [0.007, 0.035, 0.07, 0.35], SOL: [0.05, 0.25, 0.5, 2.5], MON: [200, 1000, 2000, 10000] }, sell: [25, 50, 100] },
  },
};

// ---------- stdout 事件（sidecar → Swift） ----------

export type OutEvent =
  | { t: "ready"; groups: Array<{ username: string; displayName: string }>; since: number }
  | { t: "state"; tokens: TokenView[] }
  | { t: "new_token"; address: string }
  /** 追踪代币被判定为非 ERC20 而从 `state` 里消失（只在「显示 → 隐藏」的转变时发，紧跟在已不含它的 `state` 之后）：Swift 据此收掉它的弹卡 / 待弹队列 */
  | { t: "token_hidden"; address: string }
  | { t: "heartbeat"; maxTime: number; polls: number }
  | { t: "error"; message: string }
  /** dashboard 地址（sidecar 起的本地 HTTP） */
  | { t: "dashboard"; url: string }
  /**
   * 弹卡 K 线：[time, open, high, low, close, volume]，time 为 unix 秒；bars 为该分辨率下 sidecar 缓存的全部（已合并分页）。
   * `error` 非空 = 这次拉取失败（bars/covered 是之前缓存的，没有就是空 + 零长度 covered）；bars 空且 error 为 null = 该范围真没成交
   */
  | {
      t: "kline";
      address: string;
      /** 实际路由的链（gmgn slug） */
      chain: string;
      resolution: string;
      bars: Array<[number, number, number, number, number, number]>;
      /** 已实际拉取过的时间范围（1s 级别没成交就没蜡烛，不能拿首末根当覆盖） */
      covered: [number, number];
      calls: Array<[number, string, string]>;
      error?: string | null;
    }
  /**
   * 弹卡「群内喊单」的语境：某次喊单（sender @ ts）那条消息前后的群聊原文。
   * `call` = 喊单那条在 lines 里的下标。
   */
  | { t: "context"; address: string; sender: string; ts: number; group: string; lines: Array<{ time: number; sender: string; text: string }>; call: number }
  /** gmgn 实时成交推着 K 线最后一根走：替换同 t 的蜡烛，没有就追加 */
  | { t: "kline_bar"; address: string; chain: string; resolution: string; bar: [number, number, number, number, number, number] }
  /** 不在追踪列表里的「当前持仓」弹卡快照（与 `state` 里的 TokenView 同构，`holdingOnly=true`）：只对当前 focus 的持仓推，绝不进 `state` / 落库 */
  | { t: "token_detail"; token: TokenView }
  /**
   * 各来源已选群的监听异常汇总（变化时推）：Windows 悬浮窗底栏据此显示「飞书 N 个群异常」。
   * 只列有群在异常的来源；全好时 items 为空
   */
  | { t: "source_health"; items: Array<{ source: "wechat" | "feishu" | "qq"; failing: number; error: string | null }> }
  /** 设置变更（Swift 只关心 panel 尺寸） */
  | { t: "settings"; settings: Settings }
  /** fomo.family 登录态（启动与变化时推）：只给信号半边（关注者 / Thesis / 前排）用，与交易无关 */
  | { t: "fomo_state"; loggedIn: boolean }
  /**
   * 群来源就绪态（dashboard 起来后推一次，之后在 configured 变化时推）：configured = 微信 / 飞书至少一个能读；
   * firstRun = 这台机器第一次跑（没弹过引导且一个群都没选）。Swift 在 firstRun 或 configured=false 时自动打开
   * dashboard「群组」页，一进程只弹一次；详情（各来源的前置条件 / 登录进度）走 /api/sources
   */
  | { t: "sources"; configured: boolean; firstRun: boolean; wechat: { ready: boolean }; feishu: { ready: boolean }; qq: { ready: boolean } }
  | TradeStateEvent
  | TradeQuoteEvent
  | TradeEvent
  /** burner 钱包当前持仓（账本里 confirmed 过的币 + 焦点币的链上余额；余额变化 / 成交后推）；at = 快照 unix 秒 */
  | { t: "trade_holdings"; at: number; holdings: TradeHolding[] }
  | FomoThesisEvent
  | GmgnCallsEvent
  /** 让 Swift 在对应站点的页面上下文里代发请求 */
  | { t: "rpc"; id: number; method: RpcMethod; params: unknown };

export type RpcMethod = "gmgn.fetch" | "fomo.token" | "fomo.me";

/** fomo.token：从常驻 fomo.family 的 WKWebView 里取当前 Privy access token；refresh=true 让 Swift 重载页面（限频）促使 Privy SDK 换新 */
export interface FomoTokenParams {
  refresh: boolean;
}
export interface FomoTokenResult {
  token: string | null;
}
/** fomo.me：页面自己 `POST /v2/users` 的响应（用户脚本截获），没登录 → null */
export type FomoMeResult = { userId: string; handle: string; following: number | null } | null;

export interface GmgnFetchParams {
  path: string; // 以 /api/... 开头；query string 由 Swift 拼页面自己的 device_id 参数
  method: "GET" | "POST";
  body?: unknown;
}

export interface GmgnFetchResult {
  status: number;
  body: string;
}

// ---------- stdin 事件（Swift → sidecar） ----------

export type InEvent =
  | { t: "rpc_result"; id: number; ok: true; result: unknown }
  | { t: "rpc_result"; id: number; ok: false; error: string }
  /**
   * 弹卡开/关：sidecar 据此订阅/退订该代币的 gmgn 实时成交、刷新推文 / GMGN喊单 / fomo 列。
   * `chain` = Swift 已知的链（追踪列表里的币 = 其 market.chain；「当前持仓」行 = 持仓行的链）；不在追踪列表里的持仓靠它才能走 gmgn 路由（同一 0x 地址在别的链上是别的币）。关闭 → address=null
   */
  | { t: "focus"; address: string | null; chain?: string | null }
  /** 主面板当前显示（LazyVStack 已出现 / 预取）的代币行全集（替换语义；面板折叠 → `[]`；sidecar 重连后 Swift 重发）：这些行也要有「fomo 前排比例」 */
  | { t: "front_rank_visible"; addresses: string[] }
  /** 点了 K 线上某个喊单标记：要这一次喊单的语境 */
  | { t: "context"; address: string; sender: string; ts: number; group: string }
  /** 弹卡 K 线请求：分辨率来自弹卡按钮，时间窗来自可见范围；chain 同 focus（持仓行必带） */
  | { t: "kline"; address: string; resolution: string; from: number; to: number; chain?: string | null }
  /** 弹卡「fomo Thesis」列：翻下一页（有 hasNext 时） */
  | { t: "fomo_thesis_more"; address: string }
  /** 弹卡「GMGN 喊单」列：翻下一页（has_more 时） */
  | { t: "gmgn_calls_more"; address: string }
  /** 弹卡交易卡：要一份只读报价（一次性，无刷新）；address=null 取消在飞的。buy 给 amount（原生币数量）；sell 给 pct（1–100，按持仓比例） */
  | { t: "trade_quote"; address: string | null; chain?: string; side?: "buy" | "sell"; amount?: number; pct?: number }
  /** 弹卡交易卡：owner 点了执行 → 不可变交易意图；quoteId 必须是该地址/方向最新的一份。amount / pct 必须与那份报价一致（sell 时 amount 传 0） */
  | { t: "trade"; address: string; chain: string; side: "buy" | "sell"; amount: number; pct?: number | null; quoteId: string }
  /**
   * 持仓行「闪电」一键交易：Swift 每次点击生成一个 UUID `id`，sidecar 用它作为交易记录 id（先同步落 validating 回执，再取路由并执行）。
   * buy：amount = 原生币数量、pct 省略；sell：pct = 预设整数比例、amount 传 0（估值由 sidecar 按持仓算）。同 id 重放 / 该地址有在飞或未对账的记录 → 不新建，只回放当前记录
   */
  | { t: "trade_quick"; id: string; address: string; chain: string; side: "buy" | "sell"; amount: number; pct?: number | null }
  /** swap 卡 / 充值弹窗「生成热钱包」：还没有 burner 时生成一把 EVM + 一把 Solana（私钥进 Keychain），成功 / 失败都回一条 `trade_state`；已有钱包 → 只重推状态，绝不覆盖 */
  | { t: "wallet_init" }
  /** 调试：模拟一条喊单 */
  | { t: "simulate" };
