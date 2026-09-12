import type { Database as DB } from "better-sqlite3-multiple-ciphers";
import { WechatReader, baseType } from "./reader.js";
import type { WeChatMessage } from "./types.js";
import { decompressContent } from "../zstd.js";
import { extractAddresses, displayText } from "./extract.js";

/** watch() 回调事件；WatchManager 把 msg 补上 group 变成 GroupMsg，其余透传给 cli */
export type WatchEvent =
  | {
      t: "msg";
      time: number;
      sender: string;
      text: string;
      addrs: string[];
      chainHint: string | null;
      backfill: boolean;
    }
  | { t: "heartbeat"; maxTime: number; polls: number }
  | { t: "error"; message: string };

const INTERVAL_MS = 2500;
const HEARTBEAT_MS = 10_000;
/** 每隔多少轮重新枚举分片（微信新开 message_N.db 时能跟上）≈1 分钟 */
const REOPEN_EVERY = 24;

interface Shard {
  db: DB;
  table: string;
  name2id: Map<number, string>;
  /** 该分片已处理到的 (create_time, local_id) 游标 */
  cursorTime: number;
  cursorId: number;
}

/**
 * 长连接轮询：分片打开一次复用（每轮重开并解密所有库太浪费），
 * 游标用 (create_time, local_id) 双键，同秒多条不漏不重。
 */
export class WechatWatcher extends WechatReader {
  private shards: Shard[] = [];
  private polls = 0;
  private stopped = false;

  /** 分片常开时直接在句柄上查上下文（毫秒级）；还没 open（或已 stop）就退回父类的开-查-关 */
  override readAround(username: string, ts: number, before: number, after: number): WeChatMessage[] {
    if (this.shards.length === 0 || username !== this.username) return super.readAround(username, ts, before, after);
    return this.readAroundIn(this.shards, username, ts, before, after);
  }
  private username = "";

  /** 让 watch() 主循环在下一轮退出并关掉分片句柄 */
  stop(): void {
    this.stopped = true;
  }

  private openShards(username: string, sinceTs: number): void {
    this.closeShards();
    for (const s of this.findMessageShards(username)) {
      const name2id = this.loadName2Id(s.db);
      this.shards.push({ db: s.db, table: s.table, name2id, cursorTime: sinceTs, cursorId: -1 });
    }
  }

  /**
   * 「最近 n 条」的起点：各分片按 sort_seq 倒序各取 n 条，合起来第 n 大的那条所在的秒。
   * 游标是 `sort_seq >= cursor*1000`，所以同一秒里多出的几条会一起带上，不会漏；消息总数不足 n 时从头读
   */
  private recentCursor(n: number): number {
    const seqs: number[] = [];
    for (const s of this.shards) {
      const rows = s.db.prepare(`SELECT sort_seq FROM [${s.table}] ORDER BY sort_seq DESC LIMIT ?`).all(n) as Array<{ sort_seq: number | bigint }>;
      for (const r of rows) seqs.push(Number(r.sort_seq));
    }
    if (seqs.length < n) return 0;
    seqs.sort((a, b) => b - a);
    return Math.floor(seqs[n - 1] / 1000);
  }

  private closeShards(): void {
    for (const s of this.shards) {
      try {
        s.db.close();
      } catch {
        /* ignore */
      }
    }
    this.shards = [];
  }

  /** 拉一个分片在游标之后的新消息，并推进游标 */
  private pollShard(s: Shard, grp: boolean, username: string, emit: (e: WatchEvent) => void, startedAt: number): number {
    // 游标比较走 sort_seq（= create_time*1000，有索引；create_time 本身没索引，每 2s 全表扫 5 万行要 200ms，还把事件循环卡住）
    const rows = s.db
      .prepare(
        `SELECT local_id, local_type, create_time, real_sender_id,
                message_content, WCDB_CT_message_content
         FROM [${s.table}]
         WHERE sort_seq >= ? AND (sort_seq > ? OR local_id > ?)
         ORDER BY sort_seq ASC, local_id ASC
         LIMIT 500`,
      )
      .all(s.cursorTime * 1000, s.cursorTime * 1000, s.cursorId) as Array<{
      local_id: number;
      local_type: number | bigint;
      create_time: number;
      real_sender_id: number | null;
      message_content: unknown;
      WCDB_CT_message_content: number | null;
    }>;
    let maxTime = s.cursorTime;
    for (const row of rows) {
      s.cursorTime = row.create_time;
      s.cursorId = row.local_id;
      maxTime = Math.max(maxTime, row.create_time);
      const bt = baseType(row.local_type);
      if (bt !== 1 && bt !== 49) continue;
      const decoded = decompressContent(row.message_content, row.WCDB_CT_message_content) ?? "";
      const { sender, text } = this.formatContent(decoded, bt, grp, username, row.real_sender_id, s.name2id);
      // formatContent 对非文本会加 "[链接/文件] " 前缀并截断到 200 字，URL 可能被截掉 —— 抽地址用原文
      const raw = grp && decoded.includes(":\n") ? decoded.slice(decoded.indexOf(":\n") + 2) : decoded;
      const body = bt === 49 ? raw : text;
      const { addrs, chainHint } = extractAddresses(body, bt);
      if (addrs.length === 0) continue;
      emit({
        t: "msg",
        time: row.create_time,
        sender,
        text: displayText(body, bt).slice(0, 300),
        addrs,
        chainHint,
        // 启动前的历史 = 回灌（群一天上千条，单轮 LIMIT 500 可能分几轮才追平，不能按轮次判）
        backfill: row.create_time < startedAt,
      });
    }
    return maxTime;
  }

  /**
   * 阻塞式主循环；stop() 或进程信号退出。只发含地址的消息。
   * 起点二选一：`sinceTs`（首批群按启动时间窗回灌）或 `lastN`（运行中新勾选的群回灌最近 N 条）
   */
  async watch(query: string, opts: { sinceTs: number } | { lastN: number }, emit: (e: WatchEvent) => void): Promise<void> {
    const username = this.resolveTarget(query);
    if (!username) throw new Error(`未能解析会话 "${query}"`);
    const grp = username.includes("@chatroom");
    this.username = username;

    this.openShards(username, "sinceTs" in opts ? opts.sinceTs : 0);
    const sinceTs = "sinceTs" in opts ? opts.sinceTs : this.recentCursor(opts.lastN);
    if ("lastN" in opts) for (const s of this.shards) s.cursorTime = sinceTs;
    console.error(`[watch] ${username} shards=${this.shards.length} since=${sinceTs}${"lastN" in opts ? ` (last ${opts.lastN})` : ""}`);

    let maxTime = sinceTs;
    let lastHeartbeat = 0;
    const startedAt = Math.floor(Date.now() / 1000);
    while (!this.stopped) {
      try {
        if (this.polls > 0 && this.polls % REOPEN_EVERY === 0) {
          // 已开分片保留游标，只补新出现的分片
          const known = new Set(this.shards.map((s) => s.db.name));
          for (const s of this.findMessageShards(username)) {
            if (known.has(s.db.name)) {
              s.db.close();
              continue;
            }
            console.error(`[watch] new shard ${s.db.name}`);
            this.shards.push({ db: s.db, table: s.table, name2id: this.loadName2Id(s.db), cursorTime: maxTime, cursorId: -1 });
          }
        }
        for (const s of this.shards) {
          maxTime = Math.max(maxTime, this.pollShard(s, grp, username, emit, startedAt));
        }
        this.polls++;
        const now = Date.now();
        if (now - lastHeartbeat >= HEARTBEAT_MS) {
          lastHeartbeat = now;
          emit({ t: "heartbeat", maxTime, polls: this.polls });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[watch] poll error: ${message}`);
        emit({ t: "error", message });
        // 库句柄可能坏了（微信重建/轮转），整体重开，游标接着 maxTime
        try {
          this.openShards(username, maxTime);
        } catch (e2) {
          console.error(`[watch] reopen failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
    this.closeShards();
  }
}
