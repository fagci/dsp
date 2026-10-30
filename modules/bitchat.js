"use strict";
/* ============================ bitchat mesh chat (мост DSP app) ============================
   Публичный (нешифрованный) чат bitchat (permissionlesstech/bitchat) по BLE — без установки их приложения:
   узел через bridge приложения DSP (tools/android, тот же протокол, что у BLE GATT / Bluetooth) сканирует эфир,
   находит рядом телефоны с bitchat (service UUID — data/bluetooth-uuids.json), подключается к ним как GATT-клиент
   (роль «центрального» — её достаточно, т.к. bitchat сам выступает периферийным GATT-сервером) и обменивается их
   бинарными пакетами (modules/bitchat-kernels.js — разбор по BinaryProtocol.swift). Реализован только публичный
   broadcast (announce/message): приватные сообщения у bitchat идут через Noise-рукопожатие, его не делаем —
   для личных сообщений в этой сети нужно их собственное приложение. Релей (пересылка чужих пакетов дальше по mesh)
   тоже не делаем — только прямая видимость (один «прыжок» BLE).
   Подпись Ed25519 своих пакетов и SHA-256 для peerID — через Web Crypto (нужен современный Chrome/Chromium,
   как и остальной проект); входящие подписи не проверяем (сами пакеты и так открытым текстом — см. тот же подход
   в meshcore-kernels.js). Своя пара ключей — на время жизни узла (пересоздание патча меняет peerID).
   Своего периферийного GATT-сервера приложение DSP не даёт (только реклама-маячок и роль центрального),
   поэтому «увидеть нас» снаружи bitchat не может — только мы видим и пишем им. */

async function bcGenIdentity(n){
  n.ready=false; n.status='generating keys…';
  try{
    const ed=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const x=await crypto.subtle.generateKey('X25519',true,['deriveBits']);
    n.edPriv=ed.privateKey;
    n.signPub=new Uint8Array(await crypto.subtle.exportKey('raw',ed.publicKey));
    n.noisePub=new Uint8Array(await crypto.subtle.exportKey('raw',x.publicKey));
    n.peerID=new Uint8Array(await crypto.subtle.digest('SHA-256',n.noisePub)).slice(0,8);
    n.ready=true; n.status='not connected';
  }catch(e){ n.status='Ed25519/X25519 unsupported — needs a recent Chrome/Chromium ('+e.message+')'; }
}
async function bcSign(n,pkt){ return new Uint8Array(await crypto.subtle.sign('Ed25519',n.edPriv,bcSigningBytes(pkt))); }

function bcStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status=n.ready ? 'not connected' : n.status;
  for(const p of n.peers.values()) p.state='seen';
}
function bcStart(n){
  bcStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status=(typeof gwErr==='function' && gwErr(n.p.url))||'URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected (bridge) — scanning'; bcSub(n); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) bcStart(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) bcFeed(n,r);
  };
}
function bcSub(n){
  const m=JSON.stringify({sub:['ble','gatt']});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function bcSend(n,cmd){ if(n.ws && n.ws.readyState===1) n.ws.send(JSON.stringify({...cmd,id:++n.seq})); }
function bcPeer(n,addr){ let p=n.peers.get(addr); if(!p){ p={state:'seen',lastSeen:0,senderHex:'',nickname:''}; n.peers.set(addr,p); } return p; }

function bcFeed(n,r){
  if(!r || typeof r!=='object') return;
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  if(r.src==='ble'){
    const uuids=(r.uuids||[]).map(u=>String(u).toLowerCase());
    if(!uuids.includes(BC_SERVICE_UUID)) return;
    const addr=r.addr; if(!addr) return;
    const p=bcPeer(n,addr); p.lastSeen=Date.now(); p.rssi=r.rssi;
    if(n.p.autoConnect && n.ready && (p.state==='seen' || p.state==='lost')){
      p.state='connecting'; bcSend(n,{cmd:'gatt.connect',addr,phy:'1m',mtu:0,read:false,notify:true,max:0,auto:false,timeout:12000});
    }
    return;
  }
  if(r.src!=='gatt') return;
  const addr=r.addr; const p=addr ? bcPeer(n,addr) : null;
  switch(r.ev){
    case 'connected': if(p){ p.state='connected'; bcAnnounceTo(n,addr); } break;
    case 'disconnected': if(p) p.state='lost'; break;
    case 'notify': case 'read':
      if(p && r.chr && String(r.chr).toLowerCase()===BC_CHAR_UUID && r.hex) bcRecv(n,addr,p,bcUnhex(r.hex));
      break;
  }
}

async function bcAnnounceTo(n,addr){
  if(!n.ready) return;
  const payload=bcEncodeAnnounce({nickname:n.p.nickname||'dsp',noisePublicKey:n.noisePub,signingPublicKey:n.signPub});
  const pkt={type:1,ttl:BC_TTL_DEFAULT,senderID:n.peerID,recipientID:null,timestamp:Date.now(),payload,signature:null};
  pkt.signature=await bcSign(n,pkt);
  bcSend(n,{cmd:'gatt.write',addr,svc:BC_SERVICE_UUID,chr:BC_CHAR_UUID,hex:bcHex(bcEncode(pkt)),resp:true});
}
// from/text — чтобы rec можно было завести прямо во вход rec узла Chat (modules/chat.js);
// там исходящее от «in/out» отличают по совпадению from с полем «my name», так что туда стоит
// поставить тот же никнейм, что здесь в params.nickname.
function bcLog(n,dir,nick,text){
  const row={t:Date.now(),dir,nick,from:nick,text};
  n.log.push(row); if(n.log.length>300) n.log.shift();
  n.recQ.push(row); if(n.recQ.length>2000) n.recQ.shift();
  n.lastLine=(dir==='out' ? '→ ' : '')+nick+': '+text;
  n.fresh=1;
}
async function bcRecv(n,addr,p,bytes){
  let pkt; try{ pkt=bcDecode(bytes); }catch(e){ return; }
  if(!pkt) return;
  if(pkt.type===1){ // announce — подпись не проверяем (см. заголовок файла), просто запоминаем, кто это
    const a=bcDecodeAnnounce(pkt.payload); if(!a) return;
    p.senderHex=bcHex(pkt.senderID); p.nickname=a.nickname;
    bcLog(n,'in','*',a.nickname+' is here');
    return;
  }
  if(pkt.type===2){ // message — публичный, может быть сжат (deflate-raw, Apple Compression "ZLIB" на деле — он)
    let payload=pkt.payload;
    if(pkt.isCompressed){
      if(typeof DecompressionStream==='undefined'){ bcLog(n,'in',p.nickname||addr,'[compressed message, unsupported browser]'); return; }
      try{
        const ds=new DecompressionStream('deflate-raw');
        const stream=new Blob([payload]).stream().pipeThrough(ds);
        payload=new Uint8Array(await new Response(stream).arrayBuffer());
      }catch(e){ bcLog(n,'in',p.nickname||addr,'[failed to decompress]'); return; }
    }
    let text; try{ text=new TextDecoder('utf-8').decode(payload); }catch(e){ return; }
    bcLog(n,'in',p.nickname||bcHex(pkt.senderID).slice(0,8)||addr,text);
  }
  // leave / fragment / noise* / ping / pong — вне базового чата, пропускаем
}
async function bcSendText(n,text){
  if(!n.ready || !text) return;
  const payload=new TextEncoder().encode(text);
  const pkt={type:2,ttl:BC_TTL_DEFAULT,senderID:n.peerID,recipientID:null,timestamp:Date.now(),payload,signature:null};
  pkt.signature=await bcSign(n,pkt);
  const bin=bcEncode(pkt), hex=bcHex(bin);
  let sent=0;
  for(const [addr,p] of n.peers) if(p.state==='connected'){ bcSend(n,{cmd:'gatt.write',addr,svc:BC_SERVICE_UUID,chr:BC_CHAR_UUID,hex,resp:true}); sent++; }
  bcLog(n,'out',n.p.nickname||'dsp',text+(sent ? '' : '  (no peers connected)'));
}

def({ id:'bitchat', title:'bitchat mesh chat (DSP app bridge)', cat:'Sources', kw:'bitchat ble mesh chat offline messaging bluetooth phone nearby without installing',
  ins:[{n:'send',t:'txt'}], outs:[{n:'rec',t:'rec'},{n:'line',t:'txt'},{n:'go',t:'num'},{n:'peers',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices'},
    {n:'nickname',t:'text',d:'dsp',label:'nickname (shown to bitchat peers)'},
    {n:'autoConnect',t:'check',d:true,label:'connect automatically to bitchat peers seen over BLE'},
    {n:'text',t:'text',d:'',label:'message'},
    {n:'send',t:'button',label:'Send',fn:n=>bcSendText(n,String(n.p.text||'').trim())},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'connect',t:'button',label:'Connect bridge',fn:n=>bcStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>bcStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.seq=0; n.ready=false; n.status='not connected'; n.warn=''; n.bridgeMsg=''; n.sentSub=null;
            n.peers=new Map(); n.log=[]; n.recQ=[]; n.lastLine=''; n.fresh=0; n.lastSend='';
            bcGenIdentity(n); },
  dispose:n=>bcStop(n),
  process(n,I){
    bcSub(n);
    const send=typeof I.send==='string' ? I.send : '';
    if(send && send!==n.lastSend) bcSendText(n,send);
    n.lastSend=send;
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    let peers=0; for(const p of n.peers.values()) if(p.state==='connected') peers++;
    return {rec, line:n.lastLine||null, go:fresh, peers};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let connected=0, seen=0; for(const p of n.peers.values()){ if(p.state==='connected') connected++; else seen++; }
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · peers '+connected+' connected, '+seen+' seen';
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    for(const row of n.log.slice(-8)) t+='\n'+(row.dir==='out' ? '→ ' : '')+row.nick+': '+row.text;
    if(r.textContent!==t) r.textContent=t; }
});
