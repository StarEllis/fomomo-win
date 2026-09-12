import AppKit

// 无 Dock 图标、无主窗口的悬浮小工具（accessory）
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// `pkill Fomomo` / Ctrl-C 走正常退出路径，让 applicationWillTerminate 有机会收掉 sidecar
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { NSApplication.shared.terminate(nil) }
    src.resume()
    _ = Unmanaged.passRetained(src)   // 常驻
}

app.run()
