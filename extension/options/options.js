import { normalizeDomain } from '../lib/domain.js';
import { load, updateRules, updateDests, clearHistory, newId, currentOs } from '../lib/store.js';
import { call, session } from '../lib/native.js';
import { buildExport, parseImport, previewMerge, mergeImport } from '../lib/backup.js';
import { detectKind, KIND_LABEL } from '../lib/kinds.js';
import { svg, esc, chip, fav, paintIcons, fmtTime, destKind, isOn, setToggle } from '../ui/parts.js';

const $ = (id) => document.getElementById(id);
const OS_NAME = { mac: 'Mac', win: 'Windows' };
let S, os, other, helper = { connected: false }, access = null, hfilter = 'all';
let modalGen = 0; // 開いているダイアログの世代（閉じた後に届いた結果を捨てるため）
let accessSeq = 0; // 保存先の確認の世代（古い結果で上書きしないため）

/* ---------- 起動 ---------- */
async function init() {
  paintIcons();
  os = await currentOs();
  other = os === 'mac' ? 'win' : 'mac';
  $('os-name').textContent = OS_NAME[os];
  $('extid').textContent = chrome.runtime.id;
  await reload();
  // はじめての設定の「ルールを作る」から来たら、追加画面を開く
  const newRule = location.hash === '#new-rule';
  if (newRule) history.replaceState(null, '', '#rules');
  route();
  checkHelper();
  if (newRule) ruleModal();
}

async function reload() {
  S = await load();
  renderAll();
}

/* 描画：表示中の画面だけ描き、ほかは切り替えたときに描く */
const RENDER = { rules: () => renderRules(), dests: () => renderDests(), history: () => renderHistory(), backup: () => renderBackup() };
const dirty = new Set();
let current = 'rules';

function invalidate(...views) {
  for (const v of views) {
    if (v === current) RENDER[v]();
    else dirty.add(v);
  }
}

function renderAll() {
  renderBadges();
  Object.keys(RENDER).forEach((v) => dirty.add(v));
  if (dirty.delete(current)) RENDER[current]?.();
}

function renderBadges() {
  $('n-rules').textContent = S.rules.length || '';
  $('n-dests').textContent = S.dests.length || '';
}

// ポップアップなど別の画面での変更を、変わった部分だけ反映する
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local' || !S) return;
  if (c.rules) S.rules = c.rules.newValue || [];
  if (c.dests) S.dests = c.dests.newValue || [];
  if (c.history) S.history = c.history.newValue || [];
  if (c.lastExport) S.lastExport = c.lastExport.newValue || null;
  if (c.rules || c.dests) {
    renderBadges();
    invalidate('rules', 'dests', 'backup');
  }
  if (c.dests) {
    invalidate('history');
    checkAccess();
  }
  if (c.history) invalidate('history');
  if (c.lastExport) invalidate('backup');
});

// 保存先 id → 保存先、保存先 id → ルール数（描画のたびに配列を何度も探さないため）
function destIndex() {
  return new Map(S.dests.map((d) => [d.id, d]));
}
function ruleCounts() {
  const m = new Map();
  for (const r of S.rules) m.set(r.destId, (m.get(r.destId) || 0) + 1);
  return m;
}

/* ---------- 画面切り替え（#rules など） ---------- */
function route() {
  const v = (location.hash || '#rules').slice(1);
  const view = document.querySelector(`.view[data-v="${CSS.escape(v)}"]`) ? v : 'rules';
  current = view;
  if (S && dirty.delete(view)) RENDER[view]?.();
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('on', s.dataset.v === view));
  document.querySelectorAll('.nav').forEach((n) => {
    const on = n.getAttribute('href') === '#' + view;
    n.classList.toggle('on', on);
    if (on) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', route);

/* ---------- ヘルパー ---------- */
async function checkHelper() {
  // 接続確認と保存先の確認を 1 回の接続で済ませる
  const seq = ++accessSeq;
  const paths = S.dests.map((d) => d.paths?.[os]).filter(Boolean);
  try {
    await session(async (send) => {
      const r = await send('ping');
      helper = { connected: true, version: r.version, os: r.os, arch: r.arch };
      access = paths.length ? (await send('checkPaths', { paths }).catch(() => null))?.result || null : {};
    });
  } catch {
    helper = { connected: false };
    access = null;
  }
  // 確認中に保存先が変わり、新しい確認が始まっていたら、そちらの結果を使う
  if (seq !== accessSeq) access = null;
  document.querySelectorAll('[data-hdot]').forEach((d) => (d.className = 'dot ' + (helper.connected ? 'ok' : 'ng')));
  document.querySelectorAll('[data-htext]').forEach((d) => (d.textContent = helper.connected ? 'ヘルパー接続中' : 'ヘルパー未接続'));
  $('hbanner').hidden = helper.connected;
  $('hver').textContent = helper.connected ? `${helper.version}（${helper.os}/${helper.arch}）` : '—';
  invalidate('dests');
}
$('reconnect').onclick = async () => {
  await checkHelper();
  toast(helper.connected ? 'ヘルパーに接続しました' : 'ヘルパーに接続できませんでした');
};

/** 保存先に今アクセスできるか（ヘルパーで確認） */
// 確認できなかったときは null（「見つかりません」と区別する）
async function checkAccess() {
  const seq = ++accessSeq;
  const paths = S.dests.map((d) => d.paths?.[os]).filter(Boolean);
  let result = {};
  if (helper.connected && paths.length) {
    result = await call('checkPaths', { paths }).then((r) => r.result || null, () => null);
  }
  if (seq !== accessSeq) return; // 新しい確認が始まっていたら古い結果は使わない
  access = result;
  invalidate('dests');
}

/* ---------- ルール ---------- */
$('q').addEventListener('input', renderRules);

function renderRules() {
  const el = $('rules');
  const q = $('q').value.trim().toLowerCase();
  const list = S.rules.filter((r) => r.domain.includes(q)).sort((a, b) => a.domain.localeCompare(b.domain));
  const byId = destIndex();
  if (!S.rules.length) {
    el.innerHTML = `<div class="empty">${ILLUST}<h3>まだルールがありません</h3>
      <p>よく使うサイトを登録すると、そのサイトのダウンロードだけ<br>指定したフォルダに自動で保存されます。</p>
      <button class="btn primary" data-add-rule>${svg('plus')}最初のルールを追加</button></div>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>「${esc(q)}」に一致するルールはありません</h3></div>`;
    return;
  }
  el.innerHTML = list
    .map((r) => {
      const d = byId.get(r.destId);
      return `<div class="card rule${r.enabled ? '' : ' disabled'}" data-id="${esc(r.id)}">
        ${fav(r.domain)}
        <div class="info"><div class="dom">${esc(r.domain)}</div><div class="mode">${r.includeSubdomains ? 'サブドメインも含む' : '完全一致のみ'}</div></div>
        <span class="arrow">${svg('arrow')}</span><div class="dest">${chip(d, os)}</div>
        <div class="more"><button class="iconbtn" aria-label="${esc(r.domain)} を編集" data-edit>${svg('edit')}</button>
          <button class="iconbtn" aria-label="${esc(r.domain)} を削除" data-del>${svg('trash')}</button></div>
        <button class="toggle" role="switch" aria-checked="${r.enabled}" aria-label="${esc(r.domain)} を振り分け" data-sw></button></div>`;
    })
    .join('');
}

$('rules').addEventListener('click', async (e) => {
  const card = e.target.closest('.rule');
  if (!card) return;
  const id = card.dataset.id;
  const r = S.rules.find((x) => x.id === id);
  if (!r) return;
  if (e.target.closest('[data-sw]')) {
    await updateRules((rules) => {
      const x = rules.find((y) => y.id === id);
      if (!x) return false;
      x.enabled = !x.enabled;
    });
  } else if (e.target.closest('[data-del]')) {
    let at = -1;
    await updateRules((rules) => {
      at = rules.findIndex((y) => y.id === id);
      if (at < 0) return false;
      rules.splice(at, 1);
    });
    toast(`「${r.domain}」を削除しました`, '元に戻す', () =>
      updateRules((rules) => {
        if (rules.some((y) => y.id === id || y.domain === r.domain)) return false;
        rules.splice(Math.min(Math.max(at, 0), rules.length), 0, r);
      }),
    );
  } else if (e.target.closest('[data-edit]')) {
    ruleModal(r);
  }
});

function ruleModal(rule) {
  if (!S.dests.length) {
    openModal(`<h3 id="mtitle">先に保存先を登録してください</h3>
      <p class="muted" style="margin:0">ルールは「ドメイン → 保存先」の組み合わせです。まず保存先を 1 つ以上登録してください。</p>
      <div class="foot"><button class="btn ghost" data-close>閉じる</button><a class="btn primary" href="#dests" data-close>保存先を登録する</a></div>`);
    return;
  }
  let destId = rule?.destId || S.dests[0].id;
  openModal(`<h3 id="mtitle">${rule ? 'ルールを編集' : 'ルールを追加'}</h3>
    <div class="field"><label for="m-dom">ドメイン</label><input class="input" id="m-dom" placeholder="例：drive.google.com" value="${esc(rule?.domain || '')}" autocomplete="off">
      <div class="hint">URL を貼り付けてもかまいません</div></div>
    <div class="field"><span class="lbl">保存先</span><div class="pick" id="m-pick" role="radiogroup">${S.dests
      .map((d) => {
        const k = destKind(d, os);
        return `<button role="radio" data-id="${esc(d.id)}" aria-checked="${d.id === destId}" class="${d.id === destId ? 'on' : ''}"><span class="ic ${k}">${svg(k)}</span><span class="nm">${esc(d.name)}</span></button>`;
      })
      .join('')}</div></div>
    <div class="row" style="margin-bottom:10px"><div><div>サブドメインも含む</div><div class="small muted">オフにすると完全一致のみ（www. は常に含みます）</div></div>
      <button class="toggle" role="switch" aria-checked="${rule ? rule.includeSubdomains : true}" aria-label="サブドメインも含む" id="m-sub"></button></div>
    <div class="err" id="m-err"></div>
    <div class="foot"><button class="btn ghost" data-close>キャンセル</button><button class="btn primary" id="m-save">保存</button></div>`);
  $('m-dom').focus();
  $('m-pick').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    destId = b.dataset.id;
    $('m-pick').querySelectorAll('button').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
  };
  $('m-sub').onclick = () => setToggle($('m-sub'), !isOn($('m-sub')));
  const save = async () => {
    const domain = normalizeDomain($('m-dom').value);
    if (!domain) return ($('m-err').textContent = 'ドメインを正しく入力してください（例：drive.google.com）');
    const data = { domain, destId, includeSubdomains: isOn($('m-sub')) };
    // 保存の直前に最新のルールで確かめる（ダイアログを開いている間に別の画面で変わっていることがある）
    let err = '';
    await updateRules((rules) => {
      if (rules.some((r) => r.domain === domain && r.id !== rule?.id)) return void (err = `「${domain}」のルールはすでにあります`), false;
      if (!rule) return void rules.push({ id: newId(), enabled: true, ...data });
      const x = rules.find((r) => r.id === rule.id);
      if (!x) return void (err = 'このルールは別の画面で削除されました'), false;
      Object.assign(x, data);
    });
    if (err) return ($('m-err').textContent = err);
    closeModal();
    toast(rule ? 'ルールを更新しました' : `「${domain}」を追加しました`);
  };
  $('m-save').onclick = save;
  $('m-dom').addEventListener('keydown', (e) => e.key === 'Enter' && save());
}

/* ---------- 保存先 ---------- */
function renderDests() {
  const el = $('dests');
  if (!S.dests.length) {
    el.innerHTML = `<div class="empty">${ILLUST}<h3>まだ保存先がありません</h3>
      <p>Googleドライブ・Dropbox・外付けSSD など、振り分け先のフォルダを登録します。</p>
      <button class="btn primary" data-add-dest>${svg('plus')}保存先を追加</button></div>`;
    return;
  }
  const counts = ruleCounts();
  el.innerHTML = S.dests
    .map((d) => {
      const k = destKind(d, os);
      const used = counts.get(d.id) || 0;
      const cur = d.paths?.[os];
      const st = !cur
        ? '<span class="dot"></span>この PC は未設定'
        : !helper.connected || !access || !(cur in access)
          ? '<span class="dot"></span>確認できません'
          : access[cur]
            ? '<span class="dot ok"></span>アクセス可'
            : '<span class="dot ng"></span>見つかりません';
      const p = (key) =>
        `<div class="path${key === os ? ' cur' : ''}"><span class="os">${key.toUpperCase()}</span>${
          d.paths?.[key] ? `<code title="${esc(d.paths[key])}">${esc(d.paths[key])}</code>` : '<code class="unset">未設定</code>'
        }</div>`;
      return `<div class="card dest-card" data-id="${esc(d.id)}">
        <div class="ic ${k}">${svg(k)}</div>
        <div class="nm">${esc(d.name)}<small>${KIND_LABEL[k]}・ルール ${used} 件</small></div>
        <div class="st">${st}<div class="more"><button class="iconbtn" aria-label="${esc(d.name)} を編集" data-edit>${svg('edit')}</button>
          <button class="iconbtn" aria-label="${esc(d.name)} を削除" data-del>${svg('trash')}</button></div></div>
        ${p(os)}${p(other)}</div>`;
    })
    .join('');
}

$('dests').addEventListener('click', async (e) => {
  const card = e.target.closest('.dest-card');
  if (!card) return;
  const id = card.dataset.id;
  const d = S.dests.find((x) => x.id === id);
  if (!d) return;
  if (e.target.closest('[data-edit]')) return destModal(d);
  if (e.target.closest('[data-del]')) {
    const used = ruleCounts().get(id) || 0;
    if (used) return toast(`ルール ${used} 件で使われているため削除できません`);
    let at = -1;
    await updateDests((dests) => {
      at = dests.findIndex((x) => x.id === id);
      if (at < 0) return false;
      dests.splice(at, 1);
    });
    toast(`「${d.name}」を削除しました`, '元に戻す', () =>
      updateDests((dests) => {
        if (dests.some((x) => x.id === id)) return false;
        dests.splice(Math.min(Math.max(at, 0), dests.length), 0, d);
      }),
    );
  }
});

function destModal(dest) {
  openModal(`<h3 id="mtitle">${dest ? '保存先を編集' : '保存先を追加'}</h3>
    <div class="field"><label for="m-name">名前</label><input class="input" id="m-name" maxlength="60" placeholder="例：大学資料（Drive）" value="${esc(dest?.name || '')}"></div>
    <div class="field"><label for="m-cur">この PC（${OS_NAME[os]}）のフォルダ</label>
      <div class="with-btn"><input class="input mono" id="m-cur" placeholder="${os === 'mac' ? '/Volumes/SSD/動画' : 'G:\\マイドライブ\\大学'}" value="${esc(dest?.paths?.[os] || '')}">
        <button class="btn ghost" id="m-browse" ${helper.connected ? '' : 'disabled'}>${svg('folder')}選ぶ</button></div>
      <div class="hint" id="m-hint">${helper.connected ? '' : 'ヘルパーに接続すると、フォルダをダイアログで選べます'}</div>
      <div class="pick" id="m-vols" style="margin-top:8px"></div></div>
    <div class="field"><label for="m-oth">${OS_NAME[other]} のフォルダ（任意）</label>
      <input class="input mono" id="m-oth" placeholder="${other === 'mac' ? '~/Library/CloudStorage/…' : 'G:\\マイドライブ\\大学'}" value="${esc(dest?.paths?.[other] || '')}">
      <div class="hint">${OS_NAME[other]} 側で設定してバックアップを読み込めば、ここは空のままで大丈夫です</div></div>
    <div class="err" id="m-err"></div>
    <div class="foot"><button class="btn ghost" data-close>キャンセル</button><button class="btn primary" id="m-save">保存</button></div>`);
  $('m-name').focus();
  const gen = modalGen;
  const alive = () => gen === modalGen; // まだこのダイアログが開いているか
  if (helper.connected) {
    // マウント中の場所（Googleドライブ・Dropbox・外付けなど）を候補として出す
    call('listVolumes')
      .then((r) => {
        const vols = r.volumes || [];
        if (!vols.length || !alive()) return;
        $('m-vols').innerHTML =
          '<span class="small muted" style="width:100%">マウント中の場所</span>' +
          vols
            .map((v) => {
              const k = detectKind(v.path);
              return `<button data-path="${esc(v.path)}" title="${esc(v.path)}"><span class="ic ${k}">${svg(k)}</span><span class="nm">${esc(v.name)}</span></button>`;
            })
            .join('');
      })
      .catch(() => {});
    $('m-vols').onclick = (e) => {
      const b = e.target.closest('[data-path]');
      if (b) browse(b.dataset.path);
    };
  }
  $('m-browse').onclick = () => browse($('m-cur').value.trim());
  async function browse(start) {
    $('m-hint').textContent = 'フォルダ選択のウィンドウを開きました（Brave の後ろに出ることがあります）';
    try {
      const r = await call('pickFolder', { startDir: start || '' });
      if (!alive()) return; // 選んでいる間にダイアログが閉じられた
      if (r.path) {
        $('m-cur').value = r.path;
        if (!$('m-name').value.trim()) $('m-name').value = r.path.split(/[\\/]/).filter(Boolean).pop() || '';
      }
      $('m-hint').textContent = '';
    } catch (e) {
      if (alive()) $('m-hint').textContent = 'フォルダを選べませんでした：' + e.message;
    }
  }
  $('m-save').onclick = async () => {
    const name = $('m-name').value.trim();
    const cur = $('m-cur').value.trim();
    const oth = $('m-oth').value.trim();
    if (!name) return ($('m-err').textContent = '名前を入力してください');
    if (!cur && !oth) return ($('m-err').textContent = 'フォルダを 1 つ以上入力してください');
    const paths = { [os]: cur, [other]: oth };
    let err = '';
    await updateDests((dests) => {
      if (dests.some((d) => d.name === name && d.id !== dest?.id)) return void (err = '同じ名前の保存先があります'), false;
      if (!dest) return void dests.push({ id: newId(), name, paths });
      const x = dests.find((d) => d.id === dest.id);
      if (!x) return void (err = 'この保存先は別の画面で削除されました'), false;
      Object.assign(x, { name, paths });
    });
    if (err) return ($('m-err').textContent = err);
    closeModal();
    toast(dest ? '保存先を更新しました' : `「${name}」を追加しました`);
  };
}

/* ---------- 履歴 ---------- */
$('hfilter').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  hfilter = b.dataset.f;
  $('hfilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderHistory();
};
$('hclear').onclick = () => {
  openModal(`<h3 id="mtitle">履歴を消去しますか？</h3><p class="muted" style="margin:0">振り分けたファイル自体は消えません。</p>
    <div class="foot"><button class="btn ghost" data-close>キャンセル</button><button class="btn danger" id="m-ok">消去する</button></div>`);
  $('m-ok').onclick = async () => {
    await clearHistory();
    closeModal();
  };
};

function renderHistory() {
  const list = S.history.filter((h) => hfilter === 'all' || h.status !== 'ok');
  $('hclear').disabled = !S.history.length;
  if (!list.length) {
    $('history').innerHTML = `<div class="card empty"><h3>${hfilter === 'fail' ? '失敗した振り分けはありません' : 'まだ履歴はありません'}</h3>
      <p style="margin:0">登録したサイトからダウンロードすると、ここに表示されます。</p></div>`;
    return;
  }
  const byId = destIndex();
  $('history').innerHTML = `<div class="card table"><table>
    <thead><tr><th>ファイル</th><th>サイト</th><th>保存先</th><th>結果</th><th>日時</th></tr></thead><tbody>${list
      .map((h) => {
        const ok = h.status === 'ok';
        const d = byId.get(h.destId) || { name: h.destName, paths: {} };
        const note = ok ? (h.renamed ? `同名ファイルがあったため「${h.renamed}」で保存` : '') : h.reason + '（ダウンロードフォルダに残しました）';
        return `<tr data-path="${esc(h.path)}" title="フォルダを開く"><td class="fn-cell"><div class="fn">${esc(h.filename)}</div>${note ? `<div class="reason">${esc(note)}</div>` : ''}</td>
          <td class="muted">${esc(h.site || '')}</td><td>${chip(d, os)}</td>
          <td>${ok ? `<span class="res ok">${svg('check')}成功</span>` : `<span class="res ng">${svg('x')}失敗</span>`}</td>
          <td class="muted small" style="white-space:nowrap">${fmtTime(h.time)}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
}
$('history').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-path]');
  if (tr) call('openFolder', { path: tr.dataset.path, reveal: true }).catch((err) => toast('フォルダを開けませんでした：' + err.message));
});

/* ---------- バックアップ ---------- */
function renderBackup() {
  $('exp-desc').textContent = `ルール ${S.rules.length} 件・保存先 ${S.dests.length} 件を 1 つのファイルにします。`;
  $('last-exp').textContent = S.lastExport ? `最後に書き出した日時：${fmtTime(new Date(S.lastExport).getTime())}` : '';
}

$('export').onclick = async () => {
  const now = new Date();
  const data = buildExport(S, now);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `shimau-${now.toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  await chrome.storage.local.set({ lastExport: now.toISOString() });
  toast('書き出しました');
};

$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  let incoming;
  try {
    incoming = parseImport(await f.text());
  } catch (e) {
    return toast(e.message);
  }
  const p = previewMerge(S, incoming);
  const run = async (overwrite) => {
    const merged = mergeImport(S, incoming, { overwrite, newId });
    await chrome.storage.local.set({ rules: merged.rules, dests: merged.dests });
    closeModal();
    toast('読み込みました');
  };
  openModal(`<h3 id="mtitle">バックアップを読み込みますか？</h3>
    <p class="muted" style="margin:0 0 6px">ルール ${p.added} 件を追加し、保存先 ${p.dests} 件を反映します。</p>
    ${p.conflicts ? `<p style="margin:0">同じドメインのルールが <b>${p.conflicts} 件</b> あります。上書きしますか？</p>` : ''}
    <div class="foot"><button class="btn ghost" data-close>キャンセル</button>
      ${p.conflicts ? '<button class="btn ghost" id="m-keep">今のルールを残す</button><button class="btn primary" id="m-over">上書きする</button>' : '<button class="btn primary" id="m-keep">読み込む</button>'}</div>`);
  $('m-keep').onclick = () => run(false);
  if ($('m-over')) $('m-over').onclick = () => run(true);
};

/* ---------- 共通：追加ボタン・モーダル・トースト ---------- */
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-add-rule]')) ruleModal(null);
  if (e.target.closest('[data-add-dest]')) destModal(null);
  if (e.target.closest('[data-close]') || e.target === $('modal')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && location.hash !== '#dests') {
    e.preventDefault();
    location.hash = '#rules';
    $('q').focus();
  }
});

let lastFocus;
function openModal(html) {
  modalGen++;
  lastFocus = document.activeElement;
  $('side').inert = $('main').inert = true; // 背面をキーボードで触れないようにする
  $('mbox').innerHTML = html;
  $('modal').hidden = false;
  const first = $('mbox').querySelector('input,button.primary');
  first?.focus();
}
function closeModal() {
  modalGen++;
  $('side').inert = $('main').inert = false;
  $('modal').hidden = true;
  $('mbox').innerHTML = '';
  lastFocus?.focus?.();
}

let toastTimer;
function toast(msg, btnLabel, onBtn) {
  $('toast-msg').textContent = msg;
  const b = $('toast-btn');
  b.hidden = !btnLabel;
  b.textContent = btnLabel || '';
  b.onclick = async () => {
    hideToast();
    await onBtn?.();
  };
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
const hideToast = () => $('toast').classList.remove('show');

const ILLUST = `<svg class="ill" viewBox="0 0 160 110" fill="none" aria-hidden="true"><rect x="20" y="30" width="120" height="70" rx="12" fill="var(--surface-2)"/>
  <path d="M20 46a12 12 0 0 1 12-12h28l10 10h58a12 12 0 0 1 12 12" stroke="var(--border)" stroke-width="3"/>
  <circle cx="80" cy="66" r="16" fill="var(--accent-soft)"/><path d="M80 58v16M72 66h16" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
  <circle cx="132" cy="18" r="5" fill="var(--accent)" opacity=".5"/><circle cx="26" cy="14" r="3" fill="var(--text-3)" opacity=".5"/></svg>`;

init();
