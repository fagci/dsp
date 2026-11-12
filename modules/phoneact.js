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
  // поля — по секциям; раскрыта та, что нужна выбранному действию (phoneActGroups), остальные свёрнуты
  groups:[{n:'Notify / vibrate / torch'},{n:'SMS / contacts',open:false},{n:'Alarm',open:false},{n:'Calendar',open:false},{n:'Recording',open:false},{n:'Call recording',open:false},{n:'Gallery',open:false},{n:'Folders / files',open:false},{n:'USSD / calls',open:false},{n:'Screen recording',open:false},{n:'Boot patches',open:false},{n:'Events',open:false}],
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices'},
    {n:'action',t:'select',opts:PHONE_ACTIONS,d:'notify',label:'action (the Run button, or a rising edge on go)',
      fn:n=>{ const want=phoneActGroups(n.p.action); if(want.length) for(const g of MOD.phone.groups) if(g.n!=='Events') setGroupOpen(n,g.n,want.includes(g.n)); }},
    {n:'title',t:'text',d:'DSP',label:'notification: title',g:'Notify / vibrate / torch'},
    {n:'body',t:'text',d:'',label:'text of the notification / SMS (the «text» input overrides it)',g:'Notify / vibrate / torch'},
    {n:'buttons',t:'text',d:'',label:'notification: buttons, comma separated (up to 3) → rec {src:notify, action}',g:'Notify / vibrate / torch'},
    {n:'open',t:'check',d:false,label:'notification: a tap opens the app (no tap event)',g:'Notify / vibrate / torch'},
    {n:'vibMs',t:'range',min:10,max:10000,step:10,d:200,label:'vibrate: duration, ms (a single buzz; a pattern or a named effect go through the «cmd» rec input: {cmd:\'vibrate\',pattern:[…]} or {cmd:\'vibrate\',effect:\'click\'})',g:'Notify / vibrate / torch'},
    {n:'vibAmp',t:'range',min:0,max:255,step:1,d:0,label:'vibrate: amplitude, 0…255 (0 — default; needs amplitude control)',g:'Notify / vibrate / torch'},
    {n:'to',t:'text',d:'',label:'SMS: number',g:'SMS / contacts'},
    {n:'dataHex',t:'text',d:'',label:'data SMS: payload, hex (binary SMS to an application port — not a raw PDU; build one with the SMS PDU node)',g:'SMS / contacts'},
    {n:'dport',t:'num',d:2948,label:'data SMS: destination port',g:'SMS / contacts'},
    {n:'rawPdu',t:'text',d:'',label:'raw SMS: TPDU hex, no SMSC prefix (the «tpdu» output of SMS PDU, or the «text» input) — experimental, needs a hidden Android API (tools/android/README.md)',g:'SMS / contacts'},
    {n:'rawSmsc',t:'text',d:'',label:'raw SMS: SMSC bytes, hex (empty — let the network use its default)',g:'SMS / contacts'},
    {n:'box',t:'select',opts:['all','inbox','sent'],d:'all',label:'SMS list: folder',g:'SMS / contacts'},
    {n:'q',t:'text',d:'',label:'SMS list / contacts: search text',g:'SMS / contacts'},
    {n:'limit',t:'range',min:1,max:500,step:1,d:50,label:'SMS list / contacts: how many',g:'SMS / contacts'},
    {n:'level',t:'range',min:0,max:20,step:1,d:0,label:'torch: brightness level (0 — default; Android 13+)',g:'Notify / vibrate / torch'},
    {n:'alarmName',t:'text',d:'',label:'alarm: name (id; empty — made from the time; for remove empty = all)',g:'Alarm'},
    {n:'alarmTime',t:'text',d:'7:00',label:'alarm: time HH:MM',g:'Alarm'},
    {n:'alarmDays',t:'text',d:'weekdays',label:'alarm: days — mon,wed,fri / weekdays / weekend / daily; empty — once',g:'Alarm'},
    {n:'alarmLabel',t:'text',d:'',label:'alarm: title on the lock screen',g:'Alarm'},
    {n:'alarmUrl',t:'text',d:'',label:'alarm: internet radio stream (http/https, .pls, .m3u, HLS) — plays on the alarm volume',g:'Alarm'},
    {n:'alarmSample',t:'text',d:'default',label:'alarm: fallback if the stream does not load, drops or there is no network — file path / content:// / address; default — the system alarm tone, beep — built-in beeps',g:'Alarm'},
    {n:'alarmLoad',t:'range',min:3,max:60,step:1,d:12,label:'alarm: wait for the stream to start, s (then the fallback)',g:'Alarm'},
    {n:'alarmRamp',t:'range',min:0,max:300,step:5,d:20,label:'alarm: volume rises over, s (0 — at once)',g:'Alarm'},
    {n:'alarmVol',t:'range',min:0,max:100,step:5,d:0,label:'alarm: alarm volume, % of the maximum (0 — leave as set)',g:'Alarm'},
    {n:'alarmSnooze',t:'range',min:1,max:120,step:1,d:9,label:'alarm: snooze, min',g:'Alarm'},
    {n:'alarmMax',t:'range',min:1,max:60,step:1,d:15,label:'alarm: stops ringing by itself after, min',g:'Alarm'},
    {n:'screenFps',t:'range',min:0,max:60,step:1,d:0,label:'screen recording: frames per second (0 — 30)',g:'Screen recording'},
    {n:'screenSide',t:'select',opts:['0','640','854','1280','1920'],d:'0',label:'screen recording: the long side of the picture, px (0 — 1280; never above the screen)',g:'Screen recording'},
    {n:'screenKbps',t:'range',min:0,max:20000,step:100,d:0,label:'screen recording: bitrate, kbit/s (0 — by the size of the picture)',g:'Screen recording'},
    {n:'screenAudio',t:'check',d:false,label:'screen recording: add the microphone sound (the sound of other apps is not recorded)',g:'Screen recording'},
    {n:'ussdCode',t:'text',d:'*100#',label:'USSD: code, *100# style (balance, tariff… — it can cost money; wipe / service codes are refused; 5 a minute at most). The answer of the network comes as a record ussd',g:'USSD / calls'},
    {n:'ussdSim',t:'text',d:'',label:'USSD: SIM slot from 0 (empty — the default SIM; ussd.sims lists them)',g:'USSD / calls'},
    {n:'dialNumber',t:'text',d:'',label:'dial: the number (digits, +, *, #)',g:'USSD / calls'},
    {n:'dialDirect',t:'check',d:false,label:'dial: call at once (asks for Phone permission; off — the dialer opens with the number and you press call)',g:'USSD / calls'},
    {n:'mediaKind',t:'select',opts:['images','video','audio','files'],d:'images',label:'gallery: what to list / read / save (the gallery of the phone, MediaStore; Android asks for access to photos, video or audio once)',g:'Gallery'},
    {n:'mediaQuery',t:'text',d:'',label:'gallery: list — only names with this text',g:'Gallery'},
    {n:'mediaDays',t:'range',min:0,max:3650,step:1,d:30,label:'gallery: list — added in the last N days (0 — all)',g:'Gallery'},
    {n:'mediaExif',t:'check',d:false,label:'gallery: list — the position of the photo from EXIF (lat, lon; asks for «media location»; up to 100 rows)',g:'Gallery'},
    {n:'mediaThumbs',t:'check',d:false,label:'gallery: list — a thumbnail in the field thumb as a data-URI (a Table card shows it; up to 100 rows)',g:'Gallery'},
    {n:'mediaThumb',t:'range',min:48,max:512,step:16,d:128,label:'gallery: thumbnail size, px',g:'Gallery'},
    {n:'mediaId',t:'text',d:'',label:'gallery: id of the item (from the list) for media.thumb / media.read',g:'Gallery'},
    {n:'mediaFolder',t:'text',d:'DSP',label:'gallery: save — sub-folder inside Pictures / Movies / Music / Download (Android 10+; no permission needed)',g:'Gallery'},
    {n:'fsGrant',t:'text',d:'',label:'folders: grant (from fs.pick / fs.grants) — the folder you chose in the system picker',g:'Folders / files'},
    {n:'fsPath',t:'text',d:'',label:'folders: path inside the folder, a/b/c.txt (list: a folder; empty — the root)',g:'Folders / files'},
    {n:'fileName',t:'text',d:'',label:'save: file name',g:'Folders / files'},
    {n:'fileMime',t:'text',d:'',label:'save: MIME type (image/jpeg, text/csv…)',g:'Folders / files'},
    {n:'fileData',t:'text',d:'',label:'save / write: the content as base64 (empty — the text input or the «text» field is written; up to 4 MB per call)',g:'Folders / files'},
    {n:'fileAppend',t:'check',d:false,label:'fs.write: append to the end',g:'Folders / files'},
    {n:'fileOffset',t:'text',d:'0',label:'read: from byte (the reply has next and eof — repeat from next until eof)',g:'Folders / files'},
    {n:'fileLimit',t:'range',min:0,max:262144,step:1024,d:0,label:'read: bytes per call (0 — 256 kB, the most)',g:'Folders / files'},
    {n:'fileText',t:'check',d:false,label:'read: as UTF-8 text in the field text (otherwise base64 in data)',g:'Folders / files'},
    {n:'callMode',t:'select',opts:['auto','off'],d:'auto',label:'call recording: auto — the service records every call by itself (set), off — stop (allow Phone for the app; the law of many countries requires warning the other person)',g:'Call recording'},
    {n:'callSrc',t:'select',opts:['auto','voice_call','downlink','uplink','mic','voice_recognition','voice_comm','camcorder'],d:'auto',label:'call recording: source — auto = voice_call (both sides) with root, else the microphone (the other side is heard only on the speaker; new Android may mute the app\'s microphone during a call). downlink = the other side, uplink = you (root, depends on the phone)',g:'Call recording'},
    {n:'callRate',t:'select',opts:['8000','16000','48000'],d:'16000',label:'call recording: sample rate, Hz',g:'Call recording'},
    {n:'callMin',t:'range',min:0,max:120,step:1,d:3,label:'call recording: delete recordings shorter than, s (a rejected / missed call)',g:'Call recording'},
    {n:'recName',t:'text',d:'walk',label:'recording: file name prefix (walk-20261031-090503.jsonl)',g:'Recording'},
    {n:'recSubs',t:'text',d:'gps,wifi,ble,bt,cell',label:'recording: sources, separated by commas (gps, wifi, ble, bt, cell, accel, gyro, sys…; sms, mic and pkt are never recorded) — it keeps going with no page and after a reboot',g:'Recording'},
    {n:'recHz',t:'range',min:0,max:200,step:1,d:0,label:'recording: sensor rate, Hz (0 — 20)',g:'Recording'},
    {n:'recWifi',t:'range',min:0,max:600,step:1,d:0,label:'recording: Wi-Fi scan every, s (0 — 10)',g:'Recording'},
    {n:'recCell',t:'range',min:0,max:120,step:1,d:0,label:'recording: cell poll every, s (0 — 5)',g:'Recording'},
    {n:'recMax',t:'range',min:0,max:200,step:1,d:0,label:'recording: new file after, MB (0 — 20); the oldest files go over 300 MB in total',g:'Recording'},
    {n:'recFile',t:'text',d:'',label:'recording: file name (from rec.list) for read / export / delete',g:'Recording'},
    {n:'recOffset',t:'text',d:'0',label:'recording: read — from byte (the answer has next and eof)',g:'Recording'},
    {n:'calTitle',t:'text',d:'',label:'calendar: event title',g:'Calendar'},
    {n:'calStart',t:'text',d:'tomorrow 9:00',label:'calendar: start — 2026-11-02 09:30, 2026-11-02, 9:30, tomorrow 9:30, +2h',g:'Calendar'},
    {n:'calEnd',t:'text',d:'+1h',label:'calendar: end — the same forms, +1h is from the start (empty — an hour; all day — the end day itself is not included)',g:'Calendar'},
    {n:'calAllDay',t:'check',d:false,label:'calendar: all-day event',g:'Calendar'},
    {n:'calWhere',t:'text',d:'',label:'calendar: place',g:'Calendar'},
    {n:'calNote',t:'text',d:'',label:'calendar: note',g:'Calendar'},
    {n:'calRemind',t:'text',d:'10',label:'calendar: reminders, minutes before the start, up to 5 (10, 60, 1440) — the Calendar app shows them',g:'Calendar'},
    {n:'calQuery',t:'text',d:'',label:'calendar: list — only events with this text',g:'Calendar'},
    {n:'calDays',t:'range',min:1,max:366,step:1,d:7,label:'calendar: list — days ahead from now',g:'Calendar'},
    {n:'calId',t:'text',d:'',label:'calendar: id of the calendar (cal.calendars shows them; empty — the first writable)',g:'Calendar'},
    {n:'calEvent',t:'text',d:'',label:'calendar: id of the event to remove (from cal.list)',g:'Calendar'},
    {n:'bootPatches',t:'text',d:'',label:'boot patches: names separated by «;» (boot.set saves the list, boot.run / boot.stop take it or all; they run in the app without a window, up to 6)',g:'Boot patches'},
    {n:'alarmEv',t:'check',d:false,label:'system events → rec: alarm.* (fire, fallback, snooze, dismiss…), boot.* (patches without a window), callrec.* (start, stop, dropped, error) (asks for «phone state» permission)',g:'Events'},
    {n:'smsIn',t:'check',d:false,label:'incoming SMS → rec (only the page of the app)',g:'Events'},
    {n:'notifyEv',t:'check',d:true,label:'taps on the notification buttons → rec',g:'Events'},
    {n:'torchState',t:'check',d:true,label:'torch state → output torch',g:'Events'},
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
