"use strict";
/* ============================ Прокси: список в Settings → Network ============================
   Один список «имя → как ходить», три вида:
     cors   — внешний CORS-прокси (nginx, Cloudflare Worker…): шаблон адреса, «{url}» заменяется адресом;
     bridge — мост из Settings → Devices (приложение Android / Node): его /proxy, токен берётся из Devices;
     socks  — обычный SOCKS5 / HTTP-прокси (учётка типа proxy из Credentials). Браузер сам с ним говорить не умеет —
              ходит мост (поле dev); без моста запись остаётся только для узлов, что открывают соединение через мост.
   Общий прокси (запасной) — одно из имён списка. В узле параметр proxy: auto (напрямую, при отказе — общий) · off · имя из списка.
   Чистая логика без DOM — tools/test-proxies.mjs (нужен gateways-kernels.js: gwFind, gwProxyTemplate). */

const PX_TYPES=['cors','bridge','socks'];
const PX_RESERVED=['auto','off'];                                   // значения параметра узла, не имена
const pxNameOk=s=>/^[A-Za-z0-9_.-]{1,24}$/.test(String(s)) && !PX_RESERVED.includes(String(s).toLowerCase());
const pxFind=(list,name)=>(list||[]).find(p=>p.name.toLowerCase()===String(name||'').toLowerCase());
function pxClean(list){                                             // из хранилища: допустимые записи, без повторов имён
  const seen=new Set(), out=[];
  for(const p of Array.isArray(list) ? list : []){
    if(!p || typeof p.name!=='string') continue;
    const name=p.name.trim(); if(!pxNameOk(name) || seen.has(name.toLowerCase())) continue;
    const type=PX_TYPES.includes(p.type) ? p.type : 'cors', s=k=>typeof p[k]==='string' ? p[k].trim() : '';
    seen.add(name.toLowerCase());
    const e={name,type};
    if(type==='cors') e.url=s('url'); else { e.dev=s('dev'); if(type==='socks') e.cred=s('cred'); }
    out.push(e);
  }
  return out;
}
// шаблон адреса записи → строка с «{url}» или префикс; '' — нельзя (нет устройства, не ws://, пустой адрес)
function pxTemplate(p,devices,tokens){
  if(!p) return '';
  if(p.type==='cors') return p.url||'';
  const d=gwFind(devices,String(p.dev||'').replace(/^@/,''));
  return d ? gwProxyTemplate(d,(tokens||{})[d.name.toLowerCase()]) : '';
}
// почему запись не работает (для строки в настройках); '' — всё в порядке
function pxProblem(p,devices,creds){
  if(!p) return '';
  if(p.type==='cors') return /^https?:\/\//i.test(p.url||'') || /^\/\//.test(p.url||'') ? '' : 'the address must start with https:// (or http://)';
  const d=gwFind(devices,String(p.dev||'').replace(/^@/,''));
  if(!p.dev) return 'choose a bridge from Devices';
  if(!d) return 'device «'+p.dev+'» is not in Devices';
  if(!/^wss?:\/\//i.test(d.url)) return 'the address of «'+d.name+'» must start with ws://';
  if(p.type==='socks'){
    if(!p.cred) return 'choose a proxy credential (socks5://… or http://…)';
    if(!(creds||[]).some(c=>c.name.toLowerCase()===p.cred.toLowerCase())) return 'credential «'+p.cred+'» is not in Credentials';
  }
  return '';
}
// старое хранилище: одна строка «CORS proxy» (шаблон или «@имя» моста) → список + общий
function pxMigrate(old){
  const v=String(old||'').trim(); if(!v) return {list:[],def:''};
  if(v[0]==='@'){ const n=v.slice(1).trim(); return pxNameOk(n) ? {list:[{name:n,type:'bridge',dev:n}],def:n} : {list:[],def:''}; }
  return {list:[{name:'proxy',type:'cors',url:v}],def:'proxy'};
}
// значение параметра узла → {mode:'auto'|'off'|'name', name}. Раньше это была галочка: true — «через прокси из Settings»
function pxSel(v,defName,globalMode){
  if(v===true) return globalMode==='auto' || !defName ? {mode:'auto'} : {mode:'name',name:defName};     // как раньше: «always» — сразу через прокси, «on error» — сначала напрямую
  const s=typeof v==='string' ? v.trim() : '';
  if(!s || s.toLowerCase()==='auto') return {mode:'auto'};
  if(s.toLowerCase()==='off') return {mode:'off'};
  return {mode:'name',name:s};
}
const pxChoices=list=>['auto','off',...(list||[]).map(p=>p.name)];
// «{url}» заменяется закодированным адресом, иначе адрес дописывается к префиксу
const pxApply=(tpl,u)=>tpl.includes('{url}') ? tpl.replace('{url}',encodeURIComponent(u)) : tpl+u;
