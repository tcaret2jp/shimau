#!/bin/bash
# Pi でビルドした未署名の Mac 用アプリを Mac で署名（ad-hoc）し、配布用の shimau-helper-mac.zip を作る。
# Pi に rcodesign がない場合だけ使う（開発者用。利用者は使わない）。
# 使い方（Mac で）: bash sign-mac.sh shimau-helper-mac-unsigned.zip
#   → 同じフォルダに shimau-helper-mac.zip ができる
set -euo pipefail
SRC=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
DST=$(dirname "$SRC")/shimau-helper-mac.zip
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ditto -x -k "$SRC" "$WORK"
APP="$WORK/shimau ヘルパー.app"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
rm -f "$DST"
ditto -c -k --keepParent "$APP" "$DST"
echo "✓ 署名しました: $DST"
