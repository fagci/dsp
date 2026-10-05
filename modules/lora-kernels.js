"use strict";
/* ============================ LoRa (Semtech, чирп-модуляция CSS) ============================
   Ядро IQK (страница и воркер), без DOM. Физический уровень по описанию открытых реализаций (gr-lora_sdr, LoRaPHY):
   байты → белая последовательность (LFSR x⁸+x⁶+x⁵+x⁴+1) → полубайты (младший первым) → Хэмминг 4/(4+CR) → диагональное перемежение блока
   SF строк → код Грея → циклический сдвиг базового чирпа. Кадр: преамбула (апчирпы), синхрослово (2 чирпа со сдвигом 8·полубайт),
   2,25 даунчирпа, затем символы. Первый блок (8 символов) — всегда CR 4/8 и SF−2 бит на символ (в нём заголовок), при LDRO так же и вся
   нагрузка. CRC-16 (CCITT) считается по нагрузке без последних двух байт и складывается XOR с ними.
   Приём: канал → ФНЧ (шире ±BW/2: край чирпа, сдвинутый CFO, не должен резаться) → передискретизация до 2·BW → де-чирп и БПФ из M = 2^SF
   отсчётов. Преамбулу находим по одинаковому пику в подряд идущих окнах; границу кадра и сдвиг частоты — по паре пиков up/down (SFD):
   трапеция амплитуды даунчирпа снимает неоднозначность в M/2, затем границу уточняем итерациями до долей отсчёта. Окна символов берутся с
   дробной позиции, а уход тактов гасит ПИ-петля по скачку фазы между половинами чирпа. Совместимость с настоящими приёмопередатчиками —
   по открытым описаниям, на железе не проверена. */

/* ---- PHY ---- */
function loraWhite(len){                                          // 0xFF, 0xFE, 0xFC, 0xF8, 0xF0, 0xE1, …
  const o=new Uint8Array(len); let a=0xFF;
  for(let i=0;i<len;i++){ o[i]=a; a=((a<<1)&0xFF)|(((a>>7)^(a>>5)^(a>>4)^(a>>3))&1); }
  return o;
}
// кодовое слово (4+cr бит, старший первым): d0 d1 d2 d3 p0 p1 p2 p3; cr=1 — один бит чётности
function loraCw(nib,cr){
  const d=[nib&1,(nib>>1)&1,(nib>>2)&1,(nib>>3)&1];
  const p=[d[0]^d[1]^d[2], d[1]^d[2]^d[3], d[0]^d[1]^d[3], d[0]^d[2]^d[3]];
  const bits=d.concat(cr===1 ? [d[0]^d[1]^d[2]^d[3]] : p.slice(0,cr));
  let w=0; for(const b of bits) w=(w<<1)|b;
  return w;
}
const LORA_CW=[null,...[1,2,3,4].map(cr=>Array.from({length:16},(_,v)=>loraCw(v,cr)))];
// слово → {nib, err}: 0 — чисто, 1 — исправлена ошибка, 2 — ошибка не исправлена (cr 1…2 только обнаруживают)
function loraHamDec(w,cr){
  const T=LORA_CW[cr];
  if(cr<=2){                                                       // данные — старшие 4 бита (d0 первым), проверка пересчётом
    const dd=w>>cr, nib=((dd>>3)&1)|(((dd>>2)&1)<<1)|(((dd>>1)&1)<<2)|((dd&1)<<3);
    return {nib, err:T[nib]===w ? 0 : 2};
  }
  let best=0, bd=99, tie=false;
  for(let v=0;v<16;v++){ const d=popcnt32(T[v]^w); if(d<bd){ bd=d; best=v; tie=false; } else if(d===bd) tie=true; }
  return {nib:best, err:bd===0 ? 0 : bd===1 && !tie ? 1 : 2};
}
function loraGray(v){ return v^(v>>1); }
function loraGrayInv(g){ let b=g; for(let s=1;s<16;s<<=1) b^=b>>s; return b; }
// проверочная сумма заголовка: 5 бит от трёх полубайт (длина, CR и флаг CRC)
function loraHdrChk(a0,a1,a2){
  const b=(v,i)=>(v>>i)&1;
  const c4=b(a0,3)^b(a0,2)^b(a0,1)^b(a0,0);
  const c3=b(a0,3)^b(a1,3)^b(a1,2)^b(a1,1)^b(a2,0);
  const c2=b(a0,2)^b(a1,3)^b(a1,0)^b(a2,3)^b(a2,1);
  const c1=b(a0,1)^b(a1,2)^b(a1,0)^b(a2,2)^b(a2,1)^b(a2,0);
  const c0=b(a0,0)^b(a1,1)^b(a2,3)^b(a2,2)^b(a2,1)^b(a2,0);
  return (c4<<4)|(c3<<3)|(c2<<2)|(c1<<1)|c0;
}
function loraCrc(b){                                              // CCITT 0x1021, init 0, по нагрузке без последних двух байт, XOR с ними
  const L=b.length;
  let c=crc16(b,0,Math.max(0,L-2),0x1021,0,0);
  if(L>=1) c^=b[L-1];
  if(L>=2) c^=b[L-2]<<8;
  return c&0xFFFF;
}
// ldro: низкая скорость (SF11/12 при BW 125 кГц и ниже): символ несёт SF−2 бит; auto — как у Semtech, символ длиннее 16 мс
function loraLdro(mode,sf,bw){ return mode==='on' || (mode!=='off' && (1<<sf)/bw>0.016); }
// число символов кадра: 8 + ceil((8·PL − 4·SF + 28 + 16·CRC − 20·IH) / (4·(SF − 2·DE)))·(CR+4)
function loraSymCount(len,o){
  const top=8*len-4*o.sf+28+16*(o.crc?1:0)-20*(o.ih?1:0);
  return 8+Math.max(0,Math.ceil(top/(4*(o.sf-(o.ldro?2:0)))))*(o.cr+4);
}
// блок: sfa строк по cw бит → cw символов по sfa бит; символ i, бит j (j=0 — старший) = бит i слова (i−j−1) mod sfa
function loraInter(rows,cw,sf,sfa){
  const out=[], sh=sf-sfa;
  for(let i=0;i<cw;i++){
    let y=0;
    for(let j=0;j<sfa;j++) y=(y<<1)|((rows[(((i-j-1)%sfa)+sfa)%sfa]>>(cw-1-i))&1);
    out.push(loraGrayInv(y)<<sh);                                  // обратный Грей, у блока с SF−2 битами — на шаг 4
  }
  return out;
}
function loraDeint(syms,off,cw,sf,sfa){
  const sh=sf-sfa, mask=(1<<sfa)-1, rows=new Array(sfa).fill(0);
  for(let i=0;i<cw;i++){
    const v=((syms[off+i]+(sh ? 1<<(sh-1) : 0))>>sh)&mask, y=loraGray(v);
    for(let j=0;j<sfa;j++) rows[(((i-j-1)%sfa)+sfa)%sfa]|=((y>>(sfa-1-j))&1)<<(cw-1-i);
  }
  return rows;
}
// o: {sf, cr 1…4, crc, ih (неявный заголовок), ldro} → символы (значения 0…2^SF−1)
function loraEncode(bytes,o){
  const sf=o.sf, w=loraWhite(bytes.length), nib=[];
  if(!o.ih){
    const L=bytes.length, a0=L>>4, a1=L&15, a2=(o.cr<<1)|(o.crc ? 1 : 0), ck=loraHdrChk(a0,a1,a2);
    nib.push(a0,a1,a2,ck>>4,ck&15);
  }
  for(let i=0;i<bytes.length;i++){ const v=bytes[i]^w[i]; nib.push(v&15,v>>4); }
  if(o.crc){ const c=loraCrc(bytes); nib.push(c&15,(c>>4)&15,(c>>8)&15,(c>>12)&15); }
  const syms=[]; let p=0;
  { const rows=[]; for(let r=0;r<sf-2;r++) rows.push(LORA_CW[4][nib[p++]||0]); syms.push(...loraInter(rows,8,sf,sf-2)); }
  const sfa=o.ldro ? sf-2 : sf;
  while(p<nib.length){
    const rows=[]; for(let r=0;r<sfa;r++) rows.push(LORA_CW[o.cr][nib[p++]||0]);
    syms.push(...loraInter(rows,o.cr+4,sf,sfa));
  }
  return syms;
}
// заголовок из первых 8 символов: {ok, len, cr, crc, nib (полубайты первого блока после заголовка)}
function loraHeader(syms,sf){
  const rows=loraDeint(syms,0,8,sf,sf-2), nib=rows.map(w=>loraHamDec(w,4)), v=nib.map(x=>x.nib);
  const len=(v[0]<<4)|v[1], cr=v[2]>>1, crc=!!(v[2]&1), ok=loraHdrChk(v[0],v[1],v[2])===((v[3]<<4)|v[4]) && cr>=1 && cr<=4 && len>0;
  return {ok, len, cr, crc, nib:v.slice(5), err:nib.reduce((a,x)=>a+(x.err===2 ? 1 : 0),0)};
}
// o: {sf, ldro, ih, len, cr, crc} (три последних — для неявного заголовка) → {ok, hdr, len, cr, crc, payload, crcOk, errs, fixed, nSym}
function loraDecode(syms,o){
  const sf=o.sf;
  if(syms.length<8) return {ok:false, nSym:8};
  let h;
  if(o.ih){ const rows=loraDeint(syms,0,8,sf,sf-2); h={ok:true, len:o.len, cr:o.cr, crc:!!o.crc, nib:rows.map(w=>loraHamDec(w,4).nib), err:0}; }
  else h=loraHeader(syms,sf);
  if(!h.ok) return {ok:false, hdr:false, nSym:8};
  const ld=!!o.ldro, nSym=loraSymCount(h.len,{sf, cr:h.cr, crc:h.crc, ih:o.ih, ldro:ld});
  if(syms.length<nSym) return {ok:false, hdr:true, len:h.len, cr:h.cr, crc:h.crc, nSym};
  const nib=h.nib.slice(0,sf-2-(o.ih ? 0 : 5)), sfa=ld ? sf-2 : sf;
  let errs=h.err, fixed=0;
  for(let p=8;p<nSym;p+=h.cr+4){
    const rows=loraDeint(syms,p,h.cr+4,sf,sfa);
    for(const w of rows){ const r=loraHamDec(w,h.cr); nib.push(r.nib); if(r.err===2) errs++; else if(r.err===1) fixed++; }
  }
  const nb=h.len+(h.crc ? 2 : 0), by=new Uint8Array(nb);
  for(let i=0;i<nb;i++) by[i]=(nib[2*i]|(nib[2*i+1]<<4))&255;
  const wh=loraWhite(h.len), payload=new Uint8Array(h.len);
  for(let i=0;i<h.len;i++) payload[i]=by[i]^wh[i];
  const crcOk=h.crc ? loraCrc(payload)===(by[h.len]|(by[h.len+1]<<8)) : null;
  return {ok:true, hdr:true, len:h.len, cr:h.cr, crc:h.crc, payload, crcOk, errs, fixed, nSym};
}
// текст нагрузки: UTF-8, управляющие знаки — точкой
function loraText(b){
  let s=''; for(const x of b) s+=String.fromCharCode(x);
  try{ s=decodeURIComponent(escape(s)); }catch(e){ s=s.replace(/[^\x20-\x7e]/g,'·'); }
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'·');
}
function loraBytes(s){ const e=unescape(encodeURIComponent(s)), b=new Uint8Array(e.length); for(let i=0;i<e.length;i++) b[i]=e.charCodeAt(i); return b; }

/* ---- синтез ---- */
// сегмент [сдвиг, направление (1 вверх, −1 вниз), длина в символах]
function loraSegs(syms,o){
  const M=1<<o.sf, sw=o.sync==null ? 0x12 : o.sync, segs=[];
  for(let i=0;i<o.pre;i++) segs.push([0,1,1]);
  segs.push([((sw>>4)&15)*8%M,1,1],[(sw&15)*8%M,1,1],[0,-1,1],[0,-1,1],[0,-1,.25]);
  for(const s of syms) segs.push([s,1,1]);
  return segs;
}
// потоковый генератор: фаза чирпа берётся из точной формулы π(w²/M − w), w = (t + сдвиг) mod M (в отсчётах BW), на стыках символов
// подстраивается до непрерывной; CFO копится отдельно, ppm растягивает время и полосу вместе (уход кварца)
function loraGenNew(segs,o){ return {segs, o, i:0, t:0, base:0, cph:0}; }
function loraGenRun(g,re,im,from,to,fs){
  const o=g.o, M=1<<o.sf, ck=1+(o.ppm||0)*1e-6, step=o.bw*ck/fs, a=o.amp==null ? 1 : o.amp, kc=2*Math.PI*(o.cfo||0)/fs, inv=o.invert ? -1 : 1;
  const ph=(sg,w)=>sg[1]*Math.PI*(w*w/M-w);
  let n=from;
  for(;n<to && g.i<g.segs.length;n++){
    const sg=g.segs[g.i], p=g.base+ph(sg,(g.t+sg[0])%M)+g.cph;
    re[n]=a*Math.cos(p); im[n]=inv*a*Math.sin(p);
    g.cph+=kc; g.t+=step;
    if(g.t>=sg[2]*M){
      const end=sg[2]*M;
      g.t-=end; g.i++;
      if(g.i<g.segs.length){ const nx=g.segs[g.i]; g.base+=ph(sg,(end+sg[0])%M)-ph(nx,nx[0]%M); }
    }
  }
  g.base%=2*Math.PI; g.cph%=2*Math.PI;
  return n-from;
}
// весь кадр сразу (тесты): pad отсчётов тишины до и после
function loraSynth(syms,o,fs,pad){
  const segs=loraSegs(syms,o), M=1<<o.sf, ck=1+(o.ppm||0)*1e-6;
  let units=0; for(const s of segs) units+=s[2]*M;
  const N=Math.ceil(units*fs/(o.bw*ck))+2, re=new Float32Array(N+2*pad), im=new Float32Array(N+2*pad);
  const g=loraGenNew(segs,o), c=loraGenRun(g,re,im,pad,pad+N,fs);
  return {re, im, len:c};
}

/* ---- приёмник ---- */
const loraWrap=(x,M)=>((x%M)+M)%M;
const loraWrapS=(x,M)=>{ x=loraWrap(x,M); return x>=M/2 ? x-M : x; };
function loraPush(n,re,im,cnt){
  if(n.zn+cnt>n.zr.length){
    const drop=Math.max(0,Math.floor(Math.min(n.zn,n.keep-n.zb)));
    if(drop>0){ n.zr.copyWithin(0,drop,n.zn); n.zi.copyWithin(0,drop,n.zn); n.zb+=drop; n.zn-=drop; }
    if(n.zn+cnt>n.zr.length){
      const cap=Math.max(2*n.zr.length,n.zn+cnt), a=new Float32Array(cap), b=new Float32Array(cap);
      a.set(n.zr.subarray(0,n.zn)); b.set(n.zi.subarray(0,n.zn)); n.zr=a; n.zi=b;
    }
  }
  n.zr.set(re.subarray(0,cnt),n.zn); n.zi.set(im.subarray(0,cnt),n.zn); n.zn+=cnt;
}
// передискретизация окном Кайзера-sinc (24 отсчёта, 128 дробных фаз): поток после ФНЧ → 2·BW, потом окна символов с дробных позиций
const LORA_IP=128, LORA_IT=24;
const LORA_ITAB=(()=>{
  const t=new Float32Array((LORA_IP+1)*LORA_IT), beta=8, i0=besselI0(beta);
  for(let p=0;p<=LORA_IP;p++){
    const f=p/LORA_IP; let sum=0;
    for(let j=0;j<LORA_IT;j++){
      const x=j-(LORA_IT/2-1)-f, r=x/(LORA_IT/2), sinc=x===0 ? 1 : Math.sin(Math.PI*x)/(Math.PI*x);
      const w=Math.abs(r)<1 ? besselI0(beta*Math.sqrt(1-r*r))/i0 : 0;
      t[p*LORA_IT+j]=sinc*w; sum+=sinc*w;
    }
    for(let j=0;j<LORA_IT;j++) t[p*LORA_IT+j]/=sum;
  }
  return t;
})();
function loraResample(n,xr,xi){                                   // n.q входных отсчётов на выходной (выход — 2·BW)
  const K=xr.length, H=LORA_IT-1, br=new Float32Array(H+K), bi=new Float32Array(H+K);
  br.set(n.hr); bi.set(n.hq); br.set(xr,H); bi.set(xi,H);
  const cap=Math.ceil(K/n.q)+2, or=new Float32Array(cap), oi=new Float32Array(cap);
  let m=0;
  for(;;){
    const i0=Math.floor(n.u), ph=Math.round((n.u-i0)*LORA_IP), x=i0-n.gb-(LORA_IT/2-1);
    if(x+LORA_IT>br.length) break;
    const o=ph*LORA_IT; let a=0, b=0;
    for(let j=0;j<LORA_IT;j++){ const c=LORA_ITAB[o+j]; a+=c*br[x+j]; b+=c*bi[x+j]; }
    or[m]=a; oi[m]=b; m++; n.u+=n.q;
  }
  n.gb+=K; n.hr=br.slice(K,K+H); n.hq=bi.slice(K,K+H);
  loraPush(n,or,oi,m);
}
// позиции окон — в отсчётах BW (дробные допустимы), в потоке 2·BW это индекс 2·pos
function loraHave(n,pos){ return 2*(pos+n.M)+LORA_IT/2+1<=n.zb+n.zn; }
// окно M отсчётов с позиции pos: де-чирп (down=false — апчирпы, true — даунчирпы) + БПФ → пик
function loraWin(n,pos,down,keep){
  const M=n.M, p0=2*pos-n.zb, wr=n.wr, wi=n.wi, zr=n.zr, zi=n.zi;
  if(p0<LORA_IT/2 || 2*(pos+M)+LORA_IT/2+1>n.zb+n.zn) return null;
  const i0=Math.floor(p0), fr=p0-i0;
  if(fr<1e-9) for(let j=0;j<M;j++){ wr[j]=zr[i0+2*j]; wi[j]=zi[i0+2*j]; }
  else for(let j=0;j<M;j++){
    const q=p0+2*j, i=Math.floor(q), o=Math.round((q-i)*LORA_IP)*LORA_IT, x=i-(LORA_IT/2-1);
    let a=0, b=0;
    for(let t=0;t<LORA_IT;t++){ const c=LORA_ITAB[o+t]; a+=c*zr[x+t]; b+=c*zi[x+t]; }
    wr[j]=a; wi[j]=b;
  }
  const re=n.re, im=n.im, ur=n.cr, ui=n.cq;
  if(down) for(let i=0;i<M;i++){ const a=wr[i], b=wi[i]; re[i]=a*ur[i]-b*ui[i]; im[i]=a*ui[i]+b*ur[i]; }
  else for(let i=0;i<M;i++){ const a=wr[i], b=wi[i]; re[i]=a*ur[i]+b*ui[i]; im[i]=b*ur[i]-a*ui[i]; }
  if(keep){ n.dr.set(re); n.dq.set(im); }
  fft(re,im);
  const pw=n.pw; let tot=0, bi=0, bp=0;
  for(let k=0;k<M;k++){ const p=re[k]*re[k]+im[k]*im[k]; pw[k]=p; tot+=p; if(p>bp){ bp=p; bi=k; } }
  const il=(bi+M-1)%M, ir=(bi+1)%M, pl=pw[il], pr=pw[ir], near=pl+bp+pr, nb=Math.max((tot-near)/(M-3),1e-30);
  // Якобсен: дробная часть пика по комплексным бинам (для чистого тона точна)
  const nr=re[il]-re[ir], ni=im[il]-im[ir], dr=2*re[bi]-re[il]-re[ir], di=2*im[bi]-im[il]-im[ir], dd=dr*dr+di*di;
  return {f:bi+(dd>0 ? (nr*dr+ni*di)/dd : 0), pk:bp, ratio:bp/nb, snr:(near-3*nb)/(M*nb)};
}
function loraDb(x){ return 10*Math.log10(Math.max(x,1e-12)); }

// ошибка границы символа по скачку фазы между половинами чирпа (до и после перескока частоты): вторая половина сдвинута на −2π·τ,
// τ — на сколько отсчётов BW окно запаздывает. Остаток пика для этого не годится: его сдвиг зависит от значения символа.
function loraPhaseStep(n,k){
  const M=n.M, L1=M-k;
  if(Math.min(L1,k)<M/8) return null;
  const th=-2*Math.PI*(k+n.binRef)/M, cr=Math.cos(th), ci=Math.sin(th), dr=n.dr, dq=n.dq;
  let pr=1, pi=0, a1r=0, a1i=0, a2r=0, a2i=0;
  for(let i=0;i<M;i++){
    const xr=dr[i]*pr-dq[i]*pi, xi=dr[i]*pi+dq[i]*pr;
    if(i<L1){ a1r+=xr; a1i+=xi; } else { a2r+=xr; a2i+=xi; }
    const q=pr*cr-pi*ci; pi=pr*ci+pi*cr; pr=q;
  }
  return -Math.atan2(a2i*a1r-a2r*a1i, a2r*a1r+a2i*a1i)/Math.PI;     // сдвиг окна τ ещё и сдвигает тон на τ бинов: фазовый скачок получается −πτ, а не −2πτ
}

IQK.loraRx={
  init(n){ n.key=''; n.recent=[]; n.frames=0; n.okc=0; n.bad=0; n.hdrBad=0; n.last=null; n.lastT=0; },
  setup(n,s){
    const P=n.p, bw=+P.bw, sf=+P.sf, M=1<<sf;
    n.bw=bw; n.sf=sf; n.M=M; n.err=s.sr<bw*.99 ? 'sample rate is below the channel width' : null;
    n.Dm=Math.max(1,Math.floor(s.sr/(2*bw))); n.fsd=s.sr/n.Dm; n.q=n.fsd/(2*bw);
    n.decim=n.Dm>1 ? {p:{M:String(n.Dm), cut:.45, tpp:'8'}} : null;
    if(n.decim) IQK.iqDecim.init(n.decim);
    n.lp=kaiserLP(n.fsd,Math.min(.75*bw,.4*n.fsd),Math.min(bw,.49*n.fsd),255);   // шире ±BW/2: край чирпа, сдвинутый CFO, не должен резаться
    n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1);
    n.hr=new Float32Array(LORA_IT-1); n.hq=new Float32Array(LORA_IT-1); n.gb=-(LORA_IT-1); n.u=LORA_IT/2;
    const ur=new Float32Array(M), ui=new Float32Array(M);
    for(let k=0;k<M;k++){ const ph=Math.PI*k*k/M-Math.PI*k; ur[k]=Math.cos(ph); ui[k]=Math.sin(ph); }
    n.cr=ur; n.cq=ui; n.re=new Float32Array(M); n.im=new Float32Array(M); n.pw=new Float32Array(M); n.wr=new Float32Array(M); n.wi=new Float32Array(M); n.dr=new Float32Array(M); n.dq=new Float32Array(M);
    n.zr=new Float32Array(M*48); n.zi=new Float32Array(M*48); n.zb=0; n.zn=0; n.keep=0;
    n.st='search'; n.pos=LORA_IT; n.run=0;
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null, text:null}; }
    const P=n.p, key=[s.sr,P.bw,P.sf].join('|');
    if(key!==n.key){ n.key=key; this.setup(n,s); }
    const out={recs:[], text:[]};
    if(n.err){ n.ui={err:n.err, sf:n.sf, bw:n.bw, frames:0, recent:[]}; return {rec:null, text:null}; }
    n.thr=Math.pow(10,(+P.thr||9)/10);
    const src=n.decim ? IQK.iqDecim.process(n.decim,{in:s}).out : s, inv=P.invert ? -1 : 1;
    for(const c of src.chunks){
      const xr=firRun(n.lp,n.lr,c.re), xi=firRun(n.lp,n.li,iqChunkIm(c));
      if(inv<0) for(let i=0;i<xi.length;i++) xi[i]=-xi[i];
      loraResample(n,xr,xi);
      this.run(n,out);
    }
    n.ui={sr:s.sr, bw:n.bw, sf:n.sf, state:n.st==='data' ? 'frame '+n.syms.length+(n.need ? ' / '+n.need : '')+' symbols' : n.st==='search' && n.run>=3 ? 'preamble' : 'searching',
      frames:n.frames, ok:n.okc, bad:n.bad, hdrBad:n.hdrBad, snr:n.snr, cfo:n.cfo, last:n.last, age:n.lastT ? Date.now()-n.lastT : null, recent:n.recent.slice(-8)};
    return {rec:out.recs.length ? out.recs : null, text:out.text.length ? out.text.join('\n') : null};
  },
  run(n,out){
    const M=n.M;
    for(;;){
      if(n.st==='search'){
        n.keep=2*(n.pos-8*M);
        const w=loraHave(n,n.pos) ? loraWin(n,n.pos,false) : null;
        if(!w) return;
        if(w.ratio>n.thr && (n.run===0 || Math.abs(loraWrapS(w.f-n.bm,M))<=2)){
          if(n.run===0){ n.bm=w.f; n.snr0=0; }
          else n.bm=loraWrap(n.bm+loraWrapS(w.f-n.bm,M)/(n.run+1),M);
          n.run++; n.snr0+=w.snr; n.pos+=M;
        } else if(n.run>=4){ n.pe=n.pos; n.st='sfd'; }
        else { n.run=0; n.pos+=M; }
      }
      else if(n.st==='sfd'){
        if(!loraHave(n,n.pe+6*M)) return;
        if(this.sfd(n)){ n.st='data'; n.syms=[]; n.need=0; n.dsnr=0; n.tr=0; }
        else { n.st='search'; n.run=0; n.pos=n.pe; }
      }
      else if(n.st==='data'){
        n.keep=2*(n.D-M);
        const w=loraHave(n,n.D) ? loraWin(n,n.D,false,true) : null;
        if(!w) return;
        const P=n.p, ih=P.hdr==='implicit', ld=loraLdro(P.ldro,n.sf,n.bw), step=n.syms.length<8 || ld ? 4 : 1;
        const raw=loraWrap(w.f-n.binRef,M), k=loraWrap(Math.round(raw/step)*step,M);
        n.dsnr+=w.snr;
        const tau=loraPhaseStep(n,k);                               // ПИ-петля по времени окна (уход тактов)
        if(tau!==null && Math.abs(tau)<.5){ const g=Math.min(1,2*Math.min(M-k,k)/M); n.tr+=.05*g*tau; n.D-=.3*g*tau; }
        n.D-=n.tr;
        n.syms.push(k); n.D+=M;
        if(n.syms.length===8){
          const o={sf:n.sf, ldro:ld, ih};
          if(ih){ o.len=Math.max(1,Math.min(255,+P.len||1)); o.cr=+(P.cr||'4/5').slice(2)-4; o.crc=P.crc!==false; n.need=loraSymCount(o.len,{sf:n.sf, cr:o.cr, crc:o.crc, ih, ldro:ld}); }
          else { const h=loraHeader(n.syms,n.sf); if(!h.ok){ n.hdrBad++; n.st='search'; n.run=0; n.pos=Math.ceil(n.D); continue; } n.need=loraSymCount(h.len,{sf:n.sf, cr:h.cr, crc:h.crc, ih, ldro:ld}); }
        }
        if(n.need && n.syms.length>=n.need){ this.done(n,ld,ih,out); n.st='search'; n.run=0; n.pos=Math.ceil(n.D); }
      }
    }
  },
  // граница кадра и сдвиг частоты по паре пиков up/down; true — найдено, n.D — начало первого символа после SFD, n.binRef — пик символа 0
  sfd(n){
    const M=n.M, pe=n.pe, base=pe-M, st=M/4, K=29, m=[];
    for(let j=0;j<K;j++){ const w=loraWin(n,base+j*st,true); m.push(w ? Math.sqrt(w.pk) : 0); }
    const mx=Math.max(...m), lo=m.slice().sort((a,b)=>a-b).slice(0,4).reduce((a,b)=>a+b,0)/4, half=lo+.5*(mx-lo);
    if(mx<=lo*1.5) return false;
    let j1=0; while(m[j1]<half) j1++;
    let j2=K-1; while(m[j2]<half) j2--;
    const L=j1>0 ? base+(j1-1+(half-m[j1-1])/(m[j1]-m[j1-1]))*st : base, R=j2<K-1 ? base+(j2+(m[j2]-half)/(m[j2]-m[j2+1]))*st : base+(K-1)*st;
    if(R-L<1.4*M || R-L>3.2*M) return false;
    const c=(L+R)/2, tsC=c-.625*M, Pg=pe+M*Math.round((c-pe)/M), wd=loraWin(n,Pg,true);
    if(!wd || wd.ratio<n.thr/2) return false;
    // грубо: bu = δ+d, bd = δ−d (d — сдвиг окна от границы символа, δ — CFO в бинах) → d с точностью до M/2, трапеция снимает неоднозначность
    const bu=n.bm, d0=loraWrap(.5*loraWrap(bu-wd.f,M),M/2);
    const cands=[d0,d0+M/2].map(d=>({d, e:Math.abs(loraWrapS(Pg-d-tsC,M))})).sort((a,b)=>a.e-b.e);
    const want=String(n.p.sync||'any').trim().toLowerCase();
    for(const {d} of cands){
      let ts=Pg-d-M*Math.round((Pg-d-tsC)/M), wu, wn, lag=0;
      // точно: окна ровно по символам — пик up (последний символ преамбулы) и пик down (первый даунчирп) расходятся на ±lag
      for(let it=0;it<3;it++){
        wu=loraWin(n,ts-3*M,false); wn=loraWin(n,ts,true);
        if(!wu || !wn) break;
        lag=loraWrapS(wu.f-wn.f,M)/2; ts-=lag;
        if(Math.abs(lag)<.02) break;
      }
      if(!wu || !wn || Math.abs(lag)>.5 || wu.ratio<n.thr/2 || wn.ratio<n.thr/2) continue;
      const ref=loraWrap(wn.f+lag,M), w1=loraWin(n,ts-2*M,false), w2=loraWin(n,ts-M,false);
      if(!w1 || !w2) continue;
      const s1=loraWrapS(w1.f-ref,M), s2=loraWrapS(w2.f-ref,M), a1=Math.round(s1/8), a2=Math.round(s2/8);
      if(Math.abs(s1-8*a1)>2 || Math.abs(s2-8*a2)>2 || a1<0 || a2<0 || a1>15 || a2>15) continue;
      const sw=(a1<<4)|a2;
      if(want!=='any' && want!=='' && parseInt(want,16)!==sw) continue;
      n.D=ts+2.25*M; n.binRef=ref; n.sw=sw;
      n.cfo=loraWrapS(ref,M)*n.bw/M; n.snr=loraDb(n.snr0/n.run);
      return true;
    }
    return false;
  },
  done(n,ld,ih,out){
    const P=n.p, o={sf:n.sf, ldro:ld, ih};
    if(ih){ o.len=Math.max(1,Math.min(255,+P.len||1)); o.cr=+(P.cr||'4/5').slice(2)-4; o.crc=P.crc!==false; }
    const r=loraDecode(n.syms,o);
    n.frames++;
    if(!r.ok){ n.bad++; return; }
    const good=r.crcOk!==false;
    if(good) n.okc++; else n.bad++;
    if(!good && P.bad===false) return;
    const text=loraText(r.payload), snr=loraDb(n.dsnr/n.syms.length);
    const rec={t:Date.now(), src:'LoRa', kind:'frame', sf:n.sf, bw:n.bw, cr:'4/'+(4+r.cr), crc:r.crc, crcOk:r.crcOk, hdr:ih ? 'implicit' : 'explicit', len:r.len, sync:n.sw,
      snr:+snr.toFixed(1), cfo:Math.round(n.cfo), errs:r.errs, fixed:r.fixed, text, hex:bytesHex(r.payload)};
    out.recs.push(rec);
    if(good) out.text.push(text);
    n.last=rec; n.lastT=Date.now();
    n.recent.push((good ? '' : '[CRC error] ')+'SF'+n.sf+' '+rec.cr+' '+r.len+' B  '+snr.toFixed(1)+' dB  '+Math.round(n.cfo)+' Hz  sync '+bytesHex(Uint8Array.of(n.sw))+'  "'+text.replace(/\n/g,'⏎').slice(0,80)+'"');
    if(n.recent.length>20) n.recent.shift();
  }};
