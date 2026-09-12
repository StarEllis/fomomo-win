import { WechatWatcher, type WatchEvent } from "../wechat/watch.js";
import { RECENT_BACKFILL, type GroupMsg } from "./messages.js";

/**
 * 多群监听：每个群一个 WechatWatcher（各自开一套只读分片句柄，互不影响），
 * dashboard 改了群列表就 add/remove，不用重启 sidecar。
 */
export class WatchManager {
  private readonly running = new Map<string, WechatWatcher>();
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
    for (const g of want) {
      if (this.running.has(g)) continue;
      try {
        this.start(g);
      } catch (e) {
        this.onEvent({ t: "error", message: e instanceof Error ? e.message : String(e) }, g);
      }
    }
  }

  private start(group: string): void {
    const w = new WechatWatcher();
    this.running.set(group, w);
    // 首批群按 sinceTs 回灌；之后 dashboard 加的群回灌最近 RECENT_BACKFILL 条再接着监听
    const opts = this.firstBatch ? { sinceTs: this.sinceTs } : { lastN: RECENT_BACKFILL };
    void w
      .watch(group, opts, (e) => {
        if (this.running.get(group) !== w) return;
        if (e.t === "msg") this.onMsg({ ...e, group });
        else this.onEvent(e, group);
      })
      .catch((e: unknown) => {
        if (this.running.get(group) !== w) return;
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[watch] ${group} died: ${message}`);
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
    this.lookup?.stop();
  }
}
