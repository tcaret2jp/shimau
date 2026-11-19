// signrelease：アップデート用の latest.json を作り、Ed25519 で署名する（build.sh から使う）
//
//	signrelease keygen <鍵ファイル>                         鍵を作る（すでにあれば何もしない）。公開鍵（base64）を表示
//	signrelease pub <鍵ファイル>                            公開鍵（base64）を表示
//	signrelease release <鍵ファイル> <dist> <版> <変更点.txt>  dist の配布ファイルから latest.json と latest.json.sig を作る
//
// 秘密鍵はリポジトリに入れない（既定の置き場所：~/.config/shimau-release/ed25519.key）。
// なくすと、配布済みのヘルパーが新しい版を受け付けなくなる（手動で入れ直してもらうしかない）ので、別の場所にも控えておく。
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 配布ファイル（latest.json の files のキー → dist 内の名前）
var assets = map[string]string{
	"extension":     "shimau-extension.zip",
	"darwin":        "shimau-helper-darwin",
	"windows-amd64": "shimau-helper-windows-amd64.exe",
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "signrelease:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		return errors.New("使い方: signrelease keygen|pub|release <鍵ファイル> ...")
	}
	keyPath := args[1]
	switch args[0] {
	case "keygen":
		if _, err := os.Stat(keyPath); err == nil {
			return printPub(keyPath)
		}
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(priv.Seed())+"\n"), 0o600); err != nil {
			return err
		}
		return printPub(keyPath)
	case "pub":
		return printPub(keyPath)
	case "release":
		if len(args) != 5 {
			return errors.New("使い方: signrelease release <鍵ファイル> <dist> <版> <変更点.txt>")
		}
		return release(keyPath, args[2], args[3], args[4])
	}
	return fmt.Errorf("不明なコマンド: %s", args[0])
}

func loadKey(p string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("鍵ファイルが正しくありません")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func printPub(p string) error {
	k, err := loadKey(p)
	if err != nil {
		return err
	}
	fmt.Println(base64.StdEncoding.EncodeToString(k.Public().(ed25519.PublicKey)))
	return nil
}

type file struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func release(keyPath, dist, version, notesPath string) error {
	k, err := loadKey(keyPath)
	if err != nil {
		return err
	}
	var notes []string
	if b, err := os.ReadFile(notesPath); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			l = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "-"))
			if l != "" && !strings.HasPrefix(l, "#") {
				notes = append(notes, l)
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	files := map[string]file{}
	for key, name := range assets {
		b, err := os.ReadFile(filepath.Join(dist, name))
		if errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "注意: %s がないため latest.json に入れません\n", name)
			continue
		}
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		files[key] = file{Name: name, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))}
	}
	if _, ok := files["extension"]; !ok {
		return errors.New("shimau-extension.zip がありません")
	}
	tag := "v" + version
	body, err := json.MarshalIndent(map[string]any{
		"version":     version,
		"tag":         tag,
		"publishedAt": time.Now().Format("2006-01-02"),
		"notes":       notes,
		"url":         "https://github.com/tcaret2jp/shimau/releases/tag/" + tag,
		"files":       files,
	}, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	if err := os.WriteFile(filepath.Join(dist, "latest.json"), body, 0o644); err != nil {
		return err
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(k, body)) + "\n"
	if err := os.WriteFile(filepath.Join(dist, "latest.json.sig"), []byte(sig), 0o644); err != nil {
		return err
	}
	fmt.Printf("latest.json（v%s、%d ファイル）と署名を作りました\n", version, len(files))
	return nil
}
