"use strict";
/* ============================ Air Diary ============================
   Дневник эфира: спектр (SDR, FFT…) → когда и на каких частотах эфир был занят + повторяющиеся передатчики. Работает днями: слоты по часу (или короче),
   история лежит в IndexedDB под именем дневника и переживает перезапуск. На холсте — тепловая карта «час суток × частота» (или «день × частота»):
   цвет — доля времени, когда ячейка была выше пола на thr дБ; наведи курсор — час, частота, доля, уровень.
   Выходы: rows — ячейки карты в Table; tx — найденные передатчики в Table; rec — поток записей (новый маяк / периодический / несущая / «каждый день в этот час»);
   bursts — все всплески (t, dur, freq, rssi) в Timeline: дорожки по частоте, период, джиттер, скважность.
   Ядро — modules/airdiary-kernels.js (tools/test-airdiary.mjs). */

/* ---- хранилище: IndexedDB «dsp-airdiary», по записи на дневник ---- */
function adDb(){
  return new Promise((ok,bad)=>{ const q=indexedDB.open('dsp-airdiary',1);
    q.onupgradeneeded=()=>q.result.createObjectStore('diary');
    q.onsuccess=()=>ok(q.result); q.onerror=()=>bad(q.error); });
}
async function adPut(name,obj){ const db=await adDb(); return new Promise((ok,bad)=>{ const t=db.transaction('diary','readwrite'); t.objectStore('diary').put(obj,name); t.oncomplete=()=>ok(); t.onerror=()=>bad(t.error); }); }
async function adGet(name){ const db=await adDb(); return new Promise((ok,bad)=>{ const q=db.transaction('diary').objectStore('diary').get(name); q.onsuccess=()=>ok(q.result||null); q.onerror=()=>bad(q.error); }); }
async function adDel(name){ const db=await adDb(); return new Promise((ok,bad)=>{ const t=db.transaction('diary','readwrite'); t.objectStore('diary').delete(name); t.oncomplete=()=>ok(); t.onerror=()=>bad(t.error); }); }

const AD_PAL=[[0,[12,16,28]],[.04,[24,52,120]],[.15,[28,128,170]],[.35,[60,190,140]],[.6,[240,210,70]],[1,[240,70,50]]];   // тёмный → синий → бирюза → жёлтый → красный
function adCol(v){
  const x=Math.sqrt(Math.max(0,Math.min(1,v)));                    // корень: редкая занятость видна
  for(let i=1;i<AD_PAL.length;i++){ const [f1,c1]=AD_PAL[i], [f0,c0]=AD_PAL[i-1];
    if(x<=f1){ const u=(x-f0)/(f1-f0); return c0.map((c,k)=>c+(c1[k]-c)*u); } }
  return AD_PAL[AD_PAL.length-1][1];
}
const adFq=hz=>hz>=1e9 ? (hz/1e9).toFixed(4)+' GHz' : hz>=1e6 ? (hz/1e6).toFixed(3)+' MHz' : (hz/1e3).toFixed(1)+' kHz';

function adSaveNow(n){
  const name=String(n.p.diary||'').trim(); if(!name || n.loading || !n.st.slots.size) return Promise.resolve(false);
  n.dirty=false; return adPut(name,adSave(n.st)).then(()=>{ n.savedAt=Date.now(); return true; }).catch(e=>{ n.err='cannot save: '+(e&&e.message||e); return false; });
}
async function adReload(n){
  const name=String(n.p.diary||'').trim(); n.loadedName=name; n.loading=!!name;
  if(!name){ n.loading=false; return; }
  try{ const d=await adGet(name); if(n.loadedName===name){ n.st=adNew(); if(d && adLoad(n.st,d)) n.msg='diary “'+name+'” loaded: '+n.st.slots.size+' slots'; else n.msg='new diary “'+name+'”'; } }
  catch(e){ n.err='cannot read: '+(e&&e.message||e); }
  n.loading=false; n.heatKey='';
}
function adCsv(rows){
  if(!rows.length) return '';
  const cols=Object.keys(rows[0]); return cols.join(',')+'\n'+rows.map(r=>cols.map(c=>{ const v=r[c]; return v==null ? '' : /[",\n]/.test(v) ? '"'+String(v).replace(/"/g,'""')+'"' : v; }).join(',')).join('\n');
}

def({ id:'airdiary', title:'Air Diary', cat:'Analysis', readout:true, resize:true, w:560, view:{h:230}, viewTop:true,
  kw:'air diary spectrum occupancy history heatmap hour frequency monitor repeater beacon periodic transmitter schedule log band usage activity channel busy day night timeline дневник эфира занятость',
  ins:[{n:'spec',t:'spec'},{n:'pause',t:'num'}],
  outs:[{n:'rows',t:'bands'},{n:'tx',t:'bands'},{n:'bursts',t:'bands'},{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'occ',t:'num'},{n:'active',t:'num'}],
  groups:[{n:'Time and grid'},{n:'Detection',open:false},{n:'Repeaters',open:false},{n:'Map',open:false}],
  params:[
    {n:'diary',t:'text',d:'main',label:'diary name (stored in the browser; empty — only until the page closes)',g:'Time and grid'},
    {n:'mapView',t:'select',opts:['hour × frequency','day × frequency'],d:'hour × frequency',label:'map rows: hours of the day (all days together) or each day',g:'Map'},
    {n:'show',t:'range',min:1,max:60,step:1,d:14,label:'days on the map and in the history (older is forgotten)',g:'Time and grid'},
    {n:'slot',t:'select',opts:['5','10','15','30','60'],d:'60',label:'time slot, min (the diary is kept per slot; the map has hour rows)',g:'Time and grid'},
    {n:'res',t:'select',opts:['auto','100','500','1000','5000','12500','25000','100000'],d:'auto',label:'cell width, Hz (auto — the bin width of the spectrum on the 1-2-5 grid). A change starts a new diary',g:'Time and grid'},
    {n:'thr',t:'range',min:3,max:40,step:.5,d:10,label:'busy above the floor by, dB (the floor is the median of the frame)',g:'Detection'},
    {n:'confirm',t:'range',min:1,max:20,step:1,d:2,label:'frames in a row before a transmission starts',g:'Detection'},
    {n:'hold',t:'range',min:50,max:60000,step:50,d:1500,log:true,label:'a transmission ends after it is gone for, ms',g:'Detection'},
    {n:'fps',t:'range',min:1,max:30,step:1,d:10,label:'frames per second taken from the spectrum (more is not better: time is counted in frames)',g:'Detection'},
    {n:'minBursts',t:'range',min:4,max:30,step:1,d:6,label:'transmissions needed to call a transmitter periodic',g:'Repeaters'},
    {n:'regular',t:'range',min:40,max:100,step:1,d:70,label:'regularity, % of intervals that fit the period (a skipped repeat counts)',g:'Repeaters'},
    {n:'tol',t:'range',min:2,max:30,step:1,d:10,label:'period tolerance, %',g:'Repeaters'},
    {n:'contMin',t:'range',min:5,max:3600,step:5,d:60,log:true,label:'a carrier that does not go off for this long, s — continuous',g:'Repeaters'},
    {n:'minDays',t:'range',min:2,max:14,step:1,d:3,label:'“daily”: the same hour on this many days (and on 60% of the days seen)',g:'Repeaters'},
    {n:'fmin',t:'num',d:0,label:'map from, Hz (0 — all observed)',g:'Map'},
    {n:'fmax',t:'num',d:0,label:'map to, Hz (0 — all observed)',g:'Map'},
    {n:'minOcc',t:'range',min:0,max:50,step:.5,d:.5,label:'rows output: cells busy at least, %',g:'Map'},
    {n:'on',t:'check',d:true,label:'recording (off — the diary only shows what it has)'},
    {n:'save',t:'button',label:'Save now',fn:n=>{ adSaveNow(n).then(ok=>{ n.msg=ok ? 'saved' : (n.err||'nothing to save yet'); }); }},
    {n:'csv',t:'button',label:'Map → CSV',fn:n=>{ const t=adCsv(n.rowsOut||[]); if(!t){ n.msg='the map is empty'; return; } dl(new Blob([t],{type:'text/csv'}),'airdiary-'+(n.p.diary||'map')+'.csv'); }},
    {n:'csv2',t:'button',label:'Transmitters → CSV',fn:n=>{ const t=adCsv(n.txOut||[]); if(!t){ n.msg='no transmitters yet'; return; } dl(new Blob([t],{type:'text/csv'}),'airdiary-tx-'+(n.p.diary||'')+'.csv'); }},
    {n:'clr',t:'button',label:'Forget everything',fn:n=>{ n.st=adNew(); n.heatKey=''; n.heat=null; n.rowsOut=[]; n.txOut=[]; n.msg='forgotten'; const nm=String(n.p.diary||'').trim(); if(nm) adDel(nm).catch(()=>{}); }}],
  init:n=>{ n.st=adNew(); n.loading=false; n.loadedName=null; n.msg='connect a spectrum'; n.err=''; n.heat=null; n.heatKey=''; n.heatAt=0; n.rowsOut=[]; n.txOut=[]; n.recs=[];
    n.lastRev=undefined; n.lastRef=null; n.lastT=0; n.dirty=false; n.saveAt=0; n.savedAt=0; n.occ=0; n.nact=0; n.hov=null; n.resAuto=0; n.rev=0; n.txRev=0; n.burstRev=0; n.burstOut=[]; adReload(n); },
  dispose:n=>{ adSaveNow(n); },
  process(n,I){
    const p=n.p, s=I.spec, now=Date.now();
    if(String(p.diary||'').trim()!==n.loadedName && !n.loading) adReload(n);
    if(s && s.mag && s.mag.length>1 && !n.loading && p.on && !(I.pause>=.5)){
      const fresh=s.rev!=null ? s.rev!==n.lastRev : s!==n.lastRef;
      if(fresh){ n.lastRev=s.rev; n.lastRef=s; }
      if(fresh && now-n.lastT>=1000/Math.max(1,+p.fps)){
        n.lastT=now;
        const N=s.mag.length, binHz=Math.abs(specHz(s,1)-specHz(s,0))||1, m=s.mag;
        const res=p.res==='auto' ? (n.resAuto>0 && n.st.res===n.resAuto ? n.resAuto : cfarIdStep('auto',binHz)) : +p.res;
        if(p.res==='auto') n.resAuto=res;
        const r=adFrame(n.st,N,i=>specHz(s,i),i=>20*Math.log10(Math.max(m[i],1e-12)),
          {res, slotMin:+p.slot, thr:+p.thr, confirm:+p.confirm, hold:+p.hold, gap:1, now, contMs:+p.contMin*1000, minBursts:+p.minBursts,
           regular:+p.regular/100, tol:+p.tol/100, minDays:+p.minDays});
        n.occ=r.occ; n.nact=r.active.length; n.dirty=true;
        for(const x of r.recs) n.recs.push(x);
        if(n.recs.length>500) n.recs.splice(0,n.recs.length-500);
        if(r.recs.length || n.burstN!==n.st.bursts.length) n.rev++;
        n.burstN=n.st.bursts.length;
      }
    }
    if(now-n.heatAt>1500 || n.heatKey===''){                         // карта и таблицы — раз в 1,5 с
      n.heatAt=now; adPrune(n.st,now,+p.show);
      const key=p.mapView+'|'+p.show+'|'+p.fmin+'|'+p.fmax;
      n.heat=adHeat(n.st,{mode:p.mapView.startsWith('day') ? 'day' : 'hour', days:+p.show, now, cols:Math.max(60,Math.min(600,Math.round((n.size&&n.size.w||560)/2))),
        f0:+p.fmin>0 ? +p.fmin : null, f1:+p.fmax>0 ? +p.fmax : null});
      n.heatKey=key; n.rowsOut=adHeatRows(n.heat,+p.minOcc/100); n.txOut=adTrackRows(n.st); n.burstOut=n.st.bursts.slice(-3000); n.rev++;
    }
    if(n.dirty && now-n.saveAt>60000){ n.saveAt=now; adSaveNow(n); }
    const rec=n.recs.length ? n.recs.splice(0) : null;
    return {rows:n.rowsOut, tx:n.txOut, bursts:n.burstOut, rec, count:n.txOut.filter(t=>t.kind!=='sporadic').length, occ:n.occ*100, active:n.nact};
  },
  draw(n,cv,cx){
    const ro=n.el.querySelector('.readout'), p=n.p, st=n.st, h=n.heat;
    if(ro){
      const tx=n.txOut.filter(t=>t.kind!=='sporadic').slice(0,6);
      const lines=[(n.loading ? 'loading the diary…' : !p.on ? '⏸ not recording' : st.res ? '● recording' : 'waiting for a spectrum')+
        (st.res ? ' · cells '+adFq(st.res)+' · slots '+st.slots.size+' ('+p.slot+' min) · now busy '+(n.occ*100).toFixed(1)+'% · '+n.nact+' active' : '')];
      if(n.hov) lines.push(n.hov);
      for(const t of tx) lines.push(adFq(t.freq).padStart(11)+'  '+t.kind.padEnd(11)+(t.period!=null && /beacon|periodic/.test(t.kind) ? 'every '+t.period+' s · ' : '')+(t.hour!=null ? 'at '+t.hour+':00 · ' : '')+t.count+' tx · '+t.db+' dB');
      if(!tx.length && st.res) lines.push('no repeating transmitters yet — they appear after '+p.minBursts+' transmissions');
      if(n.err) lines.push(n.err); else if(n.msg) lines.push(n.msg);
      const t=lines.join('\n'); if(ro.textContent!==t) ro.textContent=t;
    }
    if(!cv || !cv.width) return;
    if(!n._hv){ n._hv=1;
      cv.addEventListener('pointermove',e=>{ const hh=n.heat; if(!hh){ n.hov=null; return; }
        const r=cv.getBoundingClientRect(), x=(e.clientX-r.left)/r.width, y=(e.clientY-r.top)/r.height, L=n._pl||0, B=n._pb||0, W=1-L/r.width, H=1-B/r.height;
        const u=(x-L/r.width)/W, v=y/H; if(u<0||u>1||v<0||v>1){ n.hov=null; return; }
        const row=hh.rows[Math.min(hh.rows.length-1,Math.floor(v*hh.rows.length))], c=Math.min(hh.cols-1,Math.floor(u*hh.cols));
        n.hov=row.label+' · '+adFq(hh.f0+(c+.5)*hh.step*hh.res)+' · busy '+(row.occ[c]*100).toFixed(1)+'%'+(isFinite(row.db[c]) ? ' · '+row.db[c].toFixed(0)+' dB' : '')+' · '+row.frames+' frames'; });
      cv.addEventListener('pointerleave',()=>{ n.hov=null; }); }
    const key=n.rev+'|'+cv.width+'x'+cv.height; if(n._dk===key) return; n._dk=key;
    const W=cv.width, H=cv.height; cx.clearRect(0,0,W,H);
    const L=34, B=16; n._pl=L; n._pb=B;
    if(!h){ cx.fillStyle=themeColor('--dim'); cx.font='11px sans-serif'; cx.fillText(n.loading ? 'loading…' : 'the map appears after the first frames', 10, H/2); return; }
    const pw=W-L, ph=H-B, rows=h.rows.length;
    const img=document.createElement('canvas'); img.width=h.cols; img.height=rows; const ic=img.getContext('2d'), id=ic.createImageData(h.cols,rows);
    h.rows.forEach((r,y)=>{ for(let c=0;c<h.cols;c++){ const k=(y*h.cols+c)*4, col=r.frames>0 ? adCol(r.occ[c]) : [20,22,30]; id.data[k]=col[0]; id.data[k+1]=col[1]; id.data[k+2]=col[2]; id.data[k+3]=255; } });
    ic.putImageData(id,0,0); cx.imageSmoothingEnabled=false; cx.drawImage(img,L,0,pw,ph);
    cx.fillStyle=themeColor('--dim'); cx.font='10px sans-serif'; cx.textBaseline='middle'; cx.textAlign='right';
    const step=rows>30 ? Math.ceil(rows/10) : 3;
    h.rows.forEach((r,y)=>{ if(y%step===0) cx.fillText(rows>30 ? r.label.slice(5) : r.label.slice(0,2),L-4,(y+.5)*ph/rows); });
    cx.textBaseline='top'; cx.textAlign='center';
    const nt=Math.max(2,Math.min(8,Math.floor(pw/90)));
    for(let i=0;i<=nt;i++){ const f=h.f0+(h.f1-h.f0)*i/nt; cx.fillText(adFq(f).replace(/ [A-Za-z]+$/,''),L+pw*i/nt,ph+3); }
  }});
