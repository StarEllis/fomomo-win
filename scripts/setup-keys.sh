#!/usr/bin/env bash
# 提取微信数据库密钥（仅密钥，无聊天内容）。
# 密钥提取用审计过的 wcdb-key-tool（Python + lldb），之后的查询/解密全在 TS 里做。
#
# 默认【副本模式】：复制一份微信到家目录、只签这份副本、用它提 key，
#   全程不碰 /Applications 的原版 —— 原版始终保持腾讯签名，截图/录屏权限不受影响，
#   也不需要 App Management 授权（家目录签名不受保护）。
# 传 --in-place 才会重签名 /Applications（会破坏截图权限，不推荐）。
#
# 密钥落到应用数据目录（与 src/config.ts 的 SECRETS_DIR 一致），dashboard「群组」页的引导按钮
# 也是在终端里跑本脚本；FOMOMO_DATA_DIR 与 sidecar 同义（测试 / 多实例用）。
set -euo pipefail

SECRETS="${FOMOMO_DATA_DIR:-$HOME/Library/Application Support/fomomo}/secrets"
TOOL="$SECRETS/wcdb_key_tool_macos.py"
KEYS="$SECRETS/all_keys.json"

MODE="copy"
[ "${1:-}" = "--in-place" ] && MODE="inplace"

WECHAT_APP="/Applications/WeChat.app"
[ -d "$WECHAT_APP" ] || WECHAT_APP="$HOME/Applications/WeChat.app"
COPY="$HOME/WeChat-extract.app"

mkdir -p "$SECRETS"
chmod 700 "$SECRETS"

COPY_PID=""
cleanup() {
  if [ "$MODE" = "copy" ]; then
    # 只收副本：按 PID 杀，不用 `quit app "WeChat"`（原版此时可能已被用户重新打开）
    [ -n "$COPY_PID" ] && kill "$COPY_PID" 2>/dev/null || true
    sleep 1
    rm -rf "$COPY"
  fi
}
trap cleanup EXIT

# 等一个名叫 WeChat 的进程全部退出（最多 ~10s），不行就强杀。原版没退干净的话：
# 1) wcdb-key-tool 按 `pgrep -x WeChat` 取第一个 PID，会 attach 到带 Hardened Runtime 的原版而失败；
# 2) LaunchServices 见到同 bundle id 的实例在跑，`open` 副本会被重定向成激活原版。
wait_wechat_gone() {
  for _ in $(seq 1 20); do pgrep -xq WeChat || return 0; sleep 0.5; done
  echo "    微信没有在 10s 内退出，强制结束"
  killall WeChat 2>/dev/null || true
  sleep 1
  pgrep -xq WeChat && { echo "    仍有 WeChat 进程在跑，请手动退出后重试" >&2; return 1; }
  return 0
}

echo "==> 1/4 下载 wcdb-key-tool (macOS)"
if [ ! -f "$TOOL" ]; then
  curl -fsSL https://raw.githubusercontent.com/TANGandXUE/wcdb-key-tool/main/wcdb_key_tool_macos.py -o "$TOOL"
  echo "    已保存到 $TOOL —— 建议自己通读一遍再运行（821 行，零网络）"
else
  echo "    已存在，跳过下载"
fi

echo "==> 2/4 检查 lldb 与微信"
command -v lldb >/dev/null 2>&1 || { echo "    未检测到 lldb，请先: xcode-select --install" >&2; exit 1; }
[ -d "$WECHAT_APP" ] || { echo "    未找到 WeChat.app（$WECHAT_APP）" >&2; exit 1; }

if [ "$MODE" = "copy" ]; then
  echo "==> 3/4 [副本模式] 复制并签名副本（不动 /Applications 原版）"
  echo "    先退出正在运行的微信（同一账号容器，需独占）..."
  osascript -e 'quit app "WeChat"' >/dev/null 2>&1 || true
  wait_wechat_gone
  rm -rf "$COPY"
  echo "    复制 $WECHAT_APP -> $COPY ..."
  cp -R "$WECHAT_APP" "$COPY"
  codesign --force --deep --sign - "$COPY"
  echo "    已 ad-hoc 签名副本（家目录，无需 sudo / App 管理授权）"
  echo "    启动副本..."
  # 直接执行副本里的二进制而不是 `open`：LaunchServices 会按 bundle id 把 open 解析回 /Applications 注册的原版
  "$COPY/Contents/MacOS/WeChat" >/dev/null 2>&1 &
  COPY_PID=$!
  disown "$COPY_PID" 2>/dev/null || true
  echo ""
  echo "    ⚠️ 请在弹出的【副本微信】里登录（若要求登录就扫码/密码登录）。"
  echo "       登录本身就会触发密钥计算，正是断点要抓的时刻。"
  read -r -p "    登录完成后回车，开始提取…" _
else
  echo "==> 3/4 [in-place 模式] 重签名 /Applications/WeChat.app（会破坏截图权限，不推荐）"
  echo "    即将执行: sudo codesign --force --deep --sign - $WECHAT_APP"
  read -r -p "    继续? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "已取消"; exit 1; }
  sudo codesign --force --deep --sign - "$WECHAT_APP"
  echo "    完成。请【重启微信】后回车继续..."
  read -r _
fi

echo "==> 4/4 提取密钥"
echo "    若提示「退出登录再重新登录」，就在当前这个微信窗口里退登→重登（180s 内）。"
# 只提取密钥，不加 --decrypt（解密由 TS 端按需完成）
cd "$SECRETS"
sudo python3 "$TOOL" extract --output "$KEYS"

# wcdb-key-tool 以 root 身份写文件，改回当前用户并收紧权限
sudo chown "$(id -un):$(id -gn)" "$KEYS" 2>/dev/null || true
chmod 600 "$KEYS"

echo ""
echo "✅ 密钥已就绪: $KEYS (权限 600)"
if [ "$MODE" = "copy" ]; then
  echo "   副本将自动退出并删除；日常继续用 /Applications 的原版微信（截图正常）。"
fi
echo "   回到 fomomo 的 dashboard「群组」页：微信来源会自动变为就绪，勾好要监听的群点「保存」即可。"
