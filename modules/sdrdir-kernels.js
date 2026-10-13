"use strict";
/* ============================ Ядро каталога SDR-приёмников ============================
   Списки публичных KiwiSDR и SpyServer → записи карты {id,lat,lon,label,kind,server,…}. Без DOM — tools/test-sdrdir.mjs.
   Форматы каталогов восстановлены по памяти и не сверены с живыми ответами: разбор терпимый к именам полей. */

const SD_NUM=v=>{ const x=typeof v==='number' ? v : parseFloat(v); return isFinite(x) ? x : null; };

// "(55.9, 37.6)" | "55.9,37.6" | {lat,lon} | [lat,lon]
function sdGps(v){
  if(v==null) return null;
  let a,b;
  if(Array.isArray(v)){ a=SD_NUM(v[0]); b=SD_NUM(v[1]); }
  else if(typeof v==='object'){ a=SD_NUM(v.lat ?? v.latitude); b=SD_NUM(v.lon ?? v.lng ?? v.longitude); }
  else { const m=String(v).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/); if(!m) return null; a=+m[1]; b=+m[2]; }
  if(a==null || b==null || Math.abs(a)>90 || Math.abs(b)>180 || (a===0 && b===0)) return null;
  return {lat:a, lon:b};
}

function sdHostPort(s,port){
  s=String(s||'').trim().replace(/^[a-z]+:\/\//i,'').replace(/[\/?#].*$/,'');
  const m=s.match(/^(.+):(\d+)$/);
  const host=m ? m[1] : s, p=m ? +m[2] : SD_NUM(port);
  return host ? {host, port:p} : null;
}

// массив объектов где угодно в JSON; «var x = [...];» и мусор вокруг допустимы
function sdExtractArray(text){
  text=String(text||'').trim();
  try{ const f=sdFindArray(JSON.parse(text)); if(f) return f; }catch(e){}
  const a=text.indexOf('['), b=text.lastIndexOf(']');
  if(a>=0 && b>a){
    const body=text.slice(a,b+1).replace(/[\x00-\x1f]/g,' ').replace(/,\s*\]$/,']');           // хвостовая запятая в kiwisdr_com.js
    try{ const f=sdFindArray(JSON.parse(body)); if(f) return f; }catch(e){}
    const objs=[];                                                  // запасной путь: объекты по одному
    for(const m of body.matchAll(/\{[^{}]*\}/g)){ try{ objs.push(JSON.parse(m[0])); }catch(e){} }
    if(objs.length) return objs;
  }
  const c=text.indexOf('{'), d=text.lastIndexOf('}');
  if(c>=0 && d>c){ try{ return sdFindArray(JSON.parse(text.slice(c,d+1))); }catch(e){} }
  return null;
}
function sdFindArray(j,depth=0){
  if(Array.isArray(j)) return j.length && typeof j[0]==='object' ? j : (j.length ? null : j);
  if(j && typeof j==='object' && depth<3) for(const k of Object.keys(j)){ const f=sdFindArray(j[k],depth+1); if(f && f.length) return f; }
  return null;
}

// страница kiwisdr.com/public/: у каждого приёмника HTML-комментарий с «key=value» строками (name=, gps=(lat, lon), users=, …)
function sdKiwiHtml(text){
  const out=[];
  const blocks=String(text).match(/<!--[\s\S]*?-->/g)||[];
  for(const b of blocks){
    if(!/gps\s*=/.test(b)) continue;
    const kv={}; for(const m of b.matchAll(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/gim)) kv[m[1].toLowerCase()]=m[2];
    const link=b.match(/https?:\/\/[^\s'"<>]+/);
    kv.url=kv.url ?? kv.addr ?? (link && link[0]);
    out.push(kv);
  }
  return out;
}

const sdPick=(o,keys)=>{ for(const k of keys) if(o[k]!=null && o[k]!=='') return o[k]; return null; };

function sdRecord(o,kind){
  if(String(o.offline).toLowerCase()==='yes' || String(o.status).toLowerCase()==='offline') return null;
  const pos=sdGps(sdPick(o,['gps','location_gps','coordinates','coords','latlon'])) ||
            sdGps({lat:sdPick(o,['lat','latitude']), lon:sdPick(o,['lon','lng','longitude'])});
  if(!pos) return null;
  const hp=sdHostPort(sdPick(o,['url','address','addr','host','hostname','streamingHost','ip','server']), sdPick(o,['port','streamingPort']));
  if(!hp) return null;
  const port=hp.port ?? (kind==='kiwisdr' ? 8073 : 5555);
  const server=hp.host+':'+port;
  const name=String(sdPick(o,['name','title','description','label']) ?? server).replace(/\s+/g,' ').trim();
  const users=SD_NUM(sdPick(o,['users','clients','connected'])), max=SD_NUM(sdPick(o,['users_max','maxUsers','max_users','slots','maxClients']));
  const loc=sdPick(o,['loc','location','city']);
  const r={id:kind+':'+server, lat:pos.lat, lon:pos.lon, kind, server, host:hp.host, port, name, label:name, track:0,
           color:kind==='kiwisdr' ? '#f59e0b' : '#38bdf8'};
  if(users!=null) r.users=users;
  if(max!=null) r.usersMax=max;
  if(loc!=null && typeof loc!=='object') r.loc=String(loc);
  const hw=sdPick(o,['sdr_hw','hardware','device','sdr']); if(hw!=null && typeof hw!=='object') r.hw=String(hw);
  const bands=sdPick(o,['bands','freq_range']); if(bands!=null && typeof bands!=='object') r.bands=String(bands);
  const snr=SD_NUM(sdPick(o,['snr','snr_all'])); if(snr!=null) r.snr=snr;
  const ant=sdPick(o,['antenna','ant']); if(ant!=null && typeof ant!=='object') r.antenna=String(ant);
  return r;
}

// kind: 'kiwisdr' | 'spyserver'
function sdParse(text,kind){
  let items=sdExtractArray(text);
  if(!items || !items.length) items=sdKiwiHtml(text);
  const seen=new Set(), out=[];
  for(const o of items){
    if(!o || typeof o!=='object') continue;
    const r=sdRecord(o,kind); if(!r || seen.has(r.id)) continue;
    seen.add(r.id); out.push(r);
  }
  return out;
}

// фильтр: свободные места, подстрока в названии/месте
function sdFilter(list,{free=false,q=''}={}){
  q=String(q||'').trim().toLowerCase();
  return list.filter(r=>{
    if(free && r.usersMax!=null && r.users!=null && r.users>=r.usersMax) return false;
    if(q && !(r.name+' '+(r.loc||'')+' '+r.server).toLowerCase().includes(q)) return false;
    return true;
  });
}
