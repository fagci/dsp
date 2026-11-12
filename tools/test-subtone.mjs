// Субтоны CTCSS и DCS (собрали → разобрали): node tools/test-subtone.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Set,Map,Number,String,JSON,Array,Object,Float64Array,Float32Array,Int32Array,isFinite,parseInt});
vm.runInContext(fs.readFileSync(path.join(root,'modules/subtone-kernels.js'),'utf8')+';this.K={CT_TONES,DCS_CODES,dcsMod,dcsBits,dcsParse,dcsTxNew,dcsTxBlock,dcsRxNew,dcsRxPush,ctTxNew,ctTxBlock,ctRxNew,ctRxPush};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
let seed=12345; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
const gauss=()=>{ let s=0; for(let i=0;i<6;i++) s+=rnd(); return (s-3)/Math.sqrt(.5); };

// код Голея: 4096 слов, минимальное расстояние 7
{ let dmin=99; for(let d=1;d<4096;d++){ const c=(d<<11)|K.dcsMod(d<<11); let w=0,v=c; while(v){ w+=v&1; v>>>=1; } if(w<dmin) dmin=w; }
  ok('the generator is a Golay code: minimal distance 7',dmin===7,String(dmin)); }
ok('50 CTCSS tones, 104 DCS codes',K.CT_TONES.length===50 && K.DCS_CODES.length===104 && new Set(K.DCS_CODES).size===104);
// слово: все коды, обе полярности, до 3 ошибок
{ let fail=0, failE=0;
  for(const code of K.DCS_CODES) for(const inv of [false,true]){
    const b=K.dcsBits(code,inv), r=K.dcsParse(b);
    if(!r || r.code!==code || r.inv!==inv || r.errs!==0) fail++;
    const e=b.slice(); const idx=new Set(); while(idx.size<3) idx.add(Math.floor(rnd()*23)); for(const i of idx) e[i]^=1;
    const r3=K.dcsParse(e,3); if(!r3 || r3.code!==code || r3.inv!==inv) failE++;
  }
  ok('word: every code in both polarities parses back',fail===0,String(fail));
  ok('word: three bit errors are corrected',failE===0,String(failE)); }
{ let acc=0; for(let k=0;k<2000;k++){ const b=[]; for(let i=0;i<23;i++) b.push(rnd()<.5 ? 1 : 0); if(K.dcsParse(b,2)) acc++; }
  ok('random words are rarely accepted (≤ 2 errors)',acc<60,String(acc)); }

// CTCSS: каждый тон, с шумом и «голосом»
function runCt(sr,tone,amp,noise,voice){
  const tx=K.ctTxNew(sr), rx=K.ctRxNew(sr), buf=new Float32Array(480); let ev=[], ph=0;
  for(let b=0;b<Math.ceil(sr*3/480);b++){
    K.ctTxBlock(tx,tone,amp,buf);
    for(let i=0;i<480;i++){ ph+=2*Math.PI*(700+300*Math.sin(b*.01))/sr; const x=(tone?buf[i]:0)+voice*Math.sin(ph)+noise*gauss(); const e=K.ctRxPush(rx,x); if(e) ev.push(e); }
  }
  return {ev,rx};
}
{ let miss=0; for(const t of K.CT_TONES){ const r=runCt(48000,t,.1,.02,.3); if(!(r.ev.length>=1 && r.ev[0].tone===t && r.rx.tone===t)) miss++; }
  ok('CTCSS: all 50 tones found at 48 kS/s (tone 10 %, voice 30 %, noise)',miss===0,String(miss)); }
{ let miss=0; for(const t of [67.0,69.3,100.0,151.4,203.5,254.1]){ const r=runCt(44100,t,.1,.02,.3); if(!(r.rx.tone===t)) miss++; }
  ok('CTCSS: 44.1 kS/s',miss===0,String(miss)); }
{ const r=runCt(48000,0,0,.02,.3); ok('CTCSS: voice and noise without a tone → no tone',r.ev.length===0 && r.rx.tone===0,JSON.stringify(r.ev)); }
{ const sr=48000, tx=K.ctTxNew(sr), rx=K.ctRxNew(sr), buf=new Float32Array(480); let on=0, off=0;
  for(let b=0;b<300;b++){ K.ctTxBlock(tx,100,b<150 ? .1 : 0,buf); for(let i=0;i<480;i++){ const e=K.ctRxPush(rx,buf[i]+.02*gauss()); if(e){ if(e.tone===100) on++; else if(e.tone===0) off++; } } }
  ok('CTCSS: the tone appears and then goes away',on===1 && off===1,on+'/'+off); }
{ const r=runCt(48000,100,.002,.02,0); ok('CTCSS: a tone below the threshold is ignored',r.rx.tone===0); }

// DCS: все коды, обе полярности, с шумом
function runDcs(sr,code,inv,amp,noise,voice,sec){
  const tx=K.dcsTxNew(sr,code,inv), rx=K.dcsRxNew(sr), buf=new Float32Array(480); let ev=[], ph=0;
  for(let b=0;b<Math.ceil(sr*sec/480);b++){
    K.dcsTxBlock(tx,amp,buf);
    for(let i=0;i<480;i++){ ph+=2*Math.PI*900/sr; const e=K.dcsRxPush(rx,buf[i]+voice*Math.sin(ph)+noise*gauss()); if(e) ev.push(e); }
  }
  return {ev,rx};
}
// инверсный сигнал читается как эквивалентный нормальный код (D023I = D047N), если такой есть
const want=(code,inv)=>{ if(!inv) return {code,inv:false}; const b=K.dcsBits(code,true);
  for(let r=0;r<23;r++){ const p=K.dcsParse(b.slice(r).concat(b.slice(0,r))); if(p && !p.inv) return p; }      // слово циклическое: ищем сдвиг, где читается как «N»
  return {code,inv:true}; };
{ let miss=0, eqv=0; for(const code of K.DCS_CODES) for(const inv of [false,true]){ const w=want(code,inv); if(inv && w.code!==code) eqv++; const r=runDcs(48000,code,inv,.2,.02,.2,2); if(!(r.rx.code===w.code && r.rx.inv===w.inv)) miss++; }
  ok('DCS: all 104 codes in both polarities at 48 kS/s (noise, voice)',miss===0,String(miss));
  ok('DCS: D023I reads as D047N (an inverted word is another normal code)',want('023',true).code==='047' && !want('023',true).inv && eqv>50,String(eqv)); }
{ let miss=0; for(const code of ['023','155','411','754']){ const r=runDcs(44100,code,false,.2,.02,.2,2); if(r.rx.code!==code) miss++; }
  ok('DCS: 44.1 kS/s',miss===0,String(miss)); }
{ const r=runDcs(48000,'023',false,0,.02,.3,2); ok('DCS: noise and voice without a code → nothing',r.ev.length===0 && r.rx.code===''); }
{ const sr=48000, tx=K.dcsTxNew(sr,'131',false), rx=K.dcsRxNew(sr), buf=new Float32Array(480); let on=0, off=0, other=0;
  for(let b=0;b<400;b++){ K.dcsTxBlock(tx,b<150 ? .2 : 0,buf); for(let i=0;i<480;i++){ const e=K.dcsRxPush(rx,buf[i]+.01*gauss()); if(e){ if(e.code==='131') on++; else if(e.code==='') off++; else other++; } } }
  ok('DCS: the code appears and then goes away',on===1 && off===1 && other===0,on+'/'+off+'/'+other); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
