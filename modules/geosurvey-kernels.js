// Ядро слоя «съёмка» карты: замеры уровня по устройствам (таблица rssi-by-device) → трек, устройства, фильтр, цвет по уровню.
// Без DOM: node tools/test-geosurvey.mjs
const SV_TECH=['wifi','ble','bt','cell'];
const svNum=v=>{ if(v==null || v==='') return null; const x=+v; return isFinite(x) ? x : null; };
const svTech=r=>{ const s=String(r.src||'').toLowerCase(); if(SV_TECH.includes(s)) return s; const d=String(r.dev||''); const k=d.slice(0,d.indexOf(':')); return SV_TECH.includes(k) ? k : (k||'?'); };
const svDist=(q,lat,lon)=>Math.hypot(111320*(lat-q.lat),111320*Math.cos(lat*Math.PI/180)*(lon-q.lon));   // м, на малых расстояниях
// rows — записи с dev, lat, lon, rssi (+ t, acc, name, ssid, ch…). Возвращает {track, devs:Map, n, tech:{wifi:n,…}}
function svIngest(rows,opt){
  const maxAcc=svNum(opt?.maxAcc) ?? 30;
  const devs=new Map(), track=[], tech={};
  let n=0, bad=0, lastKey='';
  const list=Array.isArray(rows) ? rows.slice() : [];
  list.sort((a,b)=>(svNum(a?.t) ?? 0)-(svNum(b?.t) ?? 0));
  for(const r of list){
    if(!r) continue;
    const lat=svNum(r.lat), lon=svNum(r.lon);
    if(lat==null || lon==null || (lat===0 && lon===0)){ bad++; continue; }
    const t=svNum(r.t) ?? 0, acc=svNum(r.acc);
    if(acc==null || acc<=maxAcc){                                  // трек — только хорошие фиксы, без повторов и без скачков GPS
      const k=lat+','+lon, q=track[track.length-1];
      if(k!==lastKey && !(q && t-q.t<=30000 && svDist(q,lat,lon)>12*Math.max(1,(t-q.t)/1000))){ lastKey=k; track.push({lat,lon,t,acc}); }
    }
    const dev=String(r.dev ?? ''), rssi=svNum(r.rssi);
    if(!dev || rssi==null){ bad++; continue; }
    let d=devs.get(dev);
    if(!d){ d={dev, src:svTech(r), name:'', ssid:'', ch:null, band:null, type:'', mfr:'', pts:[], best:-1e9, bestAt:-1}; devs.set(dev,d); tech[d.src]=(tech[d.src]||0)+1; }
    const nm=r.ssid || r.name; if(nm && !d.name) d.name=String(nm);
    if(r.ssid && !d.ssid) d.ssid=String(r.ssid);
    if(d.ch==null) d.ch=svNum(r.ch);
    if(d.band==null && r.band!=null && r.band!=='') d.band=r.band;
    if(!d.type && r.type) d.type=String(r.type);
    if(!d.mfr){ const m=r.wpsMfr || r.mfr; if(m) d.mfr=String(m); }
    d.pts.push({lat,lon,rssi,t,acc});
    if(rssi>d.best){ d.best=rssi; d.bestAt=d.pts.length-1; }
    n++;
  }
  return {track, devs, n, bad, tech};
}
// фильтр: технологии (Set; пусто — все), поиск по подстроке (имя, ssid, dev, производитель), минимум замеров, минимум уровня
function svMatch(d,f){
  if(f.tech && f.tech.size && !f.tech.has(d.src)) return false;
  if(f.minPts>0 && d.pts.length<f.minPts) return false;
  if(f.minRssi!=null && f.minRssi>-200 && d.best<f.minRssi) return false;
  const q=String(f.q||'').trim().toLowerCase();
  if(q){ const h=(d.dev+' '+d.name+' '+d.ssid+' '+d.mfr+' '+d.type+(d.ch!=null?' ch'+d.ch:'')).toLowerCase(); for(const w of q.split(/\s+/)) if(!h.includes(w)) return false; }
  return true;
}
const SV_SORT={
  best:(a,b)=>b.best-a.best,
  points:(a,b)=>b.pts.length-a.pts.length || b.best-a.best,
  name:(a,b)=>(a.name||a.dev).localeCompare(b.name||b.dev)};
function svList(S,f,sort){
  const out=[]; if(S) for(const d of S.devs.values()) if(svMatch(d,f||{})) out.push(d);
  return out.sort(SV_SORT[sort]||SV_SORT.best);
}
// уровень → цвет: слабый (-100) синий … сильный (-40) красный
function svColor(rssi,lo=-100,hi=-40){
  const x=Math.max(0,Math.min(1,(rssi-lo)/(hi-lo))), h=240-240*x;
  return 'hsl('+Math.round(h)+',85%,'+(45+Math.round(10*(1-Math.abs(x-.5)*2)))+'%)';
}
// охват замеров устройства, м (по диагонали рамки): мало охвата — оценка положения ненадёжна
function svSpread(d){
  if(!d || d.pts.length<2) return 0;
  let a=1e9,b=-1e9,c=1e9,e=-1e9;
  for(const p of d.pts){ if(p.lat<a) a=p.lat; if(p.lat>b) b=p.lat; if(p.lon<c) c=p.lon; if(p.lon>e) e=p.lon; }
  const my=111320*(b-a), mx=111320*Math.cos((a+b)/2*Math.PI/180)*(e-c);
  return Math.hypot(mx,my);
}
