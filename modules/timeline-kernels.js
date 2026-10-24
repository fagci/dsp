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
   Правка: tlApply / tlReconcile (наложение правок поверх строк), tlRaw / tlPatch (время обратно в единицы колонок), tlSnap,
   метки tlMarksParse, эффекты дорожек tlFxParse / tlFxLane / tlFxRun, микс клипов tlMixClip, диапазон IQ tlIqSpan, tlGate, tlCsv
   Проверка: node tools/test-timeline.mjs */

const TL_T=['t','time','ts','timestamp','start','t0','begin'], TL_DUR=['dur','duration','len','length','airtime'],
  TL_END=['end','t1','stop'], TL_LANE=['track','lane','freq','chan','channel','src','kind'],
  TL_RSSI=['rssi','rssi_max','level','power','dbm'], TL_FILE=['file','fileid','clip','ref'];
const TL_UNIT={s:1,ms:1e-3,us:1e-6};

const tlNum=v=>typeof v==='number' ? (isFinite(v) ? v : null) : typeof v==='string' && /^\s*-?(\d|\.\d)[\d.eE+-]*\s*$/.test(v) ? +v : null;
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
  return {ok:true, ev, unit, origin:o0*k, o0, tmin, tmax, cols:{t:tc,dur:dc,end:ec,rssi:rc,file:fc,all:[...cols]}};
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


/* ============================ правка ============================
   Таблица остаётся хранилищем: правки лежат поверх неё. ed = {p:{ключ:{колонка:значение}}, d:{ключ:1}, a:[новые строки]};
   ключ строки — значение колонки key (id / key / uid / uuid), без неё — номер строки «#i». Новые строки — «n:j».
   Когда исходная таблица сама приняла правку (выход edited → Table), наложение снимается: см. tlReconcile. */
const TL_KEY=['id','key','uid','uuid'];
function tlKeyCol(rows,want){
  const cols=new Set(); for(const r of (rows||[]).slice(0,50)) for(const k in r) cols.add(k);
  return tlCol(cols,TL_KEY,want);
}
const tlRk=(r,i,kc)=>{ if(kc){ const v=r[kc]; if(v!=null && v!=='') return 'k:'+v; } return '#'+i; };
const tlEd0=()=>({p:{},d:{},a:[]});
const tlEdSize=ed=>Object.keys(ed.p).length+Object.keys(ed.d).length+ed.a.length;
function tlEdParse(s){
  let o; try{ o=typeof s==='string' ? JSON.parse(s||'null') : s; }catch(e){ o=null; }
  const ed=tlEd0(); if(!o || typeof o!=='object') return ed;
  if(o.p && typeof o.p==='object') for(const k in o.p) if(o.p[k] && typeof o.p[k]==='object') ed.p[k]=o.p[k];
  if(o.d && typeof o.d==='object') for(const k in o.d) if(o.d[k]) ed.d[k]=1;
  if(Array.isArray(o.a)) ed.a=o.a.filter(r=>r && typeof r==='object');
  return ed;
}
const tlEdClone=ed=>({p:Object.fromEntries(Object.entries(ed.p).map(([k,v])=>[k,Object.assign({},v)])), d:Object.assign({},ed.d), a:ed.a.map(r=>Object.assign({},r))});
// → {rows, keys}: строки с правками (изменённые — копии, остальные те же объекты) и их ключи
function tlApply(src,ed,kc){
  const rows=[], keys=[];
  src.forEach((r,i)=>{
    if(!r || typeof r!=='object') return;
    const k=tlRk(r,i,kc); if(ed.d[k]) return;
    const q=ed.p[k]; rows.push(q ? Object.assign({},r,q) : r); keys.push(k);
  });
  ed.a.forEach((r,j)=>{ rows.push(r); keys.push('n:'+j); });
  return {rows,keys};
}
const tlSame=(a,b)=>{
  if(a===b) return true;
  if(a==null || b==null) return (a==null || a==='') && (b==null || b==='');
  const x=tlNum(a), y=tlNum(b);
  if(x!==null && y!==null) return Math.abs(x-y)<=1e-13*Math.max(1,Math.abs(x));
  return String(a)===String(b);
};
// таблица приняла правку → наложение снимается. true — наложение изменилось
function tlReconcile(src,ed,kc){
  let ch=false; const at=new Map();
  src.forEach((r,i)=>{ if(r && typeof r==='object') at.set(tlRk(r,i,kc),r); });
  for(const k of Object.keys(ed.p)){
    const r=at.get(k); if(!r){ if(kc){ delete ed.p[k]; ch=true; } continue; }
    for(const c of Object.keys(ed.p[k])) if(tlSame(r[c],ed.p[k][c])){ delete ed.p[k][c]; ch=true; }
    if(!Object.keys(ed.p[k]).length){ delete ed.p[k]; ch=true; }
  }
  for(const k of Object.keys(ed.d)) if(!at.has(k)){ delete ed.d[k]; ch=true; }
  if(kc){ const keep=ed.a.filter(r=>{ const v=r[kc]; return v==null || v==='' || !at.has('k:'+v); }); if(keep.length!==ed.a.length){ ed.a=keep; ch=true; } }
  return ch;
}
// время в секундах оси → число в единицах колонки (с точностью до микросекунды), m — результат tlEvents
const tlRaw=(m,t)=>{ const k=TL_UNIT[m.unit]; return m.o0+Math.round(t*1e6)/1e6/k; };
const tlRawD=(m,d)=>Math.round(d/TL_UNIT[m.unit]*1e6)/1e6;
// новый интервал события [t0,t1] → правка колонок (старт, длительность или конец)
function tlPatch(m,t0,t1,resized){
  const c=m.cols, k=TL_UNIT[m.unit], o={};
  o[c.t]=m.o0+Math.round(t0/k*1e6)/1e6;
  if(c.dur) o[c.dur]=tlRawD(m,Math.max(0,t1-t0));
  else if(c.end) o[c.end]=m.o0+Math.round(t1/k*1e6)/1e6;
  else if(resized && t1>t0) o.dur=tlRawD(m,t1-t0);
  return o;
}
// ближайшее к t значение из отсортированного списка, если оно ближе tol
function tlSnap(t,list,tol){
  let lo=0, hi=list.length; while(lo<hi){ const m=(lo+hi)>>1; if(list[m]<t) lo=m+1; else hi=m; }
  let best=t, bd=tol;
  for(const i of [lo-1,lo]){ if(i<0 || i>=list.length) continue; const d=Math.abs(list[i]-t); if(d<=bd){ bd=d; best=list[i]; } }
  return best;
}

/* ---------- метки ---------- */
function tlMarksParse(s){
  let a; try{ a=typeof s==='string' ? JSON.parse(s||'[]') : s; }catch(e){ a=[]; }
  if(!Array.isArray(a)) return [];
  return a.filter(x=>x && typeof x.t==='number' && isFinite(x.t)).map(x=>({t:x.t,label:String(x.label??'')})).sort((x,y)=>x.t-y.t);
}
const tlMarksStr=a=>JSON.stringify(a.map(x=>({t:Math.round(x.t*1e6)/1e6,label:x.label})));

/* ---------- эффекты дорожек ----------
   Строки «дорожка: gain=-6 lp=3000 hp=200 echo=250,.4 mute solo»; дорожка — маска с «*» (без учёта регистра), «*» — все.
   Подходят несколько строк — их слова складываются, поздняя перебивает раннюю. */
function tlFxParse(text){
  const rules=[];
  for(const ln of String(text||'').split(/\n/)){
    const m=/^\s*([^:#][^:]*):\s*(.*)$/.exec(ln); if(!m) continue;
    const re=new RegExp('^'+m[1].trim().replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$','i'), fx={};
    for(const w of m[2].split(/\s+/).filter(Boolean)){
      const [k,v]=w.split('='), x=tlNum(v);
      if(k==='mute') fx.mute=true; else if(k==='solo') fx.solo=true;
      else if(k==='gain' && x!==null) fx.gain=x;
      else if((k==='lp' || k==='hp') && x>0) fx[k]=x;
      else if(k==='echo'){ const [ms,fb]=String(v).split(',').map(tlNum); if(ms>0) fx.echo={ms:Math.min(2000,ms),fb:Math.min(.95,Math.max(0,fb ?? .35))}; }
    }
    rules.push({re,fx});
  }
  return rules;
}
// → Map имя дорожки → {gain (линейный), lp, hp, echo, silent}; silent — mute или чужой solo
function tlFxLane(rules,names){
  const mp=new Map(); let solo=false;
  for(const nm of names){
    const fx={};
    for(const r of rules) if(r.re.test(nm)) Object.assign(fx,r.fx);
    if(fx.solo) solo=true;
    mp.set(nm,fx);
  }
  for(const [nm,fx] of mp){ fx.silent=!!fx.mute || (solo && !fx.solo); fx.lin=fx.gain!=null ? Math.pow(10,fx.gain/20) : 1; }
  return mp;
}
function tlBiquad(type,fc,sr){                     // Баттерворт 2-го порядка (RBJ), нормировано на a0
  fc=Math.min(Math.max(fc,10),sr*.45);
  const w=2*Math.PI*fc/sr, c=Math.cos(w), al=Math.sin(w)/(2*Math.SQRT1_2), a0=1+al;
  const b=type==='lp' ? [(1-c)/2,1-c,(1-c)/2] : [(1+c)/2,-(1+c),(1+c)/2];
  return {b0:b[0]/a0,b1:b[1]/a0,b2:b[2]/a0,a1:-2*c/a0,a2:(1-al)/a0,z1:0,z2:0};
}
function tlBqRun(q,x){ for(let i=0;i<x.length;i++){ const v=x[i], y=q.b0*v+q.z1; q.z1=q.b1*v-q.a1*y+q.z2; q.z2=q.b2*v-q.a2*y; x[i]=y; } }
// st — состояние дорожки между блоками ({}), x — блок на месте
function tlFxRun(fx,st,x,sr){
  if(fx.lp){ if(!st.lp || st.lpf!==fx.lp){ st.lp=tlBiquad('lp',fx.lp,sr); st.lpf=fx.lp; } tlBqRun(st.lp,x); } else st.lp=null;
  if(fx.hp){ if(!st.hp || st.hpf!==fx.hp){ st.hp=tlBiquad('hp',fx.hp,sr); st.hpf=fx.hp; } tlBqRun(st.hp,x); } else st.hp=null;
  if(fx.echo){
    const d=Math.max(1,Math.round(fx.echo.ms*1e-3*sr));
    if(!st.eb || st.eb.length!==d){ st.eb=new Float32Array(d); st.ep=0; }
    for(let i=0;i<x.length;i++){ const o=st.eb[st.ep]; st.eb[st.ep]=x[i]+o*fx.echo.fb; x[i]+=o; st.ep=(st.ep+1)%d; }
  } else st.eb=null;
  if(fx.lin!==undefined && fx.lin!==1) for(let i=0;i<x.length;i++) x[i]*=fx.lin;
}

/* ---------- микс клипа в блок ----------
   clip: {buf (моно, Float32Array), sr, t0, t1 (секунды оси), off (секунды файла), lin (усиление), fi, fo (секунды)}.
   Блок покрывает время оси [a,b) (при скорости ≠ 1 это не BLOCK/sr); отсчёт i берётся в a+(b-a)·i/N с линейной интерполяцией */
function tlMixClip(dst,clip,a,b){
  const N=dst.length, buf=clip.buf, sr=clip.sr, L=buf.length;
  if(!(b>a) || b<=clip.t0 || a>=clip.t1) return;
  const dt=(b-a)/N, fi=clip.fi>0 ? clip.fi : 0, fo=clip.fo>0 ? clip.fo : 0, g=clip.lin ?? 1;
  for(let i=0;i<N;i++){
    const tau=a+dt*i; if(tau<clip.t0 || tau>=clip.t1) continue;
    const pos=(tau-clip.t0+(clip.off||0))*sr, j=Math.floor(pos); if(j<0 || j>=L-1) continue;
    const f=pos-j; let v=buf[j]*(1-f)+buf[j+1]*f;
    let e=g; if(fi && tau-clip.t0<fi) e*=(tau-clip.t0)/fi; if(fo && clip.t1-tau<fo) e*=(clip.t1-tau)/fo;
    dst[i]+=v*e;
  }
}
// моно из каналов декодированного звука
function tlMono(chs){
  if(chs.length===1) return chs[0];
  const o=new Float32Array(chs[0].length); for(const c of chs) for(let i=0;i<o.length;i++) o[i]+=c[i]/chs.length;
  return o;
}

/* ---------- IQ: какие отсчёты файла лежат между положениями a и b плейхеда ----------
   клип начинается в t0, смещение в файле off (с), частота дискретизации sr, всего total отсчётов; соседние блоки стыкуются без щелей */
function tlIqSpan(a,b,t0,off,sr,total){
  const s0=Math.round((a-t0+off)*sr), s1=Math.round((b-t0+off)*sr);
  const lo=Math.max(0,s0), hi=Math.min(total,s1);
  return hi>lo ? [lo,hi] : null;
}

/* ---------- сигнал → события (вход gate): фронт вверх — старт, вниз — конец ----------
   st — состояние ({}); возвращает законченные импульсы [{i0, n}] в отсчётах от начала потока; st.pos — отсчётов обработано */
function tlGate(st,x,thr,hyst){
  if(st.on===undefined){ st.on=false; st.i0=0; st.pos=0; }
  const hi=thr, lo=thr-(hyst||0), out=[];
  for(let i=0;i<x.length;i++){
    const v=x[i];
    if(!st.on && v>=hi){ st.on=true; st.i0=st.pos+i; }
    else if(st.on && v<lo){ st.on=false; out.push({i0:st.i0,n:st.pos+i-st.i0}); }
  }
  st.pos+=x.length;
  return out;
}

function tlCsv(rows){
  const cols=[]; const seen=new Set();
  for(const r of rows) for(const k in r) if(!seen.has(k)){ seen.add(k); cols.push(k); }
  const q=v=>{ if(v==null) return ''; const s=typeof v==='object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  return [cols.map(q).join(',')].concat(rows.map(r=>cols.map(c=>q(r[c])).join(','))).join('\n')+'\n';
}
