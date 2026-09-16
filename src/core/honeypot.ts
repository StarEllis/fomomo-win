import { requestJson } from "./proxy.js";

/**
 * 貔貅探测（GoPlus 公共 token_security，免 key，只读）：
 * - `honeypot`：EVM 合约判定为貔貅（`is_honeypot=1`）或卖出税 ≥ 50%；Solana mint 仍有冻结权限（项目方能冻结买家的代币账户）或不可转账；
 * - `ok`：拿到了该币的检测结果且不命中上面任何一条；
 * - `unknown`：网络 / 限流 / 链不支持 / GoPlus 还没收录（字段为空）——绝不当成貔貅。
 */
export type HoneypotVerdict = "honeypot" | "ok" | "unknown";
export type HoneypotCheck = (address: string, chain: string, base?: string) => Promise<HoneypotVerdict>;

const GOPLUS = "https://api.gopluslabs.io";
/** gmgn 链 slug → GoPlus chain id（均在 GoPlus supported_chains 里） */
const CHAIN_IDS: Record<string, string> = { eth: "1", bsc: "56", base: "8453", monad: "143", robinhood: "4663" };
const TIMEOUT_MS = 8_000;
const MAX_SELL_TAX = 0.5;

export const Honeypot: { check: HoneypotCheck } = {
  async check(address, chain, base = GOPLUS) {
    const url = chain === "sol"
      ? `${base}/api/v1/solana/token_security?contract_addresses=${address}`
      : CHAIN_IDS[chain] ? `${base}/api/v1/token_security/${CHAIN_IDS[chain]}?contract_addresses=${address}` : null;
    if (!url) return "unknown";
    const r = await requestJson(url, { timeoutMs: TIMEOUT_MS });
    const body = r.json as { code?: unknown; message?: unknown; result?: Record<string, unknown> } | null;
    if (r.status !== 200 || body?.code !== 1 || !body.result || typeof body.result !== "object") {
      console.error(`[honeypot] ${address.slice(0, 10)} ${chain}: HTTP ${r.status} code=${String(body?.code)} ${String(body?.message ?? "")}`);
      return "unknown";
    }
    // 结果按地址键（EVM 小写；Solana 原样），取唯一那条
    const item = Object.values(body.result)[0] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return "unknown";
    return chain === "sol" ? solana(item) : evm(item);
  },
};

function evm(item: Record<string, unknown>): HoneypotVerdict {
  const flag = item.is_honeypot;
  if (flag !== "0" && flag !== "1") return "unknown";
  const sellTax = Number(item.sell_tax);
  return flag === "1" || (Number.isFinite(sellTax) && sellTax >= MAX_SELL_TAX) ? "honeypot" : "ok";
}

function solana(item: Record<string, unknown>): HoneypotVerdict {
  const freeze = (item.freezable as { status?: unknown } | undefined)?.status;
  const locked = item.non_transferable;
  if ((freeze !== "0" && freeze !== "1") || (locked !== "0" && locked !== "1")) return "unknown";
  return freeze === "1" || locked === "1" ? "honeypot" : "ok";
}
