# sidecar 所有 Node 出站统一经系统代理（`proxy.ts`）

开发机的系统 DNS 会把 `api.dexscreener.com` / `gmgn.ai` 之类域名劫持到假 IP 或 `0.0.0.0`，WKWebView 走 macOS 系统代理所以正常，而 Node 的 `fetch` / `ws` 不看系统代理，直连必超时。所以 sidecar 的每一个出站请求都从 `proxy.ts` 拿 Agent：优先 `HTTPS_PROXY` / `ALL_PROXY`，否则 `scutil --proxy` 探测（30s 缓存），有代理就走自写的 HTTP CONNECT 隧道 + `tls.connect`，没代理就走保活的直连 Agent，行为不变。

## Considered Options

- Node 22 的 `--use-env-proxy` / undici `ProxyAgent`：要在进程启动前给参数，而 sidecar 由 Swift 拉起、Node 内置 undici 又不对外暴露；不想让 Swift 感知网络配置。
- 只修 DNS：不可控，且群友的机器各不相同。

## Consequences

- CONNECT 隧道里的 TLS 不能设 ALPN：ClientHello 多一个扩展就会被带人机验证的站点（gmgn 等）判成机器人（403 challenge）。
- 直连 Agent 空闲 socket 保留 2 分钟而不是 Node 默认的 5 秒，省掉每次报价前的 TLS 握手。
