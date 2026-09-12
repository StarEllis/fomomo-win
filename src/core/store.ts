import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DB } from "better-sqlite3-multiple-ciphers";
import { DATA_DIR } from "../config.js";
import { DEFAULT_SETTINGS, NATIVE_SYMBOLS, type Ath, type BuyPresets, type FomoActivity, type Links, type Market, type Mention, type Sample, type Settings, type TokenState, type TradeEvent, type TradeSettings, type Tweet, type TwitterUser } from "./types.js";
import { thin } from "./engine.js";

/** 快捷额：买入按原生币分组、缺的组补默认；旧库存的是 USD 数组（2026-09-11 前）→ 整个买入段回默认 */
function mergePresets(saved: unknown): TradeSettings["presets"] {
  const d = DEFAULT_SETTINGS.trade.presets;
  const s = saved && typeof saved === "object" ? (saved as Partial<{ buy: unknown; sell: unknown }>) : {};
  const buy = { ...d.buy } as BuyPresets;
  if (s.buy && typeof s.buy === "object" && !Array.isArray(s.buy)) {
    for (const k of NATIVE_SYMBOLS) {
      const v = (s.buy as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.length) buy[k] = [...(v as number[])];
    }
  }
  return { buy, sell: Array.isArray(s.sell) && s.sell.length ? [...(s.sell as number[])] : [...d.sell] };
}

/**
 * 本地持久化（明文 sqlite，和微信加密库无关）：喊单记录 + 行情采样 + 代币快照 + 设置。
 * 目的：重启后恢复面板状态；给 dashboard 做「按人统计胜率/归零率」留原始数据。
 * 只存喊单那条消息的展示文本（标题/正文 ≤300 字），不存整段聊天。
 */
export class Store {
  readonly db: DB;
  readonly path: string;

  static defaultPath(): string {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return path.join(DATA_DIR, "fomomo.sqlite");
  }

  constructor(file = Store.defaultPath()) {
    this.path = file;
    this.db = new Database(file);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens(
        address TEXT PRIMARY KEY, chain TEXT, symbol TEXT, name TEXT, logo TEXT,
        first_seen REAL NOT NULL,
        price REAL, mc REAL, liq REAL, holders INTEGER, source TEXT, updated_at REAL,
        links TEXT, ath TEXT, profile TEXT, official TEXT, tweets TEXT, tweets_at REAL
      );
      CREATE TABLE IF NOT EXISTS calls(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, text TEXT, grp TEXT NOT NULL,
        price REAL, mc REAL, approx INTEGER NOT NULL DEFAULT 0,
        UNIQUE(address, sender, ts, grp)
      );
      CREATE INDEX IF NOT EXISTS calls_sender ON calls(sender);
      CREATE TABLE IF NOT EXISTS samples(
        address TEXT NOT NULL, ts REAL NOT NULL, price REAL NOT NULL, mc REAL, liq REAL,
        PRIMARY KEY(address, ts)
      );
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- K 线不落库：gmgn 一次往返两三百毫秒，进程内缓存够用（曾做过一版 candles 表，2026-09-04 拆掉）
      DROP TABLE IF EXISTS candles;
      DROP TABLE IF EXISTS candle_cov;
      -- 喊单语境：只存每次喊单周围的少量原文，来源群参与身份。
      DROP TABLE IF EXISTS contexts;
      CREATE TABLE IF NOT EXISTS call_context(
        address TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, grp TEXT NOT NULL,
        lines TEXT NOT NULL, call INTEGER NOT NULL, after INTEGER NOT NULL, at REAL NOT NULL,
        PRIMARY KEY(address, sender, ts, grp)
      );
      -- fomo.family 关注者对我们列表里代币的买卖/Thesis（fomo.ts）；只存列表里有的币，启动时清掉已不在 tokens 里的
      CREATE TABLE IF NOT EXISTS fomo_activity(
        address TEXT NOT NULL, chain TEXT NOT NULL, handle TEXT NOT NULL, avatar TEXT, kind TEXT NOT NULL,
        usd REAL, mc REAL, ts REAL NOT NULL, comment TEXT,
        PRIMARY KEY(address, handle, ts, kind)
      );
      -- 一键买卖（trade.ts：burner 钱包 + OKX）的生命周期账本（每笔一行，按 id）；重启时 in-flight 的变 unknown，绝不自动重发。
      -- created = 首次落 validating 的时刻（日限额按它算）；in_raw/out_raw = 输入/到账最小单位数量（字串，bigint），decimals/symbol 为当时的代币元数据（持仓统计不再查链）
      -- 老库里的 fomo_trade 表是 fomo 页面执行时期的历史，代码已不读写，保留数据不删。
      CREATE TABLE IF NOT EXISTS trade(
        id TEXT PRIMARY KEY, address TEXT NOT NULL, chain TEXT NOT NULL, side TEXT NOT NULL, usd REAL NOT NULL, pct REAL,
        quote_id TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, error TEXT, detail TEXT, ts REAL NOT NULL, created REAL NOT NULL,
        in_raw TEXT, out_raw TEXT, decimals INTEGER, symbol TEXT
      );
      CREATE INDEX IF NOT EXISTS trade_address ON trade(address, ts);
    `);
    // 老库补列（sqlite 没有 ADD COLUMN IF NOT EXISTS）
    this.addColumns("tokens", { logo: "TEXT", links: "TEXT", ath: "TEXT", profile: "TEXT", official: "TEXT", tweets: "TEXT", tweets_at: "REAL", erc20_check: "TEXT" });
    this.addColumns("calls", { grp: "TEXT" });
    this.migrateCallGroups();
  }

  private addColumns(table: string, cols: Record<string, string>): void {
    const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of Object.entries(cols)) if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  /** 旧库按 sender/time 去重会把不同来源的同名同刻喊单合并；保留原记录扩展唯一键。没标来源的旧喊单归到当时唯一监听的那个群（旧设置里的第一个） */
  private migrateCallGroups(): void {
    const indexes = this.db.pragma("index_list(calls)") as Array<{ name: string; unique: number }>;
    const oldCalls = indexes.some((index) => index.unique && (this.db.pragma(`index_info('${index.name}')`) as Array<{ name: string }>).map((c) => c.name).join(",") === "address,sender,ts");
    const oldContexts = (this.db.pragma("table_info(call_context)") as Array<{ name: string; pk: number }>).some((c) => c.name === "grp" && c.pk === 0);
    if (!oldCalls && !oldContexts) return;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    const legacyGroup = (row ? (JSON.parse(row.value) as { groups?: string[] }).groups?.[0] : undefined) ?? "unknown@chatroom";
    this.db.transaction(() => {
      if (oldCalls) {
        this.db.exec(`
          ALTER TABLE calls RENAME TO calls_before_group_key;
          CREATE TABLE calls(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            address TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, text TEXT, grp TEXT NOT NULL,
            price REAL, mc REAL, approx INTEGER NOT NULL DEFAULT 0,
            UNIQUE(address, sender, ts, grp)
          );
        `);
        this.db.prepare(`INSERT INTO calls SELECT id, address, sender, ts, text, COALESCE(grp, ?), price, mc, approx FROM calls_before_group_key`).run(legacyGroup);
        this.db.exec(`
          DROP TABLE calls_before_group_key;
          CREATE INDEX calls_sender ON calls(sender);
        `);
      }
      if (oldContexts) {
        this.db.exec(`
          ALTER TABLE call_context RENAME TO context_before_group_key;
          CREATE TABLE call_context(
            address TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, grp TEXT NOT NULL,
            lines TEXT NOT NULL, call INTEGER NOT NULL, after INTEGER NOT NULL, at REAL NOT NULL,
            PRIMARY KEY(address, sender, ts, grp)
          );
          INSERT INTO call_context SELECT address, sender, ts, grp, lines, call, after, at FROM context_before_group_key;
          DROP TABLE context_before_group_key;
        `);
      }
    })();
  }

  // ---------- settings ----------

  getSettings(): Settings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key='settings'`).get() as { value: string } | undefined;
    const saved = row ? JSON.parse(row.value) as Partial<Settings> : {};
    // 逐字段取，不 spread saved：老库还存着已删的键（sinceHours、trade 的费率/代理），不能漂回来
    return {
      groups: [...(saved.groups ?? DEFAULT_SETTINGS.groups)],
      feishuGroups: [...(saved.feishuGroups ?? DEFAULT_SETTINGS.feishuGroups)],
      panel: { ...DEFAULT_SETTINGS.panel, ...(saved.panel ?? {}) },
      trade: {
        rpc: { ...(saved.trade?.rpc ?? {}) },
        maxUsdPerTrade: saved.trade?.maxUsdPerTrade ?? DEFAULT_SETTINGS.trade.maxUsdPerTrade,
        maxUsdPerDay: saved.trade?.maxUsdPerDay ?? DEFAULT_SETTINGS.trade.maxUsdPerDay,
        presets: mergePresets(saved.trade?.presets),
      },
    };
  }

  setSettings(s: Settings): void {
    this.db.prepare(`INSERT INTO settings(key, value) VALUES('settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(s));
  }

  /**
   * 首启标记（settings 表里独立一行，不进 Settings 对象）：第一次 run 时不存在 → 引导页要弹；
   * 弹过就写上。与「来源是否就绪」无关——机器上可能早有 lark-cli 登录，但群一个都没选，页面还是得出现一次
   */
  get onboarded(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM settings WHERE key='onboarded'`).get();
  }

  markOnboarded(): void {
    this.db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES('onboarded', '1')`).run();
  }

  // ---------- tokens ----------

  upsertToken(t: TokenState): void {
    const m = t.market;
    this.db
      .prepare(
        `
      INSERT INTO tokens(address, chain, symbol, name, logo, first_seen, price, mc, liq, holders, source, updated_at, links, ath, profile, official, tweets, tweets_at, erc20_check)
      VALUES(@address, @chain, @symbol, @name, @logo, @first_seen, @price, @mc, @liq, @holders, @source, @updated_at, @links, @ath, @profile, @official, @tweets, @tweets_at, @erc20_check)
      ON CONFLICT(address) DO UPDATE SET
        chain=COALESCE(excluded.chain, chain), symbol=COALESCE(excluded.symbol, symbol), name=COALESCE(excluded.name, name), logo=COALESCE(excluded.logo, logo),
        first_seen=MIN(first_seen, excluded.first_seen),
        price=COALESCE(excluded.price, price), mc=COALESCE(excluded.mc, mc), liq=COALESCE(excluded.liq, liq),
        holders=COALESCE(excluded.holders, holders), source=COALESCE(excluded.source, source),
        updated_at=COALESCE(excluded.updated_at, updated_at),
        links=COALESCE(excluded.links, links), ath=COALESCE(excluded.ath, ath), profile=COALESCE(excluded.profile, profile), official=COALESCE(excluded.official, official),
        tweets=COALESCE(excluded.tweets, tweets), tweets_at=COALESCE(excluded.tweets_at, tweets_at),
        erc20_check=excluded.erc20_check
    `,
      )
      .run({
        address: t.address,
        chain: m?.chain ?? t.chainHint ?? null,
        symbol: m?.symbol ?? null,
        name: m?.name ?? null,
        logo: m?.logo ?? null,
        first_seen: t.mentions[0]?.time ?? Math.floor(Date.now() / 1000),
        price: m?.price ?? null,
        mc: m?.mc ?? null,
        liq: m?.liq ?? null,
        holders: m?.holders ?? null,
        source: m?.source ?? null,
        updated_at: m?.updatedAt ?? null,
        links: t.links ? JSON.stringify(t.links) : null,
        ath: t.ath ? JSON.stringify(t.ath) : null,
        profile: t.profile ? JSON.stringify(t.profile) : null,
        official: t.tweetsAt ? JSON.stringify(t.official) : null,
        tweets: t.tweetsAt ? JSON.stringify(t.tweets) : null,
        tweets_at: t.tweetsAt || null,
        // 不 COALESCE：行情到达后结论作废，要能把列清成 NULL
        erc20_check: t.erc20Check ? JSON.stringify(t.erc20Check) : null,
      });
  }

  insertCall(address: string, c: Mention): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO calls(address, sender, ts, text, grp, price, mc, approx) VALUES(?,?,?,?,?,?,?,?)`)
      .run(address, c.sender, c.time, c.text, c.group, c.price ?? null, c.mc ?? null, c.approx ? 1 : 0);
  }

  updateCallPrice(address: string, c: Mention): void {
    this.db
      .prepare(`UPDATE calls SET price=?, mc=?, approx=? WHERE address=? AND sender=? AND ts=? AND grp=?`)
      .run(c.price ?? null, c.mc ?? null, c.approx ? 1 : 0, address, c.sender, c.time, c.group);
  }

  insertSample(address: string, s: Sample, mc: number | null, liq: number | null): void {
    this.db.prepare(`INSERT OR IGNORE INTO samples(address, ts, price, mc, liq) VALUES(?,?,?,?,?)`).run(address, s.time, s.price, mc, liq);
  }

  // ---------- fomo.family 关注者动向 ----------

  insertFomoActivity(r: FomoActivityRow): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO fomo_activity(address, chain, handle, avatar, kind, usd, mc, ts, comment) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(r.address, r.chain, r.handle, r.avatar, r.kind, r.usd, r.mc, r.ts, r.comment);
  }

  /** 启动恢复：先删掉已不在 tokens 表里的币的记录（列表最多 80 个币，别让这表无限长），再整表按 ts 倒序读出 */
  loadFomoActivity(): FomoActivityRow[] {
    this.db.exec(`DELETE FROM fomo_activity WHERE address NOT IN (SELECT address FROM tokens)`);
    return this.db.prepare(`SELECT address, chain, handle, avatar, kind, usd, mc, ts, comment FROM fomo_activity ORDER BY ts DESC`).all() as FomoActivityRow[];
  }

  /**
   * 一笔交易的当前状态（upsert）。exec 各列 COALESCE：拿到就写、没拿到不覆盖（in_raw 在 submitting 时有，out_raw 在 confirmed 解析到账后才有）。
   * created 只在首次写入时定。
   */
  saveTrade(t: TradeEvent, quoteId: string, exec?: Partial<TradeExec> | null): void {
    this.db
      .prepare(
        `INSERT INTO trade(id, address, chain, side, usd, pct, quote_id, status, tx_hash, error, detail, ts, created, in_raw, out_raw, decimals, symbol) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET usd=excluded.usd, pct=excluded.pct, quote_id=excluded.quote_id, status=excluded.status, tx_hash=COALESCE(excluded.tx_hash, trade.tx_hash), error=excluded.error, detail=excluded.detail, ts=excluded.ts,
           in_raw=COALESCE(excluded.in_raw, trade.in_raw), out_raw=COALESCE(excluded.out_raw, trade.out_raw), decimals=COALESCE(excluded.decimals, trade.decimals), symbol=COALESCE(excluded.symbol, trade.symbol)`,
      )
      .run(t.id, t.address, t.chain, t.side, t.usd, t.pct, quoteId, t.status, t.txHash, t.error, t.detail, t.ts, t.ts, exec?.inRaw ?? null, exec?.outRaw ?? null, exec?.decimals ?? null, exec?.symbol ?? null);
  }

  private static readonly TRADE_COLS = "id, address, chain, side, usd, pct, quote_id, status, tx_hash, error, detail, ts, created, in_raw, out_raw, decimals, symbol";

  private static tradeRow(r: TradeRow): StoredTrade {
    return {
      ev: { t: "trade", id: r.id, address: r.address, chain: r.chain, side: r.side, usd: r.usd, pct: r.pct ?? null, status: r.status, txHash: r.tx_hash, error: r.error, detail: r.detail, ts: r.ts },
      quoteId: r.quote_id,
      created: r.created,
      exec: { inRaw: r.in_raw, outRaw: r.out_raw, decimals: r.decimals, symbol: r.symbol },
    };
  }

  /** 每个地址最近一笔（启动恢复给 Swift） */
  loadTrades(): StoredTrade[] {
    const rows = this.db.prepare(`SELECT ${Store.TRADE_COLS} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY address ORDER BY ts DESC, rowid DESC) AS rank FROM trade) WHERE rank = 1`).all() as TradeRow[];
    return rows.map(Store.tradeRow);
  }

  /** 按交易 id 查一笔（quick trade 的 id 由 Swift 生成：同 id 重放——哪怕该地址之后已有更新的记录、哪怕跨重启——只回放这条，不再执行） */
  tradeById(id: string): StoredTrade | null {
    const r = this.db.prepare(`SELECT ${Store.TRADE_COLS} FROM trade WHERE id = ?`).get(id) as TradeRow | undefined;
    return r ? Store.tradeRow(r) : null;
  }

  /** 这份报价是否已被**别的**交易记录消费过（重放保护，跨重启）；exceptId = 正在校验的这笔自己 */
  quoteConsumed(quoteId: string, exceptId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM trade WHERE quote_id = ? AND id <> ? AND status <> 'failed' LIMIT 1`).get(quoteId, exceptId);
  }

  /** dashboard：最近 limit 笔（ts 降序） */
  recentTrades(limit: number): TradeEvent[] {
    return (this.db.prepare(`SELECT ${Store.TRADE_COLS} FROM trade ORDER BY ts DESC, rowid DESC LIMIT ?`).all(limit) as TradeRow[]).map((r) => Store.tradeRow(r).ev);
  }

  /** 日限额：created ≥ since 且已上链或结果未知的买入 usd 合计（failed / 还没广播的不算） */
  buyUsdSince(since: number): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS s FROM trade WHERE side = 'buy' AND created >= ? AND status IN ('submitted', 'confirmed', 'unknown')`).get(since) as { s: number };
    return r.s;
  }

  /** 「错过金狗」口径：我们买过（已上链 / 已确认 / 结果未知，failed 不算）的地址集合，不限时间——只要下过单就不算错过 */
  boughtAddresses(): string[] {
    return (this.db.prepare(`SELECT DISTINCT address FROM trade WHERE side = 'buy' AND status IN ('submitted', 'confirmed', 'unknown')`).all() as Array<{ address: string }>).map((r) => r.address);
  }

  /**
   * 持仓统计口径：每个 (address, chain) 的 confirmed 记录合计。买入数量取 out_raw（到账），卖出数量取 in_raw（卖掉的）；
   * raw 缺的那笔只计 usd 不计数量（均价分母少算一笔，宁可 null 也不编）。
   */
  tradedTokens(): TradedToken[] {
    const rows = this.db
      .prepare(
        `SELECT address, chain, MAX(symbol) AS symbol, MAX(decimals) AS decimals,
           SUM(CASE WHEN side='buy' THEN usd ELSE 0 END) AS bought_usd, SUM(CASE WHEN side='sell' THEN usd ELSE 0 END) AS sold_usd,
           MIN(CASE WHEN side='buy' THEN created END) AS first_buy,
           GROUP_CONCAT(CASE WHEN side='buy' AND out_raw IS NOT NULL THEN out_raw || ':' || usd END, ',') AS buys,
           GROUP_CONCAT(CASE WHEN side='sell' AND in_raw IS NOT NULL THEN in_raw || ':' || usd END, ',') AS sells
         FROM trade WHERE status = 'confirmed' GROUP BY address, chain`,
      )
      .all() as Array<{ address: string; chain: string; symbol: string | null; decimals: number | null; bought_usd: number; sold_usd: number; first_buy: number | null; buys: string | null; sells: string | null }>;
    const legs = (s: string | null): Array<{ raw: bigint; usd: number }> => (s ? s.split(",").filter(Boolean).map((x) => { const [raw, usd] = x.split(":"); return { raw: BigInt(raw), usd: Number(usd) }; }) : []);
    return rows.map((r) => ({ address: r.address, chain: r.chain, symbol: r.symbol, decimals: r.decimals, boughtUsd: r.bought_usd, soldUsd: r.sold_usd, firstBuy: r.first_buy, buys: legs(r.buys), sells: legs(r.sells) }));
  }

  /** 最近 limit 个代币（按首次喊单倒序）及其喊单、全跨度采样抽稀到 samplesPerToken */
  loadTokens(limit: number, samplesPerToken: number): TokenState[] {
    type TokRow = {
      address: string;
      chain: string | null;
      symbol: string | null;
      name: string | null;
      logo: string | null;
      first_seen: number;
      price: number | null;
      mc: number | null;
      liq: number | null;
      holders: number | null;
      source: string | null;
      updated_at: number | null;
      links: string | null;
      ath: string | null;
      profile: string | null;
      official: string | null;
      tweets: string | null;
      tweets_at: number | null;
      erc20_check: string | null;
    };
    const rows = this.db.prepare(`SELECT * FROM tokens ORDER BY first_seen DESC LIMIT ?`).all(limit) as TokRow[];
    const callStmt = this.db.prepare(`SELECT sender, ts, text, grp, price, mc, approx FROM calls WHERE address=? ORDER BY ts ASC`);
    const sampleStmt = this.db.prepare(`SELECT ts, price, mc FROM samples WHERE address=? ORDER BY ts ASC`);
    const parse = <T>(s: string | null): T | null => {
      if (!s) return null;
      try {
        return JSON.parse(s) as T;
      } catch {
        return null;
      }
    };
    // 严格校验形状：列里的坏数据（手改 / 旧版本）当没查过，下轮重新探测
    const erc20Check = (s: string | null): TokenState["erc20Check"] => {
      const c = parse<{ verdict?: unknown; checkedAt?: unknown }>(s);
      if (!c || typeof c !== "object") return undefined;
      const { verdict, checkedAt } = c;
      if (verdict !== "erc20" && verdict !== "non-erc20" && verdict !== "unknown") return undefined;
      if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt) || checkedAt < 0 || checkedAt > Date.now() / 1000) return undefined;
      return { verdict, checkedAt };
    };
    return rows.map((r) => {
      let market: Market | null = null;
      if (r.source === "gmgn" || r.source === "dex") {
        market = {
          symbol: r.symbol ?? undefined,
          name: r.name ?? undefined,
          logo: r.logo ?? undefined,
          chain: r.chain ?? undefined,
          price: r.price ?? undefined,
          mc: r.mc ?? undefined,
          liq: r.liq ?? undefined,
          holders: r.holders ?? undefined,
          source: r.source,
          updatedAt: r.updated_at ?? 0,
        };
      }
      const mentions = (
        callStmt.all(r.address) as Array<{ sender: string; ts: number; text: string | null; grp: string | null; price: number | null; mc: number | null; approx: number }>
      ).map((c) => ({
        sender: c.sender,
        time: c.ts,
        text: c.text ?? "",
        group: c.grp ?? DEFAULT_SETTINGS.groups[0],
        price: c.price ?? undefined,
        mc: c.mc ?? undefined,
        approx: c.approx !== 0,
      }));
      const all = (sampleStmt.all(r.address) as Array<{ ts: number; price: number; mc: number | null }>).map((s) => ({
        time: s.ts,
        price: s.price,
        mc: s.mc ?? undefined,
      }));
      return {
        address: r.address,
        chainHint: market ? null : r.chain,
        market,
        mentions,
        history: thin(all, samplesPerToken),
        links: parse<Links>(r.links),
        ath: parse<Ath>(r.ath),
        profile: parse<TwitterUser>(r.profile),
        official: parse<Tweet[]>(r.official) ?? [],
        tweets: parse<Tweet[]>(r.tweets) ?? [],
        tweetsAt: r.tweets_at ?? 0,
        erc20Check: market ? undefined : erc20Check(r.erc20_check),
      };
    });
  }

  // ---------- 喊单语境 ----------

  loadContexts(): CallContextRow[] {
    return (this.db.prepare(`SELECT address, sender, ts, grp, lines, call, after, at FROM call_context`).all() as Array<Omit<CallContextRow, "lines"> & { lines: string }>)
      .map((r) => ({ ...r, lines: JSON.parse(r.lines) }));
  }

  saveContext(c: CallContextRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO call_context(address, sender, ts, grp, lines, call, after, at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(c.address, c.sender, c.ts, c.grp, JSON.stringify(c.lines), c.call, c.after, c.at);
  }

  // ---------- 统计（dashboard） ----------

  /**
   * 每个（喊单人, 代币）一行：基准 mc、现 mc、峰值 mc。senderStats / overview 共用。口径：
   * - 基准 = 该人对该代币的**首次**喊单时的 mc（无 mc 用 price）
   * - 峰值 = 喊单后采样里的最高 mc；胜 = 峰值 ≥ 基准 × winX
   * - 归零 = 当前 mc ≤ 基准 × zeroX（或当前流动性 < $1K）
   */
  private outcomes(opts: { group?: string; sinceTs?: number }) {
    const where = ["c.price IS NOT NULL", "c.mc IS NOT NULL", "t.mc IS NOT NULL"];
    const args: unknown[] = [];
    if (opts.group) {
      where.push("c.grp = ?");
      args.push(opts.group);
    }
    if (opts.sinceTs) {
      where.push("c.ts >= ?");
      args.push(opts.sinceTs);
    }
    type Row = { sender: string; address: string; symbol: string | null; logo: string | null; chain: string | null; ts: number; base_mc: number; now_mc: number; now_liq: number | null; peak_mc: number | null };
    const rows = this.db
      .prepare(
        `
      SELECT c.sender, c.address, t.symbol, t.logo, t.chain, MIN(c.ts) ts, c.mc base_mc, t.mc now_mc, t.liq now_liq,
             (SELECT MAX(s.mc) FROM samples s WHERE s.address = c.address AND s.ts >= MIN(c.ts)) peak_mc
      FROM calls c JOIN tokens t ON t.address = c.address
      WHERE ${where.join(" AND ")}
      GROUP BY c.sender, c.address
    `,
      )
      .all(...args) as Row[];
    return rows.map((r) => {
      const nowX = r.now_mc / r.base_mc;
      return { ...r, nowX, peakX: Math.max(nowX, (r.peak_mc ?? 0) / r.base_mc) };
    });
  }

  senderStats(opts: { group?: string; sinceTs?: number; winX?: number; zeroX?: number }) {
    const winX = opts.winX ?? 1.5;
    const zeroX = opts.zeroX ?? 0.1;
    const rows = this.outcomes(opts);
    const by = new Map<string, { sender: string; calls: number; wins: number; zeros: number; mults: number[]; peaks: number[]; best: { symbol: string; x: number } | null }>();
    for (const r of rows) {
      const s = by.get(r.sender) ?? { sender: r.sender, calls: 0, wins: 0, zeros: 0, mults: [], peaks: [], best: null };
      const { nowX, peakX } = r;
      s.calls++;
      if (peakX >= winX) s.wins++;
      if (nowX <= zeroX || (r.now_liq !== null && r.now_liq < 1000)) s.zeros++;
      s.mults.push(nowX);
      s.peaks.push(peakX);
      if (!s.best || peakX > s.best.x) s.best = { symbol: r.symbol ?? r.address.slice(0, 8), x: peakX };
      by.set(r.sender, s);
    }
    const median = (xs: number[]) => {
      const a = [...xs].sort((x, y) => x - y);
      return a.length ? a[Math.floor(a.length / 2)] : 0;
    };
    return [...by.values()]
      .map((s) => ({
        sender: s.sender,
        calls: s.calls,
        winRate: s.wins / s.calls,
        zeroRate: s.zeros / s.calls,
        medianNowX: median(s.mults),
        medianPeakX: median(s.peaks),
        avgPeakX: s.peaks.reduce((a, b) => a + b, 0) / s.peaks.length,
        best: s.best,
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  /**
   * 某个喊单人喊过的全部代币（含还没定价的），每个代币一行：首次喊单时间/原话/群、喊单市值、现市值、现倍、峰倍。新的在上。
   * 与 senderStats 同口径（基准 = 该人对该币首次喊单 mc）。
   */
  senderCalls(sender: string, opts: { group?: string; sinceTs?: number }) {
    const where = ["c.sender = ?"];
    const args: unknown[] = [sender];
    if (opts.group) {
      where.push("c.grp = ?");
      args.push(opts.group);
    }
    if (opts.sinceTs) {
      where.push("c.ts >= ?");
      args.push(opts.sinceTs);
    }
    type Row = {
      address: string; symbol: string | null; logo: string | null; chain: string | null; ts: number; text: string | null; grp: string | null;
      n: number; base_mc: number | null; now_mc: number | null; now_liq: number | null; peak_mc: number | null;
    };
    const rows = this.db
      .prepare(
        `
      SELECT c.address, t.symbol, t.logo, t.chain, MIN(c.ts) ts,
             (SELECT text FROM calls c2 WHERE c2.address = c.address AND c2.sender = c.sender ORDER BY c2.ts LIMIT 1) text,
             (SELECT grp FROM calls c2 WHERE c2.address = c.address AND c2.sender = c.sender ORDER BY c2.ts LIMIT 1) grp,
             COUNT(*) n,
             (SELECT mc FROM calls c2 WHERE c2.address = c.address AND c2.sender = c.sender ORDER BY c2.ts LIMIT 1) base_mc,
             t.mc now_mc, t.liq now_liq,
             (SELECT MAX(s.mc) FROM samples s WHERE s.address = c.address AND s.ts >= MIN(c.ts)) peak_mc
      FROM calls c JOIN tokens t ON t.address = c.address
      WHERE ${where.join(" AND ")}
      GROUP BY c.address
      ORDER BY ts DESC
    `,
      )
      .all(...args) as Row[];
    return rows.map((r) => {
      const nowX = r.base_mc && r.now_mc ? r.now_mc / r.base_mc : null;
      const peakX = r.base_mc ? Math.max(nowX ?? 0, (r.peak_mc ?? 0) / r.base_mc) || null : null;
      return { ...r, nowX, peakX };
    });
  }

  /**
   * 总览页数据：24h 喊单/新币（含与前 24h 对比）、每小时/每天喊单节奏、整体胜率归零率、最近喊单、峰值最高、按链分布。
   * 胜/归零口径与 senderStats 一致（winX 1.5 / zeroX 0.1）。
   */
  overview(): Overview {
    const now = Math.floor(Date.now() / 1000);
    const count = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
    const calls24h = count(`SELECT COUNT(*) n FROM calls WHERE ts >= ?`, now - 86400);
    const callsPrev24h = count(`SELECT COUNT(*) n FROM calls WHERE ts >= ? AND ts < ?`, now - 172800, now - 86400);
    const tokens24h = count(`SELECT COUNT(*) n FROM tokens WHERE first_seen >= ?`, now - 86400);
    const tokensPrev24h = count(`SELECT COUNT(*) n FROM tokens WHERE first_seen >= ? AND first_seen < ?`, now - 172800, now - 86400);
    const senders24h = count(`SELECT COUNT(DISTINCT sender) n FROM calls WHERE ts >= ?`, now - 86400);
    const totalCalls = count(`SELECT COUNT(*) n FROM calls`);
    const totalTokens = count(`SELECT COUNT(*) n FROM tokens`);
    const firstTs = (this.db.prepare(`SELECT MIN(ts) t FROM calls`).get() as { t: number | null }).t;

    const bucket = (stepSec: number, n: number) => {
      const start = Math.floor(now / stepSec) * stepSec - (n - 1) * stepSec;
      const rows = this.db.prepare(`SELECT CAST((ts - ?) / ? AS INTEGER) i, COUNT(*) n FROM calls WHERE ts >= ? GROUP BY i`).all(start, stepSec, start) as { i: number; n: number }[];
      const out = Array.from({ length: n }, (_, i) => ({ t: start + i * stepSec, n: 0 }));
      for (const r of rows) if (r.i >= 0 && r.i < n) out[r.i].n = r.n;
      return out;
    };
    const perHour = bucket(3600, 24);
    const perDay = bucket(86400, 7);

    const all = this.outcomes({});
    const wins = all.filter((r) => r.peakX >= 1.5).length;
    const zeros = all.filter((r) => r.nowX <= 0.1 || (r.now_liq !== null && r.now_liq < 1000)).length;
    const peaks = all.map((r) => r.peakX).sort((a, b) => a - b);
    const medianPeakX = peaks.length ? peaks[Math.floor(peaks.length / 2)] : 0;
    const priced = totalCalls ? count(`SELECT COUNT(*) n FROM calls WHERE mc IS NOT NULL`) / totalCalls : 0;

    type Recent = { sender: string; ts: number; address: string; symbol: string | null; logo: string | null; chain: string | null; call_mc: number | null; now_mc: number | null; grp: string | null };
    const recent = (
      this.db
        .prepare(
          `SELECT c.sender, c.ts, c.address, t.symbol, t.logo, t.chain, c.mc call_mc, t.mc now_mc, c.grp
       FROM calls c JOIN tokens t ON t.address = c.address ORDER BY c.ts DESC LIMIT 8`,
        )
        .all() as Recent[]
    ).map((r) => ({ ...r, change: r.call_mc && r.now_mc ? (r.now_mc / r.call_mc - 1) * 100 : null }));

    const bestByToken = new Map<string, (typeof all)[number]>();
    for (const r of all) {
      const cur = bestByToken.get(r.address);
      if (!cur || r.peakX > cur.peakX) bestByToken.set(r.address, r);
    }
    const top = [...bestByToken.values()]
      .sort((a, b) => b.peakX - a.peakX)
      .slice(0, 5)
      .map((r) => ({ address: r.address, symbol: r.symbol, logo: r.logo, chain: r.chain, sender: r.sender, ts: r.ts, peakX: r.peakX, nowX: r.nowX }));

    const chains = (this.db.prepare(`SELECT COALESCE(chain, '?') chain, COUNT(*) n FROM tokens GROUP BY chain ORDER BY n DESC`).all() as { chain: string; n: number }[]);

    return {
      now, firstTs, totalCalls, totalTokens,
      calls24h, callsPrev24h, tokens24h, tokensPrev24h, senders24h,
      perHour, perDay,
      quality: { rated: all.length, winRate: all.length ? wins / all.length : 0, zeroRate: all.length ? zeros / all.length : 0, medianPeakX, priced },
      recent, top, chains,
    };
  }

  /**
   * 「N 小时战况」原料：窗口内**每一条**喊单（不按人/币去重）的基准市值、现市值、喊单后峰值市值 + 代币元数据，前端据此画结构与收益。
   * 峰值 = samples 里该币在喊单时刻之后的最高 mc（与 outcomes 同口径），现市值 = tokens.mc；没定价的喊单也返回（结构要算，收益标未定价）。
   */
  report(sinceTs: number): ReportCall[] {
    type Row = { id: number; address: string; sender: string; ts: number; grp: string; approx: number; symbol: string | null; logo: string | null; chain: string | null; base_mc: number | null; now_mc: number | null; now_liq: number | null; peak_mc: number | null };
    const rows = this.db
      .prepare(
        `SELECT c.id, c.address, c.sender, c.ts, c.grp, c.approx, t.symbol, t.logo, t.chain, c.mc base_mc, t.mc now_mc, t.liq now_liq,
                (SELECT MAX(s.mc) FROM samples s WHERE s.address = c.address AND s.ts >= c.ts) peak_mc
         FROM calls c LEFT JOIN tokens t ON t.address = c.address
         WHERE c.ts >= ? ORDER BY c.ts ASC`,
      )
      .all(sinceTs) as Row[];
    return rows.map((r) => {
      const priced = r.base_mc !== null && r.base_mc > 0 && r.now_mc !== null;
      const nowX = priced ? r.now_mc! / r.base_mc! : null;
      const peakX = priced ? Math.max(nowX!, (r.peak_mc ?? 0) / r.base_mc!) : null;
      return { id: r.id, address: r.address, sender: r.sender, ts: r.ts, group: r.grp, approx: r.approx === 1, symbol: r.symbol, logo: r.logo, chain: r.chain, baseMc: r.base_mc, nowMc: r.now_mc, nowLiq: r.now_liq, peakMc: r.peak_mc, nowX, peakX };
    });
  }
}

export interface CallContextRow {
  address: string;
  sender: string;
  ts: number;
  grp: string;
  lines: Array<{ time: number; sender: string; text: string }>;
  /** 喊单那条在 lines 里的下标 */
  call: number;
  /** 喊单之后拿到了几条（不足 CONTEXT_AFTER 说明喊单刚发生，之后可补读） */
  after: number;
  at: number;
}

/** fomo_activity 一行 = 某关注者对某币的一次买/卖/Thesis（address 小写；chain 为 gmgn slug） */
export interface FomoActivityRow extends FomoActivity {
  address: string;
  chain: string;
}

/** 执行细节（只有数量与元数据，不含签名/私钥）；各字段拿到才有 */
export interface TradeExec {
  /** 输入侧最小单位数量（buy = 原生币 wei/lamports；sell = 代币 raw） */
  inRaw: string | null;
  /** 到账最小单位数量（buy = 代币 raw，confirmed 后从 Transfer 日志解析；sell = 原生币，余额差） */
  outRaw: string | null;
  decimals: number | null;
  symbol: string | null;
}

export interface StoredTrade {
  ev: TradeEvent;
  quoteId: string;
  created: number;
  exec: TradeExec;
}

/** `tradedTokens()` 一行：某 (address, chain) 的 confirmed 合计；buys/sells 为有 raw 的那些腿（均价分子分母） */
export interface TradedToken {
  address: string;
  chain: string;
  symbol: string | null;
  decimals: number | null;
  boughtUsd: number;
  soldUsd: number;
  firstBuy: number | null;
  buys: Array<{ raw: bigint; usd: number }>;
  sells: Array<{ raw: bigint; usd: number }>;
}

type TradeRow = {
  id: string; address: string; chain: string; side: "buy" | "sell"; usd: number; pct: number | null; quote_id: string; status: TradeEvent["status"];
  tx_hash: string | null; error: string | null; detail: string | null; ts: number; created: number; in_raw: string | null; out_raw: string | null; decimals: number | null; symbol: string | null;
};

export interface Overview {
  now: number;
  firstTs: number | null;
  totalCalls: number;
  totalTokens: number;
  calls24h: number;
  callsPrev24h: number;
  tokens24h: number;
  tokensPrev24h: number;
  senders24h: number;
  perHour: Array<{ t: number; n: number }>;
  perDay: Array<{ t: number; n: number }>;
  quality: { rated: number; winRate: number; zeroRate: number; medianPeakX: number; priced: number };
  recent: Array<{ sender: string; ts: number; address: string; symbol: string | null; logo: string | null; chain: string | null; call_mc: number | null; now_mc: number | null; grp: string | null; change: number | null }>;
  top: Array<{ address: string; symbol: string | null; logo: string | null; chain: string | null; sender: string; ts: number; peakX: number; nowX: number }>;
  chains: Array<{ chain: string; n: number }>;
}

/** 战况页一条喊单：nowX/peakX = 现市值 / 峰值市值 ÷ 喊单市值；没定价（喊单时无行情）→ null */
export interface ReportCall {
  id: number;
  address: string;
  sender: string;
  ts: number;
  /** 原始群 id（微信 `…@chatroom` / `feishu:oc_…`）；显示名由 server 按监听器补 */
  group: string;
  /** 喊单价是回灌近似值（蜡烛/桶价） */
  approx: boolean;
  symbol: string | null;
  logo: string | null;
  chain: string | null;
  baseMc: number | null;
  nowMc: number | null;
  nowLiq: number | null;
  peakMc: number | null;
  nowX: number | null;
  peakX: number | null;
}
