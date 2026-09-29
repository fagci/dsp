"use strict";
/* ============================ MPT 1327 (аналоговый транкинг, канал управления) ============================
   Ядро IQK (страница и воркер), без DOM. ЧМ → звук; FFSK 1200 Бод: 1 — 1200 Гц, 0 — 1800 Гц.
   Поток: преамбула, синхрослово (управляющий канал 0xC4D7, речевой 0x3B28 — инверсия), кодовые слова по 64 бита:
   48 бит данных, 15 бит CRC (полином 0x6815, xorout 1, CRC-15/MPT1327) и бит чётности всего слова.
   Первый бит слова: 1 — адресное слово (PFIX 7 бит, IDENT 13 бит), 0 — слово данных.
   Тактовая фаза не отслеживается: 8 сдвигов решётки по ⅛ бита, слово принимается по CRC. */

const MPT_BAUD=1200, MPT_SYNC=0xC4D7, MPT_SYNT=0x3B28, MPT_PH=8;
function mptPop(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
// CRC-15 по bit(i), i=0..len-1 (первый переданный бит — старший)
function mptCrcBits(bit,len){
  let r=0;
  for(let i=0;i<len;i++){ const fb=((r>>14)&1)^bit(i); r=(r<<1)&0x7FFF; if(fb) r^=0x6815; }
  return r^1;
}
// слово: w1 — первые 32 бита, w0 — последние 32; годно, если CRC сходится и чётность полная
function mptCheck(w1,w0){
  if((mptPop(w1)+mptPop(w0))&1) return false;
  const c=mptCrcBits(i=>i<32 ? (w1>>>(31-i))&1 : (w0>>>(63-i))&1, 48);
  return c===((w0>>>1)&0x7FFF);
}
// значение поля из 48 бит информации (pos — номер бита от начала, len ≤ 24)
function mptField(w1,w0,pos,len){
  let v=0;
  for(let i=pos;i<pos+len;i++) v=v*2+(i<32 ? (w1>>>(31-i))&1 : (w0>>>(63-i))&1);
  return v;
}
// 48 бит (массив 0/1) → 64 бита слова
function mptEncode(b48){
  const c=mptCrcBits(i=>b48[i],48), out=new Uint8Array(64);
  let ones=0;
  for(let i=0;i<48;i++){ out[i]=b48[i]; ones+=b48[i]; }
  for(let i=0;i<15;i++){ out[48+i]=(c>>(14-i))&1; ones+=out[48+i]; }
  out[63]=ones&1;
  return out;
}

IQK.mpt1327Rx={
  init(n){ n.key=''; n.words=0; n.syncs=0; n.addr=0; n.data=0; n.inv=null; n.chan=null; n.recent=[]; n.lastWord=0; },
  setup(n,s,cplx){
    const M=cplx ? Math.max(1,Math.floor(s.sr/24000)) : 1;
    n.M=M; n.fs=s.sr/M; n.sps=n.fs/MPT_BAUD;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,12000/n.fs), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    const stop=Math.min(11000,.47*n.fs);
    n.lp=cplx ? kaiserLP(n.fs,.6*stop,stop,255) : null;
    if(n.lp){ n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1); }
    n.pr=0; n.pi=0; n.dc=0;
    n.x=new Float32Array(0); n.xb=0; n.tNext=0; n.jj=0;
    n.w0=new Uint32Array(MPT_PH); n.w1=new Uint32Array(MPT_PH); n.w2=new Uint32Array(MPT_PH);
    n.ends=[];
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null}; }
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
      n.dc=dc; parts.push(y);
    }
    let add=0; for(const p of parts) add+=p.length;
    const nx=new Float32Array(n.x.length+add); nx.set(n.x); let o=n.x.length;
    for(const p of parts){ nx.set(p,o); o+=p.length; }
    n.x=nx;
    const recs=this.scan(n);
    const now=Date.now();
    n.ui={fs:n.fs, M:n.M, syncs:n.syncs, words:n.words, addr:n.addr, data:n.data, inv:n.inv, chan:n.chan,
      age:n.lastWord ? now-n.lastWord : null, recent:n.recent.slice(-8)};
    return {rec:recs.length ? recs : null};
  },
  scan(n){
    const x=n.x, N=x.length, sps=n.sps, fs=n.fs, recs=[];
    // префиксные суммы произведений с квадратурами обоих тонов (фаза — по абсолютному номеру отсчёта)
    const P=[new Float64Array(N+1),new Float64Array(N+1),new Float64Array(N+1),new Float64Array(N+1)];
    const fr=[1200/fs,1800/fs];
    for(let i=0;i<N;i++){
      const ab=n.xb+i, v=x[i];
      for(let t=0;t<2;t++){
        const ph=2*Math.PI*((ab*fr[t])%1);
        P[2*t][i+1]=P[2*t][i]+v*Math.cos(ph); P[2*t+1][i+1]=P[2*t+1][i]+v*Math.sin(ph);
      }
    }
    const step=sps/MPT_PH;
    let tj=n.tNext-n.xb;
    if(tj<0) tj=0;
    while(tj+sps<N-1){
      // окно [tj, tj+sps): энергия 1200 и 1800 Гц
      const gs=[], a0=Math.floor(tj), a1=Math.floor(tj+sps);
      for(let q=0;q<4;q++){
        const p=P[q];
        const va=p[a0]+(tj-a0)*(p[a0+1]-p[a0]), vb=p[a1]+(tj+sps-a1)*(p[a1+1]-p[a1]);
        gs.push(vb-va);
      }
      const bit=(gs[0]*gs[0]+gs[1]*gs[1])>(gs[2]*gs[2]+gs[3]*gs[3]) ? 1 : 0;
      const ph=n.jj%MPT_PH;
      n.jj++;
      const w2=((n.w2[ph]<<1)|(n.w1[ph]>>>31))&0xFFFF, w1=((n.w1[ph]<<1)|(n.w0[ph]>>>31))>>>0, w0=((n.w0[ph]<<1)|bit)>>>0;
      n.w2[ph]=w2; n.w1[ph]=w1; n.w0[ph]=w0;
      this.test(n,n.xb+tj+sps,w2,w1,w0,recs);
      tj+=step;
    }
    n.tNext=n.xb+tj;
    const keep=Math.max(0,Math.floor(tj)-2);
    if(keep>0){ n.x=x.slice(keep); n.xb+=keep; }
    return recs;
  },
  // te — момент конца слова (в отсчётах); w2 — 16 бит перед словом
  test(n,te,w2,w1,w0,recs){
    const sps=n.sps, ends=n.ends;
    while(ends.length && te-ends[0].t>400*sps) ends.shift();
    let inv=null, kind=null;
    const sm=Math.min(mptPop(w2^MPT_SYNC),mptPop(w2^MPT_SYNT));
    if(sm<=1){                                         // после синхрослова
      const eff=x=>mptPop(x^MPT_SYNC)<=1 ? 'control' : mptPop(x^MPT_SYNT)<=1 ? 'traffic' : null;
      if(mptCheck(w1,w0)){ inv=false; kind=eff(w2); }
      else if(mptCheck(~w1>>>0,~w0>>>0)){ inv=true; kind=eff(~w2&0xFFFF); }
      if(kind) n.syncs++;
    }
    if(kind===null){                                   // слово вплотную к принятому (данные) или после нового синхрослова
      for(const e of ends){
        const d=te-e.t;
        if(Math.abs(d-64*sps)<.6*sps || Math.abs(d-80*sps)<.6*sps){
          const ok=e.inv ? mptCheck(~w1>>>0,~w0>>>0) : mptCheck(w1,w0);
          if(ok){ inv=e.inv; kind=e.kind; break; }
        }
      }
    }
    if(kind===null) return;
    for(const e of ends) if(Math.abs(te-e.t)<1.2*sps) return;   // то же слово с соседней фазы
    ends.push({t:te, inv, kind});
    const a=inv ? ~w1>>>0 : w1, b=inv ? ~w0>>>0 : w0;
    const hex=(a>>>0).toString(16).padStart(8,'0')+(b>>>16).toString(16).padStart(4,'0');
    const now=Date.now(), rec={t:now, src:'MPT1327', chan:kind, raw:hex};
    if(a>>>31){
      rec.kind='address'; rec.pfix=mptField(a,b,1,7); rec.ident=mptField(a,b,8,13); rec.rest=mptField(a,b,21,24)*8+mptField(a,b,45,3);
      rec.text='ADDR '+rec.pfix+'/'+rec.ident+' · '+hex; n.addr++;
    } else { rec.kind='data'; rec.text='DATA '+hex; n.data++; }
    n.words++; n.inv=inv; n.chan=kind; n.lastWord=now;
    n.recent.push(kind[0].toUpperCase()+' '+rec.text); if(n.recent.length>20) n.recent.shift();
    recs.push(rec);
  }};

/* ---- генератор: канал управления MPT 1327 ---- */
// Преамбула (1010…), синхрослово, адресное слово, иногда слово данных; FFSK 1200/1800 Гц, девиация 2.5 кГц.
function mptSimMessage(k){
  const bits=[];
  for(let i=0;i<16;i++) bits.push(i&1 ? 0 : 1);
  for(let i=15;i>=0;i--) bits.push((MPT_SYNC>>i)&1);
  const b48=new Uint8Array(48), put=(pos,len,v)=>{ for(let i=0;i<len;i++) b48[pos+i]=(v>>(len-1-i))&1; };
  b48[0]=1; put(1,7,5+(k%3)); put(8,13,1000+((k*37)%3000)); put(21,24,(0x123456^(k*0x111))&0xFFFFFF); put(45,3,k&7);
  for(const v of mptEncode(b48)) bits.push(v);
  if(k%2){
    const d=new Uint8Array(48);
    for(let i=0;i<47;i++) d[1+i]=((k*2654435761)>>>(i%31))&1;
    for(const v of mptEncode(d)) bits.push(v);
  }
  return bits;
}
function mptGenerate(n,sr,N){
  let g=n.mpt;
  if(!g || g.sr!==sr) g=n.mpt={sr, t:0, ph:0, pa:0, bits:[], base:0, k:0};
  const re=new Float32Array(N), im=new Float32Array(N), spb=sr/MPT_BAUD, kd=2*Math.PI*2500/sr;
  for(let i=0;i<N;i++,g.t++){
    const idx=Math.floor(g.t/spb);
    while(g.base+g.bits.length<=idx) for(const v of mptSimMessage(g.k++)) g.bits.push(v);
    const bit=g.bits[idx-g.base];
    g.pa+=2*Math.PI*(bit ? 1200 : 1800)/sr;
    g.ph+=kd*Math.sin(g.pa);
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
    if(idx-g.base>8192){ g.bits.splice(0,4096); g.base+=4096; }
  }
  g.pa%=2*Math.PI; g.ph%=2*Math.PI;
  return [re,im];
}
