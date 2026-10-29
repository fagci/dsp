#!/usr/bin/env node
// Node-мост мессенджеров: страница (узел Messenger) открывает сюда WebSocket, а мост держит каналы, которых из браузера не достать
// (IRC и XMPP по TCP/TLS) — и, при желании, любые остальные (Nostr, ntfy, Matrix, Telegram) на стороне сервера.
// Код протоколов тот же, что у страницы: modules/msgr-kernels.js + msgr-session.js (грузятся через vm).
//
//   node tools/node/bridge.mjs                          только этот компьютер: ws://127.0.0.1:8777
//   node tools/node/bridge.mjs --host 0.0.0.0 --token секрет      для других устройств: ws://IP:8777/?token=секрет
//   --hosts irc.libera.chat,*.example.org               ограничить, к каким серверам мост вообще ходит
//
// Протокол (JSON-тексты): страница → {op:'open',proto,cfg} | {op:'send',text,to} | {op:'close'};
//                         мост → {ev:'hello'} | {ev:'status',text,state} | {ev:'msg',m}.
// Пароль уходит на мост в cfg — держи мост на localhost или за --token. Нужен Node 22+ (глобальные WebSocket и fetch).

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {wsAccept, wsFrame, wsParser, originOk, DEFAULT_ORIGINS} from '../termux/bridge.mjs';
import {loadMsgr} from './load.mjs';

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
    tcp(host, port, useTls, h) {
      guard(host);
      let sock = useTls ? tls.connect({host, port, servername: host}) : net.connect(port, host);
      const attach = s => {
        s.setEncoding('utf8');
        s.on('data', d => h.data(d));
        s.on('error', e => h.close(e.message));
        s.on('close', () => h.close(''));
      };
      sock.once(useTls ? 'secureConnect' : 'connect', () => h.open && h.open());
      attach(sock);
      return {
        write: s => { sock.write(s); },
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

export function createMsgrBridge(opt) {
  const o = {host: '127.0.0.1', port: 8777, token: '', origins: DEFAULT_ORIGINS, hosts: [], log: () => {}, ...opt};
  const M = loadMsgr();
  const io = o.io || nodeIo(o.hosts);
  const clients = new Set();

  const server = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'text/plain'});
    res.end('DSP messenger bridge: ' + clients.size + ' client(s)\nconnect with WebSocket\n');
  });
  server.on('upgrade', (req, sock) => {
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
    send({ev: 'hello', ver: 1, host: os.hostname(), protos: ['nostr', 'ntfy', 'matrix', 'telegram', 'irc', 'xmpp']});
  });

  return {
    server, clients,
    listen: () => new Promise((ok, bad) => { server.once('error', bad); server.listen(o.port, o.host, () => ok(server.address())); }),
    close: () => { for (const c of clients) { c.dead = true; try { c.ses && c.ses.close(); } catch (e) { /* закрыт */ } c.sock.destroy(); } clients.clear(); server.close(); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const {values: a} = parseArgs({options: {
    host: {type: 'string', default: '127.0.0.1'}, port: {type: 'string', default: '8777'}, token: {type: 'string', default: ''},
    origin: {type: 'string', multiple: true, default: []}, hosts: {type: 'string', default: ''}, help: {type: 'boolean', short: 'h', default: false},
  }});
  if (a.help) {
    console.log('node tools/node/bridge.mjs [--host 127.0.0.1] [--port 8777] [--token T] [--origin URL]… [--hosts irc.example.org,*.example.net]');
    process.exit(0);
  }
  if (a.host !== '127.0.0.1' && a.host !== 'localhost' && !a.token) console.error('warning: open to the network without --token — anyone on it can use your accounts through this bridge');
  const b = createMsgrBridge({host: a.host, port: +a.port, token: a.token, origins: [...DEFAULT_ORIGINS, ...a.origin],
    hosts: a.hosts.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    log: m => console.error(new Date().toISOString().slice(11, 19) + ' ' + m)});
  b.listen().then(ad => console.error('listening on ws://' + ad.address + ':' + ad.port + (a.token ? '/?token=…' : '')), e => { console.error(e.message); process.exit(1); });
  process.on('SIGINT', () => { b.close(); process.exit(0); });
}
