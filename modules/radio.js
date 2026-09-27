"use strict";
/* ============================ ИНТЕРНЕТ-РАДИО (Radio Browser) ============================ */
// radio-browser.info — открытая общественная база станций, публичный API.
// Поиск по названию/тегу/стране → список в IndexedDB (дальше офлайн) → станции на карту.
// Выбор (клик на карте → select, или имя в параметре) отдаёт адрес потока на url → 'stream'.
// Станции без координат ставятся в центр страны (с разбросом, чтобы не слипались).

const RB_FALLBACK=['de1.api.radio-browser.info','de2.api.radio-browser.info','fi1.api.radio-browser.info'];
let rbServerP=null;
function rbServer(){
  return rbServerP || (rbServerP=(async()=>{
    try{
      const r=await fetch('https://all.api.radio-browser.info/json/servers');
      const a=(await r.json()).map(s=>s.name).filter(Boolean);
      if(a.length) return a[Math.floor(Math.random()*a.length)];
    }catch(e){}
    return RB_FALLBACK[Math.floor(Math.random()*RB_FALLBACK.length)];
  })());
}
function rbCompact(s){
  const lat=parseFloat(s.geo_lat), lon=parseFloat(s.geo_long);
  return {id:s.stationuuid, name:(s.name||'').trim(), url:s.url_resolved||s.url||'', home:s.homepage||'',
    cc:(s.countrycode||'').toUpperCase(), country:s.country||'', state:s.state||'', lang:s.language||'',
    tags:(s.tags||'').slice(0,80), codec:s.codec||'', br:s.bitrate|0, votes:s.votes|0, clicks:s.clickcount|0,
    ...(isFinite(lat) && isFinite(lon) && !(lat===0 && lon===0) ? {lat, lon} : {})};
}
function rbHash(s){ let h=2166136261; for(const c of s) h=Math.imul(h^c.charCodeAt(0),16777619); return h>>>0; }
function rbPos(s){
  if(s.lat!=null) return {lat:s.lat, lon:s.lon, approx:0};
  const c=GeoBase.data?.countryLabels.find(c=>c.a2===s.cc);
  if(!c) return null;
  const h=rbHash(s.id), a=(h%3600)/10*D2R, r=0.15+((h>>12)%100)/100*1.2;   // до ~1.3° от центра
  return {lat:c.lat+r*Math.sin(a), lon:c.lon+r*Math.cos(a)/Math.max(0.2,Math.cos(c.lat*D2R)), approx:1};
}
async function rbSearch(n){
  n.msg='searching…';
  try{
    const srv=n.p.server.trim() || await rbServer();
    const q=new URLSearchParams({hidebroken:'true', order:'clickcount', reverse:'true', limit:String(n.p.limit|0)});
    if(n.p.name.trim()) q.set('name',n.p.name.trim());
    if(n.p.tag.trim()) q.set('tag',n.p.tag.trim());
    if(n.p.cc.trim()) q.set('countrycode',n.p.cc.trim().toUpperCase());
    if(n.p.geo) q.set('has_geo_info','true');
    const r=await fetch('https://'+srv+'/json/stations/search?'+q); if(!r.ok) throw new Error('HTTP '+r.status);
    const list=(await r.json()).map(rbCompact).filter(s=>s.url);
    n.list=list; n.src=srv+' · '+new Date().toISOString().slice(0,16).replace('T',' ');
    n.emitKey=''; n.msg='';
    geoPut('radio:list',{list,src:n.src}).catch(()=>{});
  }catch(e){ n.msg='search failed: '+e.message; }
}
function rbFiltered(n){                           // зовётся каждый блок — кэш по списку и флагу
  const https=n.p.https && location.protocol==='https:';
  if(n.visList!==n.list || n.visHttps!==https){
    n.visList=n.list; n.visHttps=https;
    n.vis=https ? n.list.filter(s=>s.url.startsWith('https:')) : n.list;
  }
  return n.vis;
}
function rbSelect(n,s){
  n.sel=s; n.selUrl=s.url;
  setMod(n,'station',s.name);
  // счётчик прослушиваний — так просит документация API
  rbServer().then(srv=>fetch('https://'+(n.p.server.trim()||srv)+'/json/url/'+encodeURIComponent(s.id)).catch(()=>{}));
}

def({ id:'radioDir', title:'Internet Radio', cat:'Sources',
  ins:[{n:'select',t:'rec'}],                          // клик на карте (выход sel)
  outs:[{n:'rec',t:'rec'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'count',t:'num'}],
  readout:true, tall:true, w:340,
  params:[{n:'name',t:'text',d:'',label:'name contains'},
          {n:'tag',t:'text',d:'',label:'tag (jazz, news, …)'},
          {n:'cc',t:'text',d:'',label:'country code (RU, DE, …)'},
          {n:'limit',t:'range',min:50,max:10000,step:50,d:1000,label:'max stations'},
          {n:'geo',t:'check',d:false,label:'with coordinates only'},
          {n:'https',t:'check',d:true,label:'https streams only'},
          {n:'search',t:'button',label:'🔍 Search',fn:n=>rbSearch(n)},
          {n:'station',t:'text',d:'',label:'station (name, or click on the map)'},
          {n:'server',t:'text',d:'',label:'API server (empty — random mirror)',adv:true}],
  init:n=>{ n.list=[]; n.src=''; n.msg=''; n.emitKey=''; n.sel=null; n.selUrl=''; n.lastStation=n.p.station;
    geoGet('radio:list').then(v=>{ if(v && !n.list.length){ n.list=v.list; n.src=v.src; n.emitKey=''; } }).catch(()=>{}); },
  process(n,I){
    for(const r of recList(I.select)){
      const id=String(r.id||''); if(!id.startsWith('radio:')) continue;
      const s=n.list.find(x=>x.id===id.slice(6)); if(s){ rbSelect(n,s); n.lastStation=n.p.station; }
    }
    if(n.p.station!==n.lastStation){                  // имя ввели руками
      n.lastStation=n.p.station;
      const q=n.p.station.trim().toLowerCase();
      const s=q && (n.list.find(x=>x.name.toLowerCase()===q) || n.list.find(x=>x.name.toLowerCase().includes(q)));
      if(s && s!==n.sel){ rbSelect(n,s); n.lastStation=n.p.station; }
    }
    const vis=rbFiltered(n);
    let rec=null;
    const key=n.src+'|'+vis.length+'|'+n.p.https+'|'+GeoBase.state+'|'+(n.sel?.id||'');
    if(key!==n.emitKey && GeoBase.state==='ready'){
      n.emitKey=key;
      rec=[];
      for(const s of vis){
        const p=rbPos(s); if(!p) continue;
        rec.push({id:'radio:'+s.id, label:s.name, icon:'♪', color:s===n.sel ? '#ffd84a' : p.approx ? '#c890ff' : '#ff8fb1',
          size:s===n.sel ? 10 : 7, lat:+p.lat.toFixed(4), lon:+p.lon.toFixed(4), ...(p.approx?{approx:1}:{}),
          country:s.country, ...(s.state?{state:s.state}:{}), ...(s.lang?{lang:s.lang}:{}), ...(s.tags?{tags:s.tags}:{}),
          codec:s.codec+(s.br?' '+s.br+'k':''), votes:s.votes, url:s.url, ...(s.home?{home:s.home}:{})});
      }
      if(!rec.length) rec=null;
    }
    return {rec, url:n.selUrl||null, name:n.sel?.name||null, count:vis.length};
  },
  draw(n){
    const vis=n.list.length ? rbFiltered(n).length : 0, s=n.sel;
    const L=[];
    if(n.msg) L.push(n.msg);
    L.push(n.list.length ? n.src+' · '+n.list.length+' found'+(vis!==n.list.length?' · '+vis+' playable here':'') :
      'set a filter and press Search (radio-browser.info)');
    if(n.p.https && location.protocol==='https:' && n.list.length) L.push('http:// streams are hidden: an https page cannot play them');
    if(s) L.push('▶ '+s.name+'\n  '+[s.country,s.state,s.lang].filter(Boolean).join(' · ')+'\n  '+s.codec+(s.br?' '+s.br+' kbps':'')+
      (s.tags?' · '+s.tags:'')+'\n  '+s.url);
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
