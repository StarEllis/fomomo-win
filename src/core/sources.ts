import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, KEYS_FILE, SECRETS_DIR, SETUP_KEYS_SCRIPT, WECHAT_KEY_FILE, autoDetectDbDir } from "../config.js";
import { openDb } from "../db.js";
import { larkEnv, larkErrorText, resolveLarkCli, type Resolved } from "../feishu/client.js";
import { loadKeys, normalizeKey, saveWechatKey, type KeyStore } from "../keys.js";
import { autoGetWindowsWechatKey } from "../wechat/windows-key.js";
import { NO_HEALTH, type SourceHealth } from "./messages.js";

/**
 * 群来源（微信 / 飞书）的就绪判定与引导动作。dashboard「群组」页据此显示引导卡；Swift 只看 `configured`
 * （至少一个来源就绪）决定首启要不要自动打开 dashboard。
 *
 * 微信：密钥文件能读 + 能用它打开 session 库（一步证明密钥有效且有完全磁盘访问）。提取密钥要 lldb + sudo + 交互，
 *   只能在终端里跑仓库的 setup-keys.sh，这里负责把终端拉起来、把前置条件（命令行工具 / 磁盘权限）查清楚。
 * 飞书：lark-cli 可用 + 有应用凭据 + 用户身份已登录。三步都能免终端：`config init --new` 在 stderr 打验证 URL 并阻塞到
 *   浏览器里完成；`auth login --no-wait --json` 给 URL + device_code，再用 `--device-code` 阻塞轮询到授权完成。
 */

export interface WechatSource extends WithHealth {
  supported: boolean;
  ready: boolean;
  /** 微信 4.x 数据目录存在（装过且登录过） */
  installed: boolean;
  /** 密钥文件存在且可解析 */
  keys: boolean;
  dbDir: string | null;
  /** 能否读微信容器目录；null = 目录不存在无从判断，或平台不涉及（Windows 无此权限概念） */
  diskAccess: boolean | null;
  /** Xcode 命令行工具（lldb）可用；Windows 恒为 false，密钥由用户直接填 */
  lldb: boolean;
  error: string | null;
  /** 最近一次点「提取密钥」拉起终端的时刻（unix 秒）；ready 后清空 */
  setupStartedAt: number | null;
  /** 密钥由用户手填（Windows）而不是终端提取（macOS） */
  manualKey: boolean;
  /** Windows 是否可以调用本机取钥组件 */
  autoKey?: boolean;
}

/**
 * 每个来源都带一份实时监听健康度：ready 只说「配好了」，health 说「现在还在正常跑吗」。
 * 群组页的「异常处理」条读 health，就绪之后掉线 / 掉权限也有按钮可点。
 */
interface WithHealth {
  health: SourceHealth;
}

export type FeishuLoginStep = "idle" | "config" | "auth" | "done" | "error";

export interface FeishuSource extends WithHealth {
  ready: boolean;
  cli: string | null;
  /** 有应用凭据（config init 做过） */
  app: boolean;
  loggedIn: boolean;
  user: string | null;
  error: string | null;
  login: { step: FeishuLoginStep; url: string | null; error: string | null; startedAt: number | null };
}

export interface QQSource extends WithHealth {
  supported: boolean;
  ready: boolean;
  configured: boolean;
  /** 设置里启用了 / 选了群 / 列过群：会去连本机 OneBot */
  enabled?: boolean;
  url: string;
  error: string | null;
}

export interface SourcesStatus {
  configured: boolean;
  wechat: WechatSource;
  feishu: FeishuSource;
  qq: QQSource;
}

/** 飞书只读监控需要的最小权限：列群 + 以用户身份读群消息 */
export const FEISHU_SCOPES = "im:chat:read im:message:readonly im:message.group_msg:get_as_user";

const WECHAT_CONTAINER = path.join(os.homedir(), "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files");
const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
/** macOS 用 lldb 注入微信进程抓密钥；Windows 让用户把密钥填进来，两条路都读同一套 4.x 库 */
const MAC_KEY_FLOW = process.platform === "darwin";
const WECHAT_SUPPORTED = MAC_KEY_FLOW || process.platform === "win32";
/** 状态缓存：dashboard 2s 轮询 + 内部轮询共用一份，飞书那两次 lark-cli 调用不用每次都跑 */
const CACHE_MS = 2_500;
const POLL_MS = 3_000;
/** 提取密钥全程（复制微信、重登、lldb 注入）通常 2–5 分钟；超过就不再显示「进行中」 */
const SETUP_WINDOW_S = 15 * 60;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** 跑一个外部命令到退出，不抛：exit code（spawn 失败 / 被杀算 1）+ 输出 */
function cmd(file: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
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
    private readonly deps: {
      larkCli?: () => Resolved | null;
      openUrl?: (url: string) => void;
      /** 运行中的三个监听器的实时健康度；没接线（测试 / 单跑命令）就当没有监听 */
      health?: () => { wechat: SourceHealth; feishu: SourceHealth; qq: SourceHealth };
      /** QQ 就绪与否只有 QQMonitor 知道（OneBot 连没连上），顺带让它有机会自己重连 */
      qq?: () => Omit<QQSource, "health">;
    } = {},
  ) {}

  private health(): { wechat: SourceHealth; feishu: SourceHealth; qq: SourceHealth } {
    try {
      return this.deps.health?.() ?? { wechat: NO_HEALTH, feishu: NO_HEALTH, qq: NO_HEALTH };
    } catch {
      return { wechat: NO_HEALTH, feishu: NO_HEALTH, qq: NO_HEALTH };
    }
  }

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
      const health = this.health();
      const url = process.env.FOMOMO_ONEBOT_WS_URL ?? "ws://127.0.0.1:8080";
      // QQ 就绪 = OneBot 真的连上了；没接 QQMonitor（单跑命令）时只能报未连接
      const base = this.deps.qq?.() ?? { supported: true, ready: false, configured: true, url, error: null };
      const qq: QQSource = { ...base, health: health.qq };
      const status: SourcesStatus = {
        configured: wechat.ready || feishu.ready || qq.ready,
        wechat: { ...wechat, health: health.wechat },
        feishu: { ...feishu, health: health.feishu },
        qq,
      };
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

  private async wechat(): Promise<Omit<WechatSource, "health">> {
    if (!WECHAT_SUPPORTED) {
      return {
        supported: false,
        ready: false,
        installed: false,
        keys: false,
        dbDir: null,
        diskAccess: null,
        lldb: false,
        error: "当前系统不支持微信来源",
        setupStartedAt: null,
        manualKey: false,
      };
    }
    if (!MAC_KEY_FLOW) return this.wechatWindows();
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
    return { supported: true, ready, installed, keys, dbDir, diskAccess, lldb, error, setupStartedAt, manualKey: false };
  }

  /**
   * Windows：没有 lldb 提取那一步，用户自己把 64 位数据库密钥填进来。
   * 数据目录从微信自己的 config 里读（见 autoDetectDbDir），一把密钥配全部库。
   */
  private async wechatWindows(): Promise<Omit<WechatSource, "health">> {
    const detected = autoDetectDbDir();
    let dbDir = detected, keys = false, ready = false, error: string | null = null;
    if (fs.existsSync(WECHAT_KEY_FILE)) {
      try {
        const store = loadKeys();
        keys = true;
        dbDir = store.dbDir;
        error = await probeSessionTwice(store);
        ready = error === null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (!detected) error ??= "没找到微信 4.x 的数据目录：请先安装并登录微信";
    else if (!keys) error ??= "还没填数据库密钥";
    return { supported: true, ready, installed: !!detected, keys, dbDir, diskAccess: null, lldb: false, error, setupStartedAt: null, manualKey: true, autoKey: true };
  }

  async autoGetWechatKey(): Promise<void> {
    if (MAC_KEY_FLOW) throw new Error("macOS 版请用「在终端中提取密钥」");
    const result = await autoGetWindowsWechatKey();
    const bad = await probeSessionTwice(loadKeys());
    if (bad) throw new Error(bad);
    console.error(`[wechat] Windows 自动取钥成功${result.name ? `：${result.name}` : ""}`);
    this.invalidate();
  }

  /** 存密钥前先验一遍，别把错的存下来让用户以为配好了 */
  async setWechatKey(key: string): Promise<void> {
    if (MAC_KEY_FLOW) throw new Error("macOS 版请用「在终端中提取密钥」");
    const passphraseHex = normalizeKey(key);
    if (!passphraseHex) throw new Error("密钥必须是 64 位十六进制字符串");
    const dbDir = process.env.WECHAT_DB_DIR || autoDetectDbDir();
    if (!dbDir) throw new Error("没找到微信数据目录：请先安装并登录微信");
    const bad = await probeSessionTwice({ dbDir, byRel: new Map(), passphraseHex });
    if (bad) throw new Error(bad);
    saveWechatKey(passphraseHex, dbDir);
    this.invalidate();
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
    if (!MAC_KEY_FLOW) throw new Error("这一步只在 macOS 上需要");
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
    if (!MAC_KEY_FLOW) throw new Error("这一步只在 macOS 上需要");
    const r = await cmd("open", [FDA_SETTINGS_URL]);
    if (r.code !== 0) throw new Error("打不开系统设置");
  }

  /** 弹系统的「安装命令行开发者工具」对话框；已装则命令立即退出，无害 */
  async installCommandLineTools(): Promise<void> {
    if (!MAC_KEY_FLOW) throw new Error("这一步只在 macOS 上需要");
    await cmd("xcode-select", ["--install"]);
    this.lldbCache = null;
    this.invalidate();
  }

  // ---------- 飞书 ----------

  private larkCli(): Resolved | null {
    return (this.deps.larkCli ?? resolveLarkCli)(process.env);
  }

  private async feishu(): Promise<Omit<FeishuSource, "health">> {
    const bin = this.larkCli();
    const base = { cli: bin?.file ?? null, app: false, loggedIn: false, user: null as string | null, error: null as string | null, login: this.login };
    if (!bin) return { ...base, ready: false, error: "未找到 lark-cli" };
    const run = (args: string[]) => cmd(bin.file, [...bin.argvPrefix, ...args], 10_000, larkEnv());
    const [show, status] = await Promise.all([run(["config", "show"]), run(["auth", "status", "--json"])]);
    base.app = show.code === 0;
    if (status.code === 0) {
      try {
        type Identity = { status?: string; available?: boolean; userName?: string };
        const j = JSON.parse(status.stdout) as { identities?: { bot?: Identity; user?: Identity } };
        const u = j.identities?.user;
        // config.json 里有 appId，但系统凭据库读不到密钥（lark-cli 报 bot not_configured）：换了 Windows 登录上下文 / 凭据被清时会这样。
        // 当作没有应用凭据，登录流程才会重新 config init；否则设备授权永远报 missing client_secret、拿不到授权链接
        if (j.identities?.bot?.status === "not_configured") base.app = false;
        // needs_refresh = 访问令牌过期但刷新令牌有效，lark-cli 下次调用自动续期，照样可用
        base.loggedIn = base.app && (u?.available === true || u?.status === "ready");
        base.user = u?.userName ?? null;
      } catch {
        base.error = "lark-cli auth status 输出无法解析";
      }
    } else if (base.app) {
      base.error = larkErrorText(status.stdout, status.stderr).slice(0, 200) || null;
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
      const out = init.stdout.trim();
      const j = JSON.parse(out.slice(Math.max(0, out.indexOf("{")))) as { verification_url?: string; device_code?: string };
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
    (this.deps.openUrl ?? openExternal)(url);
  }

  /** 跑一个 lark-cli 子进程到退出；stderr 逐块回调（验证 URL 从这儿出）；非 0 退出用最后一行 stderr 当错误 */
  private spawnLark(bin: Resolved, args: string[], onStderr: (chunk: string) => void, alive: () => boolean): Promise<{ stdout: string; stderr: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
    const child = spawn(bin.file, [...bin.argvPrefix, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...larkEnv(), NO_COLOR: "1" } });
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
      const msg = larkErrorText(stdout, stderr);
      reject(new Error(msg || (signal ? `lark-cli 被 ${signal} 终止（超时？）` : `lark-cli 退出码 ${code}`)));
    });
    return promise;
  }
}

/**
 * 用这套密钥打开 session 库并读一下 schema：一步证明密钥有效、目录对、文件读得到。
 *
 * 微信正在写库时偶尔会读到写了一半的页，SQLCipher 校验不过，报的错和「密钥真的不对」一模一样，
 * 所以这种错标成可重试 —— 只失败一次不足以判定密钥无效。
 */
function probeSession(store: KeyStore): { error: string | null; retryable: boolean } {
  const ok = { error: null, retryable: false };
  const classify = (e: unknown): { error: string; retryable: boolean } => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not a database|SQLITE_NOTADB/i.test(msg)) return { error: "密钥不对，或这个密钥不是当前登录账号的", retryable: true };
    if (/EPERM|EACCES|CANTOPEN|BUSY|LOCKED|permission/i.test(msg)) return { error: "读不到微信数据库文件（被占用或没权限）", retryable: true };
    return { error: msg, retryable: false };
  };
  let db;
  try {
    db = openDb(store, "session/session.db");
  } catch (e) {
    return classify(e);
  }
  if (!db) return { error: "没找到 session 库：数据目录不对，或微信还没登录过", retryable: false };
  try {
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return ok;
  } catch (e) {
    return classify(e);
  } finally {
    db.close();
  }
}

/** 可重试的失败再给一次机会；连着两次都不行才当成密钥问题报给用户 */
async function probeSessionTwice(store: KeyStore): Promise<string | null> {
  const first = probeSession(store);
  if (!first.error || !first.retryable) return first.error;
  await new Promise((r) => setTimeout(r, 250));
  return probeSession(store).error;
}

/** Open a URL without a shell.  `open` is macOS-only; rundll32 is available on
 * every supported Windows desktop and preserves the user's default browser. */
function openExternal(url: string): void {
  if (process.platform === "win32") {
    void cmd("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  } else {
    void cmd("open", [url]);
  }
}
