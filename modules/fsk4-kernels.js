"use strict";
/* ============================ 4FSK / 2FSK: общий приёмник ============================
   Ядро IQK (страница и воркер), без DOM. IQ (или ЧМ-звук) → дискриминатор → RRC → 8 решёток по ⅛ символа →
   сдвиговые регистры дибитов → поиск синхрослов всех протоколов канала → захват → разбор кадров протоколом.
   Протокол — описание в FSK4.protos: скорость, α, таблица синхрослов и обработчики (init, lock, frame, ui).
   Каналы (пары скорость/α) делятся между протоколами: одна цепочка фильтров на всех.
   Уровни: дибит 00 → +1, 01 → +3, 10 → −1, 11 → −3 (2FSK: 00 → +1, 10 → −1). Инверсия спектра — переворот старшего бита. */

const FSK4_PH=8, FSK4_RING=1024, FSK4_RM=1023;
const FSK4_LEV=[1,3,-1,-3];
const FSK4={protos:{}, order:[]};

function fsk4Pop(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }

/* ---- RRC, единичная энергия в отсчётах (согласованный фильтр приёмника) ---- */
function fsk4Rrc(t,a){
  if(Math.abs(t)<1e-9) return 1-a+4*a/Math.PI;
  if(Math.abs(Math.abs(t)-1/(4*a))<1e-9) return a/Math.SQRT2*((1+2/Math.PI)*Math.sin(Math.PI/(4*a))+(1-2/Math.PI)*Math.cos(Math.PI/(4*a)));
  return (Math.sin(Math.PI*t*(1-a))+4*a*t*Math.cos(Math.PI*t*(1+a)))/(Math.PI*t*(1-Math.pow(4*a*t,2)));
}
function fsk4RrcTaps(sps,a){
  const hl=Math.round(6*sps), h=new Float32Array(2*hl+1); let e=0;
  for(let i=0;i<h.length;i++){ h[i]=fsk4Rrc((i-hl)/sps,a); e+=h[i]*h[i]; }
  const g=1/Math.sqrt(e);
  for(let i=0;i<h.length;i++) h[i]*=g;
  return h;
}

/* ---- синхрослова ---- */
function fsk4Bits(hex){ let s=''; for(const c of hex) s+=(parseInt(c,16)+16).toString(2).slice(1); return s; }
// шаблон из строки бит (чётной длины, до 48 бит), самый свежий дибит — последний
function fsk4Sync(bits,extra){
  const L=bits.length>>1, syms=new Float32Array(L);
  let hi=0, lo=0, mhi=0, mlo=0;
  for(let i=0;i<L;i++){
    const d=(bits.charCodeAt(2*i)-48)*2+(bits.charCodeAt(2*i+1)-48);
    hi=((hi<<2)|(lo>>>22))&0xFFFFFF; lo=((lo<<2)|d)&0xFFFFFF;
    mhi=((mhi<<2)|(mlo>>>22))&0xFFFFFF; mlo=((mlo<<2)|3)&0xFFFFFF;
    syms[i]=FSK4_LEV[d];
  }
  return Object.assign({hi,lo,mhi,mlo,len:L,syms,bits}, extra);
}
// ошибок в бит между регистром (24+24 бита) и шаблоном; xm — 0xAAAAAA для инверсии
function fsk4Dist(hi,lo,p,xm){ return fsk4Pop(((hi^xm^p.hi)&p.mhi)>>>0)+fsk4Pop(((lo^xm^p.lo)&p.mlo)>>>0); }

/* ---- кадр: дибиты по захвату (e — шаг последнего дибита) ---- */
function fsk4Slice(L,e,count){
  const ring=L.ch.ring[e&7], k0=e>>3, F=new Uint8Array(count);
  for(let i=0;i<count;i++){
    const z=(ring[(k0-(count-1-i))&FSK4_RM]-L.o)/L.g;
    F[i]=z>2 ? 1 : z>0 ? 0 : z>-2 ? 2 : 3;
  }
  return F;
}
// нормированные уровни (≈ ±1, ±3) тех же count дибитов
function fsk4Levels(L,e,count){
  const ring=L.ch.ring[e&7], k0=e>>3, F=new Float32Array(count);
  for(let i=0;i<count;i++) F[i]=(ring[(k0-(count-1-i))&FSK4_RM]-L.o)/L.g;
  return F;
}
function fsk4Drop(L){ if(L.ch.lock===L) L.ch.lock=null; }
// дибиты → биты (0/1), старший первым
function fsk4Unpack(F,o,n){ const b=new Uint8Array(2*n); for(let i=0;i<n;i++){ const d=F[o+i]; b[2*i]=d>>1; b[2*i+1]=d&1; } return b; }

/* ---- узел приёмника ---- */
function fsk4Node(pick,title){
  const K={
    init(n){ n.key=''; n.pr={}; n.ch=[]; n.ids=[]; },
    setup(n,s,cplx,ids){
      const M=cplx ? Math.max(1,Math.floor(s.sr/48000)) : 1;
      n.M=M; n.fs=s.sr/M; n.ids=ids;
      n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,7500/n.fs), tpp:'16'}} : null;
      if(n.dec) IQK.iqDecim.init(n.dec);
      const groups=new Map();
      for(const id of ids){
        const pr=FSK4.protos[id], key=pr.baud+'|'+pr.alpha+'|'+pr.lp;
        if(!groups.has(key)) groups.set(key,{baud:pr.baud, alpha:pr.alpha, lp:pr.lp, protos:[]});
        groups.get(key).protos.push(pr);
        if(!n.pr[id]){ n.pr[id]={}; pr.init(n.pr[id]); } else pr.reset(n.pr[id]);
      }
      n.ch=[];
      for(const g of groups.values()){
        const c={baud:g.baud, protos:g.protos, sps:n.fs/g.baud, lock:null, jj:0, x:new Float32Array(0), xb:0, tNext:0,
                 pr:0, pi:0, dc:0, env:0, lev:g.protos.some(p=>p.levels===4) ? 4 : 2};
        const stop=Math.min(g.lp*1.65,.47*n.fs);
        c.lp=cplx ? kaiserLP(n.fs,g.lp,stop,255) : null;
        if(c.lp){ c.lr=new Float32Array(c.lp.length-1); c.li=new Float32Array(c.lp.length-1); }
        c.rrc=fsk4RrcTaps(c.sps,g.alpha); c.rh=new Float32Array(c.rrc.length-1);
        c.ring=[]; for(let p=0;p<FSK4_PH;p++) c.ring.push(new Float32Array(FSK4_RING));
        c.hi=new Uint32Array(FSK4_PH); c.lo=new Uint32Array(FSK4_PH);
        c.maxLen=Math.max(...g.protos.flatMap(p=>p.syncs.map(s=>s.len)));
        n.ch.push(c);
      }
    },
    process(n,I){
      const s=iqIn(I,'in');
      if(!s){ n.ui=null; return {rec:null, voice:null}; }
      const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
      const ids=pick(n), key=s.sr+'|'+cplx+'|'+ids.join();
      if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx,ids); }
      const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
      const out={recs:[], voice:[]};
      for(const ch of n.ch){
        const parts=[], a=1/(0.2*n.fs);
        for(const c of src.chunks){
          let y;
          if(!n.cplx) y=Float32Array.from(c.re);
          else {
            const xr=firRun(ch.lp,ch.lr,c.re), xi=firRun(ch.lp,ch.li,iqChunkIm(c)), K=xr.length, k=n.fs/(2*Math.PI);
            y=new Float32Array(K);
            let pr=ch.pr, pi=ch.pi;
            for(let i=0;i<K;i++){ const p=xr[i], q=xi[i]; y[i]=Math.atan2(q*pr-p*pi, p*pr+q*pi)*k; pr=p; pi=q; }
            ch.pr=pr; ch.pi=pi;
          }
          let dc=ch.dc;                                    // уход частоты приёмника — медленный ФВЧ
          for(let i=0;i<y.length;i++){ dc+=a*(y[i]-dc); y[i]-=dc; }
          ch.dc=dc;
          parts.push(firRun(ch.rrc,ch.rh,y));
        }
        let add=0; for(const p of parts) add+=p.length;
        const nx=new Float32Array(ch.x.length+add); nx.set(ch.x); let o=ch.x.length;
        for(const p of parts){ nx.set(p,o); o+=p.length; }
        ch.x=nx;
        this.scan(n,ch,out);
      }
      const now=Date.now(), ui={fs:n.fs, M:n.M, protos:{}, active:null};
      for(const ch of n.ch) if(ch.lock){ ui.active=ch.lock.proto.id; }
      for(const id of n.ids){
        const pr=FSK4.protos[id], L=n.ch.map(c=>c.lock).find(l=>l && l.proto===pr) || null;
        ui.protos[id]=pr.ui(n.pr[id],L,now);
      }
      n.ui=n.ids.length===1 ? Object.assign(ui,ui.protos[n.ids[0]]) : ui;
      return {rec:out.recs.length ? out.recs : null, voice:out.voice.length ? out.voice : null};
    },
    scan(n,ch,out){
      const x=ch.x, N=x.length, step=ch.sps/FSK4_PH;
      let tj=ch.tNext-ch.xb;
      if(tj<0) tj=0;
      while(tj<N-1){
        const i0=Math.floor(tj), fr=tj-i0;
        this.step(n,ch,x[i0]+fr*(x[i0+1]-x[i0]),out);
        ch.jj++; tj+=step;
      }
      ch.tNext=ch.xb+tj;
      const keep=Math.max(0,Math.floor(tj)-2);
      if(keep>0){ ch.x=x.slice(keep); ch.xb+=keep; }
    },
    step(n,ch,y,out){
      const jj=ch.jj, ph=jj&7, k=jj>>3;
      ch.ring[ph][k&FSK4_RM]=y;
      ch.env+=(Math.abs(y)-ch.env)*(1/2048);
      const e=ch.env, d=ch.lev===4 ? (y>e ? 1 : y>0 ? 0 : y>-e ? 2 : 3) : (y>0 ? 0 : 2);
      ch.hi[ph]=((ch.hi[ph]<<2)|(ch.lo[ph]>>>22))&0xFFFFFF; ch.lo[ph]=((ch.lo[ph]<<2)|d)&0xFFFFFF;
      const lk=ch.lock;
      if(jj>=8*ch.maxLen && (!lk || Math.abs(jj-lk.next)<=8)) this.findSync(n,ch,ph,jj);
      const l2=ch.lock;
      if(l2 && jj===l2.next+8*l2.after) l2.proto.frame(n.pr[l2.proto.id],l2,jj,out);
    },
    findSync(n,ch,ph,jj){
      const lk=ch.lock, hi=ch.hi[ph], lo=ch.lo[ph];
      let bd=99, bp=null, bq=null;
      for(const pr of lk ? [lk.proto] : ch.protos){
        const thr=lk ? pr.thrLock : pr.thrAcq;
        for(const xm of [0,0xAAAAAA]) for(const p of pr.syncs){
          const d=fsk4Dist(hi,lo,p,xm);
          if(d<=thr && d<bd){ bd=d; bp=p; bq=pr; }
        }
      }
      if(!bp) return;
      const f=this.fit(ch,ph,jj,bp);
      if(!f) return;
      const P=n.pr[bq.id];
      if(!lk){
        const L={ch, proto:bq, next:jj, best:bd, bestRq:f.rq, g:f.g, o:f.o, miss:0, after:0};
        Object.assign(L,bq.lock(P,L,bp,f));
        ch.lock=L;
      } else if(bd<lk.best || (bd===lk.best && f.rq<lk.bestRq)){
        lk.next=jj; lk.best=bd; lk.bestRq=f.rq;
        lk.g=lk.proto.gain ? lk.proto.gain(lk,f) : f.g; lk.o=f.o;
        if(lk.proto.resync) lk.proto.resync(P,lk,bp);
      }
    },
    // усиление и смещение по известным символам синхрослова: y = g·s + o (g<0 — инвертированный спектр);
    // rq — остаточная дисперсия в долях g²: минимум — лучшая фаза такта
    fit(ch,ph,jj,p){
      const ring=ch.ring[ph], k=jj>>3, s=p.syms, N=p.len;
      let sy=0, sx=0, sxx=0, sxy=0, syy=0;
      for(let i=0;i<N;i++){ const v=ring[(k-(N-1-i))&FSK4_RM]; sy+=v; sx+=s[i]; sxx+=s[i]*s[i]; sxy+=s[i]*v; syy+=v*v; }
      const den=N*sxx-sx*sx, g=(N*sxy-sx*sy)/den, o=(sy-g*sx)/N;
      if(!isFinite(g) || Math.abs(g)<1e-3) return null;
      const res=(syy-2*g*sxy-2*o*sy+g*g*sxx+2*g*o*sx+N*o*o)/N;
      return {g, o, rq:res/(g*g)};
    }};
  return K;
}

/* ---- генератор: уровни цикла (±1, ±3) → RRC → ЧМ ---- */
// cfg: {key, baud, alpha, dev (Гц на единицу уровня), script(): Float32Array — цикл уровней}
function fsk4Generate(n,sr,N,cfg){
  let g=n.fkg;
  if(!g || g.sr!==sr || g.key!==cfg.key){
    const sps=sr/cfg.baud, rx=fsk4RrcTaps(sps,cfg.alpha), hl=(rx.length-1)/2;
    let cal=0; for(let j=0;j<rx.length;j++) cal+=rx[j]*fsk4Rrc((j-hl)/sps,cfg.alpha);
    const tab=new Float32Array(769); for(let i=0;i<769;i++) tab[i]=fsk4Rrc((i-384)/64,cfg.alpha)/cal;
    g=n.fkg={sr, key:cfg.key, t:0, ph:0, lv:cfg.script(), tab};
  }
  const re=new Float32Array(N), im=new Float32Array(N), S=g.lv.length, kd=2*Math.PI*cfg.dev/sr, tab=g.tab, lv=g.lv;
  for(let i=0;i<N;i++,g.t++){
    const tau=g.t*cfg.baud/sr, kc=Math.floor(tau);
    let f=0;
    for(let k=kc-5;k<=kc+6;k++){ const v=lv[((k%S)+S)%S]; if(v) f+=v*tab[Math.round((tau-k+6)*64)]; }
    g.ph+=kd*f;
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
  }
  g.ph%=2*Math.PI;
  return [re,im];
}
// дибиты (0..3) → уровни
function fsk4LevelsOf(dib){ const r=new Float32Array(dib.length); for(let i=0;i<dib.length;i++) r[i]=FSK4_LEV[dib[i]]; return r; }
// биты (0/1) → дибиты
function fsk4Dib(bits){ const d=new Uint8Array(bits.length>>1); for(let i=0;i<d.length;i++) d[i]=bits[2*i]*2+bits[2*i+1]; return d; }
