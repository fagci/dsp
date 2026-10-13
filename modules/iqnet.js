"use strict";
/* ============================ IQ по сети ============================
   Поток IQ из WebSocket на выход 'iq' — для любого приёмника, который умеет отдавать отсчёты в трубу.
   rtl_tcp: браузер не открывает TCP, нужен мост «TCP → WebSocket» (websockify 8766 host:1234, websocat, любой прокси);
   заголовок «RTL0» и команды (частота, частота дискретизации, усиление, ppm, bias-T, прямая выборка) — как у rtl_tcp.
   raw stream: просто байты IQ (uint8 / int8 / int16 LE / float32 LE) на заданной частоте дискретизации и центре:
   rtl_sdr - | websocat -b -s 8766, hackrf_transfer -r - …, GNU Radio, SoapySDR, свой скрипт.
   SpyServer (Airspy One / HF+ / RTL-SDR): тот же мост (websockify 8766 host:5555); частота дискретизации — ступень децимации
   сервера (максимум / 2^k), усиление сервера в старших 16 битах типа сообщения снимается на приёме.
   Со страницы по https — только wss://. */

const IQN_FRAME={'uint8':2,'int8':2,'int16 LE':4,'float32 LE':8};                       // байт на комплексный отсчёт
const IQN_TUNERS=['unknown','E4000','FC0012','FC0013','FC2580','R820T','R828D'];
const IQN_SPY_VER=(2<<24)|1700;                                                           // версия протокола SpyServer 2.0.1700
const IQN_SPY_DEV=['invalid','Airspy One','Airspy HF+','RTL-SDR'];
const iqnSr=n=>(n.sp && n.sp.sr) || +n.p.sr || 1e6;                                     // у SpyServer частоту задаёт сервер
const IQN_QMAX_S=2;                                                                      // сколько секунд держим в очереди, дальше выбрасываем старое
function iqnStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null; n.ok=false;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function iqnStart(n){
  iqnStop(n);
  const url=String(n.p.url||'').trim();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; n.bad=false; iqnOpen(n,url);
}
function iqnOpen(n,url){
  let ws;
  try{ ws=new WebSocket(url); }
  catch(e){ n.status='error: '+e.message; iqnRetry(n,url); return; }
  ws.binaryType='arraybuffer'; n.ws=ws; n.status='connecting…';
  n.q=[]; n.qN=0; n.carry=new Uint8Array(0); n.hdr=n.p.proto==='rtl_tcp' ? new Uint8Array(0) : null; n.ap={}; n.tuner='';
  n.sp=n.p.proto==='SpyServer' ? {buf:new Uint8Array(0), info:null, go:false, ap:{}, sr:0, can:true} : null;
  ws.onopen=()=>{
    n.ok=true;
    if(n.sp){ n.status='connected, waiting for SpyServer…'; iqnSpyCmd(n,0,iqnSpyHello()); }
    else n.status=n.p.proto==='rtl_tcp' ? 'connected, waiting for the rtl_tcp header…' : 'connected';
  };
  ws.onerror=()=>{ n.status='connection error'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.ok=false;
    if(!n.bad) n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    iqnRetry(n,url);
  };
  ws.onmessage=e=>{ if(typeof e.data!=='string') iqnIn(n,new Uint8Array(e.data)); };
}
function iqnRetry(n,url){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) iqnOpen(n,url); },3000); } }
function iqnIn(n,u){
  n.bytes+=u.length;
  if(n.sp) return iqnSpyIn(n,u);
  if(n.hdr){                                                                            // rtl_tcp: 12 байт — «RTL0», тип тюнера, число ступеней усиления
    const m=new Uint8Array(n.hdr.length+u.length); m.set(n.hdr); m.set(u,n.hdr.length);
    if(m.length<12){ n.hdr=m; return; }
    if(String.fromCharCode(m[0],m[1],m[2],m[3])!=='RTL0'){ n.status='not an rtl_tcp server (no RTL0 header)'; n.want=false; n.bad=true; try{ n.ws.close(); }catch(e){} return; }
    const dv=new DataView(m.buffer);
    n.tuner=IQN_TUNERS[dv.getUint32(4,false)]||'tuner '+dv.getUint32(4,false); n.gains=dv.getUint32(8,false);
    n.hdr=null; n.status='connected, '+n.tuner; u=m.subarray(12);
    if(!u.length) return;
  }
  const fs=IQN_FRAME[n.p.proto==='rtl_tcp' ? 'uint8' : n.p.fmt]||2;
  if(n.carry.length){ const m=new Uint8Array(n.carry.length+u.length); m.set(n.carry); m.set(u,n.carry.length); u=m; n.carry=new Uint8Array(0); }
  const use=u.length-(u.length%fs);
  if(use<u.length) n.carry=u.slice(use);
  if(!use) return;
  const body=u.slice(0,use), fmt=n.p.proto==='rtl_tcp' ? 'uint8' : n.p.fmt, k=use/fs;
  let c;
  if(fmt==='uint8') c={raw:body,fmt:'u8',n:k};
  else if(fmt==='int16 LE') c={raw:new Int16Array(body.buffer,0,k*2),fmt:'s16',n:k};
  else{
    const re=new Float32Array(k), im=new Float32Array(k);
    if(fmt==='int8'){ const s=new Int8Array(body.buffer); for(let i=0;i<k;i++){ re[i]=s[2*i]/128; im[i]=s[2*i+1]/128; } }
    else { const dv=new DataView(body.buffer); for(let i=0;i<k;i++){ re[i]=dv.getFloat32(8*i,true); im[i]=dv.getFloat32(8*i+4,true); } }
    c={re,im,n:k};
  }
  iqnQueue(n,c,k);
}
function iqnQueue(n,c,k){
  n.q.push(c); n.qN+=k;
  const lim=Math.max(1,iqnSr(n))*IQN_QMAX_S;
  if(n.qN>lim){ while(n.qN>lim/2 && n.q.length>1){ n.qN-=n.q.shift().n; } n.gap=true; n.dropped++; }
}
// ---- SpyServer: все поля uint32 little-endian ----
// команда: {тип, размер тела}; сообщение: {протокол, тип | флаги<<16, поток, номер, размер тела}
function iqnSpyHello(){
  const name=new TextEncoder().encode('dsp'), b=new Uint8Array(4+name.length);
  new DataView(b.buffer).setUint32(0,IQN_SPY_VER,true); b.set(name,4);
  return b;
}
function iqnSpyCmd(n,type,body){
  if(!n.ws || n.ws.readyState!==1) return;
  const b=new Uint8Array(8+body.length), dv=new DataView(b.buffer);
  dv.setUint32(0,type,true); dv.setUint32(4,body.length,true); b.set(body,8);
  n.ws.send(b);
}
function iqnSpySet(n,setting,value){
  const b=new Uint8Array(8), dv=new DataView(b.buffer);
  dv.setUint32(0,setting,true); dv.setUint32(4,value>>>0,true);
  iqnSpyCmd(n,2,b);
}
// ступени децимации сервера: частота = максимум / 2^k, k от MinimumIQDecimation до DecimationStageCount
function iqnSpyRates(i){
  const r=[];
  for(let k=i.minDec;k<=Math.max(i.minDec,i.stages);k++) r.push({k, sr:i.maxSr/2**k});
  return r;
}
function iqnSpyPick(n){
  const want=+n.p.sr||1e6, rs=iqnSpyRates(n.sp.info);
  let b=rs[0];
  for(const r of rs) if(Math.abs(Math.log(r.sr/want))<Math.abs(Math.log(b.sr/want))) b=r;
  return b;
}
function iqnSpyIn(n,u){
  const s=n.sp;
  if(s.buf.length){ const m=new Uint8Array(s.buf.length+u.length); m.set(s.buf); m.set(u,s.buf.length); u=m; }
  let o=0;
  while(u.length-o>=20){
    const dv=new DataView(u.buffer,u.byteOffset+o,20), mt=dv.getUint32(4,true), size=dv.getUint32(16,true);
    if(size>(1<<20)){ n.status='SpyServer: bad message size'; n.want=false; n.bad=true; try{ n.ws.close(); }catch(e){} return; }
    if(u.length-o<20+size) break;
    iqnSpyMsg(n,mt&0xffff,mt>>>16,u.slice(o+20,o+20+size));
    o+=20+size;
  }
  s.buf=u.slice(o);
}
function iqnSpyMsg(n,type,flags,body){
  const s=n.sp, dv=new DataView(body.buffer);
  if(type===0 && body.length>=48){                                                       // DEVICE_INFO
    const v=i=>dv.getUint32(i*4,true);
    s.info={dev:v(0), serial:v(1), maxSr:v(2), stages:v(4), gains:v(5), maxGain:v(6), minF:v(7), maxF:v(8), minDec:v(10)};
    n.tuner=(IQN_SPY_DEV[s.info.dev]||'device '+s.info.dev)+' #'+s.info.serial;
    n.status='connected, '+n.tuner+(s.can ? '' : ' (view only)');
    const pick=iqnSpyPick(n);
    iqnSpySet(n,0,1);                                                                    // режим: только IQ
    iqnSpySet(n,100,2);                                                                  // формат: int16
    s.ap={}; iqnSpySync(n);
    iqnSpySet(n,1,1);                                                                    // поток включён
    s.go=true; s.sr=pick.sr;
  }
  else if(type===1 && body.length>=16){ s.can=!!dv.getUint32(0,true); }   // CLIENT_SYNC: CanControl
  else if(type>=100 && type<=103 && s.go){                                              // IQ: uint8 / int16 / int24 / float
    const g=10**(flags/20);
    let c, k;
    if(type===101){
      k=body.length>>2; if(!k) return;
      const a=new Int16Array(body.buffer,0,k*2);
      if(flags===0) c={raw:a,fmt:'s16',n:k};
      else{ const re=new Float32Array(k), im=new Float32Array(k), sc=1/(32768*g); for(let i=0;i<k;i++){ re[i]=a[2*i]*sc; im[i]=a[2*i+1]*sc; } c={re,im,n:k}; }
    }
    else if(type===100){
      k=body.length>>1; if(!k) return;
      const re=new Float32Array(k), im=new Float32Array(k), sc=1/(128*g);
      for(let i=0;i<k;i++){ re[i]=(body[2*i]-128)*sc; im[i]=(body[2*i+1]-128)*sc; }
      c={re,im,n:k};
    }
    else if(type===103){
      k=body.length>>3; if(!k) return;
      const a=new Float32Array(body.buffer,0,k*2), re=new Float32Array(k), im=new Float32Array(k);
      for(let i=0;i<k;i++){ re[i]=a[2*i]/g; im[i]=a[2*i+1]/g; }
      c={re,im,n:k};
    }
    else return;                                                                          // int24 не поддержан, формат запрашиваем int16
    iqnQueue(n,c,k);
  }
}
// параметры → настройки сервера: отправляем только изменившееся
function iqnSpySync(n){
  const s=n.sp;
  if(!n.ok || !s || !s.info) return;
  const p=n.p, pick=iqnSpyPick(n), g=Math.round(+p.spygain);
  const want=[['dec',102,pick.k],['freq',101,Math.round(+p.freq)],['gain',2,g>=0 ? Math.min(g,s.info.maxGain) : null]];
  for(const [k,cmd,v] of want){
    if(v===null || s.ap[k]===v) continue;
    s.ap[k]=v; iqnSpySet(n,cmd,v);
    if(k==='dec') s.sr=pick.sr;
  }
}
function iqnCmd(n,cmd,val){
  if(!n.ws || n.ws.readyState!==1) return;
  const b=new Uint8Array(5); b[0]=cmd; new DataView(b.buffer).setUint32(1,val>>>0,false); n.ws.send(b);
}
// параметры → команды rtl_tcp: отправляем только изменившееся (провод на параметр работает так же)
function iqnSync(n){
  if(n.sp) return iqnSpySync(n);
  if(n.p.proto!=='rtl_tcp' || !n.ok || n.hdr) return;
  const p=n.p, g=+p.gain||0;
  const want=[['sr',0x02,Math.round(+p.sr)],['freq',0x01,Math.round(+p.freq)],['gm',0x03,g>0 ? 1 : 0],['gain',0x04,g>0 ? Math.round(g*10) : null],
              ['ppm',0x05,Math.round(+p.ppm)||0],['agc',0x08,p.agc ? 1 : 0],['direct',0x09,p.direct==='I' ? 1 : p.direct==='Q' ? 2 : 0],['bias',0x0e,p.bias ? 1 : 0]];
  for(const [k,cmd,v] of want){
    if(v===null || n.ap[k]===v) continue;
    n.ap[k]=v; iqnCmd(n,cmd,v);
  }
}
def({ id:'iqnet', title:'IQ over Network', cat:'Sources', kw:'rtl_tcp rtl-tcp remote sdr iq stream websocket websockify websocat raspberry pi soapy hackrf rtl_sdr',
  outs:[{n:'iq',t:'iq'},{n:'sr',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'ws://127.0.0.1:8766',label:'WebSocket: ws:// wss:// (rtl_tcp: through a bridge, e.g. websockify 8766 host:1234)'},
          {n:'proto',t:'select',opts:['rtl_tcp','raw stream','SpyServer'],d:'rtl_tcp',label:'protocol'},
          {n:'fmt',t:'select',opts:Object.keys(IQN_FRAME),d:'uint8',label:'raw stream: sample format (interleaved I, Q)'},
          {n:'sr',t:'num',d:1024000,label:'sample rate, Hz (rtl_tcp: sent to the server; SpyServer: nearest decimation step)'},
          {n:'freq',t:'num',d:100000000,label:'center frequency, Hz (rtl_tcp, SpyServer: tuned; raw stream: only labels the stream)'},
          {n:'gain',t:'num',d:0,label:'rtl_tcp: tuner gain, dB (0 — auto)'},
          {n:'ppm',t:'num',d:0,label:'rtl_tcp: frequency correction, ppm'},
          {n:'agc',t:'check',d:false,label:'rtl_tcp: RTL AGC'},
          {n:'bias',t:'check',d:false,label:'rtl_tcp: bias-T (V4 and similar)'},
          {n:'direct',t:'select',opts:['off','I','Q'],d:'off',label:'rtl_tcp: direct sampling branch (HF)'},
          {n:'spygain',t:'num',d:-1,label:'SpyServer: gain index (−1 — leave as the server has it)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>iqnStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>iqnStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.ok=false; n.timer=null; n.q=[]; n.qN=0; n.carry=new Uint8Array(0); n.hdr=null; n.ap={}; n.tuner=''; n.sp=null;
            n.gap=false; n.dropped=0; n.bytes=0; n.rate=0; n.rateT=performance.now(); n.rateB=0; n.fc=null; n.status='not connected'; n.warn=''; },
  dispose:n=>iqnStop(n),
  process(n){
    iqnSync(n);
    if(n._iqOrd!==Graph.order){ n._iqOrd=Graph.order; n._iqWired=Graph.edges.some(e=>e.from===n.id && e.fp==='iq'); }
    const sr=iqnSr(n), fc=+n.p.freq||0;
    if(!n._iqWired || !n.ok || n.hdr || (n.sp && !n.sp.go)){ if(!n._iqWired){ n.q=[]; n.qN=0; } return {iq:null,sr}; }
    const s=iqStream(n,'iq',sr,fc);
    let tag=n.gap ? 'gap' : null; n.gap=false;
    if(n.fc!==null && fc!==n.fc) tag='retune';
    n.fc=fc;
    for(const c of n.q.splice(0)){ if(c.raw) iqPushRaw(s,c.raw,c.fmt,tag); else iqPush(s,c.re,c.im,tag); tag=null; }
    n.qN=0;
    return {iq:s,sr};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const now=performance.now();
    if(now-n.rateT>1000){ n.rate=(n.bytes-n.rateB)/((now-n.rateT)/1000); n.rateB=n.bytes; n.rateT=now; }
    const fs=n.sp ? 4 : IQN_FRAME[n.p.proto==='rtl_tcp' ? 'uint8' : n.p.fmt]||2;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+(n.ok ? ' · '+(n.rate/fs/1e6).toFixed(3)+' MS/s received (set '+(iqnSr(n)/1e6).toFixed(3)+')' : '')+
      (n.dropped ? ' · overflows '+n.dropped : '');
    if(r.textContent!==t) r.textContent=t; }
});
