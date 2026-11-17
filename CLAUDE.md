# shimau（プロジェクト固有ルール）

共通ルールは `~/.claude/CLAUDE.md`。ここにはこのプロジェクト固有のことだけ書く。

## 最初に読む
- `README.md`（現状と次にやること）
- `docs/requirements.md`（承認済みの要件定義。仕様変更はとーやに確認してから反映）

## 構成
- `extension/` Brave 拡張（Manifest V3、素の JS + CSS）
- `helper/` ネイティブヘルパー（Go。Pi 上で darwin/arm64・darwin/amd64・windows/amd64 にクロスビルド）
- `docs/` 要件定義・設計メモ

## 注意
- 動作確認は Mac / Windows 実機が必要。Pi ではロジックの単体テストまで
- UI は実装前にモックでとーやの OK をもらう
- 作業が進んだら README の「現状」「次にやること」を更新する
