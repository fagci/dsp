"use strict";
/* ============================ Podcasts / Webcams / Free Music: разбор ответов ============================
   Без DOM и сети — проверяется tools/test-online.mjs. */

const OL_ENT={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
const olDecode=s=>String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>{
  if(e[0]==='#'){ const c=e[1]==='x'||e[1]==='X' ? parseInt(e.slice(2),16) : +e.slice(1); try{ return String.fromCodePoint(c); }catch(x){ return m; } }
  return OL_ENT[e.toLowerCase()] ?? m; });
// текст тега: CDATA как есть, остальное с сущностями; HTML внутри описания убираем
function olTag(block,name){
  const m=block.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i'));
  if(!m) return '';
  const c=m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (c ? c[1] : olDecode(m[1])).trim();
}
function olAttr(block,name,attr){
  const m=block.match(new RegExp('<'+name+'\\s([^>]*)>','i'));
  if(!m) return '';
  const a=m[1].match(new RegExp('(?:^|\\s)'+attr+'\\s*=\\s*("([^"]*)"|\'([^\']*)\')','i'));
  return a ? olDecode(a[2] ?? a[3]) : '';
}
// «1:02:03», «12:30», «3600» → секунды
function olDur(s){
  s=String(s||'').trim(); if(!s) return 0;
  const p=s.split(':').map(Number);
  if(p.some(x=>!isFinite(x))) return 0;
  return p.reduce((a,x)=>a*60+x,0);
}
function olFmtDur(sec){
  sec=Math.round(sec||0); if(sec<=0) return '';
  const h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60;
  return h ? h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0') : m+':'+String(s).padStart(2,'0');
}
const olDate=s=>{ const t=Date.parse(s); return isFinite(t) ? new Date(t).toISOString().slice(0,10) : ''; };

// RSS 2.0 подкаста → {title, author, image, items:[{n,label,url,date,dur,size,link}]}; новые выпуски первыми, как в ленте
function olFeed(xml){
  xml=String(xml||'');
  if(!/<(rss|channel)[\s>]/i.test(xml)) return null;
  const i0=xml.search(/<item[\s>]/i), head=i0<0 ? xml : xml.slice(0,i0);
  const items=[];
  const re=/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi; let m;
  while((m=re.exec(xml))){
    const b=m[1];
    const url=olAttr(b,'enclosure','url');
    if(!/^https?:\/\//i.test(url)) continue;
    items.push({n:items.length+1, label:olTag(b,'title'), url, date:olDate(olTag(b,'pubDate')),
      dur:olDur(olTag(b,'itunes:duration')), size:+olAttr(b,'enclosure','length')||0, link:olTag(b,'link')});
  }
  return {title:olTag(head,'title'), author:olTag(head,'itunes:author'), image:olAttr(head,'itunes:image','href'), items};
}

// iTunes Search API (media=podcast) → строки подкастов
function olItunes(j){
  const out=[];
  for(const r of j?.results||[]){
    if(!r.feedUrl) continue;
    out.push({id:'pod:'+r.collectionId, label:r.collectionName||r.trackName||'', url:r.feedUrl, artist:r.artistName||'',
      genre:r.primaryGenreName||'', country:r.country||'', episodes:r.trackCount|0, home:r.collectionViewUrl||''});
  }
  return out;
}

// Openverse /v1/audio/ → дорожки (url — сам файл)
function olOpenverse(j){
  const out=[];
  for(const r of j?.results||[]){
    if(!/^https?:\/\//i.test(r.url||'')) continue;
    out.push({id:'ov:'+r.id, label:r.title||'', url:r.url, artist:r.creator||'', dur:Math.round((r.duration||0)/1000),
      genre:(r.genres||[]).join(', '), license:String(r.license||'').toUpperCase()+(r.license_version ? ' '+r.license_version : ''),
      source:r.source||r.provider||'', home:r.foreign_landing_url||''});
  }
  return out;
}

// Internet Archive: advancedsearch → записи (набор файлов), metadata → дорожки записи
function olArchiveItems(j){
  const out=[];
  for(const d of j?.response?.docs||[]){
    if(!d.identifier) continue;
    const cr=Array.isArray(d.creator) ? d.creator.join(', ') : d.creator||'';
    out.push({id:'ia:'+d.identifier, label:Array.isArray(d.title) ? d.title[0] : d.title||d.identifier, ident:d.identifier,
      artist:cr, downloads:d.downloads|0, home:'https://archive.org/details/'+d.identifier});
  }
  return out;
}
const OL_AUDIO=[/\.mp3$/i,/\.ogg$/i,/\.flac$/i];
function olArchiveFiles(meta,ident){
  const files=(meta?.files||[]).filter(f=>f.name && !/spectrogram|_64kb|\.m3u/i.test(f.name));
  let pick=[];
  for(const re of OL_AUDIO){ pick=files.filter(f=>re.test(f.name)); if(pick.length) break; }
  const base=meta?.metadata?.title;
  return pick.map((f,i)=>({n:i+1, id:'ia:'+ident+'/'+f.name, label:f.title||f.name.replace(/\.[^.]+$/,''),
    url:'https://archive.org/download/'+encodeURIComponent(ident)+'/'+f.name.split('/').map(encodeURIComponent).join('/'),
    artist:f.creator||(Array.isArray(meta?.metadata?.creator) ? meta.metadata.creator.join(', ') : meta?.metadata?.creator)||'',
    dur:olDur(f.length), album:Array.isArray(base) ? base[0] : base||''}));
}

// адрес камеры → тип: image (снимок), mjpeg (поток кадров), hls, page (страница сайта)
function olCamKind(url){
  const p=String(url||'').split(/[?#]/)[0].toLowerCase();
  if(/\.m3u8?$/.test(p)) return 'hls';
  if(/\.(jpe?g|png|gif|webp|bmp)$/.test(p)) return 'image';
  if(/\.(mjpe?g|mjpg)$/.test(p) || /mjpe?g|videostream|\/video\.cgi|faststream/i.test(String(url))) return 'mjpeg';
  return 'page';
}
// Overpass (out center tags) → веб-камеры OSM: contact:webcam у любого объекта и man_made=surveillance + surveillance:type=webcam
function olWebcams(j){
  const out=[], seen=new Set();
  for(const e of j?.elements||[]){
    const t=e.tags||{};
    const url=t['contact:webcam'] || (t['surveillance:type']==='webcam' ? (t.url||t.website||t['contact:website']||'') : '');
    const lat=e.lat ?? e.center?.lat, lon=e.lon ?? e.center?.lon;
    if(!/^https?:\/\//i.test(url) || lat==null || lon==null || seen.has(url)) continue;
    seen.add(url);
    out.push({id:'cam:'+e.type[0]+e.id, label:t.name||t['name:en']||t.description||t.ref||t.tourism||t.natural||'webcam', url,
      kind:olCamKind(url), lat:+lat.toFixed(5), lon:+lon.toFixed(5), ...(t.operator?{operator:t.operator}:{})});
  }
  return out;
}
function olWebcamQuery(lat,lon,rKm,limit){
  const dl=rKm/111.2, dn=rKm/(111.2*Math.max(.1,Math.cos(lat*Math.PI/180))), f=x=>+x.toFixed(4);
  const a='('+[f(lat-dl),f(lon-dn),f(lat+dl),f(lon+dn)]+')';
  return '[out:json][timeout:25];(nwr["contact:webcam"]'+a+';nwr["man_made"="surveillance"]["surveillance:type"="webcam"]'+a+';);out center tags '+(limit|0)+';';
}
// первый целый JPEG (FFD8 … FFD9) в куске MJPEG-потока; null — ещё не пришёл
function olJpegFrame(b){
  for(let s=0;s+2<b.length;s++){
    if(b[s]!==0xFF || b[s+1]!==0xD8 || b[s+2]!==0xFF) continue;
    for(let e=s+2;e+1<b.length;e++) if(b[e]===0xFF && b[e+1]===0xD9) return b.subarray(s,e+2);
    return null;
  }
  return null;
}

// выбор из списка: число (1-based), id, адрес или часть названия → индекс с 1, 0 — нет
function olFind(list,v){
  if(!list?.length || v==null || v==='') return 0;
  if(typeof v==='number' || /^\d+$/.test(String(v).trim())) { const i=+v; return i>=1 && i<=list.length ? i : 0; }
  const s=String(v).trim().toLowerCase();
  let i=list.findIndex(c=>String(c.id||'').toLowerCase()===s || c.url===v || String(c.label||'').toLowerCase()===s);
  if(i<0) i=list.findIndex(c=>String(c.label||'').toLowerCase().includes(s));
  return i+1;
}
