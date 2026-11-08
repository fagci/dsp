// Звук через пины без разрывов: USB-SDR 1024 kS/s → IQ Decimator 5 → Pins Out → мост → Pins In → WFM → звук. Узел Pins In раньше отдавал IQ в граф
// «как пришло»: кадры по сети идут неровно, такт движка без кадра — тишина (при нулевых счётчиках потерь). Теперь буфер выдаёт ровно столько
// отсчётов на такт, сколько дал бы источник в графе. Сравниваем с тем же графом без пинов (0 разрывов): метрика — разрывы 1 кГц синуса.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-pins-audio.mjs
import { createRequire } from 'node:module';
import { createMsgrBridge } from './node/bridge.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const { chromium } = createRequire(import.meta.url)('playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bridge = createMsgrBridge({ port: 0, log: () => {} }), port = (await bridge.listen()).port, url = 'ws://127.0.0.1:' + port;
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const ctx = await b.newContext(); const errs = [];
async function mk() { const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push(e.message)); await pg.goto('http://localhost:8123/index.html');
  await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
  await pg.waitForFunction(() => typeof addNode === 'function'); return pg; }
const hook = () => { window.__cap = []; window.__blocks = 0; const o = MOD.dac.process; MOD.dac.process = function (n, I) { window.__blocks++; if (I.L) window.__cap.push(Float32Array.from(I.L)); return o.call(this, n, I); }; };
const analyse = (pg) => pg.evaluate(() => {
  const cs = window.__cap; const n = cs.reduce((a, c) => a + c.length, 0), x = new Float32Array(n); let o = 0; for (const c of cs) { x.set(c, o); o += c.length; }
  const fs = Eng.sr, w = 2 * Math.PI * 1000 / fs, k = 2 * Math.cos(w); let amp = 0; for (let i = fs; i < n; i++) amp = Math.max(amp, Math.abs(x[i]));
  let bad = 0, runs = 0, last = -1e9, zero = 0;
  for (let i = fs + 2; i < n; i++) { const r = x[i] - k * (x[i - 1]) + x[i - 2]; if (Math.abs(r) > 0.15 * amp) { bad++; if (i - last > 50) runs++; last = i; } if (x[i] === 0 && x[i - 1] === 0 && x[i - 2] === 0) zero++; }
  return { fs, samples: n, seconds: +(n / fs).toFixed(1), amp: +amp.toFixed(3), discontinuous: bad, events: runs, zeroRun: zero, blocks: window.__blocks };
});
async function scenario(name, withPins, fmt) {
  const A = await mk(); let B = A;
  if (withPins) B = await mk();
  await A.evaluate(async ({ url, withPins, fmt }) => {
    clearAll();
    const gen = addNode('iqGen', 40, 40, { sr: '1024000', fc: 100000000, mode: 'WFM stereo', off: 0, tone: 1000, lvl: -10, noise: -120 });
    const dcb = addNode('iqDecim', 300, 40, { M: '5', cut: .45 });
    addEdge(gen.id, 'iq', dcb.id, 'in');
    if (withPins) { const po = addNode('pinsout', 560, 40, { on: true, url, count: '1', names: 'wfm', fmt }); addEdge(dcb.id, 'out', po.id, 'in1'); window.__po = po; }
    else { const de = addNode('iqDemod', 560, 40, { mode: 'WFM', deemph: '50 µs', stereo: true }); const au = addNode('iqAudio', 800, 40, {}); const dc = addNode('dac', 1040, 40, { vol: .01 });
      addEdge(dcb.id, 'out', de.id, 'in'); addEdge(de.id, 'stereo', au.id, 'in'); addEdge(au.id, 'out', dc.id, 'L'); addEdge(au.id, 'q', dc.id, 'R'); }
    markWiresDirty();
  }, { url, withPins, fmt });
  if (withPins) await B.evaluate(async ({ url }) => {
    clearAll();
    const pi = addNode('pinsin', 40, 40, { on: true, url, count: '1', names: 'wfm' });
    const de = addNode('iqDemod', 300, 40, { mode: 'WFM', deemph: '50 µs', stereo: true }); const au = addNode('iqAudio', 560, 40, {}); const dc = addNode('dac', 820, 40, { vol: .01 });
    addEdge(pi.id, 'out1', de.id, 'in'); addEdge(de.id, 'stereo', au.id, 'in'); addEdge(au.id, 'out', dc.id, 'L'); addEdge(au.id, 'q', dc.id, 'R'); markWiresDirty(); window.__pi = pi;
  }, { url });
  await B.evaluate(hook);
  await A.evaluate(() => Eng.start()); if (B !== A) await B.evaluate(() => Eng.start());
  await wait(4000);
  await B.evaluate(() => { window.__cap = []; window.__blocks = 0; });
  await wait(10000);
  const r = await analyse(B);
  let extra = '';
  if (withPins) extra = JSON.stringify(await B.evaluate(() => ({ lost: __pi.dropped, rx: __pi.lk.rx, qlen: __pi.rSt[0].q.length, status: __pi.status }))) + ' sender ' + JSON.stringify(await A.evaluate(() => ({ drops: __po.lk.drops, tx: __po.lk.tx })));
  console.log(name.padEnd(22), JSON.stringify(r), extra);
  return r;
  await A.close(); if (B !== A) await B.close();
}
const base = await scenario('baseline (no pins)', false);
ok('baseline graph: a clean tone', base.discontinuous === 0 && base.zeroRun === 0 && base.seconds >= 9.5);
for (const fmt of ['float32', 'int16']) {
  const r = await scenario('pins ' + fmt, true, fmt);
  ok('pins ' + fmt + ': audio as clean as without pins (no silent ticks, no clicks)', r.events === 0 && r.zeroRun < 500 && r.seconds >= 9.5 && Math.abs(r.amp - base.amp) < 0.05, JSON.stringify(r));
}
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close(); bridge.close();
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
