"use strict";
/* ======================= ROTATOR (азимут / возвышение) — узел ======================= */
// Поворотник антенны: rotctld (Hamlib) через WebSocket-мост, GS-232 и EasyComm II по Web Serial, либо виртуальный (ядро — rotator-kernels.js).
// Компас на канве: клик/перетаскивание задаёт цель (радиус = возвышение, центр — зенит), колесо ±1° (Shift ±10°). Круговой скан по уровню на пине lvl.

const ROT_BAUD=['1200','2400','4800','9600','19200','38400','115200'];
const RT_Q=3000;                                                         // rotctld отвечает на P, когда команда принята, — запас на медленные бэкенды

function rtStop(n,quiet){
  n.want=false; clearInterval(n.tm); n.tm=null;
  if(n.cp && n.connected && !quiet){ try{ n.cp.write(RT_PROTO[n.p.proto].stop); }catch(e){} }
  if(n.q) n.q.reset('closed');
  cpClose(n); n.scan=null;
}
async function rtConnect(n){
  rtStop(n,true); n.want=true; n.sim=null; n.q=hlQueue(RT_Q); n.pollT=0; n.lastSend=0; n.simT=performance.now();
  await cpOpen(n,{via:n.p.via,url:n.p.url,baud:n.p.baud,sim:n.p.via==='simulator' ? (n.sim=rtSim({rate:+n.p.simRate})) : null,
    onText:s=>n.q&&n.q.feed(s), onClose:()=>rtLost(n)});
  if(!n.connected){ rtRetry(n); return; }
  n.tm=setInterval(()=>rtTick(n),40);
  n.sent=null; n.cmdDirty=false;                                          // первая цель — только по команде пользователя
}
function rtLost(n){ clearInterval(n.tm); n.tm=null; if(n.q) n.q.reset('closed'); n.act.az=n.act.el=NaN; rtRetry(n); }
function rtRetry(n){
  if(!n.want || !n.p.reconnect || n.p.via!=='websocket') return;
  clearTimeout(n.retryT); n.retryT=setTimeout(()=>{ if(n.want && !n.connected){ n.status='reconnecting…'; rtConnect(n); } },3000);
}
// цель вне пределов не уходит на устройство: азимут выбирается внутри [azMin,azMax] ближе к текущему положению
function rtTarget(n){
  const p=n.p, cur=Number.isFinite(n.act.az) ? n.act.az : p.azMin;
  return {az:rtPick(p.azT,cur,+p.azMin,+p.azMax), el:p.elOn ? rtClampEl(+p.elT,+p.elMin,+p.elMax) : 0};
}
function rtSetTarget(n,az,el,fromScan){
  if(n.scan && !fromScan) rtScanAbort(n,'scan stopped by hand');
  if(Number.isFinite(az)) setMod(n,'azT',+rtNorm(az).toFixed(2));
  if(n.p.elOn && Number.isFinite(el)) setMod(n,'elT',+rtClampEl(el,+n.p.elMin,+n.p.elMax).toFixed(2));
  n.cmdDirty=true; n.dirty=true;
}
function rtJog(n,d){ rtSetTarget(n,n.p.azT+d); }
function rtHalt(n){
  if(n.scan) rtScanAbort(n,'stopped');
  if(n.connected){ const P=RT_PROTO[n.p.proto]; n.q.add(P.stop,P.ack||0); }
  if(Number.isFinite(n.act.az)){ setMod(n,'azT',+rtNorm(n.act.az).toFixed(2)); if(n.p.elOn && Number.isFinite(n.act.el)) setMod(n,'elT',+n.act.el.toFixed(2)); }
  n.cmdDirty=false; n.sent=null; n.status='stopped';
}
function rtPark(n){ if(n.scan) rtScanAbort(n,'parked'); rtSetTarget(n,0,0); n.status='parking'; }
function rtSend(n,now){
  const P=RT_PROTO[n.p.proto], t=rtTarget(n), s=n.sent;
  n.lastSend=now; n.cmdDirty=false;
  if(s && Math.abs(s.az-t.az)<.05 && Math.abs(s.el-t.el)<.05) return;
  n.sent=t;
  n.q.add(P.set(t.az,t.el,n.p.elOn),P.ack||0);
}
function rtTick(n){
  if(!n.connected || !n.cp) return;
  const now=performance.now(), q=n.q, P=RT_PROTO[n.p.proto];
  if(n.sim){ n.sim.step(Math.min(.2,(now-n.simT)/1000)); } n.simT=now;
  if(n.cmdDirty && now-n.lastSend>250) rtSend(n,now);
  if(q.pending()===0 && now-n.pollT>=1000/+n.p.poll){
    n.pollT=now;
    q.add(n.p.proto==='GS-232' && !n.p.elOn ? P.getAz : P.get,P.getLines,(ls,e)=>{
      if(e){ n.miss=(n.miss||0)+1; if(n.miss>3) n.status='no answer from the rotator'; return; }
      n.miss=0; const r=P.parse(ls); if(r){ n.act.az=r.az; n.act.el=r.el; n.act.t=performance.now(); if(/^no answer/.test(n.status)) n.status=n.cp?.kind==='sim' ? 'simulator' : 'connected'; }
    });
  }
  const c=q.pump(now); if(c) n.cp.write(c);
  rtScanStep(n,now);
  n.dirty=true;
}

/* ---- круговой скан ---- */
function rtScanStart(n){
  if(!n.connected){ n.status='connect first'; return; }
  if(!Number.isFinite(n.act.az)){ n.status='scan: no position yet'; return; }
  const span=+n.p.scanSpan, plan=rtScanPlan(n.act.az,span,+n.p.scanStep);
  n.scan={plan,bins:rtScanInit(plan),i:0,phase:'move',t:performance.now(),best:null,back:n.act.az};
  n.best=null; rtSetTarget(n,plan[0],undefined,true); n.status='scan 1/'+plan.length;
}
function rtScanAbort(n,msg){ if(n.scan){ n.scan=null; n.status=msg||'scan stopped'; } }
function rtScanStep(n,now){
  const sc=n.scan; if(!sc) return;
  const tol=Math.max(1.5,+n.p.scanStep*.15);
  if(sc.phase==='move'){
    if(Math.abs(rtDelta(n.act.az,sc.plan[sc.i]))<=tol){ sc.phase='dwell'; sc.t=now; }
    else if(now-sc.t>90000){ rtScanAbort(n,'scan: the rotator did not reach '+sc.plan[sc.i].toFixed(0)+'°'); }
  }else if(sc.phase==='dwell' && now-sc.t>=n.p.scanDwell*1000){
    sc.i++;
    if(sc.i>=sc.plan.length){
      sc.best=rtScanBest(sc.bins,n.p.centroid); n.best=sc.best; sc.phase='done';
      n.status=sc.best ? 'scan done: best '+sc.best.az.toFixed(1)+'° ('+sc.best.lvl.toFixed(1)+' dB)' : 'scan done: no level on the lvl pin';
      if(sc.best && n.p.scanGo) rtSetTarget(n,sc.best.az,undefined,true);
    }else{ sc.phase='move'; sc.t=now; rtSetTarget(n,sc.plan[sc.i],undefined,true); n.status='scan '+(sc.i+1)+'/'+sc.plan.length; }
  }
}

/* ---- мышь ---- */
function rtWire(n,cv){
  if(n._wcv===cv) return; n._wcv=cv;
  let down=false;
  const set=ev=>{
    const r=cv.getBoundingClientRect(), d=rtDial(cv.width,cv.height);
    const q=rtDialPoint(d,(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height);
    rtSetTarget(n,q.az,n.p.elOn ? q.el : undefined);
  };
  cv.addEventListener('pointerdown',ev=>{ ev.stopPropagation(); down=true; cv.setPointerCapture(ev.pointerId); set(ev); });
  cv.addEventListener('pointermove',ev=>{ if(down) set(ev); });
  cv.addEventListener('pointerup',()=>{ down=false; });
  cv.addEventListener('wheel',ev=>{ ev.preventDefault(); ev.stopPropagation(); rtJog(n,(ev.deltaY<0?1:-1)*(ev.shiftKey?10:1)); },{passive:false});
}

def({ id:'rotator', lazy:'manual', title:'Rotator (az / el)', cat:'Sources',
  kw:'rotator rotor antenna azimuth elevation pointing rotctl rotctld hamlib gs-232 yaesu easycomm satnogs tracker scan direction compass',
  ins:[{n:'az',t:'num',tip:'target azimuth, ° (from the north, clockwise)'},{n:'el',t:'num',tip:'target elevation, °'},
       {n:'lvl',t:'num',tip:'level in dB for the circular scan (Antenna Peaker snr, Signal Meter…)'},
       {n:'stop',t:'num',tip:'a pulse 0→1 stops'},{n:'park',t:'num',tip:'a pulse 0→1 parks (0°, 0°)'}],
  outs:[{n:'az',t:'num',tip:'actual azimuth, °'},{n:'el',t:'num',tip:'actual elevation, °'},{n:'taz',t:'num',tip:'target azimuth'},{n:'tel',t:'num'},
        {n:'lvl',t:'num',tip:'level used by the scan, dB (the lvl pin or, in the simulator, a virtual beacon)'},{n:'moving',t:'num',tip:'1 while it turns'},{n:'best',t:'num',tip:'best azimuth of the last scan, °'},{n:'text',t:'txt'},{n:'on',t:'num',tip:'1 when connected'}],
  view:{h:230}, readout:true, resize:true, w:380,
  params:[{n:'connect',t:'button',label:'Connect',fn:n=>rtConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ rtStop(n); n.status='disconnected'; }},
          {n:'stopb',t:'button',label:'■ Stop',fn:n=>rtHalt(n)},
          {n:'parkb',t:'button',label:'Park (0°, 0°)',fn:n=>rtPark(n)},
          {n:'azT',t:'range',min:0,max:360,step:.1,d:0,label:'target azimuth, ° (click the compass)'},
          {n:'elT',t:'range',min:0,max:90,step:.1,d:0,label:'target elevation, ° (the radius of the compass: rim — horizon, centre — zenith)'},
          {n:'n',t:'button',label:'N',fn:n=>rtSetTarget(n,0)},{n:'e',t:'button',label:'E',fn:n=>rtSetTarget(n,90)},
          {n:'s',t:'button',label:'S',fn:n=>rtSetTarget(n,180)},{n:'w',t:'button',label:'W',fn:n=>rtSetTarget(n,270)},
          {n:'m10',t:'button',label:'◄◄ −10°',fn:n=>rtJog(n,-10)},{n:'m1',t:'button',label:'◄ −1°',fn:n=>rtJog(n,-1)},
          {n:'p1',t:'button',label:'+1° ►',fn:n=>rtJog(n,1)},{n:'p10',t:'button',label:'+10° ►►',fn:n=>rtJog(n,10)},
          {n:'elOn',t:'check',d:false,label:'elevation (otherwise azimuth only)'},
          {n:'follow',t:'check',d:true,label:'follow the az / el pins when they change'},
          {n:'via',t:'select',opts:['websocket','serial','simulator'],d:'websocket',label:'channel (websocket — bridge to rotctld; serial — controller directly; simulator — no hardware)'},
          {n:'proto',t:'select',opts:Object.keys(RT_PROTO),d:'rotctld',label:'protocol'},
          {n:'url',t:'text',d:'ws://127.0.0.1:8769',label:'bridge URL: rotctld -m <model> -r <port> -t 4533, then websockify 8769 127.0.0.1:4533'},
          {n:'baud',t:'select',opts:ROT_BAUD,d:'9600',label:'serial: baud (GS-232 9600, EasyComm 19200 / 115200)'},
          {n:'scan',t:'button',label:'⟳ Circular scan (level on lvl)',fn:n=>rtScanStart(n)},
          {n:'scanSpan',t:'range',min:30,max:360,step:10,d:360,label:'scan: sector, ° (from the current azimuth)'},
          {n:'scanStep',t:'range',min:2,max:45,step:1,d:10,label:'scan: step, °'},
          {n:'scanDwell',t:'range',min:.3,max:20,step:.1,d:1.5,label:'scan: dwell at each step, s'},
          {n:'scanGo',t:'check',d:true,label:'scan: turn to the best at the end'},
          {n:'centroid',t:'check',d:true,label:'scan: refine the best by the peak shape (not a bin centre)'},
          {n:'azMin',t:'range',min:-180,max:360,step:1,d:0,label:'limit: azimuth from, ° (a rotator with 450° travel: 0…450)',adv:true},
          {n:'azMax',t:'range',min:0,max:540,step:1,d:360,label:'limit: azimuth to, °',adv:true},
          {n:'elMin',t:'range',min:0,max:90,step:1,d:0,label:'limit: elevation from, °',adv:true},
          {n:'elMax',t:'range',min:0,max:180,step:1,d:90,label:'limit: elevation to, °',adv:true},
          {n:'poll',t:'select',opts:['0.5','1','2','5'],d:'2',label:'poll rate, Hz',adv:true},
          {n:'simRate',t:'range',min:1,max:60,step:1,d:12,label:'simulator: speed, °/s',adv:true},
          {n:'simBeam',t:'range',min:0,max:360,step:1,d:217,label:'simulator: azimuth of the virtual beacon for the scan, °',adv:true},
          {n:'reconnect',t:'check',d:true,label:'reconnect (websocket) after a drop',adv:true},
          {n:'auto',t:'check',d:false,label:'connect when the patch loads (websocket / simulator)',adv:true}],
  init:n=>{
    n.act={az:NaN,el:NaN,t:0}; n.cp=null; n.connected=false; n.want=false; n.q=null; n.tm=null; n.sim=null; n.status='not connected';
    n.sent=null; n.cmdDirty=false; n.scan=null; n.best=null; n.dirty=true; n.miss=0; n._inAz=undefined; n._inEl=undefined; n._sp=false; n._pk=false;
  },
  dispose:n=>{ rtStop(n); clearTimeout(n.retryT); },
  process(n,I){
    const p=n.p;
    if(!n._boot){ n._boot=true; if(p.auto && p.via!=='serial' && !n.connected) rtConnect(n); }
    if(p.follow && !n.scan){
      const az=typeof I.az==='number' && isFinite(I.az) ? I.az : undefined, el=typeof I.el==='number' && isFinite(I.el) ? I.el : undefined;
      if(az!==undefined && (n._inAz===undefined || Math.abs(rtDelta(n._inAz,az))>=.05)){ n._inAz=az; n._inEl=el; rtSetTarget(n,az,el); }
      else if(el!==undefined && el!==n._inEl){ n._inEl=el; rtSetTarget(n,undefined,el); }
    }
    const sp=+I.stop>.5, pk=+I.park>.5;
    if(sp && !n._sp) rtHalt(n);
    if(pk && !n._pk) rtPark(n);
    n._sp=sp; n._pk=pk;
    const sc=n.scan;
    let lv=typeof I.lvl==='number' && isFinite(I.lvl) ? I.lvl : NaN;
    if(!Number.isFinite(lv) && n.sim && Number.isFinite(n.act.az)) lv=rtSimBeam(n.act.az,+p.simBeam,22,1,Math.random());
    if(sc && sc.phase==='dwell') rtScanAdd(sc.bins[sc.i],lv);
    const a=n.act, t=rtTarget(n), live=n.connected && Number.isFinite(a.az);
    const mv=live && (Math.abs(rtDelta(a.az,t.az))>1.2 || (p.elOn && Math.abs(a.el-t.el)>1.2));
    return {az:live ? a.az : null, el:live && p.elOn ? a.el : null, taz:t.az, tel:p.elOn ? t.el : null, lvl:Number.isFinite(lv) ? lv : null, moving:mv?1:0, best:n.best ? n.best.az : null,
      text:live ? 'AZ '+a.az.toFixed(1)+'°'+(p.elOn ? ' EL '+a.el.toFixed(1)+'°' : '')+(mv ? ' → '+t.az.toFixed(1)+'°' : '') : n.status, on:n.connected?1:0};
  },
  drawKey:n=>(n.dirty?'d':'')+n.status+'|'+Math.round(n.act.az*10)+'|'+Math.round(n.act.el*10)+'|'+n.p.azT+'|'+n.p.elT+'|'+(n.scan?n.scan.i+n.scan.phase:'')+'|'+n.connected,
  draw(n,cv,cx){
    n.dirty=false; rtWire(n,cv);
    const W=cv.width, H=cv.height, p=n.p, a=n.act, d=rtDial(W,H), hi=themeColor('--scr-hi'), dim=themeColor('--axis'), pan=themeColor('--scr-panel');
    const R=a=>a*Math.PI/180, fs=Math.max(9,Math.min(13,d.r*.11));
    cx.clearRect(0,0,W,H); cx.textBaseline='middle'; cx.textAlign='center';
    cx.fillStyle=pan; cx.beginPath(); cx.arc(d.cx,d.cy,d.r,0,7); cx.fill();
    // запретный сектор: от azMax к azMin по часовой
    if(+p.azMax-+p.azMin<360-1e-6){
      cx.fillStyle=themeColor('--scr-bad'); cx.globalAlpha=.18; cx.beginPath(); cx.moveTo(d.cx,d.cy);
      cx.arc(d.cx,d.cy,d.r,R(rtNorm(+p.azMax)-90),R(rtNorm(+p.azMin)-90+(rtNorm(+p.azMin)<=rtNorm(+p.azMax)?360:0))); cx.closePath(); cx.fill(); cx.globalAlpha=1; }
    // результат скана: клинья от центра, длина — уровень
    const sc=n.scan;
    if(sc){
      const ms=sc.bins.map(rtBinMean).filter(Number.isFinite);
      if(ms.length){
        const lo=Math.min(...ms), hiV=Math.max(...ms), step=R(Math.max(2,+p.scanStep)/2);
        cx.fillStyle=themeColor('--acc2');
        sc.bins.forEach(b=>{ const m=rtBinMean(b); if(!Number.isFinite(m)) return;
          const len=d.r*(.12+.88*(hiV>lo ? (m-lo)/(hiV-lo) : .5)), c=R(b.az-90);
          cx.globalAlpha=.55; cx.beginPath(); cx.moveTo(d.cx,d.cy); cx.arc(d.cx,d.cy,len,c-step,c+step); cx.closePath(); cx.fill(); });
        cx.globalAlpha=1;
      }
    }
    // кольца и деления
    cx.strokeStyle=dim; cx.lineWidth=1; cx.globalAlpha=.6;
    cx.beginPath(); cx.arc(d.cx,d.cy,d.r,0,7); cx.stroke();
    if(p.elOn){ cx.globalAlpha=.25; for(const e of [30,60]){ cx.beginPath(); cx.arc(d.cx,d.cy,d.r*(1-e/90),0,7); cx.stroke(); } }
    cx.globalAlpha=.7; cx.beginPath();
    for(let g=0;g<360;g+=10){ const c=Math.sin(R(g)), s=-Math.cos(R(g)), l=g%30===0 ? 8 : 4; cx.moveTo(d.cx+c*d.r,d.cy+s*d.r); cx.lineTo(d.cx+c*(d.r-l),d.cy+s*(d.r-l)); }
    cx.stroke(); cx.globalAlpha=1;
    cx.fillStyle=dim; cx.font=fs+'px monospace';
    [['N',0],['E',90],['S',180],['W',270]].forEach(([t,g])=>cx.fillText(t,d.cx+Math.sin(R(g))*(d.r+9),d.cy-Math.cos(R(g))*(d.r+9)));
    // лучшее по скану
    const best=n.best; if(best){ const q=rtDialXY(d,best.az,0,false); cx.strokeStyle=themeColor('--scr-ok'); cx.lineWidth=2; cx.beginPath(); cx.moveTo(d.cx,d.cy); cx.lineTo(q.x,q.y); cx.stroke(); }
    // цель и положение
    const t=rtTarget(n), tp=rtDialXY(d,t.az,t.el,p.elOn);
    cx.strokeStyle=themeColor('--scr-warn'); cx.lineWidth=1.5; cx.setLineDash([4,3]); cx.beginPath(); cx.moveTo(d.cx,d.cy); cx.lineTo(tp.x,tp.y); cx.stroke(); cx.setLineDash([]);
    cx.beginPath(); cx.arc(tp.x,tp.y,5,0,7); cx.stroke();
    if(Number.isFinite(a.az)){
      const ap=rtDialXY(d,a.az,a.el,p.elOn), mv=Math.abs(rtDelta(a.az,t.az))>1.2;
      cx.strokeStyle=hi; cx.fillStyle=hi; cx.lineWidth=3; cx.beginPath(); cx.moveTo(d.cx,d.cy); cx.lineTo(ap.x,ap.y); cx.stroke();
      cx.beginPath(); cx.arc(ap.x,ap.y,mv?4:6,0,7); cx.fill();
    }
    cx.fillStyle=hi; cx.beginPath(); cx.arc(d.cx,d.cy,3,0,7); cx.fill();
    // числа
    cx.textAlign='left'; cx.font='bold '+Math.round(fs*1.6)+'px monospace';
    cx.fillText(Number.isFinite(a.az) ? a.az.toFixed(1)+'°' : '–',6,fs*1.2);
    if(p.elOn){ cx.font=Math.round(fs*1.2)+'px monospace'; cx.fillStyle=dim; cx.fillText(Number.isFinite(a.el) ? 'el '+a.el.toFixed(1)+'°' : 'el –',6,fs*3.1); }
    cx.textAlign='right'; cx.font=fs+'px monospace'; cx.fillStyle=themeColor('--scr-warn'); cx.fillText('→ '+t.az.toFixed(1)+'°'+(p.elOn ? ' / '+t.el.toFixed(1)+'°' : ''),W-6,fs*1.2);
    if(best){ cx.fillStyle=themeColor('--scr-ok'); cx.fillText('best '+best.az.toFixed(1)+'°',W-6,fs*2.7); }
    cx.textAlign='start'; cx.textBaseline='alphabetic';
    roText(n,n.status);
  }});
defGroups('rotator',[
  {n:'Aim',p:'azT elT n e s w m10 m1 p1 p10 elOn follow'},
  {n:'Circular scan',p:'scan scanSpan scanStep scanDwell scanGo centroid',open:false},
  {n:'Connection',p:'via proto url baud reconnect auto poll simRate simBeam',open:false},
  {n:'Limits',p:'azMin azMax elMin elMax',open:false}],{pri:'connect stopb azT'});
