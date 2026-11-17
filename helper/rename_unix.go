//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// renameNoReplace は上書きせずに名前を変える（同じドライブ内の移動）。
// 宛先が存在すれば errExists、別ドライブなら errCrossDevice。
func renameNoReplace(src, dst string) error {
	err := renameExcl(src, dst)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, unix.EEXIST):
		return errExists
	case errors.Is(err, unix.EXDEV):
		return errCrossDevice
	case errors.Is(err, unix.EINVAL), errors.Is(err, unix.ENOTSUP), errors.Is(err, unix.ENOSYS):
		// ファイルシステムが「上書きしない名前変更」に非対応 → ハードリンク（宛先があれば必ず失敗する）＋元を削除
		if lerr := os.Link(src, dst); lerr != nil {
			if errors.Is(lerr, unix.EEXIST) {
				return errExists
			}
			// ハードリンクも使えない（exFAT など）→ コピー（O_EXCL で上書きしない）に切り替える
			return errCrossDevice
		}
		if rerr := os.Remove(src); rerr != nil {
			os.Remove(dst)
			return rerr
		}
		return nil
	default:
		return err
	}
}

func defaultDownloadDirs() []string {
	h, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(h, "Downloads")}
}
