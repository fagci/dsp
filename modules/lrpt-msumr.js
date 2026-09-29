"use strict";
/* ============================ Meteor-M LRPT: MSU-MR (картинка) ============================
   Чистый код, без DOM: грузится и страницей, и воркером (генератор LRPT в iq-kernels).
   По SatDump (GPLv3): plugins/meteor_support/meteor/instruments/msumr/lrpt (segment, huffman,
   tables, lrpt_msumr_reader), common/ccsds/ccsds_aos/demuxer.
   VCDU VCID 5 → M_PDU (882 байта данных, первый заголовок пакета — 11 бит) → пакеты CCSDS →
   APID 64…69 — каналы 1…6. Пакет-сегмент: время (8 байт), MCUN, QT, DC/AC, QFM=FFF0, QF, затем
   14 блоков 8×8, сжатых как JPEG без маркеров: таблицы Хаффмана и квантования — стандартные
   (яркость), качество QF. Строка — 196 блоков (1568 точек) × 8 строк: 14 пакетов на канал.
   Цикл передачи — 43 пакета (14 × 3 канала + телеметрия APID 70). */

const MSU_W=1568, MSU_SEG=14, MSU_LOOP=43, MSU_APID0=64;
// натуральный номер коэффициента → позиция в зигзаге
const MSU_ZZ=[0,1,5,6,14,15,27,28, 2,4,7,13,16,26,29,42, 3,8,12,17,25,30,41,43, 9,11,18,24,31,40,44,53,
  10,19,23,32,39,45,52,54, 20,22,33,38,46,51,55,60, 21,34,37,47,50,56,59,61, 35,36,48,49,57,58,62,63];
const MSU_Q=[16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55, 14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92, 49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99];
// Хаффман JPEG (яркость, приложение K): BITS и HUFFVAL — те же коды, что в tables.h SatDump
const MSU_DC_BITS=[0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0], MSU_DC_VAL=[0,1,2,3,4,5,6,7,8,9,10,11];
const MSU_AC_BITS=[0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,125];
const MSU_AC_VAL=[1,2,3,0,4,17,5,18,33,49,65,6,19,81,97,7,34,113,20,50,129,145,161,8,35,66,177,193,21,82,209,240,
  36,51,98,114,130,9,10,22,23,24,25,26,37,38,39,40,41,42,52,53,54,55,56,57,58,67,68,69,70,71,72,73,74,83,84,85,86,87,
  88,89,90,99,100,101,102,103,104,105,106,115,116,117,118,119,120,121,122,131,132,133,134,135,136,137,138,146,147,
  148,149,150,151,152,153,154,162,163,164,165,166,167,168,169,170,178,179,180,181,182,183,184,185,186,194,195,196,
  197,198,199,200,201,202,210,211,212,213,214,215,216,217,218,225,226,227,228,229,230,231,232,233,234,241,242,243,
  244,245,246,247,248,249,250];
// канонические коды: для декодера — max/min кода по длине, для кодера — код и длина по символу
function msuHuff(bits,vals){
  const maxc=new Int32Array(17).fill(-1), minc=new Int32Array(17), ptr=new Int32Array(17), code=new Int32Array(256), len=new Uint8Array(256);
  let c=0, k=0;
  for(let L=1;L<=16;L++){
    ptr[L]=k; minc[L]=c;
    for(let i=0;i<bits[L-1];i++,k++,c++){ code[vals[k]]=c; len[vals[k]]=L; }
    maxc[L]=bits[L-1] ? c-1 : -1;
    c<<=1;
  }
  return {maxc, minc, ptr, vals, code, len};
}
const MSU_HDC=msuHuff(MSU_DC_BITS,MSU_DC_VAL), MSU_HAC=msuHuff(MSU_AC_BITS,MSU_AC_VAL);
// таблица квантования по QF (как GetQuantizationTable в SatDump, вместе с его ветками)
function msuQTable(qf){
  const f=qf>=20 && qf<50 ? 5000/qf : 200-2*qf, t=new Int32Array(64);
  for(let i=0;i<64;i++) t[i]=Math.max(1,Math.floor(f/100*MSU_Q[i]+.5));
  return t;
}
// ОДПФ 8×8: M[x][u] = C(u)/2·cos((2x+1)uπ/16)
const MSU_COS=(()=>{ const m=new Float64Array(64);
  for(let x=0;x<8;x++) for(let u=0;u<8;u++) m[x*8+u]=(u ? .5 : Math.SQRT1_2/2)*Math.cos((2*x+1)*u*Math.PI/16);
  return m; })();

/* ---- декодер сегмента ---- */
// {ok, mcus, qf, ms, pix: Uint8Array(8·112)}; ok=false — заголовок не MSU-MR или первый блок битый
function msuDecodeSegment(p){
  if(p.length<15) return {ok:false};
  if(p[9]!==0 || p[10]!==0 || p[11]!==0xFF || p[12]!==0xF0) return {ok:false};
  const qf=p[13], qt=msuQTable(qf), pix=new Uint8Array(8*MSU_SEG*8);
  const ms=((p[2]<<24)>>>0)+(p[3]<<16)+(p[4]<<8)+p[5];
  let pos=14*8;                                      // в битах
  const end=p.length*8;
  const bit=()=>{ if(pos>=end) return -1; const b=(p[pos>>3]>>(7-(pos&7)))&1; pos++; return b; };
  const huff=h=>{ let c=0;
    for(let L=1;L<=16;L++){ const b=bit(); if(b<0) return -1; c=(c<<1)|b;
      if(h.maxc[L]>=0 && c<=h.maxc[L]) return h.vals[h.ptr[L]+c-h.minc[L]]; }
    return -1; };
  const val=s=>{ let v=0; for(let i=0;i<s;i++){ const b=bit(); if(b<0) return null; v=(v<<1)|b; }
    return v<(1<<(s-1)) ? v-(1<<s)+1 : v; };
  const zz=new Float64Array(64), nat=new Float64Array(64), tmp=new Float64Array(64);
  let dc=0, mcus=0;
  for(let m=0;m<MSU_SEG;m++){
    zz.fill(0);
    const s=huff(MSU_HDC); if(s<0) break;
    const d=s ? val(s) : 0; if(d===null) break;
    dc+=d; zz[0]=dc;
    let k=1, bad=false;
    while(k<64){
      const rs=huff(MSU_HAC); if(rs<0){ bad=true; break; }
      const r=rs>>4, sz=rs&15;
      if(!sz){ if(r===15){ k+=16; continue; } break; }   // ZRL / EOB
      k+=r; if(k>63){ bad=true; break; }
      const v=val(sz); if(v===null){ bad=true; break; }
      zz[k++]=v;
    }
    if(bad) break;
    for(let i=0;i<64;i++) nat[i]=zz[MSU_ZZ[i]]*qt[i];
    // строки, затем столбцы: nat[v*8+u] → точки [y*8+x]
    for(let v=0;v<8;v++) for(let x=0;x<8;x++){ let a=0; for(let u=0;u<8;u++) a+=MSU_COS[x*8+u]*nat[v*8+u]; tmp[v*8+x]=a; }
    for(let y=0;y<8;y++) for(let x=0;x<8;x++){
      let a=0; for(let v=0;v<8;v++) a+=MSU_COS[y*8+v]*tmp[v*8+x];
      const q=Math.round(a+128);
      pix[y*MSU_SEG*8+m*8+x]=q<0 ? 0 : q>255 ? 255 : q;
    }
    mcus++;
  }
  return {ok:mcus>0, mcus, qf, ms, pix};
}

/* ---- кодер сегмента (для генератора) ---- */
// src(x, y) — точка 0…255 сегмента 112×8; → байты заголовка сегмента и сжатых блоков
function msuEncodeSegment(src,qf,ms,mcun){
  const qt=msuQTable(qf), out=[];
  let acc=0, n=0;
  const put=(c,L)=>{ for(let i=L-1;i>=0;i--){ acc=(acc<<1)|((c>>i)&1); if(++n===8){ out.push(acc); acc=0; n=0; } } };
  const cat=v=>{ let a=Math.abs(v), s=0; while(a){ s++; a>>=1; } return s; };
  const amp=(v,s)=>v>=0 ? v : v+(1<<s)-1;
  const blk=new Float64Array(64), tmp=new Float64Array(64), zz=new Int32Array(64);
  let prev=0;
  for(let m=0;m<MSU_SEG;m++){
    for(let y=0;y<8;y++) for(let x=0;x<8;x++) blk[y*8+x]=src(m*8+x,y)-128;
    // прямое ДКП: F[v*8+u] = Σ M[y][v]·M[x][u]·f[y][x]
    for(let y=0;y<8;y++) for(let u=0;u<8;u++){ let a=0; for(let x=0;x<8;x++) a+=MSU_COS[x*8+u]*blk[y*8+x]; tmp[y*8+u]=a; }
    for(let v=0;v<8;v++) for(let u=0;u<8;u++){
      let a=0; for(let y=0;y<8;y++) a+=MSU_COS[y*8+v]*tmp[y*8+u];
      zz[MSU_ZZ[v*8+u]]=Math.round(a/qt[v*8+u]);
    }
    const d=zz[0]-prev; prev=zz[0];
    const s=cat(d); put(MSU_HDC.code[s],MSU_HDC.len[s]); if(s) put(amp(d,s),s);
    let run=0;
    for(let k=1;k<64;k++){
      const v=zz[k];
      if(!v){ run++; continue; }
      while(run>15){ put(MSU_HAC.code[0xF0],MSU_HAC.len[0xF0]); run-=16; }
      const sz=cat(v), sym=(run<<4)|sz;
      put(MSU_HAC.code[sym],MSU_HAC.len[sym]); put(amp(v,sz),sz); run=0;
    }
    if(run) put(MSU_HAC.code[0],MSU_HAC.len[0]);    // EOB
  }
  if(n) put((1<<(8-n))-1,8-n);                       // добивка единицами
  const h=[0,0, (ms>>>24)&255,(ms>>16)&255,(ms>>8)&255,ms&255, 0,0, mcun, 0, 0, 0xFF, 0xF0, qf];
  return Uint8Array.from(h.concat(out));
}
// пакет CCSDS: заголовок 6 байт (флаг вторичного заголовка, «отдельный пакет»)
function msuPacket(apid,seq,payload){
  const p=new Uint8Array(6+payload.length), L=payload.length-1;
  p[0]=0x08|((apid>>8)&7); p[1]=apid&255; p[2]=0xC0|((seq>>8)&0x3F); p[3]=seq&255; p[4]=(L>>8)&255; p[5]=L&255;
  p.set(payload,6);
  return p;
}

/* ---- разбор M_PDU на пакеты ---- */
// st: {buf, cnt}; vcdu — 892 байта (заголовок 6, вставка 2, M_PDU 2 + 882). → [{apid, seq, data}]
function msuDemux(st,vcdu){
  const out=[], cnt=(vcdu[2]<<16)|(vcdu[3]<<8)|vcdu[4], fhp=((vcdu[8]&7)<<8)|vcdu[9], data=vcdu.subarray(10,10+882);
  const gap=st.cnt==null || cnt!==((st.cnt+1)&0xFFFFFF);
  if(gap && st.cnt!=null) st.lost=(st.lost||0)+1;
  st.cnt=cnt;
  let b=st.buf;
  if(gap || !b){                                     // начало или пропуск: ждём заголовка по указателю
    if(fhp===2047 || fhp>=882){ st.buf=null; return out; }
    b=data.slice(fhp);
  } else {
    // сверка: где по нашему счёту кончается текущий пакет — там и должен быть заголовок
    if(fhp<882 && b.length>=6){
      const need=6+((b[4]<<8)|b[5])+1-b.length;
      if(need>=0 && need!==fhp){ b=data.slice(fhp); st.resync=(st.resync||0)+1; }
      else b=msuCat(b,data);
    } else b=msuCat(b,data);
  }
  let o=0;
  while(b.length-o>=6){
    const ver=b[o]>>5, len=((b[o+4]<<8)|b[o+5])+1;
    if(ver!==0 || len>8192){ st.buf=null; st.resync=(st.resync||0)+1; return out; }
    if(b.length-o<6+len) break;
    out.push({apid:((b[o]&7)<<8)|b[o+1], seq:((b[o+2]&0x3F)<<8)|b[o+3], data:b.slice(o+6,o+6+len)});
    o+=6+len;
  }
  st.buf=b.slice(o);
  return out;
}
function msuCat(a,b){ const c=new Uint8Array(a.length+b.length); c.set(a); c.set(b,a.length); return c; }

/* ---- сборка строк ---- */
// Номер строки по счётчику пакетов: у каждого канала свой сдвиг в 43-пакетном цикле; каналы,
// которые в цикле идут раньше канала с наименьшим сдвигом, — на строку ниже (как в SatDump).
function msuNew(){ return {ch:new Map(), seqAbs:null, rows:0, base:null, good:0, bad:0, qf:0, dirty:new Set()}; }
function msuAdd(im,pk){
  const c=pk.apid-MSU_APID0;
  if(c<0 || c>5) return false;
  const seg=msuDecodeSegment(pk.data);
  if(!seg.ok){ im.bad++; return false; }
  const mcu=pk.data[8]/MSU_SEG;
  if(mcu!==Math.floor(mcu) || mcu>=MSU_SEG){ im.bad++; return false; }
  // 14-битный счётчик → непрерывный
  if(im.seqAbs==null) im.seqAbs=pk.seq;
  else { let d=pk.seq-(im.seqAbs&0x3FFF); if(d<-8192) d+=16384; else if(d>8192) d-=16384; im.seqAbs+=d; }
  const s=im.seqAbs;
  let ch=im.ch.get(c);
  if(!ch){ ch={off:((s-mcu)%MSU_LOOP+MSU_LOOP)%MSU_LOOP, rows:new Map()}; im.ch.set(c,ch); }
  let low=null; for(const [k,v] of im.ch) if(low==null || v.off<im.ch.get(low).off) low=k;
  const line=Math.floor((s-ch.off)/MSU_LOOP)+(c<low ? 1 : 0);
  if(im.base==null) im.base=line-1;
  const r=line-im.base;
  if(r<0 || r>1500) return false;                    // вне окна (сбой счётчика)
  let row=ch.rows.get(r);
  if(!row){ row=new Uint8Array(MSU_W*8); ch.rows.set(r,row); }
  for(let y=0;y<8;y++) row.set(seg.pix.subarray(y*MSU_SEG*8,(y+1)*MSU_SEG*8),y*MSU_W+mcu*MSU_SEG*8);
  im.rows=Math.max(im.rows,r+1); im.good++; im.qf=seg.qf; im.dirty.add(r);
  return true;
}
// точка канала c (0…5) в (x, y) всего изображения; нет данных — 0
function msuPixel(im,c,x,y){
  const ch=im.ch.get(c); if(!ch) return 0;
  const row=ch.rows.get(y>>3); return row ? row[(y&7)*MSU_W+x] : 0;
}

/* ---- тестовый поток для генератора ---- */
// Картинка: у каждого канала свой узор (градиенты, кольца, сетка) — цветная в RGB, строки по кругу.
const MSU_SIM_ROWS=120, MSU_SIM_QF=80, MSU_SIM_APIDS=[64,65,66];
function msuSimPixel(c,x,y){
  y%=MSU_SIM_ROWS*8;
  const cx=x-784, cy=y-480, r=Math.sqrt(cx*cx+cy*cy);
  if(c===0) return Math.round(40+180*x/MSU_W*(.6+.4*Math.cos(r/40)));
  if(c===1) return Math.round(128+100*Math.sin(y/37)*Math.cos(x/53));
  return (((x>>5)+(y>>5))&1) ? 200 : Math.round(60+60*Math.sin(r/25));
}
// бесконечный поток байт M_PDU: строка за строкой, по 43 пакета; окно байт сдвигается вперёд
const MSU_SIM={pos:0, base:0, buf:new Uint8Array(0), line:0, seq:0, hdr:[]};
function msuSimLine(){
  const S=MSU_SIM, parts=[], ms=S.line*1540;
  for(const apid of MSU_SIM_APIDS){
    const c=apid-MSU_APID0;
    for(let m=0;m<MSU_SEG;m++){
      const x0=m*MSU_SEG*8, y0=S.line*8;
      const seg=msuEncodeSegment((x,y)=>msuSimPixel(c,x0+x,y0+y),MSU_SIM_QF,ms,m*MSU_SEG);
      S.hdr.push(S.base+S.buf.length+parts.reduce((a,p)=>a+p.length,0));
      parts.push(msuPacket(apid,S.seq,seg)); S.seq=(S.seq+1)&0x3FFF;
    }
  }
  const tm=new Uint8Array(62); tm[2]=(ms>>>24)&255; tm[3]=(ms>>16)&255; tm[4]=(ms>>8)&255; tm[5]=ms&255;
  S.hdr.push(S.base+S.buf.length+parts.reduce((a,p)=>a+p.length,0));
  parts.push(msuPacket(70,S.seq,tm)); S.seq=(S.seq+1)&0x3FFF;
  const n=parts.reduce((a,p)=>a+p.length,0), all=new Uint8Array(S.buf.length+n);
  all.set(S.buf); let o=S.buf.length;
  for(const p of parts){ all.set(p,o); o+=p.length; }
  S.buf=all; S.line++;
}
// данные M_PDU номер cnt: [указатель первого заголовка, 882 байта]
function msuSimMpdu(cnt){
  const S=MSU_SIM, from=cnt*882, to=from+882;
  if(from<S.base){ S.base=0; S.buf=new Uint8Array(0); S.line=0; S.seq=0; S.hdr=[]; }
  while(S.base+S.buf.length<to+4096) msuSimLine();
  const d=S.buf.slice(from-S.base,to-S.base);
  let fhp=2047;
  for(const h of S.hdr) if(h>=from && h<to){ fhp=h-from; break; }
  // окно: всё, что до этого M_PDU минус запас, — выбросить
  const keep=from-64*882;
  if(keep>S.base){ const cut=keep-S.base; S.buf=S.buf.slice(cut); S.base=keep; S.hdr=S.hdr.filter(h=>h>=keep); }
  return [fhp,d];
}
