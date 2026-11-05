// Регистрация учётки прямо из узла: XMPP (XEP-0077) и Matrix (m.login.dummy): node tools/test-register.mjs
import net from 'node:net';
import http from 'node:http';
import {loadMsgr} from './node/load.mjs';
import {nodeIo} from './node/bridge.mjs';

const M = loadMsgr(), io = nodeIo();
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(15); } return f(); }
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];
const PW = Math.random().toString(36).slice(2, 10);
const rig = (proto, cfg) => { const r = {msgs: [], st: []}; r.s = M.mgConnect(proto, {retry: false, via: 'page', io, ...cfg}, {msg: m => r.msgs.push(m), status: (t, s) => r.st.push([s, t])}); r.state = () => (r.st.at(-1) || [])[0]; r.text = () => (r.st.at(-1) || [])[1]; return r; };
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });

// ---- XMPP: сервер с регистрацией; mode: open | taken | email | closed | nofeature ----
function xmppServer(mode) {
  const seen = {reg: [], auth: 0};
  const srv = net.createServer(sock => {
    sock.setEncoding('utf8'); let acc = '', streams = 0;
    const hdr = f => "<?xml version='1.0'?><stream:stream from='ex.org' id='s" + streams + "' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>" + f;
    sock.on('data', d => { acc += d;
      for (;;) {
        const m = /<stream:stream[^>]*>|<auth[^>]*>[^<]*<\/auth>|<iq[^>]*id='reg\d'[\s\S]*?<\/iq>|<iq[^>]*id='bind1'[\s\S]*?<\/iq>|<iq[^>]*id='roster1'[\s\S]*?<\/iq>|<message[\s\S]*?<\/message>/.exec(acc);
        if (!m) break; acc = acc.slice(m.index + m[0].length);
        const x = m[0];
        if (x.startsWith('<stream:stream')) { streams++; sock.write(hdr(streams === 1 ? "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms>" + (mode === 'nofeature' ? '' : "<register xmlns='http://jabber.org/features/iq-register'/>") + '</stream:features>' : "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>")); }
        else if (x.includes("id='reg1'")) sock.write(mode === 'email' ? "<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><username/><password/><email/></query></iq>" : mode === 'closed' ? "<iq type='error' id='reg1'><error type='cancel'><service-unavailable xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>" : "<iq type='result' id='reg1'><query xmlns='jabber:iq:register'><instructions>pick</instructions><username/><password/></query></iq>");
        else if (x.includes("id='reg2'")) { seen.reg.push(x); sock.write(mode === 'taken' ? "<iq type='error' id='reg2'><error type='cancel'><conflict xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>" : "<iq type='result' id='reg2'/>"); }
        else if (x.startsWith('<auth')) { seen.auth++; sock.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>"); }
        else if (x.includes("id='bind1'")) sock.write("<iq type='result' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>newbie@ex.org/dsp</jid></bind></iq>");
      } });
    sock.on('error', () => {});
  }); servers.push(srv);
  return {srv, seen};
}
for (const [mode, expect] of [['open', 'up'], ['taken', 'fatal'], ['email', 'fatal'], ['closed', 'fatal'], ['nofeature', 'fatal']]) {
  const {srv, seen} = xmppServer(mode), port = await listen(srv);
  const R = rig('xmpp', {user: 'newbie@ex.org', pass: PW, server: 'xmpp://127.0.0.1:' + port, insecure: true, register: true, nick: 'nb'});
  await until(() => R.state() === 'up' || R.state() === 'fatal');
  const t = R.text();
  if (mode === 'open') {
    ok('xmpp register: account is created, then the login follows and succeeds', R.state() === 'up' && /newbie@ex\.org\/dsp/.test(t) && seen.auth === 1, JSON.stringify(R.st));
    ok('xmpp register: the status tells «registered» (the node clears its flag by it)', R.st.some(x => /^registered newbie@ex\.org/.test(x[1])), JSON.stringify(R.st));
    ok('xmpp register: only login and password were sent (the name is the local part)', seen.reg.length === 1 && /<username>newbie<\/username><password>/.test(seen.reg[0]) && !/email/.test(seen.reg[0]), seen.reg[0]);
  } else if (mode === 'taken') ok('xmpp register: a taken name is said so', R.state() === 'fatal' && /name is taken/.test(t) && seen.auth === 0, t);
  else if (mode === 'email') ok('xmpp register: a server that wants an e-mail / captcha sends the user to its website, nothing is sent', R.state() === 'fatal' && /email/.test(t) && /website/.test(t) && !seen.reg.length, t);
  else if (mode === 'closed') ok('xmpp register: registration unavailable is reported', R.state() === 'fatal' && /not available/.test(t), t);
  else ok('xmpp register: a server without the feature is not asked to log in with a new account', R.state() === 'fatal' && /does not offer registration/.test(t) && seen.auth === 0, t);
  R.s.close();
}
// без флага регистрации сервер с такой возможностью просто принимает вход
{ const {srv, seen} = xmppServer('open'), port = await listen(srv);
  const R = rig('xmpp', {user: 'newbie@ex.org', pass: PW, server: 'xmpp://127.0.0.1:' + port, insecure: true, nick: 'nb'});
  await until(() => R.state() === 'up');
  ok('xmpp without the register flag logs in as before, no registration traffic', R.state() === 'up' && !seen.reg.length && seen.auth === 1, JSON.stringify(R.st)); R.s.close(); }

// ---- Matrix: mode open (dummy) | captcha | taken | closed ----
function matrixServer(mode) {
  const seen = {reg: [], logins: 0};
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), js = (o, code = 200) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (u.pathname.endsWith('/register')) {
      const b = JSON.parse(await body(req)); seen.reg.push(b);
      if (mode === 'closed') return js({errcode: 'M_FORBIDDEN', error: 'Registration has been disabled'}, 403);
      if (mode === 'taken') return js({errcode: 'M_USER_IN_USE', error: 'User ID already taken.'}, 400);
      if (!b.auth) return js({session: 's1', flows: [mode === 'captcha' ? {stages: ['m.login.recaptcha', 'm.login.terms']} : {stages: ['m.login.dummy']}]}, 401);
      return js({access_token: 'tok-' + PW, user_id: '@' + b.username + ':hs', device_id: 'D'});
    }
    if (u.pathname.endsWith('/login')) { seen.logins++; return js({access_token: 'tok-' + PW, user_id: '@x:hs'}); }
    if (req.headers.authorization !== 'Bearer tok-' + PW) return js({errcode: 'M_UNKNOWN_TOKEN'}, 401);
    if (u.pathname.endsWith('/sync')) { await sleep(150); return js({next_batch: 'b', rooms: {}}); }
    if (u.pathname.endsWith('/joined_rooms')) return js({joined_rooms: []});
    js({});
  }); servers.push(srv);
  return {srv, seen};
}
for (const mode of ['open', 'captcha', 'taken', 'closed']) {
  const {srv, seen} = matrixServer(mode), port = await listen(srv);
  const R = rig('matrix', {server: 'http://127.0.0.1:' + port, user: 'newbie', pass: PW, register: true, cache: {}});
  await until(() => R.state() === 'up' || R.state() === 'fatal');
  const t = R.text();
  if (mode === 'open') {
    ok('matrix register: the dummy flow creates the account and the session goes up with its token (no password login)', R.state() === 'up' && seen.logins === 0 && seen.reg.length === 2 && seen.reg[1].auth.type === 'm.login.dummy' && seen.reg[1].auth.session === 's1', JSON.stringify(R.st));
    ok('matrix register: the status tells «registered» with the full user id', R.st.some(x => /^registered @newbie:hs/.test(x[1])), JSON.stringify(R.st));
  } else if (mode === 'captcha') ok('matrix register: a server that wants a captcha / terms is explained, nothing else is sent', R.state() === 'fatal' && /recaptcha/.test(t) && /website/.test(t) && seen.reg.length === 1, t);
  else if (mode === 'taken') ok('matrix register: a taken name is said so', R.state() === 'fatal' && /name is taken/.test(t), t);
  else ok('matrix register: closed registration is reported as the server says', R.state() === 'fatal' && /disabled/.test(t), t);
  R.s.close();
}

for (const s of servers) { try { s.close(); } catch (e) { /* закрыт */ } }
console.log(bad ? bad + ' FAILED' : 'all passed');
process.exit(bad ? 1 : 0);
