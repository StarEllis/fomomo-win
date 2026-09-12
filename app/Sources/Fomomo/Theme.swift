import SwiftUI
import AppKit

extension Color {
    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255)
    }
}

/// fomo 配色（从截图取色）：纯黑 + 翡翠绿，跌红
enum FM {
    static let accent    = Color(hex: 0x24c47c)
    static let accentDim = Color(hex: 0x0f8a55)
    static let up        = Color(hex: 0x3ddc84)
    static let down      = Color(hex: 0xff5b5b)
    static let ink       = Color(hex: 0xf2f4f6)
    static let muted     = Color(hex: 0x8b9296)
    static let faint     = Color(hex: 0x565c61)
    static let hair      = Color.white.opacity(0.08)
    static let hair2     = Color.white.opacity(0.05)
    static let surface   = Color.white.opacity(0.04)
    /// 抬起的半透明瓦片（交易卡的 Buy/Sell 未选、金额框、快捷额、灰按钮）：叠在 `surface` 卡底上再亮一档，不用实色，跟着玻璃底色走
    static let surface2  = Color.white.opacity(0.07)
    static let amber     = Color(hex: 0xf0b90b)
    static let orange    = Color(hex: 0xff9347)
    static let logoInk   = Color(hex: 0x04140c)

    /// Color-code the fomo front-rank ratio while preserving the nil state.
    static func frontRankColor(_ ratio: Double?) -> Color {
        guard let ratio else { return faint }
        if ratio >= 0.75 { return down }
        if ratio >= 0.50 { return orange }
        if ratio >= 0.25 { return amber }
        return muted
    }
    /// 由 symbol 派生翡翠绿系 logo 渐变
    static func logoGradient(_ symbol: String) -> LinearGradient {
        var h = 0
        for c in symbol.unicodeScalars { h = h &* 31 &+ Int(c.value) }
        let base = 152.0 + Double((h % 60) - 30)
        return LinearGradient(
            colors: [Color(hue: base/360, saturation: 0.85, brightness: 0.62),
                     Color(hue: (base+34)/360, saturation: 0.80, brightness: 0.44)],
            startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// 面板玻璃背景（NSVisualEffectView 毛玻璃 + 原型 --glass rgba(11,12,14,.84)）
struct GlassBackground: View {
    var opacity: Double = 1
    var body: some View {
        ZStack {
            VisualEffect(material: .hudWindow, blending: .behindWindow)
            Color(hex: 0x0b0c0e).opacity(0.84)
        }
        // Apply to the material and tint together; callers keep content fully opaque.
        .opacity(min(max(opacity, 0), 1))
    }
}

struct VisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material
    var blending: NSVisualEffectView.BlendingMode
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blending
        v.state = .active
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.blendingMode = blending
    }
}
