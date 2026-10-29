// Сессии мессенджеров против настоящих сокетов (локальные имитации серверов) + Node-мост: node tools/test-msgr-net.mjs
import http from 'node:http';
import net from 'node:net';
import {loadMsgr} from './node/load.mjs';
import {nodeIo, createMsgrBridge} from './node/bridge.mjs';
import {wsAccept, wsFrame, wsParser} from './termux/bridge.mjs';

const M = loadMsgr(), io = nodeIo();
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
const rig = (proto, cfg) => {
  const r = {msgs: [], st: [], s: null};
  r.s = M.mgConnect(proto, {retry: false, via: 'page', io, ...cfg}, {msg: m => r.msgs.push(m), status: (t, s) => r.st.push([s, t])});
  r.state = () => (r.st[r.st.length - 1] || [])[0];
  return r;
};
const servers = [];
// пароли и токены тестов — случайные на каждый запуск, не литералы (сканеры секретов принимают их за настоящие)
const rnd = () => Math.random().toString(36).slice(2, 10);
const PW = rnd(), TOK = rnd(), TG = rnd() + ':' + rnd(), IRC_PW = rnd(), BAD = rnd();

// ---- Nostr: имитация реле ----
{ const subs = new Set();
  const srv = http.createServer(); servers.push(srv);
  srv.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    const me = {sock, sub: null};
    subs.add(me);
    const send = a => { try { sock.write(wsFrame(JSON.stringify(a))); } catch (e) {} };
    sock.on('data', wsParser({onMsg: t => {
      const a = JSON.parse(t);
      if (a[0] === 'REQ') me.sub = a[1];
      else if (a[0] === 'EVENT') { send(['OK', a[1].id, true, '']); for (const o of subs) if (o.sub) o.send(['EVENT', o.sub, a[1]]); }
    }, onClose() {}, onPing() {}}));
    me.send = send;
    sock.on('close', () => subs.delete(me)); sock.on('error', () => {});
  });
  const port = await listen(srv), url = 'ws://127.0.0.1:' + port;
  const A = rig('nostr', {server: url, channel: 'dsp-test', nick: 'аня'}), B = rig('nostr', {server: url, channel: '#dsp-test', nick: 'bob'});
  await until(() => A.state() === 'up' && B.state() === 'up');
  ok('nostr connected', A.state() === 'up' && B.state() === 'up', JSON.stringify(A.st));
  await sleep(100);
  ok('nostr send', A.s.send('привет 👋') === true);
  await until(() => A.msgs.length && B.msgs.length);
  ok('nostr peer gets it', B.msgs[0]?.text === 'привет 👋' && B.msgs[0].from === 'аня' && !B.msgs[0].self, JSON.stringify(B.msgs));
  ok('nostr own message comes back as self', A.msgs[0]?.self === true);
  // подделка: событие с чужой подписью не должно дойти
  const forged = M.mgNostrSign(M.mgNostrGenKey(), {created_at: 1, kind: 1, tags: [['t', 'dsp-test']], content: 'forged'});
  forged.content = 'tampered';
  for (const o of subs) if (o.sub) o.send(['EVENT', o.sub, forged]);
  await sleep(150);
  ok('forged event dropped', !B.msgs.some(m => /tampered|forged/.test(m.text)));
  A.s.close(); B.s.close();
}

// ---- ntfy ----
{ const streams = new Set(); let id = 0;
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/room/json')) { res.writeHead(200, {'content-type': 'application/x-ndjson'}); res.write('{"event":"open"}\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (req.method === 'POST' && req.url === '/room') {
      const text = await body(req), title = req.headers.title || '';
      const line = JSON.stringify({id: 'id' + (++id), time: 1700000000, event: 'message', topic: 'room', message: text, title: title.startsWith('=?UTF-8?B?') ? Buffer.from(title.slice(10, -2), 'base64').toString() : title, tags: (req.headers.tags || '').split(',')});
      for (const s of streams) s.write(line + '\n');
      res.end('{}'); return;
    }
    res.writeHead(404); res.end();
  }); servers.push(srv);
  const port = await listen(srv), server = 'http://127.0.0.1:' + port;
  const A = rig('ntfy', {server, channel: 'room', nick: 'аня'}), B = rig('ntfy', {server, channel: 'room', nick: 'bob'});
  await until(() => A.state() === 'up' && B.state() === 'up');
  ok('ntfy subscribed', A.state() === 'up', JSON.stringify(A.st));
  ok('ntfy publish', await A.s.send('hello ntfy') === true);
  await until(() => A.msgs.length && B.msgs.length);
  ok('ntfy peer gets it (non-ASCII nick via RFC 2047)', B.msgs[0]?.text === 'hello ntfy' && B.msgs[0].from === 'аня' && !B.msgs[0].self, JSON.stringify(B.msgs));
  ok('ntfy own message flagged', A.msgs[0]?.self === true);
  const C = rig('ntfy', {server, channel: 'nope'}); await until(() => C.state() === 'fatal');
  ok('ntfy 404 is fatal', C.state() === 'fatal', JSON.stringify(C.st));
  A.s.close(); B.s.close(); for (const s of streams) s.end();
}

// ---- Matrix ----
{ const sent = []; const pending = []; let logins = 0, syncs = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), js = o => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    const auth = req.headers.authorization === 'Bearer ' + TOK;
    if (u.pathname === '/_matrix/client/v3/login') { logins++; const b = JSON.parse(await body(req)); return b.password === PW ? js({access_token: TOK, user_id: '@me:hs'}) : (res.writeHead(403), res.end('{"errcode":"M_FORBIDDEN","error":"bad password"}')); }
    if (!auth) { res.writeHead(401); return res.end('{"errcode":"M_UNKNOWN_TOKEN","error":"nope"}'); }
    if (u.pathname.endsWith('/join/!r%3Ahs') || u.pathname.includes('/join/')) { await body(req); return js({room_id: '!r:hs'}); }
    if (u.pathname.endsWith('/account/whoami')) return js({user_id: '@me:hs'});
    if (u.pathname.endsWith('/sync')) {
      syncs++;
      if (!u.searchParams.get('since')) return js({next_batch: 'b0', rooms: {join: {'!r:hs': {timeline: {events: [{type: 'm.room.message', event_id: '$old', sender: '@old:hs', content: {msgtype: 'm.text', body: 'history'}}]}}}}});
      for (let i = 0; i < 100 && !pending.length; i++) await sleep(20);
      const evs = pending.splice(0);
      return js({next_batch: 'b' + syncs, rooms: {join: {'!r:hs': {timeline: {events: evs}}}}});
    }
    if (req.method === 'PUT' && u.pathname.includes('/send/m.room.message/')) {
      const b = JSON.parse(await body(req)); sent.push(b);
      pending.push({type: 'm.room.message', event_id: '$s' + sent.length, sender: '@me:hs', origin_server_ts: 1, content: b});
      return js({event_id: '$s'});
    }
    res.writeHead(404); res.end('{}');
  }); servers.push(srv);
  const port = await listen(srv), server = 'http://127.0.0.1:' + port, cache = {};
  const A = rig('matrix', {server, user: 'me', pass: PW, channel: '!r:hs', cache});
  await until(() => A.state() === 'up');
  ok('matrix login + join', A.state() === 'up' && logins === 1, JSON.stringify(A.st));
  await sleep(100);
  pending.push({type: 'm.room.message', event_id: '$1', sender: '@bob:hs', origin_server_ts: 2, content: {msgtype: 'm.text', body: 'hi from bob'}});
  await until(() => A.msgs.length);
  ok('matrix incoming (history skipped)', A.msgs.length === 1 && A.msgs[0].text === 'hi from bob' && A.msgs[0].from === 'bob', JSON.stringify(A.msgs));
  ok('matrix send', await A.s.send('мой ответ') === true && sent[0].body === 'мой ответ');
  await until(() => A.msgs.length === 2);
  ok('matrix own message self', A.msgs[1]?.self === true);
  A.s.close();
  const B = rig('matrix', {server, user: 'me', pass: BAD, channel: '!r:hs'}); await until(() => B.state() === 'fatal');
  ok('matrix wrong password fatal', B.state() === 'fatal', JSON.stringify(B.st));
  const C = rig('matrix', {server, pass: TOK, channel: '!r:hs'}); await until(() => C.state() === 'up');
  ok('matrix access token only', C.state() === 'up', JSON.stringify(C.st)); C.s.close();
}

// ---- Telegram ----
{ const queue = []; const sent = [];
  const srv = http.createServer(async (req, res) => {
    const m = /\/bot([^/]+)\/(\w+)/.exec(req.url), js = o => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== TG) { res.writeHead(401); return res.end('{"ok":false,"error_code":401,"description":"Unauthorized"}'); }
    const b = JSON.parse((await body(req)) || '{}');
    if (m[2] === 'getMe') return js({ok: true, result: {username: 'dsp_bot'}});
    if (m[2] === 'getUpdates') { for (let i = 0; i < 60 && !queue.length; i++) await sleep(20); return js({ok: true, result: queue.splice(0)}); }
    if (m[2] === 'sendMessage') { sent.push(b); return js({ok: true, result: {}}); }
  }); servers.push(srv);
  const port = await listen(srv), server = 'http://127.0.0.1:' + port;
  const A = rig('telegram', {server, pass: TG, nick: 'dspbot'});
  await until(() => A.state() === 'up');
  ok('telegram getMe', A.state() === 'up' && /dsp_bot/.test(A.st.at(-1)[1]), JSON.stringify(A.st));
  ok('send with no chat known is refused', await A.s.send('x') === false);
  queue.push({update_id: 5, message: {chat: {id: 42, title: 'Team'}, from: {username: 'bob'}, text: 'hello bot', date: 9}});
  await until(() => A.msgs.length);
  ok('telegram incoming', A.msgs[0]?.text === 'hello bot' && A.msgs[0].from === 'bob', JSON.stringify(A.msgs));
  ok('telegram reply goes to the last chat', await A.s.send('hello human') === true && sent[0].chat_id === 42 && sent[0].text === 'hello human');
  ok('telegram own message echoed locally', A.msgs.at(-1).self === true);
  A.s.close();
  const B = rig('telegram', {server, pass: BAD}); await until(() => B.state() === 'fatal');
  ok('telegram bad token fatal', B.state() === 'fatal', JSON.stringify(B.st));
}

// ---- IRC (TCP) напрямую и через мост ----
{ const clients = new Set(); const got = [];
  const srv = net.createServer(sock => {
    clients.add(sock); sock.setEncoding('utf8'); let buf = '', nick = '*';
    sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); got.push(l);
      if (l.startsWith('NICK ')) nick = l.slice(5);
      if (l.startsWith('USER ')) sock.write(':srv 001 ' + nick + ' :Welcome\r\n');
      if (l.startsWith('JOIN ')) sock.write(':' + nick + '!u@h JOIN ' + l.slice(5) + '\r\n'); } });
    sock.on('close', () => clients.delete(sock)); sock.on('error', () => {});
  }); servers.push(srv);
  const port = await listen(srv), server = 'irc://127.0.0.1:' + port;
  const A = rig('irc', {server, channel: 'dsp', nick: 'dspbot', pass: IRC_PW});
  await until(() => A.st.some(s => /joined #dsp/.test(s[1])));
  ok('irc registered and joined (#dsp from "dsp")', got.includes('PASS ' + IRC_PW) && got.includes('JOIN #dsp'), JSON.stringify(got));
  for (const s of clients) s.write(':bob!u@h PRIVMSG #dsp :привет, мир\r\n');
  await until(() => A.msgs.length);
  ok('irc incoming', A.msgs[0]?.text === 'привет, мир' && A.msgs[0].from === 'bob');
  ok('irc send', A.s.send('ответ\nвторая строка') === true);
  await until(() => got.includes('PRIVMSG #dsp :вторая строка'));
  ok('irc lines sent', got.includes('PRIVMSG #dsp ответ') && got.includes('PRIVMSG #dsp :вторая строка'));
  ok('irc own message echoed locally', A.msgs.at(-1).self === true);
  const none = rig('irc', {server: 'irc://127.0.0.1:1', io: {...io, tcp: null}, channel: 'x'});
  ok('irc without a TCP transport explains why', none.state() === 'fatal' && /bridge/i.test(none.st.at(-1)[1]));
  // та же сессия, но страница говорит с мостом, а мост — с IRC
  const br = createMsgrBridge({port: 0}); const bp = (await br.listen()).port; servers.push({close: () => br.close()});
  const P = rig('irc', {server, channel: 'dsp', nick: 'viabridge', bridge: 'ws://127.0.0.1:' + bp, via: 'auto', io: {}});
  await until(() => P.st.some(s => /joined #dsp/.test(s[1])), 5000);
  ok('irc through the Node bridge', P.st.some(s => /joined #dsp/.test(s[1])), JSON.stringify(P.st));
  for (const s of clients) s.write(':bob!u@h PRIVMSG #dsp :через мост\r\n');
  await until(() => P.msgs.length);
  ok('bridge delivers messages', P.msgs[0]?.text === 'через мост', JSON.stringify(P.msgs));
  P.s.send('обратно');
  await until(() => got.includes('PRIVMSG #dsp обратно'));
  ok('bridge sends messages', got.includes('PRIVMSG #dsp обратно'));
  P.s.close(); A.s.close();
  // токен и Origin
  const br2 = createMsgrBridge({port: 0, token: 'tk'}); const p2 = (await br2.listen()).port; servers.push({close: () => br2.close()});
  const bad401 = await new Promise(r => { const q = http.request({port: p2, headers: {connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13'}}); q.on('upgrade', () => r(101)); q.on('response', x => r(x.statusCode)); q.on('error', () => r(-1)); q.end(); });
  ok('bridge without token refused', bad401 === 401, String(bad401));
  const evil = await new Promise(r => { const q = http.request({port: p2, path: '/?token=tk', headers: {connection: 'Upgrade', upgrade: 'websocket', origin: 'https://evil.example', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13'}}); q.on('upgrade', () => r(101)); q.on('response', x => r(x.statusCode)); q.on('error', () => r(-1)); q.end(); });
  ok('bridge refuses a foreign Origin', evil === 403, String(evil));
  const lim = createMsgrBridge({port: 0, hosts: ['irc.allowed.example']}); const p3 = (await lim.listen()).port; servers.push({close: () => lim.close()});
  const L = rig('irc', {server, channel: 'x', bridge: 'ws://127.0.0.1:' + p3, via: 'auto', io: {}});
  await until(() => L.state() === 'fatal' || L.st.some(s => /not in --hosts/.test(s[1])));
  ok('--hosts keeps the bridge from other servers', L.st.some(s => /not in --hosts/.test(s[1])), JSON.stringify(L.st)); L.s.close();
}

// ---- XMPP (TCP без TLS, insecure) ----
{ const rx = [];
  const srv = net.createServer(sock => {
    sock.setEncoding('utf8'); let acc = '', streams = 0;
    const hdr = f => "<?xml version='1.0'?><stream:stream from='ex.org' id='s" + streams + "' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>" + f;
    sock.on('data', d => { acc += d; rx.push(d);
      for (;;) {
        const m = /<stream:stream[^>]*>|<auth[^>]*>[^<]*<\/auth>|<iq[^>]*id='bind1'[\s\S]*?<\/iq>|<message[\s\S]*?<\/message>/.exec(acc);
        if (!m) break; acc = acc.slice(m.index + m[0].length);
        if (m[0].startsWith('<stream:stream')) { streams++; sock.write(hdr(streams === 1 ? "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>" : "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>")); }
        else if (m[0].startsWith('<auth')) sock.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
        else if (m[0].startsWith('<iq')) sock.write("<iq type='result' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>bob@ex.org/dsp</jid></bind></iq>");
        else if (m[0].startsWith('<message')) sock.write(m[0].replace("type='groupchat'", "type='groupchat' from='room@conf.ex.org/bobby'").replace(/ to='[^']*'/, ''));
      } });
    sock.on('error', () => {});
    sock.once('data', () => {});
  }); servers.push(srv);
  const port = await listen(srv);
  const refuse = rig('xmpp', {user: 'bob@ex.org', pass: PW, server: 'xmpp://127.0.0.1:' + port, channel: 'room@conf.ex.org', nick: 'bobby'});
  await until(() => refuse.state() === 'fatal');
  ok('xmpp refuses a plaintext password without STARTTLS', refuse.state() === 'fatal' && /STARTTLS/.test(refuse.st.at(-1)[1]) && !rx.join('').includes('<auth'), JSON.stringify(refuse.st));
  const A = rig('xmpp', {user: 'bob@ex.org', pass: PW, server: 'xmpp://127.0.0.1:' + port, channel: 'room@conf.ex.org', nick: 'bobby', insecure: true});
  await until(() => A.state() === 'up');
  ok('xmpp login + bind', A.state() === 'up' && /bob@ex\.org\/dsp/.test(A.st.at(-1)[1]), JSON.stringify(A.st));
  ok('xmpp send to the room', A.s.send('hi & <all>') === true);
  await until(() => A.msgs.length);
  ok('xmpp room reflection is own message', A.msgs[0]?.text === 'hi & <all>' && A.msgs[0].self === true, JSON.stringify(A.msgs));
  A.s.close(); refuse.s.close();
}

for (const s of servers) try { s.close(); s.closeAllConnections?.(); } catch (e) {}
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
