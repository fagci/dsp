"use strict";
/* ============================ TETRA (прямой канал, π/4-DQPSK) ============================
   Ядро IQK (страница и воркер), без DOM. IQ → RRC 0.35 → 8 решёток по ⅛ символа → дифференциальные приращения фазы →
   поиск пакета по частотной поправке и синхропоследовательности → BSCH (цвет, MCC/MNC, номер слота) → пакеты по тренировочным
   последовательностям на сетке слотов (255 символов, 18 000 Бод).
   Блок: дескремблирование → деперемежение → снятие выкалывания (RCPC 2/3) → Витерби (K=5, 1/4, мягкие решения) → CRC-16.
   Верхний MAC: AACH, SYNC, SYSINFO, MAC-RESOURCE (адрес, выделение канала, шифрование), LLC / MLE / CMCE — только имена PDU.
   Речь (ACELP) не разбирается. Кодеры тех же блоков нужны генератору и тестам. */

const TETRA_BAUD=18000, TETRA_SYM=255, TETRA_PH=8, TETRA_RING=1024, TETRA_RM=1023;
const TETRA_SCR0=3;                                    // скремблер BSCH: MCC=MNC=CC=0

/* ---- последовательности (биты, первый передаётся первым) ---- */
const TETRA_SEQ={
  n:[1,1,0,1,0,0,0,0,1,1,1,0,1,0,0,1,1,1,0,1,0,0],
  p:[0,1,1,1,1,0,1,0,0,1,0,0,0,0,1,1,0,1,1,1,1,0],
  q:[1,0,1,1,0,1,1,1,0,0,0,0,0,1,1,0,1,0,1,1,0,1],
  y:[1,1,0,0,0,0,0,1,1,0,0,1,1,1,0,0,1,1,1,0,1,0,0,1,1,1,0,0,0,0,0,1,1,0,0,1,1,1]};
// дибит (b1,b2) → приращение фазы в π/4: 00 → +1, 01 → +3, 11 → −3, 10 → −1
const TETRA_INC={'00':1,'01':3,'11':-3,'10':-1};
// шаблоны приращений (комплексные единицы) для корреляции
const TETRA_TPL={};
for(const k of ['n','p','y']){
  const b=TETRA_SEQ[k], L=b.length>>1, re=new Float32Array(L), im=new Float32Array(L);
  for(let i=0;i<L;i++){ const a=TETRA_INC[''+b[2*i]+b[2*i+1]]*Math.PI/4; re[i]=Math.cos(a); im[i]=Math.sin(a); }
  TETRA_TPL[k]={re,im,len:L};
}
// положение в пакете (в символах): тренировочная последовательность нормального пакета, y в синхропакете, частотная поправка
const TETRA_POS={n:122,p:122,y:107,fcMid:11,fcLen:32};

/* ---- скремблер (EN 300 392-2, 8.2.5): сдвиговый регистр 32 бита ---- */
const tetraScrCache=new Map();
function tetraScrInit(mcc,mnc,cc){ return ((((cc&63)|((mnc&0x3fff)<<6)|((mcc&1023)<<20))<<2)|TETRA_SCR0)>>>0; }
function tetraScrSeq(init,len){
  const key=init+'|'+len, c=tetraScrCache.get(key);
  if(c) return c;
  const o=new Uint8Array(len); let l=init>>>0;
  for(let i=0;i<len;i++){
    const b=(l^(l>>>6)^(l>>>9)^(l>>>10)^(l>>>16)^(l>>>20)^(l>>>21)^(l>>>22)^(l>>>24)^(l>>>25)^(l>>>27)^(l>>>28)^(l>>>30)^(l>>>31))&1;
    l=((l>>>1)|(b<<31))>>>0; o[i]=b;
  }
  if(tetraScrCache.size>64) tetraScrCache.clear();
  tetraScrCache.set(key,o);
  return o;
}

/* ---- перемежитель: k = 1 + (a·i mod K) ---- */
const tetraIlvCache={};
function tetraIlv(K,a){
  const key=K+'|'+a; let t=tetraIlvCache[key];
  if(!t){ t=tetraIlvCache[key]=new Uint16Array(K); for(let i=1;i<=K;i++) t[i-1]=(a*i)%K; }
  return t;
}

/* ---- свёрточный код 1/4, K=5: G1=1+D+D⁴, G2=1+D²+D³+D⁴, G3=1+D+D²+D⁴, G4=1+D+D³+D⁴; выкалывание 2/3 ---- */
// состояние: d0 (последний бит) в бите 0 … d3 в бите 3
const TETRA_TR=(()=>{
  const out=new Uint8Array(32), nxt=new Uint8Array(32);
  for(let s=0;s<16;s++) for(let b=0;b<2;b++){
    const d0=s&1, d1=(s>>1)&1, d2=(s>>2)&1, d3=(s>>3)&1;
    const g1=b^d0^d3, g2=b^d1^d2^d3, g3=b^d0^d1^d3, g4=b^d0^d2^d3;
    out[s*2+b]=g1|(g2<<1)|(g3<<2)|(g4<<3); nxt[s*2+b]=((s<<1)|b)&15;
  }
  return {out,nxt};
})();
// индекс бита материнского кода для j-го бита после выкалывания 2/3 (j с 0)
const tetraPunct23=len=>{ const t=new Uint16Array(len), P=[0,1,2,5]; for(let j=1;j<=len;j++){ const q=Math.floor((j-1)/3); t[j-1]=8*q+P[j-3*q]-1; } return t; };
function tetraConvEnc(bits,L){                       // L бит → 4L бит материнского кода
  const o=new Uint8Array(4*L); let s=0;
  for(let i=0;i<L;i++){ const b=bits[i]&1, m=TETRA_TR.out[s*2+b]; for(let k=0;k<4;k++) o[4*i+k]=(m>>k)&1; s=TETRA_TR.nxt[s*2+b]; }
  return o;
}
// мягкий Витерби: m — 4L мягких значений материнского кода (+ → 0, − → 1, 0 — стёрто); начало и конец в нулевом состоянии
function tetraViterbi(m,L){
  const NEG=-1e30; let pm=new Float32Array(16).fill(NEG), nm=new Float32Array(16);
  pm[0]=0;
  const dec=new Uint8Array(L*16);
  for(let i=0;i<L;i++){
    nm.fill(NEG);
    const v0=m[4*i], v1=m[4*i+1], v2=m[4*i+2], v3=m[4*i+3];
    for(let s=0;s<16;s++){
      const p=pm[s]; if(p<=NEG) continue;
      for(let b=0;b<2;b++){
        const o=TETRA_TR.out[s*2+b], ns=TETRA_TR.nxt[s*2+b];
        const c=p+((o&1)?-v0:v0)+((o&2)?-v1:v1)+((o&4)?-v2:v2)+((o&8)?-v3:v3);
        if(c>nm[ns]){ nm[ns]=c; dec[i*16+ns]=(s<<1)|b; }       // прежнее состояние s, вход b
      }
    }
    const t=pm; pm=nm; nm=t;
  }
  const out=new Uint8Array(L); let s=0;
  for(let i=L-1;i>=0;i--){ const d=dec[i*16+s]; out[i]=d&1; s=d>>1; }
  return {bits:out, metric:pm[0]};
}

/* ---- CRC-16 CCITT (init 0xFFFF, остаток при верном блоке 0x1D0F) ---- */
function tetraCrc(bits,len){
  let c=0xFFFF;
  for(let i=0;i<len;i++){ c^=(bits[i]&1)<<15; c=(c&0x8000) ? ((c<<1)^0x1021)&0xFFFF : (c<<1)&0xFFFF; }
  return c;
}

/* ---- блок: тип-1 → тип-5 (кодер) и обратно (декодер) ---- */
// k345 — длина блока на воздухе, a — параметр перемежителя; t1 — бит информации (без CRC и хвоста)
const TETRA_BLK={ sb1:{k:120,a:11,t1:60}, hd:{k:216,a:101,t1:124}, full:{k:432,a:103,t1:268} };
function tetraBlkEnc(t1bits,blk,scrInit){
  const t2=blk.t1+20, b=new Uint8Array(t2);
  b.set(t1bits.subarray(0,blk.t1));
  const c=tetraCrc(b,blk.t1)^0xFFFF;
  for(let i=0;i<16;i++) b[blk.t1+i]=(c>>(15-i))&1;
  const mother=tetraConvEnc(b,t2), pu=tetraPunct23(blk.k), t3=new Uint8Array(blk.k);
  for(let j=0;j<blk.k;j++) t3[j]=mother[pu[j]];
  const il=tetraIlv(blk.k,blk.a), t4=new Uint8Array(blk.k);
  for(let i=0;i<blk.k;i++) t4[il[i]]=t3[i];
  const sc=tetraScrSeq(scrInit,blk.k);
  for(let i=0;i<blk.k;i++) t4[i]^=sc[i];
  return t4;
}
// soft — мягкие биты тип-5 (+ → 0); результат {ok, bits (t1), metric}
function tetraBlkDec(soft,blk,scrInit){
  const k=blk.k, t2=blk.t1+20, sc=tetraScrSeq(scrInit,k), il=tetraIlv(k,blk.a), pu=tetraPunct23(k);
  const m=new Float32Array(4*t2);
  for(let i=0;i<k;i++){
    const v=sc[il[i]] ? -soft[il[i]] : soft[il[i]];     // деперемежение: i-й бит тип-3 стоит на месте il[i]
    m[pu[i]]=v;
  }
  const r=tetraViterbi(m,t2);
  return {ok:tetraCrc(r.bits,blk.t1+16)===0x1D0F, bits:r.bits.subarray(0,blk.t1), metric:r.metric};
}

/* ---- AACH: РМ(30,14), систематический, скремблирован кодом соты ---- */
const TETRA_RMG=[
  [1,0,0,1,1,0,1,1,0,1,1,0,0,0,0,0],[0,0,1,0,1,1,0,1,1,1,1,0,0,0,0,0],[1,1,1,1,1,1,0,0,0,0,1,0,0,0,0,0],
  [1,1,1,0,0,0,0,0,0,0,1,1,1,1,0,0],[1,0,0,1,1,0,0,0,0,0,1,1,1,0,1,0],[0,1,0,1,0,1,0,0,0,0,1,1,0,1,1,0],
  [0,0,1,0,1,1,0,0,0,0,1,0,1,1,1,0],[1,1,1,1,1,1,1,1,1,1,0,1,1,1,1,1],[1,0,0,0,0,0,1,1,0,0,1,1,1,0,0,1],
  [0,1,0,0,0,0,1,0,1,0,1,1,0,1,0,1],[0,0,1,0,0,0,0,1,1,0,1,0,1,1,0,1],[0,0,0,1,0,0,1,0,0,1,1,1,0,0,1,1],
  [0,0,0,0,1,0,0,1,0,1,1,0,1,0,1,1],[0,0,0,0,0,1,0,0,1,1,1,0,0,1,1,1]];
let tetraRmTab=null;
function tetraRmEnc(info14){                          // 14-битное число → 30-битное слово (старший бит — первый)
  if(!tetraRmTab){
    const rows=TETRA_RMG.map((g,i)=>{ let v=1<<(29-i); for(let j=0;j<16;j++) if(g[j]) v|=1<<(15-j); return v>>>0; });
    tetraRmTab=new Uint32Array(16384);
    for(let x=0;x<16384;x++){ let v=0; for(let i=0;i<14;i++) if((x>>(13-i))&1) v^=rows[i]; tetraRmTab[x]=v>>>0; }
  }
  return tetraRmTab[info14];
}
function tetraPop(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
// слово 30 бит → {info (14 бит), dist}; ближайшее кодовое слово
function tetraRmDec(w){
  tetraRmEnc(0);
  let bd=99, bi=0;
  for(let x=0;x<16384;x++){ const d=tetraPop((w^tetraRmTab[x])>>>0); if(d<bd){ bd=d; bi=x; if(!d) break; } }
  return {info:bi, dist:bd};
}

/* ---- разбор PDU ---- */
function tetraBits(b,pos,len){ let v=0; for(let i=0;i<len;i++) v=v*2+(b[pos+i]&1); return v; }
function tetraHex(b,pos,len){ let s=''; for(let i=0;i<len;i+=4){ let v=0; for(let j=0;j<4;j++) v=(v<<1)|(i+j<len ? b[pos+i+j]&1 : 0); s+=v.toString(16); } return s; }

// SYNC PDU (BSCH, 60 бит): системный код 4, цвет 6, TN 2, FN 5, MN 6, режим 2, зарезервированные кадры 3, DTX 1, расширение кадра 18 1, резерв 1, MCC 10, MNC 14, соседи 2, уровень 2, позднее вхождение 1
function tetraSync(b){
  return {sys:tetraBits(b,0,4), cc:tetraBits(b,4,6), tn:tetraBits(b,10,2)+1, fn:tetraBits(b,12,5), mn:tetraBits(b,17,6),
    sharing:tetraBits(b,23,2), reserved:tetraBits(b,25,3), dtx:b[28], f18ext:b[29], mcc:tetraBits(b,31,10), mnc:tetraBits(b,41,14),
    nbr:tetraBits(b,55,2), svc:tetraBits(b,57,2), late:b[59]};
}
function tetraSyncBits(s){
  const b=new Uint8Array(60), put=(p,l,v)=>{ for(let i=0;i<l;i++) b[p+i]=(v>>(l-1-i))&1; };
  put(0,4,s.sys||0); put(4,6,s.cc); put(10,2,s.tn-1); put(12,5,s.fn); put(17,6,s.mn); put(23,2,s.sharing||0); put(25,3,s.reserved||0);
  b[28]=s.dtx||0; b[29]=s.f18ext||0; put(31,10,s.mcc); put(41,14,s.mnc); put(55,2,s.nbr||0); put(57,2,s.svc||0); b[59]=s.late||0;
  return b;
}
const TETRA_BAND_HZ=b=>b*100e6, TETRA_OFFS=[0,6250,-6250,12500];
const tetraDlHz=(band,carrier,off)=>TETRA_BAND_HZ(band)+carrier*25000+TETRA_OFFS[off&3];
// SYSINFO (MAC-BROADCAST, 124 бита): 82 бита MAC + 42 бита MLE (LA 14, класс абонентов 16, сервисы 12)
const TETRA_SERV=['registration mandatory','de-registration mandatory','priority cell','no minimum mode','migration','system-wide services','voice','circuit data','(res)','SNDCP data','air encryption','advanced link'];
function tetraSysinfo(b){
  let c=4;
  const r={carrier:tetraBits(b,c,12), band:tetraBits(b,c+12,4), off:tetraBits(b,c+16,2), duplex:tetraBits(b,c+18,3), reverse:b[c+21],
    ncs:tetraBits(b,c+22,2), txpwr:tetraBits(b,c+24,3), rxmin:tetraBits(b,c+27,4), access:tetraBits(b,c+31,4), timeout:tetraBits(b,c+35,4)};
  c+=39; r.cckValid=b[c++]; const v=tetraBits(b,c,16); c+=16;
  if(r.cckValid) r.cck=v; else r.hyper=v;
  r.opt=tetraBits(b,c,2);
  r.la=tetraBits(b,82,14); r.subscr=tetraBits(b,96,16); r.serv=tetraBits(b,112,12);
  r.dlHz=tetraDlHz(r.band,r.carrier,r.off);
  const sp=[[0,1600,10000,10000,10000,10000,10000],[0,4500,0,36000,7000,0,0,0,45000,45000],[],[0,0,0,8000,8000,0,0,0,18000,18000],[0,0,0,18000,5000,0,30000,30000,0,39000],[0,0,0,0,9500]][r.duplex]||[];
  const d=(sp[r.band]||0)*1000;
  r.ulHz=d ? r.dlHz+(r.reverse ? d : -d) : 0;
  r.services=TETRA_SERV.filter((_,i)=>(r.serv>>(11-i))&1);
  r.encrypted=!!((r.serv>>1)&1);
  return r;
}
function tetraSysinfoBits(s){
  const b=new Uint8Array(124), put=(p,l,v)=>{ for(let i=0;i<l;i++) b[p+i]=(v>>(l-1-i))&1; };
  put(0,2,2); put(2,2,0); put(4,12,s.carrier); put(16,4,s.band); put(20,2,s.off); put(22,3,s.duplex); b[25]=s.reverse||0;
  put(26,2,s.ncs||0); put(28,3,s.txpwr||0); put(31,4,s.rxmin||0); put(35,4,s.access||0); put(39,4,s.timeout||0);
  b[43]=s.cckValid?1:0; put(44,16,s.cckValid ? s.cck : s.hyper); put(60,2,s.opt||0); put(62,20,0);
  put(82,14,s.la); put(96,16,s.subscr||0); put(112,12,s.serv);
  return b;
}
// ACCESS-ASSIGN (14 бит): заголовок 2, два поля по 6; на кадре 18 только поля доступа
const TETRA_DLU=['unallocated','assigned control','common control','reserved'];
function tetraAach(info,f18){
  const hdr=info>>12, f1=(info>>6)&63, f2=info&63, r={hdr,f1,f2,traffic:0};
  if(f18){ r.dl='frame 18'; return r; }
  if(hdr===0) r.dl='common control';
  else { r.dl=f1>3 ? 'traffic' : TETRA_DLU[f1]; if(f1>3) r.traffic=f1; }
  if(hdr===3) r.ul=f2 ? 'traffic' : 'unallocated';
  return r;
}
// MAC-RESOURCE: имена, адрес, выделение канала
const TETRA_ADDR=['null','SSI','event label','USSI','SMI','SSI+event','SSI+usage','SMI+event'];
const TETRA_ALLOC=['replace','additional','quit and go','replace + slot 1'];
const TETRA_ULDL=['augmented','downlink','uplink','uplink+downlink'];
function tetraChanAlloc(b,pos,band,off){
  let c=pos;
  const r={type:tetraBits(b,c,2), ts:tetraBits(b,c+2,4), uldl:tetraBits(b,c+6,2)}; c+=8;
  r.clch=b[c++]; r.cellChg=b[c++]; r.carrier=tetraBits(b,c,12); c+=12;
  if(b[c++]){ band=tetraBits(b,c,4); off=tetraBits(b,c+4,2); c+=10; r.extCarrier=true; }
  const mp=tetraBits(b,c,2); c+=2;
  if(mp===0) c+=2;
  if(r.uldl===0){ r.aug=true; return {r,len:-1}; }                  // расширенный вариант (QAM) не разбирается
  r.dlHz=band!=null ? tetraDlHz(band,r.carrier,off) : 0;
  return {r,len:c-pos};
}
function tetraResource(b,len,band,off){
  const r={fill:b[2], grantPos:b[3], enc:tetraBits(b,4,2), rand:b[6], lenInd:tetraBits(b,7,6), addrType:tetraBits(b,13,3)};
  let c=16;
  const at=r.addrType;
  if(at===0){ r.addr='null'; r.octets=r.lenInd; r.end=true; return r; }
  if(at===2){ r.event=tetraBits(b,c,10); }
  else {
    r.ssi=tetraBits(b,c,24);
    if(at===5||at===7) r.event=tetraBits(b,c+24,10);
    else if(at===6) r.usage=tetraBits(b,c+24,6);
  }
  c+=[0,24,10,24,24,34,30,34][at];
  const li=r.lenInd;
  r.octets=li>=1 && li<=0x3a ? li : 0;
  r.frag=li===0x3f; r.stolen2=li===0x3e;
  r.addr=TETRA_ADDR[at]+' '+(r.ssi!=null ? r.ssi : r.event)+(r.usage!=null ? '/U'+r.usage : '')+(at===5||at===7 ? '/E'+r.event : '');
  if(r.enc){ r.tm=-1; return r; }                                  // после адреса шифрование: дальше не разобрать
  if(b[c++]) c+=4;
  if(b[c++]) c+=8;                                                 // basic slot granting
  if(b[c++]){
    const a=tetraChanAlloc(b,c,band,off);
    r.alloc=a.r;
    if(a.len<0){ r.tm=-1; return r; }
    c+=a.len;
  }
  r.tm=c;
  return r;
}
// LLC → MLE: имена PDU верхних уровней (без разбора полей)
const TETRA_LLC=['BL-ADATA','BL-DATA','BL-UDATA','BL-ACK','BL-ADATA+FCS','BL-DATA+FCS','BL-UDATA+FCS','BL-ACK+FCS','AL-SETUP','AL-DATA/FINAL','AL-UDATA/UFINAL','AL-ACK/RNR','AL-RECONNECT','AL-SUPPL','AL-L2SIG','AL-DISC'];
const TETRA_PDISC={1:'MM',2:'CMCE',4:'SNDCP',5:'MLE',6:'MGMT',7:'TEST'};
const TETRA_CMCE=['D-ALERT','D-CALL PROCEEDING','D-CONNECT','D-CONNECT ACK','D-DISCONNECT','D-INFO','D-RELEASE','D-SETUP','D-STATUS','D-TX CEASED','D-TX CONTINUE','D-TX GRANTED','D-TX WAIT','D-TX INTERRUPT','D-CALL RESTORE','D-SDS DATA','D-FACILITY'];
const TETRA_MM={0:'D-OTAR',1:'D-AUTHENTICATION',2:'D-CK CHANGE DEMAND',3:'D-DISABLE',4:'D-ENABLE',5:'D-LOCATION UPDATE ACCEPT',6:'D-LOCATION UPDATE COMMAND',7:'D-LOCATION UPDATE REJECT',9:'D-LOCATION UPDATE PROCEEDING',10:'D-ATTACH/DETACH GROUP ID',11:'D-ATTACH/DETACH GROUP ID ACK',12:'D-MM STATUS',15:'MM PDU NOT SUPPORTED'};
const TETRA_MLE=['D-NEW CELL','D-PREPARE FAIL','D-NWRK BROADCAST','D-NWRK BROADCAST EXT','D-RESTORE ACK','D-RESTORE FAIL','D-CHANNEL RESPONSE'];
function tetraTmSdu(b,pos,end){
  const len=end-pos;
  if(len<4) return null;
  const t=tetraBits(b,pos,4), r={llc:TETRA_LLC[t]};
  let c=pos+4, e=end;
  if(t<=7 && t>=4) e-=32;                                          // FCS
  if(t===0||t===4) c+=2; else if(t===1||t===5||t===3||t===7) c+=1;
  if(t>7 || e-c<4) return r;
  if(t===3||t===7) return r;                                       // BL-ACK без данных
  const d=tetraBits(b,c,3); c+=3;
  r.disc=TETRA_PDISC[d]||('PD'+d);
  if(d===2 && e-c>=5){ const k=tetraBits(b,c,5); r.pdu=TETRA_CMCE[k]||('type '+k); }
  else if(d===1 && e-c>=4){ const k=tetraBits(b,c,4); r.pdu=TETRA_MM[k]||('type '+k); }
  else if(d===5 && e-c>=3){ const k=tetraBits(b,c,3); r.pdu=TETRA_MLE[k]||('type '+k); }
  r.bits=[c,e];
  return r;
}

/* ---- кодеры для генератора ---- */
function tetraPutBits(b,pos,len,v){ for(let i=0;i<len;i++) b[pos+i]=Math.floor(v/Math.pow(2,len-1-i))&1; }
// MAC-RESOURCE с SSI-адресом и TM-SDU (биты); остаток блока — NULL PDU и заполнение
function tetraResourceBits(blkBits,ssi,sdu,alloc){
  const b=new Uint8Array(blkBits); let c=0;
  const put=(l,v)=>{ tetraPutBits(b,c,l,v); c+=l; };
  put(2,0); const fillAt=c; put(1,0); put(1,0); put(2,0); put(1,0); const liAt=c; put(6,0); put(3,1); put(24,ssi);
  put(1,0); put(1,0);
  if(alloc){ put(1,1); put(2,0); put(4,alloc.ts); put(2,alloc.uldl); put(1,0); put(1,0); put(12,alloc.carrier); put(1,0); put(2,3); }
  else put(1,0);
  for(let i=0;i<sdu.length;i++) b[c++]=sdu[i];
  let fill=0;
  if(c&7){ fill=1; b[c++]=1; while(c&7) b[c++]=0; }
  tetraPutBits(b,fillAt,1,fill); tetraPutBits(b,liAt,6,c>>3);
  if(c+17<=blkBits){                                               // NULL PDU: тип 00, заполнение 1, длина 2, адрес 000
    b[c+2]=1; tetraPutBits(b,c+7,6,2);
    c+=16; b[c]=1;
  }
  return b;
}

/* ---- речь TCH/S: 432 бита слота → два кадра кодека по 137 бит ----
   Матричное деперемежение 24×18, класс 0 (102 бита) без защиты, классы 1 и 2 — один сверточный код 1/3
   (G1=1+D+D²+D³+D⁴, G2=1+D+D³+D⁴, G3=1+D²+D⁴), 112 бит с выкалыванием 8/12 и 72 бита (60 + CRC-8 + хвост) с 8/18.
   Порядок битов в кадре — таблица 4 EN 300 395-2 (позиции с 1). */
const TETRA_C0=[35,36,37,38,39,40,41,42,43,47,48,56,61,62,63,64,65,66,67,68,69,70,74,75,83,88,89,90,91,92,93,94,95,96,97,101,102,110,115,116,117,118,119,120,121,122,123,124,128,129,137];
const TETRA_C1=[58,85,112,54,81,108,135,50,77,104,131,45,72,99,126,55,82,109,136,5,13,34,8,16,17,22,23,24,25,26,6,14,7,15,60,87,114,46,73,100,127,44,71,98,125,33,49,76,103,130,59,86,113,57,84,111];
const TETRA_C2=[18,19,20,21,31,32,53,80,107,134,1,2,3,4,9,10,11,12,27,28,29,30,52,79,106,133,51,78,105,132];
// type-4 мягкие биты (+ → 0, 432) → 274 бита кадров кодека (кадр 0, кадр 1)
function tetraSpeech(t4){
  const d=new Float32Array(432);
  for(let c=0;c<18;c++) for(let l=0;l<24;l++) d[l*18+c]=t4[c*24+l];
  const t2=new Uint8Array(274);
  for(let i=0;i<102;i++) t2[i]=d[i]<0 ? 1 : 0;
  // 184 позиции × 3 бита материнского кода; выколотые — 0 (стёрто)
  const sym=new Float32Array(184*3); let k=102;
  for(let pos=0;pos<184;pos++){
    const a=pos<112, ph=a ? pos : pos-112;
    sym[pos*3]=d[k++];
    if(a ? (ph&1)===0 : true) sym[pos*3+1]=d[k++];
    if(!a && (ph&3)===0) sym[pos*3+2]=d[k++];
  }
  const NEG=-1e30; let pm=new Float32Array(16).fill(NEG), nm=new Float32Array(16); pm[0]=0;
  const dec=new Uint8Array(184*16), par=v=>{ v^=v>>4; v^=v>>2; v^=v>>1; return v&1; };
  for(let pos=0;pos<184;pos++){
    nm.fill(NEG);
    const v0=sym[pos*3], v1=sym[pos*3+1], v2=sym[pos*3+2];
    for(let s=0;s<16;s++){
      const p=pm[s]; if(p<=NEG) continue;
      for(let b=0;b<2;b++){
        const x=(b<<4)|s, ns=(b<<3)|(s>>1);
        const c=p+(par(x&0x1f) ? -v0 : v0)+(par(x&0x1b) ? -v1 : v1)+(par(x&0x15) ? -v2 : v2);
        if(c>nm[ns]){ nm[ns]=c; dec[pos*16+ns]=(s<<1)|b; }
      }
    }
    const t=pm; pm=nm; nm=t;
  }
  let st=0;
  const u=new Uint8Array(184);
  for(let pos=183;pos>=0;pos--){ const x=dec[pos*16+st]; u[pos]=x&1; st=x>>1; }
  for(let i=0;i<172;i++) t2[102+i]=u[i];
  const out=new Uint8Array(274);
  const put=(tab,o)=>{ for(let i=0;i<tab.length;i++) for(let f=0;f<2;f++) out[f*137+tab[i]-1]=t2[o+2*i+f]; };
  put(TETRA_C0,0); put(TETRA_C1,102); put(TETRA_C2,214);
  return out;
}

/* ---- пакет: разбивка (в битах от начала пакета) ---- */
const TETRA_SB={b1:94, bbk:252, b2:282}, TETRA_NB={b1:14, bb1:230, tr:244, bb2:266, b2:282};
function tetraNext(t){ if(++t.tn>4){ t.tn=1; if(++t.fn>18){ t.fn=1; if(++t.mn>60) t.mn=1; } } }
// слот с BSCH / BNCH в кадре 18 (как у osmo-tetra)
const tetraBschTn=mn=>4-((mn+1)%4);

/* ---- SDS (CMCE D-SDS-DATA, EN 300 392-2 14.8.x; SDS-TL 29.4; LIP TS 100 392-18-1) ---- */
// конец сообщения без заполнения: последний единичный бит — граница
function tetraStrip(b,from,to){ let i=to-1; while(i>=from && !b[i]) i--; return i>=from ? i : to; }
const TETRA_GSM=[64,163,36,165,232,233,249,236,242,199,10,216,248,13,197,229,916,95,934,915,923,937,928,936,931,920,926,32,198,230,223,201,
  32,33,34,35,164,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  161,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,196,214,209,220,167,
  191,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,228,246,241,252,224];
const TETRA_GSM_ESC={10:12,20:94,40:123,41:125,47:92,60:91,61:126,62:93,64:124,101:0x20ac};
// текст: кодировка 7 бит (0: алфавит GSM 7 бит, биты упакованы по октетам с младшего), 8 бит (1: ISO 8859-1), 16 бит (26: UCS-2 / UTF-16BE)
function tetraText(b,pos,end,coding){
  const av=end-pos;
  if(coding===0){
    let s='', esc=false, n=Math.floor(av/7), last=-1;
    for(let k=0;k<n;k++){
      let v=0;
      for(let j=0;j<7;j++){ const p=k*7+j; v|=(b[pos+(p>>3)*8+7-(p&7)]&1)<<j; }
      last=v;
      if(k===n-1 && v===0 && n%8===0) break;                        // 7 бит заполнения до октета
      if(!esc && v===27){ esc=true; continue; }
      let c=TETRA_GSM[v];
      if(esc){ if(TETRA_GSM_ESC[v]) c=TETRA_GSM_ESC[v]; esc=false; }
      s+=String.fromCodePoint(c);
    }
    return s;
  }
  if(coding===1){ let s=''; for(let i=pos;i+8<=end;i+=8){ const c=tetraBits(b,i,8); s+=String.fromCharCode(c||32); } return s; }
  if(coding===26){ let s=''; for(let i=pos;i+16<=end;i+=16){ const c=tetraBits(b,i,16); s+=String.fromCharCode(c||32); } return s; }
  return null;
}
const TETRA_LIP_ERR=['<2 m','<20 m','<200 m','<2 km','<20 km','≤200 km','>200 km',null];
// короткий отчёт LIP: тип PDU 2, время 2, долгота 25, широта 24, ошибка 3, скорость 7, направление 4, тип доп. данных 1 (+ причина 8)
function tetraLip(b,o,len){
  if(len<8+68 || tetraBits(b,o+8,2)!==0) return null;
  const sg=(v,n)=>v>=Math.pow(2,n-1) ? v-Math.pow(2,n) : v;
  const lon=sg(tetraBits(b,o+12,25),25)*360/Math.pow(2,25), lat=sg(tetraBits(b,o+37,24),24)*180/Math.pow(2,24);
  const k=tetraBits(b,o+64,7);
  const r={lat:+lat.toFixed(6), lon:+lon.toFixed(6), elapsed:tetraBits(b,o+10,2), err:TETRA_LIP_ERR[tetraBits(b,o+61,3)]};
  if(k<127) r.speed=k<=28 ? k : +(16*Math.pow(1.038,k-13)).toFixed(1);
  const d=tetraBits(b,o+71,4); r.heading=d*22.5;
  if(!b[o+75] && len>=84) r.reason=tetraBits(b,o+76,8);
  if(Math.abs(lat)>90 || Math.abs(lon)>180) return null;
  return r;
}
// pos — начало PDU CMCE (тип 5 бит); ответ — поля сообщения или null
function tetraSds(b,pos,end){
  let o=pos+5;
  if(end-o<4) return null;
  const cpti=tetraBits(b,o,2); o+=2;
  let from=null;
  if(cpti===1||cpti===2){ if(end-o<24) return null; from=tetraBits(b,o,24); o+=24; }
  if(cpti===2){ if(end-o<24) return null; o+=24; }
  if(end-o<2) return null;
  const sdti=tetraBits(b,o,2); o+=2;
  let len;
  if(sdti<3) len=[16,32,64][sdti]; else { if(end-o<11) return null; len=tetraBits(b,o,11); o+=11; }
  if(o+len>end) return null;
  const r={from, sdti, len, hex:tetraHex(b,o,Math.min(len,512))};
  if(sdti===0){ r.kind='status'; r.status=tetraBits(b,o,16); return r; }
  if(sdti<3||len<8){ r.kind='data'; return r; }
  const pid=tetraBits(b,o,8); r.pid=pid; r.kind='data';
  const e=o+len;
  let ts=-1, tsOk=false;
  if(pid===2||pid===9) ts=o+8;
  else if(pid===10){ const p=tetraLip(b,o,len); if(p){ r.kind='location'; Object.assign(r,p); } return r; }
  else if(pid>=128 && pid<255 && len>=12){
    const type=tetraBits(b,o+8,4);
    if(type<=2){
      let h=type===0 ? 24 : 32;
      if(len<h) return r;
      r.tl=['TRANSFER','REPORT','ACK'][type]; r.ref=tetraBits(b,o+h-8,8);
      if(type!==2 && b[o+15]){                                      // хранение и пересылка: срок 5, тип адреса 3, адрес
        let req=h+8; const a=tetraBits(b,o+h+5,3);
        if(len<req) return r;
        if(a===0) req+=8; else if(a===1) req+=24; else if(a===2) req+=48;
        else if(a===3){ if(len<h+16) return r; const dg=tetraBits(b,o+h+8,8); req=h+16+((dg+1)&~1)*4; }
        else if(a!==7) return r;
        if(len<req) return r;
        h=req;
      }
      if(type===0 && (pid===130||pid===137)){ ts=o+h; tsOk=true; }
    }
  }
  if(ts>=0 && e-ts>=8){
    const tsFlag=b[ts], coding=tetraBits(b,ts+1,7);
    let p=ts+8; if(tsOk && tsFlag) p+=24;
    r.coding=coding;
    if(p<=e){ const t=tetraText(b,p,e,coding); if(t!=null){ r.kind='text'; r.text=t; } }
  }
  return r;
}

IQK.tetraRx={
  init(n){ n.key=''; n.ui=null; },
  setup(n,s){
    const M=Math.max(1,Math.floor(s.sr/72000));
    n.M=M; n.fs=s.sr/M; n.sps=n.fs/TETRA_BAUD;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,20000/n.fs), tpp:'8'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    n.rrc=fsk4RrcTaps(n.sps,.35);
    n.hr=new Float32Array(n.rrc.length-1); n.hi=new Float32Array(n.rrc.length-1);
    n.xr=new Float32Array(0); n.xi=new Float32Array(0); n.xb=0; n.tNext=1; n.jj=0;
    n.dR=[]; n.dI=[]; n.pR=new Float32Array(TETRA_PH); n.pI=new Float32Array(TETRA_PH);
    n.sR=new Float64Array(TETRA_PH); n.sI=new Float64Array(TETRA_PH);            // скользящая сумма приращений за 32 символа
    n.m1=new Float64Array(TETRA_PH); n.m2=new Float64Array(TETRA_PH); n.s1r=new Float64Array(TETRA_PH); n.s1i=new Float64Array(TETRA_PH);
    for(let p=0;p<TETRA_PH;p++){ n.dR.push(new Float32Array(TETRA_RING)); n.dI.push(new Float32Array(TETRA_RING)); }
    n.cand=[]; n.pass=[]; n.lock=null;
    n.cnt={sync:0, bursts:0, aach:0, crcOk:0, crcBad:0, sysinfo:0, resource:0, tch:0, locks:0};
    n.si=null; n.calls={}; n.recent=[]; n.last=null;
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, voice:null}; }
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    if(!cplx){ n.ui={err:'needs a complex (IQ) stream'}; return {rec:null, voice:null}; }
    const key=s.sr+'|'+cplx;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    const out={recs:[], voice:[]};
    for(const c of src.chunks){
      const yr=firRun(n.rrc,n.hr,c.re), yi=firRun(n.rrc,n.hi,iqChunkIm(c));
      const nr=new Float32Array(n.xr.length+yr.length), ni=new Float32Array(nr.length);
      nr.set(n.xr); ni.set(n.xi); nr.set(yr,n.xr.length); ni.set(yi,n.xi.length);
      n.xr=nr; n.xi=ni;
      this.scan(n,out);
    }
    this.ui(n);
    return {rec:out.recs.length ? out.recs : null, voice:out.voice.length ? out.voice : null};
  },
  ui(n){
    const L=n.lock, c=n.cnt, si=n.si;
    n.ui={fs:n.fs, M:n.M, locked:!!L, cell:L ? L.cell : null, tn:L ? L.tn : 0, fn:L ? L.fn : 0, mn:L ? L.mn : 0,
      ferr:L ? L.w*TETRA_BAUD/(2*Math.PI) : null, inv:L ? L.inv : null, cnt:Object.assign({},c), si:si ? {dlHz:si.dlHz, ulHz:si.ulHz, la:si.la, services:si.services, encrypted:si.encrypted} : null,
      calls:Object.keys(n.calls).map(t=>({tn:+t, marker:n.calls[t].marker})), last:n.last, recent:n.recent.slice(-8)};
  },
  scan(n,out){
    const xr=n.xr, xi=n.xi, N=xr.length, step=n.sps/TETRA_PH;
    let tj=n.tNext-n.xb;
    if(tj<1) tj=1;
    while(tj<N-2){
      const i0=Math.floor(tj), f=tj-i0;
      const a0=xr[i0-1], a1=xr[i0], a2=xr[i0+1], a3=xr[i0+2], b0=xi[i0-1], b1=xi[i0], b2=xi[i0+1], b3=xi[i0+2];
      const re=((((-.5*a0+1.5*a1-1.5*a2+.5*a3)*f+(a0-2.5*a1+2*a2-.5*a3))*f)+(-.5*a0+.5*a2))*f+a1;
      const im=((((-.5*b0+1.5*b1-1.5*b2+.5*b3)*f+(b0-2.5*b1+2*b2-.5*b3))*f)+(-.5*b0+.5*b2))*f+b1;
      this.step(n,re,im,out);
      tj+=step;
    }
    n.tNext=n.xb+tj;
    const keep=Math.max(0,Math.floor(tj)-3);
    if(keep>0){ n.xr=xr.slice(keep); n.xi=xi.slice(keep); n.xb+=keep; }
  },
  step(n,sr,si,out){
    const jj=n.jj++, p=jj&7, k=Math.floor(jj/8), R=TETRA_RM;
    const pr=n.pR[p], pi=n.pI[p];
    let dr=sr*pr+si*pi, di=si*pr-sr*pi;
    n.pR[p]=sr; n.pI[p]=si;
    const m=Math.hypot(dr,di);
    if(m>1e-12){ dr/=m; di/=m; } else { dr=0; di=0; }
    const rr=n.dR[p], ri=n.dI[p];
    n.sR[p]+=dr-rr[(k-32)&R]; n.sI[p]+=di-ri[(k-32)&R];     // окно: k−31…k
    rr[k&R]=dr; ri[k&R]=di;
    const L=n.lock;
    if(L){ if(jj>=L.evalJ) this.slot(n,out); }
    else if(k>=48) this.hunt(n,p,k,jj,out);
  },
  /* ---- поиск синхропакета: 32 символа с постоянным приращением +π/4 (частотная поправка), затем y ---- */
  hunt(n,p,k,jj,out){
    const sr=n.sR[p], si=n.sI[p], m=Math.hypot(sr,si);
    const e=k-1, m1=n.m1[p], m2=n.m2[p];
    if(m1>=22.4 && m1>=m2 && m1>m){                         // пик на предыдущем символе
      n.cand.push({p, e, sr:n.s1r[p], si:n.s1i[p], due:e+83});
    }
    n.m2[p]=m1; n.m1[p]=m; n.s1r[p]=sr; n.s1i[p]=si;
    if(n.cand.length) for(let i=n.cand.length-1;i>=0;i--){
      const c=n.cand[i];
      if(c.p!==p || k<c.due) continue;
      n.cand.splice(i,1);
      this.test(n,c);
    }
    if(n.pass.length){
      const a=n.pass[0];
      if(jj>=a.due){
        let best=a;
        for(const q of n.pass) if(Math.abs(q.jc-a.jc)<=32 && q.score>best.score) best=q;
        n.pass=n.pass.filter(q=>Math.abs(q.jc-a.jc)>32);
        this.acquire(n,best,out);
      }
    }
  },
  test(n,c){
    const arg=Math.atan2(c.si,c.sr), R=TETRA_RM, rr=n.dR[c.p], ri=n.dI[c.p], tp=TETRA_TPL.y;
    let best=null;
    for(let inv=0;inv<2;inv++){
      let w=(inv ? -arg : arg)-Math.PI/4;
      w=Math.atan2(Math.sin(w),Math.cos(w));
      const z=this.corr(rr,ri,c.e+65,tp,w,inv);
      if(z.c>0 && (!best || z.c>best.c)) best={c:z.c, arg:z.arg, w, inv};
    }
    if(!best || best.c<.7) return;
    const w=best.w+best.arg*19/51;
    const jc=(c.e-42)*8+c.p;
    n.pass.push({jc, w, inv:best.inv, score:best.c+Math.hypot(c.sr,c.si)/32, due:Math.max(jc+8*256, n.jj+24)});
  },
  // корреляция приращений с шаблоном: z = Σ d[k+i]·e^{−jw}·conj(tpl[i]); c — |z|/len
  corr(rr,ri,k,tp,w,inv){
    const R=TETRA_RM, cw=Math.cos(w), sw=Math.sin(w);
    let zr=0, zi=0;
    for(let i=0;i<tp.len;i++){
      const dr0=rr[(k+i)&R], di0=inv ? -ri[(k+i)&R] : ri[(k+i)&R];
      const xr=dr0*cw+di0*sw, xi=di0*cw-dr0*sw;
      zr+=xr*tp.re[i]+xi*tp.im[i]; zi+=xi*tp.re[i]-xr*tp.im[i];
    }
    return {c:Math.hypot(zr,zi)/tp.len, arg:Math.atan2(zi,zr)};
  },
  // снять скремблер с мягких битов (+ → 0)
  descr(b,scr){ const q=tetraScrSeq(scr,b.length), o=new Float32Array(b.length); for(let i=0;i<b.length;i++) o[i]=q[i] ? -b[i] : b[i]; return o; },
  // мягкие биты пакета (510): + → 0; b1 ≈ Im, b2 ≈ Re приращения после снятия набега фазы w
  soft(n,jc,w,inv){
    const p=jc&7, k0=Math.floor(jc/8), R=TETRA_RM, rr=n.dR[p], ri=n.dI[p], cw=Math.cos(w), sw=Math.sin(w), o=new Float32Array(2*TETRA_SYM);
    for(let i=0;i<TETRA_SYM;i++){
      const dr=rr[(k0+i)&R], di=inv ? -ri[(k0+i)&R] : ri[(k0+i)&R];
      o[2*i]=di*cw-dr*sw; o[2*i+1]=dr*cw+di*sw;
    }
    return o;
  },
  acquire(n,c,out){
    const soft=this.soft(n,c.jc,c.w,c.inv), sb=tetraBlkDec(soft.subarray(TETRA_SB.b1,TETRA_SB.b1+120),TETRA_BLK.sb1,TETRA_SCR0);
    if(!sb.ok){ n.cnt.crcBad++; return; }
    const sy=tetraSync(sb.bits);
    const L=n.lock={jS:c.jc, w:c.w, inv:c.inv, tn:sy.tn, fn:sy.fn, mn:sy.mn, miss:0, quiet:0, evalJ:0, sc:0, fr:{},
      cell:{mcc:sy.mcc, mnc:sy.mnc, cc:sy.cc, scr:tetraScrInit(sy.mcc,sy.mnc,sy.cc)}, since:Date.now()};
    n.cnt.locks++; n.si=null;
    this.burst(n,L,'y',soft,out,true);
    L.jS=c.jc+8*TETRA_SYM; tetraNext(L); L.evalJ=L.jS+2060;
  },
  /* ---- сетка слотов: пакет в пределах ±3 символов от ожидаемого места ---- */
  slot(n,out){
    const L=n.lock, jS=L.jS, R=TETRA_RM;
    let best=null;
    for(let jc=jS-24;jc<=jS+24;jc++){
      const p=jc&7, k0=Math.floor(jc/8), rr=n.dR[p], ri=n.dI[p];
      for(const t of ['y','n','p']){
        const z=this.corr(rr,ri,k0+TETRA_POS[t],TETRA_TPL[t],L.w,L.inv);
        if(!best || z.c>best.c) best={c:z.c, arg:z.arg, jc, t};
      }
    }
    if(best.c>=.75){
      L.miss=0;
      L.w+=.5*best.arg; L.w=Math.atan2(Math.sin(L.w),Math.cos(L.w));
      L.jS=best.jc;
      this.burst(n,L,best.t,this.soft(n,best.jc,L.w,L.inv),out,false);
    } else if(++L.miss>=12){ this.drop(n,'lost'); return; }
    L.jS+=8*TETRA_SYM; tetraNext(L); L.evalJ=L.jS+2060; L.sc++;
    if(++L.quiet>=72*2){ this.drop(n,'no valid blocks'); }
  },
  drop(n,why){
    n.lock=null; n.cand.length=0; n.pass.length=0; n.calls={}; n.last=why;
    n.sR.fill(0); n.sI.fill(0); n.m1.fill(0); n.m2.fill(0);
    for(let p=0;p<TETRA_PH;p++){ n.dR[p].fill(0); n.dI[p].fill(0); }
  },
  /* ---- содержимое пакета ---- */
  emit(n,L,out,kind,text,extra){
    const r=Object.assign({t:Date.now(), src:'TETRA', kind, text, tn:L.tn, fn:L.fn, mn:L.mn}, extra);
    out.recs.push(r);
    n.recent.push(text); if(n.recent.length>24) n.recent.shift();
    n.last=text;
    return r;
  },
  burst(n,L,type,soft,out,first){
    const cell=L.cell, C=n.cnt;
    C.bursts++;
    let bbk, blocks=[], full=null;
    if(type==='y'){
      const sb=tetraBlkDec(soft.subarray(TETRA_SB.b1,TETRA_SB.b1+120),TETRA_BLK.sb1,TETRA_SCR0);
      if(sb.ok){
        const sy=tetraSync(sb.bits);
        C.sync++; C.crcOk++; L.quiet=0;
        if(!first && (sy.mcc!==cell.mcc || sy.mnc!==cell.mnc || sy.cc!==cell.cc)){ cell.mcc=sy.mcc; cell.mnc=sy.mnc; cell.cc=sy.cc; cell.scr=tetraScrInit(sy.mcc,sy.mnc,sy.cc); n.si=null; }
        if(sy.tn!==L.tn || sy.fn!==L.fn || sy.mn!==L.mn){ L.tn=sy.tn; L.fn=sy.fn; L.mn=sy.mn; }
        this.emit(n,L,out,'sync','SYNC · MCC '+sy.mcc+' MNC '+sy.mnc+' · colour '+sy.cc+' · TN '+sy.tn+' FN '+sy.fn+' MN '+sy.mn+
          (sy.sys===0||sy.sys===1 ? '' : ' · system code '+sy.sys)+(sy.late ? ' · late entry' : ''),
          {mcc:sy.mcc, mnc:sy.mnc, cc:sy.cc, sharing:sy.sharing, sys:sy.sys, late:!!sy.late, dtx:!!sy.dtx, f18ext:!!sy.f18ext});
      } else C.crcBad++;
      bbk=soft.subarray(TETRA_SB.bbk,TETRA_SB.bbk+30);
      blocks.push({name:'SB2', s:soft.subarray(TETRA_SB.b2,TETRA_SB.b2+216)});
    } else {
      bbk=new Float32Array(30); bbk.set(soft.subarray(TETRA_NB.bb1,TETRA_NB.bb1+14)); bbk.set(soft.subarray(TETRA_NB.bb2,TETRA_NB.bb2+16),14);
      const b1=soft.subarray(TETRA_NB.b1,TETRA_NB.b1+216), b2=soft.subarray(TETRA_NB.b2,TETRA_NB.b2+216);
      if(type==='n'){ full=new Float32Array(432); full.set(b1); full.set(b2,216); }
      else if(type==='p'){ blocks.push({name:'B1',s:b1},{name:'B2',s:b2}); }
    }
    // AACH
    const sc=tetraScrSeq(cell.scr,30);
    let w=0;
    for(let i=0;i<30;i++) w=(w*2+((bbk[i]<0 ? 1 : 0)^sc[i]))>>>0;
    const rm=tetraRmDec(w), f18=L.fn===18;
    let aach=null;
    if(rm.dist<=3){ aach=tetraAach(rm.info,f18); C.aach++; }
    const traffic=aach ? aach.traffic : 0;
    if(!f18 && aach) this.track(n,L,out,traffic);
    // блоки
    if(type==='n'){
      if(traffic){
        C.tch++;
        const fr=tetraSpeech(this.descr(full,cell.scr));
        out.voice.push({t:Date.now(), src:'TETRA', kind:'voice', slot:L.tn, usage:traffic, acelp:tetraHex(fr,0,274), encrypted:!!(n.si && n.si.encrypted)});
        return;
      }
      const r=tetraBlkDec(full,TETRA_BLK.full,cell.scr);
      if(r.ok){ C.crcOk++; L.quiet=0; this.mac(n,L,out,r.bits,'SCH/F'); } else C.crcBad++;
    } else {
      for(const b of blocks){
        const r=tetraBlkDec(b.s,TETRA_BLK.hd,cell.scr);
        if(r.ok){ C.crcOk++; L.quiet=0; this.mac(n,L,out,r.bits,traffic && b.name!=='SB2' ? 'STCH' : b.name==='SB2' ? 'BNCH/SCH/HD' : 'SCH/HD'); }
        else if(!traffic || b.name==='SB2') C.crcBad++;
      }
    }
  },
  track(n,L,out,marker){
    const c=n.calls, tn=L.tn;
    let e=c[tn];
    if(marker){
      if(!e || e.marker!==marker){
        if(e) this.callEnd(n,L,out,tn);
        e=c[tn]={marker, t0:Date.now(), bursts:0, quiet:0};
        this.emit(n,L,out,'call','CALL start · TN '+tn+' · usage marker '+marker,{slot:tn, marker});
      }
      e.bursts++; e.quiet=0;
    } else if(e && ++e.quiet>=3) this.callEnd(n,L,out,tn);
  },
  callEnd(n,L,out,tn){
    const e=n.calls[tn]; delete n.calls[tn];
    const sec=(Date.now()-e.t0)/1000;
    this.emit(n,L,out,'end','CALL end · TN '+tn+' · usage marker '+e.marker+' · '+sec.toFixed(1)+' s · '+e.bursts+' traffic bursts',{slot:tn, marker:e.marker, seconds:+sec.toFixed(1), bursts:e.bursts});
  },
  // сообщение верхнего уровня: LLC → MLE → CMCE; D-SDS-DATA → запись message
  l3(n,L,out,b,sdu,to,chan){
    if(!sdu || sdu.disc!=='CMCE' || sdu.pdu!=='D-SDS DATA') return;
    const m=tetraSds(b,sdu.bits[0],sdu.bits[1]);
    if(!m) return;
    n.cnt.sds=(n.cnt.sds||0)+1;
    const f={chan, from:m.from!=null ? String(m.from) : undefined, to, pid:m.pid, sdti:m.sdti, ref:m.ref, tl:m.tl, hex:m.hex};
    let txt;
    if(m.kind==='text'){ f.message=m.text; f.service='SDS text'; txt='SDS '+(m.from!=null ? m.from : '?')+' → '+(to||'?')+' "'+m.text+'"'; }
    else if(m.kind==='location'){ Object.assign(f,{lat:m.lat, lon:m.lon, speed:m.speed, heading:m.heading, accuracy:m.err, reason:m.reason, service:'SDS LIP'});
      txt='SDS LIP '+(m.from!=null ? m.from : '?')+' · '+m.lat+', '+m.lon+(m.speed!=null ? ' · '+m.speed+' km/h' : ''); }
    else if(m.kind==='status'){ f.service='SDS status'; f.status=m.status; txt='SDS status '+(m.from!=null ? m.from : '?')+' → '+(to||'?')+' · 0x'+m.status.toString(16).toUpperCase().padStart(4,'0'); }
    else { f.service='SDS data'+(m.pid!=null ? ' PID '+m.pid : ''); txt='SDS data '+(m.from!=null ? m.from : '?')+' → '+(to||'?')+' · '+m.len+' bits'+(m.pid!=null ? ' · PID '+m.pid : ''); }
    if(m.from!=null && f.lat!=null){ f.id='tetra:'+m.from; f.label=String(m.from); }
    this.emit(n,L,out,'message',txt,f);
  },
  // слот TN: накопление фрагментов (MAC-RESOURCE «начало», MAC-FRAG, MAC-END)
  frag(n,L,out,part,fin,to,chan){
    const fr=L.fr, tn=L.tn;
    let f=fr[tn];
    if(part==='start'){ f={bits:[...fin.bits], to, sc:L.sc}; fr[tn]=f; return; }
    if(!f) return;
    if(L.sc-f.sc>144){ delete fr[tn]; return; }                    // два мультикадра без продолжения
    f.sc=L.sc;
    for(const v of fin.bits) f.bits.push(v);
    if(f.bits.length>4096){ delete fr[tn]; return; }
    if(part==='end'){
      delete fr[tn];
      const a=Uint8Array.from(f.bits), sdu=tetraTmSdu(a,0,a.length);
      this.l3(n,L,out,a,sdu,f.to,chan);
    }
  },
  mac(n,L,out,b,chan){
    const N=b.length, si=n.si;
    let off=0;
    while(off+16<=N){
      const t=tetraBits(b,off,2), v=b.subarray(off);
      if(t===2){
        const bt=tetraBits(b,off+2,2);
        if(bt===0 && N-off>=124){
          const s=tetraSysinfo(v);
          n.si=s; n.cnt.sysinfo++;
          this.emit(n,L,out,'sysinfo','SYSINFO · DL '+(s.dlHz/1e6).toFixed(4)+' MHz'+(s.ulHz ? ' · UL '+(s.ulHz/1e6).toFixed(4) : '')+' · LA '+s.la+
            (s.encrypted ? ' · air encryption' : '')+' · '+s.services.join(', '),
            {dlHz:s.dlHz, ulHz:s.ulHz, la:s.la, band:s.band, carrier:s.carrier, services:s.services, encrypted:s.encrypted, chan});
        } else if(bt===1) this.emit(n,L,out,'access-define','ACCESS-DEFINE',{chan});
        return;
      }
      if(t===0){
        const r=tetraResource(v,N-off,si ? si.band : null,si ? si.off : 0);
        if(r.end) return;
        let end=N, rest=true;
        if(r.octets>0 && !r.frag && !r.stolen2){ end=off+r.octets*8; rest=false; if(end>N) return; }
        let sdu=null, tail=end;
        if(r.fill && r.tm>0) tail=tetraStrip(b,off+r.tm,end);
        if(r.tm>0 && tail-off>r.tm) sdu=tetraTmSdu(b,off+r.tm,tail);
        n.cnt.resource++;
        const to=r.ssi!=null ? String(r.ssi) : undefined;
        let txt='RESOURCE · '+r.addr+(r.enc ? ' · ENCRYPTED ('+r.enc+')' : '');
        if(r.alloc) txt+=' · alloc TN '+r.alloc.ts+' '+(TETRA_ULDL[r.alloc.uldl]||'')+' ch '+r.alloc.carrier+(r.alloc.dlHz ? ' ('+(r.alloc.dlHz/1e6).toFixed(4)+' MHz)' : '')+' ['+(TETRA_ALLOC[r.alloc.type]||'')+']';
        if(r.frag) txt+=' · fragment start';
        if(sdu) txt+=' · '+sdu.llc+(sdu.disc ? ' · '+sdu.disc+(sdu.pdu ? ' '+sdu.pdu : '') : '');
        this.emit(n,L,out,'resource',txt,{chan, addrType:TETRA_ADDR[r.addrType], to, event:r.event, usage:r.usage, enc:r.enc,
          encrypted:r.enc>0, alloc:r.alloc, llc:sdu&&sdu.llc, disc:sdu&&sdu.disc, pdu:sdu&&sdu.pdu, hex:sdu&&sdu.bits ? tetraHex(b,sdu.bits[0],Math.min(256,sdu.bits[1]-sdu.bits[0])) : undefined, frag:r.frag});
        if(r.frag && r.tm>0) this.frag(n,L,out,'start',{bits:b.subarray(off+r.tm,tail)},to,chan);
        else if(!r.frag && sdu) this.l3(n,L,out,b,sdu,to,chan);
        if(rest) return;
        off=end; continue;
      }
      if(t===1){
        n.cnt.frag=(n.cnt.frag||0)+1;
        if(b[off+2]===0){                                           // MAC-FRAG: тип 2, FRAG 1, заполнение 1, данные до конца блока
          const e=b[off+3] ? tetraStrip(b,off+4,N) : N;
          this.frag(n,L,out,'frag',{bits:b.subarray(off+4,e)},null,chan);
          return;
        }
        const li=tetraBits(b,off+5,6);                              // MAC-END: тип 2, END 1, заполнение 1, позиция гранта 1, длина 6
        if(li<1 || li>0x3a || off+li*8>N) return;
        let c=off+11;
        if(b[c++]) c+=8;
        if(b[c++]){ const a=tetraChanAlloc(b,c,si ? si.band : null,si ? si.off : 0); if(a.len<0) return; c+=a.len; }
        const e=b[off+3] ? tetraStrip(b,c,off+li*8) : off+li*8;
        this.frag(n,L,out,'end',{bits:b.subarray(c,e)},null,chan);
        off+=li*8; continue;
      }
      return;
    }
  }};

/* ---- генератор: сота на главной несущей ---- */
// MCC 262, MNC 1011, цвет 5, 391.0 МГц; слот 1 каждого кадра — управляющий, слот 2 временами занят вызовом; BSCH в кадре 18
const TETRA_CELL={mcc:262, mnc:1011, cc:5, band:3, carrier:3640, off:0, duplex:3, la:4242};
function tetraGenSdu(g,k){
  const rnd=(l)=>{ const a=new Uint8Array(l); for(let i=0;i<l;i++){ g.x^=g.x<<13; g.x^=g.x>>>17; g.x^=g.x<<5; a[i]=(g.x>>>7)&1; } return a; };
  const hdr=[[2,1,5],[0,2,7],[2,2,15],[1,1,10],[2,5,2],[0,2,0],[2,2,5]][k%7];       // LLC, протокол (1 MM, 2 CMCE, 5 MLE), PDU
  const b=[];
  const put=(l,v)=>{ for(let i=l-1;i>=0;i--) b.push((v>>i)&1); };
  put(4,hdr[0]); if(hdr[0]===0){ put(1,k&1); put(1,(k>>1)&1); } else if(hdr[0]===1) put(1,k&1);
  put(3,hdr[1]); put(hdr[1]===2 ? 5 : hdr[1]===1 ? 4 : 3,hdr[2]);
  const pay=rnd(24+(k%5)*8);
  return Uint8Array.from([...b,...pay]);
}

/* ---- генератор SDS: тексты (GSM 7 бит, Latin-1, UCS-2), отчёты LIP, статусы, длинное сообщение кусками MAC ---- */
function tetraGsmBits(str){
  const idx=[...str].map(c=>{ const v=TETRA_GSM.lastIndexOf(c.codePointAt(0)); return v<0 ? TETRA_GSM.lastIndexOf(63) : v; });
  const b=new Uint8Array(Math.ceil(idx.length*7/8)*8);
  idx.forEach((v,k)=>{ for(let j=0;j<7;j++){ const p=k*7+j; b[(p>>3)*8+7-(p&7)]=(v>>j)&1; } });
  return b;
}
function tetraGenSds(g,k){
  const out=[], put=(l,v)=>{ for(let i=l-1;i>=0;i--) out.push(Math.floor(v/Math.pow(2,i))&1); };
  const from=7001000+k%3, to=100000+(k*37)%9000, kind=k%6;
  let data=[], pu=(l,v)=>{ for(let i=l-1;i>=0;i--) data.push(Math.floor(v/Math.pow(2,i))&1); };
  const text=(str,coding,pid)=>{
    if(pid===130){ pu(8,130); pu(4,0); pu(2,0); pu(1,0); pu(1,0); pu(8,k&255); } else pu(8,pid);
    pu(1,0); pu(7,coding);
    if(coding===0) data.push(...tetraGsmBits(str));
    else for(const c of str) pu(coding===1 ? 8 : 16,coding===1 ? c.charCodeAt(0)&255 : c.charCodeAt(0));
  };
  let sdti=3;
  if(kind===0) text('Hello from the TETRA test cell, message '+k,0,130);
  else if(kind===1){
    const a=(k/3)*0.01, lat=55.7558+0.02*Math.sin(a+(k%3)*2), lon=37.6173+0.03*Math.cos(a+(k%3)*2);
    const enc=(v,bits,scale)=>{ let x=Math.round(v/scale); if(x<0) x+=Math.pow(2,bits); return x; };
    pu(8,10); pu(2,0); pu(2,0); pu(25,enc(lon,25,360/Math.pow(2,25))); pu(24,enc(lat,24,180/Math.pow(2,24))); pu(3,1); pu(7,20+(k%7)); pu(4,k%16); pu(1,0); pu(8,1);
  }
  else if(kind===2) text('Simple text, no SDS-TL: caf\u00e9 '+k,1,2);
  else if(kind===3){ sdti=0; pu(16,0x8000+k%64); }
  else if(kind===4) text('Длинное сообщение SDS ('+k+'): '+'проверка сборки фрагментов MAC, UCS-2. '.repeat(2),26,130);
  else return null;
  put(4,2); put(3,2); put(5,15); put(2,1); put(24,from); put(2,sdti);
  if(sdti===3) put(11,data.length);
  out.push(...data); out.push(0);
  return {ssi:to, sdu:Uint8Array.from(out)};
}
// блок из S бит: сообщение целиком, начало фрагментации, продолжение или конец
function tetraGenBlk(g,S){
  const b=new Uint8Array(S), put=(c,l,v)=>{ tetraPutBits(b,c,l,v); return c+l; };
  const nul=c=>{ if(c+17<=S){ b[c+2]=1; tetraPutBits(b,c+7,6,2); b[c+16]=1; } };
  if(g.carry){
    const r=g.carry;
    if(r.length>S-4){ let c=put(0,2,1); c=put(c,1,0); c=put(c,1,0); b.set(r.subarray(0,S-4),c); g.carry=r.subarray(S-4); return b; }
    let c=put(0,2,1); c=put(c,1,1); const fillAt=c; c=put(c,1,0); c=put(c,1,0); const liAt=c; c=put(c,6,0); c=put(c,1,0); c=put(c,1,0);
    b.set(r,c); c+=r.length;
    let fill=0; if(c&7){ fill=1; b[c++]=1; while(c&7) b[c++]=0; }
    tetraPutBits(b,fillAt,1,fill); tetraPutBits(b,liAt,6,c>>3);
    nul(c); g.carry=null; return b;
  }
  const m=tetraGenSds(g,g.k++);
  if(!m){ const t1=tetraResourceBits(S,100000+(g.k*37)%9000,tetraGenSdu(g,g.k),null); return t1; }
  if(43+m.sdu.length<=S) return tetraResourceBits(S,m.ssi,m.sdu,null);
  let c=put(0,2,0); c=put(c,1,0); c=put(c,1,0); c=put(c,2,0); c=put(c,1,0); c=put(c,6,0x3f); c=put(c,3,1); c=put(c,24,m.ssi); c=put(c,1,0); c=put(c,1,0); c=put(c,1,0);
  b.set(m.sdu.subarray(0,S-c),c); g.carry=m.sdu.subarray(S-c);
  return b;
}
function tetraGenSlot(g){
  const c=TETRA_CELL, sc=g.sc++, tn=sc%4+1, fn=Math.floor(sc/4)%18+1, mn=Math.floor(sc/72)%60+1;
  const scr=tetraScrInit(c.mcc,c.mnc,c.cc), bits=new Uint8Array(2*TETRA_SYM);
  let off=0;
  const put=a=>{ bits.set(a,off); off+=a.length; };
  const q=TETRA_SEQ.q, rm=(info)=>{ const w=tetraRmEnc(info), a=new Uint8Array(30); for(let i=0;i<30;i++) a[i]=(w>>>(29-i))&1; return a; };
  const aach=(hdr,f1,f2)=>{ const a=rm((hdr<<12)|(f1<<6)|f2), s=tetraScrSeq(scr,30); for(let i=0;i<30;i++) a[i]^=s[i]; return a; };
  const hd=sdu=>{ const t1=tetraResourceBits(124,100000+g.k*37%9000,sdu); return tetraBlkEnc(t1,TETRA_BLK.hd,scr); };
  const nullHd=()=>{ const t1=new Uint8Array(124); t1[2]=1; tetraPutBits(t1,7,6,2); t1[16]=1; return tetraBlkEnc(t1,TETRA_BLK.hd,scr); };
  const callOn=tn===2 && fn>=4 && fn<=17 && mn%4!==0, callSet=tn===2 && fn===3 && mn%4!==0;
  const bschTn=tetraBschTn(mn);
  if(fn===18 && tn===bschTn){
    const sy=tetraSyncBits({cc:c.cc, tn, fn, mn, mcc:c.mcc, mnc:c.mnc, svc:1});
    const si=tetraSysinfoBits({carrier:c.carrier, band:c.band, off:c.off, duplex:c.duplex, access:2, rxmin:3, hyper:Math.floor(sc/4320)%65536, la:c.la, serv:(1<<7)|(1<<6)|(1<<5)|(1<<2)});
    put(q.slice(10)); put([0,0]); put(Array(8).fill(1)); put(Array(64).fill(0)); put(Array(8).fill(1));
    put(tetraBlkEnc(sy,TETRA_BLK.sb1,TETRA_SCR0)); put(TETRA_SEQ.y); put(aach(0,0x03,0x03)); put(tetraBlkEnc(si,TETRA_BLK.hd,scr)); put([0,0]); put(q.slice(0,10));
    return bits;
  }
  let bb, b1, b2, tr=TETRA_SEQ.p, full=null;
  if(fn===18) bb=aach(0,0x03,0x03);
  else if(callOn) bb=aach(1,5,0x03);
  else if(callSet) bb=aach(1,5,0x03);
  else if(tn===1) bb=aach(0,0x03,0x03);
  else bb=aach(1,0,0x03);
  if(callOn){ tr=TETRA_SEQ.n; full=new Uint8Array(432); for(let i=0;i<432;i++){ g.x^=g.x<<13; g.x^=g.x>>>17; g.x^=g.x<<5; full[i]=(g.x>>>9)&1; } }
  else if(tn===1 && fn%2===0 && fn!==18){
    tr=TETRA_SEQ.n;
    full=tetraBlkEnc(tetraGenBlk(g,268),TETRA_BLK.full,scr);
  }
  if(full){ b1=full.subarray(0,216); b2=full.subarray(216); }
  else if(callSet){ g.k++; b1=hd(tetraGenSdu(g,7)); b2=nullHd(); }
  else if(tn===1 && fn!==18){ b1=tetraBlkEnc(tetraGenBlk(g,124),TETRA_BLK.hd,scr); b2=nullHd(); }
  else { b1=nullHd(); b2=nullHd(); }
  put(q.slice(10)); put([0,0]); put(b1); put(bb.subarray(0,14)); put(tr); put(bb.subarray(14)); put(b2); put([0,0]); put(q.slice(0,10));
  return bits;
}
// символы (индексы фазы в π/4) → отсчёты с RRC 0.35
function tetraGenerate(n,sr,N){
  let g=n.ttg;
  if(!g || g.sr!==sr){
    const sps=sr/TETRA_BAUD, rx=fsk4RrcTaps(sps,.35), hl=(rx.length-1)/2;
    let cal=0; for(let j=0;j<rx.length;j++) cal+=rx[j]*fsk4Rrc((j-hl)/sps,.35);
    const tab=new Float32Array(769); for(let i=0;i<769;i++) tab[i]=fsk4Rrc((i-384)/64,.35)/cal;
    g={sr, t:0, tab, sc:0, k:0, x:0x2545F491, sym:[], base:0, ph:0};
    n.ttg=g;
  }
  const re=new Float32Array(N), im=new Float32Array(N), tab=g.tab;
  const ci=new Float32Array(8), si=new Float32Array(8);
  for(let i=0;i<8;i++){ ci[i]=Math.cos(i*Math.PI/4); si[i]=Math.sin(i*Math.PI/4); }
  for(let i=0;i<N;i++,g.t++){
    const tau=g.t*TETRA_BAUD/sr, kc=Math.floor(tau);
    while(g.base+g.sym.length<=kc+6){
      const bits=tetraGenSlot(g);
      for(let j=0;j<TETRA_SYM;j++){
        g.ph=(g.ph+TETRA_INC[''+bits[2*j]+bits[2*j+1]]+8)&7;
        g.sym.push(g.ph);
      }
    }
    let a=0, b=0;
    for(let k=kc-5;k<=kc+6;k++){
      const idx=k-g.base; if(idx<0) continue;
      const v=tab[Math.round((tau-k+6)*64)], s=g.sym[idx];
      a+=v*ci[s]; b+=v*si[s];
    }
    re[i]=a; im[i]=b;
    if(kc-g.base>4096){ g.sym.splice(0,2048); g.base+=2048; }
  }
  return [re,im];
}
