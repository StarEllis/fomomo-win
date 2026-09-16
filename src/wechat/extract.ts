import bs58 from "bs58";

/**
 * 从一条消息里抽合约地址（微信 / 飞书共用）。
 * - 文本（baseType 1）：正文里的地址
 * - 链接/文件（baseType 49）：appmsg XML 里的 url/title/des，群里大量是 gmgn/dexscreener 链接
 * EVM：0x + 40 位 hex，小写归一。Solana：base58、前后不能紧挨字母数字、解码必须正好 32 字节（公钥），区分大小写原样保留。
 * 同一条消息内去重。
 */
const EVM_RE = /0x[a-fA-F0-9]{40}/g;
const SOL_RE = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

/** 长得像 mint 但不是 meme 喊单的：系统 / 代币程序、wSOL、主流稳定币 */
const SOL_IGNORE = new Set([
  "11111111111111111111111111111111", // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

function isSolanaKey(s: string): boolean {
  if (SOL_IGNORE.has(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Solana 地址（base58，区分大小写）；其余一律当 EVM */
export function isSolanaAddress(a: string): boolean {
  return !a.startsWith("0x");
}

/** 从 URL 路径猜链：gmgn.ai/bsc/token/0x… dexscreener.com/bsc/0x… */
const CHAIN_HINT_RE = /(?:gmgn\.ai|dexscreener\.com|debot\.ai|ave\.ai)\/(?:[a-z_]+\/)?(bsc|eth|base|sol|robinhood)\b/i;

export interface Extracted {
  addrs: string[];
  chainHint: string | null;
}

/** appmsg `<type>57</type>` = 引用回复：正文在 `<title>`，被引用的原消息在 `<refermsg>` 里 */
function isQuoteReply(raw: string): boolean {
  return /<appmsg[\s>][\s\S]*?<type>57<\/type>/.test(raw);
}

/** 群里行情机器人（阿宅5号机）回的卡片："💵战力 / 💰血量 / 👤团员"——是对别人喊单的响应，不是喊单 */
function isBotCard(text: string): boolean {
  return /战力[：:]/.test(text) && /血量[：:]/.test(text);
}

export function extractAddresses(text: string, baseType: number): Extracted {
  if (baseType !== 1 && baseType !== 49) return { addrs: [], chainHint: null };
  if (isBotCard(text)) return { addrs: [], chainHint: null };
  // 引用回复只看回复者自己写的那句（title）：被引用的地址是别人喊的，不能算回复者喊单。
  // 群里的机器人（阿宅5号机）就是引用别人贴的地址回一张行情卡，之前全被记成了它的喊单。
  if (baseType === 49 && isQuoteReply(text)) {
    text = text.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
  }
  const seen = new Set<string>();
  const addrs: string[] = [];
  const add = (a: string) => {
    if (seen.has(a)) return;
    seen.add(a);
    addrs.push(a);
  };
  for (const m of text.matchAll(EVM_RE)) add(m[0].toLowerCase());
  for (const m of text.matchAll(SOL_RE)) if (isSolanaKey(m[0])) add(m[0]);
  // 链接里的链优先；只有 Solana 地址时链就是 sol（地址格式本身就说明了链）
  const hint = text.match(CHAIN_HINT_RE)?.[1]?.toLowerCase() ?? (addrs.length > 0 && addrs.every(isSolanaAddress) ? "sol" : null);
  return { addrs, chainHint: hint };
}

/** 链接消息只留标题，别把整段 XML 推给 UI */
export function displayText(text: string, baseType: number): string {
  if (baseType === 49) {
    const title = text.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    return title ? `[链接] ${title}` : "[链接]";
  }
  return text;
}
