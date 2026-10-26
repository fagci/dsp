"use strict";
/* ============================ STUDIO: ОБОЛОЧКА (узел, окно, стойка каналов, микшер, инструменты) ============================
   Полноэкранная студия в духе FL Studio: Channel Rack со степ-секвенсором, Piano Roll (studio-roll.js), Playlist
   (studio-playlist.js), Mixer с цепочками эффектов и посылами, редактор инструмента. Проект лежит в IndexedDB
   (dsp-studio), в узле хранится только ключ. Ядро — studio-kernels.js, звук — studio-engine.js. */

const StuDB=(()=>{
  let dbp=null;
  const open=()=>dbp||(dbp=new Promise((res,rej)=>{
    const rq=indexedDB.open('dsp-studio',1);
    rq.onupgradeneeded=e=>{ const db=e.target.result; if(!db.objectStoreNames.contains('projects')) db.createObjectStore('projects',{keyPath:'id'}); };
    rq.onsuccess=e=>res(e.target.result); rq.onerror=e=>rej(e.target.error); }));
  const rp=r=>new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  const st=async m=>(await open()).transaction('projects',m).objectStore('projects');
  return {get:async id=>rp((await st('readonly')).get(id)), put:async rec=>rp((await st('readwrite')).put(rec)),
    del:async id=>rp((await st('readwrite')).delete(id)), all:async()=>rp((await st('readonly')).getAll())};
})();

/* ---------- мелкие виджеты ---------- */
const stuEl=(tag,cls,html)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; };
const stuEsc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stuCss=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ручка: вертикальное перетаскивание, колесо, двойной клик — значение по умолчанию, правая кнопка — автоматизация
function stuKnob(o){
  const d=o.d, el=stuEl('div','stu-knob'+(o.small?' sm':'')), cv=stuEl('canvas'), lb=stuEl('div','stu-kl',stuEsc(o.label||d.label||d.k)), vl=stuEl('div','stu-kv');
  const S=o.small?24:38, dpr=Math.min(2,window.devicePixelRatio||1);
  cv.width=cv.height=S*dpr; cv.style.width=cv.style.height=S+'px'; el.append(cv,vl,lb);
  let v=o.v, norm=stToNorm(d,v);
  const draw=()=>{
    const c=cv.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,S,S);
    const r=S/2-3, a0=Math.PI*.75, a1=Math.PI*2.25, bi=d.min<0 && d.max>0, z=bi?stToNorm(d,0):0;
    c.lineWidth=3; c.lineCap='round'; c.strokeStyle=stuCss('--line')||'#444'; c.beginPath(); c.arc(S/2,S/2,r,a0,a1); c.stroke();
    c.strokeStyle=stuCss('--acc')||'#e0b23c'; c.beginPath();
    const ang=a0+(a1-a0)*norm, az=a0+(a1-a0)*z; c.arc(S/2,S/2,r,Math.min(ang,az),Math.max(ang,az)); c.stroke();
    c.strokeStyle=stuCss('--txt')||'#ccc'; c.lineWidth=2; c.beginPath(); c.moveTo(S/2+Math.cos(ang)*(r-7),S/2+Math.sin(ang)*(r-7)); c.lineTo(S/2+Math.cos(ang)*r,S/2+Math.sin(ang)*r); c.stroke();
    vl.textContent=stFmt(d,v);
  };
  const set=(nv,fire)=>{ v=nv; norm=stToNorm(d,v); draw(); };
  let dragging=null;
  el.addEventListener('pointerdown',ev=>{
    if(ev.button!==0) return; ev.preventDefault(); el.setPointerCapture(ev.pointerId); dragging={y:ev.clientY,n:norm}; el.classList.add('on'); });
  el.addEventListener('pointermove',ev=>{
    if(!dragging) return;
    norm=stClamp(dragging.n+(dragging.y-ev.clientY)/(ev.shiftKey?600:160),0,1); v=stFromNorm(d,norm); draw(); o.onInput&&o.onInput(v); });
  const end=()=>{ if(dragging){ dragging=null; el.classList.remove('on'); o.onChange&&o.onChange(v); } };
  el.addEventListener('pointerup',end); el.addEventListener('pointercancel',end);
  el.addEventListener('dblclick',()=>{ set(d.d); o.onInput&&o.onInput(v); o.onChange&&o.onChange(v); });
  el.addEventListener('wheel',ev=>{ ev.preventDefault(); norm=stClamp(norm-Math.sign(ev.deltaY)*(ev.shiftKey?.005:.03),0,1); v=stFromNorm(d,norm); draw();
    o.onInput&&o.onInput(v); clearTimeout(el._wt); el._wt=setTimeout(()=>o.onChange&&o.onChange(v),250); },{passive:false});
  if(o.target) el.addEventListener('contextmenu',ev=>{ ev.preventDefault();
    stuMenu(ev.clientX,ev.clientY,[{label:'Create automation clip',fn:()=>STU&&STU.autoFor(o.target)}]); });
  el.title=(o.label||d.label||d.k)+(o.target?' — right click: automation':'');
  el.set=set; draw(); return el;
}
function stuSelect(o){
  const d=o.d, el=stuEl('div','stu-sel'), s=stuEl('select'); el.append(s,stuEl('div','stu-kl',stuEsc(o.label||d.label||d.k)));
  for(const x of d.o) s.append(new Option(x,x));
  s.value=o.v; s.addEventListener('change',()=>{ o.onInput&&o.onInput(s.value); o.onChange&&o.onChange(s.value); });
  el.set=v=>{ s.value=v; }; return el;
}
function stuCheck(o){
  const d=o.d, el=stuEl('button','stu-chk'+(o.v?' on':''),stuEsc(o.label||d.label||d.k));
  el.addEventListener('click',()=>{ const v=el.classList.toggle('on')?1:0; o.onInput&&o.onInput(v); o.onChange&&o.onChange(v); });
  el.set=v=>el.classList.toggle('on',!!v); return el;
}
// панель параметров по описанию: группы, ручки, списки; get/set — значения, fin — после отпускания
function stuParams(defs,p,onInput,onChange,targetOf){
  const root=stuEl('div','stu-params'), groups=new Map(), ctl={};
  for(const d of defs){
    let g=groups.get(d.g||''); if(!g){ g=stuEl('div','stu-grp'); if(d.g) g.append(stuEl('h4',null,stuEsc(d.g))); const kn=stuEl('div','stu-knobs'); g.append(kn); g._k=kn; groups.set(d.g||'',g); root.append(g); }
    const o={d,v:p[d.k],onInput:v=>onInput(d.k,v),onChange:v=>onChange&&onChange(d.k,v),target:targetOf?targetOf(d.k):null};
    const e=d.t==='sel'?stuSelect(o):d.t==='chk'?stuCheck(o):stuKnob(o);
    g._k.append(e); ctl[d.k]=e;
  }
  root.ctl=ctl; return root;
}
function stuMenu(x,y,items){
  document.querySelectorAll('.stu-menu').forEach(m=>m.remove());
  const m=stuEl('div','stu-menu'); (document.querySelector('.stu')||document.body).append(m);
  for(const it of items){
    if(it.sep){ m.append(stuEl('div','sep')); continue; }
    const b=stuEl('button',it.on?'on':'',stuEsc(it.label)); if(it.dis) b.disabled=true;
    b.addEventListener('click',()=>{ m.remove(); it.fn&&it.fn(); }); m.append(b);
  }
  const r=m.getBoundingClientRect(); m.style.left=Math.max(4,Math.min(x,innerWidth-r.width-4))+'px'; m.style.top=Math.max(4,Math.min(y,innerHeight-r.height-4))+'px';
  const away=ev=>{ if(!m.contains(ev.target)){ m.remove(); removeEventListener('pointerdown',away,true); } };
  setTimeout(()=>addEventListener('pointerdown',away,true),0);
  return m;
}
const stuDl=(name,blob)=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000); };
const stuPick=(accept)=>new Promise(res=>{ const i=document.createElement('input'); i.type='file'; i.accept=accept; i.onchange=()=>res(i.files[0]||null); i.click(); });

/* ---------- узел ---------- */
let STU=null;
def({ id:'studio', lazy:'manual', title:'Studio (DAW)', cat:'Music', readout:true, w:230,
  outs:[],
  params:[
    {n:'open',t:'button',label:'🎹 Open Studio',fn:n=>stuOpen(n)},
    {n:'proj',t:'text',d:'',hidden:true}],
  init(n){ n.status='piano roll · step sequencer · playlist · mixer'; },
  dispose(n){ if(STU && STU.node===n) STU.close(true); },
  process(n){ return {}; },
  draw(n){ if(n.ro) n.ro.textContent=STU&&STU.node===n ? (STU.P.name+' · '+STU.P.bpm+' bpm') : n.status; }
});

function stuOpen(n){
  if(STU && STU.node!==n) STU.close(true);
  if(!STU) STU=new StuApp(n); else STU.show();
}

/* ---------- приложение ---------- */
class StuApp{
  constructor(node){
    this.node=node; this.P=stNewProject(); this.eng=new StEngine(this.P); this.cur={pat:0,ch:0,ins:1,slot:-1};
    this.tab='list'; this.snap=ST_STEP; this.mode='song'; this.rec=false; this.pos=0; this.undo=[]; this.redoS=[]; this.projId=node.p.proj||('stu'+Date.now().toString(36));
    this.meters=new Float32Array(ST_INSERTS+1); this.hold=new Float32Array(ST_INSERTS+1); this.keys=new Map(); this.recOn=new Map(); this.dirty={};
    this.build(); this.bind();
    node.p.proj=this.projId;
    this.load();
    this.raf=requestAnimationFrame(()=>this.frame());
  }
  /* ----- каркас ----- */
  build(){
    const r=this.root=stuEl('div','stu');
    r.innerHTML=`
      <div class="stu-top">
        <button class="stu-b stu-x" title="Close (Esc)">✕</button>
        <button class="stu-b" data-a="menu" title="Project">☰ Project</button>
        <button class="stu-b" data-a="undo" title="Undo (Ctrl+Z)">↶</button><button class="stu-b" data-a="redo" title="Redo (Ctrl+Y)">↷</button>
        <span class="stu-sep"></span>
        <button class="stu-b stu-play" data-a="play" title="Play / Stop (Space)">▶</button>
        <button class="stu-b" data-a="stop" title="Stop (to start)">■</button>
        <button class="stu-b stu-recb" data-a="rec" title="Record notes from keyboard / MIDI into the current pattern">●</button>
        <button class="stu-b" data-a="mode" title="Song (playlist) / Pattern mode">SONG</button>
        <button class="stu-b" data-a="metro" title="Metronome">♩</button>
        <span class="stu-time" data-r="time">001:1:00</span>
        <label class="stu-f">BPM <input type="number" min="40" max="300" step="1" data-r="bpm"></label>
        <label class="stu-f">Swing <input type="range" min="0" max="1" step="0.01" data-r="swing"></label>
        <span class="stu-sep"></span>
        <label class="stu-f">Pattern <select data-r="pat"></select></label>
        <button class="stu-b" data-a="newpat" title="New pattern">＋</button>
        <button class="stu-b" data-a="patmenu" title="Pattern: clone / rename / length / delete">⋯</button>
        <span class="stu-fill"></span>
        <canvas class="stu-master" width="120" height="22" data-r="master" title="Master level"></canvas>
        <span class="stu-stat" data-r="stat"></span>
      </div>
      <div class="stu-main">
        <div class="stu-rack"><div class="stu-rack-in" data-r="rack"></div>
          <div class="stu-rack-add"><button class="stu-b" data-a="addch">＋ Channel</button></div></div>
        <div class="stu-work">
          <div class="stu-tabs">
            <button data-t="list">Playlist</button><button data-t="roll">Piano Roll</button><button data-t="mix">Mixer</button><button data-t="inst">Instrument</button>
            <button data-t="rack" class="stu-tab-rack">Rack</button></div>
          <div class="stu-pane" data-p="list"></div><div class="stu-pane" data-p="roll"></div>
          <div class="stu-pane" data-p="mix"></div><div class="stu-pane" data-p="inst"></div>
        </div>
      </div>`;
    document.body.append(r);
    this.q=s=>r.querySelector(s); this.qa=s=>[...r.querySelectorAll(s)];
    this.rackEl=this.q('[data-r=rack]');
    this.roll=new StuRoll(this,this.q('[data-p=roll]'));
    this.list=new StuList(this,this.q('[data-p=list]'));
    this.buildMixer();
    this.instEl=this.q('[data-p=inst]');
  }
  bind(){
    const r=this.root;
    r.addEventListener('pointerdown',()=>{ this.eng.ensure(); this.prepAudio(); },{capture:true});
    r.addEventListener('click',ev=>{
      const t=ev.target.closest('[data-t]'); if(t){ this.setTab(t.dataset.t); return; }
      const a=ev.target.closest('[data-a]'); if(a) this.action(a.dataset.a,ev);
      const bt=ev.target.closest('button'); if(bt && !bt.closest('.stu-menu')) bt.blur();
      if(ev.target.closest('.stu-x')) this.close();
    });
    const bpm=this.q('[data-r=bpm]'); bpm.addEventListener('change',()=>{ this.P.bpm=stClamp(+bpm.value||120,40,300); this.commit(); });
    bpm.addEventListener('wheel',ev=>{ ev.preventDefault(); this.P.bpm=stClamp(this.P.bpm-Math.sign(ev.deltaY),40,300); bpm.value=this.P.bpm; clearTimeout(this._bw); this._bw=setTimeout(()=>this.commit(),400); },{passive:false});
    const sw=this.q('[data-r=swing]'); sw.addEventListener('input',()=>{ this.P.swing=+sw.value; }); sw.addEventListener('change',()=>this.commit());
    this.q('[data-r=pat]').addEventListener('change',e=>{ this.cur.pat=+e.target.value; this.refreshRack(); this.roll.dirty=this.list.dirty=1; if(this.mode==='pat') this.restartIfPlaying(); });
    this.kd=ev=>this.onKey(ev,true); this.ku=ev=>this.onKey(ev,false);
    addEventListener('keydown',this.kd,true); addEventListener('keyup',this.ku,true);
    this.rz=()=>this.resize(); addEventListener('resize',this.rz);
    this.eng.onstop=()=>{ this.q('.stu-play').textContent='▶'; this.dirty.all=1; };
    this.initMidi();
  }
  show(){ this.root.style.display=''; this.resize(); }
  close(force){
    this.eng.stop(); this.saveNow();
    removeEventListener('keydown',this.kd,true); removeEventListener('keyup',this.ku,true); removeEventListener('resize',this.rz);
    cancelAnimationFrame(this.raf); try{ this.eng.ac&&this.eng.ac.close(); }catch(e){}
    this.root.remove(); STU=null;
  }
  setTab(t){
    if(t==='rack'){ this.root.classList.toggle('rackopen'); return; }
    this.tab=t; this.root.classList.remove('rackopen');
    this.qa('.stu-tabs [data-t]').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
    this.qa('.stu-pane').forEach(p=>p.classList.toggle('on',p.dataset.p===t));
    this.resize(); if(t==='inst') this.refreshInst(); if(t==='mix') this.refreshMixer();
    this.roll.dirty=this.list.dirty=1; if(t==='roll') requestAnimationFrame(()=>{ this.roll.resize(); this.roll.fit(); });
  }
  resize(){ this.roll.resize(); this.list.resize(); }

  /* ----- проект: загрузка, сохранение, откат ----- */
  async load(){
    let rec=null; try{ rec=await StuDB.get(this.projId); }catch(e){ console.warn('studio db',e); }
    if(rec) this.adopt(stLoad(rec.json),rec.samples); else this.adopt(stDemoProject());
    this.undo=[JSON.stringify(this.P)]; this.setTab(this.tab);
  }
  adopt(P,samples){
    this.P=P; this.eng.samples={};
    for(const id in samples||{}) this.eng.samples[id]={name:samples[id].name,data:samples[id].data};
    this.eng.setProject(P);
    this.cur.pat=P.patterns[0]?P.patterns[0].id:0; this.cur.ch=P.channels[0]?P.channels[0].id:0; this.cur.ins=1; this.cur.slot=-1;
    this.pos=0; this.refreshAll();
  }
  async prepAudio(){
    const e=this.eng; if(!e.ac) return;
    for(const id in e.samples){ const s=e.samples[id]; if(!s.buf && s.data && !s.busy){ s.busy=1;
      try{ s.buf=await e.ac.decodeAudioData(s.data.slice(0)); }catch(err){ console.warn('sample',err); } s.busy=0; } }
    if(e.rig) e.rig.samples=e.samples;
  }
  commit(){
    const s=JSON.stringify(this.P); if(s===this.undo[this.undo.length-1]) { this.saveSoon(); return; }
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
  saveSoon(){ clearTimeout(this._st); this.q('[data-r=stat]').textContent='unsaved'; this._st=setTimeout(()=>this.saveNow(),1200); }
  async saveNow(){
    clearTimeout(this._st);
    const samples={}; for(const id in this.eng.samples){ const s=this.eng.samples[id]; if(this.P.channels.some(c=>c.id==id)) samples[id]={name:s.name,data:s.data}; }
    try{ await StuDB.put({id:this.projId,name:this.P.name,json:JSON.stringify(this.P),samples,mod:Date.now()}); const st=this.q&&this.q('[data-r=stat]'); if(st) st.textContent='saved'; }
    catch(e){ console.warn('studio save',e); }
  }

  /* ----- действия панели ----- */
  action(a,ev){
    const P=this.P, e=this.eng;
    switch(a){
      case 'play': this.togglePlay(); break;
      case 'stop': this.stopAll(); break;
      case 'rec': this.rec=!this.rec; if(this.rec && this.mode!=='pat') this.setMode('pat'); ev.target.classList.toggle('on',this.rec); break;
      case 'mode': this.setMode(this.mode==='song'?'pat':'song'); break;
      case 'metro': e.metro=!e.metro; ev.target.classList.toggle('on',e.metro); break;
      case 'undo': this.doUndo(); break;
      case 'redo': this.doRedo(); break;
      case 'newpat': { const p=stAddPattern(P,'Pattern '+(P.patterns.length+1),1); this.cur.pat=p.id; this.commit(); this.refreshAll(); } break;
      case 'patmenu': this.patMenu(ev); break;
      case 'addch': this.addMenu(ev.clientX,ev.clientY); break;
      case 'menu': this.projMenu(ev); break;
    }
  }
  setMode(m){
    this.mode=m; const b=this.q('[data-a=mode]'); b.textContent=m==='song'?'SONG':'PAT'; b.classList.toggle('on',m==='pat');
    this.eng.view=m==='song'?{mode:'song'}:{mode:'pat',pat:this.cur.pat};
    if(this.eng.playing) this.restartIfPlaying();
  }
  togglePlay(){
    if(this.eng.playing){ this.eng.stop(); this.pos=this.playFrom||0; this.q('.stu-play').textContent='▶'; this.stopRecNotes(); }
    else this.startPlay(this.pos);
    this.dirty.all=1;
  }
  startPlay(from){
    this.eng.view=this.mode==='song'?{mode:'song'}:{mode:'pat',pat:this.cur.pat};
    this.playFrom=from; this.eng.play(from); this.q('.stu-play').textContent='❚❚'; this.prepAudio();
  }
  restartIfPlaying(){ if(!this.eng.playing) return; const t=this.eng.getTick(); this.startPlay(t==null?0:t); }
  stopAll(){ this.eng.stop(); this.pos=0; this.playFrom=0; this.q('.stu-play').textContent='▶'; this.stopRecNotes(); this.dirty.all=1; }
  seek(t){ this.pos=Math.max(0,t); this.playFrom=this.pos; if(this.eng.playing) this.startPlay(this.pos); this.dirty.all=1; }
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
      {label:'New empty project',fn:()=>this.newProject(false)},
      {label:'Load demo project',fn:()=>this.newProject(true)},
      {label:'Open…',fn:()=>this.openList()},
      {label:'Rename…',fn:()=>{ const n=prompt('Project name',P.name); if(n){ P.name=n; this.commit(); this.refreshTop(); } }},
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
  newProject(demo){
    this.saveNow(); this.projId='stu'+Date.now().toString(36); this.node.p.proj=this.projId;
    let P; if(demo) P=stDemoProject(); else{ P=stNewProject(); const pat=stAddPattern(P,'Pattern 1',1);
      const k=stAddChannel(P,'drum','Kick',ST_KITS['Kick 909'],1), s=stAddChannel(P,'drum','Snare',ST_KITS.Snare,2), h=stAddChannel(P,'drum','Hat',ST_KITS['Closed Hat'],3),
        sy=stAddChannel(P,'synth','Synth',stPatchP('Supersaw Lead'),4);
      for(const c of [k,s,h,sy]) pat.notes[c.id]=[]; stAddClip(P,pat,0,0,4); P.playlist.loop=[0,4*ST_BAR]; }
    this.eng.samples={}; this.adopt(P); this.undo=[JSON.stringify(P)]; this.saveSoon();
  }
  async exportWav(what){
    const st=this.q('[data-r=stat]'); st.textContent='rendering…';
    try{
      await this.prepAudio();
      const view=what==='pat'?{mode:'pat',pat:this.cur.pat}:{mode:'song'};
      const o=await stRender(this.P,this.eng.samples,{view,tail:3});
      stuDl((this.P.name||'song')+(what==='pat'?'-'+this.patObj().name:'')+'.wav',new Blob([stWav(o.L,o.R,o.sr)],{type:'audio/wav'}));
      st.textContent='exported';
    }catch(e){ st.textContent='export failed'; console.error(e); }
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
  // удерживаемая нота для прослушивания; len — секунды (автоотпускание)
  audition(chId,key,vel,len){
    const e=this.eng; e.ensure(); this.prepAudio(); e.noteOn(chId,key,vel||100);
    if(len) setTimeout(()=>e.noteOff(chId,key),len*1000);
  }
  chMenu(ev,ch){
    const P=this.P;
    stuMenu(ev.clientX,ev.clientY,[
      {label:'Piano roll',fn:()=>{ this.cur.ch=ch.id; this.setTab('roll'); this.refreshRack(); }},
      {label:'Instrument',fn:()=>{ this.cur.ch=ch.id; this.setTab('inst'); this.refreshRack(); }},
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

  /* ----- обновление частей ----- */
  refreshAll(){ this.refreshTop(); this.refreshRack(); this.refreshInst(); this.refreshMixer(); this.roll.dirty=this.list.dirty=1; this.dirty.all=1; }
  refreshTop(){
    const P=this.P, sel=this.q('[data-r=pat]'); sel.innerHTML='';
    for(const p of P.patterns) sel.append(new Option(p.name,p.id)); sel.value=this.cur.pat;
    this.q('[data-r=bpm]').value=P.bpm; this.q('[data-r=swing]').value=P.swing;
    if(this.mode==='pat') this.eng.view={mode:'pat',pat:this.cur.pat};
  }
  refreshRack(){
    const P=this.P, pat=this.patObj(), host=this.rackEl; host.innerHTML='';
    if(!pat) return;
    const steps=pat.bars*16;
    for(const ch of P.channels){
      const row=stuEl('div','stu-ch'+(ch.id===this.cur.ch?' sel':'')+(ch.mute?' mute':'')), head=stuEl('div','stu-chh');
      const led=stuEl('button','stu-led'+(ch.mute?'':' on'),''); led.style.setProperty('--c',ch.color); led.title='Mute';
      led.addEventListener('click',()=>{ ch.mute=!ch.mute; this.eng.rig&&this.eng.rig.refreshChannel(ch); this.commit(); this.refreshRack(); });
      const nm=stuEl('button','stu-chn',stuEsc(ch.name)); nm.title='Click: select · double click: piano roll · right click: menu';
      nm.addEventListener('click',()=>{ this.cur.ch=ch.id; this.qa('.stu-ch').forEach(r=>r.classList.toggle('sel',r===row)); this.roll.dirty=1; if(this.tab==='roll') this.roll.fit(); if(this.tab==='inst') this.refreshInst(); this.audition(ch.id,this.stepKey(ch),100,.35); });
      nm.addEventListener('dblclick',()=>{ this.cur.ch=ch.id; this.setTab('roll'); this.refreshRack(); });
      nm.addEventListener('contextmenu',ev=>{ ev.preventDefault(); this.chMenu(ev,ch); });
      const solo=stuEl('button','stu-s'+(ch.solo?' on':''),'S'); solo.title='Solo';
      solo.addEventListener('click',()=>{ ch.solo=!ch.solo; this.eng.rig&&this.eng.rig.refresh(); this.commit(); this.refreshRack(); });
      const vol=stuKnob({small:1,label:'vol',d:{k:'v',min:0,max:1,d:.8},v:ch.vol,target:null,onInput:v=>{ ch.vol=v; this.eng.rig&&this.eng.rig.refreshChannel(ch); },onChange:()=>this.commit()});
      const pan=stuKnob({small:1,label:'pan',d:{k:'p',min:-1,max:1,d:0},v:ch.pan,onInput:v=>{ ch.pan=v; this.eng.rig&&this.eng.rig.refreshChannel(ch); },onChange:()=>this.commit()});
      const mix=stuEl('select','stu-mixsel'); mix.title='Mixer insert';
      for(let i=0;i<=ST_INSERTS;i++) mix.append(new Option(i?String(i):'M',i)); mix.value=ch.mix;
      mix.addEventListener('change',()=>{ ch.mix=+mix.value; this.eng.rig&&this.eng.rig.routeChannel(ch); this.commit(); });
      const pr=stuEl('button','stu-pr','🎹'); pr.title='Piano roll'; pr.addEventListener('click',()=>{ this.cur.ch=ch.id; this.setTab('roll'); this.refreshRack(); });
      head.append(led,nm,solo,vol,pan,mix,pr);
      const sw=stuEl('div','stu-steps'), notes=pat.notes[ch.id]||[], on=new Set(notes.map(n=>Math.floor(n.t/ST_STEP)));
      for(let i=0;i<steps;i++){ const b=stuEl('div','stu-st'+(on.has(i)?' on':'')+((i>>2)&1?' alt':'')); b.dataset.i=i; b.style.setProperty('--c',ch.color); sw.append(b); }
      this.bindSteps(sw,ch,pat);
      row.append(head,sw); host.append(row);
    }
    this.stepEls=this.qa('.stu-steps');
  }
  bindSteps(sw,ch,pat){
    let mode=null;
    const toggle=(b,force)=>{
      const i=+b.dataset.i, t=i*ST_STEP, arr=stPatNotes(pat,ch.id), has=arr.some(n=>n.t===t);
      const want=force==null?!has:force; if(want===has) return;
      if(want){ arr.push({t,l:ST_STEP,k:this.stepKey(ch),v:100}); this.audition(ch.id,this.stepKey(ch),100,.25); }
      else pat.notes[ch.id]=arr.filter(n=>n.t!==t);
      b.classList.toggle('on',want); this.roll.dirty=this.list.dirty=1;
    };
    sw.addEventListener('pointerdown',ev=>{ const b=ev.target.closest('.stu-st'); if(!b||ev.button!==0) return; ev.preventDefault();
      this.cur.ch=ch.id; this.qa('.stu-ch').forEach(r=>r.classList.toggle('sel',r.contains(sw)));
      mode=!b.classList.contains('on'); toggle(b,mode); sw.setPointerCapture(ev.pointerId); });
    sw.addEventListener('pointermove',ev=>{ if(mode==null) return; const el=document.elementFromPoint(ev.clientX,ev.clientY); const b=el&&el.closest&&el.closest('.stu-st'); if(b&&sw.contains(b)) toggle(b,mode); });
    const end=()=>{ if(mode!=null){ mode=null; this.commit(); } };
    sw.addEventListener('pointerup',end); sw.addEventListener('pointercancel',end);
  }

  /* ----- редактор инструмента ----- */
  refreshInst(){
    const host=this.instEl; if(!host) return; host.innerHTML=''; const ch=this.chObj();
    if(!ch){ host.append(stuEl('div','stu-empty','Add a channel in the rack')); return; }
    const head=stuEl('div','stu-ihead'), nm=stuEl('b',null,stuEsc(ch.name)+' <i>'+ch.type+'</i>'); head.append(nm);
    if(ch.type==='synth'){
      const s=stuEl('select'); s.append(new Option('— patch —','')); for(const n of Object.keys(ST_PATCHES)) s.append(new Option(n,n));
      s.addEventListener('change',()=>{ if(!s.value) return; ch.p=stPatchP(s.value); this.commit(); this.refreshInst(); this.audition(ch.id,60,100,.6); }); head.append(s);
    }else if(ch.type==='drum'){
      const s=stuEl('select'); s.append(new Option('— kit sound —','')); for(const n of Object.keys(ST_KITS)) s.append(new Option(n,n));
      s.addEventListener('change',()=>{ if(!s.value) return; ch.p=stFillP(ST_DRUM,ST_KITS[s.value]); this.commit(); this.refreshInst(); this.audition(ch.id,60,110,.3); }); head.append(s);
    }else{
      const b=stuEl('button','stu-b','Load sample…'); b.addEventListener('click',async()=>{ const f=await stuPick('audio/*'); if(!f) return;
        try{ await this.eng.loadSample(ch.id,f); ch.p.sname=f.name; this.commit(); this.refreshInst(); }catch(e){ alert('Cannot decode: '+e.message); } });
      head.append(b,stuEl('span','stu-dim',stuEsc(ch.p.sname||'no sample')));
    }
    const test=stuEl('button','stu-b','▶ Test'); test.addEventListener('click',()=>this.audition(ch.id,ch.type==='sampler'?ch.p.root:60,100,.7)); head.append(test);
    host.append(head);
    const pan=stuParams(ST_CHDEF[ch.type],ch.p,(k,v)=>{ ch.p[k]=v; if(ch.type==='synth' && k==='mono') return; },()=>{ this.commit(); if(ch.type==='synth') this.drawEnv(); },k=>'ch:'+ch.id+':'+k);
    host.append(pan);
    if(ch.type==='synth'){ const cv=stuEl('canvas','stu-env'); cv.width=520; cv.height=90; this.envCv=cv; host.insertBefore(cv,pan); this.drawEnv(); pan.addEventListener('pointerup',()=>this.drawEnv()); }
    if(ch.type==='sampler' && this.eng.samples[ch.id]?.buf){ const cv=stuEl('canvas','stu-env'); cv.width=520; cv.height=90; host.insertBefore(cv,pan); this.drawWave(cv,this.eng.samples[ch.id].buf); }
  }
  drawEnv(){
    const cv=this.envCv, ch=this.chObj(); if(!cv||!ch||ch.type!=='synth') return; const p=ch.p, c=cv.getContext('2d'), W=cv.width, H=cv.height;
    c.clearRect(0,0,W,H); c.fillStyle='#0a0d0e'; c.fillRect(0,0,W,H);
    const hold=Math.max(.3,p.a+p.d)+.3, T=hold+p.r+.2;
    const curve=(a,d,s,r,col)=>{
      c.strokeStyle=col; c.lineWidth=2; c.beginPath();
      for(let x=0;x<=W;x++){ const t=x/W*T, v=stAdsrAt(t,a,d,s,r,hold); c.lineTo(x,H-4-v*(H-10)); } c.stroke(); };
    curve(p.fa,p.fd,p.fs,p.fr,'#4ec9b0'); curve(p.a,p.d,p.s,p.r,'#e0b23c');
    c.fillStyle='#929fa7'; c.font='10px sans-serif'; c.fillText('amp (yellow) · filter (green)',6,12);
  }
  drawWave(cv,buf){
    const c=cv.getContext('2d'), W=cv.width, H=cv.height, d=buf.getChannelData(0); c.fillStyle='#0a0d0e'; c.fillRect(0,0,W,H);
    c.strokeStyle='#4ec9b0'; c.beginPath();
    for(let x=0;x<W;x++){ let mn=1,mx=-1; const a=Math.floor(x/W*d.length), b=Math.floor((x+1)/W*d.length);
      for(let i=a;i<b;i+=Math.max(1,(b-a)>>6)){ if(d[i]<mn) mn=d[i]; if(d[i]>mx) mx=d[i]; }
      c.moveTo(x,H/2-mx*H/2); c.lineTo(x,H/2-mn*H/2+1); } c.stroke();
  }

  /* ----- микшер ----- */
  buildMixer(){
    const host=this.q('[data-p=mix]'); host.innerHTML='<div class="stu-strips" data-r="strips"></div><div class="stu-fxp" data-r="fxp"></div>';
    this.stripsEl=host.querySelector('[data-r=strips]'); this.fxEl=host.querySelector('[data-r=fxp]');
  }
  refreshMixer(){
    const P=this.P, host=this.stripsEl; host.innerHTML=''; this.stripCv=[];
    P.mixer.forEach((m,i)=>{
      const s=stuEl('div','stu-strip'+(i===this.cur.ins?' sel':'')+(i===0?' master':''));
      const nm=stuEl('div','stu-sn',stuEsc(m.name)); nm.title='Double click to rename';
      nm.addEventListener('dblclick',()=>{ const n=prompt('Insert name',m.name); if(n){ m.name=n; this.commit(); this.refreshMixer(); } });
      const fxl=stuEl('div','stu-sfx',m.fx.length?m.fx.map(f=>`<i class="${f.on?'on':''}">${stuEsc(ST_FX[f.type].name)}</i>`).join(''):'<i class="none">no fx</i>');
      const cv=stuEl('canvas','stu-fad'); cv.width=56; cv.height=170; this.stripCv[i]=cv; cv.title='Drag: volume';
      const setV=ev=>{ const r=cv.getBoundingClientRect(); const y=stClamp(1-(ev.clientY-r.top)/r.height,0,1); m.vol=Math.round(y*1.25*100)/100; this.eng.rig&&this.eng.rig.refreshInsert(i); this.dirty.mix=1; };
      cv.addEventListener('pointerdown',ev=>{ cv.setPointerCapture(ev.pointerId); cv._d=1; setV(ev); });
      cv.addEventListener('pointermove',ev=>{ if(cv._d) setV(ev); });
      cv.addEventListener('pointerup',()=>{ cv._d=0; this.commit(); }); cv.addEventListener('dblclick',()=>{ m.vol=i?.8:.85; this.eng.rig&&this.eng.rig.refreshInsert(i); this.commit(); });
      cv.addEventListener('contextmenu',ev=>{ ev.preventDefault(); stuMenu(ev.clientX,ev.clientY,[{label:'Create automation clip (volume)',fn:()=>this.autoFor('mix:'+i+':vol')}]); });
      const pan=stuKnob({small:1,label:'pan',d:{k:'p',min:-1,max:1,d:0},v:m.pan,target:'mix:'+i+':pan',onInput:v=>{ m.pan=v; this.eng.rig&&this.eng.rig.refreshInsert(i); },onChange:()=>this.commit()});
      const ms=stuEl('div','stu-ms'), mu=stuEl('button','stu-s'+(m.mute?' on':''),'M'), so=stuEl('button','stu-s'+(m.solo?' on':''),'S');
      mu.addEventListener('click',()=>{ m.mute=!m.mute; mu.classList.toggle('on',m.mute); this.eng.rig&&this.eng.rig.refresh(); this.commit(); });
      so.addEventListener('click',()=>{ m.solo=!m.solo; so.classList.toggle('on',m.solo); this.eng.rig&&this.eng.rig.refresh(); this.commit(); });
      ms.append(mu,so);
      s.append(nm,fxl,cv,pan,ms,stuEl('div','stu-sno',i?String(i):'M'));
      s.addEventListener('click',ev=>{ if(ev.target.closest('canvas,button,.stu-knob')) return; this.cur.ins=i; this.cur.slot=-1; this.refreshMixer(); });
      host.append(s);
    });
    this.refreshFx();
  }
  refreshFx(){
    const P=this.P, i=this.cur.ins, m=P.mixer[i], host=this.fxEl; host.innerHTML='';
    host.append(stuEl('h3',null,'FX · '+stuEsc(m.name)));
    const list=stuEl('div','stu-fxl');
    for(let j=0;j<10;j++){
      const f=m.fx[j], row=stuEl('div','stu-slot'+(j===this.cur.slot?' sel':'')+(f?'':' empty'));
      if(f){
        const on=stuEl('button','stu-led'+(f.on?' on':'')); on.addEventListener('click',ev=>{ ev.stopPropagation(); f.on=!f.on; this.eng.rig&&this.eng.rig.buildInsert(i); this.commit(); this.refreshMixer(); });
        const up=stuEl('button','stu-mini','↑'), dn=stuEl('button','stu-mini','↓'), del=stuEl('button','stu-mini','✕');
        up.addEventListener('click',ev=>{ ev.stopPropagation(); if(j>0){ [m.fx[j-1],m.fx[j]]=[m.fx[j],m.fx[j-1]]; this.cur.slot=j-1; this.fxChanged(i); } });
        dn.addEventListener('click',ev=>{ ev.stopPropagation(); if(j<m.fx.length-1){ [m.fx[j+1],m.fx[j]]=[m.fx[j],m.fx[j+1]]; this.cur.slot=j+1; this.fxChanged(i); } });
        del.addEventListener('click',ev=>{ ev.stopPropagation(); m.fx.splice(j,1); this.cur.slot=-1; this.fxChanged(i); });
        row.append(on,stuEl('span','n',stuEsc(ST_FX[f.type].name)),up,dn,del);
        row.addEventListener('click',()=>{ this.cur.slot=j; this.refreshFx(); });
      }else{
        row.append(stuEl('span','n','＋ add effect'));
        row.addEventListener('click',ev=>{ stuMenu(ev.clientX,ev.clientY,ST_FX_ORDER.map(t=>({label:ST_FX[t].name,fn:()=>{
          m.fx.push({id:stNextId(P),type:t,on:true,p:stDefs(ST_FX[t].p)}); this.cur.slot=m.fx.length-1; this.fxChanged(i); }}))); });
      }
      list.append(row);
    }
    host.append(list);
    const f=m.fx[this.cur.slot];
    if(f){
      const pan=stuParams(ST_FX[f.type].p,f.p,(k,v)=>{ f.p[k]=v; const x=this.eng.rig&&this.eng.rig.ins[i].fx[this.cur.slot]; if(x) x.update(f.p,P.bpm); },()=>this.commit(),k=>'fx:'+i+':'+this.cur.slot+':'+k);
      host.append(pan);
    }
    if(i>0){
      host.append(stuEl('h3',null,'Sends'));
      const sl=stuEl('div','stu-sends');
      for(const t in m.sends){
        const d={k:'s',min:0,max:1,d:0,label:P.mixer[t].name};
        sl.append(stuKnob({small:1,label:P.mixer[t].name,d,v:m.sends[t],onInput:v=>{ m.sends[t]=v; this.eng.rig&&this.eng.rig.refreshInsert(i); },onChange:()=>this.commit()}));
      }
      const add=stuEl('button','stu-b','＋ send to…');
      add.addEventListener('click',ev=>stuMenu(ev.clientX,ev.clientY,P.mixer.map((x,t)=>({label:(t||'M')+' '+x.name,dis:t===0||t===i||t in m.sends,
        fn:()=>{ m.sends[t]=.5; this.eng.rig&&this.eng.rig.refreshInsert(i); this.commit(); this.refreshFx(); }})).filter(x=>!x.dis)));
      sl.append(add); host.append(sl);
      if(Object.keys(m.sends).length) { const rm=stuEl('button','stu-b','clear sends'); rm.addEventListener('click',()=>{ m.sends={}; this.eng.rig&&this.eng.rig.refreshInsert(i); this.commit(); this.refreshFx(); }); host.append(rm); }
    }
  }
  fxChanged(i){ if(this.eng.rig) this.eng.rig.buildInsert(i); this.commit(); this.refreshMixer(); }
  drawStrips(){
    const lv=this.eng.rig&&this.eng.ac&&this.eng.ac.state==='running' ? this.eng.rig.levels() : null, P=this.P;
    for(let i=0;i<this.stripCv.length;i++){
      const cv=this.stripCv[i]; if(!cv||!cv.isConnected) continue; const c=cv.getContext('2d'), W=cv.width, H=cv.height, m=P.mixer[i];
      const lvl=lv?lv[i]:0; this.meters[i]=Math.max(lvl,this.meters[i]*.92); this.hold[i]=Math.max(lvl,this.hold[i]-.004);
      c.fillStyle='#0a0d0e'; c.fillRect(0,0,W,H);
      const mh=Math.min(1,Math.pow(this.meters[i],.5))*H; const g=c.createLinearGradient(0,H,0,0); g.addColorStop(0,'#3a9d5d'); g.addColorStop(.7,'#d4c24a'); g.addColorStop(1,'#e05c5c');
      c.fillStyle=g; c.fillRect(W-18,H-mh,12,mh); c.fillStyle='#fff'; c.fillRect(W-18,H-Math.min(1,Math.pow(this.hold[i],.5))*H,12,1);
      const y=H-m.vol/1.25*H; c.fillStyle='#2a3136'; c.fillRect(10,0,3,H);
      c.fillStyle=m.mute?'#666':('#e0b23c'); c.fillRect(4,Math.max(0,y-5),16,10);
    }
  }

  /* ----- автоматизация ----- */
  autoFor(target){
    const P=this.P, def=stTargetDef(P,target); if(!def) return;
    const cl=P.playlist.clips, last=cl.filter(c=>c.kind==='auto').reduce((a,c)=>Math.max(a,c.tr),-1);
    let tr=last>=0?last:Math.min(P.playlist.tracks-1,P.playlist.clips.reduce((a,c)=>Math.max(a,c.tr),0)+1), t=Math.floor(this.pos/ST_BAR)*ST_BAR;
    const cur=this.valueNow(target,def);
    cl.push({id:stNextId(P),kind:'auto',tr,t,l:4*ST_BAR,target,pts:[[0,cur],[4*ST_BAR,cur]]});
    P.playlist.tracks=Math.max(P.playlist.tracks,tr+1); this.commit(); this.setTab('list'); this.list.dirty=1;
  }
  valueNow(target,def){
    const s=target.split(':'), P=this.P; let v=def.d;
    if(s[0]==='mix') v=P.mixer[+s[1]][s[2]]; else if(s[0]==='fx') v=P.mixer[+s[1]].fx[+s[2]].p[s[3]]; else if(s[0]==='ch') v=P.channels.find(c=>c.id===+s[1]).p[s[2]];
    return stClamp(stToNorm(def,v),0,1);
  }

  /* ----- клавиатура и MIDI ----- */
  onKey(ev,down){
    const tg=ev.target; if(tg && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName) && !(tg.type==='range'||tg.type==='button')) { if(ev.key!=='Escape') return; }
    if(!this.root.isConnected) return;
    const k=ev.key, mod=ev.ctrlKey||ev.metaKey;
    if(down){
      if(k==='Escape'){ if(document.querySelector('.stu-menu')) document.querySelectorAll('.stu-menu').forEach(m=>m.remove()); else this.close(); ev.stopPropagation(); return; }
      if(mod && k.toLowerCase()==='z'){ ev.preventDefault(); ev.shiftKey?this.doRedo():this.doUndo(); return; }
      if(mod && k.toLowerCase()==='y'){ ev.preventDefault(); this.doRedo(); return; }
      if(mod && k.toLowerCase()==='s'){ ev.preventDefault(); this.saveNow(); return; }
      if(k===' ' && !(tg&&tg.tagName==='BUTTON' && false)){ ev.preventDefault(); ev.stopPropagation(); this.togglePlay(); return; }
      if(ev.altKey && '1234'.includes(k)){ ev.preventDefault(); this.setTab(['list','roll','mix','inst'][+k-1]); return; }
      if(this.tab==='roll' && this.roll.key(ev)) { ev.preventDefault(); return; }
      if(this.tab==='list' && this.list.key(ev)) { ev.preventDefault(); return; }
    }
    // компьютерная клавиатура как пианино: ряды A… и Q…
    if(mod||ev.altKey) return;
    const KM='awsedftgyhujkolp;\'',idx=KM.indexOf(k.toLowerCase());
    if(idx>=0){
      if(ev.repeat){ ev.preventDefault(); return; }
      ev.preventDefault(); const key=this.kbOct*12+12+idx;
      if(down) this.liveOn(key,100); else this.liveOff(key);
    }else if(down && (k==='z'||k==='x')){ this.kbOct=stClamp(this.kbOct+(k==='x'?1:-1),1,7); this.q('[data-r=stat]').textContent='keyboard octave '+this.kbOct; }
  }
  get kbOct(){ return this._ko==null?5:this._ko; } set kbOct(v){ this._ko=v; }
  liveOn(key,vel){
    const ch=this.chObj(); if(!ch) return; this.eng.noteOn(ch.id,key,vel); this.roll.live(key,1);
    if(this.rec && this.eng.playing) this.recOn.set(key,{tick:this.eng.getTick(),vel});
  }
  liveOff(key){
    const ch=this.chObj(); if(!ch) return; this.eng.noteOff(ch.id,key); this.roll.live(key,0);
    const r=this.recOn.get(key); if(!r) return; this.recOn.delete(key); this.finishRec(ch,key,r,this.eng.getTick());
  }
  finishRec(ch,key,r,end){
    const pat=this.patObj(); if(!pat||end==null) return; const L=stPatLen(pat), q=Math.max(1,this.snap);
    const t0=Math.round(r.tick/q)*q, len=Math.max(q,Math.round((end-r.tick)/q)*q);
    const arr=stPatNotes(pat,ch.id), t=((t0%L)+L)%L;
    pat.notes[ch.id]=arr.filter(n=>!(n.k===key && n.t===t)); pat.notes[ch.id].push({t,l:Math.min(len,L-t),k:key,v:r.vel});
    this.commit(); this.roll.dirty=this.list.dirty=1; this.refreshRack();
  }
  stopRecNotes(){ for(const [key,r] of [...this.recOn]) this.liveOff(key); this.recOn.clear(); }
  async initMidi(){
    if(!navigator.requestMIDIAccess) return;
    try{
      const acc=await navigator.requestMIDIAccess(); this.midi=acc;
      const on=m=>{ const [s,a,b]=m.data, c=s&0xf0; if(c===0x90 && b>0) this.liveOn(a,b); else if(c===0x80 || (c===0x90 && b===0)) this.liveOff(a); };
      const hook=()=>{ for(const i of acc.inputs.values()) i.onmidimessage=on; if(acc.inputs.size) this.q('[data-r=stat]').textContent='MIDI: '+[...acc.inputs.values()].map(i=>i.name).join(', '); };
      hook(); acc.onstatechange=hook;
    }catch(e){}
  }

  /* ----- кадр ----- */
  frame(){
    this.raf=requestAnimationFrame(()=>this.frame());
    if(!this.root.isConnected) return;
    const e=this.eng, tick=e.playing?e.getTick():null, shown=tick==null?this.pos:tick;
    if(tick!==null && shown!==this._lt || this.dirty.all){
      const bar=Math.floor(shown/ST_BAR)+1, beat=Math.floor(shown%ST_BAR/ST_PPQ)+1, tk=Math.floor(shown%ST_PPQ);
      this.q('[data-r=time]').textContent=String(bar).padStart(3,'0')+':'+beat+':'+String(tk).padStart(2,'0');
    }
    this._lt=shown;
    this.tickHead=e.playing?shown:null;
    // подсветка текущего шага в стойке
    if(this.stepEls){
      const pat=this.patObj(), L=pat?stPatLen(pat):1, st=e.playing && pat ? Math.floor(((this.mode==='pat'?shown%L:Math.max(0,shown)%L))/ST_STEP) : -1;
      if(st!==this._ls){ this._ls=st; for(const sw of this.stepEls){ sw.querySelector('.cur')?.classList.remove('cur'); if(st>=0) sw.children[st]?.classList.add('cur'); } }
    }
    if(this.tab==='roll'&&(this.roll.dirty||e.playing)) this.roll.draw();
    if(this.tab==='list'&&(this.list.dirty||e.playing)) this.list.draw();
    if(this.tab==='mix') this.drawStrips();
    const mc=this.q('[data-r=master]');
    if(mc){ const c=mc.getContext('2d'); c.fillStyle='#0a0d0e'; c.fillRect(0,0,mc.width,mc.height);
      const lv=e.rig&&e.ac.state==='running'?e.rig.levels()[0]:0; this.mm=Math.max(lv,(this.mm||0)*.92); const w=Math.min(1,Math.pow(this.mm,.5))*mc.width;
      const g=c.createLinearGradient(0,0,mc.width,0); g.addColorStop(0,'#3a9d5d'); g.addColorStop(.75,'#d4c24a'); g.addColorStop(1,'#e05c5c'); c.fillStyle=g; c.fillRect(0,4,w,mc.height-8); }
    this.dirty.all=0;
  }
}
