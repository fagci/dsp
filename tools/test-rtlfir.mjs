// КИХ демод-воркера RTL-SDR и запись кольца: node tools/test-rtlfir.mjs
// Проверяем то, что нельзя услышать в браузере: симметрию коэффициентов (по ней свёртка
// складывает пары отсчётов и делает вдвое меньше умножений) и корректность записи с переносом
// через границу кольца. Функции живут в sources.js (makeLP — внутри RTL_WORKER_SRC), поэтому
// вырезаем их по скобкам и исполняем в vm.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'modules/sources.js'), 'utf8');
let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if(!c) bad++; };

function cut(marker){
  const a = src.indexOf(marker);
  if(a < 0) throw new Error('not found: ' + marker);
  let i = src.indexOf('{', a), depth = 0;
  for(; i < src.length; i++){
    const c = src[i];
    if(c === '{') depth++;
    else if(c === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unterminated: ' + marker);
}

const code = cut('function besselI0') + '\n' + cut('function makeLP') + '\n' + cut('function rtlRingWrite') +
  '\n;globalThis.MAKE=makeLP; globalThis.RING=rtlRingWrite;';
const ctx = vm.createContext({Math, Float32Array, Float64Array, Uint8Array, Int16Array, console});
vm.runInContext(code, ctx);
const makeLP = ctx.MAKE, ringWrite = ctx.RING;

// ---- КИХ ----
for(const [fs, pass, stop, maxN] of [[3200000, 95000, 151153, 2047], [246153, 15000, 19000, 1023], [48000, 12000, 15000, 1023]]){
  const h = makeLP(fs, pass, stop, maxN);
  let sym = h.length & 1;
  for(let k = 0; k < h.length >> 1; k++) if(h[k] !== h[h.length - 1 - k]) sym = false;
  ok(sym, `КИХ ${fs} Гц: нечётная длина и h[k] === h[N−1−k] (N=${h.length})`);
}

// Свёртка «в лоб» и парная (как в демод-воркере) на случайном сигнале должны совпадать.
{
  const h = makeLP(3200000, 95000, 151153, 2047), N = h.length, n = N + 40;
  let seed = 123456789;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5;
  const xi = new Float32Array(n), xq = new Float32Array(n);
  for(let i = 0; i < n; i++){ xi[i] = rnd(); xq[i] = rnd(); }
  for(const pos of [0, 7, 33, n - N]){
    let di = 0, dq = 0;
    for(let t = 0; t < N; t++){ const c = h[t], a = pos + t; di += c * xi[a]; dq += c * xq[a]; }
    let si = 0, sq = 0, half = N >> 1;
    for(let t = 0; t < half; t++){ const c = h[t], a = pos + t, b = pos + N - 1 - t; si += c * (xi[a] + xi[b]); sq += c * (xq[a] + xq[b]); }
    si += h[half] * xi[pos + half]; sq += h[half] * xq[pos + half];
    ok(Math.abs(di - si) < 1e-5 && Math.abs(dq - sq) < 1e-5, `парная свёртка = прямая, pos=${pos}`);
  }
}

// ---- запись кольца ----
const mkRing = (size) => ({I:new Float32Array(size), Q:new Float32Array(size), size, w:0, filled:0, written:0});
{
  const r = mkRing(5), u8 = new Uint8Array([255, 0, 127, 127, 128, 128, 0, 255, 255, 0]);
  ringWrite(r, u8, null, 5);
  ok(r.w === 0 && r.filled === 5 && r.written === 5, 'u8: 5 отсчётов ровно заполнили кольцо, указатель обнулился');
  ok(Math.abs(r.I[0] - 1) < 1e-6 && Math.abs(r.Q[0] + 1) < 1e-6 && Math.abs(r.I[1] + 0.5/127.5) < 1e-6, 'u8: масштаб 127.5 и знак Q');
  ringWrite(r, u8, null, 5);
  ok(r.w === 0 && r.filled === 5 && r.written === 10, 'u8: перезапись через границу не сбивает filled/written');
  const r2 = mkRing(5);
  ringWrite(r2, u8, null, 3);
  ok(r2.w === 3 && r2.filled === 3 && r2.written === 3, 'u8: частичная запись');
  ringWrite(r2, u8, null, 4);
  ok(r2.w === 2 && r2.filled === 5 && r2.written === 7, 'u8: перенос через конец кольца');
  ok(Math.abs(r2.I[2] - 0.5/127.5) < 1e-6 && Math.abs(r2.I[0] - 0.5/127.5) < 1e-6 && Math.abs(r2.I[1] + 1) < 1e-6, 'u8: хвост и начало после переноса');
}
{
  const r = mkRing(4), s16 = new Int16Array([32767, -32768, 16384, -16384]);
  ringWrite(r, null, s16, 2);
  ok(Math.abs(r.I[0] - 32767/32768) < 1e-6 && Math.abs(r.Q[0] + 1) < 1e-6 && Math.abs(r.I[1] - 0.5) < 1e-6, 's16: масштаб 32768');
}

if(bad){ console.error(bad + ' ошибок'); process.exit(1); }
console.log('rtlfir ok');
