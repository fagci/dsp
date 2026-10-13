"use strict";
/* ============================ Meshtastic: сниффер эфира (поверх LoRa Decoder) ============================
   Пассивный разбор пакетов Meshtastic прямо из воздуха, без своей ноды: LoRa Decoder (sync 2B) даёт байты кадра,
   здесь — 16-байтный заголовок (meshtastic-kernels.js: mshAirHeader) и попытка расшифровать payload AES-CTR по PSK
   канала (по умолчанию AQ== — публичный ключ канала LongFast/«Default», так передаётся большая часть трафика;
   приватные каналы с другим PSK не читаются, пока этот PSK не укажут явно). Подключается к выходу rec узла LoRa Decoder. */

function meshAirHex(n,bytes,psk,now){
  let r; try{ r=mshAirDecode(bytes,psk); }catch(e){ return null; }
  if(!r) return null;
  if(r.encrypted){ n.undec++; return {t:now, src:'Meshtastic', kind:'encrypted', from:mshNodeId(r.from), to:r.dest===MSH_BROADCAST?'all':mshNodeId(r.dest), hop:r.hopLimit, encrypted:true}; }
  n.ok++;
  const d=r.data, upd={};
  for(const k of ['lat','lon','alt','battery','voltage','temp','hum','press','uptime','chUtil','airUtil']) if(d[k]!==undefined) upd[k]=d[k];
  if(d.user) upd.user=d.user;
  const u=mshNodeUpdate(n,r.from,upd), who=mshWho(n,r.from);
  return mshClean({t:now, src:'Meshtastic', kind:d.portName, id:who.id, name:who.name, from:who.id,
    to:r.dest===MSH_BROADCAST ? 'all' : mshNodeId(r.dest), hop:r.hopLimit, hopStart:r.hopStart||undefined, viaMqtt:r.viaMqtt||undefined, psk:r.plain ? 'none' : r.psk,
    text:d.text, lat:u.lat, lon:u.lon, alt:d.alt, battery:d.battery, voltage:d.voltage, temp:d.temp, hum:d.hum, press:d.press, uptime:d.uptime, user:d.user});
}

def({ id:'meshAir', title:'Meshtastic Sniffer (LoRa)', cat:'Decoders', kw:'meshtastic lora mesh sniff decrypt plaintext longfast default channel psk aes air packet passive',
  ins:[{n:'rec',t:'rec'},{n:'hex',t:'txt'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'from',t:'txt'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true, resize:true, w:480,
  params:[{n:'psk',t:'text',d:'AQ==',label:'channel PSK, base64 (through comma — try several; AQ== — default public key of LongFast/Default; empty — payload already plaintext)'},
          {n:'onlyKnown',t:'check',d:true,label:'hide frames that none of the PSKs could decrypt'},
          {n:'hexcol',adv:true,t:'text',d:'hex',label:'hex field in the input record'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.nodes.clear(); n.ok=n.undec=0; n.recent=[]; }}],
  init:n=>{ n.nodes=new Map(); n.ok=0; n.undec=0; n.recent=[]; n.lastHex=undefined; n.lastText=null; n.lastLat=null; n.lastLon=null; },
  process(n,I){
    const now=Date.now(), out=[], psk=n.p.psk, hc=n.p.hexcol||'hex';
    for(const r of recList(I.rec)){
      const hx=r && r[hc]; if(typeof hx!=='string' || !hx) continue;
      const rec=meshAirHex(n,hexFromHex(hx),psk,now);
      if(rec && (!rec.encrypted || !n.p.onlyKnown)) out.push(rec);
    }
    if(typeof I.hex==='string' && I.hex!==n.lastHex){
      n.lastHex=I.hex;
      const rec=meshAirHex(n,hexFromHex(I.hex),psk,now);
      if(rec && (!rec.encrypted || !n.p.onlyKnown)) out.push(rec);
    }
    for(const rec of out){
      n.recent.push((rec.encrypted ? '[locked] ' : '')+(rec.name||rec.from||'?')+' → '+rec.to+' · '+rec.kind+(rec.text ? ' "'+String(rec.text).slice(0,80)+'"' : rec.lat!=null ? ' '+rec.lat.toFixed(5)+','+rec.lon.toFixed(5) : ''));
      if(rec.text!=null) n.lastText=rec.text;
      if(rec.lat!=null){ n.lastLat=rec.lat; n.lastLon=rec.lon; }
    }
    if(n.recent.length>30) n.recent.splice(0,n.recent.length-30);
    return {rec:out.length ? out : null, text:n.lastText, from:out.length ? (out[out.length-1].name||out[out.length-1].from) : null, lat:n.lastLat, lon:n.lastLon, new:out.length ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t='decoded '+n.ok+(n.undec ? ' · locked '+n.undec : '')+' · '+n.nodes.size+' nodes'+(n.recent.length ? '\n'+n.recent.slice(-12).join('\n') : '\nno frames yet (feed LoRa Decoder rec, sync 2B for Meshtastic)');
    if(r.textContent!==t) r.textContent=t; }
});
