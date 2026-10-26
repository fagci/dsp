"use strict";
/* ============================ STUDIO: СЕССИЯ, УЗЛЫ, ОКНО ============================
   Студия разложена на модули: studio-kernels.js (проект), studio-engine.js (звук), studio-ui.js (виджеты),
   studio-panels.js (транспорт, стойка, микшер, инструмент), studio-roll.js, studio-playlist.js.
   StuApp — сессия проекта: данные, звук, откат, сохранение. Её показывают панели: все вместе в полноэкранном окне
   (StuFull) или по отдельности — тайлами-узлами, как у трекера. Узел Studio (DAW) держит сессию, тайлы берут её
   по проводу studio. Проект лежит в IndexedDB (dsp-studio), в узле — только ключ. */

let StuFocus=null;                               // сессия, получающая клавиши (последняя, по чьей панели кликали)

class StuApp{
  constructor(node){
    this.node=node; this.P=stNewProject(); this.eng=new StEngine(this.P); this.cur={pat:0,ch:0,ins:1,slot:-1};
    this.snap=ST_STEP; this.mode='song'; this.rec=false; this.pos=0; this.playFrom=0; this.tickHead=null; this.msg='';
    this.undo=[]; this.redoS=[]; this.recOn=new Map(); this.panels=new Set(); this.full=null; this.focusPanel=null; this._ko=5; this.raf=0; this.lv=null;
    this.projId=node.p.proj||('stu'+Date.now().toString(36)); node.p.proj=this.projId;
    this.dead=false; this.initMidi(); this.load();
  }
  /* ----- панели ----- */
  attach(p){
    this.panels.add(p);
    p.el.addEventListener('pointerdown',()=>{ StuFocus=this; this.focusPanel=p; this.eng.ensure(); this.prepAudio(); },true);
    if(!this.raf) this.raf=requestAnimationFrame(()=>this.frame());
  }
  detach(p){ this.panels.delete(p); if(this.focusPanel===p) this.focusPanel=null; }
  each(kind,fn){ for(const p of [...this.panels]) if(p.kind===kind) fn(p); }
  dirty(...kinds){ for(const p of this.panels) if(kinds.includes(p.kind)) p.dirty=1; }
  refreshRack(){ this.each('rack',p=>p.refresh()); }
  refreshMixer(){ this.each('mix',p=>p.refresh()); }
  refreshPats(){
    this.each('bar',p=>p.refresh()); this.refreshRack(); this.dirty('roll','list');
    if(this.mode==='pat') this.eng.view={mode:'pat',pat:this.cur.pat};
  }
  refreshAll(){ for(const p of [...this.panels]) p.refresh(); this.dirty('roll','list'); if(this.mode==='pat') this.eng.view={mode:'pat',pat:this.cur.pat}; }
  say(m){ this.msg=m; }
  focusTab(kind){ if(this.full) this.full.setTab(kind); }
  levels(){ return this.lv; }
  frame(){
    this.raf=0; if(!this.panels.size || this.dead) return;
    this.raf=requestAnimationFrame(()=>this.frame());
    const e=this.eng; this.tickHead=e.playing?e.getTick():null;
    this.lv=e.rig&&e.ac&&e.ac.state==='running' ? e.rig.levels() : null;
    for(const p of [...this.panels]) if(p.el.isConnected && p.el.offsetParent!==null) p.frame();
  }
  open(){ if(!this.full) this.full=new StuFull(this); StuFocus=this; return this.full; }
  destroy(){
    this.dead=true; if(this.full) this.full.close(); for(const p of [...this.panels]) p.destroy();
    this.eng.stop(); this.saveNow(); try{ this.eng.ac&&this.eng.ac.close(); }catch(e){}
    if(StuFocus===this) StuFocus=null; cancelAnimationFrame(this.raf);
  }

  /* ----- проект: загрузка, сохранение, откат ----- */
  async load(){
    let rec=null; try{ rec=await StuDB.get(this.projId); }catch(e){ console.warn('studio db',e); }
    if(this.dead) return;
    if(rec) this.adopt(stLoad(rec.json),rec.samples); else this.adopt(stDemoProject());
    this.undo=[JSON.stringify(this.P)];
  }
  adopt(P,samples){
    this.P=P; this.eng.samples={};
    for(const id in samples||{}) this.eng.samples[id]={name:samples[id].name,data:samples[id].data};
    this.eng.setProject(P);
    this.cur.pat=P.patterns[0]?P.patterns[0].id:0; this.cur.ch=P.channels[0]?P.channels[0].id:0; this.cur.ins=1; this.cur.slot=-1;
    this.pos=0; this.mode=P.playlist.clips.some(c=>c.kind==='pat')?'song':'pat'; this.refreshAll();
  }
  async prepAudio(){
    const e=this.eng; if(!e.ac) return;
    for(const id in e.samples){ const s=e.samples[id]; if(!s.buf && s.data && !s.busy){ s.busy=1;
      try{ s.buf=await e.ac.decodeAudioData(s.data.slice(0)); }catch(err){ console.warn('sample',err); } s.busy=0; } }
    if(e.rig) e.rig.samples=e.samples;
  }
  commit(){
    const s=JSON.stringify(this.P); if(s===this.undo[this.undo.length-1]){ this.saveSoon(); return; }
    this.undo.push(s); if(this.undo.length>150) this.undo.shift(); this.redoS=[]; this.saveSoon();
  }
  restore(s){
    const P=stLoad(s); for(const k of Object.keys(this.P)) delete this.P[k]; Object.assign(this.P,P);
    if(!this.P.patterns.some(p=>p.id===this.cur.pat)) this.cur.pat=this.P.patterns[0]?this.P.patterns[0].id:0;
    if(!this.P.channels.some(c=>c.id===this.cur.ch)) this.cur.ch=this.P.channels[0]?this.P.channels[0].id:0;
    if(this.eng.rig) this.eng.rig.sync(); this.refreshAll();
  }
  doUndo(){ if(this.undo.length<2) return; this.redoS.push(this.undo.pop()); this.restore(this.undo[this.undo.length-1]); this.saveSoon(); }
  doRedo(){ if(!this.redoS.length) return; const s=this.redoS.pop(); this.undo.push(s); this.restore(s); this.saveSoon(); }
  saveSoon(){ clearTimeout(this._st); this.msg='unsaved'; this._st=setTimeout(()=>this.saveNow(),1200); }
  async saveNow(){
    clearTimeout(this._st);
    const samples={}; for(const id in this.eng.samples){ const s=this.eng.samples[id]; if(this.P.channels.some(c=>c.id==id)) samples[id]={name:s.name,data:s.data}; }
    try{ await StuDB.put({id:this.projId,name:this.P.name,json:JSON.stringify(this.P),samples,mod:Date.now()}); if(this.msg==='unsaved') this.msg='saved'; }
    catch(e){ console.warn('studio save',e); }
  }

  /* ----- действия панели транспорта ----- */
  action(a,ev){
    const P=this.P, e=this.eng;
    switch(a){
      case 'play': this.togglePlay(); break;
      case 'stop': this.stopAll(); break;
      case 'rec': this.rec=!this.rec; if(this.rec && this.mode!=='pat') this.setMode('pat'); break;
      case 'mode': this.setMode(this.mode==='song'?'pat':'song'); break;
      case 'metro': e.metro=!e.metro; break;
      case 'undo': this.doUndo(); break;
      case 'redo': this.doRedo(); break;
      case 'newpat': { const p=stAddPattern(P,'Pattern '+(P.patterns.length+1),1); this.cur.pat=p.id; this.commit(); this.refreshAll(); } break;
      case 'patmenu': this.patMenu(ev); break;
      case 'addch': this.addMenu(ev.clientX,ev.clientY); break;
      case 'menu': this.projMenu(ev); break;
      case 'full': this.open(); break;
      case 'close': if(this.full) this.full.close(); break;
    }
  }
  setMode(m){
    this.mode=m; this.eng.view=m==='song'?{mode:'song'}:{mode:'pat',pat:this.cur.pat};
    if(this.eng.playing) this.restartIfPlaying();
  }
  togglePlay(){
    if(this.eng.playing){ this.eng.stop(); this.pos=this.playFrom||0; this.stopRecNotes(); }
    else this.startPlay(this.pos);
  }
  startPlay(from){
    if(this.mode==='song' && !this.P.playlist.clips.some(c=>c.kind==='pat')){ this.mode='pat'; this.say('playlist is empty — playing the current pattern'); }
    this.eng.view=this.mode==='song'?{mode:'song'}:{mode:'pat',pat:this.cur.pat};
    this.playFrom=from; this.eng.play(from); this.prepAudio();
  }
  restartIfPlaying(){ if(!this.eng.playing) return; const t=this.eng.getTick(); this.startPlay(t==null?0:t); }
  stopAll(){ this.eng.stop(); this.pos=0; this.playFrom=0; this.stopRecNotes(); }
  seek(t){ this.pos=Math.max(0,t); this.playFrom=this.pos; if(this.eng.playing) this.startPlay(this.pos); }
  patObj(){ return this.P.patterns.find(p=>p.id===this.cur.pat); }
  chObj(){ return this.P.channels.find(c=>c.id===this.cur.ch); }
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
  projMenu(ev){
    const P=this.P;
    stuMenu(ev.clientX,ev.clientY,[
      {label:'New empty project',fn:()=>this.newProject(null)},
      {label:'Examples ▸',fn:()=>this.examplesMenu(ev.clientX,ev.clientY)},
      {label:'Open…',fn:()=>this.openList()},
      {label:(P.lite?'✓ ':'')+'Low CPU mode (fewer voices, short reverb)',fn:()=>{ P.lite=!P.lite; if(this.eng.rig) this.eng.rig.sync(); this.commit(); this.say(P.lite?'low CPU mode on':'low CPU mode off'); }},
      {label:'Rename…',fn:()=>{ const n=prompt('Project name',P.name); if(n){ P.name=n; this.commit(); this.refreshAll(); } }},
      {sep:1},
      {label:'Export WAV (song)',fn:()=>this.exportWav('song')},
      {label:'Export WAV (current pattern)',fn:()=>this.exportWav('pat')},
      {label:'Export project (.json)',fn:()=>stuDl((P.name||'project')+'.studio.json',new Blob([JSON.stringify(P)],{type:'application/json'}))},
      {label:'Import project (.json)…',fn:async()=>{ const f=await stuPick('.json'); if(f){ try{ this.projId='stu'+Date.now().toString(36); this.node.p.proj=this.projId; this.adopt(stLoad(await f.text())); this.undo=[JSON.stringify(this.P)]; this.saveSoon(); }catch(e){ alert('Bad project file: '+e.message); } } }},
    ]);
  }
  async openList(){
    const all=(await StuDB.all()).sort((a,b)=>b.mod-a.mod);
    stuMenu(innerWidth/2-120,80,all.length?all.map(r=>({label:(r.id===this.projId?'● ':'')+r.name+'  ·  '+new Date(r.mod).toLocaleString(),
      fn:()=>{ this.saveNow(); this.projId=r.id; this.node.p.proj=r.id; this.adopt(stLoad(r.json),r.samples); this.undo=[JSON.stringify(this.P)]; }})):[{label:'No saved projects',dis:1}]);
  }
  examplesMenu(x,y){
    stuMenu(x,y,Object.keys(ST_EXAMPLES).map(n=>({label:n,fn:()=>this.newProject(ST_EXAMPLES[n])})));
  }
  newProject(make){
    this.saveNow(); this.projId='stu'+Date.now().toString(36); this.node.p.proj=this.projId;
    let P; if(make) P=make(); else{ P=stNewProject(); const pat=stAddPattern(P,'Pattern 1',1);
      const k=stAddChannel(P,'drum','Kick',ST_KITS['Kick 909'],1), s=stAddChannel(P,'drum','Snare',ST_KITS.Snare,2), h=stAddChannel(P,'drum','Hat',ST_KITS['Closed Hat'],3),
        sy=stAddChannel(P,'synth','Synth',stPatchP('Supersaw Lead'),4);
      for(const c of [k,s,h,sy]) pat.notes[c.id]=[]; stAddClip(P,pat,0,0,4); P.playlist.loop=[0,4*ST_BAR]; }
    this.eng.samples={}; this.adopt(P); this.undo=[JSON.stringify(P)]; this.saveSoon();
  }
  async exportWav(what){
    this.say('rendering…');
    try{
      await this.prepAudio();
      const view=what==='pat'?{mode:'pat',pat:this.cur.pat}:{mode:'song'};
      const o=await stRender(this.P,this.eng.samples,{view,tail:3});
      stuDl((this.P.name||'song')+(what==='pat'?'-'+this.patObj().name:'')+'.wav',new Blob([stWav(o.L,o.R,o.sr)],{type:'audio/wav'}));
      this.say('exported');
    }catch(e){ this.say('export failed'); console.error(e); }
  }

  /* ----- каналы ----- */
  addMenu(x,y){
    const items=[{label:'Synth',fn:()=>this.addChannel('synth','Synth',stPatchP('Init'))}];
    for(const n of Object.keys(ST_PATCHES).slice(1)) items.push({label:'Synth: '+n,fn:()=>this.addChannel('synth',n,stPatchP(n))});
    items.push({sep:1});
    for(const n of Object.keys(ST_KITS)) items.push({label:'Drum: '+n,fn:()=>this.addChannel('drum',n,ST_KITS[n])});
    items.push({sep:1},{label:'Sampler (load audio…)',fn:()=>this.addSampler()});
    stuMenu(x,y,items);
  }
  addChannel(type,name,p){
    const P=this.P, ch=stAddChannel(P,type,name,p,0);
    ch.mix=this.freeInsert(); if(ch.mix) P.mixer[ch.mix].name=name;
    this.cur.ch=ch.id; if(this.eng.rig) this.eng.rig.sync(); this.commit(); this.refreshAll(); this.eng.ensure(); this.audition(ch.id,60,100,.4);
  }
  freeInsert(){ const used=new Set(this.P.channels.map(c=>c.mix)); for(let i=1;i<=ST_INSERTS;i++) if(!used.has(i) && !this.P.mixer[i].fx.length) return i; return 0; }
  async addSampler(){
    const f=await stuPick('audio/*'); if(!f) return;
    const P=this.P, ch=stAddChannel(P,'sampler',f.name.replace(/\.\w+$/,''),{},0); ch.mix=this.freeInsert();
    try{ await this.eng.loadSample(ch.id,f); }catch(e){ alert('Cannot decode audio: '+e.message); stRemoveChannel(P,ch.id); return; }
    ch.p.sname=f.name; this.cur.ch=ch.id; if(this.eng.rig) this.eng.rig.sync(); this.commit(); this.refreshAll();
  }
  stepKey(ch){ return ch.type==='drum' ? 60 : ch.type==='sampler' ? ch.p.root : (ch.stepKey||60); }
  // прослушивание: len — секунды (автоотпускание)
  audition(chId,key,vel,len){
    const e=this.eng; e.ensure(); this.prepAudio(); e.noteOn(chId,key,vel||100);
    if(len) setTimeout(()=>e.noteOff(chId,key),len*1000);
  }
  chMenu(ev,ch){
    const P=this.P;
    stuMenu(ev.clientX,ev.clientY,[
      {label:'Piano roll',fn:()=>{ this.cur.ch=ch.id; this.focusTab('roll'); this.refreshRack(); this.each('roll',r=>r.fit()); }},
      {label:'Instrument',fn:()=>{ this.cur.ch=ch.id; this.focusTab('inst'); this.refreshRack(); this.each('inst',i=>i.refresh()); }},
      {label:'Rename…',fn:()=>{ const n=prompt('Channel name',ch.name); if(n){ ch.name=n; this.commit(); this.refreshAll(); } }},
      {label:'Clone',fn:()=>{ const c=JSON.parse(JSON.stringify(ch)); c.id=stNextId(P); c.name=ch.name+' 2'; const i=P.channels.indexOf(ch); P.channels.splice(i+1,0,c);
        for(const pt of P.patterns) if(pt.notes[ch.id]) pt.notes[c.id]=JSON.parse(JSON.stringify(pt.notes[ch.id]));
        if(this.eng.samples[ch.id]) this.eng.samples[c.id]=this.eng.samples[ch.id];
        this.cur.ch=c.id; if(this.eng.rig) this.eng.rig.sync(); this.commit(); this.refreshAll(); }},
      {label:'Move up',dis:P.channels.indexOf(ch)===0,fn:()=>{ const i=P.channels.indexOf(ch); P.channels.splice(i,1); P.channels.splice(i-1,0,ch); this.commit(); this.refreshRack(); }},
      {label:'Move down',dis:P.channels.indexOf(ch)===P.channels.length-1,fn:()=>{ const i=P.channels.indexOf(ch); P.channels.splice(i,1); P.channels.splice(i+1,0,ch); this.commit(); this.refreshRack(); }},
      {label:'Clear notes in this pattern',fn:()=>{ const p=this.patObj(); if(p) delete p.notes[ch.id]; this.commit(); this.refreshAll(); }},
      {sep:1},
      {label:'Delete channel',fn:()=>{ if(!confirm('Delete channel "'+ch.name+'" with all its notes?')) return;
        if(this.eng.rig) this.eng.rig.removeChannel(ch); stRemoveChannel(P,ch.id); this.cur.ch=P.channels[0]?P.channels[0].id:0; this.commit(); this.refreshAll(); }}]);
  }

  /* ----- автоматизация ----- */
  autoFor(target){
    const P=this.P, def=stTargetDef(P,target); if(!def) return;
    const cl=P.playlist.clips, last=cl.filter(c=>c.kind==='auto').reduce((a,c)=>Math.max(a,c.tr),-1);
    const tr=last>=0?last:Math.min(P.playlist.tracks-1,cl.reduce((a,c)=>Math.max(a,c.tr),0)+1), t=Math.floor(this.pos/ST_BAR)*ST_BAR;
    const cur=this.valueNow(target,def);
    cl.push({id:stNextId(P),kind:'auto',tr,t,l:4*ST_BAR,target,pts:[[0,cur],[4*ST_BAR,cur]]});
    P.playlist.tracks=Math.max(P.playlist.tracks,tr+1); this.commit(); this.focusTab('list'); this.dirty('list'); this.say('automation clip added to the playlist');
  }
  valueNow(target,def){
    const s=target.split(':'), P=this.P; let v=def.d;
    if(s[0]==='mix') v=P.mixer[+s[1]][s[2]]; else if(s[0]==='fx') v=P.mixer[+s[1]].fx[+s[2]].p[s[3]]; else if(s[0]==='ch') v=P.channels.find(c=>c.id===+s[1]).p[s[2]];
    return stClamp(stToNorm(def,v),0,1);
  }

  /* ----- клавиатура и MIDI ----- */
  onKey(ev,down){
    if(!down && ev.key===' '){ ev.preventDefault(); return; }       // иначе пробел на фокусной кнопке ещё и «кликнет» её
    const tg=ev.target; if(tg && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName) && !(tg.type==='range'||tg.type==='button')) return;
    const k=ev.key, mod=ev.ctrlKey||ev.metaKey;
    if(down){
      if(k==='Escape'){ if(document.querySelector('.stu-menu')){ document.querySelectorAll('.stu-menu').forEach(m=>m.remove()); ev.stopPropagation(); } else if(this.full){ this.full.close(); ev.stopPropagation(); } return; }
      if(mod && k.toLowerCase()==='z'){ ev.preventDefault(); ev.shiftKey?this.doRedo():this.doUndo(); return; }
      if(mod && k.toLowerCase()==='y'){ ev.preventDefault(); this.doRedo(); return; }
      if(mod && k.toLowerCase()==='s'){ ev.preventDefault(); this.saveNow(); return; }
      if(k===' '){ ev.preventDefault(); ev.stopPropagation(); this.togglePlay(); return; }
      if(this.full && ev.altKey && '1234'.includes(k)){ ev.preventDefault(); this.full.setTab(['list','roll','mix','inst'][+k-1]); return; }
      const f=this.focusPanel;
      if(f && (f.kind==='roll'||f.kind==='list') && f.key(ev)){ ev.preventDefault(); return; }
    }
    // компьютерная клавиатура как пианино: ряды A… и Q…
    if(mod||ev.altKey) return;
    const KM='awsedftgyhujkolp;\'',idx=KM.indexOf(k.toLowerCase());
    if(idx>=0){
      ev.preventDefault(); if(ev.repeat) return; const key=this._ko*12+12+idx;
      if(down) this.liveOn(key,100); else this.liveOff(key);
    }else if(down && (k==='z'||k==='x')){ this._ko=stClamp(this._ko+(k==='x'?1:-1),1,7); this.say('keyboard octave '+this._ko); }
  }
  liveOn(key,vel){
    const ch=this.chObj(); if(!ch) return; this.eng.noteOn(ch.id,key,vel); this.each('roll',r=>r.live(key,1));
    if(this.rec && this.eng.playing) this.recOn.set(key,{tick:this.eng.getTick(),vel});
  }
  liveOff(key){
    const ch=this.chObj(); if(!ch) return; this.eng.noteOff(ch.id,key); this.each('roll',r=>r.live(key,0));
    const r=this.recOn.get(key); if(!r) return; this.recOn.delete(key); this.finishRec(ch,key,r,this.eng.getTick());
  }
  finishRec(ch,key,r,end){
    const pat=this.patObj(); if(!pat||end==null) return; const L=stPatLen(pat), q=Math.max(1,this.snap);
    const t0=Math.round(r.tick/q)*q, len=Math.max(q,Math.round((end-r.tick)/q)*q);
    const arr=stPatNotes(pat,ch.id), t=((t0%L)+L)%L;
    pat.notes[ch.id]=arr.filter(n=>!(n.k===key && n.t===t)); pat.notes[ch.id].push({t,l:Math.min(len,L-t),k:key,v:r.vel});
    this.commit(); this.dirty('roll','list'); this.refreshRack();
  }
  stopRecNotes(){ for(const [key,r] of [...this.recOn]) this.liveOff(key); this.recOn.clear(); }
  async initMidi(){
    if(!navigator.requestMIDIAccess) return;
    try{
      const acc=await navigator.requestMIDIAccess(); this.midi=acc;
      const on=m=>{ if(StuFocus!==this) return; const [s,a,b]=m.data, c=s&0xf0; if(c===0x90 && b>0) this.liveOn(a,b); else if(c===0x80 || (c===0x90 && b===0)) this.liveOff(a); };
      const hook=()=>{ for(const i of acc.inputs.values()) i.onmidimessage=on; if(acc.inputs.size) this.say('MIDI: '+[...acc.inputs.values()].map(i=>i.name).join(', ')); };
      hook(); acc.onstatechange=hook;
    }catch(e){}
  }
}
// клавиши и фокус — один раз на страницу
addEventListener('keydown',ev=>{ if(StuFocus && !StuFocus.dead && StuFocus.panels.size) StuFocus.onKey(ev,true); },true);
addEventListener('keyup',ev=>{ if(StuFocus && !StuFocus.dead && StuFocus.panels.size) StuFocus.onKey(ev,false); },true);
addEventListener('pointerdown',ev=>{ if(StuFocus && !ev.target.closest('.stu-panel,.stu-full,.stu-menu')) StuFocus=null; },true);

/* ---------- полноэкранное окно: все панели вместе ---------- */
class StuFull{
  constructor(app){
    this.app=app; const r=this.root=stuEl('div','stu stu-full');
    r.innerHTML=`<div class="stu-main">
        <div class="stu-rack" data-h="rack"></div>
        <div class="stu-work">
          <div class="stu-tabs">
            <button data-t="list">Playlist</button><button data-t="roll">Piano Roll</button><button data-t="mix">Mixer</button><button data-t="inst">Instrument</button>
            <button data-t="rack" class="stu-tab-rack">Rack</button></div>
          <div class="stu-pane" data-p="list"></div><div class="stu-pane" data-p="roll"></div>
          <div class="stu-pane" data-p="mix"></div><div class="stu-pane" data-p="inst"></div>
        </div></div>`;
    this.bar=new StuBar(app); r.insertBefore(this.bar.el,r.firstChild);
    this.ps=[this.bar];
    const put=(P,sel)=>{ const p=new P(app); r.querySelector(sel).append(p.el); this.ps.push(p); return p; };
    this.rack=put(StuRack,'[data-h=rack]'); this.roll=put(StuRoll,'[data-p=roll]'); this.list=put(StuList,'[data-p=list]');
    this.mix=put(StuMixer,'[data-p=mix]'); this.inst=put(StuInst,'[data-p=inst]');
    document.body.append(r);
    r.addEventListener('click',ev=>{ const t=ev.target.closest('[data-t]'); if(t) this.setTab(t.dataset.t); });
    this.tab='list'; this.setTab('list');
    for(const p of this.ps) p.refresh();
  }
  setTab(t){
    if(t==='rack'){ this.root.classList.toggle('rackopen'); return; }
    this.tab=t; this.root.classList.remove('rackopen');
    this.root.querySelectorAll('.stu-tabs [data-t]').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
    this.root.querySelectorAll('.stu-pane').forEach(p=>p.classList.toggle('on',p.dataset.p===t));
    const p=this[t]; if(p){ this.app.focusPanel=p; p.dirty=1; if(t==='roll') requestAnimationFrame(()=>{ p.resize(); p.fit(); }); if(t==='list') requestAnimationFrame(()=>p.resize()); }
  }
  close(){
    for(const p of this.ps) p.destroy(); this.root.remove(); this.app.full=null; this.app.saveNow();
  }
}

/* ---------- узлы ---------- */
def({ id:'studio', lazy:'manual', title:'Studio (DAW)', cat:'Music', readout:true, w:230,
  outs:[{n:'studio',t:'stu'},{n:'bpm',t:'num'},{n:'bar',t:'num'},{n:'playing',t:'num'}],
  params:[
    {n:'open',t:'button',label:'🎹 Open Studio',fn:n=>{ if(n.S) n.S.open(); }},
    {n:'proj',t:'text',d:'',hidden:true}],
  init(n){ n.S=new StuApp(n); },
  dispose(n){ if(n.S){ n.S.destroy(); n.S=null; } },
  process(n){
    const S=n.S; if(!S) return {};
    const t=S.tickHead==null?S.pos:S.tickHead;
    return {bpm:S.P.bpm,bar:Math.floor(t/ST_BAR)+1,playing:S.eng.playing?1:0};
  },
  drawKey(n){ const S=n.S; return S ? S.P.name+'|'+S.P.bpm+'|'+S.eng.playing+'|'+S.msg : ''; },
  draw(n){ if(n.ro) n.ro.textContent=n.S ? n.S.P.name+' · '+n.S.P.bpm+' bpm'+(n.S.eng.playing?' · ▶':'') : ''; }
});

function stuSource(n){                                // узел Studio (DAW) на входе studio
  const e=Graph.edges.find(e=>e.to===n.id && e.tp==='studio');
  const m=e && Graph.map[e.from];
  return m && m.type==='studio' && m.S ? m : null;
}
// каждая панель — свой узел-тайл: раскладывайте их по дашборду как свою студию
const STU_TILES=[
  ['stubar', 'Studio: Transport',     'bar',  900, 56],
  ['sturack','Studio: Channel Rack',  'rack', 640, 360],
  ['stuseq', 'Studio: Piano Roll',    'roll', 760, 420],
  ['stulist','Studio: Playlist',      'list', 760, 380],
  ['stumix', 'Studio: Mixer',         'mix',  760, 400],
  ['stuinst','Studio: Instrument',    'inst', 620, 400]];
const STU_PANEL={bar:()=>StuBar,rack:()=>StuRack,roll:()=>StuRoll,list:()=>StuList,mix:()=>StuMixer,inst:()=>StuInst};
for(const [id,title,kind,w,h] of STU_TILES) def({ id, lazy:'manual', title, cat:'Music', w, h, resize:true,
  ins:[{n:'studio',t:'stu'}],
  init:n=>{ n.onResize=ln=>{ if(ln.tile) syncCustomHeight(ln,ln.tile,50); }; },
  drawKey:n=>{ const s=stuSource(n); return s?s.id+'|'+(s.S?'1':'0'):''; },
  draw(n){ stuTileSync(n,kind); },
  dispose(n){ if(n.P){ n.P.destroy(); n.P=null; } } });
function stuTileSync(n,kind){
  if(!n.mid) return;
  if(!n.tile){ n.tile=document.createElement('div'); n.tile.className='stu stu-tile'; syncCustomHeight(n,n.tile,50); }
  if(!n.mid.contains(n.tile)) n.mid.append(n.tile);
  const src=stuSource(n);
  if(n.P && src && n.P.app===src.S && n.P.el.isConnected) return;
  if(n.P){ n.P.destroy(); n.P=null; }
  n.tile.innerHTML='';
  if(!src){ n.tile.innerHTML='<div class="stu-empty">wire <b>studio</b> from a Studio (DAW) node</div>'; return; }
  n.P=new (STU_PANEL[kind]())(src.S); n.tile.append(n.P.el); n.P.refresh();
  if(n.P.resize) requestAnimationFrame(()=>n.P.resize());
}
