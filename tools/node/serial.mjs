// Последовательные порты и TCP «сырыми байтами» для страницы (Packet Link, канал websocket): мост отдаёт порт как WebSocket
//   node tools/node/bridge.mjs --serial esp=/dev/ttyACM0@115200            локальный порт (Linux, macOS; нужен stty)
//   node tools/node/bridge.mjs --serial esp=tcp://192.168.1.1:2000         ser2net на роутере OpenWrt (raw-порт)
// и на странице: ws://127.0.0.1:8777/serial/esp  — байты идут как бинарные кадры в обе стороны, текстовый кадр = его UTF-8.
// Страница выбирает порт только из списка --serial: произвольный адрес через мост открыть нельзя.
import net from 'node:net';
import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';

const BAUDS = new Set([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000]);

// «имя=/dev/ttyACM0@115200» | «имя=tcp://host:port»  →  {name, kind:'tty'|'tcp', dev, baud | host, port}
export function parseSerialSpec(s) {
  const m = /^([A-Za-z0-9_.-]{1,32})=(.+)$/.exec(String(s).trim());
  if (!m) throw new Error('--serial: expected name=/dev/ttyACM0@115200 or name=tcp://host:port, got «' + s + '»');
  const name = m[1], t = m[2];
  const tcp = /^tcp:\/\/(\[[^\]]+\]|[^:/]+):(\d{1,5})$/i.exec(t);
  if (tcp) {
    const port = +tcp[2];
    if (port < 1 || port > 65535) throw new Error('--serial ' + name + ': bad port');
    return {name, kind: 'tcp', host: tcp[1].replace(/^\[|\]$/g, ''), port};
  }
  const tty = /^([^@]+?)(?:@(\d+))?$/.exec(t);
  if (!tty || /^[a-z]+:\/\//i.test(t)) throw new Error('--serial ' + name + ': «' + t + '» is neither a device path nor tcp://host:port');
  const baud = tty[2] ? +tty[2] : 115200;
  if (!BAUDS.has(baud)) throw new Error('--serial ' + name + ': baud ' + baud + ' is not in the list (' + [...BAUDS].join(', ') + ')');
  return {name, kind: 'tty', dev: tty[1], baud};
}

// Соединение с одним TCP-портом: {write, close}; события — onData(buf), onClose(msg)
function openTcp(spec, h) {
  const sock = net.connect(spec.port, spec.host);
  sock.setNoDelay(true);
  let dead = false;
  const end = msg => { if (!dead) { dead = true; h.onClose(msg); } };
  sock.on('connect', () => h.onOpen && h.onOpen());
  sock.on('data', d => h.onData(d));
  sock.on('error', e => end(e.message));
  sock.on('close', () => end('closed'));
  return {write: b => { if (!dead) sock.write(b); }, close: () => { dead = true; sock.destroy(); }};
}

// Локальный tty без зависимостей: настройка через stty, чтение — дочерний cat (его можно убить), запись — через fd
function openTty(spec, h) {
  const mac = process.platform === 'darwin';
  if (process.platform === 'win32') { process.nextTick(() => h.onClose('local serial ports need Linux or macOS (stty); on Windows use tcp://')); return {write() {}, close() {}}; }
  const st = spawnSync('stty', [mac ? '-f' : '-F', spec.dev, String(spec.baud), 'raw', '-echo', '-hupcl', 'clocal', 'cread', '-crtscts'], {encoding: 'utf8'});
  if (st.error || st.status !== 0) {
    const why = st.error ? (st.error.code === 'ENOENT' ? 'stty not found' : st.error.message) : (st.stderr || '').trim() || 'stty failed';
    process.nextTick(() => h.onClose(spec.dev + ': ' + why));
    return {write() {}, close() {}};
  }
  let fd;
  try { fd = fs.openSync(spec.dev, fs.constants.O_WRONLY | fs.constants.O_NOCTTY); }
  catch (e) { process.nextTick(() => h.onClose(spec.dev + ': ' + e.message)); return {write() {}, close() {}}; }
  const rd = spawn('cat', [spec.dev], {stdio: ['ignore', 'pipe', 'ignore']});
  let dead = false;
  const end = msg => { if (!dead) { dead = true; try { rd.kill(); } catch (e) { /* уже закрыт */ } try { fs.closeSync(fd); } catch (e) { /* закрыт */ } h.onClose(msg); } };
  rd.stdout.on('data', d => h.onData(d));
  rd.on('error', e => end(e.message));
  rd.on('close', () => end('device closed'));
  process.nextTick(() => h.onOpen && h.onOpen());
  return {
    write: b => {
      if (dead) return;
      try { let o = 0; while (o < b.length) { try { o += fs.writeSync(fd, b, o); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } }
      catch (e) { end(e.message); }
    },
    close: () => { dead = true; try { rd.kill(); } catch (e) { /* закрыт */ } try { fs.closeSync(fd); } catch (e) { /* закрыт */ } },
  };
}

// Набор портов моста. attach(name, client) → {write, close} или null (нет такого порта).
// client: {onOpen, onData(buf), onClose(msg)}. tcp — свой сокет на каждого клиента (ser2net пускает одного);
// tty — одно устройство на всех: чтение рассылается каждому, писать может любой; открывается с первым клиентом, закрывается с последним.
export function createSerialHub(specs, log = () => {}) {
  const map = new Map(specs.map(s => [s.name, s]));
  const live = new Map();                                    // name → {io, clients:Set} для tty
  return {
    has: n => map.has(n),
    list: () => specs.map(s => ({name: s.name, kind: s.kind, target: s.kind === 'tcp' ? 'tcp://' + s.host + ':' + s.port : s.dev + '@' + s.baud})),
    attach(name, c) {
      const spec = map.get(name);
      if (!spec) return null;
      if (spec.kind === 'tcp') {
        log('serial ' + name + ': → ' + spec.host + ':' + spec.port);
        return openTcp(spec, c);
      }
      let L = live.get(name);
      if (!L) {
        L = {clients: new Set(), io: null, opened: false};
        live.set(name, L);
        log('serial ' + name + ': open ' + spec.dev + ' @' + spec.baud);
        L.io = openTty(spec, {
          onOpen: () => { L.opened = true; for (const x of L.clients) x.onOpen && x.onOpen(); },
          onData: d => { for (const x of L.clients) x.onData(d); },
          onClose: msg => { live.delete(name); log('serial ' + name + ': ' + msg); for (const x of [...L.clients]) x.onClose(msg); L.clients.clear(); },
        });
      }
      L.clients.add(c);
      if (L.opened) process.nextTick(() => c.onOpen && c.onOpen());
      return {
        write: b => L.io.write(b),
        close: () => { L.clients.delete(c); if (!L.clients.size && live.get(name) === L) { live.delete(name); L.io.close(); log('serial ' + name + ': closed (no clients)'); } },
      };
    },
    closeAll() { for (const L of live.values()) { try { L.io.close(); } catch (e) { /* закрыт */ } } live.clear(); },
  };
}
