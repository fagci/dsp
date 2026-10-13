"use strict";
/* ============================ MeshCore: сниффер эфира (поверх LoRa Decoder) ============================
   Пассивный разбор пакетов MeshCore прямо из воздуха: LoRa Decoder (sync 12 — приватное/дефолтное слово LoRa,
   его использует и MeshCore, и многие другие приватные LoRa-сети — отличить их друг от друга можно только по
   содержимому) даёт байты кадра, здесь — заголовок пакета (meshcore-kernels.js: mcPacket) и разбор по типу:
   ADVERT — целиком открытый текст (имя узла, тип, координаты); GRP_TXT/GRP_DATA — AES-ECB по PSK канала
   (по умолчанию izOH6cXN6mrJ5e26oRXNcg== — предустановленный канал «Public», этим ключом идёт открытый чат по
   умолчанию во многих клиентах; свои каналы — свой PSK). Личные сообщения (TXT_MSG) и прочее, что шифруется
   приватным ключом получателя (ECDH), пассивно не читаются — это не ограничение декодера, а свойство протокола. */

function mcHex(n,bytes,pskCsv,now){
  let r; try{ r=mcDecode(bytes,String(pskCsv||MC_PUBLIC_PSK).split(',').map(s=>s.trim()).filter(Boolean)); }catch(e){ return null; }
  if(!r) return null;
  const rec={t:now, src:'MeshCore', kind:r.typeName, route:r.route, hop:r.hopCount};
  if(r.advert){
    n.ok++;
    const node=n.nodes.get(r.pubKey)||{pubKey:r.pubKey}; if(r.name) node.name=r.name; node.type=r.advTypeName;
    if(r.lat!=null){ node.lat=r.lat; node.lon=r.lon; } n.nodes.set(r.pubKey,node);
    Object.assign(rec,{from:'!'+r.id, pubKey:r.pubKey, name:r.name, advType:r.advTypeName, lat:r.lat, lon:r.lon, text:(r.name||'node')+' ('+r.advTypeName+')'+(r.lat!=null ? ' @ '+r.lat.toFixed(5)+','+r.lon.toFixed(5) : '')});
  } else if(r.text!==undefined || r.dataType!==undefined || r.encrypted){
    if(r.encrypted){ n.undec++; rec.encrypted=true; rec.channelHash=r.channelHash; }
    else{
      n.ok++;
      Object.assign(rec,{channelHash:r.channelHash, psk:r.psk});
      if(r.text!==undefined) rec.text=r.text;
      else{ rec.dataType=r.dataType; rec.data=r.data; }
    }
  } else if(r.tag!==undefined){ n.ok++; Object.assign(rec,{tag:r.tag,text:'trace tag '+r.tag.toString(16)}); }
  else { n.skip++; return null; }                                 // text/request/response/anon/ack/path/… — читается только ключом получателя
  return rec;
}

def({ id:'meshcore', title:'MeshCore Sniffer (LoRa)', cat:'Decoders', kw:'meshcore lora mesh sniff decrypt plaintext public channel psk aes air packet passive advert',
  ins:[{n:'rec',t:'rec'},{n:'hex',t:'txt'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'from',t:'txt'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true, resize:true, w:480,
  params:[{n:'psk',t:'text',d:MC_PUBLIC_PSK,label:'channel PSK, base64 (through comma — try several; default — the pre-set "Public" channel)'},
          {n:'onlyKnown',t:'check',d:true,label:'hide group frames that none of the PSKs could decrypt'},
          {n:'hexcol',adv:true,t:'text',d:'hex',label:'hex field in the input record'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.nodes.clear(); n.ok=n.undec=n.skip=0; n.recent=[]; }}],
  init:n=>{ n.nodes=new Map(); n.ok=0; n.undec=0; n.skip=0; n.recent=[]; n.lastHex=undefined; n.lastText=null; n.lastLat=null; n.lastLon=null; },
  process(n,I){
    const now=Date.now(), out=[], psk=n.p.psk, hc=n.p.hexcol||'hex';
    for(const r of recList(I.rec)){
      const hx=r && r[hc]; if(typeof hx!=='string' || !hx) continue;
      const rec=mcHex(n,hexFromHex(hx),psk,now);
      if(rec && (!rec.encrypted || !n.p.onlyKnown)) out.push(rec);
    }
    if(typeof I.hex==='string' && I.hex!==n.lastHex){
      n.lastHex=I.hex;
      const rec=mcHex(n,hexFromHex(I.hex),psk,now);
      if(rec && (!rec.encrypted || !n.p.onlyKnown)) out.push(rec);
    }
    for(const rec of out){
      n.recent.push((rec.encrypted ? '[locked] ' : '')+rec.kind+(rec.from ? ' '+rec.from : '')+(rec.text ? ' "'+String(rec.text).slice(0,80)+'"' : rec.channelHash!=null ? ' channel 0x'+rec.channelHash.toString(16) : ''));
      if(rec.text!=null) n.lastText=rec.text;
      if(rec.lat!=null){ n.lastLat=rec.lat; n.lastLon=rec.lon; }
    }
    if(n.recent.length>30) n.recent.splice(0,n.recent.length-30);
    return {rec:out.length ? out : null, text:n.lastText, from:out.length ? (out[out.length-1].from||out[out.length-1].pubKey) : null, lat:n.lastLat, lon:n.lastLon, new:out.length ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t='decoded '+n.ok+(n.undec ? ' · locked '+n.undec : '')+(n.skip ? ' · needs peer key '+n.skip : '')+' · '+n.nodes.size+' nodes'+
      (n.recent.length ? '\n'+n.recent.slice(-12).join('\n') : '\nno frames yet (feed LoRa Decoder rec, sync 12 for MeshCore)');
    if(r.textContent!==t) r.textContent=t; }
});
