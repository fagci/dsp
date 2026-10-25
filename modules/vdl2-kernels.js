"use strict";
/* ============================ VDL Mode 2: D8PSK 10500 Бод, 25 кГц (136.975 МГц и др.) ============================
   Ядро IQK.vdl2Rx (грузится и страницей, и воркером острова), без DOM. Цепочка:
   IQ канала → ФНЧ 8 кГц → передискретизация на 105 кС/с (10 отсчётов на символ) → поиск преамбулы (16 символов, линейная регрессия
   фазовой ошибки — она же оценка расстройки) → разностная демодуляция D8PSK (код Грея) → скремблер (ЛРС x^15+x+1, начало 0x6959) →
   заголовок 25 бит (3 резерв, длина 17, БЧХ-проверка 5, исправление ошибки по синдрому) → данные + Рид—Соломон RS(255,249) по блокам
   с перемежением (последний блок короче: 0 / 2 / 4 / 6 проверочных байт, остальные — стирания) → HDLC (флаги 0x7E, бит-стаффинг) →
   AVLC (адреса, FCS CRC-16, кадры I / S / U) → ACARS в I-кадрах (ff ff 01 …), остальное — записью с hex.
   Алгоритмы и константы — по dumpvdl2 (Tomasz Lemiech, GPLv3) и libacars; сверка со стандартом ICAO Annex 10 vol. III, ARINC 631.
   Нужны: rsCodec (ccsds-kernels.js), iqBq (iq-kernels.js), vacParse / vacCrc / vacPar (acars-kernels.js). */
const VDL2_BAUD=10500, VDL2_SPS=10, VDL2_FS=VDL2_BAUD*VDL2_SPS, VDL2_PRE=16, VDL2_SBL=VDL2_PRE*VDL2_SPS, VDL2_SKIP=3, VDL2_THR=4, VDL2_PHMAX=1000;
const VDL2_RS_K=249, VDL2_RS_N=255, VDL2_TRLEN=17, VDL2_FECLEN=5, VDL2_HDR=3+VDL2_TRLEN+VDL2_FECLEN, VDL2_IV=0x6959, VDL2_MAXLEN=0x3FFF, VDL2_MAXLEN_C=0x1FFF;
const VDL2_GRAY=[0,1,3,2,6,7,5,4];
// фаза после каждого символа преамбулы, единицы π/4
const VDL2_PREPH=[0,3,-3,1,1,2,0,4,-3,4,-2,3,1,-2,-3,0].map(k=>k*Math.PI/4);
const VDL2_H=['0000000011111111111110000','0011111100001111111101000','1100011100110000111100100','1101101101010011001100010','0110100111100101010100001'].map(s=>parseInt(s,2));
const VDL2_SYND=['0000000000000000000000000','0000000000000000000000001','0000000000000000000000010','0100000000000000000000100','0000000000000000000000100','0100000000000000000000010','1000000000000000000000000','0100000000000000000000000',
  '0000000000000000000001000','0010000000000000000000000','0001000000000000000000000','0000100000000000000000000','0000010000000000000000000','1000100000000000000000000','0000001000000000000000000','0000000100000000000000000',
  '0000000000000000000010000','0000000010000000000000000','0100000000100000000000000','0000000001000000000000000','0100000001000000000000000','0000000000100000000000000','0000000000010000000000000','1000000010000000000000000',
  '0000000000001000000000000','0000000000000100000000000','0000000000000010000000000','0000000000000001000000000','0000000000000000100000000','0000000000000000010000000','0000000000000000001000000','0000000000000000000100000'].map(s=>parseInt(s,2));
const VDL2_SYNDW=[0,1,1,2,1,2,1,1,1,1,1,1,1,2,1,1,1,1,2,1,2,1,1,2,1,1,1,1,1,1,1,1];
const VDL2_RS=rsCodec(0x187,120,1,6);
// CRC-16/X.25 (FCS кадра AVLC): отражённый 0x1021, начало 0xFFFF, хороший остаток 0xF0B8
const VDL2_CRCT=(()=>{ const t=new Uint16Array(256); for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c=c&1 ? (c>>1)^0x8408 : c>>1; t[i]=c; } return t; })();
function vdl2Crc(b,len,crc){ crc=crc==null ? 0xFFFF : crc; for(let i=0;i<len;i++) crc=(crc>>8)^VDL2_CRCT[(crc^b[i])&0xFF]; return crc&0xFFFF; }
const vdl2Par=v=>{ v^=v>>16; v^=v>>8; v^=v>>4; v^=v>>2; v^=v>>1; return v&1; };
function vdl2Rev(v,nb){ let r=0; for(let i=0;i<nb;i++){ r=(r<<1)|(v&1); v>>>=1; } return r>>>0; }
// число проверочных байт в последнем (неполном) блоке
const vdl2FecOct=len=>len<3 ? 0 : len<31 ? 2 : len<68 ? 4 : 6;

// RS(255,249) с стираниями: cw[0..254], er — индексы стёртых; число исправленных байт (стирания в счёт) или −1
function vdl2RsFix(cw,er){
  const rs=VDL2_RS, np=rs.np, fcr=120, mul=rs.mul, div=rs.div, pw=rs.pw;
  const S=new Uint8Array(np);
  let bad=0;
  for(let j=0;j<np;j++){ const r=pw(fcr+j); let s=0; for(let i=0;i<255;i++) s=mul(s,r)^cw[i]; S[j]=s; bad|=s; }
  if(!bad) return 0;
  const ne=er.length;
  if(ne>np) return -1;
  // локатор стираний Γ(x)=∏(1+X·x), X=α^(254−i)
  let G=[1];
  for(const i of er){ const X=pw(254-i), h=new Array(G.length+1).fill(0); for(let k=0;k<G.length;k++){ h[k]^=G[k]; h[k+1]^=mul(G[k],X); } G=h; }
  // модифицированные синдромы T=S·Γ mod x^np, годятся T[ne…np−1]
  const T=new Uint8Array(np);
  for(let i=0;i<np;i++){ let v=0; for(let j=0;j<=Math.min(i,ne);j++) v^=mul(G[j],S[i-j]); T[i]=v; }
  const m=np-ne;
  let C=new Uint8Array(m+1), B=new Uint8Array(m+1), L=0, mm=1, b=1;
  C[0]=1; B[0]=1;
  for(let n=0;n<m;n++){
    let d=T[ne+n];
    for(let i=1;i<=L;i++) d^=mul(C[i],T[ne+n-i]);
    if(!d){ mm++; continue; }
    const coef=div(d,b), tmp=C.slice();
    for(let i=mm;i<=m;i++) C[i]^=mul(coef,B[i-mm]);
    if(2*L<=n){ L=n+1-L; B=tmp; b=d; mm=1; } else mm++;
  }
  if(2*L+ne>np) return -1;
  // полный локатор Ψ=Λ·Γ
  const Psi=new Uint8Array(L+ne+1);
  for(let i=0;i<=L;i++) for(let j=0;j<=ne;j++) Psi[i+j]^=mul(C[i],G[j]);
  const deg=L+ne;
  const O=new Uint8Array(np);
  for(let i=0;i<np;i++){ let v=0; for(let j=0;j<=Math.min(i,deg);j++) v^=mul(Psi[j],S[i-j]); O[i]=v; }
  const pos=[], val=[];
  for(let i=0;i<255;i++){
    const d=254-i, xi=pw(-d);
    let lv=0; for(let j=deg;j>=0;j--) lv=mul(lv,xi)^Psi[j];
    if(lv) continue;
    let ov=0; for(let j=np-1;j>=0;j--) ov=mul(ov,xi)^O[j];
    let dv=0; for(let j=1;j<=deg;j+=2) dv^=mul(Psi[j],pw(-d*(j-1)));
    if(!dv) return -1;
    pos.push(i); val.push(mul(div(ov,dv),pw(d*(1-fcr))));
  }
  if(pos.length!==deg) return -1;
  for(let k=0;k<pos.length;k++) cw[pos[k]]^=val[k];
  for(let j=0;j<np;j++){ const r=pw(fcr+j); let s=0; for(let i=0;i<255;i++) s=mul(s,r)^cw[i]; if(s) return -1; }     // проверка: после исправления синдромы нулевые
  return pos.length;
}

// перемежение: байты in[0..len) идут по столбцам таблицы rows×255, ширина заполнения fillwidth, смещение столбца offset; у короткой последней строки в конце столбцов дыры.
// Возвращает {row:[], col:[]} для каждого входного байта или код ошибки
function vdl2Map(len,rows,fillwidth,offset){
  if(rows===0 || fillwidth===0) return -1;
  let lastRow=len%fillwidth; if(lastRow===0) lastRow=fillwidth;
  if(fillwidth+offset>VDL2_RS_N) return -2;
  if(len>rows*fillwidth) return -3;
  if(rows>1 && len-lastRow<(rows-1)*fillwidth) return -4;
  const R=new Uint16Array(len), C=new Uint16Array(len);
  let row=0, col=offset;
  lastRow+=offset;
  for(let i=0;i<len;i++){
    if(row===rows-1 && col>=lastRow){ row=0; col++; }
    R[i]=row; C[i]=col; row++;
    if(row===rows){ row=0; col++; }
  }
  return {R,C};
}

// ---- битовый поток ----
function vdl2Bs(len){ return {buf:new Uint8Array(len), start:0, end:0, dpos:0}; }
function vdl2BsReset(b){ b.start=b.end=b.dpos=0; }
function vdl2Descramble(b,st){
  if(b.dpos<b.start) b.dpos=b.start;
  for(let i=b.dpos;i<b.end;i++){
    const bit=((st.lfsr>>0)^(st.lfsr>>14))&1;
    st.lfsr=(st.lfsr>>1)|(bit<<14);
    b.buf[i]^=bit;
  }
  b.dpos=b.end;
}
function vdl2ReadLsb(b,out,nbytes){
  if(b.start+8*nbytes>b.end) return false;
  for(let i=0;i<nbytes;i++){ let v=0; for(let j=0;j<8;j++) v|=(b.buf[b.start++]&1)<<j; out[i]=v; }
  return true;
}
function vdl2AppendLsb(b,bytes,from,nbytes){
  if(b.end+8*nbytes>b.buf.length) return false;
  for(let i=0;i<nbytes;i++){ const t=bytes[from+i]; for(let j=0;j<8;j++) b.buf[b.end++]=(t>>j)&1; }
  return true;
}
// следующий кадр HDLC из src: снимает флаги и вставленные нули; {bits, more} или null при ошибке
function vdl2NextFrame(src){
  for(;;){
    let ones=0, j=0, restart=false;
    const dst=[];
    let i=src.start;
    for(;i<src.end;i++,src.start++){
      const bit=src.buf[i];
      if(bit===0 && ones===5){ ones=0; continue; }
      if(bit===1){ ones++; if(ones>6) return null; }
      dst[j]=bit;
      if(bit===0){
        if(ones===6){
          if(j===7){ src.start++; restart=true; break; }
          if(j<7) return null;
          dst.length=j-7; src.start++;
          return {bits:dst, more:src.start<src.end};
        }
        ones=0;
      }
      j++;
    }
    if(!restart) return {bits:dst, more:src.start<src.end, open:true};     // флага в конце нет — данные, сколько есть (как в dumpvdl2)
  }
}

// ---- AVLC / ACARS ----
const VDL2_ADDR_TYPE=['reserved','Aircraft','reserved','reserved','Ground station','Ground station','reserved','All stations'];
const VDL2_S_CMD=['Receive Ready','Receive not Ready','Reject','Selective Reject'];
const VDL2_U_CMD={0x00:'UI',0x03:'DM',0x10:'DISC',0x18:'UA',0x21:'FRMR',0x2b:'XID',0x38:'TEST'};
function vdl2Addr(b,o){
  const x=(b[o]>>1)|(b[o+1]<<6)|(b[o+2]<<13)|((b[o+3]&0xfe)<<20);
  const v=vdl2Rev(x&0xFFFFFFF,28);
  return {addr:v&0xFFFFFF, type:(v>>24)&7, status:(v>>27)&1};
}
const vdl2Hex=(b,from,to)=>{ let s=''; for(let i=from;i<to;i++) s+=(b[i]<16 ? '0' : '')+b[i].toString(16); return s; };
// кадр AVLC (с FCS) → запись или null (короткий / FCS не сошёлся)
function vdl2Avlc(b,meta){
  if(b.length<11) return null;
  if(vdl2Crc(b,b.length)!==0xF0B8) return null;
  const len=b.length-2;
  const dst=vdl2Addr(b,0), src=vdl2Addr(b,4), lcf=b[8];
  const hex=a=>a.addr.toString(16).toUpperCase().padStart(6,'0');
  const r={t:Date.now(), src:'VDL2', from:hex(src), to:hex(dst), fromType:VDL2_ADDR_TYPE[src.type], toType:VDL2_ADDR_TYPE[dst.type],
    ag:dst.status ? 'On ground' : 'Airborne', cr:src.status ? 'Response' : 'Command', len};
  if(meta){ r.rssi=meta.rssi; r.df=meta.df; if(meta.fixed) r.fixed=meta.fixed; }
  const body=b.subarray(9,len);
  let kind='avlc', text='';
  if((lcf&3)===1){ r.frame='S'; r.cmd=VDL2_S_CMD[(lcf>>2)&3]; r.rseq=(lcf>>5)&7; r.pf=(lcf>>4)&1; text=r.cmd; }
  else if((lcf&3)===3){ const mf=(lcf>>2)&0x3b; r.frame='U'; r.cmd=VDL2_U_CMD[mf]||'0x'+mf.toString(16); r.pf=(lcf>>4)&1; text=r.cmd; }
  else { r.frame='I'; r.sseq=(lcf>>1)&7; r.rseq=(lcf>>5)&7; r.poll=(lcf>>4)&1; text='I-frame';
    if(body.length>3 && body[0]===0xff && body[1]===0xff && body[2]===0x01){
      const a=vdl2Acars(body.subarray(3));
      if(a){ kind='message'; Object.assign(r,a); text=a.reg+' '+a.label+(a.flight ? ' '+a.flight : '')+(a.txt ? ' · '+a.txt : ''); }
      else { kind='data'; r.proto='ACARS'; text='ACARS (broken)'; }
    } else { kind='data'; r.proto=body.length ? 'X.25/ATN' : ''; text='data '+body.length+' B'; }
  }
  r.kind=kind;
  if(kind!=='message') r.hex=vdl2Hex(body,0,Math.min(body.length,96));
  r.text=r.from+'>'+r.to+' '+text;
  return r;
}
// блок ACARS внутри AVLC: …, ETX/ETB, BCS (2 байта), DEL
function vdl2Acars(b){
  const n=b.length;
  if(n<16 || b[n-1]!==0x7f) return null;
  const crcOk=crc16r(b,0,n-1,0x8408,0,0)===0;
  const by=Array.from(b.subarray(0,n-3),v=>v&0x7f);
  if(by[by.length-1]!==3 && by[by.length-1]!==0x17) return null;
  const m=vacParse(by);
  if(!m) return null;
  const o={id:m.reg, reg:m.reg, mode:m.mode, ack:m.ack, label:m.label, blk:m.blk, dir:m.dir, txt:m.txt};
  if(m.no) o.no=m.no;
  if(m.flight) o.flight=m.flight;
  if(m.etb) o.etb=true;
  if(!crcOk) o.crcBad=true;
  return o;
}

// ---- приёмник ----
function vdl2Reset(v){            // новый поиск преамбулы
  v.ds=0; v.dec=0; v.reqBits=VDL2_HDR; v.fixes=0; vdl2BsReset(v.bs);
  v.sclk=0; v.pherr=[VDL2_PHMAX,VDL2_PHMAX,VDL2_PHMAX]; v.pwr=0; v.pwrN=0;
}
const VDL2_LRX=(()=>{ let m=0; for(let i=0;i<VDL2_PRE;i++) m+=i; m/=VDL2_PRE; const X=[]; let den=0; for(let i=0;i<VDL2_PRE;i++){ X.push(i-m); den+=(i-m)*(i-m); } return {X,den}; })();
function vdl2ParaVertex(x,d,y1,y2,y3){
  const den=d*2*d*(-d);
  const A=(x*(y2-y1)+(x-d)*(y1-y3)+(x-2*d)*(y3-y2))/den;
  const B=(x*x*(y1-y2)+(x-d)*(x-d)*(y3-y1)+(x-2*d)*(x-2*d)*(y2-y3))/den;
  return -B/(2*A);
}
function vdl2GotSync(v){
  const err=new Float64Array(VDL2_PRE), sb=v.sb, L=VDL2_SBL;
  let prev=sb[(v.sbi+VDL2_SPS)%L]-VDL2_PREPH[0], mean=prev, unwrap=0;
  err[0]=prev;
  for(let i=1;i<VDL2_PRE;i++){
    const cur=sb[(v.sbi+(i+1)*VDL2_SPS)%L]-VDL2_PREPH[i], dd=cur-prev;
    prev=cur;
    if(dd>Math.PI) unwrap-=2*Math.PI; else if(dd<-Math.PI) unwrap+=2*Math.PI;
    err[i]=cur+unwrap; mean+=err[i];
  }
  mean/=VDL2_PRE;
  for(let i=0;i<VDL2_PRE;i++) err[i]-=mean;
  let fe=0;
  for(let i=0;i<VDL2_PRE;i++) fe+=VDL2_LRX.X[i]*err[i];
  fe/=VDL2_LRX.den;
  v.pherr[0]=0;
  for(let i=0;i<VDL2_PRE;i++){ const e=err[i]-fe*VDL2_LRX.X[i]; v.pherr[0]+=e*e; }
  if(v.pherr[1]<VDL2_THR && v.pherr[0]>v.pherr[1]){
    let vx=vdl2ParaVertex(v.sclk,VDL2_SKIP,v.pherr[2],v.pherr[1],v.pherr[0]);
    if(!isFinite(vx)) vx=0;
    v.sclk=-Math.round(vx);
    let sp=(v.sbi-v.sclk)%L; if(sp<0) sp+=L;
    v.prevPhi=sb[sp];
    v.dphi=v.prevDphi;
    v.pherr[1]=v.pherr[2]=VDL2_PHMAX;
    return true;
  }
  v.pherr[2]=v.pherr[1];
  v.pherr[1]=v.pherr[0];
  v.prevDphi=fe;
  return false;
}
// разбор принятого пакета: заголовок, данные, FEC → кадры (Uint8Array[]) или null
function vdl2Burst(v){
  const bs=v.bs;
  if(v.dec===0){                                                  // заголовок
    v.st.lfsr=VDL2_IV; vdl2Descramble(bs,v.st);
    let h=0;
    for(let i=0;i<VDL2_HDR;i++) h=(h<<1)|bs.buf[bs.start+i];
    bs.start+=VDL2_HDR;
    const mask=(1<<(VDL2_TRLEN+VDL2_FECLEN))-1;
    h&=mask;                                                      // резервный символ — нули
    let syn=0;
    for(let i=0;i<VDL2_FECLEN;i++) syn|=vdl2Par(h&VDL2_H[i])<<(VDL2_FECLEN-1-i);
    h=(h^VDL2_SYND[syn])>>>0;
    v.syn=syn;
    if((h&mask)!==h){ v.cnt.badHdr++; v.dec=2; return null; }
    h>>>=VDL2_FECLEN;
    v.datalen=vdl2Rev(h&((1<<VDL2_TRLEN)-1),VDL2_TRLEN);
    if((syn!==0 && v.datalen>VDL2_MAXLEN_C) || v.datalen>VDL2_MAXLEN){ v.cnt.badHdr++; v.dec=2; return null; }
    v.dOct=Math.ceil(v.datalen/8);
    v.nBlk=Math.floor(v.dOct/VDL2_RS_K);
    v.fecOct=v.nBlk*(VDL2_RS_N-VDL2_RS_K);
    v.lastLen=v.dOct%VDL2_RS_K;
    if(v.lastLen!==0) v.nBlk++;
    v.fecOct+=vdl2FecOct(v.lastLen);
    if(v.lastLen===0) v.lastLen=VDL2_RS_K;
    if(v.fecOct===0){ v.cnt.badHdr++; v.dec=2; return null; }
    v.reqBits=8*(v.dOct+v.fecOct);
    v.dec=1;
    return null;
  }
  // данные
  vdl2Descramble(bs,v.st);
  const data=new Uint8Array(v.dOct), fec=new Uint8Array(v.fecOct);
  v.dec=2;
  if(!vdl2ReadLsb(bs,data,v.dOct) || !vdl2ReadLsb(bs,fec,v.fecOct)) return null;
  const tab=new Uint8Array(v.nBlk*VDL2_RS_N);
  const m1=vdl2Map(v.dOct,v.nBlk,VDL2_RS_K,0);
  if(typeof m1==='number'){ v.cnt.badFec++; return null; }
  for(let i=0;i<v.dOct;i++) tab[m1.R[i]*VDL2_RS_N+m1.C[i]]=data[i];
  let fecRows=v.nBlk;
  if(vdl2FecOct(v.lastLen)===0) fecRows--;
  if(fecRows>0){
    const m2=vdl2Map(v.fecOct,fecRows,VDL2_RS_N-VDL2_RS_K,VDL2_RS_K);
    if(typeof m2==='number'){ v.cnt.badFec++; return null; }
    for(let i=0;i<v.fecOct;i++) tab[m2.R[i]*VDL2_RS_N+m2.C[i]]=fec[i];
  }
  vdl2BsReset(bs);
  for(let r=0;r<v.nBlk;r++){
    const nf=r===v.nBlk-1 ? vdl2FecOct(v.lastLen) : VDL2_RS_N-VDL2_RS_K;
    const cw=tab.subarray(r*VDL2_RS_N,(r+1)*VDL2_RS_N);
    if(nf>0){
      const er=[]; for(let i=VDL2_RS_K+nf;i<VDL2_RS_N;i++) er.push(i);
      const ret=vdl2RsFix(cw,er);
      if(ret<0){ v.cnt.badFec++; return null; }
      if(ret>0) v.fixes+=Math.max(0,ret-er.length);
    }
    if(!vdl2AppendLsb(bs,cw,0,r!==v.nBlk-1 ? VDL2_RS_K : v.lastLen)){ v.cnt.badFec++; return null; }
  }
  if(v.datalen<bs.end-bs.start) bs.end=bs.start+v.datalen;
  const frames=[];
  for(;;){
    const f=vdl2NextFrame(bs);
    if(!f){ v.cnt.badStuff++; return frames.length ? frames : null; }
    if(f.bits.length%8!==0){ v.cnt.badStuff++; return frames.length ? frames : null; }
    const by=new Uint8Array(f.bits.length/8);
    for(let i=0;i<by.length;i++){ let x=0; for(let j=0;j<8;j++) x|=f.bits[8*i+j]<<j; by[i]=x; }
    frames.push(by);
    if(!f.more) break;
  }
  return frames;
}
function vdl2Sample(n,v,re,im,recs,now){
  if(v.dec===2) vdl2Reset(v);
  if(v.ds===0){                                                    // поиск преамбулы
    v.sbi=(v.sbi+1)%VDL2_SBL; v.sb[v.sbi]=Math.atan2(im,re);
    if(++v.sclk<VDL2_SKIP) return;
    v.sclk=0;
    v.mag=v.mag*.9+Math.hypot(re,im)*.1;
    if(vdl2GotSync(v)) v.ds=1;
    return;
  }
  if(++v.sclk<VDL2_SPS) return;
  v.sclk=0;
  const phi=Math.atan2(im,re);
  let d=phi-v.prevPhi-v.dphi;
  if(d<0) d+=2*Math.PI; else if(d>2*Math.PI) d-=2*Math.PI;
  d/=Math.PI/4;
  const idx=Math.round(d)%8;
  v.pwr=(v.pwr*v.pwrN+re*re+im*im)/(v.pwrN+1); v.pwrN++;
  v.prevPhi=phi;
  const bs=v.bs, g=VDL2_GRAY[idx<0 ? idx+8 : idx];
  if(bs.end+3>bs.buf.length){ v.dec=2; return; }
  bs.buf[bs.end++]=(g>>2)&1; bs.buf[bs.end++]=(g>>1)&1; bs.buf[bs.end++]=g&1;
  if(bs.end-bs.start>=v.reqBits){
    v.cnt.bursts++;
    const frames=vdl2Burst(v);
    if(v.dec===1) return;                                          // заголовок принят, ждём данные
    v.dec=2;
    if(frames){
      const meta={rssi:+(10*Math.log10(Math.max(v.pwr,1e-9))).toFixed(1), df:Math.round(v.dphi*VDL2_BAUD/(2*Math.PI)), fixed:v.fixes};
      for(const f of frames){
        const r=vdl2Avlc(f,meta);
        if(r){ n.frames++; v.cnt.good++; if(v.fixes) n.fixed++; if(r.kind==='message') n.acars++; recs.push(r); n.last=now;
          n.recent.push(new Date(now).toTimeString().slice(0,8)+' '+r.text.slice(0,100)); if(n.recent.length>20) n.recent.shift(); }
        else v.cnt.badFcs++;
      }
    }
  }
}

IQK.vdl2Rx={
  init(n){
    n.key=''; n.frames=0; n.fixed=0; n.acars=0; n.last=0; n.recent=[]; n.rt=0; n.ui=null;
    n.vd={bs:vdl2Bs(32768), sb:new Float64Array(VDL2_SBL), sbi:0, st:{lfsr:0}, prevPhi:0, dphi:0, prevDphi:0, mag:0,
      cnt:{bursts:0, good:0, badHdr:0, badFec:0, badStuff:0, badFcs:0}};
    vdl2Reset(n.vd);
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s || !s.sr){ n.ui=null; return {rec:null, text:null, locked:0}; }
    const sr=s.sr, v=n.vd, recs=[], now=Date.now();
    if(sr<24e3){ n.ui={err:'sample rate '+(sr/1000).toFixed(1)+' kS/s is too low: VDL2 needs ≥ 48 kS/s', fs:sr, frames:n.frames, recent:n.recent}; return {rec:null, text:null, locked:0}; }
    if(n.key!==String(sr)){                                        // ФНЧ 8 кГц и шаг передискретизации
      n.key=String(sr); n.q=biquadCoef('lp',Math.min(8000,.45*sr),.7071,sr);
      n.zr=new Float64Array(4); n.zi=new Float64Array(4); n.step=sr/VDL2_FS; n.rt=0;
      n.hr=new Float64Array(4); n.hi=new Float64Array(4);          // последние 4 отфильтрованных отсчёта (кубическая интерполяция)
    }
    const q=n.q, zr=n.zr, zi=n.zi, hr=n.hr, hi=n.hi, step=n.step;
    for(const c of s.chunks){
      const xr=c.re, xi=iqChunkIm(c), K=xr.length;
      for(let i=0;i<K;i++){
        const yr=iqBq(zr,0,q,xr[i]), yi=iqBq(zi,0,q,xi[i]);
        hr[0]=hr[1]; hr[1]=hr[2]; hr[2]=hr[3]; hr[3]=yr;
        hi[0]=hi[1]; hi[1]=hi[2]; hi[2]=hi[3]; hi[3]=yi;
        // выходной отсчёт лежит между hr[1] и hr[2] при n.rt∈[0,1); n.rt — позиция относительно hr[1]
        while(n.rt<1){
          const t=n.rt;
          const cr=.5*(hr[2]-hr[0]), c2r=hr[0]-2.5*hr[1]+2*hr[2]-.5*hr[3], c3r=.5*(hr[3]-hr[0])+1.5*(hr[1]-hr[2]);
          const ci=.5*(hi[2]-hi[0]), c2i=hi[0]-2.5*hi[1]+2*hi[2]-.5*hi[3], c3i=.5*(hi[3]-hi[0])+1.5*(hi[1]-hi[2]);
          vdl2Sample(n,v,((c3r*t+c2r)*t+cr)*t+hr[1],((c3i*t+c2i)*t+ci)*t+hi[1],recs,now);
          n.rt+=step;
        }
        n.rt-=1;
      }
    }
    const nz=Math.max(v.mag,1e-9);
    n.ui={fs:sr, frames:n.frames, fixed:n.fixed, acars:n.acars, bursts:v.cnt.bursts, bad:v.cnt.badHdr+v.cnt.badFec+v.cnt.badStuff+v.cnt.badFcs, cnt:{...v.cnt},
      lvl:20*Math.log10(nz), recent:n.recent, age:n.last ? now-n.last : null, state:v.ds===0 ? 'search' : v.dec===0 ? 'header' : 'data'};
    const text=recs.map(r=>r.text);
    return {rec:recs.length ? recs : null, text:text.length ? text.join('\n') : null, locked:n.last && now-n.last<5000 ? 1 : 0};
  }};

/* ---- передатчик (тест и генератор): кадры AVLC → пакет D8PSK ---- */
const VDL2_SIM=[
  {from:0x4840D6, to:0x1B4002, text:{mode:'2', reg:'.PH-BXA', ack:0x15, label:'H1', blk:'3', flight:'KL1234', body:'#M1BPOS N52123E004456,FL360,ETA1432'}},
  {from:0x1B4002, to:0x4840D6, text:{mode:'2', reg:'.PH-BXA', ack:'3', label:'5Z', blk:'B', body:'GATE B23 LAND 1432Z'}},
  {from:0x3C4DD2, to:0x1B4002, text:{mode:'2', reg:'.D-AIZF', ack:0x15, label:'QA', blk:'1', flight:'LH0401', body:'OUT0745 OFF0802'}}];
function vdl2AddrBytes(a,last){        // type, status, addr → 4 октета (LSB — признак продолжения)
  const val=(a.addr&0xFFFFFF)|((a.type&7)<<24)|((a.status&1)<<27), x=vdl2Rev(val,28);
  return [((x&0x7f)<<1), (((x>>7)&0x7f)<<1), (((x>>14)&0x7f)<<1), ((((x>>21)&0x7f)<<1)|1)];
}
function vdl2AcarsBytes(m,k){
  const code=s=>typeof s==='number' ? s : s.charCodeAt(0), c=[code(m.mode)];
  for(const ch of m.reg) c.push(ch.charCodeAt(0));
  c.push(code(m.ack), m.label.charCodeAt(0), m.label.charCodeAt(1), code(m.blk));
  let txt=m.body;
  if(m.blk<='9') txt='M'+String(k%100).padStart(2,'0')+'A'+(m.flight||'').padEnd(6,' ')+txt;
  if(txt){ c.push(2); for(const ch of txt) c.push(ch.charCodeAt(0)); }
  c.push(3);
  const by=c.map(vacPar), crc=vacCrc(by,by.length);
  by.push(crc&0xFF,crc>>8,0x7f);
  return by;
}
// кадр I с ACARS (адреса — {addr,type,status}) → байты с FCS
function vdl2BuildFrame(dst,src,sseq,rseq,payload){
  const b=[...vdl2AddrBytes(dst),...vdl2AddrBytes(src),((rseq&7)<<5)|((sseq&7)<<1),...payload];
  const fcs=vdl2Crc(b,b.length)^0xFFFF;
  b.push(fcs&0xFF,fcs>>8);
  return Uint8Array.from(b);
}
// кадры (байты) → индексы разностной фазы (0…7) пакета, включая преамбулу: [символы фазы]
function vdl2BuildBurst(frames){
  const bits=[];
  const flag=[0,1,1,1,1,1,1,0];
  for(const b of flag) bits.push(b);
  for(const f of frames){
    let ones=0;
    for(const by of f) for(let j=0;j<8;j++){ const bit=(by>>j)&1; bits.push(bit); if(bit){ if(++ones===5){ bits.push(0); ones=0; } } else ones=0; }
    for(const b of flag) bits.push(b);
  }
  const datalen=bits.length, dOct=Math.ceil(datalen/8);
  const data=new Uint8Array(dOct);
  for(let i=0;i<datalen;i++) data[i>>3]|=bits[i]<<(i&7);
  const nBlk=Math.ceil(dOct/VDL2_RS_K), lastLen=dOct%VDL2_RS_K || VDL2_RS_K;
  const tab=new Uint8Array(nBlk*VDL2_RS_N);
  for(let r=0;r<nBlk;r++){
    const len=r===nBlk-1 ? lastLen : VDL2_RS_K, cw=tab.subarray(r*VDL2_RS_N,(r+1)*VDL2_RS_N);
    cw.set(data.subarray(r*VDL2_RS_K,r*VDL2_RS_K+len));
    VDL2_RS.encode(cw);
  }
  const nfLast=vdl2FecOct(lastLen);
  const fecTotal=(nBlk-1)*(VDL2_RS_N-VDL2_RS_K)+nfLast;
  const m1=vdl2Map(dOct,nBlk,VDL2_RS_K,0);
  const outData=new Uint8Array(dOct);
  for(let i=0;i<dOct;i++) outData[i]=tab[m1.R[i]*VDL2_RS_N+m1.C[i]];
  let fecRows=nBlk; if(nfLast===0) fecRows--;
  const outFec=new Uint8Array(fecTotal);
  if(fecRows>0 && fecTotal>0){
    const m2=vdl2Map(fecTotal,fecRows,VDL2_RS_N-VDL2_RS_K,VDL2_RS_K);
    for(let i=0;i<fecTotal;i++) outFec[i]=tab[m2.R[i]*VDL2_RS_N+m2.C[i]];
  }
  // заголовок: резерв 000, длина (биты в обратном порядке), проверка
  let h=(vdl2Rev(datalen,VDL2_TRLEN)<<VDL2_FECLEN)>>>0;
  for(let i=0;i<VDL2_FECLEN;i++) if(vdl2Par(h&VDL2_H[i])) h|=1<<(VDL2_FECLEN-1-i);
  const all=[];
  for(let i=VDL2_HDR-1;i>=0;i--) all.push((h>>i)&1);
  for(const by of outData) for(let j=0;j<8;j++) all.push((by>>j)&1);
  for(const by of outFec) for(let j=0;j<8;j++) all.push((by>>j)&1);
  let lf=VDL2_IV;
  for(let i=0;i<all.length;i++){ const bit=((lf>>0)^(lf>>14))&1; lf=(lf>>1)|(bit<<14); all[i]^=bit; }
  while(all.length%3) all.push(0);
  const inv=[]; VDL2_GRAY.forEach((g,i)=>{ inv[g]=i; });
  const sym=[];
  for(let i=0;i<all.length;i+=3) sym.push(inv[(all[i]<<2)|(all[i+1]<<1)|all[i+2]]);
  return sym;
}
// RRC α=0.6 в таблице (шаг 1/64 символа, ±6 символов)
const VDL2_RRC=(()=>{
  const a=.6, R=64, H=6, t=new Float32Array(2*H*R+1);
  for(let i=0;i<t.length;i++){
    const x=(i-H*R)/R;
    let v;
    if(Math.abs(x)<1e-9) v=1-a+4*a/Math.PI;
    else if(Math.abs(Math.abs(x)-1/(4*a))<1e-6) v=a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
    else v=(Math.sin(Math.PI*x*(1-a))+4*a*x*Math.cos(Math.PI*x*(1+a)))/(Math.PI*x*(1-(4*a*x)*(4*a*x)));
    t[i]=v;
  }
  let e=0; for(const v of t) e+=v*v; const k=1/Math.sqrt(e/R);
  for(let i=0;i<t.length;i++) t[i]*=k;
  return t;
})();
// символы разностной фазы → комплексный сигнал на частоте sr (преамбула добавляется здесь); [re,im]
function vdl2Modulate(sym,sr,lead,tail){
  const ph=[...VDL2_PREPH];
  let p=0;
  for(const d of sym){ p+=d*Math.PI/4; ph.push(p); }
  const spsr=sr/VDL2_BAUD, nl=Math.round(lead*spsr), nt=Math.round(tail*spsr), N=Math.round((ph.length+12)*spsr)+nl+nt;
  const re=new Float32Array(N), im=new Float32Array(N), R=64, H=6;
  const cs=ph.map(Math.cos), sn=ph.map(Math.sin);
  for(let i=0;i<N-nt;i++){
    const tau=(i-nl)/spsr-6;
    const k0=Math.ceil(tau-H), k1=Math.floor(tau+H);
    let ar=0, ai=0;
    for(let k=Math.max(0,k0);k<=Math.min(ph.length-1,k1);k++){
      const w=VDL2_RRC[Math.round((tau-k+H)*R)]; if(w===undefined) continue;
      ar+=w*cs[k]; ai+=w*sn[k];
    }
    re[i]=ar; im[i]=ai;
  }
  return [re,im];
}
// генератор IQ для IQ Generator: пакеты с ACARS через паузу, амплитуда 1
function vdl2Generate(n,sr,N){
  let g=n.vdl2G;
  if(!g || g.sr!==sr) g=n.vdl2G={sr, k:0, buf:null, pos:0};
  const re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){
    if(!g.buf || g.pos>=g.buf[0].length){
      const m=VDL2_SIM[g.k%VDL2_SIM.length];
      const pay=[0xff,0xff,0x01,...vdl2AcarsBytes(m.text,g.k)];
      const fr=vdl2BuildFrame({addr:m.to,type:m.to===0x1B4002 ? 4 : 1,status:0},{addr:m.from,type:m.from===0x1B4002 ? 4 : 1,status:0},g.k&7,(g.k+1)&7,pay);
      g.buf=vdl2Modulate(vdl2BuildBurst([fr]),sr,Math.round(.05*VDL2_BAUD),Math.round(.4*VDL2_BAUD)); g.pos=0; g.k++;
    }
    re[i]=g.buf[0][g.pos]; im[i]=g.buf[1][g.pos]; g.pos++;
  }
  return [re,im];
}
