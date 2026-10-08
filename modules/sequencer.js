"use strict";
/* ============================ DATA SEQUENCER, TRIGGER CLOCK, TIME BASE ============================ */
// Таблица любых полей (CSV / KML / GPX / GeoJSON) выдаётся по строке: по триггеру, таймеру,
// паузе из колонки, меткам времени из данных или по пройденному расстоянию между точками.
// Trigger Clock — универсальный источник импульсов, Time Base — виртуальные часы (ручное время).

/* ---------- разбор форматов: всё приводится к таблице [[заголовки],[строка],…] ---------- */
function seqXml(text){
  const doc=new DOMParser().parseFromString(text,'text/xml');
  if(doc.getElementsByTagName('parsererror').length) throw new Error('invalid XML');
  return doc;
}
const seqTags=(el,name)=>Array.from(el.getElementsByTagNameNS('*',name));
const seqTxt=(el,name)=>{ const e=seqTags(el,name)[0]; return e ? e.textContent.trim() : ''; };

function seqKml(text){
  const doc=seqXml(text), rows=[['name','lat','lon','alt','time','desc']];
  for(const pm of seqTags(doc,'Placemark')){
    const name=seqTxt(pm,'name'), desc=seqTxt(pm,'description').replace(/\s+/g,' ');
    const when=seqTxt(pm,'when')||seqTxt(pm,'begin');
    const tr=seqTags(pm,'Track')[0];
    if(tr){                                           // gx:Track: when[i] ↔ gx:coord[i]
      const ws=seqTags(tr,'when'), cs=seqTags(tr,'coord');
      cs.forEach((c,i)=>{ const [lo,la,al]=c.textContent.trim().split(/\s+/);
        rows.push([name,la,lo,al||'',ws[i]?ws[i].textContent.trim():'',desc]); });
      continue;
    }
    for(const c of seqTags(pm,'coordinates'))
      for(const tup of c.textContent.trim().split(/\s+/)){
        const [lo,la,al]=tup.split(',');
        if(la===undefined || lo==='') continue;
        rows.push([name,la,lo,al||'',when,desc]);
      }
  }
  return rows;
}
function seqGpx(text){
  const doc=seqXml(text), rows=[['name','lat','lon','alt','time','speed']];
  for(const tag of ['wpt','rtept','trkpt'])
    for(const p of seqTags(doc,tag))
      rows.push([seqTxt(p,'name'),p.getAttribute('lat'),p.getAttribute('lon'),
                 seqTxt(p,'ele'),seqTxt(p,'time'),seqTxt(p,'speed')]);
  return rows;
}
function seqGeoJson(text){
  const o=JSON.parse(text), rows=[['name','lat','lon','alt']];
  const pt=(name,c)=>{ if(Array.isArray(c) && c.length>=2) rows.push([name,c[1],c[0],c[2]??'']); };
  const geom=(g,name)=>{
    if(!g) return;
    const c=g.coordinates;
    switch(g.type){
      case 'Point': pt(name,c); break;
      case 'MultiPoint': case 'LineString': c.forEach(p=>pt(name,p)); break;
      case 'MultiLineString': case 'Polygon': c.forEach(l=>l.forEach(p=>pt(name,p))); break;
      case 'MultiPolygon': c.forEach(pl=>pl.forEach(l=>l.forEach(p=>pt(name,p)))); break;
      case 'GeometryCollection': g.geometries.forEach(x=>geom(x,name)); break;
    }
  };
  const feat=f=>{
    if(f.type==='FeatureCollection') return f.features.forEach(feat);
    if(f.type==='Feature') return geom(f.geometry,f.properties?.name??f.properties?.id??'');
    geom(f,'');
  };
  feat(o);
  return rows;
}
// заголовок header=false — столбцы col1…; ext/содержимое определяют формат
function seqParse(text,ext,header){
  const t=String(text).replace(/^﻿/,''), head=t.trimStart().slice(0,300);
  let table;
  if(ext==='kml' || /^<\?xml[^>]*>\s*<kml|^<kml/i.test(head)) table=seqKml(t);
  else if(ext==='gpx' || /<gpx[\s>]/i.test(head)) table=seqGpx(t);
  else if(ext==='geojson' || head[0]==='{') table=seqGeoJson(t);
  else {
    table=geoCsvParse(t,'');
    if(table.length && header===false) table.unshift(table[0].map((_,i)=>'col'+(i+1)));
  }
  if(!table.length) throw new Error('no data');
  return table;
}
function seqToCsv(table){ return table.map(r=>r.map(csvCell).join(',')).join('\n'); }

/* ---------- время ---------- */
// число >1e11 — мс, иначе секунды; "HH:MM:SS" — секунды от полуночи; иначе дата
function seqTime(v){
  if(typeof v==='number') return isFinite(v) ? (v>1e11 ? v/1000 : v) : null;
  const s=String(v??'').trim(); if(!s) return null;
  let m=s.match(/^(\d+):(\d\d)(?::(\d\d(?:\.\d+)?))?$/);
  if(m) return +m[1]*3600+ +m[2]*60+ +(m[3]||0);
  const p=Date.parse(s); return isFinite(p) ? p/1000 : null;
}
const SEQ_TIME_COLS=['t','time','timestamp','datetime','date','ts','when','epoch'];
const SEQ_LAT_COLS=['lat','latitude'], SEQ_LON_COLS=['lon','lng','long','longitude'];
const SEQ_FIXED=new Set(['rec','text','row','count','next','done','dist','bearing','progress',
  'trig','t','rate','loop','speed','tscale','interp','first','last','initial']);

function seqFind(headers,want,list){
  if(want){ const w=String(want).trim().toLowerCase(); const h=headers.find(x=>x.toLowerCase()===w); if(h) return h; }
  if(want) return null;
  for(const k of list){ const h=headers.find(x=>x.toLowerCase()===k); if(h) return h; }
  return null;
}

/* ---------- таблица узла ---------- */
function seqSetup(n){
  const text=String(n.p.data||'').trim();
  n.rows=[]; n.headers=[]; n.cols=[]; n.err='';
  if(text){
    try{
      const table=seqParse(text,'',n.p.header);
      n.headers=hostlistDedupFieldNames(table[0]);
      n.rows=table.slice(1).map(r=>{ const o={}; n.headers.forEach((h,i)=>o[h]=hostlistCoerce(r[i]??'')); return o; });
    }catch(e){ n.err=e.message; }
  }
  const used=new Set(SEQ_FIXED);
  n.cols=n.headers.map(h=>{ let port=h; while(used.has(port)) port+='_'; used.add(port); return {h,port}; });
  n.timeCol=seqFind(n.headers,n.p.tcol,SEQ_TIME_COLS);
  n.latCol=seqFind(n.headers,n.p.latCol,SEQ_LAT_COLS);
  n.lonCol=seqFind(n.headers,n.p.lonCol,SEQ_LON_COLS);
  n.tt=null;
  if(n.timeCol){                                      // метки времени, дыры заполняем предыдущим значением
    let prev=0; n.tt=n.rows.map(r=>{ const v=seqTime(r[n.timeCol]); if(v!=null) prev=v; return prev; });
  }
  n.geo=!!(n.latCol && n.lonCol);
  seqReset(n);
}
function seqLoad(n,file){
  const rd=new FileReader();
  rd.onload=()=>{
    const ext=file.name.toLowerCase().split('.').pop();
    let table; try{ table=seqParse(String(rd.result),ext,n.p.header); }
    catch(e){ alert('failed to read '+file.name+': '+e.message); return; }
    n.name=file.name;
    const csv=seqToCsv(table);
    if(n.set?.data) n.set.data(csv); else n.p.data=csv;
    seqApply(n);
  };
  rd.readAsText(file);
}
function seqApply(n){ seqSetup(n); rebuildNode(n); markTopoDirty(); }

/* ---------- порядок выдачи ---------- */
function seqRange(n){
  const N=n.rows.length, lo=clamp((n.p.first|0)-1,0,Math.max(0,N-1)), t=n.p.last|0;
  return [lo, t>0 ? clamp(t-1,lo,N-1) : N-1];
}
function seqReset(n){
  const [lo]=seqRange(n);
  n.idx=lo; n.dir=1; n.bag=[]; n.bagEnd=false; n.acc=0; n.s=0; n.elapsed=0; n.nxt=lo; n.tPrev=null;
  n.done=false; n.started=false; n.initDone=false; n.count=0; n.cur=n.rows[lo] ? {...n.rows[lo]} : null; n.emitAcc=0;
  n.seg={d:0,b:0};
}
// следующая строка при порядке seq/pingpong без побочных эффектов; -1 — конец
function seqPeek(n){
  const [lo,hi]=seqRange(n), loop=n.p.loop;
  if(n.p.order==='ping-pong' && loop){
    if(hi===lo) return lo;
    const j=n.idx+n.dir;
    return j>hi ? hi-1 : j<lo ? lo+1 : j;
  }
  return n.idx<hi ? n.idx+1 : loop ? lo : -1;
}
function seqMove(n,j){
  if(j!==n.idx) n.dir=j>n.idx ? 1 : -1;
  n.idx=j;
}
// следующая выдаваемая строка по порядку; false — список кончился
function seqStep(n){
  const [lo,hi]=seqRange(n), order=n.p.order;
  if(order==='random'){
    let j=lo+Math.floor(Math.random()*(hi-lo+1));
    if(hi>lo && j===n.idx && n.started) j=j===hi ? lo : j+1;
    n.idx=j; return true;
  }
  if(order==='shuffle'){
    if(!n.bag.length){
      if(n.bagEnd && !n.p.loop){ n.done=true; return false; }
      for(let i=lo;i<=hi;i++) n.bag.push(i);
      for(let i=n.bag.length-1;i>0;i--){ const k=Math.floor(Math.random()*(i+1)); [n.bag[i],n.bag[k]]=[n.bag[k],n.bag[i]]; }
      n.bagEnd=false;
    }
    n.idx=n.bag.pop(); if(!n.bag.length) n.bagEnd=true;
    return true;
  }
  const j=seqPeek(n);
  if(j<0){ n.done=true; return false; }
  seqMove(n,j); return true;
}
function seqSpeedKmh(n){
  const k={'km/h':1,'m/s':3.6,'knots':1.852}[n.p.unit]||1;
  const col=n.p.speedCol && n.rows[n.idx] ? n.rows[n.idx][n.p.speedCol] : null;
  return (typeof col==='number' && col>0 ? col : +n.p.speed||0)*k;
}
function seqSegment(n,a,b){                           // расстояние (км) и азимут от строки a к b
  if(!n.geo || b<0 || a===b) return {d:0,b:0};
  const A=n.rows[a], B=n.rows[b], la=A[n.latCol], lo=A[n.lonCol], lb=B[n.latCol], ob=B[n.lonCol];
  if(![la,lo,lb,ob].every(v=>typeof v==='number')) return {d:0,b:0};
  return {d:geoDist(la,lo,lb,ob), b:geoBearing(la,lo,lb,ob)};
}

/* ---------- узел ---------- */
def({ id:'csvsrc', title:'Data Sequencer', cat:'Sources', legacy:true,   // заменён узлом 'table'
  ins:[{n:'trig',t:'val'},{n:'row',t:'val'},{n:'t',t:'num'}],
  outs:n=>[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'row',t:'num'},{n:'count',t:'num'},
           {n:'next',t:'num'},{n:'done',t:'num'},{n:'dist',t:'num'},{n:'bearing',t:'num'},
           {n:'progress',t:'num'},...(n.cols||[]).map(c=>({n:c.port,t:'val'}))],
  readout:true, tall:true, w:260,
  params:[
    {n:'file',t:'file',accept:'.csv,.tsv,.txt,.kml,.gpx,.geojson,.json,text/csv',fn:(n,f)=>seqLoad(n,f)},
    {n:'advance',t:'select',opts:['rate','dwell','time','distance'],d:'rate',
      label:'advance'},
    {n:'order',t:'select',opts:['sequential','ping-pong','random','shuffle'],d:'sequential'},
    {n:'rate',t:'range',min:0,max:50,step:.1,d:0,label:'rows/s'},
    {n:'speed',t:'range',min:0,max:1000,step:.1,d:50,label:'speed'},
    {n:'tscale',t:'range',min:.01,max:1000,step:.01,log:true,d:1,label:'time ×'},
    {n:'loop',t:'check',d:true},
    {n:'interp',t:'check',d:false,label:'interpolate'},
    {n:'initial',t:'check',d:true,label:'first row at start'},
    {n:'reset',t:'button',label:'Reset',fn:n=>{ seqReset(n); }},
    {n:'apply',t:'button',label:'Apply table',fn:n=>seqApply(n)},
    {n:'first',t:'num',min:1,max:1e6,step:1,d:1,adv:true,label:'first row'},
    {n:'last',t:'num',min:0,max:1e6,step:1,d:0,adv:true,label:'last row (0=end)'},
    {n:'unit',t:'select',opts:['km/h','m/s','knots'],d:'km/h',adv:true,label:'speed unit'},
    {n:'header',t:'check',d:true,adv:true,label:'header line'},
    {n:'tcol',t:'text',d:'',adv:true,label:'time col (auto)'},
    {n:'dwellCol',t:'text',d:'dwell',adv:true,label:'dwell col, s'},
    {n:'speedCol',t:'text',d:'speed',adv:true,label:'speed col'},
    {n:'latCol',t:'text',d:'',adv:true,label:'lat col (auto)'},
    {n:'lonCol',t:'text',d:'',adv:true,label:'lon col (auto)'},
    {n:'textCol',t:'text',d:'',adv:true,label:'text col (row)'},
    {n:'data',t:'code',d:'',adv:true,label:'table'},
  ],
  init:n=>{ n.name=''; n.trigPrev=0; n.rowPrev=null; n.pulse=0; seqSetup(n); },
  process:(n,I)=>seqProcess(n,I),
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const N=n.rows.length;
    const warn = n.err ? n.err : !N ? 'no data: load a file or fill «table» and press Apply table' :
      n.p.advance==='time' && !n.tt ? 'no time column' : n.p.advance==='distance' && !n.geo ? 'no lat/lon columns' : '';
    r.textContent = warn ? '⚠ '+warn : 
      (n.name?n.name+' · ':'')+'row '+(n.idx+1)+'/'+N+' · '+n.p.advance+(n.done?' · done':'')+
      (n.cur?'\n'+n.headers.slice(0,6).map(h=>h+': '+recFmt(n.cur[h])).join('\n'):''); }
});

// общий ход секвенсора: им же пользуется узел 'table' (modules/table.js)
function seqProcess(n,I){
    const N=n.rows.length, dt=BLOCK/Eng.sr, p=n.p, batch=[];
    if(!N){ n.pulse=0; return {rec:null,text:'',row:0,count:0,next:0,done:0,dist:0,bearing:0,progress:0}; }
    const [lo,hi]=seqRange(n);
    const emit=(r)=>{ batch.push(r || {...n.rows[n.idx]}); n.count++; n.started=true; };

    if(n.idx<lo || n.idx>hi) n.idx=lo;
    if(!n.initDone){ n.initDone=true; if(p.initial && p.advance!=='time') emit(); }

    // выбор строки по номеру (1…N)
    const rw=typeof I.row==='number' && isFinite(I.row) ? I.row : null;
    if(rw!==null && rw!==n.rowPrev){ n.idx=clamp(Math.round(rw)-1,0,N-1); n.nxt=n.idx+1; n.s=0; emit(); }
    n.rowPrev=rw;
    if(n.pick!=null){ n.idx=clamp(n.pick,0,N-1); n.nxt=n.idx+1; n.s=0; n.pick=null; emit(); }   // клик по строке в таблице

    const trig=typeof I.trig==='number' ? I.trig : 0;
    const edge=trig>0.5 && n.trigPrev<=0.5; n.trigPrev=trig;
    const ext=p.advance==='time' && n.tt && typeof I.t==='number' && n.tt[lo]>1e8;   // внешнее время (Time Base)
    if(edge && !n.done && !ext){
      if(p.advance==='time' && n.tt){ n.nxt=Math.min(n.nxt,hi); if(seqStep(n)){ n.nxt=n.idx+1; n.elapsed=(n.tt[n.idx]-n.tt[lo])/(+p.tscale||1); emit(); } }
      else if(seqStep(n)){ n.s=0; emit(); }
    }

    if(n.done && p.loop && p.advance!=='time' && p.advance!=='distance') n.done=false;
    if(!n.done){
      if(p.advance==='rate' && p.rate>0){
        n.acc+=dt; const iv=1/p.rate;
        for(let k=0;n.acc>=iv && k<50;k++){ n.acc-=iv; if(!seqStep(n)) break; emit(); }
      }
      else if(p.advance==='dwell'){
        const col=p.dwellCol && n.rows[n.idx] ? n.rows[n.idx][p.dwellCol] : null;
        const hold=typeof col==='number' && col>0 ? col : p.rate>0 ? 1/p.rate : 1;
        n.acc+=dt;
        for(let k=0;n.acc>=hold && k<50;k++){
          n.acc-=hold; if(!seqStep(n)) break; emit();
        }
      }
      else if(p.advance==='time' && n.tt){
        let head;
        if(ext){
          head=I.t;
          if(n.tPrev===null || head<n.tPrev-1e-6){      // старт или время отмотали: без выдачи прошлого
            let j=lo-1; while(j+1<=hi && n.tt[j+1]<=head) j++;
            n.nxt=j+1; if(j>=lo) n.idx=j;
          }
          n.tPrev=head;
        } else {
          n.elapsed+=dt*(+p.tscale||1); head=n.tt[lo]+n.elapsed;
        }
        for(let k=0;n.nxt<=hi && n.tt[n.nxt]<=head && k<5000;k++){ n.idx=n.nxt++; emit(); }
        if(n.nxt>hi){
          if(p.loop && !ext){ n.nxt=lo; n.elapsed=0; } else n.done=true;
        }
      }
      else if(p.advance==='distance' && n.geo){
        const v=seqSpeedKmh(n);
        let nx=seqPeek(n);
        n.s+=v*dt/3600;
        n.seg=seqSegment(n,n.idx,nx);
        for(let k=0;nx>=0 && n.s>=n.seg.d && k<5000;k++){
          n.s-=n.seg.d; seqMove(n,nx);
          if(!p.interp || !(p.rate>0)) emit();
          nx=seqPeek(n); n.seg=seqSegment(n,n.idx,nx);
        }
        if(nx<0){ n.done=true; n.s=0; if(p.interp && p.rate>0) emit(); }
        else if(p.interp && p.rate>0){
          n.emitAcc+=dt;
          if(n.emitAcc>=1/p.rate){
            n.emitAcc=0;
            const A=n.rows[n.idx], B=nx>=0 ? n.rows[nx] : A, f=n.seg.d>0 ? Math.min(1,n.s/n.seg.d) : 0;
            const r={...A};
            if(typeof A[n.latCol]==='number' && typeof B[n.latCol]==='number'){
              r[n.latCol]=A[n.latCol]+(B[n.latCol]-A[n.latCol])*f;
              r[n.lonCol]=A[n.lonCol]+(B[n.lonCol]-A[n.lonCol])*f;
            }
            emit(r);
          }
        }
      }
    }
    if(batch.length) n.cur=batch[batch.length-1];
    n.pulse=batch.length ? 1 : 0;
    const row=n.rows[n.idx], cur=n.cur || row;
    const out={ rec:batch.length ? batch : null, row:n.idx+1, count:n.count, next:n.pulse, done:n.done?1:0,
      dist:n.seg.d, bearing:n.seg.b, progress:N>1 ? (n.idx-lo+(n.seg.d>0?Math.min(1,n.s/n.seg.d):0))/Math.max(1,hi-lo) : 0 };
    out.text = p.textCol && cur[p.textCol]!==undefined ? String(cur[p.textCol]) : n.headers.map(h=>cur[h]).join(',');
    for(const c of n.cols) out[c.port]=cur[c.h];
    return out;
}

/* ---------- Time Base ---------- */
// Виртуальные часы: системное время или заданное вручную, с любой скоростью
function tbParse(s){
  const t=String(s||'').trim(); if(!t) return null;
  const v=Date.parse(/^\d{4}-\d\d-\d\d \d/.test(t) ? t.replace(' ','T') : t);
  return isFinite(v) ? v/1000 : null;
}
function tbSet(n,sec){ n.t=sec; n.setPrev=undefined; }
def({ id:'timebase', title:'Time Base', cat:'Control',
  ins:[{n:'set',t:'val'}],
  outs:[{n:'t',t:'num'},{n:'iso',t:'txt'},{n:'tod',t:'num'}],
  readout:true,
  params:[
    {n:'source',t:'select',opts:['system','manual'],d:'manual',label:'source'},
    {n:'start',t:'text',d:'2026-01-01 08:00:00',label:'start, UTC'},
    {n:'speed',t:'range',min:.01,max:10000,step:.01,log:true,d:1,label:'speed ×'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'now',t:'button',label:'Set to start',fn:n=>tbSet(n,tbParse(n.p.start)??Date.now()/1000)},
    {n:'sys',t:'button',label:'Set to now',fn:n=>tbSet(n,Date.now()/1000)},
  ],
  init:n=>{ n.t=tbParse(n.p.start)??Date.now()/1000; n.setPrev=undefined; },
  process(n,I){
    const dt=BLOCK/Eng.sr;
    if(I.set!==null && I.set!==undefined && I.set!==n.setPrev){   // вход set: epoch (с или мс) или строка даты
      n.setPrev=I.set;
      const v=typeof I.set==='number' ? (I.set>1e11 ? I.set/1000 : I.set) : tbParse(I.set);
      if(v!=null && isFinite(v)) n.t=v;
    }
    if(n.p.source==='system') n.t=Date.now()/1000;
    else if(n.p.run) n.t+=dt*(+n.p.speed||1);
    const d=new Date(n.t*1000);
    return {t:n.t, iso:d.toISOString().slice(0,19).replace('T',' '), tod:n.t%86400};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=new Date(n.t*1000).toISOString().slice(0,19).replace('T',' ')+' UTC'; }
});

/* ---------- Cron ---------- */
// Расписание как у crontab (см. cronParse в core-dsp.js). Время — вход t (Time Base) или системные часы.
// Импульс trig — один блок; gate держится dur секунд после срабатывания («писать 10 минут каждый час»).
// Пропущенное срабатывание (перемотка, вкладка спала > 2 мин) не догоняется.
def({ id:'cron', title:'Cron', cat:'Control',
  ins:[{n:'t',t:'num'}],
  outs:[{n:'trig',t:'num'},{n:'gate',t:'num'},{n:'n',t:'num'},{n:'next',t:'num'}],
  readout:true,
  params:[
    {n:'expr',t:'text',d:'*/15 * * * *',label:'cron: min hour day month weekday (or @hourly @daily @weekly @monthly)'},
    {n:'tz',t:'select',opts:['UTC','local'],d:'UTC',label:'zone'},
    {n:'dur',t:'range',min:0,max:86400,step:1,log:false,d:0,label:'gate length, s'},
    {n:'run',t:'check',d:true,label:'run'},
  ],
  init:n=>{ n.src=null; n.c=null; n.nextAt=null; n.fired=0; n.hi=false; n.gateEnd=-1; n.err=false; n.lastT=null; },
  process(n,I){
    const p=n.p, cur=typeof I.t==='number' ? (I.t>1e11 ? I.t/1000 : I.t) : Date.now()/1000;
    const off=p.tz==='local' ? -new Date(cur*1000).getTimezoneOffset()*60 : 0;
    const key=p.expr+'|'+p.tz;
    if(key!==n.src){ n.src=key; n.c=cronParse(p.expr); n.err=!n.c; n.nextAt=n.c ? cronNext(n.c,cur,off) : null; }
    if(n.lastT!=null && (cur<n.lastT || cur-n.lastT>120)) n.nextAt=n.c ? cronNext(n.c,cur,off) : null;   // перемотка: не догоняем
    n.lastT=cur;
    let fire=false;
    if(n.hi) n.hi=false;
    else if(p.run && n.c && n.nextAt!=null && cur>=n.nextAt){
      fire=true; n.hi=true; n.fired++; n.gateEnd=cur+p.dur; n.nextAt=cronNext(n.c,cur,off);
    }
    n.cur=cur;
    return {trig:fire?1:0, gate:p.dur>0 && cur<n.gateEnd ? 1 : 0, n:n.fired, next:n.nextAt!=null ? Math.max(0,n.nextAt-cur) : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const nx=n.nextAt!=null ? new Date(n.nextAt*1000+((n.p.tz==='local' ? -new Date(n.nextAt*1000).getTimezoneOffset()*60 : 0))*1000).toISOString().slice(0,16).replace('T',' ') : '—';
    r.textContent=n.err ? 'bad cron expression' : (n.p.run ? '' : 'stopped · ')+'fired '+n.fired+' · next '+nx+(n.p.tz==='local'?' local':' UTC'); }
});

/* ---------- Trigger Clock ---------- */
// interval / random / poisson / schedule. Импульс держится один блок, между двумя событиями
// всегда есть блок без импульса (чтобы потребитель увидел фронт).
function tcSchedule(s){                               // "08:00, 12:30:15, */15s, */5m" → [{tod}|{every}]
  const out=[];
  for(const part of String(s||'').split(/[,;\s]+/)){
    let m=part.match(/^\*\/(\d+(?:\.\d+)?)([smh]?)$/);
    if(m){ out.push({every:+m[1]*({s:1,m:60,h:3600}[m[2]||'s'])}); continue; }
    m=part.match(/^(\d{1,2}):(\d\d)(?::(\d\d))?$/);
    if(m) out.push({tod:+m[1]*3600+ +m[2]*60+ +(m[3]||0)});
  }
  return out;
}
function tcNextInterval(n){
  const p=n.p, iv=Math.max(0.001,+p.interval||1);
  if(p.mode==='random'){ const a=Math.min(p.rmin,p.rmax), b=Math.max(p.rmin,p.rmax); return a+Math.random()*(b-a); }
  if(p.mode==='poisson') return -Math.log(1-Math.random())*iv;
  return iv*(1+(Math.random()*2-1)*(p.jitter/100));
}
function tcReset(n){
  n.time=0; n.next=+n.p.delay||0; n.inBurst=0; n.fired=0; n.hi=false; n.pending=false;
  n.gateEnd=-1; n.wall=0; n.prevT=null; n.stopped=false;
}
def({ id:'tclock', title:'Trigger Clock', cat:'Control',
  ins:[{n:'t',t:'num'},{n:'reset',t:'val'}],
  outs:[{n:'trig',t:'num'},{n:'gate',t:'num'},{n:'n',t:'num'},{n:'next',t:'num'}],
  readout:true,
  params:[
    {n:'mode',t:'select',opts:['interval','random','poisson','schedule'],d:'interval',
      label:'mode'},
    {n:'interval',t:'range',min:.02,max:3600,step:.01,log:true,d:1,label:'interval, s'},
    {n:'jitter',t:'range',min:0,max:100,step:1,d:0,label:'jitter, %'},
    {n:'rmin',t:'range',min:.02,max:3600,step:.01,log:true,d:1,label:'min, s'},
    {n:'rmax',t:'range',min:.02,max:3600,step:.01,log:true,d:5,label:'max, s'},
    {n:'width',t:'range',min:0,max:3600,step:.01,d:0,label:'gate, s'},
    {n:'burst',t:'range',min:1,max:100,step:1,d:1,label:'burst'},
    {n:'gap',t:'range',min:.02,max:60,step:.01,log:true,d:.2,label:'gap, s'},
    {n:'delay',t:'range',min:0,max:3600,step:.1,d:0,label:'delay, s'},
    {n:'count',t:'range',min:0,max:100000,step:1,d:0,label:'max N (0=∞)'},
    {n:'at',t:'text',d:'*/30s',label:'schedule'},
    {n:'tz',t:'select',opts:['UTC','local'],d:'UTC',label:'zone'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'reset',t:'button',label:'Reset',fn:n=>tcReset(n)},
  ],
  init:n=>{ tcReset(n); n.rstPrev=0; n.sched=null; n.schedSrc=null; n.wall=0; },
  process(n,I){
    const p=n.p, dt=BLOCK/Eng.sr;
    const rst=typeof I.reset==='number' ? I.reset : 0;
    if(rst>0.5 && n.rstPrev<=0.5) tcReset(n);
    n.rstPrev=rst;
    let fire=false;
    n.wall+=dt;
    if(p.run && !n.stopped){
      if(p.mode==='schedule'){
        if(n.schedSrc!==p.at){ n.schedSrc=p.at; n.sched=tcSchedule(p.at); }
        const cur=typeof I.t==='number' ? I.t : Date.now()/1000;
        const prev=n.prevT; n.prevT=cur;
        if(prev!==null && cur>prev && cur-prev<86400*2){
          const off=p.tz==='local' ? -new Date(cur*1000).getTimezoneOffset()*60 : 0;
          for(const e of n.sched){
            if(e.every){ if(Math.floor((cur+off)/e.every)>Math.floor((prev+off)/e.every)) n.pending=true; }
            else for(let d=Math.floor((prev+off)/86400); d<=Math.floor((cur+off)/86400); d++){
              const occ=d*86400+e.tod-off; if(occ>prev && occ<=cur) n.pending=true; }
          }
        }
      } else {
        n.time+=dt;
        if(n.time>=n.next){
          n.pending=true;
          if(++n.inBurst<(p.burst|0)) n.next=n.time+Math.max(.001,+p.gap||.2);
          else { n.inBurst=0; n.next=n.time+tcNextInterval(n); }
        }
      }
    }
    if(n.hi){ n.hi=false; }                           // пауза в один блок между импульсами
    else if(n.pending){
      n.pending=false; fire=true; n.hi=true; n.fired++;
      if(p.width>0) n.gateEnd=n.wall+p.width;
      if(p.count>0 && n.fired>=p.count) n.stopped=true;
    }
    const gate=p.width>0 && n.wall<n.gateEnd ? 1 : 0;
    return {trig:fire?1:0, gate, n:n.fired, next:p.mode==='schedule' ? 0 : Math.max(0,n.next-n.time)};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=(n.stopped?'stopped · ':'')+'triggers '+n.fired+(n.p.mode==='schedule'?' · '+n.p.at:' · next in '+Math.max(0,n.next-n.time).toFixed(1)+' s'); }
});

/* ---------- Stopwatch ---------- */
// Замер интервала между событием start и событием stop (задержки, время передачи данных).
// Событие: фронт числа/сигнала через порог (в сигнале — с точностью до доли отсчёта), либо новое значение
// не-числового входа (текст, rec, bin). Часы: wall — performance.now() (реальное время, мкс),
// samples — счётчик отсчётов узла (точное время в цепочке DSP, не зависит от нагрузки).
function swReset(n){
  n.run=false; n.t0=0; n.last=null; n.st=swStat(); n.recQ=[]; n.es={}; n.pv={};
}
function swClock(n){ return n.p.clock==='samples' ? n.smp/Eng.sr*1000 : performance.now(); }
function swAbs(n,t){ return n.clk==='samples' ? t : performance.timeOrigin+t; }
function swEvent(n,k,t){
  if(k==='reset'){ swReset(n); return; }
  const toggle=k==='start' && n.p.mode==='toggle' && n.run;
  if(k==='start' && !toggle){
    if(n.run && n.p.again==='ignore') return;
    n.run=true; n.t0=t; n.clk=n.p.clock; return;
  }
  if(!n.run) return;                                   // stop (или повторный toggle) без старта
  const ms=Math.max(0,t-n.t0);
  n.run=false; n.last=ms; n.done=1; swAdd(n.st,ms);
  n.recQ.push({n:n.st.n, start:swAbs(n,n.t0), end:swAbs(n,t), ms, clock:n.clk});
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
function swInput(n,key,v,ev){
  if(v===null || v===undefined){ delete n.es[key]; n.pv[key]=null; return; }
  if(typeof v==='number' || v instanceof Float32Array){
    for(const p of swEdges(n.es[key]||(n.es[key]={}),v,+n.p.thr,.05)) ev.push({p,k:key});
  } else {
    if(v!==n.pv[key] && v.length!==0) ev.push({p:0,k:key});
    n.pv[key]=v;
  }
}
def({ id:'stopwatch', title:'Stopwatch', cat:'Control',
  ins:[{n:'start',t:'val'},{n:'stop',t:'val'},{n:'reset',t:'val'}],
  outs:[{n:'ms',t:'num'},{n:'elapsed',t:'num'},{n:'run',t:'num'},{n:'done',t:'num'},{n:'rec',t:'rec'},
        {n:'text',t:'txt'},{n:'mean',t:'num'},{n:'n',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'clock',t:'select',opts:['wall','samples'],d:'wall',label:'clock (wall = real time, samples = sample count)'},
    {n:'mode',t:'select',opts:['start/stop','toggle'],d:'start/stop',label:'mode (toggle: every start edge flips)'},
    {n:'again',t:'select',opts:['ignore','restart'],d:'ignore',label:'start while running'},
    {n:'thr',t:'range',min:-1,max:1,step:.01,d:.5,label:'threshold'},
    {n:'go',t:'button',label:'Start / Stop',fn:n=>swEvent(n,n.run ? 'stop' : 'start',swClock(n))},
    {n:'rst',t:'button',label:'Reset',fn:n=>swEvent(n,'reset')},
  ],
  init:n=>{ n.smp=0; n.clk=n.p.clock; n.done=0; swReset(n); },
  process(n,I){
    const w0=performance.now(), sr=Eng.sr, ev=[];
    n.done=0;
    swInput(n,'start',I.start,ev); swInput(n,'stop',I.stop,ev); swInput(n,'reset',I.reset,ev);
    ev.sort((a,b)=>a.p-b.p);
    for(const e of ev) swEvent(n,e.k, n.p.clock==='samples' ? (n.smp+e.p)/sr*1000 : w0+e.p/sr*1000);
    n.smp+=BLOCK;
    const el=n.run ? Math.max(0,(n.clk==='samples' ? (n.smp)/sr*1000 : w0)-n.t0) : 0;
    n.elapsed=el;
    const s=n.st, last=n.last;
    return {ms:last??0, elapsed:el, run:n.run?1:0, done:n.done, rec:n.recQ.length ? n.recQ.splice(0) : null,
      text:last!==null ? swFmt(last) : null, mean:s.n ? s.mean : 0, n:s.n};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const s=n.st, l1=n.run ? '● '+swFmt(n.elapsed) : n.last!==null ? swFmt(n.last) : '—';
    r.textContent=l1+(s.n ? '\nn '+s.n+' · min '+swFmt(s.min)+' · avg '+swFmt(s.mean)+' · max '+swFmt(s.max)+' · σ '+swFmt(swSd(s)) : ''); }
});
