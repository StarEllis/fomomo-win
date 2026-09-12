# fomo.family 登录态由应用内常驻 WKWebView 持有

fomo 数据面需要 Privy 登录态（access token 约 1h，refresh token 30d 且单次轮换），而我们不控制 fomo.family 的 OAuth 回调与 RP 配置。决定：Swift 侧 `FomoBridge` 常驻一个隐藏 WKWebView 停在 fomo.family，会话存在固定 identifier 的持久 `WKWebsiteDataStore` 里；owner 从状态栏「登录 fomo…」亮出窗口做一次 OAuth，此后页面里的 Privy SDK 自己续期，sidecar 每次用前经 rpc `fomo.token` / `fomo.me` 只取 access token 与用户身份（用户脚本截获页面自己的请求），**refresh token 永不离开 WebView**。这是唯一不需要第二个浏览器进程、不复制会话、不开泛用调试端口就能保证「只有一个 refresh owner」的路线。

## Considered Options
- 接管用户外部 Chrome（CDP attach / agent-browser / DevTools MCP）：Chrome 144+ 虽有用户授权的 attach，但 CDP 权限覆盖整个 profile，且要求用户常开 Chrome 与一个 fomo 标签，后台页会被冻结/丢弃。
- Firefox WebDriver BiDi / geckodriver Marionette：Remote Agent 无认证可读 cookie，监听即 `navigator.webdriver === true`，且目标进程须预先以自动化参数启动，不是无感附着日常实例。
- Docker Camoufox（Playwright Juggler）：远程 server 是实验接口且不支持持久 profile，登录态随容器消失；反检测也不解决 Google 拒绝。
- 浏览器扩展 + Native Messaging（Chrome / Firefox / Safari）：权限面最窄，但要签名分发扩展、安装 native host，对单站点工具成本过高；仅留作日后替代 transport。
- ASWebAuthenticationSession：实测默认浏览器里登录成功，但 fomo/Privy 回跳到 `https://fomo.family/?privy_oauth_code=…` 而非 app 自定义 scheme，app 永远收不到 callback。
- 把浏览器会话复制进 WK / 第二个 profile：refresh token 单次轮换，两份副本必有一份失效。

## Consequences
- Google OAuth 对嵌入式 WebView 的默认 UA 回 `disallowed_useragent`，故 `customUserAgent` 固定为 Safari UA（Apple 登录不挑）；OAuth 的 `window.open` 在同一视图内导航，回跳后页面自己收尾。
- Passkey 在这条路线上不可用：Apple 要求 WKWebView 为 RP 配置 `webcredentials` associated domain（我们拿不到 fomo.family / Google 的 AASA 授权），隔离 WK 实测 Google passkey 在选择器出现前即失败；换 1Password 或 Apple Passwords 做 provider 也无济于事。登录只能走密码 / OAuth 账号流程。
- 页面遇到人机验证或会话失效时不做绕过：把常驻 WebView 亮成普通窗口让人点一下，`fomo.me` 拿到用户后自动收回；gmgn 侧 `GmgnBridge` 是同一模式（检测到挑战页标题自动亮窗）。
- 换 UA 不改 TLS 指纹：fomo REST 不经页面代发，而由 sidecar 用 wreq-js 伪装 Safari 指纹直发（见 `src/core/fomo.ts` 头注）。
