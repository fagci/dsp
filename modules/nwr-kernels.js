"use strict";
/* ============================ NOAA Weather Radio: передатчики и округа ============================
   Чистая логика без DOM (страница и Node) над данными nwr-data.js (NWR_TX, NWR_CTY; список NWS, tools/gen-nwr.mjs).
   Пара «округ → передатчики» ↔ «передатчик → округа»: nwrByCounty ↔ nwrCounties (проверка кругом — tools/test-nwr.mjs);
   nwrNearest — ближайшие по координатам. Частоты: 162.400…162.550 МГц шагом 25 кГц — семь каналов WX1…WX7. */

const NWR_CH={'162.400':'WX1','162.425':'WX2','162.450':'WX3','162.475':'WX4','162.500':'WX5','162.525':'WX6','162.550':'WX7'};
const nwrHas=()=>typeof NWR_TX!=='undefined' && typeof NWR_CTY!=='undefined';
function nwrKm(la1,lo1,la2,lo2){
  const r=Math.PI/180, dl=(la2-la1)*r, dn=(lo2-lo1)*r;
  const a=Math.sin(dl/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dn/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(a)));
}
function nwrTx(call){
  if(!nwrHas()) return null;
  const t=NWR_TX[call]; if(!t) return null;
  return {call, freq:t[0], lat:t[1], lon:t[2], pwr:t[3], site:t[4], state:t[5], wfo:t[6], down:t[7]===1, ch:NWR_CH[t[0].toFixed(3)]||''};
}
const nwrLabel=t=>t.call+' '+t.freq.toFixed(3)+' MHz'+(t.ch ? ' ('+t.ch+')' : '')+' · '+t.site+', '+t.state+(t.down ? ' · off the air' : '');
// PSSCCC (часть округа не важна; «000» — весь штат) → передатчики: рабочие первыми, затем по расстоянию до pos={lat,lon} или по мощности
function nwrByCounty(loc,pos){
  if(!nwrHas()) return [];
  loc=String(loc).padStart(6,'0');
  let calls=NWR_CTY[loc] || NWR_CTY['0'+loc.slice(1)];                     // часть округа есть в данных — берём её, иначе округ целиком
  if(!calls && loc.slice(3)==='000'){ const ss=loc.slice(1,3); const set=new Set(); for(const k in NWR_CTY) if(k.slice(1,3)===ss) for(const c of NWR_CTY[k]) set.add(c); calls=[...set]; }
  const list=(calls||[]).map(nwrTx).filter(Boolean);
  if(pos && isFinite(pos.lat) && isFinite(pos.lon)) for(const t of list) t.dist=+nwrKm(pos.lat,pos.lon,t.lat,t.lon).toFixed(1);
  return list.sort((a,b)=>(a.down-b.down) || (a.dist!==undefined ? a.dist-b.dist : b.pwr-a.pwr) || (a.call<b.call ? -1 : 1));
}
// зеркало: передатчик → округа PSSCCC, которые он покрывает
function nwrCounties(call){
  if(!nwrHas()) return [];
  const out=[]; for(const k in NWR_CTY) if(NWR_CTY[k].includes(call)) out.push(k);
  return out;
}
function nwrNearest(lat,lon,n,opts){
  if(!nwrHas()) return [];
  const o=opts||{}, list=[];
  for(const c in NWR_TX){ const t=nwrTx(c); if(o.up && t.down) continue; t.dist=+nwrKm(lat,lon,t.lat,t.lon).toFixed(1); list.push(t); }
  return list.sort((a,b)=>a.dist-b.dist).slice(0,n||5);
}
// SAME-записи «…» → первый округ с передатчиком (для строки «слушать на …»)
function nwrFirst(locs,pos){
  for(const l of String(locs||'').split(/[\s,;-]+/).filter(x=>/^\d{6}$/.test(x))){ const r=nwrByCounty(l,pos); if(r.length) return r[0]; }
  return null;
}
