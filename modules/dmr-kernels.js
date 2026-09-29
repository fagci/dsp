"use strict";
/* ============================ DMR (ETSI TS 102 361, Tier II/III) ============================
   Ядро IQK (страница и воркер), без DOM. 4FSK 4800 Бод (9600 бит/с), TDMA 2 слота по 30 мс.
   Кадр 144 дибита: CACH 12 (только от базовой) + пакет 132: 49 + 5 + 24 (синхро/EMB) + 5 + 49.
   Символы: 01 → +3 (+1944 Гц), 00 → +1, 10 → −1, 11 → −3. Инверсия спектра = переворот старшего бита дибита.
   Фазы такта не отслеживаются: 8 решёток по ⅛ символа, кадровая сетка держится по синхрословам.
   Уровни: слот-тип Golay(20,8), EMB QR(16,7), BPTC(196,96), RS(12,9), CRC-CCITT / CRC-5 / CRC-8, Хэмминг,
   Rate ¾ (решётка), сборка данных → IP/UDP → Motorola TMS. Голос AMBE+2 не декодируется — отдаются сырые кадры. */

const DMR_BAUD=4800, DMR_PH=8, DMR_FR=144, DMR_BURST=132, DMR_SYNC_AT=54;
// [шаблон 48 бит, источник, вид, слот (прямой режим)]
const DMR_SYNCS=[
  ['755FD7DF75F7','bs','voice',0], ['DFF57D75DF5D','bs','data',0],
  ['7F7D5DD57DFD','ms','voice',0], ['D5D7F77FD757','ms','data',0], ['77D55F7DFD77','ms','rc',0],
  ['5D577F7757FF','direct','voice',1], ['F7FDD5DDFD55','direct','data',1],
  ['7DFFD5F55D5F','direct','voice',2], ['D7557F5FF7F5','direct','data',2]
].map(s=>({hi:parseInt(s[0].slice(0,6),16), lo:parseInt(s[0].slice(6),16), mode:s[1], kind:s[2], slot:s[3], hex:s[0]}));
const DMR_DT=['PI header','Voice LC header','Terminator LC','CSBK','MBC header','MBC cont.','Data header','Rate ½ data','Rate ¾ data','Idle','Rate 1 data','USBD'];

function dmrPop(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
// число из len ≤ 30 бит массива 0/1, старший первым
function dmrNum(b,o,len){ let v=0; for(let i=0;i<len;i++) v=v*2+b[o+i]; return v; }
function dmrBytes(b,o,n){ const r=new Uint8Array(n); for(let i=0;i<n;i++) r[i]=dmrNum(b,o+8*i,8); return r; }
function dmrHex(a,o,n){ let s=''; for(let i=o||0;i<(n==null ? a.length : (o||0)+n);i++) s+=(a[i]<16?'0':'')+a[i].toString(16); return s.toUpperCase(); }
function dmrBitsOf(bytes){ const r=new Uint8Array(bytes.length*8); for(let i=0;i<bytes.length;i++) for(let k=0;k<8;k++) r[8*i+k]=(bytes[i]>>(7-k))&1; return r; }
function dmrId(a,o){ return a[o]*65536+a[o+1]*256+a[o+2]; }

/* ---- Хэмминг: k информационных бит, затем проверочные; eqs[j] — какие инф. биты входят в j-й ---- */
function dmrHamMake(k,eqs){
  const n=k+eqs.length, col=new Array(n).fill(0), pos=new Map();
  eqs.forEach((e,j)=>{ for(const i of e) col[i]|=1<<j; col[k+j]=1<<j; });
  col.forEach((c,i)=>pos.set(c,i));
  return {k,n,eqs,pos};
}
const DMR_H15113=dmrHamMake(11,[[0,1,2,3,5,7,8],[1,2,3,4,6,8,9],[2,3,4,5,7,9,10],[0,1,2,4,6,7,10]]);
const DMR_H1393=dmrHamMake(9,[[0,1,3,5,6],[0,1,2,4,6,7],[0,1,2,3,5,7,8],[0,2,4,5,8]]);
const DMR_H16114=dmrHamMake(11,[[0,1,2,3,5,7,8],[1,2,3,4,6,8,9],[2,3,4,5,7,9,10],[0,1,2,4,6,7,10],[0,2,5,6,8,9,10]]);
const DMR_H17123=dmrHamMake(12,[[0,1,2,3,6,7,9],[0,1,2,3,4,7,8,10],[1,2,3,4,5,8,9,11],[0,1,4,5,7,10],[0,1,2,5,6,8,11]]);
const DMR_H743=dmrHamMake(4,[[0,1,2],[1,2,3],[0,1,3]]);
// 0 — чисто, 1 — исправлена одна ошибка, −1 — не исправить
function dmrHam(h,b,o){
  let s=0;
  for(let j=0;j<h.eqs.length;j++){ let p=b[o+h.k+j]; for(const i of h.eqs[j]) p^=b[o+i]; s|=p<<j; }
  if(!s) return 0;
  const i=h.pos.get(s);
  if(i===undefined) return -1;
  b[o+i]^=1; return 1;
}
function dmrHamEnc(h,b,o){ for(let j=0;j<h.eqs.length;j++){ let p=0; for(const i of h.eqs[j]) p^=b[o+i]; b[o+h.k+j]=p; } }

/* ---- Golay(20,8) слот-типа и QR(16,7) EMB: перебор по 256 / 128 кодовым словам ---- */
const DMR_GOLAY_B=[0x8EB,0x93E,0xA97,0xDC6,0x367,0x6CD,0xD99,0x3DA];
const DMR_QR_B=[0x273,0x4E5,0x9C9,0x11E2,0x21B7,0x411E,0x804F];
const DMR_GOLAY=(()=>{ const t=new Uint32Array(256); for(let v=0;v<256;v++){ let p=0; for(let i=0;i<8;i++) if((v>>i)&1) p^=DMR_GOLAY_B[i]; t[v]=(v<<12)|p; } return t; })();
const DMR_QR=(()=>{ const t=new Uint32Array(128); for(let v=0;v<128;v++){ let c=0; for(let i=0;i<7;i++) if((v>>i)&1) c^=DMR_QR_B[i]; t[v]=c; } return t; })();
function dmrNearest(tab,w,maxErr){
  let best=-1, bd=99;
  for(let v=0;v<tab.length;v++){ const d=dmrPop((tab[v]^w)>>>0); if(d<bd){ bd=d; best=v; } }
  return bd<=maxErr ? {v:best, err:bd} : null;
}

/* ---- CRC ---- */
// CRC-CCITT (0x1021, начальное 0, инверсия): 80 бит + 16 бит проверки (в MMDVM addCCITT162)
function dmrCrc16(a,n){
  let r=0;
  for(let i=0;i<n;i++){ r^=a[i]<<8; for(let k=0;k<8;k++) r=(r&0x8000) ? ((r<<1)^0x1021)&0xFFFF : (r<<1)&0xFFFF; }
  return r^0xFFFF;
}
// CRC-5 встроенного LC: сумма байт по модулю 31
function dmrCrc5(bits72){ let t=0; for(let i=0;i<72;i+=8) t+=dmrNum(bits72,i,8); return t%31; }
// CRC-32 сообщения данных (ETSI B.3.?): как в dsd-fme — слова по 2 октета меняются местами, результат байтами наоборот
function dmrCrc32(m,n){
  let r=0;
  for(let i=0;i<n;i+=2) for(const idx of [i+1,i]){
    const v=idx<n ? m[idx] : 0;
    for(let k=7;k>=0;k--){ const fb=((r>>>31)&1)^((v>>k)&1); r=(r<<1)>>>0; if(fb) r=(r^0x04C11DB7)>>>0; }
  }
  return (((r&0xFF)<<24)|(((r>>>8)&0xFF)<<16)|(((r>>>16)&0xFF)<<8)|(r>>>24))>>>0;
}
// CRC-8 короткого LC: делимость 36 бит на x^8+x^2+x+1
function dmrCrc8Ok(b,o,n){
  const t=Array.from(b.subarray(o,o+n));
  for(let i=0;i<n-8;i++) if(t[i]) for(let j=0;j<9;j++) t[i+j]^=[1,0,0,0,0,0,1,1,1][j];
  for(let i=n-8;i<n;i++) if(t[i]) return false;
  return true;
}

/* ---- RS(12,9) над GF(256), полином 0x11D, g(x)=x³+14x²+56x+64 ---- */
const DMR_GF=(()=>{ const e=new Uint8Array(512), l=new Uint8Array(256); let x=1; for(let i=0;i<255;i++){ e[i]=x; l[x]=i; x<<=1; if(x&0x100) x^=0x11D; } for(let i=255;i<512;i++) e[i]=e[i-255]; return {e,l}; })();
function dmrGmul(a,b){ return a&&b ? DMR_GF.e[DMR_GF.l[a]+DMR_GF.l[b]] : 0; }
function dmrRsPar(m){
  const P=[64,56,14], par=[0,0,0];
  for(let i=0;i<9;i++){
    const d=m[i]^par[2];
    par[2]=par[1]^dmrGmul(P[2],d); par[1]=par[0]^dmrGmul(P[1],d); par[0]=dmrGmul(P[0],d);
  }
  return [par[2],par[1],par[0]];
}
function dmrRsOk(a){ const p=dmrRsPar(a); return a[9]===p[0] && a[10]===p[1] && a[11]===p[2]; }

/* ---- BPTC(196,96): 13×15, строки Хэмминг (15,11,3), столбцы (13,9,3), перемежение a·181 mod 196 ---- */
function dmrRaw196(bits){ const r=new Uint8Array(196); for(let i=0;i<98;i++){ r[i]=bits[i]; r[98+i]=bits[166+i]; } return r; }
const DMR_BPTC_ROWS=[[4,11],[16,26],[31,41],[46,56],[61,71],[76,86],[91,101],[106,116],[121,131]];
function dmrBptcDec(raw){
  const d=new Uint8Array(196);
  for(let a=0;a<196;a++) d[a]=raw[(a*181)%196];
  const col=new Uint8Array(13);
  for(let it=0,fix=true;fix&&it<5;it++){
    fix=false;
    for(let c=0;c<15;c++){
      for(let r=0;r<13;r++) col[r]=d[1+c+15*r];
      if(dmrHam(DMR_H1393,col,0)===1){ for(let r=0;r<13;r++) d[1+c+15*r]=col[r]; fix=true; }
    }
    for(let r=0;r<9;r++) if(dmrHam(DMR_H15113,d,1+15*r)===1) fix=true;
  }
  const out=new Uint8Array(96); let p=0;
  for(const [a,b] of DMR_BPTC_ROWS) for(let i=a;i<=b;i++) out[p++]=d[i];
  return out;
}
function dmrBptcEnc(b96){
  const d=new Uint8Array(196); let p=0;
  for(const [a,b] of DMR_BPTC_ROWS) for(let i=a;i<=b;i++) d[i]=b96[p++];
  for(let r=0;r<9;r++) dmrHamEnc(DMR_H15113,d,1+15*r);
  const col=new Uint8Array(13);
  for(let c=0;c<15;c++){ for(let r=0;r<13;r++) col[r]=d[1+c+15*r]; dmrHamEnc(DMR_H1393,col,0); for(let r=0;r<13;r++) d[1+c+15*r]=col[r]; }
  const raw=new Uint8Array(196);
  for(let a=0;a<196;a++) raw[(a*181)%196]=d[a];
  return raw;
}

/* ---- Rate ¾: решётка 8 состояний (состояние — прошлый трибит), 49 точек созвездия, перемежение по 98 дибитам ---- */
const DMR_T34_IL=[0,1,8,9,16,17,24,25,32,33,40,41,48,49,56,57,64,65,72,73,80,81,88,89,96,97,
  2,3,10,11,18,19,26,27,34,35,42,43,50,51,58,59,66,67,74,75,82,83,90,91,
  4,5,12,13,20,21,28,29,36,37,44,45,52,53,60,61,68,69,76,77,84,85,92,93,
  6,7,14,15,22,23,30,31,38,39,46,47,54,55,62,63,70,71,78,79,86,87,94,95];
const DMR_T34_X=[[1,-3,-3,1,3,-1,-1,3],[-3,1,3,-1,-1,3,1,-3],[-1,3,3,-1,-3,1,1,-3],[3,-1,-3,1,1,-3,-1,3],
  [-3,1,1,-3,-1,3,3,-1],[1,-3,-1,3,3,-1,-3,1],[3,-1,-1,3,1,-3,-3,1],[-1,3,1,-3,-3,1,3,-1]];
const DMR_T34_Y=[[-1,3,-1,3,-3,1,-3,1],[-1,3,-3,1,-3,1,-1,3],[-1,3,-1,3,-3,1,-3,1],[-1,3,-3,1,-3,1,-1,3],
  [-3,1,-3,1,-1,3,-1,3],[-3,1,-1,3,-1,3,-3,1],[-3,1,-3,1,-1,3,-1,3],[-3,1,-1,3,-1,3,-3,1]];
const DMR_T34_SYM=[1,3,-1,-3], DMR_T34_INV={'1':0,'3':1,'-1':2,'-3':3};
// 196 бит → 144 бита (18 октетов); ошибки — сумма расстояний лучшего пути
function dmrT34Dec(raw){
  const dd=new Uint8Array(98);
  for(let i=0;i<98;i++) dd[DMR_T34_IL[i]]=raw[2*i]*2+raw[2*i+1];
  const px=new Int8Array(49), py=new Int8Array(49);
  for(let i=0;i<49;i++){ px[i]=DMR_T34_SYM[dd[2*i]]; py[i]=DMR_T34_SYM[dd[2*i+1]]; }
  let met=new Float64Array(8).fill(1e9); met[0]=0;
  const prev=[];
  for(let j=0;j<49;j++){
    const nm=new Float64Array(8).fill(1e9), pv=new Int8Array(8);
    for(let s=0;s<8;s++){
      if(met[s]>=1e9) continue;
      for(let t=0;t<(j===48 ? 1 : 8);t++){
        const m=met[s]+Math.abs(px[j]-DMR_T34_X[s][t])+Math.abs(py[j]-DMR_T34_Y[s][t]);
        if(m<nm[t]){ nm[t]=m; pv[t]=s; }
      }
    }
    prev.push(pv); met=nm;
  }
  const tri=new Uint8Array(49); let s=0;
  for(let j=48;j>=0;j--){ tri[j]=s; s=prev[j][s]; }
  const out=new Uint8Array(144);
  for(let j=0;j<48;j++) for(let k=0;k<3;k++) out[3*j+k]=(tri[j]>>(2-k))&1;
  return {bits:out, err:met[0]};
}
function dmrT34Enc(b144){
  const dd=new Uint8Array(98); let s=0;
  for(let j=0;j<49;j++){
    const t=j<48 ? b144[3*j]*4+b144[3*j+1]*2+b144[3*j+2] : 0;
    const x=DMR_T34_INV[DMR_T34_X[s][t]], y=DMR_T34_INV[DMR_T34_Y[s][t]];
    dd[2*j]=x; dd[2*j+1]=y; s=t;
  }
  const raw=new Uint8Array(196);
  for(let i=0;i<98;i++){ const d=dd[DMR_T34_IL[i]]; raw[2*i]=d>>1; raw[2*i+1]=d&1; }
  return raw;
}

/* ---- слот-тип, EMB, CACH ---- */
function dmrSlotType(bits,maxErr){
  let w=0;
  for(let i=0;i<10;i++) w=w*2+bits[98+i];
  for(let i=0;i<10;i++) w=w*2+bits[156+i];
  const r=dmrNearest(DMR_GOLAY,w,maxErr);
  return r ? {cc:r.v>>4, dt:r.v&15, err:r.err} : null;
}
function dmrEmb(bits,maxErr){
  let w=0;
  for(let i=0;i<8;i++) w=w*2+bits[108+i];
  for(let i=0;i<8;i++) w=w*2+bits[148+i];
  const r=dmrNearest(DMR_QR,w,maxErr);
  return r ? {cc:r.v>>3, pi:(r.v>>2)&1, lcss:r.v&3, err:r.err} : null;
}
const DMR_CACH_IL=[0,7,8,9,1,10,11,12,2,13,14,15,3,16,4,17,18,19,5,20,21,22,6,23];
// 24 бита → TACT (Хэмминг 7,4) и 17 бит полезной части; fix: 0 — чисто, 1 — исправлено
function dmrCach(bits24){
  const c=new Uint8Array(24);
  for(let k=0;k<24;k++) c[DMR_CACH_IL[k]]=bits24[k];
  const fix=dmrHam(DMR_H743,c,0);
  return {at:c[0], ts:c[1], lcss:c[2]*2+c[3], fix, pay:c.subarray(7)};
}
// 4 фрагмента по 17 бит → Short LC 36 бит (28 + CRC-8) или null
function dmrShortLc(frags){
  const raw=new Uint8Array(68);
  for(let j=0;j<4;j++) raw.set(frags[j],17*j);
  const d=new Uint8Array(68);
  for(let i=0;i<67;i++) d[i]=raw[(i*4)%67];
  d[67]=raw[67];
  for(const o of [0,17,34]) if(dmrHam(DMR_H17123,d,o)<0) return null;
  for(let c=0;c<17;c++) if((d[c]^d[c+17]^d[c+34])!==d[c+51]) return null;
  const out=new Uint8Array(36);
  out.set(d.subarray(0,12),0); out.set(d.subarray(17,29),12); out.set(d.subarray(34,46),24);
  return dmrCrc8Ok(out,0,36) ? out : null;
}

/* ---- встроенный LC (4×32 бита, матрица 8×16) ---- */
function dmrEmbDecode(raw){
  const d=new Uint8Array(128);
  for(let a=0,b=0;a<128;a++){ d[b]=raw[a]; b+=16; if(b>127) b-=127; }
  for(let a=0;a<112;a+=16) if(dmrHam(DMR_H16114,d,a)<0) return null;
  for(let a=0;a<16;a++){ let p=0; for(let r=0;r<8;r++) p^=d[a+16*r]; if(p) return null; }
  const lc=new Uint8Array(72); let b=0;
  for(const [x,y] of [[0,10],[16,26],[32,41],[48,57],[64,73],[80,89],[96,105]]) for(let a=x;a<=y;a++) lc[b++]=d[a];
  const crc=d[42]*16+d[58]*8+d[74]*4+d[90]*2+d[106];
  return dmrCrc5(lc)===crc ? lc : null;
}
function dmrEmbEncode(lc){
  const crc=dmrCrc5(lc), d=new Uint8Array(128);
  d[106]=crc&1; d[90]=(crc>>1)&1; d[74]=(crc>>2)&1; d[58]=(crc>>3)&1; d[42]=(crc>>4)&1;
  let b=0;
  for(const [x,y] of [[0,10],[16,26],[32,41],[48,57],[64,73],[80,89],[96,105]]) for(let a=x;a<=y;a++) d[a]=lc[b++];
  for(let a=0;a<112;a+=16) dmrHamEnc(DMR_H16114,d,a);
  for(let a=0;a<16;a++){ let p=0; for(let r=0;r<7;r++) p^=d[a+16*r]; d[a+112]=p; }
  const raw=new Uint8Array(128);
  for(let a=0,b2=0;a<128;a++){ raw[a]=d[b2]; b2+=16; if(b2>127) b2-=127; }
  return raw;
}

/* ---- разбор служебных данных ---- */
const DMR_CSBKO={0x04:'UU_V_Req',0x05:'UU_Ans_Rsp',0x07:'CT_CSBK',0x19:'C_ALOHA',0x1C:'C_AHOY',0x1E:'C_RAND',0x1F:'Call Alert',0x20:'Call Alert Ack / C_ACKD',
  0x21:'C_ACKU',0x22:'P_ACKD',0x23:'P_ACKU',0x24:'Radio Check',0x26:'NACK_Rsp',0x27:'Call Emergency',0x28:'C_BCAST',0x2A:'Maint',0x2E:'P_CLEAR',
  0x2F:'P_PROTECT',0x30:'PV_GRANT',0x31:'TV_GRANT',0x32:'BTV_GRANT',0x33:'PD_GRANT',0x34:'TD_GRANT',0x35:'PV_GRANT_DX',0x36:'PD_GRANT_DX',
  0x37:'PD_GRANT_MI',0x38:'BS_Dwn_Act',0x39:'C_MOVE',0x3D:'Preamble'};
const DMR_SAP=['UDT','','TCP/IP header comp.','UDP/IP header comp.','IP packet','ARP','','','','proprietary','short data'];
const DMR_ACT=['idle','','group CSBK','individual CSBK','','','','','group voice','individual voice','individual data','group data','group emergency','individual emergency'];

// 96 бит после BPTC → CSBK/MBC/данные с CRC-CCITT и маской
function dmrMasked(b96,mask){
  const a=dmrBytes(b96,0,12); a[10]^=mask>>8; a[11]^=mask&255;
  return dmrCrc16(a,10)===((a[10]<<8)|a[11]) ? dmrBytes(b96,0,12) : null;
}
function dmrLc(b96,mask){
  const a=dmrBytes(b96,0,12); a[9]^=mask; a[10]^=mask; a[11]^=mask;
  return dmrRsOk(a) ? a : null;
}
function dmrSvcOpt(o){
  const f=[]; if(o&0x80) f.push('emergency'); if(o&0x40) f.push('encrypted'); if(o&0x08) f.push('broadcast'); if(o&0x04) f.push('OVCM');
  return f;
}
// текст по формату talker alias / short data
function dmrTextTA(fmt,size,buf){
  let s='';
  if(fmt===0){
    let c=0,t1=0,t2=0;
    for(let i=0;i<buf.length&&t2<size;i++) for(let j=7;j>=0;j--){
      c=(c<<1)|((buf[i]>>j)&1);
      if(++t1===7){ if(i>0){ s+=String.fromCharCode(c&0x7F); t2++; } t1=0; c=0; if(t2>=size) break; }
    }
  } else if(fmt===3){
    for(let i=0;i<15&&s.length<size;i++) s+=buf[2*i+1]===0 ? String.fromCharCode(buf[2*i+2]) : '?';
  } else s=Array.from(buf.subarray(1,1+size),c=>String.fromCharCode(c)).join('');
  return s.replace(/[\u0000-\u001F]/g,'');
}
function dmrPrintable(a,o,n){
  let s='';
  for(let i=o;i<o+n&&i<a.length;i++){ const c=a[i]; s+=c>=32&&c<127 ? String.fromCharCode(c) : c===10||c===13 ? ' ' : c===0 ? '' : '·'; }
  return s;
}
function dmrUtf16(a,o,n,le){
  let s='';
  for(let i=o;i+1<o+n&&i+1<a.length;i+=2){ const c=le ? a[i]|(a[i+1]<<8) : (a[i]<<8)|a[i+1]; if(c===0) continue; s+=c>=32 ? String.fromCharCode(c) : ' '; }
  return s;
}
function dmrText7(a,o,n){
  let s='', acc=0, nb=0;
  for(let i=o;i<o+n&&i<a.length;i++){ acc=(acc<<8)|a[i]; nb+=8; while(nb>=7){ const c=(acc>>(nb-7))&0x7F; nb-=7; if(c>=32) s+=String.fromCharCode(c); } acc&=(1<<nb)-1; }
  return s;
}
// текст Motorola TMS (UDP 4007): длина, заголовок, необязательный адрес, текст UTF-16LE
function dmrTms(a,p){
  const len=(a[p]<<8)|a[p+1], hdr=a[p+2], adl=a[p+3];
  if((hdr&15)!==0) return {ack:true};
  let ptr=adl ? p+3+adl+1 : p+4;
  while(ptr<a.length && (a[ptr]>>7)){ const b1=a[ptr++]; if(b1>>7) ptr++; }
  let best='';
  for(const st of [ptr-1,ptr,ptr+1]){
    let s='', run=0;
    for(let i=st;i+1<a.length&&i<p+2+len;i+=2){ const c=a[i]|(a[i+1]<<8); if(c===0) break; s+=c>=32 ? String.fromCharCode(c) : ' '; if(c>=32&&c<0x500) run++; }
    if(run>best.length) best=s;
  }
  return {ack:false, text:best};
}
// собранные октеты → поля записи (IP/UDP, TMS, короткие данные)
function dmrPayload(sap,dd,msg){
  const r={};
  if(sap===4 && msg.length>28 && (msg[0]>>4)===4){
    const ihl=(msg[0]&15)*4, prot=msg[9];
    r.ip=msg[12]+'.'+msg[13]+'.'+msg[14]+'.'+msg[15]+' → '+msg[16]+'.'+msg[17]+'.'+msg[18]+'.'+msg[19];
    if(prot===17 && msg.length>=ihl+8){
      const sp=(msg[ihl]<<8)|msg[ihl+1], dp=(msg[ihl+2]<<8)|msg[ihl+3]; r.port=dp; r.proto='UDP';
      const p=ihl+8, port=dp===4007||sp===4007 ? 4007 : dp;
      if(port===4007){ const t=dmrTms(msg,p); r.service='TMS'; if(t.ack) r.ack=true; else r.message=t.text; }
      else { r.service=({4001:'LRRP',4004:'XCMP',4005:'ARS',4008:'telemetry',231:'Cellocator'})[port]||('UDP '+port); r.data=dmrHex(msg,p,Math.min(40,msg.length-p)); }
    } else { r.proto='IP '+prot; r.data=dmrHex(msg,ihl,Math.min(40,msg.length-ihl)); }
  } else if(dd!=null){
    r.service='short data'; r.format=dd;
    r.message=dd===0||dd===1 ? undefined : dd===2 ? dmrText7(msg,0,msg.length) : dmrPrintable(msg,0,msg.length);
    r.data=dmrHex(msg,0,Math.min(40,msg.length));
  } else { r.data=dmrHex(msg,0,Math.min(40,msg.length)); const t=dmrPrintable(msg,0,msg.length); if(/[A-Za-z]{4}/.test(t)) r.message=t; }
  return r;
}

/* ---- RRC α=0.2, единичная энергия в отсчётах (согласованный фильтр приёмника) ---- */
function dmrRrc(t,a){
  if(Math.abs(t)<1e-9) return 1-a+4*a/Math.PI;
  if(Math.abs(Math.abs(t)-1/(4*a))<1e-9) return a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
  return (Math.sin(Math.PI*t*(1-a))+4*a*t*Math.cos(Math.PI*t*(1+a)))/(Math.PI*t*(1-Math.pow(4*a*t,2)));
}
function dmrRrcTaps(sps){
  const hl=Math.round(6*sps), h=new Float32Array(2*hl+1); let e=0;
  for(let i=0;i<h.length;i++){ h[i]=dmrRrc((i-hl)/sps,.2); e+=h[i]*h[i]; }
  const g=1/Math.sqrt(e);
  for(let i=0;i<h.length;i++) h[i]*=g;
  return h;
}

/* ---- приёмник ---- */
const DMR_ACQ=4, DMR_LOCK=8, DMR_SYNC_OK=10, DMR_MISS=12;

function dmrSlotNew(key){ return {key, call:null, vseq:null, est:0, eraw:new Uint8Array(128), ta:null, d:null, lastRaw:{}, lastVoice:0, vbursts:0, sf:0, last:''}; }

IQK.dmrRx={
  init(n){
    n.key=''; n.lock=null; n.now=0; n.slots=[dmrSlotNew(0),dmrSlotNew(1)]; n.cc=null; n.recent=[]; n.lastAct=0;
    n.st={bursts:0, syncs:0, voice:0, data:0, csbk:0, lc:0, msgs:0, bad:0, gaps:0, locks:0}; n.sys=null;
  },
  setup(n,s,cplx){
    const M=cplx ? Math.max(1,Math.floor(s.sr/48000)) : 1;
    n.M=M; n.fs=s.sr/M; n.sps=n.fs/DMR_BAUD;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,7500/n.fs), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    const stop=Math.min(9000,.47*n.fs);
    n.lp=cplx ? kaiserLP(n.fs,5500,stop,255) : null;
    if(n.lp){ n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1); }
    n.rrc=dmrRrcTaps(n.sps); n.rh=new Float32Array(n.rrc.length-1);
    n.pr=0; n.pi=0; n.dc=0; n.env=0;
    n.x=new Float32Array(0); n.xb=0; n.tNext=0; n.jj=0;
    n.ring=[]; for(let p=0;p<DMR_PH;p++) n.ring.push(new Float32Array(256));
    n.hi=new Uint32Array(DMR_PH); n.lo=new Uint32Array(DMR_PH);
    n.lock=null; n.now=0; n.slots=[dmrSlotNew(0),dmrSlotNew(1)];
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, voice:null}; }
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    const key=s.sr+'|'+cplx;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    const parts=[], a=1/(0.2*n.fs);
    for(const c of src.chunks){
      let y;
      if(!n.cplx) y=Float32Array.from(c.re);
      else {
        const xr=firRun(n.lp,n.lr,c.re), xi=firRun(n.lp,n.li,iqChunkIm(c)), K=xr.length, k=n.fs/(2*Math.PI);
        y=new Float32Array(K);
        let pr=n.pr, pi=n.pi;
        for(let i=0;i<K;i++){ const p=xr[i], q=xi[i]; y[i]=Math.atan2(q*pr-p*pi, p*pr+q*pi)*k; pr=p; pi=q; }
        n.pr=pr; n.pi=pi;
      }
      let dc=n.dc;                                     // уход частоты приёмника — медленный ФВЧ
      for(let i=0;i<y.length;i++){ dc+=a*(y[i]-dc); y[i]-=dc; }
      n.dc=dc;
      parts.push(firRun(n.rrc,n.rh,y));
    }
    let add=0; for(const p of parts) add+=p.length;
    const nx=new Float32Array(n.x.length+add); nx.set(n.x); let o=n.x.length;
    for(const p of parts){ nx.set(p,o); o+=p.length; }
    n.x=nx;
    const out={recs:[], voice:[]};
    this.scan(n,out);
    const now=Date.now();
    n.ui={fs:n.fs, M:n.M, cc:n.cc, st:{...n.st}, locked:!!n.lock, mode:n.lock ? n.lock.mode : null, inv:n.lock ? n.lock.g<0 : null,
      age:n.lastAct ? now-n.lastAct : null, slots:n.slots.map(dmrSlotLine), recent:n.recent.slice(-8), sys:n.sys};
    return {rec:out.recs.length ? out.recs : null, voice:out.voice.length ? out.voice : null};
  },
  scan(n,out){
    const x=n.x, N=x.length, step=n.sps/DMR_PH;
    let tj=n.tNext-n.xb;
    if(tj<0) tj=0;
    while(tj<N-1){
      const i0=Math.floor(tj), fr=tj-i0;
      this.step(n,x[i0]+fr*(x[i0+1]-x[i0]),out);
      n.jj++; tj+=step;
    }
    n.tNext=n.xb+tj;
    const keep=Math.max(0,Math.floor(tj)-2);
    if(keep>0){ n.x=x.slice(keep); n.xb+=keep; }
  },
  step(n,y,out){
    const jj=n.jj, ph=jj&7, k=jj>>3;
    n.ring[ph][k&255]=y;
    n.env+=(Math.abs(y)-n.env)*(1/2048);
    const e=n.env, d=y>e ? 1 : y>0 ? 0 : y>-e ? 2 : 3;
    n.hi[ph]=((n.hi[ph]<<2)|(n.lo[ph]>>>22))&0xFFFFFF; n.lo[ph]=((n.lo[ph]<<2)|d)&0xFFFFFF;
    const lk=n.lock;
    if(jj>=8*24 && (!lk || Math.abs(jj-lk.next)<=8)) this.findSync(n,ph,jj);
    const l2=n.lock;
    if(l2 && jj===l2.next+8*(DMR_BURST-1-(DMR_SYNC_AT+23))){
      this.frame(n,l2,jj,out);
      if(n.lock===l2){ l2.next+=8*DMR_FR; l2.best=99; l2.bestRq=1e9; }
    }
  },
  findSync(n,ph,jj){
    const lk=n.lock, thr=lk ? DMR_LOCK : DMR_ACQ;
    let bd=99, bp=null;
    for(const xm of [0,0xAAAAAA]){
      const hi=n.hi[ph]^xm, lo=n.lo[ph]^xm;
      for(const p of DMR_SYNCS){ const d=dmrPop((hi^p.hi)>>>0)+dmrPop((lo^p.lo)>>>0); if(d<bd){ bd=d; bp=p; } }
    }
    if(bd>thr) return;
    const f=this.fit(n,ph,jj,bp);
    if(!f) return;
    if(!lk){
      n.lock={next:jj, best:bd, bestRq:f.rq, mode:bp.mode, g:f.g, o:f.o, cc:-1, fn:0, miss:0, polOk:false, lastSync:bp};
      n.st.locks++;
    } else if(bd<lk.best || (bd===lk.best && f.rq<lk.bestRq)){
      lk.next=jj; lk.best=bd; lk.bestRq=f.rq;
      // синхрослово голоса и данных — двойники (инверсия): после определения полярности знак задан FEC
      lk.g=lk.polOk && Math.sign(f.g)!==Math.sign(lk.g) ? -f.g : f.g; lk.o=f.o;
    }
  },
  // усиление и смещение по 24 известным символам синхрослова: y = g·s + o (g<0 — инвертированный спектр);
  // rq — остаточная дисперсия в долях g²: минимум — лучшая фаза такта
  fit(n,ph,jj,p){
    const ring=n.ring[ph], k=jj>>3, s=p.syms||(p.syms=dmrSyncSyms(p));
    let sy=0, sx=0, sxx=0, sxy=0, syy=0;
    for(let i=0;i<24;i++){ const v=ring[(k-(23-i))&255]; sy+=v; sx+=s[i]; sxx+=s[i]*s[i]; sxy+=s[i]*v; syy+=v*v; }
    const den=24*sxx-sx*sx, g=(24*sxy-sx*sy)/den, o=(sy-g*sx)/24;
    if(!isFinite(g) || Math.abs(g)<1e-3) return null;
    const res=(syy-2*g*sxy-2*o*sy+g*g*sxx+2*g*o*sx+24*o*o)/24;
    return {g, o, rq:res/(g*g)};
  },
  // кадр 144 дибита, последний — на шаге e
  frame(n,L,e,out){
    const ph=e&7, k0=e>>3, ring=n.ring[ph];
    let F=new Uint8Array(DMR_FR);
    for(let i=0;i<DMR_FR;i++){
      const z=(ring[(k0-(DMR_FR-1-i))&255]-L.o)/L.g;
      F[i]=z>2 ? 1 : z>0 ? 0 : z>-2 ? 2 : 3;
    }
    // синхрослова голоса и данных — инверсии друг друга, полярность определяется по FEC (слот-тип, EMB)
    if(!L.polOk){
      const G=F.map(d=>d^2), a=dmrFecScore(F,L), b=dmrFecScore(G,L);
      if(a.s===0 && b.s===0){
        if(a.sync || b.sync){ L.miss=0; L.fn++; } else if(++L.miss>DMR_MISS){ n.lock=null; return; } else L.fn++;
        return;
      }
      if(b.s>a.s){ L.g=-L.g; F=G; }
      L.polOk=true;
    }
    n.now=e/(DMR_PH*DMR_BAUD)*1000;
    const ok=dmrFrame(n,L,F,e,out);
    n.st.bursts++;
    if(ok){ L.miss=0; n.lastAct=Date.now(); } else if(++L.miss>DMR_MISS){ n.lock=null; return; }
    L.fn++;
  }};
// 2 — слот-тип данных сошёлся с синхрословом данных, 1 — сошёлся EMB
function dmrFecScore(F,L){
  const bits=new Uint8Array(264);
  for(let i=0;i<132;i++){ const d=F[12+i]; bits[2*i]=d>>1; bits[2*i+1]=d&1; }
  let sh=0, sl=0;
  for(let i=0;i<12;i++){ sh=(sh<<2)|F[12+DMR_SYNC_AT+i]; sl=(sl<<2)|F[12+DMR_SYNC_AT+12+i]; }
  let bd=99, bp=null;
  for(const p of DMR_SYNCS){ const d=dmrPop((sh^p.hi)>>>0)+dmrPop((sl^p.lo)>>>0); if(d<bd){ bd=d; bp=p; } }
  const sync=bd<=DMR_SYNC_OK && bp.kind!=='rc';
  if(sync && bp.kind==='data'){ const st=dmrSlotType(bits,1); if(st && st.dt<=11) return {s:2, sync}; }
  if(!sync){ const emb=dmrEmb(bits,1); if(emb && (L.cc<0 || emb.cc===L.cc)) return {s:1, sync}; }
  return {s:0, sync};
}
function dmrSyncSyms(p){
  const s=new Float32Array(24), v=[1,3,-1,-3];
  const h=p.hex;
  for(let i=0;i<12;i++){ const nb=parseInt(h[i],16); s[2*i]=v[nb>>2]; s[2*i+1]=v[nb&3]; }
  return s;
}
function dmrSlotLine(S){
  const c=S.call;
  if(!c) return 'idle';
  return (c.late ? 'late ' : '')+(c.type||'call')+' '+c.from+' → '+c.to+' · '+S.vbursts+' voice bursts'+(c.flags&&c.flags.length ? ' · '+c.flags.join(',') : '');
}

/* ---- разбор кадра ---- */
function dmrEmit(n,S,L,out,kind,f,text,dedup){
  const ts=n.now;                                   // время потока (мс от начала), а не стенные часы: разбор идёт и быстрее реального времени
  if(dedup!=null && S){ const p=S.lastRaw[kind]; if(p && p.k===dedup && ts-p.t<1000){ p.t=ts; return null; } S.lastRaw[kind]={k:dedup,t:ts}; }
  const r={t:Date.now(), src:'DMR', kind, slot:S&&S.slot||null, cc:L&&L.cc>=0 ? L.cc : null, ...f, text};
  out.recs.push(r);
  n.recent.push((S&&S.slot ? 'S'+S.slot+' ' : '')+text); if(n.recent.length>20) n.recent.shift();
  return r;
}
function dmrCallName(flco){ return flco===0 ? 'group' : flco===3 ? 'private' : 'FLCO '+flco; }

function dmrFrame(n,L,F,e,out){
  const bits=new Uint8Array(264);
  for(let i=0;i<132;i++){ const d=F[12+i]; bits[2*i]=d>>1; bits[2*i+1]=d&1; }
  let sh=0, sl=0;
  for(let i=0;i<12;i++){ sh=(sh<<2)|F[12+DMR_SYNC_AT+i]; sl=(sl<<2)|F[12+DMR_SYNC_AT+12+i]; }
  let bd=99, bp=null;
  for(const p of DMR_SYNCS){ const d=dmrPop((sh^p.hi)>>>0)+dmrPop((sl^p.lo)>>>0); if(d<bd){ bd=d; bp=p; } }
  const sync=bd<=DMR_SYNC_OK && bp.kind!=='rc' ? bp : null;
  if(sync){ L.mode=sync.mode; L.lastSync=sync; n.st.syncs++; }
  let slot=null;
  if(L.mode==='bs'){
    const cb=new Uint8Array(24);
    for(let i=0;i<12;i++){ cb[2*i]=F[i]>>1; cb[2*i+1]=F[i]&1; }
    const c=dmrCach(cb);
    slot=c.ts+1;
    dmrShortFrag(n,L,c,out);
  } else if(L.mode==='direct'){ slot=sync ? sync.slot : L.dslot||null; if(sync) L.dslot=sync.slot; }
  const S=n.slots[slot ? slot-1 : L.fn&1]; S.slot=slot;
  const setCc=(cc,err)=>{ if(err<=1 || L.cc<0){ L.cc=cc; n.cc=cc; } };
  const ccOk=(cc,err)=>L.cc>=0 ? cc===L.cc : err===0;
  if(sync && sync.kind==='data'){
    const st=dmrSlotType(bits,3);
    if(!st || st.dt>11){ n.st.bad++; return 2; }
    setCc(st.cc,st.err); dmrData(n,L,S,bits,st,out); return 2;
  }
  if(sync){ dmrVoice(n,L,S,bits,sync,null,out); return 2; }
  const st=dmrSlotType(bits,2);
  if(st && st.dt<=11 && ccOk(st.cc,st.err)){ setCc(st.cc,st.err); dmrData(n,L,S,bits,st,out); return 1; }
  const emb=dmrEmb(bits,2);
  if(emb && ccOk(emb.cc,emb.err)){ setCc(emb.cc,emb.err); dmrVoice(n,L,S,bits,null,emb,out); return 1; }
  n.st.gaps++;
  return 0;
}

// Short LC из CACH: 4 фрагмента (LCSS 1, 3, 3, 2)
function dmrShortFrag(n,L,c,out){
  if(c.lcss===1){ L.sf=[Uint8Array.from(c.pay)]; }
  else if(L.sf && (c.lcss===3 || c.lcss===2)){
    L.sf.push(Uint8Array.from(c.pay));
    if(c.lcss===2){
      if(L.sf.length===4){
        const b=dmrShortLc(L.sf);
        if(b){
          const slco=dmrNum(b,0,4), f={slco};
          let text='SLC ';
          if(slco===1){
            const a1=dmrNum(b,4,4), a2=dmrNum(b,8,4);
            Object.assign(f,{ts1:DMR_ACT[a1]||'res '+a1, ts2:DMR_ACT[a2]||'res '+a2, hash1:dmrNum(b,12,8), hash2:dmrNum(b,20,8)});
            text+='activity: TS1 '+f.ts1+', TS2 '+f.ts2;
          } else if(slco===2 || slco===3){
            const model=dmrNum(b,4,2), nb=[9,7,4,2][model], sb=[3,5,8,10][model];
            Object.assign(f,{model:['tiny','small','large','huge'][model], net:dmrNum(b,6,nb), site:dmrNum(b,6+nb,sb), reg:b[18], csc:dmrNum(b,19,9)});
            text+=(slco===2 ? 'C_SYS_Parms' : 'P_SYS_Parms')+' '+f.model+' net '+f.net+' site '+f.site;
            n.sys={net:f.net, site:f.site, model:f.model};
          } else text+=slco===0 ? 'null' : 'SLCO '+slco+' '+dmrHex(dmrBytes(Uint8Array.from([...b,0,0,0,0]),0,5));
          if(slco!==0) dmrEmit(n,null,L,out,'slc',f,text,text);
        } else n.st.bad++;
      }
      L.sf=null;
    }
  }
}

function dmrVoice(n,L,S,bits,sync,emb,out){
  n.st.voice++;
  const now=n.now;
  if(S.call && now-S.lastVoice>3000) S.call=null;
  S.lastVoice=now; S.vbursts++;
  if(sync){ S.vseq=0; S.sf++; S.est=0; }
  else {
    if(emb.lcss===1) S.vseq=1; else if(emb.lcss===2) S.vseq=4; else if(emb.lcss===0) S.vseq=5;
    else S.vseq=S.vseq==null ? 2 : Math.min(3,S.vseq+1);
  }
  const ambe=new Uint8Array(216);
  ambe.set(bits.subarray(0,108),0); ambe.set(bits.subarray(156,264),108);
  const c=S.call;
  out.voice.push({t:now, src:'DMR', kind:'ambe', slot:S.slot||null, cc:L.cc>=0 ? L.cc : null, seq:'ABCDEF'[S.vseq], from:c?c.from:null, to:c?c.to:null, ambe:dmrHex(dmrBytes(ambe,0,27))});
  if(!emb) return;
  const frag=bits.subarray(116,148);
  if(emb.lcss===1){ S.eraw.set(frag,0); S.est=1; }
  else if(emb.lcss===3 && S.est===1){ S.eraw.set(frag,32); S.est=2; }
  else if(emb.lcss===3 && S.est===2){ S.eraw.set(frag,64); S.est=3; }
  else if(emb.lcss===2 && S.est===3){
    S.eraw.set(frag,96); S.est=0;
    const lc=dmrEmbDecode(S.eraw);
    if(lc) dmrEmbLc(n,L,S,lc,out); else n.st.bad++;
  }
}
function dmrEmbLc(n,L,S,lc,out){
  const flco=dmrNum(lc,2,6), b=dmrBytes(lc,0,9);
  if(flco===0 || flco===3){
    const to=dmrId(b,3), from=dmrId(b,6), flags=dmrSvcOpt(b[2]);
    if(!S.call || S.call.from!==from || S.call.to!==to){
      S.call={from,to,type:dmrCallName(flco),flags,t0:n.now,late:true};
      n.st.lc++;
      dmrEmit(n,S,L,out,'call',{from,to,call:S.call.type,flags:flags.join(','),late:1,source:'embedded LC'},
        'LATE ENTRY '+S.call.type+' '+from+' → '+to+(flags.length ? ' ['+flags.join(',')+']' : ''));
    }
  } else if(flco>=4 && flco<=7){
    const ta=S.ta&&S.ta.from===(S.call&&S.call.from) ? S.ta : (S.ta={from:S.call&&S.call.from, buf:new Uint8Array(28), got:0});
    ta.buf.set(b.subarray(2,9),(flco-4)*7); ta.got|=1<<(flco-4);
    const fmt=ta.buf[0]>>6, size=(ta.buf[0]>>1)&31;
    if(ta.got&1){
      const need=fmt===0 ? Math.ceil((7+size*7)/56) : fmt===3 ? Math.ceil((8+size*16)/56) : Math.ceil((8+size*8)/56);
      if(ta.got===(1<<need)-1 || (need>4 && ta.got===15)){
        const s=dmrTextTA(fmt,size,ta.buf);
        if(s && s!==ta.done){ ta.done=s; if(S.call) S.call.alias=s;
          dmrEmit(n,S,L,out,'alias',{from:S.call&&S.call.from, alias:s},'ALIAS '+(S.call ? S.call.from+' ' : '')+'"'+s+'"'); }
      }
    }
  } else dmrEmit(n,S,L,out,'emb-lc',{flco,raw:dmrHex(b)},'EMB LC FLCO '+flco+' '+dmrHex(b),dmrHex(b));
}

function dmrData(n,L,S,bits,st,out){
  const dt=st.dt, dn=DMR_DT[dt]||'DT '+dt, raw=dmrRaw196(bits);
  if(dt!==9) n.st.data++;
  switch(dt){
  case 9: return;
  case 0: {
    const b=dmrMasked(dmrBptcDec(raw),0x6969);
    if(!b){ n.st.bad++; return; }
    const alg=b[0], mi=dmrHex(b,3,4), to=dmrId(b,7);
    dmrEmit(n,S,L,out,'pi',{alg, fid:b[1], key:b[2], mi, to},'PI (encrypted) alg 0x'+alg.toString(16).toUpperCase()+' key '+b[2]+' MI '+mi+' → '+to,dmrHex(b));
    if(S.call && !S.call.flags.includes('encrypted')) S.call.flags.push('encrypted');
    return; }
  case 1: case 2: {
    const b=dmrLc(dmrBptcDec(raw),dt===1 ? 0x96 : 0x99);
    if(!b){ n.st.bad++; return; }
    const flco=b[0]&63, fid=b[1], flags=dmrSvcOpt(b[2]), to=dmrId(b,3), from=dmrId(b,6);
    if(dt===1){
      n.st.lc++;
      if(S.d) dmrDataFlush(n,L,S,out,'interrupted');
      S.call={from,to,type:dmrCallName(flco),flags,t0:n.now,late:false}; S.vbursts=0; S.ta=null;
      dmrEmit(n,S,L,out,'call',{from,to,call:S.call.type,flags:flags.join(','),flco,fid,source:'LC header'},
        'CALL '+S.call.type+' '+from+' → '+to+(flags.length ? ' ['+flags.join(',')+']' : '')+(fid ? ' FID 0x'+fid.toString(16) : ''),'h'+dmrHex(b));
    } else {
      const c=S.call, dur=c ? Math.round(n.now-c.t0) : null;
      dmrEmit(n,S,L,out,'end',{from,to,call:dmrCallName(flco),voice:S.vbursts,ms:dur,alias:c&&c.alias||undefined},
        'END '+dmrCallName(flco)+' '+from+' → '+to+' · '+S.vbursts+' voice bursts',dmrHex(b));
      S.call=null; S.vbursts=0;
    }
    return; }
  case 3: case 4: {
    const bp=dmrBptcDec(raw), b=dmrMasked(bp,dt===3 ? 0xA5A5 : 0xAAAA);
    if(!b){ n.st.bad++; return; }
    n.st.csbk++;
    const op=b[0]&63, name=DMR_CSBKO[op]||'CSBKO 0x'+op.toString(16), f={op, name, lb:b[0]>>7, pf:(b[0]>>6)&1, fid:b[1], raw:dmrHex(b,0,10)};
    let text=(dt===4 ? 'MBC ' : 'CSBK ')+name;
    if(op===0x3D){ Object.assign(f,{data:b[2]>>7, group:(b[2]>>6)&1, blocks:b[3], to:dmrId(b,4), from:dmrId(b,7)});
      text+=(f.data ? ' data' : ' CSBK')+' ×'+f.blocks+' '+f.from+' → '+(f.group ? 'TG ' : '')+f.to; }
    else if([0x04,0x05,0x1F,0x20,0x24,0x26,0x27,0x30,0x31,0x32,0x33,0x34].includes(op) && dt===3){ f.to=dmrId(b,4); f.from=dmrId(b,7); text+=' '+f.from+' → '+f.to; }
    else if(op===0x38){ f.bs=dmrId(b,4); f.from=dmrId(b,7); text+=' BS '+f.bs+' src '+f.from; }
    else text+=' '+f.raw;
    dmrEmit(n,S,L,out,dt===3 ? 'csbk' : 'mbc',f,text,f.raw);
    return; }
  case 6: return dmrDataHeader(n,L,S,raw,out);
  case 7: case 8: case 10: {
    let by;
    if(dt===7) by=dmrBytes(dmrBptcDec(raw),0,12);
    else if(dt===8) by=dmrBytes(dmrT34Dec(raw).bits,0,18);
    else {                                              // Rate 1 без FEC — не разбирается
      if(S.d) dmrDataFlush(n,L,S,out,'rate 1 data not decoded'); else dmrEmit(n,S,L,out,'data',{dt},'Rate 1 data (not decoded)',dn+dt);
      return;
    }
    if(!S.d){ dmrEmit(n,S,L,out,'block',{rate:dt===7 ? '1/2' : '3/4', raw:dmrHex(by)},(dt===7 ? 'DATA ½ ' : 'DATA ¾ ')+dmrHex(by)+' (no header)',dmrHex(by)); return; }
    const d=S.d;
    d.blk.push(d.conf ? by.subarray(2) : by); d.rate=dt===7 ? '1/2' : '3/4';
    if(d.conf) d.serial.push(by[0]>>1);
    if(d.blk.length>=d.blocks) dmrDataDone(n,L,S,out);
    return; }
  default:
    dmrEmit(n,S,L,out,'data',{dt},dn+' burst',dn+dt);
  }
}
function dmrDataHeader(n,L,S,raw,out){
  const b=dmrMasked(dmrBptcDec(raw),0xCCCC);
  if(!b){ n.st.bad++; return; }
  if(S.d) dmrDataFlush(n,L,S,out,'new header');
  const dpf=b[0]&15, gi=b[0]>>7, ack=(b[0]>>6)&1, to=dmrId(b,2), from=dmrId(b,5);
  const names={0:'UDT',1:'response',2:'unconfirmed',3:'confirmed',13:'short data (defined)',14:'short data (raw)',15:'proprietary'};
  const f={dpf, type:names[dpf]||'DPF '+dpf, to, from, group:gi, ack};
  let blocks=0, extra='';
  if(dpf===2 || dpf===3){
    f.sap=b[1]>>4; f.pad=(((b[0]>>4)&1)<<4)|(b[1]&15); blocks=b[8]&0x7F; f.blocks=blocks;
    extra=' SAP '+(DMR_SAP[f.sap]||f.sap)+' ×'+blocks;
  } else if(dpf===13 || dpf===14){ blocks=(((b[0]>>4)&3)<<4)|(b[1]&15); f.blocks=blocks; f.format=b[1]>>4; f.pad=0; extra=' fmt '+f.format+' ×'+blocks; }
  else if(dpf===1){ blocks=b[8]&0x7F; f.blocks=blocks; extra=' ×'+blocks; }
  else if(dpf===0){ blocks=(b[8]&3)+1; f.blocks=blocks; f.format=b[1]&15; extra=' fmt '+f.format+' ×'+blocks; }
  dmrEmit(n,S,L,out,'data-header',f,'DATA HDR '+f.type+' '+from+' → '+(gi ? 'TG ' : '')+to+extra,dmrHex(b));
  if(blocks>0 && dpf!==15) S.d={dpf, sap:f.sap, pad:f.pad||0, blocks, dd:f.format, conf:dpf===3, blk:[], serial:[], from, to, group:gi, rate:null, hdr:f};
}
function dmrDataFlush(n,L,S,out,why){
  const d=S.d; S.d=null;
  if(d && d.blk.length) dmrEmit(n,S,L,out,'data-partial',{from:d.from,to:d.to,got:d.blk.length,blocks:d.blocks,why},'DATA incomplete '+d.blk.length+'/'+d.blocks+' blocks ('+why+')');
}
function dmrDataDone(n,L,S,out){
  const d=S.d; S.d=null;
  let tot=0; for(const p of d.blk) tot+=p.length;
  const m=new Uint8Array(tot); let o=0; for(const p of d.blk){ m.set(p,o); o+=p.length; }
  const f={from:d.from, to:d.to, group:d.group, type:d.hdr.type, rate:d.rate, blocks:d.blocks, bytes:tot};
  let body=m, crc=null;
  if(d.dpf===0){ body=m; }
  else if(tot>4){
    const want=((m[tot-4]<<24)|(m[tot-3]<<16)|(m[tot-2]<<8)|m[tot-1])>>>0;
    crc=dmrCrc32(m,tot-4)===want; f.crc=crc?'ok':'bad';
    body=m.subarray(0,Math.max(0,tot-4-d.pad));
  }
  let text;
  if(d.dpf===0){
    const fm=d.dd;
    const msg=fm===7 ? dmrUtf16(m,0,tot,false) : fm===3 ? dmrText7(m,0,tot) : dmrPrintable(m,0,tot);
    f.format=fm; f.message=msg; f.data=dmrHex(m,0,Math.min(48,tot)); f.service='UDT';
  } else Object.assign(f,dmrPayload(d.dpf===13||d.dpf===14 ? 10 : d.sap,d.dpf===13||d.dpf===14 ? d.dd : null,body));
  n.st.msgs++;
  text='DATA '+f.from+' → '+(d.group ? 'TG ' : '')+f.to+' '+(f.service||'')+(f.port?' :'+f.port:'')+' '+(crc===false?'[CRC bad] ':'')+(f.message!=null ? '"'+f.message+'"' : f.data||'');
  dmrEmit(n,S,L,out,'message',f,text);
}

/* ---- генератор: сеанс DMR (голос со слотом 1, данные — слот 2) ---- */
function dmrCrc8Gen(b28){
  const t=Array.from(b28); for(let i=0;i<8;i++) t.push(0);
  for(let i=0;i<28;i++) if(t[i]) for(let j=0;j<9;j++) t[i+j]^=[1,0,0,0,0,0,1,1,1][j];
  return t.slice(28,36);
}
function dmrShortLcEnc(b36){
  const d=new Uint8Array(68);
  d.set(b36.subarray(0,12),0); d.set(b36.subarray(12,24),17); d.set(b36.subarray(24,36),34);
  for(const o of [0,17,34]) dmrHamEnc(DMR_H17123,d,o);
  for(let c=0;c<17;c++) d[51+c]=d[c]^d[c+17]^d[c+34];
  const raw=new Uint8Array(68);
  for(let i=0;i<67;i++) raw[(i*4)%67]=d[i];
  raw[67]=d[67];
  return [0,1,2,3].map(j=>raw.slice(17*j,17*j+17));
}
function dmrEncLc(lc9,mask){ const p=dmrRsPar(lc9), a=new Uint8Array(12); a.set(lc9); a[9]=p[0]^mask; a[10]=p[1]^mask; a[11]=p[2]^mask; return dmrBptcEnc(dmrBitsOf(a)); }
function dmrEncMasked(b10,mask){ const a=new Uint8Array(12), c=dmrCrc16(b10,10); a.set(b10); a[10]=(c>>8)^(mask>>8); a[11]=(c&255)^(mask&255); return dmrBptcEnc(dmrBitsOf(a)); }
function dmrSyncBits(p){ const b=new Uint8Array(48); for(let i=0;i<12;i++){ const v=parseInt(p.hex[i],16); for(let k=0;k<4;k++) b[4*i+k]=(v>>(3-k))&1; } return b; }
function dmrDataBurst(cc,dt,raw196,sp){
  const b=new Uint8Array(264), w=DMR_GOLAY[(cc<<4)|dt];
  b.set(raw196.subarray(0,98),0); b.set(raw196.subarray(98),166);
  for(let i=0;i<20;i++){ const v=(w>>(19-i))&1; b[i<10 ? 98+i : 156+i-10]=v; }
  b.set(dmrSyncBits(sp),108);
  return b;
}
function dmrVoiceBurst(ambe,mid){ const b=new Uint8Array(264); b.set(ambe.subarray(0,108),0); b.set(mid,108); b.set(ambe.subarray(108),156); return b; }
function dmrDib(bits){ const d=new Uint8Array(bits.length>>1); for(let i=0;i<d.length;i++) d[i]=bits[2*i]*2+bits[2*i+1]; return d; }
function dmrIpMsg(from,to,text){
  const t=[]; for(const ch of text){ const c=ch.charCodeAt(0); t.push(c&255,c>>8); }
  const tl=2+t.length;
  // UDP: порты, длина (заголовок 8 + TMS), контрольная 0; TMS: длина, заголовок, число адресных байт, текст
  const u=[0x0F,0xA7,0x0F,0xA7,((8+2+tl)>>8)&255,(8+2+tl)&255,0,0,(tl>>8)&255,tl&255,0xA0,0,...t];
  const tot=20+u.length, ip=[0x45,0,tot>>8,tot&255,0,0,0,0,64,17,0,0,12,(from>>16)&255,(from>>8)&255,from&255,12,(to>>16)&255,(to>>8)&255,to&255];
  return Uint8Array.from([...ip,...u]);
}
// сообщение + нули + CRC-32 → блоки по bs октетов
function dmrMsgBlocks(body,bs,padTo){
  const need=Math.ceil((body.length+4)/bs)*bs, pad=need-4-body.length, m=new Uint8Array(need);
  m.set(body); const c=dmrCrc32(m,need-4);
  m[need-4]=c>>>24; m[need-3]=(c>>>16)&255; m[need-2]=(c>>>8)&255; m[need-1]=c&255;
  const blk=[]; for(let i=0;i<need;i+=bs) blk.push(m.subarray(i,i+bs));
  return {blk,pad};
}
function dmrPack7(text,nb){
  const bits=[]; for(const ch of text) for(let k=6;k>=0;k--) bits.push((ch.charCodeAt(0)>>k)&1);
  while(bits.length<nb*8) bits.push(0);
  const r=new Uint8Array(nb); for(let i=0;i<nb*8;i++) r[i>>3]|=bits[i]<<(7-(i&7));
  return r;
}
function dmrBuildScript(mode,cc){
  const sp=(kind)=>DMR_SYNCS.find(p=>p.kind===kind && (mode==='inbound (MS)' ? p.mode==='ms' : mode==='direct TS1' ? p.mode==='direct' && p.slot===1 : mode==='direct TS2' ? p.mode==='direct' && p.slot===2 : p.mode==='bs'));
  const vs=sp('voice'), ds=sp('data');
  let seed=0x1234567; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return (seed>>8)&255; };
  const dburst=(dt,raw)=>dmrDib(dmrDataBurst(cc,dt,raw,ds).subarray(0,264));
  const idle=dburst(9,dmrBptcEnc(new Uint8Array(96)));
  const lcBytes=(flco,to,from)=>Uint8Array.from([flco,0,0,(to>>16)&255,(to>>8)&255,to&255,(from>>16)&255,(from>>8)&255,from&255]);
  const dst=9, src=2600123;
  // слот 1: заголовок, 4 суперкадра, терминатор
  const q1=[dburst(1,dmrEncLc(lcBytes(0,dst,src),0x96))];
  const ta=new Uint8Array(9); ta[0]=4;
  {                                                // формат 0, длина 6, знаки по 7 бит с бита 7
    const s=[0,0,0,0,1,1,0]; for(const ch of 'DSPLAB') for(let k=6;k>=0;k--) s.push((ch.charCodeAt(0)>>k)&1); while(s.length<56) s.push(0); for(let i=0;i<7;i++) for(let k=0;k<8;k++) ta[2+i]|=s[8*i+k]<<(7-k); }
  for(let sf=0;sf<4;sf++){
    const lc=sf===1 ? ta : lcBytes(0,dst,src), er=dmrEmbEncode(dmrBitsOf(lc));
    for(let b=0;b<6;b++){
      const ambe=Uint8Array.from({length:216},()=>rnd()&1), mid=new Uint8Array(48);
      if(b===0) mid.set(dmrSyncBits(vs));
      else {
        const lcss=b===1 ? 1 : b===4 ? 2 : b===5 ? 0 : 3, w=DMR_QR[(cc<<3)|lcss];
        for(let i=0;i<8;i++){ mid[i]=(w>>(15-i))&1; mid[40+i]=(w>>(7-i))&1; }
        if(b<=4) mid.set(er.subarray(32*(b-1),32*b),8);
      }
      q1.push(dmrDib(dmrVoiceBurst(ambe,mid)));
    }
  }
  q1.push(dburst(2,dmrEncLc(lcBytes(0,dst,src),0x99)));
  while(q1.length<28) q1.push(idle);
  // слот 2: два сообщения данных
  const q2=[];
  const pre=(to,from,blocks)=>dmrEncMasked(Uint8Array.from([0xBD,0,0x80,blocks,(to>>16)&255,(to>>8)&255,to&255,(from>>16)&255,(from>>8)&255,from&255]),0xA5A5);
  const id2=[4001234,2600123];
  q2.push(dburst(3,pre(id2[0],id2[1],7)));
  { const {blk,pad}=dmrMsgBlocks(dmrIpMsg(id2[1],id2[0],'Hello from DSP lab'),12,0);
    const h=Uint8Array.from([0x02|((pad>>4)<<4),(4<<4)|(pad&15),(id2[0]>>16)&255,(id2[0]>>8)&255,id2[0]&255,(id2[1]>>16)&255,(id2[1]>>8)&255,id2[1]&255,0x80|blk.length,0]);
    q2.push(dburst(6,dmrEncMasked(h,0xCCCC)));
    for(const b of blk) q2.push(dburst(7,dmrBptcEnc(dmrBitsOf(b)))); }
  q2.push(dburst(3,pre(id2[0],id2[1],1)));
  { const {blk}=dmrMsgBlocks(dmrPack7('DMR TEST 34',10),18,0);
    const bl=blk.length, h=Uint8Array.from([0x8D|(((bl>>4)&3)<<4),(2<<4)|(bl&15),(id2[0]>>16)&255,(id2[0]>>8)&255,id2[0]&255,(id2[1]>>16)&255,(id2[1]>>8)&255,id2[1]&255,1,0]);
    q2.push(dburst(6,dmrEncMasked(h,0xCCCC)));
    for(const b of blk) q2.push(dburst(8,dmrT34Enc(dmrBitsOf(b)))); }
  q2.push(dburst(3,dmrEncMasked(Uint8Array.from([0xB8,0,0,0,0,0,5,(src>>16)&255,(src>>8)&255,src&255]),0xA5A5)));
  while(q2.length<28) q2.push(idle);
  // кадры
  const frames=[];
  if(mode==='repeater (BS)'){
    const act=new Uint8Array(36); act.set([0,0,0,1],0); act.set([1,0,0,0],4); act.set([1,0,1,1],8);
    for(let i=0;i<8;i++){ act[12+i]=(0x5A>>(7-i))&1; act[20+i]=(0xA5>>(7-i))&1; }
    act.set(dmrCrc8Gen(act.subarray(0,28)),28);
    const frag=dmrShortLcEnc(act);
    for(let f=0;f<56;f++){
      const slot=f&1, c=new Uint8Array(24), lcss=[1,3,3,2][f&3];
      c[0]=1; c[1]=slot; c[2]=lcss>>1; c[3]=lcss&1; dmrHamEnc(DMR_H743,c,0); c.set(frag[f&3],7);
      const b24=new Uint8Array(24); for(let k=0;k<24;k++) b24[k]=c[DMR_CACH_IL[k]];
      const fr=new Uint8Array(144); fr.set(dmrDib(b24),0); fr.set((slot ? q2 : q1)[f>>1],12); frames.push(fr);
    }
  } else {
    const first=mode==='direct TS2' ? 1 : 0;
    for(let f=0;f<56;f++){
      if((f&1)!==first){ frames.push(null); continue; }
      const fr=new Uint8Array(144); fr.set(q1[f>>1],0); frames.push(fr);
    }
  }
  const lv=new Float32Array(frames.length*144), map=[1,3,-1,-3];
  frames.forEach((fr,i)=>{ if(fr) for(let k=0;k<144;k++) lv[i*144+k]=map[fr[k]]; });
  return lv;
}
function dmrGenerate(n,sr,N){
  const mode=n.p.dmr||'repeater (BS)';
  let g=n.dmrg;
  if(!g || g.sr!==sr || g.mode!==mode){
    const sps=sr/DMR_BAUD, rx=dmrRrcTaps(sps), hl=(rx.length-1)/2;
    let cal=0; for(let j=0;j<rx.length;j++) cal+=rx[j]*dmrRrc((j-hl)/sps,.2);
    const tab=new Float32Array(769); for(let i=0;i<769;i++) tab[i]=dmrRrc((i-384)/64,.2)/cal;
    g=n.dmrg={sr, mode, t:0, ph:0, lv:dmrBuildScript(mode,1), tab};
  }
  const re=new Float32Array(N), im=new Float32Array(N), S=g.lv.length, kd=2*Math.PI*648/sr, tab=g.tab, lv=g.lv;
  for(let i=0;i<N;i++,g.t++){
    const tau=g.t*DMR_BAUD/sr, kc=Math.floor(tau);
    let f=0;
    for(let k=kc-5;k<=kc+6;k++){ const v=lv[((k%S)+S)%S]; if(v) f+=v*tab[Math.round((tau-k+6)*64)]; }
    g.ph+=kd*f;
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
  }
  g.ph%=2*Math.PI;
  return [re,im];
}
