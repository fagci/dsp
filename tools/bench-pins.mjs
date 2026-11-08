// Замер пропускной способности пинов: мост (ретрансляция) и кодирование IQ на стороне страницы. node tools/bench-pins.mjs [--seconds 3]
// Мост — tools/node/bridge.mjs, клиенты — глобальный WebSocket Node (как у браузера: маскированные кадры, бинарные сообщения).
import { createMsgrBridge } from './node/bridge.mjs';
import { wsFrame, wsParser } from './termux/bridge.mjs';
import { loadKernels } from './netmock.mjs';
const K = loadKernels(['pins-kernels.js'], 'pinEncode,pinDecode,pinClassify,pinFrames,pinIqSplit,PIN_IQ');
const sec = +(process.argv[process.argv.indexOf('--seconds') + 1]) || 3;
const MB = (b) => (b / 1048576).toFixed(1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. мост: страница-источник шлёт кадры по 512 КБ, подписчик считает принятое
async function relay(frameBytes, label) {
  const br = createMsgrBridge({ port: 0, log: () => {} }), port = (await br.listen()).port, url = 'ws://127.0.0.1:' + port + '/';
  const open = () => new Promise((res) => { const w = new WebSocket(url); w.binaryType = 'arraybuffer'; w.onopen = () => res(w); });
  const src = await open(), dst = await open();
  let got = 0, frames = 0; dst.onmessage = (e) => { if (typeof e.data !== 'string') { got += e.data.byteLength; frames++; } };
  src.send(JSON.stringify({ t: 'hello', role: 'graph' })); dst.send(JSON.stringify({ t: 'sub', names: ['x'] }));
  await wait(200);
  const f = K.pinEncode({ kind: 2, name: 'x', fc: 1e8, sr: 1e6, seq: 0, data: new Float32Array(frameBytes / 4) });
  const t0 = performance.now(); let sent = 0;
  while (performance.now() - t0 < sec * 1000) {
    if (src.bufferedAmount > 8 << 20) { await wait(1); continue; }
    src.send(f); sent += f.length;
    if (sent % (4 * f.length) === 0) await wait(0);
  }
  await wait(300);
  const dt = (performance.now() - t0 - 300) / 1000;
  console.log(label.padEnd(34), 'sent', MB(sent).padStart(7), 'MB · relayed', MB(got).padStart(7), 'MB in', dt.toFixed(1) + ' s =', (got / 1048576 / dt).toFixed(0).padStart(4), 'MB/s,', (frames / dt).toFixed(0), 'frames/s');
  src.close(); dst.close(); br.close();
}

// 2. разбор кадров мостом (wsParser) отдельно от сокетов
function parser(frameBytes) {
  const payload = Buffer.alloc(frameBytes, 7), mask = Buffer.from([1, 2, 3, 4]), masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const h = frameBytes < 65536 ? Buffer.from([0x82, 0x80 | 126, frameBytes >> 8, frameBytes & 255]) : Buffer.concat([Buffer.from([0x82, 0x80 | 127, 0, 0, 0, 0]), Buffer.from([frameBytes >>> 24, frameBytes >>> 16, frameBytes >>> 8, frameBytes].map((x) => x & 255))]);
  const frame = Buffer.concat([h, mask, masked]);
  let n = 0; const feed = wsParser({ onMsg() {}, onBin: (b) => { n += b.length; }, onClose() {}, onPing() {} });
  const chunk = 65536, t0 = performance.now(); let total = 0;
  while (performance.now() - t0 < 1500) { for (let o = 0; o < frame.length; o += chunk) feed(frame.subarray(o, Math.min(frame.length, o + chunk))); total += frameBytes; }
  const dt = (performance.now() - t0) / 1000;
  console.log(('wsParser (64 KB chunks), frame ' + frameBytes / 1024 + ' KB').padEnd(34), (total / 1048576 / dt).toFixed(0).padStart(5), 'MB/s');
}
function framer(frameBytes) {
  const b = Buffer.alloc(frameBytes), t0 = performance.now(); let total = 0;
  while (performance.now() - t0 < 1000) { wsFrame(b, 2); total += frameBytes; }
  console.log(('wsFrame, frame ' + frameBytes / 1024 + ' KB').padEnd(34), (total / 1048576 / ((performance.now() - t0) / 1000)).toFixed(0).padStart(5), 'MB/s');
}

// 3. кодирование IQ потока в кадры и обратно (страница): MS/s комплексных отсчётов и байт на отсчёт
function iqCodec() {
  const N = 1 << 16, chunks = [{ re: new Float32Array(N).fill(0.5), im: new Float32Array(N).fill(0.25) }], s = { sr: 1e6, fc: 1e8, chunks };
  for (const fmt of ['float32', 'int16', 'int8']) {
    let t0 = performance.now(), n = 0;
    while (performance.now() - t0 < 700) { K.pinFrames('x', K.pinClassify(s, 0, fmt), 0); n += N; }
    const enc = n / 1e6 / ((performance.now() - t0) / 1000);
    const fr = K.pinFrames('x', K.pinClassify(s, 0, fmt), 0)[0];
    t0 = performance.now(); n = 0;
    while (performance.now() - t0 < 700) { K.pinIqSplit(K.pinDecode(fr)); n += N; }
    const dec = n / 1e6 / ((performance.now() - t0) / 1000);
    console.log(('iq ' + fmt).padEnd(14), 'encode', enc.toFixed(0).padStart(4), 'MS/s · decode', dec.toFixed(0).padStart(4), 'MS/s ·', ((fr.length - 28) / N).toFixed(0), 'bytes per sample · at 2.4 MS/s', ((fr.length - 28) / N * 2.4).toFixed(1), 'MB/s on the wire');
  }
}

console.log('--- bridge (node/bridge.mjs, localhost) ---');
await relay(512 * 1024, 'relay, 512 KB frames');
await relay(64 * 1024, 'relay, 64 KB frames');
await relay(8 * 1024, 'relay, 8 KB frames');
console.log('--- bridge internals ---');
for (const kb of [8, 64, 512]) parser(kb * 1024);
for (const kb of [8, 512]) framer(kb * 1024);
console.log('--- page side ---');
iqCodec();
process.exit(0);
