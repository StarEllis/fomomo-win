import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var overlay: OverlayPanelController?
    private var statusBar: StatusBar?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let overlay = OverlayPanelController()
        self.overlay = overlay
        statusBar = StatusBar(overlay: overlay)
        overlay.show()
    }

    func applicationWillTerminate(_ notification: Notification) {
        overlay?.shutdown()     // 结束 node sidecar，别留孤儿
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}
