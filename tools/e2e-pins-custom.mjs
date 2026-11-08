// Pins (custom) и WebRTC в браузере: пины создаёт другая сторона; две страницы через мост и через WebRTC.
// Нужны Playwright и статика на :8123 (python3 -m http.server 8123): node tools/e2e-pins-custom.mjs  (BRIDGE=node — через tools/node/bridge.mjs)
import { createRequire } from 'node:module';
import { loadKernels } from './netmock.mjs';
import { createBridge } from './termux/bridge.mjs';
import { createMsgrBridge } from './node/bridge.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const K = loadKernels(['pins-kernels.js'], 'pinEncode,pinDecode,PIN_JSON,PIN_IQ');
const bridge = process.env.BRIDGE === 'node' ? createMsgrBridge({ port: 0, log: () => {} }) : createBridge({ port: 0, sources: [], log: () => {} }),   // BRIDGE=node — tools/node/bridge.mjs
  port = (await bridge.listen()).port, url = 'ws://127.0.0.1:' + port;
const b = await chromium.launch(); const ctx = await b.newContext(); const errs = [];
async function mk() {
  const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://localhost:8123/index.html');
  await pg.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 90000 }).catch(() => {}); await pg.waitForTimeout(1500);
  await pg.waitForFunction(() => typeof addNode === 'function', null, { timeout: 90000 });
  return pg;
}
const A = await mk(), B = await mk();

// ---------- 1. Pins (custom) и клиент моста ----------
await A.evaluate(async (url) => {
  clearAll();
  const x = addNode('pinsx', 40, 40, { on: true, url, pins: '', grow: true });
  window.__x = x; await Eng.start();
}, url);
await wait(1000);
ok('page shows the bridge version', /node bridge v2/.test(await A.evaluate(() => __x.el.querySelector('.readout').textContent)), await A.evaluate(() => __x.el.querySelector('.readout').textContent));
await A.evaluate(() => { __x.lk.bridge = null; __x.lk.openT -= 5000; });                    // как будто мост старый и версию не назвал
await wait(1200);
ok('an old bridge (no version) is called out on the node', /does not report its version/.test(await A.evaluate(() => __x.el.querySelector('.readout').textContent)));
const cli = await new Promise((res) => { const w = new WebSocket(url + '/'); w.binaryType = 'arraybuffer'; w.msgs = []; w.onmessage = (e) => w.msgs.push(e.data); w.onopen = () => res(w); });
cli.send(JSON.stringify({ t: 'sub', names: ['spec1'] }));                   // хочу получать «spec1» → у узла появится вход
await wait(500);
cli.send(JSON.stringify({ t: 'make', name: 'tune', dir: 'pub' }));          // отдаю «tune» → выход
await wait(300);
cli.send(K.pinEncode({ kind: K.PIN_JSON, name: 'speed', seq: 0, data: 5 }));  // первый кадр с новым именем → выход
await wait(500);
let pins = await A.evaluate(() => __x.p.pins);
ok('client created the pins', pins === '>spec1, <tune, <speed', pins);
const pp = await A.evaluate(() => portsOf(__x, 'ins').map((p) => p.n).filter((n) => !['on', 'grow'].includes(n)).join() + '|' + portsOf(__x, 'outs').map((p) => p.n).filter((n) => !['on', 'grow'].includes(n)).join());
ok('ports follow', pp === 'rtc,spec1|tune,speed', pp);
cli.send(K.pinEncode({ kind: K.PIN_JSON, name: 'speed', seq: 1, data: 7 }));
cli.send(JSON.stringify({ t: 'set', name: 'tune', v: 100.5e6 }));
await wait(500);
ok('values reach the new outputs', await A.evaluate(() => __x.out.speed === 7 && __x.out.tune === 100.5e6), await A.evaluate(() => JSON.stringify(__x.out)));
await A.evaluate(() => { __x.p.grow = false; }); cli.send(JSON.stringify({ t: 'make', name: 'nope', dir: 'pub' })); await wait(300);
ok('grow off → no new pins', await A.evaluate(() => __x.p.pins) === pins);
await A.evaluate(() => { __x.p.grow = true; });
cli.close(); await wait(300);                                                // клиент со старой подпиской не нужен дальше

// ---------- 2. Две страницы через мост: граф → граф ----------
await A.evaluate(async (url) => {
  clearAll();
  const gen = addNode('iqGen', 40, 40, { sr: '128000', fc: 50000000, mode: 'carrier' });
  const o = addNode('pinsout', 300, 40, { on: true, url, count: '1', names: 'chan' });
  addEdge(gen.id, 'iq', o.id, 'in1'); markWiresDirty(); window.__o = o; await Eng.start();
}, url);
await B.evaluate(async (url) => {
  clearAll();
  const i = addNode('pinsin', 40, 40, { on: true, url, count: '1', names: 'chan' });
  const sp = addNode('iqSpec', 300, 40, { size: '1024' }), sa = addNode('sa', 560, 40, {});
  addEdge(i.id, 'out1', sp.id, 'in'); addEdge(sp.id, 'spec', sa.id, 'spec'); markWiresDirty(); window.__i = i; window.__sp = sp; await Eng.start();
}, url);
await wait(2500);
const g2g = await B.evaluate(() => ({ spec: !!(__sp.out.spec && __sp.out.spec.mag), fc: __sp.out.spec && __sp.out.spec.freqs && __sp.out.spec.freqs[512], st: __i.status }));
ok('page B takes page A\'s IQ through the bridge', g2g.spec && Math.abs(g2g.fc - 50e6) < 1, JSON.stringify(g2g));
await A.evaluate(() => { __o.p.on = false; }); await B.evaluate(() => { __i.p.on = false; }); await wait(300);

// ---------- 2b. ввод в поле pins: порты обновляются без движка, фокус не теряется, чужая сторона не плодит промежуточные пины ----------
await A.evaluate(async (url) => {
  Eng.stop && Eng.stop();
  clearAll();
  window.__t = addNode('pinsx', 40, 40, { on: false, pins: '' });
}, url);
await wait(300);
await A.locator('.prm[data-param="pins"] input').first().click();
await A.keyboard.type('>aa, <bb');
const typed = await A.evaluate(() => ({ f: document.activeElement.closest('.prm')?.dataset.param, ins: portsOf(__t, 'ins').map((p) => p.n).filter((n) => !['on', 'grow'].includes(n)).join() }));
ok('focus stays in the pins field while typing', typed.f === 'pins', JSON.stringify(typed));
await A.keyboard.press('Enter'); await A.locator('.prm[data-param="pins"] input').first().blur();
await wait(300);
const upd = await A.evaluate(() => ({ ins: [...__t.el.querySelectorAll('.port[data-dir="i"] .pin')].map((e) => e.textContent).join(), outs: [...__t.el.querySelectorAll('.port[data-dir="o"] .pin')].map((e) => e.textContent).join() }));
ok('pins appear on the node right after the edit (engine stopped)', /aa/.test(upd.ins) && /bb/.test(upd.outs), JSON.stringify(upd));
ok('no text field has autofill on', await A.evaluate(() => [...document.querySelectorAll('input,textarea')].filter((i) => !['checkbox', 'radio', 'file', 'password', 'button', 'range', 'color', 'hidden', 'submit'].includes(i.type) && i.getAttribute('autocomplete') !== 'off').map((i) => i.id || i.className || i.type).join() === ''), await A.evaluate(() => [...document.querySelectorAll('input,textarea')].filter((i) => !['checkbox', 'radio', 'file', 'password', 'button', 'range', 'color', 'hidden', 'submit'].includes(i.type) && i.getAttribute('autocomplete') !== 'off').map((i) => i.id || i.className || i.type).join()));
// страница A правит список под мостом, страница B (тоже Pins custom) не должна получить пин на каждую букву
await B.evaluate(async (url) => { clearAll(); window.__bx = addNode('pinsx', 40, 40, { on: true, url, pins: '', grow: true }); await Eng.start(); }, url);
await A.evaluate(async (url) => { clearAll(); window.__t = addNode('pinsx', 40, 40, { on: true, url, pins: '', grow: true }); await Eng.start(); }, url);
await wait(800);
await A.locator('.prm[data-param="pins"] input').first().click();
await A.keyboard.type('>channel', { delay: 120 });
await wait(2200);
const bPins = await B.evaluate(() => __bx.p.pins), aPins = await A.evaluate(() => __t.p.pins);
ok('typing a name does not leave a trail of prefixes on the other side', bPins === '<channel' && aPins === '>channel', aPins + ' | ' + bPins);
await A.evaluate(() => { __t.p.on = false; }); await B.evaluate(() => { __bx.p.on = false; }); await wait(300);

// ---------- 3. WebRTC: тот же узел на обоих концах, мост не нужен ----------
await A.evaluate(async () => {
  clearAll();
  const gen = addNode('iqGen', 40, 40, { sr: '128000', fc: 70000000, mode: 'carrier' });
  const rt = addNode('rtcdata', 40, 300, {});
  const o = addNode('pinsout', 300, 40, { on: true, transport: 'WebRTC', count: '1', names: 'chan' });
  const x = addNode('pinsx', 300, 300, { on: true, transport: 'WebRTC', pins: '', grow: true });
  addEdge(gen.id, 'iq', o.id, 'in1'); addEdge(rt.id, 'link', o.id, 'rtc'); addEdge(rt.id, 'link', x.id, 'rtc'); markWiresDirty();
  window.__rt = rt; window.__o = o; window.__x = x; await Eng.start(); rtcOffer(rt);
});
await A.waitForFunction(() => __rt.code, null, { timeout: 15000 }).catch(() => {});
const offer = await A.evaluate(() => __rt.code);
ok('offer ready', offer.length > 100);
await B.evaluate(async (offer) => {
  clearAll();
  const rt = addNode('rtcdata', 40, 300, {});
  const x = addNode('pinsx', 300, 40, { on: true, transport: 'WebRTC', pins: '>tune', grow: true });
  addEdge(rt.id, 'link', x.id, 'rtc'); markWiresDirty();
  window.__rt = rt; window.__x = x; await Eng.start(); rt.p.remote = offer; rtcAnswer(rt);
}, offer);
await B.waitForFunction(() => __rt.code, null, { timeout: 15000 }).catch(() => {});
const answer = await B.evaluate(() => __rt.code);
ok('answer ready', answer.length > 100);
await A.evaluate((answer) => { __rt.p.remote = answer; rtcApply(__rt); }, answer);
await wait(4000);
const link = await Promise.all([A, B].map((p) => p.evaluate(() => ({ open: __rt.pnsOpen, st: __x.status }))));
ok('pins channel is open on both sides', link[0].open && link[1].open, JSON.stringify(link));
const bp = await B.evaluate(() => __x.p.pins);
const ap = await A.evaluate(() => __x.p.pins);
ok('B created the pin A announced (<chan), A created the one B announced (<tune: B sends it)', /<chan/.test(bp) && />tune/.test(bp) && /<tune/.test(ap), bp + ' | ' + ap);
await B.evaluate(() => { const sp = addNode('iqSpec', 560, 40, { size: '1024' }), sa = addNode('sa', 820, 40, {}); addEdge(__x.id, 'chan', sp.id, 'in'); addEdge(sp.id, 'spec', sa.id, 'spec'); markWiresDirty(); window.__sp = sp; });
await wait(2500);
const rtc = await B.evaluate(() => ({ spec: !!(__sp.out.spec && __sp.out.spec.mag), fc: __sp.out.spec && __sp.out.spec.freqs && __sp.out.spec.freqs[512], st: __x.status }));
ok('IQ flows over WebRTC and is shown by B', rtc.spec && Math.abs(rtc.fc - 70e6) < 1, JSON.stringify(rtc));
// B → A: число по проводу tune (из генератора констант B в узел A)
await B.evaluate(() => { const c = addNode('const', 40, 40, { v: 99 }); addEdge(c.id, 'out', __x.id, 'tune'); markWiresDirty(); });
await wait(1500);
ok('number B → A arrives on the new output', await A.evaluate(() => __x.out.tune) === 99, await A.evaluate(() => JSON.stringify(__x.out)));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close(); bridge.close(); cli.close();
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
