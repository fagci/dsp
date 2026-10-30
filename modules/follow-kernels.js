"use strict";
/* ============================ Follow Detector — ядро ============================
   Устройство (BLE / Bluetooth / Wi-Fi), которое видно в нескольких разных местах вашего маршрута и достаточно долго, — вероятно «едет с вами».
   Каждое наблюдение — id устройства + ваша позиция. «Место» — точка маршрута не ближе sep метров от прежних мест того же устройства.
   Подозрительным устройство становится, когда мест ≥ places, а с первого наблюдения прошло ≥ mins минут (и вы отошли от первой точки ≥ dist м).
   Проверяется в tools/test-follow.mjs; расстояние — gfDist из geofence-kernels.js. */

function flNew(){ return {dev:new Map(), alerts:0}; }
// наблюдение: o={id,label,lat,lon,t,rssi}; cfg={places,mins,sep,dist,ttl}; → {dev, fresh:true, newly:true когда только что стало подозрительным}
function flSee(st,o,cfg){
  if(!o || o.id==null || o.id==='' || !isFinite(o.lat) || !isFinite(o.lon)) return null;
  const id=String(o.id);
  let d=st.dev.get(id);
  if(!d){ d={id,label:'',first:o.t,last:o.t,n:0,places:[],sus:false,rssi:null,maxD:0}; st.dev.set(id,d); }
  if(o.label) d.label=String(o.label);
  d.last=o.t; d.n++; d.rssi=o.rssi==null ? d.rssi : o.rssi;
  const sep=Math.max(1,+cfg.sep||150);
  let near=null;
  for(const p of d.places) if(gfDist(p.lat,p.lon,o.lat,o.lon)<sep){ near=p; break; }
  if(near){ near.t=o.t; near.n++; }
  else{ d.places.push({lat:o.lat,lon:o.lon,t:o.t,n:1}); if(d.places.length>40) d.places.shift(); }
  const f=d.places[0];
  d.maxD=Math.max(d.maxD,gfDist(f.lat,f.lon,o.lat,o.lon));
  let newly=false;
  if(!d.sus && d.places.length>=(+cfg.places||3) && o.t-d.first>=(+cfg.mins||5)*60 && d.maxD>=(+cfg.dist||300)){ d.sus=true; newly=true; st.alerts++; }
  d.lat=o.lat; d.lon=o.lon;
  return {dev:d,newly};
}
// забыть устройства, которых не видно дольше ttl минут (кроме подозрительных, их помним вдвое дольше)
function flPrune(st,now,ttlMin){
  const ttl=Math.max(1,+ttlMin||30)*60;
  for(const [k,d] of st.dev) if(now-d.last>ttl*(d.sus?2:1)) st.dev.delete(k);
}
// строки для Table: по устройству
function flRows(st,now){
  return [...st.dev.values()].sort((a,b)=>(b.sus-a.sus)||(b.places.length-a.places.length)).map(d=>({
    id:d.id, name:d.label||d.id, status:d.sus ? 'FOLLOWING' : d.places.length>1 ? 'watch' : 'seen',
    places:d.places.length, seen:d.n, mins:Math.round((d.last-d.first)/6)/10, away_m:Math.round(d.maxD), ago_s:Math.round(now-d.last), rssi:d.rssi==null ? '' : d.rssi}));
}
// точки для Map: каждое «место» подозрительных и наблюдаемых устройств; последняя точка — движущаяся (устройство сейчас с вами)
function flPoints(st){
  const out=[];
  for(const d of st.dev.values()){
    if(d.places.length<2) continue;
    const col=d.sus ? '#e05555' : '#e8a200', name=d.label||d.id;
    d.places.forEach((p,i)=>out.push({id:d.id+'#'+i,type:'follow',lat:p.lat,lon:p.lon,label:i===d.places.length-1 ? name+' ×'+d.places.length : '',color:col,shape:i===d.places.length-1 ? 'triangle' : 'dot'}));
  }
  return out;
}
