"use strict";
/* ============================ Geofence ============================
   Зоны (круги / многоугольники) из текста, из карты (Map → edit rec) или из списка Table (rec со столбцами name/gtype/lat/lon/radius/geom);
   вход — позиция (rec с lat/lon, или числа lat/lon/acc). Выходы: события входа/выхода (с гистерезисом и задержкой — flow-kernels не нужен,
   это сразу решает geofence-kernels), расстояние до ближайшей границы, список зон внутри которых мы сейчас, и зоны как rec для Map.
   Ядро — modules/geofence-kernels.js, проверяется в tools/test-geofence.mjs. */

function gfApply(n){
  const {zones,errors}=gfParseZones(n.p.zones);
  n.zones=zones; n.zoneErr=errors;
}
def({ id:'geofence', title:'Geofence', cat:'Geo', kw:'geofence zone circle polygon enter exit alert perimeter fence area trigger automation',
  ins:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'zones',t:'rec'}],
  outs:[{n:'events',t:'rec'},{n:'shapes',t:'rec'},{n:'enter',t:'num'},{n:'exit',t:'num'},{n:'in',t:'num'},{n:'dist',t:'num'},{n:'nearest',t:'txt'},{n:'inside',t:'txt'}],
  readout:true, tall:true,
  params:[
    {n:'zones',t:'code',plain:true,d:'Home: circle 55.7558 37.6173 200\nWork: poly 55.76,37.60 55.76,37.64 55.74,37.64 55.74,37.60',
     label:'zones: name: circle lat lon radius_m  |  name: poly lat,lon lat,lon …  (or a JSON array; «zones» input adds more from a Table / Map)'},
    {n:'hyst',t:'range',min:0,max:200,step:1,d:15,label:'hysteresis, m (ignore crossings this close to the edge)'},
    {n:'dwell',t:'range',min:0,max:300,step:1,d:0,label:'confirm after, s (0 — immediately)'},
    {n:'accMax',t:'range',min:0,max:500,step:5,d:100,label:'ignore fixes less accurate than, m (0 — don\'t check)'},
    {n:'first',t:'check',d:false,label:'report a zone already entered on the first fix'},
    {n:'idle',t:'range',min:0,max:60,step:1,d:5,label:'recompute at least every, s (0 — only on a new position)'},
  ],
  init:n=>{ n.st={}; n.zones=[]; n.zoneErr=[]; n.zonesExtra=new Map(); n.lastZonesP=null; n.lastT=0; n.lastLL=''; n.lastRes=null; n.evQ=[]; n.lastShapes=null; n.shapesGen=0;
            n.curLat=null; n.curLon=null; n.curAcc=null; },
  process(n,I){
    if(n.p.zones!==n.lastZonesP){ n.lastZonesP=n.p.zones; gfApply(n); }
    if(Array.isArray(I.zones)){
      for(const r of I.zones){ const z=gfZoneFromRec(r); if(z) n.zonesExtra.set(z.name,z); }
    }
    const all=n.zonesExtra.size ? [...n.zones,...n.zonesExtra.values()] : n.zones;
    let lat=recNum(I.lat), lon=recNum(I.lon), acc=recNum(I.acc), fresh=lat!=null && lon!=null, t=Date.now();
    if(!fresh){
      const r=I.rec && (Array.isArray(I.rec) ? I.rec[I.rec.length-1] : I.rec);
      const p=r && geoRecPos(r);
      if(p){ lat=p.lat; lon=p.lon; acc=acc ?? recNum(r.acc); fresh=true; }
    }
    // «rec» на входе — пульс (одна запись на новый фикс), а не постоянный уровень: без своего кэша idle-пересчёт
    // (и подтверждение после задержки) никогда бы не сработал — lat/lon обнулялись бы на следующем же такте.
    if(fresh){ n.curLat=lat; n.curLon=lon; n.curAcc=acc; } else { lat=n.curLat; lon=n.curLon; acc=n.curAcc; }
    const ll=lat+','+lon;
    const idle=+n.p.idle>0 ? t-n.lastT>=n.p.idle*1000 : false;
    let res=n.lastRes;
    if(lat!=null && lon!=null && (ll!==n.lastLL || idle)){
      n.lastLL=ll; n.lastT=t;
      res=gfStep(n.st,all,lat,lon,t,{hyst:+n.p.hyst,dwell:+n.p.dwell,accMax:+n.p.accMax,acc,first:n.p.first});
      n.lastRes=res;
      if(res.events.length){ n.evQ.push(...res.events.map(e=>({t,...e}))); if(n.evQ.length>2000) n.evQ.splice(0,n.evQ.length-2000); n.shapesGen++; }
    }
    if(n.shapesGen!==n.lastShapesGen){ n.lastShapesGen=n.shapesGen; n.lastShapes=gfShapes(all,res?res.inside:[]); }
    else if(!n.lastShapes && all.length) n.lastShapes=gfShapes(all,res?res.inside:[]);
    const events=n.evQ.length ? n.evQ.splice(0) : null;
    const enter=events ? events.filter(e=>e.ev==='enter').length>0 ? 1 : 0 : 0;
    const exit=events ? events.filter(e=>e.ev==='exit').length>0 ? 1 : 0 : 0;
    return {events, shapes:n.lastShapes, enter, exit, in:res && res.inside.length ? 1 : 0,
            dist:res ? res.dist : null, nearest:res ? res.nearest : null, inside:res ? res.inside.join(', ') : ''};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const all=n.zonesExtra.size ? n.zones.length+n.zonesExtra.size : n.zones.length;
    let t=all+' zone'+(all===1?'':'s');
    if(n.zoneErr.length) t+='\n⚠ '+n.zoneErr[0]+(n.zoneErr.length>1 ? ' (+'+(n.zoneErr.length-1)+')' : '');
    if(n.lastRes){ t+='\ninside: '+(n.lastRes.inside.join(', ')||'—'); if(n.lastRes.nearest) t+='\nnearest: '+n.lastRes.nearest+' '+geoFmtDist(Math.abs(n.lastRes.dist)/1000)+(n.lastRes.dist<0?' inside':' away'); }
    if(r.textContent!==t) r.textContent=t; }
});
