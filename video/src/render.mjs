// HTML のアニメーションを 1 コマずつ撮って動画にする（Pi 上の Chromium ＋ ffmpeg）
//
// 使い方: node video/src/render.mjs <scene.html> <出力.mp4> [秒数] [fps]
// scene.html は window.__duration（秒）を持ち、CSS / Web Animations で動くページ。
// 撮影の前に window.__ready（Promise。画像の読み込みなど）を待つ。
// 各コマで document.getAnimations() の再生位置をそろえてから撮るので、処理速度に関係なく正確な動画になる。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , sceneArg, outArg, durArg, fpsArg] = process.argv;
if (!sceneArg || !outArg) {
  console.error('使い方: node render.mjs <scene.html> <出力.mp4> [秒数] [fps]');
  process.exit(1);
}
if (!existsSync(sceneArg)) {
  console.error(`見つかりません: ${sceneArg}`);
  process.exit(1);
}
const W = 1280, H = 720;
const fps = Number(fpsArg || 30);
const CDP_TIMEOUT = 30_000;

const prof = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'shimau-render-'));
let chrome, ws, ff;

// 子プロセスの終了を待つ（すでに終わっていればすぐ返る）
const exited = (p) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', r)));

try {
  // TMPDIR が長いとソケットのパスが長すぎて起動しないので、Chromium だけ /tmp を使う
  chrome = spawn('chromium', [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', `--user-data-dir=${prof}`, `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, TMPDIR: '/tmp' } });
  let chromeError = null;
  chrome.once('error', (e) => { chromeError = e; }); // 実行ファイルが無いときなど

  let port;
  for (let i = 0; i < 600 && !port; i++) { // 初回はプロファイル作成で時間がかかる
    if (chromeError) throw new Error(`Chromium を起動できませんでした: ${chromeError.message}`);
    if (chrome.exitCode !== null) throw new Error('Chromium が途中で終了しました');
    const f = join(prof, 'DevToolsActivePort');
    if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0];
    else await sleep(100);
  }
  if (!port) throw new Error(chromeError ? `Chromium を起動できませんでした: ${chromeError.message}` : 'Chromium が起動しませんでした');

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP に接続できませんでした')); });

  let seq = 0;
  const pending = new Map();
  const waiters = [];
  const failAll = (err) => {
    for (const { rej, timer } of pending.values()) { clearTimeout(timer); rej(err); }
    pending.clear();
    for (const w of waiters.splice(0)) w.reject(err);
  };
  ws.onclose = () => failAll(new Error('CDP の接続が切れました'));
  ws.onerror = () => failAll(new Error('CDP の接続でエラーが起きました'));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej, timer } = pending.get(d.id);
      pending.delete(d.id);
      clearTimeout(timer);
      d.error ? rej(new Error(d.error.message)) : res(d.result);
    } else if (d.method) {
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === d.method) waiters.splice(i, 1)[0].resolve(d.params);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP が応答しません: ${method}`)); }, CDP_TIMEOUT);
    pending.set(id, { res, rej, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitEvent = (method, ms) => new Promise((res, rej) => {
    const w = { method, resolve: (p) => { clearTimeout(t); res(p); }, reject: (e) => { clearTimeout(t); rej(e); } };
    const t = setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); rej(new Error(`${method} を待ちきれませんでした`)); }, ms);
    waiters.push(w);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS error');
    return r.result.value;
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const url = pathToFileURL(resolve(sceneArg)).href;
  const loaded = waitEvent('Page.loadEventFired', 30_000); // 移動する前から待つ（取りこぼさないように）
  loaded.catch(() => {}); // 移動に失敗して待たなくなっても、未処理のエラーにしない
  const nav = await send('Page.navigate', { url });
  if (nav.errorText) throw new Error(`読み込めませんでした: ${nav.errorText}`);
  await loaded;
  if ((await evaluate('location.href')) !== url) throw new Error('別のページが開いています');
  await evaluate('document.fonts.ready.then(() => true)');
  await evaluate('Promise.resolve(window.__ready).then(() => true)');
  await evaluate('Promise.all([...document.images].map((i) => i.decode().catch(() => 0))).then(() => true)');

  const duration = Number(durArg || (await evaluate('window.__duration || 0')));
  if (!(duration > 0)) throw new Error('window.__duration がありません');
  const frames = Math.round(duration * fps);
  console.log(`${sceneArg} → ${outArg}（${duration} 秒・${frames} コマ）`);

  // 撮った JPEG はフルレンジ（0–255）なので、動画用の範囲（16–235）に変換してから yuv420p にする
  ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-movflags', '+faststart', outArg,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  let ffError = null;
  let ffBroken; // ffmpeg が失敗・終了したら解ける（書き込み待ちを解くため）
  const broken = new Promise((r) => { ffBroken = r; });
  const ffDone = new Promise((res) => {
    ff.once('error', (e) => { ffError ??= e; res(); });
    ff.once('exit', (code, sig) => { if (code !== 0) ffError ??= new Error(`ffmpeg が失敗しました（${code ?? sig}）`); res(); });
  });
  ffDone.then(() => ffBroken());
  ff.stdin.on('error', (e) => { ffError ??= e; ffBroken(); });
  const write = (buf) => new Promise((res, rej) => {
    if (ffError) return rej(ffError);
    if (ff.stdin.write(buf)) return res();
    // 書き込みが詰まったら、空くか ffmpeg が終わるまで待つ
    let settled = false;
    const done = () => { if (settled) return; settled = true; ff.stdin.off('drain', done); ffError ? rej(ffError) : res(); };
    ff.stdin.once('drain', done);
    broken.then(done);
  });

  // 再生位置を止めてそろえる関数をページに入れる
  await evaluate(`window.__seek = (ms) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } if (window.__onSeek) window.__onSeek(ms); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }; true`);

  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    await evaluate(`window.__seek(${(i * 1000) / fps})`);
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
    await write(Buffer.from(data, 'base64'));
    if (i % fps === 0) process.stdout.write(`\r${Math.round((i / frames) * 100)}%`);
  }
  ff.stdin.end();
  await ffDone;
  if (ffError) throw ffError;
  console.log(`\r完了（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
} catch (e) {
  console.error(`\n失敗: ${e.message}`);
  process.exitCode = 1;
} finally {
  // 途中で失敗しても、Chromium・ffmpeg・一時フォルダを必ず片付ける
  try { ws?.close(); } catch {}
  if (ff && ff.exitCode === null) { ff.stdin.destroy(); ff.kill(); }
  if (chrome) { chrome.kill(); await exited(chrome); }
  if (ff) await exited(ff);
  rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
