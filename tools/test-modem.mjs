// Модем (V.8 / V.34-подобный): сигналы и сообщения «собрали → разобрали», QAM-тракт, полный звонок двух модемов через линию,
// блоки приложения (Modem + Telephone Line): node tools/test-modem.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const base={Math,Float32Array,Float64Array,Array,Object,Number,Uint8Array,Int32Array,JSON,String,Error,parseInt,console};
const ctx=vm.createContext({...base});
vm.runInContext(rd('modules/modem-dsp-kernels.js')+'\n'+rd('modules/v22bis-kernels.js')+'\n'+rd('modules/modem-kernels.js')+
  ';this.K={mdmNew,mdmRun,mdmDial,mdmSend,mdmHang,mdmLineNew,mdmRng,mdmCrc16,mdmCrc8,mdmFskRxNew,mdmFskSeg,mdmInfoBits,mdmCmBits,mdmOctBits,mdmProbeSeg,mdmProbeRxNew,mdmPlan,mdmTones,mdmAnsam,mdmCfg,mdmQamTxSeg,mdmQamRxNew,mdmQamMap,mdmScr,mdmPnSyms,mdmLfsr,mdmLfsr16,mdmQpsk,mdmB1Syms,mdmBankNew,mdmResamp,mdmBitsFor,mdmSymsOf,MDM_FS,MDM_SYNC,MDM_ME,MDM_MB,MDM_PNSEED,MDM_PROBE_A,MDM_LVL,MDM_ROWS,MDM_COLS,MDM_KEYS};',ctx);
const K=ctx.K, FS=K.MDM_FS;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const enc=s=>Array.from(s).map(c=>c.charCodeAt(0));
const eq=(a,b)=>JSON.stringify(Array.from(a))===JSON.stringify(Array.from(b));
const fill=(seg,n)=>{ const x=new Float32Array(n); seg.fill(x,0,n); return x; };
const pad=(x,pre,post)=>{ const o=new Float32Array(pre+x.length+post); o.set(x,pre); return o; };

// ---------- контрольные значения ----------
ok('CRC-16/CCITT-FALSE check value 0x29B1',K.mdmCrc16(enc('123456789'))===0x29B1);
{ const b=K.mdmCmBits(0x45,true);
  ok('V.8 CM: 10 единиц, затем октет 0xE0 (старт 0, биты от младшего, стоп 1), 0xC1, 0x45',b.join('').startsWith('1111111111'+'0'+'00000111'+'1'+'0'+'10000011'+'1'+'0'+'10100010'+'1'),b.join('')); }

// ---------- V.21 FSK: сообщения V.8 и INFO, CJ ----------
function fskRun(ch,bits,amp,snr,seed){
  const rnd=K.mdmRng(seed||3), seg=K.mdmFskSeg(bits,ch,amp,{}), n=bits.length*40, x=pad(fill(seg,n),2400,2400), ev=[]; const rx=K.mdmFskRxNew(ch,e=>ev.push(e));
  const sg=Math.sqrt(2*amp*amp/2*Math.pow(10,-snr/10)*40/20);   // σ шума: SNR по мощности тона, оценка грубая
  for(let i=0;i<x.length;i++){ const u=Math.max(rnd(),1e-12), v=rnd(); rx.push(x[i]+(snr<200?sg*Math.sqrt(-2*Math.log(u))*Math.cos(6.2831853*v):0)); }
  return ev; }
for(const ch of [1,2]){
  const ev=fskRun(ch,K.mdmCmBits(0x45,true).concat(K.mdmCmBits(0x45,true)),0.2,300);
  const v8=ev.filter(e=>e.t==='V8');
  ok('FSK канал '+ch+': CM ×2 → два V8, call function 6 (данные), модуляция 0x45 (V.34)',v8.length===2 && v8.every(e=>e.cf===6 && e.mod===0x45),JSON.stringify(ev)); }
{ const rnd=K.mdmRng(9); let all=true;
  for(let t=0;t<20;t++){ const len=1+Math.floor(rnd()*10), d=Array.from({length:len},()=>Math.floor(rnd()*256));
    const ev=fskRun(1+(t&1),K.mdmInfoBits(d),0.2,t<10?300:30,t+1), inf=ev.filter(e=>e.t==='INFO');
    if(!(inf.length===1 && eq(inf[0].d,d))){ all=false; console.log('  INFO',t,len,JSON.stringify(ev).slice(0,200)); } }
  ok('INFO: 20 случайных кадров (до 10 байт, часть с шумом SNR 30 дБ) → CRC верна, поля совпали',all); }
{ const bits=K.mdmInfoBits([1,1,168,31]); bits[40]^=1;
  ok('INFO: перевёрнутый бит → кадр отброшен (CRC)',!fskRun(1,bits,0.2,300).some(e=>e.t==='INFO')); }
ok('CJ: три октета 0x00 после захвата',(()=>{ const b=K.mdmCmBits(0x45,true).concat(K.mdmOctBits([0,0,0],false)); const ev=fskRun(1,b,0.2,300); return ev.some(e=>e.t==='CJ'); })());
ok('FSK-приёмник молчит на тишине и на тоне ANSam',(()=>{ const rx=K.mdmFskRxNew(1,e=>{ if(e.t!=='SYNC') ev.push(e); }), ev=[]; const a=fill(K.mdmAnsam(1500,0.2,{}),FS*1.5); for(const v of a) rx.push(v); for(let i=0;i<FS;i++) rx.push(0); return ev.length===0; })());

// ---------- DTMF и ANSam между двумя автоматами ----------
{ const A=K.mdmNew({role:'call',digits:'07*#A1B9',dialToneMs:300}), B=K.mdmNew({role:'ans',ringS:.5});
  K.mdmDial(A); const n=120, ya=new Float32Array(n), yb=new Float32Array(n), xa=new Float32Array(n), xb=new Float32Array(n);
  let ans=-1; for(let s=0;s<FS*12/n && ans<0;s++){ K.mdmRun(A,xa,n,ya,null); K.mdmRun(B,xb,n,yb,null); xb.set(ya); xa.set(yb); if(B.ph==='ansam' && A.ansN>=8) ans=s; }
  ok('DTMF: отвечающий принял набранные цифры 07*#A1B9 (все 16 клавиш допустимы)',B.dt.digits==='07*#A1B9',B.dt.digits);
  ok('ANSam: отвечающий поднял трубку после звонка, звонящий принял тон 2100 Гц',ans>=0); }
{ const x=fill(K.mdmAnsam(1500,0.2,{}),FS*1.5); const b=K.mdmBankNew([2100,1800,2400],240); let p=null; for(const v of x) if(b.push(v)) p=Array.from(b.p);
  ok('ANSam: энергия на 2100 Гц, не на соседних',p[0]>10*p[1] && p[0]>10*p[2]); }
{ const x=fill(K.mdmAnsam(1500,0.2,{}),FS*1.5), fr=[]; let s=0; const b=K.mdmBankNew([2100],480); // огибающая: 15 Гц АМ, 20 %
  let mx=0; for(let i=0;i<x.length;i++) mx=Math.max(mx,Math.abs(x[i])); ok('ANSam: пик = уровень × (1 + 20 % АМ)',mx<=0.2*1.2+1e-6 && mx>0.2*1.15,mx); }

// ---------- QAM: преамбула, обучение, данные ----------
function qamLink(bi,ci,b,line,seed){
  const cfg=K.mdmCfg(bi,ci), NS=160, Ntr=640, pn=K.mdmPnSyms(K.MDM_PNSEED,Ntr), fillg=K.mdmLfsr16(0xACE1), rnd=K.mdmRng(seed||1), map=K.mdmQamMap(b), scr=K.mdmScr(18), sent=[], q=[];
  for(let k=0;k<NS;k++) q.push([(k&1)?-1:1,0]); for(const s of K.MDM_SYNC) q.push(s); for(const s of pn) q.push(s);
  for(let i=0;i<300;i++) q.push(K.mdmQpsk(fillg(),fillg()));
  for(const s of K.MDM_MB) q.push(s); for(const s of K.mdmB1Syms(true,b)) q.push(s);
  for(let i=0;i<60;i++) q.push(K.mdmQpsk(fillg(),fillg())); for(const s of K.MDM_ME) q.push(s);
  for(let i=0;i<4000;i++){ let v=0; for(let k=0;k<b;k++){ const bit=rnd()<.5?1:0; sent.push(bit); v=(v<<1)|scr.tx(bit); } q.push(map.map(v)); }
  for(let i=0;i<40;i++) q.push([0,0]);
  let qi=0; const seg=K.mdmQamTxSeg(cfg,0.15,()=>qi<q.length?q[qi++]:null,{}), tot=Math.ceil(q.length*FS/cfg.B)+3000, tx=new Float32Array(tot), n=seg.fill(tx,0,tot);
  const xin=new Float32Array(tot+4000); xin.set(tx.subarray(0,n),2000); const y=new Float32Array(xin.length); K.mdmLineNew(line).run(xin,xin.length,y);
  const got=[]; let verdict=null, b1=null, marker=false, rx; rx=K.mdmQamRxNew(cfg,{NS,Ntr,scr:()=>K.mdmScr(18)},{verdict:v=>{ verdict=v; rx.setB(b); },b1:v=>{ b1=v; },marker:()=>{ marker=true; },data:bit=>got.push(bit)});
  for(let i=0;i<y.length;i++) rx.push(y[i]);
  let best=1e9, off=0; for(let o=0;o<Math.min(100,got.length-1000);o++){ let e=0; for(let i=0;i<1000;i++) if(got[o+i]!==sent[i]) e++; if(e<best){ best=e; off=o; } }
  let errs=0; for(let i=0;i<sent.length;i++) if(got[off+i]!==sent[i]) errs++;
  return {verdict,b1,marker,errs,n:sent.length,st:rx.st}; }
for(const [bi,ci,b] of [[0,1,4],[0,0,8],[1,1,6],[2,1,10],[3,1,8],[4,0,6]]){
  const cfg=K.mdmCfg(bi,ci), r=qamLink(bi,ci,b,{snr:60,delayMs:9,seed:4});
  ok('QAM '+Math.round(cfg.B)+' бод / '+cfg.fc+' Гц, '+b+' бит/символ: преамбула → обучение → B1 → данные без ошибок',r.verdict&&r.verdict.ok && r.b1&&r.b1[0]===0xB1&&(r.b1[1]&15)===b && r.marker && r.errs===0,JSON.stringify(r)); }
{ const lo=qamLink(0,1,6,{snr:28,delayMs:9}), hi=qamLink(0,1,6,{snr:46,delayMs:9});
  ok('QAM: измеренный SNR обучения следует за SNR линии (28 дБ → ≈26–31, 46 дБ → > 38)',lo.verdict.snr>24 && lo.verdict.snr<32 && hi.verdict.snr>38,lo.verdict.snr+' '+hi.verdict.snr); }
{ const r=qamLink(0,1,4,{snr:5,delayMs:9});
  ok('QAM: при SNR линии 5 дБ вердикт «не годится» (ok = false)',r.verdict && !r.verdict.ok,JSON.stringify(r.verdict)); }
ok('QAM: полоса 600–2300 Гц и задержка 40 мс — 2400 бод, 4 бита, без ошибок',(()=>{ const r=qamLink(0,0,4,{snr:50,lo:600,hi:2300,delayMs:40}); return r.verdict&&r.verdict.ok&&r.errs===0; })());
ok('QAM: преамбула не найдена в тишине (без падения)',(()=>{ const cfg=K.mdmCfg(0,1); let ev=null; const rx=K.mdmQamRxNew(cfg,{NS:160,Ntr:640,scr:()=>K.mdmScr(18)},{verdict:v=>{ ev=v; }}); const r=K.mdmRng(2); for(let i=0;i<FS*2;i++) rx.push((r()-.5)*0.01); return ev===null && rx.st==='listen'; })());
{ const a=K.mdmQamMap(8), p=[0,1,17,100,255].map(v=>a.slice(...a.map(v))); ok('QAM: отображение ↔ срез (256 точек, код Грея)',p.every((q,i)=>q.v===[0,1,17,100,255][i]) && (()=>{ for(let v=0;v<256;v++){ const [re,im]=a.map(v); if(a.slice(re,im).v!==v) return false; } return true; })());
  ok('QAM: средняя мощность созвездия 1 при 4…12 битах',[4,5,6,7,8,9,10,11,12].every(b=>{ const m=K.mdmQamMap(b); let s=0; for(let v=0;v<(1<<b);v++){ const [re,im]=m.map(v); s+=re*re+im*im; } return Math.abs(s/(1<<b)-1)<1e-6; })); }
{ const tx=K.mdmScr(18), rx=K.mdmScr(18), r=K.mdmRng(5); let all=true; for(let i=0;i<5000;i++){ const b=r()<.5?1:0; if(rx.rx(tx.tx(b))!==b) all=false; } ok('скремблер ↔ дескремблер',all);
  const t2=K.mdmScr(5), r2=K.mdmScr(5); let a2=true; for(let i=0;i<2000;i++){ const b=(i%7)&1; if(r2.rx(t2.tx(b))!==b) a2=false; } ok('скремблер 1+x⁻⁵+x⁻²³ ↔ дескремблер',a2); }

// маркеры B1 / ME не должны встречаться в заполнителе, ПСП обучения и синхрослове (иначе приёмник ложно «находит» B1 в длинном заполнителе)
{ const q=s=>(s[0]<0?2:0)|(s[1]<0?1:0), strm=(gen,n)=>{ const o=[]; for(let i=0;i<n;i++){ const a=gen(), b=gen(); o.push((a?2:0)|(b?1:0)); } return o; };
  const mind=(m,st)=>{ let best=99; for(let i=0;i+16<=st.length;i++){ let d=0; for(let k=0;k<16&&d<best;k++) if(st[i+k]!==m[k]) d++; if(d<best) best=d; } return best; };
  const fillS=strm(K.mdmLfsr16(0xACE1),140000), pnS=strm(K.mdmLfsr(K.MDM_PNSEED),70000), syncS=K.MDM_SYNC.map(q);
  const mb=K.MDM_MB.map(q), me=K.MDM_ME.map(q);
  ok('маркеры B1 и ME: ≥ 4 символов от любого окна заполнителя (2 периода), ПСП и синхрослова; детектор допускает 2',Math.min(mind(mb,fillS),mind(me,fillS),mind(mb,pnS),mind(me,pnS),mind(mb,syncS),mind(me,syncS))>=4);
  ok('маркеры B1 и ME различаются (≥ 8 из 16 символов)',(()=>{ let d=0; for(let i=0;i<16;i++) if(mb[i]!==me[i]) d++; return d>=8; })()); }

// ---------- зондирование и выбор скорости ----------
function probe(line){
  const seg=K.mdmProbeSeg(480,K.MDM_PROBE_A,{}), n=Math.round(0.48*FS), x=pad(fill(seg,n),3000,3000), y=new Float32Array(x.length); K.mdmLineNew(line).run(x,x.length,y);
  let res; const pr=K.mdmProbeRxNew(r=>{ res=r; }); for(let i=0;i<y.length;i++) pr.push(y[i]); return res; }
{ const good=K.mdmPlan(probe({snr:45,delayMs:5}),33600,31), mid=K.mdmPlan(probe({snr:30,delayMs:5}),33600,31), narrow=K.mdmPlan(probe({snr:45,lo:700,hi:2200,delayMs:5}),33600,31), bad=K.mdmPlan(probe({snr:8,delayMs:5}),33600,31);
  ok('зондирование: хорошая линия → план с бодами и несущей',good && good.rate>20000,JSON.stringify(good));
  ok('зондирование: хуже SNR → скорость ниже',mid && mid.rate<good.rate,JSON.stringify([good,mid]));
  ok('зондирование: узкая полоса 700–2200 Гц → 2400 бод',narrow && narrow.bi===0,JSON.stringify(narrow));
  ok('зондирование: SNR 8 дБ → плана нет',bad===null,JSON.stringify(bad));
  ok('зондирование: оценка SNR близка к заданной (SNR 30 → 26…34 дБ)',mid && mid.snr>26 && mid.snr<34,mid&&mid.snr);
  ok('число бит по SNR: монотонно, потолок 12, при SNR 10 дБ — 0',[10,20,30,40,50,60].map(s=>K.mdmBitsFor(s,14)).every((b,i,a)=>i===0||b>=a[i-1]) && K.mdmBitsFor(90,14)===12 && K.mdmBitsFor(10,14)===0 && K.mdmBitsFor(60,3)===3); }

// ---------- полный звонок: два независимых модема через линию ----------
function call(opts,line,sec,hook){
  const A=K.mdmNew({role:'call',digits:'5551234',pace:opts.pace||1,seed:1,...(opts.A||{})}), B=K.mdmNew({role:'ans',pace:opts.pace||1,seed:2,ringS:1,...(opts.B||{})});
  const l1=K.mdmLineNew({seed:11,...line}), l2=K.mdmLineNew({seed:12,...line});
  const n=120, yA=new Float32Array(n), yB=new Float32Array(n), xA=new Float32Array(n), xB=new Float32Array(n);
  K.mdmDial(A); const mA=enc('Hello from caller. ').concat([0x7E,0x7D,0x00,0xFF],enc(' end')), mB=enc('Reply from answerer: 1234567890');
  let sent=-1, end=-1, hung=false;
  for(let s=0;s<sec*FS/n;s++){
    K.mdmRun(A,xA,n,yA,null); K.mdmRun(B,xB,n,yB,null); l1.run(yA,n,xB); l2.run(yB,n,xA);
    if(hook) hook(s,A,B,xA,xB,yA,yB,l1,l2);
    if(A.connected&&B.connected&&sent<0){ sent=s; K.mdmSend(A,mA); K.mdmSend(B,mB); end=s+Math.floor(2.5*FS/n); }
    if(opts.hang && sent>=0 && s===end){ K.mdmHang(A,'Hang up'); end=s+Math.floor(3*FS/n); hung=true; }
    if(end>=0 && s>end) break;
    if(sent<0 && A.ph==='idle' && B.ph==='idle' && A.logs.length>1 && B.logs.length>1 && s>FS*3/n) break; }
  const prefix=(rx,m)=>rx.length>=m.length && eq(rx.slice(0,m.length),m);
  return {A,B,connected:sent>=0,ab:prefix(B.rxq,mA),ba:prefix(A.rxq,mB),tConn:sent>=0?A.nowMs:0,rate:A.rate,rateB:B.rate}; }
const logs=r=>r.A.logs.map(l=>l.t).join(' / ')+' || '+r.B.logs.map(l=>l.t).join(' / ');
const R={};
for(const [name,line] of [['clean',{snr:45,delayMs:8}],['snr38',{snr:38,delayMs:8}],['snr32',{snr:32,delayMs:8}],['snr26',{snr:26,delayMs:8}],['snr20',{snr:20,delayMs:8}],
    ['narrow',{snr:45,lo:700,hi:2000,delayMs:8}],['delay80',{snr:45,delayMs:80}],['mulaw',{snr:60,delayMs:8,law:true}],['weak',{snr:45,delayMs:8,gainDb:-30}]]){
  const r=R[name]=call({},line,60);
  ok('звонок «'+name+'»: CONNECT, текст в обе стороны побайтно (в т. ч. 0x7E, 0x7D, 0x00, 0xFF)',r.connected && r.ab && r.ba,logs(r)); }
ok('скорость падает с качеством линии: чистая ≥ 38 дБ ≥ 32 дБ ≥ 26 дБ ≥ 20 дБ',['clean','snr38','snr32','snr26','snr20'].map(k=>R[k].rate.rx).every((v,i,a)=>i===0||v<=a[i-1]) && R.clean.rate.rx>R.snr20.rate.rx*2,['clean','snr38','snr32','snr26','snr20'].map(k=>R[k].rate.rx).join(' '));
ok('чистая линия: > 24000 бит/с, SNR 20 дБ: < 12000',R.clean.rate.rx>24000 && R.snr20.rate.rx<12000,R.clean.rate.rx+' '+R.snr20.rate.rx);
ok('узкая полоса 700–2000 Гц: 2400 бод, ниже чистой линии',R.narrow.rate.rx<R.clean.rate.rx && /2400/.test(R.narrow.A.logs.find(l=>/CONNECT/.test(l.t)).t),R.narrow.rate.rx);
ok('скорость обоих концов одинаково читается: CONNECT tx/rx у звонящего = rx/tx у отвечающего',R.clean.rate.tx===R.clean.rateB.rx && R.clean.rate.rx===R.clean.rateB.tx);
{ const r=call({},{snr:45,delayMs:8},60);
  const need=['Набор','ANSam','V.8: JM','INFO0','зондирую','Линия:','Обучение:','CONNECT'];
  ok('журнал звонящего содержит этапы в порядке: набор → ANSam → V.8 → INFO0 → зондирование → обучение → CONNECT',(()=>{ let i=0; for(const l of r.A.logs){ while(i<need.length && l.t.includes(need[i])) i++; } return i===need.length; })(),r.A.logs.map(l=>l.t).join(' / ')); }
{ const a=call({pace:1},{snr:45,delayMs:8},60), b=call({pace:3},{snr:45,delayMs:8},90);
  ok('pace 3 растягивает подключение (дольше, чем pace 1), результат тот же',b.connected && b.tConn>a.tConn+1000 && b.ab && b.ba,a.tConn+' '+b.tConn); }
{ const r=call({hang:true},{snr:45,delayMs:8},60);
  ok('положили трубку: звонящий idle, у отвечающего «несущая пропала» и idle',r.A.ph==='idle' && r.B.ph==='idle' && r.B.logs.some(l=>/несущая пропала/.test(l.t)),logs(r)); }
{ const r=call({},{snr:45,delayMs:8,gainDb:-90},45);
  ok('линия мертва: NO ANSWER или NO CARRIER, оба модема возвращаются в idle',!r.connected && r.A.ph==='idle' && /NO (ANSWER|CARRIER)/.test(r.A.logs.at(-1).t),logs(r)); }
{ const r=call({},{snr:9,delayMs:8},60);
  ok('очень шумная линия (9 дБ): NO CARRIER / NO ANSWER, не зависает',!r.connected && r.A.ph==='idle' && r.B.ph==='idle' && /NO (CARRIER|ANSWER)/.test(r.A.logs.at(-1).t),logs(r)); }
{ const r=call({B:{ringS:1}},{snr:45,delayMs:8},60,(s,A,B,xA,xB,yA,yB)=>{ });
  ok('номер: отвечающий принял все цифры звонящего',r.B.dt.digits==='5551234',r.B.dt.digits); }
{ let burst=0, hit=false;
  const r=call({},{snr:45,delayMs:8},60,(s,A,B,xA,xB)=>{ if(A.ph==='train' && !hit && A.pt>200){ hit=true; burst=Math.round(0.9*FS/120); } if(burst>0){ burst--; const g=K.mdmRng(s+1); for(let i=0;i<xB.length;i++){ xB[i]+=(g()-.5)*1.2; xA[i]+=(g()-.5)*1.2; } } });
  ok('помеха во время обучения → повторное обучение → всё равно CONNECT',r.connected && r.A.logs.some(l=>/Повторное обучение/.test(l.t)) && r.ab && r.ba,logs(r)); }
{ const r=call({A:{maxRate:14400},B:{maxRate:14400}},{snr:45,delayMs:8},60);
  ok('maxRate 14400 ограничивает скорость в обе стороны',r.connected && r.rate.rx<=14400 && r.rate.tx<=14400 && r.ab && r.ba,r.rate.rx+' '+r.rate.tx); }
{ const r=call({A:{maxRate:9600},B:{maxRate:33600}},{snr:45,delayMs:8},60);
  ok('разные maxRate у сторон: принимается наименьший',r.connected && r.rate.rx<=9600 && r.rate.tx<=9600 && r.rateB.rx<=9600,r.rate.rx+' '+r.rate.tx+' '+r.rateB.rx+' '+r.rateB.tx); }
{ const r=call({A:{bmask:1},B:{bmask:3}},{snr:45,delayMs:8},60);
  ok('маски символьных скоростей пересекаются: только 2400 бод',r.connected && r.A.logs.some(l=>/2400 \/ 2400 бод/.test(l.t)),logs(r)); }
{ const r=call({A:{bmask:1},B:{bmask:2}},{snr:45,delayMs:8},40);
  ok('маски не пересекаются: NO CARRIER «нет общей символьной скорости»',!r.connected && r.A.logs.some(l=>/нет общей/.test(l.t)),logs(r)); }

// ---------- блоки приложения: Modem + Telephone Line на частотах движка ----------
function appRun(sr,BLOCKN,lineP,sec){
  const defs={}; const c2=vm.createContext({...base,TextEncoder,TextDecoder,def:o=>{ defs[o.id]=o; },Eng:{sr},BLOCK:BLOCKN,buf:(n,name)=>{ n.b=n.b||{}; return n.b[name]||(n.b[name]=new Float32Array(BLOCKN)); }});
  vm.runInContext(rd('modules/modem-dsp-kernels.js')+'\n'+rd('modules/v22bis-kernels.js')+'\n'+rd('modules/modem-kernels.js')+'\n'+rd('modules/modem.js')+'',c2);
  const mk=(type,p)=>{ const d=defs[type], n={type,p:{},el:null,b:{}}; for(const q of d.params) if(q.d!==undefined) n.p[q.n]=q.d; Object.assign(n.p,p||{}); d.init&&d.init(n); return n; };
  const A=mk('modem',{role:'caller',number:'5551234',pace:1,autoDial:true,greet:'Hi from A\r\n'}), B=mk('modem',{role:'answerer',ringS:1,pace:1,greet:'Hi from B\r\n'}), L1=mk('phoneline',lineP), L2=mk('phoneline',lineP);
  const run=(n,I)=>defs[n.type].process(n,I);
  let oA={line:new Float32Array(BLOCKN)}, oB={line:new Float32Array(BLOCKN)}, o1={out:new Float32Array(BLOCKN)}, o2={out:new Float32Array(BLOCKN)}, rxA='', rxB='', spkPeak=0, cst=0, conn=-1, finite=true;
  for(let s=0;s<sec*sr/BLOCKN;s++){
    o1=run(L1,{in:oA.line}); o2=run(L2,{in:oB.line}); oA=run(A,{line:o2.out}); oB=run(B,{line:o1.out});
    if(oA.rx) rxA+=oA.rx; if(oB.rx) rxB+=oB.rx; for(const v of oA.spk) spkPeak=Math.max(spkPeak,Math.abs(v)); for(const v of oA.line) if(!Number.isFinite(v)) finite=false;
    if(oA.cI.some(v=>v!==0)) cst++;
    if(oA.connected&&oB.connected&&conn<0) conn=s; if(conn>=0 && s>conn+2*sr/BLOCKN) break; }
  return {A,B,rxA,rxB,spkPeak,cst,conn,finite,defs,rate:oA.rate,oA}; }
for(const [sr,bl] of [[48000,512],[44100,512],[16000,256]]){
  const r=appRun(sr,bl,{},60);
  ok('блок Modem + Telephone Line на '+sr+' Гц (блок '+bl+'): CONNECT, приветствия обеих сторон дошли',r.conn>=0 && r.rxB.includes('Hi from A') && r.rxA.includes('Hi from B') && r.finite,r.A.m.logs.map(l=>l.t).join(' / ')+' | rxA='+JSON.stringify(r.rxA)+' rxB='+JSON.stringify(r.rxB)); }
{ const r=appRun(48000,512,{lo:500,hi:2700,snr:29,delayMs:60,gainDb:-12,law:true},60);
  ok('плохая линия из пресета (500–2700 Гц, SNR 29 дБ, 60 мс) на блоках приложения: CONNECT, скорость ≤ 15000, приветствия дошли',r.conn>=0 && r.rate>=4000 && r.rate<=15000 && r.rxB.includes('Hi from A') && r.rxA.includes('Hi from B'),r.A.m.logs.map(l=>l.t).join(' / ')+' '+r.rate); }
{ const r=appRun(48000,512,{},60);
  ok('динамик слышен до CONNECT, затем гаснет; в созвездие шли точки; выход rate = скорость приёма',r.spkPeak>0.05 && r.cst>20 && r.rate===r.A.m.rate.rx && r.rate>5000,r.spkPeak+' '+r.cst+' '+r.rate); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
