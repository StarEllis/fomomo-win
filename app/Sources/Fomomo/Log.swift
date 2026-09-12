import Foundation
import os

/// 双写：os_log（Console.app）+ ~/Library/Logs/fomomo.log（方便 tail / 远程排查）。
/// 只记状态与地址数，不记聊天正文。
enum FLog {
    private static let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/fomomo.log")
    private static let q = DispatchQueue(label: "fomomo.log")
    private static let oslog = Logger(subsystem: "fomomo", category: "app")
    private static let fmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f
    }()

    static func info(_ cat: String, _ msg: String) { write("I", cat, msg); oslog.info("[\(cat, privacy: .public)] \(msg, privacy: .public)") }
    static func error(_ cat: String, _ msg: String) { write("E", cat, msg); oslog.error("[\(cat, privacy: .public)] \(msg, privacy: .public)") }

    private static func write(_ lvl: String, _ cat: String, _ msg: String) {
        let line = "\(fmt.string(from: Date())) \(lvl) [\(cat)] \(msg)\n"
        q.async {
            guard let d = line.data(using: .utf8) else { return }
            if let h = try? FileHandle(forWritingTo: file) {
                defer { try? h.close() }
                _ = try? h.seekToEnd()
                try? h.write(contentsOf: d)
            } else {
                try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? d.write(to: file)
            }
        }
    }
}
