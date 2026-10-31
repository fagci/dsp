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
  if(!url){ n.status=(typeof gwErr==='function' && gwErr(n.p.url))||'URL must start with ws:// or wss://'; return; }
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
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices'},
    {n:'action',t:'select',opts:PHONE_ACTIONS,d:'notify',label:'action (the Run button, or a rising edge on go)'},
    {n:'title',t:'text',d:'DSP',label:'notification: title'},
    {n:'body',t:'text',d:'',label:'text of the notification / SMS (the «text» input overrides it)'},
    {n:'buttons',t:'text',d:'',label:'notification: buttons, comma separated (up to 3) → rec {src:notify, action}'},
    {n:'open',t:'check',d:false,label:'notification: a tap opens the app (no tap event)'},
    {n:'vibMs',t:'range',min:10,max:10000,step:10,d:200,label:'vibrate: duration, ms (a single buzz; a pattern or a named effect go through the «cmd» rec input: {cmd:\'vibrate\',pattern:[…]} or {cmd:\'vibrate\',effect:\'click\'})'},
    {n:'vibAmp',t:'range',min:0,max:255,step:1,d:0,label:'vibrate: amplitude, 0…255 (0 — default; needs amplitude control)'},
    {n:'to',t:'text',d:'',label:'SMS: number'},
    {n:'dataHex',t:'text',d:'',label:'data SMS: payload, hex (binary SMS to an application port — not a raw PDU; build one with the SMS PDU node)'},
    {n:'dport',t:'num',d:2948,label:'data SMS: destination port'},
    {n:'rawPdu',t:'text',d:'',label:'raw SMS: TPDU hex, no SMSC prefix (the «tpdu» output of SMS PDU, or the «text» input) — experimental, needs a hidden Android API (tools/android/README.md)'},
    {n:'rawSmsc',t:'text',d:'',label:'raw SMS: SMSC bytes, hex (empty — let the network use its default)'},
    {n:'box',t:'select',opts:['all','inbox','sent'],d:'all',label:'SMS list: folder'},
    {n:'q',t:'text',d:'',label:'SMS list / contacts: search text'},
    {n:'limit',t:'range',min:1,max:500,step:1,d:50,label:'SMS list / contacts: how many'},
    {n:'level',t:'range',min:0,max:20,step:1,d:0,label:'torch: brightness level (0 — default; Android 13+)'},
    {n:'alarmName',t:'text',d:'',label:'alarm: name (id; empty — made from the time; for remove empty = all)'},
    {n:'alarmTime',t:'text',d:'7:00',label:'alarm: time HH:MM'},
    {n:'alarmDays',t:'text',d:'weekdays',label:'alarm: days — mon,wed,fri / weekdays / weekend / daily; empty — once'},
    {n:'alarmLabel',t:'text',d:'',label:'alarm: title on the lock screen'},
    {n:'alarmUrl',t:'text',d:'',label:'alarm: internet radio stream (http/https, .pls, .m3u, HLS) — plays on the alarm volume'},
    {n:'alarmSample',t:'text',d:'default',label:'alarm: fallback if the stream does not load, drops or there is no network — file path / content:// / address; default — the system alarm tone, beep — built-in beeps'},
    {n:'alarmLoad',t:'range',min:3,max:60,step:1,d:12,label:'alarm: wait for the stream to start, s (then the fallback)'},
    {n:'alarmRamp',t:'range',min:0,max:300,step:5,d:20,label:'alarm: volume rises over, s (0 — at once)'},
    {n:'alarmVol',t:'range',min:0,max:100,step:5,d:0,label:'alarm: alarm volume, % of the maximum (0 — leave as set)'},
    {n:'alarmSnooze',t:'range',min:1,max:120,step:1,d:9,label:'alarm: snooze, min'},
    {n:'alarmMax',t:'range',min:1,max:60,step:1,d:15,label:'alarm: stops ringing by itself after, min'},
    {n:'callMode',t:'select',opts:['auto','off'],d:'auto',label:'call recording: auto — the service records every call by itself (set), off — stop (allow Phone for the app; the law of many countries requires warning the other person)'},
    {n:'callSrc',t:'select',opts:['auto','voice_call','downlink','uplink','mic','voice_recognition','voice_comm','camcorder'],d:'auto',label:'call recording: source — auto = voice_call (both sides) with root, else the microphone (the other side is heard only on the speaker; new Android may mute the app\'s microphone during a call). downlink = the other side, uplink = you (root, depends on the phone)'},
    {n:'callRate',t:'select',opts:['8000','16000','48000'],d:'16000',label:'call recording: sample rate, Hz'},
    {n:'callMin',t:'range',min:0,max:120,step:1,d:3,label:'call recording: delete recordings shorter than, s (a rejected / missed call)'},
    {n:'recName',t:'text',d:'walk',label:'recording: file name prefix (walk-20261031-090503.jsonl)'},
    {n:'recSubs',t:'text',d:'gps,wifi,ble,bt,cell',label:'recording: sources, separated by commas (gps, wifi, ble, bt, cell, accel, gyro, sys…; sms, mic and pkt are never recorded) — it keeps going with no page and after a reboot'},
    {n:'recHz',t:'range',min:0,max:200,step:1,d:0,label:'recording: sensor rate, Hz (0 — 20)'},
    {n:'recWifi',t:'range',min:0,max:600,step:1,d:0,label:'recording: Wi-Fi scan every, s (0 — 10)'},
    {n:'recCell',t:'range',min:0,max:120,step:1,d:0,label:'recording: cell poll every, s (0 — 5)'},
    {n:'recMax',t:'range',min:0,max:200,step:1,d:0,label:'recording: new file after, MB (0 — 20); the oldest files go over 300 MB in total'},
    {n:'recFile',t:'text',d:'',label:'recording: file name (from rec.list) for read / export / delete'},
    {n:'recOffset',t:'text',d:'0',label:'recording: read — from byte (the answer has next and eof)'},
    {n:'calTitle',t:'text',d:'',label:'calendar: event title'},
    {n:'calStart',t:'text',d:'tomorrow 9:00',label:'calendar: start — 2026-11-02 09:30, 2026-11-02, 9:30, tomorrow 9:30, +2h'},
    {n:'calEnd',t:'text',d:'+1h',label:'calendar: end — the same forms, +1h is from the start (empty — an hour; all day — the end day itself is not included)'},
    {n:'calAllDay',t:'check',d:false,label:'calendar: all-day event'},
    {n:'calWhere',t:'text',d:'',label:'calendar: place'},
    {n:'calNote',t:'text',d:'',label:'calendar: note'},
    {n:'calRemind',t:'text',d:'10',label:'calendar: reminders, minutes before the start, up to 5 (10, 60, 1440) — the Calendar app shows them'},
    {n:'calQuery',t:'text',d:'',label:'calendar: list — only events with this text'},
    {n:'calDays',t:'range',min:1,max:366,step:1,d:7,label:'calendar: list — days ahead from now'},
    {n:'calId',t:'text',d:'',label:'calendar: id of the calendar (cal.calendars shows them; empty — the first writable)'},
    {n:'calEvent',t:'text',d:'',label:'calendar: id of the event to remove (from cal.list)'},
    {n:'bootPatches',t:'text',d:'',label:'boot patches: names separated by «;» (boot.set saves the list, boot.run / boot.stop take it or all; they run in the app without a window, up to 6)'},
    {n:'alarmEv',t:'check',d:false,label:'system events → rec: alarm.* (fire, fallback, snooze, dismiss…), boot.* (patches without a window), callrec.* (start, stop, dropped, error) (asks for «phone state» permission)'},
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
