"use strict";
// ---- HF propagation: текущие солнечно-геомагнитные индексы (NOAA SWPC, открытый JSON с CORS) и
// грубая оценка прохождения по диапазонам для заданной точки. Модель ориентировочная (как у
// сводок N0NBH/hamqsl), не замена VOACAP: foF2 от SSN и высоты Солнца, MUF(3000)≈3.3·foF2,
// штрафы за поглощение в D-слое днём, вспышки (X-ray) и геомагнитные бури (Kp).

const SWPC='https://services.swpc.noaa.gov/';
const PROP_URLS={
  kp:   SWPC+'products/noaa-planetary-k-index.json',
  sfi:  SWPC+'json/f107_cm_flux.json',
  xray: SWPC+'json/goes/primary/xrays-6-hour.json',
  plasma: SWPC+'products/solar-wind/plasma-5-minute.json',
  mag:  SWPC+'products/solar-wind/mag-5-minute.json',
  ssn:  SWPC+'json/solar-cycle/swpc_observed_ssn.json',
};
// [название, опорная частота МГц для оценки, границы диапазона в кГц (РФ)]
const PROP_BANDS=[['160m',1.9,1810,2000],['80m',3.6,3500,3800],['40m',7.1,7000,7200],['30m',10.1,10100,10150],
  ['20m',14.1,14000,14350],['17m',18.1,18068,18168],['15m',21.2,21000,21450],['12m',24.9,24890,24990],
  ['10m',28.5,28000,29700],['6m',50.1,50000,52000]];
const PROP_LVL=['Good','Fair','Poor'], PROP_LVL_COL=['#43a047','#f9a825','#c62828'];
const PROP_CACHE_KEY='dsp-propagation-cache';

// SWPC отдаёт и массив массивов с шапкой в первой строке, и массив объектов — приводим к объектам
function propRows(j){
  if(!Array.isArray(j)||!j.length) return [];
  if(Array.isArray(j[0])){ const h=j[0]; return j.slice(1).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]]))); }
  return j.filter(r=>r&&typeof r==='object');
}
const propNum=v=>{ const x=parseFloat(v); return isFinite(x)?x:null; };
const propTime=r=>{
  const s=String(r.time_tag||r.Obsdate||r.date||'').replace(' ','T');
  return Date.parse(s+(/Z|[+-]\d\d:?\d\d$/.test(s)?'':'Z'))||0;
};
// последняя по времени строка с числовым полем key (первым найденным из списка)
function propLatest(rows,keys,filter){
  let best=null, bt=-Infinity;
  for(const r of rows){
    if(filter&&!filter(r)) continue;
    const k=keys.find(k=>propNum(r[k])!=null); if(!k) continue;
    const t=propTime(r); if(t>=bt){ bt=t; best={v:propNum(r[k]),t,row:r}; }
  }
  return best;
}

async function propFetch(n){
  n.busy=true; n.err='';
  const get=async u=>{ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error(r.status); return propRows(await r.json()); };
  const keys=Object.keys(PROP_URLS);
  const res=await Promise.allSettled(keys.map(k=>get(PROP_URLS[k])));
  const R={}; keys.forEach((k,i)=>{ if(res[i].status==='fulfilled') R[k]=res[i].value; });
  const d={...(n.data||{})};
  if(R.kp){
    const kp=R.kp.map(r=>({t:propTime(r),v:propNum(r.Kp??r.kp_index??r.kp)})).filter(x=>x.v!=null).sort((a,b)=>a.t-b.t);
    if(kp.length){ d.kp=kp[kp.length-1].v; d.kpHist=kp.slice(-8); }
    const a=propLatest(R.kp,['a_running','ap']); if(a) d.a=a.v;
  }
  if(R.sfi){ const s=propLatest(R.sfi,['flux'],r=>r.frequency==null||+r.frequency===2800); if(s) d.sfi=s.v; }
  if(R.xray){
    const x=propLatest(R.xray,['flux'],r=>!r.energy||r.energy==='0.1-0.8nm'); if(x) d.xray=x.v;
    let mx=0; for(const r of R.xray) if((!r.energy||r.energy==='0.1-0.8nm')) mx=Math.max(mx,propNum(r.flux)||0);
    if(mx) d.xrayMax=mx;
  }
  if(R.plasma){ const p=propLatest(R.plasma,['speed']); if(p) d.wind=p.v; const q=propLatest(R.plasma,['density']); if(q) d.dens=q.v; }
  if(R.mag){ const b=propLatest(R.mag,['bz_gsm']); if(b) d.bz=b.v; }
  if(R.ssn){ const s=propLatest(R.ssn,['swpc_ssn','ssn','Ri','ri']); if(s) d.ssn=s.v; }
  const got=keys.filter(k=>R[k]).length;
  if(got){ d.t=Date.now(); n.data=d; try{ localStorage.setItem(PROP_CACHE_KEY,JSON.stringify(d)); }catch(e){} }
  if(got<keys.length) n.err = got ? 'partial: '+keys.filter(k=>!R[k]).join(',') : 'no data (offline/CORS)';
  n.busy=false; n.lastTry=Date.now();
}

// высота Солнца, градусы (упрощённый алгоритм NOAA, точность ~1°)
function propSunDecl(ms){
  const d=(ms-Date.UTC(2000,0,1,12))/864e5, g=(357.529+0.98560028*d)*Math.PI/180;
  const q=280.459+0.98564736*d, L=(q+1.915*Math.sin(g)+0.020*Math.sin(2*g))*Math.PI/180;
  const e=(23.439-0.00000036*d)*Math.PI/180;
  const dec=Math.asin(Math.sin(e)*Math.sin(L));
  const ra=Math.atan2(Math.cos(e)*Math.sin(L),Math.cos(L));
  const gmst=(18.697374558+24.06570982441908*d)%24;
  return {dec, ra, gmst};
}
function propSunElev(ms,lat,lon){
  const {dec,ra,gmst}=propSunDecl(ms), rad=Math.PI/180;
  const ha=(gmst*15+lon)*rad-ra, la=lat*rad;
  return Math.asin(Math.sin(la)*Math.sin(dec)+Math.cos(la)*Math.cos(dec)*Math.cos(ha))/rad;
}
// SSN из SFI: обращение SFI = 63.7 + 0.728R + 0.00089R²
function propSsnFromSfi(sfi){
  const c=0.00089, b=0.728, a=63.7-sfi;
  return Math.max(0,(-b+Math.sqrt(b*b-4*c*a))/(2*c));
}
function propMuf(el,R,kp){
  const day=4.3+0.043*R, night=2.3+0.012*R;
  const w=clamp((el+6)/36,0,1), s=w*w*(3-2*w);
  let fo=night+(day-night)*s;
  fo*=Math.max(.6,1-0.05*Math.max(0,(kp||0)-3));
  return 3.3*fo;
}
// список для входа 'bands' у 'sa': диапазоны с оценкой прохождения (цвет — по оценке) и точка MUF.
// Пересобирается раз в минуту — между пересборками отдаём тот же массив.
function propBands(n){
  const d=n.data, lat=+n.p.lat||0, lon=+n.p.lon||0, now=Date.now();
  const key=Math.floor(now/60e3)+'|'+(d?.t||0)+'|'+lat+','+lon+'|'+n.p.bandsFor;
  if(key===n._bandsKey) return n._bands;
  n._bandsKey=key; n._bands=[];
  if(!d||(d.sfi==null&&d.ssn==null)) return n._bands;
  const {dec}=propSunDecl(now), decD=dec*180/Math.PI;
  const el = n.p.bandsFor==='day' ? 90-Math.abs(lat-decD)
           : n.p.bandsFor==='night' ? -90+Math.abs(lat+decD) : propSunElev(now,lat,lon);
  const month=new Date(now).getUTCMonth();
  for(const [name,f,lo,hi] of PROP_BANDS){
    const lv=propRate(f,el,d,lat,month);
    n._bands.push({lo:lo*1e3,hi:hi*1e3,label:name+' '+PROP_LVL[lv],color:PROP_LVL_COL[lv],step:100});
  }
  const ssn=d.ssn!=null?d.ssn:propSsnFromSfi(d.sfi??70), muf=propMuf(el,ssn,d.kp);
  n._bands.push({lo:Math.round(muf*1e4)*100,hi:Math.round(muf*1e4)*100,label:'MUF '+muf.toFixed(1)+'M',color:'#ffffff',step:0});
  return n._bands;
}
// 0 Good / 1 Fair / 2 Poor
function propRate(fMHz,el,d,lat,month){
  const R=d.ssn!=null?d.ssn:propSsnFromSfi(d.sfi??70), kp=d.kp??2, muf=propMuf(el,R,kp);
  const isDay=el>0;
  if(fMHz>30){                                      // 6m: F2 только при высокой MUF, иначе Es летом днём
    if(muf>fMHz) return 0;
    const esSeason = lat>=0 ? (month>=4&&month<=7) : (month>=10||month<=1);
    return esSeason&&el>-6 ? 1 : 2;
  }
  let lv = fMHz>muf*1.15 ? 2 : fMHz>muf*.85 ? 1 : 0;
  if(isDay){                                       // поглощение в D-слое
    const sunF=clamp(el/40,0,1);
    if(fMHz<2.5) lv+= sunF>.1?2:1;
    else if(fMHz<5) lv+= sunF>.3?1:0;
    const x=d.xray||0;
    if(x>=1e-4) lv+=2; else if(x>=1e-5 && fMHz<15) lv+=1;
  }
  if(kp>=7) lv+=2; else if(kp>=5) lv+=1;
  return Math.min(2,lv);
}
function propXClass(f){
  if(!f) return '—';
  const cls=[['X',1e-4],['M',1e-5],['C',1e-6],['B',1e-7],['A',1e-8]].find(([,b])=>f>=b)||['A',1e-8];
  return cls[0]+(f/cls[1]).toFixed(1);
}
function propGeo(kp){
  if(kp==null) return ['—','#9e9e9e'];
  if(kp>=5) return ['Storm G'+Math.min(5,Math.floor(kp)-4),'#c62828'];
  if(kp>=4) return ['Active','#f9a825'];
  if(kp>=3) return ['Unsettled','#fdd835'];
  return ['Quiet','#43a047'];
}
function propRScale(f){
  if(!f||f<1e-5) return 'R0';
  return f>=2e-3?'R5':f>=1e-3?'R4':f>=1e-4?'R3':f>=5e-5?'R2':'R1';
}

def({ id:'propagation', title:'HF Propagation', cat:'Radio',
  // Индексы NOAA SWPC (SFI, SSN, Kp/A, рентген GOES, солнечный ветер) и оценка прохождения
  // КВ-диапазонов: днём/ночью (полдень/полночь по Солнцу для точки lat/lon) и сейчас. Выход bands —
  // диапазоны, раскрашенные по оценке, и отметка MUF: на вход bands у 'sa' (или через 'bandsmerge').
  outs:[{n:'sfi',t:'num'},{n:'ssn',t:'num'},{n:'kp',t:'num'},{n:'a',t:'num'},{n:'muf',t:'num'},{n:'xray',t:'num'},{n:'bands',t:'bands'}],
  w:360, view:{h:300}, resize:true,
  params:[
    {n:'lat',t:'num',d:55.75,label:'lat, °'},
    {n:'lon',t:'num',d:37.62,label:'lon, °'},
    {n:'bandsFor',t:'select',opts:['now','day','night'],d:'now',label:'bands output'},
    {n:'period',t:'select',opts:['5 min','15 min','30 min','60 min'],d:'15 min',label:'refresh'},
    {n:'locate',t:'button',label:'⌖ Locate',fn:n=>{
      navigator.geolocation?.getCurrentPosition(p=>{
        const r=v=>Math.round(v*100)/100;
        setMod(n,'lat',r(p.coords.latitude)); setMod(n,'lon',r(p.coords.longitude)); },
        e=>{ n.err='geolocation: '+e.message; }); }},
    {n:'refresh',t:'button',label:'↻ Refresh',fn:n=>{ if(!n.busy) propFetch(n); }},
  ],
  init:n=>{
    n.busy=false; n.lastTry=0; n.err='';
    try{ const c=JSON.parse(localStorage.getItem(PROP_CACHE_KEY)||'null'); if(c&&typeof c==='object') n.data=c; }catch(e){}
    n.data=n.data||null;
  },
  process(n){
    const d=n.data; if(!d) return {bands:[]};
    const ssn=d.ssn!=null?d.ssn:propSsnFromSfi(d.sfi??70);
    const el=propSunElev(Date.now(),+n.p.lat||0,+n.p.lon||0);
    return {sfi:d.sfi??0, ssn, kp:d.kp??0, a:d.a??0, muf:propMuf(el,ssn,d.kp), xray:d.xray??0, bands:propBands(n)};
  },
  draw(n,cv,cx){
    const per=(parseInt(n.p.period)||15)*60e3;
    if(!n.busy && Date.now()-n.lastTry>(n.err&&!n.data?60e3:per)) propFetch(n);
    const W=cv.width, H=cv.height, d=n.data||{};
    // перерисовываем раз в секунду — данные меняются редко
    const key=W+'x'+H+'|'+(d.t||0)+'|'+n.err+'|'+n.busy+'|'+n.p.lat+','+n.p.lon+'|'+Math.floor(Date.now()/1e3);
    if(key===n._drawKey) return; n._drawKey=key;
    cx.clearRect(0,0,W,H);
    cx.font='11px monospace'; cx.textBaseline='alphabetic';
    const fg=themeColor('--screen-fg'), ax=themeColor('--axis');
    const lat=+n.p.lat||0, lon=+n.p.lon||0, now=Date.now();
    const ssn=d.ssn!=null?d.ssn:(d.sfi!=null?propSsnFromSfi(d.sfi):null);
    // ---- индексы: плитки в строку, переносятся по ширине ----
    const [geoT,geoC]=propGeo(d.kp);
    const tiles=[
      ['SFI', d.sfi!=null?d.sfi.toFixed(0):'—', fg],
      ['SSN', ssn!=null?(d.ssn!=null?'':'~')+ssn.toFixed(0):'—', fg],
      ['Kp', d.kp!=null?d.kp.toFixed(2).replace(/0$/,''):'—', geoC],
      ['A', d.a!=null?d.a.toFixed(0):'—', fg],
      ['X-ray', propXClass(d.xray), d.xray>=1e-5?'#ef5350':fg],
      ['Wind', d.wind!=null?d.wind.toFixed(0)+'km/s':'—', d.wind>=600?'#ef5350':fg],
      ['Bz', d.bz!=null?d.bz.toFixed(1)+'nT':'—', d.bz<=-10?'#ef5350':fg],
    ];
    let x=4, y=4;
    for(const [k,v,c] of tiles){
      const tw=Math.max(cx.measureText(k).width,cx.measureText(v).width)+10;
      if(x+tw>W-2 && x>4){ x=4; y+=30; }
      cx.fillStyle=ax; cx.fillText(k,x,y+10);
      cx.fillStyle=c; cx.fillText(v,x,y+24);
      x+=tw+4;
    }
    y+=34;
    const el=propSunElev(now,lat,lon);
    const muf=propMuf(el,ssn??0,d.kp);
    cx.fillStyle=geoC; cx.fillText(geoT,4,y+10);
    let gx=4+cx.measureText(geoT).width+10;
    const rs=propRScale(d.xrayMax||d.xray);
    cx.fillStyle=rs==='R0'?fg:'#ef5350'; cx.fillText(rs,gx,y+10); gx+=cx.measureText(rs).width+10;
    cx.fillStyle=fg; cx.fillText('MUF≈'+muf.toFixed(1)+'MHz · sun '+el.toFixed(0)+'°',gx,y+10);
    y+=16;
    // ---- таблица диапазонов: день / ночь (полдень/полночь по Солнцу для точки) / сейчас ----
    const {dec}=propSunDecl(now), decD=dec*180/Math.PI;
    const elNoon=90-Math.abs(lat-decD), elNight=-90+Math.abs(lat+decD);
    const month=new Date(now).getUTCMonth();
    const cols=[['Day',elNoon],['Night',elNight],['Now',el]];
    const c0=46, cw=Math.max(30,Math.floor((W-c0-8)/3)), rh=Math.max(12,Math.min(16,Math.floor((H-y-50)/(PROP_BANDS.length+1))));
    cx.fillStyle=ax;
    cols.forEach(([t],i)=>{ const tx=c0+i*cw+(cw-cx.measureText(t).width)/2; cx.fillText(t,Math.round(tx),y+rh-4); });
    y+=rh;
    for(const [name,f] of PROP_BANDS){
      cx.fillStyle=fg; cx.fillText(name,4,y+rh-4);
      cols.forEach(([,e],i)=>{
        const lv=d.sfi!=null||d.ssn!=null ? propRate(f,e,d,lat,month) : null;
        const bx=c0+i*cw;
        cx.fillStyle=lv==null?'#424242':PROP_LVL_COL[lv]; cx.fillRect(bx+1,y+1,cw-2,rh-2);
        const t=lv==null?'—':PROP_LVL[lv];
        cx.fillStyle=lv==null?fg:contrastText(PROP_LVL_COL[lv]);
        cx.fillText(t,Math.round(bx+(cw-cx.measureText(t).width)/2),y+rh-4);
      });
      y+=rh;
    }
    // ---- Kp за последние 24 ч (8 трёхчасовых значений) ----
    const hist=d.kpHist||[];
    const kh=Math.min(36,H-y-18);
    if(hist.length && kh>10){
      y+=4;
      cx.fillStyle=ax; cx.fillText('Kp 24h',4,y+kh/2+4);
      const bw=Math.max(4,Math.floor((W-c0-8)/8));
      hist.forEach((p,i)=>{
        const h=Math.max(1,Math.round(clamp(p.v/9,0,1)*kh)), bx=c0+i*bw;
        cx.fillStyle=propGeo(p.v)[1]; cx.fillRect(bx+1,y+kh-h,bw-2,h);
      });
      y+=kh;
    }
    // ---- статус ----
    const age=d.t?Math.round((now-d.t)/60e3):null;
    const st=n.busy?'updating…':(n.err?n.err+' · ':'')+(age!=null?'NOAA SWPC · '+(age<1?'just now':age+' min ago'):'');
    cx.fillStyle=n.err?'#ef9a9a':ax; cx.fillText(st,4,H-4);
  }});
