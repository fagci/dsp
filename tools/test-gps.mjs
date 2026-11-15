// Ядро GPS L1 C/A: node tools/test-gps.mjs  (весь круг: синтетический эфир → поиск → слежение → биты → эфемериды → позиция)
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'modules/gps-kernels.js'),'utf8')+';this.K={gpsCA,gpsFFT,gpsParity,gpsBuildSubframe,gpsParseSubframe,gpsQuantize,gpsFindFrames,gpsEphAdd,gpsSatPos,gpsGeo2Ecef,gpsEcef2Geo,gpsElAz,gpsSolve,gpsDemoEph,gpsAcquire,gpsTrackNew,gpsTrackPush,gpsBitSync,gpsChannelNav,gpsPseudoranges,gpsSynth,gpsDelay,GPS_C,GPS_SF};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// --- C/A-коды: первые 10 чипов (восьмеричное из ICD), баланс, корреляции
const oct=prn=>{ const c=K.gpsCA(prn); let v=0; for(let i=0;i<10;i++) v=v*2+(c[i]<0?1:0); return v.toString(8); };
ok('PRN 1…5: первые 10 чипов по ICD = 1440 1620 1710 1744 1133',[1,2,3,4,5].map(oct).join(' ')==='1440 1620 1710 1744 1133',[1,2,3,4,5].map(oct).join(' '));
{ let allOk=true, balOk=true, xOk=true; const seen=new Set();
  for(let p=1;p<=32;p++){ const c=K.gpsCA(p); let ones=0; for(const v of c) if(v<0) ones++; if(ones!==512) balOk=false; seen.add(Array.from(c).join(''));
    for(const q of [p%32+1]){ const d=K.gpsCA(q); for(const sh of [0,17,500]){ let s=0; for(let i=0;i<1023;i++) s+=c[i]*d[(i+sh)%1023]; if(![-65,-1,63].includes(s)) xOk=false; } }
    let a=0; for(let i=0;i<1023;i++) a+=c[i]*c[i]; if(a!==1023) allOk=false; for(const sh of [1,300,900]){ let s=0; for(let i=0;i<1023;i++) s+=c[i]*c[(i+sh)%1023]; if(![-65,-1,63].includes(s)) allOk=false; } }
  ok('все 32 кода: 512 единиц на 1023, автокорреляция 1023 / боковые из {−65,−1,63}',allOk&&balOk); ok('перекрёстная корреляция соседних PRN — только {−65,−1,63}',xOk); ok('32 разных кода',seen.size===32); }

// --- FFT
{ const n=64, re=new Float64Array(n), im=new Float64Array(n); for(let i=0;i<n;i++) re[i]=Math.sin(2*Math.PI*5*i/n); K.gpsFFT(re,im,false);
  ok('FFT: синус на 5 бине',Math.abs(im[5]+n/2)<1e-9&&Math.abs(re[1])<1e-9); K.gpsFFT(re,im,true); near('FFT: обратное возвращает сигнал',re[3],Math.sin(2*Math.PI*5*3/n),1e-9); }

// --- навигационное сообщение: «собрали → разобрали»
const TOE=1792; const eph=K.gpsDemoEph(7,TOE);
const bitsOf=id=>K.gpsBuildSubframe(Object.assign({},eph,{id,tow:301}));
{ const out={};
  for(const id of [1,2,3]){ const b=bitsOf(id), sf=K.gpsParseSubframe(b); out[id]=sf; ok('подкадр '+id+': разобрался, id и счётчик HOW сохранены',sf.ok&&sf.id===id&&sf.tow===301,JSON.stringify(sf).slice(0,120));
    let worst=0,names=[]; for(const [name] of K.GPS_SF[id]){ const d=Math.abs(sf[name]-eph[name]); if(d>0) { worst=Math.max(worst,d/(Math.abs(eph[name])||1)); names.push(name); } }
    ok('подкадр '+id+': все поля совпали с квантованными',names.length===0,names.join(',')); }
  const b=bitsOf(2); ok('последние два бита слов 2 и 10 нулевые (инвариант ICD)',b[58]===0&&b[59]===0&&b[298]===0&&b[299]===0);
  const inv=b.map(v=>v^1); const si=K.gpsParseSubframe(inv); ok('инвертированный поток (фаза ФАПЧ) разбирается так же',si.ok&&si.IODE2===out[2].IODE2&&si.M0===out[2].M0&&si.inv===1);
  const bad1=b.slice(); bad1[100]^=1; ok('один испорченный бит ловится чётностью',K.gpsParseSubframe(bad1).err==='parity');
  const fill=new Uint8Array(192).map((_,i)=>(i*7+3)%5<2?1:0); const s4=K.gpsParseSubframe(K.gpsBuildSubframe({id:4,tow:5,fill})); ok('подкадр 4/5 с заполнением: валидная чётность, id',s4.ok&&s4.id===4&&s4.tow===5);
  // поток: мусор 123 бита + 3 кадра, инвертирован
  const junk=new Uint8Array(123).map((_,i)=>(i*13+1)%3===0?1:0), st=new Uint8Array(123+900); st.set(junk); [1,2,3].forEach((id,k)=>st.set(bitsOf(id),123+300*k));
  const fr=K.gpsFindFrames(st.map(v=>v^1)); ok('поиск кадров в потоке: 3 кадра на позициях 123/423/723, полярность инвертирована',fr.length===3&&fr[0].pos===123&&fr[2].pos===723,fr.map(f=>f.pos).join());
  const store={}; for(const f of fr) K.gpsEphAdd(store,f.sf); ok('эфемерида собрана из трёх подкадров (IODC=IODE2=IODE3)',store.ready&&Math.abs(store.eph.sqrtA-eph.sqrtA)<1e-9&&store.eph.iode===37);
  const store2={}; K.gpsEphAdd(store2,fr[0].sf); K.gpsEphAdd(store2,fr[1].sf); ok('двух подкадров мало',!store2.ready); }

// --- орбита и координаты
{ const t=1800; let rmin=1e99,rmax=0; for(let s=0;s<24;s++){ const e=K.gpsDemoEph(s,TOE), p=K.gpsSatPos(e,t), r=Math.hypot(p.x,p.y,p.z); rmin=Math.min(rmin,r); rmax=Math.max(rmax,r); }
  ok('24 слота: радиус орбиты 26 400…26 700 км',rmin>26.4e6&&rmax<26.72e6,(rmin/1e3|0)+'…'+(rmax/1e3|0));
  const a=K.gpsSatPos(eph,t), b=K.gpsSatPos(eph,t+1); const v=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z); ok('скорость спутника в ECEF 2.5…4.2 км/с (инерциальная 3.87 минус/плюс вращение Земли)',v>2500&&v<4200,v.toFixed(0));
  const g=K.gpsGeo2Ecef(55.03,82.92,150), r=K.gpsEcef2Geo(...g); near('WGS84 туда-обратно: широта',r.lat,55.03,1e-9); near('…долгота',r.lon,82.92,1e-9); near('…высота, м',r.h,150,1e-4);
  const up=K.gpsElAz(g,[g[0]*2,g[1]*2,g[2]*2]); near('точка над головой: возвышение ~90°',up.el,90,0.2); }

// --- решение навигационной задачи (без сигналов): точные дальности + смещение часов 123 456 м
const rcv=K.gpsGeo2Ecef(55.03,82.92,150);
const visible=(()=>{ const out=[]; for(let s=0;s<24;s++){ const e=K.gpsDemoEph(s,TOE), p=K.gpsSatPos(e,1799), ea=K.gpsElAz(rcv,[p.x,p.y,p.z]); if(ea.el>12) out.push({slot:s,prn:s+1,eph:e,el:ea.el}); } return out.sort((a,b)=>b.el-a.el); })();
ok('над точкой видно ≥ 6 спутников',visible.length>=6,visible.length+' шт.');
{ const obs=visible.map(v=>{ const d=K.gpsDelay(v.eph,rcv,1800), s=K.gpsSatPos(v.eph,1800-d.tau); return {x:s.x,y:s.y,z:s.z,pr:d.tau*K.GPS_C+123456}; });
  const fix=K.gpsSolve(obs); ok('решение: сошлось',fix.ok&&fix.iters<=8,JSON.stringify(fix));
  near('позиция без шума: ошибка по X, м',fix.x,rcv[0],0.01); near('…по Y',fix.y,rcv[1],0.01); near('…по Z',fix.z,rcv[2],0.01); near('смещение часов приёмника, м',fix.cb,123456,0.01); ok('PDOP разумен (0.5…8)',fix.pdop>0.5&&fix.pdop<8,fix.pdop);
  ok('меньше 4 спутников — отказ',!K.gpsSolve(obs.slice(0,3)).ok); }

// --- синтетический эфир: поиск, слежение, декодирование, позиция
const FS=2.048e6, N=2048, SECONDS=+(process.env.GPS_SECONDS||19.3), TOW0=1799;
const use=visible.slice(0,6), cfg={fs:FS,tow0:TOW0,rcv,noise:5,seed:11,sats:use.map((v,i)=>({prn:v.prn,eph:v.eph,amp:1,phi:i,cycle:[1,2,3]}))};
const gen=K.gpsSynth(cfg);
console.log('спутники:',use.map(v=>'PRN'+v.prn+'('+v.el.toFixed(0)+'°)').join(' '),'· C/N0 ≈',(10*Math.log10(FS/(2*cfg.noise*cfg.noise))).toFixed(1),'дБ·Гц');
const T0=Date.now(); const head={re:new Float32Array(12*N),im:new Float32Array(12*N)};
for(let k=0;k<12;k++){ const b=gen.block(k); head.re.set(b.re,k*N); head.im.set(b.im,k*N); }
const acqs=[]; let missed=0,dErr=0,lErr=0;
for(const [i,v] of use.entries()){ const a=K.gpsAcquire(head,FS,v.prn,{ms:10}), ex=gen.expect(i); acqs.push(a);
  const dl=Math.min(Math.abs(a.lag-ex.lag),N-Math.abs(a.lag-ex.lag)); if(!a.found) missed++; dErr=Math.max(dErr,Math.abs(a.dopp-ex.dopp)); lErr=Math.max(lErr,dl);
  console.log('  PRN'+v.prn,'допплер',a.dopp.toFixed(0),'(правда',ex.dopp.toFixed(0)+')','задержка',a.lag,'(правда',ex.lag.toFixed(1)+')','отношение',a.ratio.toFixed(1)); }
ok('поиск: все 6 видимых найдены',missed===0); ok('допплер найден с точностью ≤ 30 Гц',dErr<=30,dErr.toFixed(1)); ok('задержка кода с точностью ≤ 1 отсчёта',lErr<=1.01,lErr.toFixed(2));
{ const absent=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32].filter(p=>!use.some(v=>v.prn===p)); let fa=0; let mx=0; for(const p of absent.slice(0,8)){ const r=K.gpsAcquire(head,FS,p,{ms:10}); mx=Math.max(mx,r.ratio); if(r.found) fa++; } ok('ложных находок среди 8 отсутствующих PRN нет (макс. отношение '+mx.toFixed(1)+', порог 5)',fa===0,fa); }
console.log('генерация + поиск:',((Date.now()-T0)/1000).toFixed(1),'с');

const chs=acqs.map((a,i)=>K.gpsTrackNew(use[i].prn,FS,a));
const nblk=Math.round(SECONDS*1000); const T1=Date.now();
for(let k=0;k<nblk;k++){ const b=k<12?{re:head.re.subarray(k*N,k*N+N),im:head.im.subarray(k*N,k*N+N)}:gen.block(k); for(const ch of chs) K.gpsTrackPush(ch,b); }
console.log('слежение за',nblk,'мс × 6 спутников:',((Date.now()-T1)/1000).toFixed(1),'с');
ok('все каналы набрали захват несущей (lock > 0.7)',chs.every(c=>c.lock>0.7),chs.map(c=>c.lock.toFixed(2)).join(' '));
ok('эпох столько, сколько миллисекунд (±3)',chs.every(c=>Math.abs(c.S.length-nblk)<=3),chs.map(c=>c.S.length).join(' '));
const navs=chs.map(c=>K.gpsChannelNav(c));
ok('бит-синхронизация и кадры во всех каналах',navs.every(n=>n.ok&&n.frames.length>=2),navs.map(n=>n.ok?n.frames.length:n.err).join(' '));
ok('эфемериды декодированы во всех каналах',navs.every(n=>n.eph),navs.map(n=>!!n.eph).join(' '));
{ let same=true; navs.forEach((n,i)=>{ if(n.eph) for(const [name] of [...K.GPS_SF[1],...K.GPS_SF[2],...K.GPS_SF[3]]) if(n.eph[name]!==use[i].eph[name]) same=false; }); ok('принятые эфемериды совпали с переданными',same); }
const list=navs.map((n,i)=>n.eph&&{prn:use[i].prn,S:chs[i].S,fs:FS,ref:n.ref,eph:n.eph}).filter(Boolean);
const obs=K.gpsPseudoranges(list), fix=K.gpsSolve(obs);
ok('позиция посчитана',fix.ok,JSON.stringify(fix));
if(fix.ok){ const err=Math.hypot(fix.x-rcv[0],fix.y-rcv[1],fix.z-rcv[2]); console.log('позиция:',fix.lat.toFixed(5),fix.lon.toFixed(5),fix.h.toFixed(0),'м; ошибка',err.toFixed(1),'м; PDOP',fix.pdop.toFixed(1),'; невязка',fix.rms.toFixed(1),'м');
  ok('ошибка позиции ≤ 30 м (одна эпоха, C/N0 ≈ 46 дБ·Гц)',err<=30,err); ok('PDOP считается',fix.pdop>0&&fix.pdop<10); }
console.log(bad?('FAIL: '+bad):'всё ок'); process.exit(bad?1:0);
