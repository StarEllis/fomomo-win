import type { Bridge } from "./rpc.js";
import type { Ath, GmgnCall, Links, Market, Tweet, TwitterUser } from "./types.js";

/** mutil_window_token_info 单次上限：11 个即 400 P_GMGN_WEB_INVALID_ARGUMENT（2026-09 实测） */
export const GMGN_BATCH = 10;

function positive(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const AGO_KEYS: Array<[string, number]> = [
  ["price_1m", 60],
  ["price_5m", 300],
  ["price_1h", 3600],
  ["price_6h", 21600],
  ["price_24h", 86400],
];

type Item = {
  address?: string;
  symbol?: string;
  name?: string;
  logo?: string;
  holder_count?: number;
  liquidity?: string;
  market_cap?: unknown;
  circulating_supply?: string;
  total_supply?: string;
  price?: Record<string, unknown> & { address?: string };
};

/**
 * gmgn 响应 → Market。字段名对着真实响应写（$TMPDIR/fomomo_gmgn_sample.json）：
 * - 顶层：symbol / name / holder_count / liquidity(String USD) / circulating_supply / total_supply；`market_cap` 恒 null
 * - price：price(String) + 历史价 price_1m/5m/1h/6h/24h（没有 percent 字段，涨跌自己算）
 * - 未收录地址返回空壳（symbol "" / price "0"），全部归 undefined 以免覆盖 DexScreener 基线
 */
function fromGmgn(it: Item, chain: string): Market {
  const p = it.price ?? {};
  const price = positive(p.price);
  const change = (key: string): number | undefined => {
    const old = positive(p[key]);
    return price !== undefined && old !== undefined ? (price / old - 1) * 100 : undefined;
  };
  const supply = positive(it.circulating_supply) ?? positive(it.total_supply);
  const priceAgo: Record<number, number> = {};
  for (const [k, sec] of AGO_KEYS) {
    const v = positive(p[k]);
    if (v !== undefined) priceAgo[sec] = v;
  }
  return {
    symbol: it.symbol || undefined,
    name: it.name || undefined,
    logo: it.logo || undefined,
    chain,
    price,
    mc: positive(it.market_cap) ?? (price !== undefined && supply !== undefined ? price * supply : undefined),
    liq: positive(it.liquidity),
    change5m: change("price_5m"),
    change1h: change("price_1h"),
    change24h: change("price_24h"),
    holders: positive(it.holder_count),
    priceAgo,
    source: "gmgn",
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

export class GmgnError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

/** gmgn 响应通用解析：非 200 / 非 JSON / code≠0 → GmgnError，否则返回 `data` */
async function gmgnJson<T>(bridge: Bridge, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const res = await bridge.gmgnFetch({ path, method, body });
  if (res.status !== 200) throw new GmgnError(res.status, `http ${res.status}`);
  let obj: { code?: number; data?: T; message?: string };
  try {
    obj = JSON.parse(res.body);
  } catch {
    throw new GmgnError(res.status, "non-json body");
  }
  if (obj.code !== 0) throw new GmgnError(res.status, `code=${obj.code} ${obj.message ?? ""}`);
  return obj.data as T;
}

/** POST /api/v1/mutil_window_token_info（≤GMGN_BATCH 地址，同链）→ 按地址（小写）归一的 Market */
export async function tokenInfo(bridge: Bridge, chain: string, addresses: string[]): Promise<Map<string, Market>> {
  const data = await gmgnJson<Item[] | null>(bridge, "/api/v1/mutil_window_token_info", "POST", { chain, addresses });
  if (!Array.isArray(data)) throw new GmgnError(200, "mutil_window_token_info: no list");
  const out = new Map<string, Market>();
  for (const it of data) {
    const a = (it.address ?? it.price?.address)?.toLowerCase();
    if (!a) continue;
    const m = fromGmgn(it, chain);
    if (m.price === undefined && m.symbol === undefined) continue; // 空壳
    out.set(a, m);
  }
  return out;
}

export interface Candle {
  time: number; // unix 秒（蜡烛起点）
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** 分辨率 → 蜡烛秒数（gmgn token_candles 实测接受：1s 5s 15s 30s 1m 3m 5m 15m 30m 1h 4h 12h 1d；2h/6h 报 invalid resolution） */
export const RESOLUTION_SEC: Record<string, number> = {
  "1s": 1, "5s": 5, "15s": 15, "30s": 30,
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400,
};

/**
 * GET /api/v1/token_candles/{chain}/{addr}?pool_type=tpool&resolution=1m&from=<ms>&to=<ms>
 * 价格蜡烛（USD）；`kind="mcap"` 走同参数同结构的 `token_mcap_candles`，返回市值蜡烛（弹卡 K 线用）。
 * 2026-09 实测：robinhood 有数据；from/to 必须是毫秒（秒会返回空）；单次最多约 100 根。
 * 注意响应里的 `_debug_tpool_desc: "chain not support"` 是调试字段，不代表没数据。
 */
export async function candles(bridge: Bridge, chain: string, address: string, fromSec: number, toSec: number, resolution: string, kind: "price" | "mcap" = "price"): Promise<Candle[]> {
  const ep = kind === "mcap" ? "token_mcap_candles" : "token_candles";
  const path = `/api/v1/${ep}/${chain}/${address}?pool_type=tpool&resolution=${resolution}&from=${fromSec * 1000}&to=${toSec * 1000}`;
  const data = await gmgnJson<{ list?: Array<Record<string, unknown>> } | null>(bridge, path, "GET");
  const out: Candle[] = [];
  for (const c of data?.list ?? []) {
    const time = typeof c.time === "number" ? Math.floor(c.time / 1000) : NaN;
    const open = positive(c.open);
    const close = positive(c.close);
    if (!Number.isFinite(time) || open === undefined || close === undefined) continue;
    out.push({ time, open, close, high: positive(c.high) ?? Math.max(open, close), low: positive(c.low) ?? Math.min(open, close), volume: positive(c.volume) ?? 0 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** gmgn 前排持有人一行（`/vas/api/v1/token_holders`）：数量是人类单位；`addrType` 0 钱包（含带 name 的交易所钱包）/ 1 燃烧 / 2 pool */
export interface GmgnHolder {
  address: string;
  amount: number;
  addrType: number;
}

/** 持仓数量的严格解析：有限数字或非空数字字串；null / 布尔 / 空白 / NaN / 负数 → null（缺数据不能变 0） */
export function strictAmount(v: unknown): number | null {
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    v = Number(v);
  }
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 服务端 limit 上限（>100 会退回默认 20 行）。响应带 `next` 游标，但 gmgn 前端没有任何 caller 翻页，作为 `cursor`/`next`/`after` 传回都被忽略 → 续页契约未知，前 100 名即可达上限 */
export const GMGN_HOLDERS_LIMIT = 100;

export interface GmgnHoldersPage {
  rows: GmgnHolder[];
  /** 服务端是否声明还有更多行：`next` 非空字串 → true；`next` 为 null / 空串 → false；字段缺失或类型不对 → null（未知，不能当取尽） */
  more: boolean | null;
}

/**
 * GET /vas/api/v1/token_holders/{chain}/{address}?limit=100&orderby=amount_percentage&direction=desc（gmgn 代币页 Holders 列表 / 图上 top holder 线同一调用）。
 * 每行必须有有限的 `balance` 和整数 `addr_type`，缺一行就整体抛错——不把没标记的行当普通钱包（口径：docs/adr/0007）。
 * 续页信息按 `more` 三态带回（见 GmgnHoldersPage）。
 */
export async function topHolders(bridge: Bridge, chain: string, address: string): Promise<GmgnHoldersPage> {
  const data = await gmgnJson<{ list?: unknown; next?: unknown } | null>(bridge, `/vas/api/v1/token_holders/${chain}/${address}?limit=${GMGN_HOLDERS_LIMIT}&orderby=amount_percentage&direction=desc`, "GET");
  if (!Array.isArray(data?.list)) throw new GmgnError(200, "token_holders: no list");
  const rows: GmgnHolder[] = [];
  for (const [i, it] of data.list.entries()) {
    const address = typeof it === "object" && it && "address" in it ? it.address : undefined;
    const amount = typeof it === "object" && it && "balance" in it ? strictAmount(it.balance) : null;
    const addrType = typeof it === "object" && it && "addr_type" in it ? it.addr_type : undefined;
    if (typeof address !== "string" || amount === null || typeof addrType !== "number" || !Number.isInteger(addrType)) {
      throw new GmgnError(200, `token_holders: row ${i} missing balance/addr_type`);
    }
    rows.push({ address, amount, addrType });
  }
  const next = data.next;
  return { rows, more: next === null || next === "" ? false : typeof next === "string" ? true : null };
}

type FullInfo = {
  address?: string;
  link?: { twitter_username?: string; website?: string; telegram?: string };
  ath_price?: unknown;
  ath_market_cap?: unknown;
  ath_ts?: unknown;
};

/**
 * POST /mrwapi/v1/multi_token_full_info：社交链接 + ATH。
 * `link.twitter_username` 可能是用户名（`HuggingFaceXYZ`）也可能是推文路径（`user/status/123`），统一拼成 x.com URL。
 */
export async function fullInfo(bridge: Bridge, chain: string, addresses: string[]): Promise<Map<string, { links: Links; ath: Ath | null }>> {
  const data = (await gmgnJson<FullInfo[] | null>(bridge, "/mrwapi/v1/multi_token_full_info", "POST", { chain, addresses })) ?? [];
  const out = new Map<string, { links: Links; ath: Ath | null }>();
  for (const d of data) {
    const a = d.address?.toLowerCase();
    if (!a) continue;
    const links: Links = {};
    const tw = d.link?.twitter_username?.trim();
    if (tw) links.twitter = /^https?:/.test(tw) ? tw : `https://x.com/${tw.replace(/^@/, "")}`;
    if (d.link?.website) links.website = d.link.website;
    if (d.link?.telegram) links.telegram = /^https?:/.test(d.link.telegram) ? d.link.telegram : `https://t.me/${d.link.telegram.replace(/^@/, "")}`;
    const price = positive(d.ath_price);
    const mc = positive(d.ath_market_cap);
    const ts = positive(d.ath_ts);
    out.set(a, { links, ath: price !== undefined && mc !== undefined && ts !== undefined ? { price, mc, time: ts } : null });
  }
  return out;
}

type TwUser = { name?: string; screen_name?: string; avatar?: string; followers?: number; verified?: boolean; description?: string; joined_at?: number };

type TwContent = { text?: string; media?: Array<{ type?: string; url?: string }> };
type TwMetrics = { likes?: number; quotes?: number; replies?: number; retweets?: number; views?: number };

/** token/search 与 link_preview 共用的推文结构；`source_*` = 引用/回复的原推（tw_type=quote/reply 时有） */
type TweetItem = {
  id?: string;
  tweet_id?: string;
  tw_type?: string;
  tw_timestamp?: string | number;
  user?: TwUser;
  content?: TwContent;
  tweet_metrics?: TwMetrics;
  source_id?: string;
  source_tw_timestamp?: string | number;
  source_user?: TwUser;
  source_content?: TwContent;
  source_tweet_metrics?: TwMetrics;
};

function toUser(u: TwUser | undefined, screen: string): TwitterUser {
  const joined = Number(u?.joined_at ?? 0);
  return {
    name: u?.name ?? screen,
    screen,
    avatar: u?.avatar ?? "",
    followers: u?.followers ?? 0,
    verified: u?.verified === true,
    bio: u?.description || undefined,
    joined: joined > 1e12 ? Math.floor(joined / 1000) : joined || undefined,
  };
}

/** gmgn 时间戳有毫秒字符串也有秒 → 秒 */
function toSec(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

/** `source_*` → 被引用的原推；没有作者/正文就当没引用。译文由 translate.ts 之后补 */
function quotedOf(it: TweetItem): Tweet | null {
  const screen = it.source_user?.screen_name;
  const text = it.source_content?.text?.trim();
  if (!screen || !text) return null;
  const id = it.source_id ?? "";
  return {
    id,
    url: id ? `https://x.com/${screen}/status/${id}` : `https://x.com/${screen}`,
    time: toSec(it.source_tw_timestamp),
    kind: "tweet",
    user: toUser(it.source_user, screen),
    text,
    likes: it.source_tweet_metrics?.likes,
    image: it.source_content?.media?.find((m) => m.type === "image")?.url,
    translation: null,
    quoted: null,
  };
}

function toTweet(it: TweetItem, fallbackId?: string): Tweet | null {
  const id = it.tweet_id ?? fallbackId;
  const screen = it.user?.screen_name;
  const text = it.content?.text?.trim();
  if (!id || !screen || !text) return null;
  return {
    id,
    url: `https://x.com/${screen}/status/${id}`,
    time: toSec(it.tw_timestamp),
    kind: it.tw_type ?? "tweet",
    user: toUser(it.user, screen),
    text,
    likes: it.tweet_metrics?.likes,
    image: it.content?.media?.find((m) => m.type === "image")?.url,
    translation: null,
    quoted: quotedOf(it),
  };
}

/** GET /vas/api/v1/twitter/token/search?keyword=<地址>：提到该代币的推文，按粉丝数降序 */
export async function tweets(bridge: Bridge, address: string, limit: number): Promise<Tweet[]> {
  const data = (await gmgnJson<TweetItem[] | null>(bridge, `/vas/api/v1/twitter/token/search?keyword=${address}&limit=${limit}`, "GET")) ?? [];
  const out: Tweet[] = [];
  for (const it of data) {
    const tw = toTweet(it);
    if (tw) out.push(tw);
  }
  out.sort((a, b) => b.user.followers - a.user.followers);
  return out;
}

const GMGN_CALLS_PAGE = 50;

export interface GmgnCallsPage {
  items: GmgnCall[];
  hasMore: boolean;
  /** 下一页游标（base64 keyset）；has_more 为 false 时 null */
  next: string | null;
}

type CommunityMessage = {
  id?: unknown;
  ulid?: unknown;
  content?: unknown;
  display_content?: unknown;
  media_url?: unknown;
  username?: unknown;
  display_name?: unknown;
  profile_image_url?: unknown;
  wallet_address?: unknown;
  user_twitter_url?: unknown;
  follower_count?: unknown;
  like_count?: unknown;
  reply_count?: unknown;
  created_at?: unknown;
  multiplier?: unknown;
  is_blue_verified?: unknown;
  is_kol?: unknown;
  callback_to_ulid?: unknown;
};

/** 一条 community message → GmgnCall；内容可为空但必须有附件；身份可由 username/display_name/wallet 短地址兜底 */
function toGmgnCall(raw: unknown): GmgnCall | null {
  const m = raw as CommunityMessage | null;
  if (!m || typeof m !== "object") return null;
  const id = typeof m.ulid === "string" && m.ulid ? m.ulid : typeof m.id === "string" && m.id ? m.id : null;
  const rawHandle = typeof m.username === "string" ? m.username.trim() : "";
  const display = typeof m.display_name === "string" ? m.display_name.trim() : "";
  const wallet = typeof m.wallet_address === "string" ? m.wallet_address.trim() : "";
  const handle = rawHandle || display || (wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : null);
  const text = typeof m.display_content === "string" && m.display_content.trim() ? m.display_content.trim() : typeof m.content === "string" ? m.content.trim() : "";
  const image = typeof m.media_url === "string" && m.media_url.trim() ? m.media_url.trim() : null;
  const ts = Math.floor(Date.parse(String(m.created_at)) / 1000);
  if (!id || !handle || (!text && !image) || !Number.isFinite(ts)) return null;
  const mult = typeof m.multiplier === "string" || typeof m.multiplier === "number" ? Number(m.multiplier) : NaN;
  return {
    id,
    handle,
    name: display || handle,
    url: typeof m.user_twitter_url === "string" && m.user_twitter_url ? m.user_twitter_url : null,
    avatar: typeof m.profile_image_url === "string" && m.profile_image_url ? m.profile_image_url : null,
    followers: positive(m.follower_count) ?? 0,
    verified: m.is_blue_verified === true,
    kol: m.is_kol === true,
    ts,
    text,
    image,
    likes: positive(m.like_count) ?? 0,
    replies: positive(m.reply_count) ?? 0,
    multiplier: Number.isFinite(mult) && mult > 0 ? mult : null,
    replyTo: typeof m.callback_to_ulid === "string" && m.callback_to_ulid ? m.callback_to_ulid : null,
  };
}

function sameTokenAddress(a: unknown, want: string): boolean {
  if (typeof a !== "string" || !a) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(want) ? a.toLowerCase() === want.toLowerCase() : a === want;
}

function communityInvalid(message: string): never {
  throw new GmgnError(200, `invalid community feed: ${message}`);
}

function validateCommunityMeta(data: Record<string, unknown>, chain: string, address: string): void {
  if (typeof data.has_more !== "boolean") communityInvalid("has_more must be boolean");
  const next = data.next_cursor;
  if (data.has_more && (typeof next !== "string" || !next)) communityInvalid("has_more requires next_cursor");
  const community = data.community;
  if (community && typeof community === "object" && "token_address" in community && !sameTokenAddress((community as Record<string, unknown>).token_address, address)) communityInvalid("token identity mismatch");
  if (typeof data.chain === "string" && data.chain !== chain) communityInvalid("chain mismatch");
}

/**
 * GET /api/v1/token/{chain}/{addr}/community/messages?limit=50[&cursor=<next_cursor>]
 */
export async function communityMessages(bridge: Bridge, chain: string, address: string, cursor: string | null): Promise<GmgnCallsPage> {
  const q = `limit=${GMGN_CALLS_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const data = await gmgnJson<Record<string, unknown> | null>(bridge, `/api/v1/token/${chain}/${address}/community/messages?${q}`, "GET");
  if (!data || !Array.isArray(data.messages)) communityInvalid("messages must be an array");
  validateCommunityMeta(data, chain, address);
  const next = typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : null;
  if (data.has_more && next === cursor) communityInvalid("cursor did not advance");
  const items: GmgnCall[] = [];
  for (const m of data.messages) {
    const c = toGmgnCall(m);
    if (!c) communityInvalid("malformed message row");
    items.push(c);
  }
  return { items, hasMore: data.has_more as boolean, next: data.has_more ? next : null };
}

type ProfileItem = {
  screen_name?: string;
  name?: string;
  description?: string;
  profile_image_url?: string;
  followers_count?: number;
  following_count?: number;
  is_blue_verified?: boolean;
  joined_at?: number;
  profile_banner?: string;
  profile_location?: string;
};

/**
 * GET /api/v1/twitter/user_profile?username=&chain=&token_address=&source=token
 * gmgn 悬停 X 图标那张卡的账号资料（不需要登录 X）
 */
export async function userProfile(bridge: Bridge, screen: string, chain: string, token: string): Promise<TwitterUser | null> {
  const d = await gmgnJson<ProfileItem | null>(
    bridge,
    `/api/v1/twitter/user_profile?username=${encodeURIComponent(screen)}&chain=${chain}&token_address=${token}&source=token`,
    "GET",
  );
  if (!d?.screen_name) return null;
  const joined = Number(d.joined_at ?? 0);
  return {
    name: d.name ?? d.screen_name,
    screen: d.screen_name,
    avatar: d.profile_image_url ?? "",
    followers: d.followers_count ?? 0,
    verified: d.is_blue_verified === true,
    bio: d.description || undefined,
    joined: joined > 1e12 ? Math.floor(joined / 1000) : joined || undefined,
    following: d.following_count,
    location: d.profile_location || undefined,
    banner: d.profile_banner || undefined,
  };
}

/**
 * GET /vas/api/v1/twitter/link_preview/{chain}/{token}/{tweet_id}?source=token
 * 资料里 X 链接指向的那条推文（正文、图、作者、tweet_metrics；tw_type=quote 时 `source_*` 是被引用的原推 → `quoted`）
 */
export async function linkPreview(bridge: Bridge, chain: string, token: string, tweetId: string): Promise<Tweet | null> {
  const it = await gmgnJson<TweetItem | null>(bridge, `/vas/api/v1/twitter/link_preview/${chain}/${token}/${tweetId}?source=token`, "GET");
  return it ? toTweet(it, tweetId) : null;
}
