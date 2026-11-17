import { hostOf, siteDomain, findRule } from '../lib/domain.js';
import { load, saveRules, newId, currentOs } from '../lib/store.js';
import { ping, call } from '../lib/native.js';
import { svg, esc, chip, fav, paintIcons, relTime, destKind } from '../ui/parts.js';

const $ = (id) => document.getElementById(id);
let S, os, host, picking = false;

async function init() {
  paintIcons();
  [S, os] = await Promise.all([load(), currentOs()]);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = hostOf(tab?.url);
  renderSite();
  renderRecent();
  ping().then(renderHelper);
}

function renderHelper(h) {
  $('hdot').className = 'dot ' + (h.connected ? 'ok' : 'ng');
  $('htext').textContent = h.connected ? 'ヘルパー接続中' : 'ヘルパー未接続';
  $('hbanner').hidden = h.connected;
}

function renderSite() {
  const el = $('site');
  if (!host) {
    el.innerHTML = `<div class="site-top"><div class="fav" style="background:var(--ssd)">${svg('alert')}</div>
      <div><div class="dom">このページでは使えません</div><div class="sub">http / https のサイトを開いてください</div></div></div>`;
    return;
  }
  const rule = findRule(S.rules, host, { onlyEnabled: false });
  if (rule) {
    const dest = S.dests.find((d) => d.id === rule.destId);
    const viaParent = rule.domain !== siteDomain(host);
    el.innerHTML = `<div class="site-top">${fav(rule.domain)}
        <div><div class="dom">${esc(host)}</div><div class="sub">${
          rule.enabled ? (viaParent ? `「${esc(rule.domain)}」のルールで振り分け中` : 'このサイトを振り分け中') : '振り分けをオフにしています'
        }</div></div>
        <button class="toggle" role="switch" aria-checked="${rule.enabled}" aria-label="振り分け" id="sw-on"></button></div>
      <div class="site-rows">
        <div class="row"><span class="k">保存先</span><button class="btn text destbtn" id="pick" aria-expanded="${picking}">${chip(dest, os)}${svg('chev')}</button></div>
        <div class="row"><span class="k">サブドメインも含む</span><button class="toggle sm" role="switch" aria-checked="${rule.includeSubdomains}" aria-label="サブドメインも含む" id="sw-sub"></button></div>
      </div>${picking ? picker(rule.destId) : ''}`;
    $('sw-on').onclick = () => update(rule, { enabled: !rule.enabled });
    $('sw-sub').onclick = () => update(rule, { includeSubdomains: !rule.includeSubdomains });
    $('pick').onclick = () => { picking = !picking; renderSite(); };
    bindPicker((destId) => update(rule, { destId }));
  } else {
    const dom = siteDomain(host);
    el.innerHTML = `<div class="site-top">${fav(dom)}<div><div class="dom">${esc(host)}</div><div class="sub">振り分け対象外（Brave 標準の保存先）</div></div></div>
      ${
        !S.dests.length
          ? `<p class="small muted" style="margin:12px 0 0">先に保存先を登録してください。</p><button class="btn primary" data-open="dests">${svg('plus')}保存先を登録する</button>`
          : picking
            ? `<div class="small muted" style="margin-top:12px">保存先を選ぶと登録が完了します</div>${picker()}`
            : `<button class="btn primary" id="add">${svg('plus')}このサイトを振り分けに追加</button>`
      }`;
    if ($('add')) $('add').onclick = () => { picking = true; renderSite(); };
    bindPicker(async (destId) => {
      S.rules.push({ id: newId(), domain: dom, destId, includeSubdomains: true, enabled: true });
      await saveRules(S.rules);
    });
  }
}

function picker(cur) {
  return `<div class="picker" role="listbox">${S.dests
    .map((d) => {
      const k = destKind(d, os);
      const p = d.paths?.[os];
      return `<button role="option" data-choose="${esc(d.id)}" aria-selected="${d.id === cur}">
        <span class="ic ${k}">${svg(k)}</span>
        <span class="t"><div class="nm">${esc(d.name)}</div><div class="pt">${p ? esc(p) : 'この PC のパスが未設定'}</div></span>
        ${d.id === cur ? `<span class="cur">${svg('check')}</span>` : ''}</button>`;
    })
    .join('')}</div>`;
}

function bindPicker(onChoose) {
  $('site').querySelectorAll('[data-choose]').forEach((b) => {
    b.onclick = async () => {
      await onChoose(b.dataset.choose);
      picking = false;
      renderSite();
    };
  });
}

async function update(rule, patch) {
  Object.assign(rule, patch);
  await saveRules(S.rules);
  renderSite();
}

function renderRecent() {
  const items = S.history.slice(0, 5);
  if (!items.length) {
    $('recent').innerHTML = '<div class="none">まだ振り分けたファイルはありません</div>';
    return;
  }
  $('recent').innerHTML = items
    .map((h, i) => {
      const fail = h.status !== 'ok';
      const d = S.dests.find((x) => x.id === h.destId);
      const k = fail ? 'warn' : destKind(d, os);
      return `<button data-i="${i}" title="フォルダを開く">
        <span class="ic ${k}">${svg(fail ? 'alert' : k)}</span>
        <span class="t"><div class="fn">${esc(h.renamed || h.filename)}</div><div class="meta">${
          fail ? esc(h.reason) + '（ダウンロードフォルダに残しました）' : esc(h.destName)
        }</div></span>
        <span class="when">${relTime(h.time)}</span></button>`;
    })
    .join('');
  $('recent').querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => call('openFolder', { path: items[+b.dataset.i].path, reveal: true }).catch(() => {});
  });
}

document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (!o) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#' + o.dataset.open) });
  window.close();
});

init();
