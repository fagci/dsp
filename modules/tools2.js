"use strict";
/* ======================= ИНСТРУМЕНТЫ 2 (для телефона) =======================
   Дальномер, угломер, шумомер, экспонометр, детектор металла, калькулятор, солнце и луна, таймер, случайное, сирена, охрана.
   Помощники TLN / tlDeg / tlK — из tools.js, логика — в tools2-kernels.js. */

const t2Pad=(v,n)=>String(v).padStart(n,'0');
const t2Rng=()=>crypto.getRandomValues(new Uint32Array(1))[0];
const t2Rising=(n,key,v)=>{ const up=typeof v==='number' && v>=.5 && !n['_p'+key]; n['_p'+key]=typeof v==='number' && v>=.5; return up; };
// звук: в контексте движка (он уже разбужен), иначе свой
function t2Ctx(){
  const c=(typeof Eng!=='undefined' && Eng.ctx) || t2Ctx.own || (t2Ctx.own=new (window.AudioContext||window.webkitAudioContext)());
  if(c.state==='suspended') c.resume().catch(()=>{});
  return c;
}
function t2Beep(freq,ms,vol){
  try{
    const c=t2Ctx(), o=c.createOscillator(), g=c.createGain(), t=c.currentTime;
    o.type='sine'; o.frequency.value=freq; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vol,t+.01); g.gain.setValueAtTime(vol,t+ms/1000-.03); g.gain.linearRampToValueAtTime(0,t+ms/1000);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+ms/1000+.02);
  }catch(e){}
}

/* ---- дальномер ---- */
def({ id:'rangef', lazy:'proc', title:'Rangefinder', cat:'Tools', readout:true, tall:true, w:320,
  kw:'rangefinder distance range clinometer camera angle ground object size дальномер расстояние',
  ins:[{n:'el',t:'num'}], outs:[{n:'d',t:'num'}],
  params:[{n:'mode',t:'select',opts:['ground point','object size'],d:'ground point',
            label:'ground point: aim at the foot of the object, the distance comes from the angle down and your eye height · object size: you know its height, aim at its top and base'},
          {n:'eye',t:'num',d:1.6,label:'eye (phone) height, m',if:n=>n.p.mode==='ground point'},
          {n:'size',t:'num',d:2,label:'object height, m',if:n=>n.p.mode==='object size'},
          {n:'top',t:'button',label:'① top → mark',if:n=>n.p.mode==='object size',fn:n=>{ if(n.cur!==null) n.top=n.cur; }},
          {n:'base',t:'button',label:'② base → mark',if:n=>n.p.mode==='object size',fn:n=>{ if(n.cur!==null) n.base=n.cur; }},
          {n:'clr',t:'button',label:'clear marks',if:n=>n.p.mode==='object size',fn:n=>{ n.top=n.base=null; }}],
  init:n=>{ n.cur=null; n.top=null; n.base=null; n.d=null; },
  process(n,I){
    n.cur=TLN(I.el);
    n.d=n.p.mode==='ground point' ? (n.cur===null ? null : tsRangeGround(n.cur,+n.p.eye))
                                  : (n.top===null || n.base===null ? null : tsRangeSize(n.top,n.base,+n.p.size));
    return {d:n.d}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const s=[n.d!==null ? `distance ${n.d.toFixed(1)} m  (${(n.d*3.28084).toFixed(0)} ft)` : 'distance —', `angle now ${n.cur!==null ? tlDeg(n.cur) : '—'}`];
    if(n.p.mode==='object size') s.push(`top ${n.top!==null ? tlDeg(n.top) : '—'} · base ${n.base!==null ? tlDeg(n.base) : '—'}`);
    if(n.cur===null) s.push('wire Orientation → el');
    else if(n.p.mode==='ground point' && n.d===null) s.push('aim lower: the point must be below the horizon');
    r.textContent=s.join('\n'); }});

/* ---- угломер / теодолит ---- */
def({ id:'protractor', lazy:'proc', title:'Protractor (angle between two points)', cat:'Tools', readout:true, tall:true, w:320,
  kw:'protractor theodolite angle between azimuth elevation bearing sextant угломер теодолит угол',
  ins:[{n:'az',t:'num'},{n:'el',t:'num'}], outs:[{n:'angle',t:'num'},{n:'dAz',t:'num'},{n:'dEl',t:'num'}],
  params:[{n:'a',t:'button',label:'① point A → mark',fn:n=>{ if(n.ca!==null && n.ce!==null) n.A=[n.ca,n.ce]; }},
          {n:'b',t:'button',label:'② point B → mark',fn:n=>{ if(n.ca!==null && n.ce!==null) n.B=[n.ca,n.ce]; }},
          {n:'clr',t:'button',label:'clear marks',fn:n=>{ n.A=n.B=null; }}],
  init:n=>{ n.ca=null; n.ce=null; n.A=null; n.B=null; n.r=null; },
  process(n,I){
    n.ca=TLN(I.az); n.ce=TLN(I.el);
    const to=n.B || (n.ca!==null && n.ce!==null ? [n.ca,n.ce] : null);
    n.r=n.A && to ? tsAngle3(n.A[0],n.A[1],to[0],to[1]) : null;
    return {angle:n.r?n.r.angle:null, dAz:n.r?n.r.dAz:null, dEl:n.r?n.r.dEl:null}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const f=a=>a ? `az ${a[0].toFixed(1)}° el ${a[1].toFixed(1)}°` : '—';
    r.textContent=[n.r ? `angle ${n.r.angle.toFixed(1)}°` : 'angle —', n.r ? `Δ azimuth ${n.r.dAz.toFixed(1)}° · Δ elevation ${n.r.dEl.toFixed(1)}°` : '',
      `A ${f(n.A)}`, `B ${n.B ? f(n.B) : n.A ? '(live) '+f(n.ca!==null && n.ce!==null ? [n.ca,n.ce] : null) : '—'}`,
      n.ca===null ? 'wire Orientation → az, el' : ''].filter(Boolean).join('\n'); }});

/* ---- шумомер ---- */
def({ id:'spl', lazy:'proc', title:'Sound Level Meter', cat:'Tools', fs:true, resize:true, view:{h:130}, w:340, readout:true,
  kw:'sound level meter decibel dba spl noise loudness microphone шумомер децибел шум',
  ins:[{n:'in',t:'sig'}], outs:[{n:'db',t:'num'},{n:'leq',t:'num'},{n:'max',t:'num'}],
  params:[{n:'weight',t:'select',opts:['A','Z'],d:'A',label:'A: like the ear (dBA) · Z: flat'},
          {n:'speed',t:'select',opts:['fast','slow'],d:'fast',label:'fast 125 ms · slow 1 s'},
          {n:'offset',t:'num',d:100,label:'dB SPL at digital full scale (0 dBFS) — calibrate!'},
          {n:'ref',t:'num',d:94,label:'calibrator level, dB (94 dB at 1 kHz)'},
          {n:'cal',t:'button',label:'Calibrate: current reading = the level above',fn:n=>{ if(n.live) setMod(n,'offset',+(n.p.ref-(n.dbFS??-200)).toFixed(1)); }},
          {n:'reset',t:'button',label:'Reset max / Leq',fn:n=>{ if(n.M) tsMeterReset(n.M); n.hist=[]; }}],
  init:n=>{ n.M=null; n.key=''; n.live=false; n.dbFS=null; n.hist=[]; n.hT=0; },
  process(n,I){
    const key=n.p.weight+n.p.speed+Eng.sr;
    if(!n.M || n.key!==key){ n.M=tsMeterNew(Eng.sr,n.p.weight,n.p.speed==='slow' ? 1 : .125); n.key=key; }
    n.live=!!I.in;
    if(I.in){ n.dbFS=tsMeterPush(n.M,I.in);
      const t=performance.now(); if(t-n.hT>250){ n.hT=t; n.hist.push(n.dbFS+ +n.p.offset); if(n.hist.length>240) n.hist.shift(); } }
    const o=+n.p.offset, M=n.M;
    return n.live ? {db:n.dbFS+o, leq:tsLeq(M)+o, max:isFinite(M.max) ? M.max+o : null} : {db:null,leq:null,max:null}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, r=n.el.querySelector('.readout'), o=+n.p.offset;
    cx.fillStyle=themeColor('--screen'); cx.fillRect(0,0,W,H);
    if(!n.live){ indFont(cx,13); cx.fillStyle=themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillText('wire a microphone → in',W/2,H/2); if(r) r.textContent=''; return; }
    const db=n.dbFS+o, lo=30, hi=130, fr=Math.max(0,Math.min(1,(db-lo)/(hi-lo)));
    const col=db<70 ? themeColor('--scr-ok') : db<85 ? themeColor('--scr-warn') : themeColor('--err');
    const f=Math.max(14,Math.min(H*.36,W*.14));
    cx.textAlign='left'; cx.textBaseline='middle'; cx.fillStyle=col; indFont(cx,f*1.5); cx.fillText(db.toFixed(1),10,H*.3);
    indFont(cx,f*.5); cx.fillStyle=themeColor('--axis'); cx.fillText('dB'+(n.p.weight==='A' ? '(A)' : '')+' SPL',10+f*3.6,H*.34);
    const bx=10, bw=W-20, by=H*.55;                               // шкала 30…130 дБ
    cx.fillStyle=themeColor('--grid'); cx.fillRect(bx,by,bw,8); cx.fillStyle=col; cx.fillRect(bx,by,bw*fr,8);
    if(isFinite(n.M.max)){ const mx=Math.max(0,Math.min(1,(n.M.max+o-lo)/(hi-lo))); cx.fillStyle=themeColor('--scr-hi'); cx.fillRect(bx+bw*mx-1,by-3,2,14); }
    const gy=H*.68, gh=H*.3;                                      // история 60 с
    cx.strokeStyle=themeColor('--acc'); cx.lineWidth=1.5; cx.beginPath();
    n.hist.forEach((v,i)=>{ const x=bx+bw*i/239, y=gy+gh*(1-Math.max(0,Math.min(1,(v-lo)/(hi-lo)))); i ? cx.lineTo(x,y) : cx.moveTo(x,y); }); cx.stroke();
    if(r) r.textContent=`Leq ${(tsLeq(n.M)+o).toFixed(1)} · max ${isFinite(n.M.max) ? (n.M.max+o).toFixed(1) : '—'} · peak ${(20*Math.log10(n.M.peak||1e-10)+o).toFixed(1)} dB`; }});

/* ---- экспонометр ---- */
def({ id:'exposure', lazy:'proc', title:'Light Meter (exposure)', cat:'Tools', readout:true, tall:true, w:320,
  kw:'light meter exposure lux ev aperture shutter iso photography экспонометр выдержка диафрагма',
  ins:[{n:'lux',t:'num'}], outs:[{n:'ev',t:'num'},{n:'t',t:'num'},{n:'N',t:'num'}],
  params:[{n:'lux',t:'num',d:1000,label:'illuminance, lux (the pin from Ambient Light wins)'},
          {n:'iso',t:'select',opts:['50','100','200','400','800','1600','3200','6400'],d:'100'},
          {n:'solve',t:'select',opts:['shutter','aperture'],d:'shutter',label:'find'},
          {n:'N',t:'select',opts:['1.4','2','2.8','4','5.6','8','11','16','22'],d:'5.6',label:'aperture f/',if:n=>n.p.solve==='shutter'},
          {n:'t',t:'select',opts:['1/2000','1/1000','1/500','1/250','1/125','1/60','1/30','1/15','1/8','1/4','1/2','1'],d:'1/125',label:'shutter, s',if:n=>n.p.solve==='aperture'}],
  init:n=>{ n.r=null; },
  process(n,I){
    const lux=TLN(I.lux)!==null ? I.lux : +n.p.lux, ev=tsEv(lux), iso=+n.p.iso; n.r=null;
    if(ev===null) return {ev:null,t:null,N:null};
    if(n.p.solve==='shutter'){ const N=+n.p.N, t=tsShutter(ev,N,iso); n.r={lux,ev,t,N}; }
    else { const [a,b]=n.p.t.split('/'), t=b ? +a/+b : +a, N=tsAperture(ev,t,iso); n.r={lux,ev,t,N}; }
    return {ev,t:n.r.t,N:n.r.N}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return; const q=n.r;
    r.textContent=q ? `${tlFmt(+q.lux.toFixed(1))} lux · EV ${q.ev.toFixed(1)} (ISO 100)\nISO ${n.p.iso} · f/${q.N.toFixed(1)} · ${tsFmtShutter(q.t)}\nincident light, mid-grey; for a bright / dark subject ±1–2 EV` : 'no light value'; }});

/* ---- детектор металла (магнитометр) ---- */
def({ id:'magdet', lazy:'proc', title:'Metal Detector (magnetometer)', cat:'Tools', resize:true, view:{h:90}, w:320, readout:true,
  kw:'metal detector magnetometer magnetic field uT wires rebar stud finder металлоискатель магнитометр',
  ins:[{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}], outs:[{n:'b',t:'num'},{n:'delta',t:'num'},{n:'alert',t:'num'}],
  params:[{n:'tau',t:'range',min:1,max:20,step:.5,d:5,label:'the reference follows the field, s (longer — slower to forget a find)'},
          {n:'thr',t:'range',min:.5,max:50,step:.5,d:5,label:'alert at a change of, µT'},
          {n:'zero',t:'button',label:'Zero here (take the field as the reference)',fn:n=>{ n.G.base=n.G.b; }}],
  init:n=>{ n.G=tsMagNew(); n.has=false; n.alert=0; },
  process(n,I){
    const x=TLN(I.x), y=TLN(I.y), z=TLN(I.z); n.has=x!==null && y!==null && z!==null;
    if(!n.has) return {b:null,delta:null,alert:0};
    tsMagStep(n.G,performance.now()/1000,Math.hypot(x,y,z),+n.p.tau);
    n.alert=Math.abs(n.G.delta)>+n.p.thr ? 1 : 0;
    return {b:n.G.b,delta:n.G.delta,alert:n.alert}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, r=n.el.querySelector('.readout');
    cx.fillStyle=themeColor('--screen'); cx.fillRect(0,0,W,H);
    if(!n.has){ indFont(cx,13); cx.fillStyle=themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillText('wire Sensor (Generic) Magnetometer → x y z',W/2,H/2); if(r) r.textContent=''; return; }
    const span=+n.p.thr*2, d=Math.max(-span,Math.min(span,n.G.delta)), cxm=W/2, bh=H*.3, y0=H*.35;
    cx.strokeStyle=themeColor('--axis'); cx.lineWidth=1; cx.strokeRect(8,y0,W-16,bh);
    cx.fillStyle=n.alert ? themeColor('--err') : themeColor('--scr-ok'); const bw=(W/2-8)*d/span;
    cx.fillRect(bw>=0 ? cxm : cxm+bw,y0+2,Math.abs(bw),bh-4);
    cx.strokeStyle=themeColor('--scr-hi'); cx.beginPath(); cx.moveTo(cxm,y0-4); cx.lineTo(cxm,y0+bh+4); cx.stroke();
    cx.fillStyle=n.alert ? themeColor('--err') : themeColor('--scr-hi'); indFont(cx,Math.max(11,H*.16)); cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillText((n.G.delta>=0 ? '+' : '')+n.G.delta.toFixed(1)+' µT'+(n.alert ? '  ⚠' : ''),W/2,H*.82);
    if(r) r.textContent=`|B| ${n.G.b.toFixed(1)} µT · reference ${n.G.base.toFixed(1)} µT`; }});

/* ---- калькулятор ---- */
def({ id:'calc', lazy:'proc', title:'Calculator', cat:'Tools', readout:true, w:320,
  kw:'calculator expression formula math evaluate калькулятор выражение формула',
  ins:[{n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'}], outs:[{n:'out',t:'num'},{n:'text',t:'txt'}],
  params:[{n:'expr',t:'text',d:'round(a*b/(c+1),2)',label:'expression: a b c d, + - * / %, ( ), functions as in Table (round sqrt pow min max abs if convert…)'},
          {n:'a',t:'num',d:2,label:'a (the pin wins)'},{n:'b',t:'num',d:3,label:'b'},{n:'c',t:'num',d:4,label:'c'},{n:'d',t:'num',d:0,label:'d'}],
  init:n=>{ n.v=''; n.err=''; },
  process(n,I){
    const row={}; for(const k of ['a','b','c','d']) row[k]=TLN(I[k])!==null ? I[k] : +n.p[k];
    n.err=''; n.v='';
    try{ const v=trCompile(n.p.expr)(row); n.v=v===undefined || (typeof v==='number' && !isFinite(v)) ? '' : v; }
    catch(e){ n.err=e.message; }
    return {out:typeof n.v==='number' ? n.v : (n.v!=='' && isFinite(Number(n.v)) ? Number(n.v) : null), text:String(n.v)}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.err ? '✗ '+n.err : (n.v==='' ? 'empty result (a value is missing or ÷0)' : `= ${typeof n.v==='number' ? tlFmt(n.v) : n.v}`); }});

/* ---- солнце и луна ---- */
def({ id:'sunmoon', lazy:'proc', title:'Sun & Moon', cat:'Tools', readout:true, tall:true, w:340,
  kw:'sun moon sunrise sunset solar elevation azimuth daylight golden hour moon phase солнце луна восход закат фаза',
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'}], outs:[{n:'el',t:'num'},{n:'az',t:'num'},{n:'day',t:'num'},{n:'moon',t:'num'}],
  params:[{n:'lat',t:'num',d:55.0375,label:'latitude (the pin wins)'},{n:'lon',t:'num',d:82.925,label:'longitude, east +'}],
  init:n=>{ n.k=''; n.t=0; n.o=null; n.txt=''; },
  process(n,I){
    const lat=TLN(I.lat)!==null ? I.lat : +n.p.lat, lon=TLN(I.lon)!==null ? I.lon : +n.p.lon, now=Date.now();
    if(!n.o || now-n.t>1000 || n.k!==lat+','+lon){
      n.t=now; n.k=lat+','+lon;
      if(!(Math.abs(lat)<=90 && Math.abs(lon)<=180)){ n.o=null; n.txt='latitude / longitude?'; }
      else {
        const s=tsSun(now,lat,lon), m=tsMoon(now), hm=ms=>ms===null ? '—' : new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        const gold=s.rise===null ? '' : `golden hour until ${hm(s.rise+3600000)} and from ${hm(s.set-3600000)}`;
        n.o={s,m};
        n.txt=[`sun ${s.el>=0 ? 'above' : 'below'} the horizon: elevation ${s.el.toFixed(1)}°, azimuth ${s.az.toFixed(0)}°`,
          s.polar==='day' ? 'polar day: the sun does not set' : s.polar==='night' ? 'polar night: the sun does not rise' : `sunrise ${hm(s.rise)} · noon ${hm(s.noon)} · sunset ${hm(s.set)}`,
          s.polar ? '' : `day length ${Math.floor(s.dayLen)} h ${t2Pad(Math.round((s.dayLen%1)*60),2)} min · ${gold}`,
          `moon: ${m.name}, ${m.illum.toFixed(0)} % lit, age ${m.age.toFixed(1)} d`, `next full moon in ${m.toFull.toFixed(1)} d, new moon in ${m.toNew.toFixed(1)} d`,
          '(times in the device time zone; no atmospheric refraction, moon by the mean cycle ±0.5 d)'].filter(Boolean).join('\n'); } }
    const o=n.o; return o ? {el:o.s.el,az:o.s.az,day:o.s.dayLen,moon:o.m.illum} : {el:null,az:null,day:null,moon:null}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.txt; }});

/* ---- таймер ---- */
def({ id:'timer', lazy:'proc', title:'Timer', cat:'Tools', fs:true, resize:true, view:{h:110}, w:320,
  kw:'timer countdown alarm kitchen interval таймер обратный отсчёт',
  ins:[{n:'start',t:'num'}], outs:[{n:'left',t:'num'},{n:'frac',t:'num'},{n:'done',t:'num'}],
  params:[{n:'min',t:'num',d:5,label:'minutes'},{n:'sec',t:'num',d:0,label:'seconds'},
          {n:'repeat',t:'check',d:false,label:'start again by itself'},
          {n:'sound',t:'check',d:true,label:'beep and vibrate at the end'},
          {n:'go',t:'button',label:'Start / pause',fn:n=>t2TimerToggle(n)},
          {n:'reset',t:'button',label:'Reset',fn:n=>{ n.run=false; n.left=t2TimerTotal(n); }}],
  init:n=>{ n.run=false; n.left=null; n.last=0; n.until=0; },
  process(n,I){
    const tot=t2TimerTotal(n), now=performance.now();
    if(n.left===null) n.left=tot;
    if(t2Rising(n,'start',I.start)) t2TimerToggle(n);
    if(n.run){
      n.left-=(now-n.last)/1000;
      if(n.left<=0){
        n.until=now+3000;
        if(n.p.sound){ t2Beep(880,250,.4); setTimeout(()=>t2Beep(880,250,.4),400); setTimeout(()=>t2Beep(1320,500,.4),800); try{ navigator.vibrate?.([300,150,300,150,500]); }catch(e){} }
        if(n.p.repeat) n.left=tot; else { n.run=false; n.left=0; } }
    }
    n.last=now; n.tot=tot;
    return {left:Math.max(0,n.left),frac:tot>0 ? Math.max(0,n.left)/tot : 0,done:now<n.until ? 1 : 0}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, left=Math.max(0,n.left??0), tot=n.tot||1, flash=performance.now()<n.until && Math.floor(performance.now()/250)%2===0;
    cx.fillStyle=flash ? themeColor('--err') : themeColor('--screen'); cx.fillRect(0,0,W,H);
    const s=Math.ceil(left), t=s>=3600 ? `${Math.floor(s/3600)}:${t2Pad(Math.floor(s/60)%60,2)}:${t2Pad(s%60,2)}` : `${t2Pad(Math.floor(s/60),2)}:${t2Pad(s%60,2)}`;
    cx.fillStyle=flash ? '#fff' : n.run ? themeColor('--scr-hi') : themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
    indFont(cx,Math.min(H*.5,W/(t.length*.62))); cx.fillText(t,W/2,H*.45);
    cx.fillStyle=themeColor('--grid'); cx.fillRect(10,H-16,W-20,6); cx.fillStyle=themeColor('--acc'); cx.fillRect(10,H-16,(W-20)*left/tot,6);
    indFont(cx,Math.max(9,H*.1)); cx.fillStyle=themeColor('--axis'); cx.fillText(n.run ? 'running — tap Start / pause' : left<=0 ? 'done' : 'paused',W/2,H-30); }});
const t2TimerTotal=n=>Math.max(1,(+n.p.min||0)*60+(+n.p.sec||0));
function t2TimerToggle(n){
  if(n.run){ n.run=false; return; }
  if(n.left===null || n.left<=0) n.left=t2TimerTotal(n);
  n.run=true; n.last=performance.now();
}

/* ---- случайное ---- */
function t2Gen(n){
  const p=n.p, r=t2Rng; let res='', num=null;
  if(p.kind==='dice'){ const x=tsRoll(r,p.expr); if(x){ num=x.total; res=`${x.total}`+(x.rolls.length>1 || x.mod ? `  (${x.rolls.join(' + ')}${x.mod ? (x.mod>0 ? ' + ' : ' − ')+Math.abs(x.mod) : ''})` : ''); } else res='dice as 2d6+3, d20'; }
  else if(p.kind==='coin'){ const h=tsRandInt(r,2); num=h; res=h ? 'heads' : 'tails'; }
  else if(p.kind==='number'){ const lo=Math.round(+p.min), hi=Math.round(+p.max); if(hi>=lo && hi-lo<4294967295){ num=lo+tsRandInt(r,hi-lo+1); res=String(num); } else res='min ≤ max?'; }
  else if(p.kind==='password'){ res=tsPassword(r,+p.len,['lower','upper','digits','symbols'].filter(k=>p[k])); if(!res) res='pick at least one set'; }
  else res=tsPick(r,p.list)||'the list is empty';
  n.res=res; n.num=num; n.cnt++; n.log.unshift(res); if(n.log.length>5) n.log.pop();
}
def({ id:'rand', lazy:'proc', title:'Random (dice, coin, password)', cat:'Tools', readout:true, tall:true, w:320,
  kw:'random dice coin number password generator pick choose draw lottery случайное кубик монетка пароль',
  ins:[{n:'go',t:'num'}], outs:[{n:'num',t:'num'},{n:'text',t:'txt'}],
  params:[{n:'kind',t:'select',opts:['dice','coin','number','password','pick from list'],d:'dice'},
          {n:'expr',t:'text',d:'2d6',label:'dice: NdS±M, e.g. 2d6+3, d20',if:n=>n.p.kind==='dice'},
          {n:'min',t:'num',d:1,if:n=>n.p.kind==='number'},{n:'max',t:'num',d:100,if:n=>n.p.kind==='number'},
          {n:'len',t:'range',min:4,max:64,step:1,d:16,label:'length',if:n=>n.p.kind==='password'},
          {n:'lower',t:'check',d:true,label:'a–z',if:n=>n.p.kind==='password'},{n:'upper',t:'check',d:true,label:'A–Z',if:n=>n.p.kind==='password'},
          {n:'digits',t:'check',d:true,label:'0–9',if:n=>n.p.kind==='password'},{n:'symbols',t:'check',d:false,label:'symbols',if:n=>n.p.kind==='password'},
          {n:'list',t:'text',d:'pizza\nsushi\nburger',label:'one per line',if:n=>n.p.kind==='pick from list'},
          {n:'gen',t:'button',label:'Generate',fn:n=>t2Gen(n)}],
  init:n=>{ n.res=''; n.num=null; n.cnt=0; n.log=[]; },
  process(n,I){ if(t2Rising(n,'go',I.go)) t2Gen(n); return {num:n.num,text:n.res}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.res ? n.res+(n.log.length>1 ? '\n— earlier: '+n.log.slice(1).join(' · ') : '')+'\n(system random: crypto.getRandomValues)' : 'press Generate'; }});

/* ---- сирена ---- */
function t2SirenStop(n){
  if(n.au){ try{ n.au.nodes.forEach(x=>{ try{ x.stop?.(); }catch(e){} try{ x.disconnect(); }catch(e){} }); }catch(e){} n.au=null; }
}
function t2SirenStart(n){
  const c=t2Ctx(), o=c.createOscillator(), g=c.createGain(), out=c.createGain(), nodes=[o,g,out], k=n.p.sound;
  const lfo=(type,hz,depth,target)=>{ const l=c.createOscillator(), d=c.createGain(); l.type=type; l.frequency.value=hz; d.gain.value=depth; l.connect(d); d.connect(target); l.start(); nodes.push(l,d); };
  o.type=k==='beeps' || k==='continuous' ? 'square' : 'sawtooth'; g.gain.value=1;
  if(k==='siren'){ o.frequency.value=1000; lfo('sine',.6,450,o.frequency); }
  else if(k==='two-tone'){ o.frequency.value=900; lfo('square',1.6,260,o.frequency); }
  else if(k==='beeps'){ o.frequency.value=2200; g.gain.value=.5; lfo('square',4,.5,g.gain); }
  else o.frequency.value=1000;
  out.gain.value=+n.p.vol; o.connect(g); g.connect(out); out.connect(c.destination); o.start();
  n.au={nodes,out};
}
def({ id:'siren', lazy:'proc', title:'Alarm Siren', cat:'Tools', fs:true, resize:true, view:{h:90}, w:300, readout:true,
  kw:'siren alarm alert beacon flash loud police sound сирена тревога сигнал',
  ins:[{n:'on',t:'num'}],
  params:[{n:'on',t:'check',d:false,label:'on'},
          {n:'sound',t:'select',opts:['siren','two-tone','beeps','continuous'],d:'siren'},
          {n:'vol',t:'range',min:0,max:1,step:.01,d:.5,label:'volume (the phone volume is also in play)'},
          {n:'flash',t:'check',d:true,label:'red / white screen flashing (double-click for fullscreen)'}],
  init:n=>{ n.au=null; },
  onStop:n=>t2SirenStop(n),
  dispose:n=>t2SirenStop(n),
  process(n,I){
    if(typeof I.on==='number') setMod(n,'on',I.on>=.5);
    if(n.p.on && !n.au) { try{ t2SirenStart(n); }catch(e){ n.err=e.message; } }
    else if(!n.p.on && n.au) t2SirenStop(n);
    if(n.au) n.au.out.gain.value=+n.p.vol;
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, on=!!n.p.on, ph=Math.floor(performance.now()/250)%2===0;
    cx.fillStyle=on && n.p.flash ? (ph ? '#d22' : '#fff') : themeColor('--screen'); cx.fillRect(0,0,W,H);
    cx.fillStyle=on ? (ph && n.p.flash ? '#fff' : '#d22') : themeColor('--axis'); cx.textAlign='center'; cx.textBaseline='middle';
    indFont(cx,Math.min(H*.4,W*.14)); cx.fillText(on ? '⚠ ALARM' : 'off',W/2,H/2);
    const r=n.el.querySelector('.readout'); if(r) r.textContent=n.err || (on ? 'sounding' : 'off — tick «on» (the graph has to be running)'); }});

/* ---- охрана телефона ---- */
def({ id:'guard', lazy:'proc', title:'Motion Guard (phone alarm)', cat:'Tools', resize:true, view:{h:100}, w:320, readout:true,
  kw:'guard alarm theft motion movement anti-theft protect phone accelerometer охрана сигнализация движение',
  ins:[{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}], outs:[{n:'alarm',t:'num'},{n:'armed',t:'num'}],
  params:[{n:'delay',t:'num',d:5,label:'delay before arming, s (put the phone down)'},
          {n:'sens',t:'range',min:.2,max:5,step:.1,d:.8,label:'trigger: change of the acceleration vector, m/s²'},
          {n:'hold',t:'range',min:.05,max:1,step:.05,d:.15,label:'it has to last, s'},
          {n:'arm',t:'button',label:'Arm',fn:n=>tsGuardArm(n.G,performance.now()/1000)},
          {n:'off',t:'button',label:'Disarm / reset',fn:n=>tsGuardOff(n.G)}],
  init:n=>{ n.G=tsGuardNew(); n.has=false; n.vib=false; },
  process(n,I){
    const x=TLN(I.x), y=TLN(I.y), z=TLN(I.z); n.has=x!==null && y!==null && z!==null;
    const G=n.G, t=performance.now()/1000;
    if(n.has) tsGuardStep(G,t,[x,y,z],{delay:+n.p.delay,sens:+n.p.sens,hold:+n.p.hold});
    if(G.state==='alarm' && !n.vib){ n.vib=true; try{ navigator.vibrate?.([500,200,500,200,500]); }catch(e){} }
    if(G.state!=='alarm') n.vib=false;
    return {alarm:G.state==='alarm' ? 1 : 0, armed:G.state==='armed' || G.state==='alarm' ? 1 : 0}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, G=n.G, r=n.el.querySelector('.readout');
    const flash=G.state==='alarm' && Math.floor(performance.now()/250)%2===0;
    cx.fillStyle=flash ? themeColor('--err') : themeColor('--screen'); cx.fillRect(0,0,W,H);
    const left=Math.max(0,+n.p.delay-(performance.now()/1000-G.t0));
    const txt=G.state==='off' ? 'DISARMED' : G.state==='arming' ? `arming in ${Math.ceil(left)}…` : G.state==='armed' ? 'ARMED' : '⚠ MOVED';
    cx.fillStyle=G.state==='armed' ? themeColor('--scr-ok') : G.state==='arming' ? themeColor('--scr-warn') : G.state==='alarm' ? (flash ? '#fff' : themeColor('--err')) : themeColor('--axis');
    cx.textAlign='center'; cx.textBaseline='middle'; indFont(cx,Math.min(H*.4,W*.12)); cx.fillText(txt,W/2,H/2);
    if(r) r.textContent=n.has ? `change ${G.delta.toFixed(2)} m/s²` : 'wire accel → x y z (with gravity)'; }});
