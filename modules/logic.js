"use strict";
/* ============================ CONTROL LOGIC ============================ */
// Универсальные блоки на числовых проводах: Math, Compare, Logic, Select, Flip-Flop,
// Sample & Hold, Counter, One-Shot. Число входов задаёт параметр «inputs» (порты пересобираются).
// Импульс — число 0/1; фронт — переход через 0.5. Любой числовой параметр можно подать проводом.

const LG_COUNTS=['2','3','4','5','6','7','8'];
const lgOn=v=>typeof v==='number' && v>=.5;
const lgIns=(n,pre='in')=>Array.from({length:+n.p.inputs||2},(_,k)=>({n:pre+(k+1),t:'num'}));
const lgVals=(n,I)=>lgIns(n).map(p=>typeof I[p.n]==='number' && isFinite(I[p.n]) ? I[p.n] : null);
function lgResize(n){                                // после смены числа входов — убрать провода к исчезнувшим портам
  const valid=new Set(portsOf(n,'ins').map(p=>p.n));
  Graph.edges.filter(e=>e.to===n.id && !valid.has(e.tp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
const LG_INPUTS={n:'inputs',t:'select',opts:LG_COUNTS,d:'2',label:'inputs',fn:lgResize};
function lgEdge(n,key,v){                            // true на фронте 0→1
  const hi=lgOn(v), r=hi && !n.lg[key]; n.lg[key]=hi; return r;
}
const lgFmt=v=>typeof v!=='number' || !isFinite(v) ? '—' : Math.abs(v)>=1e5 || (v!==0 && Math.abs(v)<1e-3) ? v.toExponential(2) : String(+v.toFixed(4));
const lgReadout=(n,s)=>{ const r=n.el.querySelector('.readout'); if(r) r.textContent=s; };

/* ---------- Math ---------- */
const LG_OPS={
  sum:a=>a.reduce((s,v)=>s+(v??0),0),
  mean:a=>{ const w=a.filter(v=>v!==null); return w.length ? w.reduce((s,v)=>s+v,0)/w.length : 0; },
  product:a=>a.reduce((s,v)=>s*(v??1),1),
  min:a=>{ const w=a.filter(v=>v!==null); return w.length ? Math.min(...w) : 0; },
  max:a=>{ const w=a.filter(v=>v!==null); return w.length ? Math.max(...w) : 0; },
  'in1 − rest':a=>(a[0]??0)-a.slice(1).reduce((s,v)=>s+(v??0),0),
  'in1 ÷ rest':a=>{ const d=a.slice(1).reduce((s,v)=>s*(v??1),1); return d ? (a[0]??1)/d : 0; },
  'in1 ^ in2':a=>Math.pow(a[0]??0,a[1]??1),
  '|in1 − in2|':a=>Math.abs((a[0]??0)-(a[1]??0)),
};
def({ id:'nmath', title:'Math', cat:'Control',
  ins:n=>lgIns(n), outs:[{n:'out',t:'num'}], readout:true,
  params:[{n:'op',t:'select',opts:Object.keys(LG_OPS),d:'sum',label:'operation'}, LG_INPUTS,
          {n:'k',t:'num',d:1,label:'gain'},{n:'ofs',t:'num',d:0,label:'offset'}],
  init:n=>{ n.v=0; },
  process(n,I){
    let r=(LG_OPS[n.p.op]||LG_OPS.sum)(lgVals(n,I))*n.p.k+n.p.ofs;
    if(!isFinite(r)) r=0;
    n.v=r; return {out:r}; },
  draw(n){ lgReadout(n,lgFmt(n.v)); }
});

/* ---------- Compare (порог / окно с гистерезисом + экранчик) ---------- */
const LG_HIST=4096;
def({ id:'ncmp', lazy:'proc', title:'Compare', cat:'Control',
  ins:[{n:'in',t:'num'}], outs:[{n:'out',t:'num'},{n:'rise',t:'num'},{n:'fall',t:'num'}],
  view:{h:90}, resize:true, readout:true,
  params:[{n:'mode',t:'select',opts:['above','below','inside','outside'],d:'above',label:'condition'},
          {n:'thr',t:'num',d:.5,label:'threshold / low'},
          {n:'thr2',t:'num',d:1,label:'high (window)'},
          {n:'hys',t:'num',d:0,label:'hysteresis'},
          {n:'hold',t:'range',min:0,max:60,step:.01,d:0,label:'min on-time, s'},
          {n:'invert',t:'check',d:false},
          {n:'span',t:'range',min:1,max:120,step:1,d:10,log:true,label:'screen, s'}],
  init:n=>{ n.lg={}; n.q=false; n.ht=0; n.on=false; n.v=null; n.ring=new Float32Array(LG_HIST);
            n.st=new Uint8Array(LG_HIST); n.w=0; n.cnt=0; },
  process(n,I){
    const p=n.p, v=typeof I.in==='number' && isFinite(I.in) ? I.in : null, h=Math.abs(p.hys)/2;
    const lo=Math.min(p.thr,p.thr2), hi=Math.max(p.thr,p.thr2);
    if(v!==null){
      const was=n.q;
      if(p.mode==='above') n.q=was ? v>p.thr-h : v>p.thr+h;
      else if(p.mode==='below') n.q=was ? v<p.thr+h : v<p.thr-h;
      else {                                          // окно: inside / outside — одно состояние, outside инвертирует
        const ins=p.mode==='inside' ? was : !was;
        const r=ins ? v>lo-h && v<hi+h : v>lo+h && v<hi-h;
        n.q=p.mode==='inside' ? r : !r;
      }
    } else n.q=false;
    const dt=BLOCK/Eng.sr;
    n.ht = n.q ? +p.hold : Math.max(0,n.ht-dt);
    let o=n.q || n.ht>0; if(p.invert) o=!o;
    const rise=o && !n.on, fall=!o && n.on; n.on=o; n.v=v;
    n.ring[n.w]=v===null ? NaN : v; n.st[n.w]=o?1:0; n.w=(n.w+1)%LG_HIST; n.cnt=Math.min(LG_HIST,n.cnt+1);
    return {out:o?1:0, rise:rise?1:0, fall:fall?1:0}; },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, p=n.p, rate=(Eng.sr||48000)/BLOCK;
    const span=clamp(Math.round(p.span*rate),2,Math.min(LG_HIST,Math.max(2,n.cnt))), start=(n.w-span+LG_HIST)%LG_HIST;
    const win=p.mode==='inside' || p.mode==='outside', h=Math.abs(p.hys)/2;
    let lo=Infinity, hi=-Infinity;
    for(let k=0;k<span;k++){ const v=n.ring[(start+k)%LG_HIST]; if(v<lo) lo=v; if(v>hi) hi=v; }
    for(const t of win ? [p.thr,p.thr2] : [p.thr]){ if(t<lo) lo=t; if(t>hi) hi=t; }
    if(!isFinite(lo)){ lo=0; hi=1; }
    const pad=(hi-lo)*.12||.5; lo-=pad; hi+=pad;
    const Y=v=>H-clamp((v-lo)/(hi-lo),0,1)*H;
    cx.clearRect(0,0,W,H);
    cx.fillStyle=themeColor('--acc2'); cx.globalAlpha=.18;
    for(let x=0;x<W;x++) if(n.st[(start+Math.floor(x/W*span))%LG_HIST]) cx.fillRect(x,0,1,H);
    cx.globalAlpha=1; cx.lineWidth=1;
    cx.strokeStyle=themeColor('--acc'); cx.setLineDash([4,3]);
    for(const t of win ? [p.thr,p.thr2] : [p.thr]){
      cx.beginPath(); cx.moveTo(0,Y(t)+.5); cx.lineTo(W,Y(t)+.5); cx.stroke();
      if(h>0){ cx.globalAlpha=.4; for(const d of [-h,h]){ cx.beginPath(); cx.moveTo(0,Y(t+d)+.5); cx.lineTo(W,Y(t+d)+.5); cx.stroke(); } cx.globalAlpha=1; } }
    cx.setLineDash([]); cx.strokeStyle=themeColor('--t-num'); cx.beginPath();
    let pen=false;
    for(let x=0;x<W;x++){ const v=n.ring[(start+Math.floor(x/W*span))%LG_HIST];
      if(isNaN(v)){ pen=false; continue; }
      pen ? cx.lineTo(x,Y(v)) : cx.moveTo(x,Y(v)); pen=true; }
    cx.stroke();
    cx.fillStyle=themeColor('--axis'); cx.font='8px monospace';
    cx.fillText(lgFmt(hi),2,9); cx.fillText(lgFmt(lo),2,H-2);
    lgReadout(n,lgFmt(n.v)+' · '+(n.on?'ON':'off')); }
});

/* ---------- Logic ---------- */
const LG_LOGIC={
  AND:b=>b.every(Boolean), OR:b=>b.some(Boolean), XOR:b=>b.filter(Boolean).length%2===1,
  NAND:b=>!b.every(Boolean), NOR:b=>!b.some(Boolean), XNOR:b=>b.filter(Boolean).length%2===0,
};
def({ id:'nlogic', title:'Logic', cat:'Control',
  ins:n=>lgIns(n), outs:[{n:'out',t:'num'},{n:'not',t:'num'}], readout:true,
  params:[{n:'op',t:'select',opts:Object.keys(LG_LOGIC),d:'AND',label:'operation'}, LG_INPUTS],
  init:n=>{ n.v=0; },
  process(n,I){
    const b=lgVals(n,I).filter(v=>v!==null).map(lgOn);   // неподключённые входы игнорируются
    const r=b.length && LG_LOGIC[n.p.op](b) ? 1 : 0;
    n.v=r; return {out:r, not:1-r}; },
  draw(n){ lgReadout(n,n.v?'1':'0'); }
});

/* ---------- Select ---------- */
def({ id:'nsel', title:'Select', cat:'Control',
  ins:n=>lgIns(n), outs:[{n:'out',t:'num'}], readout:true,
  params:[LG_INPUTS, {n:'sel',t:'num',d:0,label:'index'}],
  init:n=>{ n.v=0; n.i=0; },
  process(n,I){
    const K=+n.p.inputs||2;
    n.i=clamp(Math.floor(+n.p.sel||0),0,K-1);
    const v=I['in'+(n.i+1)];
    n.v=typeof v==='number' && isFinite(v) ? v : 0;
    return {out:n.v}; },
  draw(n){ lgReadout(n,'in'+(n.i+1)+' → '+lgFmt(n.v)); }
});

/* ---------- Flip-Flop ---------- */
def({ id:'nflip', title:'Flip-Flop', cat:'Control',
  ins:[{n:'set',t:'num'},{n:'reset',t:'num'},{n:'clk',t:'num'}], outs:[{n:'out',t:'num'},{n:'not',t:'num'}],
  readout:true,
  params:[{n:'prio',t:'select',opts:['reset','set'],d:'reset',label:'both at once'},
          {n:'start',t:'check',d:false,label:'start on'},
          {n:'tog',t:'button',label:'Toggle',fn:n=>{ n.q=!n.q; }}],
  init:n=>{ n.lg={}; n.q=!!n.p.start; },
  process(n,I){
    const s=lgEdge(n,'s',I.set), r=lgEdge(n,'r',I.reset), c=lgEdge(n,'c',I.clk);
    if(c) n.q=!n.q;
    if(s && r) n.q=n.p.prio==='set'; else if(s) n.q=true; else if(r) n.q=false;
    return {out:n.q?1:0, not:n.q?0:1}; },
  draw(n){ lgReadout(n,n.q?'ON':'off'); }
});

/* ---------- Sample & Hold ---------- */
def({ id:'nhold', title:'Sample & Hold', cat:'Control',
  ins:[{n:'in',t:'num'},{n:'trig',t:'num'}], outs:[{n:'out',t:'num'}], readout:true,
  params:[{n:'mode',t:'select',opts:['sample on edge','track while high'],d:'sample on edge'}],
  init:n=>{ n.lg={}; n.v=0; },
  process(n,I){
    const x=typeof I.in==='number' && isFinite(I.in) ? I.in : null, e=lgEdge(n,'t',I.trig);
    if(x!==null && (n.p.mode==='sample on edge' ? e : lgOn(I.trig))) n.v=x;
    return {out:n.v}; },
  draw(n){ lgReadout(n,lgFmt(n.v)); }
});

/* ---------- Counter / Divider ---------- */
def({ id:'ncount', title:'Counter', cat:'Control',
  ins:[{n:'clk',t:'num'},{n:'reset',t:'num'}],
  outs:[{n:'count',t:'num'},{n:'wrap',t:'num'},{n:'phase',t:'num'}], readout:true,
  params:[{n:'mod',t:'num',d:4,label:'modulo'},
          {n:'step',t:'num',d:1},{n:'start',t:'num',d:0},
          {n:'rst',t:'button',label:'Reset',fn:n=>{ n.c=+n.p.start||0; }}],
  init:n=>{ n.lg={}; n.c=+n.p.start||0; },
  process(n,I){
    const m=Math.abs(+n.p.mod||0);
    let wrap=0;
    if(lgEdge(n,'r',I.reset)) n.c=+n.p.start||0;
    if(lgEdge(n,'c',I.clk)){
      n.c+=+n.p.step||0;
      if(m>0 && n.c>=m){ n.c%=m; wrap=1; } }
    return {count:n.c, wrap, phase:m>0 ? n.c/m : 0}; },
  draw(n){ lgReadout(n,lgFmt(n.c)+(+n.p.mod ? ' / '+n.p.mod : '')); }
});

/* ---------- One-Shot (задержка и длительность) ---------- */
def({ id:'nshot', title:'One-Shot', cat:'Control',
  ins:[{n:'trig',t:'num'}], outs:[{n:'gate',t:'num'},{n:'end',t:'num'}], readout:true,
  params:[{n:'delay',t:'range',min:0,max:60,step:.01,d:0,label:'delay, s'},
          {n:'width',t:'range',min:0,max:60,step:.01,d:1,label:'width, s'},
          {n:'retrig',t:'check',d:true,label:'retrigger'}],
  init:n=>{ n.lg={}; n.t=0; n.t0=0; n.t1=0; n.act=false; },
  process(n,I){
    const dt=BLOCK/Eng.sr; n.t+=dt;
    if(lgEdge(n,'t',I.trig) && (n.p.retrig || !n.act)){
      n.act=true; n.t0=n.t+n.p.delay; n.t1=n.t0+Math.max(n.p.width,dt); }
    let gate=0, end=0;
    if(n.act){
      if(n.t>=n.t1){ n.act=false; end=1; }
      else if(n.t>=n.t0) gate=1; }
    n.g=gate; return {gate, end}; },
  draw(n){ lgReadout(n,n.act ? (n.g ? 'ON' : 'waiting') : 'idle'); }
});
