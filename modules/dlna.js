"use strict";
/* ============================ DLNA / UPnP: экран и звук по сети ============================
   Cast Receiver — телефон (страница) как устройство вывода: появляется в меню «Передать на устройство» плееров, галерей, VLC, Windows;
   Cast to Screen — пульт: найти телевизор / колонку и послать им файл или адрес. Протокол — upnp-kernels.js (проверен настоящим пультом
   async-upnp-client, tools/test-upnp.mjs), сокеты — приложение DSP (udp.open с multicast, tcp.listen), связь с мостом — netsvc.js.
   Chromecast и AirPlay не поддерживаются: у них шифрованные закрытые протоколы. */

/* ---------- Cast Receiver ---------- */
function dlnarxPlayer(n){
  const v=n.video;
  return {
    load:(uri,meta)=>{ n.title=meta.title||''; n.cls=meta.cls||''; n.err=''; if(n.p.frames) v.crossOrigin='anonymous'; else v.removeAttribute('crossorigin'); v.src=uri; v.load(); },
    play:()=>{ v.play().catch(e=>{ n.err=e.name+': '+e.message; if(e.name!=='NotAllowedError') n.rend?.playerEvent('error'); }); },
    pause:()=>v.pause(),
    stop:()=>{ v.pause(); try{ v.currentTime=0; }catch(e){} },
    seek:t=>{ try{ v.currentTime=t; }catch(e){} },
    setVolume:p=>{ v.volume=Math.max(0,Math.min(1,p/100)); n.vol=p; },
    setMute:m=>{ v.muted=!!m||!!n.p.silent; },
    info:()=>({pos:v.currentTime||0,dur:isFinite(v.duration) ? v.duration : NaN,paused:v.paused,ended:v.ended,error:!!v.error,seeking:v.seeking}),
  };
}
async function dlnarxStart(n){
  if(n.running || n.starting) return;
  n.starting=true; n.status='connecting…';
  try{
    const ns=await nsvLink(n), info=await ns.call('net.info').catch(()=>null);
    const host=((info&&info.ips)||[]).find(ip=>/^\d+\.\d+\.\d+\.\d+$/.test(ip) && !/^127\./.test(ip)) || '127.0.0.1';
    if(!n.p.uuid) setMod(n,'uuid',upnpUuid());
    const r=new UpnpRenderer(ns,dlnarxPlayer(n),{name:String(n.p.name||'DSP'),uuid:n.p.uuid,host,port:+n.p.port||0,autoplay:!!n.p.autoplay,volume:+n.p.volume,
      onState:e=>{ for(const k in e.vars){ const v=e.vars[k]; nsvPush(n,{src:'dlna',ev:k,value:v && typeof v==='object' ? v.val : v}); } n.pulse=2; }});
    n.rend=r; n.video.muted=!!n.p.silent; n.video.volume=Math.max(0,Math.min(1,(+n.p.volume>=0 ? +n.p.volume : 100)/100));
    const port=await r.start();
    n.running=true; n.urls=['http://'+host+':'+port+'/desc.xml'];
    n.status='«'+n.p.name+'» is on the network · '+(r.ssdp||'');
  }catch(e){ n.status='error: '+(e.message||e); n.running=false; try{ await n.rend?.stop(); }catch(x){} n.rend=null; }
  n.starting=false;
}
async function dlnarxStop(n){
  n.running=false; n.urls=null;
  try{ await n.rend?.stop(); }catch(e){} n.rend=null;
  try{ n.video.pause(); n.video.removeAttribute('src'); n.video.load(); }catch(e){}
  n.status='stopped'; n.title='';
}
def({ id:'dlnarx', title:'Cast Receiver (DLNA / UPnP)', cat:'Sources', kw:'dlna upnp cast receiver renderer screen display speaker sound airplay chromecast tv media render play to device vlc phone as tv miracast',
  ins:[{n:'start',t:'num'}], outs:[{n:'vid',t:'vid'},{n:'img',t:'img'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'title',t:'txt'},{n:'state',t:'txt'},{n:'playing',t:'num'},{n:'pos',t:'num'},{n:'dur',t:'num'},{n:'volume',t:'num'},{n:'on',t:'num'}],
  view:{h:160}, readout:true, tall:true, always:true, resize:true, w:360,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'name',t:'text',d:'DSP',label:'name in the «cast to» lists'},
    {n:'port',t:'range',min:0,max:65535,step:1,d:0,label:'HTTP port of the device description (0 — any)'},
    {n:'autoplay',t:'check',d:false,label:'start playing as soon as the address arrives (most controllers send Play themselves)'},
    {n:'volume',t:'range',min:0,max:100,step:1,d:100,label:'start volume, % (the sender can change it)'},
    {n:'silent',t:'check',d:false,label:'no sound from the phone (picture only, e.g. to take the frames into the graph)'},
    {n:'frames',t:'check',d:false,label:'frames to «img»: the picture is readable by the graph only when the media server sends CORS headers, and some servers without them then fail to play'},
    {n:'w',t:'select',opts:['80','160','320','640'],d:'160',label:'«img» width',adv:true},
    {n:'uuid',t:'text',d:'',label:'device id (made once, keeps the receiver the same device for the senders)',adv:true},
    {n:'startBtn',t:'button',label:'Start',fn:n=>dlnarxStart(n)},
    {n:'stopBtn',t:'button',label:'Stop',fn:n=>dlnarxStop(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.rend=null; n.running=false; n.starting=false; n.status='stopped'; n.urls=null; n.warn=''; n.recQ=[]; n.pulse=0; n.prevStart=0;
            n.title=''; n.cls=''; n.err=''; n.vol=100; n.img=null; n._key=''; n.stat='';
            n.video=document.createElement('video'); n.video.playsInline=true; n.video.preload='auto';
            n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
            const v=n.video, ev=k=>()=>n.rend?.playerEvent(k);
            v.addEventListener('ended',ev('ended')); v.addEventListener('error',ev('error')); v.addEventListener('playing',ev('playing')); v.addEventListener('pause',()=>{ if(!v.ended && !v.seeking) n.rend?.playerEvent('paused'); }); },
  dispose:n=>{ dlnarxStop(n); nsvDrop(n); try{ n.video.removeAttribute('src'); n.video.load(); }catch(e){} },
  process(n,I){
    const st=(I.start||0)>.5; if(st && !n.prevStart) dlnarxStart(n); n.prevStart=st;
    const v=n.video, s=n.rend?.st, rec=n.recQ.length ? n.recQ.splice(0) : null;
    const pl=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
    return {vid:v.videoWidth ? v : null,img:n.img||null,rec,text:s?.uri||'',title:n.title||'',state:s?.state||'',playing:s?.state==='PLAYING' ? 1 : 0,pos:v.currentTime||0,dur:isFinite(v.duration) ? v.duration : 0,volume:s?.volume??n.p.volume,on:n.running ? 1 : 0}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r){
      const s=n.rend?.st, t=(n.warn&&!n.running ? '⚠ '+n.warn+'\n' : '')+n.status+(n.urls ? '\n'+n.urls[0] : '')+(s ? '\n'+s.state+(n.title ? ' · '+n.title : '')+(n.err ? '\n⚠ '+n.err : '') : '')+(n.rend ? '\nactions '+n.rend.stats.actions+' · searches '+n.rend.stats.searches+' · subscribers '+n.rend.subs.size : '');
      if(r.textContent!==t) r.textContent=t; }
    const v=n.video; if(!cv) return;
    cx.fillStyle='#000'; cx.fillRect(0,0,cv.width,cv.height);
    if(!v.videoWidth) return;
    const k=Math.min(cv.width/v.videoWidth,cv.height/v.videoHeight), w=v.videoWidth*k, h=v.videoHeight*k;
    try{ cx.drawImage(v,(cv.width-w)/2,(cv.height-h)/2,w,h); }catch(e){}
    if(n.p.frames){
      const W=+n.p.w||160, H=Math.round(W*(v.videoHeight/v.videoWidth||3/4)), tf=v.getVideoPlaybackQuality?.().totalVideoFrames;
      const key=(tf??performance.now())+'|'+W+'x'+H; if(key===n._key) return; n._key=key;
      if(n.capCv.width!==W || n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
      n.capCx.drawImage(v,0,0,W,H);
      try{ n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1}; }catch(e){ n.err='no CORS on the media server — frames unreadable'; }
    } } });

/* ---------- Cast to Screen (пульт) ---------- */
const DLNACAST_ACTIONS=['cast (set address + play)','play','pause','stop','seek','volume','mute','unmute','status'];
// LOCATION из строки: адрес описания, IP (ищем юникастовым M-SEARCH) или запись обнаружения
async function dlnacastLocation(ns,v,rec){
  if(rec && rec.location) return rec.location;
  v=String(v||'').trim(); if(!v) return '';
  if(/^https?:\/\//i.test(v)) return v;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(v)){
    let loc=''; await discRun(ns,{ssdp:true,st:UPNP_RENDERER,targets:[v+':1900'],wait:2500,desc:false,onRec:r=>{ if(!loc && r.location) loc=r.location; }});
    return loc;
  }
  return '';
}
function dlnacastRun(n){
  const act=n.p.action;
  nsvClientRun(n,async ns=>{
    const rec=Array.isArray(n.recIn) ? n.recIn.find(r=>r && r.location && /renderer|speaker|cast|^$/.test(String(r.kind||''))) || n.recIn.find(r=>r && r.location) : null;
    const loc=await dlnacastLocation(ns,n.hostIn||n.p.host,rec);
    if(!loc) throw new Error('no player: set its description address (http://…/desc.xml) or IP, or wire Device Discovery records to «rec»');
    const desc=(await httpFetch(ns,loc,{timeout:5000})).text();
    const avt=upnpFindService(desc,loc,'AVTransport'), rc=upnpFindService(desc,loc,'RenderingControl');
    const name=upnpParseDesc(desc).name||'player';
    if(!avt) throw new Error('«'+name+'» has no AVTransport service — it cannot play from the network');
    const A=(a,args={})=>upnpCall(ns,avt,a,{InstanceID:0,...args});
    switch(act){
      case DLNACAST_ACTIONS[0]: {
        let uri=String(n.urlIn||n.p.media||'').trim(), mime=String(n.p.mime||'').trim(), title=String(n.p.title||'').trim();
        if(n.binIn){                                                 // файл с графа: отдаём своим HTTP-сервером, адрес — по IP телефона
          const info=await ns.call('net.info').catch(()=>null), v4=((info&&info.ips)||[]).filter(x=>/^\d+\.\d+\.\d+\.\d+$/.test(x)), ip=v4.find(x=>!/^127\./.test(x)) || v4[0];
          if(!ip) throw new Error('the phone has no network address to serve the file from');
          if(!n.vfs) n.vfs=new VfsMem();
          const fn=String(n.binIn.name||'media').replace(/[^\w.\-]+/g,'_')||'media'; await n.vfs.write('/'+fn,n.binIn.d,n.binIn.mime);
          if(!n.srv){ n.srv=new HttpServer(ns,httpFileHandler(n.vfs,{write:false}),{cors:true}); n.srvPort=await n.srv.start(+n.p.servePort||8090,true); }
          uri='http://'+ip+':'+n.srvPort+'/'+encodeURIComponent(fn); mime=mime||n.binIn.mime||httpMime(fn); title=title||n.binIn.name||fn;
        }
        if(!uri) throw new Error('what to play: set the address in «media», on the «url» input, or wire a file to «bin»');
        mime=mime||httpMime(uri.split('?')[0]).split(';')[0]; title=title||nsvName(uri)||'DSP';
        const cls=/^audio/.test(mime) ? 'object.item.audioItem' : /^image/.test(mime) ? 'object.item.imageItem' : 'object.item.videoItem';
        await A('Stop').catch(()=>{});
        await A('SetAVTransportURI',{CurrentURI:uri,CurrentURIMetaData:upnpDidlItem({title,uri,mime,cls})});
        await A('Play',{Speed:1});
        return {status:'«'+name+'» plays '+uri,text:uri,rows:[{src:'dlna',ev:'cast',renderer:name,location:loc,uri,mime}]};
      }
      case 'play': await A('Play',{Speed:1}); return {status:'«'+name+'»: play'};
      case 'pause': await A('Pause'); return {status:'«'+name+'»: pause'};
      case 'stop': await A('Stop'); return {status:'«'+name+'»: stop'};
      case 'seek': { const t=Math.max(0,+n.p.seek||0); await A('Seek',{Unit:'REL_TIME',Target:upnpTime(t)}); return {status:'«'+name+'»: '+upnpTime(t)}; }
      case 'volume': case 'mute': case 'unmute': {
        if(!rc) throw new Error('«'+name+'» has no RenderingControl service');
        const R=(a,args)=>upnpCall(ns,rc,a,{InstanceID:0,Channel:'Master',...args});
        if(act==='volume'){ const v=Math.max(0,Math.min(100,Math.round(+n.p.volume))); await R('SetVolume',{DesiredVolume:v}); return {status:'«'+name+'»: volume '+v,code:v}; }
        await R('SetMute',{DesiredMute:act==='mute' ? 1 : 0}); return {status:'«'+name+'»: '+act};
      }
      case 'status': {
        const ti=await A('GetTransportInfo'), pi=await A('GetPositionInfo'), vol=rc ? await upnpCall(ns,rc,'GetVolume',{InstanceID:0,Channel:'Master'}).catch(()=>null) : null;
        const d=upnpDidl(pi.TrackMetaData);
        return {status:'«'+name+'»: '+ti.CurrentTransportState+' · '+pi.RelTime+' / '+pi.TrackDuration+(vol ? ' · vol '+vol.CurrentVolume : ''),text:pi.TrackURI||'',code:vol ? +vol.CurrentVolume : 0,
          rows:[{src:'dlna',ev:'status',renderer:name,state:ti.CurrentTransportState,uri:pi.TrackURI,title:d.title,pos:pi.RelTime,dur:pi.TrackDuration,volume:vol ? +vol.CurrentVolume : null}]};
      }
    }
    throw new Error('unknown action');
  });
}
def({ id:'dlnacast', title:'Cast to Screen (DLNA / UPnP)', cat:'Sources', kw:'dlna upnp cast sender controller push play tv television speaker renderer screen media send file video music airplay chromecast',
  ins:[{n:'go',t:'num'},{n:'host',t:'txt'},{n:'url',t:'txt'},{n:'bin',t:'bin'},{n:'rec',t:'rec'}], outs:NSV_CLI_OUTS, readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:NSV_URL,label:'bridge of the DSP app'},
    {n:'host',t:'text',d:'',label:'the player: description address http://ip:port/desc.xml (Device Discovery gives it), or just its IP (the «host» input overrides; records with a location on «rec» work too)'},
    {n:'action',t:'select',opts:DLNACAST_ACTIONS,d:DLNACAST_ACTIONS[0],label:'action (Run, or a rising edge on go)'},
    {n:'media',t:'text',d:'',label:'cast: address of the file or stream http://… (the «url» input overrides; a file on «bin» is served by the phone itself)'},
    {n:'title',t:'text',d:'',label:'cast: title shown on the screen'},
    {n:'mime',t:'text',d:'',label:'cast: media type (empty — by the extension)'},
    {n:'seek',t:'num',d:0,label:'seek: position, s'},
    {n:'volume',t:'range',min:0,max:100,step:1,d:30,label:'volume, %'},
    {n:'servePort',t:'range',min:1024,max:65535,step:1,d:8090,label:'port of the phone\'s file server for «bin»',adv:true},
    {n:'run',t:'button',label:'Run',fn:n=>dlnacastRun(n)}],
  init:n=>{ n.nsP=null; n.ns=null; n.ws=null; n.recQ=[]; n.busy=false; n.status='idle'; n.ok=0; n.code=0; n.pulse=0; n.outBin=null; n.outText=null; n.prevGo=0; n.hostIn=''; n.urlIn=''; n.binIn=null; n.recIn=null; n.cliSrc='dlna'; n.warn=''; n.srv=null; n.vfs=null; n.srvPort=0; },
  dispose:n=>{ try{ n.srv?.stop(); }catch(e){} n.srv=null; nsvDrop(n); },
  process(n,I){
    n.hostIn=typeof I.host==='string' ? I.host : ''; n.urlIn=typeof I.url==='string' ? I.url : ''; n.binIn=I.bin||null; n.recIn=Array.isArray(I.rec) ? I.rec : null;
    const go=(I.go||0)>.5; if(go && !n.prevGo) dlnacastRun(n); n.prevGo=go;
    return nsvClientOut(n); },
  draw:nsvClientDraw });
