"use strict";
/* ============================ STUDIO: ПАНЕЛИ ============================
   Стойка строк со степ-секвенсором, микшер с цепочками эффектов, редактор строки. Панели живут внутри узлов (studio-nodes.js). */

/* ---------- стойка каналов со степ-секвенсором ---------- */
class StuRack extends StuPanel{
  constructor(app){
    super(app,'rack'); this.el.innerHTML='<div class="stu-rack-in"></div><div class="stu-rack-add"><button class="stu-b">＋ Channel</button></div>';
    this.host=this.el.firstChild; this.el.querySelector('button').addEventListener('click',ev=>app.addMenu(ev.clientX,ev.clientY));
    this.refresh();
  }
  refresh(){
    const A=this.app, P=A.P, pat=A.patObj(), host=this.host, keep=host.scrollTop; host.innerHTML='';
    if(!pat) return;
    const steps=pat.bars*16, rows=this.el;
    for(const ch of P.channels){
      const row=stuEl('div','stu-ch'+(ch.id===A.cur.ch?' sel':'')+(ch.mute?' mute':'')), head=stuEl('div','stu-chh');
      const led=stuEl('button','stu-led'+(ch.mute?'':' on'),''); led.style.setProperty('--c',ch.color); led.title='Mute';
      led.addEventListener('click',()=>{ ch.mute=!ch.mute; A.eng.rig&&A.eng.rig.refreshChannel(ch); A.commit(); A.refreshRack(); });
      const nm=stuEl('button','stu-chn',stuEsc(ch.name)); nm.title='Click: select · double click: piano roll · right click: menu';
      nm.addEventListener('click',()=>{ A.cur.ch=ch.id; A.refreshRack(); A.dirty('roll'); A.each('roll',r=>r.fit()); A.each('inst',i=>i.refresh()); A.audition(ch.id,A.stepKey(ch),100,.35); });
      nm.addEventListener('dblclick',()=>{ A.cur.ch=ch.id; A.focusTab('roll'); A.refreshRack(); });
      nm.addEventListener('contextmenu',ev=>{ ev.preventDefault(); A.chMenu(ev,ch); });
      const solo=stuEl('button','stu-s'+(ch.solo?' on':''),'S'); solo.title='Solo';
      solo.addEventListener('click',()=>{ ch.solo=!ch.solo; A.eng.rig&&A.eng.rig.refresh(); A.commit(); A.refreshRack(); });
      const vol=stuKnob({small:1,label:'vol',d:{k:'v',min:0,max:1,d:.8},v:ch.vol,onInput:v=>{ ch.vol=v; A.eng.rig&&A.eng.rig.refreshChannel(ch); },onChange:()=>A.commit()});
      const pan=stuKnob({small:1,label:'pan',d:{k:'p',min:-1,max:1,d:0},v:ch.pan,onInput:v=>{ ch.pan=v; A.eng.rig&&A.eng.rig.refreshChannel(ch); },onChange:()=>A.commit()});
      const mix=stuEl('select','stu-mixsel'); mix.title='Mixer insert';
      for(let i=0;i<=ST_INSERTS;i++) mix.append(new Option(i?String(i):'M',i)); mix.value=ch.mix;
      mix.addEventListener('change',()=>{ ch.mix=+mix.value; A.eng.rig&&A.eng.rig.routeChannel(ch); A.commit(); });
      const pr=stuEl('button','stu-pr','🎹'); pr.title='Piano roll'; pr.addEventListener('click',()=>{ A.cur.ch=ch.id; A.focusTab('roll'); A.refreshRack(); A.each('roll',r=>r.fit()); });
      head.append(led,nm,solo,vol,pan,mix,pr);
      const sw=stuEl('div','stu-steps'), notes=pat.notes[ch.id]||[], on=new Set(notes.map(n=>Math.floor(n.t/ST_STEP)));
      for(let i=0;i<steps;i++){ const b=stuEl('div','stu-st'+(on.has(i)?' on':'')+((i>>2)&1?' alt':'')); b.dataset.i=i; b.style.setProperty('--c',ch.color); sw.append(b); }
      this.bindSteps(sw,ch,pat,row);
      row.append(head,sw); host.append(row);
    }
    host.scrollTop=keep; this.stepEls=[...host.querySelectorAll('.stu-steps')]; this._ls=-2;
  }
  bindSteps(sw,ch,pat,row){
    const A=this.app; let mode=null;
    const toggle=(b,force)=>{
      const i=+b.dataset.i, t=i*ST_STEP, arr=stPatNotes(pat,ch.id), has=arr.some(n=>n.t===t);
      const want=force==null?!has:force; if(want===has) return;
      if(want){ arr.push({t,l:ST_STEP,k:A.stepKey(ch),v:100}); A.audition(ch.id,A.stepKey(ch),100,.25); }
      else pat.notes[ch.id]=arr.filter(n=>n.t!==t);
      b.classList.toggle('on',want); A.dirty('roll','list');
    };
    sw.addEventListener('pointerdown',ev=>{ const b=ev.target.closest('.stu-st'); if(!b||ev.button!==0) return; ev.preventDefault();
      if(A.cur.ch!==ch.id){ A.cur.ch=ch.id; this.host.querySelectorAll('.stu-ch').forEach(r=>r.classList.toggle('sel',r===row)); A.dirty('roll'); A.each('inst',i=>i.refresh()); }
      mode=!b.classList.contains('on'); toggle(b,mode); try{ sw.setPointerCapture(ev.pointerId); }catch(e){} });
    sw.addEventListener('pointermove',ev=>{ if(mode==null) return; const el=document.elementFromPoint(ev.clientX,ev.clientY); const b=el&&el.closest&&el.closest('.stu-st'); if(b&&sw.contains(b)) toggle(b,mode); });
    const end=()=>{ if(mode!=null){ mode=null; A.commit(); } };
    sw.addEventListener('pointerup',end); sw.addEventListener('pointercancel',end);
  }
  frame(){
    const A=this.app, pat=A.patObj(), t=A.tickHead; if(!this.stepEls) return;
    const st=t!=null&&pat ? Math.floor((t%stPatLen(pat))/ST_STEP) : -1;
    if(st!==this._ls){ this._ls=st; for(const sw of this.stepEls){ const o=sw.querySelector('.cur'); if(o) o.classList.remove('cur'); if(st>=0&&sw.children[st]) sw.children[st].classList.add('cur'); } }
  }
}

/* ---------- микшер ---------- */
class StuMixer extends StuPanel{
  constructor(app){
    super(app,'mix'); this.el.innerHTML='<div class="stu-strips"></div><div class="stu-fxp"></div>';
    this.stripsEl=this.el.children[0]; this.fxEl=this.el.children[1]; this.meters=new Float32Array(ST_INSERTS+1); this.hold=new Float32Array(ST_INSERTS+1); this.stripCv=[];
    this.refresh();
  }
  refresh(){
    const A=this.app, P=A.P, host=this.stripsEl, keep=host.scrollLeft; host.innerHTML=''; this.stripCv=[];
    P.mixer.forEach((m,i)=>{
      const s=stuEl('div','stu-strip'+(i===A.cur.ins?' sel':'')+(i===0?' master':''));
      const nm=stuEl('div','stu-sn',stuEsc(m.name)); nm.title='Double click to rename';
      nm.addEventListener('dblclick',()=>{ const n=prompt('Insert name',m.name); if(n){ m.name=n; A.commit(); A.refreshMixer(); } });
      const fxl=stuEl('div','stu-sfx',m.fx.length?m.fx.map(f=>`<i class="${f.on?'on':''}">${stuEsc(ST_FX[f.type].name)}</i>`).join(''):'<i class="none">no fx</i>');
      const cv=stuEl('canvas','stu-fad'); cv.width=56; cv.height=170; this.stripCv[i]=cv; cv.title='Drag: volume · double click: reset';
      const setV=ev=>{ const r=cv.getBoundingClientRect(); const y=stClamp(1-(ev.clientY-r.top)/r.height,0,1); m.vol=Math.round(y*1.25*100)/100; A.eng.rig&&A.eng.rig.refreshInsert(i); };
      cv.addEventListener('pointerdown',ev=>{ cv.setPointerCapture(ev.pointerId); cv._d=1; setV(ev); });
      cv.addEventListener('pointermove',ev=>{ if(cv._d) setV(ev); });
      cv.addEventListener('pointerup',()=>{ cv._d=0; A.commit(); }); cv.addEventListener('dblclick',()=>{ m.vol=i?.8:.85; A.eng.rig&&A.eng.rig.refreshInsert(i); A.commit(); });
      const pan=stuKnob({small:1,label:'pan',d:{k:'p',min:-1,max:1,d:0},v:m.pan,onInput:v=>{ m.pan=v; A.eng.rig&&A.eng.rig.refreshInsert(i); },onChange:()=>A.commit()});
      const ms=stuEl('div','stu-ms'), mu=stuEl('button','stu-s'+(m.mute?' on':''),'M'), so=stuEl('button','stu-s'+(m.solo?' on':''),'S');
      mu.addEventListener('click',()=>{ m.mute=!m.mute; mu.classList.toggle('on',m.mute); A.eng.rig&&A.eng.rig.refresh(); A.commit(); });
      so.addEventListener('click',()=>{ m.solo=!m.solo; so.classList.toggle('on',m.solo); A.eng.rig&&A.eng.rig.refresh(); A.commit(); });
      ms.append(mu,so);
      s.append(nm,fxl,cv,pan,ms,stuEl('div','stu-sno',i?String(i):'M'));
      if(A.liteKind==='mixer' && i){
        const sc=stuEl('input','stu-scn'); sc.placeholder='all'; sc.value=m.scenes||''; sc.title='Audible only in these pattern numbers of the scene input (e.g. 1,3-4). Empty = always';
        sc.addEventListener('change',()=>{ m.scenes=sc.value.trim(); if(!m.scenes) delete m.scenes; A.commit(); }); sc.addEventListener('click',ev=>ev.stopPropagation()); s.append(sc);
      }
      s.addEventListener('click',ev=>{ if(ev.target.closest('canvas,button,.stu-knob')) return; A.cur.ins=i; A.cur.slot=-1; A.refreshMixer(); });
      host.append(s);
    });
    host.scrollLeft=keep; this.refreshFx();
  }
  refreshFx(){
    const A=this.app, P=A.P, i=A.cur.ins, m=P.mixer[i], host=this.fxEl; host.innerHTML='';
    host.append(stuEl('h3',null,'FX · '+stuEsc(m.name)));
    const list=stuEl('div','stu-fxl');
    for(let j=0;j<10;j++){
      const f=m.fx[j], row=stuEl('div','stu-slot'+(j===A.cur.slot?' sel':'')+(f?'':' empty'));
      if(f){
        const on=stuEl('button','stu-led'+(f.on?' on':'')); on.addEventListener('click',ev=>{ ev.stopPropagation(); f.on=!f.on; A.eng.rig&&A.eng.rig.buildInsert(i); A.commit(); A.refreshMixer(); });
        const up=stuEl('button','stu-mini','↑'), dn=stuEl('button','stu-mini','↓'), del=stuEl('button','stu-mini','✕');
        up.addEventListener('click',ev=>{ ev.stopPropagation(); if(j>0){ [m.fx[j-1],m.fx[j]]=[m.fx[j],m.fx[j-1]]; A.cur.slot=j-1; this.fxChanged(i); } });
        dn.addEventListener('click',ev=>{ ev.stopPropagation(); if(j<m.fx.length-1){ [m.fx[j+1],m.fx[j]]=[m.fx[j],m.fx[j+1]]; A.cur.slot=j+1; this.fxChanged(i); } });
        del.addEventListener('click',ev=>{ ev.stopPropagation(); m.fx.splice(j,1); A.cur.slot=-1; this.fxChanged(i); });
        row.append(on,stuEl('span','n',stuEsc(ST_FX[f.type].name)),up,dn,del);
        row.addEventListener('click',()=>{ A.cur.slot=j; this.refreshFx(); });
      }else{
        row.append(stuEl('span','n','＋ add effect'));
        row.addEventListener('click',ev=>{ stuMenu(ev.clientX,ev.clientY,ST_FX_ORDER.map(t=>({label:ST_FX[t].name,fn:()=>{
          m.fx.push({id:stNextId(P),type:t,on:true,p:stDefs(ST_FX[t].p)}); A.cur.slot=m.fx.length-1; this.fxChanged(i); }}))); });
      }
      list.append(row);
    }
    host.append(list);
    const f=m.fx[A.cur.slot];
    if(f){
      host.append(stuParams(ST_FX[f.type].p,f.p,(k,v)=>{ f.p[k]=v; const x=A.eng.rig&&A.eng.rig.ins[i].fx[A.cur.slot]; if(x) x.update(f.p,P.bpm); },()=>A.commit()));
    }
    if(i>0){
      host.append(stuEl('h3',null,'Sends'));
      const sl=stuEl('div','stu-sends');
      for(const t in m.sends){
        const d={k:'s',min:0,max:1,d:0,label:P.mixer[t].name};
        sl.append(stuKnob({small:1,label:P.mixer[t].name,d,v:m.sends[t],onInput:v=>{ m.sends[t]=v; A.eng.rig&&A.eng.rig.refreshInsert(i); },onChange:()=>A.commit()}));
      }
      const add=stuEl('button','stu-b','＋ send to…');
      add.addEventListener('click',ev=>stuMenu(ev.clientX,ev.clientY,P.mixer.map((x,t)=>({label:(t||'M')+' '+x.name,dis:t===0||t===i||t in m.sends,
        fn:()=>{ m.sends[t]=.5; A.eng.rig&&A.eng.rig.refreshInsert(i); A.commit(); this.refreshFx(); }})).filter(x=>!x.dis)));
      sl.append(add); host.append(sl);
      if(Object.keys(m.sends).length){ const rm=stuEl('button','stu-b','clear sends'); rm.addEventListener('click',()=>{ m.sends={}; A.eng.rig&&A.eng.rig.refreshInsert(i); A.commit(); this.refreshFx(); }); host.append(rm); }
    }
  }
  fxChanged(i){ const A=this.app; if(A.eng.rig) A.eng.rig.buildInsert(i); A.commit(); A.refreshMixer(); }
  frame(){
    const lv=this.app.levels(), P=this.app.P;
    for(let i=0;i<this.stripCv.length;i++){
      const cv=this.stripCv[i]; if(!cv) continue; const c=cv.getContext('2d'), W=cv.width, H=cv.height, m=P.mixer[i];
      const lvl=lv?lv[i]:0; this.meters[i]=Math.max(lvl,this.meters[i]*.92); this.hold[i]=Math.max(lvl,this.hold[i]-.004);
      const mh=Math.round(Math.min(1,Math.pow(this.meters[i],.5))*H), hh=Math.round(Math.min(1,Math.pow(this.hold[i],.5))*H), key=mh+'|'+hh+'|'+m.vol+'|'+m.mute;
      if(cv._k===key) continue; cv._k=key;                 // ничего не изменилось — не рисуем
      c.fillStyle='#0a0d0e'; c.fillRect(0,0,W,H);
      const g=cv._g||(cv._g=(()=>{ const q=c.createLinearGradient(0,H,0,0); q.addColorStop(0,'#3a9d5d'); q.addColorStop(.7,'#d4c24a'); q.addColorStop(1,'#e05c5c'); return q; })());
      c.fillStyle=g; c.fillRect(W-18,H-mh,12,mh); c.fillStyle='#fff'; c.fillRect(W-18,H-hh,12,1);
      const y=H-m.vol/1.25*H; c.fillStyle='#2a3136'; c.fillRect(10,0,3,H);
      c.fillStyle=m.mute?'#666':'#e0b23c'; c.fillRect(4,Math.max(0,y-5),16,10);
    }
  }
}

/* ---------- редактор строки Drum Machine: ударный звук, клип из Files › audio или строка-триггер ---------- */
class StuInst extends StuPanel{
  constructor(app){ super(app,'inst'); this.refresh(); }
  refresh(){
    const A=this.app, host=this.el; host.innerHTML=''; const ch=A.chObj();
    if(!ch){ host.append(stuEl('div','stu-empty','Add a row in the rack')); return; }
    const head=stuEl('div','stu-ihead'); head.append(stuEl('b',null,stuEsc(ch.name)+' <i>'+(ch.type==='ext'?'trigger':ch.type)+'</i>'));
    if(ch.type==='drum'){
      const s=stuEl('select'); s.append(new Option('— kit sound —','')); for(const n of Object.keys(ST_KITS)) s.append(new Option(n,n));
      s.addEventListener('change',()=>{ if(!s.value) return; ch.p=stFillP(ST_DRUM,ST_KITS[s.value]); A.commit(); this.refresh(); }); head.append(s);
    }else if(ch.type==='sampler'){
      // клип из библиотеки Files › audio (как у узла Sampler) или файл с диска
      const sel=stuEl('select'); sel.append(new Option('— clip from Files › audio —',''));
      const list=(typeof SamplerClips!=='undefined'?SamplerClips:[]).slice(); if(ch.p.clip && !list.includes(ch.p.clip)) list.push(ch.p.clip);
      for(const c of list) sel.append(new Option(c,c)); sel.value=ch.p.clip||'';
      sel.addEventListener('change',async()=>{ ch.p.clip=sel.value; ch.p.sname=''; delete A.eng.samples[ch.id]; delete A.clips[ch.id]; const id=parseInt(sel.value);
        if(id){ try{ await A.eng.loadClip(ch.id,id); ch.name=sel.value.replace(/^\d+:\s*/,'').split('/').pop(); }catch(e){ A.say('clip not found'); } }
        A.commit(); A.refreshAll(); });
      const rs=stuEl('button','stu-b','↻ library'); rs.addEventListener('click',async()=>{ if(typeof samplerScan==='function'){ await samplerScan(); this.refresh(); } });
      const b=stuEl('button','stu-b','Load file…'); b.addEventListener('click',async()=>{ const f=await stuPick('audio/*'); if(!f) return;
        try{ await A.eng.loadSample(ch.id,f); ch.p.sname=f.name; ch.p.clip=''; A.commit(); this.refresh(); }catch(e){ alert('Cannot decode: '+e.message); } });
      head.append(sel,rs,b,stuEl('span','stu-dim',stuEsc(ch.p.clip||ch.p.sname||'no sample')));
    }else{
      head.append(stuEl('span','stu-dim','Trigger row: no sound of its own — only its gate pin fires on every step. Wire it to a Sampler or any trigger input.'));
      host.append(head); return;
    }
    host.append(head);
    const pan=stuParams(ST_CHDEF[ch.type],ch.p,(k,v)=>{ ch.p[k]=v; },()=>A.commit());
    host.append(pan);
    if(ch.type==='sampler' && A.eng.samples[ch.id] && A.eng.samples[ch.id].buf){ const cv=stuEl('canvas','stu-env'); cv.width=520; cv.height=90; host.insertBefore(cv,pan); this.drawWave(cv,A.eng.samples[ch.id].buf); }
  }
  drawWave(cv,buf){
    const c=cv.getContext('2d'), W=cv.width, H=cv.height, d=buf.getChannelData(0); c.fillStyle='#0a0d0e'; c.fillRect(0,0,W,H);
    c.strokeStyle='#4ec9b0'; c.beginPath();
    for(let x=0;x<W;x++){ let mn=1,mx=-1; const a=Math.floor(x/W*d.length), b=Math.floor((x+1)/W*d.length);
      for(let i=a;i<b;i+=Math.max(1,(b-a)>>6)){ if(d[i]<mn) mn=d[i]; if(d[i]>mx) mx=d[i]; }
      c.moveTo(x,H/2-mx*H/2); c.lineTo(x,H/2-mn*H/2+1); } c.stroke();
  }
}
