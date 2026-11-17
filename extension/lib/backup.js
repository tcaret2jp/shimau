// JSON エクスポート／インポート（純粋関数）
import { normalizeDomain } from './domain.js';

export const BACKUP_FORMAT = 'shimau';

export function buildExport({ rules, dests }, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    rules: rules.map(({ id, domain, destId, includeSubdomains, enabled }) => ({ id, domain, destId, includeSubdomains, enabled })),
    dests: dests.map(({ id, name, paths }) => ({ id, name, paths: { mac: paths?.mac || '', win: paths?.win || '' } })),
  };
}

/** 読み込んだ JSON を検証して整形する。不正なら Error を投げる。 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON として読み込めませんでした');
  }
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.rules) || !Array.isArray(data.dests)) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  const dests = data.dests
    .filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string')
    .map((d) => ({
      id: d.id,
      name: d.name.trim().slice(0, 60) || '名前なし',
      paths: { mac: str(d.paths?.mac), win: str(d.paths?.win) },
    }));
  const destIds = new Set(dests.map((d) => d.id));
  // 同じ id の保存先が複数あると、ルールの行き先が黙って変わってしまうので受け付けない
  if (destIds.size !== dests.length) throw new Error('保存先の id が重複しています（ファイルが壊れている可能性があります）');
  const rules = [];
  for (const r of data.rules) {
    const domain = normalizeDomain(r?.domain);
    if (!domain || !destIds.has(r.destId)) continue;
    rules.push({
      id: typeof r.id === 'string' ? r.id : null,
      domain,
      destId: r.destId,
      includeSubdomains: r.includeSubdomains !== false,
      enabled: r.enabled !== false,
    });
  }
  return { rules, dests };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 取り込み前に「追加 / 上書き」の件数を数える。 */
export function previewMerge(current, incoming) {
  const domains = new Set(current.rules.map((r) => r.domain));
  const conflicts = incoming.rules.filter((r) => domains.has(r.domain)).length;
  return { added: incoming.rules.length - conflicts, conflicts, dests: incoming.dests.length };
}

/**
 * 取り込む。
 * - 保存先：同じ id は上書き（空のパスは今の値を残す＝相手の OS 側パスを消さない）、なければ追加
 * - ルール：同じドメインは overwrite=true なら置き換え、false なら今のものを残す
 */
export function mergeImport(current, incoming, { overwrite, newId }) {
  const dests = current.dests.map((d) => ({ ...d, paths: { ...d.paths } }));
  for (const inc of incoming.dests) {
    const ex = dests.find((d) => d.id === inc.id);
    if (ex) {
      ex.name = inc.name;
      if (inc.paths.mac) ex.paths.mac = inc.paths.mac;
      if (inc.paths.win) ex.paths.win = inc.paths.win;
    } else {
      dests.push({ id: inc.id, name: inc.name, paths: { ...inc.paths } });
    }
  }
  const rules = current.rules.map((r) => ({ ...r }));
  for (const inc of incoming.rules) {
    const i = rules.findIndex((r) => r.domain === inc.domain);
    if (i >= 0) {
      if (overwrite) rules[i] = { ...inc, id: rules[i].id };
    } else {
      rules.push({ ...inc, id: inc.id && !rules.some((r) => r.id === inc.id) ? inc.id : newId() });
    }
  }
  return { rules, dests };
}
