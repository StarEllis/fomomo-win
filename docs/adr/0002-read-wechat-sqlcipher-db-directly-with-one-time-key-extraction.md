# 直接只读微信本地 SQLCipher 原库，密钥用 LLDB 一次性提取（副本模式）

微信 macOS 4.x 的聊天库是 SQLCipher 加密的，没有任何官方 / 稳定的读取接口。我们用 `wcdb-key-tool` 在 LLDB 断点里抓一次 passphrase，把每个库的 raw key 缓存到本机 `secrets/all_keys.json`，之后用 `better-sqlite3-multiple-ciphers` **只读**打开原库、按需在内存里解密，绝不写入、不全量导出。提取密钥要去掉微信的 Hardened Runtime（ad-hoc 重签），而重签会让微信丢失截图 / 录屏的 TCC 权限，所以默认把微信复制一份到 `~/WeChat-extract.app` 只签副本、提完删除，`/Applications` 原版始终保持腾讯签名。

## Considered Options

- `wechat-cli` 之类第三方读取工具：多一层进程和格式转换，且同样依赖抓密钥，不如自己用 SQLCipher 引擎直读。
- 原地重签 `/Applications` 微信（`--in-place`）：能省一次拷贝，但会破坏截图权限，只留作显式选项。
- 走微信自动化 / 网页协议：违反使用条款且有封号风险，不考虑。

## Consequences

- 只有退登 / 换号（passphrase 变）或新增消息分片（新 salt）时才需重提密钥。
- 读的是正被微信写入的库：会遇到 `database is locked`，终端缺「完全磁盘访问权限」时是 `EPERM`。
