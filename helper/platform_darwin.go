package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const pickScript = `on run argv
	set msg to "shimau：保存先のフォルダを選んでください"
	if (count of argv) > 0 then
		set p to choose folder with prompt msg default location (POSIX file (item 1 of argv))
	else
		set p to choose folder with prompt msg
	end if
	return POSIX path of p
end run`

// pickFolder は Finder のフォルダ選択ダイアログを出す。キャンセルなら空文字。
func pickFolder(start string) (string, error) {
	args := []string{"-e", pickScript}
	if fi, err := os.Stat(start); err == nil && fi.IsDir() {
		args = append(args, start)
	}
	out, err := exec.Command("osascript", args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "-128") {
			return "", nil // ユーザーがキャンセル
		}
		return "", err
	}
	p := strings.TrimSpace(string(out))
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	return p, nil
}

func openPath(p string, reveal bool) error {
	if reveal {
		return exec.Command("open", "-R", p).Run()
	}
	return exec.Command("open", p).Run()
}

// listVolumes は外付けドライブ（/Volumes）とクラウドストレージ（~/Library/CloudStorage）を返す
func listVolumes() []volume {
	var vols []volume
	if ents, err := os.ReadDir("/Volumes"); err == nil {
		for _, e := range ents {
			p := filepath.Join("/Volumes", e.Name())
			if r, err := filepath.EvalSymlinks(p); err == nil && r == "/" {
				continue // 起動ディスク（Macintosh HD）は除く
			}
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				vols = append(vols, volume{Name: e.Name(), Path: p})
			}
		}
	}
	home, _ := os.UserHomeDir()
	cs := filepath.Join(home, "Library", "CloudStorage")
	if ents, err := os.ReadDir(cs); err == nil {
		for _, e := range ents {
			p := filepath.Join(cs, e.Name())
			name := e.Name()
			switch {
			case strings.HasPrefix(name, "GoogleDrive"):
				// Googleドライブは「マイドライブ」の中を候補にする
				for _, sub := range []string{"マイドライブ", "My Drive"} {
					if fi, err := os.Stat(filepath.Join(p, sub)); err == nil && fi.IsDir() {
						vols = append(vols, volume{Name: "Googleドライブ（" + sub + "）", Path: filepath.Join(p, sub)})
					}
				}
				continue
			case strings.HasPrefix(name, "Dropbox"):
				name = "Dropbox"
			case strings.HasPrefix(name, "OneDrive"):
				name = "OneDrive"
			}
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				vols = append(vols, volume{Name: name, Path: p})
			}
		}
	}
	return vols
}
