"use strict";
/* Расшифровка голоса: P25 ADP (ALGID 0xAA) и DMR Enhanced Privacy (ALG 0x21) — RC4, ключ 40 бит.
   Гамма идёт на биты параметров вокодера до FEC: кадр mbelib разбирается, расшифровывается и собирается обратно.
   P25: RC4(key‖MI[8]), гамма с байта 267, 11 байт на кадр, +101 для LDU2, +2 (LSD) перед 9-м кадром.
   DMR: RC4(key‖MI[4]), гамма с байта 256, 7 байт на кадр подряд с заголовка вызова. Смещения — как в dsd-fme. */

class VcRc4 {
  constructor(key){
    const s=new Uint8Array(256); for(let i=0;i<256;i++) s[i]=i;
    for(let i=0,j=0;i<256;i++){ j=(j+s[i]+key[i%key.length])&255; const t=s[i]; s[i]=s[j]; s[j]=t; }
    this.s=s; this.i=0; this.j=0; this.ks=[];
  }
  at(n){
    const s=this.s;
    while(this.ks.length<=n){
      this.i=(this.i+1)&255; this.j=(this.j+s[this.i])&255;
      const t=s[this.i]; s[this.i]=s[this.j]; s[this.j]=t;
      this.ks.push(s[(s[this.i]+s[this.j])&255]);
    }
    return this.ks[n];
  }
}

const vcPar=x=>{ x^=x>>8; x^=x>>4; x^=x>>2; x^=x>>1; return x&1; };
const vcPop=x=>{ let c=0; for(;x;x&=x-1) c++; return c; };
const vcGolayChk=d=>{ let r=d<<11; for(let i=22;i>=11;i--) if((r>>i)&1) r^=0xC75<<(i-11); return r&0x7FF; };
let VC_GS=null;
function vcGolayDec(w){                       // слово 23 бита: данные верхние 12; исправляет до 3 ошибок
  if(!VC_GS){
    const t=VC_GS=new Int32Array(2048).fill(-1), syn=x=>vcGolayChk(x>>>11)^(x&0x7FF);
    t[0]=0;
    for(let a=0;a<23;a++){ t[syn(1<<a)]=1<<a;
      for(let b=a+1;b<23;b++){ t[syn((1<<a)|(1<<b))]=(1<<a)|(1<<b);
        for(let c=b+1;c<23;c++) t[syn((1<<a)|(1<<b)|(1<<c))]=(1<<a)|(1<<b)|(1<<c); } }
  }
  const e=VC_GS[vcGolayChk(w>>>11)^(w&0x7FF)];
  return {d:(w^e)>>>11, e:vcPop(e)};
}
const VC_HG=[0x7f08,0x78e4,0x66d2,0x55b1];
const vcHamSyn=w=>{ let s=0; for(let i=0;i<4;i++) s=(s<<1)|vcPar(w&VC_HG[i]); return s; };
let VC_HS=null;
function vcHamDec(w){                         // Hamming(15,11) IMBE: данные верхние 11 бит
  if(!VC_HS){ VC_HS=new Int8Array(16).fill(-1); for(let p=0;p<15;p++) VC_HS[vcHamSyn(1<<p)]=p; }
  const s=vcHamSyn(w);
  if(s) w^=1<<VC_HS[s];                       // у mbelib таблица позиций линейная и ошибается в трети случаев
  return {d:w>>>4, e:s ? 1 : 0};
}
function vcHamEnc(d){ let w=d<<4; for(let i=0;i<4;i++) w|=vcPar(w&VC_HG[i])<<(3-i); return w; }
function vcPn(seed,n){                        // псевдослучайная маска mbelib: pr[1..n]
  const p=new Uint8Array(n+1); let x=(16*seed)&0xFFFF;
  for(let i=1;i<=n;i++){ x=(173*x+13849)&0xFFFF; p[i]=x>>15; }
  return p;
}
const vcPut=(u,o,v,n)=>{ for(let i=0;i<n;i++) u[o+i]=(v>>(n-1-i))&1; };
const vcGet=(u,o,n)=>{ let v=0; for(let i=0;i<n;i++) v=v*2+u[o+i]; return v; };

// IMBE: матрица 8×23 (плоско) ↔ 88 бит данных
function vcImbeDec(fr){
  const u=new Uint8Array(88); let e=0, c0=0, o=0;
  const row=(r,n,pr,k)=>{ let w=0; for(let j=n-1;j>=0;j--) w|=(fr[r*23+j]^(pr ? pr[k++] : 0))<<j; return w; };
  const g0=vcGolayDec(row(0,23)); c0=e=g0.e; vcPut(u,0,g0.d,12); o=12;
  const pr=vcPn(g0.d,114); let k=1;
  for(let r=1;r<4;r++){ const g=vcGolayDec(row(r,23,pr,k)); k+=23; e+=g.e; vcPut(u,o,g.d,12); o+=12; }
  for(let r=4;r<7;r++){ const g=vcHamDec(row(r,15,pr,k)); k+=15; e+=g.e; vcPut(u,o,g.d,11); o+=11; }
  for(let j=6;j>=0;j--) u[o++]=fr[7*23+j];
  return {u, e, c0};
}
function vcImbeEnc(u){
  const fr=new Uint8Array(184); let o=0;
  const u0=vcGet(u,0,12), pr=vcPn(u0,114); let k=1; o=12;
  const w0=(u0<<11)|vcGolayChk(u0); for(let j=0;j<23;j++) fr[j]=(w0>>j)&1;
  for(let r=1;r<4;r++){ const d=vcGet(u,o,12), w=(d<<11)|vcGolayChk(d); o+=12; for(let j=22;j>=0;j--) fr[r*23+j]=((w>>j)&1)^pr[k++]; }
  for(let r=4;r<7;r++){ const d=vcGet(u,o,11), w=vcHamEnc(d); o+=11; for(let j=14;j>=0;j--) fr[r*23+j]=((w>>j)&1)^pr[k++]; }
  for(let j=6;j>=0;j--) fr[7*23+j]=u[o++];
  return fr;
}
// AMBE+2 (DMR): матрица 4×24 (плоско) ↔ 49 бит данных
function vcAmbeDec(fr){
  const u=new Uint8Array(49);
  let w0=0; for(let j=0;j<23;j++) w0|=fr[1+j]<<j;
  const g0=vcGolayDec(w0), pr=vcPn(g0.d,23);
  let w1=0; for(let j=22;j>=0;j--) w1|=(fr[24+j]^pr[23-j])<<j;
  const g1=vcGolayDec(w1);
  vcPut(u,0,g0.d,12); vcPut(u,12,g1.d,12);
  for(let i=0;i<11;i++) u[24+i]=fr[48+10-i];
  for(let i=0;i<14;i++) u[35+i]=fr[72+13-i];
  return {u, e:g0.e+g1.e, c0:g0.e};
}
function vcAmbeEnc(u){
  const fr=new Uint8Array(96), u0=vcGet(u,0,12), pr=vcPn(u0,23);
  const w0=(u0<<11)|vcGolayChk(u0), u1=vcGet(u,12,12), w1=(u1<<11)|vcGolayChk(u1);
  for(let j=0;j<23;j++) fr[1+j]=(w0>>j)&1;
  fr[0]=vcPop(w0)&1;
  for(let j=22;j>=0;j--) fr[24+j]=((w1>>j)&1)^pr[23-j];
  for(let i=0;i<11;i++) fr[48+10-i]=u[24+i];
  for(let i=0;i<14;i++) fr[72+13-i]=u[35+i];
  return fr;
}

/* Ключи: строки через `;` или перевод строки, `#` — комментарий.
     0123456789        любой вызов
     5=0123456789      ключ с ID 5 (в заголовке вызова)
     tg:5000=0123456789 группа / получатель 5000
   Приоритет: tg → ID ключа → любой; при равенстве побеждает более поздняя запись. */
function vcParseKeys(txt){
  const list=[], bad=[];
  for(const raw of String(txt||'').split(/[;\n\r]+/)){
    const l=raw.replace(/#.*/,'').trim(); if(!l) continue;
    const m=l.match(/^(?:(\*|tg\s*:\s*(\w+)|(?:kid\s*:\s*)?(\w+))\s*=\s*)?(?:0x)?([0-9a-f\s:.\-]+)$/i);
    const hex=m ? m[4].replace(/[^0-9a-f]/gi,'') : '';
    if(!m || hex.length!==10){ bad.push(l); continue; }
    const num=s=>/^0x/i.test(s) ? parseInt(s,16) : /^\d+$/.test(s) ? parseInt(s,10) : NaN;
    let sel='any', id=0;
    if(m[2]!=null){ sel='tg'; id=num(m[2]); } else if(m[3]!=null){ sel='kid'; id=num(m[3]); }
    if((sel!=='any') && isNaN(id)){ bad.push(l); continue; }
    list.push({sel, id, hex:hex.toUpperCase(), bytes:Uint8Array.from(hex.match(/../g),h=>parseInt(h,16))});
  }
  return {list, bad};
}
function vcPick(list,kid,tg){
  let best=null, rank=0;
  for(const e of list){
    const r=e.sel==='tg' ? (e.id===tg ? 3 : 0) : e.sel==='kid' ? (e.id===kid ? 2 : 0) : 1;
    if(r && r>=rank){ best=e; rank=r; }
  }
  return best;
}

// кадр f записи voice → {st, fm?, alg, kid, errs?}; null — вызов открытый или формат без шифрования.
// st: ok | nokey | nomi | alg (алгоритм не поддержан) | err (слишком много ошибок в кадре)
function vcDecrypt(r,f,fm,keys,s){
  if(r.alg==null) return null;
  const p25=r.src==='P25';
  if(p25 ? (r.alg===0x80 || r.alg===0) : r.alg===0) return null;
  const info={alg:r.alg, kid:r.kid};
  if(p25 ? r.alg!==0xAA : r.alg!==0x21) return {...info, st:'alg'};
  const k=vcPick(keys,r.kid,r.to);
  if(!k) return {...info, st:'nokey'};
  if(!r.mi) return {...info, st:'nomi'};
  const miB=r.mi.match(/../g).map(h=>parseInt(h,16));
  const base=p25 ? 267+(r.seq==='LDU2' ? 101 : 0)+11*(r.n-1)+(r.n===9 ? 2 : 0) : 256+7*(3*r.vb+f);
  const bits=p25 ? 88 : 49;
  if(!(base>=0) || base>1<<20) return {...info, st:'nomi'};
  const sig=r.src+'|'+r.alg+'|'+k.hex+'|'+r.mi;
  if(!s.rc4 || s.rc4.sig!==sig){ s.rc4=new VcRc4(Uint8Array.from([...k.bytes,...(p25 ? miB.slice(0,8) : miB.slice(0,4))])); s.rc4.sig=sig; }
  const d=p25 ? vcImbeDec(fm.fr) : vcAmbeDec(fm.fr);
  if(!p25 && d.c0>=3) return {...info, st:'err'};
  for(let i=0;i<bits;i++) d.u[i]^=(s.rc4.at(base+(i>>3))>>(7-(i&7)))&1;
  return {...info, st:'ok', errs:d.e, fm:{k:fm.k, fr:p25 ? vcImbeEnc(d.u) : vcAmbeEnc(d.u)}};
}
