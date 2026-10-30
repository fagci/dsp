"use strict";
/* ============================ OpenWebRX ============================
   Клиент удалённого приёмника OpenWebRX / OpenWebRX+: WebSocket ws://host:port/ws/, демодуляция на сервере,
   сюда приходит готовый звук. Протокол и разбор — в openwebrx-kernels.js. Звук идёт в кольцо и ресемплируется
   так же, как у KiwiSDR (netAudioRead). Выход spec — FFT ленты сервера (абсолютные частоты). Частота задаётся абсолютной: смещение от центра ленты считается здесь.
   Профили сервера (диапазоны / приёмники) — сообщение 'profiles', выбор — 'selectprofile'; режимы — сообщение 'modes', цифровые декодирует сервер,
   их сообщения идут на rec / text. Смена профиля меняет приёмник у всех слушателей сервера. */

const OWRX_QMAX=500;                                       // сообщений в очереди на выход rec
const OWRX_OUT=12000, OWRX_HD=44100;                       // запрошенные частоты звука: обычный и HD (wfm)

function owrxWsUrl(a){
  if(Net.proxy){
    let u=Net.url(`http${a.tls?'s':''}://${a.host}:${a.port}/ws/`,true);
    if(!/^[a-z]+:\/\//i.test(u)) u=new URL(u,location.href).href;
    return u.replace(/^http/i,'ws');
  }
  if(!a.tls && location.protocol==='https:' && !Net.app) throw new Error('set a proxy in Settings (https page cannot open ws://)');
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
  const pl=owrxPlan(n.p.mod,n.modes,n.p.under,n.p.bw);
  if(pl.err){ n.status=pl.err; return; }
  n.outOfRange=false; n.status='connected';
  const params={offset_freq:off,mod:pl.mod,squelch_level:-150,secondary_mod:pl.sec};
  if(pl.lo!=null){ params.low_cut=Math.round(pl.lo); params.high_cut=Math.round(pl.hi); }
  if(pl.sub && +n.p.subfreq) params.secondary_offset_freq=Math.round(+n.p.subfreq);
  if(!n.started){ n.started=true; owrxSend(n,{type:'dspcontrol',action:'start'}); }
  owrxSend(n,{type:'dspcontrol',params});
  n.plan=pl; n.appliedKey=owrxTuneKey(n);
}
const owrxTuneKey=n=>[Math.round(n.p.freq),n.p.mod,n.p.under,n.p.bw,n.p.subfreq,n.modes?n.modes.length:0].join('|');

// выбор профиля: имя / id / подстрока. Сервер ответит новым config — владеет перестройкой owrxOnText
function owrxSelectProfile(n,q){
  const p=owrxFindProfile(n.profiles,q);
  if(!p){ if(String(q||'').trim()) n.status='no such profile: '+q; return; }
  if(p.id===n.profId) return;
  n.status='switching to '+p.name+'…'; n.specHold=Date.now()+3000; owrxSend(n,{type:'selectprofile',params:{profile:p.id}});
}

// профиль из патча — один раз и только когда известен текущий: иначе переключили бы сервер на тот же профиль
function owrxInitialProfile(n){
  if(n.profAsked || !n.p.profile || !n.profId || !n.profiles.length) return;
  n.profAsked=true; owrxSelectProfile(n,n.p.profile);
}

// сообщения цифровых режимов и метаданные → очередь rec; одна строка — на text
function owrxMsg(n,v,kind){
  const rec=v && typeof v==='object' ? {t:Date.now(),kind,...v} : {t:Date.now(),kind,text:String(v)};
  n.q.push(rec); if(n.q.length>OWRX_QMAX) n.q.shift();
  n.lastText=owrxMsgText(v); n.nmsg++;
}

// Для 'sa' (как у USB SDR): spec.chans — полоса канала вокруг частоты, spec.pickBw — полоса для подсказки маркера,
// spec.setChanBw — перетаскивание края шторки меняет bw (только у аналоговых режимов: у цифровых полосу задаёт сервер)
const OWRX_ANALOG_BW=[200,12000];
function owrxChan(n){
  const pl=n.plan; if(!pl || !n.cfg || n.outOfRange) return null;
  const f=n.p.freq, bw=+n.p.bw||2700, mode=pl.mod.toUpperCase();
  const lo=pl.lo!=null ? f+pl.lo : f-bw/2, hi=pl.hi!=null ? f+pl.hi : f+bw/2;
  return {idx:0,f,lo,hi,mode,rssi:n.rssi,snr:null,sql:null,sqOpen:true};
}
function owrxSetChanBw(n,mode,w){
  const pl=n.plan; if(!pl || pl.sec) return;
  const bw=mode==='USB' ? w-(pl.lo||0) : mode==='LSB' ? w+(pl.hi||0) : w;
  setMod(n,'bw',Math.round(clamp(bw,OWRX_ANALOG_BW[0],OWRX_ANALOG_BW[1])));
}
function owrxSpecOut(n){
  const sp=n.connected ? n.spec : null; if(!sp) return null;
  const c=owrxChan(n), pl=n.plan;
  sp.chans=c ? [c] : null;
  sp.pickBw=c ? {mode:c.mode,pass:c.mode==='USB' ? pl.hi : c.mode==='LSB' ? -pl.lo : (c.hi-c.lo)/2} : null;
  sp.setChanBw=c && !pl.sec ? (n._setChanBw||(n._setChanBw=(mode,w)=>owrxSetChanBw(n,mode,w))) : undefined;
  return sp;
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
    // сервер шлёт только изменившиеся поля — сливаем с прежним config
    if(v.center_freq!=null || v.samp_rate!=null){
      const c=v.center_freq!=null ? +v.center_freq : n.cfg&&n.cfg.center, s=v.samp_rate!=null ? +v.samp_rate : n.cfg&&n.cfg.sr;
      if(c!=null && s!=null && isFinite(c) && isFinite(s) && s>0){
        if(n.cfg && (n.cfg.center!==c || n.cfg.sr!==s)) n.spec=null;
        n.cfg={center:c,sr:s}; n.specHold=0;
      }
    }
    if(v.sdr_id!=null || v.profile_id!=null){
      const id=(v.sdr_id ?? (n.profId||'').split('|')[0])+'|'+(v.profile_id ?? (n.profId||'').split('|')[1]);
      if(id!==n.profId){ n.profId=id; n.started=false; n.spec=null; }       // новый профиль — заново start и ось спектра
      owrxInitialProfile(n);
    }
    if(typeof v.audio_compression==='string') n.comp=v.audio_compression;
    if(typeof v.fft_compression==='string') n.fcomp=v.fft_compression;
    if(n.cfg) owrxTune(n);
  }else if(m.type==='profiles' && Array.isArray(v)){
    n.profiles=v.filter(p=>p && p.id!=null).map(p=>({id:String(p.id),name:String(p.name ?? p.id)}));
    owrxInitialProfile(n);
  }else if(m.type==='modes' && Array.isArray(v)){ n.modes=v; if(n.cfg) owrxTune(n); }
  else if(m.type==='features' && v && typeof v==='object') n.features=v;
  else if(m.type==='secondary_demod' && v!=null) owrxMsg(n,v,'decoded');
  else if(m.type==='metadata' && v && typeof v==='object'){
    const k=JSON.stringify(v); if(k!==n.lastMeta){ n.lastMeta=k; owrxMsg(n,v,'metadata'); }
  }
  else if(m.type==='smeter' && typeof v==='number') n.rssi=owrxDb(v);
  else if(m.type==='sdr_error' || m.type==='demodulator_error') n.status='server: '+(typeof v==='string' ? v : JSON.stringify(v));
  else if(m.type==='backoff') n.status='server busy, try again later';
}

// дБ из кадра сервера → линейная амплитуда на абсолютной оси частот ленты
function owrxSpec(n,body){
  if(!n.cfg || n.specHold>Date.now()) return;                   // до нового config кадры принадлежат старому профилю
  const db=owrxFft(body,n.fcomp,n.fcodec), N=db.length; if(N<2) return;
  let sp=n.spec;
  if(!sp || sp.size!==N || n.specC!==n.cfg.center || n.specS!==n.cfg.sr){
    const f0=n.cfg.center-n.cfg.sr/2, st=n.cfg.sr/N, freqs=new Float64Array(N);
    for(let i=0;i<N;i++) freqs[i]=f0+(i+.5)*st;
    sp=n.spec={mag:new Float32Array(N),freqs,sr:n.cfg.sr,size:N,rev:(sp?sp.rev:0)};
    n.specC=n.cfg.center; n.specS=n.cfg.sr;
  }
  for(let i=0;i<N;i++) sp.mag[i]=Math.pow(10,db[i]/20);
  sp.rev++;
}

function owrxOnBin(n,buf8){
  if(buf8.length<2) return;
  const t=buf8[0], body=buf8.subarray(1);
  if(t===1){ owrxSpec(n,body); return; }
  if(t!==2 && t!==4) return;
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
  n.ws=ws; n.cfg=null; n.started=false; n.modes=null; n.features=null; n.profiles=[]; n.profId=''; n.profAsked=false; n.q=[]; n.lastMeta=''; n.comp='none'; n.fcomp='none'; n.spec=null; n.codec.reset(); n.fcodec.reset(); n.rssi=-150; n.audioRate=OWRX_OUT; kiwiResetRing(n);
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
  n.connected=false; n.connecting=false; n.cfg=null; n.modes=null; n.status='disconnected';
}

def({ id:'openwebrx', title:'OpenWebRX', cat:'Sources',
  ins:[{n:'freq',t:'num'},{n:'tuneFreq',t:'num'},{n:'steerFreq',t:'num'},{n:'bw',t:'num'},{n:'demod',t:'val'},{n:'server',t:'txt'},{n:'profile',t:'txt'}], outs:[{n:'audio',t:'sig'},{n:'spec',t:'spec'},{n:'rssi',t:'num'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'tuneFreq',t:'num'},{n:'bw',t:'num'},{n:'freqLo',t:'num'},{n:'freqHi',t:'num'},{n:'profile',t:'txt'}],
  view:{h:56}, readout:true,
  params:[
    {n:'server',t:'text',d:'',label:'host:port (wss:// — with TLS)'},
    {n:'connect',t:'button',label:'Connect',fn:n=>owrxConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>owrxDisconnect(n)},
    {n:'freq',t:'num',d:7100000,label:'frequency, Hz (within the server band)'},
    {n:'profile',t:'select',opts:n=>['',...(n.profiles||[]).map(p=>p.name)],d:'',label:'profile (band / receiver of the server; switching affects all listeners)',
     fn:n=>{ if(n.connected && n.p.profile) owrxSelectProfile(n,n.p.profile); }},
    {n:'mod',t:'select',opts:n=>{ const o=owrxModeNames(n.modes,n.features); if(!o.includes(n.p.mod)) o.push(n.p.mod); return o; },d:'am',
     label:'mode (the list comes from the server; digital modes are decoded by it → rec / text)',fn:n=>{ if(n.connected) owrxTune(n); }},
    {n:'under',t:'select',opts:['auto','usb','lsb','am','nfm','cw'],d:'auto',label:'digital mode: underlying modulation (auto — the server\'s first)',fn:n=>{ if(n.connected) owrxTune(n); }},
    {n:'subfreq',t:'num',d:0,label:'digital mode with a secondary spectrum: offset in the passband, Hz (0 — not sent)',fn:n=>{ if(n.connected) owrxTune(n); }},
    {n:'buf',t:'range',min:100,max:2000,step:50,d:300,label:'audio buffer, ms (less — lower delay, more dropouts on a bad network)'},
    {n:'bw',t:'range',min:200,max:12000,step:100,d:2700,log:true,label:'bandwidth, Hz (analog modes)',fn:n=>{ if(n.connected) owrxTune(n); }}
  ],
  init:n=>{ n.ws=null; n.connected=false; n.connecting=false; n.status='not connected'; n.cfg=null; n.started=false;
            n.modes=null; n.features=null; n.profiles=[]; n.profId=''; n.profAsked=false; n.q=[]; n.lastText=''; n.nmsg=0; n.lastMeta=''; n.plan=null;
            n.comp='none'; n.fcomp='none'; n.codec=owrxAdpcm(); n.fcodec=owrxAdpcm(); n.spec=null; n.ver=''; n.audioRate=OWRX_OUT; n.rssi=-150; n.appliedKey=''; kiwiResetRing(n); },
  dispose:n=>owrxDisconnect(n),
  process(n,I){
    if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    if(typeof I.tuneFreq==='number') setMod(n,'freq',I.tuneFreq);        // выход f1…f4 анализатора спектра, как у USB SDR
    if(typeof I.bw==='number' && I.bw>0) setMod(n,'bw',Math.round(clamp(I.bw,OWRX_ANALOG_BW[0],OWRX_ANALOG_BW[1])));
    if(typeof I.demod==='string'){ const d=I.demod.toLowerCase().replace(/^sam$/,'am'); if(d!==n.p.mod && owrxModeNames(n.modes,n.features).includes(d)) setMod(n,'mod',d); }
    if(typeof I.server==='string' && I.server && I.server!==n.p.server){
      n.p.server=I.server; if(n.set && n.set.server) n.set.server(I.server);
      if(n.connected||n.connecting){ owrxDisconnect(n); owrxConnect(n); }
    }
    if(typeof I.profile==='string' && I.profile && I.profile!==n.lastInProfile){
      n.lastInProfile=I.profile; n.p.profile=I.profile; if(n.set && n.set.profile) n.set.profile(I.profile);
      if(n.connected) owrxSelectProfile(n,I.profile);
    }
    if(n.connected && n.cfg && owrxTuneKey(n)!==n.appliedKey) owrxTune(n);
    const oa=buf(n,'audio'), pl=n.plan || owrxPlan(n.p.mod,null,n.p.under,n.p.bw);
    netAudioRead(n,oa,pl.mod==='wfm' ? 15000 : Math.max(Math.abs(pl.lo ?? 3000),Math.abs(pl.hi ?? 3000)),(+n.p.buf||300)/1000);
    const rec=n.q.length ? n.q.splice(0) : null, cur=(n.profiles.find(p=>p.id===n.profId)||{}).name ?? null;
    const r=owrxRange(n);
    return {audio:oa,rssi:n.rssi,spec:owrxSpecOut(n),tuneFreq:n.p.freq,bw:n.p.bw,freqLo:r?r[0]:null,freqHi:r?r[1]:null,rec,text:n.lastText||null,profile:cur}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = n.connected && n.cfg && !n.outOfRange
      ? `${n.p.server} · ${n.p.mod}${n.plan && n.plan.sec ? ' on '+n.plan.mod : ''} · ${fmtHz(n.p.freq)} · ${n.rssi.toFixed(0)} dB · buf ${Math.max(0,Math.round((n.ring.written-n.readCount)/n.audioRate*1000))} ms${n.ver?' · '+n.ver:''}`+
        ((n.profiles.find(p=>p.id===n.profId)||{}).name ? '\nprofile: '+n.profiles.find(p=>p.id===n.profId).name+' ('+n.profiles.length+')' : '')+
        (n.nmsg ? '\n'+n.lastText.slice(0,120) : '')
      : n.status+(n.outOfRange && n.profiles.length>1 ? '\nother profiles: '+n.profiles.map(p=>p.name).join(', ').slice(0,200) : ''); }});
