import AppKit
import WebKit

/// dashboard 窗口：sidecar 起的本地网页装在 WKWebView 里，外壳做成现代 macOS 原生样子——
/// 透明标题栏 + 内容顶到头、不显示标题，红绿灯压在网页左侧导航栏上（网页 `?native=1` 时侧栏顶部让位）。
/// 导航在网页侧栏里，不做原生工具栏。
///
/// 拖动：WKWebView 铺满整个窗口（含标题栏那 28pt），AppKit 的 `isMovableByWindowBackground` 对它不起作用，
/// 所以由注入的 user script 在侧栏 / 顶栏的非控件区域 mousedown 时报给 Swift，Swift 用那次 mouseDown 事件
/// 调 `performDrag(with:)` 走原生拖动（和 Tauri `data-tauri-drag-region` 同一套路）。index.html 无需改动。
@MainActor
final class DashboardWindow {
    let window: NSWindow
    private let web: WKWebView
    private let drag: WindowDragBridge

    init() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addUserScript(WKUserScript(source: WindowDragBridge.script, injectionTime: .atDocumentEnd,
                                                             forMainFrameOnly: true, in: .defaultClient))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1240, height: 800), configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")   // 让窗口底色透出来，页面还没画时不闪白
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "fomomo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0x0d / 255, green: 0x0e / 255, blue: 0x10 / 255, alpha: 1)   // = 网页侧栏 --side
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 960, height: 600)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("fomomo.dashboard")
        drag = WindowDragBridge(window: window)
        web.configuration.userContentController.add(drag, contentWorld: .defaultClient, name: WindowDragBridge.handler)
    }

    func show(_ url: URL, tab: String? = nil) {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "native", value: "1")]
        c.fragment = tab
        web.load(URLRequest(url: c.url!))
        window.makeKeyAndOrderFront(nil)
    }
}

/// 网页 → 原生的窗口拖动桥。
/// 网页的 mousedown 是异步经 IPC 传回来的，到手时 `NSApp.currentEvent` 可能已经是 mouseDragged / mouseUp，
/// 所以用本地事件监听记住这个窗口最近一次 leftMouseDown；对应的 mouseUp 先到就作废（快速点击不拖）。
/// 顶栏双击按系统「双击标题栏」偏好处理（缩放 / 最小化 / 无）。
@MainActor
private final class WindowDragBridge: NSObject, WKScriptMessageHandler {
    static let handler = "fomomoDrag"
    /// 侧栏、顶栏里不落在控件（按钮/链接/输入框/列表行……）上的左键按下 → 报给原生；preventDefault 免得拖动时选中文字。
    static let script = """
    (() => {
      const port = webkit.messageHandlers.\(handler);
      const controls = 'button, a, input, select, textarea, label, [contenteditable], .li, .g, tr';
      document.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest(controls)) return;
        const region = e.target.closest('.topbar') ? 'titlebar' : e.target.closest('aside') ? 'sidebar' : null;
        if (!region) return;
        e.preventDefault();
        port.postMessage(region);
      }, true);
    })();
    """

    private unowned let window: NSWindow
    private var pendingDown: NSEvent?
    nonisolated(unsafe) private var monitor: Any?

    init(window: NSWindow) {
        self.window = window
        super.init()
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] ev in
            guard let self, ev.window === self.window else { return ev }
            MainActor.assumeIsolated { self.pendingDown = ev.type == .leftMouseDown ? ev : nil }
            return ev
        }
    }

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let down = pendingDown else { return }
        pendingDown = nil
        if message.body as? String == "titlebar", down.clickCount == 2 {
            titlebarDoubleClick()
        } else {
            window.performDrag(with: down)
        }
    }

    private func titlebarDoubleClick() {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "None": break
        case "Minimize": window.miniaturize(nil)
        case "Fill": if let f = window.screen?.visibleFrame { window.setFrame(f, display: true, animate: true) }
        default: window.performZoom(nil)
        }
    }
}
