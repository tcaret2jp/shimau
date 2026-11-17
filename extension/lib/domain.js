// ドメイン判定（chrome.* に依存しない純粋関数。node:test でテストする）

/** URL 文字列からホスト名を取り出す。http/https 以外や不正な URL は null。 */
export function hostOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * ユーザー入力をルール用ドメインに正規化する。
 * "https://www.Example.com/path" → "example.com"、不正なら null。
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host || host.length > 253) return null;
  // IPv6 は対象外。ラベルは英数字とハイフン（punycode 化済み）
  const labels = host.split('.');
  if (labels.some((l) => !/^[a-z0-9-]{1,63}$/.test(l) || l.startsWith('-') || l.endsWith('-'))) return null;
  return host;
}

/** ルール用ドメイン：サイトのホスト名から www. を取ったもの。 */
export function siteDomain(host) {
  return host ? host.replace(/^www\./, '') : null;
}

/** 1つのルールがホストに一致するか。 */
export function ruleMatches(rule, host) {
  if (!host || !rule?.domain) return false;
  const d = rule.domain;
  if (host === d || host === 'www.' + d) return true;
  return !!rule.includeSubdomains && host.endsWith('.' + d);
}

/**
 * ホストに一致するルールのうち、最も具体的な（ドメインが長い）ものを返す。
 * onlyEnabled=false にすると OFF のルールも対象にする（ポップアップ表示用）。
 */
export function findRule(rules, host, { onlyEnabled = true } = {}) {
  let best = null;
  for (const r of rules || []) {
    if (onlyEnabled && !r.enabled) continue;
    if (!ruleMatches(r, host)) continue;
    if (!best || r.domain.length > best.domain.length) best = r;
  }
  return best;
}

/**
 * ダウンロードの「判定に使うホスト」を決める。
 * 優先順：開始したページ（referrer）→ 開いていたタブ → ファイル本体の URL。
 */
export function pickSourceHost({ referrer, tabUrl, finalUrl, url }) {
  return hostOf(referrer) || hostOf(tabUrl) || hostOf(finalUrl) || hostOf(url);
}
