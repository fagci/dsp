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

/* ---- радио: длина волны, антенна, бюджет линии, КСВ, закон Ома, LC ---- */
const RF_C=299792458;
// k — коэффициент укорочения провода (≈0.95), vf — скорость в кабеле / среде
function rfWave(fHz,k){
  if(!(fHz>0)) return null;
  const lam=RF_C/fHz, kk=k>0 ? k : 1;
  return {lambda:lam, quarter:lam/4*kk, half:lam/2*kk, full:lam*kk};
}
const rfFspl=(dKm,fMHz)=>dKm>0 && fMHz>0 ? 32.44+20*Math.log10(dKm)+20*Math.log10(fMHz) : null;
// все в дБ / дБм / дБи; возвращает потери трассы, уровень на входе приёмника, запас и дальность при нулевом запасе
function rfLink(o){
  const fs=rfFspl(o.dKm,o.fMHz); if(fs===null) return null;
  const eirp=o.pt+o.gt-o.lossTx, pr=eirp+o.gr-o.lossRx-fs, margin=pr-o.sens;
  const rng=Math.pow(10,(eirp+o.gr-o.lossRx-o.sens-32.44-20*Math.log10(o.fMHz))/20);
  return {fspl:fs,eirp,pr,margin,range:rng};
}
function rfSwr(swr){
  if(!(swr>=1)) return null;
  const g=(swr-1)/(swr+1);
  return {gamma:g, rl:g>0 ? -20*Math.log10(g) : Infinity, ml:-10*Math.log10(1-g*g), refl:g*g*100};
}
const rfSwrFromRl=rl=>{ if(!(rl>=0)) return null; const g=Math.pow(10,-rl/20); return g<1 ? (1+g)/(1-g) : Infinity; };
// два из V, I, R, P (0 / пусто — неизвестно) → остальные
function rfOhm(V,I,R,P){
  const k=[V,I,R,P].map(x=>x>0 ? 1 : 0);
  if(k[0]+k[1]+k[2]+k[3]!==2) return null;
  if(k[0] && k[1]) return {V,I,R:V/I,P:V*I};
  if(k[0] && k[2]) return {V,I:V/R,R,P:V*V/R};
  if(k[0] && k[3]) return {V,I:P/V,R:V*V/P,P};
  if(k[1] && k[2]) return {V:I*R,I,R,P:I*I*R};
  if(k[1] && k[3]) return {V:P/I,I,R:P/(I*I),P};
  return {V:Math.sqrt(P*R),I:Math.sqrt(P/R),R,P};
}
// резонанс: L в мкГн, C в пФ → f в Гц
const rfLc=(Luh,Cpf)=>Luh>0 && Cpf>0 ? 1/(2*Math.PI*Math.sqrt(Luh*1e-6*Cpf*1e-12)) : null;
// ёмкость для заданной частоты и индуктивности, пФ
const rfLcC=(fHz,Luh)=>fHz>0 && Luh>0 ? 1/(Math.pow(2*Math.PI*fHz,2)*Luh*1e-6)*1e12 : null;

/* ---- координаты ---- */
const CO_A=6378137, CO_F=1/298.257223563, CO_K0=.9996;
const CO_N=CO_F/(2-CO_F), CO_AA=CO_A/(1+CO_N)*(1+CO_N*CO_N/4+Math.pow(CO_N,4)/64);
const CO_AL=[CO_N/2-2*CO_N*CO_N/3+5*Math.pow(CO_N,3)/16, 13*CO_N*CO_N/48-3*Math.pow(CO_N,3)/5, 61*Math.pow(CO_N,3)/240];
const CO_BE=[CO_N/2-2*CO_N*CO_N/3+37*Math.pow(CO_N,3)/96, CO_N*CO_N/48+Math.pow(CO_N,3)/15, 17*Math.pow(CO_N,3)/480];
const CO_DE=[2*CO_N-2*CO_N*CO_N/3-2*Math.pow(CO_N,3), 7*CO_N*CO_N/3-8*Math.pow(CO_N,3)/5, 56*Math.pow(CO_N,3)/15];
const CO_BANDS='CDEFGHJKLMNPQRSTUVWX';
const coBand=lat=>lat>=84||lat<-80 ? '' : CO_BANDS[Math.min(19,Math.floor((lat+80)/8))];
function coZone(lat,lon){
  let z=Math.floor((lon+180)/6)+1; if(z>60) z=60; if(z<1) z=1;
  if(lat>=56 && lat<64 && lon>=3 && lon<12) z=32;                        // Норвегия
  if(lat>=72 && lat<84){ if(lon>=0 && lon<9) z=31; else if(lon>=9 && lon<21) z=33; else if(lon>=21 && lon<33) z=35; else if(lon>=33 && lon<42) z=37; }   // Шпицберген
  return z;
}
function coUtm(lat,lon,zone){
  if(!(Math.abs(lat)<=84 || lat>-80) || !isFinite(lat) || !isFinite(lon) || lat>84 || lat<-80) return null;
  const z=zone||coZone(lat,lon), l0=((z-1)*6-180+3)*Math.PI/180, f=lat*Math.PI/180, dl=lon*Math.PI/180-l0;
  const q=2*Math.sqrt(CO_N)/(1+CO_N), s=Math.sin(f);
  const t=Math.sinh(Math.atanh(s)-q*Math.atanh(q*s));
  const xp=Math.atan2(t,Math.cos(dl)), ep=Math.atanh(Math.sin(dl)/Math.sqrt(1+t*t));
  let x=xp, e=ep;
  for(let j=1;j<=3;j++){ x+=CO_AL[j-1]*Math.sin(2*j*xp)*Math.cosh(2*j*ep); e+=CO_AL[j-1]*Math.cos(2*j*xp)*Math.sinh(2*j*ep); }
  return {zone:z, band:coBand(lat), north:lat>=0, E:500000+CO_K0*CO_AA*e, N:CO_K0*CO_AA*x+(lat<0?1e7:0)};
}
function coFromUtm(zone,north,E,N){
  const l0=((zone-1)*6-180+3)*Math.PI/180;
  const x=((north ? N : N-1e7))/(CO_K0*CO_AA), e=(E-500000)/(CO_K0*CO_AA);
  let xp=x, ep=e;
  for(let j=1;j<=3;j++){ xp-=CO_BE[j-1]*Math.sin(2*j*x)*Math.cosh(2*j*e); ep-=CO_BE[j-1]*Math.cos(2*j*x)*Math.sinh(2*j*e); }
  const chi=Math.asin(Math.sin(xp)/Math.cosh(ep));
  let f=chi; for(let j=1;j<=3;j++) f+=CO_DE[j-1]*Math.sin(2*j*chi);
  const lon=l0+Math.atan2(Math.sinh(ep),Math.cos(xp));
  return {lat:f*180/Math.PI, lon:lon*180/Math.PI};
}
const CO_COL=['ABCDEFGH','JKLMNPQR','STUVWXYZ'], CO_ROW='ABCDEFGHJKLMNPQRSTUV';
// digits — 1…5 цифр на ось (10 км … 1 м)
function coMgrs(lat,lon,digits){
  const u=coUtm(lat,lon); if(!u) return null;
  const d=Math.max(1,Math.min(5,digits||5)), e=Math.floor(u.E), n=Math.floor(u.N);
  const col=CO_COL[(u.zone-1)%3][Math.floor(e/100000)-1], row=CO_ROW[(Math.floor(n/100000)+(u.zone%2===0?5:0))%20];
  const pad=v=>String(v%100000).padStart(5,'0').slice(0,d);
  return u.zone+u.band+' '+col+row+' '+pad(e)+' '+pad(n);
}
function coUtmText(lat,lon){
  const u=coUtm(lat,lon); if(!u) return null;
  return `${u.zone}${u.band} ${Math.round(u.E)} ${Math.round(u.N)}`;
}
// «18T WL 85628 11322» → центр клетки
function coFromMgrs(s){
  const m=/^\s*(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*((?:\d\s*){0,10})\s*$/i.exec(s); if(!m) return null;
  const zone=+m[1], band=m[2].toUpperCase(), c=m[3].toUpperCase(), r=m[4].toUpperCase();
  const dg=m[5].replace(/\s/g,''); if(dg.length%2 || zone<1 || zone>60) return null;
  const h=dg.length/2, step=Math.pow(10,5-h), mid=h ? step/2 : 50000;     // центр клетки
  const ci=CO_COL[(zone-1)%3].indexOf(c); if(ci<0) return null;
  const E=(ci+1)*100000+(h ? +dg.slice(0,h)*step : 0)+mid;
  const rowN=((CO_ROW.indexOf(r)-(zone%2===0?5:0))%20+20)%20*100000+(h ? +dg.slice(h)*step : 0)+mid;
  const north=band>='N', lat0=(CO_BANDS.indexOf(band))*8-80;
  const lonC=(zone-1)*6-180+3;
  let minN=coUtm(Math.max(-80,lat0),lonC,zone).N;
  if(!north) minN=coUtm(lat0,lonC,zone).N;
  let N=rowN; while(N<minN-1e-6) N+=2e6;
  return coFromUtm(zone,north,E,N);
}
function coMaiden(lat,lon,len){
  if(!(lat>=-90 && lat<=90 && lon>=-180 && lon<=180)) return null;
  len=[4,6,8,10].includes(len) ? len : 6;
  let x=(lon+180)/20, y=(lat+90)/10, out='';
  const A='ABCDEFGHIJKLMNOPQR', a='abcdefghijklmnopqrstuvwx';
  const fx=Math.min(17,Math.floor(x)), fy=Math.min(17,Math.floor(y)); out+=A[fx]+A[fy]; x=(x-fx)*10; y=(y-fy)*10;
  const sx=Math.min(9,Math.floor(x)), sy=Math.min(9,Math.floor(y)); out+=sx+''+sy; x=(x-sx)*24; y=(y-sy)*24;
  if(len>=6){ const ux=Math.min(23,Math.floor(x)), uy=Math.min(23,Math.floor(y)); out+=a[ux]+a[uy]; x=(x-ux)*10; y=(y-uy)*10; }
  if(len>=8){ const vx=Math.min(9,Math.floor(x)), vy=Math.min(9,Math.floor(y)); out+=vx+''+vy; x=(x-vx)*24; y=(y-vy)*24; }
  if(len>=10){ const wx=Math.min(23,Math.floor(x)), wy=Math.min(23,Math.floor(y)); out+=a[wx]+a[wy]; }
  return out;
}
function coFromMaiden(s){
  const m=/^\s*([A-R]{2})(\d{2})(?:([A-X]{2})(?:(\d{2})(?:([A-X]{2}))?)?)?\s*$/i.exec(s); if(!m) return null;
  const A='ABCDEFGHIJKLMNOPQR', a='abcdefghijklmnopqrstuvwx';
  let lon=-180+A.indexOf(m[1][0].toUpperCase())*20, lat=-90+A.indexOf(m[1][1].toUpperCase())*10, w=20, h=10;
  lon+=+m[2][0]*2; lat+=+m[2][1]; w=2; h=1;
  if(m[3]){ lon+=a.indexOf(m[3][0].toLowerCase())*5/60; lat+=a.indexOf(m[3][1].toLowerCase())*2.5/60; w=5/60; h=2.5/60; }
  if(m[4]){ lon+=+m[4][0]*w/10; lat+=+m[4][1]*h/10; w/=10; h/=10; }
  if(m[5]){ lon+=a.indexOf(m[5][0].toLowerCase())*w/24; lat+=a.indexOf(m[5][1].toLowerCase())*h/24; w/=24; h/=24; }
  return {lat:lat+h/2, lon:lon+w/2};
}
const coP=(v,p)=>v.toFixed(p);
function coDD(lat,lon,p){ p=p??5; return coP(lat,p)+', '+coP(lon,p); }
function coDMS(lat,lon){
  const one=(v,pos,neg)=>{ const h=v<0?neg:pos; v=Math.abs(v); let d=Math.floor(v), m=Math.floor((v-d)*60), s=((v-d)*60-m)*60;
    if(+s.toFixed(2)>=60){ s=0; m++; } if(m>=60){ m=0; d++; }
    return `${d}°${String(m).padStart(2,'0')}'${s.toFixed(2).padStart(5,'0')}"${h}`; };
  return one(lat,'N','S')+' '+one(lon,'E','W');
}
function coDDM(lat,lon){
  const one=(v,pos,neg)=>{ const h=v<0?neg:pos; v=Math.abs(v); let d=Math.floor(v), m=(v-d)*60;
    if(+m.toFixed(4)>=60){ m=0; d++; }
    return `${d}°${m.toFixed(4).padStart(7,'0')}'${h}`; };
  return one(lat,'N','S')+' '+one(lon,'E','W');
}
// любой формат → {lat,lon,fmt}: MGRS, UTM «33U 500000 5500000», локатор, DD / DDM / DMS с буквами или со знаком
function coParse(s){
  s=String(s??'').trim(); if(!s) return null;
  let r=coFromMaiden(s); if(r) return {...r,fmt:'Maidenhead'};
  const u=/^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d+(?:\.\d+)?)\s*m?[\s,;]+(\d+(?:\.\d+)?)\s*m?$/i.exec(s);
  if(u){ const zone=+u[1], band=u[2].toUpperCase(); r=coFromUtm(zone,band>='N',+u[3],+u[4]); return r ? {...r,fmt:'UTM'} : null; }
  r=coFromMgrs(s); if(r) return {...r,fmt:'MGRS'};
  const T=s.replace(/[°º'′"″]/g,' ').match(/[NSEWСЮВЗ]|-?\d+(?:[.,]\d+)?/gi); if(!T) return null;
  const map={'С':'N','Ю':'S','В':'E','З':'W'}, isH=t=>/^[NSEWСЮВЗ]$/i.test(t), hem=t=>map[t.toUpperCase()]||t.toUpperCase();
  const groups=[];
  if(isH(T[0])){                                       // буква перед числами: N 55 02.25  E 82 55.5
    let h=null, nums=[];
    for(const t of T){
      if(isH(t)){ if(h && nums.length) groups.push({nums,h}); h=hem(t); nums=[]; }
      else nums.push(+t.replace(',','.'));
    }
    if(h && nums.length) groups.push({nums,h});
  } else {                                             // буква после чисел или её нет
    let nums=[];
    for(const t of T){
      if(isH(t)){ if(nums.length) groups.push({nums,h:hem(t)}); nums=[]; }
      else nums.push(+t.replace(',','.'));
    }
    if(nums.length) groups.push({nums,h:null});
  }
  const val=g=>{ const [d,m=0,sec=0]=g.nums; if(g.nums.length>3) return NaN; const sg=(d<0||Object.is(d,-0)||g.h==='S'||g.h==='W')?-1:1; return sg*(Math.abs(d)+m/60+sec/3600); };
  let lat,lon;
  if(groups.length===2 && groups.every(g=>g.h)){
    for(const g of groups){ if(g.h==='N'||g.h==='S') lat=val(g); else lon=val(g); }
  } else {
    const all=groups.flatMap(g=>g.nums), n=all.length;
    if(![2,4,6].includes(n)) return null;
    const half=n/2, a={nums:all.slice(0,half),h:null}, b={nums:all.slice(half),h:null};
    lat=val(a); lon=val(b);
  }
  if(!isFinite(lat) || !isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180) return null;
  return {lat,lon,fmt:'DD / DMS'};
}
const CO_FMT=['DD','DMS','DDM','UTM','MGRS','Maidenhead'];
function coFormat(lat,lon,fmt,digits){
  if(!(Math.abs(lat)<=90 && Math.abs(lon)<=180)) return null;
  switch(String(fmt).toLowerCase()){
    case 'dd': return coDD(lat,lon);
    case 'dms': return coDMS(lat,lon);
    case 'ddm': return coDDM(lat,lon);
    case 'utm': return coUtmText(lat,lon);
    case 'mgrs': return coMgrs(lat,lon,digits);
    case 'maidenhead': case 'locator': case 'qth': return coMaiden(lat,lon,6);
  }
  return null;
}
