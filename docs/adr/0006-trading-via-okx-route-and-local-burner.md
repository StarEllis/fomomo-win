# 一键买卖走 OKX DEX 路由 + 本机 burner 热钱包，不用 fomo.family 站内 swap

一键买卖 = 向固定接口端点取 OKX DEX 报价 / 路由与未签名交易（客户端不持有凭据），本机 Keychain 里一把独立的 burner 热钱包 eth_call 模拟后签名，经公共 RPC 广播、等回执。fomo.family 只剩信号源，不再碰交易；其站内 swap 执行半边已于 2026-09-09 删除。
选它是因为目标单是 $10–100 的 Robinhood / BSC meme，需要「点一下 1–2s 上链、零弹窗」，而 burner 的暴露面只有它自己的余额（建议 ≤ 数百美元），主钱包不进这台机器。

## Considered Options

- fomo.family 站内 swap（在 WKWebView 里调前端导出的交易函数或 DOM 自动化）：签名只能发生在页面世界的 Privy iframe（on-device 分片，Node 拿不到），报价 → userOp → 跨链 fill 的执行链路完全不可控（每笔都是 Solana USDC ↔ EVM 的跨链 swap，5–15s、小单跨链成本占 2–15%），前端 bundle 名随部署天天变，且 ToS §16 明文禁止「automated means to execute trades」——封号连带 owner 的社交身份与全部站内资产。
- 导出 fomo 钱包私钥当热钱包（为了在 fomo 上「打榜」）：地址永久变热钱包，本机被攻破 = fomo 全部余额暴露；未采用。
- 每笔 WalletConnect / 浏览器钱包确认：私钥零暴露，但 10s+ 且要切窗口，一键体验最差。
- 托管式签名服务：私钥不在本机看似更安全，但服务端风控 / 地区门随时会打断一键流程，且 token 成为唯一信任根，暴露面反而更大。

## Consequences

- 单子不在 fomo 上，followers 看不到；社交归因与执行彻底解耦。
- 绝不自动重发；同地址有未落定记录时拒新意图；等回执超时进 `unknown`，对账循环 30 分钟无回执按 failed。
- 私钥与 OKX 相关配置永不进日志 / 事件（`wallet.ts` 只暴露地址与签名 / 发送）。
