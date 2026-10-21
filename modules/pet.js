"use strict";
/* ============================ Aether Pet ============================
   Питомец живёт в ядре: включается галочкой в настройках и после этого активен всегда, пока работает хотя бы один
   Signal Type Identifier (он кормит питомца метками и не пропускается как «неиспользуемый»). Модуль «Aether Pet» —
   только окно к нему: рисует организм, показывает слова и позволяет сменить задание. Ядро — pet-kernels.js (node tools/test-pet.mjs). */

const PET_KEY='dsp-pet', PET_ON_KEY='dsp-pet-on', PET_LOG_MAX=60, PET_SCAN_MS=20000, PET_SAVE_MS=5000;
const Pet={
  on:false, st:petNew(), inv:[], log:[], n:0,                    // log — события для модулей, n — сколько их было всего
  labels:[], live:0, nag:'', line:'', lastFeed:0, flash:0, evText:'', evT:0, dirty:false, scanT:0,
  load(){
    try{ const d=JSON.parse(localStorage.getItem(PET_KEY)||'null'); if(d) petLoad(this.st,d); }catch(e){}
    this.st.lastGain=performance.now();
  },
  save(){ if(!this.dirty) return; this.dirty=false; try{ localStorage.setItem(PET_KEY,JSON.stringify(petSave(this.st))); }catch(e){} },
  setOn(on){
    this.on=!!on;
    try{ localStorage.setItem(PET_ON_KEY,on ? '1' : ''); }catch(e){}
    if(on){ this.st.lastGain=performance.now(); this.scan(); }
    if(typeof markTopoDirty==='function') markTopoDirty();        // sigid больше не «неиспользуемый»
    ptInfo();
  },
  reset(){ const name=this.st.name; this.st=petNew(name); this.st.lastGain=performance.now(); this.log=[]; this.dirty=true; this.save(); this.refresh(); },
  // метки sigid → находки, события и слова
  feed(labels){
    if(!this.on) return;
    const now=performance.now();
    this.lastFeed=now; this.labels=labels||[]; this.live=this.labels.length;
    const ev=petFrame(this.st,this.labels,now,this.inv,{});
    this.nag=petNag(this.st,this.labels);
    if(ev.length) this.push(ev);
    this.refresh();
  },
  push(ev){
    const now=performance.now();
    for(const e of ev){
      this.n++; this.log.push({t:Date.now(),...e});
      if(e.kind!=='gear') this.flash=1;
    }
    if(this.log.length>PET_LOG_MAX) this.log.splice(0,this.log.length-PET_LOG_MAX);
    this.evText=petSay(this.st,this.inv,ev,'',now,this.live); this.evT=now;
    this.dirty=true;
    ptToast(this.evText);
  },
  refresh(){
    const now=performance.now(), s=this.st;
    if(now-this.evT<9000 && this.evText) this.line=this.evText;
    else if(this.inv.length && now-this.lastFeed>20000) this.line='I sense nothing. Add a Signal Type Identifier to the graph and give it a spectrum (USB SDR → Spectrum Analyzer works) or a microphone.';
    else this.line=petSay(s,this.inv,[],this.nag,now,this.live);
  },
  async scan(){
    const nav=navigator, flags={}, usb=[], ser=[];
    try{ if(nav.usb) for(const d of await nav.usb.getDevices()) usb.push({vendorId:d.vendorId,productId:d.productId}); }catch(e){}
    try{ if(nav.serial) for(const p of await nav.serial.getPorts()){ const i=p.getInfo(); ser.push({vendorId:i.usbVendorId,productId:i.usbProductId}); } }catch(e){}
    try{ const md=await nav.mediaDevices.enumerateDevices(); flags.audio=md.some(x=>x.kind==='audioinput'); flags.camera=md.some(x=>x.kind==='videoinput'); }catch(e){}
    flags.ble=!!nav.bluetooth; flags.nfc='NDEFReader' in window; flags.hid=!!nav.hid;
    try{ flags.gamepad=Array.from(nav.getGamepads ? nav.getGamepads() : []).some(g=>g && g.connected); }catch(e){}
    flags.motion=matchMedia('(pointer:coarse)').matches && 'DeviceMotionEvent' in window;
    this.inv=petDevices(usb,ser,flags);
    const gear=petNewGear(this.st,this.inv);
    if(gear.length){ this.dirty=true; if(this.on) this.push(gear); }
    this.refresh();
  },
  skip(){ const q=petPick(this.st,this.inv); if(q){ this.st.skip[q.id]=1; this.dirty=true; this.refresh(); } },
  unskip(){ this.st.skip={}; this.dirty=true; this.refresh(); },
  quest(){ return this.inv.length ? petPick(this.st,this.inv) : null; },
};
function ptToast(text){
  if(typeof showToast!=='function') return;
  showToast(text);
  if(typeof toastTimer!=='undefined'){ clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl && toastEl.classList.remove('show'),4500); }
}
function ptInfo(){
  const el=document.getElementById('petInfo'); if(!el) return;
  const l=petLevel(Pet.st.xp), t=Pet.on ? Pet.st.name+' · Lv '+l.lv+' · '+Pet.st.xp+' xp' : 'asleep';
  if(el.textContent!==t) el.textContent=t;
}
(()=>{
  try{ Pet.load(); Pet.on=localStorage.getItem(PET_ON_KEY)==='1'; }catch(e){}
  const cb=document.getElementById('petOn');
  if(cb){ cb.checked=Pet.on; cb.onchange=()=>Pet.setOn(cb.checked); }
  if(navigator.usb && navigator.usb.addEventListener){ for(const t of ['connect','disconnect']) navigator.usb.addEventListener(t,()=>{ if(Pet.on) Pet.scan(); }); }
  Pet.scan();
  setInterval(()=>{ if(Pet.on){ Pet.scan(); } },PET_SCAN_MS);
  setInterval(()=>{ if(Pet.on) Pet.refresh(); Pet.save(); ptInfo(); },PET_SAVE_MS/2);
  addEventListener('pagehide',()=>{ Pet.dirty=true; Pet.save(); });
  ptInfo();
})();

/* ---- окно питомца: эфирное существо, сотканное из сигнала ----
   Голова окружена радиальным спектром: пики находок — корона, живые сигналы — всплески, глаза следят за самым сильным.
   Рот — waveform «голоса» (сумма найденных классов), хвост — ленты-волны этих классов. Устройства кружат вокруг,
   полоса внизу — горизонты (открытые яркие). Форма растёт с уровнем: шум → тон → аккорд → спектр. */
const PT_KIND_HUE={sdr:200,audio:50,camera:280,ble:225,nfc:160,hid:100,gamepad:320,motion:20,board:140};
const ptHue=s=>{ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))%360; return h; };
const ptHsl=(h,s,l,a)=>'hsla('+(((h%360)+360)%360).toFixed(0)+','+s+'%,'+l+'%,'+(a==null ? 1 : a)+')';
function ptWrap(cx,text,w,maxLines){
  const words=String(text).split(/\s+/), lines=[]; let cur='';
  for(const word of words){
    const t=cur ? cur+' '+word : word;
    if(cx.measureText(t).width>w && cur){ lines.push(cur); cur=word; } else cur=t;
  }
  if(cur) lines.push(cur);
  if(lines.length>maxLines){ lines.length=maxLines; lines[maxLines-1]=lines[maxLines-1].replace(/\s*\S*$/,'')+'…'; }
  return lines;
}
// ось: слева короткий отрезок «audio» (20 Гц … 20 кГц), дальше радио 100 кГц … 6 ГГц в логарифме
const PT_AU=.07, PT_F0=Math.log10(1e5), PT_F1=Math.log10(6e9);
const ptPos=(f,rf)=>rf===false ? PT_AU*petClamp((Math.log10(Math.max(f,20))-1.3)/3,0,1) : PT_AU+.02+(1-PT_AU-.02)*petClamp((Math.log10(Math.max(f,1))-PT_F0)/(PT_F1-PT_F0),0,1);
const ptBandPos=b=>b[0]==='audio' ? [0,PT_AU] : [ptPos(Math.max(b[1],1e5),true),ptPos(Math.min(b[2],6e9),true)];
// форма «голоса» класса: фаза x в радианах, результат −1…1
function ptWave(type,x,t){
  const s=Math.sin;
  switch(type){
    case 'CAR': case 'TONE': return s(x);
    case 'AM': return s(x*6)*(.55+.45*s(x));
    case 'WFM': case 'NFM': return s(x*5+2.2*s(x));
    case 'CW': return s(x*7)*(s(x*.5)>.2 ? 1 : 0);
    case 'OOK': return s(x*8)*(s(x*1.7+t)>0 ? 1 : .05);
    case 'FSK': return s(x*(Math.floor(x/2)%2 ? 9 : 6));
    case 'MFSK': return s(x*(5+Math.floor(x/1.5)%4*1.6));
    case 'PSK': return s(x*7+(Math.floor(x/2.2)%2 ? Math.PI : 0));
    case 'USB': case 'LSB': case 'SSB': case 'VOICE': return (s(x*3)+.6*s(x*5.3+1)+.4*s(x*8.1+2))/2;
    case 'DTMF': return (s(x*6.9)+s(x*12))/2;
    case 'OFDM': return (s(x*4)+s(x*5)+s(x*6)+s(x*7)+s(x*8)+s(x*9))/4;
    case 'DIG': return s(x*6)>0 ? .7 : -.7;
    default: return s(x*13+s(x*3))*.8*s(x*29);
  }
}
const ptNoise=(x,t)=>Math.sin(x*61+t*1.7)*Math.sin(x*137-t*2.3)*.5+Math.sin(x*23+t*.9)*.3+Math.sin(x*311+t*5)*.2;
function ptDraw(n,cv,cx){
  const W=cv.width, H=cv.height, on=Pet.on, st=Pet.st, now=performance.now(), t=now/1000;
  const dt=Math.min(.1,(now-(n.t0||now))/1000); n.t0=now;
  Pet.flash=Math.max(0,Pet.flash-dt*1.2);
  const scr=themeColor('--screen')||'#0a0d0e', hi=themeColor('--scr-hi')||'#9fe8b4';
  cx.globalCompositeOperation='source-over'; cx.globalAlpha=1; cx.fillStyle=scr; cx.fillRect(0,0,W,H);
  const lv=petLevel(st.xp), stage=PET_STAGES.indexOf(petStage(lv.lv)), keys=Object.keys(st.found);
  const m=petMood(st,now,Pet.live), live=on ? Math.min(1,Pet.live/6) : 0, wob=on ? 1 : .12, fl=Pet.flash;
  const fs=Math.max(10,Math.round(W/46)), px=fs/12;
  const base=on ? 150+stage*35 : 210, sat=on ? 70 : 8;
  // шапка
  cx.font='bold '+fs+'px monospace'; cx.textBaseline='top'; cx.textAlign='left'; cx.fillStyle=hi;
  const title=on ? st.name+' · '+PET_STAGES[stage]+' · Lv '+lv.lv : st.name+' is asleep';
  cx.fillText(title, 8*px, 6*px);
  const barY=6*px+fs+4*px;
  if(on){
    cx.font=(fs-1)+'px monospace'; cx.globalAlpha=.7; cx.textAlign='right';
    const info=st.xp+' xp · '+keys.length+' finds'+(Pet.live ? ' · '+Pet.live+' in air' : '');
    if(cx.measureText(info).width+cx.measureText(title).width*1.1<W-24*px) cx.fillText(info, W-8*px, 6*px+px);
    cx.textAlign='left'; cx.globalAlpha=1;
    cx.fillStyle=ptHsl(base,sat,50,.25); cx.fillRect(8*px,barY,W-16*px,3*px);
    cx.fillStyle=ptHsl(base,sat,62,.95); cx.fillRect(8*px,barY,(W-16*px)*lv.frac,3*px);
  }
  // слова внизу; остальное — существо
  const text=on ? Pet.line : 'Switch it on in Settings (sliders button): the pet then lives in the core and watches every Signal Type Identifier.';
  cx.font=fs+'px monospace';
  const lines=ptWrap(cx,text,W-16*px,Math.max(2,Math.floor((H*.26)/(fs+3)))), th=lines.length*(fs+3)+8*px;
  const top=barY+8*px, bot=H-th-4*px, gh=bot-top, w=W-16*px;
  if(gh>50){
    const hx=W/2, Rh=Math.min(w*.2,gh*.24)*(.82+.06*stage)*(1+fl*.08), hy=top+gh*.3;
    const types=Object.keys(st.types).slice(0,8), glow=(typeof vzGlow==='function' ? vzGlow() : 'lighter');
    // «спектр» существа: шумовой пол + пики найденных классов + живые сигналы эфира — на круге, ось частот по часовой стрелке
    const N=96, ys=new Float32Array(N);
    for(let i=0;i<N;i++){ const u=i/N; ys[i]=.12*(1+.5*ptNoise(u*9,t*wob))+live*.1*Math.abs(ptNoise(u*30,t*4)); }
    const peak=(u,h,wd)=>{ const c=Math.round(u*N), r=Math.max(1.2,wd*N);
      for(let d=-Math.ceil(r*3);d<=Math.ceil(r*3);d++){ const i=((c+d)%N+N)%N; ys[i]+=h*Math.exp(-(d/r)*(d/r)); } };
    const crown=[];
    for(const k of keys){
      const f=st.found[k], ty=k.slice(0,k.indexOf('@')), u=ptPos(f.f,!k.endsWith('@audio'));
      const h=petClamp(.3+.05*PET_TYPES[ty]+.07*Math.log2(1+f.n),.3,1.1)*(.9+.1*Math.sin(t*(1.2+PET_TYPES[ty]*.2)+f.f)*wob);
      peak(u,h*(1+fl*.3),.012); crown.push({u,ty});
    }
    let gaze=null;
    if(on) for(const l of Pet.labels||[]){ if(!l || !(l.f>0)) continue; const u=ptPos(l.f,l.rf!==false), sn=l.snr||10;
      peak(u,.15+.5*petClamp(sn/40,0,1)*(.7+.3*Math.abs(Math.sin(t*9+l.f))),.008); if(!gaze || sn>gaze.sn) gaze={u,sn}; }
    // аура: радиальный спектр вокруг головы
    cx.lineCap='round'; cx.globalCompositeOperation=glow;
    for(let pass=0;pass<2;pass++){
      cx.lineWidth=pass ? Math.max(1.2,px*1.3) : Math.max(3,px*4); cx.globalAlpha=pass ? .9 : .13;
      for(let i=0;i<N;i++){
        const a=-Math.PI/2+i/N*Math.PI*2, r0=Rh*1.04, r1=r0+Rh*ys[i]*1.1;
        cx.strokeStyle=ptHsl(base+i/N*70,sat,pass ? 66 : 55);
        cx.beginPath(); cx.moveTo(hx+Math.cos(a)*r0,hy+Math.sin(a)*r0); cx.lineTo(hx+Math.cos(a)*r1,hy+Math.sin(a)*r1); cx.stroke();
      }
    }
    cx.globalCompositeOperation='source-over';
    // хвост: ленты-волны найденных классов, тают книзу
    const nr=3+stage*2+(types.length>6 ? 1 : 0), tl=Math.max(20,bot-(hy+Rh*.9)-6*px), sw=Math.min(w*.4,Rh*2.6);
    for(let r=0;r<nr;r++){
      const ty=types.length ? types[r%types.length] : null, off=(r-(nr-1)/2)/Math.max(1,nr-1)*2, hue=ty ? ptHue(ty) : base;
      let px0=0, py0=0;
      for(let j=0;j<=18;j++){
        const u=j/18, ph=u*9-t*(on ? 2.2 : .4)+r*1.3;
        const lat=(ty ? ptWave(ty,ph,t) : ptNoise(ph,t*wob))*Rh*.17*(.25+u)*(on ? .6+.4*live+.4*fl+.25*m.curiosity : .25)+Math.sin(t*1.1*wob+r+u*3.5)*Rh*.13*u;
        const x=hx+off*sw*.5*(.55+u*.45)+lat, y=hy+Rh*.9+u*tl;
        if(j){ cx.strokeStyle=ptHsl(hue,sat,64,.85*(1-u)*(1-u*.4)); cx.lineWidth=Math.max(1,px*(2.2-u*1.4)); cx.beginPath(); cx.moveTo(px0,py0); cx.lineTo(x,y); cx.stroke(); }
        px0=x; py0=y;
      }
    }
    // голова: полупрозрачный диск
    const g=cx.createRadialGradient(hx,hy-Rh*.2,Rh*.1,hx,hy,Rh);
    g.addColorStop(0,ptHsl(base+30,sat,78,.5+.3*fl)); g.addColorStop(.75,ptHsl(base,sat,45,.28)); g.addColorStop(1,ptHsl(base,sat,30,.12));
    cx.fillStyle=g; cx.beginPath(); cx.arc(hx,hy,Rh,0,Math.PI*2); cx.fill();
    cx.strokeStyle=ptHsl(base+30,sat,78,.85); cx.lineWidth=Math.max(1,px*1.2); cx.stroke();
    // глаза следят за самым сильным живым сигналом, иначе блуждают
    const ga=gaze ? -Math.PI/2+gaze.u*Math.PI*2 : t*.4*wob, gd=gaze ? .09 : .04;
    const tx=Math.cos(ga)*Rh*gd*2, ty2=Math.sin(ga)*Rh*gd*2;
    n.gx=(n.gx||0)+(tx-(n.gx||0))*Math.min(1,dt*6); n.gy=(n.gy||0)+(ty2-(n.gy||0))*Math.min(1,dt*6);
    const blink=!on || (t%4.3)<.12, er=Rh*.2*(1+.2*m.curiosity+.25*fl), ey=hy-Rh*.12;
    for(const sx of [-1,1]){
      const ex=hx+sx*Rh*.38;
      if(blink){ cx.strokeStyle=ptHsl(base+30,sat,80,.9); cx.lineWidth=Math.max(1.2,px*1.6); cx.beginPath(); cx.moveTo(ex-er,ey); cx.lineTo(ex+er,ey); cx.stroke(); continue; }
      cx.fillStyle=ptHsl(base+30,sat,92,.95); cx.beginPath(); cx.ellipse(ex,ey,er,er*1.15,0,0,Math.PI*2); cx.fill();
      cx.fillStyle=ptHsl(base+190,sat,25,1); cx.beginPath(); cx.arc(ex+n.gx,ey+n.gy,er*.5,0,Math.PI*2); cx.fill();
    }
    // рот — waveform голоса: тише в покое, громче от эфира и находок
    const mw=Rh*.7, my=hy+Rh*.42, ma=Rh*(on ? .05+.16*live+.2*fl+.07*m.curiosity : .01);
    cx.strokeStyle=ptHsl(base+80,sat,85,.95); cx.lineWidth=Math.max(1.2,px*1.5); cx.beginPath();
    for(let i=0;i<=32;i++){
      const u=i/32, ph=u*10+t*(on ? 3 : .5);
      let v=0; if(types.length){ for(const ty of types) v+=ptWave(ty,ph,t); v/=Math.sqrt(types.length); } else v=Math.sin(ph*2)*.6;
      const x=hx-mw/2+u*mw, y=my+v*ma*Math.sin(u*Math.PI);
      i ? cx.lineTo(x,y) : cx.moveTo(x,y);
    }
    cx.stroke();
    // органы: устройства инвентаря кружат вокруг головы
    const inv=Pet.inv;
    inv.forEach((d,i)=>{
      const a=t*.35*wob+i/Math.max(1,inv.length)*Math.PI*2, x=hx+Math.cos(a)*Rh*2.15, y=hy+Math.sin(a)*Rh*1.25, rr=Math.max(3,Rh*.1), hue=PT_KIND_HUE[d.kind]??0;
      cx.strokeStyle=ptHsl(hue,sat,60,.2); cx.lineWidth=1; cx.beginPath(); cx.moveTo(hx,hy); cx.lineTo(x,y); cx.stroke();
      cx.fillStyle=ptHsl(hue,sat,64,.95); cx.beginPath(); cx.arc(x,y,rr,0,Math.PI*2); cx.fill();
    });
    // метки классов у кончиков короны
    cx.font=Math.max(9,fs-3)+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
    for(const c of crown.slice(0,10)){ const i=Math.round(c.u*N)%N, a=-Math.PI/2+c.u*Math.PI*2, r=Rh*(1.04+ys[i]*1.1)+fs*.8;
      cx.fillStyle=ptHsl(ptHue(c.ty),sat,74,.95); cx.fillText(c.ty,hx+Math.cos(a)*r,hy+Math.sin(a)*r); }
    cx.textAlign='left'; cx.textBaseline='top';
    // горизонты: полосы по оси частот; открытые яркие, достижимые тусклые, цвет — устройство
    const hor=on ? petHorizons(st,Pet.inv) : [], sy=bot-5*px, x0=8*px;
    for(const b of PET_BANDS){
      const [a,c]=ptBandPos(b), h=b[0]==='audio' ? null : hor.find(q=>q.name===b[0]), au=b[0]==='audio' && on && Pet.inv.some(d=>d.kind==='audio');
      if(!h && !au) continue;
      const open=au ? keys.some(k=>k.endsWith('@audio')) : h.open, dev=au ? 'audio' : (Pet.inv.find(d=>d.name===h.dev)||{}).kind;
      cx.fillStyle=ptHsl(PT_KIND_HUE[dev]??base,sat,open ? 62 : 38,open ? .95 : .45);
      cx.fillRect(x0+a*w+1,sy,Math.max(2,(c-a)*w-2),3.5*px);
    }
  }
  cx.font=fs+'px monospace'; cx.fillStyle=hi; cx.globalAlpha=.95; cx.textAlign='left'; cx.textBaseline='top';
  const y0=H-4*px-lines.length*(fs+3);
  lines.forEach((l,i)=>cx.fillText(l,8*px,y0+i*(fs+3)));
  cx.globalAlpha=1;
}

function ptRec(e){
  const r={t:e.t,src:'Pet',kind:e.kind};
  for(const k in e) if(k!=='t' && k!=='kind') r[k]=e[k];
  r.text=e.kind+(e.type ? ' '+e.type : '')+(e.f ? ' '+petFmtHz(e.f) : '')+(e.title ? ' '+e.title : '')+(e.name ? ' '+e.name : '')+(e.xp ? ' +'+e.xp+' xp' : '');
  return r;
}
def({ id:'pet', title:'Aether Pet', cat:'Analysis', view:{h:300}, resize:true, w:380,
  kw:'tamagotchi pet game achievements quests xp level gamification explore signals inventory horizons organism',
  outs:[{n:'text',t:'txt'},{n:'quest',t:'txt'},{n:'rec',t:'rec'},{n:'xp',t:'num'},{n:'level',t:'num'}],
  params:[{n:'wake',t:'button',label:'Wake / sleep',fn:n=>{ Pet.setOn(!Pet.on); const cb=document.getElementById('petOn'); if(cb) cb.checked=Pet.on; }},
          {n:'skip',t:'button',label:'Skip quest',fn:()=>Pet.skip()},
          {n:'unskip',t:'button',label:'Restore skipped',fn:()=>Pet.unskip()},
          {n:'scan',t:'button',label:'Rescan gear',fn:()=>Pet.scan()},
          {n:'name',t:'button',label:'Rename',fn:()=>{ const v=prompt('Name',Pet.st.name); if(v && v.trim()){ Pet.st.name=v.trim().slice(0,20); Pet.dirty=true; Pet.save(); ptInfo(); } }},
          {n:'save',t:'button',label:'Export',fn:()=>dl(new Blob([JSON.stringify(petSave(Pet.st))],{type:'application/json'}),'pet-'+Pet.st.name+'.json')},
          {n:'load',t:'button',label:'Import',fn:()=>{ const i=document.createElement('input'); i.type='file'; i.accept='.json,application/json';
            i.onchange=async()=>{ try{ if(petLoad(Pet.st,JSON.parse(await i.files[0].text()))){ Pet.dirty=true; Pet.save(); Pet.refresh(); } }catch(e){} };
            i.click(); }},
          {n:'reset',t:'button',label:'Reset',fn:()=>{ if(confirm('Forget all finds, quests and achievements?')) Pet.reset(); }}],
  init:n=>{ n.i0=Pet.n; n.t0=0; },
  process(n){
    const q=Pet.on ? Pet.quest() : null, rec=Pet.n>n.i0 ? Pet.log.slice(Math.max(0,Pet.log.length-(Pet.n-n.i0))).map(ptRec) : null;
    n.i0=Pet.n;
    return {text:Pet.on ? Pet.line : '', quest:q ? q.title : '', rec, xp:Pet.st.xp, level:petLevel(Pet.st.xp).lv};
  },
  draw:ptDraw });
