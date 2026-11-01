"use strict";
/* ============================ Video Player: ядро (без DOM) ============================
   Список источников (строки Table: name, url), тип адреса, сохранённая позиция просмотра по адресу, время в тексте. */

// тип источника по адресу: HLS (.m3u8) / DASH (.mpd) / обычный файл
function vpKind(url){
  const u=String(url||'').split(/[?#]/)[0].toLowerCase();
  if(/\.m3u8?$/.test(u)) return 'hls';
  if(/\.mpd$/.test(u)) return 'dash';
  return 'file';
}
// строки Table → [{name,url,...}] (колонки url / link / src, name / title); без адреса http(s) строка пропускается
function vpSources(rows){
  const out=[];
  for(const r of Array.isArray(rows) ? rows : []){
    if(!r || typeof r!=='object') continue;
    const url=String(r.url ?? r.link ?? r.src ?? '').trim();
    if(!/^(https?:|blob:)/i.test(url)) continue;
    out.push({...r,url,name:String(r.name ?? r.title ?? '').trim() || url.replace(/^https?:\/\//,'').slice(0,60)});
  }
  return out;
}
// номер (с 1), название или адрес → индекс в списке (-1 — нет)
function vpFind(list,v){
  if(v==null || v==='') return -1;
  if(typeof v==='number' || /^\d+$/.test(String(v).trim())){ const i=Math.round(+v)-1; return i>=0 && i<list.length ? i : -1; }
  const s=String(v).trim().toLowerCase();
  let i=list.findIndex(c=>c.url===v || c.name.toLowerCase()===s);
  if(i<0) i=list.findIndex(c=>c.name.toLowerCase().includes(s));
  return i;
}
// с какой секунды начинать: запись о просмотре {pos,dur}. Начало (< 5 с) и конец (≥ 95 % или < 15 с до конца) — с нуля
function vpResume(e){
  if(!e || !(e.pos>=5)) return 0;
  if(e.dur>0 && (e.pos>=e.dur*.95 || e.dur-e.pos<15)) return 0;
  return e.pos;
}
// положить позицию в хранилище {url:{pos,dur,name,t}}; больше cap записей — старейшие по t уходят. Возвращает запись (или null — не сохранять)
function vpPut(map,url,pos,dur,name,now,cap){
  if(!url || !(pos>=0)) return null;
  const done= dur>0 && pos>=dur*.95;
  const e={pos:Math.round(pos*10)/10,dur:dur>0 ? Math.round(dur*10)/10 : 0,name:name||'',t:now,done};
  map[url]=e;
  const keys=Object.keys(map);
  if(keys.length>(cap||300)){
    keys.sort((a,b)=>(map[a].t||0)-(map[b].t||0));
    for(const k of keys.slice(0,keys.length-(cap||300))) delete map[k];
  }
  return e;
}
// 3725 → «1:02:05», 65 → «1:05»
function vpFmt(s){
  if(!(s>=0) || !isFinite(s)) return '0:00';
  s=Math.floor(s); const h=Math.floor(s/3600), m=Math.floor(s/60)%60, x=s%60;
  return (h ? h+':'+String(m).padStart(2,'0') : m)+':'+String(x).padStart(2,'0');
}
// перемотка с ограничением [0, dur]
function vpSeek(cur,delta,dur){
  let t=cur+delta; if(!(t>0)) t=0;
  if(dur>0 && t>dur) t=dur;
  return t;
}
// запись о просмотре → строка Table (ключ url)
function vpRec(url,name,e){
  return {url,name:name||e.name||'',pos:e.pos,dur:e.dur,pct:e.dur>0 ? Math.round(e.pos/e.dur*1000)/10 : 0,done:e.done ? 1 : 0,t:e.t};
}
