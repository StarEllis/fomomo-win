#!/usr/bin/env bash
# 发一个版本：改 package.json 的 version → 提交「vX.Y.Z」→ 打 tag vX.Y.Z → 推 main 和 tag。
# tag 一到 GitHub，.github/workflows/release.yml 就在 macos-26 上跑测试、scripts/build-app.sh，把 zip 附到同名 Release。
#   scripts/release.sh 0.1.2        # 也可 pnpm release 0.1.2
# 要求工作区干净（未提交的改动先自己提交），版本号是 X.Y.Z（CFBundleShortVersionString 只接受最多三段整数）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "用法: scripts/release.sh X.Y.Z（如 0.1.2）" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "工作区有未提交的改动，先提交再发版" >&2; git status --short >&2; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "请在 main 上发版（当前 $(git branch --show-current)）" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && { echo "tag v$V 已存在" >&2; exit 1; }
CUR="$(node -p "require('./package.json').version")"
[ "$V" != "$CUR" ] || { echo "package.json 已经是 $V，请给一个新版本号" >&2; exit 1; }

git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "本地 main 与 origin/main 不一致，先 pull / push" >&2; exit 1; }

# 只改 version 字段，保留其余格式（node 重写会保持 2 空格缩进，与仓库一致）
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='$V';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
git add package.json
git commit -q -m "v$V"
git tag -a "v$V" -m "v$V"
git push -q origin main
git push -q origin "v$V"
echo "✅ v$V 已推送；CI: https://github.com/nishuzumi/fomomo/actions  Release: https://github.com/nishuzumi/fomomo/releases/tag/v$V"
