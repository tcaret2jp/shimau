package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func hidden(cmd *exec.Cmd) *exec.Cmd { return cmd }

func newInstaller() (*installer, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	as := filepath.Join(home, "Library", "Application Support")
	return &installer{
		dir:     filepath.Join(as, "shimau"),
		exeName: "shimau-helper",
		manifestDirs: []string{
			filepath.Join(as, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
			filepath.Join(as, "Google", "Chrome", "NativeMessagingHosts"),
		},
	}, nil
}

// afterCopy は念のため「隔離」属性を外す（Brave から起動するときに止められないように）
func afterCopy(p string) {
	_ = exec.Command("xattr", "-d", "com.apple.quarantine", p).Run()
}

func appleStr(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// appIcon はアプリ（.app）の中のアイコン。なければ空文字
func appIcon() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	icon := filepath.Join(filepath.Dir(p), "..", "Resources", "AppIcon.icns")
	if _, err := os.Stat(icon); err != nil {
		return ""
	}
	return icon
}

// dialog は Mac 標準のダイアログを出し、押されたボタンを返す。キャンセルなら空文字
func dialog(msg string, buttons []string, cancel string, icon string) string {
	bs := make([]string, len(buttons))
	for i, b := range buttons {
		bs[i] = appleStr(b)
	}
	if icon == "" {
		if p := appIcon(); p != "" {
			icon = "POSIX file " + appleStr(p)
		} else {
			icon = "note"
		}
	}
	s := "activate\nset r to display dialog " + appleStr(msg) +
		" with title " + appleStr("shimau ヘルパー") +
		" buttons {" + strings.Join(bs, ", ") + "} default button " + bs[len(bs)-1]
	if cancel != "" {
		s += " cancel button " + appleStr(cancel)
	}
	s += " with icon " + icon + "\nreturn button returned of r"
	out, err := exec.Command("osascript", "-e", s).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "-128") {
			return ""
		}
		return ""
	}
	return strings.TrimSpace(string(out))
}

func notify(msg string)    { dialog(msg, []string{"OK"}, "", "") }
func showError(msg string) { dialog(msg, []string{"OK"}, "", "caution") }

func askReinstall(msg string) choice {
	switch dialog(msg+"\n\n入れ直すか、削除するかを選んでください。", []string{"キャンセル", "削除する", "入れ直す"}, "キャンセル", "") {
	case "入れ直す":
		return choiceReinstall
	case "削除する":
		return choiceRemove
	}
	return choiceCancel
}
