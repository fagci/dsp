"use strict";
/* ============================ РАСПИСАНИЯ КВ-СТАНЦИЙ ============================ */
// Форматы:
//  • EiBi (eibispace.de, sked-XNN.csv): "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;"
//    строки вида "6000;0000-0100;;CUB;R Habana Cuba;S;NAm;;1;;". В Remarks "/XXX" — страна передатчика (ретрансляция).
//  • свой CSV с заголовком: freq|khz|kHz, start/end или time (HHMM-HHMM), days, station|name, lang, target, itu,
//    lat, lon, remarks — порядок колонок любой, разделитель , ; или таб.
// Координаты: lat/lon из файла, иначе центр страны передатчика по коду ITU (грубо — для азимута и расстояния).

const SKED_DAYS={MO:0,TU:1,WE:2,TH:3,FR:4,SA:5,SU:6};
// дни недели → битовая маска (бит 0 — понедельник); 0 — каждый день или непонятно (показываем всегда)
function skedDays(s){
  s=String(s||'').trim().toUpperCase();
  if(!s) return 0;
  if(/^[1-7]+$/.test(s)){ let m=0; for(const c of s) m|=1<<(+c-1); return m; }
  let m=0;
  for(const part of s.split(/[,/ ]+/)){
    const r=part.match(/^(MO|TU|WE|TH|FR|SA|SU)(?:-(MO|TU|WE|TH|FR|SA|SU))?$/);
    if(!r) continue;
    const a=SKED_DAYS[r[1]], b=r[2]!=null ? SKED_DAYS[r[2]] : a;
    for(let d=a;;d=(d+1)%7){ m|=1<<d; if(d===b) break; }
  }
  return m;
}
function skedTime(s){                                  // "0000-2400" → [0,1440] минут
  const m=String(s||'').match(/(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})/);
  if(!m) return null;
  return [(+m[1])*60+(+m[2]), (+m[3])*60+(+m[4])];
}
function skedOnAir(e,now){
  const d=new Date(now), min=d.getUTCHours()*60+d.getUTCMinutes();
  const wd=(d.getUTCDay()+6)%7;                        // 0 — понедельник
  let on;
  if(e.t0<=e.t1) on=min>=e.t0 && min<e.t1;
  else on=min>=e.t0 || min<e.t1;                       // через полночь
  if(!on) return false;
  if(!e.days) return true;
  // для передач через полночь после 00:00 день — вчерашний
  const day=(e.t0>e.t1 && min<e.t1) ? (wd+6)%7 : wd;
  return !!(e.days&(1<<day));
}

// Коды стран ITU (как в EiBi), отличающиеся от ISO3, и точки без отдельной страны в подложке
const SKED_ITU={ALG:'DZA',AFS:'ZAF',AGL:'AGO',ARS:'SAU',B:'BRA',BOT:'BWA',BUL:'BGR',CLM:'COL',CLN:'LKA',
  CME:'CMR',CTI:'CIV',CVA:'VAT',D:'DEU',E:'ESP',EQA:'ECU',F:'FRA',G:'GBR',HNG:'HUN',HOL:'NLD',I:'ITA',
  INS:'IDN',J:'JPN',KRE:'PRK',MLA:'MYS',MLD:'MDV',MRC:'MAR',MTN:'MRT',MYA:'MMR',NGR:'NER',NIG:'NGA',
  NMB:'NAM',OMA:'OMN',POR:'PRT',PRG:'PRY',PRU:'PER',RRW:'RWA',S:'SWE',SNG:'SGP',SUI:'CHE',UAE:'ARE',
  URG:'URY',VTN:'VNM',MAU:'MUS',TCH:'TCD',GUI:'GIN',BFA:'BFA',BDI:'BDI',MWI:'MWI',LSO:'LSO',SWZ:'SWZ',
  KOS:'KOS',TWN:'TWN',ROU:'ROU',ISL:'ISL',IRL:'IRL'};
const SKED_PTS={ASC:[-7.95,-14.37],GUM:[13.44,144.79],HWA:[21.31,-157.86],ALS:[61.2,-149.9],MRA:[15.2,145.75],
  REU:[-21.11,55.53],CNR:[28.1,-15.4],AZR:[37.74,-25.67],MDR:[32.65,-16.91],BER:[32.3,-64.78],
  PTR:[18.22,-66.59],VIR:[18.34,-64.9],GRL:[64.18,-51.72],SAP:[-7.2,72.4],DGA:[-7.3,72.4]};
function skedItuPos(itu){
  itu=String(itu||'').trim().toUpperCase();
  if(!itu) return null;
  if(SKED_PTS[itu]) return {lat:SKED_PTS[itu][0], lon:SKED_PTS[itu][1]};
  const D=GeoBase.data; if(!D) return null;
  const a3=SKED_ITU[itu]||itu;
  const c=D.countryLabels.find(c=>c.a3===a3);
  return c ? {lat:c.lat, lon:c.lon} : null;
}

function skedParse(text){
  const t=text.replace(/^﻿/,'');
  const nl=t.indexOf('\n'), head=(nl<0?t:t.slice(0,nl)).trim();
  const out=[];
  if(/^kHz:\d+;/i.test(head)){                          // EiBi
    for(const line of t.slice(nl+1).split('\n')){
      const c=line.replace(/\r$/,'').split(';');
      if(c.length<5) continue;
      const khz=parseFloat(c[0]), tm=skedTime(c[1]);
      if(!isFinite(khz) || !tm) continue;
      const rem=(c[7]||'').trim(), site=rem.match(/\/([A-Z]{1,3})\b/);
      out.push({khz, t0:tm[0], t1:tm[1], time:c[1].trim(), days:skedDays(c[2]), daysTxt:(c[2]||'').trim(),
        itu:(c[3]||'').trim(), station:(c[4]||'').trim(), lang:(c[5]||'').trim(), target:(c[6]||'').trim(),
        remarks:rem, txItu:site ? site[1] : (c[3]||'').trim()});
    }
    return out;
  }
  const rows=geoCsvParse(t,'');
  const h=(rows.shift()||[]).map(s=>s.trim().toLowerCase());
  const ix=(...ks)=>{ for(const k of ks){ const i=h.indexOf(k); if(i>=0) return i; } return -1; };
  const iF=ix('khz','freq','frequency','f'), iT=ix('time','utc'), iS=ix('start','from'), iE=ix('end','stop','to'),
        iD=ix('days','day'), iN=ix('station','name'), iL=ix('lang','language','lng'), iG=ix('target'),
        iI=ix('itu','country'), iLa=ix('lat','latitude'), iLo=ix('lon','lng','longitude'), iR=ix('remarks','note','notes');
  if(iF<0) throw new Error('no frequency column (khz / freq)');
  const hhmm=v=>{ const m=String(v||'').match(/(\d{1,2}):?(\d{2})/); return m ? (+m[1])*60+(+m[2]) : null; };
  for(const r of rows){
    let khz=parseFloat(r[iF]); if(!isFinite(khz)) continue;
    if(khz>1e5) khz/=1000;                             // указали в Гц
    let t0=0, t1=1440, time='0000-2400';
    if(iT>=0 && skedTime(r[iT])){ [t0,t1]=skedTime(r[iT]); time=r[iT].trim(); }
    else if(iS>=0 && iE>=0 && hhmm(r[iS])!=null && hhmm(r[iE])!=null){ t0=hhmm(r[iS]); t1=hhmm(r[iE]); time=r[iS]+'-'+r[iE]; }
    const e={khz, t0, t1, time, days:iD>=0 ? skedDays(r[iD]) : 0, daysTxt:iD>=0 ? r[iD] : '',
      station:iN>=0 ? r[iN] : '', lang:iL>=0 ? r[iL] : '', target:iG>=0 ? r[iG] : '',
      itu:iI>=0 ? r[iI] : '', remarks:iR>=0 ? r[iR] : ''};
    e.txItu=e.itu;
    const la=iLa>=0 ? parseFloat(r[iLa]) : NaN, lo=iLo>=0 ? parseFloat(r[iLo]) : NaN;
    if(isFinite(la) && isFinite(lo)){ e.lat=la; e.lon=lo; }
    out.push(e);
  }
  return out;
}

function skedColor(lang){                              // цвет по языку — стабильный хэш
  let h=0; for(const c of String(lang||'')) h=(h*31+c.charCodeAt(0))|0;
  return `hsl(${((h%360)+360)%360},65%,62%)`;
}
function skedLine(e){
  return (String(e.khz).padStart(6))+' kHz  '+e.time+(e.daysTxt?' '+e.daysTxt:'')+'  '+e.station+
    (e.lang?' ['+e.lang+']':'')+(e.target?' → '+e.target:'')+(e.txItu?' ('+e.txItu+')':'');
}

def({ id:'sked', title:'Station Schedule', cat:'Radio',
  // Какая станция сейчас в эфире: метки на спектре (bands → 'sa'), список на частоте настройки,
  // передатчики на карту (rec) с расстоянием и азимутом от своей позиции.
  ins:[{n:'freq',t:'num'}],
  outs:[{n:'bands',t:'bands'},{n:'now',t:'txt'},{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true, w:360,
  params:[{n:'tol',t:'range',min:0.1,max:50,step:0.1,d:5,label:'match ±, kHz'},
          {n:'filter',t:'text',d:'',label:'filter (station, language, target, ITU)'},
          {n:'lo',t:'num',d:0,label:'bands from, kHz (0 — all)'},
          {n:'hi',t:'num',d:0,label:'bands to, kHz'},
          {n:'file',t:'file',accept:'.csv,.txt,text/csv,text/plain',fn:(n,f)=>{
            const rd=new FileReader(); rd.onload=()=>skedLoadText(n,String(rd.result),f.name); rd.readAsText(f); }},
          {n:'url',t:'text',d:'',label:'URL (EiBi: …/dx/sked-a26.csv)',adv:true},
          {n:'proxy',t:'text',d:'',label:'CORS proxy prefix (if the site has no CORS)',adv:true},
          {n:'dl',t:'button',label:'Download from URL',fn:n=>skedDownload(n),adv:true},
          {n:'clr',t:'button',label:'Forget schedule',fn:n=>{ n.list=[]; n.src=''; geoPut('sked',null).catch(()=>{}); n.key=''; },adv:true}],
  init:n=>{
    n.list=[]; n.src=''; n.msg=''; n.key=''; n.bands=[]; n.onAir=[]; n.nowTxt=''; n.recQ=null; n.lastRecKey='';
    geoGet('sked').then(v=>{ if(v && !n.list.length){ n.list=v.list; n.src=v.src; n.key=''; } }).catch(()=>{});
  },
  process(n,I){
    const now=Date.now(), minute=Math.floor(now/60000);
    const f=typeof I.freq==='number' && isFinite(I.freq) ? I.freq/1000 : null;   // вход — Гц
    const key=[minute,n.list.length,n.src,n.p.filter,n.p.lo,n.p.hi,GeoBase.state,GeoMe.lat,GeoMe.lon].join('|');
    if(key!==n.key){ n.key=key; skedUpdate(n,now); }
    const fk=f!=null ? Math.round(f*10)+'|'+n.p.tol+'|'+minute : 'none';
    if(fk!==n.fKey){
      n.fKey=fk;
      if(f==null) n.nowTxt='';
      else {
        const hit=n.onAir.filter(e=>Math.abs(e.khz-f)<=n.p.tol).sort((a,b)=>Math.abs(a.khz-f)-Math.abs(b.khz-f));
        n.nowTxt=hit.length ? hit.slice(0,20).map(skedLine).join('\n') : '';
      }
    }
    const rec=n.recQ; n.recQ=null;
    return {bands:n.bands, now:n.nowTxt, rec, count:n.onAir.length};
  },
  draw(n){
    const r=n.el.querySelector('.readout');
    const head=(n.msg?n.msg+'\n':'')+(n.list.length ? n.src+' · '+n.list.length+' entries · on air '+n.onAir.length :
      'load a schedule: EiBi CSV or your own CSV (khz, time, station, …)');
    r.textContent=head+(n.nowTxt ? '\n— on the tuned frequency —\n'+n.nowTxt : '');
  }});
function skedMatch(e,q){
  if(!q) return true;
  const s=(e.station+' '+e.lang+' '+e.target+' '+e.itu+' '+e.txItu+' '+e.remarks).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w=>s.includes(w));
}
function skedUpdate(n,now){
  const lo=+n.p.lo||0, hi=+n.p.hi||0;
  n.onAir=n.list.filter(e=>skedOnAir(e,now) && skedMatch(e,n.p.filter));
  const vis=n.onAir.filter(e=>(!lo || e.khz>=lo) && (!hi || e.khz<=hi));
  n.bands=vis.slice(0,3000).map(e=>({lo:e.khz*1000, hi:e.khz*1000, step:0,
    label:e.khz+' '+e.station+(e.lang?' '+e.lang:''), color:skedColor(e.lang)}));
  // передатчики: одна запись на станцию+страну передатчика, частоты списком
  const tx=new Map();
  for(const e of vis){
    const pos=e.lat!=null ? {lat:e.lat,lon:e.lon} : skedItuPos(e.txItu);
    if(!pos) continue;
    const id='tx:'+e.station+'/'+(e.txItu||'');
    let t=tx.get(id);
    if(!t){ t={t:now, id, label:e.station, icon:'tx', color:skedColor(e.lang), lat:pos.lat, lon:pos.lon,
      station:e.station, itu:e.txItu, lang:e.lang, target:e.target, khz:[], approx:e.lat==null ? 1 : 0};
      if(GeoMe.lat!=null){ t.dist_km=Math.round(geoDist(GeoMe.lat,GeoMe.lon,pos.lat,pos.lon));
        t.az=Math.round(geoBearing(GeoMe.lat,GeoMe.lon,pos.lat,pos.lon)); }
      tx.set(id,t); }
    if(!t.khz.includes(e.khz)) t.khz.push(e.khz);
  }
  const recs=[...tx.values()].map(t=>({...t, khz:t.khz.sort((a,b)=>a-b).join(' ')}));
  const rk=recs.map(r=>r.id+r.khz).join('|');
  if(rk!==n.lastRecKey){ n.lastRecKey=rk; n.recQ=recs.length ? recs : null; }
}
function skedLoadText(n,text,src){
  try{
    const list=skedParse(text);
    if(!list.length) throw new Error('no entries recognised');
    n.list=list; n.src=src; n.key=''; n.msg='';
    geoPut('sked',{list,src}).catch(e=>{ n.msg='not saved: '+e.message; });
  }catch(e){ n.msg='error: '+e.message; }
}
async function skedDownload(n){
  const url=String(n.p.url||'').trim(); if(!url){ n.msg='enter URL'; return; }
  n.msg='downloading…';
  try{
    const r=await fetch((n.p.proxy||'')+url); if(!r.ok) throw new Error('HTTP '+r.status);
    // EiBi — в Latin-1
    const buf=await r.arrayBuffer();
    let text;
    try{ text=new TextDecoder('utf-8',{fatal:true}).decode(buf); }catch(e){ text=new TextDecoder('latin1').decode(buf); }
    skedLoadText(n,text,url.split('/').pop());
  }catch(e){ n.msg='download failed: '+e.message+' — the site may block cross-origin requests: set a CORS proxy or load the file'; }
}
