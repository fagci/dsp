"use strict";
/* Image on Map: снимок с дрона, ортофото, скриншот или фото сверху — на карту и под Plan Editor по опорным точкам.
   Снимок лежит в Files (путь в параметре img — переживает перезагрузку и работает без сети). Щёлкаете на снимке углы / столбики, имена которых
   знает план (A, B, C… из Site Plan на входе rec): по ним считается привязка (2 точки — поворот и масштаб, 3 и больше — ещё перекос). Ядро — geoimage-kernels.js. */

async function giFind(path,create){                                         // путь «Images/plot.jpg» в Files → {dir, name, rec}
  const a=String(path??'').replace(/\\/g,'/').split('/').map(x=>x.trim()).filter(x=>x && x!=='.' && x!=='..'); if(!a.length) return null;
  const name=a.pop(); let id=FS_ROOT;
  for(const nm of a){
    const f=(await FileStore.listFolders('files',id)).find(x=>x.name===nm);
    if(f) id=f.id; else if(create) id=await FileStore.addFolder('files',nm,id); else return null;
  }
  return {dir:id,name,rec:(await FileStore.list('files',id)).find(x=>x.name===name)||null};
}
async function giLoad(n){
  const path=String(n.p.img||'').trim(), tok=n.loadTok=(n.loadTok||0)+1;
  n.loaded=path;
  if(!path){ n.bm=null; n.src=null; n.msg='choose an image (or type its path in Files)'; n.dirty=true; redraw(n); return; }
  try{
    const f=await giFind(path,false); if(tok!==n.loadTok) return;
    if(!f || !f.rec){ n.bm=null; n.src=null; n.msg='no file «'+path+'» in Files — choose the image again'; n.dirty=true; redraw(n); return; }
    const bm=await createImageBitmap((await FileStore.get(f.rec.id)).blob); if(tok!==n.loadTok){ bm.close?.(); return; }
    n.bm?.close?.(); n.bm=bm; n.src=null; n.msg=''; n.dirty=true; redraw(n);
  }catch(e){ n.bm=null; n.src=null; n.msg='image: '+e.message; n.dirty=true; redraw(n); }
}
function giSmall(n){                                                        // уменьшенная копия снимка (≤ maxpx по большей стороне) для перепроекции
  const bm=n.bm, m=Math.max(256,+n.p.maxpx||2048), k=Math.min(1,m/Math.max(bm.width,bm.height)), sw=Math.max(1,Math.round(bm.width*k)), sh=Math.max(1,Math.round(bm.height*k));
  const c=document.createElement('canvas'); c.width=sw; c.height=sh; const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(bm,0,0,sw,sh);
  return {data:x.getImageData(0,0,sw,sh).data,sw,sh,w:bm.width,h:bm.height,m};
}
async function giPick(n,f){                                                 // выбранный файл — в Files; путь — в параметр img
  try{
    const path=String(n.p.img||'').trim() || 'Images/'+String(f.name||'image.jpg').replace(/[\\/]/g,'_'), F=await giFind(path,true);
    if(F.rec) await FileStore.update(F.rec.id,{blob:f,mime:f.type||'image/jpeg'}); else await FileStore.put({space:'files',folderId:F.dir,name:F.name,mime:f.type||'image/jpeg',blob:f});
    n.p.img=path; if(n.set?.img) n.set.img(path); n.pts=[]; giSave(n); giLoad(n);
  }catch(e){ n.msg='file: '+e.message; redraw(n); }
}
const giSave=n=>{ n.p.state=JSON.stringify({pts:n.pts}); };
const giNames=n=>String(n.p.names||'').split(/[\s,;]+/).filter(Boolean);

// точки: щелчки по снимку (по порядку имён) + строки «u v ИМЯ» / «u v lat lon» из параметра extra
function giPairs(n){
  const names=giNames(n), L=[]; n.pts.forEach((q,i)=>{ if(names[i]) L.push({u:q[0],v:q[1],name:names[i]}); });
  const E=giParse(n.p.extra); L.push(...E.pts); n.extraErr=E.errors;
  const geo=[], plan=[], miss=[];
  for(const p of L){
    const k=p.name ? n.known.get(p.name) : null;
    const lat=p.lat ?? k?.lat, lon=p.lon ?? k?.lon;
    if(isFinite(lat) && isFinite(lon)) geo.push({u:p.u,v:p.v,lat,lon});
    if(k && isFinite(k.x) && isFinite(k.y)) plan.push({u:p.u,v:p.v,X:k.x,Y:k.y});
    if(p.name && !k) miss.push(p.name);
  }
  return {geo,plan,miss};
}
function giCalc(n){
  n.fitG=null; n.fitP=null; n.rast=null; n.under=null; n.bad='';
  if(!n.bm) return;
  const P=giPairs(n), mode=n.p.fit==='similarity' ? 'similar' : 'auto';
  if(P.geo.length>=2){
    const la=P.geo.reduce((t,p)=>t+p.lat,0)/P.geo.length, lo=P.geo.reduce((t,p)=>t+p.lon,0)/P.geo.length, F=giFrame(la,lo);
    const T=giFit(P.geo.map(p=>{ const q=F.fwd(p.lat,p.lon); return {u:p.u,v:p.v,X:q[0],Y:q[1]}; }),mode);
    if(T){
      n.fitG=T;
      try{ if(!n.src || n.src.m!==Math.max(256,+n.p.maxpx||2048)) n.src=giSmall(n);
        const W=giWarp(n.src.data,n.src.sw,n.src.sh,n.src.w,n.src.h,T,F,Math.max(256,+n.p.maxpx||2048));
        if(W){ const c=document.createElement('canvas'); c.width=W.w; c.height=W.h; c.getContext('2d').putImageData(new ImageData(W.data,W.w,W.h),0,0);
          n.rast={id:'gi:'+n.id,kind:'raster',label:'image',canvas:c,north:W.north,south:W.south,east:W.east,west:W.west,opacity:+n.p.alpha||.85}; }
        else n.bad='the image comes out empty — check the points';
      }catch(e){ n.bad='warp: '+e.message; }
    } else n.bad='the points do not give a fit (the same place, or all in one pixel)';
  }
  if(P.plan.length>=2){
    const T=giFit(P.plan,mode);
    if(T){ n.fitP=T;
      // под Plan Editor берём окно вокруг опорных точек (с запасом), а не весь снимок: у ортофото участка в километр плана иначе не разглядеть; H — с поправкой на окно и уменьшение
      const us=P.plan.map(p=>p.u), vs=P.plan.map(p=>p.v), u0=Math.min(...us), u1=Math.max(...us), v0=Math.min(...vs), v1=Math.max(...vs), pad=Math.max(u1-u0,v1-v0,50)*.6;
      const x0=Math.max(0,Math.floor(u0-pad)), y0=Math.max(0,Math.floor(v0-pad)), x1=Math.min(n.bm.width,Math.ceil(u1+pad)), y1=Math.min(n.bm.height,Math.ceil(v1+pad)), k=Math.min(1,3000/Math.max(x1-x0,y1-y0));
      const cw=Math.max(1,Math.round((x1-x0)*k)), ch=Math.max(1,Math.round((y1-y0)*k)), c=document.createElement('canvas'); c.width=cw; c.height=ch; c.getContext('2d').drawImage(n.bm,x0,y0,x1-x0,y1-y0,0,0,cw,ch);
      const M=T.M, H=[M[0]/k,M[1]/k,M[2]+M[0]*x0+M[1]*y0,M[3]/k,M[4]/k,M[5]+M[3]*x0+M[4]*y0,0,0,1], span=Math.max(80,Math.ceil(Math.hypot(x1-x0,y1-y0)*T.mpp*1.2));
      n.under={id:'under:'+n.id,kind:'underlay',bm:c,w:cw,h:ch,H,up:0,span}; }
  }
  n.miss=P.miss;
}

def({ id:'geoImage', title:'Image on Map', cat:'Geo', touch:true, lazy:true, kw:'image photo drone ortho orthophoto aerial satellite overlay map georeference underlay plan trace fence buildings',
  // rec (вход) — известные точки: Site Plan (name, x, y, lat, lon) или любые записи с name + lat / lon;
  // rec (выход) — растровый слой для Map (по широте / долготе) и подложка для Plan Editor (в метрах плана Site Plan); rms — невязка привязки, м; mpp — м на пиксель
  ins:[{n:'rec',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'rms',t:'num'},{n:'mpp',t:'num'},{n:'n',t:'num'}],
  w:460, view:{h:360}, resize:true, readout:true,
  params:[{n:'file',t:'file',accept:'image/*',label:'image (a drone orthophoto, a screenshot, a photo from above) — saved to Files',fn:(n,f)=>giPick(n,f)},
          {n:'img',t:'text',d:'',label:'the image in Files (Images/plot.jpg)',fn:n=>{ n.pts=[]; giSave(n); giLoad(n); }},
          {n:'names',t:'text',d:'A B C D',label:'known points in the order you click them on the image (their names come from Site Plan on «rec»)'},
          {n:'fit',t:'select',opts:['auto','similarity'],d:'auto',label:'fit: auto (2 points — rotation and scale; 3 or more — also skew) · similarity (rotation and one scale only, a flat north-up ortho)',fn:n=>{ n.dirty=true; }},
          {n:'alpha',t:'range',min:.1,max:1,step:.05,d:.85,label:'opacity on the map',fn:n=>{ n.dirty=true; }},
          {n:'maxpx',t:'range',min:512,max:4096,step:256,d:2048,label:'the largest side of the picture on the map, px',adv:true,fn:n=>{ n.src=null; n.dirty=true; }},
          {n:'extra',t:'text',d:'',label:'more points, one per line: «u v NAME» or «u v lat lon» (u, v — the pixel, v counts down)',adv:true,fn:n=>{ n.dirty=true; }},
          {n:'undo',t:'button',label:'Undo last point',fn:n=>{ n.pts.pop(); giSave(n); n.dirty=true; }},
          {n:'reset',t:'button',label:'Reset points',fn:n=>{ n.pts=[]; giSave(n); n.dirty=true; }},
          {n:'state',t:'text',d:'',hidden:true}],
  init:n=>{ n.bm=null; n.src=null; n.pts=[]; n.known=new Map(); n.fitG=null; n.fitP=null; n.rast=null; n.under=null; n.miss=[]; n.extraErr=[]; n.msg=''; n.bad=''; n.dirty=true; n.drag=null; n.vt=null; n.loaded=null; n.recSig='';
    try{ const s=JSON.parse(n.p.state||'null'); if(s && Array.isArray(s.pts)) n.pts=s.pts.filter(q=>Array.isArray(q) && isFinite(q[0]) && isFinite(q[1])); }catch(e){}
    giLoad(n); },
  dispose:n=>{ n.bm?.close?.(); },
  process(n,I){
    if(String(n.p.img||'').trim()!==n.loaded) giLoad(n);
    for(const r of recList(I.rec)){
      const nm=String(r?.name ?? r?.label ?? '').trim(); if(!nm || r.kind==='plan poly' || r.kind==='plan walls') continue;
      const x=recNum(r.x), y=recNum(r.y), lat=recNum(r.lat ?? r.latitude), lon=recNum(r.lon ?? r.lng ?? r.longitude);
      if(!(isFinite(lat) && isFinite(lon)) && !(isFinite(x) && isFinite(y))) continue;
      const o=n.known.get(nm), v={x,y,lat,lon};
      if(!o || o.x!==x || o.y!==y || o.lat!==lat || o.lon!==lon){ n.known.set(nm,v); n.dirty=true; }
    }
    let rec=null;
    if(n.dirty){ n.dirty=false; giCalc(n); n.recSig='1'; n.recT=-1e9; redraw(n); }
    const now=performance.now();
    if(n.recSig && now-(n.recT||0)>8000 && (n.rast || n.under)){ n.recT=now; rec=[n.rast,n.under].filter(Boolean); }         // раз в 8 с и после правки: редактор или карта, добавленные позже, тоже получат
    const T=n.fitG||n.fitP;
    return {rec, rms:T ? T.rms : null, mpp:T ? T.mpp : null, n:n.pts.length};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, L=[], fg=themeColor('--scr-txt')||'#9fb0b6', names=giNames(n);
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    if(n.msg) L.push(n.msg);
    if(n.bad) L.push('⚠ '+n.bad);
    for(const e of (n.extraErr||[]).slice(0,3)) L.push('extra, line '+e.line+': '+e.msg);
    if(!n.bm){ cx.fillStyle=fg; cx.font='12px sans-serif'; cx.textAlign='center'; cx.fillText('choose an image (a drone orthophoto, a photo from above)',W/2,H/2); n.vt=null; }
    else {
      const iw=n.bm.width, ih=n.bm.height, s=Math.min(W/iw,H/ih), ox=(W-iw*s)/2, oy=(H-ih*s)/2; n.vt={s,ox,oy};
      cx.drawImage(n.bm,ox,oy,iw*s,ih*s);
      cx.font='11px monospace'; cx.textBaseline='alphabetic';
      n.pts.forEach((q,i)=>{ const nm=names[i], p=[ox+q[0]*s,oy+q[1]*s], k=nm ? n.known.get(nm) : null, res=!!k && ((isFinite(k.lat) && isFinite(k.lon)) || (isFinite(k.x) && isFinite(k.y)));
        cx.fillStyle=nm ? (res ? '#7dff9a' : '#ffb74d') : '#888'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(p[0],p[1],6,0,7); cx.stroke(); cx.fill();
        cx.textAlign='left'; cx.fillStyle='#fff'; cx.strokeStyle='rgba(0,0,0,.8)'; cx.lineWidth=3; const t=(nm||'?')+(nm && !res ? ' (unknown)' : ''); cx.strokeText(t,p[0]+9,p[1]-7); cx.fillText(t,p[0]+9,p[1]-7); });
      const T=n.fitG||n.fitP;
      if(names.length>n.pts.length) L.push('click the image where «'+names[n.pts.length]+'» is ('+n.pts.length+' of '+names.length+' set; 2 are enough, 3 or more correct the skew)');
      else if(n.pts.length<2) L.push('add at least 2 known points in «names»');
      if(T) L.push((T.similar ? 'rotation + scale' : 'affine')+' fit, '+T.n+' points: '+T.mpp.toFixed(3)+' m/px, turned '+T.rot.toFixed(1)+'°, residual rms '+T.rms.toFixed(2)+' m'+(T.n===3 && !T.similar ? ' (3 points fit exactly — the residual says nothing; a 4th shows the error)' : ''));
      else if(n.pts.length>=2) L.push('waiting for the known points on «rec» (Site Plan: A, B, … with lat / lon) — or type «u v lat lon» in the advanced «extra»');
      if(n.miss && n.miss.length) L.push('Site Plan does not know: '+[...new Set(n.miss)].join(', '));
      if(n.rast) L.push('map layer '+n.rast.canvas.width+'×'+n.rast.canvas.height+' → wire «rec» to Map');
      if(n.under) L.push('underlay for Plan Editor is ready → wire «rec» to Plan Editor');
    }
    indWire(n,cv,{
      down:(x,y)=>{
        if(!n.vt || !n.bm) return; const {s,ox,oy}=n.vt, near=q=>Math.hypot(ox+q[0]*s-x,oy+q[1]*s-y)<16, i=n.pts.findIndex(near);
        if(i>=0){ n.drag=i; return; }
        const q=[(x-ox)/s,(y-oy)/s]; if(q[0]<0||q[1]<0||q[0]>n.bm.width||q[1]>n.bm.height) return;
        if(n.pts.length>=giNames(n).length) return;
        n.pts.push(q); n.drag=n.pts.length-1; n.dirty=true; giSave(n); },
      move:(x,y)=>{ if(n.drag==null || !n.vt) return; const {s,ox,oy}=n.vt; n.pts[n.drag]=[Math.max(0,Math.min(n.bm.width,(x-ox)/s)),Math.max(0,Math.min(n.bm.height,(y-oy)/s))]; n.dirty=true; },
      up:()=>{ if(n.drag!=null){ n.drag=null; giSave(n); } }});
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
