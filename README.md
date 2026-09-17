# fomomo-win

Windows 桌面端「群喊单」监控悬浮窗。基于 [nishuzumi/fomomo](https://github.com/nishuzumi/fomomo) 移植，Electron 外壳，逻辑复用原项目的 TypeScript sidecar。

它会监听你选定的飞书 / 微信 / QQ 群。群里一出现代币合约地址就记下来，并显示实时行情、K 线、喊单后的涨跌、喊单人和喊单次数。有新币时会主动弹卡提醒。

> 当前 Windows 版**只读监控，不能交易**。开放交易的方案见 [docs/adr/0013](docs/adr/0013-windows-trading-with-dpapi-burner-store.md)，还在评估中。

<p align="center">
  <img src="docs/screenshots/panel.png" width="300" alt="主面板" />
</p>

> 截图来自 macOS 版，内容为演示数据。Windows 版的布局与其一致。

## 功能

- **悬浮窗**：贴在屏幕边缘并置顶，不抢焦点。每行显示一个代币的符号、链、来源、首个喊单人及其历史胜率、喊单人数、迷你走势、市值、首喊以来涨跌和距首喊的时间。
  - 支持多种排序，可按来源或链快速筛选。
  - 搜索框可以搜代币名、合约地址、喊单人和群名。
  - 右键菜单可隐藏代币。
  - 收起后的小图标可以拖动，位置会被记住。
- **弹卡**：包含以下内容：
  - 1s–1d 市值 K 线：滚轮缩放，拖动平移，双击复位。点喊单标记可以切换群聊语境。
  - 群内喊单原文与前后文。
  - 官方推特及中文译文。
  - GMGN 喊单（GMGN / X 两个页签）。
  - fomo.family 关注者动向与 Thesis。
- **提醒**：
  - 新币默认自动弹卡，6 秒后收起，点一下可以钉住。也可以改成只发系统通知，或者关掉。
  - 提醒条件可设：至少几人喊、市值范围、只看哪些链、喊单人的历史胜率。
  - **老币回暖**：首喊已超过 1 小时的币，如果 30 分钟内又有多人喊，也会提醒。行上会显示 🔥 和人数。
  - 弹卡顶部会写明这次提醒的原因。
- **全局快捷键**：在任何程序里按 `Ctrl+Alt+F` 都能显示或隐藏悬浮窗。
- **dashboard**（本地网页）：包括总览、群组勾选、喊单人战绩、代币列表、24h 战况和各项设置。

## 环境要求

- Windows 10 / 11，x64
- 安装包已自带 Node 运行时和 lark-cli，不需要另外安装 Node 或 pnpm

## 安装与构建

```powershell
corepack pnpm install
corepack pnpm windows:build
```

产物都在 `dist/windows/` 里：

- `fomomo-<版本>-win-x64-setup.exe`：安装程序，可以选安装目录，并创建桌面和开始菜单快捷方式。
- 便携压缩包：解压后直接运行 `fomomo.exe`。

开发调试可以直接运行 `corepack pnpm windows:dev`。

数据保存在 `%LOCALAPPDATA%\Fomomo`，卸载时不会删除。

## 首次使用：配置群来源

第一次启动时会自动打开群组设置。任意配好一个来源就能开始用。

### 飞书

1. 点「创建应用并登录」。程序会在浏览器里创建一个只读权限的飞书应用，并完成授权。整个过程用的是你本人的账号，不需要把机器人拉进群。
2. 授权完成后，勾选要监听的群，点「保存」。

飞书请求会直接连接，不走本机代理。

### 微信 4.x

程序会从正在运行的 `Weixin.exe` 里自动获取数据库密钥；如果获取失败，可以手动粘贴 64 位密钥。

微信数据库以只读方式打开，程序不会导出聊天内容。取密钥用的是 CipherTalk 的 `wechat_key_tool.dll`，该组件采用 CC BY-NC-SA 4.0 许可，不可商用。

### QQ（通过 NapCat / OneBot 接入）

1. 安装并启动 [NapCat](https://napneko.github.io/)，扫码登录。
2. 在 NapCat 里打开「网络配置 → OneBot 11 → 正向 WebSocket」，地址填 `127.0.0.1`，端口填 `8080`。
3. 在 Fomomo 里打开「群组 → QQ」，点「启用 QQ 监听」。连接成功后勾选要监听的群，点「保存」。

地址和 Token 可以在「设置 → QQ 连接」里修改，改完不用重启程序。

> 这种方式依赖非官方 QQ 协议，可能会掉线，也有账号被风控的风险。建议使用专用 QQ 号。

### gmgn 验证

行情数据来自 gmgn。底栏的 `gmgn` 变成红点时，点它打开内置窗口，完成一次 Cloudflare 验证后关掉窗口即可。

## 开发

- Node **22**，版本见 `.node-version`。SQLite 原生模块是按 Node 22 的 ABI 编译的，换其他大版本会跑不起来。
- 类型检查与测试：`corepack pnpm typecheck`、`corepack pnpm test`
- 界面冒烟测试：`corepack pnpm exec electron test/windows-ui-smoke.cjs`
- 重新生成图标：`corepack pnpm exec electron scripts/make-windows-icons.cjs`（源文件是 `windows/assets/tray.svg`）

目录结构：

| 路径 | 内容 |
|---|---|
| `windows/` | Electron 主进程、悬浮窗、弹卡与提醒 |
| `src/` | 共用的 TypeScript sidecar，负责群来源、行情和数据存储 |
| `scripts/build-windows.ps1` | Windows 打包脚本 |
| `docs/` | 架构说明、ADR 决策记录，以及 [macOS 版原说明](docs/README-macos.md) |

## 安全与隐私

- 所有数据只保存在本机。应用自己的数据库只存喊单原话和少量上下文，不保存完整群聊。
- 飞书凭据由 lark-cli 管理。程序不保存 QQ 密码，也不持有任何交易所凭据。
- 日志只记录状态信息，不记录聊天正文。

## 致谢

- 原项目：[nishuzumi/fomomo](https://github.com/nishuzumi/fomomo)
- 微信取密钥：CipherTalk `wechat_key_tool.dll`（CC BY-NC-SA 4.0）
