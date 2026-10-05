"use strict";
/* ============================ Слепой анализ неизвестного сигнала: ядра ============================
   Цепочка: IQ → Baud Estimator (скорость символов) → [CMA Equalizer] → слайсер → Sync Word Hunter (синхрослово, период, кадры)
   → Conv Code Finder (свёрточный код, Витерби) → CRC Finder (параметры CRC). Генератор Unknown Signal — тестовая передача с известными параметрами.
   Кадры — blk {d: ±1 биты, n, id}. Символы по IQ-проводу — вещественный поток на частоте символов (выход symSlicer). */

/* ---------- CRC: каталог (Rocksoft: ширина, полином, init, refin, refout, xorout, контрольная сумма "123456789") ---------- */
const BLIND_CRC=[
  ['CRC-8',8,0x07,0x00,0,0,0x00,0xF4],['CRC-8/CDMA2000',8,0x9B,0xFF,0,0,0x00,0xDA],['CRC-8/DARC',8,0x39,0x00,1,1,0x00,0x15],
  ['CRC-8/DVB-S2',8,0xD5,0x00,0,0,0x00,0xBC],['CRC-8/EBU',8,0x1D,0xFF,1,1,0x00,0x97],['CRC-8/I-CODE',8,0x1D,0xFD,0,0,0x00,0x7E],
  ['CRC-8/ITU',8,0x07,0x00,0,0,0x55,0xA1],['CRC-8/MAXIM',8,0x31,0x00,1,1,0x00,0xA1],['CRC-8/ROHC',8,0x07,0xFF,1,1,0x00,0xD0],
  ['CRC-8/WCDMA',8,0x9B,0x00,1,1,0x00,0x25],['CRC-8/SAE-J1850',8,0x1D,0xFF,0,0,0xFF,0x4B],['CRC-8/BLUETOOTH',8,0xA7,0x00,1,1,0x00,0x26],
  ['CRC-16/ARC',16,0x8005,0x0000,1,1,0x0000,0xBB3D],['CRC-16/CCITT-FALSE',16,0x1021,0xFFFF,0,0,0x0000,0x29B1],
  ['CRC-16/XMODEM',16,0x1021,0x0000,0,0,0x0000,0x31C3],['CRC-16/KERMIT',16,0x1021,0x0000,1,1,0x0000,0x2189],
  ['CRC-16/X-25',16,0x1021,0xFFFF,1,1,0xFFFF,0x906E],['CRC-16/MODBUS',16,0x8005,0xFFFF,1,1,0x0000,0x4B37],
  ['CRC-16/GENIBUS',16,0x1021,0xFFFF,0,0,0xFFFF,0xD64E],['CRC-16/DNP',16,0x3D65,0x0000,1,1,0xFFFF,0xEA82],
  ['CRC-16/USB',16,0x8005,0xFFFF,1,1,0xFFFF,0xB4C8],['CRC-16/MCRF4XX',16,0x1021,0xFFFF,1,1,0x0000,0x6F91],
  ['CRC-16/BUYPASS',16,0x8005,0x0000,0,0,0x0000,0xFEE8],['CRC-16/CDMA2000',16,0xC867,0xFFFF,0,0,0x0000,0x4C06],
  ['CRC-16/DDS-110',16,0x8005,0x800D,0,0,0x0000,0x9ECF],['CRC-16/DECT-R',16,0x0589,0x0000,0,0,0x0001,0x007E],
  ['CRC-16/DECT-X',16,0x0589,0x0000,0,0,0x0000,0x007F],['CRC-16/EN-13757',16,0x3D65,0x0000,0,0,0xFFFF,0xC2B7],
  ['CRC-16/T10-DIF',16,0x8BB7,0x0000,0,0,0x0000,0xD0DB],['CRC-16/TELEDISK',16,0xA097,0x0000,0,0,0x0000,0x0FB3],
  ['CRC-16/TMS37157',16,0x1021,0x89EC,1,1,0x0000,0x26B1],['CRC-16/ISO-14443-3-A',16,0x1021,0xC6C6,1,1,0x0000,0xBF05],
  ['CRC-16/AUG-CCITT',16,0x1021,0x1D0F,0,0,0x0000,0xE5CC],['CRC-16/GSM',16,0x1021,0x0000,0,0,0xFFFF,0xCE3C],
  ['CRC-16/LJ1200',16,0x6F63,0x0000,0,0,0x0000,0xBDF4],['CRC-16/OPENSAFETY-A',16,0x5935,0x0000,0,0,0x0000,0x5D38],
  ['CRC-16/OPENSAFETY-B',16,0x755B,0x0000,0,0,0x0000,0x20FE],['CRC-16/PROFIBUS',16,0x1DCF,0xFFFF,0,0,0xFFFF,0xA819],
  ['CRC-16/RIELLO',16,0x1021,0xB2AA,1,1,0x0000,0x63D0],['CRC-16/M17',16,0x5935,0xFFFF,0,0,0x0000,0x772B],
  ['CRC-24/OPENPGP',24,0x864CFB,0xB704CE,0,0,0x000000,0x21CF02],['CRC-24/BLE',24,0x00065B,0x555555,1,1,0x000000,0xC25A56],
  ['CRC-32',32,0x04C11DB7,0xFFFFFFFF,1,1,0xFFFFFFFF,0xCBF43926],['CRC-32/BZIP2',32,0x04C11DB7,0xFFFFFFFF,0,0,0xFFFFFFFF,0xFC891918],
  ['CRC-32C',32,0x1EDC6F41,0xFFFFFFFF,1,1,0xFFFFFFFF,0xE3069283],['CRC-32D',32,0xA833982B,0xFFFFFFFF,1,1,0xFFFFFFFF,0x87315576],
  ['CRC-32/MPEG-2',32,0x04C11DB7,0xFFFFFFFF,0,0,0x00000000,0x0376E6E7],['CRC-32/POSIX',32,0x04C11DB7,0x00000000,0,0,0xFFFFFFFF,0x765E7680],
  ['CRC-32Q',32,0x814141AB,0x00000000,0,0,0x00000000,0x3010BF7F],['CRC-32/JAMCRC',32,0x04C11DB7,0xFFFFFFFF,1,1,0x00000000,0x340BC6D9],
  ['CRC-32/XFER',32,0x000000AF,0x00000000,0,0,0x00000000,0xBD0BE338]
].map(a=>({name:a[0],w:a[1],poly:a[2],init:a[3],refin:a[4],refout:a[5],xorout:a[6],check:a[7]}));
// простые суммы: не CRC, но так тоже бывает
const BLIND_SUMS=[
  {name:'Sum-8',w:8,fn:(B,a,b)=>{ let s=0; for(let i=a;i<b;i++) s+=B[i]; return s&255; }},
  {name:'Sum-8 (two\'s complement)',w:8,fn:(B,a,b)=>{ let s=0; for(let i=a;i<b;i++) s+=B[i]; return (-s)&255; }},
  {name:'XOR-8',w:8,fn:(B,a,b)=>{ let s=0; for(let i=a;i<b;i++) s^=B[i]; return s; }},
  {name:'Sum-16',w:16,fn:(B,a,b)=>{ let s=0; for(let i=a;i<b;i++) s+=B[i]; return s&0xFFFF; }}
];
const BLIND_REV8=(()=>{ const t=new Uint8Array(256); for(let i=0;i<256;i++){ let r=0; for(let k=0;k<8;k++) r|=((i>>k)&1)<<(7-k); t[i]=r; } return t; })();
function blindRev(v,w){ let r=0; for(let i=0;i<w;i++) r=(r<<1)|((v>>>i)&1); return r>>>0; }
function blindCrcReg(B,from,to,w,poly,init,refin){
  const top=(1<<(w-1))>>>0, mask=w===32 ? 0xFFFFFFFF : ((1<<w)-1)>>>0, sh=w-8;
  let c=init>>>0;
  for(let i=from;i<to;i++){
    const b=refin ? BLIND_REV8[B[i]] : B[i];
    c=(c^((b<<sh)>>>0))>>>0;
    for(let k=0;k<8;k++) c=((((c&top) ? ((c<<1)^poly) : (c<<1)))&mask)>>>0;
  }
  return c;
}
function blindCrc(B,from,to,e){
  let c=blindCrcReg(B,from,to,e.w,e.poly,e.init,e.refin);
  if(e.refout) c=blindRev(c,e.w);
  return (c^e.xorout)>>>0;
}
function blindCrcAdvance(c,nbytes,w,poly){                       // nbytes нулевых байт через регистр
  const top=(1<<(w-1))>>>0, mask=w===32 ? 0xFFFFFFFF : ((1<<w)-1)>>>0;
  for(let k=0;k<8*nbytes;k++) c=((((c&top) ? ((c<<1)^poly) : (c<<1)))&mask)>>>0;
  return c;
}
// A·x = t над GF(2): cols[i] — столбец i (w-битное число). Возвращает x или null
function blindGf2Solve(cols,t,w){
  const rows=[];
  for(let j=0;j<w;j++){ let m=0; for(let i=0;i<w;i++) if((cols[i]>>>j)&1) m|=(1<<i); rows.push({m:m>>>0, b:(t>>>j)&1}); }
  const piv=[];
  let r=0;
  for(let c=0;c<w && r<w;c++){
    let p=-1; for(let k=r;k<w;k++) if((rows[k].m>>>c)&1){ p=k; break; }
    if(p<0) continue;
    [rows[r],rows[p]]=[rows[p],rows[r]];
    for(let k=0;k<w;k++) if(k!==r && ((rows[k].m>>>c)&1)){ rows[k].m=(rows[k].m^rows[r].m)>>>0; rows[k].b^=rows[r].b; }
    piv.push(c); r++;
  }
  for(let k=r;k<w;k++) if(rows[k].b) return null;
  let x=0; for(let k=0;k<r;k++) if(rows[k].b) x|=(1<<piv[k]);
  return x>>>0;
}

// биты кадра (Uint8Array 0/1) → байты: bitOff — сдвиг, lsb — младший бит первым
function blindBytes(bits,bitOff,lsb){
  const L=(bits.length-bitOff)>>3, B=new Uint8Array(L);
  for(let i=0;i<L;i++){
    let v=0;
    if(lsb) for(let k=7;k>=0;k--) v=(v<<1)|bits[bitOff+8*i+k];
    else for(let k=0;k<8;k++) v=(v<<1)|bits[bitOff+8*i+k];
    B[i]=v;
  }
  return B;
}
function blindHard(d){ const b=new Uint8Array(d.length); for(let i=0;i<d.length;i++) b[i]=d[i]>0 ? 1 : 0; return b; }
function blindHex(v,w){ return '0x'+(v>>>0).toString(16).toUpperCase().padStart(w>>2,'0'); }
function blindField(B,L,wb,le){                                 // последние wb байт кадра как число
  let v=0;
  if(le) for(let k=wb-1;k>=0;k--) v=v*256+B[L-wb+k]; else for(let k=0;k<wb;k++) v=v*256+B[L-wb+k];
  return v>>>0;
}

/* Поиск по каталогу: порядок бит, сдвиг (опц.), пропуск заголовка, порядок байт суммы. Лучшие — по доле кадров. */
function blindCrcCatalog(frames,opt){
  const F=frames.slice(0,16), found=[];
  const offs=opt.bitOffs ? [0,1,2,3,4,5,6,7] : [0];
  const ents=BLIND_CRC.map(e=>({e,w:e.w,run:(B,a,b)=>blindCrc(B,a,b,e),name:e.name,def:e}))
    .concat(BLIND_SUMS.map(s=>({e:null,w:s.w,run:s.fn,name:s.name,def:null})));
  for(const lsb of [0,1]) for(const off of offs){
    const BY=F.map(f=>blindBytes(f,off,lsb));
    for(let skip=0;skip<=opt.maxSkip;skip++) for(const en of ents){
      const wb=en.w>>3;
      for(const le of (wb>1 ? [0,1] : [0])){
        let ok=0, tot=0;
        for(const B of BY){
          const L=B.length; if(L<skip+wb+1) continue;
          tot++;
          if(en.run(B,skip,L-wb)===blindField(B,L,wb,le)) ok++;
        }
        if(tot>=Math.min(opt.min,F.length) && ok/F.length>=opt.ratio && ok>=3)
          found.push({name:en.name,def:en.def,w:en.w,lsb,off,skip,le,ok,tot:F.length});
      }
    }
  }
  found.sort((a,b)=>b.ok-a.ok || a.skip-b.skip || a.off-b.off || a.lsb-b.lsb);
  return found;
}
/* Неизвестный полином (8 и 16 бит) без перебора init/xorout: CRC линейна, поэтому для кадров одной длины
   crc(m0)^crc(m1) = raw(m0^m1) при любых init и xorout. Перебор полиномов по паре кадров, остальные — проверка константы. */
function blindCrcUnknownTasks(frames,maxSkip){
  const cnt=new Map();
  for(const f of frames){ const L=f.length>>3; cnt.set(L,(cnt.get(L)||0)+1); }
  let L=0,c=0; for(const [l,k] of cnt) if(k>c || (k===c && l>L)){ L=l; c=k; }
  const G=frames.filter(f=>(f.length>>3)===L).map(f=>blindBytes(f,0,0));
  if(G.length<3 || L<6) return null;
  const tasks=[];
  for(const w of [8,16]) for(const refin of [0,1]) for(let skip=0;skip<=maxSkip;skip++) if(L>=skip+(w>>3)+1) tasks.push({w,refin,skip});
  return {L,G,tasks,ti:0,poly:1,found:null,t0:0};
}
function blindCrcUnknownRun(u,budgetMs){
  const t0=Date.now();
  while(u.ti<u.tasks.length && !u.found){
    const T=u.tasks[u.ti], wb=T.w>>3, L=u.L, G=u.G, end=L-wb, D=new Uint8Array(end-T.skip);
    for(let i=0;i<D.length;i++) D[i]=G[0][T.skip+i]^G[1][T.skip+i];
    const fe=le=>blindField(G[0],L,wb,le)^blindField(G[1],L,wb,le);
    const tf=[fe(0),fe(1)], lim=T.w===8 ? 256 : 65536;
    for(;u.poly<lim;u.poly+=2){
      const R=blindCrcReg(D,0,D.length,T.w,u.poly,0,T.refin);
      const Rr=blindRev(R,T.w);
      for(let le=0;le<2;le++) for(let ro=0;ro<2;ro++){
        if((ro ? Rr : R)!==tf[le]) continue;
        // кандидат: остальные кадры — одна и та же константа K = поле ^ реg
        const Ks=new Map();
        for(const B of G){
          const r=blindCrcReg(B,T.skip,end,T.w,u.poly,0,T.refin), K=(blindField(B,L,wb,le)^(ro ? blindRev(r,T.w) : r))>>>0;
          Ks.set(K,(Ks.get(K)||0)+1);
        }
        let bk=0,bc=0; for(const [K,c] of Ks) if(c>bc){ bk=K; bc=c; }
        if(bc>=Math.max(3,Math.ceil(.6*G.length))){ u.found={w:T.w,poly:u.poly,refin:T.refin,refout:ro,le,skip:T.skip,K:bk,ok:bc,tot:G.length,L}; return true; }
      }
      if((u.poly&255)===1 && Date.now()-t0>budgetMs) return false;
    }
    u.ti++; u.poly=1;
  }
  return !!u.found;
}
// init и xorout по константе K для длины L: поле = xorout ^ [rev](A_L·init) ^ [rev]raw(m)
function blindCrcDerive(f){
  const wb=f.w>>3, nb=f.L-wb-f.skip, cols=[];
  for(let i=0;i<f.w;i++) cols.push(blindCrcAdvance((1<<i)>>>0,nb,f.w,f.poly));
  const ones=f.w===32 ? 0xFFFFFFFF : ((1<<f.w)-1)>>>0;
  let best=null;
  for(const xo of [0,ones]){
    let t=(f.K^xo)>>>0; if(f.refout) t=blindRev(t,f.w);
    const init=blindGf2Solve(cols,t,f.w);
    if(init===null) continue;
    const nice=init===0 || init===ones;
    if(!best || (nice && !best.nice)) best={init,xorout:xo,nice};
  }
  return best;
}

/* ---------- Viterbi / сверточный кодер (полиномы в обычной записи: старший бит — текущий вход, 171/133 для K=7) ---------- */
function blindConvEnc(u,polys,K){
  const out=[]; let reg=0;
  const n=u.length+K-1;
  for(let i=0;i<n;i++){
    const b=i<u.length ? u[i] : 0;
    reg=(b<<(K-1))|(reg>>1);
    for(const p of polys){ let v=reg&p; v^=v>>16; v^=v>>8; v^=v>>4; v^=v>>2; v^=v>>1; out.push(v&1); }
  }
  return out;
}
function blindViterbi(x,o,polys,K,tail,maxSteps){
  const n=polys.length, S=1<<(K-1), avail=Math.floor((x.length-o)/n);
  // конец сообщения известен с точностью до нескольких шагов: считаем с запасом и берём то место, где путь с нулевым конечным состоянием дешевле всего
  const steps=Math.min(avail, maxSteps>=1e8 ? avail : (maxSteps||1e9)+(tail ? 16 : 0));
  if(steps<=K) return null;
  const par=p=>{ let v=p; v^=v>>16; v^=v>>8; v^=v>>4; v^=v>>2; v^=v>>1; return v&1; };
  const out=new Uint8Array(S*2*n);                                // для (state,u): выходные биты
  for(let s=0;s<S;s++) for(let b=0;b<2;b++){
    const reg=(b<<(K-1))|s;
    for(let j=0;j<n;j++){ let v=reg&polys[j]; out[(s*2+b)*n+j]=par(v); }
  }
  let m=new Int32Array(S).fill(1e9), m2=new Int32Array(S);
  m[0]=0;
  const dec=new Uint8Array(steps*S), from=new Uint16Array(steps*S), m0=new Int32Array(steps+1);
  for(let t=0;t<steps;t++){
    m2.fill(1e9);
    for(let s=0;s<S;s++){
      const base=m[s]; if(base>=1e9) continue;
      for(let b=0;b<2;b++){
        let d=0; const q=(s*2+b)*n;
        for(let j=0;j<n;j++) d+=out[q+j]^x[o+t*n+j];
        const ns=((b<<(K-1))|s)>>1, v=base+d;
        if(v<m2[ns]){ m2[ns]=v; dec[t*S+ns]=b; from[t*S+ns]=s; }
      }
    }
    const tm=m; m=m2; m2=tm; m0[t+1]=m[0];
  }
  let end=steps, bs=0;
  if(tail){
    const lo=Math.max(K,(maxSteps>=1e8 || !maxSteps ? 1 : maxSteps-16));
    // до конца сообщения ошибки копятся медленно (шум), после — со скоростью ~0.25 бит на бит (случайные данные): минимум m0[t] − g·t
    const g=.12*n; let bm=1e18; for(let t=lo;t<=steps;t++){ const v=m0[t]-g*t; if(v<=bm){ bm=v; end=t; } }
    bs=0;
  } else { for(let s=1;s<S;s++) if(m[s]<m[bs]) bs=s; }
  const u=new Uint8Array(end);
  let s=bs;
  for(let t=end-1;t>=0;t--){ u[t]=dec[t*S+s]; s=from[t*S+s]; }
  const metric=tail ? m0[end] : m[bs];
  return {bits:tail ? u.slice(0,Math.max(0,end-(K-1))) : u, metric, steps:end, frac:metric/(end*n)};
}

/* ---------- поиск свёрточного кода по проверочному соотношению ----------
   Для кода 1/n с полиномами g_i потоки c_i = g_i·u подчиняются g_j·c_i = g_i·c_j при любом u, поэтому проверка не знает данных.
   Перебор пар по маскам (бит i — коэффициент при D^i), сумма предвычисляется: s = P_b[A] ^ P_a[B]. Минимальная пара (gcd = 1).
   Инверсия одного из выходов даёт постоянный синдром 1 — «согласованность» = доля большинства. */
function blindGf2Gcd(a,b){
  const bl=v=>32-Math.clz32(v);
  while(b){ while(a && bl(a)>=bl(b)) a^=b<<(bl(a)-bl(b)); const t=a; a=b; b=t; }
  return a;
}
function blindConvPair(A,B,Kmax,thr){                            // A, B — по кадрам потоки Uint8Array. Возвращает список {a,b,K,cons}
  const k0=Kmax-1, pos=[];
  const flatA=[], flatB=[]; let g=0; const starts=[];
  for(let f=0;f<A.length;f++){ starts.push(g); for(let k=0;k<Math.min(A[f].length,B[f].length);k++){ flatA.push(A[f][k]); flatB.push(B[f][k]); g++; } }
  const lens=A.map((a,f)=>Math.min(a.length,B[f].length));
  const maxL=Math.max(...lens,0);
  const grp=[];
  for(let k=k0;k<maxL && pos.length<1700;k++) for(let f=0;f<A.length && pos.length<1700;f++) if(k<lens[f]){ pos.push(starts[f]+k); grp.push(k); }
  if(pos.length<48) return [];
  const FA=Uint8Array.from(flatA), FB=Uint8Array.from(flatB), P=pos.length, M=1<<Kmax;
  const taps=[]; for(let m=0;m<M;m++){ const t=[]; for(let i=0;i<Kmax;i++) if((m>>i)&1) t.push(i); taps.push(t); }
  const PA=new Array(M), PB=new Array(M);                         // PA[m][r] = ⊕ A[pos[r]-i], i в маске m
  for(let m=1;m<M;m++){
    const ta=new Uint8Array(P), tb=new Uint8Array(P), t=taps[m];
    for(let r=0;r<P;r++){ let sa=0, sb=0; const p=pos[r]; for(let q=0;q<t.length;q++){ sa^=FA[p-t[q]]; sb^=FB[p-t[q]]; } ta[r]=sa; tb[r]=sb; }
    PA[m]=ta; PB[m]=tb;
  }
  const res=[], WA=new Uint32Array(M), WB=new Uint32Array(M);   // первые 32 синдрома, упакованные в слово — быстрый отсев
  for(let m=1;m<M;m++){ let x=0,y=0; for(let r=0;r<32;r++){ x|=PA[m][r]<<r; y|=PB[m][r]<<r; } WA[m]=x>>>0; WB[m]=y>>>0; }
  for(let a=1;a<M;a++) for(let b=1;b<M;b++){
    if(a===b) continue;
    const o1=popcnt32((WB[a]^WA[b])>>>0);
    if(Math.min(o1,32-o1)>8) continue;
    const pa=PB[a], pb=PA[b];                                      // s = (b⊛A) ^ (a⊛B)
    // согласованность по префиксу кадра: сообщение кончается там, где накопленное «согласие минус случайное» перестаёт расти (CUSUM)
    let n1=0, tot=0, S=0, bestS=-1, bend=0, bn1=0, btot=0;
    for(let i=0;i<P;i++){
      n1+=pa[i]^pb[i]; tot++;
      if(i===P-1 || grp[i+1]!==grp[i]){
        const sc=Math.max(n1,tot-n1)-tot/2;
        if(tot>=40 && sc>bestS){ bestS=sc; bend=grp[i]+1; bn1=n1; btot=tot; }
      }
    }
    if(btot<40){ bn1=n1; btot=tot; bend=grp[P-1]+1; }
    const cons=Math.max(bn1,btot-bn1)/btot;
    if(cons<thr) continue;
    if(blindGf2Gcd(a,b)!==1) continue;
    const K=32-Math.clz32(a|b);
    if(res.length<2000) res.push({a,b,K,cons,S:bestS,end:bend>=grp[P-1]+1 ? 1e9 : bend,inv:bn1>btot/2});
  }
  return res;
}
// поиск по шагам: один шаг — одна пара (скорость, фаза); так воркер не стоит на весь перебор сразу
function blindConvStart(frames,opt){
  let ones=0,tot=0; for(const f of frames){ for(let i=0;i<f.length;i++) ones+=f[i]; tot+=f.length; }
  if(tot<200) return {err:'few bits'};
  if(ones/tot<.15 || ones/tot>.85) return {err:'data too regular (ones '+Math.round(100*ones/tot)+'%)'};
  const tasks=[]; for(const n of opt.rates) for(let o=0;o<n;o++) tasks.push({n,o});
  return {fr:frames.slice(0,8),opt,tasks,ti:0,cands:[]};
}
function blindConvStep(st){                                      // true — перебор закончен
  const {n,o}=st.tasks[st.ti++], opt=st.opt;
  const S=[]; for(let j=0;j<n;j++) S.push(st.fr.map(f=>{ const L=Math.floor((f.length-o)/n), s=new Uint8Array(L); for(let k=0;k<L;k++) s[k]=f[o+k*n+j]; return s; }));
  const pairs=[];
  for(let j=1;j<n;j++){
    // настоящая пара согласуется на всём сообщении (большой накопленный избыток S); ложная — только на постоянных заголовках.
    // Кратные полиномы дают тот же S, поэтому берётся наименьшая длина K среди близких к максимуму.
    let r=blindConvPair(S[0],S[j],opt.Kmax,opt.thr);
    const smax=Math.max(0,...r.map(x=>x.S));
    r=r.filter(x=>x.S>=.9*smax).sort((x,y)=>x.K-y.K || y.S-x.S);
    pairs.push(r);
  }
  if(!pairs.some(p=>!p.length)){
    if(n===2){ const r=pairs[0][0]; st.cands.push({n,o,polys:[r.a,r.b],K:r.K,cons:r.cons,S:r.S,end:r.end}); }
    else {                                                        // n=3: общий первый полином
      let c=null;
      for(const p1 of pairs[0]) for(const p2 of pairs[1]) if(p1.a===p2.a){
        const K=Math.max(p1.K,p2.K);
        if(!c || K<c.K) c={n,o,polys:[p1.a,p1.b,p2.b],K,cons:Math.min(p1.cons,p2.cons),S:Math.min(p1.S,p2.S),end:Math.min(p1.end,p2.end)};
      }
      if(c) st.cands.push(c);
    }
  }
  return st.ti>=st.tasks.length;
}
function blindConvFinish(st){
  if(!st.cands.length) return null;
  const rev=(m,K)=>{ let r=0; for(let i=0;i<K;i++) if((m>>i)&1) r|=1<<(K-1-i); return r; };
  // неверная фаза тоже даёт согласованную пару, но с K на единицу больше — выигрывает наименьшее K
  const smax=Math.max(...st.cands.map(c=>c.S)), top=st.cands.filter(c=>c.S>=.9*smax).sort((x,y)=>x.K-y.K || y.S-x.S)[0];
  return {n:top.n,o:top.o,K:top.K,cons:top.cons,end:top.end,polys:top.polys.map(m=>rev(m,top.K))};
}
function blindConvFind(frames,opt){                              // всё сразу (для тестов)
  const st=blindConvStart(frames,opt); if(st.err) return st;
  while(!blindConvStep(st));
  return blindConvFinish(st);
}

/* ============================ Baud Estimator ============================
   Признаки на частоте fd = sr/D: огибающая, её скачки, скачки частоты, скачки комплексного отсчёта. Скачки происходят на границах символов,
   поэтому у спектра признака есть линия на частоте символов (у случайных данных NRZ линии на бод нет, нужны именно скачки).
   Периодограммы усредняются, пик ищется в [min, max], гармоники сводятся к основной. */
const BLIND_FEATS=['envelope','envelope edges','frequency edges','sample edges'];
IQK.blindBaud={
  init(n){ n.key=''; n.baud=0; n.est=0; n.snr=0; n.ui=null; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {baud:n.baud>0 ? n.baud : null,conf:n.snr,sps:0,text:''}; }
    const sr=s.sr, mn=Math.max(10,n.p.min), mx=Math.max(mn*2,Math.min(n.p.max,sr/2.2));
    const key=sr+'|'+mn+'|'+mx+'|'+n.p.avg;
    if(key!==n.key){
      n.key=key; n.D=Math.max(1,Math.floor(sr/(8*mx))); n.fd=sr/n.D;
      n.N=Math.max(2048,Math.min(32768,pow2ge(Math.ceil(n.fd/(mn/4)))));
      n.F=BLIND_FEATS.map(()=>({buf:new Float32Array(n.N), w:0, since:0, acc:new Float64Array(n.N>>1), cnt:0}));
      n.win=window_('hann',n.N); n.zr=new Float64Array(n.N>>1); n.zi=new Float64Array(n.N>>1); n.or=new Float64Array(n.N>>1); n.oi=new Float64Array(n.N>>1);
      n.tmp=new Float32Array(n.N);
      n.ar=0; n.ai=0; n.k=0; n.pr=0; n.pi=0; n.pp=0; n.pdp=0; n.have=0; n.cplx=false; n.upd=false; n.res=null;
    }
    const D=n.D, N=n.N, hop=N>>1, F=n.F;
    for(const c of s.chunks){
      const xr=c.re, xi=c.im; if(xi) n.cplx=true;
      for(let i=0;i<xr.length;i++){
        n.ar+=xr[i]; if(xi) n.ai+=xi[i];
        if(++n.k<D) continue;
        const re=n.ar/D, im=n.ai/D; n.ar=0; n.ai=0; n.k=0;
        const p=re*re+im*im;
        if(n.have>=2){
          const cr=re*n.pr+im*n.pi, ci=im*n.pr-re*n.pi, dp=Math.atan2(ci,cr);
          let dd=dp-n.pdp; if(dd>Math.PI) dd-=2*Math.PI; else if(dd<-Math.PI) dd+=2*Math.PI;
          const v=[p, Math.abs(p-n.pp), n.cplx ? Math.abs(dd) : 0, (re-n.pr)*(re-n.pr)+(im-n.pi)*(im-n.pi)];
          for(let f=0;f<4;f++){ const q=F[f]; q.buf[q.w&(N-1)]=v[f]; q.w++; q.since++; }
          n.pdp=dp;
        } else if(n.have===1){ n.pdp=Math.atan2(im*n.pr-re*n.pi, re*n.pr+im*n.pi); n.have=2; }
        else n.have=1;
        n.pr=re; n.pi=im; n.pp=p;
      }
    }
    const avg=Math.max(2,n.p.avg|0);
    for(let f=0;f<4;f++){
      const q=F[f];
      if(f===2 && !n.cplx) continue;
      while(q.since>=hop && q.w>=N){
        q.since-=hop;
        const x=n.tmp; let m=0;
        for(let i=0;i<N;i++){ x[i]=q.buf[(q.w-q.since-N+i)&(N-1)]; m+=x[i]; }
        m/=N; for(let i=0;i<N;i++) x[i]=(x[i]-m)*n.win[i];
        rfft(x,n.zr,n.zi,n.or,n.oi);
        const a=1/Math.min(++q.cnt,avg);
        for(let k=0;k<hop;k++) q.acc[k]+=a*((n.or[k]*n.or[k]+n.oi[k]*n.oi[k])-q.acc[k]);
        n.upd=true;
      }
    }
    if(n.upd){
      n.upd=false;
      const res=n.fd/N, k0=Math.max(2,Math.ceil(mn/res)), k1=Math.min(hop-3,Math.floor(mx/res));
      let best=null; const cands=[];
      if(k1>k0+4) for(let f=0;f<4;f++){
        const q=F[f]; if(q.cnt<3 || (f===2 && !n.cplx)) continue;
        const P=q.acc, sorted=Float64Array.from(P.subarray(k0,k1+1)).sort(), noise=sorted[sorted.length>>1]+1e-30;
        let k=k0; for(let i=k0;i<=k1;i++) if(P[i]>P[k]) k=i;
        for(const m of [3,2]){                                      // линия на f0/m, не слабее −3 дБ от главной, — основная частота (у скачков вторая гармоника бывает сильнее первой)
          const kk=Math.round(k/m); if(kk-2<k0) continue;
          let kb=kk; for(let i=kk-2;i<=kk+2;i++) if(P[i]>P[kb]) kb=i;
          if(P[kb]>noise*10 && P[kb]>.5*P[k]){ k=kb; break; }
        }
        const lm=Math.log(P[k-1]+1e-30), l0=Math.log(P[k]+1e-30), lp=Math.log(P[k+1]+1e-30), den=lm-2*l0+lp;
        const d=den<0 ? clamp(.5*(lm-lp)/den,-.5,.5) : 0;
        cands.push({baud:(k+d)*res, snr:10*Math.log10(P[k]/noise), f, res});
      }
      for(const c of cands){                                        // признаки голосуют: совпавшая частота (±2%) прибавляет очки
        c.sup=cands.filter(o=>o!==c && o.snr>=n.p.thr && Math.abs(o.baud-c.baud)<.02*c.baud).length;
        c.score=c.snr+4*c.sup;
        if(!best || c.score>best.score) best=c;
      }
      n.res=best;
      if(best && best.snr>=n.p.thr){
        n.est=n.est && Math.abs(best.baud-n.est)/n.est<.02 ? .7*n.est+.3*best.baud : best.baud;
        if(!n.baud || Math.abs(n.est-n.baud)/n.baud>.003) n.baud=n.est;   // выход держится: мелкий дрейф оценки не должен перезапускать слайсер и фильтр после него
        n.snr=best.snr;
      } else if(best) n.snr=best.snr;
    }
    const lock=n.res && n.res.snr>=n.p.thr;
    n.ui={sr, baud:n.baud, snr:n.snr, lock, feat:n.res ? BLIND_FEATS[n.res.f] : '', fd:n.fd, res:n.res ? n.res.res : n.fd/n.N, found:n.baud>0};
    const text=n.baud>0 ? (lock ? '' : '(last) ')+n.baud.toFixed(1)+' Bd · '+(sr/n.baud).toFixed(2)+' samples per symbol · peak '+n.snr.toFixed(1)+' dB ('+(n.ui.feat||'—')+')'
                        : 'no clear symbol rate yet'+(n.res ? ' · best peak '+n.res.snr.toFixed(1)+' dB at '+n.res.baud.toFixed(0)+' Bd' : '');
    n.ui.text=text;
    // пока скорость не найдена, выход пуст: провод на baud слайсера/фильтра тогда не трогает их значение
    return {baud:n.baud>0 ? n.baud : null, conf:n.snr, sps:n.baud>0 ? sr/n.baud : null, text};
  }};

/* ============================ CMA Equalizer ============================
   Слепой эквалайзер по постоянному модулю (ЧМ, ФМ, GMSK, QPSK без формы): y = Σ w·x, w ← w − μ·y(|y|²−1)·x*.
   Многолучёвость портит модуль огибающей — CMA возвращает его, не зная данных. Вход нормируется медленной АРУ. */
IQK.blindEq={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null,cost:n.cost||0}; }
    const T=Math.max(3,(n.p.taps|0)|1);
    const key=s.sr+'|'+T;
    if(key!==n.key){
      n.key=key; n.wr=new Float64Array(T); n.wi=new Float64Array(T); n.wr[T>>1]=1;
      n.dr=new Float64Array(2*T); n.di=new Float64Array(2*T); n.pos=0; n.pw=1; n.g=1; n.cnt=0; n.c0=0; n.c1=0; n.cost=0;
    }
    const out=iqStream(n,'out',s.sr,s.fc), wr=n.wr, wi=n.wi, dr=n.dr, di=n.di, mu=n.p.mu/T, freeze=!!n.p.freeze, ag=1/Math.max(64,s.sr*.02);
    let pos=n.pos, pw=n.pw, g=n.g, cnt=n.cnt, c0=n.c0, c1=n.c1;
    for(const c of s.chunks){
      const xr=c.re, xi=c.im, K=xr.length;
      if(!xi){ iqPush(out,xr.slice(),null,c.tag); continue; }
      const yr=new Float32Array(K), yi=new Float32Array(K);
      for(let i=0;i<K;i++){
        const ar=xr[i], ai=xi[i];
        pw+=(ar*ar+ai*ai-pw)*ag;
        if((++cnt&31)===0) g=1/Math.sqrt(pw+1e-20);
        const br=ar*g, bi=ai*g;
        pos=pos===0 ? T-1 : pos-1;                                  // двойной буфер: окно — dr[pos..pos+T)
        dr[pos]=dr[pos+T]=br; di[pos]=di[pos+T]=bi;
        let sr_=0, si_=0;
        for(let k=0;k<T;k++){ const ur=dr[pos+k], ui=di[pos+k]; sr_+=wr[k]*ur-wi[k]*ui; si_+=wr[k]*ui+wi[k]*ur; }
        const p=sr_*sr_+si_*si_, e=p-1;
        c0+=((br*br+bi*bi-1)*(br*br+bi*bi-1)-c0)*.0005; c1+=(e*e-c1)*.0005;
        if(!freeze){
          const er=sr_*e, ei=si_*e;                                // e·y, ошибка комплексная
          const lim=4; const ee=Math.hypot(er,ei), sc=ee>lim ? lim/ee : 1;
          for(let k=0;k<T;k++){ const ur=dr[pos+k], ui=di[pos+k]; wr[k]-=mu*sc*(er*ur+ei*ui); wi[k]-=mu*sc*(ei*ur-er*ui); }
        }
        yr[i]=sr_; yi[i]=si_;
      }
      iqPush(out,yr,yi,c.tag);
    }
    n.pos=pos; n.pw=pw; n.g=g; n.cnt=cnt; n.c0=c0; n.c1=c1; n.cost=c1;
    n.ui={taps:T, before:c0, after:c1, sr:s.sr};
    return {out, cost:c1};
  }};

/* ============================ Sync Word Hunter ============================
   Вход — символы на частоте символов (вещественный поток, например выход Symbol Slicer). Биты копятся в окне; слова длиной len
   считаются все; синхрослово — слово, которое повторяется через одно и то же расстояние. Найденное слово режет кадры (blk). */
function blindDib(z){ return z>2 ? 1 : z>0 ? 0 : z>-2 ? 2 : 3; }     // как symDib
const BLIND_CAP=1<<17, BLIND_MASK=BLIND_CAP-1;
IQK.syncHunt={
  init(n){ n.key=''; n.ring=new Uint8Array(BLIND_CAP); n.w=0; n.mu=0; n.hasMu=false; n.lastA=0; n.word=null; n.period=0; n.hits=0; n.reg=0;
    n.sf=0; n.until=0; n.pend=[]; n.outQ=[]; n.fid=0; n.frame=null; n.total=0; n.cand=[]; n.ui=null; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {blk:n.frame, word:n.wordHex||'', period:n.period, hits:n.hits, text:''}; }
    const L=clamp(n.p.len|0,8,32), lv=+n.p.levels, R=n.ring;
    if(n.key!==L+'|'+lv+'|'+n.p.word){ n.key=L+'|'+lv+'|'+n.p.word; n.word=null; n.wordHex=''; n.period=0; n.hits=0; n.sf=n.w; n.pend=[]; n.outQ=[]; n.lastA=n.w; n.manual=false; }
    // биты
    for(const c of s.chunks){
      const z=c.re;
      for(let i=0;i<z.length;i++){
        const v=z[i];
        if(!n.hasMu){ n.mu=v; n.hasMu=true; }
        n.mu+=(v-n.mu)*.002;
        if(lv===2){ R[n.w&BLIND_MASK]=v>n.mu ? 1 : 0; n.w++; }
        else { const d=blindDib(v-n.mu); R[n.w&BLIND_MASK]=d>>1; R[(n.w+1)&BLIND_MASK]=d&1; n.w+=2; }
      }
    }
    const w=n.w, depth=Math.min(+n.p.depth,BLIND_CAP-64);
    // ручное слово
    const man=String(n.p.word||'').replace(/[^0-9a-fA-F]/g,'');
    if(man && !n.manual){
      const v=parseInt(man.slice(0,8),16)>>>0, Lw=Math.min(32,man.length*4);
      n.word=Lw===32 ? v : (v&((1<<Lw)-1))>>>0; n.wL=Lw; n.wordHex=man.slice(0,8).toUpperCase(); n.manual=true;
      if(n.p.flen>0) n.period=Lw+(n.p.flen|0);
      n.sf=Math.max(w-depth,0);
    }
    // анализ
    if(!man && w-n.lastA>=Math.max(1024,depth>>2) && w>=Math.min(depth,4096)){
      n.lastA=w;
      const r=blindSyncAnalyze(R,w,Math.min(depth,w),L,n.p.minHits|0);
      n.cand=r.list;
      const same=n.word!==null && n.period ? r.list.find(c=>c.key===n.word && c.wl===n.wL) : null;
      if(same){ n.hits=same.hits; n.period=same.period||n.period; n.reg=same.reg; }          // захваченное слово ещё в окне — остаётся
      else if(r.best){
        n.word=r.best.key; n.wL=r.best.wl; n.wordHex=r.best.key.toString(16).toUpperCase().padStart(Math.ceil(r.best.wl/4),'0');
        n.period=r.best.period; n.hits=r.best.hits; n.reg=r.best.reg;
        n.sf=Math.max(w-depth,0); n.pend=[]; n.outQ=[]; n.until=0;                         // новое слово: кадры окна режутся заново
      }
    }
    // кадры по найденному слову
    const wl=n.wL||L, flen=n.p.flen>0 ? n.p.flen|0 : (n.period>wl ? n.period-wl : 0);
    if(n.word!==null && flen>0){
      const Lw=n.wL, tol=n.p.tol|0, keyMask=Lw===32 ? 0xFFFFFFFF : (1<<Lw)-1;
      const from=Math.max(n.sf,w-BLIND_CAP+64,Lw-1);
      let e=from;
      for(;e<w;e++){
        let key=0; for(let j=Lw-1;j>=0;j--) key=(key<<1)|R[(e-j)&BLIND_MASK];
        key=(key&keyMask)>>>0;
        if(e<n.until) continue;
        let x=(key^n.word)>>>0, pc=0; while(x){ pc+=x&1; x>>>=1; }
        if(pc<=tol){ n.pend.push({e,errs:pc}); n.until=e+flen; }
      }
      n.sf=e;
      while(n.pend.length && n.pend[0].e+flen<w){
        const m=n.pend.shift();
        if(m.e+flen<w-BLIND_CAP+64) continue;
        const d=new Float32Array(flen); for(let j=0;j<flen;j++) d[j]=R[(m.e+1+j)&BLIND_MASK] ? 1 : -1;
        n.outQ.push({d,n:flen,id:++n.fid,word:n.wordHex,errs:m.errs,t:m.e});
        n.total++;
        if(n.outQ.length>64) n.outQ.shift();
      }
    }
    if(n.outQ.length) n.frame=n.outQ.shift();
    const bps=lv===2 ? 1 : 2;
    n.ui={bits:w, word:n.wordHex, period:n.period, perSym:n.period/bps, hits:n.hits, reg:n.reg, frames:n.total, L, manual:n.manual, cand:(n.cand||[]).slice(0,3)};
    const text=n.word!==null
      ? 'sync '+n.wordHex+' ('+n.wL+' bits)'+(n.period ? ' · every '+n.period+' bits'+(lv===4 ? ' ('+n.period/2+' symbols)' : '')+' · frame '+(n.period-n.wL)+' bits after the word' : '')+' · '+n.hits+' hits · '+n.total+' frames'
      : 'collecting bits… '+w+(n.cand && n.cand.length ? ' · best repeat '+n.cand[0].key.toString(16).toUpperCase()+' ×'+n.cand[0].hits : '');
    n.ui.text=text;
    return {blk:n.frame, word:n.wordHex||'', period:n.period, hits:n.hits, text};
  }};
// все слова из len бит окна depth: повторяющиеся и регулярные (одно и то же расстояние) — кандидаты в синхрослово.
// Слово расширяется до общего участка всех повторов (преамбула + слово + постоянный заголовок); синхрослово — участок после преамбулы
// (чередующиеся биты, кратно байту). Из нескольких участков берётся тот, что с преамбулой, иначе самый длинный.
function blindSyncAnalyze(R,w,depth,L,minHits){
  const mask=L===32 ? 0xFFFFFFFF : (1<<L)-1, start=w-depth, cnt=new Map();
  let key=0;
  for(let i=start;i<w;i++){
    key=((key<<1)|R[i&BLIND_MASK])>>>0;
    if(i-start>=L-1) { const k=(key&mask)>>>0; cnt.set(k,(cnt.get(k)||0)+1); }
  }
  const trivial=k=>{ // нули, единицы и чередование — это преамбула или простой
    let tr=0; for(let j=1;j<L;j++) if(((k>>>j)&1)!==((k>>>(j-1))&1)) tr++;
    return tr<=3 || tr>=L-3;
  };
  const top=[...cnt].filter(([k,c])=>c>=minHits && !trivial(k)).sort((a,b)=>b[1]-a[1]).slice(0,800);
  if(!top.length) return {best:null,list:[]};
  const want=new Map(top.map(([k])=>[k,[]]));
  key=0;
  for(let i=start;i<w;i++){
    key=((key<<1)|R[i&BLIND_MASK])>>>0;
    if(i-start>=L-1){ const k=(key&mask)>>>0, a=want.get(k); if(a) a.push(i); }
  }
  const list=[];
  for(const [k,pos] of want){
    const dif=new Map();
    for(let i=1;i<pos.length;i++){ const d=pos[i]-pos[i-1]; if(d>=L) dif.set(d,(dif.get(d)||0)+1); }
    let bd=0,bc=0; for(const [d,c] of dif) if(c>bc || (c===bc && d<bd)){ bd=d; bc=c; }
    // кратные расстояния (потерянный кадр) тоже считаются
    let ok=0; for(let i=1;i<pos.length;i++){ const d=pos[i]-pos[i-1]; if(bd && d%bd===0) ok++; }
    const reg=pos.length>1 ? ok/(pos.length-1) : 0;
    if(reg<.6 || pos.length<minHits) continue;
    // общий участок вокруг окна
    const agree=off=>{ let ones=0,tot=0; for(const p of pos){ const q=p+off; if(q<start || q>=w) continue; ones+=R[q&BLIND_MASK]; tot++; } return tot>=.9*pos.length && Math.max(ones,tot-ones)>=.9*tot; };
    let l=0; while(l<256 && agree(-(L-1)-1-l)) l++;
    let r=0; while(r<256 && agree(1+r)) r++;
    list.push({key:k,pos,hits:pos.length,period:bd,reg,l,r,run:L+l+r,rs:((pos[0]-(L-1)-l)%bd+bd)%bd,score:pos.length*reg*reg});
  }
  if(!list.length) return {best:null,list:[]};
  const hmax=Math.max(...list.map(c=>c.hits));
  // участки: одинаковый период и положение начала; редкие совпадения (случайные биты вокруг) в расчёт не идут
  const runs=new Map();
  for(const c of list){ if(c.hits<.6*hmax) continue; const id=c.period+'|'+c.rs; const g=runs.get(id); if(!g || c.run>g.run || (c.run===g.run && c.score>g.score)) runs.set(id,c); }
  const cons=c=>{                                                 // биты общего участка по большинству повторов
    const bits=[]; for(let off=-(L-1)-c.l;off<=c.r;off++){ let ones=0,tot=0; for(const p of c.pos){ const q=p+off; if(q<start || q>=w) continue; ones+=R[q&BLIND_MASK]; tot++; } bits.push(ones*2>tot ? 1 : 0); }
    return bits;
  };
  const cand=[];
  for(const c of runs.values()){
    const bits=cons(c); let a=0; while(a+1<bits.length && bits[a]!==bits[a+1]) a++;   // чередующийся префикс — преамбула
    const strip=a>=16 ? Math.floor(a/8)*8 : 0, wl=Math.min(L,bits.length-strip);
    if(wl<Math.min(L,16)) continue;
    let k2=0; for(let j=0;j<wl;j++) k2=((k2<<1)|bits[strip+j])>>>0;
    cand.push({key:k2,wl,hits:c.hits,period:c.period,reg:c.reg,score:c.score,pre:strip>0,run:c.run,strip});
  }
  if(!cand.length) return {best:null,list:list.sort((a,b)=>b.score-a.score)};
  cand.sort((a,b)=>(b.pre-a.pre) || (b.run-a.run) || (b.score-a.score));
  return {best:cand[0],list:cand};
}

/* ============================ CRC Finder ============================ */
IQK.crcFind={
  init(n){ n.frames=[]; n.res=null; n.last=0; n.u=null; n.derived=null; n.frame=null; n.ok=0; n.seen=0; n.good=0; n.goodTotal=0; n.fid=-1; n.text=''; n.cs=null; n.okey=''; },
  process(n,I){
    const b=I.blk;
    n.newFrame=null;
    if(b && b.d && b.id!==n.fid){
      n.fid=b.id;
      const bits=blindHard(b.d);
      if(bits.length>=24){
        n.frames.push(bits); if(n.frames.length>(n.p.keep|0)) n.frames.shift();
        n.seen++; n.newFrame=bits;
      }
    }
    const need=Math.max(3,n.p.min|0), tailMax=n.p.tail|0;
    const opt={min:need, ratio:n.p.ratio, maxSkip:n.p.maxSkip|0, bitOffs:!!n.p.bitOffs};
    const okey=JSON.stringify(opt)+'|'+tailMax+'|'+n.p.unknown;
    if(n.okey!==okey){ n.okey=okey; n.res=null; n.u=null; n.cs=null; n.derived=null; n.last=0; n.good=0; n.goodTotal=0; n.ok=0; }
    if(!n.res && !n.cs && !n.u && n.frames.length>=need && n.frames.length>=n.last+(n.last ? 4 : 0)){
      n.last=n.frames.length; n.cs={t:0,fr:n.frames.slice(0,16)};
    }
    // каталог: хвост после суммы (пауза, преамбула следующего кадра) перебирается по одному значению за такт
    if(!n.res && n.cs){
      const t=n.cs.t++, fr=t ? n.cs.fr.map(f=>f.slice(0,Math.max(0,f.length-8*t))) : n.cs.fr;
      const cat=blindCrcCatalog(fr,opt);
      if(cat.length){ cat.forEach(c=>c.tail=t); n.res={kind:'catalog',list:cat,best:cat[0]}; n.cs=null; }
      else if(n.cs.t>tailMax){ n.cs=null; if(n.p.unknown) n.u=blindCrcUnknownTasks(n.frames,opt.maxSkip); else n.nocat=true; }
    }
    if(!n.res && n.u && !n.u.found && n.u.ti<n.u.tasks.length) blindCrcUnknownRun(n.u,6);
    if(!n.res && n.u && n.u.found){ n.derived=blindCrcDerive(n.u.found); n.u.found.tail=0; n.res={kind:'unknown',best:n.u.found,derived:n.derived}; }
    if(!n.res && n.u && n.u.ti>=n.u.tasks.length && !n.u.found) n.u.done=true;
    // кадры без суммы
    if(n.res && n.newFrame){
      const r=n.res.best, cat=n.res.kind==='catalog', t=r.tail||0;
      const f=t ? n.newFrame.slice(0,Math.max(0,n.newFrame.length-8*t)) : n.newFrame;
      const lsb=cat ? r.lsb : 0, off=cat ? r.off : 0;
      const B=blindBytes(f,off,lsb), wb=r.w>>3, L=B.length;
      let pass=false;
      if(L>=r.skip+wb+1){
        const got=blindField(B,L,wb,r.le);
        if(cat) pass=(r.def ? blindCrc(B,r.skip,L-wb,r.def) : BLIND_SUMS.find(s=>s.name===r.name).fn(B,r.skip,L-wb))===got;
        else if(L===r.L){ const reg=blindCrcReg(B,r.skip,L-wb,r.w,r.poly,0,r.refin); pass=((r.refout ? blindRev(reg,r.w) : reg)^r.K)>>>0===got; }
      }
      n.goodTotal++;
      n.ok=0;
      if(pass){
        n.good++; n.ok=1;
        const o=new Float32Array((L-wb)*8);
        for(let i=0;i<L-wb;i++) for(let k=0;k<8;k++) o[i*8+k]=((lsb ? (B[i]>>k) : (B[i]>>(7-k)))&1) ? 1 : -1;
        n.frame={d:o,n:o.length,id:b.id,crc:true};
      }
    }
    // текст
    let text;
    if(n.res){
      const r=n.res.best;
      if(n.res.kind==='catalog'){
        const alt=n.res.list.slice(1,3).map(x=>x.name).join(', ');
        text='✓ '+r.name+' · '+r.ok+'/'+r.tot+' frames · '+(r.lsb ? 'LSB-first' : 'MSB-first')+' bytes'+(r.off ? ' · bit offset '+r.off : '')+(r.skip ? ' · skip '+r.skip+' B' : '')+(r.tail ? ' · '+r.tail+' B after the checksum' : '')+(r.w>8 ? ' · '+(r.le ? 'little' : 'big')+'-endian' : '')+(alt ? '\nalso: '+alt : '');
      } else {
        const d=n.derived;
        text='✓ unknown '+r.w+'-bit CRC: poly '+blindHex(r.poly,r.w)+' refin '+r.refin+' refout '+r.refout+(d ? ' · init '+blindHex(d.init,r.w)+' xorout '+blindHex(d.xorout,r.w) : ' · constant '+blindHex(r.K,r.w))+(r.skip ? ' · skip '+r.skip+' B' : '')+(r.w>8 ? ' · '+(r.le ? 'little' : 'big')+'-endian' : '')+' · '+r.ok+'/'+r.tot+' frames of '+r.L+' B\n(init/xorout are known only as a pair for this length)';
      }
      text+='\nchecked now: '+n.good+' of '+n.goodTotal+' frames pass';
    } else if(n.frames.length<need) text='collecting frames… '+n.frames.length+' / '+need;
    else if(n.cs) text='searching the catalog… trailing bytes '+(n.cs.t-1)+' of '+tailMax;
    else if(n.u && !n.u.done) text='no catalog CRC — searching an unknown polynomial… '+Math.round(100*(n.u.ti+n.u.poly/(n.u.tasks[Math.min(n.u.ti,n.u.tasks.length-1)].w===8 ? 256 : 65536))/n.u.tasks.length)+'%';
    else text=n.u && n.u.done ? 'no CRC found (checked the catalog'+(tailMax ? ' with up to '+tailMax+' trailing bytes' : '')+', unknown 8/16-bit polynomials)' : (n.nocat ? 'no catalog CRC found' : 'waiting for more frames');
    n.text=text;
    n.ui={text, frames:n.frames.length, found:!!n.res, name:n.res ? (n.res.kind==='catalog' ? n.res.best.name : 'unknown '+n.res.best.w+'-bit') : '', good:n.good};
    return {blk:n.frame, ok:n.res ? (n.ok?1:0) : 0, found:n.res?1:0, text};
  }};

/* ============================ Conv Code Finder ============================ */
IQK.convFind={
  init(n){ n.frames=[]; n.fid=-1; n.res=null; n.st=null; n.last=0; n.frame=null; n.text=''; n.err=''; n.okey=''; n.dids=0; },
  process(n,I){
    const b=I.blk;
    if(b && b.d && b.id!==n.fid){
      n.fid=b.id;
      const bits=blindHard(b.d);
      if(bits.length>=40){ n.frames.push(bits.slice(0,Math.min(bits.length,n.p.maxBits|0))); if(n.frames.length>(n.p.keep|0)) n.frames.shift(); n.newFrame=bits; }
    } else n.newFrame=null;
    const okey=n.p.rate+'|'+n.p.maxK+'|'+n.p.thr;
    if(n.okey!==okey){ n.okey=okey; n.res=null; n.st=null; n.last=0; n.err=''; }
    const need=Math.max(3,n.p.min|0);
    if(!n.res && !n.st && n.frames.length>=need && n.frames.length>=n.last+(n.last ? 6 : 0)){
      n.last=n.frames.length;
      const rates=n.p.rate==='1/2' ? [2] : n.p.rate==='1/3' ? [3] : [2,3];
      const st=blindConvStart(n.frames,{rates,Kmax:n.p.maxK|0,thr:n.p.thr});
      if(st.err) n.err=st.err; else { n.st=st; n.err=''; }
    }
    if(n.st){
      if(blindConvStep(n.st)){
        const r=blindConvFinish(n.st); n.st=null;
        if(r){
          // проверка декодером: у настоящего кода путь Витерби почти не расходится с принятым (шум), у случайного совпадения — около 11 % и больше
          const fr=n.frames.slice(0,6).map(f=>blindViterbi(f,r.o,r.polys,r.K,!!n.p.tail,r.end)).filter(Boolean);
          const fracs=fr.map(d=>d.frac).sort((a,b)=>a-b), med=fracs.length ? fracs[fracs.length>>1] : 1;
          if(med<=.07){ n.res=r; n.err=''; n.res.frac=med; }
          else n.err='candidate K='+r.K+' rejected: the decoder leaves '+(100*med).toFixed(0)+'% errors';
        }
      }
    }
    if(n.res && n.newFrame){
      const r=n.res, dec=blindViterbi(n.newFrame,r.o,r.polys,r.K,!!n.p.tail,r.end);
      if(dec){
        const o=new Float32Array(dec.bits.length); for(let i=0;i<o.length;i++) o[i]=dec.bits[i] ? 1 : -1;
        n.frame={d:o,n:o.length,id:b.id,errs:dec.metric};
        n.dids++;
      }
    }
    let text;
    if(n.res){
      const r=n.res, oct=r.polys.map(p=>p.toString(8)).join(', ');
      text='✓ rate 1/'+r.n+' K='+r.K+' polynomials ('+oct+') octal · bit phase '+r.o+' · consistency '+(100*r.cons).toFixed(1)+'%'+(n.frame ? '\nViterbi: '+n.frame.n+' bits per frame, '+n.frame.errs+' channel errors corrected' : '');
    } else if(n.frames.length<need) text='collecting frames… '+n.frames.length+' / '+need;
    else if(n.st) text='searching a convolutional code… '+n.st.ti+' / '+n.st.tasks.length;
    else text='no convolutional code found'+(n.err ? ' ('+n.err+')' : '')+' · '+n.frames.length+' frames checked (retry at +6)';
    n.text=text;
    n.ui={text, frames:n.frames.length, found:!!n.res, K:n.res?n.res.K:0, rate:n.res?n.res.n:0, polys:n.res?n.res.polys.map(p=>p.toString(8)):[]};
    return {blk:n.frame, found:n.res?1:0, k:n.res?n.res.K:0, text};
  }};

/* ============================ Unknown Signal (генератор) ============================
   Тестовая передача с известными параметрами: 2FSK, GFSK, BPSK, QPSK; преамбула + слово + [FEC] + CRC; эхо — многолучёвость. */
const BLIND_GEN_CRC=['none','CRC-16/X-25','CRC-16/CCITT-FALSE','CRC-16/ARC','CRC-16/XMODEM','CRC-16/KERMIT','CRC-16/MODBUS','CRC-16/DNP','CRC-8','CRC-32'];
const BLIND_GEN_FEC={'none':null,'K=3 (7, 5)':{K:3,p:[7,5]},'K=5 (23, 35)':{K:5,p:[0o23,0o35]},'K=7 (171, 133)':{K:7,p:[0o171,0o133]},'K=9 (561, 753)':{K:9,p:[0o561,0o753]},'K=7 1/3 (133, 171, 165)':{K:7,p:[0o133,0o171,0o165]}};
IQK.blindGen={
  init(n){ n.acc=0; n.ph=0; n.t=0; n.k=0; n.qr=[]; n.qi=[]; n.cnt=0; n.rng=0x1234567; n.dly=new Float32Array(0); n.dp=0; n.tx=null; n.fid=0; n.key=''; n.nxt=0; },
  process(n,I,ctx){
    const sr=+n.p.sr, fc=pv(n,I,'fc'), s=iqStream(n,'iq',sr,fc), baud=Math.max(50,n.p.baud);
    n.acc+=sr*ctx.block/ctx.sr;
    const N=Math.floor(n.acc); n.acc-=N;
    const mod=n.p.mod, psk=mod==='BPSK' || mod==='QPSK';
    const key=[mod,n.p.word,n.p.len,n.p.crc,n.p.fec,n.p.gap].join('|');
    if(key!==n.key){ n.key=key; n.qr=[]; n.qi=[]; n.k=0; n.t=0; n.cnt=0; n.nxt=0; }
    let x=n.rng; const rnd=()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
    const bitsPerSym=mod==='QPSK' ? 2 : 1;
    // очередь символов: не меньше 16 символов впереди
    const build=()=>{
      const bits=[];
      for(const hx of [0xAA,0xAA,0xAA,0xAA]) for(let i=7;i>=0;i--) bits.push((hx>>i)&1);
      const w=String(n.p.word).replace(/[^0-9a-fA-F]/g,'')||'B38D2E5A';
      for(const ch of w) for(let i=3;i>=0;i--) bits.push((parseInt(ch,16)>>i)&1);
      // сообщение
      const len=Math.max(4,n.p.len|0), msg=[], txt='NODE 07 T=21.5C #'+String(n.cnt).padStart(4,'0')+' ';
      for(let i=0;i<len;i++) msg.push(i<txt.length ? txt.charCodeAt(i)&255 : (rnd()*256)|0);
      msg[0]=0x07; msg[1]=n.cnt&255;
      const bytes=msg.slice();
      if(n.p.crc!=='none'){
        const e=BLIND_CRC.find(c=>c.name===n.p.crc), c=blindCrc(Uint8Array.from(msg),0,msg.length,e), wb=e.w>>3;
        for(let k=wb-1;k>=0;k--) bytes.push((c>>>(8*k))&255);
      }
      const mb=[]; for(const B of bytes) for(let i=7;i>=0;i--) mb.push((B>>i)&1);
      const fec=BLIND_GEN_FEC[n.p.fec], coded=fec ? blindConvEnc(mb,fec.p,fec.K) : mb;
      for(const b of coded) bits.push(b);
      const gap=n.p.gap|0; for(let i=0;i<gap;i++) bits.push(rnd()<.5 ? 1 : 0);
      if(bitsPerSym===2 && bits.length&1) bits.push(0);
      for(let i=0;i<bits.length;i+=bitsPerSym){
        if(mod==='QPSK'){ n.qr.push(bits[i] ? 1 : -1); n.qi.push(bits[i+1] ? 1 : -1); }
        else { n.qr.push(bits[i] ? 1 : -1); n.qi.push(0); }
      }
      const tb=new Float32Array(mb.length); for(let i=0;i<mb.length;i++) tb[i]=mb[i] ? 1 : -1;
      n.tx={d:tb,n:tb.length,id:++n.fid};
      n.cnt++;
    };
    const need=Math.ceil(N*baud/sr)+24;
    while(n.qr.length-n.k<need) build();
    n.rng=x;
    const re=new Float32Array(N), im=new Float32Array(N), a=Math.pow(10,n.p.lvl/20), nz=Math.pow(10,n.p.noise/20)/Math.SQRT2;
    const dt=baud/sr, offw=2*Math.PI*pv(n,I,'off')/sr, dev=n.p.dev, gf=2*Math.PI*dev/sr;
    const sps=sr/baud, D=Math.max(1,Math.round(n.p.echoDelay*sps)), eg=n.p.echo, ep=n.p.echoPhase*Math.PI/180, ecr=eg*Math.cos(ep), eci=eg*Math.sin(ep);
    if(n.dly.length!==2*(D+1)){ n.dly=new Float32Array(2*(D+1)); n.dp=0; }
    const tab=psk ? symRrcTab(.35) : null, wblend=mod==='GFSK' ? 1 : .3;
    let t=n.t, ph=n.ph, q=n.qr, qi=n.qi, k=n.k;
    let x2=n.rng2||0x2468ace; const r2=()=>{ x2^=x2<<13; x2^=x2>>>17; x2^=x2<<5; return (x2>>>0)/4294967296; };
    for(let i=0;i<N;i++){
      let br, bi;
      if(psk){
        let vr=0, vi=0;
        for(let j=-5;j<=6;j++){
          const sidx=k+Math.floor(t)+j; if(sidx<0 || sidx>=q.length) continue;
          const wgt=tab[Math.round((t-Math.floor(t)-j+6)*64)]; if(!wgt) continue;
          vr+=q[sidx]*wgt; vi+=qi[sidx]*wgt;
        }
        if(mod==='QPSK'){ vr*=Math.SQRT1_2; vi*=Math.SQRT1_2; }
        const c=Math.cos(ph), sn=Math.sin(ph);
        br=vr*c-vi*sn; bi=vr*sn+vi*c; ph+=offw;
      } else {
        const kc=k+Math.floor(t), u=t-Math.floor(t), cur=q[kc], prv=kc>0 ? q[kc-1] : cur, nxt=q[kc+1];
        let v=cur;
        if(u<wblend/2) v=cur+(prv-cur)*.25*(1+Math.cos(Math.PI*u/(wblend/2)));
        else if(u>1-wblend/2) v=cur+(nxt-cur)*.25*(1-Math.cos(Math.PI*(u-(1-wblend/2))/(wblend/2)));
        ph+=offw+gf*v;
        br=Math.cos(ph); bi=Math.sin(ph);
      }
      t+=dt;
      // эхо
      const di=2*n.dp; const dr=n.dly[di], dim=n.dly[di+1];
      n.dly[di]=br; n.dly[di+1]=bi; n.dp=(n.dp+1)%(D+1);
      let yr=br+ecr*dr-eci*dim, yi=bi+ecr*dim+eci*dr;
      if(nz>0){ // гаусс по Бокса-Мюллеру
        const u1=Math.max(1e-12,r2()), u2=r2(), m=Math.sqrt(-2*Math.log(u1));
        yr=a*yr+nz*m*Math.cos(2*Math.PI*u2); yi=a*yi+nz*m*Math.sin(2*Math.PI*u2);
      } else { yr*=a; yi*=a; }
      re[i]=yr; im[i]=yi;
    }
    // сдвиг очереди
    const adv=Math.floor(t); t-=adv; k+=adv;
    if(k>4096){ n.qr=n.qr.slice(k-8); n.qi=n.qi.slice(k-8); k=8; }
    n.t=t; n.ph=ph%(2*Math.PI); n.k=k; n.rng2=x2;
    if(N>0) iqPush(s,re,im);
    n.ui={sr,baud,frames:n.cnt};
    return {iq:s, tx:n.tx};
  }};
