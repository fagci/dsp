"use strict";
/* ============================ Phone Actions (приложение DSP) ============================
   Действия телефона из графа: уведомление с кнопками, фонарь, SMS (чтение / отправка / приём), контакты, ИК-передатчик.
   Команды и записи — по WebSocket моста приложения (ядро — phoneact-kernels.js). SMS и контакты открыты только странице самого
   приложения: она добавляет к адресу ключ (DspApp.appKey), чужие сайты его не знают. Телефон без нужного железа ответит ошибкой в rec. */

function phoneStop(n){
  n.want=false; clearTimeout(n.timer); n.timer=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onopen=ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function phoneSubSend(n){
  const m=JSON.stringify({sub:phoneSub(n.p)});
  if(n.ws && n.ws.readyState===1 && m!==n.sentSub){ n.sentSub=m; n.ws.send(m); }
}
function phoneStart(n){
  phoneStop(n);
  let key=''; try{ key=(window.DspApp && DspApp.appKey && DspApp.appKey()) || ''; }catch(e){}
  const url=phoneUrl(n.p.url,key);
  if(!url){ n.status='URL must start with ws:// or wss://'; return; }
  n.want=true; n.warn=netInsecure(url) ? NET_INSECURE_MSG : '';
  let ws;
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message; return; }
  n.ws=ws; n.status='connecting…'; n.sentSub=null;
  ws.onopen=()=>{ n.status='connected'; phoneSubSend(n); for(const c of n.pend.splice(0)) phoneSend(n,c); };
  ws.onerror=()=>{ n.status='connection error — is the DSP app running?'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000 ? ' ('+e.code+')' : '')+(n.p.reconnect ? ' — reconnecting…' : '');
    if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(()=>{ if(n.want) phoneStart(n); },3000); }
  };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]) phoneFeed(n,r);
  };
}
// команда ушла сразу или ждёт соединения (его открывает сама)
function phoneSend(n,cmd){
  if(!cmd) return;
  if(!n.ws || n.ws.readyState!==1){
    n.pend.push(cmd); if(n.pend.length>20) n.pend.shift();
    if(!n.ws) phoneStart(n);
    return;
  }
  n.ws.send(JSON.stringify({...cmd,id:++n.seq}));
}
function phoneFeed(n,r){
  if(!r || typeof r!=='object') return;
  n.count++;
  if(r.src==='torch') n.torchSeen=1; else n.last=phoneLine(r);      // состояние фонаря приходит само и не должно затирать ответ на команду
  if(r.src==='bridge'){ if(r.level==='error' || r.level==='warn') n.bridgeMsg=r.msg; return; }
  if(r.src==='cmd'){ n.ok=r.ok ? 1 : 0; if(r.text){ n.text=String(r.text); n.last+='\n'+String(r.text).slice(0,2500); } }     // текст ответа (диагностика root) — на выход text
  if(r.src==='torch') n.torch=r.on ? 1 : 0;
  if(r.src==='sms') n.text=String(r.body||'');
  if(r.src==='notify') n.text=String(r.action||'');
  if(r.src==='contact') n.text=String(r.name||'');
  n.fresh=1;
  n.recQ.push({t:Date.now(),...r});
  if(n.recQ.length>5000) n.recQ.splice(0,n.recQ.length-5000);
}

def({ id:'phone', title:'Phone Actions (DSP app)', cat:'Output', kw:'android app phone notification action button flashlight torch sms text message contacts infrared ir blaster',
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'ir',t:'txt'},{n:'torch',t:'num'},{n:'cmd',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'new',t:'num'},{n:'torch',t:'num'},{n:'ok',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'bridge of the DSP app'},
    {n:'action',t:'select',opts:PHONE_ACTIONS,d:'notify',label:'action (the Run button, or a rising edge on go)'},
    {n:'title',t:'text',d:'DSP',label:'notification: title'},
    {n:'body',t:'text',d:'',label:'text of the notification / SMS (the «text» input overrides it)'},
    {n:'buttons',t:'text',d:'',label:'notification: buttons, comma separated (up to 3) → rec {src:notify, action}'},
    {n:'open',t:'check',d:false,label:'notification: a tap opens the app (no tap event)'},
    {n:'to',t:'text',d:'',label:'SMS: number'},
    {n:'box',t:'select',opts:['all','inbox','sent'],d:'all',label:'SMS list: folder'},
    {n:'q',t:'text',d:'',label:'SMS list / contacts: search text'},
    {n:'limit',t:'range',min:1,max:500,step:1,d:50,label:'SMS list / contacts: how many'},
    {n:'level',t:'range',min:0,max:20,step:1,d:0,label:'torch: brightness level (0 — default; Android 13+)'},
    {n:'smsIn',t:'check',d:false,label:'incoming SMS → rec (only the page of the app)'},
    {n:'notifyEv',t:'check',d:true,label:'taps on the notification buttons → rec'},
    {n:'torchState',t:'check',d:true,label:'torch state → output torch'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'run',t:'button',label:'Run',fn:n=>{ phoneSend(n,phoneCmd(n.p,n.textIn)); }},
    {n:'connect',t:'button',label:'Connect',fn:n=>phoneStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>phoneStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.pend=[]; n.seq=0; n.count=0; n.text=''; n.ok=0; n.torch=0; n.fresh=0;
            n.status='not connected'; n.warn=''; n.sentSub=null; n.torchSeen=0; n.bridgeMsg=''; n.last=''; n.prevGo=0; n.prevTorch=null; n.textIn=''; n.ev={}; },
  dispose:n=>phoneStop(n),
  process(n,I){
    phoneSubSend(n);
    n.textIn=typeof I.text==='string' ? I.text : '';
    const go=(I.go||0)>.5; if(go && !n.prevGo) phoneSend(n,phoneCmd(n.p,n.textIn)); n.prevGo=go;
    if(typeof I.torch==='number'){                                  // вход torch: фронт — включить, спад — выключить
      const on=I.torch>.5;
      if(n.prevTorch!==null && on!==n.prevTorch) phoneSend(n,{cmd:'torch',on,...(on && +n.p.level>0 ? {level:+n.p.level} : {})});
      n.prevTorch=on;
    }
    const raw=typeof irEvent==='function' ? irEvent(n,'ir',I.ir) : null;      // кадр ИК пришёл — на излучатель
    if(raw){ const c=phoneIrCmd(raw,irParse); if(c) phoneSend(n,c); else n.last='cannot parse the IR frame'; }
    if(Array.isArray(I.cmd) && I.cmd!==n.lastCmd){                   // записи с полем cmd уходят как есть
      n.lastCmd=I.cmd;
      for(const r of I.cmd) if(r && typeof r.cmd==='string') phoneSend(n,r);
    }
    const rec=n.recQ.length ? n.recQ.splice(0) : null, fresh=n.fresh; n.fresh=0;
    return {rec, text:n.text, new:fresh, torch:n.torch, ok:n.ok};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · records '+n.count;
    if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(n.last) t+='\n'+n.last;
    if(n.p.torchState && n.torchSeen) t+='\ntorch '+(n.torch ? 'on' : 'off');      // только пока узел подписан на состояние фонаря
    if(r.textContent!==t) r.textContent=t; }
});
