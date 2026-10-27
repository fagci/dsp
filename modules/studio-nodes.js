"use strict";
/* ============================ STUDIO: УЗЛЫ ГРАФА ============================
   Студия — это узлы графа и провода между ними, другой студии нет. Drum Machine, Piano Roll, Pattern Playlist, Mixer и эффекты
   (EQ, Compressor, Delay, Reverb…) — обычные модули: пины (clk / run / reset / pat на входе; gate, freq, vel, звук на выходе),
   данные в параметре узла, редактор внутри узла. Master Clock → Pattern Playlist → Drum Machine / Piano Roll → Synth → Mixer → DAC. */

let StuFocus=null;                               // узел-редактор, получающий клавиши (последний, по чьей панели кликали)
addEventListener('keydown',ev=>{ if(StuFocus && !StuFocus.dead && StuFocus.panels.size) StuFocus.onKey(ev,true); },true);
addEventListener('pointerdown',ev=>{ if(StuFocus && !ev.target.closest('.stu-panel,.stu-menu')) StuFocus=null; },true);

/* ---------- данные и правка узла: то, что нужно панелям-редакторам (стойка, ролл, плейлист, микшер), хранится в самом узле ---------- */
class StuLite{
  constructor(node,make,opt){
    opt=opt||{}; this.node=node; this.panels=new Set(); this.dead=false; this.snap=ST_STEP; this.minSnap=ST_STEP; this.mode=opt.mode||'pat';
    this.pos=0; this.tickHead=null; this.msg=''; this.cur={pat:0,ch:0,ins:1,slot:-1}; this.focusPanel=null; this.raf=0; this.full=null; this.maxMix=opt.maxMix||0;
    this.clips={}; this.undo=[]; this.redoS=[]; this.rev=1; this.lv=null; this.makeDefault=make; this.kind=opt.kind||''; this.song=null; this._pv=null; this.selCh=0; this.seenGen=0; this.seenRev=0;
    const self=this;
    this.eng={playing:false,view:{},samples:{},rig:null,ac:null,ensure(){},extSetup(){},extRoute(){},noteOn(){},noteOff(){},
      async loadClip(chId,id){ const c=await SampleDB.getClip(id); if(!c) throw new Error('clip not found'); self.clips[chId]={data:c.samples,sr:c.sr,name:c.name};
        this.samples[chId]={buf:{getChannelData:()=>c.samples,duration:c.samples.length/c.sr},name:c.name}; self.rev++; },
      async loadSample(chId,f){ const d=await decodeAudioFile(f); self.clips[chId]={data:d.samples||d.data,sr:d.sr,name:f.name};
        this.samples[chId]={buf:{getChannelData:()=>self.clips[chId].data},name:f.name}; self.rev++; }};
    let P=null; try{ if(node.p.data) P=stLoad(node.p.data); }catch(e){ console.warn('studio node data',e); }
    this._P=P||make();
    this.cur.pat=this._P.patterns[0]?this._P.patterns[0].id:0; this.cur.ch=this._P.channels[0]?this._P.channels[0].id:0;
    this.undo=[JSON.stringify(this._P)]; if(!node.p.data) node.p.data=this.undo[0];
    setTimeout(()=>this.loadClips(),0);
  }
  // P — то, что видят панели: данные узла или (провод song) данные композиции; root — настоящие данные, в которые пишет правка
  get P(){ return this.song ? this._pv : this._P; }
  get root(){ return this.song ? this.song.P : this._P; }
  // подключили / отключили узел Song: те же панели, но данные — общие с композицией
  bindSong(song){
    this.song=song||null; this._pv=null; this.clips={}; this.eng.samples={};
    if(song){ this.seenGen=song.gen; this.seenRev=song.rev;
      const R=song.P, kind=this.kind, self=this;
      this._pv=new Proxy(R,{get(t,k){ if(k==='channels'){ const c=t.channels;
          return kind==='drum' ? c.filter(x=>x.type==='drum'||x.type==='sampler'||x.type==='ext') : kind==='roll' ? c.filter(x=>x.id===self.selCh) : c; } return t[k]; },
        set(t,k,v){ t[k]=v; return true; }}); }
    const P=this.P; this.cur.pat=P.patterns[0]?P.patterns[0].id:0; this.cur.ch=P.channels[0]?P.channels[0].id:0;
    this.loadClips(); this.rev++; this.refreshAll();
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
    if(this.song){ this.song.commit(); this.seenRev=this.song.rev; this.rev++; return; }
    const s=JSON.stringify(this._P); if(s===this.undo[this.undo.length-1]) return;
    this.undo.push(s); if(this.undo.length>80) this.undo.shift(); this.redoS=[]; this.node.p.data=s; this.rev++;
  }
  restore(s){ const P=stLoad(s); for(const k of Object.keys(this._P)) delete this._P[k]; Object.assign(this._P,P);
    if(!this.patObj()) this.cur.pat=this._P.patterns[0]?this._P.patterns[0].id:0; if(!this.chObj()) this.cur.ch=this._P.channels[0]?this._P.channels[0].id:0;
    this.node.p.data=s; this.rev++; this.refreshAll(); }
  doUndo(){ if(this.song){ this.song.doUndo(); return; } if(this.undo.length<2) return; this.redoS.push(this.undo.pop()); this.restore(this.undo[this.undo.length-1]); }
  doRedo(){ if(this.song){ this.song.doRedo(); return; } if(!this.redoS.length) return; const s=this.redoS.pop(); this.undo.push(s); this.restore(s); }
  onKey(ev,down){
    const tg=ev.target; if(tg && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName) && !(tg.type==='range'||tg.type==='button')) return;
    if(!down) return; const k=ev.key, mod=ev.ctrlKey||ev.metaKey;
    if(mod && k.toLowerCase()==='z'){ ev.preventDefault(); ev.shiftKey?this.doRedo():this.doUndo(); return; }
    if(mod && k.toLowerCase()==='y'){ ev.preventDefault(); this.doRedo(); return; }
    const f=this.focusPanel; if(f && (f.kind==='roll'||f.kind==='list') && f.key(ev)) ev.preventDefault();
  }
  patMenu(ev){
    const P=this.P, pat=this.patObj(); if(!pat) return;
    stuMenu(ev.clientX,ev.clientY,[
      {label:'Rename…',fn:()=>{ const n=prompt('Pattern name',pat.name); if(n){ pat.name=n; this.commit(); this.refreshAll(); } }},
      {label:'Clone',fn:()=>{ const c=stClonePattern(P,pat); this.cur.pat=c.id; this.commit(); this.refreshAll(); }},
      {label:'Length: '+pat.bars+' bar(s) — change…',fn:()=>{ const n=+prompt('Length in bars (1–32)',pat.bars); if(n>=1&&n<=32){ pat.bars=Math.round(n); this.commit(); this.refreshAll(); } }},
      {label:'Clear notes',fn:()=>{ pat.notes={}; this.commit(); this.refreshAll(); }},
      {sep:1},
      {label:'Delete',dis:P.patterns.length<2,fn:()=>{ stRemovePattern(P,pat.id); this.cur.pat=P.patterns[0].id; this.commit(); this.refreshAll(); }}]);
  }
  // строки drum machine: до 8 штук
  addMenu(x,y){
    const rows=this.P.channels.length; if(rows>=(this.song?16:8)){ this.say('8 rows maximum'); return; }
    const items=Object.keys(ST_KITS).map(n=>({label:'Drum: '+n,fn:()=>this.addRow('drum',n,ST_KITS[n])}));
    items.push({sep:1},{label:'Clip row (sample from Files › audio)',fn:()=>this.addRow('sampler','Clip',{})},{label:'Trigger row (gate pin only)',fn:()=>this.addRow('ext','Trigger',{})});
    stuMenu(x,y,items);
  }
  addRow(type,name,p){ const ch=stAddChannel(this.root,type,name,p,0); this.cur.ch=ch.id; this.commit(); this.refreshAll(); }
  chMenu(ev,ch){
    const P=this.P;
    stuMenu(ev.clientX,ev.clientY,[
      {label:'Rename…',fn:()=>{ const n=prompt('Row name',ch.name); if(n){ ch.name=n; this.commit(); this.refreshAll(); } }},
      {label:'Move up',dis:!!this.song||P.channels.indexOf(ch)===0,fn:()=>{ const i=P.channels.indexOf(ch); P.channels.splice(i,1); P.channels.splice(i-1,0,ch); this.commit(); this.refreshRack(); }},
      {label:'Move down',dis:!!this.song||P.channels.indexOf(ch)===P.channels.length-1,fn:()=>{ const i=P.channels.indexOf(ch); P.channels.splice(i,1); P.channels.splice(i+1,0,ch); this.commit(); this.refreshRack(); }},
      {label:'Clear steps in this pattern',fn:()=>{ const p=this.patObj(); if(p) delete p.notes[ch.id]; this.commit(); this.refreshAll(); }},
      {sep:1},
      {label:'Delete row',fn:()=>{ stRemoveChannel(this.root,ch.id); this.cur.ch=this.P.channels[0]?this.P.channels[0].id:0; this.commit(); this.refreshAll(); }}]);
  }
}

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
// вход song: данные композиции из узла Song. Возвращает bpm композиции или null, если провода нет
function stuSongIn(n,I){
  const S=n.S, sg=I.song||null;
  if(sg!==S.song) S.bindSong(sg);
  else if(sg){ if(S.seenGen!==sg.gen) S.bindSong(sg); else if(S.seenRev!==sg.rev){ S.seenRev=sg.rev; S.refreshAll(); } }
  return sg?sg.P.bpm:null;
}
// вход pat: номер паттерна (0…) выбирает его; отрицательный — «клипа нет» (так выдаёт полоса Pattern Playlist): узел молчит
function stuPatIn(n,I){
  n._mute=false; if(typeof I.pat!=='number') return;
  const S=n.S, P=S.P; if(I.pat<0){ n._mute=true; return; }
  const q=P.patterns[Math.max(0,Math.min(P.patterns.length-1,Math.round(I.pat)))];
  if(q && q.id!==S.cur.pat){ S.cur.pat=q.id; S.refreshPats(); }
}
// сцены дорожки микшера: «1,3-4» → множество номеров паттернов (с 1)
function stuParseScenes(str){
  const set=new Set(); for(const part of String(str||'').split(',')){ const m=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/); if(!m) continue; const a=+m[1], b=m[2]?+m[2]:a; for(let i=a;i<=Math.min(b,a+99);i++) set.add(i); }
  return set;
}
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
  ins:[...stuLiteIns,{n:'pat',t:'num'},{n:'song',t:'song'}],
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
    n.S=new StuLite(n,stuDrumDefault,{kind:'drum'}); n.S.liteKind='drum'; n.step=-1; n.samplesLeft=0; n.stepLen=0; n.vo=[[],[],[],[],[],[],[],[]]; n.gl=new Float32Array(8); n.pend=[]; n.built=false; n.tile=null; n._rev=0;
    n.S_info=()=>'step '+(n.step<0?0:(n.step%Math.max(1,(n.S.patObj()?n.S.patObj().bars:1)*16))+1);
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, L=buf(n,'L'), R=buf(n,'R'), O=buf(n,'out'); L.fill(0); R.fill(0); O.fill(0);
    const G=[]; for(let k=0;k<8;k++){ G[k]=buf(n,'g'+(k+1)); G[k].fill(0); }
    if(!S) return {out:O,L,R,step:0}; stuRunFlag(n,I);
    const sbpm=stuSongIn(n,I), bpm=sbpm||p.bpm, P=S.P, rows=P.channels.slice(0,8);
    stuPatIn(n,I);
    const pat=S.patObj(); if(!pat) return {out:O,L,R,step:n.step};
    const steps=pat.bars*16, own=Math.round(sr*60/bpm/4), anySolo=rows.some(c=>c.solo), gl=Math.max(8,Math.round((n.stepLen||own)*p.gate));
    for(let i=0;i<BLOCK;i++){
      if(stuStep(n,I,i,own)){
        const st=((n.step%steps)+steps)%steps, sw=(st&1)?Math.round((S.song?S.song.P.swing:p.swing)*.33*(n.stepLen||own)):0;
        rows.forEach((ch,k)=>{ const ns=pat.notes[ch.id]; if(!ns||n._mute) return; for(const q of ns) if(Math.floor(q.t/ST_STEP)===st) n.pend.push({k,v:q.v,key:q.k,at:i+sw}); });
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
  ins:[...stuLiteIns,{n:'pat',t:'num'},{n:'song',t:'song'}],
  outs:STU_ROLL_OUTS,
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (no clk)'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'gatelen',t:'range',min:.05,max:1,step:.01,d:.9,label:'note length'},
    {n:'ch',t:'select',d:'',label:'channel (from Song)',opts:n=>['',...(n.S&&n.S.song?n.S.song.P.channels.filter(c=>c.type!=='drum').map(c=>c.name):[])]},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=140; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuRollDefault,{kind:'roll'}); n.S.minSnap=ST_STEP; n.step=-1; n.samplesLeft=0; n.stepLen=0; n.built=false; n.tile=null;
    n.vc=[0,1,2,3].map(()=>({on:0,left:0,f:440,v:0,gap:0})); n.pend=[];
    n.S_info=()=>'step '+(n.step<0?0:(n.step%Math.max(1,(n.S.patObj()?n.S.patObj().bars:1)*16))+1);
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, G=[0,1,2,3].map(k=>buf(n,'gate'+(k?k+1:'')));
    for(const g of G) g.fill(0);
    const out=()=>{ const o={step:Math.max(0,n.step)}; n.vc.forEach((v,k)=>{ const q=k?k+1:''; o['freq'+q]=v.f; o['gate'+q]=G[k]; o['vel'+q]=v.v; }); return o; };
    if(!S) return out(); stuRunFlag(n,I);
    // канал берётся из композиции по имени (параметр ch), по умолчанию — первый не-ударный
    if(S.song){ const cs=S.song.P.channels.filter(c=>c.type!=='drum'), c=cs.find(x=>x.name===p.ch)||cs[0]; S.selCh=c?c.id:0; }
    const sbpm=stuSongIn(n,I); if(S.song){ if(S.cur.ch!==S.selCh){ S.cur.ch=S.selCh; S.refreshAll(); } }
    const P=S.P;
    stuPatIn(n,I);
    const pat=S.patObj(), ch=S.chObj(); if(!pat||!ch) return out();
    const steps=pat.bars*16, own=Math.round(sr*60/(sbpm||p.bpm)/4), notes=pat.notes[ch.id]||[];
    for(let i=0;i<BLOCK;i++){
      if(stuStep(n,I,i,own)){
        const st=((n.step%steps)+steps)%steps, sl=n.stepLen||own;
        if(!n._mute) for(const q of notes) if(Math.floor(q.t/ST_STEP)===st){
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
  ins:[...stuLiteIns,{n:'song',t:'song'}],
  outs:STU_ARR_OUTS,
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (no clk)'},
    {n:'run',t:'check',d:true,label:'run'},
    {n:'loop',t:'check',d:true,label:'loop region'},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=140; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuArrDefault,{mode:'song',kind:'list'}); n.step=-1; n.samplesLeft=0; n.stepLen=0; n.built=false; n.tile=null; n._end=0;
    n.S_info=()=>'bar '+(n.step<0?1:Math.floor(n.step/16)+1);
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, E=buf(n,'end'); E.fill(0); const G=[]; for(let k=0;k<8;k++){ G[k]=buf(n,'g'+(k+1)); G[k].fill(0); }
    const o={bar:1,step:0,end:E}; if(!S){ for(let k=0;k<8;k++){ o['g'+(k+1)]=G[k]; o['p'+(k+1)]=-1; } return o; }
    stuRunFlag(n,I); const sbpm=stuSongIn(n,I), P=S.P, own=Math.round(sr*60/(sbpm||p.bpm)/4);
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
    for(let k=0;k<8;k++){ o['g'+(k+1)]=G[k]; o['p'+(k+1)]=(n.cur||cur)[k]-1; }
    o.bar=Math.floor(Math.max(0,n.step)/16)+1; o.step=Math.max(0,n.step);
    S.tickHead=n.step<0?null:(n.step*ST_STEP+ST_STEP*(n._pos||0)/Math.max(1,n.stepLen||own)); S.eng.playing=n._run; S.mode='song';
    return o;
  },
  drawKey:n=>n.S?n.S.rev+'':'',
  draw(n){ stuLiteTile(n,(S,host)=>{ const l=new StuList(S); host.append(l.el); l.el.style.flex='1'; requestAnimationFrame(()=>{ l.resize(); l.fit(); }); }); }
});

/* ============================ MIXER ============================ */
// мягкий потолок мастера: до 0.8 линейно, выше — плавно к 1.0 (громкая композиция не трещит жёстким клиппером)
const stuSoft=x=>{ const a=x<0?-x:x; return a<=.8 ? x : (x<0?-1:1)*(.8+.2*Math.tanh((a-.8)/.2)); };
function stuMixDefault(){
  const P=stNewProject(); P.name='Mixer';
  for(let i=1;i<=8;i++){ P.mixer[i].name='Ch '+i; P.mixer[i].vol=.8; }
  P.mixer[8].name='Reverb bus'; P.mixer[8].vol=.7; P.mixer[8].fx.push({id:stNextId(P),type:'reverb',on:true,p:stFillP(ST_FX.reverb.p,{size:3.5,mix:1,damp:.6})});
  return P;
}
const STU_MIX_INS=[]; for(let k=1;k<=8;k++) STU_MIX_INS.push({n:'in'+k,t:'sig'});
for(let k=1;k<=8;k++) STU_MIX_INS.push({n:'g'+k,t:'sig'});
def({ id:'stumixer', lazy:'manual', title:'Mixer (Studio)', cat:'Music', resize:true, w:780, h:540, readout:true,
  ins:[...STU_MIX_INS,{n:'bpm',t:'num'},{n:'scene',t:'num'},{n:'song',t:'song'}],
  outs:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'out',t:'sig'},{n:'left',t:'num'}],
  params:[
    {n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (pump / gate / delay)'},
    {n:'timer',t:'range',min:0,max:720,step:1,d:0,label:'sleep timer, min (0 = off)'},
    {n:'fade',t:'range',min:1,max:900,step:1,d:60,label:'fade-out, s'},
    {n:'restart',t:'button',label:'↻ restart timer',fn:n=>{ n._tl=null; }},
    {n:'data',t:'text',d:'',hidden:true}],
  init(n){
    n.tileOff=205; n.onResize=ln=>stuLiteFit(ln);
    n.S=new StuLite(n,stuMixDefault,{kind:'mixer'}); n.S.liteKind='mixer'; n.scn=[]; n.built=false; n.tile=null; n.fxs=new Map(); n.sv=new Float32Array(17).fill(0); n.acc=[]; n.idle=new Int32Array(17); n.lvv=new Float32Array(17); n._beat=0; n._tl=null;
    n.S_info=()=>n._tl!=null&&n.p.timer>0?'sleep in '+Math.floor(n._tl/60)+':'+String(Math.floor(n._tl%60)).padStart(2,'0'):'';
  },
  dispose:stuLiteDispose,
  process(n,I){
    const S=n.S, sr=Eng.sr, p=n.p, L=buf(n,'L'), R=buf(n,'R'), O=buf(n,'out'); L.fill(0); R.fill(0);
    if(!S){ O.fill(0); return {L,R,out:O,left:0}; }
    const sbpm=stuSongIn(n,I), P=S.P, bpm=typeof I.bpm==='number'&&I.bpm>=40?I.bpm:(sbpm||p.bpm), ctx={bpm,beat:n._beat}; n._beat+=BLOCK*bpm/60/sr;
    const fxFor=(f,mono)=>{ let e=n.fxs.get(f.id); if(!e||e.type!==f.type){ e={type:f.type,proc:stFxNew(f.type,sr)}; n.fxs.set(f.id,e); } if(e.proc) e.proc.set(f.p,ctx); return e.proc; };
    for(let i=0;i<=16;i++) if(!n.acc[i]) n.acc[i]=new Float32Array(BLOCK);
    const work=n._w||(n._w=new Float32Array(BLOCK)), anySolo=P.mixer.some((m,i)=>i&&m.solo);
    for(let i=1;i<=16;i++){
      const m=P.mixer[i]; if(!m) continue; const inp=I['in'+i], acc=n.acc[i], gt=I['g'+i];
      let act=!!inp; if(!act) for(let j=0;j<BLOCK;j+=16) if(acc[j]!==0){ act=true; break; }
      if(act) n.idle[i]=Math.round(sr*4); else if(n.idle[i]>0) n.idle[i]-=BLOCK;
      if(n.idle[i]<=0){ n.lvv[i]*=.9; acc.fill(0); continue; }
      if(inp) for(let j=0;j<BLOCK;j++) work[j]=inp[j]+acc[j]; else work.set(acc);
      acc.fill(0);
      for(const f of m.fx) if(f.on){ const pr=fxFor(f,true); if(pr) pr.run(work,null,BLOCK); }
      // сцены: дорожка звучит только в указанных паттернах (номер приходит на вход scene, например с полосы Pattern Playlist)
      let inScene=true; if(typeof I.scene==='number' && m.scenes){ let e=n.scn[i]; if(!e||e.src!==m.scenes) e=n.scn[i]={src:m.scenes,set:stuParseScenes(m.scenes)}; if(e.set.size) inScene=I.scene>=0 && e.set.has(Math.round(I.scene)+1); }
      const aud=!m.mute&&inScene&&(!anySolo||m.solo), tg=aud?m.vol:0; let sv=n.sv[i], pk=0;
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
    for(let j=0;j<BLOCK;j++){ mv+=(tv-mv)*.004; const l=stuSoft(L[j]*mv), r=stuSoft(R[j]*mv); L[j]=l; R[j]=r; O[j]=(l+r)*.5; const a=Math.max(Math.abs(l),Math.abs(r)); if(a>pk) pk=a; }
    n._mv=mv; n.lvv[0]=Math.max(pk,n.lvv[0]*.9);
    S.lv=n.lvv; S.eng.playing=true;
    return {L,R,out:O,left:n._tl==null?0:n._tl};
  },
  drawKey:n=>n.S?n.S.rev+'|'+(n.S_info?n.S_info():''):'',
  draw(n){ stuLiteTile(n,(S,host)=>{ const m=new StuMixer(S); host.append(m.el); m.el.style.flex='1'; }); if(n.ro) n.ro.textContent=n.S_info?n.S_info():''; }
});

/* ============================ ЭФФЕКТЫ: по узлу на эффект ============================ */
// EQ, Compressor, Filter, Distortion, Bitcrusher, Chorus, Phaser, Delay, Reverb, Pump, Trance Gate, Stereo Width.
// Вход L (и R; без R — моно), выход L / R. Delay, Pump и Gate привязаны к темпу: bpm (параметр или вход), либо clk — импульсы 1/16.
const STU_FX_TITLE={eq:'EQ',comp:'Compressor',filter:'Filter',dist:'Distortion',crush:'Bitcrusher',chorus:'Chorus',phaser:'Phaser',delay:'Delay',reverb:'Reverb',pump:'Pump (sidechain)',gate:'Trance Gate',width:'Stereo Width'};
for(const type of ST_FX_ORDER){
  const defs=ST_FX[type].p, tempo=['delay','pump','gate'].includes(type);
  const params=defs.map(d=>d.t==='sel' ? {n:d.k,t:'select',opts:d.o,d:d.d,label:d.label}
    : d.t==='chk' ? {n:d.k,t:'check',d:!!d.d,label:d.label}
    : {n:d.k,t:'range',min:d.min,max:d.max,step:d.step||(d.log?d.min/20:(d.max-d.min)/1000),d:d.d,log:!!d.log,label:d.label+(d.u&&d.u!=='x'?', '+d.u:'')});
  if(tempo) params.push({n:'bpm',t:'range',min:40,max:300,step:1,d:120,label:'bpm (no clk / bpm input)'});
  def({ id:'stufx_'+type, title:STU_FX_TITLE[type]+' (Studio)', cat:'Audio', w:250,
    ins:[{n:'L',t:'sig'},{n:'R',t:'sig'},...(tempo?[{n:'bpm',t:'num'},{n:'clk',t:'sig'}]:[])],
    outs:[{n:'L',t:'sig'},{n:'R',t:'sig'}],
    params,
    init(n){ n.proc=stFxNew(type,Eng.sr); n._beat=0; n._clkN=0; },
    process(n,I){
      const L=buf(n,'L'), R=buf(n,'R'), a=I.L, b=I.R||I.L;
      if(!a){ L.fill(0); R.fill(0); return {L,R}; }
      if(!n.proc || n.proc.sr!==Eng.sr) n.proc=stFxNew(type,Eng.sr);
      L.set(a); R.set(b);
      const bpm=typeof I.bpm==='number'&&I.bpm>=40?I.bpm:(n.p.bpm||120);
      if(I.clk){ n._beat=n._clkN/4; for(let i=0;i<BLOCK;i++) if(I.clk[i]>.5) n._clkN++; } 
      n.proc.set(stFillP(defs,n.p),{bpm,beat:n._beat});
      n.proc.run(L,R,BLOCK);
      if(!I.clk) n._beat+=BLOCK*bpm/60/Eng.sr;
      return {L,R};
    } });
}

/* ============================ SONG: композиция в узле ============================ */
// Узел Song держит композицию (паттерны, каналы, плейлист, микшер), загружает и сохраняет её (Files › Songs, файл .json, примеры)
// и отдаёт проводом song всем блокам, которые от неё зависят: Pattern Playlist, Drum Machine, Piano Roll, Mixer. Блоки правят общие данные,
// узел Song их сохраняет. Без провода song блок работает на собственных данных.
class StuSong{
  constructor(node){
    this.node=node; this.gen=1; this.rev=1; this.undo=[]; this.redoS=[]; this.dead=false;
    let P=null; try{ if(node.p.data) P=stLoad(node.p.data); }catch(e){ console.warn('song data',e); }
    this.P=P||stDemoProject(); this.undo=[JSON.stringify(this.P)]; node.p.data=this.undo[0];
  }
  commit(){ const s=JSON.stringify(this.P); if(s===this.undo[this.undo.length-1]) return; this.undo.push(s); if(this.undo.length>80) this.undo.shift(); this.redoS=[]; this.node.p.data=s; this.rev++; }
  restore(s){ const P=stLoad(s); for(const k of Object.keys(this.P)) delete this.P[k]; Object.assign(this.P,P); this.node.p.data=s; this.rev++; }
  doUndo(){ if(this.undo.length<2) return; this.redoS.push(this.undo.pop()); this.restore(this.undo[this.undo.length-1]); }
  doRedo(){ if(!this.redoS.length) return; const s=this.redoS.pop(); this.undo.push(s); this.restore(s); }
  load(P){ this.P=P; this.gen++; this.rev++; this.undo=[JSON.stringify(P)]; this.redoS=[]; this.node.p.data=this.undo[0]; }
}
const stuDl=(name,blob)=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000); };
// композиции лежат в Files, папка Songs
async function stuSongDir(create){
  const f=(await FileStore.listFolders('files')).find(x=>x.name==='Songs'); if(f) return f.id;
  return create ? FileStore.addFolder('files','Songs') : null;
}
async function stuSongList(){ const d=await stuSongDir(false); return d==null ? [] : (await FileStore.list('files',d)).filter(r=>/\.json$/i.test(r.name)).sort((a,b)=>b.modified-a.modified); }
async function stuSongSave(P,name){
  const d=await stuSongDir(true), file=name.replace(/[\\/]/g,'_')+'.studio.json', old=(await FileStore.list('files',d)).find(r=>r.name===file);
  const blob=new Blob([JSON.stringify(P)],{type:'application/json'});
  return FileStore.put({id:old?old.id:undefined,space:'files',folderId:d,name:file,mime:'application/json',blob});
}
function stuSongBlank(){
  const P=stuDrumDefault(); P.name='New song'; P.bpm=120; stAddChannel(P,'synth','Synth',stPatchP('Supersaw Lead'),5); P.playlist.tracks=8;
  const pat=P.patterns[0]; stAddClip(P,pat,0,0,4); P.playlist.loop=[0,4*ST_BAR]; P.mixer[1].name='Drums'; P.mixer[5].name='Synth'; return P;
}
function stuSongTile(n){
  if(!n.mid) return;
  if(!n.tile){ n.tile=document.createElement('div'); n.tile.className='stu stu-tile stu-song'; stuLiteFit(n); }
  if(!n.mid.contains(n.tile)) n.mid.append(n.tile);
  const S=n.S; if(!S) return; const key=S.gen+'|'+S.rev; if(n._tk===key) return; n._tk=key;
  const P=S.P, T=n.tile, say=m=>{ n.status=m; redraw(n); };
  T.innerHTML='';
  const top=stuEl('div','stu-top'); T.append(top);
  const nm=stuEl('input'); nm.value=P.name; nm.title='Song name'; nm.style.width='160px'; nm.addEventListener('change',()=>{ P.name=nm.value||'Song'; S.commit(); });
  const bp=stuEl('input'); bp.type='number'; bp.min=40; bp.max=300; bp.value=P.bpm; bp.addEventListener('change',()=>{ P.bpm=Math.max(40,Math.min(300,+bp.value||120)); S.commit(); });
  const sw=stuEl('input'); sw.type='range'; sw.min=0; sw.max=1; sw.step=.01; sw.value=P.swing; sw.addEventListener('change',()=>{ P.swing=+sw.value; S.commit(); });
  top.append(nm,stuEl('label','stu-f','BPM ')); top.lastChild.append(bp); const lb=stuEl('label','stu-f','Swing '); lb.append(sw); top.append(lb,stuEl('span','stu-sep'));
  const btn=(txt,tip,fn)=>{ const b=stuEl('button','stu-b',txt); b.title=tip; b.addEventListener('click',fn); top.append(b); return b; };
  btn('📂 Load ▾','Load a composition: examples, saved in Files › Songs, or a file',async ev=>{
    const saved=await stuSongList().catch(()=>[]), items=[];
    for(const k of Object.keys(ST_EXAMPLES)) items.push({label:k,fn:()=>{ S.load(ST_EXAMPLES[k]()); say('loaded '+k); }});
    items.push({sep:1}); if(saved.length) for(const r of saved.slice(0,20)) items.push({label:'📁 '+r.name.replace(/\.studio\.json$|\.json$/i,''),fn:async()=>{ try{ S.load(stLoad(await (await FileStore.get(r.id)).blob.text())); say('loaded '+r.name); }catch(e){ say('cannot load: '+e.message); } }});
    else items.push({label:'(nothing saved in Files › Songs yet)',dis:1});
    items.push({sep:1},{label:'Import .json file…',fn:async()=>{ const f=await stuPick('.json'); if(!f) return; try{ S.load(stLoad(await f.text())); say('imported '+f.name); }catch(e){ say('bad file: '+e.message); } }});
    stuMenu(ev.clientX,ev.clientY,items); });
  btn('💾 Save to Files','Save into Files › Songs',async()=>{ const nmv=prompt('Save as',P.name); if(!nmv) return; try{ P.name=nmv; S.commit(); await stuSongSave(P,nmv); say('saved Files › Songs / '+nmv); }catch(e){ say('save failed: '+e.message); } });
  btn('⬇ .json','Download the composition as a file',()=>stuDl((P.name||'song')+'.studio.json',new Blob([JSON.stringify(P)],{type:'application/json'})));
  btn('＋ New','Start an empty composition',()=>{ if(confirm('Replace the composition in this node with an empty one?')){ S.load(stuSongBlank()); say('new song'); } });
  // состав: паттерны, каналы, плейлист, микшер — правятся в блоках, подключённых к этому узлу
  const grid=stuEl('div','stu-sgrid'); T.append(grid);
  const col=(title,rows)=>{ const c=stuEl('div','stu-scol'); c.append(stuEl('h4',null,title)); for(const r of rows) c.append(stuEl('div','stu-srow',r)); grid.append(c); };
  col('Patterns ('+P.patterns.length+')',P.patterns.map((p,i)=>(i+1)+'. '+stuEsc(p.name)+' · '+p.bars+' bar'+(p.bars>1?'s':'')+' · '+Object.values(p.notes).reduce((a,x)=>a+x.length,0)+' notes'));
  col('Channels ('+P.channels.length+')',P.channels.map(c=>'<i style="color:'+c.color+'">●</i> '+stuEsc(c.name)+' <span class="stu-dim">'+(c.type==='ext'?'trigger':c.type)+' · insert '+c.mix+'</span>'));
  const lanes={}; for(const c of P.playlist.clips) if(c.kind==='pat') lanes[c.tr]=(lanes[c.tr]||0)+1;
  col('Playlist lanes',Object.keys(lanes).map(t=>'lane '+(+t+1)+' → pin p'+(+t+1)+' / g'+(+t+1)+' · '+lanes[t]+' clip'+(lanes[t]>1?'s':'')));
  col('Mixer inserts',P.mixer.map((m,i)=>({m,i})).filter(x=>x.i&&(x.m.fx.length||P.channels.some(c=>c.mix===x.i)||Object.keys(x.m.sends).length)).map(x=>x.i+'. '+stuEsc(x.m.name)+(x.m.fx.length?' <span class="stu-dim">'+x.m.fx.map(f=>ST_FX[f.type].name).join(' › ')+'</span>':'')));
  T.append(stuEl('div','stu-dim stu-snote','Wire <b>song</b> to Pattern Playlist, Drum Machine, Piano Roll and Mixer: they edit and play this composition; this node loads and saves it.'));
  if(n.ro) n.ro.textContent=n.status||(P.name+' · '+P.bpm+' bpm');
}
def({ id:'stusong', lazy:'manual', title:'Song (Studio)', cat:'Music', resize:true, w:600, h:440, readout:true,
  outs:[{n:'song',t:'song'},{n:'bpm',t:'num'}],
  params:[{n:'data',t:'text',d:'',hidden:true}],
  init(n){ n.tileOff=70; n.onResize=ln=>stuLiteFit(ln); n.S=new StuSong(n); n.tile=null; n._tk=''; n.status=''; },
  dispose(n){ if(n.S){ n.S.dead=true; n.S=null; } },
  process(n){ const S=n.S; return {song:S||null,bpm:S?S.P.bpm:0}; },
  drawKey:n=>n.S?n.S.gen+'|'+n.S.rev+'|'+n.status:'',
  draw(n){ stuSongTile(n); }
});

/* ============================ ГОТОВЫЕ КОМПОЗИЦИИ ИЗ УЗЛОВ ============================ */
// Собирает патч: узел Song с композицией (ST_EXAMPLES), Master Clock → Pattern Playlist → Drum Machine / Piano Roll → Synth → Mixer → Sound Card;
// блоки подключены к Song проводом song, дорожка плейлиста k даёт pK в pat своего инструмента. Тест для всей связки узлов.
function stuVoiceParams(p){
  return {wave1:p.w1,level1:p.l1,semi1:Math.max(-24,Math.min(24,p.o1*12+p.s1)),wave2:p.w2,level2:p.l2,semi2:Math.max(-24,Math.min(24,p.o2*12+p.s2)),fine2:Math.max(-50,Math.min(50,p.dt2)),
    attack:p.a,decay:p.d,sustain:p.s,release:p.r};
}
function stuCompose(name){
  const E=ST_EXAMPLES[name](), clips=E.playlist.clips.filter(c=>c.kind==='pat');
  const tracks=[...new Set(clips.map(c=>c.tr))].sort((a,b)=>a-b).slice(0,8);
  clearAll();
  const so=addNode('stusong',40,40,{data:JSON.stringify(E)}); so.size.w=600; so.size.h=440; applySize(so);
  const ck=addNode('clock',680,40,{bpm:E.bpm,div:'1/16'});
  const ar=addNode('stuarr',40,520,{}); ar.size.w=780; ar.size.h=440; applySize(ar); addEdge(so.id,'song',ar.id,'song'); addEdge(ck.id,'pulse',ar.id,'clk');
  const used=new Set(), links=[];
  tracks.forEach((tr,li)=>{
    const ids=new Set(clips.filter(c=>c.tr===tr).map(c=>c.pat)), chIds=new Set();
    for(const pt of E.patterns) if(ids.has(pt.id)) for(const id in pt.notes) if(pt.notes[id].length) chIds.add(+id);
    const chs=E.channels.filter(c=>chIds.has(c.id)); if(!chs.length) return;
    const y=1000+Math.floor(li/2)*620, px=40+(li%2)*1700;
    let src, ins=chs[0].mix;
    if(chs.every(c=>c.type==='drum')){
      const dm=addNode('studrum',px,y,{bpm:E.bpm,swing:E.swing||0,gain:.8}); dm.size.w=640; dm.size.h=560; applySize(dm);
      addEdge(so.id,'song',dm.id,'song'); addEdge(ck.id,'pulse',dm.id,'clk'); addEdge(ar.id,'p'+(tr+1),dm.id,'pat'); src=[dm.id,'out'];
    }else{
      const c=chs[0], poly=(()=>{ let m=0; for(const pt of E.patterns){ const cnt={}; for(const q of (pt.notes[c.id]||[])){ const k=Math.floor(q.t/ST_STEP); cnt[k]=(cnt[k]||0)+1; if(cnt[k]>m) m=cnt[k]; } } return m>1; })();
      const pr=addNode('stuprl',px,y,{bpm:E.bpm,gatelen:.9,ch:c.name}); pr.size.w=780; pr.size.h=540; applySize(pr);
      addEdge(so.id,'song',pr.id,'song'); addEdge(ck.id,'pulse',pr.id,'clk'); addEdge(ar.id,'p'+(tr+1),pr.id,'pat');
      let sy; const sx=px+800;
      if(/acid/i.test(c.name)){ sy=addNode('acid',sx,y,{wave:c.p.w1==='square'?'square':'saw',cutoff:Math.min(8000,Math.max(100,c.p.cut)),reso:.8,envAmt:2400,decay:.2}); addEdge(pr.id,'freq',sy.id,'freq'); addEdge(pr.id,'gate',sy.id,'gate'); }
      else if(poly){ sy=addNode('poly4',sx,y,{wave:c.p.w1,attack:c.p.a,decay:c.p.d,sustain:c.p.s,release:c.p.r,spread:.6});
        for(let k=0;k<4;k++){ const q=k?k+1:''; addEdge(pr.id,'freq'+q,sy.id,'freq'+q); addEdge(pr.id,'gate'+q,sy.id,'gate'+q); } }
      else{ sy=addNode('voice',sx,y,stuVoiceParams(c.p)); addEdge(pr.id,'freq',sy.id,'freq'); addEdge(pr.id,'gate',sy.id,'gate'); addEdge(pr.id,'vel',sy.id,'vel'); }
      src=[sy.id,'out'];
    }
    let k=ins>=1&&ins<=8&&!used.has(ins)?ins:0; if(!k) for(let q=1;q<=8;q++) if(!used.has(q)){ k=q; break; }
    if(k){ used.add(k); links.push([src[0],src[1],'in'+k]); }
  });
  const mx=addNode('stumixer',900,40,{}); mx.size.w=780; mx.size.h=540; applySize(mx); addEdge(so.id,'song',mx.id,'song');
  for(const [id,pin,to] of links) addEdge(id,pin,mx.id,to);
  const dc=addNode('dac',1740,40,{vol:.5,mode:'stereo'}); addEdge(mx.id,'L',dc.id,'L'); addEdge(mx.id,'R',dc.id,'R');
  const nt=addNode('note',860,620,{text:name+' — built from nodes only.\n'+
    'Song (load / save) → song pin → Pattern Playlist, Drum Machine, Piano Roll, Mixer.  Master Clock → clk of all.\n'+
    'Playlist lane k → pat of its instrument; instruments → Synth → Mixer inputs (strip = song insert) → Sound Card.\n'+
    'Edit a pattern in any block: the change goes into the shared song, Song saves it (💾 → Files › Songs).'});
  nt.size.w=620; nt.size.h=120; applySize(nt);
  markWiresDirty();
}
