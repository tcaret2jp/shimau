package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// app はヘルパーの設定（保存先の許可リストと、移動元として認めるダウンロードフォルダ）
type app struct {
	cfgPath      string
	downloadDirs []string
}

type config struct {
	// 拡張機能から同期される「登録済み保存先」。ここにあるフォルダにしか移動しない
	Destinations []string `json:"destinations"`
	// Brave のダウンロード先を ~/Downloads 以外にしている場合に、手で追加するフォルダ
	ExtraDownloadDirs []string `json:"extraDownloadDirs"`
}

func newApp() (*app, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return &app{cfgPath: filepath.Join(dir, "shimau", "config.json"), downloadDirs: defaultDownloadDirs()}, nil
}

func (a *app) loadConfig() (config, error) {
	var c config
	b, err := os.ReadFile(a.cfgPath)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("設定ファイルが壊れています (%s): %w", a.cfgPath, err)
	}
	return c, nil
}

func (a *app) saveConfig(c config) error {
	if err := os.MkdirAll(filepath.Dir(a.cfgPath), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// 複数のヘルパーが同時に書いても壊れないよう、一時ファイル名は毎回変える
	f, err := os.CreateTemp(filepath.Dir(a.cfgPath), "config-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, a.cfgPath); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func (a *app) syncDestinations(paths []string) error {
	c, err := a.loadConfig()
	if err != nil {
		return err
	}
	c.Destinations = c.Destinations[:0]
	for _, p := range paths {
		if p = strings.TrimSpace(p); p != "" {
			c.Destinations = append(c.Destinations, p)
		}
	}
	return a.saveConfig(c)
}

// move はダウンロードしたファイル src を保存先フォルダ destDir に移動し、最終的なパスを返す。
// 同名ファイルがあれば「名前 (1).拡張子」のように連番にし、上書きはしない。
func (a *app) move(src, destDir string) (string, error) {
	c, err := a.loadConfig()
	if err != nil {
		return "", err
	}
	src = expandHome(src)
	if !filepath.IsAbs(src) {
		return "", errc("SRC_NOT_ALLOWED", "絶対パスではありません: %s", src)
	}
	fi, err := os.Lstat(src)
	if err != nil {
		return "", errc("SRC_NOT_FOUND", "%v", err)
	}
	if !fi.Mode().IsRegular() {
		return "", errc("SRC_NOT_ALLOWED", "通常のファイルではありません: %s", src)
	}
	realSrc, ok := a.inDownloads(src, c)
	if !ok {
		return "", errc("SRC_NOT_ALLOWED", "ダウンロードフォルダの外のファイルです: %s", src)
	}
	// 以降は解決済みのパスで操作する（確認後にフォルダを差し替えられても外のファイルを動かさない）
	src = realSrc

	dest := expandHome(destDir)
	if !filepath.IsAbs(dest) {
		return "", errc("DEST_NOT_ALLOWED", "絶対パスではありません: %s", destDir)
	}
	if !containsExact(c.Destinations, dest) {
		return "", errc("DEST_NOT_ALLOWED", "登録されていない保存先です: %s", dest)
	}
	if di, err := os.Stat(dest); err != nil || !di.IsDir() {
		return "", errc("DEST_NOT_FOUND", "保存先が見つかりません: %s", dest)
	}
	if sameDir(filepath.Dir(src), dest) {
		return src, nil // すでに保存先にある
	}

	base := filepath.Base(src)
	for i := 0; i < 1000; i++ {
		dst := filepath.Join(dest, numbered(base, i))
		err := renameNoReplace(src, dst)
		switch {
		case err == nil:
			return dst, nil
		case errors.Is(err, errExists):
			continue
		case errors.Is(err, errCrossDevice):
			err = copyThenRemove(src, dst, fi)
			if errors.Is(err, errExists) {
				continue
			}
			if err != nil {
				return "", err
			}
			return dst, nil
		default:
			return "", errc("COPY_FAILED", "%v", err)
		}
	}
	return "", errc("COPY_FAILED", "空いているファイル名が見つかりません")
}

var (
	errExists      = errors.New("同名のファイルがあります")
	errCrossDevice = errors.New("別のドライブです")
)

// numbered("a.pdf", 2) → "a (2).pdf"
func numbered(base string, i int) string {
	if i == 0 {
		return base
	}
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" { // ".bashrc" のような名前
		stem, ext = base, ""
	}
	return fmt.Sprintf("%s (%d)%s", stem, i, ext)
}

// copyThenRemove は別ドライブへの移動：コピー → サイズを検証 → 元を削除
func copyThenRemove(src, dst string, srcInfo fs.FileInfo) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return errc("SRC_NOT_FOUND", "%v", err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, fs.ErrExist) {
		return errExists
	}
	if err != nil {
		return errc("COPY_FAILED", "%v", err)
	}
	defer func() {
		if err != nil {
			out.Close()
			os.Remove(dst) // 途中までのファイルは残さない
		}
	}()
	if _, err = io.Copy(out, in); err != nil {
		return errc("COPY_FAILED", "%v", err)
	}
	if err = out.Sync(); err != nil {
		return errc("COPY_FAILED", "%v", err)
	}
	if err = out.Close(); err != nil {
		return errc("COPY_FAILED", "%v", err)
	}
	di, err := os.Stat(dst)
	if err != nil {
		return errc("COPY_FAILED", "%v", err)
	}
	if di.Size() != srcInfo.Size() {
		err = errc("COPY_FAILED", "コピー後のサイズが一致しません (%d != %d)", di.Size(), srcInfo.Size())
		return err
	}
	_ = os.Chtimes(dst, srcInfo.ModTime(), srcInfo.ModTime())
	in.Close()
	if rmErr := os.Remove(src); rmErr != nil {
		// コピーは成功しているので失敗扱いにはしない（元ファイルが残るだけ）
		fmt.Fprintf(os.Stderr, "shimau-helper: 元ファイルを削除できませんでした: %v\n", rmErr)
	}
	return nil
}

// inDownloads は src（シンボリックリンクを解決したパス）がダウンロードフォルダの中にあるかを調べ、
// 中にあれば解決済みのパスを返す。フォルダの同一性は名前ではなく実体（os.SameFile）で比べるので、
// 大文字小文字を区別するボリュームでも別フォルダと取り違えない。
func (a *app) inDownloads(src string, c config) (string, bool) {
	realSrc, err := filepath.EvalSymlinks(src)
	if err != nil {
		return "", false
	}
	var roots []os.FileInfo
	for _, d := range append(append([]string{}, a.downloadDirs...), c.ExtraDownloadDirs...) {
		if d = expandHome(d); d == "" {
			continue
		}
		if fi, err := os.Stat(d); err == nil && fi.IsDir() {
			roots = append(roots, fi)
		}
	}
	for p := filepath.Dir(realSrc); ; {
		if fi, err := os.Stat(p); err == nil {
			for _, r := range roots {
				if os.SameFile(fi, r) {
					return realSrc, true
				}
			}
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", false
		}
		p = parent
	}
}

// sameDir は 2 つのパスが同じフォルダの実体を指すか
func sameDir(a, b string) bool {
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(fa, fb)
}

// containsExact は登録済みの保存先と完全に同じ文字列か（大文字小文字も区別する。拡張は登録時と同じ文字列を送る）
func containsExact(list []string, p string) bool {
	for _, x := range list {
		if expandHome(x) == p {
			return true
		}
	}
	return false
}

// expandHome は先頭の ~ をホームフォルダに置き換える
func expandHome(p string) string {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[1:])
		}
	}
	if p == "" {
		return ""
	}
	return filepath.Clean(p)
}

func checkPaths(paths []string) map[string]bool {
	res := make(map[string]bool, len(paths))
	for _, p := range paths {
		fi, err := os.Stat(expandHome(p))
		res[p] = err == nil && fi.IsDir()
	}
	return res
}

type volume struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func openFolder(p string, reveal bool) error {
	p = expandHome(p)
	if p == "" {
		return errc("BAD_REQUEST", "パスが空です")
	}
	fi, err := os.Stat(p)
	if err != nil {
		// ファイルがもう無い場合は、そのフォルダを開く
		dir := filepath.Dir(p)
		if di, derr := os.Stat(dir); derr == nil && di.IsDir() {
			return openPath(dir, false)
		}
		return errc("DEST_NOT_FOUND", "見つかりません: %s", p)
	}
	if fi.IsDir() {
		return openPath(p, false)
	}
	if reveal {
		return openPath(p, true)
	}
	return openPath(filepath.Dir(p), false)
}
