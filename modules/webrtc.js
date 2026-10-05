"use strict";
/* ============================ WebRTC Data ============================
   Прямой канал между двумя браузерами (RTCDataChannel) без сервера: код соединения (offer / answer) передаётся вручную —
   через мессенджер или буфер обмена. Один узел делает Offer, второй принимает его (Accept offer) и отдаёт Answer,
   первый применяет Answer. Дальше текст идёт как у Text over Network (строки в line, JSON — в rec). В одной сети STUN не
   нужен; через интернет — укажите STUN-сервер. Разбор сообщений — netTextFeed (sources.js). */

function rtcClose(n){
  n.gen=(n.gen|0)+1;
  const dc=n.dc, pc=n.pc; n.dc=n.pc=null; n.open=false;
  if(dc){ dc.onopen=dc.onclose=dc.onmessage=null; try{ dc.close(); }catch(e){} }
  if(pc){ pc.onconnectionstatechange=pc.ondatachannel=null; try{ pc.close(); }catch(e){} }
  n.status='closed';
}
const rtcEnc=d=>btoa(unescape(encodeURIComponent(JSON.stringify({type:d.type,sdp:d.sdp}))));
const rtcDec=s=>JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/\s+/g,'')))));
function rtcMake(n){
  rtcClose(n);
  if(typeof RTCPeerConnection==='undefined'){ n.status='WebRTC is not supported by this browser'; return null; }
  const ice=String(n.p.ice||'').split(/[\s,]+/).filter(Boolean).map(urls=>({urls}));
  const pc=new RTCPeerConnection({iceServers:ice}), gen=n.gen;
  n.pc=pc;
  pc.onconnectionstatechange=()=>{ if(n.gen===gen && !n.open) n.status='connection: '+pc.connectionState; };
  return pc;
}
function rtcAttach(n,dc){
  const gen=n.gen; n.dc=dc;
  dc.onopen=()=>{ if(n.gen===gen){ n.open=true; n.status='connected'; n.code=''; } };
  dc.onclose=()=>{ if(n.gen===gen){ n.open=false; n.status='channel closed'; } };
  dc.onmessage=e=>{ if(typeof e.data==='string') netTextFeed(n,e.data); };
}
async function rtcGather(n,pc){                       // без trickle: код целиком после сбора кандидатов
  if(pc.iceGatheringState!=='complete') await new Promise(res=>{
    const t=setTimeout(res,5000);
    pc.onicegatheringstatechange=()=>{ if(pc.iceGatheringState==='complete'){ clearTimeout(t); res(); } };
  });
  return rtcEnc(pc.localDescription);
}
async function rtcShow(n,kind,code){
  n.code=code; let copied=false;
  try{ await navigator.clipboard.writeText(code); copied=true; }catch(e){}
  n.status=kind+' ready'+(copied ? ' — copied to the clipboard' : ' — copy it from below')+
    (kind==='offer' ? ', send it to the other side and paste its answer into «remote code»' : ', send it back');
}
async function rtcOffer(n){
  const pc=rtcMake(n); if(!pc) return;
  const gen=n.gen; n.status='creating offer…';
  try{
    rtcAttach(n,pc.createDataChannel('dsp'));
    await pc.setLocalDescription(await pc.createOffer());
    const code=await rtcGather(n,pc); if(n.gen===gen) await rtcShow(n,'offer',code);
  }catch(e){ if(n.gen===gen) n.status='error: '+e.message; }
}
async function rtcAnswer(n){
  let d; try{ d=rtcDec(n.p.remote); }catch(e){ n.status='remote code is not valid'; return; }
  if(d.type!=='offer'){ n.status='remote code is not an offer'; return; }
  const pc=rtcMake(n); if(!pc) return;
  const gen=n.gen; n.status='creating answer…';
  pc.ondatachannel=e=>rtcAttach(n,e.channel);
  try{
    await pc.setRemoteDescription(d);
    await pc.setLocalDescription(await pc.createAnswer());
    const code=await rtcGather(n,pc); if(n.gen===gen) await rtcShow(n,'answer',code);
  }catch(e){ if(n.gen===gen) n.status='error: '+e.message; }
}
async function rtcApply(n){
  if(!n.pc){ n.status='create an offer first'; return; }
  let d; try{ d=rtcDec(n.p.remote); }catch(e){ n.status='remote code is not valid'; return; }
  if(d.type!=='answer'){ n.status='remote code is not an answer'; return; }
  try{ await n.pc.setRemoteDescription(d); n.status='connecting…'; }catch(e){ n.status='error: '+e.message; }
}
def({ id:'rtcdata', title:'WebRTC Data', cat:'Sources', kw:'webrtc peer data channel p2p datachannel browser direct',
  ins:[{n:'send',t:'txt'}],
  outs:[{n:'line',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'ice',t:'text',d:'',label:'STUN (stun:stun.l.google.com:19302), empty — same network only'},
    {n:'offer',t:'button',label:'1. Create offer',fn:n=>rtcOffer(n)},
    {n:'remote',t:'text',d:'',label:'remote code (paste the other side\'s offer / answer)'},
    {n:'accept',t:'button',label:'2. Accept offer → answer',fn:n=>rtcAnswer(n)},
    {n:'apply',t:'button',label:'3. Apply answer',fn:n=>rtcApply(n)},
    {n:'close',t:'button',label:'Close',fn:n=>rtcClose(n)},
  ],
  init:n=>{ n.pc=n.dc=null; n.open=false; n.gen=0; n.code=''; n.lineQ=[]; n.recQ=[]; n.lastLine=''; n.msgs=0; n.count=0;
            n.lastSend=undefined; n.status=typeof RTCPeerConnection==='undefined' ? 'WebRTC is not supported by this browser' : 'not connected'; },
  dispose:n=>rtcClose(n),
  process(n,I){
    if(typeof I.send==='string' && I.send!==n.lastSend){
      n.lastSend=I.send;
      if(n.dc && n.dc.readyState==='open') n.dc.send(I.send);
    }
    let go=0;
    if(n.lineQ.length){ n.lastLine=n.lineQ.shift(); go=1; n.count++; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {line:n.lastLine, go, rec, count:n.count}; },
  drawKey:n=>n.status+'|'+n.msgs+'|'+n.lineQ.length,
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=n.status+(n.msgs ? ' · messages '+n.msgs : '')+(n.code ? '\n'+n.code : '')+(n.lastLine ? '\n'+n.lastLine.slice(0,400) : ''); }
});
