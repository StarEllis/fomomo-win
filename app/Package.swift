// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Fomomo",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Fomomo",
            path: "Sources/Fomomo"
        )
    ]
)
