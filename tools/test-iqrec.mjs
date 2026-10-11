// Проверка аннотаций SigMF, записи куска полосы и триггера: node tools/test-iqrec.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Int16Array,Set,Array,Object,String,Number,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/iqrec-kernels.js'),'utf8')+
  ';this.K={iqaSigmf,iqaFromSigmf,iqaDdc,iqaTrig};',ctx,{filename:'iqrec-kernels.js'});
const K=ctx.K;
let bad=0;
const ok=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } else console.log('ok  ',m); };

const N=4096, W=N, sr=2.048e6, fc=100e6;
const list=[{a0:1000,a1:9000,lo:100299000,hi:100301000,label:'A 100.3MHz'},{a0:20000,a1:30000,lo:99499000,hi:99501000,label:'mark',mark:true}];

// SigMF туда и обратно
const an=K.iqaSigmf(list, 0, 40*W, 4, 512000);
ok(an.length===2 && an[0]['core:sample_start']>=0 && an[0]['core:freq_lower_edge']<an[0]['core:freq_upper_edge'], 'SigMF-аннотации');
const back=K.iqaFromSigmf(an, fc, 512000);
ok(back.length===2 && Math.abs(back[0].a0*4-list[0].a0)<=4 && back[0].label==='A 100.3MHz', 'обратный разбор');
ok(K.iqaSigmf(list, 1e9, 10, 1, 1).length===0, 'вне записи не попадает');

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
