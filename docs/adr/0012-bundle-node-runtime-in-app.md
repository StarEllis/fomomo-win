# `.app` 随包带 Node 22 二进制 + 只含 native addon 的 node_modules，sidecar 用 esbuild 打成单文件

分发给群友的 `Fomomo.app` 不能要求对方装 Node / pnpm / lark-cli。Raycast v2 的做法（Swift 壳 + 长驻 Node 后端 + 随包 Node 运行时）和本项目同构，Electron 也是同一套（运行时随包、`.node` 落盘逐个签），所以照做：`Resources/node/bin/node` 是 nodejs.org 官方 arm64 二进制（SHASUMS 校验、版本钉 `.node-version`），`Resources/sidecar/cli.mjs` 是 esbuild 的 ESM 单文件（`better-sqlite3-multiple-ciphers`、`wreq-js` 标 external，留在旁边的 `node_modules/` 里用 npm 装成扁平树），`Resources/bin/lark-cli` 是 `@larksuite/cli` 的 Go 二进制。Swift 只按 `Resources/sidecar/cli.mjs` 是否存在切模式，开发模式一切照旧。

## Considered Options

- **Node SEA（官方单文件）**：能把 `.node` 当 asset 塞进 blob，但运行时必须先写到临时目录再 `process.dlopen`，两个 addon 都要手写胶水；主脚本必须是 CJS 而项目是 ESM；node 本体还在里面，体积省不了。多一层脆弱性换不来收益。
- **pkg / yao-pkg**（Tauri 教程的 sidecar 套路）：vercel/pkg 已废弃转向 SEA，yao-pkg 自标 macos-arm64 experimental，native addon 要关字节码绕。
- **Bun `--compile`**：能嵌 napi `.node`，包体约 50MB；但 `better-sqlite3` 系明确不支持 Bun（Bun 有自己的 `bun:sqlite`），要重写 SQLCipher 读库层并把 `ws` / `viem` / `@solana/web3.js` 全部换运行时重验。为省 60MB 换整套运行时，不值。
- **首启按需下载 node**（Raycast v1）：安装包缩到 ~20MB，但多一条网络依赖、国内拉 nodejs.org 慢。留作以后的优化。

## Consequences

- 包约 183MB（node 106 + lark-cli 44 + node_modules 25），zip 57MB。用户端不再有「node 大版本和 addon ABI 不匹配」这类问题——两者由同一个构建脚本按 `.node-version` 锁在一起。
- 代码目录变成签名封住的只读区，可写数据（sqlite、微信密钥）必须在 `~/Library/Application Support/fomomo/`；`config.ts` 用 `import.meta.url` 定位代码目录，开发 / 打包两种布局下相对路径一致。
- 签名：Resources 下每个 Mach-O 单独签，node 侧只需 `com.apple.security.cs.allow-jit`。ad-hoc 时不能开 hardened runtime（library validation 要求 node 与 addon 同一 Team ID），所以本地 / 无证书的 CI 构建首次打开要右键放行；配了 Developer ID 与 App Store Connect key 的 CI 才产出公证过的包。
- WKWebView 的持久数据仓（gmgn / fomo 登录态）路径含 bundle id，从裸二进制迁到 `.app` 后各要重过一次验证 / 登录。
