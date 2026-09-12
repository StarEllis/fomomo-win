# 业务逻辑全在 TypeScript sidecar，Swift 只负责展示

悬浮窗是原生 SwiftUI，但群监听、地址抽取、行情编排、喊单定价、交易、存储、dashboard 全部放在 Swift 拉起的 Node sidecar 里，两者只通过 stdout / stdin 的 JSON Lines 通信（契约在 `src/core/types.ts`）。这样 dashboard / 统计 / 设置这类以后很可能是网页的东西和引擎共用一份逻辑，TS 迭代快、可用假 Swift 无 GUI 回归；Swift 缩成「浮窗 + 页面内请求代发 + 渲染」，解码时忽略未知键。

## Consequences

- 任何字段要给界面看，先进 `types.ts` 的 `TokenView` / 事件联合，再让 Swift 解码；Swift 不解析任何第三方响应。
- sidecar 崩溃由 Swift 退避重启；`.node-version` 钉住 Node 22，native addon 的 ABI 绑在这个版本上。
