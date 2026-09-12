# fomomo（macOS 原生悬浮窗）

SwiftUI + AppKit。左侧常驻、不抢焦点、置顶、跨 Space 的浮动面板，只负责展示与页面内请求代发；业务逻辑在仓库根 `src/` 的 TypeScript sidecar。
`Sidecar.swift` 按 `Bundle.main.resourceURL/sidecar/cli.mjs` 是否存在分两种模式：打包模式用 `Resources/node/bin/node cli.mjs run`（cwd = `Resources/sidecar`，`FOMOMO_LARK_CLI` 指向 `Resources/bin/lark-cli`）；开发模式（`swift build` 的裸二进制）用 fnm / nvm 里 `.node-version` 那个 node 跑 `node --import tsx src/cli.ts run`。
使用方法见 [../README.md](../README.md)，架构见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

## 构建

需要 Xcode 26 / Swift 6。

```bash
swift build && .build/debug/Fomomo      # 开发模式；或 swift run；Ctrl-C 退出
./build.sh                              # 沙盒环境（SwiftPM 的 sandbox-exec 起不来时）直调 swiftc，产物等价
./build.sh smoke && .build/debug/smoke  # 无 UI 冒烟：Tests/smoke.swift（Fmt / 快照解码 / Feed 弹卡规则 / 交易门禁）
../scripts/build-app.sh                 # 打包 ../dist/Fomomo.app（swift release + 自带 Node + sidecar + lark-cli，签名）
```

或用 Xcode 打开 `Package.swift`，运行 Fomomo scheme。日志在 `~/Library/Logs/fomomo.log`。

`Info.plist`（`LSUIElement`、`__VERSION__` 占位）、`Fomomo.entitlements`（空）、`Sidecar.entitlements`（只有 `allow-jit`，签 node / lark-cli / *.node）由 `scripts/build-app.sh` 使用；`swift build` 不读它们。

## 文件

```
Package.swift
Sources/Fomomo/
  main.swift          入口（accessory 应用）
  AppDelegate.swift   启动时创建悬浮窗
  OverlayPanel.swift  NSPanel 配置（悬浮/不抢焦点/置顶/跨Space）；主面板贴左缘、内部上下拖动、
                      右/上/下边 + 沿右侧圆角可见圆弧悬停/斜向拖拽改尺寸（ResizeEdgeView / PanelResize，不用 .resizable），
                      尺寸经 PanelSizeStore 存回 sidecar 设置；右侧弹卡子窗口
  Theme.swift         fomo 配色 + 毛玻璃背景（GlassBackground(opacity:)：主面板背景不透明度来自设置 panel.backgroundOpacity）
  Model.swift         Token + Feed（@Observable）+ PanelSize 限值 + TradeState / TradeQuote / Trade / TradeHolding（sidecar trade_*）
                      未监听持仓也异步加载完整详情；token_detail 更新卡片但不加入群聊列表，按地址+链隔离。
                      余额刷新保留已加载资料，清仓不被迟到详情复活；K线错误/空数据不再永久显示加载中。
  CandleChart.swift   市值蜡烛 + 当前持仓买入/卖出均价水平线（绿/红）；均价来自本地账本（confirmed 买卖），没成交不画。
                      USD 均价按同一行情 mc/price 换算，标出单价与市值；清仓/切链随持仓清除。
  Views.swift         PanelView（头 / 代币列表 / 底部「持仓」区 HoldingRowView / 页脚）/ 行 / 弹出卡 / TradeCard / 折线K线
                      持仓区与交易卡门禁 = tradeState.ready（本地 burner 钱包 + OKX 已配）；持仓默认隐藏价值 < $2 的代币，仅过滤显示。
                      闪电展开行内买/卖预设（设置 presets：买 = 原生币数量按 ETH/BNB/SOL/MON 分组，卖 = 持仓比例），点直接交易，无二次确认；点币名仍开详情。
                      在途/未知结果锁定，清仓后暂留状态反馈；最小 280×300 自动滚到完整两排控件。
                      交易卡：买入输入原生币数量（旁标 ≈$，价来自 trade_state.balances[chain].price，没价不显示），卖出只有比例瓦片；报价一次性（手输 400ms 防抖、快捷额立即），
                      报价在飞时先灰色显示本地估算「≈N TOKEN · 估算」（数量 × 原生币价 ÷ 代币价，照 gmgn，0 请求），OKX 真报价到了换实数；
                      显示「N 秒前」>30s 变灰不自动重报；蜜罐/税橙色警示；余额不足按原生币数量本地判，单笔/日上限只在有价时本地判（sidecar 终判）。
                      弹卡 Token 信息右侧显示持仓数量/估值、累计买入/卖出、盈亏；窄宽度改排信息下方，仍在K线上方。
```
