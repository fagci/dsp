"use strict";
/* ---- справочники: RadioID (радио ID → позывной, имя, место) и имена разговорных групп ---- */
// RadioID: user.csv (RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY) или users.json ({users:[{id,callsign,fname,name,city,state,country}]})
function dmrIdParse(text){
  const m=new Map(), put=(id,call,first,last,city,state,country)=>{
    id=+id; if(!(id>0) || !call) return;
    m.set(id,{call:String(call).trim(), name:[first,last].filter(Boolean).join(' ').trim(), place:[city,state,country].filter(Boolean).join(', ')});
  };
  text=String(text).replace(/^﻿/,'');
  if(/^\s*[{[]/.test(text)){
    let j; try{ j=JSON.parse(text); }catch(e){ return m; }
    for(const u of (Array.isArray(j) ? j : j.users||j.results||[])) put(u.id||u.radio_id,u.callsign,u.fname||u.first_name,u.name||u.surname||u.last_name,u.city,u.state,u.country);
    return m;
  }
  for(const ln of text.split(/\r?\n/)){
    const c=ln.split(',');
    if(c.length>=2 && /^\d+$/.test(c[0].trim())) put(c[0],c[1],c[2],c[3],c[4],c[5],c[6]);
  }
  return m;
}
// группы: {"91":"World-wide"} (BrandMeister API) или строки «id,имя» / «id;имя» / «id имя»
function dmrTgParse(text){
  const m=new Map();
  text=String(text).replace(/^﻿/,'');
  if(/^\s*[{[]/.test(text)){
    let j; try{ j=JSON.parse(text); }catch(e){ return m; }
    if(Array.isArray(j)) for(const g of j){ const id=+(g.id??g.talkgroup??g.tg), nm=g.name||g.label; if(id>=0 && nm) m.set(id,String(nm)); }
    else for(const k of Object.keys(j)) if(/^\d+$/.test(k) && j[k]) m.set(+k,String(j[k]));
    return m;
  }
  for(const ln of text.split(/\r?\n/)){
    const r=/^\s*(\d+)\s*[,;\t ]\s*(.+?)\s*$/.exec(ln);
    if(r) m.set(+r[1],r[2].replace(/^"|"$/g,''));
  }
  return m;
}
