"use strict";
/* ============================ OSC ============================
   Open Sound Control (TouchOSC, Max, Pd, SuperCollider, Ableton, Behringer X32 и др.). Браузер не шлёт UDP — между страницей и
   программой мост WebSocket↔UDP: websocat --binary ws-l:127.0.0.1:8080 udp-l:127.0.0.1:9000. Ядро — osc-kernels.js. */

function ocStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null; n.ok=false;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function ocStart(n){
  ocStop(n);
  const url=String(n.p.url||'').trim();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; ocOpen(n,url);
}
function ocOpen(n,url){
  let ws; try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  ws.binaryType='arraybuffer'; n.ws=ws; n.status='connecting…';
  ws.onopen=()=>{ n.ok=true; n.status='connected'; };
  ws.onerror=()=>{ n.status='connection error (is the websocat bridge running?)'; };
  ws.onclose=()=>{
    if(n.ws!==ws) return;
    n.ws=null; n.ok=false; n.status='closed'+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) ocOpen(n,url); },3000); }
  };
  ws.onmessage=e=>{
    let msgs;
    try{ msgs=oscDecode(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : OSC_TE.encode(String(e.data))); }catch(err){ n.bad++; return; }
    for(const m of msgs) ocIn(n,m);
  };
}
function ocIn(n,m){
  if(!oscMatch(n.p.filter,m.addr)) return;
  const num=m.args.find(a=>typeof a.v==='number' && isFinite(a.v));
  const text=oscToText(m);
  n.msgs++; n.q.push({text,addr:m.addr,val:num ? num.v : null});
  const rec={t:Date.now(),addr:m.addr,args:m.args.length};
  m.args.forEach((a,i)=>{ rec['a'+i]=a.t==='b' ? '<'+a.v.length+' bytes>' : a.v; });
  n.recQ.push(rec);
  if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
function ocSend(n,addr,args){
  if(!n.ws || n.ws.readyState!==1) return false;
  try{ n.ws.send(oscEncode(addr,args)); n.sent++; return true; }catch(e){ n.status='not sent: '+e.message; return false; }
}
def({ id:'oscIo', title:'OSC', cat:'Data', kw:'osc open sound control touchosc max pd supercollider udp mixer x32 lighting controller faders',
  ins:[{n:'value',t:'num'},{n:'text',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'addr',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'ws://127.0.0.1:8080',label:'bridge to UDP: ws:// wss://'},
          {n:'filter',t:'text',d:'',label:'receive only addresses (prefix like /mix, or a pattern /fader{1,2}/*; empty — all)'},
          {n:'send',t:'text',d:'/dsp/value',label:'address for the value input'},
          {n:'type',t:'select',opts:['float','int'],d:'float',label:'value is sent as'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>ocStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>ocStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.ok=false; n.timer=null; n.q=[]; n.recQ=[]; n.msgs=0; n.sent=0; n.bad=0;
            n.lastText=undefined; n.lastVal=undefined; n.last={text:'',addr:'',val:0}; n.status='not connected'; n.warn=''; },
  dispose:n=>ocStop(n),
  process(n,I){
    if(typeof I.value==='number' && isFinite(I.value) && I.value!==n.lastVal && n.ok){
      const addr=String(n.p.send||'').trim();
      if(addr && ocSend(n,addr,[{t:n.p.type==='int' ? 'i' : 'f',v:I.value}])) n.lastVal=I.value;
    }
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      if(I.text.trim() && n.ok){
        const m=oscFromText(I.text);
        if(!m) n.status='not an OSC line (/address arg arg …)'; else ocSend(n,m.addr,m.args);
      }
    }
    const m=n.q.length ? n.q.shift() : null;
    if(m) n.last={text:m.text,addr:m.addr,val:m.val!==null ? m.val : n.last.val};
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:m ? m.text : null,addr:m ? m.addr : null,value:n.last.val,rec,new:m ? 1 : 0,ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · in '+n.msgs+(n.bad ? ' (bad '+n.bad+')' : '')+' · out '+n.sent+(n.q.length ? ' · queued '+n.q.length : '')+(n.last.text ? '\n'+n.last.text.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
