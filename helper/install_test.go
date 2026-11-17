package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestIsNativeMessaging(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{"h"}, false},                                                          // ダブルクリック
		{[]string{"h", "-psn_0_12345"}, false},                                          // 古い macOS の Finder から
		{[]string{"h", "chrome-extension://" + extID + "/"}, true},                      // Mac / Linux の Brave
		{[]string{"h", "chrome-extension://" + extID + "/", "--parent-window=0"}, true}, // Windows の Brave
	}
	for _, c := range cases {
		if got := isNativeMessaging(c.args); got != c.want {
			t.Errorf("%v: got %v", c.args, got)
		}
	}
}

func testInstaller(t *testing.T) (*installer, []string) {
	root := t.TempDir()
	var registered []string
	in := &installer{
		dir:          filepath.Join(root, "app", "shimau"),
		exeName:      "shimau-helper",
		manifestDirs: []string{filepath.Join(root, "brave"), filepath.Join(root, "chrome")},
		register:     func(p string) error { registered = append(registered, p); return nil },
	}
	return in, registered
}

// 版を答えるだけの偽ヘルパー
const fakeHelper = "#!/bin/sh\necho 'shimau-helper 9.9.9 (linux/arm64)'\n"

func TestInstallAndUninstall(t *testing.T) {
	in, _ := testInstaller(t)
	if v := in.installedVersion(); v != "" {
		t.Fatalf("入る前なのに %q", v)
	}
	if err := in.install([]byte(fakeHelper)); err != nil {
		t.Fatal(err)
	}
	if v := in.installedVersion(); v != "9.9.9" {
		t.Fatalf("版 %q", v)
	}
	for _, d := range in.manifestDirs {
		b, err := os.ReadFile(filepath.Join(d, hostName+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		if m["path"] != in.exe() || m["name"] != hostName {
			t.Fatalf("マニフェストが違う: %s", b)
		}
		if o := m["allowed_origins"].([]any); len(o) != 1 || o[0] != "chrome-extension://"+extID+"/" {
			t.Fatalf("allowed_origins: %v", o)
		}
	}
	if left, _ := filepath.Glob(filepath.Join(in.dir, ".shimau-helper-*")); len(left) > 0 {
		t.Fatalf("一時ファイルが残っている: %v", left)
	}

	// 入れ直し（上書き）できる
	if err := in.install([]byte(fakeHelper)); err != nil {
		t.Fatal(err)
	}

	// 設定ファイルは削除しても残す
	cfg := filepath.Join(in.dir, "config.json")
	os.WriteFile(cfg, []byte("{}"), 0o600)
	if err := in.uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(in.exe()); !os.IsNotExist(err) {
		t.Fatal("ヘルパーが残っている")
	}
	for _, d := range in.manifestDirs {
		if _, err := os.Stat(filepath.Join(d, hostName+".json")); !os.IsNotExist(err) {
			t.Fatal("マニフェストが残っている")
		}
	}
	if _, err := os.Stat(cfg); err != nil {
		t.Fatal("設定ファイルまで消えた")
	}
	// 2 回消してもエラーにしない
	if err := in.uninstall(); err != nil {
		t.Fatal(err)
	}
}

func TestInstalledVersionBroken(t *testing.T) {
	in, _ := testInstaller(t)
	if err := in.install([]byte("#!/bin/sh\nexit 1\n")); err != nil {
		t.Fatal(err)
	}
	if v := in.installedVersion(); v != "?" {
		t.Fatalf("壊れたヘルパーは ? のはず: %q", v)
	}
}

func TestRegisterCalledPerManifest(t *testing.T) {
	root := t.TempDir()
	var got []string
	in := &installer{
		dir: filepath.Join(root, "shimau"), exeName: "h",
		manifestDirs: []string{filepath.Join(root, "shimau")},
		register:     func(p string) error { got = append(got, p); return nil },
	}
	if err := in.install([]byte(fakeHelper)); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != filepath.Join(root, "shimau", hostName+".json") {
		t.Fatalf("register: %v", got)
	}
}

// ヘルパーを消せないときは、登録を残す（Brave からつながらなくなるのを防ぐ）
func TestUninstallKeepsRegistrationWhenExeLocked(t *testing.T) {
	in, _ := testInstaller(t)
	if err := in.install([]byte(fakeHelper)); err != nil {
		t.Fatal(err)
	}
	// 実行ファイルの代わりに中身のあるフォルダを置いて、削除を失敗させる
	os.Remove(in.exe())
	os.MkdirAll(filepath.Join(in.exe(), "x"), 0o755)
	if err := in.uninstall(); err == nil {
		t.Fatal("失敗するはず")
	}
	for _, d := range in.manifestDirs {
		if _, err := os.Stat(filepath.Join(d, hostName+".json")); err != nil {
			t.Fatal("登録まで消えた")
		}
	}
}
