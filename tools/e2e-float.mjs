// Плавающее окно (оверлей) не должно занимать главный поток: кодирование кадра асинхронное, такты движка (а с ними радио и любой звук) не опаздывают.
// Заглушка DspApp, холст спектра в окне, процессор замедлен в 4 раза. Нужны Playwright и статика на :8123: node tools/e2e-float.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = 'overlay', rate = 4;
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
const pg = await (await b.newContext()).newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.goto('http://localhost:8123/index.html');
await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
await pg.waitForFunction(() => typeof addNode === 'function');
await pg.evaluate(async () => { clearAll();
  const gen = addNode('iqGen', 40, 40, { sr: '1024000', fc: 100000000, mode: 'WFM stereo', off: 0, tone: 1000, lvl: -10, noise: -60 });
  const dcb = addNode('iqDecim', 300, 40, { M: '5', cut: .45 }); const sp = addNode('iqSpec', 300, 200, { size: '4096', upd: 16 });
  const de = addNode('iqDemod', 560, 40, { mode: 'WFM', deemph: '50 µs', stereo: true }); const au = addNode('iqAudio', 820, 40, {}); const dc = addNode('dac', 1080, 40, { vol: .01 });
  const sa = addNode('sa', 300, 360, { auto: true }); window.__sa = sa;
  addEdge(gen.id, 'iq', dcb.id, 'in'); addEdge(dcb.id, 'out', sp.id, 'in'); addEdge(sp.id, 'spec', sa.id, 'spec'); addEdge(dcb.id, 'out', de.id, 'in');
  addEdge(de.id, 'stereo', au.id, 'in'); addEdge(au.id, 'out', dc.id, 'L'); addEdge(au.id, 'q', dc.id, 'R'); markWiresDirty();
  window.__ticks = []; const o = MOD.dac.process; MOD.dac.process = function (n, I) { window.__ticks.push(performance.now()); return o.call(this, n, I); };
  await Eng.start(); });
await wait(3000);
await pg.evaluate((mode) => {
  window.__frames = 0; window.__bytes = 0; window.__cost = [];
  if (mode === 'overlay') {
    window.DspApp = { floatCan: () => true, floatShow: () => true, floatClose() {}, floatPerm() {}, floatFrame: (id, b64) => { if (!window.__first) window.__first = b64.startsWith('UklGR') ? 'webp' : b64.startsWith('iVBOR') ? 'png' : 'other:' + b64.slice(0, 8); window.__frames++; window.__bytes += b64.length; }, appKey: () => '' };
    const orig = floatSend; floatSend = function (s) { const t = performance.now(); try { return orig(s); } finally { window.__cost.push(performance.now() - t); } };
    floatToggle(__sa);
  }
  window.__lag = []; let last = performance.now(); setInterval(() => { const n = performance.now(); window.__lag.push(n - last - 20); last = n; }, 20);
}, mode);
const cdp = await pg.context().newCDPSession(pg); await cdp.send('Emulation.setCPUThrottlingRate', { rate });
await pg.evaluate(() => { window.__ticks.length = 0; });
await wait(12000);
const r = await pg.evaluate(() => {
  const t = window.__ticks, gaps = []; for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  gaps.sort((a, b) => a - b); const q = (p) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] || 0);
  const lag = window.__lag.slice().sort((a, b) => a - b); const c = window.__cost.slice().sort((a, b) => a - b);
  return { ticksPerSec: +(t.length / 12).toFixed(1), tickGapMs: { p50: q(.5), p95: q(.95), p99: q(.99), max: Math.round(gaps[gaps.length - 1] || 0) }, tickGaps_over_40ms: gaps.filter((g) => g > 40).length,
    heartbeatLagMs: { p50: Math.round(lag[Math.floor(lag.length * .5)] || 0), p95: Math.round(lag[Math.floor(lag.length * .95)] || 0), max: Math.round(lag[lag.length - 1] || 0) },
    overlayFrames: window.__frames, firstKind: window.__first, kbPerFrame: window.__frames ? Math.round(window.__bytes / window.__frames / 1024) : 0, frameCostMs: c.length ? { avg: Math.round(c.reduce((a, x) => a + x, 0) / c.length), p95: Math.round(c[Math.floor(c.length * .95)]), max: Math.round(c[c.length - 1]) } : null };
});
console.log(mode.padEnd(8), 'cpu×' + rate, JSON.stringify(r));
globalThis.__r = r;

ok('a cheap frame lets the window run fast (≥ 15 per second; it was capped at 8)', r.overlayFrames >= 180, String(r.overlayFrames));
ok('frames are WebP / PNG images', r.firstKind === 'webp' || r.firstKind === 'png', String(r.firstKind));
ok('a frame costs the main thread under 10 ms at CPU ×4 (28 ms on average with the synchronous toDataURL)', r.frameCostMs && r.frameCostMs.avg < 10 && r.frameCostMs.p95 < 18, JSON.stringify(r.frameCostMs));
ok('engine ticks stay regular: few gaps over 40 ms (44 with the synchronous encoder, 3 without an overlay)', r.tickGaps_over_40ms < 20, String(r.tickGaps_over_40ms));
ok('engine keeps real time (86 ticks per second)', r.ticksPerSec > 80, String(r.ticksPerSec));
// дорогой кадр (слабый телефон) — окно само замедляется, а не отнимает такты у звука
await pg.evaluate(() => { const o = floatSend; window.__fsOrig = o; floatSend = function (s) { const t = performance.now(); while (performance.now() - t < 30) {} return o(s); }; window.__frames = 0; });
await wait(4000);
const slow = await pg.evaluate(() => window.__frames);
ok('a 30 ms frame slows the window down (≤ 8 per second) instead of eating the engine', slow <= 36, String(slow));
await pg.evaluate(() => { floatSend = window.__fsOrig; window.__frames = 0; }); await wait(4000);
ok('and it speeds up again when frames are cheap', await pg.evaluate(() => window.__frames) >= 60);
// кодировщик замолчал — окно не замирает навсегда
await pg.evaluate(() => { const o = HTMLCanvasElement.prototype.toBlob; let first = true; HTMLCanvasElement.prototype.toBlob = function (cb, t, q) { if (first) { first = false; return; } return o.call(this, cb, t, q); }; window.__frames = 0; });
await wait(5000);
ok('a lost encoder callback does not freeze the window', await pg.evaluate(() => window.__frames) > 5);
// узел удалили — кадры прекращаются
await pg.evaluate(() => { floatToggle(__sa); window.__frames = 0; }); await wait(1200);
ok('closing the window stops the frames', await pg.evaluate(() => window.__frames) === 0);
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close(); console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
