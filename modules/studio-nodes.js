"use strict";
/* ============================ STUDIO: САМОСТОЯТЕЛЬНЫЕ УЗЛЫ ГРАФА ============================
   Drum Machine, Piano Roll, Pattern Playlist, Mixer — каждый работает сам по себе, как любой модуль графа: обычные пины
   (clk / run / reset на входе; gate, freq, vel, звук на выходе), свои данные в параметре узла, редактор внутри узла
   (те же панели, что в студии). Не нужны ни узел Studio (DAW), ни проводы между собой:
   Master Clock → Drum Machine → Sampler (самый простой сэмплер), Pattern Playlist → Piano Roll (pat) → Synth,
   любые генераторы → Mixer → DAC (микс для сна с таймером). */

/* ---------- адаптер: даёт панелям студии то, что им нужно от «сессии», но данные — в узле ---------- */
class StuLite{
  constructor(node,make,opt){
    opt=opt||{}; this.node=node; this.panels=new Set(); this.dead=false; this.snap=ST_STEP; this.minSnap=ST_STEP; this.mode=opt.mode||'pat';
    this.pos=0; this.tickHead=null; this.msg=''; this.cur={pat:0,ch:0,ins:1,slot:-1}; this.focusPanel=null; this.raf=0; this.full=null; this.maxMix=opt.maxMix||0;
    this.clips={}; this.undo=[]; this.redoS=[]; this.rev=1; this.lv=null; this.makeDefault=make;
    const self=this;
    this.eng={playing:false,view:{},samples:{},rig:null,ac:null,ensure(){},extSetup(){},extRoute(){},noteOn(){},noteOff(){},
      async loadClip(chId,id){ const c=await SampleDB.getClip(id); if(!c) throw new Error('clip not found'); self.clips[chId]={data:c.samples,sr:c.sr,name:c.name};
        this.samples[chId]={buf:{getChannelData:()=>c.samples,duration:c.samples.length/c.sr},name:c.name}; self.rev++; },
      async loadSample(chId,f){ const d=await decodeAudioFile(f); self.clips[chId]={data:d.samples||d.data,sr:d.sr,name:f.name};
        this.samples[chId]={buf:{getChannelData:()=>self.clips[chId].data},name:f.name}; self.rev++; }};
    let P=null; try{ if(node.p.data) P=stLoad(node.p.data); }catch(e){ console.warn('studio node data',e); }
    this.P=P||make(); if(this.maxMix) this.P.mixer.length=this.maxMix+1;
    this.cur.pat=this.P.patterns[0]?this.P.patterns[0].id:0; this.cur.ch=this.P.channels[0]?this.P.channels[0].id:0;
    this.undo=[JSON.stringify(this.P)]; if(!node.p.data) node.p.data=this.undo[0];
    setTimeout(()=>this.loadClips(),0);
  }
  // клипы строк-сэмплеров: данные берутся из библиотеки Files › audio по id
  async loadClips(){
    for(const ch of this.P.channels) if(ch.type==='sampler' && ch.p.clip && !this.clips[ch.id]){
      const id=parseInt(ch.p.clip); if(id) try{ await this.eng.loadClip(ch.id,id); }catch(e){ console.warn('studio clip',e); } }
    this.each('inst',i=>i.refresh());
  }
  attach(p){
    this.panels.add(p);
    p.el.addEventListener('pointerdown',()=>{ StuFocus=this; this.focusPanel=p; },true);
    if(!this.raf) this.raf=requestAnimationFrame(()=>this.frame());
  }
  detach(p){ this.panels.delete(p); if(this.focusPanel===p) this.focusPanel=null; }
  each(kind,fn){ for(const p of [...this.panels]) if(p.kind===kind) fn(p); }
  dirty(...kinds){ for(const p of this.panels) if(kinds.includes(p.kind)) p.dirty=1; }
  refreshRack(){ this.each('rack',p=>p.refresh()); }
  refreshMixer(){ this.each('mix',p=>p.refresh()); }
  refreshPats(){ this.each('bar',p=>p.refresh()); this.refreshRack(); this.dirty('roll','list'); }
  refreshAll(){ for(const p of [...this.panels]) p.refresh(); this.dirty('roll','list'); }
  say(m){ this.msg=m; }
  focusTab(){}
  levels(){ return this.lv; }
  seek(t){ const n=this.node; n.step=Math.floor(Math.max(0,t)/ST_STEP)-1; n.samplesLeft=0; n._clkAge=0; }
  restartIfPlaying(){}
  action(a,ev){ if(a==='newpat'){ const p=stAddPattern(this.P,'Pattern '+(this.P.patterns.length+1),this.patObj()?this.patObj().bars:1); this.cur.pat=p.id; this.commit(); this.refreshAll(); } else if(a==='patmenu') this.patMenu(ev); }
  autoFor(){ this.say('use the g1…g8 inputs for level automation'); }
  audition(){}
  patObj(){ return this.P.patterns.find(p=>p.id===this.cur.pat); }
  chObj(){ return this.P.channels.find(c=>c.id===this.cur.ch); }
  stepKey(ch){ return ch.type==='sampler' ? ch.p.root : 60; }
  frame(){
    this.raf=0; if(!this.panels.size || this.dead) return;
    this.raf=requestAnimationFrame(()=>this.frame());
    const now=performance.now(); if(now-(this._lf||0)<28) return; this._lf=now;
    for(const p of [...this.panels]) if(p.el.isConnected && p.el.offsetParent!==null) p.frame();
  }
  commit(){
    const s=JSON.stringify(this.P); if(s===this.undo[this.undo.length-1]) return;
    this.undo.push(s); if(this.undo.length>80) this.undo.shift(); this.redoS=[]; this.node.p.data=s; this.rev++;
  }
  restore(s){ const P=stLoad(s); for(const k of Object.keys(this.P)) delete this.P[k]; Object.assign(this.P,P); if(this.maxMix) this.P.mixer.length=this.maxMix+1;
    if(!this.patObj()) this.cur.pat=this.P.patterns[0]?this.P.patterns[0].id:0; if(!this.chObj()) this.cur.ch=this.P.channels[0]?this.P.channels[0].id:0;
    this.node.p.data=s; this.rev++; this.refreshAll(); }
  doUndo(){ if(this.undo.length<2) return; this.redoS.push(this.undo.pop()); this.restore(this.undo[this.undo.length-1]); }
  doRedo(){ if(!this.redoS.length) return; const s=this.redoS.pop(); this.undo.push(s); this.restore(s); }
  onKey(ev,down){
    const tg=ev.target; if(tg && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName) && !(tg.type==='range'||tg.type==='button')) return;
    if(!down) return; const k=ev.key, mod=ev.ctrlKey||ev.metaKey;
    if(mod && k.toLowerCase()==='z'){ ev.preventDefault(); ev.shiftKey?this.doRedo():this.doUndo(); return; }
    if(mod && k.toLowerCase()==='y'){ ev.preventDefault(); this.doRedo(); return; }
    const f=this.focusPanel; if(f && (f.kind==='roll'||f.kind==='list') && f.key(ev)) ev.preventDefault();
  }
  // строки drum machine: до 8 штук
  addMenu(x,y){
    const rows=this.P.channels.length; if(rows>=8){ this.say('8 rows maximum'); return; }
    const items=Object.keys(ST_KITS).map(n=>({label:'Drum: '+n,fn:()=>this.addRow('drum',n,ST_KITS[n])}));
    items.push({sep:1},{label:'Clip row (sample from Files › audio)',fn:()=>this.addRow('sampler','Clip',{})},{label:'Trigger row (gate pin only)',fn:()=>this.addRow('ext','Trigger',{})});
    stuMenu(x,y,items);
  }
  addRow(type,name,p){ const ch=stAddChannel(this.P,type,name,p,0); this.cur.ch=ch.id; this.commit(); this.refreshAll(); }
  chMenu(ev,ch){
    const P=this.P;
    stuMenu(ev.clientX,ev.clientY,[
      {label:'Rename…',fn:()=>{ const n=prompt('Row name',ch.name); if(n){ ch.name=n; this.commit(); this.refreshAll(); } }},
      {label:'Move up',dis:P.channels.indexOf(ch)===0,fn:()=>{ const i=P.channels.indexOf(ch); P.channels.splice(i,1); P.channels.splice(i-1,0,ch); this.commit(); this.refreshRack(); }},
      {label:'Move down',dis:P.channels.indexOf(ch)===P.channels.length-1,fn:()=>{ const i=P.channels.indexOf(ch); P.channels.splice(i,1); P.channels.splice(i+1,0,ch); this.commit(); this.refreshRack(); }},
      {label:'Clear steps in this pattern',fn:()=>{ const p=this.patObj(); if(p) delete p.notes[ch.id]; this.commit(); this.refreshAll(); }},
      {sep:1},
      {label:'Delete row',fn:()=>{ stRemoveChannel(P,ch.id); this.cur.ch=P.channels[0]?P.channels[0].id:0; this.commit(); this.refreshAll(); }}]);
  }
}
for(const m of ['patMenu']) StuLite.prototype[m]=StuApp.prototype[m];

/* ---------- малая панель: выбор паттерна и подсказки ---------- */
class StuLiteBar extends StuPanel{
  constructor(app,label){
    super(app,'bar'); this.el.classList.add('stu-top');
    this.el.innerHTML='<label class="stu-f">Pattern <select data-r="pat"></select></label><button class="stu-b" data-a="newpat" title="New pattern">＋</button><button class="stu-b" data-a="patmenu" title="Pattern: clone / rename / length / delete">⋯</button><span class="stu-dim" data-r="info"></span><span class="stu-fill"></span><span class="stu-dim">'+(label||'')+'</span>';
    this.el.addEventListener('click',ev=>{ const a=ev.target.closest('[data-a]'); if(a) app.action(a.dataset.a,ev); });
    this.el.querySelector('select').addEventListener('change',e=>{ app.cur.pat=+e.target.value; app.node._patUser=app.cur.pat; app.refreshPats(); });
    this.refresh();
  }
  refresh(){ const A=this.app, sel=this.el.querySelector('select'); sel.innerHTML=''; for(const p of A.P.patterns) sel.append(new Option(p.name,p.id)); sel.value=A.cur.pat; }
  frame(){ const i=this.el.querySelector('[data-r=info]'), n=this.app.node, t=n.S_info?n.S_info():''; if(i.textContent!==t) i.textContent=t; }
}

/* ---------- общее: шаги, запуск, сброс ---------- */
// true в сэмпле начала шага (1/16): внешний clk-вход (импульсы) или свой bpm — как у Piano Roll и Master Clock
function stuStep(n,I,i,own){
  if(I.reset && I.reset[i]>.5){ n.step=-1; n.samplesLeft=0; n._clkAge=0; }
  if(!n._run) return false;
  if(!seqTick(n,I,i,own)) return false;
  n.step++; return true;
}
function stuRunFlag(n,I){ n._run=typeof I.run==='number' ? I.run>.5 : !!n.p.run; }
const stuLiteIns=[{n:'clk',t:'sig'},{n:'run',t:'num'},{n:'reset',t:'sig'}];

const stuLiteFit=n=>{ if(n.tile) n.tile.style.height=Math.max(140,(n.size.h||300)-(n.tileOff||150))+'px'; };
// узел → тайл с панелями: build(app, host) наполняет контейнер
function stuLiteTile(n,build){
  if(!n.mid) return;
  if(!n.tile){ n.tile=document.createElement('div'); n.tile.className='stu stu-tile stu-lite'; stuLiteFit(n); }
  if(!n.mid.contains(n.tile)) n.mid.append(n.tile);
  if(n.built || !n.S) return; n.built=true; n.tile.innerHTML=''; build(n.S,n.tile);
}
const stuLiteDispose=n=>{ if(n.S){ n.S.dead=true; for(const p of [...n.S.panels]) p.destroy(); n.S=null; } };
function stuLiteStatus(n,txt){ n.status=txt; }

/* ============================ DRUM MACHINE ============================ */
function stuDrumDefault(){
  const P=stNewProject(); P.name='Drum Machine'; const pat=stAddPattern(P,'Pattern 1',1);
  const k=stAddChannel(P,'drum','Kick',ST_KITS['Kick 909'],0), s=stAddChannel(P,'drum','Snare',ST_KITS.Snare,0), h=stAddChannel(P,'drum','Hat',ST_KITS['Closed Hat'],0), o=stAddChannel(P,'drum','Open Hat',ST_KITS['Open Hat'],0);
  const B=(c,str,v)=>{ pat.notes[c.id]=[]; [...str].forEach((x,i)=>{ if(x==='x') pat.notes[c.id].push({t:i*ST_STEP,l:ST_STEP,k:60,v:v||100}); }); };
  B(k,'x...x...x...x...',115); B(s,'....x.......x...',100); B(h,'x.x.x.x.x.x.x.x.',70); B(o,'..x...x...x...x.',80);
  return P;
}
const STU_DRUM_OUTS=[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'step',t:'num'}];
for(let k=1;k<=8;k++) STU_DRUM_OUTS.push({n:'g'+k,t:'sig'});
def({ id:'studrum', lazy:'manual', title:'Drum Machine (Studio)', cat:'Music', resize:true, w:640, h:560, readout:true,
  ins:[...stuLiteIns,{n:'pat',t:'num'}],
  outs:STU_DRUM_OUTS,
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (no clk)'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'swing',t:'range',min:0,max:1,step:.01,d:0},
    {n:'gate',t:'range',min:.05,max:1,step:.01,d:.5,label:'gate length'},
    {n:'gain',t:'range',min:0,max:1.5,step:.01,d:.8},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=170; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuDrumDefault); n.S.liteKind='drum'; n.step=-1; n.samplesLeft=0; n.stepLen=0; n.vo=[[],[],[],[],[],[],[],[]]; n.gl=new Float32Array(8); n.pend=[]; n.built=false; n.tile=null; n._rev=0;
    n.S_info=()=>'step '+(n.step<0?0:(n.step%Math.max(1,(n.S.patObj()?n.S.patObj().bars:1)*16))+1);
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, L=buf(n,'L'), R=buf(n,'R'), O=buf(n,'out'); L.fill(0); R.fill(0); O.fill(0);
    const G=[]; for(let k=0;k<8;k++){ G[k]=buf(n,'g'+(k+1)); G[k].fill(0); }
    if(!S) return {out:O,L,R,step:0}; stuRunFlag(n,I);
    const P=S.P, rows=P.channels.slice(0,8);
    if(typeof I.pat==='number'){ const q=P.patterns[Math.max(0,Math.min(P.patterns.length-1,Math.round(I.pat)))]; if(q && q.id!==S.cur.pat){ S.cur.pat=q.id; S.refreshPats(); } }
    const pat=S.patObj(); if(!pat) return {out:O,L,R,step:n.step};
    const steps=pat.bars*16, own=Math.round(sr*60/p.bpm/4), anySolo=rows.some(c=>c.solo), gl=Math.max(8,Math.round((n.stepLen||own)*p.gate));
    for(let i=0;i<BLOCK;i++){
      if(stuStep(n,I,i,own)){
        const st=((n.step%steps)+steps)%steps, sw=(st&1)?Math.round(p.swing*.33*(n.stepLen||own)):0;
        rows.forEach((ch,k)=>{ const ns=pat.notes[ch.id]; if(!ns) return; for(const q of ns) if(Math.floor(q.t/ST_STEP)===st) n.pend.push({k,v:q.v,key:q.k,at:i+sw}); });
        n.gStep=st;
      }
      for(let j=n.pend.length-1;j>=0;j--){ const e=n.pend[j]; if(e.at<=i){ n.pend.splice(j,1); const ch=rows[e.k]; if(!ch) continue; n.gl[e.k]=gl;
          if(ch.mute||(anySolo&&!ch.solo)) continue;
          const vs=n.vo[e.k]; if(vs.length>6) vs.shift();
          if(ch.type==='drum') vs.push(stJsDrumVoice(ch.p.kind,ch.p,e.v,sr,(Math.random()*1e9)|0));
          else if(ch.type==='sampler'){ const c=S.clips[ch.id]; if(c) vs.push(stJsClipVoice(c.data,c.sr,sr,e.key,ch.p.root,ch.p.pit,ch.p.vol,e.v)); } } }
      for(let k=0;k<8;k++) if(n.gl[k]>0){ G[k][i]=1; n.gl[k]--; }
    }
    if(n.pend.length) for(const e of n.pend) e.at-=BLOCK;
    // голоса строк → стерео-сумма
    const tmp=n._tmp||(n._tmp=new Float32Array(BLOCK));
    rows.forEach((ch,k)=>{ const vs=n.vo[k]; if(!vs.length) return; tmp.fill(0);
      for(let j=vs.length-1;j>=0;j--){ const v=vs[j]; if(ch.type==='drum') stJsDrumRender(v,tmp,BLOCK,0); else stJsClipRender(v,tmp,BLOCK,0); if(v.done) vs.splice(j,1); }
      const a=(ch.pan+1)*Math.PI/4, gl_=Math.cos(a)*ch.vol*p.gain, gr_=Math.sin(a)*ch.vol*p.gain;
      for(let i=0;i<BLOCK;i++){ L[i]+=tmp[i]*gl_; R[i]+=tmp[i]*gr_; } });
    for(let i=0;i<BLOCK;i++) O[i]=(L[i]+R[i])*.5;
    S.tickHead=n.step<0?null:(n.step*ST_STEP+ST_STEP*(n._pos||0)/Math.max(1,n.stepLen||own)); S.eng.playing=n._run;
    const o={out:O,L,R,step:Math.max(0,n.step)}; for(let k=0;k<8;k++) o['g'+(k+1)]=G[k]; return o;
  },
  drawKey:n=>n.S?n.S.rev+'|'+(n.S.P.channels.length):'',
  draw(n){ stuLiteTile(n,(S,host)=>{ const bar=new StuLiteBar(S,'steps · gate pins g1…g8 · clk in'); host.append(bar.el);
      const rk=new StuRack(S); host.append(rk.el); const ins=new StuInst(S); host.append(ins.el); rk.el.style.flex='1 1 55%'; ins.el.style.flex='1 1 45%'; }); }
});

/* ============================ PIANO ROLL ============================ */
function stuRollDefault(){
  const P=stNewProject(); P.name='Piano Roll'; const pat=stAddPattern(P,'Pattern 1',2), ch=stAddChannel(P,'synth','Notes',{},0);
  pat.notes[ch.id]=[]; const mel=[[0,2,69],[2,2,72],[4,2,76],[6,2,72],[8,2,67],[10,2,71],[12,2,74],[14,2,71],[16,2,65],[18,2,69],[20,2,72],[22,2,69],[24,4,67],[28,4,62]];
  for(const [s,l,k] of mel) pat.notes[ch.id].push({t:s*ST_STEP,l:l*ST_STEP,k,v:100});
  return P;
}
const STU_ROLL_OUTS=[{n:'step',t:'num'}];
for(let k=1;k<=4;k++){ const q=k>1?k:''; STU_ROLL_OUTS.push({n:'freq'+q,t:'num'},{n:'gate'+q,t:'sig'},{n:'vel'+q,t:'num'}); }
def({ id:'stuprl', lazy:'manual', title:'Piano Roll (Studio)', cat:'Music', resize:true, w:780, h:540, readout:true,
  ins:[...stuLiteIns,{n:'pat',t:'num'}],
  outs:STU_ROLL_OUTS,
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (no clk)'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'gatelen',t:'range',min:.05,max:1,step:.01,d:.9,label:'note length'},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=140; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuRollDefault); n.S.minSnap=ST_STEP; n.step=-1; n.samplesLeft=0; n.stepLen=0; n.built=false; n.tile=null;
    n.vc=[0,1,2,3].map(()=>({on:0,left:0,f:440,v:0,gap:0})); n.pend=[];
    n.S_info=()=>'step '+(n.step<0?0:(n.step%Math.max(1,(n.S.patObj()?n.S.patObj().bars:1)*16))+1);
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, G=[0,1,2,3].map(k=>buf(n,'gate'+(k?k+1:'')));
    for(const g of G) g.fill(0);
    const out=()=>{ const o={step:Math.max(0,n.step)}; n.vc.forEach((v,k)=>{ const q=k?k+1:''; o['freq'+q]=v.f; o['gate'+q]=G[k]; o['vel'+q]=v.v; }); return o; };
    if(!S) return out(); stuRunFlag(n,I);
    const P=S.P;
    if(typeof I.pat==='number'){ const q=P.patterns[Math.max(0,Math.min(P.patterns.length-1,Math.round(I.pat)))]; if(q && q.id!==S.cur.pat){ S.cur.pat=q.id; S.refreshPats(); } }
    const pat=S.patObj(), ch=S.chObj(); if(!pat||!ch) return out();
    const steps=pat.bars*16, own=Math.round(sr*60/p.bpm/4), notes=pat.notes[ch.id]||[];
    for(let i=0;i<BLOCK;i++){
      if(stuStep(n,I,i,own)){
        const st=((n.step%steps)+steps)%steps, sl=n.stepLen||own;
        for(const q of notes) if(Math.floor(q.t/ST_STEP)===st){
          let k=n.vc.findIndex(v=>!v.on); if(k<0){ k=0; for(let j=1;j<4;j++) if(n.vc[j].left<n.vc[k].left) k=j; }
          const v=n.vc[k]; v.gap=v.on?24:0; v.on=1; v.left=Math.max(8,Math.round(q.l/ST_STEP*sl*p.gatelen)); v.f=stHz(q.k); v.v=q.v/127; }
      }
      for(let k=0;k<4;k++){ const v=n.vc[k]; if(!v.on) continue; if(v.gap>0){ v.gap--; } else G[k][i]=1; if(--v.left<=0) v.on=0; }
    }
    S.tickHead=n.step<0?null:(n.step*ST_STEP+ST_STEP*(n._pos||0)/Math.max(1,n.stepLen||own)); S.eng.playing=n._run;
    return out();
  },
  drawKey:n=>n.S?n.S.rev+'':'',
  draw(n){ stuLiteTile(n,(S,host)=>{ const bar=new StuLiteBar(S,'clk in · freq / gate / vel ×4 out'); host.append(bar.el); const r=new StuRoll(S); host.append(r.el); r.el.style.flex='1';
      const opts=[...r.el.querySelectorAll('[data-o=snap] option')]; for(const o of opts) if(+o.value<S.minSnap) o.remove(); requestAnimationFrame(()=>{ r.resize(); r.fit(); }); }); }
});

/* ============================ PATTERN PLAYLIST ============================ */
function stuArrDefault(){
  const P=stNewProject(); P.name='Pattern Playlist'; P.playlist.tracks=8;
  const names=['Intro','Verse','Chorus','Break']; for(let i=0;i<4;i++) stAddPattern(P,names[i],4);
  const c=(pi,tr,bar,bars)=>stAddClip(P,P.patterns[pi],tr,bar*ST_BAR,bars);
  c(0,0,0,4); c(1,0,4,8); c(2,0,12,8); c(3,0,20,4); c(1,1,4,8); c(2,1,12,8); c(2,2,12,8); c(0,3,0,24);
  P.playlist.loop=[0,24*ST_BAR]; return P;
}
const STU_ARR_OUTS=[{n:'bar',t:'num'},{n:'step',t:'num'},{n:'end',t:'sig'}];
for(let k=1;k<=8;k++) STU_ARR_OUTS.push({n:'g'+k,t:'sig'},{n:'p'+k,t:'num'});
def({ id:'stuarr', lazy:'manual', title:'Pattern Playlist (Studio)', cat:'Music', resize:true, w:780, h:440, readout:true,
  ins:stuLiteIns,
  outs:STU_ARR_OUTS,
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (no clk)'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'loop',t:'check',d:true,label:'loop region'},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=140; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuArrDefault,{mode:'song'}); n.step=-1; n.samplesLeft=0; n.stepLen=0; n.built=false; n.tile=null; n._end=0;
    n.S_info=()=>'bar '+(n.step<0?1:Math.floor(n.step/16)+1);
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, E=buf(n,'end'); E.fill(0); const G=[]; for(let k=0;k<8;k++){ G[k]=buf(n,'g'+(k+1)); G[k].fill(0); }
    const o={bar:1,step:0,end:E}; if(!S){ for(let k=0;k<8;k++){ o['g'+(k+1)]=G[k]; o['p'+(k+1)]=0; } return o; }
    stuRunFlag(n,I); const P=S.P, own=Math.round(sr*60/p.bpm/4), lane=new Array(8).fill(null);
    const clips=P.playlist.clips.filter(c=>c.kind==='pat'), end=Math.max(ST_BAR,stSongEnd(P)), lp=p.loop&&P.playlist.loop?P.playlist.loop:null;
    const cur=new Array(8).fill(0);
    for(let i=0;i<BLOCK;i++){
      if(stuStep(n,I,i,own)){
        let t=n.step*ST_STEP;
        if(lp){ if(t>=lp[1]){ n.step=Math.floor(lp[0]/ST_STEP); t=lp[0]; } }
        else if(t>=end){ E[i]=1; n.step=-1; n.samplesLeft=0; t=0; n._run=false; setMod(n,'run',false); }
        for(let k=0;k<8;k++){ cur[k]=0; for(const c of clips) if(c.tr===k && t>=c.t && t<c.t+c.l){ cur[k]=P.patterns.findIndex(x=>x.id===c.pat)+1; break; } }
        n.cur=cur.slice();
      }
      const cc=n.cur||cur; for(let k=0;k<8;k++) if(cc[k]) G[k][i]=1;
    }
    for(let k=0;k<8;k++){ o['g'+(k+1)]=G[k]; o['p'+(k+1)]=(n.cur||cur)[k]-1>=0?(n.cur||cur)[k]-1:0; }
    o.bar=Math.floor(Math.max(0,n.step)/16)+1; o.step=Math.max(0,n.step);
    S.tickHead=n.step<0?null:(n.step*ST_STEP+ST_STEP*(n._pos||0)/Math.max(1,n.stepLen||own)); S.eng.playing=n._run; S.mode='song';
    return o;
  },
  drawKey:n=>n.S?n.S.rev+'':'',
  draw(n){ stuLiteTile(n,(S,host)=>{ const l=new StuList(S); host.append(l.el); l.el.style.flex='1'; requestAnimationFrame(()=>{ l.resize(); l.fit(); }); }); }
});

/* ============================ MIXER ============================ */
function stuMixDefault(){
  const P=stNewProject(); P.name='Mixer'; P.mixer.length=9;
  for(let i=1;i<=8;i++){ P.mixer[i].name='Ch '+i; P.mixer[i].vol=.8; }
  P.mixer[8].name='Reverb bus'; P.mixer[8].vol=.7; P.mixer[8].fx.push({id:stNextId(P),type:'reverb',on:true,p:stFillP(ST_FX.reverb.p,{size:3.5,mix:1,damp:.6})});
  return P;
}
const STU_MIX_INS=[]; for(let k=1;k<=8;k++) STU_MIX_INS.push({n:'in'+k,t:'sig'});
for(let k=1;k<=8;k++) STU_MIX_INS.push({n:'g'+k,t:'sig'});
def({ id:'stumixer', lazy:'manual', title:'Mixer (Studio)', cat:'Music', resize:true, w:780, h:540, readout:true,
  ins:[...STU_MIX_INS,{n:'bpm',t:'num'}],
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'out',t:'sig'},{n:'left',t:'num'}],
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (pump / gate / delay)'},
    {n:'timer',t:'range',min:0,max:720,step:1,d:0,label:'sleep timer, min (0 = off)'},
    {n:'fade',t:'range',min:1,max:900,step:1,d:60,label:'fade-out, s'},
    {n:'restart',t:'button',label:'↻ restart timer',fn:n=>{ n._tl=null; }},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=205; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuMixDefault,{maxMix:8}); n.built=false; n.tile=null; n.fxs=new Map(); n.sv=new Float32Array(9).fill(0); n.acc=[]; n.idle=new Int32Array(9); n.lvv=new Float32Array(9); n._beat=0; n._tl=null;
    n.S_info=()=>n._tl!=null&&n.p.timer>0?'sleep in '+Math.floor(n._tl/60)+':'+String(Math.floor(n._tl%60)).padStart(2,'0'):'';
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, L=buf(n,'L'), R=buf(n,'R'), O=buf(n,'out'); L.fill(0); R.fill(0);
    if(!S){ O.fill(0); return {L,R,out:O,left:0}; }
    const P=S.P, bpm=typeof I.bpm==='number'&&I.bpm>=40?I.bpm:p.bpm, ctx={bpm,beat:n._beat}; n._beat+=BLOCK*bpm/60/sr;
    const fxFor=(f,mono)=>{ let e=n.fxs.get(f.id); if(!e||e.type!==f.type){ e={type:f.type,proc:stFxNew(f.type,sr)}; n.fxs.set(f.id,e); } if(e.proc) e.proc.set(f.p,ctx); return e.proc; };
    for(let i=0;i<=8;i++) if(!n.acc[i]) n.acc[i]=new Float32Array(BLOCK);
    const work=n._w||(n._w=new Float32Array(BLOCK)), anySolo=P.mixer.some((m,i)=>i&&m.solo);
    for(let i=1;i<=8;i++){
      const m=P.mixer[i]; if(!m) continue; const inp=I['in'+i], acc=n.acc[i], gt=I['g'+i];
      let act=!!inp; if(!act) for(let j=0;j<BLOCK;j+=16) if(acc[j]!==0){ act=true; break; }
      if(act) n.idle[i]=Math.round(sr*4); else if(n.idle[i]>0) n.idle[i]-=BLOCK;
      if(n.idle[i]<=0){ n.lvv[i]*=.9; acc.fill(0); continue; }
      if(inp) for(let j=0;j<BLOCK;j++) work[j]=inp[j]+acc[j]; else work.set(acc);
      acc.fill(0);
      for(const f of m.fx) if(f.on){ const pr=fxFor(f,true); if(pr) pr.run(work,null,BLOCK); }
      const aud=!m.mute&&(!anySolo||m.solo), tg=aud?m.vol:0; let sv=n.sv[i], pk=0;
      const pa=(m.pan+1)*Math.PI/4, gl=Math.cos(pa), gr=Math.sin(pa), sends=m.sends;
      for(let j=0;j<BLOCK;j++){ sv+=((gt?tg*(gt[j]>.5?1:gt[j]<0?0:gt[j]):tg)-sv)*.004; const x=work[j]*sv; L[j]+=x*gl; R[j]+=x*gr; const a=Math.abs(x); if(a>pk) pk=a; work[j]=x; }
      n.sv[i]=sv; n.lvv[i]=Math.max(pk,n.lvv[i]*.9);
      for(const t in sends){ const ta=n.acc[+t]; if(!ta||+t===i) continue; const lv=sends[t]; for(let j=0;j<BLOCK;j++) ta[j]+=work[j]*lv; }
    }
    // мастер
    const M=P.mixer[0]; for(const f of M.fx) if(f.on){ const pr=fxFor(f,false); if(pr) pr.run(L,R,BLOCK); }
    // таймер сна: плавное затухание в последние fade секунд
    let tg=1; if(p.timer>0){ if(n._tl==null) n._tl=p.timer*60; if(n._tl>0) n._tl=Math.max(0,n._tl-BLOCK/sr); tg=n._tl>=p.fade?1:n._tl/p.fade; } else n._tl=null;
    let mv=n._mv==null?M.vol:n._mv, pk=0; const tv=M.vol*tg;
    for(let j=0;j<BLOCK;j++){ mv+=(tv-mv)*.004; const l=Math.max(-1,Math.min(1,L[j]*mv)), r=Math.max(-1,Math.min(1,R[j]*mv)); L[j]=l; R[j]=r; O[j]=(l+r)*.5; const a=Math.max(Math.abs(l),Math.abs(r)); if(a>pk) pk=a; }
    n._mv=mv; n.lvv[0]=Math.max(pk,n.lvv[0]*.9);
    S.lv=n.lvv; S.eng.playing=true;
    return {L,R,out:O,left:n._tl==null?0:n._tl};
  },
  drawKey:n=>n.S?n.S.rev+'|'+(n.S_info?n.S_info():''):'',
  draw(n){ stuLiteTile(n,(S,host)=>{ const m=new StuMixer(S); host.append(m.el); m.el.style.flex='1'; }); if(n.ro) n.ro.textContent=n.S_info?n.S_info():''; }
});
