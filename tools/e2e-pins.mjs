// Сквозная проверка Pins Out / Pins In в браузере: граф ↔ tools/termux/bridge.mjs ↔ внешний клиент.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-pins.mjs
import { createRequire } from 'node:module';
import { loadKernels } from './netmock.mjs';
import { createBridge } from './termux/bridge.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const K = loadKernels(['pins-kernels.js'], 'pinEncode,pinDecode,PIN_JSON,PIN_SIG,PIN_IQ');
const bridge = createBridge({ port: 0, sources: [], log: () => {} }), port = (await bridge.listen()).port;
const cli = await new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:' + port + '/'); w.binaryType = 'arraybuffer'; w.msgs = []; w.onmessage = (e) => { if (typeof e.data !== 'string') w.msgs.push(K.pinDecode(new Uint8Array(e.data))); }; w.onopen = () => res(w); });
const b = await chromium.launch(); const pg = await b.newPage(); const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
await pg.evaluate(async (port) => {
  clearAll();
  const url = 'ws://127.0.0.1:' + port;
  const gen = addNode('iqGen', 40, 40, { sr: '256000', fc: 100000000, mode: 'carrier' });
  const sp = addNode('iqSpec', 300, 40, { size: '1024' });
  const out = addNode('pinsout', 560, 40, { on: true, url, count: '2', names: 'chan1, spectrum' });
  const inn = addNode('pinsin', 40, 300, { on: true, url, count: '2', names: 'iqback, tune' });
  const sp2 = addNode('iqSpec', 300, 300, { size: '1024' });
  const num = addNode('lamps', 560, 300, { count: '1' });
  addEdge(gen.id, 'iq', out.id, 'in1'); addEdge(gen.id, 'iq', sp.id, 'in'); addEdge(sp.id, 'spec', out.id, 'in2');
  const sa = addNode('sa', 800, 300, {}); addEdge(sp2.id, 'spec', sa.id, 'spec');
  addEdge(inn.id, 'out1', sp2.id, 'in'); addEdge(inn.id, 'out2', num.id, 'in1');
  markWiresDirty();
  window.__o = out; window.__i = inn; window.__s2 = sp2; window.__l = num;
  await Eng.start();
}, port);
await wait(1500);
const st = await pg.evaluate(() => ({ o: __o.status, i: __i.status }));
ok('both nodes connected', /connected/.test(st.o) && /connected/.test(st.i), JSON.stringify(st));
// каталог пинов
const list = await new Promise((r) => { const w = new WebSocket('ws://127.0.0.1:' + port + '/'); w.onopen = () => w.send(JSON.stringify({ t: 'pins' })); w.onmessage = (e) => { const j = JSON.parse(e.data); if (j.t === 'pins' && j.out.length) r(j); }; });
ok('pin list has names', list.out.map((p) => p.name).join() === 'chan1,spectrum' && list.in.map((p) => p.name).join() === 'iqback,tune', JSON.stringify(list));
// пока никто не подписан, ничего не шлётся
await wait(500);
ok('no traffic without subscribers', cli.msgs.length === 0 && await pg.evaluate(() => __o.lk.tx) === 0);
cli.send(JSON.stringify({ t: 'sub', names: ['chan1', 'spectrum'] }));
await wait(1500);
const fr = cli.msgs;
const iq = fr.filter((f) => f.name === 'chan1'), spf = fr.filter((f) => f.name === 'spectrum');
ok('iq frames arrive (256 kS/s, centre 100 MHz)', iq.length > 3 && iq[0].kind === K.PIN_IQ && iq[0].sr === 256000 && iq[0].fc === 100e6, JSON.stringify(iq[0] && { k: iq[0].kind, sr: iq[0].sr, fc: iq[0].fc }));
const nIq = iq.reduce((a, f) => a + f.data.length / 2, 0);
ok('iq rate ≈ 256 kS/s (±30 %)', nIq > 256000 * 1.5 * 0.7 && nIq < 256000 * 1.5 * 1.3, String(nIq));
ok('iq seq is consecutive', iq.every((f, i) => i === 0 || f.seq === ((iq[i - 1].seq + 1) >>> 0)));
ok('spectrum frames carry 1024 bins', spf.length > 2 && spf[0].data.length === 1024 && spf[0].kind === 3, String(spf[0] && spf[0].data.length));
// вход: iq обратно и число
const N = 256, d = new Float32Array(N * 2); for (let i = 0; i < N; i++) { d[2 * i] = Math.cos(i * 0.5); d[2 * i + 1] = Math.sin(i * 0.5); }
let seq = 0; const feed = setInterval(() => cli.send(K.pinEncode({ kind: K.PIN_IQ, name: 'iqback', fc: 7e6, sr: 128000, seq: seq++, data: d })), 20);
cli.send(JSON.stringify({ t: 'set', name: 'tune', v: 1 }));
await wait(1500); clearInterval(feed);
const back = await pg.evaluate(() => ({ spec: !!(__s2.out.spec && __s2.out.spec.mag), fc: __s2.out.spec && __s2.out.spec.freqs && __s2.out.spec.freqs[512], lamp: __l.on && __l.on[0], st: __i.status }));
ok('Pins In feeds IQ into a downstream IQ Spectrum', back.spec && Math.abs(back.fc - 7e6) < 1, JSON.stringify(back));
ok('Pins In num drives a lamp', back.lamp === true, JSON.stringify(back));
// целые форматы: Pins Out шлёт IQ как int16 / int8 (в 2 / 4 раза меньше байт), а Pins In принимает целые кадры
for (const [fmt, kind, bytes] of [['int16', 6, 4], ['int8', 7, 2]]) {
  await pg.evaluate((f) => { __o.p.fmt = f; }, fmt); await wait(300); cli.msgs.length = 0; await wait(1200);
  const fr = cli.msgs.filter((f) => f.name === 'chan1'), smp = fr.reduce((a, f) => a + f.data.length / 2, 0);
  ok('Pins Out fmt ' + fmt + ': frames are kind ' + kind + ', ' + bytes + ' bytes per sample', fr.length > 3 && fr.every((f) => f.kind === kind && f.sr === 256000 && f.fc === 100e6) && smp > 256000 * 1.2 * 0.7, JSON.stringify(fr[0] && { k: fr[0].kind, n: fr.length, smp }));
}
await pg.evaluate(() => { __o.p.fmt = 'float32'; });
{
  const d16 = new Int16Array(2 * 256); for (let i = 0; i < 256; i++) { d16[2 * i] = Math.round(Math.cos(i * 0.5) * 20000); d16[2 * i + 1] = Math.round(Math.sin(i * 0.5) * 20000); }
  let sq = 0; const feed16 = setInterval(() => cli.send(K.pinEncode({ kind: 6, name: 'iqback', fc: 9e6, sr: 128000, seq: sq++, data: d16 })), 20);
  await wait(1500); clearInterval(feed16);
  const b16 = await pg.evaluate(() => ({ fc: __s2.out.spec && __s2.out.spec.freqs && __s2.out.spec.freqs[512], peak: __s2.out.spec ? Math.max(...__s2.out.spec.mag) : 0 }));
  ok('Pins In takes int16 IQ frames (spectrum centred at 9 MHz with a tone)', Math.abs(b16.fc - 9e6) < 1 && b16.peak > 0.1, JSON.stringify(b16));
}
// отписка — поток прекращается
cli.send(JSON.stringify({ t: 'sub', names: [] })); await wait(300);
const n0 = cli.msgs.length; await wait(600);
ok('unsubscribe stops the stream', cli.msgs.length === n0);
// выключили узел — связь закрыта, мост видит, что графа нет
await pg.evaluate(() => { __o.p.on = false; __i.p.on = false; }); await wait(500);
ok('nodes off → link released', await pg.evaluate(() => !__o.lk && !__i.lk));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close(); bridge.close(); cli.close();
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
