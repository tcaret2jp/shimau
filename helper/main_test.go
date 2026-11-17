package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// テスト用の環境：ダウンロードフォルダと保存先を一時フォルダに作る
func setup(t *testing.T) (a *app, dl, dest string) {
	t.Helper()
	root := t.TempDir()
	dl = filepath.Join(root, "Downloads")
	dest = filepath.Join(root, "Drive", "大学")
	for _, d := range []string{dl, dest} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	a = &app{cfgPath: filepath.Join(root, "cfg", "config.json"), downloadDirs: []string{dl}}
	if err := a.syncDestinations([]string{dest}); err != nil {
		t.Fatal(err)
	}
	return a, dl, dest
}

func write(t *testing.T, p, body string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func code(err error) string {
	if ce, ok := err.(*codeError); ok {
		return ce.Code
	}
	if err == nil {
		return ""
	}
	return "OTHER:" + err.Error()
}

func TestMoveBasic(t *testing.T) {
	a, dl, dest := setup(t)
	src := filepath.Join(dl, "講義資料.pdf")
	write(t, src, "hello")
	got, err := a.move(src, dest)
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(dest, "講義資料.pdf") {
		t.Fatalf("path = %s", got)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("元ファイルが残っている")
	}
	if b, _ := os.ReadFile(got); string(b) != "hello" {
		t.Fatal("中身が違う")
	}
}

func TestMoveNumbersOnConflict(t *testing.T) {
	a, dl, dest := setup(t)
	write(t, filepath.Join(dest, "a.pdf"), "old")
	write(t, filepath.Join(dest, "a (1).pdf"), "old1")
	src := filepath.Join(dl, "a.pdf")
	write(t, src, "new")
	got, err := a.move(src, dest)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got) != "a (2).pdf" {
		t.Fatalf("got %s", got)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "a.pdf")); string(b) != "old" {
		t.Fatal("既存ファイルが上書きされた")
	}
}

func TestMoveRejects(t *testing.T) {
	a, dl, dest := setup(t)
	outside := filepath.Join(filepath.Dir(dl), "secret.txt")
	write(t, outside, "x")
	if _, err := a.move(outside, dest); code(err) != "SRC_NOT_ALLOWED" {
		t.Fatalf("ダウンロード外のファイル: %v", err)
	}
	// ../ で抜け出そうとしても拒否
	if _, err := a.move(filepath.Join(dl, "..", "secret.txt"), dest); code(err) != "SRC_NOT_ALLOWED" {
		t.Fatalf("../: %v", err)
	}
	src := filepath.Join(dl, "f.txt")
	write(t, src, "x")
	other := filepath.Join(filepath.Dir(dl), "Other")
	os.MkdirAll(other, 0o755)
	if _, err := a.move(src, other); code(err) != "DEST_NOT_ALLOWED" {
		t.Fatalf("未登録の保存先: %v", err)
	}
	if _, err := a.move(filepath.Join(dl, "none.txt"), dest); code(err) != "SRC_NOT_FOUND" {
		t.Fatalf("存在しない: %v", err)
	}
	// ダウンロードフォルダ内のシンボリックリンクは移動しない
	link := filepath.Join(dl, "link.txt")
	if err := os.Symlink(outside, link); err == nil {
		if _, err := a.move(link, dest); code(err) != "SRC_NOT_ALLOWED" {
			t.Fatalf("symlink: %v", err)
		}
	}
	// ダウンロードフォルダ内のフォルダがリンクで外を指している場合も拒否
	linkDir := filepath.Join(dl, "sub")
	if err := os.Symlink(filepath.Dir(dl), linkDir); err == nil {
		if _, err := a.move(filepath.Join(linkDir, "secret.txt"), dest); code(err) != "SRC_NOT_ALLOWED" {
			t.Fatalf("symlink dir: %v", err)
		}
	}
	if _, err := os.Stat(src); err != nil {
		t.Fatal("拒否したのにファイルが消えた")
	}
}

func TestMoveDestMissingKeepsFile(t *testing.T) {
	a, dl, dest := setup(t)
	src := filepath.Join(dl, "v.mp4")
	write(t, src, "video")
	os.RemoveAll(dest) // SSD を外した状態
	if _, err := a.move(src, dest); code(err) != "DEST_NOT_FOUND" {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(src); err != nil {
		t.Fatal("ファイルがダウンロードフォルダに残っていない")
	}
}

func TestCopyThenRemove(t *testing.T) {
	_, dl, dest := setup(t)
	src := filepath.Join(dl, "big.bin")
	write(t, src, strings.Repeat("z", 100000))
	fi, _ := os.Stat(src)
	dst := filepath.Join(dest, "big.bin")
	if err := copyThenRemove(src, dst, fi); err != nil {
		t.Fatal(err)
	}
	if di, _ := os.Stat(dst); di.Size() != 100000 {
		t.Fatal("サイズ違い")
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("元が残っている")
	}
	// 宛先があるときは errExists、元は残る
	write(t, src, "again")
	fi, _ = os.Stat(src)
	if err := copyThenRemove(src, dst, fi); err != errExists {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(src); err != nil {
		t.Fatal("元が消えた")
	}
}

func TestNumbered(t *testing.T) {
	cases := map[string]string{"a.pdf": "a (3).pdf", "archive.tar.gz": "archive.tar (3).gz", "noext": "noext (3)", ".env": ".env (3)"}
	for in, want := range cases {
		if got := numbered(in, 3); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	if numbered("a.pdf", 0) != "a.pdf" {
		t.Error("0 は元の名前")
	}
}

func TestDestMustMatchExactly(t *testing.T) {
	a, dl, dest := setup(t)
	src := filepath.Join(dl, "c.txt")
	write(t, src, "x")
	upper := filepath.Join(filepath.Dir(dest), strings.ToUpper(filepath.Base(dest))+"X")
	os.MkdirAll(upper, 0o755)
	if _, err := a.move(src, upper); code(err) != "DEST_NOT_ALLOWED" {
		t.Fatalf("got %v", err)
	}
}

func TestProtocol(t *testing.T) {
	a, dl, dest := setup(t)
	src := filepath.Join(dl, "p.txt")
	write(t, src, "p")
	var in bytes.Buffer
	for _, m := range []map[string]any{
		{"cmd": "ping"},
		{"cmd": "move", "src": src, "destDir": dest},
		{"cmd": "checkPaths", "paths": []string{dest, "/nope"}},
		{"cmd": "unknown"},
	} {
		if err := writeMessage(&in, m); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := serve(a, &in, &out); err != nil {
		t.Fatal(err)
	}
	var res []map[string]any
	for {
		b, err := readMessage(&out)
		if err != nil {
			break
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		res = append(res, m)
	}
	if len(res) != 4 {
		t.Fatalf("応答数 %d", len(res))
	}
	if res[0]["ok"] != true || res[0]["version"] != version {
		t.Errorf("ping %v", res[0])
	}
	if res[1]["ok"] != true || res[1]["path"] != filepath.Join(dest, "p.txt") {
		t.Errorf("move %v", res[1])
	}
	r := res[2]["result"].(map[string]any)
	if r[dest] != true || r["/nope"] != false {
		t.Errorf("checkPaths %v", res[2])
	}
	if res[3]["ok"] != false || res[3]["code"] != "BAD_REQUEST" {
		t.Errorf("unknown %v", res[3])
	}
}

func TestSyncKeepsExtraDirs(t *testing.T) {
	a, _, _ := setup(t)
	c, _ := a.loadConfig()
	c.ExtraDownloadDirs = []string{"/data/dl"}
	a.saveConfig(c)
	a.syncDestinations([]string{"/x", " ", ""})
	c, _ = a.loadConfig()
	if len(c.Destinations) != 1 || c.ExtraDownloadDirs[0] != "/data/dl" {
		t.Fatalf("%+v", c)
	}
}
