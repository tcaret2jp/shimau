// UI 部品（アイコン・チップ・ファビコンなど）
import { detectKind } from '../lib/kinds.js';

const I = {
  route: '<path d="M4 12h6l4-6h6M14 18h6M10 12l4 6"/><path d="M17 3l3 3-3 3M17 15l3 3-3 3"/>',
  drive: '<path d="M8 3h8l6 10-4 7H6l-4-7z"/><path d="M8 3l6 10h8M2 13h12l-4 7"/>',
  dropbox: '<path d="M7 3l5 3.2-5 3.3L2 6.2zM17 3l5 3.2-5 3.3-5-3.3zM2 12.8l5-3.3 5 3.3-5 3.2zM17 9.5l5 3.3-5 3.2-5-3.2zM7 17.3l5-3.2 5 3.2-5 3.3z"/>',
  ssd: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 14h.01M11 14h6"/>',
  local: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

export const svg = (n) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;

/** data-icon="名前" の要素にアイコンを入れる */
export function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((e) => {
    e.innerHTML = svg(e.dataset.icon);
  });
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 保存先の種類（今の OS のパスで判定） */
export const destKind = (dest, os) => detectKind(dest?.paths?.[os] || dest?.paths?.mac || dest?.paths?.win);

export function chip(dest, os, { off = false } = {}) {
  if (!dest) return `<span class="chip off"><span class="ic warn">${svg('alert')}</span><span class="nm">保存先なし</span></span>`;
  const k = destKind(dest, os);
  return `<span class="chip${off ? ' off' : ''}"><span class="ic ${k}">${svg(k)}</span><span class="nm">${esc(dest.name)}</span></span>`;
}

const COLORS = ['#4b7bec', '#20bf6b', '#8854d0', '#eb3b5a', '#fa8231', '#0fb9b1', '#3867d6'];
const favColor = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

/** ファビコン（取得できなければ頭文字） */
export function fav(domain) {
  const src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://' + domain)}&size=32`);
  return `<div class="fav has-img" style="background:${favColor(domain)}">${esc(domain[0]?.toUpperCase() || '?')}<img src="${src}" alt=""></div>`;
}
// 画像が読めなかったら頭文字に戻す（インラインの onerror は CSP で使えないため、捕捉フェーズで拾う）
document.addEventListener(
  'error',
  (e) => {
    if (e.target?.tagName === 'IMG' && e.target.parentElement?.classList.contains('fav')) {
      e.target.parentElement.classList.remove('has-img');
      e.target.remove();
    }
  },
  true,
);

export function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  if (s < 172800) return '昨日';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function setToggle(el, on) {
  el.setAttribute('aria-checked', String(!!on));
}
export const isOn = (el) => el.getAttribute('aria-checked') === 'true';
