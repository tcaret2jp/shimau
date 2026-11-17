// バックグラウンド：ダウンロードを監視し、ルールに一致したものだけ完了後にヘルパーで移動する
import { findRule, pickSourceHost } from './lib/domain.js';
import { load, addHistory, currentOs } from './lib/store.js';
import { call, reasonText } from './lib/native.js';

// ダウンロード開始時の判定結果。小さいファイルは判定より先に完了することがあるので Promise で持つ。
// サービスワーカーが眠っても続きができるよう、storage.session にも保存する。
const decisions = new Map();
const pendingKey = (id) => `pending:${id}`;
const notifKey = (id) => `notif:${id}`;

chrome.downloads.onCreated.addListener((item) => {
  if (item.byExtensionId === chrome.runtime.id) return; // 自分のバックアップ書き出しなどは対象外
  const p = decide(item).catch((e) => {
    console.error('decide failed', e);
    return null;
  });
  decisions.set(item.id, p);
});

async function decide(item) {
  const { rules, dests } = await load();
  if (!rules.some((r) => r.enabled)) return null;
  let tabUrl = null;
  if (!item.referrer) {
    // referrer が取れないときは、今開いているタブで判定する
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    tabUrl = tab?.url || null;
  }
  const host = pickSourceHost({ referrer: item.referrer, tabUrl, finalUrl: item.finalUrl, url: item.url });
  const rule = findRule(rules, host);
  if (!rule) return null; // 一致しないダウンロードには一切介入しない
  const dest = dests.find((d) => d.id === rule.destId);
  if (!dest) return null;
  const decision = { ruleId: rule.id, destId: dest.id, site: host };
  await chrome.storage.session.set({ [pendingKey(item.id)]: decision });
  return decision;
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  // 中断（interrupted）では判定を消さない：再開して完了したときにも振り分けるため。
  // storage.session はブラウザを閉じると消えるので、残り続けることはない。
  if (state === 'complete') handleComplete(delta.id).catch((e) => console.error('handleComplete failed', e));
});
chrome.downloads.onErased.addListener((id) => forget(id));

async function forget(id) {
  decisions.delete(id);
  await chrome.storage.session.remove(pendingKey(id));
}

async function takeDecision(id) {
  let d = decisions.has(id) ? await decisions.get(id) : undefined;
  if (d === undefined) d = (await chrome.storage.session.get(pendingKey(id)))[pendingKey(id)];
  await forget(id);
  return d || null;
}

async function handleComplete(id) {
  const decision = await takeDecision(id);
  if (!decision) return;
  const [item] = await chrome.downloads.search({ id });
  if (!item?.filename) return;
  const src = item.filename;
  const name = basename(src);
  const { dests } = await load();
  const dest = dests.find((d) => d.id === decision.destId);
  if (!dest) return;
  const os = await currentOs();
  const destDir = dest.paths?.[os];
  const base = { filename: name, site: decision.site, destId: dest.id, destName: dest.name };

  if (!destDir) return fail(base, src, 'NO_PATH');

  let res;
  try {
    res = await moveWithSync(src, destDir);
  } catch (e) {
    return fail(base, src, e.code, e.message);
  }
  const finalName = basename(res.path);
  await addHistory({ ...base, status: 'ok', path: res.path, renamed: finalName !== name ? finalName : undefined });
  await notify({
    title: `${dest.name} に保存しました`,
    message: finalName !== name ? `${finalName}（同名ファイルがあったため名前を変更）` : finalName,
    path: res.path,
    button: 'フォルダを開く',
  });
}

async function moveWithSync(src, destDir) {
  try {
    return await call('move', { src, destDir });
  } catch (e) {
    if (e.code !== 'DEST_NOT_ALLOWED') throw e;
    await syncDestinations(); // 保存先の許可リストが古い → 送り直して1回だけ再試行
    return await call('move', { src, destDir });
  }
}

async function fail(base, src, code, detail) {
  const reason = reasonText(code, detail);
  await addHistory({ ...base, status: 'fail', reason, path: src });
  await notify({
    title: `${base.destName} に保存できませんでした`,
    message: `${reason}\n${base.filename} はダウンロードフォルダに残しました`,
    path: src,
    button: 'ダウンロードフォルダを開く',
  });
}

async function notify({ title, message, path, button }) {
  const nid = await chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    buttons: [{ title: button }],
    priority: 0,
  });
  await chrome.storage.session.set({ [notifKey(nid)]: path });
}

async function openFromNotification(nid) {
  const path = (await chrome.storage.session.get(notifKey(nid)))[notifKey(nid)];
  if (path) await call('openFolder', { path, reveal: true }).catch((e) => console.warn(e));
  chrome.notifications.clear(nid);
}
chrome.notifications.onButtonClicked.addListener((nid) => openFromNotification(nid));
chrome.notifications.onClicked.addListener((nid) => openFromNotification(nid));
chrome.notifications.onClosed.addListener((nid) => chrome.storage.session.remove(notifKey(nid)));

// 保存先の許可リストをヘルパーに同期する（ヘルパーは登録済みの保存先にしか移動しない）
async function syncDestinations() {
  const { dests } = await load();
  const os = await currentOs();
  const paths = dests.map((d) => d.paths?.[os]).filter(Boolean);
  await call('syncDestinations', { paths });
}
const syncQuietly = () => syncDestinations().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.dests) syncQuietly();
});
chrome.runtime.onStartup.addListener(syncQuietly);
chrome.runtime.onInstalled.addListener(({ reason }) => {
  syncQuietly();
  // 初めて入れたときだけ、はじめての設定を開く（更新時は開かない）
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
});

function basename(p) {
  return p.split(/[\\/]/).pop();
}
