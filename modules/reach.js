"use strict";
/* ============================ Radio Reach ============================
   До какого расстояния по каждому азимуту виден самолёт на заданной высоте из точки с антенной на заданной высоте:
   рельеф из Horizon (карта высот), кривизна Земли с рефракцией. Несколько высот антенны и самолётов сразу — сравнение антенн и мест.
   Принятые борты (rec ADS-B Decoder) ложатся на тот же график: видно, где реальный приём короче или длиннее расчёта.
   Точка наблюдения — lat / lon (My Position, строка Table), высота антенны — параметр или вход h. Ядро — reach-kernels.js. */

const RR_COLORS=['#4ec9b0','#e0b23c','#c586c0','#569cd6','#e0875f','#b4d455'];
const RR_BINS=72, RR_MAX_SEEN=1500;

function reachInputs(n,I){
  const p=n.p, lat=recNum(I.lat) ?? GeoMe.lat, lon=recNum(I.lon) ?? GeoMe.lon, hIn=recNum(I.h);
  const ants=hIn!=null ? [hIn] : rrParseNums(p.ants).slice(0,6), alts=rrParseAlts(p.alts,p.unit).slice(0,6);
  return {lat,lon,ants:ants.length ? ants : [10],alts};
}
const reachTick=ms=>new Promise(r=>setTimeout(r,ms));

async function reachRun(n,key,inp){
  const p=n.p, tok=n.tok={}, H=Horizon, hAt=H.hAt, dmax=+p.range*1000, k=+p.k||1.33;
  const fail=m=>{ if(n.tok===tok){ n.msg=m; n.job=false; n.res=null; n.done=key; } };
  try{
    let g0=hAt ? hAt(inp.lat,inp.lon) : +p.ground;
    if(g0!==g0) return fail('no terrain at the observer — put the point inside the radius of a Horizon node');
    const rh=hAt ? Math.min(H.radius*1000,dmax) : 0, d=rrDists(rh,100,dmax), ht=[];
    for(let a=0;a<360;a++){
      ht.push(hAt ? rrTerrain(hAt,inp.lat,inp.lon,a,d) : new Float32Array(d.length).fill(NaN));
      if(a%12===11){ n.msg='terrain '+Math.round(100*(a+1)/360)+'%'; await reachTick(0); if(n.tok!==tok) return; }
    }
    const gref=p.far==='sea level' ? 0 : g0, items=[];
    inp.ants.forEach((ant,ai)=>inp.alts.forEach((al,li)=>{
      const reach=rrReachAll(d,ht,g0+ant,al.m,k,gref);
      items.push({ai,li,ant,alt:al,reach,st:rrStats(reach),h0:g0+ant});
    }));
    if(n.tok!==tok) return;
    n.res={lat:inp.lat,lon:inp.lon,g0,d,ht,gref,k,items,ants:inp.ants,alts:inp.alts,t:Date.now()};
    n.msg=''; n.job=false; n.done=key; n.emit=reachRecords(n);
    n.seenIds.clear(); n.missIds.clear();                 // расчёт изменился — сравнение с принятым начинаем заново
  }catch(e){ fail('reach: '+e.message); }
}
// записи по каждой паре «антенна × высота»: сводка и многоугольник для карты / Table
function reachRecords(n){
  const R=n.res, name=n.p.name||'', t=new Date(R.t).toISOString(), sum=[], poly=[];
  for(const it of R.items){
    const id='reach:'+(name||R.lat.toFixed(4)+','+R.lon.toFixed(4))+':'+it.ant+'m:'+it.alt.label, label=(name ? name+' · ' : '')+it.ant+' m · '+it.alt.label;
    sum.push({t, id, label, name, lat:R.lat, lon:R.lon, ground:Math.round(R.g0), ant:it.ant, alt:it.alt.label, alt_m:Math.round(it.alt.m), k:R.k,
      min_km:+it.st.min.toFixed(1), avg_km:+it.st.avg.toFixed(1), max_km:+it.st.max.toFixed(1), area_km2:Math.round(it.st.area), worst_az:it.st.minAz, best_az:it.st.maxAz});
    poly.push({id:id+':area', label, lat:R.lat, lon:R.lon, icon:'dot', color:RR_COLORS[it.li%RR_COLORS.length], path:rrPolygon(R.lat,R.lon,it.reach,5)});
  }
  return {sum,poly};
}
async function reachSave(n){
  if(!n.res){ n.msg='nothing to save yet'; return; }
  const rows=reachRecords(n).sum, cols=Object.keys(rows[0]);
  await tblPut(n.p.save||'analysis/reach',cols,rows);
  n.msg='saved '+rows.length+' rows to «'+(n.p.save||'analysis/reach')+'»';
}

def({ id:'reach', title:'Radio Reach', cat:'Radio', kw:'coverage range adsb aircraft terrain mountains antenna height line of sight radio horizon dead zone reception compare',
  // lat / lon — точка приёма (иначе My Position), h — высота антенны над землёй, м (перекрывает параметр); rec — принятые борты (ADS-B Decoder).
  // min / avg / max, км и area, км² — по выбранной паре «антенна № × высота №»; seen — принятых бортов, miss — из них «закрытых» по расчёту
  // (приём длиннее расчёта: поправьте k и высоту антенны), obs — самая дальняя принятая цель, км.
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'h',t:'num'},{n:'rec',t:'rec'}],
  outs:[{n:'min',t:'num'},{n:'avg',t:'num'},{n:'max',t:'num'},{n:'area',t:'num'},{n:'seen',t:'num'},{n:'miss',t:'num'},{n:'obs',t:'num'},
        {n:'rec',t:'rec'},{n:'poly',t:'rec'}],
  w:400, view:{h:340}, resize:true, readout:true,
  params:[{n:'ants',t:'text',d:'10',label:'antenna height above ground, m (several: 2, 10, 30)'},
          {n:'alts',t:'text',d:'FL100, FL250, FL350',label:'aircraft altitude: FL, feet or 3000m (several)'},
          {n:'unit',t:'select',opts:['ft','m'],d:'ft',label:'a plain number in the altitude list is in'},
          {n:'antNo',t:'range',min:1,max:6,step:1,d:1,label:'antenna # shown and sent to min / avg / max'},
          {n:'altNo',t:'range',min:1,max:6,step:1,d:1,label:'altitude # for min / avg / max'},
          {n:'k',t:'range',min:1,max:2,step:.01,d:1.33,label:'refraction k (4/3 — standard)'},
          {n:'range',t:'range',min:100,max:600,step:10,d:400,label:'range limit, km'},
          {n:'far',t:'select',opts:['observer ground','sea level'],d:'observer ground',label:'ground beyond the Horizon height map (and without Horizon)'},
          {n:'name',t:'text',d:'',label:'name of the point (in the records and the table)'},
          {n:'save',t:'text',d:'analysis/reach',label:'Table list for «Save to table»'},
          {n:'tosave',t:'button',label:'Save to table',fn:n=>reachSave(n)},
          {n:'calc',t:'button',label:'Recalculate',fn:n=>{ n.key=''; n.due=0; }},
          {n:'clr',t:'button',label:'Clear received',fn:n=>{ n.bins.fill(0); n.pts.clear(); n.seenIds.clear(); n.missIds.clear(); }},
          {n:'ground',t:'num',d:0,label:'ground height without Horizon, m',adv:true}],
  init:n=>{ n.msg=''; n.res=null; n.key=''; n.due=0; n.job=false; n.done=null; n.tok=null; n.emit=null;
            n.bins=new Float32Array(RR_BINS); n.pts=new Map(); n.seenIds=new Set(); n.missIds=new Set(); n.chk=new Map(); n.obsKm=null; },
  dispose:n=>{ n.tok=null; },
  process(n,I){
    const p=n.p, now=Date.now(), inp=reachInputs(n,I);
    if(inp.lat==null || inp.lon==null){ n.noPos=true; }
    else {
      n.noPos=false;
      const key=[inp.lat,inp.lon,inp.ants.join(),inp.alts.map(a=>a.m).join(),p.k,p.range,p.far,p.ground,Horizon.ver,Horizon.hAt?1:0].join('|');
      if(key!==n.key){
        if(!n.due) n.due=now+400;                         // слайдер и ввод не запускают расчёт на каждый шаг
        if(now>=n.due){ n.due=0; n.key=key; n.job=true; reachRun(n,key,inp); }
      }
    }
    // принятые борты: дальность и азимут, сравнение с расчётом
    const R=n.res;
    for(const r of recList(I.rec)){
      const s=r && typeof flyRecState==='function' ? flyRecState(r) : null; if(!s || s.ground || inp.lat==null) continue;
      const km=rrDistKm(inp.lat,inp.lon,s.lat,s.lon), az=rrBearing(inp.lat,inp.lon,s.lat,s.lon), id=String(r.id ?? r.icao ?? r.label ?? '');
      if(km>+p.range || km<1) continue;
      rrObsPush(n.bins,az,km); if(km>(n.obsKm||0)) n.obsKm=km;
      let ok=true;
      if(R && R.items.length){                            // видна ли цель по расчёту для выбранной антенны
        const ai=Math.min(R.ants.length-1,Math.max(0,Math.round(+p.antNo)-1)), item=R.items.find(x=>x.ai===ai) || R.items[0];
        ok=rrReachAz(R.d,R.ht[Math.round(az)%360],item.h0,s.alt,R.k,R.gref)>=km*1000*.97;
      }
      if(id){ n.seenIds.add(id); if(!ok) n.missIds.add(id); }
      n.pts.set(id||('p'+n.pts.size),{az,km,ok,t:now});
      if(n.pts.size>RR_MAX_SEEN) n.pts.delete(n.pts.keys().next().value);
    }
    const ai=R ? Math.min(R.ants.length-1,Math.max(0,Math.round(+p.antNo)-1)) : 0, li=R ? Math.min(R.alts.length-1,Math.max(0,Math.round(+p.altNo)-1)) : 0;
    const it=R?.items.find(x=>x.ai===ai && x.li===li), e=n.emit; n.emit=null;
    return {min:it ? it.st.min : null, avg:it ? it.st.avg : null, max:it ? it.st.max : null, area:it ? it.st.area : null,
      seen:n.seenIds.size, miss:n.missIds.size, obs:n.obsKm, rec:e ? e.sum : null, poly:e ? e.poly : null};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, R=n.res, p=n.p, pad=22, rad=Math.max(20,Math.min(W,H)/2-pad), cxp=W/2, cyp=H/2+2;
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
    const ai=R ? Math.min(R.ants.length-1,Math.max(0,Math.round(+p.antNo)-1)) : 0, sel=R ? R.items.filter(x=>x.ai===ai) : [];
    let top=0; for(const it of sel) top=Math.max(top,it.st.max); for(let i=0;i<RR_BINS;i++) top=Math.max(top,n.bins[i]);
    if(!top) top=+p.range;
    const steps=[10,25,50,100,200,250], step=steps.find(s=>top/s<=5) || 250, maxR=Math.ceil(top/step)*step, sc=rad/maxR;
    const dim=themeColor('--axis')||'#2a3a40', txt=themeColor('--dim')||'#6c7a80';
    cx.lineWidth=1; cx.strokeStyle=dim; cx.fillStyle=txt; cx.font='10px monospace'; cx.textAlign='left'; cx.textBaseline='alphabetic';
    for(let r=step;r<=maxR;r+=step){ cx.beginPath(); cx.arc(cxp,cyp,r*sc,0,7); cx.globalAlpha=.5; cx.stroke(); cx.globalAlpha=1; cx.fillText(r+' km',cxp+3,cyp-r*sc-2); }
    cx.beginPath(); cx.moveTo(cxp-rad,cyp); cx.lineTo(cxp+rad,cyp); cx.moveTo(cxp,cyp-rad); cx.lineTo(cxp,cyp+rad); cx.globalAlpha=.4; cx.stroke(); cx.globalAlpha=1;
    cx.textAlign='center'; [['N',0,-1],['E',1,0],['S',0,1],['W',-1,0]].forEach(([s,x,y])=>cx.fillText(s,cxp+x*(rad+11),cyp+y*(rad+11)+4));
    const pt=(a,km)=>{ const t=a*Math.PI/180; return [cxp+Math.sin(t)*km*sc, cyp-Math.cos(t)*km*sc]; };
    // расчётная зона: по высоте самолёта своя кривая
    for(const it of sel){
      const col=RR_COLORS[it.li%RR_COLORS.length]; cx.beginPath();
      for(let a=0;a<=360;a++){ const q=pt(a,it.reach[a%360]/1000); if(a) cx.lineTo(q[0],q[1]); else cx.moveTo(q[0],q[1]); }
      cx.fillStyle=col; cx.globalAlpha=.07; cx.fill(); cx.globalAlpha=1; cx.strokeStyle=col; cx.lineWidth=it.li===Math.round(+p.altNo)-1 ? 2 : 1.2; cx.stroke();
    }
    // принятое: наибольшая дальность по секторам и сами цели
    cx.lineWidth=1.2; cx.strokeStyle=themeColor('--scr-hi'); cx.setLineDash([4,3]); cx.beginPath(); let any=false;
    for(let i=0;i<=RR_BINS;i++){ const km=n.bins[i%RR_BINS]; if(!km) continue; const q=pt((i%RR_BINS+.5)*360/RR_BINS,km); if(any) cx.lineTo(q[0],q[1]); else cx.moveTo(q[0],q[1]); any=true; }
    cx.stroke(); cx.setLineDash([]);
    for(const q of n.pts.values()){ const s=pt(q.az,q.km); cx.fillStyle=q.ok ? themeRgba('--scr-hi',.85) : '#ff5c5c'; cx.fillRect(s[0]-1.5,s[1]-1.5,3,3); }
    cx.fillStyle='#ffd84a'; cx.beginPath(); cx.arc(cxp,cyp,3,0,7); cx.fill();
    // легенда
    cx.textAlign='left'; cx.font='10px monospace';
    sel.forEach((it,i)=>{ cx.fillStyle=RR_COLORS[it.li%RR_COLORS.length]; cx.fillRect(6,8+i*13,8,8); cx.fillStyle=themeColor('--scr-txt'); cx.fillText((it.li===Math.round(+p.altNo)-1 ? '▶ ' : '')+it.alt.label,18,16+i*13); });
    const L=[];
    if(n.msg) L.push(n.msg);
    if(n.noPos) L.push('no observer — add My Position or wire lat / lon');
    if(R){
      L.push((p.name ? p.name+' · ' : '')+R.lat.toFixed(4)+', '+R.lon.toFixed(4)+' · ground '+Math.round(R.g0)+' m · k '+R.k+(Horizon.hAt ? '' : ' · no Horizon: flat ground'));
      for(const it of sel) L.push(it.alt.label.padEnd(8)+' '+it.ant+' m: min '+it.st.min.toFixed(0)+' (az '+it.st.minAz+'°) · avg '+it.st.avg.toFixed(0)+' · max '+it.st.max.toFixed(0)+' km · '+Math.round(it.st.area/1000)+' k km²');
      if(R.ants.length>1){ const li=Math.min(R.alts.length-1,Math.max(0,Math.round(+p.altNo)-1)); L.push('antennas at '+(R.alts[li]?.label||'')+': '+R.items.filter(x=>x.li===li).map(x=>x.ant+' m → avg '+x.st.avg.toFixed(0)+' km').join(' · ')); }
    }
    if(n.seenIds.size) L.push('received '+n.seenIds.size+' aircraft, farthest '+(n.obsKm||0).toFixed(0)+' km; '+n.missIds.size+' beyond the calculated reach (red)');
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
