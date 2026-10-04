"use strict";
/* ============================ Символьный тракт: сборка 4FSK-приёмника блоками ============================
   Тот же тракт, что fsk4-kernels.js делает одним куском: IQ → FM-дискриминатор → RRC → символьный слайсер → поиск синхрослов.
   Символы идут по IQ-проводу как вещественный поток на частоте символов: re = уровень (≈ ±1, ±3, дибит 00 → +1, 01 → +3, 10 → −1, 11 → −3).
   Кадр поиска синхрослов — blk {d: ±1 мягкие биты (как у Sync Word → Frame), dib: дибиты, n, id, word, inv, errs, t}. */

/* ---- FM-дискриминатор: IQ → частота, Гц (вещественный поток той же частоты) ---- */
IQK.fmDisc={
  init(n){ n.key=''; n.pr=0; n.pi=0; n.dc=0; n.lp=null; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const bw=n.p.bw, key=s.sr+'|'+bw;
    if(key!==n.key){
      n.key=key;
      n.lp=bw>0 && bw<.4*s.sr ? kaiserLP(s.sr,bw,Math.min(bw*1.65,.47*s.sr),255) : null;
      if(n.lp){ n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1); }
    }
    const o=iqStream(n,'out',s.sr,0), k=s.sr/(2*Math.PI), a=n.p.dc>0 ? 1/(n.p.dc*s.sr) : 0;
    let pr=n.pr, pi=n.pi, dc=n.dc;
    for(const c of s.chunks){
      let y;
      if(!c.im) y=Float32Array.from(c.re);                // вещественный вход — уже ЧМ-звук
      else {
        const xr=n.lp ? firRun(n.lp,n.lr,c.re) : c.re, xi=n.lp ? firRun(n.lp,n.li,c.im) : c.im, K=xr.length;
        y=new Float32Array(K);
        for(let i=0;i<K;i++){ const p=xr[i], q=xi[i]; y[i]=Math.atan2(q*pr-p*pi, p*pr+q*pi)*k; pr=p; pi=q; }
      }
      if(a) for(let i=0;i<y.length;i++){ dc+=a*(y[i]-dc); y[i]-=dc; }    // уход частоты приёмника — медленный ФВЧ
      iqPush(o,y,null,c.tag);
    }
    n.pr=pr; n.pi=pi; n.dc=dc;
    n.ui={sr:s.sr, dc};
    return {out:o};
  }};

/* ---- RRC: согласованный фильтр (бод, α) ---- */
IQK.symRrc={
  init(n){ n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const key=s.sr+'|'+n.p.baud+'|'+n.p.alpha;
    if(key!==n.key){ n.key=key; n.h=fsk4RrcTaps(s.sr/n.p.baud,n.p.alpha); n.hist=new Float32Array(n.h.length-1); }
    const o=iqStream(n,'out',s.sr,0);
    for(const c of s.chunks) iqPush(o,firRun(n.h,n.hist,c.re),null,c.tag);
    n.ui={sps:s.sr/n.p.baud, taps:n.h.length};
    return {out:o};
  }};

/* ---- символьный слайсер ----
   Отсчёт в момент pos (дробный, кубическая интерполяция), шаг — символ. Такт подстраивается по энергии: в момент отсчёта
   (после RRC) энергия символа максимальна, спереди и сзади на sps/8 — меньше; (E_late − E_early) двигает pos. Уровень — по
   среднему |y| (для ±1, ±3 он равен 2g): на выходе уровни ≈ ±1, ±3. */
function symCubic(x,i,f){                                   // кубический Эрмит, i — целая часть, f — дробная
  const a=x[i-1], b=x[i], c=x[i+1], d=x[i+2];
  return b+.5*f*(c-a+f*(2*a-5*b+4*c-d+f*(3*(b-c)+d-a)));
}
IQK.symSlicer={
  init(n){ n.sx=new Float32Array(0); n.xb=0; n.pos=-1; n.env=0; n.envF=0; n.Ee=0; n.El=0; n.cnt=0; n.eps=0; n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const sps=s.sr/n.p.baud;
    if(sps<2){ n.ui={err:'sample rate must be ≥ 2 × baud'}; return {out:null}; }
    const key=s.sr+'|'+n.p.baud;
    if(key!==n.key){ n.key=key; n.sx=new Float32Array(0); n.xb=0; n.pos=-1; n.env=0; n.envF=0; n.Ee=0; n.El=0; }
    let add=0; for(const c of s.chunks) add+=c.re.length;
    const nx=new Float32Array(n.sx.length+add); nx.set(n.sx); let o0=n.sx.length;
    for(const c of s.chunks){ nx.set(c.re,o0); o0+=c.re.length; }
    const x=n.sx=nx, N=x.length, xb=n.xb;
    if(n.pos<0) n.pos=xb+sps+2;
    const out=iqStream(n,'out',n.p.baud,0), z=new Float32Array(Math.ceil(N/sps)+2), dl=sps/8, mu=n.p.loop;
    let pos=n.pos, env=n.env, envF=n.envF, Ee=n.Ee, El=n.El, m=0, eps=n.eps;
    while(pos+dl+2<xb+N-1){
      const t=pos-xb, i=Math.floor(t), v=symCubic(x,i,t-i);
      const te=t-dl, ie=Math.floor(te), ve=symCubic(x,ie,te-ie), tl=t+dl, il=Math.floor(tl), vl=symCubic(x,il,tl-il);
      env+=(Math.abs(v)-env)*(n.cnt<64 ? 1/(n.cnt+1) : 1/256);
      envF+=(Math.abs(v)-envF)*(1/8);
      if(envF>2*env || envF<.5*env) env=envF;          // пачка после паузы (или смена уровня) — не ждать медленную оценку
      Ee+=(ve*ve-Ee)*(1/32); El+=(vl*vl-El)*(1/32);
      eps=(El-Ee)/(El+Ee+1e-20);
      z[m++]=env>1e-9 ? v/(.5*env) : 0;
      n.cnt++;
      pos+=sps+mu*eps*sps;
    }
    n.pos=pos; n.env=env; n.envF=envF; n.Ee=Ee; n.El=El; n.eps=eps;
    const keep=Math.max(0,Math.floor(pos-xb-dl)-3);
    if(keep>0){ n.sx=x.slice(keep); n.xb=xb+keep; }
    if(m) iqPush(out,z.slice(0,m),null,null);
    n.ui={sps, env, timing:eps, symbols:n.cnt};
    return {out};
  }};

/* ---- поиск синхрослов: символы → кадры ----
   Слова (hex, несколько через пробел). Кандидат — по корреляции окна символов с эталоном (не зависит от масштаба: пачка с
   преамбулой из одних ±3 сбивает АРУ слайсера), затем усиление и смещение подгоняются по словам (как в монолите): знак
   усиления — полярность (инверсия спектра), кадр режется уже с поправкой. tol — ошибок в битах слова после подгонки,
   len — дибитов в кадре после слова. */
const SYM_LEV=[1,3,-1,-3];
function symDib(z){ return z>2 ? 1 : z>0 ? 0 : z>-2 ? 2 : 3; }
function symWords(text){
  const r=[];
  for(const w of String(text).split(/[\s,;]+/)){
    const hex=w.replace(/[^0-9a-fA-F]/g,'');
    if(!hex || hex.length%2) continue;                     // дибит — 2 бита, слово — целое число байт
    const d=[]; for(const ch of hex){ const v=parseInt(ch,16); d.push(v>>2, v&3); }
    const dd=Uint8Array.from(d), sy=Float32Array.from(dd,q=>SYM_LEV[q]);
    let sm=0, ss=0; for(const v of sy){ sm+=v; ss+=v*v; }
    r.push({hex:hex.toUpperCase(), d:dd, s:sy, sm, ss});
  }
  return r;
}
const SYM_POP2=[0,1,1,2];
IQK.symSync={
  init(n){ n.key=''; n.ring=new Float32Array(64); n.w=0; n.cnt=0; n.st=0; n.buf=null; n.k=0; n.fid=0; n.frame=null; n.sync={}; n.total=0; n.t=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {blk:n.frame}; }
    if(n.key!==n.p.word){ n.key=n.p.word; n.words=symWords(n.p.word); n.sync={}; n.cnt=0; n.st=0; }
    const W=n.words, len=Math.max(1,n.p.len|0), tol=n.p.tol|0, pol=n.p.pol, thr=n.p.corr, R=n.ring;
    if(!n.buf || n.buf.length!==len) n.buf=new Uint8Array(len);
    for(const c of s.chunks){
      const zz=c.re;
      for(let i=0;i<zz.length;i++,n.t++){
        const z=zz[i];
        if(n.st===1){                                       // кадр: набираем len дибитов с поправкой по слову
          n.buf[n.k++]=symDib((z-n.fo)/n.fg);
          if(n.k>=len){
            const bits=new Float32Array(2*len);
            for(let j=0;j<len;j++){ bits[2*j]=n.buf[j]&2 ? 1 : -1; bits[2*j+1]=n.buf[j]&1 ? 1 : -1; }
            n.frame={d:bits, dib:n.buf.slice(), n:2*len, id:++n.fid, word:n.hit.hex, inv:n.fg<0, errs:n.errs, t:n.t};
            n.sync[n.hit.hex]=(n.sync[n.hit.hex]||0)+1; n.total++;
            n.st=0; n.cnt=0;
          }
          continue;
        }
        R[n.w&63]=z; n.w++; n.cnt++;
        let bestC=0, bw=null, bs=0;
        for(const w of W){
          const L=w.s.length; if(n.cnt<L) continue;
          let dot=0, zs=0, zq=0;
          for(let j=0;j<L;j++){ const v=R[(n.w-L+j)&63]; dot+=v*w.s[j]; zs+=v; zq+=v*v; }
          // корреляция Пирсона с эталоном (смещение не мешает)
          const cv=dot-zs*w.sm/L, vz=zq-zs*zs/L, vs=w.ss-w.sm*w.sm/L;
          const r=cv/Math.sqrt(vz*vs+1e-20);
          const sg=r<0 ? -1 : 1;
          if(Math.abs(r)<thr || (sg>0 ? pol==='inverted' : pol==='normal')) continue;
          // прямая полярность — приоритетнее: у M17 FF5D — инверсия 55F7
          const score=Math.abs(r)+(sg>0 ? 1e-6 : 0);
          if(score>bestC){ bestC=score; bw=w; bs=sg; }
        }
        if(!bw) continue;
        // подгонка z = g·s + o по символам слова
        const L=bw.s.length;
        let zs=0, zd=0; for(let j=0;j<L;j++){ const v=R[(n.w-L+j)&63]; zs+=v; zd+=v*bw.s[j]; }
        const g=(zd-zs*bw.sm/L)/(bw.ss-bw.sm*bw.sm/L), o=(zs-g*bw.sm)/L;
        if(!isFinite(g) || Math.abs(g)<1e-6) continue;
        let e=0;
        for(let j=0;j<L;j++) e+=SYM_POP2[symDib((R[(n.w-L+j)&63]-o)/g)^bw.d[j]];
        if(e>tol) continue;
        n.st=1; n.k=0; n.hit=bw; n.fg=g; n.fo=o; n.errs=e;
      }
    }
    n.ui={frames:n.total, sync:{...n.sync}, id:n.fid, words:W.map(w=>w.hex)};
    return {blk:n.frame};
  }};
