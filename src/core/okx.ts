import { requestJson, type JsonResponse } from "./proxy.js";
import type { TradeChain } from "./types.js";

/**
 * OKX Onchain OS Trade API（v6 aggregator）薄客户端。请求统一发到 fomomo 的 OKX 接口端点（`OKX_API_BASE`，固定、不可配置）：
 * 客户端不持有任何 OKX 凭据、不签名 HMAC；四个 GET + 错误码归类 + 实例内串行限速；只产出 calldata / base58 交易，不签名不广播（那是 wallet.ts 的事）。
 * 参数名 / 错误码以 OKX 官方文档为准；不猜文档没写的字段。
 */
export type { TradeChain };
export const TRADE_CHAINS: readonly TradeChain[] = ["eth", "bsc", "base", "monad", "robinhood", "sol"];
const OKX_CHAIN_INDEX: Record<TradeChain, string> = { eth: "1", bsc: "56", base: "8453", monad: "143", robinhood: "4663", sol: "501" };
const EVM_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const NATIVE_TOKEN: Record<TradeChain, string> = { eth: EVM_NATIVE, bsc: EVM_NATIVE, base: EVM_NATIVE, monad: EVM_NATIVE, robinhood: EVM_NATIVE, sol: "11111111111111111111111111111111" };

/** 唯一的 OKX 出口。改地址 = 改这里发新客户端 */
export const OKX_API_BASE = "https://fomomo-okx-proxy.boxchen.workers.dev";

export type OkxErrorKind = "auth" | "rate-limit" | "params" | "liquidity" | "price-impact" | "fee-unsupported" | "fee-service" | "unsupported" | "network" | "api";
export class OkxError extends Error {
  readonly kind: OkxErrorKind;
  readonly code: string | null;
  readonly httpStatus: number | null;
  constructor(kind: OkxErrorKind, message: string, code: string | null, httpStatus: number | null) {
    super(message);
    this.name = "OkxError";
    this.kind = kind;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface EvmTx { to: `0x${string}`; data: `0x${string}`; value: bigint; gas: bigint; gasPrice: bigint; maxPriorityFeePerGas: bigint | null }
export interface TokenInfo {
  symbol: string;
  decimals: number;
  isHoneyPot: boolean | null;
  taxRate: number | null;
  /** OKX 给的美元单价（`tokenUnitPrice`）；原生币的这一项就是我们换算 USD→数量用的价 */
  unitPriceUsd: number | null;
}
export interface RouteInfo {
  toTokenAmount: bigint;
  priceImpactPercent: number | null;
  estimateGasFee: bigint | null;
  fromToken: TokenInfo;
  toToken: TokenInfo;
  dexNames: string[];
}
export interface QuoteRequest { chain: TradeChain; fromToken: string; toToken: string; amountRaw: bigint; priceImpactProtectionPercent?: number }
export interface SwapRequest extends QuoteRequest {
  userWalletAddress: string;
}
export interface SwapResult {
  route: RouteInfo;
  /** 实际生效的滑点：autoSlippage 时以响应 tx.slippagePercent 为准，缺失退请求的兜底 0.5 */
  slippagePercent: string;
  evm: { tx: EvmTx } | null;
  sol: { txBase58: string } | null;
}
export interface OkxClientOptions {
  /** 默认 OKX_API_BASE；只给测试用 */
  baseUrl?: string;
  /** 实例内串行 + 最小间隔；默认 600ms（接口侧多人共享配额） */
  minIntervalMs?: number;
  /** 撞 50011 限流后等多久再重试一次（四个接口都是幂等 GET）；默认 1500，测试可设 0 */
  rateLimitRetryMs?: number;
  request?: typeof requestJson;
  now?: () => Date;
}

/** 同实例串行、最小间隔 100ms：只防同一用户连点把请求叠在一起；共享配额的 RPS 由接口侧处理（撞 50011 等 1.5s 重试一次） */
const INTERVAL_MS = 100;
const RATE_LIMIT_RETRY_MS = 1500;
const TIMEOUT_MS = 15_000;
const PATH = "/api/v6/dex/aggregator";

/** 错误码 → 类别（按 OKX 文档错误码表；82xxx 走 HTTP 200，只能看 body.code） */
function classify(code: string, status: number): OkxErrorKind {
  if (code === "50011") return "rate-limit";
  if (/^501[01]\d$/.test(code)) return "auth";
  if (code === "51000" || code === "50014") return "params";
  if (code === "82000") return "liquidity";
  if (code === "82112") return "price-impact";
  if (code === "82004" || code === "82005") return "fee-unsupported";
  if (code === "82001") return "fee-service";
  if (code === "82104" || code === "82105") return "unsupported";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  return "api";
}

type Params = Record<string, string>;

export class OkxClient {
  private readonly opts: OkxClientOptions;
  private readonly request: typeof requestJson;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  /** 下一次允许发出的时刻：调用顺序分配发送槽（间隔 minIntervalMs），响应可以重叠——旧报价还没回来不挡新报价（2026-09-11 前是等上一个响应再发） */
  private nextSlot = 0;

  constructor(opts: OkxClientOptions = {}) {
    this.opts = opts;
    this.request = opts.request ?? requestJson;
    this.now = opts.now ?? (() => new Date());
    this.baseUrl = (opts.baseUrl ?? OKX_API_BASE).replace(/\/+$/, "");
    this.minIntervalMs = opts.minIntervalMs ?? INTERVAL_MS;
  }

  async quote(q: QuoteRequest): Promise<RouteInfo> {
    const params: Params = { chainIndex: OKX_CHAIN_INDEX[q.chain], amount: q.amountRaw.toString(), fromTokenAddress: q.fromToken, toTokenAddress: q.toToken, swapMode: "exactIn" };
    if (q.priceImpactProtectionPercent !== undefined) params.priceImpactProtectionPercent = String(q.priceImpactProtectionPercent);
    return parseRoute(await this.get(`${PATH}/quote`, params));
  }

  /** 固定 autoSlippage（≤15%，兜底 0.5）、gasLevel fast */
  async swap(s: SwapRequest): Promise<SwapResult> {
    const params: Params = {
      chainIndex: OKX_CHAIN_INDEX[s.chain],
      amount: s.amountRaw.toString(),
      fromTokenAddress: s.fromToken,
      toTokenAddress: s.toToken,
      swapMode: "exactIn",
      userWalletAddress: s.userWalletAddress,
      slippagePercent: "0.5",
      autoSlippage: "true",
      maxAutoSlippagePercent: "15",
      gasLevel: "fast",
    };
    if (s.priceImpactProtectionPercent !== undefined) params.priceImpactProtectionPercent = String(s.priceImpactProtectionPercent);
    const data = await this.get(`${PATH}/swap`, params);
    const route = parseRoute(at(data, "routerResult"));
    const tx = at(data, "tx");
    const base = { route, slippagePercent: str(at(tx, "slippagePercent")) ?? params.slippagePercent };
    if (s.chain === "sol") {
      const txBase58 = str(at(tx, "data"));
      if (!txBase58) throw new OkxError("api", "swap 响应缺 tx.data（Solana 交易）", null, 200);
      return { ...base, evm: null, sol: { txBase58 } };
    }
    const to = hex(at(tx, "to"));
    const data0 = hex(at(tx, "data"));
    const gas = toBigInt(at(tx, "gas"));
    const gasPrice = toBigInt(at(tx, "gasPrice"));
    if (!to || !data0 || gas === null || gasPrice === null) throw new OkxError("api", "swap 响应 tx 缺 to/data/gas/gasPrice", null, 200);
    return { ...base, evm: { tx: { to, data: data0, value: toBigInt(at(tx, "value")) ?? 0n, gas, gasPrice, maxPriorityFeePerGas: toBigInt(at(tx, "maxPriorityFeePerGas")) } }, sol: null };
  }

  async approveTransaction(chain: TradeChain, tokenAddress: string, amountRaw: bigint): Promise<{ to: `0x${string}`; data: `0x${string}`; spender: `0x${string}`; gasLimit: bigint | null; gasPrice: bigint | null }> {
    const data = await this.get(`${PATH}/approve-transaction`, { chainIndex: OKX_CHAIN_INDEX[chain], tokenContractAddress: tokenAddress, approveAmount: amountRaw.toString() });
    // approve 交易的 to 就是被授权的代币合约本身；spender 是 OKX 授权合约（以响应为准，不硬编码）
    const to = hex(tokenAddress);
    const calldata = hex(at(data, "data"));
    const spender = hex(at(data, "dexContractAddress"));
    if (!to || !calldata || !spender) throw new OkxError("api", "approve-transaction 响应缺 data/dexContractAddress", null, 200);
    return { to, data: calldata, spender, gasLimit: toBigInt(at(data, "gasLimit")), gasPrice: toBigInt(at(data, "gasPrice")) };
  }

  async supportedChain(chain: TradeChain): Promise<{ chainName: string; dexTokenApproveAddress: string | null }> {
    const data = await this.get(`${PATH}/supported/chain`, { chainIndex: OKX_CHAIN_INDEX[chain] });
    return { chainName: str(at(data, "chainName")) ?? chain, dexTokenApproveAddress: str(at(data, "dexTokenApproveAddress")) };
  }

  /**
   * 预热到接口端点的 TLS 连接（弹卡打开时调）：打一个不存在的路径，端点直接回 404、不碰 OKX，零配额；
   * 之后用户点数额时 socket 已在（proxy.ts directAgent 保活 2 分钟），省掉 ~0.22s 握手。并发发两条 → 池里两个 socket，
   * 连点瓦片时第二条报价（旧的还没回）也不用新开连接。不占发送槽、失败静默
   */
  warm(): void {
    for (let i = 0; i < 2; i++) void this.request(`${this.baseUrl}/warm`, { method: "GET", timeoutMs: TIMEOUT_MS }).catch(() => undefined);
  }

  /** 占一个发送槽 → 发 GET → 校验 body.code → 返回 data[0]；限流只重试一次（重试也占槽），仍限流就抛给调用方 */
  private async get(path: string, params: Params): Promise<unknown> {
    try {
      return await this.send(path, params);
    } catch (e) {
      if (!(e instanceof OkxError && e.kind === "rate-limit")) throw e;
      const retryMs = this.opts.rateLimitRetryMs ?? RATE_LIMIT_RETRY_MS;
      // 留痕：限流重试是报价突然慢 1.5s 的唯一「静默」原因，日志里要看得见
      console.error(`[okx] ${path.slice(PATH.length + 1)} 限流（${e.message}），${retryMs}ms 后重试一次`);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, retryMs);
      await promise;
      return this.send(path, params);
    }
  }

  /** 同步占槽：多个并发调用按到达顺序拿到递增的时刻，保证任意两次发送间隔 ≥ minIntervalMs */
  private takeSlot(): number {
    const now = this.now().getTime();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.minIntervalMs;
    return at - now;
  }

  private async send(path: string, params: Params): Promise<unknown> {
    const wait = this.takeSlot();
    if (wait > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
    }
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
    let res: JsonResponse;
    try {
      res = await this.request(url, { method: "GET", timeoutMs: TIMEOUT_MS });
    } catch (e) {
      throw new OkxError("network", `OKX 请求失败: ${e instanceof Error ? e.message : String(e)}`, null, null);
    }
    if (res.status === 0) throw new OkxError("network", "OKX 请求超时或网络错误", null, null);
    if (res.json === null || typeof res.json !== "object") {
      // 非 JSON（挑战页/空 body）：401/429 仍能靠状态码归类，其余算网络层问题
      const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate-limit" : "network";
      throw new OkxError(kind, `OKX 返回非 JSON（HTTP ${res.status}）`, null, res.status);
    }
    const code = str(at(res.json, "code"));
    const msg = str(at(res.json, "msg")) ?? "";
    if (res.status !== 200 || code !== "0") {
      const c = code ?? "";
      throw new OkxError(classify(c, res.status), `OKX ${c || "HTTP " + res.status}: ${msg || "请求失败"}`, code, res.status);
    }
    const data = at(res.json, "data");
    return Array.isArray(data) ? data[0] : data;
  }
}

/** quote 的 data[0] 或 swap 的 routerResult → RouteInfo；缺字段给 null，不猜 */
function parseRoute(v: unknown): RouteInfo {
  const dexNames: string[] = [];
  const routers = at(v, "dexRouterList");
  if (Array.isArray(routers)) {
    for (const r of routers) {
      const subs = at(r, "subRouterList");
      for (const s of Array.isArray(subs) ? subs : []) {
        const protos = at(s, "dexProtocol");
        for (const p of Array.isArray(protos) ? protos : []) {
          const name = str(at(p, "dexName"));
          if (name && !dexNames.includes(name)) dexNames.push(name);
        }
      }
    }
  }
  return {
    toTokenAmount: toBigInt(at(v, "toTokenAmount")) ?? 0n,
    priceImpactPercent: toNumber(at(v, "priceImpactPercent")),
    estimateGasFee: toBigInt(at(v, "estimateGasFee")),
    fromToken: parseToken(at(v, "fromToken")),
    toToken: parseToken(at(v, "toToken")),
    dexNames,
  };
}

function parseToken(v: unknown): TokenInfo {
  const honey = at(v, "isHoneyPot");
  return {
    symbol: str(at(v, "tokenSymbol")) ?? "",
    decimals: toNumber(at(v, "decimal")) ?? 18,
    isHoneyPot: typeof honey === "boolean" ? honey : honey === "true" ? true : honey === "false" ? false : null,
    taxRate: toNumber(at(v, "taxRate")),
    unitPriceUsd: toNumber(at(v, "tokenUnitPrice")),
  };
}

function at(v: unknown, key: string): unknown {
  return v !== null && typeof v === "object" && key in v ? (v as Record<string, unknown>)[key] : undefined;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}
function hex(v: unknown): `0x${string}` | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? (v as `0x${string}`) : null;
}
function toBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  return BigInt(v);
}
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
