# shimau（しまう）

Brave（Mac / Windows）で、登録したドメインのダウンロードだけを指定フォルダ（Googleドライブ・Dropbox・外付けSSD 含む）へ自動で振り分ける拡張機能＋ヘルパーアプリ。

> **名前の由来**：ダウンロードしたファイルを、あるべき場所に「ちゃんとしまっておくね」→ しまう → **shimau**。姉妹リポジトリ pomoru（ポモる）と同じく、やさしい日本語の動詞から付けた（2026-11-17 決定）。

## 現状（2026-11-17）
- 要件定義：完了・承認済み → [docs/requirements.md](docs/requirements.md)
- デザインモック：OK 済み → [docs/mockup.html](docs/mockup.html)
- 実装：拡張機能・ヘルパー・インストールスクリプトまで完了（v0.1.0）。Codex レビューの指摘 6 件を修正済み
  - Pi で確認済み：単体テスト（拡張・ヘルパー）、Chromium＋ヘルパーでの通しテスト（振り分け・同名ファイルの連番・ルール OFF のときは介入しない）
  - **未確認**：Mac / Windows 実機での動作（下の「実機での確認項目」）
- GitHub：https://github.com/tcaret2jp/shimau （Public）

## 次にやること
1. Mac / Windows 実機でインストールして動作確認（とーや）
2. 実機で見つかった問題の修正
3. 配布用 zip を GitHub Releases に置く

## 構成
```
extension/        Brave 拡張（Manifest V3、素の JS + CSS）
  background.js   ダウンロード監視 → ルール判定 → 完了後にヘルパーへ移動を依頼
  lib/            ドメイン判定・バックアップ・ストレージ・ヘルパー通信
  popup/ options/ ポップアップ・設定画面
helper/           ネイティブヘルパー（Go）
  build.sh        Mac(arm64/amd64)・Windows(amd64) 向けにビルドし dist/ に zip を作る
  install/        install.sh / install.ps1 とアンインストール用スクリプト
tests/            拡張の単体テスト（node --test）
docs/             要件定義・デザインモック
```

## インストール
### 1. 拡張機能（Mac / Windows 共通）
1. Brave で `brave://extensions` を開き、右上の「デベロッパーモード」を ON
2. 「パッケージ化されていない拡張機能を読み込む」→ このリポジトリの `extension` フォルダを選ぶ
3. 拡張機能 ID が `clnofopcnjnjgknoflaipaohdofeolng` になっていることを確認（manifest の key で固定）

### 2. ヘルパー
`helper/build.sh` で作った zip（`helper/dist/`）を展開して実行する。
- Mac：`shimau-helper-mac.zip` を展開 → ターミナルで `./install.sh`
- Windows：`shimau-helper-windows.zip` を展開 → PowerShell で `powershell -ExecutionPolicy Bypass -File install.ps1`

Brave を再起動し、設定画面の「ヘルパー」が「接続中」になれば完了。どちらも管理者権限は不要。

### 実機での確認項目
1. 未登録サイトでダウンロード → Brave 標準のフォルダに保存される
2. 登録サイトでダウンロード → ローカル／Googleドライブ／Dropbox／SSD に移動され、通知が出る
3. SSD を外した状態でダウンロード → ダウンロードフォルダに残り、通知が出る
4. 同名ファイル → 「名前 (1).拡張子」で保存される
5. Mac でバックアップを書き出し → Windows で読み込み → ルールが反映される
6. 保存先の追加画面で「選ぶ」→ フォルダ選択ダイアログが出る

### 補足・既知の制限
- Brave のダウンロード先を `~/Downloads` 以外にしている場合は、ヘルパーの設定ファイル（Mac：`~/Library/Application Support/shimau/config.json`、Windows：`%APPDATA%\shimau\config.json`）の `extraDownloadDirs` にそのフォルダを追加する。安全のため、ヘルパーはダウンロードフォルダ内のファイルしか動かさない。
- ダウンロード元のページが分からない（referrer がない）ときは、その時点で開いているタブで判定する。裏のタブから始まったダウンロードは、手前のタブのルールで振り分けられることがある。
- Brave の「保存する前に保存先を確認する」が ON だと、振り分け対象でもダイアログが出る。

## 開発
```bash
npm test                                   # 拡張の単体テスト
cd helper && go test ./... && ./build.sh   # ヘルパーのテストとビルド
```
Go は Pi の `~/.local/go`（sudo なしで導入）を使う。

## 経緯
- アイデア出しと要件定義は `00_cc` のセッションで実施
- 判断記録：`00_cc/02_Knowledge/02_Decison/2026-11-17_Braveダウンロード振り分けはヘルパー方式.md`
