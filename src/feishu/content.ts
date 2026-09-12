import { extractAddresses, type Extracted } from "../wechat/extract.js";
import type { RawMessage } from "./client.js";

/**
 * 飞书消息 body.content 是 JSON 字符串，按 msg_type 结构各异（text / post 富文本 / interactive 卡片 …）。
 * 这里统一拍平成一段可读文本：文字原样、链接带上 href（喊单常是 gmgn/dexscreener 链接）、
 * @ 换成人名、图片/视频/文件用占位符——图片没 OCR，不能凭空造地址。
 */

/** 只有结构、不会出现在正文里的键；其余字符串叶子（text/content/title/href/url…）都当文本收集 */
const STRUCT_KEYS: Record<string, true> = {
  tag: true,
  style: true,
  image_key: true,
  file_key: true,
  user_id: true,
  id: true,
  key: true,
  schema: true,
  type: true,
  size: true,
  color: true,
  mode: true,
  width: true,
  height: true,
  align: true,
  template: true,
  icon: true,
  img_key: true,
  element_id: true,
  scale_type: true,
  preview: true,
  transparent: true,
  wide_screen_mode: true,
  enable_forward: true,
  update_multi: true,
  language: true,
  behavior: true,
  version: true,
  config: true,
};

const PLACEHOLDER_BY_TYPE: Record<string, string> = {
  image: "[图片]",
  file: "[文件]",
  audio: "[语音]",
  media: "[视频]",
  sticker: "[表情]",
  video_chat: "[视频通话]",
  share_chat: "[群名片]",
  share_user: "[个人名片]",
  share_calendar_event: "[日程]",
  location: "[位置]",
  merge_forward: "[合并转发]",
  system: "[系统消息]",
  hongbao: "[红包]",
  todo: "[任务]",
  vote: "[投票]",
  folder: "[文件夹]",
  calendar: "[日程]",
  general_calendar: "[日程]",
};

/** 会解析出正文并抽地址的类型；其余只给占位符 */
const TEXTUAL: Record<string, true> = { text: true, post: true, interactive: true };

function walk(node: unknown, out: string[], depth: number): void {
  if (depth > 12 || node == null) return;
  if (typeof node === "string") {
    if (node.trim()) out.push(node.trim());
    return;
  }
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  switch (o.tag) {
    case "at":
      out.push(`@${typeof o.user_name === "string" && o.user_name ? o.user_name : String(o.user_id ?? "")}`);
      return;
    case "img":
      out.push("[图片]");
      return;
    case "media":
      out.push("[视频]");
      return;
    case "emotion":
    case "hr":
      return;
    case "a":
    case "link": {
      const text = typeof o.text === "string" ? o.text.trim() : "";
      const href = typeof o.href === "string" ? o.href : typeof o.url === "string" ? o.url : "";
      if (text) out.push(text);
      if (href && href !== text) out.push(href);
      return;
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (STRUCT_KEYS[k]) continue;
    // post 同时带 content 与 content_v2（同一段富文本两种编码），只走一份
    if (k === "content_v2" && "content" in o) continue;
    if (typeof v === "string") {
      // 卡片里的 url 对象 {url, android_url, ios_url, pc_url} 只留一份
      if (k === "android_url" || k === "ios_url" || k === "pc_url") continue;
      if (v.trim()) out.push(v.trim());
    } else walk(v, out, depth + 1);
  }
}

/** post 内容可能包了一层语言键 {"zh_cn": {...}}，取第一份 */
function unwrapLocale(o: Record<string, unknown>): unknown {
  if ("content" in o || "title" in o || "elements" in o || "text" in o) return o;
  const first = Object.values(o)[0];
  return first && typeof first === "object" ? first : o;
}

export interface Rendered {
  /** 可读文本（已把 @_user_N 换成人名，链接展开成 href） */
  text: string;
  /** 是否有可供抽地址的正文（图片/表情等没有） */
  textual: boolean;
}

export function renderContent(m: RawMessage): Rendered {
  if (m.deleted) return { text: "[已撤回]", textual: false };
  const type = m.msg_type;
  if (!TEXTUAL[type]) return { text: PLACEHOLDER_BY_TYPE[type] ?? `[${type}]`, textual: false };
  const raw = m.body?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  const out: string[] = [];
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null; // JSON.parse 的对象分支，仅按 unknown 值读取
  if (type === "text") {
    out.push(obj && typeof obj.text === "string" ? obj.text : raw);
  } else {
    walk(obj && type === "post" ? unwrapLocale(obj) : parsed, out, 0);
  }
  let text = out.join(" ").replace(/\s+/g, " ").trim();
  for (const men of m.mentions ?? []) {
    if (!men.key) continue;
    text = text.split(men.key).join(`@${men.name || men.id || ""}`);
  }
  return { text: text || (type === "interactive" ? "[卡片]" : ""), textual: true };
}

/** 发送者显示名：API with_sender_name 给的 name，没有就用原始 id（open_id / app_id） */
export function senderName(m: RawMessage): string {
  return m.sender?.name?.trim() || m.sender?.id || "?";
}

/** 复用微信的地址/链提取（baseType 1 = 纯文本路径，飞书这边已经把链接展开进文本） */
export function extractFromMessage(m: RawMessage): Extracted & Rendered {
  const r = renderContent(m);
  if (!r.textual) return { ...r, addrs: [], chainHint: null };
  return { ...r, ...extractAddresses(r.text, 1) };
}
