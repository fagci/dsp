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
  const srv = addNode('rtlserve', 400, 40, { transport: 'TCP port (phone app / desktop bridge)', url: 'ws://127.0.0.1:' + wsPort, port, lan: false });
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

// скорость через «Wi-Fi» с задержкой 40 мс в каждую сторону: новое приложение (ordered) держит несколько блоков в полёте, старое — по одному
async function rate(opt, port) {
  const br = await mockBridgeWs(0, { app: true, latency: 40, ...opt });
  await pg.evaluate(([wp, pt]) => { __srv.p.url = 'ws://127.0.0.1:' + wp; __srv.p.port = pt; rtlsStart(__srv); }, [br.port, port]);
  await wait(1500);
  const c = net.connect(port, '127.0.0.1'); let got = 0; c.on('data', (d) => { got += d.length; });
  await wait(600); const g0 = got; await wait(3000); const bps = (got - g0) / 3;
  const info = await pg.evaluate(() => ({ ordered: __srv.ordered, binary: __srv.binary, dropped: __srv.dropped }));
  c.destroy(); await pg.evaluate(() => rtlsStop(__srv)); await wait(300); br.close();
  return { bps, ...info };
}
const fast = await rate({}, 21301), mid = await rate({ nobin: true }, 21304), slow = await rate({ legacy: true }, 21302);
console.log('rate with 40 ms each way: binary', Math.round(fast.bps / 1000), 'kB/s, pipelined hex', Math.round(mid.bps / 1000), 'kB/s, old app', Math.round(slow.bps / 1000), 'kB/s');
ok('newest app (binary frames) carries the full 1.024 MS/s through 80 ms of latency', fast.ordered && fast.binary && fast.bps > 1.9e6, JSON.stringify(fast));
ok('pipelined hex (previous app) also carries 1.024 MS/s here', mid.ordered && !mid.binary && mid.bps > 1.9e6, JSON.stringify(mid));
ok('old app still works, bigger blocks, but slower', !slow.ordered && !slow.binary && slow.bps > 2e5 && slow.bps < fast.bps / 3, JSON.stringify(slow));

// клиент просит 250 kS/s, USB SDR даёт 1.024 MS/s: узел пересэмплирует (≈ 500 кБ/с вместо 2 МБ/с), в readout это видно
{
  const br = await mockBridgeWs(0, { app: true });
  await pg.evaluate(([wp, pt]) => { __srv.p.url = 'ws://127.0.0.1:' + wp; __srv.p.port = pt; rtlsStart(__srv); }, [br.port, 21303]);
  await wait(1500);
  const c = net.connect(21303, '127.0.0.1'); let got = 0; c.on('data', (d) => { got += d.length; });
  await wait(400); c.write(Buffer.from('02' + (250000).toString(16).padStart(8, '0'), 'hex'));
  await wait(1200); const g0 = got; await wait(3000); const bps = (got - g0) / 3;
  const rs = await pg.evaluate(() => ({ resamp: __srv.resamp, dropped: __srv.dropped, status: __srv.status }));
  ok('client asked 250 kS/s: the node sends ~500 kB/s, not 2 MB/s', bps > 4.2e5 && bps < 5.8e5 && /1024000>250000/.test(rs.resamp), Math.round(bps) + ' B/s ' + JSON.stringify(rs));
  c.destroy(); await pg.evaluate(() => rtlsStop(__srv)); await wait(300); br.close();
}

// клиент просит чуть больше, чем даёт железо (1.1 MS/s при потоке 1.024): интерполяция вверх, а не «врём о частоте»
{
  const br = await mockBridgeWs(0, { app: true });
  await pg.evaluate(([wp, pt]) => { __srv.p.url = 'ws://127.0.0.1:' + wp; __srv.p.port = pt; rtlsStart(__srv); }, [br.port, 21305]);
  await wait(1500);
  const c = net.connect(21305, '127.0.0.1'); let got = 0; c.on('data', (d) => { got += d.length; });
  await wait(400); c.write(Buffer.from('02' + (1100000).toString(16).padStart(8, '0'), 'hex'));
  await wait(1200); const g0 = got; await wait(3000); const bps = (got - g0) / 3;
  const rs = await pg.evaluate(() => ({ resamp: __srv.resamp, status: __srv.status }));
  ok('client asked 1.1 MS/s, stream 1.024: interpolated up (~2.2 MB/s)', bps > 2.0e6 && bps < 2.4e6 && /1024000>1100000/.test(rs.resamp), Math.round(bps) + ' B/s ' + JSON.stringify(rs));
  c.destroy(); await pg.evaluate(() => rtlsStop(__srv)); await wait(300); br.close();
}

// приложение с выключенным «Let any page use actions» отвечает forbidden — узел говорит, что включить
await pg.evaluate((port) => { __srv.p.url = 'ws://127.0.0.1:' + port; rtlsStart(__srv); }, closed403.port); await wait(1200);
const fst = await pg.evaluate(() => __srv.status);
ok('forbidden → tells to turn on «Let any page use actions»', /Let any page use actions/.test(fst), fst);
await pg.evaluate(() => rtlsStop(__srv));
console.log('page errors:', errs.slice(0, 3));
await b.close(); bridge.close(); closed403.close();
process.exit(bad ? 1 : 0);
