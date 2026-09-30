"use strict";
/* ============================ P25 Phase 1 (TIA-102.BAAA, C4FM 4800 Бод) ============================
   Плагин общего 4FSK-движка (fsk4-kernels.js). Кадр: синхро 24 дибита + NID 32 (NAC 12 бит, DUID 4, BCH(63,16) + бит чётности),
   статус-дибит после каждых 35 дибитов данных. HDU: Golay(18,6,8) + RS(36,20,17); LDU1/2: 9 кадров IMBE, LC (RS(24,12,13)) или
   ESS (RS(24,16,9)) в словах Хэмминга (10,6,3), LSD; TSDU: 1–3 блока TSBK (трелис ½ + CRC-16); PDU: только заголовок.
   Голос IMBE не декодируется — отдаются сырые 144 бита кадра. Кодеры нужны генератору и тестам (сверка с MMDVMHost).
   Помощники (dmrNum, dmrPop, dmrHam*, dmrCrc16, DMR_GOLAY_B…) берутся из dmr-kernels.js. */

const P25_BAUD=4800, P25_SYNC=fsk4Sync(fsk4Bits('5575F5FF77FF'));
const P25_LEN={0:396, 5:864, 10:864, 3:72, 15:216};                 // длины кадров в дибитах со статусами
const P25_DUIDS=[0,3,5,7,10,12,15];
const P25_DUID_NAME={0:'HDU', 3:'TDU', 5:'LDU1', 7:'TSDU', 10:'LDU2', 12:'PDU', 15:'TDULC'};
const P25_ALGO={0x80:'clear', 0x81:'DES-OFB', 0x83:'3DES', 0x84:'AES-256', 0xAA:'ADP RC4', 0x9F:'DES-XL', 0xA0:'DVI-XL'};
const P25_AFTER_NID=33, P25_MISS=3;

/* ---- индексы: m-й дибит данных ↔ индекс в кадре (статус — каждый 36-й, номер 35 mod 36) ---- */
function p25Idx(m){ return m+Math.floor(m/35); }
function p25Data(F,m0,n){ const r=new Uint8Array(n); for(let i=0;i<n;i++) r[i]=F[p25Idx(m0+i)]; return r; }
// данные → кадр len дибитов со статус-дибитами (idle = 1)
function p25Weave(data,len,st){
  const F=new Uint8Array(len); let m=0;
  for(let i=0;i<len;i++){ if(i%36===35) F[i]=st==null ? 1 : st; else F[i]=m<data.length ? data[m++] : 0; }
  return F;
}
// число дибитов кадра, в котором лежат первые D дибитов данных
const p25Span=D=>p25Idx(D-1)+1;

/* ---- GF(64), полином x⁶+x+1, RS с корнями α¹…α^(n−k) ---- */
const P25_GF=(()=>{ const e=new Uint8Array(126), l=new Uint8Array(64); let x=1; for(let i=0;i<63;i++){ e[i]=x; l[x]=i; x<<=1; if(x&64) x^=0x43; } for(let i=63;i<126;i++) e[i]=e[i-63]; return {e,l}; })();
function p25Mul(a,b){ return a&&b ? P25_GF.e[P25_GF.l[a]+P25_GF.l[b]] : 0; }
function p25Div(a,b){ return a ? P25_GF.e[P25_GF.l[a]+63-P25_GF.l[b]] : 0; }
const P25_RSG={};
function p25RsGen(np){
  if(P25_RSG[np]) return P25_RSG[np];
  let g=[1];
  for(let j=1;j<=np;j++){ const r=P25_GF.e[j], h=new Array(g.length+1).fill(0); for(let i=0;i<g.length;i++){ h[i]^=g[i]; h[i+1]^=p25Mul(g[i],r); } g=h; }
  return P25_RSG[np]=g;                                        // g[0] — старшая степень
}
// данные (гексабиты) → слово n гексабит: данные, затем проверочные
function p25RsEnc(d,n){
  const k=d.length, np=n-k, g=p25RsGen(np), par=new Array(np).fill(0);
  for(let i=0;i<k;i++){
    const fb=d[i]^par[0];
    for(let j=0;j<np-1;j++) par[j]=par[j+1]^p25Mul(fb,g[j+1]);
    par[np-1]=p25Mul(fb,g[np]);
  }
  return Uint8Array.from([...d,...par]);
}
// исправление на месте (слово s, k информационных); число ошибок или −1
function p25RsDec(s,k){
  const n=s.length, np=n-k, t=np>>1, S=new Array(np).fill(0);
  let any=0;
  for(let j=1;j<=np;j++){ let a=0; for(let i=0;i<n;i++) if(s[i]) a^=P25_GF.e[(P25_GF.l[s[i]]+(n-1-i)*j)%63]; S[j-1]=a; any|=a; }
  if(!any) return 0;
  let C=[1], B=[1], L=0, m=1, b=1;
  for(let i=0;i<np;i++){
    let d=S[i]; for(let j=1;j<=L;j++) if(C[j] && S[i-j]) d^=p25Mul(C[j],S[i-j]);
    if(!d){ m++; continue; }
    const T=C.slice(), c=p25Div(d,b);
    while(C.length<B.length+m) C.push(0);
    for(let j=0;j<B.length;j++) C[j+m]^=p25Mul(c,B[j]);
    if(2*L<=i){ L=i+1-L; B=T; b=d; m=1; } else m++;
  }
  if(L>t) return -1;
  const omega=new Array(np).fill(0);
  for(let i=0;i<np;i++) for(let j=0;j<=i && j<C.length;j++) omega[i]^=p25Mul(C[j],S[i-j]);
  const fix=[];
  for(let i=0;i<n;i++){
    const xi=(63-((n-1-i)%63))%63, ev=(poly,len)=>{ let a=0; for(let j=0;j<len;j++) if(poly[j]) a^=P25_GF.e[(P25_GF.l[poly[j]]+xi*j)%63]; return a; };
    if(ev(C,L+1)) continue;
    let dl=0; for(let j=1;j<=L;j+=2) if(C[j]) dl^=P25_GF.e[(P25_GF.l[C[j]]+xi*(j-1))%63];
    if(!dl) return -1;
    fix.push([i,p25Div(ev(omega,np),dl)]);
  }
  if(fix.length!==L) return -1;
  for(const [i,v] of fix) s[i]^=v;
  return L;
}
const p25Hex=(bits,o)=>bits[o]*32+bits[o+1]*16+bits[o+2]*8+bits[o+3]*4+bits[o+4]*2+bits[o+5];
function p25HexBits(h){ const b=new Uint8Array(h.length*6); for(let i=0;i<h.length;i++) for(let k=0;k<6;k++) b[6*i+k]=(h[i]>>(5-k))&1; return b; }
function p25BitsHex(b){ const h=new Uint8Array(b.length/6|0); for(let i=0;i<h.length;i++) h[i]=p25Hex(b,6*i); return h; }
function p25Bytes(b){ const r=new Uint8Array(b.length>>3); for(let i=0;i<r.length;i++) r[i]=dmrNum(b,8*i,8); return r; }
const p25Cat=(...a)=>{ let n=0; for(const x of a) n+=x.length; const r=new Uint8Array(n); let o=0; for(const x of a){ r.set(x,o); o+=x.length; } return r; };

/* ---- Хэмминг (10,6,3) слов LC / ESS ---- */
const P25_H1063=dmrHamMake(6,[[0,1,2,5],[0,1,3,5],[0,2,3,4],[1,2,3,4]]);

/* ---- Golay (18,6,8) заголовка: 6 бит данных + 12 проверочных ---- */
const P25_G18=(()=>{
  const t=new Uint32Array(64);
  for(let d=0;d<64;d++){ let c=0; for(let i=0;i<6;i++) if((d>>i)&1) c^=DMR_GOLAY_B[i]; t[d]=(d<<12)|c; }
  return t;
})();
function p25Golay18(w){
  let best=-1, bd=99;
  for(let d=0;d<64;d++){ const e=dmrPop((P25_G18[d]^w)>>>0); if(e<bd){ bd=e; best=d; } }
  return bd<=3 ? {v:best, err:bd} : null;
}

/* ---- LSD: циклический (16,8,5), g = x⁸+x⁵+x⁴+x³+1 ---- */
function p25LsdPar(d){ let r=d<<8; for(let i=15;i>=8;i--) if((r>>i)&1) r^=0x139<<(i-8); return r&255; }
function p25Lsd(w16){                                              // 16 бит → байт или −1
  const d=w16>>8;
  if(p25LsdPar(d)===(w16&255)) return d;
  let bd=99, best=-1;
  for(let v=0;v<256;v++){ const e=dmrPop((((v<<8)|p25LsdPar(v))^w16)>>>0); if(e<bd){ bd=e; best=v; } }
  return bd<2 ? best : -1;
}

/* ---- BCH(63,16) NID (Morelos-Zaragoza, как в MMDVMHost) ---- */
const P25_BCH_G=[1,1,0,0,1,1,0,1,1,0,0,1,0,0,1,1,0,0,0,0,1,0,1,1,1,1,0,1,1,1,0,1,0,0,1,1,1,0,1,1,0,0,1,0,1,0,1,1];
function p25BchPar(d16){                                           // d16[0..15] в порядке передачи → 47 проверочных бит
  const bb=new Array(47).fill(0);
  for(let i=15;i>=0;i--){
    const fb=d16[i]^bb[46];
    for(let j=46;j>0;j--) bb[j]=P25_BCH_G[j] ? bb[j-1]^fb : bb[j-1];
    bb[0]=P25_BCH_G[0] && fb ? 1 : 0;
  }
  return bb;
}
// 64 бита NID: NAC, DUID, BCH, чётность (1 у LDU1/LDU2)
function p25NidBits(nac,duid){
  const d=new Uint8Array(16);
  for(let i=0;i<12;i++) d[i]=(nac>>(11-i))&1;
  for(let i=0;i<4;i++) d[12+i]=(duid>>(3-i))&1;
  const b=new Uint8Array(64); b.set(d); b.set(p25BchPar(d),16);
  b[63]=duid===5 || duid===10 ? 1 : 0;
  return b;
}
let P25_NIDT=null;
function p25NidTable(){
  if(P25_NIDT) return P25_NIDT;
  const basis=[];
  for(let i=0;i<16;i++){ const d=new Uint8Array(16); d[i]=1; basis.push(p25BchPar(d)); }
  const N=4096*P25_DUIDS.length, A=new Uint32Array(N), B=new Uint32Array(N), K=new Uint16Array(N);
  let k=0;
  for(let nac=0;nac<4096;nac++) for(const duid of P25_DUIDS){
    const d=(nac<<4)|duid, par=new Uint8Array(47);
    for(let i=0;i<16;i++) if((d>>(15-i))&1) for(let j=0;j<47;j++) par[j]^=basis[i][j];
    let a=d*65536, b=duid===5 || duid===10 ? 1 : 0;
    for(let j=0;j<16;j++) a+=par[j]*Math.pow(2,15-j);
    for(let j=16;j<47;j++) b+=par[j]*Math.pow(2,31-(j-16));
    A[k]=a; B[k]=b; K[k]=d; k++;
  }
  return P25_NIDT={A,B,K};
}
// ближайшее слово среди всех NAC × DUID; maxErr — допуск, бит
function p25NidFind(bits,maxErr){
  const T=p25NidTable(); let a=0, b=0;
  for(let i=0;i<32;i++){ a=a*2+bits[i]; b=b*2+bits[32+i]; }
  let bd=99, bk=-1;
  for(let i=0;i<T.K.length;i++){
    const d=fsk4Pop((T.A[i]^a)>>>0)+fsk4Pop((T.B[i]^b)>>>0);
    if(d<bd){ bd=d; bk=T.K[i]; }
  }
  return bd<=maxErr ? {nac:bk>>4, duid:bk&15, err:bd} : null;
}

/* ---- трелис ½ (98 дибитов → 96 бит), как P25Trellis в MMDVMHost ---- */
const P25_IL=(()=>{ const t=[]; for(let g=0;g<4;g++) for(let i=0;i<(g ? 12 : 13);i++) for(const o of [0,1]) t.push(g*2+i*8+o); return t; })();
const P25_T12=[0,15,12,3, 4,11,8,7, 13,2,1,14, 9,6,5,10];
// точка созвездия → пара дибитов (+1 → 0, +3 → 1, −1 → 2, −3 → 3)
const P25_PTS=[[1,-1],[-1,-1],[3,-3],[-3,-3],[-3,-1],[3,-1],[-1,-3],[1,-3],[-3,3],[3,3],[-1,1],[1,1],[1,3],[-1,3],[3,1],[-3,1]]
  .map(p=>p.map(v=>v===1 ? 0 : v===3 ? 1 : v===-1 ? 2 : 3));
function p25Tr12Enc(bytes12){
  const bits=dmrBitsOf(bytes12), pts=new Uint8Array(98);
  let st=0;
  for(let i=0;i<49;i++){
    const x=i<48 ? bits[2*i]*2+bits[2*i+1] : 0, p=P25_PTS[P25_T12[st*4+x]];
    pts[2*i]=p[0]; pts[2*i+1]=p[1]; st=x;
  }
  const out=new Uint8Array(98);
  for(let i=0;i<98;i++) out[i]=pts[P25_IL[i]];
  return out;
}
// 98 принятых дибитов → 12 байт; err — расстояние выбранного пути (бит)
function p25Tr12Dec(dib){
  const pts=new Uint8Array(98);
  for(let i=0;i<98;i++) pts[P25_IL[i]]=dib[i];
  let cost=[0,1e9,1e9,1e9];
  const back=[];
  for(let i=0;i<49;i++){
    const a=pts[2*i], b=pts[2*i+1], nc=[1e9,1e9,1e9,1e9], bp=new Uint8Array(4);
    for(let s=0;s<4;s++){
      if(cost[s]>=1e9) continue;
      for(let x=0;x<4;x++){
        const p=P25_PTS[P25_T12[s*4+x]], d=cost[s]+dmrPop(p[0]^a)+dmrPop(p[1]^b);
        if(d<nc[x]){ nc[x]=d; bp[x]=s; }
      }
    }
    back.push(bp); cost=nc;
  }
  let s=0; for(let x=1;x<4;x++) if(cost[x]<cost[s]) s=x;
  const err=cost[s], x=new Uint8Array(49);
  for(let i=48;i>=0;i--){ x[i]=s; s=back[i][s]; }
  const bits=new Uint8Array(96);
  for(let i=0;i<48;i++){ bits[2*i]=x[i]>>1; bits[2*i+1]=x[i]&1; }
  return {bytes:p25Bytes(bits), bits, err};
}

/* ---- разбор служебных данных ---- */
const p25Mhz=f=>f==null ? '?' : (f/1e6).toFixed(5);
function p25Chan(P,ch){
  const t=P.idens[(ch>>12)&15], n=ch&0xFFF;
  if(!t) return null;
  return t.base+t.step*(t.tdma ? Math.floor(n/t.tdma) : n);
}
const p25ChanText=(P,ch)=>{ const f=p25Chan(P,ch); return f==null ? 'ch 0x'+ch.toString(16) : p25Mhz(f)+' MHz'; };
const P25_TSBK={0x00:'GRP_V_CH_GRANT', 0x02:'GRP_V_CH_GRANT_UPDT', 0x03:'GRP_V_CH_GRANT_UPDT_EXP', 0x04:'UU_V_CH_GRANT', 0x05:'UU_ANS_REQ', 0x06:'UU_V_CH_GRANT_UPDT',
  0x08:'TELE_INT_CH_GRANT', 0x14:'SN-DAT_CHN_GNT', 0x16:'SN-DAT_CHN_ANN', 0x1F:'CALL_ALERT', 0x20:'ACK_RSP_FNE', 0x21:'QUE_RSP', 0x24:'EXT_FNCT_CMD', 0x27:'DENY_RSP',
  0x28:'GRP_AFF_RSP', 0x29:'SCCB_EXP', 0x2A:'GRP_AFF_Q', 0x2B:'LOC_REG_RSP', 0x2C:'U_REG_RSP', 0x2D:'U_REG_CMD', 0x2E:'AUTH_CMD', 0x2F:'U_DE_REG_ACK',
  0x33:'IDEN_UP_TDMA', 0x34:'IDEN_UP_VU', 0x35:'TIME_DATE_ANN', 0x38:'SYS_SRV_BCST', 0x39:'SCCB', 0x3A:'RFSS_STS_BCST', 0x3B:'NET_STS_BCST', 0x3C:'ADJ_STS_BCST', 0x3D:'IDEN_UP'};
// 96 бит блока (с CRC) → {f: поля, text}; P.idens — таблица идентификаторов каналов (пополняется IDEN_UP*)
// смещения — от начала блока: 0 LB, 1 P, 2..7 код, 8..15 MFID, 16..79 аргументы, 80..95 CRC
function p25Tsbk(P,bits){
  const F=(a,l)=>dmrNum(bits,a,l), lb=bits[0], prot=bits[1], op=F(2,6), mf=F(8,8), name=P25_TSBK[op]||'TSBK 0x'+op.toString(16);
  const f={name, op, mfid:mf, lb, protected:prot};
  let text=name;
  if(prot) return {f, text:text+' (protected)'};
  if(mf===0 || mf===1){
    if(op===0x00){
      Object.assign(f,{opts:F(16,8), ch:F(24,16), to:F(40,16), from:F(56,24)}); f.freq=p25Chan(P,f.ch);
      text+=' TG '+f.to+' ← '+f.from+' @ '+p25ChanText(P,f.ch)+(f.opts&0x80 ? ' EMERGENCY' : '')+(f.opts&0x40 ? ' encrypted' : '');
    } else if(op===0x02){
      Object.assign(f,{ch1:F(16,16), to1:F(32,16), ch2:F(48,16), to2:F(64,16)});
      text+=' TG '+f.to1+' @ '+p25ChanText(P,f.ch1)+(f.ch2!==f.ch1 ? ', TG '+f.to2+' @ '+p25ChanText(P,f.ch2) : '');
    } else if(op===0x03){
      Object.assign(f,{opts:F(16,8), ch:F(32,16), chRx:F(48,16), to:F(64,16)});
      text+=' TG '+f.to+' @ '+p25ChanText(P,f.ch);
    } else if(op===0x28){
      Object.assign(f,{global:F(16,1), gav:F(22,2), aga:F(24,16), to:F(40,16), from:F(56,24)});
      text+=' unit '+f.from+' TG '+f.to+(f.gav ? ' refused' : ' accepted');
    } else if(op===0x2B){
      Object.assign(f,{rv:F(22,2), to:F(24,16), rfss:F(40,8), site:F(48,8), from:F(56,24)});
      text+=' unit '+f.from+' → RFSS '+f.rfss+' site '+f.site+(f.rv ? ' refused' : ' ok');
    } else if(op===0x2C){
      Object.assign(f,{rv:F(18,2), sysid:F(20,12), sid:F(32,24), from:F(56,24)});
      text+=' unit '+f.from+' sysid 0x'+f.sysid.toString(16)+(f.rv ? ' refused' : ' ok');
    } else if(op===0x2F){
      Object.assign(f,{wacn:F(24,20), sysid:F(44,12), from:F(56,24)});
      text+=' unit '+f.from+' sysid 0x'+f.sysid.toString(16);
    } else if(op===0x1F || op===0x20){
      Object.assign(f,{to:F(32,24), from:F(56,24)});
      if(op===0x20) f.svc=F(16,8);
      text+=' '+f.from+' → '+f.to;
    } else if(op===0x33 || op===0x34 || op===0x3D){
      const id=F(16,4), spac=F(38,10), t={base:F(48,32)*5, step:spac*125};
      if(op===0x3D){ t.off=(F(29,1) ? 1 : -1)*F(30,8)*250000; t.bw=F(20,9); }
      else { t.off=(F(24,1) ? 1 : -1)*F(25,13)*spac*125; if(op===0x33) t.tdma=[1,1,1,2,4,2,2,2,2,2,2,2,2,2,2,2][F(20,4)]; else t.bw=F(20,4); }
      P.idens[id]=t; Object.assign(f,{iden:id, base:t.base, step:t.step, offset:t.off});
      text+=' id '+id+' base '+p25Mhz(t.base)+' MHz step '+(t.step/1000)+' kHz'+(t.tdma ? ' TDMA ×'+t.tdma : '');
    } else if(op===0x3A){
      Object.assign(f,{lra:F(16,8), sysid:F(28,12), rfss:F(40,8), site:F(48,8), ch:F(56,16), svc:F(72,8)}); f.freq=p25Chan(P,f.ch);
      text+=' sysid 0x'+f.sysid.toString(16)+' RFSS '+f.rfss+' site '+f.site+' CC @ '+p25ChanText(P,f.ch);
    } else if(op===0x3B){
      Object.assign(f,{lra:F(16,8), wacn:F(24,20), sysid:F(44,12), ch:F(56,16), svc:F(72,8)}); f.freq=p25Chan(P,f.ch);
      text+=' WACN 0x'+f.wacn.toString(16)+' sysid 0x'+f.sysid.toString(16)+' CC @ '+p25ChanText(P,f.ch);
    } else if(op===0x3C){
      Object.assign(f,{lra:F(16,8), cfva:F(24,4), sysid:F(28,12), rfss:F(40,8), site:F(48,8), ch:F(56,16)}); f.freq=p25Chan(P,f.ch);
      text+=' sysid 0x'+f.sysid.toString(16)+' RFSS '+f.rfss+' site '+f.site+' @ '+p25ChanText(P,f.ch);
    } else if(op===0x38){
      Object.assign(f,{svcAvail:F(24,24), svcSupp:F(48,24), prio:F(72,8)});
      text+=' available 0x'+f.svcAvail.toString(16).padStart(6,'0')+' supported 0x'+f.svcSupp.toString(16).padStart(6,'0');
    } else if(op===0x39 || op===0x29){
      Object.assign(f,{rfss:F(16,8), site:F(24,8), ch1:F(32,16), ch2:F(56,16)});
      text+=' RFSS '+f.rfss+' site '+f.site+' @ '+p25ChanText(P,f.ch1);
    } else if(op===0x35){
      f.utcOffset=F(20,12);
    }
  }
  if(f.hex===undefined && Object.keys(f).length<=5) f.hex=dmrHex(p25Bytes(bits.subarray(16,80)));
  return {f, text};
}
function p25Lc(b72){                                               // 72 бита LC → поля
  const y=p25Bytes(b72), lcf=y[0], op=lcf&0x3F, mf=y[1];
  const f={lcf:op, mfid:mf, protected:lcf>>7, explicit:(lcf>>6)&1};
  const id3=o=>y[o]*65536+y[o+1]*256+y[o+2];
  if((mf===0 || mf===1) && op===0x00){ Object.assign(f,{type:'group', svc:y[2], to:y[4]*256+y[5], from:id3(6), emergency:y[2]>>7, encrypted:(y[2]>>6)&1}); }
  else if((mf===0 || mf===1) && op===0x03){ Object.assign(f,{type:'private', svc:y[2], to:id3(3), from:id3(6), emergency:y[2]>>7, encrypted:(y[2]>>6)&1}); }
  else if((mf===0 || mf===1) && op===0x0F){ Object.assign(f,{type:'terminate', to:id3(3), from:id3(6)}); }
  else f.hex=dmrHex(y,2,7);
  return f;
}

/* ---- разбор кадров ---- */
function p25Emit(P,L,out,kind,f,text){
  const r={t:Date.now(), src:'P25', kind, nac:P.nac, ...f, text};
  out.recs.push(r);
  P.recent.push(text); if(P.recent.length>20) P.recent.shift();
  return r;
}
// 648 бит → RS(36,20) гексабиты HDU; null при неудаче
function p25HduDecode(F){
  const bits=fsk4Unpack(p25Data(F,56,324),0,324), rs=new Uint8Array(36);
  for(let i=0;i<36;i++){
    let w=0; for(let k=0;k<18;k++) w=w*2+bits[18*i+k];
    const g=p25Golay18(w); rs[i]=g ? g.v : 0;
  }
  if(p25RsDec(rs,20)<0) return null;
  return p25Bytes(p25HexBits(rs.subarray(0,20)));
}
// LC / ESS из шести групп по 4 слова Хэмминга (10,6,3); k — число информационных гексабит (12 — LC, 16 — ESS)
const P25_LCPOS=[200,292,384,476,568,660];
function p25LduWords(F,k){
  const hex=new Uint8Array(24);
  for(let g=0;g<6;g++){
    const bits=fsk4Unpack(p25Data(F,P25_LCPOS[g],20),0,20);
    for(let w=0;w<4;w++){ const o=w*10; dmrHam(P25_H1063,bits,o); hex[4*g+w]=p25Hex(bits,o); }
  }
  const ec=p25RsDec(hex,k);
  return ec<0 ? null : {bits:p25HexBits(hex.subarray(0,k)), ec};
}
const P25_IMBE=[56,128,220,312,404,496,588,680,768];

FSK4.protos.p25={
  id:'p25', name:'P25', baud:P25_BAUD, alpha:.2, lp:5500, levels:4, thrAcq:4, thrLock:8, syncs:[P25_SYNC],
  init(P){
    P.now=0; P.eps=0; P.nac=null; P.call=null; P.recent=[]; P.lastAct=0; P.idens={}; P.cc=null; P.crypt=null;
    P.st={frames:0, hdu:0, ldu:0, tdu:0, tsdu:0, tsbk:0, pdu:0, voice:0, calls:0, bad:0, locks:0};
  },
  reset(P){ P.now=0; P.call=null; },
  lock(P,L){
    P.st.locks++;
    L.after=P25_AFTER_NID;
    return {stage:0, first:true, duid:null, k:0, last:-1, eps:P.eps, exp:L.next, plen:0, blind:false};
  },
  ui(P,L,now){
    const s=P.st, c=P.call;
    const head='P25 · '+(L ? 'NAC 0x'+(P.nac==null ? '?' : P.nac.toString(16).toUpperCase())+(L.g<0 ? ', inverted' : '') : 'searching sync')+
      (P.lastAct ? ' · last '+((now-P.lastAct)/1000).toFixed(0)+' s ago' : '');
    const cnt=s.frames+' frames · '+s.ldu+' LDU · '+s.tsbk+' TSBK · '+s.calls+' calls · '+s.bad+' FEC errors';
    return {locked:!!L, nac:P.nac, st:{...s}, age:P.lastAct ? now-P.lastAct : null, call:c, recent:P.recent.slice(-8), idens:Object.keys(P.idens).length,
      text:head+'\n'+cnt+'\n'+(c ? (c.type||'call')+' '+c.from+' → '+c.to+(c.emergency ? ' EMERGENCY' : '')+(c.encrypted ? ' encrypted' : '')+' · '+c.ldu+' LDU' : 'idle')+
        (P.recent.length ? '\n'+P.recent.slice(-8).join('\n') : '')};
  },
  frame(P,L,e,out){
    P.now=e/(FSK4_PH*P25_BAUD)*1000;
    if(L.stage===0) this.nid(P,L,e,out); else this.body(P,L,e,out);
  },
  // следующее синхро ждём с поправкой на уход такта; сдвиг найденного синхро относительно ожидаемого уточняет оценку ухода
  advance(P,L,len){
    L.next=Math.round(L.next+8*len*(1+L.eps)); L.exp=L.next; L.plen=len;
    L.best=99; L.bestRq=1e9; L.stage=0; L.after=P25_AFTER_NID; L.first=false;
  },
  tail(L,len){ return len-24+Math.max(0,Math.ceil(len*L.eps))+1; },
  nid(P,L,e,out){
    // синхрослово рядом с ожидаемым местом было? иначе NID доверия нет (тишина даёт «правильное» нулевое слово)
    const synced=L.first || L.best!==99;
    if(synced){ L.miss=0; if(L.plen){ L.eps=P.eps=Math.max(-.002,Math.min(.002,L.eps+.5*(L.next-L.exp)/(8*L.plen))); } }
    else if(++L.miss>P25_MISS){ fsk4Drop(L); return; }
    const F=fsk4Slice(L,e,24+P25_AFTER_NID), r=synced ? p25NidFind(fsk4Unpack(p25Data(F,24,32),0,32),8) : null;
    let duid;
    L.blind=false;
    if(r){ duid=r.duid; P.nac=r.nac; }
    else {                                                        // NID не разобран: продолжение вызова угадываем по предыдущему кадру
      duid=({0:5, 5:10, 10:5, 7:7})[L.last];
      if(synced) P.st.bad++;
      if(duid==null){ fsk4Drop(L); return; }
      L.blind=!synced;
    }
    L.duid=duid; L.last=duid; L.stage=1; L.k=1; P.st.frames++;
    if(P25_LEN[duid]) L.after=this.tail(L,P25_LEN[duid]);
    else if(duid===7 || duid===12) L.after=this.tail(L,p25Span(56+98));
    else fsk4Drop(L);
  },
  body(P,L,e,out){
    const duid=L.duid;
    if(duid===7 || duid===12) return this.blocks(P,L,e,out);
    const len=P25_LEN[duid], F=fsk4Slice(L,L.next+8*(len-24),len,L.eps);
    P.lastAct=Date.now();
    if(duid===0){
      P.st.hdu++;
      const b=p25HduDecode(F);
      if(b){
        const mi=dmrHex(b,0,9), algid=b[10], kid=b[11]*256+b[12], to=b[13]*256+b[14];
        P.crypt={algid, kid, mi};
        p25Emit(P,L,out,'hdu',{mi, mfid:b[9], algid, algo:P25_ALGO[algid]||'0x'+algid.toString(16), kid, to},
          'HDU TG '+to+' '+(P25_ALGO[algid]||'algo 0x'+algid.toString(16))+(algid!==0x80 ? ' key '+kid : ''));
      } else if(L.blind){ fsk4Drop(L); return; } else P.st.bad++;
    } else if(duid===5 || duid===10){ if(!this.ldu(P,L,F,duid,e,out)) return; }
    else if(duid===3){ P.st.tdu++; this.end(P,L,out,'TDU'); }
    else if(duid===15){ P.st.tdu++; this.end(P,L,out,'TDULC'); }
    this.advance(P,L,len);
  },
  ldu(P,L,F,duid,e,out){
    P.st.ldu++;
    const c=P.call, tag=duid===5 ? 'LDU1' : 'LDU2';
    const w=p25LduWords(F,duid===5 ? 12 : 16);
    if(!w){ if(L.blind){ fsk4Drop(L); return false; } P.st.bad++; }
    else if(duid===5){
      const f=p25Lc(w.bits.subarray(0,72));
      if(f.type==='group' || f.type==='private'){
        if(!c || c.from!==f.from || c.to!==f.to || P.now-c.last>3000){
          if(c) this.end(P,L,out,'call');
          P.call={from:f.from, to:f.to, type:f.type, emergency:f.emergency, encrypted:f.encrypted, t0:P.now, last:P.now, ldu:0, voice:0, nac:P.nac};
          P.st.calls++;
          p25Emit(P,L,out,'call',{from:f.from, to:f.to, call:f.type, emergency:f.emergency, encrypted:f.encrypted, svc:f.svc, source:'LDU1'},
            (f.emergency ? 'EMERGENCY ' : '')+f.type+' call '+f.from+' → '+f.to+(f.encrypted ? ' [encrypted]' : ''));
        }
      } else if(f.hex!==undefined){
        p25Emit(P,L,out,'lc',{...f},'LC 0x'+f.lcf.toString(16)+(f.mfid>1 ? ' MFID 0x'+f.mfid.toString(16) : '')+' '+f.hex);
      }
    } else {
      const b=p25Bytes(w.bits), algid=b[9], kid=b[10]*256+b[11], mi=dmrHex(b,0,9);
      if(!P.crypt || P.crypt.algid!==algid || P.crypt.kid!==kid){
        P.crypt={algid, kid, mi};
        p25Emit(P,L,out,'crypt',{mi, algid, algo:P25_ALGO[algid]||'0x'+algid.toString(16), kid},
          'ESS '+(P25_ALGO[algid]||'algo 0x'+algid.toString(16))+(algid!==0x80 ? ' key '+kid : ''));
      }
    }
    if(P.call){ P.call.ldu++; P.call.last=P.now; }
    // сырые кадры IMBE (144 бита каждый)
    const c2=P.call;
    for(let i=0;i<9;i++){
      const bits=fsk4Unpack(p25Data(F,P25_IMBE[i],72),0,72);
      out.voice.push({t:P.now, src:'P25', kind:'imbe', nac:P.nac, seq:tag, n:i+1, from:c2?c2.from:null, to:c2?c2.to:null, imbe:dmrHex(p25Bytes(bits))});
      P.st.voice++; if(c2) c2.voice++;
    }
    // низкоскоростные данные (только в LDU1/LDU2: 2 байта)
    const lb=fsk4Unpack(p25Data(F,752,16),0,16), l1=p25Lsd(dmrNum(lb,0,16));
    if(l1>0 && w) p25Emit(P,L,out,'lsd',{lsd:l1, seq:tag},'LSD '+l1.toString(16).padStart(2,'0'));
    return true;
  },
  end(P,L,out,by){
    const c=P.call;
    if(!c) return;
    const dur=(P.now-c.t0)/1000;
    p25Emit(P,L,out,'end',{from:c.from, to:c.to, call:c.type, seconds:+dur.toFixed(1), ldu:c.ldu, voice:c.voice, by},
      'END '+c.from+' → '+c.to+' · '+dur.toFixed(1)+' s · '+c.ldu+' LDU ('+by+')');
    P.call=null;
  },
  // TSDU: до трёх блоков по 98 дибитов; PDU: только заголовок
  blocks(P,L,e,out){
    const k=L.k, span=p25Span(56+98*k), F=fsk4Slice(L,L.next+8*(span-24),span,L.eps);
    P.lastAct=Date.now();
    const d=p25Tr12Dec(p25Data(F,56+98*(k-1),98)), bits=dmrBitsOf(d.bytes);
    const ok=dmrCrc16(d.bytes,10)===d.bytes[10]*256+d.bytes[11];
    let last=true;
    if(L.duid===7){
      P.st.tsdu+=k===1 ? 1 : 0;
      if(ok){
        P.st.tsbk++;
        const r=p25Tsbk(P,bits);
        p25Emit(P,L,out,'tsbk',r.f,r.text);
        last=!!bits[0];
      } else if(L.blind){ fsk4Drop(L); return; } else P.st.bad++;
      if(!last && k<3){ L.k++; L.after=this.tail(L,p25Span(56+98*(k+1))); return; }
      this.advance(P,L,Math.ceil(span/36)*36);
    } else {
      P.st.pdu++;
      if(ok){
        const b=d.bytes, f={fmt:b[0]&31, ao:b[0]>>6, sap:b[1]&63, mfid:b[2], llid:b[3]*65536+b[4]*256+b[5], blocks:b[6]&127};
        p25Emit(P,L,out,'pdu',f,'PDU fmt 0x'+f.fmt.toString(16)+' SAP '+f.sap+' LLID '+f.llid+' · '+f.blocks+' data blocks');
      } else P.st.bad++;
      fsk4Drop(L);                                                // длину данных не отслеживаем: следующий кадр найдёт поиск синхрослова
    }
  }};
FSK4.order.push('p25');

/* ---- генератор: кадры P25 ---- */
const P25_SYNC_DIB=fsk4Dib(Uint8Array.from(P25_SYNC.bits,c=>+c));
function p25Frame(nac,duid,body,len){ return p25Weave(p25Cat(P25_SYNC_DIB,fsk4Dib(p25NidBits(nac,duid)),body),len); }
function p25BytesBits(b){ return dmrBitsOf(b); }
function p25HduBody(mi,mfid,algid,kid,tgid){
  const raw=new Uint8Array(15); raw.set(mi); raw[9]=mfid; raw[10]=algid; raw[11]=kid>>8; raw[12]=kid&255; raw[13]=tgid>>8; raw[14]=tgid&255;
  const rs=p25RsEnc(p25BitsHex(p25BytesBits(raw)),36), bits=new Uint8Array(648);
  for(let i=0;i<36;i++){ const w=P25_G18[rs[i]]; for(let k=0;k<18;k++) bits[18*i+k]=(w>>(17-k))&1; }
  return fsk4Dib(bits);
}
// LDU: 9 кадров IMBE (по 18 байт), 24 гексабита LC/ESS, 2 байта LSD
function p25LduBody(imbe,hex24,lsd){
  const lc=[];
  for(let g=0;g<6;g++){
    const bits=new Uint8Array(40);
    for(let w=0;w<4;w++){ const h=hex24[4*g+w]; for(let k=0;k<6;k++) bits[10*w+k]=(h>>(5-k))&1; dmrHamEnc(P25_H1063,bits,10*w); }
    lc.push(fsk4Dib(bits));
  }
  const ls=new Uint8Array(32);
  for(let i=0;i<2;i++){ const d=lsd[i], w=(d<<8)|p25LsdPar(d); for(let k=0;k<16;k++) ls[16*i+k]=(w>>(15-k))&1; }
  const v=imbe.map(b=>fsk4Dib(p25BytesBits(b)));
  return p25Cat(v[0],v[1],lc[0],v[2],lc[1],v[3],lc[2],v[4],lc[3],v[5],lc[4],v[6],lc[5],v[7],fsk4Dib(ls),v[8]);
}
function p25Ldu1Body(imbe,type,svc,to,from){
  const lc=new Uint8Array(9); lc[0]=type==='private' ? 3 : 0; lc[2]=svc;
  if(type==='private'){ lc[3]=to>>16; lc[4]=(to>>8)&255; lc[5]=to&255; } else { lc[4]=to>>8; lc[5]=to&255; }
  lc[6]=from>>16; lc[7]=(from>>8)&255; lc[8]=from&255;
  return p25LduBody(imbe,p25RsEnc(p25BitsHex(p25BytesBits(lc)),24),[0,0]);
}
function p25Ldu2Body(imbe,mi,algid,kid,lsd){
  const e=new Uint8Array(12); e.set(mi); e[9]=algid; e[10]=kid>>8; e[11]=kid&255;
  return p25LduBody(imbe,p25RsEnc(p25BitsHex(p25BytesBits(e)),24),lsd||[0,0]);
}
// блок TSBK: fields — [значение, бит]…, всего 64 бита аргументов
function p25TsbkBlock(op,mf,fields,lb){
  const b=new Uint8Array(96); b[0]=lb ? 1 : 0;
  for(let i=0;i<6;i++) b[2+i]=(op>>(5-i))&1;
  for(let i=0;i<8;i++) b[8+i]=(mf>>(7-i))&1;
  let o=16;
  for(const [v,n] of fields){ for(let i=0;i<n;i++) b[o+i]=Math.floor(v/Math.pow(2,n-1-i))&1; o+=n; }
  const c=dmrCrc16(p25Bytes(b),10); for(let i=0;i<16;i++) b[80+i]=(c>>(15-i))&1;
  return p25Tr12Enc(p25Bytes(b));
}
function p25TsduFrame(nac,blocks){                                  // blocks — массив 98-дибитных блоков
  const body=p25Cat(...blocks), D=56+body.length, len=Math.ceil(p25Span(D)/36)*36;
  return p25Frame(nac,7,body,len);
}
// сеанс генератора: 'voice' — HDU, LDU1/2, TDU; иначе — управляющий канал транкинга
function p25Script(mode){
  const nac=0x293, rnd=(()=>{ let x=0x1234567; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return x&255; }; })();
  const imbe=()=>Array.from({length:9},()=>Uint8Array.from({length:18},rnd)), mi=Uint8Array.from([1,2,3,4,5,6,7,8,9]);
  const seq=[];
  if(mode==='voice'){
    seq.push(p25Frame(nac,0,p25HduBody(mi,0,0x80,0,4321),396));
    seq.push(p25Frame(nac,5,p25Ldu1Body(imbe(),'group',0,4321,1234567),864));
    seq.push(p25Frame(nac,10,p25Ldu2Body(imbe(),mi,0x80,0,[0x5A,0]),864));
    seq.push(p25Frame(nac,5,p25Ldu1Body(imbe(),'group',0,4321,1234567),864));
    seq.push(p25Frame(nac,10,p25Ldu2Body(imbe(),mi,0x80,0,[0,0]),864));
    seq.push(p25Frame(nac,3,new Uint8Array(14),72));
  } else {
    seq.push(p25TsduFrame(nac,[
      p25TsbkBlock(0x3D,0,[[1,4],[100,9],[1,1],[0,8],[100,10],[851012500/5,32]],0),
      p25TsbkBlock(0x3A,0,[[0,8],[0,4],[nac,12],[1,8],[7,8],[0x1001,16],[0x70,8]],0),
      p25TsbkBlock(0x3B,0,[[0,8],[0xBEE00,20],[nac,12],[0x1001,16],[0x70,8]],1)]));
    seq.push(p25TsduFrame(nac,[p25TsbkBlock(0x00,0,[[0x40,8],[0x1003,16],[4321,16],[1234567,24]],1)]));
    seq.push(p25TsduFrame(nac,[
      p25TsbkBlock(0x28,0,[[0,1],[0,5],[0,2],[0,16],[4321,16],[1234567,24]],0),
      p25TsbkBlock(0x38,0,[[0,8],[0x0F0F0F,24],[0x0F0F0F,24],[0,8]],1)]));
  }
  return fsk4LevelsOf(p25Cat(new Uint8Array(60),...seq,new Uint8Array(60)));
}
FSK4.gen['P25 voice']={baud:P25_BAUD, alpha:.2, dev:600, script:()=>p25Script('voice')};
FSK4.gen['P25 control channel']={baud:P25_BAUD, alpha:.2, dev:600, script:()=>p25Script('control')};
