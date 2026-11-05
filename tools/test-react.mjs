// Реакции на сообщения: Matrix, Telegram, XMPP (XEP-0444), Nostr (NIP-25 / NIP-09): node tools/test-react.mjs
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
const rig = (proto, cfg) => { const r = {msgs: [], st: []}; r.s = M.mgConnect(proto, {retry: false, via: 'page', io, ...cfg}, {msg: m => r.msgs.push(m), status: (t, s) => r.st.push([s, t])}); r.state = () => (r.st.at(-1) || [])[0]; r.text = () => (r.st.at(-1) || [])[1]; r.reacts = () => r.msgs.filter(m => m.kind === 'reaction'); return r; };
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });

// ================= Matrix =================
{ const pending = [], sent = [], redacted = []; let evN = 0, syncs = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), js = (o, c = 200) => { res.writeHead(c, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer ' + TOK) return js({errcode: 'M_UNKNOWN_TOKEN'}, 401);
    if (u.pathname.endsWith('/join/' + encodeURIComponent('!r:hs')) || u.pathname.includes('/join/')) { await body(req); return js({room_id: '!r:hs'}); }
    if (u.pathname.endsWith('/account/whoami')) return js({user_id: '@me:hs'});
    if (u.pathname.endsWith('/joined_rooms')) return js({joined_rooms: []});
    if (u.pathname.endsWith('/sync')) {
      syncs++;
      if (!u.searchParams.get('since')) return js({next_batch: 'b0', rooms: {join: {}}});
      for (let i = 0; i < 100 && !pending.length; i++) await sleep(20);
      return js({next_batch: 'b' + syncs, rooms: {join: {'!r:hs': {timeline: {events: pending.splice(0)}}}}});
    }
    if (req.method === 'PUT' && u.pathname.includes('/send/m.reaction/')) { const b = JSON.parse(await body(req)); sent.push(b); const id = '$rx' + (++evN); pending.push({type: 'm.reaction', event_id: id, sender: '@me:hs', origin_server_ts: 5, content: b}); return js({event_id: id}); }
    if (req.method === 'PUT' && u.pathname.includes('/redact/')) { const id = decodeURIComponent(u.pathname.split('/redact/')[1].split('/')[0]); redacted.push(id); await body(req); pending.push({type: 'm.room.redaction', event_id: '$d' + (++evN), sender: '@me:hs', redacts: id, content: {}}); return js({event_id: '$d'}); }
    js({});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('matrix', {server: 'http://127.0.0.1:' + port, pass: TOK, channel: '!r:hs', cache: {}});
  await until(() => R.state() === 'up'); await sleep(100);
  ok('matrix: react without a target is refused', await R.s.react({emoji: '👍', on: true}) === false);
  ok('matrix: a reaction is sent as an annotation of the message', await R.s.react({target: '$m1', emoji: '👍', on: true, room: '!r:hs'}) === true && sent[0] && sent[0]['m.relates_to'].rel_type === 'm.annotation' && sent[0]['m.relates_to'].event_id === '$m1' && sent[0]['m.relates_to'].key === '👍', JSON.stringify(sent));
  const mine = await until(() => R.reacts().find(r => r.op === 'add'));
  ok('matrix: the echo comes back as an event of mine', !!mine && mine.target === '$m1' && mine.emojis[0] === '👍' && mine.self === true && mine.author === 'me', JSON.stringify(R.reacts()));
  pending.push({type: 'm.reaction', event_id: '$other', sender: '@anna:hs', origin_server_ts: 6, content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$m1', key: '🔥'}}});
  const other = await until(() => R.reacts().find(r => r.author === 'anna'));
  ok('matrix: another person\'s reaction arrives', !!other && other.emojis[0] === '🔥' && other.self === false && other.target === '$m1');
  ok('matrix: removing a reaction redacts exactly the event that was sent', await R.s.react({target: '$m1', emoji: '👍', on: false, room: '!r:hs'}) === true && redacted[0] === '$rx1', JSON.stringify(redacted));
  const gone = await until(() => R.reacts().find(r => r.op === 'remove' && r.emojis[0] === '👍'));
  ok('matrix: the redaction comes back as a «remove» of that reaction', !!gone && gone.target === '$m1' && gone.author === 'me', JSON.stringify(R.reacts()));
  ok('matrix: removing a reaction the session never saw is refused with a reason', await R.s.react({target: '$m9', emoji: '😮', on: false, room: '!r:hs'}) === false && /not known/.test(R.text()), R.text());
  R.s.close(); }

// ================= Telegram =================
{ const updates = [], set = [], seenAllowed = []; let uid = 0;
  const srv = http.createServer(async (req, res) => {
    const m = /\/bot[^/]+\/(\w+)/.exec(req.url), js = o => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    const b = JSON.parse((await body(req)) || '{}');
    if (m[1] === 'getMe') return js({ok: true, result: {username: 'dspbot'}});
    if (m[1] === 'getUpdates') { for (let i = 0; i < 60 && !updates.length; i++) await sleep(20); seenAllowed.push(b.allowed_updates); return js({ok: true, result: updates.splice(0)}); }
    if (m[1] === 'setMessageReaction') { set.push(b); return js(b.reaction.length && b.reaction[0].emoji === '💩' ? {ok: false, error_code: 400, description: 'Bad Request: REACTION_INVALID'} : {ok: true, result: true}); }
    js({ok: true, result: {}});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('telegram', {server: 'http://127.0.0.1:' + port, pass: 'x' + rnd(), channel: ''});
  await until(() => R.state() === 'up');
  ok('telegram: the bot asks Telegram for reaction updates too', await until(() => seenAllowed.length) && seenAllowed[0].includes('message_reaction'), JSON.stringify(seenAllowed));
  updates.push({update_id: ++uid, message: {message_id: 41, chat: {id: 7, username: 'ivan'}, from: {username: 'ivan'}, date: 1, text: 'привет'}});
  const msg = await until(() => R.msgs.find(m => m.text === 'привет'));
  ok('telegram: a received message carries its reference chat:message', !!msg && msg.ref === '7:41' && msg.mid === 41, JSON.stringify(msg));
  ok('telegram: a reaction is sent with chat id and message id', await R.s.react({target: msg.ref, emoji: '👍', on: true}) === true && set[0].chat_id === 7 && set[0].message_id === 41 && set[0].reaction[0].emoji === '👍', JSON.stringify(set));
  ok('telegram: removing sends an empty set', await R.s.react({target: msg.ref, emoji: '👍', on: false}) === true && set[1].reaction.length === 0, JSON.stringify(set));
  ok('telegram: an emoji Telegram refuses is reported', await R.s.react({target: msg.ref, emoji: '💩', on: true}) === false && /fixed set of emoji/.test(R.text()), R.text());
  ok('telegram: a target without a reference is refused', await R.s.react({target: 'abc', emoji: '👍', on: true}) === false);
  updates.push({update_id: ++uid, message_reaction: {chat: {id: 7, username: 'ivan'}, message_id: 41, user: {username: 'ivan'}, date: 2, new_reaction: [{type: 'emoji', emoji: '❤️'}]}});
  const rr = await until(() => R.reacts()[0]);
  ok('telegram: an incoming reaction update is the full set of that person', !!rr && rr.target === '7:41' && rr.author === 'ivan' && rr.emojis[0] === '❤️' && rr.op === 'set', JSON.stringify(rr));
  R.s.close(); }

// ================= XMPP (XEP-0444) =================
{ const rx = []; let sockRef = null;
  const srv = net.createServer(sock => {
    sockRef = sock; sock.setEncoding('utf8'); let acc = '', streams = 0;
    const hdr = f => "<?xml version='1.0'?><stream:stream from='ex.org' id='s" + streams + "' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>" + f;
    sock.on('data', d => { acc += d;
      for (;;) {
        const m = /<stream:stream[^>]*>|<auth[^>]*>[^<]*<\/auth>|<iq[^>]*id='bind1'[\s\S]*?<\/iq>|<iq[^>]*id='roster1'[\s\S]*?<\/iq>|<message[\s\S]*?<\/message>/.exec(acc);
        if (!m) break; acc = acc.slice(m.index + m[0].length);
        const x = m[0];
        if (x.startsWith('<stream:stream')) { streams++; sock.write(hdr(streams === 1 ? "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>" : "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>")); }
        else if (x.startsWith('<auth')) sock.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
        else if (x.includes("id='bind1'")) sock.write("<iq type='result' id='bind1'><bind xmlns='urn:xmpp:xmpp-bind'><jid>me@ex.org/dsp</jid></bind></iq>".replace('urn:xmpp:xmpp-bind', 'urn:ietf:params:xml:ns:xmpp-bind'));
        else if (x.startsWith('<message')) rx.push(x);
      } });
    sock.on('error', () => {});
  }); servers.push(srv);
  const port = await listen(srv);
  const R = rig('xmpp', {user: 'me@ex.org', pass: rnd(), server: 'xmpp://127.0.0.1:' + port, insecure: true, nick: 'me', roster: false});
  await until(() => R.state() === 'up'); await sleep(50);
  const r1 = R.s.react({to: 'anna@ex.org', target: 'msg-9', emoji: '👍', on: true, mine: ['👍', '❤️']}); await until(() => rx.length >= 1);
  ok('xmpp: react sends the FULL set of mine (XEP-0444 replaces the previous set)', r1 === true && /type='chat'/.test(rx[0]) && /to='anna@ex\.org'/.test(rx[0]) && /<reactions xmlns='urn:xmpp:reactions:0' id='msg-9'><reaction>👍<\/reaction><reaction>❤️<\/reaction><\/reactions>/.test(rx[0]), rx[0]);
  const r2 = R.s.react({to: 'anna@ex.org', target: 'msg-9', on: false, mine: []}); await until(() => rx.length >= 2);
  ok('xmpp: removing the last one sends an empty set', r2 === true && /<reactions [^>]*id='msg-9'><\/reactions>/.test(rx[1]), rx[1]);
  sockRef.write("<message from='anna@ex.org/phone' to='me@ex.org/dsp' type='chat' id='r1'><reactions xmlns='urn:xmpp:reactions:0' id='msg-9'><reaction>🔥</reaction><reaction>👍</reaction></reactions></message>");
  const got = await until(() => R.reacts()[0]);
  ok('xmpp: an incoming reaction message is the set of that person on that message', !!got && got.target === 'msg-9' && got.author === 'anna@ex.org' && got.op === 'set' && got.emojis.join() === '🔥,👍' && got.self === false, JSON.stringify(got));
  ok('xmpp: a reaction message is not shown as a text message', !R.msgs.some(m => m.kind !== 'reaction' && m.text));
  R.s.close(); }

// ================= Nostr (NIP-25 / NIP-09) =================
{ const subs = new Set(), events = []; const sks = M.mgNostrGenKey(), skMe = M.mgNostrGenKey();
  const srv = http.createServer(); servers.push(srv);
  srv.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    const me = {sock}; subs.add(me);
    const send = a => { try { sock.write(wsFrame(JSON.stringify(a))); } catch (e) { /* закрыт */ } }; me.send = send;
    sock.on('data', wsParser({onMsg: t => { const a = JSON.parse(t); if (a[0] === 'REQ') { me.sub = a[1]; me.filter = a[2]; } else if (a[0] === 'EVENT') { events.push(a[1]); send(['OK', a[1].id, true, '']); for (const o of subs) if (o.sub) o.send(['EVENT', o.sub, a[1]]); } }, onClose() {}, onPing() {}}));
    sock.on('close', () => subs.delete(me)); sock.on('error', () => {});
  });
  const port = await listen(srv);
  const R = rig('nostr', {server: 'ws://127.0.0.1:' + port, channel: 'dsp', key: M.mgHex(skMe), nick: 'me'});
  await until(() => R.state() === 'up'); await sleep(100);
  ok('nostr: the subscription asks for messages, deletions and reactions', [...subs][0].filter.kinds.join() === '1,5,7', JSON.stringify([...subs][0].filter));
  const target = 'a'.repeat(64);
  ok('nostr: a reaction is a signed kind 7 event pointing at the message, with the channel tag', R.s.react({target, emoji: '🔥', on: true}) === true && await until(() => events.length === 1) && events[0].kind === 7 && events[0].content === '🔥' && events[0].tags.some(t => t[0] === 'e' && t[1] === target) && events[0].tags.some(t => t[0] === 't' && t[1] === 'dsp') && M.mgNostrVerify(events[0]), JSON.stringify(events[0]));
  const mine = await until(() => R.reacts().find(r => r.op === 'add'));
  ok('nostr: the relay echo is an event of mine', !!mine && mine.self === true && mine.target === target && mine.emojis[0] === '🔥', JSON.stringify(mine));
  const other = M.mgNostrSign(sks, {created_at: Math.floor(Date.now() / 1000), kind: 7, tags: [['e', target], ['t', 'dsp'], ['nick', 'bob']], content: '+'});
  [...subs][0].send(['EVENT', [...subs][0].sub, other]);
  const o = await until(() => R.reacts().find(r => r.author === 'bob'));
  ok('nostr: another person\'s «+» is a thumb with his nick', !!o && o.emojis[0] === '👍' && o.self === false, JSON.stringify(o));
  ok('nostr: removing deletes the event that was sent (kind 5 pointing at it)', R.s.react({target, emoji: '🔥', on: false}) === true && await until(() => events.length === 2) && events[1].kind === 5 && events[1].tags.some(t => t[0] === 'e' && t[1] === events[0].id), JSON.stringify(events[1]));
  const gone = await until(() => R.reacts().find(r => r.op === 'remove'));
  ok('nostr: the deletion comes back as a «remove» of that reaction', !!gone && gone.target === target && gone.emojis[0] === '🔥', JSON.stringify(gone));
  ok('nostr: removing a reaction the session never sent is refused with a reason', R.s.react({target, emoji: '😮', on: false}) === false && /not known/.test(R.text()), R.text());
  R.s.close(); }

for (const s of servers) { try { s.close(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
