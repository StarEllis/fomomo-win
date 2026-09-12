import { execFile } from "node:child_process";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  type Chain as ViemChain,
  type Hex,
  type Log,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  getAddress,
  HttpRequestError,
  RpcRequestError,
  TransactionReceiptNotFoundError,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet, monad, robinhood } from "viem/chains";
import { PUBLIC_RPC } from "./erc20.js";
import type { EvmTx, TradeChain } from "./okx.js";
import { requestJson } from "./proxy.js";

/**
 * 本地 burner 热钱包：私钥放 macOS Keychain，进程内只有 viem account / solana Keypair 对象。
 * 对外只暴露地址与「签名 / 发送」，私钥永不进日志、事件、返回值——engine 层拿不到它。
 */

export type EvmChain = Exclude<TradeChain, "sol">;

export interface SecretStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
}

/** account: "evm" = 0x 私钥 hex；"sol" = base58 secretKey（64 字节） */
export const WALLET_SERVICE = "fomomo.wallet";

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string }>();
  execFile("security", args, { encoding: "utf8" }, (err, stdout) => {
    const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
    resolve({ code, stdout });
  });
  return promise;
}

/**
 * macOS Keychain（`security` CLI，execFile 不走 shell，不受特殊字符影响）。
 * 已知妥协：`add-generic-password` 不支持从 stdin 读值，`-w <value>` 会让 secret 瞬时出现在该进程 argv（ps 可见），
 * 进程结束即消失；本机单用户场景可接受。读取用 `-w` 走 stdout，不进 argv。
 */
export class KeychainStore implements SecretStore {
  async get(service: string, account: string): Promise<string | null> {
    const r = await security(["find-generic-password", "-s", service, "-a", account, "-w"]);
    if (r.code === 44) return null; // errSecItemNotFound
    if (r.code !== 0) throw new Error(`keychain read failed (exit ${r.code})`);
    return r.stdout.replace(/\n$/, "");
  }
  async set(service: string, account: string, value: string): Promise<void> {
    // -U：已存在则更新；否则 add 会以 45（duplicate）失败
    const r = await security(["add-generic-password", "-U", "-s", service, "-a", account, "-w", value]);
    if (r.code !== 0) throw new Error(`keychain write failed (exit ${r.code})`);
  }
}

/** 测试用；不落盘 */
export class MemoryStore implements SecretStore {
  private readonly m = new Map<string, string>();
  private static key(service: string, account: string): string {
    return `${service}\0${account}`;
  }
  async get(service: string, account: string): Promise<string | null> {
    return this.m.get(MemoryStore.key(service, account)) ?? null;
  }
  async set(service: string, account: string, value: string): Promise<void> {
    this.m.set(MemoryStore.key(service, account), value);
  }
  async delete(service: string, account: string): Promise<void> {
    this.m.delete(MemoryStore.key(service, account));
  }
}

/** 覆盖默认公共节点 */
export interface RpcConfig {
  evm: Partial<Record<EvmChain, string>>;
  sol?: string;
}

const publicRpc = (slug: EvmChain): string => {
  const c = PUBLIC_RPC.find((c) => c.slug === slug);
  if (c === undefined) throw new Error(`erc20.ts PUBLIC_RPC missing ${slug}`);
  return c.url;
};

export const DEFAULT_RPC: { evm: Record<EvmChain, string>; sol: string } = {
  evm: { eth: publicRpc("eth"), bsc: publicRpc("bsc"), base: publicRpc("base"), monad: publicRpc("monad"), robinhood: publicRpc("robinhood") },
  sol: "https://api.mainnet-beta.solana.com",
};

/** viem 2.56 内置全部五条链（monad 143 / robinhood 4663 都在 viem/chains） */
const VIEM_CHAIN: Record<EvmChain, ViemChain> = { eth: mainnet, bsc, base, monad, robinhood };

/** sendSol / 余额查询只用到的这几个方法；`Connection` 结构上满足，测试可注入假实现 */
export interface SolConnection {
  getBalance(owner: PublicKey): Promise<number>;
  getParsedTokenAccountsByOwner(owner: PublicKey, filter: { mint: PublicKey }): Promise<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }> }>;
  getLatestBlockhash(commitment: "confirmed"): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(raw: Uint8Array, opts: { skipPreflight: boolean; preflightCommitment: "confirmed" }): Promise<string>;
  confirmTransaction(strategy: { signature: string; blockhash: string; lastValidBlockHeight: number }, commitment: "confirmed"): Promise<{ value: { err: unknown } }>;
  getSignatureStatuses(signatures: string[]): Promise<{ value: Array<{ err: unknown; confirmationStatus?: string | null } | null> }>;
}

/** 测试注入点；生产用默认 `Connection(rpc.sol)` */
export interface WalletDeps {
  sol?: SolConnection;
}

const RPC_TIMEOUT_MS = 15_000;
let rpcId = 1;

/**
 * viem 传输层不用它自带的 `http()`（底层 fetch，不走系统代理，见 proxy.ts），改成 requestJson 驮 JSON-RPC。
 * 错误按 viem 自己的 RpcRequestError / HttpRequestError 抛，call/estimateGas 才能把 code 3 识别成 revert。
 */
function proxiedTransport(url: string) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const body = { jsonrpc: "2.0", id: rpcId++, method, params: params ?? [] };
      const r = await requestJson(url, { method: "POST", timeoutMs: RPC_TIMEOUT_MS, body });
      const res = r.json !== null && typeof r.json === "object" ? (r.json as { result?: unknown; error?: { code: number; message: string; data?: unknown } }) : null;
      // 节点用非 2xx 也照样带 JSON-RPC error 时（publicnode 403 拒 archive 方法），错误消息比状态码有用，按 RpcRequestError 抛
      if (res?.error !== undefined) throw new RpcRequestError({ body, error: res.error, url });
      if (r.status < 200 || r.status >= 300 || res === null) {
        throw new HttpRequestError({ body, status: r.status || undefined, url, details: r.status === 0 ? "no response" : (r.text ?? "non-JSON body") });
      }
      return res.result;
    },
  }, { retryCount: 0 });
}

/** 上链回执：status reverted = 交易上链但失败（gas 已花） */
export interface EvmReceipt {
  hash: `0x${string}`;
  status: "success" | "reverted";
  logs: Log[];
}

/** Solana 交易已广播但确认为失败（有 signature 可查） */
export class SolTxError extends Error {
  constructor(readonly signature: string, err: string) {
    super(`solana tx ${signature} failed: ${err}`);
    this.name = "SolTxError";
  }
}

export class BurnerWallet {
  readonly evmAddress: `0x${string}`;
  readonly solAddress: string;
  readonly #evm: PrivateKeyAccount;
  readonly #sol: Keypair;
  readonly #rpc: { evm: Record<EvmChain, string>; sol: string };
  readonly #publics = new Map<EvmChain, PublicClient>();
  readonly #wallets = new Map<EvmChain, WalletClient>();
  #solConn: SolConnection | undefined;

  private constructor(evm: PrivateKeyAccount, sol: Keypair, rpc: RpcConfig | undefined, deps: WalletDeps | undefined) {
    this.#evm = evm;
    this.#sol = sol;
    this.#rpc = { evm: { ...DEFAULT_RPC.evm, ...rpc?.evm }, sol: rpc?.sol ?? DEFAULT_RPC.sol };
    this.#solConn = deps?.sol;
    this.evmAddress = evm.address;
    this.solAddress = sol.publicKey.toBase58();
  }

  /** 两把都在才算有；只剩一把视为损坏，返回 null 让上层决定 */
  static async load(store: SecretStore, rpc?: RpcConfig, deps?: WalletDeps): Promise<BurnerWallet | null> {
    const [evmKey, solKey] = await Promise.all([store.get(WALLET_SERVICE, "evm"), store.get(WALLET_SERVICE, "sol")]);
    if (evmKey === null || solKey === null) return null;
    return new BurnerWallet(privateKeyToAccount(evmKey as Hex), Keypair.fromSecretKey(bs58.decode(solKey)), rpc, deps);
  }

  /** 任一已存在即拒绝：覆盖 = 资金丢失 */
  static async create(store: SecretStore, rpc?: RpcConfig, deps?: WalletDeps): Promise<BurnerWallet> {
    const [evmKey, solKey] = await Promise.all([store.get(WALLET_SERVICE, "evm"), store.get(WALLET_SERVICE, "sol")]);
    if (evmKey !== null || solKey !== null) throw new Error("burner wallet already exists; refusing to overwrite");
    const pk = generatePrivateKey();
    const evm = privateKeyToAccount(pk);
    const sol = Keypair.generate();
    await store.set(WALLET_SERVICE, "evm", pk);
    await store.set(WALLET_SERVICE, "sol", bs58.encode(sol.secretKey));
    return new BurnerWallet(evm, sol, rpc, deps);
  }

  /** 节点当前 gasPrice（OKX approve-transaction 响应没给 gasPrice 时用） */
  gasPrice(chain: EvmChain): Promise<bigint> {
    return this.#public(chain).getGasPrice();
  }

  nativeBalance(chain: TradeChain): Promise<bigint> {
    if (chain === "sol") return this.#solConnection().getBalance(this.#sol.publicKey).then(BigInt);
    return this.#public(chain).getBalance({ address: this.evmAddress });
  }

  erc20Balance(chain: EvmChain, token: string): Promise<bigint> {
    return this.#public(chain).readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [this.evmAddress] });
  }

  erc20Decimals(chain: EvmChain, token: string): Promise<number> {
    return this.#public(chain).readContract({ address: getAddress(token), abi: erc20Abi, functionName: "decimals" });
  }

  erc20Allowance(chain: EvmChain, token: string, spender: string): Promise<bigint> {
    return this.#public(chain).readContract({ address: getAddress(token), abi: erc20Abi, functionName: "allowance", args: [this.evmAddress, getAddress(spender)] });
  }

  /** 同 mint 可能有多个 token account（ATA + 历史手建），求和；没有账户 → amount 0、decimals null（mint 精度要另问） */
  async splBalance(mint: string): Promise<{ amount: bigint; decimals: number | null }> {
    const r = await this.#solConnection().getParsedTokenAccountsByOwner(this.#sol.publicKey, { mint: new PublicKey(mint) });
    let amount = 0n;
    let decimals: number | null = null;
    for (const a of r.value) {
      const t = a.account.data.parsed.info.tokenAmount;
      amount += BigInt(t.amount);
      decimals ??= t.decimals;
    }
    return { amount, decimals };
  }

  /**
   * gas 按 OKX 给的 ×1.5（聚合器估算偏紧，meme 币 transfer 钩子常超）；有 maxPriorityFeePerGas → EIP-1559（maxFeePerGas=gasPrice），否则 legacy。
   * 广播前 eth_call 一次当模拟：revert 直接抛，不花 gas。拿到 hash 先回调 `onSubmitted`（调用方据此落 submitted），再等回执（超时由调用方控制）；
   * 回执里带 logs 给调用方解析到账（Transfer 到我们地址）。
   */
  async sendEvm(chain: EvmChain, tx: EvmTx, onSubmitted?: (hash: `0x${string}`) => void): Promise<EvmReceipt> {
    const pub = this.#public(chain);
    const base = { account: this.#evm, to: tx.to, data: tx.data, value: tx.value } as const;
    await pub.call(base);
    const wallet = this.#wallet(chain);
    const gas = (tx.gas * 3n) / 2n;
    const hash =
      tx.maxPriorityFeePerGas === null
        ? await wallet.sendTransaction({ ...base, chain: VIEM_CHAIN[chain], gas, gasPrice: tx.gasPrice })
        : await wallet.sendTransaction({ ...base, chain: VIEM_CHAIN[chain], gas, maxFeePerGas: tx.gasPrice, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
    onSubmitted?.(hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status, logs: receipt.logs };
  }

  /**
   * 对账：问一次回执。三态——有回执 / null（节点明确说还没上链）/ 抛错（节点没答上来：限流、403、断网）。
   * 调用方必须区分后两者：只有节点明确的「没有」才能累计到「放弃」，节点出错不能当没上链。
   */
  async receiptEvm(chain: EvmChain, hash: `0x${string}`): Promise<EvmReceipt | null> {
    try {
      const receipt = await this.#public(chain).getTransactionReceipt({ hash });
      return { hash, status: receipt.status, logs: receipt.logs };
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    }
  }

  /**
   * OKX 返回的是已编好的完整交易（base58），fee payer 是我们。blockhash 在 OKX 侧生成、到我们手里可能已过期，
   * 统一换成最新的再签。v0 失败才回退 legacy `Transaction`。
   */
  async sendSol(txBase58: string, onSubmitted?: (signature: string) => void): Promise<{ signature: string }> {
    const conn = this.#solConnection();
    const bytes = bs58.decode(txBase58);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    let raw: Uint8Array;
    let versioned: VersionedTransaction | null = null;
    try {
      versioned = VersionedTransaction.deserialize(bytes);
    } catch {
      versioned = null;
    }
    if (versioned !== null) {
      versioned.message.recentBlockhash = blockhash;
      versioned.sign([this.#sol]);
      raw = versioned.serialize();
    } else {
      const legacy = Transaction.from(bytes);
      legacy.recentBlockhash = blockhash;
      legacy.feePayer ??= this.#sol.publicKey;
      legacy.sign(this.#sol);
      raw = legacy.serialize();
    }
    const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
    onSubmitted?.(signature);
    const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err !== null && res.value.err !== undefined) throw new SolTxError(signature, JSON.stringify(res.value.err));
    return { signature };
  }

  /** 对账：已广播的 Solana 签名现在什么状态（节点找不到 = 还在飞或已丢） */
  async solStatus(signature: string): Promise<"success" | "failed" | "pending"> {
    const r = await this.#solConnection().getSignatureStatuses([signature]);
    const s = r.value[0];
    if (!s) return "pending";
    if (s.err !== null && s.err !== undefined) return "failed";
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "success" : "pending";
  }

  /** 只签不发（测试用，确定性）；gas / 费用规则与 sendEvm 一致 */
  signEvmOffline(chain: EvmChain, tx: EvmTx, nonce: number): Promise<`0x${string}`> {
    const gas = (tx.gas * 3n) / 2n;
    const common = { chainId: VIEM_CHAIN[chain].id, to: tx.to, data: tx.data, value: tx.value, gas, nonce } as const;
    return tx.maxPriorityFeePerGas === null
      ? this.#evm.signTransaction({ ...common, type: "legacy", gasPrice: tx.gasPrice })
      : this.#evm.signTransaction({ ...common, type: "eip1559", maxFeePerGas: tx.gasPrice, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
  }

  #public(chain: EvmChain): PublicClient {
    let c = this.#publics.get(chain);
    if (c === undefined) {
      c = createPublicClient({ chain: VIEM_CHAIN[chain], transport: proxiedTransport(this.#rpc.evm[chain]) });
      this.#publics.set(chain, c);
    }
    return c;
  }

  #wallet(chain: EvmChain): WalletClient {
    let c = this.#wallets.get(chain);
    if (c === undefined) {
      c = createWalletClient({ account: this.#evm, chain: VIEM_CHAIN[chain], transport: proxiedTransport(this.#rpc.evm[chain]) });
      this.#wallets.set(chain, c);
    }
    return c;
  }

  #solConnection(): SolConnection {
    this.#solConn ??= new Connection(this.#rpc.sol, "confirmed");
    return this.#solConn;
  }
}
