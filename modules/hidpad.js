"use strict";
/* ============================ HID-периферия приложения DSP: клавиатура + мышь + медиа, геймпад ============================
   Телефон — своя Bluetooth-клавиатура / мышь / медиа-пульт (одно устройство, три report id) или геймпад для ТВ, приставки, ПК.
   Не клон чужого устройства: приложение регистрирует СВОЮ HID-периферию (BluetoothHidDevice, Android 9+). Перед работой телефон
   надо спарить с хостом в системных настройках Bluetooth хоста (имя — из поля name), дальше хост подключается сам или по полю host.
   Звук по HID не передаётся: громкостью и воспроизведением ТВ управляют медиа-кнопки (vol ± / mute / play), а сам звук на ТВ идёт
   системным Bluetooth-аудио (A2DP) — это выбор вывода в настройках Android, не узел.
   Ядро (дескрипторы, отчёты, жесты) — modules/hid-kernels.js, tools/test-hid.mjs. Канал до приложения — те же функции, что у gattlink.js. */

const HID_SUB='hid';
function hidStop(n){
  if(n.ws && n.ws.readyState===1 && n.reg){ try{ n.ws.send(JSON.stringify({cmd:hidCmdName(n.p.transport,'unregister'),id:++n.seq})); }catch(e){} }
  n.reg=false; n.hosts.clear(); n.typeQ.length=0;
  gattStop(n);
}
function hidStart(n){
  gattStart(n);
  const ws=n.ws; if(!ws) return;
  const open=ws.onopen;
  ws.onopen=e=>{ open&&open(e); n.reg=false; gattSend(n,{cmd:hidCmdName(n.p.transport,'list')}); hidRegister(n); };
  ws.onmessage=e=>{
    if(typeof e.data!=='string') return;
    let j; try{ j=JSON.parse(e.data); }catch(x){ return; }
    for(const r of Array.isArray(j) ? j : [j]){ gattFeed(n,r); hidFeed(n,r); }
  };
}
function hidRegister(n){ gattSend(n,hidRegisterCmd(n.devRow||n.dev,n.p.name||(n.devRow&&n.devRow.name),n.p.transport)); }
function hidFeed(n,r){
  if(!r || typeof r!=='object') return;
  if(r.src==='btdev' && r.addr){ if(!n.bondedAt || Date.now()-n.bondedAt>3000){ n.bonded=[]; } n.bondedAt=Date.now(); n.bonded.push(r.name ? r.name+' '+r.addr : r.addr); return; }
  if(r.src==='cmd'){
    if(r.cmd==='hid.register' || r.cmd==='usbhid.register'){ if(r.ok){ n.reg=true; hidAfterReg(n); } else n.regErr=r.msg||'registration refused'; }
    if((r.cmd==='hid.list' || r.cmd==='usbhid.list') && r.ok){ if(r.registered) n.reg=true; if(Array.isArray(r.devices)) for(const a of r.devices) n.hosts.add(a); }
    return;
  }
  if(r.src!=='hid') return;
  if(r.ev==='app'){ n.reg=+r.registered===1; if(n.reg) hidAfterReg(n); }
  else if(r.ev==='connected'){ n.hosts.add(r.addr); n.regErr=''; }
  else if(r.ev==='disconnected' || r.ev==='unplug'){ n.hosts.delete(r.addr); n.ho&&n.ho.releaseAll(); n.ho&&n.ho.take(); }
  else if(r.ev==='data' && r.hex!=null){                   // output-отчёт хоста — светодиоды клавиатуры
    const id=+r.id||0, d=hidReportParse(n.dev,id,hidBytes(r.hex));
    if(d && d.kind==='leds') n.leds=d;
  }
}
function hidAfterReg(n){
  const h=plAddr(n.p.host);
  if(h && !hidUsb(n.p.transport) && !n.hosts.has(h) && !n.connTried){ n.connTried=true; gattSend(n,{cmd:'hid.connect',addr:h}); }
}
// отчёт: в rec всегда (проверка без эфира), в приложение — когда оно зарегистрировано и хост подключён
function hidTx(n,r){
  n.txRec.push({src:'hidtx',dev:n.dev,id:r.id,hex:hidxHex(r.bytes),t:Date.now()}); if(n.txRec.length>300) n.txRec.splice(0,n.txRec.length-300);
  n.sent++;
  if(n.ws && n.ws.readyState===1 && n.reg && (n.hosts.size || hidUsb(n.p.transport))) gattSend(n,hidReportCmd(r.id,r.bytes,null,n.p.transport));
}
function hidPump(n){
  n.pumpT=0;
  for(const r of n.ho.take()) hidTx(n,r);
  const now=performance.now();
  if(n.typeQ.length && now>=n.typeT){ hidTx(n,n.typeQ.shift()); n.typeT=now+500/Math.max(5,+n.p.cps||25); }
  if(n.typeQ.length) n.pumpT=setTimeout(()=>hidPump(n),6);
}
function hidKick(n){ if(!n.pumpT) n.pumpT=setTimeout(()=>hidPump(n),0); }
function hidAlias(s){ const o={}; for(const part of String(s||'').split(/[,;\n]+/)){ const m=/^\s*([^=\s]+)\s*=\s*(\S+)\s*$/.exec(part); if(m) o[m[1].toLowerCase()]=m[2]; } return o; }
function hidTypeText(n,text){
  if(!text) return;
  const t=new HidOut(n.ho.ids); const r=t.type(String(text)+(n.p.enter ? '\n' : ''),n.p.layout);
  n.typeQ.push(...t.take()); n.typed=(n.typed||0)+r.strokes.length; n.skipped=r.skipped;
  hidKick(n);
}
function hidStatus(n){
  const bits=[(n.devRow&&n.devRow.name ? n.devRow.name+' · ' : '')+n.status];
  if(n.ws && n.status==='connected') bits.push(n.reg ? 'registered' : (n.regErr||'registering…'), n.hosts.size ? 'host '+[...n.hosts].join(', ') : (hidUsb(n.p.transport) ? 'cable: no host yet' : 'no host connected'));
  if(n.err) bits.push('⚠ '+n.err);
  return bits.join(' · ');
}

/* ---------- Keyboard + Mouse + Media ---------- */
def({ id:'hidpad', title:'HID Keyboard + Mouse + Media (phone as a Bluetooth remote)', cat:'Sources', touch:true,
  kw:'hid bluetooth keyboard mouse touchpad trackpad remote tv media volume type text air mouse android tv smart tv cursor',
  ins:[{n:'dev',t:'rec'},{n:'cmd',t:'rec'},{n:'key',t:'txt'},{n:'text',t:'txt'},{n:'dx',t:'num'},{n:'dy',t:'num'},{n:'wheel',t:'num'},{n:'btn',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'reg',t:'num'},{n:'hosts',t:'num'},{n:'sent',t:'num'},{n:'caps',t:'num'},{n:'num',t:'num'}],
  view:{h:300}, w:300, resize:true, tall:true,
  groups:[{n:'Typing',open:true},{n:'Touchpad',open:false},{n:'Link',open:false}],
  params:[
    {n:'text',t:'text',d:'',label:'text to type on the host (the Type button; the «text» input types whenever it changes)',g:'Typing'},
    {n:'enter',t:'check',d:false,label:'press Enter after the text',g:'Typing'},
    {n:'layout',t:'select',opts:['us','ru'],d:'us',label:'host keyboard layout: us — Latin; ru — ЙЦУКЕН (Cyrillic goes to the physical keys; Latin letters cannot be typed in this mode)',g:'Typing'},
    {n:'cps',t:'range',min:5,max:80,step:1,d:25,label:'typing speed, characters per second (lower it if the host drops keys)',g:'Typing'},
    {n:'alias',t:'text',d:'a=back,b=menu,c=home,d=mute',label:'names for the «key» input: from=to (a D-pad sends a b c d). Names: letters, digits, up down left right enter esc tab space backspace delete f1…f12, ctrl+c, vol+ vol- mute play next prev home back search…',g:'Typing'},
    {n:'gain',t:'range',min:.2,max:5,step:.05,d:1.4,label:'cursor speed',g:'Touchpad'},
    {n:'accel',t:'range',min:0,max:2,step:.05,d:.6,label:'acceleration (fast strokes go further)',g:'Touchpad'},
    {n:'scroll',t:'range',min:.02,max:.5,step:.01,d:.12,label:'two-finger scroll speed',g:'Touchpad'},
    {n:'natural',t:'check',d:false,label:'natural scrolling (content follows the fingers)',g:'Touchpad'},
    {n:'wgain',t:'range',min:.1,max:20,step:.1,d:4,label:'«dx» / «dy» inputs: steps per unit (an XY Pad or a tilt sensor makes an air mouse)',g:'Touchpad'},
    {n:'transport',t:'select',opts:['bluetooth','usb (root)'],d:'bluetooth',label:'transport: bluetooth — the phone pairs with the host; usb (root) — the phone itself is a USB device on a cable (needs root and a kernel with the USB HID gadget function; the phone\'s USB mode may restart for a moment)',g:'Link'},
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices',g:'Link'},
    {n:'name',t:'text',d:'',label:'name the host sees (empty — DSP keyboard + mouse + media). Changing it takes effect after a new Connect',g:'Link'},
    {n:'host',t:'text',d:'',label:'host address AA:BB:CC:DD:EE:FF to connect to after registering (empty — the paired host connects by itself). «Paired hosts» lists them',g:'Link'},
    {n:'auto',t:'check',d:false,label:'connect to the app and register when the patch starts',g:'Link'},
    {n:'reconnect',t:'check',d:true,label:'reconnect to the app',g:'Link'},
    {n:'type',t:'button',label:'Type',fn:n=>hidTypeText(n,n.p.text)},
    {n:'connect',t:'button',label:'Connect',fn:n=>{ n.connTried=false; if(n.ws && n.ws.readyState===1) hidRegister(n); else hidStart(n); }},
    {n:'bonded',t:'button',label:'Paired hosts',fn:n=>{ n.bonded=[]; gattSend(n,{cmd:'bt.bonded'}); }},
    {n:'rel',t:'button',label:'Release all',fn:n=>{ n.ho.releaseAll(); hidKick(n); }},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>hidStop(n)},
  ],
  init:n=>{
    n.dev='combo'; n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.pend=[]; n.seq=0; n.count=0; n.ok=0; n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.last='';
    n.val=null; n.hex=''; n.txt=''; n.fresh=0;
    n.reg=false; n.regErr=''; n.hosts=new Set(); n.bonded=[]; n.connTried=false; n.leds=null; n.txRec=[]; n.sent=0; n.typed=0; n.skipped=0;
    n.ho=new HidOut(HID_DEVICES.combo.ids); n.touch=new HidTouch(); n.typeQ=[]; n.typeT=0; n.pumpT=0; n.held=new Map(); n.pads=new Map();
    n.prevKey=''; n.prevText=''; n.prevBtn=0; n.autoDone=false; n._wcv=null; n.pulse=0; n.devRow=null; n.lastDev=null; n.lastCmd=null; n.err='';
  },
  dispose:n=>{ clearTimeout(n.pumpT); hidStop(n); },
  process(n,I){
    const p=n.p;
    if(p.auto && !n.autoDone){ n.autoDone=true; hidStart(n); }
    if(Array.isArray(I.dev) && I.dev!==n.lastDev){                       // строка «Reference/HID Devices» из Table: другое устройство
      n.lastDev=I.dev; const d=hidDeviceFromRow(I.dev[I.dev.length-1]);
      if(d){ n.devRow=d; n.ho.ids=d.ids; n.err=''; n.ho.releaseAll(); n.ho.take(); n.touch=new HidTouch();
        if(n.ws && n.ws.readyState===1 && n.reg){ n.connTried=false; gattSend(n,{cmd:hidCmdName(n.p.transport,'unregister')}); n.reg=false; n.hosts.clear(); setTimeout(()=>{ if(n.ws && n.ws.readyState===1) hidRegister(n); },400); } }
      else n.err='dev: a row with a hex «descriptor» is needed (Reference/HID Devices)';
    }
    if(Array.isArray(I.cmd) && I.cmd!==n.lastCmd){                        // команды: строки Table (Reference/HID Keys), Rule, свои записи
      n.lastCmd=I.cmd; const al=hidAlias(p.alias);
      for(const c of I.cmd) for(const a of hidApplyCmd(n.ho,c,al)){
        if(a.text) hidTypeText(n,a.text); else if(a.error) n.err=a.error;
        else if(a.register){ n.connTried=false; if(n.ws && n.ws.readyState===1) hidRegister(n); else hidStart(n); }
        else if(a.unregister) hidStop(n); else if(a.connect && !hidUsb(n.p.transport)) gattSend(n,{cmd:'hid.connect',addr:plAddr(a.connect)||a.connect});
      }
      hidKick(n);
    }
    const key=typeof I.key==='string' ? I.key : '';
    if(key!==n.prevKey){
      const al=hidAlias(p.alias);
      if(n.prevKey){ n.ho.keyUp(hidKeySpec(n.prevKey,al)); }
      if(key){ if(!n.ho.keyDown(hidKeySpec(key,al))) n.last='key: unknown name «'+key+'»'; }
      n.prevKey=key; hidKick(n);
    }
    const text=typeof I.text==='string' ? I.text : '';
    if(text!==n.prevText){ n.prevText=text; if(text) hidTypeText(n,text); }
    const dx=+I.dx||0, dy=+I.dy||0, wh=+I.wheel||0, g=+p.wgain||4;
    if(dx||dy||wh){ n.ho.move(dx*g,dy*g,wh,0); hidKick(n); }
    const btn=(+I.btn||0)&7;
    if(btn!==n.prevBtn){ for(let b=0;b<3;b++){ const m=1<<b; if((btn&m)!==(n.prevBtn&m)) n.ho.button(b+1,!!(btn&m)); } n.prevBtn=btn; hidKick(n); }
    const rec=n.txRec.length ? n.txRec.splice(0) : null;
    return {rec,reg:n.reg?1:0,hosts:n.hosts.size,sent:n.sent,caps:n.leds&&n.leds.caps?1:0,num:n.leds&&n.leds.num?1:0};
  },
  drawKey:n=>hidStatus(n)+'|'+(n.leds?'L':'')+n.pulse,
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, L=hidPadLayout(W,H), pd=L.pad;
    if(n._wcv!==cv){ n._wcv=cv; hidWire(n,cv); }
    n.layout=L;
    cx.clearRect(0,0,W,H);
    indFont(cx,Math.min(11,Math.max(8,H*.045))); cx.textBaseline='top'; cx.textAlign='left';
    cx.fillStyle=themeColor('--scr-hi'); const st=hidStatus(n); cx.fillText(st.length>W/6 ? st.slice(0,Math.floor(W/6))+'…' : st,5,2);
    cx.fillStyle=themeColor('--scr-panel'); cx.strokeStyle=n.reg&&n.hosts.size ? themeColor('--t-blk') : themeColor('--axis'); cx.lineWidth=1.5;
    cx.beginPath(); cx.roundRect(pd.x,pd.y,pd.w,pd.h,8); cx.fill(); cx.stroke();
    cx.globalAlpha=.35; cx.fillStyle=themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillText('move · tap = click',pd.x+pd.w/2,pd.y+pd.h/2-8); cx.fillText('2 fingers: scroll · tap = right click',pd.x+pd.w/2,pd.y+pd.h/2+8); cx.globalAlpha=1;
    for(const b of L.btns){
      const on=[...n.held.values()].includes(b.id);
      cx.fillStyle=on ? themeColor('--t-blk') : themeColor('--scr-panel'); cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1;
      cx.beginPath(); cx.roundRect(b.x,b.y,b.w,b.h,6); cx.fill(); cx.stroke();
      cx.fillStyle=on ? themeColor('--scr-panel') : themeColor('--scr-hi'); indFont(cx,Math.min(13,b.h*.42)); cx.fillText(b.label,b.x+b.w/2,b.y+b.h/2);
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic';
  },
});
// касания тачпада и кнопок: несколько пальцев, у каждой кнопки своё удержание
function hidWire(n,cv){
  cv.style.touchAction='none'; cv.style.cursor='pointer';
  const css=ev=>{ const r=cv.getBoundingClientRect(); return [ev.clientX-r.left, ev.clientY-r.top, cv.width/Math.max(1,r.width)]; };
  const spec=id=>id==='mb1'||id==='mb2'||id==='mb4' ? null : hidKeySpec(id,hidAlias(n.p.alias));
  const apply=acts=>{
    for(const a of acts){
      if(a.a==='move') n.ho.move(a.dx,a.dy,0,0);
      else if(a.a==='scroll') n.ho.move(0,0,a.wheel,a.pan);
      else if(a.a==='press') n.ho.button(a.b,true);
      else if(a.a==='release') n.ho.button(a.b,false);
      else if(a.a==='click') n.ho.click(a.b);
    }
    hidKick(n);
  };
  const cfg=()=>{ const t=n.touch, p=n.p; t.gain=+p.gain||1; t.accel=+p.accel||0; t.scroll=+p.scroll||.12; t.natural=!!p.natural; };
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation(); ev.preventDefault(); cv.setPointerCapture(ev.pointerId); cfg();
    const [x,y,k]=css(ev), h=hidHit(n.layout||hidPadLayout(cv.width,cv.height),x*k,y*k); if(!h) return;
    if(h.kind==='btn'){
      n.held.set(ev.pointerId,h.id);
      if(h.id==='mb1') n.ho.button(1,true); else if(h.id==='mb2') n.ho.button(2,true); else if(h.id==='mb4') n.ho.button(3,true);
      else n.ho.keyDown(spec(h.id));
      try{ navigator.vibrate && navigator.vibrate(8); }catch(e){}
      hidKick(n); redraw(n); return;
    }
    n.pads.set(ev.pointerId,1); apply(n.touch.down(ev.pointerId,x,y,ev.timeStamp));
  });
  cv.addEventListener('pointermove',ev=>{
    if(!n.pads.has(ev.pointerId)) return;
    const [x,y]=css(ev); cfg(); apply(n.touch.move(ev.pointerId,x,y,ev.timeStamp));
  });
  const up=ev=>{
    if(n.held.has(ev.pointerId)){
      const id=n.held.get(ev.pointerId); n.held.delete(ev.pointerId);
      if(id==='mb1') n.ho.button(1,false); else if(id==='mb2') n.ho.button(2,false); else if(id==='mb4') n.ho.button(3,false);
      else n.ho.keyUp(spec(id));
      hidKick(n); redraw(n); return;
    }
    if(n.pads.delete(ev.pointerId)) apply(n.touch.up(ev.pointerId,ev.timeStamp));
  };
  cv.addEventListener('pointerup',up); cv.addEventListener('pointercancel',up);
}

/* ---------- Gamepad ---------- */
def({ id:'hidgamepad', title:'HID Gamepad (phone as a Bluetooth gamepad)', cat:'Sources',
  kw:'hid bluetooth gamepad joystick controller game pad console tv android steam emulator',
  ins:[{n:'x1',t:'num'},{n:'y1',t:'num'},{n:'x2',t:'num'},{n:'y2',t:'num'},{n:'lt',t:'num'},{n:'rt',t:'num'},
       {n:'up',t:'num'},{n:'down',t:'num'},{n:'left',t:'num'},{n:'right',t:'num'},
       ...Array.from({length:16},(_,i)=>({n:'b'+(i+1),t:'num',...(i>=8?{hide:true}:{})}))],
  outs:[{n:'rec',t:'rec'},{n:'reg',t:'num'},{n:'hosts',t:'num'},{n:'sent',t:'num'}],
  readout:true,
  params:[
    {n:'transport',t:'select',opts:['bluetooth','usb (root)'],d:'bluetooth',label:'transport: bluetooth — the phone pairs with the host; usb (root) — the phone itself is a USB device on a cable (needs root and a kernel with the USB HID gadget function; the phone\'s USB mode may restart for a moment)'},
   {n:'url',t:'text',d:'ws://127.0.0.1:8765',dev:true,label:'bridge of the DSP app — an address, or @name from Settings → Devices'},
    {n:'name',t:'text',d:'',label:'name the host sees (empty — DSP gamepad)'},
    {n:'host',t:'text',d:'',label:'host address AA:BB:CC:DD:EE:FF to connect to after registering (empty — the paired host connects by itself)'},
    {n:'invy',t:'check',d:true,label:'invert the Y axes (a stick or a Joystick node gives up = +1, HID wants up = −1)'},
    {n:'rate',t:'range',min:5,max:120,step:1,d:60,label:'reports per second at most (a report goes only when something changed, plus a refresh every second)'},
    {n:'auto',t:'check',d:false,label:'connect to the app and register when the patch starts'},
    {n:'reconnect',t:'check',d:true,label:'reconnect to the app'},
    {n:'connect',t:'button',label:'Connect',fn:n=>{ n.connTried=false; if(n.ws && n.ws.readyState===1) hidRegister(n); else hidStart(n); }},
    {n:'bonded',t:'button',label:'Paired hosts',fn:n=>{ n.bonded=[]; gattSend(n,{cmd:'bt.bonded'}); }},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>hidStop(n)},
  ],
  init:n=>{
    n.dev='gamepad'; n.ws=null; n.want=false; n.timer=null; n.recQ=[]; n.pend=[]; n.seq=0; n.count=0; n.ok=0; n.status='not connected'; n.warn=''; n.sentSub=null; n.bridgeMsg=''; n.last='';
    n.val=null; n.hex=''; n.txt=''; n.fresh=0;
    n.reg=false; n.regErr=''; n.hosts=new Set(); n.bonded=[]; n.connTried=false; n.leds=null; n.txRec=[]; n.sent=0; n.autoDone=false;
    n.pumpT=0; n.padLast=''; n.padT=0; n.padFrame=null;
    n.ho=null; n.typeQ=[];
  },
  dispose:n=>hidStop(n),
  process(n,I){
    const p=n.p;
    if(p.auto && !n.autoDone){ n.autoDone=true; hidStart(n); }
    let btn=0; for(let i=0;i<16;i++) if((+I['b'+(i+1)]||0)>.5) btn|=1<<i;
    const f={btn,hat:hidHat((+I.up||0)>.5,(+I.right||0)>.5,(+I.down||0)>.5,(+I.left||0)>.5),x1:I.x1,y1:p.invy ? -(+I.y1||0) : I.y1,x2:I.x2,y2:p.invy ? -(+I.y2||0) : I.y2,lt:I.lt,rt:I.rt};
    const bytes=hidPadBuild(f), hex=hidxHex(bytes), now=performance.now();
    const minGap=1000/Math.max(5,+p.rate||60);
    if((hex!==n.padLast && now-n.padT>=minGap) || now-n.padT>1000){
      n.padLast=hex; n.padT=now; hidTx(n,{id:1,bytes});
    }
    const rec=n.txRec.length ? n.txRec.splice(0) : null;
    return {rec,reg:n.reg?1:0,hosts:n.hosts.size,sent:n.sent};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t=hidStatus(n); if(n.regErr) t+='\n⚠ '+n.regErr; if(n.bridgeMsg) t+='\n⚠ '+n.bridgeMsg;
    if(n.bonded.length) t+='\npaired: '+n.bonded.join(' · ');
    t+='\nreports '+n.sent+(n.padLast ? ' · '+JSON.stringify(hidPadParse(hidBytes(n.padLast))) : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- HID Report Decode (зеркало передатчиков: отчёт → поля) ---------- */
def({ id:'hidparse', title:'HID Report Decode', cat:'Processing',
  kw:'hid report decode parse keyboard mouse gamepad media consumer usage descriptor led',
  ins:[{n:'rec',t:'rec'},{n:'hex',t:'txt'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'key',t:'txt'},{n:'media',t:'txt'},{n:'dx',t:'num'},{n:'dy',t:'num'},{n:'wheel',t:'num'},{n:'btn',t:'num'},
        {n:'x1',t:'num'},{n:'y1',t:'num'},{n:'x2',t:'num'},{n:'y2',t:'num'}],
  readout:true,
  params:[
    {n:'device',t:'select',opts:['combo','gamepad'],d:'combo',label:'device: combo — keyboard (id 1) + mouse (id 2) + media (id 3); gamepad — one report'},
    {n:'rid',t:'num',d:1,label:'report id for the «hex» input (records carry their own id)'},
  ],
  init:n=>{ n.last=null; n.line=''; n.seen=0; },
  process(n,I){
    const recs=[]; if(Array.isArray(I.rec)) for(const r of I.rec) if(r && (r.hex!=null) && (r.src==='hidtx' || r.src==='hid')) recs.push({id:+r.id||0,hex:r.hex,dev:r.dev});
    if(typeof I.hex==='string' && I.hex) recs.push({id:+n.p.rid||0,hex:I.hex});
    const out=[]; 
    for(const r of recs){
      const d=hidReportParse(r.dev||n.p.device,r.id,hidBytes(r.hex)); if(!d) continue;
      out.push({src:'hidrx',id:r.id,...d}); n.last=d; n.seen++;
      n.line=d.kind==='key' ? 'key '+(d.names.join('+')||'—')+(d.mod ? ' mod 0x'+d.mod.toString(16) : '')
        : d.kind==='mouse' ? 'mouse btn '+d.btn+' d('+d.dx+','+d.dy+') wheel '+d.wheel+' pan '+d.pan
        : d.kind==='media' ? 'media '+(d.name||'released')
        : d.kind==='leds' ? 'LEDs '+['num','caps','scroll'].filter(k=>d[k]).join(' ')
        : d.kind==='pad' ? 'pad btn '+(d.buttons.join(',')||'—')+' hat '+(d.hatName||'—')+' L('+d.x1+','+d.y1+') R('+d.x2+','+d.y2+') LT '+d.lt+' RT '+d.rt : '';
    }
    const k=n.last||{}, o={rec:out.length ? out : null,text:n.line||null};
    o.key=k.kind==='key' ? k.names.join('+') : null; o.media=k.kind==='media' ? k.name : null;
    o.dx=out.reduce((s,r)=>s+(r.kind==='mouse' ? r.dx : 0),0); o.dy=out.reduce((s,r)=>s+(r.kind==='mouse' ? r.dy : 0),0); o.wheel=out.reduce((s,r)=>s+(r.kind==='mouse' ? r.wheel : 0),0);
    o.btn=k.kind==='mouse' ? k.btn : k.kind==='pad' ? k.btn : 0;
    o.x1=k.x1||0; o.y1=k.y1||0; o.x2=k.x2||0; o.y2=k.y2||0;
    return o;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return; const t=(n.line||'waiting for reports…')+'\nreports '+n.seen; if(r.textContent!==t) r.textContent=t; }
});
