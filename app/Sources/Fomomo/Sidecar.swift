import Foundation

/// `state` 事件用 Codable 解（tokens 结构固定）；其余事件字段少且 rpc body 是任意 JSON，直接走 JSONSerialization
private struct StateEvent: Decodable { let tokens: [Token] }

/// 拉起 sidecar，按行解析 stdout 喂 Feed；stdin 回 rpc 结果。退出码非 0 退避重启（1s→30s）。
/// 两种模式（见 `bundledResources`）：
/// - 打包（Fomomo.app）：`Resources/node/bin/node cli.mjs run`，cwd = `Resources/sidecar`，lark-cli 走 `FOMOMO_LARK_CLI`
/// - 开发（swift build）：仓库根下 `node --import tsx src/cli.ts run`，node 用 fnm 里 `.node-version` 钉的版本
@MainActor
final class Sidecar {
    private let feed: Feed
    private let gmgn: GmgnBridge
    private let fomo = FomoBridge.shared
    private var process: Process?
    private var stdin: FileHandle?
    private var buffer = Data()
    private var backoff: TimeInterval = 1
    private var stopping = false
    private var generation = 0
    /// 设置里的悬浮窗尺寸（OverlayPanelController 挂上来改窗口 frame）
    var onPanelSize: ((PanelSize) -> Void)?
    /// 设置里的主面板背景不透明度
    var onPanelBackgroundOpacity: ((Double) -> Void)?

    /// 打包模式：`Contents/Resources/sidecar/cli.mjs` 存在就认定跑在 Fomomo.app 里（build 脚本产出的布局），返回 Resources 根；
    /// 开发模式（swift build / smoke）为 nil。用「文件存在」而不是 bundle id 判断，避免 `swift build` 出来的裸二进制误判
    static let bundledResources: URL? = {
        guard let r = Bundle.main.resourceURL,
              FileManager.default.fileExists(atPath: r.appendingPathComponent("sidecar/cli.mjs").path) else { return nil }
        return r
    }()

    /// 仓库根（仅开发模式）：优先 FOMOMO_ROOT，否则从源码路径推（app/Sources/Fomomo/Sidecar.swift → 上 4 级）
    static let repoRoot: URL = {
        if let r = ProcessInfo.processInfo.environment["FOMOMO_ROOT"] { return URL(fileURLWithPath: r) }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }()

    /// 群列表 / 回灌起点默认由 sidecar 的设置（dashboard 可改）决定；这两个环境变量只是调试时的临时覆盖
    static let groupOverride = ProcessInfo.processInfo.environment["FOMOMO_GROUP"]
    static let sinceOverride = ProcessInfo.processInfo.environment["FOMOMO_SINCE"]

    /// GUI 进程的 PATH 里没有 fnm/homebrew，自己找 node。`FOMOMO_NODE` 永远最先。
    /// 打包模式随包带了 node（`Resources/node/bin/node`），native addon 就是按它的 ABI 编的，直接用；
    /// 开发模式 native addon（better-sqlite3-multiple-ciphers）只兼容编译它的 node ABI，所以优先用仓库 `.node-version`
    /// 钉住的版本（fnm 安装目录），再回退到系统里随便哪个 node。`.node-version` 只在开发模式读（包里没有仓库根）
    static func nodePath() -> String? {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates: [String] = []
        if let n = env["FOMOMO_NODE"] { candidates.append(n) }
        if let res = bundledResources {
            candidates.append(res.appendingPathComponent("node/bin/node").path)
        } else if let pinned = try? String(contentsOf: repoRoot.appendingPathComponent(".node-version"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !pinned.isEmpty {
            let v = pinned.hasPrefix("v") ? pinned : "v\(pinned)"
            candidates.append("\(home)/.local/share/fnm/node-versions/\(v)/installation/bin/node")
            candidates.append("\(home)/.nvm/versions/node/\(v)/bin/node")
        }
        candidates += ["\(home)/.local/share/fnm/aliases/default/bin/node", "\(home)/.volta/bin/node",
                       "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        for dir in (env["PATH"] ?? "").split(separator: ":") { candidates.append("\(dir)/node") }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    init(feed: Feed, gmgn: GmgnBridge) {
        self.feed = feed
        self.gmgn = gmgn
        feed.onSimulate = { [weak self] in self?.send(#"{"t":"simulate"}"#) }
        feed.onFocus = { [weak self] a, chain in
            let obj: [String: Any] = ["t": "focus", "address": a as Any? ?? NSNull(), "chain": chain as Any? ?? NSNull()]
            if let d = try? JSONSerialization.data(withJSONObject: obj) { self?.send(String(decoding: d, as: UTF8.self)) }
        }
        feed.onFrontRankVisible = { [weak self] addrs in
            let obj: [String: Any] = ["t": "front_rank_visible", "addresses": addrs]
            if let d = try? JSONSerialization.data(withJSONObject: obj) { self?.send(String(decoding: d, as: UTF8.self)) }
        }
        feed.onContext = { [weak self] a, sender, ts, group in
            let obj: [String: Any] = ["t": "context", "address": a, "sender": sender, "ts": ts, "group": group]
            if let d = try? JSONSerialization.data(withJSONObject: obj) { self?.send(String(decoding: d, as: UTF8.self)) }
        }
        feed.onKline = { [weak self] r in
            let obj: [String: Any] = ["t": "kline", "address": r.address, "chain": r.chain as Any? ?? NSNull(), "resolution": r.resolution, "from": Int(r.from), "to": Int(r.to)]
            if let d = try? JSONSerialization.data(withJSONObject: obj) { self?.send(String(decoding: d, as: UTF8.self)) }
        }
        feed.onTradeQuote = { [weak self] a, chain, side, amount, pct in self?.tradeQuote(address: a, chain: chain, side: side, amount: amount, pct: pct) }
        feed.onCancelTradeQuote = { [weak self] in self?.cancelTradeQuote() }
        feed.onTrade = { [weak self] a, chain, side, amount, pct, quoteId in self?.trade(address: a, chain: chain, side: side, amount: amount, pct: pct, quoteId: quoteId) }
        feed.onQuickTrade = { [weak self] id, a, chain, side, amount, pct in
            self?.quickTrade(id: id, address: a, chain: chain, side: side, amount: amount, pct: pct)
        }
        feed.onThesisMore = { [weak self] a in
            let obj: [String: Any] = ["t": "fomo_thesis_more", "address": a]
            if let d = try? JSONSerialization.data(withJSONObject: obj) { self?.send(String(decoding: d, as: UTF8.self)) }
        }
        feed.onGmgnCallsMore = { [weak self] a in
            let obj: [String: Any] = ["t": "gmgn_calls_more", "address": a]
            if let d = try? JSONSerialization.data(withJSONObject: obj) { self?.send(String(decoding: d, as: UTF8.self)) }
        }
    }

    /// 弹卡「swap」卡要一份**一次性**报价（OKX /quote），sidecar 回一条 `trade_quote`；amount = buy 的原生币数量（sell 传 0），pct = sell 按持仓比例
    func tradeQuote(address: String, chain: String, side: String, amount: Double, pct: Int?) {
        let obj: [String: Any] = ["t": "trade_quote", "address": address, "chain": chain, "side": side, "amount": amount, "pct": pct as Any? ?? NSNull()]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { send(String(decoding: d, as: UTF8.self)) }
    }

    /// 作废还没回来的报价（address = null）
    func cancelTradeQuote() {
        send(#"{"t":"trade_quote","address":null}"#)
    }

    /// owner 点了执行：把不可变意图（含钉住的 quoteId）交给 sidecar，由本地 burner 钱包签名、经 OKX 路由提交。Swift 不做任何判断
    func trade(address: String, chain: String, side: String, amount: Double, pct: Int?, quoteId: String) {
        let obj: [String: Any] = ["t": "trade", "address": address, "chain": chain, "side": side, "amount": amount, "pct": pct as Any? ?? NSNull(), "quoteId": quoteId]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { send(String(decoding: d, as: UTF8.self)) }
    }

    /// 持仓行快捷额：Feed 已本地落了 validating 占位，这里必须能分清「没发出去」（failed）和「写了一半 / 进程没了」（unknown）
    private func quickTrade(id: String, address: String, chain: String, side: String, amount: Double, pct: Int?) {
        guard let stdin, process?.isRunning == true else {
            feed.quickTradeDeliveryFailed(id: id, uncertain: false)
            return
        }
        let obj: [String: Any] = ["t": "trade_quick", "id": id, "address": address, "chain": chain,
                                  "side": side, "amount": amount, "pct": pct as Any? ?? NSNull()]
        guard var data = try? JSONSerialization.data(withJSONObject: obj) else {
            feed.quickTradeDeliveryFailed(id: id, uncertain: false)
            return
        }
        data.append(0x0A)
        do { try stdin.write(contentsOf: data) }
        catch { feed.quickTradeDeliveryFailed(id: id, uncertain: true) }
    }

    func start() {
        stopping = false
        launch()
    }

    func stop() {
        stopping = true
        process?.terminate()
        process = nil
    }

    private func launch() {
        guard !stopping else { return }
        guard let node = Self.nodePath() else {
            feed.link = .failed("找不到 node")
            FLog.error("sidecar", "node not found")
            return
        }
        generation += 1
        let gen = generation
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        let bundled = Self.bundledResources
        let cwd = bundled?.appendingPathComponent("sidecar") ?? Self.repoRoot
        var args = bundled != nil ? ["cli.mjs", "run"] : ["--import", "tsx", "src/cli.ts", "run"]
        if let g = Self.groupOverride { args += ["--group", g] }
        if let s = Self.sinceOverride { args += ["--since", s] }
        p.arguments = args
        p.currentDirectoryURL = cwd
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = (URL(fileURLWithPath: node).deletingLastPathComponent().path) + ":" + (env["PATH"] ?? "/usr/bin:/bin")
        // 包里带的 lark-cli（飞书源）；没打进包就不设，让 sidecar 按自己的默认查找
        if let lark = bundled?.appendingPathComponent("bin/lark-cli").path, FileManager.default.isExecutableFile(atPath: lark) {
            env["FOMOMO_LARK_CLI"] = lark
        }
        p.environment = env

        let inp = Pipe(), out = Pipe(), err = Pipe()
        p.standardInput = inp
        p.standardOutput = out
        p.standardError = err
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard !d.isEmpty else { return }
            Task { @MainActor [weak self] in self?.consume(d, gen: gen) }
        }
        err.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
            for line in s.split(separator: "\n") { FLog.info("sidecar", "\(line)") }
        }
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor [weak self] in self?.exited(code: code, gen: gen) }
        }
        do {
            try p.run()
            process = p
            stdin = inp.fileHandleForWriting
            buffer.removeAll()
            feed.link = generation == 1 ? .connecting : .reconnecting("重启 sidecar")
            FLog.info("sidecar", "sidecar started mode=\(bundled != nil ? "bundled" : "dev") pid=\(p.processIdentifier) node=\(node) cwd=\(cwd.path)")
        } catch {
            feed.link = .failed(error.localizedDescription)
            FLog.error("sidecar", "spawn failed: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    private func exited(code: Int32, gen: Int) {
        guard gen == generation else { return }
        process = nil
        stdin = nil
        if stopping { return }
        FLog.error("sidecar", "sidecar exited code=\(code)")
        feed.link = .reconnecting("退出码 \(code)")
        feed.quickTradesDisconnected()
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = backoff
        backoff = min(backoff * 2, 30)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            self?.launch()
        }
    }

    private func send(_ line: String) {
        guard let stdin, let d = (line + "\n").data(using: .utf8) else { return }
        try? stdin.write(contentsOf: d)
    }

    private func consume(_ d: Data, gen: Int) {
        guard gen == generation else { return }
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard !line.isEmpty else { continue }
            handle(line)
        }
    }

    private static func bar(_ b: [Any]) -> Bar? {
        guard b.count == 6 else { return nil }
        let n = b.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard n.count == 6 else { return nil }
        return Bar(t: n[0], o: n[1], h: n[2], l: n[3], c: n[4], v: n[5])
    }

    private func handle(_ line: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let t = obj["t"] as? String else {
            FLog.error("sidecar", "bad line: \(String(decoding: line.prefix(200), as: UTF8.self))")
            return
        }
        switch t {
        case "ready":
            backoff = 1
            feed.link = .connected
            let gs = (obj["groups"] as? [[String: Any]]) ?? []
            let names = gs.compactMap { $0["displayName"] as? String }.filter { !$0.isEmpty }
            feed.groupName = names.isEmpty ? "未监听群组" : names.count == 1 ? names[0] : "\(names[0]) 等 \(names.count) 群"
            feed.groupNames = Dictionary(uniqueKeysWithValues: gs.compactMap { g in (g["username"] as? String).flatMap { u in (g["displayName"] as? String).map { (u, $0) } } })
            feed.replayFrontRankVisible()
        case "dashboard":
            if let u = (obj["url"] as? String).flatMap(URL.init(string:)) { feed.dashboardURL = u }
        case "sources":
            if let c = obj["configured"] as? Bool {
                feed.sourcesConfigured = c
                feed.onSources?(c, obj["firstRun"] as? Bool ?? false)
            }
        case "settings":
            if let settings = (obj["settings"] as? [String: Any]),
               let p = settings["panel"] as? [String: Any] {
                if let w = p["width"] as? Double, let h = p["height"] as? Double {
                    onPanelSize?(PanelSize(width: w, height: h))
                }
                if let opacity = p["backgroundOpacity"] as? Double {
                    onPanelBackgroundOpacity?(min(max(opacity, 0), 1))
                }
            }
        case "state":
            do {
                let tokens = try JSONDecoder().decode(StateEvent.self, from: line).tokens
                feed.applyState(tokens)
            } catch { FLog.error("sidecar", "bad state: \(error)") }
        case "new_token":
            if let a = obj["address"] as? String { feed.newToken(a) }
        case "token_hidden":
            if let a = obj["address"] as? String { feed.tokenHidden(a) }
        case "kline":
            guard let a = obj["address"] as? String, let chain = obj["chain"] as? String, let res = obj["resolution"] as? String, let bs = obj["bars"] as? [[Any]] else { return }
            let bars = bs.compactMap(Self.bar)
            let calls = ((obj["calls"] as? [[Any]]) ?? []).compactMap { c -> CallMark? in
                guard c.count == 3, let t = (c[0] as? NSNumber)?.doubleValue, let s = c[1] as? String, let g = c[2] as? String else { return nil }
                return CallMark(t: t, sender: s, group: g)
            }
            let cov = (obj["covered"] as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? []
            let covered = cov.count == 2 ? (from: cov[0], to: cov[1]) : (from: bars.first?.t ?? 0, to: (bars.last?.t ?? 0) + (Kline.stepSec[res] ?? 60))
            feed.applyKline(Kline(address: a, chain: chain, resolution: res, bars: bars, covered: covered, calls: calls, error: obj["error"] as? String))
        case "context":
            guard let a = obj["address"] as? String, let g = obj["group"] as? String, let ls = obj["lines"] as? [[String: Any]] else { return }
            let lines = ls.compactMap { l -> CallContext.Line? in
                guard let t = (l["time"] as? NSNumber)?.doubleValue else { return nil }
                return CallContext.Line(time: t, sender: l["sender"] as? String ?? "", text: l["text"] as? String ?? "")
            }
            feed.applyContext(CallContext(address: a, sender: obj["sender"] as? String ?? "", ts: (obj["ts"] as? NSNumber)?.doubleValue ?? 0, group: g, lines: lines, call: (obj["call"] as? NSNumber)?.intValue ?? -1))
        case "kline_bar":
            guard let a = obj["address"] as? String, let chain = obj["chain"] as? String, let res = obj["resolution"] as? String,
                  let raw = obj["bar"] as? [Any], let b = Self.bar(raw) else { return }
            feed.applyBar(address: a, chain: chain, resolution: res, bar: b)
        case "token_detail":
            do {
                struct Ev: Decodable { let token: Token }
                let ev = try JSONDecoder().decode(Ev.self, from: line)
                feed.applyTokenDetail(ev.token)
            } catch { FLog.error("sidecar", "bad token_detail: \(error)") }
        case "heartbeat":
            if feed.link != .connected { feed.link = .connected }
        case "fomo_state":
            feed.fomoState = FomoState(loggedIn: obj["loggedIn"] as? Bool ?? false)
        case "trade_state":
            do {
                let s = try JSONDecoder().decode(TradeState.self, from: line)
                feed.tradeState = s
            } catch { FLog.error("sidecar", "bad trade_state: \(error)") }
        case "trade_quote":
            do {
                let q = try JSONDecoder().decode(TradeQuote.self, from: line)
                // 只收当前弹卡那个币（address + chain）的（切币后旧报价晚到不能显示）
                if let p = feed.popup, p.address == q.address, p.chain == q.chain { feed.tradeQuote = q }
            } catch { FLog.error("sidecar", "bad trade_quote: \(error)") }
        case "trade":
            do {
                let tr = try JSONDecoder().decode(Trade.self, from: line)
                feed.applyTrade(tr)
            } catch { FLog.error("sidecar", "bad trade: \(error)") }
        case "trade_holdings":
            do {
                struct Ev: Decodable { let at: Double?; let holdings: [TradeHolding] }
                let ev = try JSONDecoder().decode(Ev.self, from: line)
                feed.applyHoldings(ev.holdings, at: ev.at.map { Date(timeIntervalSince1970: $0 > 1e11 ? $0 / 1000 : $0) } ?? Date())
            } catch { FLog.error("sidecar", "bad trade_holdings: \(error)") }
        case "fomo_thesis":
            do {
                let f = try JSONDecoder().decode(FomoThesisFeed.self, from: line)
                // 只收当前弹卡（含入场中 pending）那个币的；事件带链时链也得对上（同一 0x 地址两条链）
                if feed.focused(address: f.address, chain: f.chain) { feed.fomoThesis = f }
            } catch { FLog.error("sidecar", "bad fomo_thesis: \(error)") }
        case "gmgn_calls":
            do {
                let g = try JSONDecoder().decode(GmgnCalls.self, from: line)
                if feed.focused(address: g.address, chain: g.chain) { feed.gmgnCalls = g }
            } catch { FLog.error("sidecar", "bad gmgn_calls: \(error)") }
        case "error":
            FLog.error("sidecar", "sidecar error: \(obj["message"] ?? "")")
        case "rpc":
            guard let id = obj["id"] as? Int else { return }
            let params = obj["params"] as? [String: Any]
            switch obj["method"] as? String {
            case "gmgn.fetch":
                guard let path = params?["path"] as? String, let method = params?["method"] as? String else { return reply(id: id, error: "bad params") }
                let body = params?["body"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
                    .map { String(decoding: $0, as: UTF8.self) }
                Task { await rpcGmgnFetch(id: id, path: path, method: method, body: body) }
            case "fomo.token":
                let refresh = params?["refresh"] as? Bool ?? false
                Task {
                    let t = await fomo.token(refresh: refresh)
                    reply(id: id, result: ["token": t as Any? ?? NSNull()])
                }
            case "fomo.me":
                Task { reply(id: id, result: await fomo.me() ?? NSNull()) }
            default:
                reply(id: id, error: "unknown method \(obj["method"] ?? "")")
            }
        default:
            break
        }
    }

    private func rpcGmgnFetch(id: Int, path: String, method: String, body: String?) async {
        guard await gmgn.waitReady(timeout: 8) else { return reply(id: id, error: "gmgn not ready: \(gmgn.state.label)") }
        do {
            let r = try await gmgn.fetch(path: path, method: method, body: body)
            reply(id: id, result: ["status": r.status, "body": r.body])
        } catch {
            reply(id: id, error: String(describing: error))
        }
    }

    private func reply(id: Int, result: Any) {
        let obj: [String: Any] = ["t": "rpc_result", "id": id, "ok": true, "result": result]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { send(String(decoding: d, as: UTF8.self)) }
    }

    private func reply(id: Int, error: String) {
        let obj: [String: Any] = ["t": "rpc_result", "id": id, "ok": false, "error": error]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { send(String(decoding: d, as: UTF8.self)) }
    }
}
