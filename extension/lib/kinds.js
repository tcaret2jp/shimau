// 保存先パスの種類を判別する（アイコン表示用）

export const KIND_LABEL = {
  drive: 'Googleドライブ',
  dropbox: 'Dropbox',
  ssd: '外付け',
  local: 'ローカル',
};

/** パス文字列から種類を推定する：drive / dropbox / ssd / local */
export function detectKind(path) {
  if (!path) return 'local';
  const p = path.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  if (/googledrive|google drive|マイドライブ|my drive|shared drives|共有ドライブ/i.test(p)) return 'drive';
  if (lower.includes('dropbox')) return 'dropbox';
  if (lower.startsWith('/volumes/')) return 'ssd';
  if (/^[a-z]:\//i.test(p) && !/^c:\//i.test(p)) return 'ssd';
  return 'local';
}

/** 実行中の OS（chrome.runtime.getPlatformInfo の os）からパスのキーを決める。 */
export function osKey(platformOs) {
  return platformOs === 'win' ? 'win' : 'mac'; // linux（Pi での動作確認）は mac と同じ扱い
}
