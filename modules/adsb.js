"use strict";
/* ============================ ADS-B / Mode S 1090 МГц ============================
   ADS-B Demodulator (IQ-блок, ядро в iq-kernels.js): IQ ≥ 2 МС/с → кадры с верной CRC (rec: raw, df, icao, rssi).
   ADS-B Decoder: кадры (rec или текст AVR "*8D…;" — например, из dump1090 по сети) → таблица бортов
   и записи для карты: позиция (CPR), высота, скорость, курс, позывной, squawk. */

defIQ({ id:'adsbDemod', title:'ADS-B Demodulator', cat:'Modulation',
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'rate',t:'num'}],
  params:[{n:'thr',t:'range',min:1,max:12,step:.5,d:6,label:'preamble: pulses over the gaps, dB'},
          {n:'fix',t:'select',opts:['off','1 bit','2 weak bits'],d:'1 bit',label:'fix errors in DF17/18 (2 weak bits — more range, rare ghosts)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    return (u.sr<1.9e6 ? 'needs ≥ 2 MS/s! · ' : '')+u.frames+' frames · '+(u.rate||0).toFixed(1)+'/s · '+u.fixed+' fixed · '+u.known+' aircraft'; });

def({ id:'adsbDecode', title:'ADS-B Decoder', cat:'Decoders',
  ins:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'msgs',t:'num'},{n:'range',t:'num'}],
  readout:true, tall:true, w:540, resize:true,
  params:[{n:'ttl',t:'range',min:10,max:600,step:10,d:60,label:'keep aircraft, s'},
          {n:'rlat',t:'num',d:0,label:'receiver latitude (or lat input / My Position)'},
          {n:'rlon',t:'num',d:0,label:'receiver longitude'},
          {n:'maxKm',t:'range',min:0,max:1000,step:10,d:0,label:'reject positions farther than, km (0 — any)'},
          {n:'noPos',t:'check',d:true,label:'list aircraft without position'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.ac.clear(); n.msgs=0; n.maxRange=0; }}],
  init:n=>{ n.ac=new Map(); n.msgs=0; n.lastText=null; n.maxRange=0; n.lastPrune=0; },
  process(n,I){
    const now=Date.now(), ref=adsbRef(n,I), changed=new Set();
    for(const r of recList(I.rec)) if(r && r.raw) adsbFeed(n,r.raw,r.t||now,r.rssi,ref,changed);
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const line of I.text.split(/[\r\n;]+/)){
        const h=line.replace(/^@[0-9a-f]{12}/i,'').replace(/[^0-9a-f]/gi,'');
        if(h.length===14 || h.length===28) adsbFeed(n,h,now,null,ref,changed);
      }
    }
    if(now-n.lastPrune>1000){ n.lastPrune=now;
      for(const [k,a] of n.ac) if(now-a.seen>n.p.ttl*1000) n.ac.delete(k); }
    const recs=adsbRecs(n,changed);
    return {rec:recs.length ? recs : null, count:n.ac.size, msgs:n.msgs, range:n.maxRange ? +n.maxRange.toFixed(1) : null};
  },
  draw(n){ n.el.querySelector('.readout').textContent=adsbTable(n); }});

function adsbRef(n,I){
  if(typeof I.lat==='number' && typeof I.lon==='number' && isFinite(I.lat) && isFinite(I.lon)) return {lat:I.lat, lon:I.lon};
  if(n.p.rlat || n.p.rlon) return {lat:+n.p.rlat, lon:+n.p.rlon};
  if(GeoMe.lat!=null) return {lat:GeoMe.lat, lon:GeoMe.lon};
  return null;
}
function adsbTable(n){
  const now=Date.now(), rows=[...n.ac.values()].filter(a=>n.p.noPos || a.lat!=null).sort((x,y)=>y.seen-x.seen);
  const pad=(v,w)=>String(v ?? '').padEnd(w).slice(0,w), num=(v,w,d=0)=>(v==null ? '' : Number(v).toFixed(d)).padStart(w);
  let s=n.ac.size+' aircraft · '+rows.filter(a=>a.lat!=null).length+' with position · '+n.msgs+' msgs'+
    (n.maxRange ? ' · max '+n.maxRange.toFixed(0)+' km' : '')+'\n';
  s+='ICAO    Flight   Sqwk    Alt   Spd  Hdg      Lat      Lon   Km  Msgs  Age\n';
  for(const a of rows.slice(0,40))
    s+=pad(a.icao,7)+' '+pad(a.flight,8)+' '+pad(a.squawk,4)+' '+(a.ground ? '   gnd' : num(a.alt,6))+' '+num(a.gs,5)+' '+
      num(a.track ?? a.hdg,4)+' '+num(a.lat,8,3)+' '+num(a.lon,8,3)+' '+num(a.dist,4)+' '+num(a.msgs,5)+' '+num((now-a.seen)/1000,4)+'\n';
  return s;
}
