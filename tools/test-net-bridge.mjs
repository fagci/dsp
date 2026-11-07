// Настольный мост Network (tools/net-bridge.mjs): TCP-пакеты с hex туда и обратно, проверка Origin: node tools/test-net-bridge.mjs
import net from 'node:net';
import crypto from 'node:crypto';
import { createNetBridge } from './net-bridge.mjs';
import { wsParser } from './termux/bridge.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const br = createNetBridge({ port: 0 });
const port = await br.start();

function mframe(text) {
  const b = Buffer.from(text), n = b.length, mk = crypto.randomBytes(4);
  const h = n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]);
  for (let i = 0; i < n; i++) b[i] ^= mk[i & 3];
  return Buffer.concat([h, mk, b]);
}
function openWs(origin) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1'), msgs = []; let hs = false, head = '';
    const feed = wsParser({ onMsg: (t) => msgs.push(JSON.parse(t)), onClose() {}, onPing() {} });
    s.on('data', (d) => { if (!hs) { const i = d.indexOf('\r\n\r\n'); head = d.subarray(0, i < 0 ? d.length : i).toString(); hs = true; res({ s, msgs, head, send: (o) => s.write(mframe(JSON.stringify(o))) }); if (i >= 0 && d.length > i + 4) feed(d.subarray(i + 4)); } else feed(d); });
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
ws.s.destroy(); fake.close(); br.stop();
{
  const tb = createNetBridge({ port: 0, token: 'sekret' });
  const tp = await tb.start();
  const hs = (q) => new Promise((res) => { const s = net.connect(tp, '127.0.0.1'); s.once('data', (d) => { res(d.toString().split('\r\n')[0]); s.destroy(); }); s.write('GET /' + q + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n'); });
  ok('net bridge: no token → 401', (await hs('')).includes('401'));
  ok('net bridge: right token → 101', (await hs('?token=sekret')).includes('101'));
  tb.stop();
}
process.exit(bad ? 1 : 0);
