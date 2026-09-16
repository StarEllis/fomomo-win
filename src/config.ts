import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 代码所在目录：开发时是 `src/`，打进 .app 后是 `Contents/Resources/sidecar/`（esbuild 把本文件内联进 cli.mjs，
 * 所以 import.meta.url 在两种布局下都落在同一层）。dashboard 页面和引导脚本都按它相对定位，不依赖 cwd。
 */
export const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const DASHBOARD_HTML = path.join(APP_ROOT, "dashboard", "index.html");

/** 微信密钥提取脚本：开发 = 仓库 `scripts/`，bundle = `Resources/scripts/` */
export const SETUP_KEYS_SCRIPT = path.join(APP_ROOT, "..", "scripts", "setup-keys.sh");

/**
 * 应用自己的数据目录（sqlite、密钥）。与代码目录分离：bundle 的 Resources 是只读且被签名覆盖的，写进去会破坏签名、升级即丢。
 * `FOMOMO_DATA_DIR` 只给测试 / 多实例用。
 */
/**
 * Keep the data directory outside the install bundle on every platform.  The
 * original app only ran on macOS, where the conventional location is
 * `~/Library/Application Support/fomomo`; the Windows build uses the local
 * application-data directory so a portable install does not put a database
 * beside the executable or require administrator permissions.
 */
export const DATA_DIR = process.env.FOMOMO_DATA_DIR || (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Fomomo")
  : path.join(os.homedir(), "Library", "Application Support", "fomomo"));

/** 敏感数据目录 —— 只放密钥（明文聊天记录不落盘，见 db.ts 的按需解密）。权限 700 */
export const SECRETS_DIR = path.join(DATA_DIR, "secrets");

/** wcdb-key-tool 提取出的密钥文件（只含密钥，无聊天内容），权限 600 */
export const KEYS_FILE = path.join(SECRETS_DIR, "all_keys.json");

/**
 * Windows 的微信密钥文件：`{ key, dbDir }`。macOS 每个库一把密钥（各自的 salt 由 lldb 一次性抓出来），
 * Windows 版微信整个 db_storage 共用一把，用户自己拿到后填进来即可，不需要注入进程。
 */
export const WECHAT_KEY_FILE = path.join(SECRETS_DIR, "wechat-key.json");

/**
 * 微信 4.x 数据目录自动探测。
 * 优先级：环境变量 WECHAT_DB_DIR > 密钥文件里记的 dbDir > 本函数扫描出的当前账号。
 */
export function autoDetectDbDir(): string | null {
  if (process.platform === "darwin") return autoDetectDarwin();
  if (process.platform === "win32") return autoDetectWindows();
  return null;
}

function autoDetectDarwin(): string | null {
  const containerRoot = path.join(
    os.homedir(),
    "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files",
  );
  if (!fs.existsSync(containerRoot)) return null;
  let fallback: string | null = null;
  for (const entry of fs.readdirSync(containerRoot)) {
    const dbStorage = path.join(containerRoot, entry, "db_storage");
    if (fs.existsSync(dbStorage) && fs.statSync(dbStorage).isDirectory()) {
      fallback ??= dbStorage;
      if (fs.existsSync(path.join(dbStorage, "message"))) return dbStorage;
    }
  }
  return fallback;
}

/**
 * Windows 版微信把用户选的数据目录写在 `%APPDATA%\Tencent\xwechat\config\<hash>.ini` 里
 * （文件内容就是一行裸路径，没有 INI 段落），默认则在「文档」下。
 */
function windowsFileRoots(): string[] {
  const roots: string[] = [];
  const configDir = path.join(process.env.APPDATA ?? "", "Tencent", "xwechat", "config");
  try {
    for (const entry of fs.readdirSync(configDir)) {
      if (!entry.toLowerCase().endsWith(".ini")) continue;
      const root = fs.readFileSync(path.join(configDir, entry), "utf-8").trim();
      if (root) roots.push(path.join(root, "xwechat_files"));
    }
  } catch {
    /* 没装微信 / 没登录过：退回默认位置 */
  }
  roots.push(path.join(os.homedir(), "Documents", "xwechat_files"));
  return roots;
}

/**
 * 登录过的账号目录都会留着，但只有当前登录的那个还在写 session 库，
 * 所以按 session.db 的修改时间挑最新的那个账号。
 */
function autoDetectWindows(): string | null {
  let best: { dbStorage: string; at: number } | null = null;
  for (const root of windowsFileRoots()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dbStorage = path.join(root, entry, "db_storage");
      let at: number;
      try {
        at = fs.statSync(path.join(dbStorage, "session", "session.db")).mtimeMs;
      } catch {
        continue;
      }
      if (!best || at > best.at) best = { dbStorage, at };
    }
  }
  return best?.dbStorage ?? null;
}
