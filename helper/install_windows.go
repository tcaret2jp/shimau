package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Brave がどちらのキーを読むか版によって違うため、両方に登録する
var regKeys = []string{
	`Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + hostName,
	`Software\Google\Chrome\NativeMessagingHosts\` + hostName,
}

func newInstaller() (*installer, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		d, err := os.UserCacheDir() // Windows では %LOCALAPPDATA%
		if err != nil {
			return nil, err
		}
		local = d
	}
	dir := filepath.Join(local, "shimau")
	return &installer{
		dir:          dir,
		exeName:      "shimau-helper.exe",
		manifestDirs: []string{dir},
		register: func(manifest string) error {
			for _, k := range regKeys {
				key, _, err := registry.CreateKey(registry.CURRENT_USER, k, registry.SET_VALUE)
				if err != nil {
					return err
				}
				err = key.SetStringValue("", manifest)
				key.Close()
				if err != nil {
					return err
				}
			}
			return nil
		},
		unregister: func() error {
			for _, k := range regKeys {
				if err := registry.DeleteKey(registry.CURRENT_USER, k); err != nil && !errors.Is(err, registry.ErrNotExist) {
					return err
				}
			}
			return nil
		},
	}, nil
}

func afterCopy(string) {} // 書き込んだファイルには「インターネットから来た」印が付かない

const (
	mbOK            = 0x0
	mbYesNoCancel   = 0x3
	mbIconError     = 0x10
	mbIconQuestion  = 0x20
	mbIconInfo      = 0x40
	mbSetForeground = 0x10000
	mbTopmost       = 0x40000
	idYes           = 6
	idNo            = 7
)

func msgBox(msg string, flags uint32) int32 {
	t, _ := windows.UTF16PtrFromString(msg)
	c, _ := windows.UTF16PtrFromString("shimau ヘルパー")
	r, _ := windows.MessageBox(0, t, c, flags|mbSetForeground|mbTopmost)
	return r
}

func notify(msg string)    { msgBox(msg, mbOK|mbIconInfo) }
func showError(msg string) { msgBox(msg, mbOK|mbIconError) }

func askReinstall(msg string) choice {
	switch msgBox(msg+"\n\n入れ直す　→「はい」\n削除する　→「いいえ」", mbYesNoCancel|mbIconQuestion) {
	case idYes:
		return choiceReinstall
	case idNo:
		return choiceRemove
	}
	return choiceCancel
}
