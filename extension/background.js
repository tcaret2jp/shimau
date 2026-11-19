// バックグラウンド：ダウンロードを監視し、ルールに一致したものだけ完了後にヘルパーで移動する
// あわせて、保存先の接続待ち（lib/waiting.js）とアップデート（lib/update.js）を受け持つ
import { findRule, pickSourceHost } from './lib/domain.js';
import { loadConfig, addHistory, currentOs } from './lib/store.js';
import { call, session, reasonText } from './lib/native.js';
import { planRetry, addWaiting, resolveWaiting, cancelWaiting, movedMessage, sameFile, WAIT_TEXT, RETRY_ALARM } from './lib/waiting.js';
import {
  UPDATE_ALARM,
  CHECK_MINUTES,
  getUpdate,
  patchUpdate,
  needsUpdate,
  extVersion,
  updateErrorText,
} from './lib/update.js';

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
  const { rules, dests } = await loadConfig();
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

async function getDecision(id) {
  let d = decisions.has(id) ? await decisions.get(id) : undefined;
  if (d === undefined) d = (await chrome.storage.session.get(pendingKey(id)))[pendingKey(id)];
  return d || null;
}

const running = new Set(); // 同じダウンロードを二重に処理しない（更新はこれが空になるまで待つ）

async function handleComplete(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const decision = await getDecision(id);
    if (decision) await processDownload(id, decision);
  } finally {
    // 判定は処理が終わってから消す（途中でサービスワーカーが止まっても記録が残るように）
    running.delete(id);
    await forget(id);
  }
}

async function processDownload(id, decision) {
  const [item] = await chrome.downloads.search({ id });
  if (!item?.filename) return;
  const src = item.filename;
  const name = basename(src);
  const { dests } = await loadConfig();
  const dest = dests.find((d) => d.id === decision.destId);
  if (!dest) return;
  const os = await currentOs();
  const destDir = dest.paths?.[os];
  const base = { filename: name, site: decision.site, destId: dest.id, destName: dest.name };

  // 接続待ちにしたとき、あとで「同じファイルか」を確かめるための情報
  const meta = { size: item.fileSize > 0 ? item.fileSize : undefined, endTime: item.endTime ? Date.parse(item.endTime) : Date.now() };
  if (!destDir) return fail(base, src, 'NO_PATH');

  let res;
  try {
    res = await session((send) => moveIn(send, src, destDir));
  } catch (e) {
    return fail(base, src, e.code, e.message, meta);
  }
  const finalName = basename(res.path);
  await addHistory({ ...base, status: 'ok', path: res.path, renamed: finalName !== name ? finalName : undefined });
  await notify({
    title: `${dest.name} に保存しました`,
    message: finalName !== name ? `${finalName}（同名ファイルがあったため名前を変更）` : finalName,
    action: { open: res.path },
    buttons: ['フォルダを開く'],
  });
}

// 1 回の接続の中で「移動 →（許可リストが古ければ）同期 → 再移動」まで済ませる
async function moveIn(send, src, destDir) {
  try {
    return await send('move', { src, destDir });
  } catch (e) {
    if (e.code !== 'DEST_NOT_ALLOWED') throw e;
    await send('syncDestinations', { paths: await destPaths() });
    return await send('move', { src, destDir });
  }
}

async function fail(base, src, code, detail, meta = {}) {
  const reason = reasonText(code, detail);
  // 保存先が見つからないだけなら、つながるのを待つ
  if (code === 'DEST_NOT_FOUND') {
    const historyId = await addHistory({ ...base, status: 'wait', reason: WAIT_TEXT.waiting, path: src });
    await addWaiting({ historyId, src, ...base, ...meta });
    await notify({
      title: `${base.destName} に保存できませんでした`,
      message: `${reason}\n${base.filename} はダウンロードフォルダに置いてあります。つながったら自動で移動します`,
      action: { open: src },
      buttons: ['ダウンロードフォルダを開く'],
    });
    return;
  }
  await addHistory({ ...base, status: 'fail', reason, path: src });
  await notify({
    title: `${base.destName} に保存できませんでした`,
    message: `${reason}\n${base.filename} はダウンロードフォルダに残しました`,
    action: { open: src },
    buttons: ['ダウンロードフォルダを開く'],
  });
}

/* ---------- 接続待ち ---------- */

// 待っているファイルがある間だけ、1 分ごとに確認する
async function syncRetryAlarm(list) {
  const waiting = list || (await chrome.storage.local.get('waiting')).waiting || [];
  const alarm = await chrome.alarms.get(RETRY_ALARM);
  if (waiting.length && !alarm) await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  if (!waiting.length && alarm) await chrome.alarms.clear(RETRY_ALARM);
}

let retrying = null;
function retryWaiting() {
  retrying ||= doRetry()
    .catch((e) => console.warn('retryWaiting failed', e))
    .finally(() => (retrying = null));
  return retrying;
}

async function doRetry() {
  const [{ waiting = [] }, { dests }, os] = await Promise.all([chrome.storage.local.get('waiting'), loadConfig(), currentOs()]);
  if (!waiting.length) return;
  const { expired, orphan, byDir } = planRetry(waiting, dests, os);
  for (const w of expired) await resolveWaiting(w, { status: 'fail', reason: WAIT_TEXT.expired });
  for (const w of orphan) await resolveWaiting(w, { status: 'fail', reason: WAIT_TEXT.destRemoved });
  if (!byDir.size) return;

  const moved = new Map(); // 保存先の名前 → [{ name, path }]
  try {
    await session(async (send) => {
      // ダウンロードフォルダから消えた・別のファイルに変わったものは待つのをやめる（古いヘルパーには checkFiles がない）
      const all = [...byDir.values()].flat();
      const files = await send('checkFiles', { paths: all.map((w) => w.src) }).then((r) => r.result, () => null);
      const dropped = new Set();
      if (files) {
        for (const w of all) {
          const st = sameFile(w, files[w.src]);
          if (st === 'same') continue;
          dropped.add(w.historyId);
          await resolveWaiting(w, { status: 'fail', reason: st === 'gone' ? WAIT_TEXT.gone : WAIT_TEXT.replaced });
        }
      }
      const dirs = await send('checkPaths', { paths: [...byDir.keys()] });
      for (const [dir, list] of byDir) {
        if (!dirs.result?.[dir]) continue; // まだつながっていない
        for (const w of list) {
          if (dropped.has(w.historyId)) continue;
          // 確認している間に「待つのをやめる」が押されていたら動かさない
          const { waiting: now = [] } = await chrome.storage.local.get('waiting');
          if (!now.some((x) => x.historyId === w.historyId)) continue;
          try {
            const res = await moveIn(send, w.src, dir);
            const finalName = basename(res.path);
            await resolveWaiting(w, {
              status: 'ok',
              path: res.path,
              reason: undefined,
              renamed: finalName !== w.filename ? finalName : undefined,
              movedLater: Date.now(),
            });
            const key = w.destName;
            if (!moved.has(key)) moved.set(key, []);
            moved.get(key).push({ name: finalName, path: res.path });
          } catch (e) {
            if (e.code === 'NOT_CONNECTED') throw e;
            if (e.code === 'DEST_NOT_FOUND') break; // また外れた：次の確認で
            if (e.code === 'SRC_NOT_FOUND') await resolveWaiting(w, { status: 'fail', reason: WAIT_TEXT.gone });
            else await resolveWaiting(w, { status: 'fail', reason: reasonText(e.code, e.message) + '（ダウンロードフォルダにあります）' });
          }
        }
      }
    });
  } catch (e) {
    if (e.code !== 'NOT_CONNECTED') throw e; // ヘルパーにつながらないときは、次の確認で
  } finally {
    for (const [destName, items] of moved) {
      await notify({
        title: `${destName} がつながったので移動しました`,
        message: movedMessage(items.map((i) => i.name)),
        action: { open: items[0].path },
        buttons: ['フォルダを開く'],
      });
    }
  }
}

/* ---------- アップデート ---------- */

async function checkUpdate({ manual = false } = {}) {
  let info;
  try {
    info = await session(async (send) => {
      const p = await send('ping');
      const u = await send('checkUpdate');
      // 更新できないヘルパー（配布されていない OS）は、版の比較に入れない
      return { helperVersion: u.helperUpdatable ? p.version : undefined, latest: u.latest };
    });
  } catch (e) {
    const message = updateErrorText(e.code, e.message);
    await patchUpdate({ lastCheck: Date.now(), error: { message, time: Date.now() } });
    if (manual) throw new Error(message);
    return getUpdate();
  }
  const u = await patchUpdate({ lastCheck: Date.now(), latest: info.latest, helperVersion: info.helperVersion, error: undefined });
  const v = info.latest?.version;
  if (!needsUpdate(v, extVersion(), info.helperVersion)) return u;
  if (u.auto) {
    applyUpdate({ auto: true }); // 終わるのは待たない（移動中なら待ってから更新する）
    return u;
  }
  if (!manual && u.dismissed !== v && u.notified !== v) {
    await patchUpdate({ notified: v });
    await notify({
      title: `shimau の新しい版があります（v${v}）`,
      message: 'ヘルパーと拡張機能をまとめて更新します',
      action: { update: v },
      buttons: ['更新する', 'あとで'],
    });
  }
  return u;
}

let applying = null;
function applyUpdate(opts = {}) {
  applying ||= doApply(opts).finally(() => (applying = null));
  return applying;
}

// ファイルの移動・接続待ちの確認・ダウンロード中の振り分けが終わるまで待つ（最大 10 分）。
// 読み込み直すと storage.session の判定が消えるので、振り分け待ちのダウンロードがある間も待つ。
async function busy() {
  if (running.size || retrying) return true;
  const s = await chrome.storage.session.get(null);
  return Object.keys(s).some((k) => k.startsWith('pending:'));
}
async function waitIdle() {
  const until = Date.now() + 10 * 60 * 1000;
  while ((await busy()) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function doApply({ auto = false } = {}) {
  await chrome.storage.session.set({ updating: true });
  try {
    await waitIdle();
    const r = await session((send) => send('applyUpdate', { extVersion: extVersion() }));
    const u = await getUpdate();
    const done = { version: r.version, time: Date.now(), url: u.latest?.url, ext: r.extension?.status, helper: r.helper?.status };
    if (r.extension?.status === 'updated') {
      // 読み込み直したあと（onInstalled）に「更新しました」を出す
      await patchUpdate({ done: { ...done, notice: true }, error: undefined, dismissed: undefined, helperVersion: helperAfter(r, u) });
      await waitIdle(); // 置き換えている間に始まったダウンロードの振り分けが終わってから
      chrome.runtime.reload();
      return { ok: true, reloading: true };
    }
    await patchUpdate({ done: { ...done, notice: false }, error: undefined, dismissed: undefined, helperVersion: helperAfter(r, u) });
    const note = EXT_NOTE[r.extension?.status];
    await notify({
      title: r.helper?.status === 'updated' ? `ヘルパーを v${r.version} に更新しました` : 'shimau は最新です',
      message: note || '',
      action: { url: done.url },
      buttons: [],
    });
    return { ok: true, extension: r.extension?.status, note };
  } catch (e) {
    const message = updateErrorText(e.code, e.message);
    await patchUpdate({ error: { message, time: Date.now() } });
    await notify({
      title: '更新できませんでした',
      message: auto ? `${message}。明日もう一度確認します` : message,
      action: { retry: true },
      buttons: ['もう一度'],
    });
    return { ok: false, message };
  } finally {
    await chrome.storage.session.set({ updating: false });
  }
}

// 更新後のヘルパーの版（更新できないヘルパーは比較に入れない）
function helperAfter(r, u) {
  if (r.helper?.status === 'unsupported') return undefined;
  return r.helperVersion || u.helperVersion;
}

const EXT_NOTE = {
  dev: '拡張機能は開発用のフォルダ（git）から読み込まれているため、更新していません',
  notFound: '拡張機能のフォルダが見つからないため、拡張機能は更新していません。GitHub から新しい版を入れてください',
  error: '拡張機能のファイルを置き換えられませんでした。GitHub から新しい版を入れてください',
};

// 読み込み直したあとに「更新しました」を出す
async function noticeUpdated() {
  const u = await getUpdate();
  if (!u.done?.notice) return;
  await patchUpdate({ done: { ...u.done, notice: false } });
  if (u.done.version !== extVersion()) return;
  await notify({
    title: `v${u.done.version} に更新しました`,
    message: 'クリックで変更点を開きます',
    action: { url: u.done.url },
    buttons: [],
  });
}

async function syncUpdateAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: CHECK_MINUTES });
  }
  // ブラウザを毎日閉じる人のために、起動時にも 1 日たっていれば確認する
  const u = await getUpdate();
  if (!u.lastCheck || Date.now() - u.lastCheck > CHECK_MINUTES * 60 * 1000) checkUpdate().catch(() => {});
}

// 画面（ポップアップ・設定）からの依頼
// 接続待ちの取り消しもここで行う（書き換えをバックグラウンドの 1 か所にまとめ、画面との書き込みの取り合いを避ける）
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string') return;
  const run = {
    'waiting:cancel': async () => {
      const { waiting = [] } = await chrome.storage.local.get('waiting');
      const w = waiting.find((x) => x.historyId === msg.historyId);
      if (!w) return { ok: true, found: false };
      await cancelWaiting(w);
      return { ok: true, found: true, filename: w.filename };
    },
    'update:check': () => checkUpdate({ manual: true }).then((u) => ({ ok: true, update: u })),
    'update:apply': () => applyUpdate(),
    'update:dismiss': async () => {
      const u = await getUpdate();
      await patchUpdate({ dismissed: u.latest?.version });
      return { ok: true };
    },
  }[msg.type];
  if (!run) return;
  run().then(reply, (e) => reply({ ok: false, message: e.message }));
  return true; // 非同期で返す
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === RETRY_ALARM) retryWaiting();
  if (a.name === UPDATE_ALARM) checkUpdate().catch(() => {});
});

/* ---------- 通知 ---------- */

// action: { open: パス } フォルダを開く ／ { update: 版 } 更新する・あとで ／ { retry } もう一度 ／ { url } ページを開く
async function notify({ title, message, action, buttons = [] }) {
  const nid = await chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    buttons: buttons.map((t) => ({ title: t })),
    priority: 0,
  });
  await chrome.storage.session.set({ [notifKey(nid)]: action || {} });
}

async function onNotification(nid, button) {
  let a = (await chrome.storage.session.get(notifKey(nid)))[notifKey(nid)] || {};
  if (typeof a === 'string') a = { open: a }; // v0.2 までの形
  chrome.notifications.clear(nid);
  if (a.open) {
    await call('openFolder', { path: a.open, reveal: true }).catch((e) => console.warn(e));
  } else if (a.update) {
    if (button === 1) await patchUpdate({ dismissed: a.update });
    else if (button === 0) await applyUpdate();
    else chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#helper') });
  } else if (a.retry) {
    if (button === 0) await applyUpdate();
    else chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#helper') });
  } else if (a.url) {
    chrome.tabs.create({ url: a.url });
  }
}
chrome.notifications.onButtonClicked.addListener((nid, i) => onNotification(nid, i));
chrome.notifications.onClicked.addListener((nid) => onNotification(nid, -1));
chrome.notifications.onClosed.addListener((nid) => chrome.storage.session.remove(notifKey(nid)));

/* ---------- 保存先の同期・起動時 ---------- */

// 保存先の許可リストをヘルパーに同期する（ヘルパーは登録済みの保存先にしか移動しない）
async function destPaths() {
  const [{ dests }, os] = await Promise.all([loadConfig(), currentOs()]);
  return dests.map((d) => d.paths?.[os]).filter(Boolean);
}
async function syncDestinations() {
  await call('syncDestinations', { paths: await destPaths() });
}
const syncQuietly = () => syncDestinations().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.dests) syncQuietly();
  if (changes.waiting) syncRetryAlarm(changes.waiting.newValue || []);
});

function onBoot() {
  syncRetryAlarm().then(() => retryWaiting());
  syncUpdateAlarm();
}
chrome.runtime.onStartup.addListener(() => {
  syncQuietly();
  onBoot();
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  syncQuietly();
  onBoot();
  if (reason === chrome.runtime.OnInstalledReason.UPDATE) noticeUpdated();
  // 初めて入れたときだけ、はじめての設定を開く（更新時は開かない）
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
});

function basename(p) {
  return p.split(/[\\/]/).pop();
}
