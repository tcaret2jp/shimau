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

export const saveRules = (rules) => chrome.storage.local.set({ rules });
export const saveDests = (dests) => chrome.storage.local.set({ dests });

// 同時に完了したダウンロードの記録が上書きし合わないよう、1件ずつ順番に書く
let historyQueue = Promise.resolve();
export function addHistory(entry) {
  const run = async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ id: newId(), time: Date.now(), ...entry });
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
  };
  historyQueue = historyQueue.then(run, run);
  return historyQueue;
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
