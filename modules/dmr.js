"use strict";
/* ============================ DMR ============================
   Ядро DMR (dmr-kernels.js) работает в узле 4FSK Digital Voice (fskRx, proto = dmr; прежний узел DMR Decoder — его миграция): IQ (или ЧМ-звук) → 4FSK 4800 Бод → синхрослова, слоты, колор-код →
   голосовые вызовы (LC, встроенный LC, talker alias), CSBK, данные и SMS, Short LC; сырые кадры AMBE — отдельным выходом. */

// кадры DMR из Symbol Sync Search (с сеткой кадров) → записи и сырые кадры AMBE+2; разбор тот же, что у Digital Voice Decoder с proto = dmr
defIQ({ id:'dmrParse', title:'DMR Frame Parser', cat:'Decoders', kw:'dmr frames burst csbk lc motorola mototrbo', tall:true, resize:true, w:480,
  ins:[{n:'blk',t:'blk'}], outs:[{n:'rec',t:'rec'},{n:'voice',t:'rec'}]},
  n=>n.ui ? n.ui.text : 'no input');

/* ---- журнал: звонки, станции, разговорные группы ---- */
// Копит записи DMR (Digital Voice Decoder): кто с кем, когда, сколько; по станциям и группам — счётчики. Станции с позицией (LRRP / NMEA)
// уходят на карту. Длительность — по записи end (время потока), без неё — по числу голосовых пакетов (60 мс на слот).
// имена: списки Table «Reference/DMR radio IDs» и «Reference/DMR talkgroups» (Files → ⇩ offline; индексы общие с lookup() в Table).
// Пока списка нет, журнал работает с числами; попытка загрузки повторяется не чаще раза в 30 с
const dmrLogIx=(n,w)=>LU.get(LU.key(w==='id' ? REF_DMRID : REF_DMRTG,'eq','id'));
function dmrLogLoad(n){
  if(!n.p.names || Date.now()<n.ldRetry) return;
  n.ldRetry=Date.now()+30000;
  for(const w of ['id','tg']){
    const list=w==='id' ? REF_DMRID : REF_DMRTG, k=LU.key(list,'eq','id');
    if(!LU.get(k)) luLoad(n,k,{list,mode:'eq',c1:'id'});
  }
}
const dmrLogWho=(n,id)=>n.p.names ? dmrLogIx(n,'id')?.find(id)||null : null;
const dmrLogTgName=(n,id)=>n.p.names ? dmrLogIx(n,'tg')?.find(id)?.name||null : null;
function dmrLogNames(n){
  if(!n.p.names) return '';
  const a=dmrLogIx(n,'id'), g=dmrLogIx(n,'tg');
  if(a||g) return ' · names: '+(a ? a.size+' IDs' : 'no IDs')+(g ? ', '+g.size+' groups' : ', no groups');
  return ' · names: no data — Files → ⇩ offline ("DMR radio IDs")';
}
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
  out.calls.push(dmrLogCallRec(n,c));
}
// участник вызова: «ID ПОЗЫВНОЙ "алиас"»; группа: «TG 91 (название)»
function dmrLogParty(n,id,alias){ const w=dmrLogWho(n,id); return id+(w ? ' '+w.callsign : '')+(alias ? ' "'+alias+'"' : ''); }
function dmrLogDest(n,c){ if(c.type!=='group') return dmrLogParty(n,c.to); const g=dmrLogTgName(n,c.to); return 'TG '+c.to+(g ? ' ('+g+')' : ''); }
function dmrLogCallRec(n,c){
  const w=dmrLogWho(n,c.from);
  return {t:c.t0, src:'DMR', kind:'call-log', radio:c.from, callsign:w?.callsign, name:w?.name||undefined, to:c.to, tgname:c.type==='group' ? dmrLogTgName(n,c.to)||undefined : undefined, call:c.type, slot:c.slot, cc:c.cc, seconds:+c.dur.toFixed(1), voice:c.voice, alias:c.alias||undefined, flags:c.flags||undefined,
    text:dmrLogParty(n,c.from,c.alias)+' → '+dmrLogDest(n,c)+' · '+c.dur.toFixed(1)+' s'};
}
function dmrLogStationRec(n,s,t){
  const w=dmrLogWho(n,s.radio);
  const r={t, src:'DMR', kind:'station', id:'dmr:'+s.radio, radio:s.radio, alias:s.alias||undefined, callsign:w?.callsign, name:w?.name||undefined, place:w?.place||undefined, label:s.alias||w?.callsign||String(s.radio), calls:s.calls, seconds:+s.seconds.toFixed(1), messages:s.msgs, tg:s.tg, slot:s.slot, last:s.last};
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
          {n:'names',t:'check',d:true,label:'names from RadioID and talkgroup lists (Files → ⇩ offline)'},
          {n:'replay',t:'button',label:'Replay stations',fn:n=>{ n.replay=[...n.st.values()].map(s=>dmrLogStationRec(n,s,s.last)); }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.st=new Map(); n.tgs=new Map(); n.calls=[]; n.open=new Map(); }}],
  init:n=>{ n.st=new Map(); n.tgs=new Map(); n.calls=[]; n.open=new Map(); n.replay=null; n.ldRetry=0; },
  process(n,I){
    dmrLogLoad(n);
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
    let st=[...out.st].map(s=>dmrLogStationRec(n,s,s.last));
    if(n.replay?.length){ st=st.concat(n.replay.splice(0,500)); }
    return {stations:st.length ? st : null, calls:out.calls.length ? out.calls : null, count:n.st.size};
  },
  draw(n){
    const fmt=t=>new Date(t).toLocaleTimeString(), act=[...n.open.values()];
    const head='stations '+n.st.size+' · groups '+n.tgs.size+' · calls '+n.calls.filter(c=>!c.data).length+' · messages '+n.calls.filter(c=>c.data).length+dmrLogNames(n);
    const now=act.map(c=>'● '+(c.slot ? 'TS'+c.slot+' ' : '')+dmrLogParty(n,c.from,n.st.get(c.from)?.alias)+' → '+dmrLogDest(n,c));
    const top=[...n.st.values()].sort((a,b)=>b.last-a.last).slice(0,6).map(s=>dmrLogParty(n,s.radio,s.alias)+'  ×'+s.calls+' · '+s.seconds.toFixed(0)+' s'+(s.msgs ? ' · '+s.msgs+' msg' : '')+(s.lat!=null ? ' · ⌖' : '')+'  '+fmt(s.last));
    const tail=n.calls.slice(-5).map(c=>fmt(c.t0)+' '+dmrLogParty(n,c.from)+' → '+dmrLogDest(n,c)+' '+(c.data ? (c.type+' '+(c.text||'').slice(0,40)) : c.dur.toFixed(1)+' s'));
    n.el.querySelector('.readout').textContent=head+(now.length ? '\n'+now.join('\n') : '')+(top.length ? '\n— stations —\n'+top.join('\n') : '')+(tail.length ? '\n— last —\n'+tail.join('\n') : '');
  }});
function dmrLogCallRows(n){
  const row=c=>({start:new Date(c.t0).toISOString(), radio:c.from, callsign:dmrLogWho(n,c.from)?.callsign||'', to:c.to, to_name:c.type==='group' ? dmrLogTgName(n,c.to)||'' : dmrLogWho(n,c.to)?.callsign||'', type:c.type, slot:c.slot, cc:c.cc, seconds:+(c.dur||0).toFixed(1), voice_bursts:c.voice, alias:c.alias||'', flags:c.flags||'', late_entry:c.late ? 1 : 0, text:c.text||'', open:c.open ? 1 : 0});
  return n.calls.map(row).concat([...n.open.values()].map(row));
}
function dmrLogStationRows(n){
  return [...n.st.values()].map(s=>({radio:s.radio, callsign:dmrLogWho(n,s.radio)?.callsign||'', name:dmrLogWho(n,s.radio)?.name||'', place:dmrLogWho(n,s.radio)?.place||'', alias:s.alias, calls:s.calls, seconds:+s.seconds.toFixed(1), messages:s.msgs, emergency:s.emergency, encrypted:s.encrypted,
    first:new Date(s.first).toISOString(), last:new Date(s.last).toISOString(), last_group:s.tg, slot:s.slot, lat:s.lat, lon:s.lon}));
}
function dmrLogGroupRows(n){
  return [...n.tgs.values()].map(g=>({group:g.id, name:dmrLogTgName(n,g.id)||'', calls:g.calls, seconds:+g.seconds.toFixed(1), stations:g.stations.size, last:g.last ? new Date(g.last).toISOString() : ''}));
}
