# 「fomo 前排比例」的口径

fomo 前排比例 = fomo 全站前 n（≤50）名持有人代币数合计（`GET /hodlers/top`，服务端最多 50 行）÷ gmgn 前排前 n（≤50）名代币数合计（`/vas/api/v1/token_holders` 一页 100 行，**仅排除 pool**，即 `addr_type === 2`；燃烧地址 / 交易所钱包 / dev 保留）。
两边都是人类单位代币数，同一供应量约掉，不需要也不去猜 totalSupply；可以 > 1。两源必须同一轮都成功才出数：任一侧没拿到 / 字段缺失 / 响应不是请求的币 / 分母为 0 → `ratio = null` + `why`，UI 显示「—」，绝不给部分值。

## Considered Options

- 同时排除燃烧 / 交易所钱包 / dev：用户口径是「只排除 pool」（pool 是 LP 不是持有人，其余都算「拿着币的人」）；gmgn 对 dev 没有显式标记，交易所钱包与普通钱包同为 `addr_type 0`，只能靠 `name` 猜；再排除是一次明说的口径变更。
- 按 `exchange` 名称白名单识别 pool：`uniswap_v3/v4` 只是样本里见到的例子，不是完整集合；`addr_type` 才是显式字段。
- 做 fomo 用户钱包与 gmgn 地址的交集（「前排里有多少是 fomo 人」）：是另一个指标，未采用。
- gmgn 非 pool 不足 50 时按实际 n 出数：只有服务端明确说没有更多且不满一页才算取尽（UI 标「Top n」）；否则前排被截断而该端点续页契约未验证，按不可用处理，不把截断值标成 Top50。

## Consequences

- 只对焦点币在既有 15s tick 上顺带拉两源（单飞、同轮）；主面板显示行经串行队列 ≥45s 一刷；快照 >60s 过期为 null。
- gmgn 一行缺 `balance` / `addr_type` 就整体抛错，不把没标记的行当普通钱包。
