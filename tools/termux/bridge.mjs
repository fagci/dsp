#!/usr/bin/env node
// Мост Termux → браузер: датчики, GPS, батарея, Wi-Fi и соты телефона по WebSocket (JSON-записи).
//
// Установка (Termux + приложение Termux:API из F-Droid, разрешения на геолокацию и датчики):
//   pkg install nodejs termux-api
// Запуск:
//   node bridge.mjs                       только этот телефон: ws://127.0.0.1:8765
//   node bridge.mjs --host 0.0.0.0 --token секрет     и для других устройств: ws://IP:8765/?token=секрет
// Узел Termux в приложении сам выбирает, какие источники нужны (сообщение {"sub":[…]});
// обычный Text over Network получает то, что задано в --sources.
//
// Записи: {src:'gps'|'battery'|'sensor'|'wifi'|'cell'|'bridge', …}, см. SOURCES ниже.
//
// Пины наружу (узлы Pins Out / Pins In / Pins (custom) страниц DSP; без termux тоже работает — на ноутбуке: node bridge.mjs --sources ''):
//   страница: url = ws://host:8765 (она сама шлёт {t:'hello',role:'graph'}); страницы получают пины друг друга, внешние клиенты — тоже
//   ws://host:8765/raw/ИМЯ   только данные пина, без заголовка: float32 (sig, спектр), float32 I,Q,I,Q… (iq), UTF-8 JSON (числа, текст, записи)
//                            websocat -b ws://127.0.0.1:8765/raw/chan1 | …
//   ws://host:8765/          кадры с заголовком (modules/pins-kernels.js); {t:'sub',names:['a','*']} подписывает, {t:'pins'} просит список,
//                            {t:'set',name:'tune',v:100.5e6} подаёт значение на Pins In, бинарный кадр с тем же именем — поток,
//                            {t:'make',name:'x',dir:'pub'|'sub'} создаёт пин в узле Pins (custom) страницы
//   GET http://host:8765/pins   список пинов: {out:[{name,kind,fc,sr}], in:[{name}]}
// Тот же протокол у моста приложения Android (PinRelay.kt).
// Страницы чужих сайтов тоже могут открыть ws://127.0.0.1 — поэтому Origin проверяется (--origin).

import http from 'node:http';
import crypto from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const DEFAULT_ORIGINS = ['https://fagci.github.io'];
const SENSORS = ['accel', 'gyro', 'mag', 'light', 'pressure', 'proximity', 'gravity', 'linear', 'rotation', 'steps'];

// ---------- разбор потоков ----------

// termux-sensor и termux-location -r updates печатают подряд pretty-printed JSON-объекты: режем по глубине скобок
export function jsonStream(onObj) {
  let buf = '', pos = 0, depth = 0, start = -1, str = false, esc = false;
  return chunk => {
    buf += chunk;
    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') { if (depth > 0) str = true; }
      else if (c === '{' || c === '[') { if (depth++ === 0) start = pos; }
      else if (c === '}' || c === ']') {
        if (depth > 0 && --depth === 0) {
          try { onObj(JSON.parse(buf.slice(start, pos + 1))); } catch (e) { /* битый кусок — пропускаем */ }
          buf = buf.slice(pos + 1); pos = -1; start = -1;
        }
      }
    }
    if (depth === 0) { buf = ''; pos = 0; }
  };
}

// имя датчика Android («LSM6DSO Accelerometer») → короткий вид
export function sensorKind(name) {
  const s = String(name).toLowerCase();
  if (/uncalibrated|wake.?up/.test(s) && /gyro|accel|magnet/.test(s)) return null;
  if (/linear/.test(s)) return 'linear';
  if (/gravity/.test(s)) return 'gravity';
  if (/rotation/.test(s)) return 'rotation';
  if (/gyro/.test(s)) return 'gyro';
  if (/magnet/.test(s)) return 'mag';
  if (/accel/.test(s)) return 'accel';
  if (/light/.test(s)) return 'light';
  if (/pressure|baro/.test(s)) return 'pressure';
  if (/proximity/.test(s)) return 'proximity';
  if (/step/.test(s)) return 'steps';
  return null;
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : undefined);
const clean = o => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

export function sensorRecs(obj) {
  const out = [];
  for (const [name, d] of Object.entries(obj || {})) {
    const kind = sensorKind(name), v = d && d.values;
    if (!kind || !Array.isArray(v)) continue;
    out.push(clean({src: 'sensor', sensor: kind, name, x: num(v[0]), y: num(v[1]), z: num(v[2]), values: v}));
  }
  return out;
}

export function gpsRec(o) {
  if (!o || num(o.latitude) === undefined || num(o.longitude) === undefined) return null;
  return clean({src: 'gps', id: 'me', provider: o.provider, lat: o.latitude, lon: o.longitude, alt: num(o.altitude),
    acc: num(o.accuracy), vacc: num(o.vertical_accuracy), speed: num(o.speed), bearing: num(o.bearing), age_ms: num(o.elapsedMs)});
}

export function batteryRec(o) {
  if (!o || num(o.percentage) === undefined) return null;
  return clean({src: 'battery', pct: o.percentage, status: o.status, plugged: o.plugged, health: o.health,
    temp: num(o.temperature), current: num(o.current)});
}

// termux-wifi-scaninfo: [{bssid, ssid, rssi, frequency_mhz, timestamp, …}]; fix — последние координаты (или null)
export function wifiRecs(list, fix) {
  if (!Array.isArray(list)) return [];
  const ts = list.map(a => Number(a.timestamp)).filter(isFinite), last = ts.length ? Math.max(...ts) : 0;
  const out = [];
  for (const a of list) {
    if (!a || !a.bssid || num(a.rssi) === undefined) continue;
    const t = Number(a.timestamp);
    if (last && isFinite(t) && last - t > 3e6) continue;       // термукс отдаёт кэш: старые сканы (> 3 с по µs) отбрасываем
    out.push(clean({src: 'wifi', bssid: a.bssid, ssid: a.ssid || '', rssi: a.rssi, freq: num(a.frequency_mhz),
      lat: fix?.lat, lon: fix?.lon, acc: fix?.acc}));
  }
  return out;
}

// termux-telephony-cellinfo: [{type, registered, …вложенные поля}] → плоские записи
export function cellRecs(list) {
  if (!Array.isArray(list)) return [];
  return list.map(c => {
    const r = {src: 'cell'};
    for (const [k, v] of Object.entries(c || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k2, v2] of Object.entries(v)) if (typeof v2 !== 'object') r[k2] = v2; }
      else if (typeof v !== 'object') r[k] = v;
    }
    return r;
  });
}

// ---------- WebSocket (минимум RFC 6455: текстовые кадры, ping, close) ----------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function wsAccept(key) { return crypto.createHash('sha1').update(key + WS_GUID).digest('base64'); }

export function wsFrame(text, op = 1) {
  const p = Buffer.from(text), n = p.length;
  const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x80 | op, 127, 0, 0, 0, 0]), Buffer.from([n >>> 24, n >>> 16, n >>> 8, n].map(x => x & 255))]);
  return Buffer.concat([h, p]);
}

// разбор кадров клиента (всегда с маской); onMsg(text), onClose(), onPing(payload); onBin(buf) — если задан, бинарные сообщения идут в него как есть
const LE = new Uint32Array(new Uint8Array([1, 2, 3, 4]).buffer)[0] === 0x04030201;
// снять маску с pl на месте: по 4 байта за раз (pl — свой ArrayBuffer с нуля, см. allocUnsafeSlow), хвост — по байту
function unmask(pl, mask) {
  const n = pl.length;
  let i = 0;
  if (LE && n >= 64) {
    const w = new Uint32Array(pl.buffer, pl.byteOffset, n >> 2), m = (mask[0] | mask[1] << 8 | mask[2] << 16 | mask[3] << 24) >>> 0;
    for (let k = 0; k < w.length; k++) w[k] ^= m;
    i = w.length << 2;
  }
  for (; i < n; i++) pl[i] ^= mask[i & 3];
}
export function wsParser({onMsg, onBin, onClose, onPing}) {
  let buf = Buffer.alloc(0), parts = null, have = 0, need = 0, msg = [], mop = 1;
  return chunk => {
    // кадр длиннее одного куска сокета (64 КБ): куски копим в списке и склеиваем один раз, когда набралось нужное — иначе каждый кусок
    // заново копирует весь накопленный буфер (кадр в 512 КБ копировался ~4 раза)
    if (need && have + chunk.length < need) { parts.push(chunk); have += chunk.length; return; }
    buf = parts ? Buffer.concat([...parts, chunk]) : buf.length ? Buffer.concat([buf, chunk]) : chunk;
    parts = null; have = 0; need = 0;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); o = 10; }
      if (len > 1 << 20) { onClose(); return; }
      const total = o + (masked ? 4 : 0) + len;
      if (buf.length < total) { if (len >= 4096) { parts = [buf]; have = buf.length; need = total; } return; }
      const mask = masked ? buf.subarray(o, o + 4) : null; o += masked ? 4 : 0;
      const pl = len >= 64 ? Buffer.allocUnsafeSlow(len) : Buffer.allocUnsafe(len);
      buf.copy(pl, 0, o, o + len);
      if (mask) unmask(pl, mask);
      buf = buf.subarray(o + len);
      if (op === 8) { onClose(); return; }
      if (op === 9) { onPing(pl); continue; }
      if (op === 1 || op === 2 || op === 0) {
        if (op) mop = op;
        msg.push(pl);
        if (fin) { const all = msg.length === 1 ? msg[0] : Buffer.concat(msg); msg = []; if (mop === 2 && onBin) onBin(all); else onMsg(all.toString()); }
      }
    }
  };
}

export function originOk(origin, allowed) {
  if (!origin) return true;                                  // не браузер (websocat, curl)
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try { return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(origin).hostname); } catch (e) { return false; }
}

// ---------- пины наружу ----------
// Ретранслятор кадров по имени пина, как PinRelay.kt в приложении Android. Кадры не разбираются: смотрим только имя в заголовке
// ([kind u8][длина имени u8][0 0][fc f64][sr f64][seq u32][имя, добор до кратного 4][данные], см. modules/pins-kernels.js).
// Участник (peer): {text(s), bin(buf), graph, subs:Set, pins:{out,in}, raw, greeted}.
export const PIN_VER = 2;                               // 2: страницы получают пины друг друга (graph ↔ graph), {t:'make'}, версия в ответе
const pinHdr = nl => 24 + ((nl + 3) & ~3);
export function pinJsonFrame(name, v) {                 // кадр json (kind 5): так {t:'set'} доходит до Pins In страницы
  const nb = Buffer.from(String(name).slice(0, 64)), body = Buffer.from(JSON.stringify(v === undefined ? null : v)), hl = pinHdr(nb.length);
  const f = Buffer.alloc(hl + body.length); f[0] = 5; f[1] = nb.length; nb.copy(f, 24); body.copy(f, hl);
  return f;
}
export function createPinRelay(log = () => {}) {
  const peers = new Set();
  const graphs = () => [...peers].filter(p => p.graph);
  const list = skip => {                                // пины всех страниц, кроме самой `skip` (свои она знает)
    const out = [], inn = [];
    for (const g of graphs()) if (g !== skip) { out.push(...g.pins.out); inn.push(...g.pins.in); }
    return {out, in: inn};
  };
  const listMsg = p => JSON.stringify({t: 'pins', ...list(p)});
  const announce = () => { for (const p of peers) if (!p.raw) p.text(listMsg(p)); };
  const wantNames = skip => {                           // что просят остальные (клиенты и другие страницы): страница шлёт только это
    const s = new Set(); for (const p of peers) if (p !== skip) for (const n of p.subs) s.add(n);
    return s.has('*') ? ['*'] : [...s];
  };
  const sendWant = g => g.text(JSON.stringify({t: 'want', names: wantNames(g)}));
  const wantAll = () => { for (const g of graphs()) sendWant(g); };
  const names = a => (Array.isArray(a) ? a.slice(0, 256) : []);
  return {
    list,
    add(p) { peers.add(p); if (p.raw) { p.subs = new Set([p.raw]); wantAll(); } else p.text(listMsg(p)); },
    remove(p) {
      if (!peers.delete(p)) return;
      log((p.graph ? 'page' : 'client') + ' left');
      if (p.graph) announce();
      wantAll();                                        // подписки ушедшего (клиента или Pins In страницы) пропали
    },
    text(p, m) {
      if (!p.greeted) { p.greeted = true; p.text(JSON.stringify({t: 'bridge', ver: PIN_VER, impl: 'node'})); }   // страница видит, что мост не старый
      if (m.t === 'hello' && m.role === 'graph' && !p.raw) {
        p.graph = true; p.pins = {out: [], in: []}; p.subs = new Set(); log('page joined as graph (' + (p.origin || 'no Origin') + ')'); sendWant(p); announce();
      } else if (m.t === 'sub' && Array.isArray(m.names)) {          // подписка: и клиента, и другой страницы (её Pins In)
        p.subs = new Set(m.names.map(String).filter(Boolean).slice(0, 256)); log((p.graph ? 'page' : 'client') + ' subscribes: ' + ([...p.subs].join(', ') || '—')); wantAll();
      } else if (m.t === 'pins') {
        if (p.graph) {
          p.pins = {out: names(m.out), in: names(m.in)};
          log('page offers: ' + (p.pins.out.map(x => x.name).join(', ') || '—') + ' · takes: ' + (p.pins.in.map(x => x.name).join(', ') || '—')); announce();
        } else p.text(listMsg(p));
      } else if (m.t === 'make' && !p.graph && typeof m.name === 'string' && m.name && (m.dir === 'pub' || m.dir === 'sub')) {
        const t = JSON.stringify({t: 'make', name: m.name, dir: m.dir});   // «создай пин в узле Pins»: pub — клиент отдаёт, sub — хочет получать
        for (const g of graphs()) g.text(t);
      } else if (m.t === 'set' && !p.graph && !p.raw && typeof m.name === 'string' && m.name) {
        const f = pinJsonFrame(m.name, m.v);
        for (const g of graphs()) g.bin(f);
      }
    },
    binary(p, f) {
      if (f.length < 24 || f.length < pinHdr(f[1])) return;
      if (!p.graph) { for (const g of graphs()) g.bin(f); return; }   // от клиента — на входы страниц
      const name = f.toString('utf8', 24, 24 + f[1]), hl = pinHdr(f[1]);
      for (const k of peers) if (k !== p && (k.subs.has(name) || k.subs.has('*'))) k.bin(k.raw ? f.subarray(hl) : f);
    },
  };
}
const PIN_MAX_BACKLOG = 4 << 20;                        // сколько байт может висеть в сокете медленного клиента, дальше кадры выбрасываем
// участник ретрансляции для соединения c = {sock, dead}: общий для этого моста и tools/node/bridge.mjs
export function makePinPeer(c, origin = '') {
  const {sock} = c;
  return {
    graph: false, subs: new Set(), pins: {out: [], in: []}, raw: '', greeted: false, origin,
    text: t => { if (!c.dead) try { sock.write(wsFrame(t)); } catch (e) { c.dead = true; } },
    bin: b => { if (!c.dead && sock.writableLength < PIN_MAX_BACKLOG) try { sock.write(wsFrame(b, 2)); } catch (e) { c.dead = true; } },   // клиент не успевает — старое не копим
  };
}

// ---------- мост ----------

export function createBridge(opt) {
  const o = {host: '127.0.0.1', port: 8765, token: '', origins: DEFAULT_ORIGINS, sources: ['gps', 'battery'], provider: 'gps',
    sensorDelay: 200, batteryEvery: 30, wifiEvery: 10, cellEvery: 10, log: () => {}, ...opt};
  const clients = new Set();
  const pins = createPinRelay(m => o.log(m));
  const running = new Map();                                 // источник → {stop()}
  let fix = null, fixAt = 0;

  const send = (c, rec) => { if (!c.dead) try { c.sock.write(wsFrame(JSON.stringify(rec))); } catch (e) { c.dead = true; } };
  const emit = (src, rec) => {
    if (src === 'gps') { fix = {lat: rec.lat, lon: rec.lon, acc: rec.acc}; fixAt = Date.now(); }
    for (const c of clients) if (c.subs.has(src)) send(c, rec);
  };
  const note = (msg, level = 'info') => { const r = {src: 'bridge', level, msg}; o.log(level + ': ' + msg); for (const c of clients) if (!c.pin?.raw) send(c, r); };   // /raw/ИМЯ получает только данные пина

  // подписка клиента: gps, battery, wifi, cell, а также accel gyro mag light pressure proximity gravity linear rotation steps
  const wanted = () => {
    const s = new Set();
    for (const c of clients) for (const x of c.subs) s.add(x);
    return s;
  };

  function streamProc(cmd, args, onObj, name) {
    const p = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    const feed = jsonStream(onObj);
    p.stdout.setEncoding('utf8'); p.stdout.on('data', feed);
    p.stderr.on('data', d => note(name + ': ' + String(d).trim().slice(0, 200), 'warn'));
    p.on('error', e => note(name + ': ' + (e.code === 'ENOENT' ? 'command not found (pkg install termux-api)' : e.message), 'error'));
    return {stop() { p.removeAllListeners(); try { p.kill(); } catch (e) { /* уже завершён */ } }};
  }
  function pollProc(cmd, args, every, onObj, name) {
    let timer = null, dead = false;
    const tick = () => execFile(cmd, args, {timeout: 20000}, (err, out) => {
      if (dead) return;
      if (err) note(name + ': ' + (err.code === 'ENOENT' ? 'command not found (pkg install termux-api)' : err.message.split('\n')[0]), 'error');
      else try { onObj(JSON.parse(out)); } catch (e) { note(name + ': bad output', 'warn'); }
      timer = setTimeout(tick, Math.max(1, every) * 1000);
    });
    tick();
    return {stop() { dead = true; clearTimeout(timer); }};
  }

  const start = {
    gps: () => streamProc('termux-location', ['-p', o.provider, '-r', 'updates'], j => { const r = gpsRec(j); if (r) emit('gps', r); }, 'termux-location'),
    battery: () => pollProc('termux-battery-status', [], o.batteryEvery, j => { const r = batteryRec(j); if (r) emit('battery', r); }, 'termux-battery-status'),
    wifi: () => pollProc('termux-wifi-scaninfo', [], o.wifiEvery, j => {
      const f = fix && Date.now() - fixAt < 30000 ? fix : null;
      for (const r of wifiRecs(j, f)) emit('wifi', r);
    }, 'termux-wifi-scaninfo'),
    cell: () => pollProc('termux-telephony-cellinfo', [], o.cellEvery, j => { for (const r of cellRecs(j)) emit('cell', r); }, 'termux-telephony-cellinfo'),
  };

  // termux-sensor один на всех: набор датчиков — объединение подписок, при изменении процесс перезапускается
  let sensorKey = '';
  function syncSensors(w) {
    const names = SENSORS.filter(s => w.has(s)), key = names.join(',');
    if (key === sensorKey) return;
    sensorKey = key; running.get('sensor')?.stop(); running.delete('sensor');
    if (!names.length) return;
    const want = new Set(names);
    const pat = {accel: 'accel', gyro: 'gyro', mag: 'magnet', light: 'light', pressure: 'pressure', proximity: 'proximity',
      gravity: 'gravity', linear: 'linear', rotation: 'rotation', steps: 'step'};
    running.set('sensor', streamProc('termux-sensor', ['-s', names.map(n => pat[n]).join(','), '-d', String(o.sensorDelay)],
      j => { for (const r of sensorRecs(j)) if (want.has(r.sensor)) emit(r.sensor, r); }, 'termux-sensor'));
  }
  function sync() {
    const w = wanted();
    for (const s of Object.keys(start)) {
      if (w.has(s) && !running.has(s)) running.set(s, start[s]());
      else if (!w.has(s) && running.has(s)) { running.get(s).stop(); running.delete(s); }
    }
    syncSensors(w);
  }

  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/pins') { res.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'}); res.end(JSON.stringify(pins.list(null))); return; }
    res.writeHead(200, {'content-type': 'text/plain'});
    res.end('DSP Termux bridge: ' + clients.size + ' client(s), sources: ' + [...wanted()].join(', ') + ', pins v' + PIN_VER + '\nconnect with WebSocket\n');
  });
  server.on('upgrade', (req, sock) => {
    const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
    const deny = code => { sock.end('HTTP/1.1 ' + code + '\r\nconnection: close\r\n\r\n'); };
    if (!key || /websocket/i.test(req.headers.upgrade || '') === false) return deny('400 Bad Request');
    if (!originOk(req.headers.origin, o.origins)) { o.log('origin refused: ' + req.headers.origin); return deny('403 Forbidden'); }
    if (o.token && u.searchParams.get('token') !== o.token) return deny('401 Unauthorized');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(key) + '\r\n\r\n');
    // источники: ?sources=a,b (пустой — никаких, так подключаются узлы Pins), /raw/ИМЯ — никаких; иначе --sources
    const raw = /^\/raw\/(.+)$/.exec(u.pathname);
    const c = {sock, subs: new Set(raw ? [] : u.searchParams.has('sources') ? u.searchParams.get('sources').split(',').map(x => x.trim()).filter(Boolean) : o.sources), dead: false, pin: null};
    const peer = () => c.pin || (c.pin = makePinPeer(c, req.headers.origin || ''));
    clients.add(c);
    if (raw) { const p = peer(); try { p.raw = decodeURIComponent(raw[1]); } catch (e) { p.raw = raw[1]; } pins.add(p); }
    const bye = () => { if (clients.delete(c)) { c.dead = true; if (c.pin) pins.remove(c.pin); sync(); } };
    const par = wsParser({
      onBin: b => { if (c.pin) pins.binary(c.pin, b); },
      onMsg: t => {
        let m; try { m = JSON.parse(t); } catch (e) { return; }
        if (typeof m?.t === 'string') {                          // пины: первое такое сообщение делает соединение участником
          const fresh = !c.pin, p = peer(); if (fresh) pins.add(p);
          pins.text(p, m); return;
        }
        if (Array.isArray(m?.sub)) { c.subs = new Set(m.sub.map(String)); sync(); send(c, {src: 'bridge', level: 'info', msg: 'sub: ' + [...c.subs].join(',')}); }
      },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) { /* закрыт */ } bye(); },
      onPing: p => { try { sock.write(wsFrame(p.toString(), 10)); } catch (e) { /* закрыт */ } },
    });
    sock.on('data', par); sock.on('close', bye); sock.on('error', bye);
    if (!raw) send(c, {src: 'bridge', level: 'hello', ver: 1, host: os.hostname(), sources: Object.keys(start), sensors: SENSORS});
    sync();
  });

  return {
    server, clients, running,
    listen: () => new Promise((ok, bad) => { server.once('error', bad); server.listen(o.port, o.host, () => ok(server.address())); }),
    close: () => { for (const r of running.values()) r.stop(); running.clear(); for (const c of clients) c.sock.destroy(); server.close(); },
  };
}

// ---------- CLI ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const {values: a} = parseArgs({options: {
    host: {type: 'string', default: '127.0.0.1'}, port: {type: 'string', default: '8765'},
    token: {type: 'string', default: ''}, origin: {type: 'string', multiple: true, default: []},
    sources: {type: 'string', default: 'gps,battery'}, provider: {type: 'string', default: 'gps'},
    'sensor-delay': {type: 'string', default: '200'}, help: {type: 'boolean', short: 'h', default: false},
  }});
  if (a.help) {
    console.log('node bridge.mjs [--host 127.0.0.1] [--port 8765] [--token T] [--origin URL]… [--sources gps,battery,accel,gyro,mag,light,pressure,wifi,cell] [--provider gps|network|passive] [--sensor-delay ms]');
    process.exit(0);
  }
  if (a.host !== '127.0.0.1' && a.host !== 'localhost' && !a.token) console.error('warning: open to the network without --token — anyone on it can read the phone\'s location');
  const b = createBridge({host: a.host, port: +a.port, token: a.token, origins: [...DEFAULT_ORIGINS, ...a.origin],
    sources: a.sources.split(',').map(s => s.trim()).filter(Boolean), provider: a.provider, sensorDelay: +a['sensor-delay'] || 200,
    log: m => console.error(new Date().toISOString().slice(11, 19) + ' ' + m)});
  b.listen().then(ad => {
    console.error('listening on ws://' + ad.address + ':' + ad.port + (a.token ? '/?token=…' : '') + ' (sensors, pins v' + PIN_VER + ')');
    if (a.host === '0.0.0.0') for (const l of Object.values(os.networkInterfaces()).flat()) if (l && l.family === 'IPv4' && !l.internal) console.error('  from other devices: ws://' + l.address + ':' + ad.port + (a.token ? '/?token=…' : ''));
  }, e => { console.error(e.message); process.exit(1); });
  process.on('SIGINT', () => { b.close(); process.exit(0); });
}
