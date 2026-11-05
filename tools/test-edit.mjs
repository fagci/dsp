// Правка и удаление сообщений: Matrix (m.replace, redaction), Telegram (editMessageText, deleteMessage),
// XMPP (XEP-0308, XEP-0424), Nostr (NIP-09, правки нет): node tools/test-edit.mjs
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
const rig = (proto, cfg) => { const r = {msgs: [], st: []}; r.s = M.mgConnect(proto, {retry: false, via: 'page', io, ...cfg}, {msg: m => r.msgs.push(m), status: (t, s) => r.st.push([s, t])}); r.state = () => (r.st.at(-1) || [])[0]; r.text = () => (r.st.at(-1) || [])[1]; r.of = k => r.msgs.filter(m => m.kind === k); return r; };
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });

// pure: разбор событий
{ const o = M.mgMatrixSync({next_batch: 'n', rooms: {join: {'!r:hs': {timeline: {events: [
    {type: 'm.room.message', event_id: '$m1', sender: '@bob:hs', origin_server_ts: 1, content: {msgtype: 'm.text', body: 'old'}},
    {type: 'm.room.message', event_id: '$e1', sender: '@bob:hs', origin_server_ts: 2, content: {msgtype: 'm.text', body: '* new', 'm.new_content': {msgtype: 'm.text', body: 'new'}, 'm.relates_to': {rel_type: 'm.replace', event_id: '$m1'}}},
    {type: 'm.room.message', event_id: '$e2', sender: '@me:hs', origin_server_ts: 3, content: {msgtype: 'm.text', body: '* only star', 'm.relates_to': {rel_type: 'm.replace', event_id: '$m1'}}}]}}}}}, '!r:hs', '@me:hs');
  ok('matrix parse: an edit is an event, not a second message', o.msgs.map(m => m.id).join() === '$m1', JSON.stringify(o.msgs));
  ok('matrix parse: the new text comes from m.new_content, or the body without the «* » of old clients', o.edits.map(e => [e.target, e.text, e.author, e.self]).join('|') === '$m1,new,bob,false|$m1,only star,me,true', JSON.stringify(o.edits)); }
{ const u = M.mgTgUpdates({result: [{update_id: 5, edited_message: {message_id: 41, chat: {id: 7}, from: {username: 'ivan'}, date: 1, edit_date: 9, text: 'fixed'}}, {update_id: 6, edited_message: {message_id: 42, chat: {id: 7}, date: 1, photo: []}}]}, '');
  ok('telegram parse: an edited text message is an edit event with the full new text', u.edits.length === 1 && u.edits[0].target === '7:41' && u.edits[0].text === 'fixed' && u.edits[0].author === 'ivan' && u.next === 7, JSON.stringify(u)); }

// ================= Matrix =================
{ const pending = [], sent = [], redacted = []; let evN = 0, syncs = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), js = (o, c = 200) => { res.writeHead(c, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer ' + TOK) return js({errcode: 'M_UNKNOWN_TOKEN'}, 401);
    if (u.pathname.includes('/join/')) { await body(req); return js({room_id: '!r:hs'}); }
    if (u.pathname.endsWith('/account/whoami')) return js({user_id: '@me:hs'});
    if (u.pathname.endsWith('/joined_rooms')) return js({joined_rooms: []});
    if (u.pathname.endsWith('/sync')) { syncs++; if (!u.searchParams.get('since')) return js({next_batch: 'b0', rooms: {join: {}}}); for (let i = 0; i < 100 && !pending.length; i++) await sleep(20); return js({next_batch: 'b' + syncs, rooms: {join: {'!r:hs': {timeline: {events: pending.splice(0)}}}}}); }
    if (req.method === 'PUT' && u.pathname.includes('/send/m.room.message/')) { const b = JSON.parse(await body(req)); sent.push(b); const id = '$s' + (++evN); pending.push({type: 'm.room.message', event_id: id, sender: '@me:hs', origin_server_ts: 5, content: b}); return js({event_id: id}); }
    if (req.method === 'PUT' && u.pathname.includes('/redact/')) { const id = decodeURIComponent(u.pathname.split('/redact/')[1].split('/')[0]); redacted.push(id); await body(req); pending.push({type: 'm.room.redaction', event_id: '$d' + (++evN), sender: '@me:hs', redacts: id, content: {}}); return js({event_id: '$d'}); }
    js({});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('matrix', {server: 'http://127.0.0.1:' + port, pass: TOK, channel: '!r:hs', cache: {}});
  await until(() => R.state() === 'up'); await sleep(100);
  ok('matrix: an edit is a replacement event with new content', await R.s.modify({op: 'edit', target: '$m1', text: 'исправлено', room: '!r:hs'}) === true && sent[0]['m.relates_to'].rel_type === 'm.replace' && sent[0]['m.relates_to'].event_id === '$m1' && sent[0]['m.new_content'].body === 'исправлено' && sent[0].body === '* исправлено', JSON.stringify(sent));
  const e = await until(() => R.of('edit')[0]);
  ok('matrix: the echo is an edit event of mine', !!e && e.target === '$m1' && e.text === 'исправлено' && e.self === true && R.msgs.every(m => m.kind === 'edit' || m.kind === undefined) && !R.msgs.some(m => m.text === '* исправлено'), JSON.stringify(R.msgs));
  ok('matrix: a delete is a redaction of that event', await R.s.modify({op: 'delete', target: '$m1', room: '!r:hs'}) === true && redacted[0] === '$m1', JSON.stringify(redacted));
  const d = await until(() => R.of('delete')[0]);
  ok('matrix: the redaction comes back as a delete event (the server has checked the rights)', !!d && d.target === '$m1' && d.force === true, JSON.stringify(d));
  ok('matrix: nothing to change is refused', await R.s.modify({op: 'edit', text: 'x'}) === false);
  R.s.close(); }

// ================= Telegram =================
{ const updates = [], calls = []; let uid = 0, mid = 100;
  const srv = http.createServer(async (req, res) => {
    const m = /\/bot[^/]+\/(\w+)/.exec(req.url), js = o => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    const b = JSON.parse((await body(req)) || '{}');
    if (m[1] === 'getMe') return js({ok: true, result: {username: 'dspbot'}});
    if (m[1] === 'getUpdates') { b.allowed_updates && calls.push(['allowed', b.allowed_updates]); for (let i = 0; i < 60 && !updates.length; i++) await sleep(20); return js({ok: true, result: updates.splice(0)}); }
    if (m[1] === 'sendMessage') return js({ok: true, result: {message_id: ++mid, chat: {id: b.chat_id}, text: b.text}});
    calls.push([m[1], b]);
    if (m[1] === 'deleteMessage' && b.message_id === 999) return js({ok: false, error_code: 400, description: "Bad Request: message can't be deleted"});
    js({ok: true, result: true});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('telegram', {server: 'http://127.0.0.1:' + port, pass: 'x' + rnd(), channel: '7'});
  await until(() => R.state() === 'up');
  ok('telegram: the bot asks for edited messages too', !!(await until(() => calls.find(c => c[0] === 'allowed'))) && calls.find(c => c[0] === 'allowed')[1].includes('edited_message'));
  ok('telegram: a sent message is echoed with its reference (chat:message_id)', await R.s.send('привет', '7') === true);
  const mine = await until(() => R.msgs.find(m => m.self && m.text === 'привет'));
  ok('telegram: the echo has ref, mid and an id', !!mine && mine.ref === '7:101' && mine.mid === 101 && /^tgo7:101$/.test(mine.id), JSON.stringify(mine));
  ok('telegram: edit goes to editMessageText with chat and message ids', await R.s.modify({op: 'edit', target: mine.ref, text: 'привет, мир'}) === true && calls.find(c => c[0] === 'editMessageText')[1].message_id === 101 && calls.find(c => c[0] === 'editMessageText')[1].text === 'привет, мир');
  ok('telegram: delete goes to deleteMessage', await R.s.modify({op: 'delete', target: mine.ref}) === true && calls.find(c => c[0] === 'deleteMessage')[1].chat_id === 7);
  ok('telegram: a refusal of Telegram is shown', await R.s.modify({op: 'delete', target: '7:999'}) === false && /can't be deleted/.test(R.text()), R.text());
  ok('telegram: a target without a reference is refused', await R.s.modify({op: 'edit', target: 'abc', text: 'x'}) === false);
  updates.push({update_id: ++uid, edited_message: {message_id: 55, chat: {id: 7}, from: {username: 'ivan'}, date: 1, edit_date: 2, text: 'правка гостя'}});
  const e = await until(() => R.of('edit')[0]);
  ok('telegram: an edit of someone\'s message arrives as an event', !!e && e.target === '7:55' && e.text === 'правка гостя' && e.author === 'ivan', JSON.stringify(e));
  R.s.close(); }

// ================= XMPP: XEP-0308 / XEP-0424 =================
{ const rx = []; let sockRef = null;
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
  const R = rig('xmpp', {user: 'me@ex.org', pass: rnd(), server: 'xmpp://127.0.0.1:' + port, insecure: true, nick: 'me', roster: false});
  await until(() => R.state() === 'up'); await sleep(50);
  ok('xmpp: a sent direct message is echoed with its id', R.s.send('привет', 'anna@ex.org') === true && !!(await until(() => R.msgs.find(m => m.self && m.id))));
  await until(() => rx.length >= 1);
  const mine = R.msgs.find(m => m.self && m.id), sentId = (/id='(m\d+)'/.exec(rx[0]) || [])[1];
  ok('xmpp: the echo id is the id of the stanza on the wire', !!mine && mine.id === sentId, mine && mine.id + ' vs ' + sentId);
  const r1 = R.s.modify({op: 'edit', target: mine.id, text: 'привет, Анна', to: 'anna@ex.org'}); await until(() => rx.length >= 2);
  ok('xmpp: an edit is a new message with <replace id=original> (XEP-0308)', r1 === true && /<body>привет, Анна<\/body><replace xmlns='urn:xmpp:message-correct:0' id='m\d+'\/>/.test(rx[1]) && rx[1].includes("id='" + mine.id + "'/>"), rx[1]);
  const r2 = R.s.modify({op: 'delete', target: mine.id, to: 'anna@ex.org'}); await until(() => rx.length >= 3);
  ok('xmpp: a delete is <retract id=original> with a fallback text (XEP-0424)', r2 === true && rx[2].includes("<retract xmlns='urn:xmpp:message-retract:1' id='" + mine.id + "'/>") && /<fallback /.test(rx[2]), rx[2]);
  sockRef.write("<message from='anna@ex.org/phone' to='me@ex.org/dsp' type='chat' id='c1'><body>исправила</body><replace xmlns='urn:xmpp:message-correct:0' id='a-1'/></message>");
  const e = await until(() => R.of('edit')[0]);
  ok('xmpp: an incoming correction is an edit event of that message, not a new message', !!e && e.target === 'a-1' && e.text === 'исправила' && e.author === 'anna@ex.org' && !R.msgs.some(m => m.text === 'исправила' && !m.kind), JSON.stringify(R.msgs));
  sockRef.write("<message from='anna@ex.org/phone' to='me@ex.org/dsp' type='chat' id='c2'><retract xmlns='urn:xmpp:message-retract:1' id='a-1'/><body>fallback text</body></message>");
  const d = await until(() => R.of('delete')[0]);
  ok('xmpp: an incoming retraction is a delete event, its fallback text is not shown', !!d && d.target === 'a-1' && d.author === 'anna@ex.org' && !R.msgs.some(m => m.text === 'fallback text'), JSON.stringify(R.msgs));
  R.s.close(); }

// ================= Nostr: только удаление (NIP-09) =================
{ const subs = new Set(), events = []; const skA = M.mgNostrGenKey(), skB = M.mgNostrGenKey(), skMe = M.mgNostrGenKey();
  const srv = http.createServer(); servers.push(srv);
  srv.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    const me = {sock}; subs.add(me);
    me.send = a => { try { sock.write(wsFrame(JSON.stringify(a))); } catch (e) { /* закрыт */ } };
    sock.on('data', wsParser({onMsg: t => { const a = JSON.parse(t); if (a[0] === 'REQ') me.sub = a[1]; else if (a[0] === 'EVENT') { events.push(a[1]); me.send(['OK', a[1].id, true, '']); for (const o of subs) if (o.sub) o.send(['EVENT', o.sub, a[1]]); } }, onClose() {}, onPing() {}}));
    sock.on('close', () => subs.delete(me)); sock.on('error', () => {});
  });
  const port = await listen(srv);
  const R = rig('nostr', {server: 'ws://127.0.0.1:' + port, channel: 'dsp', key: M.mgHex(skMe), nick: 'me'});
  await until(() => R.state() === 'up'); await sleep(100);
  const sub = () => [...subs][0];
  const post = (sk, text) => { const ev = M.mgNostrSign(sk, {created_at: Math.floor(Date.now() / 1000), kind: 1, tags: [['t', 'dsp'], ['nick', 'author']], content: text}); sub().send(['EVENT', sub().sub, ev]); return ev; };
  const a1 = post(skA, 'сообщение A'); await until(() => R.msgs.find(m => m.id === a1.id));
  const del = (sk, id) => { const ev = M.mgNostrSign(sk, {created_at: Math.floor(Date.now() / 1000), kind: 5, tags: [['e', id], ['t', 'dsp']], content: ''}); sub().send(['EVENT', sub().sub, ev]); };
  del(skB, a1.id); await sleep(300);
  ok('nostr: somebody else cannot delete another person\'s message (NIP-09: only the author)', R.of('delete').length === 0, JSON.stringify(R.of('delete')));
  del(skA, a1.id);
  const d = await until(() => R.of('delete')[0]);
  ok('nostr: the author\'s deletion arrives as a delete event of that message', !!d && d.target === a1.id, JSON.stringify(d));
  R.s.send('моё'); const mine = await until(() => R.msgs.find(m => m.self && m.text === 'моё'));
  ok('nostr: delete of mine is a kind 5 pointing at my event', R.s.modify({op: 'delete', target: mine.id}) === true && !!(await until(() => events.find(e => e.kind === 5 && e.tags.some(t => t[0] === 'e' && t[1] === mine.id)))));
  ok('nostr: an edit is refused with a reason', R.s.modify({op: 'edit', target: mine.id, text: 'x'}) === false && /cannot be edited/.test(R.text()), R.text());
  R.s.close(); }

for (const s of servers) { try { s.close(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
