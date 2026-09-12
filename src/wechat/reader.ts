import crypto from "node:crypto";
import type { Database as DB } from "better-sqlite3-multiple-ciphers";
import { loadKeys, messageDbKeys, type KeyStore } from "../keys.js";
import { openDb, hasTable } from "../db.js";
import { decompressContent } from "../zstd.js";
import { displayText } from "./extract.js";
import type { Session, WeChatMessage } from "./types.js";

const TYPE_LABELS: Record<number, string> = {
  1: "文本",
  3: "图片",
  34: "语音",
  42: "名片",
  43: "视频",
  47: "表情",
  48: "位置",
  49: "链接/文件",
  50: "通话",
  10000: "系统",
  10002: "撤回",
};

function md5hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf-8").digest("hex");
}

function isGroup(username: string): boolean {
  return username.includes("@chatroom");
}

/** local_type 拆低/高 32 位 */
export function baseType(t: number | bigint): number {
  const n = typeof t === "bigint" ? t : BigInt(Math.trunc(t));
  return Number(n & 0xffffffffn);
}

export class WechatReader {
  private readonly store: KeyStore = loadKeys();
  private contactCache?: Map<string, string>;

  /** username -> 显示名（remark > nick_name > username） */
  private contacts(): Map<string, string> {
    if (this.contactCache) return this.contactCache;
    const map = new Map<string, string>();
    const db = openDb(this.store, "contact/contact.db");
    if (db) {
      try {
        const rows = db
          .prepare("SELECT username, nick_name, remark FROM contact")
          .all() as { username: string; nick_name: string | null; remark: string | null }[];
        for (const r of rows) {
          if (!r.username) continue;
          map.set(r.username, r.remark || r.nick_name || r.username);
        }
      } catch {
        /* 表结构异常时降级为空 */
      } finally {
        db.close();
      }
    }
    this.contactCache = map;
    return map;
  }

  display(username: string): string {
    return this.contacts().get(username) || username;
  }

  /** 列出会话（含单聊+群）。按最后活跃时间倒序。 */
  listSessions(limit = 50): Session[] {
    const db = openDb(this.store, "session/session.db");
    if (!db) throw new Error("无法解密 session/session.db（缺少密钥？）");
    try {
      const rows = db
        .prepare(
          `SELECT username, unread_count, summary, last_timestamp,
                  last_msg_sender, last_sender_display_name
           FROM SessionTable
           WHERE last_timestamp > 0
           ORDER BY last_timestamp DESC
           LIMIT ?`,
        )
        .all(limit) as Array<{
        username: string;
        unread_count: number | null;
        summary: unknown;
        last_timestamp: number;
        last_msg_sender: string | null;
        last_sender_display_name: string | null;
      }>;

      return rows.map((r) => {
        const grp = isGroup(r.username);
        let summary = decompressContent(r.summary, 4) ?? "";
        // 群摘要形如 "wxid_xxx:\n正文"，去掉发送者前缀
        if (grp && summary.includes(":\n")) summary = summary.split(":\n").slice(1).join(":\n");
        return {
          username: r.username,
          displayName: this.display(r.username),
          isGroup: grp,
          unread: r.unread_count ?? 0,
          lastTimestamp: r.last_timestamp,
          summary: summary.replace(/\s+/g, " ").trim(),
        } satisfies Session;
      });
    } finally {
      db.close();
    }
  }

  /** 只列群聊 */
  listGroups(limit = 100): Session[] {
    return this.listSessions(limit).filter((s) => s.isGroup);
  }

  /**
   * 把用户给的名字/备注/username 解析成真实 username。
   * 优先精确匹配显示名，其次子串匹配，最后当作 raw username（含 @chatroom / wxid_ / gh_）。
   */
  resolveTarget(query: string): string | null {
    const q = query.trim();
    if (!q) return null;
    const contacts = this.contacts();
    const ql = q.toLowerCase();
    for (const [uname, display] of contacts) if (display.toLowerCase() === ql) return uname;
    for (const [uname, display] of contacts) if (display.toLowerCase().includes(ql)) return uname;
    if (contacts.has(q)) return q;
    // 直接是 username 形态
    if (/@chatroom$/.test(q) || /^wxid_/.test(q) || /^gh_/.test(q)) return q;
    return null;
  }

  /** 找到含该会话消息表的所有 message_N.db（可能分散在多个分片） */
  protected findMessageShards(
    username: string,
  ): Array<{ db: DB; table: string; maxCreateTime: number }> {
    const table = `Msg_${md5hex(username)}`;
    if (!/^Msg_[0-9a-f]{32}$/.test(table)) return [];
    const out: Array<{ db: DB; table: string; maxCreateTime: number }> = [];
    for (const key of messageDbKeys(this.store)) {
      const db = openDb(this.store, key.rel);
      if (!db) continue;
      if (!hasTable(db, table)) {
        db.close();
        continue;
      }
      const row = db.prepare(`SELECT MAX(create_time) AS m FROM [${table}]`).get() as {
        m: number | null;
      };
      out.push({ db, table, maxCreateTime: row?.m ?? 0 });
    }
    out.sort((a, b) => b.maxCreateTime - a.maxCreateTime);
    return out;
  }

  /**
   * 某条消息前后的上下文：时刻 ts 之前（含）最近 before 条 + 之后最早 after 条，按时间升序。
   * 只取文本/链接/图片/表情这些能"看"的类型，其他给类型标签。给弹卡看喊单语境用，**不落库**。
   */
  readAround(username: string, ts: number, before: number, after: number): WeChatMessage[] {
    const shards = this.findMessageShards(username);
    try {
      return this.readAroundIn(shards.map((s) => ({ db: s.db, table: s.table, name2id: this.loadName2Id(s.db) })), username, ts, before, after);
    } finally {
      for (const s of shards) s.db.close();
    }
  }

  /** readAround 的核心：在给定的（已打开的）分片上查。WechatWatcher 用自己常开的句柄调它，免得每次重开+解密所有库。 */
  protected readAroundIn(shards: Array<{ db: DB; table: string; name2id: Map<number, string> }>, username: string, ts: number, before: number, after: number): WeChatMessage[] {
    const grp = isGroup(username);
    type Raw = { local_id: number; local_type: number | bigint; create_time: number; real_sender_id: number | null; message_content: unknown; WCDB_CT_message_content: number | null; __name2id: Map<number, string> };
    const cols = "local_id, local_type, create_time, real_sender_id, message_content, WCDB_CT_message_content";
    // 系统消息/撤回/通话不算上下文
    const skip = new Set([50, 10000, 10002]);
    const pre: Raw[] = [], post: Raw[] = [];
    // create_time 没索引（全表扫 100ms+）；sort_seq = create_time*1000 且有索引（实测每行都相等），用它当时间键 → 0.1ms
    for (const shard of shards) {
      const a = shard.db.prepare(`SELECT ${cols} FROM [${shard.table}] WHERE sort_seq < ? ORDER BY sort_seq DESC, local_id DESC LIMIT ?`).all((ts + 1) * 1000, before + 4) as Raw[];
      const b = shard.db.prepare(`SELECT ${cols} FROM [${shard.table}] WHERE sort_seq >= ? ORDER BY sort_seq ASC, local_id ASC LIMIT ?`).all((ts + 1) * 1000, after + 4) as Raw[];
      for (const r of a) pre.push({ ...r, __name2id: shard.name2id });
      for (const r of b) post.push({ ...r, __name2id: shard.name2id });
    }
    pre.sort((x, y) => y.create_time - x.create_time || y.local_id - x.local_id);
    post.sort((x, y) => x.create_time - y.create_time || x.local_id - y.local_id);
    const pick = (rows: Raw[], n: number) => rows.filter((r) => !skip.has(baseType(r.local_type))).slice(0, n);
    const chosen = [...pick(pre, before).reverse(), ...pick(post, after)];
    return chosen.map((row) => {
      const bt = baseType(row.local_type);
      const decoded = decompressContent(row.message_content, row.WCDB_CT_message_content) ?? "";
      const { sender, text } = this.formatContent(decoded, bt, grp, username, row.real_sender_id, row.__name2id);
      const shown = bt === 1 || bt === 49 ? displayText(text, bt) : `[${TYPE_LABELS[bt] ?? `type=${bt}`}]`;
      return { createTime: row.create_time, sender, text: shown.slice(0, 200) };
    });
  }

  protected loadName2Id(db: DB): Map<number, string> {
    const map = new Map<number, string>();
    try {
      const rows = db.prepare("SELECT rowid, user_name FROM Name2Id").all() as {
        rowid: number;
        user_name: string | null;
      }[];
      for (const r of rows) if (r.user_name) map.set(r.rowid, r.user_name);
    } catch {
      /* 无 Name2Id 表时退回内容前缀解析 */
    }
    return map;
  }

  /** 解出发送者 + 正文文本（非文本消息给出占位标签） */
  protected formatContent(
    content: string,
    bt: number,
    grp: boolean,
    chatUsername: string,
    realSenderId: number | null,
    name2id: Map<number, string>,
  ): { sender: string; text: string } {
    let text = content;

    // 群消息正文前缀 "sender:\n正文"
    let contentSenderUname = "";
    if (grp && content.includes(":\n")) {
      const idx = content.indexOf(":\n");
      contentSenderUname = content.slice(0, idx);
      text = content.slice(idx + 2);
    }

    // 发送者：优先 Name2Id(real_sender_id) → username → 显示名，回退正文前缀
    const senderUname = (realSenderId != null && name2id.get(realSenderId)) || contentSenderUname || "";
    const sender = senderUname && senderUname !== chatUsername ? this.display(senderUname) : "";

    // 非文本类型给占位标签（步骤 1 先不深挖图片/文件路径）
    if (bt !== 1) {
      const label = TYPE_LABELS[bt] ?? `type=${bt}`;
      text = text.trim() ? `[${label}] ${text.trim().slice(0, 200)}` : `[${label}]`;
    }
    return { sender, text };
  }
}
