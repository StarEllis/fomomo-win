// 无 UI 冒烟：Fmt 格式化 + sidecar state 快照解码 + Feed 弹卡规则。
// 业务逻辑（抽地址/行情/落盘/自喊单涨跌）在 TS sidecar，这里不再测；见 `pnpm cli run` 与 /tmp 级别的假 Swift 脚本。
// 编译：`./build.sh smoke`
import Foundation

@MainActor
func run() async {
    print("== Fmt ==")
    for v in [1_240_000.0, 318_000.0, 44_000_000.0, 2_100_000_000.0, 950.0] { print(v, "→", Fmt.compact(v)) }
    print(Fmt.pct(42.34), Fmt.pct(-18.2), Fmt.pct(1424.2), Fmt.pct(20528.9), Fmt.pct(61.7, approx: true), Fmt.pct(nil))

    print("\n== state decode (与 src/core/types.ts TokenView 对齐) ==")
    let json = """
    [{"address":"0xcc9c1ec224c3824ae5ea699ec72ef5fad4165e49","chainHint":null,
      "market":{"symbol":"DINO","name":"Dino","chain":"robinhood","price":0.00123,"mc":1230000,"liq":45000,"change1h":5.5,"holders":321,"source":"gmgn","updatedAt":1788324300},
      "mentions":[{"sender":"甲","time":1788324279,"text":"0xcc9c…","group":"10000000001@chatroom","price":0.001,"mc":1000000,"approx":true}],
      "spark":[0.1,0.5,0.9],"live":true,"trend":1,"change":23.0,"changeApprox":true,"kol":1,"avg":0.001,"firstSeen":1788324279,"lastSeen":1788324279,
      "links":{"twitter":"https://x.com/dino"},"ath":{"price":0.002,"mc":2000000,"time":1788324500},"profile":null,"official":[],"twitterRequest":{"status":"error","error":"X 搜索: HTTP 429"},
      "tweets":[{"id":"1","url":"https://x.com/a/status/1","time":1788324400,"kind":"tweet","user":{"name":"A","screen":"a","avatar":"","followers":12000,"verified":true},"text":"dino to the moon"}]},
     {"address":"0x5686d17ad04e48cead159214d03113bfa69a9bd2","chainHint":"bsc","market":null,"mentions":[{"sender":"乙","time":1788324400,"text":"冲","group":"10000000002@chatroom","approx":false}],
      "spark":[0.5,0.5],"live":false,"trend":1,"change":null,"changeApprox":false,"kol":1,"avg":null,"firstSeen":1788324400,"lastSeen":1788324400,"links":null,"ath":null,"profile":null,"official":[],"twitterRequest":{"status":"no_link","error":null},"tweets":[]}]
    """
    let tokens = try! JSONDecoder().decode([Token].self, from: json.data(using: .utf8)!)
    print("decoded:", tokens.map { "\($0.symbol)/\($0.chain) resolved=\($0.resolved) change=\(Fmt.pct($0.change, approx: $0.changeApprox)) live=\($0.live) spark=\($0.sparkPoints.count) tweets=\($0.tweets.count) tw=\($0.links?.twitter ?? "-") group=\($0.mentions[0].group)" })
    print("agoShort:", Fmt.agoShort(Date(timeIntervalSinceNow: -42), now: Date()), Fmt.agoShort(Date(timeIntervalSinceNow: -400), now: Date()), Fmt.agoShort(Date(timeIntervalSinceNow: -7200), now: Date()), "followers:", Fmt.followers(12000), Fmt.followers(890))
    print("unresolved shows shortAddr:", tokens[1].symbol == tokens[1].shortAddr, "chain from hint:", tokens[1].chain)

    print("\n== Feed popup rules ==")
    let feed = Feed()
    feed.applyState(tokens)
    print("popup after state (should be nil):", feed.popup as Any)
    // 弹卡改为等语境到了再亮（Feed.present，仅 link == .connected 时等）：这里立刻打 popup 会是 "-"，喂一条同地址语境才亮
    feed.link = .connected
    func ctx(_ a: String) -> CallContext { CallContext(address: a, sender: "", ts: 0, group: "", lines: [], call: -1) }
    feed.newToken(tokens[1].address)
    print("new_token before context → popup (should be -):", feed.popup?.shortAddr ?? "-")
    feed.applyContext(ctx(tokens[1].address))
    print("new_token → popupAuto:", feed.popupAuto, "fresh:", feed.freshID ?? "-", "popup:", feed.popup?.shortAddr ?? "-")
    feed.openDetail(tokens[0])
    feed.applyContext(ctx(tokens[0].address))
    print("openDetail → popupAuto:", feed.popupAuto, "popup:", feed.popup?.symbol ?? "-")
    // 新快照里 popup 对应代币更新了 → popup 跟着换
    let updated = try! JSONDecoder().decode([Token].self, from: json.replacingOccurrences(of: "\"change\":23.0", with: "\"change\":99.0").data(using: .utf8)!)
    feed.applyState(updated)
    print("popup follows state:", Fmt.pct(feed.popup?.change))
    feed.dismissPopup()
    print("dismiss → popup:", feed.popup as Any)

    print("\n== Auto-popped card follows the token once its chain resolves ==")
    // 新币 new_token 时行情还没到（market=null、chainHint=null → chain "?"），~0.5s 后 state 才带链和行情；
    // 卡不能停在打开那一刻的快照上，否则行情 / 推特 / fomo / 报价全部永远空着，只能关了重开。
    var unresolvedPayload = (try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]])[0]
    unresolvedPayload["market"] = NSNull()
    unresolvedPayload["chainHint"] = NSNull()
    unresolvedPayload["tweets"] = [] as [Any]
    let unresolved = try! JSONDecoder().decode(Token.self, from: JSONSerialization.data(withJSONObject: unresolvedPayload))
    precondition(unresolved.knownChain == nil && unresolved.market == nil)
    let lateFeed = Feed()
    lateFeed.link = .connected
    lateFeed.applyState([unresolved])
    lateFeed.newToken(unresolved.address)
    lateFeed.applyContext(ctx(unresolved.address))
    precondition(lateFeed.popup?.knownChain == nil && lateFeed.popupAuto)
    lateFeed.applyState(tokens) // 行情到了：同地址、链从 "?" 变成 robinhood
    precondition(lateFeed.popup?.market?.mc == tokens[0].market?.mc, "auto-popped card must pick up market once the chain resolves")
    precondition(lateFeed.popup?.tweets == tokens[0].tweets, "late tweets must reach the open card")
    lateFeed.dismissPopup()
    // 入场中（pending，还没亮）时行情先到：亮出来的必须是带行情的那份
    lateFeed.applyState([unresolved])
    lateFeed.newToken(unresolved.address)
    lateFeed.applyState(tokens)
    lateFeed.applyContext(ctx(unresolved.address))
    precondition(lateFeed.popup?.market?.mc == tokens[0].market?.mc, "pending card must commit the resolved token")
    lateFeed.dismissPopup()
    print("auto card and pending card both follow the resolved token")

    print("\n== Holding detail survives balance refresh ==")
    let holdingFeed = Feed()
    let holding = TradeHolding(address: tokens[0].address, chain: "robinhood", symbol: "DINO", name: nil, logo: nil,
                               amount: 10, price: 1, usd: 10, boughtUsd: 0, soldUsd: 0, pnlUsd: nil, pnlPct: nil, heldSince: nil, tradePrices: nil)
    holdingFeed.applyHoldings([holding], at: Date())
    holdingFeed.openHolding(holding)
    // 社交先到、行情未到：仍用持仓身份显示，但下一份余额不能清空已到的详情。
    var payload = (try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]])[0]
    payload["market"] = NSNull()
    payload["chainHint"] = "robinhood"
    payload["holdingOnly"] = true
    let partial = try! JSONDecoder().decode(Token.self, from: JSONSerialization.data(withJSONObject: payload))
    holdingFeed.applyTokenDetail(partial)
    holdingFeed.applyHoldings([holding], at: Date())
    precondition(holdingFeed.popup?.links?.twitter == tokens[0].links?.twitter)
    precondition(holdingFeed.popup?.tweets == tokens[0].tweets)
    precondition(holdingFeed.popup?.position?.amount == 10)
    let complete = tokens[0].with(position: TradePosition(amount: 100, usd: 100), holdingOnly: true)
    holdingFeed.applyTokenDetail(complete)
    holdingFeed.applyHoldings([], at: Date())
    holdingFeed.applyTokenDetail(complete)
    precondition(holdingFeed.popup?.position?.amount == 0)
    precondition(holdingFeed.popup?.market?.mc == tokens[0].market?.mc)
    precondition(holdingFeed.tokens.isEmpty)
    print("partial social data retained; full metadata retained; late detail cannot resurrect sold balance")
    holdingFeed.link = .connected
    let baseHolding = TradeHolding(address: holding.address, chain: "base", symbol: "BASE", name: nil, logo: nil,
                                   amount: 8, price: 1, usd: 8, boughtUsd: 0, soldUsd: 0, pnlUsd: nil, pnlPct: nil, heldSince: nil, tradePrices: nil)
    holdingFeed.openHolding(baseHolding)
    let bar = Bar(t: 100, o: 10, h: 11, l: 9, c: 10, v: 1)
    holdingFeed.applyKline(Kline(address: holding.address, chain: "base", resolution: "1m", bars: [bar], covered: (0, 200), calls: [], error: nil))
    holdingFeed.applyKline(Kline(address: holding.address, chain: "robinhood", resolution: "1m", bars: [], covered: (0, 200), calls: [], error: "old response"))
    precondition(holdingFeed.klines["1m"]?.chain == "base" && holdingFeed.klines["1m"]?.bars == [bar])
    let wxMark = CallMark(t: 100.125, sender: "同名", group: "wx@chatroom")
    let feishuMark = CallMark(t: 100.125, sender: "同名", group: "feishu:oc_group")
    let wxChart = Kline(address: holding.address, chain: "base", resolution: "1m", bars: [bar], covered: (0, 200), calls: [wxMark], error: nil)
    let feishuChart = Kline(address: holding.address, chain: "base", resolution: "1m", bars: [bar], covered: (0, 200), calls: [feishuMark], error: nil)
    precondition(wxChart != feishuChart, "same-count chart updates must retain source-specific call markers")
    precondition(feishuChart.merging(Bar(t: 160, o: 10, h: 12, l: 9, c: 11, v: 1)).calls == [feishuMark])
    holdingFeed.dismissPopup()
    print("pending new-chain chart survives a late response while the old card is still visible")

    print("\n== Rejected address cannot linger or cancel another card ==")
    let hiddenFeed = Feed()
    hiddenFeed.link = .connected
    hiddenFeed.applyState(tokens)
    hiddenFeed.openDetail(tokens[1])
    hiddenFeed.applyContext(ctx(tokens[1].address))
    hiddenFeed.openDetail(tokens[0]) // 新卡 pending，旧的非代币仍可见
    hiddenFeed.applyState([tokens[0]])
    hiddenFeed.tokenHidden(tokens[1].address)
    precondition(hiddenFeed.popup == nil)
    hiddenFeed.applyContext(ctx(tokens[0].address))
    precondition(hiddenFeed.popup?.address == tokens[0].address)
    hiddenFeed.tokenHidden(tokens[0].address) // 新 state 已恢复的币，不受旧通知影响
    precondition(hiddenFeed.popup?.address == tokens[0].address)
    hiddenFeed.applyState([])
    hiddenFeed.tokenHidden(tokens[0].address)
    precondition(hiddenFeed.popup == nil)
    hiddenFeed.openDetail(tokens[1])
    hiddenFeed.tokenHidden(tokens[1].address) // 取消尚未入场的非代币
    hiddenFeed.applyContext(ctx(tokens[1].address))
    try? await Task.sleep(for: .milliseconds(120))
    precondition(hiddenFeed.popup == nil)
    hiddenFeed.openHolding(holding)
    hiddenFeed.applyContext(ctx(holding.address))
    hiddenFeed.tokenHidden(holding.address)
    precondition(hiddenFeed.popup?.isHoldingOnly == true)
    hiddenFeed.dismissPopup()
    print("hidden tracked/pending cards close; unrelated pending, recovered token and real holding survive")

    print("\n== Trade state: buy in native units, USD limits only when a price is cached ==")
    // 与 src/core/types.ts TradeStateEvent / TradeQuoteEvent 对齐：balances 带 price（DexScreener 缓存，拉不到为 null），presets.buy 按原生币符号分组
    let tradeJSON = """
    {"ready":true,"reason":null,"evmAddress":"0xabc","solAddress":null,
     "balances":{"bsc":{"native":0.05,"symbol":"BNB","price":null,"usd":null},
                 "robinhood":{"native":0.05,"symbol":"ETH","price":4000,"usd":200}},
     "presets":{"buy":{"ETH":[0.002,0.01,0.02,0.1],"BNB":[0.007,0.035,0.07,0.35],"SOL":[0.05,0.25,0.5,2.5],"MON":[200,1000,2000,10000]},"sell":[25,50,100]},
     "limits":{"perTrade":100,"perDay":130,"dayUsed":60},"at":1788324300}
    """
    let tstate = try! JSONDecoder().decode(TradeState.self, from: Data(tradeJSON.utf8))
    precondition(tstate.buyPresets(chain: "bsc") == [0.007, 0.035, 0.07, 0.35] && tstate.nativeSymbol(chain: "bsc") == "BNB")
    precondition(tstate.buyPresets(chain: "sol") == [0.05, 0.25, 0.5, 2.5] && tstate.nativeSymbol(chain: "sol") == "SOL", "chain without a balance row falls back to the static chain table")
    precondition(tstate.buyPresets(chain: "??").isEmpty)
    // 没价的链：只按原生币数量比余额，限额不判（sidecar 执行时同样没价会拒单）
    precondition(tstate.buyReason(chain: "bsc", amount: 0.035) == nil, "no price → balance-only check must pass")
    precondition(tstate.buyReason(chain: "bsc", amount: 0.07) == "BNB 不足")
    // 有价的链：0.01 ETH ≈ $40 可买（60 + 40 ≤ 130）；0.02 ≈ $80 单笔内但 60 + 80 超今日 130；0.03 ≈ $120 超单笔 100；0.0001 ≈ $0.4 低于最低 $1
    precondition(tstate.buyReason(chain: "robinhood", amount: 0.01) == nil)
    precondition(tstate.buyReason(chain: "robinhood", amount: 0.02) == "超今日上限")
    precondition(tstate.buyReason(chain: "robinhood", amount: 0.03)?.hasPrefix("超单笔上限") == true)
    precondition(tstate.buyReason(chain: "robinhood", amount: 0.0001)?.hasPrefix("最低") == true)
    precondition(tstate.buyReason(chain: "robinhood", amount: 0.06) == "ETH 不足", "balance check comes before USD limits")
    precondition(Fmt.literal(0.035) == "0.035" && Fmt.literal(200) == "200" && Fmt.literal(0.1) == "0.1")
    let quoteJSON = """
    {"id":"q1","address":"\(holding.address)","chain":"bsc","side":"buy","amount":0.035,"usd":null,"pct":null,"ok":true,
     "inAmount":0.035,"inSymbol":"BNB","outAmount":12345.6,"outSymbol":"DINO","outUsd":24.1,"networkFeeUsd":null,"priceImpactPct":0.4,
     "honeypot":false,"taxPct":null,"minUsd":1,"error":null,"at":1788324300}
    """
    let tq = try! JSONDecoder().decode(TradeQuote.self, from: Data(quoteJSON.utf8))
    precondition(tq.amount == 0.035 && tq.usd == nil && tq.networkFeeUsd == nil, "quote without a native price still decodes; USD fields are nil")
    // Feed.quickTrade：意图按原生币数量发出（sell 传 0 + pct）；占位单的 usd 只是估算，没价 → 0
    let quickFeed = Feed()
    quickFeed.link = .connected
    quickFeed.tradeState = tstate
    let bscHolding = TradeHolding(address: holding.address, chain: "bsc", symbol: "DINO", name: nil, logo: nil,
                                  amount: 10, price: 1, usd: 10, boughtUsd: 0, soldUsd: 0, pnlUsd: nil, pnlPct: nil, heldSince: nil, tradePrices: nil)
    quickFeed.applyHoldings([bscHolding], at: Date())
    var sentIntent: (side: String, amount: Double, pct: Int?)?
    quickFeed.onQuickTrade = { _, _, chain, side, amount, pct in precondition(chain == "bsc"); sentIntent = (side, amount, pct) }
    quickFeed.quickTrade(bscHolding, side: "buy", amount: 0.035, pct: nil)
    precondition(sentIntent?.side == "buy" && sentIntent?.amount == 0.035 && sentIntent?.pct == nil)
    precondition(quickFeed.trades[bscHolding.address]?.usd == 0, "no cached price → placeholder estimate is 0")
    quickFeed.quickTrade(bscHolding, side: "sell", amount: 0.035, pct: 50)
    precondition(sentIntent?.amount == 0.035, "address lock: second intent while validating must not be sent")
    quickFeed.applyTrade(Trade(id: quickFeed.trades[bscHolding.address]!.id, address: bscHolding.address, chain: "bsc", side: "buy", usd: 24, pct: nil,
                               status: "failed", txHash: nil, error: "x", detail: nil, ts: Date().timeIntervalSince1970))
    quickFeed.quickTrade(bscHolding, side: "sell", amount: 0.035, pct: 50)
    precondition(sentIntent?.side == "sell" && sentIntent?.amount == 0 && sentIntent?.pct == 50, "sell sends amount 0 + pct")
    precondition(quickFeed.trades[bscHolding.address]?.usd == 5, "sell placeholder = holding usd × pct")
    print("native-denominated buy presets, price-gated USD limits and quick-trade intents OK")

    print("\n== Sidecar env ==")
    print("repoRoot:", Sidecar.repoRoot.path, "node:", Sidecar.nodePath() ?? "nil")
    print("gmgn link:", Links.gmgn(tokens[1])!.absoluteString)
    print("\nOK")
}

@main
enum Smoke {
    static func main() async { await run() }
}
