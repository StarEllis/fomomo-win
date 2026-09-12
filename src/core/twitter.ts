import { requestJson } from "./proxy.js";
import type { Tweet } from "./types.js";

/**
 * 代币官方推特的内容（资料里 link.twitter 指向的那条推文 / 那个账号）。
 * - `x.com/<user>/status/<id>` → X 的 syndication 接口（无鉴权，过系统代理 proxy.ts），拿正文/作者/图片/点赞
 * - `x.com/i/web/status/<id>` / `x.com/i/status/<id>` → X 的系统路由，`i` 不是用户名：只有推文 id，作者要等拉到推文才知道
 * - `x.com/<user>` → 没有可靠的公开时间线接口（syndication 的 timeline-profile 会 429），
 *   由调用方用 gmgn 搜索结果里该账号本人的推文兜底
 * - `x.com/i/…` 其它（communities / flow / …）既不是账号也不是推文 → null
 */
export function parseTwitterLink(url: string): { screen?: string; statusId?: string } | null {
  const m = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})(?:\/(?:web\/)?status\/(\d+))?/i);
  if (!m) return null;
  const [, screen, statusId] = m;
  if (screen.toLowerCase() === "i") return statusId ? { statusId } : null;
  return statusId ? { screen, statusId } : { screen };
}

type SyndUser = { screen_name?: string; name?: string; profile_image_url_https?: string; is_blue_verified?: boolean; verified?: boolean };
type Syndication = {
  id_str?: string;
  text?: string;
  created_at?: string;
  favorite_count?: number;
  user?: SyndUser;
  mediaDetails?: Array<{ media_url_https?: string; type?: string }>;
  quoted_tweet?: Syndication;
};

function toTweet(j: Syndication, id: string, quoted: Tweet | null): Tweet | null {
  const screen = j.user?.screen_name;
  if (!screen || !j.text) return null;
  return {
    id: j.id_str ?? id,
    url: `https://x.com/${screen}/status/${j.id_str ?? id}`,
    time: j.created_at ? Math.floor(Date.parse(j.created_at) / 1000) : 0,
    kind: quoted ? "quote" : "tweet",
    user: {
      name: j.user?.name ?? screen,
      screen,
      // syndication 给的是 _normal（48px），换成 _400x400
      avatar: (j.user?.profile_image_url_https ?? "").replace("_normal.", "_400x400."),
      followers: 0,
      verified: j.user?.is_blue_verified === true || j.user?.verified === true,
    },
    text: j.text,
    likes: j.favorite_count,
    image: j.mediaDetails?.find((m) => m.type === "photo")?.media_url_https,
    translation: null,
    quoted,
  };
}

export async function fetchTweet(id: string): Promise<Tweet | null> {
  // 保留备用接口的 HTTP 错误；不能经 getJson 把限流/网络失败折成空数据。
  const r = await requestJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`, {
    timeoutMs: 10_000,
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15" },
  });
  if (r.status === 0) throw new Error("网络错误或请求超时");
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  if (r.json === null) throw new Error("响应不是有效 JSON");
  const j = r.json as Syndication;
  const q = j.quoted_tweet;
  return toTweet(j, id, q?.id_str ? toTweet(q, q.id_str, null) : null);
}
