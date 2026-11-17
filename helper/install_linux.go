package main

// Linux は開発・テスト用（Pi での通しテスト）。ダイアログの代わりに文字を出す

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func hidden(cmd *exec.Cmd) *exec.Cmd { return cmd }

func newInstaller() (*installer, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return &installer{
		dir:     filepath.Join(cfg, "shimau"),
		exeName: "shimau-helper",
		manifestDirs: []string{
			filepath.Join(cfg, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
			filepath.Join(cfg, "chromium", "NativeMessagingHosts"),
		},
	}, nil
}

func afterCopy(string) {}

func notify(msg string)    { fmt.Println(msg) }
func showError(msg string) { fmt.Fprintln(os.Stderr, msg) }

func askReinstall(msg string) choice {
	fmt.Println(msg + "（入れ直します）")
	return choiceReinstall
}
