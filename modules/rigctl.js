"use strict";
/* ======================= RIG CONTROL (Hamlib rigctld) — узел ======================= */
// Частота, режим, PTT и S-метр трансивера через rigctld (ядро — hamlib-kernels.js). Табло на канве: клик по верхней/нижней
// половине цифры или колесо над ней — шаг в этом разряде; режимы и PTT — кнопки на канве. Мост к rigctld — ctlport.js.

const RG_DIG=10;                                                         // 10 разрядов: до 9 999 999 999 Гц
const RG_STEPS=['1','10','100','1000','5000','12500','25000','100000'];
const RG_BW=['default','300','500','1800','2400','3000','6000','15000','230000'];
const rgBw=n=>n.p.bw==='default' ? 0 : +n.p.bw;

function rgStop(n){
  n.want=false; clearInterval(n.tm); n.tm=null; clearTimeout(n.sendT); n.sendT=null;
  if(n.q) n.q.reset('closed');
  if(n.cp && n.act.ptt && n.connected){ try{ n.cp.write(hlCmd.setPtt(false)[0]); }catch(e){} }   // отпустить передачу при отключении
  cpClose(n); n.act.ptt=0; n.pttT=0; n.wantF=null; n.wantMode=null;
}
async function rgConnect(n){
  rgStop(n); n.want=true;
  n.q=hlQueue(1500); n.pollN=0; n.pollT=0;
  await cpOpen(n,{via:n.p.via,url:n.p.url,sim:n.p.via==='simulator' ? (n.sim||(n.sim=hlSimRig())) : null,
    onText:s=>n.q&&n.q.feed(s), onClose:()=>rgLost(n)});
  if(!n.connected){ rgRetry(n); return; }
  n.tm=setInterval(()=>rgTick(n),40);
}
function rgLost(n){
  clearInterval(n.tm); n.tm=null; if(n.q) n.q.reset('closed');
  n.act.s=NaN; rgRetry(n);
}
function rgRetry(n){
  if(!n.want || !n.p.reconnect || n.p.via!=='websocket') return;
  clearTimeout(n.retryT); n.retryT=setTimeout(()=>{ if(n.want && !n.connected){ n.status='reconnecting…'; rgConnect(n); } },3000);
}
function rgTick(n){
  if(!n.connected || !n.cp) return;
  const now=performance.now(), q=n.q;
  if(n.act.ptt && n.pttT && now-n.pttT>n.p.tot*1000){ n.status='PTT released: time-out'; rgPtt(n,false); }
  if(q.pending()===0 && now-n.pollT>=1000/+n.p.poll){
    n.pollT=now; const k=n.pollN++;
    q.add(...hlCmd.getFreq(),(ls,e)=>{ if(!e){ const v=hlNum(ls[0]); if(v>=0 && n.wantF==null) n.act.f=v; } });
    if(k%4===0){
      q.add(...hlCmd.getMode(),(ls,e)=>{ if(!e && n.wantMode==null){ n.act.mode=ls[0]; n.act.bw=hlNum(ls[1]); } });
      q.add(...hlCmd.getPtt(),(ls,e)=>{ if(!e && n.wantPtt==null) n.act.ptt=ls[0]==='1' ? 1 : 0; });
    }
    if(!n.act.ptt) q.add(...hlCmd.getStrength(),(ls,e)=>{ n.act.s=e ? NaN : hlNum(ls[0]); });
  }
  const c=q.pump(now); if(c) n.cp.write(c);
  n.dirty=true;
}
// пользовательские изменения: частота склеивается (колесо крутят пачкой), режим и PTT уходят сразу
function rgSetFreq(n,hz){
  hz=Math.max(0,Math.min(Math.pow(10,RG_DIG)-1,Math.round(hz)));
  n.wantF=hz; n.dirty=true;
  if(!n.connected) { n.act.f=hz; n.wantF=null; return; }
  clearTimeout(n.sendT);
  n.sendT=setTimeout(()=>{
    const f=n.wantF; if(f==null) return;
    n.q.add(...hlCmd.setFreq(f),(ls,e)=>{ if(e) n.status='set frequency: '+e; else n.act.f=f; if(n.wantF===f) n.wantF=null; });
  },120);
}
function rgSetMode(n,m){
  if(!HL_MODES.includes(m)) return;
  n.wantMode=m; n.dirty=true;
  if(!n.connected){ n.act.mode=m; n.wantMode=null; return; }
  n.q.add(...hlCmd.setMode(m,rgBw(n)),(ls,e)=>{ if(e) n.status='set mode: '+e; else n.act.mode=m; if(n.wantMode===m) n.wantMode=null; });
}
function rgPtt(n,on){
  if(on && !n.p.pttEn){ n.status='PTT is off — tick «allow PTT» first'; return; }
  on=!!on; n.wantPtt=on; n.dirty=true;
  if(!n.connected){ n.act.ptt=on?1:0; n.wantPtt=null; return; }
  n.q.add(...hlCmd.setPtt(on),(ls,e)=>{ if(e) n.status='PTT: '+e; else { n.act.ptt=on?1:0; n.pttT=on ? performance.now() : 0; } n.wantPtt=null; });
}
const rgFreq=n=>n.wantF!=null ? n.wantF : n.act.f;

// мышь и колесо на табло
function rgWire(n,cv){
  if(n._wcv===cv) return; n._wcv=cv;
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return [(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height]; };
  const digitAt=(x,y)=>{ const L=hlLayout(cv.width,cv.height,RG_DIG,HL_MODES.length); return L.digits.find(d=>hlHit(d,x,y)); };
  cv.addEventListener('pointerdown',ev=>{
    ev.stopPropagation();
    const [x,y]=pos(ev), L=hlLayout(cv.width,cv.height,RG_DIG,HL_MODES.length);
    const d=L.digits.find(d=>hlHit(d,x,y));
    if(d){ const dg=hlDigits(rgFreq(n),RG_DIG)[d.i]; rgSetFreq(n,hlStepFreq(rgFreq(n)||0,dg.pow,y<d.y+d.h/2 ? 1 : -1,RG_DIG)); return; }
    const m=L.modes.find(r=>hlHit(r,x,y)); if(m){ rgSetMode(n,HL_MODES[m.i]); return; }
    if(hlHit(L.ptt,x,y)) rgPtt(n,!n.act.ptt);
  });
  cv.addEventListener('pointermove',ev=>{ const [x,y]=pos(ev), d=digitAt(x,y); const h=d ? d.i*2+(y<d.y+d.h/2?0:1) : -1; if(h!==n.hov){ n.hov=h; n.dirty=true; } });
  cv.addEventListener('pointerleave',()=>{ n.hov=-1; n.dirty=true; });
  cv.addEventListener('wheel',ev=>{
    const [x,y]=pos(ev), d=digitAt(x,y); if(!d) return;
    ev.preventDefault(); ev.stopPropagation();
    rgSetFreq(n,hlStepFreq(rgFreq(n)||0,hlDigits(0,RG_DIG)[d.i].pow,ev.deltaY<0 ? 1 : -1,RG_DIG));
  },{passive:false});
}

def({ id:'rigctl', lazy:'manual', title:'Rig Control (Hamlib rigctld)', cat:'Sources',
  kw:'rig radio transceiver cat rigctl rigctld hamlib frequency vfo mode ptt s-meter tune icom yaesu kenwood',
  ins:[{n:'f',t:'num',tip:'frequency to set, Hz (on change)'},{n:'mode',t:'txt',tip:'mode to set: USB LSB CW AM FM…'},{n:'ptt',t:'num',tip:'>0.5 — transmit (needs «allow PTT»)'}],
  outs:[{n:'f',t:'num',tip:'rig frequency, Hz → USB SDR tuneFreq'},{n:'mode',t:'txt'},{n:'ptt',t:'num'},
        {n:'s',t:'num',tip:'signal strength, dB relative to S9 (S9 = 0)'},{n:'su',t:'num',tip:'S units 0…9'},{n:'text',t:'txt'},{n:'on',t:'num',tip:'1 when connected'}],
  view:{h:150}, readout:true, resize:true, w:440,
  params:[{n:'connect',t:'button',label:'Connect',fn:n=>rgConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ rgStop(n); n.status='disconnected'; }},
          {n:'via',t:'select',opts:['websocket','simulator'],d:'websocket',label:'channel (websocket — bridge to rigctld; simulator — no hardware)'},
          {n:'url',t:'text',d:'ws://127.0.0.1:8768',label:'bridge URL: rigctld -m <model> -r <port> -t 4532, then websockify 8768 127.0.0.1:4532'},
          {n:'poll',t:'select',opts:['1','2','5','10'],d:'2',label:'poll rate, Hz'},
          {n:'stepm',t:'button',label:'− step',fn:n=>rgSetFreq(n,(rgFreq(n)||0)-n.p.step)},
          {n:'stepp',t:'button',label:'+ step',fn:n=>rgSetFreq(n,(rgFreq(n)||0)+n.p.step)},
          {n:'step',t:'select',opts:RG_STEPS,d:'1000',label:'step for the buttons and the f pin, Hz'},
          {n:'bw',t:'select',opts:RG_BW,d:'default',label:'passband when setting the mode, Hz'},
          {n:'ctl',t:'check',d:true,label:'take f / mode / ptt from the pins when they change'},
          {n:'pttEn',t:'check',d:false,label:'allow PTT (transmit)'},
          {n:'tot',t:'range',min:5,max:600,step:5,d:120,label:'PTT time-out, s (released automatically)'},
          {n:'reconnect',t:'check',d:true,label:'reconnect (websocket) after a drop'},
          {n:'auto',t:'check',d:false,label:'connect when the patch loads (websocket / simulator)'}],
  init:n=>{
    n.act={f:NaN,mode:'',bw:NaN,ptt:0,s:NaN}; n.wantF=null; n.wantMode=null; n.wantPtt=null; n.hov=-1; n.dirty=true;
    n.cp=null; n.connected=false; n.want=false; n.q=null; n.tm=null; n.status='not connected'; n.sim=null;
    n._inF=undefined; n._inM=undefined; n._inP=undefined; n._shown='';
  },
  dispose:n=>{ rgStop(n); clearTimeout(n.retryT); },
  process(n,I){
    if(!n._boot){ n._boot=true; if(n.p.auto && !n.connected) rgConnect(n); }
    if(n.p.ctl){
      if(typeof I.f==='number' && I.f>0 && I.f!==n._inF){ n._inF=I.f; rgSetFreq(n,I.f); }
      if(typeof I.mode==='string' && I.mode && I.mode!==n._inM){ n._inM=I.mode; rgSetMode(n,I.mode.toUpperCase()); }
      if(typeof I.ptt==='number'){ const on=I.ptt>.5; if(on!==n._inP){ n._inP=on; rgPtt(n,on); } }
    }
    const a=n.act, f=rgFreq(n);
    return {f:Number.isFinite(f) ? f : null, mode:a.mode||null, ptt:a.ptt, s:Number.isFinite(a.s) ? a.s : null, su:Number.isFinite(a.s) ? hlSUnits(a.s) : null,
      text:(Number.isFinite(f) ? hlFmtFreq(f)+' Hz ' : '')+(a.mode||'')+(a.ptt?' TX':'')+(Number.isFinite(a.s) ? ' '+hlSText(a.s) : ''), on:n.connected?1:0};
  },
  drawKey:n=>(n.dirty?'d':'')+n.status+'|'+n.act.f+'|'+n.wantF+'|'+n.act.mode+'|'+n.act.ptt+'|'+Math.round(n.act.s)+'|'+n.hov+'|'+n.connected,
  draw(n,cv,cx){
    n.dirty=false; rgWire(n,cv);
    const W=cv.width, H=cv.height, a=n.act, L=hlLayout(W,H,RG_DIG,HL_MODES.length), f=rgFreq(n);
    cx.clearRect(0,0,W,H); cx.textBaseline='middle'; cx.textAlign='center';
    const hi=themeColor('--scr-hi'), dim=themeColor('--axis'), pan=themeColor('--scr-panel');
    cx.font='bold '+Math.round(L.dh*.82)+'px monospace';
    const dg=Number.isFinite(f) ? hlDigits(f,RG_DIG) : null;
    L.digits.forEach((d,i)=>{
      cx.fillStyle=pan; cx.fillRect(d.x,d.y,d.w,d.h);
      if(n.hov>>1===i){ cx.fillStyle=themeColor('--acc2'); cx.globalAlpha=.25; cx.fillRect(d.x,(n.hov&1)?d.y+d.h/2:d.y,d.w,d.h/2); cx.globalAlpha=1; }
      cx.fillStyle=!dg ? dim : dg[i].dim ? dim : (n.wantF!=null ? themeColor('--scr-warn') : hi);
      cx.globalAlpha=dg && dg[i].dim ? .35 : 1;
      cx.fillText(dg ? dg[i].d : '–',d.x+d.w/2,d.y+d.h*.52); cx.globalAlpha=1;
    });
    cx.font=Math.round(L.modes[0].h*.55)+'px monospace';
    L.modes.forEach((m,i)=>{
      const on=a.mode===HL_MODES[i];
      cx.fillStyle=on ? hi : pan; cx.fillRect(m.x,m.y,m.w,m.h);
      cx.fillStyle=on ? themeColor('--bg') : dim; cx.fillText(HL_MODES[i],m.x+m.w/2,m.y+m.h/2+1);
    });
    cx.fillStyle=a.ptt ? themeColor('--scr-bad') : pan; cx.fillRect(L.ptt.x,L.ptt.y,L.ptt.w,L.ptt.h);
    cx.fillStyle=a.ptt ? '#fff' : n.p.pttEn ? dim : themeColor('--axis'); cx.globalAlpha=n.p.pttEn||a.ptt ? 1 : .45;
    cx.fillText(a.ptt ? 'TX' : 'PTT',L.ptt.x+L.ptt.w/2,L.ptt.y+L.ptt.h/2+1); cx.globalAlpha=1;
    // S-метр: S1…S9 по 6 дБ, выше — до +40
    const s=L.sm, su=Number.isFinite(a.s) ? Math.max(0,Math.min(1,(a.s+54)/94)) : 0;
    cx.fillStyle=pan; cx.fillRect(s.x,s.y,s.w,s.h);
    cx.fillStyle=a.s>0 ? themeColor('--scr-warn') : themeColor('--scr-ok'); cx.globalAlpha=.85; cx.fillRect(s.x,s.y,s.w*su,s.h); cx.globalAlpha=1;
    cx.fillStyle=dim; cx.textAlign='left';
    for(let i=1;i<=9;i+=2){ const x=s.x+s.w*(((i-9)*6+54)/94); cx.fillRect(x,s.y+s.h-4,1,4); cx.fillText(String(i),x+2,s.y+s.h*.35); }
    cx.textAlign='right'; cx.fillStyle=hi; cx.fillText(hlSText(a.s),s.x+s.w-4,s.y+s.h*.5);
    cx.textAlign='start'; cx.textBaseline='alphabetic';
    roText(n,n.status+(n.connected && !Number.isFinite(f) ? ' · waiting for the rig…' : ''));
  }});
defGroups('rigctl',[
  {n:'Connection',p:'via url poll reconnect auto',open:false},
  {n:'Tuning',p:'step bw ctl tot',open:false}],{pri:'connect stepm stepp pttEn'});
