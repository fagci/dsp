"use strict";
/* ============================ DMR ============================
   DMR Decoder (ядро в dmr-kernels.js): IQ (или ЧМ-звук) → 4FSK 4800 Бод → синхрослова, слоты, колор-код →
   голосовые вызовы (LC, встроенный LC, talker alias), CSBK, данные и SMS, Short LC; сырые кадры AMBE — отдельным выходом. */

defIQ({ id:'dmrRx', title:'DMR Decoder', cat:'Decoders', tall:true, resize:true, w:480,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}]},
  n=>n.ui ? n.ui.text : 'no input');

/* ---- журнал: звонки, станции, разговорные группы ---- */
// Копит записи DMR Decoder: кто с кем, когда, сколько; по станциям и группам — счётчики. Станции с позицией (LRRP / NMEA)
// уходят на карту. Длительность — по записи end (время потока), без неё — по числу голосовых пакетов (60 мс на слот).
function dmrLogStation(n,id,t){
  let s=n.st.get(id);
  if(!s){ s={radio:id, alias:'', calls:0, seconds:0, msgs:0, emergency:0, encrypted:0, first:t, last:t, tg:null, slot:null}; n.st.set(id,s); }
  s.last=Math.max(s.last,t); return s;
}
function dmrLogGroup(n,id){
  let g=n.tgs.get(id);
  if(!g){ g={id, calls:0, seconds:0, stations:new Set(), last:0}; n.tgs.set(id,g); }
  return g;
}
function dmrLogClose(n,c,dur,voice,by,out,t){
  const s=dmrLogStation(n,c.from,t==null ? c.t0+dur*1000 : t), g=dmrLogGroup(n,c.to);
  c.dur=dur; c.voice=voice; c.by=by; c.open=false;
  s.seconds+=dur; g.seconds+=dur;
  n.calls.push(c); if(n.calls.length>n.p.max) n.calls.splice(0,n.calls.length-n.p.max);
  out.calls.push(dmrLogCallRec(c));
}
function dmrLogCallRec(c){
  return {t:c.t0, src:'DMR', kind:'call-log', radio:c.from, to:c.to, call:c.type, slot:c.slot, cc:c.cc, seconds:+c.dur.toFixed(1), voice:c.voice, alias:c.alias||undefined, flags:c.flags||undefined,
    text:c.from+(c.alias ? ' "'+c.alias+'"' : '')+' → '+(c.type==='group' ? 'TG ' : '')+c.to+' · '+c.dur.toFixed(1)+' s'};
}
function dmrLogStationRec(s,t){
  const r={t, src:'DMR', kind:'station', id:'dmr:'+s.radio, radio:s.radio, alias:s.alias||undefined, label:s.alias||String(s.radio), calls:s.calls, seconds:+s.seconds.toFixed(1), messages:s.msgs, tg:s.tg, slot:s.slot, last:s.last};
  if(s.lat!=null){ r.lat=s.lat; r.lon=s.lon; }
  return r;
}
def({ id:'dmrLog', title:'DMR Call Log', cat:'Output',
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'stations',t:'rec'},{n:'calls',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true, resize:true, w:480,
  params:[{n:'max',t:'range',min:100,max:100000,step:100,d:5000,label:'max calls and messages kept'},
          {n:'calls',t:'button',label:'Calls CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv(dmrLogCallRows(n))],{type:'text/csv;charset=utf-8'}),'dmr-calls-'+Date.now()+'.csv')},
          {n:'stations',t:'button',label:'Stations CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv(dmrLogStationRows(n))],{type:'text/csv;charset=utf-8'}),'dmr-stations-'+Date.now()+'.csv')},
          {n:'groups',t:'button',label:'Groups CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv(dmrLogGroupRows(n))],{type:'text/csv;charset=utf-8'}),'dmr-groups-'+Date.now()+'.csv')},
          {n:'replay',t:'button',label:'Replay stations',fn:n=>{ n.replay=[...n.st.values()].map(s=>dmrLogStationRec(s,s.last)); }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.st=new Map(); n.tgs=new Map(); n.calls=[]; n.open=new Map(); }}],
  init:n=>{ n.st=new Map(); n.tgs=new Map(); n.calls=[]; n.open=new Map(); n.replay=null; },
  process(n,I){
    const out={calls:[], st:new Set()};
    for(const r of recList(I.rec)){
      if(r.src!=='DMR') continue;
      const k=r.slot||0;
      if(r.kind==='call'){
        const c=n.open.get(k);
        if(c && c.from===r.from && c.to===r.to){ if(r.flags) c.flags=r.flags; continue; }   // повтор заголовка
        if(c) dmrLogClose(n,c,Math.max(0,(r.t-c.t0)/1000),c.voice||0,'new call',out);
        const s=dmrLogStation(n,r.from,r.t), g=dmrLogGroup(n,r.to);
        s.calls++; s.tg=r.to; s.slot=r.slot||null; g.calls++; g.stations.add(r.from); g.last=r.t;
        if(r.flags&&r.flags.includes('emergency')) s.emergency++;
        if(r.flags&&r.flags.includes('encrypted')) s.encrypted++;
        n.open.set(k,{from:r.from, to:r.to, type:r.call, slot:r.slot||null, cc:r.cc, t0:r.t, flags:r.flags||'', late:!!r.late, alias:s.alias||'', open:true, voice:0, dur:0, counted:true});
        out.st.add(s);
      } else if(r.kind==='end'){
        let c=n.open.get(k);
        if(!c || c.from!==r.from) c={from:r.from, to:r.to, type:r.call, slot:r.slot||null, cc:r.cc, t0:r.t-(r.ms||0), flags:'', late:true, alias:'', open:true, counted:false};
        n.open.delete(k);
        if(r.alias) c.alias=r.alias;
        const dur=r.ms!=null ? r.ms/1000 : r.voice*0.06;
        if(!c.counted){ const s=dmrLogStation(n,c.from,r.t), g=dmrLogGroup(n,c.to); s.calls++; g.calls++; g.stations.add(c.from); g.last=r.t; }
        dmrLogClose(n,c,dur,r.voice,'terminator',out,r.t);
        out.st.add(n.st.get(c.from));
      } else if(r.kind==='alias'){
        const s=dmrLogStation(n,r.from,r.t); s.alias=r.alias;
        const c=n.open.get(k); if(c && c.from===r.from) c.alias=r.alias;
        out.st.add(s);
      } else if(r.kind==='message' && r.from!=null){
        const s=dmrLogStation(n,r.from,r.t); s.msgs++; s.slot=r.slot||s.slot;
        if(r.lat!=null){ s.lat=r.lat; s.lon=r.lon; }
        n.calls.push({from:r.from, to:r.to, type:r.service||'data', slot:r.slot||null, cc:r.cc, t0:r.t, dur:0, voice:0, flags:'', alias:s.alias, text:r.message!=null ? String(r.message) : r.data, open:false, data:true});
        if(n.calls.length>n.p.max) n.calls.splice(0,n.calls.length-n.p.max);
        out.st.add(s);
      }
    }
    let st=[...out.st].map(s=>dmrLogStationRec(s,s.last));
    if(n.replay?.length){ st=st.concat(n.replay.splice(0,500)); }
    return {stations:st.length ? st : null, calls:out.calls.length ? out.calls : null, count:n.st.size};
  },
  draw(n){
    const fmt=t=>new Date(t).toLocaleTimeString(), act=[...n.open.values()];
    const head='stations '+n.st.size+' · groups '+n.tgs.size+' · calls '+n.calls.filter(c=>!c.data).length+' · messages '+n.calls.filter(c=>c.data).length;
    const now=act.map(c=>'● '+(c.slot ? 'TS'+c.slot+' ' : '')+c.from+(n.st.get(c.from)?.alias ? ' "'+n.st.get(c.from).alias+'"' : '')+' → '+(c.type==='group' ? 'TG ' : '')+c.to);
    const top=[...n.st.values()].sort((a,b)=>b.last-a.last).slice(0,6).map(s=>s.radio+(s.alias ? ' '+s.alias : '')+'  ×'+s.calls+' · '+s.seconds.toFixed(0)+' s'+(s.msgs ? ' · '+s.msgs+' msg' : '')+(s.lat!=null ? ' · ⌖' : '')+'  '+fmt(s.last));
    const tail=n.calls.slice(-5).map(c=>fmt(c.t0)+' '+c.from+' → '+(c.type==='group' ? 'TG ' : '')+c.to+' '+(c.data ? (c.type+' '+(c.text||'').slice(0,40)) : c.dur.toFixed(1)+' s'));
    n.el.querySelector('.readout').textContent=head+(now.length ? '\n'+now.join('\n') : '')+(top.length ? '\n— stations —\n'+top.join('\n') : '')+(tail.length ? '\n— last —\n'+tail.join('\n') : '');
  }});
function dmrLogCallRows(n){
  const row=c=>({start:new Date(c.t0).toISOString(), radio:c.from, to:c.to, type:c.type, slot:c.slot, cc:c.cc, seconds:+(c.dur||0).toFixed(1), voice_bursts:c.voice, alias:c.alias||'', flags:c.flags||'', late_entry:c.late ? 1 : 0, text:c.text||'', open:c.open ? 1 : 0});
  return n.calls.map(row).concat([...n.open.values()].map(row));
}
function dmrLogStationRows(n){
  return [...n.st.values()].map(s=>({radio:s.radio, alias:s.alias, calls:s.calls, seconds:+s.seconds.toFixed(1), messages:s.msgs, emergency:s.emergency, encrypted:s.encrypted,
    first:new Date(s.first).toISOString(), last:new Date(s.last).toISOString(), last_group:s.tg, slot:s.slot, lat:s.lat, lon:s.lon}));
}
function dmrLogGroupRows(n){
  return [...n.tgs.values()].map(g=>({group:g.id, calls:g.calls, seconds:+g.seconds.toFixed(1), stations:g.stations.size, last:g.last ? new Date(g.last).toISOString() : ''}));
}
