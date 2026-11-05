// Исходящий прокси для Node-моста: SOCKS5 (с логином и паролем, имя хоста резолвит прокси) и HTTP CONNECT.
// Через него ходят все каналы Messenger, которые мост открывает сам: TCP (IRC, XMPP, APRS-IS, почта), HTTP (Matrix, ntfy, Telegram, ленты)
// и WebSocket (Nostr, IRC по ws). Прокси задаётся учёткой типа proxy (Settings → Credentials) и приходит с запросом open.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {wsAccept} from '../termux/bridge.mjs';

// «socks5://user:pass@host:1080», «socks5h://…», «http://host:3128»; либо {server, user, pass} (запись учётки)
export function parseProxy(p) {
  if (!p) return null;
  if (typeof p === 'object' && p.kind && p.host) return p;        // уже разобран
  let server = '', user = '', pass = '';
  if (typeof p === 'string') server = p.trim(); else { server = String(p.server || '').trim(); user = String(p.user || ''); pass = String(p.pass || ''); }
  if (!server) return null;
  let u; try { u = new URL(/^[a-z0-9+.-]+:\/\//i.test(server) ? server : 'socks5://' + server); } catch (e) { throw new Error('proxy: bad address «' + server + '» (socks5://host:1080 or http://host:3128)'); }
  const proto = u.protocol.replace(':', '').toLowerCase();
  const kind = /^socks5h?$/.test(proto) ? 'socks5' : proto === 'http' || proto === 'https' ? 'http' : '';
  if (!kind) throw new Error('proxy: «' + proto + '» is not supported (socks5:// or http://)');
  if (u.username && !user) user = decodeURIComponent(u.username);
  if (u.password && !pass) pass = decodeURIComponent(u.password);
  return {kind, host: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port || (kind === 'socks5' ? 1080 : proto === 'https' ? 443 : 3128), user, pass, tls: proto === 'https'};
}

// читатель ответа прокси: один постоянный обработчик и буфер; stop() возвращает сокет потребителю (остаток данных — обратно в поток)
function reader(sock) {
  let buf = Buffer.alloc(0), want = null, dead = null;
  const flush = () => {
    if (want && buf.length >= want.n) { const w = want; want = null; const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.ok(out); }
    else if (want && dead) { const w = want; want = null; w.bad(dead); }
  };
  const on = d => { buf = Buffer.concat([buf, d]); flush(); };
  const err = e => { dead = e; flush(); }, cls = () => { dead = dead || new Error('proxy closed the connection'); flush(); };
  sock.on('data', on); sock.on('error', err); sock.on('close', cls);
  return {
    take: n => new Promise((ok, bad) => { want = {n, ok, bad}; flush(); }),
    stop() { sock.off('data', on); sock.off('error', err); sock.off('close', cls); if (buf.length) { sock.pause(); sock.unshift(buf); } },
  };
}

// сокет, уже соединённый через прокси с host:port (Promise); дальше — как обычный net.Socket
export async function proxyConnect(px, host, port, timeoutMs = 20000) {
  const sock = px.tls ? tls.connect({host: px.host, port: px.port, servername: px.host}) : net.connect(px.port, px.host);
  sock.setNoDelay(true);
  const fail = e => { try { sock.destroy(); } catch (x) { /* закрыт */ } throw e; };
  const rd = reader(sock), readN = (_s, n) => rd.take(n);
  const timer = setTimeout(() => sock.destroy(new Error('proxy: timeout')), timeoutMs);
  try {
    await new Promise((ok, bad) => { sock.once(px.tls ? 'secureConnect' : 'connect', ok); sock.once('error', bad); });
    if (px.kind === 'socks5') {
      const auth = !!(px.user || px.pass);
      sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
      const m = await readN(sock, 2);
      if (m[0] !== 5) throw new Error('proxy: not a SOCKS5 server');
      if (m[1] === 2) {
        const u = Buffer.from(px.user), p = Buffer.from(px.pass);
        if (u.length > 255 || p.length > 255) throw new Error('proxy: login or password too long');
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        const a = await readN(sock, 2);
        if (a[1] !== 0) throw new Error('proxy: login refused');
      } else if (m[1] !== 0) throw new Error(m[1] === 0xff ? 'proxy: no acceptable login method' : 'proxy: unsupported method');
      const ip = net.isIP(host), h = Buffer.from(host);
      if (!ip && h.length > 255) throw new Error('proxy: host name too long');
      const addr = ip === 4 ? Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))])
        : ip === 6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
          : Buffer.concat([Buffer.from([3, h.length]), h]);             // имя хоста отдаём прокси — DNS на его стороне
      sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
      const r = await readN(sock, 4);
      const REP = ['', 'general failure', 'not allowed by the proxy rules', 'network unreachable', 'host unreachable', 'connection refused', 'TTL expired', 'command not supported', 'address type not supported'];
      if (r[1] !== 0) throw new Error('proxy: ' + (REP[r[1]] || 'error ' + r[1]));
      await readN(sock, r[3] === 1 ? 6 : r[3] === 4 ? 18 : (await readN(sock, 1))[0] + 2);
    } else {
      const target = (net.isIPv6(host) ? '[' + host + ']' : host) + ':' + port;
      sock.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n' + (px.user || px.pass ? 'Proxy-Authorization: Basic ' + Buffer.from(px.user + ':' + px.pass).toString('base64') + '\r\n' : '') + '\r\n');
      let head = '';
      for (;;) {
        const b = (await readN(sock, 1))[0]; head += String.fromCharCode(b);
        if (head.endsWith('\r\n\r\n')) break;
        if (head.length > 8192) throw new Error('proxy: bad reply');
      }
      const st = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!st || st[1][0] !== '2') throw new Error('proxy: ' + (st ? (st[1] === '407' ? 'login refused (407)' : 'refused (' + st[1] + ')') : 'bad reply'));
    }
  } catch (e) { clearTimeout(timer); rd.stop(); return fail(e); }
  clearTimeout(timer); rd.stop();
  return sock;
}
function ipv6Bytes(s) {
  const [a, b = ''] = s.split('::'), hex = x => x ? x.split(':').filter(Boolean) : [];
  const L = hex(a), R = hex(b), mid = s.includes('::') ? 8 - L.length - R.length : 0, all = [...L, ...Array(mid).fill('0'), ...R];
  return Buffer.from(all.flatMap(x => { const v = parseInt(x || '0', 16); return [v >> 8, v & 255]; }));
}

// соединение с TLS поверх туннеля, если нужно
export async function proxyStream(px, host, port, useTls) {
  const raw = await proxyConnect(px, host, port);
  if (!useTls) return raw;
  const t = tls.connect({socket: raw, servername: net.isIP(host) ? undefined : host});
  await new Promise((ok, bad) => { t.once('secureConnect', ok); t.once('error', bad); });
  return t;
}

// fetch через прокси: http(s)-запрос с туннелированным сокетом; ответ — настоящий Response (json(), text(), body-поток)
export function makeProxyFetch(px, guard = () => {}) {
  return (input, o = {}) => new Promise((ok, bad) => {
    let u; try { u = new URL(String(input)); } catch (e) { return bad(new TypeError('bad url')); }
    try { guard(u.hostname); } catch (e) { return bad(e); }
    const secure = u.protocol === 'https:', port = +u.port || (secure ? 443 : 80);
    const headers = {...(o.headers || {})};
    const body = o.body == null ? null : typeof o.body === 'string' ? Buffer.from(o.body) : Buffer.from(o.body);
    if (body && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) headers['content-length'] = body.length;
    const lib = secure ? https : http;
    const req = lib.request({
      host: u.hostname, port, path: u.pathname + u.search, method: o.method || 'GET', headers,
      createConnection: (opt, cb) => { proxyStream(px, u.hostname, port, secure).then(s => cb(null, s), cb); },     // без agent: с agent:false Node берёт свой агент и игнорирует createConnection
    }, res => {
      const h = new Headers(); for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
      const nobody = res.statusCode === 204 || res.statusCode === 304;
      ok(new Response(nobody ? null : Readable.toWeb(res), {status: res.statusCode, statusText: res.statusMessage, headers: h}));
    });
    req.on('error', e => bad(e));
    if (o.signal) { if (o.signal.aborted) req.destroy(new Error('aborted')); else o.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true}); }
    if (body) req.write(body);
    req.end();
  });
}

// WebSocket-клиент через прокси (текстовые кадры, ping, close): onopen / onmessage({data}) / onerror / onclose({code}), send, close
export function makeProxyWs(px, guard = () => {}) {
  return urlStr => {
    const u = new URL(urlStr); guard(u.hostname);
    const secure = u.protocol === 'wss:', port = +u.port || (secure ? 443 : 80);
    const ws = {readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null};
    let sock = null, closed = false;
    const fire = (k, ev) => { try { ws[k] && ws[k](ev); } catch (e) { /* обработчик страницы */ } };
    const finish = code => { if (closed) return; closed = true; ws.readyState = 3; try { sock && sock.destroy(); } catch (e) { /* закрыт */ } fire('onclose', {code}); };
    const frame = (op, payload) => {
      const p = Buffer.from(payload), n = p.length, m = crypto.randomBytes(4);
      const h = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127, 0, 0, 0, 0]), Buffer.from([n >>> 24, n >>> 16, n >>> 8, n].map(x => x & 255))]);
      const q = Buffer.from(p); for (let i = 0; i < n; i++) q[i] ^= m[i & 3];
      return Buffer.concat([h, m, q]);
    };
    ws.send = s => { if (ws.readyState !== 1) throw new Error('not open'); sock.write(frame(1, String(s))); };
    ws.close = () => { if (ws.readyState === 1) { try { sock.write(frame(8, Buffer.alloc(0))); } catch (e) { /* закрыт */ } } finish(1000); };
    (async () => {
      try {
        sock = await proxyStream(px, u.hostname, port, secure);
        const key = crypto.randomBytes(16).toString('base64');
        sock.write('GET ' + (u.pathname || '/') + u.search + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
        let buf = Buffer.alloc(0), up = false, msg = [];
        sock.on('data', d => {
          buf = Buffer.concat([buf, d]);
          if (!up) {
            const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
            const head = buf.subarray(0, i).toString('latin1'); buf = buf.subarray(i + 4);
            if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(wsAccept(key).toLowerCase())) { fire('onerror', {}); return finish(1002); }
            up = true; ws.readyState = 1; fire('onopen', {});
          }
          for (;;) {
            if (buf.length < 2) return;
            const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
            let len = buf[1] & 127, o = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); o = 10; }
            if (buf.length < o + (masked ? 4 : 0) + len) return;
            const pl = Buffer.from(buf.subarray(o + (masked ? 4 : 0), o + (masked ? 4 : 0) + len));
            buf = buf.subarray(o + (masked ? 4 : 0) + len);
            if (op === 8) return finish(pl.length >= 2 ? pl.readUInt16BE(0) : 1005);
            if (op === 9) { sock.write(frame(10, pl)); continue; }
            if (op === 1 || op === 2 || op === 0) { msg.push(pl); if (fin) { const t = Buffer.concat(msg).toString(); msg = []; fire('onmessage', {data: t}); } }
          }
        });
        sock.on('error', () => { fire('onerror', {}); finish(1006); });
        sock.on('close', () => finish(1006));
      } catch (e) { fire('onerror', {message: e.message}); finish(1006); }
    })();
    return ws;
  };
}

// io.tcp через прокси: тот же интерфейс {write, close, upgrade}, что у обычного сокета моста; записи до соединения ждут в очереди
export function proxyTcp(px, host, port, useTls, h, o = {}) {
  const enc = o.binary ? 'latin1' : 'utf8';
  let sock = null, dead = false; const queue = [];
  const attach = s => {
    s.setEncoding(enc);
    s.on('data', d => h.data(d));
    s.on('error', e => { if (!dead) h.close(e.message); });
    s.on('close', () => { if (!dead) h.close(''); });
  };
  proxyStream(px, host, port, useTls).then(s => {
    if (dead) return s.destroy();
    sock = s; attach(s); s.resume();
    for (const q of queue.splice(0)) s.write(q, enc);
    if (h.open) h.open();
  }, e => { if (!dead) h.close(e.message); });
  return {
    write: s => { if (sock) sock.write(s, enc); else queue.push(s); },
    close: () => { dead = true; if (sock) sock.destroy(); },
    upgrade(done) {
      const raw = sock;
      raw.removeAllListeners('data'); raw.removeAllListeners('close'); raw.removeAllListeners('error'); raw.on('error', () => {});
      sock = tls.connect({socket: raw, servername: net.isIP(host) ? undefined : host});
      sock.once('secureConnect', done);
      attach(sock);
    },
  };
}
