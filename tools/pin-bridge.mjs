// Мост «пины наружу»: узлы Pins Out / Pins In страницы DSP ↔ любые внешние клиенты (GNU Radio, скрипты, другая вкладка).
// Мост ничего не разбирает: пересылает кадры по имени пина (формат — modules/pins-kernels.js).
//   node tools/pin-bridge.mjs [--port 8766] [--host 127.0.0.1] [--token секрет] [--origin https://мой.сайт]
// Страница: узел Pins Out / Pins In, url = ws://127.0.0.1:8766 (роль {t:'hello',role:'graph'}).
// Внешний клиент (по умолчанию роль client):
//   ws://host:8766/raw/ИМЯ      только данные пина, без заголовка: float32 (sig, spec), float32 I,Q,I,Q… (iq), UTF-8 JSON (числа, текст, записи)
//                               websocat -b ws://127.0.0.1:8766/raw/chan1 | …
//   ws://host:8766/             кадры с заголовком; {t:'sub',names:['a','b']} (или '*') подписывает, {t:'pins'} просит список,
//                               {t:'set',name:'tune',v:100.5e6} подаёт значение на Pins In, бинарный кадр с тем же именем — поток
//   GET http://host:8766/pins   список пинов: {out:[{name,kind,fc,sr}], in:[{name}]}
// Токен: ?token=… в адресе. Принимаются только страницы с разрешённым Origin (по умолчанию localhost и fagci.github.io).
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wsAccept, wsFrame, wsParser, originOk, DEFAULT_ORIGINS } from './termux/bridge.mjs';
import { loadKernels } from './netmock.mjs';

const K = loadKernels(['pins-kernels.js'], 'pinEncode,pinHdrLen,PIN_JSON');
const MAX_BACKLOG = 4 << 20;                           // сколько байт может висеть в сокете медленного клиента, дальше кадры выбрасываем

export function createPinBridge(opt = {}) {
  const o = { host: '127.0.0.1', port: 8766, token: '', origins: DEFAULT_ORIGINS, log: () => {}, ...opt };
  const conns = new Set();
  const graphs = () => [...conns].filter((c) => c.role === 'graph');
  const clients = () => [...conns].filter((c) => c.role === 'client');

  const write = (c, buf, op) => {
    if (c.dead) return false;
    if (c.sock.writableLength > MAX_BACKLOG) { c.drops++; return false; }
    try { c.sock.write(wsFrame(buf, op)); return true; } catch (e) { c.dead = true; return false; }
  };
  const sendJson = (c, j) => write(c, JSON.stringify(j), 1);
  const nameOf = (u8) => Buffer.from(u8.buffer, u8.byteOffset + 24, u8[1]).toString();

  const pinList = () => {
    const out = [], inn = [];
    for (const g of graphs()) { out.push(...(g.pins.out || [])); inn.push(...(g.pins.in || [])); }
    return { out, in: inn };
  };
  const announce = () => { const l = { t: 'pins', ...pinList() }; for (const c of clients()) if (!c.rawName) sendJson(c, l); };
  const wantNames = () => { const s = new Set(); for (const c of clients()) for (const n of c.subs) s.add(n); return s.has('*') ? ['*'] : [...s]; };
  const sendWant = (g) => sendJson(g, { t: 'want', names: wantNames() });
  const wantAll = () => { for (const g of graphs()) sendWant(g); };

  const onBin = (c) => (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    if (u8.length < 24 || u8.length < K.pinHdrLen(u8[1])) return;
    if (c.role === 'graph') {
      const name = nameOf(u8), hl = K.pinHdrLen(u8[1]);
      for (const k of clients()) {
        if (!(k.subs.has(name) || k.subs.has('*'))) continue;
        write(k, k.rawName ? u8.subarray(hl) : u8, 2);
      }
    } else for (const g of graphs()) write(g, u8, 2);   // от клиента — на вход графа
  };
  const onText = (c) => (t) => {
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello' && m.role === 'graph') {
      c.role = 'graph'; c.pins = { out: [], in: [] }; c.subs.clear(); o.log('page joined as graph'); sendWant(c); announce();
    } else if (c.role === 'graph' && m.t === 'pins') {
      c.pins = { out: Array.isArray(m.out) ? m.out.slice(0, 256) : [], in: Array.isArray(m.in) ? m.in.slice(0, 256) : [] }; announce();
    } else if (c.role === 'client') {
      if (m.t === 'sub' && Array.isArray(m.names)) { c.subs = new Set(m.names.map(String).slice(0, 256)); wantAll(); }
      else if (m.t === 'pins') sendJson(c, { t: 'pins', ...pinList() });
      else if (m.t === 'set' && typeof m.name === 'string') {
        const f = K.pinEncode({ kind: K.PIN_JSON, name: m.name, seq: 0, data: m.v });
        for (const g of graphs()) write(g, f, 2);
      }
    }
  };

  const server = http.createServer((q, s) => {
    if (q.url.split('?')[0] === '/pins') { s.setHeader('content-type', 'application/json'); s.setHeader('access-control-allow-origin', '*'); s.end(JSON.stringify(pinList())); return; }
    s.end('DSP pin bridge: ' + graphs().length + ' graph(s), ' + clients().length + ' client(s)\n');
  });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'], u = new URL(req.url, 'http://x');
    if (!key || !originOk(req.headers.origin, o.origins)) { o.log('refused origin ' + req.headers.origin); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (o.token && u.searchParams.get('token') !== o.token) { o.log('refused: wrong token'); sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    const c = { sock, role: 'client', subs: new Set(), pins: null, drops: 0, dead: false, rawName: '' };
    const raw = /^\/raw\/(.+)$/.exec(u.pathname);
    if (raw) { c.rawName = decodeURIComponent(raw[1]); c.subs.add(c.rawName); }
    conns.add(c);
    sock.on('data', wsParser({
      onMsg: onText(c), onBin: onBin(c),
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) { /* закрыт */ } },
      onPing: (p) => { try { sock.write(wsFrame(p, 10)); } catch (e) { /* закрыт */ } },
    }));
    const bye = () => {
      if (!conns.delete(c)) return;
      c.dead = true; o.log((c.role === 'graph' ? 'graph' : 'client') + ' left');
      if (c.role === 'graph') announce(); else wantAll();
    };
    sock.on('close', bye); sock.on('error', bye);
    if (raw) wantAll(); else sendJson(c, { t: 'pins', ...pinList() });
  });
  return {
    start: () => new Promise((ok) => server.listen(o.port, o.host, () => ok(server.address().port))),
    stop: () => { for (const c of conns) c.sock.destroy(); conns.clear(); server.close(); server.closeAllConnections?.(); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = process.argv.slice(2), g = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const host = g('host', '127.0.0.1');
  const b = createPinBridge({ host, port: +g('port', 8766), token: g('token', ''), origins: [...DEFAULT_ORIGINS, ...a.flatMap((x, i) => x === '--origin' ? [a[i + 1]] : [])], log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
  if (host !== '127.0.0.1' && !g('token', '')) console.error('warning: open to the network without --token — anyone on it can read the exposed pins and write the inputs');
  console.log('pin bridge: ws://' + host + ':' + await b.start() + '  (nodes «Pins Out» / «Pins In» → url)');
}
