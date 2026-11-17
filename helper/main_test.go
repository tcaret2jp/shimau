package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestCopyAcross(t *testing.T) {
	_, dl, dest := setup(t)
	write(t, filepath.Join(dest, "big.bin"), "old")
	src := filepath.Join(dl, "big.bin")
	write(t, src, strings.Repeat("z", 3<<20)) // バッファ（1MB）より大きい
	fi, _ := os.Stat(src)
	got, err := copyAcross(src, dest, "big.bin", fi)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got) != "big (1).bin" {
		t.Fatalf("got %s", got)
	}
	if di, _ := os.Stat(got); di.Size() != 3<<20 || di.Mode().Perm() != 0o644 {
		t.Fatalf("size/perm %v", di)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "big.bin")); string(b) != "old" {
		t.Fatal("既存ファイルが上書きされた")
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("元が残っている")
	}
	assertNoParts(t, dest)
}

func assertNoParts(t *testing.T, dir string) {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), partPrefix) {
			t.Fatalf("一時ファイルが残っている: %s", e.Name())
		}
	}
}

func TestCopyAcrossKeepsReplacedSource(t *testing.T) {
	_, dl, dest := setup(t)
	src := filepath.Join(dl, "a.txt")
	write(t, src, "original")
	fi, _ := os.Stat(src)
	tmp, in, err := copyToTemp(src, dest, fi)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp)
	// コピー中に同じ名前の別ファイルへ差し替えられた
	os.Remove(src)
	write(t, src, "another")
	removeSource(src, in)
	if b, _ := os.ReadFile(src); string(b) != "another" {
		t.Fatal("差し替え後の別ファイルを消してしまった")
	}
}

func TestCleanStaleParts(t *testing.T) {
	_, _, dest := setup(t)
	old := filepath.Join(dest, partPrefix+"1"+partSuffix)
	fresh := filepath.Join(dest, partPrefix+"2"+partSuffix)
	write(t, old, "x")
	write(t, fresh, "x")
	past := time.Now().Add(-48 * time.Hour)
	os.Chtimes(old, past, past)
	cleanStaleParts(dest)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("古い一時ファイルが残っている")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("コピー中かもしれない新しい一時ファイルを消した")
	}
}

func TestTrailingSpaceName(t *testing.T) {
	a, dl, dest := setup(t)
	write(t, filepath.Join(dl, "r.pdf"), "plain")
	src := filepath.Join(dl, "r.pdf ")
	write(t, src, "space")
	got, err := a.move(src, dest)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(got); string(b) != "space" {
		t.Fatal("別のファイルを動かした")
	}
	if _, err := os.Stat(filepath.Join(dl, "r.pdf")); err != nil {
		t.Fatal("空白なしのファイルが動いた")
	}
}

func TestNumbered(t *testing.T) {
	cases := map[string]string{"a.pdf": "a (3).pdf", "archive.tar.gz": "archive (3).tar.gz", "x.TAR.XZ": "x (3).TAR.XZ", "noext": "noext (3)", ".env": ".env (3)", "a.b.c": "a.b (3).c"}
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
