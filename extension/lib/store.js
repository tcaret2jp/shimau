// chrome.storage.local の読み書き
//
// 保存する形:
//   rules:   [{ id, domain, destId, includeSubdomains, enabled }]
//   dests:   [{ id, name, paths: { mac, win } }]
//   history: [{ id, time, filename, site, destId, destName, status: 'ok'|'fail', reason, path }]  新しい順・最大200件
//   lastExport: ISO 文字列

export const HISTORY_LIMIT = 200;

export async function load() {
  const d = await chrome.storage.local.get(['rules', 'dests', 'history', 'lastExport']);
  return { rules: d.rules || [], dests: d.dests || [], history: d.history || [], lastExport: d.lastExport || null };
}

/** ルールと保存先だけ読む（ダウンロードのたびに 200 件の履歴まで読まないため） */
export async function loadConfig() {
  const d = await chrome.storage.local.get(['rules', 'dests']);
  return { rules: d.rules || [], dests: d.dests || [] };
}

export const saveRules = (rules) => chrome.storage.local.set({ rules });

/**
 * 最新の内容を読み直してから書き換える（ほかの画面での変更を古い内容で上書きしないため）。
 * fn は配列を直接書き換える。false を返すと保存しない。戻り値は書き換え後の配列。
 */
let listQueue = Promise.resolve();
function updateList(key, fn) {
  const run = async () => {
    const { [key]: list = [] } = await chrome.storage.local.get(key);
    if (fn(list) !== false) await chrome.storage.local.set({ [key]: list });
    return list;
  };
  const p = listQueue.then(run, run);
  listQueue = p.catch(() => {});
  return p;
}
export const updateRules = (fn) => updateList('rules', fn);
export const updateDests = (fn) => updateList('dests', fn);

// 同時に完了したダウンロードの記録が上書きし合わないよう、1件ずつ順番に書く
let historyQueue = Promise.resolve();
export function addHistory(entry) {
  const run = async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ id: newId(), time: Date.now(), ...entry });
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
  };
  const p = historyQueue.then(run, run);
  historyQueue = p.catch(() => {});
  return p;
}

export const clearHistory = () => chrome.storage.local.set({ history: [] });

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

let osPromise;
/** 'mac' | 'win'（linux は 'mac' 扱い） */
export function currentOs() {
  osPromise ||= chrome.runtime.getPlatformInfo().then((p) => (p.os === 'win' ? 'win' : 'mac'));
  return osPromise;
}
