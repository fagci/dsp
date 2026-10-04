"use strict";
/* ============================ Messages and Subscribers ============================
   Два узла над записями `rec` любых цифровых протоколов (Digital Voice Decoder, дальше — всё, что отдаёт записи с from / to):
   Messages — содержательные сообщения отдельным потоком (SMS / текст, короткие данные, координаты, IP / UDP, пакеты M17, слоудата D-STAR);
   сигнализация (транкинг, заголовки, шифрование) — по галочке. Subscribers — реестр абонентов и групп: кто, когда, сколько говорил,
   сколько сообщений, позывной / alias, положение (на карту). Единый вид записей для всех протоколов: commsMessage / commsWho. */

const COMMS_SIGNAL=new Set(['csbk','usbd','data-header','data-partial','mbc','tsbk','mbt','lc','hdu','crypt','lsd','header','bert','emb-lc','pi','block','resource','sysinfo','sync']);
const COMMS_GROUP_CALLS=new Set(['group','conference']);
const commsIsGroup=r=>COMMS_GROUP_CALLS.has(r.call) || r.group===true || r.group===1 || (typeof r.to==='string' && /^CQ/i.test(r.to));
// позывной D-STAR приходит то с суффиксом (N0CALL/TEST — в заголовке), то без (в конце передачи): абонент — позывной до «/»
const commsId=(v,src)=>v==null || v==='' ? null : src==='D-STAR' ? String(v).split('/')[0].trim() : String(v);

// запись → сообщение {t, src, type, from, to, text, lat, lon, ...} или null; sig — брать и сигнализацию
function commsMessage(r,sig){
  if(!r || typeof r!=='object' || !r.src) return null;
  const base=(type,extra)=>({t:r.t, src:r.src, kind:'message', type, from:commsId(r.from,r.src), to:commsId(r.to,r.src), rec:r.kind, ...extra});
  const k=r.kind;
  if(r.src==='DMR' && k==='message')                                       // SMS / TMS, LRRP, IP / UDP, NMEA
    return base(r.lat!=null ? 'location' : r.message!=null ? 'text' : 'data', {text:r.message!=null ? String(r.message) : r.data||'', service:r.service, group:!!r.group, slot:r.slot, cc:r.cc, lat:r.lat, lon:r.lon,
      speed:r.speed, heading:r.heading, ip:r.ip, port:r.port, crc:r.crc, hex:r.data});
  if(r.src==='P25' && k==='pdu' && r.crc!=='none'){                        // многоблочные данные; llid — источник (IO=0) или получатель (IO=1)
    const from=r.io ? null : r.llid, to=r.io ? r.llid : null;
    return base(r.lat!=null ? 'location' : r.message!=null ? 'text' : 'data', {from:commsId(from ?? r.extSrc), to:commsId(to), text:r.message!=null ? String(r.message) : r.hex ? String(r.hex).slice(0,64) : '',
      service:r.service||r.sapName, nac:r.nac, lat:r.lat, lon:r.lon, ip:r.ip, port:r.port, crc:r.crc, hex:r.hex});
  }
  if(r.src==='NXDN' && k==='msg' && /^(SD|D)CALL_/.test(r.msg||''))       // короткие данные / вызов данных: текста нет, только заголовок
    return base('data', {text:r.msg+(r.hex ? ' '+r.hex : ''), service:r.msg, ran:r.ran, hex:r.hex});
  if(r.src==='M17' && k==='packet')
    return base(r.message!=null ? 'text' : 'data', {text:r.message!=null ? String(r.message) : r.hex||'', service:'proto '+r.proto, can:r.can, crc:r.crc, hex:r.hex});
  if(r.src==='TETRA' && k==='message')                                     // SDS: текст, статус, положение (LIP), данные
    return base(r.lat!=null ? 'location' : r.message!=null ? 'text' : 'data', {text:r.message!=null ? String(r.message) : r.lat!=null ? r.lat+', '+r.lon+(r.speed!=null ? ' · '+r.speed+' km/h' : '') : r.status!=null ? 'status 0x'+r.status.toString(16).toUpperCase().padStart(4,'0') : r.hex||'', service:r.service,
      lat:r.lat, lon:r.lon, speed:r.speed, heading:r.heading, hex:r.hex});
  if(r.src==='D-STAR' && k==='text') return base('text', {text:String(r.message), service:'slow data'});
  if(r.src==='D-STAR' && k==='gps'){
    const g=typeof dmrNmea==='function' ? dmrNmea(String(r.nmea||'')) : {};
    return base('location', {text:String(r.nmea||''), service:'slow data', lat:g.lat, lon:g.lon, speed:g.speed, heading:g.heading, alt:g.alt});
  }
  if(r.src==='YSF' && k==='gps') return base('location', {text:r.text, service:'GPS '+(r.radio||''), lat:r.lat, lon:r.lon});
  if(sig && (COMMS_SIGNAL.has(k) || k==='msg' || k==='call' || k==='end' || k==='alias'))
    return base('signalling', {text:r.text||k, service:r.name||r.msg||r.type||k, slot:r.slot, cc:r.cc, nac:r.nac, ran:r.ran});
  return null;
}

// запись → наблюдения {radios: [{id, alias, role, seconds}], groups: [{id, role}], ...}: role — tx | rx; seconds — по записи end
function commsWho(r){
  const k=r.kind, out={radios:[], groups:[], call:false};
  if(!r.src) return out;
  const from=commsId(r.from,r.src), to=commsId(r.to,r.src);
  let lat=r.lat, lon=r.lon;
  if(k==='gps' && r.nmea!=null && typeof dmrNmea==='function'){ const g=dmrNmea(String(r.nmea||'')); lat=g.lat; lon=g.lon; }        // D-STAR: NMEA из слоудаты
  const dest=(id)=>{ if(id==null) return; if(commsIsGroup(r)) out.groups.push({id, role:'rx'}); else out.radios.push({id, role:'rx'}); };
  if(k==='call' || (k==='header' && !r.packet) || k==='end' || k==='message' || k==='pdu' || k==='msg' || k==='alias' || k==='text' || k==='gps' || k==='packet' || k==='data-header'){
    const s=k==='pdu' ? (r.io ? null : commsId(r.llid)) : from;
    if(s!=null) out.radios.push({id:s, role:'tx', alias:r.alias, seconds:k==='end' ? +r.seconds||0 : 0, call:k==='call', end:k==='end', lat, lon, msg:k==='message' || k==='pdu' || k==='packet' || k==='text' || k==='gps' || k==='data-header'});
    if(k==='pdu' && r.io && r.llid!=null) out.radios.push({id:commsId(r.llid), role:'rx'});
    else if(k!=='alias' && k!=='pdu') dest(to);
    if(r.src==='D-STAR' && k==='call' && r.rpt1) out.via=String(r.rpt1).trim();
    if(r.src==='YSF' && k==='call') out.via=[r.downlink, r.uplink].filter(Boolean).join(' / ')||undefined;
  }
  return out;
}

/* ---- Messages ---- */
const COMMS_PROTOS=['all','DMR','P25','NXDN','dPMR','YSF','M17','D-STAR','TETRA'];
function commsMsgRow(m){
  return {time:new Date(m.t).toISOString(), protocol:m.src, type:m.type, from:m.from||'', to:m.to||'', text:m.text||'', service:m.service||'', lat:m.lat ?? '', lon:m.lon ?? '', ip:m.ip||'', crc:m.crc||'', slot:m.slot||'', cc:m.cc ?? m.nac ?? m.ran ?? m.can ?? ''};
}
def({ id:'msgLog', title:'Messages', cat:'Output',
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'msgs',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true, resize:true, w:480,
  params:[{n:'proto',t:'select',opts:COMMS_PROTOS,d:'all',label:'protocol'},
          {n:'sig',t:'check',d:false,label:'signalling too (trunking, headers, encryption sync)'},
          {n:'max',t:'range',min:100,max:100000,step:100,d:5000,label:'max messages kept'},
          {n:'csv',t:'button',label:'Save CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv(n.rows.map(commsMsgRow))],{type:'text/csv;charset=utf-8'}),'messages-'+Date.now()+'.csv')},
          {n:'replay',t:'button',label:'Replay',fn:n=>{ n.replay=n.rows.slice(); }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.rows=[]; }}],
  init:n=>{ n.rows=[]; n.replay=null; n.n={}; },
  process(n,I){
    const out=[];
    for(const r of recList(I.rec)){
      if(n.p.proto!=='all' && r.src!==n.p.proto) continue;
      const m=commsMessage(r,n.p.sig);
      if(!m) continue;
      n.rows.push(m); out.push(m); n.n[m.src]=(n.n[m.src]||0)+1;
    }
    if(n.rows.length>n.p.max) n.rows.splice(0,n.rows.length-n.p.max);
    if(n.replay?.length) out.push(...n.replay.splice(0,500));
    return {msgs:out.length ? out : null, count:n.rows.length};
  },
  draw(n){
    const fmt=t=>new Date(t).toLocaleTimeString();
    const head='messages '+n.rows.length+(Object.keys(n.n).length ? ' · '+Object.entries(n.n).map(([k,v])=>k+' '+v).join(' · ') : '');
    const tail=n.rows.slice(-12).map(m=>fmt(m.t)+' '+m.src+' '+(m.from||'?')+(m.to ? ' → '+m.to : '')+' ['+m.type+'] '+(m.lat!=null ? m.lat+', '+m.lon+' ' : '')+String(m.text||'').slice(0,80));
    n.el.querySelector('.readout').textContent=head+(tail.length ? '\n'+tail.join('\n') : '\nwaiting for messages');
  }});

/* ---- Subscribers ---- */
function commsStation(n,proto,id,t){
  const key=proto+'|'+id;
  let s=n.st.get(key);
  if(!s){ s={proto, id, alias:'', calls:0, rx:0, seconds:0, msgs:0, first:t, last:t, tg:null, slot:null, cc:null, via:'', lat:null, lon:null}; n.st.set(key,s); }
  if(t>s.last) s.last=t;
  return s;
}
function commsStationRec(s){
  const r={t:s.last, src:s.proto, kind:'station', id:s.proto+':'+s.id, subscriber:s.id, alias:s.alias||undefined, label:s.alias ? s.alias+' ('+s.id+')' : s.id, calls:s.calls, heard_as_destination:s.rx, seconds:+s.seconds.toFixed(1),
    messages:s.msgs, tg:s.tg, via:s.via||undefined, first:s.first, last:s.last};
  if(s.lat!=null){ r.lat=s.lat; r.lon=s.lon; }
  return r;
}
function commsSubRows(n){
  return [...n.st.values()].map(s=>({protocol:s.proto, id:s.id, alias:s.alias, calls:s.calls, heard_as_destination:s.rx, seconds:+s.seconds.toFixed(1), messages:s.msgs, last_group:s.tg ?? '', via:s.via,
    lat:s.lat ?? '', lon:s.lon ?? '', first:new Date(s.first).toISOString(), last:new Date(s.last).toISOString()}));
}
function commsGroupRows(n){
  return [...n.gr.values()].map(g=>({protocol:g.proto, group:g.id, calls:g.calls, seconds:+g.seconds.toFixed(1), stations:g.stations.size, last:new Date(g.last).toISOString()}));
}
def({ id:'subLog', title:'Subscribers', cat:'Output',
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'stations',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true, resize:true, w:480,
  params:[{n:'proto',t:'select',opts:COMMS_PROTOS,d:'all',label:'protocol'},
          {n:'max',t:'range',min:100,max:100000,step:100,d:5000,label:'max subscribers kept'},
          {n:'csv',t:'button',label:'Subscribers CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv(commsSubRows(n))],{type:'text/csv;charset=utf-8'}),'subscribers-'+Date.now()+'.csv')},
          {n:'gcsv',t:'button',label:'Groups CSV',fn:n=>dl(new Blob(['﻿'+recsToCsv(commsGroupRows(n))],{type:'text/csv;charset=utf-8'}),'groups-'+Date.now()+'.csv')},
          {n:'replay',t:'button',label:'Replay stations',fn:n=>{ n.replay=[...n.st.values()].map(commsStationRec); }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.st=new Map(); n.gr=new Map(); }}],
  init:n=>{ n.st=new Map(); n.gr=new Map(); n.replay=null; },
  process(n,I){
    const touched=new Set();
    for(const r of recList(I.rec)){
      if(!r || !r.src || (n.p.proto!=='all' && r.src!==n.p.proto)) continue;
      const w=commsWho(r), t=r.t||Date.now();
      for(const x of w.radios){
        if(x.id==null) continue;
        const s=commsStation(n,r.src,x.id,t);
        if(x.role==='tx'){
          if(x.call) s.calls++;
          if(x.end) s.seconds+=x.seconds;
          if(x.msg) s.msgs++;
          if(x.alias) s.alias=String(x.alias);
          if(r.to!=null && r.kind==='call') s.tg=r.to;
          if(r.slot) s.slot=r.slot;
          if(w.via) s.via=w.via;
          if(x.lat!=null){ s.lat=x.lat; s.lon=x.lon; }
        } else if(r.kind==='call') s.rx++;
        touched.add(s);
      }
      for(const x of w.groups){
        const key=r.src+'|'+x.id;
        let g=n.gr.get(key);
        if(!g){ g={proto:r.src, id:x.id, calls:0, seconds:0, stations:new Set(), last:t}; n.gr.set(key,g); }
        g.last=Math.max(g.last,t);
        if(r.kind==='call'){ g.calls++; if(r.from!=null) g.stations.add(String(r.from)); }
        if(r.kind==='end') g.seconds+=+r.seconds||0;
      }
    }
    if(n.st.size>n.p.max){ const old=[...n.st.entries()].sort((a,b)=>a[1].last-b[1].last).slice(0,n.st.size-n.p.max); for(const [k] of old) n.st.delete(k); }
    let st=[...touched].map(commsStationRec);
    if(n.replay?.length) st=st.concat(n.replay.splice(0,500));
    return {stations:st.length ? st : null, count:n.st.size};
  },
  draw(n){
    const fmt=t=>new Date(t).toLocaleTimeString();
    const top=[...n.st.values()].sort((a,b)=>b.last-a.last).slice(0,10).map(s=>s.proto+' '+s.id+(s.alias ? ' "'+s.alias+'"' : '')+'  ×'+s.calls+' · '+s.seconds.toFixed(0)+' s'+(s.msgs ? ' · '+s.msgs+' msg' : '')+(s.lat!=null ? ' · ⌖' : '')+'  '+fmt(s.last));
    const grp=[...n.gr.values()].sort((a,b)=>b.last-a.last).slice(0,5).map(g=>g.proto+' '+g.id+'  ×'+g.calls+' · '+g.stations.size+' stations');
    n.el.querySelector('.readout').textContent='subscribers '+n.st.size+' · groups '+n.gr.size+(top.length ? '\n'+top.join('\n') : '\nwaiting for calls')+(grp.length ? '\n— groups —\n'+grp.join('\n') : '');
  }});
