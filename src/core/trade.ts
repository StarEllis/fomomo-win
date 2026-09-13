import { randomUUID } from "node:crypto";
import { HttpRequestError, RpcRequestError, parseEventLogs, erc20Abi, type Log } from "viem";
import type { NativePrices } from "./native-price.js";
import { NATIVE_TOKEN, OkxError, TRADE_CHAINS, type OkxClient, type RouteInfo } from "./okx.js";
import type { Store, StoredTrade, TradeExec } from "./store.js";
import { NATIVE_SYMBOL, type OutEvent, type TradeChain, type TradeEvent, type TradeHolding, type TradePosition, type TradeQuoteEvent, type TradeSettings, type TradeStateEvent } from "./types.js";
import { SolTxError, type BurnerWallet, type EvmChain } from "./wallet.js";

/**
 * 一键买卖：本地 burner 热钱包签名 + OKX DEX 路由。fomo 只剩信号，不再碰交易。
 *
 * 报价：只在用户输入数量 / 点快捷额时问 OKX `/quote` **一次**（trade_quote），没有周期刷新、没有过期时间，也不依赖任何价格。
 *   买入按原生币数量计价（ETH/BNB/SOL/MON），卖出按持仓百分比；美元估值只做显示 + USD 限额校验，原生币美元价来自 native-price.ts（DexScreener 60s 后台缓存），
 *   缓存没价时报价照常（估值给 null），只有买入执行会因为没法校验限额而拒单。
 * 执行：点按钮时 `/swap` 现取新路由 + 未签名交易（autoSlippage ≤15%、priceImpactProtection 50%），本地 eth_call 模拟 → 签名 → 广播 → 等回执。
 *   sell（EVM）先查 allowance，不够就先发一笔 approve（额度 = 卖出量，不无限授权）。
 * 生命周期：validating → submitting → submitted（有 hash）→ confirmed | failed；等回执超时 → unknown，对账循环轮询 receipt 改终态，30 分钟仍无回执按 failed（未上链）。
 *   绝不自动重发；同地址有未落定记录时拒绝新意图；quoteId 消费一次；quick trade 同 id 重放只回放。
 * 余额/持仓：原生币六链余额 + 账本里 confirmed 过的币（∪ 焦点币）的链上余额，60s 一轮 + 成交后 0/2/4s 补读；持仓只跟我们自己买过的币（外部转入的不出现）。
 * 限额：单笔 / 滚动 24h 买入合计（设置）；卖出不计。
 * 私钥、OKX secret 永不进这里的日志 / 事件（wallet.ts 只暴露地址与签名/发送）。
 */

export interface TradeDeps {
  store: Store;
  bridge: { emit(e: OutEvent): void };
  settings: () => TradeSettings;
  /** OKX 客户端；设置变了重建 */
  okx: () => OkxClient;
  /** 从 Keychain 加载 burner；null = 还没生成 */
  wallet: (rpc: TradeSettings["rpc"]) => Promise<BurnerWallet | null>;
  /** 生成 burner（Swift「生成热钱包」按钮）；任一把已存在必须抛错，绝不覆盖 */
  createWallet: (rpc: TradeSettings["rpc"]) => Promise<BurnerWallet>;
  /** 引擎现价（链要对上；有限正数才算有）与展示元数据 */
  priceOf: (address: string, chain: string) => number | null;
  meta: (address: string, chain: string) => { symbol: string | null; name: string | null; logo: string | null } | null;
  /** 原生币美元价缓存（native-price.ts）；只做显示 / 限额，报价不靠它 */
  nativePrices: NativePrices;
  /** 秒 */
  now?: () => number;
  /** 等回执上限 / 对账间隔 / 对账放弃时限 / 余额轮询间隔（毫秒）；测试缩短 */
  timing?: Partial<Timing>;
}

interface Timing {
  receiptMs: number;
  reconcileEveryMs: number;
  reconcileGiveUpMs: number;
  /** 六链原生币 + 账本币全量扫一遍的间隔（兜底） */
  balancesEveryMs: number;
  /** 弹卡开着时，焦点币所在链的原生币 + 该币余额的刷新间隔（用户要「一秒一次」；只打一条链的节点，2 次/秒） */
  focusEveryMs: number;
}
const DEFAULT_TIMING: Timing = { receiptMs: 90_000, reconcileEveryMs: 15_000, reconcileGiveUpMs: 30 * 60_000, balancesEveryMs: 60_000, focusEveryMs: 1_000 };

const NATIVE_DECIMALS: Record<TradeChain, number> = { eth: 18, bsc: 18, base: 18, monad: 18, robinhood: 18, sol: 9 };
/** 本地最低额（USD）：更小的金额 gas 都不够 */
export const MIN_USD = 1;
const PRICE_IMPACT_PROTECTION = 50;
/** 未落定：这些状态下该地址不接受新意图 */
const LOCKED = new Set<TradeEvent["status"]>(["validating", "submitting", "submitted", "unknown"]);
/** 没钱包时 trade_state.reason；Swift 看到没地址就在这行下面放「生成热钱包」按钮，所以这里不提命令行 */
const NO_WALLET = "还没有热钱包";

const isTradeChain = (c: string): c is TradeChain => (TRADE_CHAINS as readonly string[]).includes(c);
const normAddress = (a: string, chain: string): string => (chain === "sol" ? a : a.toLowerCase());
const key = (address: string, chain: string): string => `${normAddress(address, chain)}:${chain}`;

/** 人类数量 → 最小单位（字串路径，18 位小数不丢精度） */
export function toRaw(amount: number, decimals: number): bigint {
  if (!(amount > 0)) return 0n;
  const [int, frac = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
  return BigInt(int + frac.padEnd(decimals, "0").slice(0, decimals));
}
export function fromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

interface Position {
  raw: bigint;
  decimals: number;
  symbol: string | null;
}

/** 执行要用的报价上下文（钉住的那份 quote 算出来的数量；swap 时按它下单，不重新算） */
interface QuotePlan {
  chain: TradeChain;
  side: "buy" | "sell";
  amountRaw: bigint;
  fromToken: string;
  toToken: string;
  tokenDecimals: number;
  tokenSymbol: string | null;
}

interface QuoteWant {
  address: string;
  chain: string;
  side: "buy" | "sell";
  /** buy：原生币数量；sell：0 */
  amount: number;
  pct: number | null;
}

export class TradeService {
  private readonly timing: Timing;
  private readonly now: () => number;
  private wallet: BurnerWallet | null = null;
  private okx: OkxClient | null = null;
  private reason: string | null = "交易模块未启动";
  /** 「生成热钱包」在飞：同一时刻只跑一次（并发两次 create 会互相覆盖私钥） */
  private walletIniting = false;
  private nativeBalances = new Map<TradeChain, bigint>();
  private positions = new Map<string, Position>();
  private approveSpender = new Map<TradeChain, string>();
  /** 最近一份报价（按 address:side）：执行意图必须钉住它的 id */
  private lastQuotes = new Map<string, { ev: TradeQuoteEvent; plan: QuotePlan }>();
  private quoteSeq = 0;
  private trades = new Map<string, StoredTrade>();
  private consumedQuotes = new Set<string>();
  private balancesTimer: NodeJS.Timeout | undefined;
  private focusTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private postTradeTimers: NodeJS.Timeout[] = [];
  private focused: { address: string; chain: TradeChain } | null = null;
  private closed = false;
  /** 持仓 / 余额 / 状态变了：Engine 据此重推 state（TokenView.position） */
  onChange: (() => void) | null = null;

  constructor(private readonly deps: TradeDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    this.restoreTrades();
    // 原生币价拉到 / 变了：余额估值跟着变，重推 trade_state
    this.deps.nativePrices.onChange = () => this.emitState();
    await this.settingsChanged();
    this.balancesTimer = setInterval(() => void this.refreshBalances(), this.timing.balancesEveryMs);
    if ([...this.trades.values()].some((t) => t.ev.status === "unknown" && t.ev.txHash)) this.ensureReconcile();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.balancesTimer);
    clearInterval(this.focusTimer);
    clearTimeout(this.reconcileTimer);
    for (const t of this.postTradeTimers) clearTimeout(t);
    this.postTradeTimers = [];
  }

  /** 设置变了（dashboard PUT / CLI）或启动：重建 OKX 客户端、按新 RPC 重载钱包、重算 ready，推一份状态 */
  async settingsChanged(): Promise<void> {
    const trade = this.deps.settings();
    try {
      this.wallet = await this.deps.wallet(trade.rpc);
    } catch (e) {
      this.wallet = null;
      console.error(`[trade] wallet load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.okx = this.deps.okx();
    // 唯一的门禁是钱包：OKX 凭据不在本机，没有可缺的配置
    this.reason = this.wallet ? null : NO_WALLET;
    this.emitState();
    await this.refreshBalances();
  }

  /**
   * Swift「生成热钱包」按钮（`wallet_init`）：没有钱包才生成，生成后立刻 ready 并推状态 + 拉余额；已有钱包只重推一份状态（绝不覆盖——覆盖 = 资金丢失）。
   * 失败（Keychain 拒绝 / 半把残留）把原因放进 reason 推给 UI，用户看得到；下一次 settingsChanged 会重算
   */
  async initWallet(): Promise<void> {
    if (this.wallet) return this.emitState();
    if (this.walletIniting) return;
    this.walletIniting = true;
    const rpc = this.deps.settings().rpc;
    try {
      this.wallet = await this.deps.createWallet(rpc);
      this.reason = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 极端并发（CLI 同时 wallet-init）→ 已存在也算成功，重载即可；其他失败把原因给 UI
      this.wallet = await this.deps.wallet(rpc).catch(() => null);
      this.reason = this.wallet ? null : `生成钱包失败：${msg}`;
      if (!this.wallet) console.error(`[trade] wallet init failed: ${msg}`);
    } finally {
      this.walletIniting = false;
    }
    this.emitState();
    if (this.wallet) await this.refreshBalances();
  }

  get ready(): boolean {
    return this.reason === null && this.wallet !== null && this.okx !== null;
  }

  // ---------- 状态 / 余额 / 持仓 ----------

  state(): TradeStateEvent {
    const trade = this.deps.settings();
    const balances = {} as TradeStateEvent["balances"];
    for (const c of TRADE_CHAINS) {
      const raw = this.nativeBalances.get(c);
      const native = raw === undefined ? 0 : fromRaw(raw, NATIVE_DECIMALS[c]);
      const price = this.nativePrice(c);
      balances[c] = { native, symbol: NATIVE_SYMBOL[c], price, usd: price === null ? null : native * price };
    }
    return {
      t: "trade_state",
      ready: this.ready,
      reason: this.reason,
      evmAddress: this.wallet?.evmAddress ?? null,
      solAddress: this.wallet?.solAddress ?? null,
      balances,
      presets: trade.presets,
      limits: { perTrade: trade.maxUsdPerTrade, perDay: trade.maxUsdPerDay, dayUsed: this.deps.store.buyUsdSince(this.now() - 86_400) },
      at: this.now(),
    };
  }

  private emitState(): void {
    this.deps.bridge.emit(this.state());
  }

  /** 弹卡 / 主面板持仓行用：链上余额 × 引擎现价；没读过 / 为 0 → null */
  positionOf(address: string, chain: string | null): TradePosition | null {
    if (!chain) return null;
    const p = this.positions.get(key(address, chain));
    if (!p || p.raw === 0n) return null;
    const amount = fromRaw(p.raw, p.decimals);
    const price = this.deps.priceOf(normAddress(address, chain), chain);
    return { amount, usd: price === null ? null : amount * price };
  }

  holdings(): TradeHolding[] {
    const out: TradeHolding[] = [];
    for (const t of this.deps.store.tradedTokens()) {
      const p = this.positions.get(key(t.address, t.chain));
      if (!p || p.raw === 0n) continue;
      const amount = fromRaw(p.raw, p.decimals);
      const meta = this.deps.meta(t.address, t.chain);
      const price = this.deps.priceOf(t.address, t.chain);
      const usd = price === null ? null : amount * price;
      const avg = (legs: Array<{ raw: bigint; usd: number }>): number | null => {
        const qty = legs.reduce((s, l) => s + fromRaw(l.raw, p.decimals), 0);
        return qty > 0 ? legs.reduce((s, l) => s + l.usd, 0) / qty : null;
      };
      const buy = avg(t.buys);
      const sell = avg(t.sells);
      const pnlUsd = usd === null ? null : usd + t.soldUsd - t.boughtUsd;
      out.push({
        address: t.address,
        chain: t.chain,
        symbol: meta?.symbol ?? t.symbol ?? p.symbol ?? t.address.slice(0, 6),
        name: meta?.name ?? null,
        logo: meta?.logo ?? null,
        amount,
        price,
        usd,
        boughtUsd: t.boughtUsd,
        soldUsd: t.soldUsd,
        pnlUsd,
        pnlPct: pnlUsd !== null && t.boughtUsd > 0 ? (pnlUsd / t.boughtUsd) * 100 : null,
        heldSince: t.firstBuy,
        tradePrices: buy === null && sell === null ? null : { buy, sell },
      });
    }
    return out;
  }

  private emitHoldings(): void {
    this.deps.bridge.emit({ t: "trade_holdings", at: this.now(), holdings: this.holdings() });
  }

  /** 弹卡开了某币：立刻读一次它的余额，然后每 `focusEveryMs` 读该链原生币 + 该币（卡关了停）；成交后另有 0/2/4s 补读 */
  focusChanged(address: string | null, chain: string | null): void {
    clearInterval(this.focusTimer);
    this.focusTimer = undefined;
    if (!address || !chain || !isTradeChain(chain)) {
      this.focused = null;
      return;
    }
    this.focused = { address: normAddress(address, chain), chain };
    if (this.closed) return;
    this.refreshGasPrice(chain);
    this.okx?.warm();
    void this.refreshFocused();
    this.focusTimer = setInterval(() => void this.refreshFocused(), this.timing.focusEveryMs);
  }

  /** 焦点币那条链的原生币 + 该币余额；变了才推（每秒一次不能把 state 事件当心跳发）；上一拍没回来就跳过这拍，节点慢时不叠请求 */
  private focusBusy = false;
  private async refreshFocused(): Promise<void> {
    const f = this.focused;
    const w = this.wallet;
    if (!f || !w || this.closed || this.focusBusy) return;
    this.focusBusy = true;
    try {
      this.refreshGasPrice(f.chain);
      const [nativeChanged, positionChanged] = await Promise.all([this.readNative(f.chain), this.readPosition(f.address, f.chain)]);
      if (nativeChanged || positionChanged) this.changed();
    } finally {
      this.focusBusy = false;
    }
  }

  /** 读一条链的原生币余额；返回是否变化。读失败保留旧值 */
  private async readNative(c: TradeChain): Promise<boolean> {
    const w = this.wallet;
    if (!w) return false;
    try {
      const bal = await w.nativeBalance(c);
      if (this.nativeBalances.get(c) === bal) return false;
      this.nativeBalances.set(c, bal);
      return true;
    } catch (e) {
      console.error(`[trade] ${c} native balance: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 六链原生币 + 账本币（∪ 焦点币）余额；任一变了推 state / holdings；单链失败只记日志 */
  async refreshBalances(): Promise<void> {
    const w = this.wallet;
    if (!w || this.closed) return;
    let changed = (await Promise.all(TRADE_CHAINS.map((c) => this.readNative(c)))).some(Boolean);
    const targets = new Map<string, { address: string; chain: TradeChain }>();
    for (const t of this.deps.store.tradedTokens()) if (isTradeChain(t.chain)) targets.set(key(t.address, t.chain), { address: t.address, chain: t.chain });
    if (this.focused) targets.set(key(this.focused.address, this.focused.chain), this.focused);
    const results = await Promise.all([...targets.values()].map((t) => this.readPosition(t.address, t.chain)));
    if (results.some(Boolean)) changed = true;
    if (changed) this.changed();
    else this.emitState();
  }

  private changed(): void {
    this.emitState();
    this.emitHoldings();
    this.onChange?.();
  }

  /** 读一个币的链上余额（+ decimals）；返回是否变化。读失败保留旧值 */
  private async readPosition(address: string, chain: TradeChain): Promise<boolean> {
    const w = this.wallet;
    if (!w) return false;
    const k = key(address, chain);
    const prev = this.positions.get(k);
    try {
      let raw: bigint;
      let decimals: number | null;
      if (chain === "sol") {
        const r = await w.splBalance(address);
        raw = r.amount;
        decimals = r.decimals ?? prev?.decimals ?? null;
      } else {
        raw = await w.erc20Balance(chain, address);
        decimals = prev?.decimals ?? (await w.erc20Decimals(chain, address));
      }
      if (decimals === null) {
        // 没有 token account 也没缓存过精度：数量 0，精度先按 sol 常见 6 位占位（只影响 0 的显示，下次报价会带来真实精度）
        decimals = 6;
      }
      if (prev && prev.raw === raw && prev.decimals === decimals) return false;
      this.positions.set(k, { raw, decimals, symbol: prev?.symbol ?? null });
      return true;
    } catch (e) {
      console.error(`[trade] position ${chain} ${address.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 原生币美元价（native-price.ts 缓存）；没拉到 → null */
  private nativePrice(chain: TradeChain): number | null {
    return this.deps.nativePrices.get(NATIVE_SYMBOL[chain]);
  }

  // ---------- 报价（一次） ----------

  /** Swift 弹卡：输入数量 / 点快捷额 → 一次报价；address=null 只是让在飞的那份作废。buy 用 amount（原生币数量），sell 用 pct */
  quote(want: { address: string | null; chain?: string; side?: "buy" | "sell"; amount?: number; pct?: number | null }): void {
    this.quoteSeq++;
    if (!want.address) return;
    const chain = want.chain ?? "";
    const side = want.side === "sell" ? "sell" : "buy";
    const amount = num(want.amount) ?? 0;
    const w: QuoteWant = { address: normAddress(want.address, chain), chain, side, amount: side === "buy" && amount > 0 ? amount : 0, pct: want.pct === undefined || want.pct === null ? null : Math.round(want.pct) };
    void this.quoteOnce(w, this.quoteSeq);
  }

  /** 调试端点 / 内部：一次报价并返回事件（seq 对不上 = 用户已改金额，结果不推） */
  async quoteOnce(w: QuoteWant, seq: number | null = null): Promise<TradeQuoteEvent> {
    const { ev, plan } = await this.buildQuote(w);
    if (seq === null || seq === this.quoteSeq) {
      if (ev.ok && plan) this.lastQuotes.set(`${w.address}:${w.side}`, { ev, plan });
      this.deps.bridge.emit(ev);
    }
    return ev;
  }

  private async buildQuote(w: QuoteWant): Promise<{ ev: TradeQuoteEvent; plan: QuotePlan | null }> {
    const nativePrice = isTradeChain(w.chain) ? this.nativePrice(w.chain) : null;
    // buy 的估值 = 数量 × 缓存价（没价 → null，只影响显示）；sell 的估值在拿到路由后按现价算
    const base = { t: "trade_quote" as const, id: `q:${randomUUID()}`, address: w.address, chain: w.chain, side: w.side, amount: w.side === "buy" ? w.amount : 0, pct: w.pct, usd: w.side === "buy" && nativePrice !== null ? w.amount * nativePrice : null, minUsd: MIN_USD, at: this.now() };
    const fail = (error: string): { ev: TradeQuoteEvent; plan: null } => ({ ev: { ...base, ok: false, outAmount: null, outSymbol: null, outUsd: null, networkFeeUsd: null, priceImpactPct: null, honeypot: false, taxPct: null, error }, plan: null });
    if (!this.ready) return fail(this.reason ?? "交易模块未就绪");
    if (!isTradeChain(w.chain)) return fail(w.chain ? `不支持的链 ${w.chain}` : "链未知，等行情定链");
    const chain = w.chain;
    try {
      const plan = await this.plan(w.address, chain, w.side, w.amount, w.pct);
      if (plan.amountRaw === 0n) return fail(w.side === "sell" ? "没有持仓" : "数量太小");
      const r = await this.okx!.quote({ chain, fromToken: plan.fromToken, toToken: plan.toToken, amountRaw: plan.amountRaw, priceImpactProtectionPercent: PRICE_IMPACT_PROTECTION });
      this.rememberMeta(w.address, chain, r, w.side);
      const token = w.side === "buy" ? r.toToken : r.fromToken;
      // 精度以 OKX 响应为准（买入前本地可能还没读过这个币）
      const tokenDecimals = token.decimals;
      const inDec = w.side === "buy" ? NATIVE_DECIMALS[chain] : tokenDecimals;
      const outDec = w.side === "buy" ? tokenDecimals : NATIVE_DECIMALS[chain];
      const inAmount = fromRaw(plan.amountRaw, inDec);
      const outAmount = fromRaw(r.toTokenAmount, outDec);
      // 到手估值：buy = 代币数量 ×（OKX 给的价，退引擎现价）；sell = 原生币数量 ×（缓存价，退 OKX 给的价）
      const outUnit = w.side === "buy" ? (r.toToken.unitPriceUsd ?? this.deps.priceOf(w.address, chain)) : (nativePrice ?? r.toToken.unitPriceUsd);
      const outUsd = outUnit === null ? null : outAmount * outUnit;
      // sell 的 usd 展示值 = 卖出数量 × 现价（引擎价优先，退 OKX 给的价）；buy 在 base 里已按缓存价算好
      const inUnit = w.side === "sell" ? (this.deps.priceOf(w.address, chain) ?? r.fromToken.unitPriceUsd) : null;
      const usd = w.side === "sell" ? (inUnit === null ? null : inAmount * inUnit) : base.usd;
      const symbol = token.symbol || plan.tokenSymbol;
      const ev: TradeQuoteEvent = {
        ...base,
        usd,
        ok: true,
        outAmount,
        outSymbol: w.side === "buy" ? symbol : NATIVE_SYMBOL[chain],
        outUsd,
        networkFeeUsd: this.networkFeeUsd(chain, r.estimateGasFee, nativePrice),
        priceImpactPct: r.priceImpactPercent,
        honeypot: token.isHoneyPot === true,
        taxPct: token.taxRate === null ? null : token.taxRate * 100,
        error: null,
      };
      return { ev, plan: { ...plan, tokenDecimals, tokenSymbol: symbol } };
    } catch (e) {
      return fail(describe(e));
    }
  }

  private gasPrices = new Map<TradeChain, { wei: bigint; at: number }>();
  private gasPriceBusy = new Set<TradeChain>();
  /** 节点 gasPrice 60s 缓存（BSC dataseed 一次 eth_gasPrice 实测 0.43s，不能挂在报价路径上）；焦点循环按秒喂，报价只读缓存 */
  private refreshGasPrice(chain: TradeChain): void {
    const w = this.wallet;
    if (!w || chain === "sol" || this.closed || this.gasPriceBusy.has(chain)) return;
    const gp = this.gasPrices.get(chain);
    if (gp && this.now() - gp.at <= 60) return;
    this.gasPriceBusy.add(chain);
    void w
      .gasPrice(chain)
      .then((wei) => this.gasPrices.set(chain, { wei, at: this.now() }))
      .catch((e: unknown) => console.error(`[trade] ${chain} gasPrice: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.gasPriceBusy.delete(chain));
  }

  /** OKX 的 estimateGasFee 是 gas 数（实测 BSC 报 490616），EVM 要乘节点 gasPrice（只读缓存，没缓存 → null，同时后台去拉，下一次报价就有）；Solana 给的是 lamports */
  private networkFeeUsd(chain: TradeChain, gas: bigint | null, nativePrice: number | null): number | null {
    if (gas === null || nativePrice === null || !this.wallet) return null;
    if (chain === "sol") return fromRaw(gas, 9) * nativePrice;
    const gp = this.gasPrices.get(chain);
    if (!gp) {
      this.refreshGasPrice(chain);
      return null;
    }
    return fromRaw(gas * gp.wei, 18) * nativePrice;
  }

  private rememberMeta(address: string, chain: TradeChain, r: RouteInfo, side: "buy" | "sell"): void {
    const token = side === "buy" ? r.toToken : r.fromToken;
    const k = key(address, chain);
    const p = this.positions.get(k);
    if (p) {
      p.symbol = token.symbol || p.symbol;
      p.decimals = token.decimals;
    } else this.positions.set(k, { raw: 0n, decimals: token.decimals, symbol: token.symbol || null });
  }

  /**
   * 把意图折成最小单位数量：buy = 原生币数量直接换最小单位；sell = 现读的持仓 × pct。
   * sell 每次都现读链上余额（卖的是真实数量，不能用旧读数）。
   */
  private async plan(address: string, chain: TradeChain, side: "buy" | "sell", amount: number, pct: number | null): Promise<QuotePlan> {
    const native = NATIVE_TOKEN[chain];
    if (side === "buy") {
      const p = this.positions.get(key(address, chain));
      return { chain, side, amountRaw: toRaw(amount, NATIVE_DECIMALS[chain]), fromToken: native, toToken: address, tokenDecimals: p?.decimals ?? 18, tokenSymbol: p?.symbol ?? null };
    }
    if (pct === null) throw new Error("卖出按持仓百分比");
    await this.readPosition(address, chain);
    const p = this.positions.get(key(address, chain));
    if (!p || p.raw === 0n) return { chain, side, amountRaw: 0n, fromToken: address, toToken: native, tokenDecimals: p?.decimals ?? 18, tokenSymbol: p?.symbol ?? null };
    const amountRaw = (p.raw * BigInt(Math.min(100, Math.max(1, pct)))) / 100n;
    return { chain, side, amountRaw, fromToken: address, toToken: native, tokenDecimals: p.decimals, tokenSymbol: p.symbol };
  }

  // ---------- 执行 ----------

  private setTrade(ev: TradeEvent, quoteId: string, exec?: Partial<TradeExec> | null): void {
    const prev = this.trades.get(ev.address);
    const stored: StoredTrade = { ev, quoteId, created: prev?.ev.id === ev.id ? prev.created : ev.ts, exec: { ...(prev?.ev.id === ev.id ? prev.exec : { inRaw: null, outRaw: null, decimals: null, symbol: null }), ...strip(exec) } };
    this.trades.set(ev.address, stored);
    this.deps.store.saveTrade(ev, quoteId, exec);
    this.deps.bridge.emit(ev);
    console.error(`[trade] ${ev.id.slice(0, 8)} ${ev.side} ${ev.chain} ${ev.address.slice(0, 10)} $${ev.usd.toFixed(2)} → ${ev.status}${ev.txHash ? ` tx=${ev.txHash.slice(0, 18)}…` : ""}${ev.error ? ` error=${ev.error}` : ""}${ev.detail ? ` (${ev.detail})` : ""}`);
    if (ev.status === "confirmed" || ev.status === "failed") this.afterTerminal();
    if (ev.status === "unknown" && ev.txHash) this.ensureReconcile();
  }

  /** 成交 / 失败后 0/2/4s 补读余额与持仓（链上余额索引常晚一拍） */
  private afterTerminal(): void {
    for (const d of [0, 2000, 4000]) {
      const t = setTimeout(() => {
        this.postTradeTimers = this.postTradeTimers.filter((x) => x !== t);
        void this.refreshBalances();
      }, d);
      this.postTradeTimers.push(t);
    }
    this.emitState();
  }

  private restoreTrades(): void {
    for (const st of this.deps.store.loadTrades()) {
      let ev = st.ev;
      if (ev.status === "validating" || (ev.status === "submitting" && !ev.txHash)) {
        // 进程重启：签名/广播前中断。submitting 有几百毫秒窗口可能已广播但没记 hash——无法核对，按 failed 放开锁，余额刷新以链上为准
        ev = { ...ev, status: "failed", error: "restart", detail: ev.status === "submitting" ? "进程重启时正在广播且未记录 hash；余额以链上为准" : "进程重启，未发起交易", ts: this.now() };
        this.deps.store.saveTrade(ev, st.quoteId);
      } else if (ev.status === "submitting" || ev.status === "submitted") {
        ev = { ...ev, status: "unknown", detail: "进程重启，等回执中断；按 hash 对账", ts: this.now() };
        this.deps.store.saveTrade(ev, st.quoteId);
      }
      this.trades.set(ev.address, { ...st, ev });
      if (st.quoteId) this.consumedQuotes.add(st.quoteId);
      this.deps.bridge.emit(ev);
    }
  }

  /** 该地址有未落定记录 → 拒绝新意图的原因；null = 可以 */
  private lockReason(address: string): string | null {
    const cur = this.trades.get(address);
    return cur && LOCKED.has(cur.ev.status) ? `上一单还未落定（${cur.ev.status}）` : null;
  }

  /** 买入门槛：原生币价可用（否则没法折 USD）→ 最低额 → 单笔 / 滚动 24h 上限；卖出不计 */
  private limitReason(side: "buy" | "sell", usd: number, nativePrice: number | null): string | null {
    if (side !== "buy") return null;
    if (nativePrice === null) return "原生币美元价未知，无法校验限额；稍等重试";
    if (usd < MIN_USD) return `最低 $${MIN_USD}`;
    const t = this.deps.settings();
    if (usd > t.maxUsdPerTrade) return `超单笔上限 $${t.maxUsdPerTrade}`;
    const used = this.deps.store.buyUsdSince(this.now() - 86_400);
    if (used + usd > t.maxUsdPerDay) return `超今日上限 $${t.maxUsdPerDay}（已用 $${used.toFixed(0)}）`;
    return null;
  }

  /** 弹卡主按钮：钉住当前报价 id；校验通过才进 runTrade。buy 传原生币数量，sell 传 pct（amount 给 0） */
  trade(intent: { address: string; chain: string; side: "buy" | "sell"; amount: number; pct?: number | null; quoteId: string }): void {
    const chain = intent.chain;
    const address = normAddress(intent.address, chain);
    const side = intent.side === "sell" ? "sell" : "buy";
    const pct = intent.pct ?? null;
    const amount = num(intent.amount) ?? 0;
    const locked = this.lockReason(address);
    if (locked) {
      const cur = this.trades.get(address)!;
      this.deps.bridge.emit(cur.ev);
      console.error(`[trade] reject ${side} ${address.slice(0, 10)}: ${locked}`);
      return;
    }
    const lq = this.lastQuotes.get(`${address}:${side}`);
    // 账本估值：buy = 数量 × 原生币缓存价（没价 → 0，下面拒单）；sell = 报价里按现价折的估值
    const nativePrice = side === "buy" && isTradeChain(chain) ? this.nativePrice(chain) : null;
    const usd = side === "buy" ? (nativePrice === null ? 0 : amount * nativePrice) : (lq?.ev.usd ?? 0);
    const base: TradeEvent = { t: "trade", id: randomUUID(), address, chain, side, usd, pct, status: "validating", txHash: null, error: null, detail: null, ts: this.now() };
    this.setTrade(base, intent.quoteId);
    const fail = (error: string, detail: string | null = null) => this.setTrade({ ...base, status: "failed", error, detail, ts: this.now() }, intent.quoteId);
    if (!this.ready) return fail(this.reason ?? "交易模块未就绪");
    if (!isTradeChain(chain)) return fail(`不支持的链 ${chain || "?"}`);
    if (this.consumedQuotes.has(intent.quoteId) || this.deps.store.quoteConsumed(intent.quoteId, base.id)) return fail("这份报价已被执行过，请重新报价");
    if (!lq || lq.ev.id !== intent.quoteId) return fail("报价已更新，请按最新报价重新点击");
    if (lq.ev.chain !== chain) return fail("链与报价不一致，请重新报价");
    if ((side === "buy" && Math.abs(lq.ev.amount - amount) > 1e-12) || lq.ev.pct !== pct) return fail("数量与报价不一致，请重新报价");
    const limit = this.limitReason(side, usd, nativePrice);
    if (limit) return fail(limit);
    this.consumedQuotes.add(intent.quoteId);
    void this.runTrade(base, lq.plan, intent.quoteId);
  }

  /** 持仓行闪电：Swift 给 id；同步先落 validating，再现算数量执行（不发 trade_quote）。buy 传原生币数量，sell 传 pct（amount 给 0） */
  quickTrade(intent: { id: string; address: string; chain: string; side: "buy" | "sell"; amount: number; pct?: number | null }): void {
    const chain = intent.chain;
    const address = normAddress(intent.address, chain);
    const side = intent.side === "sell" ? "sell" : "buy";
    const pct = intent.pct ?? null;
    const amount = num(intent.amount) ?? 0;
    const existing = this.trades.get(address)?.ev.id === intent.id ? this.trades.get(address) : this.deps.store.tradeById(intent.id);
    if (existing) {
      this.deps.bridge.emit(existing.ev);
      return;
    }
    const locked = this.lockReason(address);
    if (locked) {
      this.deps.bridge.emit(this.trades.get(address)!.ev);
      console.error(`[trade] reject quick ${side} ${address.slice(0, 10)}: ${locked}`);
      return;
    }
    // buy 的账本估值 = 数量 × 原生币缓存价（没价 → 0，下面拒单）；sell 的在 plan 之后按现价折
    const nativePrice = side === "buy" && isTradeChain(chain) ? this.nativePrice(chain) : null;
    const base: TradeEvent = { t: "trade", id: intent.id, address, chain, side, usd: nativePrice === null ? 0 : amount * nativePrice, pct, status: "validating", txHash: null, error: null, detail: null, ts: this.now() };
    const quoteId = `quick:${intent.id}`;
    this.setTrade(base, quoteId);
    const fail = (error: string, detail: string | null = null) => this.setTrade({ ...base, status: "failed", error, detail, ts: this.now() }, quoteId);
    if (!this.ready) return fail(this.reason ?? "交易模块未就绪");
    if (!isTradeChain(chain)) return fail(`不支持的链 ${chain || "?"}`);
    const limit = this.limitReason(side, base.usd, nativePrice);
    if (limit) return fail(limit);
    void (async () => {
      let plan: QuotePlan;
      try {
        plan = await this.plan(address, chain, side, amount, pct);
      } catch (e) {
        return fail(describe(e));
      }
      if (plan.amountRaw === 0n) return fail(side === "sell" ? "没有持仓" : "数量太小");
      // sell 的展示 usd 按现价折算（UI 传 0）
      const shown = side === "sell" ? { ...base, usd: (this.deps.priceOf(address, chain) ?? 0) * fromRaw(plan.amountRaw, plan.tokenDecimals) } : base;
      await this.runTrade(shown, plan, quoteId);
    })();
  }

  /**
   * 真正花钱的路径：余额校验 → （sell 先 approve）→ OKX swap → 本地模拟/签名/广播 → 等回执。
   * 任何在拿到 hash 之前的失败 = failed（确定没交易）；拿到 hash 之后超时 = unknown（对账）。
   */
  private async runTrade(base: TradeEvent, plan: QuotePlan, quoteId: string): Promise<void> {
    const w = this.wallet!;
    const okx = this.okx!;
    const chain = plan.chain;
    let cur: TradeEvent = base;
    const set = (patch: Partial<TradeEvent>, exec?: Partial<TradeExec> | null) => {
      cur = { ...cur, ...patch, ts: this.now() };
      this.setTrade(cur, quoteId, exec);
    };
    const fail = (error: string, detail: string | null = null) => set({ status: "failed", error, detail });
    try {
      if (plan.side === "buy") {
        const bal = this.nativeBalances.get(chain) ?? (await w.nativeBalance(chain));
        if (bal < plan.amountRaw) return fail("余额不足", `需要 ${fromRaw(plan.amountRaw, NATIVE_DECIMALS[chain]).toPrecision(4)} ${NATIVE_SYMBOL[chain]}，钱包有 ${fromRaw(bal, NATIVE_DECIMALS[chain]).toPrecision(4)}`);
      }
      set({ status: "submitting", detail: null }, { inRaw: plan.amountRaw.toString(), decimals: plan.tokenDecimals, symbol: plan.tokenSymbol });
      if (plan.side === "sell" && chain !== "sol") await this.ensureAllowance(w, okx, chain, plan, set);
      const userWalletAddress = chain === "sol" ? w.solAddress : w.evmAddress;
      const swap = await okx.swap({ chain, fromToken: plan.fromToken, toToken: plan.toToken, amountRaw: plan.amountRaw, userWalletAddress, priceImpactProtectionPercent: PRICE_IMPACT_PROTECTION });
      const token = plan.side === "buy" ? swap.route.toToken : swap.route.fromToken;
      set({ detail: `路由 ${swap.route.dexNames.join("+") || "OKX"} · 滑点 ${swap.slippagePercent}%` }, { outRaw: swap.route.toTokenAmount.toString(), decimals: token.decimals, symbol: token.symbol || plan.tokenSymbol });
      if (chain === "sol") {
        if (!swap.sol) return fail("OKX 未返回 Solana 交易");
        const { signature } = await this.withTimeout(w.sendSol(swap.sol.txBase58, (sig) => set({ status: "submitted", txHash: sig, detail: "已广播，等待确认" })), this.timing.receiptMs);
        set({ status: "confirmed", txHash: signature, error: null, detail: "已成交" });
        return;
      }
      if (!swap.evm) return fail("OKX 未返回 EVM 交易");
      const receipt = await this.withTimeout(w.sendEvm(chain, swap.evm.tx, (hash) => set({ status: "submitted", txHash: hash, detail: "已上链，等待确认" })), this.timing.receiptMs);
      if (receipt.status === "reverted") return set({ status: "failed", txHash: receipt.hash, error: "链上执行失败（revert）", detail: "gas 已消耗，代币未成交" });
      const received = plan.side === "buy" ? receivedFromLogs(receipt.logs, plan.toToken, w.evmAddress) : null;
      set({ status: "confirmed", txHash: receipt.hash, error: null, detail: "已成交" }, received !== null ? { outRaw: received.toString() } : null);
    } catch (e) {
      // Solana 确认为失败：有 signature，链上已执行（gas 已花）
      if (e instanceof SolTxError) return set({ status: "failed", txHash: e.signature, error: "链上执行失败", detail: e.message.slice(0, 200) });
      // 已广播但没等到回执：不能断定成败 → unknown，交给对账。原因要写进 detail——2026-09-10 首单就是节点 403 拒 getTransactionReceipt，光写「出错」查不出来
      if (cur.status === "submitted") return set({ status: "unknown", error: e instanceof TimeoutError ? "receipt_timeout" : "receipt_error", detail: e instanceof TimeoutError ? "等待回执超时，按 hash 对账中" : `等待回执出错：${describe(e)}；按 hash 对账中` });
      return fail(describe(e));
    }
  }

  /** sell（EVM）：allowance 不够就先发一笔 approve（额度 = 卖出量），等它上链再 swap */
  private async ensureAllowance(w: BurnerWallet, okx: OkxClient, chain: EvmChain, plan: QuotePlan, set: (patch: Partial<TradeEvent>) => void): Promise<void> {
    let spender = this.approveSpender.get(chain);
    if (!spender) {
      const s = await okx.supportedChain(chain);
      if (!s.dexTokenApproveAddress) throw new Error(`OKX 没给 ${chain} 的授权合约地址`);
      spender = s.dexTokenApproveAddress;
      this.approveSpender.set(chain, spender);
    }
    const allowance = await w.erc20Allowance(chain, plan.fromToken, spender);
    if (allowance >= plan.amountRaw) return;
    set({ detail: "授权中…" });
    const a = await okx.approveTransaction(chain, plan.fromToken, plan.amountRaw);
    const gasPrice = a.gasPrice ?? (await w.gasPrice(chain));
    const receipt = await this.withTimeout(w.sendEvm(chain, { to: a.to, data: a.data, value: 0n, gas: a.gasLimit ?? 100_000n, gasPrice, maxPriorityFeePerGas: null }), this.timing.receiptMs);
    if (receipt.status === "reverted") throw new Error("授权交易失败（revert）");
    set({ detail: "已授权，下单中…" });
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    const { promise, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    return Promise.race([p, promise]).finally(() => clearTimeout(timer));
  }

  // ---------- 对账（unknown 有 hash） ----------

  private ensureReconcile(): void {
    if (this.reconcileTimer || this.closed) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcile();
    }, this.timing.reconcileEveryMs);
  }

  /**
   * unknown 且有 hash 的记录每 15s 问一次链。三态严格分开：节点给回执 → 落定；节点明确说没有 → 累计「未上链」，超 30 分钟按 not_mined 失败；
   * 节点没答上来（限流 / 403 / 断网）→ 记录保持 unknown、detail 写明节点错误、继续重试，**永不**因为我们读不到就断定链上没成交
   */
  private async reconcile(): Promise<void> {
    const w = this.wallet;
    let pending = false;
    for (const st of [...this.trades.values()]) {
      const ev = st.ev;
      if (ev.status !== "unknown" || !ev.txHash || !isTradeChain(ev.chain) || !w) continue;
      let notMined = false;
      try {
        if (ev.chain === "sol") {
          const s = await w.solStatus(ev.txHash);
          if (s === "success") this.setTrade({ ...ev, status: "confirmed", error: null, detail: "对账：链上确认", ts: this.now() }, st.quoteId);
          else if (s === "failed") this.setTrade({ ...ev, status: "failed", error: "链上执行失败", detail: "对账：链上确认失败", ts: this.now() }, st.quoteId);
          else notMined = true;
        } else {
          const r = await w.receiptEvm(ev.chain, ev.txHash as `0x${string}`);
          if (r === null) notMined = true;
          else if (r.status === "success") {
            const received = ev.side === "buy" ? receivedFromLogs(r.logs, ev.address, w.evmAddress) : null;
            this.setTrade({ ...ev, status: "confirmed", error: null, detail: "对账：链上确认", ts: this.now() }, st.quoteId, received !== null ? { outRaw: received.toString() } : null);
          } else this.setTrade({ ...ev, status: "failed", error: "链上执行失败（revert）", detail: "对账：链上确认失败", ts: this.now() }, st.quoteId);
        }
      } catch (e) {
        pending = true;
        const detail = `对账读节点失败：${describe(e)}；继续重试`;
        if (ev.detail !== detail) this.setTrade({ ...ev, detail, ts: this.now() }, st.quoteId);
        continue;
      }
      if (!notMined) continue;
      if ((this.now() - st.created) * 1000 > this.timing.reconcileGiveUpMs) {
        this.setTrade({ ...ev, status: "failed", error: "not_mined", detail: "超过 30 分钟节点都说没有这笔交易，视为未上链；余额以链上为准", ts: this.now() }, st.quoteId);
      } else pending = true;
    }
    if (pending) this.ensureReconcile();
  }
}

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

/** 到账 = 回执里 token 合约发给我们地址的 Transfer 之和 */
function receivedFromLogs(logs: Log[], token: string, me: string): bigint | null {
  const mine = logs.filter((l) => l.address.toLowerCase() === token.toLowerCase());
  if (mine.length === 0) return null;
  let sum = 0n;
  let hit = false;
  for (const ev of parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: mine, strict: false })) {
    if (ev.args.to?.toLowerCase() === me.toLowerCase() && ev.args.value !== undefined) {
      sum += ev.args.value;
      hit = true;
    }
  }
  return hit ? sum : null;
}

function strip(exec: Partial<TradeExec> | null | undefined): Partial<TradeExec> {
  const out: Partial<TradeExec> = {};
  if (!exec) return out;
  for (const k of Object.keys(exec) as Array<keyof TradeExec>) if (exec[k] !== undefined && exec[k] !== null) (out as Record<string, unknown>)[k] = exec[k];
  return out;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 错误 → 用户可读中文；OKX 错误按 kind，RPC/余额错误按常见文案 */
function describe(e: unknown): string {
  if (e instanceof OkxError) {
    switch (e.kind) {
      case "liquidity": return "流动性不足";
      case "price-impact": return `价格冲击超过 ${PRICE_IMPACT_PROTECTION}%`;
      case "rate-limit": return "OKX 忙，请稍后重试";
      case "auth": return "OKX 凭据无效";
      case "unsupported": return "OKX 不支持该代币/链";
      case "network": return "网络错误";
      default: return e.message;
    }
  }
  // viem 的节点错误 message 是多行长文（URL / 请求体 / 版本），只取节点说的那句
  if (e instanceof RpcRequestError) return `节点报错：${e.details}`.slice(0, 200);
  if (e instanceof HttpRequestError) return `节点 HTTP ${e.status ?? "无响应"}：${e.details ?? ""}`.slice(0, 200);
  const m = e instanceof Error ? e.message : String(e);
  if (/insufficient funds/i.test(m)) return "余额不足付 gas";
  if (/execution reverted|revert/i.test(m)) return "模拟执行失败（revert）";
  if (/timeout|timed out/i.test(m)) return "请求超时";
  return m.length > 200 ? m.slice(0, 200) : m;
}

