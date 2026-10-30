// TLS у Node-моста: один порт для ws:// и wss://, свой центр, скачивание CA, обновление сертификата: node tools/test-bridge-tls.mjs
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto, {X509Certificate} from 'node:crypto';
import {createMsgrBridge} from './node/bridge.mjs';
import {wsParser} from './termux/bridge.mjs';
import {loadMsgr} from './node/load.mjs';
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brtls-'));
const open = [];
const mk = async o => { const b = createMsgrBridge({port: 0, proxyLoopback: true, ...o}); const ad = await b.listen(); open.push(b); return {b, port: ad.port}; };
const httpGet = (port, p, o = {}) => new Promise(r => { const q = (o.tls ? https : http).get({port, host: '127.0.0.1', path: p, ca: o.ca, rejectUnauthorized: true, ...(o.servername ? {servername: o.servername} : {})}, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r({status: res.statusCode, headers: res.headers, body: d})); }); q.on('error', e => r({err: e.code || e.message})); });
// WebSocket-рукопожатие вручную, чтобы выбрать, чему доверять
const wsHello = (port, o = {}) => new Promise(r => {
  const onConn = sock => { sock.write('GET /?token=' + (o.token || '') + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    let buf = Buffer.alloc(0), head = false; sock.on('data', d => { buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (!head && i >= 0) { head = true; if (!/101/.test(buf.toString('latin1', 0, i))) { r({err: 'no 101'}); sock.destroy(); return; } buf = buf.subarray(i + 4); }
      if (head && buf.length > 2) { const n = buf[1] & 127; if (buf.length >= 2 + n) { r({hello: JSON.parse(buf.toString('utf8', 2, 2 + n)), proto: sock.encrypted ? 'tls' : 'plain'}); sock.destroy(); } } }); sock.on('error', e => r({err: e.code || e.message})); };
  if (o.tls) { const s = tls.connect({port, host: '127.0.0.1', ca: o.ca, servername: 'localhost'}, () => onConn(s)); s.on('error', e => r({err: e.code || e.message})); }
  else { const c = net.connect(port, '127.0.0.1', () => onConn(c)); c.on('error', e => r({err: e.code || e.message})); }
});

const dir = path.join(tmp, 'a');
const A = await mk({tls: true, tlsDir: dir});
ok('the bridge made a CA and a certificate on first start', A.b.tls.created === true && A.b.tls.regenerated === true && fs.existsSync(path.join(dir, 'ca.crt')) && fs.existsSync(path.join(dir, 'leaf.crt')));
ok('the CA key is private to the user (mode 600)', process.platform === 'win32' || (fs.statSync(path.join(dir, 'ca.key')).mode & 0o077) === 0 && (fs.statSync(path.join(dir, 'leaf.key')).mode & 0o077) === 0);
const ca = fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8');
ok('the certificate lists localhost, 127.0.0.1, ::1 and the LAN addresses', A.b.tls.dns.includes('localhost') && A.b.tls.ips.includes('127.0.0.1') && A.b.tls.ips.includes('::1') && A.b.tls.dns.some(n => /\.local$/.test(n)), JSON.stringify([A.b.tls.dns, A.b.tls.ips]));
// один порт: https и http
const t1 = await httpGet(A.port, '/', {tls: true, ca, servername: 'localhost'}); ok('https on the same port, trusted through the bridge CA', t1.status === 200 && /ws:\/\/ and wss:\/\//.test(t1.body), JSON.stringify(t1).slice(0, 200));
const t2 = await httpGet(A.port, '/'); ok('plain http on the same port still works', t2.status === 200);
const t3 = await httpGet(A.port, '/', {tls: true, servername: 'localhost'}); ok('without the CA a browser-like client refuses (self-made CA is not trusted by default)', !!t3.err, JSON.stringify(t3));
// ws и wss
const w1 = await wsHello(A.port); ok('ws:// handshake and greeting', w1.hello?.ev === 'hello' && w1.proto === 'plain', JSON.stringify(w1));
const w2 = await wsHello(A.port, {tls: true, ca}); ok('wss:// handshake and greeting on the same port', w2.hello?.ev === 'hello' && w2.proto === 'tls', JSON.stringify(w2));
// CA скачивается без TLS (его ещё не доверяют)
const c1 = await httpGet(A.port, '/ca.crt'); ok('/ca.crt is downloadable over plain http, as a certificate file', c1.status === 200 && c1.body === ca && /x509-ca-cert/.test(c1.headers['content-type']) && /dsp-bridge-ca\.crt/.test(c1.headers['content-disposition']));
ok('only the CA certificate is served, never a key', !/PRIVATE KEY/.test(c1.body) && !/PRIVATE KEY/.test((await httpGet(A.port, '/leaf.key')).body) && !/PRIVATE KEY/.test((await httpGet(A.port, '/ca.key')).body));
// прокси и токен работают и по TLS
const tgt = http.createServer((q, r) => { r.writeHead(200); r.end('target body'); }); await new Promise(r => tgt.listen(0, '127.0.0.1', r)); open.push({close: () => tgt.close()});
const p1 = await httpGet(A.port, '/proxy?url=' + encodeURIComponent('http://127.0.0.1:' + tgt.address().port + '/'), {tls: true, ca, servername: 'localhost'}); ok('the CORS proxy works over https too', p1.status === 200 && p1.body === 'target body', JSON.stringify(p1));
// TLS-мусор на plain-порту / не-TLS на TLS: не падаем
const junkT0 = Date.now(); const junk = await new Promise(r => { const c = net.connect(A.port, '127.0.0.1', () => { c.resume(); c.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0xff])); }); c.on('error', () => r('closed')); c.on('close', () => r('closed')); setTimeout(() => r('open'), 1500); });
ok('a broken TLS hello is dropped without breaking the bridge', junk === 'closed' && (await httpGet(A.port, '/')).status === 200, junk);
A.b.close();
// повторный запуск: тот же центр, тот же сертификат
const B = await mk({tls: true, tlsDir: dir});
ok('restart: the same CA and the same certificate are reused (trust is installed once)', B.b.tls.created === false && B.b.tls.regenerated === false && B.b.tls.fingerprint === A.b.tls.fingerprint && fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8') === ca);
B.b.close();
// новое имя: центр прежний, сертификат новый
const C = await mk({tls: true, tlsDir: dir, tlsNames: ['pi.local', '10.9.8.7']});
const leafC = new X509Certificate(fs.readFileSync(path.join(dir, 'leaf.crt'), 'utf8'));
ok('a new name: the certificate is made again for it, the CA stays (nothing to re-trust)', C.b.tls.regenerated === true && C.b.tls.fingerprint === A.b.tls.fingerprint && leafC.checkHost('pi.local') === 'pi.local' && !!leafC.checkIP('10.9.8.7') && leafC.verify(new X509Certificate(ca).publicKey));
C.b.close();
// имя вне разрешённого центром — отказ с понятным текстом
const refused = await createMsgrBridge({port: 0, tls: true, tlsDir: dir, tlsNames: ['example.com']}).listen().then(() => 'started', e => e.message);
ok('a name the (local-only) CA does not allow is refused with advice, not silently signed', /does not allow the name\(s\) example\.com/.test(refused) && /delete ca\.crt/.test(refused), refused);
// публичный IP в --tls-name просто не попадает в сертификат
const D = await mk({tls: true, tlsDir: path.join(tmp, 'd'), tlsNames: ['8.8.8.8']}); ok('a public IP address is not put into a certificate of a local CA', !D.b.tls.ips.includes('8.8.8.8')); D.b.close();
// --cert / --key: свои файлы (mkcert, Let's Encrypt), центр не раздаётся
const M = loadMsgr(); const own = await M.certNewCA({name: 'Own'}); const oleaf = await M.certNewLeaf(own, {dns: ['localhost'], ips: ['127.0.0.1']});
fs.writeFileSync(path.join(tmp, 'o.crt'), oleaf.chainPem); fs.writeFileSync(path.join(tmp, 'o.key'), oleaf.keyPem);
const E = await mk({cert: path.join(tmp, 'o.crt'), key: path.join(tmp, 'o.key')});
const e1 = await httpGet(E.port, '/', {tls: true, ca: own.pem, servername: 'localhost'}); ok('--cert / --key: the given certificate is used', e1.status === 200);
ok('--cert / --key: no CA is offered for download (it is not ours)', (await httpGet(E.port, '/ca.crt')).body.startsWith('DSP messenger bridge'));
ok('--cert without --key is an error', await createMsgrBridge({port: 0, cert: path.join(tmp, 'o.crt')}).listen().then(() => false, e => /go together/.test(e.message)));
// без --tls порт остаётся прежним: TLS не включается
const F = await mk({}); ok('without --tls there is no TLS at all', F.b.tls === null && (await httpGet(F.port, '/', {tls: true, ca, servername: 'localhost'})).err !== undefined);
for (const x of open) try { x.close(); } catch (e) {}
fs.rmSync(tmp, {recursive: true, force: true});
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
