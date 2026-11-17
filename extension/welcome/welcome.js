// はじめての設定：ヘルパーのダウンロード → インストール → つながったら最初のルールへ
import { ping } from '../lib/native.js';
import { paintIcons, svg } from '../ui/parts.js';

const $ = (id) => document.getElementById(id);
const RELEASE = 'https://github.com/tcaret2jp/shimau/releases/latest/download/';
const POLL_MS = 2000;

const GUIDE = {
  mac: {
    label: 'Mac 用をダウンロード',
    file: 'shimau-helper-mac.zip',
    lead: 'ダウンロードが終わったら、<b>ターミナル</b>を開いて次のコマンドを貼り付けて実行してください。',
    cmd: 'cd ~/Downloads && unzip -o shimau-helper-mac.zip -d shimau-helper && bash shimau-helper/install.sh',
    hint: 'ターミナルは Spotlight（⌘ + スペース）で「ターミナル」と入力すると開けます。',
  },
  win: {
    label: 'Windows 用をダウンロード',
    file: 'shimau-helper-windows.zip',
    lead: 'ダウンロードが終わったら、<b>PowerShell</b> を開いて次のコマンドを貼り付けて実行してください。',
    // 展開に失敗したら古いフォルダで入れてしまわないよう、途中で止める
    cmd: 'try { cd ~\\Downloads -ErrorAction Stop; Expand-Archive -Force shimau-helper-windows.zip shimau-helper -ErrorAction Stop; powershell -ExecutionPolicy Bypass -File .\\shimau-helper\\install.ps1 } catch { Write-Host $_ -ForegroundColor Red }',
    hint: 'PowerShell はスタートメニューで「PowerShell」と入力すると開けます。',
  },
};

let timer = null;
let busy = false;

async function init() {
  paintIcons();
  const { os } = await chrome.runtime.getPlatformInfo();
  const g = GUIDE[os === 'win' ? 'win' : 'mac'];
  $('dl').href = RELEASE + g.file;
  $('dl-label').textContent = g.label;
  $('dl-file').textContent = g.file;
  $('cmd-lead').innerHTML = g.lead;
  $('cmd').textContent = g.cmd;
  $('cmd-hint').textContent = g.hint;
  $('copy').onclick = () => copy(g.cmd);
  if (os !== 'mac' && os !== 'win') $('cmd-hint').textContent = 'このパソコンの OS には対応していません（Mac / Windows 用です）。';

  await check();
  document.addEventListener('visibilitychange', schedule);
}

async function copy(text) {
  const label = $('copy-label');
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = 'コピーしました';
  } catch {
    label.textContent = 'コピーできませんでした';
  }
  setTimeout(() => (label.textContent = 'コピー'), 1500);
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
}

init();
