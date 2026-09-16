import { CONTEXT_AFTER, CONTEXT_BEFORE, RECENT_BACKFILL, type ContextRow, type GroupMsg, type GroupSummary, type MonitorEvent, type SourceHealth } from "../core/messages.js";
import { LarkCliClient, LarkError, type FeishuTransport, type RawChat, type RawMessage } from "./client.js";
import { extractFromMessage, renderContent, senderName } from "./content.js";

/**
 * 飞书群监控：一轮 = 所有到期的群并发各起一个 lark-cli（上限 MAX_CONCURRENCY），每群把 [watermark-120s, now]
 * 的历史分页取完；整轮结束立刻下一轮，正常路径不 sleep、不积压。出错按群退避让其它健康群继续。
 * 限流配额（1000/min & 50/s）是所有群共享的，所以限流不算某个群的错误：整体暂停一段时间再开下一轮。
 * 只读：GET /open-apis/im/v1/messages，不用 search（索引延迟不明，会漏新消息）。
 * 去重靠 message_id，120s 重叠窗口吃掉边界与时钟偏差；watermark 只在该群整轮分页全部成功后推进。
 */

const OVERLAP_MS = 120_000;
const HEARTBEAT_MS = 5_000;
const PAGE_SIZE = 50;
const CHATS_TTL_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** 每群内存里保留的最近消息条数（预览 / 语境）；运行中新勾选的群也用这一批做回灌 */
const RECENT_LIMIT = RECENT_BACKFILL;
/** 同时在飞的 lark-cli 进程上限；每个进程 ≈1s，8 路已远低于 50/s 配额 */
const MAX_CONCURRENCY = 8;
const RATE_LIMIT_PAUSE_MS = 15_000;

const FEISHU_PREFIX = "feishu:";

function chatIdOf(group: string): string {
  return group.startsWith(FEISHU_PREFIX) ? group.slice(FEISHU_PREFIX.length) : group;
}

interface CachedMessage {
  id: string;
  row: ContextRow;
}

interface PendingContext {
  msg: GroupMsg;
  rows: CachedMessage[];
  call: number;
}

interface Group {
  id: string;
  /** 已完整取到的时间上界（毫秒）；下一轮从 wm-120s 起 */
  wmMs: number;
  /** 早于此刻的消息不发：首批群从 sinceTs 起；运行中加入的群在预热后压到最近 RECENT_LIMIT 条里最早那条 */
  floorMs: number;
  /** 早于此刻的消息标 backfill：首批群 = 进程启动时刻，运行中加入的群 = 勾选时刻 */
  startedAtMs: number;
  /** 运行中加入的群：预热拿到的最近 RECENT_LIMIT 条要当回灌发出去，而不只是进缓存 */
  backfillRecent: boolean;
  /** message_id → create_time(ms)，随 watermark 修剪，只保留重叠窗口内的 */
  seen: Map<string, number>;
  warmed: boolean;
  recent: CachedMessage[];
  /** Only unfinished CA windows survive across polls; ordinary history is capped at 100. */
  pending: PendingContext[];
  state: "starting" | "monitoring" | "error";
  error?: string;
  failures: number;
  nextRetryAt: number;
  lastMsgSec: number;
  lastText: string;
}

export class FeishuMonitor {
  private readonly client: FeishuTransport;
  private readonly groups = new Map<string, Group>();
  private order: string[] = [];
  private worker: Promise<void> | undefined;
  private readonly inflight = new Map<string, AbortController>();
  /** 限流后整体暂停到此刻；连续限流指数加长，任一群成功即清零 */
  private pausedUntil = 0;
  private rateLimitStreak = 0;
  private wakeUp: (() => void) | null = null;
  private stopped = false;
  private polls = 0;
  private maxTime: number;
  private lastHeartbeat = 0;
  private readonly startedAtMs = Date.now();

  private chatsCache: { at: number; list: RawChat[] } | null = null;
  private chatsInflight: Promise<RawChat[]> | null = null;
  private readonly names = new Map<string, string>();
  private readonly contextInflight = new Map<string, Promise<ContextRow[]>>();

  constructor(
    private readonly sinceTs: number,
    private readonly onMsg: (m: GroupMsg) => void,
    private readonly onEvent: (e: MonitorEvent) => void,
    client?: FeishuTransport,
  ) {
    this.client = client ?? new LarkCliClient();
    this.maxTime = sinceTs;
  }

  /** 接受 feishu:oc_xxx 或 oc_xxx；群名还没拉到时先回 id，拉到后会发 groups 事件让上层刷新 */
  displayName(group: string): string {
    const id = chatIdOf(group);
    return this.names.get(id) ?? id;
  }

  /** 让运行中的集合等于 chatIds。initial=true：首批按 sinceTs 回灌；之后加入的群回灌最近 RECENT_LIMIT 条再接着监听 */
  sync(chatIds: string[], initial = false): void {
    if (this.stopped) return;
    const now = Date.now();
    const want = new Set(chatIds.map(chatIdOf).filter(Boolean));
    for (const id of this.groups.keys()) {
      if (want.has(id)) continue;
      this.groups.delete(id);
      this.inflight.get(id)?.abort();
      console.error(`[feishu] stop ${id}`);
    }
    let needNames = false;
    for (const id of want) {
      if (!this.names.has(id)) needNames = true;
      if (this.groups.has(id)) continue;
      const from = initial ? this.sinceTs * 1000 : now;
      this.groups.set(id, {
        id,
        wmMs: from,
        floorMs: from,
        startedAtMs: initial ? this.startedAtMs : now,
        backfillRecent: !initial,
        seen: new Map(),
        warmed: false,
        recent: [],
        pending: [],
        state: "starting",
        failures: 0,
        nextRetryAt: 0,
        lastMsgSec: 0,
        lastText: "",
      });
      console.error(`[feishu] start ${id} since=${Math.floor(from / 1000)}${initial ? " (backfill)" : ` (last ${RECENT_LIMIT})`}`);
    }
    this.order = [...want];
    if (needNames) void this.loadChats(false).catch(() => undefined);
    this.ensureWorker();
    this.wake();
  }

  health(): SourceHealth {
    let failing = 0;
    let error: string | null = null;
    for (const g of this.groups.values()) {
      if (g.state !== "error") continue;
      failing++;
      error ??= `${this.displayName(g.id)}: ${g.error ?? "拉取失败"}`;
    }
    // 限流是全局的，不算某个群异常，但用户该知道为什么半天不更新
    if (!error && this.pausedUntil > Date.now()) error = `飞书限流中，约 ${Math.ceil((this.pausedUntil - Date.now()) / 1000)}s 后自动继续`;
    return { watching: this.groups.size, failing, error };
  }

  /**
   * 一键重试：异常群最长会退避到 5 分钟（未登录 / 无权限那类从 1 分钟起），用户刚修好登录时不该干等。
   * 清掉退避与限流暂停、把异常群打回「启动中」，立刻叫醒轮询。返回被重试的群数。
   */
  retryNow(): number {
    if (this.stopped) return 0;
    this.pausedUntil = 0;
    this.rateLimitStreak = 0;
    this.chatsCache = null;
    let n = 0;
    for (const g of this.groups.values()) {
      if (g.state !== "error") continue;
      g.failures = 0;
      g.nextRetryAt = 0;
      g.state = "starting";
      g.error = undefined;
      n++;
    }
    console.error(`[feishu] retry now: ${n} group(s)`);
    this.ensureWorker();
    this.wake();
    this.onEvent({ t: "groups" });
    return n;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const ac of this.inflight.values()) ac.abort();
    this.wake();
    await Promise.all([this.worker, this.client.stop()]);
    this.groups.clear();
    this.order = [];
  }

  private ensureWorker(): void {
    if (this.worker || this.stopped || this.groups.size === 0) return;
    this.worker = this.loop().finally(() => {
      this.worker = undefined;
      // 循环因为群清空而退出、同一 tick 又加了群
      this.ensureWorker();
    });
  }

  private wake(): void {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  /** 等到 sync/stop 唤醒，或到 untilMs（无则一直等） */
  private sleepUntil(untilMs: number | undefined): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      if (this.wakeUp === done) this.wakeUp = null;
      resolve();
    };
    this.wakeUp = done;
    if (untilMs !== undefined) timer = setTimeout(done, Math.max(0, untilMs - Date.now()));
    return promise;
  }

  /** 本轮到期的群，保持选中顺序 */
  private due(now: number): Group[] {
    const out: Group[] = [];
    for (const id of this.order) {
      const g = this.groups.get(id);
      if (g && g.nextRetryAt <= now) out.push(g);
    }
    return out;
  }

  private async loop(): Promise<void> {
    while (!this.stopped && this.groups.size > 0) {
      const now = Date.now();
      if (this.pausedUntil > now) {
        await this.sleepUntil(this.pausedUntil);
        continue;
      }
      const due = this.due(now);
      if (due.length === 0) {
        // 全都在退避：等最近到期的那个，或配置变化
        let soonest: number | undefined;
        for (const x of this.groups.values()) soonest = soonest === undefined ? x.nextRetryAt : Math.min(soonest, x.nextRetryAt);
        await this.sleepUntil(soonest);
        continue;
      }
      await this.round(due);
      if (this.stopped) break;
      const t = Date.now();
      if (t - this.lastHeartbeat >= HEARTBEAT_MS) {
        this.lastHeartbeat = t;
        this.onEvent({ t: "heartbeat", maxTime: this.maxTime, polls: this.polls });
      }
    }
  }

  /** 一轮：到期的群并发 poll，最多 MAX_CONCURRENCY 路；全部结束才返回（轮次屏障） */
  private async round(due: Group[]): Promise<void> {
    let next = 0;
    const lane = async () => {
      while (next < due.length && !this.stopped) {
        const g = due[next++];
        if (this.alive(g)) await this.poll(g);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, due.length) }, lane));
  }

  private alive(g: Group): boolean {
    return !this.stopped && this.groups.get(g.id) === g;
  }

  /** 一轮：固定 end 边界，从 wm-120s 起升序分页取完；成功才推进 wm，失败退避 */
  private async poll(g: Group): Promise<void> {
    const ac = new AbortController();
    this.inflight.set(g.id, ac);
    const endSec = Math.ceil(Date.now() / 1000);
    const startSec = Math.floor((g.wmMs - OVERLAP_MS) / 1000);
    let token = "";
    const window: CachedMessage[] = [];
    try {
      if (!g.warmed) {
        // 预热：最近 RECENT_LIMIT 条。首批群只进预览缓存（它们的回灌走下面的时间窗）；
        // 运行中新勾选的群把 floor 压到这批里最早那条，整批当回灌发出去（startedAtMs = 勾选时刻，所以都标 backfill）
        const latest = await this.collect(g.id, { order: "desc", startTime: 0, endTime: endSec }, () => true, RECENT_LIMIT, ac.signal);
        if (!this.alive(g)) return;
        latest.reverse();
        if (g.backfillRecent && latest.length) {
          g.floorMs = Math.min(g.floorMs, Number(latest[0].create_time));
          for (const m of latest) this.handle(g, m, window);
        } else {
          for (const m of latest) this.remember(g, m);
        }
        g.warmed = true;
        this.onEvent({ t: "groups" });
      }
      do {
        const page = await this.client.listMessages({ chatId: g.id, startTime: startSec, endTime: endSec, order: "asc", pageToken: token || undefined, pageSize: PAGE_SIZE }, ac.signal);
        if (!this.alive(g)) return; // 取消/关停后迟到的一页：丢弃，不 emit
        for (const m of page.items) this.handle(g, m, window);
        if (page.hasMore && (!page.pageToken || page.pageToken === token)) throw new LarkError("飞书消息分页游标未推进", "api");
        token = page.hasMore ? page.pageToken : "";
      } while (token && this.alive(g));
      if (!this.alive(g)) return;
      g.wmMs = Math.max(g.wmMs, endSec * 1000);
      const keepFrom = g.wmMs - OVERLAP_MS - 5_000;
      for (const [id, ms] of g.seen) if (ms < keepFrom) g.seen.delete(id);
      this.polls++;
      g.failures = 0;
      g.nextRetryAt = 0;
      this.rateLimitStreak = 0;
      if (g.state !== "monitoring") {
        g.state = "monitoring";
        g.error = undefined;
        console.error(`[feishu] ${g.id} monitoring`);
        this.onEvent({ t: "groups" });
      }
    } catch (e) {
      if (!this.alive(g) || (e instanceof LarkError && e.kind === "aborted")) return;
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof LarkError && e.kind === "rate-limit") {
        // 配额是全局的：不把每个群翻成错误态，整体暂停。暂停期间不会开新轮，所以还在暂停就说明是同一轮里别的群撞到同一次限流，不再叠加
        if (this.pausedUntil <= Date.now()) {
          const pause = Math.min(RATE_LIMIT_PAUSE_MS * 2 ** Math.min(this.rateLimitStreak, 4), MAX_BACKOFF_MS);
          this.rateLimitStreak++;
          this.pausedUntil = Date.now() + pause;
          console.error(`[feishu] rate limited, pausing all groups ${pause / 1000}s: ${message}`);
          this.onEvent({ t: "error", message: `飞书限流，暂停 ${pause / 1000}s 后继续：${message}` });
        }
        return;
      }
      g.failures++;
      // 临时错误 2s 起指数退避；未登录/无权限/退群这类打了也没用，1 分钟起
      const base = e instanceof LarkError && !e.transient ? 60_000 : 2_000;
      g.nextRetryAt = Date.now() + Math.min(base * 2 ** Math.min(g.failures - 1, 8), MAX_BACKOFF_MS);
      const wasError = g.state === "error";
      g.state = "error";
      g.error = message;
      console.error(`[feishu] ${g.id} poll error (#${g.failures}): ${message}`);
      if (!wasError) {
        this.onEvent({ t: "error", message: `${this.displayName(g.id)}: ${message}` });
        this.onEvent({ t: "groups" });
      }
    } finally {
      if (this.inflight.get(g.id) === ac) this.inflight.delete(g.id);
    }
  }

  /** Render once for the bounded cache; an overlap page must not replace newer previews. */
  private remember(g: Group, m: RawMessage): CachedMessage | undefined {
    const ms = Number(m.create_time);
    if (!Number.isFinite(ms) || !m.message_id || m.deleted || m.msg_type === "system") return;
    const known = g.recent.find((r) => r.id === m.message_id);
    if (known) return known;
    const row: ContextRow = { createTime: ms / 1000, sender: senderName(m), text: renderContent(m).text.slice(0, 200) };
    const entry = { id: m.message_id, row };
    let at = g.recent.length;
    while (at > 0 && g.recent[at - 1].row.createTime > row.createTime) at--;
    if (g.recent.length < RECENT_LIMIT || at > 0) {
      g.recent.splice(at, 0, entry);
      if (g.recent.length > RECENT_LIMIT) g.recent.shift();
    }
    if (row.createTime >= g.lastMsgSec) {
      g.lastMsgSec = row.createTime;
      g.lastText = row.text.slice(0, 120);
    }
    return entry;
  }

  private publishContext(c: PendingContext): void {
    this.onEvent({ t: "context", msg: c.msg, rows: c.rows.map((r) => r.row), call: c.call });
  }

  /** Capture before filtering calls: ordinary messages supply previews and CA surroundings. */
  private handle(g: Group, m: RawMessage, window: CachedMessage[]): void {
    const entry = this.remember(g, m);
    if (!entry) return;
    const ms = Number(m.create_time);
    const fresh = !g.seen.has(m.message_id);
    if (!window.some((r) => r.id === entry.id)) {
      window.push(entry);
      if (window.length > CONTEXT_BEFORE) window.shift();
    }
    for (let i = g.pending.length - 1; i >= 0; i--) {
      const c = g.pending[i];
      if (!fresh || entry.row.createTime < c.msg.time || c.rows.some((r) => r.id === entry.id)) continue;
      c.rows.push(entry);
      this.publishContext(c);
      if (c.rows.length - c.call - 1 >= CONTEXT_AFTER) g.pending.splice(i, 1);
    }
    if (!fresh) return;
    g.seen.set(m.message_id, ms);
    if (ms < g.floorMs) return;
    const sec = ms / 1000;
    this.maxTime = Math.max(this.maxTime, sec);
    const { text, textual, addrs, chainHint } = extractFromMessage(m);
    if (!textual || addrs.length === 0) return;
    const msg: GroupMsg = {
      t: "msg", group: FEISHU_PREFIX + g.id, time: sec, sender: entry.row.sender,
      text: text.slice(0, 300), addrs, chainHint, backfill: ms < g.startedAtMs,
    };
    this.onMsg(msg);
    const at = g.recent.findIndex((r) => r.id === entry.id);
    const before = at < 0 ? [] : g.recent.slice(Math.max(0, at - CONTEXT_BEFORE + 1), at + 1);
    const prefix = before.length >= window.length ? before : window;
    const rows = [...prefix, ...(at < 0 ? [] : g.recent.slice(at + 1, at + 1 + CONTEXT_AFTER))];
    const c: PendingContext = { msg, rows, call: prefix.length - 1 };
    this.publishContext(c);
    if (rows.length - c.call - 1 < CONTEXT_AFTER) g.pending.push(c);
  }

  /** 群列表（带 TTL 缓存与在飞去重）；失败抛出，让接口回 500 而不是假装没群 */
  private loadChats(refresh: boolean): Promise<RawChat[]> {
    if (!refresh && this.chatsCache && Date.now() - this.chatsCache.at < CHATS_TTL_MS) return Promise.resolve(this.chatsCache.list);
    if (this.chatsInflight) return this.chatsInflight;
    const p = this.client
      .listChats()
      .then((list) => {
        this.chatsCache = { at: Date.now(), list };
        let changed = false;
        for (const c of list) {
          const name = c.name?.trim() || c.chat_id;
          if (this.groups.has(c.chat_id) && this.names.get(c.chat_id) !== name) changed = true;
          this.names.set(c.chat_id, name);
        }
        if (changed && !this.stopped) this.onEvent({ t: "groups" });
        return list;
      })
      .finally(() => {
        if (this.chatsInflight === p) this.chatsInflight = null;
      });
    this.chatsInflight = p;
    return p;
  }

  /** 当前用户可见的全部群 + 正在监控但已不可见的群；watched/state/error 反映实时监控状态 */
  async listGroups(refresh = false): Promise<GroupSummary[]> {
    if (this.stopped) throw new LarkError("飞书监控已关闭", "aborted");
    const chats = await this.loadChats(refresh);
    const out: GroupSummary[] = [];
    const seen = new Set<string>();
    for (const c of chats) {
      if (c.chat_mode === "p2p") continue;
      seen.add(c.chat_id);
      const g = this.groups.get(c.chat_id);
      out.push({
        username: FEISHU_PREFIX + c.chat_id,
        displayName: c.name?.trim() || c.chat_id,
        lastTimestamp: g?.lastMsgSec ?? 0,
        summary: g?.lastText || (c.description ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        source: "feishu",
        watched: Boolean(g),
        ...(g ? { state: g.state } : {}),
        ...(g?.error ? { error: g.error } : {}),
      });
    }
    for (const g of this.groups.values()) {
      if (seen.has(g.id)) continue;
      out.push({
        username: FEISHU_PREFIX + g.id,
        displayName: this.displayName(g.id),
        lastTimestamp: g.lastMsgSec,
        summary: g.lastText,
        source: "feishu",
        watched: true,
        state: g.state,
        error: g.error ?? "当前账号已不在该群（或群不可见），请取消勾选",
      });
    }
    return out;
  }

  /**
   * Prefer the recent 100 in memory. Older CA calls can still recover their small context from the API.
   * Ordinary cache eviction never writes history to the database.
   */
  readAround(group: string, ts: number, before: number, after: number): Promise<ContextRow[]> {
    if (this.stopped) return Promise.reject(new LarkError("飞书监控已关闭", "aborted"));
    const id = chatIdOf(group);
    const tsMs = Math.round(ts * 1000);
    const recent = this.groups.get(id)?.recent;
    if (recent) {
      const at = recent.findLastIndex((r) => Math.round(r.row.createTime * 1000) === tsMs);
      if (at >= 0) return Promise.resolve(recent.slice(Math.max(0, at - before + 1), at + after + 1).map((r) => r.row));
    }
    const key = `${id}|${tsMs}|${before}|${after}`;
    const hit = this.contextInflight.get(key);
    if (hit) return hit;
    const p = this.fetchAround(id, tsMs, before, after).finally(() => {
      this.contextInflight.delete(key);
    });
    this.contextInflight.set(key, p);
    return p;
  }

  private async fetchAround(id: string, tsMs: number, before: number, after: number): Promise<ContextRow[]> {
    const pre = before > 0 ? await this.collect(id, { order: "desc", endTime: Math.floor(tsMs / 1000) + 1 }, (ms) => ms <= tsMs, before) : [];
    const post = after > 0 ? await this.collect(id, { order: "asc", startTime: Math.floor(tsMs / 1000) }, (ms) => ms > tsMs, after) : [];
    return [...pre.reverse(), ...post].map((m) => ({
      createTime: Number(m.create_time) / 1000,
      sender: senderName(m),
      text: renderContent(m).text.slice(0, 200),
    }));
  }

  /** 按给定方向分页，直到凑够 n 条通过 accept 的、非系统/非撤回消息 */
  private async collect(id: string, range: { order: "asc" | "desc"; startTime?: number; endTime?: number }, accept: (ms: number) => boolean, n: number, signal?: AbortSignal): Promise<RawMessage[]> {
    const out: RawMessage[] = [];
    let token = "";
    do {
      if (this.stopped || signal?.aborted) throw new LarkError("飞书读取已取消", "aborted");
      const page = await this.client.listMessages({ chatId: id, ...range, pageToken: token || undefined, pageSize: PAGE_SIZE }, signal);
      if (this.stopped || signal?.aborted) throw new LarkError("飞书读取已取消", "aborted");
      for (const m of page.items) {
        const ms = Number(m.create_time);
        if (!Number.isFinite(ms) || !accept(ms) || m.deleted || m.msg_type === "system") continue;
        out.push(m);
        if (out.length >= n) break;
      }
      if (!page.hasMore || out.length >= n) break;
      if (!page.pageToken || page.pageToken === token) throw new LarkError("飞书上下文分页游标未推进", "api");
      token = page.pageToken;
    } while (true);
    return out;
  }
}
