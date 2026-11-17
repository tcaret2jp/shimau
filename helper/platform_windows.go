package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// renameNoReplace は上書きせずに移動する（MoveFileEx をフラグなしで呼ぶと上書きせず、別ドライブなら失敗する）
func renameNoReplace(src, dst string) error {
	from, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	err = windows.MoveFileEx(from, to, 0)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, windows.ERROR_ALREADY_EXISTS), errors.Is(err, windows.ERROR_FILE_EXISTS):
		return errExists
	case errors.Is(err, windows.ERROR_NOT_SAME_DEVICE):
		return errCrossDevice
	default:
		return err
	}
}

func defaultDownloadDirs() []string {
	var dirs []string
	// 「ダウンロード」フォルダの場所を変更している場合（OneDrive など）にも対応
	if p, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0); err == nil && p != "" {
		dirs = append(dirs, p)
	}
	if h, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(h, "Downloads"))
	}
	return dirs
}

const pickPS = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'shimau：保存先のフォルダを選んでください'
$d.ShowNewFolderButton = $true
if ($env:SHIMAU_START -and (Test-Path -LiteralPath $env:SHIMAU_START)) { $d.SelectedPath = $env:SHIMAU_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$owner.Dispose()
`

// pickFolder はエクスプローラーのフォルダ選択ダイアログを出す。キャンセルなら空文字。
func pickFolder(start string) (string, error) {
	cmd := hidden(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", pickPS))
	cmd.Env = append(os.Environ(), "SHIMAU_START="+start)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.TrimPrefix(string(out), "\ufeff")), nil
}

func openPath(p string, reveal bool) error {
	cmd := exec.Command("explorer.exe")
	if reveal {
		// explorer は引数の書き方にうるさいので、コマンドラインをそのまま渡す
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: fmt.Sprintf(`explorer.exe /select,"%s"`, p)}
	} else {
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: fmt.Sprintf(`explorer.exe "%s"`, p)}
	}
	return cmd.Start() // explorer は成功しても終了コード 1 を返すので待たない
}

// listVolumes はドライブ（C: 以外）と Dropbox フォルダを返す
func listVolumes() []volume {
	var vols []volume
	mask, err := windows.GetLogicalDrives()
	if err == nil {
		for i := 0; i < 26; i++ {
			if mask&(1<<uint(i)) == 0 {
				continue
			}
			letter := string(rune('A' + i))
			root := letter + `:\`
			if letter == "C" {
				continue
			}
			label := volumeLabel(root)
			name := letter + ":"
			if label != "" {
				name = label + "（" + letter + ":）"
			}
			// Googleドライブ（パソコン版）は「マイドライブ」の中を候補にする
			added := false
			for _, sub := range []string{"マイドライブ", "My Drive"} {
				p := filepath.Join(root, sub)
				if fi, err := os.Stat(p); err == nil && fi.IsDir() {
					vols = append(vols, volume{Name: "Googleドライブ（" + sub + "）", Path: p})
					added = true
				}
			}
			if !added {
				if _, err := os.Stat(root); err == nil {
					vols = append(vols, volume{Name: name, Path: root})
				}
			}
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(h, "Dropbox")
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			vols = append(vols, volume{Name: "Dropbox", Path: p})
		}
	}
	return vols
}

func volumeLabel(root string) string {
	r, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return ""
	}
	buf := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumeInformation(r, &buf[0], uint32(len(buf)), nil, nil, nil, nil, 0); err != nil {
		return ""
	}
	return windows.UTF16ToString(buf)
}
