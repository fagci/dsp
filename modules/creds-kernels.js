"use strict";
/* ============================ Учётки (Credentials): чистая логика ============================
   crClean(list) — валидация и дедуп по имени (регистронезависимо); crFind(list, name) → запись или null. */

const CR_NAME=/^[A-Za-z0-9_.-]{1,24}$/;
function crClean(list){
  const out=[], seen=new Set();
  for(const c of Array.isArray(list)?list:[]){
    if(!c||typeof c!=='object') continue;
    const name=String(c.name||'').trim();
    if(!CR_NAME.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({name, server:String(c.server||''), user:String(c.user||''), pass:String(c.pass||''), smtp:String(c.smtp||'')});
  }
  return out;
}
function crFind(list,name){
  const n=String(name||'').trim().toLowerCase();
  return (Array.isArray(list)?list:[]).find(c=>c&&String(c.name||'').toLowerCase()===n)||null;
}
