// Сокеты приложения (modules/netsock-kernels.js) на мосте-имитаторе: node tools/test-netsock.mjs
import net from 'node:net';
import dgram from 'node:dgram';
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js'], 'NetSock,nsHex,nsBytes,nsEnc,nsDec');
const ns = mockSock(K);
const dec = (b) => Buffer.from(b).toString();

// TCP-клиент к настоящему серверу Node
const echo = net.createServer((s) => { s.on('data', (b) => s.write(b)); });
await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const port = echo.address().port;
const c = await ns.connect('127.0.0.1', port);
await c.write('hello\nworld\r\nrest');
ok('readLine', (await c.readLine(2000)) === 'hello' && (await c.readLine(2000)) === 'world');
ok('read n', dec(await c.read(4, 2000)) === 'rest');
const big = new Uint8Array(300000).map((_, i) => i * 7);
c.write(big);
const got = await c.read(big.length, 5000);
ok('big transfer in pieces', got.length === big.length && got[299999] === big[299999] && got[12345] === big[12345]);
await c.write('a:b::c');
ok('readUntil', dec(await c.readUntil('::', 2000)) === 'a:b::');
ok('timeout', await c.read(10, 100).then(() => false, (e) => e.message === 'timeout'));
await c.close();
ok('closed conn rejects write', await c.write('x').then(() => false, () => true));
await new Promise((r) => echo.close(r));

// сервер приложения: accept → поток
const acc = [];
const srv = await ns.listen(0, (conn) => acc.push(conn));
const cli = net.connect(srv.port, '127.0.0.1');
await new Promise((r) => cli.once('connect', r));
cli.write('GET /\r\n\r\n');
await new Promise((r) => setTimeout(r, 100));
ok('accept gives a stream', acc.length === 1 && dec(await acc[0].readUntil('\r\n\r\n', 1000)) === 'GET /\r\n\r\n');
await acc[0].write('pong');
ok('server → client', (await new Promise((r) => cli.once('data', r))).toString() === 'pong');
cli.end();
ok('remote close: readAny → null', (await acc[0].readAny(1000)) === null);
ok('listen below 1024 refused', await ns.listen(80, () => {}).then(() => false, (e) => /1024/.test(e.message)));
await srv.close();

// UDP
const u = await ns.udpOpen(0, false);
const peer = dgram.createSocket('udp4');
peer.on('message', (b, r) => peer.send(Buffer.concat([Buffer.from('re:'), b]), r.port, r.address));
await new Promise((r) => peer.bind(0, '127.0.0.1', r));
await u.send('127.0.0.1', peer.address().port, 'ping');
const d = await u.recv(2000);
ok('udp send / recv', dec(d.bytes) === 're:ping');
const rq = await ns.udpRequest('127.0.0.1', peer.address().port, new Uint8Array([1, 2]), 1000);
ok('udp request', rq.bytes.length === 5 && rq.bytes[3] === 1);
ok('udp request timeout', await ns.udpRequest('127.0.0.1', 9, 'x', 300).then(() => false, (e) => /no answer/.test(e.message)));
await u.close(); peer.close();

ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
