package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

const testKey = "MIIBtestkey"

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func manifest(ver, key string) string {
	b, _ := json.Marshal(map[string]string{"name": "shimau", "version": ver, "key": key})
	return string(b)
}

// fakeRelease は GitHub の Release の代わりのサーバーを立て、鍵と配布ファイルを差し替える
type fakeRelease struct {
	t       *testing.T
	priv    ed25519.PrivateKey
	assets  map[string][]byte // ファイル名 → 中身
	latest  []byte
	sig     []byte
	hits    map[string]int
	tamper  bool // latest.json を署名のあとで書き換える
	badFile bool // 配布ファイルの中身を差し替える
}

func newFakeRelease(t *testing.T, ver string, ext []byte) *fakeRelease {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := &fakeRelease{t: t, priv: priv, assets: map[string][]byte{"shimau-extension.zip": ext}, hits: map[string]int{}}
	sum := sha256.Sum256(ext)
	body, _ := json.Marshal(map[string]any{
		"version": ver, "tag": "v" + ver, "publishedAt": "2026-11-24", "notes": []string{"いろいろ直した"},
		"url":   "https://example.invalid/v" + ver,
		"files": map[string]any{"extension": map[string]any{"name": "shimau-extension.zip", "sha256": hex.EncodeToString(sum[:]), "size": len(ext)}},
	})
	f.latest = body
	f.sig = []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body)))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits[r.URL.Path]++
		switch r.URL.Path {
		case "/latest/download/latest.json":
			b := f.latest
			if f.tamper {
				b = bytes.Replace(b, []byte("いろいろ"), []byte("わるもの"), 1)
			}
			w.Write(b)
		case "/latest/download/latest.json.sig":
			w.Write(f.sig)
		case "/download/v" + ver + "/shimau-extension.zip":
			b := f.assets["shimau-extension.zip"]
			if f.badFile {
				b = append([]byte{}, b...)
				b[len(b)-1] ^= 0xff
			}
			w.Write(b)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	oldKey, oldBase := releasePubKey, releaseBase
	releasePubKey = base64.StdEncoding.EncodeToString(pub)
	releaseBase = func() string { return srv.URL }
	t.Cleanup(func() { releasePubKey, releaseBase = oldKey, oldBase })
	return f
}

// fakeBrave は Brave のプロフィール（Secure Preferences）に拡張機能のフォルダを登録する
func fakeBrave(t *testing.T, extDirs ...string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Brave-Browser")
	for i, d := range extDirs {
		prof := filepath.Join(root, []string{"Default", "Profile 1", "Profile 2"}[i])
		os.MkdirAll(prof, 0o755)
		b, _ := json.Marshal(map[string]any{"extensions": map[string]any{"settings": map[string]any{
			extID:   map[string]any{"path": d, "location": 4},
			"other": map[string]any{"path": "relative/path"},
		}}})
		os.WriteFile(filepath.Join(prof, "Secure Preferences"), b, 0o644)
	}
	old := browserRoots
	browserRoots = func() []string { return []string{root, filepath.Join(root, "nope")} }
	t.Cleanup(func() { browserRoots = old })
}

func extDir(t *testing.T, ver, key string) string {
	t.Helper()
	d := filepath.Join(t.TempDir(), "shimau-main", "extension")
	os.MkdirAll(filepath.Join(d, "lib"), 0o755)
	write(t, filepath.Join(d, "manifest.json"), manifest(ver, key))
	write(t, filepath.Join(d, "background.js"), "old")
	write(t, filepath.Join(d, "keep-me.txt"), "user file")
	return d
}

func newExtZip(t *testing.T, ver string) []byte {
	return makeZip(t, map[string]string{
		"manifest.json":  manifest(ver, testKey),
		"background.js":  "new",
		"lib/waiting.js": "added",
	})
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCmpVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{{"0.3.0", "0.2.1", 1}, {"0.10.0", "0.9.9", 1}, {"1.0.0", "1.0.0", 0}, {"0.2.9", "0.3.0", -1}, {"1.0", "1.0.0", 0}}
	for _, c := range cases {
		got := cmpVersion(c.a, c.b)
		if (got > 0) != (c.want > 0) || (got < 0) != (c.want < 0) {
			t.Errorf("cmpVersion(%s, %s) = %d", c.a, c.b, got)
		}
	}
}

func TestCheckUpdate(t *testing.T) {
	newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	out, err := (&app{}).checkUpdate()
	if err != nil {
		t.Fatal(err)
	}
	l := out["latest"].(map[string]any)
	if l["version"] != "0.4.0" || l["url"] != "https://example.invalid/v0.4.0" {
		t.Fatalf("latest = %v", l)
	}
}

func TestCheckUpdateBadSignature(t *testing.T) {
	f := newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	f.tamper = true
	if _, err := (&app{}).checkUpdate(); code(err) != "BAD_SIGNATURE" {
		t.Fatalf("err = %v", err)
	}
	// 別の鍵で署名したもの
	f.tamper = false
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	f.sig = []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(other, f.latest)))
	if _, err := (&app{}).checkUpdate(); code(err) != "BAD_SIGNATURE" {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckUpdateNetwork(t *testing.T) {
	old := releaseBase
	releaseBase = func() string { return "http://127.0.0.1:1" }
	t.Cleanup(func() { releaseBase = old })
	if _, err := (&app{}).checkUpdate(); code(err) != "NETWORK" {
		t.Fatalf("err = %v", err)
	}
}

func TestApplyUpdateExtension(t *testing.T) {
	newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	d := extDir(t, "0.3.0", testKey)
	other := extDir(t, "1.0.0", "SOMEONE-ELSE") // 同じ id で別の拡張機能（key が違う）は触らない
	fakeBrave(t, d, other)
	out, err := (&app{}).applyUpdate("0.3.0")
	if err != nil {
		t.Fatal(err)
	}
	ext := out["extension"].(map[string]any)
	if ext["status"] != "updated" {
		t.Fatalf("extension = %v", ext)
	}
	if read(t, filepath.Join(d, "background.js")) != "new" || read(t, filepath.Join(d, "lib", "waiting.js")) != "added" {
		t.Fatal("ファイルが置き換わっていない")
	}
	if read(t, filepath.Join(d, "keep-me.txt")) != "user file" {
		t.Fatal("古い版にしかないファイルを消した")
	}
	if manifestKey([]byte(read(t, filepath.Join(d, "manifest.json")))) != testKey || !bytes.Contains([]byte(read(t, filepath.Join(d, "manifest.json"))), []byte("0.4.0")) {
		t.Fatal("manifest.json が新しくない")
	}
	if read(t, filepath.Join(other, "background.js")) != "old" {
		t.Fatal("別の拡張機能を書き換えた")
	}
	if runtime.GOOS == "linux" && out["helper"].(map[string]any)["status"] != "unsupported" {
		t.Fatalf("helper = %v", out["helper"])
	}
}

func TestApplyUpdateDevFolder(t *testing.T) {
	newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	d := extDir(t, "0.3.0", testKey)
	os.MkdirAll(filepath.Join(filepath.Dir(d), ".git"), 0o755) // リポジトリの extension フォルダ
	fakeBrave(t, d)
	out, err := (&app{}).applyUpdate("0.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if s := out["extension"].(map[string]any)["status"]; s != "dev" {
		t.Fatalf("status = %v", s)
	}
	if read(t, filepath.Join(d, "background.js")) != "old" {
		t.Fatal("開発用のフォルダを書き換えた")
	}
}

func TestApplyUpdateNotFoundAndCurrent(t *testing.T) {
	f := newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	fakeBrave(t)
	out, err := (&app{}).applyUpdate("0.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if s := out["extension"].(map[string]any)["status"]; s != "notFound" {
		t.Fatalf("status = %v", s)
	}
	// 拡張機能が最新ならダウンロードしない
	n := f.hits["/download/v0.4.0/shimau-extension.zip"]
	out, err = (&app{}).applyUpdate("0.4.0")
	if err != nil {
		t.Fatal(err)
	}
	if s := out["extension"].(map[string]any)["status"]; s != "current" || f.hits["/download/v0.4.0/shimau-extension.zip"] != n {
		t.Fatalf("status = %v", s)
	}
}

func TestApplyUpdateBadFile(t *testing.T) {
	f := newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	f.badFile = true
	d := extDir(t, "0.3.0", testKey)
	fakeBrave(t, d)
	if _, err := (&app{}).applyUpdate("0.3.0"); code(err) != "BAD_FILE" {
		t.Fatalf("err = %v", err)
	}
	if read(t, filepath.Join(d, "background.js")) != "old" {
		t.Fatal("壊れたファイルで書き換えた")
	}
}

func TestReadExtensionZipRejectsBadNames(t *testing.T) {
	for _, name := range []string{"../evil.js", "/abs.js", "a/../../b.js", `a\b.js`} {
		z := makeZip(t, map[string]string{"manifest.json": manifest("1.0.0", testKey), name: "x"})
		if _, err := readExtensionZip(z); code(err) != "BAD_FILE" {
			t.Errorf("%q: err = %v", name, err)
		}
	}
	if _, err := readExtensionZip(makeZip(t, map[string]string{"a.js": "x"})); code(err) != "BAD_FILE" {
		t.Errorf("manifest.json なし: err = %v", err)
	}
}

func TestReplaceHelper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("シェルスクリプトで代用するため")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "shimau-helper")
	write(t, exe, "#!/bin/sh\necho shimau-helper 0.3.0 \"(linux/arm64)\"\n")
	os.Chmod(exe, 0o755)
	old := helperExePath
	helperExePath = func() (string, error) { return exe, nil }
	t.Cleanup(func() { helperExePath = old })

	// 起動しない版は入れず、元に戻す
	if err := replaceHelper([]byte("#!/bin/sh\nexit 1\n"), "0.4.0"); code(err) != "BAD_FILE" {
		t.Fatalf("err = %v", err)
	}
	if exeVersion(exe) != "0.3.0" {
		t.Fatal("元に戻っていない")
	}
	if err := replaceHelper([]byte("#!/bin/sh\necho shimau-helper 0.4.0 \"(linux/arm64)\"\n"), "0.4.0"); err != nil {
		t.Fatal(err)
	}
	if exeVersion(exe) != "0.4.0" {
		t.Fatal("置き換わっていない")
	}
	if _, err := os.Stat(exe + ".old"); !os.IsNotExist(err) {
		t.Fatal(".old が残っている")
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("余計なファイル: %v", ents)
	}
}

func TestCheckFiles(t *testing.T) {
	_, dl, dest := setup(t)
	f := filepath.Join(dl, "a.mp4")
	write(t, f, "x")
	got := checkFiles([]string{f, filepath.Join(dl, "nope.mp4"), dest})
	if got[f] == nil || got[f].Size != 1 || got[f].MTime == 0 || got[filepath.Join(dl, "nope.mp4")] != nil || got[dest] != nil {
		t.Fatalf("checkFiles = %v", got)
	}
}

func TestApplyUpdateNoDowngradeOtherProfile(t *testing.T) {
	newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	newer := extDir(t, "0.5.0", testKey) // 別のプロフィールではもっと新しい版
	older := extDir(t, "0.3.0", testKey)
	fakeBrave(t, newer, older)
	out, err := (&app{}).applyUpdate("0.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if s := out["extension"].(map[string]any)["status"]; s != "updated" {
		t.Fatalf("status = %v", s)
	}
	if read(t, filepath.Join(newer, "background.js")) != "old" || read(t, filepath.Join(older, "background.js")) != "new" {
		t.Fatal("新しい版を古い版で上書きした／古い版を更新していない")
	}
}

func TestApplyUpdateLocked(t *testing.T) {
	newFakeRelease(t, "0.4.0", newExtZip(t, "0.4.0"))
	lock := filepath.Join(t.TempDir(), "lock")
	old := updateLockPath
	updateLockPath = func() string { return lock }
	t.Cleanup(func() { updateLockPath = old })
	write(t, lock, "123")
	if _, err := (&app{}).applyUpdate("0.3.0"); code(err) != "BUSY" {
		t.Fatalf("err = %v", err)
	}
	// 古いロック（止まった更新の残り）は消して進む
	past := time.Now().Add(-time.Hour)
	os.Chtimes(lock, past, past)
	fakeBrave(t)
	if _, err := (&app{}).applyUpdate("0.3.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatal("ロックが残っている")
	}
}

func TestWriteExtensionRollback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	d := extDir(t, "0.3.0", testKey)
	// lib を書き込み禁止にして、途中で失敗させる
	os.Chmod(filepath.Join(d, "lib"), 0o555)
	t.Cleanup(func() { os.Chmod(filepath.Join(d, "lib"), 0o755) })
	err := writeExtension(d, map[string][]byte{
		"manifest.json":  []byte(manifest("0.4.0", testKey)),
		"background.js":  []byte("new"),
		"lib/waiting.js": []byte("x"),
	})
	if err == nil {
		t.Fatal("失敗するはず")
	}
	if read(t, filepath.Join(d, "background.js")) != "old" || !bytes.Contains([]byte(read(t, filepath.Join(d, "manifest.json"))), []byte("0.3.0")) {
		t.Fatal("元に戻っていない")
	}
	ents, _ := os.ReadDir(d)
	for _, e := range ents {
		if bytes.HasPrefix([]byte(e.Name()), []byte(".shimau-")) {
			t.Fatalf("一時ファイルが残っている: %s", e.Name())
		}
	}
}
