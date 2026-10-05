"use strict";
/* ============================ GSM: общие определения, кодеры канала, тестовая BCCH-несущая ============================
   Константы бёрстов и кодеры (SCH, FIRE CRC-40, свёртка K=5, перемежение xCCH) — общие для приёмника (gsm.js) и генератора.
   Генератор — режим GSM в IQ Generator: несущая C0 без паузы на всех 8 таймслотах, TS0 по 51-мультикадру (FCCH, SCH, BCCH,
   CCCH), в остальных слотах — заполняющие бёрсты; GMSK BT=0.3 по TS 45.004. Файл грузят и страница, и воркер острова. */

/* ---------- константы (gr-gsm gsm_constants.h) ---------- */
const GSM_OSR=4;
const GSM_SYMBOL_RATE=1625000/6;                     // символов/с
const GSM_TARGET_SR=GSM_SYMBOL_RATE*GSM_OSR;         // 1083333.33 отсч./с
const GSM_TAIL=3, GSM_GUARD_BITS=8, GSM_GUARD_FRAC=0.25, GSM_GUARD=GSM_GUARD_BITS+GSM_GUARD_FRAC;
const GSM_DATA_BITS=57, GSM_N_TRAIN=26, GSM_N_SYNC=64;
const GSM_USEFUL=142, GSM_BURST_SIZE=GSM_USEFUL+2*GSM_TAIL;   // 148
const GSM_SCH_DATA_LEN=39;
const GSM_TS_BITS=GSM_TAIL+GSM_USEFUL+GSM_TAIL+GSM_GUARD_BITS;   // 156
const GSM_TS_PER_FRAME=8, GSM_FRAME_BITS=GSM_TS_PER_FRAME*GSM_TS_BITS+2;   // 1250
const GSM_SYNC_POS=39, GSM_SYNC_SEARCH_RANGE=30;
const GSM_TRAIN_POS=GSM_TAIL+(GSM_DATA_BITS+1)+5, GSM_TRAIN_BEGINNING=5;   // 66
const GSM_SAFETY_MARGIN=6, GSM_CHAN_IMP=5, GSM_MAX_SCH_ERR=10;
const GSM_FCCH_HITS=GSM_USEFUL-4, GSM_FCCH_MISS=1, GSM_FCCH_MAX_OFF=100;

const GSM_SYNC_BITS=[
  1,0,1,1,1,0,0,1,0,1,1,0,0,0,1,0, 0,0,0,0,0,1,0,0,0,0,0,0,1,1,1,1,
  0,0,1,0,1,1,0,1,0,1,0,0,0,1,0,1, 0,1,1,1,0,1,1,0,0,0,0,1,1,0,1,1];
const GSM_TRAIN_SEQ=[
  [0,0,1,0,0,1,0,1,1,1,0,0,0,0,1,0,0,0,1,0,0,1,0,1,1,1],
  [0,0,1,0,1,1,0,1,1,1,0,1,1,1,1,0,0,0,1,0,0,1,0,1,1,1],
  [0,1,0,0,0,0,1,1,1,0,1,1,1,0,1,0,0,1,0,0,0,0,1,1,1,0],
  [0,1,0,0,0,1,1,1,1,0,1,1,0,1,0,0,0,1,0,0,0,1,1,1,1,0],
  [0,0,0,1,1,0,1,0,1,1,1,0,0,1,0,0,0,0,0,1,1,0,1,0,1,1],
  [0,1,0,0,1,1,1,0,1,0,1,1,0,0,0,0,0,1,0,0,1,1,1,0,1,0],
  [1,0,1,0,0,1,1,1,1,1,0,1,1,0,0,0,1,0,1,0,0,1,1,1,1,1],
  [1,1,1,0,1,1,1,1,0,0,0,1,0,0,1,0,1,1,1,0,1,1,1,1,0,0],
  [0,1,1,1,0,0,0,1,0,1,1,1,0,0,0,1,0,1,1,1,0,0,0,1,0,1]];

// Порядок бит как в osmo_conv: r=(state<<1)|bit, out=parity(r&poly), state=r&0xF.
const GSM_G0=0b11001, GSM_G1=0b11011;
function gsmParity(x){ x^=x>>>4; x^=x>>>2; x^=x>>>1; return x&1; }   // чётность бит
// вход — 39 инф. бит (25 данные + 10 CRC + ... ), возвращает 78 кодовых бит (0/1)
function gsmSchConvEncode(u){
  const out=new Int8Array(78); let state=0, o=0;
  for(let i=0;i<39;i++){
    const bit=i<u.length?u[i]:0, r=(state<<1)|bit;
    out[o++]=gsmParity(r&GSM_G0); out[o++]=gsmParity(r&GSM_G1);
    state=r&0xf;
  }
  return out;
}

// CRC-16/10 SCH: poly 0x175, init 0, xor 0x3ff (libosmocore gsm0503_sch_crc10)
function gsmSchCrc10(bits, len){
  let crc=0; const n=9;
  for(let i=0;i<len;i++){ crc^=(bits[i]&1)<<n;
    crc=(crc&(1<<n))?((crc<<1)^0x175):(crc<<1); crc&=0x3ff; }
  return crc^0x3ff;
}

// свёрточный код K=5 (кодер, для самопроверки декодера): u (steps−4 инф. + хвост) → 2·steps бит
function gsmConvK5Encode(u, steps){
  const out=new Int8Array(2*steps); let state=0, o=0;
  for(let i=0;i<steps;i++){ const bit=i<u.length?u[i]:0, r=(state<<1)|bit;
    out[o++]=gsmParity(r&GSM_G0); out[o++]=gsmParity(r&GSM_G1); state=r&0xf; }
  return out;
}
// FIRE CRC-40 (libosmocore gsm0503_fire_crc40): poly 0x0004820009, init 0, xor 0xffffffffff
const GSM_FIRE_POLY=0x0004820009n, GSM_FIRE_MASK=(1n<<40n)-1n;
function gsmFireCrc40(bits, len){
  let crc=0n;
  for(let i=0;i<len;i++){ crc^=BigInt(bits[i]&1)<<39n;
    crc=(crc&(1n<<39n))?((crc<<1n)^GSM_FIRE_POLY):(crc<<1n); crc&=GSM_FIRE_MASK; }
  return crc^0xffffffffffn;
}

function gsmXcchInterleave(cB){
  const iB=new Int8Array(456);
  for(let k=0;k<456;k++){ const B=k&3, j=2*((49*k)%57)+((k&7)>>2); iB[B*114+j]=cB[k]; }
  return iB;
}

// 23 байта L2 → 4×114 бит (для самопроверки): 184 данные + FIRE-40 → свёртка → перемежение
function gsmBcchEncode(l2){
  const conv=new Int8Array(224);
  // TS 04.08: бит 1 октета передаётся первым и является младшим (LSB) — зеркально gsmBcchDecode
  for(let i=0;i<23;i++) for(let b=0;b<8;b++) conv[i*8+b]=(l2[i]>>b)&1;
  const crc=gsmFireCrc40(conv,184);
  for(let i=0;i<40;i++) conv[184+i]=Number((crc>>BigInt(39-i))&1n);
  const coded=gsmConvK5Encode(conv,228);
  const iB=gsmXcchInterleave(coded);
  const bursts=[]; for(let B=0;B<4;B++) bursts.push(iB.subarray(B*114,B*114+114));
  return bursts;
}


/* ---------- тестовая несущая C0 ---------- */
const GSM_SYNC_FILL=0x2B;
const GSM_FCCH_SET=new Set([0,10,20,30,40]), GSM_SCH_SET=new Set([1,11,21,31,41]);

// SCH: BSIC (NCC<<3|BCC) и номер кадра → 78 кодовых бит
function gsmSchBits(bsic,fn){
  const t1=Math.floor(fn/1326)&2047, t2=fn%26, t3p=((fn%51)-1)/10|0, d=new Int8Array(39);
  d[7]=bsic>>5&1; d[6]=bsic>>4&1; d[5]=bsic>>3&1; d[4]=bsic>>2&1; d[3]=bsic>>1&1; d[2]=bsic&1;
  d[1]=t1>>10&1; d[0]=t1>>9&1; d[15]=t1>>8&1; d[14]=t1>>7&1; d[13]=t1>>6&1; d[12]=t1>>5&1; d[11]=t1>>4&1; d[10]=t1>>3&1; d[9]=t1>>2&1; d[8]=t1>>1&1; d[23]=t1&1;
  d[22]=t2>>4&1; d[21]=t2>>3&1; d[20]=t2>>2&1; d[19]=t2>>1&1; d[18]=t2&1;
  d[17]=t3p>>2&1; d[16]=t3p>>1&1; d[24]=t3p&1;
  const crc=gsmSchCrc10(d,25);
  for(let i=0;i<10;i++) d[25+i]=crc>>(9-i)&1;
  return gsmSchConvEncode(d);
}
// 148 бит бёрстов: [хвост 3][данные][хвост 3]
function gsmSchBurst(bsic,fn){
  const c=gsmSchBits(bsic,fn), b=new Int8Array(GSM_BURST_SIZE);
  b.set(c.subarray(0,39),3); b.set(GSM_SYNC_BITS,3+39); b.set(c.subarray(39),3+39+GSM_N_SYNC);
  return b;
}
function gsmNormalBurst(d114,tsc){
  const b=new Int8Array(GSM_BURST_SIZE);
  b.set(d114.subarray(0,57),3); b.set(GSM_TRAIN_SEQ[tsc],3+57+1); b.set(d114.subarray(57),3+57+1+GSM_N_TRAIN+1);
  return b;
}
// L2-кадры (23 байта): SI1…SI4 и пустой CCCH
function gsmL2(type,cell){
  const l=new Uint8Array(23).fill(GSM_SYNC_FILL);
  const lai=(o)=>{
    const m=String(cell.mcc).padStart(3,'0'), n=String(cell.mnc), n2=n.length===2;
    l[o]=(+m[1]<<4)|+m[0]; l[o+1]=((n2?15:+n[2])<<4)|+m[2]; l[o+2]=(+n[1]<<4)|+n[0];
    l[o+3]=cell.lac>>8&255; l[o+4]=cell.lac&255;
  };
  l[1]=0x06;
  if(type==='SI3'){ l[0]=0x49; l[2]=0x1b; l[3]=cell.ci>>8&255; l[4]=cell.ci&255; lai(5);
    l.set([0x01,0x03,0x00, 0x28, 0x45,0x0c, 0x47,0x00,0x00,0x00],10); }
  else if(type==='SI4'){ l[0]=0x31; l[2]=0x1c; lai(3); l.set([0x45,0x0c, 0x47,0x00,0x00,0x00],8); }
  else { l[0]=0x59; l[2]={SI1:0x19,SI2:0x1a,SI2bis:0x02,SI2ter:0x03,CCCH:0x21}[type]; if(type==='CCCH'){ l[0]=0x15; l[3]=0x00; l[4]=0x01; l[5]=0xf0; } }
  return l;
}
const GSM_SI_ROT=['SI1','SI2','SI3','SI4','SI2bis','SI2ter','SI3','SI4'];

// частотный импульс GMSK, BT=0.3 (T=1): q(x)=∫g, g — прямоугольник, свёрнутый с гауссианой, центр в 0.5; q(∞)=0.5
const GSM_Q_STEP=32, GSM_Q_LO=-2, GSM_Q_HI=3;
let GSM_Q=null;
function gsmQTable(){
  if(GSM_Q) return GSM_Q;
  const c=2*Math.PI*0.3/Math.sqrt(Math.LN2), N=(GSM_Q_HI-GSM_Q_LO)*GSM_Q_STEP, q=new Float64Array(N+2);
  const erfc=x=>{ const t=1/(1+.3275911*Math.abs(x)), y=t*(.254829592+t*(-.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429))))*Math.exp(-x*x); return x>=0?y:2-y; };
  const Qf=z=>.5*erfc(z/Math.SQRT2), dx=1/GSM_Q_STEP;
  let s=0;
  for(let i=0;i<=N;i++){ const x=GSM_Q_LO+i*dx; q[i]=s; s+=.5*(Qf(c*(x-1))-Qf(c*x))*dx; }
  const k=.5/q[N]; for(let i=0;i<=N;i++) q[i]*=k; q[N+1]=.5;
  return GSM_Q=q;
}
function gsmQ(x){
  if(x<=GSM_Q_LO) return 0;
  if(x>=GSM_Q_HI) return .5;
  const u=(x-GSM_Q_LO)*GSM_Q_STEP, i=u|0, f=u-i, q=GSM_Q;
  return q[i]+(q[i+1]-q[i])*f;
}

function gsmParseCell(s){
  const m=/^\s*(\d{3})\D+(\d{2,3})\D+(\d+)\D+(\d+)\s*$/.exec(s||'');
  return m ? {mcc:m[1], mnc:m[2], lac:+m[3]&65535, ci:+m[4]&65535} : {mcc:'250', mnc:'01', lac:1234, ci:5678};
}
// следующий таймслот → биты (до дифф. кодирования) в g.sym как ±1
function gsmNextSlot(g){
  const tn=g.tn, f51=g.fn%51, bsic=g.bsic&63, tsc=bsic&7;
  let burst;
  if(tn===0 && GSM_FCCH_SET.has(f51)) burst=new Int8Array(GSM_BURST_SIZE);
  else if(tn===0 && GSM_SCH_SET.has(f51)) burst=gsmSchBurst(bsic,g.fn);
  else if(tn===0 && f51>=2 && f51<=5){
    const k=g.fn/51|0, key=GSM_SI_ROT[k&7]+'|'+k;
    if(g.siKey!==key){ g.siKey=key; g.si=gsmBcchEncode(gsmL2(GSM_SI_ROT[k&7],g.cell)); }
    burst=gsmNormalBurst(g.si[f51-2],tsc);
  } else if(tn===0 && f51!==50){
    if(!g.idle) g.idle=gsmBcchEncode(gsmL2('CCCH',g.cell));
    burst=gsmNormalBurst(g.idle[(f51-6)&3],tsc);
  } else {
    const d=new Int8Array(114); for(let i=0;i<114;i++){ g.rng^=g.rng<<13; g.rng^=g.rng>>>17; g.rng^=g.rng<<5; d[i]=g.rng>>>31; }
    burst=gsmNormalBurst(d,tsc);
  }
  const guard=(tn===0||tn===4) ? 9 : 8;
  for(let i=0;i<GSM_BURST_SIZE+guard;i++){
    const b=i<GSM_BURST_SIZE ? burst[i] : 0;
    g.sym.push(1-2*(b^g.prev)); g.prev=b;       // d=b⊕b₋₁, α=1−2d
  }
  if(++g.tn===8){ g.tn=0; g.fn++; }
}
function gsmGenerate(n,sr,N){
  let g=n.gsm;
  if(!g || g.sr!==sr || g.key!==n.p.gsmCell+'|'+n.p.bsic){
    gsmQTable();
    g=n.gsm={sr, key:n.p.gsmCell+'|'+n.p.bsic, cell:gsmParseCell(n.p.gsmCell), bsic:+n.p.bsic||0,
             sym:[], base:0, acc:0, x:0, tn:0, fn:0, prev:0, rng:0x9e3779b9, siKey:'', si:null, idle:null};
  }
  const re=new Float32Array(N), im=new Float32Array(N), dx=GSM_SYMBOL_RATE/sr;
  for(let s=0;s<N;s++){
    const k=Math.floor(g.x);
    while(g.base+g.sym.length<=k+2) gsmNextSlot(g);
    let ph=g.acc;
    for(let i=k-3;i<=k+2;i++) if(i>=g.base) ph+=g.sym[i-g.base]*gsmQ(g.x-i);
    ph*=Math.PI;
    re[s]=Math.cos(ph); im[s]=Math.sin(ph);
    g.x+=dx;
    const k2=Math.floor(g.x);
    if(k2>k){ const o=k-3; if(o>=g.base){ g.acc=(g.acc+.5*g.sym[o-g.base])%2; if(o-g.base>4096){ g.sym.splice(0,2048); g.base+=2048; } } }
  }
  return [re,im];
}
