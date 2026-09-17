# Windows 开放交易：热钱包私钥用 DPAPI 加密落盘，先加固交易入口再放开

> 状态：提议（2026-09-17），待评估，未实施。

Windows 首版只读：`cli.ts` 在 win32 上给 Engine 传 `null` 交易依赖。0006 的交易链路（OKX 路由、viem / `@solana/web3.js` 签名、对账）全在 TS sidecar 里，与平台无关。Windows 缺的只有两样：`SecretStore` 的 Windows 实现（mac 的 `KeychainStore` 走 `security` CLI），以及 Electron 壳里的交易界面（mac 的交易卡在 Swift 里）。目标是与 mac **同等**而非更高的安全级别：热钱包的暴露面仍只有它自己的小额余额，「只放小钱」仍是主防线。

## Decision

**私钥存储**：新增 `DpapiFileStore implements SecretStore`。sidecar 用已随包的 koffi 调 `crypt32!CryptProtectData / CryptUnprotectData`（结果用 `kernel32!LocalFree` 释放），当前用户作用域，带 `CRYPTPROTECT_UI_FORBIDDEN`。

- 每个 `service/account` 对应一个文件，放在 `SECRETS_DIR`（默认 `%LOCALAPPDATA%\Fomomo\secrets\`），文件名为 `fomomo.wallet.evm.dpapi` / `fomomo.wallet.sol.dpapi`，内容就是 DPAPI blob。
- 读：文件不存在返回 `null`；文件在但解不开就抛错，不能当成「没有钱包」，否则界面会引导用户再生成一把。
- 写：先写临时文件，再用 `fs.linkSync` 链到正式路径（目标已存在则 EEXIST 失败），最后删掉临时文件。这样写入是原子的，文件系统层面也不会覆盖。语义比 Keychain 的 `-U` 更严，但唯一的写入方 `BurnerWallet.create` 本来就拒绝覆盖。
- 不加 `pOptionalEntropy`：常量写在开源代码里，挡不住有针对性的攻击，只会增加复杂度。
- `cli.ts` / `setup.ts` 按平台选 store；mac 的 `KeychainStore` 不动。

**开关**：首版用环境变量 `FOMOMO_WINDOWS_TRADE=1` 门控，先在小范围里试；验证后去掉门控，改为默认开启。`server.ts` 的 `tradeEnabled` 改为看 `engine.trade` 是否已装载；`main.cjs` 的 `capabilities.trade` 跟随 sidecar 的实际状态（收到 `trade_state` 才算可用），不再写死。

**入口加固**（放开交易之前必须完成）：

- `main.cjs` 的 `ALLOWED_COMMANDS` 加入 `trade_quote / trade / trade_quick / wallet_init`，这四个命令只接受 overlay 和 detail 窗口的 `webContents` 发来的。GMGN / fomo 窗口保持不挂 preload。
- `server.ts` 对所有请求校验 `Host`，只允许 `127.0.0.1:48765` 和 `localhost:48765`，挡 DNS rebinding。非 GET 请求若带了 `Origin` 且不是 dashboard 自己的，一律返回 403，挡 CSRF（现在 `POST /api/sources/*` 用 `text/plain` 就能跨站发出去）。不带 `Origin` 的请求（curl、本机脚本）照常放行，本机进程本来就有用户权限。
  - 现有的风险：通过 rebinding 进来的网页可以 `PUT /api/settings`，把 `maxUsdPerTrade` 调到 100000，并把 RPC 换成攻击者自己的 https 节点。这个节点在广播前就能看到已签名的交易，可以夹单，也可以谎报模拟结果。这项加固对 mac 同样生效。
- 下单仍只走 stdin bridge，HTTP 不新增任何下单接口。

**界面**：`detail.html` 加交易卡；`overlay.html` 加持仓区和行内闪电快捷买卖；新增生成热钱包 / 充值弹窗，充值地址除二维码外，还要放大显示首尾各 6 位，防剪贴板劫持。sidecar 事件已经全部经 `broadcastEvent` 转给各窗口，转发这边不用改；dashboard 的交易页现成可用。

## Considered Options

- **凭据管理器（`advapi32!CredWriteW / CredReadW`）**：底层也是 DPAPI，安全边界相同。好处是删掉数据目录钱包还在，用户也能在「凭据管理器」里看到，最接近 Keychain。坏处有三点：
  - 结构体编组麻烦；
  - 要靠 `GetLastError == ERROR_NOT_FOUND (1168)` 区分「没有」和「出错」，经 koffi 取这个值是否可靠未实测；
  - 它是 LaZagne 这类窃密工具默认会枚举的位置。

  以后若决定钱包要和数据目录分开存，这是首选替代方案。
- **`@napi-rs/keyring`**（keytar 的后继，统一封装 Win 凭据管理器 / mac Keychain / Linux Secret Service）：API 最干净，还能顺带消除 mac 上 `security add-generic-password -w` 让私钥短暂出现在进程参数里的问题。代价是多一个原生依赖：Windows 打包要像 `better-sqlite3-multiple-ciphers` 那样放进 `vendor/`，mac 上要逐个签 `.node`。留到想统一两端时再做。
- **Electron `safeStorage`**：只能在主进程里用，私钥得经 stdin 传给 sidecar，两个进程里都会有明文；`pnpm cli wallet-*` 也用不了。不采用。
- **启动口令（scrypt + AES-256-GCM，外层再包 DPAPI）**：只拿到磁盘或只拿到 DPAPI 都解不开，比 mac 更强。代价是每次启动都要输口令，忘了就丢钱；而且会话内已经在跑的木马（键盘记录、读内存）照样防不住。留作第二期的可选项。
- **TPM / Windows Hello**：Windows 的 TPM 提供程序不支持 secp256k1 / ed25519，不能直接签名，只能拿来包一层，私钥最终照样解到内存里。若每笔都要过 Hello，又违背 0006 要求的「零弹窗」。不采用。
- **Windows 继续只读**：零风险，但 Windows 用户没有一键买卖，只能去 GMGN 网页或用 mac 端。这是现状，也是评估不通过时的退路。

## Consequences

- 安全边界与 Keychain 相同：以当前用户身份运行的任何进程都能解密；拿走磁盘但不知道登录密码的人，以及本机其他用户，都解不开。README 的「热钱包边界」要补上 Windows 的说明。
- 删除 `%LOCALAPPDATA%\Fomomo` 就等于删除钱包（mac 的 Keychain 不受删除 Application Support 影响）。README 和任何「重置」流程都要明确提醒。
- DPAPI 与 Windows 用户配置绑定：重装系统、或管理员强制重置密码（用户自己改密码不受影响）之后就解不开，余额会被锁死。**上线前**要补「导出私钥」（二次确认，只显示一次）或「提走余额到指定地址」。这个功能两端共用，另开 ADR。
- 休眠文件 / 页面文件里可能残留私钥明文；README 建议开启 BitLocker 或设备加密。
- 发布包目前是未签名的 zip。开放交易后假包的危害明显变大，建议上代码签名，并在 release 附上 SHA256。
- 不新增 npm 依赖：koffi 已在 sidecar 打包清单里（微信取钥在用）。
- `Host` / `Origin` 校验对两端都生效：用其他主机名访问 dashboard 会得到 403。
- 落地时要同步改 README 里的几处说法：「Windows 首版为只读」「交易暂不启用」「不会在 Windows 上生成或使用 burner 钱包」。

## References

- `AzureAD/microsoft-authentication-library-for-js` 的 `extensions/msal-node-extensions`：DPAPI 加密文件持久化 + 文件锁的官方实现。
- `atom/node-keytar`（已归档）：Windows 凭据管理器的 C++ 调用写法，可对照着写 koffi 版本。
- `Brooooooklyn/keyring-node`：即 `@napi-rs/keyring`。
- `floating-frame/frame`：Electron 桌面钱包，hot signer 跑在独立子进程，私钥用口令加密，超时锁定。
- `MetaMask/browser-passworder`、`hummingbot/hummingbot`：口令加密 vault 的做法，以及「启动时解锁一次、会话内免确认」的交互。
