"use strict";
/* ============================ Phone Control & Automation (DSP app) ============================
   Streaming speech recognition (Android's own, works offline with a downloaded language pack), system events for automation
   (screen on/off, charging, headset, Bluetooth / Wi-Fi state, calls, network up/down, notifications, foreground app — needs
   Notification access / Accessibility, asked once from the app Settings), and actions: volume, text-to-speech, clipboard,
   media keys, toast, launch an app, send an intent, and UI automation (tap, swipe, Back/Home/Recents, click a button by its
   text, type into the focused field, read the visible text) via the app's Accessibility service. Needs a trusted client
   (the app's own page, or «Let any page use actions» in Settings) — same gate as Phone Actions. Commands — tools/android/README.md
   (speech.*, vol.*, tts.*, clip.*, media, app.*, intent, ui.*, sys.*). Building — modules/phonelink-kernels.js (tools/test-phonelink.mjs). */

function pcStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function pcStart(n){
  pcStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status='URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected'; pcSub(n); for(const c of n.pend.splice(0)) pcSend(n,c); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) pcStart(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) pcFeed(n,r);
  };
}
function pcSub(n){
  const subs=['speech']; if(n.p.sysEvents) subs.push('sys');
  const m=JSON.stringify({sub:subs});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function pcSend(n,cmd){
  if(!cmd || cmd.error) return;
  if(!n.ws || n.ws.readyState!==1){ n.pend.push(cmd); if(n.pend.length>20) n.pend.shift(); if(!n.ws) pcStart(n); return; }
  n.ws.send(JSON.stringify({...cmd,id:++n.seq}));
}
function pcFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.count++;
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  if(r.src==='speech'){
    if(r.level){ n.last='speech: '+r.level+': '+r.msg; return; }
    if(r.final){ n.text=r.text; n.textQ.push({t:Date.now(),src:'speech',...r}); if(n.textQ.length>500) n.textQ.shift(); n.fresh=1; }
    else n.interim=r.text;
    return;
  }
  const line=plLine(r); if(line) n.last=line;
  if(r.src==='cmd'){
    n.ok=r.ok?1:0;
    if(!r.ok && r.msg) n.last=(r.cmd||'')+': '+r.msg;
    if(r.cmd==='clip.get' && typeof r.text==='string') n.clip=r.text;
    if(r.cmd==='app.list') n.last='apps: '+r.n;
    if(r.cmd==='sys.shell.exec' && typeof r.out==='string'){ n.text=r.out; n.last='shell: exit '+r.code; n.fresh=1; }
    if(r.cmd==='sys.bcast.listen' && r.ok) n.last='listening: '+r.n+' action(s)';
  }
  if(r.src==='app' || r.src==='uitext') n.sysQ.push({t:Date.now(),...r});
  if(r.src==='sys') n.sysQ.push({t:Date.now(),...r});
  if(n.sysQ.length>2000) n.sysQ.splice(0,n.sysQ.length-2000);
}
def({ id:'phonectl', title:'Phone Control & Automation (DSP app)', cat:'Sources', kw:'speech recognition voice dictation stt automation accessibility tap swipe click text to speech tts volume clipboard notification intent launch app sys events screen bluetooth network headset call',
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'x2',t:'num'},{n:'y2',t:'num'},{n:'pkg',t:'txt'},{n:'cmd',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'sys',t:'rec'},{n:'text',t:'txt'},{n:'interim',t:'txt'},{n:'ok',t:'num'},{n:'new',t:'num'}],
  readout:true, tall:true,
  groups:[{n:'Speech'},{n:'Volume / TTS',open:false},{n:'App / intent',open:false},{n:'UI automation',open:false},{n:'Broadcasts / shell',open:false}],
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'bridge of the DSP app'},
    {n:'action',t:'select',opts:PL_SYS_ACTIONS,d:'speech start',label:'action (the Run button, or a rising edge on go)'},
    {n:'sysEvents',t:'check',d:false,label:'system events → output «sys» (screen, charging, Bluetooth, network, calls…)'},
    {n:'lang',t:'text',d:'',label:'speech / TTS language, e.g. ru-RU (empty — system default)',g:'Speech'},
    {n:'partial',t:'check',d:true,label:'speech: interim results → output «interim»',g:'Speech'},
    {n:'offline',t:'check',d:false,label:'speech: prefer the on-device model (needs a downloaded language, Android 13+)',g:'Speech'},
    {n:'stream',t:'select',opts:['music','ring','alarm','notification','call','system'],d:'music',label:'volume stream',g:'Volume / TTS'},
    {n:'volPct',t:'range',min:0,max:100,step:1,d:'',label:'set volume, % (empty — use the level below)',g:'Volume / TTS'},
    {n:'volLevel',t:'num',d:0,label:'set volume, level (phone-specific steps)',g:'Volume / TTS'},
    {n:'volUi',t:'check',d:false,label:'show the system volume UI',g:'Volume / TTS'},
    {n:'ringer',t:'select',opts:['normal','vibrate','silent'],d:'normal',label:'ringer mode',g:'Volume / TTS'},
    {n:'text',t:'text',d:'',label:'text to speak / type / toast (the «text» input overrides it)',g:'Volume / TTS'},
    {n:'rate',t:'range',min:.1,max:3,step:.1,d:1,label:'TTS: speech rate',g:'Volume / TTS'},
    {n:'pitch',t:'range',min:.1,max:3,step:.1,d:1,label:'TTS: pitch',g:'Volume / TTS'},
    {n:'queue',t:'check',d:false,label:'TTS: queue after the current phrase instead of interrupting it',g:'Volume / TTS'},
    {n:'q',t:'text',d:'',label:'app list: filter by name',g:'App / intent'},
    {n:'pkg',t:'text',d:'',label:'package name (the «pkg» input overrides it; from «app list»\'s records)',g:'App / intent'},
    {n:'intentAction',t:'text',d:'',label:'intent: action (android.intent.action.VIEW…)',g:'App / intent'},
    {n:'intentData',t:'text',d:'',label:'intent: data URI',g:'App / intent'},
    {n:'root',t:'check',d:false,label:'use root for launch / intent (works from the background; needs «Allow root features» in Settings)',g:'App / intent'},
    {n:'bcastActions',t:'text',d:'',label:'listen for system broadcasts: actions, comma separated (e.g. android.intent.action.AIRPLANE_MODE_CHANGED) → output «sys»',g:'Broadcasts / shell'},
    {n:'shellCmd',t:'code',plain:true,d:'',label:'shell command (the «text» input overrides it) → output «text»',g:'Broadcasts / shell'},
    {n:'shellRoot',t:'check',d:false,label:'as root (needs «Allow root features» in the app Settings)',g:'Broadcasts / shell'},
    {n:'shellTimeout',t:'range',min:500,max:60000,step:500,d:15000,label:'timeout, ms',g:'Broadcasts / shell'},
    {n:'x',t:'num',d:500,label:'x, px (the «x» input overrides it)',g:'UI automation'},
    {n:'y',t:'num',d:1000,label:'y, px (the «y» input overrides it)',g:'UI automation'},
    {n:'x2',t:'num',d:500,label:'swipe: x2, px',g:'UI automation'},
    {n:'y2',t:'num',d:500,label:'swipe: y2, px',g:'UI automation'},
    {n:'swipeMs',t:'range',min:10,max:2000,step:10,d:300,label:'swipe: duration, ms',g:'UI automation'},
    {n:'run',t:'button',label:'Run',fn:n=>{ const c=plSysCmd(n.p,{text:n.textIn,x:n.xIn,y:n.yIn,x2:n.x2In,y2:n.y2In,pkg:n.pkgIn}); if(c.error) n.last=c.error; else pcSend(n,c); }},
    {n:'connect',t:'button',label:'Connect',fn:n=>pcStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>pcStop(n)},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.pend=[]; n.seq=0; n.lastCmd=null; n.count=0; n.ok=0; n.text=''; n.interim=''; n.fresh=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.last=''; n.prevGo=0; n.clip=''; n.textQ=[]; n.sysQ=[];
            n.textIn=''; n.xIn=0; n.yIn=0; n.x2In=0; n.y2In=0; n.pkgIn=''; },
  dispose:n=>pcStop(n),
  process(n,I){
    pcSub(n);
    n.textIn=typeof I.text==='string' ? I.text : ''; n.pkgIn=typeof I.pkg==='string' ? I.pkg : '';
    n.xIn=typeof I.x==='number' ? I.x : undefined; n.yIn=typeof I.y==='number' ? I.y : undefined;
    n.x2In=typeof I.x2==='number' ? I.x2 : undefined; n.y2In=typeof I.y2==='number' ? I.y2 : undefined;
    const go=(I.go||0)>.5;
    if(go && !n.prevGo){ const c=plSysCmd(n.p,{text:n.textIn,x:n.xIn,y:n.yIn,x2:n.x2In,y2:n.y2In,pkg:n.pkgIn}); if(c.error) n.last=c.error; else pcSend(n,c); }
    n.prevGo=go;
    if(Array.isArray(I.cmd) && I.cmd!==n.lastCmd){                   // записи с полем cmd уходят как есть (собрать их можно Rec Filter / Fields → Rec)
      n.lastCmd=I.cmd;
      for(const r of I.cmd) if(r && typeof r.cmd==='string') pcSend(n,r);
    }
    const rec=n.textQ.length ? n.textQ.splice(0) : null, sys=n.sysQ.length ? n.sysQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    return {rec, sys, text:n.text||null, interim:n.interim||null, ok:n.ok, new:fresh};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · records '+n.count;
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(n.last) t+='\n'+n.last;
    if(n.interim) t+='\n… '+n.interim.slice(0,200);
    if(n.text) t+='\n'+n.text.slice(0,300);
    if(r.textContent!==t) r.textContent=t; }
});
