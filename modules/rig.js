"use strict";
/* ============================ Rig Control (rigctl) ============================
   Управление трансивером через Hamlib rigctld. Браузер не открывает TCP — между ним и rigctld нужен мост WebSocket↔TCP:
   websocat --text ws-l:127.0.0.1:4533 tcp:127.0.0.1:4532. Ядро — rig-kernels.js. Команды идут по одной, пока нет RPRT. */

const RIG_TIMEOUT=2500;
function rgStop(n){
  if(n.ptt_on && n.ws && n.ws.readyState===1){ try{ n.ws.send(rigSetPtt(false)); }catch(e){} }   // не оставлять радио на передаче
  n.ptt_on=false; n.want=false; clearTimeout(n.timer); clearInterval(n.pollT); n.timer=n.pollT=null; clearTimeout(n.waitT);
  const ws=n.ws; n.ws=null; n.ok=false; n.cmdq=[]; n.wait=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function rgStart(n){
  rgStop(n);
  const url=String(n.p.url||'').trim();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; rgOpen(n,url);
}
function rgOpen(n,url){
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; rgRetry(n,url); return; }
  n.ws=ws; n.status='connecting…'; n.parser=new RigParser(); n.cmdq=[]; n.wait=null;
  ws.onopen=()=>{ n.ok=true; n.status='connected'; rgPoll(n); clearInterval(n.pollT); n.pollT=setInterval(()=>rgPoll(n),Math.max(.2,n.p.period)*1000); };
  ws.onerror=()=>{ n.status='connection error (is the websocat bridge to rigctld running?)'; };
  ws.onclose=()=>{
    if(n.ws!==ws) return;
    n.ws=null; n.ok=false; clearInterval(n.pollT); clearTimeout(n.waitT); n.wait=null; n.cmdq=[];
    n.status='closed'+(n.p.reconnect ? ' — reconnecting…' : ''); rgRetry(n,url);
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    for(const r of n.parser.push(e.data)) rgReply(n,r);
  };
}
function rgRetry(n,url){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) rgOpen(n,url); },3000); } }
// очередь: команда уходит, когда предыдущая получила RPRT (или истёк срок)
function rgSend(n,cmd,front){
  if(!n.ws || n.ws.readyState!==1) return false;
  if(n.cmdq.length>20) return false;                      // радио молчит — не копим
  front ? n.cmdq.unshift(cmd) : n.cmdq.push(cmd); rgPump(n); return true;
}
function rgPump(n){
  if(n.wait || !n.cmdq.length || !n.ws || n.ws.readyState!==1) return;
  const c=n.cmdq.shift(); n.wait=c;
  n.ws.send(c);
  n.waitT=setTimeout(()=>{ n.wait=null; n.status='no answer from rigctld'; rgPump(n); },RIG_TIMEOUT);
}
function rgPoll(n){
  if(n.cmdq.length>3) return;
  rgSend(n,rigGetFreq()); rgSend(n,rigGetMode());
  const lv=String(n.p.level||'').trim(); if(lv) rgSend(n,rigGetLevel(lv));
  if(n.p.ptt) rgSend(n,rigGetPtt());
}
function rgReply(n,r){
  clearTimeout(n.waitT); const w=n.wait; n.wait=null;
  if(r.rprt<0 && r.name) n.status='rig: '+r.name+' failed (RPRT '+r.rprt+')'; else if(n.ok) n.status='connected';
  const o=rigReply(r);
  if(o.freq!==undefined) n.rig.freq=o.freq;
  if(o.mode!==undefined){ n.rig.mode=o.mode; if(o.pb!==undefined) n.rig.pb=o.pb; }
  if(o.level!==undefined) n.rig.level=o.level;
  if(o.ptt!==undefined) n.rig.ptt=o.ptt;
  if(r.name==='get_freq' || r.name==='get_mode') n.pulse=1;
  rgPump(n);
}
def({ id:'rigCtl', title:'Rig Control (rigctl)', cat:'Control', kw:'hamlib rigctld cat transceiver radio rig frequency mode ptt tune ic-7300 ft-991 kenwood yaesu icom',
  ins:[{n:'freq',t:'num'},{n:'mode',t:'txt'},{n:'ptt',t:'num'}],
  outs:[{n:'freq',t:'num'},{n:'mode',t:'txt'},{n:'level',t:'num'},{n:'ptt',t:'num'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'ws://127.0.0.1:4533',label:'bridge to rigctld: ws:// wss://'},
          {n:'period',t:'range',min:.2,max:30,step:.1,d:1,label:'poll period, s'},
          {n:'level',t:'text',d:'STRENGTH',label:'level to read (STRENGTH, SWR, ALC, RFPOWER_METER…; empty — none)'},
          {n:'passband',t:'range',min:0,max:12000,step:50,d:0,label:'passband for mode set, Hz (0 — the rig default)'},
          {n:'ptt',t:'check',d:false,label:'allow PTT (the radio TRANSMITS on the ptt wire)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>rgStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>rgStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.ok=false; n.timer=n.pollT=n.waitT=null; n.cmdq=[]; n.wait=null; n.pulse=0; n.sent=0; n.ptt_on=false;
            n.rig={freq:0,mode:'',pb:0,level:0,ptt:0}; n.lastF=undefined; n.lastM=undefined; n.lastP=undefined; n.status='not connected'; n.warn=''; },
  dispose:n=>rgStop(n),
  process(n,I){
    if(n.ok){
      if(typeof I.freq==='number' && I.freq>0 && isFinite(I.freq) && I.freq!==n.lastF){ if(rgSend(n,rigSetFreq(I.freq),true)){ n.lastF=I.freq; n.rig.freq=I.freq; n.sent++; } }
      if(typeof I.mode==='string' && I.mode.trim() && I.mode!==n.lastM){
        const m=I.mode.trim().toUpperCase();
        if(RIG_MODES.includes(m)){ if(rgSend(n,rigSetMode(m,n.p.passband),true)){ n.lastM=I.mode; n.rig.mode=m; n.sent++; } }
        else{ n.lastM=I.mode; n.status='unknown mode «'+I.mode+'»'; }
      }
      if(n.p.ptt && typeof I.ptt==='number' && I.ptt!==n.lastP){
        const on=I.ptt>.5; if(rgSend(n,rigSetPtt(on),true)){ n.lastP=I.ptt; n.ptt_on=on; n.rig.ptt=on ? 1 : 0; n.sent++; }
      } else if(!n.p.ptt && n.ptt_on){ n.ptt_on=false; rgSend(n,rigSetPtt(false),true); }   // флажок сняли на передаче — отбой
    }
    const pulse=n.pulse; n.pulse=0;
    return {freq:n.rig.freq,mode:n.rig.mode,level:n.rig.level,ptt:n.rig.ptt,new:pulse,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const f=n.rig.freq ? (n.rig.freq/1e6).toFixed(6)+' MHz' : '—';
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+'\n'+f+' · '+(n.rig.mode||'—')+(n.rig.pb ? ' '+n.rig.pb+' Hz' : '')+
      (String(n.p.level||'').trim() ? ' · '+n.p.level+' '+n.rig.level : '')+(n.rig.ptt ? ' · TX' : '')+' · set '+n.sent;
    if(r.textContent!==t) r.textContent=t; }
});
