"use strict";
/* ============================ POCSAG (пейджеры, 512 / 1200 / 2400 Бод) ============================
   Ядро IQK (страница и воркер), без DOM. ЧМ → звук; 2-FSK ±4.5 кГц, NRZ, старший бит вперёд.
   Передача: преамбула 1010…, затем пакеты: синхрослово 0x7CD215D8 и 16 кодовых слов (8 кадров по 2).
   Слово 32 бита: бит 31 — 0 адрес / 1 сообщение; адрес: 18 бит адреса (RIC = адрес·8 + номер кадра),
   2 бита функции; сообщение: 20 бит данных; 10 проверочных BCH(31,21), полином 0x769, и бит чётности (чётное число
   единиц во всём слове). Свободное слово — 0x7A89C197. Сообщение идёт словами подряд до следующего адреса или
   свободного слова, через границу пакета (синхрослово пропускается).
   Полярность по стандарту (ITU-R M.584): 1 — нижняя частота (−4.5 кГц), 0 — верхняя; приёмник берёт любую.
   Текст: 7-битные символы младшим битом вперёд поверх потока 20-битных данных; цифры: тетрады младшим вперёд,
   «0123456789*U -][».
   Скорость ищется перебором всех трёх, тактовая фаза — 8 сдвигами решётки по ⅛ бита, полярность — по синхрослову
   или его инверсии. Порог — скользящее среднее звука по 48 символам вокруг решения. */

const POC_SYNC=0x7CD215D8, POC_IDLE=0x7A89C197, POC_PH=8, POC_W=48, POC_BAUDS=[512,1200,2400], POC_CLIP=12000;
const POC_NUM='0123456789*U -][';
function pocPop(v){ v-=(v>>>1)&0x55555555; v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
// остаток от деления слова (без бита чётности, бит 31 — старшая степень) на x^10+x^9+x^8+x^6+x^5+x^3+1
function pocRem(w){
  let r=w>>>1;
  for(let i=30;i>=10;i--) if((r>>>i)&1) r^=0x769<<(i-10);
  return r&0x3FF;
}
// проверочные биты и чётность для 21 информационного бита
function pocEncode(info21){
  const w=((info21<<11)>>>0), r=pocRem(w|0), cw=(w|(r<<1))>>>0;
  return (cw|(pocPop(cw)&1))>>>0;
}
// таблица синдромов: ключ (остаток<<1 | чётность) → шаблон ошибки, число ошибок
const POC_SYN=(()=>{
  const m=new Map(), add=(e,k)=>{ const key=(pocRem(e)<<1)|(pocPop(e)&1); if(!m.has(key)) m.set(key,[e>>>0,k]); };
  for(let i=0;i<32;i++) add(1<<i,1);
  for(let i=0;i<32;i++) for(let j=i+1;j<32;j++) add((1<<i)|(1<<j),2);
  return m;
})();
// слово → [исправленное слово, число исправленных ошибок] или null; maxErr 0…2
function pocFix(w,maxErr){
  const s=pocRem(w), p=pocPop(w)&1;
  if(!s && !p) return [w>>>0,0];
  if(!maxErr) return null;
  const e=POC_SYN.get((s<<1)|p);
  return e && e[1]<=maxErr ? [(w^e[0])>>>0,e[1]] : null;
}
// биты данных сообщения → строка
function pocAlpha(bits){
  let s='';
  for(let i=0;i+7<=bits.length;i+=7){
    let c=0; for(let k=0;k<7;k++) c|=bits[i+k]<<k;
    if(c===0 || c===4) break;                          // NUL / EOT — конец
    s+=c===10 || c===13 ? ' ' : c<32 || c===127 ? '·' : String.fromCharCode(c);
  }
  return s.replace(/\s+$/,'');
}
function pocNumeric(bits){
  let s='';
  for(let i=0;i+4<=bits.length;i+=4) s+=POC_NUM[bits[i]|(bits[i+1]<<1)|(bits[i+2]<<2)|(bits[i+3]<<3)];
  return s.replace(/\s+$/,'');
}

IQK.pocsagRx={
  init(n){ n.key=''; n.msgs=0; n.cws=0; n.bad=0; n.fixed=0; n.syncs=0; n.recent=[]; n.lastMsg=0; n.baud=null; n.pend=[]; n.tNow=0; },
  setup(n,s,cplx){
    const M=cplx ? Math.max(1,Math.floor(s.sr/24000)) : 1;
    n.M=M; n.fs=s.sr/M;
    n.dec=M>1 ? {p:{M:String(M), cut:Math.min(.45,12000/n.fs), tpp:'16'}} : null;
    if(n.dec) IQK.iqDecim.init(n.dec);
    const stop=Math.min(11500,.47*n.fs);
    n.lp=cplx ? kaiserLP(n.fs,Math.min(8000,.6*stop),stop,255) : null;
    if(n.lp){ n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1); }
    n.pr=0; n.pi=0;
    n.x=new Float32Array(0); n.xb=0;
    const sel=String(n.p.baud||'auto');
    n.lanes=POC_BAUDS.filter(b=>sel==='auto' || +sel===b).map(b=>{
      const sps=n.fs/b, lane={baud:b, sps, tNext:0, jj:0, ph:[]};
      for(let i=0;i<POC_PH;i++) lane.ph.push({reg:0, state:0, pol:0, nb:0, idx:0, msg:null, quiet:0});
      return lane;
    });
    n.cfgKey=sel+'|'+n.p.fix;
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null}; }
    const cplx=s.chunks.length ? !!s.chunks[0].im : n.cplx;
    const key=s.sr+'|'+cplx+'|'+n.p.baud;
    if(key!==n.key){ n.key=key; n.cplx=cplx; this.setup(n,s,cplx); }
    const src=n.dec ? IQK.iqDecim.process(n.dec,{in:s}).out : s;
    const parts=[];
    for(const c of src.chunks){
      let y;
      if(!n.cplx) y=Float32Array.from(c.re);
      else {
        const xr=firRun(n.lp,n.lr,c.re), xi=firRun(n.lp,n.li,iqChunkIm(c)), K=xr.length, k=n.fs/(2*Math.PI);
        y=new Float32Array(K);
        let pr=n.pr, pi=n.pi;
        for(let i=0;i<K;i++){
          const p=xr[i], q=xi[i], v=Math.atan2(q*pr-p*pi, p*pr+q*pi)*k;
          y[i]=v>POC_CLIP ? POC_CLIP : v<-POC_CLIP ? -POC_CLIP : v; pr=p; pi=q;
        }
        n.pr=pr; n.pi=pi;
      }
      parts.push(y);
    }
    let add=0; for(const p of parts) add+=p.length;
    const nx=new Float32Array(n.x.length+add); nx.set(n.x); let o=n.x.length;
    for(const p of parts){ nx.set(p,o); o+=p.length; }
    n.x=nx;
    const recs=[];
    this.scan(n,recs);
    this.flush(n,recs);
    const now=Date.now();
    n.ui={fs:n.fs, M:n.M, msgs:n.msgs, cws:n.cws, fixed:n.fixed, bad:n.bad, syncs:n.syncs, baud:n.baud,
      age:n.lastMsg ? now-n.lastMsg : null, recent:n.recent.slice(-8)};
    return {rec:recs.length ? recs : null};
  },
  scan(n,recs){
    const x=n.x, N=x.length, P=POC_PH;
    const S=new Float64Array(N+1);
    for(let i=0;i<N;i++) S[i+1]=S[i]+x[i];
    const integ=t=>{ if(t<=0) return 0; if(t>=N) return S[N]; const a=Math.floor(t); return S[a]+(t-a)*x[a]; };
    const avg=(a,b)=>{ a=Math.max(0,a); b=Math.min(N,b); return b>a ? (integ(b)-integ(a))/(b-a) : 0; };
    let keep=N;
    for(const L of n.lanes){
      const sps=L.sps, half=POC_W*sps/2, hw=sps/4, step=sps/P;
      let tj=L.tNext-n.xb;
      if(tj<0) tj=0;
      while(tj+half+hw<N-1){
        const bit=avg(tj-hw,tj+hw)>avg(tj-half,tj+half) ? 1 : 0;
        this.feed(n,L,L.ph[L.jj%P],bit,(n.xb+tj)/n.fs,recs);
        L.jj++; tj+=step;
      }
      L.tNext=n.xb+tj;
      keep=Math.min(keep,Math.floor(tj-half-2*sps));
    }
    if(keep>0){ n.x=x.slice(keep); n.xb+=keep; }
  },
  // один бит одной фазы одной скорости
  feed(n,L,d,bit,te,recs){
    if(te>n.tNow) n.tNow=te;
    d.reg=((d.reg<<1)|bit)>>>0;
    if(d.state===0){
      const a=pocPop((d.reg^POC_SYNC)>>>0), b=pocPop((d.reg^~POC_SYNC)>>>0);
      if(a<=2 || b<=2){ d.state=1; d.pol=a<=2 ? 0 : 1; d.nb=0; d.idx=0; d.bad=0; n.syncs++; }
      return;
    }
    if(++d.nb<32) return;
    d.nb=0;
    const w=(d.pol ? ~d.reg : d.reg)>>>0;
    if(d.idx<0){                                       // ждём синхрослово следующего пакета
      if(pocPop((w^POC_SYNC)>>>0)<=4){ d.idx=0; return; }
      this.finish(n,L,d,te,recs);
      d.state=0; return;
    }
    const fx=pocFix(w,+n.p.fix);
    n.cws++;
    if(!fx){
      n.bad++;
      if(d.msg){ d.msg.bad++; for(let k=19;k>=0;k--) d.msg.bits.push((w>>>(11+k))&1); }
    } else {
      if(fx[1]) n.fixed++;
      const c=fx[0];
      if(c===POC_IDLE) this.finish(n,L,d,te,recs);
      else if(c>>>31){
        if(d.msg){ for(let k=19;k>=0;k--) d.msg.bits.push((c>>>(11+k))&1); if(fx[1]) d.msg.fixed+=fx[1]; }
      } else {
        this.finish(n,L,d,te,recs);
        d.msg={ric:(((c>>>13)&0x3FFFF)<<3)|((d.idx>>1)&7), func:(c>>>11)&3, bits:[], bad:0, fixed:fx[1], t:te};
      }
    }
    if(++d.idx>=16) d.idx=-1;
  },
  // готовое сообщение одной фазы — кандидат: все фазы читают одни и те же биты, поэтому сообщения с одним началом
  // (в пределах 8 бит) — одно и то же; остаётся то, где меньше ошибок. Выдаём, когда кандидаты перестали приходить.
  finish(n,L,d,te,recs){
    const m=d.msg; d.msg=null;
    if(!m) return;
    const alpha=pocAlpha(m.bits), num=pocNumeric(m.bits);
    const kind=!m.bits.length ? 'tone' : m.func===0 ? 'numeric' : 'alpha';
    const text=kind==='tone' ? '' : kind==='numeric' ? num : alpha;
    const r={src:'POCSAG', kind:'message', id:String(m.ric), to:String(m.ric), ric:m.ric, func:m.func, type:kind, baud:L.baud, text};
    if(kind!=='tone'){ r.alpha=alpha; r.num=num; }
    if(m.bad || m.fixed){ r.errors=m.bad; r.fixed=m.fixed; }
    const score=m.bad*1000+m.fixed, key=m.ric+'|'+m.func+'|'+text;
    for(const p of n.pend) if(p.baud===L.baud && Math.abs(p.start-m.t)<8/L.baud){
      const c=p.c.get(key);
      if(c) c.votes++; else p.c.set(key,{rec:r, score, votes:1});
      p.due=Math.max(p.due,te+0.3);
      return;
    }
    n.pend.push({baud:L.baud, start:m.t, due:te+0.3, c:new Map([[key,{rec:r, score, votes:1}]])});
  },
  flush(n,recs){
    for(let i=n.pend.length-1;i>=0;i--){
      const p=n.pend[i];
      if(p.due>n.tNow) continue;
      n.pend.splice(i,1);
      let best=null;                                   // без ошибок или подтверждена соседними фазами: на мусоре фазы расходятся
      for(const c of p.c.values()) if((c.score===0 || c.votes>=2) && (!best || c.score<best.score || (c.score===best.score && c.votes>best.votes))) best=c;
      if(!best) continue;
      const r=best.rec, now=Date.now();
      r.t=now; n.msgs++; n.lastMsg=now; n.baud=r.baud;
      n.recent.push(r.ric+' f'+r.func+' '+r.baud+' · '+(r.type==='tone' ? 'tone' : r.text.slice(0,60))+(r.errors ? ' ('+r.errors+' bad)' : ''));
      if(n.recent.length>20) n.recent.shift();
      recs.push(r);
    }
  }};

/* ---- генератор: пейджинг с тремя типами сообщений ---- */
function pocBatches(cwList,pre){                       // слова-сообщения → поток битов (преамбула pre бит, пакеты)
  const bits=[];
  for(let i=0;i<(pre||576);i++) bits.push(i&1 ? 0 : 1);
  const putw=w=>{ for(let k=31;k>=0;k--) bits.push((w>>>k)&1); };
  const words=cwList.slice();
  while(words.length%16) words.push(POC_IDLE);
  for(let b=0;b<words.length;b+=16){ putw(POC_SYNC); for(let i=0;i<16;i++) putw(words[b+i]); }
  return bits;
}
function pocAddrWord(ric,func){ return pocEncode(((ric>>>3)&0x3FFFF)<<2|func); }
function pocDataWords(bits){                           // биты → 20-битные слова сообщения (добор нулями)
  const out=[];
  for(let i=0;i<bits.length;i+=20){
    let v=1; for(let k=0;k<20;k++) v=(v<<1)|(bits[i+k]||0);
    out.push(pocEncode(v));
  }
  return out;
}
function pocAlphaBits(s){ const b=[]; for(const ch of s+'\x04'){ const c=ch.charCodeAt(0); for(let k=0;k<7;k++) b.push((c>>k)&1); } return b; }
function pocNumBits(s){ const b=[]; for(const ch of s){ const v=Math.max(0,POC_NUM.indexOf(ch)); for(let k=0;k<4;k++) b.push((v>>k)&1); } return b; }
// сообщение для адреса ric: кадр = ric & 7, слова до него заполняются свободными
function pocMessage(ric,func,bits){
  const words=[]; for(let i=0;i<(ric&7)*2;i++) words.push(POC_IDLE);
  words.push(pocAddrWord(ric,func));
  if(bits) for(const w of pocDataWords(bits)) words.push(w);
  return words;
}
const POC_SIM=[
  {ric:1234567, func:3, text:'TEST PAGE: SERVER ROOM TEMPERATURE HIGH'},
  {ric:1234568, func:0, num:'112 5551234 U 9'},
  {ric:1000001, func:3, text:'Hello from the DSP workbench'},
  {ric:1234567, func:1, tone:true}];
function pocGenerate(n,sr,N){
  let g=n.poc;
  const baud=+n.p.pocsag||1200;
  if(!g || g.sr!==sr || g.baud!==baud) g=n.poc={sr, baud, k:0, f:null, pos:0, gap:Math.round(sr*.3), ph:0, lp:0};
  const re=new Float32Array(N), im=new Float32Array(N);
  for(let i=0;i<N;i++){
    if(!g.f){
      if(g.gap>0){ g.gap--; continue; }
      const m=POC_SIM[g.k++%POC_SIM.length];
      const bits=pocBatches(pocMessage(m.ric,m.func,m.tone ? null : m.num ? pocNumBits(m.num) : pocAlphaBits(m.text)));
      const spb=sr/baud, f=new Float32Array(Math.ceil(bits.length*spb)+8);
      for(let k=0;k<f.length;k++){ const b=bits[Math.min(bits.length-1,Math.floor(k/spb))]; f[k]=b ? -4500 : 4500; }
      g.f=f; g.pos=0; g.lp=f[0];
    }
    g.lp+=(g.f[g.pos]-g.lp)*Math.min(1,2*Math.PI*0.6*g.baud/sr);   // сглаживание фронтов
    g.ph+=2*Math.PI*g.lp/sr;
    re[i]=Math.cos(g.ph); im[i]=Math.sin(g.ph);
    if(++g.pos>=g.f.length){ g.f=null; g.gap=Math.round(sr*(1.0+0.5*((g.k*0.618)%1))); g.ph%=2*Math.PI; }
  }
  return [re,im];
}

/* ---- кодер: сообщение → биты в эфире ---- */
// дополнение до целого числа слов: текст — нулями после EOT, цифры — пробелами (0xC)
function pocTxData(kind,text){
  let b;
  if(kind==='numeric'){
    b=pocNumBits(String(text).toUpperCase().replace(/\(/g,'[').replace(/\)/g,']').replace(/[^0-9*U \-\[\]]/g,' '));
    while(b.length%20) b.push(...[0,0,1,1]);
  } else {
    b=pocAlphaBits(String(text).replace(/[^\x20-\x7E\r\n]/g,'?'));
    while(b.length%20) b.push(0);
  }
  return b;
}
// RIC и функция, чей адресный код совпал бы с синхрословом или свободным словом, передавать нельзя
function pocTxCheck(ric,func){
  if(!(ric>=0 && ric<=2097151 && ric===Math.floor(ric))) return 'RIC must be 0…2097151';
  const w=pocAddrWord(ric,func);
  if(w===POC_IDLE || w===POC_SYNC) return 'this RIC and function make the idle word — pick another';
  return '';
}
function pocTxBits(ric,func,kind,text,pre){
  return pocBatches(pocMessage(ric,func,kind==='tone' ? null : pocTxData(kind,text)),pre);
}
