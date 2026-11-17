// ネイティブヘルパーとの通信（Native Messaging）
// sendNativeMessage はメッセージごとにヘルパーを起動して終了させるので、常駐しない。

export const HOST_NAME = 'com.shimau.helper';

export class HelperError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** ヘルパーにコマンドを送る。失敗時は HelperError（code: NOT_CONNECTED / ヘルパー側のコード）。 */
export async function call(cmd, args = {}) {
  let res;
  try {
    res = await chrome.runtime.sendNativeMessage(HOST_NAME, { cmd, ...args });
  } catch (e) {
    throw new HelperError('NOT_CONNECTED', e?.message || 'ヘルパーに接続できません');
  }
  if (!res) throw new HelperError('NOT_CONNECTED', 'ヘルパーから応答がありません');
  if (!res.ok) throw new HelperError(res.code || 'ERROR', res.message || '不明なエラー');
  return res;
}

/** 接続確認。{ connected, version, os, arch } */
export async function ping() {
  try {
    const r = await call('ping');
    return { connected: true, version: r.version, os: r.os, arch: r.arch };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

/** ヘルパーのエラーコード → 画面に出す日本語 */
export function reasonText(code, fallback) {
  return (
    {
      NOT_CONNECTED: 'ヘルパーに接続できません',
      DEST_NOT_FOUND: '保存先が見つかりません（未接続・同期停止の可能性）',
      DEST_NOT_ALLOWED: '保存先がヘルパーに登録されていません',
      SRC_NOT_ALLOWED: 'ダウンロードフォルダ以外のファイルは移動できません',
      SRC_NOT_FOUND: 'ダウンロードしたファイルが見つかりません',
      NO_PATH: 'この PC 用の保存先パスが未設定です',
      COPY_FAILED: 'コピーに失敗しました',
    }[code] || fallback || '移動に失敗しました'
  );
}
