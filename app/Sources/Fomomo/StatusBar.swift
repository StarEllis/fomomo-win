import AppKit

/// 菜单栏图标：面板收起后唯一的入口。点图标弹菜单（不做左键直接 toggle，免得误点）：
/// 「隐藏面板 / 显示面板」（文案跟随 `OverlayPanelController.isCollapsed`）· 打开 Dashboard · 登录 fomo… · 退出。
/// 收起状态不持久化：重启默认显示。
@MainActor
final class StatusBar: NSObject, NSMenuDelegate {
    private let item: NSStatusItem
    private let toggleItem: NSMenuItem
    private unowned let overlay: OverlayPanelController

    init(overlay: OverlayPanelController) {
        self.overlay = overlay
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        toggleItem = NSMenuItem(title: "隐藏面板", action: #selector(toggle), keyEquivalent: "h")
        super.init()

        item.button?.image = StatusBar.icon()
        item.button?.toolTip = "fomomo"

        let menu = NSMenu()
        menu.delegate = self
        toggleItem.target = self
        menu.addItem(toggleItem)
        menu.addItem(.separator())
        let dash = NSMenuItem(title: "打开 Dashboard", action: #selector(openDashboard), keyEquivalent: "")
        dash.target = self
        menu.addItem(dash)
        // fomo.family 登录：把常驻的隐藏 WKWebView 亮出来完成一次 OAuth（FomoBridge），登完自动收回
        let fomo = NSMenuItem(title: "登录 fomo…", action: #selector(loginFomo), keyEquivalent: "")
        fomo.target = self
        menu.addItem(fomo)
        menu.addItem(.separator())
        // burner 充值入口：弹卡里也有「充值」，这里是不开卡也能拿到地址的地方（同一个 DepositSheet，六链地址 + 该转的币）；钱包没生成时灰掉并提示命令
        depositItem.target = self
        menu.addItem(depositItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 fomomo", action: #selector(quit), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
    }

    private let depositItem = NSMenuItem(title: "充值地址…", action: #selector(showDeposit), keyEquivalent: "")

    /// 菜单弹出前按当前状态改文案
    func menuNeedsUpdate(_ menu: NSMenu) {
        toggleItem.title = overlay.isCollapsed ? "显示面板" : "隐藏面板"
        depositItem.isEnabled = overlay.hasWallet
        depositItem.title = overlay.hasWallet ? "充值地址…" : "钱包未生成：pnpm cli wallet-init"
    }

    @objc private func toggle() { overlay.setCollapsed(!overlay.isCollapsed) }
    @objc private func openDashboard() { overlay.showDashboard() }
    @objc private func loginFomo() { FomoBridge.shared.showLogin() }
    @objc private func showDeposit() { if let b = item.button { overlay.showDeposit(relativeTo: b) } }
    @objc private func quit() { NSApp.terminate(nil) }

    /// 面板头部 logo 的单色版：圆角方块里镂空一个 “f”。模板图，跟着菜单栏深浅自动变色。
    private static func icon() -> NSImage {
        let side: CGFloat = 16
        let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            guard let cg = NSGraphicsContext.current?.cgContext else { return false }
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 4.5, yRadius: 4.5).fill()
            cg.setBlendMode(.destinationOut)
            let text = NSAttributedString(string: "f", attributes: [
                .font: NSFont.systemFont(ofSize: 11.5, weight: .bold),
                .foregroundColor: NSColor.black,
            ])
            let s = text.size()
            // 视觉居中：f 字形重心偏上，往下压一点
            text.draw(at: NSPoint(x: (side - s.width) / 2, y: (side - s.height) / 2 - 0.5))
            return true
        }
        img.isTemplate = true
        return img
    }
}
