import AppKit
import WebKit

/// 「寄生在登录浏览器里」的 fomo.family 版（同 GmgnBridge）：一个常驻的隐藏 WKWebView 停在 https://fomo.family/，
/// 会话持久（固定 identifier 的 WKWebsiteDataStore），owner 在状态栏「登录 fomo…」亮出的窗口里完成一次 OAuth 即可。
///
/// fomo 的 REST/WS 由 sidecar 用 Node 直发（REST 经 wreq-js 伪装成 Safari 的 TLS/HTTP2 指纹过它的请求画像门），这里只出两样东西（都是信号半边；交易在本地 burner 钱包 + OKX，与这个页面无关）：
/// - `fomo.token`：当前 Privy access token。页面里的 Privy SDK 自己续期（access 1h / refresh 30d 单次轮换），
///   sidecar 每次用前取一次，**refresh token 永不离开 WebView**。取法：用户脚本截获页面自己发往 prod-api 的 `Authorization: Bearer …`
///   （最新鲜），兜底 `localStorage["privy:token"]` / cookie `privy-token`。`refresh=true` 时重载页面（限频 60s）让 SDK 换新。
/// - `fomo.me`：页面登录后自己 `POST /v2/users` 的响应（`{id, userHandle, following}`），同样由用户脚本截获。
///
/// UA 伪装成 Safari：Google OAuth 对嵌入式 WebView 的默认 UA 回 `disallowed_useragent`；Apple 登录一般不挑。
/// `window.open`（部分 OAuth 弹窗）直接在本视图里导航，回跳到 fomo.family 后页面自己收尾。
@MainActor
final class FomoBridge: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let shared = FomoBridge()

    let webView: WKWebView
    private let window: NSWindow
    private var lastReloadAt = Date.distantPast
    private(set) var loaded = false

    static let home = URL(string: "https://fomo.family/")!
    static let safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"

    /// 在页面世界里包一层 fetch：记下页面发往 prod-api 的最新 Bearer，以及 `POST /v2/users` 的响应（= 我是谁）
    private static let interceptor = """
    (() => {
      if (window.__fomomoHooked) return;
      window.__fomomoHooked = true;
      const orig = window.fetch;
      const headerOf = (h, k) => {
        if (!h) return null;
        if (h instanceof Headers) return h.get(k);
        for (const key of Object.keys(h)) if (key.toLowerCase() === k) return h[key];
        return null;
      };
      window.fetch = function (input, init) {
        let url = '';
        let auth = null;
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          auth = headerOf(init && init.headers, 'authorization') || (input instanceof Request ? input.headers.get('authorization') : null);
          if (auth && /^Bearer\\s+\\S/i.test(auth) && url.indexOf('prod-api.fomo.family') !== -1) window.__fomomoToken = auth.replace(/^Bearer\\s+/i, '');
        } catch (e) {}
        const p = orig.apply(this, arguments);
        try {
          const method = ((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
          if (method === 'POST' && /prod-api\\.fomo\\.family\\/v2\\/users\\/?$/.test(url.split('?')[0])) {
            p.then(r => r.clone().json()).then(j => {
              const u = j && j.responseObject;
              if (u && u.id) window.__fomomoMe = { userId: u.id, handle: u.userHandle || '', following: typeof u.following === 'number' ? u.following : null };
            }).catch(() => {});
          }
        } catch (e) {}
        return p;
      };
    })();
    """

    private override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "F0A0A0A0-F0F0-4D00-8000-0000000F0F0F")!)
        cfg.userContentController.addUserScript(WKUserScript(source: Self.interceptor, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: cfg)
        webView.customUserAgent = Self.safariUA
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "fomo.family · 登录（完成后可关闭）"
        window.contentView = webView
        window.isReleasedWhenClosed = false
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        load()
    }

    func load() {
        loaded = false
        webView.load(URLRequest(url: Self.home))
    }

    /// 状态栏「登录 fomo…」：把常驻 WebView 放进普通窗口让人完成 OAuth；登录完成（`fomo.me` 拿到用户）自动收回
    func showLogin() {
        if webView.url == nil || webView.url?.host?.hasSuffix("fomo.family") != true { load() }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hideWindow() {
        if window.isVisible { window.orderOut(nil) }
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        FLog.info("fomo", "page loaded host=\(webView.url?.host ?? "") path=\(webView.url?.path ?? "")")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FLog.error("fomo", "nav failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FLog.error("fomo", "provisional nav failed: \(error.localizedDescription)")
    }

    /// OAuth 用 `window.open` 时在本视图里导航（不开新窗），回跳仍落回 fomo.family
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { FLog.info("fomo", "window.open → \(url.host ?? "")") }
        webView.load(navigationAction.request)
        return nil
    }

    // MARK: sidecar rpc

    /// 当前 Privy access token；`refresh` = 快到期了，重载页面（≥60s 一次）让 Privy SDK 换新，然后等新 token 出现（≤15s）
    func token(refresh: Bool) async -> String? {
        let before = await readToken()
        guard refresh, Date().timeIntervalSince(lastReloadAt) > 60 else { return before }
        lastReloadAt = Date()
        FLog.info("fomo", "reloading page to refresh token")
        load()
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            try? await Task.sleep(for: .milliseconds(500))
            guard loaded else { continue }
            if let t = await readToken(), t != before { return t }
        }
        return await readToken()
    }

    private func readToken() async -> String? {
        let js = """
        (() => {
          if (window.__fomomoToken) return window.__fomomoToken;
          try {
            const raw = localStorage.getItem('privy:token');
            if (raw) { const v = raw[0] === '"' ? JSON.parse(raw) : raw; if (typeof v === 'string' && v.split('.').length === 3) return v; }
          } catch (e) {}
          const m = document.cookie.match(/(?:^|;\\s*)privy-token=([^;]+)/);
          return m ? decodeURIComponent(m[1]) : null;
        })()
        """
        let raw = try? await webView.evaluateJavaScript(js)
        guard let s = raw as? String, !s.isEmpty else { return nil }
        return s
    }

    /// 页面自己 `POST /v2/users` 的响应：`{userId, handle, following}`；还没登录 / 页面还没发 → nil。拿到即收起登录窗
    func me() async -> [String: Any]? {
        let raw = try? await webView.evaluateJavaScript("window.__fomomoMe ? JSON.stringify(window.__fomomoMe) : null")
        guard let s = raw as? String, let d = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        if window.isVisible {
            FLog.info("fomo", "login detected, hiding window")
            hideWindow()
        }
        return obj
    }
}
