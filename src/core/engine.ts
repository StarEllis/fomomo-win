import { Chain, Dex } from "./dex.js";
import { Erc20, type Erc20Verdict } from "./erc20.js";
import { FomoService } from "./fomo.js";
import type { HoneypotCheck } from "./honeypot.js";
import { GMGN_BATCH, GmgnError, RESOLUTION_SEC, candles, communityMessages, fullInfo, linkPreview, tokenInfo, topHolders, tweets, userProfile, type Candle, type GmgnCallsPage } from "./gmgn.js";
import { GmgnWs, type Trade } from "./gmgnws.js";
import type { Bridge } from "./rpc.js";
import type { Store } from "./store.js";
import { translateTweet } from "./translate.js";
import { DEFAULT_SETTINGS, type FomoView, type GmgnCall, type GmgnCallsEvent, type Market, type Mention, type OutEvent, type TokenState, type TokenView, type TradePosition, type Tweet, type TwitterRequest } from "./types.js";
import { TradeService, type TradeDeps } from "./trade.js";
import { fetchTweet, parseTwitterLink } from "./twitter.js";
import { CONTEXT_AFTER, CONTEXT_BEFORE, type ContextRow, type GroupMsg, type MonitorEvent } from "./messages.js";
import { isSolanaAddress } from "../wechat/extract.js";

const MAX_TOKENS = 80;
/** 内存里每个代币最多保留的采样点。超出时按时间均匀抽稀（不是砍最旧的）：K 线要覆盖"自喊单起"的整个跨度 */
const MAX_HISTORY = 720;
/** 消息时间距现在不超过这个数就算 live 喊单：用现价当喊单价 */
const LIVE_WINDOW = 180;
const REFRESH_EVERY_MS = 20_000;
/** WS 成交 tick 拨了现价后最多多久推一次 state（fomo 前端持仓值约 2s 一跳） */
const LIVE_PRICE_PUSH_MS = 1000;
/** 同一代币两次拉蜡烛的最小间隔（没数据的新币别每 20s 打一次） */
const CANDLE_RETRY_MS = 5 * 60_000;
/** 蜡烛离喊单时刻最多差多少秒还算"当时价" */
const CANDLE_TOLERANCE = 600;
const REFRESH_TOP = 40;
/** 链未知（DexScreener 还没收录的新币）时依次试群里常见的链 */
const GUESS_CHAINS = ["robinhood", "bsc"];
/** 行情源都查不到的 0x 地址：链上 ERC20 探测（erc20.ts）的确定结论缓存多久；unknown（节点抽风 / 限流）多久后重试 */
export const ERC20_TTL = 10 * 60;
const ERC20_UNKNOWN_TTL = 60;
/** 同时在飞的 ERC20 探测数（每个探测只读最多五条链） */
const ERC20_CONCURRENCY = 3;
/** 貔貅探测（honeypot.ts）多久复查：貔貅留 24h（GoPlus 可能纠错）、正常 6h（项目方可以事后改税）、unknown 10min */
const HONEYPOT_TTL = { honeypot: 24 * 3600, ok: 6 * 3600, unknown: 10 * 60 } as const;
const HONEYPOT_CONCURRENCY = 2;

/** gmgn 链 slug → fomo.family 路由段（fomo 前端 `chains-v2` 的 chainId→slug 表：solana/base/monad/bnb/ethereum/robinhood）。
 *  Solana mint 区分大小写，地址全程按原样保留（Engine.norm 只对 0x 小写） */
const FOMO_CHAINS: Record<string, string> = { base: "base", bsc: "bnb", eth: "ethereum", robinhood: "robinhood", sol: "solana" };

function fomoURL(chain: string | null, address: string): string | null {
  const slug = chain ? FOMO_CHAINS[chain] : undefined;
  return slug ? `https://fomo.family/tokens/${slug}/${address}` : null;
}

const now = () => Math.floor(Date.now() / 1000);

function merged(old: Market | null, n: Market): Market {
  if (!old) return n;
  const m: Market = { ...old };
  if (n.symbol) m.symbol = n.symbol;
  if (n.name) m.name = n.name;
  if (n.logo) m.logo = n.logo;
  if (n.chain !== undefined) m.chain = n.chain;
  if (n.price !== undefined) m.price = n.price;
  if (n.mc !== undefined) m.mc = n.mc;
  if (n.liq !== undefined) m.liq = n.liq;
  if (n.change5m !== undefined) m.change5m = n.change5m;
  if (n.change1h !== undefined) m.change1h = n.change1h;
  if (n.change24h !== undefined) m.change24h = n.change24h;
  if (n.holders !== undefined) m.holders = n.holders;
  if (n.priceAgo && Object.keys(n.priceAgo).length > 0) m.priceAgo = n.priceAgo;
  m.source = n.source;
  m.updatedAt = n.updatedAt;
  return m;
}

/** 等间隔抽 n 个点（首尾保留） */
export function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * (xs.length - 1)) / (n - 1))]);
  return out;
}

function toView(t: TokenState, fomo: FomoView | null, position: TradePosition | null, twitterRequest: TwitterRequest | null): TokenView {
  // 序列优先用 mc：新币刚收录时 DexScreener/gmgn 的 price 常因 decimals 抖一个数量级，mc 不抖
  const useMc = t.history.length > 0 && t.history.every((s) => s.mc !== undefined && s.mc > 0);
  const series = t.history.map((s) => (useMc ? s.mc! : s.price));
  const pts = thin(series, 48);
  let spark: number[];
  if (pts.length >= 2) {
    const lo = Math.min(...pts);
    const hi = Math.max(...pts);
    const span = Math.max(hi - lo, hi * 0.002, 1e-18);
    spark = pts.map((p) => 0.1 + (0.8 * (p - lo)) / span);
  } else {
    spark = new Array(12).fill(0.5);
  }
  const base = t.mentions.find((m) => m.price !== undefined);
  const price = t.market?.price;
  const mc = t.market?.mc;
  let change: number | null = null;
  if (base?.mc && mc !== undefined && mc > 0) change = (mc / base.mc - 1) * 100;
  else if (base?.price && price !== undefined) change = (price / base.price - 1) * 100;
  const first = series[0];
  const last = series[series.length - 1];
  const trend: 1 | -1 = series.length >= 2 && first !== last ? (last > first ? 1 : -1) : (change ?? 0) >= 0 ? 1 : -1;
  let market: TokenView["market"] = null;
  if (t.market) {
    const { priceAgo: _drop, ...rest } = t.market;
    market = rest;
  }
  return {
    address: t.address,
    chainHint: t.chainHint,
    market,
    mentions: t.mentions,
    spark,
    live: t.history.length >= 2,
    trend,
    change,
    changeApprox: base?.approx ?? false,
    kol: new Set(t.mentions.map((m) => m.sender)).size,
    firstSeen: t.mentions[0]?.time ?? 0,
    links: t.links,
    ath: t.ath,
    profile: t.profile,
    official: t.official.slice(0, 3),
    twitterRequest: twitterRequest ?? {
      status: !t.links ? (!t.market?.chain ? "waiting_chain" : "idle") : !t.links.twitter ? "no_link" : !parseTwitterLink(t.links.twitter) ? "unsupported" : t.profile || t.official.length ? "ready" : !t.market?.chain ? "waiting_chain" : "idle",
      error: null,
    },
    tweets: t.tweets.slice(0, 3),
    fomoURL: fomoURL(t.market?.chain ?? t.chainHint, t.address),
    fomo,
    position,
  };
}

/**
 * 全部业务逻辑：喊单入库、行情编排（DexScreener 定链 → gmgn 覆盖 → 周期刷新）、
 * 喊单价基准、K 线采样、落盘、向 Swift 推展示快照。Swift 只渲染。
 */
export class Engine {
  private tokens: TokenState[] = [];
  private index = new Map<string, number>();
  private pending = new Map<string, string | null>(); // 新地址 -> chainHint
  /** 首轮 Dex/GMGN 均已结束的对象：其它批次或周期刷新不能抢在它自己的行情查询前判非代币。 */
  private marketTried = new WeakSet<TokenState>();
  private flushTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  /** gmgn 实时成交流：只订 focus 中的代币，用来推 K 线最后一根 */
  private readonly ws = new GmgnWs();
  /** fomo.family 关注者动向（登录桥在 Swift；REST/WS 在 fomo.ts）——只做信号 */
  private readonly fomo: FomoService;
  /** 一键买卖：burner 钱包 + OKX（trade.ts）；测试不给 tradeDeps 就不装 */
  readonly trade: TradeService | null;
  /** 成交流统计：每 60s 一行 / 推送的分辨率集合变了立刻一行，用来在日志里确认实时推送活着 */
  private tradeCount = 0;
  private tradeLogAt = 0;
  private tradePushed = "";
  /** 每币最近一笔已采用的 WS 成交时间（秒）：更早的迟到成交不把现价往回滚 */
  private liveAt = new WeakMap<TokenState, number>();
  private chainMismatchLogged = false;
  /** WS 成交 tick 推 state 的节流（每笔 print 都推全量 state 太贵；fomo 前端也是 ~2s 一跳） */
  private liveStateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly bridge: Bridge,
    /** 只给测试指到本机假 fomo 服务；默认 prod（见 FomoService deps） */
    fomoEndpoints: { apiBase?: string; wsUrl?: string } = {},
    /** 交易模块的外部依赖（OKX 客户端工厂 / Keychain 钱包）；cli.ts 组装，测试可注入假实现或省略 */
    tradeDeps: Pick<TradeDeps, "okx" | "wallet" | "createWallet" | "nativePrices" | "now" | "timing"> | null = null,
    /** 貔貅探测（cli.ts 传 Honeypot.check）；null = 不探测（测试默认不打外网） */
    private readonly honeypotCheck: HoneypotCheck | null = null,
  ) {
    this.ws.onTrade = (tr) => this.onTrade(tr);
    this.fomo = new FomoService(store, bridge, {
      tracked: () => this.tokens.map((t) => ({ address: t.address, chain: t.market?.chain ?? t.chainHint })),
      focused: () => (this.focused ? { address: this.focused.address, chain: this.focused.market?.chain ?? this.focused.chainHint } : null),
      symbolOf: (a) => this.lookup(a, null)?.market?.symbol ?? null,
      gmgnTopHolders: (a, chain) => topHolders(bridge, chain, a),
      ...fomoEndpoints,
    });
    this.fomo.onChange = () => this.scheduleState();
    this.trade = tradeDeps
      ? new TradeService({
          store,
          bridge,
          settings: () => store.getSettings().trade,
          // 持仓估值用的现价：链要对上（同一 0x 地址在别的链上可能是别的币），有限正数才算有
          priceOf: (a, chain) => {
            const t = this.lookup(a, chain);
            const p = t?.market?.price;
            return t && (t.market?.chain ?? t.chainHint) === chain && p !== undefined && Number.isFinite(p) && p > 0 ? p : null;
          },
          meta: (a, chain) => {
            const m = this.lookup(a, chain)?.market;
            return m ? { symbol: m.symbol ?? null, name: m.name ?? null, logo: m.logo ?? null } : null;
          },
          ...tradeDeps,
        })
      : null;
    if (this.trade) this.trade.onChange = () => this.scheduleState();
  }

  /** 从库里恢复上次的面板，并开始周期刷新 */
  start(): void {
    this.tokens = this.store.loadTokens(MAX_TOKENS, MAX_HISTORY);
    this.reindex();
    for (const c of this.store.loadContexts()) {
      if (this.index.has(c.address)) this.contexts.set(Engine.ctxKey(c.address, c.sender, c.ts, c.grp), { ev: { t: "context", address: c.address, sender: c.sender, ts: c.ts, group: c.grp, lines: c.lines, call: c.call }, at: c.at, after: c.after });
    }
    console.error(`[engine] restored ${this.tokens.length} tokens, ${this.contexts.size} contexts from ${this.store.path}`);
    this.scheduleState();
    // 恢复的代币里没定链/没行情的也要拉；有链的把近似喊单价用蜡烛做准
    for (const t of this.tokens) {
      if (!t.market) this.enqueue(t.address, t.chainHint);
      else {
        void this.priceFromCandles(t);
        if (!t.links) void this.fetchSocials(t);
        else if ((t.official.length === 0 || !t.profile) && t.links.twitter && t.tweetsAt) void this.refreshOfficial(t).then(() => { this.store.upsertToken(t); this.scheduleState(); });
      }
    }
    this.probeHoneypots();
    this.refreshTimer = setInterval(() => void this.refreshAll(), REFRESH_EVERY_MS);
    this.fomo.start();
    void this.trade?.start();
  }

  private refreshTimer: NodeJS.Timeout | undefined;

  /** 停掉全部周期任务 / WS / fomo（生产里进程直接退出；测试用它收尾） */
  close(): void {
    this.closed = true;
    this.erc20Queue = [];
    this.honeypotQueue = [];
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    clearTimeout(this.flushTimer ?? undefined);
    this.flushTimer = null;
    clearTimeout(this.stateTimer ?? undefined);
    this.stateTimer = null;
    clearTimeout(this.liveStateTimer ?? undefined);
    this.liveStateTimer = null;
    this.ws.close();
    this.fomo.close();
    this.trade?.close();
  }

  private closed = false;

  /**
   * 当前展示快照（`state` 与 dashboard 的 /api/tokens 共用）：只有追踪列表，焦点持仓不在内。
   * 行情源都查不到、且链上确认不是 ERC20（结论未过期）的不展示——记录与索引都保留，之后行情收录了照常显示
   */
  views(): TokenView[] {
    return this.tokens.filter((t) => !this.hidden(t)).map((t) => this.view(t));
  }

  private hidden(t: TokenState): boolean {
    if (t.honeypotCheck?.verdict === "honeypot") return true;
    const c = t.erc20Check;
    return t.market === null && c?.verdict === "non-erc20" && now() >= c.checkedAt && now() - c.checkedAt < ERC20_TTL;
  }

  private view(t: TokenState): TokenView {
    const chain = t.market?.chain ?? t.chainHint;
    const v = toView(t, this.fomo.view(t.address, chain), this.trade?.positionOf(t.address, chain) ?? null, this.twitterRequests.get(t) ?? null);
    if (!this.isTracked(t)) v.holdingOnly = true;
    return v;
  }

  private reindex(): void {
    this.index = new Map(this.tokens.map((t, i) => [t.address, i]));
  }

  // ---------- 追踪列表 vs 焦点持仓 ----------

  /**
   * 不在追踪列表里的「当前持仓」弹卡：按 `chain:address` 键的临时 TokenState（没有 mentions、不落库、不进 `state`），走和追踪代币完全相同的行情 / K 线 / 社交 / GMGN喊单 / fomo 管线，
   * 只对当前 focus 的那份推 `token_detail`。最多留 MAX_HOLDINGS 份（关卡再开不重拉），最旧的淘汰
   */
  private holdings = new Map<string, TokenState>();
  static readonly MAX_HOLDINGS = 8;

  /** EVM 地址小写归一；Solana base58 mint 区分大小写，原样 */
  private static norm(address: string): string {
    return address.startsWith("0x") ? address.toLowerCase() : address;
  }

  private static holdingKey(address: string, chain: string): string {
    return `${chain}:${Engine.norm(address)}`;
  }

  /** 追踪列表里的（对象同一性：临时持仓永远不在 tokens 里） */
  private isTracked(t: TokenState): boolean {
    return this.tokens[this.index.get(t.address) ?? -1] === t;
  }

  /** 能打 gmgn 的链：追踪代币要行情确认过的链（chainHint 只是群里的猜测）；焦点持仓的链是持仓行给的，直接可用 */
  private route(t: TokenState): string | null {
    return t.market?.chain ?? (this.isTracked(t) ? null : t.chainHint);
  }

  /**
   * address(+链) → 状态。没给链的详情操作先认当前焦点；给链时只匹配对应链，避免同地址的监听币抢走持仓分页。
   * 追踪币的行情链尚未确认时仍可接行情解析结果；临时持仓始终由明确链定位。
   */
  private lookup(address: string, chain: string | null): TokenState | undefined {
    const f = this.focused;
    if (!chain && f?.address === Engine.norm(address)) return f;
    const t = this.tokens[this.index.get(Engine.norm(address)) ?? -1];
    if (t && (!chain || !t.market?.chain || t.market.chain === chain)) return t;
    if (chain) return this.holdings.get(Engine.holdingKey(address, chain));
    return undefined;
  }

  /** 取 / 建某链上的焦点持仓状态（复用已有对象：已加载的行情 / 社交 / K 线缓存不丢） */
  private holding(address: string, chain: string | null): TokenState {
    const key = Engine.holdingKey(address, chain ?? "?");
    let t = this.holdings.get(key);
    if (t) this.holdings.delete(key); // 重新插到末尾 = 最近用过
    else {
      // 追踪列表只留最近 MAX_TOKENS 个：更早被喊过的（dashboard 点开）从库里带上喊单 / 采样 / 社交，链对得上才用
      const stored = this.store.loadToken(Engine.norm(address), MAX_HISTORY);
      t = stored && (!chain || (stored.market?.chain ?? stored.chainHint) === chain)
        ? { ...stored, chainHint: chain ?? stored.market?.chain ?? stored.chainHint }
        : { address: Engine.norm(address), chainHint: chain, market: null, mentions: [], history: [], links: null, ath: null, profile: null, official: [], tweets: [], tweetsAt: 0 };
    }
    this.holdings.set(key, t);
    for (const k of this.holdings.keys()) {
      if (this.holdings.size <= Engine.MAX_HOLDINGS) break;
      this.holdings.delete(k);
    }
    return t;
  }

  /** 只有追踪列表里的代币落库；焦点持仓的一切都留在内存 */
  private save(t: TokenState): void {
    if (this.isTracked(t)) this.store.upsertToken(t);
  }

  /** gmgn / Dex 批量结果按小写地址归一；按请求时的写法（Solana mint 区分大小写）回填。返回成功 apply 的地址 */
  private applyBatch(ms: Map<string, Market>, requested: string[]): Set<string> {
    const want = new Map(requested.map((a) => [a.toLowerCase(), a]));
    const done = new Set<string>();
    for (const [a, m] of ms) {
      const addr = want.get(a) ?? a;
      this.apply(addr, m);
      done.add(addr);
    }
    return done;
  }

  // ---------- 喊单 ----------

  ingest(e: GroupMsg): void {
    for (const a of e.addrs) {
      const address = Engine.norm(a);
      this.ingestOne(
        address,
        { sender: e.sender || "?", time: e.time, text: e.text, group: e.group, approx: false },
        // Solana 地址（base58）本身就说明链；群消息里的链提示只对 EVM 地址有意义
        isSolanaAddress(address) ? "sol" : e.chainHint,
        e.backfill,
      );
    }
  }

  private ingestOne(address: string, mention: Mention, chainHint: string | null, backfill: boolean): void {
    const i = this.index.get(address);
    if (i !== undefined) {
      const t = this.tokens[i];
      // 老代币再被喊：只记 mention（KOL 数会变），不弹不挪位
      if (!t.mentions.some((m) => m.sender === mention.sender && m.time === mention.time && m.group === mention.group)) {
        t.mentions.push(mention);
        t.mentions.sort((x, y) => x.time - y.time);
        this.fillMentionPrices(t);
        this.store.insertCall(address, mention);
        if (mention.price !== undefined) this.store.updateCallPrice(address, mention);
        if (!mention.group.startsWith("feishu:")) setTimeout(() => this.loadContext(t, mention, false), backfill ? 0 : 15_000);
      }
      if (t.chainHint === null && chainHint) {
        t.chainHint = chainHint;
        // 群里第一次给出链：之前按无提示扫出的 ERC20 结论作废（隐藏的先回来），按新提示重新查行情 → 再探测
        if (!t.market) {
          if (t.erc20Check) {
            delete t.erc20Check;
            this.store.upsertToken(t);
          }
          this.enqueue(address, chainHint);
        }
      }
      this.scheduleState();
      return;
    }
    const t: TokenState = { address, chainHint, market: null, mentions: [mention], history: [], links: null, ath: null, profile: null, official: [], tweets: [], tweetsAt: 0 };
    if (backfill) {
      // 回灌按时间插入（分片间不保证全局有序），不弹
      const at = this.tokens.findIndex((x) => (x.mentions[0]?.time ?? 0) < mention.time);
      this.tokens.splice(at === -1 ? this.tokens.length : at, 0, t);
    } else {
      this.tokens.unshift(t);
    }
    if (this.tokens.length > MAX_TOKENS) this.tokens.length = MAX_TOKENS;
    this.reindex();
    this.store.upsertToken(t);
    this.store.insertCall(address, mention);
    this.scheduleState();
    if (!backfill) this.emitAfterState({ t: "new_token", address });
    this.enqueue(address, chainHint);
    this.fomo.adopt(address);
    // 微信本地语境预取；飞书由监控消息窗口主动保存，不额外批量发网络请求。
    if (!mention.group.startsWith("feishu:")) setTimeout(() => this.loadContext(t, mention, false), backfill ? 0 : 15_000);
  }

  /** 调试：塞一条假喊单走完整的新代币路径（地址是群里真出现过的） */
  simulate(): void {
    const pool = ["0x5686d17ad04e48cead159214d03113bfa69a9bd2", "0xc32b91fe216af1b834db02f33326e983ad8cf201", "0x000b2164a76560323163343431db8be550f164b8"];
    const a = pool.find((x) => !this.index.has(x)) ?? pool[0];
    const i = this.index.get(a);
    if (i !== undefined) {
      this.tokens.splice(i, 1);
      this.reindex();
    }
    this.ingestOne(a, { sender: "调试", time: now(), text: a, group: DEFAULT_SETTINGS.groups[0], approx: false }, null, false);
  }

  // ---------- 行情 ----------

  /** 新地址先攒 500ms 再一起查：回灌时几十个地址一起到，别对 gmgn 打几十个单地址请求 */
  private enqueue(address: string, hint: string | null): void {
    const t = this.tokens[this.index.get(address) ?? -1];
    if (t) this.marketTried.delete(t);
    this.pending.set(address, hint);
    clearTimeout(this.flushTimer ?? undefined);
    this.flushTimer = setTimeout(() => void this.flushPending(), 500);
  }

  /**
   * 首次：DexScreener 定链+基线 与 gmgn（有 chainHint 的直查，没有的按 GUESS_CHAINS 猜）**并行**发出，谁先回谁先 apply（merged 补字段）。
   * 之前是 Dex 先、gmgn 后：本机 DexScreener 不可达时要等它超时才轮到 gmgn 猜链，链到达晚于自动弹卡关闭（6s），K 线永远来不及画。
   * gmgn 没拿到、但 Dex 定出了一条还没按它查过的链 → 再补一次 gmgn。
   */
  private async flushPending(): Promise<void> {
    const batch = new Map(this.pending);
    this.pending.clear();
    if (batch.size === 0) return;
    try {
      const byHint = new Map<string, string[]>();
      for (const [a, hint] of batch) byHint.set(hint ?? "?", [...(byHint.get(hint ?? "?") ?? []), a]);
      const dexChain = new Map<string, string>();
      const [sets] = await Promise.all([
        Promise.all([...byHint].map(([c, addrs]) => this.refreshGmgnGuessing(c, addrs))),
        Promise.all(
          [...batch.keys()].map(async (a) => {
            const t0 = Date.now();
            const m = await Dex.lookup(a);
            // 新币定链的证据：过系统代理正常 <1s；miss = 3s 超时或 Dex 未收录
            console.error(`[dex] ${m?.symbol ?? a.slice(0, 10)} ${m ? `chain=${m.chain}` : "miss"} ${Date.now() - t0}ms`);
            if (!m) return;
            this.apply(a, m);
            if (m.chain) dexChain.set(a, m.chain);
          }),
        ),
      ]);
      const got = new Set(sets.flatMap((s) => [...s]));
      const retry = new Map<string, string[]>();
      for (const [a, c] of dexChain) {
        const hint = batch.get(a);
        if (got.has(a) || (hint ? hint === c : GUESS_CHAINS.includes(c))) continue;
        retry.set(c, [...(retry.get(c) ?? []), a]);
      }
      for (const [c, addrs] of retry) await this.refreshGmgn(c, addrs);
    } finally {
      for (const [address, hint] of batch) {
        const t = this.tokens[this.index.get(address) ?? -1];
        if (t && t.chainHint === hint) this.marketTried.add(t);
      }
      this.probeUnresolved();
      this.probeHoneypots();
    }
  }

  private async refreshGmgnGuessing(chain: string, addresses: string[]): Promise<Set<string>> {
    if (chain !== "?") return this.refreshGmgn(chain, addresses);
    let left = addresses;
    const got = new Set<string>();
    for (const c of GUESS_CHAINS) {
      if (left.length === 0) break;
      const g = await this.refreshGmgn(c, left);
      for (const a of g) got.add(a);
      left = left.filter((a) => !g.has(a));
    }
    return got;
  }

  /** 一轮：前 REFRESH_TOP 个（+ 正开着的焦点持仓）按链分组 → gmgn 批量 → 没拿到的走 DexScreener 批量 */
  async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const groups = new Map<string, string[]>();
      const list = this.tokens.slice(0, REFRESH_TOP);
      if (this.focused && !this.isTracked(this.focused)) list.push(this.focused);
      for (const t of list) {
        const chain = t.market?.chain ?? t.chainHint ?? "?";
        groups.set(chain, [...(groups.get(chain) ?? []), t.address]);
      }
      for (const [chain, addrs] of groups) {
        const got = await this.refreshGmgnGuessing(chain, addrs);
        const rest = addrs.filter((a) => !got.has(a));
        if (chain === "?") {
          // 还没定链的：DexScreener 可能这会儿收录了，重查一遍（≤10 个/轮）
          await Promise.all(
            rest.slice(0, 10).map(async (a) => {
              const m = await Dex.lookup(a);
              if (m) this.apply(a, m);
            }),
          );
          continue;
        }
        for (let i = 0; i < rest.length; i += 30) {
          const slice = rest.slice(i, i + 30);
          this.applyBatch(await Dex.batch(Chain.toDex(chain), slice), slice);
        }
      }
    } finally {
      this.refreshing = false;
      this.probeUnresolved();
      this.probeHoneypots();
    }
  }

  // ---------- 行情源都查不到的地址：链上 ERC20 探测 ----------

  /** 排队中或在飞的（对象同一性：同一代币只一份请求） */
  private erc20Queued = new WeakSet<TokenState>();
  private erc20Queue: TokenState[] = [];
  private erc20Active = 0;

  /** 该代币需要（重新）探测：追踪中、行情仍空、没结论或结论过期（EVM 查 ERC20，Solana 查 SPL mint，见 erc20.ts） */
  private erc20Due(t: TokenState): boolean {
    if (t.market || !this.marketTried.has(t)) return false;
    const c = t.erc20Check;
    return !c || now() < c.checkedAt || now() - c.checkedAt >= (c.verdict === "unknown" ? ERC20_UNKNOWN_TTL : ERC20_TTL);
  }

  /**
   * 每轮行情（首查 / 周期刷新）之后：把**全部**追踪列表里（不止前 REFRESH_TOP）仍没行情的 0x 地址排进探测队列。
   * 行情源永远是权威——这里只负责把「确定不是代币」的隐藏掉；探测不发明行情，也不阻塞行情拉取
   */
  private probeUnresolved(): void {
    if (this.closed) return;
    for (const t of this.tokens) {
      if (this.erc20Queued.has(t) || !this.erc20Due(t)) continue;
      this.erc20Queued.add(t);
      this.erc20Queue.push(t);
    }
    this.pumpErc20();
  }

  private pumpErc20(): void {
    if (this.closed) return;
    while (this.erc20Active < ERC20_CONCURRENCY && this.erc20Queue.length > 0) {
      const t = this.erc20Queue.shift()!;
      if (!this.isTracked(t) || !this.erc20Due(t)) {
        this.erc20Queued.delete(t);
        continue;
      }
      this.erc20Active++;
      void this.probeErc20(t).finally(() => {
        this.erc20Active--;
        this.erc20Queued.delete(t);
        this.pumpErc20();
      });
    }
  }

  /** 结论落地：引擎已关 / 代币已不在列表（或被同地址的新对象替换）/ 行情已到 → 结果作废。只在「显示 → 隐藏」时发 token_hidden（跟在过滤后的 state 之后） */
  private async probeErc20(t: TokenState): Promise<void> {
    const hint = t.chainHint;
    let verdict: Erc20Verdict;
    try {
      verdict = await Erc20.check(t.address, hint);
    } catch (e) {
      console.error(`[erc20] ${t.address.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      verdict = "unknown";
    }
    // 在飞期间群里给了链提示：这份结论是按旧提示得出的，作废（重新排队由下一轮行情之后的 probeUnresolved 负责）
    if (t.chainHint !== hint) return;
    if (this.closed || !this.isTracked(t) || t.market) return;
    const wasHidden = this.hidden(t);
    t.erc20Check = { verdict, checkedAt: now() };
    this.store.upsertToken(t);
    const isHidden = this.hidden(t);
    if (isHidden !== wasHidden) console.error(`[erc20] ${t.address.slice(0, 10)} ${verdict} → ${isHidden ? "hidden" : "shown"}`);
    if (isHidden && !wasHidden) this.emitAfterState({ t: "token_hidden", address: t.address });
    else this.scheduleState(); // 过期的隐藏结论变为 unknown/erc20 时也要把行推回原生，不只更新 views()
  }

  // ---------- 貔貅探测（行情确认了链之后） ----------

  private honeypotQueued = new WeakSet<TokenState>();
  private honeypotQueue: TokenState[] = [];
  private honeypotActive = 0;

  private honeypotDue(t: TokenState): boolean {
    if (!this.honeypotCheck || !t.market?.chain) return false;
    const c = t.honeypotCheck;
    return !c || now() < c.checkedAt || now() - c.checkedAt >= HONEYPOT_TTL[c.verdict];
  }

  /** 每轮行情之后：追踪列表里链已确认、没结论或结论过期的排进队列 */
  private probeHoneypots(): void {
    if (this.closed) return;
    for (const t of this.tokens) {
      if (this.honeypotQueued.has(t) || !this.honeypotDue(t)) continue;
      this.honeypotQueued.add(t);
      this.honeypotQueue.push(t);
    }
    while (this.honeypotActive < HONEYPOT_CONCURRENCY && this.honeypotQueue.length > 0) {
      const t = this.honeypotQueue.shift()!;
      if (!this.isTracked(t) || !this.honeypotDue(t)) {
        this.honeypotQueued.delete(t);
        continue;
      }
      this.honeypotActive++;
      void this.probeHoneypot(t).finally(() => {
        this.honeypotActive--;
        this.honeypotQueued.delete(t);
        this.probeHoneypots();
      });
    }
  }

  /** 结论落地（引擎已关 / 代币已不在列表 → 作废）；只在「显示 → 隐藏」时发 token_hidden，收掉它的弹卡 */
  private async probeHoneypot(t: TokenState): Promise<void> {
    const chain = t.market!.chain!;
    const verdict = await this.honeypotCheck!(t.address, chain);
    if (this.closed || !this.isTracked(t) || t.market?.chain !== chain) return;
    const wasHidden = this.hidden(t);
    t.honeypotCheck = { verdict, checkedAt: now() };
    this.store.upsertToken(t);
    const isHidden = this.hidden(t);
    if (isHidden !== wasHidden) console.error(`[honeypot] ${t.market?.symbol ?? t.address.slice(0, 10)} ${chain} ${verdict} → ${isHidden ? "hidden" : "shown"}`);
    if (isHidden && !wasHidden) this.emitAfterState({ t: "token_hidden", address: t.address });
    else if (isHidden !== wasHidden) this.scheduleState();
  }

  /** 返回成功更新的地址集合 */
  private async refreshGmgn(chain: string, addresses: string[]): Promise<Set<string>> {
    const done = new Set<string>();
    for (let i = 0; i < addresses.length; i += GMGN_BATCH) {
      const slice = addresses.slice(i, i + GMGN_BATCH);
      try {
        for (const a of this.applyBatch(await tokenInfo(this.bridge, chain, slice), slice)) done.add(a);
      } catch (e) {
        const msg = e instanceof GmgnError ? `${e.message} status=${e.status}` : e instanceof Error ? e.message : String(e);
        console.error(`[gmgn] refresh failed chain=${chain} n=${addresses.length}: ${msg}`);
        break;
      }
    }
    return done;
  }

  /** 焦点持仓的行情：链已知，直接按链查 gmgn，没拿到再走 DexScreener 同链批量（和 refreshAll 一轮同样的两步，只针对这一个币） */
  private async refreshHolding(t: TokenState): Promise<void> {
    const chain = this.route(t);
    if (!chain) return;
    const got = await this.refreshGmgn(chain, [t.address]);
    if (got.has(t.address)) return;
    try {
      this.applyBatch(await Dex.batch(Chain.toDex(chain), [t.address]), [t.address]);
    } catch (e) {
      console.error(`[dex] ${t.address.slice(0, 10)} ${chain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 行情到达：按 `m.chain` 路由（追踪代币的链一旦确认，别的链上同地址的行情不再合进去——那是另一个币；只可能是某条链上的焦点持仓） */
  apply(address: string, m: Market): void {
    const t = this.lookup(address, m.chain ?? null);
    if (!t) return;
    const hadChain = !!this.route(t);
    t.market = merged(t.market, m);
    // 行情源认了它就是代币：链上探测的结论作废（隐藏的重新显示；落库时把列清空）
    delete t.erc20Check;
    // 第一次知道链：Swift 弹卡还开着且它的 kline 请求被挂起（链未知时到达）→ 按它要的范围拉并推回；否则静默预取最近 100 根 1m（不推给 Swift，弹卡一开默认分辨率就有图）
    if (!hadChain && t.market.chain) {
      const w = this.klineWaiting.get(t.address);
      this.klineWaiting.delete(t.address);
      if (w && this.focused === t) void this.kline(t.address, w.resolution, w.from, w.to, true, t.market.chain);
      else void this.kline(t.address, "1m", now() - Engine.CANDLE_PAGE * 60, now(), false, t.market.chain);
      if (this.focused === t) {
        this.ws.watch({ chain: t.market.chain, address: t.address });
        this.fomo.focusChanged(t.address, t.market.chain); // 链到了才知道 networkId：补拉一次「fomo 前排」+ Thesis 列
        this.trade?.focusChanged(t.address, t.market.chain); // 余额快循环按链打节点，链未知时没起来
        this.gmgnCallsFocused(t); // GMGN喊单 接口按链路由，链到了才能拉
        console.error(`[gmgn-ws] watch ${t.market.symbol ?? t.address.slice(0, 10)} chain=${t.market.chain} (late)`);
      } else if (this.visible.has(t.address)) this.fomo.visibleChanged([...this.visible]); // 主面板行的链迟到：重踢前排队列
    }
    if (m.price !== undefined && t.history[t.history.length - 1]?.price !== m.price) {
      const s = { time: now(), price: m.price, mc: t.market.mc };
      t.history.push(s);
      if (t.history.length > MAX_HISTORY) t.history = thin(t.history, MAX_HISTORY);
      if (this.isTracked(t)) this.store.insertSample(t.address, s, t.market.mc ?? null, t.market.liq ?? null);
    }
    this.fillMentionPrices(t);
    this.save(t);
    this.scheduleState();
    void this.priceFromCandles(t);
    void this.fetchSocials(t);
  }

  private candleTried = new WeakMap<TokenState, number>();
  private socialsTried = new WeakSet<TokenState>();
  private tweetsInflight = new WeakSet<TokenState>();
  /** 最近一次 tweets() 失败原因（成功清掉）；弹卡 X喊单 页签据此区分 加载中 / 失败 */
  private tweetsError = new WeakMap<TokenState, string>();
  private twitterRequests = new WeakMap<TokenState, TwitterRequest>();

  private setTwitterRequest(t: TokenState, status: TwitterRequest["status"], error: string | null = null): void {
    this.twitterRequests.set(t, { status, error });
    this.scheduleState();
  }

  private twitterError(stage: string, e: unknown): string {
    const detail = e instanceof Error ? e.message : String(e);
    return `${stage}: ${detail.replace(/\bhttp (\d{3})/i, "HTTP $1").replace("rpc timeout", "请求超时（rpc timeout）")}`;
  }
  /** 推文缓存有效期：弹卡打开（focus）时超过这个就重拉 */
  static readonly TWEETS_TTL = 120;

  /** 链定了之后拉一次社交链接/ATH + 一次推文（新代币弹卡里要立刻有推特内容） */
  private async fetchSocials(t: TokenState): Promise<void> {
    const chain = this.route(t);
    if (!chain || this.socialsTried.has(t)) return;
    this.socialsTried.add(t);
    if (!t.links) this.setTwitterRequest(t, "loading");
    try {
      const got = (await fullInfo(this.bridge, chain, [t.address])).get(t.address.toLowerCase());
      if (got) {
        t.links = Object.keys(got.links).length ? got.links : t.links;
        t.ath = got.ath ?? t.ath;
        this.save(t);
        this.scheduleState();
      }
    } catch (e) {
      console.error(`[socials] ${t.market?.symbol ?? t.address.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      this.socialsTried.delete(t); // 下轮 apply 再试
      if (!t.links) {
        this.setTwitterRequest(t, "error", this.twitterError("代币社交资料", e));
        return;
      }
    }
    if (t.tweetsAt === 0) await this.refreshTweets(t);
    else {
      await this.refreshOfficial(t);
      this.save(t);
    }
  }

  private async refreshTweets(t: TokenState): Promise<void> {
    if (this.tweetsInflight.has(t)) return;
    this.tweetsInflight.add(t);
    if (t.links?.twitter) this.setTwitterRequest(t, "loading");
    if (this.focused === t) this.emitGmgnCalls(t, this.gmgnCallsInflight.has(t));
    try {
      t.tweets = await tweets(this.bridge, t.address, Engine.TWEETS_LIMIT);
      t.tweetsAt = now();
      this.tweetsError.delete(t);
      await this.refreshOfficial(t);
      this.save(t);
      this.scheduleState();
      console.error(`[tweets] ${t.market?.symbol ?? t.address.slice(0, 10)} n=${t.tweets.length} official=${t.official.length}`);
    } catch (e) {
      this.tweetsError.set(t, e instanceof Error ? e.message : String(e));
      console.error(`[tweets] ${t.market?.symbol ?? t.address.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      if (t.links?.twitter) this.setTwitterRequest(t, "error", this.twitterError("X 搜索", e));
      else this.setTwitterRequest(t, "no_link");
    } finally {
      this.tweetsInflight.delete(t);
      if (this.focused === t) this.emitGmgnCalls(t, this.gmgnCallsInflight.has(t));
    }
  }

  /**
   * 官方推特内容 = gmgn 悬停 X 图标那张卡（都是 gmgn 自己的接口，不需要登录 X）：
   * - 账号资料：/api/v1/twitter/user_profile（头像、简介、粉丝/关注、注册时间、蓝标、位置）
   * - 链接是某条推文：/vas/api/v1/twitter/link_preview/{chain}/{token}/{tweet_id}（正文、图、metrics、被引用的原推）；
   *   每次都重拉（metrics 会变），失败退回上次落库的那条，再退到 X syndication
   * - 再补该账号本人提到该币的推文（gmgn 搜索结果里筛）
   * - 第一条（弹卡展示的那条）补中文译文（translate.ts；落库的译文直接沿用）
   */
  private async refreshOfficial(t: TokenState): Promise<void> {
    const link = t.links?.twitter ? parseTwitterLink(t.links.twitter) : null;
    const chain = this.route(t);
    if (!t.links?.twitter) { this.setTwitterRequest(t, "no_link"); return; }
    if (!link) { this.setTwitterRequest(t, "unsupported"); return; }
    if (!chain) { this.setTwitterRequest(t, "waiting_chain"); return; }
    this.setTwitterRequest(t, "loading");
    const label = t.market?.symbol ?? t.address.slice(0, 10);
    const errors: string[] = [];
    const failed = (stage: string, e: unknown) => {
      const error = this.twitterError(stage, e);
      errors.push(error);
      console.error(`[x] ${label} ${error}`);
    };
    let linked: Tweet | null = null;
    try {
      // 系统路由没有用户名，作者只能从推文本身取得。
      if (link.statusId) {
        const cached = t.official.find((x) => x.id === link.statusId) ?? null;
        try {
          linked = await linkPreview(this.bridge, chain, t.address, link.statusId);
        } catch (e) { failed("推文预览", e); }
        if (linked && cached) {
          linked.translation = cached.translation ?? null;
          if (linked.quoted && cached.quoted?.id === linked.quoted.id) linked.quoted.translation = cached.quoted.translation ?? null;
        }
        linked ??= cached;
        if (!linked) {
          try { linked = await fetchTweet(link.statusId); }
          catch (e) { failed("X 备用接口", e); }
        }
      }
      const screen = link.screen ?? linked?.user.screen;
      if (!screen) {
        t.profile = null;
        t.official = [];
        return;
      }
      const same = (s: string) => s.toLowerCase() === screen.toLowerCase();
      try {
        const p = await userProfile(this.bridge, screen, chain, t.address);
        if (p) t.profile = p;
      } catch (e) { failed("账号资料", e); }
      const byAuthor = t.tweets.filter((x) => same(x.user.screen));
      if (!t.profile || !same(t.profile.screen)) {
        const rich = byAuthor[0]?.user ?? linked?.user;
        t.profile = rich && same(rich.screen) ? rich : null;
      }
      t.official = linked ? [linked, ...byAuthor.filter((x) => x.id !== link.statusId)] : byAuthor;
      if (t.official[0]) await translateTweet(t.official[0]);
    } catch (e) {
      failed("官方推特", e);
    } finally {
      // 请求失败与缓存是否可展示独立；不能让缓存掩盖本次 HTTP 错误。
      this.setTwitterRequest(t, errors.length ? "error" : (link.statusId ? linked !== null : t.profile !== null) ? "ready" : "empty", errors.length ? errors.join("；") : null);
    }
  }

  /** K 线缓存（进程内，不落库）：`${chain}:${address}:${resolution}` → 按时间升序、去重的**市值**蜡烛（gmgn `token_mcap_candles`）。平移/切分辨率不重拉，WS 逐笔推末根靠它 */
  private klines = new Map<string, Candle[]>();
  /** 每个 key 已拉取过的连续时间范围 */
  private klineCov = new Map<string, [number, number]>();
  private klineInflight = new Set<string>();
  private klinePending = new Map<string, { from: number; to: number }>();
  /** 当前弹卡的币（Swift focus；追踪代币或焦点持仓，按对象同一性比较），apply 补 K 线/补订阅时用来守卫：别把用户正在看的另一张卡的缓存冲掉 */
  private focused: TokenState | null = null;
  /** 主面板当前显示的行（Swift `front_rank_visible` 全集，小写地址）：这些行也要有「fomo 前排比例」；apply() 链迟到时用来补踢 */
  private visible = new Set<string>();
  /** 链未知时到达的 Swift K 线请求（按地址只留最新；只有追踪代币会链未知）：apply() 第一次知道链时补跑。Swift Coordinator.last 去重不会重发，丢了就永远「加载 K 线…」 */
  private klineWaiting = new Map<string, { resolution: string; from: number; to: number }>();
  /** gmgn 单次最多 ~100 根 */
  static readonly CANDLE_PAGE = 100;
  static readonly CANDLE_MAX_PAGES = 8;

  /**
   * Swift 请求某分辨率下 [from, to] 的 K 线：按 100 根一页从 to 往前翻，直到覆盖 from 或翻满，合并进缓存后整段推回。
   * 缓存只增不删，Swift 拿到的是该分辨率下已知的全部蜡烛。
   * 拉的是**市值**蜡烛（不是价格）：新币 price 因 decimals 抖一个数量级时 MC 稳定；喊单定价（`priceFromCandles`）仍用价格蜡烛。
   * `chain` = Swift 那张卡的链（持仓行必带；追踪代币可省略，按已确认的链）。失败推带 `error` 的同事件（不假装覆盖），Swift 才不会永远「加载 K 线…」
   */
  async kline(address: string, resolution: string, from: number, to: number, emit = true, chain: string | null = null): Promise<void> {
    const t = this.lookup(address, chain);
    const step = RESOLUTION_SEC[resolution];
    if (!t || !step) {
      if (emit) this.bridge.emit({ t: "kline", address: Engine.norm(address), chain: chain ?? "", resolution, bars: [], covered: [to, to], calls: [], error: !t ? "未知代币（不在追踪列表，也不是打开的持仓）" : `不支持的分辨率 ${resolution}` });
      return;
    }
    const route = this.route(t);
    if (!route) {
      if (emit) this.klineWaiting.set(t.address, { resolution, from, to });
      return;
    }
    const key = `${route}:${t.address}:${resolution}`;
    if (this.klineInflight.has(key)) {
      // 在飞：记下最新诉求，完成后补跑一次（不能丢，否则 Swift 那边以为已请求过，这段永远空着）
      this.klinePending.set(key, { from, to });
      return;
    }
    this.klineInflight.add(key);
    const have = this.klines.get(key) ?? [];
    const cov = this.klineCov.get(key);
    const bars = (cs: Candle[]) => cs.map((c): [number, number, number, number, number, number] => [c.time, c.open, c.high, c.low, c.close, c.volume]);
    const calls = t.mentions.map((m): [number, string, string] => [m.time, m.sender, m.group]);
    try {
      // 已拉过的区间不重拉：只补 [from, covLo) 和 (covHi, to]（按拉取范围判断，不按首末根——1s 没成交就没蜡烛）
      const gaps: Array<[number, number]> = [];
      if (!cov) gaps.push([from, to]);
      else {
        if (from < cov[0] - step) gaps.push([from, cov[0]]);
        if (to > cov[1] + step) gaps.push([cov[1], to]);
      }
      // 页窗口按步长切死（每页 100 根），所有页**并行**发——之前是串行翻页，8 页 = 8 个 RTT，弹卡开了要等一两秒
      const windows: Array<[number, number]> = [];
      for (const [gf, gt] of gaps) {
        for (let cursor = gt, page = 0; page < Engine.CANDLE_MAX_PAGES && cursor > gf; page++) {
          const pf = Math.max(gf, cursor - Engine.CANDLE_PAGE * step);
          windows.push([pf, cursor]);
          cursor = pf;
        }
      }
      const pages = await Promise.all(windows.map(([pf, pt]) => candles(this.bridge, route, t.address, pf, pt, resolution, "mcap")));
      const got = pages.flat();
      // 覆盖范围 = 请求过的全部窗口（没蜡烛的窗口 = 那会儿没成交/代币不存在，同样算覆盖）
      let reachedLo = cov?.[0] ?? Infinity, reachedHi = cov?.[1] ?? -Infinity;
      for (const [pf, pt] of windows) {
        reachedLo = Math.min(reachedLo, pf);
        reachedHi = Math.max(reachedHi, pt);
      }
      // 最早那页满了说明再往前可能还有，但已翻满页数：覆盖只能算到实际拿到的最早一根
      if (windows.length >= Engine.CANDLE_MAX_PAGES) {
        const oldest = pages[pages.length - 1];
        if (oldest.length >= Engine.CANDLE_PAGE - 2) reachedLo = Math.max(reachedLo, oldest[0].time);
      }
      const merged = new Map<number, Candle>();
      for (const c of have) merged.set(c.time, c);
      for (const c of got) merged.set(c.time, c);
      const all = [...merged.values()].sort((a, b) => a.time - b.time);
      this.klines.set(key, all);
      const covered: [number, number] = [Math.min(reachedLo, all[0]?.time ?? reachedLo), Math.max(reachedHi, (all[all.length - 1]?.time ?? 0) + step)];
      this.klineCov.set(key, covered);
      if (emit) this.bridge.emit({ t: "kline", address: t.address, chain: route, resolution, bars: bars(all), covered, calls, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[kline] ${t.market?.symbol ?? t.address.slice(0, 10)} ${route} ${resolution}: ${error}`);
      // 失败：不记覆盖（下次同范围重拉），推缓存里已有的 + error；没缓存就是空 + 零长度 covered
      if (emit) this.bridge.emit({ t: "kline", address: t.address, chain: route, resolution, bars: bars(have), covered: cov ?? [to, to], calls, error });
    } finally {
      this.klineInflight.delete(key);
      const p = this.klinePending.get(key);
      if (p) {
        this.klinePending.delete(key);
        void this.kline(address, resolution, p.from, p.to, true, route);
      }
    }
  }

  /**
   * gmgn 推来 focus 代币的一笔成交。两件事，互不依赖：
   * 1. 现价：`market.price` 拨到这笔成交（链要对上；比这一币已采用的最新成交更早的迟到成交不回滚），有 mc 的按供量不变同步 mc；≤1/s 推一次 state → 弹卡市值 / 持仓估值随成交走。
   * 2. K 线：把该代币每个已缓存分辨率的最后一根蜡烛推着走（同周期合并，新周期追加），每个改动的分辨率单独推一根给 Swift。只改"已拉取范围末端"之后的蜡烛，不动历史。
   *    WS 给的是 USD 单价，缓存里是市值蜡烛：按当前 mc/price 折成市值再合；没有可用的折算比就只跳过 K 线这一步。
   */
  private onTrade(tr: Trade): void {
    // WS 只订了焦点币：按 gmgn 给的链找（同地址别的链上是别的币）；gmgn 若把 Solana mint 折了大小写，就退回焦点币按大小写不敏感对
    const f = this.focused;
    const t = this.lookup(tr.address, tr.chain) ?? (f && f.address.toLowerCase() === tr.address.toLowerCase() ? f : undefined);
    if (!t?.market || !Number.isFinite(tr.price) || tr.price <= 0) return;
    if (t.market.chain !== tr.chain) {
      if (!this.chainMismatchLogged) {
        this.chainMismatchLogged = true;
        console.error(`[gmgn-ws] trade chain=${tr.chain} ≠ market chain=${t.market.chain ?? "?"} for ${t.market.symbol ?? t.address.slice(0, 10)}; ignoring mismatched prints (logged once)`);
      }
      return;
    }
    this.tradeCount++;
    // 供量 = mc / price（gmgn 快照），用来把单价折成市值；缺了不影响现价更新
    const supply = t.market.mc && t.market.price && t.market.mc > 0 && t.market.price > 0 ? t.market.mc / t.market.price : undefined;
    if (tr.time >= (this.liveAt.get(t) ?? 0)) {
      this.liveAt.set(t, tr.time);
      if (t.market.price !== tr.price) {
        t.market.price = tr.price;
        if (supply !== undefined) t.market.mc = tr.price * supply;
        t.market.updatedAt = now();
        this.liveStateTimer ??= setTimeout(() => {
          this.liveStateTimer = null;
          this.scheduleState();
        }, LIVE_PRICE_PUSH_MS);
      }
    }
    // 每 60s 一行，或者推送的分辨率集合变了（新缓存了某档 / 换了币）就立刻记一行：日志里能看出 kline_bar 正在推哪些档
    const pushed = `${t.address} ${Object.keys(RESOLUTION_SEC).filter((r) => this.klines.has(`${tr.chain}:${t.address}:${r}`)).join(",")}`;
    if (pushed !== this.tradePushed || now() - this.tradeLogAt >= 60) {
      this.tradePushed = pushed;
      this.tradeLogAt = now();
      console.error(`[gmgn-ws] trades=${this.tradeCount} ${t.market?.symbol ?? t.address.slice(0, 10)} kline_bar=${pushed.slice(pushed.indexOf(" ") + 1) || "-"}`);
    }
    if (supply === undefined) return;
    const mcap = tr.price * supply;
    for (const [res, step] of Object.entries(RESOLUTION_SEC)) {
      const key = `${tr.chain}:${t.address}:${res}`;
      const bars = this.klines.get(key);
      if (!bars) continue;
      const bt = Math.floor(tr.time / step) * step;
      const last = bars[bars.length - 1];
      let bar: Candle;
      if (last && last.time === bt) {
        last.high = Math.max(last.high, mcap);
        last.low = Math.min(last.low, mcap);
        last.close = mcap;
        last.volume += tr.volume;
        bar = last;
      } else if (!last || bt > last.time) {
        bar = { time: bt, open: last?.close ?? mcap, high: mcap, low: mcap, close: mcap, volume: tr.volume };
        bars.push(bar);
      } else continue; // 迟到的旧成交，历史蜡烛以 gmgn 为准
      const cov = this.klineCov.get(key);
      if (cov) cov[1] = Math.max(cov[1], bt + step);
      this.bridge.emit({ t: "kline_bar", address: t.address, chain: tr.chain, resolution: res, bar: [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume] });
    }
  }

  /** 来源读取器由 cli 注入；本地微信同步，飞书网络读取异步。 */
  readContext: ((group: string, ts: number, before: number, after: number) => ContextRow[] | Promise<ContextRow[]>) | null = null;

  /** 每次喊单的语境缓存，来源群参与身份，避免跨群同名同刻串线。 */
  private contexts = new Map<string, { ev: Extract<OutEvent, { t: "context" }>; at: number; after: number }>();
  private contextLoads = new Map<string, Promise<void>>();
  private requestedContext: string | null = null;
  private static ctxKey(address: string, sender: string, ts: number, group: string): string {
    return JSON.stringify([address, group, sender, ts]);
  }

  /** Only a CA hit can produce this event; ordinary recent messages never reach persistence. */
  ingestContext(e: Extract<MonitorEvent, { t: "context" }>): void {
    if (this.closed) return;
    for (const raw of e.msg.addrs) {
      const address = Engine.norm(raw);
      this.saveContext(address, { sender: e.msg.sender, time: e.msg.time, group: e.msg.group }, e.rows, e.call);
      const key = Engine.ctxKey(address, e.msg.sender, e.msg.time, e.msg.group);
      const cached = this.contexts.get(key);
      if (cached && this.requestedContext === key && this.focused?.address === address) this.bridge.emit(cached.ev);
    }
  }

  /** Merge partial windows so a late read cannot overwrite already captured neighbours. */
  private saveContext(address: string, m: Pick<Mention, "sender" | "time" | "group">, rows: ContextRow[], call: number): void {
    if (call < 0 || call >= rows.length) return;
    const key = Engine.ctxKey(address, m.sender, m.time, m.group);
    const previous = this.contexts.get(key);
    const lines = rows.map((r) => ({ time: r.createTime, sender: r.sender, text: r.text.slice(0, 200) }));
    const before = previous && previous.ev.call > call ? previous.ev.lines.slice(0, previous.ev.call) : lines.slice(0, call);
    const after = previous && previous.after > rows.length - call - 1 ? previous.ev.lines.slice(previous.ev.call + 1) : lines.slice(call + 1);
    const prefix = before.slice(-(CONTEXT_BEFORE - 1));
    const suffix = after.slice(0, CONTEXT_AFTER);
    const ev: Extract<OutEvent, { t: "context" }> = {
      t: "context", address, sender: m.sender, ts: m.time, group: m.group,
      lines: [...prefix, lines[call], ...suffix], call: prefix.length,
    };
    const at = now();
    this.contexts.set(key, { ev, at, after: suffix.length });
    this.store.saveContext({ address, sender: m.sender, ts: m.time, grp: m.group, lines: ev.lines, call: ev.call, after: suffix.length, at });
  }

  private loadContext(t: TokenState, m: Mention, emit: boolean): void {
    if (!this.readContext || this.closed) return;
    const key = Engine.ctxKey(t.address, m.sender, m.time, m.group);
    if (emit) this.requestedContext = key;
    let pending = this.contextLoads.get(key);
    if (!pending) {
      pending = (async () => {
        const result = this.readContext!(m.group, m.time, CONTEXT_BEFORE, CONTEXT_AFTER);
        const rows = Array.isArray(result) ? result : await result;
        if (this.closed) return;
        let call = rows.findIndex((r) => r.createTime === m.time && r.sender === m.sender);
        if (call < 0) call = rows.findIndex((r) => r.createTime === m.time);
        this.saveContext(t.address, m, rows, call);
      })().catch((e: unknown) => {
        if (!this.closed) console.error(`[context] ${t.market?.symbol ?? t.address.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      }).finally(() => this.contextLoads.delete(key));
      this.contextLoads.set(key, pending);
    }
    if (emit) void pending.then(() => {
      const cached = this.contexts.get(key);
      if (!this.closed && this.requestedContext === key && this.focused === t && cached) this.bridge.emit(cached.ev);
    });
  }

  /** 启动后预取缺少的微信语境；飞书恢复记录按需拉取，避免启动时并发扫全部历史。 */
  prefetchContexts(): void {
    let n = 0;
    for (const t of this.tokens) for (const m of t.mentions) if (!m.group.startsWith("feishu:") && !this.contexts.has(Engine.ctxKey(t.address, m.sender, m.time, m.group))) { this.loadContext(t, m, false); n++; }
    console.error(`[context] prefetched ${n} new, ${this.contexts.size} total`);
  }

  /** 推某次喊单的语境：缓存有就立刻推；"后 N 条"还没凑齐（喊单刚发生）且上次读已过 20s 就再读一次补齐 */
  private pushContext(t: TokenState, m: Mention): void {
    const key = Engine.ctxKey(t.address, m.sender, m.time, m.group);
    this.requestedContext = key;
    const c = this.contexts.get(key);
    if (c) {
      this.bridge.emit(c.ev);
      if (c.after >= CONTEXT_AFTER || now() - c.at < 20) return;
    }
    this.loadContext(t, m, true);
  }

  /** Swift 点了 K 线上的喊单标记 */
  context(address: string, sender: string, ts: number, group: string): void {
    const t = this.lookup(address, null);
    if (!t) return;
    const m = t.mentions.find((x) => x.time === ts && x.sender === sender && x.group === group);
    if (m) this.pushContext(t, m);
  }

  /** 弹卡交易卡要一次报价（address=null 让在飞的作废）。链默认取该币当前已知的链 */
  tradeQuote(e: { address: string | null; chain?: string; side?: "buy" | "sell"; amount?: number; pct?: number }): void {
    if (!e.address) return this.trade?.quote(e);
    this.trade?.quote({ ...e, chain: this.chainFor(e.address, e.chain) });
  }

  /** 弹卡主按钮：不可变意图 → TradeService.trade（校验 + 签名广播 + 生命周期） */
  tradeIntent(e: { address: string; chain: string; side: "buy" | "sell"; amount: number; pct?: number | null; quoteId: string }): void {
    this.trade?.trade({ ...e, chain: this.chainFor(e.address, e.chain) });
  }

  /** 持仓行「闪电」：UI 的 UUID 意图 → TradeService.quickTrade（同步回执 validating → 现算数量 → 同一条执行链路） */
  tradeQuick(e: { id: string; address: string; chain: string; side: "buy" | "sell"; amount: number; pct?: number | null }): void {
    this.trade?.quickTrade({ ...e, chain: this.chainFor(e.address, e.chain) });
  }

  /** swap 卡 / 充值弹窗「生成热钱包」→ TradeService.initWallet（没有才生成；结果以 trade_state 回） */
  walletInit(): void {
    void this.trade?.initWallet();
  }

  private chainFor(address: string, given: string | undefined): string {
    const t = this.lookup(address, given ?? null);
    return given || t?.market?.chain || t?.chainHint || "";
  }

  /**
   * Swift 打开/关闭了弹卡：记下 focus，订阅它的实时成交，推喊单语境；推文太旧就刷新（K 线由 Swift 按分辨率/可见范围另发 kline 请求；链未知时先只解除旧订阅，行情到达时 apply() 补订）；
   * fomo 补拉前排 / Thesis；交易模块读一次它的链上余额。
   * 不在追踪列表里的地址（主面板「当前持仓」里未被喊过的币）按 Swift 给的 `chain` 建焦点持仓状态（见 `holding`），走同一套行情 / K 线 / 社交 / GMGN喊单 / fomo 管线，结果以 `token_detail` 推回。
   */
  focus(address: string | null, chain: string | null = null): void {
    if (!address) {
      this.focused = null;
      this.fomo.focusChanged(null);
      this.trade?.focusChanged(null, null);
      this.klineWaiting.clear();
      this.ws.watch(null);
      console.error("[gmgn-ws] unwatch");
      return;
    }
    const t = this.lookup(address, chain) ?? this.holding(address, chain);
    const tracked = this.isTracked(t);
    this.focused = t;
    const route = this.route(t);
    this.fomo.focusChanged(t.address, t.market?.chain ?? t.chainHint);
    this.trade?.focusChanged(t.address, t.market?.chain ?? t.chainHint);
    // 只留新 focus 的挂起项（Swift 的 kline 请求可能先于 focus 到）
    for (const k of this.klineWaiting.keys()) if (k !== t.address) this.klineWaiting.delete(k);
    this.ws.watch(route ? { chain: route, address: t.address } : null);
    console.error(`[gmgn-ws] ${route ? "watch" : "unwatch"} ${t.market?.symbol ?? t.address.slice(0, 10)} chain=${route ?? "?"}${tracked ? "" : " (holding)"}`);
    if (t.mentions[0]) this.pushContext(t, t.mentions[0]);
    // 焦点持仓不在 refreshAll 的名单里（除了正开着时）：每次打开都刷一遍行情，链到了 apply() 顺带拉社交
    if (!tracked && route) void this.refreshHolding(t);
    if (now() - t.tweetsAt >= Engine.TWEETS_TTL) void this.refreshTweets(t);
    this.gmgnCallsFocused(t);
    this.scheduleState(); // 焦点持仓：立刻推一份 token_detail（哪怕还是空壳）
  }

  // ---------- 弹卡「GMGN 喊单」列 ----------

  /** 代币 → 原生 GMGN喊单（community/messages）已翻到的全部页；进程内、不落库 */
  private gmgnCalls = new WeakMap<TokenState, { chain: string; items: GmgnCall[]; next: string | null; hasNext: boolean; at: number; error: string | null }>();
  private gmgnCallsInflight = new WeakSet<TokenState>();
  /** 快照超过这个时长，再 focus 时重拉首页（合并进已翻到的页） */
  static readonly GMGN_CALLS_TTL = 60;
  /** X喊单 页签 gmgn 自己请求 100 条 */
  static readonly TWEETS_LIMIT = 100;

  /** 弹卡打开 / 换币 / 链迟到：立刻推缓存（或 chain_unknown），过期再拉首页 */
  private gmgnCallsFocused(t: TokenState): void {
    const chain = this.route(t);
    if (!chain) {
      this.emitGmgnCalls(t, false);
      return;
    }
    const cur = this.gmgnCalls.get(t);
    if (cur && !cur.error && cur.chain === chain && now() - cur.at <= Engine.GMGN_CALLS_TTL) {
      this.emitGmgnCalls(t, false);
      return;
    }
    void this.fetchGmgnCalls(t, null);
  }

  /** Swift 点了「加载更多」：带 next_cursor 翻下一页（翻的是打开的那张卡 = 当前链）；服务端 has_more=false / 在飞 / 链未知就忽略 */
  gmgnCallsMore(address: string): void {
    const t = this.lookup(address, null);
    if (!t) return;
    const cur = this.gmgnCalls.get(t);
    if (!this.route(t) || !cur?.hasNext || !cur.next) return;
    void this.fetchGmgnCalls(t, cur.next);
  }

  /** 单飞；首页重拉 = 合并（按 ulid 去重、ts 降序），翻页 = 追加；失败保留旧条目只标 error */
  private async fetchGmgnCalls(t: TokenState, cursor: string | null): Promise<void> {
    const chain = this.route(t);
    if (!chain || this.gmgnCallsInflight.has(t)) return;
    this.gmgnCallsInflight.add(t);
    const prev = this.gmgnCalls.get(t);
    const base = prev && prev.chain === chain ? prev : { chain, items: [] as GmgnCall[], next: null, hasNext: false, at: 0, error: null };
    this.gmgnCalls.set(t, base);
    this.emitGmgnCalls(t, true);
    try {
      let page: GmgnCallsPage;
      try {
        page = await communityMessages(this.bridge, chain, t.address, cursor);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.gmgnCalls.set(t, { ...base, error });
        console.error(`[gmgn-calls] ${t.market?.symbol ?? t.address.slice(0, 10)}: ${error}`);
        return;
      }
      const byId = new Map<string, GmgnCall>();
      for (const c of base.items) byId.set(c.id, c);
      let overlap = 0;
      for (const c of page.items) {
        if (byId.has(c.id)) overlap++;
        byId.set(c.id, c);
      }
      const items = [...byId.values()].sort((a, b) => b.ts - a.ts);
      // 翻页 / 首次 / 与缓存零重叠且还有更多的首页重拉（TTL 内新增 >50 条，缓存和这页之间有洞，从这页游标继续翻才能补上，不能假装已取尽）→ 取这一页的游标与 has_more；
      // 有重叠的首页重拉（60s TTL）→ 沿用原来的游标与结论（翻到底后首页自带 has_more 不能再点亮「加载更多」）
      const adopt = cursor !== null || base.at === 0 || (overlap === 0 && page.hasMore);
      this.gmgnCalls.set(t, { chain, items, next: adopt ? page.next : base.next, hasNext: adopt ? page.hasMore : base.hasNext, at: now(), error: null });
    } finally {
      this.gmgnCallsInflight.delete(t);
      if (this.focused === t) this.emitGmgnCalls(t, false);
    }
  }

  private emitGmgnCalls(t: TokenState, loading: boolean): void {
    if (this.focused !== t) return;
    const chain = this.route(t);
    const cur = this.gmgnCalls.get(t);
    const ok = cur && cur.chain === chain ? cur : null;
    const ev: GmgnCallsEvent = {
      t: "gmgn_calls",
      address: t.address,
      chain,
      items: ok?.items ?? [],
      hasNext: ok?.hasNext ?? false,
      at: ok?.at ?? 0,
      error: chain ? (ok?.error ?? null) : "chain_unknown",
      loading,
      tweets: [...t.tweets].sort((a, b) => b.time - a.time),
      tweetsAt: t.tweetsAt,
      tweetsLoading: this.tweetsInflight.has(t),
      tweetsError: this.tweetsError.get(t) ?? null,
    };
    this.bridge.emit(ev);
  }

  /** Swift 点了 Thesis 列「加载更多」 */
  fomoThesisMore(address: string): void {
    this.fomo.thesisMore(address);
  }

  /** Swift 主面板显示行全集变了（LazyVStack 出现 / 折叠 → []）：交给 FomoService 的串行前排队列；焦点币仍走 focus() 的立即路径 */
  frontRankVisible(addresses: string[]): void {
    this.visible = new Set(addresses.map((a) => Engine.norm(a)));
    this.fomo.visibleChanged([...this.visible]);
  }

  /**
   * 用 gmgn 蜡烛做两件事（每代币最多 5 分钟一次）：
   * 1. 回灌喊单的"当时价"：按喊单时刻 ±30 分钟拉 1m 蜡烛（同一小时内的喊单合并一次请求），取所在分钟的 open。
   *    桶近似在拉盘币上能差两个数量级，这里必须分钟精度。
   * 2. 自首次喊单起的 K 线：单次最多约 100 根，按跨度选分辨率（≤95 根）用 close 补齐。
   */
  private async priceFromCandles(t: TokenState): Promise<void> {
    const chain = t.market?.chain;
    if (!chain) return;
    const ts = now();
    const targets = t.mentions.filter((c) => (c.price === undefined || c.approx) && ts - c.time > LIVE_WINDOW);
    const firstCall = t.mentions[0]?.time;
    const needSeed = firstCall !== undefined && (t.history.length === 0 || t.history[0].time - firstCall > 120);
    if (targets.length === 0 && !needSeed) return;
    const last = this.candleTried.get(t) ?? 0;
    if (Date.now() - last < CANDLE_RETRY_MS) return;
    this.candleTried.set(t, Date.now());
    const label = t.market?.symbol ?? t.address.slice(0, 10);
    const fetch = async (from: number, to: number, resolution: string) => {
      try {
        return await candles(this.bridge, chain, t.address, from, to, resolution);
      } catch (e) {
        console.error(`[candles] ${label} ${chain}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    };
    let changed = false;

    // 1. 喊单定价：按时间聚簇，每簇一次 1m 请求（窗口 ≤ 90 根）
    const supply = t.market?.price && t.market.mc ? t.market.mc / t.market.price : undefined;
    const sorted = [...targets].sort((a, b) => a.time - b.time);
    let priced = 0;
    for (let i = 0; i < sorted.length; ) {
      const from = sorted[i].time - 1800;
      const to = Math.min(ts, from + 90 * 60);
      const cluster: Mention[] = [];
      while (i < sorted.length && sorted[i].time + 60 <= to) cluster.push(sorted[i++]);
      if (cluster.length === 0) cluster.push(sorted[i++]);
      const list = await fetch(from, to, "1m");
      if (list.length === 0) continue;
      for (const c of cluster) {
        const hit = list.find((k) => k.time <= c.time && c.time < k.time + 60) ?? list.reduce((b, k) => (Math.abs(k.time - c.time) < Math.abs(b.time - c.time) ? k : b));
        if (Math.abs(hit.time - c.time) > CANDLE_TOLERANCE) continue;
        c.price = hit.open;
        c.mc = supply !== undefined ? hit.open * supply : undefined;
        c.approx = false;
        this.store.updateCallPrice(t.address, c);
        priced++;
        changed = true;
      }
    }

    // 2. K 线补齐：首次喊单 → 现有采样起点，分辨率按跨度选
    if (needSeed && firstCall !== undefined) {
      const until = t.history[0]?.time ?? ts;
      const spanSec = until - firstCall;
      const resolution = Object.entries(RESOLUTION_SEC).find(([, sec]) => spanSec / sec <= 95)?.[0] ?? "1h";
      const step = RESOLUTION_SEC[resolution];
      const list = await fetch(firstCall - step, until, resolution);
      const seed = list
        .filter((k) => k.time >= firstCall - step && k.time < until)
        .map((k) => ({ time: k.time + step, price: k.close, mc: supply !== undefined ? k.close * supply : undefined }));
      if (seed.length > 0) {
        for (const s of seed) this.store.insertSample(t.address, s, s.mc ?? null, null);
        t.history = [...seed, ...t.history];
        if (t.history.length > MAX_HISTORY) t.history = thin(t.history, MAX_HISTORY);
        changed = true;
        console.error(`[candles] ${label} seeded ${seed.length}@${resolution}`);
      }
    }
    if (priced > 0) console.error(`[candles] ${label} priced ${priced}/${targets.length}`);
    if (changed) this.scheduleState();
  }

  /**
   * 喊单价补全：
   * - live（消息 ≤ LIVE_WINDOW 秒前）→ 现价
   * - 回灌 → gmgn 历史价桶里离喊单时间最近的一个（间隔差 >3 倍就宁缺毋滥），标 approx
   * - 只有 dex 快照、没有历史桶 → 先留空，等 gmgn
   */
  private fillMentionPrices(t: TokenState): void {
    const m = t.market;
    if (!m || m.price === undefined) return;
    const p = m.price;
    const ts = now();
    for (const c of t.mentions) {
      if (c.price !== undefined) continue;
      const age = Math.max(1, ts - c.time);
      if (age <= LIVE_WINDOW) {
        c.price = p;
        c.mc = m.mc;
        c.approx = false;
      } else if (m.priceAgo) {
        let bestSec = 0;
        let bestDist = Infinity;
        for (const k of Object.keys(m.priceAgo)) {
          const sec = Number(k);
          const d = Math.abs(Math.log(sec) - Math.log(age));
          if (d < bestDist) {
            bestDist = d;
            bestSec = sec;
          }
        }
        if (!bestSec || age / bestSec >= 3 || bestSec / age >= 3) continue;
        const hp = m.priceAgo[bestSec];
        c.price = hp;
        c.approx = true;
        if (m.mc !== undefined && p > 0) c.mc = (m.mc * hp) / p;
      } else continue;
      this.store.updateCallPrice(t.address, c);
    }
  }

  // ---------- 推送 ----------

  private afterState: Array<Parameters<Bridge["emit"]>[0]> = [];

  /** 状态变更合并 150ms 再推，回灌几十条不至于刷屏。正开着焦点持仓（不在 tokens 里）时顺带推它的 `token_detail`——它的行情 / 社交 / fomo 变化和追踪代币走同一条 scheduleState */
  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.bridge.emit({ t: "state", tokens: this.views() });
      const f = this.focused;
      if (f && !this.isTracked(f)) this.bridge.emit({ t: "token_detail", token: this.view(f) });
      for (const e of this.afterState) {
        // 排队期间可见性变了的作废：隐藏的币不弹卡（state 里已没有它）；行情赶在推送前到了的不发 token_hidden
        if (e.t === "new_token" || e.t === "token_hidden") {
          const t = this.tokens[this.index.get(e.address) ?? -1];
          if (!t || this.hidden(t) !== (e.t === "token_hidden")) continue;
        }
        this.bridge.emit(e);
      }
      this.afterState = [];
    }, 150);
  }

  /** 保证在下一次 state 之后发出（Swift 弹卡时列表里已经有这个代币） */
  private emitAfterState(e: Parameters<Bridge["emit"]>[0]): void {
    this.afterState.push(e);
    this.scheduleState();
  }
}
