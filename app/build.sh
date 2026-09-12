#!/bin/bash
# 不经 SwiftPM 的直编脚本（SwiftPM 自带 sandbox-exec 在受限环境里起不来时用）。
# 正常环境直接 `swift build` 即可，两者产物等价。
#   ./build.sh         → .build/debug/Fomomo
#   ./build.sh smoke   → .build/debug/smoke（无 UI 冒烟：Tests/smoke.swift + 除 main.swift 外的源码）
set -euo pipefail
cd "$(dirname "$0")"
PLUGINS=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins
CACHE="${TMPDIR:-/tmp}/fomomo-modcache"
mkdir -p .build/debug "$CACHE"
common=(-swift-version 6 -target arm64-apple-macosx14.0 -module-cache-path "$CACHE"
        -load-plugin-library "$PLUGINS/libObservationMacros.dylib")
if [[ "${1:-}" == "smoke" ]]; then
  srcs=$(ls Sources/Fomomo/*.swift | grep -v '/main.swift$')
  swiftc "${common[@]}" -module-name smoke $srcs Tests/smoke.swift -o .build/debug/smoke
  echo "→ .build/debug/smoke"
else
  swiftc "${common[@]}" -module-name Fomomo Sources/Fomomo/*.swift -o .build/debug/Fomomo
  echo "→ .build/debug/Fomomo"
fi
