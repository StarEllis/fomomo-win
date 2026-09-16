import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { autoDetectDbDir } from "../config.js";
import { loadKeys, normalizeKey, saveWechatKey } from "../keys.js";

type ScanAccount = { db_key?: string; wxid?: string; name?: string; number?: string; phone?: string };

/** Windows 微信 4.x 的本机取钥适配器。实现协议来自 CipherTalk 的 wechat_key_tool.dll。 */
export async function autoGetWindowsWechatKey(): Promise<{ key: string; dbDir: string; wxid?: string; name?: string }> {
  if (process.platform !== "win32") throw new Error("自动取钥目前只用于 Windows 微信");
  const dllPath = process.env.FOMOMO_WECHAT_KEY_DLL;
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error("安装包缺少微信取钥组件 wechat_key_tool.dll");
  const dbDir = autoDetectDbDir();
  if (!dbDir) throw new Error("没找到微信 4.x 数据目录，请先安装并登录微信");
  const koffi = createRequire(import.meta.url)("koffi");
  const lib = koffi.load(path.resolve(dllPath));
  const challenge = lib.func("int wkt_challenge(uint8_t*, size_t)");
  const scan = lib.func("void* wkt_scan_account_auth(uint8_t*, size_t)");
  const free = lib.func("void wkt_free(void*)");
  const nonce = Buffer.alloc(32);
  if (challenge(nonce, 32) !== 32) throw new Error("微信取钥组件初始化失败");
  // CipherTalk DLL 内置配对公钥；私钥仅用于本地挑战应答，不写入磁盘。
  const obf = "6a74585b5a6a5f5c59713f2a5e785e7a168e0e9425838c437f0b1274d114f59457f436c936b80178da1848856b58eef3";
  const der = Buffer.from(Buffer.from(obf, "hex").map((v: number) => v ^ 0x5a));
  const sig = crypto.sign(null, nonce, crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  const ptr = scan(sig, sig.length);
  if (!ptr) throw new Error("未能读取微信进程内存，请确认微信已登录并以相同权限运行 fomomo");
  try {
    const raw = String(koffi.decode(ptr, "char", -1) || "").replace(/\0/g, "");
    const data = JSON.parse(raw) as ScanAccount;
    const key = normalizeKey(data.db_key || "");
    if (!key) throw new Error("微信进程未返回有效数据库密钥");
    saveWechatKey(key, dbDir);
    // 让上层立刻做 SQLCipher 验证；保存前不接受无法验证的候选值。
    const stored = loadKeys();
    if (stored.passphraseHex !== key) throw new Error("微信密钥保存后校验失败");
    return { key, dbDir, wxid: data.wxid, name: data.name };
  } finally { free(ptr); }
}
