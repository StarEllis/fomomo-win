import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, KEYS_FILE, SECRETS_DIR, SETUP_KEYS_SCRIPT } from "../config.js";
import { openDb } from "../db.js";
import { resolveLarkCli, type Resolved } from "../feishu/client.js";
import { loadKeys } from "../keys.js";

/**
 * 群来源（微信 / 飞书）的就绪判定与引导动作。dashboard「群组」页据此显示引导卡；Swift 只看 `configured`
 * （至少一个来源就绪）决定首启要不要自动打开 dashboard。
 *
 * 微信：密钥文件能读 + 能用它打开 session 库（一步证明密钥有效且有完全磁盘访问）。提取密钥要 lldb + sudo + 交互，
 *   只能在终端里跑仓库的 setup-keys.sh，这里负责把终端拉起来、把前置条件（命令行工具 / 磁盘权限）查清楚。
 * 飞书：lark-cli 可用 + 有应用凭据 + 用户身份已登录。三步都能免终端：`config init --new` 在 stderr 打验证 URL 并阻塞到
 *   浏览器里完成；`auth login --no-wait --json` 给 URL + device_code，再用 `--device-code` 阻塞轮询到授权完成。
 */

export interface WechatSource {
  ready: boolean;
  /** 微信 4.x 容器目录存在（装过且登录过） */
  installed: boolean;
  /** 密钥文件存在且可解析 */
  keys: boolean;
  dbDir: string | null;
  /** 能否读微信容器目录；null = 目录不存在无从判断 */
  diskAccess: boolean | null;
  /** Xcode 命令行工具（lldb）可用 */
  lldb: boolean;
  error: string | null;
  /** 最近一次点「提取密钥」拉起终端的时刻（unix 秒）；ready 后清空 */
  setupStartedAt: number | null;
}

export type FeishuLoginStep = "idle" | "config" | "auth" | "done" | "error";

export interface FeishuSource {
  ready: boolean;
  cli: string | null;
  /** 有应用凭据（config init 做过） */
  app: boolean;
  loggedIn: boolean;
  user: string | null;
  error: string | null;
  login: { step: FeishuLoginStep; url: string | null; error: string | null; startedAt: number | null };
}

export interface SourcesStatus {
  configured: boolean;
  wechat: WechatSource;
  feishu: FeishuSource;
}

/** 飞书只读监控需要的最小权限：列群 + 以用户身份读群消息 */
export const FEISHU_SCOPES = "im:chat:read im:message:readonly im:message.group_msg:get_as_user";

const WECHAT_CONTAINER = path.join(os.homedir(), "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files");
const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
/** 状态缓存：dashboard 2s 轮询 + 内部轮询共用一份，飞书那两次 lark-cli 调用不用每次都跑 */
const CACHE_MS = 2_500;
const POLL_MS = 3_000;
/** 提取密钥全程（复制微信、重登、lldb 注入）通常 2–5 分钟；超过就不再显示「进行中」 */
const SETUP_WINDOW_S = 15 * 60;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** 跑一个外部命令到退出，不抛：exit code（spawn 失败 / 被杀算 1）+ 输出 */
function cmd(file: string, args: string[], timeout = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const c = (err as (Error & { code?: number | string }) | null)?.code;
    resolve({ code: err === null ? 0 : typeof c === "number" ? c : 1, stdout, stderr });
  });
  return promise;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 从一段输出里挑出第一个 http(s) 链接（lark-cli 把验证 URL 和二维码一起打在 stderr） */
function firstUrl(text: string): string | null {
  return /https?:\/\/[^\s'"<>）)]+/.exec(text)?.[0] ?? null;
}

export class Sources {
  private cache: { at: number; status: SourcesStatus } | null = null;
  private inflight: Promise<SourcesStatus> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;
  private lastConfigured: boolean | null = null;
  private wechatSetupAt: number | null = null;
  private login: FeishuSource["login"] = { step: "idle", url: null, error: null, startedAt: null };
  private loginChild: ChildProcess | null = null;
  private loginSeq = 0;

  constructor(
    private readonly onChange: (s: SourcesStatus) => void,
    private readonly deps: { larkCli?: () => Resolved | null; openUrl?: (url: string) => void } = {},
  ) {}

  /** 启动即查一次并上报；之后在还没配置好之前每 3s 复查（配好后 Swift 不再需要变化通知，dashboard 自己轮询） */
  start(): void {
    void this.tick();
  }

  /** 一次复查：有待触发的定时器先作废（invalidate 会提前叫）；进行中就不重入 */
  private async tick(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const s = await this.status();
      if (this.stopped) return;
      if (s.configured !== this.lastConfigured) {
        this.lastConfigured = s.configured;
        this.onChange(s);
      }
      if (!s.configured) this.timer = setTimeout(() => void this.tick(), POLL_MS);
    } finally {
      this.ticking = false;
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.cancelFeishuLogin();
  }

  async status(force = false): Promise<SourcesStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.status;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const [wechat, feishu] = await Promise.all([this.wechat(), this.feishu()]);
      const status = { configured: wechat.ready || feishu.ready, wechat, feishu };
      this.cache = { at: Date.now(), status };
      this.inflight = null;
      return status;
    })();
    return this.inflight;
  }

  /** 动作之后立刻重算状态；还没配置好时顺带把变化尽快推给 Swift */
  private invalidate(): void {
    this.cache = null;
    if (!this.stopped && this.lastConfigured === false) void this.tick();
  }

  // ---------- 微信 ----------

  private async wechat(): Promise<WechatSource> {
    const installed = fs.existsSync(WECHAT_CONTAINER);
    let diskAccess: boolean | null = null;
    if (installed) {
      try {
        fs.readdirSync(WECHAT_CONTAINER);
        diskAccess = true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        diskAccess = code === "EPERM" || code === "EACCES" ? false : null;
      }
    }
    const lldb = await this.hasLldb();
    let keys = false, dbDir: string | null = null, ready = false, error: string | null = null;
    if (fs.existsSync(KEYS_FILE)) {
      try {
        const store = loadKeys();
        keys = true;
        dbDir = store.dbDir;
        const db = openDb(store, "session/session.db");
        if (!db) error = "密钥文件里没有 session 库的密钥，请重新提取";
        else {
          try {
            db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
            ready = true;
          } finally {
            db.close();
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not a database|SQLITE_NOTADB/i.test(msg)) error = "密钥已失效（退登 / 换号或微信新建分片后需重新提取）";
        else if (/CANTOPEN|EPERM|EACCES|permission/i.test(msg)) error = "读不到微信数据库：需要「完全磁盘访问权限」";
        else error = msg;
      }
    }
    if (!installed) error ??= "未检测到微信 4.x 的数据目录：请先安装并登录微信";
    else if (diskAccess === false) error ??= "没有「完全磁盘访问权限」，读不到微信数据目录";
    const setupStartedAt = !ready && this.wechatSetupAt && Date.now() / 1000 - this.wechatSetupAt < SETUP_WINDOW_S ? this.wechatSetupAt : null;
    if (ready) this.wechatSetupAt = null;
    return { ready, installed, keys, dbDir, diskAccess, lldb, error, setupStartedAt };
  }

  private lldbCache: { at: number; ok: boolean } | null = null;
  private async hasLldb(): Promise<boolean> {
    if (this.lldbCache && Date.now() - this.lldbCache.at < 30_000) return this.lldbCache.ok;
    const r = await cmd("xcode-select", ["-p"]);
    const ok = r.code === 0 && fs.existsSync(path.join(r.stdout.trim(), "usr", "bin", "lldb"));
    this.lldbCache = { at: Date.now(), ok };
    return ok;
  }

  /**
   * 在 Terminal 里跑 setup-keys.sh（要 sudo 与交互，不能在 sidecar 里跑）。走 `open -a Terminal x.command`：
   * Terminal 对 .command 文件的默认动作就是开新窗口执行，不需要 Apple Events 自动化授权（osascript `do script` 会弹权限框）。
   * 包装脚本落在数据目录，把 FOMOMO_DATA_DIR 传下去，密钥目录和 sidecar 同一处
   */
  async startWechatSetup(): Promise<void> {
    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    const wrapper = path.join(DATA_DIR, "setup-keys.command");
    const env = process.env.FOMOMO_DATA_DIR ? `export FOMOMO_DATA_DIR=${shellQuote(process.env.FOMOMO_DATA_DIR)}\n` : "";
    fs.writeFileSync(wrapper, `#!/bin/bash\n# fomomo 生成：在终端里跑微信密钥提取脚本\n${env}clear\nexec ${shellQuote(SETUP_KEYS_SCRIPT)}\n`, { mode: 0o755 });
    const r = await cmd("open", ["-a", "Terminal", wrapper]);
    if (r.code !== 0) throw new Error(`打不开终端：${r.stderr.trim() || `open 退出码 ${r.code}`}`);
    this.wechatSetupAt = Math.floor(Date.now() / 1000);
    this.invalidate();
  }

  /** 系统设置 → 隐私与安全性 → 完全磁盘访问权限（用户把 Fomomo / 终端加进去） */
  async openDiskAccessSettings(): Promise<void> {
    const r = await cmd("open", [FDA_SETTINGS_URL]);
    if (r.code !== 0) throw new Error("打不开系统设置");
  }

  /** 弹系统的「安装命令行开发者工具」对话框；已装则命令立即退出，无害 */
  async installCommandLineTools(): Promise<void> {
    await cmd("xcode-select", ["--install"]);
    this.lldbCache = null;
    this.invalidate();
  }

  // ---------- 飞书 ----------

  private larkCli(): Resolved | null {
    return (this.deps.larkCli ?? resolveLarkCli)(process.env);
  }

  private async feishu(): Promise<FeishuSource> {
    const bin = this.larkCli();
    const base = { cli: bin?.file ?? null, app: false, loggedIn: false, user: null as string | null, error: null as string | null, login: this.login };
    if (!bin) return { ...base, ready: false, error: "未找到 lark-cli" };
    const run = (args: string[]) => cmd(bin.file, [...bin.argvPrefix, ...args], 10_000);
    const [show, status] = await Promise.all([run(["config", "show"]), run(["auth", "status", "--json"])]);
    base.app = show.code === 0;
    if (status.code === 0) {
      try {
        const j = JSON.parse(status.stdout) as { identities?: { user?: { status?: string; userName?: string } } };
        const u = j.identities?.user;
        base.loggedIn = u?.status === "ready";
        base.user = u?.userName ?? null;
      } catch {
        base.error = "lark-cli auth status 输出无法解析";
      }
    } else if (base.app) {
      base.error = (status.stderr || status.stdout).trim().split("\n").at(-1)?.slice(0, 200) || null;
    }
    return { ...base, ready: base.app && base.loggedIn };
  }

  /**
   * 飞书登录全流程（幂等：进行中再点不重复起）。每一步拿到验证 URL 就直接开系统浏览器，同时把 URL 放进状态给页面显示。
   * 失败只记在 login.error，不抛；页面轮询看到 step=error 显示出来。
   */
  startFeishuLogin(): void {
    if (this.login.step === "config" || this.login.step === "auth") return;
    const seq = ++this.loginSeq;
    this.login = { step: "config", url: null, error: null, startedAt: Math.floor(Date.now() / 1000) };
    this.invalidate();
    void this.runFeishuLogin(seq).then(
      () => { if (seq === this.loginSeq) this.login = { ...this.login, step: "done", url: null }; },
      (e: unknown) => { if (seq === this.loginSeq) this.login = { ...this.login, step: "error", error: e instanceof Error ? e.message : String(e) }; },
    ).finally(() => { this.loginChild = null; this.invalidate(); });
  }

  cancelFeishuLogin(): void {
    this.loginSeq++;
    this.loginChild?.kill("SIGTERM");
    this.loginChild = null;
    if (this.login.step === "config" || this.login.step === "auth") this.login = { step: "idle", url: null, error: null, startedAt: null };
    this.invalidate();
  }

  private async runFeishuLogin(seq: number): Promise<void> {
    const bin = this.larkCli();
    if (!bin) throw new Error("未找到 lark-cli");
    const current = await this.feishu();
    const alive = () => seq === this.loginSeq && !this.stopped;
    if (!current.app) {
      // 一键创建飞书应用：URL 在 stderr，命令阻塞到浏览器里完成
      await this.spawnLark(bin, ["config", "init", "--new"], (chunk) => {
        if (this.login.url) return;
        const url = firstUrl(chunk);
        if (url) this.setLoginUrl(url);
      }, alive);
      if (!alive()) return;
    }
    this.login = { ...this.login, step: "auth", url: null };
    this.invalidate();
    const init = await this.spawnLark(bin, ["auth", "login", "--scope", FEISHU_SCOPES, "--no-wait", "--json"], () => {}, alive);
    if (!alive()) return;
    let deviceCode = "", url: string | null = null;
    try {
      const j = JSON.parse(init.stdout.trim().split("\n").at(-1) ?? "") as { verification_url?: string; device_code?: string };
      deviceCode = j.device_code ?? "";
      url = j.verification_url ?? null;
    } catch {
      throw new Error(`lark-cli 未返回设备码：${(init.stderr || init.stdout).trim().slice(0, 200)}`);
    }
    if (!deviceCode || !url) throw new Error("lark-cli 未返回设备码");
    this.setLoginUrl(url);
    await this.spawnLark(bin, ["auth", "login", "--device-code", deviceCode, "--json"], () => {}, alive);
  }

  private setLoginUrl(url: string): void {
    this.login = { ...this.login, url };
    this.invalidate();
    (this.deps.openUrl ?? ((u: string) => void cmd("open", [u])))(url);
  }

  /** 跑一个 lark-cli 子进程到退出；stderr 逐块回调（验证 URL 从这儿出）；非 0 退出用最后一行 stderr 当错误 */
  private spawnLark(bin: Resolved, args: string[], onStderr: (chunk: string) => void, alive: () => boolean): Promise<{ stdout: string; stderr: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
    const child = spawn(bin.file, [...bin.argvPrefix, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    this.loginChild = child;
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; onStderr(d); });
    const timer = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!alive()) return resolve({ stdout, stderr });
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().split("\n").filter((l) => l.trim() && !/^[▀▄█ ]+$/.test(l)).at(-1)?.slice(0, 300) ?? "";
      let msg = tail;
      try {
        const j = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { error?: string | { message?: string } };
        if (typeof j.error === "string") msg = j.error;
        else if (j.error?.message) msg = j.error.message;
      } catch { /* 非 JSON 输出 */ }
      reject(new Error(msg || (signal ? `lark-cli 被 ${signal} 终止（超时？）` : `lark-cli 退出码 ${code}`)));
    });
    return promise;
  }
}
