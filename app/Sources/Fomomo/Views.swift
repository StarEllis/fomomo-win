import SwiftUI
import AppKit

// MARK: - 折线 K线

struct KLineShape: Shape {
    var points: [CGFloat]
    var closed: Bool = false
    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard points.count > 1 else { return p }
        func pt(_ i: Int) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * CGFloat(i) / CGFloat(points.count - 1),
                    y: rect.maxY - rect.height * points[i])
        }
        p.move(to: pt(0))
        for i in 1..<points.count { p.addLine(to: pt(i)) }
        if closed {
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            p.closeSubpath()
        }
        return p
    }
}

struct KLineView: View {
    let points: [CGFloat]
    let up: Bool
    var live: Bool = true       // 没有历史价时画成弱灰平线
    var body: some View {
        let col = live ? (up ? FM.up : FM.down) : FM.faint
        ZStack {
            if live {
                KLineShape(points: points, closed: true)
                    .fill(LinearGradient(colors: [col.opacity(0.26), col.opacity(0)], startPoint: .top, endPoint: .bottom))
            }
            KLineShape(points: points)
                .stroke(col, style: StrokeStyle(lineWidth: live ? 1.6 : 1, lineCap: .round, lineJoin: .round, dash: live ? [] : [2, 3]))
        }
    }
}

// MARK: - 小组件

struct Hairline: View {
    var body: some View { Rectangle().fill(FM.hair2).frame(height: 1) }
}

struct ChainBadge: View {
    let chain: String
    var body: some View {
        let c: Color = switch chain {
        case "bsc": FM.amber
        case "eth": Color(hex: 0x7e8dff)
        case "base": Color(hex: 0x3b82f6)
        case "sol": Color(hex: 0xc792ff)
        case "robinhood": Color(hex: 0x9fc700)
        case "?": FM.faint
        default: FM.muted
        }
        // 长链名缩写：ROBINHOOD 全拼 ~72px，会把 326 宽面板里的 symbol 挤到只剩省略号
        Text(chain == "robinhood" ? "RH" : chain.uppercased())
            .font(.system(size: 8.5, weight: .bold)).tracking(0.3)
            .foregroundStyle(c)
            .padding(.horizontal, 5).padding(.vertical, 1.5)
            .background(c.opacity(0.13), in: RoundedRectangle(cornerRadius: 5))
            .fixedSize()
    }
}

struct TokenLogo: View {
    let symbol: String
    var logo: URL? = nil
    var size: CGFloat = 30
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        ZStack {
            // 首字母底：没图 / 加载中 / 加载失败都靠它兜底
            shape.fill(FM.logoGradient(symbol))
            Text(String(symbol.prefix(1)).uppercased()).font(.system(size: size * 0.43, weight: .bold)).foregroundStyle(FM.logoInk)
            if let logo { CachedImage(url: logo) { EmptyView() } }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(.white.opacity(0.08)))
    }
}

struct Equalizer: View {
    @State private var on = false
    private let h: [CGFloat] = [0.55, 1.0, 0.42, 0.78]
    var body: some View {
        HStack(alignment: .bottom, spacing: 2.5) {
            ForEach(0..<4, id: \.self) { i in
                Capsule().fill(FM.accent)
                    .frame(width: 2.5, height: 14 * h[i])
                    .scaleEffect(y: on ? 1 : 0.3, anchor: .bottom)
                    .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true).delay(Double(i) * 0.12), value: on)
            }
        }
        .frame(height: 14)
        .onAppear { on = true }
    }
}

/// 数字文本：等宽 + tabular，未解析时用 shortAddr 也能对齐
private extension View {
    func numeric(_ size: CGFloat) -> some View { font(.system(size: size, design: .monospaced)).monospacedDigit() }
}

/// 可点元素统一的 hover 反馈：手型光标 + 轻微提亮（白 6%，克制，不加绿光）。弹卡按钮、主面板行/页脚都走这一个。
/// 光标能在后台 app 里生效靠 OverlayPanel 里的 SetsCursorInBackground，见那边注释。
/// 进出要计数：从主面板一行滑到弹卡按钮时，两个窗口各自报 hover，SwiftUI 可能先报「进按钮」再报「出行」，
/// 若「出」无脑设箭头就会盖掉刚设好的手型；只有最后一个离开才还原箭头。
private struct Clickable: ViewModifier {
    let radius: CGFloat
    @State private var hover = false
    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .overlay(RoundedRectangle(cornerRadius: radius).fill(Color.white.opacity(hover ? 0.06 : 0)).allowsHitTesting(false))
            .onHover { on in
                guard on != hover else { return }
                hover = on
                on ? HandCursor.enter() : HandCursor.leave()
            }
            .onDisappear { if hover { hover = false; HandCursor.leave() } }
    }
}

@MainActor private enum HandCursor {
    private static var hovered = 0
    static func enter() { hovered += 1; NSCursor.pointingHand.set() }
    static func leave() { hovered = max(0, hovered - 1); if hovered == 0 { NSCursor.arrow.set() } }
}
extension View {
    func clickable(radius: CGFloat = 6) -> some View { modifier(Clickable(radius: radius)) }
}

enum Links {
    // 链未知时按群里最常见的链猜（页面打开后 gmgn 自己会提示换链）
    static func gmgn(_ t: Token) -> URL? { URL(string: "https://gmgn.ai/\(t.chain == "?" ? "robinhood" : t.chain)/token/\(t.address)") }
    static func dex(_ t: Token) -> URL? { URL(string: "https://dexscreener.com/search?q=\(t.address)") }
    static func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }
}

// MARK: - 紧凑行

struct TokenRowView: View {
    let t: Token
    let fresh: Bool
    let now: Date
    let onTap: () -> Void
    /// 行进出 LazyVStack 的可见/预取区（Feed 汇总成主面板「fomo 前排」兴趣集告诉 sidecar）
    var onVisible: (Bool) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 9) {
            TokenLogo(symbol: t.symbol, logo: t.logoURL)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if t.resolved {
                        Text(t.symbol).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    } else {
                        Text(t.shortAddr).numeric(12).foregroundStyle(FM.muted).lineLimit(1)
                    }
                    ChainBadge(chain: t.chain)
                }
                HStack(spacing: 7) {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2.fill").font(.system(size: 8))
                        Text("\(t.kol)")
                    }.foregroundStyle(FM.accent)
                    // fomo 前排比例（fomo 全站前 50 ÷ gmgn 前排前 50）：不用开弹卡就能看；未登录 fomo / 链不支持时整段不显示
                    if let f = t.fomo {
                        HStack(spacing: 3) {
                            Image(systemName: "chart.pie.fill").font(.system(size: 8))
                            Text(FomoFrontRank.text(f.frontRank))
                        }
                        .foregroundStyle(FM.frontRankColor(f.frontRank?.ratio))
                        .help("fomo 前排 " + FomoFrontRank.text(f.frontRank) + "\n" + FomoFrontRank.help(f.frontRank))
                        .accessibilityLabel("fomo 前排 " + FomoFrontRank.text(f.frontRank))
                    }
                }.numeric(10.5).lineLimit(1).fixedSize()
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
            KLineView(points: t.sparkPoints, up: t.trend > 0, live: t.live).frame(width: 54, height: 26)
            VStack(alignment: .trailing, spacing: 1) {
                Text(Fmt.compact(t.market?.mc)).numeric(12.5)
                Text(Fmt.pct(t.change, approx: t.changeApprox))
                    .numeric(10)
                    .foregroundStyle(t.change == nil ? FM.faint : ((t.change ?? 0) >= 0 ? FM.up : FM.down))
                // 首次喊单距今，5s 一跳
                Text(Fmt.agoShort(t.firstSeenDate, now: now) + "前喊").numeric(9).foregroundStyle(FM.faint)
            }.frame(width: 64, alignment: .trailing)
        }
        .foregroundStyle(FM.ink)
        .padding(8)
        .background(fresh ? FM.accent.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(fresh ? FM.accent.opacity(0.4) : .clear))
        .clickable(radius: 12)
        .onTapGesture(perform: onTap)
        .onAppear { onVisible(true) }
        .onDisappear { onVisible(false) }
    }
}

/// 主面板底部「持仓」区的一行：身份（logo / symbol / 链）· 持有时长 · 现值 · 盈亏 % · 右侧 ⚡ 展开**行内一键交易**。
/// 点身份 / 行空白仍旧打开弹卡详情；⚡ 只切换本行下方的「买 / 卖」两排快捷额，**不**开卡。快捷额点一下 = 直接下单（无二次确认），
/// 由 `onQuickTrade` 显式发出，绝不 onChange / task 自动触发；展开本身不拉报价。
/// 下单状态按 **地址+链** 匹配的那单显示在副标题位（替换「持有 …」）：在途带进度条，unknown 持续警示，不按时间解锁；
/// 终态（confirmed / failed）按事件 ts 展示 ~2s 后隐去。同地址任何链有未落定单 → 所有快捷额锁住（跟 Feed.trades 的地址键一致，保守）。
/// 时长 / 盈亏拿不到就显示「—」——这两个数只认本地交易账本（`TradeHolding`），不本地推算
struct HoldingRowView: View {
    static let height: CGFloat = 36
    /// 展开后多出的高度（两排快捷额 26 + 间距 + 上下 padding）；PanelView 算持仓区高度用
    static let expandedExtra: CGFloat = 68
    let h: TradeHolding
    let now: Date
    let state: TradeState
    /// sidecar 链路在线（断开时不能发意图，快捷额禁用并说明）
    let linkConnected: Bool
    /// 该**地址**最近一次下单（Feed.trades[address]，跨链共用一把锁）；状态只显示 chain 对得上的那单
    let trade: Trade?
    let expanded: Bool
    /// ⚡ 点击：切换本行展开
    let onToggle: () -> Void
    /// 身份 / 行空白点击：打开弹卡详情
    let onOpen: () -> Void
    /// (side "buy"|"sell", amount = 买入原生币数量（sell 传 0）, sellPct) → Feed.quickTrade；**只**由快捷额按钮点击调用
    let onQuickTrade: (String, Double, Int?) -> Void
    /// 已经展示够 2s 的终态单（id|status）：隐去副标题里的状态，回到「持有 …」
    @State private var terminalShown: String?

    /// 持有时长（秒 / 分 / 时 / 天，`Fmt.agoShort`）；账本里没有这个币的 confirmed 买入（转入 / 账本之外的仓位）时为 nil → 「—」
    private var held: String { h.heldSince.map { "持有 " + Fmt.agoShort(Date(timeIntervalSince1970: $0), now: now) } ?? "持有 —" }
    /// 盈亏一律百分数（用户要的是 %；不像代币列表那样 ≥1000% 换成倍数）
    private var pnl: String {
        guard let v = h.pnlPct, v.isFinite else { return "—" }
        return (v >= 0 ? "▲" : "▼") + String(format: abs(v) < 100 ? "%.1f%%" : "%.0f%%", abs(v))
    }
    private var value: String {
        guard let u = h.usd, u.isFinite else { return "—" }
        return u >= 1000 ? Fmt.compact(u) : String(format: u >= 100 ? "$%.0f" : "$%.2f", u)
    }
    private var pnlColor: Color { h.pnlPct == nil ? FM.faint : ((h.pnlPct ?? 0) >= 0 ? FM.up : FM.down) }

    /// 链也对得上的那单才在本行显示状态
    private var ownTrade: Trade? { trade.flatMap { $0.chain == h.chain ? $0 : nil } }
    private static func key(_ t: Trade) -> String { t.id + "|" + t.status }
    /// 副标题位要显示的单：未落定一直显示；终态只在事件 ts 后 ~2s 内显示（`terminalShown` 由 task 到点写入；`now` 粗筛掉重启后读回的旧记录，免得闪一帧）
    private var statusTrade: Trade? {
        guard let t = ownTrade else { return nil }
        if t.isLocked { return t }
        guard terminalShown != Self.key(t), t.ts > now.timeIntervalSince1970 - 10 else { return nil }
        return t
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if expanded { controls }
        }
        .foregroundStyle(FM.ink)
        .background(expanded ? FM.surface : .clear, in: RoundedRectangle(cornerRadius: 10))
        // 终态单展示满 2s（按事件 ts 算，不按收到时刻）后隐去；未落定的不设时
        .task(id: ownTrade.map(Self.key)) {
            guard let t = ownTrade, !t.isLocked else { return }
            let remain = t.ts + 2 - Date().timeIntervalSince1970
            if remain > 0 { try? await Task.sleep(for: .seconds(remain)) }
            guard !Task.isCancelled else { return }
            terminalShown = Self.key(t)
        }
    }

    /// 收起态整行：身份（可截断）· 现值 / 盈亏 · ⚡。右侧两块 `fixedSize` + 高优先级，长 symbol 只能自己截断，挤不动尾部控件
    private var header: some View {
        HStack(spacing: 8) {
            TokenLogo(symbol: h.symbol, logo: h.logoURL, size: 22)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(h.symbol).font(.system(size: 12.5, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                    ChainBadge(chain: h.chain)
                }
                subtitle
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                Text(value).numeric(12)
                Text(pnl).numeric(10).foregroundStyle(pnlColor)
            }
            .lineLimit(1).fixedSize().layoutPriority(1)
            bolt.layoutPriority(1)
        }
        .padding(.horizontal, 8)
        .frame(height: Self.height)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .help(h.heldSince == nil || h.pnlPct == nil ? "时长 / 盈亏为「—」：本地账本里没有这个币的 confirmed 买入（转入 / 旧持仓），或现价缺失" : "")
    }

    /// 副标题：有要显示的单 → 进度条 + 「买入 $50 · 校验中…」（终态按结果着色）；否则「持有 …」
    @ViewBuilder private var subtitle: some View {
        if let t = statusTrade {
            let (label, color) = t.statusLabel
            let amount = t.side == "sell" ? (t.pct.map { "\($0)%" } ?? "$" + Fmt.literal(t.usd)) : "$" + Fmt.literal(t.usd)
            let note = t.error ?? t.detail
            HStack(spacing: 4) {
                if t.isPending { ProgressView().controlSize(.mini).scaleEffect(0.7).frame(width: 10, height: 10) }
                Text("\(t.side == "buy" ? "买入" : "卖出") \(amount) · \(label)").numeric(9.5).fontWeight(.semibold).foregroundStyle(color).lineLimit(1)
            }
            .help(note ?? (t.status == "unknown" ? "结果未知：等 sidecar 对账后才会更新，可在 dashboard 交易页核对" : ""))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(h.symbol) \(t.side == "buy" ? "买入" : "卖出") \(amount) \(label)")
        } else {
            Text(held).numeric(9.5).foregroundStyle(FM.faint).lineLimit(1)
        }
    }

    /// 右侧 ⚡ 方块：收起 = 绿底绿字；展开 = 实心绿底深字 + ✕。只切换展开，不开卡（事件在这里吃掉，不冒泡到行的 onTapGesture）
    private var bolt: some View {
        Button(action: onToggle) {
            Image(systemName: expanded ? "xmark" : "bolt.fill")
                .font(.system(size: expanded ? 10 : 11, weight: .bold))
                .foregroundStyle(expanded ? FM.logoInk : FM.accent)
                .frame(width: 24, height: 24)
                .background(expanded ? FM.accent : FM.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable(radius: 7)
        .fixedSize()
        .help(expanded ? "收起快捷交易" : "快捷交易 \(h.symbol)：展开买 / 卖快捷额，点一下直接下单（本地 burner 钱包签名，经 OKX 路由，无二次确认）")
        .accessibilityLabel(expanded ? "收起 \(h.symbol) 快捷交易" : "展开 \(h.symbol) 快捷交易")
    }

    /// 展开区：「买」绿 / 「卖」红 两排，每排一列等宽快捷额（来自设置 `presets`，sidecar `trade_state` 下发；买 = 该链原生币数量，瓦片只显数字（用户 2026-09-11：「直接显示数字就行了」），符号进 tooltip；卖 `N%`）。
    /// 空白处点击吃掉，不开卡、不触发父级手势
    private var controls: some View {
        return VStack(spacing: 4) {
            presetRow("买", tint: FM.accent, side: "buy", items: state.buyPresets(chain: h.chain).map { (Fmt.literal($0), $0, nil) })
            presetRow("卖", tint: FM.down, side: "sell", items: state.presets.sell.map { ("\($0)%", 0, $0) })
        }
        .padding(.horizontal, 8).padding(.top, 2).padding(.bottom, 6)
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    /// 一排：左侧固定宽方向字 + 等宽瓦片。280 最小宽：内容宽 280 − 面板 6×2 − 行 8×2 = 252，扣掉 18 字宽 + 6 + 3×4 间距 → 每块 ≥ 54pt，装得下 `100%` / `10000`
    private func presetRow(_ label: String, tint: Color, side: String, items: [(String, Double, Int?)]) -> some View {
        HStack(spacing: 6) {
            Text(label).font(.system(size: 11, weight: .bold)).foregroundStyle(tint).frame(width: 18, alignment: .leading)
            if items.isEmpty {
                Text("—").font(.system(size: 10.5)).foregroundStyle(FM.faint).frame(maxWidth: .infinity, minHeight: 26, alignment: .leading)
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    preset(it.0, tint: tint, side: side, amount: it.1, pct: it.2)
                }
            }
        }
    }

    /// 单个快捷额瓦片：可用 → 深色半透明底、白字，hover 提亮；不可用 → 灰字、tooltip 给原因。点击 = 直接下单意图
    private func preset(_ label: String, tint: Color, side: String, amount: Double, pct: Int?) -> some View {
        let reason = disabledReason(side: side, amount: amount, pct: pct)
        let what = side == "buy" ? "用 \(label) \(state.nativeSymbol(chain: h.chain) ?? "") 买入 \(h.symbol)" : "卖出 \(label) \(h.symbol)"
        return Button { onQuickTrade(side, amount, pct) } label: {
            Text(label).font(.system(size: 10.5, weight: .bold, design: .monospaced)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.8)
                .foregroundStyle(reason == nil ? FM.ink : FM.faint)
                .frame(maxWidth: .infinity, minHeight: 26)
                .background(FM.surface2, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(reason == nil ? tint.opacity(0.35) : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable(radius: 8)
        .disabled(reason != nil)
        .help(reason.map { "\(what)：\($0)" } ?? "\(what) · 点一下直接下单（本地 burner 钱包签名，经 OKX 路由，无二次确认）")
        .accessibilityLabel(what)
        .accessibilityHint(reason ?? "点击直接下单")
    }

    /// 本地就能判的不可用原因（nil = 可点）。顺序：钱包就绪 → 链路 → 该链原生币（买入付款 / 卖出付 gas）→ 锁 → 数量与限额（买入走 `TradeState.buyReason`：余额按原生币数量，USD 限额只在有价时判）。最终可执行性仍由 sidecar 报价校验
    private func disabledReason(side: String, amount: Double, pct: Int?) -> String? {
        if !state.ready { return state.reason ?? "交易未就绪" }
        if !linkConnected { return "sidecar 未连接" }
        guard let bal = state.balances[h.chain] else { return "该链余额未知" }
        if bal.native <= 0 { return "\(bal.symbol) 余额为 0" }
        // 同地址任何链上有未落定单（validating / submitting / submitted / unknown）→ 锁快捷额；没有定时器解锁
        if trade?.isLocked ?? false { return "该币有未落定的单" }
        if side == "buy" {
            if amount <= 0 { return "数量无效" }
            return state.buyReason(chain: h.chain, amount: amount)
        }
        guard h.amount > 0 else { return "无持仓" }
        guard let pct, pct > 0 else { return "比例无效" }
        if let v = h.usd, v.isFinite {
            let est = v * Double(pct) / 100
            if est < TradeState.minUsd { return "低于最低 \(Fmt.usd(TradeState.minUsd))" }
            if est > state.limits.perTrade { return "超单笔上限 \(Fmt.usd(state.limits.perTrade))" }
        }
        return nil
    }
}

// MARK: - 弹出详情卡

struct PopupCard: View {
    let t: Token
    let auto: Bool
    let now: Date
    let klines: [String: Kline]
    /// 首次喊单前后的群聊原文（sidecar 按弹卡 focus 推来；地址不匹配就当没有）
    let context: CallContext?
    let groups: [String: String]
    /// fomo 登录态（关注者区 / Thesis 列据此显示未登录提示；交易卡不看它）
    let fomoState: FomoState
    /// 本地 burner 钱包 + OKX 的交易状态（sidecar `trade_state`）
    let tradeState: TradeState
    /// sidecar 最近一次报价（地址/方向/金额对不上当前卡就当没有）
    let tradeQuote: TradeQuote?
    /// (address, chain, side, amount, sellPct) → sidecar 拉一次性报价
    let onTradeQuote: (String, String, String, Double, Int?) -> Void
    let onCancelTradeQuote: () -> Void
    /// 该币最近一次下单状态（Feed.trades[address]）
    let trade: Trade?
    /// (address, chain, side, amount, sellPct, quoteId) → sidecar 下单
    let onTrade: (String, String, String, Double, Int?, String) -> Void
    /// 我在这个币（address + 链精确匹配）的当前持仓（`Feed.tradeHoldings` 全量，不过滤碎屑；没持仓为 nil）→ 卡头持仓区 + K 线上画买 / 卖均价线
    let holding: TradeHolding?
    /// 「GMGN 喊单」列（sidecar `gmgn_calls`；地址不匹配就当没有 = 加载中）
    let gmgnCalls: GmgnCalls?
    /// 「fomo Thesis」列（sidecar `fomo_thesis`）
    let thesis: FomoThesisFeed?
    let onGmgnCallsMore: (String) -> Void
    let onThesisMore: (String) -> Void
    let onKline: (KlineRequest) -> Void
    let onContext: (String, String, Double, String) -> Void
    let onClose: () -> Void
    @State private var copied = false
    /// GMGN 喊单列的页签：原生 GMGN喊单（默认）/ X喊单
    @State private var gmgnTab: GmgnTab = .gmgn
    /// 展开了全文的条目（GMGN 喊单 ulid / Thesis id）
    @State private var expanded: Set<String> = []
    /// X喊单 已显示条数（服务端一次给 100 条，本地分批展开）
    @State private var xShown = 20
    enum GmgnTab { case gmgn, x }
    let layout: Layout
    /// 左列无约束测出的自然高度（0 = 还没量）；> `layout.maxHeight` 才整列滚动
    @State private var leftHeight: CGFloat = 0
    /// K 线分辨率（gmgn 同款一排按钮），记住上次选的
    @AppStorage("chartResolution") private var resolution = "1m"

    /// 右列信息栏（swap 卡 → 𝕏 官方推特 → fomo 关注者）固定宽；新增的 GMGN 喊单 / fomo Thesis 两列也各用这个宽
    static let sidebarWidth: CGFloat = 300
    static let extraColumns: CGFloat = 2

    /// 弹卡尺寸契约：一切都从**实际可用空间**（主面板右缘 + 10 间隙 + 弹窗留白之后到屏幕右缘；弹卡顶到屏幕底减留白）推出来，不是猜屏宽。
    /// - `chart`：左列宽 = 屏宽 30%（目标 ≥600），但**不超过**可用宽减一个右栏；K 线高 = 屏高 30%（≥220），窄矮屏再按可用高收。
    /// - `wide`：可用宽放得下 左列 + 3×301 → GMGN 喊单 / fomo Thesis 并排在 swap 栏右边、与左列同高；否则叠在「群内喊单」下面一排（`stackedHeight` 160…320）。
    /// - `maxHeight`：整卡高度上限 = 可用高；左列内容（含叠放的两列）超过就整体在卡内滚动（`ViewThatFits`），右栏 overlay 跟左列同高、各自滚动，旧内容不裁。
    struct Layout: Equatable {
        let wide: Bool
        let chart: CGSize
        let stackedHeight: CGFloat
        let maxHeight: CGFloat
        /// 弹卡总宽 = 左列 + 右侧各栏（每栏 1pt 分隔线 + 300）
        var width: CGFloat { chart.width + (PopupCard.sidebarWidth + 1) * (wide ? 1 + PopupCard.extraColumns : 1) }
        var rightWidth: CGFloat { width - chart.width }

        /// `available` = 弹卡内容可用的宽高；`screen` = 所在屏幕可见区尺寸（30% 比例的基数）
        init(available: CGSize, screen: CGSize) {
            let col = PopupCard.sidebarWidth + 1
            let chartW = min(max(600, (screen.width * 0.3).rounded()), max(360, available.width - col))
            wide = available.width >= chartW + col * (1 + PopupCard.extraColumns)
            // 主行估算（只用于给叠放行分高度）：头部 ~130 + K 线区（图 + 一排分辨率按钮 + 边距）+ 群内喊单 ≤8 行 ~215
            var chartH = max(220, (screen.height * 0.3).rounded())
            if !wide { chartH = max(220, min(chartH, available.height - 130 - 20 - 215 - 160)) }
            chart = CGSize(width: chartW, height: chartH)
            stackedHeight = min(320, max(160, available.height - (130 + chartH + 20 + 215) - 1))
            maxHeight = max(320, available.height)
        }
    }
    /// 生产布局：主面板真实 frame（没有就按默认 326 宽贴左缘、顶部离菜单栏 22）+ `PopupHost` 留白
    static var layout: Layout { layout(panel: NSApp?.windows.first { $0 is OverlayPanelController.EdgeLockedPanel }?.frame) }
    /// 按给定的主面板 frame 算（`PopupHost` 用 `Feed.panelFrame`，面板拖动 / 改尺寸后能跟着重排）
    static func layout(panel: NSRect?) -> Layout {
        let vf = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let panelRight = panel?.maxX ?? (vf.minX + 326)
        let cardTop = (panel?.maxY ?? (vf.maxY - 22)) - 50
        return Layout(available: CGSize(width: vf.maxX - (panelRight + 10) - PopupHost.padX * 2, height: cardTop - vf.minY - PopupHost.padTop - PopupHost.padBottom),
                      screen: vf.size)
    }
    /// 资料里的 X 链接指向某条推文时，官方内容第一条就是它；指向账号则显示资料卡
    private static func linkedTweet(_ t: Token) -> Tweet? { t.links?.twitter?.contains("/status/") == true ? t.official.first : nil }

    /// 左 = 代币信息 → K 线 → 群内喊单 [→ 窄屏时 GMGN 喊单 | fomo Thesis 一排]（决定高度，超过 `maxHeight` 整列滚动）；
    /// 右 = 固定 300 宽信息栏（宽屏时再加两栏），作为左列的 overlay 拿到同样的高度，内容多就在栏内滚动、不撑高弹卡
    var body: some View {
        // 自然高度 vs 滚动只看 `layout.maxHeight` 和左列自己量出来的高度，**不看窗口给的 proposal**：弹卡窗口是先按内容尺寸再长大的，
        // 用 ViewThatFits 会被初始 480 高的窗口钉死在 400（真机回归）。左列内容始终无约束测量（ScrollView 里也是），超过上限才套 ScrollView
        Group {
            if leftHeight > layout.maxHeight {
                ScrollView(.vertical, showsIndicators: false) { leftColumn.measured(LeftHeightKey.self) }.frame(height: layout.maxHeight)
            } else {
                leftColumn.measured(LeftHeightKey.self)
            }
        }
        .onPreferenceChange(LeftHeightKey.self) { h in if h > 0 { leftHeight = h } }
        .frame(width: layout.chart.width)
        .padding(.trailing, layout.rightWidth)
        .overlay(alignment: .trailing) {
            HStack(spacing: 0) {
                Rectangle().fill(FM.hair2).frame(width: 1)
                sidebar.frame(width: Self.sidebarWidth)
                if layout.wide {
                    Rectangle().fill(FM.hair2).frame(width: 1)
                    gmgnCallsColumn.frame(width: Self.sidebarWidth)
                    Rectangle().fill(FM.hair2).frame(width: 1)
                    thesisColumn.frame(width: Self.sidebarWidth)
                }
            }
        }
        .foregroundStyle(FM.ink)
        .background(GlassBackground())
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        // 和主面板一样的细边，不要绿色描边/光晕：fomo 风格是克制的
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(FM.hair))
        .shadow(color: .black.opacity(0.7), radius: 16, y: 14)
    }

    private var leftColumn: some View {
        VStack(spacing: 0) {
            header
            Hairline()
            chart
            Hairline()
            calls
            if !layout.wide {
                Hairline()
                HStack(spacing: 0) {
                    gmgnCallsColumn.frame(maxWidth: .infinity)
                    Rectangle().fill(FM.hair2).frame(width: 1)
                    thesisColumn.frame(maxWidth: .infinity)
                }
                .frame(height: layout.stackedHeight)
            }
        }
    }

    /// 顶部左侧代币信息，右侧利用空白展示本轮持仓；窄宽度放不下时，持仓自然排在代币信息下方，仍在 K 线上方。
    private var header: some View {
        Group {
            if let h = cycleHolding {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: 20) {
                        tokenInfo.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 0)
                        holdingSection(h).frame(width: 252)
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        tokenInfo
                        holdingSection(h).frame(width: 252)
                    }
                }
            } else {
                tokenInfo
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 11)
    }

    /// 代币信息（logo / 地址链接 / 市值 / 行情统计），与持仓盈亏独立排布。
    private var tokenInfo: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 9) {
                TokenLogo(symbol: t.symbol, logo: t.logoURL, size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(t.symbol).font(.system(size: 16, weight: .semibold)).lineLimit(1).fixedSize()
                        ChainBadge(chain: t.chain)
                        Text(t.resolved ? t.name : (now.timeIntervalSince(t.firstSeenDate) > 600 ? "未收录" : "加载中…"))
                            .font(.system(size: 11)).foregroundStyle(FM.muted).lineLimit(1).truncationMode(.tail)
                        if auto { Text("新").font(.system(size: 9, weight: .bold)).foregroundStyle(FM.accent).padding(.horizontal, 5).padding(.vertical, 1.5).background(FM.accent.opacity(0.12), in: Capsule()) }
                    }
                    HStack(spacing: 5) {
                        Button {
                            Links.copy(t.address)
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.2)); copied = false }
                        } label: {
                            HStack(spacing: 4) {
                                Text(t.shortAddr).numeric(10.5).foregroundStyle(FM.muted)
                                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 9)).foregroundStyle(copied ? FM.accent : FM.faint)
                            }.padding(.horizontal, 4).padding(.vertical, 2)
                        }.buttonStyle(.plain).clickable(radius: 5).help(t.address)
                        if let u = t.links?.website.flatMap(URL.init(string:)) { linkPill("官网", u) }
                        if let u = t.links?.telegram.flatMap(URL.init(string:)) { linkPill("TG", u) }
                        if let u = t.fomoLink { linkPill("fomo", u, accent: true) }
                        if let u = Links.gmgn(t) { linkPill("GMGN", u) }
                        if let u = Links.dex(t) { linkPill("DEX", u) }
                    }
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Fmt.compact(t.market?.mc)).numeric(17).fixedSize()
                Text("喊后 " + Fmt.pct(t.change, approx: t.changeApprox)).numeric(11.5).fixedSize()
                    .foregroundStyle(t.change == nil ? FM.faint : ((t.change ?? 0) >= 0 ? FM.up : FM.down))
                Spacer(minLength: 0)
            }
            HStack(spacing: 12) {
                stat("喊单 MC", Fmt.compact(t.mentions.first?.mc)); stat("流动性", Fmt.compact(t.market?.liq))
                stat("持有", t.market?.holders.map { "\(Int($0))" } ?? "—")
                stat("KOL", "\(t.kol) 人", accent: true)
                stat("fomo 买入", fomoBuyers)
                    .help(t.fomo?.holders == nil ? "fomo 关注者里买过这个币的人数" : "fomo 关注者里买过的人数 / 目前仍持有的人数")
                if t.fomo != nil {
                    stat("fomo 前排", FomoFrontRank.text(t.fomo?.frontRank)).help(FomoFrontRank.help(t.fomo?.frontRank))
                }
                if let ath = t.ath { stat("ATH", Fmt.compact(ath.mc)) }
                Spacer(minLength: 0)
            }
            HStack(spacing: 12) {
                delta("5m", t.market?.change5m); delta("1h", t.market?.change1h); delta("24h", t.market?.change24h)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 「fomo 买入」：买过的人数；知道持有人数时写成 3 / 5
    private var fomoBuyers: String {
        guard let f = t.fomo else { return "—" }
        if let h = f.holders { return "\(f.buyers) / \(h)" }
        return "\(f.buyers) 人"
    }

    /// 右列：swap 卡 → 𝕏 官方推特（原文 + 译文 + 嵌套引用）→ fomo 关注者动作。高度等于左列，内容多在栏内滚动。
    /// swap 卡在原位、**没有自己的外框/底色**（用户 2026-09-07：「就在原来的位置，只不过没有外边框」），直接坐在右栏玻璃底上
    private var sidebar: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 10) {
                TradeCard(t: t, state: tradeState, quote: tradeQuote, trade: trade, now: now, onQuote: onTradeQuote, onCancel: onCancelTradeQuote, onTrade: onTrade, onClose: onClose)
                twitterSection
                Hairline()
                fomoSection
            }
            .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 12)
        }
    }

    /// 卡头持仓区用的持仓：`holding` 是**这张卡**的币（地址 + 链精确匹配）并且还有量。`PopupHost` 传进来的已按此过滤，直接用 `PopupCard` 也不漏
    private var cycleHolding: TradeHolding? {
        guard let h = holding, h.amount > 0, h.address == t.address, h.chain == t.chain else { return nil }
        return h
    }

    /// 我的持仓（本地 burner 钱包链上余额 + 本地账本）：盈亏 $ + % 最醒目，下面 2×2 数量 / 估值、累计买入 / 累计卖出（confirmed 的买卖，不含转入转出）。
    /// 拿不到的数显示「—」不编 0；真 0 中性色；放在 Token 信息右侧，不加自己的外框
    private func holdingSection(_ h: TradeHolding) -> some View {
        let pctColor = h.pnlUsd != nil ? Self.pnlColor(h.pnlUsd) : Self.pnlColor(h.pnlPct)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Text("持仓").font(.system(size: 10, weight: .bold)).tracking(0.4).foregroundStyle(FM.accent)
                Text(t.symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(FM.faint).lineLimit(1)
                Spacer()
                Image(systemName: "questionmark.circle").font(.system(size: 10)).foregroundStyle(FM.faint)
                    .help("数量 / 估值：本地 burner 钱包的链上余额 × 现价。\n累计买入 / 累计卖出：本地账本里 confirmed 的买卖金额，不含转入转出。\n盈亏 = 估值 + 累计卖出 − 累计买入；百分数按累计买入算。\n「—」表示现价缺失或账本里没有这个币的成交。")
                    .accessibilityLabel("持仓说明")
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("盈亏").font(.system(size: 11)).foregroundStyle(FM.muted)
                Spacer(minLength: 8)
                Text(Fmt.usd(h.pnlUsd, signed: true)).numeric(17).fontWeight(.semibold).foregroundStyle(Self.pnlColor(h.pnlUsd)).lineLimit(1)
                Text(Fmt.pct(h.pnlPct)).numeric(11.5).foregroundStyle(pctColor).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("盈亏 \(Fmt.usd(h.pnlUsd, signed: true)) \(Fmt.pct(h.pnlPct))")
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 5) {
                GridRow {
                    cycleStat("数量", TradeCard.qty(h.amount), color: FM.ink)
                    cycleStat("估值", Fmt.usd(h.usd), color: h.usd == nil ? FM.faint : FM.ink)
                }
                GridRow {
                    cycleStat("累计买入", Fmt.usd(h.boughtUsd), color: h.boughtUsd == 0 ? FM.muted : FM.ink)
                    cycleStat("累计卖出", Fmt.usd(h.soldUsd), color: h.soldUsd == 0 ? FM.muted : FM.ink)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("持仓 \(t.symbol)")
    }

    /// 2×2 里的一格：小标签 + 等宽数字，占半栏
    private func cycleStat(_ label: String, _ value: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label).font(.system(size: 10.5)).foregroundStyle(FM.muted).fixedSize()
            Spacer(minLength: 4)
            Text(value).numeric(11.5).foregroundStyle(color).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(value)")
    }

    /// 盈亏着色：拿不到 → 淡；四舍五入到分后为 0 → 中性；正绿负红
    private static func pnlColor(_ v: Double?) -> Color {
        guard let v, v.isFinite else { return FM.faint }
        if abs(v) < 0.005 { return FM.muted }
        return v > 0 ? FM.up : FM.down
    }

    /// 资料里绑定的那个推特（gmgn 悬停 X 图标那张）：链接指向推文就显示那条推文（全文 + 译文，引用的原推嵌在卡内下方），指向账号就显示账号资料卡。只这一个，不列别的。
    private var twitterSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text("𝕏").font(.system(size: 11, weight: .bold))
                Text("官方推特").font(.system(size: 10, weight: .bold)).tracking(0.4).foregroundStyle(FM.accent)
                Spacer()
                if let u = t.links?.twitter.flatMap(URL.init(string:)) { openLink(u) }
            }
            if let tw = Self.linkedTweet(t) {
                tweetBox(tw)
            } else if let p = t.profile {
                profileCard(p)
            }
            if let message = t.twitterRequest.message {
                Text(message).font(.system(size: 10.5))
                    .foregroundStyle(t.twitterRequest.status == .error ? FM.orange : FM.faint)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    .background(FM.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    /// fomo 关注者对这个币的动作：买入 / 卖出 / Thesis，按 sidecar 给的顺序列；未登录、无数据、还没加载各有一行提示
    private var fomoSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text("fomo 关注者").font(.system(size: 10, weight: .bold)).tracking(0.4).foregroundStyle(FM.accent)
                if let f = t.fomo, !f.activity.isEmpty { Text("\(f.activity.count) 条").numeric(10).foregroundStyle(FM.faint) }
                Spacer()
            }
            if !fomoState.loggedIn {
                sidebarNote("未登录 fomo · 状态栏菜单登录", color: FM.muted)
            } else if let f = t.fomo {
                if f.activity.isEmpty {
                    sidebarNote("还没有关注者动作", color: FM.faint)
                } else {
                    ForEach(f.activity) { fomoRow($0) }
                }
            } else {
                sidebarNote("fomo 暂无此链数据", color: FM.faint)
            }
        }
    }

    private func sidebarNote(_ s: String, color: Color) -> some View {
        Text(s).font(.system(size: 10.5)).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            .background(FM.surface, in: RoundedRectangle(cornerRadius: 10))
    }

    /// 一条关注者动作：头像 · handle · 买入/卖出/Thesis 标签 · $金额 · @ 市值 · 多久前；thesis 的评论另起一行（≤3 行）
    private func fomoRow(_ a: FomoActivity) -> some View {
        let (label, color): (String, Color) = switch a.kind {
            case "buy": ("买入", FM.up)
            case "sell": ("卖出", FM.down)
            default: ("Thesis", FM.muted)
        }
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                CachedImage(url: a.avatar.flatMap(URL.init(string:))) {
                    Circle().fill(LinearGradient(colors: Token.avatarColors(a.handle), startPoint: .topLeading, endPoint: .bottomTrailing))
                        .overlay(Text(String(a.handle.prefix(1)).uppercased()).font(.system(size: 9, weight: .bold)).foregroundStyle(.white))
                }
                .frame(width: 18, height: 18).clipShape(Circle())
                Text(a.handle).font(.system(size: 11, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                Text(label).font(.system(size: 9, weight: .bold)).foregroundStyle(color)
                    .padding(.horizontal, 5).padding(.vertical, 1.5).background(color.opacity(0.12), in: Capsule()).fixedSize()
                Spacer(minLength: 4)
                if let usd = a.usd { Text(Fmt.compact(usd)).numeric(10.5).fixedSize() }
                if let mc = a.mc { Text("@ " + Fmt.compact(mc)).numeric(9.5).foregroundStyle(FM.faint).fixedSize() }
                Text(Fmt.ago(Date(timeIntervalSince1970: a.ts), now: now)).numeric(9.5).foregroundStyle(FM.faint).fixedSize()
            }
            if let c = a.comment?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty {
                Text(c).font(.system(size: 10)).foregroundStyle(FM.ink.opacity(0.85))
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 24)
            }
        }
        .padding(.vertical, 3)
    }

    // MARK: 「GMGN 喊单」列 = gmgn 代币页「喊单」面板（GMGN喊单 / X喊单 两页签）。官方推特 / 群内喊单是别的区，不混

    /// 当前弹卡的 GMGN 喊单快照（地址对不上 = 还没到）
    /// 守卫 = 地址 + 链：事件带链（拉取时按链路由）时必须等于卡上的链，链未知（`chain_unknown` 事件）时只比地址
    private var callsFeed: GmgnCalls? { gmgnCalls?.address == t.address && (gmgnCalls?.chain == nil || gmgnCalls?.chain == t.chain) ? gmgnCalls : nil }
    private var thesisFeed: FomoThesisFeed? { thesis?.address == t.address && (thesis?.chain == nil || thesis?.chain == t.chain) ? thesis : nil }

    private var gmgnCallsColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("GMGN 喊单").font(.system(size: 10, weight: .bold)).tracking(0.4).foregroundStyle(FM.accent)
                columnTab("GMGN", on: gmgnTab == .gmgn) { gmgnTab = .gmgn }
                columnTab("X", on: gmgnTab == .x) { gmgnTab = .x }
                Spacer(minLength: 4)
                if let c = callsFeed {
                    if gmgnTab == .gmgn, !c.items.isEmpty { Text("\(c.items.count) 条\(c.hasNext ? "+" : "")").numeric(10).foregroundStyle(FM.muted) }
                    if gmgnTab == .x, !c.tweets.isEmpty { Text("\(c.tweets.count) 条").numeric(10).foregroundStyle(FM.muted) }
                    if gmgnTab == .gmgn ? c.loading : c.tweetsLoading { ProgressView().controlSize(.mini) }
                }
            }
            .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 8)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 8) {
                    if gmgnTab == .gmgn { gmgnNativeList } else { gmgnXList }
                }
                .padding(.horizontal, 12).padding(.bottom, 12)
            }
        }
    }

    /// 原生 GMGN喊单（`community/messages`）：加载中 / 链未知 / 拉取失败 / 空 / 列表 + 服务端 has_more 时「加载更多」
    @ViewBuilder private var gmgnNativeList: some View {
        if let c = callsFeed {
            if c.items.isEmpty {
                if c.error == "chain_unknown" { sidebarNote("链未定，行情到了再拉", color: FM.muted) }
                else if let e = c.error { sidebarNote("拉取失败 · \(e)", color: FM.down) }
                else if c.loading { sidebarNote("加载中…", color: FM.muted) }
                else { sidebarNote("gmgn 上还没有人喊这个币", color: FM.muted) }
            } else {
                if let e = c.error { sidebarNote("刷新失败 · \(e)（下面是上次结果）", color: FM.down) }
                ForEach(c.items) { gmgnCallRow($0) }
                if c.hasNext { moreButton(loading: c.loading) { onGmgnCallsMore(t.address) } }
            }
        } else {
            sidebarNote("加载中…", color: FM.muted)
        }
    }

    /// X喊单（gmgn `twitter/token/search` 前 100 条，按时间降序）：一次到齐，本地每次多展开 20 条。
    /// 没拉到过（`tweetsAt == 0`）时按 `tweetsLoading` / `tweetsError` 区分 加载中 / 失败；拉过之后失败只提示、仍显示上次结果
    @ViewBuilder private var gmgnXList: some View {
        if let c = callsFeed {
            if c.tweetsAt == 0 {
                if let e = c.tweetsError, !c.tweetsLoading { sidebarNote("拉取失败 · \(e)", color: FM.down) }
                else { sidebarNote("加载中…", color: FM.muted) }
            } else if c.tweets.isEmpty {
                sidebarNote("gmgn 没搜到提到这个币的 X 帖", color: FM.muted)
            } else {
                if let e = c.tweetsError { sidebarNote("刷新失败 · \(e)（下面是上次结果）", color: FM.down) }
                ForEach(c.tweets.prefix(xShown)) { tweetBox($0) }
                if c.tweets.count > xShown { moreButton(loading: false) { xShown += 20 } }
            }
        } else {
            sidebarNote("加载中…", color: FM.muted)
        }
    }

    /// 一条 GMGN喊单：头像 · 显示名 · 蓝标 · KOL · @x 用户名 / 喊后倍数；正文（默认 ≤6 行，长文可展开）；粉丝 · 多久前 · ♥ · 回复。点作者名打开 x.com
    private func gmgnCallRow(_ c: GmgnCall) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                avatar(c.avatar, seed: c.handle.isEmpty ? c.name : c.handle, size: 22)
                Button { if let s = c.url, let u = URL(string: s) { NSWorkspace.shared.open(u) } } label: {
                    HStack(spacing: 4) {
                        Text(c.name).font(.system(size: 11, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                        if c.verified { Image(systemName: "checkmark.seal.fill").font(.system(size: 9.5)).foregroundStyle(Color(hex: 0x1d9bf0)) }
                        if c.kol { pill("KOL", FM.accent) }
                        if !c.handle.isEmpty, c.handle != c.name { Text("@\(c.handle)").numeric(9.5).foregroundStyle(FM.muted).lineLimit(1) }
                    }
                }
                .buttonStyle(.plain).clickable(radius: 5).disabled(c.url == nil)
                Spacer(minLength: 4)
                if let m = c.multiplier {
                    Text(m >= 10 ? String(format: "%.0fx", m) : String(format: "%.2fx", m)).numeric(10).fixedSize()
                        .foregroundStyle(m >= 1 ? FM.up : FM.down).help("喊单后市值倍数（gmgn multiplier）")
                }
            }
            if c.replyTo != nil { Text("喊回 ↩").font(.system(size: 9)).foregroundStyle(FM.muted).padding(.leading, 28) }
            if !c.text.isEmpty { expandableText(c.text, id: c.id, lines: 6).padding(.leading, 28) }
            HStack(spacing: 6) {
                if c.followers > 0 { Text(Fmt.followers(c.followers)).numeric(9.5) }
                Text(Fmt.ago(Date(timeIntervalSince1970: c.ts), now: now)).numeric(9.5)
                if c.likes > 0 { Text("♥ \(c.likes)").numeric(9.5) }
                if c.replies > 0 { Text("💬 \(c.replies)").numeric(9.5) }
                if let s = c.image, let u = URL(string: s) {
                    Button { NSWorkspace.shared.open(u) } label: { Text("附图 ↗").numeric(9.5).foregroundStyle(FM.muted) }.buttonStyle(.plain).clickable(radius: 4)
                }
            }
            .foregroundStyle(FM.muted).padding(.leading, 28)
        }
        .padding(8)
        .background(FM.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(FM.hair))
    }

    // MARK: 「fomo Thesis」列 = fomo 代币页 Thesis 列（`/feed/token/thesis`，全站用户；不同于右栏「fomo 关注者」只看我关注的人）

    private var thesisColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("fomo Thesis").font(.system(size: 10, weight: .bold)).tracking(0.4).foregroundStyle(FM.accent)
                Text("全站").font(.system(size: 9)).foregroundStyle(FM.muted)
                Spacer(minLength: 4)
                if let f = thesisFeed {
                    if !f.items.isEmpty {
                        Text(f.count.map { $0 > f.items.count ? "\(f.items.count) / \($0) 条" : "\(f.items.count) 条" } ?? "\(f.items.count) 条").numeric(10).foregroundStyle(FM.muted)
                    }
                    if f.loading { ProgressView().controlSize(.mini) }
                }
                if let u = t.fomoLink { openLink(u) }
            }
            .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 8)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 8) { thesisList }
                    .padding(.horizontal, 12).padding(.bottom, 12)
            }
        }
    }

    @ViewBuilder private var thesisList: some View {
        if !fomoState.loggedIn {
            sidebarNote("未登录 fomo · 状态栏菜单登录", color: FM.muted)
        } else if let f = thesisFeed {
            if f.items.isEmpty {
                switch f.error {
                case "not_logged_in": sidebarNote("未登录 fomo · 状态栏菜单登录", color: FM.muted)
                case "unsupported_chain": sidebarNote("fomo 不支持该链", color: FM.muted)
                case "chain_unknown": sidebarNote("链未定，行情到了再拉", color: FM.muted)
                case "fetch_failed": sidebarNote("拉取失败（fomo REST 退避 / 网络），稍后自动重试", color: FM.down)
                case "schema": sidebarNote("fomo 响应格式不符，未显示", color: FM.down)
                case .some(let e): sidebarNote("拉取失败 · \(e)", color: FM.down)
                case nil: if f.loading { sidebarNote("加载中…", color: FM.muted) } else { sidebarNote("还没有人写 Thesis", color: FM.muted) }
                }
            } else {
                if let e = f.error { sidebarNote("刷新失败 · \(e)（下面是上次结果）", color: FM.down) }
                ForEach(f.items) { thesisRow($0) }
                if f.hasNext { moreButton(loading: f.loading) { onThesisMore(t.address) } }
            }
        } else {
            sidebarNote("加载中…", color: FM.muted)
        }
    }

    /// 一条 Thesis：头像 · 显示名 · 蓝标 · dev · @handle / 多久前；正文（默认 ≤6 行，长文可展开）；♥ · 回复 · 作者持仓 $ 与未实现盈亏 %
    private func thesisRow(_ th: FomoThesis) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                avatar(th.avatar, seed: th.handle, size: 22)
                Text(th.name).font(.system(size: 11, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                if th.verified { Image(systemName: "checkmark.seal.fill").font(.system(size: 9.5)).foregroundStyle(Color(hex: 0x1d9bf0)) }
                if th.isDev { pill("dev", FM.amber) }
                if th.name != th.handle { Text("@\(th.handle)").numeric(9.5).foregroundStyle(FM.muted).lineLimit(1) }
                Spacer(minLength: 4)
                Text(Fmt.ago(Date(timeIntervalSince1970: th.ts), now: now)).numeric(9.5).foregroundStyle(FM.muted).fixedSize()
            }
            expandableText(th.comment, id: th.id, lines: 6).padding(.leading, 28)
            HStack(spacing: 6) {
                if th.likes > 0 { Text("♥ \(th.likes)").numeric(9.5) }
                if th.replies > 0 { Text("💬 \(th.replies)").numeric(9.5) }
                if let p = th.position {
                    Text("持仓 \(Fmt.compact(p.usd))").numeric(9.5)
                    if let pct = p.unrealizedPct {
                        Text(String(format: "%@%.1f%%", pct >= 0 ? "+" : "", pct)).numeric(9.5).foregroundStyle(pct >= 0 ? FM.up : FM.down)
                    }
                }
            }
            .foregroundStyle(FM.muted).padding(.leading, 28)
        }
        .padding(8)
        .background(FM.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(FM.hair))
    }

    // MARK: 两列共用的小件

    private func columnTab(_ label: String, on: Bool, _ act: @escaping () -> Void) -> some View {
        Button(action: act) {
            Text(label).font(.system(size: 9, weight: on ? .bold : .medium)).foregroundStyle(on ? FM.accent : FM.muted)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(on ? FM.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain).clickable(radius: 5)
    }

    private func pill(_ s: String, _ color: Color) -> some View {
        Text(s).font(.system(size: 8.5, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 4).padding(.vertical, 1).background(color.opacity(0.12), in: Capsule()).fixedSize()
    }

    private func avatar(_ url: String?, seed: String, size: CGFloat) -> some View {
        CachedImage(url: url.flatMap(URL.init(string:))) {
            Circle().fill(LinearGradient(colors: Token.avatarColors(seed), startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(Text(String(seed.prefix(1)).uppercased()).font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(.white))
        }
        .frame(width: size, height: size).clipShape(Circle())
    }

    /// 长正文：按字数 / 换行数判定「长」的才折成 `lines` 行 + 「展开全文 / 收起」；短文**不限行**（短 CJK / emoji 在窄列也可能折成 >6 行，不能被截掉）。展开状态按条目 id 记在卡上
    private func expandableText(_ s: String, id: String, lines: Int) -> some View {
        let text = s.trimmingCharacters(in: .whitespacesAndNewlines)
        let long = text.count > 140 || text.filter { $0 == "\n" }.count >= lines
        let open = expanded.contains(id)
        return VStack(alignment: .leading, spacing: 2) {
            Text(text).font(.system(size: 10.5)).foregroundStyle(FM.ink.opacity(0.9))
                .lineLimit(open || !long ? nil : lines).fixedSize(horizontal: false, vertical: true)
            if long {
                Button { if open { expanded.remove(id) } else { expanded.insert(id) } } label: {
                    Text(open ? "收起" : "展开全文").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(FM.accent.opacity(0.85))
                        .padding(.horizontal, 6).padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain).clickable(radius: 5)
            }
        }
    }

    private func moreButton(loading: Bool, _ act: @escaping () -> Void) -> some View {
        Button(action: act) {
            Text(loading ? "加载中…" : "加载更多").font(.system(size: 10, weight: .semibold)).foregroundStyle(FM.muted)
                .frame(maxWidth: .infinity).padding(.vertical, 6)
                .background(FM.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(FM.hair))
        }
        .buttonStyle(.plain).clickable(radius: 8).disabled(loading)
    }

    private func openLink(_ u: URL) -> some View {
        Button { NSWorkspace.shared.open(u) } label: { Text("打开 ↗").numeric(9.5).foregroundStyle(FM.muted).padding(.horizontal, 4).padding(.vertical, 2) }
            .buttonStyle(.plain).clickable(radius: 5).help(u.absoluteString)
    }

    /// 中部：分辨率按钮 + K 线（市值蜡烛；基准虚线 = 首次喊单 MC，喊单人标记）
    private var chart: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                HStack(spacing: 2) {
                    ForEach(Kline.choices, id: \.self) { r in
                        Button { resolution = r } label: {
                            Text(r).font(.system(size: 9.5, weight: r == resolution ? .bold : .medium).monospaced()).fixedSize()
                                .foregroundStyle(r == resolution ? FM.accent : FM.faint)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(r == resolution ? FM.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 5))
                        }
                        .buttonStyle(.plain).clickable(radius: 5)
                    }
                }
                Spacer()
                Text("滚轮缩放 · 拖动平移 · 双击复位").font(.system(size: 9)).foregroundStyle(FM.faint.opacity(0.7))
            }
            CandleChart(klines: klines.values.first.map { $0.address == t.address && (t.knownChain == nil || $0.chain == t.knownChain) } == true ? klines : [:],
                        address: t.address, chain: t.knownChain, firstCall: t.firstSeen, resolution: resolution,
                        selectedCall: context.map { CallMark(t: $0.ts, sender: $0.sender, group: $0.group) }, positions: PositionLevels(holding: holding, market: t.market),
                        onRequest: onKline, onCallTap: { ts, sender, group in onContext(t.address, sender, ts, group) })
                .frame(height: layout.chart.height - 40)
                .background(Color.white.opacity(0.02), in: RoundedRectangle(cornerRadius: 12))
        }
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 10)
    }

    /// 底部：群内喊单语境——首次喊单那条消息前 5 条 + 后 3 条群聊原文，喊单那条高亮；语境还没到时退回只列喊单记录
    private var calls: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("群内喊单").font(.system(size: 10.5, weight: .bold)).tracking(0.5).foregroundStyle(FM.accent)
                Text("\(t.mentions.count) 次 · \(t.kol) 人").numeric(10).foregroundStyle(FM.faint)
                if let c = context, let idx = t.mentions.firstIndex(where: { $0.time == c.ts && $0.sender == c.sender && $0.group == c.group }) {
                    Text("· 第 \(idx + 1) 次 \(c.sender) \(Fmt.ago(Date(timeIntervalSince1970: c.ts), now: now))").numeric(10).foregroundStyle(FM.muted).lineLimit(1)
                }
                Spacer()
                Text(t.mentions.count > 1 ? "点 K 线上的标记看其他喊单" : "").font(.system(size: 9.5)).foregroundStyle(FM.faint.opacity(0.8))
                if let c = context, let g = groups[c.group] { Text(g).font(.system(size: 10)).foregroundStyle(FM.faint).lineLimit(1) }
            }
            if let c = context, !c.lines.isEmpty {
                ForEach(Array(c.lines.enumerated()), id: \.offset) { i, l in
                    contextLine(l, isCall: i == c.call)
                }
            } else {
                ForEach(Array(t.mentions.reversed().prefix(4).enumerated()), id: \.offset) { _, m in
                    contextLine(CallContext.Line(time: m.time, sender: m.sender, text: m.text), isCall: true)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
    }

    private func contextLine(_ l: CallContext.Line, isCall: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(LinearGradient(colors: Token.avatarColors(l.sender), startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 16, height: 16)
                .overlay(Text(String(l.sender.prefix(1))).font(.system(size: 8.5, weight: .bold)).foregroundStyle(.white))
                .opacity(isCall ? 1 : 0.7)
            Text(l.sender).font(.system(size: 11, weight: .semibold)).foregroundStyle(isCall ? FM.ink : FM.muted).lineLimit(1).fixedSize()
            Text(Fmt.clock(Date(timeIntervalSince1970: l.time))).numeric(10).foregroundStyle(FM.faint).fixedSize()
            Text(l.text.lowercased() == t.address ? t.shortAddr : l.text)
                .font(.system(size: 10.5)).foregroundStyle(isCall ? FM.ink.opacity(0.9) : FM.muted)
                .lineLimit(isCall ? 3 : 1).truncationMode(.tail).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3).padding(.horizontal, isCall ? 8 : 0)
        .background(isCall ? FM.accent.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .overlay(alignment: .leading) { if isCall { RoundedRectangle(cornerRadius: 1).fill(FM.accent).frame(width: 2).padding(.vertical, 3) } }
    }

    /// 账号资料卡：头像 · 名 · 蓝标 · @id · 粉丝 · 注册时间 · 简介（2 行）
    private func profileCard(_ p: TwitterUser) -> some View {
        Button { if let u = URL(string: "https://x.com/\(p.screen)") { NSWorkspace.shared.open(u) } } label: {
            HStack(alignment: .top, spacing: 8) {
                CachedImage(url: URL(string: p.avatar)) { Circle().fill(FM.surface).overlay(Text(String(p.name.prefix(1))).font(.system(size: 12, weight: .bold)).foregroundStyle(FM.muted)) }
                    .frame(width: 28, height: 28).clipShape(Circle())
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(p.name).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                        if p.verified { Image(systemName: "checkmark.seal.fill").font(.system(size: 9.5)).foregroundStyle(Color(hex: 0x1d9bf0)) }
                        Text("@\(p.screen)").numeric(9.5).foregroundStyle(FM.muted).lineLimit(1)
                    }
                    Text([p.followers > 0 ? Fmt.followers(p.followers) : nil, p.joined.map(Fmt.joined)].compactMap { $0 }.joined(separator: " · "))
                        .lineLimit(1).numeric(9.5).foregroundStyle(FM.faint)
                    if let bio = p.bio, !bio.isEmpty {
                        Text(bio).font(.system(size: 10)).foregroundStyle(FM.ink.opacity(0.85)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(FM.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(FM.hair))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).clickable(radius: 10)
    }

    private func stat(_ label: String, _ value: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9, weight: .semibold)).tracking(0.4).foregroundStyle(FM.faint)
            Text(value).numeric(12).foregroundStyle(accent ? FM.accent : FM.ink).lineLimit(1)
        }.fixedSize()
    }

    private func delta(_ label: String, _ v: Double?) -> some View {
        HStack(spacing: 3) {
            Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(FM.faint).fixedSize()
            Text(Fmt.pct(v)).numeric(10).foregroundStyle(v == nil ? FM.faint : ((v ?? 0) >= 0 ? FM.up : FM.down))
                .lineLimit(1).fixedSize()
        }
    }

    private func linkPill(_ label: String, _ url: URL, accent: Bool = false) -> some View {
        Button { NSWorkspace.shared.open(url) } label: {
            Text(label).font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 7).padding(.vertical, 3)
                .foregroundStyle(accent ? FM.accent : FM.muted)
                .background(FM.surface, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(accent ? FM.accent.opacity(0.35) : FM.hair))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).clickable()
        .help(url.absoluteString)
    }

    /// 一条推文的卡：头像 · 名字 @id · 粉丝/多久前/♥；正文全文（上限 12 行防极端长文）；有译文时下面一块略淡底的译文；引用了别的推文时被引用的原推（作者 · 原文 · 译文）嵌在最下面
    private func tweetBox(_ tw: Tweet) -> some View {
        let user = tw.user
        return Button { if let u = URL(string: tw.url) { NSWorkspace.shared.open(u) } } label: {
            HStack(alignment: .top, spacing: 8) {
                CachedImage(url: URL(string: user.avatar)) { Circle().fill(FM.surface) }
                    .frame(width: 28, height: 28).clipShape(Circle())
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(user.name).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                        if user.verified { Image(systemName: "checkmark.seal.fill").font(.system(size: 9.5)).foregroundStyle(Color(hex: 0x1d9bf0)) }
                        Text("@\(user.screen)").numeric(9.5).foregroundStyle(FM.muted).lineLimit(1)
                    }
                    Text([user.followers > 0 ? Fmt.followers(user.followers) : nil, tw.time > 0 ? Fmt.ago(Date(timeIntervalSince1970: tw.time), now: now) : nil, tw.likes.map { "♥ \($0)" }]
                            .compactMap { $0 }.joined(separator: " · "))
                        .numeric(9.5).foregroundStyle(FM.faint).lineLimit(1)
                    Text(tw.text.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 10)).foregroundStyle(FM.ink.opacity(0.9))
                        .lineLimit(12).fixedSize(horizontal: false, vertical: true)
                    if let translation = tw.translation {
                        Text(translation.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 10)).foregroundStyle(FM.muted)
                            .lineLimit(12).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 6).padding(.vertical, 5)
                            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
                            .padding(.top, 3)
                    }
                    if let q = tw.quoted {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 4) {
                                CachedImage(url: URL(string: q.user.avatar)) { Circle().fill(FM.surface) }
                                    .frame(width: 16, height: 16).clipShape(Circle())
                                Text(q.user.name).font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
                                if q.user.verified { Image(systemName: "checkmark.seal.fill").font(.system(size: 9)).foregroundStyle(Color(hex: 0x1d9bf0)) }
                                Text("@\(q.user.screen)").numeric(9).foregroundStyle(FM.muted).lineLimit(1)
                                if q.time > 0 { Text("· " + Fmt.ago(Date(timeIntervalSince1970: q.time), now: now)).numeric(9).foregroundStyle(FM.faint).lineLimit(1) }
                            }
                            Text(q.text.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 10)).foregroundStyle(FM.ink.opacity(0.85))
                                .lineLimit(8).fixedSize(horizontal: false, vertical: true)
                            if let qt = q.translation {
                                Text(qt.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 10)).foregroundStyle(FM.muted)
                                    .lineLimit(8).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(7)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(FM.hair))
                        .padding(.top, 5)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(FM.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(FM.hair))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).clickable(radius: 10)
    }
}

// MARK: - 交易卡

/// 右栏顶部的「swap」卡：买/卖切换、买入 = 原生币数量输入（旁边 ≈$ 估值，来自 sidecar 的 DexScreener 缓存价，没价就不显示）、卖出 = 持仓百分比瓦片、
/// 报价（预计获得 / 网络费 / 价格影响）、主按钮「买入 X」。
/// 报价由 sidecar 向 OKX 拉**一次**（只在输入数量 / 点快捷额时问：手输 400ms 防抖，瓦片点下去立刻问；数量一变先作废旧报价；本地判错不问），不依赖任何价格，没有周期刷新也没有过期时间：
/// 报价旁显示「N 秒前」，超 30s 变灰提醒但不自动重报——执行时 sidecar 用 `/swap` 现取新路由 + tx（OKX 自带 autoSlippage ≤15% / 价格影响保护 50%）。
/// 主按钮**只在用户点击时**把结构化意图（地址/链/方向/原生币数量/卖出百分比/报价 id）交给 sidecar，由本地 burner 钱包签名、经 OKX 路由提交。
/// 门禁只看 `state.ready`（钱包已生成 + OKX 已配），不看 fomo 登录；不 ready 时只显示 `state.reason` 一行。
/// 下单状态（validating/submitting/submitted/confirmed/failed/unknown）按地址存在 `Feed.trades`，弹卡关了再开还在；未落定（含 unknown）时**只锁执行按钮**、禁止重发，没有定时器解锁；换方向/改金额/看报价始终可用。
struct TradeCard: View {
    let t: Token
    let state: TradeState
    let quote: TradeQuote?
    /// 该币最近一次下单（Feed 按地址留着）
    let trade: Trade?
    /// 5s 一跳的当前时间：报价「N 秒前」
    let now: Date
    /// (address, chain, side, amount, sellPct) → sidecar 拉一次性报价；buy 传原生币数量，sell 传 0 + pct，sidecar 按真实代币余额算
    let onQuote: (String, String, String, Double, Int?) -> Void
    let onCancel: () -> Void
    /// (address, chain, side, amount, sellPct, quoteId) → sidecar 下单；只由主按钮点击触发
    let onTrade: (String, String, String, Double, Int?, String) -> Void
    let onClose: () -> Void
    @State private var side = "buy"
    /// 买入的原生币数量字面（TextField 原样字符串）；卖出方向不用
    @State private var amount = ""
    /// 卖出选中的持仓百分比（卖出只有这一种意图）
    @State private var sellPct: Int?
    /// 点了下单、sidecar 还没回第一条状态：本地先锁住，防双击；只有 trade 变了才解（无超时）
    @State private var sent: Date?
    /// 快捷额瓦片刚点过：下一次报价不等 400ms 防抖（点击是一次确定的意图，手输才需要等手停）
    @State private var instantQuote = false
    /// 点了「充值」：弹 `DepositSheet`（六条链的地址 + 该转什么币）；余额 0 时胶囊常亮提醒，但不自动弹
    @State private var showDeposit = false

    /// 报价超过这个秒数「N 秒前」变灰（只提醒，不自动重报）
    private static let staleAfter = 30

    /// 买入的原生币数量（解析失败 / 空 → 0）
    private var qtyIn: Double { Double(amount) ?? 0 }
    private var position: TradePosition? { t.position }
    /// 该币所在链的原生币余额 + 缓存价（买入付款 / 卖出付 gas）；`trade_state` 没给这条链 → nil
    private var balance: TradeState.Balance? { state.balances[t.chain] }
    /// 买入数量的美元估值：amount × 缓存价；没价 / 没数量 → nil（只做显示，报价不需要它）
    private var buyUsd: Double? { balance?.price.flatMap { qtyIn > 0 ? qtyIn * $0 : nil } }
    /// 当前地址/链/方向对得上、且意图对得上的报价才算：卖比 pct，买比原生币数量（旧数量、别的币、别的链的报价不显示）
    private var liveQuote: TradeQuote? {
        guard let q = quote, q.address == t.address, q.chain == t.chain, q.side == side else { return nil }
        if side == "sell" { guard let p = sellPct, q.pct == p else { return nil } }
        else { guard q.pct == nil, q.amount == qtyIn else { return nil } }
        return q
    }
    private var hasIntent: Bool { side == "sell" ? sellPct != nil : qtyIn > 0 }
    /// 本地就能判的错（不问 sidecar）：买入走 `TradeState.buyReason`（原生币不够按数量判，最低额 / 单笔 / 今日只在有缓存价时判）；
    /// 卖出按持仓估值 × pct 判单笔上限——真实卖出量由 sidecar 按余额×pct 算，持仓 USD 缺现价就不判
    private var localError: String? {
        guard hasIntent else { return nil }
        if side == "buy" { return state.buyReason(chain: t.chain, amount: qtyIn) }
        if let p = sellPct, let pu = position?.usd, pu.isFinite, pu * Double(p) / 100 > state.limits.perTrade {
            return "超单笔上限 \(Fmt.usd(state.limits.perTrade))"
        }
        return nil
    }
    /// 已经问了 sidecar、还没等到对得上的报价：按钮区给「报价中…」反馈
    private var quotePending: Bool { hasIntent && localError == nil && liveQuote == nil }
    private var stale: Bool { liveQuote.map { $0.ageSeconds(now: now) > Self.staleAfter } ?? false }

    /// sidecar 报的未落定状态。`unknown` 也算：钱的事结果不明就不能再下单，等 sidecar 对账成 confirmed/failed 才放开
    private var inFlight: Bool { trade?.isLocked ?? false }
    /// **只锁执行**：sidecar 有未落定单，或本地刚点了下单还没收到第一条状态（没有超时自动解锁；弹卡重开后靠 Feed.trades 里 sidecar 立刻回的 validating 接力）。
    /// 换方向 / 改金额 / 快捷额 / 看报价永远可用——上一单 submitted 等链上确认的几十秒里点「卖出」必须有反应
    private var executeLocked: Bool { inFlight || sent != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("swap").font(.system(size: 9.5, weight: .semibold)).tracking(0.4).foregroundStyle(FM.faint)
                Spacer()
                // 充值：与 × 同排（用户 2026-09-10：「存款按钮应该在 swap 那个 x 的位置，不要显示地址」）；余额 0 时亮绿提醒；点开六链充值弹窗
                if state.hasWallet {
                    let empty = (balance?.native ?? 0) == 0
                    Button { showDeposit = true } label: {
                        Text("充值").font(.system(size: 10, weight: .semibold)).foregroundStyle(showDeposit || empty ? FM.accent : FM.muted)
                            .padding(.horizontal, 7).padding(.vertical, 2.5)
                            .background(FM.accent.opacity(showDeposit || empty ? 0.14 : 0.06), in: Capsule())
                    }
                    .buttonStyle(.plain).clickable(radius: 9).help("充值：各链地址与该转的币")
                    .popover(isPresented: $showDeposit, arrowEdge: .bottom) { DepositSheet(state: state) }
                }
                Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).padding(4) }
                    .buttonStyle(.plain).clickable().foregroundStyle(FM.muted)
            }
            if state.ready {
                tabs
                amountTile
                presets
                infoRows
                if let tr = trade { statusRow(tr) }
                action
                if let q = liveQuote, q.ok, q.honeypot || (q.taxPct ?? 0) > 0 { taxWarning(q) }
                if let q = liveQuote, q.ok, let n = q.networkFeeUsd, n > 1 { feeWarning }
            } else {
                Text(state.reason ?? "等待 sidecar 交易状态…").font(.system(size: 10.5)).foregroundStyle(FM.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    .background(FM.surface2, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(12)
        .onChange(of: side) { _, _ in amount = ""; sellPct = nil }
        // sidecar 回了任何一条下单状态 → 本地锁交给 inFlight 管
        .onChange(of: trade) { _, _ in sent = nil }
        // 数量/方向/百分比一变：先作废上一份报价（一次性报价，旧数量的回包不能显示）。手输数量等 400ms 没再动才问；快捷额瓦片点下去立刻问。本地判错的不问。
        // 按百分比卖时 key 只看 pct + 本地是否有效：持仓 USD 每 tick 变化不能把报价作废重问，但跨过限额门槛（无效→有效）要发起报价、（有效→无效）要作废
        .task(id: side == "sell" ? "\(side)|pct\(sellPct.map(String.init) ?? "-")|\(localError == nil)" : "\(side)|\(qtyIn)") {
            onCancel()
            let instant = instantQuote
            instantQuote = false
            let pct = side == "sell" ? sellPct : nil
            guard hasIntent, localError == nil else { return }
            if !instant {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
            }
            onQuote(t.address, t.chain, side, side == "sell" ? 0 : qtyIn, pct)
        }
        .onDisappear(perform: onCancel)
    }

    /// 该币最近一次下单的状态行：方向 · 金额 · 状态（颜色按结果），失败带原因，已提交带短 hash
    private func statusRow(_ tr: Trade) -> some View {
        let (label, color) = tr.statusLabel
        let note = tr.error ?? tr.detail
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if tr.isPending { ProgressView().controlSize(.mini) }
                Text("\(tr.side == "buy" ? "买入" : "卖出") \(tr.pct.map { "\($0)%" } ?? "$" + Self.fmt(tr.usd))").numeric(10).foregroundStyle(FM.muted)
                Text(label).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(color)
                Spacer(minLength: 0)
                if let h = tr.txHash, h.count > 12 {
                    Text(h.prefix(6) + "…" + h.suffix(4)).numeric(9).foregroundStyle(FM.faint).help(h)
                }
            }
            if let note, !note.isEmpty {
                Text(note).font(.system(size: 9.5)).foregroundStyle(tr.status == "failed" ? FM.down.opacity(0.9) : FM.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 2).padding(.vertical, 4) }
    }

    /// 买入 / 卖出：两块等宽瓦片。选中 → 半透明绿/红底 + 绿/红粗字；未选 → surface2 底 + 灰字
    private var tabs: some View {
        HStack(spacing: 8) {
            ForEach([("buy", "买入", FM.accent.opacity(0.18), FM.accent), ("sell", "卖出", FM.down.opacity(0.18), FM.down)], id: \.0) { k, label, tint, fg in
                Button { side = k } label: {
                    Text(label).font(.system(size: 12.5, weight: .bold))
                        .foregroundStyle(side == k ? fg : FM.muted)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background(side == k ? tint : FM.surface2, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain).clickable(radius: 10)
            }
        }
    }

    /// 数量瓦片右侧文案的上限宽。卡宽 276（右栏 300 − 栏 padding 12×2），瓦片内容宽 224（再减卡 padding 12×2、瓦片 padding 14×2），
    /// 扣掉两个 10 间距 + 4 Spacer 后数量组至少还剩 ~92pt，够 `10000 MON`（22pt 等宽粗体数字 + 12pt 符号）；长代币名在右侧截断（…），不能把输入框挤没
    private static let quoteSideMaxWidth: CGFloat = 108

    /// 数量瓦片：买入 = 左大号原生币数量输入 + 符号后缀，下面一行「≈ $x」（有缓存价才有）；卖出 = 「卖出 <数量> <symbol>」+「≈ $x」由持仓 × pct 算（没选比例显示提示）。
    /// 右两行 = 预计获得 / 价格影响 · N 秒前（报价中、本地错、sidecar 错都占这个位置）
    private var amountTile: some View {
        HStack(alignment: .center, spacing: 10) {
            if side == "buy" { buyInput } else { sellSummary }
            Spacer(minLength: 4)
            quoteSide.frame(maxWidth: Self.quoteSideMaxWidth, alignment: .trailing).layoutPriority(1)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(FM.surface2, in: RoundedRectangle(cornerRadius: 12))
    }

    /// 买入数量：只有数字（照 gmgn：输入框和快捷额都不带币种字样，单位由下面「可用 N BNB」一行说明；用户 2026-09-11「这里面也不需要显示 BNB」），下一行「≈ $x」
    private var buyInput: some View {
        VStack(alignment: .leading, spacing: 2) {
            // 占位「0」用 FM.faint；面板窗口已钉 darkAqua，这里再显式钉一次 colorScheme，脱离 makePanel 宿主（离屏夹具）时占位也不会变成近黑
            TextField("0", text: $amount, prompt: Text("0").foregroundColor(FM.faint))
                .textFieldStyle(.plain).font(.system(size: 22, weight: .bold, design: .monospaced)).monospacedDigit().foregroundStyle(FM.ink)
                .environment(\.colorScheme, .dark)
                .onChange(of: amount) { _, v in
                    // 只留数字和一个小数点（TextField 是原样字符串，不走任何本地化）
                    var dot = false
                    let f = v.filter { c in
                        if c == "." { if dot { return false }; dot = true; return true }
                        return c.isNumber
                    }
                    if f != v { amount = f }
                }
            if let u = buyUsd {
                Text("≈ $" + Self.fmt(u)).numeric(10.5).foregroundStyle(FM.muted).lineLimit(1)
            }
        }
    }

    private var sellSummary: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let p = sellPct, let pos = position, pos.amount > 0 {
                Text("卖出 \(Self.qty(pos.amount * Double(p) / 100)) \(t.symbol)").font(.system(size: 15, weight: .bold, design: .monospaced)).monospacedDigit()
                    .foregroundStyle(FM.ink).lineLimit(1).minimumScaleFactor(0.7)
                if let u = pos.usd, u.isFinite {
                    Text("≈ $" + Self.fmt(u * Double(p) / 100)).numeric(10.5).foregroundStyle(FM.muted).lineLimit(1)
                }
            } else {
                Text((position?.amount ?? 0) > 0 ? "选一个比例" : "没有持仓").font(.system(size: 15, weight: .bold)).foregroundStyle(FM.faint).lineLimit(1)
            }
        }
    }

    /// 报价没回来之前的本地估算（照 gmgn：它的面板就只有这个——数量 × 原生币价 ÷ 代币价，两个价都已在手里，0 请求）。
    /// 不含价格影响 / 税 / 路由，所以灰色 + 「估算」字样；OKX 真报价 0.2s 后到了就换成实数。买：≈ 代币数量；卖：≈ 持仓估值 × pct。没价就 nil（回退「报价中…」）
    private var localEstimate: String? {
        if side == "buy" {
            guard qtyIn > 0, let np = balance?.price, let tp = t.market?.price, tp > 0 else { return nil }
            return "≈\(Self.qty(qtyIn * np / tp)) \(t.symbol)"
        }
        guard let p = sellPct, let pos = position, pos.amount > 0, let u = pos.usd, u.isFinite else { return nil }
        return "≈$" + Self.fmt(u * Double(p) / 100)
    }

    /// 数量瓦片右侧：本地错 / sidecar 错（红）· 本地估算 + 报价中… · 预计获得 + `影响 x%` 价格影响（**原样带符号**：sidecar 给多少显多少）+ 「N 秒前」（>30s 灰）
    @ViewBuilder private var quoteSide: some View {
        if let e = localError {
            Text(e).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(FM.down).lineLimit(1)
        } else if let q = liveQuote {
            if !q.ok {
                Text(Self.errorText(q)).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(FM.down).lineLimit(2).multilineTextAlignment(.trailing)
            } else {
                VStack(alignment: .trailing, spacing: 2) {
                    if side == "buy", let n = q.outAmount {
                        Text("~\(Self.qty(n)) \(q.outSymbol ?? t.symbol)").numeric(13).fontWeight(.medium).foregroundStyle(FM.ink.opacity(0.85)).lineLimit(1)
                    } else if let u = q.outUsd {
                        Text("~$" + Self.fmt(u)).numeric(13).fontWeight(.medium).foregroundStyle(FM.ink.opacity(0.85)).lineLimit(1)
                    }
                    HStack(spacing: 4) {
                        if let impact = q.priceImpactPct {
                            Text(String(format: "影响 %.2f%%", impact)).numeric(10).foregroundStyle(impact > 5 ? FM.down : FM.muted).lineLimit(1)
                        }
                        Text("\(q.ageSeconds(now: now))秒前").numeric(10).foregroundStyle(stale ? FM.faint : FM.muted).lineLimit(1)
                            .help(stale ? "报价超过 \(Self.staleAfter)s；执行时 sidecar 会现取新路由，改一下数量可重新报价" : "报价时刻；执行时 sidecar 会现取新路由")
                    }
                }
            }
        } else if quotePending {
            VStack(alignment: .trailing, spacing: 2) {
                if let est = localEstimate {
                    Text(est).numeric(13).fontWeight(.medium).foregroundStyle(FM.muted).lineLimit(1)
                        .help("按现价估算（数量 × 原生币价 ÷ 代币价），不含价格影响与税；OKX 报价到了会替换")
                }
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini)
                    Text(localEstimate == nil ? "报价中…" : "估算 · 报价中…").font(.system(size: 10)).foregroundStyle(FM.faint).lineLimit(1)
                }
            }
        }
    }

    /// 快捷额（设置 `presets`，sidecar `trade_state` 下发）：买 → 该链原生币数量，只显数字 `0.01`（`state.buyPresets(chain:)`，回填输入框；单位见「可用」行）；卖 → 持仓百分比 `N%`（没持仓就没得选）。
    /// 点击立刻报价，不等防抖。卖出只按 pct 走 sidecar 用真实代币余额，没有 USD 折算
    @ViewBuilder private var presets: some View {
        if side == "buy" {
            let list = state.buyPresets(chain: t.chain)
            if !list.isEmpty {
                HStack(spacing: 6) {
                    ForEach(list, id: \.self) { v in
                        chip(Fmt.literal(v), active: qtyIn == v) { if qtyIn != v { instantQuote = true }; amount = Fmt.literal(v) }
                    }
                }
            }
        } else if let p = position, p.amount > 0, !state.presets.sell.isEmpty {
            HStack(spacing: 6) {
                ForEach(state.presets.sell, id: \.self) { pct in
                    chip("\(pct)%", active: sellPct == pct) { if sellPct != pct { instantQuote = true }; sellPct = pct }
                }
            }
        }
    }

    /// 等宽瓦片：选中白字，未选灰字，无描边
    private func chip(_ label: String, active: Bool, _ act: @escaping () -> Void) -> some View {
        Button(action: act) {
            Text(label).font(.system(size: 11.5, weight: .bold, design: .monospaced)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
                .foregroundStyle(active ? FM.ink : FM.muted)
                .frame(maxWidth: .infinity, minHeight: 28)
                .background(FM.surface2, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain).clickable(radius: 10)
    }

    /// 「持仓 N SYM · $X」（估值缺现价时只有数量）
    private func positionText(_ p: TradePosition) -> String {
        "持仓 \(Self.qty(p.amount)) \(t.symbol)" + (p.usd.map { " · $" + String(format: "%.2f", $0) } ?? "")
    }

    /// 一行信息：左 = 可用（买：该链原生币 `0.0213 BNB ≈$16`）/ 持仓（卖）；右 = 网络费（链上 gas，>$1 橙）。
    /// 买入方向且已持有该币时再加一行持仓 数量·USD（卖出方向这信息已在左侧）。充值按钮在卡头 × 旁，不占这里
    private var infoRows: some View {
        let q = liveQuote.flatMap { $0.ok ? $0 : nil }
        let left: String = side == "buy"
            ? balance.map { b in "可用 \(Self.qty(b.native)) \(b.symbol)" + (b.usd.map { " ≈$" + Self.fmt($0) } ?? "") } ?? "可用 —"
            : position.flatMap { $0.amount > 0 ? positionText($0) : nil } ?? "没有持仓"
        let net = q?.networkFeeUsd
        return VStack(spacing: 4) {
            HStack(spacing: 6) {
                Text(left).numeric(11).foregroundStyle(FM.muted).lineLimit(1)
                Spacer(minLength: 8)
                Text("网络费").font(.system(size: 11)).foregroundStyle(FM.muted)
                Text(net.map { "$" + Self.fmt($0) } ?? "—").numeric(11).foregroundStyle((net ?? 0) > 1 ? FM.orange : FM.muted)
            }
            .help("网络费 = 链上 gas；滑点由 OKX 自动（≤15%），价格影响保护 50%")
            if side == "buy", let p = position, p.amount > 0 {
                HStack {
                    Text(positionText(p)).numeric(10.5).foregroundStyle(FM.muted).lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
        }
    }

}

/// 充值弹窗（弹卡「充值」胶囊 / 状态栏「充值地址…」共用）：**两块**——左 EVM（RH / BSC / ETH / Base / Monad 共用一把地址）、右 Solana（单独一把），
/// 各自二维码 + 完整地址 + 有余额的链；点整块即复制（1.2s「已复制」）。2026-09-10 版是六链各一行，用户 2026-09-11：「EVM 和 SOL 单独显示就行，
/// 不用每个链一个地址，做成二维码，左边 evm 右边 sol」；再改「不要选中框效果、转什么币的提示多余」——两块同色无边框，不标当前链，链徽本身就说明转什么
struct DepositSheet: View {
    let state: TradeState
    /// 刚复制的块（"evm" / "sol"），1.2s 后清
    @State private var copied: String? = nil

    private struct Block: Identifiable {
        let id: String
        let title: String
        let chains: [TradeState.ChainInfo]
        let address: String?
    }
    private var blocks: [Block] {
        [
            Block(id: "evm", title: "EVM", chains: TradeState.chains.filter { $0.slug != "sol" }, address: state.evmAddress),
            Block(id: "sol", title: "Solana", chains: TradeState.chains.filter { $0.slug == "sol" }, address: state.solAddress),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("充值到热钱包").font(.system(size: 13, weight: .bold)).foregroundStyle(FM.ink)
                Text("五条 EVM 链共用左边这把地址，Solana 用右边这把；热钱包只放小额。")
                    .font(.system(size: 10.5)).foregroundStyle(FM.muted).fixedSize(horizontal: false, vertical: true)
            }
            if state.hasWallet {
                HStack(alignment: .top, spacing: 10) { ForEach(blocks) { block($0) } }
            } else {
                Text(state.reason ?? "钱包未生成：终端跑 pnpm cli wallet-init，重启 sidecar 后这里就有地址")
                    .font(.system(size: 11)).foregroundStyle(FM.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: 500)
        // 弹窗材质跟系统外观走，配色（ink 近白、surface2 白 7%）是按深底设计的：自己铺一层实色深底，浅色系统下也不会白字白底
        .background(Color(hex: 0x15171a))
    }

    private func block(_ b: Block) -> some View {
        let done = copied == b.id
        return Button {
            guard let address = b.address else { return }
            Links.copy(address)
            copied = b.id
            Task { try? await Task.sleep(for: .seconds(1.2)); if copied == b.id { copied = nil } }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 5) { ForEach(b.chains) { ChainBadge(chain: $0.slug) } }
                Text(b.title).font(.system(size: 12, weight: .bold)).foregroundStyle(FM.ink)
                HStack { Spacer(minLength: 0); QRCode(text: b.address ?? "", size: 132); Spacer(minLength: 0) }
                Text(b.address ?? "—").font(.system(size: 10, design: .monospaced)).foregroundStyle(b.address == nil ? FM.faint : FM.muted)
                    .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(balances(b)).numeric(10).foregroundStyle(FM.faint).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Text(done ? "已复制" : "复制").font(.system(size: 10, weight: .semibold)).foregroundStyle(done ? FM.accent : FM.ink)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(done ? FM.accent.opacity(0.14) : FM.surface2, in: Capsule())
                }
            }
            .padding(10)
            .frame(width: 231, alignment: .leading)
            .background(FM.surface2, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain).clickable(radius: 10)
        .disabled(b.address == nil)
        .help(b.address.map { "点击复制 \($0)" } ?? "钱包未生成")
    }

    /// 该块里**有余额的链**：`BSC 0.0528 BNB · RH 0.01 ETH`（不同链的 ETH 不能相加，按链列；全零 → 「各链余额 0」）
    private func balances(_ b: Block) -> String {
        let parts = b.chains.compactMap { c -> String? in
            guard let bal = state.balances[c.slug], bal.native > 0 else { return nil }
            return "\(c.slug == "robinhood" ? "RH" : c.slug.uppercased()) \(TradeCard.qty(bal.native)) \(bal.symbol)"
        }
        return parts.isEmpty ? "各链余额 0" : parts.joined(separator: " · ")
    }
}

/// 地址二维码：CoreImage 生成后按整数倍放大（插值关掉，不糊）；文本为空画占位
struct QRCode: View {
    let text: String
    let size: CGFloat
    var body: some View {
        Group {
            if let img = Self.render(text, side: size) {
                Image(nsImage: img).interpolation(.none).resizable().frame(width: size, height: size)
            } else {
                RoundedRectangle(cornerRadius: 6).fill(FM.surface2).frame(width: size, height: size)
            }
        }
        .padding(6).background(.white, in: RoundedRectangle(cornerRadius: 8))
    }
    static func render(_ text: String, side: CGFloat) -> NSImage? {
        guard !text.isEmpty, let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage else { return nil }
        let scale = max(1, floor(side * 2 / out.extent.width))
        let scaled = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let rep = NSCIImageRep(ciImage: scaled)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }
}

extension TradeCard {

    /// 蜜罐 / 买卖税 > 0 的橙色警示行（数据来自 OKX 报价，标题不带来源前缀——用户 2026-09-10 要求）；只在有 ok 报价时出现
    private func taxWarning(_ q: TradeQuote) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 14, weight: .semibold)).foregroundStyle(FM.orange).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(q.honeypot ? "疑似蜜罐" : String(format: "买卖税 %.1f%%", q.taxPct ?? 0)).font(.system(size: 11.5, weight: .bold)).foregroundStyle(FM.orange)
                Text(q.honeypot ? "买入后可能无法卖出；仍可下单，风险自担。" : (q.taxPct.map { String(format: "合约在转账时扣 %.1f%%，实际到手会少这一截。", $0) } ?? ""))
                    .font(.system(size: 10.5)).foregroundStyle(FM.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(FM.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }

    /// 网络费 > $1 的提示框（只在有 ok 报价时出现）
    private var feeWarning: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.square").font(.system(size: 14, weight: .semibold)).foregroundStyle(FM.orange).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text("网络费较高").font(.system(size: 11.5, weight: .bold)).foregroundStyle(FM.orange)
                Text("该链网络费用较高，由网络收取。").font(.system(size: 10.5)).foregroundStyle(FM.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(FM.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }

    /// 主按钮「买入 SYMBOL / 卖出 SYMBOL」：把当前这条报价（id 钉死，地址/链/方向/金额或百分比全对上）作为下单意图交给 sidecar。
    /// 可点条件全都得满足：ready · 报价 ok · 本地没判错 · 没在飞。点下去先本地锁（sent），不重复发
    private var action: some View {
        let q = liveQuote
        let enabled = state.ready && localError == nil && q?.ok == true && !executeLocked
        let title = executeLocked ? (trade?.status == "unknown" ? "结果未知 · 待核对" : inFlight ? "处理中…" : "已发送…")
                  : "\(side == "buy" ? "买入" : "卖出") \(t.symbol)"
        return Button {
            guard enabled, let q, sent == nil else { return }
            sent = Date()
            onTrade(q.address, q.chain, q.side, q.amount, q.pct, q.id)
        } label: {
            HStack(spacing: 6) {
                if executeLocked && trade?.status != "unknown" { ProgressView().controlSize(.mini) }
                Text(title).font(.system(size: 13, weight: .bold)).lineLimit(1)
            }
            .foregroundStyle(enabled ? FM.logoInk : FM.muted)
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(enabled ? FM.accent : FM.surface2, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain).clickable(radius: 12)
        .disabled(!enabled)
        .help(trade?.status == "unknown" ? "上一单结果未知，等 sidecar 对账；可在 dashboard 交易页核对"
              : quotePending ? "等报价…"
              : "本地 burner 钱包签名，经 OKX 路由")
    }

    private static func errorText(_ q: TradeQuote) -> String {
        switch q.error {
        case "min": return "最低 $" + fmt(q.minUsd)
        case "honeypot": return "疑似蜜罐"
        case let .some(e) where !e.isEmpty: return e
        default: return "暂无报价"
        }
    }

    /// 美元：<1000 两位小数（去掉多余的 0），再大用 K/M
    private static func fmt(_ v: Double) -> String {
        if v >= 1000 { return String(Fmt.compact(v).dropFirst()) }
        let s = String(format: "%.2f", v)
        return s.hasSuffix(".00") ? String(s.dropLast(3)) : s
    }
    /// 代币 / 原生币数量：大数 K/M，小数按量级留 2–6 位；卡头持仓区也用
    static func qty(_ v: Double) -> String {
        if v == 0 { return "0" }
        if v >= 1000 { return String(Fmt.compact(v).dropFirst()) }
        if v >= 1 { return String(format: "%.2f", v) }
        return String(format: v >= 0.01 ? "%.4f" : "%.6f", v)
    }
}

/// 右侧弹窗的根视图：原型 .popup 的入场动效（translateX(-24) scale(.94) + opacity）
struct PopupHost: View {
    // 阴影留白：必须盖住阴影可见范围（≈2×radius+offset），否则会被窗口边界硬裁出矩形
    static let padX: CGFloat = 32
    static let padTop: CGFloat = 24
    static let padBottom: CGFloat = 56

    let feed: Feed
    let onVisibility: (Bool) -> Void
    /// 卡片实际尺寸（不含留白）→ 控制器据此改窗口大小
    let onSize: (CGSize) -> Void

    var body: some View {
        // 面板拖动 / 改尺寸后 Feed.panelFrame 变 → 这里重算一次布局（PopupCard.layout 读窗口 frame，本身不响应式）
        let layout = feed.panelFrame.map(PopupCard.layout(panel:)) ?? PopupCard.layout
        ZStack(alignment: .topLeading) {
            if let t = feed.popup {
                PopupCard(t: t, auto: feed.popupAuto, now: feed.now, klines: feed.klines, context: feed.context?.address == t.address ? feed.context : nil, groups: feed.groupNames,
                          fomoState: feed.fomoState, tradeState: feed.tradeState, tradeQuote: feed.tradeQuote,
                          onTradeQuote: { feed.onTradeQuote?($0, $1, $2, $3, $4) }, onCancelTradeQuote: { feed.onCancelTradeQuote?() },
                          trade: feed.trades[t.address], onTrade: { feed.onTrade?($0, $1, $2, $3, $4, $5) },
                          holding: feed.tradeHoldings.first(where: { $0.address == t.address && $0.chain == t.knownChain }),
                          gmgnCalls: feed.gmgnCalls, thesis: feed.fomoThesis,
                          onGmgnCallsMore: { feed.onGmgnCallsMore?($0) }, onThesisMore: { feed.onThesisMore?($0) },
                          onKline: { feed.onKline?($0) }, onContext: { feed.onContext?($0, $1, $2, $3) }, onClose: { feed.dismissPopup() }, layout: layout)
                    .frame(width: layout.width)
                    .background(GeometryReader { g in Color.clear.preference(key: CardSizeKey.self, value: g.size) })
                    // 身份 = 链 + 地址：同一 0x 地址在两条链上都持有时切链也得像换币一样重建卡（swap 卡 @State 金额 / 方向、报价 task 全部归零）
                    .id(t.chain + ":" + t.address)
                    .transition(.asymmetric(
                        insertion: .offset(x: -24).combined(with: .scale(scale: 0.94, anchor: .leading)).combined(with: .opacity),
                        removal: .opacity))
            }
        }
        .padding(.horizontal, Self.padX).padding(.top, Self.padTop).padding(.bottom, Self.padBottom)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // 入场 / 换币动画只按地址：新币自动弹卡的链在 ~0.5s 后才从 "?" 变成真链，`.id` 会重建卡（K 线 / swap 卡状态归零是对的），但不该再播一遍入场动画
        .animation(.spring(response: 0.5, dampingFraction: 0.75), value: feed.popup?.address)
        // 语境晚到（80ms 兜底后）/ 点 K 线标记换语境时行数变化：平滑长高而不是瞬跳；推特卡从「加载中…」换成资料/推文卡同理
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: feed.context?.ts)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: feed.popup?.profile?.screen ?? feed.popup?.official.first?.id)
        .onChange(of: feed.popup != nil) { _, visible in onVisibility(visible) }
        .onPreferenceChange(CardSizeKey.self) { s in if s.height > 0 { onSize(s) } }
    }
}

/// 左列自然高度上报（PopupCard 决定要不要整列滚动）
private struct LeftHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private extension View {
    /// 把自己的实际高度经 preference 报给上层（不改布局）
    func measured<K: PreferenceKey>(_ key: K.Type) -> some View where K.Value == CGFloat {
        background(GeometryReader { g in Color.clear.preference(key: key, value: g.size.height) })
    }
}

private struct CardSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let n = nextValue()
        value = CGSize(width: max(value.width, n.width), height: max(value.height, n.height))
    }
}

// MARK: - 主面板

struct PanelView: View {
    let feed: Feed
    /// 调试入口（底栏「＋」模拟喊单）只在 FOMOMO_DEBUG=1 时显示，避免假记录混进真实列表
    static let debug = ProcessInfo.processInfo.environment["FOMOMO_DEBUG"] == "1"
    nonisolated static let shape = UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: 22, topTrailingRadius: 22, style: .continuous)

    /// 搜索框内容（symbol / 名称 / 合约地址，不分大小写、子串匹配）；空 = 不过滤
    @State private var query = ""
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    /// 列表实际显示的代币：按搜索过滤；排序不变
    private var shown: [Token] {
        let q = trimmedQuery
        if q.isEmpty { return feed.tokens }
        return feed.tokens.filter { t in
            t.symbol.lowercased().contains(q) || (t.market?.name?.lowercased().contains(q) ?? false) || t.address.lowercased().contains(q)
        }
    }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                header
                search
                columns
                list
                if feed.tradeState.ready { holdings(cap: max(HoldingRowView.height * 2, geo.size.height * 0.3)) }
                footer
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .background(GlassBackground(opacity: feed.panelBackgroundOpacity))
        // 灵动岛式：贴着屏幕左缘长出来，只有右侧两个圆角
        .clipShape(Self.shape)
        .overlay(Self.shape.strokeBorder(FM.hair))
        // 点面板空白处（非行、非按钮）关弹卡；行的 onTapGesture 在内层先吃掉事件
        .contentShape(Rectangle())
        .onTapGesture { feed.dismissPopup() }
        // 阴影由 NSPanel.hasShadow 画在窗口外；SwiftUI .shadow 会被窗口边界硬裁出矩形
    }

    /// 头部下方一行搜索框：筛名字（symbol / 全名）和 CA；Esc / × 清空。主面板窗口为此开了 key 资格（OverlayPanel.makePanel）
    private var search: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 10, weight: .semibold)).foregroundStyle(FM.faint)
            TextField("搜索代币名 / CA", text: $query, prompt: Text("搜索代币名 / CA").foregroundColor(FM.faint))
                .textFieldStyle(.plain).font(.system(size: 11.5)).foregroundStyle(FM.ink)
                .environment(\.colorScheme, .dark)
                .onExitCommand { query = "" }
            if !trimmedQuery.isEmpty {
                Text("\(shown.count)/\(feed.tokens.count)").font(.system(size: 9.5, design: .monospaced)).monospacedDigit().foregroundStyle(FM.muted)
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(FM.muted).padding(2).contentShape(Rectangle())
                }
                .buttonStyle(.plain).clickable().help("清空搜索")
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(FM.surface2, in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 10).padding(.vertical, 7)
        .overlay(Hairline(), alignment: .bottom)
    }

    /// 展开了行内快捷交易的那一行（`TradeHolding.id` = chain:address）；一次只展开一行。只由该行 ⚡ 切换，弹卡开关 / 面板空白点击都不动它；
    /// 收起再展开不丢下单状态——状态在 `Feed.trades` 里，不在行里
    @State private var expandedHolding: String?

    /// 代币列表下方、分隔线隔开的「持仓」区（钱包 + OKX 就绪 `tradeState.ready` 后才有）：高度 = min(内容, 面板高 30%)，超出在区内滚动，
    /// 上面的代币列表在最小尺寸（300 高）下仍留得住几行；有行展开时下限抬到能放下一整个展开行。行数据 = sidecar `trade_holdings`（含监听列表之外的币），
    /// 只是**显示**时过滤掉价值 < $2 的碎屑（usd 未知的不算碎屑，照显）；`feed.tradeHoldings` 本身保持完整，弹卡 / 卖出刷新照旧。
    /// 例外：`feed.quickTradeHoldings` 里正在一键交易 / 刚落定的行照显（全卖后快照把它拿掉、或跌成碎屑时，状态反馈不能跟着消失），快照里还有就用快照那份（现值实时）
    private func holdings(cap: CGFloat) -> some View {
        let retained = feed.quickTradeHoldings
        var rows = feed.tradeHoldings.filter { ($0.usd ?? .infinity) >= 2 || retained[$0.id] != nil }
        let hidden = feed.tradeHoldings.count - rows.count
        let live = Set(feed.tradeHoldings.map(\.id))
        rows += retained.values.filter { !live.contains($0.id) }
        rows.sort { ($0.usd ?? 0) > ($1.usd ?? 0) }
        let expanded = expandedHolding.flatMap { id in rows.contains { $0.id == id } ? id : nil }
        let content = CGFloat(rows.count) * (HoldingRowView.height + 2) + 4 + (expanded == nil ? 0 : HoldingRowView.expandedExtra)
        let cap = expanded == nil ? cap : max(cap, HoldingRowView.height + HoldingRowView.expandedExtra + 4)
        return VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("持仓").tracking(0.6)
                Text("\(rows.count)").foregroundStyle(FM.muted)
                Spacer()
                if let at = feed.tradeHoldingsAt { Text(Fmt.agoShort(at, now: feed.now) + "前").help("持仓快照时间") }
            }
            .font(.system(size: 9, weight: .semibold)).foregroundStyle(FM.faint)
            .padding(.horizontal, 14).padding(.vertical, 6)
            if rows.isEmpty {
                Text(feed.tradeHoldingsAt == nil ? "读取持仓…" : hidden > 0 ? "暂无 ≥ $2 持仓（已隐藏 \(hidden) 个碎屑）" : "暂无持仓")
                    .font(.system(size: 10.5)).foregroundStyle(FM.faint)
                    .frame(maxWidth: .infinity).padding(.bottom, 8)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(spacing: 2) {
                            ForEach(rows) { h in
                                HoldingRowView(h: h, now: feed.now, state: feed.tradeState, linkConnected: feed.link == .connected,
                                               trade: feed.trades[h.address], expanded: expanded == h.id,
                                               onToggle: { expandedHolding = expandedHolding == h.id ? nil : h.id },
                                               onOpen: { feed.openHolding(h) },
                                               onQuickTrade: { side, amount, pct in feed.quickTrade(h, side: side, amount: amount, pct: pct) })
                                    .id(h.id)
                            }
                        }
                        .padding(.horizontal, 6).padding(.bottom, 4)
                    }
                    .frame(height: min(cap, content))
                    .onChange(of: expanded) { _, id in
                        if let id { withAnimation(.easeOut(duration: 0.16)) { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                    .onChange(of: cap) { _, _ in
                        if let expanded { proxy.scrollTo(expanded, anchor: .bottom) }
                    }
                }
            }
        }
        .overlay(Hairline(), alignment: .top)
    }

    private var header: some View {
        HStack {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(LinearGradient(colors: [FM.accent, FM.accentDim], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 30, height: 30)
                    .overlay(Text("f").font(.system(size: 16, weight: .bold)).foregroundStyle(FM.logoInk))
                VStack(alignment: .leading, spacing: 2) {
                    Text("fomomo").font(.system(size: 15, weight: .semibold))
                    HStack(spacing: 5) {
                        Circle().fill(feed.link == .connected ? FM.accent : FM.amber).frame(width: 6, height: 6)
                        HStack(spacing: 0) {
                            Text("监听 \(feed.groupName) · ").foregroundStyle(FM.muted)
                            Text("\(feed.tokens.count)").foregroundStyle(FM.accent)
                            Text(" 代币").foregroundStyle(FM.muted)
                        }.lineLimit(1)
                    }.font(.system(size: 10.5))
                }
            }
            Spacer()
            if feed.link == .connected { Equalizer() }
        }
        .foregroundStyle(FM.ink)
        .padding(.horizontal, 14).padding(.top, 13).padding(.bottom, 11)
        .overlay(Hairline(), alignment: .bottom)
    }

    private var columns: some View {
        HStack {
            Text("代币 / KOL").frame(maxWidth: .infinity, alignment: .leading)
            Text("走势").frame(width: 54, alignment: .center)
            Text("MC / 喊后").frame(width: 64, alignment: .trailing)
        }
        .font(.system(size: 9, weight: .semibold)).tracking(0.6)
        .foregroundStyle(FM.faint)
        .padding(.horizontal, 14).padding(.vertical, 7)
        .overlay(Hairline(), alignment: .bottom)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 3) {
                if shown.isEmpty {
                    if feed.tokens.isEmpty && feed.link == .connected && feed.sourcesConfigured == false {
                        // 首次启动：一个群来源都没配，空列表永远不会有东西，直接给去设置的入口（样式同底栏按钮）
                        Button { feed.onOpenDashboard?("groups") } label: {
                            Text("还没配置微信 / 飞书群来源 · 去设置").lineLimit(1)
                                .padding(.horizontal, 5).padding(.vertical, 3).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).clickable().font(.system(size: 11)).foregroundStyle(FM.faint)
                        .frame(maxWidth: .infinity).padding(.top, 40)
                    } else {
                        Text(feed.tokens.isEmpty ? (feed.link == .connected ? "等待群里出现合约地址…" : feed.link.label) : "没有匹配「\(query.trimmingCharacters(in: .whitespaces))」的代币")
                            .font(.system(size: 11)).foregroundStyle(FM.faint)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                ForEach(shown) { t in
                    TokenRowView(t: t, fresh: feed.freshID == t.address, now: feed.now, onTap: { feed.openDetail(t) },
                                 onVisible: { feed.rowVisible(t.address, $0) })
                        .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                }
            }
            .padding(6)
            .animation(.spring(response: 0.5, dampingFraction: 0.8), value: shown.map(\.address))
        }
        .frame(maxHeight: .infinity)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(linkColor).frame(width: 6, height: 6)
                Text(feed.link.label).lineLimit(1)
            }
            Spacer()
            // `.plain` Button 只按 label 的实际绘制内容命中：10pt 图标外那圈 padding 点了不算（实测命中区仅 10×8pt），
            // 点空了就落到 PanelView 的 onTapGesture（关弹卡）——「设置有时要点两下」的根源。contentShape 必须放在 label 里，
            // Clickable 加在 Button 外面的那份对 Button 自己的手势不起作用。
            Button { feed.onCollapse?() } label: { Image(systemName: "chevron.left.2").font(.system(size: 10)).padding(4).contentShape(Rectangle()) }
                .clickable().help("收起到状态栏")
            if feed.dashboardURL != nil {
                // 24h 战况：窗口内全部喊单的结构与收益（图表在 dashboard，悬浮窗太窄画不下）
                Button { feed.onOpenDashboard?("battle") } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chart.bar.xaxis").font(.system(size: 10))
                        Text("24h").lineLimit(1)
                    }.padding(.horizontal, 5).padding(.vertical, 3).contentShape(Rectangle())
                }
                .clickable().help("24h 战况：全部喊单的结构、单个与总体收益")
                Button { feed.onOpenDashboard?(nil) } label: {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 10)).padding(4).contentShape(Rectangle())
                }
                .clickable().help("设置 / 群组 / 统计")
            }
            Button { feed.onOpenGmgn?() } label: {
                HStack(spacing: 4) {
                    Circle().fill(feed.gmgn.ok ? FM.accent : (feed.gmgn == .loading ? FM.amber : FM.down)).frame(width: 5, height: 5)
                    Text(feed.gmgn.ok ? "gmgn" : feed.gmgn.label).lineLimit(1)
                }.padding(.horizontal, 5).padding(.vertical, 3).contentShape(Rectangle())
            }
            .clickable().help(feed.gmgn.label + "（点击打开 gmgn 窗口）")
            if PanelView.debug {
                Button("＋") { feed.onSimulate?() }.clickable().help("调试：模拟一条喊单（FOMOMO_DEBUG=1 时显示）")
            }
        }
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(FM.muted)
        .buttonStyle(.plain)
        .padding(.horizontal, 14).padding(.vertical, 9)
        .overlay(Hairline(), alignment: .top)
    }

    private var linkColor: Color {
        switch feed.link {
        case .connected: FM.accent
        case .connecting, .reconnecting: FM.amber
        case .failed: FM.down
        }
    }
}
