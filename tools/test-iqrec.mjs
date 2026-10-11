// Проверка разметки IQ, записи куска полосы и триггера: node tools/test-iqrec.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Int16Array,Set,Array,Object,String,Number,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/iqrec-kernels.js'),'utf8')+
  ';this.K={iqaDetect,iqaNew,iqaTrack,iqaActiveIn,iqaSigmf,iqaFromSigmf,iqaDdc,iqaTrig,iqaFmtHz};',ctx,{filename:'iqrec-kernels.js'});
const K=ctx.K;
let bad=0;
const ok=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } else console.log('ok  ',m); };

// спектр: шум + несущие
const N=4096, sr=2.048e6, fc=100e6, bin=sr/N;
const freqs=new Float64Array(N).map((_,i)=>fc+(i-N/2)*bin);
let seed=1; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
function frame(sigs){
  const m=new Float32Array(N).map(()=>Math.pow(10,(-90+3*(rnd()-.5))/20));
  for(const [f,w,db] of sigs){ const c=Math.round((f-freqs[0])/bin), h=Math.round(w/bin/2); for(let i=c-h;i<=c+h;i++) m[i]=Math.pow(10,db/20); }
  return m;
}
const f1=fc+300e3, f2=fc-500e3;
let d=K.iqaDetect(freqs, frame([[f1,12e3,-40],[f2,6e3,-50]]), 10, [{lo:fc-3e3,hi:fc+3e3}]);
ok(d.length===2, 'два сигнала найдены: '+d.length);
ok(d.some(x=>Math.abs((x.lo+x.hi)/2-f1)<2*bin) && d.some(x=>Math.abs((x.lo+x.hi)/2-f2)<2*bin), 'центры совпадают');
ok(K.iqaDetect(freqs, frame([]), 10).length===0, 'на шуме пусто');
ok(K.iqaDetect(freqs, frame([[fc,2e3,-30]]), 10, [{lo:fc-3e3,hi:fc+3e3}]).length===0, 'пик нуля пропущен');

// трекер: сигнал есть кадры 0..9, нет 10..19, снова 20..24
const st=K.iqaNew(); let t=0; const W=N;
for(let k=0;k<40;k++){ t+=W/2; const on=k<10||(k>=20&&k<25); K.iqaTrack(st, on?K.iqaDetect(freqs,frame([[f1,12e3,-40]]),10):[], t, W, W*3, ''); }
ok(st.list.length===2, 'два интервала: '+st.list.length);
ok(st.list[0].a1>st.list[0].a0 && st.list[0].a1<=10*W/2+W/2, 'первый интервал закончился вовремя');
ok(st.act.length===0, 'активных нет');
ok(/100\.3M/.test(st.list[0].label), 'подпись по частоте: '+st.list[0].label);
// единичный кадр не создаёт аннотацию
{ const s1=K.iqaNew(); K.iqaTrack(s1, K.iqaDetect(freqs,frame([[f1,12e3,-40]]),10), W, W, W*3, ''); K.iqaTrack(s1, [], 2*W, W, W*3, ''); K.iqaTrack(s1, K.iqaDetect(freqs,frame([[f1,12e3,-40]]),10), 3*W, W, W*3, ''); ok(s1.list.length===0, 'выброс на один кадр не размечается'); }
// чистый шум за 400 кадров — ничего
{ const s0=K.iqaNew(); for(let k=0;k<400;k++) K.iqaTrack(s0, K.iqaDetect(freqs,frame([]),10), k*W, W, W*3, ''); ok(s0.list.length===0, 'шум не размечается: '+s0.list.length); }
// файловая аннотация не дублируется
const st2=K.iqaNew(); st2.list.push({a0:0,a1:100*W,lo:f1-10e3,hi:f1+10e3,label:'x',auto:false});
for(let k=0;k<4;k++) K.iqaTrack(st2, K.iqaDetect(freqs,frame([[f1,12e3,-40]]),10), (5+k)*W, W, W*3, '');
ok(st2.list.length===1, 'уже размеченное не дублируется');
// перемотка назад закрывает активные
K.iqaTrack(st, K.iqaDetect(freqs,frame([[f1,12e3,-40]]),10), 100*W, W, W*3, '');
K.iqaTrack(st, [], 1*W, W, W*3, '');
ok(st.act.length===0, 'перемотка назад сбрасывает активные');

// SigMF туда и обратно
const an=K.iqaSigmf(st.list, 0, 40*W, 4, 512000);
ok(an.length===2 && an[0]['core:sample_start']>=0 && an[0]['core:freq_lower_edge']<an[0]['core:freq_upper_edge'], 'SigMF-аннотации');
const back=K.iqaFromSigmf(an, fc, 512000);
ok(back.length===2 && Math.abs(back[0].a0*4-st.list[0].a0)<=4, 'обратный разбор');
ok(K.iqaSigmf(st.list, 1e9, 10, 1, 1).length===0, 'вне записи не попадает');

// DDC: тон на +120 кГц от центра приёма, запись вокруг +100 кГц, полоса 50 кГц, должен стать +20 кГц
{
  const bw=50e3, D=Math.floor(sr/(bw*1.2)), off=100e3, ddc=K.iqaDdc(sr, off, D, bw);
  ok(ddc.rate===Math.round(sr/D), 'выходная частота '+ddc.rate+' (D='+D+')');
  const tones=[[120e3,1],[-300e3,1]];                // второй — вне полосы, должен подавиться
  const n=Math.round(sr*0.2), raw=new Int16Array(2*n);
  for(let i=0;i<n;i++){ let a=0,b=0; for(const [f,g] of tones){ const p=2*Math.PI*f*i/sr; a+=g*Math.cos(p)*.4; b+=g*Math.sin(p)*.4; } raw[2*i]=Math.round(a*32767); raw[2*i+1]=Math.round(b*32767); }
  const parts=[]; for(let i=0;i<n;i+=60000){ parts.push(ddc.push(raw.subarray(2*i, 2*Math.min(n,i+60000)), 's16')); }
  const tot=parts.reduce((s,p)=>s+p.length,0), out=new Int16Array(tot); let o=0; for(const p of parts){ out.set(p,o); o+=p.length; }
  const m=tot>>1, fs=sr/D;
  ok(Math.abs(m-n/D)<=ddc.taps/D+2, 'число отсчётов '+m+' ≈ '+(n/D).toFixed(0)+' минус задержка фильтра');
  // частота по фазе между соседними отсчётами
  let acr=0, aci=0, pw=0;
  for(let i=1000;i<m;i++){ const ar=out[2*i]/32768, ai=out[2*i+1]/32768, br=out[2*i-2]/32768, bi=out[2*i-1]/32768; acr+=ar*br+ai*bi; aci+=ai*br-ar*bi; pw+=ar*ar+ai*ai; }
  const f=Math.atan2(aci,acr)/(2*Math.PI)*fs;
  ok(Math.abs(f-20e3)<300, 'тон в записи на '+f.toFixed(0)+' Гц (ждали 20000)');
  ok(Math.sqrt(pw/(m-1000))>.3 && Math.sqrt(pw/(m-1000))<.5, 'уровень сохранён: '+Math.sqrt(pw/(m-1000)).toFixed(3));
  // в u8
  const ddc2=K.iqaDdc(sr, 0, 8, 100e3), u8=new Uint8Array(2*8192);
  for(let i=0;i<8192;i++){ u8[2*i]=Math.round(127.5+100*Math.cos(2*Math.PI*10e3*i/sr)); u8[2*i+1]=Math.round(127.5+100*Math.sin(2*Math.PI*10e3*i/sr)); }
  const r=ddc2.push(u8,'u8'); ok(r.length>0 && r.length%2===0, 'u8 принимается: '+r.length);
}

// триггер
{
  const o={maxMs:10000, waitMs:2000, armAtStart:true}; let s={};
  const r=[K.iqaTrig(s,false,true,0,o), K.iqaTrig(s,true,false,100,o), K.iqaTrig(s,true,false,200,o), K.iqaTrig(s,false,true,300,o)];
  ok(r.join()===[null,'start',null,'stop'].join(), 'старт по открытию, стоп по закрытию: '+r.join());
  s={}; K.iqaTrig(s,true,false,0,{...o,armAtStart:false});
  ok(K.iqaTrig(s,false,true,500,{...o,armAtStart:false})===null, 'стоп не раньше, чем сработает источник остановки');
  ok(K.iqaTrig(s,false,true,600,{...o,armed:true})==='stop', 'после срабатывания — стоп');
  s={}; K.iqaTrig(s,true,false,0,{...o,armAtStart:false});
  ok(K.iqaTrig(s,false,true,2500,{...o,armAtStart:false})==='stop', 'не открывался — ждём waitMs');
  s={on:true,t0:0,seen:true}; ok(K.iqaTrig(s,true,false,11000,o)==='stop', 'предел длительности');
}
console.log(bad ? bad+' failed' : 'all passed'); process.exit(bad?1:0);
