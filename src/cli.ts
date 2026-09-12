import { FeishuMonitor } from "./feishu/watch.js";
import type { GroupMsg, MonitorEvent } from "./core/messages.js";
import { Engine } from "./core/engine.js";
import { Bridge } from "./core/rpc.js";
import { startServer } from "./core/server.js";
import { okxCheck, rpcConfig, tradeConfig, walletInit, walletShow } from "./core/setup.js";
import { NativePriceFeed } from "./core/native-price.js";
import { OkxClient } from "./core/okx.js";
import { Sources } from "./core/sources.js";
import { BurnerWallet, KeychainStore } from "./core/wallet.js";
import { Store } from "./core/store.js";
import { WatchManager } from "./core/watchers.js";
import { WechatReader } from "./wechat/reader.js";

/** 启动回灌小时数（原来是设置项，2026-09-10 用户「去掉回灌可选项」→ 固定；调试用 --since 覆盖） */
const BACKFILL_HOURS = 6;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    flags[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  return flags;
}

/** --since 支持：ISO 日期 / Unix 秒 / 相对量（30m、6h、2d） */
function toSince(v: string | undefined, now: number): number {
  if (!v) return now;
  const rel = v.match(/^(\d+)([smhd])$/);
  if (rel) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2] as "s" | "m" | "h" | "d"];
    return now - Number(rel[1]) * mult;
  }
  if (/^\d{9,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? now : Math.floor(t / 1000);
}

async function main() {
  // 过滤掉 pnpm/npm 可能透传的独立 "--" 分隔符
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`用法:
  pnpm sidecar   (= pnpm cli run) [--group <群名/username>] [--since 6h|2026-09-03T00:00|<unix>] [--db <path>]
                                   完整 sidecar：监听 + 行情 + 落盘，stdout 推展示快照（Swift 消费）；--group 临时加一个群
  pnpm cli okx-check               发一次 supported/chain 验到 OKX 接口端点的链路（地址固定在 src/core/okx.ts）
  pnpm cli wallet-init             生成 burner 热钱包（EVM + Solana，私钥进 Keychain）并打印地址
  pnpm cli wallet-show [--balances true]   显示地址（可选各链原生币余额）
  pnpm cli trade-config [--rpc-<chain> https://…]   覆盖公共 RPC 节点；sidecar 在跑则立即生效`);
    return;
  }

  if (cmd === "run") {
    let shutdown: (() => Promise<void>) | undefined;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void (shutdown?.() ?? Promise.resolve()).finally(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdout.on("error", stop);
    process.stdout.on("close", stop);
    process.stdin.on("close", stop);

    const bridge = new Bridge();
    const store = new Store(flags.db);
    // 交易模块的外部依赖：OKX 只经固定的接口端点（本机不持有凭据），本机 Keychain 只放 burner 私钥；原生币美元价（显示 / 限额）由 DexScreener 后台拉
    const keychain = new KeychainStore();
    const nativePrices = new NativePriceFeed();
    const engine = new Engine(store, bridge, {}, {
      okx: () => new OkxClient(),
      wallet: (rpc) => BurnerWallet.load(keychain, rpcConfig(rpc)),
      nativePrices,
    });
    nativePrices.start();
    engine.start();

    // 群列表来自设置（dashboard 可改）；--group 只是调试时临时加一个
    let settings = store.getSettings();
    if (flags.group) {
      const u = new WechatReader().resolveTarget(flags.group);
      if (u && !settings.groups.includes(u)) settings = { ...settings, groups: [...settings.groups, u] };
    }
    const sinceTs = flags.since ? toSince(flags.since, Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000) - BACKFILL_HOURS * 3600;
    let maxTime = sinceTs;
    const onMsg = (m: GroupMsg) => {
      if (stopping) return;
      console.error(`[msg] ${m.group} @${m.time} addrs=${m.addrs.length}${m.backfill ? " (backfill)" : ""}`);
      engine.ingest(m);
    };
    const onEvent = (e: MonitorEvent) => {
      if (stopping) return;
      if (e.t === "heartbeat") {
        maxTime = Math.max(maxTime, e.maxTime);
        bridge.emit({ t: "heartbeat", maxTime, polls: e.polls });
      } else if (e.t === "error") bridge.emit(e);
      else if (e.t === "context") engine.ingestContext(e);
      else emitGroups();
    };
    const watchers = new WatchManager(sinceTs, onMsg, (e, group) => onEvent(e.t === "error" ? { t: "error", message: `${group}: ${e.message}` } : e));
    const feishu = new FeishuMonitor(sinceTs, onMsg, onEvent);
    const emitGroups = () => bridge.emit({
      t: "ready",
      groups: [
        ...settings.groups.map((u) => ({ username: u, displayName: watchers.displayName(u) })),
        ...settings.feishuGroups.map((id) => ({ username: `feishu:${id}`, displayName: `飞书 · ${feishu.displayName(id)}` })),
      ],
      since: sinceTs,
    });
    // 群来源就绪态：Swift 在首启（没弹过引导且一个群都没选）或没有任何来源就绪时自动打开 dashboard 群组页，
    // 所以要等 dashboard URL 发出后再起；firstRun 只在第一条 sources 上为 true，发完即落库
    let firstRun = !store.onboarded && settings.groups.length === 0 && settings.feishuGroups.length === 0;
    const sources = new Sources((s) => {
      bridge.emit({ t: "sources", configured: s.configured, firstRun, wechat: { ready: s.wechat.ready }, feishu: { ready: s.feishu.ready } });
      if (firstRun) {
        store.markOnboarded();
        firstRun = false;
      }
    });
    shutdown = async () => {
      engine.close();
      nativePrices.close();
      watchers.stop();
      sources.stop();
      await feishu.stop();
    };
    engine.readContext = (group, ts, before, after) => group.startsWith("feishu:")
      ? feishu.readAround(group, ts, before, after)
      : watchers.readAround(group, ts, before, after);
    setTimeout(() => { if (!stopping) engine.prefetchContexts(); }, 8_000);
    watchers.startInitial(settings.groups);
    feishu.sync(settings.feishuGroups, true);
    emitGroups();
    bridge.emit({ t: "settings", settings });

    bridge.onCommand = (e) => {
      if (e.t === "simulate") engine.simulate();
      else if (e.t === "focus") engine.focus(e.address, e.chain ?? null);
      else if (e.t === "front_rank_visible") engine.frontRankVisible(e.addresses);
      else if (e.t === "kline") void engine.kline(e.address, e.resolution, e.from, e.to, true, e.chain ?? null);
      else if (e.t === "context") engine.context(e.address, e.sender, e.ts, e.group);
      else if (e.t === "fomo_thesis_more") engine.fomoThesisMore(e.address);
      else if (e.t === "gmgn_calls_more") engine.gmgnCallsMore(e.address);
      else if (e.t === "trade_quote") engine.tradeQuote(e);
      else if (e.t === "trade") engine.tradeIntent(e);
      else if (e.t === "trade_quick") engine.tradeQuick(e);
    };

    try {
      const url = await startServer({
        store,
        engine,
        watchers,
        feishu,
        sources,
        onSettings: (s) => {
          const tradeChanged = JSON.stringify(s.trade) !== JSON.stringify(settings.trade);
          settings = s;
          watchers.sync(s.groups);
          feishu.sync(s.feishuGroups);
          bridge.emit({ t: "settings", settings: s });
          emitGroups();
          if (tradeChanged) void engine.trade?.settingsChanged();
        },
      });
      console.error(`[dashboard] ${url}`);
      bridge.emit({ t: "dashboard", url });
    } catch (e) {
      console.error(`[dashboard] failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    sources.start();
    // 常驻：watcher 们在自己的循环里跑；进程靠信号 / stdin 关闭退出
    await Promise.withResolvers<never>().promise;
    return;
  }

  // ---- 一键买卖（OKX DEX + burner 热钱包）的本机命令；机密只进 Keychain ----
  if (cmd === "okx-check") return okxCheck();
  if (cmd === "wallet-init") return walletInit(undefined, new Store(flags.db).getSettings().trade.rpc);
  if (cmd === "wallet-show") return walletShow(undefined, { balances: flags.balances === "true", rpc: new Store(flags.db).getSettings().trade.rpc });
  if (cmd === "trade-config") {
    await tradeConfig(flags, flags.db);
    return;
  }

  console.error(`未知命令: ${cmd}（试试 pnpm cli help）`);
  process.exit(2);
}

main().catch((e) => {
  console.error(`\n[错误] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
