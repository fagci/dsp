"use strict";
/* ============================ OpenWebRX ============================
   Клиент удалённого приёмника OpenWebRX / OpenWebRX+: WebSocket ws://host:port/ws/, демодуляция на сервере,
   сюда приходит готовый звук. Протокол и разбор — в openwebrx-kernels.js. Звук идёт в кольцо и ресемплируется
   так же, как у KiwiSDR (netAudioRead). Частота задаётся абсолютной: смещение от центра ленты считается здесь. */

const OWRX_MODS=['am','lsb','usb','cw','nfm','wfm'];
const OWRX_OUT=12000, OWRX_HD=44100;                       // запрошенные частоты звука: обычный и HD (wfm)

function owrxWsUrl(a){
  if(Net.proxy){
    let u=Net.url(`http${a.tls?'s':''}://${a.host}:${a.port}/ws/`);
    if(!/^[a-z]+:\/\//i.test(u)) u=new URL(u,location.href).href;
    return u.replace(/^http/i,'ws');
  }
  if(!a.tls && location.protocol==='https:') throw new Error('set a proxy in Settings (https page cannot open ws://)');
  return `${a.tls?'wss':'ws'}://${a.host}:${a.port}/ws/`;
}
const owrxSend=(n,o)=>{ if(n.ws && n.ws.readyState===1) n.ws.send(typeof o==='string' ? o : JSON.stringify(o)); };

function owrxRange(n){ return n.cfg ? [n.cfg.center-n.cfg.sr/2, n.cfg.center+n.cfg.sr/2] : null; }

// частота, полоса, режим → dspcontrol; вне ленты сервера — не шлём и пишем причину в статус
function owrxTune(n){
  if(!n.connected || !n.cfg) return;
  const r=owrxRange(n), off=Math.round(n.p.freq-n.cfg.center);
  if(n.p.freq<r[0] || n.p.freq>r[1]){
    n.status=`out of range: server covers ${fmtHz(r[0])} … ${fmtHz(r[1])}`; n.outOfRange=true; return;
  }
  n.outOfRange=false; n.status='connected';
  const [lo,hi]=owrxPassband(n.p.mod,n.p.bw);
  const params={low_cut:Math.round(lo),high_cut:Math.round(hi),offset_freq:off,mod:n.p.mod,squelch_level:-150,secondary_mod:false};
  if(!n.started){ n.started=true; owrxSend(n,{type:'dspcontrol',action:'start'}); }
  owrxSend(n,{type:'dspcontrol',params});
  n.appliedFreq=n.p.freq; n.appliedMod=n.p.mod; n.appliedBw=n.p.bw;
}

function owrxPush(n,pcm,rate){
  if(rate!==n.audioRate){ n.audioRate=rate; kiwiResetRing(n); }
  const ring=n.ring; let w=ring.w, filled=ring.filled;
  for(let i=0;i<pcm.length;i++){
    ring.A[w]=pcm[i]/32768;
    w=(w+1)%ring.size; if(filled<ring.size) filled++;
  }
  ring.w=w; ring.filled=filled; ring.written+=pcm.length;
}

function owrxOnText(n,str){
  const m=owrxText(str); if(!m) return;
  if(m.type==='hello'){ n.ver=(m.server||'?')+(m.version?' '+m.version:''); return; }
  const v=m.value;
  if(m.type==='config' && v){
    if(v.center_freq!=null && v.samp_rate!=null) n.cfg={center:+v.center_freq,sr:+v.samp_rate};
    if(typeof v.audio_compression==='string') n.comp=v.audio_compression;
    if(n.cfg) owrxTune(n);
  }else if(m.type==='smeter' && typeof v==='number') n.rssi=owrxDb(v);
  else if(m.type==='sdr_error' || m.type==='demodulator_error') n.status='server: '+(typeof v==='string' ? v : JSON.stringify(v));
  else if(m.type==='backoff') n.status='server busy, try again later';
}

function owrxOnBin(n,buf8){
  if(buf8.length<2) return;
  const t=buf8[0], body=buf8.subarray(1);
  if(t!==2 && t!==4) return;                               // FFT нам не нужен
  let pcm;
  if(n.comp==='adpcm') pcm=n.codec.decode(body);
  else{ const k=body.length>>1; pcm=new Int16Array(k); const dv=new DataView(body.buffer,body.byteOffset,k*2); for(let i=0;i<k;i++) pcm[i]=dv.getInt16(i*2,true); }
  owrxPush(n,pcm,t===4 ? OWRX_HD : OWRX_OUT);
}

function owrxConnect(n){
  if(n.connected||n.connecting) return;
  const a=owrxParseAddr(n.p.server);
  if(!a.host){ n.status='server address not set'; return; }
  n.connecting=true; n.status='connecting…';
  let ws;
  try{ ws=new WebSocket(owrxWsUrl(a)); }
  catch(e){ n.connecting=false; n.status='error: '+e.message; return; }
  ws.binaryType='arraybuffer';
  n.ws=ws; n.cfg=null; n.started=false; n.comp='none'; n.codec.reset(); n.rssi=-150; n.audioRate=OWRX_OUT; kiwiResetRing(n);
  const openTimeout=setTimeout(()=>{
    if(n.connecting){ n.status='no response from server (timeout)'; try{ ws.close(); }catch(e){} }
  },8000);
  ws.onopen=()=>{
    clearTimeout(openTimeout);
    n.connecting=false; n.connected=true; n.status='connected, waiting for config…';
    owrxSend(n,'SERVER DE CLIENT client=openwebrx.js type=receiver');
    owrxSend(n,{type:'connectionproperties',params:{output_rate:OWRX_OUT,hd_output_rate:OWRX_HD}});
  };
  ws.onmessage=ev=>{
    if(typeof ev.data==='string') owrxOnText(n,ev.data);
    else if(ev.data instanceof ArrayBuffer) owrxOnBin(n,new Uint8Array(ev.data));
  };
  ws.onclose=ev=>{ clearTimeout(openTimeout); n.connected=false; n.connecting=false;
    if(n.status==='connected'||n.status==='connecting…'||n.status.startsWith('connected,')) n.status=`disconnected (code ${ev.code}${ev.reason?': '+ev.reason:''})`; };
  ws.onerror=()=>{ n.status='connection error (see browser console for details)'; };
}

function owrxDisconnect(n){
  if(n.ws){ const ws=n.ws; n.ws=null; ws.onclose=null; try{ ws.close(); }catch(e){} }
  n.connected=false; n.connecting=false; n.cfg=null; n.status='disconnected';
}

def({ id:'openwebrx', title:'OpenWebRX', cat:'Sources',
  ins:[{n:'freq',t:'num'},{n:'server',t:'txt'}], outs:[{n:'audio',t:'sig'},{n:'rssi',t:'num'}],
  view:{h:40}, readout:true,
  params:[
    {n:'server',t:'text',d:'',label:'host:port (wss:// — with TLS)'},
    {n:'connect',t:'button',label:'Connect',fn:n=>owrxConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>owrxDisconnect(n)},
    {n:'freq',t:'num',d:7100000,label:'frequency, Hz (within the server band)'},
    {n:'mod',t:'select',opts:OWRX_MODS,d:'am',label:'demodulation',fn:n=>{ if(n.connected) owrxTune(n); }},
    {n:'bw',t:'range',min:200,max:12000,step:100,d:2700,log:true,label:'bandwidth, Hz',fn:n=>{ if(n.connected) owrxTune(n); }}
  ],
  init:n=>{ n.ws=null; n.connected=false; n.connecting=false; n.status='not connected'; n.cfg=null; n.started=false;
            n.comp='none'; n.codec=owrxAdpcm(); n.ver=''; n.audioRate=OWRX_OUT; n.rssi=-150; n.appliedFreq=null; kiwiResetRing(n); },
  dispose:n=>owrxDisconnect(n),
  process(n,I){
    if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    if(typeof I.server==='string' && I.server && I.server!==n.p.server){
      n.p.server=I.server; if(n.set && n.set.server) n.set.server(I.server);
      if(n.connected||n.connecting){ owrxDisconnect(n); owrxConnect(n); }
    }
    if(n.connected && n.cfg && (Math.round(n.p.freq)!==Math.round(n.appliedFreq) || n.p.mod!==n.appliedMod || n.p.bw!==n.appliedBw)) owrxTune(n);
    const oa=buf(n,'audio'), [lo,hi]=owrxPassband(n.p.mod,n.p.bw);
    netAudioRead(n,oa,n.p.mod==='wfm' ? 15000 : Math.max(Math.abs(lo),Math.abs(hi)));
    return {audio:oa,rssi:n.rssi}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = n.connected && n.cfg && !n.outOfRange
      ? `${n.p.server} · ${n.p.mod} · ${fmtHz(n.p.freq)} · ${n.rssi.toFixed(0)} dB${n.ver?' · '+n.ver:''}`
      : n.status; }});
