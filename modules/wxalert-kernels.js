"use strict";
/* ============================ Погодные оповещения: NWS / CAP, фильтр SAME, APRS ============================
   Чистая логика без DOM (страница и Node). Пары «разбор ↔ сборка» зеркальны (проверка кругом — tools/test-wxalert.mjs):
   • NWS API (api.weather.gov/alerts/active, GeoJSON): wxParseNws ↔ wxBuildNws;
   • CAP 1.2 XML и Atom с cap:-полями (NWS .atom, IPAWS): wxParseCap ↔ wxBuildCap;
   • APRS: бюллетень «:BLN1WX   :текст» и объект «;TOR1830Z *DDHHMMz…» — wxAprsBulletin / wxAprsObject ↔ wxAprsParse;
   • фильтр по FIPS (PSSCCC / SSCCC / «OK») и по кодам событий (TOR, !RWT, *W) — общий для SAME-декодера и NWS.
   Запись оповещения (rec): {src,kind:'header'|'cancel'|'eom', id, event, eventName, locations:'040109 040017', states:'OK', area,
   severity, urgency, certainty, headline, text, description, instruction, sent, expires, lat, lon, t}. Время — мс (UTC). */

const WX_STATE={'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN',
  '19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ',
  '35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA',
  '53':'WA','54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI'};
const WX_STATE_CODE=Object.fromEntries(Object.entries(WX_STATE).map(([k,v])=>[v,k]));
// название события NWS/CAP → код SAME (когда в оповещении нет eventCode)
const WX_EVENT={'Tornado Warning':'TOR','Tornado Watch':'TOA','Severe Thunderstorm Warning':'SVR','Severe Thunderstorm Watch':'SVA','Severe Weather Statement':'SVS',
  'Flash Flood Warning':'FFW','Flash Flood Watch':'FFA','Flash Flood Statement':'FFS','Flood Warning':'FLW','Flood Watch':'FLA','Flood Statement':'FLS',
  'Special Weather Statement':'SPS','Special Marine Warning':'SMW','High Wind Warning':'HWW','High Wind Watch':'HWA','Extreme Wind Warning':'EWW',
  'Winter Storm Warning':'WSW','Winter Storm Watch':'WSA','Blizzard Warning':'BZW','Dust Storm Warning':'DSW','Snow Squall Warning':'SQW','Freeze Warning':'FZW',
  'Hurricane Warning':'HUW','Hurricane Watch':'HUA','Tropical Storm Warning':'TRW','Tropical Storm Watch':'TRA','Storm Surge Warning':'SSW','Storm Surge Watch':'SSA',
  'Tsunami Warning':'TSW','Tsunami Watch':'TSA','Coastal Flood Warning':'CFW','Coastal Flood Watch':'CFA','Fire Warning':'FRW','Civil Emergency Message':'CEM',
  'Civil Danger Warning':'CDW','Earthquake Warning':'EQW','Evacuation Immediate':'EVI','Hazardous Materials Warning':'HMW','Law Enforcement Warning':'LEW',
  'Local Area Emergency':'LAE','Shelter In Place Warning':'SPW','Volcano Warning':'VOW','Nuclear Power Plant Warning':'NUW','Radiological Hazard Warning':'RHW',
  'Required Monthly Test':'RMT','Required Weekly Test':'RWT','Practice/Demo Warning':'DMO','Child Abduction Emergency':'CAE','Avalanche Warning':'AVW','Avalanche Watch':'AVA'};
const WX_EVENT_NAME=Object.fromEntries(Object.entries(WX_EVENT).map(([k,v])=>[v,k]));
const wxTime=s=>{ const t=Date.parse(s); return isFinite(t) ? t : null; };
const wxIso=ms=>ms==null ? '' : new Date(ms).toISOString().replace(/\.\d+Z$/,'+00:00');
const wxStates=list=>[...new Set(list.map(l=>WX_STATE[String(l).padStart(6,'0').slice(1,3)]).filter(Boolean))].join(' ');

/* ---------- названия округов (FIPS, modules/fips-data.js) ---------- */
const WX_PART={'0':'','1':'NW','2':'N','3':'NE','4':'W','5':'C','6':'E','7':'SW','8':'S','9':'SE'};
const wxHasFips=()=>typeof FIPS_COUNTIES!=='undefined' && typeof FIPS_STATES!=='undefined';
// PSSCCC → «Travis, TX», «NW Travis, TX», «Texas (statewide)»; неизвестный округ — «county 453, TX»
function wxAreaName(loc){
  loc=String(loc).padStart(6,'0');
  const ss=loc.slice(1,3), cc=loc.slice(3), ab=WX_STATE[ss]||ss, part=WX_PART[loc[0]]||'';
  if(cc==='000') return (wxHasFips() && FIPS_STATES[ss] || ab)+' (statewide)';
  const nm=wxHasFips() && FIPS_COUNTIES[ss+cc];
  return (part ? part+' ' : '')+(nm || 'county '+cc)+', '+ab;
}
// список кодов («040109 048453») → «A, XX; B, YY (+N)»
function wxAreaNames(locs,max){
  const L=(Array.isArray(locs) ? locs : String(locs||'').split(/[\s,;-]+/)).filter(x=>/^\d{6}$/.test(x));
  const m=max||6, t=L.slice(0,m).map(wxAreaName).join('; ');
  return L.length>m ? t+' (+'+(L.length-m)+')' : t;
}
// зеркало wxAreaName: название округа и штат → PSSCCC (часть округа не указывается — «0»)
function wxAreaCode(name,state){
  if(!wxHasFips()) return null;
  const ss=WX_STATE_CODE[String(state||'').toUpperCase()] || (/^\d{2}$/.test(state) ? state : null); if(!ss) return null;
  const q=String(name||'').toLowerCase().replace(/_/g,' ').replace(/\s+(county|parish|borough)$/,'').trim();
  for(const k in FIPS_COUNTIES) if(k.slice(0,2)===ss && FIPS_COUNTIES[k].toLowerCase()===q) return '0'+k;
  return null;
}

/* ---------- фильтр ---------- */
// «OK», «40», «40109», «040109», через пробел/запятую → [{p,ss,cc}]; p='0' — любая часть округа, cc='000' — весь штат
function wxFipsList(s){
  const out=[];
  for(const t of String(s||'').split(/[\s,;]+/).filter(Boolean)){
    const u=t.toUpperCase(), nm=/^([A-Za-z]{2}):(.+)$/.exec(t);
    if(nm){ const c=wxAreaCode(nm[2],nm[1]); if(c) out.push({p:'0',ss:c.slice(1,3),cc:c.slice(3)}); }
    else if(/^[A-Z]{2}$/.test(u)){ if(WX_STATE_CODE[u]) out.push({p:'0',ss:WX_STATE_CODE[u],cc:'000'}); }
    else if(/^\d{2}$/.test(u)) out.push({p:'0',ss:u,cc:'000'});
    else if(/^\d{5}$/.test(u)) out.push({p:'0',ss:u.slice(0,2),cc:u.slice(2)});
    else if(/^\d{6}$/.test(u)) out.push({p:u[0],ss:u.slice(1,3),cc:u.slice(3)});
  }
  return out;
}
// locs — массив/строка PSSCCC; пустой фильтр пропускает всё
function wxFipsMatch(locs,filter){
  const f=Array.isArray(filter) ? filter : wxFipsList(filter);
  if(!f.length) return true;
  const L=(Array.isArray(locs) ? locs : String(locs||'').split(/[\s,;-]+/)).filter(x=>/^\d{6}$/.test(x));
  return L.some(l=>f.some(w=>w.ss===l.slice(1,3) && (w.cc==='000' || l.slice(3)==='000' || w.cc===l.slice(3)) && (w.p==='0' || l[0]==='0' || w.p===l[0])));
}
// «TOR SVR*», «*W» (все Warning), «!RWT !RMT» (исключить); пусто — все
function wxEventMatch(code,spec){
  const toks=String(spec||'').toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if(!toks.length) return true;
  const re=t=>new RegExp('^'+t.replace(/[^A-Z0-9*?]/g,'').replace(/\*/g,'[A-Z0-9]*').replace(/\?/g,'[A-Z0-9]')+'$');
  const c=String(code||'').toUpperCase();
  const inc=toks.filter(t=>t[0]!=='!'), exc=toks.filter(t=>t[0]==='!').map(t=>t.slice(1));
  if(exc.some(t=>re(t).test(c))) return false;
  return !inc.length || inc.some(t=>re(t).test(c));
}
const wxMatch=(rec,fips,events)=>wxFipsMatch(rec.locations,fips) && wxEventMatch(rec.event,events);

/* ---------- геометрия ---------- */
// кольцо [[lon,lat],…] (GeoJSON) → центр вершин (без замыкающей)
function wxCentroid(ring){
  if(!Array.isArray(ring) || ring.length<3) return null;
  const pts=ring.slice(0,ring[0][0]===ring[ring.length-1][0] && ring[0][1]===ring[ring.length-1][1] ? -1 : undefined);
  let la=0, lo=0; for(const p of pts){ la+=p[1]; lo+=p[0]; }
  return {lat:+(la/pts.length).toFixed(4), lon:+(lo/pts.length).toFixed(4)};
}

/* ---------- NWS API (GeoJSON) ---------- */
function wxNwsUrl(o){
  o=o||{};
  if(isFinite(o.lat) && isFinite(o.lon) && (o.lat||o.lon)) return 'https://api.weather.gov/alerts/active?point='+(+o.lat).toFixed(4)+','+(+o.lon).toFixed(4);
  const area=String(o.area||'').toUpperCase().replace(/[^A-Z0-9,]/g,'');
  if(/^[A-Z]{2}(,[A-Z]{2})*$/.test(area)) return 'https://api.weather.gov/alerts/active?area='+area;
  if(area) return 'https://api.weather.gov/alerts/active?zone='+area;
  return 'https://api.weather.gov/alerts/active';
}
function wxOne(src,f){
  const same=(f.same||[]).map(x=>String(x).padStart(6,'0'));
  const code=f.code || WX_EVENT[f.event] || '';
  const r={src, kind:/^cancel$/i.test(f.msg||'') ? 'cancel' : 'header', id:f.id||'', event:code, eventName:f.event||WX_EVENT_NAME[code]||code,
    locations:same.join(' '), states:wxStates(same), area:f.area||'', severity:f.severity||'', urgency:f.urgency||'', certainty:f.certainty||'',
    headline:f.headline||'', description:f.description||'', instruction:f.instruction||'', sender:f.sender||'', msg:f.msg||'Alert',
    sent:f.sent??null, expires:f.expires??null, lat:f.lat??null, lon:f.lon??null};
  r.t=r.sent ?? Date.now();
  r.text=r.eventName+(r.area ? ' · '+r.area : '')+(r.expires ? ' · until '+wxHm(r.expires)+'Z' : '')+(r.severity ? ' · '+r.severity : '');
  return r;
}
const wxHm=ms=>{ const d=new Date(ms); return String(d.getUTCHours()).padStart(2,'0')+String(d.getUTCMinutes()).padStart(2,'0'); };
function wxParseNws(j){
  if(!j || !Array.isArray(j.features)) return null;
  const out=[];
  for(const ft of j.features){
    const p=ft && ft.properties; if(!p) continue;
    const ec=p.eventCode && p.eventCode.SAME && p.eventCode.SAME[0];
    let c=null; const g=ft.geometry;
    if(g && g.type==='Polygon') c=wxCentroid(g.coordinates[0]);
    else if(g && g.type==='MultiPolygon') c=wxCentroid(g.coordinates[0] && g.coordinates[0][0]);
    out.push(wxOne('NWS',{id:p.id||ft.id, code:ec, event:p.event, same:p.geocode && p.geocode.SAME, area:p.areaDesc, severity:p.severity, urgency:p.urgency,
      certainty:p.certainty, headline:p.headline, description:p.description, instruction:p.instruction, sender:p.senderName||p.sender, msg:p.messageType,
      sent:wxTime(p.sent), expires:wxTime(p.ends||p.expires), lat:c&&c.lat, lon:c&&c.lon}));
  }
  return out;
}
// зеркало wxParseNws: записи → GeoJSON api.weather.gov (для проверки без сети)
function wxBuildNws(recs){
  return {type:'FeatureCollection', features:recs.map(r=>({id:r.id, type:'Feature',
    geometry:r.lat!=null && r.lon!=null ? {type:'Polygon', coordinates:[[[r.lon-.1,r.lat-.1],[r.lon+.1,r.lat-.1],[r.lon+.1,r.lat+.1],[r.lon-.1,r.lat+.1],[r.lon-.1,r.lat-.1]]]} : null,
    properties:{id:r.id, areaDesc:r.area||'', geocode:{SAME:String(r.locations||'').split(' ').filter(Boolean), UGC:[]}, sent:wxIso(r.sent), effective:wxIso(r.sent),
      expires:wxIso(r.expires), ends:wxIso(r.expires), messageType:r.kind==='cancel' ? 'Cancel' : 'Alert', severity:r.severity||'Unknown', certainty:r.certainty||'Unknown',
      urgency:r.urgency||'Unknown', event:r.eventName||'', eventCode:{SAME:[r.event]}, senderName:r.sender||'', headline:r.headline||'', description:r.description||'',
      instruction:r.instruction||''}}))};
}

/* ---------- CAP 1.2 XML / Atom ---------- */
const wxUnx=s=>String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi,(m,e)=>
  ({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'}[e.toLowerCase()] ?? String.fromCodePoint(e[1]==='x'||e[1]==='X' ? parseInt(e.slice(2),16) : +e.slice(1)))).trim();
const wxEsc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function wxTag(s,t){
  const m=new RegExp('<(?:\\w+:)?'+t+'(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?'+t+'>','i').exec(s);
  return m ? wxUnx(m[1]) : '';
}
function wxParseCap(xml){
  const x=String(xml||'');
  if(!/<(?:\w+:)?(?:alert|entry|feed)[\s>]/i.test(x)) return null;
  const items=[...x.matchAll(/<(?:\w+:)?(alert|entry)[\s>][\s\S]*?<\/(?:\w+:)?\1>/gi)].map(m=>m[0]);
  const out=[];
  for(const it of items){
    const same=[]; let m;
    const re=/<(?:\w+:)?geocode>([\s\S]*?)<\/(?:\w+:)?geocode>/gi;
    while((m=re.exec(it))) if(/^SAME$/i.test(wxTag(m[1],'valueName'))) same.push(...wxTag(m[1],'value').split(/\s+/).filter(Boolean));
    let code=''; const ecs=/<(?:\w+:)?eventCode>([\s\S]*?)<\/(?:\w+:)?eventCode>/gi;
    while((m=ecs.exec(it))) if(/^SAME$/i.test(wxTag(m[1],'valueName'))) code=wxTag(m[1],'value');
    const poly=wxTag(it,'polygon'); let c=null;
    if(poly){ const pts=poly.split(/\s+/).map(p=>p.split(',').map(Number)).filter(p=>p.length===2 && isFinite(p[0]) && isFinite(p[1])); c=wxCentroid(pts.map(p=>[p[1],p[0]])); }
    out.push(wxOne('CAP',{id:wxTag(it,'identifier')||wxTag(it,'id'), code, event:wxTag(it,'event'), same, area:wxTag(it,'areaDesc'), severity:wxTag(it,'severity'),
      urgency:wxTag(it,'urgency'), certainty:wxTag(it,'certainty'), headline:wxTag(it,'headline'), description:wxTag(it,'description'),
      instruction:wxTag(it,'instruction'), sender:wxTag(it,'senderName')||wxTag(it,'sender'), msg:wxTag(it,'msgType'),
      sent:wxTime(wxTag(it,'sent')||wxTag(it,'effective')), expires:wxTime(wxTag(it,'expires')), lat:c&&c.lat, lon:c&&c.lon}));
  }
  return out;
}
// зеркало wxParseCap: записи → CAP 1.2 (по одному <alert> в <feed>-обёртке не нужен: просто конкатенация alert'ов в <alerts>)
function wxBuildCap(recs){
  const one=r=>'<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>'+wxEsc(r.id)+'</identifier><sender>'+wxEsc(r.sender||'test@example.invalid')+'</sender><sent>'+wxIso(r.sent)+
    '</sent><status>'+(r.src==='TEST' ? 'Test' : 'Actual')+'</status><msgType>'+(r.kind==='cancel' ? 'Cancel' : 'Alert')+'</msgType><scope>Public</scope>'+
    '<info><category>Met</category><event>'+wxEsc(r.eventName)+'</event><eventCode><valueName>SAME</valueName><value>'+wxEsc(r.event)+'</value></eventCode>'+
    '<urgency>'+wxEsc(r.urgency||'Unknown')+'</urgency><severity>'+wxEsc(r.severity||'Unknown')+'</severity><certainty>'+wxEsc(r.certainty||'Unknown')+'</certainty>'+
    '<expires>'+wxIso(r.expires)+'</expires><senderName>'+wxEsc(r.sender||'')+'</senderName><headline>'+wxEsc(r.headline)+'</headline><description>'+wxEsc(r.description)+
    '</description><instruction>'+wxEsc(r.instruction)+'</instruction><area><areaDesc>'+wxEsc(r.area)+'</areaDesc>'+
    (r.lat!=null && r.lon!=null ? '<polygon>'+[[-.1,-.1],[.1,-.1],[.1,.1],[-.1,.1],[-.1,-.1]].map(d=>(r.lat+d[0]).toFixed(4)+','+(r.lon+d[1]).toFixed(4)).join(' ')+'</polygon>' : '')+
    '<geocode><valueName>SAME</valueName><value>'+wxEsc(String(r.locations||''))+'</value></geocode></area></info></alert>';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<alerts>'+recs.map(one).join('\n')+'</alerts>';
}
// любой ответ (JSON NWS или XML) → записи
function wxParseAny(text){
  const s=String(text||'').trim();
  if(s[0]==='<') return wxParseCap(s);
  try{ return wxParseNws(JSON.parse(s)); }catch(e){ return null; }
}
// новые относительно множества виденных id; seen обновляется (остаются только актуальные)
function wxDiff(recs,seen){
  const fresh=[], now=new Set();
  for(const r of recs){ now.add(r.id); if(!seen.has(r.id)) fresh.push(r); }
  seen.clear(); for(const id of now) seen.add(id);
  return fresh;
}

/* ---------- APRS ---------- */
function wxAprsLat(v){ const h=v<0 ? 'S' : 'N'; v=Math.abs(v); let d=Math.floor(v), m=Math.round((v-d)*6000)/100; if(m>=60){ d++; m-=60; } return String(d).padStart(2,'0')+m.toFixed(2).padStart(5,'0')+h; }
function wxAprsLon(v){ const h=v<0 ? 'W' : 'E'; v=Math.abs(v); let d=Math.floor(v), m=Math.round((v-d)*6000)/100; if(m>=60){ d++; m-=60; } return String(d).padStart(3,'0')+m.toFixed(2).padStart(5,'0')+h; }
const wxDhm=ms=>{ const d=new Date(ms); return [d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes()].map(x=>String(x).padStart(2,'0')).join('')+'z'; };
// конец действия: expires (NWS/CAP) или время записи + purge, мин (SAME)
const wxUntil=r=>r.expires ?? (r.purge ? (r.t||Date.now())+r.purge*60000 : null);
function wxShort(r,max){
  const a=r.area || (r.locations ? (wxHasFips() ? wxAreaNames(r.locations,2) : r.locations.split(' ').slice(0,4).join(' ')) : r.states||'');
  const u=wxUntil(r);
  let t=(r.eventName||r.event||'Alert')+(r.kind==='cancel'||r.kind==='eom' ? ' CANCELLED' : '')+(a ? ' '+a : '')+(u && r.kind==='header' ? ' til '+wxHm(u)+'Z' : '');
  t=t.replace(/[|~{}\r\n]+/g,' ');
  return t.length>max ? t.slice(0,max-1)+'…' : t;
}
// «:BLN1WX   :текст» — адресат 9 знаков, текст до 67
function wxAprsBulletin(r,o){
  o=o||{};
  const id=String(o.id||'BLN1WX').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,9) || 'BLN1WX';
  return ':'+id.padEnd(9)+':'+wxShort(r,67).replace(/…/g,'.');
}
// «;ИМЯ(9)*DDHHMMzDDMM.mmN/DDDMM.mmWsкомментарий» — только если есть координаты; отмена — «_»
function wxAprsObject(r,o){
  o=o||{};
  const lat=r.lat ?? o.lat, lon=r.lon ?? o.lon;
  if(!isFinite(lat) || !isFinite(lon) || (!lat && !lon)) return null;
  const sym=String(o.sym||'\\!'); const tab=sym[0]==='/'||sym[0]==='\\' ? sym[0] : '\\', code=sym.length>1 ? sym[1] : '!';
  const name=((r.event||'WX')+wxHm(wxUntil(r)||r.t||Date.now())+'Z').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,9);
  return ';'+name.padEnd(9)+(r.kind==='cancel'||r.kind==='eom' ? '_' : '*')+wxDhm(r.t||Date.now())+wxAprsLat(lat)+tab+wxAprsLon(lon)+code+wxShort(r,43).replace(/…/g,'.');
}
// зеркало: информационное поле AX.25 → запись или null
function wxAprsParse(s){
  s=String(s||'');
  let m=/^:([A-Z0-9 ]{9}):(.*)$/.exec(s);
  if(m && /^BLN/.test(m[1])) return {src:'APRS', kind:'bulletin', id:m[1].trim(), text:m[2]};
  m=/^;(.{9})([*_])(\d{6}z)(\d{2})(\d{2}\.\d{2})([NS])([\/\\])(\d{3})(\d{2}\.\d{2})([EW])(.)(.*)$/.exec(s);
  if(!m) return null;
  const lat=(+m[4]+ +m[5]/60)*(m[6]==='S' ? -1 : 1), lon=(+m[8]+ +m[9]/60)*(m[10]==='W' ? -1 : 1);
  return {src:'APRS', kind:m[2]==='_' ? 'cancel' : 'object', id:m[1].trim(), time:m[3], lat:+lat.toFixed(4), lon:+lon.toFixed(4), sym:m[7]+m[11], text:m[12], event:m[1].slice(0,3)};
}
