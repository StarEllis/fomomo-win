# fomo.family 信号只取自站内 WS + REST，凭据留在页面里

「我关注的人买了什么」这一口径只有 fomo.family 自己有，所以信号直接取自它的私有后端：WS `trading_activity:<me>` 推每笔关注者买卖 / Thesis，REST `POST /hodlers/friends`（关注者当前持有人数）、`GET /feed/tradingActivity`（回灌最近 24h）、`GET /feed/token/thesis`（弹卡 Thesis 列，全站用户）补齐。
凭据由常驻 WKWebView 里页面自带的 Privy SDK 持有并自行续期；sidecar 每次用前经 rpc 取当前 access token，**不碰 refresh token**（refresh 是一次性轮换的，借走就把浏览器登出）。REST 由 Node 直发，但 TLS / HTTP2 指纹按 Safari 伪装（`wreq-js`），因为 fomo 的请求画像门对 Node 原生栈一律 430。

## Considered Options

- 拿关注者的 fomo 钱包地址去 gmgn 逐笔匹配：gmgn 成交流不带 maker，得对 21 人 × 5 链轮询钱包活动，请求量 ×100，且成交口径与站内 Alerts 对不上；只作降级备选，未实现。
- sidecar 自己登一条 Privy 会话：fomo 的 Privy 只开 Google / Apple / Twitter OAuth（无邮箱 OTP），回跳必须落在浏览器里，sidecar 独立完成不了。
- REST 全部经 WKWebView 页内 fetch（rpc）：能过门，但多一跳且依赖页面已加载；Node 侧能过就不留那条路。
- fomo 推送通知 / 单币 `/feed/token` 轮询 / Telegram bot：不完整或不可编程。

## Consequences

- fomo ToS §16 明文禁止自动化提取交易数据；这里是个人自用、只读、低频（一条 WS + 15s 一次批量 POST），**绝不伴随自动交易**，账号风险由 owner 自担。
- 430/431 = 指纹拒绝、429 = 限流：只记日志并退避 60s×2 到 30min，不重试；`/feed/tradingActivity` 连翻 4 页是配额上限。
- 只对我们列表里的币落库（`fomo_activity`），其它 alert 只留内存 24h，避免变成第二个 Alerts 面板。
