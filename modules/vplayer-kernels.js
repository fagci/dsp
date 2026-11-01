"use strict";
/* ============================ Video Player: ядро (без DOM) ============================
   Список источников (строки Table: name, url), тип адреса, сохранённая позиция просмотра по адресу, время в тексте. */

// тип источника по адресу: HLS (.m3u8) / DASH (.mpd) / «native» — то, чего нет у <video> браузера и что играет нативный плеер приложения
// (udp:// и rtp:// multicast, rtsp://, контейнеры mkv / avi / ts / mpg / flv / wmv) / обычный файл
function vpKind(url){
  const s=String(url||'');
  if(/^magnet:/i.test(s)) return 'torrent';
  if(/^(udp|rtp|rtsp):/i.test(s)) return 'native';
  const u=s.split(/[?#]/)[0].toLowerCase();
  if(/\.torrent$/.test(u)) return 'torrent';
  if(/\.m3u8?$/.test(u)) return 'hls';
  if(/\.mpd$/.test(u)) return 'dash';
  if(/\.(mkv|avi|ts|m2ts|mts|mpg|mpeg|vob|flv|wmv|rmvb)$/.test(u)) return 'native';
  return 'file';
}
// адреса, которые страница принимает: сеть (http / https), blob, multicast / rtsp (играет нативный плеер приложения) и торренты (magnet: / .torrent — через приложение)
const VP_URL_RE=/^(https?:|blob:|udp:|rtp:|rtsp:|magnet:)/i;
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
    if(!VP_URL_RE.test(url)) continue;
    const name=String(r.name ?? r.title ?? '').trim() || vpMagnetName(url) || url.replace(/^https?:\/\//,'').slice(0,60);
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
const VP_IA_KINDS={'any video':'mediatype:movies','movies & films':'collection:moviesandfilms','open source movies':'collection:opensource_movies','film noir':'collection:film_noir','silent films':'collection:silent_films','news & public affairs':'collection:newsandpublicaffairs','Prelinger archives':'collection:prelinger','feature films':'collection:feature_films','cartoons':'collection:animationandcartoons','classic TV':'collection:classic_tv','TV series (shows)':'collection:television','sci-fi & horror':'collection:SciFi_Horror','short films':'collection:short_films'};
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
// метаданные предмета (archive.org/metadata/ID) → проигрываемые файлы. Файлы одной серии (то же имя без расширения и суффиксов
// _512kb / .ia) — разные форматы одного видео: основной — самый «безопасный» для браузера (h.264 — производный файл Архива,
// оригинал может быть DivX / MPEG-4 Part 2, который браузер не играет), остальные идут в alt (адреса через пробел) — запасные
const VP_IA_RANK=[/h\.?264/i,/512kb\s*mpeg4|_512kb\.mp4$/i,/mpeg-?4|\.mp4$|\.m4v$/i,/webm/i,/ogg video|\.ogv$/i];
function vpIaFiles(meta,id){
  const files=meta && Array.isArray(meta.files) ? meta.files : [];
  const groups=new Map();
  for(const f of files){
    const nm=String(f.name||''); if(!/\.(mp4|m4v|webm|ogv)$/i.test(nm)) continue;
    if(/^__ia_thumb/.test(nm) || /\.thumbs\//.test(nm)) continue;
    const key=nm.replace(/\.[^.]+$/,'').replace(/(\.ia|_512kb|_h264|_hd)$/i,'');
    let r=VP_IA_RANK.findIndex(x=>x.test((f.format||'')+' '+nm));
    if(r<0) r=9;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push({f,r});
  }
  const md=meta && meta.metadata || {};
  const title=String(Array.isArray(md.title) ? md.title[0] : md.title||id);
  const dl=f=>'https://archive.org/download/'+encodeURIComponent(id)+'/'+String(f.name).split('/').map(encodeURIComponent).join('/');
  const list=[...groups.entries()].map(([key,c])=>{
    c.sort((x,y)=>x.r-y.r || (x.f.name<y.f.name ? -1 : 1));
    const f=c[0].f, base=key.split('/').pop().replace(/_+/g,' ').trim();
    const row={name:String(f.title||base||f.name),file:f.name,url:dl(f),size:+f.size||0,length:+f.length||0};
    if(c.length>1) row.alt=c.slice(1).map(x=>dl(x.f)).join(' ');
    return row;
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
    {name:'Subaru Outback On Street And Dirt',url:g('SubaruOutbackOnStreetAndDirt'),group:'Car reviews'},
    {name:'Volkswagen GTI Review',url:g('VolkswagenGTIReview'),group:'Car reviews'},
    {name:'We Are Going On Bullrun',url:g('WeAreGoingOnBullrun'),group:'Car reviews'},
    {name:'What car can you get for a grand?',url:g('WhatCarCanYouGetForAGrand'),group:'Car reviews'},
    {name:'The Pink Panther cartoons (Internet Archive)',url:'https://archive.org/details/ThePinkPanther-cartoons',group:'Internet Archive'},
    {name:'Big Buck Bunny (torrent)',url:'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969',group:'Torrent (app)'},
    {name:'Sintel (torrent)',url:'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969',group:'Torrent (app)'},
    {name:'Tears of Steel (torrent)',url:'magnet:?xt=urn:btih:209c8226b299b308beaf2b9cd3fb49212dbd13ec&dn=Tears+of+Steel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969',group:'Torrent (app)'},
    {name:'Cosmos Laundromat (torrent)',url:'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&dn=Cosmos+Laundromat&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969',group:'Torrent (app)'},
    {name:'Big Buck Bunny (HLS)',url:'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',group:'HLS test'},
    {name:'Sintel (HLS, bitdash)',url:'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',group:'HLS test'},
    {name:'Apple bip-bop (HLS)',url:'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',group:'HLS test'},
    {name:'Blazes',url:g('ForBiggerBlazes'),series:ser,season:1,episode:1,group:'Sample series'},
    {name:'Escapes',url:g('ForBiggerEscapes'),series:ser,season:1,episode:2,group:'Sample series'},
    {name:'Fun',url:g('ForBiggerFun'),series:ser,season:1,episode:3,group:'Sample series'},
    {name:'Joyrides',url:g('ForBiggerJoyrides'),series:ser,season:1,episode:4,group:'Sample series'},
    {name:'Meltdowns',url:g('ForBiggerMeltdowns'),series:ser,season:1,episode:5,group:'Sample series'}];
})();

// ссылка на страницу предмета Архива (не на файл): archive.org/details/ID
const vpIsIaPage=u=>/^https?:\/\/(www\.)?archive\.org\/details\/[^\/?#]+\/?(\?|#|$)/i.test(String(u||'').trim());
// причина ошибки <video> по коду MediaError
function vpMediaErr(code){ return ({1:'aborted',2:'network error (the address is unreachable or the server refused)',3:'the video is damaged or uses a codec the browser cannot decode',4:'the format is not supported or the address does not give a video file'})[code] || 'cannot be played'; }

/* ---------- ещё каталоги ---------- */
// Wikimedia Commons: видео (webm / ogv / mp4), прямые адреса файлов
const VP_WM_MIME=/^(video\/(webm|ogg|mp4)|application\/ogg)$/i;
function vpWmSearchUrl(q,rows){
  const text=String(q||'').trim().replace(/\s+/g,' ')||'film';
  return 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit='+(rows>0 ? Math.min(rows,50) : 30)+'&gsrsearch='+encodeURIComponent('filetype:video '+text)+'&prop=imageinfo&iiprop='+encodeURIComponent('url|mime|size|extmetadata')+'&format=json&origin=*';
}
function vpWmItems(json){
  const pages=json && json.query && json.query.pages; if(!pages) return [];
  return Object.values(pages).sort((a,b)=>(a.index||0)-(b.index||0)).map(pg=>{
    const ii=pg.imageinfo && pg.imageinfo[0]; if(!ii || !ii.url || !VP_WM_MIME.test(ii.mime||'')) return null;
    const em=ii.extmetadata||{}, nm=String(pg.title||'').replace(/^File:/i,'').replace(/\.[^.]+$/,'').replace(/_/g,' ');
    return {name:nm,url:ii.url,mime:ii.mime,size:ii.size||0,page:'https://commons.wikimedia.org/wiki/'+encodeURIComponent(String(pg.title||'').replace(/ /g,'_')),group:'Wikimedia Commons',license:String(em.LicenseShortName&&em.LicenseShortName.value||'')};
  }).filter(Boolean);
}
// PeerTube (поиск SepiaSearch по всем открытым серверам): результаты → строки с id «сервер/uuid»; файлы — со страницы видео сервера
function vpPtSearchUrl(q,rows){
  return 'https://sepiasearch.org/api/v1/search/videos?search='+encodeURIComponent(String(q||'').trim()||'film')+'&count='+(rows>0 ? Math.min(rows,100) : 30)+'&sort=-match';
}
function vpPtItems(json){
  const d=json && Array.isArray(json.data) ? json.data : [];
  return d.map(v=>{
    let host=v.account && v.account.host || ''; if(!host){ try{ host=new URL(v.url).host; }catch(e){} }
    if(!host || !v.uuid) return null;
    return {id:host+'/'+v.uuid,name:String(v.name||v.uuid),duration:v.duration||0,channel:String(v.channel && (v.channel.displayName||v.channel.name)||''),url:v.url||'',group:host};
  }).filter(Boolean);
}
const vpPtId=v=>{ const m=/^(?:peertube:)?([a-z0-9.\-]+\.[a-z]{2,})\/([\w\-]+)$/i.exec(String(v||'').trim()); return m ? {host:m[1],uuid:m[2]} : null; };
function vpPtFiles(json,host,uuid){
  if(!json) return [];
  const name=String(json.name||uuid), out=[];
  const pl=json.streamingPlaylists && json.streamingPlaylists[0];
  if(pl && pl.playlistUrl) out.push({name,url:pl.playlistUrl});
  const fl=(json.files||[]).filter(f=>f.fileUrl).sort((a,b)=>Math.abs((a.resolution&&a.resolution.id||0)-720)-Math.abs((b.resolution&&b.resolution.id||0)-720));
  if(fl.length){ if(out.length) out[0].alt=fl.map(f=>f.fileUrl).join(' '); else out.push({name,url:fl[0].fileUrl,alt:fl.slice(1).map(f=>f.fileUrl).join(' ')}); }
  return out.map(o=>o.alt ? o : {name:o.name,url:o.url});
}
// iptv-org: страна (две буквы), язык (три) или категория; списки на iptv-org.github.io
const VP_IPTV_CATS=['animation','classic','comedy','cooking','culture','documentary','education','entertainment','family','general','kids','legislative','lifestyle','movies','music','news','outdoor','relax','religious','science','series','shop','sports','travel','weather'];
function vpIptvUrl(v){
  const s=String(v||'').trim().toLowerCase().replace(/[^a-z]/g,'');
  if(VP_IPTV_CATS.includes(s)) return 'https://iptv-org.github.io/iptv/categories/'+s+'.m3u';
  if(s.length===3) return 'https://iptv-org.github.io/iptv/languages/'+s+'.m3u';
  return VP_IPTV_URL(s);
}

/* ---------- торренты (через приложение Android: команды torrent.* моста, TorrentHub.kt) ---------- */
// «magnet:…#file=2» → {base:'magnet:…', file:2}; без #file — file:null (в торренте одно видео или нужен выбор)
function vpTorrentRef(url){
  const m=/^(.*?)#file=(\d+)$/.exec(String(url||'').trim());
  return m ? {base:m[1],file:+m[2]} : {base:String(url||'').trim(),file:null};
}
// название из magnet (dn=…)
function vpMagnetName(url){
  const m=/^magnet:\?.*?[?&]dn=([^&#]*)/i.exec(String(url||'')) || /^magnet:\?dn=([^&#]*)/i.exec(String(url||''));
  if(!m) return '';
  try{ return decodeURIComponent(m[1].replace(/\+/g,' ')); }catch(e){ return m[1]; }
}
// ответ torrent.add {name, files:[{i,name,size,video}]} → строки для плеера: по одному на видеофайл, серии (S01E02, «3 серия») разбираются из имён;
// адрес строки — адрес торрента + #file=номер: по нему хранится позиция просмотра, и он не зависит от порта локального сервера
function vpTorrentRows(url,reply){
  const base=vpTorrentRef(url).base, files=Array.isArray(reply && reply.files) ? reply.files : [];
  const vids=files.filter(f=>f && f.video);
  const many=vids.length>1;
  return vids.map(f=>({name:String(f.name||('file '+f.i)).replace(/\.[^.]+$/,'').replace(/[._]+/g,' ').trim(),url:base+'#file='+f.i,size:f.size||0,...(many ? {series:String(reply.name||'')} : {})}));
}
// строка состояния раздачи: «37 % · ↓ 1.2 MB/s · 14 peers»
function vpTorrentLine(st){
  if(!st) return '';
  const f=n=>n>=1048576 ? (n/1048576).toFixed(1)+' MB/s' : Math.round(n/1024)+' kB/s';
  const stl=String(st.state||'');
  if(stl==='starting' || stl==='checking_files' || stl==='checking_resume_data') return 'torrent: starting…';
  if(stl==='downloading_metadata') return 'torrent: looking for the metadata…';
  const peers=+st.peers||0;
  return 'torrent: '+Math.round((+st.progress||0)*100)+' % of the torrent · ↓ '+f(+st.down||0)+' · '+peers+' peer'+(peers===1 ? '' : 's')+(+st.seeds ? ' ('+st.seeds+' seeds)' : '')+(peers===0 ? ' — no peers yet'+(st.dht!=null ? ' (DHT nodes: '+(+st.dht||0)+')' : '')+(st.trk ? '\ntrackers: '+st.trk : '') : '');
}
// торрент предмета Internet Archive (peers вместо сервера Архива); файлы раскроются в плеере
const vpIaTorrentUrl=id=>'https://archive.org/download/'+encodeURIComponent(id)+'/'+encodeURIComponent(id)+'_archive.torrent';

// btih из magnet (hex 40 или base32 32 → hex 40, нижний регистр); '' — нет
function vpMagnetHash(url){
  const m=/[?&]xt=urn:btih:([0-9A-Za-z]{32,40})/i.exec(String(url||'')); if(!m) return '';
  const h=m[1]; if(h.length===40) return h.toLowerCase(); if(h.length!==32) return '';
  const al='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits=0, acc=0, out='';
  for(const ch of h.toUpperCase()){ const v=al.indexOf(ch); if(v<0) return ''; acc=((acc<<5)|v)&0xFFFFFF; bits+=5; if(bits>=8){ bits-=8; out+=((acc>>bits)&255).toString(16).padStart(2,'0'); } }
  return out;
}
// строка состояния поиска метаданных: «DHT: 87 узлов · пиров: 2»
function vpTorrentSearchLine(st,secs){
  const dht=+(st&&st.dht)||0, peers=+(st&&st.peers)||0;
  return 'torrent: looking for the metadata — '+Math.round(secs)+' s · DHT nodes: '+dht+' · peers: '+peers+(secs>20 && dht===0 ? ' (DHT is silent: UDP blocked or no network?)' : secs>40 && peers===0 ? ' (no peers yet — a rare torrent, wait or try another)' : '');
}
