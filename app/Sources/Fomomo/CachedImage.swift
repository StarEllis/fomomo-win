import SwiftUI
import ImageIO

/// 进程内图片缓存：命中时同步出图（和卡片一起入场，不会先字母后头像地闪一下）。
/// AsyncImage 每次建视图都从 .empty 起步，弹卡里的 logo/头像总比卡片慢半拍，所以不用它。
@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSURL, NSImage>()
    private var inflight: [URL: Task<NSImage?, Never>] = [:]
    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.requestCachePolicy = .returnCacheDataElseLoad
        c.urlCache = URLCache(memoryCapacity: 64 << 20, diskCapacity: 256 << 20)
        return URLSession(configuration: c)
    }()

    private init() { cache.countLimit = 600 }

    func cached(_ url: URL) -> NSImage? { cache.object(forKey: url as NSURL) }

    func load(_ url: URL) async -> NSImage? {
        if let img = cached(url) { return img }
        if let t = inflight[url] { return await t.value }
        let t = Task<NSImage?, Never> {
            do {
                let (d, r) = try await Self.session.data(from: url)
                // NSImage(data:) 对部分 webp 解出空表示；走 ImageIO → CGImage 最稳（AsyncImage 内部同路）
                guard let src = CGImageSourceCreateWithData(d as CFData, nil),
                      let cg = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: true] as CFDictionary) else {
                    FLog.error("img", "decode failed \(url.lastPathComponent) status=\((r as? HTTPURLResponse)?.statusCode ?? 0) bytes=\(d.count)")
                    return nil
                }
                return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
            } catch {
                FLog.error("img", "load failed \(url.host ?? "") \(url.lastPathComponent): \(error.localizedDescription)")
                return nil
            }
        }
        inflight[url] = t
        let img = await t.value
        inflight[url] = nil
        if let img { cache.setObject(img, forKey: url as NSURL) }
        return img
    }

    /// 预热：state 一到就把 logo / 头像拉进缓存，弹卡打开时全部同步命中
    func prefetch(_ urls: [URL]) {
        for u in urls where cached(u) == nil && inflight[u] == nil { Task { _ = await load(u) } }
    }
}

/// 有缓存就直接画；没有就先画 placeholder，加载完再换（只在首次见到这张图时才会闪）
struct CachedImage<Placeholder: View>: View {
    let url: URL?
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: NSImage?

    var body: some View {
        // ZStack + Color.clear 保证有真实视图承载 .task：placeholder 为 EmptyView 时，挂在它上面的 .task 不会跑
        ZStack {
            Color.clear
            if let img = image ?? url.flatMap({ ImageCache.shared.cached($0) }) {
                Image(nsImage: img).resizable().scaledToFill()
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            guard let url else { return }
            if let c = ImageCache.shared.cached(url) { image = c; return }
            image = await ImageCache.shared.load(url)
        }
    }
}
