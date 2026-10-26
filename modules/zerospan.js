"use strict";
/* ======================= ZERO-SPAN — узел ======================= */
// Уровень на одной частоте от времени (логика — zerospan-kernels.js): IQ-поток → сдвиг на off → фильтр RBW →
// огибающая в дБ, триггер по уровню с предзаписью, измерения импульса: пик, ширина, период, скважность, фронт.

const ZS_SWEEPS=['0.05','0.1','0.2','0.5','1','2','5','10','20','50','100','200','500','1000'];
def({ id:'zerospan', title:'Zero-span (level vs time)', cat:'Radio',
  ins:[{n:'in',t:'iq'},{n:'freq',t:'num',tip:'absolute frequency, Hz (instead of «offset from center»)'},{n:'level',t:'num',tip:'trigger level, dB'}],
  outs:[{n:'lvl',t:'num',tip:'last envelope point, dB'},{n:'peak',t:'num'},{n:'mean',t:'num'},{n:'width',t:'num',tip:'first pulse width, s'},
        {n:'period',t:'num',tip:'distance between the first two pulses, s'},{n:'duty',t:'num'},{n:'rise',t:'num',tip:'10–90 % rise time, s'},
        {n:'trig',t:'num',tip:'a pulse on every trigger'}],
  w:440, view:{h:230}, resize:true, readout:true,
  params:[{n:'off',t:'num',d:0,label:'offset from the stream center, Hz'},
          {n:'rbw',t:'range',min:100,max:2e6,step:10,log:true,d:20000,label:'RBW, Hz (two poles, ≈ −3 dB at 0.64 of it)'},
          {n:'sweep',t:'select',opts:ZS_SWEEPS,d:'1',label:'sweep, ms'},
          {n:'trig',t:'buttons',opts:['rise','fall','free'],d:'rise',label:'trigger'},
          {n:'tmode',t:'buttons',opts:['auto','normal','single'],d:'auto',label:'mode',fn:n=>{ n.armed=true; }},
          {n:'level',t:'range',min:-120,max:0,step:1,d:-40,label:'trigger level, dB'},
          {n:'tpos',t:'range',min:0,max:1,step:.01,d:.25,label:'trigger position (pre-trigger share)'},
          {n:'arm',t:'button',label:'Arm (single)',fn:n=>{ n.armed=true; }},
          {n:'autoset',t:'button',label:'Autoset',fn:n=>zsAutoset(n)},
          {n:'floor',t:'range',min:-140,max:0,step:1,d:-100,label:'bottom, dB',adv:true},
          {n:'top',t:'range',min:-120,max:20,step:1,d:-10,label:'top, dB',adv:true},
          {n:'grid',t:'check',d:true,adv:true}],
  init:n=>{ n.zs=zsNew(); n.armed=true; n.msg=''; n.m=null; n._nt=0; n._pulse=0; n.sr=0; n.fc=0; n.dt=0; n.offUse=0; },
  process(n,I){
    const s=iqIn(I,'in');
    if(!s){ n.msg='connect an IQ stream'; n.m=null; return {trig:0}; }
    n.msg='';
    let off=n.p.off;
    if(typeof I.freq==='number' && isFinite(I.freq)) off=I.freq-s.fc;
    if(typeof I.level==='number' && isFinite(I.level)) setMod(n,'level',I.level);
    const sweep=+n.p.sweep, st=n.zs;
    const p={sr:s.sr,off,rbw:n.p.rbw,sweepMs:sweep,mode:n.p.trig,level:n.p.level,tpos:n.p.tpos,auto:n.p.tmode==='auto'};
    st.armed=n.p.tmode!=='single' || n.armed;
    const nt0=st.nTrig;
    for(const c of s.chunks) zsPush(st,c.re,c.im,p);
    if(n.p.tmode==='single' && st.nTrig>nt0) n.armed=false;
    if(st.nTrig>nt0) n._pulse=2;
    n.sr=s.sr; n.fc=s.fc; n.offUse=off; n.dt=zsDecim(s.sr,sweep)/s.sr;
    n.m=zsMeasure(st.frame,n.dt,st.trigIdx>=0 ? n.p.level : NaN);
    const m=n.m||{}, pulse=n._pulse>0 ? 1 : 0; if(n._pulse>0) n._pulse--;
    const last=st.total>0 ? st.ring[(st.total-1)%ZS_RING] : null;
    return {lvl:last, peak:m.peak??null, mean:m.mean??null, width:Number.isFinite(m.width)?m.width:null, period:Number.isFinite(m.period)?m.period:null,
      duty:Number.isFinite(m.duty)?m.duty:null, rise:Number.isFinite(m.rise)?m.rise:null, trig:pulse}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout'), m=n.m;
    const txt=n.msg || (n.sr ? fmtHz(n.fc+n.offUse,4)+'Hz · RBW '+fmtHz(n.p.rbw,n.p.rbw<1e4?2:1)+'Hz · '+n.p.sweep+' ms · '+
      (m ? 'peak '+m.peak.toFixed(1)+' dB · mean '+m.mean.toFixed(1)+' dB'+(Number.isFinite(m.width)?' · width '+zsFmtT(m.width):'')+(Number.isFinite(m.period)?' · period '+zsFmtT(m.period):'')+
        (Number.isFinite(m.duty)?' · duty '+(m.duty*100).toFixed(1)+'%':'')+(Number.isFinite(m.rise)?' · rise '+zsFmtT(m.rise):'') : 'waiting for samples…') : '');
    if(r && r.textContent!==txt) r.textContent=txt;
    if(!cv||!cx) return;
    const W=cv.width, H=cv.height, st=n.zs, f=st.frame;
    cx.clearRect(0,0,W,H); cx.fillStyle=themeColor('--screen'); cx.fillRect(0,0,W,H);
    const lo=n.p.floor, hi=n.p.top, y=v=>H-1-clamp((v-lo)/((hi-lo)||1),0,1)*(H-2);
    if(n.p.grid){
      cx.strokeStyle=themeColor('--grid'); cx.lineWidth=1; cx.font='10px monospace'; cx.fillStyle=themeColor('--axis'); cx.textAlign='left';
      for(let k=0;k<=10;k++){ const x=Math.round(k*(W-1)/10)+.5; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); }
      for(let v=Math.ceil(lo/10)*10; v<=hi; v+=10){ const yy=Math.round(y(v))+.5; cx.beginPath(); cx.moveTo(0,yy); cx.lineTo(W,yy); cx.stroke(); cx.fillText(v+'',3,yy-2); }
      if(n.sr){ const sw=n.dt*ZS_NW; cx.textAlign='right'; cx.fillText(zsFmtT(sw/10)+'/div',W-4,H-4); }
    }
    if(!f){ cx.fillStyle=themeColor('--axis'); cx.textAlign='center'; cx.fillText(n.msg||(n.p.trig==='free'?'waiting for samples…':'waiting for a trigger…'),W/2,H/2); return; }
    const X=i=>i*(W-1)/(f.length-1);
    cx.beginPath(); cx.moveTo(0,y(f[0]));
    for(let i=1;i<f.length;i++) cx.lineTo(X(i),y(f[i]));
    cx.lineTo(W-1,H); cx.lineTo(0,H); cx.closePath();
    const col=getComputedStyle(document.body).getPropertyValue('--t-spec')||'#4fc3f7';
    cx.globalAlpha=.2; cx.fillStyle=col; cx.fill(); cx.globalAlpha=1;
    cx.strokeStyle=col; cx.lineWidth=1.2; cx.beginPath(); cx.moveTo(0,y(f[0]));
    for(let i=1;i<f.length;i++) cx.lineTo(X(i),y(f[i]));
    cx.stroke();
    if(n.p.trig!=='free'){                                             // уровень триггера и точка события
      const ty=Math.round(y(n.p.level))+.5; cx.strokeStyle=themeColor('--acc'); cx.globalAlpha=.8; cx.setLineDash([4,3]);
      cx.beginPath(); cx.moveTo(0,ty); cx.lineTo(W,ty); cx.stroke(); cx.setLineDash([]); cx.globalAlpha=1;
      if(st.trigIdx>=0){ const tx=X(st.trigIdx); cx.fillStyle=themeColor('--acc'); cx.beginPath(); cx.moveTo(tx-5,0); cx.lineTo(tx+5,0); cx.lineTo(tx,8); cx.fill(); }
    }
    cx.font='10px monospace'; cx.textAlign='left'; cx.fillStyle=themeColor('--acc');
    cx.fillText(n.p.tmode==='single' ? (n.armed?'● armed':'■ stopped') : (st.auto ? 'auto (no trigger)' : n.p.trig==='free' ? 'free run' : 'triggered'),W-110,12);
  }});
function zsAutoset(n){
  const f=n.zs&&n.zs.frame; if(!f) return;
  let mx=-Infinity, mn=Infinity; for(const v of f){ if(v>mx) mx=v; if(v<mn) mn=v; }
  mn=Math.max(mn,mx-90);
  setMod(n,'top',Math.min(20,Math.ceil(mx+5))); setMod(n,'floor',Math.max(-140,Math.floor(mn-5)));
  setMod(n,'level',Math.round((mx+mn)/2));
  n.armed=true;
}
