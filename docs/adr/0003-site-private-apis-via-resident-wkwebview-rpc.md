# 站点私有 API 经应用内常驻 WKWebView 在页面上下文里代发

gmgn 的私有 API 在进程外直接请求会被人机验证挡下（按 TLS 指纹 + UA 判），fomo.family 的凭据由页面里的 Privy SDK 持有。所以 Swift 各常驻一个隐藏 WKWebView（`GmgnBridge` / `FomoBridge`，固定 identifier 的持久数据仓），sidecar 通过 `rpc` 事件让 Swift 在页面上下文里执行：gmgn 的每个请求都在页面里 `fetch` 并原样回状态码 + body；fomo 只经页面取 access token 与用户身份，数据 REST 由 sidecar 拿 token 用 Safari 指纹（`wreq-js`）直发。端点、参数、字段全由 TS 决定，Swift 不解析任何第三方响应。页面出现人机验证或需要登录时把窗口亮出来让人点一下。

## Considered Options

- Node 直连并模仿浏览器指纹：对 gmgn 试过，能过的 UA / TLS 组合脆弱且随时失效，只对不设门的接口（成交流 WebSocket）这么做；对 fomo REST 反而可行（HTTP/1.1 + 浏览器 UA 稳定 200），所以 fomo 只把登录态留在页面里。
- 接管用户日常浏览器：见 ADR 0004。

## Consequences

- gmgn 请求都多一次 WKWebView 往返；批量接口按上限攒批（`mutil_window_token_info` ≤10 地址）。
- 这两个 WebView 是唯一需要人偶尔交互（过验证 / 登录）的地方。
