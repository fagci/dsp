// Замер ядер IQ (modules/iq-kernels.js) в Node: доля ядра процессора на каждый блок цепочки
// генератор → сдвиг → децимация → демодулятор. Запуск: node bench.mjs [sr] [M] [tpp]
import fs from 'node:fs';
const root = new URL('../../', import.meta.url);
const src = ['core-dsp.js', 'modules/iq-kernels.js'].map(f => fs.readFileSync(new URL(f, root), 'utf8')).join('\n');
const IQK = new Function(src+'\nreturn IQK;')();

const sr = +(process.argv[2] || 2400000), M = process.argv[3] || '10', tpp = process.argv[4] || '16';
const secs = 5, ctx = {block:512, sr:48000};
const mk = (t, p) => { const n = {p}; IQK[t].init(n); return n; };
const nodes = [
  ['iqGen', {sr:String(sr), fc:1e8, off:100000, lvl:-20, noise:-60, tone:1000, mode:'FM', dev:5000, depth:.5, ppm:0}],
  ['iqShift', {offset:100000}],
  ['iqDecim', {M, cut:.4, tpp}],
  ['iqDemod', {mode:'FM', dev:5000, deemph:'off', bw:2700, gain:0}],
].map(([t, p]) => ({t, n:mk(t, p), ms:0}));

for(let i=0, ticks=Math.round(secs*ctx.sr/ctx.block); i<ticks; i++){
  let s = null;
  for(const b of nodes){
    const a = performance.now();
    const out = IQK[b.t].process(b.n, s ? {in:s} : {}, ctx);
    b.ms += performance.now()-a;
    s = out.iq || out.out;
  }
}
console.log(`${sr/1e6} MS/s, decimation ${M}, ${tpp} taps per output`);
for(const b of nodes) console.log('  '+b.t.padEnd(8), (b.ms/secs/10).toFixed(1).padStart(6)+'% of a core');
