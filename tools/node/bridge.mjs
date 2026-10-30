#!/usr/bin/env node
// Node-мост мессенджеров: страница (узел Messenger) открывает сюда WebSocket, а мост держит каналы, которых из браузера не достать
// (IRC и XMPP по TCP/TLS) — и, при желании, любые остальные (Nostr, ntfy, Matrix, Telegram) на стороне сервера.
// Код протоколов тот же, что у страницы: modules/msgr-kernels.js + msgr-session.js (грузятся через vm).
//
//   node tools/node/bridge.mjs                          только этот компьютер: ws://127.0.0.1:8777
//   node tools/node/bridge.mjs --host 0.0.0.0 --token секрет      для других устройств: ws://IP:8777/?token=секрет
//   --hosts irc.libera.chat,*.example.org               ограничить, к каким серверам мост вообще ходит
//
// Он же — CORS-прокси для всех модулей страницы: в Settings → CORS proxy впиши
//   http://127.0.0.1:8777/proxy?token=ТОКЕН&url={url}
// GET / HEAD (с Range) на любой http(s)-адрес, потоком — годятся MJPEG, HLS, радио. Защита: Origin и токен, --hosts, а мост не ходит на
// loopback / link-local / служебные адреса (--proxy-loopback разрешает loopback, --proxy-no-private запрещает и локальную сеть, --no-proxy выключает).
//
// Протокол (JSON-тексты): страница → {op:'open',proto,cfg} | {op:'send',text,to} | {op:'close'};
//                         мост → {ev:'hello'} | {ev:'status',text,state} | {ev:'msg',m}.
// Пароль уходит на мост в cfg — держи мост на localhost или за --token. Нужен Node 22+ (глобальные WebSocket и fetch).

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {wsAccept, wsFrame, wsParser, originOk, DEFAULT_ORIGINS} from '../termux/bridge.mjs';
import {loadMsgr} from './load.mjs';
import {prepareTls} from './tlsdir.mjs';

export function hostOk(host, allowed) {
  if (!allowed || !allowed.length) return true;
  host = String(host).toLowerCase();
  return allowed.some(p => p === host || (p.startsWith('*.') && host.endsWith(p.slice(1))));
}

// транспорты Node для сессий: ws / fetch — глобальные, tcp — net / tls (с переходом STARTTLS)
export function nodeIo(allowed = []) {
  const guard = h => { if (!hostOk(h, allowed)) throw new Error('host ' + h + ' is not in --hosts'); };
  const hostOf = u => new URL(u).hostname;
  return {
    ws: u => { guard(hostOf(u)); if (typeof WebSocket === 'undefined') throw new Error('Node 22+ is required (global WebSocket)'); return new WebSocket(u); },
    fetch: (u, o) => { guard(hostOf(String(u))); return fetch(u, o); },
    tcp(host, port, useTls, h, o = {}) {                       // o.binary — по символу на байт (latin1): почта, где важны длины литералов
      guard(host);
      const enc = o.binary ? 'latin1' : 'utf8';
      let sock = useTls ? tls.connect({host, port, servername: host}) : net.connect(port, host);
      const attach = s => {
        s.setEncoding(enc);
        s.on('data', d => h.data(d));
        s.on('error', e => h.close(e.message));
        s.on('close', () => h.close(''));
      };
      sock.once(useTls ? 'secureConnect' : 'connect', () => h.open && h.open());
      attach(sock);
      return {
        write: s => { sock.write(s, enc); },
        close: () => { sock.destroy(); },
        upgrade(done) {
          const raw = sock;
          raw.removeAllListeners('data'); raw.removeAllListeners('close'); raw.removeAllListeners('error'); raw.on('error', () => {});
          sock = tls.connect({socket: raw, servername: host});
          sock.once('secureConnect', done);
          attach(sock);
        },
      };
    },
  };
}


// ---------- HTTP-прокси (CORS) ----------
export function ipClass(ip) {                                // public | private | loopback | linklocal | unspecified | multicast | invalid
  let v = net.isIP(ip);
  if (!v) return 'invalid';
  if (v === 6) {
    const l = ip.toLowerCase();
    let m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (!m) { const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l); if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); m = [null, (a >> 8) + '.' + (a & 255) + '.' + (b >> 8) + '.' + (b & 255)]; } }
    if (m) { ip = m[1]; v = 4; }
    else {
      if (l === '::1') return 'loopback'; if (l === '::') return 'unspecified';
      if (/^fe[89ab]/.test(l)) return 'linklocal'; if (/^f[cd]/.test(l)) return 'private'; if (/^ff/.test(l)) return 'multicast';
      return 'public';
    }
  }
  const [a, b] = ip.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'linklocal';             // в том числе облачные метаданные 169.254.169.254
  if (a >= 224) return 'multicast';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}
const PROXY_CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': '*',
  'access-control-allow-private-network': 'true', 'access-control-expose-headers': '*', 'access-control-max-age': '600', vary: 'Origin'};
const PROXY_PASS_REQ = ['range', 'accept', 'accept-language', 'if-none-match', 'if-modified-since', 'if-range'];
const PROXY_PASS_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-encoding', 'expires'];
const sameToken = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function makeProxy(o) {
  const classOk = (cls, host) => cls === 'public' || (cls === 'private' && o.proxyPrivate !== false) || (cls === 'loopback' && !!o.proxyLoopback) || (o.hosts.length > 0 && hostOk(host, o.hosts) && cls !== 'invalid');
  const lookup = (hostname, opts, cb) => dns.lookup(hostname, opts, (err, addr, fam) => {   // проверяем адрес, который будет использован для соединения (без «DNS rebinding»)
    if (err) return cb(err);
    const list = Array.isArray(addr) ? addr : [{address: addr}];
    for (const a of list) if (!classOk(ipClass(a.address), hostname)) return cb(new Error('the address ' + a.address + ' of ' + hostname + ' is not allowed for the proxy'));
    cb(null, addr, fam);
  });
  let busy = 0;
  const fail = (res, code, msg) => { if (!res.headersSent) res.writeHead(code, {...PROXY_CORS, 'content-type': 'text/plain; charset=utf-8'}); res.end(msg + '\n'); };
  return function handle(req, res, u) {
    if (req.method === 'OPTIONS') { res.writeHead(204, PROXY_CORS); return res.end(); }
    if (!originOk(req.headers.origin, o.origins)) { o.log('proxy: origin refused: ' + req.headers.origin); return fail(res, 403, 'origin not allowed (--origin)'); }
    if (o.token && !sameToken(u.searchParams.get('token') || '', o.token)) return fail(res, 401, 'token');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'GET and HEAD only');
    if (busy >= 32) return fail(res, 429, 'too many proxied requests');
    // url — последний параметр: и закодированный (…&url=https%3A%2F%2F…), и «как есть» (…&url=https://x/y?a=1&b=2, когда в шаблоне нет {url})
    const um = /[?&]url=(.*)$/.exec(req.url);
    let target = ''; if (um) { try { target = /^https?:\/\//i.test(um[1]) ? um[1] : decodeURIComponent(um[1]); } catch (e) { return fail(res, 400, 'bad url'); } }
    const hdrs = {'user-agent': 'DSP-workbench proxy'};
    for (const k of PROXY_PASS_REQ) if (req.headers[k]) hdrs[k] = req.headers[k];
    busy++; let done = false; const release = () => { if (!done) { done = true; busy--; } };
    res.on('close', release);
    const go = (urlStr, depth) => {
      let t; try { t = new URL(urlStr); } catch (e) { return fail(res, 400, 'bad url'); }
      if (t.protocol !== 'http:' && t.protocol !== 'https:') return fail(res, 400, 'only http and https');
      const host = t.hostname.replace(/^\[|\]$/g, '');
      if (!hostOk(host, o.hosts)) return fail(res, 403, 'host ' + host + ' is not in --hosts');
      if (net.isIP(host) && !classOk(ipClass(host), host)) return fail(res, 403, 'the address ' + host + ' is not allowed for the proxy (' + ipClass(host) + ')');
      const lib = t.protocol === 'https:' ? https : http;
      const ureq = lib.request({host, port: t.port || (t.protocol === 'https:' ? 443 : 80), path: t.pathname + t.search, method: req.method, headers: {...hdrs, host: t.host}, lookup, timeout: 30000});
      res.on('close', () => ureq.destroy());
      ureq.on('timeout', () => ureq.destroy(new Error('the server does not answer')));
      ureq.on('error', e => fail(res, 502, 'proxy: ' + (e.message || e.code)));
      ureq.on('response', ur => {
        if ([301, 302, 303, 307, 308].includes(ur.statusCode) && ur.headers.location) {
          ur.resume();
          if (depth >= 5) return fail(res, 502, 'too many redirects');
          return go(new URL(ur.headers.location, t).toString(), depth + 1);
        }
        const out = {...PROXY_CORS};
        for (const k of PROXY_PASS_RES) if (ur.headers[k] !== undefined) out[k] = ur.headers[k];
        res.writeHead(ur.statusCode, out);
        ur.on('error', () => res.destroy());
        ur.pipe(res);
      });
      ureq.end();
    };
    go(target, 0);
  };
}

export function createMsgrBridge(opt) {
  const o = {host: '127.0.0.1', port: 8777, token: '', origins: DEFAULT_ORIGINS, hosts: [], proxy: true, proxyLoopback: false, proxyPrivate: true, log: () => {}, ...opt};
  const proxy = o.proxy ? makeProxy(o) : null;
  const M = loadMsgr();
  const io = o.io || nodeIo(o.hosts);
  const clients = new Set();

  let tlsInfo = null, tlsSrv = null;
  const onRequest = (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (proxy && u.pathname === '/proxy') return proxy(req, res, u);
    if (tlsInfo && tlsInfo.caPem && (u.pathname === '/ca.crt' || u.pathname === '/ca.pem')) {      // сертификат центра — публичный, его и ставят на устройство
      res.writeHead(200, {'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="dsp-bridge-ca.crt"', 'access-control-allow-origin': '*'});
      return res.end(tlsInfo.caPem);
    }
    res.writeHead(200, {'content-type': 'text/plain'});
    res.end('DSP messenger bridge: ' + clients.size + ' client(s)\nconnect with WebSocket' + (tlsInfo ? ' (ws:// and wss:// on this port)' : '') + (proxy ? '; CORS proxy: /proxy?url=…' : '') + (tlsInfo && tlsInfo.caPem ? '\nCA certificate to trust: /ca.crt' : '') + '\n');
  };
  const onUpgrade = (req, sock) => {
    const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
    const deny = code => { sock.end('HTTP/1.1 ' + code + '\r\nconnection: close\r\n\r\n'); };
    if (!key || /websocket/i.test(req.headers.upgrade || '') === false) return deny('400 Bad Request');
    if (!originOk(req.headers.origin, o.origins)) { o.log('origin refused: ' + req.headers.origin); return deny('403 Forbidden'); }
    if (o.token && u.searchParams.get('token') !== o.token) return deny('401 Unauthorized');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(key) + '\r\n\r\n');
    const c = {sock, ses: null, dead: false};
    clients.add(c);
    const send = rec => { if (!c.dead) try { sock.write(wsFrame(JSON.stringify(rec))); } catch (e) { c.dead = true; } };
    const stop = () => { if (c.ses) { try { c.ses.close(); } catch (e) { /* закрыт */ } c.ses = null; } };
    const bye = () => { if (clients.delete(c)) { c.dead = true; stop(); } };
    const par = wsParser({
      onMsg: t => {
        let m; try { m = JSON.parse(t); } catch (e) { return; }
        if (m.op === 'open' && typeof m.proto === 'string' && m.cfg && typeof m.cfg === 'object') {
          stop();
          // мост сам переподключается; io и via задаём сами — страница не может подсунуть чужой транспорт
          const {io: _i, cache: _c, bridge: _b, ...cfg} = m.cfg;
          o.log('open ' + m.proto + ' ' + String(cfg.server || '') + (cfg.channel ? ' ' + cfg.channel : ''));
          c.ses = M.mgConnect(m.proto, {...cfg, io, via: 'page', retry: true}, {
            msg: x => send({ev: 'msg', m: x}),
            status: (text, state) => { o.log(m.proto + ': ' + text); send({ev: 'status', text, state}); },
          });
        } else if (m.op === 'send' && c.ses) {
          Promise.resolve(c.ses.send(String(m.text || ''), m.to ? String(m.to) : undefined)).catch(() => {});
        } else if (m.op === 'close') stop();
      },
      onClose: () => { try { sock.end(wsFrame('', 8)); } catch (e) { /* закрыт */ } bye(); },
      onPing: p => { try { sock.write(wsFrame(p.toString(), 10)); } catch (e) { /* закрыт */ } },
    });
    sock.on('data', par); sock.on('close', bye); sock.on('error', bye);
    send({ev: 'hello', ver: 1, host: os.hostname(), protos: ['nostr', 'ntfy', 'matrix', 'telegram', 'irc', 'xmpp', 'aprs', 'email']});
  };
  const httpSrv = http.createServer(onRequest); httpSrv.on('upgrade', onUpgrade);
  // один порт — и ws:// / http://, и wss:// / https://: по первому байту (0x16 — TLS ClientHello) соединение отдаётся нужному серверу
  const server = net.createServer(sock => {
    sock.on('error', () => {}); sock.setTimeout(15000, () => sock.destroy());
    sock.once('data', d => { sock.setTimeout(0); sock.pause(); sock.unshift(d); (d[0] === 0x16 && tlsSrv ? tlsSrv : httpSrv).emit('connection', sock); process.nextTick(() => sock.resume()); });
  });

  return {
    server, clients, get tls() { return tlsInfo; },
    listen: async () => {
      if (o.tls || o.cert || o.key) {
        tlsInfo = await prepareTls(o, M, ip => ['private', 'loopback', 'linklocal'].includes(ipClass(ip)));
        tlsSrv = https.createServer({cert: tlsInfo.cert, key: tlsInfo.key, handshakeTimeout: 10000}, onRequest); tlsSrv.on('upgrade', onUpgrade); tlsSrv.on('tlsClientError', (e, s) => { try { s.destroy(); } catch (x) { /* закрыт */ } });      // с обработчиком Node сам сокет не закрывает
      }
      return new Promise((ok, bad) => { server.once('error', bad); server.listen(o.port, o.host, () => ok(server.address())); });
    },
    close: () => { for (const c of clients) { c.dead = true; try { c.ses && c.ses.close(); } catch (e) { /* закрыт */ } c.sock.destroy(); } clients.clear(); server.close(); for (const x of [httpSrv, tlsSrv]) { try { x && x.closeAllConnections && x.closeAllConnections(); } catch (e) { /* закрыт */ } } },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const {values: a} = parseArgs({options: {
    host: {type: 'string', default: '127.0.0.1'}, port: {type: 'string', default: '8777'}, token: {type: 'string', default: ''},
    origin: {type: 'string', multiple: true, default: []}, 'no-proxy': {type: 'boolean', default: false}, tls: {type: 'boolean', default: false}, 'tls-dir': {type: 'string', default: ''}, 'tls-name': {type: 'string', multiple: true, default: []}, cert: {type: 'string', default: ''}, key: {type: 'string', default: ''}, 'proxy-loopback': {type: 'boolean', default: false}, 'proxy-no-private': {type: 'boolean', default: false}, hosts: {type: 'string', default: ''}, help: {type: 'boolean', short: 'h', default: false},
  }});
  if (a.help) {
    console.log('node tools/node/bridge.mjs [--host 127.0.0.1] [--port 8777] [--token T] [--origin URL]… [--hosts irc.example.org,*.example.net] [--no-proxy] [--proxy-loopback] [--proxy-no-private] [--tls [--tls-dir DIR] [--tls-name name-or-ip]…] [--cert FILE --key FILE]');
    process.exit(0);
  }
  if (a.host !== '127.0.0.1' && a.host !== 'localhost' && !a.token) console.error('warning: open to the network without --token — anyone on it can use your accounts through this bridge');
  const b = createMsgrBridge({host: a.host, port: +a.port, token: a.token, origins: [...DEFAULT_ORIGINS, ...a.origin],
    hosts: a.hosts.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), proxy: !a['no-proxy'], tls: a.tls, tlsDir: a['tls-dir'], tlsNames: a['tls-name'], cert: a.cert, key: a.key, proxyLoopback: a['proxy-loopback'], proxyPrivate: !a['proxy-no-private'],
    log: m => console.error(new Date().toISOString().slice(11, 19) + ' ' + m)});
  b.listen().then(ad => {
    console.error('listening on ws://' + ad.address + ':' + ad.port + (a.token ? '/?token=…' : '') + (b.tls ? '  and  wss://…:' + ad.port : '') + (a['no-proxy'] ? '' : ' · CORS proxy: http' + (b.tls ? '(s)' : '') + '://' + ad.address + ':' + ad.port + '/proxy?' + (a.token ? 'token=…&' : '') + 'url={url}'));
    const t = b.tls;
    if (t && t.own) {
      console.error('TLS: certificate for ' + [...t.dns, ...t.ips].join(', ') + (t.regenerated ? '  (made now)' : '') + '  — files in ' + t.dir);
      console.error('TLS: trust this CA on every device that opens wss:// / https:// of this bridge (browser, phone):  ' + t.caFile + '   — or download http://<this address>:' + ad.port + '/ca.crt');
      console.error('TLS: CA SHA-256 fingerprint  ' + t.fingerprint + '   (compare it when you install the CA)');
    }
  }, e => { console.error(e.message); process.exit(1); });
  process.on('SIGINT', () => { b.close(); process.exit(0); });
}
