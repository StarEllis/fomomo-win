import AppKit
import SwiftUI

/// 一根蜡烛（sidecar `kline` 事件；o/h/l/c 是市值 USD，不是单价）
struct Bar: Equatable {
    let t: Double, o: Double, h: Double, l: Double, c: Double, v: Double
}

/// 来源群和精确时刻共同标识喊单，不能把同秒的不同群消息当作同一个标记。
struct CallMark: Equatable {
    let t: Double
    let sender: String
    let group: String
}

struct Kline: Equatable {
    let address: String
    /// sidecar 实际按哪条链拉的（同一 0x 地址两条链都持有时区分）
    let chain: String
    let resolution: String
    let bars: [Bar]
    /// sidecar 实际拉取过的范围（覆盖判断用它，不用首末根：没成交的时段没蜡烛）
    let covered: (from: Double, to: Double)
    let calls: [CallMark]
    /// 拉取失败原因（bars 为空时画成失败而不是一直「加载中」）；nil = 正常，空 bars 就是没成交
    let error: String?

    static func == (a: Kline, b: Kline) -> Bool {
        a.address == b.address && a.chain == b.chain && a.resolution == b.resolution && a.bars.count == b.bars.count && a.bars.last == b.bars.last
            && a.bars.first == b.bars.first && a.covered == b.covered && a.calls == b.calls && a.error == b.error
    }
    /// 弹卡上的分辨率按钮（gmgn 同款一排）
    static let choices = ["1s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"]
    static let stepSec: [String: Double] = ["1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400]
    var step: Double { Self.stepSec[resolution] ?? 60 }

    /// 实时成交推来的一根：同 t 替换，否则追加（sidecar 只会推末端）
    func merging(_ b: Bar) -> Kline {
        var bs = bars
        if let l = bs.last, l.t == b.t { bs[bs.count - 1] = b } else if (bs.last?.t ?? -1) < b.t { bs.append(b) } else { return self }
        return Kline(address: address, chain: chain, resolution: resolution, bars: bs, covered: (covered.from, max(covered.to, b.t + step)), calls: calls, error: error)
    }
}

/// K 线请求（分辨率来自弹卡按钮，时间窗来自可见范围；sidecar 按 address + chain 分页拉 gmgn 蜡烛；chain 未知为 nil，sidecar 自己推）
struct KlineRequest: Equatable {
    let address: String
    let chain: String?
    let resolution: String
    let from: Double
    let to: Double
}

/// 当前持仓的买 / 卖均价落到市值轴上的位置（K 线 o/h/l/c 是市值，不是单价）：`mc = 均价 × market.mc / market.price`，mc 与 price 必须来自**同一份** market，
/// 不拿持仓行的现价去配详情的市值。只有本地账本给了买 / 卖均价（`TradeHolding.tradePrices`，没成交过为 nil）、amount > 0、market 的 mc / price 都是有限正数才有；哪一侧算不出就没那一侧
struct PositionLevels: Equatable {
    struct Level: Equatable { let price: Double; let mc: Double }
    let buy: Level?
    let sell: Level?

    init?(holding: TradeHolding?, market: Market?) {
        guard let h = holding, h.amount > 0, let tp = h.tradePrices,
              let mc = market?.mc, let px = market?.price, mc.isFinite, px.isFinite, mc > 0, px > 0 else { return nil }
        func level(_ p: Double?) -> Level? {
            guard let p, p.isFinite, p > 0 else { return nil }
            let m = p * mc / px
            return m.isFinite && m > 0 ? Level(price: p, mc: m) : nil
        }
        buy = level(tp.buy)
        sell = level(tp.sell)
        if buy == nil && sell == nil { return nil }
    }

    /// 画图 / 无障碍共用的两条线（买绿卖红），只有实际存在的那几条
    var lines: [(name: String, level: Level, isBuy: Bool)] {
        var out: [(name: String, level: Level, isBuy: Bool)] = []
        if let b = buy { out.append(("买入均价", b, true)) }
        if let s = sell { out.append(("卖出均价", s, false)) }
        return out
    }
    static func label(_ name: String, _ l: Level) -> String { "\(name) \(Fmt.price(l.price)) · 市值 \(Fmt.compact(l.mc))" }
    var summary: String { lines.map { Self.label($0.name, $0.level) }.joined(separator: "；") }
}

/// 蜡烛图（AppKit 自绘）：分辨率由外面的按钮定（gmgn 同款），滚轮/捏合以光标为中心缩放，横向滚动/拖动平移，双击复位，悬停十字线。
/// 基准线 = 首次喊单 MC；喊单标记（喊单人首字）贴在所在蜡烛 low 下方，叠住时往下堆。底部 18% 画成交量。
/// 可见范围变化 → onRange(t0, t1) 由外层决定要不要补数据。
final class CandleChartNSView: NSView {
    /// 各分辨率缓存（同一代币），只画 `resolution` 那档；切回来时立刻有图
    var klines: [String: Kline] = [:] { didSet { fitToData(); needsDisplay = true } }
    var resolution = "1m" { didSet { if oldValue != resolution { resetRange() } } }
    /// 用户还没动过视图（默认范围）：数据到了发现代币比默认窗口年轻，就把左边空白收掉
    private var untouched = true
    /// 右端贴着"现在"时随时间前进（gmgn 同款）；往左翻历史就停
    private var follow = true
    private var clock: Timer?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        clock?.invalidate()
        clock = window == nil ? nil : Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
    }

    private var lastTick = Date().timeIntervalSince1970
    private func tick() {
        let now = Date().timeIntervalSince1970
        let dt = now - lastTick
        lastTick = now
        guard follow, dt > 0 else { return }
        t0 += dt; t1 += dt
        needsDisplay = true
        // 最新一根靠近右缘时提前把区间要到（sidecar 只会推已缓存范围的末端）
        if let k = current, k.covered.to < t1 - step { onRange?(t0, t1) }
    }

    private func fitToData() {
        guard untouched, let k = current, let f = k.bars.first, k.covered.from <= t0, f.t > t0 + (t1 - t0) * 0.3 else { return }
        t0 = f.t - 2 * step
    }
    var calls: [CallMark] { klines.values.first?.calls ?? [] }
    private var current: Kline? { klines[resolution] }
    var step: Double { Kline.stepSec[resolution] ?? 60 }

    /// 首次喊单时刻：可见范围默认从这里开始
    var firstCall: Double = 0
    var onRange: ((Double, Double) -> Void)?
    /// 点了某个喊单标记 → (时刻, 喊单人, 来源群)
    var onCallTap: ((Double, String, String) -> Void)?
    /// 当前展示语境的那次喊单（外面按 context 事件喂进来），标记画成实心
    var selectedCall: CallMark? { didSet { if oldValue != selectedCall { needsDisplay = true } } }
    /// 我的持仓买 / 卖均价（已换算到市值轴）；nil = 没持仓 / 未登录 / 换算不出，立刻不画
    var positions: PositionLevels? { didSet { if oldValue != positions { needsDisplay = true } } }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .image }
    override func accessibilityLabel() -> String? { positions.map { "市值 K 线 · " + $0.summary } ?? "市值 K 线" }

    private var t0: Double = 0, t1: Double = 1
    private var hover: CGPoint? = nil
    private var dragStart: (x: CGFloat, t0: Double, t1: Double)?
    private var tracking: NSTrackingArea?
    private let padL: CGFloat = 8, padR: CGFloat = 60, padT: CGFloat = 10, padB: CGFloat = 22
    private let volFrac: CGFloat = 0.18
    private static let up = NSColor(red: 0x3d/255, green: 0xdc/255, blue: 0x84/255, alpha: 1)
    private static let down = NSColor(red: 1, green: 0x5b/255, blue: 0x5b/255, alpha: 1)

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let a = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(a)
        tracking = a
        super.updateTrackingAreas()
    }

    /// 默认可见：最近 ~80 根到现在；首次喊单在这个窗口附近（≤ 240 根前）就从喊单前 5 根开始，喊后走势一眼看全
    func resetRange() {
        let now = Date().timeIntervalSince1970
        var start = now - 80 * step
        if firstCall > 0, now - firstCall <= 240 * step { start = min(start, firstCall - 5 * step) }
        t0 = start
        t1 = now + max((now - start) * 0.03, 2 * step)
        untouched = true
        follow = true
        lastTick = now
        fitToData()
        needsDisplay = true
        onRange?(t0, t1)
    }

    private var plot: CGRect { CGRect(x: padL, y: padT, width: bounds.width - padL - padR, height: bounds.height - padT - padB) }
    private var priceRect: CGRect { let p = plot; return CGRect(x: p.minX, y: p.minY, width: p.width, height: p.height * (1 - volFrac) - 4) }
    private var volRect: CGRect { let p = plot; return CGRect(x: p.minX, y: p.maxY - p.height * volFrac, width: p.width, height: p.height * volFrac) }

    private func x(_ t: Double) -> CGFloat { plot.minX + CGFloat((t - t0) / max(t1 - t0, 1)) * plot.width }
    private func t(atX px: CGFloat) -> Double { t0 + Double((px - plot.minX) / max(plot.width, 1)) * (t1 - t0) }

    // MARK: 交互

    override func scrollWheel(with e: NSEvent) {
        let dx = e.scrollingDeltaX, dy = e.scrollingDeltaY
        if abs(dx) > abs(dy) { pan(byPixels: dx) } else if dy != 0 { zoom(factor: exp(-dy * 0.01), at: convert(e.locationInWindow, from: nil).x) }
    }
    override func magnify(with e: NSEvent) { zoom(factor: 1 / (1 + e.magnification), at: convert(e.locationInWindow, from: nil).x) }
    override func mouseDown(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        // 点到喊单标记：切换选中 + 要这一次喊单的语境；不进入拖动
        if let hit = bubbleRects().first(where: { $0.rect.insetBy(dx: -3, dy: -3).contains(p) }) {
            selectedCall = hit.call
            needsDisplay = true
            onCallTap?(hit.call.t, hit.call.sender, hit.call.group)
            return
        }
        if e.clickCount == 2 { resetRange(); return }
        dragStart = (p.x, t0, t1)
    }
    override func mouseDragged(with e: NSEvent) {
        guard let d = dragStart else { return }
        let dt = Double((convert(e.locationInWindow, from: nil).x - d.x) / max(plot.width, 1)) * (d.t1 - d.t0)
        t0 = d.t0 - dt; t1 = d.t1 - dt
        rangeChanged()
    }
    override func mouseUp(with e: NSEvent) { dragStart = nil }
    override func mouseMoved(with e: NSEvent) {
        hover = convert(e.locationInWindow, from: nil)
        if let h = hover, bubbleRects().contains(where: { $0.rect.insetBy(dx: -3, dy: -3).contains(h) }) { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
        needsDisplay = true
    }
    override func mouseExited(with e: NSEvent) { hover = nil; needsDisplay = true }

    private func pan(byPixels dx: CGFloat) {
        let dt = Double(dx / max(plot.width, 1)) * (t1 - t0)
        t0 -= dt; t1 -= dt
        rangeChanged()
    }
    private func zoom(factor: Double, at px: CGFloat) {
        let anchor = t(atX: px)
        var span = (t1 - t0) * factor
        span = min(max(span, 12 * step), 400 * step)   // 蜡烛别细到看不见 / 粗到一屏几根
        let ratio = (anchor - t0) / max(t1 - t0, 1)
        t0 = anchor - span * ratio
        t1 = t0 + span
        rangeChanged()
    }
    private func rangeChanged() {
        untouched = false
        let now = Date().timeIntervalSince1970
        let span = t1 - t0
        if t1 > now + span * 0.5 { t1 = now + span * 0.5; t0 = t1 - span }
        follow = t1 >= now
        lastTick = now
        needsDisplay = true
        onRange?(t0, t1)
    }

    // MARK: 绘制

    override func draw(_ dirty: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let step = self.step
        guard let k = current else { drawEmpty("加载 K 线…"); drawXAxis(ctx); return }
        // 可见范围左边还没拉到：gmgn 同款，先空着等数据；sidecar 报错就说失败，别一直「加载中」
        guard let s = scale() else {
            if let e = k.error, k.bars.isEmpty { drawEmpty("K 线拉取失败 · \(e)") }
            else { drawEmpty(k.covered.from > t1 || k.covered.to < t0 ? "加载 K 线…" : "此区间没有成交") }
            drawXAxis(ctx); return
        }
        let vis = s.vis, base = s.base, lo = s.lo, hi = s.hi
        let pr = priceRect, vr = volRect
        let y = s.y
        let vmax = max(vis.map(\.v).max() ?? 1, 1e-9)
        let grid = NSColor.white.withAlphaComponent(0.06)
        let faint = NSColor(red: 0x56/255, green: 0x5c/255, blue: 0x61/255, alpha: 1)
        let font = NSFont.monospacedSystemFont(ofSize: 9, weight: .regular)
        for i in 0...4 {
            let v = lo + (hi - lo) * Double(i) / 4
            let yy = y(v)
            ctx.setStrokeColor(grid.cgColor); ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: pr.minX, y: yy)); ctx.addLine(to: CGPoint(x: pr.maxX, y: yy)); ctx.strokePath()
            (Fmt.compact(v) as NSString).draw(at: CGPoint(x: pr.maxX + 6, y: yy - 6), withAttributes: [.font: font, .foregroundColor: faint])
        }
        drawXAxis(ctx)

        // 基准线（首次喊单 MC）
        if let b = base {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.2).cgColor)
            ctx.setLineDash(phase: 0, lengths: [3, 3])
            ctx.move(to: CGPoint(x: pr.minX, y: y(b))); ctx.addLine(to: CGPoint(x: pr.maxX, y: y(b))); ctx.strokePath()
            ctx.setLineDash(phase: 0, lengths: [])
        }

        // 蜡烛 + 成交量
        let up = Self.up, down = Self.down
        let bw = max(1, CGFloat(step / max(t1 - t0, 1)) * plot.width)
        let body = max(1, bw * 0.7)
        ctx.saveGState(); ctx.clip(to: plot)
        for b in vis {
            let cx = x(b.t + step / 2)
            let col = b.c >= b.o ? up : down
            ctx.setStrokeColor(col.cgColor); ctx.setFillColor(col.cgColor); ctx.setLineWidth(max(1, min(1.5, body * 0.15)))
            ctx.move(to: CGPoint(x: cx, y: y(b.h))); ctx.addLine(to: CGPoint(x: cx, y: y(b.l))); ctx.strokePath()
            let top = y(max(b.o, b.c)), bot = y(min(b.o, b.c))
            ctx.fill(CGRect(x: cx - body / 2, y: top, width: body, height: max(1, bot - top)))
            let vh = CGFloat(b.v / vmax) * vr.height
            ctx.setFillColor(col.withAlphaComponent(0.35).cgColor)
            ctx.fill(CGRect(x: cx - body / 2, y: vr.maxY - vh, width: body, height: vh))
        }
        ctx.restoreGState()
        drawCalls(ctx, s)
        drawPositions(ctx, s)

        // 悬停
        if let h = hover, plot.contains(h), let near = vis.min(by: { abs(x($0.t + step / 2) - h.x) < abs(x($1.t + step / 2) - h.x) }) {
            let hx = x(near.t + step / 2)
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.25).cgColor); ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: hx, y: pr.minY)); ctx.addLine(to: CGPoint(x: hx, y: plot.maxY))
            ctx.move(to: CGPoint(x: pr.minX, y: h.y)); ctx.addLine(to: CGPoint(x: pr.maxX, y: h.y)); ctx.strokePath()
            let pct = base.map { (near.c / $0 - 1) * 100 }
            let df = DateFormatter(); df.dateFormat = step < 60 ? "HH:mm:ss" : "M/d HH:mm"
            let text = "O \(Fmt.compact(near.o))  H \(Fmt.compact(near.h))  L \(Fmt.compact(near.l))  C \(Fmt.compact(near.c))  \(pct.map { "喊后 " + Fmt.pct($0) } ?? "")  \(df.string(from: Date(timeIntervalSince1970: near.t)))" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor.white]
            let sz = text.size(withAttributes: attrs)
            let box = CGRect(x: min(max(plot.minX, hx - sz.width / 2 - 6), plot.maxX - sz.width - 12), y: plot.minY + 2, width: sz.width + 12, height: sz.height + 6)
            ctx.setFillColor(NSColor(red: 0x1a/255, green: 0x1b/255, blue: 0x1f/255, alpha: 0.96).cgColor)
            ctx.addPath(CGPath(roundedRect: box, cornerWidth: 5, cornerHeight: 5, transform: nil)); ctx.fillPath()
            text.draw(at: CGPoint(x: box.minX + 6, y: box.minY + 3), withAttributes: attrs)
        }
    }

    private func drawXAxis(_ ctx: CGContext) {
        let faint = NSColor(red: 0x56/255, green: 0x5c/255, blue: 0x61/255, alpha: 1)
        let font = NSFont.monospacedSystemFont(ofSize: 9, weight: .regular)
        let df = DateFormatter(); df.dateFormat = (t1 - t0) > 86400 * 2 ? "M/d HH:mm" : ((t1 - t0) < 600 ? "HH:mm:ss" : "HH:mm")
        for i in 0...4 {
            let tt = t0 + (t1 - t0) * Double(i) / 4
            let label = df.string(from: Date(timeIntervalSince1970: tt)) as NSString
            let w = label.size(withAttributes: [.font: font]).width
            label.draw(at: CGPoint(x: min(max(x(tt) - w / 2, plot.minX), plot.maxX - w), y: plot.maxY + 6), withAttributes: [.font: font, .foregroundColor: faint])
        }
    }

    /// 价格轴映射：可见蜡烛 + 基准（首次喊单 open）+ 值→像素 y。draw 与标记命中共用，避免两套标尺
    private struct Scale {
        let vis: [Bar], lo: Double, hi: Double, base: Double?, pr: CGRect
        func y(_ v: Double) -> CGFloat { pr.maxY - CGFloat((v - lo) / (hi - lo)) * pr.height }
    }
    private func scale() -> Scale? {
        guard let k = current else { return nil }
        let step = self.step
        let vis = k.bars.filter { $0.t + step >= t0 && $0.t <= t1 }
        guard !vis.isEmpty else { return nil }
        var lo = vis.map(\.l).min()!, hi = vis.map(\.h).max()!
        // 基准 = 首次喊单时刻的 open：当前档里喊单所在/之后第一根；当前档没拉到那么早就用最细的一档
        let baseSrc = k.covered.from <= firstCall ? k : klines.values.filter { $0.covered.from <= firstCall }.min { $0.step < $1.step }
        let base = baseSrc.flatMap { k in k.bars.first { $0.t + k.step > firstCall }?.o }
        if let b = base { lo = min(lo, b); hi = max(hi, b) }
        // 持仓均价线也得在轴上——不然线跑到图外看不见，或被夹到边上说假话
        for l in positions?.lines ?? [] { lo = min(lo, l.level.mc); hi = max(hi, l.level.mc) }
        let span = max(hi - lo, hi * 0.005, 1e-12)
        return Scale(vis: vis, lo: lo - span * 0.06, hi: hi + span * 0.06, base: base, pr: priceRect)
    }

    private let bubbleSize: CGFloat = 16

    /// 喊单标记：**贴在喊单所在那根蜡烛的 low 正下方**（6pt），可点击。选中的实心 accent，其余描边。
    /// 落在同一根/相邻根、会叠住的**往下堆叠**（一个气泡 + 2pt），不往右错；到 plot 底就夹住。没蜡烛可挂就不画。
    private func bubbleRects(_ s: Scale? = nil) -> [(rect: CGRect, call: CallMark)] {
        guard let s = s ?? scale() else { return [] }
        let step = self.step, d = bubbleSize
        var out: [(rect: CGRect, call: CallMark)] = []
        for c in calls.sorted(by: { $0.t < $1.t }) where c.t >= t0 && c.t <= t1 {
            // 喊单落在的那根蜡烛；没有（那一段没成交）就挂最近一根
            let bar = s.vis.first { $0.t <= c.t && c.t < $0.t + step } ?? s.vis.min { abs($0.t - c.t) < abs($1.t - c.t) }!
            var r = CGRect(x: x(bar.t + step / 2) - d / 2, y: s.y(bar.l) + 6, width: d, height: d)
            while out.contains(where: { abs($0.rect.midX - r.midX) < d && abs($0.rect.midY - r.midY) < d }) { r.origin.y += d + 2 }
            r.origin.y = min(r.origin.y, plot.maxY - d)
            out.append((r, c))
        }
        return out
    }

    private func drawCalls(_ ctx: CGContext, _ s: Scale) {
        let accent = NSColor(red: 0x24/255, green: 0xc4/255, blue: 0x7c/255, alpha: 1)
        for (bubble, c) in bubbleRects(s) {
            let selected = selectedCall == c
            // 标记底色：选中实心，未选中深底 + accent 描边
            if selected {
                ctx.setFillColor(accent.cgColor); ctx.fillEllipse(in: bubble)
            } else {
                ctx.setFillColor(NSColor(red: 0x14/255, green: 0x16/255, blue: 0x18/255, alpha: 1).cgColor); ctx.fillEllipse(in: bubble)
                ctx.setStrokeColor(accent.withAlphaComponent(0.8).cgColor); ctx.setLineWidth(1.2); ctx.strokeEllipse(in: bubble.insetBy(dx: 0.6, dy: 0.6))
            }
            let ch = String(c.sender.prefix(1)) as NSString
            let ink = selected ? NSColor(red: 0x04/255, green: 0x14/255, blue: 0x0c/255, alpha: 1) : accent
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 9, weight: .bold), .foregroundColor: ink]
            let sz = ch.size(withAttributes: attrs)
            ch.draw(at: CGPoint(x: bubble.midX - sz.width / 2, y: bubble.midY - sz.height / 2), withAttributes: attrs)
        }
    }

    /// 持仓买 / 卖均价：细虚线（买绿卖红）画在**真实 y**，标签贴 plot 左缘（右边是最新蜡烛，别挡）。两条挨得太近时标签往下（放不下就往上）错开，
    /// 标签左侧画一段实线引回真实 y；标签始终留在价格区内
    private func drawPositions(_ ctx: CGContext, _ s: Scale) {
        guard let p = positions else { return }
        let pr = priceRect
        let font = NSFont.monospacedSystemFont(ofSize: 9, weight: .medium)
        var boxes: [CGRect] = []
        ctx.saveGState(); ctx.clip(to: plot)
        for line in p.lines {
            let col = line.isBuy ? Self.up : Self.down
            let yy = s.y(line.level.mc)
            ctx.setStrokeColor(col.withAlphaComponent(0.85).cgColor); ctx.setLineWidth(1)
            ctx.setLineDash(phase: 0, lengths: [4, 3])
            ctx.move(to: CGPoint(x: pr.minX, y: yy)); ctx.addLine(to: CGPoint(x: pr.maxX, y: yy)); ctx.strokePath()
            ctx.setLineDash(phase: 0, lengths: [])

            let text = PositionLevels.label(line.name, line.level) as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: col]
            let sz = text.size(withAttributes: attrs)
            var box = CGRect(x: pr.minX + 6, y: yy - sz.height / 2 - 2, width: sz.width + 8, height: sz.height + 4)
            if let o = boxes.first(where: { $0.intersects(box) }) {
                box.origin.y = o.maxY + 2 + box.height <= pr.maxY ? o.maxY + 2 : o.minY - 2 - box.height
            }
            box.origin.y = min(max(box.origin.y, pr.minY), pr.maxY - box.height)
            boxes.append(box)
            if abs(box.midY - yy) > 1 {
                ctx.setStrokeColor(col.withAlphaComponent(0.7).cgColor)
                ctx.move(to: CGPoint(x: pr.minX + 3, y: yy)); ctx.addLine(to: CGPoint(x: pr.minX + 3, y: box.midY))
                ctx.addLine(to: CGPoint(x: box.minX, y: box.midY)); ctx.strokePath()
            }
            ctx.setFillColor(NSColor(red: 0x1a/255, green: 0x1b/255, blue: 0x1f/255, alpha: 0.92).cgColor)
            ctx.addPath(CGPath(roundedRect: box, cornerWidth: 3, cornerHeight: 3, transform: nil)); ctx.fillPath()
            text.draw(at: CGPoint(x: box.minX + 4, y: box.minY + 2), withAttributes: attrs)
        }
        ctx.restoreGState()
    }

    private func drawEmpty(_ msg: String) {
        let s = msg as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor(white: 1, alpha: 0.3)]
        let sz = s.size(withAttributes: attrs)
        s.draw(at: CGPoint(x: bounds.midX - sz.width / 2, y: bounds.midY - sz.height / 2), withAttributes: attrs)
    }
}

/// SwiftUI 包装：分辨率来自弹卡按钮；可见范围变化 → 防抖后按当前分辨率发 kline 请求。身份 = address + chain
struct CandleChart: NSViewRepresentable {
    let klines: [String: Kline]
    let address: String
    let chain: String?
    let firstCall: Double
    let resolution: String
    /// 当前语境对应的喊单（来源群、发送者、精确时刻）。
    let selectedCall: CallMark?
    /// 我的持仓买 / 卖均价（PopupCard 按 address + 链精确对上持仓、用同一份 market 换算；nil 就不画）
    let positions: PositionLevels?
    let onRequest: (KlineRequest) -> Void
    let onCallTap: (Double, String, String) -> Void

    final class Coordinator {
        var debounce: Task<Void, Never>?
        var last: KlineRequest?
        var identity = ""
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    private var identity: String { (chain ?? "?") + ":" + address }

    func makeNSView(context: Context) -> CandleChartNSView {
        let v = CandleChartNSView()
        v.firstCall = firstCall
        v.onRange = { t0, t1 in Self.request(t0: t0, t1: t1, context: context, address: address, chain: chain, resolution: resolution, onRequest: onRequest) }
        context.coordinator.identity = identity
        v.resolution = resolution
        v.selectedCall = selectedCall
        v.positions = positions
        v.onCallTap = onCallTap
        v.resetRange()
        return v
    }

    func updateNSView(_ v: CandleChartNSView, context: Context) {
        v.firstCall = firstCall
        v.onRange = { t0, t1 in Self.request(t0: t0, t1: t1, context: context, address: address, chain: chain, resolution: resolution, onRequest: onRequest) }
        if context.coordinator.identity != identity {
            context.coordinator.identity = identity
            context.coordinator.last = nil
            v.klines = [:]
            v.resolution = resolution
            v.resetRange()
        } else if v.resolution != resolution {
            context.coordinator.last = nil
            v.resolution = resolution   // didSet → resetRange → 请求新分辨率
        }
        if v.klines != klines { v.klines = klines }
        v.selectedCall = selectedCall
        v.positions = positions
        v.onCallTap = onCallTap
    }

    private static func request(t0: Double, t1: Double, context: Context, address: String, chain: String?, resolution: String, onRequest: @escaping (KlineRequest) -> Void) {
        let step = Kline.stepSec[resolution] ?? 60
        // 多要一屏，减少平移时的重复请求
        let req = KlineRequest(address: address, chain: chain, resolution: resolution, from: floor((t0 - (t1 - t0)) / step) * step, to: min(Date().timeIntervalSince1970, t1 + step))
        let c = context.coordinator
        if let l = c.last, l.resolution == req.resolution, l.from <= req.from, l.to >= req.to - step { return }
        c.debounce?.cancel()
        // 第一次（弹卡刚开 / 刚切分辨率）立刻发，别白等 250ms；之后平移缩放中的连发才防抖
        if c.last == nil {
            c.last = req
            onRequest(req)
            return
        }
        c.debounce = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            c.last = req
            onRequest(req)
        }
    }
}
