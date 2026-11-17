package main

// Linux は Pi での動作確認用（本番の対象は Mac / Windows）

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

func pickFolder(start string) (string, error) {
	args := []string{"--file-selection", "--directory", "--title=shimau：保存先のフォルダを選んでください"}
	if start != "" {
		args = append(args, "--filename="+start+"/")
	}
	out, err := exec.Command("zenity", args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func openPath(p string, reveal bool) error {
	if reveal {
		p = filepath.Dir(p)
	}
	return exec.Command("xdg-open", p).Start()
}

func listVolumes() []volume {
	var vols []volume
	roots := []string{"/mnt"}
	if u, err := user.Current(); err == nil {
		roots = append([]string{filepath.Join("/media", u.Username)}, roots...)
	}
	for _, root := range roots {
		ents, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if e.IsDir() {
				vols = append(vols, volume{Name: e.Name(), Path: filepath.Join(root, e.Name())})
			}
		}
	}
	return vols
}
