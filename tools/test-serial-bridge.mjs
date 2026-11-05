// Мост порта для страницы: node tools/test-serial-bridge.mjs
// tcp:// (имитация ser2net на роутере) и локальный tty (псевдотерминал через python3, если есть) → WebSocket с бинарными кадрами
import net from 'node:net';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {createMsgrBridge} from './node/bridge.mjs';
import {parseSerialSpec} from './node/serial.mjs';

let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }
const cleanup = [];

// ---- разбор аргумента ----
{ const a = parseSerialSpec('esp=/dev/ttyACM0@921600'), b = parseSerialSpec('r=tcp://192.168.1.1:2000'), c = parseSerialSpec('x=/dev/ttyUSB1');
  ok('spec tty', a.kind === 'tty' && a.dev === '/dev/ttyACM0' && a.baud === 921600);
  ok('spec tcp', b.kind === 'tcp' && b.host === '192.168.1.1' && b.port === 2000);
  ok('spec default baud', c.baud === 115200);
  for (const bad1 of ['nonsense', 'a=tcp://h', 'a=tcp://h:99999', 'a=/dev/x@123', 'a=http://x/y', '=/dev/x']) {
    let e = null; try { parseSerialSpec(bad1); } catch (x) { e = x; }
    ok('spec rejects «' + bad1 + '»', !!e);
  } }

const wsOpen = (url, opt) => new Promise(res => {
  const ws = new WebSocket(url, opt); ws.binaryType = 'arraybuffer';
  const r = {ws, got: [], text: [], closed: null, opened: false};
  ws.onopen = () => { r.opened = true; res(r); };
  ws.onmessage = e => { if (typeof e.data === 'string') r.text.push(e.data); else r.got.push(...new Uint8Array(e.data)); };
  ws.onclose = e => { r.closed = e.code; if (!r.opened) res(r); };
  ws.onerror = () => {};
});
const status = (url, origin) => new Promise(res => {
  const u = new URL(url);
  const rq = http.request({host: u.hostname, port: u.port, path: u.pathname + u.search, headers: {connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...(origin ? {origin} : {})}});
  rq.on('upgrade', (r, s) => { s.destroy(); res(r.statusCode); });
  rq.on('response', r => { r.resume(); res(r.statusCode); });
  rq.on('error', () => res(0)); rq.end();
});

// ---- tcp: «ser2net» повторяет всё, что получил, +1 к каждому байту; при подключении шлёт 00 80 ff ----
{ const conns = [];
  const ser2net = net.createServer(s => { conns.push(s); s.write(Buffer.from([0, 0x80, 0xff])); s.on('data', d => s.write(Buffer.from(d.map(x => (x + 1) & 255)))); s.on('error', () => {}); });
  await new Promise(r => ser2net.listen(0, '127.0.0.1', r)); cleanup.push(() => { ser2net.close(); conns.forEach(s => s.destroy()); });
  const sp = ser2net.address().port;
  const br = createMsgrBridge({port: 0, token: 'tk', serial: ['esp=tcp://127.0.0.1:' + sp, 'dead=tcp://127.0.0.1:1']});
  const bp = (await br.listen()).port; cleanup.push(() => br.close());
  const base = 'ws://127.0.0.1:' + bp;

  const a = await wsOpen(base + '/serial/esp?token=tk');
  ok('tcp: opened', a.opened);
  ok('tcp: bytes 00 80 ff arrive as binary', !!(await until(() => a.got.length >= 3)) && a.got.join() === '0,128,255', a.got.join());
  a.ws.send(new Uint8Array([1, 2, 0x7f, 0xfe]));
  ok('tcp: binary page→port→page', !!(await until(() => a.got.length >= 7)) && a.got.slice(3).join() === '2,3,128,255', a.got.join());
  a.ws.send('AB');
  ok('tcp: text frame goes as UTF-8 bytes', !!(await until(() => a.got.length >= 9)) && a.got.slice(7).join() === '66,67', a.got.join());
  const big = new Uint8Array(100000).map((_, i) => i & 255); a.ws.send(big);
  ok('tcp: 100 kB in one message', !!(await until(() => a.got.length >= 100009)) && a.got.length === 100009 && a.got[9 + 1000] === ((1000 + 1) & 255));
  const b = await wsOpen(base + '/serial/esp?token=tk');
  ok('tcp: second client has its own connection', b.opened && !!(await until(() => b.got.length >= 3)) && conns.length === 2);
  a.ws.close(); b.ws.close();

  ok('no token → 401', await status(base + '/serial/esp') === 401);
  ok('wrong token → 401', await status(base + '/serial/esp?token=zz') === 401);
  ok('unknown port → 404', await status(base + '/serial/nope?token=tk') === 404);
  ok('foreign Origin refused', await status(base + '/serial/esp?token=tk', 'https://evil.example') === 403);
  ok('own Origin accepted', await status(base + '/serial/esp?token=tk', 'https://fagci.github.io') === 101);
  ok('only listed ports: no host in the path', await status(base + '/serial/127.0.0.1:22?token=tk') === 404);
  const lst = await (await fetch('http://127.0.0.1:' + bp + '/serial?token=tk')).json();
  ok('list of ports', lst.length === 2 && lst[0].name === 'esp' && lst[0].target === 'tcp://127.0.0.1:' + sp, JSON.stringify(lst));
  ok('list needs the token', (await fetch('http://127.0.0.1:' + bp + '/serial')).status === 401);

  const d = await wsOpen(base + '/serial/dead?token=tk');
  ok('tcp: connection refused → the page gets a close with the reason', !!(await until(() => d.closed !== null)) && d.closed === 1000, String(d.closed));

  // ser2net закрыл — страница видит закрытие
  const e = await wsOpen(base + '/serial/esp?token=tk'); await until(() => e.got.length >= 3); conns.at(-1).destroy();
  ok('tcp: port side closed → ws closed', !!(await until(() => e.closed !== null)));
}

// ---- локальный tty через псевдотерминал (python3 + stty) ----
const py = spawnSync('python3', ['-I', '-c', '1']), sty = spawnSync('stty', ['--version']);
if (process.platform !== 'linux' || py.status !== 0 || sty.status !== 0) console.log('skip tty: needs linux + python3 + stty');
else {
  // «устройство» на другом конце: читает с master и отвечает байтом-инверсией; печатает путь к slave
  const dev = spawn('python3', ['-I', '-u', '-c', `
import os, pty, sys, tty
m, s = pty.openpty()
print(os.ttyname(s), flush=True)
tty.setraw(m)
os.write(m, b"\\x00\\x80\\xffhi")
while True:
    d = os.read(m, 4096)
    if not d: break
    os.write(m, bytes(255 - x for x in d))
`], {stdio: ['ignore', 'pipe', 'inherit']});
  cleanup.push(() => dev.kill());
  const path = await new Promise(r => dev.stdout.once('data', d => r(String(d).trim())));
  const br = createMsgrBridge({port: 0, serial: ['pty=' + path + '@115200']});
  const bp = (await br.listen()).port; cleanup.push(() => br.close());
  const a = await wsOpen('ws://127.0.0.1:' + bp + '/serial/pty'), b = await wsOpen('ws://127.0.0.1:' + bp + '/serial/pty');
  ok('tty: opened by two clients', a.opened && b.opened);
  a.ws.send(new Uint8Array([0, 1, 0x80, 0xfe]));
  const want = '255,254,127,1';
  ok('tty: write goes to the device, answer returns to BOTH clients', !!(await until(() => a.got.join().includes(want) && b.got.join().includes(want))), a.got.join() + ' | ' + b.got.join());
  a.ws.close();
  await sleep(100);
  b.ws.send(new Uint8Array([10])); ok('tty: still works after one client left', !!(await until(() => b.got.slice(-1)[0] === 245)), b.got.join());
  b.ws.close(); await sleep(150);
  const c = await wsOpen('ws://127.0.0.1:' + bp + '/serial/pty'); c.ws.send(new Uint8Array([5]));
  ok('tty: reopens after the last client left', !!(await until(() => c.got.slice(-1)[0] === 250)), c.got.join()); c.ws.close();
  const nb = createMsgrBridge({port: 0, serial: ['bad=/dev/does-not-exist@115200']});
  const np = (await nb.listen()).port; cleanup.push(() => nb.close());
  const x = await wsOpen('ws://127.0.0.1:' + np + '/serial/bad');
  ok('tty: no such device → the page gets a close', !!(await until(() => x.closed !== null)) );
}

// ---- обычный мессенджерный WebSocket по-прежнему работает на том же порту ----
{ const br = createMsgrBridge({port: 0}); const bp = (await br.listen()).port; cleanup.push(() => br.close());
  const m = await wsOpen('ws://127.0.0.1:' + bp + '/');
  ok('messenger ws still gets hello', m.opened && !!(await until(() => m.text.length)) && JSON.parse(m.text[0]).ev === 'hello'); m.ws.close(); }

for (const f of cleanup) { try { f(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
