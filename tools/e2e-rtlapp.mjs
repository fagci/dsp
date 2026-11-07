// Сквозная проверка: узел rtl_tcp Server (TCP-порт) ↔ мост-имитатор приложения на сокетах Node ↔ обычный TCP-клиент.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-rtlapp.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
import { mockBridgeWs } from './netmock-ws.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bridge = await mockBridgeWs(0, { app: true });        // строго как приложение: подписка на net и пачки-массивы
const closed403 = await mockBridgeWs(0, { forbid: true });
const PORT = 21234;
const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
await pg.evaluate(async ([wsPort, port]) => {
  clearAll();
  const gen = addNode('iqGen', 40, 40, { sr: '1024000', fc: 100000000, mode: 'carrier' });
  const srv = addNode('rtlserve', 400, 40, { transport: 'TCP port (phone app / net-bridge)', url: 'ws://127.0.0.1:' + wsPort, port, lan: false });
  addEdge(gen.id, 'iq', srv.id, 'iq'); markWiresDirty();
  window.__srv = srv; rtlsStart(srv); await Eng.start();
}, [bridge.port, PORT]);
await wait(1200);
ok('app listens', /listening on port/.test(await pg.evaluate(() => __srv.status)), await pg.evaluate(() => __srv.status));

const cli = net.connect(PORT, '127.0.0.1'); const chunks = []; cli.on('data', (d) => chunks.push(d));
await wait(300);
cli.write(Buffer.from('0105f5e100', 'hex')); cli.write(Buffer.from('0200249f00', 'hex'));      // 100 MHz, 2.4 MS/s
await wait(2500);
const all = Buffer.concat(chunks);
ok('header first: RTL0, R820T', all.subarray(0, 12).toString('hex') === '52544c30000000050000001d', all.subarray(0, 12).toString('hex'));
ok('IQ follows (> 500 kB in 2.5 s)', all.length > 500000, String(all.length));
const st = await pg.evaluate(() => ({ f: __srv.st.freq, sr: __srv.st.sr, cli: __srv.cli, status: __srv.status, dropped: __srv.dropped }));
ok('commands decoded', st.f === 100000000 && st.sr === 2400000, JSON.stringify(st));
const cli2 = net.connect(PORT, '127.0.0.1'); const closed = new Promise((r) => cli2.on('close', r));
await Promise.race([closed, wait(1500)]);
ok('second client refused (one at a time)', cli2.destroyed);
cli.destroy(); await wait(600);
ok('client left → waiting again', /waiting for a client/.test(await pg.evaluate(() => __srv.status)), await pg.evaluate(() => __srv.status));
const cli3 = net.connect(PORT, '127.0.0.1'); const c3 = []; cli3.on('data', (d) => c3.push(d)); await wait(800);
ok('new client gets a fresh header', Buffer.concat(c3).subarray(0, 4).toString() === 'RTL0');
cli3.destroy();
await pg.evaluate(() => rtlsStop(__srv)); await wait(300);
// старый патч с transport «WebSocket (bridge)» тоже работает через мост приложения
await pg.evaluate(() => { __srv.p.transport = 'WebSocket (bridge)'; rtlsStart(__srv); }); await wait(1000);
ok('legacy transport value still listens', /listening on port/.test(await pg.evaluate(() => __srv.status)), await pg.evaluate(() => __srv.status));
await pg.evaluate(() => rtlsStop(__srv)); await wait(300);
const c4 = net.connect(PORT, '127.0.0.1'); const refused = await new Promise((r) => { c4.on('error', () => r(true)); c4.on('connect', () => { c4.destroy(); r(false); }); });
ok('Stop releases the port', refused);
// приложение с выключенным «Let any page use actions» отвечает forbidden — узел говорит, что включить
await pg.evaluate((port) => { __srv.p.url = 'ws://127.0.0.1:' + port; rtlsStart(__srv); }, closed403.port); await wait(1200);
const fst = await pg.evaluate(() => __srv.status);
ok('forbidden → tells to turn on «Let any page use actions»', /Let any page use actions/.test(fst), fst);
await pg.evaluate(() => rtlsStop(__srv));
console.log('page errors:', errs.slice(0, 3));
await b.close(); bridge.close(); closed403.close();
process.exit(bad ? 1 : 0);
