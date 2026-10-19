"use strict";
/* ============================ Signal Analyzer: узел ============================
   Как Universal Radio Hacker: захват IQ (или сигнала) → демодуляция → сообщения, символы и биты прямо на осциллограмме
   (полосы сообщений — как bands на спектре), таблица сообщений (bin / hex / ascii) с выравниванием по синхрословам,
   метки полей. Выходы: blk (биты сообщений), rec (сообщения и поля), bin / text (выбранное сообщение).
   Ядро — siglab-kernels.js. */

const SL_Q=(document.currentScript?.src||'').replace(/^[^?]*/,'');
const SL_COL=['#5fb8d1','#e0875f','#7fd17f','#d18ad1','#e0b050','#6fd0c0','#e07fb0','#b4d455'];
const SL_AXH=14, SL_OVH=22, SL_B=64;
const slFmtT=t=>{ const a=Math.abs(t);
  return a>=1 ? t.toFixed(a>=10 ? 2 : 3)+' s' : a>=1e-3 ? (t*1e3).toFixed(a>=.01 ? 2 : 3)+' ms' : (t*1e6).toFixed(a>=1e-5 ? 1 : 2)+' µs'; };
const slFmtV=v=>{ const a=Math.abs(v);
  return a>=1e6 ? (v/1e6).toFixed(2)+'M' : a>=1e3 ? (v/1e3).toFixed(2)+'k' : a>=10 ? v.toFixed(1) : a>=.01 ? v.toFixed(3) : v.toExponential(1); };
const slEsc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

def({ id:'sigLab', title:'Signal Analyzer', cat:'Analysis', lazy:'manual', view:{h:230}, resize:true, w:620,
  kw:'urh universal radio hacker signal analysis bits symbols demodulate ook ask fsk psk manchester protocol reverse engineering packet baud decode unknown waveform oscilloscope',
  ins:[{n:'iq',t:'iq'},{n:'in',t:'sig'},{n:'go',t:'num'}],
  outs:[{n:'blk',t:'blk'},{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'text',t:'txt'},{n:'baud',t:'num'},{n:'count',t:'num'}],
  params:[
    {n:'mod',t:'select',opts:['auto','ASK','FSK','PSK','raw'],d:'auto',label:'modulation (auto — from the signal; ASK includes OOK; raw — the input is already demodulated data, e.g. NFM audio of an FSK transmission)'},
    {n:'levels',t:'select',opts:['2','4'],d:'2',label:'symbol levels (2 — a bit per symbol, 4 — a dibit)'},
    {n:'code',t:'select',opts:['auto',...SL_CODES],d:'auto',label:'line code of the bits (auto: Manchester when the pairs show it, else NRZ)'},
    {n:'inv',t:'check',d:false,label:'invert'},
    {n:'mode',t:'select',opts:['rolling','single','trigger'],d:'rolling',label:'capture: rolling window, one buffer, or one buffer on a level'},
    {n:'secs',t:'range',min:.1,max:30,step:.1,d:2,log:true,label:'capture length, s'},
    {n:'run',t:'button',label:'Run / Stop',fn:n=>slRunStop(n)},
    {n:'ana',t:'button',label:'Analyse',fn:n=>{ n.forceAna=true; }},
    {n:'clr',t:'button',label:'Clear',fn:n=>slClear(n)},
    {n:'lock',t:'button',label:'Lock baud',fn:n=>{ if(n.R?.baud){ setMod(n,'baud',Math.round(n.R.baud)); setMod(n,'auto',false); n.forceAna=true; } }},
    {n:'auto',t:'check',d:true,label:'find noise level, centre and baud by itself',adv:true},
    {n:'baud',t:'num',d:0,label:'symbol rate, Bd (0 — search; used when "find by itself" is off or locked)',adv:true},
    {n:'noise',t:'num',d:0,label:'noise level (signal amplitude), drag the line on the plot',adv:true},
    {n:'center',t:'num',d:0,label:'decision level of the demodulated signal, drag the line on the plot',adv:true},
    {n:'pause',t:'range',min:0,max:64,step:1,d:0,label:'pause between messages, symbols (0 — from the gaps)',adv:true},
    {n:'minBits',t:'range',min:4,max:128,step:1,d:8,label:'shortest message, symbols',adv:true},
    {n:'split',t:'text',d:'',label:'cut long messages into frames at this sync word (hex; auto — find a repeating word; empty — off)',adv:true},
    {n:'perMsg',t:'check',d:true,label:'own symbol rate for a message that differs from the rest (mixed protocols)',adv:true},
    {n:'gray',t:'check',d:false,label:'Gray code for 4 levels',adv:true},
    {n:'lsb',t:'check',d:false,label:'bytes: least significant bit first',adv:true},
    {n:'align',t:'select',opts:['sync','start'],d:'sync',label:'align messages in the table',adv:true},
    {n:'lanes',t:'select',opts:['both','demod','magnitude'],d:'both',label:'plot',adv:true},
    {n:'refresh',t:'range',min:.5,max:10,step:.5,d:2,label:'rolling: analyse every, s',adv:true},
    {n:'trig',t:'range',min:-80,max:0,step:1,d:-30,label:'trigger level, dBFS',adv:true},
    {n:'maxS',t:'num',d:4000000,label:'samples kept at most',adv:true},
    {n:'fmt',t:'text',d:'bin',hidden:true},
    {n:'labels',t:'text',d:'[]',hidden:true}],
  init:n=>{ n.cap=null; n.R=null; n.run=true; n.sel=-1; n.vx=null; n.hover=null; n.range=null; n.bsel=null;
    n.seen=new Set(); n.qBlk=[]; n.qRec=[]; n.oBin=null; n.oText=null; n.cost=0; n.tA=0; n.anaW=-1; n.forceAna=false;
    n.prevGo=0; n.trigAt=-1; n.armed=true; n.fid=0; n.labels=[]; n.labSrc=null; n.tableDirty=true; n.ui=null;
    n.sw=null; n.busy=0; n.again=false; n.jobId=0; },
  dispose:n=>{ if(n.sw){ n.sw.terminate(); n.sw=null; } n.cap=null; n.R=null; },
  process(n,I){
    const P=n.p, s=iqIn(I,'iq');
    let sr=0, cplx=false, chunks=null;
    if(s && s.sr){ sr=s.sr; cplx=true; chunks=s.chunks; }
    else if(I.in && I.in.length){ sr=Eng.sr; chunks=[{re:I.in}]; }
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    if(rise){ if(P.mode==='rolling') n.forceAna=true; else slRunStop(n,true); }
    if(sr && (!n.cap || n.cap.sr!==sr || n.cap.cplx!==cplx || (n.run && n.cap.L!==Math.max(1024,Math.min(Math.round(P.secs*sr),(P.maxS|0)||4000000))))) slCapInit(n,sr,cplx);
    const c=n.cap;
    if(n._mode!==P.mode){ const first=n._mode===undefined; n._mode=P.mode; if(!first && c && P.mode!=='rolling') slRunStop(n,true); }      // новый буфер для single / trigger
    if(c && !n.R && performance.now()-(n._rt||0)>250){ n._rt=performance.now(); redraw(n); }      // ход первого захвата
    if(c && n.run && chunks){
      for(const ch of chunks){
        const re=ch.re, im=cplx ? iqChunkIm(ch) : null, N=re.length;
        if(!N) continue;
        if(P.mode==='trigger' && n.armed){
          let pk=0; for(let i=0;i<N;i+=4){ const v=cplx ? re[i]*re[i]+im[i]*im[i] : re[i]*re[i]; if(v>pk) pk=v; }
          if(10*Math.log10(pk+1e-20)>=+P.trig){ n.armed=false; n.trigAt=c.w; }
        }
        slCapPush(n,re,im);
      }
      if(P.mode==='single' && c.w>=c.L) slFreeze(n);
      else if(P.mode==='trigger' && !n.armed && c.w>=n.trigAt+Math.round(.85*c.L)) slFreeze(n);
    }
    if(c){
      n.tA+=BLOCK/Eng.sr;
      const every=Math.max(+P.refresh,n.cost*(n.sw ? 2 : 8)/1000);
      if(n.forceAna || (n.run && P.mode==='rolling' && n.tA>=every && c.w!==n.anaW)){ n.forceAna=false; n.tA=0; slAnalyze_(n); }
    }
    const cfgK=[P.mod,P.levels,P.code,P.inv,P.pause,P.minBits,P.split,P.gray,P.perMsg,P.auto,P.baud,P.noise,P.center,P.align,P.lsb].join('|');
    if(n.cfgK!==cfgK){ n.cfgK=cfgK; if(c && c.w>0) n.forceAna=true; }
    const o={blk:n.qBlk.length ? n.qBlk.shift() : null, rec:n.qRec.length ? n.qRec.splice(0) : null,
      bin:n.oBin, text:n.oText, baud:n.R ? n.R.baud : 0, count:n.R ? n.R.msgs.length : 0};
    return o; },
  draw(n,cv,cx){
    if(!n.ui && n.el) slInitUI(n);
    slWire(n,cv);
    slLabelsSync(n);
    slPaint(n,cv,cx);
    if(n.ui){ slInfo(n); if(n.tableDirty && performance.now()-(n.tableT||0)>150){ n.tableDirty=false; n.tableT=performance.now(); slRenderTable(n); } }
  } });

/* ---------- захват ---------- */
function slCapInit(n,sr,cplx){
  const L=Math.max(1024,Math.min(Math.round(n.p.secs*sr),(n.p.maxS|0)||4000000));
  n.cap={sr,L,re:new Float32Array(L),im:cplx ? new Float32Array(L) : null,w:0,cplx,ep:(n.cap?n.cap.ep:0)+1};
  n.R=null; n.sel=-1; n.vx=null; n.range=null; n.bsel=null; n.seen.clear(); n.anaW=-1; n.armed=true; n.trigAt=-1;
  n.tableDirty=true; redraw(n);
}
function slCapPush(n,re,im){
  const c=n.cap, L=c.L;
  let N=re.length, i=0;
  if(N>L){ i=N-L; N=L; c.w+=i; }                           // длиннее кольца — пишем только хвост
  let k0=i;
  while(k0<re.length){
    const p=c.w%L, k=Math.min(re.length-k0,L-p);
    c.re.set(re.subarray(k0,k0+k),p);
    if(c.im){ if(im) c.im.set(im.subarray(k0,k0+k),p); else c.im.fill(0,p,p+k); }
    c.w+=k; k0+=k;
  }
}
function slCapLinear(n){
  const c=n.cap, N=Math.min(c.w,c.L);
  if(c.w<=c.L) return {re:c.re.subarray(0,N),im:c.im ? c.im.subarray(0,N) : null,N,abs0:0};
  const p=c.w%c.L, re=new Float32Array(N), im=c.im ? new Float32Array(N) : null;
  re.set(c.re.subarray(p),0); re.set(c.re.subarray(0,p),c.L-p);
  if(im){ im.set(c.im.subarray(p),0); im.set(c.im.subarray(0,p),c.L-p); }
  return {re,im,N,abs0:c.w-N};
}
function slFreeze(n){ n.run=false; n.forceAna=true; redraw(n); }
function slRunStop(n,arm){
  if(arm || !n.run){
    if(n.p.mode!=='rolling' && n.cap) slCapInit(n,n.cap.sr,n.cap.cplx);
    n.run=true;
  } else n.run=false;
  redraw(n);
}
function slClear(n){ if(n.cap) slCapInit(n,n.cap.sr,n.cap.cplx); n.qBlk=[]; n.qRec=[]; n.oBin=null; n.oText=null; redraw(n); }

/* ---------- разбор ---------- */
// считается в воркере; нет воркера (file://, политика) — в главном потоке
function slAnalyze_(n){
  const c=n.cap, P=n.p;
  if(!c || c.w<256) return;
  if(n.busy){ n.again=true; return; }
  const lin=slCapLinear(n);
  const cfg={mod:P.mod,levels:+P.levels,gray:P.gray,code:P.code,inv:P.inv,pause:+P.pause,minBits:+P.minBits,
    auto:P.auto,noise:+P.noise,center:+P.center,baud:+P.baud,perMsg:P.perMsg,split:P.split};
  if(n.sw===null && typeof Worker!=='undefined'){
    try{
      const w=new Worker('siglab-worker.js'+SL_Q);
      w.onmessage=e=>slResult(n,e.data);
      w.onerror=e=>{ e.preventDefault?.(); console.warn('[sigLab] воркер недоступен, разбор в главном потоке:',e.message); if(n.sw){ n.sw.terminate(); } n.sw=false; n.busy=0; n.forceAna=true; };
      n.sw=w;
    }catch(e){ n.sw=false; }
  }
  const job={abs0:lin.abs0,N:lin.N,ep:c.ep};
  if(n.sw){
    job.id=++n.jobId; n.job=job; n.busy=1;
    const re=lin.re.slice(), im=lin.im ? lin.im.slice() : null;
    n.sw.postMessage({id:job.id,re,im,sr:c.sr,cfg},im ? [re.buffer,im.buffer] : [re.buffer]);
    return;
  }
  let R;
  try{ R=slAnalyzeFull(lin.re,lin.im,c.sr,cfg); }catch(e){ n.err=e; console.error('[sigLab]',e); return; }
  slApply(n,R,job);
}
function slResult(n,m){
  n.busy=0;
  if(m.err){ n.err=new Error(m.err); console.error('[sigLab]',m.err); }
  else if(n.job && m.id===n.job.id && n.cap && n.cap.ep===n.job.ep) slApply(n,m.R,n.job);
  if(n.again){ n.again=false; n.forceAna=true; }
}
function slApply(n,R,job){
  n.cost=R.cost; n.anaW=n.cap ? n.cap.w : 0;
  R.abs0=job.abs0; R.N=job.N;
  const was=n.R && n.R.msgs[n.sel] ? n.R.abs0+n.R.msgs[n.sel].a : null;       // выбранное сообщение остаётся тем же, пока оно в окне
  n.R=R; n.pyrM=R.pyrM||null; n.pyrD=R.pyrD||null;
  if(was!==null){
    let bi=-1, bd=R.sr*.002;
    R.msgs.forEach((m,i)=>{ const d=Math.abs(R.abs0+m.a-was); if(d<bd){ bd=d; bi=i; } });
    n.sel=bi;
  }
  if(n.sel>=R.msgs.length) n.sel=R.msgs.length-1;
  if(n.sel<0 && R.msgs.length) n.sel=R.msgs.length-1;
  slDerive(n);
  slEmit(n);
  n.tableDirty=true; redraw(n);
}
function slDerive(n){
  const R=n.R;
  const L=R.msgs.map(m=>m.bits);
  let al=null;
  const sg=R.sync;
  if(n.p.align==='sync' && sg && sg.len>=8) al=slAlign(L,sg.word.slice(0,Math.min(sg.len,32)),1);
  n.alMode=al ? 'sync' : 'start';
  n.off=al ? al.map(a=>a.hit ? a.off : 0) : L.map(()=>0);
  const col=slColumns(L,n.off);
  n.P=col.P; n.same=col.same;
  n.maxLen=Math.max(0,...L.map((b,i)=>b.length-n.off[i]));
}
// сообщение → rec / blk для выходов; повторы в скользящем окне отсекаются по абсолютной позиции
function slEmit(n){
  const R=n.R, sr=R.sr, lsb=n.p.lsb;
  if(n.seen.size>4000) n.seen.clear();
  const fields=n.labels.filter(l=>l.al===n.alMode);
  R.msgs.forEach((m,i)=>{
    const key=Math.round((R.abs0+m.a)/(sr*.0005));
    if(n.seen.has(key)) return;
    // скользящее окно: сообщение на краях может быть неполным — ждём, пока оно уйдёт от края
    if(n.run && n.p.mode==='rolling' && (R.N-m.b<R.gap*(m.T||R.T) || (R.abs0>0 && m.a<2*(m.T||R.T)))) return;
    n.seen.add(key);
    const hex=slHex(m.bits,0,m.bits.length,lsb), id=++n.fid;
    const rec={t:Date.now(),src:'SigLab',kind:'msg',id,n:m.bits.length,hex,bin:slBin(m.bits,0,Math.min(m.bits.length,1024)),
      text:slAscii(m.bits,0,m.bits.length,lsb),baud:Math.round(R.baud),mod:R.mod,start:(R.abs0+m.a)/sr,dur:m.dur};
    for(const f of fields){ const v=slField(m.bits,f.from+n.off[i],f.len,lsb); if(v!==null) rec[f.name.replace(/\W+/g,'_')]=v; }
    n.qRec.push(rec);
    const d=new Float32Array(m.bits.length); for(let k=0;k<d.length;k++) d[k]=m.bits[k] ? 1 : -1;
    n.qBlk.push({d,n:d.length,id});
    if(n.qBlk.length>64) n.qBlk.shift();
    if(n.qRec.length>256) n.qRec.splice(0,n.qRec.length-256);
  });
  slSelOut(n);
}
function slSelOut(n){
  const R=n.R, m=R && R.msgs[n.sel];
  if(!m){ return; }
  const bytes=Uint8Array.from(slBytes(m.bits,0,m.bits.length,n.p.lsb));
  if(n.oText!==slHex(m.bits,0,m.bits.length,n.p.lsb)) n.oBin=typeof binObj==='function' ? binObj(bytes,'sigLab-'+(n.sel+1)+'.bin','application/octet-stream') : {d:bytes,name:'',mime:'',id:++n.fid};
  n.oText=slHex(m.bits,0,m.bits.length,n.p.lsb);
}

/* ---------- метки полей ---------- */
// хранятся в скрытом параметре JSON: [{name, from, len, al}], from — бит от начала синхрослова (или сообщения)
function slLabelsSync(n){
  if(n.labSrc===n.p.labels) return;
  n.labSrc=n.p.labels;
  try{ const a=JSON.parse(n.p.labels||'[]'); n.labels=Array.isArray(a) ? a.filter(l=>l && typeof l.name==='string' && l.len>0) : []; }catch(e){ n.labels=[]; }
}
function slLabelsSave(n){ n.p.labels=n.labSrc=JSON.stringify(n.labels); n.tableDirty=true; redraw(n); }

/* ---------- геометрия осциллограммы ---------- */
function slView(n){
  const R=n.R, N=R ? R.N : 0;
  if(!n.vx || !R) return [0,N];
  let a=n.vx[0]-R.abs0, b=n.vx[1]-R.abs0;
  if(b<=0 || a>=N){ n.vx=null; return [0,N]; }
  return [Math.max(0,a),Math.min(N,Math.max(b,a+16))];
}
function slSetView(n,a,b){
  const R=n.R; if(!R) return;
  const N=R.N, span=Math.max(16,Math.min(N,b-a));
  a=Math.max(0,Math.min(a,N-span));
  n.vx=(a<=0 && a+span>=N) ? null : [R.abs0+a,R.abs0+a+span];
  redraw(n);
}
function slLanes(n,H){
  const R=n.R, top=SL_AXH, bot=H-SL_OVH-2, h=bot-top;
  const both=n.p.lanes==='both' && R && R.mod!=='ASK';
  const strip=Math.min(46,h*.35);                                 // место под полосы символов, бит и полей
  if(both){ const mh=Math.round(h*.3); return {mag:[top,top+mh-2],dem:[top+mh,bot],strip,top,bot}; }
  const onlyMag=n.p.lanes==='magnitude' || (R && R.mod==='ASK');
  return onlyMag ? {mag:[top,bot],dem:null,strip,top,bot} : {mag:null,dem:[top,bot],strip,top,bot};
}
const slNice=x=>{ const e=Math.pow(10,Math.floor(Math.log10(x))), f=x/e; return (f<1.5?1:f<3.5?2:f<7.5?5:10)*e; };

/* ---------- отрисовка ---------- */
function slPaint(n,cv,cx){
  const W=cv.width, H=cv.height, R=n.R, c=n.cap;
  const bg=themeColor('--screen'), txt=themeColor('--scr-txt')||themeColor('--txt'), grid=themeColor('--grid'), axis=themeColor('--axis');
  const acc=themeColor('--acc'), acc2=themeColor('--screen-fg')||themeColor('--acc2'), bad=themeColor('--scr-bad')||themeColor('--err');
  cx.clearRect(0,0,W,H); cx.fillStyle=bg; cx.fillRect(0,0,W,H);
  cx.font='9px monospace'; cx.textBaseline='alphabetic';
  if(!R || !R.mag){
    cx.fillStyle=txt;
    const st=!c ? 'wire an iq or signal source' : c.w<256 ? 'capturing… '+c.w+' / '+c.L : R && R.err ? R.err : 'analysing…';
    cx.fillText(st,8,16);
    if(c){ cx.fillStyle=grid; cx.fillRect(8,24,W-16,6); cx.fillStyle=acc; cx.fillRect(8,24,(W-16)*Math.min(1,c.w/c.L),6); }
    if(R && R.err && c && c.w>=256){ cx.fillStyle=bad; cx.fillText(R.err,8,48); }
    n._geo=null; return;
  }
  const sr=R.sr, N=R.N, [v0,v1]=slView(n), span=v1-v0, L=slLanes(n,H);
  const X=s=>(s-v0)/span*W, S=x=>v0+x/W*span;
  n._geo={W,H,v0,v1,span,L,X,S};
  // сетка времени
  const step=slNice(span/sr/Math.max(2,W/90));
  cx.strokeStyle=grid; cx.fillStyle=axis; cx.lineWidth=1;
  const t0=Math.ceil((v0/sr)/step)*step;
  cx.beginPath();
  for(let t=t0;t*sr<v1;t+=step){ const x=Math.round(X(t*sr))+.5; cx.moveTo(x,SL_AXH-3); cx.lineTo(x,H-SL_OVH); }
  cx.stroke();
  for(let t=t0;t*sr<v1;t+=step){ const x=Math.round(X(t*sr))+3; if(x>176) cx.fillText(slFmtT(t),x,10); }
  // линии оси и уровни
  const lane=(arr,pyr,ln,lo,hi,col)=>{
    const [y0,y1]=ln, Y=v=>y1-(Math.min(hi,Math.max(lo,v))-lo)/(hi-lo)*(y1-y0);
    cx.strokeStyle=grid; cx.beginPath(); cx.moveTo(0,y1+.5); cx.lineTo(W,y1+.5); cx.stroke();
    slTrace(cx,arr,pyr,v0,v1,W,Y,col);
    return Y;
  };
  let Ym=null, Yd=null;
  if(L.mag) Ym=lane(R.mag,n.pyrM,L.mag,0,R.magTop,acc2);
  if(L.dem){ const d=R.mod==='ASK' ? R.mag : R.dem;
    Yd=lane(d,R.mod==='ASK' ? n.pyrM : n.pyrD,L.dem,R.mod==='ASK' ? 0 : R.demLo,R.mod==='ASK' ? R.magTop : R.demHi,themeColor('--t-num')||acc); }
  n._Ym=Ym; n._Yd=Yd;
  // порог шума и центр
  cx.setLineDash([4,3]);
  if(Ym && R.noise>0 && isFinite(R.noise)){ const y=Math.round(Ym(R.noise))+.5; cx.strokeStyle=bad; cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke(); cx.fillStyle=bad; cx.fillText('noise '+slFmtV(R.noise),W-92,y-2); n._ny=y; } else n._ny=null;
  const cenLane=L.dem ? Yd : (R.mod==='ASK' ? Ym : null);
  if(cenLane && R.segs.length){
    cx.strokeStyle=acc; cx.fillStyle=acc;
    const cy=Math.round(cenLane(R.center))+.5; cx.beginPath(); cx.moveTo(0,cy); cx.lineTo(W,cy); cx.stroke(); cx.fillText('centre '+slFmtV(R.center),W-92,cy-2); n._cy=cy;
    if(R.thrs) for(const t of R.thrs){ const y=Math.round(cenLane(t))+.5; cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke(); }
  } else n._cy=null;
  cx.setLineDash([]);
  // сообщения: полосы (как bands на спектре), символы и биты
  const lanesTop=L.top, lanesBot=L.bot;
  R.msgs.forEach((m,i)=>{
    if(m.b<v0 || m.a>v1) return;
    const x0=X(m.a), x1=X(m.b), col=SL_COL[i%SL_COL.length], on=i===n.sel;
    cx.fillStyle=col+(on ? '33' : '1c'); cx.fillRect(x0,lanesTop,Math.max(1,x1-x0),lanesBot-lanesTop);
    cx.fillStyle=col+(on ? 'dd' : '88'); cx.fillRect(x0,lanesTop,Math.max(1,x1-x0),11);
    if(x1-x0>34){ cx.save(); cx.beginPath(); cx.rect(x0,lanesTop,x1-x0,11); cx.clip(); cx.fillStyle='#000'; cx.fillText('#'+(i+1)+' '+m.bits.length+' b',x0+3,lanesTop+9); cx.restore(); }
    if(on){ cx.strokeStyle=col; cx.lineWidth=1.5; cx.strokeRect(x0+.5,lanesTop+.5,Math.max(1,x1-x0-1),lanesBot-lanesTop-1); cx.lineWidth=1; }
    slPaintSymbols(n,cx,m,i,R,X,L,col,txt);
  });
  n._hit=R.msgs.map(m=>[X(m.a),X(m.b)]);
  // выделение диапазона
  if(n.range){
    const a=Math.min(...n.range)-R.abs0, b=Math.max(...n.range)-R.abs0;
    cx.fillStyle='rgba(255,255,255,.14)'; cx.fillRect(X(a),SL_AXH,X(b)-X(a),H-SL_OVH-SL_AXH);
    cx.strokeStyle=acc; cx.beginPath(); cx.moveTo(X(a)+.5,SL_AXH); cx.lineTo(X(a)+.5,H-SL_OVH); cx.moveTo(X(b)+.5,SL_AXH); cx.lineTo(X(b)+.5,H-SL_OVH); cx.stroke();
    const t=slFmtT((b-a)/sr)+(R.T>0 ? ' = '+((b-a)/R.T).toFixed(1)+' sym' : '');
    cx.fillStyle=acc; cx.fillText(t,Math.min(W-cx.measureText(t).width-4,X(a)+4),SL_AXH+22);
  }
  // курсор
  if(n.hover){
    const hx=n.hover.x; cx.strokeStyle=axis; cx.beginPath(); cx.moveTo(hx+.5,SL_AXH); cx.lineTo(hx+.5,H-SL_OVH); cx.stroke();
    const s=S(hx), line=[slFmtT(s/sr)];
    const mi=R.msgs.findIndex(m=>s>=m.a && s<=m.b);
    if(mi>=0){ const m=R.msgs[mi], k=Math.max(0,Math.min(m.n-1,m.bnd.findIndex((b,j)=>j+1<m.bnd.length && s>=b && s<m.bnd[j+1])));
      line.push('#'+(mi+1)+' sym '+k+' = '+m.sym[k]); }
    const T=line.join('  '), tw=cx.measureText(T).width;
    cx.fillStyle=bg+'e0'; cx.fillRect(Math.min(W-tw-8,hx+6),H-SL_OVH-14,tw+6,12);
    cx.fillStyle=txt; cx.fillText(T,Math.min(W-tw-5,hx+9),H-SL_OVH-5);
  }
  // обзор всего захвата
  const oy=H-SL_OVH+2, oh=SL_OVH-4;
  cx.fillStyle=themeColor('--scr-panel'); cx.fillRect(0,oy,W,oh);
  if(n.pyrM){
    const nb=n.pyrM.length/2;
    cx.strokeStyle=acc2+'aa'; cx.beginPath();
    for(let x=0;x<W;x++){
      const b0=Math.floor(x/W*nb), b1=Math.max(b0+1,Math.floor((x+1)/W*nb));
      let mx=0; for(let b=b0;b<b1&&b<nb;b++) if(n.pyrM[2*b+1]>mx) mx=n.pyrM[2*b+1];
      const h=Math.min(1,mx/R.magTop)*(oh-2);
      cx.moveTo(x+.5,oy+oh-1); cx.lineTo(x+.5,oy+oh-1-h);
    }
    cx.stroke();
  }
  R.msgs.forEach((m,i)=>{ cx.fillStyle=SL_COL[i%SL_COL.length]+(i===n.sel ? 'aa' : '55'); cx.fillRect(m.a/N*W,oy,Math.max(1,(m.b-m.a)/N*W),oh); });
  cx.strokeStyle=acc; cx.lineWidth=1.5; cx.strokeRect(v0/N*W+.5,oy+.5,Math.max(3,span/N*W-1),oh-1); cx.lineWidth=1;
  // состояние
  const info=[R.mod,(R.baud>=1000 ? (R.baud/1000).toFixed(3)+' kBd' : R.baud.toFixed(1)+' Bd'),R.msgs.length+' msg'];
  if(R.L>2) info.push(R.L+' levels');
  cx.fillStyle=n.run ? acc2 : bad; cx.fillText(n.run ? (n.p.mode==='trigger' && n.armed ? 'ARMED' : 'RUN') : 'STOP',4,10);
  cx.fillStyle=txt; cx.fillText(info.join(' · '),38,10);
}
// вид сигнала: огибающая min/max для плотных участков, ломаная — для растянутых
function slTrace(cx,x,pyr,v0,v1,W,Y,col){
  const spp=(v1-v0)/W;
  cx.strokeStyle=col; cx.lineWidth=1; cx.beginPath();
  if(spp<=1){
    const i0=Math.max(0,Math.floor(v0)-1), i1=Math.min(x.length-1,Math.ceil(v1)+1);
    for(let i=i0;i<=i1;i++){ const px=(i-v0)/spp, py=Y(x[i]); i===i0 ? cx.moveTo(px,py) : cx.lineTo(px,py); }
  } else if(spp>SL_B*2 && pyr){
    for(let px=0;px<W;px++){
      const b0=Math.floor((v0+px*spp)/SL_B), b1=Math.max(b0+1,Math.floor((v0+(px+1)*spp)/SL_B));
      let mn=Infinity, mx=-Infinity;
      for(let b=b0;b<b1 && 2*b+1<pyr.length;b++){ if(pyr[2*b]<mn) mn=pyr[2*b]; if(pyr[2*b+1]>mx) mx=pyr[2*b+1]; }
      if(mn>mx) continue;
      cx.moveTo(px+.5,Y(mn)); cx.lineTo(px+.5,Y(mx));
    }
  } else {
    for(let px=0;px<W;px++){
      const i0=Math.max(0,Math.floor(v0+px*spp)), i1=Math.min(x.length,Math.max(i0+1,Math.floor(v0+(px+1)*spp)));
      let mn=x[i0], mx=mn;
      for(let i=i0+1;i<i1;i++){ const v=x[i]; if(v<mn) mn=v; else if(v>mx) mx=v; }
      px ? cx.lineTo(px+.5,Y(mn)) : cx.moveTo(px+.5,Y(mn)); cx.lineTo(px+.5,Y(mx));
    }
  }
  cx.stroke();
}
// символы, декодированные биты и метки полей под кривой
function slPaintSymbols(n,cx,m,mi,R,X,L,col,txt){
  const sy1=L.bot, sh=15, y0=sy1-sh;
  const T=m.T||R.T, px=T/((n._geo.span)/n._geo.W);
  if(px<2.5){                                              // слишком мелко: одна полоса сообщения
    cx.fillStyle=col+'66'; cx.fillRect(X(m.a),y0,Math.max(1,X(m.b)-X(m.a)),sh); return;
  }
  const k0=Math.max(0,m.bnd.findIndex(b=>X(b)>=-px)-1);
  const palette=R.L>2 ? ['#e05c5c','#e0b23c','#7fd17f','#5fb8d1'] : ['#555566','#e0b23c'];
  cx.font=(px>=18 ? '10px' : '9px')+' monospace';
  cx.textAlign='center';
  for(let k=k0;k<m.n;k++){
    const xa=X(m.bnd[k]), xb=X(m.bnd[k+1]);
    if(xa>n._geo.W) break;
    cx.fillStyle=palette[m.sym[k]]+'55'; cx.fillRect(xa+.5,y0,Math.max(.5,xb-xa-1),sh);
    if(px>=9){ cx.fillStyle=txt; cx.fillText(String(m.sym[k]),(xa+xb)/2,y0+sh-4); }
    if(px>=6){ cx.strokeStyle='rgba(128,128,128,.35)'; cx.beginPath(); cx.moveTo(Math.round(xa)+.5,L.top); cx.lineTo(Math.round(xa)+.5,sy1); cx.stroke(); }
  }
  // декодированные биты (когда код или уровни меняют разметку)
  const coded=R.code!=='NRZ' || R.L>2 || n.p.inv;
  const bps=R.L>2 ? 2 : 1, src=m.src;
  let y1=y0-1;
  if(coded && px>=5 && mi===n.sel){
    y1=y0-sh-1;
    cx.fillStyle=txt;
    for(let k=0;k<m.bits.length;k++){
      const s0=(src.start+k*src.step)/bps;
      const xa=X(m.bnd[Math.min(m.n,Math.max(0,Math.floor(s0)))]+(s0%1)*T), xb=X(m.bnd[Math.min(m.n,Math.max(0,Math.floor(s0)))]+(s0%1)*T+src.step/bps*T);
      if(xb<0) continue;
      if(xa>n._geo.W) break;
      cx.fillStyle=m.bits[k] ? 'rgba(78,201,176,.30)' : 'rgba(128,128,128,.22)';
      cx.fillRect(xa+.5,y1,Math.max(.5,xb-xa-1),sh);
      if(xb-xa>=9){ cx.fillStyle=txt; cx.fillText(String(m.bits[k]),(xa+xb)/2,y1+sh-4); }
    }
  }
  if(px>=5 && mi===n.sel){
    // метки полей
    const labs=n.labels.filter(l=>l.al===n.alMode);
    labs.forEach((l,j)=>{
      const b0=l.from+n.off[mi], b1=b0+l.len;
      if(b0<0 || b0>=m.bits.length) return;
      const s0=(m.src.start+b0*m.src.step)/bps, s1=(m.src.start+Math.min(b1,m.bits.length)*m.src.step)/bps;
      const f=s=>{ const i=Math.min(m.n,Math.max(0,Math.floor(s))); return X(m.bnd[i]+(s-i)*T); };
      const xa=f(s0), xb=f(s1), c=SL_COL[(j+3)%SL_COL.length];
      cx.fillStyle=c+'88'; cx.fillRect(xa,y1-12,Math.max(1,xb-xa),11);
      if(xb-xa>26){ cx.save(); cx.beginPath(); cx.rect(xa,y1-12,xb-xa,11); cx.clip(); cx.fillStyle='#000'; cx.fillText(l.name,(xa+xb)/2,y1-3); cx.restore(); }
    });
  }
  cx.textAlign='start'; cx.font='9px monospace';
}

/* ---------- мышь и касания ---------- */
function slWire(n,cv){
  if(n._wcv===cv) return; n._wcv=cv;
  const pos=ev=>{ const r=cv.getBoundingClientRect(); return [(ev.clientX-r.left)/r.width*cv.width,(ev.clientY-r.top)/r.height*cv.height]; };
  const ptr=new Map();
  let drag=null, pinch=null;
  cv.addEventListener('pointerdown',ev=>{
    const R=n.R, g=n._geo; if(!R || !g) return;
    ev.stopPropagation(); cv.setPointerCapture(ev.pointerId);
    const [x,y]=pos(ev); ptr.set(ev.pointerId,[x,y]);
    if(ptr.size===2){ const [a,b]=[...ptr.values()]; pinch={d:Math.hypot(a[0]-b[0],a[1]-b[1]),v:[g.v0,g.v1]}; drag=null; return; }
    if(y>g.H-SL_OVH){ drag={k:'ov'}; slOvTo(n,x); return; }
    if(n._ny!=null && Math.abs(y-n._ny)<5){ drag={k:'noise'}; return; }
    if(n._cy!=null && Math.abs(y-n._cy)<5){ drag={k:'center'}; return; }
    drag={k:ev.shiftKey || ev.ctrlKey ? 'range' : 'pan',x0:x,y0:y,v0:g.v0,v1:g.v1,moved:false};
    if(drag.k==='range'){ const s=R.abs0+g.S(x); n.range=[s,s]; }
  });
  cv.addEventListener('pointermove',ev=>{
    const g=n._geo, R=n.R; if(!g || !R) return;
    const [x,y]=pos(ev);
    if(ptr.has(ev.pointerId)) ptr.set(ev.pointerId,[x,y]);
    if(pinch && ptr.size===2){
      const [a,b]=[...ptr.values()], d=Math.hypot(a[0]-b[0],a[1]-b[1])||1, mid=(a[0]+b[0])/2/g.W;
      const span=(pinch.v[1]-pinch.v[0])*pinch.d/d, c=pinch.v[0]+(pinch.v[1]-pinch.v[0])*mid;
      slSetView(n,c-span*mid,c+span*(1-mid)); return;
    }
    if(drag){
      if(drag.k==='ov') slOvTo(n,x);
      else if(drag.k==='noise' && g.L.mag){ const [y0,y1]=g.L.mag, v=(y1-Math.min(y1,Math.max(y0,y)))/(y1-y0)*R.magTop; setMod(n,'auto',false); setMod(n,'noise',+v.toPrecision(4)); n.forceAna=true; }
      else if(drag.k==='center'){
        const ln=g.L.dem||g.L.mag, [y0,y1]=ln, lo=g.L.dem && R.mod!=='ASK' ? R.demLo : 0, hi=g.L.dem && R.mod!=='ASK' ? R.demHi : R.magTop;
        const v=lo+(y1-Math.min(y1,Math.max(y0,y)))/(y1-y0)*(hi-lo); setMod(n,'auto',false); setMod(n,'center',+v.toPrecision(5)); n.forceAna=true; }
      else if(drag.k==='range'){ n.range[1]=R.abs0+g.S(x); redraw(n); }
      else if(drag.k==='pan'){
        if(Math.abs(x-drag.x0)>3) drag.moved=true;
        const d=(x-drag.x0)/g.W*(drag.v1-drag.v0); slSetView(n,drag.v0-d,drag.v1-d);
      }
      return;
    }
    n.hover={x,y}; cv.style.cursor=(n._ny!=null && Math.abs(y-n._ny)<5) || (n._cy!=null && Math.abs(y-n._cy)<5) ? 'ns-resize' : '';
    redraw(n);
  });
  const end=ev=>{
    ptr.delete(ev.pointerId);
    if(ptr.size<2) pinch=null;
    const g=n._geo, R=n.R;
    if(drag && drag.k==='pan' && !drag.moved && g && R){                       // щелчок: выбрать сообщение под курсором
      const [x]=pos(ev), s=g.S(x), i=R.msgs.findIndex(m=>s>=m.a && s<=m.b);
      if(i>=0) slSelect(n,i,false);
    }
    if(drag && drag.k==='range' && n.range && Math.abs(n.range[1]-n.range[0])<3) n.range=null;
    if(drag && drag.k==='range') n.tableDirty=true;
    drag=null; redraw(n);
  };
  cv.addEventListener('pointerup',end); cv.addEventListener('pointercancel',end);
  cv.addEventListener('pointerleave',()=>{ n.hover=null; redraw(n); });
  cv.addEventListener('dblclick',ev=>{
    ev.stopPropagation();
    const g=n._geo, R=n.R; if(!g || !R) return;
    const [x]=pos(ev), s=g.S(x), i=R.msgs.findIndex(m=>s>=m.a && s<=m.b);
    if(i>=0 && (g.span>(R.msgs[i].b-R.msgs[i].a)*1.3 || g.span<(R.msgs[i].b-R.msgs[i].a)*.9)){ const m=R.msgs[i], p=(m.b-m.a)*.06; slSetView(n,m.a-p,m.b+p); slSelect(n,i,false); }
    else { n.vx=null; redraw(n); }
  });
  cv.addEventListener('wheel',ev=>{
    const g=n._geo, R=n.R; if(!g || !R) return;
    ev.preventDefault(); ev.stopPropagation();
    const [x]=pos(ev), f=ev.deltaY<0 ? .8 : 1.25, mid=x/g.W, c=g.v0+g.span*mid;
    if(ev.shiftKey){ const d=(ev.deltaY||ev.deltaX)/g.W*g.span*.5; slSetView(n,g.v0+d,g.v1+d); return; }
    const span=g.span*f;
    slSetView(n,c-span*mid,c+span*(1-mid));
  },{passive:false});
}
function slOvTo(n,x){
  const R=n.R, g=n._geo; if(!R || !g) return;
  const c=x/g.W*R.N, span=g.span;
  slSetView(n,c-span/2,c+span/2);
}
function slSelect(n,i,fromTable){
  n.sel=i; n.bsel=null; slSelOut(n); n.tableDirty=true; redraw(n);
  if(!fromTable && n.ui){ const row=n.ui.tbl.querySelector('.sl-row[data-i="'+i+'"]'); if(row) row.scrollIntoView({block:'nearest'}); }
}

/* ---------- интерфейс: таблица сообщений, метки ---------- */
function slInitUI(n){
  const mid=n.el.querySelector('.mid');
  if(!mid || mid.querySelector('.sl-ui')) return;
  const root=document.createElement('div'); root.className='sl-ui';
  root.innerHTML=`<div class="sl-bar"><span class="sl-info"></span>
      <span class="sl-fm"><button class="sl-btn" data-f="bin">bin</button><button class="sl-btn" data-f="hex">hex</button><button class="sl-btn" data-f="ascii">ascii</button></span>
      <button class="sl-btn sl-fit" title="show the whole capture">fit</button>
      <button class="sl-btn sl-copy" title="copy all messages in the shown format">copy</button></div>
    <div class="sl-rng"></div>
    <div class="sl-tbl" tabindex="0"></div>
    <div class="sl-sel"></div>
    <div class="sl-lab"></div>`;
  mid.append(root);
  root.style.height=Math.max(150,n.size.h*.9)+'px';
  const q=s=>root.querySelector(s);
  n.ui={root,info:q('.sl-info'),rng:q('.sl-rng'),tbl:q('.sl-tbl'),sel:q('.sl-sel'),lab:q('.sl-lab')};
  for(const ev of ['pointerdown','wheel','keydown','dblclick']) root.addEventListener(ev,e=>e.stopPropagation());
  q('.sl-fit').addEventListener('click',()=>{ n.vx=null; redraw(n); });
  q('.sl-copy').addEventListener('click',()=>{
    if(!n.R) return;
    const t=n.R.msgs.map((m,i)=>'#'+(i+1)+' '+slMsgText(n,m,n.p.fmt)).join('\n');
    try{ navigator.clipboard.writeText(t); }catch(e){}
  });
  q('.sl-fm').addEventListener('click',e=>{ const b=e.target.closest('[data-f]'); if(!b) return; n.p.fmt=b.dataset.f; n.bsel=null; n.tableDirty=true; redraw(n); });
  // таблица: выбор строки; в выбранной строке — протяжка по битам (байтам) для метки
  let down=null;
  n.ui.tbl.addEventListener('pointerdown',e=>{
    const row=e.target.closest('.sl-row'); if(!row) return;
    const i=+row.dataset.i, cell=e.target.closest('[data-u]');
    if(i!==n.sel){ slSelect(n,i,true); return; }
    if(!cell) return;
    down=+cell.dataset.u; n.bsel=[down,down]; slBselPaint(n);
    n.ui.tbl.setPointerCapture?.(e.pointerId);
  });
  n.ui.tbl.addEventListener('pointermove',e=>{
    if(down==null) return;
    const el=document.elementFromPoint(e.clientX,e.clientY), cell=el && el.closest && el.closest('[data-u]');
    if(cell){ n.bsel=[down,+cell.dataset.u]; slBselPaint(n); }
  });
  const up=()=>{ down=null; slSelLine(n); };
  n.ui.tbl.addEventListener('pointerup',up); n.ui.tbl.addEventListener('pointercancel',up);
  q('.sl-lab').addEventListener('click',e=>{
    const del=e.target.closest('[data-del]'), chip=e.target.closest('[data-lab]'), add=e.target.closest('.sl-add');
    if(del){ n.labels.splice(+del.dataset.del,1); slLabelsSave(n); return; }
    if(add){
      const nm=q('.sl-name').value.trim(), r=slBselBits(n);
      if(!nm || !r) return;
      n.labels.push({name:nm,from:r.from,len:r.len,al:n.alMode}); n.bsel=null; slLabelsSave(n); return;
    }
    if(chip){ const l=n.labels[+chip.dataset.lab]; if(l){ n.bsel=slLabelUnits(n,l); slBselPaint(n); slSelLine(n); } }
  });
  q('.sl-lab').addEventListener('keydown',e=>{ if(e.key==='Enter') q('.sl-add')?.click(); });
  q('.sl-rng').addEventListener('click',e=>{
    const b=e.target.closest('[data-act]'); if(!b || !n.range || !n.R) return;
    const lo=Math.min(...n.range), hi=Math.max(...n.range), k=Math.max(1,+q('.sl-rbits')?.value||1);
    setMod(n,'auto',false); setMod(n,'baud',+(n.R.sr*k/(hi-lo)).toFixed(3)); n.forceAna=true;
  });
  n.tableDirty=true;
}
function slInfo(n){
  const R=n.R, c=n.cap, u=n.ui;
  let t;
  if(!c) t='no input';
  else if(!R) t=c.w<256 ? 'capturing '+Math.round(100*c.w/c.L)+' %' : 'capturing…';
  else {
    t=R.err ? R.err : R.mod+' · '+(R.baud>=1000 ? (R.baud/1000).toFixed(3)+' kBd' : R.baud.toFixed(1)+' Bd')+' · '+R.msgs.length+' msg'
      +(R.code && R.code!=='NRZ' ? ' · '+R.code : '')+(R.conf>0 && R.conf<1 ? ' · conf '+Math.round(R.conf*100)+' %' : '')
      +(R.sync && R.sync.len ? ' · sync '+R.sync.hex+(R.sync.pre ? ' · preamble '+R.sync.pre+' b' : '') : R.sync && R.sync.pre ? ' · preamble '+R.sync.pre+' b' : '')
      +' · '+(c.cplx ? 'iq' : 'sig')+' '+(c.sr/1000).toFixed(c.sr>=1e5 ? 0 : 1)+' kS/s'+(n.cost ? ' · '+n.cost.toFixed(0)+' ms' : '');
  }
  if(u.info.textContent!==t) u.info.textContent=t;
  for(const b of u.root.querySelectorAll('[data-f]')) b.classList.toggle('on',b.dataset.f===n.p.fmt);
  const rg=n.range && n.R ? Math.abs(n.range[1]-n.range[0]) : 0;
  const rt=rg>2 ? '<span>selection '+slFmtT(rg/n.R.sr)+(n.R.T>0 ? ' = '+(rg/n.R.T).toFixed(2)+' sym' : '')+'</span> <span>it is</span> <input class="sl-rbits" type="number" min="1" value="1" title="symbols in the selection"> <span>symbol(s)</span> <button class="sl-btn" data-act="baud">set baud</button>' : '';
  if(u.rngH!==rt){ u.rngH=rt; if(rt && !u.rng.querySelector('.sl-rbits')) u.rng.innerHTML=rt; else if(!rt) u.rng.innerHTML=''; else u.rng.firstElementChild.textContent='selection '+slFmtT(rg/n.R.sr)+(n.R.T>0 ? ' = '+(rg/n.R.T).toFixed(2)+' sym' : ''); }
}

// текст сообщения в формате fmt
function slMsgText(n,m,fmt){
  const b=m.bits, lsb=n.p.lsb;
  return fmt==='hex' ? slHex(b,0,b.length,lsb).replace(/(..)/g,'$1 ').trim() : fmt==='ascii' ? slAscii(b,0,b.length,lsb) : slBin(b,0,b.length).replace(/(.{8})/g,'$1 ').trim();
}
// единицы выбора: биты (bin) или байты (hex, ascii) выровненной оси; u — номер бита от начала синхрослова (или сообщения)
const slUnit=n=>n.p.fmt==='bin' ? 1 : 8;
function slBselBits(n){
  if(!n.bsel || !n.R) return null;
  const u=slUnit(n), a=Math.min(...n.bsel), b=Math.max(...n.bsel);
  return {from:a*u,len:(b-a+1)*u};
}
function slLabelUnits(n,l){ const u=slUnit(n); return [Math.floor(l.from/u),Math.floor((l.from+l.len-1)/u)]; }
function slBselPaint(n){
  const r=n.bsel ? [Math.min(...n.bsel),Math.max(...n.bsel)] : null;
  for(const e of n.ui.tbl.querySelectorAll('.sl-row.on [data-u]')){ const u=+e.dataset.u; e.classList.toggle('sel',!!r && u>=r[0] && u<=r[1]); }
  slSelLine(n);
}
function slSelLine(n){
  const R=n.R, m=R && R.msgs[n.sel], el=n.ui.sel;
  const r=slBselBits(n);
  if(!m || !r){ el.textContent=m ? 'drag over bits of the selected message to mark a field' : ''; slLabForm(n); return; }
  const b0=r.from+n.off[n.sel], b1=Math.min(m.bits.length,b0+r.len);
  if(b0<0 || b0>=m.bits.length){ el.textContent='outside the message'; slLabForm(n); return; }
  const v=slField(m.bits,b0,b1-b0,n.p.lsb);
  el.textContent='bits '+r.from+'…'+(r.from+r.len-1)+' ('+(b1-b0)+') · '+slBin(m.bits,b0,Math.min(b1,b0+64))+' · hex '+slHex(m.bits,b0,b1,n.p.lsb)+(typeof v==='number' ? ' · dec '+v : '');
  slLabForm(n);
}
function slLabForm(n){
  const el=n.ui.lab, labs=n.labels, R=n.R;
  const chips=labs.map((l,j)=>{
    const m=R && R.msgs[n.sel], v=m ? slField(m.bits,l.from+n.off[n.sel],l.len,n.p.lsb) : null;
    return '<span class="sl-chip" data-lab="'+j+'" style="--c:'+SL_COL[(j+3)%SL_COL.length]+'">'+slEsc(l.name)+' <i>'+l.from+'+'+l.len+(l.al!==n.alMode ? ' ('+l.al+')' : '')+'</i>'+(v!=null ? ' = '+(typeof v==='number' ? v+' (0x'+v.toString(16).toUpperCase()+')' : v) : '')+' <b data-del="'+j+'" title="delete">×</b></span>';
  }).join('');
  const key=chips+'|'+(slBselBits(n)?1:0);
  if(el._k===key) return; el._k=key;
  const keep=el.querySelector('.sl-name')?.value||'';
  el.innerHTML=(n.bsel ? '<span class="sl-new"><input class="sl-name" placeholder="field name" spellcheck="false"><button class="sl-btn sl-add">add field</button></span>' : '')+chips;
  const nm=el.querySelector('.sl-name'); if(nm){ nm.value=keep; }
}

// таблица сообщений
function slRenderTable(n){
  const R=n.R, tbl=n.ui.tbl;
  if(!R || !R.msgs.length){ tbl.innerHTML='<div class="sl-empty">'+(R ? 'no messages — adjust the noise level or the symbol rate' : 'waiting for a capture…')+'</div>'; slSelLine(n); return; }
  const fmt=n.p.fmt, P=n.P, labs=n.labels.filter(l=>l.al===n.alMode), lsb=n.p.lsb;
  const key=[n.cfgK,fmt,lsb,n.sel,P,n.alMode,n.p.labels,R.msgs.map((m,i)=>Math.round((R.abs0+m.a)/R.sr*1e4)+'.'+m.bits.length+'.'+n.off[i]).join(',')].join('|');
  if(key===n.tblKey) return;
  n.tblKey=key;
  const same=n.same;
  const cap=Math.min(R.msgs.length,300), maxBits=Math.min(n.maxLen+P,fmt==='bin' ? 640 : 2048);
  const labAt=rel=>{ for(let j=0;j<labs.length;j++) if(rel>=labs[j].from && rel<labs[j].from+labs[j].len) return j; return -1; };
  const rows=[];
  // линейка: номера бит от начала синхрослова (сообщения) над группами по 8
  let ruler='';
  if(fmt==='bin'){
    let pos=0;
    for(let u=0;u<maxBits;u++){
      const rel=u-P, g=((rel%8)+8)%8===0;
      if(g){ const t=String(rel); ruler=ruler.padEnd(pos,' ')+t; }
      pos+=1+(((rel%8)+8)%8===7 ? 1 : 0);
    }
  } else {
    const k0=Math.floor(-P/8), k1=Math.ceil((maxBits-P)/8);
    for(let k=k0;k<k1;k++){ const t=String(k); ruler+=fmt==='hex' ? t.padEnd(3,' ') : (k%4===0 ? t.padEnd(4,' ') : ''); }
  }
  // байт k содержит биты rel 8k…8k+7
  for(let i=0;i<cap;i++){
    const m=R.msgs[i], off=n.off[i], sel=i===n.sel, bits=m.bits;
    let html='';
    const cell=(txt,u,rel0,rel1)=>{
      let diff=0, lab=-1;
      for(let r=rel0;r<=rel1;r++){ const col=r+P; if(col>=0 && col<same.length && !same[col]) diff=1; const j=labAt(r); if(j>=0 && lab<0) lab=j; }
      const cls='sl-d'+diff+(lab>=0 ? ' sl-l'+(lab%8) : '');
      return sel ? '<i data-u="'+u+'" class="'+cls+'">'+slEsc(txt)+'</i>' : '<i class="'+cls+'">'+slEsc(txt)+'</i>';
    };
    if(fmt==='bin'){
      for(let u=0;u<maxBits;u++){
        const rel=u-P, b=rel+off, sp=((rel%8)+8)%8===7;
        html+= b<0 || b>=bits.length ? ' ' : cell(bits[b],rel,rel,rel);
        if(sp) html+=' ';
      }
    } else {
      const k0=Math.floor(-P/8), k1=Math.ceil((maxBits-P)/8);
      for(let k=k0;k<k1;k++){
        const b0=8*k+off, full=b0>=0 && b0+8<=bits.length, part=b0+8>bits.length && b0<bits.length && b0>=0;
        if(!full && !part){ html+= fmt==='hex' ? '   ' : ' '; continue; }
        const v=slHexByte(bits,b0,lsb);
        const t=fmt==='hex' ? (v<16?'0':'')+v.toString(16).toUpperCase() : (v>=32&&v<127 ? String.fromCharCode(v) : '.');
        html+=cell(t,k,8*k,8*k+7)+(fmt==='hex' ? ' ' : '');
      }
    }
    rows.push('<div class="sl-row'+(sel?' on':'')+'" data-i="'+i+'" style="--c:'+SL_COL[i%SL_COL.length]+'"><span class="sl-id">#'+(i+1)+'</span><span class="sl-t">'+slFmtT(m.t+(R.abs0||0)/R.sr)+'</span><span class="sl-n">'+bits.length+'b'+(m.err ? ' !'+m.err : '')+(m.T && Math.abs(m.T/R.T-1)>.05 ? ' '+slFmtV(R.sr/m.T)+'Bd' : '')+'</span><span class="sl-dt">'+html+'</span></div>');
  }
  tbl.innerHTML='<div class="sl-row sl-ruler"><span class="sl-id"></span><span class="sl-t"></span><span class="sl-n"></span><span class="sl-dt">'+slEsc(ruler)+'</span></div>'+rows.join('')+(R.msgs.length>cap ? '<div class="sl-empty">… '+(R.msgs.length-cap)+' more</div>' : '');
  if(n.bsel) slBselPaint(n); else slSelLine(n);
  n.ui.lab._k=null; slLabForm(n);
}
