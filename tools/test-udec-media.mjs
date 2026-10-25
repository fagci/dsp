// Universal Decoder: звук и видео наружу (voice, video, iq), маршрут DVB. IQ-генератор (AIS, POCSAG, ISM433, ACARS) → IQK.udec в режимах auto / hint / manual.
// Проверка: node tools/test-udec-media.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
let T=0; class ImageData{ constructor(d,w,h){ this.data=d; this.width=w; this.height=h; } }
const ctx=vm.createContext({ImageData,Uint8ClampedArray,console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,TextDecoder,atob,RegExp,Error,performance:{now:()=>T}});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const ev=s=>vm.runInContext(s,ctx);
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
ok(ev('typeof IQK.udec')==='object','IQK.udec есть в воркере');


ev(`globalThis.REG=UDEC_REG; globalThis.F=udecFind;`);
const F=ctx.F;
// подсказки: маршрут DVB и аналоговое ТВ
ok(F('dvbs')?.route==='dvbsoft' && F('dvbsoft')?.route==='dvbsoft' && F('DVB-T2')?.route==='dvbsoft' && F('dvb')?.route==='dvbsoft','подсказки dvbs / dvbsoft / DVB-T2 → маршрут DVB');
ok(F('fpv')?.proto==='Analog TV (FM)' && F('atv')?.proto==='Analog TV (FM)' && F('pal')?.proto==='Analog TV (AM)' && F('atvam')?.proto==='Analog TV (AM)' && F('tvDecode')?.id==='tvDecode','подсказки: fpv / atv → Analog TV (FM), pal / atvam → Analog TV (AM)');
ok(ctx.REG.filter(r=>r.route).length===1 && ctx.REG.every(r=>r.route || r.id),'у записей без маршрута есть id декодера');
// параметры tvDecode в реестре совпадают с модулем
{ const src=fs.readFileSync(path.join(root,'modules/video.js'),'utf8'), i=src.indexOf("id:'tvDecode'"), blk=src.slice(i,src.indexOf('n=>{',i));
  const r=ctx.REG.find(x=>x.id==='tvDecode');
  { const sd=fs.readFileSync(path.join(root,'modules/video.js'),'utf8'), j=sd.indexOf("id:'tvDemod'"), pb=sd.slice(j,sd.indexOf('n=>',j));
    for(const e of ctx.REG.filter(x=>x.pre)) for(const k in e.pre.p) ok(new RegExp("\\{n:'"+k+"'").test(pb),e.proto+': параметр tvDemod '+k+' есть в модуле'); }
  for(const k in r.p){ const m=blk.match(new RegExp("\\{n:'"+k+"',[^}]*?d:('[^']*'|[-\\d.]+|true|false)"));
    ok(!!m,'tvDecode: параметр '+k+' есть в модуле');
    if(m){ const d=m[1].startsWith("'") ? m[1].slice(1,-1) : m[1]==='true' ? true : m[1]==='false' ? false : +m[1]; ok(d===r.p[k],'tvDecode.'+k+': в модуле '+d+', в реестре '+r.p[k]); } } }
// sigDb → каталог → подсказка udec
{ const sctx=vm.createContext({Math,Object,Array,Set,Number,String,JSON,IQK:{},pv:(n,I,k)=>+I[k]||0});
  vm.runInContext(rd('modules/sigcat-kernels.js')+rd('modules/sigdb-kernels.js')+';globalThis.pick=sigcatPick; globalThis.OF=SIGCAT_OF;',sctx);
  ok(sctx.pick(sctx.OF['DVB-T / DVB-T2'],0)?.decoder==='dvbsoft' && sctx.pick(sctx.OF['Аналоговое ТВ PAL/SECAM'],0)?.decoder==='tvDecode','каталог: DVB → dvbsoft, аналоговое ТВ → tvDecode');
  ok(F(sctx.pick('atv',0).hint)?.proto==='Analog TV (AM)' && F(sctx.pick('atv',471.25e6).hint)?.proto==='Analog TV (AM)' && F(sctx.pick('atv',5658e6).hint)?.proto==='Analog TV (FM)','каталог: у двух ступеней ТВ своя подсказка (AM — эфир, FM — FPV)');
  ok(F(sctx.pick('dvbt',0).decoder)?.route,'декодер DVB из каталога udec находит по подсказке'); }

const mkIq=(sr,fc,N)=>{ const re=new Float32Array(N), im=new Float32Array(N); for(let i=0;i<N;i++){ re[i]=Math.sin(i*.01); im[i]=Math.cos(i*.013); } return {sr,fc,chunks:[{re,im,t0:0}]}; };
// маршрут DVB: IQ на выход iq копией, декодеров не запускает
{ ev(`globalThis.UR={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000}}; IQK.udec.init(UR);`);
  const s=mkIq(10e6,474e6,2048); ctx.__s=s;
  const o=ev(`IQK.udec.process(UR,{in:__s,hint:'dvbt2'},{})`);
  ok(o.proto==='DVB' && o.locked===1 && o.rec===null && ev('UR.ui.route')==='dvbsoft' && ev('UR.ui.st')==='hint','маршрут DVB: proto DVB, locked, без записей');
  ok(o.iq && o.iq.sr===10e6 && o.iq.fc===474e6 && o.iq.chunks[0].re.length===2048 && o.iq.chunks[0].re!==s.chunks[0].re && o.iq.chunks[0].re.buffer!==s.chunks[0].re.buffer && o.iq.chunks[0].re[100]===s.chunks[0].re[100] && o.iq.chunks[0].im[100]===s.chunks[0].im[100],'iq — копия (другие буферы, те же значения), sr и fc сохранены');
  ok(ev('UR.kids.size')===0,'для маршрута декодеры не создаются');
  // ручной режим тоже
  ev(`globalThis.UR2={p:{mode:'manual',proto:'DVB'}}; IQK.udec.init(UR2);`);
  const o2=ev(`IQK.udec.process(UR2,{in:__s},{})`); ok(o2.iq && o2.proto==='DVB' && ev('UR2.ui.st')==='manual','manual DVB тоже отдаёт iq');
  // без passIq и маршрута iq не нужен
  ev(`globalThis.UN={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000}}; IQK.udec.init(UN);`);
  ctx.__s2=mkIq(256000,161.975e6,1024); const o3=ev(`IQK.udec.process(UN,{in:__s2},{})`); ok(o3.iq===null,'без passIq и маршрута iq не копируется');
  ev(`globalThis.UP={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000,passIq:true}}; IQK.udec.init(UP);`);
  const o4=ev(`IQK.udec.process(UP,{in:__s2},{})`); ok(o4.iq && o4.iq.chunks[0].re.length===1024,'passIq: IQ канала отдаётся'); }

// звук: кадры голоса цифровой речи на выход voice
const SR=256000, BLK=1024;
ev(`globalThis.GV={p:{sr:'${SR}',fc:433e6,mode:'4FSK',fsk4:'M17 voice stream',off:2000,lvl:-20,tone:1000,dev:5000,depth:.5,noise:-45,pocsag:'1200',ism:'OOK'}}; IQK.iqGen.init(GV);
    globalThis.UV={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000}}; IQK.udec.init(UV);`);
{ let voices=[], recs=0;
  for(let i=0;i<Math.round(3*SR/BLK);i++){ const o=ev(`(()=>{ const g=IQK.iqGen.process(GV,{},{block:${BLK},sr:${SR}}).iq; const o=IQK.udec.process(UV,{in:g,hint:'m17'},{}); return {voice:o.voice, rec:o.rec&&o.rec.length}; })()`);
    if(o.voice) for(const v of o.voice) voices.push(v); if(o.rec) recs+=o.rec; }
  ok(voices.length>0,'voice: кадры голоса M17 вышли на выход voice ('+voices.length+')');
  ok(voices.every(v=>v.decoder==='fskRx' && v.proto),'voice: записи с decoder и proto ('+(voices[0]&&voices[0].proto)+')');
  ok(recs>0,'rec тоже идёт: '+recs); }

// несколько каналов: voice с частотой и номером канала; iq / video выбранного канала
{ const SR2=1024000;
  ev(`globalThis.GM={p:{sr:'${SR2}',fc:433e6,mode:'4FSK',fsk4:'M17 voice stream',off:100000,lvl:-20,tone:1000,dev:5000,depth:.5,noise:-45,pocsag:'1200',ism:'OOK'}}; IQK.iqGen.init(GM);
      globalThis.UMu={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000,maxCh:4,chHold:8000,passIq:true,outCh:1}}; IQK.udec.init(UMu);`);
  const voices=[]; let iqOk=false;
  for(let i=0;i<Math.round(3*SR2/BLK);i++){ const o=ev(`(()=>{ const g=IQK.iqGen.process(GM,{},{block:${BLK},sr:${SR2}}).iq; const o=IQK.udec.process(UMu,{in:g,sigs:[{f:433.1e6,nbw:25e3,db:-20,sig:true,dec:'m17'}]},{}); return {voice:o.voice, iq:o.iq&&{sr:o.iq.sr,fc:o.iq.fc,n:o.iq.chunks.length&&o.iq.chunks[0].re.length}}; })()`);
    if(o.voice) for(const v of o.voice) voices.push(v); if(o.iq && o.iq.sr<SR2 && Math.abs(o.iq.fc-433.1e6)<1) iqOk=true; }
  ok(voices.length>0 && voices.every(v=>v.ch===1 && Math.abs(v.f-433.1e6)<1),'несколько каналов: voice несёт f и ch ('+voices.length+')');
  ok(iqOk,'несколько каналов: iq — вырезанный канал (sr ниже окна, fc = частота канала)'); }

// видео: аналоговое ТВ (PAL, FM-видео FPV) → картинка на video
{ ev(`globalThis.GT={p:{tv:'PAL',tvm:'FM',tvdev:8e6}}; globalThis.UT={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:8000}}; IQK.udec.init(UT);`);
  let shown=0, w=0, h=0;
  for(let t=0;t<60;t++){
    T=t*5; const o=ev(`(()=>{ const [re,im]=tvGenerate(GT,20e6,100000); const o=IQK.udec.process(UT,{in:{sr:20e6,fc:5658e6,chunks:[{re,im,t0:0}]}},{}); return {v:o.video&&{w:o.video.w,h:o.video.h}, proto:o.proto}; })()`);
    if(o.v){ shown++; w=o.v.w; h=o.v.h; } }
  ok(shown>0 && w>=300 && h>=200,'video: картинка декодера аналогового ТВ вышла на video ('+shown+' кадров, '+w+'×'+h+')');
  ok(ev('UT.ui.proto')==='Analog TV (FM)' && ev('UT.ui.counts["Analog TV (FM)"]')>0 && ev('UT.ui.act.join()')==='Analog TV (FM)','в поиске по диапазону 5.8 ГГц слушает только FM-ТВ, захват удержан'); }

if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('udec media ok');
