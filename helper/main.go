// shimau-helper: Brave 拡張「shimau」用のネイティブヘルパー。
//
// Native Messaging（標準入出力・4バイト長＋JSON）でコマンドを受け取り、
// ダウンロードフォルダ内のファイルを登録済みの保存先へ移動する。
// Brave が必要なときだけ起動し、常駐もネット通信もしない。
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"runtime"
)

const version = "0.1.1"

// 受け取るメッセージの上限（Chrome → ホストは最大 64MiB だが、ここでは十分小さくてよい）
const maxMessage = 1 << 20

type request struct {
	Cmd      string   `json:"cmd"`
	Src      string   `json:"src"`
	DestDir  string   `json:"destDir"`
	Paths    []string `json:"paths"`
	Path     string   `json:"path"`
	Reveal   bool     `json:"reveal"`
	StartDir string   `json:"startDir"`
}

// codeError はエラーコード付きのエラー（拡張側で日本語に変換する）
type codeError struct {
	Code string
	Msg  string
}

func (e *codeError) Error() string { return e.Code + ": " + e.Msg }

func errc(code, format string, a ...any) error {
	return &codeError{Code: code, Msg: fmt.Sprintf(format, a...)}
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("shimau-helper: ")
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Printf("shimau-helper %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	}
	a, err := newApp()
	if err != nil {
		log.Fatal(err)
	}
	if err := serve(a, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}

// serve は入力が閉じられるまでメッセージを処理する
func serve(a *app, r io.Reader, w io.Writer) error {
	for {
		msg, err := readMessage(r)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var req request
		var res map[string]any
		if err := json.Unmarshal(msg, &req); err != nil {
			res = errorResponse(errc("BAD_REQUEST", "JSON を読めません: %v", err))
		} else {
			res = a.handle(req)
		}
		if err := writeMessage(w, res); err != nil {
			return err
		}
	}
}

func (a *app) handle(req request) map[string]any {
	var (
		out map[string]any
		err error
	)
	switch req.Cmd {
	case "ping":
		out = map[string]any{"version": version, "os": runtime.GOOS, "arch": runtime.GOARCH}
	case "syncDestinations":
		err = a.syncDestinations(req.Paths)
		out = map[string]any{}
	case "move":
		var p string
		p, err = a.move(req.Src, req.DestDir)
		out = map[string]any{"path": p}
	case "checkPaths":
		out = map[string]any{"result": checkPaths(req.Paths)}
	case "listVolumes":
		out = map[string]any{"volumes": listVolumes()}
	case "pickFolder":
		var p string
		p, err = pickFolder(expandHome(req.StartDir))
		out = map[string]any{"path": p} // キャンセル時は空文字
	case "openFolder":
		err = openFolder(req.Path, req.Reveal)
		out = map[string]any{}
	default:
		err = errc("BAD_REQUEST", "不明なコマンド: %q", req.Cmd)
	}
	if err != nil {
		log.Printf("%s: %v", req.Cmd, err)
		return errorResponse(err)
	}
	out["ok"] = true
	return out
}

func errorResponse(err error) map[string]any {
	var ce *codeError
	if errors.As(err, &ce) {
		return map[string]any{"ok": false, "code": ce.Code, "message": ce.Msg}
	}
	return map[string]any{"ok": false, "code": "ERROR", "message": err.Error()}
}

// Native Messaging の形式：4バイト長（ネイティブのバイト順＝対象 OS はすべてリトルエンディアン）＋ UTF-8 JSON
func readMessage(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, io.EOF
		}
		return nil, err
	}
	if n > maxMessage {
		return nil, fmt.Errorf("メッセージが大きすぎます (%d bytes)", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeMessage(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}
