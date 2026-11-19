// 保存先の接続待ち（2026-11-19 追加）
//
// 保存先が見つからず（SSD を外している・ドライブが止まっているなど）ダウンロードフォルダに残したファイルを覚えておき、
// 保存先がつながったら自動で移動する。確認は待っているファイルがある間だけ、1 分ごと（background.js）。
// 待つのをやめる：「待つのをやめる」を押した／30 日たった／ダウンロードフォルダから消えた・別のファイルに変わった／保存先が削除された。
// 書き換えはバックグラウンドだけで行う（画面からは chrome.runtime.sendMessage({ type: 'waiting:cancel' })）。

import { updateWaiting, addHistory, updateHistory } from './store.js';

export const WAIT_DAYS = 30;
export const WAIT_MS = WAIT_DAYS * 24 * 60 * 60 * 1000;
export const RETRY_ALARM = 'retryWaiting';

export const WAIT_TEXT = {
  waiting: 'つながったら自動で移動します',
  canceled: '待つのをやめました（ダウンロードフォルダにあります）',
  expired: `${WAIT_DAYS} 日たっても接続されなかったので、待つのをやめました（ダウンロードフォルダにあります）`,
  gone: 'ダウンロードフォルダにファイルが見つからないため、待つのをやめました',
  replaced: 'ダウンロードフォルダのファイルが別のファイルに変わっていたため、待つのをやめました',
  destRemoved: '保存先が削除されたため、待つのをやめました（ダウンロードフォルダにあります）',
};

/**
 * 待っているファイルを、今回どうするかに分ける（純粋関数）。
 * - expired: 30 日たった
 * - orphan:  保存先が削除された／この PC 用のパスがなくなった
 * - byDir:   保存先のフォルダ → 待っているファイル（古い順）。ここだけヘルパーで確認する
 */
export function planRetry(waiting, dests, os, now = Date.now()) {
  const expired = [];
  const orphan = [];
  const byDir = new Map();
  for (const w of [...waiting].sort((a, b) => a.since - b.since)) {
    if (now - w.since >= WAIT_MS) {
      expired.push(w);
      continue;
    }
    const dir = dests.find((d) => d.id === w.destId)?.paths?.[os];
    if (!dir) {
      orphan.push(w);
      continue;
    }
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(w);
  }
  return { expired, orphan, byDir };
}

/**
 * 待っているファイルが、ダウンロードしたときのままか（純粋関数）。
 * info はヘルパーの checkFiles の結果（{ size, mtime } か null）。
 * 同じ名前で別のファイルがダウンロードされた場合に、取り違えて動かさないため。
 * @returns 'same' | 'gone' | 'replaced'
 */
export function sameFile(w, info) {
  if (!info) return 'gone';
  if (w.size != null && info.size !== w.size) return 'replaced';
  // ダウンロードが終わったあとに書き換えられている（2 分の余裕を見る）
  if (w.endTime && info.mtime > w.endTime + 2 * 60 * 1000) return 'replaced';
  return 'same';
}

/** 接続待ちに加える */
export async function addWaiting(w) {
  await updateWaiting((list) => {
    if (list.some((x) => x.historyId === w.historyId)) return false;
    list.push({ ...w, since: w.since || Date.now() });
  });
}

/**
 * 待つのをやめる／移動できたときに、接続待ちから外して履歴を書き換える。
 * 履歴を消去していて元の記録がないときは、新しく足す。
 */
export async function resolveWaiting(w, patch) {
  await updateWaiting((list) => {
    const i = list.findIndex((x) => x.historyId === w.historyId);
    if (i < 0) return false;
    list.splice(i, 1);
  });
  const found = await updateHistory(w.historyId, patch);
  if (!found) {
    const { historyId, since, src, ...rest } = w;
    await addHistory({ ...rest, path: src, ...patch });
  }
}

/** 画面の「待つのをやめる」 */
export function cancelWaiting(w) {
  return resolveWaiting(w, { status: 'fail', reason: WAIT_TEXT.canceled });
}

/** 移動できた通知の本文（1 件ならファイル名、複数なら「ほか N 件」） */
export function movedMessage(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names[0]} ほか ${names.length - 1} 件`;
}
