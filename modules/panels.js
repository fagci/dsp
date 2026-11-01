"use strict";
/* ============================ PANELS ============================ */
// Лицевые панели приборов на canvas узла: дисплеи радиостанций, спектроанализатор, детекторы (в т.ч. металлоискатель по магнитометру),
// стрелочный индикатор, спидометр с одометром, счётчик, газоразрядный индикатор, кнопочные панели и джойстик-крестовина.
// Кнопки управления — отдельные узлы (Key Panel, D-pad), дисплеи берут числа и текст с проводов: любую панель можно подключить к любому дисплею.
// Общие помощники (indColor, indNum, indSmooth, indWire, SEG7 …) — из indicators.js, который грузится раньше.

const PN_DIM=.045;                                 // негорящие сегменты: почти не видны
const PN_FACE={cream:'#e9dfb8',amber:'#f0b24a',white:'#f2f2ee',green:'#9fd8a8',blue:'#9cc7e8',dark:'#1d2126'};
const pnFace=s=>{ s=String(s||'').trim().toLowerCase(); return PN_FACE[s] || (/^#[0-9a-f]{3,8}$/.test(s) ? s : PN_FACE.cream); };
// подсветка любого цвета: оттенок 0–360 (hue) важнее текстового поля color
const pnBL=p=>+p.hue>=0 ? 'hsl('+Math.round(p.hue)+' 90% 55%)' : indColor(p.color);
const PN_HUE={n:'hue',t:'range',min:-1,max:360,step:1,d:-1,label:'hue 0–360 (−1 — use the colour above)'};
const pnRound=(cx,x,y,w,h,r)=>{ cx.beginPath(); cx.roundRect(x,y,w,h,r); };
const pnDark=hex=>{ const m=/^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(hex); if(!m) return true;
  let h=m[1]; if(h.length===3) h=h.replace(/./g,'$&$&');
  return (parseInt(h.slice(0,2),16)*.3+parseInt(h.slice(2,4),16)*.59+parseInt(h.slice(4,6),16)*.11)<110; };
const pnHz=f=>{ const a=Math.abs(f); return a>=1e9 ? (f/1e9).toFixed(4)+' GHz' : a>=1e6 ? (f/1e6).toFixed(4)+' MHz' : a>=1e3 ? (f/1e3).toFixed(3)+' kHz' : f.toFixed(0)+' Hz'; };
const PN_FONT='"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
function pnPortsFix(n){
  const iv=new Set(portsOf(n,'ins').map(p=>p.n)), ov=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>(e.to===n.id && !iv.has(e.tp)) || (e.from===n.id && !ov.has(e.fp))).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
function pnPlate(cx,W,H){
  const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#2d3238'); g.addColorStop(1,'#14171a');
  cx.fillStyle=g; pnRound(cx,1,1,W-2,H-2,Math.min(12,H*.08)); cx.fill();
  cx.strokeStyle='#4b525a'; cx.lineWidth=1.5; cx.stroke();
}

/* ---------- семисегментные цифры (для всех панелей) ---------- */
function pnSegChar(cx,x0,y0,w,h,m,col,dim){
  const t=Math.max(1.2,h*.11), g=t*.7, x1=x0+w, ym=y0+h/2, y1=y0+h;
  const hs=(a,b,y)=>{ cx.moveTo(a,y); cx.lineTo(a+t/2,y-t/2); cx.lineTo(b-t/2,y-t/2); cx.lineTo(b,y); cx.lineTo(b-t/2,y+t/2); cx.lineTo(a+t/2,y+t/2); cx.closePath(); };
  const vs=(a,b,x)=>{ cx.moveTo(x,a); cx.lineTo(x+t/2,a+t/2); cx.lineTo(x+t/2,b-t/2); cx.lineTo(x,b); cx.lineTo(x-t/2,b-t/2); cx.lineTo(x-t/2,a+t/2); cx.closePath(); };
  const S=[()=>hs(x0+g,x1-g,y0),()=>vs(y0+g,ym-g/2,x1),()=>vs(ym+g/2,y1-g,x1),()=>hs(x0+g,x1-g,y1),
           ()=>vs(ym+g/2,y1-g,x0),()=>vs(y0+g,ym-g/2,x0),()=>hs(x0+g,x1-g,ym)];
  for(let k=0;k<7;k++){
    const on=m>>k&1;
    cx.save(); cx.fillStyle=col; cx.globalAlpha=on ? 1 : dim;
    if(on){ cx.shadowColor=col; cx.shadowBlur=t*1.4; }
    cx.beginPath(); S[k](); cx.fill(); cx.restore();
  }
}
// строка, выровненная вправо по xr; cells — минимум знакомест (пустые рисуются тусклыми сегментами); возвращает левый край
function pnSegStr(cx,s,xr,y,h,col,dim,cells){
  const w=h*.5, cw=w+h*.2, ch=[];
  for(let i=0;i<s.length;i++){ if(s[i]==='.' && ch.length) ch[ch.length-1].dot=true; else ch.push({c:s[i],dot:false}); }
  const n=Math.max(cells||0,ch.length), x=xr-cw*n;
  for(let i=0;i<n;i++){
    const c=ch[i-(n-ch.length)], x0=x+i*cw+(cw-w)/2;
    pnSegChar(cx,x0,y,w,h,c ? (SEG7[c.c]??0) : 0,col,dim);
    if(c && c.dot){ cx.save(); cx.fillStyle=col; cx.shadowColor=col; cx.shadowBlur=h*.08; cx.beginPath(); cx.arc(x0+w+(cw-w)*.45,y+h,Math.max(1.2,h*.065),0,7); cx.fill(); cx.restore(); }
  }
  return x;
}
// механический барабан: колёса поворачиваются только в последней десятой оборота младшего (как в одометре)
function pnDrum(cx,x,y,cw,ch,val,digits,redLast){
  val=Math.max(0,val);
  cx.save(); cx.font=Math.round(ch*.78)+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
  for(let i=0;i<digits;i++){
    const x0=x+(digits-1-i)*cw, q=val/Math.pow(10,i), fl=Math.floor(q), d=fl%10, lower=q-fl;
    const sc=i===0 ? lower : lower>.9 ? (lower-.9)*10 : 0, red=redLast && i===0;
    cx.save(); cx.beginPath(); cx.rect(x0,y,cw,ch); cx.clip();
    cx.fillStyle=red ? '#6e1a1a' : '#0f0f0f'; cx.fillRect(x0,y,cw,ch);
    cx.fillStyle=red ? '#f6eaea' : '#ece8dc';
    cx.fillText(d,x0+cw/2,y+ch/2-sc*ch); cx.fillText((d+1)%10,x0+cw/2,y+ch/2+(1-sc)*ch);
    const g=cx.createLinearGradient(0,y,0,y+ch);
    g.addColorStop(0,'rgba(0,0,0,.7)'); g.addColorStop(.3,'rgba(0,0,0,0)'); g.addColorStop(.7,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,.7)');
    cx.fillStyle=g; cx.fillRect(x0,y,cw,ch); cx.restore();
    cx.strokeStyle='#000'; cx.lineWidth=1; cx.strokeRect(x0+.5,y+.5,cw-1,ch-1);
  }
  cx.restore();
}

/* ---------- Radio Display (стационарная) ---------- */
const RB_MODES=['LSB','USB','CW','AM','FM','DIG'];
// дБм → число сегментов S-метра (S1…S9 по 6 дБ, затем +20 / +40 / +60)
const pnSegs=(dbm,s9)=>dbm<=s9 ? clamp((dbm-(s9-48))/6+1,0,9) : clamp(9+(dbm-s9)/20,9,12);
function pnSBar(cx,x,y,w,h,k,s9,col){
  const N=12, gw=w/N, labels=['1','3','5','7','9','+20','+40','+60'];
  for(let i=0;i<N;i++){
    const lit=k>i, c=i>=9 ? '#ff4a3a' : col;
    cx.save(); cx.fillStyle=c; cx.globalAlpha=lit ? 1 : PN_DIM*2;
    if(lit){ cx.shadowColor=c; cx.shadowBlur=h*.6; }
    cx.fillRect(x+i*gw+1,y,gw-2,h); cx.restore();
  }
  cx.fillStyle=col; cx.globalAlpha=.7; cx.font=Math.max(7,h*.8)+'px monospace'; cx.textAlign='center'; cx.textBaseline='top';
  labels.forEach((t,i)=>cx.fillText(t,x+(i<5 ? (i*2+.5) : 8+(i-4)+.5)*gw,y+h+2));
  cx.globalAlpha=1;
}
def({ id:'radiobase', lazy:'proc', title:'Radio Display (base station)', cat:'Indicators', kw:'transceiver hf station rig vfo s-meter frequency front panel display ham',
  ins:[{n:'freq',t:'num'},{n:'s',t:'num'},{n:'mode',t:'txt'},{n:'tx',t:'num'},{n:'sql',t:'num'},{n:'name',t:'txt'},{n:'vfo',t:'txt'}],
  view:{h:150}, w:460, resize:true,
  params:[{n:'model',t:'text',d:'DSP-1000'},
          {n:'color',t:'text',d:'amber',label:'display colour: '+IND_COLORS.join(', ')+' or #rrggbb'},PN_HUE,
          {n:'digits',t:'range',min:6,max:10,step:1,d:8,label:'frequency digits'},
          {n:'decimals',t:'range',min:0,max:6,step:1,d:5,label:'decimals in MHz'},
          {n:'s9',t:'num',d:-73,label:'S9 level, dBm'}],
  init:n=>{ n.f=null; n.ss=-140; n.mode=''; n.tx=0; n.sql=0; n.name=''; n.vfo='A'; n.rx=false; },
  process(n,I){
    n.f=indNum(I.freq); const s=indNum(I.s); n.rx=s!==null;
    if(s!==null) n.ss=indSmooth(n.ss,s,s>n.ss ? .03 : .35);
    n.mode=typeof I.mode==='string' ? I.mode.toUpperCase() : ''; n.name=typeof I.name==='string' ? I.name : '';
    n.vfo=typeof I.vfo==='string' && I.vfo ? I.vfo : 'A';
    n.tx=+I.tx>0 ? 1 : 0; n.sql=+I.sql>0 ? 1 : 0;
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, col=pnBL(p), m=Math.max(6,H*.05);
    cx.clearRect(0,0,W,H); pnPlate(cx,W,H);
    const wx=m, wy=m, ww=W-2*m, wh=H*.76;
    cx.fillStyle='#070908'; pnRound(cx,wx,wy,ww,wh,6); cx.fill(); cx.strokeStyle='#000'; cx.lineWidth=2; cx.stroke();
    const f1=Math.max(8,Math.min(14,wh*.1));
    cx.font='bold '+f1+'px monospace'; cx.textBaseline='top'; cx.textAlign='left';
    cx.fillStyle=col; cx.fillText('VFO '+n.vfo,wx+10,wy+wh*.05);
    cx.globalAlpha=.75; cx.fillText(n.name,wx+10+f1*5,wy+wh*.05); cx.globalAlpha=1;
    const known=RB_MODES.includes(n.mode); let bx=wx+ww-8;
    cx.textAlign='right';
    for(let i=RB_MODES.length-1;i>=0;i--){
      const t=RB_MODES[i], on=n.mode===t || (!known && n.mode && t==='DIG' && false);
      cx.globalAlpha=on ? 1 : .22; cx.fillStyle=col;
      if(on){ cx.shadowColor=col; cx.shadowBlur=6; }
      cx.fillText(t,bx,wy+wh*.05); cx.shadowBlur=0; bx-=cx.measureText(t).width+f1*.9;
    }
    cx.globalAlpha=1;
    const D=Math.round(p.digits), dec=Math.round(p.decimals);
    const fh=Math.min(wh*.38,ww*.8/(D*.7)), fy=wy+wh*.2;
    const s=n.f===null ? '-'.repeat(D) : (n.f/1e6).toFixed(dec);
    pnSegStr(cx,s,wx+ww-ww*.12,fy,fh,col,PN_DIM,D);
    cx.fillStyle=col; cx.font='bold '+Math.max(9,fh*.28)+'px monospace'; cx.textAlign='left'; cx.textBaseline='bottom'; cx.fillText('MHz',wx+ww-ww*.115,fy+fh);
    pnSBar(cx,wx+ww*.05,wy+wh*.68,ww*.9,wh*.1,n.rx ? pnSegs(n.ss,+p.s9) : 0,+p.s9,col);
    // нижняя полоса: марка, лампы TX / BUSY
    const by=wy+wh+(H-wy-wh)/2;
    cx.textBaseline='middle'; cx.font='bold '+Math.max(9,Math.min(15,H*.08))+'px '+PN_FONT; cx.textAlign='left'; cx.fillStyle='#c9ced4';
    cx.fillText(String(p.model||''),wx+6,by);
    const lamp=(x,t,on,c)=>{ const r=Math.max(3,H*.022); cx.save(); cx.fillStyle=c; cx.globalAlpha=on ? 1 : .18;
      if(on){ cx.shadowColor=c; cx.shadowBlur=r*2.5; } cx.beginPath(); cx.arc(x,by,r,0,7); cx.fill(); cx.restore();
      cx.fillStyle='#9aa1a8'; cx.font=Math.max(8,H*.055)+'px monospace'; cx.textAlign='left'; cx.fillText(t,x+r+4,by); };
    lamp(W-m-ww*.32,'BUSY',n.sql && !n.tx,'#4fe08a'); lamp(W-m-ww*.12,'TX',n.tx,'#ff4a3a');
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Radio Display (мобильная / портативная, подсветка любого цвета) ---------- */
def({ id:'radiomobile', lazy:'proc', title:'Radio Display (mobile)', cat:'Indicators', kw:'handheld walkie talkie transceiver lcd backlight channel mobile car radio display',
  ins:[{n:'freq',t:'num'},{n:'s',t:'num'},{n:'mode',t:'txt'},{n:'tx',t:'num'},{n:'sql',t:'num'},{n:'name',t:'txt'},{n:'ch',t:'num'},{n:'vol',t:'num'},{n:'batt',t:'num'}],
  view:{h:170}, w:280, resize:true,
  params:[{n:'model',t:'text',d:''},
          {n:'color',t:'text',d:'green',label:'backlight: '+IND_COLORS.join(', ')+' or #rrggbb'},PN_HUE,
          {n:'style',t:'select',opts:['negative','positive'],d:'negative',label:'LCD (negative — glowing digits, positive — dark digits on a lit panel)'},
          {n:'digits',t:'range',min:6,max:10,step:1,d:8,label:'frequency digits'},
          {n:'decimals',t:'range',min:0,max:6,step:1,d:4,label:'decimals in MHz'},
          {n:'s9',t:'num',d:-73,label:'S9 level, dBm'}],
  init:n=>{ n.f=null; n.ss=-140; n.mode=''; n.tx=0; n.sql=0; n.name=''; n.ch=null; n.vol=null; n.bat=null; n.rx=false; },
  process(n,I){
    n.f=indNum(I.freq); const s=indNum(I.s); n.rx=s!==null;
    if(s!==null) n.ss=indSmooth(n.ss,s,s>n.ss ? .03 : .35);
    n.mode=typeof I.mode==='string' ? I.mode.toUpperCase() : ''; n.name=typeof I.name==='string' ? I.name : '';
    n.ch=indNum(I.ch); n.vol=indNum(I.vol); n.bat=indNum(I.batt);
    n.tx=+I.tx>0 ? 1 : 0; n.sql=+I.sql>0 ? 1 : 0;
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, bl=pnBL(p), pos=p.style==='positive', m=Math.max(5,H*.04);
    cx.clearRect(0,0,W,H);
    const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#33373d'); g.addColorStop(1,'#1a1c20');
    cx.fillStyle=g; pnRound(cx,1,1,W-2,H-2,Math.min(18,H*.12)); cx.fill(); cx.strokeStyle='#50565e'; cx.lineWidth=1.5; cx.stroke();
    const sx=m*1.4, sy=m*1.4, sw=W-2*sx, sh=H-2*sy-(p.model ? H*.09 : 0);
    // подсветка: positive — залитое стекло, negative — тёмное с цветным свечением
    cx.save(); pnRound(cx,sx,sy,sw,sh,6); cx.clip();
    if(pos){ const rg=cx.createRadialGradient(W/2,sy+sh*.4,sh*.1,W/2,sy+sh*.4,sw*.7); rg.addColorStop(0,bl); rg.addColorStop(1,'rgba(0,0,0,.55)');
      cx.fillStyle=bl; cx.fillRect(sx,sy,sw,sh); cx.fillStyle=rg; cx.fillRect(sx,sy,sw,sh); }
    else { cx.fillStyle='#050706'; cx.fillRect(sx,sy,sw,sh);
      const rg=cx.createRadialGradient(W/2,sy+sh*.5,0,W/2,sy+sh*.5,sw*.65); rg.addColorStop(0,bl); rg.addColorStop(1,'rgba(0,0,0,0)');
      cx.globalAlpha=.16; cx.fillStyle=rg; cx.fillRect(sx,sy,sw,sh); cx.globalAlpha=1; }
    const ink=pos ? '#0d120c' : bl, dim=pos ? .07 : PN_DIM*1.4;
    const f1=Math.max(8,Math.min(13,sh*.1)), L=sx+8, R=sx+sw-8;
    cx.font='bold '+f1+'px monospace'; cx.textBaseline='top'; cx.fillStyle=ink; cx.textAlign='left';
    // строка состояния: уровень сигнала, TX / RX, заряд
    const bars=n.rx ? Math.round(pnSegs(n.ss,+p.s9)/12*5) : 0, bw=f1*.5, y0=sy+5;
    for(let i=0;i<5;i++){ const h=f1*(.35+.13*i); cx.globalAlpha=i<bars ? 1 : dim*3; cx.fillRect(L+i*(bw+1.5),y0+f1-h,bw,h); }
    cx.globalAlpha=1;
    cx.textAlign='center'; cx.fillStyle=n.tx ? (pos ? '#8a0f0f' : '#ff5a4a') : ink;
    cx.fillText(n.tx ? 'TX' : n.sql ? 'BUSY' : n.rx ? 'RX' : '',sx+sw/2,y0);
    if(n.bat!==null){ const k=clamp(n.bat,0,1), bx=R-f1*2.2, by=y0+1;
      cx.fillStyle=ink; cx.strokeStyle=ink; cx.lineWidth=1.2; cx.strokeRect(bx,by,f1*1.8,f1*.85); cx.fillRect(bx+f1*1.8,by+f1*.25,2,f1*.35);
      cx.fillRect(bx+2,by+2,(f1*1.8-4)*k,f1*.85-4); }
    // частота
    const D=Math.round(p.digits), dec=Math.round(p.decimals);
    const fh=Math.min(sh*.34,sw*.8/(D*.7)), fy=sy+sh*.2;
    const s=n.f===null ? '-'.repeat(D) : (n.f/1e6).toFixed(dec);
    pnSegStr(cx,s,R-sw*.1,fy,fh,ink,dim,D);
    cx.fillStyle=ink; cx.font='bold '+Math.max(8,fh*.26)+'px monospace'; cx.textAlign='left'; cx.textBaseline='bottom'; cx.fillText('MHz',R-sw*.095,fy+fh);
    // канал, имя, режим, громкость
    const y2=sy+sh*.66; cx.textBaseline='top'; cx.font='bold '+Math.max(9,sh*.13)+'px monospace';
    cx.textAlign='left'; cx.fillText(n.ch!==null ? 'CH'+String(Math.round(n.ch)).padStart(2,'0') : '',L,y2);
    cx.textAlign='center'; cx.fillText(n.name.slice(0,12),sx+sw/2,y2);
    cx.textAlign='right'; cx.fillText(n.mode,R,y2);
    if(n.vol!==null){ const y3=sy+sh-f1*1.5, vk=clamp(n.vol,0,1); cx.textAlign='left'; cx.font=Math.max(8,f1*.9)+'px monospace'; cx.fillText('VOL',L,y3);
      for(let i=0;i<10;i++){ cx.globalAlpha=i<Math.round(vk*10) ? 1 : dim*3; cx.fillRect(L+f1*3+i*(sw*.05),y3+1,sw*.035,f1*.85); } cx.globalAlpha=1; }
    cx.restore();
    cx.fillStyle='rgba(255,255,255,.05)'; pnRound(cx,sx,sy,sw,sh*.38,6); cx.fill();                // блик стекла
    cx.strokeStyle='#000'; cx.lineWidth=2; pnRound(cx,sx,sy,sw,sh,6); cx.stroke();
    if(p.model){ cx.fillStyle='#c9ced4'; cx.font='bold '+Math.max(8,H*.06)+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText(p.model,W/2,H-m-H*.025); }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Spectrum Display (панель анализатора спектра) ---------- */
def({ id:'specdisp', lazy:'proc', title:'Spectrum Analyzer Display', cat:'Indicators', kw:'spectrum analyzer panel screen crt tinysa handheld marker peak hold graticule',
  ins:[{n:'spec',t:'spec'},{n:'f0',t:'num'},{n:'f1',t:'num'},{n:'ref',t:'num'},{n:'floor',t:'num'}],
  outs:[{n:'peak',t:'num'},{n:'pf',t:'num'}],
  view:{h:220}, w:480, resize:true,
  params:[{n:'style',t:'select',opts:['lab','handheld'],d:'lab',label:'screen (lab — green CRT with a graticule, handheld — colour LCD with a fill)'},
          {n:'color',t:'text',d:'green',label:'trace colour: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'dbrange',t:'range2',keys:['floor','top'],min:-140,max:20,step:1,d:[-110,-10],label:'range, dB (also from the ref / floor pins)'},
          {n:'avg',t:'range',min:0,max:2,step:.01,d:.15,label:'averaging, s'},
          {n:'hold',t:'check',d:true,label:'peak hold'},
          {n:'marker',t:'check',d:true,label:'marker on the peak'},
          {n:'title',t:'text',d:''}],
  init:n=>{ n.db=null; n.av=null; n.hd=null; n.k=1; n.sp=null; n.pkv=null; n.pkf=null; n.lo=0; n.hi=1; },
  process(n,I){
    const s=I.spec, p=n.p;
    if(!s || !s.mag || !s.mag.length){ n.sp=null; return {peak:null,pf:null}; }
    const N=s.mag.length, k=Math.max(1,Math.ceil(N/2048)), nb=Math.ceil(N/k), bin=(s.sr/2)/N;
    if(!n.db || n.db.length!==nb){ n.db=new Float32Array(nb); n.av=new Float32Array(nb).fill(-200); n.hd=new Float32Array(nb).fill(-200); }
    const a=+p.avg>0 ? 1-Math.exp(-indDt()/+p.avg) : 1;
    for(let j=0;j<nb;j++){
      let mx=0; for(let i=j*k;i<Math.min(N,j*k+k);i++) if(s.mag[i]>mx) mx=s.mag[i];
      const d=20*Math.log10(mx+1e-9);
      n.av[j]= n.av[j]<-150 ? d : n.av[j]+(d-n.av[j])*a;
      n.hd[j]=Math.max(d,n.hd[j]-30*indDt());
    }
    n.sp=s; n.k=k; n.bin=bin;
    const f0=indNum(I.f0), f1=indNum(I.f1), lo=f0!==null ? f0 : 0;
    n.lo=lo; n.hi= f1!==null && f1>lo ? f1 : lo+s.sr/2;
    n.ref=indNum(I.ref); n.flo=indNum(I.floor);
    let pm=-Infinity, pj=-1;
    for(let j=0;j<nb;j++){ const f=lo+(j*k+k/2)*bin; if(f<lo || f>n.hi) continue; if(n.av[j]>pm){ pm=n.av[j]; pj=j; } }
    n.pkv= pj<0 ? null : pm; n.pkf= pj<0 ? null : lo+(pj*k+k/2)*bin;
    return {peak:n.pkv,pf:n.pkf}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, lab=p.style==='lab', col=indColor(p.color);
    const top=n.ref!=null ? n.ref : +p.top, flo=n.flo!=null ? n.flo : +p.floor, span=Math.max(1,top-flo);
    cx.clearRect(0,0,W,H);
    const bezel=cx.createLinearGradient(0,0,0,H); bezel.addColorStop(0,'#2d3238'); bezel.addColorStop(1,'#14171a');
    cx.fillStyle=bezel; pnRound(cx,1,1,W-2,H-2,Math.min(12,H*.06)); cx.fill(); cx.strokeStyle='#4b525a'; cx.lineWidth=1.5; cx.stroke();
    const m=Math.max(6,H*.04), px=m+22, py=m+(p.title ? 14 : 6), pw=W-px-m-4, ph=H-py-m-16;
    cx.fillStyle=lab ? '#050a06' : '#0a1226'; cx.fillRect(px,py,pw,ph);
    // сетка
    cx.strokeStyle=lab ? 'rgba(120,255,150,.22)' : 'rgba(150,170,220,.18)'; cx.lineWidth=1;
    for(let i=0;i<=10;i++){ const x=Math.round(px+pw*i/10)+.5; cx.beginPath(); cx.moveTo(x,py); cx.lineTo(x,py+ph); cx.stroke(); }
    for(let i=0;i<=8;i++){ const y=Math.round(py+ph*i/8)+.5; cx.beginPath(); cx.moveTo(px,y); cx.lineTo(px+pw,y); cx.stroke(); }
    indFont(cx,Math.max(8,Math.min(11,H*.045))); cx.fillStyle=lab ? 'rgba(160,255,180,.8)' : '#e8d75a'; cx.textAlign='right'; cx.textBaseline='middle';
    for(let i=0;i<=8;i+=2) cx.fillText(indFmt(top-span*i/8),px-3,py+ph*i/8);
    const sp=n.sp, lo=n.lo, hi=n.hi;
    cx.textBaseline='top'; cx.textAlign='left'; cx.fillText(sp ? pnHz(lo) : '—',px,py+ph+3);
    cx.textAlign='right'; cx.fillText(sp ? pnHz(hi) : '',px+pw,py+ph+3);
    cx.textAlign='center'; if(sp) cx.fillText('span '+pnHz(hi-lo),px+pw/2,py+ph+3);
    if(p.title){ cx.textAlign='left'; cx.textBaseline='top'; cx.fillText(p.title,px,m-1); }
    if(sp){
      const nb=n.db.length, k=n.k, bin=n.bin, X=f=>px+(f-lo)/(hi-lo)*pw, Y=d=>py+ph*(1-clamp((d-flo)/span,0,1));
      cx.save(); cx.beginPath(); cx.rect(px,py,pw,ph); cx.clip();
      const line=(arr)=>{ cx.beginPath(); let st=false;
        for(let j=0;j<nb;j++){ const x=X(lo+(j*k+k/2)*bin); if(x<px-2 || x>px+pw+2) continue; const y=Y(arr[j]); st ? cx.lineTo(x,y) : cx.moveTo(x,y); st=true; } };
      if(!lab){ line(n.av); cx.lineTo(px+pw,py+ph); cx.lineTo(px,py+ph); cx.closePath();
        const g=cx.createLinearGradient(0,py,0,py+ph); g.addColorStop(0,col); g.addColorStop(1,'rgba(0,0,0,0)'); cx.globalAlpha=.35; cx.fillStyle=g; cx.fill(); cx.globalAlpha=1; }
      if(p.hold){ line(n.hd); cx.strokeStyle=lab ? 'rgba(255,220,90,.6)' : 'rgba(255,255,255,.4)'; cx.lineWidth=1; cx.stroke(); }
      line(n.av); cx.strokeStyle=col; cx.lineWidth=lab ? 1.6 : 1.4; cx.lineJoin='round';
      if(lab){ cx.shadowColor=col; cx.shadowBlur=6; } cx.stroke(); cx.shadowBlur=0;
      if(p.marker && n.pkv!==null){
        const x=X(n.pkf), y=Y(n.pkv);
        cx.fillStyle='#ffd24a'; cx.beginPath(); cx.moveTo(x,y-2); cx.lineTo(x-5,y-11); cx.lineTo(x+5,y-11); cx.closePath(); cx.fill();
        indFont(cx,Math.max(8,Math.min(12,H*.05))); cx.textBaseline='top';
        const t=pnHz(n.pkf)+'  '+n.pkv.toFixed(1)+' dB', right=x>px+pw*.6;
        cx.textAlign=right ? 'right' : 'left'; cx.fillText(t,right ? px+pw-4 : px+4,py+4);
      }
      cx.restore();
    }
    cx.strokeStyle='#000'; cx.lineWidth=2; cx.strokeRect(px,py,pw,ph);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Detector (металлоискатель по магнитометру, жучки, ЭМП, радиация) ---------- */
const DET_STYLES=['metal','bug','emf','geiger'];
def({ id:'detector', lazy:'proc', title:'Detector', cat:'Indicators', kw:'metal detector magnetometer ground balance target id bug sweeper rf emf geiger radiation cpm field anomaly',
  ins:[{n:'in',t:'num'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}],
  outs:[{n:'level',t:'num'},{n:'delta',t:'num'},{n:'id',t:'num'},{n:'alarm',t:'num'},{n:'tone',t:'num'}],
  view:{h:170}, w:360, resize:true,
  params:[{n:'style',t:'select',opts:DET_STYLES,d:'metal',label:'style (metal — needle and target ID, bug — LED ladder, emf — five lamps, geiger — counts)'},
          {n:'full',t:'num',d:20,label:'full scale: change from the baseline (geiger: not used)'},
          {n:'sens',t:'range',min:.1,max:10,step:.1,d:1,label:'sensitivity'},
          {n:'bal',t:'range',min:0,max:60,step:.5,d:8,label:'auto ground balance, s (0 — off; a click on the display sets the baseline by hand)'},
          {n:'thr',t:'range',min:0,max:1,step:.01,d:.3,label:'alarm level'},
          {n:'unit',t:'text',d:'µT'},
          {n:'k',t:'num',d:.0057,label:'geiger: µSv/h per count per minute'}],
  init:n=>{ n.base=null; n.cur=null; n.d=0; n.proj=0; n.lv=0; n.tid=0; n.act=false; n.pk=0; n.pt=0; n.raw=0; },
  process(n,I){
    const p=n.p, dt=indDt(), sc=indNum(I.in), x=indNum(I.x), y=indNum(I.y), z=indNum(I.z);
    const vec= x!==null && y!==null && z!==null ? [x,y,z] : sc!==null ? [sc] : null;
    if(!vec){ n.act=false; n.lv=indSmooth(n.lv,0,.4); return {level:0,delta:0,id:0,alarm:0,tone:0}; }
    n.act=true; let t;
    if(p.style==='geiger'){
      n.raw=sc!==null ? sc : Math.hypot(...vec); n.d=n.raw;
      t=clamp(Math.log10(1+Math.max(0,n.raw))/4,0,1);                  // 0…10000 CPM по логарифму
    } else {
      if(!n.base || n.base.length!==vec.length) n.base=vec.slice();
      else if(+p.bal>0){ const a=1-Math.exp(-dt/+p.bal); for(let i=0;i<vec.length;i++) n.base[i]+=(vec[i]-n.base[i])*a; }
      n.cur=vec;
      const d=vec.map((q,i)=>q-n.base[i]);
      n.d=Math.hypot(...d);
      if(vec.length===3){ const bm=Math.hypot(...n.base)||1; n.proj=(d[0]*n.base[0]+d[1]*n.base[1]+d[2]*n.base[2])/bm; } else n.proj=d[0];
      t=clamp(n.d*(+p.sens)/(+p.full||1),0,1);
      // «ID»: поле у цели сильнее фона → высокие номера (чёрный металл), слабее → низкие (эвристика по знаку изменения)
      if(t>.04) n.tid=clamp(Math.round(50+49*n.proj/(n.d||1)),0,99);
    }
    n.lv=indSmooth(n.lv,t,t>n.lv ? .03 : .4);
    indPeak(n,n.lv,1);
    return {level:n.lv, delta:p.style==='geiger' ? n.raw*(+p.k) : n.d, id:n.tid, alarm:n.lv>=+p.thr ? 1 : 0, tone:n.lv>.02 ? 200+1800*n.lv : 0}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, st=p.style, lv=n.lv, thr=+p.thr;
    indWire(n,cv,{down:()=>{ if(n.cur) n.base=n.cur.slice(); n.tid=50; }});
    cx.clearRect(0,0,W,H); pnPlate(cx,W,H);
    const m=Math.max(6,H*.05), ink='#cfd6dc', zone=f=>f>=.8 ? '#ff4a3a' : f>=.5 ? '#ffb23a' : '#4fe08a';
    const lbl=(t,x,y,a,sz)=>{ cx.fillStyle='#8c949c'; cx.font=Math.max(8,sz)+'px monospace'; cx.textAlign=a||'left'; cx.textBaseline='top'; cx.fillText(t,x,y); };
    if(st==='metal'){
      const lw=W*.58, R=Math.min(lw/2-m,H-2*m-8), X=lw/2+m*.5, Y=H-m-8;
      cx.fillStyle='#07090a'; pnRound(cx,m,m,lw,H-2*m,8); cx.fill();
      // дуга шкалы с зонами
      for(let i=0;i<60;i++){ const a0=Math.PI+Math.PI*i/60, f=i/60; cx.beginPath(); cx.arc(X,Y,R,a0,a0+Math.PI/60+.01);
        cx.strokeStyle=zone(f); cx.globalAlpha=lv>f ? 1 : .18; cx.lineWidth=Math.max(5,R*.09); cx.stroke(); }
      cx.globalAlpha=1; cx.strokeStyle='#8c949c'; cx.lineWidth=1;
      for(let i=0;i<=10;i++){ const a=Math.PI+Math.PI*i/10, r1=R-R*.13, r2=R-R*.2; cx.beginPath(); cx.moveTo(X+Math.cos(a)*r1,Y+Math.sin(a)*r1); cx.lineTo(X+Math.cos(a)*r2,Y+Math.sin(a)*r2); cx.stroke(); }
      const a=Math.PI+Math.PI*lv; cx.strokeStyle='#ff5a3c'; cx.lineWidth=Math.max(2,R*.03); cx.shadowColor='#ff5a3c'; cx.shadowBlur=6;
      cx.beginPath(); cx.moveTo(X,Y); cx.lineTo(X+Math.cos(a)*(R-R*.1),Y+Math.sin(a)*(R-R*.1)); cx.stroke(); cx.shadowBlur=0;
      cx.fillStyle=ink; cx.beginPath(); cx.arc(X,Y,R*.06,0,7); cx.fill();
      if(n.pk>.02){ const ap=Math.PI+Math.PI*n.pk; cx.fillStyle='#ffd24a'; cx.beginPath(); cx.arc(X+Math.cos(ap)*(R+3),Y+Math.sin(ap)*(R+3),2.5,0,7); cx.fill(); }
      lbl('SIGNAL',m+6,m+4,'left',H*.07);
      // справа: ID цели, шкала FE / NON-FE, глубина
      const rx=lw+m*2, rw=W-rx-m;
      lbl('TARGET ID',rx,m+4,'left',H*.07);
      const live=n.act && lv>.04, h=Math.min(H*.34,rw*.5);
      pnSegStr(cx,live ? String(n.tid).padStart(2,' ') : '--',rx+rw,m+H*.16,h,'#ffb23a',PN_DIM,2);
      const sy=m+H*.16+h+H*.1, sw=rw;
      cx.strokeStyle='#8c949c'; cx.lineWidth=1; cx.strokeRect(rx+.5,sy+.5,sw,H*.05);
      const gr=cx.createLinearGradient(rx,0,rx+sw,0); gr.addColorStop(0,'#4aa8ff'); gr.addColorStop(1,'#ff7a3a'); cx.globalAlpha=.55; cx.fillStyle=gr; cx.fillRect(rx+1,sy+1,sw-1,H*.05-1); cx.globalAlpha=1;
      if(live){ const xx=rx+sw*n.tid/99; cx.fillStyle='#fff'; cx.beginPath(); cx.moveTo(xx,sy+H*.05+2); cx.lineTo(xx-4,sy+H*.05+9); cx.lineTo(xx+4,sy+H*.05+9); cx.fill(); }
      lbl('weaker',rx,sy+H*.05+4,'left',H*.055); lbl('stronger',rx+sw,sy+H*.05+4,'right',H*.055);
      const dy=H-m-H*.1;
      for(let i=0;i<5;i++){ cx.fillStyle=zone(i/5); cx.globalAlpha=lv>(i+.5)/5*.95 ? 1 : .15; cx.fillRect(rx+i*(sw/5)+1,dy,sw/5-3,H*.07); }
      cx.globalAlpha=1;
    } else if(st==='bug'){
      const N=14, gw=(W-2*m)/N, hh=H*.34, y0=H*.18;
      for(let i=0;i<N;i++){ const f=i/(N-1), on=lv*N>i+.2, c=zone(f);
        cx.save(); cx.fillStyle=c; cx.globalAlpha=on ? 1 : .12; if(on){ cx.shadowColor=c; cx.shadowBlur=8; }
        cx.fillRect(m+i*gw+2,y0+hh*(1-.35-.65*f),gw-4,hh*(.35+.65*f)); cx.restore(); }
      const pi=Math.round(n.pk*(N-1)); if(n.pk>.02){ cx.fillStyle='#fff'; cx.fillRect(m+pi*gw+2,y0+hh+4,gw-4,3); }
      pnSegStr(cx,n.act ? (p.style==='bug' ? (lv*100).toFixed(0) : '0') : '--',W-m-H*.3,H*.6,H*.24,'#4fe08a',PN_DIM,3);
      lbl('FIELD %',m+2,H*.62,'left',H*.07); lbl('SENS ×'+(+p.sens).toFixed(1),m+2,H*.74,'left',H*.07);
      lbl('click: re-zero',m+2,H-m-H*.07,'left',H*.06);
    } else if(st==='emf'){
      const cols=['#4fe08a','#4fe08a','#ffb23a','#ff6a3a','#ff3a3a'], r=Math.min((W-2*m)/10,H*.2);
      for(let i=0;i<5;i++){ const on=lv>(i+.4)/5*.95 || (i===0 && n.act && lv>.02), x=m+(W-2*m)*(i+.5)/5, y=H*.32;
        cx.save(); cx.fillStyle=cols[i]; cx.globalAlpha=on ? 1 : .13; if(on){ cx.shadowColor=cols[i]; cx.shadowBlur=r*1.2; }
        cx.beginPath(); cx.arc(x,y,r,0,7); cx.fill(); cx.restore();
        cx.strokeStyle='#000'; cx.lineWidth=2; cx.beginPath(); cx.arc(x,y,r,0,7); cx.stroke(); }
      pnSegStr(cx,n.act ? (+n.d).toFixed(2) : '--',W-m-H*.16,H*.58,H*.26,'#ffb23a',PN_DIM,5);
      cx.fillStyle=ink; cx.font='bold '+H*.1+'px monospace'; cx.textAlign='left'; cx.textBaseline='bottom'; cx.fillText(p.unit,W-m-H*.14,H*.84);
      lbl('EMF',m+2,H*.62,'left',H*.08);
    } else {
      const cs=Math.min(H*.36,W*.22), X=m+cs+4, Y=H*.46, an=lv>.02 ? Math.min(1,.4+lv) : .35;
      cx.save(); cx.translate(X,Y);
      for(let i=0;i<3;i++){ cx.beginPath(); cx.moveTo(0,0); const a0=-Math.PI/2+i*2*Math.PI/3-Math.PI/6, a1=a0+Math.PI/3; cx.arc(0,0,cs,a0,a1); cx.closePath();
        cx.fillStyle='#ffd24a'; cx.globalAlpha=an; if(lv>.05){ cx.shadowColor='#ffd24a'; cx.shadowBlur=10; } cx.fill(); cx.shadowBlur=0; }
      cx.globalAlpha=1; cx.fillStyle='#0b0d0e'; cx.beginPath(); cx.arc(0,0,cs*.2,0,7); cx.fill(); cx.restore();
      const hx=X+cs+m, hw=W-hx-m;
      pnSegStr(cx,n.act ? String(Math.round(n.raw)) : '--',hx+hw,H*.12,H*.3,'#ffb23a',PN_DIM,5);
      lbl('CPM',hx,H*.12+H*.31,'left',H*.07);
      cx.fillStyle=ink; cx.font='bold '+H*.1+'px monospace'; cx.textAlign='right'; cx.textBaseline='top';
      cx.fillText(n.act ? (n.raw*(+p.k)).toFixed(2)+' µSv/h' : '',hx+hw,H*.55);
      cx.fillStyle='#07090a'; cx.fillRect(hx,H*.8,hw,H*.08);
      for(let i=0;i<20;i++){ const f=i/20; cx.fillStyle=zone(f); cx.globalAlpha=lv>f ? 1 : .15; cx.fillRect(hx+i*hw/20+1,H*.8,hw/20-2,H*.08); }
      cx.globalAlpha=1;
    }
    if(lv>=thr && n.act){ cx.fillStyle='#ff3a3a'; cx.shadowColor='#ff3a3a'; cx.shadowBlur=10; cx.beginPath(); cx.arc(W-m-5,m+5,4,0,7); cx.fill(); cx.shadowBlur=0; }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Needle Meter (стрелочный индикатор уровня) ---------- */
def({ id:'vumeter', lazy:'proc', title:'Needle Meter', cat:'Indicators', kw:'vu analog panel meter level needle ammeter voltmeter backlit dial',
  ins:n=>+n.p.channels===2 ? [{n:'in',t:'num'},{n:'in2',t:'num'}] : [{n:'in',t:'num'}],
  view:{h:140}, w:300, resize:true,
  params:[{n:'channels',t:'select',opts:['1','2'],d:'1',fn:pnPortsFix},
          {n:'min',t:'num',d:-20},{n:'max',t:'num',d:3},
          {n:'red',t:'num',d:0,label:'red zone from'},
          {n:'unit',t:'text',d:'VU'},
          {n:'ticks',t:'range',min:3,max:12,step:1,d:8,label:'labels'},
          {n:'face',t:'text',d:'cream',label:'dial colour: '+Object.keys(PN_FACE).join(', ')+' or #rrggbb'},
          {n:'lit',t:'range',min:0,max:1,step:.05,d:.5,label:'backlight glow'},
          {n:'attack',t:'range',min:0,max:1,step:.01,d:.15,label:'attack, s'},
          {n:'fall',t:'range',min:0,max:2,step:.01,d:.3,label:'fall, s'}],
  init:n=>{ n.v=[null,null]; n.sv=[0,0]; n.pkl=[0,0]; },
  process(n,I){
    const p=n.p, lo=+p.min, N=+p.channels===2 ? 2 : 1;
    for(let c=0;c<N;c++){
      const v=indNum(I[c ? 'in2' : 'in']); n.v[c]=v;
      const x=v===null ? lo : clamp(v,Math.min(p.min,p.max),Math.max(p.min,p.max));
      n.sv[c]=indSmooth(n.sv[c],x,x>n.sv[c] ? +p.attack : +p.fall);
      n.pkl[c]= v!==null && v>=+p.red ? 1 : Math.max(0,n.pkl[c]-indDt()*3);
    }
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, N=+p.channels===2 ? 2 : 1, face=pnFace(p.face), dk=pnDark(face);
    const lo=+p.min, hi=+p.max, rng=hi-lo||1, ink=dk ? '#e6e9ec' : '#2a2418';
    cx.clearRect(0,0,W,H);
    const pw=(W-(N+1)*4)/N, m=Math.max(3,H*.03);
    for(let c=0;c<N;c++){
      const x0=4+c*(pw+4), y0=m, ph=H-2*m, cxm=x0+pw/2;
      cx.save(); pnRound(cx,x0,y0,pw,ph,Math.min(10,ph*.08)); cx.clip();
      const rg=cx.createRadialGradient(cxm,y0+ph*.55,ph*.05,cxm,y0+ph*.55,pw*.75); rg.addColorStop(0,face); rg.addColorStop(1,dk ? '#0a0c0e' : '#b9ae82');
      cx.fillStyle=face; cx.fillRect(x0,y0,pw,ph); cx.globalAlpha=.5+.5*(+p.lit); cx.fillStyle=rg; cx.fillRect(x0,y0,pw,ph); cx.globalAlpha=1;
      const R=Math.min(ph*1.05,pw*1.1), PX=cxm, PY=y0+ph*1.12, rs=Math.min(R*.9,PY-y0-ph*.16);
      const A=Math.min(Math.PI*.3,Math.asin(clamp((pw/2-6)/rs,.2,1)));                // шкала не шире панели
      const ang=v=>-A+2*A*clamp((v-lo)/rng,0,1), pt=(a,r)=>[PX+Math.sin(a)*r,PY-Math.cos(a)*r];
      const rd=clamp(+p.red,lo,hi);
      cx.lineWidth=Math.max(2,R*.025); cx.strokeStyle=ink; cx.beginPath(); cx.arc(PX,PY,rs,-Math.PI/2+ang(lo),-Math.PI/2+ang(rd)); cx.stroke();
      cx.strokeStyle='#d8352a'; cx.lineWidth=Math.max(4,R*.05); cx.beginPath(); cx.arc(PX,PY,rs,-Math.PI/2+ang(rd),-Math.PI/2+ang(hi)); cx.stroke();
      cx.fillStyle=ink; cx.font=Math.max(7,Math.min(11,ph*.085))+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle'; cx.lineWidth=1; cx.strokeStyle=ink;
      const mag=Math.pow(10,Math.floor(Math.log10(rng/Math.max(2,p.ticks)))), cand=[1,2,5,10].map(q=>q*mag), step=cand.find(q=>rng/q<=p.ticks) || cand[3];   // подписи — круглые числа
      for(let v=Math.ceil(lo/step-1e-9)*step; v<=hi+1e-9; v+=step){ const a=ang(v), [x1,y1]=pt(a,rs-R*.01), [x2,y2]=pt(a,rs-R*.08), [x3,y3]=pt(a,rs-R*.15);
        cx.beginPath(); cx.moveTo(x1,y1); cx.lineTo(x2,y2); cx.stroke(); cx.fillText(indFmt(+v.toFixed(6)),x3,y3);
        for(let q=1;q<5;q++){ const w=v+step*q/5; if(w>hi) break; const [a1,b1]=pt(ang(w),rs-R*.01), [a2,b2]=pt(ang(w),rs-R*.04); cx.beginPath(); cx.moveTo(a1,b1); cx.lineTo(a2,b2); cx.stroke(); } }
      cx.font='bold '+Math.max(9,ph*.18)+'px '+PN_FONT; cx.fillText(p.unit,cxm,y0+ph*.62);
      // стрелка с тенью
      const a=ang(n.sv[c]), [tx,ty]=pt(a,rs+R*.03);
      cx.save(); cx.shadowColor='rgba(0,0,0,.35)'; cx.shadowBlur=4; cx.shadowOffsetX=2; cx.shadowOffsetY=2;
      cx.strokeStyle=dk ? '#ff9a3a' : '#111'; cx.lineWidth=Math.max(1.4,R*.02); cx.beginPath(); cx.moveTo(PX,PY); cx.lineTo(tx,ty); cx.stroke(); cx.restore();
      // лампа пика
      cx.save(); const lx=x0+pw-ph*.1, ly=y0+ph*.12, lr=Math.max(3,ph*.045); cx.fillStyle='#ff3a2a'; cx.globalAlpha=.15+.85*n.pkl[c];
      if(n.pkl[c]>.2){ cx.shadowColor='#ff3a2a'; cx.shadowBlur=lr*2.5; } cx.beginPath(); cx.arc(lx,ly,lr,0,7); cx.fill(); cx.restore();
      // стекло
      cx.fillStyle='rgba(255,255,255,.07)'; cx.beginPath(); cx.moveTo(x0,y0); cx.lineTo(x0+pw*.7,y0); cx.lineTo(x0,y0+ph*.55); cx.closePath(); cx.fill();
      cx.restore();
      cx.strokeStyle='#15171a'; cx.lineWidth=3; pnRound(cx,x0,y0,pw,ph,Math.min(10,ph*.08)); cx.stroke();
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- S-Meter (needle): стрелочный S-метр приёмника ---------- */
// Общие куски: панель-стекло, стрелка с тенью. Угол шкалы — как у Needle Meter: стрелка качается вокруг точки под панелью.
function pnNeedleFace(cx,x0,y0,pw,ph,face,dk,lit){
  const cxm=x0+pw/2, rg=cx.createRadialGradient(cxm,y0+ph*.55,ph*.05,cxm,y0+ph*.55,pw*.75);
  rg.addColorStop(0,face); rg.addColorStop(1,dk ? '#0a0c0e' : '#b9ae82');
  cx.fillStyle=face; cx.fillRect(x0,y0,pw,ph); cx.globalAlpha=.5+.5*lit; cx.fillStyle=rg; cx.fillRect(x0,y0,pw,ph); cx.globalAlpha=1;
}
function pnNeedle(cx,PX,PY,tx,ty,w,col){
  cx.save(); cx.shadowColor='rgba(0,0,0,.35)'; cx.shadowBlur=4; cx.shadowOffsetX=2; cx.shadowOffsetY=2;
  cx.strokeStyle=col; cx.lineWidth=w; cx.lineCap='round'; cx.beginPath(); cx.moveTo(PX,PY); cx.lineTo(tx,ty); cx.stroke(); cx.restore();
}
function pnGlass(cx,x0,y0,pw,ph){
  cx.fillStyle='rgba(255,255,255,.07)'; cx.beginPath(); cx.moveTo(x0,y0); cx.lineTo(x0+pw*.7,y0); cx.lineTo(x0,y0+ph*.55); cx.closePath(); cx.fill();
  cx.restore(); cx.strokeStyle='#15171a'; cx.lineWidth=3; pnRound(cx,x0,y0,pw,ph,Math.min(10,ph*.08)); cx.stroke();
}
def({ id:'smeterneedle', lazy:'proc', title:'S-Meter (needle)', cat:'Indicators', kw:'s meter signal strength receiver analog needle rssi s9 dbm ham radio',
  ins:[{n:'in',t:'num'}], outs:[{n:'s',t:'num'}], view:{h:130}, w:280, resize:true,
  params:[{n:'s9',t:'num',d:-73,label:'S9 level, dBm (−73 HF, −93 VHF)'},
          {n:'face',t:'text',d:'cream',label:'dial colour: '+Object.keys(PN_FACE).join(', ')+' or #rrggbb'},
          {n:'lit',t:'range',min:0,max:1,step:.05,d:.6,label:'backlight glow'},
          {n:'attack',t:'range',min:0,max:1,step:.005,d:.04,label:'attack, s'},
          {n:'fall',t:'range',min:0,max:3,step:.01,d:.6,label:'fall, s'},
          {n:'peak',t:'check',d:true,label:'peak hold marker'}],
  init:n=>{ n.v=null; n.sv=-Infinity; n.pk=-Infinity; n.pt=0; },
  process(n,I){
    const p=n.p, v=indNum(I.in); n.v=v;
    if(v===null){ n.sv=indSmooth(isFinite(n.sv) ? n.sv : +p.s9-54,+p.s9-54,+p.fall); return {s:null}; }
    if(!isFinite(n.sv)) n.sv=v;
    n.sv=indSmooth(n.sv,v,v>n.sv ? +p.attack : +p.fall); indPeak(n,n.sv,60);
    return {s:n.sv<p.s9-54 ? 0 : 9+(n.sv-p.s9)/6}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, s9=+p.s9, face=pnFace(p.face), dk=pnDark(face), ink=dk ? '#e6e9ec' : '#2a2418';
    cx.clearRect(0,0,W,H);
    const m=Math.max(3,H*.03), x0=4, y0=m, pw=W-8, ph=H-2*m, cxm=x0+pw/2;
    cx.save(); pnRound(cx,x0,y0,pw,ph,Math.min(10,ph*.08)); cx.clip(); pnNeedleFace(cx,x0,y0,pw,ph,face,dk,+p.lit);
    const R=Math.min(ph*1.05,pw*.8), PX=cxm, PY=y0+ph*1.12, rs=Math.min(R*.9,PY-y0-ph*.2);
    const A=Math.min(Math.PI*.33,Math.asin(clamp((pw/2-10)/rs,.2,1))), ang=f=>-A+2*A*clamp(f,0,1), pt=(a,r)=>[PX+Math.sin(a)*r,PY-Math.cos(a)*r];
    cx.lineWidth=Math.max(1.5,R*.02); cx.strokeStyle=ink; cx.beginPath(); cx.arc(PX,PY,rs,-Math.PI/2+ang(0),-Math.PI/2+ang(.6)); cx.stroke();
    cx.strokeStyle='#d8352a'; cx.lineWidth=Math.max(3,R*.045); cx.beginPath(); cx.arc(PX,PY,rs,-Math.PI/2+ang(.6),-Math.PI/2+ang(1)); cx.stroke();
    const fs=Math.max(7,Math.min(12,ph*.1)); cx.font=fs+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillStyle=ink; cx.lineWidth=1;
    const tick=(f,label,long,red)=>{ const a=ang(f), [x1,y1]=pt(a,rs), [x2,y2]=pt(a,rs-R*(long ? .09 : .05)), [x3,y3]=pt(a,rs-R*.17);
      cx.strokeStyle=red ? '#d8352a' : ink; cx.fillStyle=red ? '#d8352a' : ink; cx.beginPath(); cx.moveTo(x1,y1); cx.lineTo(x2,y2); cx.stroke(); if(label) cx.fillText(label,x3,y3); };
    for(let s=1;s<=9;s++) tick(s/9*.6,s%2===1 ? String(s) : '',s%2===1,false);
    for(const o of [20,40,60]) tick(.6+o/60*.4,'+'+o,true,true);
    cx.fillStyle=ink; cx.font='bold '+Math.max(9,ph*.15)+'px '+PN_FONT; cx.fillText('S',cxm,y0+ph*.5);
    cx.font=Math.max(7,ph*.09)+'px monospace'; cx.textAlign='left'; cx.fillText(n.v===null ? '—' : indFmt(n.v)+' dBm',x0+8,y0+ph-fs-2);
    cx.textAlign='right'; cx.fillText(n.v===null ? '' : SM_NAME(n.sv,s9),x0+pw-8,y0+ph-fs-2);
    if(p.peak && isFinite(n.pk)){ const [a1,b1]=pt(ang(SM_FRAC(n.pk,s9)),rs+R*.01), [a2,b2]=pt(ang(SM_FRAC(n.pk,s9)),rs-R*.06); cx.strokeStyle='#e08a1e'; cx.lineWidth=Math.max(2,R*.03); cx.beginPath(); cx.moveTo(a1,b1); cx.lineTo(a2,b2); cx.stroke(); }
    const [tx,ty]=pt(ang(isFinite(n.sv) ? SM_FRAC(n.sv,s9) : 0),rs+R*.03); pnNeedle(cx,PX,PY,tx,ty,Math.max(1.4,R*.022),dk ? '#ff9a3a' : '#111');
    pnGlass(cx,x0,y0,pw,ph); cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- SWR / Power meter (перекрёстные стрелки) ---------- */
// Левая стрелка — прямая мощность, правая — отражённая; SWR считается из них. Как у Diamond SX / Daiwa CN.
def({ id:'swrmeter', lazy:'proc', title:'SWR / Power Meter (cross needle)', cat:'Indicators', kw:'swr power watt forward reflected cross needle vswr antenna analyzer tuner diamond',
  ins:[{n:'fwd',t:'num'},{n:'ref',t:'num'}], outs:[{n:'swr',t:'num'}], view:{h:150}, w:300, resize:true,
  params:[{n:'max',t:'num',d:100,label:'forward full scale, W'},
          {n:'refmax',t:'num',d:20,label:'reflected full scale, W'},
          {n:'warn',t:'num',d:3,label:'SWR warning above'},
          {n:'face',t:'text',d:'cream',label:'dial colour: '+Object.keys(PN_FACE).join(', ')+' or #rrggbb'},
          {n:'lit',t:'range',min:0,max:1,step:.05,d:.5,label:'backlight glow'},
          {n:'tau',t:'range',min:0,max:1.5,step:.01,d:.12,label:'needle damping, s'}],
  init:n=>{ n.f=null; n.r=null; n.sf=0; n.sr=0; n.swr=null; },
  process(n,I){
    const p=n.p, f=indNum(I.fwd), r=indNum(I.ref); n.f=f; n.r=r;
    n.sf=indSmooth(n.sf,clamp(f===null ? 0 : f,0,+p.max),+p.tau); n.sr=indSmooth(n.sr,clamp(r===null ? 0 : r,0,+p.refmax),+p.tau);
    if(f!==null && r!==null && f>0.01){ const g=Math.sqrt(clamp(r/f,0,.9999)); n.swr=(1+g)/(1-g); } else n.swr=null;
    return {swr:n.swr}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, face=pnFace(p.face), dk=pnDark(face), ink=dk ? '#e6e9ec' : '#2a2418';
    cx.clearRect(0,0,W,H);
    const m=Math.max(3,H*.03), x0=4, y0=m, pw=W-8, ph=H-2*m;
    cx.save(); pnRound(cx,x0,y0,pw,ph,Math.min(10,ph*.08)); cx.clip(); pnNeedleFace(cx,x0,y0,pw,ph,face,dk,+p.lit);
    const L=Math.min(ph*.86,pw*.78), D=Math.PI/180, PYb=y0+ph*.97, PXl=x0+pw*.07, PXr=x0+pw*.93;
    // угол стрелки от оси +x: левая 80°→20°, правая 100°→160°
    const aL=t=>(80-60*clamp(t,0,1))*D, aR=t=>(100+60*clamp(t,0,1))*D;
    const scale=(PX,aF,max,label,col)=>{
      cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=Math.max(1.5,L*.015); cx.beginPath();
      for(let i=0;i<=40;i++){ const a=aF(i/40), x=PX+Math.cos(a)*L, y=PYb-Math.sin(a)*L; i ? cx.lineTo(x,y) : cx.moveTo(x,y); } cx.stroke();
      const mag=Math.pow(10,Math.floor(Math.log10(max/4))), st=[1,2,5,10].map(q=>q*mag).find(q=>max/q<=6) || mag*10;
      cx.font=Math.max(7,Math.min(11,ph*.085))+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle'; cx.lineWidth=1;
      for(let v=0; v<=max+1e-9; v+=st){ const a=aF(v/max), c=Math.cos(a), s=Math.sin(a);
        cx.beginPath(); cx.moveTo(PX+c*L,PYb-s*L); cx.lineTo(PX+c*(L-L*.07),PYb-s*(L-L*.07)); cx.stroke();
        cx.fillText(indFmt(+v.toPrecision(4)),PX+c*(L-L*.16),PYb-s*(L-L*.16)); }
      cx.font='bold '+Math.max(8,ph*.1)+'px '+PN_FONT; const a=aF(.5); cx.fillText(label,PX+Math.cos(a)*(L-L*.34),PYb-Math.sin(a)*(L-L*.34)); };
    scale(PXl,aL,+p.max,'FWD W',ink); scale(PXr,aR,+p.refmax,'REF W',dk ? '#ff8a6a' : '#b02a1a');
    const swr=n.swr, bad=swr!==null && swr>=+p.warn;
    cx.font='bold '+Math.max(9,ph*.14)+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='top'; cx.fillStyle=bad ? '#d8352a' : ink;
    cx.fillText(swr===null ? 'SWR —' : 'SWR '+(swr>=99 ? '∞' : swr.toFixed(swr<10 ? 2 : 1)),x0+pw/2,y0+ph*.08);
    pnNeedle(cx,PXl,PYb,PXl+Math.cos(aL(n.sf/(+p.max||1)))*(L+3),PYb-Math.sin(aL(n.sf/(+p.max||1)))*(L+3),Math.max(1.4,L*.017),dk ? '#ffd24a' : '#111');
    pnNeedle(cx,PXr,PYb,PXr+Math.cos(aR(n.sr/(+p.refmax||1)))*(L+3),PYb-Math.sin(aR(n.sr/(+p.refmax||1)))*(L+3),Math.max(1.4,L*.017),dk ? '#ff6a4a' : '#b02a1a');
    cx.fillStyle='#15171a'; for(const X of [PXl,PXr]){ cx.beginPath(); cx.arc(X,PYb,Math.max(3,L*.035),0,7); cx.fill(); }
    pnGlass(cx,x0,y0,pw,ph); cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Tuning Meter (центр-ноль: расстройка / дискриминатор) ---------- */
def({ id:'tunemeter', lazy:'proc', title:'Tuning Meter (centre zero)', cat:'Indicators', kw:'centre zero center discriminator afc tuning offset error needle analog fm deviation',
  ins:[{n:'in',t:'num'}], outs:[{n:'tuned',t:'num'}], view:{h:120}, w:260, resize:true,
  params:[{n:'range',t:'num',d:5000,label:'scale ± (same unit as the input)'},
          {n:'tol',t:'num',d:500,label:'«in tune» band ±'},
          {n:'unit',t:'text',d:'Hz'},
          {n:'face',t:'text',d:'cream',label:'dial colour: '+Object.keys(PN_FACE).join(', ')+' or #rrggbb'},
          {n:'lit',t:'range',min:0,max:1,step:.05,d:.5,label:'backlight glow'},
          {n:'tau',t:'range',min:0,max:2,step:.01,d:.25,label:'needle damping, s'}],
  init:n=>{ n.v=null; n.sv=0; n.ok=0; },
  process(n,I){
    const p=n.p, v=indNum(I.in), R=Math.abs(+p.range)||1; n.v=v;
    n.sv=indSmooth(n.sv,v===null ? 0 : clamp(v,-R,R),+p.tau); n.ok=v!==null && Math.abs(v)<=+p.tol ? 1 : 0;
    return {tuned:n.ok}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, R0=Math.abs(+p.range)||1, face=pnFace(p.face), dk=pnDark(face), ink=dk ? '#e6e9ec' : '#2a2418';
    cx.clearRect(0,0,W,H);
    const m=Math.max(3,H*.03), x0=4, y0=m, pw=W-8, ph=H-2*m, cxm=x0+pw/2;
    cx.save(); pnRound(cx,x0,y0,pw,ph,Math.min(10,ph*.08)); cx.clip(); pnNeedleFace(cx,x0,y0,pw,ph,face,dk,+p.lit);
    const R=Math.min(ph*1.05,pw*.8), PX=cxm, PY=y0+ph*1.12, rs=Math.min(R*.9,PY-y0-ph*.2);
    const A=Math.min(Math.PI*.33,Math.asin(clamp((pw/2-10)/rs,.2,1))), ang=f=>A*clamp(f,-1,1), pt=(a,r)=>[PX+Math.sin(a)*r,PY-Math.cos(a)*r];
    const tl=clamp((+p.tol)/R0,0,1);
    cx.lineWidth=Math.max(1.5,R*.02); cx.strokeStyle=ink; cx.beginPath(); cx.arc(PX,PY,rs,-Math.PI/2-A,-Math.PI/2+A); cx.stroke();
    cx.strokeStyle=n.ok ? '#2fc45a' : '#5a9a6a'; cx.lineWidth=Math.max(4,R*.05); cx.beginPath(); cx.arc(PX,PY,rs,-Math.PI/2-ang(tl),-Math.PI/2+ang(tl)); cx.stroke();
    const fs=Math.max(7,Math.min(12,ph*.1)); cx.font=fs+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillStyle=ink; cx.strokeStyle=ink; cx.lineWidth=1;
    for(let i=-5;i<=5;i++){ const f=i/5, a=ang(f), [x1,y1]=pt(a,rs), [x2,y2]=pt(a,rs-R*(i%5===0 ? .1 : .06)), [x3,y3]=pt(a,rs-R*.18);
      cx.beginPath(); cx.moveTo(x1,y1); cx.lineTo(x2,y2); cx.stroke(); if(i%5===0 || i===0) cx.fillText(i===0 ? '0' : (i<0 ? '−' : '+')+indFmt(R0),x3,y3); }
    cx.font='bold '+Math.max(9,ph*.15)+'px '+PN_FONT; cx.fillText(p.unit,cxm,y0+ph*.52);
    cx.font=Math.max(7,ph*.09)+'px monospace'; cx.fillText(n.v===null ? '—' : (n.v>0 ? '+' : '')+indFmt(n.v)+' '+p.unit,cxm,y0+ph-fs-2);
    const [tx,ty]=pt(ang(n.sv/R0),rs+R*.03); pnNeedle(cx,PX,PY,tx,ty,Math.max(1.4,R*.022),dk ? '#ff9a3a' : '#111');
    pnGlass(cx,x0,y0,pw,ph); cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Speedometer (спидометр с одометром и суточным пробегом) ---------- */
const SP_MS={'m/s':1,'km/h':1/3.6,'mph':.44704,'kn':.514444};
const SP_DIST={'km/h':['km',1000],'mph':['mi',1609.344],'m/s':['km',1000],'kn':['nm',1852]};
def({ id:'speedo', lazy:'proc', title:'Speedometer', cat:'Indicators', kw:'speed odometer trip distance gps car dashboard mileage drum',
  ins:[{n:'in',t:'num'},{n:'reset',t:'num'}], outs:[{n:'speed',t:'num'},{n:'odo',t:'num'},{n:'trip',t:'num'}],
  view:{h:230}, w:260, resize:true,
  params:[{n:'inunit',t:'select',opts:Object.keys(SP_MS),d:'m/s',label:'wire carries (GPS speed is m/s)'},
          {n:'unit',t:'select',opts:Object.keys(SP_MS),d:'km/h',label:'dial shows'},
          {n:'max',t:'num',d:200,label:'full scale'},
          {n:'red',t:'num',d:140,label:'red zone from'},
          {n:'tau',t:'range',min:0,max:2,step:.01,d:.2,label:'needle damping, s'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ const a=ctlParse(n.p.state,2,0); n.odo=a[0]; n.trip=a[1]; n.sv=0; n.v=null; n.pr=0; n.sT=0; },
  process(n,I){
    const p=n.p, v=indNum(I.in); n.v=v;
    const ms= v===null ? 0 : Math.max(0,v)*SP_MS[p.inunit||'m/s'], disp=ms/SP_MS[p.unit||'km/h'];
    n.sv=indSmooth(n.sv,clamp(disp,0,+p.max||1),+p.tau);
    const dt=indDt(); n.odo+=ms*dt; n.trip+=ms*dt;
    const r= +I.reset>0 ? 1 : 0; if(r && !n.pr) n.trip=0; n.pr=r;
    if((n.sT-=dt)<=0){ n.sT=2; p.state=+n.odo.toFixed(1)+','+(+n.trip.toFixed(1)); }
    const [, m1]=SP_DIST[p.unit||'km/h'];
    return {speed:v===null ? null : disp, odo:n.odo/m1, trip:n.trip/m1}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, max=+p.max||1, [du,m1]=SP_DIST[p.unit||'km/h'];
    indWire(n,cv,{down:(x,y)=>{ if(y>H*.66){ n.trip=0; redraw(n); } }});
    cx.clearRect(0,0,W,H);
    const R=Math.min(W/2-4,(H-8)*.42), X=W/2, Y=R+4;
    const bz=cx.createRadialGradient(X,Y,R*.8,X,Y,R); bz.addColorStop(0,'#181b1e'); bz.addColorStop(.92,'#0b0c0e'); bz.addColorStop(1,'#6b727a');
    cx.fillStyle=bz; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.fill();
    const A0=Math.PI*.75, SW=Math.PI*1.5, ang=v=>A0+SW*clamp(v/max,0,1);
    const rd=clamp(+p.red,0,max);
    cx.lineWidth=R*.035; cx.strokeStyle='#d8352a'; cx.beginPath(); cx.arc(X,Y,R*.9,ang(rd),ang(max)); cx.stroke();
    const step=max<=60 ? 5 : max<=120 ? 10 : max<=260 ? 20 : max<=600 ? 50 : 100;
    cx.fillStyle='#eceae2'; cx.strokeStyle='#eceae2'; cx.textAlign='center'; cx.textBaseline='middle'; cx.font='bold '+Math.max(8,R*.12)+'px '+PN_FONT;
    for(let v=0;v<=max+1e-6;v+=step/2){
      const a=ang(v), major=Math.abs(v/step-Math.round(v/step))<1e-6, r1=R*.86, r2=r1-R*(major ? .1 : .05);
      cx.lineWidth=major ? 2 : 1; cx.beginPath(); cx.moveTo(X+Math.cos(a)*r1,Y+Math.sin(a)*r1); cx.lineTo(X+Math.cos(a)*r2,Y+Math.sin(a)*r2); cx.stroke();
      if(major){ const r3=r2-R*.12; cx.fillText(indFmt(v),X+Math.cos(a)*r3,Y+Math.sin(a)*r3); }
    }
    cx.font='bold '+Math.max(8,R*.1)+'px '+PN_FONT; cx.fillStyle='#9aa1a8'; cx.fillText(p.unit,X,Y+R*.62);
    pnSegStr(cx,n.v===null ? '---' : String(Math.round(n.sv)),X+R*.3,Y+R*.26,R*.22,'#ffb23a',PN_DIM,3);
    // стрелка
    const a=ang(n.sv), tipR=R*.84;
    cx.save(); cx.shadowColor='rgba(255,60,40,.7)'; cx.shadowBlur=8; cx.strokeStyle='#ff4a30'; cx.lineWidth=Math.max(2,R*.03); cx.lineCap='round';
    cx.beginPath(); cx.moveTo(X-Math.cos(a)*R*.12,Y-Math.sin(a)*R*.12); cx.lineTo(X+Math.cos(a)*tipR,Y+Math.sin(a)*tipR); cx.stroke(); cx.restore();
    cx.fillStyle='#2a2d31'; cx.beginPath(); cx.arc(X,Y,R*.07,0,7); cx.fill(); cx.strokeStyle='#8a9098'; cx.lineWidth=1.5; cx.stroke();
    // одометр и суточный пробег
    const cw=Math.min(R*.16,(W-8)/9), ch=cw*1.45, ox=X-cw*3.5;
    pnDrum(cx,ox,Y+R*.74,cw,ch,n.odo/m1*10,7,true);
    cx.fillStyle='#9aa1a8'; cx.font=Math.max(8,R*.09)+'px monospace'; cx.textAlign='left'; cx.fillText(du,ox+cw*7+3,Y+R*.74+ch/2);
    pnDrum(cx,X-cw*2.2,Y+R*.74+ch+4,cw,ch*.85,n.trip/m1*10,5,true);
    cx.textAlign='right'; cx.fillText('TRIP',X-cw*2.2-4,Y+R*.74+ch+4+ch*.42);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Counter (механический барабан или светодиодный) ---------- */
def({ id:'counter', lazy:'proc', title:'Counter', cat:'Indicators', kw:'count totalizer tally events pulses drum odometer mechanical digits up down',
  ins:[{n:'in',t:'num'},{n:'up',t:'num'},{n:'down',t:'num'},{n:'reset',t:'num'}], outs:[{n:'count',t:'num'},{n:'hit',t:'num'}],
  view:{h:70}, w:260, resize:true,
  params:[{n:'style',t:'select',opts:['drum','led'],d:'drum'},
          {n:'digits',t:'range',min:2,max:10,step:1,d:6},
          {n:'step',t:'num',d:1,label:'step per pulse'},
          {n:'color',t:'text',d:'red',label:'LED colour: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'click',t:'check',d:false,label:'a click on the display adds a step'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.cnt=+n.p.state||0; n.pv={in:0,up:0,down:0,reset:0}; n.hit=0; },
  process(n,I){
    const p=n.p, st=+p.step||1; let ch=false;
    const edge=k=>{ const r=+I[k]>0 ? 1 : 0, f=r && !n.pv[k]; n.pv[k]=r; return f; };
    if(edge('in') || edge('up')){ n.cnt+=st; ch=true; }
    if(edge('down')){ n.cnt-=st; ch=true; }
    if(edge('reset')){ n.cnt=0; ch=true; }
    if(n.click){ n.cnt+=st; n.click=0; ch=true; }
    const lim=Math.pow(10,Math.round(p.digits));
    n.cnt=((n.cnt%lim)+lim)%lim;
    if(ch) p.state=String(+n.cnt.toFixed(6));
    return {count:n.cnt,hit:ch ? 1 : 0}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, D=Math.round(p.digits);
    indWire(n,cv,{down:()=>{ if(n.p.click) n.click=1; }});
    cx.clearRect(0,0,W,H);
    const cw=Math.min((W-12)/D,H*.62), ch=Math.min(H-10,cw*1.5), x0=(W-cw*D)/2, y0=(H-ch)/2;
    if(p.style==='led'){
      cx.fillStyle='#07090a'; pnRound(cx,x0-5,y0-4,cw*D+10,ch+8,6); cx.fill();
      pnSegStr(cx,String(Math.floor(n.cnt)).padStart(D,'0'),x0+cw*D,y0,ch,indColor(p.color),PN_DIM,D);
    } else {
      cx.fillStyle='#000'; pnRound(cx,x0-3,y0-3,cw*D+6,ch+6,3); cx.fill();
      pnDrum(cx,x0,y0,cw,ch,n.cnt,D,false);
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Nixie (газоразрядные индикаторы) ---------- */
def({ id:'nixie', lazy:'proc', title:'Nixie Tubes', cat:'Indicators', kw:'nixie tube neon glow vintage retro digits display',
  ins:[{n:'in',t:'num'}], view:{h:120}, w:340, resize:true,
  params:[{n:'digits',t:'range',min:1,max:12,step:1,d:6},
          {n:'decimals',t:'range',min:0,max:6,step:1,d:0},
          {n:'color',t:'text',d:'#ff7a1a',label:'glow: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'zeros',t:'check',d:false,label:'leading zeros'}],
  init:n=>{ n.v=null; },
  process(n,I){ n.v=indNum(I.in); return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, D=Math.round(p.digits), col=indColor(p.color);
    cx.clearRect(0,0,W,H);
    let s= n.v===null ? '-'.repeat(D) : Math.abs(n.v).toFixed(+p.decimals);
    if(n.v!==null && n.v<0) s='-'+s;
    if(p.zeros && n.v!==null) s=s.replace(/^(-?)(\d+)/,(m,sg,d)=>sg+d.padStart(D,'0'));
    const cells=[]; for(let i=0;i<s.length;i++){ if(s[i]==='.' && cells.length) cells[cells.length-1].dot=true; else cells.push({c:s[i],dot:false}); }
    const shown=cells.length>D ? Array.from({length:D},()=>({c:'-',dot:false})) : cells;
    const tw=Math.min((W-8)/D,H*.62), th=Math.min(H-8,tw*1.7), x0=(W-tw*D)/2, y0=(H-th)/2;
    for(let i=0;i<D;i++){
      const c=shown[i-(D-shown.length)], x=x0+i*tw+tw*.08, w=tw*.84;
      const g=cx.createLinearGradient(x,0,x+w,0); g.addColorStop(0,'rgba(255,255,255,.12)'); g.addColorStop(.3,'rgba(255,255,255,.02)'); g.addColorStop(1,'rgba(255,255,255,.08)');
      cx.fillStyle='#0a0705'; pnRound(cx,x,y0,w,th,w*.4); cx.fill(); cx.fillStyle=g; cx.fill();
      cx.strokeStyle='#3a342c'; cx.lineWidth=1.5; cx.stroke();
      cx.save(); pnRound(cx,x,y0,w,th,w*.4); cx.clip();
      cx.font='bold '+th*.62+'px "Arial Narrow",Arial,sans-serif'; cx.textAlign='center'; cx.textBaseline='middle';
      cx.fillStyle=col; cx.globalAlpha=.035;
      for(let d=0;d<10;d++) cx.fillText(d,x+w/2+(d%3-1)*w*.015,y0+th*.5+(d%2?1:-1)*th*.01);   // «стопка» катодов: в глубине баллона
      cx.globalAlpha=1;
      if(c && c.c!==' '){
        cx.shadowColor=col; cx.shadowBlur=th*.22; cx.fillStyle=col;
        if(c.c==='-'){ cx.fillRect(x+w*.25,y0+th*.48,w*.5,th*.04); } else cx.fillText(c.c,x+w/2,y0+th*.52);
        cx.shadowBlur=0;
        if(c.dot){ cx.shadowColor=col; cx.shadowBlur=th*.1; cx.beginPath(); cx.arc(x+w*.9,y0+th*.8,th*.025,0,7); cx.fill(); cx.shadowBlur=0; }
      }
      cx.restore();
      cx.fillStyle='rgba(255,255,255,.1)'; pnRound(cx,x+w*.14,y0+th*.04,w*.14,th*.5,w*.07); cx.fill();   // блик на стекле
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Key Panel (набор физических кнопок: отдельный узел, подключается к любому дисплею) ---------- */
const KP_LAYOUTS={
  radio:'PTT,MON,SQL,SCAN,LOCK,A/B,MENU,BACK,UP,DOWN,F,PWR',
  scanner:'HOLD,SCAN,L/O,PRI,WX,SVC,REV,FWD,MENU,SQL,UP,DOWN',
  numeric:'1,2,3,4,5,6,7,8,9,*,0,#',
  transport:'PREV,REW,PLAY,FWD,NEXT,REC',
  tuning:'BAND-,BAND+,MODE,STEP,VFO,M>V,V>M,CLR',
  phone:'VOL-,VOL+,MUTE,PREV,PLAY,NEXT'};
// layout «phone»: нажатие сразу даёт готовую команду на выходе cmd — его провод идёт во вход cmd у Phone Control (громкость и медиа-клавиши телефона)
const KP_CMDS={phone:{'VOL-':{cmd:'vol.adjust',dir:'down'},'VOL+':{cmd:'vol.adjust',dir:'up'},'MUTE':{cmd:'vol.adjust',dir:'toggle'},
  'PREV':{cmd:'media',key:'prev'},'PLAY':{cmd:'media',key:'toggle'},'NEXT':{cmd:'media',key:'next'}}};
const KP_STYLES=['rubber','mech','flat','round'];
const kpKeys=n=>(KP_LAYOUTS[n.p.layout] || String(n.p.keys||'')).split(',').map(s=>s.trim()).filter(Boolean).slice(0,32);
function kpGrid(n,W,H){
  const N=Math.max(1,kpKeys(n).length); let best=null;
  const cols=Math.round(n.p.cols);
  for(let c=1;c<=N;c++){
    if(cols>0 && c!==Math.min(cols,N)) continue;
    const r=Math.ceil(N/c), sc=Math.min(W/c/1.35,H/r);
    if(!best || sc>best.sc) best={c,r,sc};
  }
  return {...best, cw:W/best.c, ch:H/best.r};
}
def({ id:'keypanel', lazy:'proc', title:'Key Panel', cat:'Indicators', kw:'buttons keys keypad ptt radio scanner numeric transport rubber mechanical push latch hardware controls',
  outs:n=>[...kpKeys(n).map((k,i)=>({n:'k'+(i+1),t:'num'})),{n:'last',t:'num'},{n:'key',t:'txt'},{n:'hit',t:'num'},{n:'rec',t:'rec'},{n:'cmd',t:'rec'}],
  view:{h:130}, w:300, resize:true,
  params:[{n:'layout',t:'select',opts:[...Object.keys(KP_LAYOUTS),'custom'],d:'radio',fn:pnPortsFix,label:'layout (custom — the list below)'},
          {n:'keys',t:'text',d:'A,B,C,D',label:'custom keys (comma separated)',fn:pnPortsFix},
          {n:'mode',t:'select',opts:['push','latch'],d:'push',label:'push — held while pressed, latch — toggles'},
          {n:'style',t:'select',opts:KP_STYLES,d:'rubber'},
          {n:'cols',t:'range',min:0,max:8,step:1,d:0,label:'columns (0 — auto)'},
          {n:'color',t:'text',d:'green',label:'latch lamp: '+IND_COLORS.join(', ')+' or #rrggbb'}],
  init:n=>{ n.on=[]; n.held=-1; n.last=0; n.key=''; n.hit=0; n.q=[]; n.cq=[]; },
  process(n){
    const ks=kpKeys(n), o={};
    ks.forEach((k,i)=>{ o['k'+(i+1)]=n.p.mode==='latch' ? (n.on[i] ? 1 : 0) : (n.held===i ? 1 : 0); });
    o.last=n.last; o.key=n.key; o.hit=n.hit; n.hit=0;
    o.rec=n.q.length ? n.q : null; o.cmd=n.cq.length ? n.cq : null; n.q=[]; n.cq=[];
    return o; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, ks=kpKeys(n), N=ks.length, col=indColor(p.color);
    indWire(n,cv,{
      down:(x,y)=>{ const g=kpGrid(n,cv.width,cv.height), k=Math.floor(y/g.ch)*g.c+Math.floor(x/g.cw);
        if(x<0 || k<0 || k>=kpKeys(n).length) return;
        if(n.p.mode==='latch') n.on[k]=!n.on[k]; else n.held=k;
        n.last=k+1; n.key=kpKeys(n)[k]; n.hit=1;
        n.q.push({src:'keys',key:n.key,n:k+1,down:1}); const cm=(KP_CMDS[n.p.layout]||{})[n.key]; if(cm) n.cq.push({...cm}); redraw(n); },
      up:()=>{ if(n.held>=0) n.q.push({src:'keys',key:n.key,n:n.held+1,down:0}); n.held=-1; redraw(n); }});
    cx.clearRect(0,0,W,H);
    const g=kpGrid(n,W,H), pad=Math.max(2,Math.min(g.cw,g.ch)*.06), st=p.style;
    for(let k=0;k<N;k++){
      const x=(k%g.c)*g.cw+pad, y=Math.floor(k/g.c)*g.ch+pad, w=g.cw-2*pad, h=g.ch-2*pad;
      const down= p.mode==='latch' ? !!n.on[k] : n.held===k, dy=down ? Math.min(2,h*.05) : 0;
      const r= st==='round' ? Math.min(w,h)/2 : Math.min(8,h*.2);
      cx.save();
      if(!down && st!=='flat'){ cx.shadowColor='rgba(0,0,0,.55)'; cx.shadowBlur=4; cx.shadowOffsetY=2; }
      const gr=cx.createLinearGradient(0,y,0,y+h);
      if(st==='mech'){ gr.addColorStop(0,down ? '#8a9096' : '#c4c9ce'); gr.addColorStop(1,down ? '#5d6369' : '#7d848a'); }
      else if(st==='flat'){ gr.addColorStop(0,'#1a1d21'); gr.addColorStop(1,'#1a1d21'); }
      else { gr.addColorStop(0,down ? '#25282c' : '#454a50'); gr.addColorStop(1,down ? '#16181b' : '#2a2d32'); }
      cx.fillStyle=gr; pnRound(cx,x,y+dy,w,h,r); cx.fill(); cx.restore();
      cx.strokeStyle= st==='flat' ? (down ? col : '#5a626a') : '#0c0d0f'; cx.lineWidth=st==='flat' ? 1.5 : 1.2; pnRound(cx,x,y+dy,w,h,r); cx.stroke();
      if(st!=='flat' && !down){ cx.strokeStyle='rgba(255,255,255,.18)'; cx.beginPath(); cx.moveTo(x+r,y+dy+1); cx.lineTo(x+w-r,y+dy+1); cx.stroke(); }
      if(p.mode==='latch'){ const lr=Math.max(2,h*.07); cx.save(); cx.fillStyle=col; cx.globalAlpha=down ? 1 : .14; if(down){ cx.shadowColor=col; cx.shadowBlur=lr*3; }
        cx.beginPath(); cx.arc(x+w/2,y+dy+h*.18,lr,0,7); cx.fill(); cx.restore(); }
      const t=ks[k], arrow={UP:'▲',DOWN:'▼'}[t];
      cx.fillStyle= st==='mech' ? '#161a1d' : '#e4e8eb'; cx.textAlign='center'; cx.textBaseline='middle';
      const fs=Math.max(8,Math.min(h*.36,w*1.5/Math.max(2,(arrow||t).length))); cx.font='bold '+fs+'px '+PN_FONT;
      cx.fillText(arrow||t,x+w/2,y+dy+h*.54);
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- D-pad (кнопочная крестовина в квадрате: 4 стороны, OK и 4 угловые кнопки) ---------- */
const DP_DIRS=['up','down','left','right','ok','a','b','c','d'];
function dpHit(x,y,W,H){
  const S=Math.min(W,H)-8, u=(x-(W-S)/2)/S-.5, v=(y-(H-S)/2)/S-.5;
  if(Math.abs(u)>.5 || Math.abs(v)>.5) return '';
  if(Math.abs(u)>.26 && Math.abs(v)>.26) return v<0 ? (u<0 ? 'a' : 'b') : (u<0 ? 'c' : 'd');
  if(Math.hypot(u,v)<.14) return 'ok';
  if(Math.hypot(u,v)>.38) return '';
  return Math.abs(u)>Math.abs(v) ? (u<0 ? 'left' : 'right') : (v<0 ? 'up' : 'down');
}
def({ id:'dpad', lazy:'proc', title:'D-pad', cat:'Indicators', kw:'joystick directional pad arrows up down left right ok enter back menu home cross buttons navigation',
  outs:[{n:'up',t:'num'},{n:'down',t:'num'},{n:'left',t:'num'},{n:'right',t:'num'},{n:'ok',t:'num'},
        {n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'},{n:'x',t:'num'},{n:'y',t:'num'},{n:'key',t:'txt'},{n:'hit',t:'num'},{n:'rec',t:'rec'}],
  view:{h:180}, w:200, resize:true,
  params:[{n:'labels',t:'text',d:'BACK,MENU,HOME,MODE',label:'corner buttons a, b, c, d (comma separated)'},
          {n:'color',t:'text',d:'teal',label:'highlight: '+IND_COLORS.join(', ')+' or #rrggbb'}],
  init:n=>{ n.held=''; n.hit=0; n.q=[]; },
  process(n){
    const h=n.held, o={};
    for(const d of DP_DIRS) o[d]=h===d ? 1 : 0;
    o.x=(h==='right')-(h==='left'); o.y=(h==='up')-(h==='down'); o.key=h; o.hit=n.hit; n.hit=0; o.rec=n.q.length ? n.q : null; n.q=[];
    return o; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, col=indColor(n.p.color), S=Math.min(W,H)-8, x0=(W-S)/2, y0=(H-S)/2, C=[W/2,H/2];
    indWire(n,cv,{
      down:(x,y)=>{ const d=dpHit(x,y,cv.width,cv.height); if(d){ n.held=d; n.hit=1; n.q.push({src:'dpad',key:d,down:1}); redraw(n); } },
      move:(x,y)=>{ const d=dpHit(x,y,cv.width,cv.height); if(d && d!==n.held){ n.held=d; n.hit=1; n.q.push({src:'dpad',key:d,down:1}); redraw(n); } },
      up:()=>{ n.held=''; redraw(n); }});
    cx.clearRect(0,0,W,H);
    const lb=String(n.p.labels||'').split(',').map(s=>s.trim());
    const key=(path,on,glyph,fs)=>{
      cx.save(); if(!on){ cx.shadowColor='rgba(0,0,0,.55)'; cx.shadowBlur=4; cx.shadowOffsetY=2; }
      const g=cx.createLinearGradient(0,y0,0,y0+S); g.addColorStop(0,on ? '#1c1f23' : '#4a5057'); g.addColorStop(1,on ? '#121416' : '#2b2f34');
      cx.fillStyle=g; path(); cx.fill(); cx.restore();
      cx.strokeStyle=on ? col : '#0c0d0f'; cx.lineWidth=on ? 2 : 1.2; path(); cx.stroke();
      if(on){ cx.save(); cx.shadowColor=col; cx.shadowBlur=8; cx.globalAlpha=.6; path(); cx.stroke(); cx.restore(); }
      return glyph; };
    // подложка-квадрат
    cx.fillStyle='#191c1f'; pnRound(cx,x0,y0,S,S,S*.08); cx.fill(); cx.strokeStyle='#4b525a'; cx.lineWidth=1.5; cx.stroke();
    // четыре сектора кольца
    const ro=S*.38, ri=S*.14, dirs=[['up',-Math.PI/2],['right',0],['down',Math.PI/2],['left',Math.PI]];
    for(const [d,a] of dirs){
      const on=n.held===d, g=.03;
      key(()=>{ cx.beginPath(); cx.arc(C[0],C[1],ro,a-Math.PI/4+g,a+Math.PI/4-g); cx.arc(C[0],C[1],ri,a+Math.PI/4-g,a-Math.PI/4+g,true); cx.closePath(); },on);
      const r=(ro+ri)/2, tx=C[0]+Math.cos(a)*r, ty=C[1]+Math.sin(a)*r, s=S*.045;
      cx.fillStyle=on ? col : '#d7dce0'; cx.beginPath();
      cx.moveTo(tx+Math.cos(a)*s*1.2,ty+Math.sin(a)*s*1.2); cx.lineTo(tx+Math.cos(a+2.4)*s*1.5,ty+Math.sin(a+2.4)*s*1.5); cx.lineTo(tx+Math.cos(a-2.4)*s*1.5,ty+Math.sin(a-2.4)*s*1.5); cx.closePath(); cx.fill();
    }
    const okOn=n.held==='ok';
    key(()=>{ cx.beginPath(); cx.arc(C[0],C[1],S*.115,0,7); },okOn);
    cx.fillStyle=okOn ? col : '#d7dce0'; cx.font='bold '+S*.075+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText('OK',C[0],C[1]);
    // угловые кнопки
    const cs=S*.24, cr=S*.05;
    [['a',0,0],['b',1,0],['c',0,1],['d',1,1]].forEach(([d,ix,iy],i)=>{
      const bx=x0+(ix ? S-cs-S*.025 : S*.025), by=y0+(iy ? S-cs-S*.025 : S*.025), on=n.held===d;
      key(()=>pnRound(cx,bx,by,cs,cs,cr),on);
      cx.fillStyle=on ? col : '#d7dce0'; cx.font='bold '+Math.max(7,Math.min(S*.06,cs*1.6/Math.max(3,(lb[i]||d).length)))+'px '+PN_FONT;
      cx.fillText(lb[i]||d.toUpperCase(),bx+cs/2,by+cs/2);
    });
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ============ вторая партия: переключатель, jog, DIP, flip-часы, точечный LCD / VFD, гониометр, термометр ============ */
const pnStep=(rng,t)=>{ const m=Math.pow(10,Math.floor(Math.log10(rng/t))); return [1,2,5,10].map(q=>q*m).find(q=>rng/q<=t) || 10*m; };
const pnWrap=a=>{ while(a>Math.PI) a-=2*Math.PI; while(a<-Math.PI) a+=2*Math.PI; return a; };
const pnList=(s,max)=>String(s||'').split(',').map(x=>x.trim()).filter(x=>x!=='').slice(0,max);

/* ---------- Rotary Selector (галетный переключатель на N положений) ---------- */
const rsLabels=n=>{ const l=pnList(n.p.labels,12); return l.length>=2 ? l : ['0','1']; };
def({ id:'rotsel', lazy:'proc', title:'Rotary Selector', cat:'Indicators', kw:'rotary switch selector band mode positions detent bakelite wafer knob',
  outs:[{n:'pos',t:'num'},{n:'val',t:'num'},{n:'label',t:'txt'}], view:{h:160}, w:220, resize:true,
  params:[{n:'labels',t:'text',d:'OFF,LSB,USB,CW,AM,FM',label:'positions (comma separated, 2…12)'},
          {n:'values',t:'text',d:'',label:'values on «val» (comma separated; empty — 0, 1, 2…)'},
          {n:'span',t:'range',min:60,max:320,step:5,d:220,label:'sweep, degrees'},
          {n:'color',t:'text',d:'amber',label:'marker: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.pos=Math.max(0,Math.round(+n.p.state)||0); n.an=null; },
  process(n){
    const L=rsLabels(n), v=pnList(n.p.values,12); n.pos=clamp(n.pos,0,L.length-1);
    const vv=v.length>n.pos && isFinite(+v[n.pos]) ? +v[n.pos] : n.pos;
    return {pos:n.pos+1,val:vv,label:L[n.pos]}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, L=rsLabels(n), N=L.length, col=indColor(p.color), sp=+p.span*Math.PI/180;
    const ang=i=>-sp/2+sp*i/(N-1);
    const set=(x,y)=>{ const a=Math.atan2(x-W/2,-(y-H/2)); let b=0,bd=9;
      for(let i=0;i<N;i++){ const d=Math.abs(pnWrap(a-ang(i))); if(d<bd){ bd=d; b=i; } }
      n.pos=b; n.p.state=String(b); redraw(n); };
    indWire(n,cv,{down:set,move:set,wheel:(x,y,ev)=>{ n.pos=clamp(n.pos+(ev.deltaY<0 ? 1 : -1),0,N-1); n.p.state=String(n.pos); redraw(n); }});
    cx.clearRect(0,0,W,H);
    const fs=Math.max(8,Math.min(12,Math.min(W,H)*.075)), Rk=Math.min(W,H)/2-fs*2.4, X=W/2, Y=H/2;
    if(n.an===null || Math.abs(n.an-ang(n.pos))>sp) n.an=ang(n.pos);
    n.an+=(ang(n.pos)-n.an)*.35; if(Math.abs(ang(n.pos)-n.an)>.002) redraw(n);
    cx.font='bold '+fs+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle';
    for(let i=0;i<N;i++){
      const a=ang(i), on=i===n.pos, sx=Math.sin(a), sy=-Math.cos(a);
      cx.strokeStyle=on ? col : themeColor('--axis'); cx.lineWidth=on ? 2.5 : 1.5;
      cx.beginPath(); cx.moveTo(X+sx*Rk*1.08,Y+sy*Rk*1.08); cx.lineTo(X+sx*Rk*1.22,Y+sy*Rk*1.22); cx.stroke();
      cx.fillStyle=on ? col : themeColor('--scr-hi'); cx.globalAlpha=on ? 1 : .75;
      if(on){ cx.save(); cx.shadowColor=col; cx.shadowBlur=6; cx.fillText(L[i],X+sx*(Rk*1.22+fs*1.1),Y+sy*(Rk*1.22+fs*1.1)); cx.restore(); }
      else cx.fillText(L[i],X+sx*(Rk*1.22+fs*1.1),Y+sy*(Rk*1.22+fs*1.1));
      cx.globalAlpha=1;
    }
    // корпус ручки: юбка, рифлёный бортик, колпачок, указатель
    cx.save(); cx.shadowColor='rgba(0,0,0,.6)'; cx.shadowBlur=8; cx.shadowOffsetY=3;
    const sk=cx.createRadialGradient(X-Rk*.3,Y-Rk*.3,Rk*.1,X,Y,Rk); sk.addColorStop(0,'#4a4f56'); sk.addColorStop(1,'#16181b');
    cx.fillStyle=sk; cx.beginPath(); cx.arc(X,Y,Rk,0,7); cx.fill(); cx.restore();
    cx.strokeStyle='rgba(255,255,255,.14)'; cx.lineWidth=1;
    for(let i=0;i<48;i++){ const a=i*Math.PI/24; cx.beginPath(); cx.moveTo(X+Math.cos(a)*Rk*.86,Y+Math.sin(a)*Rk*.86); cx.lineTo(X+Math.cos(a)*Rk*.98,Y+Math.sin(a)*Rk*.98); cx.stroke(); }
    const cap=cx.createRadialGradient(X-Rk*.2,Y-Rk*.2,Rk*.05,X,Y,Rk*.75); cap.addColorStop(0,'#6a7078'); cap.addColorStop(1,'#25282c');
    cx.fillStyle=cap; cx.beginPath(); cx.arc(X,Y,Rk*.72,0,7); cx.fill(); cx.strokeStyle='#0b0c0e'; cx.lineWidth=1.5; cx.stroke();
    cx.save(); cx.translate(X,Y); cx.rotate(n.an); cx.strokeStyle=col; cx.lineWidth=Math.max(3,Rk*.09); cx.lineCap='round'; cx.shadowColor=col; cx.shadowBlur=6;
    cx.beginPath(); cx.moveTo(0,-Rk*.25); cx.lineTo(0,-Rk*.66); cx.stroke(); cx.restore();
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Jog Wheel (бесконечный энкодер с кнопкой) ---------- */
def({ id:'jog', lazy:'proc', title:'Jog Wheel', cat:'Indicators', kw:'encoder jog shuttle wheel rotary endless detent tuning dial spinner scroll',
  outs:[{n:'delta',t:'num'},{n:'pos',t:'num'},{n:'dir',t:'num'},{n:'push',t:'num'},{n:'rec',t:'rec'}], view:{h:170}, w:200, resize:true,
  params:[{n:'detents',t:'range',min:4,max:60,step:1,d:24,label:'detents per turn'},
          {n:'step',t:'num',d:1,label:'value per detent on «pos»'},
          {n:'color',t:'text',d:'teal',label:'marker: '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.posv=+n.p.state||0; n.rot=0; n.acc=0; n.pend=0; n.push=0; n.drag=false; n.pa=0; n.q=[]; },
  process(n){
    const d=n.pend, st=+n.p.step||1; n.pend=0;
    if(d){ n.posv+=d*st; n.p.state=String(+n.posv.toFixed(6)); n.q.push({src:'jog',delta:d,pos:n.posv}); }
    const rec=n.q.length ? n.q : null; n.q=[];
    return {delta:d,pos:n.posv,dir:Math.sign(d),push:n.push,rec}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, col=indColor(n.p.color), X=W/2, Y=H/2, R=Math.min(W,H)/2-6, det=Math.round(n.p.detents), da=2*Math.PI/det;
    const polar=(x,y)=>[Math.hypot(x-cv.width/2,y-cv.height/2),Math.atan2(y-cv.height/2,x-cv.width/2)];
    const step=k=>{ n.pend+=k; n.rot+=k*da; redraw(n); };
    indWire(n,cv,{
      down:(x,y)=>{ const [r,a]=polar(x,y); if(r<Math.min(cv.width,cv.height)*.14){ n.push=1; n.q.push({src:'jog',push:1}); } else { n.drag=true; n.pa=a; } redraw(n); },
      move:(x,y)=>{ if(!n.drag) return; const a=polar(x,y)[1]; n.acc+=pnWrap(a-n.pa); n.pa=a;
        const k=Math.trunc(n.acc/da); if(k){ n.acc-=k*da; step(k); } },
      up:()=>{ n.drag=false; n.acc=0; if(n.push){ n.push=0; n.q.push({src:'jog',push:0}); } redraw(n); },
      wheel:(x,y,ev)=>step(ev.deltaY<0 ? 1 : -1)});
    cx.clearRect(0,0,W,H);
    cx.save(); cx.shadowColor='rgba(0,0,0,.6)'; cx.shadowBlur=8; cx.shadowOffsetY=3;
    const g=cx.createRadialGradient(X-R*.3,Y-R*.3,R*.1,X,Y,R); g.addColorStop(0,'#3a3e44'); g.addColorStop(1,'#101214');
    cx.fillStyle=g; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.fill(); cx.restore();
    // рифление вращается вместе с колесом
    cx.strokeStyle='rgba(255,255,255,.2)'; cx.lineWidth=Math.max(1,R*.015);
    const ribs=det*2;
    for(let i=0;i<ribs;i++){ const a=n.rot+i*Math.PI*2/ribs; cx.beginPath(); cx.moveTo(X+Math.cos(a)*R*.7,Y+Math.sin(a)*R*.7); cx.lineTo(X+Math.cos(a)*R*.97,Y+Math.sin(a)*R*.97); cx.stroke(); }
    cx.strokeStyle='#05060a'; cx.lineWidth=2; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.stroke();
    // метка на ободе
    cx.fillStyle=col; cx.shadowColor=col; cx.shadowBlur=6; cx.beginPath(); cx.arc(X+Math.cos(n.rot-Math.PI/2)*R*.84,Y+Math.sin(n.rot-Math.PI/2)*R*.84,Math.max(2,R*.05),0,7); cx.fill(); cx.shadowBlur=0;
    // центральная кнопка
    const cr=Math.min(W,H)*.14, on=n.push;
    const cg=cx.createLinearGradient(0,Y-cr,0,Y+cr); cg.addColorStop(0,on ? '#1c1f23' : '#5a6068'); cg.addColorStop(1,on ? '#121416' : '#2a2d32');
    cx.fillStyle=cg; cx.beginPath(); cx.arc(X,Y+(on ? 1.5 : 0),cr,0,7); cx.fill(); cx.strokeStyle=on ? col : '#0b0c0e'; cx.lineWidth=on ? 2 : 1.2; cx.stroke();
    cx.fillStyle='#e4e8eb'; cx.font='bold '+cr*.7+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText(indFmt(n.posv),X,Y+(on ? 1.5 : 0));
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- DIP Switch ---------- */
const dsBits=n=>{ const N=+n.p.count||8, o=[]; for(let i=0;i<N;i++) o.push(String(n.p.state||'')[i]==='1'); return o; };
def({ id:'dipsw', lazy:'proc', title:'DIP Switch', cat:'Indicators', kw:'dip switch bank binary address bits config jumper slide',
  outs:n=>[...Array.from({length:+n.p.count||8},(_,i)=>({n:'b'+(i+1),t:'num'})),{n:'value',t:'num'},{n:'bits',t:'txt'}],
  view:{h:100}, w:300, resize:true,
  params:[{n:'count',t:'select',opts:['4','6','8','10','12','16'],d:'8',fn:pnPortsFix},
          {n:'color',t:'text',d:'red',label:'housing: red, blue, #rrggbb…'},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{},
  process(n){
    const b=dsBits(n), o={}; let v=0;
    b.forEach((x,i)=>{ o['b'+(i+1)]=x ? 1 : 0; if(x) v+=Math.pow(2,i); });
    o.value=v; o.bits=b.map(x=>x ? 1 : 0).reverse().join('');          // старший слева, как пишут адрес
    return o; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, N=+n.p.count||8, b=dsBits(n), hc={red:'#c5262c',blue:'#1f5fc4',green:'#2a9a52',yellow:'#d6b21c'}[String(n.p.color).toLowerCase()] || indColor(n.p.color);
    indWire(n,cv,{down:(x)=>{ const m=Math.max(6,cv.width*.03), k=Math.floor((x-m)/((cv.width-2*m)/(+n.p.count||8)));
      if(k<0 || k>=(+n.p.count||8)) return; const a=dsBits(n); a[k]=!a[k]; n.p.state=a.map(q=>q ? 1 : 0).join(''); redraw(n); }});
    cx.clearRect(0,0,W,H);
    const m=Math.max(6,W*.03), bw=(W-2*m)/N, bh=H-2*m;
    cx.save(); cx.shadowColor='rgba(0,0,0,.5)'; cx.shadowBlur=6; cx.shadowOffsetY=2; cx.fillStyle=hc; pnRound(cx,m*.5,m*.5,W-m,H-m,5); cx.fill(); cx.restore();
    cx.strokeStyle='rgba(0,0,0,.35)'; cx.lineWidth=1.5; pnRound(cx,m*.5,m*.5,W-m,H-m,5); cx.stroke();
    const fs=Math.max(7,Math.min(11,bw*.4)); cx.font='bold '+fs+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillStyle='rgba(255,255,255,.9)';
    cx.fillText('ON',m+bw*.5,m+fs*.7);
    for(let i=0;i<N;i++){
      const x=m+i*bw+bw*.2, w=bw*.6, y0=m+fs*1.9, h=bh-fs*3.6;
      cx.fillStyle='#0d0e10'; pnRound(cx,x,y0,w,h,w*.25); cx.fill();
      const kh=h*.46, ky=b[i] ? y0+2 : y0+h-kh-2;                     // вверх — ON
      const g=cx.createLinearGradient(x,0,x+w,0); g.addColorStop(0,'#c8ccd0'); g.addColorStop(1,'#eef0f2');
      cx.fillStyle=g; pnRound(cx,x+2,ky,w-4,kh,w*.2); cx.fill();
      cx.fillStyle='rgba(255,255,255,.9)'; cx.fillText(String(i+1),x+w/2,m+bh-fs*.7);
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Flip Clock (часы-«перекидушки» или любое число) ---------- */
def({ id:'flipclock', lazy:'proc', title:'Flip Clock', cat:'Indicators', kw:'flip clock retro split flap time cards numbers counter airport',
  ins:[{n:'in',t:'num'}], view:{h:120}, w:360, resize:true,
  params:[{n:'mode',t:'select',opts:['clock','value'],d:'clock',label:'clock — system time, value — the number on «in»'},
          {n:'seconds',t:'check',d:true,label:'clock: seconds'},
          {n:'h24',t:'check',d:true,label:'clock: 24-hour'},
          {n:'utc',t:'check',d:false,label:'clock: UTC'},
          {n:'digits',t:'range',min:1,max:10,step:1,d:4,label:'value: digits'},
          {n:'color',t:'text',d:'#f1ede4',label:'digits: #rrggbb or a name'}],
  init:n=>{ n.cells=[]; n.v=null; },
  process(n,I){
    const p=n.p; let s;
    if(p.mode==='clock'){
      const d=new Date(), u=p.utc, pad=x=>String(x).padStart(2,'0'); let h=u ? d.getUTCHours() : d.getHours(); if(!p.h24) h=h%12||12;
      s=pad(h)+':'+pad(u ? d.getUTCMinutes() : d.getMinutes())+(p.seconds ? ':'+pad(u ? d.getUTCSeconds() : d.getSeconds()) : '');
    } else { const v=indNum(I.in); s= v===null ? '-'.repeat(Math.round(p.digits)) : String(Math.max(0,Math.round(v))).padStart(Math.round(p.digits),'0').slice(-Math.round(p.digits)); }
    const now=performance.now(); let busy=false;
    n.cells.length=s.length;
    for(let i=0;i<s.length;i++){
      const c=n.cells[i]||(n.cells[i]={c:s[i],prev:s[i],t0:-1e9});
      if(c.c!==s[i]){ c.prev=c.c; c.c=s[i]; c.t0=now; }
      if(now-c.t0<500) busy=true;
    }
    if(busy) redraw(n);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, cells=n.cells, N=cells.length, now=performance.now(), ink=/^#|^[a-z]+$/i.test(p.color) ? p.color : '#f1ede4';
    cx.clearRect(0,0,W,H); if(!N) return;
    const nd=cells.filter(c=>c.c!==':').length, ncol=N-nd, unit=Math.min((W-8)/(nd*1+ncol*.35+(N-1)*.08),(H-8)/1.35);
    const cw=unit, ch=unit*1.35, gap=unit*.08, colw=unit*.35; let x=(W-(nd*cw+ncol*colw+(N-1)*gap))/2; const y=(H-ch)/2;
    const half=(c,top,sy,xx)=>{               // половинка карточки с цифрой
      cx.save(); cx.beginPath(); cx.rect(xx,top ? y : y+ch/2,cw,ch/2); cx.clip();
      cx.translate(xx,y+ch/2); cx.scale(1,sy); cx.translate(-xx,-(y+ch/2));
      const g=cx.createLinearGradient(0,y,0,y+ch); g.addColorStop(0,top ? '#2a2b2e' : '#1f2023'); g.addColorStop(1,top ? '#222326' : '#17181a');
      cx.fillStyle=g; pnRound(cx,xx,y,cw,ch,cw*.08); cx.fill();
      cx.fillStyle=ink; cx.font='bold '+ch*.78+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle'; cx.fillText(c,xx+cw/2,y+ch*.53);
      cx.restore(); };
    for(const c of cells){
      if(c.c===':'){ cx.fillStyle=ink; cx.globalAlpha=.85; for(const k of [.35,.65]){ cx.beginPath(); cx.arc(x+colw/2,y+ch*k,unit*.05,0,7); cx.fill(); } cx.globalAlpha=1; x+=colw+gap; continue; }
      const u=clamp((now-c.t0)/500,0,1);
      cx.save(); cx.shadowColor='rgba(0,0,0,.5)'; cx.shadowBlur=5; cx.shadowOffsetY=2;
      if(u>=1){ half(c.c,true,1,x); half(c.c,false,1,x); }
      else if(u<.5){ half(c.c,true,1,x); half(c.prev,false,1,x); half(c.prev,true,1-2*u,x); }     // верхняя половина сворачивается
      else { half(c.c,true,1,x); half(c.prev,false,1,x); half(c.c,false,2*u-1,x); }               // нижняя разворачивается
      cx.restore();
      cx.fillStyle='#000'; cx.fillRect(x,y+ch/2-1,cw,2);
      x+=cw+gap;
    }
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Dot-matrix LCD / VFD / OLED (символьный дисплей 5×7) ---------- */
const DM_FONT=`0000000000 00005f0000 0007000700 147f147f14 242a7f2a12 2313086462 3649562050 0005030000 001c224100 0041221c00 14083e0814 08083e0808 0050300000 0808080808 0060600000 2010080402
3e5149453e 00427f4000 4261514946 2141454b31 1814127f10 2745454539 3c4a494930 0171090503 3649494936 064949291e 0036360000 0056360000 0814224100 1414141414 0041221408 0201510906
324979413e 7e1111117e 7f49494936 3e41414122 7f4141221c 7f49494941 7f09090901 3e41495a7a 7f0808087f 00417f4100 2040413f01 7f08142241 7f40404040 7f020c027f 7f0408107f 3e4141413e
7f09090906 3e4151215e 7f09192946 4649494931 01017f0101 3f4040403f 1f2040201f 3f4038403f 6314081463 0708700807 6151494543 007f414100 0204081020 00417f0000 0402010204 4040404040
0001020400 2054545478 7f48444438 3844444420 384444487f 3854545418 087e090102 0c5252523e 7f08040478 00447d4000 2040443d00 7f10284400 00417f4000 7c04180478 7c08040478 3844444438
7c14141408 0814141c7c 7c08040408 4854545420 043f444020 3c4020407c 1c2040201c 3c4030403c 4428102844 0c5050503c 4464544c44 0008364100 00007f0000 0041360800 1008081008`.split(/\s+/);   // классический шрифт 5×7, ASCII 32…126: 5 байт-колонок на символ, бит 0 — верхняя точка
const dmGlyph=ch=>{ let c=ch.charCodeAt(0);
  if(ch==='°') return [6,9,9,6,0]; if(ch==='µ') c=117; if(c<32 || c>126) c=63;
  const h=DM_FONT[c-32]||'0000000000'; return [0,1,2,3,4].map(i=>parseInt(h.substr(i*2,2),16)); };
def({ id:'dotlcd', lazy:'proc', title:'Character Display (LCD / VFD / OLED)', cat:'Indicators', kw:'lcd 16x2 hd44780 vfd oled dot matrix character display text lines backlight',
  ins:[{n:'text',t:'txt'},{n:'l1',t:'txt'},{n:'l2',t:'txt'},{n:'l3',t:'txt'},{n:'l4',t:'txt'}],
  view:{h:100}, w:360, resize:true,
  params:[{n:'cols',t:'select',opts:['8','16','20','24','40'],d:'16'},
          {n:'rows',t:'select',opts:['1','2','4'],d:'2'},
          {n:'style',t:'select',opts:['lcd','lcd-neg','vfd','oled'],d:'lcd',label:'lcd — dark dots on a lit panel, lcd-neg — glowing on dark, vfd — round glowing dots, oled — thin dots'},
          {n:'color',t:'text',d:'#8fd14f',label:'backlight / glow: '+IND_COLORS.join(', ')+' or #rrggbb'},PN_HUE,
          {n:'text',t:'text',d:'DSP workbench|0123456789 ABC',label:'text when no pin is wired (| — new line)'}],
  init:n=>{ n.lines=[]; },
  process(n,I){
    const rows=+n.p.rows||2, ls=[1,2,3,4].map(k=>typeof I['l'+k]==='string' ? I['l'+k] : null);
    if(ls.some(x=>x!==null)) n.lines=ls.map(x=>x||'');
    else if(typeof I.text==='string') n.lines=I.text.split(/\r?\n/);
    else n.lines=String(n.p.text||'').split('|');
    n.lines=n.lines.slice(0,rows); return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, C=+p.cols||16, R=+p.rows||2, st=p.style, bl=pnBL(p), m=Math.max(5,H*.06);
    cx.clearRect(0,0,W,H);
    const g=cx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#33373d'); g.addColorStop(1,'#1a1c20');
    cx.fillStyle=g; pnRound(cx,1,1,W-2,H-2,Math.min(10,H*.1)); cx.fill(); cx.strokeStyle='#50565e'; cx.lineWidth=1.5; cx.stroke();
    const sx=m, sy=m, sw=W-2*m, sh=H-2*m, pitch=Math.min(sw/(C*6+.5),sh/(R*9+.5)), ox=sx+(sw-pitch*(C*6-1))/2, oy=sy+(sh-pitch*(R*9-2))/2;
    cx.save(); pnRound(cx,sx,sy,sw,sh,4); cx.clip();
    const pos=st==='lcd';
    cx.fillStyle= pos ? bl : '#040506'; cx.fillRect(sx,sy,sw,sh);
    if(pos){ const rg=cx.createRadialGradient(W/2,H/2,sh*.1,W/2,H/2,sw*.7); rg.addColorStop(0,'rgba(255,255,255,.18)'); rg.addColorStop(1,'rgba(0,0,0,.35)'); cx.fillStyle=rg; cx.fillRect(sx,sy,sw,sh); }
    else if(st==='lcd-neg'){ const rg=cx.createRadialGradient(W/2,H/2,0,W/2,H/2,sw*.65); rg.addColorStop(0,bl); rg.addColorStop(1,'rgba(0,0,0,0)'); cx.globalAlpha=.14; cx.fillStyle=rg; cx.fillRect(sx,sy,sw,sh); cx.globalAlpha=1; }
    const on= pos ? '#0c1408' : st==='oled' ? '#f4f1e6' : bl, off= pos ? 'rgba(0,0,0,.07)' : st==='vfd' ? 'rgba(120,255,255,.035)' : st==='lcd-neg' ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.02)';
    const d=pitch*(st==='lcd' || st==='lcd-neg' ? .86 : .72);
    const dot=(x,y,lit)=>{ cx.fillStyle=lit ? on : off;
      if(lit && st!=='lcd'){ cx.shadowColor= st==='oled' ? '#fff' : bl; cx.shadowBlur=pitch*(st==='vfd' ? 1.6 : .9); }
      if(st==='lcd' || st==='lcd-neg') cx.fillRect(x,y,d,d); else { cx.beginPath(); cx.arc(x+pitch*.45,y+pitch*.45,d*.5,0,7); cx.fill(); }
      cx.shadowBlur=0; };
    for(let r=0;r<R;r++){
      const line=String(n.lines[r]||'').padEnd(C,' ').slice(0,C);
      for(let c=0;c<C;c++){
        const gl=dmGlyph(line[c]), x0=ox+c*6*pitch, y0=oy+r*9*pitch;
        for(let i=0;i<5;i++) for(let j=0;j<7;j++) dot(x0+i*pitch,y0+j*pitch,gl[i]>>j&1);
      }
    }
    cx.restore();
    cx.fillStyle='rgba(255,255,255,.05)'; pnRound(cx,sx,sy,sw,sh*.4,4); cx.fill();
    cx.strokeStyle='#000'; cx.lineWidth=2; pnRound(cx,sx,sy,sw,sh,4); cx.stroke(); }
});

/* ---------- Goniometer (вектороскоп: Lissajous по L / R и корреляция) ---------- */
const GN_N=1024;
def({ id:'gonio', lazy:'proc', title:'Goniometer', cat:'Indicators', kw:'vectorscope lissajous stereo phase correlation goniometer left right mid side xy',
  ins:[{n:'l',t:'sig'},{n:'r',t:'sig'}], outs:[{n:'corr',t:'num'},{n:'bal',t:'num'}], view:{h:220}, w:260, resize:true,
  params:[{n:'mode',t:'select',opts:['goniometer','xy'],d:'goniometer',label:'goniometer — M/S axes at 45° (mono is a vertical line), xy — L on x, R on y'},
          {n:'gain',t:'range',min:.25,max:16,step:.25,d:2,label:'gain'},
          {n:'color',t:'text',d:'green',label:'trace: '+IND_COLORS.join(', ')+' or #rrggbb'}],
  init:n=>{ n.rx=new Float32Array(GN_N); n.ry=new Float32Array(GN_N); n.w=0; n.cr=0; n.bl=0; n.act=false; n.ell=1e-9; n.err=1e-9; n.elr=0; },
  process(n,I){
    const a=I.l, b=I.r; n.act=!!(a||b); const N=BLOCK;
    let sl=0,sr=0,slr=0;
    for(let i=0;i<N;i++){
      const l=a ? a[i] : 0, r=b ? b[i] : 0;
      n.rx[n.w]=l; n.ry[n.w]=r; n.w=(n.w+1)%GN_N; sl+=l*l; sr+=r*r; slr+=l*r;
    }
    const k=1-Math.exp(-indDt()/.5);
    n.ell+=(sl-n.ell)*k; n.err+=(sr-n.err)*k; n.elr+=(slr-n.elr)*k;
    n.cr= n.ell+n.err>1e-12 ? clamp(n.elr/Math.sqrt(n.ell*n.err+1e-18),-1,1) : 0;
    n.bl= n.ell+n.err>1e-12 ? (n.err-n.ell)/(n.err+n.ell) : 0;
    return {corr:n.cr,bal:n.bl}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, col=indColor(p.color), mb=Math.max(34,H*.17), S=Math.min(W-8,H-mb-8), X=W/2, Y=4+S/2, R=S/2;
    cx.clearRect(0,0,W,H);
    cx.fillStyle='#050a06'; pnRound(cx,X-R,Y-R,S,S,8); cx.fill(); cx.strokeStyle='#3a4a40'; cx.lineWidth=1.5; cx.stroke();
    cx.strokeStyle='rgba(120,255,150,.22)'; cx.lineWidth=1;
    cx.beginPath(); cx.arc(X,Y,R*.5,0,7); cx.arc(X,Y,R*.98,0,7); cx.stroke();
    cx.beginPath(); cx.moveTo(X-R,Y); cx.lineTo(X+R,Y); cx.moveTo(X,Y-R); cx.lineTo(X,Y+R);
    const gm=p.mode==='goniometer'; if(gm){ cx.moveTo(X-R*.7,Y+R*.7); cx.lineTo(X+R*.7,Y-R*.7); cx.moveTo(X-R*.7,Y-R*.7); cx.lineTo(X+R*.7,Y+R*.7); } cx.stroke();
    cx.fillStyle='rgba(160,255,180,.7)'; cx.font=Math.max(8,S*.06)+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
    if(gm){ cx.fillText('M',X,Y-R*.9); cx.fillText('L',X-R*.78,Y-R*.78); cx.fillText('R',X+R*.78,Y-R*.78); cx.fillText('S',X+R*.9,Y); }
    else { cx.fillText('R',X,Y-R*.9); cx.fillText('L',X+R*.9,Y); }
    if(n.act){
      const k=(+p.gain)*R*(gm ? Math.SQRT1_2 : 1), seg=8, per=GN_N/seg;
      cx.save(); cx.beginPath(); cx.rect(X-R,Y-R,S,S); cx.clip(); cx.fillStyle=col; cx.shadowColor=col; cx.shadowBlur=4;
      for(let s=0;s<seg;s++){
        cx.globalAlpha=.1+.7*(s+1)/seg;                                  // старые точки бледнее
        for(let i=0;i<per;i++){
          const q=(n.w+s*per+i)%GN_N, l=n.rx[q], r=n.ry[q];
          const x= gm ? (r-l) : l, y= gm ? (l+r) : r;
          cx.fillRect(X+x*k-1,Y-y*k-1,2,2);
        }
      }
      cx.restore();
    }
    // корреляция −1 … +1 и баланс
    const by=Y+R+10, bx=X-R, bw=S, bh=Math.max(6,H*.035);
    cx.fillStyle='#07090a'; cx.fillRect(bx,by,bw,bh);
    const gr=cx.createLinearGradient(bx,0,bx+bw,0); gr.addColorStop(0,'#ff4a3a'); gr.addColorStop(.5,'#ffb23a'); gr.addColorStop(1,'#4fe08a'); cx.globalAlpha=.35; cx.fillStyle=gr; cx.fillRect(bx,by,bw,bh); cx.globalAlpha=1;
    const cxp=bx+bw*(n.cr+1)/2; cx.fillStyle='#fff'; cx.fillRect(cxp-2,by-2,4,bh+4);
    cx.fillStyle='rgba(160,255,180,.7)'; cx.font=Math.max(8,H*.05)+'px monospace'; cx.textAlign='left'; cx.textBaseline='top';
    cx.fillText('-1',bx,by+bh+2); cx.textAlign='center'; cx.fillText('0',X,by+bh+2); cx.textAlign='right'; cx.fillText('+1',bx+bw,by+bh+2);
    cx.textAlign='center'; cx.fillText('corr '+n.cr.toFixed(2),X,by+bh+2);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});

/* ---------- Thermometer (спиртовой столбик или циферблатный) ---------- */
const TH_CONV={'°C':[1,0],'°F':[1.8,32],'K':[1,273.15]};
def({ id:'thermo', lazy:'proc', title:'Thermometer', cat:'Indicators', kw:'temperature thermometer mercury alcohol dial bimetal celsius fahrenheit kelvin min max',
  ins:[{n:'in',t:'num'}], view:{h:180}, w:160, resize:true,
  params:[{n:'style',t:'select',opts:['tube','dial'],d:'tube',label:'tube — a glass column (horizontal when the tile is wide), dial — a round dial'},
          {n:'min',t:'num',d:-30,label:'scale from, °C'},{n:'max',t:'num',d:50,label:'scale to, °C'},
          {n:'unit',t:'select',opts:Object.keys(TH_CONV),d:'°C',label:'show (the wire carries °C)'},
          {n:'liquid',t:'text',d:'red',label:'liquid: red, blue, '+IND_COLORS.join(', ')+' or #rrggbb'},
          {n:'tau',t:'range',min:0,max:5,step:.05,d:.6,label:'inertia, s'}],
  init:n=>{ n.v=null; n.sv=null; n.mn=Infinity; n.mx=-Infinity; },
  process(n,I){
    const v=indNum(I.in); n.v=v;
    if(v!==null){ n.sv= n.sv===null ? v : indSmooth(n.sv,v,+n.p.tau); n.mn=Math.min(n.mn,v); n.mx=Math.max(n.mx,v); }
    return {}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, lo=+p.min, hi=+p.max, rng=hi-lo||1, [k,b]=TH_CONV[p.unit]||TH_CONV['°C'];
    const liq={red:'#e0322a',blue:'#2a7fe0'}[String(p.liquid).toLowerCase()] || indColor(p.liquid);
    indWire(n,cv,{down:()=>{ n.mn=Infinity; n.mx=-Infinity; redraw(n); }});
    cx.clearRect(0,0,W,H);
    const f=t=>clamp((t-lo)/rng,0,1), sv=n.sv===null ? lo : n.sv;
    const ink=themeColor('--scr-hi'), dmin=lo*k+b, dmax=hi*k+b, step=pnStep(dmax-dmin,8);
    if(p.style==='dial'){
      const R=Math.min(W,H)/2-4, X=W/2, Y=H/2, A0=Math.PI*.75, SW=Math.PI*1.5, ang=t=>A0+SW*f(t);
      cx.fillStyle='#e9e6dc'; cx.beginPath(); cx.arc(X,Y,R,0,7); cx.fill(); cx.strokeStyle='#8a9098'; cx.lineWidth=R*.07; cx.stroke();
      const band=(a,c)=>{ cx.strokeStyle=c; cx.lineWidth=R*.07; cx.beginPath(); cx.arc(X,Y,R*.86,ang(lo+rng*a[0]),ang(lo+rng*a[1])); cx.stroke(); };
      band([0,.3],'#2a7fe0'); band([.3,.7],'#3aa65a'); band([.7,1],'#e0322a');
      cx.fillStyle='#222'; cx.strokeStyle='#222'; cx.font='bold '+Math.max(8,R*.12)+'px '+PN_FONT; cx.textAlign='center'; cx.textBaseline='middle';
      for(let v=Math.ceil(dmin/step)*step; v<=dmax+1e-9; v+=step){ const t=lo+(v-dmin)/(dmax-dmin)*rng, a=ang(t);
        cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(X+Math.cos(a)*R*.78,Y+Math.sin(a)*R*.78); cx.lineTo(X+Math.cos(a)*R*.68,Y+Math.sin(a)*R*.68); cx.stroke();
        cx.fillText(indFmt(+v.toFixed(6)),X+Math.cos(a)*R*.55,Y+Math.sin(a)*R*.55); }
      cx.font='bold '+R*.16+'px '+PN_FONT; cx.fillText(p.unit,X,Y+R*.3); cx.font=R*.14+'px monospace'; cx.fillText(n.v===null ? '—' : (n.v*k+b).toFixed(1),X,Y+R*.5);
      const a=ang(sv); cx.strokeStyle='#c01e1e'; cx.lineWidth=Math.max(2,R*.03); cx.lineCap='round';
      cx.beginPath(); cx.moveTo(X-Math.cos(a)*R*.12,Y-Math.sin(a)*R*.12); cx.lineTo(X+Math.cos(a)*R*.74,Y+Math.sin(a)*R*.74); cx.stroke(); cx.lineCap='butt';
      cx.fillStyle='#222'; cx.beginPath(); cx.arc(X,Y,R*.06,0,7); cx.fill();
      cx.textAlign='start'; cx.textBaseline='alphabetic'; return;
    }
    const horiz=W>H*1.3;
    cx.save(); if(horiz){ cx.translate(0,H); cx.rotate(-Math.PI/2); cx.translate(0,0); }          // горизонтально — рисуем вертикальный и поворачиваем
    const w=horiz ? H : W, h=horiz ? W : H;
    const tw=Math.min(w*.16,18), X=w/2, top=h*.07, bulbR=Math.min(tw*1.3,w*.14), bot=h-bulbR*2-h*.04, len=bot-top;
    // подпись-шкала
    cx.fillStyle=ink; cx.strokeStyle=themeColor('--axis'); cx.font=Math.max(8,Math.min(11,w*.07))+'px monospace'; cx.textBaseline='middle';
    for(let v=Math.ceil(dmin/step)*step; v<=dmax+1e-9; v+=step){ const y=bot-len*(v-dmin)/(dmax-dmin);
      cx.lineWidth=1; cx.beginPath(); cx.moveTo(X+tw/2+3,y); cx.lineTo(X+tw/2+9,y); cx.stroke();
      cx.save(); cx.translate(X+tw/2+12,y); if(horiz) cx.rotate(Math.PI/2); cx.textAlign=horiz ? 'center' : 'left'; cx.fillText(indFmt(+v.toFixed(6)),0,horiz ? 8 : 0); cx.restore(); }
    // стеклянная трубка с колбой
    cx.fillStyle='rgba(255,255,255,.12)'; cx.strokeStyle='rgba(255,255,255,.4)'; cx.lineWidth=1.5;
    cx.beginPath(); cx.roundRect(X-tw/2,top,tw,bot-top+bulbR,tw/2); cx.fill(); cx.stroke();
    cx.beginPath(); cx.arc(X,bot+bulbR*1.1,bulbR,0,7); cx.fill(); cx.stroke();
    const yv=bot-len*f(sv); cx.fillStyle=liq; cx.shadowColor=liq; cx.shadowBlur=4;
    cx.beginPath(); cx.arc(X,bot+bulbR*1.1,bulbR*.78,0,7); cx.fill(); cx.fillRect(X-tw*.2,yv,tw*.4,bot+bulbR*.5-yv); cx.shadowBlur=0;
    cx.fillStyle='rgba(255,255,255,.55)'; cx.fillRect(X-tw*.35,top+4,tw*.1,Math.max(0,bot-top-8));
    if(isFinite(n.mn) && n.mn<=n.mx){ cx.fillStyle='#4aa8ff'; const y1=bot-len*f(n.mn), y2=bot-len*f(n.mx);
      cx.beginPath(); cx.moveTo(X-tw/2-2,y1); cx.lineTo(X-tw/2-8,y1-4); cx.lineTo(X-tw/2-8,y1+4); cx.fill();
      cx.fillStyle='#ff7a3a'; cx.beginPath(); cx.moveTo(X-tw/2-2,y2); cx.lineTo(X-tw/2-8,y2-4); cx.lineTo(X-tw/2-8,y2+4); cx.fill(); }
    cx.restore();
    cx.fillStyle=ink; cx.font='bold '+Math.max(10,Math.min(16,Math.min(W,H)*.12))+'px monospace'; cx.textAlign='left'; cx.textBaseline='top';
    cx.fillText(n.v===null ? '—' : (n.v*k+b).toFixed(1)+p.unit,6,4);
    cx.textAlign='start'; cx.textBaseline='alphabetic'; }
});
