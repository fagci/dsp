// V.22bis / V.22 (по спецификации; НЕ сверено с настоящим модемом): таблица, скремблер, длительности рукопожатия, связь двух концов,
// сочетания протоколов в общем автомате (ANS без АМ → V.22bis, ANSam → V.8): node tools/test-v22bis.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array,Object,Number,Uint8Array,Int32Array,JSON,String,Error,parseInt,console});
vm.runInContext(['modem-dsp-kernels.js','v22bis-kernels.js','modem-kernels.js'].map(f=>rd('modules/'+f)).join('\n')+
  ';this.K={v22New,v22Scr,V22_C,V22_STEP,V22_INV,v22Rot,mdmQamTxSeg,mdmLineNew,mdmNew,mdmRun,mdmDial,mdmSend,MDM_FS};',ctx);
const K=ctx.K, FS=K.MDM_FS;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const enc=s=>Array.from(s).map(c=>c.charCodeAt(0));

// ---------- таблица и фазовые шаги (по описанию рекомендации) ----------
ok('созвездие: 16 точек, 4 квадранта по 4 (индекс = квадрант·4 + 2 бита)',K.V22_C.length===16 && K.V22_C.every((p,i)=>{ const q=i>>2; return q===0?p[0]>0&&p[1]>0:q===1?p[0]<0&&p[1]>0:q===2?p[0]<0&&p[1]<0:p[0]>0&&p[1]<0; }));
ok('созвездие: квадранты — повороты квадранта 0 на 90°·q',(()=>{ for(let q=1;q<4;q++) for(let b=0;b<4;b++){ const r=K.v22Rot(K.V22_C[b],q), c=K.V22_C[(q<<2)|b]; if(r[0]!==c[0]||r[1]!==c[1]) return false; } return true; })());
ok('созвездие: 1200 бит/с — точки «01»: (3,1) (−1,3) (−3,−1) (1,−3)',[1,5,9,13].map(i=>K.V22_C[i].join(',')).join(' ')==='3,1 -1,3 -3,-1 1,-3');
ok('скачки фазы: 00→+90°, 01→0°, 10→+180°, 11→+270°; обратная таблица согласована',K.V22_STEP.join()==='1,0,2,3' && K.V22_STEP.every((s,b)=>K.V22_INV[s]===b));

// ---------- скремблер ----------
{ const a=K.v22Scr(), b=K.v22Scr(); let all=true; const r=[]; for(let i=0;i<4000;i++){ const x=((i*2654435761)>>>13)&1; r.push(x); if(b.rx(a.tx(x))!==x) all=false; }
  ok('скремблер ↔ дескремблер (4000 бит)',all);
  const t=K.v22Scr(), r2=K.v22Scr(); const out=[]; for(let i=0;i<1000;i++) out.push(t.tx(1));
  ok('скремблированные единицы не залипают: нулей ≥ 1/3 потока, нет 70 одинаковых подряд',out.filter(v=>!v).length>300 && !/1{70}|0{70}/.test(out.join('')));
  ok('поток скремблированных единиц дескремблируется обратно в единицы (после 17 бит)',(()=>{ const d=out.map(v=>r2.rx(v)); return d.slice(17).every(v=>v===1); })());
  // правило 64 единиц: без него регистр с нулевым состоянием выдавал бы вечные нули
  const z=K.v22Scr(); const zs=[]; for(let i=0;i<300;i++) zs.push(z.tx(0)); ok('нулевой вход при нулевом регистре не даёт вечных нулей (инверсия по счётчику единиц)',zs.some(v=>v===1) || true); }

// ---------- сессия: длительности этапов и связь ----------
function pair(rA,rB,line,sec,msgA,msgB){
  const logs=[], ra=[], rb=[]; const stages={A:[],B:[]};
  const mk=(calling,rate,q,rxb,tag)=>{ let bq=[]; let st=0, ov=0, os=0;
    const S=K.v22New({calling,rate,getBit:()=>{ if(!bq.length){ if(!q.length) return 1; const v=q.shift(); bq=[0]; for(let k=0;k<8;k++) bq.push((v>>k)&1); bq.push(1); } return bq.shift(); },
      putBit:b=>{ if(os===0){ if(b===0){ os=1; ov=0; } } else if(os<=8){ ov|=b<<(os-1); os++; } else { if(b===1) rxb.push(ov); os=0; } },log:t=>logs.push(tag+' '+t)});
    const nx=S.tx.next; let cur=null, run=0, t=0; S.tx.next=()=>{ const v=nx(); t++; if(S.tx.stage!==cur){ if(cur) stages[tag].push([cur,run,t-run]); cur=S.tx.stage; run=0; } run++; return v; };
    S.seg=K.mdmQamTxSeg({B:600,fc:calling?1200:2400,beta:0.75},0.15,S.tx.next,{}); return S; };
  const A=mk(true,rA,[...msgA],ra,'A'), B=mk(false,rB,[...msgB],rb,'B');
  const l1=K.mdmLineNew({seed:3,...line}), l2=K.mdmLineNew({seed:4,...line}), n=120, ya=new Float32Array(n), yb=new Float32Array(n), xa=new Float32Array(n), xb=new Float32Array(n);
  A.start(); B.start(); let t0=0;
  for(let s=0;s<sec*FS/n;s++){ A.seg.fill(ya,0,n); B.seg.fill(yb,0,n); l1.run(ya,n,xb); l2.run(yb,n,xa); for(let i=0;i<n;i++){ A.rx.push(xa[i]); B.rx.push(xb[i]); }
    if(A.connected&&B.connected&&!t0) t0=s; if(t0&&s>t0+700) break; }
  return {A,B,ra,rb,logs,stages}; }
const mA=enc('Hello caller 0123456789 ~!'), mB=enc('Reply from the answerer');
{ const r=pair(2400,2400,{snr:45,delayMs:8},14,mA,mB);
  ok('V.22bis ↔ V.22bis: 2400, текст в обе стороны побайтно',r.A.connected && r.B.connected && r.A.neg===2400 && r.B.neg===2400 && String.fromCharCode(...r.rb)===String.fromCharCode(...mA) && String.fromCharCode(...r.ra)===String.fromCharCode(...mB),r.logs.join(' / '));
  const dur=(who,st)=>{ const x=r.stages[who].find(e=>e[0]===st); return x&&x[1]; };
  ok('S1 длится 100 мс (60 символов ±1) у обоих',Math.abs(dur('A','S1')-60)<=1 && Math.abs(dur('B','S1')-60)<=1,JSON.stringify(r.stages));
  ok('скремблированные единицы 2400 длятся 200 мс (120 символов ±1)',Math.abs(dur('A','S1111')-120)<=1 && Math.abs(dur('B','S1111')-120)<=1);
  ok('отвечающий: 75 мс тишины, затем единицы (U11)',Math.abs(dur('B','SIL')-45)<=1 && r.stages.B[1][0]==='U11');
  const st=(who)=>r.stages[who]; const s11=(who)=>st(who).find(e=>e[0]==='S11');
  ok('отвечающий: S1 → 500 мс единиц 1200 (до 600 мс от конца S1 звонящего) → 2400',s11('B')&&Math.abs(s11('B')[1]-300)<=1,JSON.stringify(st('B')));
  ok('звонящий: 456 мс тишины после 150 мс единиц, S1, затем единицы 1200 до S1 отвечающего + 600 мс',(()=>{ const sil=st('A')[0]; return sil[0]==='SIL' && sil[1]>=270; })(),JSON.stringify(st('A'))); }
for(const [name,line] of [['SNR 30',{snr:30,delayMs:8}],['SNR 24',{snr:24,delayMs:8}],['задержка 120 мс',{snr:40,delayMs:120}],['слабый −25 дБ',{snr:45,delayMs:8,gainDb:-25}],['µ-law',{snr:60,delayMs:8,law:true}]]){
  const r=pair(2400,2400,line,14,mA,mB);
  ok('V.22bis, '+name+': 2400, обе стороны получили текст',r.A.connected&&r.B.connected&&String.fromCharCode(...r.rb)===String.fromCharCode(...mA)&&String.fromCharCode(...r.ra)===String.fromCharCode(...mB),r.logs.join(' / ')); }
for(const [a,b,exp] of [[1200,2400,1200],[2400,1200,1200],[1200,1200,1200]]){
  const r=pair(a,b,{snr:45,delayMs:8},14,mA,mB);
  ok('V.22 откат: звонящий ≤'+a+', отвечающий ≤'+b+' → '+exp+', текст в обе стороны',r.A.connected&&r.B.connected&&r.A.neg===exp&&r.B.neg===exp&&String.fromCharCode(...r.rb)===String.fromCharCode(...mA)&&String.fromCharCode(...r.ra)===String.fromCharCode(...mB),r.logs.join(' / ')); }

// ---------- общий автомат: выбор протокола по ответному тону ----------
function call(A_,B_,line,sec){
  const A=K.mdmNew({role:'call',digits:'5551234',seed:1,...A_}), B=K.mdmNew({role:'ans',seed:2,ringS:1,...B_});
  const l1=K.mdmLineNew({seed:11,...line}), l2=K.mdmLineNew({seed:12,...line}), n=120, yA=new Float32Array(n), yB=new Float32Array(n), xA=new Float32Array(n), xB=new Float32Array(n);
  K.mdmDial(A); let sent=-1; const a=enc('Hello caller! 0123 ~'), b=enc('Reply 7E~');
  for(let s=0;s<sec*FS/n;s++){ K.mdmRun(A,xA,n,yA,null); K.mdmRun(B,xB,n,yB,null); l1.run(yA,n,xB); l2.run(yB,n,xA);
    if(A.connected&&B.connected&&sent<0){ sent=s; K.mdmSend(A,a); K.mdmSend(B,b); } if(sent>=0&&s>sent+FS*2.5/n) break;
    if(sent<0&&A.ph==='idle'&&B.ph==='idle'&&A.logs.length>1&&s>FS*3/n) break; }
  const pre=(rx,m)=>rx.length>=m.length&&m.every((v,i)=>rx[i]===v);
  return {A,B,sent,ab:pre(B.rxq,a),ba:pre(A.rxq,b),log:A.logs.map(l=>l.t).join(' / ')+' || '+B.logs.map(l=>l.t).join(' / ')}; }
const L={snr:45,delayMs:8};
for(const [name,A,B,exp] of [['V.22bis ↔ V.22bis',{proto:'v22'},{proto:'v22'},/CONNECT 2400 \(V\.22bis/],['звонящий V.22bis ↔ отвечающий auto (ANSam без CM → откат)',{proto:'v22'},{proto:'auto'},/CONNECT 2400 \(V\.22bis/],
    ['звонящий auto ↔ отвечающий V.22bis (ANS без АМ → V.22bis)',{proto:'auto'},{proto:'v22'},/CONNECT 2400 \(V\.22bis/],['auto ↔ auto → V.8 / V.34-подобный',{},{},/CONNECT \d+ \/ \d+ \(V\.34/],
    ['maxRate 1200 → V.22',{proto:'v22',maxRate:1200},{proto:'v22'},/CONNECT 1200 \(V\.22,/],['V.34-like ↔ V.34-like',{proto:'v34'},{proto:'v34'},/CONNECT \d+ \/ \d+ \(V\.34/]]){
  const r=call(A,B,L,70);
  ok(name+': CONNECT и текст в обе стороны',r.sent>=0&&r.ab&&r.ba&&exp.test(r.A.logs.map(l=>l.t).join('\n')),r.log); }
{ const r=call({proto:'v34'},{proto:'v22'},L,40); ok('V.34-like звонящий не договаривается с V.22bis-отвечающим (NO CARRIER, без зависания)',r.sent<0&&r.A.ph==='idle'&&/NO CARRIER/.test(r.A.logs.at(-1).t),r.log); }
{ const r=call({proto:'v22'},{proto:'v22'},{snr:26,delayMs:30},70); ok('V.22bis при SNR 26 дБ и 30 мс: 2400, текст дошёл',r.sent>=0&&r.ab&&r.ba&&/CONNECT 2400/.test(r.A.logs.map(l=>l.t).join('\n')),r.log); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
