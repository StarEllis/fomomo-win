import { Dex } from "./dex.js";
import { NATIVE_SYMBOLS, type NativeSymbol } from "./types.js";

/**
 * 原生币（ETH / BNB / SOL / MON）美元价：后台每 60s 从 DexScreener 拉一次包装币的价（`Dex.batch`，和 engine 定链同一条接口），只做显示与限额校验。
 * 报价 / 下单路径**不等它**——买入按原生币数量计价，没有价也能报价、能下单（2026-09-11 用户定：估值不影响展示速度）。
 * 拉失败保留旧值；从未拉到 → null（UI 显示「—」，买入限额校验拒单）。4 请求 / 分钟，DexScreener 300/min 限额忽略不计。
 */
export const WRAPPED_NATIVE: Record<NativeSymbol, { dexChain: string; address: string }> = {
  ETH: { dexChain: "ethereum", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  BNB: { dexChain: "bsc", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
  SOL: { dexChain: "solana", address: "So11111111111111111111111111111111111111112" },
  MON: { dexChain: "monad", address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" },
};

export interface NativePrices {
  /** 最近一次拉到的美元价；从未拉到 → null */
  get(symbol: NativeSymbol): number | null;
  /** 任一价变了（含首次拉到）；TradeService 用它重推 trade_state */
  onChange: (() => void) | null;
}

export interface NativePriceFeedOptions {
  everyMs?: number;
  /** 测试注入；默认 DexScreener `Dex.batch` 取该包装币流动性最大交易对的 priceUsd */
  fetch?: (dexChain: string, address: string) => Promise<number | null>;
}

const DEFAULT_EVERY_MS = 60_000;

async function dexPrice(dexChain: string, address: string): Promise<number | null> {
  const m = (await Dex.batch(dexChain, [address])).get(address.toLowerCase());
  const p = m?.price;
  return p !== undefined && Number.isFinite(p) && p > 0 ? p : null;
}

export class NativePriceFeed implements NativePrices {
  private readonly prices = new Map<NativeSymbol, number>();
  private readonly fetch: (dexChain: string, address: string) => Promise<number | null>;
  private readonly everyMs: number;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  onChange: (() => void) | null = null;

  constructor(opts: NativePriceFeedOptions = {}) {
    this.fetch = opts.fetch ?? dexPrice;
    this.everyMs = opts.everyMs ?? DEFAULT_EVERY_MS;
  }

  get(symbol: NativeSymbol): number | null {
    return this.prices.get(symbol) ?? null;
  }

  /** 立刻拉一轮（不等），之后按间隔 */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.everyMs);
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 四个币并行；上一轮没回来就跳过这轮 */
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const results = await Promise.all(
        NATIVE_SYMBOLS.map(async (s) => {
          const { dexChain, address } = WRAPPED_NATIVE[s];
          try {
            return [s, await this.fetch(dexChain, address)] as const;
          } catch (e) {
            console.error(`[native-price] ${s}: ${e instanceof Error ? e.message : String(e)}`);
            return [s, null] as const;
          }
        }),
      );
      let changed = false;
      for (const [s, p] of results) {
        if (p === null || this.prices.get(s) === p) continue;
        this.prices.set(s, p);
        changed = true;
      }
      if (changed) this.onChange?.();
    } finally {
      this.busy = false;
    }
  }
}
