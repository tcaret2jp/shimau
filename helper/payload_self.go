//go:build !(windows && setup)

package main

// セットアップ版以外は、自分自身をコピーしてインストールする
var embeddedHelper []byte
