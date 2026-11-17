//go:build windows && setup

package main

// Windows のセットアップ版（shimau-helper-setup.exe）。
// Brave はヘルパーをコンソールアプリとして起動するため、ウィンドウを出さないセットアップ版とは別にビルドし、
// コンソール版のヘルパーを中に埋め込んでおく（build.sh が setup_payload/ に置く）。

import _ "embed"

//go:embed setup_payload/shimau-helper.exe
var embeddedHelper []byte
