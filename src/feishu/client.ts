import { execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * lark-cli 子进程封装：只发 GET（`api` 子命令标 write 是因为它能发任何方法，我们只读），
 * 输出统一是 `{ok, identity, data}` / `{ok:false, error:{type,code,message,hint}}` 信封。
 * 每次调用一个进程，argv 直传不走 shell；stop() 杀掉在飞的并等它们退出，不留孤儿。
 */

export type LarkErrorKind = "missing-cli" | "auth" | "rate-limit" | "forbidden" | "not-found" | "aborted" | "api" | "network" | "cli";

export class LarkError extends Error {
  constructor(
    message: string,
    readonly kind: LarkErrorKind,
  ) {
    super(message);
    this.name = "LarkError";
  }
  /** 值得退避重试（网络/限流/临时）；权限、未登录、未安装反复打也没意义，退避更长 */
  get transient(): boolean {
    return this.kind === "rate-limit" || this.kind === "api" || this.kind === "network" || this.kind === "cli";
  }
}

interface RawSender {
  id?: string;
  id_type?: string;
  sender_type?: string;
  /** with_sender_name=true 时接口给的显示名（实测字段名是 sender_name，不是 name） */
  sender_name?: string;
  name?: string;
}

interface RawMention {
  key?: string;
  id?: string;
  name?: string;
}

/** GET /open-apis/im/v1/messages 的一条 item（字段按官方文档；create_time 是毫秒字符串） */
export interface RawMessage {
  message_id: string;
  msg_type: string;
  create_time: string;
  update_time?: string;
  deleted?: boolean;
  updated?: boolean;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  sender?: RawSender;
  body?: { content?: string };
  mentions?: RawMention[];
}

export interface MessagePage {
  items: RawMessage[];
  hasMore: boolean;
  pageToken: string;
}

export interface RawChat {
  chat_id: string;
  name?: string;
  chat_mode?: string;
  chat_status?: string;
  external?: boolean;
  description?: string;
}

export interface ListMessagesQuery {
  chatId: string;
  /** Unix 秒（API 只接受秒） */
  startTime?: number;
  endTime?: number;
  order: "asc" | "desc";
  pageToken?: string;
  pageSize?: number;
}

/** 监控/上下文读取只依赖这个面，测试可注入假实现 */
export interface FeishuTransport {
  listMessages(q: ListMessagesQuery, signal?: AbortSignal): Promise<MessagePage>;
  listChats(signal?: AbortSignal): Promise<RawChat[]>;
  stop(): Promise<void>;
}

export interface Resolved {
  file: string;
  /** npm 包装脚本没带原生二进制时用当前 node 跑脚本 */
  argvPrefix: string[];
}

const BIN = process.platform === "win32" ? "lark-cli.exe" : "lark-cli";

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name));
  } catch {
    return [];
  }
}

/**
 * GUI 启动的 sidecar 拿到的 PATH 往往只有 /usr/bin:/bin，得自己补 npm/pnpm/bun/nvm/fnm 常见 bin 目录。
 * 优先级：FOMOMO_LARK_CLI（.app 里随包带的二进制走这里）> PATH > 常见目录。找到的 lark-cli 若是 @larksuite/cli 的 run.js 包装，
 * 直接改用旁边 bin/ 里的原生二进制（少一层 node 进程）。
 */
export function resolveLarkCli(env: NodeJS.ProcessEnv): Resolved | null {
  const home = homedir();
  const candidates: string[] = [];
  if (env.FOMOMO_LARK_CLI) candidates.push(env.FOMOMO_LARK_CLI);
  const dirs = new Set<string>((env.PATH ?? "").split(path.delimiter).filter(Boolean));
  for (const d of [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "Library", "pnpm", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".yarn", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ])
    dirs.add(d);
  for (const v of listDirs(path.join(home, ".nvm", "versions", "node"))) dirs.add(path.join(v, "bin"));
  for (const base of [path.join(home, ".local", "share", "fnm", "node-versions"), path.join(home, "Library", "Application Support", "fnm", "node-versions")])
    for (const v of listDirs(base)) dirs.add(path.join(v, "installation", "bin"));
  for (const d of dirs) candidates.push(path.join(d, BIN));

  for (const c of candidates) {
    if (!existsSync(c)) continue;
    let real = c;
    try {
      real = realpathSync(c);
    } catch {
      continue;
    }
    if (real.endsWith(".js")) {
      // @larksuite/cli/scripts/run.js → @larksuite/cli/bin/lark-cli
      const native = path.join(path.dirname(path.dirname(real)), "bin", BIN);
      if (executable(native)) return { file: native, argvPrefix: [] };
      return { file: process.execPath, argvPrefix: [real] };
    }
    if (executable(real)) return { file: real, argvPrefix: [] };
  }
  return null;
}

/**
 * 给 lark-cli 子进程用的环境：去掉 AI Agent 工作区信号（OpenClaw / Hermes / Lark Channel）。
 * 机器上装过这类 Agent 时 lark-cli 会切到「Agent 工作区」模式：config init 直接拒绝、config show / auth status
 * 报 not bound。fomomo 用自己创建的只读应用，不借 Agent 的应用，所以一律按普通用户环境跑。
 */
export function larkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const noProxy: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/^(OPENCLAW_|HERMES_|LARK_CHANNEL)/i.test(k)) continue;
    if (/^no_proxy$/i.test(k)) { if (v) noProxy.push(v); continue; }
    out[k] = v;
  }
  // 飞书 / Lark 直连，不经用户设的 HTTP(S)_PROXY：本机代理（如 Clash）并发时偶发接不住新连接，而这些域名在代理里本来也是直连。
  // Windows 环境变量名不分大小写，NO_PROXY / no_proxy 合成一个
  out.NO_PROXY = [...noProxy, "feishu.cn", "larksuite.com"].join(",");
  return out;
}

/** 从 lark-cli 失败输出里取可读错误：优先 `{ok:false,error}` 信封（多行 JSON，可能在 stdout 也可能在 stderr），否则最后一行非二维码文本 */
export function larkErrorText(stdout: string, stderr: string): string {
  for (const s of [stdout, stderr]) {
    const t = s.trim();
    const i = t.indexOf("{");
    if (i < 0) continue;
    try {
      const j = JSON.parse(t.slice(i)) as { error?: string | { message?: string; hint?: string } };
      if (typeof j.error === "string") return j.error;
      if (j.error?.message) return j.error.message + (j.error.hint ? `（${j.error.hint}）` : "");
    } catch { /* 非 JSON 输出 */ }
  }
  return (stderr || stdout).trim().split("\n").filter((l) => l.trim() && !/^[▀▄█ ]+$/.test(l)).at(-1)?.slice(0, 300) ?? "";
}

const MISSING_CLI_HINT ="未找到 lark-cli（.app 自带；开发模式请 npm i -g @larksuite/cli，或用 FOMOMO_LARK_CLI 指定路径）";

interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: { type?: string; subtype?: string; code?: number; message?: string; hint?: string };
}

/** lark-cli 的 JSON 信封：成功在 stdout；失败时写在 stderr（前面可能夹着别的输出） */
export function larkEnvelope(stdout: string, stderr: string): Envelope | null {
  for (const s of [stdout, stderr]) {
    const t = s.trim();
    const i = t.indexOf("{");
    if (i < 0) continue;
    try {
      const j = JSON.parse(t.slice(i)) as Envelope;
      if (j && typeof j === "object" && typeof j.ok === "boolean") return j;
    } catch { /* 非 JSON 输出 */ }
  }
  return null;
}

export function classifyLarkError(err: NonNullable<Envelope["error"]>): LarkError {
  const code = typeof err.code === "number" ? err.code : undefined;
  if (err.type === "network") {
    // Go 的报错是 `API call failed: Get "<很长的 URL>": <原因>`，去掉 URL 才看得到原因
    const cause = (err.message ?? "").replace(/^API call failed:\s*/, "").replace(/^[A-Za-z]+ "[^"]*":\s*/, "").slice(0, 200);
    return new LarkError(`飞书网络请求失败${/proxyconnect/.test(cause) ? "（连本机代理失败）" : ""}：${cause || "未知原因"}`, "network");
  }
  const msg = (err.message ?? "飞书接口调用失败").slice(0, 300);
  const hint = err.hint ? ` (${err.hint.slice(0, 200)})` : "";
  if (err.type === "auth" || /user_access_token|not logged in|未登录|login|authoriz|token (?:expired|invalid)/i.test(msg))
    return new LarkError(`飞书未登录或授权失效，请运行 lark-cli auth login：${msg}`, "auth");
  if (code === 99991400 || code === 11232 || /frequency|rate limit|too many requests/i.test(msg)) return new LarkError(`飞书接口限流：${msg}`, "rate-limit");
  if (code === 230027 || code === 99991672 || code === 99991679 || /permission|scope|not authorized|forbidden/i.test(msg))
    return new LarkError(`飞书权限不足（需要 im:message:readonly + im:message.group_msg:get_as_user）：${msg}`, "forbidden");
  if (code === 230002 || code === 230001 || code === 231203) return new LarkError(`飞书群不可读（已退群/无效 chat_id/群禁止读取）：${msg}`, "not-found");
  if (err.type === "validation") return new LarkError(`lark-cli 参数错误：${msg}${hint}`, "cli");
  return new LarkError(`飞书接口错误：${msg}${hint}`, "api");
}

/** 单次请求超时（CLI 冷启动 + 一页 50 条约 1s，给足余量） */
const TIMEOUT_MS = 30_000;

export class LarkCliClient implements FeishuTransport {
  private resolved: Resolved | null | undefined;
  private readonly inflight = new Set<ChildProcess>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  private locate(): Resolved {
    if (!this.resolved) this.resolved = resolveLarkCli(process.env);
    if (!this.resolved) throw new LarkError(MISSING_CLI_HINT, "missing-cli");
    return this.resolved;
  }

  /** `lark-cli api GET <path>`，返回信封里的 data。网络传输失败（多半是本机代理偶发接不住新连接）隔 0.5s 重试一次 */
  async get(apiPath: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.getOnce(apiPath, params, signal);
    } catch (e) {
      if (!(e instanceof LarkError && e.kind === "network")) throw e;
      await new Promise((r) => setTimeout(r, 500));
      return this.getOnce(apiPath, params, signal);
    }
  }

  private async getOnce(apiPath: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) throw new LarkError("飞书客户端已关闭", "aborted");
    if (signal?.aborted) throw new LarkError("请求已取消", "aborted");
    const bin = this.locate();
    const args = [...bin.argvPrefix, "api", "GET", apiPath, "--as", "user", "--format", "json", "--params", JSON.stringify(params)];
    const { promise: run, resolve, reject } = Promise.withResolvers<unknown>();
    const { promise: closed, resolve: finish } = Promise.withResolvers<void>();
    const child = execFile(
      bin.file,
      args,
      { encoding: "utf8", env: larkEnv(), maxBuffer: 16 * 1024 * 1024, timeout: TIMEOUT_MS, killSignal: "SIGTERM", signal, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null; // execFile 回调的 err 类型缺 killed/signal
        if (e && e.code === "ENOENT") {
          this.resolved = undefined; // 下次重新发现（用户可能刚安装/卸载）
          return reject(new LarkError(MISSING_CLI_HINT, "missing-cli"));
        }
        if (signal?.aborted || this.stopped || e?.name === "AbortError") return reject(new LarkError("请求已取消", "aborted"));
        if (e && e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new LarkError("lark-cli 输出超过 16MB 缓冲上限", "cli"));
        if (e && (e.killed || e.signal)) return reject(new LarkError(`lark-cli 超时（${TIMEOUT_MS}ms）被终止`, "cli"));
        const env = larkEnvelope(stdout, stderr);
        if (env && env.ok === false && env.error) return reject(classifyLarkError(env.error));
        if (env && env.ok === true) return resolve(env.data);
        const tail = larkErrorText(stdout, stderr).slice(0, 200);
        return reject(new LarkError(`lark-cli 退出码 ${e?.code ?? "?"}，输出无法解析${tail ? `：${tail}` : ""}`, "cli"));
      },
    );
    const hardTimeout = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS + 2_000).unref();
    let abortTimeout: NodeJS.Timeout | undefined;
    const forceAbort = () => { abortTimeout ??= setTimeout(() => child.kill("SIGKILL"), 2_000).unref(); };
    signal?.addEventListener("abort", forceAbort, { once: true });
    child.once("close", () => {
      clearTimeout(hardTimeout);
      clearTimeout(abortTimeout);
      signal?.removeEventListener("abort", forceAbort);
      this.inflight.delete(child);
      finish();
    });
    this.inflight.add(child);
    this.pending.add(closed);
    try {
      return await run;
    } finally {
      await closed;
      this.pending.delete(closed);
    }
  }

  async listMessages(q: ListMessagesQuery, signal?: AbortSignal): Promise<MessagePage> {
    const params: Record<string, string> = {
      container_id_type: "chat",
      container_id: q.chatId,
      sort_type: q.order === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
      page_size: String(q.pageSize ?? 50),
      with_sender_name: "true",
    };
    if (q.startTime !== undefined) params.start_time = String(Math.max(0, Math.floor(q.startTime)));
    if (q.endTime !== undefined) params.end_time = String(Math.max(0, Math.ceil(q.endTime)));
    if (q.pageToken) params.page_token = q.pageToken;
    const data = (await this.get("/open-apis/im/v1/messages", params, signal)) as { items?: RawMessage[]; has_more?: boolean; page_token?: string } | null;
    return { items: data?.items ?? [], hasMore: data?.has_more === true, pageToken: data?.page_token ?? "" };
  }

  /** 当前用户可见的全部群（分页取完，按活跃时间倒序） */
  async listChats(signal?: AbortSignal): Promise<RawChat[]> {
    const out: RawChat[] = [];
    let token = "";
    do {
      const params: Record<string, string> = { page_size: "100", sort_type: "ByActiveTimeDesc" };
      if (token) params.page_token = token;
      const data = (await this.get("/open-apis/im/v1/chats", params, signal)) as { items?: RawChat[]; has_more?: boolean; page_token?: string } | null;
      for (const c of data?.items ?? []) if (c.chat_id) out.push(c);
      if (!data?.has_more) break;
      if (!data.page_token || data.page_token === token) throw new LarkError("飞书群列表分页游标未推进", "api");
      token = data.page_token;
    } while (true);
    return out;
  }

  /** 终止所有在飞子进程并等它们真正退出 */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of this.inflight) c.kill("SIGTERM");
    const force = setTimeout(() => {
      for (const c of this.inflight) c.kill("SIGKILL");
    }, 2_000).unref();
    try {
      await Promise.allSettled([...this.pending]);
    } finally {
      clearTimeout(force);
    }
  }
}
