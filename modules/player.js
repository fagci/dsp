"use strict";
/* ============================ PLAYER (Winamp) ============================
   Music Player — плейлист из файлов и URL, prev / play / pause / stop / next, перемотка, громкость и баланс,
   shuffle и repeat, теги ID3, стерео на выходе; следующий трек декодируется заранее (без паузы между треками).
   Graphic Equalizer (10 bands) — десять полос Winamp и предусилитель, пресеты. Ядро — modules/player-kernels.js. */

const WA_EXT=/\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|weba|webm)$/i;
let waAC=null;
const waEl=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
const waSet=(el,t)=>{ if(el.textContent!==t) el.textContent=t; };

async function waDecode(src){
  const raw=typeof src==='string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer();
  const ac=Eng.ctx||waAC||(waAC=new (window.AudioContext||window.webkitAudioContext)());
  const b=await ac.decodeAudioData(raw);
  const L=b.getChannelData(0);
  return {L, R:b.numberOfChannels>1 ? b.getChannelData(1) : L, sr:b.sampleRate, ch:b.numberOfChannels};
}
async function waTag(t){
  if(typeof t.src==='string') return;
  try{
    const head=new Uint8Array(await t.src.slice(0,524288).arrayBuffer());
    let tag=wpId3(head);
    if(!tag.title && t.src.size>=128) tag=wpId3(new Uint8Array(await t.src.slice(t.src.size-128).arrayBuffer()));
    t.tag=tag;
  }catch(e){}
}
const waTitle=t=>t ? wpName(t.tag, typeof t.src==='string' ? decodeURIComponent(t.src.split('?')[0]) : t.src.name) : '';

function waOrder(n){ n.order=wpOrder(n.list.length,n.p.shuffle,n.cur); }
function waAdd(n,srcs){
  for(const s of srcs){
    if(typeof s!=='string' && !(s.type.startsWith('audio/') || WA_EXT.test(s.name))) continue;
    const t={src:s, tag:null, dur:0, err:''}; n.list.push(t);
    waTag(t).then(()=>{ n.dirty=true; }); }
  waOrder(n); n.dirty=true;
  if(n.cur<0 && n.list.length) waStart(n,0,false);
}
function waPrefetch(n){
  const nx=wpStep(n.order,n.cur,1,n.p.repeat,true);
  if(nx<0 || nx===n.cur || n.nxt?.idx===nx) return;
  const t=n.list[nx], rec={idx:nx, src:t.src, data:null}; n.nxt=rec;
  waDecode(t.src).then(d=>{ rec.data=d; t.dur=d.L.length/d.sr; n.dirty=true; }).catch(()=>{ if(n.nxt===rec) n.nxt=null; });
}
function waUse(n,idx,d,play){
  const t=n.list[idx]; n.cur=idx; n.data=d; n.pos=0; n.loading=false; n.rewind=false; n.play=play; t.dur=d.L.length/d.sr; t.err='';
  n.title=waTitle(t); n.dirty=true; n.fails=0; waPrefetch(n);
}
function waStart(n,idx,play){
  const t=n.list[idx]; if(!t) return;
  n.cur=idx; n.dirty=true; n.title=waTitle(t);
  const id=++n.lid;
  if(n.nxt && n.nxt.idx===idx && n.nxt.src===t.src && n.nxt.data){ const d=n.nxt.data; n.nxt=null; waUse(n,idx,d,play); return; }
  n.nxt=null; n.data=null; n.play=false; n.loading=true;
  waDecode(t.src).then(d=>{ if(id===n.lid) waUse(n,idx,d,play); })
    .catch(e=>{ if(id!==n.lid) return;
      n.loading=false; t.err=String(e.message||e).slice(0,60)||'decode error'; n.dirty=true;
      if(play && ++n.fails<n.list.length) waNext(n,1,true); });
}
function waNext(n,dir,auto){
  const j=wpStep(n.order,n.cur,dir,n.p.repeat,auto);
  if(j<0){ n.play=false; n.rewind=true; n.dirty=true; return; }
  waStart(n,j,n.play||!!auto);
}
function waToggle(n){
  if(!n.data){ if(n.cur>=0 && !n.loading) waStart(n,n.cur,true); return; }
  n.play=!n.play; n.rewind=false; n.dirty=true;
}
function waStop(n){ n.play=false; n.rewind=true; n.dirty=true; }
function waRemove(n,i){
  n.list.splice(i,1);
  if(i===n.cur){ n.lid++; n.data=null; n.play=false; n.loading=false; n.nxt=null; n.cur=Math.min(i,n.list.length-1); n.title='';
    if(n.cur>=0) waStart(n,n.cur,false); }
  else if(i<n.cur) n.cur--;
  waOrder(n); n.nxt=null; n.dirty=true;
}

function waMount(n){
  const root=waEl('div','wa'); root.tabIndex=0;
  root.innerHTML=
   '<div class="wa-lcd"><b class="wa-time" data-f="time" title="click: elapsed / remaining">00:00</b>'+
   '<div class="wa-inf"><div class="wa-title" data-f="title"></div><div class="wa-sub" data-f="info"></div></div></div>'+
   '<input class="wa-seek" type="range" min="0" max="1000" value="0" data-f="seek">'+
   '<div class="wa-row"><span class="wa-tr">'+
     '<button data-a="prev" title="previous (Z)">⏮</button><button data-a="play" title="play (X)">▶</button>'+
     '<button data-a="pause" title="pause (C)">⏸</button><button data-a="stop" title="stop (V)">⏹</button>'+
     '<button data-a="next" title="next (B)">⏭</button></span>'+
     '<label title="volume">🔊<input type="range" min="0" max="1" step="0.01" data-f="vol"></label>'+
     '<label title="balance">⚖<input type="range" min="-1" max="1" step="0.01" data-f="bal"></label></div>'+
   '<div class="wa-row"><button data-a="shuf">shuffle</button><button data-a="rep">repeat</button>'+
     '<button data-a="add">+ files</button><button data-a="url">+ URL</button><button data-a="clr">clear</button></div>'+
   '<div class="wa-pl" data-f="pl"></div>';
  const f={}; for(const e of root.querySelectorAll('[data-f]')) f[e.dataset.f]=e;
  const inp=waEl('input'); inp.type='file'; inp.multiple=true; inp.accept='audio/*'; inp.hidden=true; root.append(inp);
  const act={
    prev:()=>waNext(n,-1,false), next:()=>waNext(n,1,false), stop:()=>waStop(n),
    play:()=>{ if(n.data){ n.play=true; n.rewind=false; if(n.pos>=n.data.L.length-1) n.pos=0; } else waToggle(n); n.dirty=true; },
    pause:()=>{ if(n.data){ n.play=!n.play; n.rewind=false; n.dirty=true; } },
    shuf:()=>{ n.p.shuffle=!n.p.shuffle; waOrder(n); n.nxt=null; n.dirty=true; },
    rep:()=>{ const o=['off','all','one']; n.p.repeat=o[(o.indexOf(n.p.repeat)+1)%3]; n.nxt=null; n.dirty=true; },
    add:()=>inp.click(),
    url:()=>{ const u=prompt('Audio URL (CORS must allow it)'); if(u&&u.trim()) waAdd(n,[u.trim()]); },
    clr:()=>{ n.lid++; n.list=[]; n.cur=-1; n.data=null; n.play=false; n.loading=false; n.nxt=null; n.title=''; waOrder(n); n.dirty=true; }};
  root.addEventListener('click',e=>{
    const b=e.target.closest('button[data-a]'); if(b){ act[b.dataset.a](); return; }
    if(e.target.closest('[data-f="time"]')){ n.p.remain=!n.p.remain; n.dirty=true; return; }
    const it=e.target.closest('.wa-it'); if(!it) return;
    const i=+it.dataset.i;
    if(e.target.closest('.x')) waRemove(n,i);
    else if(i!==n.cur || !n.data) { waStart(n,i,true); } });
  inp.addEventListener('change',()=>{ waAdd(n,[...inp.files]); inp.value=''; });
  f.pl.addEventListener('dblclick',e=>{ const it=e.target.closest('.wa-it'); if(it && !e.target.closest('.x')) waStart(n,+it.dataset.i,true); });
  f.seek.addEventListener('input',()=>{ if(n.data) n.pos=f.seek.value/1000*(n.data.L.length-1); });
  f.seek.addEventListener('pointerdown',()=>{ n.ui.drag=true; });
  addEventListener('pointerup',()=>{ if(n.ui) n.ui.drag=false; });
  f.vol.addEventListener('input',()=>{ n.p.vol=+f.vol.value; });
  f.bal.addEventListener('input',()=>{ n.p.bal=+f.bal.value; });
  f.bal.addEventListener('dblclick',()=>{ n.p.bal=0; });
  root.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.target.tagName==='INPUT') return;
    const k={z:'prev',x:'play',c:'pause',v:'stop',b:'next'}[e.key.toLowerCase()]; if(k) act[k](); });
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  root.addEventListener('dragover',e=>{ e.preventDefault(); });
  root.addEventListener('drop',e=>{ e.preventDefault(); if(e.dataTransfer?.files?.length) waAdd(n,[...e.dataTransfer.files]); });
  n.mid.append(root);
  n.ui={root,f,drag:false,btn:{},plKey:''};
  for(const b of root.querySelectorAll('button[data-a]')) n.ui.btn[b.dataset.a]=b;
  n.dirty=true;
}
function waRender(n){
  const {f,btn}=n.ui, d=n.data, cur=n.list[n.cur];
  const len=d?d.L.length/d.sr:0, pos=d?n.pos/d.sr:0;
  waSet(f.time,wpTime(n.p.remain && d ? pos-len : pos));
  waSet(f.title,n.loading ? 'loading… '+n.title : n.title||(n.list.length?'':'drop audio files here'));
  waSet(f.info,cur?.err ? 'error: '+cur.err : d ? Math.round(d.sr/1000)+' kHz · '+(d.ch>1?'stereo':'mono')+' · '+wpTime(len)+(n.play?'':n.pos>0?' · paused':' · stopped')
    : n.list.length+' tracks');
  if(!n.ui.drag) f.seek.value=len?Math.round(pos/len*1000):0;
  if(document.activeElement!==f.vol) f.vol.value=n.p.vol;
  if(document.activeElement!==f.bal) f.bal.value=n.p.bal;
  btn.play.classList.toggle('on',n.play); btn.pause.classList.toggle('on',!n.play&&!!d&&n.pos>0);
  btn.shuf.classList.toggle('on',n.p.shuffle);
  waSet(btn.rep,'repeat: '+n.p.repeat); btn.rep.classList.toggle('on',n.p.repeat!=='off');
  const key=n.list.length+'|'+n.cur+'|'+n.loading+'|'+n.list.map(t=>(t.dur|0)+(t.err?'!':'')+(t.tag?.title||'')).join(',');
  if(key===n.ui.plKey) return;
  n.ui.plKey=key; n.dirty=false;
  const keep=f.pl.scrollTop; f.pl.textContent='';
  n.list.forEach((t,i)=>{
    const it=waEl('div','wa-it'+(i===n.cur?' cur':'')+(t.err?' bad':'')); it.dataset.i=i;
    it.append(waEl('span','i',(i+1)+'.'),waEl('span','t',waTitle(t)),waEl('span','d',t.dur?wpTime(t.dur):''),waEl('button','x','×'));
    f.pl.append(it); });
  f.pl.scrollTop=keep;
  f.pl.querySelector('.cur')?.scrollIntoView({block:'nearest'});
}

def({ id:'winamp', title:'Music Player (Winamp)', cat:'Music', resize:true, w:340, h:430, readout:false,
  kw:'winamp player playlist mp3 music track next previous shuffle repeat volume balance id3 stereo',
  ins:[{n:'play',t:'num'},{n:'next',t:'num'},{n:'prev',t:'num'},{n:'stop',t:'num'},{n:'seek',t:'num'},{n:'vol',t:'num'},{n:'bal',t:'num'}],
  outs:[{n:'l',t:'sig'},{n:'r',t:'sig'},{n:'pos',t:'num'},{n:'time',t:'num'},{n:'track',t:'num'},
        {n:'playing',t:'num'},{n:'done',t:'num'},{n:'title',t:'txt'}],
  params:[{n:'vol',t:'range',min:0,max:1.5,step:.01,d:.8,label:'volume'},
          {n:'bal',t:'range',min:-1,max:1,step:.01,d:0,label:'balance'},
          {n:'rate',t:'range',min:.5,max:2,step:.01,d:1,label:'speed (pitch changes with it)'},
          {n:'shuffle',t:'check',d:false,label:'shuffle',fn:n=>{ waOrder(n); n.nxt=null; n.dirty=true; }},
          {n:'repeat',t:'select',opts:['off','all','one'],d:'off',label:'repeat',fn:n=>{ n.nxt=null; n.dirty=true; }},
          {n:'remain',t:'check',d:false,label:'show remaining time'}],
  init:n=>{ n.list=[]; n.order=[]; n.cur=-1; n.data=null; n.pos=0; n.play=false; n.run=0; n.rewind=false; n.loading=false;
    n.lid=0; n.nxt=null; n.title=''; n.fails=0; n.dirty=true; n.ui=null; n.edge={}; },
  dispose:n=>{ n.lid++; n.data=null; n.nxt=null; n.list=[]; },
  process(n,I){
    const oL=buf(n,'l'), oR=buf(n,'r');
    const pulse=(k,fn)=>{ const v=typeof I[k]==='number' && I[k]>=.5; if(v && !n.edge[k]) fn(); n.edge[k]=v; };
    pulse('play',()=>waToggle(n)); pulse('next',()=>waNext(n,1,false)); pulse('prev',()=>waNext(n,-1,false)); pulse('stop',()=>waStop(n));
    if(typeof I.vol==='number') setMod(n,'vol',I.vol);
    if(typeof I.bal==='number') setMod(n,'bal',I.bal);
    const d=n.data;
    if(d && typeof I.seek==='number' && I.seek>=0 && I.seek<=1 && Math.abs(I.seek-(n.seekPrev??-1))>1e-6){
      n.pos=I.seek*(d.L.length-1); n.seekPrev=I.seek; }
    let done=0;
    if(!d){ oL.fill(0); oR.fill(0); }
    else {
      const [bl,br]=wpBalance(n.p.bal), vol=n.p.vol, r=n.p.rate*d.sr/Eng.sr, len=d.L.length, st=1/(.015*Eng.sr);
      let ended=false;
      for(let i=0;i<BLOCK;i++){
        const tg=n.play?1:0;
        n.run = n.run<tg ? Math.min(tg,n.run+st) : Math.max(tg,n.run-st);       // плавный пуск и остановка без щелчков
        if(n.run<=0 && !n.play){ if(n.rewind){ n.pos=0; n.rewind=false; } oL[i]=0; oR[i]=0; continue; }
        if(n.pos>=len-1){
          if(n.p.repeat==='one') n.pos=0;
          else { ended=true; for(;i<BLOCK;i++){ oL[i]=0; oR[i]=0; } break; } }
        const i0=n.pos|0, fr=n.pos-i0, g=vol*n.run;
        oL[i]=(d.L[i0]*(1-fr)+d.L[i0+1]*fr)*g*bl; oR[i]=(d.R[i0]*(1-fr)+d.R[i0+1]*fr)*g*br;
        n.pos+=r; }
      if(ended){
        const nx=wpStep(n.order,n.cur,1,n.p.repeat,true);
        if(nx<0){ n.play=false; n.rewind=true; n.pos=0; done=1; n.dirty=true; }
        else if(n.nxt && n.nxt.idx===nx && n.nxt.data){ const dd=n.nxt.data; n.nxt=null; waUse(n,nx,dd,true); }
        else { n.play=true; waStart(n,nx,true); } }
    }
    const dd=n.data;
    return {l:oL, r:oR, pos:dd?n.pos/dd.L.length:0, time:dd?n.pos/dd.sr:0, track:n.cur+1,
            playing:n.play?1:0, done, title:n.title}; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected) waMount(n);
    waRender(n); }
});


/* ---------- 10-band equalizer ---------- */
const EQ_BANDS=WP_BANDS.length;
def({ id:'eq10', title:'Graphic Equalizer (10 bands)', cat:'Audio', resize:true, w:340, h:230,
  kw:'winamp equalizer eq graphic 10 band preamp preset bass treble',
  ins:[{n:'l',t:'sig'},{n:'r',t:'sig'},{n:'on',t:'num'},{n:'preamp',t:'num'}],
  outs:[{n:'l',t:'sig'},{n:'r',t:'sig'}],
  params:[{n:'on',t:'check',d:true,label:'on'},
          {n:'preset',t:'select',opts:Object.keys(WP_EQ),d:'Flat',label:'preset',fn:n=>eqApply(n,WP_EQ[n.p.preset])},
          {n:'preamp',t:'range',min:-12,max:12,step:.1,d:0,label:'preamp, dB'},
          ...WP_BANDS.map((f,i)=>({n:'b'+i,t:'range',min:-12,max:12,step:.1,d:0,hidden:true,label:WP_BAND_NAMES[i]+' Hz, dB'}))],
  onReset:n=>eqApply(n,WP_EQ.Flat),
  init:n=>{ n.st=[[],[]]; n.ck=''; n.c=null; n.ui=null;
    for(let c=0;c<2;c++) for(let i=0;i<EQ_BANDS;i++) n.st[c].push({x1:0,x2:0,y1:0,y2:0}); },
  process(n,I){
    if(typeof I.on==='number') setMod(n,'on',I.on>=.5);
    if(typeof I.preamp==='number') setMod(n,'preamp',I.preamp);
    const oL=buf(n,'l'), oR=buf(n,'r'), a=I.l, b=I.r||I.l, sr=Eng.sr, p=n.p;
    const gs=WP_BANDS.map((f,i)=>p['b'+i]);
    const key=gs.join(',')+'/'+sr;
    if(key!==n.ck){ n.ck=key; n.c=WP_BANDS.map((f,i)=>Math.abs(gs[i])<.05 ? null : wpPeak(f,gs[i],1.6,sr)); }
    const pre=Math.pow(10,p.preamp/20), on=p.on;
    const run=(x,y,s)=>{
      for(let i=0;i<BLOCK;i++){
        let v=x?x[i]:0;
        if(on){ v*=pre;
          for(let k=0;k<EQ_BANDS;k++){ const c=n.c[k]; if(!c) continue; const q=s[k];
            const o=c[0]*v+c[1]*q.x1+c[2]*q.x2-c[3]*q.y1-c[4]*q.y2;
            q.x2=q.x1; q.x1=v; q.y2=q.y1; q.y1=o; v=o; } }
        y[i]=v; } };
    run(a,oL,n.st[0]); run(b,oR,n.st[1]);
    return {l:oL, r:oR}; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected) eqMount(n);
    const u=n.ui, p=n.p;
    for(let i=0;i<EQ_BANDS;i++) if(document.activeElement!==u.sl[i] && +u.sl[i].value!==p['b'+i]){ u.sl[i].value=p['b'+i]; u.sl[i].title=p['b'+i].toFixed(1)+' dB'; }
    if(document.activeElement!==u.pre && +u.pre.value!==p.preamp) u.pre.value=p.preamp;
    eqCurve(n); }
});
function eqApply(n,pr){
  if(!pr) return;
  n.p.preamp=pr.pre; pr.g.forEach((g,i)=>{ n.p['b'+i]=g; });
  if(n.set?.preamp) n.set.preamp(pr.pre);
}
// кривая отклика по десяти полосам (сумма пиков в дБ)
function eqCurve(n){
  const cv=n.ui.cv, cx=n.ui.cx, W=cv.width, H=cv.height;
  const key=n.ck+'|'+n.p.on+'|'+W+'x'+H; if(key===n.ui.ck) return; n.ui.ck=key;
  cx.clearRect(0,0,W,H);
  cx.strokeStyle=themeColor('--line'); cx.lineWidth=1; cx.beginPath(); cx.moveTo(0,H/2+.5); cx.lineTo(W,H/2+.5); cx.stroke();
  if(!n.c) return;
  const sr=Eng.sr; cx.strokeStyle=themeColor(n.p.on?'--acc2':'--dim'); cx.lineWidth=2; cx.beginPath();
  for(let x=0;x<W;x++){
    const f=20*Math.pow(1000,x/(W-1)), w=2*Math.PI*f/sr, c1=Math.cos(w), s1=Math.sin(w), c2=Math.cos(2*w), s2=Math.sin(2*w);
    let db=n.p.preamp;
    for(const c of n.c){ if(!c) continue;
      const nr=c[0]+c[1]*c1+c[2]*c2, ni=-(c[1]*s1+c[2]*s2), dr=1+c[3]*c1+c[4]*c2, di=-(c[3]*s1+c[4]*s2);
      db+=10*Math.log10((nr*nr+ni*ni)/(dr*dr+di*di+1e-30)+1e-30); }
    const y=H/2-db/12*(H/2-2); x?cx.lineTo(x,y):cx.moveTo(x,y); }
  cx.stroke();
}
function eqMount(n){
  const root=waEl('div','eq10');
  const top=waEl('div','eq-top'), rs=waEl('button','','reset');
  const cv=waEl('canvas','eq-cv'); cv.width=300; cv.height=40;
  top.append(rs);
  const sl=waEl('div','eq-sl'), box=[], pre=waEl('input');
  const col=(lab,inp)=>{ const c=waEl('div','eq-c'); c.append(inp,waEl('span','',lab)); sl.append(c); };
  pre.type='range'; pre.min=-12; pre.max=12; pre.step=.1; pre.value=0; pre.className='eq-v'; pre.title='preamp'; col('pre',pre);
  for(let i=0;i<EQ_BANDS;i++){
    const s=waEl('input'); s.type='range'; s.min=-12; s.max=12; s.step=.1; s.className='eq-v';
    s.addEventListener('input',()=>{ n.p['b'+i]=+s.value; s.title=(+s.value).toFixed(1)+' dB'; });
    s.addEventListener('dblclick',()=>{ n.p['b'+i]=0; s.value=0; });
    box.push(s); col(WP_BAND_NAMES[i],s); }
  pre.addEventListener('input',()=>{ n.p.preamp=+pre.value; });
  pre.addEventListener('dblclick',()=>{ n.p.preamp=0; pre.value=0; });
  rs.addEventListener('click',()=>{ n.set?.preset ? n.set.preset('Flat') : (n.p.preset='Flat'); eqApply(n,WP_EQ.Flat); });
  root.append(top,cv,sl);
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  n.mid.append(root);
  n.ui={root,sl:box,pre,cv,cx:cv.getContext('2d'),ck:''};
}
