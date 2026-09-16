import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KEYS_FILE, SECRETS_DIR, WECHAT_KEY_FILE, autoDetectDbDir } from "./config.js";

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
  /**
   * Windows：整个 db_storage 共用一个 64 位十六进制口令，每个库的密钥按各自文件头的 salt 现场派生。
   * macOS 走 byRel —— 那边是 lldb 一次性把每个库【已派生】的密钥抓出来存进 all_keys.json。
   */
  passphraseHex?: string;
}

/** Windows 密钥文件的内容 */
interface WechatKeyFile {
  /** 64 位十六进制口令（PBKDF2 的输入，不是 AES 密钥本身） */
  key: string;
  /** 账号的 db_storage 目录；留空则每次自动探测当前登录的账号 */
  dbDir?: string;
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/** 载入本机的微信密钥：Windows 是用户填的一把口令，macOS 是 wcdb-key-tool 抓出来的一堆密钥。 */
export function loadKeys(): KeyStore {
  return process.platform === "win32" ? loadWindowsKey() : loadMacKeys();
}

/**
 * Windows：`{ key, dbDir }`。库不预先枚举 —— 密钥要配着每个库自己的 salt 才能派生，
 * 而 salt 在文件头里，用到哪个库现读现派生（见 resolveDb）。
 */
function loadWindowsKey(): KeyStore {
  if (!fs.existsSync(WECHAT_KEY_FILE)) {
    throw new Error(`未找到微信密钥文件: ${WECHAT_KEY_FILE}\n请在 dashboard「群组」页填入 64 位数据库密钥`);
  }
  const raw = JSON.parse(fs.readFileSync(WECHAT_KEY_FILE, "utf-8")) as Partial<WechatKeyFile>;
  const passphraseHex = normalizeKey(raw.key ?? "");
  if (!passphraseHex) throw new Error("密钥文件格式不对：key 必须是 64 位十六进制字符串");
  const dbDir = process.env.WECHAT_DB_DIR || raw.dbDir || autoDetectDbDir() || "";
  if (!dbDir) throw new Error("没找到微信数据目录：请先登录微信，或设置环境变量 WECHAT_DB_DIR");
  return { dbDir, byRel: new Map(), passphraseHex };
}

/** 把用户粘进来的密钥规整成 64 位小写 hex；不合法返回 null */
export function normalizeKey(input: string): string | null {
  const hex = input.trim().replace(/^0x/i, "").replace(/[\s:-]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** 写入 Windows 密钥文件（只存密钥与目录，不存任何聊天内容） */
export function saveWechatKey(key: string, dbDir?: string): void {
  const passphraseHex = normalizeKey(key);
  if (!passphraseHex) throw new Error("密钥必须是 64 位十六进制字符串");
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const body: WechatKeyFile = { key: passphraseHex, ...(dbDir ? { dbDir } : {}) };
  fs.writeFileSync(WECHAT_KEY_FILE, JSON.stringify(body, null, 2), { mode: 0o600 });
}

/**
 * 载入 wcdb-key-tool 生成的 all_keys.json。
 * 格式: { "<rel>": {enc_key, salt, size_mb}, ..., "_db_dir": "..." }
 */
function loadMacKeys(): KeyStore {
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

/**
 * SQLCipher 4 的密钥派生：encKey = PBKDF2-HMAC-SHA512(口令, 文件头 16 字节 salt, 256000 次, 32 字节)。
 * 派生一次约 80ms，按 salt 缓存 —— 同一个库的 salt 不变；微信重建库换了 salt 会自然算出新密钥。
 */
const derivedKeys = new Map<string, string>();

function deriveKey(absPath: string, passphraseHex: string, rel: string): DbKey | null {
  let salt: string;
  try {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(absPath, "r");
    try {
      if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
    } finally {
      fs.closeSync(fd);
    }
    salt = head.toString("hex");
  } catch {
    return null;
  }
  const memo = `${passphraseHex}:${salt}`;
  let encKeyHex = derivedKeys.get(memo);
  if (!encKeyHex) {
    encKeyHex = crypto
      .pbkdf2Sync(Buffer.from(passphraseHex, "hex"), Buffer.from(salt, "hex"), 256_000, 32, "sha512")
      .toString("hex");
    derivedKeys.set(memo, encKeyHex);
  }
  return { rel, encKeyHex, salt };
}

/** 取某个相对路径对应的绝对路径与密钥 */
export function resolveDb(
  store: KeyStore,
  rel: string,
): { absPath: string; key: DbKey } | null {
  const norm = normalizeRel(rel);
  const absPath = path.join(store.dbDir, ...norm.split("/"));
  if (store.passphraseHex) {
    const key = deriveKey(absPath, store.passphraseHex, norm);
    return key ? { absPath, key } : null;
  }
  const key = store.byRel.get(norm);
  return key ? { absPath, key } : null;
}

/** 列出所有 message/message_N.db 的密钥（按 N 排序） */
export function messageDbKeys(store: KeyStore): DbKey[] {
  if (store.passphraseHex) {
    // Windows 不预存库清单：微信随时会新开 message_N.db，直接按目录列
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(store.dbDir, "message"));
    } catch {
      return [];
    }
    return entries
      .filter((name) => /^message_\d+\.db$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => deriveKey(path.join(store.dbDir, "message", name), store.passphraseHex!, `message/${name}`))
      .filter((k): k is DbKey => k !== null);
  }
  return [...store.byRel.values()]
    .filter((k) => /(^|\/)message\/message_\d+\.db$/.test(k.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
}
