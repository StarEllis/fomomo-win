import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { DASHBOARD_HTML } from "../config.js";
import type { FeishuMonitor } from "../feishu/watch.js";
import type { QQMonitor } from "../qq/watch.js";
import type { Engine } from "./engine.js";
import { TRADE_CHAINS } from "./okx.js";
import type { Sources } from "./sources.js";
import type { Store } from "./store.js";
import { DEFAULT_SETTINGS, NATIVE_SYMBOLS, type BuyPresets, type PopupSettings, type QQSettings, type Settings, type TradeSettings } from "./types.js";
import type { WatchManager } from "./watchers.js";

export const DASHBOARD_PORT = 48765;

/**
 * 本地 dashboard：127.0.0.1 only。静态页 + JSON API。
 * 设置改动 → 立即生效（群列表 sync 到 watcher；panel 尺寸推给 Swift）。
 */
export function startServer(deps: { store: Store; engine: Engine; watchers: WatchManager; feishu: FeishuMonitor; qq: QQMonitor; sources: Sources; onSettings: (s: Settings) => void }): Promise<string> {
  // 每次请求现读：改样式刷新即见，不用重启 sidecar（本地单用户，成本可忽略）
  const htmlPath = DASHBOARD_HTML;

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
    let s = "";
    for await (const chunk of req) s += chunk;
    return s ? JSON.parse(s) : {};
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(htmlPath));
      }
      if (url.pathname === "/api/tokens") return json(res, 200, deps.engine.views());
      // dashboard「交易」页：钱包 / 余额 / 限额状态 + 最近交易 + 持仓；refresh 先重读六链余额
      if (url.pathname === "/api/trade" || (url.pathname === "/api/trade/refresh" && req.method === "POST")) {
        const trade = deps.engine.trade;
        if (!trade) return json(res, 503, { error: "交易模块未装载" });
        if (url.pathname === "/api/trade/refresh") await trade.refreshBalances();
        return json(res, 200, { state: trade.state(), trades: deps.store.recentTrades(50), holdings: trade.holdings() });
      }
      // 调试（只读，不下单）：一次 OKX 报价并返回 Swift 会收到的同一份 trade_quote。例：/api/trade/quote?address=0x…&chain=bsc&side=buy&amount=0.01（amount = 原生币数量；sell 用 pct=100）
      if (url.pathname === "/api/trade/quote") {
        const trade = deps.engine.trade;
        if (!trade) return json(res, 503, { error: "交易模块未装载" });
        const q = url.searchParams;
        const address = q.get("address");
        if (!address) return json(res, 400, { error: "address required" });
        const pct = q.get("pct");
        return json(res, 200, await trade.quoteOnce({ address, chain: q.get("chain") ?? "", side: q.get("side") === "sell" ? "sell" : "buy", amount: Number(q.get("amount") ?? 0), pct: pct ? Number(pct) : null }));
      }
      // 「N 小时战况」：窗口内每条喊单的收益原料 + 群显示名 + 我们买过的地址（前端算「错过金狗」）；hours 1–168，默认 24
      if (url.pathname === "/api/report") {
        const hours = clamp(Number(url.searchParams.get("hours") ?? 24), 1, 168);
        const now = Math.floor(Date.now() / 1000);
        const since = now - hours * 3600;
        const calls = deps.store.report(since);
        const groups: Record<string, string> = {};
        for (const c of calls) groups[c.group] ??= c.group.startsWith("feishu:") ? `飞书 · ${deps.feishu.displayName(c.group.slice(7))}` : c.group.startsWith("qq:") ? `QQ · ${deps.qq.displayName(c.group.slice(3))}` : deps.watchers.displayName(c.group);
        return json(res, 200, { now, since, hours, calls, groups, bought: deps.store.boughtAddresses() });
      }
      if (url.pathname === "/api/overview") return json(res, 200, deps.store.overview());
      if (url.pathname === "/api/settings" && req.method === "GET") return json(res, 200, deps.store.getSettings());
      if (url.pathname === "/api/settings" && req.method === "PUT") {
        const patch = (await readBody(req)) as Partial<Settings>;
        const cur = deps.store.getSettings();
        const next: Settings = {
          groups: Array.isArray(patch.groups) ? [...new Set(patch.groups.filter((g) => typeof g === "string" && g.endsWith("@chatroom")))] : cur.groups,
          feishuGroups: Array.isArray(patch.feishuGroups) ? [...new Set(patch.feishuGroups.filter((g) => typeof g === "string" && /^oc_[a-zA-Z0-9]+$/.test(g)))] : cur.feishuGroups,
          qqGroups: Array.isArray(patch.qqGroups) ? [...new Set(patch.qqGroups.filter((g) => typeof g === "string" && /^\d{5,15}$/.test(g)))] : cur.qqGroups,
          panel: sanitizePanel(patch.panel, cur.panel),
          popup: sanitizePopup(patch.popup, cur.popup),
          qq: sanitizeQQ(patch.qq, cur.qq),
          trade: sanitizeTrade(patch.trade, cur.trade),
        };
        deps.store.setSettings(next);
        deps.onSettings(next);
        return json(res, 200, next);
      }
      // 群来源引导：状态 + 动作。动作都幂等、立即返回最新状态；失败 500 带原因（页面直接显示）
      if (url.pathname === "/api/sources") {
        const status = await deps.sources.status(url.searchParams.get("refresh") === "1");
        // The dashboard uses these capability flags to avoid presenting the
        // trading controls in the Windows build.  Keeping them in this local
        // API is backwards compatible with older clients that only read `ready`.
        return json(res, 200, { ...status, platform: process.platform, tradeEnabled: process.platform !== "win32", panelLimits: PANEL_LIMITS });
      }
      if (url.pathname.startsWith("/api/sources/") && req.method === "POST") {
        const action = url.pathname.slice("/api/sources/".length);
        if (action === "wechat/key") {
          const body = (await readBody(req)) as { key?: unknown };
          await deps.sources.setWechatKey(typeof body.key === "string" ? body.key : "");
        } else if (action === "wechat/auto-key") {
          await deps.sources.autoGetWechatKey();
        } else if (action === "wechat/setup") await deps.sources.startWechatSetup();
        else if (action === "wechat/disk-access") await deps.sources.openDiskAccessSettings();
        else if (action === "wechat/clt") await deps.sources.installCommandLineTools();
        else if (action === "feishu/login") deps.sources.startFeishuLogin();
        else if (action === "feishu/cancel") deps.sources.cancelFeishuLogin();
        // 异常处理：三个来源各有一个「就地修好」的动作，都幂等，做完回最新状态
        else if (action === "wechat/restart") deps.watchers.restart();
        else if (action === "feishu/retry") deps.feishu.retryNow();
        else if (action === "qq/reconnect") await deps.qq.reconnect();
        else if (action === "qq/restart") {
          if (process.platform !== "win32") return json(res, 400, { error: "NapCat 自动重启仅支持 Windows" });
          const script = process.env.FOMOMO_NAPCAT_RESTART_SCRIPT || "D:\\NapCat\\Restart-NapCat-Framework.ps1";
          if (!fs.existsSync(script)) return json(res, 404, { error: `找不到 NapCat 重启脚本：${script}` });
          // 不能 detached：DETACHED_PROCESS 下 powershell.exe 没有控制台，会立刻 exit 0 什么都不干。
          // 等它跑完再回（脚本自己就 sleep 2s），失败直接报给界面 —— 之前无脑回 200，
          // powershell 根本没起来用户也只看到按钮闪一下，查了半天
          const fail = await new Promise<string | null>((resolve) => {
            const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: "ignore", windowsHide: true });
            child.on("error", (e) => resolve(`起不来 powershell：${e.message}`));
            child.on("exit", (code) => resolve(code === 0 ? null : `重启脚本退出码 ${code}`));
          });
          if (fail) return json(res, 500, { error: fail });
          // NapCat 重启要好几秒，这里连不上很正常；界面每 2s 轮询状态时会自己接上
          void deps.qq.reconnect();
        }
        else return json(res, 404, { error: "未知动作" });
        return json(res, 200, await deps.sources.status(true));
      }
      if (url.pathname === "/api/groups") {
        const source = url.searchParams.get("source") ?? "wechat";
        if (source === "feishu") return json(res, 200, await deps.feishu.listGroups(url.searchParams.get("refresh") === "1"));
        if (source === "qq") return json(res, 200, await deps.qq.listGroups(url.searchParams.get("refresh") === "1"));
        if (source !== "wechat") return json(res, 400, { error: "未知群组来源" });
        const watched = new Set(deps.store.getSettings().groups);
        const list = deps.watchers.reader.listGroups(300).map((g) => {
          // 已选群带上实时监听态，异常才看得见（飞书 / QQ 的 listGroups 自己就带）
          const st = watched.has(g.username) ? deps.watchers.groupState(g.username) : undefined;
          return {
            username: g.username,
            displayName: g.displayName,
            lastTimestamp: g.lastTimestamp,
            summary: g.summary,
            watched: watched.has(g.username),
            source: "wechat" as const,
            ...(st ? { state: st.state, ...(st.error ? { error: st.error } : {}) } : {}),
          };
        });
        return json(res, 200, list);
      }
      if (url.pathname === "/api/sender") {
        const name = url.searchParams.get("name") ?? "";
        const group = url.searchParams.get("group") || undefined;
        const hours = Number(url.searchParams.get("hours") || 0);
        return json(res, 200, deps.store.senderCalls(name, { group, sinceTs: hours ? Math.floor(Date.now() / 1000) - hours * 3600 : undefined }));
      }
      if (url.pathname === "/api/stats") {
        const group = url.searchParams.get("group") || undefined;
        const hours = Number(url.searchParams.get("hours") || 0);
        const winX = Number(url.searchParams.get("winX") || 1.5);
        const zeroX = Number(url.searchParams.get("zeroX") || 0.1);
        return json(res, 200, deps.store.senderStats({ group, sinceTs: hours ? Math.floor(Date.now() / 1000) - hours * 3600 : undefined, winX, zeroX }));
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  server.on("error", reject);
  server.listen(DASHBOARD_PORT, "127.0.0.1", () => resolve(`http://127.0.0.1:${DASHBOARD_PORT}/`));
  return promise;
}

/** 悬浮窗尺寸下限跟着壳走：Windows 壳的边缘手柄 / 窗口按 320×420 夹，macOS 280×300 */
export const PANEL_LIMITS = process.platform === "win32"
  ? { minWidth: 320, maxWidth: 600, minHeight: 420, maxHeight: 1400 }
  : { minWidth: 280, maxWidth: 600, minHeight: 300, maxHeight: 1400 };

export function sanitizePanel(patch: Partial<Settings["panel"]> | undefined, cur: Settings["panel"]): Settings["panel"] {
  const p = patch && typeof patch === "object" ? patch : {};
  // 位置：null = 清掉（回默认左上角），数字 = 屏幕 DIP 坐标（多屏可以是负数），其它保持
  const pos = (v: unknown, old: number | null | undefined) => v === null ? null : typeof v === "number" && Number.isFinite(v) ? Math.round(clamp(v, -100_000, 100_000)) : old ?? null;
  return {
    width: clamp(Number(p.width ?? cur.width), PANEL_LIMITS.minWidth, PANEL_LIMITS.maxWidth),
    height: clamp(Number(p.height ?? cur.height), PANEL_LIMITS.minHeight, PANEL_LIMITS.maxHeight),
    backgroundOpacity: clamp(Number(p.backgroundOpacity ?? cur.backgroundOpacity ?? DEFAULT_SETTINGS.panel.backgroundOpacity), 0, 1),
    x: pos(p.x, cur.x),
    y: pos(p.y, cur.y),
    compact: typeof p.compact === "boolean" ? p.compact : cur.compact ?? false,
  };
}

export function sanitizePopup(patch: Partial<PopupSettings> | undefined, cur: PopupSettings): PopupSettings {
  const p = patch && typeof patch === "object" ? patch : {};
  return {
    mode: p.mode === "card" || p.mode === "notify" || p.mode === "off" ? p.mode : cur.mode,
    seconds: p.seconds !== undefined && Number.isFinite(Number(p.seconds)) ? Math.round(clamp(Number(p.seconds), 2, 60)) : cur.seconds,
  };
}

/** OneBot 地址只收 ws(s)://，空串 = 用默认；token 去首尾空白、限长 */
export function sanitizeQQ(patch: Partial<QQSettings> | undefined, cur: QQSettings): QQSettings {
  const p = patch && typeof patch === "object" ? patch : {};
  const url = typeof p.url === "string" ? p.url.trim() : cur.url;
  if (url && !/^wss?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, "OneBot 地址要以 ws:// 或 wss:// 开头");
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled,
    url,
    token: typeof p.token === "string" ? p.token.trim().slice(0, 512) : cur.token,
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/**
 * 交易配置只接受合法值，非法字段回退当前值：RPC 只收 https；限额：单笔 1–100000、日 ≥ 单笔且 ≤ 1000000；快捷额 1–6 个、去重升序（买入按原生币分组，>0；卖出 1–100 整数）。
 * 接口地址是固定端点（okx.ts OKX_API_BASE），不在本机配置里；未知字段忽略
 */
export function sanitizeTrade(patch: Partial<TradeSettings> | undefined, cur: TradeSettings): TradeSettings {
  if (!patch || typeof patch !== "object") return cur;
  const rpc: TradeSettings["rpc"] = {};
  const src = patch.rpc && typeof patch.rpc === "object" ? patch.rpc : cur.rpc;
  for (const c of TRADE_CHAINS) {
    const u = (src as Record<string, unknown>)[c];
    if (typeof u === "string" && /^https:\/\/\S+$/.test(u)) rpc[c] = u;
  }
  const perTrade = Number.isFinite(Number(patch.maxUsdPerTrade)) && patch.maxUsdPerTrade !== undefined ? clamp(Number(patch.maxUsdPerTrade), 1, 100_000) : cur.maxUsdPerTrade;
  const perDay = Number.isFinite(Number(patch.maxUsdPerDay)) && patch.maxUsdPerDay !== undefined ? clamp(Number(patch.maxUsdPerDay), perTrade, 1_000_000) : Math.max(cur.maxUsdPerDay, perTrade);
  const list = (v: unknown, ok: (n: number) => boolean, fallback: number[]): number[] => {
    if (!Array.isArray(v)) return fallback;
    const xs = [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && ok(n)))].sort((a, b) => a - b);
    return xs.length >= 1 && xs.length <= 6 ? xs : fallback;
  };
  const presets = patch.presets && typeof patch.presets === "object" ? patch.presets : cur.presets;
  // 买入快捷额按原生币逐组校验；老 dashboard 传数组（USD 版）→ 整段回当前值
  const buySrc = presets.buy && typeof presets.buy === "object" && !Array.isArray(presets.buy) ? (presets.buy as Record<string, unknown>) : {};
  const buy = {} as BuyPresets;
  for (const sym of NATIVE_SYMBOLS) buy[sym] = list(buySrc[sym], (n) => n > 0, cur.presets.buy[sym]);
  return {
    rpc,
    maxUsdPerTrade: perTrade,
    maxUsdPerDay: perDay,
    presets: { buy, sell: list(presets.sell, (n) => Number.isInteger(n) && n >= 1 && n <= 100, cur.presets.sell) },
  };
}
