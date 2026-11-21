// Chrome для лабораторных проверок на живом железе: WebUSB/Web Serial без Playwright.
// Управление — по CDP через --remote-debugging-pipe (fd 3/4, JSON через \0), зависимостей нет.
// Профиль постоянный: разрешение на USB-устройство Chrome хранит в профиле, поэтому выбор
// донгла делается один раз (`node tools/e2e-usb-sdr.mjs --grant`), дальше всё headless.
// Запуск статики — здесь же: COOP/COEP отдаются заголовками, и страница сразу crossOriginIsolated
// (без перезагрузки из-за сервис-воркера, которая рвёт открытый chooser).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  .find(p => fs.existsSync(p)) || 'google-chrome';

export function defaultProfile(){
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'dsp-lab', 'chrome');
}

// ---- CDP по pipe ----
export class CDP {
  constructor(proc){
    this.out = proc.stdio[3]; this.inp = proc.stdio[4];
    this.parts = []; this.id = 0; this.cbs = new Map(); this.listeners = new Set(); this.closed = false;
    this.inp.on('data', d => this._data(d));
    this.inp.on('error', e => this.fail(e));
    this.inp.on('end', () => this.fail(new Error('CDP pipe closed')));
    this.out.on('error', e => this.fail(e));
  }
  _emit(m){ for(const h of this.listeners) h(m); }
  // кадры — JSON + \0; куски копим, склеиваем только целое сообщение (не весь буфер на каждый chunk)
  _data(d){
    let off = 0;
    while(off < d.length){
      const i = d.indexOf(0, off);
      if(i < 0){ if(off < d.length) this.parts.push(d.subarray(off)); return; }
      if(i > off) this.parts.push(d.subarray(off, i));
      const raw = this.parts.length === 1 ? this.parts[0].toString('utf8') : Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this._msg(raw);
      off = i + 1;
    }
  }
  _msg(raw){
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }
    if(m.id && this.cbs.has(m.id)){
      const {res, rej} = this.cbs.get(m.id); this.cbs.delete(m.id);
      m.error ? rej(Object.assign(new Error(m.error.message || 'CDP error'), {cdp: m.error})) : res(m.result);
    }else this._emit(m);
  }
  on(fn){ this.listeners.add(fn); return () => this.listeners.delete(fn); }
  send(method, params = {}, sessionId){
    if(this.closed) return Promise.reject(new Error('CDP closed'));
    const id = ++this.id, m = {id, method, params};
    if(sessionId) m.sessionId = sessionId;
    this.out.write(JSON.stringify(m) + '\0');
    return new Promise((res, rej) => this.cbs.set(id, {res, rej}));
  }
  // все ждущие вызовы отклоняются: Chrome умер/pipe закрылся — вызывающий не должен зависнуть
  fail(err){
    if(this.closed) return;
    this.closed = true;
    for(const {rej} of this.cbs.values()) rej(err);
    this.cbs.clear();
  }
  close(){
    this.fail(new Error('CDP closed'));
    try{ this.out.end(); }catch(e){}
  }
}

export function launchChrome({headless = true, profile = defaultProfile(), extraArgs = [], log = false} = {}){
  fs.mkdirSync(profile, {recursive: true});
  // sandbox по умолчанию включён (в профиле лежит grant на USB); в контейнере без user namespaces
  // Chrome не стартует — тогда DSP_LAB_NO_SANDBOX=1
  const args = [
    '--remote-debugging-pipe', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--disable-default-apps', '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--password-store=basic', '--use-mock-keychain', '--window-size=1280,900', '--enable-unsafe-swiftshader',
    ...(process.env.DSP_LAB_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ...(headless ? ['--headless=new'] : []), ...extraArgs, 'about:blank',
  ];
  const proc = spawn(CHROME, args, {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  proc.stderr.on('data', d => {
    const s = String(d);
    if(log || /ERROR|FATAL|usb|USB|WebUSB|permission/.test(s)) process.stderr.write('[chrome] ' + s);
  });
  const cdp = new CDP(proc);
  proc.on('error', e => cdp.fail(e));
  proc.on('exit', code => { cdp._emit({method: '__exit', params: {code}}); cdp.fail(new Error('Chrome exited (' + code + ')')); });
  return {proc, cdp, profile};
}

export async function attachPage(cdp, url){
  const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
  const page = {targetId, sessionId, send: (method, params) => cdp.send(method, params, sessionId)};
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable').catch(() => {});
  if(url) await page.send('Page.navigate', {url});
  return page;
}

export async function evaluate(page, expression, {userGesture = false, awaitPromise = true} = {}){
  const r = await page.send('Runtime.evaluate', {expression, userGesture, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true});
  if(r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

// Открыть приложение без сервис-воркера (он кэширует файлы между прогонами и на первой
// установке перезагружает страницу — это рвёт открытый chooser USB).
export async function openApp(page, url, {waitIso = true} = {}){
  await page.send('Network.setBlockedURLs', {urls: ['*sw.js*']}).catch(() => {});
  await page.send('Page.navigate', {url});
  await page.send('Page.bringToFront').catch(() => {});
  for(let i = 0; i < 240; i++){
    const st = await evaluate(page, 'document.readyState + "|" + typeof addNode + "|" + window.crossOriginIsolated').catch(() => '');
    if(st.startsWith('complete|function|') && (!waitIso || st.endsWith('|true'))) return;
    await sleep(500);
  }
  throw new Error('the page did not become ready: ' + url);
}

// ---- статика с COOP/COEP ----
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.bin': 'application/octet-stream',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8'};

export function serve(root, port = 0){
  const base = path.resolve(root), within = base + path.sep;
  const server = http.createServer((req, res) => {
    let p;
    try{ p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch(e){ res.writeHead(400).end('bad request'); return; }        // GET /% — иначе URIError валит процесс
    if(p.endsWith('/')) p += 'index.html';
    // '.' + p: decodeURIComponent уже раскрыл %2f, поэтому .. снова стал ..  — пускаем только внутрь root
    const file = path.resolve(base, '.' + p);
    if(file !== base && !file.startsWith(within)){ res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
      if(err || !st.isFile()){ res.writeHead(404).end('not found'); return; }
      const h = {'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless',
        'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store, max-age=0', 'accept-ranges': 'bytes'};
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if(range){
        const a = range[1] ? +range[1] : 0, b = range[2] ? +range[2] : st.size - 1;
        if(!(a >= 0 && a <= b && b < st.size)){ res.writeHead(416, {'content-range': `bytes */${st.size}`}).end(); return; }
        res.writeHead(206, {...h, 'content-range': `bytes ${a}-${b}/${st.size}`, 'content-length': b - a + 1});
        const s = fs.createReadStream(file, {start: a, end: b}); s.on('error', () => res.destroy()); s.pipe(res);
      }else{
        res.writeHead(200, {...h, 'content-length': st.size});
        const s = fs.createReadStream(file); s.on('error', () => res.destroy()); s.pipe(res);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(r => server.close(r))}));
  });
}

// Разрешение на устройство: Chrome показывает chooser, человек один раз выбирает донгл.
// Вернуть {usbId, productName} и сохранить рядом с профилем — дальше Connect без окна.
export async function grantDevice(page, {filters = [], file, timeout = 180} = {}){
  const p = evaluate(page,
    `navigator.usb.requestDevice({filters:${JSON.stringify(filters)}}).then(d=>JSON.stringify({usbId:d.vendorId.toString(16)+':'+d.productId.toString(16)+':'+(d.serialNumber||''),productName:d.productName,vid:d.vendorId,pid:d.productId})).catch(e=>'ERR '+e.name+': '+e.message)`,
    {userGesture: true});
  const r = timeout > 0
    ? await Promise.race([p, sleep(timeout * 1000).then(() => { throw new Error('timeout: no device chosen in ' + timeout + ' s'); })])
    : await p;
  if(String(r).startsWith('ERR')) throw new Error(r);
  const dev = JSON.parse(r);
  if(file) fs.mkdirSync(path.dirname(file), {recursive: true}), fs.writeFileSync(file, JSON.stringify(dev, null, 1) + '\n');
  return dev;
}
