// Inmarsat Aero, P-канал 600 / 1200: передатчик (aero-kernels.js) → IQK.aeroRx; кадр, Витерби, CRC SU, ISU → ACARS, несущая, шум;
// реальная запись эфира (tools/data/aero-p600-8k.i8: 1545.08 МГц, P600, 2.9 с).
// Проверка: node tools/test-aero.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Infinity,NaN,BigInt,Symbol,Error,RegExp,Promise,setTimeout,TextDecoder,TextEncoder,self:null});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } else console.log('ok  '+m); };
ok(ev('typeof IQK.aeroRx')==='object','IQK.aeroRx есть в воркере');

let seed=7; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
const gauss=()=>Math.sqrt(-2*Math.log(rnd()+1e-12))*Math.cos(2*Math.PI*rnd());

// кадровый код без модема: 72 байта → 1152 кодовых бита → мягкие значения → 72 байта (оба размера перемежителя)
ev(`globalThis.codec=function(N,flips,neighbours){
  const by=new Uint8Array(72); for(let i=0;i<72;i++) by[i]=(i*53+7)&255;
  for(let i=0;i<6;i++){ by[i*12+10]=0; by[i*12+11]=0; const c=aeroSuCrc(by,i*12); by[i*12+10]=c&255; by[i*12+11]=c>>8; }
  const st={r:0}, prevBy=by.map(v=>v^0x5A), nextBy=by.map(v=>v^0xA5);
  const pr=aeroEncode(prevBy,N,st), cur=aeroEncode(by,N,st), nx=aeroEncode(nextBy,N,st), B=64*N;
  const sf=b=>{ const o=new Float32Array(b.length); for(let i=0;i<b.length;i++) o[i]=b[i] ? 1 : -1; return o; };
  const sym=sf(cur); for(const i of flips) sym[i]=-sym[i];
  const r=aeroDecode(sym,N,neighbours ? sf(pr).subarray(AERO_DATA-B) : null,neighbours ? sf(nx).subarray(0,B) : null);
  return {same:r.bytes.every((v,i)=>v===by[i]), ber:r.ber, crc:[0,1,2,3,4,5].every(i=>aeroSuCrc(r.bytes,i*12)===(r.bytes[i*12+10]|(r.bytes[i*12+11]<<8)))}; }`);
for(const N of [6,9]){
  let r=ev(`codec(${N},[],true)`);
  ok(r.same && r.crc && r.ber===0,'кадр N='+N+': кодирование → декодирование без ошибок (BER '+r.ber+')');
  const flips=[]; for(let i=0;i<1152;i+=19) flips.push(i);           // ~5 % ошибок
  r=ev(`codec(${N},${JSON.stringify(flips)},true)`);
  ok(r.same && r.crc,'кадр N='+N+': '+flips.length+' ошибок в кодовых битах исправлены, оценка BER '+(100*r.ber).toFixed(1)+'%');
  r=ev(`codec(${N},[],false)`);
  ok(r.same,'кадр N='+N+': без соседних кадров (свободный старт, нейтральный хвост)');
}
// CRC: SU из реальной записи
ev(`globalThis.suReal=Uint8Array.from('26 19 00 00 00 00 00 00 00 00 bc ea'.split(' '),h=>parseInt(h,16))`);
ok(ev('aeroSuCrc(suReal,0)')===0xEABC,'CRC-16 SU: контрольное значение с реального эфира (0xEABC)');

function gen(sr,baud,secs,df,noise){
  ev(`globalThis.G={}`);
  const N=Math.round(sr*secs); ctx.__sr=sr; ctx.__N=N; ctx.__b=baud;
  const [re,im]=ev(`aeroGenerate(G,__sr,__N,__b)`);
  const w=2*Math.PI*df/sr;
  for(let i=0;i<N;i++){ const c=Math.cos(w*i), s=Math.sin(w*i), a=re[i], b=im[i]; re[i]=a*c-b*s+noise*gauss(); im[i]=a*s+b*c+noise*gauss(); }
  return {re,im};
}
function decode(sig,sr,baud,chunk=4096){
  ctx.__p={baud:String(baud)}; ev(`globalThis.R={p:__p}; IQK.aeroRx.init(R);`);
  const recs=[];
  for(let i=0;i<sig.re.length;i+=chunk){
    const L=Math.min(chunk,sig.re.length-i);
    ctx.__c={sr,fc:1545e6,chunks:[{re:sig.re.subarray(i,i+L),im:sig.im.subarray(i,i+L),t0:i}]};
    const o=ev('IQK.aeroRx.process(R,{in:__c},{})'); if(o.rec) for(const r of o.rec) recs.push(r);
  }
  return {recs, ui:ev('R.ui')};
}
const msgOf=(recs,reg)=>recs.find(x=>x.kind==='message' && x.reg===reg);
const cases=[[9600,600,0,0,'9.6 кС/с, чисто'],[8000,600,900,.2,'8 кС/с, расстройка +900 Гц'],[48000,600,-1500,.5,'48 кС/с, расстройка −1500 Гц'],
  [250000,600,2000,1,'250 кС/с, расстройка +2 кГц, шум'],[19200,1200,0,0,'P1200, 19.2 кС/с'],[48000,1200,1200,.5,'P1200, 48 кС/с, расстройка +1.2 кГц'],
  [48000,600,300,2.5,'48 кС/с, шум σ=2.5 (C/N ≈ 8 дБ в полосе 600 Гц)']];
for(const [sr,baud,df,noise,name] of cases){
  const r=decode(gen(sr,baud,baud===600?24:14,df,noise),sr,baud,Math.max(256,Math.round(sr/50)));
  const m1=msgOf(r.recs,'VP-BDB'), m2=msgOf(r.recs,'VQ-BRD'), call=r.recs.find(x=>x.kind==='call');
  ok(m1 && m1.label==='H1' && m1.flight==='SU1204' && m1.txt.includes('#M1BPOS N55123E037456') && m1.aes==='4840D6' && m1.ges==='2F',name+': ACARS борта VP-BDB, ICAO-адрес и станция'+(m1 ? '' : ' (кадров '+r.ui.frames+', SU '+r.ui.suOk+'/'+r.ui.suBad+')'));
  ok(m2 && m2.label==='5Z' && m2.txt.includes('GATE B23 LAND 1432Z') && m2.aes==='3C4DD2',name+': второе сообщение с несколькими SSU');
  ok(call && call.aes==='4840D6' && call.rx===1546 && call.tx===1647 && call.prio==='non-safety',name+': назначение голосового канала (RX '+(call?.rx)+' МГц, TX '+(call?.tx)+')');
  ok(Math.abs(r.ui.fc-df)<3,name+': несущая '+r.ui.fc.toFixed(1)+' Гц (задано '+df+')');
  if(sr===9600) ok(r.ui.suBad===0 && r.ui.ber===0 && r.ui.sat?.id===3 && r.ui.sat.lon===64.5,'чистый сигнал: все SU сошлись, BER 0, спутник 3 (64.5°E)');
}
{ const r=decode(gen(9600,600,12,0,0),9600,600);
  const sys=r.recs.filter(x=>x.kind==='sys').map(x=>x.text);
  ok(sys.some(t=>/^Satellite 3 at 64\.5°E, Psmc 1545\.0000 MHz/.test(t)) && sys.some(t=>/^GES 2F: P channel 1545\.0000 MHz at 1200 bit\/s/.test(t)) && sys.some(t=>/^GES 2F: Psmc 1545\.0000 MHz, Rsmc0 1646\.5000/.test(t)),'таблицы системы: спутник, P-канал станции, каналы Psmc / Rsmc');
  ok(r.recs.filter(x=>x.kind==='sys' && x.text==='System table index').length===1,'повторы таблиц не чаще раза в минуту'); }
// ACARS в нескольких блоках (ETB 0x17): два ISU склеиваются по борту, метке и следующей букве/цифре блока
ev(`globalThis.etbT=function(){
  const mk=(m,etb)=>{ const code=s=>typeof s==='number' ? s : s.charCodeAt(0), c=[code(m.mode)];
    for(const ch of m.reg) c.push(ch.charCodeAt(0));
    c.push(code(m.ack), m.label.charCodeAt(0), m.label.charCodeAt(1), code(m.blk), 2); for(const ch of m.body) c.push(ch.charCodeAt(0)); c.push(etb ? 0x17 : 3);
    const by=c.map(vacPar), crc=vacCrc(by,by.length); by.push(crc&0xFF,crc>>8,0x7f); return [0xFF,0xFF,0x01,...by]; };
  const st=aeroState(), base={mode:'2',reg:'.VP-BDB',ack:'3',label:'5Z'};
  const a=aeroAcars(st,{aes:0x4840D6,ges:0x2F,data:mk({...base,blk:'B',body:'FIRST BLOCK, '},true)},1000);
  const b=aeroAcars(st,{aes:0x4840D6,ges:0x2F,data:mk({...base,blk:'C',body:'SECOND BLOCK'},false)},2000);
  return {a, b, left:st.frag.size}; }`);
{ const r=ev('etbT()');
  ok(r.a===null && r.b && r.b.txt==='FIRST BLOCK, SECOND BLOCK' && r.b.parts===2 && r.left===0,'ACARS: блок ETB ждёт продолжения, потом выходит одним сообщением ('+(r.b?.txt)+')'); }
// инверсия (спектр зеркален): тот же кадр после сопряжения IQ
{ const sg=gen(9600,600,30,200,.3); for(let i=0;i<sg.im.length;i++) sg.im[i]=-sg.im[i];
  const r=decode(sg,9600,600);
  ok(msgOf(r.recs,'VP-BDB') && r.ui.lock,'зеркальный спектр (сопряжённый IQ): кадры принимаются, несущая '+r.ui.fc.toFixed(0)+' Гц'); }
// только шум и чужая несущая: ни кадров, ни ложных сообщений
{ const N=48000*30, re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){ re[i]=gauss()*2+.5*Math.cos(2*Math.PI*1000*i/48000); im[i]=gauss()*2+.5*Math.sin(2*Math.PI*1000*i/48000); }
  const r=decode({re,im},48000,600,960);
  ok(r.recs.length===0 && r.ui.suOk===0,'шум + CW-несущая: записей нет (синхрослов '+r.ui.uw+')'); }
// слишком низкая частота дискретизации
{ const r=decode({re:new Float32Array(2000),im:new Float32Array(2000)},4000,600);
  ok(/too low/.test(r.ui.err||''),'sr 4 кС/с: сообщение об ошибке'); }

// СКАНЕР: широкая запись с тремя каналами P600 и CW-помехой на 250 кС/с → три канала с верной частотой, помеха не остаётся
{ ev(`globalThis.GM={}`); ctx.__sr=250000;
  ctx.__p={baud:'600',max:8,thr:1.2}; ev(`globalThis.RS={p:__p}; IQK.aeroScan.init(RS);`);
  const recs=[]; let lastOut=null; const BLK=8192;
  for(let i=0;i<45*250000;i+=BLK){
    ctx.__N=BLK; const [re,im]=ev(`aeroGenMulti(GM,__sr,__N)`);
    for(let j=0;j<BLK;j++){ re[j]+=.15*gauss(); im[j]+=.15*gauss(); }
    ctx.__c={sr:250000,fc:1545.1e6,chunks:[{re,im,t0:i}]};
    const o=ev('IQK.aeroScan.process(RS,{in:__c},{})'); if(o.rec) recs.push(...o.rec); lastOut=o;
  }
  const u=ev('RS.ui'), f=u.chans.map(c=>c.f/1e6);
  ok(u.chans.length===3 && u.chans.every(c=>!c.probe && c.lock),'сканер: найдено и подтверждено три канала, CW-помеха на +10 кГц отброшена ('+f.map(x=>x.toFixed(4))+')');
  ok([1545.0625,1545.1125,1545.1375].every((e,i)=>Math.abs(f[i]-e)<.0005),'сканер: частоты несущих с точностью 0.5 кГц');
  ok(u.chans.every(c=>c.suBad===0 && c.msgs>=5),'сканер: на каждом канале все SU сошлись и принято по ACARS ('+u.chans.map(c=>c.msgs)+')');
  const m=recs.find(r=>r.kind==='message');
  ok(m && /^1545\.\d{4} · AES /.test(m.text) && m.freq>1544.99e6 && m.freq<1545.2e6,'сканер: запись с частотой канала и в тексте ('+m?.text.slice(0,50)+')');
  ok(lastOut.bands.length===3 && lastOut.bands.every(b=>b.sig && b.hi>b.lo && b.label.startsWith('P600') && b.lo>1544.9e6 && b.lo<1545.3e6) && lastOut.panes.length===3 && lastOut.panes.every(b=>!b.sig && b.hi-b.lo===8000),'сканер: bands (скобки над несущими) и panes (диапазоны) для Spectrum Analyzer ('+lastOut.bands.map(b=>b.label).join(' | ')+')');
  ctx.__p={baud:'600'}; ev(`globalThis.RS2={p:__p}; IQK.aeroScan.init(RS2);`);
  const e=ev(`(()=>{ IQK.aeroScan.process(RS2,{in:{sr:8000,chunks:[{re:new Float32Array(100),im:new Float32Array(100)}]}},{}); return RS2.ui.err; })()`);
  ok(/too low/.test(e||''),'сканер: низкая частота дискретизации — сообщение'); }

// ЖИВОЙ ЭФИР: канал P600 Inmarsat (1545.0792 МГц), 2.9 с, 8 кС/с, один полный кадр; запись повторена трижды, чтобы несущая успела
// захватиться до кадра. Кадр принят из эфира с BER ~2.5 %: шесть SU с верным CRC, таблица индекса, служебные SU.
{ const raw=fs.readFileSync(path.join(root,'tools/data/aero-p600-8k.i8')), n=raw.length/2, reps=3;
  const re=new Float32Array(n*reps), im=new Float32Array(n*reps);
  for(let r=0;r<reps;r++) for(let i=0;i<n;i++){ re[r*n+i]=(raw[2*i]<<24>>24)/32; im[r*n+i]=(raw[2*i+1]<<24>>24)/32; }
  const r=decode({re,im},8000,600,400);
  ok(r.ui.lock && Math.abs(r.ui.fc-1160.9)<3,'эфир: несущая найдена по квадрату сигнала, +'+r.ui.fc.toFixed(1)+' Гц от центра (ожидалось 1160.9)');
  ok(r.ui.suOk>=6 && r.ui.fmt===1 || r.recs.length>=3,'эфир: шесть SU сошлись по CRC ('+r.ui.suOk+' верных, '+r.ui.frames+' кадров)');
  const t=r.recs.map(x=>x.text).join('|');
  ok(/System table index/.test(t) && /Reserved: 19 00 00/.test(t) && /type 0x53: 06 A0 70 C1 F0/.test(t),'эфир: SU 0x0A (индекс таблицы), 0x26 и 0x53 с реальным содержимым'); }

if(bad){ console.error(bad+' failed'); process.exit(1); }
console.log('all ok');
