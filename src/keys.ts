import fs from "node:fs";
import path from "node:path";
import { KEYS_FILE, autoDetectDbDir } from "./config.js";

export interface DbKey {
  /** 相对 db_dir 的路径，统一用正斜杠，如 "message/message_0.db" */
  rel: string;
  /** 32 字节 AES-256 密钥（hex） */
  encKeyHex: string;
  /** 16 字节 salt（hex），即密文文件头 16 字节 */
  salt: string;
}

export interface KeyStore {
  dbDir: string;
  /** rel(正斜杠) -> DbKey */
  byRel: Map<string, DbKey>;
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/**
 * 载入 wcdb-key-tool 生成的 all_keys.json。
 * 格式: { "<rel>": {enc_key, salt, size_mb}, ..., "_db_dir": "..." }
 */
export function loadKeys(): KeyStore {
  if (!fs.existsSync(KEYS_FILE)) {
    throw new Error(`未找到微信密钥文件: ${KEYS_FILE}\n请在 dashboard「群组」页按引导提取密钥（或运行 scripts/setup-keys.sh）`);
  }
  const raw = JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8")) as Record<
    string,
    { enc_key: string; salt: string } | string
  >;

  const byRel = new Map<string, DbKey>();
  let dbDirFromKeys: string | undefined;

  for (const [k, v] of Object.entries(raw)) {
    if (k === "_db_dir") {
      if (typeof v === "string") dbDirFromKeys = v;
      continue;
    }
    if (k.startsWith("_")) continue;
    if (typeof v !== "object" || !v.enc_key || !v.salt) continue;
    const rel = normalizeRel(k);
    byRel.set(rel, { rel, encKeyHex: v.enc_key, salt: v.salt });
  }

  const dbDir =
    process.env.WECHAT_DB_DIR || dbDirFromKeys || autoDetectDbDir() || "";
  if (!dbDir) {
    throw new Error(
      "无法确定微信数据目录（db_dir）。请设置环境变量 WECHAT_DB_DIR，或确认 all_keys.json 内含 _db_dir。",
    );
  }
  if (byRel.size === 0) {
    throw new Error("密钥文件里没有任何数据库密钥，请检查 wcdb-key-tool 提取是否成功。");
  }
  return { dbDir, byRel };
}

/** 取某个相对路径对应的绝对路径与密钥 */
export function resolveDb(
  store: KeyStore,
  rel: string,
): { absPath: string; key: DbKey } | null {
  const norm = normalizeRel(rel);
  const key = store.byRel.get(norm);
  if (!key) return null;
  const absPath = path.join(store.dbDir, ...norm.split("/"));
  return { absPath, key };
}

/** 列出所有 message/message_N.db 的密钥（按 N 排序） */
export function messageDbKeys(store: KeyStore): DbKey[] {
  return [...store.byRel.values()]
    .filter((k) => /(^|\/)message\/message_\d+\.db$/.test(k.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
}
