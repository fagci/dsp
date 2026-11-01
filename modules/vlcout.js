"use strict";
/* ============================ VLC OUT ============================
   Звук графа наружу через libVLC приложения Android: HTTP-сервер на телефоне (слушатель открывает http://телефон:порт/путь в любом плеере),
   RTP / multicast, Icecast, файл, Chromecast / UPnP. Страница шлёт PCM на loopback (udp.send моста, VlcHub.kt vlc.out.*), libVLC кодирует и отдаёт.
   Ядро — modules/vlcout-kernels.js. Пароль Icecast — только через пин «pass» (в патч не попадает). */

const VLO_BRIDGE='ws://127.0.0.1:8765';
function vloLink(n){                                            // → Promise<NetSock>; одно соединение на узел
  if(n.lnP) return n.lnP;
  return n.lnP=new Promise((res,rej)=>{
    let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
    const url=typeof phoneUrl==='function' ? phoneUrl(String(n.p.bridge||VLO_BRIDGE).trim(),key) : '';
    if(!url){ n.lnP=null; return rej(new Error('the bridge address must start with ws:// or be a device name (@name)')); }
    let ws; try{ ws=new WebSocket(url); }catch(e){ n.lnP=null; return rej(e); }
    const ns=new NetSock(m=>{ if(ws.readyState!==1) throw new Error('the bridge is not connected'); ws.send(JSON.stringify(m)); });
    ws.onopen=()=>{ n.ws=ws; res(ns); };
    ws.onerror=()=>{ if(!n.ws){ n.lnP=null; rej(new Error('no connection to the bridge ('+url.replace(/\?.*$/,'')+') — VLC Out works through the DSP app for Android (is it running?)')); } };
    ws.onclose=()=>{ const was=n.ws===ws; n.lnP=null; n.ws=null; if(was){ n.oid=0; n.live=0; n.status='bridge closed'; } };
    ws.onmessage=e=>{
      if(typeof e.data!=='string') return;
      let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
      for(const r of Array.isArray(j) ? j : [j]){ if(r && r.src==='vlc'){ if(r.ev==='out' && r.oid===n.oid) vloEvent(n,r); } else ns.feed(r); }
    };
  });
}
function vloDrop(n){ const ws=n.ws; n.lnP=null; n.ns=null; n.ws=null; if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} } }
function vloEvent(n,r){
  n.state=r.state;
  if(r.state==='error'){ n.live=0; n.status='error: '+(r.msg||'libVLC cannot send there'); }
  else if(r.state==='stopped'){ n.live=0; }
  else n.status=(r.state==='playing' ? 'on the air' : r.state)+(n.where ? ' · '+n.where : '');
}
async function vloStop(n){
  const oid=n.oid, ns=n.ns; n.oid=0; n.live=0; n.gen=(n.gen||0)+1; n.where='';
  if(ns && oid){ try{ await ns.call('vlc.out.close',{oid},4000); }catch(e){} }
}
async function vloStart(n){
  await vloStop(n);
  const g=n.gen, a=vloArgs(n.p,n.pass,Eng.sr);
  if(typeof a==='string'){ n.status=a; return; }
  n.status='connecting to the app…';
  try{
    const ns=n.ns=await vloLink(n); if(g!==n.gen) return;
    n.status='asking libVLC to start the output…';
    const r=await ns.call('vlc.out.open',a,30000);
    if(g!==n.gen){ try{ await ns.call('vlc.out.close',{oid:r.oid},3000); }catch(e){} return; }
    n.oid=r.oid; n.port=r.port; n.pk=vloNew(a.channels,a.rate); n.tx=0; n.drop=0;
    const ips=Array.isArray(r.ips) ? r.ips : [];
    n.where= a.mode==='http' ? (ips.length ? 'http://'+ips[0]+':'+a.port+'/'+a.mount.replace(/^\//,'') : 'port '+a.port)
      : a.mode==='rtp' ? 'rtp://'+a.host+':'+a.port
      : a.mode==='icecast' ? a.host+':'+a.port+'/'+a.mount
      : a.mode==='file' ? (r.path||'') : (r.device||a.renderer);
    n.url=a.mode==='http' && ips.length ? n.where : '';
    n.live=1; n.status='starting · '+n.where;
  }catch(e){ if(g===n.gen) n.status='error: '+e.message; }
}
async function vloFind(n){
  n.status='looking for devices (up to 4 s)…';
  try{
    const ns=n.ns=await vloLink(n);
    const r=await ns.call('vlc.out.renderers',{ms:4000},20000);
    const names=Array.isArray(r.names) ? r.names : [];
    n.status='devices: '+vloDevices(names);
    if(names.length && !String(n.p.device||'').trim()){ const f=String(names[0]).replace(/\s*\([^()]*\)\s*$/,''); setMod(n,'device',f); }
  }catch(e){ n.status='error: '+e.message; }
}

def({ id:'vlcout', title:'VLC Out', cat:'Output', readout:true, always:true, resize:true, w:320,
  kw:'vlc libvlc output stream radio icecast shoutcast http server rtp multicast chromecast upnp dlna cast record file mp3 aac opus flac transmit broadcast speaker',
  ins:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'on',t:'num'},{n:'pass',t:'txt'}],
  outs:[{n:'url',t:'txt'},{n:'live',t:'num'}],
  params:[
    {n:'mode',t:'select',opts:VLO_MODES,d:'http server',label:'where to: http server — the phone serves the stream, any player opens http://phone:port/path; rtp / multicast — to a group or a host; icecast — to a radio server; file — a recording in the app folder; chromecast / upnp — to a speaker or a TV on the network'},
    {n:'codec',t:'select',opts:['mp3','aac','opus','flac'],d:'mp3',label:'codec (rtp: mp3 / aac; icecast: mp3 / opus)'},
    {n:'bitrate',t:'range',min:32,max:320,step:8,d:128,label:'bitrate, kbit/s (not for flac)'},
    {n:'outrate',t:'select',opts:['48000','44100'],d:'48000',label:'sample rate of the stream (opus is always 48000)'},
    {n:'channels',t:'select',opts:['stereo','mono'],d:'stereo',label:'channels (mono mixes L and R)'},
    {n:'host',t:'text',d:'',label:'rtp / icecast: address (rtp: 239.1.1.1 or a host; icecast: the server)'},
    {n:'port',t:'num',d:8080,label:'port: http — the phone\'s own (1024+); rtp / icecast — the remote one'},
    {n:'path',t:'text',d:'dsp',label:'http / icecast: the path (mount); file: the name of the file'},
    {n:'user',t:'text',d:'source',label:'icecast: login (the password goes to the «pass» pin)'},
    {n:'device',t:'text',d:'',label:'chromecast / upnp: the device name (a part is enough)'},
    {n:'findb',t:'button',label:'Find devices',fn:n=>vloFind(n)},
    {n:'startb',t:'button',label:'Start',fn:n=>vloStart(n)},
    {n:'stopb',t:'button',label:'Stop',fn:n=>{ vloStop(n).then(()=>{ n.status='stopped'; }); }},
    {n:'caching',t:'range',min:50,max:2000,step:50,d:300,label:'input buffer of libVLC, ms (more — fewer dropouts, a bigger delay)'},
    {n:'ttl',t:'range',min:1,max:32,step:1,d:4,label:'rtp multicast: hops (TTL)'},
    {n:'bridge',t:'text',d:VLO_BRIDGE,label:'bridge of the DSP app: ws://127.0.0.1:8765 or a device name (@phone)'}],
  init(n){ n.ns=null; n.ws=null; n.lnP=null; n.oid=0; n.live=0; n.gen=0; n.pk=null; n.tx=0; n.drop=0; n.where=''; n.url=''; n.pass=''; n.onPrev=false; n.state='';
    n.status='choose where to and press Start (needs the DSP app for Android)'; },
  dispose(n){ vloStop(n).finally(()=>vloDrop(n)); },
  process(n,I){
    if(typeof I.pass==='string') n.pass=I.pass;
    const on=typeof I.on==='number' ? I.on>.5 : null;
    if(on!==null && on!==n.onPrev){ n.onPrev=on; if(on) vloStart(n); else { vloStop(n).then(()=>{ n.status='stopped'; }); } }
    if(n.live && n.oid && n.ws && n.ws.readyState===1){
      for(const h of vloPack(n.pk,I.L||null,I.R||null)){
        if(n.ws.bufferedAmount>1<<20){ n.drop++; continue; }                 // сеть до приложения не успевает — лишнее выбрасываем
        n.ws.send('{"cmd":"udp.send","host":"127.0.0.1","port":'+n.port+',"hex":"'+h+'"}'); n.tx+=h.length>>1;
      }
    }
    return {url:n.url,live:n.live}; },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.live ? '\n'+(n.tx/1024|0)+' kB sent'+(n.drop ? ' · dropped '+n.drop : '') : '');
    if(r.textContent!==t) r.textContent=t; }
});
