"use strict";
/* ============================ Open Drone ID (Remote ID) ============================
   Приёмник Remote ID по строкам прошивки на ESP32 (WebSerial): ODID,<wifi|ble>,<rssi>,<mac>,<hex>.
   Прошивка — tools/odid-esp32c5. Разбор — odid-kernels.js. Узел можно кормить и без железа: вход text — те же строки
   (или голый hex сообщения) — и rec с полем raw. */

async function odidTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function odidConnect(n){
  if(n.connecting) return;
  await odidTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200, bufferSize:65536});
    n.port=port; n.connecting=false; n.connected=true; n.status='connected';
    odidReadLoop(n);
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await odidTeardown(n);
  }
}
async function odidReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  const dec=new TextDecoder(); let buf='';
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(!value) continue;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n'))>=0){ odidFeedLine(n,buf.slice(0,i)); buf=buf.slice(i+1); }
      if(buf.length>4096) buf='';
    }
    if(n.connected){ n.status='port closed by device'; odidTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; odidTeardown(n); }
  }
}

function odidFeedLine(n,line){
  const r=odidLine(line); if(!r) return;
  odidFeed(n,r.msgs,r.mac,r.rssi,r.transport,Date.now());
}
function odidFeed(n,msgs,mac,rssi,transport,now){
  if(!msgs.length) return;
  n.frames++;
  const key=mac || msgs.find(m=>m.id)?.id || '?';
  let u=n.uas.get(key);
  if(!u){ u={key, mac, id:'', uaName:'', idTypeName:'', msgs:0, first:now}; n.uas.set(key,u); }
  u.seen=now; u.msgs+=msgs.length;
  if(rssi!=null && isFinite(rssi)) u.rssi=rssi;
  if(transport) u.transport=transport;
  for(const m of msgs){
    switch(m.kind){
      case 'basic': u.id=m.id; u.idTypeName=m.idTypeName; u.uaName=m.uaName; break;
      case 'location':
        u.status=m.statusName; u.dir=m.dir; u.speed=m.speed; u.vspeed=m.vspeed;
        u.altGeo=m.altGeo; u.altBaro=m.altBaro; u.height=m.height;
        if(m.lat!=null){ u.lat=m.lat; u.lon=m.lon; u.posT=now; }
        break;
      case 'system':
        if(m.opLat!=null){ u.opLat=m.opLat; u.opLon=m.opLon; }
        u.opLoc=m.opLocName; break;
      case 'operator': u.opId=m.id; break;
      case 'selfid': u.text=m.text; break;
    }
  }
  n.changed.add(key);
}

function odidRef(n,I){
  if(typeof I.lat==='number' && typeof I.lon==='number' && isFinite(I.lat) && isFinite(I.lon)) return {lat:I.lat, lon:I.lon};
  if(typeof GeoMe!=='undefined' && GeoMe.lat!=null) return {lat:GeoMe.lat, lon:GeoMe.lon};
  return null;
}

def({ id:'odid', lazy:'manual', title:'Remote ID (Open Drone ID)', cat:'Sources', kw:'drone uav remote id odid astm f3411 esp32 wifi beacon nan ble dji',
  ins:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'frames',t:'num'},{n:'dist',t:'num'}],
  readout:true, tall:true, w:560, resize:true,
  params:[{n:'connect',t:'button',label:'Connect ESP32',fn:n=>odidConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; odidTeardown(n); }},
          {n:'baud',t:'num',d:115200,label:'baud (ignored by USB-CDC chips)',adv:true},
          {n:'ttl',t:'range',min:10,max:600,step:10,d:120,label:'keep drones, s'},
          {n:'operator',t:'check',d:true,label:'also output the operator position'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.uas.clear(); n.frames=0; }}],
  init:n=>{
    n.uas=new Map(); n.changed=new Set(); n.frames=0; n.lastText=null; n.lastPrune=0;
    n.port=null; n.reader=null; n.connected=false; n.connecting=false; n.status='not connected';
  },
  dispose:n=>{ odidTeardown(n).catch(e=>console.error('odid dispose:',e)); },
  process(n,I){
    const now=Date.now(), ref=odidRef(n,I);
    for(const r of recList(I.rec)){
      if(!r || !r.raw) continue;
      const m=odidParse(odidHex(r.raw)); odidFeed(n,m,r.mac||'',r.rssi,r.transport||null,r.t||now);
    }
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const line of I.text.split(/[\r\n;]+/)) odidFeedLine(n,line);
    }
    if(now-n.lastPrune>1000){ n.lastPrune=now;
      for(const [k,u] of n.uas) if(now-u.seen>n.p.ttl*1000) n.uas.delete(k); }
    const recs=[]; let near=null;
    for(const k of n.changed){
      const u=n.uas.get(k); if(!u || u.lat==null) continue;
      const name=u.id||u.mac||k;
      const r={t:u.seen, id:k, label:name, lat:u.lat, lon:u.lon, icon:'plane', color:'#ff8a3d', src:'Remote ID',
        mac:u.mac, uas:u.id, type:u.uaName, status:u.status, rssi:u.rssi, transport:u.transport};
      if(u.dir!=null) r.heading=u.dir;
      if(u.speed!=null) r.speed=u.speed;
      if(u.altGeo!=null) r.alt_m=u.altGeo; else if(u.altBaro!=null) r.alt_m=u.altBaro;
      if(u.height!=null) r.height_m=u.height;
      if(ref) r.dist_km=+geoDist(ref.lat,ref.lon,u.lat,u.lon).toFixed(3);
      recs.push(r);
      if(n.p.operator && u.opLat!=null)
        recs.push({t:u.seen, id:'op:'+k, label:'operator '+(u.opId||name), lat:u.opLat, lon:u.opLon, icon:'flag', color:'#4da3ff', src:'Remote ID', uas:u.id});
    }
    n.changed.clear();
    if(ref) for(const u of n.uas.values()) if(u.lat!=null){ const d=geoDist(ref.lat,ref.lon,u.lat,u.lon); if(near==null || d<near) near=d; }
    return {rec:recs.length ? recs : null, count:n.uas.size, frames:n.frames, dist:near==null ? null : +near.toFixed(3)};
  },
  drawKey:n=>n.status+'|'+n.frames+'|'+n.uas.size+'|'+Math.floor(Date.now()/1000),
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const now=Date.now(), rows=[n.status+' · '+n.uas.size+' drones · '+n.frames+' frames'];
    for(const u of [...n.uas.values()].sort((a,b)=>b.seen-a.seen).slice(0,12)){
      const pos=u.lat!=null ? u.lat.toFixed(5)+', '+u.lon.toFixed(5) : 'no position';
      const alt=u.altGeo!=null ? ' '+Math.round(u.altGeo)+' m' : '';
      const sp=u.speed!=null ? ' '+u.speed.toFixed(1)+' m/s' : '';
      rows.push((u.id||u.mac||u.key)+' · '+(u.uaName||'?')+' · '+(u.status||'?')+' · '+pos+alt+sp+
        (u.opLat!=null ? ' · op '+u.opLat.toFixed(5)+', '+u.opLon.toFixed(5) : '')+
        (u.rssi!=null ? ' · '+u.rssi+' dBm' : '')+' · '+Math.round((now-u.seen)/1000)+' s'+(u.text ? ' · "'+u.text+'"' : ''));
    }
    const s=rows.join('\n'); if(el.textContent!==s) el.textContent=s;
  }});
