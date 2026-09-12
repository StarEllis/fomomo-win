import { requestJson } from "./proxy.js";

/**
 * 「这个 0x 地址到底是不是 ERC20」的只读三态探测，给行情源（Dex/GMGN）都查不到的地址兜底：
 * - `erc20`：任一支持链上是合约且 `balanceOf/totalSupply/allowance` 都返回合法 uint256 字（全 0 也算合法——刚部署的空币）；
 * - `non-erc20`：五条链上**每条**都拿到了确定的否定（EOA `0x` 代码 / 接口 revert / 返回空或长度不对的字节）；
 * - `unknown`：其它一切——网络、限流、节点错误、响应形状不对、chainId 对不上、链不支持、地址不是 EVM。
 * 契约：RPC 挂了绝不能变成 `non-erc20`；只有 `balanceOf` 也不够（NFT 也有），`allowance` 是把 ERC721 挡在门外的那一问。
 * 只发只读 JSON-RPC 到公共节点，不带钱包/密钥，永不签名。
 */
export type Erc20Verdict = "erc20" | "non-erc20" | "unknown";

interface Chain {
  slug: string;
  url: string;
  chainId: number;
}

/**
 * 公共节点；slug 与 gmgn 链口径一致（`fomo.ts` NETWORK_TO_CHAIN）。测试注入 rpcBase 时路由到 `${rpcBase}/${slug}`。
 * wallet.ts 广播后靠 `eth_getTransactionReceipt` 等回执 / 对账，节点必须服务这一问：publicnode 的 BSC 免费档把它算「archive」直接 403
 * （2026-09-10 真钱首单撞上：广播成功、等回执 403 → unknown，对账也永远 403），故 BSC 用币安官方 dataseed；其余四条已实测回 null 正常。
 */
const CHAINS: readonly Chain[] = [
  { slug: "eth", url: "https://ethereum-rpc.publicnode.com", chainId: 1 },
  { slug: "bsc", url: "https://bsc-dataseed.bnbchain.org", chainId: 56 },
  { slug: "base", url: "https://mainnet.base.org", chainId: 8453 },
  { slug: "monad", url: "https://rpc.monad.xyz", chainId: 143 },
  { slug: "robinhood", url: "https://rpc.mainnet.chain.robinhood.com", chainId: 4663 },
];
/** 供 wallet.ts 复用同一套公共节点，别再抄一份 */
export const PUBLIC_RPC = CHAINS;

const TIMEOUT_MS = 5_000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD_HEX = /^0x[0-9a-fA-F]{64}$/;
const BYTES_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY_HEX = /^0x[0-9a-fA-F]{1,64}$/;
const REVERT_MESSAGE = /^(?:execution reverted\b|VM Exception while processing transaction: revert\b)/i;

/** 固定非零占位地址：有的代币对 address(0) 直接 revert，不能拿零地址当查询参数 */
const DUMMY_OWNER = "0x000000000000000000000000000000000000dEaD";
const DUMMY_SPENDER = "0x000000000000000000000000000000000000bEEF";
const SEL_BALANCE_OF = "0x70a08231";
const SEL_TOTAL_SUPPLY = "0x18160ddd";
const SEL_ALLOWANCE = "0xdd62ed3e";
const padAddress = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const CALLS: readonly { label: string; data: string }[] = [
  { label: "balanceOf", data: SEL_BALANCE_OF + padAddress(DUMMY_OWNER) },
  { label: "totalSupply", data: SEL_TOTAL_SUPPLY },
  { label: "allowance", data: SEL_ALLOWANCE + padAddress(DUMMY_OWNER) + padAddress(DUMMY_SPENDER) },
];

type Rpc = { kind: "result"; value: unknown } | { kind: "revert" } | { kind: "unavailable"; why: string };

let nextId = 1;

export const Erc20 = {
  /**
   * 先探 `chainHint`（命中即返回，不再问其它链），否则按 CHAINS 顺序逐链探测；hint 只是优先级，不是权威——
   * 行情源标错链的币在别的链上照样能被认成 ERC20，而否定必须五链全确认。
   * 非 EVM 地址、非空但不在支持表里的 hint（sol / 未配置链）→ `unknown`：不假装查过没配置的链。
   */
  async check(address: string, chainHint: string | null = null, rpcBase?: string): Promise<Erc20Verdict> {
    if (typeof address !== "string" || !EVM_ADDRESS.test(address)) return "unknown";
    const hinted = chainHint === null ? null : (CHAINS.find((c) => c.slug === chainHint) ?? null);
    if (chainHint !== null && hinted === null) return "unknown";
    const order = hinted === null ? CHAINS : [hinted, ...CHAINS.filter((c) => c !== hinted)];
    let negatives = 0;
    for (const chain of order) {
      const v = await probeChain(chain, address, rpcBase);
      if (v === "erc20") return "erc20";
      if (v === "non-erc20") negatives++;
    }
    return negatives === CHAINS.length ? "non-erc20" : "unknown";
  },
};

/** 单链三态：chainId 对不上 → unknown（节点被错路由时的否定不可信）；EOA 直接否定不再 eth_call；三问任一确定否定即否定，全合法即肯定 */
async function probeChain(chain: Chain, address: string, rpcBase?: string): Promise<Erc20Verdict> {
  const url = rpcBase ? `${rpcBase}/${chain.slug}` : chain.url;
  const [chainId, code] = await Promise.all([rpc(url, "eth_chainId", []), rpc(url, "eth_getCode", [address, "latest"])]);
  if (chainId.kind !== "result" || typeof chainId.value !== "string" || !QUANTITY_HEX.test(chainId.value)) {
    log(chain, address, "chainId unavailable");
    return "unknown";
  }
  if (BigInt(chainId.value) !== BigInt(chain.chainId)) {
    log(chain, address, `chainId mismatch: ${chainId.value}`);
    return "unknown";
  }
  if (code.kind !== "result" || typeof code.value !== "string" || !BYTES_HEX.test(code.value)) {
    log(chain, address, "getCode unavailable");
    return "unknown";
  }
  if (code.value === "0x") return "non-erc20";
  const results = await Promise.all(CALLS.map((c) => rpc(url, "eth_call", [{ to: address, data: c.data }, "latest"])));
  let unavailable = false;
  for (let i = 0; i < CALLS.length; i++) {
    const r = results[i];
    if (r.kind === "revert") return "non-erc20";
    if (r.kind === "unavailable") {
      log(chain, address, `${CALLS[i].label}: ${r.why}`);
      unavailable = true;
      continue;
    }
    // 合法字节但不是一个 uint256 字（`0x` / 长度不对）= 接口对不上，是确定的否定；非法形状才是节点问题
    if (typeof r.value !== "string" || !BYTES_HEX.test(r.value)) {
      log(chain, address, `${CALLS[i].label}: malformed result`);
      unavailable = true;
      continue;
    }
    if (!WORD_HEX.test(r.value)) return "non-erc20";
  }
  return unavailable ? "unknown" : "erc20";
}

/**
 * 单条 JSON-RPC 2.0：id 必须回显、`result`/`error` 恰有其一。
 * `revert` 只认 error code 3 或消息里明说 execution reverted——泛 -32000（header not found / 限流 / 节点内部错）一律 `unavailable`。
 */
async function rpc(url: string, method: string, params: unknown[]): Promise<Rpc> {
  const id = nextId++;
  const r = await requestJson(url, { method: "POST", timeoutMs: TIMEOUT_MS, body: { jsonrpc: "2.0", id, method, params } });
  if (r.status < 200 || r.status >= 300) return { kind: "unavailable", why: `HTTP ${r.status || "no response"}` };
  const body = r.json;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { kind: "unavailable", why: "non-JSON body" };
  if (at(body, "jsonrpc") !== "2.0" || at(body, "id") !== id) return { kind: "unavailable", why: "malformed envelope" };
  const hasResult = "result" in body;
  const hasError = "error" in body;
  if (hasResult === hasError) return { kind: "unavailable", why: "malformed envelope" };
  if (hasResult) return { kind: "result", value: body.result };
  const error = at(body, "error");
  const code = at(error, "code");
  const message = at(error, "message");
  if (typeof code !== "number" || !Number.isInteger(code) || typeof message !== "string") return { kind: "unavailable", why: "malformed rpc error" };
  if (code === 3 || REVERT_MESSAGE.test(message)) return { kind: "revert" };
  return { kind: "unavailable", why: `rpc error ${code}` };
}

function at(v: unknown, key: string): unknown {
  return v !== null && typeof v === "object" && key in v ? (v as Record<string, unknown>)[key] : undefined;
}

function log(chain: Chain, address: string, why: string): void {
  console.error(`[erc20] ${chain.slug} ${address.slice(0, 10)}: ${why}`);
}
