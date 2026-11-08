// Сетевые команды приложения на ноутбуке (tools/node/bridge.mjs + netcmd.mjs): TCP и UDP-пакеты с hex туда и обратно, tcp.listen, двоичные кадры, Origin и токен: node tools/test-net-bridge.mjs
import net from 'node:net';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { createMsgrBridge } from './node/bridge.mjs';
import { wsParser } from './termux/bridge.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const br = createMsgrBridge({ port: 0, proxyLoopback: true });
const port = (await br.listen()).port;

function mframe(text) {
  const b = Buffer.from(text), n = b.length, mk = crypto.randomBytes(4);
  const h = n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]);
  for (let i = 0; i < n; i++) b[i] ^= mk[i & 3];
  return Buffer.concat([h, mk, b]);
}
function mframeBin(b) {
  b = Buffer.from(b); const n = b.length, mk = crypto.randomBytes(4);
  const h = n < 126 ? Buffer.from([0x82, 0x80 | n]) : Buffer.from([0x82, 0x80 | 126, n >> 8, n & 255]);
  for (let i = 0; i < n; i++) b[i] ^= mk[i & 3];
  return Buffer.concat([h, mk, b]);
}
function openWs(origin) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1'), msgs = [], bins = []; let hs = false, head = '';
    const feed = wsParser({ onMsg: (t) => msgs.push(JSON.parse(t)), onBin: (b) => bins.push(Buffer.from(b)), onClose() {}, onPing() {} });
    s.on('data', (d) => { if (!hs) { const i = d.indexOf('\r\n\r\n'); head = d.subarray(0, i < 0 ? d.length : i).toString(); hs = true; res({ s, msgs, bins, head, send: (o) => s.write(mframe(JSON.stringify(o))) }); if (i >= 0 && d.length > i + 4) feed(d.subarray(i + 4)); } else feed(d); });
    s.write('GET / HTTP/1.1\r\nHost: x\r\n' + (origin ? 'Origin: ' + origin + '\r\n' : '') + 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
}
const evil = await openWs('https://evil.example');
ok('foreign Origin refused', evil.head.startsWith('HTTP/1.1 403'), evil.head);

// «настоящий rtl_tcp»: сервер Node отдаёт заголовок и ждёт 5-байтную команду
const got = [];
const fake = net.createServer((c) => { c.write(Buffer.from('52544c30000000050000001d', 'hex')); c.on('data', (d) => got.push(d.toString('hex'))); });
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const ws = await openWs('http://localhost:8123');
ok('localhost Origin accepted', ws.head.startsWith('HTTP/1.1 101'));
ws.send({ cmd: 'tcp.connect', id: 1, host: '127.0.0.1', port: fake.address().port, timeout: 2000 });
await wait(300);
const conn = ws.msgs.find((m) => m.cmd === 'tcp.connect' && m.ok);
ok('tcp.connect ok', !!conn, JSON.stringify(ws.msgs));
const hdr = ws.msgs.find((m) => m.ev === 'data');
ok('received header as hex record', hdr && hdr.hex === '52544c30000000050000001d' && hdr.n === 12, JSON.stringify(hdr));
ws.send({ cmd: 'tcp.send', id: 2, conn: conn.conn, hex: '0105f5e100' });
await wait(300);
ok('sent hex packet reached the server', got.join('') === '0105f5e100', got.join());


// ---- tcp.listen: порт принимает «SDR++»-клиента, данные идут в обе стороны (hex и двоичными кадрами) ----
ws.msgs.length = 0;
ws.send({ cmd: 'tcp.listen', id: 10, port: 0, lan: false });
await wait(300);
const lis = ws.msgs.find((m) => m.cmd === 'tcp.listen');
ok('tcp.listen ok (port, ordered, binary)', lis && lis.ok && lis.port > 0 && lis.ordered === true && lis.binary === true, JSON.stringify(lis));
const cl = net.connect(lis.port, '127.0.0.1'); const clGot = []; cl.on('data', (d) => clGot.push(d));
await wait(300);
const acc = ws.msgs.find((m) => m.ev === 'accept');
ok('accept event with the peer', acc && acc.server === lis.server && /127\.0\.0\.1/.test(acc.peer), JSON.stringify(acc));
cl.write(Buffer.from('0105f5e100', 'hex')); await wait(200);
ok('client bytes arrive as hex', ws.msgs.some((m) => m.ev === 'data' && m.conn === acc.conn && m.hex === '0105f5e100'));
ws.send({ cmd: 'tcp.send', id: 11, conn: acc.conn, hex: 'aabb' }); await wait(200);
ok('tcp.send reaches the client', Buffer.concat(clGot).toString('hex') === 'aabb');
ws.s.write(mframeBin(Buffer.concat([Buffer.from([1, 0, 0, 0, acc.conn]), Buffer.from('ccdd', 'hex')]))); await wait(200);
ok('binary frame [1][conn][data] reaches the client', Buffer.concat(clGot).toString('hex') === 'aabbccdd', Buffer.concat(clGot).toString('hex'));
ws.send({ cmd: 'tcp.send', id: 12, conn: 999, hex: '00' }); await wait(150);
ok('unknown connection → error', ws.msgs.some((m) => m.id === 12 && m.ok === false));
ws.send({ cmd: 'tcp.listen', id: 13, port: 80 }); await wait(150);
ok('listen below 1024 refused', ws.msgs.some((m) => m.id === 13 && m.ok === false && /1024/.test(m.msg)));
ws.send({ cmd: 'tcp.close', id: 14, server: lis.server }); await wait(200);
ok('closing the server frees the port', await new Promise((r) => { const t = net.connect(lis.port, '127.0.0.1'); t.on('error', () => r(true)); t.on('connect', () => { t.destroy(); r(false); }); }));
cl.destroy();

// ---- tcp.connect binary:true: байты клиенту кадрами [2][conn][данные] ----
{
  const srv = net.createServer((c) => { c.write('hello'); }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b2 = await openWs('http://localhost:8123', true);
  b2.send({ cmd: 'tcp.connect', id: 1, host: '127.0.0.1', port: srv.address().port, binary: true }); await wait(300);
  const c2 = b2.msgs.find((m) => m.cmd === 'tcp.connect');
  ok('tcp.connect binary:true is confirmed', c2 && c2.ok && c2.binary === true, JSON.stringify(c2));
  const f = b2.bins.find((x) => x[0] === 2);
  ok('data comes as a binary frame [2][conn][data]', f && f.readUInt32BE(1) === c2.conn && f.subarray(5).toString() === 'hello', f && f.toString('hex'));
  b2.s.destroy(); srv.close();
}

// ---- UDP: открыть сокет, послать, получить; udp.request; широковещательный адрес не блокируется классом ----
{
  const echo = dgram.createSocket('udp4'); echo.on('message', (b, r) => echo.send(Buffer.concat([Buffer.from('re:'), b]), r.port, r.address));
  await new Promise((r) => echo.bind(0, '127.0.0.1', r)); const ep = echo.address().port;
  ws.msgs.length = 0;
  ws.send({ cmd: 'udp.open', id: 20, port: 0 }); await wait(250);
  const uo = ws.msgs.find((m) => m.cmd === 'udp.open');
  ok('udp.open ok', uo && uo.ok && uo.conn > 0 && uo.port > 0, JSON.stringify(uo));
  ws.send({ cmd: 'udp.send', id: 21, conn: uo.conn, host: '127.0.0.1', port: ep, hex: '0102' }); await wait(300);
  ok('udp.send answered with an event (hex, peer)', ws.msgs.some((m) => m.ev === 'data' && m.proto === 'udp' && m.conn === uo.conn && m.hex === Buffer.from('re:\x01\x02').toString('hex') && m.peer === '127.0.0.1:' + ep), JSON.stringify(ws.msgs.slice(-3)));
  ws.send({ cmd: 'udp.request', id: 22, host: '127.0.0.1', port: ep, text: 'ping', timeout: 1000 }); await wait(300);
  const rq = ws.msgs.find((m) => m.cmd === 'udp.request');
  ok('udp.request returns the answer', rq && rq.ok && Buffer.from(rq.hex, 'hex').toString() === 're:ping' && rq.ms >= 0, JSON.stringify(rq));
  ws.send({ cmd: 'udp.request', id: 23, host: '127.0.0.1', port: 9, text: 'x', timeout: 300 }); await wait(700);
  ok('udp.request without an answer → error', ws.msgs.some((m) => m.id === 23 && m.ok === false && /no answer/.test(m.msg)));
  ws.send({ cmd: 'udp.send', id: 24, host: '255.255.255.255', port: 9, hex: '00', broadcast: true }); await wait(300);
  const bc = ws.msgs.find((m) => m.id === 24);
  ok('broadcast is not refused by the address class', bc && (bc.ok || !/not allowed/.test(bc.msg || '')), JSON.stringify(bc));
  ws.send({ cmd: 'udp.close', id: 25, conn: uo.conn }); await wait(200);
  ok('udp.close', ws.msgs.some((m) => m.id === 25 && m.ok) && ws.msgs.some((m) => m.ev === 'close' && m.proto === 'udp' && m.conn === uo.conn));
  echo.close();
}
ws.send({ cmd: 'net.info', id: 30 }); await wait(200);
const ni = ws.msgs.find((m) => m.cmd === 'net.info');
ok('net.info: addresses of this computer', ni && ni.ok && Array.isArray(ni.ips), JSON.stringify(ni));
ws.s.destroy(); fake.close(); br.close();
{
  const tb = createMsgrBridge({ port: 0, token: 'sekret' });
  const tp = (await tb.listen()).port;
  const hs = (q) => new Promise((res) => { const s = net.connect(tp, '127.0.0.1'); s.once('data', (d) => { res(d.toString().split('\r\n')[0]); s.destroy(); }); s.write('GET /' + q + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n'); });
  ok('net bridge: no token → 401', (await hs('')).includes('401'));
  ok('net bridge: right token → 101', (await hs('?token=sekret')).includes('101'));
  tb.close();
}
process.exit(bad ? 1 : 0);
