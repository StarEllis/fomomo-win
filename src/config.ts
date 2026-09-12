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
export const DATA_DIR = process.env.FOMOMO_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "fomomo");

/** 敏感数据目录 —— 只放密钥（明文聊天记录不落盘，见 db.ts 的按需解密）。权限 700 */
export const SECRETS_DIR = path.join(DATA_DIR, "secrets");

/** wcdb-key-tool 提取出的密钥文件（只含密钥，无聊天内容），权限 600 */
export const KEYS_FILE = path.join(SECRETS_DIR, "all_keys.json");

/**
 * 微信 4.x 数据目录自动探测（macOS 沙盒容器）。
 * 优先级：环境变量 WECHAT_DB_DIR > all_keys.json 里的 _db_dir > 容器路径扫描。
 */
export function autoDetectDbDir(): string | null {
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
