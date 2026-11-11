// Network Links в браузере: мост-имитатор отдаёт сети и сокеты (net.watch / net.sockets), узел кормит Graph и выдаёт записи об изменениях.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-netlinks.mjs
import { createRequire } from 'node:module';
import { mockBridgeWs } from './netmock-ws.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const net = (id, kind, o = {}) => ({ id, kind, iface: 'if' + id, ips: ['10.0.0.' + id], dns: ['1.1.1.1'], gateway: '10.0.0.1', validated: true, metered: false, default: false, down: 0, up: 0, roaming: false, ...o });
let nets = [net(100, 'wifi', { default: true, down: 866000 }), net(101, 'cell', { metered: true, down: 50000 })];
let bytes = 0;
const socks = () => [
  { id: 7, kind: 'tcp-server', addr: '0.0.0.0:8080', net: 'wifi#100', age: 5000, rx: 0, tx: 0 },
  { id: 8, kind: 'tcp', addr: '1.2.3.4:5555', net: 'wifi#100', server: 7, age: 4000, rx: bytes, tx: bytes / 2 },
  { id: 9, kind: 'tcp', addr: 'example.com:80', net: 'cell#101', age: 3000, rx: 100, tx: 100 },
];
let cmds = [];
const br = await mockBridgeWs(0, { app: true, extra: (j, reply, ev) => {
  cmds.push(j.cmd);
  if (j.cmd === 'net.watch') { reply(j.id, j.cmd, null, { on: j.on !== false, nets, socks: socks() }); return true; }
  if (j.cmd === 'net.sockets') { bytes += 4000; reply(j.id, j.cmd, null, { socks: socks() }); return true; }
  return false;
} });

const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
await pg.evaluate((p) => {
  clearAll();
  const nl = addNode('netlinks', 40, 40, { url: 'ws://127.0.0.1:' + p, poll: 250 }); const g = addNode('graphview', 600, 40, { weights: true });
  const tb = addNode('table', 600, 500, { list: '@patch', key: 'id', initial: false });
  addEdge(nl.id, 'rows', g.id, 'rows'); addEdge(nl.id, 'rec', tb.id, 'rec'); markWiresDirty(); window.__nl = nl; window.__g = g;
}, br.port);
await pg.click('#run');                                         // узлам нужен идущий граф
await wait(3000);
let st = await pg.evaluate(() => ({ nets: __nl.nets.length, socks: __nl.socks.length, graph: __nl.graph.length, gn: __g.dN && __g.dN.size, ge: __g.dE && __g.dE.size, status: __nl.status }));
ok('networks and sockets arrive', st.nets === 2 && st.socks === 3, JSON.stringify(st));
ok('Graph gets phone + 2 networks + 3 sockets', st.gn === 6, JSON.stringify(st));
ok('Graph has 5 edges (phone→net ×2, net→sock ×2, server→conn)', st.ge === 5, JSON.stringify(st));
ok('bridge asked for net.watch and then polled net.sockets', cmds.includes('net.watch') && cmds.filter((c) => c === 'net.sockets').length >= 2, cmds.join());
const spd = await pg.evaluate(() => __nl.text);
ok('traffic gives a speed in the text', /↓[1-9]/.test(spd), spd);

// сеть пропала и появилась другая: запись-изменение и новый узел в Graph
nets = [nets[0], net(102, 'eth', { validated: true })];
const before = await pg.evaluate(() => __nl.recQ.length + (__nl.pulse | 0));
// событие моста: ev:'networks' (как net.watch)
const sent = await pg.evaluate((snap) => { __nl.ns.feed({ src: 'net', ev: 'networks', nets: snap.nets, socks: snap.socks }); return __nl.nets.length; }, { nets, socks: socks() });
await wait(500);
const ch = await pg.evaluate(() => __nl.nets.map((n) => n.kind).join());
ok('event ev:networks replaces the list', ch === 'wifi,eth', ch);
const gn = await pg.evaluate(() => __g.dN.size);
ok('Graph follows (eth appeared, cell gone: the cell socket hangs on the phone)', gn === 6, String(gn));
ok('no page errors', errs.length === 0, errs.join(' | '));

// мост пропал: последнее состояние остаётся с пометкой «устарело»
await pg.evaluate(() => __nl.ws.close()); br.close(); await wait(1500);
const stale = await pg.evaluate(() => ({ s: __nl.stale, n: __nl.nets.length }));
const txt = await pg.evaluate(() => __nl.el.querySelector('.readout').textContent);
ok('bridge lost: last state kept and marked stale', stale.n === 2 && /stale/.test(txt), txt.slice(0, 80));
await b.close();
if (bad) { console.log(bad + ' failed'); process.exit(1); }
console.log('e2e netlinks: all ok');
