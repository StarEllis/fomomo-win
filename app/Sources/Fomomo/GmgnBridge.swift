import AppKit
import WebKit


enum GmgnState: Equatable {
    case idle, loading, ready, needsAttention(String), error(String)
    var label: String {
        switch self {
        case .idle: return "gmgn 未连"
        case .loading: return "gmgn 加载中"
        case .ready: return "gmgn ✓"
        case .needsAttention(let m): return "gmgn 需处理: \(m)"
        case .error(let m): return "gmgn 出错: \(m)"
        }
    }
    var ok: Bool { self == .ready }
}

enum GmgnError: Error { case notReady, badBody }

/// 「寄生在登录浏览器里」：一个常驻的 WKWebView 停在 gmgn.ai 页面上，
/// 所有 gmgn 私有 API 都在页面上下文里 fetch（带 cookie + 页面自己那串 device_id 参数），
/// 和 985gmgn-helper 的做法一致 —— 直接从进程外打 API 会被 Cloudflare 403。
/// 会话持久（固定 identifier 的 WKWebsiteDataStore），过验证/登录只需一次。
/// 页面出现 Cloudflare 挑战或 API 被拦时把窗口亮出来让人点一下。
@MainActor
final class GmgnBridge: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private let window: NSWindow
    private(set) var state: GmgnState = .idle { didSet { onState?(state) } }
    var onState: ((GmgnState) -> Void)?
    private var lastReloadAt = Date.distantPast

    static let home = URL(string: "https://gmgn.ai/?chain=robinhood")!
    static let safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"
    // 页面自己没发过带 device_id 的请求时的兜底参数（取自 985gmgn-helper 的 DEV_ATH_QS）
    static let fallbackQuery = "device_id=&client_id=gmgn_web&from_app=gmgn&app_ver=&tz_name=Asia%2FShanghai&tz_offset=28800&app_lang=zh-CN&os=web"

    override init() {
        let cfg = WKWebViewConfiguration()
        // 固定 identifier → cookie/localStorage 落在 ~/Library/WebKit 下持久化，重启不用重新过验证
        cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "F0A0A0A0-985F-4D00-8000-0000000F0F0F")!)
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1120, height: 780), configuration: cfg)
        webView.customUserAgent = Self.safariUA
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "gmgn · 人机验证 / 登录（完成后可关闭）"
        window.contentView = webView
        window.isReleasedWhenClosed = false
        super.init()
        webView.navigationDelegate = self
        load()
    }

    func load() {
        state = .loading
        webView.load(URLRequest(url: Self.home))
    }

    func showWindow() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 等页面就绪（最多 timeout 秒）
    func waitReady(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !state.ok && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(250))
        }
        return state.ok
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { await inspectPage() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        state = .error(error.localizedDescription)
        FLog.error("gmgn", "nav failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        state = .error(error.localizedDescription)
        FLog.error("gmgn", "provisional nav failed: \(error.localizedDescription)")
    }

    private func inspectPage() async {
        let title = (try? await webView.evaluateJavaScript("document.title")) as? String ?? ""
        let host = webView.url?.host ?? ""
        FLog.info("gmgn", "page loaded host=\(host) title=\(title)")
        if title.localizedCaseInsensitiveContains("just a moment") || title.localizedCaseInsensitiveContains("attention required")
            || title.localizedCaseInsensitiveContains("cloudflare") {
            state = .needsAttention("Cloudflare 验证")
            showWindow()
            return
        }
        guard host.hasSuffix("gmgn.ai") else { return }
        state = .ready
    }

    // MARK: API 代发（sidecar 通过 rpc 决定 endpoint/解析；这里只负责"在页面里发出去"）

    /// 在 gmgn.ai 页面上下文里 fetch。query string 用页面自己发过的那串 device_id 参数（抄不到用兜底常量）。
    /// 返回 (HTTP 状态, 原始 body)。403/429 或非 JSON 200 视为被 Cloudflare 拦 → 亮窗让人处理。
    func fetch(path: String, method: String, body: String?) async throws -> (status: Int, body: String) {
        guard state.ok else { throw GmgnError.notReady }
        let js = """
        const fromPage = (performance.getEntriesByType('resource').map(e => e.name)
            .find(u => u.includes('gmgn.ai/') && u.includes('device_id=')) || '').split('?')[1];
        const qs = fromPage || fallback;
        const r = await fetch('https://gmgn.ai' + path + (path.includes('?') ? '&' : '?') + qs, {
            method, credentials: 'include',
            headers: body == null ? {} : { 'Content-Type': 'application/json' },
            body: body == null ? undefined : body,
        });
        const text = await r.text();
        return JSON.stringify({ status: r.status, body: text.slice(0, 2000000) });
        """
        let raw: Any? = try await webView.callAsyncJavaScript(js, arguments: ["path": path, "method": method, "body": body.map { $0 as Any } ?? NSNull(), "fallback": Self.fallbackQuery],
                                                              in: nil, contentWorld: .page)
        guard let s = raw as? String, let d = s.data(using: .utf8),
              let env = try JSONSerialization.jsonObject(with: d) as? [String: Any],
              let status = env["status"] as? Int, let text = env["body"] as? String else { throw GmgnError.badBody }
        if status == 403 || status == 429 { markBlocked("API \(status)") }
        else if status == 200, !text.hasPrefix("{"), !text.hasPrefix("[") { markBlocked("非 JSON 响应") }  // 多半是挑战页
        return (status, text)
    }

    private func markBlocked(_ why: String) {
        state = .needsAttention(why)
        // 挑战页只能人来过；亮窗 + 重载一次（限频）
        if Date().timeIntervalSince(lastReloadAt) > 60 {
            lastReloadAt = Date()
            load()
        }
        showWindow()
    }
}
