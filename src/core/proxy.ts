import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";

export interface Proxy {
  host: string;
  port: number;
}

/**
 * 出站 HTTP 代理：环境变量（HTTPS_PROXY / ALL_PROXY）优先，否则 macOS 系统代理（`scutil --proxy`，即 WKWebView 走的那一个）。
 * 本机系统 DNS 把 gmgn.ai / ws.gmgn.ai 解析成 0.0.0.0、api.dexscreener.com 解析成投毒 IP（2026-09-05 `dig` 实证），直连 ECONNREFUSED / 超时；
 * WKWebView 能连是因为它走系统代理由代理侧解析。Node（`ws`、fetch）都不看系统代理，所以出站请求统一从这里拿 Agent。
 * 结果缓存 30s：一次 20s 刷新会发几十个请求，不能每个都起 scutil。没有代理 → null，调用方走 Node 默认路径，行为不变。
 */
let cached: { at: number; value: Promise<Proxy | null> } | undefined;
const PROXY_TTL_MS = 30_000;

export function systemProxy(): Promise<Proxy | null> {
  if (cached && Date.now() - cached.at < PROXY_TTL_MS) return cached.value;
  cached = { at: Date.now(), value: detect() };
  return cached.value;
}

async function detect(): Promise<Proxy | null> {
  for (const k of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const v = process.env[k];
    if (!v) continue;
    try {
      const u = new URL(v);
      return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
    } catch {
      /* 格式不对就往下看 */
    }
  }
  if (process.platform !== "darwin") return null;
  const { promise, resolve } = Promise.withResolvers<string>();
  execFile("scutil", ["--proxy"], (err, stdout) => resolve(err ? "" : stdout));
  const out = await promise;
  if (!/HTTPSEnable\s*:\s*1/.test(out)) return null;
  const host = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1];
  const port = Number(/HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1]);
  return host && port ? { host, port } : null;
}

/** 经 HTTP 代理 CONNECT 隧道再握 TLS 的 Agent（给 `ws` 和 https.request 用；不引第三方 proxy-agent） */
class ConnectAgent extends https.Agent {
  constructor(private readonly proxy: Proxy) {
    super({ keepAlive: true });
  }

  override createConnection(options: https.RequestOptions, callback?: (err: Error | null, stream: Duplex) => void): undefined {
    const cb = callback!;
    const target = `${options.host}:${options.port}`;
    const req = http.request({ host: this.proxy.host, port: this.proxy.port, method: "CONNECT", path: target, headers: { Host: target }, timeout: 10_000 });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error(`proxy CONNECT ${res.statusCode}`), undefined as unknown as Duplex);
        return;
      }
      // 不设 ALPN：Cloudflare 按 TLS 指纹判定，ClientHello 里多一个 ALPN 扩展就回 403 challenge（2026-09-05 实测）
      cb(null, tls.connect({ socket, servername: options.host ?? undefined }));
    });
    req.once("error", (e) => cb(e, undefined as unknown as Duplex));
    req.once("timeout", () => req.destroy(new Error("proxy CONNECT timeout")));
    req.end();
    return undefined;
  }
}

const agents = new Map<string, ConnectAgent>();
/**
 * 直连（没系统代理）用的 Agent：Node `https.globalAgent` 的空闲 socket 5s 就销毁，用户看一眼报价再点下一个（>5s）就得重握 TLS
 * （到 OKX 接口端点实测 +0.22s，一次报价 0.23s → 0.45s）。这里空闲 socket 留 2 分钟，RPC 节点同样受益
 */
const directAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000, timeout: 120_000 });

/** 当前系统代理对应的 https Agent（按 host:port 复用连接池）；没代理 → undefined（requestJson 退到 directAgent；ws 用 Node 默认） */
export async function proxyAgent(): Promise<{ proxy: Proxy; agent: https.Agent } | undefined> {
  const proxy = await systemProxy();
  if (!proxy) return undefined;
  const key = `${proxy.host}:${proxy.port}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new ConnectAgent(proxy);
    agents.set(key, agent);
  }
  return { proxy, agent };
}

/**
 * GET JSON，走系统代理。非 2xx / 超时 / 网络错 / 非 JSON 一律 null（和之前 fetch 版语义一致）。
 * 不用 fetch：Node 22 内置的 undici 不暴露 ProxyAgent，`--use-env-proxy` 又要在进程启动前给（sidecar 由 Swift 起）；
 * `https.request` + 上面的 Agent 零依赖、零启动参数。`http://` 只给 FOMOMO_DEX_BASE 调试用，直连不过代理。
 */
export async function getJson(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<unknown> {
  const r = await requestJson(url, { timeoutMs, headers });
  return r.status >= 200 && r.status < 300 ? r.json : null;
}

export interface JsonResponse {
  /** 0 = 超时 / 网络错（没拿到响应） */
  status: number;
  /** 解析出的 JSON；非 JSON / 没响应 → null */
  json: unknown;
  /** body 不是 JSON 时的原文（挑战页 / 空 body）；JSON 解析成功或没响应 → undefined */
  text?: string;
}

/**
 * 任意方法的 JSON 请求（`https.request` HTTP/1.1，走系统代理），返回状态码 + 解析后的 body，调用方自己按状态码处理。
 * fomo.family 的 REST 门就在这层：Node `https`（HTTP/1.1 + 浏览器 UA）能过，undici `fetch` 一律 430（docs/adr/0005）。
 */
export async function requestJson(url: string, opts: { method?: "GET" | "POST" | "PUT"; headers?: Record<string, string>; body?: unknown; timeoutMs: number }): Promise<JsonResponse> {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  const agent = secure ? ((await proxyAgent())?.agent ?? directAgent) : undefined;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  const { promise, resolve } = Promise.withResolvers<JsonResponse>();
  const req = (secure ? https : http).request(u, { agent, method: opts.method ?? "GET", headers }, (res) => {
    const status = res.statusCode ?? 0;
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ status, json: JSON.parse(text) });
      } catch {
        /* 非 JSON（挑战页 / 空 body）→ json null，原文留给调用方 */
        resolve({ status, json: null, text });
      }
    });
    res.on("error", () => resolve({ status, json: null }));
  });
  const timer = setTimeout(() => req.destroy(new Error("timeout")), opts.timeoutMs);
  req.on("error", () => resolve({ status: 0, json: null }));
  req.on("close", () => clearTimeout(timer));
  req.end(payload);
  return promise;
}
