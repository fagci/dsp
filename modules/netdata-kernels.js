"use strict";
/* ============================ Open-Meteo / самолёты онлайн / OSM-объекты / Ollama: разбор ответов ============================
   Без DOM и сети — проверяется tools/test-netdata.mjs. Все сервисы без ключей:
   Open-Meteo (погода, высота), adsb.lol и OpenSky (самолёты рядом), Overpass (объекты OpenStreetMap), Ollama (локальная LLM). */

const ND_RAD=Math.PI/180;
// расстояние по большому кругу, км
function ndDist(la1,lo1,la2,lo2){
  const dp=(la2-la1)*ND_RAD, dl=(lo2-lo1)*ND_RAD;
  const a=Math.sin(dp/2)**2+Math.cos(la1*ND_RAD)*Math.cos(la2*ND_RAD)*Math.sin(dl/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(a)));
}
// азимут от первой точки ко второй, градусы 0..360
function ndBearing(la1,lo1,la2,lo2){
  const dl=(lo2-lo1)*ND_RAD, y=Math.sin(dl)*Math.cos(la2*ND_RAD);
  const x=Math.cos(la1*ND_RAD)*Math.sin(la2*ND_RAD)-Math.sin(la1*ND_RAD)*Math.cos(la2*ND_RAD)*Math.cos(dl);
  return (Math.atan2(y,x)/ND_RAD+360)%360;
}
const ndNum=v=>typeof v==='number' && isFinite(v) ? v : null;
const ndRound=(v,d=1)=>v==null ? null : Math.round(v*10**d)/10**d;
// сколько назад, по-человечески
function ndAgo(ms){
  if(!(ms>=0)) return '';
  const s=Math.round(ms/1000);
  if(s<60) return s+' s'; if(s<3600) return Math.round(s/60)+' min';
  if(s<172800) return Math.round(s/3600)+' h'; return Math.round(s/86400)+' d';
}
// простой хэш строки для ключа кэша (адрес и тело запроса могут быть длинными)
function ndHash(s){ let h=5381; s=String(s); for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0; return (h>>>0).toString(36); }

/* ---------- Open-Meteo ---------- */
const ND_WMO={0:'clear',1:'mostly clear',2:'partly cloudy',3:'overcast',45:'fog',48:'rime fog',51:'light drizzle',53:'drizzle',55:'heavy drizzle',
  56:'freezing drizzle',57:'freezing drizzle',61:'light rain',63:'rain',65:'heavy rain',66:'freezing rain',67:'freezing rain',
  71:'light snow',73:'snow',75:'heavy snow',77:'snow grains',80:'showers',81:'showers',82:'heavy showers',85:'snow showers',86:'snow showers',
  95:'thunderstorm',96:'thunderstorm, hail',99:'thunderstorm, heavy hail'};
const ndWmo=c=>ND_WMO[c] ?? (c==null ? '' : 'code '+c);
const ND_MET_VARS='temperature_2m,relative_humidity_2m,apparent_temperature,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code,is_day';
function ndMeteoUrl(lat,lon,base){
  return (base||'https://api.open-meteo.com')+'/v1/forecast?latitude='+ndRound(lat,4)+'&longitude='+ndRound(lon,4)+'&current='+ND_MET_VARS+'&wind_speed_unit=ms&timezone=UTC';
}
function ndElevUrl(lat,lon,base){ return (base||'https://api.open-meteo.com')+'/v1/elevation?latitude='+ndRound(lat,4)+'&longitude='+ndRound(lon,4); }
function ndElev(j){
  const e=Array.isArray(j?.elevation) ? j.elevation[0] : j?.elevation;
  return ndNum(e);
}
// ответ /v1/forecast → плоская запись; null, если это не он
function ndMeteo(j){
  const c=j && j.current; if(!c || typeof c!=='object') return null;
  const o={
    time:c.time||'', temp:ndNum(c.temperature_2m), feels:ndNum(c.apparent_temperature), hum:ndNum(c.relative_humidity_2m),
    press:ndNum(c.pressure_msl), pressStn:ndNum(c.surface_pressure), wind:ndNum(c.wind_speed_10m), dir:ndNum(c.wind_direction_10m),
    gust:ndNum(c.wind_gusts_10m), cloud:ndNum(c.cloud_cover), precip:ndNum(c.precipitation), code:ndNum(c.weather_code),
    day:c.is_day==null ? null : +!!c.is_day, elev:ndNum(j.elevation)};
  o.sky=ndWmo(o.code);
  return o;
}
// точка росы (Магнус), °C: пригодится для расчёта рефракции и тумана
function ndDew(t,h){
  if(t==null || h==null || h<=0) return null;
  const a=17.62, b=243.12, g=Math.log(h/100)+a*t/(b+t);
  return b*g/(a-g);
}
// стороны света для направления ветра
const ND_COMP=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const ndCompass=d=>d==null ? '' : ND_COMP[Math.round((((d%360)+360)%360)/22.5)%16];
function ndMeteoLines(m){
  if(!m) return [];
  const f=(v,u,d=0)=>v==null ? '—' : ndRound(v,d)+u;
  return ['🌡 '+f(m.temp,' °C',1)+(m.feels!=null ? ' (feels '+f(m.feels,' °C',1)+')' : '')+' · 💧 '+f(m.hum,' %')+' · '+m.sky,
    '🧭 '+f(m.press,' hPa')+' · 💨 '+f(m.wind,' m/s',1)+' '+ndCompass(m.dir)+(m.gust!=null ? ' (gusts '+f(m.gust,'',1)+')' : '')+' · ☁ '+f(m.cloud,' %')+' · ☔ '+f(m.precip,' mm',1)];
}

/* ---------- самолёты: adsb.lol и OpenSky ---------- */
const ND_FT=3.28084, ND_KT=1.943844, ND_FPM=196.8504;
// радиус в морских милях (adsb.lol: 1..250), bbox для OpenSky
function ndAcUrl(src,lat,lon,rKm){
  if(src==='opensky'){
    const dla=rKm/111.2, dlo=rKm/(111.2*Math.max(.05,Math.cos(lat*ND_RAD)));
    return 'https://opensky-network.org/api/states/all?lamin='+ndRound(lat-dla,3)+'&lomin='+ndRound(lon-dlo,3)+'&lamax='+ndRound(lat+dla,3)+'&lomax='+ndRound(lon+dlo,3);
  }
  const nm=Math.max(1,Math.min(250,Math.round(rKm/1.852)));
  return 'https://api.adsb.lol/v2/point/'+ndRound(lat,4)+'/'+ndRound(lon,4)+'/'+nm;
}
function ndAcColor(alt){ return alt==null ? '#9aa' : alt<=0 ? '#8c8' : alt<10000 ? '#ffd24a' : alt<25000 ? '#ff9f43' : '#ff6b6b'; }
function ndAcRow(o,lat,lon){
  if(o.lat==null || o.lon==null) return null;
  const d=lat!=null && lon!=null ? ndDist(lat,lon,o.lat,o.lon) : null;
  const label=(o.call||o.reg||o.hex.toUpperCase());
  return {id:'ac:'+o.hex, label, hex:o.hex, call:o.call, reg:o.reg, type:o.type, squawk:o.squawk, lat:o.lat, lon:o.lon,
    alt:o.alt, speed:o.speed, track:o.track, vrate:o.vrate, ground:o.ground?1:0, country:o.country||'',
    dist:ndRound(d,1), brg:d!=null ? Math.round(ndBearing(lat,lon,o.lat,o.lon)) : null,
    icon:'✈', color:o.ground ? '#8c8' : ndAcColor(o.alt), size:7, rot:o.track,
    info:[o.type,o.alt!=null ? Math.round(o.alt)+' ft' : '',o.speed!=null ? Math.round(o.speed)+' kt' : '',o.squawk?'sq '+o.squawk:''].filter(Boolean).join(' · ')};
}
// adsb.lol / ADSBExchange v2: {ac:[{hex,flight,r,t,alt_baro,gs,track,lat,lon,squawk,baro_rate}]}
function ndAdsbLol(j,lat,lon){
  const a=j && (j.ac||j.aircraft); if(!Array.isArray(a)) return null;
  const rows=[];
  for(const x of a){
    if(!x || !x.hex) continue;
    const ground=x.alt_baro==='ground';
    const r=ndAcRow({hex:String(x.hex).toLowerCase(),call:String(x.flight||'').trim(),reg:x.r||'',type:x.t||'',squawk:x.squawk||'',
      lat:ndNum(x.lat),lon:ndNum(x.lon),alt:ground ? 0 : ndNum(x.alt_baro) ?? ndNum(x.alt_geom),speed:ndNum(x.gs),track:ndNum(x.track),
      vrate:ndNum(x.baro_rate),ground},lat,lon);
    if(r) rows.push(r);
  }
  return rows.sort((p,q)=>(p.dist??1e9)-(q.dist??1e9));
}
// OpenSky: {states:[[icao24,callsign,country,t_pos,t_contact,lon,lat,baro_alt_m,on_ground,vel_ms,track,vrate_ms,sensors,geo_alt_m,squawk,…]]}
function ndOpenSky(j,lat,lon){
  if(!j || !('states' in j)) return null;
  const rows=[];
  for(const s of j.states||[]){
    if(!Array.isArray(s) || !s[0]) continue;
    const alt=ndNum(s[7]) ?? ndNum(s[13]);
    const r=ndAcRow({hex:String(s[0]).toLowerCase(),call:String(s[1]||'').trim(),reg:'',type:'',squawk:s[14]||'',country:s[2]||'',
      lat:ndNum(s[6]),lon:ndNum(s[5]),alt:s[8] ? 0 : alt==null ? null : alt*ND_FT,speed:ndNum(s[9])==null ? null : s[9]*ND_KT,
      track:ndNum(s[10]),vrate:ndNum(s[11])==null ? null : s[11]*ND_FPM,ground:!!s[8]},lat,lon);
    if(r) rows.push(r);
  }
  return rows.sort((p,q)=>(p.dist??1e9)-(q.dist??1e9));
}
const ndAircraft=(src,j,lat,lon)=>src==='opensky' ? ndOpenSky(j,lat,lon) : ndAdsbLol(j,lat,lon);

/* ---------- Overpass: объекты OpenStreetMap ---------- */
const ND_OSM_PRESETS={
  'radio masts':['man_made','mast','📡','#7fd0ff'],
  'towers':['man_made','tower','🗼','#ffd24a'],
  'communication towers':['tower:type','communication','📡','#7fd0ff'],
  'peaks':['natural','peak','⛰','#8c8'],
  'water towers':['man_made','water_tower','💧','#7fd0ff'],
  'amateur radio':['club','amateur_radio','📻','#ff9f43'],
  'custom':null};
const ND_OSM_KEY=/^[A-Za-z0-9_:.\-]{1,40}$/, ND_OSM_VAL=/^[^"\\\n\r]{1,60}$/;
// выбор пресета или своей пары; null — пара не годится (в запрос не попадает ничего лишнего)
function ndOsmPair(kind,key,value){
  const p=ND_OSM_PRESETS[kind];
  if(p) return {key:p[0],value:p[1],icon:p[2],color:p[3]};
  key=String(key||'').trim(); value=String(value||'').trim();
  if(!ND_OSM_KEY.test(key)) return null;
  if(value && !ND_OSM_VAL.test(value)) return null;
  return {key,value,icon:'📍',color:'#c9a0ff'};
}
function ndOsmQuery(lat,lon,rKm,pair,limit){
  const sel='["'+pair.key+'"'+(pair.value ? '="'+pair.value+'"' : '')+']';
  const ar='(around:'+Math.round(rKm*1000)+','+ndRound(lat,5)+','+ndRound(lon,5)+')';
  return '[out:json][timeout:25];(node'+sel+ar+';way'+sel+ar+';relation'+sel+ar+';);out center '+Math.max(1,limit|0)+';';
}
function ndOsmRows(j,pair,lat,lon){
  if(!j || !Array.isArray(j.elements)) return null;
  const rows=[];
  for(const e of j.elements){
    const la=ndNum(e.lat) ?? ndNum(e.center?.lat), lo=ndNum(e.lon) ?? ndNum(e.center?.lon);
    if(la==null || lo==null) continue;
    const t=e.tags||{};
    const label=t.name||t.ref||t.operator||(pair.value||pair.key)+' '+e.id;
    const d=lat!=null && lon!=null ? ndDist(lat,lon,la,lo) : null;
    rows.push({id:'osm:'+e.type+e.id,label,lat:la,lon:lo,dist:ndRound(d,2),
      height:t.height ? parseFloat(t.height) || null : null, ele:t.ele ? parseFloat(t.ele) || null : null,
      operator:t.operator||'', freq:t.frequency||t['communication:frequency']||'', url:'https://www.openstreetmap.org/'+e.type+'/'+e.id,
      icon:pair.icon,color:pair.color,size:7});
  }
  return rows.sort((p,q)=>(p.dist??1e9)-(q.dist??1e9));
}

/* ---------- Ollama (HTTP API, потоковый NDJSON) ---------- */
// адрес сервера: «host», «host:port», «http://host:port/» → без хвостового слэша; порт по умолчанию 11434
function ndOllamaBase(s){
  s=String(s||'').trim();
  if(!s) return 'http://127.0.0.1:11434';
  if(!/^https?:\/\//i.test(s)) s='http://'+s;
  s=s.replace(/\/+$/,'').replace(/\/api(\/.*)?$/i,'');
  if(/^https?:\/\/[^/:]+$/i.test(s) && /^http:/i.test(s)) s+=':11434';
  return s;
}
// куски потока → готовые JSON-строки; хвост без перевода строки остаётся ждать продолжения
function ndNdjson(buf){
  const out=[]; let i;
  while((i=buf.indexOf('\n'))>=0){
    const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);
    if(!line) continue;
    try{ out.push(JSON.parse(line)); }catch(e){ out.push({error:'bad line: '+line.slice(0,80)}); }
  }
  return {lines:out,rest:buf};
}
function ndOllamaTags(j){
  if(!j || !Array.isArray(j.models)) return null;
  return j.models.map(m=>({name:m.name||m.model||'',size:ndNum(m.size)||0,params:m.details?.parameter_size||'',quant:m.details?.quantization_level||''}))
    .filter(m=>m.name).sort((a,b)=>a.name.localeCompare(b.name));
}
// история сообщений: system (если есть) + последние max пар + новая реплика; context — текст с проводов, добавляется к реплике
function ndOllamaMessages(hist,system,prompt,context,keep){
  const m=[];
  if(system) m.push({role:'system',content:String(system)});
  const h=(keep|0)>0 ? hist.slice(-(keep|0)*2) : [];
  for(const x of h) m.push({role:x.role,content:x.content});
  m.push({role:'user',content:context ? String(prompt)+'\n\n---\n'+String(context) : String(prompt)});
  return m;
}
function ndOllamaBody(model,messages,o){
  const opt={};
  if(o.temperature!=null && isFinite(o.temperature)) opt.temperature=+o.temperature;
  if(o.numCtx>0) opt.num_ctx=o.numCtx|0;
  if(o.seed>0) opt.seed=o.seed|0;
  return {model,messages,stream:true,options:opt,...(o.keepAlive ? {keep_alive:o.keepAlive} : {})};
}
// одна строка потока /api/chat → {delta,done,err,stats}
function ndOllamaChunk(o){
  if(!o) return {delta:'',done:false};
  if(o.error) return {delta:'',done:true,err:String(o.error)};
  const r={delta:o.message?.content||'',done:!!o.done};
  if(o.done){
    const tps=o.eval_count>0 && o.eval_duration>0 ? o.eval_count/(o.eval_duration/1e9) : null;
    r.stats={tokens:o.eval_count||0,promptTokens:o.prompt_eval_count||0,tps:ndRound(tps,1),total:ndRound((o.total_duration||0)/1e9,1)};
  }
  return r;
}
