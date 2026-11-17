#!/bin/bash
# shimau ヘルパーを Mac からアンインストールする
set -euo pipefail

HOST_NAME="com.shimau.helper"
APP_DIR="$HOME/Library/Application Support/shimau"

rm -f "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$APP_DIR/shimau-helper"
echo "✓ ヘルパーを削除しました（設定ファイル $APP_DIR/config.json は残しています）"
