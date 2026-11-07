// Мост rtl_tcp ↔ WebSocket на настоящих сокетах: node tools/test-rtltcp-bridge.mjs
import net from 'node:net';
import crypto from 'node:crypto';
import { createRtlBridge } from './rtltcp-bridge.mjs';
import { wsParser } from './termux/bridge.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const br = createRtlBridge({ tcp: 0, ws: 0 });
const { tcp, ws } = await br.start();

// клиент WebSocket «страницы» (кадры клиента — с маской)
function maskedFrame(buf, op = 2) {
  const n = buf.length, mk = crypto.randomBytes(4);
  const h = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]);
  const p = Buffer.from(buf); for (let i = 0; i < n; i++) p[i] ^= mk[i & 3];
  return Buffer.concat([h, mk, p]);
}
const page = net.connect(ws, '127.0.0.1');
const texts = [], bins = [];
let hs = false;
const feed = wsParser({ onMsg: (t) => texts.push(t), onBin: (b) => bins.push(b), onClose() {}, onPing() {} });
page.on('data', (d) => {
  if (!hs) { const i = d.indexOf('\r\n\r\n'); hs = true; ok('101', d.toString().startsWith('HTTP/1.1 101')); if (d.length > i + 4) feed(d.subarray(i + 4)); }
  else feed(d);
});
page.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
await wait(100);

const cli = net.connect(tcp, '127.0.0.1');
const got = [];
cli.on('data', (d) => got.push(d));
await wait(150);
ok('page told: client on', texts.includes('{"client":true}'), texts.join());

page.write(maskedFrame(Buffer.from('52544c30000000050000001d', 'hex')));
page.write(maskedFrame(Buffer.from([128, 127, 130, 125])));
await wait(150);
const all = Buffer.concat(got);
ok('header+iq reach tcp client', all.length === 16 && all.subarray(0, 4).toString() === 'RTL0' && all[15] === 125, all.toString('hex'));

cli.write(Buffer.from([1, 5, 0xf5, 0xe1, 0]));
await wait(150);
ok('command reaches page', bins.length === 1 && bins[0].toString('hex') === '0105f5e100', bins.map((b) => b.toString('hex')).join());

const cli2 = net.connect(tcp, '127.0.0.1');
await new Promise((r) => cli2.on('close', r));
ok('second client refused', true);

cli.destroy(); await wait(150);
ok('page told: client off', texts.includes('{"client":false}'));

const lone = net.connect(tcp, '127.0.0.1'); // страница ещё есть → пустим; закроем страницу и проверим отказ
await wait(100); lone.destroy(); page.destroy(); await wait(150);
const c3 = net.connect(tcp, '127.0.0.1');
await new Promise((r) => c3.on('close', r));
ok('no page → tcp refused', !br.stats().page);
// токен: без него и с чужим — 401, с верным — 101
{
  const tb = createRtlBridge({ tcp: 0, ws: 0, token: 'sekret' });
  const tp = (await tb.start()).ws;
  const hs = (q) => new Promise((res) => { const s = net.connect(tp, '127.0.0.1'); s.once('data', (d) => { res(d.toString().split('\r\n')[0]); s.destroy(); }); s.write('GET /' + q + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n'); });
  ok('no token → 401', (await hs('')).includes('401'));
  ok('wrong token → 401', (await hs('?token=nope')).includes('401'));
  ok('right token → 101', (await hs('?token=sekret')).includes('101'));
  tb.stop();
}
br.stop();
process.exit(bad ? 1 : 0);
