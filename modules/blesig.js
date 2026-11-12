"use strict";
/* ============================ BLE Signatures: Flipper · метки · очки ============================
   Записи BLE (приложение DSP) → распознанные по рекламе Flipper Zero, метки (AirTag / Find My, SmartTag, Tile, Google Find Hub) и умные очки
   (Meta / Ray-Ban Meta, Snap, Even Realities…). Ядро — modules/blesig-kernels.js, проверяется в tools/test-blesig.mjs.
   rows — устройства рядом (ближе — выше), живут ttl минут после последнего пакета; идёт на вход top у Rec → Entities. Пресет: «Phone App: Flipper, Tags and Smart Glasses Around Me». */

def({ id:'blesig', title:'BLE Signatures (Flipper · tags · glasses)', cat:'Geo', kw:'flipper zero airtag tag tracker find my smarttag tile glasses ray-ban meta spectacles smart glasses ble bluetooth advertisement signature detect nearby surveillance',
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'alert',t:'rec'},{n:'hit',t:'num'},{n:'rows',t:'bands'},{n:'count',t:'num'},{n:'text',t:'txt'}],
  readout:true, tall:true,
  params:[
    {n:'flipper',t:'check',d:true,label:'Flipper Zero (name «Flipper …», services 0x3081–0x3083)'},
    {n:'tracker',t:'check',d:true,label:'tags: Apple AirTag / Find My, Samsung SmartTag, Tile, Google Find Hub'},
    {n:'glasses',t:'check',d:true,label:'smart glasses: Meta / Ray-Ban Meta, Snap Spectacles, Even Realities, Rokid, XREAL…'},
    {n:'ttl',t:'range',min:1,max:240,step:1,d:5,label:'keep a device in the list for, min after its last packet'},
    {n:'ignore',t:'text',d:'',label:'ignore ids (regex, e.g. your own tags)',adv:true},
    {n:'reset',t:'button',label:'Forget all',fn:n=>{ n.st=bsNew(); n.dirty=true; }}],
  init:n=>{ n.st=bsNew(); n.lastRec=null; n.alertRec=null; n.hitPulse=0; n.dirty=true; n.lastPrune=0; n.lastRows=0; n.rowsRec=null; n.recOut=null; n.txt=''; n.reKey=null; n.re=null; },
  process(n,I){
    const p=n.p, now=Date.now()/1000, kinds=BS_KINDS.filter(k=>p[k]!==false);
    if(n.reKey!==p.ignore){ n.reKey=p.ignore; try{ n.re=p.ignore ? new RegExp(p.ignore,'i') : null; }catch(e){ n.re=null; } }
    const recs=recList(I.rec); let out=null, fresh=null;
    if(recs.length && I.rec!==n.lastRec){
      n.lastRec=I.rec;
      for(const r of recs){
        if(!r || r.src!=='ble' || (n.re && n.re.test(String(r.addr??'')))) continue;
        const x=bsSee(n.st,r,now,kinds); if(!x) continue;
        (out||(out=[])).push({...r,sig:x.dev.kind,sigLabel:x.dev.label,sigWhy:x.dev.why});
        if(x.fresh) (fresh||(fresh=[])).push({id:x.dev.id,name:x.dev.name||x.dev.label,kind:x.dev.kind,label:x.dev.label,rssi:x.dev.rssi,lat:r.lat,lon:r.lon,
          text:x.dev.label+' nearby: '+(x.dev.name||x.dev.id)+' ('+x.dev.rssi+' dBm)'});
      }
      if(out){ n.recOut=out; n.dirty=true; } else n.recOut=null;
      if(fresh){ n.alertRec=fresh; n.hitPulse=fresh.length; }
    } else if(I.rec!==n.lastRec) n.recOut=null;
    if(now-n.lastPrune>5){ n.lastPrune=now; bsPrune(n.st,now,p.ttl); n.dirty=true; }
    if(n.dirty || now-n.lastRows>1){
      n.dirty=false; n.lastRows=now; n.rowsRec=bsRows(n.st,now);
      n.txt=n.rowsRec.map(r=>r.label+(r.name!==r.label ? ' · '+r.name : '')+' · '+(r.rssi!==''?r.rssi+' dBm · ':'')+r.ago_s+' s').join('\n');
    }
    const o={rec:n.recOut,alert:n.alertRec,hit:n.hitPulse,rows:n.rowsRec,count:n.st.dev.size,text:n.txt};
    n.hitPulse=0; n.alertRec=null; n.recOut=null;
    return o;
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t='devices '+n.st.dev.size+(n.txt ? '\n'+n.txt : '\n(nothing recognised yet — BLE records from Phone sensors → rec)');
    if(r.textContent!==t) r.textContent=t; }
});
