"use strict";
/* ============================ Follow Detector («меня преследуют») ============================
   Наблюдения устройств (BLE / BT / Wi-Fi с полем addr / bssid) + ваша позиция → устройства, которые видны в нескольких местах маршрута.
   Ядро — modules/follow-kernels.js, проверяется в tools/test-follow.mjs. Пресет: «Follow Detector: …». */

def({ id:'follow', title:'Follow Detector', cat:'Geo', kw:'follow stalker tracker chase pursuit airtag ble bluetooth same device seen again places alert surveillance',
  ins:[{n:'rec',t:'rec'},{n:'pos',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'alert',t:'rec'},{n:'hit',t:'num'},{n:'map',t:'rec'},{n:'rows',t:'bands'},{n:'count',t:'num'},{n:'text',t:'txt'}],
  readout:true, tall:true,
  params:[
    {n:'idf',t:'text',d:'addr|bssid|mac',label:'device id field(s), first non-empty (a|b)'},
    {n:'places',t:'range',min:2,max:10,step:1,d:3,label:'seen in this many different places'},
    {n:'sep',t:'range',min:20,max:1000,step:10,d:150,label:'a «place» is at least this far from the others, m'},
    {n:'mins',t:'range',min:1,max:120,step:1,d:5,label:'…over at least, min'},
    {n:'dist',t:'range',min:0,max:5000,step:50,d:300,label:'…and you moved away at least, m'},
    {n:'ttl',t:'range',min:1,max:240,step:1,d:30,label:'forget a device not seen for, min',adv:true},
    {n:'ignore',t:'text',d:'',label:'ignore ids (regex, e.g. your own devices)',adv:true},
    {n:'reset',t:'button',label:'Forget all',fn:n=>{ n.st=flNew(); n.dirty=true; }}],
  init:n=>{ n.st=flNew(); n.lastRec=null; n.pos=null; n.alertRec=null; n.hitPulse=0; n.mapRec=null; n.rowsRec=null; n.dirty=true; n.lastPrune=0; n.reCache=null; n.txt=''; },
  process(n,I){
    const p=n.p, now=Date.now()/1000;
    for(const q of recList(I.pos)) if(q && isFinite(q.lat) && isFinite(q.lon) && (q.lat||q.lon)) n.pos={lat:+q.lat,lon:+q.lon};   // последняя запись с координатами
    if(isFinite(I.lat) && isFinite(I.lon) && (I.lat||I.lon)) n.pos={lat:+I.lat,lon:+I.lon};
    const recs=recList(I.rec);
    if(recs.length && I.rec!==n.lastRec && n.pos){
      n.lastRec=I.rec;
      if(n.reCache?.src!==p.ignore) n.reCache={src:p.ignore,re:(()=>{ try{ return p.ignore ? new RegExp(p.ignore,'i') : null; }catch(e){ return null; } })()};
      const keys=String(p.idf||'addr').split('|').map(s=>s.trim()).filter(Boolean), fresh=[];
      for(const r of recs){
        let id=null; for(const k of keys){ if(r[k]!=null && r[k]!==''){ id=r[k]; break; } }
        if(id==null || (n.reCache.re && n.reCache.re.test(String(id)))) continue;
        const x=flSee(n.st,{id,label:r.name||r.ssid||'',lat:n.pos.lat,lon:n.pos.lon,t:now,rssi:r.rssi},p);
        if(x?.newly) fresh.push({id:x.dev.id,name:x.dev.label||x.dev.id,places:x.dev.places.length,mins:Math.round((now-x.dev.first)/6)/10,away_m:Math.round(x.dev.maxD),lat:n.pos.lat,lon:n.pos.lon,
          text:'Following you: '+(x.dev.label||x.dev.id)+' — '+x.dev.places.length+' places, '+Math.round(x.dev.maxD)+' m'});
      }
      n.dirty=true;
      if(fresh.length){ n.alertRec=fresh; n.hitPulse=fresh.length; }
    }
    if(now-n.lastPrune>10){ n.lastPrune=now; flPrune(n.st,now,p.ttl); n.dirty=true; }
    if(n.dirty){
      n.dirty=false; n.mapRec=flPoints(n.st); n.rowsRec=flRows(n.st,now);
      const sus=n.rowsRec.filter(r=>r.status==='FOLLOWING');
      n.txt=sus.length ? sus.map(r=>r.name+' · '+r.places+' places · '+r.away_m+' m').join('\n') : '';
    }
    const o={alert:n.alertRec,hit:n.hitPulse,map:n.mapRec,rows:n.rowsRec,count:n.st.dev.size,text:n.txt};
    n.hitPulse=0;
    return o;
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const sus=[...n.st.dev.values()].filter(d=>d.sus).length;
    const t=(n.pos ? '' : 'waiting for a position (My Position → pos)\n')+'devices '+n.st.dev.size+' · following '+sus+(n.txt ? '\n'+n.txt : '');
    if(r.textContent!==t) r.textContent=t; }
});
