#!/bin/bash
# Mac（Apple Silicon / Intel）・Windows 向けにヘルパーをビルドし、配布用ファイルを作る
# 出力:
#   helper/dist/shimau-helper-mac.zip     中身は「shimau ヘルパー.app」（ダブルクリックでインストール）
#                                         署名できなかったときは shimau-helper-mac-unsigned.zip
#   helper/dist/shimau-helper-setup.exe   ダブルクリックでインストール
#
# Mac 用アプリは署名（ad-hoc）しないと、Mac で「壊れているため開けません」になる。
# rcodesign（https://github.com/indygreg/apple-platform-rs）があれば Pi 上で署名する。
# なければ署名なしで作り、Mac で sign-mac.sh を実行して仕上げる。
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/^const version = "\(.*\)"/\1/p' main.go)
OUT=dist
APP="$OUT/mac/shimau ヘルパー.app"
rm -rf "$OUT" setup_payload && mkdir -p "$OUT/mac" "$OUT/tmp" setup_payload

build() { # GOOS GOARCH 出力先 [追加の引数…]
  local os=$1 arch=$2 out=$3; shift 3
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w ${LDX:-}" "$@" -o "$out" .
  echo "built $out"
}

# ---- Mac ----
build darwin arm64 "$OUT/tmp/darwin-arm64"
build darwin amd64 "$OUT/tmp/darwin-amd64"
python3 -I tools/macapp.py "$APP" "$VERSION" "$OUT/tmp/darwin-arm64" "$OUT/tmp/darwin-amd64" ../extension/icons/icon128.png
# 署名できたときだけ配布用の名前（はじめての設定画面がダウンロードする名前）にする
RCS=${RCODESIGN:-$(command -v rcodesign || ls "$HOME/.local/bin/rcodesign" 2>/dev/null || true)}
if [ -n "$RCS" ]; then
  "$RCS" sign "$APP" >/dev/null
  # rcodesign の verify は不具合があるため使わない。代わりに、両方の CPU 向けの署名に
  # Info.plist と中身一覧（CodeResources）のハッシュが入り、実ファイルと一致するかを確かめる
  SIG=$("$RCS" print-signature-info "$APP/Contents/MacOS/shimau-helper" 2>/dev/null)
  for f in "Info (1):Info.plist" "Resources (3):_CodeSignature/CodeResources"; do
    slot=${f%%:*}; file=${f#*:}
    h=$(sha256sum "$APP/Contents/$file" | cut -d' ' -f1)
    [ "$(grep -c "'$slot: $h'" <<<"$SIG")" = 2 ] || { echo "署名の確認に失敗しました（$file）" >&2; exit 1; }
  done
  echo "signed (ad-hoc) $APP"
  MACZIP=shimau-helper-mac.zip
else
  MACZIP=shimau-helper-mac-unsigned.zip
  echo "注意: rcodesign がないため Mac 用アプリは未署名です（$MACZIP）。Mac で helper/sign-mac.sh を実行して shimau-helper-mac.zip を作ってください。" >&2
fi
(cd "$OUT/mac" && zip -qry "../$MACZIP" "shimau ヘルパー.app")

# ---- Windows ----
# Brave はヘルパーをコンソールアプリとして起動するので、ヘルパー本体はコンソール版。
# セットアップ版はウィンドウなし（-H windowsgui）で、本体を中に埋め込む。
build windows amd64 setup_payload/shimau-helper.exe
LDX="-H windowsgui" build windows amd64 "$OUT/shimau-helper-setup.exe" -tags setup

rm -rf "$OUT/tmp"
ls -la "$OUT"/*.zip "$OUT"/*.exe
