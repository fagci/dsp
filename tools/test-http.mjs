// HTTP-сервер и клиент (modules/http-kernels.js) против http / fetch / curl Node: node tools/test-http.mjs
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const sh = promisify(execFile);
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'http-kernels.js'], 'NetSock,HttpServer,httpFileHandler,httpFetch,httpParseRequestHead,httpMultipart,vfsNorm,VfsMem,nsEnc,nsDec,httpParseUrl');
const ns = mockSock(K);
const dec = (b) => Buffer.from(b).toString();

ok('vfsNorm', K.vfsNorm('/a/./b//../c/') === '/a/c' && K.vfsNorm('../../x') === '/x' && K.vfsNorm('') === '/');
const h = K.httpParseRequestHead('GET /a%20b/?x=1&y=%D1%8F HTTP/1.1\r\nHost: h\r\nX-A: 1\r\nx-a: 2');
ok('parse head', h.path === '/a b/' && h.query.x === '1' && h.query.y === 'я' && h.headers['x-a'] === '1, 2' && h.version === '1.1', JSON.stringify(h));
ok('bad head', K.httpParseRequestHead('garbage') === null);

// --- сервер: файлы ---
const vfs = new K.VfsMem();
await vfs.write('/hello.txt', Buffer.from('hello world'));
await vfs.write('/dir/a.bin', Uint8Array.from({ length: 1000 }, (_, i) => i & 255));
const uploads = [];
const srv = new K.HttpServer(ns, K.httpFileHandler(vfs, { write: true, onUpload: (p, b) => uploads.push([p, b.length]) }), {});
const port = await srv.start(0, false);
const base = 'http://127.0.0.1:' + port;

let r = await fetch(base + '/hello.txt');
ok('GET file', r.status === 200 && (await r.text()) === 'hello world' && r.headers.get('content-type').startsWith('text/plain'));
r = await fetch(base + '/hello.txt', { headers: { range: 'bytes=6-' } });
ok('Range', r.status === 206 && (await r.text()) === 'world' && r.headers.get('content-range') === 'bytes 6-10/11');
r = await fetch(base + '/hello.txt', { headers: { range: 'bytes=-5' } });
ok('suffix Range', (await r.text()) === 'world');
r = await fetch(base + '/hello.txt', { headers: { range: 'bytes=50-' } });
ok('Range out of file → 416', r.status === 416);
r = await fetch(base + '/hello.txt', { method: 'HEAD' });
ok('HEAD', r.status === 200 && r.headers.get('content-length') === '11' && (await r.text()) === '');
r = await fetch(base + '/nope'); ok('404', r.status === 404);
r = await fetch(base + '/'); const html = await r.text();
ok('index page', r.status === 200 && html.includes('hello.txt') && html.includes('dir/') && html.includes('type="file"'));
r = await fetch(base + '/dir/?json'); ok('json listing', (await r.json())[0].name === 'a.bin');
r = await fetch(base + '/../../etc/passwd'); ok('no escape from the root', r.status === 404);
r = await fetch(base + '/dir/a.bin'); const bin = Buffer.from(await r.arrayBuffer());
ok('binary file', bin.length === 1000 && bin[255] === 255 && bin[256] === 0);

// загрузка: PUT, multipart, chunked
r = await fetch(base + '/put.txt', { method: 'PUT', body: 'put body' });
ok('PUT creates', r.status === 201 && Buffer.from((await vfs.read('/put.txt'))).toString() === 'put body');
r = await fetch(base + '/put.txt', { method: 'PUT', body: 'again' }); ok('PUT replaces → 204', r.status === 204);
const fd = new FormData(); fd.append('file', new Blob([Buffer.alloc(5000, 7)], { type: 'application/x-test' }), 'up load.dat'); fd.append('note', 'x');
r = await fetch(base + '/dir/', { method: 'POST', body: fd });
ok('multipart upload', r.status === 201 && (await vfs.stat('/dir/up load.dat'))?.size === 5000 && uploads.some((u) => u[0] === '/dir/up load.dat'), JSON.stringify(uploads));
const big = Buffer.alloc(700000, 3);
r = await fetch(base + '/big.bin', { method: 'PUT', body: big });
ok('PUT 700 KB', r.status === 201 && (await vfs.stat('/big.bin')).size === 700000);
await new Promise((res) => {
  const rq = http.request({ port, method: 'PUT', path: '/chunk.txt', headers: { 'transfer-encoding': 'chunked' } }, (m) => { m.resume(); m.on('end', res); });
  rq.write('abc'); rq.write('defgh'); rq.end('!');
});
ok('chunked request body', dec(await vfs.read('/chunk.txt')) === 'abcdefgh!');
r = await fetch(base + '/hello.txt', { method: 'DELETE' }); ok('DELETE', r.status === 204 && !(await vfs.stat('/hello.txt')));
// keep-alive: два запроса по одному соединению
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const ports = []; for (let i = 0; i < 3; i++) await new Promise((res) => http.get({ port, path: '/?json', agent }, (m) => { ports.push(m.socket.localPort); m.resume(); m.on('end', res); }));
ok('keep-alive: 3 requests on one connection', ports.length === 3 && new Set(ports).size === 1, ports.join());
agent.destroy();
// curl
try {
  const o = (await sh('curl', ['-s', '-i', '-H', 'Range: bytes=0-3', base + '/dir/a.bin'], { encoding: 'latin1' })).stdout;
  ok('curl Range', /206 Partial/.test(o));
  await sh('curl', ['-s', '-T', '/etc/hostname', base + '/curl-put.txt']);
  ok('curl -T', (await vfs.stat('/curl-put.txt'))?.size > 0);
} catch (e) { console.log('skip curl:', e.message.split('\n')[0]); }
await srv.stop();

// --- авторизация, заголовки, 404 по умолчанию, ошибки ---
const srv2 = new K.HttpServer(ns, async (req) => req.path === '/api' ? { json: { m: req.method, q: req.query, body: dec(req.body) } } : req.path === '/slow' ? new Promise(() => {}) : null, { auth: 'u:p', cors: true });
const p2 = await srv2.start(0, false), b2 = 'http://127.0.0.1:' + p2;
r = await fetch(b2 + '/api'); ok('401 without login', r.status === 401 && r.headers.get('www-authenticate').startsWith('Basic'));
r = await fetch(b2 + '/api?a=1', { method: 'POST', body: 'x=1', headers: { authorization: 'Basic ' + Buffer.from('u:p').toString('base64') } });
const j = await r.json(); ok('basic auth + json + cors', j.m === 'POST' && j.q.a === '1' && j.body === 'x=1' && r.headers.get('access-control-allow-origin') === '*');
r = await fetch(b2 + '/x', { headers: { authorization: 'Basic ' + Buffer.from('u:bad').toString('base64') } }); ok('wrong password → 401', r.status === 401);
await srv2.stop();

// --- клиент против сервера Node ---
const node = http.createServer((q, s) => {
  if (q.url === '/redir') { s.writeHead(302, { location: '/target' }); return s.end(); }
  if (q.url === '/target') return s.end('arrived');
  if (q.url === '/chunked') { s.writeHead(200, { 'transfer-encoding': 'chunked' }); s.write('part1,'); setTimeout(() => s.end('part2'), 20); return; }
  if (q.url === '/nolen') { s.writeHead(200, { connection: 'close' }); s.write('close-delimited'); return setTimeout(() => s.end('!'), 20); }
  if (q.url === '/echo') { const a = []; q.on('data', (d) => a.push(d)); return q.on('end', () => s.end(JSON.stringify({ m: q.method, h: q.headers['x-t'], b: Buffer.concat(a).toString(), a: q.headers.authorization || '' }))); }
  if (q.url === '/big') return s.end(Buffer.alloc(500000, 9));
  s.writeHead(404); s.end('no');
});
await new Promise((res) => node.listen(0, '127.0.0.1', res));
const nb = 'http://127.0.0.1:' + node.address().port;
let c = await K.httpFetch(ns, nb + '/target'); ok('client GET', c.status === 200 && c.text() === 'arrived');
c = await K.httpFetch(ns, nb + '/redir'); ok('client follows redirect', c.text() === 'arrived' && c.url.endsWith('/target'));
c = await K.httpFetch(ns, nb + '/chunked'); ok('client chunked answer', c.text() === 'part1,part2');
c = await K.httpFetch(ns, nb + '/nolen'); ok('client close-delimited answer', c.text() === 'close-delimited!');
c = await K.httpFetch(ns, nb + '/echo', { method: 'POST', body: 'data', headers: { 'X-T': 'v' } }); const e = JSON.parse(c.text());
ok('client POST with headers', e.m === 'POST' && e.h === 'v' && e.b === 'data');
c = await K.httpFetch(ns, 'http://us:pw@127.0.0.1:' + node.address().port + '/echo'); ok('client url credentials', JSON.parse(c.text()).a === 'Basic ' + Buffer.from('us:pw').toString('base64'));
c = await K.httpFetch(ns, nb + '/big'); ok('client 500 KB', c.body.length === 500000);
c = await K.httpFetch(ns, nb + '/missing'); ok('client 404', c.status === 404 && c.text() === 'no');
ok('client rejects https', await K.httpFetch(ns, 'https://127.0.0.1/').then(() => false, (e) => /http:\/\//.test(e.message)));
ok('client refused', await K.httpFetch(ns, 'http://127.0.0.1:9/').then(() => false, () => true));
// сервер DSP ↔ клиент DSP
const s3 = new K.HttpServer(ns, async (req) => ({ text: 'hi ' + req.path })); const p3 = await s3.start(0, false);
c = await K.httpFetch(ns, 'http://127.0.0.1:' + p3 + '/dsp'); ok('DSP client ↔ DSP server', c.text() === 'hi /dsp');
await s3.stop(); node.close();

ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
