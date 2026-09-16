import WebSocket from "ws";
import { createTransport, fetch as wreqFetch, type Transport } from "wreq-js";
import { isLoopback, proxyAgent, systemProxy } from "./proxy.js";
import type { Bridge } from "./rpc.js";
import type { FomoActivityRow, Store } from "./store.js";
import { GMGN_HOLDERS_LIMIT, strictAmount, type GmgnHoldersPage } from "./gmgn.js";
import type { FomoActivity, FomoFrontRank, FomoMeResult, FomoThesis, FomoThesisError, FomoThesisEvent, FomoTokenParams, FomoTokenResult, FomoView } from "./types.js";

/**
 * fomo.family「我关注的人买了什么」（决策：docs/adr/0005）。交易半边（报价 / 执行 / 持仓）不在这里：见 `trade.ts`（本地 burner + OKX DEX，docs/adr/0006）。
 *
 * 凭证：Swift 侧 `FomoBridge` 常驻一个登录了 fomo.family 的 WKWebView，sidecar 每次用前经 rpc `fomo.token` 取当前 Privy access token
 * （页面里 Privy SDK 自己续期；sidecar **不碰 refresh token**）、`fomo.me` 取 `{userId, handle, following}`（用户脚本截获页面自己的 `POST /v2/users`）。
 * REST 由 Node 直发，但 **TLS / HTTP2 指纹按 Safari 26 (macOS) 伪装**（`wreq-js`：BoringSSL + 浏览器画像，tls.peet.ws 实测 JA3 / JA4 / peetprint / Akamai h2
 * 四项与本机 WKWebView 逐项相同）。背景：fomo 的请求画像门 2026-09-09 22:18 起对 Node 原生 `https`（OpenSSL 指纹 + Chrome UA）一律 430
 * `{"error":"unauthorized"}`（此前间歇性、逐步收紧到 100%），undici 更早就是 430；换成浏览器指纹后 8/8 → 200。曾短暂改为在 WKWebView 页面里 fetch（rpc），
 * 同样有效但多一跳且依赖页面已加载，Node 侧能过就不留那条路。
 *   `GET /v2/users/current/followingIds` + `GET /v2/users/<me>/followingPaginate` 关注列表；
 *   `GET /feed/tradingActivity?limit=50[&lastId]` 回灌最近 24h（≤4 页）；`POST /hodlers/friends` 批量「关注者当前持有人数」（焦点币 15s，其余 60s）。
 *   430/431 = 指纹拒绝、429 = 限流：记日志、退避 60s×2 到 30min，**不重试**。
 * WS：`wss://prod-api.fomo.family/ws` challenge → challengeResponse(jwt) → subscribe trading_activity:<me>，服务端推关注者每笔买卖/Thesis；
 *   重连同 gmgnws（单一建连路径、1s→60s 退避），重连后补一页 REST。
 *
 * 只保留我们列表里有的币（address 小写 + 链匹配）的记录进 `activity` 与 sqlite `fomo_activity`；其它 alert 只在内存 `recent`（24h、≤1000 条）里
 * 留一份归一化后的，新币进列表时从这里补（`adopt`）。
 *
 * ToS：fomo §16 禁自动抓取，这里是个人只读、低频（一条 WS + 15s 一次批量 POST），绝不做自动交易。
 */

const WS_URL = "wss://prod-api.fomo.family/ws";
const ORIGIN = "https://fomo.family";
const API = "https://prod-api.fomo.family";
/** 只给 WS（Node `ws` 直连）用；REST 的 UA 由 wreq-js 的 Safari 画像决定 */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const SUPPORTED_CHAINS = "1,56,143,4663,8453,1399811149";

/** fomo networkId ↔ 我们的 gmgn 链 slug */
const NETWORK_TO_CHAIN: Record<number, string> = { 1: "eth", 56: "bsc", 143: "monad", 4663: "robinhood", 8453: "base", 1399811149: "sol" };
const CHAIN_TO_NETWORK: Record<string, number> = Object.fromEntries(Object.entries(NETWORK_TO_CHAIN).map(([n, c]) => [c, Number(n)]));

const BACKFILL_WINDOW_SEC = 24 * 3600;
/** `/feed/tradingActivity` 连翻 4 页是它的配额（第 5 页必 429、无限流头可读，1s 间隔也一样；Node 直连时期就如此）；一撞整个 REST 退避 60s，前排 / Thesis 跟着停。4 页 = 200 条，24h 窗口够不够看运气，之后靠 WS */
const BACKFILL_MAX_PAGES = 4;
const BACKFILL_PAGE_GAP_MS = 1000;
const RECENT_MAX = 1000;
const PER_TOKEN_MAX = 100;
const VIEW_MAX = 30;
const HOLDERS_EVERY_MS = 15_000;
/** 非焦点币每 4 个 tick（60s）一次 */
const HOLDERS_ALL_EVERY = 4;
/** 弹卡「fomo Thesis」列：`GET /feed/token/thesis`（全站用户、threshold=0 = 全部金额）每页 50；用户点「加载更多」用 lastId 翻页直到服务端 hasNextPage=false；焦点币快照超过 60s 在 15s tick 上重拉首页 */
const THESIS_PAGE = 50;
const THESIS_STALE_SEC = 60;
const LOGIN_POLL_MS = 30_000;
const REST_BACKOFF_MIN_MS = 60_000;
const REST_BACKOFF_MAX_MS = 30 * 60_000;
const WS_BACKOFF_MIN = 1000;
const WS_BACKOFF_MAX = 60_000;

const now = () => Math.floor(Date.now() / 1000);

export interface FomoTracked {
  address: string;
  chain: string | null;
}

interface Me {
  userId: string;
  handle: string;
  following: number | null;
}

interface Envelope<T> {
  message?: string;
  responseObject?: T;
}

/** 弹卡 Thesis 列的进程内快照（不落库；登出清空） */
interface ThesisCache {
  address: string;
  chain: string;
  items: FomoThesis[];
  count: number | null;
  hasNext: boolean;
  at: number;
  error: FomoThesisError | null;
  /** 下一页的 lastId = 最深那页原样的最后一条 id；null = 还没拉到过。首页重拉与缓存有重叠时保留（翻到底后不再点亮「加载更多」），零重叠且还有更多时改成这页的最后一条（从洞口继续） */
  cursor: string | null;
}

/** 从 JWT 里读 exp（秒）；解不出 → null */
function jwtExp(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function normAddress(a: unknown): string {
  const s = String(a ?? "");
  return s.startsWith("0x") ? s.toLowerCase() : s;
}

const FRONT_TOP = 50;
/** 快照超过这个时长不再展示（焦点币 15s 一刷；主面板显示行 ≥45s 排队刷；其它币不刷） */
const FRONT_STALE_SEC = 60;
/** 主面板显示行的快照到这个年龄就排队重拉（< FRONT_STALE_SEC，免得行上先「—」一下再回来） */
const FRONT_REFRESH_SEC = 45;

/**
 * 「fomo 前排比例」纯计算：fomo `/hodlers/top` 的 responseObject[0]（或 null = 没拿到）× gmgn 前排一页（或 Error = 没拿到）→ 快照。
 * - fomo：响应的 `tokenAddress` / `networkId` 必须就是请求的币（串位 → 不可用）；`topHolders[]` 必须是数组（服务端按持仓降序、最多 50 行），只累加前 50 行；
 *   每行 `humanAmount` 必须是有限非负数，否则不可用；空数组是合法的 0。
 * - gmgn：按服务端排序扫描，**只跳过 pool**（`addrType === 2`；燃烧 / 交易所钱包 / dev 保留），累加前 50 个非 pool。`pools` = 选满前跳过的 pool 数。
 *   非 pool 不足 50 时：只有「服务端明确说没有更多（`more === false`）且不满一页」才算列表取尽、按实际 n 算；
 *   否则（还有更多 / 满页 / 续页信息缺失）= 前排被截断且我们不能续页 → 不可用，不给部分值。
 * - 分母 0 → 不可用。
 */
export function frontRank(want: { address: string; networkId: number }, fomo: unknown, gmgn: GmgnHoldersPage | Error, at: number): FomoFrontRank {
  const fail = (why: string): FomoFrontRank => ({ ratio: null, fomo: null, gmgn: null, at, why });
  if (fomo === null) return fail("fomo 前排没拿到");
  if (typeof fomo !== "object" || !fomo || !("topHolders" in fomo) || !("tokenAddress" in fomo) || !("networkId" in fomo)) return fail("fomo 前排响应缺 topHolders/tokenAddress/networkId");
  if (normAddress(fomo.tokenAddress) !== normAddress(want.address) || fomo.networkId !== want.networkId) return fail("fomo 前排响应不是请求的币");
  const top = fomo.topHolders;
  if (!Array.isArray(top)) return fail("fomo 前排响应 topHolders 不是数组");
  const fomoN = Math.min(top.length, FRONT_TOP);
  let fomoSum = 0;
  for (let i = 0; i < fomoN; i++) {
    const row: unknown = top[i];
    const a = typeof row === "object" && row && "humanAmount" in row ? strictAmount(row.humanAmount) : null;
    if (a === null) return fail(`fomo 前排第 ${i + 1} 行缺 humanAmount`);
    fomoSum += a;
  }
  if (gmgn instanceof Error) return fail(`gmgn 前排没拿到：${gmgn.message}`);
  let gmgnSum = 0;
  let gmgnN = 0;
  let pools = 0;
  for (const r of gmgn.rows) {
    if (gmgnN >= FRONT_TOP) break;
    if (r.addrType === 2) pools++;
    else {
      gmgnSum += r.amount;
      gmgnN++;
    }
  }
  if (gmgnN < FRONT_TOP && (gmgn.more !== false || gmgn.rows.length >= GMGN_HOLDERS_LIMIT)) {
    return fail(`gmgn 这页 ${gmgn.rows.length} 行里非 pool 只有 ${gmgnN} 个，凑不满 ${FRONT_TOP} 且${gmgn.more === null ? "续页信息缺失" : "不能续页"}`);
  }
  const out = { fomo: { amount: fomoSum, n: fomoN }, gmgn: { amount: gmgnSum, n: gmgnN, pools }, at };
  if (!(gmgnSum > 0)) return { ...out, ratio: null, why: "gmgn 前排合计为 0" };
  return { ...out, ratio: fomoSum / gmgnSum, why: null };
}

export class FomoService {
  private me: Me | null = null;
  private loggingIn = false;
  private loginTimer: NodeJS.Timeout | undefined;
  private closed = false;

  private tok: string | null = null;
  private tokExp = 0;
  private refreshAskedAt = 0;
  private tokenNullStreak = 0;

  /** userId → 关注者（头像兜底、following 数） */
  private following = new Map<string, { handle: string; avatar: string | null }>();
  /** 列表里代币的记录：address → 按 ts 降序、去重 */
  private activity = new Map<string, FomoActivityRow[]>();
  /** 最近 24h 全部归一化 alert（不分是否在列表里），新币进列表时从这里补 */
  private recent: FomoActivityRow[] = [];
  private holders = new Map<string, { n: number; at: number }>();
  /** `${chain}:${address}` → 最近一份前排比例快照 */
  private frontRank = new Map<string, FomoFrontRank>();
  private frontInflight = new Set<string>();
  /** 主面板当前显示的行（Swift `front_rank_visible` 全集，小写地址）：串行排队拉前排 */
  private visible: string[] = [];
  private visiblePumping = false;
  private holdersTimer: NodeJS.Timeout | undefined;
  private holdersTick = 0;
  private lastAlertTs = 0;
  /** `${chain}:${address}` → 弹卡 Thesis 列快照（按 ts 降序、已翻到的全部页） */
  private thesis = new Map<string, ThesisCache>();
  private thesisInflight = new Set<string>();

  private restBlockedUntil = 0;
  private restBackoffMs = 0;
  private lastLog = "";

  private ws: WebSocket | null = null;
  private wsBackoff = 0;
  private wsTimer: NodeJS.Timeout | undefined;
  private wsConnecting = false;
  private wsError = "";
  private wsLastLog = "";
  private wsEverConnected = false;
  private multiShapeLogged = false;

  /** 某代币的 fomo 数据变了（活动 / 持有人数）→ 引擎推 state */
  onChange: ((address: string) => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly bridge: Bridge,
    private readonly deps: {
      tracked: () => FomoTracked[];
      /** 当前弹卡的币（地址 + 引擎已知的链）：追踪列表里的，或不在列表里的「当前持仓」 */
      focused: () => FomoTracked | null;
      symbolOf: (address: string) => string | null;
      /** gmgn 前排一页（`gmgn.ts topHolders`，经 GmgnBridge；行 + `next` 游标）；失败抛错 */
      gmgnTopHolders: (address: string, chain: string) => Promise<GmgnHoldersPage>;
      /** 只给测试指到本机假服务 / 假 WS；默认 prod */
      apiBase?: string;
      wsUrl?: string;
    },
  ) {}

  get loggedIn(): boolean {
    return this.me !== null;
  }

  /** 从库恢复列表里代币的记录，推一次未登录状态，然后每 30s 问 Swift 一次登录态直到登上 */
  start(): void {
    const rows = this.store.loadFomoActivity();
    for (const r of rows) this.put(r, false);
    console.error(`[fomo] restored ${rows.length} activity rows for ${this.activity.size} tokens`);
    this.emitState();
    this.loginTimer = setInterval(() => void this.tryLogin(), LOGIN_POLL_MS);
    void this.tryLogin();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.loginTimer);
    this.stopHolders();
    this.closeWs();
    // transport 持有原生连接池（keep-alive 连接），不关会拖住进程退出
    void this.transport?.t.close();
    this.transport = null;
  }

  /** 弹卡契约：未登录 / 该链 fomo 不支持 → null */
  view(address: string, chain: string | null): FomoView | null {
    if (!this.me) return null;
    if (chain && CHAIN_TO_NETWORK[chain] === undefined) return null;
    // 不在追踪列表里的「当前持仓」没有 activity（不落库、不 adopt）：焦点币从最近 24h 的全站 alert 里现取（只对焦点币算，别的 view 调用不扫 recent）
    const rows = this.activity.get(address) ?? (this.deps.focused()?.address === address ? this.recent.filter((r) => r.address === address).sort((a, b) => b.ts - a.ts) : []);
    const mine = chain ? rows.filter((r) => r.chain === chain) : rows;
    const buyers = new Set(mine.filter((r) => r.kind === "buy" || (r.kind === "thesis" && r.usd !== null)).map((r) => r.handle)).size;
    const h = this.holders.get(address);
    const fr = chain ? this.frontRank.get(`${chain}:${address}`) : undefined;
    return {
      buyers,
      holders: h ? h.n : null,
      activity: mine.slice(0, VIEW_MAX).map(({ handle, avatar, kind, usd, mc, ts, comment }): FomoActivity => ({ handle, avatar, kind, usd, mc, ts, comment })),
      frontRank: fr && now() - fr.at <= FRONT_STALE_SEC ? fr : null,
    };
  }

  /** 新币进了列表：把最近 24h 里它的 alert 补进来 */
  adopt(address: string): void {
    let n = 0;
    for (const r of this.recent) if (r.address === address && this.put(r, true)) n++;
    if (n) {
      console.error(`[fomo] adopt ${address.slice(0, 10)}: ${n} recent alerts`);
      this.onChange?.(address);
    }
  }

  // ---------- 登录 ----------

  private emitState(): void {
    this.bridge.emit({ t: "fomo_state", loggedIn: this.me !== null });
  }

  private logOnce(line: string): void {
    if (line === this.lastLog) return;
    this.lastLog = line;
    console.error(`[fomo] ${line}`);
  }

  private async tryLogin(): Promise<void> {
    if (this.closed || this.me || this.loggingIn) return;
    this.loggingIn = true;
    try {
      const token = await this.token();
      if (!token) {
        this.logOnce("not logged in (no token from fomo.family page); use status bar「登录 fomo…」");
        return;
      }
      let me: FomoMeResult;
      try {
        me = (await this.bridge.rpc("fomo.me", {}, 20_000)) as FomoMeResult;
      } catch (e) {
        this.logOnce(`fomo.me rpc: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!me?.userId) {
        this.logOnce("have token but page has not reported /v2/users yet");
        return;
      }
      this.me = { userId: me.userId, handle: me.handle, following: me.following ?? null };
      this.lastLog = "";
      this.emitState();
      console.error(`[fomo] logged in as ${me.handle} following=${me.following ?? "?"}`);
      await this.loadFollowing();
      await this.backfill(now() - BACKFILL_WINDOW_SEC, BACKFILL_MAX_PAGES);
      this.connectWs();
      this.startHolders();
      // 登录前弹卡已开着：之前推的是 not_logged_in，现在补拉 Thesis 列 / 前排
      const f = this.deps.focused();
      if (f) this.focusChanged(f.address, f.chain);
    } finally {
      this.loggingIn = false;
    }
  }

  private setLoggedOut(why: string): void {
    if (!this.me) return;
    console.error(`[fomo] logged out (${why})`);
    this.me = null;
    this.tok = null;
    this.following.clear();
    this.holders.clear();
    this.frontRank.clear();
    this.thesis.clear();
    this.thesisInflight.clear(); // 在飞的旧请求回来会因 me 变了被丢弃，且不再释放（新账号的同 key 请求可能已在飞）
    this.stopHolders();
    this.closeWs();
    this.emitState();
  }

  /**
   * 当前 access token：缓存里还有 >2min 就直接用；否则问 Swift（快到期且 60s 内没问过就带 refresh=true 让页面重载换新）。
   * 页面连续 3 次给不出 token → 视为登出。
   */
  private async token(): Promise<string | null> {
    const t = now();
    if (this.tok && this.tokExp - t > 120) return this.tok;
    const wantRefresh = !!this.tok && this.tokExp - t <= 120 && t - this.refreshAskedAt > 60;
    if (wantRefresh) this.refreshAskedAt = t;
    let r: FomoTokenResult;
    try {
      r = (await this.bridge.rpc("fomo.token", { refresh: wantRefresh } satisfies FomoTokenParams, 30_000)) as FomoTokenResult;
    } catch (e) {
      this.logOnce(`fomo.token rpc: ${e instanceof Error ? e.message : String(e)}`);
      return this.tok && this.tokExp > t ? this.tok : null;
    }
    const tok = r?.token ?? null;
    if (!tok) {
      if (this.me && ++this.tokenNullStreak >= 3) this.setLoggedOut("page has no token");
      return null;
    }
    this.tokenNullStreak = 0;
    const exp = jwtExp(tok);
    this.tok = tok;
    this.tokExp = exp ?? t + 3600;
    if (exp !== null && exp <= t) {
      // 页面存的已过期：留着 tok/tokExp 让下次调用触发 refresh（页面重载后 Privy 会用 refresh token 换新）
      this.logOnce("page token expired; asking page to refresh");
      return null;
    }
    return tok;
  }

  // ---------- REST ----------

  /** 成功 → responseObject；其它一律 null（错误已记日志）。要看错误信封用 `request()` */
  private async api<T>(path: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T | null> {
    const r = await this.request<T>(path, opts);
    return r && r.status >= 200 && r.status < 300 ? (r.env?.responseObject ?? null) : null;
  }

  /**
   * 带 token 发一个请求（Node + Safari 指纹，见文件头），返回状态码 + 信封。null = 没发（REST 退避中 / 没 token）或指纹门 / 401（已记日志）。
   * 430/431/429 → 退避 60s×2 到 30min 不重试；401 → 丢缓存 token；其它非 2xx 记一行日志后原样交给调用方。网络错 / 超时按 status 0 处理
   */
  private async request<T>(path: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<{ status: number; env: Envelope<T> | null } | null> {
    const method = opts.method ?? "GET";
    if (Date.now() < this.restBlockedUntil) return null;
    const token = await this.token();
    if (!token) return null;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Supported-Chains": SUPPORTED_CHAINS };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const r = await this.nodeFetch({ path, method, body: opts.body === undefined ? null : JSON.stringify(opts.body), headers });
    if (r.status === 430 || r.status === 431 || r.status === 429) {
      this.restBackoffMs = this.restBackoffMs ? Math.min(this.restBackoffMs * 2, REST_BACKOFF_MAX_MS) : REST_BACKOFF_MIN_MS;
      this.restBlockedUntil = Date.now() + this.restBackoffMs;
      console.error(`[fomo] ${method} ${path.split("?")[0]} → ${r.status} (${r.status === 429 ? "rate limited" : "fingerprint gate"}); REST paused ${this.restBackoffMs / 1000}s`);
      return null;
    }
    if (r.status === 401) {
      this.tok = null;
      console.error(`[fomo] ${method} ${path.split("?")[0]} → 401; dropping cached token`);
      return null;
    }
    const env = r.json as Envelope<T> | null;
    if (r.status < 200 || r.status >= 300) {
      console.error(`[fomo] ${method} ${path.split("?")[0]} → ${r.status || "no response"}${env?.message ? ` ${env.message}` : ""}`);
      return { status: r.status, env };
    }
    this.restBackoffMs = 0;
    return { status: r.status, env };
  }

  /**
   * Node 侧发请求，TLS / HTTP2 指纹按 Safari 26 (macOS) 伪装（见文件头），再加上页面 fetch 会带的 Origin / Referer / sec-fetch-*。
   * 走系统代理（与 proxy.ts 同一份 systemProxy，30s 缓存；代理变了重建 transport——transport 持有连接池与 TLS 会话缓存）。
   * status 0 = 网络错 / 超时；非 JSON body → json null
   */
  private transport: { key: string; t: Transport } | null = null;
  private async nodeFetch(p: { path: string; method: "GET" | "POST"; body: string | null; headers: Record<string, string> }): Promise<{ status: number; json: unknown }> {
    try {
      const base = this.deps.apiBase ?? API;
      const proxy = isLoopback(base) ? null : await systemProxy();
      const key = proxy ? `http://${proxy.host}:${proxy.port}` : "";
      if (this.transport?.key !== key) {
        void this.transport?.t.close();
        this.transport = { key, t: await createTransport({ browser: "safari_26", os: "macos", ...(key ? { proxy: key } : {}) }) };
      }
      const res = await wreqFetch(base + p.path, {
        transport: this.transport.t,
        method: p.method,
        headers: { ...p.headers, Origin: ORIGIN, Referer: `${ORIGIN}/`, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site" },
        body: p.body ?? undefined,
        timeout: 15_000,
      });
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        return { status: res.status, json: null };
      }
    } catch (e) {
      this.logOnce(`fomo rest: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 0, json: null };
    }
  }

  /**
   * 弹卡关了 / 换币（引擎 focus() 调；链迟到时引擎再调一次）：
   * 新焦点币**立刻**拉一次「fomo 前排」，不等 15s tick——用户连点几张卡每张只看几秒，等 tick 就永远是「—」（真机 focus→首份快照 17s）。
   * 60s 内已有快照的直接展示、交给 tick 刷；单飞由 refreshFrontRank 守。
   * `chain` = 弹卡这张卡的链（不在追踪列表里的「当前持仓」只有它知道）；省略则按追踪列表推。
   */
  focusChanged(address: string | null, chain: string | null = null): void {
    if (!address) return;
    const a = normAddress(address);
    const t: FomoTracked = { address: a, chain: chain ?? this.deps.tracked().find((x) => x.address === a)?.chain ?? null };
    this.thesisFocused(t.address, t);
    if (!this.me || !t.chain || CHAIN_TO_NETWORK[t.chain] === undefined) return;
    const cur = this.frontRank.get(`${t.chain}:${t.address}`);
    if (cur && now() - cur.at <= FRONT_STALE_SEC) return;
    void this.refreshFrontRank(t);
  }

  /** 弹卡上的币：焦点币的地址对得上就用焦点币（链跟着弹卡走，不在追踪列表里的持仓只有这一条路），否则查追踪列表 */
  private focusedOrTracked(address: string): FomoTracked | null {
    const f = this.deps.focused();
    if (f && normAddress(f.address) === address) return f;
    return this.deps.tracked().find((x) => x.address === address) ?? null;
  }

  // ---------- fomo Thesis（弹卡列） ----------

  /**
   * 弹卡打开 / 换币 / 链迟到：立刻推该币的 Thesis 快照。未登录 / 链未知 / fomo 不支持该链 → 带 error 的事件（items 空），
   * 有 ≤60s 的快照直接推缓存；否则先推 `loading:true`（带旧缓存）再拉首页。不扇出到别的币。
   */
  private thesisFocused(address: string, t: FomoTracked | null): void {
    const fail = (chain: string | null, error: FomoThesisError) => this.emitThesis({ t: "fomo_thesis", address, chain, items: [], count: null, hasNext: false, at: now(), error, loading: false });
    if (!this.me) return fail(t?.chain ?? null, "not_logged_in");
    if (!t?.chain) return fail(null, "chain_unknown");
    if (CHAIN_TO_NETWORK[t.chain] === undefined) return fail(t.chain, "unsupported_chain");
    const cur = this.thesis.get(`${t.chain}:${address}`);
    if (cur && !cur.error && now() - cur.at <= THESIS_STALE_SEC) return this.emitThesis(this.thesisEvent(cur, false));
    void this.fetchThesis(t, null);
  }

  /** Swift 点了「加载更多」：用最后一条的 id 当 lastId 翻下一页（≤4 页）；没有下一页 / 在飞就忽略。链取弹卡当前的（同地址换链后不翻旧链的页） */
  thesisMore(address: string): void {
    const a = normAddress(address);
    const t = this.focusedOrTracked(a);
    if (!this.me || !t?.chain) return;
    const cur = this.thesis.get(`${t.chain}:${a}`);
    if (!cur?.hasNext || !cur.cursor) return;
    void this.fetchThesis(t, cur.cursor);
  }

  /** 15s tick：焦点币的快照 ≥60s 就重拉首页（合并进已有页，不丢已翻到的） */
  private thesisTick(t: FomoTracked): void {
    const cur = this.thesis.get(`${t.chain}:${t.address}`);
    if (cur && now() - cur.at < THESIS_STALE_SEC) return;
    void this.fetchThesis(t, null);
  }

  /**
   * `GET /feed/token/thesis?tokenAddress&networkId&limit=50&threshold=0[&lastId]`（threshold=0 = 全部金额）→ `{items, hasNextPage, count}`。
   * 单飞（按 chain:address）；登出 / 换号 / close 后回来的响应丢弃；响应不是这个形状 → `schema`（不当成空列表）；request 为 null（退避 / 无 token / 指纹门）或非 2xx → `fetch_failed`。
   * 失败时保留旧 items，只更新 error/at。
   */
  private async fetchThesis(t: FomoTracked, lastId: string | null): Promise<void> {
    const me = this.me;
    if (!me || CHAIN_TO_NETWORK[t.chain!] === undefined) return;
    const key = `${t.chain}:${t.address}`;
    if (this.thesisInflight.has(key)) return;
    this.thesisInflight.add(key);
    const prev = this.thesis.get(key) ?? { address: t.address, chain: t.chain!, items: [], count: null, hasNext: false, at: 0, error: null, cursor: null };
    this.emitThesis(this.thesisEvent(prev, true));
    try {
      const page = await this.thesisRequest(t.address, t.chain!, lastId);
      if (this.closed || this.me !== me) return;
      const label = this.deps.symbolOf(t.address) ?? t.address.slice(0, 10);
      let next: ThesisCache;
      if ("error" in page) next = { ...prev, at: now(), error: page.error };
      else {
        const byId = new Map<string, FomoThesis>();
        // 首页重拉 = 刷新已翻到的全部（保留旧页的条目），翻页 = 追加
        for (const x of prev.items) byId.set(x.id, x);
        let overlap = 0;
        for (const x of page.items) {
          if (byId.has(x.id)) overlap++;
          byId.set(x.id, x);
        }
        const items = [...byId.values()].sort((a, b) => b.ts - a.ts);
        // 翻页 / 首次 / 与缓存零重叠且还有更多的首页重拉（60s 内新增 >50 条，中间有洞，要从这页最后一条继续翻，不能假装已取尽）→ 取这一页的 hasNext + 最后一条 id；
        // 有重叠的首页重拉 → 保留原来的游标与结论（翻到底后首页自带的 hasNextPage 不能再点亮「加载更多」）
        const adopt = lastId !== null || prev.cursor === null || (overlap === 0 && page.hasNext);
        next = {
          address: t.address,
          chain: t.chain!,
          items,
          count: page.count ?? prev.count, // 服务端总数原样（口径未知，UI 只作「/ 总数」提示，不据此夹高）
          hasNext: adopt ? page.hasNext : prev.hasNext,
          at: now(),
          error: null,
          cursor: adopt ? page.lastId : prev.cursor,
        };
        if (page.dropped) console.error(`[fomo] thesis ${label}: dropped ${page.dropped} malformed rows`);
      }
      this.thesis.set(key, next);
      if (next.error && next.error !== prev.error) console.error(`[fomo] thesis ${label}: ${next.error}`);
      this.emitThesis(this.thesisEvent(next, false));
    } finally {
      // 登出 / 换号后 setLoggedOut 已清空 inflight；此时不能再删——同 key 可能已是新账号的在飞请求
      if (this.me === me) this.thesisInflight.delete(key);
    }
  }

  /** 一页原样：request 为 null（退避 / 无 token / 指纹门）或非 2xx → fetch_failed；`items` 不是数组 → schema（不当成空列表） */
  private async thesisRequest(address: string, chain: string, lastId: string | null): Promise<{ items: FomoThesis[]; count: number | null; hasNext: boolean; lastId: string | null; dropped: number } | { error: FomoThesisError }> {
    const net = CHAIN_TO_NETWORK[chain];
    if (net === undefined) return { error: "unsupported_chain" };
    // threshold=0 = fomo 前端「Min size → All」传给同族 /feed/token/* 的取值；不传时服务端按自己的默认筛（2026-09-07 真机：不传与 threshold=1000 都回 29 条 / count 191），所以显式传 0
    const q = `tokenAddress=${encodeURIComponent(address)}&networkId=${net}&limit=${THESIS_PAGE}&threshold=0${lastId ? `&lastId=${encodeURIComponent(lastId)}` : ""}`;
    const r = await this.request<{ items?: unknown; hasNextPage?: unknown; count?: unknown }>(`/feed/token/thesis?${q}`);
    if (!r || r.status < 200 || r.status >= 300) return { error: "fetch_failed" };
    const ro = r.env?.responseObject;
    if (!ro || !Array.isArray(ro.items)) {
      console.error(`[fomo] thesis ${this.deps.symbolOf(address) ?? address.slice(0, 10)}: unexpected shape keys=${JSON.stringify(Object.keys((ro as object) ?? {}))}`);
      return { error: "schema" };
    }
    const items = ro.items.map(FomoService.thesisOf).filter((x): x is FomoThesis => x !== null);
    // 翻页契约：hasNextPage 必须是布尔；说还有下一页就必须给得出可用的 lastId（原样最后一条的 id）且比上一页前进了，否则是形状/契约问题，不能静默当「到底了」
    const raw = ro.items[ro.items.length - 1] as { id?: unknown } | undefined;
    const pageLast = typeof raw?.id === "string" && raw.id ? raw.id : null;
    if (typeof ro.hasNextPage !== "boolean" || (ro.hasNextPage && (!pageLast || pageLast === lastId))) {
      console.error(`[fomo] thesis ${this.deps.symbolOf(address) ?? address.slice(0, 10)}: pagination contract broken (hasNextPage=${String(ro.hasNextPage)} lastId=${pageLast})`);
      return { error: "schema" };
    }
    return { items, count: num(ro.count), hasNext: ro.hasNextPage, lastId: pageLast, dropped: ro.items.length - items.length };
  }

  private thesisEvent(c: ThesisCache, loading: boolean): FomoThesisEvent {
    return { t: "fomo_thesis", address: c.address, chain: c.chain, items: c.items, count: c.count, hasNext: c.hasNext, at: c.at, error: c.error, loading };
  }

  /** 只推当前焦点币的（换卡 / 换链后迟到的响应对 Swift 没用；缓存照存） */
  private emitThesis(ev: FomoThesisEvent): void {
    const f = this.deps.focused();
    if (!f || normAddress(f.address) !== ev.address || (ev.chain !== null && f.chain !== null && ev.chain !== f.chain)) return;
    this.bridge.emit(ev);
  }

  /** 一条 `/feed/token/thesis` item → FomoThesis；缺 id / handle / 时间 / 非空评论 → null（调用方计数并记日志） */
  static thesisOf(raw: unknown): FomoThesis | null {
    const it = raw as Record<string, unknown> | null;
    if (!it || typeof it !== "object") return null;
    const id = typeof it.id === "string" ? it.id : null;
    const handle = typeof it.userHandle === "string" && it.userHandle ? it.userHandle : typeof it.displayName === "string" && it.displayName ? it.displayName : null;
    const c = it.comment as { comment?: unknown; numLikes?: unknown } | undefined;
    const comment = typeof c?.comment === "string" && c.comment.trim() ? c.comment.trim() : null;
    const ts = Math.floor(Date.parse(String(it.createdAt)) / 1000);
    if (!id || !handle || !comment || !Number.isFinite(ts)) return null;
    const tr = it.authorTrade as Record<string, unknown> | null | undefined;
    const amount = tr ? num(tr.humanTokenAmount) : null;
    const usd = tr ? num(tr.usdValue) : null;
    const position = amount !== null && amount > 0 && usd !== null ? { usd, unrealizedPct: num(tr!.percentageUnrealizedPnl) } : null;
    return {
      id,
      handle,
      name: typeof it.displayName === "string" && it.displayName ? it.displayName : handle,
      avatar: typeof it.profilePictureLink === "string" && it.profilePictureLink ? it.profilePictureLink : null,
      verified: it.verified === true,
      ts,
      comment,
      likes: num(c?.numLikes) ?? 0,
      replies: num(it.numReplies) ?? 0,
      position,
      isDev: it.isDev === true,
    };
  }

  /**
   * 主面板显示行全集变了（引擎 frontRankVisible / 链迟到再通知）：只替换集合并踢一下串行队列。
   * 不同于弹卡的立即路径：主面板一次可能十几行，这里**并发 1** 顺序拉（每行 fomo GET + gmgn WK 各一次），快照 ≥45s 才重拉；
   * 焦点币由 focusChanged / 15s tick 负责，队列跳过；不扇出全部 tracked。
   */
  visibleChanged(addresses: string[]): void {
    this.visible = addresses.map(normAddress);
    void this.pumpVisible();
  }

  /** 串行跑完所有该刷的显示行；空转即退出，由 visibleChanged / 15s tick 再踢 */
  private async pumpVisible(): Promise<void> {
    if (this.visiblePumping) return;
    this.visiblePumping = true;
    try {
      for (;;) {
        const t = this.nextVisible();
        if (!t) return;
        await this.refreshFrontRank(t);
      }
    } finally {
      this.visiblePumping = false;
    }
  }

  /** 下一个该刷的显示行：有链且 fomo 支持、非焦点、非在飞、没快照或快照 ≥45s；最旧优先。REST 退避中 / 未登录 / 已关 → 无 */
  private nextVisible(): FomoTracked | null {
    if (this.closed || !this.me || !this.visible.length || Date.now() < this.restBlockedUntil) return null;
    const focused = this.deps.focused()?.address ?? null;
    const tracked = this.deps.tracked();
    let best: FomoTracked | null = null;
    let bestAt = Infinity;
    for (const a of this.visible) {
      if (a === focused) continue;
      const t = tracked.find((x) => x.address === a);
      if (!t?.chain || CHAIN_TO_NETWORK[t.chain] === undefined) continue;
      const key = `${t.chain}:${t.address}`;
      if (this.frontInflight.has(key)) continue;
      const at = this.frontRank.get(key)?.at ?? 0;
      if (now() - at < FRONT_REFRESH_SEC) continue;
      if (at < bestAt) {
        best = t;
        bestAt = at;
      }
    }
    return best;
  }

  private async loadFollowing(): Promise<void> {
    const me = this.me;
    if (!me) return;
    const ids = await this.api<{ followingIds: string[] }>("/v2/users/current/followingIds");
    const users = new Map<string, { handle: string; avatar: string | null }>();
    let lastId: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.api<{ users: Array<{ id: string; userHandle?: string; profilePictureLink?: string | null }> }>(
        `/v2/users/${me.userId}/followingPaginate${lastId ? `?lastId=${encodeURIComponent(lastId)}` : ""}`,
      );
      if (!r?.users?.length) break;
      for (const u of r.users) users.set(u.id, { handle: u.userHandle ?? "?", avatar: u.profilePictureLink ?? null });
      if (r.users.length < 20) break;
      lastId = r.users[r.users.length - 1].id;
    }
    if (users.size) this.following = users;
    const n = ids?.followingIds?.length ?? null;
    if (n !== null && me.following !== n) {
      me.following = n;
      this.emitState();
    }
    console.error(`[fomo] following ids=${n ?? "?"} users=${users.size}`);
  }

  /** `GET /feed/tradingActivity` 从新往旧翻到 sinceTs（≤maxPages 页，见 BACKFILL_MAX_PAGES）；不传 threshold = 全部 */
  private async backfill(sinceTs: number, maxPages: number): Promise<void> {
    let lastId: string | undefined;
    let total = 0, matched = 0;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await new Promise((r) => setTimeout(r, BACKFILL_PAGE_GAP_MS));
      const r = await this.api<{ items: Array<Record<string, unknown>>; hasNextPage?: boolean }>(`/feed/tradingActivity?limit=50${lastId ? `&lastId=${encodeURIComponent(lastId)}` : ""}`);
      if (!r?.items?.length) break;
      let older = false;
      for (const it of r.items) {
        total++;
        const ts = Date.parse(String(it.createdAt ?? "")) / 1000;
        if (Number.isFinite(ts) && ts < sinceTs) {
          older = true;
          continue;
        }
        if (this.ingest(it, false)) matched++;
      }
      if (older || !r.hasNextPage) break;
      lastId = String(r.items[r.items.length - 1].id ?? "");
      if (!lastId) break;
    }
    console.error(`[fomo] backfill ${total} alerts (${matched} on tracked tokens)`);
  }

  // ---------- alert 归一化 / 归并 ----------

  /** 一条 alert → 0..n 行（multi_user_* 一人一行）；不认识的类型 / 链 → [] */
  private normalize(a: Record<string, unknown>): FomoActivityRow[] {
    const type = String(a.type ?? "");
    const address = normAddress(a.tokenAddress);
    const chain = NETWORK_TO_CHAIN[Number(a.networkId)];
    const ts = Math.floor(Date.parse(String(a.createdAt ?? "")) / 1000);
    if (!address || !chain || !Number.isFinite(ts)) return [];
    const handle = String(a.userHandle ?? a.displayName ?? "?");
    const userId = typeof a.userId === "string" ? a.userId : "";
    const avatar = typeof a.profilePictureLink === "string" && a.profilePictureLink ? a.profilePictureLink : (this.following.get(userId)?.avatar ?? null);
    const mc = num(a.fdv ?? a.marketCap);
    switch (type) {
      case "swap_buy":
      case "transfer_in":
        return [{ address, chain, handle, avatar, kind: "buy", usd: num(a.usdAmount), mc, ts, comment: null }];
      case "swap_sell":
      case "transfer_out":
        return [{ address, chain, handle, avatar, kind: "sell", usd: num(a.usdAmount), mc, ts, comment: null }];
      case "thesis": {
        const c = a.comment as { comment?: unknown } | undefined;
        const comment = typeof c?.comment === "string" && c.comment.trim() ? c.comment.trim() : null;
        if (!comment) return [];
        const trade = a.authorTrade as { usdValue?: unknown; humanTokenAmount?: unknown } | undefined;
        // usd 非空 = 作者持仓（authorTrade）→ view 里算买入人
        const usd = trade && (num(trade.humanTokenAmount) ?? 0) > 0 ? num(trade.usdValue) : null;
        return [{ address, chain, handle, avatar, kind: "thesis", usd, mc, ts, comment }];
      }
      case "multi_user_buy":
      case "multi_user_sell": {
        const body = (a.body ?? {}) as Record<string, unknown>;
        const bmc = num(body.fdv ?? body.marketCap) ?? mc;
        const kind = type === "multi_user_buy" ? "buy" : "sell";
        const users = (Array.isArray(body.users) ? body.users : Array.isArray(body.userHandles) ? body.userHandles : []) as unknown[];
        const rows: FomoActivityRow[] = [];
        for (const u of users) {
          if (typeof u === "string") rows.push({ address, chain, handle: u, avatar: null, kind, usd: null, mc: bmc, ts, comment: null });
          else if (u && typeof u === "object") {
            const o = u as Record<string, unknown>;
            const h = String(o.userHandle ?? o.displayName ?? "");
            if (!h) continue;
            const uid = typeof o.userId === "string" ? o.userId : typeof o.id === "string" ? o.id : "";
            rows.push({ address, chain, handle: h, avatar: typeof o.profilePictureLink === "string" ? o.profilePictureLink : (this.following.get(uid)?.avatar ?? null), kind, usd: num(o.usdAmount), mc: bmc, ts, comment: null });
          }
        }
        if (!rows.length && !this.multiShapeLogged) {
          this.multiShapeLogged = true;
          console.error(`[fomo] ${type} without user list; body keys: ${Object.keys(body).join(",")}`);
        }
        return rows;
      }
      default:
        return [];
    }
  }

  /** 归一化 → 进 recent；在列表里的进 activity + sqlite。返回是否命中列表里的币 */
  private ingest(a: Record<string, unknown>, live: boolean): boolean {
    const rows = this.normalize(a);
    if (!rows.length) return false;
    const tracked = new Map(this.deps.tracked().map((t) => [t.address, t.chain]));
    let hit = false;
    for (const r of rows) {
      this.lastAlertTs = Math.max(this.lastAlertTs, r.ts);
      this.remember(r);
      if (!tracked.has(r.address)) continue;
      const chain = tracked.get(r.address);
      if (chain && chain !== r.chain) continue;
      if (this.put(r, true)) {
        hit = true;
        if (live) console.error(`[fomo] ${r.handle} ${r.kind} ${String(a.ticker ?? r.address.slice(0, 10))}${r.usd !== null ? ` $${Math.round(r.usd)}` : ""} ${r.chain}`);
        this.onChange?.(r.address);
      }
    }
    return hit;
  }

  private remember(r: FomoActivityRow): void {
    const cutoff = now() - BACKFILL_WINDOW_SEC;
    if (r.ts < cutoff) return;
    if (this.recent.some((x) => x.address === r.address && x.handle === r.handle && x.ts === r.ts && x.kind === r.kind)) return;
    this.recent.push(r);
    if (this.recent.length > RECENT_MAX || this.recent.length % 100 === 0) {
      this.recent = this.recent.filter((x) => x.ts >= cutoff);
      if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
    }
  }

  /** 进 activity（按 ts 降序、主键去重、每币 ≤100）；persist=true 同时落库。返回是否新增 */
  private put(r: FomoActivityRow, persist: boolean): boolean {
    const list = this.activity.get(r.address) ?? [];
    if (list.some((x) => x.handle === r.handle && x.ts === r.ts && x.kind === r.kind)) return false;
    const at = list.findIndex((x) => x.ts < r.ts);
    list.splice(at === -1 ? list.length : at, 0, r);
    if (list.length > PER_TOKEN_MAX) list.length = PER_TOKEN_MAX;
    this.activity.set(r.address, list);
    if (persist) this.store.insertFomoActivity(r);
    return true;
  }

  // ---------- 持有人数 ----------

  private startHolders(): void {
    this.stopHolders();
    this.holdersTick = 0;
    this.holdersTimer = setInterval(() => void this.pollHolders(), HOLDERS_EVERY_MS);
    void this.pollHolders();
  }

  private stopHolders(): void {
    clearInterval(this.holdersTimer);
    this.holdersTimer = undefined;
  }

  /** 焦点币每 15s；全部（有链且 fomo 支持的）每 60s 一次批量 `POST /hodlers/friends` */
  private async pollHolders(): Promise<void> {
    if (!this.me) return;
    const all = this.holdersTick++ % HOLDERS_ALL_EVERY === 0;
    const focused = this.deps.focused();
    const targets = this.deps
      .tracked()
      .filter((t) => t.chain && CHAIN_TO_NETWORK[t.chain] !== undefined && (all || t.address === focused?.address))
      .slice(0, 80);
    // 不在追踪列表里的「当前持仓」弹卡：也要它的关注者持有人数 / 前排 / Thesis
    if (focused?.chain && CHAIN_TO_NETWORK[focused.chain] !== undefined && !targets.some((t) => t.address === focused.address)) targets.push(focused);
    // 焦点币顺带刷「fomo 前排比例」（fomo GET + gmgn 经 WK 各一次）；主面板显示行走串行队列（visibleChanged），这里只是踢一下
    const focusedTok = targets.find((t) => t.address === focused?.address);
    if (focusedTok) {
      void this.refreshFrontRank(focusedTok);
      this.thesisTick(focusedTok);
    }
    void this.pumpVisible();
    if (!targets.length) return;
    const r = await this.api<{ tokens: Array<{ tokenAddress?: string; networkId?: number; totalHolders?: unknown }> }>("/hodlers/friends", {
      method: "POST",
      body: { tokens: targets.map((t) => ({ address: t.address, networkId: CHAIN_TO_NETWORK[t.chain!] })), limit: 1 },
    });
    if (!r?.tokens) return;
    const got = new Map<string, number>();
    for (const t of r.tokens) {
      const n = num(t.totalHolders);
      if (t.tokenAddress && n !== null) got.set(normAddress(t.tokenAddress), n);
    }
    const at = now();
    for (const t of targets) {
      const n = got.get(t.address) ?? 0; // 响应里没有 = 没有关注者持有
      const prev = this.holders.get(t.address);
      this.holders.set(t.address, { n, at });
      if (prev?.n !== n) this.onChange?.(t.address);
    }
  }

  // ---------- fomo 前排比例 ----------

  /**
   * 焦点币的「fomo 前排比例」：同一轮并行拉 fomo `GET /hodlers/top`（全站前 50 名，服务端上限）与 gmgn `token_holders`（前 100 名，排除 pool 后取前 50），
   * 两侧都成功才出比例；任一侧失败整份快照标不可用（不拿旧的一半拼新的一半）。单飞：上一轮没回来不再发。
   * 登出 / 换号后回来的响应丢弃（快照按 chain+address 存，换焦点不丢——那还是该币的数据）。
   */
  private async refreshFrontRank(t: FomoTracked): Promise<void> {
    const me = this.me;
    const net = CHAIN_TO_NETWORK[t.chain!];
    if (!me || net === undefined) return;
    const key = `${t.chain}:${t.address}`;
    if (this.frontInflight.has(key)) return;
    this.frontInflight.add(key);
    try {
      const q = encodeURIComponent(JSON.stringify([{ address: t.address, networkId: net }]));
      const [fomo, gmgn] = await Promise.allSettled([this.api<unknown[]>(`/hodlers/top?tokens=${q}`), this.deps.gmgnTopHolders(t.address, t.chain!)]);
      if (this.closed || this.me !== me) return;
      const env = fomo.status === "fulfilled" ? fomo.value : null;
      const gm = gmgn.status === "fulfilled" ? gmgn.value : gmgn.reason instanceof Error ? gmgn.reason : new Error(String(gmgn.reason));
      const snap = frontRank({ address: t.address, networkId: net }, env === null ? null : Array.isArray(env) ? env[0] : undefined, gm, now());
      const prev = this.frontRank.get(key);
      this.frontRank.set(key, snap);
      if (snap.why && snap.why !== prev?.why) console.error(`[fomo] front rank ${this.deps.symbolOf(t.address) ?? t.address.slice(0, 10)}: ${snap.why}`);
      // 每份完成的快照都推（15s 一次有界）：金额 / 计数 / 时间也是契约的一部分，只比 ratio 会让 Swift 拿着过期的快照
      this.onChange?.(t.address);
    } finally {
      this.frontInflight.delete(key);
    }
  }

  // ---------- WS ----------

  private connectWs(): void {
    if (this.closed || !this.me || this.ws || this.wsConnecting) return;
    this.wsConnecting = true;
    void (async () => {
      const via = await proxyAgent();
      this.wsConnecting = false;
      if (this.closed || !this.me || this.ws) return;
      const ws = new WebSocket(this.deps.wsUrl ?? WS_URL, { headers: { Origin: ORIGIN, "User-Agent": UA }, agent: via?.agent, handshakeTimeout: 15_000 });
      this.ws = ws;
      this.wsError = "";
      ws.on("open", () => {
        if (this.ws !== ws) return;
        const reconnect = this.wsEverConnected;
        this.wsEverConnected = true;
        this.wsBackoff = 0;
        this.wsLastLog = "";
        console.error(`[fomo-ws] connected${via ? ` via ${via.proxy.host}:${via.proxy.port}` : ""}`);
        // 断线期间漏掉的用 REST 补一页
        if (reconnect) void this.backfill(this.lastAlertTs || now() - 3600, 2);
      });
      ws.on("message", (m) => void this.onWsMessage(ws, m.toString()));
      ws.on("error", (e: NodeJS.ErrnoException) => {
        if (this.ws === ws) this.wsError = e.message || e.code || String(e);
      });
      ws.on("close", (code) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.closed || !this.me) return;
        this.scheduleWs(code);
      });
    })();
  }

  private scheduleWs(code: number): void {
    this.wsBackoff = this.wsBackoff ? Math.min(this.wsBackoff * 2, WS_BACKOFF_MAX) : WS_BACKOFF_MIN;
    const line = `closed ${code}${this.wsError ? ` (${this.wsError})` : ""}; retry in ${this.wsBackoff}ms`;
    if (line !== this.wsLastLog) {
      this.wsLastLog = line;
      console.error(`[fomo-ws] ${line}`);
    }
    clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => {
      this.wsTimer = undefined;
      this.connectWs();
    }, this.wsBackoff);
  }

  private closeWs(): void {
    clearTimeout(this.wsTimer);
    this.wsTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private async onWsMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: { type?: string; topicType?: string; topicId?: string; payload?: Record<string, unknown>; code?: unknown; message?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (this.ws !== ws || !this.me) return;
    switch (msg.type) {
      case "challenge": {
        const jwt = await this.token();
        if (this.ws !== ws) return;
        if (!jwt) {
          console.error("[fomo-ws] challenge but no token; closing");
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "challengeResponse", jwt }));
        return;
      }
      case "challengeAccepted":
        ws.send(JSON.stringify({ type: "subscribe", topicType: "trading_activity", topicId: this.me.userId }));
        return;
      case "subscribed":
        console.error(`[fomo-ws] subscribed ${msg.topicType}:${msg.topicId}`);
        return;
      case "data":
        if (msg.topicType === "trading_activity" && msg.payload) this.ingest(msg.payload, true);
        return;
      case "error":
        console.error(`[fomo-ws] error ${String(msg.code ?? "")} ${String(msg.message ?? "")}`);
        return;
      default:
        return;
    }
  }
}
