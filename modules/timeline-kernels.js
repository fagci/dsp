"use strict";
/* ============================ Timeline: модель интервалов из строк Table ============================
   Строка = событие на оси времени: старт t, длительность dur (или конец end), дорожка (lane) — любые колонки
   (частота, абонент, тип пакета…), цвет — по колонке, высота — по rssi, file — что воспроизвести. Те же строки
   годятся для раскладки клипов (дорожка, старт, длина, ссылка на файл), поэтому ядро ничего не знает про эфир.
   tlEvents(rows,o) → {ok,err,ev[{i,t0,t1,row}],cols,unit,origin,tmin,tmax}: время в секундах от origin (первый старт;
   абсолютное = origin+t, иначе на эпохе float теряет доли мс)
   tlFilter(expr) → предикат ev→bool;  tlLanes(ev,by) → [{name,ev}];  tlMerge(ev,gap) → всплески
   tlStats(ev,o) → период / длительность / скважность / джиттер / пропуски;  tlLag(from,to,max) → задержки
   tlLinks(ev,keys) → группы событий с одним значением признака;  tlCrossed(ev,a,b), tlActive(ev,t)
   Проверка: node tools/test-timeline.mjs */

const TL_T=['t','time','ts','timestamp','start','t0','begin'], TL_DUR=['dur','duration','len','length','airtime'],
  TL_END=['end','t1','stop'], TL_LANE=['track','lane','freq','chan','channel','src','kind'],
  TL_RSSI=['rssi','rssi_max','level','power','dbm'], TL_FILE=['file','fileid','clip','ref'];
const TL_UNIT={s:1,ms:1e-3,us:1e-6};

const tlNum=v=>typeof v==='number' ? (isFinite(v) ? v : null) : typeof v==='string' && /^\s*-?\d[\d.eE+-]*\s*$/.test(v) ? +v : null;
const tlCol=(cols,list,want)=>{
  const low=new Map([...cols].map(c=>[c.toLowerCase(),c]));
  if(want){ const w=String(want).trim(); return cols.has(w) ? w : low.get(w.toLowerCase()) || null; }
  for(const k of list){ const c=low.get(k); if(c) return c; }
  return null;
};
const tlMed=a=>{ if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y), m=s.length>>1; return s.length&1 ? s[m] : (s[m-1]+s[m])/2; };
const tlMean=a=>a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
const tlStd=a=>{ if(a.length<2) return null; const m=tlMean(a); return Math.sqrt(a.reduce((x,y)=>x+(y-m)*(y-m),0)/(a.length-1)); };

// o: {t,dur,end,rssi,file,unit:'auto'|'s'|'ms'|'us'}
function tlEvents(rows,o){
  o=o||{};
  const bad=err=>({ok:false,err});
  if(!rows || !rows.length) return bad('no rows');
  const cols=new Set(); for(const r of rows.slice(0,50)) for(const k in r) cols.add(k);
  const tc=tlCol(cols,TL_T,o.t);
  if(!tc) return bad(o.t ? 'no column «'+o.t+'»' : 'no time column — set «t»');
  const dc=tlCol(cols,TL_DUR,o.dur), ec=dc ? null : tlCol(cols,TL_END,o.end);
  const rc=tlCol(cols,TL_RSSI,o.rssi), fc=tlCol(cols,TL_FILE,o.file);
  let unit=o.unit && TL_UNIT[o.unit] ? o.unit : null, tmax0=0;
  if(!unit){ for(const r of rows){ const v=tlNum(r[tc]); if(v!==null && Math.abs(v)>tmax0) tmax0=Math.abs(v); }
    unit=tmax0>1e14 ? 'us' : tmax0>1e11 ? 'ms' : 's'; }
  const k=TL_UNIT[unit], ev=[]; let tmin=Infinity, tmax=-Infinity, o0=Infinity;
  for(const r of rows){ const a=tlNum(r[tc]); if(a!==null && a<o0) o0=a; }
  rows.forEach((r,i)=>{
    const a=tlNum(r[tc]); if(a===null) return;
    let b=a;
    if(dc){ const d=tlNum(r[dc]); if(d!==null && d>0) b=a+d; }
    else if(ec){ const e=tlNum(r[ec]); if(e!==null && e>a) b=e; }
    const t0=(a-o0)*k, t1=(b-o0)*k;
    if(t0<tmin) tmin=t0; if(t1>tmax) tmax=t1;
    ev.push({i,t0,t1,row:r});
  });
  if(!ev.length) return bad('no numbers in «'+tc+'»');
  ev.sort((x,y)=>x.t0-y.t0 || x.i-y.i);
  return {ok:true, ev, unit, origin:o0*k, tmin, tmax, cols:{t:tc,dur:dc,end:ec,rssi:rc,file:fc,all:[...cols]}};
}

/* ---------- фильтр ----------
   «col=a,b»  «col!=a»  «col>-70»  «col<=5»  «col~regex»  «слово» (в любой колонке); термы через пробел или &, все должны сойтись.
   В значении «*» — любые символы; «col=» с пустым значением — колонка пуста. */
function tlFilter(expr){
  const terms=String(expr||'').split(/[\s&]+/).filter(Boolean).map(t=>{
    const m=/^([\w.]+)(!=|>=|<=|=|>|<|~)(.*)$/.exec(t);
    if(!m){ const w=t.toLowerCase(); return r=>{ for(const k in r) if(String(r[k]).toLowerCase().includes(w)) return true; return false; }; }
    const [,c,op,val]=m, low=c.toLowerCase();
    const get=r=>{ if(c in r) return r[c]; for(const k in r) if(k.toLowerCase()===low) return r[k]; return undefined; };
    if(op==='~'){ let re; try{ re=new RegExp(val,'i'); }catch(e){ return ()=>false; } return r=>re.test(String(get(r)??'')); }
    if(op==='=' || op==='!='){
      const alts=val.split(',').map(a=>a.trim()), res=alts.map(a=>new RegExp('^'+a.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$','i'));
      const eq=r=>{ const v=get(r); const s=v==null ? '' : String(v); return res.some(re=>re.test(s)) || alts.some(a=>{ const x=tlNum(a), y=tlNum(v); return x!==null && y!==null && x===y; }); };
      return op==='=' ? eq : r=>!eq(r);
    }
    const x=tlNum(val);
    return r=>{ const y=tlNum(get(r)); if(x===null || y===null) return false;
      return op==='>' ? y>x : op==='<' ? y<x : op==='>=' ? y>=x : y<=x; };
  });
  return terms.length ? ev=>terms.every(f=>f(ev.row)) : null;
}

/* ---------- дорожки ---------- */
// by — колонки через запятую; пусто — одна дорожка. Дорожки по времени первого события
function tlLanes(ev,by){
  const cols=String(by||'').split(',').map(s=>s.trim()).filter(Boolean), g=new Map();
  for(const e of ev){
    const name=cols.length ? cols.map(c=>{ const v=e.row[c]; return v==null || v==='' ? '—' : v; }).join(' · ') : 'all';
    let l=g.get(name); if(!l){ l={name,ev:[]}; g.set(name,l); }
    l.ev.push(e);
  }
  const out=[...g.values()];
  out.forEach(l=>{ l.ev.sort((a,b)=>a.t0-b.t0); l.t0=l.ev[0].t0; });
  out.sort((a,b)=>a.t0-b.t0 || (a.name<b.name ? -1 : 1));
  return out;
}

// события с зазором ≤ gap секунд (в пределах дорожки) склеиваются во всплеск: пакеты одного выхода в эфир
function tlMerge(ev,gap){
  if(!(gap>0)) return ev;
  const out=[]; let cur=null;
  for(const e of ev){
    if(cur && e.t0-cur.t1<=gap){ if(e.t1>cur.t1) cur.t1=e.t1; cur.n++; cur.parts.push(e); }
    else{ cur={i:e.i,t0:e.t0,t1:e.t1,row:e.row,n:1,parts:[e]}; out.push(cur); }
  }
  return out;
}

/* ---------- измерения ----------
   o: {tol:0.1 — допуск периода (доля), rssi:колонка}
   period — медиана интервалов между стартами; ok — доля интервалов, укладывающихся в k·period ±tol (k=1…8);
   miss — сколько «пропущенных» повторов (интервал ≈ k·period при k>1); jitter — std(интервалов, кратных period)/period */
function tlStats(ev,o){
  o=o||{}; const tol=o.tol>0 ? o.tol : .1, n=ev.length;
  const s={n, t0:n ? ev[0].t0 : null, t1:n ? Math.max(...ev.map(e=>e.t1)) : null};
  if(n) s.span=s.t1-s.t0;
  const dur=ev.map(e=>e.t1-e.t0), gaps=[];
  for(let i=1;i<n;i++) gaps.push(ev[i].t0-ev[i-1].t0);
  s.dur=tlMed(dur); s.dur_min=n ? Math.min(...dur) : null; s.dur_max=n ? Math.max(...dur) : null; s.dur_mean=tlMean(dur);
  s.duty=s.span>0 ? Math.min(1,dur.reduce((x,y)=>x+y,0)/s.span) : null;
  s.rate=s.span>0 ? (n-1)/s.span : null;
  s.period=tlMed(gaps); s.period_min=gaps.length ? Math.min(...gaps) : null; s.period_max=gaps.length ? Math.max(...gaps) : null;
  s.period_mean=tlMean(gaps);
  s.idle=tlMed(ev.slice(1).map((e,i)=>e.t0-ev[i].t1).filter(v=>v>=0));
  s.ok=null; s.miss=0; s.jitter=null;
  if(s.period>0){
    const near=[], P=s.period; let fit=0;
    for(const g of gaps){
      const k=Math.max(1,Math.round(g/P));
      if(k<=8 && Math.abs(g-k*P)<=tol*P*Math.max(1,Math.sqrt(k))){ fit++; near.push(g/k); s.miss+=k-1; }
    }
    s.ok=gaps.length ? fit/gaps.length : null;
    const sd=tlStd(near); s.jitter=sd!==null && P>0 ? sd/P : null;
  }
  if(o.rssi){
    const r=ev.map(e=>tlNum(e.row[o.rssi])).filter(v=>v!==null);
    if(r.length){ s.rssi=tlMean(r); s.rssi_min=Math.min(...r); s.rssi_max=Math.max(...r); }
  }
  return s;
}

// задержки: для каждого события from — ближайшее следующее событие to не позже max секунд (ответ после запроса)
function tlLag(from,to,max){
  const lags=[]; let j=0;
  for(const a of from){
    while(j<to.length && to[j].t0<a.t0) j++;
    if(j<to.length && (!(max>0) || to[j].t0-a.t0<=max)) lags.push(to[j].t0-a.t0);
  }
  return {n:lags.length, lags, med:tlMed(lags), mean:tlMean(lags), std:tlStd(lags),
    min:lags.length ? Math.min(...lags) : null, max:lags.length ? Math.max(...lags) : null};
}

// события с одним значением признака (абонент, адрес, ключ) на разных дорожках → группы
function tlLinks(ev,keys){
  const cols=String(keys||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!cols.length) return [];
  const g=new Map();
  for(const e of ev){
    const vals=cols.map(c=>e.row[c]); if(vals.some(v=>v==null || v==='')) continue;
    const k=vals.join(' · '); (g.get(k)||g.set(k,[]).get(k)).push(e);
  }
  return [...g].map(([key,list])=>({key,ev:list,n:list.length,t0:list[0].t0,t1:Math.max(...list.map(e=>e.t1))}));
}

/* ---------- воспроизведение: события, начавшиеся в (a,b], и активные в t ---------- */
function tlBound(ev,t){                                  // первый индекс с t0 > t
  let lo=0, hi=ev.length; while(lo<hi){ const m=(lo+hi)>>1; if(ev[m].t0<=t) lo=m+1; else hi=m; }
  return lo;
}
function tlCrossed(ev,a,b){ const out=[]; for(let i=tlBound(ev,a);i<ev.length && ev[i].t0<=b;i++) out.push(ev[i]); return out; }
function tlActive(ev,t){ const out=[]; for(let i=tlBound(ev,t)-1;i>=0;i--){ if(ev[i].t1>t) out.push(ev[i]); else if(t-ev[i].t0>3600) break; } return out; }

// метка времени оси: относительная «+1.250 s» / «+2.5 ms» с шагом, подобранным под масштаб
function tlFmt(t,step){
  const a=Math.abs(t);
  if(step<1e-3 || (a<1e-3 && a>0)) return (t*1e6).toFixed(step<1e-6 ? 1 : 0)+'µs';
  if(step<1 && a<1) return (t*1e3).toFixed(step<1e-2 ? 1 : 0)+'ms';
  if(a>=3600) return Math.floor(t/3600)+'h'+String(Math.floor(t%3600/60)).padStart(2,'0')+'m';
  if(a>=60) return Math.floor(t/60)+'m'+String(Math.floor(t%60)).padStart(2,'0')+'s';
  return t.toFixed(step<.1 ? 2 : step<1 ? 1 : 0)+'s';
}
function tlStep(span,n){                                 // «круглый» шаг делений: 1·2·5·10…
  const s0=span/Math.max(1,n), mag=Math.pow(10,Math.floor(Math.log10(s0||1))), r=s0/mag;
  return (r<1.5 ? 1 : r<3 ? 2 : r<7 ? 5 : 10)*mag;
}
function tlDur(v){                                       // длительность для readout
  if(v==null || !isFinite(v)) return '—';
  const a=Math.abs(v);
  return a<1e-3 ? (v*1e6).toFixed(0)+' µs' : a<1 ? (v*1e3).toFixed(a<.01 ? 2 : 1)+' ms' : a<60 ? v.toFixed(a<10 ? 3 : 2)+' s' : (v/60).toFixed(2)+' min';
}
