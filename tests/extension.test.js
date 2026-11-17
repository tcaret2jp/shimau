// 拡張機能の純粋関数のテスト：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, normalizeDomain, findRule, pickSourceHost, ruleMatches, siteDomain } from '../extension/lib/domain.js';
import { detectKind } from '../extension/lib/kinds.js';
import { buildExport, parseImport, previewMerge, mergeImport } from '../extension/lib/backup.js';

test('hostOf', () => {
  assert.equal(hostOf('https://Drive.Google.com/x?y'), 'drive.google.com');
  assert.equal(hostOf('http://example.com.:8080/'), 'example.com');
  assert.equal(hostOf('chrome://settings'), null);
  assert.equal(hostOf('file:///tmp/a'), null);
  assert.equal(hostOf(''), null);
  assert.equal(hostOf('not a url'), null);
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('  drive.google.com '), 'drive.google.com');
  assert.equal(normalizeDomain('日本語.jp'), 'xn--wgv71a119e.jp');
  assert.equal(normalizeDomain('localhost'), 'localhost');
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('a b.com'), null);
  assert.equal(normalizeDomain('-bad.com'), null);
});

const rules = [
  { id: '1', domain: 'google.com', includeSubdomains: true, enabled: true, destId: 'a' },
  { id: '2', domain: 'drive.google.com', includeSubdomains: true, enabled: true, destId: 'b' },
  { id: '3', domain: 'github.com', includeSubdomains: false, enabled: true, destId: 'c' },
  { id: '4', domain: 'archive.org', includeSubdomains: true, enabled: false, destId: 'd' },
];

test('findRule：より具体的なドメインを優先', () => {
  assert.equal(findRule(rules, 'drive.google.com').id, '2');
  assert.equal(findRule(rules, 'docs.drive.google.com').id, '2');
  assert.equal(findRule(rules, 'mail.google.com').id, '1');
  assert.equal(findRule(rules, 'google.com').id, '1');
});

test('findRule：完全一致のみ・www・OFF', () => {
  assert.equal(findRule(rules, 'github.com').id, '3');
  assert.equal(findRule(rules, 'www.github.com').id, '3');
  assert.equal(findRule(rules, 'gist.github.com'), null);
  assert.equal(findRule(rules, 'archive.org'), null);
  assert.equal(findRule(rules, 'archive.org', { onlyEnabled: false }).id, '4');
});

test('findRule：似た名前に一致しない', () => {
  assert.equal(findRule(rules, 'notgoogle.com'), null);
  assert.equal(findRule(rules, 'google.com.evil.net'), null);
  assert.equal(ruleMatches(rules[0], null), false);
});

test('pickSourceHost：referrer → タブ → ファイルURL', () => {
  assert.equal(pickSourceHost({ referrer: 'https://drive.google.com/', url: 'https://doc-0s.googleusercontent.com/x' }), 'drive.google.com');
  assert.equal(pickSourceHost({ referrer: '', tabUrl: 'https://notion.so/p', url: 'https://s3.amazonaws.com/f' }), 'notion.so');
  assert.equal(pickSourceHost({ referrer: '', tabUrl: 'chrome://newtab', finalUrl: 'https://github.com/a.zip', url: 'https://x.com/r' }), 'github.com');
  assert.equal(siteDomain('www.example.com'), 'example.com');
});

test('detectKind', () => {
  assert.equal(detectKind('~/Library/CloudStorage/GoogleDrive-a@b.com/マイドライブ/大学'), 'drive');
  assert.equal(detectKind('G:\\マイドライブ\\大学'), 'drive');
  assert.equal(detectKind('G:\\My Drive\\x'), 'drive');
  assert.equal(detectKind('~/Library/CloudStorage/Dropbox/資料'), 'dropbox');
  assert.equal(detectKind('C:\\Users\\t\\Dropbox\\資料'), 'dropbox');
  assert.equal(detectKind('/Volumes/T7/動画'), 'ssd');
  assert.equal(detectKind('E:\\動画'), 'ssd');
  assert.equal(detectKind('C:\\Users\\t\\Documents'), 'local');
  assert.equal(detectKind('~/Developer'), 'local');
  assert.equal(detectKind(''), 'local');
});

test('バックアップ：書き出し→読み込みで元に戻る', () => {
  const S = {
    rules: [{ id: 'r1', domain: 'notion.so', destId: 'd1', includeSubdomains: false, enabled: true, extra: 'x' }],
    dests: [{ id: 'd1', name: '資料', paths: { mac: '/m', win: '' } }],
  };
  const out = buildExport(S, new Date('2026-11-17T00:00:00Z'));
  const back = parseImport(JSON.stringify(out));
  assert.deepEqual(back.rules, [{ id: 'r1', domain: 'notion.so', destId: 'd1', includeSubdomains: false, enabled: true }]);
  assert.deepEqual(back.dests, [{ id: 'd1', name: '資料', paths: { mac: '/m', win: '' } }]);
});

test('バックアップ：不正なファイル', () => {
  assert.throws(() => parseImport('{'), /JSON/);
  assert.throws(() => parseImport('{"rules":[]}'), /バックアップファイルではありません/);
  const bad = parseImport(
    JSON.stringify({ format: 'shimau', rules: [{ domain: 'a b', destId: 'd' }, { domain: 'ok.com', destId: 'missing' }], dests: [{ id: 'd', name: 'x' }] }),
  );
  assert.equal(bad.rules.length, 0);
});

test('バックアップ：取り込み（OS 別パスを消さない・上書き選択）', () => {
  let n = 0;
  const newId = () => 'new' + ++n;
  const cur = {
    rules: [{ id: 'a', domain: 'x.com', destId: 'd1', includeSubdomains: true, enabled: true }],
    dests: [{ id: 'd1', name: 'Drive', paths: { mac: '/mac/drive', win: '' } }],
  };
  const inc = {
    rules: [
      { id: 'b', domain: 'x.com', destId: 'd2', includeSubdomains: false, enabled: true },
      { id: 'c', domain: 'y.com', destId: 'd1', includeSubdomains: true, enabled: true },
    ],
    dests: [
      { id: 'd1', name: 'Drive', paths: { mac: '', win: 'G:\\drive' } },
      { id: 'd2', name: 'SSD', paths: { mac: '', win: 'E:\\' } },
    ],
  };
  assert.deepEqual(previewMerge(cur, inc), { added: 1, conflicts: 1, dests: 2 });
  const keep = mergeImport(cur, inc, { overwrite: false, newId });
  assert.deepEqual(keep.dests[0].paths, { mac: '/mac/drive', win: 'G:\\drive' });
  assert.equal(keep.rules.find((r) => r.domain === 'x.com').destId, 'd1');
  assert.equal(keep.rules.length, 2);
  const over = mergeImport(cur, inc, { overwrite: true, newId });
  const x = over.rules.find((r) => r.domain === 'x.com');
  assert.equal(x.destId, 'd2');
  assert.equal(x.id, 'a'); // 既存の id は保つ
  assert.equal(cur.dests[0].paths.win, ''); // 元のデータは変更しない
});
