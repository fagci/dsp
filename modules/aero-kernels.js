"use strict";
/* ============================ Inmarsat Aero, P-канал 600 / 1200 бит/с (L-диапазон, 1545 МГц) ============================
   Ядро IQK (страница и воркер), без DOM. Цепочка: IQ канала → ФНЧ и передискретизация на 16 отсчётов на символ → несущая
   по квадрату сигнала (две линии на 2f±baud/2) → ФНЧ ±0.55·baud → MSK-демодуляция (приращение фазы за символ, 16 фаз
   тактовой частоты разом) → синхрослово 0xE15AE893 → кадр 1200 бит: заголовок 16 бит + 1152 кодовых бита (перемежение
   64 × N, N=6 для 600 и 9 для 1200; свёрточный код K=7 r=1/2, полиномы 109 и 79, как у STD-C; скремблер x^15+x^14+1,
   сброс на кадр) = 6 сигнальных единиц (SU) по 12 байт с CRC-16 (GENIBUS, младший бит первым). Из SU: таблицы системы
   (спутник, каналы, управление P/R), назначения голосовых C-каналов (частоты, борт), ISU 0x71 + SSU 0xC0… →
   ACARS (разбор — vdl2Acars из vdl2-kernels.js, тот же формат FF FF 01 …).
   Структура кадра, перемежитель, скремблер и разбор SU — по JAERO (Jonathan Olds, MIT); сверено с реальной записью
   (эфир 1545.08 МГц: UW без ошибок, заголовок 0x1011, CRC SU сходится). Модуляция в эфире — MSK (h=0.5), биты прямые,
   без дифференциального кодирования; частотное отклонение вверх — «1».
   Нужны: vitNew / vitStep / vitTrace / ccEncode / ccPar (ccsds-kernels.js), fft / popcnt32 / biquadCoef / crc16r (core-dsp.js),
   iqBq / iqChunkIm (iq-kernels.js), vdl2Acars / vdl2AcarsBytes (vdl2-kernels.js, грузится раньше). */

const AERO_UW=0xE15AE893, AERO_FRAME=1200, AERO_DATA=1152, AERO_SPS=16, AERO_RING=4096, AERO_AFC=8192, AERO_LPF=0.45;
// скремблер: 15-разрядный регистр, начальное состояние 110100101011001, отводы 1 и 15
const AERO_SCR=(()=>{ const st=[1,1,0,1,0,0,1,0,1,0,1,1,0,0,1], o=new Uint8Array(1200);
  for(let a=0;a<o.length;a++){ const v=st[0]^st[14]; o[a]=v; for(let i=14;i>0;i--) st[i]=st[i-1]; st[0]=v; } return o; })();
// перемежитель 64 строки × N столбцов: на выходе деперемежителя out[j·64+i] = in[((i·27) mod 64)·N + j]
const AERO_ILV={};
function aeroIlv(N){
  if(AERO_ILV[N]) return AERO_ILV[N];
  const t=new Uint16Array(64*N);
  for(let j=0;j<N;j++) for(let i=0;i<64;i++) t[j*64+i]=((i*27)%64)*N+j;
  return AERO_ILV[N]=t;
}
const aeroSuCrc=(b,o)=>crc16r(b,o,10,0x8408,0xFFFF,0xFFFF);
const aeroHex=(v,w)=>(v>>>0).toString(16).toUpperCase().padStart(w,'0');

/* ---- кадр: мягкие кодовые биты (плюс — «1») → 72 байта ---- */
// sym — 1152 бита кадра в порядке приёма, prev / next — последний блок предыдущего и первый блок следующего кадра (или null):
// код непрерывен между кадрами, поэтому соседи дают Витерби разгон и хвост.
function aeroDecode(sym,N,prev,next){
  const B=64*N, nb=AERO_DATA/B, ilv=aeroIlv(N), lead=prev ? B : 0, tot=lead+AERO_DATA+(next ? B : 48);
  const x=new Float32Array(tot);
  const put=(src,off,dst)=>{ for(let k=0;k<B;k++) x[dst+k]=src[off+ilv[k]]; };
  if(prev) put(prev,0,0);
  for(let j=0;j<nb;j++) put(sym,j*B,lead+j*B);
  if(next) put(next,0,lead+AERO_DATA);
  const steps=tot>>1, v=vitNew(steps,0);
  for(let t=0;t<steps;t++) vitStep(v,-x[2*t+1],-x[2*t]);          // первый символ пары — полином 109, второй — 79
  const bits=vitTrace(v), s0=lead>>1, by=new Uint8Array(72);
  for(let i=0;i<576;i++) by[i>>3]|=(bits[s0+i]^AERO_SCR[i])<<(i&7);
  // перекодирование: доля несовпавших кодовых бит с жёстким входом — оценка качества канала
  let r=0, e=0, c=0;
  for(let t=Math.max(0,s0-6);t<s0+576;t++){
    r=((r<<1)|bits[t])&0x7F;
    if(t<s0+6) continue;
    if(ccPar(r&CC_G2)!==(x[2*t]>0 ? 1 : 0)) e++;
    if(ccPar(r&CC_G1)!==(x[2*t+1]>0 ? 1 : 0)) e++;
    c+=2;
  }
  return {bytes:by, ber:c ? e/c : 1};
}
// обратно (передатчик): 72 байта → 1152 кодовых бита (0 / 1) в порядке передачи; st — {r}, состояние кодера продолжается
function aeroEncode(by,N,st){
  const B=64*N, ilv=aeroIlv(N), info=new Uint8Array(576);
  for(let i=0;i<576;i++) info[i]=((by[i>>3]>>(i&7))&1)^AERO_SCR[i];
  const c=ccEncode(st,info), out=new Uint8Array(AERO_DATA);
  for(let t=0;t<576;t++){ out[2*t]=c[2*t+1]; out[2*t+1]=c[2*t]; }   // 109, затем 79
  const tx=new Uint8Array(AERO_DATA);
  for(let j=0;j<AERO_DATA/B;j++) for(let k=0;k<B;k++) tx[j*B+ilv[k]]=out[j*B+k];
  return tx;
}

/* ---- сигнальные единицы ---- */
const AERO_P_TYPE={0x01:'Fill-in', 0x05:'System table: GES channels', 0x07:'System table: GES beam support', 0x0A:'System table: index',
  0x0C:'System table: satellite ID', 0x10:'Log-on request', 0x11:'Log-on confirm', 0x12:'Log-off request', 0x13:'Log-on reject',
  0x14:'Log-on interrogation', 0x15:'Log-on/off acknowledge', 0x16:'Log-on prompt', 0x17:'Data channel reassignment',
  0x21:'Call announcement', 0x28:'EIRP table', 0x30:'Call progress', 0x31:'C-channel: distress', 0x32:'C-channel: flight safety',
  0x33:'C-channel: other safety', 0x34:'C-channel: non-safety', 0x40:'P/R channel control', 0x41:'T channel control',
  0x51:'T channel assignment', 0x61:'Request for acknowledgement', 0x62:'Acknowledge', 0x71:'User data (ISU, first SU)', 0x18:'Reserved', 0x19:'Reserved', 0x26:'Reserved',
  0x74:'User data, 3-octet LSDU', 0x76:'User data, 4-octet LSDU'};
const AERO_BITRATE={0:600, 1:1200, 2:2400, 3:4800, 4:6000, 5:5250, 6:10500, 7:8400, 9:21000};
const aeroMHz=(ch,base)=>(base+ch*0.0025).toFixed(4);
const aeroId=(b,o)=>aeroHex((b[o]<<16)|(b[o+1]<<8)|b[o+2],6);
function aeroState(){ return {isu:new Map(), lastAes:0, lastGes:0, frag:new Map(), seen:new Map(), sat:null}; }
// SU (12 байт, CRC уже сошёлся) → запись или null; собранный ISU приходит в isu.done
function aeroSu(st,b,o,now){
  const t=b[o], su=b.subarray(o,o+12), r={t:now, src:'AERO', type:t};
  if(t===0x01 || t===0x00) return null;
  const name=AERO_P_TYPE[t]||((t&0xC0)===0xC0 ? 'User data (SSU)' : 'type 0x'+aeroHex(t,2));
  if(t===0x71 || (t&0xC0)===0xC0) return aeroIsu(st,su,now);
  r.kind='sys'; r.what=name;
  if(t===0x05){
    const lsu=su[2]&3, ges=su[3], ch=[(su[4]<<8)|su[5],(su[6]<<8)|su[7],(su[8]<<8)|su[9]], off=lsu===0 || lsu===1 ? [0,101.5,101.5] : [101.5,101.5,101.5];
    const f=ch.map((c,i)=>(1510+c*0.0025+off[i]).toFixed(4));
    r.ges=aeroHex(ges,2); r.seq=su[2]>>2;
    r.text=lsu<=1 ? 'GES '+r.ges+': Psmc '+f[0]+' MHz, Rsmc0 '+f[1]+', Rsmc1 '+f[2] : 'GES '+r.ges+': Rsmc'+(lsu===2 ? '2,3,4 ' : '5,6,7 ')+f.join(', ')+' MHz (TX)';
  } else if(t===0x0C){
    const sat=((su[2]<<4)&0x30)|((su[3]>>4)&15), lon=su[5]*1.5, c1=((su[6]&0x7F)<<8)|su[7], c2=((su[8]&0x7F)<<8)|su[9];
    r.satId=sat; r.lon=lon>180 ? lon-360 : lon; r.seq=su[2]>>2;
    r.text='Satellite '+sat+' at '+(lon>180 ? (360-lon)+'°W' : lon+'°E')+', Psmc '+aeroMHz(c1,1510)+' MHz'+(su[6]&0x80 ? ' (spot)' : '')+(c2 ? ', '+aeroMHz(c2,1510)+' MHz'+(su[8]&0x80 ? ' (spot)' : '') : '');
    st.sat={id:sat, lon:r.lon};
  } else if(t===0x40){
    const ges=su[4], br=AERO_BITRATE[(su[7]>>4)&15]||0, ch=((su[8]&0x7F)<<8)|su[9];
    r.ges=aeroHex(ges,2); r.rate=br; r.text='GES '+r.ges+': P channel '+aeroMHz(ch,1510)+' MHz at '+br+' bit/s'+(su[8]&0x80 ? ' (spot)' : '');
  } else if(t>=0x31 && t<=0x34 || t===0x21){
    r.kind='call'; r.aes=aeroId(su,1); r.ges=aeroHex(su[4],2);
    const rx=((su[6]&0x7F)<<8)|su[7], tx=((su[8]&0x7F)<<8)|su[9];
    r.rx=+aeroMHz(rx,1510); r.tx=+aeroMHz(tx,1611.5); r.beam=su[6]&0x80 ? 'spot' : 'global';
    r.prio=t===0x31 ? 'distress' : t===0x32 ? 'flight safety' : t===0x33 ? 'other safety' : t===0x34 ? 'non-safety' : 'announcement';
    r.text='AES '+r.aes+' ↔ GES '+r.ges+': voice channel ('+r.prio+') RX '+aeroMHz(rx,1510)+' MHz, TX '+aeroMHz(tx,1611.5)+' MHz, '+r.beam+' beam';
  } else if(t===0x11){
    r.kind='login'; r.aes=aeroId(su,1); r.ges=aeroHex(su[4],2); r.text='AES '+r.aes+' logged on via GES '+r.ges;
  } else if(t===0x0A){ r.text='System table index'; }
  else r.text=name+': '+Array.from(su.subarray(1,10),v=>aeroHex(v,2)).join(' ');
  return r;
}
// ISU: первая SU 0x71 (борт, станция, номера, число SSU, 2 байта данных), затем SSU 0xC0|номер (8 байт; в последней — «octets»)
function aeroIsu(st,su,now){
  const t=su[0];
  for(const [k,it] of st.isu) if(now-it.t>60000) st.isu.delete(k);
  if(t===0x71){
    const it={aes:(su[1]<<16)|(su[2]<<8)|su[3], ges:su[4], qno:su[5]>>4, ref:su[5]&15, seq:su[6]&0x3F, last:su[7]>>4, data:[su[8],su[9]], t:now};
    st.lastAes=it.aes; st.lastGes=it.ges;
    st.isu.set(it.aes+'/'+it.ges+'/'+it.qno+'/'+it.ref+'/'+it.seq,it);
    return null;
  }
  const seq=t&0x3F, qno=su[1]>>4, ref=su[1]&15;
  let key=null, it=null;
  for(const [k,v] of st.isu) if(v.aes===st.lastAes && v.ges===st.lastGes && v.qno===qno && v.ref===ref && v.seq===seq+1){ key=k; it=v; break; }
  if(!it) return null;
  st.isu.delete(key);
  it.seq--;
  if(it.seq===0){ for(let i=2;i<=it.last+1;i++) it.data.push(su[i]); return aeroAcars(st,it,now); }
  for(let i=2;i<10;i++) it.data.push(su[i]);
  it.t=now; st.isu.set(it.aes+'/'+it.ges+'/'+it.qno+'/'+it.ref+'/'+it.seq,it);
  return null;
}
// собранный ISU → ACARS (FF FF 01 …) или hex; ETB-блоки склеиваются по борту, метке и буквенному номеру блока
function aeroAcars(st,it,now){
  const d=Uint8Array.from(it.data), r={t:now, src:'AERO', aes:aeroHex(it.aes,6), ges:aeroHex(it.ges,2), len:d.length};
  const ac=d.length>16 && d[0]===0xFF && d[1]===0xFF && (d[15]===0x83 || d[15]===0x02) ? vdl2Acars(d.subarray(3)) : null;
  if(!ac){
    r.kind='data'; r.hex=Array.from(d.subarray(0,48),v=>aeroHex(v,2)).join(' ');
    r.text='AES '+r.aes+' GES '+r.ges+' user data '+d.length+' B: '+r.hex+(d.length>48 ? ' …' : '');
    return r;
  }
  Object.assign(r,ac); r.kind='message';
  const key=[r.aes,r.ges,ac.reg,ac.label,ac.mode,ac.ack].join('/'), pend=st.frag.get(key);
  if(pend && String.fromCharCode((pend.blk.charCodeAt(0)-65+1)%26+65)===ac.blk){
    r.txt=pend.txt+ac.txt; r.parts=pend.parts+1; st.frag.delete(key);
  }
  if(ac.etb){ st.frag.set(key,{txt:r.txt, blk:ac.blk, parts:r.parts||1, t:now}); return null; }
  for(const [k,v] of st.frag) if(now-v.t>120000) st.frag.delete(k);
  r.text='AES '+r.aes+' '+ac.reg+' '+ac.label+(ac.flight ? ' '+ac.flight : '')+' · '+r.txt;
  return r;
}

/* ---- приёмник ---- */
function aeroSetup(n,sr,baud){
  const fo=AERO_SPS*baud, M=Math.max(1,Math.floor(sr/(1.5*fo))), fi=sr/M;
  n.key=sr+'|'+baud;
  n.ae={baud, fo, N:baud===1200 ? 9 : 6, M, ac:[0,0], cnt:0, q1:biquadCoef('lp',Math.min(.375*fo,.45*fi),.7071,fi), z1:new Float64Array(8),
    step:fi/fo, rt:0, hr:new Float64Array(4), hi:new Float64Array(4),
    ring:[new Float32Array(AERO_AFC), new Float32Array(AERO_AFC)], wi:0, ns:0,
    fc:0, th:0, lock:0, miss:0, pairDb:0, win:(()=>{ const w=new Float32Array(AERO_AFC); for(let i=0;i<AERO_AFC;i++) w[i]=.5-.5*Math.cos(2*Math.PI*i/AERO_AFC); return w; })(),
    q2:[biquadCoef('lp',AERO_LPF*baud,.5412,fo), biquadCoef('lp',AERO_LPF*baud,1.3066,fo)], z2:new Float64Array(16), pr:0, pi:0, phi:0, phr:new Float64Array(64),
    S:new Float32Array(AERO_SPS*AERO_RING), h:new Uint32Array(AERO_SPS), eab:new Float32Array(AERO_SPS), k:0, pend:null, frames:[], mag:0,
    st:aeroState(), cnt2:{uw:0, fmtBad:0}};
}
// несущая: P[f]+P[f+baud] по спектру квадрата сигнала (MSK: линии на 2f ± baud/2) → f; возвращает {fc, db} или null
function aeroAfc(a){
  const N=AERO_AFC, re=new Float64Array(N), im=new Float64Array(N), w=a.win;
  for(let i=0;i<N;i++){ const j=(a.wi+i)&(N-1), x=a.ring[0][j]*w[i], y=a.ring[1][j]*w[i]; re[i]=x*x-y*y; im[i]=2*x*y; }
  fft(re,im);
  const P=new Float64Array(N);
  for(let i=0;i<N;i++) P[i]=re[i]*re[i]+im[i]*im[i];
  const sep=Math.round(a.baud/(a.fo/N));
  let best=0, bi=0, sum=0;
  for(let i=0;i<N;i++){ const v=P[i]+P[(i+sep)%N]; sum+=v; if(v>best){ best=v; bi=i; } }
  const mean=sum/N;
  if(best<20*mean) return null;
  const lo=P[bi], hi=P[(bi+sep)%N];
  if(Math.min(lo,hi)<.15*best) return null;
  const refine=i=>{ const m=P[(i+N-1)%N], c=P[i], p=P[(i+1)%N], d=m-2*c+p; return Math.abs(d)<1e-30 ? 0 : .5*(m-p)/d; };
  const df=a.fo/N, b1=bi>N/2 ? bi-N : bi, f1=b1+refine(bi), f2=b1+sep+refine((bi+sep)%N);
  let center=(f1+f2)/2*df;
  if(center>=a.fo/2) center-=a.fo; else if(center<-a.fo/2) center+=a.fo;
  return {fc:center/2, db:10*Math.log10(best/mean)};
}
function aeroSample(n,a,re,im,recs,now){
  const N=AERO_AFC;
  a.ring[0][a.wi]=re; a.ring[1][a.wi]=im; a.wi=(a.wi+1)&(N-1); a.ns++;
  if(a.ns>=N && (a.ns&4095)===0){
    const r=aeroAfc(a);
    if(r){ a.fc=a.lock ? .5*a.fc+.5*r.fc : r.fc; a.lock=1; a.miss=0; a.pairDb=r.db; }
    else if(++a.miss>6) a.lock=0;
  }
  // смеситель на −fc
  a.th+=2*Math.PI*a.fc/a.fo; if(a.th>Math.PI) a.th-=2*Math.PI; else if(a.th<-Math.PI) a.th+=2*Math.PI;
  const c=Math.cos(a.th), s=Math.sin(a.th);
  let br=re*c+im*s, bi=im*c-re*s;
  br=iqBq(a.z2,0,a.q2[0],br); br=iqBq(a.z2,4,a.q2[1],br);
  bi=iqBq(a.z2,8,a.q2[0],bi); bi=iqBq(a.z2,12,a.q2[1],bi);
  a.phi+=Math.atan2(bi*a.pr-br*a.pi, br*a.pr+bi*a.pi);
  a.pr=br; a.pi=bi;
  a.phr[(a.ns-1)&63]=a.phi;
  a.mag=a.mag*.999+Math.hypot(br,bi)*.001;
  if(a.ns>=32 && (a.ns&(AERO_SPS-1))===0) aeroTick(n,a,recs,now);
}
// следующий символ у всех 16 фаз такта; синхрослово по каждой; кадры, у которых набрались данные и хвост, — на разбор
function aeroTick(n,a,recs,now){
  const k=a.k++, R=AERO_RING, mk=R-1, ph=a.phr, ns=a.ns;
  let bestM=99, bestP=0, bestInv=false, ties=[];
  for(let p=0;p<AERO_SPS;p++){
    const e=ns-AERO_SPS+p, v=ph[e&63]-ph[(e-AERO_SPS)&63];
    a.S[p*R+(k&mk)]=v; a.eab[p]+=(Math.abs(v)-a.eab[p])*.004;
    const hh=a.h[p]=((a.h[p]<<1)|(v>0 ? 1 : 0))>>>0, m0=popcnt32((hh^AERO_UW)>>>0), inv=m0>16, m=inv ? 32-m0 : m0;
    if(m<bestM){ bestM=m; bestP=p; bestInv=inv; ties=[p]; } else if(m===bestM && inv===bestInv) ties.push(p);
  }
  let th=a.lock ? 2 : 1;
  for(const f of a.frames) if(Math.abs(k-(f.k0+AERO_FRAME))<=1 && f.chain<6) th=6;       // ждём следующий кадр ровно через 1200 символов
  if(bestM<=th && (!a.pend || bestM<a.pend.m)) a.pend={k0:k, p:ties[ties.length>>1], inv:bestInv, m:bestM, until:k+2};
  if(a.pend && k>=a.pend.until){
    const q=a.pend; a.pend=null;
    if(!a.frames.some(f=>Math.abs(f.k0-q.k0)<=2)){
      // фаза такта: из потоков, где синхрослово почти сошлось, — с самым широким «глазом»
      const ms=[]; let mn=99;
      for(let p=0;p<AERO_SPS;p++){ const m=aeroUwMiss(a,{p, inv:q.inv},q.k0); ms.push(m); if(m<mn) mn=m; }
      let bp=q.p, be=-1;
      for(let p=0;p<AERO_SPS;p++) if(ms[p]<=mn+2 && a.eab[p]>be){ be=a.eab[p]; bp=p; }
      q.p=bp;
      const prev=a.frames.find(f=>Math.abs(q.k0-f.k0-AERO_FRAME)<=1);
      a.frames.push({k0:q.k0, p:q.p, inv:q.inv, m:q.m, done:false, chain:prev ? (q.m>3 ? prev.chain+1 : 0) : 0});
      a.cnt2.uw++;
    }
  }
  const B=64*a.N;
  for(const f of a.frames){
    if(f.done || k<f.k0+AERO_FRAME+16+B+2) continue;
    f.done=true;
    aeroFrame(n,a,f,k,recs,now);
  }
  if(a.frames.length>6) a.frames=a.frames.filter(f=>k-f.k0<3*AERO_FRAME);
}
// знаки символов потока p начиная с k0 — совпадение с синхрословом (число несовпадений)
function aeroUwMiss(a,f,kEnd){
  const R=AERO_RING, mk=R-1, sg=f.inv ? -1 : 1; let m=0;
  for(let i=0;i<32;i++){ const v=a.S[f.p*R+((kEnd-31+i)&mk)]*sg; if((v>0 ? 1 : 0)!==((AERO_UW>>>(31-i))&1)) m++; }
  return m;
}
function aeroFrame(n,a,f,k,recs,now){
  const R=AERO_RING, mk=R-1, B=64*a.N, sg=f.inv ? -1 : 1, S=a.S, base=f.p*R;
  const get=(i,len)=>{ const o=new Float32Array(len); for(let j=0;j<len;j++) o[j]=S[base+((i+j)&mk)]*sg; return o; };
  const d0=f.k0+17, sym=get(d0,AERO_DATA);
  let sc=0; for(let i=0;i<AERO_DATA;i++) sc+=Math.abs(sym[i]); sc=sc/AERO_DATA||1;
  const nrm=o=>{ for(let i=0;i<o.length;i++){ const v=o[i]/sc; o[i]=v>3 ? 3 : v<-3 ? -3 : v; } return o; };
  nrm(sym);
  const hasN=aeroUwMiss(a,f,f.k0+AERO_FRAME)<=9, hasP=f.k0-AERO_FRAME-31>=k-AERO_RING+1 && aeroUwMiss(a,f,f.k0-AERO_FRAME)<=9;
  const next=hasN ? nrm(get(f.k0+AERO_FRAME+17,B)) : null, prev=hasP ? nrm(get(d0-48-B,B)) : null;
  // заголовок: format ID (должен быть 1), маркер, два счётчика кадров
  let hdr=0; for(let i=0;i<16;i++) hdr=(hdr<<1)|(S[base+((f.k0+1+i)&mk)]*sg>0 ? 1 : 0);
  const dec=aeroDecode(sym,a.N,prev,next);
  f.ber=dec.ber;
  n.frames++; n.ber=dec.ber; n.hdr=hdr; n.fmt=hdr>>12;
  if((hdr>>12)!==1) a.cnt2.fmtBad++;
  let ok=0;
  for(let i=0;i<6;i++){
    const o=i*12, crc=aeroSuCrc(dec.bytes,o), rec=dec.bytes[o+10]|(dec.bytes[o+11]<<8);
    let good=crc===rec;
    if(!good && rec===0){ let z=0; for(let j=0;j<10;j++) z|=dec.bytes[o+j]; good=!z; }
    if(!good){ n.suBad++; continue; }
    ok++; n.suOk++;
    const r=aeroSu(a.st,dec.bytes,o,now);
    if(!r) continue;
    // повторы таблиц системы: не чаще раза в минуту
    if(r.kind==='sys'){ const last=a.st.seen.get(r.text); if(last && now-last<60000) continue; a.st.seen.set(r.text,now); }
    recs.push(r);
    if(r.kind==='message') n.msgs++;
    n.last=now;
    n.recent.push(new Date(now).toTimeString().slice(0,8)+' '+r.text.slice(0,110)); if(n.recent.length>20) n.recent.shift();
  }
  if(ok) n.last=now;
}
IQK.aeroRx={
  init(n){ n.key=''; n.frames=0; n.suOk=0; n.suBad=0; n.msgs=0; n.last=0; n.ber=null; n.hdr=0; n.fmt=0; n.recent=[]; n.ui=null; n.ae=null; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr){ n.ui=null; return {rec:null, text:null, locked:0}; }
    const sr=s.sr, baud=+n.p.baud===1200 ? 1200 : 600, now=Date.now(), recs=[];
    if(sr<12*baud){ n.ui={err:'sample rate '+(sr/1000).toFixed(1)+' kS/s is too low: P'+baud+' needs ≥ '+(12*baud/1000).toFixed(1)+' kS/s', recent:n.recent}; return {rec:null, text:null, locked:0}; }
    if(n.key!==sr+'|'+baud) aeroSetup(n,sr,baud);
    const a=n.ae, q=a.q1, z=a.z1, hr=a.hr, hi=a.hi, M=a.M, step=a.step, inv=1/M;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length;
      for(let i=0;i<K;i++){
        a.ac[0]+=xr[i]; a.ac[1]+=xi[i];
        if(++a.cnt<M) continue;
        a.cnt=0;
        const yr=iqBq(z,0,q,a.ac[0]*inv), yi=iqBq(z,4,q,a.ac[1]*inv);
        a.ac[0]=0; a.ac[1]=0;
        hr[0]=hr[1]; hr[1]=hr[2]; hr[2]=hr[3]; hr[3]=yr;
        hi[0]=hi[1]; hi[1]=hi[2]; hi[2]=hi[3]; hi[3]=yi;
        while(a.rt<1){
          const t=a.rt;
          const cr=.5*(hr[2]-hr[0]), c2r=hr[0]-2.5*hr[1]+2*hr[2]-.5*hr[3], c3r=.5*(hr[3]-hr[0])+1.5*(hr[1]-hr[2]);
          const ci=.5*(hi[2]-hi[0]), c2i=hi[0]-2.5*hi[1]+2*hi[2]-.5*hi[3], c3i=.5*(hi[3]-hi[0])+1.5*(hi[1]-hi[2]);
          aeroSample(n,a,((c3r*t+c2r)*t+cr)*t+hr[1],((c3i*t+c2i)*t+ci)*t+hi[1],recs,now);
          a.rt+=step;
        }
        a.rt-=1;
      }
    }
    n.ui={fs:sr, baud, lock:!!a.lock, fc:a.fc, pairDb:a.pairDb, uw:a.cnt2.uw, frames:n.frames, fmtBad:a.cnt2.fmtBad, suOk:n.suOk, suBad:n.suBad, msgs:n.msgs, ber:n.ber, sat:a.st.sat,
      recent:n.recent, age:n.last ? now-n.last : null, lvl:20*Math.log10(Math.max(a.mag,1e-9))};
    const text=recs.map(r=>r.text);
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, locked:n.last && now-n.last<6000 ? 1 : 0};
  }};

/* ---- передатчик (тест и генератор): кадры P-канала → MSK ---- */
const AERO_SIM_AES=0x4840D6, AERO_SIM_GES=0x2F;
function aeroSuBody(arr){ const b=new Uint8Array(10); b.set(arr.slice(0,10)); return b; }
function aeroIsuBodies(aes,ges,qno,ref,ud){
  const R=ud.length-2, nS=Math.ceil(R/8), last=R-8*(nS-1), out=[];
  out.push(aeroSuBody([0x71,(aes>>16)&255,(aes>>8)&255,aes&255,ges,(qno<<4)|(ref&15),nS&0x3F,last<<4,ud[0],ud[1]]));
  for(let k=1;k<=nS;k++){ const b=new Uint8Array(10); b[0]=0xC0|((nS-k)&0x3F); b[1]=(qno<<4)|(ref&15); for(let i=0;i<8;i++){ const v=ud[2+(k-1)*8+i]; if(v!==undefined) b[2+i]=v; } out.push(b); }
  return out;
}
// сценарий: таблицы системы, назначение голосового канала, два ACARS-сообщения (второе длинное — несколько SSU)
const AERO_SIM_ACARS=[
  {mode:'2', reg:'.VP-BDB', ack:0x15, label:'H1', blk:'3', flight:'SU1204', body:'#M1BPOS N55123E037456,FL350,ETA1432'},
  {mode:'2', reg:'.VQ-BRD', ack:'3', label:'5Z', blk:'B', body:'GATE B23 LAND 1432Z, PAX 142, BAG 168'}];
function aeroSimQueue(k){
  const q=[], g=k%4, aes=AERO_SIM_AES, ges=AERO_SIM_GES;
  if(g===0){
    q.push(aeroSuBody([0x0A,0x97,0,0,0,0,0,0,0,0]));
    q.push(aeroSuBody([0x0C,0,(3<<2)|0,(3<<4),0,43,0x36,0xB0,0,0]));                           // спутник 3, 64.5°E, Psmc 1545.0 МГц
    q.push(aeroSuBody([0x05,0,(1<<2)|0,ges,0x36,0xB0,0x36,0xB0,0x36,0xC0]));
    q.push(aeroSuBody([0x40,0,0,0,ges,0,0,0x10,0x36,0xB0]));                                    // P/R control: 1200 бит/с, 1545.0 МГц
  } else if(g===1){
    q.push(aeroSuBody([0x34,(aes>>16)&255,(aes>>8)&255,aes&255,ges,0,0x38,0x40,0x37,0x78]));
    const m=AERO_SIM_ACARS[0], ud=[0xFF,0xFF,0x01,...vdl2AcarsBytes(m,k)];
    q.push(...aeroIsuBodies(aes,ges,1,k&7,ud));
  } else if(g===2){
    const m=AERO_SIM_ACARS[1], ud=[0xFF,0xFF,0x01,...vdl2AcarsBytes(m,k)];
    q.push(...aeroIsuBodies(0x3C4DD2,ges,2,k&7,ud));
  }
  return q;
}
function aeroSimFrame(g,N){
  const by=new Uint8Array(72);
  for(let i=0;i<6;i++){
    if(!g.q.length) g.q.push(...aeroSimQueue(g.qk++));
    const body=g.q.shift()||aeroSuBody([0x01]), o=i*12;
    by.set(body,o); const c=aeroSuCrc(by,o); by[o+10]=c&255; by[o+11]=c>>8;
  }
  const bits=new Uint8Array(AERO_FRAME), hdr=(1<<12)|(0<<8)|((g.fk&15)<<4)|(g.fk&15);
  for(let i=0;i<32;i++) bits[i]=(AERO_UW>>>(31-i))&1;
  for(let i=0;i<16;i++) bits[32+i]=(hdr>>(15-i))&1;
  bits.set(aeroEncode(by,N,g.enc),48);
  g.fk++;
  return bits;
}
// биты (0 / 1) → MSK: отклонение ±baud/4, фаза непрерывна; sr — частота дискретизации, дробное число отсчётов на символ допустимо
function aeroGenerate(n,sr,N,baud){
  baud=baud||600;
  let g=n.aero;
  if(!g || g.sr!==sr || g.baud!==baud) g=n.aero={sr, baud, t:0, ph:0, bits:[], pos:0, q:[], qk:n.aeroQ0||0, fk:0, enc:{r:0}};
  const re=new Float32Array(N), im=new Float32Array(N), dt=baud/sr, dph=Math.PI/2*dt, nn=baud===1200 ? 9 : 6;
  for(let i=0;i<N;i++){
    while(g.bits.length-g.pos<4){ if(g.pos>0){ g.bits=g.bits.slice(g.pos); g.pos=0; } for(const b of aeroSimFrame(g,nn)) g.bits.push(b); }
    const b=g.bits[g.pos];
    g.ph+=b ? dph : -dph;
    if(g.ph>Math.PI) g.ph-=2*Math.PI; else if(g.ph<-Math.PI) g.ph+=2*Math.PI;
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
    g.t+=dt; if(g.t>=1){ g.t-=1; g.pos++; }
  }
  return [re,im];
}

// три канала P600 на разных частотах (разный сценарий SU) и CW-помеха — для сканера
function aeroGenMulti(n,sr,N){
  const CH=[[-37500,1],[12500,.7],[37500,.5]];
  if(!n.aeroM) n.aeroM=CH.map((c,i)=>({aeroQ0:i, th:0}));
  const re=new Float32Array(N), im=new Float32Array(N);
  CH.forEach(([f,a],k)=>{
    const g=n.aeroM[k], [r,q]=aeroGenerate(g,sr,N,600), w=2*Math.PI*f/sr;
    for(let i=0;i<N;i++){ const c=Math.cos(g.th), s=Math.sin(g.th); re[i]+=a*(r[i]*c-q[i]*s); im[i]+=a*(r[i]*s+q[i]*c); g.th+=w; }
    g.th%=2*Math.PI;
  });
  const g=n.aeroM, w=2*Math.PI*10000/sr; g.cw=g.cw||0;
  for(let i=0;i<N;i++){ re[i]+=.12*Math.cos(g.cw); im[i]+=.12*Math.sin(g.cw); g.cw+=w; }
  g.cw%=2*Math.PI;
  const sc=1/1.6; for(let i=0;i<N;i++){ re[i]*=sc; im[i]*=sc; }
  return [re,im];
}

/* ---- сканер: широкая запись → все несущие P-каналов, на каждой свой приёмник ---- */
// Спектр усредняется, узкие несущие (≥ thr дБ над локальной медианой на 20 кГц) пробуются: канал получает смеситель, децимацию
// и свой IQK.aeroRx. Остаётся тот, где за AERO_SC_PROBE секунд сошёлся хотя бы один CRC; молчащий дольше AERO_SC_DROP — снимается.
// Время — по числу отсчётов потока, не по часам.
const AERO_SC_PROBE=25, AERO_SC_DROP=120, AERO_SC_BLACK=600, AERO_SC_EVERY=2;
function aeroScSetup(n,sr,baud){
  n.key=sr+'|'+baud; n.baud=baud; n.sr=sr; n.ch=[]; n.black=[]; n.t=0; n.nextScan=AERO_SC_EVERY; n.scans=0;
  n.fN=Math.min(65536,Math.max(1024,pow2ge(Math.round(sr/120))));
  n.fw=new Float32Array(n.fN); for(let i=0;i<n.fN;i++) n.fw[i]=.5-.5*Math.cos(2*Math.PI*i/n.fN);
  n.fbr=new Float32Array(n.fN); n.fbi=new Float32Array(n.fN); n.fi=0; n.P=null; n.blk=new Float64Array(n.fN); n.blkN=0;
  n.D=Math.max(1,Math.floor(sr/(3*AERO_SPS*baud))); n.chSr=sr/n.D;
}
function aeroScCand(n){
  const N=n.fN, df=n.sr/N, K=Math.max(1,Math.round(1500/df)), P=n.P, sm=new Float64Array(N), cs=new Float64Array(N+1);
  // сглаживание ±1.5 кГц по кольцу
  for(let i=0;i<N;i++) cs[i+1]=cs[i]+P[i];
  for(let i=0;i<N;i++){ let a=i-K, b=i+K+1, s=0;
    if(a<0){ s+=cs[N]-cs[N+a]; a=0; } if(b>N){ s+=cs[b-N]; b=N; } s+=cs[b]-cs[a]; sm[i]=s/(2*K+1); }
  // тренд — медиана по блокам; порядок бинов: 0 → центр, затем отрицательные частоты
  const BL=Math.max(16,Math.round(Math.min(20e3,n.sr/4)/df)), tr=new Float64Array(N);
  const order=new Float64Array(N); for(let j=0;j<N;j++) order[j]=sm[(j+N/2)%N];      // по возрастанию частоты
  for(let i=0;i<N;i+=BL){ const seg=Array.from(order.subarray(i,Math.min(N,i+BL))).sort((x,y)=>x-y), md=seg[seg.length>>1]; for(let j=i;j<Math.min(N,i+BL);j++) tr[j]=md; }
  const out=[];
  for(let j=1;j<N-1;j++){
    const f=(j-N/2)*df; if(Math.abs(f)>.42*n.sr || Math.abs(f)<4000) continue;
    const r=10*Math.log10(Math.max(order[j],1e-30)/Math.max(tr[j],1e-30));
    if(r>=n.thr && order[j]>=order[j-1] && order[j]>=order[j+1]) out.push({f, r});
  }
  out.sort((a,b)=>b.r-a.r);
  const pick=[]; for(const c of out) if(pick.every(p=>Math.abs(p.f-c.f)>2400)) pick.push(c);
  return pick;
}
function aeroScAdd(n,f){
  const ch={f, born:n.t, last:n.t, ok:0, probe:true, w:2*Math.PI*f/n.sr, pr:1, pi:0, ar:0, ai:0, cnt:0, node:{p:{baud:String(n.baud)}}};
  IQK.aeroRx.init(ch.node); n.ch.push(ch);
}
IQK.aeroScan={
  init(n){ n.key=''; n.ch=[]; n.recent=[]; n.msgs=0; n.ui=null; n.frames=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr){ n.ui=null; return {rec:null, text:null, locked:0}; }
    const sr=s.sr, baud=+n.p.baud===1200 ? 1200 : 600, now=Date.now(), recs=[];
    if(sr<24e3){ n.ui={err:'sample rate '+(sr/1000).toFixed(1)+' kS/s is too low for a scan: ≥ 24 kS/s', recent:n.recent}; return {rec:null, text:null, locked:0}; }
    if(n.key!==sr+'|'+baud) aeroScSetup(n,sr,baud);
    n.thr=+n.p.thr||1.2; const MAXC=Math.max(1,Math.min(16,+n.p.max||8)), D=n.D, fc0=s.fc||0;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length;
      // спектр
      for(let i=0;i<K;i++){
        n.fbr[n.fi]=xr[i]*n.fw[n.fi]; n.fbi[n.fi]=xi[i]*n.fw[n.fi];
        if(++n.fi===n.fN){
          n.fi=0; const a=Float64Array.from(n.fbr), b=Float64Array.from(n.fbi); fft(a,b);
          for(let j=0;j<n.fN;j++) n.blk[j]+=a[j]*a[j]+b[j]*b[j]; n.blkN++;
        }
      }
      // каналы
      for(const ch of n.ch){
        const cw=Math.cos(ch.w), sw=Math.sin(ch.w), M=Math.ceil((ch.cnt+K)/D), orr=new Float32Array(M), oi=new Float32Array(M);
        let pr=ch.pr, pi=ch.pi, ar=ch.ar, ai=ch.ai, cnt=ch.cnt, o=0;
        for(let i=0;i<K;i++){
          ar+=xr[i]*pr-xi[i]*pi; ai+=xr[i]*pi+xi[i]*pr;
          const t=pr*cw+pi*sw; pi=pi*cw-pr*sw; pr=t;
          if(++cnt===D){ orr[o]=ar/D; oi[o]=ai/D; o++; ar=0; ai=0; cnt=0; }
        }
        const m=1/Math.hypot(pr,pi); ch.pr=pr*m; ch.pi=pi*m; ch.ar=ar; ch.ai=ai; ch.cnt=cnt;
        if(!o) continue;
        const r=IQK.aeroRx.process(ch.node,{in:{sr:n.chSr, fc:fc0+ch.f, chunks:[{re:orr.subarray(0,o), im:oi.subarray(0,o), t0:0}]}},{});
        if(r.rec) for(const x of r.rec){
          x.freq=Math.round(fc0+ch.f+(ch.node.ae ? ch.node.ae.fc : 0));
          x.text=(x.freq/1e6).toFixed(4)+' · '+x.text;
          recs.push(x); if(x.kind==='message') n.msgs++;
          n.recent.push(new Date(now).toTimeString().slice(0,8)+' '+x.text.slice(0,110)); if(n.recent.length>24) n.recent.shift();
        }
      }
      n.t+=K/sr;
    }
    // жизнь каналов: подтверждённые, пробные, дубли
    for(const ch of n.ch){ if(ch.node.suOk>ch.ok){ ch.ok=ch.node.suOk; ch.last=n.t; ch.probe=false; } }
    const lockedF=ch=>ch.node.ae && ch.node.ae.lock ? ch.f+ch.node.ae.fc : null;
    for(const ch of n.ch){
      const cf=lockedF(ch); if(cf==null) continue;
      for(const o of n.ch){ if(o===ch || o.dead || ch.dead) continue; const of=lockedF(o);
        if(of!=null && Math.abs(of-cf)<400){ const drop=(ch.ok>o.ok || (ch.ok===o.ok && ch.born<o.born)) ? o : ch; drop.dead=true; } }
    }
    n.ch=n.ch.filter(ch=>{
      if(ch.dead) return false;
      if(ch.probe && n.t-ch.born>AERO_SC_PROBE){ n.black.push({f:ch.f, until:n.t+AERO_SC_BLACK}); return false; }
      if(!ch.probe && n.t-ch.last>AERO_SC_DROP) return false;
      return true;
    });
    n.black=n.black.filter(b=>b.until>n.t);
    // раз в AERO_SC_EVERY с: накопленный спектр → новые кандидаты
    if(n.t>=n.nextScan && n.blkN>0){
      n.nextScan=n.t+AERO_SC_EVERY; n.scans++;
      const N=n.fN; if(!n.P) n.P=new Float64Array(N);
      for(let j=0;j<N;j++){ const v=n.blk[j]/n.blkN; n.P[j]=n.scans===1 ? v : .75*n.P[j]+.25*v; n.blk[j]=0; } n.blkN=0;
      if(n.scans>=2) for(const c of aeroScCand(n)){
        if(n.ch.length>=MAXC) break;
        if(n.ch.some(h=>Math.abs(h.f-c.f)<1500 || (lockedF(h)!=null && Math.abs(lockedF(h)-c.f)<1500))) continue;
        if(n.black.some(b=>Math.abs(b.f-c.f)<1500)) continue;
        aeroScAdd(n,c.f); n.ch[n.ch.length-1].r=c.r;
      }
    }
    const list=n.ch.map(ch=>{ const u=ch.node.ui||{}, a=ch.node.ae; return {f:fc0+ch.f+(a ? a.fc : 0), probe:ch.probe, lock:!!(a&&a.lock), frames:ch.node.frames, suOk:ch.node.suOk, suBad:ch.node.suBad, ber:ch.node.ber, msgs:ch.node.msgs, age:ch.node.last ? now-ch.node.last : null, r:ch.r}; }).sort((a,b)=>a.f-b.f);
    n.ui={fs:sr, fc:fc0, baud, chans:list, frames:list.reduce((x,c)=>x+c.frames,0), suOk:list.reduce((x,c)=>x+c.suOk,0), suBad:list.reduce((x,c)=>x+c.suBad,0), msgs:n.msgs, recent:n.recent, scans:n.scans, black:n.black.length};
    const text=recs.map(r=>r.text);
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, locked:list.filter(c=>c.lock&&!c.probe).length};
  }};
