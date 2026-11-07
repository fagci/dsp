"use strict";
/* ============================ rtl_tcp Server (любой SDR) ============================
   Имитирует rtl_tcp поверх IQ, который уже есть в графе (USB SDR, HackRF…): отдаёт клиенту заголовок «RTL0» и поток uint8 IQ,
   а команды клиента (частота, частота дискретизации, усиление, ppm, bias-T…) разбирает и выводит на выходы — их проводами
   соединяют со входами приёмника (freq, sr, gainDb у USB SDR), так «чужой» клиент управляет железом через граф.
   Транспорты: Phone app — приложение DSP на Android само слушает TCP-порт (команда tcp.listen моста, как «Network (DSP app)»), SDR++ / GQRX
   подключаются прямо к телефону: ip:1234, ничего больше запускать не нужно; WebRTC — клиент iqnet с протоколом «rtl_tcp (WebRTC)» на другом устройстве (канал rtl узла WebRTC Data, webrtc.js);
   WebSocket — узел сам подключается к мосту tools/rtltcp-bridge.mjs, который слушает настоящий TCP-порт 1234 для SDR++, GQRX,
   rtl_power… (браузер порт открыть не может). Разбор протокола — rtlserve-kernels.js. */

const RTLS_MAXLOG=12;
function rtlsStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws && n.server && ws.readyState===1) try{ ws.send(JSON.stringify({cmd:'tcp.close',server:n.server,id:++n.cid})); }catch(e){}   // порт приложения отпускаем
  n.server=0; n.conn=0; n.aq=[]; n.aqN=0; n.inflight=0;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.cli=false; n.status='stopped';
}
function rtlsStart(n){
  rtlsStop(n);
  if(n.p.transport==='Phone app (TCP port)'){
    const url=gwUrl(String(n.p.url||'').trim());
    if(!/^wss?:\/\//i.test(url)){ n.status=gwErr(n.p.url)||'URL must start with ws:// or wss://'; return; }
    n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
    n.want=true; rtlsAppOpen(n,url); return;
  }
  if(n.p.transport==='WebRTC'){ n.want=true; n.status='waiting for the WebRTC connection'; return; }
  const url=gwUrl(String(n.p.url||'').trim());
  if(!/^wss?:\/\//i.test(url)){ n.status=gwErr(n.p.url)||'URL must start with ws:// or wss://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; rtlsOpen(n,url);
}
// ---- приложение Android: слушаем порт командой tcp.listen, клиент приходит событиями accept / data / close ----
// Команды приложения идут в пуле потоков, порядок не гарантирован: следующий tcp.send — после ответа на предыдущий.
const RTLS_CHUNK=16384, RTLS_QMAX=1<<20;
function rtlsAppCmd(n,o){ if(n.ws && n.ws.readyState===1){ o.id=++n.cid; n.ws.send(JSON.stringify(o)); return o.id; } return 0; }
function rtlsAppOpen(n,url){
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; rtlsRetry(n,url,true); return; }
  n.ws=ws; n.status='connecting to the app…'; n.server=0; n.conn=0; n.aq=[]; n.aqN=0; n.inflight=0; n.cid=0;
  ws.onopen=()=>{ n.listenId=rtlsAppCmd(n,{cmd:'tcp.listen',port:Math.round(+n.p.port)||1234,lan:!!n.p.lan}); n.status='asking the app to listen on :'+(Math.round(+n.p.port)||1234)+'…'; };
  ws.onerror=()=>{ n.status='connection error'; };
  ws.onclose=()=>{ if(n.ws!==ws) return; n.ws=null; n.cli=false; n.conn=0; n.server=0; n.status='app closed'+(n.p.reconnect ? ' — reconnecting…' : ''); rtlsRetry(n,url,true); };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let m; try{ m=JSON.parse(e.data); }catch(x){ return; }
    if(m.src==='cmd'){
      if(m.cmd==='tcp.listen' && m.id===n.listenId){
        if(m.ok){ n.server=m.server; n.status='listening on port '+m.port+(n.p.lan ? ' (LAN)' : ' (this phone only)')+' — waiting for a client'; }
        else{ n.status='tcp.listen: '+(m.msg||m.err||'refused')+' (ports 1024…65535, 4 servers at most)'; n.want=false; }
      } else if(m.cmd==='tcp.send'){ n.inflight=0; if(m.ok===false){ rtlsAppDrop(n); } else rtlsAppPump(n); }
      return;
    }
    if(m.src!=='net') return;
    if(m.ev==='accept' && m.server===n.server){
      if(n.conn){ rtlsAppCmd(n,{cmd:'tcp.close',conn:m.conn}); return; }              // как настоящий rtl_tcp — один клиент за раз
      n.conn=m.conn; n.peer=m.peer||''; rtlsClient(n,true);
    } else if(m.ev==='data' && m.conn===n.conn && n.conn){ rtlsRx(n,rtlsFromHex(m.hex||'')); }
    else if(m.ev==='close' && m.conn===n.conn && n.conn){ rtlsAppDrop(n); rtlsClient(n,false); }
    else if(m.ev==='close' && m.server && m.server===n.server){ n.server=0; n.status='the app closed the listener'; }
  };
}
function rtlsAppDrop(n){ n.aq=[]; n.aqN=0; n.inflight=0; if(n.conn){ n.conn=0; n.cli=false; } }
function rtlsAppSend(n,u8,force){
  if(!n.ws || n.ws.readyState!==1 || !n.conn) return false;
  if(!force && n.aqN>RTLS_QMAX) return false;
  for(let o=0;o<u8.length;o+=RTLS_CHUNK){ const c=u8.subarray(o,o+RTLS_CHUNK); n.aq.push(c); n.aqN+=c.length; }
  rtlsAppPump(n); return true;
}
function rtlsAppPump(n){
  if(n.inflight || !n.aq.length || !n.conn || !n.ws || n.ws.readyState!==1) return;
  const u=n.aq.shift(); n.aqN-=u.length; n.inflight=performance.now();
  rtlsAppCmd(n,{cmd:'tcp.send',conn:n.conn,hex:rtlsHexC(u)});
}
function rtlsOpen(n,url){
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; rtlsRetry(n,url); return; }
  ws.binaryType='arraybuffer'; n.ws=ws; n.status='connecting to the bridge…';
  ws.onopen=()=>{ n.status='bridge connected, waiting for a client'; };         // заголовок мост просит сам: см. sig 'hello' ниже
  ws.onerror=()=>{ n.status='connection error'; };
  ws.onclose=()=>{ if(n.ws!==ws) return; n.ws=null; n.cli=false; n.status='bridge closed'+(n.p.reconnect ? ' — reconnecting…' : ''); rtlsRetry(n,url); };
  ws.onmessage=e=>{
    if(typeof e.data==='string'){                                               // служебные: {"client":true} — подключился клиент TCP
      let m; try{ m=JSON.parse(e.data); }catch(x){ return; }
      if(m.client===true) rtlsClient(n,true); else if(m.client===false) rtlsClient(n,false);
      return;
    }
    rtlsRx(n,new Uint8Array(e.data));
  };
}
function rtlsRetry(n,url,app){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) (app ? rtlsAppOpen : rtlsOpen)(n,url); },3000); } }
function rtlsSend(n,u8,force){
  if(n.p.transport==='WebRTC') return rtcRtlSend(n.rn,u8,force);
  if(n.p.transport==='Phone app (TCP port)') return rtlsAppSend(n,u8,force);
  const ws=n.ws; if(!ws || ws.readyState!==1 || (!force && ws.bufferedAmount>(1<<20))) return false;
  try{ ws.send(u8); return true; }catch(e){ return false; }
}
// клиент подключился / отключился: заголовок и сброс разбора
function rtlsClient(n,on){
  n.cli=on; n.parser=new RtlsParser(); n.bytes=0; n.hello=false;
  if(on){ n.status='client connected'; if(n.p.transport!=='WebRTC') rtlsHello(n); }        // WebRTC: заголовок — по «привету» клиента (команда 0x00)
  else n.status=n.p.transport==='WebRTC' ? 'waiting for the client' : 'bridge connected, waiting for a client';
}
function rtlsHello(n){ rtlsSend(n,rtlsHeader(rtlsTunerId(n.p.tuner),Math.max(0,+n.p.gains|0)),true); n.hello=true; }
function rtlsRx(n,u){
  for(const c of n.parser.feed(u)){
    if(c.code===0){ rtlsHello(n); continue; }                                      // «привет» клиента iqnet по WebRTC
    rtlsApply(n.st,c); n.got[c.k]=1; n.cmds++;
    n.recs.push({t:'rtl_tcp',code:c.code,cmd:c.k,val:c.sval,hex:c.hex,info:c.d});
    n.log.push(c.hex+'  '+c.k+' = '+(c.k==='gain' ? c.sval/10 : c.sval)); if(n.log.length>RTLS_MAXLOG) n.log.shift();
  }
}
def({ id:'rtlserve', title:'rtl_tcp Server (any SDR)', cat:'IQ', kw:'rtl_tcp rtl-tcp server share remote sdr usb webrtc emulate sdr++ gqrx bridge',
  ins:[{n:'iq',t:'iq'},{n:'rtc',t:'rtc'}],
  outs:[{n:'freq',t:'num'},{n:'sr',t:'num'},{n:'gain',t:'num'},{n:'ppm',t:'num'},{n:'agc',t:'num'},{n:'bias',t:'num'},{n:'direct',t:'num'},
        {n:'rec',t:'rec'},{n:'client',t:'num'},{n:'cmds',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'transport',t:'select',opts:['WebRTC','Phone app (TCP port)','WebSocket (bridge)'],d:'WebRTC',label:'transport: WebRTC (wire WebRTC Data → rtc; the client is IQ over Network «rtl_tcp (WebRTC)»), Phone app (the Android app listens on a real TCP port — SDR++, GQRX connect to the phone) or WebSocket to tools/rtltcp-bridge.mjs on a computer'},
    {n:'url',t:'text',d:'ws://127.0.0.1:8767',dev:true,label:'bridge: the phone app ws://phone:8765 or node tools/rtltcp-bridge.mjs ws://host:8767/?token=… — or @name from Settings → Devices (the token stays there)'},
    {n:'port',t:'range',min:1024,max:65535,step:1,d:1234,label:'Phone app: TCP port to listen on (an app cannot take ports below 1024; rtl_tcp default is 1234)'},
    {n:'lan',t:'check',d:true,label:'Phone app: allow other devices on the network (off — only this phone)'},
    {n:'tuner',t:'select',opts:RTLS_TUNERS.slice(1),d:'R820T',label:'tuner type in the header (what the client thinks it talks to)'},
    {n:'gains',t:'num',d:29,label:'gain steps in the header (R820T — 29)'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'start',t:'button',label:'Start',fn:n=>rtlsStart(n)},
    {n:'stop',t:'button',label:'Stop',fn:n=>rtlsStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.cli=false; n.timer=null; n.parser=new RtlsParser(); n.st=rtlsNewState(); n.got={}; n.recs=[]; n.log=[];
            n.cmds=0; n.bytes=0; n.sent=0; n.server=0; n.conn=0; n.aq=[]; n.aqN=0; n.inflight=0; n.cid=0; n.listenId=0; n.peer=''; n.dropped=0; n.rn=null; n.rtlEv=-1; n.status='stopped'; n.warn=''; n.srIn=0; n.rate=0; n.rateT=performance.now(); n.rateB=0; },
  dispose:n=>rtlsStop(n),
  process(n,I){
    const rtc=n.p.transport==='WebRTC';
    if(rtc){
      const rn=rtcLinked(I.rtc);
      if(rn!==n.rn){ n.rn=rn; n.rtlEv=-1; if(n.cli) rtlsClient(n,false); }
      if(rn && n.want){
        if(rn.rtlEv!==n.rtlEv){ n.rtlEv=rn.rtlEv; rtlsClient(n,!!rn.rtlOpen); }       // канал открылся / закрылся
        if(rn.rtlQ.length) for(const u of rn.rtlQ.splice(0)) rtlsRx(n,u);
      }else if(!rn && n.want) n.status='wire WebRTC Data → rtc';
    }
    // IQ клиенту: только пока он подключён; переполнение — выбрасываем блок, как делает rtl_tcp при медленном клиенте
    if(n.inflight && performance.now()-n.inflight>3000){ n.inflight=0; rtlsAppPump(n); }      // ответ на tcp.send потерян — не зависаем
    const s=iqIn(I,'iq');
    n.srIn=s ? s.sr : 0;
    if(s && n.cli && n.hello && n.want){
      for(const c of s.chunks){
        const u=rtlsToU8(c);
        if(rtlsSend(n,u)) n.sent+=u.length; else n.dropped++;
      }
    }
    const g=n.got, st=n.st;
    const rec=n.recs.length ? n.recs.splice(0) : null;
    return {freq:g.freq ? st.freq : null, sr:g.sr ? st.sr : null, gain:g.gain ? st.gain : null, ppm:g.ppm ? st.ppm : null,
            agc:g.agc ? st.agc : null, bias:g.bias ? st.bias : null, direct:g.direct ? st.direct : null,
            rec, client:n.cli ? 1 : 0, cmds:n.cmds};
  },
  drawKey:n=>n.status+'|'+n.cmds+'|'+n.dropped+'|'+(n.cli ? 1 : 0)+'|'+(n.sent>>16),
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const now=performance.now();
    if(now-n.rateT>1000){ n.rate=(n.sent-n.rateB)/((now-n.rateT)/1000); n.rateB=n.sent; n.rateT=now; }
    const st=n.st, g=n.got;
    const t=(n.warn && !n.ws ? '⚠ '+n.warn+'\n' : '')+n.status+(n.cli ? ' · '+(n.peer ? n.peer+' · ' : '')+(n.rate/2e6).toFixed(3)+' MS/s sent' : '')+(n.dropped ? ' · dropped '+n.dropped : '')+
      (n.cli && !n.srIn ? '\n⚠ no IQ on the input — wire USB SDR → iq' : '')+
      (n.cmds ? '\nclient wants: '+(g.freq ? (st.freq/1e6).toFixed(6)+' MHz ' : '')+(g.sr ? (st.sr/1e6).toFixed(3)+' MS/s ' : '')+(g.gain ? st.gain+' dB' : '')+
        (n.srIn && g.sr && Math.abs(n.srIn-st.sr)>1 ? '\n⚠ stream is '+(n.srIn/1e6).toFixed(3)+' MS/s, client asked '+(st.sr/1e6).toFixed(3) : '')+
        '\n'+n.log.join('\n') : '');
    if(r.textContent!==t) r.textContent=t; }
});
