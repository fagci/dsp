"use strict";
/* ============================ ACARS (VHF, 131 МГц) ============================
   Ядро IQK (страница и воркер), без DOM. AM → огибающая → звук; MSK 2400 Бод: тоны 1200 и 2400 Гц.
   Поток: предкей, «+*», SYN SYN, SOH, блок (режим, борт 7, ACK, метка 2, номер блока, STX, текст, ETX/ETB),
   BCS (CRC-16, полином 0x8408 зеркально, начальное 0, по байтам с битом чётности, от режима до BCS — ноль), DEL.
   Байт — 7 бит LSB первым + бит чётности (нечётная). Конвенция тонов не фиксируется: 1 = 1200 Гц, инверсия и
   дифференциальный вариант (смена/повтор тона) проверяются все, верным считается тот, что дал синхрослово.
   Тактовая фаза не отслеживается: 8 сдвигов решётки по ⅛ бита, кадр принимается по CRC. */

const VAC_BAUD=2400, VAC_PH=8, VAC_DEL=0x7f, VAC_MAXLEN=240;
const VAC_INTERP=['1 = 1200 Hz','inverted','differential (change)','differential (same)'];
function vacOdd(b){ b^=b>>4; b^=b>>2; b^=b>>1; return (b&1)===1; }
function vacPar(c){ c&=0x7f; return vacOdd(c) ? c : c|0x80; }
function vacBits(bytes){ const b=[]; for(const v of bytes) for(let i=0;i<8;i++) b.push((v>>i)&1); return b; }
// '*' SYN SYN SOH: последние 32 бита перед блоком
const VAC_SYNC=(()=>{ let v=0; for(const b of vacBits([0x2A,0x16,0x16,0x01].map(vacPar))) v=((v<<1)|b)>>>0; return v; })();
const VAC_CRCT=(()=>{
  const t=new Uint16Array(256);
  for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c=c&1 ? (c>>>1)^0x8408 : c>>>1; t[i]=c; }
  return t;
})();
function vacCrc(b,len){ let c=0; for(let i=0;i<len;i++) c=(c>>>8)^VAC_CRCT[(c^b[i])&0xFF]; return c; }

// блок без чётности и BCS (режим … ETX/ETB) → поля
function vacParse(b){
  const len=b.length;
  if(len<13) return null;
  const ch=i=>String.fromCharCode(b[i]);
  const m={mode:ch(0), reg:'', ack:b[8]===0x15 ? '!' : ch(8), label:ch(9)+(b[10]===0x7f ? 'd' : ch(10)),
    blk:b[11]===0 ? ' ' : ch(11), no:'', flight:'', txt:'', etb:b[len-1]===0x17};
  for(let i=1;i<8;i++) m.reg+=ch(i);
  m.reg=m.reg.replace(/^\.+/,'');
  m.dir=m.blk>='0' && m.blk<='9' ? 'air2gnd' : 'gnd2air';
  let k=12;
  const end=len-1;
  if(k<end && b[k]===0x02) k++;
  if(m.mode<='Z' && m.blk<='9' && k<end){
    for(let i=0;i<4 && k<end;i++,k++) m.no+=ch(k);
    for(let i=0;i<6 && k<end;i++,k++) m.flight+=ch(k);
  }
  for(;k<end;k++) m.txt+=b[k]>=32 && b[k]<127 ? ch(k) : b[k]===10 || b[k]===13 ? ' ' : '.';
  return m;
}

IQK.acarsRx={
  init(n){ n.key=''; n.frames=0; n.fixed=0; n.bad=0; n.syncs=0; n.interp=null; n.recent=[]; n.last=0; n.seen=[]; n.badTe=-1e9; },
  setup(n,s,cplx){
    const M=cplx ? Math.max(1,Math.floor(s.sr/24000)) : 1;
    n.M=M; n.fs=s.sr/M; n.sps=n.fs/VAC_BAUD;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,12000/n.fs), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    n.lp=kaiserLP(n.fs,1000,Math.min(1900,.45*n.fs),511);
    n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1);
    n.dc=0; n.pk=0; n.th=0; n.pr=0; n.pi=0;
    n.ci=new Float32Array(0); n.xb=0; n.tNext=0; n.jj=0;
    n.ph=[]; for(let p=0;p<VAC_PH;p++) n.ph.push({sh:0, st:0, ip:0, by:[], nb:0, cur:0, pe:[], tail:0});
    n.seen=[];
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null}; }
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    const key=s.sr+'|'+cplx;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    const parts=[], a=1/(0.02*n.fs), w=2*Math.PI*1800/n.fs, TP=2*Math.PI;
    for(const c of src.chunks){
      const K=c.re.length, im=n.cplx ? iqChunkIm(c) : null, zr=new Float32Array(K), zi=new Float32Array(K);
      let dc=n.dc, th=n.th, pk=n.pk;
      for(let i=0;i<K;i++){
        const e=im ? Math.sqrt(c.re[i]*c.re[i]+im[i]*im[i]) : c.re[i];   // огибающая AM
        dc+=a*(e-dc);
        if(dc>pk) pk=dc;
        const x=e-dc;
        zr[i]=x*Math.cos(th); zi[i]=-x*Math.sin(th);                     // перенос 1800 Гц в ноль
        th+=w; if(th>TP) th-=TP;
      }
      n.dc=dc; n.th=th; n.pk=pk*Math.exp(-K/(3*n.fs));              // уровень несущей с медленным спадом
      const xr=firRun(n.lp,n.lr,zr), xi=firRun(n.lp,n.li,zi), ci=new Float32Array(K);
      let pr=n.pr, pi=n.pi;
      for(let i=0;i<K;i++){ const p=xr[i], q=xi[i]; ci[i]=q*pr-p*pi; pr=p; pi=q; }   // Im(z[i]·conj(z[i-1]))
      n.pr=pr; n.pi=pi; parts.push(ci);
    }
    let add=0; for(const p of parts) add+=p.length;
    const nc=new Float32Array(n.ci.length+add); nc.set(n.ci); let o=n.ci.length;
    for(const p of parts){ nc.set(p,o); o+=p.length; }
    n.ci=nc;
    const recs=this.scan(n), now=Date.now();
    n.ui={fs:n.fs, M:n.M, frames:n.frames, fixed:n.fixed, bad:n.bad, syncs:n.syncs, lvl:20*Math.log10(Math.max(n.pk,1e-6)),
      interp:n.interp!=null ? VAC_INTERP[n.interp] : null, age:n.last ? now-n.last : null, recent:n.recent.slice(-8)};
    return {rec:recs.length ? recs : null};
  },
  scan(n){
    const x=n.ci, N=x.length, sps=n.sps, recs=[], P=new Float64Array(N+1);
    for(let i=0;i<N;i++) P[i+1]=P[i]+x[i];
    const step=sps/VAC_PH;
    let tj=n.tNext-n.xb;
    if(tj<0) tj=0;
    while(tj+sps<N-1){
      // фаза за окно в один бит: вверх — 2400 Гц (бит 0), вниз — 1200 Гц (бит 1)
      const a0=Math.floor(tj), a1=Math.floor(tj+sps);
      const va=P[a0]+(tj-a0)*(P[a0+1]-P[a0]), vb=P[a1]+(tj+sps-a1)*(P[a1+1]-P[a1]);
      this.bit(n,n.jj%VAC_PH,vb-va>0 ? 0 : 1,n.xb+tj+sps,recs);
      n.jj++;
      tj+=step;
    }
    n.tNext=n.xb+tj;
    const keep=Math.max(0,Math.floor(tj)-2);
    if(keep>0){ n.ci=x.slice(keep); n.xb+=keep; }
    return recs;
  },
  // r — сырой бит решётки фазы p; te — конец окна в отсчётах
  bit(n,p,r,te,recs){
    const f=n.ph[p], prev=f.sh&1, out=f.sh>>>31;
    if(f.st) this.feed(n,f,r,prev,te,recs);
    f.sh=((f.sh<<1)|r)>>>0;
    if(f.st) return;
    const D=(f.sh^((f.sh>>>1)|(out<<31)))>>>0, cand=[f.sh,~f.sh>>>0,D,~D>>>0];
    let best=-1, bd=3;
    for(let k=0;k<4;k++){ const d=popcnt32((cand[k]^VAC_SYNC)>>>0); if(d<bd){ bd=d; best=k; } }
    if(best<0) return;
    f.st=1; f.ip=best; f.by=[]; f.nb=0; f.cur=0; f.pe=[]; f.tail=0;
    n.syncs++;
  },
  feed(n,f,r,prev,te,recs){
    const ip=f.ip, bit=ip===0 ? r : ip===1 ? r^1 : ip===2 ? r^prev : r^prev^1;
    f.cur|=bit<<f.nb;
    if(++f.nb<8) return;
    const v=f.cur, by=f.by;
    f.cur=0; f.nb=0;
    if(f.tail===0){
      if(!vacOdd(v)){ f.pe.push(by.length); if(f.pe.length>2){ f.st=0; return; } }
      by.push(v);
      const c=v&0x7f;
      if(by.length>=13 && (c===0x03 || c===0x17)) f.tail=3;           // ETX / ETB, дальше BCS (без чётности) и DEL
      else if(by.length>VAC_MAXLEN) f.st=0;
    } else if(f.tail>1){ by.push(v); f.tail--; }
    else { f.st=0; if((v&0x7f)===VAC_DEL) this.done(n,f,te,recs); }
  },
  done(n,f,te,recs){
    const by=f.by.slice(), L=by.length;
    let ok=vacCrc(by,L)===0, fixed=false;
    if(!ok && n.p.fix && f.pe.length){                              // ошибки чётности: перебор битов, верно — по CRC
      const [i,j]=f.pe;
      for(let b=0;b<8 && !ok;b++){
        by[i]^=1<<b;
        if(j==null){ if(vacCrc(by,L)===0) ok=true; }
        else for(let c=0;c<8 && !ok;c++){ by[j]^=1<<c; if(vacCrc(by,L)===0) ok=true; else by[j]^=1<<c; }
        if(!ok) by[i]^=1<<b;
      }
      fixed=ok;
    }
    if(!ok){ if(!(te-n.badTe<1.5*n.sps)) n.bad++; n.badTe=te; return; }      // соседние фазы — один кадр
    const key=by.join(',');
    const seen=n.seen;
    while(seen.length && te-seen[0].te>40*n.sps) seen.shift();
    for(const e of seen) if(e.key===key && Math.abs(te-e.te)<1.5*n.sps) return;   // тот же кадр с соседней фазы
    seen.push({key,te});
    const m=vacParse(by.slice(0,L-2).map(v=>v&0x7f));
    if(!m){ n.bad++; return; }
    const now=Date.now();
    n.frames++; if(fixed) n.fixed++;
    n.interp=f.ip; n.last=now;
    const rec={t:now, src:'ACARS', kind:'message', id:m.reg, reg:m.reg, mode:m.mode, ack:m.ack, label:m.label, blk:m.blk, dir:m.dir,
      txt:m.txt, rssi:+(20*Math.log10(Math.max(n.pk,1e-6))).toFixed(1)};
    if(m.no) rec.no=m.no;
    if(m.flight) rec.flight=m.flight;
    if(m.etb) rec.etb=true;
    if(fixed) rec.fixed=true;
    rec.text=m.reg+' '+m.label+(m.flight ? ' '+m.flight : '')+(m.txt ? ' · '+m.txt : '');
    const d=new Date(now);
    n.recent.push(d.toTimeString().slice(0,8)+' '+rec.text.slice(0,90)+(fixed ? ' (fixed)' : '')); if(n.recent.length>20) n.recent.shift();
    recs.push(rec);
  }};

/* ---- генератор: ACARS, AM-несущая с MSK 2400 ---- */
const VAC_SIM=[
  {mode:'2', reg:'.D-AIBA', ack:0x15, label:'H1', blk:'3', flight:'LH1234', body:'#M1BPOS N55123E037456,FL350,ETA1432'},
  {mode:'2', reg:'.OH-LKP', ack:'3', label:'5Z', blk:'B', body:'GATE B23 LAND 1432Z'},
  {mode:'2', reg:'.VP-BJF', ack:0x15, label:'QA', blk:'1', flight:'SU0275', body:'OUT0745 OFF0802'},
  {mode:'2', reg:'.VP-BJF', ack:0x15, label:'Q0', blk:'2', flight:'', body:''},
  {mode:'2', reg:'.N718AN', ack:0x15, label:'80', blk:'5', flight:'AA0100', body:'/BCN.TEST 01 FUEL 4120KG'}];
function vacSimBits(k){
  const m=VAC_SIM[k%VAC_SIM.length], code=s=>typeof s==='number' ? s : s.charCodeAt(0);
  const c=[code(m.mode)];
  for(const ch of m.reg) c.push(ch.charCodeAt(0));
  c.push(code(m.ack), m.label.charCodeAt(0), m.label.charCodeAt(1), code(m.blk));
  let txt=m.body;
  if(m.blk<='9') txt='M'+String(k%100).padStart(2,'0')+'A'+m.flight.padEnd(6,' ')+txt;
  if(txt){ c.push(2); for(const ch of txt) c.push(ch.charCodeAt(0)); }
  c.push(3);
  const by=c.map(vacPar), crc=vacCrc(by,by.length);
  by.push(crc&0xFF,crc>>8,VAC_DEL);
  const bits=[];
  for(let i=0;i<16;i++) bits.push(1);
  for(const v of vacBits([0x2B,0x2A,0x16,0x16,0x01].map(vacPar))) bits.push(v);
  for(const v of vacBits(by)) bits.push(v);
  for(let i=0;i<8;i++) bits.push(1);
  for(let i=0;i<3600;i++) bits.push(2);                             // пауза без несущей
  return bits;
}
function vacGenerate(n,sr,N){
  let g=n.acarsG;
  if(!g || g.sr!==sr) g=n.acarsG={sr, t:0, ph:0, bits:[], base:0, k:0};
  const re=new Float32Array(N), im=new Float32Array(N), spb=sr/VAC_BAUD;
  for(let i=0;i<N;i++,g.t++){
    const idx=Math.floor(g.t/spb);
    while(g.base+g.bits.length<=idx) for(const v of vacSimBits(g.k++)) g.bits.push(v);
    const bit=g.bits[idx-g.base];
    if(bit!==2){ g.ph+=2*Math.PI*(bit ? 1200 : 2400)/sr; re[i]=(1+.6*Math.sin(g.ph))/1.6; }
    if(idx-g.base>8192){ g.bits.splice(0,4096); g.base+=4096; }
  }
  g.ph%=2*Math.PI;
  return [re,im];
}
