import { WechatWatcher, type WatchEvent } from "../wechat/watch.js";
import { RECENT_BACKFILL, type GroupMsg, type SourceHealth } from "./messages.js";

type GroupState = { state: "starting" | "monitoring" | "error"; error?: string };

/**
 * 多群监听：每个群一个 WechatWatcher（各自开一套只读分片句柄，互不影响），
 * dashboard 改了群列表就 add/remove，不用重启 sidecar。
 */
export class WatchManager {
  private readonly running = new Map<string, WechatWatcher>();
  /** 已选群 → 监听状态。watcher 死了会从 running 里删掉，但状态留着，界面才看得到「异常」也才能一键重启 */
  private readonly states = new Map<string, GroupState>();
  private lookup: WechatWatcher | undefined;
  get reader(): WechatWatcher {
    return (this.lookup ??= new WechatWatcher());
  }

  constructor(
    private readonly sinceTs: number,
    private readonly onMsg: (m: GroupMsg) => void,
    private readonly onEvent: (e: Exclude<WatchEvent, { t: "msg" }>, group: string) => void,
  ) {}

  displayName(username: string): string {
    try {
      return this.reader.display(username);
    } catch {
      return username;
    }
  }

  /** 群聊上下文：优先用该群 watcher 常开的分片句柄（毫秒级），没在监听的群才重开库 */
  readAround(group: string, ts: number, before: number, after: number) {
    return (this.running.get(group) ?? this.reader).readAround(group, ts, before, after);
  }

  /** 某个群当下的监听状态，没选的群返回 undefined（群组页的「监听中 / 启动中 / 异常」标签） */
  groupState(username: string): GroupState | undefined {
    return this.states.get(username);
  }

  health(): SourceHealth {
    let failing = 0;
    let error: string | null = null;
    for (const [g, s] of this.states) {
      if (s.state !== "error") continue;
      failing++;
      error ??= `${this.displayName(g)}: ${s.error ?? "监听已停止"}`;
    }
    return { watching: this.states.size, failing, error };
  }

  /**
   * 一键重启微信监听：停掉全部 watcher（含查名用的那个，换过密钥 / 微信新建分片后要重开库才认）再按原群单起一遍。
   * 界面的「异常处理」按钮走这里；重启后按最近 RECENT_BACKFILL 条回灌，不会重复处理更早的喊单。
   */
  restart(): number {
    const groups = [...this.states.keys()];
    for (const w of this.running.values()) w.stop();
    this.running.clear();
    this.states.clear();
    this.lookup?.stop();
    this.lookup = undefined;
    console.error(`[watch] restart ${groups.length} group(s)`);
    this.sync(groups);
    return groups.length;
  }

  /** 让 running 的集合等于 groups：多的停掉，少的起 */
  sync(groups: string[]): void {
    const want = new Set(groups);
    for (const [g, w] of this.running) {
      if (!want.has(g)) {
        w.stop();
        this.running.delete(g);
        console.error(`[watch] stop ${g}`);
      }
    }
    for (const g of this.states.keys()) if (!want.has(g)) this.states.delete(g);
    for (const g of want) {
      if (this.running.has(g)) continue;
      try {
        this.start(g);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.states.set(g, { state: "error", error: message });
        this.onEvent({ t: "error", message }, g);
      }
    }
  }

  private start(group: string): void {
    const w = new WechatWatcher();
    this.running.set(group, w);
    this.states.set(group, { state: "starting" });
    // 首批群按 sinceTs 回灌；之后 dashboard 加的群回灌最近 RECENT_BACKFILL 条再接着监听
    const opts = this.firstBatch ? { sinceTs: this.sinceTs } : { lastN: RECENT_BACKFILL };
    void w
      .watch(group, opts, (e) => {
        if (this.running.get(group) !== w) return;
        // 第一条消息 / 心跳就说明库打开了、轮询在跑
        if (this.states.get(group)?.state !== "monitoring") this.states.set(group, { state: "monitoring" });
        if (e.t === "msg") this.onMsg({ ...e, group });
        else this.onEvent(e, group);
      })
      .catch((e: unknown) => {
        if (this.running.get(group) !== w) return;
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[watch] ${group} died: ${message}`);
        this.states.set(group, { state: "error", error: message });
        this.onEvent({ t: "error", message }, group);
        this.running.delete(group);
      });
  }

  /** sync() 第一次调用期间为 true：这批群都按 sinceTs 回灌 */
  private firstBatch = true;

  startInitial(groups: string[]): void {
    this.firstBatch = true;
    this.sync(groups);
    this.firstBatch = false;
  }

  stop(): void {
    for (const watcher of this.running.values()) watcher.stop();
    this.running.clear();
    this.states.clear();
    this.lookup?.stop();
  }
}
