"use strict";
/* ============================ STUDIO: PLAYLIST ============================
   Дорожки × такты. Клипы-паттерны (повторяются на всю длину клипа) и клипы автоматизации (параметр микшера, эффекта
   или инструмента). Слева — палитра паттернов (кисть). Линейка: клик — позиция, протяжка — петля, правый клик — снять петлю. */

let STU_LCLIP=null;

class StuList{
  constructor(app,host){
    this.app=app; this.host=host; this.sel=new Set(); this.dirty=1; this.drag=null;
    this.x0=0; this.zx=.16; this.y0=0; this.th=44; this.tool='draw'; this.lsnap=ST_BAR;
    this.HW=96; this.RH=24;
    host.innerHTML=`<div class="stu-lp"><div class="stu-lt">
        <button class="stu-b on" data-tool="draw" title="Place / move / resize clips. Right click: delete. Ctrl+drag: copy">✎ Draw</button>
        <button class="stu-b" data-tool="select" title="Box select">▭ Select</button>
        <button class="stu-b" data-tool="erase" title="Erase">⌫ Erase</button>
        <label class="stu-f">Snap <select data-o="snap"><option value="384" selected>bar</option><option value="192">1/2 bar</option><option value="96">beat</option><option value="24">1/16</option><option value="1">off</option></select></label>
        <button class="stu-b" data-act="loopclr">Clear loop</button>
        <button class="stu-b" data-act="trk+">＋ Track</button>
        <button class="stu-b" data-act="fit">Fit song</button>
        <span class="stu-dim">Wheel: scroll · Ctrl+wheel: zoom · Alt+wheel: height</span></div>
        <div class="stu-lb"><div class="stu-pal" data-r="pal"></div><div class="stu-cw"><canvas></canvas></div></div></div>`;
    this.cv=host.querySelector('canvas'); this.wrap=host.querySelector('.stu-cw'); this.pal=host.querySelector('[data-r=pal]');
    host.addEventListener('click',ev=>{
      const t=ev.target.closest('[data-tool]'); if(t){ this.tool=t.dataset.tool; host.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('on',b===t)); return; }
      const a=ev.target.closest('[data-act]'); if(!a) return;
      if(a.dataset.act==='loopclr'){ app.P.playlist.loop=null; app.commit(); this.dirty=1; if(app.eng.playing) app.restartIfPlaying(); }
      else if(a.dataset.act==='trk+'){ app.P.playlist.tracks++; app.commit(); this.dirty=1; }
      else if(a.dataset.act==='fit') this.fit();
    });
    host.addEventListener('change',ev=>{ if(ev.target.dataset.o==='snap') this.lsnap=+ev.target.value; });
    const cv=this.cv;
    cv.addEventListener('pointerdown',ev=>this.down(ev)); cv.addEventListener('pointermove',ev=>this.move(ev));
    cv.addEventListener('pointerup',ev=>this.up(ev)); cv.addEventListener('pointercancel',ev=>this.up(ev));
    cv.addEventListener('contextmenu',ev=>ev.preventDefault()); cv.addEventListener('wheel',ev=>this.wheel(ev),{passive:false});
    cv.addEventListener('dblclick',ev=>this.dbl(ev));
    new ResizeObserver(()=>this.resize()).observe(this.wrap);
  }
  get P(){ return this.app.P; }
  tx(t){ return this.HW+(t-this.x0)*this.zx; } xt(x){ return this.x0+(x-this.HW)/this.zx; }
  ty(tr){ return this.RH+tr*this.th-this.y0; } yt(y){ return Math.floor((y-this.RH+this.y0)/this.th); }
  resize(){
    const w=this.wrap.clientWidth, h=this.wrap.clientHeight; if(!w||!h) return; const dpr=Math.min(2,window.devicePixelRatio||1);
    this.W=w; this.H=h; this.dpr=dpr; this.cv.width=w*dpr; this.cv.height=h*dpr; this.cv.style.width=w+'px'; this.cv.style.height=h+'px'; this.dirty=1;
  }
  fit(){ const e=Math.max(stSongEnd(this.P),ST_BAR*8); this.x0=0; this.zx=stClamp((this.W-this.HW-20)/e,.02,2); this.dirty=1; }
  patColor(id){ const i=this.P.patterns.findIndex(p=>p.id===id); return ST_COLORS[(i<0?0:i)%ST_COLORS.length]; }
  buildPalette(){
    const app=this.app, P=this.P, pal=this.pal; pal.innerHTML='<h4>Patterns</h4>';
    for(const p of P.patterns){
      const b=document.createElement('button'); b.className='stu-pb'+(p.id===app.cur.pat?' on':''); b.style.setProperty('--c',this.patColor(p.id));
      b.textContent=p.name; b.title='Click: use as brush and edit · double click: rename';
      b.addEventListener('click',()=>{ app.cur.pat=p.id; app.refreshTop(); app.refreshRack(); app.roll.dirty=1; this.buildPalette(); this.dirty=1; if(app.mode==='pat') app.restartIfPlaying(); });
      b.addEventListener('dblclick',()=>{ const n=prompt('Pattern name',p.name); if(n){ p.name=n; app.commit(); app.refreshTop(); this.buildPalette(); } });
      pal.append(b);
    }
    const add=document.createElement('button'); add.className='stu-b'; add.textContent='＋ New pattern'; add.addEventListener('click',()=>app.action('newpat')); pal.append(add);
  }

  /* ----- рисование ----- */
  draw(){
    const cv=this.cv; if(!this.W){ this.resize(); if(!this.W) return; }
    if(this._pk!==this.P.patterns.map(p=>p.name+p.id).join()+this.app.cur.pat){ this._pk=this.P.patterns.map(p=>p.name+p.id).join()+this.app.cur.pat; this.buildPalette(); }
    this.dirty=0; const c=cv.getContext('2d'), app=this.app, P=this.P, W=this.W, H=this.H, HW=this.HW, RH=this.RH, dpr=this.dpr, pl=P.playlist;
    c.setTransform(dpr,0,0,dpr,0,0);
    const bg='#0a0d0e', line='#2a3136', txt='#c8d2d6', dim='#929fa7', acc='#e0b23c';
    c.fillStyle=bg; c.fillRect(0,0,W,H);
    const maxY=Math.max(0,pl.tracks*this.th-(H-RH)); this.y0=stClamp(this.y0,0,maxY);
    c.save(); c.beginPath(); c.rect(HW,RH,W-HW,H-RH); c.clip();
    for(let tr=0;tr<pl.tracks;tr++){ const y=this.ty(tr); if(y>H||y+this.th<RH) continue; c.fillStyle=tr&1?'#10151780':'#0c1012'; c.fillRect(HW,y,W-HW,this.th); c.fillStyle=line; c.fillRect(HW,y+this.th-1,W-HW,1); }
    const tA=this.x0, tB=this.xt(W);
    let sub=ST_BAR; while(sub*this.zx<14 && sub<ST_BAR*64) sub*=2;
    const fine=ST_PPQ*this.zx>=12;
    for(let t=Math.floor(tA/ST_PPQ)*ST_PPQ;t<=tB;t+=ST_PPQ){ const bar=t%ST_BAR===0; if(!bar && !fine) continue; if(bar && (t/ST_BAR)%(sub/ST_BAR)) continue;
      c.fillStyle=bar?'#3a454c':'#1c2327'; c.fillRect(Math.round(this.tx(t)),RH,1,H-RH); }
    // петля
    if(pl.loop){ c.fillStyle='#e0b23c18'; c.fillRect(this.tx(pl.loop[0]),RH,(pl.loop[1]-pl.loop[0])*this.zx,H-RH); }
    // клипы
    for(const cl of pl.clips) this.drawClip(c,cl);
    // позиция
    const ph=app.tickHead!=null&&app.mode==='song'?app.tickHead:app.pos;
    if(ph!=null){ const x=this.tx(ph); c.fillStyle=app.tickHead!=null&&app.mode==='song'?'#fff':'#ffffff80'; c.fillRect(Math.round(x),RH,1,H-RH); }
    if(this.drag&&this.drag.type==='box'){ const d=this.drag; c.strokeStyle='#fff'; c.setLineDash([4,3]); c.strokeRect(d.x0,d.y0,d.x1-d.x0,d.y1-d.y0); c.setLineDash([]); }
    c.restore();
    // заголовки дорожек
    c.fillStyle='#141719'; c.fillRect(0,RH,HW,H-RH);
    c.font='11px sans-serif'; c.textBaseline='middle';
    for(let tr=0;tr<pl.tracks;tr++){ const y=this.ty(tr); if(y>H||y+this.th<RH) continue;
      c.fillStyle=line; c.fillRect(0,y+this.th-1,HW,1); c.fillStyle=txt; c.fillText((pl.names&&pl.names[tr])||'Track '+(tr+1),8,y+this.th/2); }
    // линейка
    c.fillStyle='#161a1d'; c.fillRect(0,0,W,RH); c.fillStyle=line; c.fillRect(0,RH-1,W,1);
    if(pl.loop){ c.fillStyle=acc; c.fillRect(this.tx(pl.loop[0]),RH-5,(pl.loop[1]-pl.loop[0])*this.zx,4); }
    c.fillStyle=txt; c.font='10px sans-serif';
    for(let t=Math.floor(tA/ST_BAR)*ST_BAR;t<=tB;t+=ST_BAR){ if((t/ST_BAR)%(sub/ST_BAR)) continue; const x=this.tx(t); if(x<HW) continue; c.fillText(String(t/ST_BAR+1),x+3,RH/2-2); c.fillStyle='#46515a'; c.fillRect(Math.round(x),0,1,RH); c.fillStyle=txt; }
    c.fillStyle='#161a1d'; c.fillRect(0,0,HW,RH); c.fillStyle=dim; c.fillText('drag ruler: loop',6,RH/2);
    if(ph!=null){ const x=this.tx(ph); if(x>=HW){ c.fillStyle=acc; c.beginPath(); c.moveTo(x-5,0); c.lineTo(x+5,0); c.lineTo(x,9); c.fill(); } }
  }
  drawClip(c,cl){
    const x=this.tx(cl.t), w=cl.l*this.zx, y=this.ty(cl.tr); if(x+w<this.HW||x>this.W||y>this.H||y+this.th<this.RH) return;
    const th=this.th, sel=this.sel.has(cl);
    if(cl.kind==='auto'){
      c.fillStyle='#4ec9b014'; c.fillRect(x,y+1,w,th-2); c.strokeStyle=sel?'#fff':'#4ec9b0'; c.setLineDash([5,3]); c.lineWidth=1; c.strokeRect(x+.5,y+1.5,w-1,th-3); c.setLineDash([]);
      c.fillStyle='#4ec9b040'; c.fillRect(x,y+1,w,10); c.fillStyle='#cfe'; c.font='10px sans-serif'; c.textBaseline='middle';
      c.save(); c.beginPath(); c.rect(x,y,w,th); c.clip(); c.fillText(this.targetName(cl.target),x+4,y+6);
      c.strokeStyle='#4ec9b0'; c.lineWidth=2; c.beginPath();
      cl.pts.forEach((p,i)=>{ const px=x+p[0]*this.zx, py=y+th-3-p[1]*(th-16); i?c.lineTo(px,py):c.moveTo(px,py); }); c.stroke();
      c.fillStyle='#fff'; for(const p of cl.pts){ c.beginPath(); c.arc(x+p[0]*this.zx,y+th-3-p[1]*(th-16),sel?3.5:2.5,0,7); c.fill(); }
      c.restore(); return;
    }
    const pat=this.P.patterns.find(p=>p.id===cl.pat); if(!pat) return; const col=this.patColor(pat.id);
    c.fillStyle=col+'cc'; c.fillRect(x,y+1,w,th-2); c.fillStyle='#0000002a'; c.fillRect(x,y+1,w,12);
    c.save(); c.beginPath(); c.rect(Math.max(x,this.HW),y,w,th); c.clip();
    c.fillStyle='#000c'; c.font='10px sans-serif'; c.textBaseline='middle'; c.fillText(pat.name,Math.max(x,this.HW)+4,y+7);
    // мини-превью нот
    const L=stPatLen(pat); let lo=127,hi=0; for(const id in pat.notes) for(const n of pat.notes[id]){ if(n.k<lo) lo=n.k; if(n.k>hi) hi=n.k; }
    if(hi>=lo){ const rng=Math.max(12,hi-lo+1), ph=th-18; c.fillStyle='#000a';
      for(let r=0;r*L<cl.l;r++){ const bx=cl.t+r*L; if(this.tx(bx+L)<this.HW) continue; if(this.tx(bx)>this.W) break;
        for(const id in pat.notes) for(const n of pat.notes[id]){ const nt=bx+n.t; if(nt>=cl.t+cl.l) continue;
          c.fillRect(this.tx(nt),y+14+ph-(n.k-lo+.5)/rng*ph,Math.max(1,Math.min(n.l,cl.t+cl.l-nt)*this.zx),Math.max(1.5,ph/rng)); } } }
    for(let r=1;r*L<cl.l;r++){ c.fillStyle='#0004'; c.fillRect(this.tx(cl.t+r*L),y+1,1,th-2); }
    c.restore();
    if(sel){ c.strokeStyle='#fff'; c.lineWidth=2; c.strokeRect(x+1,y+2,w-2,th-4); }
  }
  targetName(t){
    const s=t.split(':'), P=this.P;
    if(s[0]==='mix') return (P.mixer[+s[1]]?.name||'?')+' · '+s[2];
    if(s[0]==='fx'){ const f=P.mixer[+s[1]]?.fx[+s[2]]; return (P.mixer[+s[1]]?.name||'?')+' · '+(f?ST_FX[f.type].name:'?')+' · '+s[3]; }
    const ch=P.channels.find(c=>c.id===+s[1]); return (ch?ch.name:'?')+' · '+s[2];
  }

  /* ----- мышь ----- */
  pos(ev){ const r=this.cv.getBoundingClientRect(); return [ev.clientX-r.left,ev.clientY-r.top]; }
  snapT(t,floor){ const s=this.lsnap; return Math.max(0,floor?Math.floor(t/s)*s:Math.round(t/s)*s); }
  hit(x,y){
    const t=this.xt(x), tr=this.yt(y), cl=this.P.playlist.clips;
    for(let i=cl.length-1;i>=0;i--){ const c=cl[i]; if(c.tr===tr && t>=c.t && t<c.t+c.l){
      const x2=this.tx(c.t+c.l), y0=this.ty(c.tr); return {c,edge:x>x2-8,head:(y-y0)<12,tr}; } }
    return null;
  }
  down(ev){
    const app=this.app, P=this.P, pl=P.playlist; this.cv.setPointerCapture(ev.pointerId); const [x,y]=this.pos(ev), HW=this.HW, RH=this.RH;
    if(ev.button===1){ this.drag={type:'pan',x,y,x0:this.x0,y0:this.y0}; return; }
    if(y<RH){
      if(ev.button===2){ pl.loop=null; app.commit(); this.dirty=1; if(app.eng.playing) app.restartIfPlaying(); return; }
      if(x>=HW) this.drag={type:'ruler',x,t:this.xt(x),moved:false}; return; }
    if(x<HW){ const tr=this.yt(y); const nm=prompt('Track name',(pl.names&&pl.names[tr])||'Track '+(tr+1)); if(nm!=null){ (pl.names||(pl.names={}))[tr]=nm; app.commit(); this.dirty=1; } return; }
    const h=this.hit(x,y), erase=ev.button===2||ev.altKey||this.tool==='erase', tr=this.yt(y);
    if(erase){ this.drag={type:'erase'}; if(h) this.del(h.c); return; }
    if(h){
      const c=h.c;
      if(c.kind==='auto' && !h.head && !h.edge && this.sel.has(c) && this.sel.size===1){      // правка точек автоматизации
        const lx=(x-this.tx(c.t))/this.zx, th=this.th, y0=this.ty(c.tr);
        let pi=c.pts.findIndex(p=>Math.abs(p[0]*this.zx-lx*this.zx)<7 && Math.abs((y0+th-3-p[1]*(th-16))-y)<8);
        if(pi<0){ const v=stClamp((y0+th-3-y)/(th-16),0,1), t=stClamp(this.snapAuto(lx),0,c.l); c.pts.push([t,v]); c.pts.sort((a,b)=>a[0]-b[0]); pi=c.pts.findIndex(p=>p[0]===t&&p[1]===v); }
        this.drag={type:'pt',c,pi}; this.dirty=1; return; }
      if(!this.sel.has(c)){ if(!ev.shiftKey) this.sel.clear(); this.sel.add(c); } else if(ev.shiftKey){ this.sel.delete(c); this.dirty=1; return; }
      if(ev.ctrlKey&&!h.edge){                                                              // копия при переносе
        const copies=[...this.sel].map(o=>{ const n=JSON.parse(JSON.stringify(o)); n.id=stNextId(P); pl.clips.push(n); return n; });
        this.sel=new Set(copies); }
      const orig=[...this.sel].map(o=>({c:o,t:o.t,l:o.l,tr:o.tr}));
      this.drag={type:h.edge?'resize':'move',x,y,orig,moved:false,tr0:h.tr}; this.dirty=1; return;
    }
    if(this.tool==='select'||ev.shiftKey){ if(!ev.shiftKey) this.sel.clear(); this.drag={type:'box',x0:x,y0:y,x1:x,y1:y}; this.dirty=1; return; }
    // новый клип
    if(tr<0||tr>=pl.tracks) return;
    const pat=app.patObj(); if(!pat) return;
    const t=this.snapT(this.xt(x),true), c=stAddClip(P,pat,tr,t);
    this.sel=new Set([c]); this.drag={type:'move',x,y,orig:[{c,t:c.t,l:c.l,tr:c.tr}],moved:false,tr0:tr,fresh:true}; this.dirty=1;
  }
  snapAuto(rel){ const s=Math.min(this.lsnap,ST_STEP*2)||1; return Math.round(rel/s)*s; }
  move(ev){
    const d=this.drag, [x,y]=this.pos(ev), P=this.P;
    if(!d){ if(y<this.RH) this.cv.style.cursor='pointer'; else if(x<this.HW) this.cv.style.cursor='text'; else{ const h=this.hit(x,y); this.cv.style.cursor=h?(h.edge?'ew-resize':h.c.kind==='auto'&&!h.head?'crosshair':'move'):'copy'; } return; }
    if(d.type==='pan'){ this.x0=Math.max(0,d.x0-(x-d.x)/this.zx); this.y0=d.y0-(y-d.y); this.dirty=1; return; }
    if(d.type==='ruler'){ if(Math.abs(x-d.x)>4) d.moved=true;
      if(d.moved){ let a=this.snapT(d.t,false), b=this.snapT(this.xt(x),false); if(a>b) [a,b]=[b,a]; if(b-a>=Math.min(this.lsnap,ST_STEP)){ P.playlist.loop=[a,b]; this.dirty=1; } } return; }
    if(d.type==='erase'){ const h=this.hit(x,y); if(h) this.del(h.c); return; }
    if(d.type==='box'){ d.x1=x; d.y1=y; this.sel.clear(); const xa=Math.min(d.x0,x),xb=Math.max(d.x0,x),ya=Math.min(d.y0,y),yb=Math.max(d.y0,y);
      for(const c of P.playlist.clips){ const cx=this.tx(c.t), cx2=this.tx(c.t+c.l), cy=this.ty(c.tr); if(cx2>=xa&&cx<=xb&&cy+this.th>=ya&&cy<=yb) this.sel.add(c); } this.dirty=1; return; }
    if(d.type==='pt'){
      const c=d.c, th=this.th, y0=this.ty(c.tr), p=c.pts[d.pi], lx=(x-this.tx(c.t))/this.zx;
      p[1]=stClamp((y0+th-3-y)/(th-16),0,1);
      const lo=d.pi>0?c.pts[d.pi-1][0]:0, hi=d.pi<c.pts.length-1?c.pts[d.pi+1][0]:c.l; p[0]=stClamp(this.snapAuto(lx),lo,hi); this.dirty=1; return; }
    if(d.type==='move'){
      const dt=Math.round(((x-d.x)/this.zx)/this.lsnap)*this.lsnap, dtr=this.yt(y)-d.tr0;
      for(const o of d.orig){ o.c.t=Math.max(0,o.t+dt); o.c.tr=stClamp(o.tr+dtr,0,P.playlist.tracks-1); } if(Math.abs(x-d.x)+Math.abs(y-d.y)>3) d.moved=true; this.dirty=1;
    }else if(d.type==='resize'){
      const dl=Math.round(((x-d.x)/this.zx)/this.lsnap)*this.lsnap;
      for(const o of d.orig){ o.c.l=Math.max(Math.min(this.lsnap,ST_STEP),o.l+dl); if(o.c.kind==='auto') o.c.pts=o.c.pts.filter(p=>p[0]<=o.c.l); } this.dirty=1; d.moved=true;
    }
  }
  up(ev){
    const d=this.drag; if(!d) return; this.drag=null; const app=this.app;
    if(d.type==='ruler'){ if(!d.moved) app.seek(this.snapT(d.t,true)); else{ app.commit(); if(app.eng.playing) app.restartIfPlaying(); } this.dirty=1; return; }
    if(d.type==='move'&&d.fresh&&!d.moved){ /* простой клик по пустому месту — клип поставлен */ }
    if(['move','resize','erase','pt'].includes(d.type)) app.commit();
    if(d.type==='box') this.dirty=1;
    this.dirty=1;
  }
  dbl(ev){
    const [x,y]=this.pos(ev), h=this.hit(x,y); if(!h) return; const c=h.c;
    if(c.kind==='pat'){ this.app.cur.pat=c.pat; this.app.refreshTop(); this.app.refreshRack(); this.app.setTab('roll'); this.app.roll.fit(); }
    else if(h.head){ if(confirm('Delete automation clip?')) this.del(c); }
  }
  del(c){ const pl=this.P.playlist; pl.clips=pl.clips.filter(x=>x!==c); this.sel.delete(c); this.dirty=1; }
  wheel(ev){
    ev.preventDefault(); const [x]=this.pos(ev);
    if(ev.ctrlKey||ev.metaKey){ const t=this.xt(x), f=Math.exp(-ev.deltaY*.0015); this.zx=stClamp(this.zx*f,.01,3); this.x0=Math.max(0,t-(x-this.HW)/this.zx); }
    else if(ev.altKey) this.th=stClamp(this.th*Math.exp(-ev.deltaY*.0015),24,120);
    else if(ev.shiftKey) this.x0=Math.max(0,this.x0+(ev.deltaY||ev.deltaX)/this.zx);
    else{ this.y0+=ev.deltaY; if(ev.deltaX) this.x0=Math.max(0,this.x0+ev.deltaX/this.zx); }
    this.dirty=1;
  }
  key(ev){
    const app=this.app, P=this.P, k=ev.key, mod=ev.ctrlKey||ev.metaKey, sel=[...this.sel], s=this.lsnap;
    if(k==='Delete'||k==='Backspace'){ if(!sel.length) return true; P.playlist.clips=P.playlist.clips.filter(c=>!this.sel.has(c)); this.sel.clear(); app.commit(); this.dirty=1; return true; }
    if(mod&&k.toLowerCase()==='a'){ for(const c of P.playlist.clips) this.sel.add(c); this.dirty=1; return true; }
    if(mod&&k.toLowerCase()==='c'){ if(sel.length){ const t0=Math.min(...sel.map(c=>c.t)); STU_LCLIP=sel.map(c=>Object.assign(JSON.parse(JSON.stringify(c)),{t:c.t-t0})); } return true; }
    if(mod&&k.toLowerCase()==='v'){ if(!STU_LCLIP) return true; const base=this.snapT(app.pos,true); this.sel.clear();
      for(const q of STU_LCLIP){ const n=JSON.parse(JSON.stringify(q)); n.id=stNextId(P); n.t=base+q.t; P.playlist.clips.push(n); this.sel.add(n); } app.commit(); this.dirty=1; return true; }
    if(mod&&k.toLowerCase()==='d'){ if(!sel.length) return true; const t0=Math.min(...sel.map(c=>c.t)), len=Math.max(...sel.map(c=>c.t+c.l))-t0; this.sel.clear();
      for(const c of sel){ const n=JSON.parse(JSON.stringify(c)); n.id=stNextId(P); n.t+=len; P.playlist.clips.push(n); this.sel.add(n); } app.commit(); this.dirty=1; return true; }
    if(sel.length&&(k==='ArrowLeft'||k==='ArrowRight'||k==='ArrowUp'||k==='ArrowDown')){
      for(const c of sel){ if(k==='ArrowLeft') c.t=Math.max(0,c.t-s); if(k==='ArrowRight') c.t+=s; if(k==='ArrowUp') c.tr=Math.max(0,c.tr-1); if(k==='ArrowDown') c.tr=Math.min(P.playlist.tracks-1,c.tr+1); }
      app.commit(); this.dirty=1; return true; }
    return false;
  }
}
