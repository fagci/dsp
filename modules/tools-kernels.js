"use strict";
/* ======================= ИНСТРУМЕНТЫ — ядро ======================= */
// Единицы измерения, линейка, высота, наклон, шаги, фонарик — без DOM: node tools/test-tools.mjs.

/* ---- единицы: число — множитель к базовой единице категории, пара функций [в базовую, из базовой] — нелинейные ---- */
const TL_UNITS={
  length:{m:1,km:1000,cm:.01,mm:.001,'µm':1e-6,nm:1e-9,mi:1609.344,yd:.9144,ft:.3048,in:.0254,nmi:1852,au:1.495978707e11,ly:9.4607304725808e15},
  area:{'m²':1,'km²':1e6,ha:1e4,'cm²':1e-4,'mm²':1e-6,'mi²':2589988.110336,ac:4046.8564224,'yd²':.83612736,'ft²':.09290304,'in²':6.4516e-4},
  volume:{L:1e-3,mL:1e-6,'m³':1,'cm³':1e-6,'ft³':.028316846592,'in³':1.6387064e-5,'gal US':.003785411784,'gal UK':.00454609,qt:9.46352946e-4,pt:4.73176473e-4,'fl oz':2.95735295625e-5,cup:2.365882365e-4,tbsp:1.47867647813e-5,tsp:4.92892159375e-6},
  mass:{kg:1,g:1e-3,mg:1e-6,t:1000,lb:.45359237,oz:.028349523125,st:6.35029318,ct:2e-4},
  speed:{'m/s':1,'km/h':1/3.6,mph:.44704,kn:1852/3600,'ft/s':.3048,Mach:343},
  temperature:{'°C':[c=>c,c=>c],K:[k=>k-273.15,c=>c+273.15],'°F':[f=>(f-32)*5/9,c=>c*9/5+32],'°R':[r=>(r-491.67)*5/9,c=>c*9/5+491.67]},
  pressure:{Pa:1,hPa:100,kPa:1000,MPa:1e6,bar:1e5,mbar:100,atm:101325,mmHg:133.322387415,inHg:3386.389,psi:6894.757293168,Torr:101325/760},
  energy:{J:1,kJ:1000,cal:4.184,kcal:4184,Wh:3600,kWh:3.6e6,eV:1.602176634e-19,BTU:1055.05585262},
  power:{W:1,mW:1e-3,kW:1000,hp:745.69987158,dBm:[x=>1e-3*Math.pow(10,x/10),w=>10*Math.log10(w/1e-3)],dBW:[x=>Math.pow(10,x/10),w=>10*Math.log10(w)]},
  force:{N:1,kN:1000,kgf:9.80665,lbf:4.4482216152605},
  angle:{'°':1,rad:180/Math.PI,grad:.9,turn:360,"'":1/60,'"':1/3600,mil:360/6400},
  time:{s:1,ms:1e-3,'µs':1e-6,ns:1e-9,min:60,h:3600,d:86400,wk:604800,yr:31557600},
  frequency:{Hz:1,kHz:1e3,MHz:1e6,GHz:1e9,rpm:1/60,'rad/s':1/(2*Math.PI)},
  data:{bit:1/8,B:1,kB:1e3,MB:1e6,GB:1e9,TB:1e12,KiB:1024,MiB:1048576,GiB:1073741824,TiB:1099511627776},
};
const tlCats=()=>Object.keys(TL_UNITS);
const tlUnits=cat=>Object.keys(TL_UNITS[cat]||{});
function tlConvert(cat,from,to,v){
  const T=TL_UNITS[cat]; if(!T || !(from in T) || !(to in T) || typeof v!=='number' || !isFinite(v)) return null;
  const f=T[from], t=T[to];
  const base=Array.isArray(f) ? f[0](v) : v*f;
  const r=Array.isArray(t) ? t[1](base) : base/t;
  return isFinite(r) ? r : null;
}
// ASCII-написания для формул Table: convert(5,'km2','ha'), convert(36.6,'C','F')
const TL_ALIAS={C:'°C',F:'°F',R:'°R',deg:'°',um:'µm',us:'µs',m2:'m²',km2:'km²',cm2:'cm²',mm2:'mm²',mi2:'mi²',yd2:'yd²',ft2:'ft²',in2:'in²',
  m3:'m³',cm3:'cm³',ft3:'ft³',in3:'in³',l:'L',ml:'mL',kph:'km/h',kmh:'km/h'};
// категория не нужна: берётся первая, где есть обе единицы (cat — подсказка при совпадении имён)
function tlConvertAuto(v,from,to,cat){
  from=String(from??'').trim(); to=String(to??'').trim();
  from=TL_ALIAS[from]||from; to=TL_ALIAS[to]||to;
  const cats=cat && TL_UNITS[cat] ? [cat] : tlCats();
  for(const c of cats) if(from in TL_UNITS[c] && to in TL_UNITS[c]) return tlConvert(c,from,to,v);
  return null;
}
// 5 значащих цифр; очень большие и малые — в экспоненциальной записи
function tlFmt(v){
  if(v===null || !isFinite(v)) return '—';
  if(v===0) return '0';
  const a=Math.abs(v);
  if(a>=1e9 || a<1e-4) return v.toExponential(4).replace(/\.?0+e/,'e');
  return String(+v.toPrecision(7));
}

/* ---- линейка: деления в мм и дюймах ---- */
// level: 0 — мелкое, 1 — половинное, 2 — основное (с подписью); pos в мм
function tlRulerTicks(lenMm,imperial){
  const out=[];
  if(!imperial){
    for(let i=0;i<=Math.floor(lenMm);i++) out.push({pos:i,level:i%10===0?2:i%5===0?1:0,label:i%10===0?String(i/10):''});
    return out;
  }
  const lenIn=lenMm/25.4;
  for(let i=0;i<=Math.floor(lenIn*16);i++){
    const level=i%16===0?2:i%8===0?1:i%4===0?1:0;
    out.push({pos:i/16*25.4,level,label:i%16===0?String(i/16):'',len:i%16===0?3:i%8===0?2:i%4===0?1.5:i%2===0?1:.6});
  }
  return out;
}
// длина между двумя метками, мм → текст в обеих системах
function tlLenText(mm){ return tlFmt(+mm.toFixed(2))+' mm · '+tlFmt(+(mm/25.4).toFixed(3))+' in'; }

/* ---- высота: угол «вверх» el положителен, вниз — отрицателен ---- */
const TL_D=Math.PI/180;
// известно расстояние до предмета
const tlHeightDist=(elTop,elBase,d)=>d*(Math.tan(elTop*TL_D)-Math.tan(elBase*TL_D));
// известна высота глаз над землёй у основания: расстояние = eye / tan(−угол вниз)
function tlHeightEye(elTop,elBase,eye){
  if(!(elBase<-.1)) return null;
  const d=eye/Math.tan(-elBase*TL_D);
  return {h:eye+d*Math.tan(elTop*TL_D), d};
}
// барометрическая формула: разность высот между давлением p и опорным p0 (в тех же единицах)
const tlBaro=(p,p0)=>p>0 && p0>0 ? 44330.77*(1-Math.pow(p/p0,.190263)) : null;

/* ---- наклон по вектору ускорения (с гравитацией) ----
   pose 'flat': телефон лежит на поверхности, 'upright': стоит вертикально. sign: −1 для iOS (оси перевёрнуты). */
function tlTilt(ax,ay,az,pose,sign){
  const s=sign<0?-1:1, x=ax*s, y=ay*s, z=az*s, m=Math.hypot(x,y,z);
  if(!(m>1e-6)) return null;
  const u=[x/m,y/m,z/m], P=u[0], Q=pose==='upright' ? u[2] : u[1], R=pose==='upright' ? u[1] : u[2];
  const slope=Math.atan2(Math.hypot(P,Q),R)/TL_D;
  return {x:Math.atan2(P,R)/TL_D, y:Math.atan2(Q,R)/TL_D, slope,
          pct:slope>=89.9 ? Infinity : Math.tan(slope*TL_D)*100,
          dir:(Math.atan2(P,Q)/TL_D+360)%360, g:m};
}

/* ---- шагомер: пики вертикального ускорения ---- */
function tlStepNew(o){
  o=o||{};
  return {minThr:o.minThr??.8, minGap:o.minGap??.28, confirm:o.confirm??4, count:0, spm:0,
    base:null, lp:0, p1:0, p2:0, t0:null, tLast:0, pk:0, lastStep:-1e9, lastCand:-1e9, run:0, iv:[]};
}
// один отсчёт модуля ускорения v в момент t (с); возвращает, сколько шагов добавилось
function tlStepPush(S,t,v){
  if(S.base===null){ S.base=v; S.t0=t; S.tLast=t; return 0; }
  const dt=t-S.tLast; if(dt<=0) return 0;
  S.tLast=t;
  S.base+=(v-S.base)*(1-Math.exp(-dt/.8));
  const hp=v-S.base;
  S.lp+=(hp-S.lp)*(1-Math.exp(-dt/.05));
  const cur=S.lp; let add=0;
  if(S.p1>S.p2 && S.p1>=cur){                       // p1 — локальный максимум
    const thr=Math.max(S.minThr,.4*S.pk);
    if(S.p1>thr && t-S.lastStep>=S.minGap){
      S.pk=S.pk ? S.pk*.7+S.p1*.3 : S.p1;
      if(t-S.lastCand>1.3) S.run=0;                 // пауза — серия заново
      S.run++; S.lastCand=t;
      if(S.run===S.confirm) add=S.confirm; else if(S.run>S.confirm) add=1;
      if(S.run>1){ S.iv.push(t-S.lastStep); if(S.iv.length>6) S.iv.shift(); }
      S.lastStep=t;
      if(S.iv.length){ const s=[...S.iv].sort((a,b)=>a-b); S.spm=60/s[s.length>>1]; }
      S.count+=add;
    }
  }
  if(t-S.lastStep>2.5){ S.pk=0; S.spm=0; }
  S.p2=S.p1; S.p1=cur;
  return add;
}

/* ---- фонарик: вкл/выкл по времени t (с) ---- */
const TL_SOS=('10101'+'000'+'111011101110111'+'000'+'10101'+'0000000').split('').map(Number);
function tlTorchOn(pattern,hz,t){
  if(pattern==='strobe') return Math.floor(t*Math.max(.1,hz)*2)%2===0;
  if(pattern==='SOS') return TL_SOS[Math.floor(t/.2)%TL_SOS.length]===1;
  return true;
}
