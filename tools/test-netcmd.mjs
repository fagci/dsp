// Сетевые команды Node-моста (ping, tcp.*): разбор вывода ping, политика адресов, сквозные проверки Batch Check через настоящий мост.
// Проверка: node tools/test-netcmd.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createMsgrBridge} from './node/bridge.mjs';
import {createNetCmds, parsePing, pingArgs} from './node/netcmd.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let bad = 0; const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = x => JSON.stringify(x);

// ---- разбор вывода ping на разных системах ----
const linux = 'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.\n64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=11.2 ms\n64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=12.8 ms\n\n--- 8.8.8.8 ping statistics ---\n2 packets transmitted, 2 received, 0% packet loss';
let r = parsePing(linux, 2); ok('ping linux', r.got === 2 && r.avg === 12 && r.min === 11.2 && r.max === 12.8, J(r));
const win = 'Reply from 8.8.8.8: bytes=32 time=14ms TTL=117\nReply from 8.8.8.8: bytes=32 time<1ms TTL=117\nReply from 192.168.0.1: TTL expired in transit.';
r = parsePing(win, 3); ok('ping windows: TTL expired — не ответ', r.got === 2 && r.sent === 3, J(r));
const ru = 'Ответ от 8.8.8.8: число байт=32 время=15мс TTL=117\nПревышен интервал ожидания для запроса.';
r = parsePing(ru, 2); ok('ping windows (русская): время=15мс', r.got === 1 && r.avg === 15, J(r));
r = parsePing('Request timed out.\nRequest timed out.', 2); ok('ping: никто не ответил', r.got === 0 && r.avg === 0, J(r));
ok('аргументы ping', J(pingArgs('linux', '1.2.3.4', 2, 3)) === J(['-c', '2', '-W', '3', '-n', '1.2.3.4']) && pingArgs('win32', '1.2.3.4', 2, 3).includes('-w') && pingArgs('darwin', 'x', 1, 2).includes('2000'));

// ---- команды напрямую, с подставным ping и политикой ----
const policy = {hostOk: () => true, classOk: (c) => c === 'public', ipClass: ip => ip.startsWith('127.') ? 'loopback' : 'public', lookup: (h, o, cb) => cb(null, '8.8.8.8', 4)};
function mk(over = {}) {
  const sent = []; const spawned = [];
  const spawnFn = (cmd, args) => { spawned.push([cmd, args]); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.kill = () => {}; setTimeout(() => { p.stdout.emit('data', linux); p.emit('close', 0); }, 5); return p; };
  const c = createNetCmds({policy, send: x => sent.push(x), spawnFn, platform: 'linux', ...over });
  return {c, sent, spawned};
}
{ const {c, sent, spawned} = mk(); await c.handle({cmd: 'ping', id: 1, host: 'example.org', count: 2});
  ok('ping: ответ got/sent/avg, ping вызван по найденному IP без shell', sent[0].ok && sent[0].got === 2 && sent[0].avg === 12 && spawned[0][0] === 'ping' && spawned[0][1].at(-1) === '8.8.8.8', J(sent[0]) + J(spawned)); }
{ const {c, sent} = mk(); await c.handle({cmd: 'ping', id: 1, host: '-c1 8.8.8.8'}); ok('ping: аргумент-инъекция отклонена', !sent[0].ok && sent[0].err === 'args', J(sent[0])); }
{ const {c, sent} = mk(); await c.handle({cmd: 'ping', id: 1, host: '127.0.0.1'}); ok('ping: loopback закрыт политикой', !sent[0].ok && sent[0].err === 'forbidden', J(sent[0])); }
{ const {c, sent} = mk(); await c.handle({cmd: 'sms.send', id: 1, to: '+1', text: 'x'}); ok('чужая команда → unsupported со словами про телефон', !sent[0].ok && sent[0].err === 'unsupported' && /phone/.test(sent[0].msg), J(sent[0])); }
{ const {c, sent} = mk({enabled: false}); await c.handle({cmd: 'ping', id: 1, host: 'example.org'}); ok('--no-net: disabled', sent[0].err === 'disabled', J(sent[0])); }
{ const {c, sent} = mk({spawnFn: () => { const e = Object.assign(new Error('x'), {code: 'ENOENT'}); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.kill = () => {}; setTimeout(() => p.emit('error', e), 2); return p; }});
  await c.handle({cmd: 'ping', id: 1, host: 'example.org'}); ok('ping не установлен — внятная ошибка', sent[0].err === 'unsupported' && /not installed/.test(sent[0].msg), J(sent[0])); }

// ---- настоящий мост + NetSock + ядра Batch Check ----
const echo = net.createServer(s => { s.on('data', d => s.write(d)); }); await new Promise(r => echo.listen(0, '127.0.0.1', r));
const web = http.createServer((q, s) => { if (q.url === '/ok') { s.writeHead(200, {'content-type': 'text/html'}); s.end('<h1>Hello bridge</h1>'); } else { s.writeHead(404); s.end('no'); } });
await new Promise(r => web.listen(0, '127.0.0.1', r));
const ctx = vm.createContext({console, Math, Object, Array, Set, Map, Number, String, JSON, RegExp, Date, Promise, isFinite, isNaN, parseFloat, parseInt, Uint8Array, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, btoa, Error, AbortController});
vm.runInContext(rd('modules/netsock-kernels.js') + rd('modules/http-kernels.js') + rd('modules/batch-kernels.js') + ';globalThis.K={NetSock,bchCheck};', ctx);
const open = async url => {
  const ws = new WebSocket(url); const ns = new ctx.K.NetSock(m => ws.send(JSON.stringify(m)));
  ws.onmessage = e => { for (const x of [].concat(JSON.parse(String(e.data)))) ns.feed(x); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  return {ws, ns};
};
const br = createMsgrBridge({port: 0, proxyLoopback: true}); const bp = (await br.listen()).port;
{
  const {ws, ns} = await open('ws://127.0.0.1:' + bp);
  const env = {ns: async () => ns, now: () => Date.now(), sleep, fetch: null, sel: null};
  const O = {kind: 'ping', keyCol: 'id', timeout: 3000, expect: '', contains: '', selector: '', port: 80, count: 1, via: 'bridge', warnDays: 30};
  const ep = echo.address().port, wp = web.address().port;

  let c = await ctx.K.bchCheck(env, {id: 't1', host: '127.0.0.1', kind: 'tcp', port: String(ep)}, O);
  ok('tcp через мост ноутбука: порт открыт', c.ok === 1 && c.status === 'ok', J(c));
  c = await ctx.K.bchCheck(env, {id: 't2', host: '127.0.0.1', kind: 'tcp', port: '9'}, O);
  ok('tcp через мост: закрытый порт — fail, не error', c.ok === 0 && c.status === 'fail', J(c));
  c = await ctx.K.bchCheck(env, {id: 'h1', url: 'http://127.0.0.1:' + wp + '/ok', kind: 'http', expect: '200', contains: 'hello bridge'}, O);
  ok('http через мост: 200 и текст', c.ok === 1 && c.found === 1 && c.code === 200, J(c));
  c = await ctx.K.bchCheck(env, {id: 'h2', url: 'http://127.0.0.1:' + wp + '/gone', kind: 'http', expect: '200'}, O);
  ok('http через мост: 404 — fail', c.ok === 0 && c.code === 404, J(c));
  c = await ctx.K.bchCheck(env, {id: 's1', to: '+7000', kind: 'sms', text: 'x'}, O);
  ok('SMS на мосте ноутбука — сразу понятная ошибка, а не зависание', c.status === 'error' && /phone/.test(c.detail), J(c));
  c = await ctx.K.bchCheck(env, {id: 'u1', kind: 'ussd', code: '*100#'}, O);
  ok('USSD на мосте ноутбука — сразу понятная ошибка', c.status === 'error' && /phone/.test(c.detail), J(c));
  ws.close();
}
{ // по умолчанию loopback закрыт (как у CORS-прокси)
  const b2 = createMsgrBridge({port: 0}); const p2 = (await b2.listen()).port;
  const {ws, ns} = await open('ws://127.0.0.1:' + p2);
  const env = {ns: async () => ns, now: () => Date.now(), sleep, fetch: null, sel: null};
  const c = await ctx.K.bchCheck(env, {id: 'x', host: '127.0.0.1', kind: 'tcp', port: String(echo.address().port)}, {kind: 'tcp', keyCol: 'id', timeout: 2000, port: 0});
  ok('по умолчанию loopback закрыт', c.status === 'error' && /not allowed/.test(c.detail), J(c)); ws.close(); b2.close();
}
{ // --no-net
  const b3 = createMsgrBridge({port: 0, net: false, proxyLoopback: true}); const p3 = (await b3.listen()).port;
  const {ws, ns} = await open('ws://127.0.0.1:' + p3);
  let e = null; try { await ns.call('ping', {host: '8.8.8.8'}, 3000); } catch (x) { e = x; }
  ok('--no-net: команды выключены', e && e.reply && e.reply.err === 'disabled', e && e.message); ws.close(); b3.close();
}
br.close(); echo.close(); web.close();
if (bad) { console.log(bad + ' FAILED'); process.exit(1); }
console.log('all ok');
process.exit(0);
