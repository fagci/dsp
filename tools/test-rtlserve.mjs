// Сервер rtl_tcp: заголовок, разбор команд, перевод IQ (modules/rtlserve-kernels.js): node tools/test-rtlserve.mjs
import { loadKernels } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['rtlserve-kernels.js'], 'rtlsHeader,rtlsTunerId,rtlsCmd,RtlsParser,rtlsNewState,rtlsApply,rtlsToU8,rtlsPick,rtlsHex,RTLS_CMDS,RtlsResampler');

const h = K.rtlsHeader(K.rtlsTunerId('R820T'), 29);
ok('header', K.rtlsHex(h) === '52 54 4C 30 00 00 00 05 00 00 00 1D', K.rtlsHex(h));

const p = new K.RtlsParser();
let r = p.feed(K.rtlsCmd(1, 100000000));
ok('freq hex', r.length === 1 && r[0].hex === '01 05 F5 E1 00' && r[0].k === 'freq' && r[0].val === 100000000, JSON.stringify(r));
// разрезанные пополам и склеенные команды
const two = new Uint8Array([...K.rtlsCmd(2, 2400000), ...K.rtlsCmd(4, 496)]);
r = p.feed(two.subarray(0, 3)); ok('partial waits', r.length === 0);
r = p.feed(two.subarray(3, 8)); ok('first done', r.length === 1 && r[0].k === 'sr' && r[0].val === 2400000);
r = p.feed(two.subarray(8)); ok('second done', r.length === 1 && r[0].k === 'gain' && r[0].val === 496);
r = p.feed(new Uint8Array([...K.rtlsCmd(5, -3 >>> 0), 0x77, 0, 0, 0, 1]));
ok('ppm signed + unknown', r[0].sval === -3 && r[1].k === 'unknown' && p.bad === 1);

const st = K.rtlsNewState();
for (const c of new K.RtlsParser().feed(new Uint8Array([...K.rtlsCmd(1, 433920000), ...K.rtlsCmd(4, 496), ...K.rtlsCmd(5, -3 >>> 0), ...K.rtlsCmd(0x0e, 1), ...K.rtlsCmd(0x41, 7)]))) K.rtlsApply(st, c);
ok('state', st.freq === 433920000 && Math.abs(st.gain - 49.6) < 1e-9 && st.ppm === -3 && st.bias === 1 && st.gainIdx === 7, JSON.stringify(st));

// IQ → u8
const raw = new Uint8Array([1, 2, 3, 4]);
const a = K.rtlsToU8({ raw, fmt: 'u8' });
ok('u8 copy', a.length === 4 && a[3] === 4 && a.buffer !== raw.buffer);
const f = K.rtlsToU8({ re: new Float32Array([0, 1, -1, 2]), im: new Float32Array([0, 0, 0.5, -3]) });
ok('float → u8', Array.from(f).join() === '128,128,255,128,0,191,255,0', Array.from(f).join());
ok('real stream', K.rtlsToU8({ re: new Float32Array([1]), im: null }).join() === '255,128');
ok('pick', K.rtlsPick(2500000, [250000, 1024000, 2048000, 2400000, 3200000]) === 2400000);

// пересэмплирование 1.024 MS/s → 250 kS/s (клиент SDR++ просит меньше, чем даёт USB SDR)
{
  const fin = 1024000, fout = 250000, N = fin;
  const tone = (f) => { const re = new Float32Array(N), im = new Float32Array(N); for (let i = 0; i < N; i++) { re[i] = Math.cos(2 * Math.PI * f * i / fin); im[i] = Math.sin(2 * Math.PI * f * i / fin); } return { re, im }; };
  const amp = (o) => { let s = 0, c = 0; for (let i = 3000; i < o.re.length; i++) { s += o.re[i] ** 2 + o.im[i] ** 2; c++; } return Math.sqrt(s / c); };
  const frq = (o) => { let a = 0, c = 0; for (let i = 3000; i < o.re.length - 1; i++) { a += Math.atan2(o.re[i] * o.im[i + 1] - o.im[i] * o.re[i + 1], o.re[i] * o.re[i + 1] + o.im[i] * o.im[i + 1]); c++; } return a / c * fout / (2 * Math.PI); };
  let t = tone(20000), o = new K.RtlsResampler(fin, fout).push(t.re, t.im);
  ok('resample: sample count', Math.abs(o.re.length - 250000) <= 2, String(o.re.length));
  ok('resample: tone keeps its frequency (20 kHz) and level', Math.abs(frq(o) - 20000) < 20 && amp(o) > 0.98, frq(o).toFixed(1) + ' Hz, amp ' + amp(o).toFixed(3));
  t = tone(75000); o = new K.RtlsResampler(fin, fout).push(t.re, t.im);
  ok('resample: FM broadcast edge (75 kHz) within 1.5 dB', amp(o) > 0.84, amp(o).toFixed(3));
  t = tone(300000); o = new K.RtlsResampler(fin, fout).push(t.re, t.im);
  ok('resample: 300 kHz (would alias to 50 kHz) is rejected', amp(o) < 0.01, amp(o).toExponential(2));
  t = tone(20000);
  const r = new K.RtlsResampler(fin, fout), sizes = [1, 7, 333, 4096, 100000, 17], fr = []; let pos = 0, k = 0;
  while (pos < N) { const s = Math.min(sizes[k++ % sizes.length], N - pos); const q = r.push(t.re.subarray(pos, pos + s), t.im.subarray(pos, pos + s)); for (let i = 0; i < q.re.length; i++) fr.push(q.re[i]); pos += s; }
  const big = new K.RtlsResampler(fin, fout).push(t.re, t.im); let md = 0;
  for (let i = 0; i < Math.min(fr.length, big.re.length); i++) md = Math.max(md, Math.abs(fr[i] - big.re[i]));
  ok('resample: chunk boundaries do not matter (1, 7, 333 … samples)', fr.length === big.re.length && md < 1e-5, fr.length + ' vs ' + big.re.length + ', diff ' + md);
}

// интерполяция вверх: клиент просит 1.024 MS/s, железо дало 0.96
{
  const fin = 960000, fout = 1024000, N = fin;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) { re[i] = Math.cos(2 * Math.PI * 100000 * i / fin); im[i] = Math.sin(2 * Math.PI * 100000 * i / fin); }
  const o = new K.RtlsResampler(fin, fout).push(re, im);
  let a = 0, c = 0, s2 = 0; for (let i = 3000; i < o.re.length - 1; i++) { a += Math.atan2(o.re[i] * o.im[i + 1] - o.im[i] * o.re[i + 1], o.re[i] * o.re[i + 1] + o.im[i] * o.im[i + 1]); s2 += o.re[i] ** 2 + o.im[i] ** 2; c++; }
  ok('upsample 0.96 → 1.024: count', Math.abs(o.re.length - 1024000) <= 3, String(o.re.length));
  ok('upsample: 100 kHz tone stays 100 kHz, level ≈ 1', Math.abs(a / c * fout / (2 * Math.PI) - 100000) < 30 && Math.sqrt(s2 / c) > 0.99, (a / c * fout / (2 * Math.PI)).toFixed(1) + ' Hz, ' + Math.sqrt(s2 / c).toFixed(3));
}
process.exit(bad ? 1 : 0);
