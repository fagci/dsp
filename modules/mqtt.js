"use strict";
/* ============================ MQTT: узлы ============================
   MQTT In / MQTT Out поверх WebSocket (mqtt:// браузеру недоступен — у брокера нужен порт WebSocket: Mosquitto
   `listener 9001` + `protocol websockets`, EMQX, HiveMQ, Home Assistant add-on). Ядро пакетов — mqtt-kernels.js.
   Каждый узел держит своё соединение; со страницы по https пускает только wss://. */

const MQ_PING_MS=20000;
function mqStop(n){
  n.want=false; clearTimeout(n.timer); clearInterval(n.pingT); n.timer=n.pingT=null;
  const ws=n.ws; n.ws=null; n.ok=false;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.send(mqDisconnect()); }catch(e){} try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function mqSend(n,bytes){ if(n.ws && n.ws.readyState===1) n.ws.send(bytes); }
function mqNextId(n){ n.pid=(n.pid%65535)+1; return n.pid; }
function mqStart(n){
  mqStop(n);
  const url=String(n.p.url||'').trim();
  if(!/^wss?:\/\//i.test(url)){ n.status='URL must start with ws:// or wss://'; return; }
  n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  n.want=true; n.refused=false; mqOpen(n,url);
}
function mqOpen(n,url){
  let ws;
  try{ ws=new WebSocket(url,'mqtt'); }
  catch(e){ n.status='error: '+e.message; mqRetry(n,url); return; }
  ws.binaryType='arraybuffer'; n.ws=ws; n.status='connecting…'; n.parser=new MqParser();
  if(!n.cid) n.cid=String(n.p.client||'').trim() || 'dsp-'+Math.random().toString(16).slice(2,10);
  ws.onopen=()=>ws.send(mqConnect({clientId:n.p.client ? String(n.p.client).trim() : n.cid,user:n.p.user,pass:n.p.pass,keepalive:Math.round(MQ_PING_MS*1.5/1000)}));
  ws.onerror=()=>{ n.status='connection error'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.ok=false; clearInterval(n.pingT);
    if(!n.refused) n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    mqRetry(n,url);
  };
  ws.onmessage=e=>{
    let pk;
    try{ pk=n.parser.push(e.data); }catch(err){ n.status='protocol error: '+err.message; try{ ws.close(); }catch(x){} return; }
    for(const p of pk) mqPacketIn(n,p);
  };
}
function mqRetry(n,url){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) mqOpen(n,url); },3000); } }
function mqPacketIn(n,p){
  if(p.type===MQ.CONNACK){
    if(p.code!==0){ n.status='refused: '+(MQ_CONNACK_TEXT[p.code]||p.code); n.want=false; n.refused=true; return; }   // повтор не поможет — логин / права
    n.ok=true; n.status='connected';
    clearInterval(n.pingT); n.pingT=setInterval(()=>mqSend(n,mqPing()),MQ_PING_MS);
    if(n.onConnect) n.onConnect(n);
  } else if(p.type===MQ.PUBLISH){
    if(p.qos===1) mqSend(n,mqPuback(p.id));
    if(n.onMessage) n.onMessage(n,p);
  } else if(p.type===MQ.SUBACK){
    if(p.codes.some(c=>c===0x80)) n.status='connected, subscription refused by the broker';
  }
}
const mqTopics=s=>String(s||'').split(/[\s,]+/).filter(Boolean);

/* ---------- MQTT In ---------- */
function mqInMessage(n,p){
  const text=mqDec.decode(p.payload), t=Date.now();
  let val=null, rec=null;
  const num=Number(text.trim());
  if(text.trim()!=='' && Number.isFinite(num)) val=num;
  if(text[0]==='{' || text[0]==='['){
    try{
      const j=JSON.parse(text);
      const objs=Array.isArray(j) ? j : [j];
      rec=objs.map(o=>({t,topic:p.topic,...(o && typeof o==='object' && !Array.isArray(o) ? o : {value:o})}));
      const f=String(n.p.field||'').trim();
      if(f){ let v=objs[0]; for(const k of f.split('.')) v=v==null ? v : v[k]; if(typeof v==='number' && Number.isFinite(v)) val=v; else if(typeof v==='string' && v.trim()!=='' && Number.isFinite(+v)) val=+v; }
    }catch(e){}
  }
  if(!rec) rec=[{t,topic:p.topic,...(val!==null ? {value:val} : {text})}];
  n.msgs++;
  n.q.push({text,topic:p.topic,val});
  n.recQ.push(...rec);
  if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
def({ id:'mqttIn', title:'MQTT In', cat:'Sources', kw:'mqtt subscribe broker iot tasmota esphome home assistant sensor',
  outs:[{n:'text',t:'txt'},{n:'topic',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true, tall:true,
  params:[{n:'url',t:'text',d:'ws://127.0.0.1:9001',label:'broker WebSocket: ws:// wss://'},
          {n:'topic',t:'text',d:'#',label:'topic filters (space or comma separated; + and # allowed)'},
          {n:'user',t:'text',d:'',label:'user (optional)'},
          {n:'pass',t:'text',d:'',label:'password (saved with the patch!)'},
          {n:'field',t:'text',d:'',label:'JSON field for the value output (a.b.c; empty — the payload itself)'},
          {n:'client',t:'text',d:'',label:'client id (empty — random)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>mqStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>mqStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.ok=false; n.timer=n.pingT=null; n.pid=0; n.cid=''; n.q=[]; n.recQ=[]; n.msgs=0;
            n.last={text:'',topic:'',val:0}; n.status='not connected'; n.warn='';
            n.onConnect=n=>{ const f=mqTopics(n.p.topic); mqSend(n,mqSubscribe(mqNextId(n),f.length ? f : ['#'],0)); };
            n.onMessage=mqInMessage; },
  dispose:n=>mqStop(n),
  process(n){
    let m=null; if(n.q.length){ m=n.q.shift(); n.last={text:m.text,topic:m.topic,val:m.val!==null ? m.val : n.last.val}; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:m ? m.text : null, topic:m ? m.topic : null, value:n.last.val, rec, new:m ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · messages '+n.msgs+(n.q.length ? ' · queued '+n.q.length : '')+
      (n.last.topic ? '\n'+n.last.topic+': '+n.last.text.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- MQTT Out ---------- */
// text — публикуется по изменению (непустой); value — по изменению, по шаблону {v} / {v:N}. Тема — параметр или провод topic.
// QoS 1: повторная отправка не делается — пока нет PUBACK, он только считается.
function mqOutPublish(n,topic,payload){
  if(!n.ok || !topic) return false;
  const qos=+n.p.qos|0, o={qos,retain:!!n.p.retain,id:qos ? mqNextId(n) : 0};
  mqSend(n,mqPublish(topic,payload,o)); n.sent++; n.lastPub=topic+': '+(typeof payload==='string' ? payload : '')+'';
  return true;
}
def({ id:'mqttOut', title:'MQTT Out', cat:'Output', kw:'mqtt publish broker iot tasmota esphome home assistant relay',
  ins:[{n:'text',t:'txt'},{n:'value',t:'num'},{n:'topic',t:'txt'}], outs:[{n:'ok',t:'num'}], readout:true,
  params:[{n:'url',t:'text',d:'ws://127.0.0.1:9001',label:'broker WebSocket: ws:// wss://'},
          {n:'topic',t:'text',d:'dsp/out',label:'topic (a wire on `topic` overrides)'},
          {n:'template',t:'text',d:'{v}',label:'value template, {v} or {v:N}'},
          {n:'qos',t:'select',opts:['0','1'],d:'0',label:'QoS'},
          {n:'retain',t:'check',d:false,label:'retain'},
          {n:'user',t:'text',d:'',label:'user (optional)'},
          {n:'pass',t:'text',d:'',label:'password (saved with the patch!)'},
          {n:'client',t:'text',d:'',label:'client id (empty — random)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect'},
          {n:'connect',t:'button',label:'Connect',fn:n=>mqStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>mqStop(n)}],
  init:n=>{ n.ws=null; n.want=false; n.ok=false; n.timer=n.pingT=null; n.pid=0; n.cid=''; n.sent=0; n.lastPub='';
            n.lastText=undefined; n.lastVal=undefined; n.status='not connected'; n.warn=''; },
  dispose:n=>mqStop(n),
  process(n,I){
    const topic=typeof I.topic==='string' && I.topic.trim() ? I.topic.trim() : String(n.p.topic||'').trim();
    if(typeof I.text==='string' && I.text!==n.lastText){ if(!I.text || mqOutPublish(n,topic,I.text)) n.lastText=I.text; }
    if(typeof I.value==='number' && isFinite(I.value) && I.value!==n.lastVal){
      const s=String(n.p.template||'{v}').replace(/\{v(?::(\d+))?\}/g,(_,w)=>w ? String(Math.round(I.value)).padStart(+w,'0') : String(I.value));
      if(mqOutPublish(n,topic,s)) n.lastVal=I.value;
    }
    return {ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=(n.warn && !n.ok ? '⚠ '+n.warn+'\n' : '')+n.status+' · published '+n.sent+(n.lastPub ? '\n'+n.lastPub.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
