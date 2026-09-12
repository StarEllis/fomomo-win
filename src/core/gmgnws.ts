import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { proxyAgent } from "./proxy.js";

/** gmgn 实时成交（token_activity 频道一条） */
export interface Trade {
  chain: string;
  address: string;
  /** 秒 */
  time: number;
  /** USD 单价 */
  price: number;
  /** USD 成交额 */
  volume: number;
  side: "buy" | "sell";
}

/**
 * gmgn 行情 WebSocket：`wss://ws.gmgn.ai/v2/ws`
 * 2026-09 实测：不需要 cookie，带浏览器 UA + Origin 直连即可（Node 自带的 undici WebSocket 会被 Cloudflare 403，`ws` 包正常）；
 * 协议：`{action:"subscribe",channel,id,data:[...]}`，同一频道再次 subscribe 会**整体替换**订阅集合（`data:[]` = 清空），
 * 没有 unsubscribe；服务端每 5s 发 heartbeat，客户端回 `{action:"heartbeat",client_ts,srv_ts}`。
 * 只订 `token_activity`（逐笔成交），用它把 K 线最后一根实时推着走。
 *
 * 重连：`connect()` 是唯一建连处、`schedule()` 是唯一定时器处；失败只在 close 事件里处理（ws 保证 error 之后必有 close），
 * 退避 1s ×2 到 60s 封顶，连上即归零；退避期间 `watch()` 只更新目标不抢连。同一失败原因只在退避档位变化时记一行日志。
 */
export class GmgnWs {
  private ws: WebSocket | null = null;
  private want: { chain: string; address: string } | null = null;
  /** 0 = 上次连接成功 / 从未失败；否则下次重连要等的毫秒数 */
  private backoff = 0;
  private timer: NodeJS.Timeout | undefined;
  private connecting = false;
  private closed = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastError = "";
  private lastLog = "";
  private srvTs = 0;
  private readonly deviceId = randomUUID();
  private readonly uuid = randomUUID().replace(/-/g, "").slice(0, 16);
  onTrade: ((t: Trade) => void) | null = null;
  /** 和 TLS 指纹一起被 Cloudflare 校验：Chrome/128 这串能过，Chrome/139 或 Safari UA 配 Node 的 ClientHello 就 403 challenge（2026-09-05 实测），不要随手升版本号 */
  private static readonly UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  private static readonly BACKOFF_MIN = 1000;
  private static readonly BACKOFF_MAX = 60_000;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 关注某个代币的成交流；传 null 清空订阅（弹卡关了） */
  watch(target: { chain: string; address: string } | null): void {
    this.want = target;
    if (!target) {
      if (this.connected) this.sendSubscribe([]);
      return;
    }
    if (this.connected) this.sendSubscribe([target]);
    else if (!this.timer) void this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  private url(): string {
    const q = new URLSearchParams({
      device_id: this.deviceId,
      tab_id: this.uuid.slice(0, 12),
      fp_did: this.uuid,
      client_id: "gmgn_web_20260903-4023-98b0841",
      from_app: "gmgn",
      app_ver: "20260903-4023-98b0841",
      tz_name: "Asia/Singapore",
      tz_offset: "28800",
      app_lang: "en-US",
      os: "web",
      worker: "0",
      uuid: this.uuid,
      reconnect: this.backoff ? "1" : "0",
    });
    return `wss://ws.gmgn.ai/v2/ws?${q}`;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.ws || this.connecting) return;
    this.connecting = true;
    const via = await proxyAgent();
    this.connecting = false;
    if (this.closed || this.ws) return;
    const ws = new WebSocket(this.url(), {
      headers: { Origin: "https://gmgn.ai", "User-Agent": GmgnWs.UA },
      agent: via?.agent,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;
    this.lastError = "";
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.backoff = 0;
      this.lastLog = "";
      console.error(`[gmgn-ws] connected${via ? ` via ${via.proxy.host}:${via.proxy.port}` : ""}`);
      if (this.want) this.sendSubscribe([this.want]);
      this.startHeartbeat();
    });
    ws.on("message", (m) => this.onMessage(m.toString()));
    // 握手失败时 ws 先 error 再 close：这里只记原因，重连统一在 close 里做
    ws.on("error", (e: NodeJS.ErrnoException) => {
      if (this.ws === ws) this.lastError = e.message || e.code || String(e);
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.closed) return;
      this.schedule(code);
    });
  }

  private schedule(code: number): void {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, GmgnWs.BACKOFF_MAX) : GmgnWs.BACKOFF_MIN;
    const line = `closed ${code}${this.lastError ? ` (${this.lastError})` : ""}; retry in ${this.backoff}ms`;
    if (line !== this.lastLog) {
      this.lastLog = line;
      console.error(`[gmgn-ws] ${line}`);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, this.backoff);
  }

  private sendSubscribe(targets: Array<{ chain: string; address: string }>): void {
    this.ws?.send(
      JSON.stringify({
        action: "subscribe",
        channel: "token_activity",
        f: "w",
        id: randomUUID().replace(/-/g, "").slice(0, 16),
        data: targets.map((t) => ({ chain: t.chain, addresses: t.address })),
      }),
    );
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.connected) this.ws!.send(JSON.stringify({ action: "heartbeat", client_ts: Date.now(), srv_ts: this.srvTs }));
    }, 5000);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private onMessage(raw: string): void {
    let msg: { channel?: string; action?: string; srv_ts?: number; data?: Array<Record<string, unknown>> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.action === "heartbeat" || msg.channel === "heartbeat") {
      if (typeof msg.srv_ts === "number") this.srvTs = msg.srv_ts;
      return;
    }
    if (msg.channel !== "token_activity" || !Array.isArray(msg.data) || !this.onTrade) return;
    const want = this.want;
    for (const d of msg.data) {
      const address = String(d.a ?? "");
      // 订阅集合已替换但旧代币的尾巴还在流：按当前关注过滤
      if (!want || address.toLowerCase() !== want.address.toLowerCase()) continue;
      const price = Number(d.pu), volume = Number(d.au), time = Number(d.t);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) continue;
      this.onTrade({ chain: String(d.n ?? want.chain), address: want.address, time, price, volume: Number.isFinite(volume) ? volume : 0, side: d.e === "sell" ? "sell" : "buy" });
    }
  }
}
