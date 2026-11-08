// Пины наружу: кадры (modules/pins-kernels.js) и ретрансляция в tools/termux/bridge.mjs: node tools/test-pins.mjs
import { loadKernels } from './netmock.mjs';
import { createBridge } from './termux/bridge.mjs';
import { createMsgrBridge } from './node/bridge.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['pins-kernels.js'], 'pinEncode,pinDecode,pinClassify,pinFrames,pinSpecOf,pinName,pinNames,PinRing,PIN_SIG,PIN_IQ,PIN_SPEC,PIN_SPECR,PIN_JSON,PIN_KIND_NAME,pinxParse,pinxWith,pinxName');

// имена
ok('names', K.pinNames('a, b ,,x y', 5, 'out').join('|') === 'a|b|out3|x_y|out5', K.pinNames('a, b ,,x y', 5, 'out').join('|'));

// кадр: sig, имя с юникодом (проверка добора до 4 байт), выравнивание данных
{
  const d = new Float32Array([0.5, -1, 2]);
  const u = K.pinEncode({ kind: K.PIN_SIG, name: 'звук', fc: 0, sr: 48000, seq: 7, data: d });
  const f = K.pinDecode(u);
  ok('sig roundtrip', f.name === 'звук' && f.sr === 48000 && f.seq === 7 && Array.from(f.data).join() === '0.5,-1,2', JSON.stringify(f));
  ok('payload aligned', (u.length - 3 * 4) % 4 === 0);
  // кадр лежит в буфере не с нуля (подмассив) — данные всё равно читаются
  const sh = new Uint8Array(u.length + 3); sh.set(u, 3);
  ok('unaligned view', Array.from(K.pinDecode(sh.subarray(3)).data).join() === '0.5,-1,2');
}

// json: число, строка, запись
for (const v of [433920000, 'hello', [{ f: 1, db: -50 }], { a: [1, 2] }]) {
  const c = K.pinClassify(v, 48000), f = K.pinDecode(K.pinEncode({ ...c, name: 'j', seq: 0 }));
  ok('json ' + JSON.stringify(v).slice(0, 20), f.kind === K.PIN_JSON && JSON.stringify(f.data) === JSON.stringify(v));
}
ok('skips null / NaN / empty', K.pinClassify(null) === null && K.pinClassify(NaN) === null && K.pinClassify([]) === null && K.pinClassify(new Float32Array(0)) === null);

// iq: потоки склеиваются в I,Q,I,Q…, большие режутся
{
  const s = { sr: 250000, fc: 100e6, chunks: [{ re: new Float32Array([1, 2]), im: new Float32Array([3, 4]) }, { re: new Float32Array([5]), im: new Float32Array([6]) }] };
  const c = K.pinClassify(s, 0), fr = K.pinFrames('c', c, 10);
  const f = K.pinDecode(fr[0]);
  ok('iq interleave', fr.length === 1 && f.kind === K.PIN_IQ && f.fc === 100e6 && f.sr === 250000 && Array.from(f.data).join() === '1,3,2,4,5,6', Array.from(f.data).join());
  const N = 300000, big = { sr: 1e6, fc: 0, chunks: [{ re: new Float32Array(N).fill(1), im: new Float32Array(N).fill(2) }] };
  const parts = K.pinFrames('big', K.pinClassify(big, 0), 5).map(K.pinDecode);
  const tot = parts.reduce((a, p) => a + p.data.length / 2, 0);
  ok('iq split', parts.length === 5 && tot === N && parts.every((p, i) => p.seq === 5 + i && p.data.length * 4 <= 512 * 1024), parts.map((p) => p.data.length).join());
}

// спектр: комплексный (оси freqs от центра fc) и вещественный
{
  const N = 8, fc = 433.92e6, bin = 1000, freqs = new Float64Array(N), mag = new Float32Array(N).map((_, i) => i);
  for (let i = 0; i < N; i++) freqs[i] = fc + (i - N / 2) * bin;
  const c = K.pinClassify({ mag, sr: N * bin, size: N, freqs, rev: 3 }, 0), f = K.pinDecode(K.pinEncode({ ...c, name: 's', seq: 0 }));
  const sp = K.pinSpecOf(f);
  ok('spec complex', f.kind === K.PIN_SPEC && c.rev === 3 && Math.abs(sp.freqs[0] - freqs[0]) < 1e-3 && Math.abs(sp.freqs[N - 1] - freqs[N - 1]) < 1e-3 && sp.sr === N * bin, JSON.stringify([f.fc, f.sr]));
  const r = K.pinDecode(K.pinEncode({ ...K.pinClassify({ mag, sr: 48000 }, 0), name: 'r', seq: 0 }));
  const rs = K.pinSpecOf(r);
  ok('spec real', r.kind === K.PIN_SPECR && rs.freqs === null && rs.sr === 48000 && rs.mag.length === N);
}

// битые кадры
ok('reject short / unknown kind / bad length', K.pinDecode(new Uint8Array(10)) === null && K.pinDecode(new Uint8Array(24).fill(9)) === null &&
  K.pinDecode(new Uint8Array([1, 0, 0, 0, ...new Array(20).fill(0), 1, 2, 3])) === null);

// очередь звука
{
  const r = new K.PinRing(8), o = new Float32Array(4);
  r.push(new Float32Array([1, 2, 3]));
  r.pull(o);
  ok('ring underrun pads zeros', Array.from(o).join() === '1,2,3,0' && r.under === 1);
  r.push(new Float32Array([1, 2, 3, 4, 5, 6])); r.push(new Float32Array([7, 8, 9, 10]));
  const o2 = new Float32Array(8); r.pull(o2);
  ok('ring overflow drops oldest', Array.from(o2).join() === '3,4,5,6,7,8,9,10' && r.over === 1, Array.from(o2).join());
}

// узел Pins (custom): список пинов строкой
{
  const x = K.pinxParse('>chan, <tune, >chan, <on, <, junk, >a b');
  ok('pinx parse', x.send.join() === 'chan,a_b' && x.recv.join() === 'tune', JSON.stringify(x));
  ok('pinx add send', K.pinxWith('', 'send', 'x') === '>x' && K.pinxWith('>x, <y', 'recv', 'z') === '>x, <y, <z');
  ok('pinx add refuses duplicate / reserved / empty', K.pinxWith('>x', 'send', 'x') === null && K.pinxWith('', 'recv', 'rtc') === null && K.pinxWith('', 'recv', '  ') === null);
  ok('pinx same name in both directions is fine', K.pinxWith('>x', 'recv', 'x') === '>x, <x');
  let t = ''; for (let i = 0; i < 70; i++) t = K.pinxWith(t, 'send', 'p' + i) ?? t;
  ok('pinx capped at 64', K.pinxParse(t).send.length === 64);
}

// https-страница и ws:// на другой хост: браузер блокирует, приложение Android (DspApp → Net.app) разрешает
{
  const fs = await import('node:fs'), vm = await import('node:vm');
  const src = fs.readFileSync(new URL('../modules/sources.js', import.meta.url), 'utf8'), pn = fs.readFileSync(new URL('../modules/pins.js', import.meta.url), 'utf8');
  const fn = (code, name) => code.slice(code.indexOf('function ' + name), code.indexOf('\n}', code.indexOf('function ' + name)) + 2);
  const run = (app, proto) => { const c = vm.createContext({ location: { protocol: proto }, Net: { app }, URL }); vm.runInContext(fn(src, 'netInsecure') + fn(pn, 'pinsBlocked'), c); return (u) => vm.runInContext('pinsBlocked(' + JSON.stringify(u) + ')', c); };
  ok('browser on https: ws:// to another host is blocked', run(false, 'https:')('ws://192.168.1.5:8765') !== '');
  ok('browser on https: localhost and wss:// are fine', run(false, 'https:')('ws://127.0.0.1:8766') === '' && run(false, 'https:')('wss://h.example:8766') === '');
  ok('Android app: ws:// to another host is allowed', run(true, 'https:')('ws://192.168.1.5:8765') === '');
}

// ---------- мост: один сценарий на оба моста (tools/termux/bridge.mjs и tools/node/bridge.mjs) ----------
async function scenario(label, port) {
  const open = (path) => new Promise((res, rej) => { const ws = new WebSocket('ws://127.0.0.1:' + port + path); ws.binaryType = 'arraybuffer'; ws.msgs = []; ws.onmessage = (e) => ws.msgs.push(e.data); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('ws error')); });
  const wait = async (f, ms = 1500) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10)); return f(); };
  const txt = (ws) => ws.msgs.filter((m) => typeof m === 'string').map((m) => JSON.parse(m));
  const bin = (ws) => ws.msgs.filter((m) => typeof m !== 'string').map((m) => K.pinDecode(new Uint8Array(m)));

  const page = await open('/');
  page.send(JSON.stringify({ t: 'hello', role: 'graph' }));
  page.send(JSON.stringify({ t: 'pins', out: [{ name: 'chan1', kind: 'iq', fc: 1e8, sr: 48000 }, { name: 'spec', kind: 'spec' }], in: [{ name: 'tune' }] }));
  const cli = await open('/');
  cli.send(JSON.stringify({ t: 'pins' }));
  ok(label + ': bridge reports its version to the page', await wait(() => txt(page).some((m) => m.t === 'bridge' && m.ver === 2 && m.impl === 'node')), JSON.stringify(txt(page)));
  ok(label + ': client sees the pin list', await wait(() => txt(cli).some((m) => m.t === 'pins' && m.out.length === 2 && m.in[0].name === 'tune')), JSON.stringify(txt(cli)));
  ok(label + ': page was told nothing wanted yet', await wait(() => txt(page).some((m) => m.t === 'want' && m.names.length === 0)));

  cli.send(JSON.stringify({ t: 'sub', names: ['chan1'] }));
  ok(label + ': page is told what is wanted', await wait(() => txt(page).some((m) => m.t === 'want' && m.names.join() === 'chan1')), JSON.stringify(txt(page)));

  const iqFrame = K.pinFrames('chan1', K.pinClassify({ sr: 48000, fc: 1e8, chunks: [{ re: new Float32Array([1, 2]), im: new Float32Array([3, 4]) }] }, 0), 0)[0];
  page.send(iqFrame);
  page.send(K.pinEncode({ kind: K.PIN_JSON, name: 'other', seq: 0, data: 1 }));       // не подписаны — не придёт
  ok(label + ': subscribed pin arrives with header', await wait(() => bin(cli).length >= 1) && bin(cli)[0].name === 'chan1' && Array.from(bin(cli)[0].data).join() === '1,3,2,4');
  await new Promise((r) => setTimeout(r, 100));
  ok(label + ': unsubscribed pin does not', bin(cli).length === 1, String(bin(cli).length));

  // raw: только данные
  const raw = await open('/raw/chan1');
  ok(label + ': raw join widens wanted', await wait(() => txt(page).some((m) => m.t === 'want' && m.names.join() === 'chan1')));
  page.send(iqFrame);
  ok(label + ': raw gets payload only', await wait(() => raw.msgs.length >= 1) && new Float32Array(raw.msgs[0]).join() === '1,3,2,4', String(raw.msgs[0] && raw.msgs[0].byteLength));

  // вход: set (текстом) и бинарный кадр доходят до графа
  cli.send(JSON.stringify({ t: 'set', name: 'tune', v: 100500000 }));
  ok(label + ': set → graph', await wait(() => bin(page).some((f) => f.name === 'tune' && f.data === 100500000)), JSON.stringify(bin(page)));
  cli.send(K.pinEncode({ kind: K.PIN_SIG, name: 'mic', seq: 0, sr: 48000, data: new Float32Array([0.25]) }));
  ok(label + ': binary → graph', await wait(() => bin(page).some((f) => f.name === 'mic' && f.data[0] === 0.25)));

  // '*' и уход клиента
  cli.send(JSON.stringify({ t: 'sub', names: ['*'] }));
  ok(label + ': * means everything', await wait(() => txt(page).some((m) => m.t === 'want' && m.names.join() === '*')));
  raw.close(); cli.close();
  ok(label + ': wanted shrinks when clients leave', await wait(() => txt(page).filter((m) => m.t === 'want').pop().names.length === 0));


  page.close();
}

const termux = createBridge({ port: 0, sources: [], log: () => {} });
await scenario('bridge.mjs (termux)', (await termux.listen()).port);
termux.close();
const desk = createMsgrBridge({ port: 0, log: () => {} });
await scenario('node/bridge.mjs', (await desk.listen()).port);
desk.close();

// токен и Origin
{
  const b2 = createBridge({ port: 0, token: 'x', sources: [] }), p2 = (await b2.listen()).port;
  const t = (q, o) => new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:' + p2 + '/' + q, o); w.onopen = () => { w.close(); res(true); }; w.onerror = () => res(false); });
  ok('token required', !(await t('')) && await t('?token=x'));
  b2.close();
}
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
