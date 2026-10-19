"use strict";
/* ============================ Satellite Autopilot ============================
   Расписание пролётов целевых спутников: окно записи, частота с доплером, режим. Ядро — satplan-kernels.js
   (node tools/test-satplan.mjs), орбиты — satState / satPasses / satRangeRate из sat.js. */
function spLoadTle(n){
  const groups=String(n.p.groups||'').split(/[,;\s]+/).filter(Boolean), key=groups.join(','), tok=n.loadTok={key};
  n._groups=key;
  Promise.all(groups.map(g=>geoGet('tle:'+g).catch(()=>null).then(v=>v ? {g,list:satParseTle(v.text)} : {g,list:null}))).then(rs=>{
    if(n.loadTok!==tok) return;
    const by=new Map(), missing=[];
    for(const r of rs){
      if(!r.list){ missing.push(r.g); continue; }
      for(const s of r.list){ const o=by.get(s.norad); if(!o || o.epoch<s.epoch) by.set(s.norad,s); }
    }
    n.sats=[...by.values()]; n.satRev=(n.satRev|0)+1;
    n.msg=!n.sats.length ? 'no TLE for '+groups.join(', ')+' — press Download TLE' : missing.length ? 'no TLE for '+missing.join(', ')+' — press Download TLE' : '';
  });
}
async function spDownload(n){
  const groups=String(n.p.groups||'').split(/[,;\s]+/).filter(g=>g && g!=='file'); n.msg='downloading TLE…';
  try{
    for(const g of groups){
      const r=await fetch(Net.url(SAT_TLE_URL.replace('{g}',g))); if(!r.ok) throw new Error(g+': HTTP '+r.status);
      const text=await r.text(); if(!satParseTle(text).length) throw new Error(g+': no TLE in response');
      await geoPut('tle:'+g,{t:Date.now(), text}).catch(()=>{});
    }
    spLoadTle(n);
  }catch(e){ n.msg='TLE: '+e.message+' — set a CORS proxy in Settings or import a TLE file'; }
}
function spFind(sats,q){
  q=String(q||'').trim(); if(!q) return null;
  if(/^\d+$/.test(q)) return sats.find(s=>s.norad===+q) || null;
  const u=q.toUpperCase();
  return sats.find(s=>s.name.toUpperCase()===u) || sats.find(s=>s.name.toUpperCase().includes(u)) || null;
}
const SP_DEPS={passes:(s,from,h,obs,minEl,maxN)=>satPasses(s,from,h,obs,minEl,maxN), rate:(s,t,obs)=>satRangeRate(s,t,obs)};

def({ id:'satPlan', title:'Satellite Autopilot', cat:'Radio', readout:true, tall:true, resize:true, w:420,
  kw:'satellite pass scheduler autopilot planner doppler record weather noaa apt meteor lrpt aos los plan next pass tune',
  // rows — цели из Table (поля sat / freq / mode / minEl / prio); пустой вход — параметр targets
  ins:[{n:'rows',t:'bands'}],
  outs:[{n:'go',t:'num'},{n:'above',t:'num'},{n:'freq',t:'num'},{n:'f0',t:'num'},{n:'shift',t:'num'},{n:'mode',t:'txt'},{n:'sat',t:'txt'},
        {n:'az',t:'num'},{n:'el',t:'num'},{n:'range',t:'num'},{n:'tAos',t:'num'},{n:'tLos',t:'num'},{n:'maxel',t:'num'},
        {n:'next',t:'txt'},{n:'count',t:'num'},{n:'plan',t:'rec'},{n:'rec',t:'rec'}],
  params:[{n:'targets',t:'text',d:'NOAA 19;;APT, NOAA 18;;APT, NOAA 15;;APT, METEOR-M2 3;;LRPT, METEOR-M2 4;;LRPT',
            label:'targets: "satellite; freq MHz; mode; min elevation; priority", separated by commas (empty field — default)'},
          {n:'groups',t:'text',d:'noaa, weather',label:'TLE groups (CelesTrak; "file" — the imported file)',fn:n=>spLoadTle(n)},
          {n:'minEl',t:'range',min:0,max:60,step:1,d:10,label:'minimum elevation, °'},
          {n:'pre',t:'range',min:0,max:600,step:5,d:30,label:'start before AOS, s (go goes high, the receiver retunes)'},
          {n:'post',t:'range',min:0,max:600,step:5,d:30,label:'stop after LOS, s'},
          {n:'gap',t:'range',min:0,max:600,step:5,d:20,label:'minimum gap between passes, s (one receiver)'},
          {n:'hours',t:'range',min:1,max:72,step:1,d:24,label:'plan ahead, hours'},
          {n:'tle',t:'button',label:'Download TLE',fn:n=>spDownload(n)},
          {n:'tleFile',t:'file',accept:'.txt,.tle,.3le',fn:(n,f)=>{
            const rd=new FileReader(); rd.onload=()=>{ if(!satParseTle(String(rd.result)).length){ n.msg='no TLE in file'; return; }
              geoPut('tle:file',{t:Date.now(), text:String(rd.result)}).then(()=>{ if(!/\bfile\b/.test(n.p.groups)) n.msg='saved as group "file" — add it to TLE groups'; else spLoadTle(n); }).catch(e=>{ n.msg=e.message; }); };
            rd.readAsText(f); },adv:true}],
  init:n=>{ n.sats=[]; n.satRev=0; n.msg=''; n.plan=[]; n.planKey=''; n.items=[]; n.noOrbit=[]; n.planRecs=null; n.evs=[]; n.lastPhase='idle'; n.lastId='';
            n.cur=null; n.curText=''; n.text='…'; satTxLoad(); spLoadTle(n); },
  process(n,I){
    const now=Date.now(), obs=satObs(), pre=n.p.pre*1000, post=n.p.post*1000;
    if(n._groups!==String(n.p.groups||'').split(/[,;\s]+/).filter(Boolean).join(',')) spLoadTle(n);
    const rows=Array.isArray(I.rows) ? spFromRows(I.rows) : [];
    const targets=rows.length ? rows : spParseTargets(n.p.targets);
    const pk=[JSON.stringify(targets),n.p.minEl,n.p.pre,n.p.post,n.p.gap,n.p.hours,n.satRev,obs?GeoMe.lat+','+GeoMe.lon:'',Math.floor(now/60000)].join('|');
    if(obs && n.sats.length && pk!==n.planKey){
      n.planKey=pk;
      const items=targets.map(t=>{ const s=spFind(n.sats,t.sat), q=spFreq(t,s?.norad,Sat.tx); return {t:{...t,mode:q.mode}, s, f0:q.f0}; });
      const from=now-20*60000, r=spPasses(items,{from,hours:n.p.hours+1/3,obs,minEl:+n.p.minEl},SP_DEPS);
      n.noOrbit=r.noOrbit;
      n.items=items;
      n.plan=spPick(r.passes.filter(p=>p.los+post>=now),pre,post,n.p.gap*1000);
      n.planRecs=n.plan.map(p=>({t:now, src:'SATPLAN', kind:'pass', id:'pass:'+p.norad+':'+Math.round(p.aos/60000), label:p.sat, sat:p.sat, norad:p.norad,
        aos:new Date(p.aos).toISOString(), los:new Date(p.los).toISOString(), dur_s:Math.round((p.los-p.aos)/1000), maxel:+p.maxEl.toFixed(1),
        az_aos:p.azAos!=null ? Math.round(p.azAos) : null, az_los:p.azLos!=null ? Math.round(p.azLos) : null,
        freq:p.f0||null, mode:p.mode, status:p.status, why:p.why||''}));
    }
    if(!obs){ n.plan=[]; n.planRecs=null; n.planKey=''; }
    const w=spNow(n.plan,now,pre,post), cur=w.cur;
    let out={go:0, above:0, count:n.plan.filter(p=>p.status==='planned').length};
    n.cur=null;
    if(cur){
      const s=spFind(n.sats,String(cur.norad)), st=s ? satState(s,new Date(now),obs) : null;
      const rate=s ? satRangeRate(s,now,obs) : null, fRx=spDoppler(cur.f0,rate);
      n.cur={p:cur, st, rate, fRx, phase:w.phase};
      Object.assign(out,{go:1, above:w.phase==='pass' ? 1 : 0, freq:fRx, f0:cur.f0||null, shift:cur.f0 && fRx ? fRx-cur.f0 : null, mode:cur.mode, sat:cur.sat,
        maxel:+cur.maxEl.toFixed(1), tLos:Math.round((cur.los-now)/1000),
        ...(st ? {az:st.az, el:st.el, range:st.range} : {}), ...(rate!=null ? {rate} : {})});
      out.tAos=w.phase==='pre' ? Math.round((cur.aos-now)/1000) : 0;
    }
    const nx=w.next;
    if(nx){ if(!cur) out.tAos=Math.round((nx.aos-now)/1000); out.next=nx.sat+' in '+spFmtDur(nx.aos-now)+' · max '+nx.maxEl.toFixed(0)+'°'; if(!cur){ out.sat=nx.sat; out.mode=nx.mode; out.maxel=+nx.maxEl.toFixed(1); } }
    // события начала и конца пролёта — в журнал
    const id=cur ? cur.norad+':'+Math.round(cur.aos/60000) : '';
    if(w.phase!==n.lastPhase || id!==n.lastId){
      const ev=(kind,p)=>n.evs.push({t:now, src:'SATPLAN', kind, id:'pass:'+p.norad+':'+Math.round(p.aos/60000), label:p.sat, sat:p.sat, norad:p.norad,
        maxel:+p.maxEl.toFixed(1), freq:p.f0||null, mode:p.mode});
      if(n.lastPhase==='pass' && (w.phase!=='pass' || id!==n.lastId) && n.lastCur) ev('los',n.lastCur);
      if(w.phase==='pass' && (n.lastPhase!=='pass' || id!==n.lastId)) ev('aos',cur);
      n.lastPhase=w.phase; n.lastId=id; n.lastCur=cur;
      if(n.evs.length>200) n.evs.splice(0,n.evs.length-200);
    }
    out.plan=n.planRecs; n.planRecs=null;
    out.rec=n.evs.length ? n.evs.splice(0) : null;
    // текст
    const L=[];
    if(n.msg) L.push(n.msg);
    if(!obs) L.push('no observer — add My Position');
    else if(n.sats.length){
      L.push(n.sats.length+' sats · '+n.plan.filter(p=>p.status==='planned').length+' passes planned in '+n.p.hours+' h'+(n.noOrbit.length ? ' · no orbit: '+n.noOrbit.join(', ') : ''));
      if(cur){ const c=n.cur; L.push((w.phase==='pass' ? '▶ ' : w.phase==='pre' ? '◔ AOS in '+spFmtDur(cur.aos-now)+' · ' : '◑ ')+cur.sat+' '+(cur.mode||'')+(cur.f0 ? ' '+(cur.f0/1e6).toFixed(4)+' MHz' : '')+
          (c.fRx && cur.f0 ? ' ('+(c.fRx-cur.f0>=0?'+':'')+(c.fRx-cur.f0)+' Hz)' : '')+(c.st ? ' · el '+c.st.el.toFixed(0)+'° az '+c.st.az.toFixed(0)+'°' : '')+' · LOS in '+spFmtDur(Math.max(0,cur.los-now))); }
      for(const p of n.plan.slice(0,10)) if(p!==cur) L.push((p.status==='planned' ? ' ' : '×')+satFmtT(p.aos)+'–'+satFmtT(p.los)+' '+p.sat.padEnd(13)+' '+p.maxEl.toFixed(0).padStart(2)+'°'+
          (p.mode ? ' '+p.mode : '')+(p.status==='skipped' ? ' (busy: '+p.why+')' : '')+(p.f0 ? '' : ' no freq'));
      L.push('times UTC');
    }
    n.text=L.join('\n');
    return out;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; }});
