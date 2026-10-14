"use strict";
/* ============================ PLAYER (Winamp) ============================
   Music Player — проигрыватель одной дорожки: play / pause / stop, перемотка, громкость и баланс, время, kbps / kHz, стерео на
   выходе; следующий трек декодируется заранее (без паузы между треками). Список дорожек — отдельный узел Playlist
   (modules/playlist.js): его выходы fs / url / name / go / nfs / nurl идут сюда, а next / prev / end / req / playing — обратно.
   Файл — запись общего файлового хранилища (FileStore), URL (интернет-радио, потоки) играет через <audio> тем же путём, что
   Audio Stream. Без плейлиста: eject открывает один файл с диска.
   Graphic Equalizer (10 bands) — десять полос Winamp и предусилитель, пресеты. Ядро — modules/player-kernels.js. */

let waAC=null;
async function waDecode(fs){
  const r=await FileStore.get(fs);
  if(!r) throw new Error('file is missing in the library');
  const raw=await r.blob.arrayBuffer();
  const ac=Eng.ctx||waAC||(waAC=new (window.AudioContext||window.webkitAudioContext)());
  const b=await ac.decodeAudioData(raw);
  const L=b.getChannelData(0);
  return {L, R:b.numberOfChannels>1 ? b.getChannelData(1) : L, sr:b.sampleRate, ch:b.numberOfChannels, size:r.size||0};
}
const waHas=n=>!!n.data || (n.mode==='stream' && n.sx.connected);
const waKey=(fs,url)=>url ? 'u:'+url : fs>=0 ? 'f:'+fs : '';
function waStreamEnd(n){ if(n.sx.audioEl) n.sx.audioEl.pause(); streamStop(n.sx); n.sxEnded=false; }
function waLen(n){ return n.mode==='stream' ? (n.sx.audioEl && isFinite(n.sx.audioEl.duration) ? n.sx.audioEl.duration : 0) : n.data ? n.data.L.length/n.data.sr : 0; }
function waPos(n){ return n.mode==='stream' ? (n.sx.audioEl ? n.sx.audioEl.currentTime : 0) : n.data ? n.pos/n.data.sr : 0; }
function waSeek(n,fr){
  if(n.mode==='stream'){ const L=waLen(n); if(L && n.sx.audioEl) n.sx.audioEl.currentTime=fr*L; }
  else if(n.data) n.pos=fr*(n.data.L.length-1); }
function waPlayPause(n,on){
  n.play=on; n.rewind=false; n.dirty=true;
  if(n.mode==='stream' && n.sx.audioEl){ if(on) n.sx.audioEl.play().catch(()=>{}); else n.sx.audioEl.pause(); }
}
function waStop(n){
  n.play=false; n.rewind=true; n.dirty=true;
  if(n.mode==='stream') waStreamEnd(n); }
// play / pause: нечего играть — просим у плейлиста текущую дорожку
function waToggle(n){
  if(!waHas(n)){ if(!n.loading) n.pulse.req=2; return; }
  waPlayPause(n,!n.play);
}
function waUse(n,tr,d,play){
  n.tr=tr; n.curKey=waKey(tr.fs,tr.url); n.mode='file'; n.data=d; n.pos=0; n.loading=false; n.rewind=false; n.play=play; n.err='';
  n.dirty=true; n.fails=0; }
// загрузить дорожку tr={fs,url,name}; play — начать сразу
function waLoad(n,tr,play){
  const id=++n.lid; n.err=''; n.tr=tr; n.curKey=waKey(tr.fs,tr.url); n.dirty=true;
  if(tr.url){                                           // поток / URL: <audio> → тап в граф, как у Audio Stream
    n.data=null; n.nxt=null; n.mode='stream'; n.play=play; n.rewind=false; n.pos=0; n.waiting=false;
    waStreamEnd(n);
    if(play){ n.loading=true; n.sx.p.url=tr.url;
      streamPlay(n.sx).then(()=>{ if(id!==n.lid) return;
        n.loading=false;
        if(!n.sx.connected){ n.err=(n.sx.status||'error').slice(0,60); n.play=false; n.pulse.next=n.fails++<3?2:0; n.dirty=true; return; }
        n.fails=0; n.sx.audioEl?.addEventListener('ended',()=>{ if(id===n.lid) n.sxEnded=true; }); n.dirty=true; }); }
    return; }
  waStreamEnd(n); n.mode='file'; n.waiting=false;
  if(n.nxt && n.nxt.fs===tr.fs && n.nxt.data){ const d=n.nxt.data; n.nxt=null; waUse(n,tr,d,play); return; }
  n.nxt=null; n.data=null; n.play=false; n.loading=true;
  waDecode(tr.fs).then(d=>{ if(id===n.lid) waUse(n,tr,d,play); })
    .catch(e=>{ if(id!==n.lid) return;
      n.loading=false; n.err=String(e.message||e).slice(0,60)||'decode error'; n.dirty=true;
      if(play && n.fails++<3) n.pulse.next=2; });          // битый файл — к следующему
}
// следующая дорожка плейлиста декодируется заранее
function waPrefetch(n,nfs){
  if(!(nfs>=0) || !n.data || n.nxt?.fs===nfs || nfs===n.tr?.fs) return;
  const rec={fs:nfs, data:null}; n.nxt=rec;
  waDecode(nfs).then(d=>{ rec.data=d; }).catch(()=>{ if(n.nxt===rec) n.nxt=null; });
}

function waMount(n){
  const root=waEl('div','wa'); root.tabIndex=0;
  const B=(a,t)=>'<button data-a="'+a+'" title="'+t+'">'+waSvg(a)+'</button>';
  root.innerHTML=
   '<div class="wa-lcd"><div class="wa-clock"><span class="wa-st" data-f="state"></span><b class="wa-time" data-f="time" title="click: elapsed / remaining">00:00</b></div>'+
   '<div class="wa-inf"><div class="wa-title" data-f="title"></div>'+
   '<div class="wa-badges"><span data-f="kbps">— kbps</span><span data-f="khz">— kHz</span><span data-f="mono">mono</span><span data-f="stereo">stereo</span></div></div></div>'+
   '<input class="wa-seek" type="range" min="0" max="1000" value="0" data-f="seek">'+
   '<div class="wa-row wa-main"><span class="wa-tr">'+B('prev','previous (Z)')+B('play','play (X)')+B('pause','pause (C)')+B('stop','stop (V)')+B('next','next (B)')+
     B('eject','open a file from this device')+'</span></div>'+
   '<div class="wa-row wa-sl"><label title="volume">'+waSvg('vol')+'<input type="range" min="0" max="1.5" step="0.01" data-f="vol"></label>'+
     '<label title="balance (double click: centre)">'+waSvg('bal')+'<input type="range" min="-1" max="1" step="0.01" data-f="bal"></label></div>';
  const f={}; for(const e of root.querySelectorAll('[data-f]')) f[e.dataset.f]=e;
  const inp=waEl('input'); inp.type='file'; inp.accept='audio/*'; inp.hidden=true; root.append(inp);
  const act={
    prev:()=>{ n.pulse.prev=2; }, next:()=>{ n.pulse.next=2; }, stop:()=>waStop(n),
    play:()=>{ if(waHas(n)){ if(n.mode==='file' && n.pos>=n.data.L.length-1) n.pos=0; waPlayPause(n,true); } else waToggle(n); },
    pause:()=>{ if(waHas(n)) waPlayPause(n,!n.play); },
    eject:()=>inp.click()};
  root.addEventListener('click',e=>{
    const b=e.target.closest('button[data-a]'); if(b){ act[b.dataset.a](); return; }
    if(e.target.closest('[data-f="time"]')){ n.p.remain=!n.p.remain; n.dirty=true; } });
  inp.addEventListener('change',async()=>{
    const ids=await waImportFiles([...inp.files],'files'); inp.value='';
    if(ids.length) waLoad(n,{fs:ids[0],url:'',name:''},true); });
  f.seek.addEventListener('input',()=>waSeek(n,f.seek.value/1000));
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
  n.mid.append(root);
  n.ui={root,f,drag:false,btn:{}};
  for(const b of root.querySelectorAll('button[data-a]')) n.ui.btn[b.dataset.a]=b;
}
function waShown(n){
  if(n.mode==='stream' && n.sx.icyRaw) return n.sx.icyRaw+(n.tr?.name?' · '+n.tr.name:'');
  const nm=n.tr?.name||(n.tr?.url||'');
  return n.loading ? 'loading… '+nm : nm||'no track — wire a Playlist or open a file';
}
function waRender(n){
  const {f,btn}=n.ui, d=n.data, st=n.mode==='stream';
  const len=waLen(n), pos=waPos(n), has=waHas(n), kb=!st && d?.size && len ? Math.round(d.size*8/len/1000) : 0;
  const state=n.play&&has ? 'play' : has&&pos>0 ? 'pause' : 'stop';
  if(f.state._s!==state){ f.state._s=state; f.state.innerHTML=waSvg(state); }
  waSet(f.time,wpTime(n.p.remain && len ? pos-len : pos));
  waSet(f.title,n.err ? 'error: '+n.err : waShown(n));
  waSet(f.kbps,(kb||'—')+' kbps'); waSet(f.khz,(d&&!st?Math.round(d.sr/1000):'—')+' kHz');
  f.mono.classList.toggle('on',!!d&&!st&&d.ch===1); f.stereo.classList.toggle('on',st||(!!d&&d.ch>1));
  f.title.classList.toggle('bad',!!n.err);
  if(!n.ui.drag) f.seek.value=len?Math.round(pos/len*1000):0;
  if(document.activeElement!==f.vol) f.vol.value=n.p.vol;
  if(document.activeElement!==f.bal) f.bal.value=n.p.bal;
  btn.play.classList.toggle('on',state==='play'); btn.pause.classList.toggle('on',state==='pause');
}

def({ id:'winamp', title:'Music Player (Winamp)', cat:'Music', resize:true, w:340, h:200, readout:false,
  kw:'winamp player mp3 music play pause stop volume balance id3 stereo radio library files playlist',
  ins:[{n:'play',t:'num'},{n:'next',t:'num'},{n:'prev',t:'num'},{n:'stop',t:'num'},{n:'seek',t:'num'},{n:'vol',t:'num'},{n:'bal',t:'num'},
       {n:'fs',t:'num'},{n:'url',t:'txt'},{n:'name',t:'txt'},{n:'go',t:'num'},{n:'nfs',t:'num'},{n:'nurl',t:'txt'}],
  outs:[{n:'l',t:'sig'},{n:'r',t:'sig'},{n:'pos',t:'num'},{n:'time',t:'num'},{n:'playing',t:'num'},{n:'end',t:'num'},{n:'title',t:'txt'},
        {n:'next',t:'num'},{n:'prev',t:'num'},{n:'req',t:'num'}],
  params:[{n:'vol',t:'range',min:0,max:1.5,step:.01,d:.8,label:'volume',hidden:true},
          {n:'bal',t:'range',min:-1,max:1,step:.01,d:0,label:'balance',hidden:true},
          {n:'rate',t:'range',min:.5,max:2,step:.01,d:1,label:'speed of files (pitch changes with it)',hidden:true},
          {n:'remain',t:'check',d:false,label:'show remaining time',hidden:true}],
  init:n=>{ n.tr=null; n.curKey=''; n.data=null; n.mode='file'; n.pos=0; n.play=false; n.run=0; n.rewind=false; n.loading=false; n.err='';
    n.lid=0; n.nxt=null; n.fails=0; n.dirty=true; n.ui=null; n.edge={}; n.sxEnded=false; n.waiting=false;
    n.pulse={next:0,prev:0,req:0,end:0};
    n.sx={p:{url:'',meta:true,gain:1}, audioEl:null,srcNode:null,tapNode:null,sink:null,ctxRef:null,connected:false,connecting:false,
          status:'',icyAbort:null,icyReading:false,icyRaw:null,icyArtist:'',icyTitle:'',icyStatus:'',trackPulse:0}; },
  dispose:n=>{ n.lid++; n.data=null; n.nxt=null; streamStop(n.sx); },
  process(n,I){
    const oL=buf(n,'l'), oR=buf(n,'r');
    const pulse=(k,fn)=>{ const v=typeof I[k]==='number' && I[k]>=.5; if(v && !n.edge[k]) fn(); n.edge[k]=v; };
    pulse('play',()=>waToggle(n)); pulse('next',()=>{ n.pulse.next=2; }); pulse('prev',()=>{ n.pulse.prev=2; }); pulse('stop',()=>waStop(n));
    // дорожка от плейлиста: go 1 — играть, .5 — только загрузить (играть, если уже играет)
    pulse('go',()=>{
      const key=waKey(typeof I.fs==='number'?I.fs:-1,typeof I.url==='string'?I.url:''); if(!key) return;
      const play=I.go>=1 || n.play;
      if(key===n.curKey && (waHas(n) || n.loading)){ if(I.go>=1 && waHas(n) && !n.play) waPlayPause(n,true); return; }
      waLoad(n,{fs:typeof I.fs==='number'?I.fs:-1, url:typeof I.url==='string'?I.url:'', name:typeof I.name==='string'?I.name:''},play); });
    if(n.tr && typeof I.name==='string' && I.name && key0(n,I)) n.tr.name=I.name;
    waPrefetch(n,typeof I.nfs==='number'?I.nfs:-1);
    const more=(typeof I.nfs==='number'&&I.nfs>=0)||(typeof I.nurl==='string'&&I.nurl!=='');
    if(typeof I.vol==='number') setMod(n,'vol',I.vol);
    if(typeof I.bal==='number') setMod(n,'bal',I.bal);
    if(n.mode==='stream' && n.sx.connected && n.sx.ctxRef!==Eng.ctx){ n.sx.status='context recreated'; waStop(n); }
    const d=n.data, st=n.mode==='stream' && n.sx.connected;
    if(typeof I.seek==='number' && I.seek>=0 && I.seek<=1 && Math.abs(I.seek-(n.seekPrev??-1))>1e-6){ waSeek(n,I.seek); n.seekPrev=I.seek; }
    const [bl,br]=wpBalance(n.p.bal), vol=n.p.vol, stp=1/(.015*Eng.sr);
    const ramp=()=>{ const tg=n.play?1:0; return n.run = n.run<tg ? Math.min(tg,n.run+stp) : Math.max(tg,n.run-stp); };   // плавный пуск и остановка без щелчков
    // трек кончился: следующий уже в плейлисте — ждём его (go придёт блоком позже), иначе стоп
    const finish=()=>{ n.pulse.end=2; if(more){ n.waiting=true; } else { n.play=false; n.rewind=true; n.pos=0; } n.dirty=true; };
    if(st){
      const ok=n.play && streamReadBlock(n.sx,oL,oR,1);
      for(let i=0;i<BLOCK;i++){ const g=ramp()*vol; oL[i]=ok?oL[i]*g*bl:0; oR[i]=ok?oR[i]*g*br:0; }
      if(n.sxEnded){ n.sxEnded=false; finish(); }
    }
    else if(!d || n.waiting){ oL.fill(0); oR.fill(0); }
    else {
      const r=n.p.rate*d.sr/Eng.sr, len=d.L.length;
      let ended=false;
      for(let i=0;i<BLOCK;i++){
        const g=ramp()*vol;
        if(n.run<=0 && !n.play){ if(n.rewind){ n.pos=0; n.rewind=false; } oL[i]=0; oR[i]=0; continue; }
        if(n.pos>=len-1){ ended=true; for(;i<BLOCK;i++){ oL[i]=0; oR[i]=0; } break; }
        const i0=n.pos|0, fr=n.pos-i0;
        oL[i]=(d.L[i0]*(1-fr)+d.L[i0+1]*fr)*g*bl; oR[i]=(d.R[i0]*(1-fr)+d.R[i0+1]*fr)*g*br;
        n.pos+=r; }
      if(ended){
        n.pulse.end=2;
        const nk=waKey(typeof I.nfs==='number'?I.nfs:-1,'');
        if(nk && nk===n.curKey){ n.pos=0; }                                              // repeat one: та же дорожка заново
        else if(n.nxt && n.nxt.data && nk==='f:'+n.nxt.fs){ const dd=n.nxt.data, fs=n.nxt.fs; n.nxt=null; waUse(n,{fs,url:'',name:''},dd,true); }   // без паузы
        else finish(); }
    }
    const L=waLen(n);
    const o={l:oL, r:oR, pos:L?waPos(n)/L:0, time:waPos(n), playing:n.play?1:0, end:n.pulse.end>0?1:0, title:waShown(n),
             next:n.pulse.next>0?1:0, prev:n.pulse.prev>0?1:0, req:n.pulse.req>0?1:0};
    for(const k in n.pulse) if(n.pulse[k]>0) n.pulse[k]--;
    return o; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected) waMount(n);
    waRender(n); }
});
// провод name приходит вместе с дорожкой; позже (когда дотянулись теги) только обновляет подпись той же дорожки
function key0(n,I){ return waKey(typeof I.fs==='number'?I.fs:-1,typeof I.url==='string'?I.url:'')===n.curKey; }


/* ---------- 10-band equalizer ---------- */
const EQ_BANDS=WP_BANDS.length;
def({ id:'eq10', title:'Graphic Equalizer (10 bands)', cat:'Audio', resize:true, w:340, h:230,
  kw:'winamp equalizer eq graphic 10 band preamp preset bass treble',
  ins:[{n:'l',t:'sig'},{n:'r',t:'sig'},{n:'on',t:'num'},{n:'preamp',t:'num'}],
  outs:[{n:'l',t:'sig'},{n:'r',t:'sig'}],
  params:[{n:'on',t:'check',d:true,label:'on',hidden:true},
          {n:'preset',t:'select',opts:Object.keys(WP_EQ),d:'Flat',label:'preset',hidden:true,fn:n=>eqApply(n,WP_EQ[n.p.preset])},
          {n:'preamp',t:'range',min:-12,max:12,step:.1,d:0,label:'preamp, dB',hidden:true},
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
    u.on.classList.toggle('on',!!p.on); if(u.ps.value!==p.preset && document.activeElement!==u.ps) u.ps.value=p.preset;
    eqCurve(n); }
});
function eqApply(n,pr){
  if(!pr) return;
  n.p.preamp=pr.pre; pr.g.forEach((g,i)=>{ n.p['b'+i]=g; });
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
  const top=waEl('div','eq-top'), rs=waEl('button','','reset'), on=waEl('button','','ON'), ps=waEl('select');
  for(const k of Object.keys(WP_EQ)) ps.append(new Option(k,k));
  on.title='equalizer on / off'; ps.title='preset';
  on.addEventListener('click',()=>{ n.p.on=!n.p.on; });
  ps.addEventListener('change',()=>{ n.p.preset=ps.value; eqApply(n,WP_EQ[ps.value]); });
  const cv=waEl('canvas','eq-cv'); cv.width=300; cv.height=40;
  top.append(on,ps,rs);
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
  rs.addEventListener('click',()=>{ n.p.preset='Flat'; eqApply(n,WP_EQ.Flat); });
  root.append(top,cv,sl);
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  n.mid.append(root);
  n.ui={root,sl:box,pre,on,ps,cv,cx:cv.getContext('2d'),ck:''};
}
