"use strict";
/* ============================ СПУТНИКИ ============================ */
// Орбиты — SGP4 по TLE (vendor/satellite.min.js, satellite.js 5.0.0, MIT).
// TLE — CelesTrak по группам, частоты — база передатчиков SatNOGS; всё разово скачивается
// и хранится в IndexedDB, так что дальше работает офлайн (TLE стареют: точность падает за 1–2 недели).
// Точка наблюдения — My Position (GeoMe).

const SAT_GROUPS=['amateur','weather','noaa','stations','cubesat','visual','resource','goes','active'];
const SAT_TLE_URL='https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=tle';
const SAT_TX_URL='https://db.satnogs.org/api/transmitters/?format=json';
const SAT_C=299792.458;                               // км/с
const Sat={tx:null, txP:null, txState:''};             // передатчики SatNOGS: norad → [..]

function satParseTle(text){
  const L=String(text).split(/\r?\n/).map(s=>s.trimEnd()).filter(s=>s.trim());
  const out=[];
  for(let i=0;i<L.length;i++){
    if(!L[i].startsWith('1 ') || !L[i+1]?.startsWith('2 ')) continue;
    const name=(i>0 && !L[i-1].startsWith('1 ') && !L[i-1].startsWith('2 ')) ? L[i-1].replace(/^0 /,'').trim() : L[i].slice(2,7).trim();
    let rec=null;
    try{ rec=satellite.twoline2satrec(L[i],L[i+1]); }catch(e){}
    if(rec && !rec.error) out.push({name, norad:+L[i].slice(2,7), l1:L[i], l2:L[i+1], rec, epoch:satEpoch(rec)});
    i++;
  }
  return out;
}
function satEpoch(rec){                                // эпоха TLE → мс
  const y=rec.epochyr<57 ? 2000+rec.epochyr : 1900+rec.epochyr;
  return Date.UTC(y,0,1)+(rec.epochdays-1)*86400000;
}
// положение и вид с точки наблюдения; null — спутник «упал» (SGP4 не сходится)
function satState(s,date,obs){
  const pv=satellite.propagate(s.rec,date);
  if(!pv || !pv.position || typeof pv.position==='boolean') return null;
  const gmst=satellite.gstime(date), gd=satellite.eciToGeodetic(pv.position,gmst);
  const st={lat:satellite.degreesLat(gd.latitude), lon:satellite.degreesLong(gd.longitude), alt:gd.height};
  if(obs){
    const ecf=satellite.eciToEcf(pv.position,gmst), la=satellite.ecfToLookAngles(obs,ecf);
    st.az=((la.azimuth/D2R)%360+360)%360; st.el=la.elevation/D2R; st.range=la.rangeSat;
  }
  return st;
}
function satObs(){
  return GeoMe.lat==null ? null : {latitude:GeoMe.lat*D2R, longitude:GeoMe.lon*D2R, height:0};
}
// скорость сближения (км/с, + — удаляется) — численно по дальности через ±0.5 с
function satRangeRate(s,t,obs){
  const a=satState(s,new Date(t-500),obs), b=satState(s,new Date(t+500),obs);
  return a && b ? b.range-a.range : null;
}
function satFootprintKm(altKm){ return GEO_R*Math.acos(GEO_R/(GEO_R+Math.max(0,altKm))); }

// порог видимости в азимуте: не ниже горизонта узла и, если включено, рельефа (Horizon)
function satLimit(n,az,obs){
  const m=+n.p.minEl||0;
  return n.p.terrain && obs ? Math.max(m,horizonAt(az,GeoMe.lat,GeoMe.lon)) : m;
}
// ближайшие пролёты: шаг 30 с, края уточняются делением пополам до ~1 с; видим, когда el выше порога lim(az)
function satPasses(s,from,hours,obs,lim,maxN=6){
  const mg=t=>{ const st=satState(s,new Date(t),obs); return st ? st.el-lim(st.az) : -90; };
  const edge=(a,b,up)=>{ for(let k=0;k<6;k++){ const m=(a+b)/2; ((mg(m)>0)===up) ? (b=m) : (a=m); } return (a+b)/2; };
  const out=[], step=30000, end=from+hours*3600000;
  let prev=mg(from), t0=prev>0 ? from : null;
  for(let t=from+step;t<=end && out.length<maxN;t+=step){
    const e=mg(t);
    if(prev<=0 && e>0) t0=edge(t-step,t,true);
    if(prev>0 && e<=0 && t0!=null){
      const t1=edge(t-step,t,false);
      let best=-90, tb=t0;
      for(let q=t0;q<=t1;q+=10000){ const v=satState(s,new Date(q),obs)?.el ?? -90; if(v>best){ best=v; tb=q; } }
      const a0=satState(s,new Date(t0),obs), a1=satState(s,new Date(t1),obs);
      out.push({aos:t0, los:t1, maxEl:best, tMax:tb, azAos:a0?.az, azLos:a1?.az});
      t0=null;
    }
    prev=e;
  }
  return out;
}

// SatNOGS: передатчики по NORAD
function satTxLoad(){
  if(Sat.txP) return Sat.txP;
  return Sat.txP=geoGet('satnogs:tx').then(v=>{ if(v) satTxSet(v,false); }).catch(()=>{});
}
function satTxSet(list,save){
  const m=new Map();
  for(const t of list){
    const id=+t.norad_cat_id; if(!id) continue;
    if(t.status && t.status!=='active') continue;
    let a=m.get(id); if(!a) m.set(id,a=[]);
    a.push({d:t.description||'', dl:t.downlink_low||null, dh:t.downlink_high||null, ul:t.uplink_low||null,
            uh:t.uplink_high||null, mode:t.mode||'', baud:t.baud||null, inv:!!t.invert});
  }
  Sat.tx=m; Sat.txState=m.size+' satellites with transmitters';
  if(save) geoPut('satnogs:tx',list.map(t=>({norad_cat_id:t.norad_cat_id,status:t.status,description:t.description,
    downlink_low:t.downlink_low,downlink_high:t.downlink_high,uplink_low:t.uplink_low,uplink_high:t.uplink_high,
    mode:t.mode,baud:t.baud,invert:t.invert}))).catch(e=>{ Sat.txState='not saved: '+e.message; });
}
async function satTxDownload(n){
  Sat.txState='downloading transmitters…';
  try{
    const r=await fetch((n.p.proxy||'')+SAT_TX_URL); if(!r.ok) throw new Error('HTTP '+r.status);
    satTxSet(await r.json(),true);
  }catch(e){ Sat.txState='transmitters: '+e.message+' — set a CORS proxy or import the JSON file'; }
}
function satFmtMHz(hz){ return (hz/1e6).toFixed(hz%1000 ? 4 : 3); }
function satTxText(norad){
  const a=Sat.tx?.get(norad); if(!a?.length) return '';
  return a.map(t=>(t.dl?'↓'+satFmtMHz(t.dl)+(t.dh&&t.dh!==t.dl?'–'+satFmtMHz(t.dh):''):'')+
    (t.ul?' ↑'+satFmtMHz(t.ul)+(t.uh&&t.uh!==t.ul?'–'+satFmtMHz(t.uh):''):'')+(t.mode?' '+t.mode:'')+(t.d?' ('+t.d+')':'')).join('; ');
}

async function satTleDownload(n){
  const g=n.p.group; n.msg='downloading TLE '+g+'…';
  try{
    const r=await fetch((n.p.proxy||'')+SAT_TLE_URL.replace('{g}',g)); if(!r.ok) throw new Error('HTTP '+r.status);
    const text=await r.text();
    const list=satParseTle(text); if(!list.length) throw new Error('no TLE in response');
    await geoPut('tle:'+g,{t:Date.now(), text}).catch(()=>{});
    satSetList(n,list,g); n.msg='';
  }catch(e){ n.msg='TLE: '+e.message+' — set a CORS proxy or import a TLE file'; }
}
function satSetList(n,list,src){
  n.loadTok=null;
  if(list.length) n.msg='';
  n.sats=list; n.src=src; n.byNorad=new Map(list.map(s=>[s.norad,s])); n.passKey=''; n.lastMap=0;
}
function satFind(n,q){
  q=String(q||'').trim(); if(!q) return null;
  if(/^\d+$/.test(q)) return n.byNorad?.get(+q) || null;
  const u=q.toUpperCase();
  return n.sats.find(s=>s.name.toUpperCase()===u) || n.sats.find(s=>s.name.toUpperCase().includes(u)) || null;
}
function satMatch(s,f){
  if(!f) return true;
  const name=s.name.toUpperCase();
  return String(f).toUpperCase().split(/[,;]+/).map(x=>x.trim()).filter(Boolean)
    .some(x=>/^\d+$/.test(x) ? s.norad===+x : name.includes(x));
}

def({ id:'satTrack', title:'Satellites', cat:'Radio',
  // Положение спутников (на карту — rec), вид неба, ближайшие пролёты выбранного и Доплер:
  // freq — принимаемая частота downlink с поправкой (на tuneFreq приёмника), up — что передавать.
  ins:[{n:'select',t:'rec'}],                         // выбор спутника кликом на карте (выход sel)
  outs:[{n:'rec',t:'rec'},{n:'freq',t:'num'},{n:'up',t:'num'},{n:'shift',t:'num'},
        {n:'az',t:'num'},{n:'el',t:'num'},{n:'range',t:'num'},{n:'rate',t:'num'},{n:'bands',t:'bands'},
        {n:'aos',t:'num'},{n:'los',t:'num'},{n:'maxel',t:'num'}],
  w:360, view:{h:240}, resize:true, readout:true, tall:true,
  params:[{n:'group',t:'select',opts:SAT_GROUPS,d:'amateur',label:'TLE group',
            fn:n=>satLoadGroup(n)},
          {n:'filter',t:'text',d:'',label:'filter: names / NORAD, comma-separated'},
          {n:'sat',t:'text',d:'ISS',label:'selected (name or NORAD)'},
          {n:'f0',t:'num',d:0,label:'downlink, MHz (0 — from SatNOGS)'},
          {n:'fu',t:'num',d:0,label:'uplink, MHz (0 — from SatNOGS)'},
          {n:'minEl',t:'range',min:-5,max:45,step:1,d:0,label:'horizon, °'},
          {n:'terrain',t:'check',d:true,label:'terrain horizon (Horizon module)'},
          {n:'show',t:'select',opts:['above horizon','all'],d:'all',label:'on the map'},
          {n:'track',t:'range',min:0,max:300,step:5,d:100,label:'ground track ahead, min'},
          {n:'tle',t:'button',label:'Download TLE',fn:n=>satTleDownload(n)},
          {n:'txdl',t:'button',label:'Download frequencies (SatNOGS)',fn:n=>satTxDownload(n)},
          {n:'tleFile',t:'file',accept:'.txt,.tle,.3le',fn:(n,f)=>{
            const rd=new FileReader(); rd.onload=()=>{ const l=satParseTle(String(rd.result));
              if(!l.length){ n.msg='no TLE in file'; return; }
              geoPut('tle:file',{t:Date.now(), text:String(rd.result)}).catch(()=>{});
              satSetList(n,l,'file: '+f.name); n.msg=''; }; rd.readAsText(f); },adv:true},
          {n:'txFile',t:'file',accept:'.json',fn:(n,f)=>{
            const rd=new FileReader(); rd.onload=()=>{ try{ satTxSet(JSON.parse(String(rd.result)),true); }
              catch(e){ Sat.txState='JSON: '+e.message; } }; rd.readAsText(f); },adv:true},
          {n:'proxy',t:'text',d:'',label:'CORS proxy prefix',adv:true}],
  init:n=>{ n.sats=[]; n.src=''; n.msg=''; n.byNorad=new Map(); n.lastMap=0; n.passes=[]; n.passKey='';
            n.cur=null; n.sky=[]; satLoadGroup(n); satTxLoad(); },
  process(n,I){
    for(const r of recList(I.select)){
      const id=String(r.id||''); if(id.startsWith('sat:')) setMod(n,'sat',id.slice(4));
    }
    if(!n.sats.length) return {rec:null};
    const now=Date.now(), date=new Date(now), obs=satObs();
    const s=satFind(n,n.p.sat);
    // выбранный: каждый блок — для плавного Доплера
    let out={rec:null};
    n.cur=null;
    if(s){
      const st=satState(s,date,obs);
      if(st){
        const rate=obs ? satRangeRate(s,now,obs) : null;
        const tx=Sat.tx?.get(s.norad)?.find(t=>t.dl) || null, txu=Sat.tx?.get(s.norad)?.find(t=>t.ul) || null;
        const f0=(+n.p.f0>0 ? +n.p.f0*1e6 : tx?.dl) || null, fu=(+n.p.fu>0 ? +n.p.fu*1e6 : txu?.ul) || null;
        const k=rate!=null ? rate/SAT_C : 0;
        n.cur={s, st, rate, f0, fu, fRx:f0 ? Math.round(f0*(1-k)) : null, fTx:fu ? Math.round(fu/(1-k)) : null};
        out={freq:n.cur.fRx, up:n.cur.fTx, shift:f0 ? n.cur.fRx-f0 : null,
             az:st.az, el:st.el, range:st.range, rate};
      }
      const ps=n.passes.find(q=>q.los>now);            // идущий или ближайший пролёт: aos, los — мс, maxel — °
      if(ps) Object.assign(out,{aos:ps.aos, los:ps.los, maxel:+ps.maxEl.toFixed(1)});
      const pk=s.norad+'|'+Math.floor(now/60000)+'|'+n.p.minEl+'|'+n.p.terrain+'|'+Horizon.gen+'|'+(obs?GeoMe.lat+','+GeoMe.lon:'');
      if(obs && pk!==n.passKey){ n.passKey=pk; n.passes=satPasses(s,now,24,obs,az=>satLimit(n,az,obs)); }
      if(!obs) n.passes=[];
    }
    // все: раз в 2 с на карту, небо, метки downlink над горизонтом
    if(now-n.lastMap>=2000){
      n.lastMap=now;
      const recs=[], sky=[], bands=[], all=n.p.show==='all';
      for(const q of n.sats){
        if(!satMatch(q,n.p.filter) && q!==s) continue;
        const st=satState(q,date,obs); if(!st) continue;
        const up=st.el!=null && st.el>satLimit(n,st.az,obs);
        if(st.el!=null && st.el>-5) sky.push({name:q.name, az:st.az, el:st.el, sel:q===s});
        if(up && Sat.tx?.get(q.norad)){
          const rr=satRangeRate(q,now,obs), k=rr!=null ? rr/SAT_C : 0;
          for(const t of Sat.tx.get(q.norad)) if(t.dl)
            bands.push({lo:Math.round(t.dl*(1-k)), hi:Math.round(t.dl*(1-k)), step:0,
                        label:q.name+' '+(t.mode||''), color:q===s ? '#ffd84a' : '#8fd6ff'});
        }
        if(!all && !up && q!==s) continue;
        const r={t:now, id:'sat:'+q.norad, label:q.name, icon:'sat', norad:q.norad,
          lat:+st.lat.toFixed(4), lon:+st.lon.toFixed(4), alt_km:Math.round(st.alt),
          color:q===s ? '#ffd84a' : up ? '#7dff9a' : '#8aa0aa', size:q===s ? 8 : 6,
          tle_age_d:+((now-q.epoch)/86400000).toFixed(1)};
        if(st.el!=null){ r.az=Math.round(st.az); r.el=+st.el.toFixed(1); r.range_km=Math.round(st.range); }
        const tx=satTxText(q.norad); if(tx) r.freqs=tx;
        if(q===s || up) r.radius=Math.round(satFootprintKm(st.alt)*1000);
        if(q===s && n.p.track>0){
          const path=[];
          for(let m=0;m<=n.p.track;m+=1){
            const p=satState(q,new Date(now+m*60000),null); if(p) path.push([+p.lat.toFixed(3),+p.lon.toFixed(3)]);
          }
          r.path=path;
        }
        recs.push(r);
      }
      n.sky=sky;
      out.rec=recs.length ? recs : null;
      n.bands=bands;
    }
    out.bands=n.bands||[];
    return out;
  },
  draw(n,cv,cx){
    // небо меняется раз в 2 с (n.sky) — SGP4 по траектории пролёта не гоняем каждый кадр
    const k=cv.width+'|'+cv.height+'|'+cv.pxGen+'|'+drawGen+'|'+GeoMe.lat+'|'+Horizon.gen+'|'+n.cur?.s.norad+'|'+n.passes[0]?.aos;
    if(n.sky!==n._skySky || k!==n._skyKey){ n._skySky=n.sky; n._skyKey=k; satSkyDraw(n,cv,cx); }
    satReadout(n); }});
function satLoadGroup(n){
  const g=n.p.group, tok=n.loadTok={g};             // загрузка файла/сети до ответа БД отменяет это чтение
  geoGet('tle:'+g).then(v=>{
    if(n.loadTok!==tok) return;
    if(v){ const l=satParseTle(v.text); satSetList(n,l,g+' · downloaded '+new Date(v.t).toISOString().slice(0,10)); n.msg=''; }
    else { satSetList(n,[],''); n.msg='no TLE for '+g+' yet — press Download TLE'; }
  }).catch(e=>{ n.msg=e.message; });
}
function satFmtT(t){ const d=new Date(t); return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+':'+String(d.getUTCSeconds()).padStart(2,'0'); }
function satReadout(n){
  const L=[];
  if(n.msg) L.push(n.msg);
  if(Sat.txState) L.push(Sat.txState);
  if(n.sats.length) L.push(n.src+' · '+n.sats.length+' sats');
  if(GeoMe.lat==null) L.push('no observer — add My Position for az/el, passes, Doppler');
  const c=n.cur;
  if(c){
    const s=c.s, st=c.st;
    L.push('▶ '+s.name+' #'+s.norad+' · TLE age '+((Date.now()-s.epoch)/86400000).toFixed(1)+' d');
    L.push('  '+st.lat.toFixed(2)+', '+st.lon.toFixed(2)+' · alt '+Math.round(st.alt)+' km'+
      (st.el!=null ? ' · az '+st.az.toFixed(1)+'° el '+st.el.toFixed(1)+'° · '+Math.round(st.range)+' km' : ''));
    if(c.rate!=null) L.push('  range rate '+c.rate.toFixed(3)+' km/s');
    if(c.f0) L.push('  ↓ '+satFmtMHz(c.f0)+' → '+(c.fRx/1e6).toFixed(6)+' MHz ('+((c.fRx-c.f0)>=0?'+':'')+Math.round(c.fRx-c.f0)+' Hz)');
    if(c.fu) L.push('  ↑ '+satFmtMHz(c.fu)+' → '+(c.fTx/1e6).toFixed(6)+' MHz');
    const tx=satTxText(s.norad); if(tx) L.push('  '+tx);
    if(n.passes.length){
      L.push('  passes (UTC)   AOS       max el   LOS');
      for(const p of n.passes) L.push('  '+new Date(p.aos).toISOString().slice(5,10)+'   '+satFmtT(p.aos)+'  '+
        p.maxEl.toFixed(0).padStart(3)+'° '+satFmtT(p.tMax)+'  '+satFmtT(p.los)+
        '  az '+Math.round(p.azAos??0)+'→'+Math.round(p.azLos??0));
    }
  } else if(n.sats.length && n.p.sat) L.push('not found: '+n.p.sat);
  n.el.querySelector('.readout').textContent=L.join('\n');
}
// небо: центр — зенит, край — горизонт, север вверху, восток справа
function satSkyDraw(n,cv,cx){
  const W=cv.width, H=cv.height;
  cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H);
  const R=Math.min(W,H)/2-14, x0=W/2, y0=H/2;
  const P=(az,el)=>{ const r=(90-Math.max(el,-5))/90*R; return [x0+r*Math.sin(az*D2R), y0-r*Math.cos(az*D2R)]; };
  cx.strokeStyle='#2a3a40'; cx.lineWidth=1;
  for(const e of [0,30,60]){ cx.beginPath(); cx.arc(x0,y0,(90-e)/90*R,0,2*Math.PI); cx.stroke(); }
  cx.beginPath(); cx.moveTo(x0-R,y0); cx.lineTo(x0+R,y0); cx.moveTo(x0,y0-R); cx.lineTo(x0,y0+R); cx.stroke();
  cx.fillStyle='#6c7a80'; cx.font='10px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
  cx.fillText('N',x0,y0-R-8); cx.fillText('S',x0,y0+R+8); cx.fillText('E',x0+R+8,y0); cx.fillText('W',x0-R-8,y0);
  if(GeoMe.lat==null){ cx.fillText('set My Position',x0,y0); return; }
  // траектория ближайшего (или текущего) пролёта выбранного
  const c=n.cur, p=n.passes[0];
  if(c && p){
    cx.strokeStyle='rgba(255,216,74,.5)'; cx.setLineDash([4,3]); cx.beginPath();
    const obs=satObs(); let first=true;
    for(let t=p.aos;t<=p.los;t+=15000){
      const st=satState(c.s,new Date(t),obs); if(!st) continue;
      const [x,y]=P(st.az,st.el); if(first){ cx.moveTo(x,y); first=false; } else cx.lineTo(x,y);
    }
    cx.stroke(); cx.setLineDash([]);
  }
  cx.textAlign='left';
  for(const q of n.sky){
    const [x,y]=P(q.az,q.el);
    cx.fillStyle=q.sel ? '#ffd84a' : q.el>0 ? '#7dff9a' : '#55656c';
    cx.beginPath(); cx.arc(x,y,q.sel?4:3,0,2*Math.PI); cx.fill();
    if(q.sel || q.el>0) cx.fillText(q.name.slice(0,14),x+5,y-5);
  }
}
