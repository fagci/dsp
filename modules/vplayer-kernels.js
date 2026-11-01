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
// серия и номер: колонки season / episode (s / e / ep) или разбор названия: S01E02, 1x02, «Episode 3», «3 серия», «Сезон 2»
function vpEpisode(name,row){
  const num=v=>{ const x=parseInt(v,10); return x>=0 ? x : null; };
  let s=row ? num(row.season ?? row.s) : null, e=row ? num(row.episode ?? row.ep ?? row.e) : null;
  const t=String(name||'');
  let m;
  if(s==null || e==null){
    if((m=/\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(t)) || (m=/\b(\d{1,2})x(\d{2,3})\b/.exec(t))){ if(s==null) s=+m[1]; if(e==null) e=+m[2]; }
  }
  if(e==null && ((m=/(?:episode|ep\.?|эпизод|серия)\s*[#№]?\s*(\d{1,3})/i.exec(t)) || (m=/(\d{1,3})\s*(?:серия|эпизод)/i.exec(t)))) e=+m[1];
  if(s==null && (m=/(?:season|сезон)\s*(\d{1,2})/i.exec(t) || /(\d{1,2})\s*сезон/i.exec(t))) s=+m[1];
  return e==null ? {s,e:null} : {s,e};
}
// строки Table → [{name,url,series,season,episode,...}] (колонки url / link / src, name / title, series / show); без адреса http(s) строка пропускается.
// Если у части строк есть номер серии — список упорядочивается: сериал (в порядке появления), сезон, серия
function vpSources(rows){
  const out=[];
  for(const r of Array.isArray(rows) ? rows : []){
    if(!r || typeof r!=='object') continue;
    const url=String(r.url ?? r.link ?? r.src ?? '').trim();
    if(!/^(https?:|blob:)/i.test(url)) continue;
    const name=String(r.name ?? r.title ?? '').trim() || url.replace(/^https?:\/\//,'').slice(0,60);
    const ep=vpEpisode(name,r);
    out.push({...r,url,name,series:String(r.series ?? r.show ?? '').trim(),season:ep.s,episode:ep.e});
  }
  if(!out.some(c=>c.episode!=null)) return out;
  const order=new Map(); out.forEach(c=>{ if(c.series && !order.has(c.series)) order.set(c.series,order.size); });
  return out.map((c,i)=>({c,i})).sort((a,b)=>{
    const sa=a.c.series ? order.get(a.c.series) : -1, sb=b.c.series ? order.get(b.c.series) : -1;
    return sa-sb || (a.c.season!=null && b.c.season!=null ? a.c.season-b.c.season : 0) || (a.c.episode==null)-(b.c.episode==null) || (a.c.episode??0)-(b.c.episode??0) || a.i-b.i; }).map(x=>x.c);
}
// подпись в списке: «S01E02 · название», «E05 · …»
function vpLabel(c){
  const t=c.episode!=null ? (c.season!=null ? 'S'+String(c.season).padStart(2,'0') : '')+'E'+String(c.episode).padStart(2,'0')+' · ' : '';
  return t+c.name;
}
// заголовок группы: «Сериал — сезон 1» (пусто — без группы)
function vpGroup(c){ return c.series ? c.series+(c.season!=null ? ' — S'+c.season : '') : ''; }
// «продолжить просмотр»: {i,pos} — последнее по времени из списка; досмотренное → следующий источник с нуля; нет — null
function vpContinue(list,map){
  let bi=-1, bt=-1;
  list.forEach((c,i)=>{ const e=map[c.url]; if(e && (e.t||0)>bt){ bt=e.t||0; bi=i; } });
  if(bi<0) return null;
  const e=map[list[bi].url];
  if(e.done) return bi+1<list.length ? {i:bi+1,pos:0} : null;
  return {i:bi,pos:vpResume(e)};
}
// метка просмотра для списка: ✓ досмотрено, ▸N % начато
function vpMark(e){
  if(!e) return '';
  if(e.done) return '✓ ';
  return e.dur>0 && e.pos>=5 ? '▸'+Math.round(e.pos/e.dur*100)+'% ' : '';
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
function vpRec(url,name,e,meta){
  return {url,name:name||e.name||'',...(meta && meta.series ? {series:meta.series,season:meta.season,episode:meta.episode} : {}),pos:e.pos,dur:e.dur,pct:e.dur>0 ? Math.round(e.pos/e.dur*1000)/10 : 0,done:e.done ? 1 : 0,t:e.t};
}

/* ---------- каталоги ---------- */
// Internet Archive: поиск → строки {id,name,year,downloads,url}; url — страница (не видеофайл)
const VP_IA_KINDS={'any video':'mediatype:movies','feature films':'collection:feature_films','cartoons':'collection:animationandcartoons','classic TV':'collection:classic_tv','TV series (shows)':'collection:television','sci-fi & horror':'collection:SciFi_Horror','short films':'collection:short_films'};
function vpIaSearchUrl(q,kind,rows){
  const f=VP_IA_KINDS[kind]||VP_IA_KINDS['any video'];
  const text=String(q||'').trim().replace(/["\\]/g,' ').replace(/\s+/g,' ').trim();
  const query=(text ? '('+text+') AND ' : '')+f+' AND mediatype:movies';
  return 'https://archive.org/advancedsearch.php?q='+encodeURIComponent(query)+'&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=downloads&sort%5B%5D='+encodeURIComponent(text ? 'downloads desc' : 'downloads desc')+'&rows='+(rows>0 ? Math.min(rows,200) : 50)+'&page=1&output=json';
}
function vpIaItems(json){
  const docs=json && json.response && json.response.docs; if(!Array.isArray(docs)) return [];
  return docs.filter(d=>d && d.identifier).map(d=>({id:d.identifier,name:String(Array.isArray(d.title) ? d.title[0] : d.title||d.identifier),year:d.year||'',downloads:d.downloads||0,url:'https://archive.org/details/'+d.identifier}));
}
// идентификатор из «id» или ссылки archive.org/details/ID
function vpIaId(v){
  const s=String(v||'').trim(); if(!s) return '';
  const m=/archive\.org\/(?:details|download|metadata)\/([^\/?#\s]+)/i.exec(s);
  if(m) return decodeURIComponent(m[1]);
  return /^[\w.\-]+$/.test(s) ? s : '';
}
// метаданные предмета (archive.org/metadata/ID) → проигрываемые файлы; по одному на имя без расширения (лучший формат)
const VP_IA_RANK=[/h\.?264|mpeg4|\.mp4$|\.m4v$/i,/webm/i,/ogg video|\.ogv$/i];
function vpIaFiles(meta,id){
  const files=meta && Array.isArray(meta.files) ? meta.files : [];
  const best=new Map();
  for(const f of files){
    const nm=String(f.name||''); if(!/\.(mp4|m4v|webm|ogv)$/i.test(nm)) continue;
    if(/\.(thumbs?|gif)$/i.test(nm) || /^__ia_thumb/.test(nm)) continue;
    const key=nm.replace(/\.[^.]+$/,'').replace(/\.(ia|512kb)$/i,'');
    let r=VP_IA_RANK.findIndex(x=>x.test(nm+' '+(f.format||'')));
    if(r<0) r=9;
    if(f.source==='original') r-=.5;
    const cur=best.get(key);
    if(!cur || r<cur.r) best.set(key,{f,r,key});
  }
  const md=meta && meta.metadata || {};
  const title=String(Array.isArray(md.title) ? md.title[0] : md.title||id);
  const list=[...best.values()].map(({f,key})=>{
    const base=key.split('/').pop().replace(/[_]+/g,' ').trim();
    return {name:String(f.title||base||f.name),file:f.name,url:'https://archive.org/download/'+encodeURIComponent(id)+'/'+String(f.name).split('/').map(encodeURIComponent).join('/'),
      size:+f.size||0,length:+f.length||0};
  });
  const rows=list.length>1 ? list.map(c=>({...c,series:title})) : list;
  rows.sort((a,b)=>{ const x=vpEpisode(a.name,null), y=vpEpisode(b.name,null);
    return (x.s!=null && y.s!=null ? x.s-y.s : 0) || (x.e??1e9)-(y.e??1e9) || (a.file<b.file ? -1 : a.file>b.file ? 1 : 0); });
  return rows;
}
// M3U (iptvParse) → строки; filter — слово в названии или группе, «-слово» исключает
function vpFilter(rows,filter){
  const ws=String(filter||'').toLowerCase().split(/\s+/).filter(Boolean); if(!ws.length) return rows;
  return rows.filter(r=>{ const t=((r.name||'')+' '+(r.group||'')+' '+(r.series||'')).toLowerCase();
    return ws.every(w=>w[0]==='-' ? w.length<2 || !t.includes(w.slice(1)) : t.includes(w)); });
}
const VP_IPTV_URL=cc=>'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/'+String(cc||'').trim().toLowerCase().replace(/[^a-z]/g,'').slice(0,3)+'.m3u';
// встроенные примеры (файлы и HLS; Google sample bucket, Mux / Apple test streams, Blender open movies) и пример сериала
const VP_SAMPLES=(()=>{
  const g=n=>'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/'+n+'.mp4';
  const ser='ForBigger (sample series)';
  return [
    {name:'Big Buck Bunny',url:g('BigBuckBunny'),group:'Blender open movies'},
    {name:'Elephants Dream',url:g('ElephantsDream'),group:'Blender open movies'},
    {name:'Sintel',url:g('Sintel'),group:'Blender open movies'},
    {name:'Tears of Steel',url:g('TearsOfSteel'),group:'Blender open movies'},
    {name:'Big Buck Bunny (HLS)',url:'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',group:'HLS test'},
    {name:'Sintel (HLS, bitdash)',url:'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',group:'HLS test'},
    {name:'Apple bip-bop (HLS)',url:'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',group:'HLS test'},
    {name:'Blazes',url:g('ForBiggerBlazes'),series:ser,season:1,episode:1,group:'Sample series'},
    {name:'Escapes',url:g('ForBiggerEscapes'),series:ser,season:1,episode:2,group:'Sample series'},
    {name:'Fun',url:g('ForBiggerFun'),series:ser,season:1,episode:3,group:'Sample series'},
    {name:'Joyrides',url:g('ForBiggerJoyrides'),series:ser,season:1,episode:4,group:'Sample series'},
    {name:'Meltdowns',url:g('ForBiggerMeltdowns'),series:ser,season:1,episode:5,group:'Sample series'}];
})();
