// Reticulum + LXMF против настоящей реализации (RNS / LXMF на Python): node tools/test-rns.mjs
// Нужен Python с пакетами rns и lxmf: RNS_PY=/путь/к/python node tools/test-rns.mjs  (pip install rns lxmf). Без него тест пропускается.
import {spawn, spawnSync} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {loadMsgr} from './node/load.mjs';
import {nodeIo} from './node/bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) { bad++; console.log('FAIL', n, extra); } else console.log('ok  ', n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(40); } return f(); }

// --- без Python — только то, что можно проверить сразу: msgpack и HDLC ---
const M = loadMsgr();
{ const h = M.rnMpPack([new M.RnFloat(1700000000.5), new TextEncoder().encode('title'), new TextEncoder().encode('привет'), new Map([[1, 'x']]), null, true, -5, 300, 70000]);
  const {v} = M.rnMpUnpack(h);
  ok('msgpack: round trip (float64 / bin / map / negative / sizes)', v[0].v === 1700000000.5 && new TextDecoder().decode(v[2]) === 'привет' && v[3].get(1) === 'x' && v[4] === null && v[5] === true && v[6] === -5 && v[7] === 300 && v[8] === 70000);
  ok('msgpack: float64 is 0xcb and bin is 0xc4 (as msgpack-python writes them)', h[1] === 0xcb && h[10] === 0xc4);
  const frames = []; const d = M.rnDeframer(f => frames.push(f));
  const payload = Uint8Array.from({length: 40}, (_, i) => i === 3 ? 0x7e : i === 9 ? 0x7d : i);
  const fr = M.rnHdlc(payload); d(fr.slice(0, 7)); d(fr.slice(7));
  ok('hdlc: escaping and split chunks', frames.length === 1 && Buffer.from(frames[0]).equals(Buffer.from(payload)));
}

const PY = process.env.RNS_PY || 'python3';
const have = spawnSync(PY, ['-c', 'import RNS, LXMF'], {encoding: 'utf8'});
if (have.status !== 0) { console.log('skip: no Python with rns + lxmf (set RNS_PY)'); console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0); }
const bin = dir => path.join(path.dirname(PY), dir);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rns-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const nodeDir = path.join(tmp, 'node'), peerDir = path.join(tmp, 'peer');
fs.mkdirSync(nodeDir); fs.mkdirSync(peerDir);
fs.writeFileSync(path.join(nodeDir, 'config'), `[reticulum]\n  enable_transport = yes\n  share_instance = no\n  instance_name = dspnode\n[interfaces]\n  [[Server]]\n    type = TCPServerInterface\n    enabled = yes\n    listen_ip = 127.0.0.1\n    listen_port = ${port}\n`);
fs.writeFileSync(path.join(peerDir, 'config'), `[reticulum]\n  enable_transport = no\n  share_instance = no\n  instance_name = dsppeer\n[interfaces]\n  [[Client]]\n    type = TCPClientInterface\n    enabled = yes\n    target_host = 127.0.0.1\n    target_port = ${port}\n`);
const procs = [];
const rnsd = spawn(bin('rnsd'), ['--config', nodeDir], {stdio: 'ignore'}); procs.push(rnsd);
await sleep(2500);
const peer = spawn(PY, [path.join(here, 'test-rns', 'peer.py'), peerDir, 'Пир-питон'], {stdio: ['pipe', 'pipe', 'inherit']}); procs.push(peer);
const pev = []; readline.createInterface({input: peer.stdout}).on('line', l => { try { pev.push(JSON.parse(l)); } catch (e) {} });
const cmd = o => peer.stdin.write(JSON.stringify(o) + '\n');
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch (e) {} fs.rmSync(tmp, {recursive: true, force: true}); };
process.on('exit', cleanup);
const ready = await until(() => pev.find(e => e.ev === 'ready'), 30000);
ok('python peer is up on a real Reticulum network', !!ready);

// --- наш узел ---
const msgs = [], st = [], peers = [];
const sock = net.connect(port, '127.0.0.1');
const mine = new M.RnsNode({name: 'dsp-test', announceMs: 600000, write: b => sock.write(Buffer.from(b)), onMsg: m => msgs.push(m), onStatus: (t, s) => st.push([s, t]), onPeer: p => peers.push(p)});
sock.on('data', d => mine.feed(new Uint8Array(d)));
sock.on('error', () => {});
await new Promise(r => sock.once('connect', r));
await mine.start();
ok('node starts with a 16-byte address', mine.destHex.length === 32, mine.destHex);

const heard = await until(() => peers.find(p => p.hex === ready.hash), 20000);
ok('hears the peer\'s announce through the transport node (signature + destination hash checked)', !!heard && heard.name === 'Пир-питон', JSON.stringify(heard && {n: heard.name, h: heard.hops}));
cmd({cmd: 'announce'});

// наш анонс должен дойти до партнёра: он отправляет нам по Link (DIRECT — так шлёт Sideband)
await sleep(2500);
cmd({cmd: 'send', to: mine.destHex, text: 'привет по линку', method: 'direct'});
const m1 = await until(() => msgs.find(m => m.text === 'привет по линку'), 30000);
ok('receives an LXMF message over a Link (handshake, token, signature)', !!m1, JSON.stringify(st.slice(-3)));
ok('the message is verified against the announced key and comes from the peer', m1 && m1.unverified === false && m1.from === 'Пир-питон', JSON.stringify(m1));
ok('it really came over a Link', m1 && m1.link === true);
ok('the peer got the delivery proof for the link message', !!await until(() => pev.find(e => e.ev === 'delivered' && e.text === 'привет по линку'), 20000), JSON.stringify(pev.slice(-3)));

cmd({cmd: 'send', to: mine.destHex, text: 'и одним пакетом', method: 'opportunistic'});
const m2 = await until(() => msgs.find(m => m.text === 'и одним пакетом'), 30000);
ok('receives an opportunistic (single packet) LXMF message', !!m2 && m2.unverified === false && m2.link === false, JSON.stringify(m2));
ok('the peer got the delivery proof for the single packet', !!await until(() => pev.find(e => e.ev === 'delivered' && e.text === 'и одним пакетом'), 20000));

// отправка с нашей стороны
ok('send to the peer by its announced name', await mine.send('привет от DSP 👋', 'пир') === true);
const got = await until(() => pev.find(e => e.ev === 'msg' && e.text === 'привет от DSP 👋'), 20000);
ok('the python LXMF router receives and verifies our message', !!got && got.verified === true && got.from === mine.destHex, JSON.stringify(got));
ok('our message is marked delivered by the proof from the peer', !!await until(() => st.find(s => /delivered to/.test(s[1])), 20000), JSON.stringify(st.slice(-3)));
ok('send by the 32-character address', await mine.send('по адресу', ready.hash) === true && !!await until(() => pev.find(e => e.ev === 'msg' && e.text === 'по адресу'), 20000));
ok('an unknown name is refused with an explanation', await mine.send('x', 'nobody-here') === false && /no address/.test(st.at(-1)[1]));
ok('a long text is split into packets that all arrive', await mine.send('д'.repeat(400), ready.hash) === true && !!await until(() => pev.filter(e => e.ev === 'msg' && /^д+$/.test(e.text)).length >= 2, 20000));


// --- то же через сессию узла Messenger (mgConnect, proto reticulum) ---
{ const sm = [], sst = [];
  const key = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(64))).toString('hex');
  const s = M.mgConnect('reticulum', {server: 'rns://127.0.0.1:' + port, key, nick: 'сессия', via: 'page', retry: false, io: nodeIo(), announceMs: 600000}, {msg: m => sm.push(m), status: (t, st) => sst.push([st, t])});
  const addr = await until(() => sst.map(x => /<([0-9a-f]{32})>/.exec(x[1])).find(Boolean), 15000);
  ok('session: connects and reports its address', !!addr, JSON.stringify(sst));
  cmd({cmd: 'announce'});                    // анонсы не повторяются для новых клиентов — просим партнёра объявиться уже при нас
  await until(() => sst.some(x => /address\(es\) heard/.test(x[1])), 15000); await sleep(800);
  ok('session: send « @name text »', await s.send('@пир через сессию') === true && !!await until(() => pev.find(e => e.ev === 'msg' && e.text === 'через сессию'), 20000));
  ok('session: own message echoed', sm.at(-1)?.self === true && sm.at(-1).text === 'через сессию');
  cmd({cmd: 'announce'}); await sleep(500);
  if (addr) cmd({cmd: 'send', to: addr[1], text: 'ответ в сессию', method: 'direct'});
  ok('session: incoming message', !!await until(() => sm.find(m => m.text === 'ответ в сессию' && m.from === 'Пир-питон'), 30000), JSON.stringify(sm.slice(-2)));
  ok('session: no recipient → explained', await s.send('просто текст') === false && /address a message/.test(sst.at(-1)[1]));
  const bad = []; const b = M.mgConnect('reticulum', {server: 'rns://127.0.0.1:1', key: 'zz', via: 'page', io: nodeIo()}, {msg() {}, status: (t, st) => bad.push([st, t])});
  ok('session: a bad key is refused', bad.some(x => x[0] === 'fatal' && /128 hex/.test(x[1])), JSON.stringify(bad)); b.close();
  s.close();
}
mine.stop(); sock.destroy(); cmd({cmd: 'quit'});
console.log(bad ? 'FAILED ' + bad : 'all ok');
cleanup(); process.exit(bad ? 1 : 0);
