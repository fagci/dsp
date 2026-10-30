"use strict";
/* ============================ Устройства (мосты): список в Settings ============================
   Имя → адрес + токен. Узлы пишут в поле адреса «@имя», а не ws://… и не держат токен в патче: список и токены лежат в браузере
   (токены отдельным ключом, который не попадает в бэкап и в «Share…»). Чистая логика без DOM — tools/test-gateways.mjs. */

const GW_NAME=/^[A-Za-z0-9_.-]{1,24}$/;
const gwRef=s=>{ const m=/^@([A-Za-z0-9_.-]{1,24})\s*$/.exec(String(s||'').trim()); return m ? m[1] : null; };     // «@телефон» → «телефон», иначе null
const gwFind=(list,name)=>(list||[]).find(d=>d.name.toLowerCase()===String(name).toLowerCase());
function gwAddToken(url,token){                                   // ?token= к адресу, если токен есть и в адресе своего нет
  token=String(token||''); if(!token) return url;
  try{ const u=new URL(url); if(u.searchParams.has('token')) return url; u.searchParams.set('token',token); return u.toString(); }catch(e){ return url; }
}
// «@имя» → {url, err}; обычный адрес возвращается как есть
function gwResolve(list,tokens,s){
  const name=gwRef(s);
  if(name===null) return {url:String(s||'')};
  const d=gwFind(list,name);
  if(!d) return {url:'',err:'device «'+name+'» is not in Settings → Devices — add it there (name, address, token)'};
  return {url:gwAddToken(d.url,(tokens||{})[d.name.toLowerCase()])};
}
// Node-мост как CORS-прокси: ws://host:8777 → http://host:8777/proxy?token=…&url={url}
function gwProxyTemplate(d,token){
  let u; try{ u=new URL(d.url); }catch(e){ return ''; }
  if(u.protocol!=='ws:' && u.protocol!=='wss:') return '';
  const t=token || u.searchParams.get('token') || '';
  const base=(u.protocol==='wss:' ? 'https://' : 'http://')+u.host+'/proxy?'+(t ? 'token='+encodeURIComponent(t)+'&' : '');
  return base+'url={url}';
}
// приветствие устройства → что это: node (tools/node/bridge.mjs), phone (приложение DSP), termux (tools/termux/bridge.mjs)
function gwKind(j){
  if(!j || typeof j!=='object') return '';
  if(j.ev==='hello') return 'node';
  if(j.src==='bridge' && j.level==='hello') return /dsp-android/i.test(j.app||'') ? 'phone' : 'termux';
  return '';
}
const GW_KIND_TEXT={node:'Node bridge',phone:'DSP app on a phone',termux:'Termux bridge'};
function gwClean(list){                                           // из хранилища: только допустимые строки, без повторов имён
  const seen=new Set(), out=[];
  for(const d of Array.isArray(list) ? list : []){
    if(!d || typeof d.name!=='string' || typeof d.url!=='string') continue;
    const name=d.name.trim(); if(!GW_NAME.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase()); out.push({name,url:d.url.trim()});
  }
  return out;
}
