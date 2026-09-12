/**
 * 从一条微信消息里抽合约地址。
 * - 文本（baseType 1）：正文里的 0x 地址
 * - 链接/文件（baseType 49）：appmsg XML 里的 url/title/des，群里大量是 gmgn/dexscreener 链接
 * 只认 EVM 40 位 hex；同一条消息内去重（小写归一）。
 */
const EVM_RE = /0x[a-fA-F0-9]{40}/g;

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
  for (const m of text.matchAll(EVM_RE)) {
    const a = m[0].toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    addrs.push(a);
  }
  const hint = text.match(CHAIN_HINT_RE)?.[1]?.toLowerCase() ?? null;
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
