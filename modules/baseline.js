"use strict";
/* ============================ Spectrum Baseline ============================
   Запоминает «норму» эфира и сообщает об отклонениях. Ядро — baseline-kernels.js (node tools/test-baseline.mjs). */
function blFresh(n,s){
  const f=s.rev!=null ? s.rev!==n._lastRev : s!==n._lastSpecRef;
  if(f){ n._lastRev=s.rev; n._lastSpecRef=s; }
  return f;
}
def({ id:'specBase', title:'Spectrum Baseline', cat:'Analysis', readout:true, tall:true, resize:true, w:420,
  kw:'baseline anomaly new signal jammer interference missing change detection monitor learn normal activity intrusion',
  ins:[{n:'spec',t:'spec'}],
  outs:[{n:'bands',t:'bands'},{n:'rec',t:'rec'},{n:'base',t:'spec'},{n:'count',t:'num'},{n:'f',t:'num'},{n:'excess',t:'num'},{n:'learned',t:'num'}],
  params:[{n:'mode',t:'select',opts:['monitor','learn only'],d:'monitor',label:'monitor: report deviations; learn only: just update the norm'},
          {n:'res',t:'select',opts:['auto','100','500','1000','5000','12500','25000','100000'],d:'auto',label:'cell width, Hz (auto — the bin width of the spectrum on the 1-2-5 grid)'},
          {n:'learn',t:'range',min:5,max:500,step:1,d:30,label:'visits to learn a cell before it is checked'},
          {n:'adapt',t:'range',min:10,max:5000,step:10,d:300,log:true,label:'norm adapts over, visits (a permanent new station is absorbed after ≈ 2× this)'},
          {n:'thr',t:'range',min:2,max:40,step:.5,d:8,label:'report above the norm by, dB'},
          {n:'z',t:'range',min:1,max:10,step:.5,d:5,label:'… and by more than this many σ of the cell'},
          {n:'sdMin',t:'range',min:.5,max:6,step:.5,d:1.5,label:'smallest σ of a cell, dB (a quiet cell is not over-sensitive)'},
          {n:'confirm',t:'range',min:1,max:10,step:1,d:3,label:'frames in a row before a report'},
          {n:'hold',t:'range',min:0,max:60000,step:100,d:3000,label:'event ends after it is gone for, ms'},
          {n:'wide',t:'range',min:5,max:5000,step:5,d:200,label:'wider than this, kHz — a wideband event (jammer, raised floor)'},
          {n:'missing',t:'check',d:true,label:'report carriers that were almost always present and vanished'},
          {n:'occMin',t:'range',min:.5,max:1,step:.01,d:.8,label:'… "almost always": share of visits with a signal',adv:true},
          {n:'drop',t:'range',min:6,max:40,step:1,d:15,label:'… and now below the norm by, dB',adv:true},
          {n:'top',t:'range',min:3,max:40,step:1,d:10,label:'events shown',adv:true},
          {n:'clr',t:'button',label:'Forget',fn:n=>{ n.st=blNew(); n.text='forgotten'; n.bnd=[]; n.act=[]; }},
          {n:'save',t:'button',label:'Save norm',fn:n=>{ const d=blSave(n.st); if(!d){ n.text='nothing to save yet'; return; }
            dl(new Blob([JSON.stringify(d)],{type:'application/json'}),'baseline-'+Date.now()+'.json'); }},
          {n:'load',t:'button',label:'Load norm',fn:n=>{ const i=document.createElement('input'); i.type='file'; i.accept='.json,application/json';
            i.onchange=async()=>{ try{ const ok=blLoad(n.st,JSON.parse(await i.files[0].text())); n.text=ok ? 'norm loaded: '+n.st.cap+' cells' : 'not a baseline file'; if(ok) n.resAuto=n.st.res; }
              catch(e){ n.text='cannot read: '+e.message; } };
            i.click(); }}],
  init:n=>{ n.st=blNew(); n.text='connect a spectrum'; n.bnd=[]; n.act=[]; n.recs=[]; n.base=null; n.resAuto=0; n.learned=0; n.nact=0; },
  process(n,I){
    const s=I.spec;
    if(!s || !s.mag || s.mag.length<2) return {bands:n.bnd, rec:null, base:n.base, count:n.act.length, f:null, excess:null, learned:n.learned};
    if(blFresh(n,s)){
      const N=s.mag.length, binHz=Math.abs(specHz(s,1)-specHz(s,0))||1;
      const res=n.p.res==='auto' ? (n.resAuto>0 && n.st.cap ? n.resAuto : cfarIdStep('auto',binHz)) : +n.p.res;
      if(n.p.res==='auto') n.resAuto=res;
      const m=s.mag, o={res, learn:+n.p.learn, adapt:+n.p.adapt, thr:+n.p.thr, z:+n.p.z, sdMin:+n.p.sdMin, confirm:+n.p.confirm,
        hold:+n.p.hold, wideBw:+n.p.wide*1000, occMin:n.p.missing ? +n.p.occMin : 2, drop:+n.p.drop, learnOnly:n.p.mode==='learn only', now:performance.now()};
      const r=blFrame(n.st,N,i=>specHz(s,i),i=>20*Math.log10(Math.max(m[i],1e-12)),o);
      n.learned=r.learning;
      for(const x of r.recs) n.recs.push(x);
      if(n.recs.length>1000) n.recs.splice(0,n.recs.length-1000);
      n.act=r.active.slice().sort((a,b)=>b.ex-a.ex);
      n.bnd=n.act.map(e=>({lo:e.lo, hi:e.hi, f:e.f, sig:true, color:e.kind==='new' ? '#ff9800' : e.kind==='wideband' ? '#f44336' : '#90a4ae',
        label:(e.kind==='missing' ? 'gone ' : e.kind==='wideband' ? 'wide +' : '+')+e.ex.toFixed(0)+' dB'}));
      const base=new Float32Array(N); for(let i=0;i<N;i++){ const v=blAt(n.st,specHz(s,i)); base[i]=v==null ? 0 : Math.pow(10,v/20); }
      n.base={mag:base, sr:s.sr, size:s.size, freqs:s.freqs, rev:(n.brev=(n.brev|0)+1)};
      const st=n.st, lines=n.act.slice(0,+n.p.top).map(e=>(fmtHz(e.f,e.f>1e6?4:2)+'Hz').padStart(13)+'  '+e.kind.padEnd(8)+' '+(e.kind==='missing' ? '−' : '+')+e.ex.toFixed(0)+' dB  bw '+fmtHz(e.bw,1)+'Hz');
      n.text=(n.p.mode==='learn only' ? 'learning (no reports)' : r.learning<.5 ? 'learning '+(r.learning*100).toFixed(0)+'%' : 'watching')+
        ' · '+st.cap+' cells of '+fmtHz(st.res,1)+'Hz · floor '+(r.floor!=null ? r.floor.toFixed(1) : '—')+' dB\n'+(lines.length ? lines.join('\n') : 'no deviations');
    }
    const rec=n.recs.length ? n.recs.splice(0) : null, a=n.act[0];
    return {bands:n.bnd, rec, base:n.base, count:n.act.length, f:a?a.f:null, excess:a?a.ex:null, learned:n.learned};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; }});
