#!/bin/bash
# shimau ヘルパーを Mac にインストールする（管理者権限は不要）
set -euo pipefail

HOST_NAME="com.shimau.helper"
EXT_ID="clnofopcnjnjgknoflaipaohdofeolng"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/shimau"

case "$(uname -m)" in
  arm64) BIN="shimau-helper-darwin-arm64" ;;
  x86_64) BIN="shimau-helper-darwin-amd64" ;;
  *) echo "未対応の CPU です: $(uname -m)" >&2; exit 1 ;;
esac
if [ ! -f "$HERE/$BIN" ]; then
  echo "$HERE/$BIN が見つかりません。配布用の zip を展開したフォルダで実行してください。" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
cp "$HERE/$BIN" "$APP_DIR/shimau-helper"
chmod 755 "$APP_DIR/shimau-helper"
# ダウンロードしたファイルに付く「隔離」属性を外す（未署名でも起動できるように）
xattr -d com.apple.quarantine "$APP_DIR/shimau-helper" 2>/dev/null || true

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "shimau helper",
  "path": "$APP_DIR/shimau-helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

# Brave（と、念のため Chrome）にヘルパーの場所を登録する
for d in \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"; do
  mkdir -p "$d"
  printf '%s\n' "$MANIFEST" > "$d/$HOST_NAME.json"
done

echo "✓ インストールしました: $APP_DIR/shimau-helper"
"$APP_DIR/shimau-helper" --version
echo "Brave を再起動し、shimau の設定画面の「ヘルパー」で「接続中」になっているか確認してください。"
