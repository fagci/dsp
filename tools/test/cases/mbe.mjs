// Vocoder (mbelib в wasm): совпадение с нативной сборкой, раскладка кадров, узел mbeVoice от генератора до звука
import {readFileSync} from 'node:fs';
const V = JSON.parse(readFileSync(new URL('../data/fsk4-vectors.json', import.meta.url), 'utf8')).mbe;

const GENV = (fsk4, proto) => [[['iqGen', {sr:'256000', fc:851e6, mode:'4FSK', off:1500, lvl:-20, noise:-45, fsk4}], ['fskRx', {proto}], ['mbeVoice', {}]], ['0.iq>1.in', '1.voice>2.voice']];
const GENDMR = () => [[['iqGen', {sr:'256000', fc:438e6, mode:'DMR', off:2000, lvl:-20, noise:-45}], ['dmrRx', {}], ['mbeVoice', {}]], ['0.iq>1.in', '1.voice>2.voice']];

export const nxdnTests = [];
export default [
  {name:'mbelib.wasm: IMBE 7200x4400, AMBE+2 3600x2450 and AMBE 3600x2400 frames give the same samples and error counts as the native build (same sources)', arg:V, async fn(V){
    if(!await mbeLoad()) return 'wasm not loaded: '+MBE.err;
    let ln = 0;                                                             // как у нативной программы: шум с фиксированным зерном на каждый кадр
    for(const [k, name] of [['imbe', 'IMBE'], ['a2450', 'AMBE+2'], ['a2400', 'AMBE']]){
      const t = V[k], h = MBE.ex.mbx_new(); let peak = 0, worst = 0, clip = 0, used = 0;
      for(let i=0; i<t.frames.length; i++){
        MBE.ex.mbx_seed(0x1234567 + ln++);
        const fm = {k, fr:Uint8Array.from(t.frames[i], c => +c)}, d = mbeDecode(h, fm, 3);
        if(d.errs !== t.errs[i]) return name+' frame '+i+': errors '+d.errs+' vs '+t.errs[i];
        for(let j=0; j<160; j++){
          const want = new Int16Array(Uint8Array.from(t.pcm[i].slice(4*j, 4*j+4).match(/../g), x => parseInt(x, 16)).reverse().buffer.slice(0))[0];
          if(Math.abs(want) >= 30000 || Math.abs(d.pcm[j]) >= 30000){ clip++; continue; }            // float → short за пределами диапазона: у x86 и wasm по-разному
          peak = Math.max(peak, Math.abs(want)); worst = Math.max(worst, Math.abs(d.pcm[j]-want)); used++;
        }
      }
      MBE.ex.mbx_free(h);
      if(peak < 1000 || used < 400) return name+': too little to compare (peak '+peak+', '+used+' samples, '+clip+' clipped)';
      if(worst > 16) return name+': samples differ by up to '+worst+' (peak '+peak+')';
    }
    return true;
  }},
  {name:'mbe frames: every protocol gets the right matrix (P25 IMBE 8×23, DMR / NXDN / dPMR / YSF AMBE+2 4×24, D-STAR AMBE 4×24), all bits placed once', fn(){
    const chk = (r, k, size, cnt) => {
      const fs = mbeFrames(r);
      if(fs.length !== cnt) return r.src+': '+fs.length+' frames, expected '+cnt;
      for(const f of fs){ if(f.k !== k || f.fr.length !== size) return r.src+': '+f.k+' '+f.fr.length; }
      return fs;
    };
    // единицы во всех битах: заняты ровно все ячейки матрицы (перемежение — перестановка; в IMBE 8×23 занято 144 из 184, остальные — 0)
    const ones = n => 'FF'.repeat(n);
    let fs = chk({src:'P25', imbe:ones(18)}, 'imbe', 184, 1); if(typeof fs === 'string') return fs;
    if(fs[0].fr.reduce((a, b) => a+b, 0) !== 144) return 'IMBE cells '+fs[0].fr.reduce((a, b) => a+b, 0);
    for(const src of ['NXDN', 'dPMR']){ fs = chk({src, ambe:ones(9)}, 'a2450', 96, 1); if(typeof fs === 'string') return fs; if(fs[0].fr.reduce((a, b) => a+b, 0) !== 72) return src+' cells'; }
    fs = chk({src:'DMR', ambe:ones(27)}, 'a2450', 96, 3); if(typeof fs === 'string') return fs;
    fs = chk({src:'YSF', kind:'ambe', dt:0, ambe:ones(9)}, 'a2450', 96, 1); if(typeof fs === 'string') return fs;
    fs = chk({src:'D-STAR', ambe:ones(9)}, 'a2400', 96, 1); if(typeof fs === 'string') return fs;
    if(fs[0].fr.reduce((a, b) => a+b, 0) !== 72) return 'D-STAR cells '+fs[0].fr.reduce((a, b) => a+b, 0);
    if(mbeFrames({src:'YSF', kind:'ambe', dt:2, ambe:ones(13)}).length || mbeFrames({src:'M17', codec2:'00'}).length) return 'YSF mode 2 / M17 must not go to mbelib';
    return true;
  }},
  {name:'mbeVoice node: 4FSK generator → fskRx → vocoder → audio (P25, NXDN 9600 / 4800, dPMR, D-STAR, DMR): frames decoded, sound comes out, no NaN', arg:[[...GENV('P25 voice', 'p25'), 'P25'], [...GENV('NXDN 9600 voice', 'nxdn'), 'NXDN'], [...GENV('NXDN 4800 voice', 'nxdn48'), 'NXDN'], [...GENV('dPMR voice', 'dpmr'), 'dPMR'], [...GENV('D-STAR voice', 'dstar'), 'D-STAR'], [...GENDMR(), 'DMR']], async fn(list){
    if(!await mbeLoad()) return 'wasm not loaded: '+MBE.err;
    for(const [g, w, src] of list){
      const ns = T.build(g, w), n = Math.ceil(6*Eng.sr/BLOCK); let pk = 0, sum = 0;
      for(let b=0; b<n; b++){
        for(const o of Eng.outs) o.fill(0);
        for(const nd of Graph.order) evalNode(nd);
        Eng.blocks++;
        const o = ns[2].out.out;
        if(o) for(let i=0; i<o.length; i++){ if(!isFinite(o[i])) return src+': NaN in the output'; pk = Math.max(pk, Math.abs(o[i])); sum += o[i]*o[i]; }
      }
      const e = T.errors(); if(e.length) return e.join('; ');
      const tot = ns[2].tot;
      if(!tot || tot.frames < 20) return src+': decoded frames '+(tot && tot.frames);
      if(src !== 'P25' && pk < .005) return src+': silent, peak '+pk+', frames '+tot.frames;   // P25: кадры генератора — случайные, mbelib по ним чаще молчит
      if(src === 'P25' && !ns[2].streams.size) return 'P25: no stream';
    }
    return true;
  }},
];
