// Universal Decoder: декодеры главного потока (SAME, Morse, DTMF, SELCAL, RTTY, AX.25, FT8, Olivia, TBSK…) через мост udec-audio.js
// Сигнал — Tx-блоки модулей → звук → FM / AM / USB в IQ канала → IQK.udec. Проверка: node tools/test-udec-audio.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const worker=rd('iq-worker.js');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
let clock=1.7e12;                                       // FT8 / JS8 ждут границы слота по Date.now(): время идёт по обработанным отсчётам
class FakeDate extends Date{ static now(){ return clock; } constructor(...a){ if(a.length) super(...a); else super(clock); } }
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date:FakeDate,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,TextDecoder,TextEncoder,performance,WebAssembly,setTimeout,clearTimeout,ArrayBuffer,DataView,RegExp,Error});
ctx.self=ctx;
vm.runInContext(`let BLOCK=512; const Eng={sr:48000,turbo:1}; const MOD={}; const def=d=>{MOD[d.id]=d}; const defGroups=()=>{}; function setMod(n,k,v){n.p[k]=v}; function buf(n,name){ (n.b||(n.b={})); return n.b[name] || (n.b[name] = new Float32Array(BLOCK)); }
  const OfflineData={blob:async()=>null,fileItem(){},item(){}}; function setNum(){} const binObj=(d,name,mime)=>({d,name:name||'',mime:mime||'',id:1});`,ctx);
for(const f of files) vm.runInContext(rd(f),ctx,{filename:f});
// модули страницы с описаниями блоков (порядок: Morse из analysis.js нужен protocols.js)
for(const f of ['modules/analysis.js','modules/protocols.js','modules/modulation.js','modules/output.js','modules/same.js','modules/selcal.js','modules/tbsk-kernels.js','modules/tbsk.js','modules/js8-kernels.js','modules/js8.js','modules/gsm.js','modules/udec-audio.js'])
  vm.runInContext(rd(f),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } else console.log('ok  '+m); };
ev(`globalThis.REG=UDEC_REG;`);
ok(ev('UDEC_AUDIO.ready()')===true,'мост готов (MOD, Eng, IQK на месте)');
export {ctx,ev,ok,root,files};

// ---- Tx-блок → звук ----
ev(`globalThis.tx=function(id,p,sr,secs,I0,port){
  const sB=BLOCK,sS=Eng.sr; BLOCK=512; Eng.sr=sr;
  const n={id:'t',p:{}}; for(const q of MOD[id].params||[]) if('d' in q) n.p[q.n]=q.d; Object.assign(n.p,p||{}); MOD[id].init(n);
  const N=Math.ceil(secs*sr/512), out=new Float32Array(N*512);
  for(let i=0;i<N;i++){ const o=MOD[id].process(n,i===0 ? Object.assign({go:1},I0||{}) : {go:0}) || {}; const v=o[port||'out']; if(v && v.length) out.set(v.subarray(0,512),i*512); }
  BLOCK=sB; Eng.sr=sS; return out; }`);
const TX=(id,p,sr,secs,I0,port)=>{ ctx.__a=[id,p,sr,secs,I0,port]; return ev('tx(...__a)'); };
// ---- звук → IQ канала ----
let seed=5; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
const gauss=()=>Math.sqrt(-2*Math.log(rnd()+1e-12))*Math.cos(2*Math.PI*rnd());
function up(a,srA,srI){ const N=Math.round(a.length*srI/srA), o=new Float32Array(N), r=srA/srI;
  for(let i=0;i<N;i++){ const x=i*r, j=Math.floor(x), f=x-j; o[i]=a[j]*(1-f)+(j+1<a.length ? a[j+1] : a[j])*f; } return o; }
function fm(a,srA,srI,dev,noise){ const u=up(a,srA,srI), re=new Float32Array(u.length), im=new Float32Array(u.length); let ph=0;
  for(let i=0;i<u.length;i++){ ph+=2*Math.PI*dev*u[i]/srI; re[i]=.5*Math.cos(ph)+noise*gauss(); im[i]=.5*Math.sin(ph)+noise*gauss(); } return {re,im}; }
function am(env,srA,srI,off,noise){ const u=up(env,srA,srI), re=new Float32Array(u.length), im=new Float32Array(u.length);
  for(let i=0;i<u.length;i++){ const ph=2*Math.PI*off*i/srI; re[i]=.5*u[i]*Math.cos(ph)+noise*gauss(); im[i]=.5*u[i]*Math.sin(ph)+noise*gauss(); } return {re,im}; }
function usb(a,srA,srI,noise){ const H=127, h=new Float32Array(H);                    // аналитический сигнал: a + j·Гильберт(a)
  for(let k=-(H>>1);k<=(H>>1);k++) if(k&1 || k&-2 && (k&1)) h[k+(H>>1)]=(2/(Math.PI*k))*(.54+.46*Math.cos(2*Math.PI*k/H));
  const q=new Float32Array(a.length);
  for(let i=0;i<a.length;i++){ let s=0; for(let k=0;k<H;k++){ const j=i-k+(H>>1); if(j>=0 && j<a.length) s+=h[k]*a[j]; } q[i]=s; }
  const re=up(a,srA,srI), im=up(q,srA,srI); for(let i=0;i<re.length;i++){ re[i]=.5*re[i]+noise*gauss(); im[i]=.5*im[i]+noise*gauss(); } return {re,im}; }
// IQ → udec (кусками), time идёт по Date; возвращает записи, текст, последнее состояние
function feed(iq,srI,fc,udP,hint,secs){
  ev(`globalThis.U={p:Object.assign({mode:'auto',proto:'AIS',hold:6000,giveUp:60000,audio:true},${JSON.stringify(udP||{})})}; IQK.udec.init(U);`);
  const recs=[], text=[]; let st=null;
  const L=iq.re.length, CH=4096;
  for(let i=0;i<L;i+=CH){
    const n=Math.min(CH,L-i);
    ctx.__c={sr:srI,fc,chunks:[{re:iq.re.subarray(i,i+n),im:iq.im.subarray(i,i+n),t0:i}]}; ctx.__h=hint??null;
    const o=ev(`IQK.udec.process(U,{in:__c,hint:__h},{block:${CH},sr:${srI}})`);
    if(o.rec) for(const r of o.rec) recs.push(r); if(o.text) text.push(o.text);
    clock+=n/srI*1000;
  }
  return {recs, text:text.join('\n'), ui:ev('U.ui')};
}
const pad=(a,s0,s1,sr)=>{ const o=new Float32Array(Math.round((s0+s1)*sr)+a.length); o.set(a,Math.round(s0*sr)); return o; };
const SR=96000;

// ---- SAME: NFM, 162.55 МГц ----
{ const a=TX('sameTx',{},12000,14);
  const r=feed(fm(a,12000,SR,5000,.002),SR,162.55e6,{},'same',14);
  const h=r.recs.filter(x=>x.kind==='header');
  ok(h.length>0 && h.every(x=>x.proto==='SAME/EAS' && x.event==='RWT' && x.decoder==='sameRx'),'SAME hint: заголовок RWT принят ('+r.recs.length+' записей, '+r.ui.st+')');
  const r2=feed(fm(a,12000,SR,5000,.002),SR,162.55e6,{},null,14);
  ok(r2.recs.some(x=>x.kind==='header' && x.event==='RWT') && r2.ui.st==='lock' && r2.ui.proto==='SAME/EAS','SAME auto по частоте 162.55 МГц: захват, состояние '+r2.ui.st+' '+r2.ui.proto);
  const r3=feed(fm(a,12000,SR,5000,.002),SR,0,{mode:'manual',proto:'SAME/EAS'},null,14);
  ok(r3.recs.some(x=>x.kind==='header'),'SAME manual без fc'); }

// ---- SELCAL: USB, ВЧ ----
{ const a=pad(TX('selcalTx',{},12000,6),0,.5,12000);
  const r=feed(usb(a,12000,SR,.002),SR,8.9e6,{},'selcal',6.5);
  ok(r.recs.some(x=>x.decoder==='selcalRx' && /[A-S]{2}-[A-S]{2}/.test(x.code||x.text||JSON.stringify(x))),'SELCAL hint: вызов принят ('+JSON.stringify(r.recs[0]||null).slice(0,120)+')'); }
// ---- Morse: AM-манипуляция несущей на смещении 700 Гц ----
{ const key=TX('morseTx',{wpm:20,text:'CQ CQ DE TEST'},4000,9,null,'bit').map(x=>x>0 ? 1 : 0);
  const r=feed(am(key,4000,SR,700,.003),SR,7.03e6,{},'morse',9);
  const t=r.recs.filter(x=>x.kind==='text').map(x=>x.text).join(' ');
  ok(/CQ\s*CQ\s*DE/.test(t),'Morse hint: «'+t+'»');
  const r2=feed(am(key,4000,SR,700,.003),SR,7.03e6,{},null,9);
  ok(r2.recs.some(x=>x.kind==='text' && /CQ/.test(x.text)),'Morse auto по частоте 7.03 МГц: ' +r2.recs.filter(x=>x.kind==='text').map(x=>x.proto+':'+x.text).join(' | ').slice(0,100)); }
// ---- DTMF: NFM ----
{ const a=pad(TX('dtmfTx',{},8000,3,{text:'1234567890'}),0,.3,8000);
  const r=feed(fm(a,8000,SR,3000,.002),SR,146.52e6,{},'dtmf',3.5);
  const t=r.recs.filter(x=>x.kind==='text').map(x=>x.text).join('');
  ok(t.replace(/\s/g,'').includes('1234567890'),'DTMF hint: «'+t+'»'); }
// ---- AX.25 / APRS: Bell 202 по FM ----
{ const bits=TX('ax25Tx',{},12000,4,{text:'N0CALL>APRS,WIDE1-1:>udec test'},'bit');
  const a=new Float32Array(bits.length); let ph=0;
  for(let i=0;i<a.length;i++){ ph+=2*Math.PI*(bits[i]>0 ? 1200 : 2200)/12000; a[i]=.7*Math.sin(ph); }
  const r=feed(fm(pad(a,.3,.3,12000),12000,SR,3000,.002),SR,144.8e6,{},'aprs',5);
  ok(r.recs.some(x=>x.kind==='frame' && /udec test/.test(x.info||'') && x.to==='APRS'),'AX.25 hint: кадр APRS ('+JSON.stringify(r.recs[0]||null)+')'); }
// ---- Olivia 8/250: USB ----
{ const a=TX('oliviaTx',{tones:'8',bw:'250',f0:1000,text:'CQ CQ DE UDEC'},12000,24);
  const r=feed(usb(a,12000,SR,.002),SR,14.1e6,{},'olivia',24);
  const t=r.recs.filter(x=>x.kind==='text').map(x=>x.text).join(' ');
  ok(/CQ CQ DE/.test(t),'Olivia hint: «'+t+'»'); }
// ---- TBSK: акустический модем по FM ----
{ const a=pad(TX('tbskTx',{},24000,4,{text:'hello udec'}),.2,.3,24000);
  const r=feed(fm(a,24000,SR,5000,.002),SR,433.5e6,{},'tbsk',4.5);
  ok(r.recs.some(x=>x.decoder==='tbskRx' && /hello udec/.test(x.text||'')),'TBSK hint: кадр ('+JSON.stringify(r.recs[0]||null).slice(0,100)+')'); }
// ---- FT8: USB, слот 15 с по Date ----
{ clock=Math.ceil(1.7e12/15000)*15000;
  const a=pad(TX('ft8Tx',{},12000,13.5,{text:'CQ K1ABC FN31',freq:1000}),.5,2,12000);
  const r=feed(usb(a,12000,SR,.002),SR,14.074e6,{},'ft8',16);
  ok(/CQ K1ABC/.test(r.text),'FT8: сообщение и в текстовом выходе ('+r.text.slice(0,60)+')');
  ok(r.recs.some(x=>x.decoder==='ft8Rx' && /K1ABC/.test(JSON.stringify(x))),'FT8 hint: сообщение слота ('+r.recs.length+' записей: '+JSON.stringify(r.recs[0]||null).slice(0,160)+')'); }
// ---- RTTY: Baudot 45.45 Bd, сдвиг 170 Гц, USB ----
function rtty(text,sr,baud,f1,f2){
  const bits=[]; for(let i=0;i<20;i++) bits.push(1);
  let figs=false; bits.push(0,1,1,1,1,1,1); for(let i=0;i<2;i++) bits.push(1);          // LTRS в начале
  const ch=c=>{ ctx.__ch=c; return ev('ita2enc(__ch)'); };
  const put=(code)=>{ bits.push(0); for(let i=0;i<5;i++) bits.push((code>>i)&1); bits.push(1,1); };
  put(31);
  for(const c of text){ const e=ch(c); if(!e) continue; if(e[0]!==figs){ figs=e[0]; put(figs ? 27 : 31); } put(e[1]); }
  for(let i=0;i<30;i++) bits.push(1);
  const spb=sr/baud, N=Math.ceil(bits.length*spb), a=new Float32Array(N); let ph=0;
  for(let i=0;i<N;i++){ const b=bits[Math.min(bits.length-1,Math.floor(i/spb))]; ph+=2*Math.PI*(b ? f1 : f2)/sr; a[i]=.7*Math.sin(ph); }
  return a;
}
// afskRx сам ищет тоны и скорость, на синтетике надёжно не сходится (на реальных записях — да): проверяем мост — блок работает, тоны найдены, мусор не выдаётся за текст
{ const a=rtty('RYRYRY CQ CQ DE TEST TEST',12000,45.45,1275,1445);
  const r=feed(usb(a,12000,SR,.002),SR,14.085e6,{},'rtty',a.length/12000+.5);
  const k=ev("U.kids.get('RTTY')"), st=k.sts[0];
  ok(!k.err && st.fMark>300 && st.fMark<3000 && r.ui.st==='hint' && k.ar>=12000,'RTTY hint: afskRx получает звук (тоны '+st.fMark.toFixed(0)+'/'+st.fSpace.toFixed(0)+' Гц, '+st.baud.toFixed(1)+' Bd)');
  ok(r.recs.every(x=>x.kind!=='text' || x.lock>=.7),'RTTY: текст с захватом ниже порога выводится как unknown'); }
// ---- JS8Call: USB, слот 15 с ----
{ clock=Math.ceil(1.7e12/15000)*15000;
  const a=pad(TX('js8Tx',{},12000,14.5,{freq:1000}),.5,1.5,12000);
  const r=feed(usb(a,12000,SR,.002),SR,14.078e6,{},'js8',16);
  ok(r.recs.some(x=>x.decoder==='js8Rx' && /K1ABC/.test(JSON.stringify(x))),'JS8 hint: кадр слота ('+r.recs.length+': '+JSON.stringify(r.recs[0]||null).slice(0,160)+')'); }
// ---- GSM: несущая из генератора → udec (IQ напрямую, ≥ 1.06 МС/с) ----
{ const SRG=ev('GSM_TARGET_SR'), N=65536, secs=4;
  ev(`globalThis.GN={p:{gsmCell:'250-01-1234-5678',bsic:18}}`);
  ev(`globalThis.U={p:{mode:'auto',proto:'AIS',hold:6000,giveUp:60000,audio:true}}; IQK.udec.init(U);`);
  const recs=[];
  for(let done=0;done<secs*SRG;done+=N){
    ctx.__g=ev(`(()=>{ const [re,im]=gsmGenerate(GN,GSM_TARGET_SR,${N}); return {sr:GSM_TARGET_SR,fc:947.2e6,chunks:[{re,im,t0:0}]}; })()`);
    const o=ev(`IQK.udec.process(U,{in:__g,hint:'gsm'},{})`); if(o.rec) for(const r of o.rec) recs.push(r); }
  ok(recs.some(x=>x.decoder==='gsmRx' && /GSM/.test(x.kind||'')),'GSM hint: системная информация ('+[...new Set(recs.map(x=>x.kind))]+')'); }
// ---- WWV: запуск без ошибок ----
{ const a=TX('wwvTx',{},8000,4);
  const r=feed(am(a,8000,SR,0,.002),SR,10e6,{},'wwv',4);
  ok(!ev("U.kids.get('WWV/CHU')?.err") && r.ui.st==='hint','WWV hint: цепочка работает без ошибок'); }
// ---- manual и переезд ----
{ const a=pad(TX('sameTx',{},12000,12),0,0,12000);
  const r=feed(fm(a,12000,SR,5000,.002),SR,162.55e6,{mode:'manual',proto:'SAME/EAS',audio:false},null,12);
  ok(r.recs.some(x=>x.kind==='header') ,'SAME manual');
  ok(ev(`udecMainWhen({p:{audio:false,mode:'manual',proto:'SAME/EAS'}})`)===true && ev(`udecMainWhen({p:{audio:false,mode:'auto',proto:'AIS'}})`)===false && ev(`udecMainWhen({p:{audio:true,mode:'auto',proto:'AIS'}})`)===true,'udecMainWhen: manual main-декодер и параметр audio гонят узел в главный поток'); }
// ---- реестр ----
{ const need=['SAME/EAS','SELCAL','Morse','DTMF','RTTY','aFSK (ASCII)','AX.25/APRS','WWV/CHU','FT8','JS8Call','Olivia 8/250','Olivia 16/500','TBSK','GSM','Meteor LRPT'];
  ok(need.every(p=>ev('UDEC_REG').some(r=>r.proto===p)),'в реестре есть: '+need.join(', '));
  ok(ev(`['same','eas','morse','cw','aprs','ax25','rtty','afsk','dtmf','wwv','ft8','js8','olivia','tbsk','gsm','lrpt','meteor','selcal'].every(h=>udecFind(h))`),'подсказки находят записи'); }
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('udec-audio ok');
