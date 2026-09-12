import fs from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DB } from "better-sqlite3-multiple-ciphers";
import { resolveDb, type KeyStore } from "./keys.js";

/**
 * 以【只读 + 按需解密】方式打开微信原库。
 *
 * 用 SQLCipher 引擎（better-sqlite3-multiple-ciphers）直接读加密原库：
 *   - 明文聊天记录【绝不落盘】，只有查询真正碰到的页在内存里被解密
 *   - 只读打开，不修改原库（不会封号/损坏）
 *   - enc_key 就是 SQLCipher 的 raw key，salt 在文件头 16 字节（SQLCipher4 标准）
 *
 * 返回 null：all_keys.json 里没有该库的密钥，或原库文件不存在。
 */
export function openDb(store: KeyStore, rel: string): DB | null {
  const r = resolveDb(store, rel);
  if (!r) return null;
  if (!fs.existsSync(r.absPath)) return null;

  const db = new Database(r.absPath, { readonly: true, fileMustExist: true });
  // SQLCipher4 + 32 字节 raw key（顺序：先声明 cipher/兼容级别，再给 key）
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key="x'${r.key.encKeyHex}'"`);
  db.pragma("query_only=ON");
  return db;
}

/** 判断某个已打开的库里是否存在某张表（只会解密 schema 页，代价很小） */
export function hasTable(db: DB, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    )
    .get(table);
  return !!row;
}
