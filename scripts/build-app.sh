#!/usr/bin/env bash
# 打包 Fomomo.app（自带 Node 22 运行时 + sidecar 打包产物 + lark-cli），产物全部落在 dist/。
#
# 布局（Swift 侧以 Resources/sidecar/cli.mjs 是否存在判定「打包模式」）：
#   Contents/MacOS/Fomomo                    swift release 二进制
#   Contents/Resources/sidecar/cli.mjs       esbuild 把 src/cli.ts 打成单文件 ESM；native 依赖留在 node_modules/
#   Contents/Resources/sidecar/dashboard/    dashboard 静态页
#   Contents/Resources/node/bin/node         nodejs.org 官方 arm64 二进制（版本 = .node-version）
#   Contents/Resources/bin/lark-cli          @larksuite/cli 的 Go 二进制
#   Contents/Resources/scripts/setup-keys.sh 微信密钥提取脚本
#
# 用法: scripts/build-app.sh [--skip-swift] [--skip-sign] [--no-zip] [--sidecar-only]
# 环境: FOMOMO_VERSION CODESIGN_IDENTITY(默认 -) LARK_CLI_VERSION(默认 1.0.95)
#       NOTARY_KEY_ID NOTARY_ISSUER_ID NOTARY_KEY_P8 三者齐全才公证 + staple
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
CACHE="$DIST/cache"
APP="$DIST/Fomomo.app"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"

SKIP_SWIFT=0 SKIP_SIGN=0 NO_ZIP=0 SIDECAR_ONLY=0
for a in "$@"; do
  case "$a" in
    --skip-swift) SKIP_SWIFT=1 ;;
    --skip-sign) SKIP_SIGN=1 ;;
    --no-zip) NO_ZIP=1 ;;
    --sidecar-only) SIDECAR_ONLY=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.node-version")"
LARK_CLI_VERSION="${LARK_CLI_VERSION:-1.0.95}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
if [ -z "${FOMOMO_VERSION:-}" ]; then
  # 版本唯一来源是 git tag：HEAD 正好落在 vX.Y.Z 上就用它（去掉 v）；否则（本地随手构建 / 手动触发 CI）退回 package.json 的版本。
  # 不用不带 --exact-match 的 describe：`v0.1.1-3-gabc123` 不是合法的 CFBundleShortVersionString
  FOMOMO_VERSION="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null | sed 's/^v//' || true)"
  [ -n "$FOMOMO_VERSION" ] || FOMOMO_VERSION="$(node -p "require('$ROOT/package.json').version")"
fi

log() { echo "==> $*"; }
size() { du -sh "$1" | cut -f1; }

# ---------- 1. sidecar：esbuild 单文件 + 仅 native 依赖的 node_modules ----------
build_sidecar() {
  local out="$DIST/sidecar"
  log "sidecar → $out"
  # 预编译 addon 与 Node ABI 绑定（22.x = ABI 127），npm install 必须用 22 跑，否则运行时报 NODE_MODULE_VERSION 不匹配
  local nv; nv="$(node -v)"
  case "$nv" in v22.*) ;; *) echo "需要 Node 22（当前 $nv）；fnm use 后重试" >&2; exit 1 ;; esac

  rm -rf "$out" && mkdir -p "$out"
  # CJS 依赖在 ESM 包里会调 require()，banner 补一个基于 import.meta.url 的 require；
  # native addon 走 --external 留在 node_modules，由 node 原生解析；bufferutil / utf-8-validate 是 ws 的可选加速，没装就跳过
  (cd "$ROOT" && pnpm exec esbuild src/cli.ts \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$out/cli.mjs" \
    --external:better-sqlite3-multiple-ciphers --external:wreq-js \
    --external:bufferutil --external:utf-8-validate \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --log-level=warning)
  cp -R "$ROOT/src/dashboard" "$out/dashboard"

  local sqlite_v wreq_v
  sqlite_v="$(node -p "require('$ROOT/node_modules/better-sqlite3-multiple-ciphers/package.json').version")"
  wreq_v="$(node -p "require('$ROOT/node_modules/wreq-js/package.json').version")"
  cat > "$out/package.json" <<EOF
{
  "name": "fomomo-sidecar",
  "private": true,
  "type": "module",
  "dependencies": {
    "better-sqlite3-multiple-ciphers": "$sqlite_v",
    "wreq-js": "$wreq_v"
  }
}
EOF
  (cd "$out" && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error)
  # wreq-js 的 optionalDependencies 里 npm 只会装当前平台那份 binding；确认 arm64 在
  [ -d "$out/node_modules/@wreq-js/binding-darwin-arm64" ] || { echo "缺 @wreq-js/binding-darwin-arm64" >&2; exit 1; }
  [ -f "$out/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node" ] || { echo "缺 better_sqlite3.node" >&2; exit 1; }
  log "sidecar 完成: cli.mjs $(size "$out/cli.mjs"), node_modules $(size "$out/node_modules")"
}

# ---------- 2. Node 运行时：官方 tarball，校验 SHASUMS256，只取 bin/node ----------
fetch_node() {
  local tgz="node-v$NODE_VERSION-darwin-arm64.tar.gz"
  local base="https://nodejs.org/dist/v$NODE_VERSION"
  mkdir -p "$CACHE"
  log "node v$NODE_VERSION"
  [ -f "$CACHE/$tgz" ] || curl -fsSL "$base/$tgz" -o "$CACHE/$tgz"
  [ -f "$CACHE/SHASUMS256-$NODE_VERSION.txt" ] || curl -fsSL "$base/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
  (cd "$CACHE" && grep " $tgz\$" "SHASUMS256-$NODE_VERSION.txt" | shasum -a 256 -c - >/dev/null)
  mkdir -p "$RES/node/bin"
  tar -xzf "$CACHE/$tgz" -C "$RES/node/bin" --strip-components=2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
  chmod +x "$RES/node/bin/node"
}

# ---------- 3. lark-cli：npm 包的 postinstall 自己下载并 sha256 校验 darwin-arm64 二进制 ----------
fetch_lark_cli() {
  local prefix="$CACHE/lark"
  local bin="$prefix/node_modules/@larksuite/cli/bin/lark-cli"
  log "lark-cli $LARK_CLI_VERSION"
  if [ ! -x "$bin" ] || [ "$(node -p "require('$prefix/node_modules/@larksuite/cli/package.json').version" 2>/dev/null)" != "$LARK_CLI_VERSION" ]; then
    rm -rf "$prefix" && mkdir -p "$prefix"
    npm install --prefix "$prefix" --no-package-lock --no-audit --no-fund --loglevel=error "@larksuite/cli@$LARK_CLI_VERSION"
  fi
  [ -f "$bin" ] || { echo "lark-cli 二进制不存在: $bin" >&2; exit 1; }
  mkdir -p "$RES/bin"
  cp "$bin" "$RES/bin/lark-cli"
  chmod +x "$RES/bin/lark-cli"
}

# ---------- 4. Swift ----------
build_swift() {
  local bin="$ROOT/app/.build/release/Fomomo"
  if [ "$SKIP_SWIFT" = 1 ]; then
    if [ ! -x "$bin" ]; then
      bin="$ROOT/app/.build/debug/Fomomo"
      echo "警告: 没有 release 二进制，改用 debug 构建 $bin" >&2
    fi
    [ -x "$bin" ] || { echo "--skip-swift 但找不到已构建的 Fomomo" >&2; exit 1; }
  else
    log "swift build -c release"
    swift build -c release --package-path "$ROOT/app"
  fi
  mkdir -p "$CONTENTS/MacOS"
  cp "$bin" "$CONTENTS/MacOS/Fomomo"
}

# ---------- 5. 签名：Resources 下所有 Mach-O 用 sidecar 权限（允许 JIT），主程序无例外 ----------
# hardened runtime 的 library validation 要求 node 与它 dlopen 的 addon 同一 Team ID；ad-hoc 签名没有 Team ID，
# 开了 runtime 会让 wreq-js / better_sqlite3 加载失败（"different Team IDs"），所以只在真实身份下加 --options runtime。
sign_app() {
  local opts=(--options runtime --timestamp)
  [ "$CODESIGN_IDENTITY" = "-" ] && opts=(--timestamp=none)
  log "codesign ($CODESIGN_IDENTITY)"
  # 可执行文件 + .node/.dylib；macOS find 的 -perm +111 已废弃，用 -perm -u+x
  find "$RES" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0 | while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    codesign --force "${opts[@]}" --entitlements "$ROOT/app/Sidecar.entitlements" --sign "$CODESIGN_IDENTITY" "$f"
  done
  codesign --force "${opts[@]}" --entitlements "$ROOT/app/Fomomo.entitlements" --sign "$CODESIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
}

zip_app() {
  rm -f "$1"
  ditto -c -k --keepParent "$APP" "$1"
}

# ---------- 6. 公证 ----------
notarize() {
  local zip="$1"
  log "notarytool submit"
  xcrun notarytool submit "$zip" --key "$NOTARY_KEY_P8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait
  xcrun stapler staple "$APP"
  zip_app "$zip"
}

# ================= main =================
mkdir -p "$DIST"
build_sidecar
[ "$SIDECAR_ONLY" = 1 ] && exit 0

log "版本 $FOMOMO_VERSION"
rm -rf "$APP"
mkdir -p "$RES"

cp -R "$DIST/sidecar" "$RES/sidecar"
fetch_node
fetch_lark_cli
build_swift

sed "s/__VERSION__/$FOMOMO_VERSION/g" "$ROOT/app/Info.plist" > "$CONTENTS/Info.plist"
plutil -lint "$CONTENTS/Info.plist" >/dev/null
mkdir -p "$RES/scripts"
cp "$ROOT/scripts/setup-keys.sh" "$RES/scripts/setup-keys.sh"
chmod +x "$RES/scripts/setup-keys.sh"

[ "$SKIP_SIGN" = 1 ] || sign_app

ZIP="$DIST/Fomomo-$FOMOMO_VERSION-arm64.zip"
if [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER_ID:-}" ] && [ -n "${NOTARY_KEY_P8:-}" ]; then
  [ "$SKIP_SIGN" = 1 ] && { echo "--skip-sign 与公证互斥" >&2; exit 1; }
  zip_app "$ZIP"
  notarize "$ZIP"
elif [ "$NO_ZIP" = 0 ]; then
  zip_app "$ZIP"
fi

echo ""
echo "✅ $APP"
echo "   node        $(size "$RES/node/bin/node")"
echo "   lark-cli    $(size "$RES/bin/lark-cli")"
echo "   cli.mjs     $(size "$RES/sidecar/cli.mjs")"
echo "   node_modules $(size "$RES/sidecar/node_modules")"
echo "   Fomomo      $(size "$CONTENTS/MacOS/Fomomo")"
echo "   app 总计    $(size "$APP")"
[ -f "$ZIP" ] && echo "   zip         $(size "$ZIP")  $ZIP"
exit 0
