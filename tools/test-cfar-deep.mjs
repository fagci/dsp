// Глубокое усреднение CFAR (cfarDeep): node tools/test-cfar-deep.mjs
// Функция живёт в modules/analysis.js рядом с DOM-кодом; вырезаем её по скобкам и гоняем в vm.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'modules/analysis.js'), 'utf8');
const a = src.indexOf('function cfarDeep');
if (a < 0) throw new Error('cfarDeep not found');
let i = src.indexOf('{', a), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
if (end < 0) throw new Error('unterminated cfarDeep');
let t = 1000;
const ctx = vm.createContext({Float32Array, Float64Array, performance: {now: () => t}});
vm.runInContext(src.slice(a, end) + '\n;globalThis.CFAR_DEEP=cfarDeep;', ctx);
const cfarDeep = ctx.CFAR_DEEP;
let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };

const N = 8, freqs = new Float64Array(N);
for (let k = 0; k < N; k++) freqs[k] = 100e6 + k * 1000;
const mk = (v) => ({mag: Float32Array.from(v), freqs, sr: 1000, size: N});

// выключено — исходный спектр без изменений
{
  const n = {p: {deep: 0}}, s = mk([1,1,1,1,1,1,1,1]);
  ok(cfarDeep(n, s) === s && !n._deep, 'deep=0: пропускает кадр как есть');
}

// включено: сигнал в бине 3 = 2, шум = 1; после первого кадра среднее — сам кадр,
// после второго — сдвиг на 10% (dt=0.1 с при deep=1 с)
{
  const n = {p: {deep: 1}}, s = mk([1,1,1,2,1,1,1,1]);
  t = 1000; const f0 = cfarDeep(n, s);
  ok(f0.mag[3] > 1.9 && f0.mag[1] < 1.05, 'первый кадр: сигнал 2, шум 1');
  t = 1100; const f1 = cfarDeep(n, s);
  ok(f1.mag[3] > f1.mag[1] && f1.mag[1] > 0.99, 'второй кадр: сигнал всё ещё выше шума');
  ok(f1.rev === 2 && n._deep.acc[3] > n._deep.acc[1], 'rev и накопитель мощности растут');
  // тот же сигнал, но другой размер оси — накопление сбрасывается
  const s2 = {mag: Float32Array.from([1,1,1,2]), freqs: Float64Array.from([100e6, 101e6, 102e6, 103e6]), sr: 1000, size: 4};
  t = 1200; const f2 = cfarDeep(n, s2);
  ok(f2.mag.length === 4 && n._deep.acc[3] === 4, 'смена размера/оси: новый накопитель');
}

if (bad) { console.error(bad + ' ошибок'); process.exit(1); }
console.log('cfar deep ok');
