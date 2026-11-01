"use strict";
/* ============================ VLC SOURCE ============================
   Любой звук в граф через libVLC приложения Android: файл или поток по сети, multicast провайдера (udp:// rtp://), smb:// ftp:// sftp:// nfs://
   upnp://, rtmp://, HLS, AC3 / DTS / FLAC / экзотические кодеки. Приложение (VlcHub.kt, команды моста vlc.*) декодирует и шлёт PCM на loopback,
   страница принимает его командой udp.open моста и выдаёт отсчётами с метками (ssPush / ssProcess, sources.js) — по часам блоков движка.
   Ядро — modules/vlcsrc-kernels.js; без приложения узел говорит, чего не хватает. */

const VLS_BRIDGE='ws://127.0.0.1:8765';
function vlsStatus(n,s){ n.status=s; }
function vlsLink(n){                                            // → Promise<NetSock>; одно соединение на узел
  if(n.lnP) return n.lnP;
  return n.lnP=new Promise((res,rej)=>{
    let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
    const url=typeof phoneUrl==='function' ? phoneUrl(String(n.p.bridge||VLS_BRIDGE).trim(),key) : '';
    if(!url){ n.lnP=null; return rej(new Error('the bridge address must start with ws:// or be a device name (@name)')); }
    let ws; try{ ws=new WebSocket(url); }catch(e){ n.lnP=null; return rej(e); }
    const ns=new NetSock(m=>{ if(ws.readyState!==1) throw new Error('the bridge is not connected'); ws.send(JSON.stringify(m)); });
    ns.hooks.add(r=>{ if(r.ev==='data' && r.proto==='udp' && r.conn===n.udpConn && r.hex) vlsPush(n,r.hex); });
    ws.onopen=()=>{ n.ws=ws; ws.send(JSON.stringify({sub:['net']})); res(ns); };
    ws.onerror=()=>{ if(!n.ws){ n.lnP=null; rej(new Error('no connection to the bridge ('+url.replace(/\?.*$/,'')+') — VLC Source works through the DSP app for Android (is it running?)')); } };
    ws.onclose=()=>{ const was=n.ws===ws; n.lnP=null; n.ws=null; n.udpConn=null; n.vid=0; if(was){ vlsStatus(n,'bridge closed'); n.playing=0; } };
    ws.onmessage=e=>{
      if(typeof e.data!=='string') return;
      let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
      for(const r of Array.isArray(j) ? j : [j]){ if(r && r.src==='vlc') vlsEvent(n,r); else ns.feed(r); }
    };
  });
}
function vlsDrop(n){ const ws=n.ws; n.lnP=null; n.ns=null; n.ws=null; if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} } }
// событие libVLC: состояние, название, позиция
function vlsEvent(n,r){
  if(r.ev!=='state' || r.vid!==n.vid) return;
  n.state=r.state; n.pos=vlsSec(r.pos); n.dur=vlsSec(r.dur); if(r.title) n.title=String(r.title);
  n.playing= r.state==='playing' ? 1 : 0;
  if(r.state==='error') vlsStatus(n,'error: '+(r.msg||'libVLC cannot play this'));
  else if(r.state==='ended'){ n.endPulse=1; vlsStatus(n,'ended'); }
  else vlsStatus(n,r.state+(n.title ? ' · '+n.title : ''));
}
// датаграмма PCM → отсчёты с метками по часам performance.now (как у микрофона телефона)
function vlsPush(n,hex){
  const f=vlsFeed(n.pcm,hex); if(!f || !f.length) return;
  const ch=n.pcm.ch, sr=n.sr, fr=f.length/ch|0, wall=performance.now()/1000, dur=fr/sr;
  if(!n.vT || Math.abs(n.vT-(wall-dur))>.5){ n.vT=wall-dur; if(n.vT0) ssInit(n,2); n.vT0=1; n.sExact=true; n.sLag=Math.max(.05,+n.p.lag/1000||.3); }
  for(let i=0;i<fr;i++){ const l=f[i*ch]; ssPush(n,n.vT+i/sr,[l,ch===2 ? f[i*ch+1] : l]); }
  n.vT+=dur; n.rx+=f.length*2;
}
async function vlsStop(n){
  const vid=n.vid, ns=n.ns, conn=n.udpConn; n.vid=0; n.udpConn=null; n.playing=0; n.gen=(n.gen||0)+1;
  if(ns){ try{ if(vid) await ns.call('vlc.close',{vid},4000); }catch(e){} try{ if(conn!=null) await ns.call('udp.close',{conn},4000); }catch(e){} }
}
async function vlsStart(n,url){
  url=String(url||'').trim();
  if(!url){ vlsStatus(n,'enter an address (URL) and press Play'); return; }
  await vlsStop(n);
  const g=n.gen;
  n.pcm=vlsNew(n.p.channels==='mono' ? 1 : 2); n.sr=vlsRate(n.p.rate,Eng.sr); n.vT=0; n.vT0=0; ssInit(n,2); n.sExact=true; n.rx=0; n.title=''; n.pos=0; n.dur=0; n.url=url;
  vlsStatus(n,'connecting to the app…');
  try{
    const ns=n.ns=await vlsLink(n); if(g!==n.gen) return;
    let conn=null, port=0;
    for(let k=0;k<5 && conn==null;k++){                                    // порт мог быть занят — другой
      port=vlsPort();
      try{ const u=await ns.call('udp.open',{port},6000); conn=u.conn; }catch(e){ if(k===4) throw e; }
    }
    n.udpConn=conn; n.port=port;
    vlsStatus(n,'asking libVLC to open the address…');
    const r=await ns.call('vlc.open',{url,port,rate:n.sr,channels:n.pcm.ch,caching:+n.p.caching||1000},25000);
    if(g!==n.gen){ try{ await ns.call('vlc.close',{vid:r.vid},3000); }catch(e){} return; }
    n.vid=r.vid; vlsStatus(n,'opening…');
  }catch(e){ if(g===n.gen) vlsStatus(n,'error: '+e.message); }
}

def({ id:'vlcsrc', title:'VLC Source', cat:'Sources', readout:true, always:true, resize:true, w:320,
  kw:'vlc libvlc audio source stream decode any codec ac3 dts flac multicast iptv radio smb ftp upnp rtmp file network sound input',
  ins:[{n:'url',t:'txt'},{n:'go',t:'num'},{n:'pause',t:'num'}],
  outs:[{n:'l',t:'sig'},{n:'r',t:'sig'},{n:'title',t:'txt'},{n:'pos',t:'num'},{n:'dur',t:'num'},{n:'playing',t:'num'},{n:'end',t:'num'}],
  params:[
    {n:'url',t:'text',d:'',label:'address: a file or a stream on the network (http / https / HLS), multicast udp://@239.1.1.1:1234 or rtp://@…, rtsp://, rtmp://, smb://, ftp://, sftp://, nfs://, upnp:// — any format libVLC knows (AC3 / DTS / FLAC / AAC / Opus …)'},
    {n:'playb',t:'button',label:'Play',fn:n=>vlsStart(n,n.p.url)},
    {n:'stopb',t:'button',label:'Stop',fn:n=>{ vlsStop(n); vlsStatus(n,'stopped'); }},
    {n:'rate',t:'select',opts:['graph','8000','16000','22050','44100','48000','96000'],d:'graph',label:'sample rate asked from libVLC (graph — the rate of the graph); the signal is interpolated to the graph rate anyway'},
    {n:'channels',t:'select',opts:['stereo','mono'],d:'stereo',label:'channels: stereo → «l» and «r»; mono → both outputs the same'},
    {n:'caching',t:'range',min:100,max:5000,step:100,d:1000,label:'libVLC network cache, ms (more — fewer dropouts on a bad network, a later start)'},
    {n:'lag',t:'range',min:50,max:1000,step:10,d:300,label:'smoothing reserve in the graph, ms (less — shorter delay, but gaps if the pieces come unevenly)'},
    {n:'bridge',t:'text',d:VLS_BRIDGE,label:'bridge of the DSP app: ws://127.0.0.1:8765 or a device name (@phone)'}],
  init(n){ ssInit(n,2); n.sExact=true; n.sLag=.3; n.pcm=vlsNew(2); n.sr=48000; n.vT=0; n.vT0=0; n.ns=null; n.ws=null; n.lnP=null; n.udpConn=null; n.vid=0; n.port=0; n.gen=0;
    n.status='enter an address and press Play (needs the DSP app for Android)'; n.title=''; n.pos=0; n.dur=0; n.playing=0; n.state=''; n.rx=0; n.endPulse=0;
    n.inUrl=''; n.goPrev=false; n.pausePrev=false; n.url=''; },
  dispose(n){ vlsStop(n).finally(()=>vlsDrop(n)); },
  process(n,I){
    if(typeof I.url==='string' && I.url && I.url!==n.inUrl){ n.inUrl=I.url; setMod(n,'url',I.url); vlsStart(n,I.url); }
    const go=(I.go||0)>.5; if(go && !n.goPrev) vlsStart(n,n.p.url); n.goPrev=go;
    const ps=(I.pause||0)>.5;
    if(ps!==n.pausePrev){ n.pausePrev=ps; if(n.vid && n.ns){ n.ns.call('vlc.cmd',{vid:n.vid,a:ps ? 'pause' : 'play'},4000).catch(()=>{}); } }
    const l=buf(n,'l'), r=buf(n,'r');
    if(n.vT0) ssProcess(n,[l,r]); else { l.fill(0); r.fill(0); }
    const end=n.endPulse; n.endPulse=0;
    return {l,r,title:n.title,pos:n.pos,dur:n.dur,playing:n.playing,end}; },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.vT0 ? '\n'+(n.sr/1000).toFixed(1)+' kHz · '+(n.pcm.ch===2 ? 'stereo' : 'mono')+' · '+(n.rx/1024|0)+' kB'+(ssStatus(n) ? ' · '+ssStatus(n) : '') : '');
    if(r.textContent!==t) r.textContent=t; }
});
