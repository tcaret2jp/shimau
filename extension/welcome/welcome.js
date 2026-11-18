// はじめての設定：ヘルパーのダウンロード → インストール → つながったら最初のルールへ
import { ping, call } from '../lib/native.js';
import { paintIcons, svg, esc, fav } from '../ui/parts.js';
import { normalizeDomain } from '../lib/domain.js';
import { detectKind } from '../lib/kinds.js';
import { load, updateDests, updateRules, newId, currentOs } from '../lib/store.js';
import { parseImport, previewMerge, mergeImport } from '../lib/backup.js';

const $ = (id) => document.getElementById(id);
const RELEASE = 'https://github.com/tcaret2jp/shimau/releases/latest/download/';
const POLL_MS = 2000;

const GUIDE = {
  mac: { label: 'Mac 用', file: 'shimau-helper-mac.zip' },
  win: { label: 'Windows 用', file: 'shimau-helper-setup.exe' },
};

let timer = null;
let busy = false;

async function init() {
  paintIcons();
  const { os } = await chrome.runtime.getPlatformInfo();
  const key = os === 'win' ? 'win' : 'mac';
  const g = GUIDE[key];
  $('dl').href = RELEASE + g.file;
  $('dl-label').textContent = g.label;
  $('dl').title = g.file;
  document.querySelectorAll('[data-os]').forEach((e) => (e.hidden = e.dataset.os !== key));
  if (os !== 'mac' && os !== 'win') {
    $('install').hidden = true;
    $('wait').querySelector('span').textContent = 'このパソコンの OS には対応していません（Mac / Windows 用です）。';
  }

  setupPlayer();
  await check();
  document.addEventListener('visibilitychange', schedule);
}

// 動画は <dialog> の showModal() で開く（背面は操作できない・Esc で閉じる・閉じると押したボタンへフォーカスが戻る）
function setupPlayer() {
  const player = $('player');
  const vid = $('vid');
  document.querySelectorAll('[data-play]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (!player.open) player.showModal();
      vid.focus();
      vid.currentTime = Number(b.dataset.play);
      vid.play().catch(() => {});
    }),
  );
  player.addEventListener('close', () => vid.pause());
  $('pclose').addEventListener('click', () => player.close());
  player.addEventListener('click', (e) => { if (e.target === player) player.close(); }); // 暗い部分を押しても閉じる
}

async function check() {
  if (busy) return;
  busy = true;
  const h = await ping();
  busy = false;
  if (h.connected) return connected(h);
  schedule();
}

// タブが見えている間だけ、接続を確認し続ける
function schedule() {
  clearTimeout(timer);
  if (!document.hidden && $('okmsg').hidden) timer = setTimeout(check, POLL_MS);
}

function connected(h) {
  clearTimeout(timer);
  if ($('player').open) $('player').close(); // 動画を見ている間につながっても、次へ進めるように閉じる
  $('s2').classList.replace('now', 'done');
  $('s3').classList.add('now');
  $('n2').innerHTML = svg('check');
  $('install').hidden = true;
  $('wait').hidden = true;
  $('trouble').hidden = true;
  $('okmsg').hidden = false;
  $('ok-text').textContent = `ヘルパーとつながりました（v${h.version}）`;
  $('s3act').hidden = false;
  $('lead').textContent = 'あと 1 ステップです。';
  setTimeout(startTour, 900); // つながったことを少し見せてから、チュートリアルへ
}
$('to-tour').onclick = () => startTour();

/* ==================== チュートリアル（カルーセル） ==================== */
const slides = [...document.querySelectorAll('.slide')];
const idx = (name) => slides.findIndex((s) => s.dataset.s === name);
let cur = 0;
let started = false;
let pos; // 'mac' | 'win'
let destId = null; // チュートリアルで作った保存先（戻って直したときは同じものを更新する）
let ruleId = null; // チュートリアルで作ったルール（同上）
let ruleDomain = null;
let furthest = 0; // 正しい順番でたどり着いた一番先のカード（点で飛べるのはここまで）
let saving = false; // 保存中は移動・入力をさせない
let destName = '';

async function startTour() {
  if (started) return;
  started = true;
  pos = await currentOs();
  const { rules, dests } = await load();
  if (rules.length || dests.length) {
    $('has-config').hidden = false;
    $('has-config-text').textContent = `ルール ${rules.length} 件・保存先 ${dests.length} 件が登録済みです`;
  }
  $('dots').innerHTML = slides.map((_, i) => `<button role="tab" aria-label="${i + 1} 枚目"></button>`).join('');
  $('progress').innerHTML = slides.map(() => '<i></i>').join('');
  $('install-view').hidden = true;
  $('tour').hidden = false;
  $('d-path').placeholder = pos === 'win' ? 'G:\\マイドライブ\\大学' : '/Users/…/マイドライブ/大学';
  renderPreview();
  loadVolumes();
  go(0, { instant: true });
  requestAnimationFrame(() => go(cur, { instant: true })); // 表示後の幅で位置を合わせ直す
}

// 進めるのは「次へ」系のボタンだけ（入力が必要なカードは条件を満たすまで進めない）
const canLeave = (i) => !slides[i].querySelector('.nav .btn.primary:disabled');

function go(i, { instant = false } = {}) {
  cur = Math.max(0, Math.min(slides.length - 1, i));
  furthest = Math.max(furthest, cur);
  const w = slides[0].offsetWidth; // 縮小表示（transform）の影響を受けない幅
  const gap = parseFloat(getComputedStyle($('track')).gap) || 0;
  const offset = $('car').clientWidth / 2 - w / 2 - cur * (w + gap);
  $('track').style.transition = instant ? 'none' : '';
  $('track').style.transform = `translateX(${offset}px)`;
  slides.forEach((s, k) => {
    s.classList.toggle('cur', k === cur);
    s.inert = k !== cur; // 見えている 1 枚だけ操作できる
    s.setAttribute('aria-hidden', String(k !== cur));
  });
  [...$('dots').children].forEach((d, k) => {
    d.classList.toggle('on', k === cur);
    d.setAttribute('aria-selected', String(k === cur));
    d.disabled = saving || k > furthest;
  });
  [...$('progress').children].forEach((d, k) => d.classList.toggle('on', k <= cur));
  const f = slides[cur].querySelector('input:not([type=file])');
  if (f && !instant) setTimeout(() => f.focus({ preventScroll: true }), 380);
}
// 保存したあとに内容を変えたら、その先へは保存し直すまで飛べない
function invalidateFrom(name) {
  furthest = Math.min(furthest, idx(name));
  [...$('dots').children].forEach((d, k) => (d.disabled = k > furthest));
}

// 保存中は、そのカードの入力とボタン・点を止める（保存の途中で移動・変更されないように）
async function whileSaving(fn) {
  if (saving) return;
  saving = true;
  const els = [...slides[cur].querySelectorAll('input, button'), ...$('dots').children];
  const was = els.map((e) => e.disabled);
  els.forEach((e) => (e.disabled = true));
  try {
    await fn();
  } finally {
    saving = false;
    els.forEach((e, k) => (e.disabled = was[k]));
    [...$('dots').children].forEach((d, k) => (d.disabled = k > furthest));
  }
}

const next = () => {
  if (saving) return;
  if (cur === idx('dest')) return saveDest();
  if (cur === idx('rule')) return saveRule();
  if (canLeave(cur)) go(cur + 1);
};
const prev = () => !saving && go(cur - 1);

document.addEventListener('click', (e) => {
  if ($('tour').hidden) return;
  if (e.target.closest('[data-next]')) next();
  if (e.target.closest('[data-prev]')) prev();
  const d = e.target.closest('#dots button');
  if (d && !d.disabled && !saving) go([...$('dots').children].indexOf(d));
});
document.addEventListener('keydown', (e) => {
  if ($('tour').hidden || (e.target instanceof Element && e.target.closest('input, textarea'))) return;
  if (e.key === 'ArrowRight' && cur < idx('dest')) next();
  if (e.key === 'ArrowRight' && cur > idx('rule') && cur < slides.length - 1) go(cur + 1);
  if (e.key === 'ArrowLeft') prev();
});
window.addEventListener('resize', () => !$('tour').hidden && go(cur, { instant: true }));

// トラックパッドの横スワイプ・タッチのスワイプ
let wheelLock = 0;
$('car').addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaX) < 30 || Math.abs(e.deltaX) < Math.abs(e.deltaY) || Date.now() < wheelLock) return;
    wheelLock = Date.now() + 600;
    if (e.deltaX > 0) {
      if (cur < idx('dest') || (cur > idx('rule') && cur < slides.length - 1)) next();
    } else prev();
  },
  { passive: true },
);
let touchX = null;
$('car').addEventListener('pointerdown', (e) => e.pointerType !== 'mouse' && (touchX = e.clientX));
$('car').addEventListener('pointerup', (e) => {
  if (touchX === null) return;
  const dx = e.clientX - touchX;
  touchX = null;
  if (dx < -50 && (cur < idx('dest') || (cur > idx('rule') && cur < slides.length - 1))) next();
  if (dx > 50) prev();
});

/* ---------- バックアップを読み込む ---------- */
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  $('import-err').textContent = '';
  try {
    const incoming = parseImport(await f.text());
    const current = await load();
    const p = previewMerge(current, incoming);
    // 同じドメインのルールが今の設定にあれば、今のものを残す（上書きは設定画面から選べる）
    const merged = mergeImport(current, incoming, { overwrite: false, newId });
    await chrome.storage.local.set({ rules: merged.rules, dests: merged.dests });
    $('done-lead').innerHTML =
      `バックアップから ルール <b>${p.added}</b> 件・保存先 <b>${p.dests}</b> 件を読み込みました。` +
      (p.conflicts ? `<br>すでにあった ${p.conflicts} 件のルールはそのまま残しています。` : '');
    ruleDomain = 'imported';
    go(idx('done'));
  } catch (e) {
    $('import-err').textContent = e.message;
  }
};

/* ---------- 保存先 ---------- */
const dPath = $('d-path');
const dName = $('d-name');
const vDest = () => {
  $('d-next').disabled = !(dPath.value.trim() && dName.value.trim());
  invalidateFrom('dest');
  $('d-err').textContent = '';
  renderPreview();
};
dPath.addEventListener('input', vDest);
dName.addEventListener('input', vDest);
dName.addEventListener('keydown', (e) => e.key === 'Enter' && !$('d-next').disabled && saveDest());
$('d-next').onclick = () => saveDest();

function setPath(p) {
  dPath.value = p;
  dName.value = p.split(/[\\/]/).filter(Boolean).pop() || '';
  vDest();
}

async function loadVolumes() {
  try {
    const vols = (await call('listVolumes')).volumes || [];
    if (!vols.length) return;
    $('d-vols').innerHTML =
      '<span class="hint" style="width:100%;margin:0 0 2px">マウント中の場所から選ぶ</span>' +
      vols
        .map((v) => {
          const k = detectKind(v.path);
          return `<button data-path="${esc(v.path)}" title="${esc(v.path)}"><span class="ic ${k}">${svg(k)}</span>${esc(v.name)}</button>`;
        })
        .join('');
  } catch {}
}
$('d-vols').onclick = (e) => {
  const b = e.target.closest('[data-path]');
  if (b) browse(b.dataset.path);
};
$('d-pick').onclick = () => browse(dPath.value.trim());

let picking = false;
async function browse(start) {
  if (picking) return;
  picking = true;
  $('d-hint').textContent = 'フォルダ選択のウィンドウを開きました（Brave の後ろに出ることがあります）';
  try {
    const r = await call('pickFolder', { startDir: start || '' });
    if (r.path) setPath(r.path);
    $('d-hint').textContent = '';
  } catch (e) {
    $('d-hint').textContent = 'フォルダを選べませんでした：' + e.message;
  } finally {
    picking = false;
  }
}

const saveDest = () => whileSaving(doSaveDest);
async function doSaveDest() {
  const path = dPath.value.trim();
  const name = dName.value.trim();
  if (!path || !name) return;
  // フォルダがあるか確かめる
  let ok;
  try {
    ok = (await call('checkPaths', { paths: [path] })).result?.[path];
  } catch {
    return ($('d-err').textContent = 'ヘルパーに接続できないため、フォルダを確認できません。少し待ってからもう一度押してください');
  }
  if (!ok) return ($('d-err').textContent = 'このフォルダが見つかりません。「選ぶ」から選んでください');
  let err = '';
  await updateDests((dests) => {
    if (dests.some((d) => d.name === name && d.id !== destId)) return void (err = `「${name}」という保存先がすでにあります。別の名前にしてください`), false;
    const ex = destId && dests.find((d) => d.id === destId);
    if (ex) ex.name = name, (ex.paths = { ...ex.paths, [pos]: path });
    else dests.push({ id: (destId = newId()), name, paths: { mac: '', win: '', [pos]: path } });
  });
  if (err) return ($('d-err').textContent = err);
  destName = name;
  renderPreview();
  go(idx('rule'));
}

/* ---------- ルール ---------- */
const rDom = $('r-dom');
rDom.addEventListener('input', () => {
  $('r-err').textContent = '';
  invalidateFrom('rule');
  $('r-next').disabled = !normalizeDomain(rDom.value);
  renderPreview();
});
rDom.addEventListener('keydown', (e) => e.key === 'Enter' && !$('r-next').disabled && saveRule());
$('r-next').onclick = () => saveRule();

function renderPreview() {
  const dom = normalizeDomain(rDom.value);
  $('p-site').innerHTML = dom ? `${fav(dom)}<span>${esc(dom)}</span>` : '<span class="muted">サイト</span>';
  const k = detectKind(dPath.value.trim());
  $('p-dest').innerHTML = `<span class="ic ${k}">${svg(k)}</span><span>${esc(dName.value.trim() || '保存先')}</span>`;
}

const saveRule = () => whileSaving(doSaveRule);
async function doSaveRule() {
  const domain = normalizeDomain(rDom.value);
  if (!domain) return;
  if (!destId) return ($('r-err').textContent = '先に保存先を作ってください（「戻る」で前のカードへ）');
  await updateRules((rules) => {
    const mine = ruleId && rules.find((r) => r.id === ruleId);
    const same = rules.find((r) => r.domain === domain && r.id !== ruleId);
    if (same) {
      // 同じサイトのルールがすでにあれば、行き先をこの保存先に変えて ON にする。
      // このチュートリアルで先に作った別のサイトのルールは消す（戻ってサイトを変えたとき）
      Object.assign(same, { destId, enabled: true });
      if (mine) rules.splice(rules.indexOf(mine), 1);
      ruleId = same.id;
    } else if (mine) {
      Object.assign(mine, { domain, destId, enabled: true });
    } else {
      rules.push({ id: (ruleId = newId()), domain, destId, includeSubdomains: true, enabled: true });
    }
  });
  ruleDomain = domain;
  $('done-lead').innerHTML = `これからは <b>${esc(domain)}</b> のダウンロードが <b>${esc(destName)}</b> に自動でしまわれます。`;
  go(idx('brave'));
}

/* ---------- Brave の設定・完了 ---------- */
$('open-settings').onclick = () => chrome.tabs.create({ url: 'chrome://settings/downloads' });
$('close').onclick = async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
  else window.close();
};

init();
