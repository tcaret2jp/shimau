#!/bin/bash
# Mac（Apple Silicon / Intel）・Windows 向けにヘルパーをビルドし、配布用 zip を作る
# 出力: helper/dist/shimau-helper-mac.zip, helper/dist/shimau-helper-windows.zip
set -euo pipefail
cd "$(dirname "$0")"

OUT=dist
rm -rf "$OUT" && mkdir -p "$OUT/mac" "$OUT/windows"

build() { # GOOS GOARCH 出力先
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -ldflags "-s -w" -o "$3" .
  echo "built $3"
}
build darwin arm64 "$OUT/mac/shimau-helper-darwin-arm64"
build darwin amd64 "$OUT/mac/shimau-helper-darwin-amd64"
build windows amd64 "$OUT/windows/shimau-helper-windows-amd64.exe"

cp install/mac/*.sh "$OUT/mac/" && chmod +x "$OUT/mac/"*.sh "$OUT/mac/shimau-helper-"*
cp install/windows/*.ps1 "$OUT/windows/"

(cd "$OUT/mac" && zip -q -X ../shimau-helper-mac.zip ./*)
(cd "$OUT/windows" && zip -q -X ../shimau-helper-windows.zip ./*)
ls -la "$OUT"/*.zip
