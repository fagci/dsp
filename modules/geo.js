"use strict";
/* ============================ ЗАПИСИ (rec) И КАРТА ============================ */
// Порт 'rec' — поток записей: в блоке, где что-то пришло, на выходе массив объектов
// {поле: значение}, в остальных блоках null. Узлы-потребители читают через recList().
// Известные карте поля: lat, lon (или grid — локатор Maidenhead), id, t, label, icon, color,
// size, radius (м), azimuth (°), range (км, длина пеленга), heading, lat2/lon2, rssi, snr.
// Остальные поля карта показывает как «ключ: значение».

function recList(v){ return Array.isArray(v) ? v : (v && typeof v==='object') ? [v] : []; }
function recNum(v){
  if(typeof v==='number') return isFinite(v) ? v : null;
  if(typeof v==='string' && v.trim()!==''){ const x=Number(v); return isFinite(x) ? x : null; }
  return null;
}
// имена портов узла и его параметров — полям так называться нельзя
const REC_RESERVED=new Set(['rec','go','count','names','consts','mode','apply','detect','rej']);
function recFieldNames(s){
  return [...new Set(String(s||'').split(',').map(x=>x.trim()).filter(x=>x && !REC_RESERVED.has(x)))];
}
function recConsts(s){                                // "icon=plane; color=#f80"
  const o={};
  for(const part of String(s||'').split(/[;\n]/)){
    const i=part.indexOf('='); if(i<=0) continue;
    const k=part.slice(0,i).trim(); if(k) o[k]=hostlistCoerce(part.slice(i+1));
  }
  return o;
}
// байтовые массивы (кадры декодеров): в тексте — длина, в CSV (full) — hex
function recFmt(v,full){
  if(typeof v==='number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  if(v instanceof Uint8Array) return full ? Array.from(v,b=>(b<16?'0':'')+b.toString(16)).join('') : '‹'+v.length+' bytes›';
  if(v && typeof v==='object') return JSON.stringify(v);
  return String(v);
}
function recText(r,skip){
  if(!r) return '';
  return Object.keys(r).filter(k=>!skip || !skip.has(k)).map(k=>k+': '+recFmt(r[k])).join('\n');
}
// время записи: t/time/date — мс, секунды unix или строка даты; иначе — сейчас
function recTime(r){
  for(const k of ['t','time','date','datetime','ts']){
    const v=r[k]; if(v==null || v==='') continue;
    if(typeof v==='number' && isFinite(v)) return v>1e11 ? v : v>1e8 ? v*1000 : null;
    const p=Date.parse(String(v)); if(isFinite(p)) return p;
  }
  return null;
}

// CSV с выбором разделителя ('' — угадать по первой строке), кавычки и "" внутри поля
function geoCsvDelim(line){
  const c={',':0,';':0,'\t':0};
  for(const ch of line) if(ch in c) c[ch]++;
  return c['\t']>=c[';'] && c['\t']>=c[','] && c['\t']>0 ? '\t' : c[';']>c[','] ? ';' : ',';
}
function geoCsvParse(text,delim){
  const rows=[]; let i=0, field='', row=[], inQ=false; const N=text.length;
  if(!delim){ const nl=text.indexOf('\n'); delim=geoCsvDelim(nl<0?text:text.slice(0,nl)); }
  while(i<N){
    const c=text[i];
    if(inQ){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i+=2; continue; } inQ=false; i++; continue; }
      field+=c; i++; continue;
    }
    if(c==='"' && field===''){ inQ=true; i++; continue; }
    if(c===delim){ row.push(field); field=''; i++; continue; }
    if(c==='\r'){ i++; continue; }
    if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; i++; continue; }
    field+=c; i++;
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.length>1 || r[0]!=='');
}
function geoCsvCell(v){
  const s=v==null ? '' : recFmt(v,true);
  return /[",\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function recsToCsv(recs){
  const keys=[]; const seen=new Set();
  for(const r of recs) for(const k in r) if(!seen.has(k)){ seen.add(k); keys.push(k); }
  return [keys.join(','), ...recs.map(r=>keys.map(k=>geoCsvCell(r[k])).join(','))].join('\r\n');
}
// фигуры: geom — [[lat,lon],…] (массив или JSON-строка), gtype — line | polygon | ruler; круг — точка с radius
const GEO_GCACHE=new Map();
function geoParseGeom(g){
  if(Array.isArray(g)) return g.length && g.every(q=>Array.isArray(q) && isFinite(q[0]) && isFinite(q[1])) ? g : null;
  if(typeof g!=='string' || g[0]!=='[') return null;
  let a=GEO_GCACHE.get(g);
  if(a===undefined){
    try{ a=geoParseGeom(JSON.parse(g)); }catch(e){ a=null; }
    if(GEO_GCACHE.size>500) GEO_GCACHE.clear();
    GEO_GCACHE.set(g,a);
  }
  return a;
}
function geoPathKm(pts,closed){
  let km=0;
  for(let i=1;i<pts.length;i++) km+=geoDist(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]);
  if(closed && pts.length>2) km+=geoDist(pts[pts.length-1][0],pts[pts.length-1][1],pts[0][0],pts[0][1]);
  return km;
}
function geoAreaKm2(pts){                            // площадь на сфере, км²
  let a=0;
  for(let i=0;i<pts.length;i++){
    const p=pts[i], q=pts[(i+1)%pts.length];
    let dl=(q[1]-p[1])*D2R; if(dl>Math.PI) dl-=2*Math.PI; else if(dl<-Math.PI) dl+=2*Math.PI;
    a+=dl*(2+Math.sin(p[0]*D2R)+Math.sin(q[0]*D2R));
  }
  return Math.abs(a)*GEO_R*GEO_R/2;
}
function geoFmtDist(km){ return km<1 ? Math.round(km*1000)+' m' : km<100 ? km.toFixed(2)+' km' : Math.round(km)+' km'; }
function geoFmtArea(km2){ return km2<1 ? Math.round(km2*1e6)+' m²' : km2<100 ? km2.toFixed(2)+' km²' : Math.round(km2)+' km²'; }
function geoShapeMetrics(type,pts){
  const poly=type==='polygon' && pts.length>2, o={};
  o.length_m=Math.round(geoPathKm(pts,poly)*1000);
  if(poly) o.area_m2=Math.round(geoAreaKm2(pts)*1e6);
  return o;
}
function recsToGeoJson(recs){
  const feats=[];
  for(const r of recs){
    const p=geoRecPos(r); if(!p) continue;
    const g=geoParseGeom(r.geom), ll=g && g.map(q=>[q[1],q[0]]);
    const geometry=g && r.gtype==='polygon' && g.length>2 ? {type:'Polygon', coordinates:[[...ll,ll[0]]]}
      : g && g.length>1 ? {type:'LineString', coordinates:ll} : {type:'Point', coordinates:[p.lon,p.lat]};
    feats.push({type:'Feature', geometry, properties:r});
  }
  return JSON.stringify({type:'FeatureCollection', features:feats});
}

function geoXml(v){ return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function geoRecIso(r){ const t=+r.t; return isFinite(t) && t>1e11 ? new Date(t).toISOString() : ''; }
function geoRecName(r){ return r.label ?? r.name ?? r.id ?? ''; }
function recsToKml(recs){
  const pm=[];
  for(const r of recs){
    const p=geoRecPos(r); if(!p) continue;
    const iso=geoRecIso(r);
    const data=Object.keys(r).filter(k=>r[k]!=null && typeof r[k]!=='object')
      .map(k=>`<Data name="${geoXml(k)}"><value>${geoXml(r[k])}</value></Data>`).join('');
    const g=geoParseGeom(r.geom), cs=g && g.map(q=>q[1]+','+q[0]).join(' ');
    const geo=g && r.gtype==='polygon' && g.length>2 ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${cs} ${g[0][1]},${g[0][0]}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      : g && g.length>1 ? `<LineString><coordinates>${cs}</coordinates></LineString>` : `<Point><coordinates>${p.lon},${p.lat}</coordinates></Point>`;
    pm.push(`<Placemark><name>${geoXml(geoRecName(r))}</name>`+(iso?`<TimeStamp><when>${iso}</when></TimeStamp>`:'')+
      `<ExtendedData>${data}</ExtendedData>${geo}</Placemark>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'+pm.join('')+'</Document></kml>';
}
function recsToGpx(recs){
  const w=[];
  for(const r of recs){
    const p=geoRecPos(r); if(!p) continue;
    const iso=geoRecIso(r), ele=isFinite(+r.alt) && r.alt!=='' && r.alt!=null ? `<ele>${+r.alt}</ele>` : '';
    const desc=Object.keys(r).filter(k=>r[k]!=null && typeof r[k]!=='object' && !['lat','lon','t','label','id','name'].includes(k))
      .map(k=>k+'='+r[k]).join('; ');
    w.push(`<wpt lat="${p.lat}" lon="${p.lon}">${ele}`+(iso?`<time>${iso}</time>`:'')+
      `<name>${geoXml(geoRecName(r))}</name>`+(desc?`<desc>${geoXml(desc)}</desc>`:'')+'</wpt>');
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="DSP workbench" xmlns="http://www.topografix.com/GPX/1/1">'+w.join('')+'</gpx>';
}
// кнопки Save KML / Save GPX рядом с Save GeoJSON: get(n) → записи узла
function geoExportBtns(get,prefix,adv){
  const b=(n,label,fn)=>({n,t:'button',label,fn,...(adv?{adv:true}:{})});
  return [b('kml','Save KML',n=>dl(new Blob([recsToKml(get(n))],{type:'application/vnd.google-earth.kml+xml'}),prefix+'-'+Date.now()+'.kml')),
          b('gpx','Save GPX',n=>dl(new Blob([recsToGpx(get(n))],{type:'application/gpx+xml'}),prefix+'-'+Date.now()+'.gpx'))];
}

/* ---------- геодезия ---------- */
const GEO_R=6371.0088;                               // средний радиус Земли, км
const D2R=Math.PI/180;
function geoDist(lat1,lon1,lat2,lon2){               // км, по большому кругу
  const a=Math.sin((lat2-lat1)*D2R/2)**2+Math.cos(lat1*D2R)*Math.cos(lat2*D2R)*Math.sin((lon2-lon1)*D2R/2)**2;
  return 2*GEO_R*Math.asin(Math.min(1,Math.sqrt(a)));
}
function geoBearing(lat1,lon1,lat2,lon2){            // начальный азимут, 0..360
  const f1=lat1*D2R, f2=lat2*D2R, dl=(lon2-lon1)*D2R;
  const b=Math.atan2(Math.sin(dl)*Math.cos(f2), Math.cos(f1)*Math.sin(f2)-Math.sin(f1)*Math.cos(f2)*Math.cos(dl));
  return (b/D2R+360)%360;
}
function geoDest(lat,lon,brg,km){                    // точка на расстоянии km по азимуту brg
  const d=km/GEO_R, f1=lat*D2R, t=brg*D2R;
  const f2=Math.asin(Math.sin(f1)*Math.cos(d)+Math.cos(f1)*Math.sin(d)*Math.cos(t));
  const l2=lon*D2R+Math.atan2(Math.sin(t)*Math.sin(d)*Math.cos(f1), Math.cos(d)-Math.sin(f1)*Math.sin(f2));
  return {lat:f2/D2R, lon:((l2/D2R+540)%360)-180};
}
// Maidenhead: 2/4/6/8 знаков → центр квадрата и его размер в градусах
function gridToLatLon(g){
  g=String(g||'').trim().toUpperCase();
  if(!/^[A-R]{2}(\d\d([A-X]{2}(\d\d)?)?)?$/.test(g)) return null;
  let lon=-180+(g.charCodeAt(0)-65)*20, lat=-90+(g.charCodeAt(1)-65)*10, w=20, h=10;
  if(g.length>=4){ lon+=(+g[2])*2; lat+=+g[3]; w=2; h=1; }
  if(g.length>=6){ w=2/24; h=1/24; lon+=(g.charCodeAt(4)-65)*w; lat+=(g.charCodeAt(5)-65)*h; }
  if(g.length>=8){ w/=10; h/=10; lon+=(+g[6])*w; lat+=(+g[7])*h; }
  return {lat:lat+h/2, lon:lon+w/2, w, h};
}
function latLonToGrid(lat,lon,len=6){
  let x=clamp(lon+180,0,359.9999999), y=clamp(lat+90,0,179.9999999);
  let s=String.fromCharCode(65+Math.floor(x/20), 65+Math.floor(y/10));
  x%=20; y%=10;
  if(len>=4){ s+=Math.floor(x/2)+''+Math.floor(y); x%=2; y%=1; }
  if(len>=6){ s+=String.fromCharCode(97+Math.floor(x*12), 97+Math.floor(y*24)); x%=1/12; y%=1/24; }
  if(len>=8){ s+=Math.floor(x*120)+''+Math.floor(y*240); }
  return s;
}
// координаты записи: lat/lon (или latitude/longitude/lng), иначе локатор grid/locator
function geoRecPos(r){
  let lat=recNum(r.lat ?? r.latitude), lon=recNum(r.lon ?? r.lng ?? r.longitude);
  if(lat!=null && lon!=null && Math.abs(lat)<=90 && Math.abs(lon)<=180) return {lat,lon};
  const g=gridToLatLon(r.grid ?? r.locator);
  return g ? {lat:g.lat, lon:g.lon, grid:g} : null;
}

/* ---------- узлы записей ---------- */
def({ id:'recPack', title:'Fields → Rec', cat:'Data',
  // Собирает запись из значений на входах. С входом rec — дописывает поля в каждую
  // приходящую запись (константы и подключённые входы перекрывают её поля).
  ins:n=>[{n:'rec',t:'rec'},{n:'go',t:'num'},...recFieldNames(n.p.names).map(f=>({n:f,t:'val'}))],
  outs:[{n:'rec',t:'rec'}],
  readout:true,
  params:[{n:'names',t:'text',d:'lat,lon,id',label:'fields, comma-separated'},
          {n:'consts',t:'text',d:'',label:'constants: key=value; …'},
          {n:'mode',t:'select',opts:['change','trigger','always'],d:'change',label:'emit'},
          {n:'apply',t:'button',label:'Apply fields',fn:n=>{ rebuildNode(n); markTopoDirty(); }}],
  init:n=>{ n.prevGo=0; n.lastKey=''; n.last=null; n.count=0; },
  process(n,I){
    if(!n._cc || n._cc.src!==n.p.consts) n._cc={src:n.p.consts, o:recConsts(n.p.consts)};
    const consts=n._cc.o, cur={};
    let any=false;
    for(const f of recFieldNames(n.p.names)){
      const v=I[f];
      if(v==null || (typeof v==='number' && !isFinite(v))) continue;
      cur[f]=v; any=true;
    }
    const src=recList(I.rec);
    if(src.length){
      const out=src.map(r=>({...r, ...consts, ...cur}));
      n.last=out[out.length-1]; n.count+=out.length;
      return {rec:out};
    }
    const go=typeof I.go==='number' ? I.go : 0, edge=go>0.5 && n.prevGo<=0.5; n.prevGo=go;
    let fire=edge;
    if(n.p.mode==='always') fire=fire || any;
    else if(n.p.mode==='change'){
      const key=any ? JSON.stringify(cur) : '';
      if(any && key!==n.lastKey) fire=true;
      n.lastKey=key;
    }
    if(!fire) return {rec:null};
    const r={t:Date.now(), ...consts, ...cur};
    n.last=r; n.count++;
    return {rec:[r]};
  },
  draw(n){ n.el.querySelector('.readout').textContent=
    'emitted '+n.count+(n.last ? '\n'+recText(n.last) : ''); }});

def({ id:'recUnpack', title:'Rec → Fields', cat:'Data',
  // Раскладывает поля последней пришедшей записи по выходам; значения держатся до следующей.
  ins:[{n:'rec',t:'rec'}],
  outs:n=>[{n:'go',t:'num'},{n:'count',t:'num'},...recFieldNames(n.p.names).map(f=>({n:f,t:'val'}))],
  readout:true,
  params:[{n:'names',t:'text',d:'lat,lon,id',label:'fields, comma-separated'},
          {n:'apply',t:'button',label:'Apply fields',fn:n=>{ rebuildNode(n); markTopoDirty(); }},
          {n:'detect',t:'button',label:'Fields from last rec',fn:n=>{
            if(!n.last) return;
            n.p.names=Object.keys(n.last).filter(k=>!REC_RESERVED.has(k)).join(',');
            rebuildNode(n); markTopoDirty(); }}],
  init:n=>{ n.last=null; n.count=0; n.vals={}; },
  process(n,I){
    const recs=recList(I.rec);
    if(recs.length){
      n.last=recs[recs.length-1]; n.count+=recs.length;
      n.vals={};
      for(const f of recFieldNames(n.p.names)) n.vals[f]=n.last[f] ?? null;
    }
    return {...n.vals, go:recs.length?1:0, count:n.count};
  },
  draw(n){ n.el.querySelector('.readout').textContent=
    'received '+n.count+(n.last ? '\n'+recText(n.last) : ''); }});

def({ id:'recCsv', title:'CSV → Rec', cat:'Data',
  // Строки CSV (с webserial, текстового источника и т.п.) или целый файл → записи.
  // Имена полей: из параметра или, если он пуст, из первой строки (заголовок).
  ins:[{n:'line',t:'txt'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'names',t:'text',d:'',label:'fields (empty — header line)'},
          {n:'delim',t:'select',opts:['auto',',',';','tab'],d:'auto',label:'delimiter'},
          {n:'file',t:'file',accept:'.csv,.tsv,.txt,text/csv,text/plain',fn:(n,f)=>{
            const rd=new FileReader();
            rd.onload=()=>recCsvFile(n,String(rd.result));
            rd.readAsText(f); }},
          {n:'reset',t:'button',label:'Reset header',fn:n=>{ n.hdr=null; }}],
  init:n=>{ n.hdr=null; n.lastLine=null; n.queue=[]; n.count=0; n.last=null; n.msg=''; },
  process(n,I){
    const out=[];
    if(typeof I.line==='string' && I.line!==n.lastLine){
      n.lastLine=I.line;
      const d=n.p.delim==='tab' ? '\t' : n.p.delim==='auto' ? '' : n.p.delim;
      for(const row of geoCsvParse(I.line,d)){
        const r=recCsvRow(n,row); if(r) out.push(r);
      }
    }
    if(n.queue.length) out.push(...n.queue.splice(0,500));   // файл — порциями, не всё в один блок
    if(!out.length) return {rec:null, count:n.count};
    n.count+=out.length; n.last=out[out.length-1];
    return {rec:out, count:n.count};
  },
  draw(n){ n.el.querySelector('.readout').textContent=
    (n.msg ? n.msg+'\n' : '')+'records '+n.count+(n.queue.length ? ' · queued '+n.queue.length : '')+
    (n.last ? '\n'+recText(n.last) : ''); }});
function recCsvRow(n,row){
  const names=recFieldNames(n.p.names);
  let hdr=names.length ? names : n.hdr;
  if(!hdr){ n.hdr=row.map(s=>s.trim()); return null; }
  const r={};
  hdr.forEach((f,i)=>{ if(f && row[i]!==undefined && row[i]!=='') r[f]=hostlistCoerce(row[i]); });
  return Object.keys(r).length ? r : null;
}
function recCsvFile(n,text){
  const d=n.p.delim==='tab' ? '\t' : n.p.delim==='auto' ? '' : n.p.delim;
  const rows=geoCsvParse(text,d);
  const save=n.hdr; if(!recFieldNames(n.p.names).length) n.hdr=null;   // у файла свой заголовок
  const recs=[];
  for(const row of rows){ const r=recCsvRow(n,row); if(r) recs.push(r); }
  n.hdr=save;
  n.queue.push(...recs);
  n.msg='file: '+recs.length+' rows';
}

def({ id:'recLog', title:'Rec Log', cat:'Output',
  // Копит записи; сохранение в CSV (все встреченные поля) и GeoJSON (записи с координатами).
  // Replay — отправить накопленное заново (например, на карту после её очистки).
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true,
  params:[{n:'max',t:'range',min:100,max:100000,step:100,d:10000,label:'max records'},
          {n:'on',t:'check',d:true,label:'record'},
          {n:'csv',t:'button',label:'Save CSV',fn:n=>dl(new Blob(['\ufeff'+recsToCsv(n.rows)],{type:'text/csv;charset=utf-8'}),'records-'+Date.now()+'.csv')},
          {n:'geojson',t:'button',label:'Save GeoJSON',fn:n=>dl(new Blob([recsToGeoJson(n.rows)],{type:'application/geo+json'}),'records-'+Date.now()+'.geojson')},
          ...geoExportBtns(n=>n.rows,'records'),
          {n:'replay',t:'button',label:'Replay',fn:n=>{ n.replay=n.rows.slice(); }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.rows=[]; }}],
  init:n=>{ n.rows=[]; n.replay=null; },
  process(n,I){
    const recs=recList(I.rec);
    if(recs.length && n.p.on){
      n.rows.push(...recs);
      if(n.rows.length>n.p.max) n.rows.splice(0,n.rows.length-n.p.max);
    }
    let out=recs.length ? recs : null;
    if(n.replay?.length){ const part=n.replay.splice(0,500); out=out ? out.concat(part) : part; }
    return {rec:out, count:n.rows.length};
  },
  draw(n){
    const tail=n.rows.slice(-5).map(r=>Object.keys(r).map(k=>k+'='+recFmt(r[k])).join(' ')).join('\n');
    n.el.querySelector('.readout').textContent=(n.p.on?'● ':'')+'records '+n.rows.length+'\n'+tail; }});

def({ id:'recUniq', title:'Rec: Unique by Key', cat:'Data',
  // Уникальные записи по ключевому полю (id, cell id, позывной…): копит по одному экземпляру
  // на ключ, считает count и время first/last. Пример: список GSM-вышек по id (PLMN-LAC-CID),
  // самолётов по icao, станций по позывному. `new` — только впервые увиденные, `rec` — обновлённые.
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'new',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true,
  params:[{n:'key',t:'text',d:'id',label:'key field'},
          {n:'mode',t:'select',opts:['merge (last wins)','first only'],d:'merge (last wins)',label:'on repeat'},
          {n:'max',t:'range',min:100,max:100000,step:100,d:10000,label:'max keys'},
          {n:'csv',t:'button',label:'Save CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv([...n.map.values()])],{type:'text/csv;charset=utf-8'}),'unique-'+Date.now()+'.csv')},
          {n:'geojson',t:'button',label:'Save GeoJSON',fn:n=>dl(new Blob([recsToGeoJson([...n.map.values()])],{type:'application/geo+json'}),'unique-'+Date.now()+'.geojson')},
          ...geoExportBtns(n=>[...n.map.values()],'unique'),
          {n:'replay',t:'button',label:'Replay',fn:n=>{ n.replay=[...n.map.values()]; }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.map=new Map(); }}],
  init:n=>{ n.map=new Map(); n.replay=null; },
  process(n,I){
    const recs=recList(I.rec), out=[], fresh=[], key=n.p.key||'id', merge=n.p.mode!=='first only';
    for(const r of recs){
      const k=r[key]; if(k==null||k==='') continue;
      const id=String(k), t=recNum(r.t)!=null?r.t:Date.now();
      let e=n.map.get(id);
      if(!e){
        e={...r, count:1, first:t, last:t};
        if(n.map.size>=n.p.max) n.map.delete(n.map.keys().next().value);   // вытесняем самый старый
        n.map.set(id,e); fresh.push(e);
      } else {
        if(merge){ const c=e.count, f=e.first; Object.assign(e,r); e.count=c; e.first=f; }
        e.count++; e.last=t;
      }
      out.push(e);
    }
    if(n.replay?.length){ const part=n.replay.splice(0,500); out.push(...part); }
    return {rec:out.length?out:null, new:fresh.length?fresh:null, count:n.map.size};
  },
  draw(n){
    const rows=[...n.map.values()], tail=rows.slice(-8).map(e=>{
      const lt=recNum(e.last)!=null?new Date(e.last).toLocaleTimeString():'';
      const extra=Object.keys(e).filter(k=>!['count','first','last','t'].includes(k)).slice(0,4)
        .map(k=>k+'='+recFmt(e[k])).join(' ');
      return `×${e.count} ${lt} ${extra}`; }).join('\n');
    n.el.querySelector('.readout').textContent='unique '+rows.length+'\n'+tail; }});

def({ id:'recMerge', title:'Rec Merge', cat:'Data', kw:'merge join combine concat records sources',
  // Один провод на вход — поэтому несколько источников записей сводим здесь: на выход идут записи
  // всех входов за такт, по порядку входов. Необязательная метка источника — в поле src.
  ins:[{n:'rec1',t:'rec'},{n:'rec2',t:'rec'},{n:'rec3',t:'rec'},{n:'rec4',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'tags',t:'text',d:'',label:'source names for the src field (comma list: input 1, 2, …; empty — no src)'}],
  init:n=>{ n.total=0; },
  process(n,I){
    const tags=String(n.p.tags||'').split(',').map(x=>x.trim()), out=[];
    ['rec1','rec2','rec3','rec4'].forEach((k,i)=>{
      for(const r of recList(I[k])) out.push(tags[i] && r && r.src==null ? {...r, src:tags[i]} : r);
    });
    n.total+=out.length;
    return {rec:out.length?out:null, count:n.total};
  },
  draw(n){ n.el.querySelector('.readout').textContent='merged '+n.total; }});

// Условие компилируется импортом blob-модуля: new Function/eval запрещены CSP страницы
// (нет unsafe-eval), import() из blob: разрешён — так же сделан Module Builder.
// Пока модуль грузится (доли мс), записи копятся и не теряются.
function recFilterCompile(n){
  const src=n.p.expr||'true', tok=n._fn={src, f:null, ready:false};
  const url=URL.createObjectURL(new Blob(['export default (r)=>('+src+');'],{type:'text/javascript'}));
  import(url).then(m=>{ if(n._fn===tok){ tok.f=m.default; tok.ready=true; n.err=''; } })
    .catch(e=>{ if(n._fn===tok){ tok.ready=true; n.err=e.message; } })
    .finally(()=>URL.revokeObjectURL(url));
}
def({ id:'recFilter', title:'Rec Filter', cat:'Data',
  // Условие — выражение JS над записью r, например: r.snr > -10 && r.id
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'rej',t:'rec'}],
  readout:true,
  params:[{n:'expr',t:'text',d:'r.lat != null',label:'condition (r — record)'}],
  init:n=>{ n.pass=0; n.drop=0; n.err=''; n.wait=[]; },
  process(n,I){
    const recs=recList(I.rec);
    if(!n._fn || n._fn.src!==(n.p.expr||'true')) recFilterCompile(n);
    if(!n._fn.ready){                                // ещё компилируется — придержать
      if(recs.length){ n.wait.push(...recs); if(n.wait.length>20000) n.wait.splice(0,n.wait.length-20000); }
      return {rec:null, rej:null};
    }
    const all=n.wait.length ? n.wait.splice(0).concat(recs) : recs;
    if(!all.length) return {rec:null, rej:null};
    const pass=[], rej=[];
    for(const r of all){
      let ok=false;
      try{ ok=n._fn.f ? !!n._fn.f(r) : false; }catch(e){ n.err=e.message; }
      (ok ? pass : rej).push(r);
    }
    n.pass+=pass.length; n.drop+=rej.length;
    return {rec:pass.length?pass:null, rej:rej.length?rej:null};
  },
  draw(n){ n.el.querySelector('.readout').textContent=
    (n.err ? 'error: '+n.err+'\n' : '')+'pass '+n.pass+' · reject '+n.drop; }});

/* ---------- Rec → Entities: правила «запись → сущности и связи» ----------
   Строка правила: [выход[!]:] условия | поля (разделитель — « | » с пробелами). Выход — имя порта (по умолчанию только rec; rec получает всё; «имя!:» — только в порт, мимо rec).
   Условия через пробел, все должны совпасть: field (есть значение), !field, field=a|b, field!=a, field~regex.
   Поля через запятую: name=шаблон, голое name (копия, если поле есть), * (все поля записи). В шаблоне {f} — поле записи,
   {f:x} — число в hex, {a|b} — первое непустое; пусто — правило для записи пропускается.
   {f*} — поле-массив: по одной записи на элемент. Поле t переходит в результат само. */
function entSplit(s,sep){                             // делит по sep вне фигурных скобок
  const out=[]; let d=0, cur='';
  for(const ch of s){
    if(ch==='{') d++; else if(ch==='}') d=Math.max(0,d-1);
    if(ch===sep && !d){ out.push(cur); cur=''; } else cur+=ch;
  }
  out.push(cur); return out;
}
function entCond(c){
  let m;
  if((m=/^([^=!~]+)!=(.*)$/.exec(c))) { const k=m[1], v=m[2].split('|'); return r=>!v.includes(String(r[k]??'')); }
  if((m=/^([^=!~]+)=(.*)$/.exec(c)))  { const k=m[1], v=m[2].split('|'); return r=>v.includes(String(r[k]??'')); }
  if((m=/^([^=!~]+)~(.*)$/.exec(c)))  { const k=m[1], re=new RegExp(m[2],'i'); return r=>re.test(String(r[k]??'')); }
  if(c[0]==='!') { const k=c.slice(1); return r=>r[k]==null || r[k]===''; }
  return r=>r[c]!=null && r[c]!=='';
}
function entParse(text){
  const rules=[], errs=[];
  String(text||'').split('\n').forEach((raw,i)=>{
    const line=raw.trim(); if(!line || line[0]==='#') return;
    try{
      const sep=/\s\|\s/.exec(line);                 // разделитель « | »; | внутри a|b — это «или»
      let head=sep ? line.slice(0,sep.index) : '', body=sep ? line.slice(sep.index+sep[0].length) : line, out='rec';
      let only=false;
      const m=/^([A-Za-z_]\w*)(!?)\s*:\s*(.*)$/.exec(head); if(m){ out=m[1]; only=!!m[2]; head=m[3]; }
      if(out==='count') throw new Error('name taken');
      const conds=head.trim().split(/\s+/).filter(Boolean).map(entCond);
      const fields=entSplit(body,',').map(x=>x.trim()).filter(Boolean).map(f=>{
        if(f==='*') return {all:true};
        const e=f.indexOf('='); if(e<0) return {k:f,tpl:'{'+f+'}',opt:true};
        return {k:f.slice(0,e).trim(),tpl:f.slice(e+1)};
      });
      rules.push({out,only,conds,fields});
    }catch(e){ errs.push('line '+(i+1)+': '+e.message); }
  });
  return {rules,errs};
}
// шаблон → строка или null (пустое поле); fan — индекс элемента для {f*}
function entTpl(tpl,r,fan){
  let miss=false, arr=null;
  const s=tpl.replace(/\{([^{}]+)\}/g,(_,x)=>{
    const star=/\*$/.test(x); if(star) x=x.slice(0,-1);
    let hex=false; const c=x.lastIndexOf(':'); if(c>0 && x.slice(c+1)==='x'){ hex=true; x=x.slice(0,c); }
    let v=null;
    for(const a of x.split('|')){ const t=r[a.trim()]; if(t!=null && t!=='' && !(Array.isArray(t) && !t.length)){ v=t; break; } }
    if(v==null){ miss=true; return ''; }
    if(star){ if(!Array.isArray(v)){ miss=true; return ''; } arr=v; return fan==null ? '' : String(v[fan]); }
    if(hex && typeof v==='number') return v.toString(16);
    return Array.isArray(v) ? v.join(' ') : recFmt(v,true);
  });
  return miss ? {s:null} : {s,arr};
}
const entVal=s=>s!=='' && s.length<16 && !/^0\d/.test(s) && isFinite(+s) ? +s : s;
function entApply(rule,r){
  if(!rule.conds.every(f=>f(r))) return [];
  let N=1;
  for(const f of rule.fields) if(f.tpl){ const t=entTpl(f.tpl,r,null); if(t.arr){ N=t.arr.length; break; } }
  const res=[];
  for(let i=0;i<N;i++){
    const o={}; let ok=true;
    for(const f of rule.fields){
      if(f.all){ Object.assign(o,r); continue; }
      const t=entTpl(f.tpl,r,i);
      if(t.s==null){ if(f.opt) continue; ok=false; break; }
      o[f.k]=entVal(t.s);
    }
    if(ok){ if(r.t!=null && o.t==null) o.t=r.t; res.push(o); }
  }
  return res;
}
const entOutNames=text=>{ const set=new Set(); for(const r of entParse(text).rules) if(r.out!=='rec') set.add(r.out); return [...set]; };
def({ id:'recEnt', title:'Rec → Entities', cat:'Data', kw:'entity entities link graph table rules map extract card',
  // Правила превращают одну запись декодера в сущности и связи: вышка, оператор, абонент, группа…
  // Выходы-таблицы по именам из правил; всё вместе — на rec. На Table (upsert key=id) дубли схлопываются.
  ins:[{n:'rec',t:'rec'}],
  outs:n=>[{n:'rec',t:'rec'},...entOutNames(n.p.rules).map(o=>({n:o,t:'rec'})),{n:'count',t:'num'}],
  readout:true, tall:true,
  params:[{n:'rules',t:'code',plain:true,d:'',label:'rules: [out:] conditions | fields'},
          {n:'apply',t:'button',label:'Apply outputs',fn:n=>{ rebuildNode(n); markTopoDirty(); }},
          {n:'tpl',t:'select',opts:['—','GSM cells','Digital voice (DMR / P25 / NXDN)','Radio (Wi-Fi / BLE / Zigbee)','Wi-Fi map (nodes · links · packets)'],d:'—',label:'insert rules',
           fn:n=>{ const t=ENT_TEMPLATES[n.p.tpl]; if(t){ n.p.rules=(n.p.rules?n.p.rules.trimEnd()+'\n':'')+t; } n.p.tpl='—'; rebuildNode(n); markTopoDirty(); }}],
  init:n=>{ n.in=0; n.outN=0; n.err=''; },
  process(n,I){
    const recs=recList(I.rec);
    if(!n._c || n._c.src!==n.p.rules){ const c=entParse(n.p.rules); c.src=n.p.rules; n._c=c; n.err=c.errs.join('; '); }
    if(!recs.length) return {rec:null,count:n.outN};
    const all=[], by={};
    for(const r of recs) for(const rule of n._c.rules){
      const res=entApply(rule,r); if(!res.length) continue;
      if(!rule.only) all.push(...res);
      if(rule.out!=='rec') (by[rule.out]||(by[rule.out]=[])).push(...res);
    }
    n.in+=recs.length; n.outN+=all.length;
    const o={rec:all.length?all:null,count:n.outN};
    for(const k of entOutNames(n.p.rules)) o[k]=by[k]||null;
    return o;
  },
  draw(n){ n.el.querySelector('.readout').textContent=(n.err?'error: '+n.err+'\n':'')+'in '+n.in+' · out '+n.outN; }});
const ENT_TEMPLATES={
  'GSM cells':
`# сота, оператор и связь «сота → оператор», каналы ARFCN; подписи ставят только правила с известным оператором
cell: kind~^GSM-SI plmn | id, type=cell, shape=square, plmn, lac, ci, bsic, freq, dbm
cell: kind~^GSM-SI plmn op | id, label={op} LAC {lac}
operator: kind~^GSM-SI plmn | id=PLMN {plmn}, type=operator, shape=hexagon
operator: kind~^GSM-SI plmn op | id=PLMN {plmn}, label={op}
link: kind~^GSM-SI plmn | id={id}>PLMN {plmn}, from={id}, to=PLMN {plmn}, label=operator
link: kind~^GSM-SI cellArfcns | id={id}>ARFCN {cellArfcns*}, from={id}, to=ARFCN {cellArfcns*}, label=uses`,
  'Radio (Wi-Fi / BLE / Zigbee)':
`# Wi-Fi: точки доступа и станции по BSSID / MAC, связи «кто кому»; BLE и Zigbee — отдельные узлы
ap: proto=wifi kind=beacon|probe-resp bssid | id={bssid}, type=ap, label={ssid|bssid}, shape=hexagon, chan, rssi
station: proto=wifi kind~^(probe-req|assoc-req|reassoc-req)$ src | id={src}, type=station, shape=dot
station: proto=wifi kind~^(qos-)?data$ tods=1 src | id={src}, type=station, shape=dot, ap={bssid}
# пакеты: только в порт pkt (таблица кадров со ссылками на точку и клиента), на граф не идут
pkt!: proto=wifi src | id={t}:{src}:{seq|len}, t, kind, src, dst, ap={bssid}, chan, rssi
link: proto=wifi kind~^(assoc-req|reassoc-req|assoc-resp|auth|deauth|disassoc|data|qos-data)$ src dst dst!=ff:ff:ff:ff:ff:ff | id={src}>{dst}, from={src}, to={dst}, label={kind}
ble: proto=ble src | id={src}, type=ble, label={name|src}, shape=triangle, rssi
zb: proto=zb src net | id=zb:{net}:{src}, type=zigbee, label={src}, shape=square
zlink: proto=zb src dst net dst!=ffff | id=zb:{net}:{src}>{dst}, from=zb:{net}:{src}, to=zb:{net}:{dst}, label={kind}`,
  'Wi-Fi map (nodes · links · packets)':
`# три порта: node (точки и станции; note — пустая колонка для комментария, повтор записи её не трогает), link (связи; dashes=1 — пунктир), pkt (кадры)
# unicast: первый октет чётный (regex [02468ace]:); широковещание ff:ff:ff:ff:ff:ff — отдельный узел «broadcast», на него идут стрелки probe-req / beacon / широковещательных кадров
node!: proto=wifi kind=beacon|probe-resp bssid | id={bssid}, type=ap, label={ssid|bssid}, shape=star, color=#e8a200, ssid, chan, rssi, note=
node!: proto=wifi kind~^(probe-req|assoc-req|reassoc-req|auth)$ src~^[0-9a-f][02468ace]: | id={src}, type=station, label={src}, shape=dot, color=#2a9df4, chan, rssi, note=
node!: proto=wifi kind~^(qos-)?data$ tods=1 src bssid | id={src}, type=station, label={src}, shape=dot, color=#2a9df4, ap={bssid}, chan, rssi, note=
node!: proto=wifi kind~^(qos-)?data$ fromds=1 dst~^[0-9a-f][02468ace]: bssid | id={dst}, type=station, label={dst}, shape=dot, color=#2a9df4, ap={bssid}, chan, note=
link!: proto=wifi kind~^(qos-)?data$ tods=1 src bssid | id={src}>{bssid}:data, from={src}, to={bssid}, label=data, type=data
link!: proto=wifi kind~^(qos-)?data$ fromds=1 bssid dst~^([0-9a-f][02468ace]:|ff:ff:ff:ff:ff:ff$) | id={bssid}>{dst}:data, from={bssid}, to={dst}, label=data, type=data
link!: proto=wifi kind~^(assoc-req|reassoc-req|assoc-resp|reassoc-resp|auth|deauth|disassoc)$ src dst~^([0-9a-f][02468ace]:|ff:ff:ff:ff:ff:ff$) | id={src}>{dst}:mgmt, from={src}, to={dst}, label={kind}, type=mgmt
link!: proto=wifi kind=probe-resp src dst~^([0-9a-f][02468ace]:|ff:ff:ff:ff:ff:ff$) | id={src}>{dst}:probe, from={src}, to={dst}, label=probe, type=probe, dashes=1
link!: proto=wifi kind=probe-req src dst~^([0-9a-f][02468ace]:|ff:ff:ff:ff:ff:ff$) | id={src}>{dst}:probe, from={src}, to={dst}, label=probe, type=probe, dashes=1
node!: proto=wifi dst=ff:ff:ff:ff:ff:ff | id={dst}, type=broadcast, label=broadcast, shape=triangleDown, color=#8a8a8a, note=
link!: proto=wifi kind=beacon bssid dst | id={bssid}>{dst}:beacon, from={bssid}, to={dst}, label=beacon, type=beacon, dashes=1, color=#9aa0a6
link!: proto=wifi kind~^(qos-)?data$ tods=0 fromds=0 src dst~^([0-9a-f][02468ace]:|ff:ff:ff:ff:ff:ff$) | id={src}>{dst}:data, from={src}, to={dst}, label=data, type=data
pkt!: proto=wifi src | id={t}:{src}:{seq|len}, t, kind, src, dst, ap={bssid}, chan, rssi, len`,
  'Digital voice (DMR / P25 / NXDN)':
`# абоненты, группы и связи; префикс сети {src} разводит одинаковые id в разных системах
subscriber: kind=call from | id={src}:{from}, type=subscriber, label={src} {from}, shape=dot
subscriber: kind=alias from alias | id={src}:{from}, alias
talkgroup: kind=call call=group to | id={src}:TG{to}, type=talkgroup, label=TG {to}, shape=diamond
link: kind=call call=group from to | id={src}:{from}>TG{to}, from={src}:{from}, to={src}:TG{to}, label=member
link: kind=call call=private from to | id={src}:{from}>{to}, from={src}:{from}, to={src}:{to}, label=call`
};

// Своя позиция: вручную (lat/lon или локатор, ⌖ — разово из геолокации) или GPS-слежение.
// Последняя известная позиция — в GeoMe, её берут узлы, которым нужна точка приёма.
const GeoMe={lat:null, lon:null, t:0};
def({ id:'geoMe', title:'My Position', cat:'Geo',
  outs:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'alt',t:'num'},
        {n:'speed',t:'num'},{n:'heading',t:'num'},{n:'grid',t:'txt'},{n:'rec',t:'rec'}],
  readout:true,
  params:[{n:'src',t:'select',opts:['manual','gps'],d:'manual',label:'source'},
          {n:'lat',t:'num',d:55.7558,label:'lat, °'},
          {n:'lon',t:'num',d:37.6173,label:'lon, °'},
          {n:'grid',t:'text',d:'',label:'locator (sets lat/lon)'},
          {n:'locate',t:'button',label:'⌖ Locate once',fn:n=>geoMeLocate(n)},
          {n:'look',t:'num',d:'',label:'look direction, ° (when GPS has no heading)'},
          {n:'fov',t:'range',min:0,max:360,step:1,d:0,label:'field of view, ° (0 — none)'},
          {n:'fovKm',t:'num',d:'',label:'field of view range, km'},
          {n:'rings',t:'text',d:'',label:'distance rings, km (e.g. 1,5,10)'},
          {n:'hi',t:'check',d:true,label:'high accuracy (GPS)',adv:true},
          {n:'id',t:'text',d:'me',label:'record id',adv:true}],
  init:n=>{
    if(n.p.on===true) n.p.src='gps';               // старые патчи: галка «track position»
    delete n.p.on;
    n.watch=null; n.fix=null; n.newFix=false; n.msg=''; n.wOn=false; n.lastGrid=n.p.grid; n.lastLL='';
  },
  dispose:n=>geoMeStop(n),
  process(n){
    const gps=n.p.src==='gps';
    if(gps && !n.wOn) geoMeStart(n);
    else if(!gps && n.wOn) geoMeStop(n);
    let f=null;
    if(gps) f=n.fix;
    else {
      // локатор правят руками — пересчитать lat/lon; lat/lon правят — обновить локатор
      if(n.p.grid!==n.lastGrid){
        n.lastGrid=n.p.grid;
        const g=gridToLatLon(n.p.grid);
        if(g){ setMod(n,'lat',+g.lat.toFixed(5)); setMod(n,'lon',+g.lon.toFixed(5)); n.lastLL=n.p.lat+','+n.p.lon; }
      }
      const lat=recNum(n.p.lat), lon=recNum(n.p.lon);
      if(lat!=null && lon!=null && Math.abs(lat)<=90 && Math.abs(lon)<=180){
        const key=lat+','+lon;
        if(key!==n.lastLL){
          n.lastLL=key;
          const g=latLonToGrid(lat,lon,6);
          const cur=String(n.p.grid||'').trim();          // точка всё ещё в введённом квадрате — локатор не трогаем
          if(!gridToLatLon(cur) || latLonToGrid(lat,lon,cur.length).toUpperCase()!==cur.toUpperCase()){
            setMod(n,'grid',g); n.lastGrid=g; }
          n.newFix=true;
        }
        f={lat, lon, acc:null, alt:null, speed:null, heading:null, t:Date.now()};
        n.msg='manual';
      } else n.msg='enter lat/lon or locator';
    }
    let rec=null;
    const vk=[n.p.look,n.p.fov,n.p.fovKm,n.p.rings].join('|');
    if(vk!==n.lastView){ n.lastView=vk; n.newFix=true; }
    if(f){
      GeoMe.lat=f.lat; GeoMe.lon=f.lon; GeoMe.t=Date.now();
      if(n.newFix){
        n.newFix=false;
        rec=[{t:f.t, id:n.p.id||'me', icon:'me', lat:f.lat, lon:f.lon,
              ...(f.acc!=null?{acc:f.acc, radius:f.acc}:{}),
              ...(f.alt!=null?{alt:f.alt}:{}), ...(f.speed!=null?{speed:f.speed}:{}),
              ...(f.heading!=null?{heading:f.heading}:recNum(n.p.look)!=null?{heading:recNum(n.p.look)}:{}),
              ...(n.p.fov>0?{fov:n.p.fov}:{}), ...(recNum(n.p.fovKm)>0?{fov_range:recNum(n.p.fovKm)}:{}),
              ...(String(n.p.rings||'').trim()?{rings:String(n.p.rings).trim()}:{}), grid:latLonToGrid(f.lat,f.lon,6)}];
      }
    }
    return f ? {lat:f.lat, lon:f.lon, acc:f.acc, alt:f.alt, speed:f.speed, heading:f.heading,
                grid:latLonToGrid(f.lat,f.lon,6), rec}
             : {rec};
  },
  draw(n){ const gps=n.p.src==='gps', f=gps ? n.fix : null;
    const lat=gps ? f?.lat ?? null : recNum(n.p.lat), lon=gps ? f?.lon ?? null : recNum(n.p.lon);
    n.el.querySelector('.readout').textContent = n.msg+(lat!=null && lon!=null ?
      '\n'+lat.toFixed(5)+', '+lon.toFixed(5)+(f?' ±'+Math.round(f.acc)+' m':'')+' · '+latLonToGrid(lat,lon,6) : ''); }});
function geoMeLocate(n){
  if(!navigator.geolocation){ n.msg='geolocation not available'; return; }
  n.msg='locating…';
  navigator.geolocation.getCurrentPosition(p=>{
    setMod(n,'src','manual');
    setMod(n,'lat',+p.coords.latitude.toFixed(5)); setMod(n,'lon',+p.coords.longitude.toFixed(5));
    n.msg='manual';
  }, e=>{ n.msg='geolocation: '+e.message; }, {enableHighAccuracy:!!n.p.hi, timeout:30000});
}
function geoMeStart(n){
  n.wOn=true;
  if(!navigator.geolocation){ n.msg='geolocation not available'; return; }
  n.msg='waiting for fix…';
  n.watch=navigator.geolocation.watchPosition(p=>{
    const c=p.coords;
    n.fix={lat:c.latitude, lon:c.longitude, acc:c.accuracy, alt:c.altitude,
           speed:c.speed, heading:(c.heading!=null && isFinite(c.heading)) ? c.heading : null, t:p.timestamp||Date.now()};
    n.newFix=true; n.msg='tracking';
  }, e=>{ n.msg='geolocation: '+e.message; }, {enableHighAccuracy:!!n.p.hi, maximumAge:1000, timeout:30000});
}
function geoMeStop(n){
  n.wOn=false;
  if(n.watch!=null) navigator.geolocation?.clearWatch(n.watch);
  n.watch=null; n.msg='';
}

/* ---------- FT8: разбор сообщения ---------- */
// "CQ [DX|POTA|…] CALL GRID", "CALL1 CALL2 GRID|R-10|-05|RRR|RR73|73"
function ft8MsgInfo(msg){
  const w=String(msg||'').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if(w.length<2) return null;
  const isGrid=x=>/^[A-R]{2}\d\d$/.test(x) && x!=='RR73';
  const call=x=>x.replace(/^<|>$/g,'').replace(/\/[RP]$/,'');
  const o={from:null, to:null, grid:null, cq:false, report:null};
  const last=w[w.length-1];
  if(w[0]==='CQ'){
    o.cq=true;
    if(isGrid(last) && w.length>=3){ o.grid=last; o.from=call(w[w.length-2]); }
    else o.from=call(last);
  } else {
    o.to=call(w[0]); o.from=call(w[1]);
    if(w.length>=3){
      if(isGrid(w[2])) o.grid=w[2];
      else if(/^R?[+-]\d\d$/.test(w[2])) o.report=w[2];
    }
  }
  const isCall=x=>x && /\d/.test(x) && /[A-Z]/.test(x) && !/^TELEM$/.test(x);   // "...", телеметрия, свободный текст
  if(!isCall(o.from)) o.from=null;
  if(!isCall(o.to)) o.to=null;
  if(w[0]==='TELEM') return null;
  return o;
}
// координаты по локатору + расстояние и азимут от своей позиции (узел My Position)
function ft8GeoFill(r,grid){
  const g=gridToLatLon(grid); if(!g) return;
  r.lat=+g.lat.toFixed(4); r.lon=+g.lon.toFixed(4);
  if(GeoMe.lat!=null){
    r.dist_km=Math.round(geoDist(GeoMe.lat,GeoMe.lon,g.lat,g.lon));
    r.az=Math.round(geoBearing(GeoMe.lat,GeoMe.lon,g.lat,g.lon));
    r.lat2=GeoMe.lat; r.lon2=GeoMe.lon;
  }
}

/* ---------- FT8: страна по префиксу, диапазон по частоте ---------- */
// префиксы ITU/DXCC (укрупнённо): "A-B" — диапазон второго символа, побеждает самый длинный префикс
const FT8_DXCC=(()=>{
  const src=`A2:Botswana;A3:Tonga;A4:Oman;A5:Bhutan;A6:UAE;A7:Qatar;A9:Bahrain;AP-AS:Pakistan;AA-AL:USA;K:USA;N:USA;W:USA;KH6:Hawaii;KL:Alaska;KP4:Puerto Rico;KP2:US Virgin Is.;KG4:Guantanamo
B:China;BV:Taiwan;C2:Nauru;C3:Andorra;C5:Gambia;C6:Bahamas;C8-C9:Mozambique;CA-CE:Chile;CM-CO:Cuba;CN:Morocco;CP:Bolivia;CQ-CT:Portugal;CT3:Madeira;CU:Azores;CX:Uruguay
D2-D3:Angola;D4:Cape Verde;D6:Comoros;DA-DR:Germany;DU-DZ:Philippines;E3:Eritrea;E4:Palestine;E5:S Cook Is.;E6:Niue;E7:Bosnia;EA-EH:Spain;EA6:Balearic Is.;EA8:Canary Is.;EA9:Ceuta & Melilla;EI-EJ:Ireland;EK:Armenia;EL:Liberia;EP-EQ:Iran;ER:Moldova;ES:Estonia;ET:Ethiopia;EU-EW:Belarus;EX:Kyrgyzstan;EY:Tajikistan;EZ:Turkmenistan
F:France;TK:Corsica;G:England;M:England;2:England;GM:Scotland;MM:Scotland;2M:Scotland;GW:Wales;MW:Wales;2W:Wales;GI:N. Ireland;MI:N. Ireland;2I:N. Ireland;GJ:Jersey;MJ:Jersey;GU:Guernsey;MU:Guernsey;GD:Isle of Man;MD:Isle of Man
H2:Cyprus;5B:Cyprus;P3:Cyprus;H4:Solomon Is.;HA:Hungary;HG:Hungary;HB:Switzerland;HB0:Liechtenstein;HC-HD:Ecuador;HH:Haiti;HI:Dominican Rep.;HJ-HK:Colombia;HL:South Korea;HO-HP:Panama;HQ-HR:Honduras;HS:Thailand;HV:Vatican;HZ:Saudi Arabia;7Z:Saudi Arabia;8Z:Saudi Arabia
I:Italy;IS0:Sardinia;IM0:Sardinia;IT9:Sicily;IB9:Sicily;IE9:Sicily;IF9:Sicily;IG9:Sicily
J2:Djibouti;J3:Grenada;J5:Guinea-Bissau;J6:St Lucia;J7:Dominica;J8:St Vincent;JA-JS:Japan;7J-7N:Japan;8J-8N:Japan;JT-JV:Mongolia;JW:Svalbard;JX:Jan Mayen;JY:Jordan
LA-LN:Norway;LO-LW:Argentina;LX:Luxembourg;LY:Lithuania;LZ:Bulgaria
OA-OC:Peru;OD:Lebanon;OE:Austria;OF-OI:Finland;OH0:Aland Is.;OJ0:Market Reef;OK-OL:Czech Rep.;OM:Slovakia;ON-OT:Belgium;OU-OZ:Denmark;OX:Greenland;OY:Faroe Is.
P2:Papua New Guinea;P4:Aruba;P5:North Korea;PA-PI:Netherlands;PJ:Curacao;PP-PY:Brazil;PZ:Suriname
R:European Russia;U:European Russia;RA2:Kaliningrad;RK2:Kaliningrad;RA0:Asiatic Russia;RA8:Asiatic Russia;RA9:Asiatic Russia;UA0:Asiatic Russia;UA8:Asiatic Russia;UA9:Asiatic Russia;RK0:Asiatic Russia;RK9:Asiatic Russia;RW0:Asiatic Russia;RW9:Asiatic Russia;RU0:Asiatic Russia;RU9:Asiatic Russia;RV0:Asiatic Russia;RV9:Asiatic Russia;RZ0:Asiatic Russia;RZ9:Asiatic Russia;RX0:Asiatic Russia;RX9:Asiatic Russia;RN0:Asiatic Russia;RN9:Asiatic Russia;RM0:Asiatic Russia;RM9:Asiatic Russia;RL0:Asiatic Russia;RL9:Asiatic Russia;RJ0:Asiatic Russia;RJ9:Asiatic Russia;RG0:Asiatic Russia;RG9:Asiatic Russia;RF0:Asiatic Russia;RF9:Asiatic Russia;RD0:Asiatic Russia;RD9:Asiatic Russia;RC0:Asiatic Russia;RC9:Asiatic Russia;RB0:Asiatic Russia;RB9:Asiatic Russia;R8:Asiatic Russia;R9:Asiatic Russia;R0:Asiatic Russia;U8:Asiatic Russia;U9:Asiatic Russia;U0:Asiatic Russia;UA2:Kaliningrad;R2:Kaliningrad;U2:Kaliningrad
S0:W Sahara;S2:Bangladesh;S5:Slovenia;S7:Seychelles;S9:Sao Tome;SA-SM:Sweden;7S:Sweden;8S:Sweden;SN-SR:Poland;HF:Poland;SO:Poland;3Z:Poland;SS-SU:Egypt;SV-SZ:Greece;J4:Greece;SV5:Dodecanese;SV9:Crete
T2:Tuvalu;T3:Kiribati;T5:Somalia;T7:San Marino;T8:Palau;T9:Bosnia;TA-TC:Turkey;YM:Turkey;TF:Iceland;TG:Guatemala;TI:Costa Rica;TJ:Cameroon;TL:Central Africa;TN:Congo;TR:Gabon;TT:Chad;TU:Cote d'Ivoire;TY:Benin;TZ:Mali
UJ-UM:Uzbekistan;UN-UQ:Kazakhstan;UR-UZ:Ukraine;EM-EO:Ukraine
V2:Antigua;V3:Belize;V4:St Kitts;V5:Namibia;V6:Micronesia;V7:Marshall Is.;V8:Brunei;VA-VG:Canada;VO:Canada;VX-VY:Canada;CF-CK:Canada;CY-CZ:Canada;XJ-XO:Canada;VH-VN:Australia;AX:Australia;VP:Falkland Is.;VQ:Diego Garcia;VR:Hong Kong;VU:India;AT-AW:India;8T-8Y:India
XA-XI:Mexico;4A-4C:Mexico;6D-6J:Mexico;XT:Burkina Faso;XU:Cambodia;XV:Vietnam;3W:Vietnam;XW:Laos;XX:Macao;XY-XZ:Myanmar
YA:Afghanistan;YB-YH:Indonesia;7A-7I:Indonesia;8A-8I:Indonesia;JZ:Indonesia;PK-PO:Indonesia;YI:Iraq;YJ:Vanuatu;YK:Syria;YL:Latvia;YN:Nicaragua;YO-YR:Romania;YS:El Salvador;YT-YU:Serbia;YZ:Serbia;YV-YY:Venezuela;4M:Venezuela
Z2:Zimbabwe;Z3:N. Macedonia;ZA:Albania;ZB:Gibraltar;ZG:Gibraltar;ZC4:UK Bases Cyprus;ZF:Cayman Is.;ZK-ZM:New Zealand;ZP:Paraguay;ZR-ZU:South Africa
3A:Monaco;3B:Mauritius;3C:Eq. Guinea;3D2:Fiji;3DA:Eswatini;3V:Tunisia;TS:Tunisia;3X:Guinea
4J-4K:Azerbaijan;4L:Georgia;4O:Montenegro;4S:Sri Lanka;4U:United Nations;4X:Israel;4Z:Israel;4W:Timor-Leste
5A:Libya;5H-5I:Tanzania;5N-5O:Nigeria;5R-5S:Madagascar;5T:Mauritania;5U:Niger;5V:Togo;5W:Samoa;5X:Uganda;5Y-5Z:Kenya;6V-6W:Senegal;6Y:Jamaica;6O:Somalia
7O:Yemen;7P:Lesotho;7Q:Malawi;7X:Algeria;7T-7Y:Algeria;8P:Barbados;8Q:Maldives;8R:Guyana
9A:Croatia;9G:Ghana;9H:Malta;9J:Zambia;9K:Kuwait;9L:Sierra Leone;9M:Malaysia;9W:Malaysia;9N:Nepal;9O-9T:DR Congo;9U:Burundi;9V:Singapore;9X:Rwanda;9Y-9Z:Trinidad & Tobago;
D5:Liberia;A8:Liberia;C4:Cyprus;C7:WMO;E2:Thailand;E8:Eritrea;H3:Panama;H8-H9:Panama;3E-3F:Panama;HM:North Korea;P6-P9:North Korea;HU:El Salvador;OB:Peru;4D-4I:Philippines;SB-SH:Sweden;9B-9D:Iran;EH:Spain;AM-AO:Spain;PQ:Brazil;ZV-ZZ:Brazil;JD:Japan;XP:Greenland;5C:Morocco;5D:Morocco;TV-TX:France;HW-HY:France`;
  const m=new Map(), up=(a,b)=>{ const o=[]; for(let c=a.charCodeAt(0);c<=b.charCodeAt(0);c++) o.push(String.fromCharCode(c)); return o; };
  for(const part of src.split(/[;\n]/)){
    const i=part.indexOf(':'); if(i<1) continue;
    const name=part.slice(i+1).trim(), key=part.slice(0,i).trim(), r=key.match(/^(.+)-(.+)$/);
    if(r){ const pre=r[1].slice(0,-1); for(const ch of up(r[1].slice(-1),r[2].slice(-1))) m.set(pre+ch,name); } else m.set(key,name);
  }
  return m;
})();
function ft8Country(call){
  const c=String(call||'').toUpperCase().replace(/[<>]/g,'');
  let base=c;
  if(c.includes('/')){                               // PREFIX/CALL или CALL/SUFFIX: префиксом считаем более короткую часть
    const a=c.split('/'); const w=a.filter(x=>x.length>1 && !/^(P|M|MM|AM|QRP|R|\d)$/.test(x));
    if(w.length>1) base=w.reduce((x,y)=>y.length<x.length&&/\d/.test(y)?y:x); else if(w.length) base=w[0]; }
  for(let l=Math.min(4,base.length);l>=1;l--){
    const v=FT8_DXCC.get(base.slice(0,l)); if(v) return v; }
  return '';
}
// диапазон по частоте приёмника, Гц
function ft8Band(hz){
  const k=hz/1000;
  const B=[[1800,2000,'160m'],[3500,4000,'80m'],[5250,5450,'60m'],[7000,7300,'40m'],[10100,10150,'30m'],[14000,14350,'20m'],
           [18068,18168,'17m'],[21000,21450,'15m'],[24890,24990,'12m'],[28000,29700,'10m'],[50000,54000,'6m'],[144000,148000,'2m']];
  for(const b of B) if(k>=b[0]&&k<=b[1]) return b[2];
  return '';
}

/* ---------- координаты из текста ---------- */
// ищет в строке координаты разных видов; возвращает [{lat,lon,kind,match}]
function geoTextFind(text,opt={}){
  const T=String(text||''), U=T.toUpperCase(), out=[], used=[];
  const free=(a,b)=>!used.some(([x,y])=>a<y && b>x);
  const hem=(v,h)=>(h==='S'||h==='W') ? -v : v;
  const ok=(lat,lon)=>isFinite(lat) && isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180 && !(lat===0 && lon===0);
  const take=(re,kind,conv)=>{
    re.lastIndex=0; let m;
    while((m=re.exec(U))){
      const a=m.index, b=a+m[0].length;
      if(!free(a,b)) continue;
      const p=conv(m); if(!p || !ok(p[0],p[1])) continue;
      used.push([a,b]); out.push({lat:+p[0].toFixed(6), lon:+p[1].toFixed(6), kind, match:T.slice(a,b), at:a});
    }
  };
  const dm=(d,m)=>+d+(+m)/60;
  // градусы-минуты-секунды: 55°45'21"N 37°37'04"E
  take(/(\d{1,2})\s*[°º]\s*(\d{1,2}(?:\.\d+)?)\s*['′]\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″]|''))?\s*([NS])[\s,;\/]*(\d{1,3})\s*[°º]\s*(\d{1,2}(?:\.\d+)?)\s*['′]\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″]|''))?\s*([EW])/g,'dms',
    m=>[hem(dm(m[1],m[2])+(+(m[3]||0))/3600,m[4]), hem(dm(m[5],m[6])+(+(m[7]||0))/3600,m[8])]);
  // градусы и минуты: NMEA "5545.350,N,03737.070,E", APRS "4903.50N/07201.75W"
  take(/(\d{2})(\d{2}\.\d+)\s*,?\s*([NS])\s*[,\/\\ ]?\s*(\d{3})(\d{2}\.\d+)\s*,?\s*([EW])/g,'ddmm',
    m=>[hem(dm(m[1],m[2]),m[3]), hem(dm(m[4],m[5]),m[6])]);
  // полушарие впереди, десятичные градусы: N55.7558 E037.6173
  take(/\b([NS])\s?(\d{1,2}\.\d+)[°º]?\s*[,;\/ ]?\s*([EW])\s?(\d{1,3}\.\d+)[°º]?/g,'hemi',
    m=>[hem(+m[2],m[1]), hem(+m[4],m[3])]);
  // ACARS: N55123E037456 — градусы, минуты и десятые (сотые) минуты
  take(/\b([NS])\s?(\d{2})(\d{2})(\d{1,2})\s*,?\s*([EW])\s?(\d{3})(\d{2})(\d{1,2})\b/g,'acars',
    m=>[hem(dm(m[2],m[3]+'.'+m[4]),m[1]), hem(dm(m[6],m[7]+'.'+m[8]),m[5])]);
  // десятичные градусы с полушарием после: 55.7558N 37.6173E
  take(/(\d{1,2}\.\d+)\s*[°º]?\s*([NS])[\s,;\/]*(\d{1,3}\.\d+)\s*[°º]?\s*([EW])/g,'dec',
    m=>[hem(+m[1],m[2]), hem(+m[3],m[4])]);
  // просто пара чисел: 55.7558, 37.6173 (не меньше трёх знаков после точки — меньше ложных)
  take(/(^|[^\d.])(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})(?![\d.])/g,'pair',
    m=>[+m[2], +m[3]]);
  // локаторы Maidenhead: 6 знаков всегда, 4 — по опции
  const gre=opt.loc4 ? /\b([A-R]{2}\d{2}(?:[A-X]{2})?)\b/g : /\b([A-R]{2}\d{2}[A-X]{2})\b/g;
  take(gre,'grid',m=>{ if(m[1]==='RR73') return null; const g=gridToLatLon(m[1]); return g ? [g.lat,g.lon] : null; });
  return out.sort((a,b)=>a.at-b.at);
}

def({ id:'geoText', title:'Geo from Text', cat:'Geo',
  // Координаты из любого текста: декодированные сообщения, NMEA, APRS, ACARS, заметки.
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'all',t:'check',d:true,label:'all matches (else first)'},
          {n:'loc4',t:'check',d:false,label:'4-char locators (more false hits)'},
          {n:'id',t:'text',d:'',label:'record id (empty — none)'}],
  init:n=>{ n.last=null; n.count=0; n.lat=null; n.lon=null; n.shown=''; },
  process(n,I){
    let rec=null;
    if(typeof I.text==='string' && I.text!==n.last){
      n.last=I.text;
      let found=geoTextFind(I.text,{loc4:n.p.loc4});
      if(!n.p.all) found=found.slice(0,1);
      if(found.length){
        const t=Date.now();
        rec=found.map(f=>({t, lat:f.lat, lon:f.lon, kind:f.kind, match:f.match,
          text:I.text.length>300 ? I.text.slice(0,300)+'…' : I.text, ...(n.p.id?{id:n.p.id}:{})}));
        const l=found[found.length-1]; n.lat=l.lat; n.lon=l.lon; n.count+=found.length;
        n.shown=found.map(f=>f.kind+': '+f.match+' → '+f.lat+', '+f.lon).join('\n');
      }
    }
    return {rec, lat:n.lat, lon:n.lon, count:n.count};
  },
  draw(n){ n.el.querySelector('.readout').textContent='found '+n.count+(n.shown?'\n'+n.shown:''); }});

def({ id:'geoMark', title:'Mark Point', cat:'Geo',
  // Снимок «где я и что принимаю»: позиция (входы lat/lon/alt или My Position) + значения на входах.
  // По кнопке, по фронту go или автоматически раз в N секунд — для замеров на местности. К замеру можно добавить фото (📷).
  // Поля записи понимает остальное: lat, lon, alt, h (высота антенны над землёй — для 3D), rssi / snr, azimuth, freq, tx (источник —
  // группировка в Source Locator), session (field — в движении, quiet — спокойное место для пеленгации), rx_ant, rx_gain, note, photo.
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'rssi',t:'num'},{n:'snr',t:'num'},
       {n:'azimuth',t:'num'},{n:'elevation',t:'num'},{n:'freq',t:'num'},{n:'go',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'mark',t:'button',label:'● Mark',fn:n=>{ n.req=true; }},
          {n:'markp',t:'button',label:'📷 Mark + photo',fn:n=>geoMarkPhoto(n)},
          {n:'auto',t:'range',min:0,max:120,step:1,d:0,label:'auto every, s (0 — off)'},
          {n:'session',t:'select',opts:['field','quiet'],d:'field',label:'session: field (moving about) or quiet (a calm place, a long listen for locating)'},
          {n:'tx',t:'text',d:'',label:'source being measured (field «tx»: Source Locator groups by it)'},
          {n:'prefix',t:'text',d:'P',label:'name prefix: P1, P2…'},
          {n:'rx_ant',t:'text',d:'',label:'receiving antenna (model, polarisation)'},
          {n:'rx_gain',t:'num',d:0,label:'antenna gain, dBi'},
          {n:'rx_h',t:'num',d:1.5,label:'antenna height above ground, m'},
          {n:'icon',t:'select',opts:['dot','square','triangle','diamond','star','flag','cross','antenna','rx'],d:'dot'},
          {n:'note',t:'text',d:'',label:'note'}],
  init:n=>{ n.req=false; n.prevGo=0; n.count=0; n.lastT=0; n.lastRec=null; n.msg=''; n.snap={}; n.emit=null; },
  process(n,I){
    const go=typeof I.go==='number' ? I.go : 0, edge=go>0.5 && n.prevGo<=0.5; n.prevGo=go;
    n.snap={lat:I.lat,lon:I.lon,alt:I.alt,rssi:I.rssi,snr:I.snr,azimuth:I.azimuth,elevation:I.elevation,freq:I.freq};
    const now=Date.now();
    let fire=n.req || edge || (n.p.auto>0 && now-n.lastT>=n.p.auto*1000);
    n.req=false;
    if(fire){ n.lastT=now; const r=geoMarkRec(n,n.snap,''); if(r) n.emit=[r]; }
    const rec=n.emit; n.emit=null;
    return {rec, count:n.count};
  },
  draw(n){ n.el.querySelector('.readout').textContent=(n.msg?n.msg+'\n':'')+'marks '+n.count+
    (n.lastRec ? '\n'+recText(n.lastRec,new Set(['icon','label'])) : ''); }});
function geoMarkRec(n,I,photo){
  const p=n.p, now=Date.now(), lat=recNum(I.lat) ?? GeoMe.lat, lon=recNum(I.lon) ?? GeoMe.lon;
  if(lat==null || lon==null){ n.msg='no position: wire lat/lon or add My Position'; return null; }
  const r={t:now, lat:+lat.toFixed(6), lon:+lon.toFixed(6), icon:p.icon, n:++n.count};
  if(p.prefix) r.name=p.prefix+r.n;
  const alt=recNum(I.alt); if(alt!=null) r.alt=+alt.toFixed(1);
  r.h=+p.rx_h||0; r.session=p.session;
  for(const k of ['rssi','snr','azimuth','elevation','freq']){ const v=recNum(I[k]); if(v!=null) r[k]=+v.toFixed(2); }
  if(p.tx) r.tx=p.tx; if(p.rx_ant) r.rx_ant=p.rx_ant; if(+p.rx_gain) r.rx_gain=+p.rx_gain; if(p.note) r.note=p.note; if(photo) r.photo=photo;
  r.label=r.rssi!=null ? r.rssi+' dBm' : r.snr!=null ? r.snr+' dB' : '#'+r.n;
  n.lastRec=r; n.msg='';
  return r;
}
// фото берётся сразу — в обработчике нажатия (иначе телефон не откроет камеру); показания — те, что были в момент нажатия
async function geoMarkPhoto(n){
  const snap={...n.snap}, got=await phPickAdd();
  if(!got.length) return;
  const x=got.find(g=>g.exif?.lat!=null)?.exif;
  if(x && recNum(snap.lat)==null && GeoMe.lat==null){ snap.lat=x.lat; snap.lon=x.lon; if(x.alt!=null && recNum(snap.alt)==null) snap.alt=x.alt; }     // GPS нет — место из снимка
  const r=geoMarkRec(n,snap,phJoin(got.map(g=>g.id)));
  if(r) n.emit=[r];
}

/* ---------- поиск источника: уровень сигнала и пеленги ---------- */
// Замеры — записи с координатами и уровнем (rssi/snr/level) и/или азимутом (azimuth).
// Уровень: модель log-distance s = A − 10·n·lg(d), мощность A неизвестна и исключается
// (для каждой точки-кандидата берётся лучшая A). Пеленги: невязка угла. Сумма квадратов
// невязок ищется перебором по сетке (грубо, затем уточнение), вероятность ∝ exp(−cost/2).
// Локальная плоская проекция: годится до сотен км. На КВ уровень почти не зависит от
// расстояния (отражения от ионосферы) — там полезны только пеленги.
function geoLocLocal(lat0,lon0){
  const kx=111.32*Math.cos(lat0*D2R), ky=110.574;
  return {fwd:(lat,lon)=>({x:(((lon-lon0+540)%360)-180)*kx, y:(lat-lat0)*ky}),
          inv:(x,y)=>({lat:lat0+y/ky, lon:((lon0+x/kx+540)%360)-180})};
}
function geoLocCost(M,x,y,o){
  let cs=0, ns=0, sumA=0;
  const L=[];
  if(o.useS){
    for(const m of M){ if(m.s==null) continue;
      const d=Math.max(Math.hypot(x-m.x,y-m.y),o.dmin), l=10*o.pn*Math.log10(d);
      L.push(l); sumA+=m.s+l; ns++; }
    if(ns>=3){
      const A=sumA/ns; let k=0;
      for(const m of M){ if(m.s==null) continue; const r=m.s-A+L[k++]; cs+=r*r; }
      cs/=o.sdb*o.sdb;
    } else cs=0;
  }
  let cb=0;
  if(o.useB) for(const m of M){ if(m.az==null) continue;
    const b=Math.atan2(x-m.x,y-m.y)/D2R;
    let da=((b-m.az)%360+540)%360-180;
    cb+=da*da/(o.saz*o.saz); }
  return cs+cb;
}
function geoLocSolve(g,p){
  const M=g.meas;
  const nS=M.filter(m=>m.s!=null).length, nB=M.filter(m=>m.az!=null).length;
  const meth=p.method;
  const useS=(meth!=='bearing') && nS>=3, useB=(meth!=='strength') && nB>=1;
  g.sol=null;
  if(!useS && !(useB && nB>=2)){ g.msg='need ≥3 level or ≥2 bearing measurements'; return; }
  const lat0=M.reduce((a,m)=>a+m.lat,0)/M.length, lon0=M[0].lon;
  const P=geoLocLocal(lat0,lon0);
  for(const m of M){ const q=P.fwd(m.lat,m.lon); m.x=q.x; m.y=q.y; }
  const o={useS, useB, pn:p.pathN, sdb:p.sigmaDb, saz:p.sigmaAz, dmin:0.005};
  // область поиска: вокруг замеров; с пеленгами — ещё и вокруг пересечения лучей (МНК)
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for(const m of M){ x0=Math.min(x0,m.x); x1=Math.max(x1,m.x); y0=Math.min(y0,m.y); y1=Math.max(y1,m.y); }
  const spread=Math.hypot(x1-x0,y1-y0)*1000;          // м — по уровню с одного места источник не найти
  if(useS && !useB && spread<(p.minSpread||0)){ g.msg='move around: measurements spread '+Math.round(spread)+' m'; return; }
  if(useB){
    let a11=0,a12=0,a22=0,b1=0,b2=0;
    for(const m of M){ if(m.az==null) continue;
      const dx=Math.sin(m.az*D2R), dy=Math.cos(m.az*D2R);
      const p11=1-dx*dx, p12=-dx*dy, p22=1-dy*dy;
      a11+=p11; a12+=p12; a22+=p22; b1+=p11*m.x+p12*m.y; b2+=p12*m.x+p22*m.y; }
    const det=a11*a22-a12*a12;
    if(Math.abs(det)>1e-9){
      const ix=(a22*b1-a12*b2)/det, iy=(a11*b2-a12*b1)/det;
      if(isFinite(ix) && Math.hypot(ix-(x0+x1)/2,iy-(y0+y1)/2)<5000){
        x0=Math.min(x0,ix); x1=Math.max(x1,ix); y0=Math.min(y0,iy); y1=Math.max(y1,iy); }
    }
  }
  const cx=(x0+x1)/2, cy=(y0+y1)/2;
  let half=p.area>0 ? p.area/2 : Math.max(0.3,Math.max(x1-x0,y1-y0)*(useS&&!useB?1.0:0.8));
  const G=g.G=96;
  const grid=(ccx,ccy,h)=>{
    const c=new Float64Array(G*G); let best=Infinity, bi=0;
    for(let j=0;j<G;j++) for(let i=0;i<G;i++){
      const x=ccx-h+(i+0.5)*2*h/G, y=ccy+h-(j+0.5)*2*h/G;
      const v=geoLocCost(M,x,y,o); c[j*G+i]=v;
      if(v<best){ best=v; bi=j*G+i; } }
    return {c,best,bi,ccx,ccy,h};
  };
  const map=grid(cx,cy,half);                         // крупная сетка — для картинки вероятности
  const fine=grid(map.ccx-map.h+((map.bi%G)+0.5)*2*map.h/G, map.ccy+map.h-(Math.floor(map.bi/G)+0.5)*2*map.h/G, map.h/8);
  const bx=fine.ccx-fine.h+((fine.bi%G)+0.5)*2*fine.h/G, by=fine.ccy+fine.h-(Math.floor(fine.bi/G)+0.5)*2*fine.h/G;
  // разброс по апостериорной вероятности на крупной сетке
  let W=0,mx=0,my=0,vx=0,vy=0;
  const pr=new Float64Array(G*G);
  for(let k=0;k<G*G;k++){ const w=Math.exp(-(map.c[k]-map.best)/2); pr[k]=w; W+=w; }
  for(let k=0;k<G*G;k++){ const x=map.ccx-map.h+((k%G)+0.5)*2*map.h/G, y=map.ccy+map.h-(Math.floor(k/G)+0.5)*2*map.h/G;
    mx+=pr[k]*x; my+=pr[k]*y; }
  mx/=W; my/=W;
  for(let k=0;k<G*G;k++){ const x=map.ccx-map.h+((k%G)+0.5)*2*map.h/G, y=map.ccy+map.h-(Math.floor(k/G)+0.5)*2*map.h/G;
    vx+=pr[k]*(x-mx)**2; vy+=pr[k]*(y-my)**2; }
  const errKm=Math.max(Math.sqrt((vx+vy)/W), 2*fine.h/G);
  // мощность в 1 км при найденной точке (для справки)
  let A=null;
  if(useS){ let s=0,k=0; for(const m of M){ if(m.s==null) continue; s+=m.s+10*o.pn*Math.log10(Math.max(Math.hypot(bx-m.x,by-m.y),o.dmin)); k++; } A=s/k; }
  const ll=P.inv(bx,by);
  g.sol={lat:ll.lat, lon:ll.lon, x:bx, y:by, errKm, A, pr, map, P, useS, useB, cost:fine.best};
  g.msg=(useS?'level ':'')+(useB?'bearings ':'')+'· '+M.length+' meas.';
}
// Группировка (group by, например bssid): у каждого значения — свои замеры и своя оценка,
// так по одному обходу находятся сразу все точки доступа. Пересчёт — порциями по несколько групп.
function geoLocGroup(n,key){
  let g=n.groups.get(key);
  if(!g){
    g={key, label:'', meas:[], sol:null, msg:'waiting for measurements', dirty:false, t:0};
    n.groups.set(key,g);
    if(n.groups.size>500){ const k0=n.groups.keys().next().value; if(k0!==key) n.groups.delete(k0); }
  }
  return g;
}
function geoLocShown(n){
  const want=n.showKey!=null ? n.groups.get(n.showKey) : null;
  if(want) return want;
  let best=null; for(const g of n.groups.values()) if(g.sol && (!best || g.t>best.t)) best=g;
  return best || n.groups.values().next().value || null;
}
function geoLocFmtErr(km){ return km>=1 ? km.toFixed(1)+' km' : Math.round(km*1000)+' m'; }
def({ id:'geoLocate', lazy:'manual', title:'Source Locator', cat:'Geo',
  ins:[{n:'rec',t:'rec'},{n:'select',t:'rec'}],        // select — клик на карте: показать эту группу
  outs:[{n:'rec',t:'rec'},{n:'rays',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'err',t:'num'},{n:'count',t:'num'}],
  view:{h:260}, resize:true, readout:true,
  params:[{n:'field',t:'select',opts:['rssi','snr','level'],d:'rssi',label:'level field'},
          {n:'method',t:'select',opts:['auto','strength','bearing'],d:'auto',label:'use'},
          {n:'group',t:'text',d:'',label:'group by field (bssid…) — one source per value'},
          {n:'labelField',t:'text',d:'',label:'label field (ssid…)'},
          {n:'pathN',t:'range',min:1.5,max:5,step:0.1,d:2.5,label:'path loss exponent n'},
          {n:'sigmaDb',t:'range',min:1,max:20,step:0.5,d:6,label:'level error, dB'},
          {n:'sigmaAz',t:'range',min:1,max:45,step:1,d:10,label:'bearing error, °'},
          {n:'minSpread',t:'range',min:0,max:500,step:1,d:0,label:'min spread of level marks, m',adv:true},
          {n:'area',t:'range',min:0,max:1000,step:0.1,d:0,label:'search area, km (0 — auto)',adv:true},
          {n:'max',t:'range',min:3,max:1000,step:1,d:200,label:'keep measurements (per source)',adv:true},
          {n:'h0',t:'range',min:0,max:300,step:1,d:10,label:'assumed source height above ground, m (without elevation angles)'},
          {n:'sigEl',t:'range',min:.5,max:20,step:.5,d:2,label:'elevation error, °',adv:true},
          {n:'rays',t:'check',d:true,label:'rays: links from the marks to the estimate (Map, 3D)'},
          {n:'save',t:'text',d:'analysis/sources',label:'Table list for the estimates',adv:true},
          {n:'tosave',t:'button',label:'Save estimates to table',fn:n=>geoLocSave(n)},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.groups.clear(); n.showKey=null; }}],
  init:n=>{ n.groups=new Map(); n.showKey=null; n.lastSolve=0; n.pkey=''; n.total=0; },
  process(n,I){
    const gf=String(n.p.group||'').trim(), lf=String(n.p.labelField||'').trim();
    for(const r of recList(I.select)){
      const id=String(r.id||''); if(id.startsWith('loc:')) n.showKey=id.slice(4);
    }
    for(const r of recList(I.rec)){
      const pos=geoRecPos(r); if(!pos) continue;
      const sv=recNum(r[n.p.field]), az=recNum(r.azimuth ?? r.bearing), el=recNum(r.elevation);
      if(sv==null && az==null) continue;
      let key='';
      if(gf){ const v=r[gf]; if(v==null || v==='') continue; key=String(v); }
      const g=geoLocGroup(n,key);
      if(lf && r[lf]!=null && r[lf]!=='') g.label=String(r[lf]);
      const last=g.meas[g.meas.length-1];
      if(last && last.lat===pos.lat && last.lon===pos.lon && last.s===sv && last.az===az) continue;   // повтор того же скана
      const hz=typeof Horizon!=='undefined' && Horizon.hAt ? Horizon.hAt(pos.lat,pos.lon) : null, m3={lat:pos.lat, lon:pos.lon, s:sv, az:az!=null ? ((az%360)+360)%360 : null, el, alt:recNum(r.alt), h:recNum(r.h)};
      m3.alt3=l3MeasAlt(m3,hz); g.meas.push(m3);
      if(g.meas.length>n.p.max) g.meas.splice(0,g.meas.length-n.p.max);
      g.dirty=true; g.t=Date.now(); n.total++;
    }
    const pkey=[n.p.method,n.p.pathN,n.p.sigmaDb,n.p.sigmaAz,n.p.area,n.p.minSpread].join();
    if(pkey!==n.pkey){ n.pkey=pkey; for(const g of n.groups.values()) g.dirty=true; }
    let rec=null, rays=null;
    const now=Date.now();
    if(now-n.lastSolve>200){
      n.lastSolve=now;
      const todo=[...n.groups.values()].filter(g=>g.dirty).slice(0,4);
      if(todo.length) n.solveGen=(n.solveGen|0)+1;
      for(const g of todo){
        g.dirty=false;
        geoLocSolve(g,n.p);
        const S=g.sol; if(!S) continue;
        geoLoc3d(g,n.p);
        const e=geoLocFmtErr(S.errKm);
        const name=gf ? (g.label||g.key) : 'source';
        (rec||(rec=[])).push({t:now, id:gf ? 'loc:'+g.key : 'estimate', label:name+' ±'+e,
          icon:gf ? 'antenna' : 'star', color:gf ? geoEntColor({}, {id:g.key}) : '#ffd84a', size:gf ? 7 : 8,
          lat:+S.lat.toFixed(6), lon:+S.lon.toFixed(6), radius:Math.round(S.errKm*1000),
          meas:g.meas.length, ...(gf?{[gf]:g.key, track:0}:{}), ...(lf&&g.label?{[lf]:g.label}:{}),
          ...(S.A!=null?{A_1km:+S.A.toFixed(1)}:{}), grid:latLonToGrid(S.lat,S.lon,6),
          ...(S.h3 ? {alt:+S.h3.alt.toFixed(1), ...(S.h3.h!=null?{h:+S.h3.h.toFixed(1)}:{}), alt_err:Math.round(S.h3.sd), height_src:S.h3.how} : {})});
        if(n.p.rays){
          const R=l3Rays(g.meas,{lat:S.lat,lon:S.lon,alt:S.h3 ? S.h3.alt : 0},'ray:'+(gf ? g.key : 'estimate'),{color:gf ? geoEntColor({}, {id:g.key}) : '#6fd0ff'});
          (rays||(rays=[])).push(...R.rays);
          for(let i=R.n;i<(g.rayN||0);i++) rays.push({id:'ray:'+(gf ? g.key : 'estimate')+':'+i,gone:true});
          g.rayN=R.n;
        }
      }
    }
    const g=geoLocShown(n), S=g?.sol;
    redrawIf(n,n.total+'|'+n.groups.size+'|'+n.showKey+'|'+n.solveGen);
    return {rec, rays, lat:S?S.lat:null, lon:S?S.lon:null, alt:S?.h3 ? S.h3.alt : null, err:S?S.errKm*1000:null, count:n.total};
  },
  draw(n,cv,cx){
    const g=geoLocShown(n);
    geoLocDraw(g,cv,cx);
    const S=g?.sol, gf=String(n.p.group||'').trim();
    let solved=0; for(const q of n.groups.values()) if(q.sol) solved++;
    n.el.querySelector('.readout').textContent=
      (gf ? 'sources '+n.groups.size+' · located '+solved+(g?'\n▶ '+(g.label||g.key)+(g.label?' ('+g.key+')':''):'')+'\n' : '')+
      (g ? g.msg : 'waiting for measurements')+
      (S ? '\n'+S.lat.toFixed(5)+', '+S.lon.toFixed(5)+' ±'+geoLocFmtErr(S.errKm)+(S.A!=null?' · A(1 km) '+S.A.toFixed(1):'')+
        (S.h3 ? '\nalt '+Math.round(S.h3.alt)+' m'+(S.h3.h!=null?' ('+Math.round(S.h3.h)+' m above ground)':'')+' ±'+Math.round(S.h3.sd)+' · '+(S.h3.how==='elevation' ? 'from '+S.h3.n+' elevation angle(s)' : 'assumed height') : '') : ''); }});
// высота найденного источника: по углам места или земля у точки + предполагаемая высота (Horizon нужен для земли)
function geoLoc3d(g,p){
  const S=g.sol, P=S.P, ground=typeof Horizon!=='undefined' && Horizon.hAt ? Horizon.hAt(S.lat,S.lon) : null;
  const M=g.meas.map(m=>({x:m.x,y:m.y,z:m.alt3,el:m.el}));
  S.h3=l3Source(M,{x:S.x,y:S.y},ground,{h0:+p.h0,sigEl:+p.sigEl});
}
// оценки в Table: lat lon alt h с погрешностями — для 3D и последующей работы
async function geoLocSave(n){
  const rows=[];
  for(const g of n.groups.values()){
    const S=g.sol; if(!S) continue;
    rows.push({name:g.label||g.key||'source',t:new Date(g.t||Date.now()).toISOString(),lat:+S.lat.toFixed(6),lon:+S.lon.toFixed(6),alt:S.h3?+S.h3.alt.toFixed(1):'',h:S.h3&&S.h3.h!=null?+S.h3.h.toFixed(1):'',
      err_m:Math.round(S.errKm*1000),alt_err_m:S.h3?Math.round(S.h3.sd):'',height_src:S.h3?S.h3.how:'',meas:g.meas.length,grid:latLonToGrid(S.lat,S.lon,6)});
  }
  if(!rows.length){ return; }
  await tblPut(n.p.save||'analysis/sources',Object.keys(rows[0]),rows);
}
function geoLocDraw(n,cv,cx){                          // n — группа замеров
  const W=cv.width, H=cv.height, S=n?.sol;
  cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
  if(!S){ cx.fillStyle='#62737b'; cx.font='11px monospace'; cx.fillText(n?.msg||'waiting for measurements',8,16); return; }
  const G=n.G, m=S.map, sz=Math.min(W,H)-8, ox=(W-sz)/2, oy=(H-sz)/2;
  if(!n._img || n._imgSol!==S){
    n._imgSol=S;
    const c=n._img || (n._img=document.createElement('canvas')); c.width=G; c.height=G;
    const ic=c.getContext('2d'), id=ic.createImageData(G,G);
    let mx=0; for(const v of S.pr) if(v>mx) mx=v;
    for(let k=0;k<G*G;k++){
      const t=Math.pow(S.pr[k]/mx,0.35);
      id.data[4*k]=Math.round(255*Math.min(1,t*1.6)); id.data[4*k+1]=Math.round(200*Math.max(0,t-0.4)/0.6);
      id.data[4*k+2]=Math.round(80*(1-t)*t*4); id.data[4*k+3]=Math.round(40+215*t);
    }
    ic.putImageData(id,0,0);
  }
  cx.imageSmoothingEnabled=true; cx.drawImage(n._img,ox,oy,sz,sz);
  const px=x=>ox+(x-(m.ccx-m.h))/(2*m.h)*sz, py=y=>oy+((m.ccy+m.h)-y)/(2*m.h)*sz;
  cx.strokeStyle='rgba(120,200,255,.6)'; cx.lineWidth=1;
  for(const q of n.meas){
    if(q.az==null || q.x==null) continue;
    cx.beginPath(); cx.moveTo(px(q.x),py(q.y));
    cx.lineTo(px(q.x+Math.sin(q.az*D2R)*m.h*4),py(q.y+Math.cos(q.az*D2R)*m.h*4)); cx.stroke();
  }
  let smin=Infinity,smax=-Infinity;
  for(const q of n.meas) if(q.s!=null){ smin=Math.min(smin,q.s); smax=Math.max(smax,q.s); }
  for(const q of n.meas){
    if(q.x==null) continue;
    const t=q.s!=null && smax>smin ? (q.s-smin)/(smax-smin) : 0.5;
    cx.fillStyle=q.s!=null ? geoSnrColor(t*40-20) : '#7ac8ff';
    cx.beginPath(); cx.arc(px(q.x),py(q.y),3+t*3,0,2*Math.PI); cx.fill();
  }
  cx.strokeStyle=themeColor('--scr-hi'); cx.lineWidth=1.5;
  const sx=px(S.x), sy=py(S.y);
  cx.beginPath(); cx.moveTo(sx-7,sy); cx.lineTo(sx+7,sy); cx.moveTo(sx,sy-7); cx.lineTo(sx,sy+7); cx.stroke();
  cx.beginPath(); cx.arc(sx,sy,Math.max(3,S.errKm/(2*m.h)*sz),0,2*Math.PI); cx.stroke();
  cx.fillStyle=themeColor('--scr-txt'); cx.font='10px monospace';
  const span=2*m.h; cx.fillText('area '+(span>=1?span.toFixed(1)+' km':Math.round(span*1000)+' m'),6,H-6);
}

/* ---------- хранилище: подложка, населённые пункты, точки карт ---------- */
let geoDbP=null;
function geoDb(){
  return geoDbP || (geoDbP=new Promise((res,rej)=>{
    const rq=indexedDB.open('dsp-geo',1);
    rq.onupgradeneeded=()=>rq.result.createObjectStore('kv');
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>{ geoDbP=null; rej(rq.error); };
  }));
}
async function geoGet(k){
  const db=await geoDb();
  return new Promise((res,rej)=>{ const r=db.transaction('kv').objectStore('kv').get(k);
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}
async function geoPut(k,v){
  const db=await geoDb();
  return new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(v,k);
    tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });
}

// Web Mercator в долях мира: x,y ∈ [0,1]
function mercX(lon){ return (lon+180)/360; }
function mercY(lat){
  const s=Math.sin(clamp(lat,-85.0511,85.0511)*D2R);
  return 0.5-Math.log((1+s)/(1-s))/(4*Math.PI);
}
function unmercX(x){ return x*360-180; }
function unmercY(y){ return Math.atan(Math.sinh(Math.PI*(1-2*y)))/D2R; }

// Подложка Natural Earth: data/basemap.json (tools/basemap.mjs), после первой загрузки — из IndexedDB
const GEO_BASE_TAG='ne10m-3';                        // сменить при пересборке data/basemap.json
const GeoBase={state:'idle', data:null, err:'', p:null, places:null, placesState:'', placesP:null, gen:0};
// подложка (4 МБ) на мобильной сети может оборваться, а запись в кэше — оказаться битой: повторяем 3 раза с паузой
function geoBaseLoad(){
  if(GeoBase.p) return GeoBase.p;
  GeoBase.state='loading';
  return GeoBase.p=(async()=>{
    let data=null;
    try{ const c=await geoGet('basemap'); if(c && c.tag===GEO_BASE_TAG) data=geoBasePrep(JSON.parse(c.text)); }catch(e){ data=null; }   // битый кэш — качаем заново
    if(!data){
      GeoBase.state='downloading';
      const r=await fetch('data/basemap.json'); if(!r.ok) throw new Error('HTTP '+r.status);
      const text=await r.text();
      data=geoBasePrep(JSON.parse(text));
      try{ await geoPut('basemap',{tag:GEO_BASE_TAG, text}); }catch(e){}
    }
    GeoBase.data=data; GeoBase.tries=0; GeoBase.err='';
    GeoBase.state='ready'; GeoBase.gen++;
  })().catch(e=>{
    GeoBase.state='error'; GeoBase.err=e.message; GeoBase.p=null;
    if((GeoBase.tries=(GeoBase.tries|0)+1)<=3) setTimeout(geoBaseLoad,3000*GeoBase.tries);
  });
}
// вернулись в приложение — подложки карт могли быть стёрты системой без всякого события: рисуем заново
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible') return;
  for(const n of Graph.nodes) if(n.type==='geoMap'){ n._baseKey=null; n.dirtyGen=(n.dirtyGen|0)+1; }
});
function geoBasePrep(raw){
  const q=raw.q||1000;
  const prepLayer=L=>{
    const out=[];
    for(let i=0;i<L.p.length;i++){
      const e=L.p[i], m=e.length>>1, xy=new Float64Array(e.length);
      let lon=0, lat=0, x0=1, y0=1, x1=0, y1=0;
      for(let j=0;j<m;j++){
        lon+=e[2*j]; lat+=e[2*j+1];
        const x=mercX(lon/q), y=mercY(lat/q);
        xy[2*j]=x; xy[2*j+1]=y;
        if(x<x0) x0=x; if(x>x1) x1=x; if(y<y0) y0=y; if(y>y1) y1=y;
      }
      out.push({xy, bb:[x0,y0,x1,y1], mz:L.mz[i]||0});
    }
    return out;
  };
  const pts=(a,f)=>a.map(f);
  return {
    src:raw.src,
    land:prepLayer(raw.land), lakes:prepLayer(raw.lakes), rivers:prepLayer(raw.rivers),
    adm0:prepLayer(raw.adm0), adm1:prepLayer(raw.adm1),
    countryLabels:pts(raw.countryLabels,a=>({x:mercX(a[0]),y:mercY(a[1]),name:a[2],mz:a[3],a3:a[4],a2:a[5],lat:a[1],lon:a[0]})),
    adm1Labels:pts(raw.adm1Labels,a=>({x:mercX(a[0]),y:mercY(a[1]),name:a[2],mz:a[3]})),
    places:pts(raw.places,a=>({x:mercX(a[0]),y:mercY(a[1]),name:a[2],mz:a[3],pop:a[4],kind:a[5]}))
      .sort((a,b)=>b.kind-a.kind || b.pop-a.pop),
  };
}

// Детальные населённые пункты (GeoNames): разово скачиваются или импортируются из файла
const GEO_PLACES_URL='https://raw.githubusercontent.com/lutangar/cities.json/master/cities.json';
function geoPlacesLoad(){
  if(GeoBase.placesP) return GeoBase.placesP;
  return GeoBase.placesP=(async()=>{
    try{ const c=await geoGet('places'); if(c) geoPlacesSet(c,false); }catch(e){}
  })();
}
function geoPlacesSet(c,save){
  // c: {name:[], lon:Float32Array, lat:Float32Array, pop:Int32Array}
  const cells=new Map();
  for(let i=0;i<c.name.length;i++){
    const k=Math.floor(c.lat[i]+90)*360+Math.floor(c.lon[i]+180);
    let a=cells.get(k); if(!a) cells.set(k,a=[]); a.push(i);
  }
  for(const a of cells.values()) a.sort((i,j)=>c.pop[j]-c.pop[i]);
  GeoBase.places={...c, cells};
  GeoBase.placesState=c.name.length+' places'; GeoBase.gen++;
  if(save) geoPut('places',{name:c.name, lon:c.lon, lat:c.lat, pop:c.pop}).catch(e=>{ GeoBase.placesState='not saved: '+e.message; });
}
function geoPlacesFromList(list){
  const N=list.length, c={name:new Array(N), lon:new Float32Array(N), lat:new Float32Array(N), pop:new Int32Array(N)};
  let k=0;
  for(const p of list){
    if(!isFinite(p.lat) || !isFinite(p.lon) || !p.name) continue;
    c.name[k]=p.name; c.lat[k]=p.lat; c.lon[k]=p.lon; c.pop[k]=p.pop|0; k++;
  }
  c.name.length=k;
  return {name:c.name, lon:c.lon.slice(0,k), lat:c.lat.slice(0,k), pop:c.pop.slice(0,k)};
}
// форматы: JSON-массив {name,lat,lng|lon}, GeoNames dump (TSV, 19 колонок), CSV с name,lat,lon[,population]
function geoPlacesParse(text){
  const t=text.trimStart();
  if(t[0]==='['){
    return JSON.parse(t).map(p=>({name:p.name, lat:+p.lat, lon:+(p.lng ?? p.lon), pop:+(p.population ?? p.pop ?? 0)}));
  }
  const first=t.slice(0,t.indexOf('\n'));
  if(first.split('\t').length>=15){
    return t.split('\n').map(l=>l.split('\t')).filter(a=>a.length>=15)
      .map(a=>({name:a[1], lat:+a[4], lon:+a[5], pop:+a[14]}));
  }
  const rows=geoCsvParse(t,''); const h=rows.shift().map(s=>s.trim().toLowerCase());
  const ix=(...ks)=>ks.map(k=>h.indexOf(k)).find(i=>i>=0) ?? -1;
  const iN=ix('name','city'), iLa=ix('lat','latitude'), iLo=ix('lon','lng','longitude'), iP=ix('population','pop');
  if(iN<0 || iLa<0 || iLo<0) throw new Error('need name, lat, lon columns');
  return rows.map(r=>({name:r[iN], lat:+r[iLa], lon:+r[iLo], pop:iP>=0 ? +r[iP] : 0}));
}
async function geoPlacesDownload(){
  GeoBase.placesState='downloading…';
  try{
    const r=await fetch(GEO_PLACES_URL); if(!r.ok) throw new Error('HTTP '+r.status);
    geoPlacesSet(geoPlacesFromList(geoPlacesParse(await r.text())),true);
  }catch(e){ GeoBase.placesState='error: '+e.message; }
}
function geoPlacesImport(f){
  const rd=new FileReader();
  GeoBase.placesState='importing…';
  rd.onload=()=>{
    try{ geoPlacesSet(geoPlacesFromList(geoPlacesParse(String(rd.result))),true); }
    catch(e){ GeoBase.placesState='error: '+e.message; }
  };
  rd.readAsText(f);
}

// Тайлы (по желанию): всё скачанное кладётся в Cache API 'dsp-tiles' и дальше доступно офлайн.
// Массовая предзагрузка не делается — правила OSM её запрещают, кэшируется только просмотренное.
const ESRI='https://server.arcgisonline.com/ArcGIS/rest/services/';
const GEO_TILES={
  'OSM':{url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max:19, attr:'© OpenStreetMap contributors'},
  'OpenTopoMap':{url:'https://tile.opentopomap.org/{z}/{x}/{y}.png', max:17, attr:'© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)'},
  'OSM Humanitarian':{url:'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', max:19, attr:'© OpenStreetMap contributors, Humanitarian OSM Team'},
  'CyclOSM':{url:'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', max:20, attr:'© OpenStreetMap contributors, © CyclOSM'},
  'CARTO Dark':{url:'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', max:20, attr:'© OpenStreetMap contributors © CARTO'},
  'CARTO Light':{url:'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', max:20, attr:'© OpenStreetMap contributors © CARTO'},
  'Esri Satellite':{url:ESRI+'World_Imagery/MapServer/tile/{z}/{y}/{x}', max:19, attr:'Tiles © Esri — Maxar, Earthstar Geographics, USDA, USGS'},
  'Esri Topo':{url:ESRI+'World_Topo_Map/MapServer/tile/{z}/{y}/{x}', max:19, attr:'Tiles © Esri — USGS, NOAA, Esri'},
  'Esri Streets':{url:ESRI+'World_Street_Map/MapServer/tile/{z}/{y}/{x}', max:19, attr:'Tiles © Esri — HERE, Garmin, OpenStreetMap contributors'},
  'Relief (DEM)':{dem:'color', url:'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', max:12, attr:'Terrain: Terrarium (SRTM, NED, GMTED, …) via AWS'},
};
// накладываются поверх основы с прозрачностью (параметр overlay)
const GEO_OVERLAYS={
  'Hillshade (DEM)':{dem:'shade', url:GEO_TILES['Relief (DEM)'].url, max:12, attr:'Terrain: Terrarium via AWS'},
  'Hillshade (Esri)':{url:ESRI+'Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', max:16, attr:'Hillshade © Esri'},
  'Railways':{url:'https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', max:19, attr:'© OpenRailwayMap'},
  'Sea marks':{url:'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', max:18, attr:'© OpenSeaMap'},
  'Hiking trails':{url:'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', max:18, attr:'© waymarkedtrails.org'},
  'Cycling routes':{url:'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', max:18, attr:'© waymarkedtrails.org'},
};
const GeoTiles={mem:new Map(), pending:new Set(), gen:0, cache:null};
// источник слоя узла: which — 'tiles' (основа) или 'overlay'; 'custom' — адрес из параметров tileUrl / tileUrl2 ({z}/{x}/{y}, {s} — a)
function geoSrc(n,which){
  const name=n.p[which];
  if(!name || name==='none') return null;
  if(name==='custom'){
    const u=String(n.p[which==='tiles' ? 'tileUrl' : 'tileUrl2']||'').trim();
    return /\{z\}/.test(u) && /\{x\}/.test(u) && /\{y\}/.test(u) ? {id:'custom:'+u, url:u, max:19, attr:'custom tiles'} : null;
  }
  const t=(which==='tiles' ? GEO_TILES : GEO_OVERLAYS)[name];
  return t ? {...t, id:t.dem ? 'dem:'+t.dem : name} : null;
}
function geoTileGet(src,z,x,y,net){
  const key=src.id+'/'+z+'/'+x+'/'+y;
  const m=GeoTiles.mem.get(key);
  if(m){
    if(m.bmp){ GeoTiles.mem.delete(key); GeoTiles.mem.set(key,m); return m.bmp; }   // LRU: в конец
    if(Date.now()-m.err<30000) return null;
  }
  if(GeoTiles.pending.has(key) || GeoTiles.pending.size>=8) return null;
  GeoTiles.pending.add(key);
  (async()=>{
    let bmp;
    if(src.dem){                                     // рельеф: тайл высот → картинка (из базы или сети, как Horizon)
      const h=await gdDemTile(z,x,y,net), mpp=156543.03392*Math.cos(unmercY((y+.5)/2**z)*D2R)/2**z;
      bmp=await createImageBitmap(new ImageData(gdDemShade(h,mpp,src.dem),256,256));
    } else {
      const url=src.url.replace('{z}',z).replace('{x}',x).replace('{y}',y).replace('{s}','a');
      const cache=GeoTiles.cache || (GeoTiles.cache=await caches.open('dsp-tiles'));
      let r=await cache.match(url);
      if(!r){
        if(!net) throw new Error('offline');
        r=await fetch(url,{mode:'cors'}); if(!r.ok) throw new Error('HTTP '+r.status);
        await cache.put(url,r.clone());
      }
      bmp=await createImageBitmap(await r.blob());
    }
    GeoTiles.mem.set(key,{bmp});
    while(GeoTiles.mem.size>300){ const k=GeoTiles.mem.keys().next().value; GeoTiles.mem.get(k).bmp?.close(); GeoTiles.mem.delete(k); }
  })().catch(()=>GeoTiles.mem.set(key,{err:Date.now()}))
    .finally(()=>{ GeoTiles.pending.delete(key); GeoTiles.gen++; });
  return null;
}

/* ---------- узел карты ---------- */
const GEO_TILE_OPTS=['none',...Object.keys(GEO_TILES),'custom'], GEO_OV_OPTS=['none',...Object.keys(GEO_OVERLAYS),'custom'];
def({ id:'geoMap', lazy:'manual', title:'Map', cat:'Geo',
  ins:[{n:'rec',t:'rec'},{n:'rec2',t:'rec'},{n:'rec3',t:'rec'},{n:'rows',t:'bands'}],
  outs:[{n:'pick',t:'rec'},{n:'sel',t:'rec'},{n:'edit',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'count',t:'num'}],
  w:480, view:{h:360}, resize:true,
  params:[{n:'ttl',t:'range',min:0,max:1440,step:1,d:0,label:'keep, min (0 — forever)'},
          {n:'tiles',t:'select',opts:GEO_TILE_OPTS,d:'none',label:'tiles'},
          {n:'overlay',t:'select',opts:GEO_OV_OPTS,d:'none',label:'overlay layer (relief shading, railways, trails…)'},
          {n:'ovAlpha',t:'range',min:.1,max:1,step:.05,d:.7,label:'overlay opacity'},
          {n:'grid',t:'select',opts:['none','lat/lon','maidenhead'],d:'none',label:'grid'},
          {n:'iconScale',t:'range',min:.5,max:3,step:.1,d:1,label:'icon size ×'},
          {n:'labels',t:'check',d:true,label:'labels'},
          {n:'cluster',t:'check',d:true,label:'cluster'},
          {n:'follow',t:'check',d:false,label:'follow'},
          {n:'net',t:'check',d:true,label:'online'},
          {n:'mode',t:'select',opts:['view','edit','add','line','polygon','ruler','circle'],d:'view',label:'mode: view / edit (select, drag, form) / add (tap = new point) / line, polygon, ruler, circle (tap = vertex)'},
          {n:'drawColor',t:'text',d:'#ffb400',label:'color of new shapes',adv:true},
          {n:'tools',t:'check',d:false,label:'mode buttons on the map (for tiles without settings)'},
          {n:'addName',t:'text',d:'P',label:'new point name prefix',adv:true},
          {n:'addIcon',t:'text',d:'dot',label:'new point icon',adv:true},
          {n:'fit',t:'button',label:'Fit',fn:n=>geoMapFit(n)},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.ents.clear(); n.gn.clear(); n.links.clear(); n.gnSrc=n.gsSrc=null; n.rasters?.clear(); n.selKey=null; geoMapChanged(n); }},
          {n:'trail',t:'range',min:1,max:5000,step:1,d:500,label:'track points per id',adv:true},
          {n:'maxEnt',t:'range',min:10,max:20000,step:10,d:5000,label:'max objects',adv:true},
          {n:'arrows',t:'check',d:false,label:'arrows on links',adv:true},
          {n:'rayKm',t:'range',min:10,max:20000,step:10,d:1000,label:'bearing length, km',adv:true},
          {n:'store',t:'text',d:'',label:'save points as (empty — don\'t save)',adv:true},
          {n:'csv',t:'button',label:'Save CSV',fn:n=>dl(new Blob(['\ufeff'+recsToCsv(geoMapRecs(n))],{type:'text/csv;charset=utf-8'}),'map-'+Date.now()+'.csv'),adv:true},
          {n:'geojson',t:'button',label:'Save GeoJSON',fn:n=>dl(new Blob([recsToGeoJson(geoMapRecs(n))],{type:'application/geo+json'}),'map-'+Date.now()+'.geojson'),adv:true},
          ...geoExportBtns(geoMapRecs,'map',true),
          {n:'tileUrl',t:'text',d:'',label:'custom tiles URL (tiles = custom): https://…/{z}/{x}/{y}.png',adv:true},
          {n:'tileUrl2',t:'text',d:'',label:'custom overlay URL (overlay = custom)',adv:true},
          {n:'vfile',t:'file',accept:'.geojson,.json,.kml,.gpx,application/json,application/geo+json',label:'Load vector layer: GeoJSON / KML / GPX',fn:(n,f)=>gdVecFile(n,f)},
          {n:'vclr',t:'button',label:'Remove vector layers',fn:n=>gdVecClear(n)},
          {n:'osmKind',t:'select',opts:Object.keys(GD_KINDS),d:'towers',label:'objects from OpenStreetMap'},
          {n:'osmGo',t:'button',label:'Load objects in view (also saved to Table lists geo/…)',fn:n=>gdMapImport(n,n.p.osmKind)},
          {n:'places',t:'button',label:'Download places (GeoNames, 17 MB)',fn:()=>geoPlacesDownload(),adv:true},
          {n:'placesFile',t:'file',accept:'.txt,.tsv,.csv,.json',fn:(n,f)=>geoPlacesImport(f),adv:true}],
  init:n=>{
    if(n.p.mlat==null) n.p.mlat=50;
    if(n.p.mlon==null) n.p.mlon=30;
    if(n.p.mz==null) n.p.mz=3;
    n.ents=new Map(); n.gn=new Map(); n.gnSrc=null; n.links=new Map(); n.gsSrc=null; n.unplaced=0; n.seq=0; n.selKey=null; n.pickRec=null; n.selOut=null; n.editQ=[]; n.loc=new Map(); n.addSeq=0; n.draft=null;
    n.pickLat=null; n.pickLon=null; n.info=null; n.lastPrune=0; n.loadedStore=null;
    geoBaseLoad(); geoPlacesLoad();
    n.vec=null; n.vmsg=''; n.vgen=0; gdVecRestore(n);
  },
  process(n,I){
    for(const k of ['rec','rec2','rec3']) for(const r of recList(I[k])) geoMapAdd(n,r);
    const sp=Array.isArray(I.rows) ? rowsSplit(I.rows) : null;     // rows: записи с координатами — точки, с from / to — связи
    geoMapNodes(n,sp&&sp.nodes); geoMapLinks(n,sp&&sp.edges);
    if(n.p.store!==n.loadedStore) geoMapRestore(n);
    const now=Date.now();
    if(now-n.lastPrune>1000){ n.lastPrune=now; geoMapPrune(n,now); }
    const pick=n.pickRec, sel=n.selOut, edit=n.editQ.length ? n.editQ.splice(0) : null; n.pickRec=null; n.selOut=null;
    return {pick, sel, edit, lat:n.pickLat, lon:n.pickLon, count:n.ents.size};
  },
  // секундный тик — только когда на карте есть что-то зависящее от времени (ttl, "seen N s ago", подсказка)
  drawKey:n=>n.dirtyGen+'|'+n.p.mode+'|'+GeoBase.gen+'|'+GeoBase.state+'|'+GeoBase.placesState+'|'+GeoTiles.gen+'|'+n.vmsg+'|'+n.selKey+'|'+
    (n.p.ttl>0 || n.selKey || (n.info && Date.now()-n.info.t<9000) ? Math.floor(Date.now()/1000) : ''),
  draw(n,cv,cx){ geoMapDraw(n,cv,cx); }});

// Один набор rows, как у Graph: записи id[,label,shape|icon,color,size] + lat/lon — точки, записи from,to[,weight,label,color] — связи.
// Снимки целиком, обновление по разнице: меняются только изменённые, пропавшие снимаются. Узел без координат на карте
// не рисуется (в Graph он остаётся). Связь рисуется между узлами по большому кругу.
const GEO_SHAPE_ICON={dot:'dot',circle:'dot',ellipse:'dot',square:'square',box:'square',database:'square',diamond:'diamond',hexagon:'diamond',
  triangle:'triangle',triangleDown:'triangle',star:'star'};
function geoNodeRec(r){
  if(!r || typeof r!=='object') return null;
  const f=gvKeys(r,GV_NODEA,null), k=f.id ?? Object.keys(r)[0], id=String(r[k]??'').trim();
  if(!id) return null;
  const pos=geoRecPos(r); if(!pos) return {id,none:true};
  const out={};
  for(const c in r) if(r[c]!=='' && r[c]!=null) out[c]=r[c];
  delete out[k]; delete out.shape;
  out.id='n:'+id; out.lat=pos.lat; out.lon=pos.lon; out.track=0;
  if(out.label==null && f.label==null) out.label=r.name ?? id;
  if(out.icon==null && f.shape!=null) out.icon=GEO_SHAPE_ICON[r[f.shape]];
  return {id,k,rec:out,sig:JSON.stringify(out)};
}
function geoMapNodes(n,src){
  if(src===n.gnSrc) return;
  n.gnSrc=src;
  const next=new Map(); n.unplaced=0;
  if(Array.isArray(src)) for(const r of src){ const x=geoNodeRec(r); if(!x) continue; if(x.none) n.unplaced++; else next.set(x.rec.id,x); }
  let ch=false;
  for(const id of n.gn.keys()) if(!next.has(id)){ n.ents.delete('id:'+id); if(n.selKey==='id:'+id) n.selKey=null; ch=true; }
  for(const [id,x] of next){
    if(n.gn.get(id)?.sig===x.sig && n.ents.has('id:'+id)) continue;
    const e=n.ents.get('id:'+id); if(e){ e.pts.length=0; e.rec={}; }
    geoMapAdd(n,x.rec); ch=true;
  }
  n.gn=next;
  if(ch) geoMapChanged(n);
}
function geoMapLinks(n,src){
  if(src===n.gsSrc) return;
  n.gsSrc=src; n.links=new Map();
  if(Array.isArray(src)) for(const r of src){ const e=gvEdgeRec(r,null); if(e) gvPut(n.links,e); }
  geoMapChanged(n);
}
// связи под значками: линия по большому кругу, толщина — вес, подпись посередине
function geoDrawLinks(n,cx,v){
  if(!n.links.size) return;
  const pos=id=>{ const e=n.ents.get('id:n:'+id), p=e?.pts[e.pts.length-1]; return p; };
  const base=themeColor('--line')||'#7a8a90', lab=n.p.labels && n.links.size<=200, labs=[];
  cx.save(); cx.lineJoin='round';
  for(const e of n.links.values()){
    const a=pos(e.from), b=pos(e.to); if(!a || !b) continue;
    const km=geoDist(a.lat,a.lon,b.lat,b.lon), brg=geoBearing(a.lat,a.lon,b.lat,b.lon), sa=geoProj(v,a.lat,a.lon);
    cx.strokeStyle=cx.fillStyle=e.color||base; cx.globalAlpha=.8; cx.lineWidth=1+Math.min(4,Math.log2(1+Math.abs(e.w)||1));
    cx.beginPath(); geoGreatCircle(cx,v,a.lat,a.lon,brg,km,sa.x); cx.stroke();
    const m=geoDest(a.lat,a.lon,brg,km/2), sm=geoProj(v,m.lat,m.lon,sa.x);
    if(n.p.arrows){
      const q=geoDest(a.lat,a.lon,brg,km*.55), sq=geoProj(v,q.lat,q.lon,sa.x), ang=Math.atan2(sq.y-sm.y,sq.x-sm.x);
      cx.beginPath(); cx.moveTo(sq.x,sq.y); cx.lineTo(sq.x-8*Math.cos(ang-.4),sq.y-8*Math.sin(ang-.4)); cx.lineTo(sq.x-8*Math.cos(ang+.4),sq.y-8*Math.sin(ang+.4)); cx.closePath(); cx.fill();
    }
    if(lab && e.label) labs.push([e.label,sm.x,sm.y]);
  }
  cx.globalAlpha=1; cx.font='10px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillStyle=themeColor('--scr-txt'); cx.strokeStyle=themeRgba('--screen',.85); cx.lineWidth=3;
  for(const [t,x,y] of labs){ cx.strokeText(t,x,y-6); cx.fillText(t,x,y-6); }
  cx.restore();
}
function geoMapAdd(n,r){
  if(r && r.kind==='raster'){                        // растровый слой (покрытие): картинка и границы, не объект
    const id=String(r.id ?? 'raster'), rs=n.rasters || (n.rasters=new Map());
    if(r.gone) rs.delete(id); else if(r.canvas && isFinite(r.north) && isFinite(r.south) && isFinite(r.west) && isFinite(r.east)){ if(rs.size>=8 && !rs.has(id)) rs.delete(rs.keys().next().value); rs.set(id,r); }
    geoMapChanged(n); return;
  }
  const pos=geoRecPos(r); if(!pos) return;
  const now=Date.now(), t=recTime(r) ?? now;
  const id=r.id!=null && r.id!=='' ? String(r.id) : null;
  const key=id!=null ? 'id:'+id : 'p:'+(n.seq++);
  let e=n.ents.get(key);
  if(!e){
    e={key, id, pts:[], rec:{}, seen:now, t};
    if(n.ents.size>=n.p.maxEnt){ const k0=n.ents.keys().next().value; n.ents.delete(k0); }
  } else n.ents.delete(key);                         // в конец Map: порядок = свежесть
  n.ents.set(key,e);
  Object.assign(e.rec,r);
  e.seen=now; e.t=t; e.grid=pos.grid||null;
  if(r.track===0 || r.track===false) e.pts.length=0;  // объект без трека (оценки, неподвижные точки)
  const last=e.pts[e.pts.length-1];
  if(!last || last.lat!==pos.lat || last.lon!==pos.lon){
    e.pts.push({lat:pos.lat, lon:pos.lon, t});
    if(e.pts.length>n.p.trail) e.pts.splice(0,e.pts.length-n.p.trail);
  }
  if(n.p.follow){ n.p.mlat=pos.lat; n.p.mlon=pos.lon; }
  geoMapChanged(n);
}
function geoMapPrune(n,now){
  if(!(n.p.ttl>0)) return;
  const ttl=n.p.ttl*60000; let ch=false;
  for(const [k,e] of n.ents) if(now-e.seen>ttl && !n.gn.has(e.id)){ n.ents.delete(k); ch=true; }
  if(ch) geoMapChanged(n);
}
function geoMapRecs(n){
  const out=[];
  for(const e of n.ents.values()){
    if(e.pts.length>1) for(const p of e.pts.slice(0,-1)) out.push({...e.rec, lat:p.lat, lon:p.lon, t:p.t});
    out.push({...e.rec});
  }
  return out;
}
// сохранение точек в IndexedDB под именем из параметра store (с задержкой, пачкой)
function geoMapChanged(n){
  n.dirtyGen=(n.dirtyGen|0)+1;
  if(!n.p.store || n.loadedStore!==n.p.store) return;
  clearTimeout(n.saveT);
  n.saveT=setTimeout(()=>{
    const ents=[...n.ents.values()].map(e=>({key:e.key, id:e.id, pts:e.pts, rec:e.rec, seen:e.seen, t:e.t}));
    geoPut('pts:'+n.p.store,{seq:n.seq, ents}).catch(()=>{});
  },2000);
}
function geoMapRestore(n){
  const name=n.p.store; n.loadedStore=name;
  if(!name) return;
  geoGet('pts:'+name).then(v=>{
    if(!v || n.p.store!==name) return;
    for(const e of v.ents) if(!n.ents.has(e.key)) n.ents.set(e.key,e);
    n.seq=Math.max(n.seq,v.seq|0); n.dirtyGen=(n.dirtyGen|0)+1;
  }).catch(()=>{});
}
function geoMapFit(n){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const e of n.ents.values()) for(const p of e.pts){
    const x=mercX(p.lon), y=mercY(p.lat);
    if(x<x0) x0=x; if(x>x1) x1=x; if(y<y0) y0=y; if(y>y1) y1=y;
  }
  if(!isFinite(x0)) return;
  const W=n.cv?.width||480, H=n.cv?.height||360;
  const span=Math.max((x1-x0)/(W*0.8), (y1-y0)/(H*0.8), 1e-9);
  n.p.mz=clamp(Math.log2(1/(256*span)),1,16);
  n.p.mlon=unmercX((x0+x1)/2); n.p.mlat=unmercY((y0+y1)/2);
}

// вид: центр (mlat, mlon) и дробный зум mz; S — размер мира в пикселях
function geoView(n,W,H){
  const z=clamp(n.p.mz,0.5,19), S=256*2**z;
  const ox=mercX(n.p.mlon)*S-W/2, oy=mercY(n.p.mlat)*S-H/2;
  return {z,S,ox,oy,W,H};
}
function geoMapZoomAt(n,px,py,dz){
  const W=n.cv.width, H=n.cv.height, v=geoView(n,W,H);
  const wx=(v.ox+px)/v.S, wy=(v.oy+py)/v.S;
  const z=clamp(v.z+dz,0.5,19), S=256*2**z;
  const ox=wx*S-px, oy=wy*S-py;
  n.p.mz=z; n.p.mlon=unmercX(geoWrapX((ox+W/2)/S)); n.p.mlat=unmercY(clamp((oy+H/2)/S,0,1));
}
function geoWrapX(x){ return x-Math.floor(x); }
function geoMapPan(n,dx,dy){
  const W=n.cv.width, H=n.cv.height, v=geoView(n,W,H);
  n.p.mlon=unmercX(geoWrapX((v.ox+W/2-dx)/v.S));
  n.p.mlat=unmercY(clamp((v.oy+H/2-dy)/v.S,0.001,0.999));
}

function geoMapWire(n,cv){
  if(n._wired===cv) return; n._wired=cv;
  // мобилка: без touch-action:none браузер забирает жест под прокрутку (дашборд) и шлёт
  // pointercancel — карта сдвигается на чуть-чуть; ownpinch — щипок не отдавать зуму графа
  cv.style.touchAction='none';
  cv.classList.add('ownpinch');
  const touches=new Map(); let drag=null, pinch=null, tap=null, mv=null, lastV=null;
  cv.addEventListener('wheel',ev=>{
    ev.preventDefault(); ev.stopPropagation();
    const r=cv.getBoundingClientRect(), k=cv.width/r.width;
    // шаг пропорционален прокрутке: тачпад шлёт много мелких событий, колесо мыши — ~100 px на щелчок
    const px=ev.deltaY*(ev.deltaMode===1 ? 33 : ev.deltaMode===2 ? 400 : 1);
    const dz=clamp(-px/(ev.ctrlKey ? 100 : 400),-0.35,0.35);
    geoMapZoomAt(n,(ev.clientX-r.left)*k,(ev.clientY-r.top)*k,dz);
  },{passive:false});
  cv.addEventListener('dblclick',ev=>{
    ev.stopPropagation();
    const r=cv.getBoundingClientRect(), k=cv.width/r.width;
    geoMapZoomAt(n,(ev.clientX-r.left)*k,(ev.clientY-r.top)*k,ev.shiftKey?-0.5:0.5);
  });
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation();
    cv.setPointerCapture(ev.pointerId);
    touches.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(touches.size===2){
      const [a,b]=[...touches.values()];
      pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1}; drag=null; tap=null; return;
    }
    drag={x:ev.clientX,y:ev.clientY}; tap={x:ev.clientX,y:ev.clientY};
    if(n.p.mode==='edit' && n.selKey){                // тянем выбранную точку / вершину, а не карту
      const r=cv.getBoundingClientRect(), k=cv.width/r.width, px=(ev.clientX-r.left)*k, py=(ev.clientY-r.top)*k;
      const e0=n.ents.get(n.selKey), h=e0 && geoEditable(n,e0) && geoShapeHandles(n,e0,geoView(n,cv.width,cv.height));
      const near=(a,d)=>a && Math.hypot(a.x-px,a.y-py)<=d;
      let vi=h?.verts ? h.verts.findIndex(a=>near(a,12)) : -1, mi=-1;
      if(vi<0 && h?.mids) mi=h.mids.findIndex(a=>near(a,10));
      if(vi>=0){ mv={e:e0,vi,moved:false}; drag=null; }
      else if(mi>=0){                                  // середина ребра: вставить вершину и сразу тянуть
        const g=h.g.map(q=>q.slice()), a=g[mi], b=g[(mi+1)%g.length], at=h.mids[mi].i+1;
        g.splice(at,0,[+((a[0]+b[0])/2).toFixed(6),+((a[1]+b[1])/2).toFixed(6)]);
        e0.rec.geom=JSON.stringify(g); mv={e:e0,vi:at,moved:false,ins:true}; drag=null; geoMapChanged(n);
      } else if(near(h?.rad,12)){ mv={e:e0,rad:true,moved:false}; drag=null; }
      else {
        const e=geoMapHit(n,px,py,14);
        if(e && e.key===n.selKey && geoEditable(n,e)){ mv={e,moved:false}; drag=null; }
      }
    }
  });
  cv.addEventListener('pointermove',ev=>{
    if(!touches.has(ev.pointerId)) return;
    touches.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    const r=cv.getBoundingClientRect(), k=cv.width/r.width;
    if(pinch && touches.size===2){
      const [a,b]=[...touches.values()], d=Math.hypot(a.x-b.x,a.y-b.y)||1;
      geoMapZoomAt(n,((a.x+b.x)/2-r.left)*k,((a.y+b.y)/2-r.top)*k,Math.log2(d/pinch.d));
      pinch.d=d; return;
    }
    if(mv){
      if(!tap || Math.hypot(ev.clientX-tap.x,ev.clientY-tap.y)>=3){
        const q=geoPxLatLon(n,(ev.clientX-r.left)*k,(ev.clientY-r.top)*k), p=mv.e.pts[mv.e.pts.length-1];
        if(mv.vi!=null){
          const g=geoParseGeom(mv.e.rec.geom).map(a=>a.slice()); g[mv.vi]=[+q.lat.toFixed(6),+q.lon.toFixed(6)];
          mv.e.rec.geom=JSON.stringify(g);
        } else if(mv.rad){
          mv.e.rec.radius=Math.max(1,Math.round(geoDist(p.lat,p.lon,q.lat,q.lon)*1000));
        } else {
          geoShiftGeom(mv.e,q.lat-p.lat,q.lon-p.lon);
          p.lat=mv.e.rec.lat=q.lat; p.lon=mv.e.rec.lon=q.lon;
        }
        mv.moved=true; tap=null; geoMapChanged(n);
      }
      return;
    }
    if(drag){
      geoMapPan(n,(ev.clientX-drag.x)*k,(ev.clientY-drag.y)*k);
      drag.x=ev.clientX; drag.y=ev.clientY;
    }
  });
  const up=ev=>{
    touches.delete(ev.pointerId);
    if(touches.size<2) pinch=null;
    if(mv){
      if(ev.type!=='pointerup'){ mv=null; tap=null; drag=null; return; }
      if(mv.vi!=null){
        const e=mv.e, now=Date.now();
        if(mv.moved || mv.ins){ lastV=null; geoCommitGeom(n,e); }
        else if(lastV && lastV.e===e && lastV.vi===mv.vi && now-lastV.t<400){      // второй тап по вершине — удалить её
          lastV=null;
          const g=geoParseGeom(e.rec.geom).map(a=>a.slice()), min=String(e.rec.gtype)==='polygon' ? 3 : 2;
          if(g.length>min){ g.splice(mv.vi,1); e.rec.geom=JSON.stringify(g); geoCommitGeom(n,e); }
        } else lastV={e,vi:mv.vi,t:now};
      } else if(mv.rad){
        if(mv.moved){ const r=mv.e.rec.radius; geoEmitEdit(n,mv.e,{radius:r,area_m2:Math.round(Math.PI*r*r)}); }
      } else if(mv.moved){ const p=mv.e.pts[mv.e.pts.length-1]; geoEmitEdit(n,mv.e,{lat:p.lat,lon:p.lon,...(mv.e.rec.geom!=null?{geom:mv.e.rec.geom}:{})}); }
      mv=null; tap=null; drag=null; return;
    }
    if(tap && ev.type==='pointerup' && Math.hypot(ev.clientX-tap.x,ev.clientY-tap.y)<6){
      const r=cv.getBoundingClientRect(), k=cv.width/r.width;
      geoMapTap(n,(ev.clientX-r.left)*k,(ev.clientY-r.top)*k);
    }
    tap=null; if(!touches.size) drag=null;
  };
  cv.addEventListener('pointerup',up);
  cv.addEventListener('pointercancel',up);
}
// правка точек: запись уходит на выход edit (в Table с upsert key = колонка имени), локально обновляется сразу
function geoEditable(n,e){
  const g=n.gn.get(e.id);
  return g ? {k:g.k,id:g.id} : n.loc.get(e.id)||null;
}
function geoEmitEdit(n,e,ch){
  const w=geoEditable(n,e); if(!w) return;
  for(const c of ['lat','lon']) if(ch[c]!=null) ch[c]=+(+ch[c]).toFixed(6);
  Object.assign(e.rec,ch);
  n.editQ.push({[w.k]:w.id,...ch});
  geoMapChanged(n);
}
function geoPxLatLon(n,px,py){
  const v=geoView(n,n.cv.width,n.cv.height);
  return {lat:unmercY(clamp((v.oy+py)/v.S,0,1)), lon:unmercX(geoWrapX((v.ox+px)/v.S))};
}
function geoMapHit(n,px,py,r){
  const v=geoView(n,n.cv.width,n.cv.height);
  let best=null, bd=r;
  for(const e of n.ents.values()){
    const p=e.pts[e.pts.length-1]; if(!p) continue;
    const s=geoProj(v,p.lat,p.lon,px), d=Math.hypot(s.x-px,s.y-py);
    if(d<bd){ bd=d; best=e; }
  }
  return best;
}
function geoAddPoint(n,px,py){
  const {lat,lon}=geoPxLatLon(n,px,py), pre=n.p.addName||'P';
  let name; do name=pre+(++n.addSeq); while(n.ents.has('id:n:'+name));
  const rec={id:'n:'+name,name,label:name,lat:+lat.toFixed(6),lon:+lon.toFixed(6),icon:n.p.addIcon||'dot',track:0};
  n.loc.set(rec.id,{k:'name',id:name});
  geoMapAdd(n,rec);
  n.editQ.push({name,lat:rec.lat,lon:rec.lon,icon:rec.icon});
  n.selKey='id:'+rec.id;
}
const GEO_FORM_SKIP=new Set(['id','track','lat','lon','path','approx','label','geom']);
const geoFormSkip=k=>GEO_FORM_SKIP.has(k) || k.startsWith('check_');
// форма правки выбранной точки: DOM поверх карты; поля — из самой записи, «＋» добавляет новое
function geoEditSync(n,cv){
  const host=cv.parentElement; if(!host) return;
  const se=!GEO_DRAW.has(n.p.mode) && n.selKey && n.ents.get(n.selKey), chk=se && se.rec.check_list && !se.rec.gtype && typeof tcChkItems==='function';
  const e=n.p.mode==='edit' && se, w=e && geoEditable(n,e);
  const key=w||chk ? n.selKey+(w ? '|e' : '')+(chk ? '|c' : '') : '';
  if(n._formKey===key && (!key || n._formEl?.isConnected)) return;
  n._formKey=key; n._formEl?.remove(); n._formEl=null;
  if(!w && !chk) return;
  if(getComputedStyle(host).position==='static') host.style.position='relative';
  const el=document.createElement('div'); el.className='geo-ov';
  el.style.cssText='position:absolute;left:6px;bottom:6px;max-width:62%;max-height:72%;overflow:auto;background:var(--panel);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:4px;border-radius:4px;z-index:3;touch-action:auto;';
  for(const ev of ['pointerdown','pointerup','wheel','dblclick']) el.addEventListener(ev,x=>x.stopPropagation());
  const inp='min-width:0;width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:1px 3px;';
  const top=document.createElement('div'); el.append(top);          // чеклист — сверху, чтобы не тонул под полями формы
  if(chk && w) top.style.cssText='border-bottom:1px solid var(--line);padding-bottom:4px;margin-bottom:4px;';
  const roll=new Set();                                              // поля-итоги чеклиста (tasks, tasks_done, tasks_total) не правятся
  if(e) for(const k in e.rec) if(k.endsWith('_total') && e.rec[k.slice(0,-6)]!==undefined){ const b=k.slice(0,-6); roll.add(b); roll.add(b+'_done'); roll.add(k); }
  if(e && 'count' in e.rec && 'first' in e.rec && 'last' in e.rec) for(const k of ['count','first','last']) roll.add(k);   // служебные поля Table
  const rows=[];
  const row=(k,v)=>{
    const d=document.createElement('div'); d.style.cssText='display:flex;gap:4px;margin:2px 0;align-items:center;';
    const l=document.createElement('input'); l.value=k; l.style.cssText=inp+'width:38%;'; l.disabled=k!==''; if(k==='') l.placeholder='field';
    const i=document.createElement('input'); i.style.cssText=inp;
    if(typeof v==='boolean'){ i.type='checkbox'; i.checked=v; i.style.width='auto'; } else i.value=v;
    i.dataset.t=typeof v;
    d.append(l,i); el.append(d); rows.push([l,i]);
  };
  if(w){
  const h=document.createElement('div'); h.style.cssText='font-weight:bold;margin-bottom:2px;'; h.textContent=w.k+': '+w.id; el.append(h);
  for(const k in e.rec) if(!geoFormSkip(k) && !roll.has(k) && k!==w.k && typeof e.rec[k]!=='object') row(k,e.rec[k]);
  const bar=document.createElement('div'); bar.style.cssText='display:flex;gap:4px;margin-top:3px;';
  const btn=(t,f)=>{ const b=document.createElement('button'); b.textContent=t; b.style.cssText='background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;'; b.onclick=f; bar.append(b); };
  btn('＋',()=>row('',''));
  btn('Save',()=>{
    const ch={};
    for(const [l,i] of rows){
      const k=l.value.trim(); if(!k || geoFormSkip(k) || k===w.k) continue;
      let v=i.type==='checkbox' ? i.checked : i.value;
      if(i.dataset.t==='number' || (i.dataset.t==='string' && v!=='' && /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v))) v=+v;
      if(v!==e.rec[k]) ch[k]=v;
    }
    if(Object.keys(ch).length) geoEmitEdit(n,e,ch);
  });
  btn('🗑',()=>{
    if(!confirm('Delete "'+w.id+'"?')) return;
    n.editQ.push({[w.k]:w.id,_delete:1});
    n.ents.delete(n.selKey); n.gn.delete(e.id); n.loc.delete(e.id); n.selKey=null; geoMapChanged(n);
  });
  btn('✕',()=>{ n.selKey=null; geoMapChanged(n); });
  el.append(bar);
  }
  host.append(el); n._formEl=el;
  if(chk){                                           // пункты чеклиста записи: галочки и добавление; сводка на значке обновится через Table
    const r=se.rec, lab=r.check_key ?? r.label ?? r.name ?? se.id, t=document.createElement('div');
    t.style.cssText='font-weight:bold;margin:0 0 2px;'; t.textContent='☑ '+lab;
    top.append(t);
    tcChkItems(r.check_list,r.check_via,r.check_col).then(s=>{
      if(!s || n._formEl!==el) return;
      top.append(tcChkView(s,String(r.check_key ?? ''),{}));
      if(!w){ const x=document.createElement('button'); x.textContent='✕'; x.style.cssText='position:absolute;right:3px;top:3px;font-size:10px;background:none;border:0;color:var(--txt);cursor:pointer;'; x.onclick=()=>{ n.selKey=null; geoMapChanged(n); }; el.append(x); }
    }).catch(()=>{});
  }
}
// кнопки режимов на самой карте: в тайле без панели настроек иначе негде переключить режим
const GEO_TOOLS=[['view','☝','view only'],['edit','✎','edit: select, drag, form, delete'],['add','＋','add a point: tap'],['line','╱','draw a line'],['polygon','⬠','draw a polygon'],['ruler','📏','ruler: distances and bearings'],['circle','◯','draw a circle: centre, then an edge point']];
function geoToolsSync(n,cv){
  const host=cv.parentElement; if(!host) return;
  if(!n.p.tools){ if(n._toolsEl){ n._toolsEl.remove(); n._toolsEl=null; } return; }
  if(!n._toolsEl?.isConnected){
    if(getComputedStyle(host).position==='static') host.style.position='relative';
    const el=document.createElement('div'); el.className='geo-ov';
    el.style.cssText='position:absolute;left:6px;top:24px;display:flex;gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:2px;z-index:3;';
    for(const ev of ['pointerdown','pointerup','wheel','dblclick']) el.addEventListener(ev,x=>x.stopPropagation());
    for(const [m,t,tip] of GEO_TOOLS){
      const b=document.createElement('button'); b.textContent=t; b.title=tip; b.dataset.m=m;
      b.style.cssText='background:none;border:1px solid transparent;color:var(--txt);min-width:24px;height:24px;border-radius:3px;cursor:pointer;font-size:13px;padding:0 3px;';
      b.onclick=()=>{ setMod(n,'mode',m); geoMapChanged(n); };
      el.append(b);
    }
    host.append(el); n._toolsEl=el;
  }
  for(const b of n._toolsEl.children){ const on=b.dataset.m===n.p.mode; b.style.background=on ? 'var(--acc)' : 'none'; b.style.color=on ? 'var(--bg)' : 'var(--txt)'; }
}
const GEO_DRAW=new Set(['line','polygon','ruler','circle']);
function geoDraftNeed(t){ return t==='polygon' ? 3 : 2; }
function geoDraftTap(n,px,py){
  const t=n.p.mode, {lat,lon}=geoPxLatLon(n,px,py), q=[+lat.toFixed(6),+lon.toFixed(6)];
  if(!n.draft || n.draft.type!==t) n.draft={type:t,pts:[]};
  const d=n.draft;
  if(t==='circle'){
    if(!d.pts.length){ d.pts.push(q); return; }
    const km=geoDist(d.pts[0][0],d.pts[0][1],q[0],q[1]);
    if(km>0) geoShapeDone(n,{gtype:'circle',lat:d.pts[0][0],lon:d.pts[0][1],radius:Math.round(km*1000),area_m2:Math.round(Math.PI*km*km*1e6)});
    n.draft=null; return;
  }
  d.pts.push(q);
}
function geoShapeDone(n,f){
  const pre=f.gtype;
  let name; do name=pre+(++n.addSeq); while(n.ents.has('id:n:'+name));
  const col=n.p.drawColor||'#ffb400', rec={id:'n:'+name,name,label:name,icon:'dot',size:3,color:col,track:0,...f};
  n.loc.set(rec.id,{k:'name',id:name});
  geoMapAdd(n,rec);
  const {id,track,label,...out}=rec; delete out.size;
  n.editQ.push(out);
  n.selKey='id:'+rec.id;
}
function geoDraftFinish(n){
  const d=n.draft; if(!d || d.pts.length<geoDraftNeed(d.type)) return;
  const g=d.pts, c=[g.reduce((a,q)=>a+q[0],0)/g.length, g.reduce((a,q)=>a+q[1],0)/g.length];
  geoShapeDone(n,{gtype:d.type,geom:JSON.stringify(g),lat:+c[0].toFixed(6),lon:+c[1].toFixed(6),...geoShapeMetrics(d.type,g)});
  n.draft=null; geoMapChanged(n);
}
function geoDraftText(n){
  const d=n.draft; if(!d) return n.p.mode==='circle' ? 'tap the centre' : 'tap vertices';
  const g=d.pts, poly=d.type==='polygon';
  if(d.type==='circle') return g.length ? 'tap a point on the circle' : 'tap the centre';
  const t=[g.length+' pts'];
  if(g.length>1) t.push(geoFmtDist(geoPathKm(g,poly)));
  if(poly && g.length>2) t.push(geoFmtArea(geoAreaKm2(g)));
  return t.join(' · ');
}
// панель рисования: DOM поверх карты, пока выбран режим фигуры
function geoDraftSync(n,cv){
  const host=cv.parentElement; if(!host) return;
  const on=GEO_DRAW.has(n.p.mode);
  if(!on){ if(n.draft) n.draft=null; if(n._drawEl){ n._drawEl.remove(); n._drawEl=null; } return; }
  if(!n._drawEl?.isConnected){
    if(getComputedStyle(host).position==='static') host.style.position='relative';
    const el=document.createElement('div'); el.className='geo-ov';
    el.style.cssText='position:absolute;left:6px;bottom:6px;display:flex;gap:4px;align-items:center;background:var(--panel);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:3px 5px;border-radius:4px;z-index:3;';
    for(const ev of ['pointerdown','pointerup','wheel','dblclick']) el.addEventListener(ev,x=>x.stopPropagation());
    const btn=(t,tip,f)=>{ const b=document.createElement('button'); b.textContent=t; b.title=tip; b.style.cssText='background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:1px 6px;border-radius:3px;cursor:pointer;font-size:11px;'; b.onclick=()=>{ f(); geoMapChanged(n); }; el.append(b); };
    btn('↶','remove the last vertex',()=>{ n.draft?.pts.pop(); });
    btn('✓','finish the shape',()=>geoDraftFinish(n));
    btn('✕','cancel',()=>{ n.draft=null; });
    const tx=document.createElement('span'); tx.className='geo-dt'; el.append(tx);
    host.append(el); n._drawEl=el;
  }
  const t=geoDraftText(n), tx=n._drawEl.querySelector('.geo-dt');
  if(tx.textContent!==t) tx.textContent=t;
}
// фигура: полилиния / многоугольник / линейка с подписями отрезков
function geoDrawShape(n,cx,v,pts,type,col,refX,w,dim){
  if(!pts.length) return;
  const poly=type==='polygon' && pts.length>2, sp=[]; let px=null;
  for(const q of pts){ const p=geoProj(v,q[0],q[1],px??refX); sp.push(p); px=p.x; }
  cx.save(); cx.lineJoin='round'; cx.strokeStyle=cx.fillStyle=col; cx.lineWidth=w;
  if(type==='ruler') cx.setLineDash([6,4]);
  cx.beginPath(); sp.forEach((p,i)=>i ? cx.lineTo(p.x,p.y) : cx.moveTo(p.x,p.y));
  if(poly) cx.closePath();
  if(poly){ cx.globalAlpha*=.15; cx.fill(); cx.globalAlpha/=.15; }
  cx.stroke(); cx.setLineDash([]);
  if(dim || type==='ruler') for(const p of sp){ cx.beginPath(); cx.arc(p.x,p.y,2.5,0,2*Math.PI); cx.fill(); }
  if(type==='ruler' && n.p.labels){
    cx.font='10px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle'; cx.strokeStyle=themeRgba('--screen',.85); cx.lineWidth=3;
    let tot=0;
    for(let i=1;i<pts.length;i++){
      const km=geoDist(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]); tot+=km;
      const x=(sp[i-1].x+sp[i].x)/2, y=(sp[i-1].y+sp[i].y)/2-7, t=geoFmtDist(km)+' · '+Math.round(geoBearing(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]))+'°';
      cx.strokeText(t,x,y); cx.fillText(t,x,y);
    }
    if(pts.length>2){ const l=sp[sp.length-1], t='Σ '+geoFmtDist(tot); cx.textAlign='left'; cx.strokeText(t,l.x+6,l.y+9); cx.fillText(t,l.x+6,l.y+9); }
  }
  cx.restore();
}
// ручки правки выбранной фигуры: вершины, середины рёбер (нажатие вставляет вершину), у круга — ручка радиуса
function geoShapeHandles(n,e,v){
  const last=e.pts[e.pts.length-1]; if(!last) return null;
  const g=geoParseGeom(e.rec.geom), type=String(e.rec.gtype||'line');
  if(g && g.length>1){
    const verts=[]; let px=geoProj(v,last.lat,last.lon).x;
    for(const q of g){ const p=geoProj(v,q[0],q[1],px); verts.push({x:p.x,y:p.y}); px=p.x; }
    const mids=[], m=type==='polygon' ? g.length : g.length-1;
    for(let i=0;i<m;i++){ const a=verts[i], b=verts[(i+1)%g.length]; mids.push({x:(a.x+b.x)/2,y:(a.y+b.y)/2,i}); }
    return {g,type,verts,mids};
  }
  const rad=recNum(e.rec.radius);
  if(type==='circle' && rad>0){
    const q=geoDest(last.lat,last.lon,90,rad/1000), p=geoProj(v,q.lat,q.lon,geoProj(v,last.lat,last.lon).x);
    return {type,rad:{x:p.x,y:p.y}};
  }
  return null;
}
function geoDrawHandles(n,cx,v,e,col){
  const h=geoShapeHandles(n,e,v); if(!h) return;
  cx.save(); cx.lineWidth=1.5; cx.strokeStyle=col; cx.fillStyle='#fff';
  for(const m of h.mids||[]){ cx.globalAlpha=.7; cx.beginPath(); cx.arc(m.x,m.y,3,0,2*Math.PI); cx.stroke(); }
  cx.globalAlpha=1;
  for(const p of h.verts||[]){ cx.beginPath(); cx.rect(p.x-4,p.y-4,8,8); cx.fill(); cx.stroke(); }
  if(h.rad){ cx.beginPath(); cx.moveTo(h.rad.x,h.rad.y-5); cx.lineTo(h.rad.x+5,h.rad.y); cx.lineTo(h.rad.x,h.rad.y+5); cx.lineTo(h.rad.x-5,h.rad.y); cx.closePath(); cx.fill(); cx.stroke(); }
  cx.restore();
}
// тап по телу фигуры (внутри полигона / рядом с линией / внутри круга) выбирает её
function geoShapeAt(n,v,px,py){
  const ents=[...n.ents.values()].reverse();
  for(const e of ents){
    const h=geoShapeHandles(n,e,v), last=e.pts[e.pts.length-1];
    if(!h) continue;
    if(h.verts){
      const V=h.verts, poly=h.type==='polygon' && V.length>2;
      if(poly){
        let ins=false;
        for(let i=0,j=V.length-1;i<V.length;j=i++) if((V[i].y>py)!==(V[j].y>py) && px<(V[j].x-V[i].x)*(py-V[i].y)/(V[j].y-V[i].y)+V[i].x) ins=!ins;
        if(ins) return e;
      }
      const m=poly ? V.length : V.length-1;
      for(let i=0;i<m;i++){
        const a=V[i], b=V[(i+1)%V.length], dx=b.x-a.x, dy=b.y-a.y, L=dx*dx+dy*dy;
        const t=L ? Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/L)) : 0;
        if(Math.hypot(px-(a.x+t*dx),py-(a.y+t*dy))<8) return e;
      }
    } else if(h.rad){
      const q=geoPxLatLon(n,px,py);
      if(geoDist(last.lat,last.lon,q.lat,q.lon)*1000<=recNum(e.rec.radius)) return e;
    }
  }
  return null;
}
// форма изменилась (вершина сдвинута / вставлена / удалена): центр и размеры пересчитать, запись — на выход edit
function geoCommitGeom(n,e){
  const g=geoParseGeom(e.rec.geom); if(!g) return;
  const c=[g.reduce((a,q)=>a+q[0],0)/g.length, g.reduce((a,q)=>a+q[1],0)/g.length], p=e.pts[e.pts.length-1];
  p.lat=c[0]; p.lon=c[1];
  geoEmitEdit(n,e,{geom:e.rec.geom,lat:c[0],lon:c[1],...geoShapeMetrics(String(e.rec.gtype||'line'),g)});
}
// сдвиг фигуры вместе с перетаскиваемой точкой
function geoShiftGeom(e,dlat,dlon){
  const g=geoParseGeom(e.rec.geom); if(!g) return;
  e.rec.geom=JSON.stringify(g.map(q=>[+(q[0]+dlat).toFixed(6),+(q[1]+dlon).toFixed(6)]));
}
function geoMapTap(n,px,py){
  if(GEO_DRAW.has(n.p.mode)){ geoDraftTap(n,px,py); geoMapChanged(n); return; }
  const v=geoView(n,n.cv.width,n.cv.height);
  for(const c of n.clusters||[]) if(Math.hypot(c.x-px,c.y-py)<=c.r+3){ geoMapZoomAt(n,c.x,c.y,2); return; }  // тап по кластеру — приблизить
  let best=null, bd=12;
  for(const e of n.ents.values()){
    const p=e.pts[e.pts.length-1]; if(!p) continue;
    const s=geoProj(v,p.lat,p.lon,px);
    const d=Math.hypot(s.x-px,s.y-py);
    if(d<bd){ bd=d; best=e; }
  }
  if(best){ n.selKey=best.key; n.selOut=[{...best.rec}]; return; }
  if(!best && n.p.mode!=='add'){ const sh=geoShapeAt(n,v,px,py); if(sh){ n.selKey=sh.key; n.selOut=[{...sh.rec}]; return; } }
  if(n.p.mode==='add'){ geoAddPoint(n,px,py); geoMapChanged(n); return; }
  n.selKey=null;
  const lat=unmercY(clamp((v.oy+py)/v.S,0,1)), lon=unmercX(geoWrapX((v.ox+px)/v.S));
  geoMapPick(n,lat,lon);                             // pick уходит с рельефом под точкой (ground), как только он известен
}
// экранные координаты точки; копию мира выбираем ближайшую к refX (по долготе мир повторяется)
function geoProj(v,lat,lon,refX){
  let x=mercX(lon)*v.S-v.ox; const y=mercY(lat)*v.S-v.oy;
  const ref=refX ?? v.W/2;
  x+=Math.round((ref-x)/v.S)*v.S;
  return {x,y};
}

// обход линий слоя с отсечением по рамке и пропуском точек ближе пикселя; world-копии по долготе
function geoPathLayer(cx,layer,v,z){
  const {S,ox,oy,W,H}=v;
  const k0=Math.floor(ox/S)-1, k1=Math.floor((ox+W)/S)+1;
  for(const L of layer){
    if(L.mz>z) continue;
    const by0=L.bb[1]*S-oy, by1=L.bb[3]*S-oy;
    if(by1<-2 || by0>H+2) continue;
    for(let k=k0;k<=k1;k++){
      const off=k*S-ox;
      if(L.bb[2]*S+off<-2 || L.bb[0]*S+off>W+2) continue;
      const xy=L.xy, m=xy.length>>1;
      let lx=xy[0]*S+off, ly=xy[1]*S-oy;
      cx.moveTo(lx,ly);
      for(let j=1;j<m;j++){
        const x=xy[2*j]*S+off, y=xy[2*j+1]*S-oy;
        if(j<m-1 && Math.abs(x-lx)+Math.abs(y-ly)<0.8) continue;
        cx.lineTo(x,y); lx=x; ly=y;
      }
    }
  }
}
const GEO_COL_DARK={sea:'#0b1419', land:'#151d21', coast:'#33454e', lake:'#0e1c24', river:'#1d3645',
  adm0:'#6d7f88', adm1:'#34444c', label:'#8d9ea6', labelDim:'#62737b', place:'#b8c4ca', grid:'rgba(120,160,180,.18)'};
const GEO_COL_LIGHT={sea:'#d9e6ee', land:'#f1efe9', coast:'#9eb0b9', lake:'#cbdfea', river:'#8fb8d0',
  adm0:'#7a8a92', adm1:'#b3bec4', label:'#4a5a62', labelDim:'#7a8a92', place:'#25313a', grid:'rgba(60,90,110,.18)'};
// светлая тема — светлая подложка (экран узла светлый)
function geoLight(){ const h=themeColor('--screen').replace('#',''); return h.length===6 && parseInt(h.slice(0,2),16)>128; }
function geoCol(){ return geoLight() ? GEO_COL_LIGHT : GEO_COL_DARK; }

const GEO_BASE_CAP=matchMedia('(pointer:coarse)').matches ? 4e6 : 1.2e7;   // пикселей буфера подложки
function geoMapDraw(n,cv,cx){
  geoMapWire(n,cv);
  geoEditSync(n,cv); geoDraftSync(n,cv); geoToolsSync(n,cv);
  const W=cv.width, H=cv.height, v=geoView(n,W,H), z=v.z;
  // подложка — в отдельную канву с полями M: при панораме сдвигаем готовую картинку,
  // при зуме растягиваем её и перерисовываем, когда зум успокоился
  const now=performance.now(), M=Math.round(Math.min(W,H)*.35);
  const key=[geoLight(),W,H,cv.pxW,GeoBase.gen,n.p.tiles,n.p.overlay,n.p.ovAlpha,n.p.tileUrl,n.p.tileUrl2,n.vgen,n.p.grid,n.p.tiles!=='none'||n.p.overlay!=='none'?GeoTiles.gen:0].join(':');
  if(v.S!==n._lastS){ n._lastS=v.S; n._zoomT=now; }
  const bv=n._bv, f=bv ? v.S/bv.S : 1;
  let dx=0, dy=0, ok=bv && n._baseKey===key && (f===1 || now-n._zoomT<200);
  if(ok){
    dx=bv.ox*f-v.ox; dy=bv.oy*f-v.oy;
    dx-=Math.round((dx+bv.M*f)/v.S)*v.S;               // мир повторяется по долготе
    ok=dx<=0 && dy<=0 && dx+bv.W*f>=W && dy+bv.H*f>=H;
  }
  if(!ok){
    n._baseKey=key;
    let b=n._base;
    if(!b){ b=n._base=document.createElement('canvas');
      // Android стирает буфер подложки в фоне / при нехватке памяти: ключ тот же, и карта рисовалась бы пустой
      b.addEventListener('contextrestored',()=>{ n._baseKey=null; redraw(n); }); }
    const BW=W+2*M, BH=H+2*M, r=Math.min(cv.pxW/W, Math.sqrt(GEO_BASE_CAP/(BW*BH)));
    const pw=Math.round(BW*r), ph=Math.round(BH*r);
    if(b.width!==pw || b.height!==ph){ b.width=pw; b.height=ph; }
    const bx=b.getContext('2d');
    bx.setTransform(pw/BW,0,0,ph/BH,0,0);
    const vb={...v, W:BW, H:BH, ox:v.ox-M, oy:v.oy-M};
    geoDrawBase(n,bx,vb);
    n._bv={ox:vb.ox, oy:vb.oy, S:v.S, W:BW, H:BH, M};
    dx=-M; dy=-M;
  }
  const g=n._bv, k=v.S/g.S;
  if(k!==1) redraw(n);                                  // подложка растянута — перерисуем, когда зум успокоится
  cx.drawImage(n._base,dx,dy,g.W*k,g.H*k);
  GD.view={n};
  geoDrawRasters(n,cx,v);
  geoDrawObjects(n,cx,v);
  if(n.draft?.pts.length){                          // фигура в процессе рисования
    const d=n.draft, c=n.p.drawColor||'#ffb400', f=geoProj(v,d.pts[0][0],d.pts[0][1]);
    if(d.type==='circle'){ cx.fillStyle=c; cx.beginPath(); cx.arc(f.x,f.y,4,0,2*Math.PI); cx.fill(); }
    else geoDrawShape(n,cx,v,d.pts,d.type,c,f.x,2,true);
  }
  geoDrawOverlay(n,cx,v);
}
// растры: строка картинки — полоса между своими широтами (карта в меркаторе, картинка линейна по широте)
function geoDrawRasters(n,cx,v){
  if(!n.rasters || !n.rasters.size) return;
  const t=n._rt || (n._rt=document.createElement('canvas'));
  if(t.width!==v.W || t.height!==v.H){ t.width=v.W; t.height=v.H; }
  const tx=t.getContext('2d');
  for(const r of n.rasters.values()){
    const c=r.canvas, rows=c.height, a=geoProj(v,r.north,r.west), b=geoProj(v,r.south,r.east);
    if(b.x<0 || a.x>v.W || b.y<0 || a.y>v.H) continue;
    // сначала непрозрачно во временную канву (границы строк по целым пикселям, без швов), затем одним слоем с прозрачностью
    tx.clearRect(0,0,v.W,v.H); tx.imageSmoothingEnabled=false;
    const x0=Math.round(a.x), w=Math.max(1,Math.round(b.x)-x0);
    if(rows<2 || b.y-a.y<rows*1.5) tx.drawImage(c,x0,Math.round(a.y),w,Math.max(1,Math.round(b.y)-Math.round(a.y)));
    else {
      let y0=Math.round(geoProj(v,r.north,r.west).y);
      for(let j=0;j<rows;j++){
        const y1=Math.round(geoProj(v,r.north+(r.south-r.north)*(j+1)/rows,r.west).y);
        if(y1>y0 && y1>=0 && y0<=v.H) tx.drawImage(c,0,j,c.width,1,x0,y0,w,y1-y0);
        y0=y1;
      }
    }
    cx.save(); cx.globalAlpha=clamp(+r.opacity||.55,0,1); cx.drawImage(t,0,0); cx.restore();
  }
}
function geoDrawBase(n,cx,v){
  const {W,H,z}=v, D=GeoBase.data;
  cx.fillStyle=geoCol().sea; cx.fillRect(0,0,W,H);
  const tiles=geoSrc(n,'tiles'), over=geoSrc(n,'overlay');
  if(tiles) geoDrawTiles(n,cx,v,tiles,1);
  if(over) geoDrawTiles(n,cx,v,over,clamp(+n.p.ovAlpha||.7,0,1));
  if(D){
    if(!tiles){
      cx.beginPath(); geoPathLayer(cx,D.land,v,z);
      cx.fillStyle=geoCol().land; cx.fill('evenodd');
      cx.strokeStyle=geoCol().coast; cx.lineWidth=1; cx.stroke();
      cx.beginPath(); geoPathLayer(cx,D.lakes,v,z);
      cx.fillStyle=geoCol().lake; cx.fill('evenodd'); cx.strokeStyle=geoCol().river; cx.stroke();
      cx.beginPath(); geoPathLayer(cx,D.rivers,v,z);
      cx.strokeStyle=geoCol().river; cx.stroke();
    }
    if(z>=3){
      cx.beginPath(); geoPathLayer(cx,D.adm1,v,Math.max(z,4)+2);
      cx.strokeStyle=tiles?'rgba(80,60,120,.6)':geoCol().adm1; cx.setLineDash([3,3]); cx.stroke(); cx.setLineDash([]);
    }
    cx.beginPath(); geoPathLayer(cx,D.adm0,v,99);
    cx.strokeStyle=tiles?'rgba(90,40,110,.8)':geoCol().adm0; cx.lineWidth=1.2; cx.stroke(); cx.lineWidth=1;
  }
  gdVecDraw(n,cx,v);
  if(n.p.grid!=='none') geoDrawGrid(n,cx,v);
  if(D && !tiles) geoDrawLabels(n,cx,v);
}
function geoDrawTiles(n,cx,v,T,alpha){
  const tz=clamp(Math.round(v.z),0,T.max), N=2**tz;
  const ts=v.S/N;                                    // размер тайла на экране
  const x0=Math.floor(v.ox/ts), x1=Math.floor((v.ox+v.W)/ts), y0=Math.max(0,Math.floor(v.oy/ts)), y1=Math.min(N-1,Math.floor((v.oy+v.H)/ts));
  if((x1-x0+1)*(y1-y0+1)>120) return;
  cx.save(); cx.imageSmoothingEnabled=true; cx.globalAlpha=alpha;
  for(let ty=y0;ty<=y1;ty++) for(let tx=x0;tx<=x1;tx++){
    const wx=((tx%N)+N)%N, sx=tx*ts-v.ox, sy=ty*ts-v.oy;
    const bmp=geoTileGet(T,tz,wx,ty,n.p.net);
    if(bmp){ cx.drawImage(bmp,sx,sy,ts+0.5,ts+0.5); continue; }
    // нет тайла — растянуть кусок родителя из памяти (офлайн или ещё грузится)
    for(let up=1;up<=5 && tz-up>=0;up++){
      const pz=tz-up, f=2**up, px=Math.floor(wx/f), py=Math.floor(ty/f);
      const m=GeoTiles.mem.get(T.id+'/'+pz+'/'+px+'/'+py);
      if(!m?.bmp){ if(up===1) geoTileGet(T,pz,px,py,n.p.net); continue; }
      const sub=256/f;
      cx.drawImage(m.bmp,(wx-px*f)*sub,(ty-py*f)*sub,sub,sub,sx,sy,ts+0.5,ts+0.5);
      break;
    }
  }
  cx.restore();
}
function geoDrawGrid(n,cx,v){
  const {W,H,S,ox,oy,z}=v;
  const lon0=unmercX(ox/S), lon1=unmercX((ox+W)/S);
  const lat1=unmercY(clamp(oy/S,0,1)), lat0=unmercY(clamp((oy+H)/S,0,1));
  let dlon, dlat;
  if(n.p.grid==='maidenhead'){
    if(z<5){ dlon=20; dlat=10; } else if(z<9){ dlon=2; dlat=1; } else { dlon=2/24; dlat=1/24; }
  } else {
    const st=[30,10,5,2,1,0.5,0.2,0.1,0.05,0.02,0.01];
    const want=(lon1-lon0)/6; dlon=st.find(s=>s<=want)||0.01; dlat=dlon;
  }
  cx.strokeStyle=geoCol().grid; cx.beginPath();
  for(let lon=Math.floor((lon0+180)/dlon)*dlon-180; lon<=lon1; lon+=dlon){
    const x=mercX(lon)*S-ox; cx.moveTo(x,0); cx.lineTo(x,H); }
  for(let lat=Math.floor((lat0+90)/dlat)*dlat-90; lat<=lat1; lat+=dlat){
    if(Math.abs(lat)>85) continue;
    const y=mercY(lat)*S-oy; cx.moveTo(0,y); cx.lineTo(W,y); }
  cx.stroke();
  if(n.p.grid==='maidenhead' && (lon1-lon0)/dlon<40){
    const len=dlon>=20?2:dlon>=2?4:6;
    cx.fillStyle='rgba(140,180,200,.45)'; cx.font='10px monospace';
    for(let lon=Math.floor((lon0+180)/dlon)*dlon-180; lon<lon1; lon+=dlon)
      for(let lat=Math.floor((lat0+90)/dlat)*dlat-90; lat<lat1; lat+=dlat){
        if(Math.abs(lat)>85) continue;
        const x=mercX(lon)*S-ox, y=mercY(lat+dlat)*S-oy;
        cx.fillText(latLonToGrid(lat+dlat/2,((lon+dlon/2+540)%360)-180,len).toUpperCase(),x+3,y+11);
      }
  }
}
// подписи с разрежением: ставим по приоритету, пропуская пересекающиеся
function geoLabelBox(boxes,x,y,w,h){
  for(const b of boxes) if(x<b[2] && x+w>b[0] && y<b[3] && y+h>b[1]) return false;
  boxes.push([x,y,x+w,y+h]); return true;
}
function geoDrawLabels(n,cx,v){
  const {W,H,S,ox,oy,z}=v, D=GeoBase.data, boxes=[];
  const k0=Math.floor(ox/S), k1=Math.floor((ox+W)/S);
  const each=(arr,fn)=>{
    for(const p of arr){
      const y=p.y*S-oy; if(y<-10 || y>H+10) continue;
      for(let k=k0;k<=k1;k++){ const x=p.x*S+k*S-ox; if(x<-40 || x>W+40) continue; fn(p,x,y); }
    }
  };
  cx.textBaseline='middle';
  cx.font='bold 11px sans-serif'; cx.fillStyle=geoCol().label;
  if(z<7) each(D.countryLabels,(p,x,y)=>{
    if(p.mz>z+1.5) return;
    const w=cx.measureText(p.name).width;
    if(geoLabelBox(boxes,x-w/2,y-7,w,14)) cx.fillText(p.name,x-w/2,y);
  });
  cx.font='10px sans-serif'; cx.fillStyle=geoCol().labelDim;
  if(z>=4) each(D.adm1Labels,(p,x,y)=>{
    if(p.mz>z+1) return;
    const w=cx.measureText(p.name).width;
    if(geoLabelBox(boxes,x-w/2,y-6,w,12)) cx.fillText(p.name,x-w/2,y);
  });
  let placed=0;
  const maxPl=Math.max(20,Math.round(W*H/7000));    // плотность подписей по площади
  const place=(name,x,y,big)=>{
    if(placed>=maxPl) return;
    cx.font=(big?'bold ':'')+'10px sans-serif';
    const w=cx.measureText(name).width;
    if(!geoLabelBox(boxes,x-12,y-12,w+30,24)) return;  // с полем — не впритык
    cx.fillStyle=geoCol().place;
    cx.fillRect(x-(big?2:1.5),y-(big?2:1.5),big?4:3,big?4:3);
    cx.fillText(name,x+5,y); placed++;
  };
  each(D.places,(p,x,y)=>{ if(p.mz<=z+.5) place(p.name,x,y,p.kind>0); });
  const P=GeoBase.places;
  if(P && z>=8){
    const lon0=unmercX(ox/S), lon1=unmercX((ox+W)/S);
    const lat1=unmercY(clamp(oy/S,0,1)), lat0=unmercY(clamp((oy+H)/S,0,1));
    if((lon1-lon0)*(lat1-lat0)<=64){
      for(let la=Math.floor(lat0);la<=Math.floor(lat1);la++)
        for(let lo=Math.floor(lon0);lo<=Math.floor(lon1);lo++){
          const lw=((lo+180)%360+360)%360;
          const cell=P.cells.get((la+90)*360+lw); if(!cell) continue;
          for(const i of cell){
            if(placed>=maxPl) break;
            const s=geoProj(v,P.lat[i],P.lon[i],(mercX(lo)*S-ox));
            if(s.x<-5 || s.x>W+5 || s.y<-5 || s.y>H+5) continue;
            place(P.name[i],s.x,s.y,false);
          }
        }
    }
  }
}

const GEO_ICONS=new Set(['dot','square','triangle','diamond','star','cross','plus','plane','antenna','tx','rx','me','flag','sat','balloon']);
function geoSnrColor(snr){                           // -20 дБ — красный … +20 дБ — зелёный
  const t=clamp((snr+20)/40,0,1);
  return `hsl(${Math.round(t*120)},80%,55%)`;
}
function geoEntColor(r,e){
  if(r.color) return String(r.color);
  const snr=recNum(r.snr); if(snr!=null) return geoSnrColor(snr);
  const rssi=recNum(r.rssi); if(rssi!=null) return geoSnrColor((rssi+100)/2);
  if(e.id!=null){ let h=0; for(const c of e.id) h=(h*31+c.charCodeAt(0))|0; return `hsl(${((h%360)+360)%360},70%,60%)`; }
  return themeColor('--acc')||'#e0b23c';
}
const GEO_ROT_ICONS=new Set(['plane','triangle','ship','car','truck','bus','train','tram','bike','moto','heli','drone','walk']);
function geoIcon(cx,icon,x,y,s,rot,col){
  cx.save(); cx.translate(x,y);
  cx.fillStyle=col; cx.strokeStyle=col; cx.lineWidth=1.5;
  const rotate=()=>{ if(rot!=null) cx.rotate(rot*D2R); };
  cx.beginPath();
  switch(icon){
    case 'square': cx.rect(-s*.8,-s*.8,s*1.6,s*1.6); cx.fill(); break;
    case 'diamond': cx.moveTo(0,-s); cx.lineTo(s,0); cx.lineTo(0,s); cx.lineTo(-s,0); cx.closePath(); cx.fill(); break;
    case 'triangle': rotate(); cx.moveTo(0,-s*1.2); cx.lineTo(s,s*.8); cx.lineTo(-s,s*.8); cx.closePath(); cx.fill(); break;
    case 'star':
      for(let i=0;i<10;i++){ const a=i*Math.PI/5-Math.PI/2, rr=i%2?s*.45:s*1.1; cx.lineTo(Math.cos(a)*rr,Math.sin(a)*rr); }
      cx.closePath(); cx.fill(); break;
    case 'cross': cx.moveTo(-s,-s); cx.lineTo(s,s); cx.moveTo(s,-s); cx.lineTo(-s,s); cx.lineWidth=2; cx.stroke(); break;
    case 'plus': cx.moveTo(-s,0); cx.lineTo(s,0); cx.moveTo(0,-s); cx.lineTo(0,s); cx.lineWidth=2; cx.stroke(); break;
    case 'plane':
      rotate(); s*=1.3;
      cx.moveTo(0,-s); cx.lineTo(s*.12,-s*.6); cx.lineTo(s*.12,-s*.2); cx.lineTo(s,s*.25); cx.lineTo(s,s*.4);
      cx.lineTo(s*.12,s*.15); cx.lineTo(s*.1,s*.7); cx.lineTo(s*.35,s*.9); cx.lineTo(s*.35,s);
      cx.lineTo(-s*.35,s); cx.lineTo(-s*.35,s*.9); cx.lineTo(-s*.1,s*.7); cx.lineTo(-s*.12,s*.15);
      cx.lineTo(-s,s*.4); cx.lineTo(-s,s*.25); cx.lineTo(-s*.12,-s*.2); cx.lineTo(-s*.12,-s*.6); cx.closePath();
      cx.fill(); cx.strokeStyle='rgba(0,0,0,.6)'; cx.lineWidth=.7; cx.stroke(); break;
    case 'ship':                                     // корпус носом по курсу
      rotate(); s*=1.2;
      cx.moveTo(0,-s*1.1); cx.lineTo(s*.55,-s*.3); cx.lineTo(s*.55,s*.9); cx.lineTo(-s*.55,s*.9); cx.lineTo(-s*.55,-s*.3); cx.closePath();
      cx.fill(); cx.strokeStyle='rgba(0,0,0,.6)'; cx.lineWidth=.7; cx.stroke(); break;
    case 'antenna':
      cx.moveTo(0,s); cx.lineTo(0,-s); cx.moveTo(-s*.7,-s); cx.lineTo(0,-s*.2); cx.lineTo(s*.7,-s); cx.stroke(); break;
    case 'tx':
      cx.moveTo(-s*.6,s); cx.lineTo(0,-s*.4); cx.lineTo(s*.6,s); cx.stroke();
      cx.beginPath(); cx.arc(0,-s*.4,s*.6,-Math.PI*.8,-Math.PI*.2); cx.stroke();
      cx.beginPath(); cx.arc(0,-s*.4,s*1.1,-Math.PI*.8,-Math.PI*.2); cx.stroke(); break;
    case 'rx': cx.arc(0,0,s,0,2*Math.PI); cx.stroke(); cx.beginPath(); cx.arc(0,0,s*.35,0,2*Math.PI); cx.fill(); break;
    case 'me':
      cx.arc(0,0,s,0,2*Math.PI); cx.stroke();
      cx.moveTo(-s*1.6,0); cx.lineTo(-s*.5,0); cx.moveTo(s*.5,0); cx.lineTo(s*1.6,0);
      cx.moveTo(0,-s*1.6); cx.lineTo(0,-s*.5); cx.moveTo(0,s*.5); cx.lineTo(0,s*1.6); cx.stroke();
      if(rot!=null){ cx.beginPath(); cx.rotate(rot*D2R); cx.moveTo(0,-s*2.4); cx.lineTo(s*.5,-s*1.5); cx.lineTo(-s*.5,-s*1.5); cx.closePath(); cx.fill(); }
      break;
    case 'flag': cx.moveTo(0,s); cx.lineTo(0,-s*1.2); cx.lineTo(s,-s*.8); cx.lineTo(0,-s*.4); cx.stroke(); cx.fill(); break;
    // транспорт: вид сверху, нос по курсу
    case 'car': case 'truck': case 'bus': case 'train': case 'tram': {
      rotate();
      const L=s*{car:1.1,truck:1.5,bus:1.5,train:1.9,tram:1.5}[icon], W=s*(icon==='car'?.55:.6), dk='rgba(0,0,0,.6)';
      if(icon==='truck'){ cx.fillRect(-W,-L,W*2,s*.7); cx.fillRect(-W,-L+s*.85,W*2,L*2-s*.85); }
      else { cx.roundRect(-W,-L,W*2,L*2,icon==='car'?s*.35:s*.2); cx.fill(); }
      cx.strokeStyle=dk; cx.lineWidth=.7; cx.stroke(); cx.fillStyle=dk;
      if(icon==='car') cx.fillRect(-W*.7,-L*.45,W*1.4,s*.5);
      else if(icon==='truck') cx.fillRect(-W*.7,-L*.85,W*1.4,s*.25);
      else for(let y=-L+s*.4;y<L-s*.3;y+=icon==='bus'?s*.55:s*.8) cx.fillRect(-W*.6,y,W*1.2,s*.28);
      break; }
    case 'bike': case 'moto':
      rotate(); cx.lineWidth=icon==='bike'?1.6:2.6; cx.moveTo(0,-s*1.1); cx.lineTo(0,s*1.1); cx.moveTo(-s*.55,-s*.5); cx.lineTo(s*.55,-s*.5); cx.stroke();
      if(icon==='moto'){ cx.beginPath(); cx.ellipse(0,s*.1,s*.3,s*.6,0,0,2*Math.PI); cx.fill(); } break;
    case 'heli':
      rotate(); cx.ellipse(0,0,s*.45,s*.8,0,0,2*Math.PI); cx.fill();
      cx.beginPath(); cx.moveTo(0,s*.6); cx.lineTo(0,s*1.4); cx.moveTo(-s*.4,s*1.4); cx.lineTo(s*.4,s*1.4);
      cx.moveTo(-s*1.2,-s*.2); cx.lineTo(s*1.2,-s*.2); cx.lineWidth=1.2; cx.stroke(); break;
    case 'drone':
      rotate(); cx.moveTo(-s,-s); cx.lineTo(s,s); cx.moveTo(s,-s); cx.lineTo(-s,s); cx.lineWidth=1.8; cx.stroke();
      cx.fillRect(-s*.35,-s*.35,s*.7,s*.7);
      for(const [dx,dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]){ cx.beginPath(); cx.arc(dx*s,dy*s,s*.38,0,2*Math.PI); cx.stroke(); }
      break;
    case 'walk':
      cx.arc(0,0,s*.55,0,2*Math.PI); cx.fill(); cx.strokeStyle='rgba(0,0,0,.6)'; cx.lineWidth=.8; cx.stroke();
      if(rot!=null){ cx.beginPath(); cx.rotate(rot*D2R); cx.moveTo(0,-s*1.5); cx.lineTo(s*.5,-s*.8); cx.lineTo(-s*.5,-s*.8); cx.closePath(); cx.fill(); }
      break;
    case 'sat':                                      // корпус и две панели
      cx.rotate(-Math.PI/4);
      cx.fillRect(-s*.35,-s*.35,s*.7,s*.7);
      cx.fillRect(-s*1.3,-s*.25,s*.8,s*.5); cx.fillRect(s*.5,-s*.25,s*.8,s*.5);
      cx.strokeStyle='rgba(0,0,0,.6)'; cx.lineWidth=.7; cx.strokeRect(-s*.35,-s*.35,s*.7,s*.7); break;
    case 'balloon':                                  // шар, стропа, зонд
      cx.arc(0,-s*.45,s*.75,0,2*Math.PI); cx.fill();
      cx.beginPath(); cx.moveTo(0,s*.3); cx.lineTo(0,s*.9); cx.stroke();
      cx.fillRect(-s*.25,s*.9,s*.5,s*.4); break;
    case 'dot':
      cx.arc(0,0,s*.8,0,2*Math.PI); cx.fill(); cx.strokeStyle='rgba(0,0,0,.6)'; cx.lineWidth=1; cx.stroke(); break;
    default:                                         // любой короткий текст/эмодзи как значок, на подложке
      cx.arc(0,0,s*1.5,0,2*Math.PI); cx.fillStyle=themeRgba('--screen',.85); cx.fill(); cx.lineWidth=1.5; cx.stroke();
      cx.fillStyle=col; cx.font='bold '+Math.round(s*2.1)+'px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillText(String(icon).slice(0,4),0,s*.1);
  }
  cx.restore();
}
// линия по большому кругу из точки: азимут/дальность или до второй точки
function geoRings(x){                                // "1,5,10" или число, км
  const a=Array.isArray(x) ? x : typeof x==='string' ? x.split(/[,;\s]+/) : x!=null ? [x] : [];
  return a.map(Number).filter(k=>k>0 && isFinite(k)).sort((p,q)=>p-q).slice(0,12);
}
function geoCircleKm(cx,v,c,km,refX){
  let px=null;
  for(let i=0;i<=72;i++){
    const q=geoDest(c.lat,c.lon,i*5,km), p=geoProj(v,q.lat,q.lon,px??refX);
    if(px==null) cx.moveTo(p.x,p.y); else cx.lineTo(p.x,p.y); px=p.x;
  }
}
function geoGreatCircle(cx,v,lat,lon,brg,km,refX){
  const N=Math.max(8,Math.min(96,Math.ceil(km/100)));
  let prev=null;
  for(let i=0;i<=N;i++){
    const p=geoDest(lat,lon,brg,km*i/N), s=geoProj(v,p.lat,p.lon,prev?prev.x:refX);
    if(!prev) cx.moveTo(s.x,s.y); else cx.lineTo(s.x,s.y);
    prev=s;
  }
}
// кластеры в мировых координатах на целом уровне зума: при панораме не пересчитываются и не прыгают
function geoClusters(n,z){
  const on=n.p.cluster && z<14, zi=Math.floor(z);
  const key=on ? n.dirtyGen+'|'+zi+'|'+n.selKey+'|'+n.ents.size : 'off';
  if(n._clKey===key) return n._cl;
  n._clKey=key;
  const out={groups:[], member:new Set()};
  if(on){
    const P=256*2**zi, R=44, grid=new Map(), all=[];
    for(const e of n.ents.values()){
      const p=e.pts[e.pts.length-1]; if(!p || e.key===n.selKey) continue;   // выбранный — всегда отдельно
      const x=mercX(p.lon)*P, y=mercY(p.lat)*P, gx=Math.floor(x/R), gy=Math.floor(y/R);
      let c=null;
      for(let i=-1;i<=1 && !c;i++) for(let j=-1;j<=1 && !c;j++)
        for(const q of grid.get((gx+i)+','+(gy+j))||[]) if(Math.abs(q.x-x)<R && Math.abs(q.y-y)<R){ c=q; break; }
      if(!c){ c={x,y,sx:0,sy:0,e:[]}; const k=gx+','+gy; (grid.get(k)||grid.set(k,[]).get(k)).push(c); all.push(c); }
      c.sx+=x; c.sy+=y; c.e.push(e);
    }
    for(const c of all){
      const k=c.e.length; if(k<2) continue;
      const col0=geoEntColor(c.e[0].rec,c.e[0]);
      out.groups.push({mx:c.sx/k/P, my:c.sy/k/P, r:10+Math.min(10,Math.log2(k)*2.5), t:k>999 ? Math.round(k/1000)+'k' : String(k),
        col:c.e.every(e=>geoEntColor(e.rec,e)===col0) ? col0 : '#9fb0b8'});
      for(const e of c.e) out.member.add(e.key);
    }
  }
  return n._cl=out;
}
function geoDrawObjects(n,cx,v){
  const {W,H,S}=v, now=Date.now(), ttl=n.p.ttl*60000;
  const mpp=lat=>40075016.686*Math.cos(lat*D2R)/S;   // метров в пикселе
  cx.save(); cx.lineJoin='round';
  geoDrawLinks(n,cx,v);
  const labs=[], marks=[], C=geoClusters(n,v.z);
  for(const e of n.ents.values()){
    const r=e.rec, last=e.pts[e.pts.length-1]; if(!last) continue;
    const col=geoEntColor(r,e);
    const age=ttl>0 ? clamp((now-e.seen)/ttl,0,1) : 0;
    cx.globalAlpha=1-age*0.7;
    const s=geoProj(v,last.lat,last.lon);
    const vis=s.x>-400 && s.x<W+400 && s.y>-400 && s.y<H+400;
    if(e.pts.length>1){                              // трек
      cx.strokeStyle=col; cx.lineWidth=1.5; cx.beginPath();
      let px=null;
      for(let i=e.pts.length-1;i>=0;i--){
        const p=geoProj(v,e.pts[i].lat,e.pts[i].lon,px??s.x);
        if(px==null) cx.moveTo(p.x,p.y); else cx.lineTo(p.x,p.y);
        px=p.x;
      }
      cx.stroke();
    }
    if(e.grid && e.grid.w<=2){                       // квадрат локатора
      const a=geoProj(v,last.lat+e.grid.h/2,last.lon-e.grid.w/2,s.x), b=geoProj(v,last.lat-e.grid.h/2,last.lon+e.grid.w/2,s.x);
      if(b.x-a.x>6){ cx.strokeStyle=col; cx.lineWidth=1; cx.globalAlpha*=.6; cx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y); cx.globalAlpha=1-age*0.7; }
    }
    const rad=recNum(r.radius);
    if(rad!=null && rad>0){
      const rp=rad/mpp(last.lat);
      if(rp>2 && rp<1e5){ cx.strokeStyle=col; cx.lineWidth=1; cx.setLineDash([4,3]); cx.beginPath();
        if(rad>300000){                              // большой круг в Меркаторе — не окружность
          let px=null;
          for(let i=0;i<=72;i++){
            const q=geoDest(last.lat,last.lon,i*5,rad/1000), p=geoProj(v,q.lat,q.lon,px??s.x);
            if(px==null) cx.moveTo(p.x,p.y); else cx.lineTo(p.x,p.y); px=p.x;
          }
        } else cx.arc(s.x,s.y,rp,0,2*Math.PI);
        cx.stroke(); cx.setLineDash([]);
        cx.fillStyle=col; cx.globalAlpha*=.08; cx.fill(); cx.globalAlpha=1-age*0.7; }
    }
    const rings=geoRings(r.rings);
    if(rings.length){                                // кольца расстояния: км от объекта
      cx.strokeStyle=col; cx.lineWidth=1; cx.setLineDash([2,4]); cx.globalAlpha*=.7;
      for(const km of rings){
        cx.beginPath(); geoCircleKm(cx,v,last,km,s.x); cx.stroke();
        if(n.p.labels){
          const q=geoDest(last.lat,last.lon,0,km), lp=geoProj(v,q.lat,q.lon,s.x);
          cx.save(); cx.setLineDash([]); cx.font='9px sans-serif'; cx.textAlign='center'; cx.fillStyle=col; cx.fillText(km+' km',lp.x,lp.y-2); cx.restore();
        }
      }
      cx.setLineDash([]); cx.globalAlpha=1-age*0.7;
    }
    const gm=geoParseGeom(r.geom);
    if(gm && gm.length>1) geoDrawShape(n,cx,v,gm,String(r.gtype||'line'),col,s.x,e.key===n.selKey?3:2,e.key===n.selKey);
    if(n.p.mode==='edit' && e.key===n.selKey && geoEditable(n,e)) geoDrawHandles(n,cx,v,e,col);
    const fov=recNum(r.fov);
    if(fov>0){                                       // поле зрения: сектор вокруг курса / азимута
      let hd=recNum(r.heading ?? r.course ?? r.azimuth ?? r.bearing);
      if(hd==null && e.pts.length>1){ const p0=e.pts[e.pts.length-2]; hd=geoBearing(p0.lat,p0.lon,last.lat,last.lon); }
      if(hd!=null){
        const km=recNum(r.fov_range) ?? recNum(r.range) ?? (rings.length ? rings[rings.length-1] : n.p.rayKm);
        const w=Math.min(fov,360), N=Math.max(6,Math.ceil(w/5));
        cx.beginPath(); cx.moveTo(s.x,s.y);
        let px=s.x;
        for(let i=0;i<=N;i++){
          const q=geoDest(last.lat,last.lon,hd-w/2+w*i/N,km), p=geoProj(v,q.lat,q.lon,px); cx.lineTo(p.x,p.y); px=p.x;
        }
        if(w<360) cx.closePath();
        cx.fillStyle=cx.strokeStyle=col; cx.lineWidth=1; cx.globalAlpha*=.18; cx.fill(); cx.globalAlpha=1-age*0.7; cx.stroke();
      }
    }
    let pth=Array.isArray(r.path) ? r.path : r.path3;
    if(typeof pth==='string' && pth[0]==='['){ try{ pth=JSON.parse(pth); }catch(e){ pth=null; } }          // path3 — ломаная связи (путь сигнала с отражением): [[lat,lon,alt],…]
    if(Array.isArray(pth) && pth.length>1){           // путь вперёд (трасса спутника и т.п.): [[lat,lon],…]
      cx.strokeStyle=col; cx.lineWidth=1.2; cx.setLineDash(r.path3 ? [] : [2,4]); cx.beginPath();
      let px=null, py=null;
      for(const q of pth){
        const p=geoProj(v,q[0],q[1],px??s.x);
        if(px==null || Math.abs(p.x-px)>v.S/2) cx.moveTo(p.x,p.y); else cx.lineTo(p.x,p.y);
        px=p.x; py=p.y;
      }
      cx.stroke(); cx.setLineDash([]);
    }
    const az=recNum(r.azimuth ?? r.bearing);
    if(az!=null){
      const km=recNum(r.range) ?? n.p.rayKm;
      cx.strokeStyle=col; cx.lineWidth=1.5; cx.setLineDash([6,4]); cx.beginPath();
      geoGreatCircle(cx,v,last.lat,last.lon,az,km,s.x); cx.stroke(); cx.setLineDash([]);
    }
    const lat2=recNum(r.lat2), lon2=recNum(r.lon2);
    if(lat2!=null && lon2!=null){
      const km=geoDist(last.lat,last.lon,lat2,lon2);
      cx.strokeStyle=col; cx.lineWidth=1; cx.beginPath();
      geoGreatCircle(cx,v,last.lat,last.lon,geoBearing(last.lat,last.lon,lat2,lon2),km,s.x); cx.stroke();
    }
    if(!vis || C.member.has(e.key)) continue;
    let icon=r.icon!=null && r.icon!=='' ? String(r.icon) : 'dot';
    const size=(recNum(r.size) ?? 6)*(+n.p.iconScale||1);
    let rot=recNum(r.heading ?? r.course ?? r.track);
    if(rot==null && GEO_ROT_ICONS.has(icon) && e.pts.length>1){
      const p0=e.pts[e.pts.length-2]; rot=geoBearing(p0.lat,p0.lon,last.lat,last.lon);
    }
    marks.push({x:s.x,y:s.y,icon,size,rot,col,a:cx.globalAlpha,sel:n.selKey===e.key,lab:r.label ?? e.id,age,chk:recNum(r.check_total)>0 ? [recNum(r.check_done)||0,recNum(r.check_total)] : null});
  }
  for(const m of marks){
    cx.globalAlpha=m.a;
    geoIcon(cx,m.icon,m.x,m.y,m.size,m.rot,m.col);
    if(m.chk){                                       // чеклист записи: «сделано/всего», зелёный — всё сделано
      const t=m.chk[0]+'/'+m.chk[1], full=m.chk[0]>=m.chk[1];
      const fs=Math.max(11,Math.round(m.size*1.3));
      cx.save(); cx.font='bold '+fs+'px sans-serif'; cx.textAlign='left'; cx.textBaseline='middle';
      const w=cx.measureText('☑ '+t).width+8, h=fs+4, bx=m.x+m.size*.7, by=m.y-m.size*1.6-h/2;
      cx.fillStyle=full ? '#2e9e44' : '#c4851a'; cx.strokeStyle='rgba(0,0,0,.55)'; cx.lineWidth=1;
      cx.beginPath(); cx.roundRect(bx,by-h/2,w,h,h/2); cx.fill(); cx.stroke();
      cx.fillStyle='#fff'; cx.fillText('☑ '+t,bx+4,by+.5); cx.restore();
    }
    if(m.sel){
      cx.strokeStyle=themeColor('--scr-hi')||'#fff'; cx.lineWidth=1.5;
      cx.beginPath(); cx.arc(m.x,m.y,m.size+5,0,2*Math.PI); cx.stroke();
    }
    if(n.p.labels && (n.ents.size<=300 || v.z>=7) && m.lab!=null && m.lab!=='')  // тысячи подписей на обзоре — каша
      labs.push({t:String(m.lab),x:m.x,y:m.y,size:m.size,col:m.col,a:m.a,pri:(m.sel?1e3:0)+m.size-m.age});
  }
  n.clusters=[];
  cx.globalAlpha=1; cx.font='bold 11px sans-serif'; cx.textAlign='center'; cx.textBaseline='middle'; cx.lineWidth=2;
  for(const c of C.groups){
    let x=c.mx*S-v.ox; x-=Math.round((x-W/2)/S)*S;
    const y=c.my*S-v.oy;
    if(x<-30 || x>W+30 || y<-30 || y>H+30) continue;
    cx.beginPath(); cx.arc(x,y,c.r,0,2*Math.PI);
    cx.fillStyle=themeRgba('--screen',.85); cx.fill(); cx.strokeStyle=c.col; cx.stroke();
    cx.fillStyle=c.col; cx.fillText(c.t,x,y+.5);
    n.clusters.push({x,y,r:c.r});
  }
  cx.globalAlpha=1;
  // подписи после значков, без наложений: важные первыми, 4 позиции вокруг точки
  labs.sort((a,b)=>b.pri-a.pri);
  cx.font='11px monospace'; cx.textBaseline='middle'; cx.textAlign='left'; cx.lineWidth=3; cx.strokeStyle=themeRgba('--screen',.8);
  const boxes=[];
  for(const L of labs){
    const w=cx.measureText(L.t).width, d=L.size+4;
    for(const [x,y] of [[L.x+d,L.y-L.size],[L.x+d,L.y+L.size],[L.x-d-w,L.y-L.size],[L.x-d-w,L.y+L.size]]){
      if(!geoLabelBox(boxes,x-1,y-7,w+2,14)) continue;
      cx.globalAlpha=L.a; cx.strokeText(L.t,x,y); cx.fillStyle=L.col; cx.fillText(L.t,x,y);
      break;
    }
  }
  cx.restore();
}
function geoDrawOverlay(n,cx,v){
  const {W,H,S,z}=v;
  cx.save();
  cx.font='10px monospace'; cx.textBaseline='alphabetic'; cx.textAlign='left';
  const box=(lines,x,y,alignRight)=>{
    const w=Math.max(...lines.map(l=>cx.measureText(l).width))+10, h=lines.length*13+6;
    const bx=alignRight ? x-w : x, by=y;
    cx.fillStyle=themeRgba('--screen',.82); cx.fillRect(bx,by,w,h);
    cx.fillStyle=themeColor('--scr-txt'); lines.forEach((l,i)=>cx.fillText(l,bx+5,by+14+i*13));
  };
  // масштабная линейка
  const mpp=40075016.686*Math.cos(n.p.mlat*D2R)/S, target=mpp*90;
  const steps=[1,2,5]; let len=1;
  for(let p=1;p<1e8;p*=10) for(const s of steps) if(s*p<=target) len=s*p;
  const px=len/mpp;
  cx.strokeStyle=themeColor('--scr-txt'); cx.lineWidth=1.5; cx.beginPath();
  cx.moveTo(8,H-10); cx.lineTo(8+px,H-10); cx.moveTo(8,H-14); cx.lineTo(8,H-6); cx.moveTo(8+px,H-14); cx.lineTo(8+px,H-6); cx.stroke();
  cx.fillStyle=themeColor('--scr-txt'); cx.fillText(len>=1000 ? len/1000+' km' : len+' m',12+px,H-6);
  // статус
  const st=[];
  if(GeoBase.state!=='ready') st.push('base map: '+GeoBase.state+(GeoBase.err?' — '+GeoBase.err:''));
  if(GeoBase.placesState && !/^\d+ places$/.test(GeoBase.placesState)) st.push('places: '+GeoBase.placesState);
  if(n.vmsg) st.push(n.vmsg);
  st.push('z '+z.toFixed(1)+' · objects '+n.ents.size);
  cx.fillStyle='rgba(200,210,214,.7)'; st.forEach((l,i)=>cx.fillText(l,6,13+i*12));
  // атрибуция
  const ts=geoSrc(n,'tiles'), os=geoSrc(n,'overlay');
  const attr=[ts ? ts.attr : 'Natural Earth', os && os.attr].filter(Boolean).join(' · ');
  cx.textAlign='right'; cx.fillStyle='rgba(200,210,214,.55)'; cx.fillText(attr,W-4,H-4); cx.textAlign='left';
  // выбранный объект / точка под пальцем
  const e=n.selKey && n.ents.get(n.selKey);
  if(e){
    const p=e.pts[e.pts.length-1];
    const cut=Math.max(16,Math.floor((W*.4-10)/6)), skip=new Set(['path','id','icon','color','size','lat','lon','approx','check_list','check_via','check_col','check_key','check_done','check_total']);
    for(const k in e.rec) if(/_(done|total)$/.test(k)) skip.add(k);
    const lines=[...recText(e.rec,skip).split('\n').slice(0,8).map(l=>l.length>cut ? l.slice(0,cut-1)+'…' : l),
      p.lat.toFixed(4)+', '+p.lon.toFixed(4)+' '+latLonToGrid(p.lat,p.lon,6),
      'seen '+Math.round((Date.now()-e.seen)/1000)+' s ago'+(e.pts.length>1?' · track '+e.pts.length:'')];
    box(lines,W-6,6,true);
  } else if(n.info && Date.now()-n.info.t<8000){
    const g=n.info.ground;
    box([n.info.lat.toFixed(5)+', '+n.info.lon.toFixed(5), latLonToGrid(n.info.lat,n.info.lon,6),
      g===undefined ? 'ground: …' : g===null ? 'ground: no data' : 'ground: '+Math.round(g)+' m'],W-6,6,true);
  }
  cx.restore();
}
defGroups('geoMap',[
  {n:'Edit', p:'mode tools addName addIcon drawColor'},
  {n:'Display', p:'ttl tiles overlay ovAlpha iconScale grid labels cluster follow net'},
  {n:'Data layers', p:'vfile vclr osmKind osmGo'},
  {n:'Tracks', p:'trail maxEnt arrows rayKm', open:false},
  {n:'Export', p:'store csv geojson kml gpx', open:false},
  {n:'Custom tiles', p:'tileUrl tileUrl2', open:false},
  {n:'Places', p:'places placesFile', open:false}]);
