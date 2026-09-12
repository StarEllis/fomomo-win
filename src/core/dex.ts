import { getJson } from "./proxy.js";
import type { Market } from "./types.js";

/** gmgn 链名 ⇄ DexScreener chainId */
export const Chain = {
  toDex(c: string): string {
    return c === "eth" ? "ethereum" : c === "sol" ? "solana" : c;
  },
  fromDex(c: string): string {
    return c === "ethereum" ? "eth" : c === "solana" ? "sol" : c;
  },
};

type Pair = {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  info?: { imageUrl?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  priceChange?: { m5?: number; h1?: number; h24?: number };
};

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function liq(p: Pair): number {
  return num(p.liquidity?.usd) ?? 0;
}

function market(p: Pair): Market {
  return {
    symbol: p.baseToken?.symbol,
    name: p.baseToken?.name,
    logo: p.info?.imageUrl,
    chain: p.chainId ? Chain.fromDex(p.chainId) : undefined,
    price: num(p.priceUsd),
    mc: num(p.marketCap) ?? num(p.fdv),
    liq: liq(p),
    change5m: num(p.priceChange?.m5),
    change1h: num(p.priceChange?.h1),
    change24h: num(p.priceChange?.h24),
    source: "dex",
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** 同一代币多个交易对：取流动性最大的 */
function best(pairs: Pair[]): Pair | undefined {
  let b: Pair | undefined;
  for (const p of pairs) if (!b || liq(p) > liq(b)) b = p;
  return b;
}

/** 调试用：指到不可达地址模拟"本机 DexScreener 挂了"（如 http://10.255.255.1） */
const BASE = process.env.FOMOMO_DEX_BASE ?? "https://api.dexscreener.com";
/** 3s：过代理正常 <1s 回；不可达时别拖住新币定链（gmgn 并行在猜，见 engine.flushPending），弹卡 6s 就关了。请求走系统代理（proxy.ts）：本机 DNS 把 api.dexscreener.com 投毒，直连必超时 */
const TIMEOUT_MS = 3_000;

/** DexScreener 公开 API（无鉴权）：定链 + 基线行情 */
export const Dex = {
  /** 任意链查一个地址 */
  async lookup(address: string): Promise<Market | null> {
    const j = (await getJson(`${BASE}/latest/dex/tokens/${address}`, TIMEOUT_MS)) as { pairs?: Pair[] } | null;
    const b = j?.pairs ? best(j.pairs) : undefined;
    return b ? market(b) : null;
  },

  /** 同链批量（≤30 地址） */
  async batch(dexChain: string, addresses: string[]): Promise<Map<string, Market>> {
    const out = new Map<string, Market>();
    if (addresses.length === 0) return out;
    const j = (await getJson(`${BASE}/tokens/v1/${dexChain}/${addresses.join(",")}`, TIMEOUT_MS)) as Pair[] | null;
    if (!Array.isArray(j)) return out;
    const byAddr = new Map<string, Pair[]>();
    for (const p of j) {
      const a = p.baseToken?.address?.toLowerCase();
      if (!a) continue;
      const arr = byAddr.get(a) ?? [];
      arr.push(p);
      byAddr.set(a, arr);
    }
    for (const [a, ps] of byAddr) {
      const b = best(ps);
      if (b) out.set(a, market(b));
    }
    return out;
  },
};
