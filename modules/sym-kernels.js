"use strict";
/* ============================ Символьный тракт: сборка 4FSK-приёмника блоками ============================
   Тот же тракт, что fsk4-kernels.js делает одним куском: IQ → FM-дискриминатор → RRC → символьный слайсер → поиск синхрослов.
   Символы идут по IQ-проводу как вещественный поток на частоте символов: re = уровень (≈ ±1, ±3, дибит 00 → +1, 01 → +3, 10 → −1, 11 → −3).
   Кадр поиска синхрослов — blk {d: ±1 мягкие биты (как у Sync Word → Frame), dib: дибиты после слова, fr: весь кадр, n, id, word, hit, inv, errs, t, outer — доля внешних уровней}. */

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
   среднему |y| (для ±1, ±3 он равен 2g), медленно: на выходе уровни ≈ ±1, ±3, а точный масштаб кадра даёт подгонка по синхрослову. */
function symCubic(x,i,f){                                   // кубический Эрмит, i — целая часть, f — дробная
  const a=x[i-1], b=x[i], c=x[i+1], d=x[i+2];
  return b+.5*f*(c-a+f*(2*a-5*b+4*c-d+f*(3*(b-c)+d-a)));
}
IQK.symSlicer={
  init(n){ n.sx=new Float32Array(0); n.xb=0; n.pos=-1; n.env=0; n.Ee=0; n.El=0; n.cnt=0; n.eps=0; n.key=''; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const sps=s.sr/n.p.baud;
    if(sps<2){ n.ui={err:'sample rate must be ≥ 2 × baud'}; return {out:null}; }
    const key=s.sr+'|'+n.p.baud;
    if(key!==n.key){ n.key=key; n.sx=new Float32Array(0); n.xb=0; n.pos=-1; n.env=0; n.Ee=0; n.El=0; }
    let add=0; for(const c of s.chunks) add+=c.re.length;
    const nx=new Float32Array(n.sx.length+add); nx.set(n.sx); let o0=n.sx.length;
    for(const c of s.chunks){ nx.set(c.re,o0); o0+=c.re.length; }
    const x=n.sx=nx, N=x.length, xb=n.xb;
    if(n.pos<0) n.pos=xb+sps+2;
    const out=iqStream(n,'out',n.p.baud,0), z=new Float32Array(Math.ceil(N/sps)+2), dl=sps/8, mu=n.p.loop, agc=1/Math.max(16,n.p.agc);
    let pos=n.pos, env=n.env, Ee=n.Ee, El=n.El, m=0, eps=n.eps;
    while(pos+dl+2<xb+N-1){
      const t=pos-xb, i=Math.floor(t), v=symCubic(x,i,t-i);
      const te=t-dl, ie=Math.floor(te), ve=symCubic(x,ie,te-ie), tl=t+dl, il=Math.floor(tl), vl=symCubic(x,il,tl-il);
      env+=(Math.abs(v)-env)*(n.cnt<64 ? 1/(n.cnt+1) : agc);   // медленно: масштаб внутри кадра не должен уходить, точный — по слову (Symbol Sync Search)
      Ee+=(ve*ve-Ee)*(1/32); El+=(vl*vl-El)*(1/32);
      eps=(El-Ee)/(El+Ee+1e-20);
      z[m++]=env>1e-9 ? v/(.5*env) : 0;
      n.cnt++;
      pos+=sps+mu*eps*sps;
    }
    n.pos=pos; n.env=env; n.Ee=Ee; n.El=El; n.eps=eps;
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
const SYM_POP2=[0,1,1,2], SYM_RING=1024, SYM_MASK=SYM_RING-1;
// окно из L символов, оканчивающееся индексом E: лучшее слово по корреляции, подгонка z = g·s + o, число битовых ошибок после подгонки
function symMatch(n,E,tolx,thr,pol,after){
  const R=n.ring;
  let best=null;
  for(const w of n.words){
    const L=w.s.length;
    if(E-L+1<=after || E-L+1<0) continue;
    let dot=0, zs=0, zq=0;
    for(let j=0;j<L;j++){ const v=R[(E-L+1+j)&SYM_MASK]; dot+=v*w.s[j]; zs+=v; zq+=v*v; }
    // корреляция Пирсона с эталоном (смещение не мешает)
    const cv=dot-zs*w.sm/L, vz=zq-zs*zs/L, vs=w.ss-w.sm*w.sm/L;
    const r=cv/Math.sqrt(vz*vs+1e-20), sg=r<0 ? -1 : 1;
    if(Math.abs(r)<thr || (sg>0 ? pol==='inverted' : pol==='normal')) continue;
    // прямая полярность — приоритетнее: у M17 FF5D — инверсия 55F7, у DMR голос и данные — двойники
    const score=Math.abs(r)+(sg>0 ? 1e-6 : 0);
    if(best && score<=best.score) continue;
    const g=(dot-zs*w.sm/L)/(w.ss-w.sm*w.sm/L), o=(zs-g*w.sm)/L;
    if(!isFinite(g) || Math.abs(g)<1e-6) continue;
    let e=0;
    for(let j=0;j<L && e<=tolx;j++) e+=SYM_POP2[symDib((R[(E-L+1+j)&SYM_MASK]-o)/g)^w.d[j]];
    if(e>tolx) continue;
    best={w,g,o,e,E,score};
  }
  return best;
}
// кадр: pre символов до слова + слово + len после, нарезка по подгонке слова (g, o)
function symEmit(n,pd,pre,len){
  const L=pd.w ? pd.w.s.length : n.words[0].s.length, tot=pre+L+len, R=n.ring, i0=pd.E-L+1-pre;
  const fr=new Uint8Array(tot);
  for(let j=0;j<tot;j++) fr[j]=symDib((R[(i0+j)&SYM_MASK]-pd.o)/pd.g);
  let outer=0; for(let j=0;j<tot;j++) if(fr[j]&1) outer++;                // дибиты 01 и 11 — внешние уровни ±3: у модулированного кадра ≈ половина
  const dib=fr.slice(pre+L), bits=new Float32Array(2*len);
  for(let j=0;j<len;j++){ bits[2*j]=dib[j]&2 ? 1 : -1; bits[2*j+1]=dib[j]&1 ? 1 : -1; }
  const hex=pd.w ? pd.w.hex : null;
  n.frame={d:bits, dib, fr, at:pre, n:2*len, id:++n.fid, word:hex, hit:pd.hit, inv:pd.g<0, errs:pd.e, t:pd.E+len, lock:pd.lock, outer:outer/tot};
  n.total++;
  if(hex) n.sync[hex]=(n.sync[hex]||0)+1;
}
/* Сетка кадров: period > 0 — после захвата кадры идут каждые period символов, и когда слова на месте нет (у DMR в голосовых
   пакетах B–F вместо него EMB), кадр всё равно выдаётся (по уровням прошлой подгонки); слово ищется на ±1 символ от ожидаемого,
   miss кадров подряд без слова — захват потерян. */
IQK.symSync={
  init(n){ n.key=''; n.ring=new Float32Array(SYM_RING); n.w=0; n.pend=null; n.after=-1; n.expect=-1; n.miss=0; n.fid=0; n.frame=null; n.sync={};
    n.total=0; n.lockId=0; n.fg=1; n.fo=0; n.words=[]; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {blk:n.frame}; }
    if(n.key!==n.p.word){ n.key=n.p.word; n.words=symWords(n.p.word); n.sync={}; n.pend=null; n.expect=-1; }
    const W=n.words, len=Math.max(1,n.p.len|0), pre=Math.max(0,n.p.pre|0), period=Math.max(0,n.p.period|0), tol=n.p.tol|0, tolLock=n.p.lockTol==null ? tol : n.p.lockTol|0,
      maxMiss=n.p.miss==null ? 12 : n.p.miss|0, pol=n.p.pol, thr=n.p.corr, R=n.ring;
    if(W.length){
      for(const c of s.chunks){
        const zz=c.re;
        for(let i=0;i<zz.length;i++){
          R[n.w&SYM_MASK]=zz[i]; n.w++;
          const cur=n.w-1;
          if(n.pend){                                      // кадр набирается: слово уже найдено, ждём len символов после него
            if(cur===n.pend.E+len){
              const pd=n.pend; n.pend=null; n.after=pd.E+len;
              if(pd.hit){ n.fg=pd.g; n.fo=pd.o; }
              symEmit(n,pd,pre,len);
              if(n.frame) (n.recent||(n.recent=[])).push({w:n.w,f:n.frame});
              n.expect=period>0 ? pd.E+period : -1;
            }
            continue;
          }
          if(n.expect>=0){                                 // держим сетку: слово ждём на n.expect ±1
            if(cur!==n.expect+1) continue;
            let best=null;
            for(let d=-1;d<=1;d++){ const m=symMatch(n,n.expect+d,tolLock,thr-.1,pol,n.after-1); if(m && (!best || m.score>best.score)) best=m; }
            if(best){ n.miss=0; n.pend={E:best.E,g:best.g,o:best.o,e:best.e,w:best.w,hit:true,lock:n.lockId}; }
            else if(++n.miss>maxMiss){ n.expect=-1; n.miss=0; }
            else n.pend={E:n.expect,g:n.fg,o:n.fo,e:-1,w:null,hit:false,lock:n.lockId};
            continue;
          }
          if(n.w<pre+8) continue;
          const m=symMatch(n,cur,tol,thr,pol,Math.max(n.after,pre-1));
          if(m && cur-m.w.s.length+1-pre>=0){ n.lockId++; n.miss=0; n.pend={E:cur,g:m.g,o:m.o,e:m.e,w:m.w,hit:true,lock:n.lockId}; }
        }
      }
    }
    n.ui={frames:n.total, sync:{...n.sync}, id:n.fid, locked:n.expect>=0 || !!n.pend, miss:n.miss, words:W.map(w=>w.hex)};
    const RF=n.recent;                                  // кадры последних ~2 с символов: поток blk — «последнее значение», а основной поток читает реже воркера
    while(RF && RF.length && n.w-RF[0].w>9600) RF.shift();
    return {blk:RF && RF.length>1 ? {...n.frame, all:RF.map(r=>r.f)} : n.frame};
  }};

/* ============================ Передатчик: зеркало приёмной цепочки ============================
   Symbol Player (кадры blk → символы на частоте символов) → RRC Pulse Shaper (→ частота потока) → FM Modulator (→ IQ). */

/* ---- Symbol Player: очередь кадров blk → вещественный поток символов (уровни ±1, ±3), в паузах — 0 (несущая без модуляции) ---- */
IQK.symPlay={
  init(n){ n.q=[]; n.cur=null; n.pos=0; n.lastFid=0; n.acc=0; n.sent=0; n.ui=null; },
  process(n,I,ctx){
    const f=I.blk;
    if(f && f.id!==n.lastFid){                         // blk.all — пачка кадров за такт (передатчики со скоростью выше такта)
      for(const x of f.all||[f]) if(x.dib && (!f.all || x.id>n.lastFid)) n.q.push(x.dib);
      n.lastFid=f.id; }
    n.acc+=n.p.baud*ctx.block/ctx.sr;
    const K=Math.floor(n.acc); n.acc-=K;
    const out=iqStream(n,'out',n.p.baud,0), z=new Float32Array(K);
    for(let i=0;i<K;i++){
      if(!n.cur || n.pos>=n.cur.length){ n.cur=n.q.shift()||null; n.pos=0; if(n.cur) n.sent++; }
      z[i]=n.cur ? FSK4_LEV[n.cur[n.pos++]]||0 : 0;           // дибит 4 — нулевой уровень (пауза передатчика)
    }
    if(K) iqPush(out,z,null,null);
    n.ui={queued:n.q.length+(n.cur && n.pos<n.cur.length ? 1 : 0), sent:n.sent, sending:!!(n.cur && n.pos<n.cur.length),
      left:n.cur ? n.cur.length-n.pos : 0};
    return {out};
  }};

/* ---- RRC Pulse Shaper: символы (частота символов) → вещественный поток на частоте sr ----
   y(t) = Σ a_k·p(t − kT), p — RRC (α), нормирован так, что постоянный символ даёт тот же уровень (усиление по постоянной составляющей 1).
   Таблица шагом 1/64 символа, ±6 символов; задержка 6 символов (нужны будущие символы). */
const SYM_TAB_CACHE={};
function symRrcTab(alpha){
  if(SYM_TAB_CACHE[alpha]) return SYM_TAB_CACHE[alpha];
  const t=new Float32Array(769); let s=0;
  for(let i=0;i<769;i++){ t[i]=fsk4Rrc((i-384)/64,alpha); s+=t[i]; }
  s/=64; for(let i=0;i<769;i++) t[i]/=s;
  return SYM_TAB_CACHE[alpha]=t;
}
IQK.symShape={
  init(n){ n.key=''; n.sy=new Float32Array(0); n.base=0; n.m=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {out:null}; }
    const sro=+n.p.sr, baud=s.sr, key=sro+'|'+baud+'|'+n.p.alpha;
    if(key!==n.key){ n.key=key; n.tab=symRrcTab(n.p.alpha); n.sy=new Float32Array(0); n.base=0; n.m=0; }
    let add=0; for(const c of s.chunks) add+=c.re.length;
    const sy=new Float32Array(n.sy.length+add); sy.set(n.sy); let o=n.sy.length;
    for(const c of s.chunks){ sy.set(c.re,o); o+=c.re.length; }
    const base=n.base, top=base+sy.length, step=baud/sro, tab=n.tab;
    const out=iqStream(n,'out',sro,0), y=[];
    let m=n.m, tau, kc;
    for(;;){
      tau=m*step; kc=Math.floor(tau);
      if(kc+6>=top) break;
      let v=0;
      for(let k=kc-5;k<=kc+6;k++){ if(k<base) continue; const a=sy[k-base]; if(a) v+=a*tab[Math.round((tau-k+6)*64)]; }
      y.push(v); m++;
    }
    n.m=m;
    const keep=Math.max(0,kc-6-base);
    n.sy=keep>0 ? sy.slice(keep) : sy; n.base=base+(keep>0 ? keep : 0);
    if(y.length) iqPush(out,Float32Array.from(y),null,null);
    n.ui={sr:sro, baud, sps:sro/baud};
    return {out};
  }};

/* ---- FM Modulator: вещественный сигнал (±1, ±3 …) → IQ, девиация dev Гц на единицу, несущая на fc + off ---- */
IQK.fmMod={
  init(n){ n.ph=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {iq:null}; }
    const sr=s.sr, o=iqStream(n,'iq',sr,n.p.fc), a=Math.pow(10,n.p.lvl/20), k=2*Math.PI/sr, dev=n.p.dev, off=n.p.off;
    let ph=n.ph;
    for(const c of s.chunks){
      const x=c.re, K=x.length, re=new Float32Array(K), im=new Float32Array(K);
      for(let i=0;i<K;i++){ ph+=k*(off+dev*x[i]); re[i]=a*Math.cos(ph); im[i]=a*Math.sin(ph); }
      iqPush(o,re,im,c.tag);
    }
    n.ph=ph%(2*Math.PI);
    n.ui={sr, air:n.p.fc+off};
    return {iq:o};
  }};

/* ============================ Protocol Decoder (matched filter output): плагины 4FSK-приёмника ============================
   Тот же код протокола (синхрослова, захват, кадры, разбор), что у Digital Voice Decoder, но вход — не IQ, а выход согласованного фильтра:
   вещественный поток после FM Discriminator → RRC Matched Filter (любая частота ≥ 2 × бод). Дальше — как в монолите: 8 фаз такта на символ,
   лучшая фаза и уровни — по подгонке синхрослова (слепая петля такта на узком глазе этих протоколов — α = 0.2 — хуже), кадровая сетка по слову.
   proto = auto — все протоколы со скоростью baud. */
IQK.fskSym=(()=>{
  const K=fsk4Node(n=>n.ids||[]);
  const pickIds=n=>{
    const p=n.p.proto;
    if(!p || p==='auto') return FSK4.order.filter(id=>Math.abs(FSK4.protos[id].baud-n.p.baud)<1);
    return FSK4.protos[p] ? [p] : [];
  };
  return {
    init(n){ K.init(n); },
    process(n,I){
      const s=iqIn(I,'in');
      if(!s){ n.ui=null; return {rec:null, voice:null}; }
      const ids=pickIds(n), key=s.sr+'|'+ids.join();
      if(key!==n.key){ n.key=key; n.cplx=false; K.setup(n,s,false,ids); }
      const out={recs:[], voice:[]};
      if(!ids.length || s.sr<2*Math.max(...ids.map(id=>FSK4.protos[id].baud))){
        n.ui={fs:s.sr, M:1, protos:{}, active:null, err:ids.length ? 'sample rate must be ≥ 2 × baud' : 'no protocol with '+n.p.baud+' Bd'};
        n.ui.text=n.ui.err; return {rec:null, voice:null};
      }
      for(const ch of n.ch){
        let add=0; for(const c of s.chunks) add+=c.re.length;
        const nx=new Float32Array(ch.x.length+add); nx.set(ch.x); let o=ch.x.length;
        for(const c of s.chunks){ nx.set(c.re,o); o+=c.re.length; }
        ch.x=nx;
        K.scan(n,ch,out);
      }
      const now=Date.now(), ui={fs:n.fs, M:1, protos:{}, active:null};
      for(const ch of n.ch) if(ch.lock) ui.active=ch.lock.proto.id;
      for(const id of n.ids){
        const pr=FSK4.protos[id], L=n.ch.map(c=>c.lock).find(l=>l && l.proto===pr) || null;
        ui.protos[id]=pr.ui(n.pr[id],L,now,n);
      }
      n.ui=n.ids.length===1 ? Object.assign(ui,ui.protos[n.ids[0]]) : ui;
      return {rec:out.recs.length ? out.recs : null, voice:out.voice.length ? out.voice : null};
    }};
})();
