"use strict";
/* ============================ ISM 433 МГц ============================
   Ядро IQK (страница и воркер), без DOM. IQ → канальный фильтр → огибающая (OOK) и/или частота (FSK) →
   пороговый слайсер с гистерезисом → цепочка импульсов (метка, пауза, …) в микросекундах →
   анализатор (кластеры длительностей: PWM, PPM, Манчестер/PCM; разбиение на повторы по длинной паузе) →
   парсеры протоколов (ISM_PROTOS) → записи. Неопознанные пакеты — с типом модуляции, таймингами и битами. */

/* ---- разбор цепочки импульсов ---- */
// Кластеры длительностей: отсортированные значения, новый кластер — если значение больше среднего текущего в ratio раз
function ismCluster(v,ratio){
  ratio=ratio||1.3;
  const a=Array.from(v).sort((x,y)=>x-y), out=[];
  let cur=null;
  for(const x of a){
    if(cur && x<=cur.sum/cur.n*ratio){ cur.sum+=x; cur.n++; cur.max=x; }
    else { cur={min:x, max:x, sum:x, n:1}; out.push(cur); }
  }
  for(const c of out) c.mean=c.sum/c.n;
  return out;
}
// оставить кластеры, в которых не меньше 4% значений (и не меньше двух)
function ismSig(cl,total){ const m=Math.max(2,Math.ceil(.04*total)); return cl.filter(c=>c.n>=m); }
function ismHex(b){
  let s='';
  for(let i=0;i<b.length;i+=4){ let v=0; for(let j=0;j<4;j++) v=v*2+(b[i+j]||0); s+=v.toString(16); }
  return s.toUpperCase();
}
function ismInt(b,pos,len){ let v=0; for(let i=0;i<len;i++) v=v*2+(b[pos+i]||0); return v; }

/* E — длительности в мкс (метка, пауза, …, метка), G — пауза после последней метки (до конца пакета).
   Результат: {mod:'PWM'|'PPM'|'MAN'|'PCM', rows:[Uint8Array], short, long, gap, T, mark, pulses} или null. */
function ismAnalyze(E,G){
  const nm=(E.length+1)>>1;
  if(nm<8) return null;
  const M=[], S=[];
  for(let i=0;i<E.length;i++) (i&1 ? S : M).push(E[i]);
  while(S.length<nm) S.push(-1);                       // после последней метки пауза неизвестна
  const known=S.slice(0,nm-1);
  // длинная пауза между повторами: редкий верхний кластер пауз с регулярным шагом (или на краю)
  const gapSet=new Set();
  let gap=0;
  if(known.length>=4){
    const cs=ismCluster(known);
    if(cs.length>=2){
      const top=cs[cs.length-1], prev=cs[cs.length-2];
      if(top.mean>=1.7*prev.mean && top.n*4<=known.length){
        const thr=Math.sqrt(prev.mean*top.mean), idx=[];
        known.forEach((s,i)=>{ if(s>=thr) idx.push(i); });
        let ok=top.mean>=3.5*prev.mean;                // явная тишина между повторами
        if(!ok && idx.length>=2){ const d=idx[1]-idx[0]; ok=true; for(let k=2;k<idx.length;k++) if(idx[k]-idx[k-1]!==d) ok=false; }
        else if(!ok) ok=cs.length>=3 || idx[0]===0 || idx[0]===known.length-1;
        if(ok){ for(const i of idx) gapSet.add(i); gap=top.mean; }
      }
    }
  }
  // строки: пары (метка, пауза) между паузами-разделителями
  const rows=[]; let cur=[];
  for(let i=0;i<nm;i++){
    if(gapSet.has(i)){ cur.tail=M[i]; if(cur.length) rows.push(cur); cur=[]; }
    else cur.push([M[i],S[i]]);
  }
  if(cur.length) rows.push(cur);
  // последняя строка длиннее остальных на одну пару — это синхроимпульс следующего повтора
  if(rows.length>=2){
    const cnt=new Map(); for(let r=0;r<rows.length-1;r++) cnt.set(rows[r].length,(cnt.get(rows[r].length)||0)+1);
    let L=0,best=0; for(const [len,c] of cnt) if(c>best){ best=c; L=len; }
    const last=rows[rows.length-1];
    if(last.length===L+1 && last[last.length-1][1]<0) last.pop();
  }
  const mk=[], sp=[], per=[];
  for(const r of rows) for(const p of r){ mk.push(p[0]); if(p[1]>=0){ sp.push(p[1]); per.push(p[0]+p[1]); } }
  if(mk.length<8) return null;
  const cM=ismSig(ismCluster(mk),mk.length), cS=ismSig(ismCluster(sp),sp.length), cP=ismSig(ismCluster(per,1.2),per.length);
  const ratio=c=>c[1].mean/c[0].mean;
  const an={rows:[], gap, pulses:nm, mark:cM.length ? cM[0].mean : 0, short:0, long:0, T:0, mod:''};
  const toBits=(r,f)=>{ const b=[]; for(const p of r){ const v=f(p); if(v>=0) b.push(v); } return Uint8Array.from(b); };
  if(cM.length===2 && ratio(cM)>=1.5 && ratio(cM)<=6 && (cS.length===1 || cP.length===1)){
    const thr=Math.sqrt(cM[0].mean*cM[1].mean);
    an.mod='PWM'; an.short=cM[0].mean; an.long=cM[1].mean;
    an.rows=rows.map(r=>toBits(r,p=>p[0]>thr ? 1 : 0));
  } else if(cS.length===2 && ratio(cS)>=1.5 && ratio(cS)<=6 && cM.length===1){
    const thr=Math.sqrt(cS[0].mean*cS[1].mean);
    an.mod='PPM'; an.short=cS[0].mean; an.long=cS[1].mean;
    an.rows=rows.map(r=>toBits(r,p=>p[1]<0 ? -1 : p[1]>thr ? 1 : 0));
  } else {
    // решётка кратных T: Манчестер или PCM; при шуме и длинных сериях одинаковых бит кластеров много — T ищем по периодичности
    const all=mk.concat(sp), cA=ismSig(ismCluster(all,1.25),all.length);
    let T=0;
    if(cA.length>=2 && cA.length<=4){
      T=cA[0].mean;
      for(const c of cA){ const q=c.mean/T; if(Math.abs(q-Math.round(q))>.25) T=0; }
    }
    if(!T) T=ismFindT(all);
    if(!T) return null;
    an.T=T; an.short=T; an.long=cA.length ? cA[cA.length-1].mean : 0;
    // весь пакет → отрезки полубит; серия длиннее 12 T — пауза, отрезок кончается (деление на строки выше для решётки не годится:
    // в NRZ редкие длинные серии похожи на паузы между повторами)
    const segs=[]; let h=[];
    const put=(l,w)=>{ const u=Math.max(1,Math.round(w/T)); if(u>12){ if(h.length) segs.push(h); h=[]; return; } for(let i=0;i<u;i++) h.push(l); };
    for(let i=0;i<nm;i++){ put(1,M[i]); if(S[i]>=0) put(0,S[i]); }
    if(h.length) segs.push(h);
    // Манчестер: пара полубит 01 → 1, 10 → 0; фаза каждой строки — с наименьшим числом недопустимых пар
    const man=(h,ph)=>{ const b=[]; let bad=0;
      for(let i=ph;i+1<h.length;i+=2){ if(h[i]===h[i+1]) bad++; else b.push(h[i+1]); }
      return {b, bad}; };
    let tot=0, bad=0;
    const hbs=segs, dm=hbs.map(h=>{ const a=man(h,0), b=man(h,1), m=b.bad<a.bad ? b : a; tot+=h.length>>1; bad+=m.bad; return m; });
    if(tot && bad<=.03*tot){ an.mod='MAN'; an.rows=dm.map(m=>Uint8Array.from(m.b)); }
    else { an.mod='PCM'; an.rows=hbs.map(h=>Uint8Array.from(h)); }
  }
  an.rows=an.rows.filter(r=>r.length>=4);
  return an.rows.length ? an : null;
}
// длительность бита T (мкс) по периодичности серий: T, при котором cos(2π·длит/T) в среднем ближе всего к 1;
// из подходящих берётся наибольшая (кратные ½T тоже подходят), затем уточняется методом наименьших квадратов
function ismFindT(v){
  const r=v.filter(x=>x>=30).sort((a,b)=>a-b);
  if(r.length<12) return 0;
  const tmax=1.3*r[r.length>>1], sc=[];
  let best=0;
  for(let T=40;T<=tmax;T*=1.015){
    let s=0; for(const x of r) s+=Math.cos(2*Math.PI*x/T);
    s/=r.length; sc.push([T,s]); if(s>best) best=s;
  }
  if(best<.7) return 0;
  let T=0; for(const [t,s] of sc) if(s>=.92*best) T=t;
  let sxn=0,snn=0; for(const x of r){ const k=Math.round(x/T); if(k>0){ sxn+=x*k; snn+=k*k; } }
  return snn ? sxn/snn : 0;
}
// самая частая строка среди rows (по длине len, если задана): {bits, agree, rows}
function ismBestRow(rows,len){
  const m=new Map(); let n=0;
  for(const r of rows){ if(len && r.length!==len) continue; n++; const k=r.join(''); const e=m.get(k); if(e) e.c++; else m.set(k,{r,c:1}); }
  let best=null; for(const e of m.values()) if(!best || e.c>best.c) best=e;
  return best ? {bits:best.r, agree:best.c, rows:n} : null;
}

/* ---- протоколы ---- */
// EV1527 / PT2262 (пульты, датчики двери, звонки): PWM, 24 бита = 20 адрес + 4 данные, метка T/3T, пауза 31T
function ismEv1527(an){
  if(an.mod!=='PWM') return null;
  let r=ismBestRow(an.rows,24);
  if(!r){                                              // пакет оборван на паузе: 24 бита и синхроимпульс следующего повтора
    r=ismBestRow(an.rows,25);
    if(!r || r.bits[24]) return null;
    r.bits=r.bits.slice(0,24);
  }
  const q=an.long/an.short;
  if(q<2.3 || q>3.8 || an.short<100 || an.short>900) return null;
  if(an.gap && an.gap<12*an.short) return null;
  const b=r.bits;
  let tr='';
  for(let i=0;i<24;i+=2){ const x=b[i]*2+b[i+1]; tr+=x===0 ? '0' : x===3 ? '1' : 'F'; }
  const addr=ismHex(b.slice(0,20)).slice(0,5), data=ismInt(b,20,4);
  return {proto:'EV1527/PT2262', kind:'remote', id:'ev1527:'+addr, addr, data, trits:tr,
    btn:[8,4,2,1].map((m,i)=>data&m ? 'D'+(3-i) : '').join('') || '-', agree:r.agree, nrows:r.rows,
    text:'EV1527 addr '+addr+' data '+data.toString(2).padStart(4,'0')+' · trits '+tr};
}
// Nexus / TFA / Digitech и клоны (термо-гигро датчики): PPM, метка ~500 мкс, пауза 1000 (0) / 2000 (1), 36 бит
function ismNexus(an){
  if(an.mod!=='PPM') return null;
  const r=ismBestRow(an.rows,36); if(!r) return null;
  if(an.mark<250 || an.mark>800 || an.short<700 || an.short>1400 || an.long<1600 || an.long>2600) return null;
  const b=r.bits;
  if(ismInt(b,24,4)!==15) return null;
  const id=ismInt(b,0,8), bat=b[8], tx=b[9], ch=ismInt(b,10,2)+1;
  let raw=ismInt(b,12,12); if(raw&0x800) raw-=0x1000;
  const temp=raw/10, hum=ismInt(b,28,8);
  if(hum>100 || temp<-40 || temp>80) return null;
  const idh=id.toString(16).toUpperCase().padStart(2,'0');
  return {proto:'Nexus', kind:'sensor', id:'nexus:'+idh+'/'+ch, dev:idh, channel:ch, temp_c:temp, humidity:hum,
    battery_ok:bat, manual:tx, agree:r.agree, nrows:r.rows,
    text:'Nexus '+idh+' ch'+ch+' '+temp.toFixed(1)+' °C '+hum+' %'+(bat ? '' : ' · low battery')};
}
const ISM_PROTOS=[ismEv1527, ismNexus];

function ismDecode(an){
  for(const f of ISM_PROTOS){ const r=f(an); if(r) return r; }
  const b=an.rows.reduce((a,r)=>r.length>a.length ? r : a, an.rows[0]);
  const hex=ismHex(b), t=an.mod==='PWM'||an.mod==='PPM' ? Math.round(an.short)+'/'+Math.round(an.long)+' µs' : 'T '+Math.round(an.T)+' µs';
  const best=ismBestRow(an.rows);
  return {proto:'unknown', kind:'unknown', id:an.mod+':'+hex.slice(0,16), bitlen:b.length, hex, agree:best?best.agree:1, nrows:an.rows.length,
    text:an.mod+' '+b.length+' bit · '+hex+' · '+t+(an.gap ? ' · gap '+Math.round(an.gap)+' µs' : '')};
}

/* ---- слайсер: уровень → цепочка импульсов ---- */
function ismSlicer(){ return {active:false, state:0, run:0, E:[], pend:-1, sumF:0, cntF:0, hiMax:0, t0:0}; }
// закрыть прогон длиной len отсчётов; короткие (глитчи) вливаются в соседние прогоны
function ismClose(n,sl,len){
  if(sl.pend>=0){ len+=sl.pend+sl.E.pop(); sl.pend=-1; }
  if(len<n.gS){
    if(!sl.E.length){ sl.active=false; return; }       // первая метка слишком короткая — не пакет
    sl.pend=len; return;
  }
  sl.E.push(len);
}
function ismFinish(n,sl,recs,fc,mod){
  const fs=n.fs, k=1e6/fs, E=sl.E;
  sl.active=false; sl.pend=-1;
  if(E.length<2*n.minBits-1) return;
  const us=E.map(x=>x*k), an=ismAnalyze(us,sl.run*k);
  n.packets++;
  let d=an ? ismDecode(an) : null;
  if(!d){
    if(!n.raw) return;
    d={proto:'unknown', kind:'unknown', id:'?:'+us.length, hex:'', bitlen:0, text:us.length+' pulses '+Math.round(Math.min(...us))+'…'+Math.round(Math.max(...us))+' µs, no structure'};
  } else if(d.kind==='unknown' && (!n.raw || d.bitlen<n.minBits)) return;
  const key=d.proto+'|'+(d.hex||d.id);
  const last=n.seen.get(key);
  if(last!==undefined && n.ts-last<n.dedup){ n.seen.set(key,n.ts); n.dups++; return; }
  n.seen.set(key,n.ts);
  if(n.seen.size>200) for(const [kk,v] of n.seen) if(n.ts-v>60) n.seen.delete(kk);
  const rec={t:Date.now(), src:'ISM', mod, ...d};
  const foff=sl.cntF ? sl.sumF/sl.cntF : 0;
  if(fc) rec.freq=Math.round(fc+foff);
  rec.foff=Math.round(foff);
  rec.rssi=+(20*Math.log10(Math.max(sl.hiMax,1e-6))).toFixed(1);
  rec.snr=+(20*Math.log10(Math.max(sl.hiMax,1e-6)/Math.max(n.nz,1e-6))).toFixed(1);
  if(an){ rec.pulses=an.pulses; rec.enc=an.mod; if(an.short) rec.short=Math.round(an.short); if(an.long) rec.long=Math.round(an.long); if(an.gap) rec.gap=Math.round(an.gap); }
  if(d.kind==='unknown') n.unk++; else n.dec++;
  n.lastPkt=Date.now();
  n.recent.push(mod+' '+d.text); if(n.recent.length>20) n.recent.shift();
  recs.push(rec);
}
function ismFeed(n,sl,lvl,recs,fc,mod,f1,e1){
  if(!sl.active){
    if(lvl){ sl.active=true; sl.state=1; sl.run=1; sl.E=[]; sl.pend=-1; sl.sumF=0; sl.cntF=0; sl.hiMax=0; }
    else return;
  } else if(lvl===sl.state){
    sl.run++;
    if(!sl.state){ if(sl.run>n.resetS){ ismFinish(n,sl,recs,fc,mod); return; } }
    else if(sl.run>n.maxMark){ sl.active=false; return; }        // несущая без пауз — не пакет
  } else {
    ismClose(n,sl,sl.run);
    if(!sl.active) return;
    sl.state=lvl; sl.run=1;
  }
  if(sl.state){ sl.sumF+=f1; sl.cntF++; }
  if(e1>sl.hiMax) sl.hiMax=e1;
  if(sl.E.length>4000) sl.active=false;
}

IQK.ismRx={
  init(n){ n.key=''; n.recent=[]; n.packets=0; n.dec=0; n.unk=0; n.dups=0; n.lastPkt=0; },
  setup(n,s){
    const M=Math.max(1,Math.floor(s.sr/250000));
    n.M=M; n.fs=s.sr/M;
    n.decim=M>1 ? {p:{M:String(M), cut:.45, tpp:'16'}} : null;
    if(n.decim) IQK.iqDecim.init(n.decim);
    const half=Math.min(.45*n.fs,(+n.p.bw||100000)/2);
    n.lp=kaiserLP(n.fs,.8*half,Math.min(.48*n.fs,1.25*half),127);
    n.lr=new Float32Array(n.lp.length-1); n.li=new Float32Array(n.lp.length-1);
    n.ae=1-Math.exp(-1/(n.fs*16e-6));
    n.kHi=1/(.1*n.fs); n.kF=1/(.02*n.fs); n.kf=n.fs/(2*Math.PI);
    n.e1=0; n.hi=0; n.nz=0; n.cnt=0; n.pr=1; n.pq=0; n.f1=0; n.lo=0;
    n.fh=0; n.fl=0; n.pres=0; n.lf=0;
    n.ook=ismSlicer(); n.fsk=ismSlicer();
    n.ts=0; n.seen=new Map();
  },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.ui=null; return {rec:null}; }
    const key=s.sr+'|'+n.p.bw;
    if(key!==n.key){ n.key=key; this.setup(n,s); }
    const P=n.p, fs=n.fs, recs=[], fc=s.fc||0;
    n.gS=Math.max(2,Math.round(fs*30e-6));
    n.resetS=Math.round(fs*(+P.reset||5000)*1e-6);
    n.maxMark=Math.round(fs*.05);
    n.minBits=+P.minBits||16; n.raw=P.raw!==false; n.dedup=(+P.dedup||0)/1000;
    const snrK=Math.pow(10,(+P.snr||12)/20), useO=P.mod!=='FSK', useF=P.mod!=='OOK';
    const src=n.decim ? IQK.iqDecim.process(n.decim,{in:s}).out : s;
    for(const c of src.chunks){
      const xr=firRun(n.lp,n.lr,c.re), xi=firRun(n.lp,n.li,iqChunkIm(c)), K=xr.length;
      for(let i=0;i<K;i++){
        const p=xr[i], q=xi[i];
        n.ts+=1/fs;
        n.e1+=n.ae*(Math.sqrt(p*p+q*q)-n.e1);
        const e1=n.e1;
        const fz=Math.atan2(q*n.pr-p*n.pq, p*n.pr+q*n.pq)*n.kf;
        n.pr=p; n.pq=q;
        n.f1+=.3*(fz-n.f1);
        if(e1>n.hi) n.hi+=.5*(e1-n.hi); else n.hi+=(e1-n.hi)*n.kHi;
        const th=Math.max(.5*n.hi,snrK*n.nz);
        const warm=n.cnt<8192;
        const lvO=warm ? 0 : n.lo ? (e1>th*.8 ? 1 : 0) : (e1>th*1.2 ? 1 : 0);
        n.lo=lvO;
        if(!lvO){ n.nz+=(e1-n.nz)*Math.max(1e-4,1/(n.cnt+1)); }
        n.cnt++;
        let lvF=0;
        if(useF){
          if(!warm && e1>.35*n.hi && e1>snrK*n.nz){
            if(++n.pres===8){ n.fh=n.fl=n.f1; }
            if(n.pres>=8){
              if(n.f1>n.fh) n.fh+=.5*(n.f1-n.fh); else n.fh+=(n.f1-n.fh)*n.kF;
              if(n.f1<n.fl) n.fl+=.5*(n.f1-n.fl); else n.fl+=(n.f1-n.fl)*n.kF;
              const span=n.fh-n.fl, mid=(n.fh+n.fl)/2;
              if(span>8000) lvF=n.lf ? (n.f1>mid-.1*span ? 1 : 0) : (n.f1>mid+.1*span ? 1 : 0);
            }
          } else n.pres=0;
          n.lf=lvF;
        }
        if(useO) ismFeed(n,n.ook,lvO,recs,fc,'OOK',n.f1,e1);
        if(useF) ismFeed(n,n.fsk,lvF,recs,fc,'FSK',n.f1,e1);
      }
    }
    n.ui={fs, M:n.M, packets:n.packets, dec:n.dec, unk:n.unk, dups:n.dups,
      hi:20*Math.log10(Math.max(n.hi,1e-6)), nz:20*Math.log10(Math.max(n.nz,1e-6)),
      age:n.lastPkt ? Date.now()-n.lastPkt : null, recent:n.recent.slice(-8)};
    return {rec:recs.length ? recs : null};
  }};

/* ---- генератор: 433 МГц телеграммы ---- */
// Nexus (5 повторов), EV1527 (6 повторов), неопознанный Манчестер (4 повтора); между ними тишина.
function ismNexusBits(id,bat,ch,tx10,hum){
  const b=[], put=(v,l)=>{ for(let i=l-1;i>=0;i--) b.push((v>>i)&1); };
  put(id,8); put(bat,1); put(0,1); put(ch-1,2); put(tx10&0xFFF,12); put(15,4); put(hum,8);
  return b;
}
function ismEv1527Bits(addr,data){
  const b=[]; for(let i=19;i>=0;i--) b.push((addr>>i)&1); for(let i=3;i>=0;i--) b.push((data>>i)&1);
  return b;
}
// сегменты [уровень (1 метка, 0 пауза, 2 тишина), мкс], соседние одинаковые склеиваются
function ismTelegram(k){
  const seg=[], put=(l,us)=>{ if(seg.length && seg[seg.length-1][0]===l) seg[seg.length-1][1]+=us; else seg.push([l,us]); };
  const m=us=>put(1,us), s=us=>put(0,us);
  const kind=k%3, v=Math.floor(k/3);
  if(kind===0){
    const t=(v%2 ? -35 : 215)+7*(v%9), bits=ismNexusBits(0x5A+(v%3), v%4 ? 1 : 0, 1+(v%3), t, 40+(v*7)%50);
    for(let r=0;r<5;r++){
      for(const x of bits){ m(500); s(x ? 2000 : 1000); }
      m(500); if(r<4) s(4000);
    }
  } else if(kind===1){
    const T=300+(v%5)*10, bits=ismEv1527Bits(0xA5C31, 1+(v%15));
    for(let r=0;r<6;r++){
      m(T); s(31*T);
      bits.forEach((x,i)=>{ if(x){ m(3*T); if(r<5 || i<23) s(T); } else { m(T); if(r<5 || i<23) s(3*T); } });
    }
  } else {
    const T=250, bits=[0,0,0,0,0,0,0,0];
    let x=0x1234+v*77; for(let i=0;i<39;i++){ x=(x*1103515245+12345)&0x7FFFFFFF; bits.push((x>>16)&1); }
    bits.push(1);
    for(let r=0;r<4;r++){
      for(const b of bits){ if(b){ s(T); m(T); } else { m(T); s(T); } }
      if(r<3) s(4000);
    }
  }
  put(2,250000);
  return seg;
}
function ismGenerate(n,sr,N){
  const fsk=n.p.ism==='FSK';
  let g=n.ism;
  if(!g || g.sr!==sr || g.fsk!==fsk) g=n.ism={sr, fsk, t:0, end:0, segs:[], i:0, k:0, lv:2, ph:0};
  const re=new Float32Array(N), im=new Float32Array(N), dev=2*Math.PI*35000/sr;
  for(let i=0;i<N;i++,g.t++){
    while(g.t>=g.end){
      if(g.i>=g.segs.length){ g.segs=ismTelegram(g.k++); g.i=0; }
      const sg=g.segs[g.i++]; g.end+=sg[1]*1e-6*sr; g.lv=sg[0];
    }
    const amp=g.lv===2 ? 0 : fsk ? 1 : g.lv;
    if(fsk) g.ph+=g.lv===1 ? dev : -dev;
    re[i]=amp*Math.cos(g.ph); im[i]=amp*Math.sin(g.ph);
  }
  g.ph%=2*Math.PI;
  return [re,im];
}
