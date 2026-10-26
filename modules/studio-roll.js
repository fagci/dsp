"use strict";
/* ============================ STUDIO: PIANO ROLL ============================
   Канвас: клавиатура слева, линейка, сетка с нотами выбранного канала (остальные каналы паттерна — призраки), полоса громкостей.
   Рисование/перенос/растяжение мышью, рамка выделения, привязка к сетке и к строю, штамп аккордов, буфер обмена, запись с клавиатуры. */

let STU_CLIP=null;                       // буфер обмена нот: {notes:[{t,l,k,v}], len}

class StuRoll extends StuPanel{
  constructor(app){
    super(app,'roll'); const host=this.host=this.el; this.sel=new Set(); this.dirty=1; this.live_=new Set();
    this.x0=0; this.y0=84; this.zx=.5; this.zy=15; this.tool='draw'; this.root=0; this.scale='chromatic'; this.snapScale=false; this.chord='off';
    this.lastLen=ST_STEP; this.drag=null; this.cursorT=0; this.vel=true;
    this.KW=58; this.RH=20; this.VH=70;
    host.innerHTML=`<div class="stu-rt">
      <span class="stu-grp-t">Tool</span>
      <button class="stu-b on" data-tool="draw" title="Draw / move / resize notes. Right click: delete">✎ Draw</button>
      <button class="stu-b" data-tool="select" title="Box select">▭ Select</button>
      <button class="stu-b" data-tool="erase" title="Erase by dragging">⌫ Erase</button>
      <span class="stu-sep"></span>
      <label class="stu-f">Snap <select data-o="snap"><option value="96">1/4</option><option value="48">1/8</option><option value="24" selected>1/16</option><option value="12">1/32</option><option value="384">bar</option><option value="1">off</option></select></label>
      <label class="stu-f">Scale <select data-o="root"></select><select data-o="scale"></select></label>
      <label class="stu-f"><input type="checkbox" data-o="ss"> snap to scale</label>
      <label class="stu-f">Chord <select data-o="chord"><option>off</option></select></label>
      <span class="stu-sep"></span>
      <button class="stu-b" data-act="quant" title="Quantize selected (or all) notes to snap">Quantize</button>
      <button class="stu-b" data-act="fit" title="Fit view to notes">Fit</button>
      <button class="stu-b" data-act="len" title="Pattern length">Bars: <b data-r="bars">1</b></button>
      <button class="stu-b on" data-act="vel" title="Velocity lane">Vel</button>
      <span class="stu-dim" data-r="info"></span></div>
      <div class="stu-cw"><canvas></canvas></div>`;
    this.cv=host.querySelector('canvas'); this.wrap=host.querySelector('.stu-cw');
    const root=host.querySelector('[data-o=root]'), sc=host.querySelector('[data-o=scale]'), ch=host.querySelector('[data-o=chord]');
    ST_NAMES.forEach((n,i)=>root.append(new Option(n,i)));
    Object.keys(ST_SCALES).forEach(n=>sc.append(new Option(n,n)));
    Object.keys(ST_CHORDS).forEach(n=>ch.append(new Option(n,n)));
    host.addEventListener('click',ev=>{
      const t=ev.target.closest('[data-tool]'); if(t){ this.tool=t.dataset.tool; host.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('on',b===t)); return; }
      const a=ev.target.closest('[data-act]'); if(!a) return;
      if(a.dataset.act==='quant') this.quantize(); else if(a.dataset.act==='fit') this.fit();
      else if(a.dataset.act==='vel'){ this.vel=!this.vel; a.classList.toggle('on',this.vel); this.resize(); }
      else if(a.dataset.act==='len'){ const p=app.patObj(); if(!p) return; const n=Math.round(+prompt('Pattern length in bars (1–32)',p.bars)); if(n>=1&&n<=32){ p.bars=n; app.commit(); app.refreshAll(); } }
    });
    host.addEventListener('change',ev=>{
      const o=ev.target.dataset.o; if(!o) return;
      if(o==='snap') app.snap=+ev.target.value; else if(o==='root') this.root=+ev.target.value; else if(o==='scale') this.scale=ev.target.value;
      else if(o==='ss') this.snapScale=ev.target.checked; else if(o==='chord') this.chord=ev.target.value;
      this.dirty=1;
    });
    const cv=this.cv;
    cv.addEventListener('pointerdown',ev=>this.down(ev)); cv.addEventListener('pointermove',ev=>this.move(ev));
    cv.addEventListener('pointerup',ev=>this.up(ev)); cv.addEventListener('pointercancel',ev=>this.up(ev));
    cv.addEventListener('contextmenu',ev=>ev.preventDefault());
    cv.addEventListener('wheel',ev=>this.wheel(ev),{passive:false});
    this.ro=new ResizeObserver(()=>this.resize()); this.ro.observe(this.wrap);
  }
  refresh(){ this.dirty=1; }
  frame(){ if(this.dirty||this.app.eng.playing) this.draw(); }
  destroy(){ this.ro.disconnect(); super.destroy(); }
  /* ----- геометрия ----- */
  get gh(){ return this.H-this.RH-(this.vel?this.VH:0); }
  tx(t){ return this.KW+(t-this.x0)*this.zx; }
  xt(x){ return this.x0+(x-this.KW)/this.zx; }
  ky(k){ return this.RH+(this.y0-k-1)*this.zy; }
  yk(y){ return Math.floor(this.y0-(y-this.RH)/this.zy); }
  resize(){
    const w=this.wrap.clientWidth, h=this.wrap.clientHeight; if(!w||!h) return;
    const dpr=Math.min(2,window.devicePixelRatio||1); this.W=w; this.H=h;
    this.cv.width=w*dpr; this.cv.height=h*dpr; this.cv.style.width=w+'px'; this.cv.style.height=h+'px'; this.dpr=dpr; this.dirty=1;
  }
  fit(){
    const ch=this.app.chObj(), pat=this.app.patObj(); if(!ch||!pat) return;
    const ns=pat.notes[ch.id]||[];
    if(ns.length){ const lo=Math.min(...ns.map(n=>n.k)), hi=Math.max(...ns.map(n=>n.k)); this.y0=Math.min(127,hi+3); this.zy=stClamp(this.gh/(hi-lo+7),8,28); }
    else{ this.y0=ch.type==='drum'?66:ch.type==='sampler'?ch.p.root+12:84; this.zy=15; }
    this.x0=0; this.zx=stClamp((this.W-this.KW-10)/(stPatLen(pat)),.08,3); this.dirty=1;
  }
  live(k,on){ on?this.live_.add(k):this.live_.delete(k); this.dirty=1; }
  notes(){ const ch=this.app.chObj(), pat=this.app.patObj(); if(!ch||!pat) return []; return pat.notes[ch.id]||[]; }
  snapT(t,floor){ const s=this.app.snap; return floor?Math.floor(t/s)*s:Math.round(t/s)*s; }
  fixKey(k){ k=stClamp(Math.round(k),0,127); return this.snapScale&&this.scale!=='chromatic'?stClamp(stSnapScale(k,this.root,this.scale),0,127):k; }

  /* ----- рисование ----- */
  draw(){
    const cv=this.cv, c=cv.getContext('2d'); if(!this.W) { this.resize(); if(!this.W) return; }
    this.dirty=0; const app=this.app, ch=app.chObj(), pat=app.patObj(), W=this.W, H=this.H, KW=this.KW, RH=this.RH, gh=this.gh, dpr=this.dpr;
    c.setTransform(dpr,0,0,dpr,0,0);
    const bg='#0a0d0e', line='#2a3136', txt='#c8d2d6', dim='#929fa7', acc='#e0b23c';
    c.fillStyle=bg; c.fillRect(0,0,W,H);
    if(!ch||!pat){ c.fillStyle=dim; c.font='13px sans-serif'; c.fillText('Select a channel',KW+20,RH+30); return; }
    this.bars=pat.bars; const info=this.host.querySelector('[data-r=bars]'); if(info.textContent!=pat.bars) info.textContent=pat.bars;
    const L=stPatLen(pat), kTop=Math.min(127,Math.ceil(this.y0)), kBot=Math.max(0,Math.floor(this.y0-gh/this.zy));
    c.save(); c.beginPath(); c.rect(KW,RH,W-KW,gh); c.clip();
    // строки
    for(let k=kBot;k<=kTop;k++){
      const y=this.ky(k), inS=this.scale==='chromatic'||stInScale(k,this.root,this.scale), blk=stIsBlack(k);
      c.fillStyle=blk?(inS?'#12171a':'#0c0f11'):(inS?'#1a2125':'#11161a'); if(k%12===this.root && this.scale!=='chromatic') c.fillStyle='#262a1c';
      c.fillRect(KW,y,W-KW,this.zy);
      c.fillStyle=line; c.fillRect(KW,y+this.zy-1,W-KW,1);
    }
    // вертикальные линии
    const sn=app.snap, minPx=7;
    const tA=Math.floor(this.x0), tB=this.xt(W);
    let sub=ST_STEP/2; while(sub*this.zx<minPx && sub<ST_BAR) sub*=2;
    for(let t=Math.floor(tA/sub)*sub;t<=tB;t+=sub){
      const x=this.tx(t); if(x<KW) continue;
      const bar=t%ST_BAR===0, beat=t%ST_PPQ===0;
      c.fillStyle=bar?'#46515a':beat?'#2d363c':'#1f272c'; c.fillRect(Math.round(x),RH,1,gh);
    }
    // за концом паттерна
    const xe=this.tx(L); if(xe<W){ c.fillStyle='#0008'; c.fillRect(Math.max(KW,xe),RH,W,gh); c.fillStyle=acc; c.fillRect(Math.round(xe),RH,2,gh); }
    // призраки
    for(const o of app.P.channels){ if(o===ch) continue; const ns=pat.notes[o.id]; if(!ns) continue;
      c.fillStyle=o.color+'44'; for(const n of ns){ const x=this.tx(n.t), w=Math.max(2,n.l*this.zx);
        if(x+w<KW||x>W||n.k<kBot||n.k>kTop) continue; c.fillRect(x,this.ky(n.k)+2,w,this.zy-4); } }
    // ноты
    const ns=this.notes(); for(const s of [...this.sel]) if(!ns.includes(s)) this.sel.delete(s);
    c.font=Math.min(11,this.zy-3)+'px sans-serif'; c.textBaseline='middle';
    for(const n of ns){
      const x=this.tx(n.t), w=Math.max(3,n.l*this.zx-1);
      if(x+w<KW||x>W||n.k<kBot||n.k>kTop) continue;
      const y=this.ky(n.k), sel=this.sel.has(n);
      c.globalAlpha=.55+.45*n.v/127; c.fillStyle=ch.color; c.fillRect(x,y+1,w,this.zy-2);
      c.globalAlpha=1; c.fillStyle='#ffffff30'; c.fillRect(x,y+1,w,2);
      if(sel){ c.strokeStyle='#fff'; c.lineWidth=2; c.strokeRect(x+1,y+2,w-2,this.zy-4); }
      if(w>26 && this.zy>=11){ c.fillStyle='#000a'; c.fillText(stNoteName(n.k),x+4,y+this.zy/2+.5); }
    }
    c.restore();
    // рамка выделения
    const d=this.drag; if(d&&d.type==='box'){ c.strokeStyle='#fff'; c.setLineDash([4,3]); c.strokeRect(d.x0,d.y0,d.x1-d.x0,d.y1-d.y0); c.setLineDash([]); c.fillStyle='#ffffff18'; c.fillRect(d.x0,d.y0,d.x1-d.x0,d.y1-d.y0); }
    // клавиши
    c.save(); c.beginPath(); c.rect(0,RH,KW,gh); c.clip();
    for(let k=kBot;k<=kTop;k++){
      const y=this.ky(k), blk=stIsBlack(k), lv=this.live_.has(k);
      c.fillStyle=lv?acc:blk?'#16191b':'#d5dadd'; c.fillRect(0,y,blk?KW*.62:KW-1,this.zy);
      if(blk){ c.fillStyle='#1a1e20'; c.fillRect(KW*.62,y,KW*.38,this.zy); }
      c.fillStyle='#0004'; c.fillRect(0,y+this.zy-1,KW,1);
      if(k%12===0 || this.zy>=14){ c.fillStyle=blk?'#999':'#333'; c.font='10px sans-serif'; c.textBaseline='middle'; if(k%12===0||!blk) c.fillText(stNoteName(k),KW-26,y+this.zy/2); }
    }
    c.restore();
    // линейка
    c.fillStyle='#161a1d'; c.fillRect(0,0,W,RH); c.fillStyle=line; c.fillRect(0,RH-1,W,1);
    c.font='10px sans-serif'; c.textBaseline='middle'; c.fillStyle=txt;
    for(let t=Math.floor(tA/ST_BAR)*ST_BAR;t<=tB;t+=ST_BAR){ const x=this.tx(t); if(x<KW-2) continue; c.fillText(String(t/ST_BAR+1),x+3,RH/2); c.fillStyle='#46515a'; c.fillRect(Math.round(x),0,1,RH); c.fillStyle=txt; }
    c.fillStyle='#161a1d'; c.fillRect(0,0,KW,RH);
    // велосити
    if(this.vel){
      const y0=H-this.VH; c.fillStyle='#0c1012'; c.fillRect(0,y0,W,this.VH); c.fillStyle=line; c.fillRect(0,y0,W,1);
      c.fillStyle=dim; c.font='10px sans-serif'; c.fillText('velocity',6,y0+10);
      for(const n of ns){ const x=this.tx(n.t); if(x<KW||x>W) continue; const h=(this.VH-8)*n.v/127;
        c.fillStyle=this.sel.has(n)?'#fff':ch.color; c.fillRect(x,H-h-2,Math.max(3,Math.min(6,n.l*this.zx)),h); c.fillStyle=ch.color; c.fillRect(x-1,H-h-3,5,3); }
    }
    // позиция воспроизведения
    const ph=this.playTick();
    if(ph!=null){ const x=this.tx(ph); if(x>=KW&&x<=W){ c.fillStyle='#fff'; c.fillRect(Math.round(x),0,1,H-0); c.fillStyle=acc; c.beginPath(); c.moveTo(x-5,0); c.lineTo(x+5,0); c.lineTo(x,8); c.fill(); } }
  }
  playTick(){
    const app=this.app, t=app.tickHead; if(t==null) return null; const pat=app.patObj(); if(!pat) return null; const L=stPatLen(pat);
    if(app.mode==='pat') return t%L;
    for(const c of app.P.playlist.clips) if(c.kind==='pat' && c.pat===pat.id && t>=c.t && t<c.t+c.l) return (t-c.t)%L;
    return null;
  }

  /* ----- мышь ----- */
  pos(ev){ const r=this.cv.getBoundingClientRect(); return [ev.clientX-r.left,ev.clientY-r.top]; }
  hit(x,y){
    const ns=this.notes(); const k=this.yk(y), t=this.xt(x);
    for(let i=ns.length-1;i>=0;i--){ const n=ns[i]; if(n.k===k && t>=n.t && t<n.t+n.l){
      const x2=this.tx(n.t+n.l); return {n,edge:x>x2-Math.min(8,(x2-this.tx(n.t))*.4)}; } }
    return null;
  }
  down(ev){
    const app=this.app, ch=app.chObj(), pat=app.patObj(); if(!ch||!pat) return;
    this.cv.setPointerCapture(ev.pointerId); const [x,y]=this.pos(ev), KW=this.KW, RH=this.RH;
    if(ev.button===1){ this.drag={type:'pan',x,y,x0:this.x0,y0:this.y0}; return; }
    if(y<RH){ if(x>=KW && app.mode==='pat'){ app.seek(Math.max(0,this.snapT(this.xt(x),true))); } return; }
    if(x<KW){                                                                     // клавиатура: прослушивание
      const k=this.yk(y); this.drag={type:'key',k}; app.eng.noteOn(ch.id,k,100); this.live(k,1); return; }
    if(this.vel && y>this.H-this.VH){ this.drag={type:'vel'}; this.setVel(x,y,ev); return; }
    const h=this.hit(x,y), erase=ev.button===2||ev.altKey||this.tool==='erase';
    this.cursorT=this.snapT(this.xt(x),true);
    if(erase){ this.drag={type:'erase'}; if(h) this.del(h.n); return; }
    if(h){
      if(!this.sel.has(h.n)){ if(!ev.shiftKey) this.sel.clear(); this.sel.add(h.n); } else if(ev.shiftKey){ this.sel.delete(h.n); this.dirty=1; return; }
      const orig=[...this.sel].map(n=>({n,t:n.t,l:n.l,k:n.k}));
      this.drag={type:h.edge?'resize':'move',x,y,orig,anchor:h.n,moved:false};
      if(!h.edge) { app.eng.noteOn(ch.id,h.n.k,h.n.v); setTimeout(()=>app.eng.noteOff(ch.id,h.n.k),180); }
      this.dirty=1; return;
    }
    if(this.tool==='select' || ev.shiftKey){ if(!ev.shiftKey) this.sel.clear(); this.drag={type:'box',x0:x,y0:y,x1:x,y1:y,add:ev.shiftKey}; this.dirty=1; return; }
    // новая нота (или аккорд)
    const t=this.snapT(this.xt(x),true), k=this.fixKey(this.yk(y)); if(t<0||t>=stPatLen(pat)) return;
    const arr=stPatNotes(pat,ch.id), len=Math.min(this.lastLen,stPatLen(pat)-t), made=[];
    const iv=this.chord==='off'?[0]:ST_CHORDS[this.chord];
    this.sel.clear();
    for(const d of iv){ const kk=k+d; if(kk>127) continue; const n={t,l:len,k:kk,v:100}; arr.push(n); made.push(n); this.sel.add(n); app.eng.noteOn(ch.id,kk,100); }
    setTimeout(()=>{ for(const n of made) app.eng.noteOff(ch.id,n.k); },260);
    this.drag={type:'draw',x,orig:made.map(n=>({n,t:n.t,l:n.l,k:n.k})),moved:true}; this.dirty=1;
  }
  move(ev){
    const d=this.drag, app=this.app, [x,y]=this.pos(ev);
    if(!d){
      if(x<this.KW||y<this.RH) this.cv.style.cursor=x<this.KW?'pointer':'default';
      else{ const h=this.hit(x,y); this.cv.style.cursor=h?(h.edge?'ew-resize':'move'):this.tool==='erase'?'not-allowed':'crosshair'; }
      return; }
    const ch=app.chObj(), pat=app.patObj(); if(!pat) return;
    if(d.type==='pan'){ this.x0=Math.max(0,d.x0-(x-d.x)/this.zx); this.y0=stClamp(d.y0+(y-d.y)/this.zy,12,127); this.dirty=1; return; }
    if(d.type==='key'){ const k=this.yk(y); if(k!==d.k){ app.eng.noteOff(ch.id,d.k); this.live(d.k,0); d.k=k; app.eng.noteOn(ch.id,k,100); this.live(k,1); } return; }
    if(d.type==='vel'){ this.setVel(x,y,ev); return; }
    if(d.type==='erase'){ const h=this.hit(x,y); if(h) this.del(h.n); return; }
    if(d.type==='box'){ d.x1=x; d.y1=y; const xa=Math.min(d.x0,x),xb=Math.max(d.x0,x),ya=Math.min(d.y0,y),yb=Math.max(d.y0,y);
      if(!d.add) this.sel.clear();
      for(const n of this.notes()){ const nx=this.tx(n.t), nx2=this.tx(n.t+n.l), ny=this.ky(n.k); if(nx2>=xa&&nx<=xb&&ny+this.zy>=ya&&ny<=yb) this.sel.add(n); }
      this.dirty=1; return; }
    const L=stPatLen(pat), s=app.snap;
    if(d.type==='draw'){                                    // тянем вправо — длина новой ноты
      const o=d.orig[0], end=Math.max(o.t+s*(s>1?1:1),this.snapT(this.xt(x),false)); const len=Math.max(s,Math.min(end-o.t,L-o.t));
      for(const q of d.orig) q.n.l=len; this.lastLen=len; this.dirty=1; return; }
    const dx=(x-d.x)/this.zx;
    if(d.type==='move'){
      const dt=Math.round(dx/s)*s, dk=Math.round(-(y-d.y)/this.zy);
      for(const q of d.orig){ q.n.t=stClamp(q.t+dt,0,L-1); const nk=stClamp(q.k+dk,0,127); q.n.k=this.snapScale&&this.scale!=='chromatic'?stClamp(stSnapScale(nk,this.root,this.scale),0,127):nk; }
      if(d.orig.length && d.anchorK!==d.anchor.k){ d.anchorK=d.anchor.k; app.eng.noteOn(ch.id,d.anchor.k,d.anchor.v); setTimeout(()=>app.eng.noteOff(ch.id,d.anchor.k),150); }
      d.moved=true; this.dirty=1;
    }else if(d.type==='resize'){
      const dl=Math.round(dx/s)*s; for(const q of d.orig){ q.n.l=stClamp(q.l+dl,Math.min(s,12),L-q.n.t); } this.lastLen=d.anchor.l; d.moved=true; this.dirty=1;
    }
  }
  up(ev){
    const d=this.drag; if(!d) return; this.drag=null; const app=this.app, ch=app.chObj();
    if(d.type==='key'){ app.eng.noteOff(ch.id,d.k); this.live(d.k,0); return; }
    if(d.type==='pan') return;
    if(d.type==='box'){ this.dirty=1; return; }
    if(d.type==='move'||d.type==='resize'||d.type==='draw'||d.type==='erase'||d.type==='vel'){ this.changed(); }
    this.dirty=1;
  }
  changed(){ const a=this.app; a.commit(); a.refreshRack(); a.dirty('list'); this.dirty=1; }
  del(n){ const pat=this.app.patObj(), ch=this.app.chObj(); pat.notes[ch.id]=pat.notes[ch.id].filter(x=>x!==n); this.sel.delete(n); this.dirty=1; }
  setVel(x,y,ev){
    const ns=this.notes(), t=this.xt(x); const v=stClamp(Math.round((1-(y-(this.H-this.VH)-4)/(this.VH-8))*127),1,127);
    let best=null,bd=1e9; for(const n of ns){ const dd=Math.abs(this.tx(n.t)-x); if(dd<bd && dd<10){ bd=dd; best=n; } }
    if(best){ if(this.sel.has(best) && this.sel.size>1) for(const n of this.sel) n.v=v; else best.v=v; this.dirty=1; }
  }
  wheel(ev){
    ev.preventDefault(); const [x,y]=this.pos(ev);
    if(ev.ctrlKey||ev.metaKey){ const t=this.xt(x), f=Math.exp(-ev.deltaY*.0015); this.zx=stClamp(this.zx*f,.05,6); this.x0=Math.max(0,t-(x-this.KW)/this.zx); }
    else if(ev.altKey){ this.zy=stClamp(this.zy*Math.exp(-ev.deltaY*.0015),7,34); }
    else if(ev.shiftKey){ this.x0=Math.max(0,this.x0+(ev.deltaY||ev.deltaX)/this.zx); }
    else{ this.y0=stClamp(this.y0-ev.deltaY/this.zy*.6,12,127); if(ev.deltaX) this.x0=Math.max(0,this.x0+ev.deltaX/this.zx); }
    this.dirty=1;
  }

  /* ----- правка ----- */
  quantize(){
    const ns=this.sel.size?[...this.sel]:this.notes(), s=this.app.snap; if(!ns.length) return;
    for(const n of ns){ n.t=Math.round(n.t/s)*s; if(n.l<s) n.l=s; }
    this.changed();
  }
  key(ev){
    const app=this.app, k=ev.key, mod=ev.ctrlKey||ev.metaKey, pat=app.patObj(), ch=app.chObj(); if(!pat||!ch) return false;
    const ns=this.notes(), sel=[...this.sel], L=stPatLen(pat), s=app.snap;
    if(k==='Delete'||k==='Backspace'){ if(!sel.length) return true; pat.notes[ch.id]=ns.filter(n=>!this.sel.has(n)); this.sel.clear(); this.changed(); return true; }
    if(mod&&k.toLowerCase()==='a'){ for(const n of ns) this.sel.add(n); this.dirty=1; return true; }
    if(mod&&(k.toLowerCase()==='c'||k.toLowerCase()==='x')){
      if(!sel.length) return true; const t0=Math.min(...sel.map(n=>n.t));
      STU_CLIP={notes:sel.map(n=>({t:n.t-t0,l:n.l,k:n.k,v:n.v})),len:Math.max(...sel.map(n=>n.t+n.l))-t0};
      if(k.toLowerCase()==='x'){ pat.notes[ch.id]=ns.filter(n=>!this.sel.has(n)); this.sel.clear(); this.changed(); } return true; }
    if(mod&&k.toLowerCase()==='v'){
      if(!STU_CLIP) return true; const base=this.cursorT||0; this.sel.clear(); const arr=stPatNotes(pat,ch.id);
      for(const q of STU_CLIP.notes){ if(base+q.t>=L) continue; const n={t:base+q.t,l:Math.min(q.l,L-base-q.t),k:q.k,v:q.v}; arr.push(n); this.sel.add(n); }
      this.cursorT=Math.min(L-1,base+STU_CLIP.len); this.changed(); return true; }
    if(mod&&k.toLowerCase()==='d'){
      if(!sel.length) return true; const t0=Math.min(...sel.map(n=>n.t)), len=Math.max(...sel.map(n=>n.t+n.l))-t0; this.sel.clear(); const arr=stPatNotes(pat,ch.id);
      for(const o of sel){ if(o.t+len>=L) continue; const n={t:o.t+len,l:o.l,k:o.k,v:o.v}; arr.push(n); this.sel.add(n); } this.changed(); return true; }
    if(sel.length && (k==='ArrowLeft'||k==='ArrowRight'||k==='ArrowUp'||k==='ArrowDown')){
      const dt=k==='ArrowLeft'?-s:k==='ArrowRight'?s:0, dk=k==='ArrowUp'?(ev.shiftKey?12:1):k==='ArrowDown'?(ev.shiftKey?-12:-1):0;
      if(ev.altKey && dt){ for(const n of sel) n.l=stClamp(n.l+dt,Math.min(s,12),L-n.t); }
      else for(const n of sel){ n.t=stClamp(n.t+dt,0,L-1); n.k=stClamp(n.k+dk,0,127); }
      this.changed(); return true; }
    if(k==='Home'){ this.x0=0; this.dirty=1; return true; }
    return false;
  }
}
