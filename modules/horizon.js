"use strict";
/* ============================ ГОРИЗОНТ ============================ */
// Профиль горизонта: для каждого азимута — наибольший угол места рельефа над точкой наблюдения.
// Высоты — Terrain-RGB тайлы (AWS Terrarium), разово скачиваются и хранятся в IndexedDB (как TLE в sat.js).
// Точка наблюдения — My Position (GeoMe) или провода lat / lon. Профиль общий (Horizon) — его читают другие узлы.

const HZ_URL='https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const HZ_MAX_TILES=150;
const Horizon={prof:null, lat:null, lon:null, src:'', gen:0};  // prof — Float32Array(360), °, индекс — азимут; gen растёт при смене профиля или точки
function horizonPublish(prof,lat,lon,src){
  const H=Horizon;
  if(H.prof!==prof || H.lat!==lat || H.lon!==lon) H.gen++;
  H.prof=prof; H.lat=lat; H.lon=lon; H.src=src;
}

function horizonInterp(prof,az){
  az=((az%360)+360)%360;
  const i=Math.floor(az), f=az-i;
  return prof[i%360]*(1-f)+prof[(i+1)%360]*f;
}
// профиль, если он посчитан для этой точки (±2 км), иначе null
function horizonFor(lat,lon){
  const H=Horizon;
  if(!H.prof || lat==null || lon==null) return null;
  if(Math.abs(lat-H.lat)>.02 || Math.abs(lon-H.lon)>.02/Math.max(.1,Math.cos(lat*D2R))) return null;
  return H.prof;
}
// угол горизонта в азимуте az для точки lat/lon; 0 — профиля для этой точки нет
function horizonAt(az,lat,lon){
  const pr=horizonFor(lat,lon);
  return pr && az!=null ? horizonInterp(pr,az) : 0;
}
// силуэт гор на полярном графике: xy(az,el) → [x,y], rimEl — угол на краю круга; без профиля точки не рисует
function horizonSilhouette(cx,xy,rimEl,lat,lon,color,alpha){
  const pr=horizonFor(lat,lon); if(!pr) return;
  const outer=[], inner=[];
  for(let a=0;a<360;a+=2){ outer.push(xy(a,rimEl)); inner.push(xy(a,Math.max(horizonInterp(pr,a),rimEl))); }
  cx.beginPath();
  for(const poly of [outer,inner]){ poly.forEach(([x,y],i)=>i ? cx.lineTo(x,y) : cx.moveTo(x,y)); cx.closePath(); }
  cx.fillStyle=color; cx.globalAlpha=alpha; cx.fill('evenodd'); cx.globalAlpha=1;
}

// hAt(lat,lon) → высота, м (NaN — нет данных); h0 — высота антенны над уровнем моря, м.
// Кривизна Земли с рефракцией: радиус k·R, провал рельефа d²/(2·k·R).
function horizonProfile(hAt,lat,lon,h0,o){
  const Rm=GEO_R*1000, Re=Rm*o.k, out=new Float32Array(360);
  const la=lat*D2R, lo=lon*D2R, sl=Math.sin(la), cl=Math.cos(la);
  for(let a=0;a<360;a++){
    const th=a*D2R, ct=Math.cos(th), st=Math.sin(th);
    let best=-90;
    for(let d=o.step;d<=o.radius;d+=o.step){
      const dl=d/Rm, sd=Math.sin(dl), cd=Math.cos(dl);
      const s2=sl*cd+cl*sd*ct, la2=Math.asin(s2), lo2=lo+Math.atan2(st*sd*cl,cd-sl*s2);
      const h=hAt(la2/D2R,lo2/D2R);
      if(h!==h) continue;
      const e=Math.atan((h-h0-d*d/(2*Re))/d)/D2R;
      if(e>best) best=e;
    }
    out[a]=best>-90 ? best : 0;
  }
  return out;
}
// tiles: Map 'x/y' → Float32Array(256·256); билинейная выборка по Web Mercator
function horizonSampler(tiles,z){
  const W=(1<<z)*256;
  const px=(ix,iy)=>{
    if(iy<0 || iy>=W) return NaN;
    ix=((ix%W)+W)%W;
    const t=tiles.get((ix>>8)+'/'+(iy>>8));
    return t ? t[(iy&255)*256+(ix&255)] : NaN;
  };
  return (lat,lon)=>{
    const fx=mercX(lon)*W-.5, fy=mercY(lat)*W-.5, x0=Math.floor(fx), y0=Math.floor(fy), tx=fx-x0, ty=fy-y0;
    return (px(x0,y0)*(1-tx)+px(x0+1,y0)*tx)*(1-ty)+(px(x0,y0+1)*(1-tx)+px(x0+1,y0+1)*tx)*ty;
  };
}
function horizonTileList(lat,lon,radiusKm,z){
  const N=1<<z, dLat=radiusKm/111.19, dLon=Math.min(180,dLat/Math.max(.05,Math.cos(lat*D2R)));
  const x0=Math.floor(mercX(lon-dLon)*N), x1=Math.floor(mercX(lon+dLon)*N);
  const y0=Math.max(0,Math.floor(mercY(Math.min(85,lat+dLat))*N)), y1=Math.min(N-1,Math.floor(mercY(Math.max(-85,lat-dLat))*N));
  const out=[];
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) out.push([((x%N)+N)%N,y]);
  return out;
}
async function horizonTile(z,x,y,proxy){
  const key='dem:'+z+'/'+x+'/'+y;
  let buf=await geoGet(key).catch(()=>null);
  if(!buf){
    const r=await fetch(proxy+HZ_URL.replace('{z}',z).replace('{x}',x).replace('{y}',y));
    if(!r.ok) throw new Error('HTTP '+r.status);
    buf=await r.arrayBuffer();
    geoPut(key,buf).catch(()=>{});
  }
  const bmp=await createImageBitmap(new Blob([buf],{type:'image/png'}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  const cv=document.createElement('canvas'); cv.width=cv.height=256;
  const cx=cv.getContext('2d',{willReadFrequently:true});
  cx.drawImage(bmp,0,0); bmp.close?.();
  const d=cx.getImageData(0,0,256,256).data, out=new Float32Array(65536);
  for(let i=0;i<65536;i++) out[i]=d[i*4]*256+d[i*4+1]+d[i*4+2]/256-32768;
  return out;
}

async function horizonRun(n,lat,lon,key){
  const p=n.p, z=Math.round(+p.zoom), tok=n.tok={}, job=n.job={key,lat,lon};
  const fail=m=>{ if(n.tok!==tok) return; n.msg=m; n.job=null; n.done={...job,err:true}; };
  try{
    const list=horizonTileList(lat,lon,+p.radius,z);
    if(list.length>HZ_MAX_TILES) return fail(list.length+' tiles — lower the radius or the zoom');
    const tiles=new Map(), proxy=p.proxy||'';
    let i=0, ok=0, bad=0, err='';
    const worker=async()=>{
      while(i<list.length && n.tok===tok){
        const [x,y]=list[i++];
        try{ tiles.set(x+'/'+y,await horizonTile(z,x,y,proxy)); ok++; }
        catch(e){ bad++; err=e.message; }
        n.msg='terrain tiles '+(ok+bad)+'/'+list.length;
      }
    };
    await Promise.all(Array.from({length:6},worker));
    if(n.tok!==tok) return;
    if(!ok) return fail('terrain: '+err+' — set a CORS proxy or import a profile file');
    const hAt=horizonSampler(tiles,z), g=hAt(lat,lon);
    if(g!==g) return fail('no terrain data at the observer');
    const pix=2*Math.PI*6378137*Math.cos(lat*D2R)/((1<<z)*256);
    const prof=horizonProfile(hAt,lat,lon,g+(+p.ant||0),{radius:+p.radius*1000, step:Math.max(50,pix), k:+p.k||1.33});
    n.prof=prof; n.ground=g; n.manual=false; n.srcTxt='terrain z'+z+', '+list.length+' tiles'+(bad?', '+bad+' failed':'');
    n.job=null; n.done=job; n.msg='';
    horizonPublish(prof,lat,lon,n.srcTxt);
  }catch(e){ fail('terrain: '+e.message); }
}
function horizonTick(n,lat,lon){
  if(lat==null || lon==null){ n.noPos=true; return; }
  n.noPos=false;
  if(n.manual && !n.req){ horizonPublish(n.prof,lat,lon,n.srcTxt); return; }
  const p=n.p, key=[p.radius,p.zoom,p.ant,p.k].join('|'), ref=n.job||n.done;
  const changed=!ref || ref.key!==key || geoDist(ref.lat,ref.lon,lat,lon)>1;
  if(!changed && !n.req) return;
  const now=Date.now();
  if(!n.due) n.due=now+(n.req ? 0 : 500);                // слайдер не запускает загрузку на каждый шаг
  if(now<n.due) return;
  n.due=0; n.req=false;
  horizonRun(n,lat,lon,key);
}
// файл: строки «азимут, угол» (любой разделитель), пропуски заполняются линейно по кругу
function horizonFromPairs(text){
  const pts=[];
  for(const ln of String(text).split(/\r?\n/)){
    const m=ln.trim().match(/^(-?[\d.]+)[\s,;]+(-?[\d.]+)/);
    if(m) pts.push([((+m[1]%360)+360)%360,+m[2]]);
  }
  if(pts.length<2) return null;
  pts.sort((a,b)=>a[0]-b[0]);
  const out=new Float32Array(360), L=pts.length;
  for(let a=0;a<360;a++){
    let j=pts.findIndex(q=>q[0]>a);
    if(j<0) j=0;
    const q1=pts[j], q0=pts[(j+L-1)%L];
    let span=q1[0]-q0[0], off=a-q0[0];
    if(span<=0) span+=360;
    if(off<0) off+=360;
    out[a]=q0[1]+(q1[1]-q0[1])*Math.min(1,off/span);
  }
  return out;
}

def({ id:'horizon', title:'Horizon', cat:'Radio',
  // Горизонт с рельефом: профиль «азимут → угол места гор» по карте высот.
  // el — угол горизонта в азимуте az (+ запас), max / maxaz — самая высокая точка профиля.
  ins:[{n:'az',t:'num'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'el',t:'num'},{n:'max',t:'num'},{n:'maxaz',t:'num'}],
  w:340, view:{h:130}, resize:true, readout:true,
  params:[{n:'radius',t:'range',min:5,max:100,step:5,d:50,label:'radius, km'},
          {n:'zoom',t:'range',min:8,max:12,step:1,d:10,label:'terrain zoom (10 ≈ 150 m per pixel)'},
          {n:'ant',t:'num',d:2,label:'antenna height above ground, m'},
          {n:'k',t:'range',min:1,max:2,step:.01,d:1.33,label:'refraction k (4/3 — standard)'},
          {n:'margin',t:'num',d:0,label:'margin on the output, °'},
          {n:'calc',t:'button',label:'Recalculate',fn:n=>{ n.req=true; }},
          {n:'file',t:'file',accept:'.csv,.txt',fn:(n,f)=>{
            const rd=new FileReader(); rd.onload=()=>{
              const pr=horizonFromPairs(String(rd.result));
              if(!pr){ n.msg='no «azimuth, elevation» rows in file'; return; }
              n.tok=null; n.prof=pr; n.manual=true; n.srcTxt='file: '+f.name; n.msg=''; }; rd.readAsText(f); },adv:true},
          {n:'proxy',t:'text',d:'',label:'CORS proxy prefix',adv:true}],
  init:n=>{ n.msg=''; n.prof=null; n.done=null; n.job=null; n.tok=null; n.due=0; n.req=false; n.manual=false;
            n.noPos=false; n.ground=null; n.srcTxt=''; n.az=null; },
  process(n,I){
    const lat=recNum(I.lat) ?? GeoMe.lat, lon=recNum(I.lon) ?? GeoMe.lon;
    horizonTick(n,lat,lon);
    const az=recNum(I.az); n.az=az;
    if(!n.prof) return {el:null,max:null,maxaz:null};
    const m=+n.p.margin||0;
    let mx=-90, mi=0;
    for(let a=0;a<360;a++) if(n.prof[a]>mx){ mx=n.prof[a]; mi=a; }
    return {el:az!=null ? horizonInterp(n.prof,az)+m : null, max:mx+m, maxaz:mi};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, pr=n.prof;
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    const L=[];
    if(n.msg) L.push(n.msg);
    if(n.noPos) L.push('no observer — add My Position or wire lat / lon');
    if(pr){
      let mx=0, mi=0;
      for(let a=0;a<360;a++) if(pr[a]>mx){ mx=pr[a]; mi=a; }
      const top=Math.max(10,Math.ceil(mx/10)*10), pad=14, X=a=>pad+a/360*(W-2*pad), Y=e=>H-pad-Math.max(0,e)/top*(H-2*pad);
      cx.strokeStyle=themeColor('--axis')||'#2a3a40'; cx.lineWidth=1; cx.beginPath();
      for(let a=0;a<=360;a+=90){ cx.moveTo(X(a),pad); cx.lineTo(X(a),H-pad); }
      for(let e=0;e<=top;e+=10){ cx.moveTo(pad,Y(e)); cx.lineTo(W-pad,Y(e)); }
      cx.globalAlpha=.4; cx.stroke(); cx.globalAlpha=1;
      cx.beginPath(); cx.moveTo(X(0),Y(0));
      for(let a=0;a<=360;a++) cx.lineTo(X(a),Y(pr[a%360]));
      cx.lineTo(X(360),Y(0)); cx.closePath();
      cx.fillStyle=themeColor('--acc')||'#7dff9a'; cx.globalAlpha=.35; cx.fill(); cx.globalAlpha=1;
      cx.strokeStyle=themeColor('--acc')||'#7dff9a'; cx.stroke();
      if(n.az!=null){ const x=X(((n.az%360)+360)%360); cx.strokeStyle='#ffd84a'; cx.beginPath(); cx.moveTo(x,pad); cx.lineTo(x,H-pad); cx.stroke(); }
      cx.fillStyle='#6c7a80'; cx.font='10px monospace'; cx.textBaseline='alphabetic';
      cx.textAlign='center';
      ['N','E','S','W','N'].forEach((s,i)=>cx.fillText(s,X(i*90),H-3));
      cx.textAlign='left'; cx.fillText(top+'°',2,pad-3);
      L.push(n.srcTxt+(n.ground!=null ? ' · ground '+Math.round(n.ground)+' m' : ''));
      L.push('max '+mx.toFixed(1)+'° at az '+mi+'°'+(n.az!=null ? ' · az '+Math.round(n.az)+'° → '+horizonInterp(pr,n.az).toFixed(1)+'°' : ''));
    }
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
