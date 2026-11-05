// Статусы доставки и прочтения: Matrix (m.receipt, m.read), XMPP (XEP-0184 / XEP-0333), Nostr (OK реле): node tools/test-status.mjs
import net from 'node:net';
import http from 'node:http';
import {loadMsgr} from './node/load.mjs';
import {nodeIo} from './node/bridge.mjs';
import {wsAccept, wsFrame, wsParser} from './termux/bridge.mjs';

const M = loadMsgr(), io = nodeIo();
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];
const rnd = () => Math.random().toString(36).slice(2, 10), TOK = rnd();
const rig = (proto, cfg) => { const r = {msgs: [], st: []}; r.s = M.mgConnect(proto, {retry: false, via: 'page', io, ...cfg}, {msg: m => r.msgs.push(m), status: (t, s) => r.st.push([s, t])}); r.state = () => (r.st.at(-1) || [])[0]; r.text = () => (r.st.at(-1) || [])[1]; r.marks = () => r.msgs.filter(m => m.kind === 'status'); return r; };
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });

// pure: квитанции Matrix
{ const o = M.mgMatrixSync({next_batch: 'n', rooms: {join: {'!r:hs': {ephemeral: {events: [
    {type: 'm.receipt', content: {'$m1': {'m.read': {'@bob:hs': {ts: 10}, '@me:hs': {ts: 11}}}, '$m2': {'m.read': {'@anna:hs': {ts: 12}}, 'm.read.private': {'@x:hs': {ts: 1}}}}},
    {type: 'm.typing', content: {user_ids: ['@bob:hs']}}]}}}}}, '!r:hs', '@me:hs');
  ok('matrix parse: read receipts of other people (mine are skipped, private ones and typing are ignored)', o.marks.map(m => [m.target, m.state, m.author, m.t].join()).join('|') === '$m1,read,bob,10|$m2,read,anna,12', JSON.stringify(o.marks)); }

// ================= Matrix =================
{ const pending = [], receipts = []; let syncs = 0, filterSeen = '';
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), js = (o, c = 200) => { res.writeHead(c, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer ' + TOK) return js({errcode: 'M_UNKNOWN_TOKEN'}, 401);
    if (u.pathname.includes('/join/')) { await body(req); return js({room_id: '!r:hs'}); }
    if (u.pathname.endsWith('/account/whoami')) return js({user_id: '@me:hs'});
    if (u.pathname.endsWith('/joined_rooms')) return js({joined_rooms: []});
    if (u.pathname.endsWith('/sync')) { syncs++; filterSeen = u.searchParams.get('filter') || filterSeen; if (!u.searchParams.get('since')) return js({next_batch: 'b0', rooms: {join: {}}}); for (let i = 0; i < 100 && !pending.length; i++) await sleep(20); return js({next_batch: 'b' + syncs, rooms: {join: {'!r:hs': {ephemeral: {events: pending.splice(0)}}}}}); }
    if (req.method === 'POST' && u.pathname.includes('/receipt/m.read/')) { await body(req); receipts.push(decodeURIComponent(u.pathname.split('/receipt/m.read/')[1])); return js({}); }
    js({});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('matrix', {server: 'http://127.0.0.1:' + port, pass: TOK, channel: '!r:hs', cache: {}, receipts_level: 2});
  await until(() => R.state() === 'up'); await sleep(100);
  ok('matrix: the sync filter asks for receipts', decodeURIComponent(filterSeen).includes('m.receipt'), filterSeen);
  pending.push({type: 'm.receipt', content: {'$mine1': {'m.read': {'@bob:hs': {ts: 5}}}}});
  const mk = await until(() => R.marks()[0]);
  ok('matrix: a read receipt of another person arrives as a status event', !!mk && mk.target === '$mine1' && mk.state === 'read' && mk.author === 'bob', JSON.stringify(R.marks()));
  ok('matrix: «delivered + read» sends the receipt for the event', await R.s.ack({target: '$their9', room: '!r:hs'}) === true && receipts[0] === '$their9', JSON.stringify(receipts));
  R.s.close();
  const R0 = rig('matrix', {server: 'http://127.0.0.1:' + port, pass: TOK, channel: '!r:hs', cache: {}, receipts_level: 1});
  await until(() => R0.state() === 'up'); await sleep(50);
  ok('matrix: «delivered» alone never sends a read receipt', await R0.s.ack({target: '$their10', room: '!r:hs'}) === false && receipts.length === 1, JSON.stringify(receipts));
  R0.s.close(); }

// ================= XMPP: XEP-0184 / XEP-0333 =================
async function xmppRig(level) {
  const rx = []; let sockRef = null;
  const srv = net.createServer(sock => {
    sockRef = sock; sock.setEncoding('utf8'); let acc = '', streams = 0;
    const hdr = f => "<?xml version='1.0'?><stream:stream from='ex.org' id='s" + streams + "' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>" + f;
    sock.on('data', d => { acc += d;
      for (;;) {
        const m = /<stream:stream[^>]*>|<auth[^>]*>[^<]*<\/auth>|<iq[^>]*id='bind1'[\s\S]*?<\/iq>|<message[\s\S]*?<\/message>/.exec(acc);
        if (!m) break; acc = acc.slice(m.index + m[0].length);
        const x = m[0];
        if (x.startsWith('<stream:stream')) { streams++; sock.write(hdr(streams === 1 ? "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>" : "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>")); }
        else if (x.startsWith('<auth')) sock.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
        else if (x.includes("id='bind1'")) sock.write("<iq type='result' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>me@ex.org/dsp</jid></bind></iq>");
        else if (x.startsWith('<message')) rx.push(x);
      } });
    sock.on('error', () => {});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('xmpp', {user: 'me@ex.org', pass: rnd(), server: 'xmpp://127.0.0.1:' + port, insecure: true, nick: 'me', roster: false, receipts_level: level});
  await until(() => R.state() === 'up'); await sleep(50);
  return {R, rx, say: x => sockRef.write(x)};
}
{ const {R, rx, say} = await xmppRig(1);
  R.s.send('привет', 'anna@ex.org'); await until(() => rx.length >= 1);
  const id = (/id='(m\d+)'/.exec(rx[0]) || [])[1];
  ok('xmpp: a direct message asks for a delivery receipt and a chat marker', /<request xmlns='urn:xmpp:receipts'\/>/.test(rx[0]) && /<markable xmlns='urn:xmpp:chat-markers:0'\/>/.test(rx[0]), rx[0]);
  say("<message from='anna@ex.org/phone' to='me@ex.org/dsp' id='x1'><received xmlns='urn:xmpp:receipts' id='" + id + "'/></message>");
  const d = await until(() => R.marks()[0]);
  ok('xmpp: a delivery receipt is a «delivered» status of that message', !!d && d.state === 'delivered' && d.target === id && d.author === 'anna@ex.org', JSON.stringify(R.marks()));
  say("<message from='anna@ex.org/phone' to='me@ex.org/dsp' id='x2'><displayed xmlns='urn:xmpp:chat-markers:0' id='" + id + "'/></message>");
  const rd = await until(() => R.marks().find(m => m.state === 'read'));
  ok('xmpp: a chat marker «displayed» is a «read» status', !!rd && rd.target === id, JSON.stringify(R.marks()));
  ok('xmpp: status stanzas are not shown as text messages', !R.msgs.some(m => !m.kind && !m.self));
  say("<message from='anna@ex.org/phone' to='me@ex.org/dsp' type='chat' id='in-7'><body>привет!</body><request xmlns='urn:xmpp:receipts'/></message>");
  await until(() => rx.some(x => x.includes("<received xmlns='urn:xmpp:receipts' id='in-7'/>")));
  ok('xmpp: when asked, delivery is confirmed (level «delivered»)', rx.some(x => /to='anna@ex\.org\/phone'/.test(x) && x.includes("<received xmlns='urn:xmpp:receipts' id='in-7'/>")), rx.join('|'));
  ok('xmpp: «delivered» alone never marks messages as read', R.s.ack({to: 'anna@ex.org', target: 'in-7'}) === false && !rx.some(x => x.includes('displayed')));
  R.s.close(); }
{ const {R, rx, say} = await xmppRig(2);
  ok('xmpp: «delivered + read» marks the message as displayed', R.s.ack({to: 'anna@ex.org', target: 'in-8'}) === true && !!(await until(() => rx.some(x => /<displayed xmlns='urn:xmpp:chat-markers:0' id='in-8'\/>/.test(x)))), rx.join('|'));
  R.s.close(); }
{ const {R, rx, say} = await xmppRig(0);
  say("<message from='anna@ex.org/phone' to='me@ex.org/dsp' type='chat' id='in-9'><body>привет</body><request xmlns='urn:xmpp:receipts'/></message>");
  await until(() => R.msgs.find(m => m.text === 'привет')); await sleep(100);
  ok('xmpp: with receipts off nothing is confirmed', !rx.some(x => x.includes('received')) && R.s.ack({to: 'anna@ex.org', target: 'in-9'}) === false);
  R.s.close(); }
{ const {R, rx, say} = await xmppRig(1);
  say("<message from='room@conf.ex.org/anna' to='me@ex.org/dsp' type='groupchat' id='g1'><body>в комнате</body><request xmlns='urn:xmpp:receipts'/></message>");
  await until(() => R.msgs.find(m => m.text === 'в комнате')); await sleep(100);
  ok('xmpp: a room message is never confirmed (no receipts in group chats)', !rx.some(x => x.includes('received')));
  R.s.close(); }

// ================= Nostr: принято реле =================
{ const subs = new Set(), events = [];
  const mk = (accept) => { const srv = http.createServer(); servers.push(srv);
    srv.on('upgrade', (req, sock) => {
      sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
      const me = {sock}; me.send = a => { try { sock.write(wsFrame(JSON.stringify(a))); } catch (e) { /* закрыт */ } };
      sock.on('data', wsParser({onMsg: t => { const a = JSON.parse(t); if (a[0] === 'EVENT') { events.push(a[1]); me.send(['OK', a[1].id, accept, accept ? '' : 'blocked: not allowed']); } }, onClose() {}, onPing() {}}));
      sock.on('error', () => {});
    }); return srv; };
  const s1 = mk(true), s2 = mk(false), s3 = mk(true);
  const p1 = await listen(s1), p2 = await listen(s2), p3 = await listen(s3);
  const R = rig('nostr', {server: ['ws://127.0.0.1:' + p1, 'ws://127.0.0.1:' + p2, 'ws://127.0.0.1:' + p3].join(' '), channel: 'dsp', nick: 'me'});
  await until(() => R.st.some(x => /relays 3\/3/.test(x[1])), 4000); await sleep(100);
  ok('nostr: send', R.s.send('привет') === true);
  const st = await until(() => R.marks().find(m => m.state === 'sent'));
  ok('nostr: the first relay that accepts makes it «sent» for the message id', !!st && st.target === events[0].id && /relays: 1\/3/.test(st.detail), JSON.stringify(R.marks()));
  await sleep(300);
  ok('nostr: a relay that refuses is reported in the status line', R.st.some(x => /rejected: blocked/.test(x[1])), JSON.stringify(R.st.slice(-3)));
  R.s.close(); }
{ const events = [];
  const srv = http.createServer(); servers.push(srv);
  srv.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    const send = a => { try { sock.write(wsFrame(JSON.stringify(a))); } catch (e) { /* закрыт */ } };
    sock.on('data', wsParser({onMsg: t => { const a = JSON.parse(t); if (a[0] === 'EVENT') { events.push(a[1]); send(['OK', a[1].id, false, 'blocked: spam']); } }, onClose() {}, onPing() {}}));
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  const R = rig('nostr', {server: 'ws://127.0.0.1:' + port, channel: 'dsp', nick: 'me'});
  await until(() => R.state() === 'up'); await sleep(100);
  R.s.send('не пройдёт');
  const f = await until(() => R.marks().find(m => m.state === 'failed'));
  ok('nostr: when every relay refuses the message is «failed» with the reason', !!f && f.target === events[0].id && /blocked: spam/.test(f.detail), JSON.stringify(R.marks()));
  R.s.close(); }

for (const s of servers) { try { s.close(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
