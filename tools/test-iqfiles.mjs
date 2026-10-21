// IQ в Files: выбор кусков с голосом, сборка WAV / SigMF, обратный разбор, метаданные: node tools/test-iqfiles.mjs
// Голос DMR — настоящий декодер на сигнале встроенного генератора; сборка и разбор файлов — код из sources.js и iqfiles.js.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const worker=rd('iq-worker.js');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,atob,Blob,File,TextEncoder,TextDecoder,Error});
ctx.self=ctx;
for(const f of files) vm.runInContext(rd(f),ctx,{filename:f});
vm.runInContext(rd('modules/iqfiles-kernels.js'),ctx,{filename:'iqfiles-kernels.js'});
const ev=s=>vm.runInContext(s,ctx);
// сборка и разбор файлов — из исходников узлов (по меткам-комментариям)
const cut=(src,a,b)=>{ const i=src.indexOf(a), j=src.indexOf(b,i); if(i<0||j<0) throw new Error('marker '+a+' / '+b); return src.slice(i,j); };
const sources=rd('modules/sources.js'), iqf=rd('modules/iqfiles.js');
ev(cut(sources,'const IQ_WAV_MAX','// Запись: чанки пишутся')+
   cut(sources,'// ---- разбор файлов ----','// Файл играет')+
   cut(iqf,'const IQF_MIME','function iqfDownload')+
   cut(iqf,'function iqpDecode','async function iqpLoad'));

let bad=0;
const ok=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } else console.log('ok  ',m); };

// ---- упаковка, метки, куски ----
{
  const p=ev('iqfPack(new Float32Array([0,1.5,-1.5,.5]),new Float32Array([1,0,-.5,0]))');
  ok(p[0]===0 && p[1]===32767 && p[2]===32767 && p[3]===0 && p[4]===-32768 && p[5]===-16383 && p[6]===16383, 'int16 с насыщением');
  ev(`globalThis.mk=(t0,n,v)=>({t0,re:new Float32Array(n).fill(v),im:new Float32Array(n)})`);
  const run=`(()=>{
    const c=iqfCutNew(), sr=1000; const out=[];
    for(let k=0;k<10;k++){ const ch=mk(k*100,100,(k+1)/20); iqfCutPush(c,ch.t0,ch.re,ch.im,k*100); }
    iqfCutMarkAt(c,500,sr,0,0);                  // [500-60 ; 500] → 440..500
    iqfCutMark(c,700,750,'x'); iqfCutMark(c,740,780,'y');   // пересекаются → один кусок 700..780
    const a=iqfCutTake(c,200,false,sr);          // решены чанки до 800
    const b=iqfCutTake(c,0,true,sr);
    return JSON.stringify([...a,...b].map(p=>[p.t0,p.n,p.label,p.a.length,p.a[0]]));
  })()`;
  const r=JSON.parse(ev(run));
  ok(r.length===2 && r[0][0]===440 && r[0][1]===60 && r[1][0]===700 && r[1][1]===80 && r[1][2]==='x', 'куски по меткам: '+JSON.stringify(r.map(x=>x.slice(0,3))));
  ok(Math.abs(r[0][4]-Math.round(0.25*32767))<2 && r[0][3]===120, 'данные куска из своего чанка');
  // кусок через границу чанков — два куска подряд, сегмент один
  const seg=JSON.parse(ev(`(()=>{
    const c=iqfCutNew(), rec={parts:[],n:0,segs:[],last:null}, sr=1000;
    for(let k=0;k<6;k++){ const ch=mk(k*100,100,.1); iqfCutPush(c,ch.t0,ch.re,ch.im,k*100); }
    iqfCutMark(c,150,350,'a'); iqfCutMark(c,450,500,'b');
    const ps=iqfCutTake(c,0,true,sr); for(const p of ps) iqfSegAdd(rec,p,p.a);
    return JSON.stringify({n:rec.n,segs:rec.segs.map(s=>[s.start,s.label]),parts:rec.parts.length});
  })()`));
  ok(seg.n===250 && seg.segs.length===2 && seg.segs[0][0]===0 && seg.segs[1][0]===200 && seg.segs[1][1]==='b', 'сегменты: непрерывный кусок — один, пропуск — новый '+JSON.stringify(seg));
  // по времени, без номера отсчёта
  const w=JSON.parse(ev(`(()=>{
    const c=iqfCutNew(), sr=1000;
    for(let k=0;k<10;k++){ const ch=mk(k*100,100,.1); iqfCutPush(c,ch.t0,ch.re,ch.im,1000+k*100+100); }   // чанк k пришёл в 1100+100k
    iqfCutMarkWall(c,1450,1520,'w',sr);
    return JSON.stringify(iqfCutTake(c,0,true,sr).map(p=>[p.t0,p.n]));
  })()`));
  ok(w.length===2 && w[0][0]===400 && w[1][0]===500 && w[1][1]===100, 'метка по времени: чанки, пришедшие в окне '+JSON.stringify(w));
  // поток начался заново — кольцо и метки сброшены
  ok(ev(`(()=>{ const c=iqfCutNew(); let ch=mk(0,100,.1); iqfCutPush(c,0,ch.re,ch.im,0); iqfCutMark(c,10,50); ch=mk(0,100,.1); iqfCutPush(c,0,ch.re,ch.im,1); return c.ring.length===1 && c.marks.length===0; })()`), 'перезапуск потока');
  ok(ev(`iqfCutHas((()=>{ const c=iqfCutNew(); const ch=mk(5000,100,.1); iqfCutPush(c,5000,ch.re,ch.im,0); globalThis.cc=c; return c; })(),5050,1000) && !iqfCutHas(cc,900000,1000)`), 'номер отсчёта чужого потока отбрасывается');
}

// ---- описание ----
{
  ok(ev(`JSON.stringify(iqfTagList('DMR, #voice ; dmr\\n, '+'x'.repeat(60)))`)===JSON.stringify(['DMR','voice','dmr','x'.repeat(40)]), 'теги: разбор, # и длина');
  ok(ev('iqfFreq(438.125e6)')==='438.1250 MHz' && ev('iqfFreq(137500)')==='137.500 kHz' && ev('iqfFreq(1.2e9)')==='1.20000 GHz', 'частота');
  ok(ev('iqfDur(2.345)')==='2.35 s' && ev('iqfDur(12.34)')==='12.3 s' && ev('iqfDur(83)')==='1:23' && ev('iqfDur(3725)')==='1:02:05', 'длина');
  ok(ev('iqfBytes(14.2*1048576)')==='14.2 MB', 'размер');
  const nm=ev(`iqfFileName({kind:'wav',label:'DMR voice!',freq:438125000,start:new Date(Date.UTC(2026,0,2,3,4,5))})`);
  ok(nm==='baseband_DMR_voice_438125000Hz_20260102_030405Z.wav', 'имя файла '+nm);
  const m=JSON.parse(ev(`JSON.stringify(iqfMeta({kind:'wav',rate:48000,freq:438.125e6,bw:12500,n:96000,segs:[{start:0,t:5,label:'a'}],src:'t',start:new Date(0),tags:'DMR, voice'}))`));
  ok(m.duration===2 && m.bytes===384000 && m.tags.join()==='DMR,voice' && m.iq.rate===48000 && m.iq.segments.length===1, 'метаданные для менеджера');
  ok(ev(`iqfSub({size:384000,meta:${JSON.stringify(m)}})`)==='438.1250 MHz · 48 kS/s · 375.0 KB · #DMR #voice', 'строка менеджера');
}

// ---- сборка файла и обратный разбор ----
{
  const N=1000, re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){ re[i]=0.5*Math.cos(i*.1); im[i]=0.5*Math.sin(i*.1); }
  ctx.reI=re; ctx.imI=im;
  for(const kind of ['wav','sigmf']){
    const blob=await vm.runInContext(`(async()=>{
      const d=iqfPack(reI,imI), r={kind:'${kind}',rate:48000,freq:438125000,bw:12500,start:new Date(1e12),stop:new Date(1e12+9000),parts:[d.subarray(0,1200),d.subarray(1200)],n:${N},
        segs:[{start:0,t:1e12,label:'1→2 TS1',freq:438125000},{start:600,t:1e12+5000,label:'',freq:438125000}],tags:['DMR','voice'],hw:'',name:'iq_t.sigmf'};
      return iqfBuild(r); })()`,ctx);
    const f=new File([blob],kind==='wav' ? 'baseband.wav' : 'iq_t.sigmf');
    const src=await ev('iqParseFiles')([f],'auto');
    ok(src.rate===48000 && src.captures[0].freq===438125000 && src.dtype==='ci16_le' && src.size===N*4, kind+': разобрано обратно (rate, freq, размер)');
    const buf=await src.blob.slice(src.off,src.off+src.size).arrayBuffer();
    const [r2,i2]=ev('iqpDecode')(buf,src.dtype);
    let e=0; for(let i=0;i<N;i++) e=Math.max(e,Math.abs(r2[i]-re[i]),Math.abs(i2[i]-im[i]));
    ok(e<1e-4, kind+': отсчёты совпали (ошибка '+e.toExponential(1)+')');
    if(kind==='sigmf'){
      ok(src.ann.length===2 && src.ann[0]['core:label']==='1→2 TS1' && src.ann[1]['core:sample_start']===600 && src.captures.length===2, 'SigMF: сегменты — captures и аннотации');
    }
  }
}

// ---- голос DMR: настоящий декодер → метки → кусок потока, который декодируется снова ----
{
  const P=`{sr:'256000',fc:438000000,mode:'DMR',off:2000,lvl:-20,noise:-45,tone:1000,dev:5000,depth:.5,lrpt:'OQPSK',dmr:'repeater (BS)',fsk4:Object.keys(FSK4.gen)[0],pocsag:'1200',ism:'OOK',tv:'PAL',tvm:'FM',tvdev:8000000,gsmCell:'250-01-1234-5678',bsic:12,gsmCombined:true,ps:'DSP TEST',ppm:0,imbG:0,imbP:0,imbD:0}`;
  const PADB=+process.env.PADB||300, PADA=+process.env.PADA||100;
  const r=JSON.parse(ev(`(()=>{
    const gen={p:${P}}, dec={p:{proto:'dmr'}}; IQK.iqGen.init(gen); IQK.fskRx.init(dec);
    const c=iqfCutNew(), sr=256000, ctxx={block:1024,sr:48000}, rec={parts:[],n:0,segs:[],last:null}, marks=[];
    let voice=0, stamped=0, total=0;
    for(let tick=0;tick<260;tick++){
      const s=IQK.iqGen.process(gen,{},ctxx).iq;
      for(const ch of s.chunks){ iqfCutPush(c,ch.t0,ch.re,ch.im,Date.now()); total+=ch.re.length; }
      const o=IQK.fskRx.process(dec,{in:s},ctxx);
      for(const v of o.voice||[]){ voice++; if(typeof v.st==='number' && v.ssr===sr){ stamped++; iqfCutMarkAt(c,v.st,sr,${PADB},${PADA},'v'); } }
      for(const p of iqfCutTake(c,Math.round(sr*.5),false,sr)) iqfSegAdd(rec,p,p.a);
    }
    for(const p of iqfCutTake(c,0,true,sr)) iqfSegAdd(rec,p,p.a);
    // вырезанное — подряд в новый декодер: голос должен найтись и там
    const dec2={p:{proto:'dmr'}}; IQK.fskRx.init(dec2); let v2=0, t0=0;
    const all=new Int16Array(rec.n*2); { let o=0; for(const q of rec.parts){ all.set(q,o); o+=q.length; } }
    for(let i=0;i<rec.n;i+=5461){
      const m=Math.min(5461,rec.n-i), re=new Float32Array(m), im=new Float32Array(m);
      for(let k=0;k<m;k++){ re[k]=all[2*(i+k)]/32768; im[k]=all[2*(i+k)+1]/32768; }
      const o=IQK.fskRx.process(dec2,{in:{sr,fc:438e6,chunks:[{re,im,t0:i}]}},ctxx);
      v2+=(o.voice||[]).length;
    }
    return JSON.stringify({voice,stamped,total,kept:rec.n,segs:rec.segs.length,again:v2});
  })()`));
  ok(r.voice>20 && r.stamped===r.voice, 'голосовые пакеты несут номер отсчёта: '+r.stamped+' из '+r.voice);
  ok(r.kept>0 && r.kept<=r.total, 'вырезано '+r.kept+' из '+r.total+' отсчётов, сегментов '+r.segs);
  ok(r.again>=r.voice*.6, 'в вырезанном голос декодируется снова: '+r.again+' из '+r.voice);
}

console.log(bad ? bad+' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
