"use strict";
/* ============================ Geotag ============================
   Приклеивает позицию к чему угодно: к записям (вход rec — пакеты, замеры, находки декодеров) и к числу (вход in — уровень SDR, температура, что угодно:
   раз в «every» секунд получается запись {t, <field>: значение, …}). Позиция берётся ПО ВРЕМЕНИ записи (у записи есть t — по нему, иначе по приходу):
   между двумя фиксами — линейно, так что запись, пришедшая с задержкой декодера, всё равно попадает в точку, где её приняли.
   Откуда позиция: записи с lat / lon на входе pos (Phone Sensors, Mock GPS, GPS-узлы), числа на lat / lon (acc, alt), а если ничего не подключено — GPS этого
   устройства (own). На выходе rec — та же запись + lat, lon, acc, alt, speed, gage (возраст фикса, с), gfix (interp / last / first) — сразу в Map (rec), Table → Map
   «съёмка» (meas: dev, lat, lon, rssi), Source Locator. Шаг step (м) и dt (с) прореживают: не чаще, чем ушли / прошло. Ядро — geotag-kernels.js (tools/test-geotag.mjs). */

function gtOwnStop(n){ if(n.watch!=null && typeof navigator!=='undefined' && navigator.geolocation){ try{ navigator.geolocation.clearWatch(n.watch); }catch(e){} } n.watch=null; }
function gtOwnStart(n){
  if(n.watch!=null || typeof navigator==='undefined' || !navigator.geolocation){ if(!navigator.geolocation) n.err='this device has no geolocation'; return; }
  try{
    n.watch=navigator.geolocation.watchPosition(p=>{
      n.err=''; const c=p.coords;
      gtPush(n.trk,{lat:c.latitude,lon:c.longitude,acc:c.accuracy,alt:c.altitude,speed:c.speed,t:p.timestamp||Date.now()});
    },e=>{ n.err='own GPS: '+(e&&e.message||e); },{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  }catch(e){ n.err='own GPS: '+(e&&e.message||e); }
}

def({ id:'geotag', title:'Geotag', cat:'Geo', readout:true, w:300,
  kw:'geotag position location gps attach tag survey walk drive map measurement level rssi lat lon coordinates track interpolate geolocate привязка позиции координаты',
  ins:[{n:'rec',t:'rec'},{n:'in',t:'num'},{n:'pos',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'alt',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'ok',t:'num'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'age',t:'num'},{n:'dist',t:'num'}],
  params:[
    {n:'field',t:'text',d:'rssi',label:'number input «in»: field name of the record it makes (rssi, level, temp…)'},
    {n:'every',t:'range',min:.1,max:60,step:.1,log:true,d:1,label:'number input «in»: one record every, s (the number is sampled, not streamed)'},
    {n:'consts',t:'text',d:'',label:'constants added to every record: key=value; … (dev=sdr1; band=433)'},
    {n:'timeBy',t:'select',opts:['record time (t)','arrival'],d:'record time (t)',label:'position at the time of: the record (field t, ms or s; without it — arrival) · the moment it arrives here'},
    {n:'maxAge',t:'range',min:.5,max:120,step:.5,log:true,d:5,label:'a fix older than this (s) is not used — no position'},
    {n:'nopos',t:'select',opts:['drop','pass untagged'],d:'drop',label:'no position: drop the record · pass it on without coordinates'},
    {n:'step',t:'range',min:0,max:500,step:1,d:0,label:'at most one record per this many metres (0 — all)'},
    {n:'dt',t:'range',min:0,max:300,step:.5,d:0,label:'… and not more often than every, s (0 — no limit)'},
    {n:'override',t:'check',d:false,label:'overwrite lat / lon the record already has (off — its own coordinates win)'},
    {n:'own',t:'check',d:true,label:'no position wired — use this device’s GPS (the browser asks permission)'},
    {n:'reset',t:'button',label:'Reset track and counters',fn:n=>{ n.trk=gtNew(); n.cnt=0; n.drop=0; n.skip=0; }}],
  init:n=>{ n.trk=gtNew(); n.cnt=0; n.drop=0; n.skip=0; n.err=''; n.watch=null; n.lastV=0; n.pushed=null; n.pushedAt=0; n.cur=null; n.wired=false; n.wiredAt=-1e9; },
  dispose:n=>gtOwnStop(n),
  process(n,I){
    const p=n.p, now=Date.now(), st=n.trk;
    // --- позиция: записи pos, числа lat/lon, иначе своё GPS
    let wired=false;
    for(const r of recList(I.pos)){ const f=gtFixOf(r,now); if(f && gtPush(st,f)) wired=true; }
    const la=gtNum(I.lat), lo=gtNum(I.lon);
    if(la!=null && lo!=null){
      wired=true; const k=la+','+lo;
      if(now-n.pushedAt>=100 && (k!==n.pushed || now-n.pushedAt>1000)){ n.pushed=k; n.pushedAt=now;   // не чаще 10 Гц: этого хватает для интерполяции
        gtPush(st,{lat:la,lon:lo,acc:gtNum(I.acc),alt:gtNum(I.alt),speed:null,t:now}); }
    }
    if(wired) n.wiredAt=now;
    n.wired=now-n.wiredAt<3000;                                // позиция «с проводов», пока она приходит (потеряли на 3 с — переходим на своё GPS)
    if(p.own && !n.wired) gtOwnStart(n); else gtOwnStop(n);
    // --- что размечаем
    const src=[...recList(I.rec)];
    const v=gtNum(I.in);
    if(v!=null && now-n.lastV>=Math.max(.1,+p.every||1)*1000){
      n.lastV=now; const f=String(p.field||'value').trim().replace(/[^\w.-]/g,'')||'value';
      src.push({t:now,[f]:+v.toFixed(3)});
    }
    const consts=n._cc && n._cc.s===p.consts ? n._cc.o : (n._cc={s:p.consts,o:recConsts(p.consts)}).o;
    const out=[], o={step:+p.step,dt:+p.dt,override:p.override};
    for(const r0 of src){
      if(!r0 || typeof r0!=='object') continue;
      const r={...r0,...consts};
      const tr=p.timeBy==='arrival' ? now : (gtTime(r.t ?? r.time ?? r.ts) ?? now);
      const pos=gtAt(st,tr,+p.maxAge);
      if(!pos){ n.drop++; if(p.nopos==='pass untagged') out.push(r); continue; }
      if(!gtStep(st,pos,tr,o)){ n.skip++; continue; }
      out.push(gtTag(r,pos,o)); n.cnt++;
    }
    n.cur=gtAt(st,now,+p.maxAge);
    const c=n.cur;
    return {rec:out.length ? out : null, count:n.cnt, ok:c ? 1 : 0, lat:c?c.lat:null, lon:c?c.lon:null, acc:c&&c.acc!=null?c.acc:null, age:c?c.age:null, dist:st.dist};
  },
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return; const c=n.cur, p=n.p;
    const lines=[c ? c.lat.toFixed(6)+', '+c.lon.toFixed(6)+(c.acc!=null ? '  ±'+Math.round(c.acc)+' m' : '')+'\nfix '+c.age.toFixed(1)+' s old · '+(n.wired ? 'from the pins' : 'own GPS')
      : (n.trk.fix.length ? 'position is stale (> '+p.maxAge+' s)' : p.own && !n.wired ? 'waiting for the GPS of this device…' : 'no position — wire pos or lat / lon')];
    lines.push('tagged '+n.cnt+' · no position '+n.drop+(+p.step>0||+p.dt>0 ? ' · thinned '+n.skip : '')+' · walked '+(n.trk.dist>=1000 ? (n.trk.dist/1000).toFixed(2)+' km' : Math.round(n.trk.dist)+' m'));
    if(n.err) lines.push(n.err);
    const t=lines.join('\n'); if(el.textContent!==t) el.textContent=t;
  }});
