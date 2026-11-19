// アップデート（2026-11-19 追加）
//
// 拡張機能は「パッケージ化されていない拡張機能」なので Brave は自動で更新しない。
// ヘルパーが GitHub の最新 Release を確認し、署名を確かめてから、ヘルパー本体と拡張機能のファイルを置き換える。
// 拡張機能はそのあと chrome.runtime.reload() で読み込み直す（background.js）。
//
// storage.local.update:
//   auto        自動で更新する（既定 false＝確認してから更新）
//   lastCheck   最後に確認した時刻
//   latest      { version, notes[], url, publishedAt }  GitHub の最新版
//   helperVersion  確認したときのヘルパーの版
//   dismissed   通知で「あとで」を押した版（次の版が出るまで通知しない）
//   done        { version, time, url, notice }  更新した記録（notice: 読み込み直したあとに通知する）
//   error       { message, time }  最後の失敗
// storage.session.updating: 更新中なら true（画面の「更新しています…」）

export const UPDATE_ALARM = 'checkUpdate';
export const CHECK_MINUTES = 24 * 60;

/** "0.10.1" と "0.9.0" のような版を比べる（a > b なら正） */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 拡張機能かヘルパーのどちらかが最新版より古ければ true */
export function needsUpdate(latest, extVersion, helperVersion) {
  if (!latest) return false;
  return cmpVersion(latest, extVersion) > 0 || (!!helperVersion && cmpVersion(latest, helperVersion) > 0);
}

export const extVersion = () => chrome.runtime.getManifest().version;

export async function getUpdate() {
  return (await chrome.storage.local.get('update')).update || {};
}

let queue = Promise.resolve();
/** update を読み直してから書き換える。undefined の項目は消す */
export function patchUpdate(patch) {
  const run = async () => {
    const u = await getUpdate();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete u[k];
      else u[k] = v;
    }
    await chrome.storage.local.set({ update: u });
    return u;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** 今、新しい版が出ているか（画面用） */
export function availableVersion(u) {
  const v = u.latest?.version;
  return needsUpdate(v, extVersion(), u.helperVersion) ? v : null;
}

/** 画面からバックグラウンドへ頼む（check / apply / dismiss） */
export async function requestUpdate(type) {
  const r = await chrome.runtime.sendMessage({ type: 'update:' + type });
  if (r && !r.ok) throw new Error(r.message || '更新できませんでした');
  return r;
}

/** ヘルパーのエラー → 画面に出す日本語 */
export function updateErrorText(code, fallback) {
  return (
    {
      NOT_CONNECTED: 'ヘルパーに接続できません',
      BAD_REQUEST: 'ヘルパーが古いため、自動で更新できません。新しいヘルパーを手動で入れてください',
      NETWORK: 'ネットにつながっていないか、GitHub に接続できません',
      BAD_SIGNATURE: 'ダウンロードしたファイルの署名が正しくないため、更新をやめました',
      BAD_FILE: 'ダウンロードしたファイルが壊れているため、更新をやめました',
    }[code] ||
    fallback ||
    '更新できませんでした'
  );
}
