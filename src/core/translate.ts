import { getJson } from "./proxy.js";
import type { Tweet } from "./types.js";

/**
 * 推文中文译文。
 *
 * 来源：Google 翻译的 Chrome 词典扩展端点 `clients5.google.com/translate_a/t?client=dict-chrome-ex`（免 key、非官方；2026-09-05 实测
 * 本机直连和系统代理都通，而 `translate.googleapis.com/translate_a/single?client=gtx` 从代理出口回 429「Sorry…」）。
 * 不用 gmgn 自己的 `/vas/api/v1/twitter/cooking/translate` / `/api/v1/translate/translate_id`：两者 `authType: Access` =
 * 要 gmgn 账号登录后的 Bearer awsToken，未登录回 `40101611 empty token`，和「不登录」的前提冲突。
 *
 * 风险：非官方端点，Google 可能限频（429）或改格式；量很小（每个弹卡 1–2 条、按 tweet id 缓存）所以可接受。失败 → 留 null，下次刷新再试。
 * 已经是中文的原文（检测到 zh-*）也记 null，不重复请求。
 */
const ENDPOINT = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=zh-CN&q=";
const TIMEOUT_MS = 8_000;
const MAX_CHARS = 4_000;

/** tweet id → 译文；null = 原文已是中文，不用翻。进程内缓存，落库的 Tweet.translation 是第二层 */
const cache = new Map<string, string | null>();

/** 返回 undefined = 请求失败（不缓存）；null = 不需要翻译 */
async function translate(text: string): Promise<string | null | undefined> {
  const q = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const j = await getJson(ENDPOINT + encodeURIComponent(q), TIMEOUT_MS);
  // 响应形如 [["译文","en"]]
  if (!Array.isArray(j) || !Array.isArray(j[0])) return undefined;
  const [translated, lang]: unknown[] = j[0];
  if (typeof translated !== "string" || typeof lang !== "string") return undefined;
  if (lang.startsWith("zh") || translated.trim() === q.trim()) return null;
  return translated;
}

async function fill(tw: Tweet, key: string): Promise<void> {
  if (tw.translation) return;
  if (cache.has(key)) {
    tw.translation = cache.get(key) ?? null;
    return;
  }
  const r = await translate(tw.text);
  if (r === undefined) return;
  cache.set(key, r);
  tw.translation = r;
}

/** 补上 `translation`（推文本身 + 被引用的原推）。已有译文 / 已缓存的不再请求 */
export async function translateTweet(tw: Tweet): Promise<void> {
  await Promise.all([fill(tw, tw.id), tw.quoted ? fill(tw.quoted, tw.quoted.id || `${tw.id}:quoted`) : undefined]);
}
