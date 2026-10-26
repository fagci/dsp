"use strict";
/* ======================= Транспорт для Rig Control и Rotator ======================= */
// n.cp = {kind, write(строка), close()}; входящий текст — в o.onText, обрыв — в o.onClose.
// websocket — мост к TCP-демону (websockify 8768 127.0.0.1:4532), serial — Web Serial, simulator — виртуальное устройство (sim.respond).

const CP_ENC=new TextEncoder();

function cpClose(n){
  const c=n.cp; n.cp=null; n.connected=false;
  if(c) try{ c.close(); }catch(e){ console.error('ctlport close:',e); }
}
// https-страница не откроет ws:// на другой машине — скажем прямо
function cpUrlBlock(url){
  return location.protocol==='https:' && /^ws:\/\//i.test(url) && !/^ws:\/\/(localhost|127\.|\[::1\])/i.test(url)
    ? 'blocked: an https page can only open wss:// (or ws://localhost) — run the bridge on this machine or use a wss:// proxy' : '';
}
async function cpOpen(n,o){
  cpClose(n);
  if(o.via==='simulator'){
    const sim=o.sim;
    n.cp={kind:'sim',write:s=>{ const r=sim.respond(s); queueMicrotask(()=>{ if(n.cp) o.onText(r); }); },close(){}};
    n.connected=true; n.status='simulator'; return;
  }
  if(o.via==='websocket'){
    const bad=cpUrlBlock(o.url); if(bad){ n.status=bad; return; }
    n.status='connecting…';
    await new Promise(res=>{
      let ws, done=false;
      const fin=ok=>{ if(!done){ done=true; res(ok); } };
      try{ ws=new WebSocket(o.url); }catch(e){ n.status='error: '+e.message; fin(false); return; }
      ws.binaryType='arraybuffer';
      const dec=new TextDecoder();
      const me={kind:'ws',write:s=>{ if(ws.readyState===1) ws.send(CP_ENC.encode(s)); },close:()=>{ ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }};
      ws.onopen=()=>{ n.cp=me; n.connected=true; n.status='connected'; fin(true); };
      ws.onerror=()=>{ if(!n.connected) n.status='connection failed — is the bridge running?'; fin(false); };
      ws.onclose=()=>{ const was=n.cp===me; if(was){ n.cp=null; n.connected=false; n.status='closed'; o.onClose&&o.onClose(); } fin(false); };
      ws.onmessage=e=>{ o.onText(typeof e.data==='string' ? e.data : dec.decode(e.data,{stream:true})); };
    });
    return;
  }
  if(o.via==='serial'){
    if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
    n.status='choose a port…';
    try{
      const port=await navigator.serial.requestPort();
      await port.open({baudRate:+o.baud||9600});
      const writer=port.writable.getWriter(), reader=port.readable.getReader(), dec=new TextDecoder();
      let open=true;
      const me={kind:'serial',
        write:s=>{ writer.write(CP_ENC.encode(s)).catch(e=>{ n.status='write error: '+e.message; }); },
        close:async()=>{ open=false; try{ await reader.cancel(); }catch(e){} try{ reader.releaseLock(); }catch(e){} try{ writer.releaseLock(); }catch(e){} try{ await port.close(); }catch(e){} }};
      n.cp=me; n.connected=true; n.status='connected, '+(+o.baud||9600)+' baud';
      (async()=>{
        try{ for(;;){ const {value,done}=await reader.read(); if(done) break; if(value) o.onText(dec.decode(value,{stream:true})); } }catch(e){ if(open) n.status='read error: '+e.message; }
        if(open && n.cp===me){ n.cp=null; n.connected=false; n.status='port closed by device'; o.onClose&&o.onClose(); }
      })();
    }catch(e){ n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; }
  }
}
