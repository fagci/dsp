// Сквозная проверка клиента: IQ over Network (rtl_tcp через мост приложения) ↔ мост-имитатор приложения ↔ настоящий rtl_tcp (имитация на сокетах Node).
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-iqnet-app.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
import { mockBridgeWs } from './netmock-ws.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// «rtl_tcp»: заголовок, потом ~2 МБ/с uint8 IQ; команды клиента копим
const cmds = [];
const rtl = net.createServer((s) => {
  s.write(Buffer.from('52544c30000000050000001d', 'hex'));
  let acc = Buffer.alloc(0);
  s.on('data', (d) => { acc = Buffer.concat([acc, d]); while (acc.length >= 5) { cmds.push(acc.subarray(0, 5).toString('hex')); acc = acc.subarray(5); } });
  const blk = Buffer.alloc(20480, 128); const t = setInterval(() => { if (!s.destroyed) s.write(blk); }, 10);
  s.on('close', () => clearInterval(t)); s.on('error', () => {});
});
await new Promise((r) => rtl.listen(0, '127.0.0.1', r)); const rtlPort = rtl.address().port;

const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
await pg.evaluate(async () => { clearAll(); const n = addNode('iqnet', 40, 40, { proto: 'rtl_tcp (DSP app)', sr: 1024000, freq: 104800000, gain: 20 }); const sp = addNode('iqSpec', 400, 40, { size: '1024' }); addEdge(n.id, 'iq', sp.id, 'in'); markWiresDirty(); window.__n = n; await Eng.start(); });

async function scenario(name, opt, want) {
  cmds.length = 0;
  const br = await mockBridgeWs(0, { app: true, ...opt });
  await pg.evaluate(([wp, rp]) => { __n.p.url = 'ws://127.0.0.1:' + wp; __n.p.host = '127.0.0.1'; __n.p.port = rp; iqnStart(__n); }, [br.port, rtlPort]);
  await wait(2500);
  const b0 = await pg.evaluate(() => __n.bytes); await wait(3000); const b1 = await pg.evaluate(() => __n.bytes);
  const st = await pg.evaluate(() => ({ status: __n.status, tuner: __n.tuner, binary: __n.app && __n.app.binary, ok: __n.ok }));
  const bps = (b1 - b0) / 3;
  ok(name + ': header and tuner read', st.ok && st.tuner === 'R820T', JSON.stringify(st));
  ok(name + ': stream arrives (' + Math.round(bps / 1000) + ' kB/s)', bps > want, String(bps));
  ok(name + ': binary path ' + (opt.nobin || opt.legacy ? 'off' : 'on'), (!!st.binary) === !(opt.nobin || opt.legacy), JSON.stringify(st));
  const c = cmds.join(' ');
  ok(name + ': rate 1024000 and frequency 104.8 MHz reach the server', cmds.includes('02000fa000') && cmds.includes('01063f1f00'), c.slice(0, 160));
  await pg.evaluate(() => iqnStop(__n)); await wait(400); br.close();
}
await scenario('new app (binary)', {}, 1.7e6);
await scenario('app without binary (hex records)', { nobin: true }, 8e5);

// ошибки: сервера нет → понятный статус; приложение без «Let any page use actions»
{
  const br = await mockBridgeWs(0, { app: true });
  await pg.evaluate(([wp]) => { __n.p.url = 'ws://127.0.0.1:' + wp; __n.p.port = 1; iqnStart(__n); }, [br.port]);
  await wait(1800);
  const st = await pg.evaluate(() => __n.status);
  ok('no rtl_tcp there: status tells what to check', /tcp\.connect 127\.0\.0\.1:1/.test(st) && /rtl_tcp -a 0\.0\.0\.0/.test(st), st);
  await pg.evaluate(() => iqnStop(__n)); br.close();
  const bf = await mockBridgeWs(0, { app: true, forbid: true });
  await pg.evaluate(([wp, rp]) => { __n.p.url = 'ws://127.0.0.1:' + wp; __n.p.port = rp; iqnStart(__n); }, [bf.port, rtlPort]);
  await wait(1800);
  const st2 = await pg.evaluate(() => __n.status);
  ok('forbidden: tells to turn on «Let any page use actions»', /Let any page use actions/.test(st2), st2);
  await pg.evaluate(() => iqnStop(__n)); bf.close();
}
console.log('page errors:', errs.slice(0, 3));
await b.close(); rtl.close();
process.exit(bad ? 1 : 0);
