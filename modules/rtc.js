"use strict";
/* ============================ RTC Data ============================
   Канал данных WebRTC между двумя браузерами напрямую, без сервера. Обмен «адресами» (сигнализация) — строками на проводах:
   offer ← с одной стороны → `remote` другой, её answer → обратно. Пакуется rtcPack / rtcUnpack (net-kernels.js).
   ICE собирается целиком до выдачи (без trickle), поэтому хватает одной строки в каждую сторону. */

function rtClose(n){
  const pc=n.pc, dc=n.dc; n.pc=n.dc=null; n.role=''; n.ok=false; n.busy=false;
  if(dc){ dc.onopen=dc.onclose=dc.onmessage=null; try{ dc.close(); }catch(e){} }
  if(pc){ pc.onconnectionstatechange=pc.ondatachannel=null; try{ pc.close(); }catch(e){} }
  n.status='closed';
}
function rtChannel(n,dc){
  n.dc=dc; dc.onopen=()=>{ n.ok=true; n.status='connected'; };
  dc.onclose=()=>{ if(n.dc===dc){ n.ok=false; n.status='channel closed'; } };
  dc.onmessage=e=>{
    const text=typeof e.data==='string' ? e.data : '';
    const m=netParse(text,n.p.field,'',Date.now(),{peer:'rtc'});
    n.msgs++; n.q.push(m); n.recQ.push(...m.rec);
    if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
    if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
  };
}
function rtGather(pc){
  return new Promise(res=>{
    if(pc.iceGatheringState==='complete') return res();
    const done=()=>{ pc.removeEventListener('icegatheringstatechange',on); clearTimeout(t); res(); };
    const on=()=>{ if(pc.iceGatheringState==='complete') done(); };
    const t=setTimeout(done,5000);
    pc.addEventListener('icegatheringstatechange',on);
  });
}
function rtNew(n,role){
  rtClose(n);
  const ice=String(n.p.stun||'').split(/[\s,]+/).filter(Boolean).map(u=>({urls:u}));
  const pc=new RTCPeerConnection({iceServers:ice});
  n.pc=pc; n.role=role; n.busy=true; n.local='';
  pc.onconnectionstatechange=()=>{ if(n.pc!==pc) return;
    const s=pc.connectionState;
    if(s==='failed'){ n.ok=false; n.status='connection failed (no route between the peers — try a STUN server, or a TURN)'; }
    else if(s==='disconnected'){ n.ok=false; n.status='disconnected'; } };
  pc.ondatachannel=e=>rtChannel(n,e.channel);
  return pc;
}
async function rtOffer(n){
  try{
    const pc=rtNew(n,'host'); rtChannel(n,pc.createDataChannel('dsp'));
    n.status='gathering addresses…';
    await pc.setLocalDescription(await pc.createOffer()); await rtGather(pc);
    if(n.pc!==pc) return;
    n.local=rtcPack(pc.localDescription); n.localNew=true; n.busy=false;
    n.status='offer ready: give it to the other side, then apply its answer';
  }catch(e){ n.status='error: '+e.message; n.busy=false; }
}
async function rtAnswer(n,d){
  try{
    const pc=rtNew(n,'guest'); n.status='gathering addresses…';
    await pc.setRemoteDescription(d);
    await pc.setLocalDescription(await pc.createAnswer()); await rtGather(pc);
    if(n.pc!==pc) return;
    n.local=rtcPack(pc.localDescription); n.localNew=true; n.busy=false;
    n.status='answer ready: give it back to the side that made the offer';
  }catch(e){ n.status='error: '+e.message; n.busy=false; }
}
// строка от другой стороны: offer → отвечаем, answer → закрываем рукопожатие
async function rtRemote(n,s){
  const d=rtcUnpack(s);
  if(!d){ n.status='not an offer / answer string'; return; }
  if(d.type==='offer') return rtAnswer(n,d);
  if(n.role!=='host' || !n.pc || n.pc.signalingState!=='have-local-offer'){ n.status='an answer, but no offer is waiting for it (press Offer first)'; return; }
  try{ n.status='connecting…'; await n.pc.setRemoteDescription(d); }catch(e){ n.status='error: '+e.message; }
}
def({ id:'rtcData', title:'RTC Data', cat:'Data', kw:'webrtc datachannel p2p peer direct chat remote link signalling',
  ins:[{n:'text',t:'txt'},{n:'value',t:'num'},{n:'remote',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'local',t:'txt'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'stun',t:'text',d:'stun:stun.l.google.com:19302',label:'STUN servers (space / comma; empty — local network only)'},
          {n:'remote',t:'text',d:'',label:'string from the other side (paste; or wire `remote`)'},
          {n:'field',t:'text',d:'',label:'JSON field for the value output (a.b.0.c)'},
          {n:'offer',t:'button',label:'Offer',fn:n=>rtOffer(n)},
          {n:'apply',t:'button',label:'Apply remote',fn:n=>rtRemote(n,n.p.remote)},
          {n:'copy',t:'button',label:'Copy mine',fn:n=>{ if(n.local) navigator.clipboard?.writeText(n.local).then(()=>{ n.status='copied'; },()=>{ n.status='clipboard blocked: select the text in the node'; }); }},
          {n:'close',t:'button',label:'Close',fn:n=>rtClose(n)}],
  init:n=>{ n.pc=n.dc=null; n.role=''; n.ok=false; n.busy=false; n.local=''; n.localNew=false; n.q=[]; n.recQ=[]; n.msgs=0; n.sent=0;
            n.lastText=undefined; n.lastVal=undefined; n.lastRemote=undefined; n.last={text:'',val:0}; n.status='idle: press Offer, or paste an offer into remote'; },
  dispose:n=>rtClose(n),
  process(n,I){
    if(typeof I.remote==='string' && I.remote!==n.lastRemote){ n.lastRemote=I.remote; if(I.remote.trim()) rtRemote(n,I.remote); }
    const open=n.dc && n.dc.readyState==='open';
    if(typeof I.text==='string' && I.text!==n.lastText){ if(!I.text || (open && (n.dc.send(I.text),n.sent++,true))) n.lastText=I.text; }
    if(typeof I.value==='number' && isFinite(I.value) && I.value!==n.lastVal){ if(open){ n.dc.send(String(I.value)); n.sent++; n.lastVal=I.value; } }
    const m=n.q.length ? n.q.shift() : null;
    if(m) n.last={text:m.text,val:m.val!==null ? m.val : n.last.val};
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    const local=n.localNew ? n.local : null; n.localNew=false;
    return {text:m ? m.text : null, value:n.last.val, rec, new:m ? 1 : 0, local, ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.role ? ' · '+(n.role==='host' ? 'offer side' : 'answer side') : '')+' · in '+n.msgs+' · out '+n.sent+
      (n.local && !n.ok ? '\n'+n.local.slice(0,120)+'… ('+n.local.length+' characters)' : '')+
      (n.last.text ? '\n'+n.last.text.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
