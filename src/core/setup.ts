import { formatUnits } from "viem";
import { OkxClient, OKX_API_BASE, TRADE_CHAINS } from "./okx.js";
import { requestJson } from "./proxy.js";
import { DASHBOARD_PORT, sanitizeTrade } from "./server.js";
import { Store } from "./store.js";
import { DEFAULT_SETTINGS, NATIVE_SYMBOL, type Settings, type TradeSettings } from "./types.js";
import { BurnerWallet, KeychainStore, type RpcConfig, type SecretStore } from "./wallet.js";

/**
 * 一键买卖的本机命令（`pnpm cli okx-check | wallet-init | wallet-show | trade-config`）。
 * 本机只有一份机密：burner 私钥（macOS Keychain）。OKX 凭据不在本机（接口端点 okx.ts OKX_API_BASE 固定），
 * 本机没有对应设置项——RPC 覆盖 / 限额 / 快捷额走 dashboard 同一份 settings.trade。
 */

/** 固定只发一次 `supported/chain?chainIndex=56`：验的是到接口端点的链路，不是逐链能力——链矩阵已固定，逐链轮询只会白吃 OKX 配额 */
export async function okxCheck(): Promise<void> {
  console.error(`经 ${OKX_API_BASE}：`);
  try {
    const r = await new OkxClient().supportedChain("bsc");
    console.error(`✓ ${r.chainName}${r.dexTokenApproveAddress ? `  approve=${r.dexTokenApproveAddress}` : ""}`);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

/** 生成（或显示已有的）burner 热钱包：EVM 一把（六链通用）+ Solana 一把，私钥只在 Keychain */
export async function walletInit(store: SecretStore = new KeychainStore(), rpc?: TradeSettings["rpc"]): Promise<void> {
  const existing = await BurnerWallet.load(store, rpcConfig(rpc));
  const w = existing ?? (await BurnerWallet.create(store, rpcConfig(rpc)));
  console.error(existing ? "已有 burner 钱包（不覆盖）：" : "已生成 burner 钱包（私钥在 Keychain service fomomo.wallet）：");
  console.error(`  EVM    ${w.evmAddress}   （eth / bsc / base / monad / robinhood 通用；往要交易的链上转少量原生币作本金 + gas）`);
  console.error(`  Solana ${w.solAddress}   （转少量 SOL）`);
  console.error("只放打算用来买 meme 的小额资金：这是热钱包，私钥在这台 Mac 上。");
}

export async function walletShow(store: SecretStore = new KeychainStore(), opts: { balances: boolean; rpc?: TradeSettings["rpc"] }): Promise<void> {
  const w = await BurnerWallet.load(store, rpcConfig(opts.rpc));
  if (!w) {
    console.error("还没有 burner 钱包：先 pnpm cli wallet-init");
    process.exitCode = 1;
    return;
  }
  console.error(`EVM    ${w.evmAddress}\nSolana ${w.solAddress}`);
  if (!opts.balances) return;
  for (const chain of TRADE_CHAINS) {
    try {
      const bal = await w.nativeBalance(chain);
      console.error(`  ${chain.padEnd(9)} ${formatUnits(bal, chain === "sol" ? 9 : 18)} ${NATIVE_SYMBOL[chain]}`);
    } catch (e) {
      console.error(`  ${chain.padEnd(9)} 查询失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function rpcConfig(rpc: TradeSettings["rpc"] | undefined): RpcConfig | undefined {
  if (!rpc) return undefined;
  const { sol, ...evm } = rpc;
  return { evm, ...(sol ? { sol } : {}) };
}

/**
 * RPC 覆盖：sidecar 在跑就 PUT dashboard 接口（立即生效），否则直接写 sqlite；
 * 显式给了 --db 就只写那个库（离线 / 测试），不碰运行中的 sidecar。校验与 dashboard 同一份 `sanitizeTrade`，非法值不写、原样打印当前值让人看出没变。
 */
export async function tradeConfig(flags: Record<string, string>, dbPath?: string): Promise<TradeSettings> {
  const rpc: TradeSettings["rpc"] = {};
  for (const c of TRADE_CHAINS) if (flags[`rpc-${c}`] !== undefined) rpc[c] = flags[`rpc-${c}`];
  const merge = (cur: TradeSettings) => sanitizeTrade(Object.keys(rpc).length ? { rpc: { ...cur.rpc, ...rpc } } : {}, cur);

  const live = dbPath ? null : await requestJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/settings`, { method: "GET", timeoutMs: 1500 }).catch(() => null);
  if (live && live.status === 200 && live.json && typeof live.json === "object") {
    // 旧版 sidecar 的设置里还没有 trade 段：按默认值起步
    const next = merge((live.json as Partial<Settings>).trade ?? DEFAULT_SETTINGS.trade);
    const r = await requestJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/settings`, { method: "PUT", body: { trade: next }, timeoutMs: 3000 });
    if (r.status !== 200) throw new Error(`dashboard 拒绝了设置：HTTP ${r.status}`);
    return print((r.json as Partial<Settings>).trade ?? next, "已通过运行中的 sidecar 保存并生效");
  }
  const store = new Store(dbPath);
  const cur = store.getSettings();
  const next: Settings = { ...cur, trade: merge(cur.trade) };
  store.setSettings(next);
  return print(next.trade, dbPath ? `已写入 ${dbPath}` : "sidecar 未运行，已直接写入设置库（下次启动生效）");
}

function print(t: TradeSettings, note: string): TradeSettings {
  console.error(`${note}：\n  okx              ${OKX_API_BASE}（固定）\n  rpc              ${Object.keys(t.rpc).length ? JSON.stringify(t.rpc) : "(默认公共节点)"}\n  maxUsdPerTrade   ${t.maxUsdPerTrade}\n  maxUsdPerDay     ${t.maxUsdPerDay}`);
  return t;
}
