package main

// ダブルクリックで開かれたときの「インストーラー」としての動き。
// ヘルパー自身を決まった場所へコピーし、Brave にヘルパーの場所を登録する。
// ターミナルを使わずに入れられるようにするため（2026-11-18）。

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	hostName = "com.shimau.helper"
	extID    = "clnofopcnjnjgknoflaipaohdofeolng"
)

// isNativeMessaging は Brave から起動されたかどうか（Brave は拡張機能の origin を引数に渡す）
func isNativeMessaging(args []string) bool {
	for _, a := range args[1:] {
		if strings.HasPrefix(a, "chrome-extension://") {
			return true
		}
	}
	return false
}

type installer struct {
	dir          string                      // ヘルパーを置くフォルダ
	exeName      string                      // ヘルパーのファイル名
	manifestDirs []string                    // Brave 用の登録ファイル（マニフェスト）を書くフォルダ
	register     func(manifest string) error // Windows：レジストリに登録
	unregister   func() error                // Windows：レジストリから削除
}

func (in *installer) exe() string { return filepath.Join(in.dir, in.exeName) }

func manifestJSON(exe string) ([]byte, error) {
	return json.MarshalIndent(map[string]any{
		"name":            hostName,
		"description":     "shimau helper",
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + extID + "/"},
	}, "", "  ")
}

// install はヘルパー本体をコピーし、Brave に登録する
func (in *installer) install(payload []byte) error {
	if err := os.MkdirAll(in.dir, 0o755); err != nil {
		return fmt.Errorf("フォルダを作れませんでした（%v）", err)
	}
	// 上書きすると Mac では古い署名情報と食い違って起動できなくなることがある。別名で書いてから置き換える
	// 一時ファイルは毎回別の名前にする（2 つ同時に開かれても、互いのファイルに書き込まない）
	tmp, err := writeTemp(in.dir, ".shimau-helper-*.new", payload, 0o755)
	if err != nil {
		return fmt.Errorf("ヘルパーを書き込めませんでした（%v）", err)
	}
	if err := os.Rename(tmp, in.exe()); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("ヘルパーを置き換えられませんでした。Brave を終了してから、もう一度開いてください（%v）", err)
	}
	afterCopy(in.exe())

	m, err := manifestJSON(in.exe())
	if err != nil {
		return err
	}
	for _, d := range in.manifestDirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("Brave に登録できませんでした（%v）", err)
		}
		p := filepath.Join(d, hostName+".json")
		if err := writeFileAtomic(p, m); err != nil {
			return fmt.Errorf("Brave に登録できませんでした（%v）", err)
		}
		if in.register != nil {
			if err := in.register(p); err != nil {
				return fmt.Errorf("Brave に登録できませんでした（%v）", err)
			}
		}
	}
	return nil
}

// uninstall はヘルパーと登録を消す。設定ファイル（config.json）は残す
// ヘルパーを先に消す（Brave が使用中で消せないときは、登録を残してつながる状態のままにする）
func (in *installer) uninstall() error {
	if err := os.Remove(in.exe()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("ヘルパーを削除できませんでした。Brave を終了してから、もう一度開いてください（%v）", err)
	}
	for _, d := range in.manifestDirs {
		if err := os.Remove(filepath.Join(d, hostName+".json")); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if in.unregister != nil {
		if err := in.unregister(); err != nil {
			return err
		}
	}
	os.Remove(in.dir) // 空のときだけ消える
	return nil
}

// installedVersion は入っているヘルパーの版。入っていなければ空文字
func (in *installer) installedVersion() string {
	if _, err := os.Stat(in.exe()); err != nil {
		return ""
	}
	return exeVersion(in.exe())
}

// exeVersion はヘルパーを --version で起動して版を返す。起動できなければ "?"
func exeVersion(exe string) string {
	out, err := hidden(exec.Command(exe, "--version")).Output()
	if err != nil {
		return "?" // 壊れている：入れ直す
	}
	f := strings.Fields(string(out)) // "shimau-helper 0.2.0 (darwin/arm64)"
	if len(f) < 2 {
		return "?"
	}
	return f[1]
}

// writeTemp は dir に別名の一時ファイルを作って書き込み、そのパスを返す
func writeTemp(dir, pattern string, b []byte, mode os.FileMode) (string, error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}

func writeFileAtomic(p string, b []byte) error {
	tmp, err := writeTemp(filepath.Dir(p), "."+filepath.Base(p)+"-*.tmp", b, 0o644)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// payload はインストールするヘルパー本体。Windows のセットアップ版は中に埋め込んだものを使う
func payload() ([]byte, error) {
	if len(embeddedHelper) > 0 {
		return embeddedHelper, nil
	}
	p, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if q, err := filepath.EvalSymlinks(p); err == nil {
		p = q
	}
	return os.ReadFile(p)
}

type choice int

const (
	choiceCancel choice = iota
	choiceReinstall
	choiceRemove
)

func runInstaller() {
	in, err := newInstaller()
	if err != nil {
		showError(err.Error())
		return
	}
	data, err := payload()
	if err != nil {
		showError(fmt.Sprintf("ヘルパーを読み込めませんでした（%v）", err))
		return
	}
	cur := in.installedVersion()
	if cur == version {
		switch askReinstall(fmt.Sprintf("shimau ヘルパー v%s はインストール済みです。", version)) {
		case choiceCancel:
			return
		case choiceRemove:
			if err := in.uninstall(); err != nil {
				showError(err.Error())
				return
			}
			notify("shimau ヘルパーを削除しました。\n\n拡張機能も使わない場合は、brave://extensions から削除してください。")
			return
		}
	}
	if err := in.install(data); err != nil {
		showError(err.Error())
		return
	}
	if cur != "" && cur != "?" && cur != version {
		notify(fmt.Sprintf("shimau ヘルパーを v%s に更新しました。", version))
		return
	}
	notify("インストールしました。\n\nBrave の「はじめての設定」画面に戻ってください。自動で次へ進みます。")
}
