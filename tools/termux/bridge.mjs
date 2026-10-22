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

// разбор кадров клиента (всегда с маской); onMsg(text), onClose(), onPing(payload)
export function wsParser({onMsg, onClose, onPing}) {
  let buf = Buffer.alloc(0), msg = [];
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); o = 10; }
      if (len > 1 << 20) { onClose(); return; }
      if (buf.length < o + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(o, o + 4) : null; o += masked ? 4 : 0;
      const pl = Buffer.from(buf.subarray(o, o + len));
      if (mask) for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
      buf = buf.subarray(o + len);
      if (op === 8) { onClose(); return; }
      if (op === 9) { onPing(pl); continue; }
      if (op === 1 || op === 2 || op === 0) { msg.push(pl); if (fin) { onMsg(Buffer.concat(msg).toString()); msg = []; } }
    }
  };
}

export function originOk(origin, allowed) {
  if (!origin) return true;                                  // не браузер (websocat, curl)
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try { return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(origin).hostname); } catch (e) { return false; }
}

// ---------- мост ----------

export function createBridge(opt) {
  const o = {host: '127.0.0.1', port: 8765, token: '', origins: DEFAULT_ORIGINS, sources: ['gps', 'battery'], provider: 'gps',
    sensorDelay: 200, batteryEvery: 30, wifiEvery: 10, cellEvery: 10, log: () => {}, ...opt};
  const clients = new Set();
  const running = new Map();                                 // источник → {stop()}
  let fix = null, fixAt = 0;

  const send = (c, rec) => { if (!c.dead) try { c.sock.write(wsFrame(JSON.stringify(rec))); } catch (e) { c.dead = true; } };
  const emit = (src, rec) => {
    if (src === 'gps') { fix = {lat: rec.lat, lon: rec.lon, acc: rec.acc}; fixAt = Date.now(); }
    for (const c of clients) if (c.subs.has(src)) send(c, rec);
  };
  const note = (msg, level = 'info') => { const r = {src: 'bridge', level, msg}; o.log(level + ': ' + msg); for (const c of clients) send(c, r); };

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
    res.writeHead(200, {'content-type': 'text/plain'});
    res.end('DSP Termux bridge: ' + clients.size + ' client(s), sources: ' + [...wanted()].join(', ') + '\nconnect with WebSocket\n');
  });
  server.on('upgrade', (req, sock) => {
    const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
    const deny = code => { sock.end('HTTP/1.1 ' + code + '\r\nconnection: close\r\n\r\n'); };
    if (!key || /websocket/i.test(req.headers.upgrade || '') === false) return deny('400 Bad Request');
    if (!originOk(req.headers.origin, o.origins)) { o.log('origin refused: ' + req.headers.origin); return deny('403 Forbidden'); }
    if (o.token && u.searchParams.get('token') !== o.token) return deny('401 Unauthorized');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(key) + '\r\n\r\n');
    const c = {sock, subs: new Set(o.sources), dead: false};
    clients.add(c);
    const bye = () => { if (clients.delete(c)) { c.dead = true; sync(); } };
    const par = wsParser({
      onMsg: t => {
        let m; try { m = JSON.parse(t); } catch (e) { return; }
        if (Array.isArray(m?.sub)) { c.subs = new Set(m.sub.map(String)); sync(); send(c, {src: 'bridge', level: 'info', msg: 'sub: ' + [...c.subs].join(',')}); }
      },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) { /* закрыт */ } bye(); },
      onPing: p => { try { sock.write(wsFrame(p.toString(), 10)); } catch (e) { /* закрыт */ } },
    });
    sock.on('data', par); sock.on('close', bye); sock.on('error', bye);
    send(c, {src: 'bridge', level: 'hello', ver: 1, host: os.hostname(), sources: Object.keys(start), sensors: SENSORS});
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
  b.listen().then(ad => console.error('listening on ws://' + ad.address + ':' + ad.port + (a.token ? '/?token=…' : '')), e => { console.error(e.message); process.exit(1); });
  process.on('SIGINT', () => { b.close(); process.exit(0); });
}
