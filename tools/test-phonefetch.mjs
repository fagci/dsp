// HTTP через сокеты телефона (шлюз — приложение DSP): запросы, chunked, редиректы, gzip, ошибки, RSS: node tools/test-phonefetch.mjs
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import {loadMsgr} from './node/load.mjs';
import {nodeIo} from './node/bridge.mjs';
import {wsAccept, wsFrame, wsParser} from './termux/bridge.mjs';

const M = loadMsgr({Response, Headers, Blob, DecompressionStream, Uint8Array}), io = nodeIo();
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];

// ---- «сайт» ----
const FEED = '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Новости</title>'
  + '<item><title>Первая новость</title><link>http://x/1</link><guid>g1</guid><pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate></item>'
  + '<item><title>Вторая новость</title><link>http://x/2</link><guid>g2</guid><pubDate>Wed, 05 Nov 2026 11:00:00 GMT</pubDate></item></channel></rss>';
const seen = [];
const site = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    seen.push({m: req.method, u: req.url, h: req.headers, b});
    const u = req.url.split('?')[0];
    if (u === '/plain') { res.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'x-k': 'v'}); return res.end('привет, телефон'); }
    if (u === '/chunked') { res.writeHead(200, {'transfer-encoding': 'chunked', 'content-type': 'text/plain; charset=utf-8'}); res.write('часть '); await sleep(40); res.write('раз, '); await sleep(40); res.end('конец'); return; }
    if (u === '/redir') { res.writeHead(302, {location: '/plain'}); return res.end(); }
    if (u === '/gzip') { const z = zlib.gzipSync('сжатый ответ'); res.writeHead(200, {'content-encoding': 'gzip', 'content-length': z.length}); return res.end(z); }
    if (u === '/close') { res.writeHead(200, {connection: 'close'}); res.write('до закрытия'); return res.end(); }
    if (u === '/missing') { res.writeHead(404, {'content-type': 'text/plain'}); return res.end('нет такого'); }
    if (u === '/post') { res.writeHead(200, {'content-type': 'application/json'}); return res.end(JSON.stringify({got: b, ct: req.headers['content-type'], len: req.headers['content-length']})); }
    if (u === '/feed.xml') { res.writeHead(200, {'content-type': 'application/rss+xml; charset=utf-8'}); return res.end(FEED); }
    if (u === '/cut') { res.socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nshort'); return setTimeout(() => res.socket.destroy(), 30); }
    if (u === '/slow') { await sleep(2000); res.writeHead(200); return res.end('late'); }
    res.writeHead(404); res.end();
  });
}); servers.push(site);
const sp = await listen(site), base = 'http://127.0.0.1:' + sp;

// ---- телефон: имитация NetHub (tcp.connect / send / starttls / close) ----
const cmds = [];
const phone = http.createServer(); servers.push(phone);
phone.on('upgrade', (req, sock) => {
  sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
  const send = a => { try { sock.write(wsFrame(JSON.stringify(a))); } catch (e) { /* закрыт */ } };
  const conns = new Map(); let nid = 100;
  send({src: 'bridge', level: 'hello', app: 'dsp-android', host: 'Pixel'});
  sock.on('data', wsParser({onMsg: t => { const m = JSON.parse(t); if (m.sub) return; cmds.push(m);
    const done = (extra = {}) => send({src: 'cmd', cmd: m.cmd, id: m.id, ok: true, ...extra});
    if (m.cmd === 'tcp.connect') { const s = net.connect(m.port, m.host), n = ++nid;
      s.on('connect', () => { conns.set(n, s); send({src: 'net', ev: 'open', conn: n, proto: 'tcp'}); done({conn: n}); });
      s.on('error', e => send({src: 'cmd', cmd: m.cmd, id: m.id, ok: false, err: 'error', msg: e.message}));
      s.on('data', d => send({src: 'net', ev: 'data', conn: n, proto: 'tcp', hex: d.toString('hex'), n: d.length}));
      s.on('close', () => send({src: 'net', ev: 'close', conn: n, proto: 'tcp'})); }
    else if (m.cmd === 'tcp.send') { conns.get(m.conn)?.write(Buffer.from(m.hex, 'hex')); done({n: m.hex.length / 2}); }
    else if (m.cmd === 'tcp.starttls') done();
    else if (m.cmd === 'tcp.close') { conns.get(m.conn)?.destroy(); done(); } }, onClose() {}, onPing() {}}));
  sock.on('error', () => {});
});
const pp = await listen(phone), phoneCfg = {url: 'ws://127.0.0.1:' + pp, key: 'APPKEY'};
const pf = M.mgPhoneFetch({...phoneCfg, io});

// ---- запросы ----
{ const r = await pf(base + '/plain?x=1&y=%D0%B0');
  const pt = await r.text();
  ok('plain: status, ok, header, utf-8 text', r.status === 200 && r.ok && r.headers.get('x-k') === 'v' && pt === 'привет, телефон', r.status + ' ' + r.ok + ' ' + r.headers.get('x-k') + ' ' + pt);
  const q = seen.at(-1);
  ok('plain: the request line keeps the query; Host, identity encoding and close are sent', q.m === 'GET' && q.u === '/plain?x=1&y=%D0%B0' && q.h.host === '127.0.0.1:' + sp && q.h['accept-encoding'] === 'identity' && q.h.connection === 'close', JSON.stringify(q.h)); }
ok('chunked: the chunks are joined (utf-8 across chunks)', await (await pf(base + '/chunked')).text() === 'часть раз, конец');
{ const r = await pf(base + '/redir'); ok('redirect: followed to the target', r.status === 200 && await r.text() === 'привет, телефон' && seen.some(x => x.u === '/redir') && seen.some(x => x.u === '/plain')); }
ok('gzip: unpacked when the server compresses anyway', await (await pf(base + '/gzip')).text() === 'сжатый ответ');
ok('no length: the answer ends with the connection', await (await pf(base + '/close')).text() === 'до закрытия');
{ const r = await pf(base + '/missing'); ok('404 is an answer, not an error', r.status === 404 && !r.ok && await r.text() === 'нет такого'); }
{ const r = await pf(base + '/post', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({текст: 'привет'})});
  const j = await r.json();
  ok('POST: the body is sent as utf-8 with its length and type', j.got === '{"текст":"привет"}' && j.ct === 'application/json' && +j.len === Buffer.byteLength('{"текст":"привет"}'), JSON.stringify(j)); }
{ let e = null; try { await pf(base + '/cut'); } catch (x) { e = x; } ok('a cut off answer is an error with a reason', e && e.name === 'TypeError' && /cut off/.test(e.message), String(e)); }
{ let e = null; const ac = new AbortController(); const p = pf(base + '/slow', {signal: ac.signal}); setTimeout(() => ac.abort(), 100); try { await p; } catch (x) { e = x; } ok('abort works', !!e && e.name === 'AbortError', String(e)); }
const conn = cmds.filter(c => c.cmd === 'tcp.connect');
{ const dead = net.createServer(); const dp = await listen(dead); dead.close();
  let e = null; try { await pf('http://127.0.0.1:' + dp + '/'); } catch (x) { e = x; } ok('an unreachable host is a TypeError (fetch-like)', !!e && e.name === 'TypeError', String(e)); }
{ let e = null; try { await pf('ftp://x/'); } catch (x) { e = x; } ok('only http and https', !!e && e.name === 'TypeError'); }
ok('every request opens its own socket on the phone', conn.length >= 8 && conn.every(c => c.host === '127.0.0.1' && c.port === sp), String(conn.length));

// ---- RSS через шлюз-телефон ----
{ const msgs = [], st = [];
  const s = M.mgConnect('rss', {server: base + '/feed.xml', history: 1e9, retry: false, via: 'page', phone: phoneCfg, io: {}}, {msg: m => msgs.push(m), status: (t, k) => st.push([k, t])});
  await until(() => msgs.length >= 2, 6000);
  ok('RSS through the phone: both news items arrive (no CORS involved)', msgs.length === 2 && msgs.some(m => /Первая новость/.test(m.text)) && msgs.some(m => /Вторая новость/.test(m.text)), JSON.stringify(msgs.map(m => m.text)) + JSON.stringify(st));
  s.close(); }
// шлюз-телефон и страница без своего fetch: ошибка называет причину, а не советует «задать шлюз»
{ const st = [];
  const s = M.mgConnect('rss', {server: 'http://127.0.0.1:1/feed.xml', retry: false, via: 'page', phone: phoneCfg, io: {}}, {msg() {}, status: (t, k) => st.push([k, t])});
  await until(() => st.some(x => x[0] === 'fatal'), 6000);
  ok('RSS through the phone: a failure says it could not be read through the phone', st.some(x => /through the phone/.test(x[1])) && !st.some(x => /set the TCP gateway/.test(x[1])), JSON.stringify(st));
  s.close(); }

for (const s of servers) { try { s.close(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
