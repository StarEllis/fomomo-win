import WebSocket from "ws";
import { extractAddresses } from "../wechat/extract.js";
import { RECENT_BACKFILL, type ContextRow, type GroupMsg, type GroupSummary, type MonitorEvent, type SourceHealth } from "../core/messages.js";

type OneBotEvent = Record<string, any>;

/** 点「重新连接」后等握手的上限：本机 NapCat 正常是几十毫秒，连不上也就是立刻 ECONNREFUSED */
const RECONNECT_WAIT_MS = 3_000;
const DEFAULT_URL = "ws://127.0.0.1:8080";
type Group = { id: string; name: string; recent: ContextRow[]; state: "starting" | "monitoring" | "error"; error?: string; lastTimestamp: number; lastText: string };

/** OneBot 11 forward-WebSocket client. QQ itself is not started or logged in by Fomomo. */
export class QQMonitor {
  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private requestSeq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private groups = new Map<string, Group>();
  private selected = new Set<string>();
  private seen = new Set<string>();
  private connected = false;
  private lastError: string | null = null;
  /**
   * 用户对 QQ 表过态：设置里启用了（或老的 FOMOMO_ONEBOT_ENABLED）、选过群、点过「重新连接」、或在界面上列过群。
   * 没表过态就不去连本机 8080 —— 不用 QQ 的人不该有一个每 3s 重试的后台循环。
   */
  private wanted: boolean;

  constructor(
    private readonly sinceTs: number,
    private readonly onMsg: (m: GroupMsg) => void,
    private readonly onEvent: (e: MonitorEvent) => void,
    opts: { url?: string; token?: string } = {},
  ) {
    this.url = opts.url ?? process.env.FOMOMO_ONEBOT_WS_URL ?? DEFAULT_URL;
    this.token = opts.token ?? process.env.FOMOMO_ONEBOT_TOKEN ?? "";
    this.wanted = process.env.FOMOMO_ONEBOT_ENABLED === "1";
  }

  /**
   * 应用 dashboard 里的 QQ 设置（启动时和每次保存时调）。启用与否只看设置（环境变量只决定设置的默认值）；
   * url / token 留空回退到环境变量与默认地址；
   * 地址或口令变了就断开重连；关掉且一个群都没选时断开并停止重试
   */
  configure(c: { enabled: boolean; url: string; token: string }): void {
    const url = c.url || process.env.FOMOMO_ONEBOT_WS_URL || DEFAULT_URL;
    const token = c.token || process.env.FOMOMO_ONEBOT_TOKEN || "";
    const changed = url !== this.url || token !== this.token;
    this.url = url;
    this.token = token;
    if (c.enabled) this.wanted = true;
    else if (!this.selected.size) {
      const had = Boolean(this.ws || this.connected);
      this.wanted = false;
      this.drop();
      this.lastError = null;
      if (had) this.onEvent({ t: "groups" });
      return;
    }
    if (changed) {
      this.drop();
      this.lastError = null;
    }
    if (this.wanted || this.selected.size) this.connect();
    if (changed) this.onEvent({ t: "groups" });
  }

  /** 就绪 = OneBot 连上了。一个群都没选时也照样连，否则用户永远看不到「已连接」、也列不出群 */
  status() {
    return { supported: true, ready: this.connected, configured: Boolean(this.url), enabled: this.wanted || this.selected.size > 0, url: this.url, error: this.lastError };
  }

  /** 断开当前连接且不排重连（先摘回调：旧 socket 的 close 会排重连、还会把新连接清成 null） */
  private drop(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const old = this.ws;
    this.ws = null;
    this.connected = false;
    if (old) {
      old.removeAllListeners();
      old.on("error", () => {});
      old.close();
    }
  }

  /** 界面轮询状态时调一下：NapCat 后起的、或断开后重来的，都能自己接上，不用等用户点按钮 */
  probe(): void {
    if (this.wanted || this.selected.size) this.connect();
  }

  health(): SourceHealth {
    let failing = 0;
    let error: string | null = null;
    for (const id of this.selected) {
      const g = this.groups.get(id);
      if (g?.state !== "error") continue;
      failing++;
      error ??= `${g.name}: ${g.error ?? "拉取失败"}`;
    }
    if (!error && !this.connected) error = this.lastError || `连不上 OneBot（${this.url}）`;
    return { watching: this.selected.size, failing, error };
  }

  /**
   * Drop the current socket and establish a fresh OneBot connection.
   * 等一下握手结果（最多 RECONNECT_WAIT_MS）：界面按完按钮直接看到「已连接」或「还是连不上」，
   * 不会先闪一下未连接再自己好起来。
   */
  async reconnect(): Promise<boolean> {
    this.drop();
    this.lastError = null;
    this.wanted = true;
    this.connect();
    this.onEvent({ t: "groups" });
    const ok = await this.waitConnected(RECONNECT_WAIT_MS);
    this.onEvent({ t: "groups" });
    return ok;
  }

  private waitConnected(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const tick = () => {
      if (this.connected) return resolve(true);
      if (this.stopped || Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
    return promise;
  }

  displayName(id: string): string { return this.groups.get(this.id(id))?.name || this.id(id); }

  sync(ids: string[], initial = false): void {
    this.selected = new Set(ids.map(String).filter(Boolean));
    for (const id of this.selected) {
      // 运行中新勾的群：连接已经在了，不该从「启动中」开始，open 也不会再来一次
      const g = this.groups.get(id) ?? { id, name: id, recent: [], state: this.connected ? "monitoring" : "starting", lastTimestamp: 0, lastText: "" };
      this.groups.set(id, g);
    }
    if (this.selected.size) {
      this.wanted = true;
      this.connect();
      if (initial) void this.backfillSelected();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("QQ 监听已停止")); }
    this.pending.clear();
    this.ws?.close(); this.ws = null; this.connected = false;
  }

  async listGroups(_refresh = false): Promise<GroupSummary[]> {
    this.wanted = true;
    this.connect();
    let list: any[] = [];
    try {
      const result = await this.call("get_group_list", {});
      if (Array.isArray(result?.data)) list = result.data;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      if (!this.groups.size) throw e;
    }
    for (const x of list) {
      const id = String(x.group_id ?? x.group_openid ?? ""); if (!id) continue;
      const g = this.groups.get(id) ?? { id, name: id, recent: [], state: "starting", lastTimestamp: 0, lastText: "" };
      if (x.group_name) g.name = String(x.group_name);
      this.groups.set(id, g);
    }
    return [...this.groups.values()].map((g) => ({ username: `qq:${g.id}`, displayName: g.name, lastTimestamp: g.lastTimestamp, summary: g.lastText, source: "qq" as const, watched: this.selected.has(g.id), ...(this.selected.has(g.id) ? { state: g.state, ...(g.error ? { error: g.error } : {}) } : {}) }));
  }

  async readAround(group: string, ts: number, before: number, after: number): Promise<ContextRow[]> {
    const g = this.groups.get(this.id(group));
    if (g?.recent.length) {
      const at = g.recent.findLastIndex((r) => Math.abs(r.createTime - ts) < 1);
      if (at >= 0) return g.recent.slice(Math.max(0, at - before + 1), at + after + 1);
    }
    try {
      const r = await this.call("get_group_msg_history", { group_id: this.id(group), count: Math.min(100, Math.max(20, before + after + 5)) });
      const rows = (Array.isArray(r?.data) ? r.data : []).map((m: any) => this.row(m)).filter(Boolean) as ContextRow[];
      rows.sort((a, b) => a.createTime - b.createTime);
      const at = rows.findIndex((x) => Math.abs(x.createTime - ts) < 2);
      return at < 0 ? rows.slice(-before - after - 1) : rows.slice(Math.max(0, at - before), at + after + 1);
    } catch { return []; }
  }

  private id(v: string): string { return v.startsWith("qq:") ? v.slice(3) : v; }

  private connect(): void {
    if (this.stopped || this.ws || this.connected) return;
    // 退避重连排着队时又被手动/轮询叫起：让这一次接管，别等到定时器再开第二条连接
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = new WebSocket(this.url, this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined);
    this.ws = ws;
    // OneBot 是推的不是拉的：连上了就是在监听。close 把已选群全标成异常，open 就得全标回来
    // （手动重连、自动重连、NapCat 重启后都走这里），否则连接早好了异常条还挂着，看着像按钮没反应
    ws.on("open", () => { this.connected = true; this.lastError = null; for (const id of this.selected) { const g = this.groups.get(id); if (g) { g.state = "monitoring"; g.error = undefined; } } this.onEvent({ t: "groups" }); });
    ws.on("message", (raw) => this.handle(JSON.parse(String(raw))));
    ws.on("error", (e) => { this.lastError = e.message; });
    ws.on("close", () => { this.ws = null; this.connected = false; for (const g of this.groups.values()) if (this.selected.has(g.id)) { g.state = "error"; g.error = this.lastError || "OneBot 连接已断开"; } if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 3000); this.onEvent({ t: "groups" }); });
  }

  private call(action: string, params: Record<string, unknown>): Promise<any> {
    this.connect();
    const echo = `fomomo-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error(`OneBot ${action} 超时`)); }, 10_000);
      this.pending.set(echo, { resolve, reject, timer });
      const send = () => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ action, params, echo })); else { clearTimeout(timer); this.pending.delete(echo); reject(new Error("OneBot 尚未连接")); } };
      // 刚启动时握手还没完成：等连上再发，否则开机第一次 backfill 必定失败、群一上来就是「异常」
      if (this.ws?.readyState === WebSocket.OPEN) send(); else void this.waitConnected(RECONNECT_WAIT_MS).then(send);
    });
  }

  private handle(e: OneBotEvent): void {
    if (e.echo && this.pending.has(String(e.echo))) { const p = this.pending.get(String(e.echo))!; this.pending.delete(String(e.echo)); clearTimeout(p.timer); if (e.status === "failed") p.reject(new Error(e.message || `OneBot retcode ${e.retcode}`)); else p.resolve(e); return; }
    if (e.post_type !== "message" || e.message_type !== "group") return;
    const id = String(e.group_id ?? ""); if (!id || !this.selected.has(id)) return;
    const msgId = String(e.message_id ?? `${e.time}:${e.user_id}:${e.raw_message ?? ""}`); if (this.seen.has(msgId)) return; this.seen.add(msgId); if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
    const text = this.text(e); const time = Number(e.time) || Math.floor(Date.now() / 1000); const sender = String(e.sender?.card || e.sender?.nickname || e.user_id || "QQ");
    const g = this.groups.get(id) ?? { id, name: id, recent: [], state: "starting", lastTimestamp: 0, lastText: "" }; this.groups.set(id, g); const row = { createTime: time, sender, text: text.slice(0, 200) }; g.recent.push(row); if (g.recent.length > RECENT_BACKFILL) g.recent.shift(); g.lastTimestamp = time; g.lastText = row.text;
    // 收到任何一条群消息就说明这个群在正常监听，不能只在「带地址」时才翻状态，
    // 否则不喊单的群永远停在「启动中」，界面上的最后一条消息也不会推给外壳
    g.state = "monitoring"; g.error = undefined; this.onEvent({ t: "groups" });
    const extracted = extractAddresses(text, 1); const addrs = extracted.addrs; if (!addrs.length) return;
    this.onMsg({ t: "msg", group: `qq:${id}`, time, sender, text: text.slice(0, 300), addrs, chainHint: extracted.chainHint, backfill: time < this.sinceTs });
  }

  private text(e: OneBotEvent): string {
    if (typeof e.raw_message === "string" && e.raw_message) return e.raw_message;
    if (typeof e.message === "string") return e.message;
    if (Array.isArray(e.message)) return e.message.map((x: any) => typeof x === "string" ? x : x.type === "text" ? x.data?.text || "" : x.data?.url || x.data?.file || "").join(" ");
    return "";
  }

  private row(m: any): ContextRow | null { const time = Number(m.time); if (!Number.isFinite(time)) return null; return { createTime: time, sender: String(m.sender?.card || m.sender?.nickname || m.user_id || "QQ"), text: this.text(m).slice(0, 200) }; }

  private async backfillSelected(): Promise<void> {
    for (const id of this.selected) {
      try { const r = await this.call("get_group_msg_history", { group_id: id, count: RECENT_BACKFILL }); const rows = (Array.isArray(r?.data) ? r.data : []).map((m: any) => ({ m, row: this.row(m) })).filter((x: any) => x.row).sort((a: any, b: any) => a.row.createTime - b.row.createTime); const g = this.groups.get(id)!; g.recent = rows.slice(-RECENT_BACKFILL).map((x: any) => x.row); for (const x of rows) { const e = x.m; const text = this.text(e); const extracted = extractAddresses(text, 1); const addrs = extracted.addrs; if (addrs.length) this.onMsg({ t: "msg", group: `qq:${id}`, time: x.row.createTime, sender: x.row.sender, text: text.slice(0, 300), addrs, chainHint: extracted.chainHint, backfill: true }); } g.state = "monitoring"; g.error = undefined; this.onEvent({ t: "groups" }); } catch (e) { const g = this.groups.get(id); if (g) { g.state = "error"; g.error = e instanceof Error ? e.message : String(e); } this.onEvent({ t: "groups" }); }
    }
  }
}
