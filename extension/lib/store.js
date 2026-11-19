// chrome.storage.local の読み書き
//
// 保存する形:
//   rules:   [{ id, domain, destId, includeSubdomains, enabled }]
//   dests:   [{ id, name, paths: { mac, win } }]
//   history: [{ id, time, filename, site, destId, destName, status: 'ok'|'fail'|'wait', reason, path, movedLater }]  新しい順・最大200件
//   waiting: [{ historyId, src, filename, site, destId, destName, since }]  保存先の接続待ち（lib/waiting.js）
//   update:  { auto, lastCheck, latest: { version, notes, url, publishedAt }, dismissed, done }  アップデート（lib/update.js）
//   lastExport: ISO 文字列

export const HISTORY_LIMIT = 200;

export async function load() {
  const d = await chrome.storage.local.get(['rules', 'dests', 'history', 'waiting', 'lastExport']);
  return {
    rules: d.rules || [],
    dests: d.dests || [],
    history: d.history || [],
    waiting: d.waiting || [],
    lastExport: d.lastExport || null,
  };
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
export const updateWaiting = (fn) => updateList('waiting', fn);

// 同時に完了したダウンロードの記録が上書きし合わないよう、1件ずつ順番に書く
let historyQueue = Promise.resolve();
function queueHistory(run) {
  const p = historyQueue.then(run, run);
  historyQueue = p.catch(() => {});
  return p;
}

/** 履歴に 1 件足し、その id を返す */
export function addHistory(entry) {
  return queueHistory(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    const id = newId();
    history.unshift({ id, time: Date.now(), ...entry });
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
    return id;
  });
}

/** 履歴の 1 件を書き換える。undefined の項目は消す。見つからなければ false */
export function updateHistory(id, patch) {
  return queueHistory(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    const h = history.find((x) => x.id === id);
    if (!h) return false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete h[k];
      else h[k] = v;
    }
    await chrome.storage.local.set({ history });
    return true;
  });
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
