import SwiftUI
import Observation

// MARK: - 展示模型（sidecar 推来的快照，与 src/core/types.ts 的 TokenView 对齐；Swift 不做业务计算）

struct Market: Decodable, Equatable {
    var symbol: String?
    var name: String?
    var logo: String?
    var chain: String?          // gmgn 口径：bsc / eth / base / sol / robinhood …
    var price: Double?
    var mc: Double?
    var liq: Double?
    var change5m: Double?
    var change1h: Double?
    var change24h: Double?
    var holders: Double?
    var source: String          // "gmgn" / "dex"
}

/// 首次喊单那条消息前后的群聊原文（sidecar `context` 事件）
struct CallContext: Equatable {
    struct Line: Equatable { let time: Double; let sender: String; let text: String }
    let address: String
    /// 这是哪一次喊单的语境（K 线上对应标记画实心）
    let sender: String
    let ts: Double
    let group: String
    let lines: [Line]
    /// 喊单那条在 lines 里的下标（-1 = 没对上）
    let call: Int
}

/// 群里一次喊单
struct Mention: Decodable, Equatable {
    let sender: String
    let time: Double            // unix 秒
    let text: String
    let group: String           // 来源群 username
    var mc: Double?
}

struct Socials: Decodable, Equatable {
    var twitter: String?
    var website: String?
    var telegram: String?
}

struct Ath: Decodable, Equatable {
    let mc: Double
}

/// 一条提到该代币的推文
struct TwitterUser: Decodable, Equatable {
    let name: String
    let screen: String
    let avatar: String
    let followers: Int
    let verified: Bool
    var bio: String?
    var joined: Double?
}

struct Tweet: Decodable, Equatable, Identifiable {
    typealias User = TwitterUser
    /// 被引用的原推（sidecar 只嵌一层，所以不递归；字段同 Tweet 去掉 quoted）
    struct Quoted: Decodable, Equatable {
        let time: Double
        let user: TwitterUser
        let text: String
        var translation: String?
    }
    let id: String
    let url: String
    let time: Double
    let user: User
    let text: String
    var likes: Int?
    /// 中文译文（sidecar 翻的；原文已是中文 / 没翻到 → nil）
    var translation: String?
    var quoted: Quoted?
}

/// 面板尺寸（sidecar 下发，dashboard 可改；用户拖窗口边缘改尺寸后经 dashboard 的 `PUT /api/settings` 存回同一处）
struct PanelSize: Decodable, Equatable {
    let width: Double
    let height: Double
    /// 与 `src/core/server.ts` 的 clamp 一致（280–600 × 300–1400）：窗口拖到的尺寸夹在同一范围里，存回去才不会被服务端改掉
    static let minSize = NSSize(width: 280, height: 300)
    static let maxSize = NSSize(width: 600, height: 1400)
    /// 逻辑尺寸（存回设置的值）：只夹服务端范围，不看屏幕。屏幕小只影响窗口，不影响存的值
    static func logical(_ s: NSSize) -> PanelSize {
        PanelSize(width: min(max(s.width, minSize.width), maxSize.width), height: min(max(s.height, minSize.height), maxSize.height))
    }
    /// 物理尺寸（窗口实际 frame）：逻辑范围再夹进所在屏幕可见区——屏幕比最小值还小时窗口跟着屏幕缩，绝不溢出可见区
    static func clamp(_ s: NSSize, screen: NSSize) -> NSSize {
        let l = logical(s)
        return NSSize(width: min(l.width, screen.width), height: min(l.height, screen.height))
    }
}

/// fomo.family 上「我关注的人」对该币的一条动作（sidecar `TokenView.fomo.activity`）
struct FomoActivity: Decodable, Equatable, Identifiable {
    var id: String { "\(handle)|\(kind)|\(ts)" }
    let handle: String
    let avatar: String?
    /// buy / sell / thesis
    let kind: String
    let usd: Double?
    let mc: Double?
    /// unix 秒
    let ts: Double
    /// thesis 必有；买卖为 nil
    let comment: String?
}

/// fomo 代币页「Thesis」列的一条（sidecar `fomo_thesis`，`GET /feed/token/thesis`，全站用户）
struct FomoThesis: Decodable, Equatable, Identifiable {
    struct Position: Decodable, Equatable {
        let usd: Double
        let unrealizedPct: Double?
    }
    let id: String
    let handle: String
    let name: String
    let avatar: String?
    let verified: Bool
    /// unix 秒
    let ts: Double
    let comment: String
    let likes: Int
    let replies: Int
    /// 作者对该币的持仓（有持仓才有）
    let position: Position?
    let isDev: Bool
}

/// sidecar `fomo_thesis` 事件：某币 Thesis 列快照。`error` 非 nil 时 items 只是旧缓存（可能为空）：
/// not_logged_in / unsupported_chain / chain_unknown / fetch_failed / schema
struct FomoThesisFeed: Decodable, Equatable {
    let address: String
    let chain: String?
    let items: [FomoThesis]
    let count: Int?
    let hasNext: Bool
    let error: String?
    let loading: Bool
}

/// gmgn 代币页「喊单 → GMGN喊单」一条（sidecar `gmgn_calls`，`/api/v1/token/{chain}/{addr}/community/messages`）
struct GmgnCall: Decodable, Equatable, Identifiable {
    let id: String
    let handle: String
    let name: String
    let url: String?
    let avatar: String?
    let followers: Int
    let verified: Bool
    let kol: Bool
    /// unix 秒
    let ts: Double
    let text: String
    let image: String?
    let likes: Int
    let replies: Int
    /// 喊单后市值倍数
    let multiplier: Double?
    let replyTo: String?
}

/// sidecar `gmgn_calls` 事件：原生 GMGN喊单（cursor 翻页）+ 同页签「X喊单」（`tweets`，按时间降序）
struct GmgnCalls: Decodable, Equatable {
    let address: String
    let chain: String?
    let items: [GmgnCall]
    let hasNext: Bool
    /// 拉取失败原因；链未知 → "chain_unknown"
    let error: String?
    let loading: Bool
    let tweets: [Tweet]
    let tweetsAt: Double
    let tweetsLoading: Bool
    /// X喊单 最近一次拉取失败原因（成功后清空）
    let tweetsError: String?
}

/// 「fomo 前排比例」快照（sidecar `FomoView.frontRank`）：fomo 全站前 n（≤50）名持仓合计 ÷ gmgn 前排（仅排除 pool）前 n 名持仓合计；
/// ratio 为 nil 时 `why` 说明不可用原因。两侧计数 n < 50 表示列表已取尽（真实持有人不足 50）。
struct FomoFrontRank: Decodable, Equatable {
    struct Side: Decodable, Equatable {
        let amount: Double
        let n: Int
        let pools: Int?
    }
    let ratio: Double?
    let fomo: Side?
    let gmgn: Side?
    let at: Double
    let why: String?
}

extension FomoFrontRank {
    static let basis = "fomo 全站前 50 名持仓合计 ÷ gmgn 前排前 50 名持仓合计（仅排除 pool 地址；燃烧 / 交易所钱包 / dev 保留）"

    /// 展示文本：百分数（可 >100%，≥10 倍写 x）；任一侧不满 50 行时标 ·n；没快照 / ratio 为 nil →「—」。主面板行与弹卡共用
    static func text(_ fr: FomoFrontRank?) -> String {
        guard let fr, let r = fr.ratio, let f = fr.fomo, let g = fr.gmgn else { return "—" }
        let pct = r >= 10 ? String(format: "%.0fx", r) : String(format: r >= 1 ? "%.0f%%" : "%.1f%%", r * 100)
        return f.n < 50 || g.n < 50 ? "\(pct) ·\(min(f.n, g.n))" : pct
    }

    /// 悬浮说明：公式 → 两侧计数/金额 → 不可用原因 → 更新时间；没快照时说明还没拿到
    static func help(_ fr: FomoFrontRank?) -> String {
        guard let fr else { return basis + "\n还没拿到（焦点币每 15s 刷，主面板行排队刷）" }
        var lines = [basis]
        if let f = fr.fomo, let g = fr.gmgn {
            lines.append("fomo 前 \(f.n) 名 \(Fmt.compact(f.amount)) ÷ gmgn 前 \(g.n) 名 \(Fmt.compact(g.amount))" + ((g.pools ?? 0) > 0 ? "（跳过 \(g.pools!) 个 pool）" : ""))
        }
        if let why = fr.why { lines.append("不可用：" + why) }
        lines.append("更新 " + Fmt.clock(Date(timeIntervalSince1970: fr.at)))
        return lines.joined(separator: "\n")
    }
}

/// 关注者买入人数 / 当前持有人数 / 明细（按 ts 降序 ≤30）/ 前排比例；未登录 fomo 或该链不支持时整个字段为 nil
struct Fomo: Decodable, Equatable {
    let buyers: Int
    let holders: Int?
    let activity: [FomoActivity]
    let frontRank: FomoFrontRank?
}

/// 我在该币的持仓（sidecar `TokenView.position`，本地 burner 钱包链上余额）；没持有 → nil。usd 缺现价时为 nil
struct TradePosition: Decodable, Equatable {
    let amount: Double
    let usd: Double?
}

/// sidecar `trade_holdings` 事件里的一行：本地 burner 钱包的当前持仓（六链余额扫描，**不限于监听列表**）。
/// 累计买入 / 卖出 / 盈亏 / 开仓时刻来自本地交易账本（confirmed 的买卖）；转入 / 账本之外的仓位这些字段为 nil 或 0 → 界面显示「—」，不编数
struct TradeHolding: Decodable, Identifiable, Equatable {
    var id: String { chain + ":" + address }
    let address: String          // 归一化（EVM 小写）
    let chain: String            // 链 slug（eth / bsc / base / monad / robinhood / sol）
    let symbol: String
    let name: String?
    let logo: String?
    let amount: Double
    let price: Double?
    let usd: Double?
    /// 账本累计（confirmed 买 / 卖的 usd 合计）
    let boughtUsd: Double
    let soldUsd: Double
    /// usd + soldUsd − boughtUsd；usd 缺 → nil。pnlPct = pnlUsd / boughtUsd × 100，没买过 → nil
    let pnlUsd: Double?
    let pnlPct: Double?
    /// 第一笔 confirmed 买入的时刻（unix 秒）；账本里没有 → nil
    let heldSince: Double?
    /// K 线买卖线：账本均价（USD / 枚）= Σusd / Σ数量；该侧没成交 → 该侧 nil；两侧都没有 → 整体 nil
    let tradePrices: TradePrices?

    struct TradePrices: Decodable, Equatable {
        let buy: Double?
        let sell: Double?
    }

    var logoURL: URL? { logo.flatMap(URL.init(string:)) }
}

/// sidecar `fomo_state` 事件：fomo.family 登录态（信号半边；交易半边见 `TradeState`）
struct FomoState: Equatable {
    var loggedIn = false
}

/// sidecar `trade_state` 事件：本地 burner 钱包 + OKX DEX 的可用状态、各链原生币余额（附 DexScreener 美元价缓存）、按原生币计的快捷额与 USD 限额
struct TradeState: Decodable, Equatable {
    struct Balance: Decodable, Equatable {
        /// 原生币数量（人类单位）
        let native: Double
        let symbol: String
        /// 原生币美元单价（sidecar DexScreener 60s 缓存）；拉不到 → nil，报价 / 下单不受影响，只影响「≈ $」显示与 USD 限额校验
        let price: Double?
        /// 原生币余额美元估值 = native × price；没价 → nil
        let usd: Double?
    }
    struct Presets: Decodable, Equatable {
        /// 买入快捷额：键 = 原生币符号（"ETH"/"BNB"/"SOL"/"MON"），值 = 原生币数量
        let buy: [String: [Double]]
        /// 持仓百分比 1–100
        let sell: [Int]
    }
    struct Limits: Decodable, Equatable {
        let perTrade: Double
        let perDay: Double
        /// 最近 24h 内 status ∈ {submitted, confirmed, unknown} 的买入 usd 合计
        let dayUsed: Double
    }
    /// 钱包已生成（OKX 出口固定，没有别的门禁）
    let ready: Bool
    /// 不 ready 的人话原因；ready 时 nil
    let reason: String?
    let evmAddress: String?
    let solAddress: String?
    /// 键 = 链 slug
    let balances: [String: Balance]
    let presets: Presets
    let limits: Limits
    let at: Double

    /// 该链原生币符号：优先 sidecar 余额里的，没收到那条链的余额就用静态链表；两处都没有 → nil
    func nativeSymbol(chain: String) -> String? { balances[chain]?.symbol ?? Self.chains.first { $0.slug == chain }?.native }
    /// 该链买入快捷额（原生币数量）；链未知 / 设置里没这个符号 → 空
    func buyPresets(chain: String) -> [Double] { nativeSymbol(chain: chain).flatMap { presets.buy[$0] } ?? [] }

    /// 本地最低单笔 $1（与 sidecar 常量同值；报价回来的 `TradeQuote.minUsd` 以 sidecar 为准）
    static let minUsd = 1.0
    /// 买入 `amount` 原生币在本地就能判的不可行原因（nil = 可行；最终仍由 sidecar 报价 / 执行时校验）。弹卡 swap 卡与持仓行快捷额共用。
    /// 余额只比原生币数量，**不需要价**；有 DexScreener 缓存价时再按 amount × price 判最低额 / 单笔 / 今日 USD 限额——
    /// 没价就放行，sidecar 执行时同样没价会拒单，这里不替它猜
    func buyReason(chain: String, amount: Double) -> String? {
        guard let b = balances[chain] else { return "该链余额未知" }
        if amount > b.native { return "\(b.symbol) 不足" }
        guard let price = b.price else { return nil }
        let usd = amount * price
        if usd < Self.minUsd { return "最低 ≈\(Fmt.usd(Self.minUsd))" }
        if usd > limits.perTrade { return "超单笔上限 \(Fmt.usd(limits.perTrade))" }
        if limits.dayUsed + usd > limits.perDay { return "超今日上限" }
        return nil
    }

    /// 六条链：slug（sidecar / OKX 用）、该转的原生币。充值弹窗按这个顺序列（群里实际热度：24h 战况里 RH + BSC + SOL 占九成以上）
    struct ChainInfo: Identifiable {
        let slug: String
        let native: String
        var id: String { slug }
    }
    static let chains: [ChainInfo] = [
        ChainInfo(slug: "robinhood", native: "ETH"),
        ChainInfo(slug: "bsc", native: "BNB"),
        ChainInfo(slug: "sol", native: "SOL"),
        ChainInfo(slug: "eth", native: "ETH"),
        ChainInfo(slug: "base", native: "ETH"),
        ChainInfo(slug: "monad", native: "MON"),
    ]
    /// 钱包一把都没有（没生成 / 还没收到 trade_state）
    var hasWallet: Bool { evmAddress != nil || solAddress != nil }

    /// 还没收到过 `trade_state`：一律不可交易，门禁行显示「等待 sidecar…」
    static let initial = TradeState(ready: false, reason: nil, evmAddress: nil, solAddress: nil, balances: [:],
                                    presets: Presets(buy: [:], sell: []), limits: Limits(perTrade: 0, perDay: 0, dayUsed: 0), at: 0)
}

/// sidecar `trade_quote` 事件：一次性报价（输入原生币数量 / 点快捷额时问一次，无周期刷新、无过期时间）。`id` 就是之后 `trade` 意图要钉住的那份报价；
/// 执行时 sidecar 用 `/swap` 现取新路由和 tx（OKX 自带 autoSlippage ≤15% / 价格影响保护 50%），这份报价只做展示与意图校验
struct TradeQuote: Decodable, Equatable {
    let id: String
    let address: String
    let chain: String
    /// buy / sell
    let side: String
    /// 请求的原生币数量（buy）；sell 为 0
    let amount: Double
    /// 美元估值（buy = amount × 缓存价，sell = 卖出数量 × 现价）；拿不到价 → nil，只做显示
    let usd: Double?
    /// sell 按持仓比例时回显；buy 为 nil
    let pct: Int?
    let ok: Bool
    let outAmount: Double?
    let outSymbol: String?
    let outUsd: Double?
    let networkFeeUsd: Double?
    let priceImpactPct: Double?
    /// OKX 标记
    let honeypot: Bool
    let taxPct: Double?
    /// 本地最低额（USD）
    let minUsd: Double
    let error: String?
    /// 报价时刻（秒或毫秒，`ageSeconds` 归一）
    let at: Double

    /// 报价距现在几秒（`Feed.now` 5s 一跳）
    func ageSeconds(now: Date) -> Int { max(0, Int(now.timeIntervalSince1970 - (at > 1e11 ? at / 1000 : at))) }
}

/// sidecar `trade` 事件：一次下单的生命周期。status = validating | submitting | submitted | confirmed | failed | unknown；
/// `unknown` 只能由 sidecar 对账后改成终态，UI 不得按时间自动解锁
struct Trade: Decodable, Equatable {
    let id: String
    let address: String
    let chain: String
    let side: String
    let usd: Double
    let pct: Int?
    let status: String
    let txHash: String?
    let error: String?
    /// 人话细节（如「正在获取最新报价」），不含原始交易
    let detail: String?
    let ts: Double

    var isPending: Bool { ["validating", "submitting", "submitted"].contains(status) }
    var isLocked: Bool { isPending || status == "unknown" }
    /// 状态人话 + 颜色（持仓行副标题 / swap 卡状态行共用）：在途灰、成交绿、失败红、unknown 琥珀
    var statusLabel: (text: String, color: Color) {
        switch status {
        case "validating": ("校验中…", FM.muted)
        case "submitting": ("提交中…", FM.muted)
        case "submitted": ("已提交 · 等待确认", FM.muted)
        case "confirmed": ("已成交", FM.up)
        case "failed": ("失败", FM.down)
        default: ("结果未知", FM.amber)
        }
    }
}

struct TwitterRequest: Decodable, Equatable {
    enum Status: String, Decodable {
        case idle, loading, ready, empty, error, unsupported
        case waitingChain = "waiting_chain"
        case noLink = "no_link"
    }
    let status: Status
    let error: String?

    var message: String? {
        switch status {
        case .idle: "尚未请求"
        case .waitingChain: "等待识别代币链"
        case .noLink: "资料里没有推特链接"
        case .unsupported: "暂不支持此类 X 链接 · 可点「打开」查看"
        case .loading: "加载中…"
        case .ready: nil
        case .empty: "请求完成 · 暂无内容"
        case .error: "请求失败 · \(error ?? "未知错误")"
        }
    }
}

struct Token: Decodable, Identifiable, Equatable {
    var id: String { address }
    let address: String          // 小写
    let chainHint: String?
    let market: Market?
    let mentions: [Mention]
    /// 归一化 0..1 的折线点（≤48）；不足 2 点时是平线
    let spark: [Double]
    /// 有 ≥2 个真实采样点（K 线不是占位）
    let live: Bool
    let trend: Int
    /// 自首次喊单到现在的涨跌 %（跟单收益视角）
    let change: Double?
    let changeApprox: Bool
    let kol: Int
    let firstSeen: Double
    let links: Socials?
    let ath: Ath?
    /// 官方推特账号资料（gmgn 悬浮卡那种）
    let profile: TwitterUser?
    /// 官方推特内容（资料里 X 链接指向的推文 / 该账号本人的推文）
    let official: [Tweet]
    let twitterRequest: TwitterRequest
    /// 社区提到该代币的推文
    let tweets: [Tweet]
    /// fomo.family 代币页（sidecar 按链映射生成；null = 不显示按钮）
    let fomoURL: String?
    /// fomo.family 关注者动向（未登录 / 链不支持 → nil）
    let fomo: Fomo?
    /// 我在该币的持仓（本地 burner 钱包链上余额；没持有 / 未扫到 → nil）
    let position: TradePosition?
    /// true = 持仓区打开的、**不在监听列表里**的币（本地合成的占位 / sidecar `token_detail` 推来的完整详情）；监听列表里的 Token 省略
    let holdingOnly: Bool?

    // MARK: 纯展示派生

    var symbol: String { market?.symbol ?? shortAddr }
    var name: String { market?.name ?? address }
    var resolved: Bool { market?.symbol != nil }
    /// 链未知时为 nil（`chain` 显示 "?"）；sidecar 事件按 address + chain 路由，发出去的就是这个
    var knownChain: String? { market?.chain ?? chainHint }
    var chain: String { knownChain ?? "?" }
    var sender: String { mentions.first?.sender ?? "?" }
    var firstSeenDate: Date { Date(timeIntervalSince1970: firstSeen) }
    var sparkPoints: [CGFloat] { spark.map { CGFloat($0) } }
    var logoURL: URL? { market?.logo.flatMap(URL.init(string:)) }
    var fomoLink: URL? { fomoURL.flatMap(URL.init(string:)) }
    var shortAddr: String {
        guard address.count > 10 else { return address }
        return address.prefix(6) + "…" + address.suffix(4)
    }
}

extension Token {
    /// 持仓区打开的、不在监听列表里的币（见 `Feed.openHolding`）：本地占位和 sidecar `token_detail` 都带 `holdingOnly: true`
    var isHoldingOnly: Bool { holdingOnly == true }

    /// 持仓区打开一个**不在监听列表里**的币的占位：只有身份（symbol / 链 / logo / 现价）+ 我的持仓，喊单 / K 线 / 推特都空，等 sidecar `token_detail` 补全。
    /// `position` 让 `TradeCard` 的卖出（按持仓比例）和「持仓 N SYM · $X」行能用；fomoURL 为 nil（sidecar 才会生成）。`market.source == "holding"` 标记这是占位行情
    init(holding h: TradeHolding) {
        self.init(address: h.address, chainHint: h.chain,
                  market: Market(symbol: h.symbol, name: h.name, logo: h.logo, chain: h.chain, price: h.price, mc: nil, liq: nil,
                                 change5m: nil, change1h: nil, change24h: nil, holders: nil, source: "holding"),
                  mentions: [], spark: [], live: false, trend: 0, change: nil, changeApprox: false, kol: 0,
                  firstSeen: h.heldSince ?? 0, links: nil, ath: nil, profile: nil, official: [],
                  twitterRequest: TwitterRequest(status: .noLink, error: nil), tweets: [], fomoURL: nil, fomo: nil,
                  position: TradePosition(amount: h.amount, usd: h.usd), holdingOnly: true)
    }

    /// 我的持仓来自 `trade_holdings`，比任何 TokenView 里的都新：换掉顶层 `position`，其余（行情 / 喊单 / K 线语境 / 推特 / fomo 信号）原样保留。
    /// `identity`：缺行情时补身份；仍是持仓占位行情时更新现价，但不丢已经加载的社交资料。
    func with(position: TradePosition?, identity: Token? = nil, holdingOnly: Bool? = nil) -> Token {
        let resolvedMarket = market?.source == "holding" ? (identity?.market ?? market) : (market ?? identity?.market)
        return Token(address: address, chainHint: chainHint ?? identity?.chainHint, market: resolvedMarket, mentions: mentions, spark: spark,
                     live: live, trend: trend, change: change, changeApprox: changeApprox, kol: kol, firstSeen: firstSeen, links: links,
                     ath: ath, profile: profile, official: official, twitterRequest: twitterRequest, tweets: tweets, fomoURL: fomoURL, fomo: fomo,
                     position: position, holdingOnly: holdingOnly ?? self.holdingOnly)
    }
}

// MARK: - 格式化

enum Fmt {
    static func compact(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "—" }
        let a = abs(v)
        func f(_ x: Double, _ s: String) -> String {
            String(format: x >= 100 ? "%.0f" : (x >= 10 ? "%.1f" : "%.2f"), x) + s
        }
        if a >= 1e9 { return "$" + f(a / 1e9, "B") }
        if a >= 1e6 { return "$" + f(a / 1e6, "M") }
        if a >= 1e3 { return "$" + f(a / 1e3, "K") }
        return "$" + String(format: "%.0f", a)
    }
    /// 持仓金额（USD）：<$1000 两位小数，再大走 `compact`；`signed` 带 +/−，四舍五入到分后为 0 不带符号（不出现 -$0.00）；非有限 → 「—」
    static func usd(_ v: Double?, signed: Bool = false) -> String {
        guard let v, v.isFinite else { return "—" }
        let r = abs(v) < 1e3 ? (v * 100).rounded() / 100 : v
        let body = abs(r) >= 1e3 ? compact(abs(r)) : "$" + String(format: "%.2f", abs(r))
        guard signed, r != 0 else { return body }
        return (r > 0 ? "+" : "−") + body
    }
    /// 完整十进制字面（快捷额标签 / 输入框回填 / 状态行金额）：0.035 → "0.035"、200.0 → "200"；绝不走 `compact` 那种 K/M 缩写
    static func literal(_ v: Double) -> String {
        let s = String(v)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }
    /// 单枚价格（USD）：meme 币常见 0.00001234，≥1 两位小数，<1 保留 4 位有效数字；非有限正数 → 「—」
    static func price(_ v: Double?) -> String {
        guard let v, v.isFinite, v > 0 else { return "—" }
        if v >= 1000 { return "$" + String(format: "%.0f", v) }
        if v >= 1 { return "$" + String(format: "%.2f", v) }
        return "$" + String(format: "%.\(Int(ceil(-log10(v))) + 3)f", v)
    }
    /// 涨跌：<100 一位小数；<1000 整数；≥1000% 显示倍数（▲12.9x）——meme 币动辄几十倍，百分比没法读也放不下
    static func pct(_ v: Double?, approx: Bool = false) -> String {
        guard let v, v.isFinite else { return "—" }
        let a = abs(v), arrow = v >= 0 ? "▲" : "▼", pre = approx ? "≈" : ""
        if a < 100 { return pre + arrow + String(format: "%.1f", a) + "%" }
        if a < 1000 { return pre + arrow + String(format: "%.0f", a) + "%" }
        let x = 1 + v / 100
        return pre + arrow + (x < 100 ? String(format: "%.1fx", x) : String(format: "%.0fx", x))
    }
    static func ago(_ d: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(d)))
        if s < 60 { return "刚刚" }
        if s < 3600 { return "\(s / 60)分钟" }
        if s < 86400 { return "\(s / 3600)小时" }
        return "\(s / 86400)天"
    }
    /// 时:分（同一天的群聊上下文用）
    static func clock(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: d)
    }
    /// 行里用的紧凑形式：32秒 / 5分 / 2时 / 3天
    static func agoShort(_ d: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(d)))
        if s < 60 { return "\(s)秒" }
        if s < 3600 { return "\(s / 60)分" }
        if s < 86400 { return "\(s / 3600)时" }
        return "\(s / 86400)天"
    }
    /// 注册时间：2021年3月加入
    static func joined(_ ts: Double) -> String {
        let c = Calendar.current.dateComponents([.year, .month], from: Date(timeIntervalSince1970: ts))
        return "\(c.year ?? 0)年\(c.month ?? 0)月加入"
    }
    /// 粉丝数：1.2万 / 8.9K
    static func followers(_ n: Int) -> String {
        if n >= 10_000 { return String(format: "%.1f万粉", Double(n) / 10_000) }
        if n >= 1_000 { return String(format: "%.1fK粉", Double(n) / 1_000) }
        return "\(n)粉"
    }
}

extension Token {
    static func avatarColors(_ sender: String) -> [Color] {
        var h = 0
        for c in sender.unicodeScalars { h = h &* 31 &+ Int(c.value) }
        let palette: [[Color]] = [
            [Color(hex: 0x19f0a0), Color(hex: 0x0b8f63)],
            [Color(hex: 0x7e8dff), Color(hex: 0x4a5cff)],
            [Color(hex: 0xff9f45), Color(hex: 0xff6a3d)],
            [Color(hex: 0xff5673), Color(hex: 0xc93a54)],
            [Color(hex: 0x4fd1ff), Color(hex: 0x2b8fe0)],
            [Color(hex: 0xc792ff), Color(hex: 0x8b5cf6)],
        ]
        return palette[abs(h) % palette.count]
    }
}

// MARK: - Feed：面板状态（全部来自 sidecar 推送 + 本地 UI 交互）

enum LinkState: Equatable {
    case connecting, connected, reconnecting(String), failed(String)
    var label: String {
        switch self {
        case .connecting: return "连接中"
        case .connected: return "已连接"
        case .reconnecting: return "重连中"
        case .failed(let m): return "失败: \(m)"
        }
    }
}

@MainActor
@Observable
final class Feed {
    var tokens: [Token] = []
    var popup: Token? = nil
    var popupAuto = false             // true: 新代币自动弹出（6s 后自动关）；false: 点行查看 / 用户点过卡（钉住，不自动关）
    /// 主面板当前 frame（OverlayPanelController 拖动 / 改尺寸结束后更新）：弹卡按实际剩余空间重排
    var panelFrame: CGRect? = nil
    var freshID: String? = nil        // 顶部新卡高亮
    var link: LinkState = .connecting
    var gmgn: GmgnState = .idle
    var groupName = "…"               // `ready` 到达前的占位；之后是群名 / 「x 等 n 群」/ 「未监听群组」
    var now = Date()                  // 5s 一跳，驱动「x秒前」
    var dashboardURL: URL? = nil
    /// 主面板背景不透明度（sidecar 设置，默认 1 保持原外观）
    var panelBackgroundOpacity = 1.0
    /// 弹卡 K 线：当前 focus 代币（address + chain）各分辨率的缓存（画图时当前分辨率没覆盖到的区间回退用粗一档）
    var klines: [String: Kline] = [:]
    var klineKey: (address: String, chain: String)? = nil
    /// 弹卡「群内喊单」的语境：首次喊单前后的群聊原文（只在内存里，随弹卡切换替换，永不落盘）
    var context: CallContext? = nil
    /// 群 username → 显示名
    var groupNames: [String: String] = [:]
    /// fomo.family 登录态（sidecar `fomo_state`）
    var fomoState = FomoState()
    /// 群来源（微信 / 飞书）至少一个就绪（sidecar `sources`）；nil = 还没收到，别当成未配置去弹设置
    var sourcesConfigured: Bool? = nil
    /// 本地 burner 钱包 + OKX 的交易状态（sidecar `trade_state`；收到前 `.initial` = 不可交易）
    var tradeState = TradeState.initial
    /// 最近一份报价（一次性，输入原生币数量 / 点快捷额时问一次；弹卡换币/关闭时清掉）
    var tradeQuote: TradeQuote? = nil
    /// 每个地址（小写）最近一次下单的生命周期；**不随弹卡关闭/切换清空**，unknown 只能由 sidecar 对账后改终态
    var trades: [String: Trade] = [:]
    /// 快捷交易暂留的行：清仓 / 跌到 dust 后仍展示在途结果，终态反馈两秒后移除。
    var quickTradeHoldings: [String: TradeHolding] = [:]
    /// 我的当前持仓（sidecar `trade_holdings`，usd 降序；钱包未就绪为空）
    var tradeHoldings: [TradeHolding] = []
    /// 最近一份持仓快照的时间（nil = 还没收到过）
    var tradeHoldingsAt: Date? = nil
    /// 弹卡「fomo Thesis」列（sidecar 按 focus 推；地址不匹配当没有）
    var fomoThesis: FomoThesisFeed? = nil
    /// 弹卡「GMGN 喊单」列（sidecar 按 focus 推；地址不匹配当没有）
    var gmgnCalls: GmgnCalls? = nil

    /// 逻辑焦点以 pending 优先：新卡入场时，旧卡还可见，但旧响应不能覆盖新卡已经收到的数据。
    func focused(address: String, chain: String?) -> Bool {
        func hit(_ t: Token) -> Bool { t.address == address && (chain == nil || t.knownChain == nil || t.knownChain == chain) }
        return (pending?.token ?? popup).map(hit) == true
    }

    /// sidecar `kline`：只收当前弹卡那个币的（切币 / 同地址切链后旧请求晚到不能盖掉新图）
    func applyKline(_ k: Kline) {
        guard focused(address: k.address, chain: k.chain) else { return }
        if klineKey?.address != k.address || klineKey?.chain != k.chain { klines.removeAll(); klineKey = (k.address, k.chain) }
        klines[k.resolution] = k
    }

    func applyContext(_ c: CallContext) {
        context = c
        if pending?.token.address == c.address { commitPending() }
    }

    /// 实时成交推来的末端一根
    func applyBar(address: String, chain: String, resolution: String, bar: Bar) {
        guard let key = klineKey, key.address == address, key.chain == chain, let k = klines[resolution] else { return }
        klines[resolution] = k.merging(bar)
    }

    /// sidecar `token_detail`：持仓区打开的、不在监听列表里的币的完整详情（行情 / 喊单 / 推特 / fomo 动向）。
    /// 只认当前弹卡（含 pending）同 address + chain 且本来就是 holdingOnly 的卡；监听列表里的币走 `state`，这里不动 `tokens`。
    /// 我的持仓以最近一份 `trade_holdings` 为准（已卖光的卡不能被晚到的详情复活）；详情还没拉到行情时保留占位的身份
    func applyTokenDetail(_ t: Token) {
        func merge(_ cur: Token) -> Token? {
            guard cur.isHoldingOnly, cur.address == t.address, t.knownChain == nil || cur.chain == t.knownChain else { return nil }
            return t.with(position: cur.position, identity: cur, holdingOnly: true)
        }
        if let p = popup, let m = merge(p) { popup = m }
        if let q = pending, let m = merge(q.token) { pending = (m, q.auto) }
    }

    private var dismissTask: Task<Void, Never>?
    /// 等本次 focus 的语境推回来再亮卡（缓存命中 ≈1–3 帧）：首帧就是最终高度，语境区跟整卡一起入场；80ms 没等到就按现状（只列喊单记录）亮
    @ObservationIgnored private var pending: (token: Token, auto: Bool)? = nil
    @ObservationIgnored private var pendingTask: Task<Void, Never>? = nil
    /// 底部「gmgn」按钮：亮出内嵌浏览器窗口做验证/登录
    @ObservationIgnored var onOpenGmgn: (() -> Void)?
    /// 底部「设置」按钮：打开 dashboard（tab = 直达页签，如 "battle"；nil = 上次页 / 总览）
    @ObservationIgnored var onOpenDashboard: ((String?) -> Void)?
    /// 底部「收起」按钮：把悬浮面板收进状态栏（OverlayPanelController.setCollapsed）
    @ObservationIgnored var onCollapse: (() -> Void)?
    /// sidecar 报了群来源就绪状态（Sidecar `sources`）：(configured, firstRun)。OverlayPanelController 据此在首启或未配置时自动打开设置
    @ObservationIgnored var onSources: ((Bool, Bool) -> Void)?
    /// 弹卡开/关：sidecar 据此拉详情 / 订阅退订该代币的实时成交；(address, chain)，chain 未知为 nil；(nil, nil) = 关了
    @ObservationIgnored var onFocus: ((String?, String?) -> Void)?
    /// 点了 K 线上的喊单标记：来源群与毫秒级时刻共同确定那次喊单
    @ObservationIgnored var onContext: ((String, String, Double, String) -> Void)?
    /// 弹卡 K 线请求（按钮选的分辨率 + 可见范围）
    @ObservationIgnored var onKline: ((KlineRequest) -> Void)?
    /// 弹卡「swap」卡：要一份一次性报价 (address, chain, side "buy"|"sell", amount, pct)；amount = buy 的原生币数量（sell 传 0），pct = sell 按持仓比例（buy 为 nil）
    @ObservationIgnored var onTradeQuote: ((String, String, String, Double, Int?) -> Void)?
    /// 取消尚未回来的报价（address = null）
    @ObservationIgnored var onCancelTradeQuote: (() -> Void)?
    /// owner 点了执行：(address, chain, side, amount, pct, quoteId) 不可变意图；quoteId = 当前显示的那份 TradeQuote.id
    @ObservationIgnored var onTrade: ((String, String, String, Double, Int?, String) -> Void)?
    /// 持仓预设的一次明确点击：(id, address, chain, side, amount, pct)。报价和执行由 sidecar 同一路径完成，sidecar 同步先回 validating
    @ObservationIgnored var onQuickTrade: ((String, String, String, String, Double, Int?) -> Void)?
    /// 弹卡「fomo Thesis」列点了「加载更多」
    @ObservationIgnored var onThesisMore: ((String) -> Void)?
    /// 弹卡「GMGN 喊单」列点了「加载更多」
    @ObservationIgnored var onGmgnCallsMore: ((String) -> Void)?
    /// 调试：让 sidecar 模拟一条喊单
    @ObservationIgnored var onSimulate: (() -> Void)?
    /// 主面板「fomo 前排」兴趣集：sidecar 只为这些行（可见 + LazyVStack 预取）排队刷前排比例；全集替换、幂等，收起面板发 []，reconnect 后重放
    @ObservationIgnored var onFrontRankVisible: (([String]) -> Void)?
    @ObservationIgnored private var visibleRows = Set<String>()
    @ObservationIgnored private var visibleTask: Task<Void, Never>? = nil
    /// 面板收起时（窗口 orderOut 不触发 onDisappear，行仍挂着）把兴趣集当空发；恢复时重放
    @ObservationIgnored private var panelHidden = false

    init() {
        Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                self.now = Date()
            }
        }
    }

    /// 行进/出 LazyVStack：合并 300ms 再整集发（滚一屏会连发几十次进出）
    func rowVisible(_ address: String, _ on: Bool) {
        if on { guard visibleRows.insert(address).inserted else { return } }
        else { guard visibleRows.remove(address) != nil else { return } }
        visibleTask?.cancel()
        visibleTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            self.visibleTask = nil
            self.pushFrontRankVisible()
        }
    }

    /// OverlayPanelController.setCollapsed：收起 → 发 []；展开 → 重放当前集
    func setPanelHidden(_ hidden: Bool) {
        guard hidden != panelHidden else { return }
        panelHidden = hidden
        pushFrontRankVisible()
    }

    /// sidecar `ready`（首启 / 重启）后重放，新进程没有旧兴趣集
    func replayFrontRankVisible() { pushFrontRankVisible() }

    /// 按面板顺序（上面的先刷）
    private func pushFrontRankVisible() {
        visibleTask?.cancel(); visibleTask = nil
        let list = panelHidden ? [] : tokens.map(\.address).filter { visibleRows.contains($0) }
        onFrontRankVisible?(list)
    }

    /// sidecar 的全量快照
    func applyState(_ ts: [Token]) {
        tokens = ts
        // 地址 + 链都对上才跟（同一 0x 地址可能两条链都持有；持仓区合成的卡只跟同链的真 Token）。
        // 例外：卡打开时链还未知（新币自动弹卡，行情要 ~0.5s 后才到，chain 显示 "?"）——这时只按地址跟，
        // 否则行情到达后 chain 变成 bsc 永远对不上 "?"，卡就停在打开那一刻的空快照上。
        func follow(_ p: Token) -> Token? { ts.first { $0.address == p.address && (p.knownChain == nil || $0.chain == p.chain) } }
        if let p = popup, let t = follow(p) { popup = t }
        if let q = pending, let t = follow(q.token) { pending = (t, q.auto) }
        // 预热图片：logo / 官方账号头像 / 推文头像，弹卡打开时同步命中，和卡片一起入场
        var urls: [URL] = []
        for t in ts.prefix(40) {
            if let u = t.logoURL { urls.append(u) }
            if let a = t.profile?.avatar, let u = URL(string: a) { urls.append(u) }
            for tw in t.official.prefix(2) + t.tweets.prefix(3) { if let u = URL(string: tw.user.avatar) { urls.append(u) } }
        }
        ImageCache.shared.prefetch(urls)
    }

    /// 紧跟过滤后的 state：链上已确认不是 ERC20，只关闭该监听币的卡，不影响另一张 pending 卡或真实持仓详情。
    func tokenHidden(_ address: String) {
        guard !tokens.contains(where: { $0.address == address }) else { return } // 较新的行情已恢复时忽略旧通知
        if freshID == address { freshID = nil }
        if let q = pending {
            if q.token.address == address && !q.token.isHoldingOnly { dismissPopup() }
            else if let p = popup, p.address == address && !p.isHoldingOnly {
                popup = nil
                popupAuto = false
            }
        } else if let p = popup, p.address == address && !p.isHoldingOnly {
            dismissPopup()
        }
    }

    /// sidecar 说有新代币（紧跟在含它的 state 之后）：插顶动画由 tokens 变化驱动，这里只管高亮 + 弹卡。
    /// 用户正在看的卡（点行打开 / 点过的自动卡 / 入场中的手动卡）不被自动弹卡顶掉——只高亮新行。
    func newToken(_ address: String) {
        guard let t = tokens.first(where: { $0.address == address }) else { return }
        freshID = address
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.2))
            if self?.freshID == address { self?.freshID = nil }
        }
        guard !manualShowing else { return }
        present(t, auto: true)
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { self?.dismissPopup() }
        }
    }

    /// 手动卡（含入场中的）正在显示
    private var manualShowing: Bool {
        if let p = pending { return !p.auto }
        return popup != nil && !popupAuto
    }

    func openDetail(_ t: Token) { present(t, auto: false) }

    /// 持仓区的币身份：开详情弹卡；闪电按钮另走行内快捷交易，不改详情焦点。
    /// 监听列表里有这个币（地址 **和链** 都对上——同一 0x 地址可能在两条链上都持有）→ 开真 Token（有行情 / K 线 / 喊单）；
    /// 没有 → 用持仓行合成一个最小 Token（只有身份 + 持仓，其余空）
    func openHolding(_ h: TradeHolding) {
        if let t = tokens.first(where: { $0.address == h.address && $0.chain == h.chain }) { openDetail(t); return }
        openDetail(Token(holding: h))
    }

    /// 持仓行快捷额的一次点击：本地先落一条 validating 占位（地址级锁立即生效，防双击），再把意图交给 sidecar；
    /// 该地址已有未落定单 / 钱包未就绪 / 链路断开一律不发。占位单的 usd 只是估算：buy = amount × 原生币缓存价（没价 → 0），sell = 持仓估值 × pct
    func quickTrade(_ holding: TradeHolding, side: String, amount: Double, pct: Int?) {
        guard link == .connected, tradeState.ready,
              let send = onQuickTrade,
              let h = tradeHoldings.first(where: { $0.id == holding.id }),
              trades[h.address]?.isLocked != true else { return }
        let id = UUID().uuidString
        let estimate = side == "sell" ? (h.usd ?? 0) * Double(pct ?? 0) / 100 : amount * (tradeState.balances[h.chain]?.price ?? 0)
        quickTradeHoldings[h.id] = h
        trades[h.address] = Trade(id: id, address: h.address, chain: h.chain, side: side, usd: estimate, pct: pct,
                                  status: "validating", txHash: nil, error: nil, detail: "正在获取最新报价", ts: Date().timeIntervalSince1970)
        send(id, h.address, h.chain, side, side == "sell" ? 0 : amount, pct)
    }

    func applyTrade(_ trade: Trade) {
        trades[trade.address] = trade
        // 服务端用地址级锁拒绝另一条链的意图时，会回放实际在途单；撤掉被拒那行的暂留副本。
        for (key, h) in quickTradeHoldings where h.address == trade.address && h.chain != trade.chain {
            quickTradeHoldings.removeValue(forKey: key)
        }
        guard !trade.isLocked else { return }
        let key = trade.chain + ":" + trade.address
        guard quickTradeHoldings[key] != nil else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, self.trades[trade.address]?.id == trade.id,
                  self.trades[trade.address]?.isLocked == false else { return }
            self.quickTradeHoldings.removeValue(forKey: key)
        }
    }

    /// 没写入 pipe 可以明确失败；写入中断 / sidecar 退出则结果未知，绝不凭超时解除交易锁。
    func quickTradeDeliveryFailed(id: String, uncertain: Bool) {
        guard let trade = trades.values.first(where: { $0.id == id }), trade.isPending else { return }
        applyTrade(Trade(id: trade.id, address: trade.address, chain: trade.chain, side: trade.side, usd: trade.usd, pct: trade.pct,
                         status: uncertain ? "unknown" : "failed", txHash: trade.txHash,
                         error: uncertain ? "连接中断，结果未知" : "未连接 sidecar，未发送交易",
                         detail: uncertain ? "sidecar 重连后对账；不会自动重试" : nil,
                         ts: Date().timeIntervalSince1970))
    }

    func quickTradesDisconnected() {
        for h in quickTradeHoldings.values {
            if let trade = trades[h.address], trade.chain == h.chain, trade.isPending {
                quickTradeDeliveryFailed(id: trade.id, uncertain: true)
            }
        }
    }

    /// sidecar `trade_holdings`：替换持仓列表；弹卡若是持仓区打开的、不在监听列表里的币（`Token.isHoldingOnly`），随快照刷新它的持仓
    /// （卖掉一部分后 swap 卡的「持仓 N SYM」/ 按比例卖要跟着变；整行没了 → 持仓归零）。
    /// 只换顶层 `position`：`token_detail` 已经补进来的行情 / 喊单 / 推特不能被每次持仓快照打回占位。
    /// 还没拿到详情的占位（market 只是持仓行拼的 `source == "holding"`）连现价也一起跟着持仓行刷
    func applyHoldings(_ hs: [TradeHolding], at: Date) {
        tradeHoldings = hs
        tradeHoldingsAt = at
        func refreshed(_ p: Token) -> Token? {
            guard p.isHoldingOnly else { return nil }
            if let h = hs.first(where: { $0.address == p.address && $0.chain == p.chain }) {
                return p.with(position: TradePosition(amount: h.amount, usd: h.usd), identity: Token(holding: h))
            }
            if let pos = p.position, pos.amount != 0 { return p.with(position: TradePosition(amount: 0, usd: 0)) }
            return nil
        }
        if let p = popup, let t = refreshed(p) { popup = t }
        // 还在入场（80ms 等语境）的卡也刷，免得 commit 时把旧持仓亮出来
        if let q = pending, let t = refreshed(q.token) { pending = (t, q.auto) }
    }

    /// 用户在弹卡里按下了鼠标（任何位置、任何键）：这张卡转成手动——取消 6s 自动关，之后的新币也不再顶掉它。
    /// 正在显示 A、而新币 B 的自动卡还在入场中（pending）：钉住的是用户看见的 A —— 取消 B 的 pending，focus 也退回 A
    /// （present 已经把 focus 发给了 B）。只有 pending 的卡（还没亮）：把它的 auto 改掉，80ms 兜底 / 语境到达的 commit 不能再改回自动。
    func pinPopup() {
        dismissTask?.cancel(); dismissTask = nil
        if let p = popup {
            popupAuto = false
            if let q = pending, q.token.address != p.address || q.token.chain != p.chain {
                pendingTask?.cancel(); pendingTask = nil
                pending = nil
                focus(p)
            } else if pending != nil { pending = (p, false) }
        } else if let q = pending, q.auto {
            pending = (q.token, false)
        }
    }

    /// 告诉 sidecar 现在看的是哪个币（address + chain）。上一个币的 K 线缓存不在这里清：`applyKline` 只认当前焦点，画图时也按 address + chain 过滤
    private func focus(_ t: Token) { onFocus?(t.address, t.knownChain) }

    func dismissPopup() {
        dismissTask?.cancel()
        pendingTask?.cancel(); pendingTask = nil
        pending = nil
        popup = nil
        tradeQuote = nil
        onFocus?(nil, nil)
    }

    private func present(_ t: Token, auto: Bool) {
        dismissTask?.cancel()
        pendingTask?.cancel()
        pending = (t, auto)
        // 换币 **或换链**（同一 0x 地址两条链都持有）都作废旧报价；卡本身也只认 address+chain+side 都对上的报价
        if tradeQuote?.address != t.address || tradeQuote?.chain != t.chain { tradeQuote = nil }
        focus(t)
        // sidecar 没连上就不会有语境推回来，不必白等
        if link != .connected { commitPending(); return }
        pendingTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard let self, !Task.isCancelled, self.pending?.token.address == t.address else { return }
            self.commitPending()
        }
    }

    private func commitPending() {
        pendingTask?.cancel(); pendingTask = nil
        guard let p = pending else { return }
        pending = nil
        popup = p.token
        popupAuto = p.auto
    }
}
