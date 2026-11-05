// Исходящий прокси моста (SOCKS5 / HTTP CONNECT): TCP, HTTP, WebSocket, CORS-прокси моста: node tools/test-outproxy.mjs
import net from 'node:net';
import http from 'node:http';
import {parseProxy, proxyConnect} from './node/proxy.mjs';
import {nodeIo, createMsgrBridge} from './node/bridge.mjs';
import {loadMsgr} from './node/load.mjs';
import {wsAccept, wsFrame, wsParser} from './termux/bridge.mjs';

let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];
const USER = 'u' + Math.random().toString(36).slice(2, 7), PASS = 'p' + Math.random().toString(36).slice(2, 9);

// ---- цели: TCP-эхо, HTTP, WebSocket-эхо ----
const echo = net.createServer(s => { s.on('data', d => s.write(Buffer.concat([Buffer.from('echo:'), d]))); s.on('error', () => {}); }); servers.push(echo);
const echoPort = await listen(echo);
const web = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { res.writeHead(200, {'content-type': 'application/json', 'x-seen': 'yes'}); res.end(JSON.stringify({m: req.method, u: req.url, body: b, ua: req.headers['user-agent'] || ''})); }); });
web.on('upgrade', (req, sock) => {
  sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
  sock.on('data', wsParser({onMsg: t => sock.write(wsFrame('srv:' + t)), onClose() { sock.end(); }, onPing() {}}));
  sock.write(wsFrame('hello'));
  sock.on('error', () => {});
}); servers.push(web);
const webPort = await listen(web);

// ---- прокси: SOCKS5 (с логином) и HTTP CONNECT; пишут, что им запросили ----
const seen = {socks: [], connect: []};
const socks = net.createServer(c => {
  c.on('error', () => {});
  let st = 0, buf = Buffer.alloc(0), authed = false;
  c.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (st === 0) { if (buf.length < 2 || buf.length < 2 + buf[1]) return; const meth = [...buf.subarray(2, 2 + buf[1])]; buf = buf.subarray(2 + buf[1]); if (!meth.includes(2)) { c.end(Buffer.from([5, 0xff])); return; } c.write(Buffer.from([5, 2])); st = 1; }
      else if (st === 1) { if (buf.length < 2) return; const ul = buf[1]; if (buf.length < 2 + ul + 1) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString(), p = buf.subarray(3 + ul, 3 + ul + pl).toString(); buf = buf.subarray(3 + ul + pl);
        if (u !== USER || p !== PASS) { c.end(Buffer.from([1, 1])); return; } authed = true; c.write(Buffer.from([1, 0])); st = 2; }
      else if (st === 2) { if (buf.length < 5) return; const at = buf[3]; const need = at === 3 ? 7 + buf[4] : at === 1 ? 10 : 22; if (buf.length < need) return;
        const host = at === 3 ? buf.subarray(5, 5 + buf[4]).toString() : at === 1 ? [...buf.subarray(4, 8)].join('.') : '?';
        const port = buf.readUInt16BE(need - 2); buf = buf.subarray(need); seen.socks.push({host, at, port});
        const up = net.connect(port, '127.0.0.1');   // всё имена (localhost) резолвим на loopback — это проверка, что имя дошло до прокси
        up.on('error', () => { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
        up.on('connect', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (buf.length) up.write(buf); c.pipe(up); up.pipe(c); st = 3; });
        c.removeAllListeners('data'); c.on('data', () => {}); return; } } });
}); servers.push(socks);
const socksPort = await listen(socks);
const hconn = net.createServer(c => {
  c.on('error', () => {});
  let buf = '';
  const on = d => { buf += d; const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    const head = buf.slice(0, i), m = /^CONNECT ([^ ]+) HTTP/.exec(head); seen.connect.push(head);
    const authOk = new RegExp('Proxy-Authorization: Basic ' + Buffer.from(USER + ':' + PASS).toString('base64')).test(head);
    c.removeListener('data', on);
    if (!m || !authOk) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [h, p] = m[1].split(':'); const up = net.connect(+p, '127.0.0.1');
    up.on('error', () => c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    up.on('connect', () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); c.pipe(up); up.pipe(c); }); };
  c.on('data', on); }); servers.push(hconn);
const connPort = await listen(hconn);

// ---- разбор адреса ----
{ const a = parseProxy('socks5://' + USER + ':' + PASS + '@10.0.0.1:1081'), b = parseProxy('http://proxy.lan:3128'), c = parseProxy({server: 'socks5h://h:9', user: 'x', pass: 'y'}), d = parseProxy('1.2.3.4:1080');
  ok('parse: socks5 with login in the url', a.kind === 'socks5' && a.host === '10.0.0.1' && a.port === 1081 && a.user === USER && a.pass === PASS);
  ok('parse: http connect, default port from the scheme', b.kind === 'http' && b.port === 3128);
  ok('parse: credential record', c.kind === 'socks5' && c.user === 'x' && c.pass === 'y' && c.port === 9);
  ok('parse: bare host:port is socks5', d.kind === 'socks5' && d.host === '1.2.3.4');
  ok('parse: empty is no proxy', parseProxy('') === null && parseProxy(null) === null);
  let e = null; try { parseProxy('ftp://x:1'); } catch (x) { e = x; }
  ok('parse: unknown scheme refused', !!e && /not supported/.test(e.message)); }

const sx = {server: 'socks5://127.0.0.1:' + socksPort, user: USER, pass: PASS}, hx = {server: 'http://127.0.0.1:' + connPort, user: USER, pass: PASS};

// ---- TCP через оба прокси ----
for (const [nm, px] of [['socks5', sx], ['http connect', hx]]) {
  const io = nodeIo([], px); const got = []; let opened = false, closed = null;
  const t = io.tcp('localhost', echoPort, false, {open: () => { opened = true; }, data: d => got.push(d), close: e => { closed = e; }});
  t.write('ping');                                                  // запись до соединения ждёт в очереди
  ok('tcp via ' + nm + ': echo comes back', !!(await until(() => got.join('') === 'echo:ping')) && opened, got.join());
  t.close();
}
ok('socks5 got the host NAME (DNS on the proxy side)', seen.socks.some(s => s.host === 'localhost' && s.at === 3 && s.port === echoPort), JSON.stringify(seen.socks));
ok('http connect carried the login', seen.connect.some(h => /^CONNECT localhost:\d+ HTTP/.test(h)), seen.connect.join('|'));
// неверный логин
{ const io = nodeIo([], {...sx, pass: 'nope'}); let err = null;
  io.tcp('localhost', echoPort, false, {data() {}, close: e => { err = e; }});
  ok('socks5: wrong password → close with a reason', !!(await until(() => err !== null)) && /login refused/.test(err), String(err)); }
{ const io = nodeIo([], {...hx, pass: 'nope'}); let err = null;
  io.tcp('localhost', echoPort, false, {data() {}, close: e => { err = e; }});
  ok('http connect: wrong password → 407 reported', !!(await until(() => err !== null)) && /407/.test(err), String(err)); }
{ const dead = net.createServer(); const p = await listen(dead); dead.close();
  const io = nodeIo([], {server: 'socks5://127.0.0.1:' + p}); let err = null;
  io.tcp('localhost', echoPort, false, {data() {}, close: e => { err = e; }});
  ok('proxy unreachable → close with a reason', !!(await until(() => err !== null)) && /ECONNREFUSED/.test(err), String(err)); }
{ let r = null; try { await proxyConnect(parseProxy(sx), 'localhost', 1); } catch (e) { r = e; }       // порт 1 закрыт: прокси отвечает «connection refused»
  ok('socks5: target refused → proxy error text', !!r && /proxy: /.test(r.message), String(r && r.message)); }

// ---- fetch ----
for (const [nm, px] of [['socks5', sx], ['http connect', hx]]) {
  const io = nodeIo([], px), cnt0 = seen.socks.length + seen.connect.length;
  const r = await io.fetch('http://localhost:' + webPort + '/a?x=1', {method: 'POST', headers: {'content-type': 'text/plain'}, body: 'тело'});
  const j = await r.json();
  ok('fetch via ' + nm + ': really went through the proxy', seen.socks.length + seen.connect.length === cnt0 + 1, nm);
  ok('fetch via ' + nm + ': method, path, body (utf-8) and headers', r.ok && r.headers.get('x-seen') === 'yes' && j.m === 'POST' && j.u === '/a?x=1' && j.body === 'тело', JSON.stringify(j));
}
{ const io = nodeIo([], sx), ac = new AbortController(); const p = io.fetch('http://localhost:' + webPort + '/', {signal: ac.signal}); ac.abort();
  let e = null; try { await p; } catch (x) { e = x; }
  ok('fetch: abort works', !!e); }

// ---- WebSocket ----
for (const [nm, px] of [['socks5', sx], ['http connect', hx]]) {
  const io = nodeIo([], px), got = [], cnt0 = seen.socks.length + seen.connect.length; let opened = false, closeCode = null;
  const ws = io.ws('ws://localhost:' + webPort + '/ws');
  ws.onopen = () => { opened = true; ws.send('привет'); }; ws.onmessage = e => got.push(e.data); ws.onclose = e => { closeCode = e.code; };
  ok('ws via ' + nm + ': hello, then echo of a utf-8 text', !!(await until(() => got.length >= 2)) && opened && got[0] === 'hello' && got[1] === 'srv:привет', JSON.stringify(got));
  ok('ws via ' + nm + ': really went through the proxy', seen.socks.length + seen.connect.length === cnt0 + 1, nm);
  ws.close();
  ok('ws via ' + nm + ': close is reported', !!(await until(() => closeCode !== null)));
}

// ---- мост целиком: --proxy по умолчанию и прокси сессии; CORS-прокси моста ----
{ const before = seen.socks.length;
  const br = createMsgrBridge({port: 0, outProxy: 'socks5://' + USER + ':' + PASS + '@127.0.0.1:' + socksPort, proxyLoopback: true}); const bp = (await br.listen()).port; servers.push({close: () => br.close()});
  const r = await fetch('http://127.0.0.1:' + bp + '/proxy?url=' + encodeURIComponent('http://localhost:' + webPort + '/via'));
  const j = await r.json();
  ok('bridge CORS proxy goes through the default proxy', r.status === 200 && j.u === '/via' && seen.socks.length > before, r.status + ' ' + JSON.stringify(j) + ' before=' + before + ' now=' + seen.socks.length); }
{ let e = null; try { createMsgrBridge({port: 0, outProxy: 'gopher://x:1'}); } catch (x) { e = x; }
  ok('bridge: a bad --proxy fails at once', !!e && /not supported/.test(e.message)); }

// ---- сессия мессенджера: прокси из учётки уходит мосту в open, и мост открывает канал через него ----
{ const M = loadMsgr(), before = seen.socks.length;
  const br = createMsgrBridge({port: 0}); const bp = (await br.listen()).port; servers.push({close: () => br.close()});
  const st = [];
  const s = M.mgConnect('ntfy', {server: 'http://localhost:' + webPort, channel: 'topic', bridge: 'ws://127.0.0.1:' + bp, via: 'bridge', proxy: sx, io: {}, retry: false}, {msg() {}, status: (t, k) => st.push([k, t])});
  ok('messenger session: the bridge opens the channel through the proxy from the credential', !!(await until(() => seen.socks.length > before)), JSON.stringify(st)); s.close();
  const before2 = seen.socks.length + seen.connect.length;
  const bad = M.mgConnect('ntfy', {server: 'http://localhost:' + webPort, channel: 't', bridge: 'ws://127.0.0.1:' + bp, via: 'bridge', proxy: {server: 'gopher://x:1'}, io: {}, retry: false}, {msg() {}, status: (t, k) => st.push([k, t])});
  ok('messenger session: a bad proxy is fatal and nothing leaves directly', !!(await until(() => st.some(x => x[0] === 'fatal' && /not supported/.test(x[1])))) && seen.socks.length + seen.connect.length === before2, JSON.stringify(st.at(-1))); bad.close(); }

for (const s of servers) { try { s.close(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
