import readline from "node:readline";
import type { GmgnFetchParams, GmgnFetchResult, InEvent, OutEvent, RpcMethod } from "./types.js";

/**
 * 与 Swift 的双向 JSON Lines：
 *   stdout → Swift：事件（含 rpc 请求）
 *   stdin  ← Swift：rpc 结果 / 调试指令
 * stdout 上只允许走这里，人类可读日志一律 stderr。
 */
export class Bridge {
  private nextId = 1;
  private readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = new Map();
  /** 非 rpc 的 stdin 指令（simulate 等） */
  onCommand: ((e: InEvent) => void) | null = null;

  constructor() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let e: InEvent;
      try {
        e = JSON.parse(line) as InEvent;
      } catch {
        console.error(`[bridge] bad stdin line: invalid JSON (${line.length} chars)`);
        return;
      }
      if (e.t === "rpc_result") {
        const p = this.pending.get(e.id);
        if (!p) return;
        this.pending.delete(e.id);
        if (e.ok) p.resolve(e.result);
        else p.reject(new Error(e.error));
        return;
      }
      this.onCommand?.(e);
    });
  }

  emit(e: OutEvent): void {
    process.stdout.write(JSON.stringify(e) + "\n");
  }

  /** 让 Swift 代发一个请求（gmgn.fetch 在 gmgn 页面里；x.graphql 在 x.com 页面里） */
  rpc(method: RpcMethod, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error("rpc timeout"));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    this.emit({ t: "rpc", id, method, params });
    return promise;
  }

  gmgnFetch(params: GmgnFetchParams): Promise<GmgnFetchResult> {
    return this.rpc("gmgn.fetch", params) as Promise<GmgnFetchResult>;
  }
}
