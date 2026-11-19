package main

// アップデート（2026-11-19 追加）
//
// GitHub の最新 Release にある latest.json（版・変更点・配布ファイルの SHA-256）とその署名（latest.json.sig）を読み、
// 署名を確かめてから、ヘルパー本体と拡張機能のファイルを置き換える。
// - 署名は Ed25519。秘密鍵は Pi の ~/.config/shimau/release-ed25519.key（リポジトリには入れない）、公開鍵はこのファイルに埋め込む。
// - 拡張機能は「パッケージ化されていない拡張機能」なので、Brave のプロフィール（Preferences）から読み込み元のフォルダを探して上書きする。
//   git のフォルダ（開発用）は上書きしない。
// - ネット通信はこのファイルの処理（GitHub）だけ。

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const releaseRepo = "https://github.com/tcaret2jp/shimau/releases"

// releasePubKey は配布ファイルの署名を確かめる公開鍵（base64）。tools/signrelease で作った鍵の公開側
var releasePubKey = "8hrW2QoA+MTpyy3JGbAJOTXj4NqicSDWe6yaBVEcFTc="

var (
	httpClient = &http.Client{Timeout: 10 * time.Minute}
	// テストで差し替える
	releaseBase    = defaultReleaseBase
	browserRoots   = defaultBrowserRoots
	helperExePath  = installedHelperPath
	updateLockPath = func() string { return filepath.Join(os.TempDir(), "shimau-update.lock") }
	maxReleaseFile = int64(200 << 20) // 配布ファイル 1 つの上限
)

var (
	reVersion = regexp.MustCompile(`^\d{1,4}\.\d{1,4}\.\d{1,4}$`)
	reName    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
)

type releaseFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// defaultReleaseBase は Release の取得元。SHIMAU_UPDATE_BASE は開発中の通しテスト用（署名は必ず確かめるので、差し替えても署名のないものは入らない）
func defaultReleaseBase() string {
	if b := os.Getenv("SHIMAU_UPDATE_BASE"); b != "" {
		return strings.TrimRight(b, "/")
	}
	return releaseRepo
}

// releaseInfo は latest.json の中身
type releaseInfo struct {
	Version     string                 `json:"version"`
	Tag         string                 `json:"tag"`
	PublishedAt string                 `json:"publishedAt"`
	Notes       []string               `json:"notes"`
	URL         string                 `json:"url"`
	Files       map[string]releaseFile `json:"files"` // "extension" / "darwin" / "windows-amd64"
}

func (r *releaseInfo) summary() map[string]any {
	return map[string]any{"version": r.Version, "notes": r.Notes, "url": r.URL, "publishedAt": r.PublishedAt}
}

// cmpVersion は "0.10.1" と "0.9.0" のような版を比べる（a > b なら正）
func cmpVersion(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

func httpGet(url string, limit int64) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "shimau-helper/"+version)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, errc("NETWORK", "%v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errc("NETWORK", "%s: HTTP %d", url, res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, errc("NETWORK", "%v", err)
	}
	if int64(len(b)) > limit {
		return nil, errc("BAD_FILE", "ファイルが大きすぎます: %s", url)
	}
	return b, nil
}

// verifySignature は latest.json の署名（base64）を公開鍵で確かめる
func verifySignature(body, sig []byte) error {
	pub, err := base64.StdEncoding.DecodeString(releasePubKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return errc("BAD_SIGNATURE", "公開鍵が正しくありません")
	}
	s, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || !ed25519.Verify(pub, body, s) {
		return errc("BAD_SIGNATURE", "latest.json の署名が正しくありません")
	}
	return nil
}

// fetchRelease は最新版の情報を取ってきて、署名と中身を確かめる
func fetchRelease() (*releaseInfo, error) {
	base := releaseBase()
	body, err := httpGet(base+"/latest/download/latest.json", 1<<20)
	if err != nil {
		return nil, err
	}
	sig, err := httpGet(base+"/latest/download/latest.json.sig", 4<<10)
	if err != nil {
		return nil, err
	}
	if err := verifySignature(body, sig); err != nil {
		return nil, err
	}
	var r releaseInfo
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, errc("BAD_FILE", "latest.json を読めません: %v", err)
	}
	if !reVersion.MatchString(r.Version) || r.Tag != "v"+r.Version {
		return nil, errc("BAD_FILE", "latest.json の版が正しくありません: %q %q", r.Version, r.Tag)
	}
	for k, f := range r.Files {
		if !reName.MatchString(f.Name) || len(f.SHA256) != 64 || f.Size <= 0 || f.Size > maxReleaseFile {
			return nil, errc("BAD_FILE", "latest.json のファイル情報が正しくありません: %s", k)
		}
	}
	return &r, nil
}

// download は配布ファイルを取ってきて、大きさと SHA-256 を確かめる
func download(r *releaseInfo, key string) ([]byte, error) {
	f, ok := r.Files[key]
	if !ok {
		return nil, errc("BAD_FILE", "この版には %s がありません", key)
	}
	b, err := httpGet(releaseBase()+"/download/"+r.Tag+"/"+f.Name, f.Size)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	if int64(len(b)) != f.Size || !strings.EqualFold(hex.EncodeToString(sum[:]), f.SHA256) {
		return nil, errc("BAD_FILE", "%s の中身が latest.json と一致しません", f.Name)
	}
	return b, nil
}

// helperKey は今の PC 用のヘルパーの配布ファイルの名前（latest.json の files のキー）。対象外なら空文字
func helperKey() string {
	switch {
	case runtime.GOOS == "darwin":
		return "darwin" // ユニバーサル（Apple Silicon / Intel）
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		return "windows-amd64"
	}
	return ""
}

func (a *app) checkUpdate() (map[string]any, error) {
	r, err := fetchRelease()
	if err != nil {
		return nil, err
	}
	_, ok := r.Files[helperKey()]
	// helperUpdatable: この PC 用のヘルパーが配布されているか（ないときは、ヘルパーの版の古さを「新しい版あり」に数えない）
	return map[string]any{"latest": r.summary(), "helperUpdatable": helperKey() != "" && ok}, nil
}

// applyUpdate は拡張機能（extVersion より新しければ）とヘルパー（自分より新しければ）を最新版にする。
// ダウンロードと確認を全部済ませてから置き換える（途中で通信が切れても、半端に入れ替わらないように）。
func (a *app) applyUpdate(extVersion string) (map[string]any, error) {
	// Brave のプロフィールが複数あると、同時に更新が始まることがある。1 つずつにする
	unlock, err := lockUpdate()
	if err != nil {
		return nil, err
	}
	defer unlock()
	r, err := fetchRelease()
	if err != nil {
		return nil, err
	}
	extStatus, helperStatus := "current", "current"
	var extZip, helperBin []byte
	if extVersion == "" || cmpVersion(r.Version, extVersion) > 0 {
		if extZip, err = download(r, "extension"); err != nil {
			return nil, err
		}
	}
	key := helperKey()
	if cmpVersion(r.Version, version) > 0 {
		if _, ok := r.Files[key]; key == "" || !ok {
			helperStatus = "unsupported"
		} else if helperBin, err = download(r, key); err != nil {
			return nil, err
		}
	}

	var paths []string
	if extZip != nil {
		extStatus, paths, err = updateExtension(extZip)
		if err != nil {
			log.Printf("applyUpdate: extension: %v", err)
			extStatus = "error"
		}
	}
	newHelper := version
	if helperBin != nil {
		if err := replaceHelper(helperBin, r.Version); err != nil {
			return nil, err
		}
		helperStatus, newHelper = "updated", r.Version
	}
	return map[string]any{
		"version":       r.Version,
		"helperVersion": newHelper,
		"extension":     map[string]any{"status": extStatus, "paths": paths},
		"helper":        map[string]any{"status": helperStatus},
		"latest":        r.summary(),
	}, nil
}

// lockUpdate は更新中の印（ロックファイル）を作る。15 分以上前のものは、止まった更新の残りとして消す
func lockUpdate() (func(), error) {
	p := updateLockPath()
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return func() { os.Remove(p) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if fi, serr := os.Stat(p); serr == nil && time.Since(fi.ModTime()) > 15*time.Minute {
			os.Remove(p)
			continue
		}
		break
	}
	return nil, errc("BUSY", "ほかの更新が進行中です")
}

/* ---------- 拡張機能 ---------- */

// readExtensionZip は拡張機能の zip を読み、パス（/ 区切り）→ 中身 を返す。おかしな名前があれば拒否する
func readExtensionZip(b []byte) (map[string][]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, errc("BAD_FILE", "拡張機能の zip を読めません: %v", err)
	}
	if len(zr.File) > 1000 {
		return nil, errc("BAD_FILE", "拡張機能の zip のファイルが多すぎます")
	}
	files := map[string][]byte{}
	var total int64
	for _, f := range zr.File {
		name := f.Name
		if strings.HasSuffix(name, "/") {
			continue // フォルダ
		}
		if strings.Contains(name, `\`) || path.IsAbs(name) || path.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") {
			return nil, errc("BAD_FILE", "拡張機能の zip に不正な名前があります: %q", name)
		}
		if !f.Mode().IsRegular() {
			return nil, errc("BAD_FILE", "拡張機能の zip に通常のファイル以外があります: %q", name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, errc("BAD_FILE", "%v", err)
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxReleaseFile+1))
		rc.Close()
		if err != nil {
			return nil, errc("BAD_FILE", "%v", err)
		}
		total += int64(len(data))
		if total > maxReleaseFile {
			return nil, errc("BAD_FILE", "拡張機能の zip が大きすぎます")
		}
		files[name] = data
	}
	if _, ok := files["manifest.json"]; !ok {
		return nil, errc("BAD_FILE", "拡張機能の zip に manifest.json がありません")
	}
	return files, nil
}

// manifestKey は manifest.json の key（拡張機能 ID を決める公開鍵）
func manifestKey(b []byte) string {
	k, _ := manifestInfo(b)
	return k
}

// manifestInfo は manifest.json の key と version
func manifestInfo(b []byte) (key, ver string) {
	var m struct {
		Key     string `json:"key"`
		Version string `json:"version"`
	}
	if json.Unmarshal(b, &m) != nil {
		return "", ""
	}
	return m.Key, m.Version
}

// isDevDir は git で管理しているフォルダ（開発用）かどうか
func isDevDir(dir string) bool {
	for _, d := range []string{dir, filepath.Dir(dir)} {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return true
		}
	}
	return false
}

// updateExtension は読み込まれている拡張機能のフォルダを、zip の中身で上書きする。
// 状態：updated（1 つ以上上書きした）／dev（開発用のフォルダだけ）／notFound（見つからない）
// 古い版にしかないファイルは消さない（ユーザーのフォルダの中身を消す危険を避けるため。残っていても動作に影響しない）
func updateExtension(zipBytes []byte) (string, []string, error) {
	files, err := readExtensionZip(zipBytes)
	if err != nil {
		return "", nil, err
	}
	key, newVer := manifestInfo(files["manifest.json"])
	if key == "" || !reVersion.MatchString(newVer) {
		return "", nil, errc("BAD_FILE", "新しい manifest.json に key か version がありません")
	}
	dirs := findExtensionDirs(extID)
	status := "notFound"
	var updated []string
	var firstErr error
	for _, dir := range dirs {
		cur, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		curKey, curVer := manifestInfo(cur)
		if err != nil || curKey != key {
			continue // shimau ではない
		}
		if cmpVersion(newVer, curVer) <= 0 {
			// ほかのプロフィールで読み込んでいるフォルダがもっと新しいときは、古い版で上書きしない
			if status == "notFound" {
				status = "current"
			}
			continue
		}
		if isDevDir(dir) {
			if status == "notFound" {
				status = "dev"
			}
			continue
		}
		if err := writeExtension(dir, files); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", dir, err)
			}
			continue
		}
		status = "updated"
		updated = append(updated, dir)
	}
	if status != "updated" && firstErr != nil {
		return "error", nil, firstErr
	}
	return status, updated, nil
}

// writeExtension は拡張機能のフォルダを新しい版の中身にする。
//  1. 全ファイルを別名（.shimau-new-*）で書く。失敗したら書いたものを消して終わり（元のまま）
//  2. 元のファイルを .shimau-old-* に退避して、新しいファイルを正式な名前にする（manifest.json は最後）
//     途中で失敗したら、それまでの入れ替えを全部元に戻す
//  3. 退避したファイルを消す
func writeExtension(dir string, files map[string][]byte) (err error) {
	type item struct{ dst, tmp, old string }
	var items []*item
	names := make([]string, 0, len(files))
	for name := range files {
		if name != "manifest.json" {
			names = append(names, name)
		}
	}
	names = append(names, "manifest.json")
	defer func() {
		if err == nil {
			return
		}
		for _, it := range items {
			if it.tmp != "" {
				os.Remove(it.tmp)
			}
		}
	}()
	for _, name := range names {
		dst := filepath.Join(dir, filepath.FromSlash(name))
		if rel, rerr := filepath.Rel(dir, dst); rerr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("フォルダの外です: %s", name)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		tmp, err := writeTemp(filepath.Dir(dst), ".shimau-new-*", files[name], 0o644)
		if err != nil {
			return err
		}
		items = append(items, &item{dst: dst, tmp: tmp})
	}
	var done []*item
	rollback := func() {
		for i := len(done) - 1; i >= 0; i-- {
			it := done[i]
			if it.old != "" {
				if rerr := os.Rename(it.old, it.dst); rerr != nil {
					log.Printf("writeExtension: 元に戻せませんでした: %s: %v", it.dst, rerr)
				}
			} else {
				os.Remove(it.dst)
			}
		}
	}
	for _, it := range items {
		if _, serr := os.Lstat(it.dst); serr == nil {
			old := filepath.Join(filepath.Dir(it.dst), fmt.Sprintf(".shimau-old-%d-%s", time.Now().UnixNano(), filepath.Base(it.dst)))
			if err := os.Rename(it.dst, old); err != nil {
				rollback()
				return err
			}
			it.old = old
		}
		if err := os.Rename(it.tmp, it.dst); err != nil {
			if it.old != "" {
				os.Rename(it.old, it.dst)
			}
			rollback()
			return err
		}
		it.tmp = ""
		done = append(done, it)
	}
	for _, it := range done {
		if it.old != "" {
			os.Remove(it.old)
		}
	}
	return nil
}

// defaultBrowserRoots は Brave（と Chrome）のユーザーデータのフォルダ
func defaultBrowserRoots() []string {
	home, _ := os.UserHomeDir()
	var roots []string
	add := func(base string, names ...string) {
		for _, n := range names {
			roots = append(roots, filepath.Join(base, n))
		}
	}
	brave := []string{"Brave-Browser", "Brave-Browser-Beta", "Brave-Browser-Nightly"}
	switch runtime.GOOS {
	case "darwin":
		as := filepath.Join(home, "Library", "Application Support")
		add(filepath.Join(as, "BraveSoftware"), brave...)
		add(as, filepath.Join("Google", "Chrome"))
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		for _, b := range brave {
			roots = append(roots, filepath.Join(local, "BraveSoftware", b, "User Data"))
		}
		roots = append(roots, filepath.Join(local, "Google", "Chrome", "User Data"))
	default:
		cfg := filepath.Join(home, ".config")
		add(filepath.Join(cfg, "BraveSoftware"), brave...)
		add(cfg, "chromium", "google-chrome")
	}
	return roots
}

// findExtensionDirs は Brave のプロフィールの設定から、拡張機能 id の読み込み元フォルダ（パッケージ化されていないもの）を探す
func findExtensionDirs(id string) []string {
	seen := map[string]bool{}
	var dirs []string
	for _, root := range browserRoots() {
		profiles, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, p := range profiles {
			if !p.IsDir() {
				continue
			}
			for _, name := range []string{"Secure Preferences", "Preferences"} {
				b, err := os.ReadFile(filepath.Join(root, p.Name(), name))
				if err != nil {
					continue
				}
				var prefs struct {
					Extensions struct {
						Settings map[string]struct {
							Path string `json:"path"`
						} `json:"settings"`
					} `json:"extensions"`
				}
				if json.Unmarshal(b, &prefs) != nil {
					continue
				}
				d := prefs.Extensions.Settings[id].Path
				if d == "" || !filepath.IsAbs(d) {
					continue // ストアから入れたもの（相対パス）や、登録なし
				}
				d = filepath.Clean(d)
				if seen[d] {
					continue
				}
				if fi, err := os.Stat(filepath.Join(d, "manifest.json")); err != nil || !fi.Mode().IsRegular() {
					continue
				}
				seen[d] = true
				dirs = append(dirs, d)
			}
		}
	}
	return dirs
}

/* ---------- ヘルパー本体 ---------- */

func installedHelperPath() (string, error) {
	in, err := newInstaller()
	if err != nil {
		return "", err
	}
	return in.exe(), nil
}

// replaceHelper はインストール済みのヘルパーを新しい版に置き換える。
// 動いている自分自身も置き換える（Mac/Linux は上書きの名前変更、Windows は動いている exe を .old に名前変更してから）。
// 新しい版が起動しなければ元に戻す。
func replaceHelper(bin []byte, want string) error {
	exe, err := helperExePath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(exe); err != nil {
		return errc("ERROR", "インストール済みのヘルパーが見つかりません: %s", exe)
	}
	tmp, err := writeTemp(filepath.Dir(exe), ".shimau-helper-*.new", bin, 0o755)
	if err != nil {
		return errc("ERROR", "新しいヘルパーを書き込めませんでした: %v", err)
	}
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(tmp)
		return errc("ERROR", "ヘルパーを置き換えられませんでした: %v", err)
	}
	if err := os.Rename(tmp, exe); err != nil {
		if rerr := os.Rename(old, exe); rerr != nil {
			log.Printf("replaceHelper: 元に戻せませんでした: %v", rerr)
		}
		os.Remove(tmp)
		return errc("ERROR", "ヘルパーを置き換えられませんでした: %v", err)
	}
	afterCopy(exe)
	if got := exeVersion(exe); got != want {
		// 起動できない・版が違う：元に戻す
		os.Remove(exe)
		if rerr := os.Rename(old, exe); rerr != nil {
			log.Printf("replaceHelper: 元に戻せませんでした: %v", rerr)
		}
		return errc("BAD_FILE", "新しいヘルパーが起動しませんでした（%q）", got)
	}
	os.Remove(old) // Windows では動いている間は消せない。次に起動したときに消す（cleanupOldHelper）
	return nil
}

// cleanupOldHelper は前回の更新で残った .old を消す
func cleanupOldHelper() {
	if p, err := os.Executable(); err == nil {
		if err := os.Remove(p + ".old"); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("cleanup: %v", err)
		}
	}
}
