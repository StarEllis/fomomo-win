import AppKit
import SwiftUI

// CoreGraphics 私有符号（见 OverlayPanelController.cursorInBackground）
@_silgen_name("_CGSDefaultConnection") private func CGSDefaultConnection() -> Int32
@_silgen_name("CGSSetConnectionProperty") private func CGSSetConnectionProperty(_ cid: Int32, _ target: Int32, _ key: CFString, _ value: CFTypeRef) -> Int32

/// 左侧常驻浮窗：无边框、不抢焦点、置顶、跨所有 Space。
/// 参考 open-vibe-island 的 NotchPanel 配置。
/// 弹出详情卡是主面板右侧的子窗口（原型 .popup：left = 面板右缘 + 10，top = 面板顶 + 50），高度随内容变。
@MainActor
final class OverlayPanelController {
    private let feed = Feed()
    private let gmgn = GmgnBridge()
    private let sidecar: Sidecar
    private var panel: NSPanel!
    private var popup: NSPanel!
    private var dashboard: DashboardWindow?

    private var panelSize = PanelSize(width: 326, height: 592)
    private let sizeStore = PanelSizeStore()
    private let popupGap: CGFloat = 10
    private let popupDrop: CGFloat = 50
    /// 弹卡窗口尺寸 = 卡片尺寸 + 留白，跟内容走
    private var popupSize = CGSize(width: PopupCard.layout.width + PopupHost.padX * 2, height: 480)
    private var clickMonitors: [Any] = []
    private var dragMonitor: Any?
    private var drag = PanelDrag()
    private var resize = PanelResize()
    /// 用户拖过面板后不再自动贴边（reposition 只在启动/改尺寸时调用，但保留用户挪的位置）
    private var userMoved = false
    /// 首启（sidecar 说这台机器第一次跑）或「群来源未配置」自动弹一次 dashboard 群组页；之后用户关了就不再骚扰（本进程内只一次）
    private var didAutoOpenSetup = false

    init() {
        sidecar = Sidecar(feed: feed, gmgn: gmgn)
        gmgn.onState = { [weak feed] s in feed?.gmgn = s }
        feed.onOpenGmgn = { [weak gmgn] in gmgn?.showWindow() }
        feed.onOpenDashboard = { [weak self] tab in self?.showDashboard(tab: tab) }
        sidecar.onPanelSize = { [weak self] s in self?.apply(panelSize: s) }
        sidecar.onPanelBackgroundOpacity = { [weak feed] v in feed?.panelBackgroundOpacity = v }
        feed.onCollapse = { [weak self] in self?.setCollapsed(true) }
        feed.onSources = { [weak self] configured, firstRun in
            guard let self, firstRun || !configured, !self.didAutoOpenSetup else { return }
            self.didAutoOpenSetup = true
            self.showDashboard(tab: "groups")
        }

        // 主面板：窗口即面板，阴影交给 AppKit（按内容 alpha 描形，不会被窗口边界裁切）
        let host = NSHostingView(rootView: PanelView(feed: feed))
        host.sizingOptions = []   // 别让 SwiftUI 的固有尺寸钉死窗口：尺寸由用户拖边缘 / 设置决定
        // 改尺寸不靠 AppKit 的 borderless+.resizable 抓边（后台 nonactivating 面板上命中区 / 光标都不可控、没法验证），
        // 自己铺一层边缘命中面：右 / 上 / 下边 + 右侧两角，悬停出改尺寸光标，按住拖就是改尺寸；规则在 `PanelResize`
        let edge = ResizeEdgeView(host: host)
        panel = Self.makePanel(edge, size: NSSize(width: panelSize.width, height: panelSize.height), lockLeft: true)
        panel.hasShadow = true
        edge.onBegin = { [weak self] edges, mouse in
            guard let self else { return }
            self.resize.begin(edges, mouse: mouse, frame: self.panel.frame)
        }
        edge.onDrag = { [weak self] mouse in self?.resizeDragged(to: mouse) }
        edge.onEnd = { [weak self] in
            guard let self, self.resize.end() else { return }
            self.resizeEnded()
        }
        // 不用系统的背景拖动：那是 WindowServer 在拖，x 会跟着鼠标走、放手才被 constrainFrameRect 吸回。
        // 自己接鼠标事件逐帧 setFrameOrigin，x 永远钉在屏幕左缘，拖动过程中就只上下动。
        panel.isMovableByWindowBackground = false
        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] e in
            self?.handleDrag(e)
            return e
        }

        // 弹窗：阴影用 SwiftUI 画，窗口内留够阴影范围；尺寸跟内容走
        popup = Self.makePanel(NSHostingView(rootView: PopupHost(feed: feed,
                                                               onVisibility: { [weak self] visible in self?.popupVisibility(visible) },
                                                               onSize: { [weak self] s in self?.resizePopup(card: s) })),
                          size: popupSize)
        popup.ignoresMouseEvents = true   // 无内容时点击穿透
        panel.addChildWindow(popup, ordered: .above)

        reposition()
        sidecar.start()
    }

    /// 主面板拖动：按下记起点，拖动时只把 y 跟着鼠标走，x 交给 constrainFrameRect 钉住；规则在 `PanelDrag`
    private func handleDrag(_ e: NSEvent) {
        guard e.window === panel else { return }
        switch drag.handle(e.type, mouse: NSEvent.mouseLocation, frame: panel.frame) {
        case .move(let origin):
            var f = panel.frame
            f.origin = origin
            panel.setFrame(panel.constrainFrameRect(f, to: panel.screen ?? NSScreen.main), display: true)
            userMoved = true
            placePopup()
        case .moved:
            feed.panelFrame = panel.frame
        case .none: break
        }
    }

    /// 主面板拖动的状态机（纯逻辑，便于离线验证）：
    /// 按下落在面板内部（`PanelResize.edges` 为空）才开始跟踪——边缘 / 角那圈是 `ResizeEdgeView` 的改尺寸区，事件到不了 SwiftUI，这里也不跟；
    /// 拖动超过 3pt 才算拖（免得点击行时抖）；松手时若真拖过就报 `.moved`。
    struct PanelDrag {
        enum Effect: Equatable { case none, move(CGPoint), moved }
        private var tracking: (mouse: CGPoint, origin: CGPoint, moved: Bool)?

        mutating func handle(_ type: NSEvent.EventType, mouse: CGPoint, frame: NSRect) -> Effect {
            switch type {
            case .leftMouseDown:
                let local = CGPoint(x: mouse.x - frame.minX, y: mouse.y - frame.minY)
                tracking = PanelResize.edges(at: local, in: NSRect(origin: .zero, size: frame.size)).isEmpty ? (mouse, frame.origin, false) : nil
                return .none
            case .leftMouseDragged:
                guard var d = tracking else { return .none }
                let dy = mouse.y - d.mouse.y
                if !d.moved && abs(dy) < 3 && abs(mouse.x - d.mouse.x) < 3 { return .none }
                d.moved = true; tracking = d
                return .move(CGPoint(x: d.origin.x, y: d.origin.y + dy))
            case .leftMouseUp:
                defer { tracking = nil }
                return tracking?.moved == true ? .moved : .none
            default: return .none
            }
        }
    }

    /// 主面板边缘改尺寸的纯几何（离线可验证）：按下点落在哪条边 / 角，拖到哪里 frame 是多少。
    /// 左缘贴屏幕边抓不到；能抓右 / 上 / 下三边 + 右上 / 右下两角，命中圈宽 `margin`（`PanelDrag` 的内部拖动区是它的补集）。
    /// 两个角跟着面板的可见圆角走（`PanelView.shape`，半径 `cornerRadius`）：窗口 isOpaque=false + 底色透明，WindowServer 把 alpha 0 的像素当穿透，
    /// 事件根本到不了窗口——角上 8×8 的方块里只有 ~5 pt² 是可见像素（22 圆角），按方块判角等于没有角。
    /// 所以角方块（r×r）里按到圆心的距离判：≥ r-margin 就是沿着圆弧的一条 8pt 环带 = 角；更靠里是内部。
    /// 右边只动宽；顶边只动 maxY（底不动）；底边只动 minY（顶不动）。尺寸先经 `clamp`（`PanelSize.clamp`：设置范围 ∩ 屏幕）再回推 origin，锚边不漂。
    struct PanelResize {
        static let margin: CGFloat = 8
        /// 右侧两角的可见圆角半径（与 `PanelView.shape` 同源，不另抄数）
        static var cornerRadius: CGFloat { PanelView.shape.cornerRadii.topTrailing }
        struct Edges: OptionSet {
            let rawValue: UInt8
            static let right = Edges(rawValue: 1), top = Edges(rawValue: 2), bottom = Edges(rawValue: 4)
        }

        /// `p` 为视图坐标（左下原点）
        static func edges(at p: CGPoint, in bounds: NSRect) -> Edges {
            guard bounds.contains(p) else { return [] }
            let r = min(cornerRadius, bounds.width / 2, bounds.height / 2)
            if p.x > bounds.maxX - r {
                // 右上 / 右下角方块：到圆心的距离 ≥ r-margin 才算角（圆弧外侧那点透明像素收不到事件，一并归到角，免得掉进内部）
                if p.y > bounds.maxY - r, hypot(p.x - (bounds.maxX - r), p.y - (bounds.maxY - r)) >= r - margin { return [.right, .top] }
                if p.y < bounds.minY + r, hypot(p.x - (bounds.maxX - r), p.y - (bounds.minY + r)) >= r - margin { return [.right, .bottom] }
                if p.y > bounds.maxY - r || p.y < bounds.minY + r { return [] }
            }
            var e: Edges = []
            if p.x >= bounds.maxX - margin { e.insert(.right) }
            if p.y >= bounds.maxY - margin { e.insert(.top) } else if p.y < bounds.minY + margin { e.insert(.bottom) }
            return e
        }

        /// 悬停 / 拖动时的光标；不在边上 → nil。macOS 15 起有带方向的系统 frameResize 光标（角是斜向双箭头），之前只有横 / 竖两种
        static func cursor(for e: Edges) -> NSCursor? {
            guard !e.isEmpty else { return nil }
            if #available(macOS 15, *) {
                let pos: NSCursor.FrameResizePosition
                switch (e.contains(.right), e.contains(.top), e.contains(.bottom)) {
                case (true, true, _): pos = .topRight
                case (true, _, true): pos = .bottomRight
                case (true, _, _): pos = .right
                case (_, true, _): pos = .top
                default: pos = .bottom
                }
                return .frameResize(position: pos, directions: .all)
            }
            return e.contains(.right) ? .resizeLeftRight : .resizeUpDown
        }

        private var tracking: (edges: Edges, mouse: CGPoint, frame: NSRect)?
        /// 正在拖边缘（按下到松手之间）
        var isTracking: Bool { tracking != nil }

        /// 按下：`mouse` 屏幕坐标，`frame` 按下那一刻的窗口 frame
        mutating func begin(_ edges: Edges, mouse: CGPoint, frame: NSRect) {
            tracking = edges.isEmpty ? nil : (edges, mouse, frame)
        }

        /// 拖到 `mouse`（屏幕坐标）时的目标 frame；没在改尺寸 → nil。
        /// `visible` = 所在屏幕可见区：拖顶边最多长到屏幕顶、拖底边最多长到屏幕底（超出就到头），锚边（对面那条）永远不动——
        /// 不这样的话 constrainFrameRect 会把整块窗口往回推，看起来像锚边在跑
        func frame(mouse: CGPoint, visible: NSRect, clamp: (NSSize) -> NSSize) -> NSRect? {
            guard let t = tracking else { return nil }
            var size = t.frame.size
            if t.edges.contains(.right) { size.width = t.frame.width + (mouse.x - t.mouse.x) }
            if t.edges.contains(.top) { size.height = min(t.frame.height + (mouse.y - t.mouse.y), visible.maxY - t.frame.minY) }
            if t.edges.contains(.bottom) { size.height = min(t.frame.height - (mouse.y - t.mouse.y), t.frame.maxY - visible.minY) }
            size = clamp(size)
            let y = t.edges.contains(.bottom) ? t.frame.maxY - size.height : t.frame.minY
            return NSRect(x: t.frame.minX, y: y, width: size.width, height: size.height)
        }

        /// 松手：true = 刚才确实在改尺寸
        mutating func end() -> Bool {
            defer { tracking = nil }
            return tracking != nil
        }
    }

    /// 主面板的显式改尺寸命中面 = 主面板 contentView 容器，SwiftUI 的 NSHostingView 是它的子视图。
    /// `hitTest` 只在 `PanelResize.margin` 那圈边缘返回自己（按下被它吃掉：行点击 / `PanelDrag` 垂直拖动都只在圈内侧），其余透给 SwiftUI。
    /// 光标：tracking area 里同步 `NSCursor.set()`——后台进程靠 `cursorInBackground`（SetsCursorInBackground）才生效，
    /// 且必须是命中目标 NSView 自己设（见 `cursorInBackground` 注释）；离开边缘 / 松手时还原箭头，不盖住 SwiftUI 行的手型。
    /// 鼠标坐标用事件自己换算到屏幕（不读 `NSEvent.mouseLocation`），进程内注入事件也能驱动。
    final class ResizeEdgeView: NSView {
        var onBegin: ((PanelResize.Edges, CGPoint) -> Void)?
        var onDrag: ((CGPoint) -> Void)?
        var onEnd: (() -> Void)?
        private var tracking: NSTrackingArea?
        private var active: PanelResize.Edges?
        private var cursorShown = false

        init(host: NSView) {
            super.init(frame: host.frame)
            host.frame = bounds
            host.autoresizingMask = [.width, .height]
            addSubview(host)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func updateTrackingAreas() {
            if let tracking { removeTrackingArea(tracking) }
            let a = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
            addTrackingArea(a)
            tracking = a
            super.updateTrackingAreas()
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            PanelResize.edges(at: convert(point, from: superview), in: bounds).isEmpty ? super.hitTest(point) : self
        }

        private func edges(_ e: NSEvent) -> PanelResize.Edges { PanelResize.edges(at: convert(e.locationInWindow, from: nil), in: bounds) }
        private func screenPoint(_ e: NSEvent) -> CGPoint { window?.convertPoint(toScreen: e.locationInWindow) ?? e.locationInWindow }
        private func showCursor(_ e: PanelResize.Edges) {
            if let c = PanelResize.cursor(for: e) { c.set(); cursorShown = true }
            else if cursorShown { NSCursor.arrow.set(); cursorShown = false }
        }

        override func mouseEntered(with e: NSEvent) { if active == nil { showCursor(edges(e)) } }
        override func mouseMoved(with e: NSEvent) { if active == nil { showCursor(edges(e)) } }
        override func mouseExited(with e: NSEvent) { if active == nil { showCursor([]) } }
        override func mouseDown(with e: NSEvent) {
            let ed = edges(e)
            guard !ed.isEmpty else { return }
            active = ed
            showCursor(ed)
            onBegin?(ed, screenPoint(e))
        }
        override func mouseDragged(with e: NSEvent) {
            guard let active else { return }
            showCursor(active)   // 拖出窗口范围时别的窗口会重设光标，每帧钉回来
            onDrag?(screenPoint(e))
        }
        override func mouseUp(with e: NSEvent) {
            guard active != nil else { return }
            active = nil
            onEnd?()
            showCursor(edges(e))
        }
    }

    /// 主面板锁在屏幕左缘：拖动 / 改尺寸只改 y 和尺寸，x 永远 = 所在屏幕 visibleFrame.minX；y 夹在可见区域内。
    final class EdgeLockedPanel: NSPanel {
        override var canBecomeKey: Bool { true }
        override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
            var r = super.constrainFrameRect(frameRect, to: screen)
            guard let vf = (screen ?? self.screen ?? NSScreen.main)?.visibleFrame else { return r }
            r.origin.x = vf.minX
            r.origin.y = min(max(r.origin.y, vf.minY), vf.maxY - r.height)
            return r
        }
    }

    /// 边缘拖动中：每帧按 `PanelResize` 算目标 frame，尺寸夹在 `PanelSize.clamp`（设置范围 ∩ 屏幕可见区），弹卡跟着挪
    private func resizeDragged(to mouse: CGPoint) {
        let screen = panel.screen ?? NSScreen.main
        let vf = screen?.visibleFrame ?? NSRect(origin: .zero, size: PanelSize.maxSize)
        guard let f = resize.frame(mouse: mouse, visible: vf, clamp: { PanelSize.clamp($0, screen: vf.size) }) else { return }
        panel.setFrame(panel.constrainFrameRect(f, to: screen), display: true)
        placePopup()
    }

    /// 用户放开边缘：整数化尺寸，写回 sidecar 设置（和 dashboard 同一条 `PUT /api/settings`、同一处 SQLite）。
    /// 存的是**逻辑尺寸** = 窗口尺寸夹进服务端允许范围（`PanelSize.logical`）：屏幕比最小值还小时窗口可能被 AppKit 压得更小，
    /// 但存回去的永远 ≥ 服务端下限，服务端不会把它规范化成别的数再推回来
    private func resizeEnded() {
        var f = panel.frame
        f.size = NSSize(width: f.width.rounded(), height: f.height.rounded())
        if f != panel.frame { panel.setFrame(panel.constrainFrameRect(f, to: panel.screen ?? NSScreen.main), display: true) }
        userMoved = true
        feed.panelFrame = panel.frame
        placePopup()
        let s = PanelSize.logical(panel.frame.size)
        guard s != panelSize else { return }
        panelSize = s
        sizeStore.save(s, dashboard: feed.dashboardURL)
    }

    /// app 是 .nonactivatingPanel 常驻后台：AppKit 只在「正在处理自己窗口里的鼠标事件」时接受 NSCursor.set()，
    /// SwiftUI onHover 是异步批处理的，回调里 set/push 全被丢掉（hover 背景亮、手型出不来；`.pointerStyle(.link)`、
    /// 透明 NSView 挂 tracking area 同步 set() 也一样无效——只有 CandleChart 这种自己当命中目标的 NSView 才行）。
    /// CGS 私有属性 SetsCursorInBackground 让后台进程随时能设光标（pixel picker / synergy 同款；非 App Store 无所谓）。
    /// 实测 macOS 26：开了之后 Clickable 的手型正常。已知残留：前台是 Ghostty 时它会持续重设 I-beam，谁都盖不过。
    private static let cursorInBackground: Bool = {
        let cid = CGSDefaultConnection()
        let err = CGSSetConnectionProperty(cid, cid, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
        if err != 0 { FLog.error("panel", "SetsCursorInBackground failed cid=\(cid) err=\(err)") }
        return err == 0
    }()

    /// borderless 的 NSPanel 默认 `canBecomeKey == false`，输入框点了也吃不到键盘（实测）。两种窗口都开 key 资格——弹卡有 `$` 金额框，
    /// 主面板有搜索框；`.nonactivatingPanel` 保证拿 key 也不激活 app，`becomesKeyOnlyIfNeeded` 保证只有点到需要键盘的控件才拿，
    /// 新币自动弹卡 orderFront / 主面板常驻都不会把用户正在打字的 app 的键盘抢走
    final class PopupPanel: NSPanel {
        override var canBecomeKey: Bool { true }
    }

    static func makePanel(_ host: NSView, size: NSSize, lockLeft: Bool = false) -> NSPanel {
        let rect = NSRect(origin: .zero, size: size)
        // 主面板改尺寸由 `ResizeEdgeView` 自己接鼠标，不走 `.resizable`；弹卡尺寸跟内容走，不给用户改
        let style: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
        let p = lockLeft ? EdgeLockedPanel(contentRect: rect, styleMask: style, backing: .buffered, defer: false)
                         : PopupPanel(contentRect: rect, styleMask: style, backing: .buffered, defer: false)
        p.becomesKeyOnlyIfNeeded = true
        p.isFloatingPanel = true
        p.level = .floating                 // 置顶（比普通窗口高，比 statusBar 低）
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // 配色是固定的「纯黑 + 翡翠绿」（FM.*），玻璃材质却跟系统外观走：系统浅色时 .hudWindow 变成浅灰毛玻璃，
        // 叠在浅色网页上整块面板发灰，底栏 faint 字和图标直接消失。钉成 darkAqua 让材质始终是深色（dashboard 窗口同样做法）
        p.appearance = NSAppearance(named: .darkAqua)
        if !Self.cursorInBackground { FLog.info("panel", "SetsCursorInBackground 不可用：手型光标可能出不来") }
        p.contentView = host
        host.frame = p.contentView?.bounds ?? .zero
        host.autoresizingMask = [.width, .height]
        return p
    }

    /// 贴左边、顶到菜单栏下、留边距；弹窗锚在面板右侧
    private func reposition() {
        guard let screen = NSScreen.main else { return }
        let rect = Self.restoreRect(panelSize, in: screen.visibleFrame, keepingTop: userMoved ? panel.frame.maxY : nil)
        panel.setFrame(panel.constrainFrameRect(rect, to: screen), display: true)
        feed.panelFrame = panel.frame
        placePopup()
    }

    /// 按设置尺寸算窗口 frame：尺寸夹在和拖边缘同一套限制里（`PanelSize.clamp`：设置范围 ∩ 屏幕可见区）——不再另减 60，
    /// 用户拖到满屏高存下的 800 重启后还是 800，屏幕变小才收。贴屏幕左缘；顶部 22pt 留白放得下就留，放不下贴顶；
    /// `keepingTop` = 用户拖过的顶边（改尺寸后保留）。y 最终由 constrainFrameRect 夹进可见区
    static func restoreRect(_ s: PanelSize, in vf: NSRect, keepingTop: CGFloat?) -> NSRect {
        let size = PanelSize.clamp(NSSize(width: s.width, height: s.height), screen: vf.size)
        let top = keepingTop ?? (size.height + 22 <= vf.height ? vf.maxY - 22 : vf.maxY)
        return NSRect(origin: CGPoint(x: vf.minX, y: top - size.height), size: size)
    }

    private func placePopup() {
        let frame = panel.frame
        let cardLeft = frame.maxX + popupGap
        let cardTop = frame.maxY - popupDrop
        popup.setFrame(NSRect(x: cardLeft - PopupHost.padX,
                              y: cardTop + PopupHost.padTop - popupSize.height,
                              width: popupSize.width,
                              height: popupSize.height), display: true)
    }

    /// 弹卡内容尺寸变了：窗口 = 内容 + 留白，左上角不动
    private func resizePopup(card: CGSize) {
        let s = CGSize(width: card.width + PopupHost.padX * 2, height: max(120, card.height + PopupHost.padTop + PopupHost.padBottom))
        guard abs(s.width - popupSize.width) > 0.5 || abs(s.height - popupSize.height) > 0.5 else { return }
        popupSize = s
        placePopup()
    }

    /// 弹卡显示期间监听全局/本地鼠标按下：点在弹卡窗口之外 → 关闭；点在弹卡里（任何位置、任何键）→ 钉住自动卡。
    /// 另：弹卡窗口左侧 `PopupHost.padX`（阴影留白）盖过了主面板右缘 `padX - popupGap` 那条（子窗口在上面，WindowServer 按窗口矩形派发），
    /// 鼠标落在这条重叠带里时把弹卡设成 `ignoresMouseEvents`，右缘的改尺寸抓边 / 行点击才收得到事件；出了重叠带就恢复。
    private func popupVisibility(_ visible: Bool) {
        popup.ignoresMouseEvents = !visible
        for m in clickMonitors { NSEvent.removeMonitor(m) }
        clickMonitors.removeAll()
        guard visible else { return }
        // 「我们的窗口」= 弹卡 / 主面板本身，以及挂在它们下面的子窗口（弹卡「充值」的 NSPopover 是弹卡的 child window；
        // 2026-09-11 用户报「点地址复制，面板直接隐藏」——就是 popover 里的点击被当成外部点击关了卡）
        let ours: (NSWindow?) -> Bool = { [weak self] w in
            guard let self else { return false }
            var cur = w
            while let x = cur {
                if x === self.popup || x === self.panel { return true }
                // 兜底：AppKit 的 popover 窗口（_NSPopoverWindow）不一定挂成 child，按类名认——我们只在弹卡 / 状态栏上开 popover
                if String(describing: type(of: x)).contains("Popover") { return true }
                cur = x.parent
            }
            return false
        }
        let outside: (NSEvent) -> Void = { [weak self] e in
            guard let self, self.feed.popup != nil else { return }
            // 本地事件：e.window 是被点的窗口。弹卡自己不关；主面板也不关——行的点击会直接 A→B 切换
            // （若在这里先关再开，弹卡会经历 A→nil→B 两次跳变，入场动画就乱了）。全局事件（别的 app）window 为 nil → 关。
            if ours(e.window) { return }
            Task { @MainActor in self.feed.dismissPopup() }
        }
        if let g = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: outside) { clickMonitors.append(g) }
        // 按下就钉（不等 Button 的 action：被控件吃掉的点击、按住不放超过 6s 的都算），事件照常放行
        if let l = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] e in
            if let self, e.window === self.popup { MainActor.assumeIsolated { self.feed.pinPopup() } }
            else if e.type != .otherMouseDown { outside(e) }
            return e
        }) { clickMonitors.append(l) }
        // 重叠带穿透：本地（鼠标在我们的窗口上）+ 全局（鼠标在别的 app 上）都要听，否则设成穿透后就再收不到自己的 mouseMoved 了
        let overlap: (NSEvent) -> Void = { [weak self] _ in
            guard let self else { return }
            MainActor.assumeIsolated {
                // 只在值真的变了才写（setter 每次都会去 WindowServer 重登记，按下 / 拖动中途写会吞掉这次点击）；按着键时不动
                let want = self.popupOverlapsPanel(at: NSEvent.mouseLocation)
                if want != self.popup.ignoresMouseEvents, NSEvent.pressedMouseButtons == 0 { self.popup.ignoresMouseEvents = want }
            }
        }
        if let g = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: overlap) { clickMonitors.append(g) }
        if let l = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { e in overlap(e); return e }) { clickMonitors.append(l) }
    }

    /// 屏幕坐标 `p` 是否落在弹卡窗口与主面板的重叠带里（弹卡的左侧阴影留白盖住主面板右缘的那条）
    private func popupOverlapsPanel(at p: CGPoint) -> Bool {
        popup.frame.intersection(panel.frame).contains(p)
    }

    /// sidecar 推来的设置（启动 / dashboard 改了 / 我们自己存回去的回声）
    private func apply(panelSize s: PanelSize) {
        // 正在拖边缘：窗口以手为准，松手会存一次；这时到的都是旧值，不让它把窗口从手里弹开
        guard !resize.isTracking else { return }
        // 用户拖出来的尺寸还没存上（之前 dashboard 没起 / 失败）：以窗口为准，补存，不让旧值把窗口弹回去
        guard sizeStore.accept(echo: s, dashboard: feed.dashboardURL) else { return }
        guard s != panelSize else { return }
        panelSize = s
        reposition()
    }

    /// 状态栏「充值地址…」/「生成热钱包…」：把 `DepositSheet` 装进 NSPopover 挂在菜单栏图标下（transient，点别处即收）。内容跟着 `feed.tradeState` 活更新：
    /// 没钱包时里面是「生成热钱包」按钮，生成完同一弹窗直接变成地址
    private var depositPopover: NSPopover?
    var hasWallet: Bool { feed.tradeState.hasWallet }
    func showDeposit(relativeTo view: NSView) {
        if depositPopover == nil {
            struct Root: View {
                let feed: Feed
                var body: some View { DepositSheet(state: feed.tradeState, onWalletInit: { feed.onWalletInit?() }) }
            }
            let p = NSPopover()
            p.behavior = .transient
            p.appearance = NSAppearance(named: .darkAqua)
            p.contentViewController = NSHostingController(rootView: Root(feed: feed))
            depositPopover = p
        }
        depositPopover?.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }

    /// dashboard：sidecar 起的本地网页，装在原生样式的窗口里（透明标题栏 + 工具栏分段切页）；tab 非 nil 时用 `#<tab>` 直达（index.html 按 hash 切页）
    func showDashboard(tab: String? = nil) {
        guard let url = feed.dashboardURL else { return }
        if dashboard == nil { dashboard = DashboardWindow() }
        dashboard?.show(url, tab: tab)
        NSApp.activate(ignoringOtherApps: true)
    }

    func show() {
        panel.orderFrontRegardless()        // 不激活 app，直接显示
    }

    /// 收进状态栏：主面板 orderOut（弹卡是子窗口，跟着一起隐）；sidecar / WS / 数据照跑，恢复时 frame 不动。
    /// 状态不持久化，重启默认显示。
    private(set) var isCollapsed = false

    func setCollapsed(_ on: Bool) {
        guard on != isCollapsed else { return }
        isCollapsed = on
        if on {
            feed.dismissPopup()
            feed.setPanelHidden(true)
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
            feed.setPanelHidden(false)
        }
    }

    func shutdown() {
        sidecar.stop()
    }
}

/// 面板尺寸的持久化：经 dashboard 的 HTTP 接口 `PUT /api/settings` 存（服务端 clamp 与 PanelSize.min/maxSize 一致，
/// 存完 sidecar 会推一条 `settings` 回来 = 同值）。dashboard 还没起 / 请求失败：记成未保存，等 sidecar 下次推设置
/// （重连 / 重启）再补存一次，不让旧值把窗口弹回去；每条回声最多补存一次，不会打转。
@MainActor
final class PanelSizeStore {
    private var unsaved: PanelSize?
    private var task: Task<Void, Never>?
    private let session = URLSession.shared

    func save(_ s: PanelSize, dashboard: URL?) {
        unsaved = s
        task?.cancel()
        task = nil // 取消掉的不能留着：dashboard 还没起时 return 在下面，否则 accept(echo) 会以为还有 PUT 在飞而不补存
        guard let base = dashboard else { FLog.info("panel", "面板尺寸 \(Int(s.width))×\(Int(s.height)) 待 dashboard 就绪后保存"); return }
        var req = URLRequest(url: base.appendingPathComponent("api/settings"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["panel": ["width": s.width, "height": s.height]])
        task = Task { [weak self, session] in
            defer { if let self, !Task.isCancelled { self.task = nil } }
            do {
                let (_, resp) = try await session.data(for: req)
                guard let self, !Task.isCancelled else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 200 { if self.unsaved == s { self.unsaved = nil } }
                else { FLog.error("panel", "保存面板尺寸失败: \(resp)") }
            } catch {
                if !Task.isCancelled { FLog.error("panel", "保存面板尺寸失败: \(error)") }
            }
        }
    }

    /// sidecar 推来一份设置：true = 照它改窗口；false = 它是旧值（用户拖出来的还没存上），别动窗口——没有 PUT 在飞就补存。
    /// 存的永远是 `PanelSize.logical`（服务端范围内），服务端不会改值，所以旧回声只会是重连 / 重启那几条，补存不会打转
    func accept(echo s: PanelSize, dashboard: URL?) -> Bool {
        guard let u = unsaved, s != u else { return true }
        if task == nil { save(u, dashboard: dashboard) }
        return false
    }
}
