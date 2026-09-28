/* ============================ ТРЕКЕР: РЕДАКТОР ============================ */
// Полноэкранный, как редактор семплов. Правит n.song на месте — плеер узла слышит правки сразу.
// Отмена — снимки песни; паттерны копируются при первой записи после снимка (copy-on-write),
// данные семплов никогда не меняются на месте, только заменяются новым массивом.
const TRK_PIANO = {                          // ev.code → полутон от базовой октавы (раскладка FT2)
  KeyZ:0,KeyS:1,KeyX:2,KeyD:3,KeyC:4,KeyV:5,KeyG:6,KeyB:7,KeyH:8,KeyN:9,KeyJ:10,KeyM:11,
  Comma:12,KeyL:13,Period:14,Semicolon:15,Slash:16,
  KeyQ:12,Digit2:13,KeyW:14,Digit3:15,KeyE:16,KeyR:17,Digit5:18,KeyT:19,Digit6:20,KeyY:21,Digit7:22,KeyU:23,
  KeyI:24,Digit9:25,KeyO:26,Digit0:27,KeyP:28,BracketLeft:29,Equal:30,BracketRight:31 };
let TrkClip = null;                          // буфер обмена блоков {w,h,cells}
const TRK_FX = {0:'arpeggio',1:'porta up',2:'porta down',3:'tone porta',4:'vibrato',5:'tone porta + vol slide',
  6:'vibrato + vol slide',7:'tremolo',8:'panning',9:'sample offset',10:'volume slide',11:'position jump',
  12:'set volume',13:'pattern break',15:'speed (<20) / tempo',16:'global volume',17:'global volume slide',
  20:'key off at tick',21:'envelope position',25:'panning slide',27:'multi retrigger',29:'tremor',33:'extra fine porta (X1 up, X2 down)'};
const TRK_EFX = {0:'filter',1:'fine porta up',2:'fine porta down',3:'glissando',4:'vibrato waveform',5:'set finetune',
  6:'pattern loop',7:'tremolo waveform',8:'panning',9:'retrigger',10:'fine vol up',11:'fine vol down',12:'note cut',
  13:'note delay',14:'pattern delay',15:'invert loop'};
const TRK_S3FX = {A:'set speed',B:'position jump',C:'pattern break',D:'volume slide (DxF/DFx fine)',E:'porta down (EFx fine, EEx extra)',
  F:'porta up (FFx fine, FEx extra)',G:'tone porta',H:'vibrato',I:'tremor',J:'arpeggio',K:'vibrato + vol slide',L:'tone porta + vol slide',
  O:'sample offset',Q:'retrigger + volume',R:'tremolo',S:'special',T:'tempo (T0x/T1x slide)',U:'fine vibrato',V:'global volume',X:'panning 00..80'};
const TRK_S3SX = {1:'glissando',2:'finetune',3:'vibrato waveform',4:'tremolo waveform',8:'panning',11:'pattern loop',
  12:'note cut',13:'note delay',14:'pattern delay'};
const TRK_VFX = {6:'volume slide down',7:'volume slide up',8:'fine volume down',9:'fine volume up',10:'vibrato speed',
  11:'vibrato',12:'set panning',13:'panning slide left',14:'panning slide right',15:'tone porta'};

// подколонки ячейки: нота, инструмент×2, [громкость×2], эффект, параметр×2; x — позиция в символах
function trkCols(song){
  const v = song.fmt!=='mod', e = v ? 10 : 7;
  const c = [{k:'n',x:0,w:3},{k:'i',h:1,x:4},{k:'i',h:0,x:5}];
  if(v) c.push({k:'v',h:1,x:7},{k:'v',h:0,x:8});
  c.push({k:'e',x:e},{k:'p',h:1,x:e+1},{k:'p',h:0,x:e+2});
  return c;
}
function trkOctRange(song){ return song.fmt==='mod' ? [2,6] : [0,7]; }

function trkOpen(n){
  if(n.T) return n.T;
  const T = { n, song:n.song, pl:n.pl, ord:0, row:0, ch:0, col:0, hs:0, oct:4, step:1, edit:false, follow:true,
              inst:1, smp:0, sel:null, anchor:null, undo:[], redo:[], fresh:new Set(), raf:0, tab:'song',
              msg:'', msgT:0, g:null, sub:null, wheel:0, env:'v', envPt:0 };
  n.T = T;
  trkBuildUI(T);
  trkPanels(T);
  return T;
}
function trkReset(T){
  T.ord = 0; T.row = 0; T.ch = 0; T.col = 0; T.hs = 0; T.sel = null; T.anchor = null;
  T.undo = []; T.redo = []; T.fresh.clear(); T.inst = 1; T.smp = 0; T.envPt = 0;
  const [a,b] = trkOctRange(T.song); T.oct = clamp(T.oct, a, b);
}
function trkClose(T, force){
  if(T.sub && !force) return;
  if(T.sub){ try{ aedClose(T.sub); }catch(e){} T.sub = null; }
  window.removeEventListener('keydown', T.onKey, true);
  T.ro.disconnect();
  cancelAnimationFrame(T.raf); T.raf = 0;
  T.ui.root.remove(); T.ui = null;
  if(T.n.saveT) trkSave(T.n);
  T.n.T = null;
  redraw(T.n);
}

/* ---------- UI ---------- */
function trkBuildUI(T){
  const root = document.createElement('div');
  root.className = 'trk';
  const btn = (a,t,title,cls='')=>`<button class="aed-b ${cls}" data-a="${a}" title="${title}">${t}</button>`;
  const keys = [];
  for(let o=0;o<2;o++) for(let k=0;k<12;k++){
    const nm = MOD_NN[k].replace('-','');
    keys.push(`<button class="trk-pk${[1,3,6,8,10].includes(k)?' blk':''}" data-a="note" data-v="${o*12+k}">${o ? nm.toLowerCase() : nm}</button>`);
  }
  const num = (cls, label, min, max, step=1)=>`<label>${label}<input type="number" class="${cls}" min="${min}" max="${max}" step="${step}"></label>`;
  root.innerHTML = `
    <div class="aed-head">
      ${btn('close','✕','Close (Esc)')}
      <input class="aed-name trk-title" type="text" spellcheck="false" maxlength="28" title="Song title">
      <span class="aed-info trk-info"></span>
      ${btn('open','⭱ open','Open a .mod / .s3m / .xm file')}
      ${btn('savefile','⭳','Download in the song\'s format','aed-pri trk-savefile')}
      <select class="trk-new aed-b" title="New empty song"><option value="">new…</option><option value="mod">new MOD (4 ch)</option><option value="s3m">new S3M (8 ch)</option><option value="xm">new XM (8 ch)</option></select>
      <select class="trk-conv aed-b" title="Convert the song to another format"><option value="">convert…</option><option value="s3m">to S3M</option><option value="xm">to XM</option></select>
      <input class="trk-file" type="file" accept=".mod,.s3m,.xm,.MOD,.S3M,.XM,.nst,.m15,.stk" hidden>
      <input class="trk-sfile" type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff" hidden>
    </div>
    <div class="aed-row trk-tr">
      ${btn('playsong','▶ song','Play song from this position (Space)','aed-play')}
      ${btn('playpat','▶ pat','Loop this pattern from the cursor row (Shift+Space)')}
      ${btn('stop','■','Stop')}
      ${btn('edit','● edit','Edit mode: keys write notes (Enter)')}
      ${btn('follow','⇣ follow','Cursor follows playback')}
      <span class="trk-lab">oct</span>${btn('octdn','−','Octave down (F1…F8 set it)')}<b class="trk-oct"></b>${btn('octup','+','Octave up')}
      <span class="trk-lab">step</span>${btn('stepdn','−','Rows to advance after a note')}<b class="trk-step"></b>${btn('stepup','+','Edit step up')}
      ${btn('undo','↶','Undo (Ctrl+Z)')}${btn('redo','↷','Redo (Ctrl+Shift+Z)')}
      <span class="trk-pos"></span>
    </div>
    <div class="trk-body">
      <div class="trk-main"><canvas class="trk-cv"></canvas></div>
      <div class="trk-side">
        <div class="trk-tabs">
          <button class="trk-tab" data-tab="song">Song</button>
          <button class="trk-tab trk-tab-smp" data-tab="smp">Samples</button>
          <button class="trk-tab" data-tab="keys">Keys</button>
        </div>
        <div class="trk-pane" data-p="song">
          <div class="aed-row">
            ${btn('posins','+ pos','Insert a position after this one')}${btn('posdel','− pos','Delete this position')}
            ${btn('patdn','pat −','Previous pattern number at this position')}${btn('patup','pat +','Next pattern number (a new empty one after the last)')}
          </div>
          <div class="aed-row">
            ${btn('patnew','new pat','Put a new empty pattern at this position')}${btn('patclone','clone','Copy of this pattern as a new one, put here')}
            ${btn('patclear','clear','Clear this pattern')}
          </div>
          <div class="trk-grid">
            ${num('trk-rows','rows in this pattern',1,256)}
            <label>channels<select class="trk-chn"></select></label>
            ${num('trk-speed','initial speed',1,31)}
            ${num('trk-bpm','initial tempo, bpm',32,255)}
            ${num('trk-gvol','global volume',0,64)}
            ${num('trk-restart','restart position',0,255)}
            <label class="trk-chk trk-linear"><input type="checkbox" class="trk-lin"> linear frequencies</label>
          </div>
          <div class="trk-ords"></div>
        </div>
        <div class="trk-pane" data-p="smp">
          <div class="trk-slist"></div>
          <div class="trk-xi">
            <input class="aed-name trk-iname" type="text" spellcheck="false" maxlength="22" placeholder="instrument name">
            <div class="aed-row trk-wrap"><span class="trk-lab">samples</span><span class="trk-xs"></span>${btn('xsadd','+','Add a sample to the instrument')}${btn('xsdel','−','Remove this sample from the instrument')}</div>
            <div class="trk-lab">note map — tap keys to give them this sample</div>
            <canvas class="trk-map"></canvas>
            ${btn('mapall','all notes → this sample','Map every note to the selected sample')}
          </div>
          <div class="trk-sed">
            <input class="aed-name trk-sname" type="text" spellcheck="false" maxlength="28" placeholder="sample name">
            <canvas class="trk-wave"></canvas>
            <div class="trk-grid">
              ${num('trk-svol','volume',0,64)}
              <label class="trk-f-pan">${'panning'}<input type="number" class="trk-span" min="0" max="255"></label>
              <label class="trk-f-ft">finetune<input type="number" class="trk-sft"></label>
              <label class="trk-f-rel">relative note<input type="number" class="trk-srel" min="-96" max="95"></label>
              <label class="trk-f-c2">C-4 rate, Hz<input type="number" class="trk-sc2" min="1000" max="192000"></label>
              <label>loop<select class="trk-sloop"><option value="0">off</option><option value="1">forward</option><option value="2">ping-pong</option></select></label>
              ${num('trk-sls','loop start',0,1e7)}
              ${num('trk-sll','loop length',0,1e7)}
            </div>
            <div class="aed-row trk-wrap">
              ${btn('splay','▶','Play the sample on the cursor channel')}
              ${btn('sload','load','Load an audio file into this slot')}
              ${btn('sedit','✎ edit','Open in the sample editor')}
              ${btn('swav','⭳ wav','Download as WAV')}
              ${btn('sclear','clear','Empty this slot')}
              <span class="trk-sinfo"></span>
            </div>
          </div>
          <div class="trk-xe">
            <div class="aed-row trk-wrap">
              <button class="aed-b trk-envt" data-a="envv">volume env</button><button class="aed-b trk-envt" data-a="envp">panning env</button>
              ${btn('envon','on','Envelope on/off')}${btn('envsus','sus','Sustain at the selected point')}
              ${btn('envls','loop ⟦','Loop start at the selected point')}${btn('envle','⟧','Loop end at the selected point')}
              ${btn('envdel','del pt','Delete the selected point')}
            </div>
            <canvas class="trk-env"></canvas>
            <div class="trk-grid">
              ${num('trk-fade','fadeout',0,4095)}
              <label>auto-vibrato<select class="trk-avt"><option value="0">sine</option><option value="1">square</option><option value="2">ramp down</option><option value="3">ramp up</option></select></label>
              ${num('trk-avs','vib sweep',0,255)}${num('trk-avd','vib depth',0,15)}${num('trk-avr','vib rate',0,63)}
            </div>
          </div>
        </div>
        <div class="trk-pane" data-p="keys">
          <div class="trk-piano">${keys.join('')}</div>
          <div class="trk-hex">${[...'0123456789ABCDEF'].map((h,i)=>`<button class="trk-k" data-a="hex" data-v="${i}">${h}</button>`).join('')}</div>
          <div class="trk-hex trk-letters">${[...'GHIJKLMNOPQRSTUVWXYZ'].map(h=>`<button class="trk-k" data-a="hex" data-v="${h.charCodeAt(0)-55}">${h}</button>`).join('')}</div>
          <div class="trk-kb">
            <button class="trk-k" data-a="up">↑</button><button class="trk-k" data-a="down">↓</button>
            <button class="trk-k" data-a="left">←</button><button class="trk-k" data-a="right">→</button>
            <button class="trk-k" data-a="tab">ch ⇥</button><button class="trk-k" data-a="del">del</button>
            <button class="trk-k trk-offk" data-a="noteoff">off</button><button class="trk-k" data-a="ins">ins row</button>
            <button class="trk-k" data-a="bksp">del row</button><button class="trk-k" data-a="mark">mark</button>
            <button class="trk-k" data-a="copy">copy</button><button class="trk-k" data-a="cut">cut</button>
            <button class="trk-k" data-a="paste">paste</button><button class="trk-k" data-a="tdn">−1</button>
            <button class="trk-k" data-a="tup">+1</button><button class="trk-k" data-a="tup12">+12</button>
          </div>
        </div>
      </div>
    </div>
    <div class="aed-stat"><span class="trk-msg"></span><span class="trk-hint"></span></div>`;
  document.body.append(root);
  const q = s=>root.querySelector(s);
  T.ui = { root, cv:q('.trk-cv'), main:q('.trk-main'), title:q('.trk-title'), info:q('.trk-info'), pos:q('.trk-pos'),
    oct:q('.trk-oct'), step:q('.trk-step'), msg:q('.trk-msg'), hint:q('.trk-hint'), ords:q('.trk-ords'),
    rows:q('.trk-rows'), chn:q('.trk-chn'), speed:q('.trk-speed'), bpm:q('.trk-bpm'), gvol:q('.trk-gvol'), restart:q('.trk-restart'), lin:q('.trk-lin'),
    slist:q('.trk-slist'), xi:q('.trk-xi'), iname:q('.trk-iname'), xs:q('.trk-xs'), map:q('.trk-map'),
    sname:q('.trk-sname'), wave:q('.trk-wave'), svol:q('.trk-svol'), span:q('.trk-span'), sft:q('.trk-sft'), srel:q('.trk-srel'),
    sc2:q('.trk-sc2'), sloop:q('.trk-sloop'), sls:q('.trk-sls'), sll:q('.trk-sll'), sinfo:q('.trk-sinfo'),
    xe:q('.trk-xe'), env:q('.trk-env'), fade:q('.trk-fade'), avt:q('.trk-avt'), avs:q('.trk-avs'), avd:q('.trk-avd'), avr:q('.trk-avr'),
    file:q('.trk-file'), sfile:q('.trk-sfile'), nw:q('.trk-new'), conv:q('.trk-conv') };
  const U = T.ui;
  // кнопки не забирают фокус — иначе пробел/стрелки уходят в кнопку, а не в редактор
  root.addEventListener('pointerdown', ev=>{ if(ev.target.closest('button')) ev.preventDefault(); });
  root.addEventListener('click', ev=>{
    const tb = ev.target.closest('.trk-tab');
    if(tb){ T.tab = tb.dataset.tab; trkPanels(T); return; }
    const b = ev.target.closest('[data-a]');
    if(b) trkAction(T, b.dataset.a, b.dataset.v!=null ? +b.dataset.v : undefined);
  });
  const S = ()=>T.song;
  U.title.addEventListener('input', ()=>trkChange(T, ()=>{ S().title = U.title.value; }, 'title'));
  const songNum = (el, fn)=>el.addEventListener('change', ()=>{ trkChange(T, ()=>fn(+el.value|0)); trkPanels(T); });
  songNum(U.speed, v=>{ S().speed = clamp(v,1,31); });
  songNum(U.bpm, v=>{ S().bpm = clamp(v,32,255); });
  songNum(U.gvol, v=>{ S().gvol = clamp(v,0,64); });
  songNum(U.restart, v=>{ S().restart = clamp(v,0,255); });
  songNum(U.rows, v=>trkSetRows(T, clamp(v,1,256)));
  U.lin.addEventListener('change', ()=>{ trkChange(T, ()=>{ S().linear = U.lin.checked; }); });
  U.chn.addEventListener('change', ()=>trkSetChannels(T, +U.chn.value));
  U.nw.addEventListener('change', ()=>{ const f = U.nw.value; U.nw.value = ''; if(f) trkNewSongUI(T, f); });
  U.conv.addEventListener('change', ()=>{ const f = U.conv.value; U.conv.value = ''; if(f) trkConvertUI(T, f); });
  U.file.addEventListener('change', ()=>{ const f=U.file.files[0]; U.file.value=''; if(f) trkLoadFile(T.n, f); });
  U.sfile.addEventListener('change', ()=>{ const f=U.sfile.files[0]; U.sfile.value=''; if(f) trkImportSample(T, f); });
  const smpField = (el, fn)=>el.addEventListener('change', ()=>{ const s=trkCurSmp(T); if(!s) return; trkChange(T, ()=>{ fn(s, +el.value); trkFixLoop(s); }); trkPanels(T); });
  U.sname.addEventListener('input', ()=>{ const s=trkCurSmp(T); if(!s) return; trkChange(T, ()=>{ s.name = U.sname.value; }, 'sname'+T.inst+':'+T.smp); trkSampleList(T); });
  smpField(U.svol, (s,v)=>{ s.vol = clamp(v|0,0,64); });
  smpField(U.span, (s,v)=>{ s.pan = clamp(v|0,0,255); });
  smpField(U.sft, (s,v)=>{ s.ft = T.song.fmt==='mod' ? clamp(v|0,-8,7) : clamp(v|0,-128,127); });
  smpField(U.srel, (s,v)=>{ s.rel = clamp(v|0,-96,95); });
  smpField(U.sc2, (s,v)=>{ s.c2spd = clamp(v|0,1000,192000); });
  smpField(U.sloop, (s,v)=>{ s.loop = v; if(v && s.ll<2){ s.ls = 0; s.ll = s.data.length; } });
  smpField(U.sls, (s,v)=>{ const end = s.ls+s.ll; s.ls = clamp(v|0,0,Math.max(0,s.data.length-2)); s.ll = Math.max(2, end-s.ls); if(!s.loop) s.loop = 1; });
  smpField(U.sll, (s,v)=>{ s.ll = clamp(v|0,0,s.data.length-s.ls); if(!s.loop && s.ll>=2) s.loop = 1; });
  U.iname.addEventListener('input', ()=>{ const i=trkCurIns(T); if(!i) return; trkChange(T, ()=>{ i.name = U.iname.value; }, 'iname'+T.inst); trkSampleList(T); });
  const insNum = (el, fn)=>el.addEventListener('change', ()=>{ const i=trkCurIns(T); if(!i) return; trkChange(T, ()=>fn(i, +el.value|0)); trkPanels(T); });
  insNum(U.fade, (i,v)=>{ i.fade = clamp(v,0,4095); });
  insNum(U.avt, (i,v)=>{ i.vib.type = clamp(v,0,3); });
  insNum(U.avs, (i,v)=>{ i.vib.sweep = clamp(v,0,255); });
  insNum(U.avd, (i,v)=>{ i.vib.depth = clamp(v,0,15); });
  insNum(U.avr, (i,v)=>{ i.vib.rate = clamp(v,0,63); });
  root.addEventListener('dragover', ev=>ev.preventDefault());
  root.addEventListener('drop', ev=>{
    ev.preventDefault();
    const f = ev.dataTransfer.files?.[0]; if(!f) return;
    if(/\.(mod|s3m|xm|nst|m15|stk)$/i.test(f.name)) trkLoadFile(T.n, f);
    else trkImportSample(T, f);
  });
  T.onKey = ev=>trkKey(T, ev);
  window.addEventListener('keydown', T.onKey, true);
  T.ro = new ResizeObserver(()=>{ trkDraw(T); trkWave(T); trkMap(T); trkEnv(T); });
  for(const el of [U.main, U.wave, U.map, U.env]) T.ro.observe(el);
  trkBindPattern(T);
  trkBindWave(T);
  trkBindMap(T);
  trkBindEnv(T);
}
function trkCurIns(T){ return T.song.instruments ? T.song.instruments[T.inst-1] : null; }
function trkCurSmp(T){
  const s = T.song;
  if(s.instruments){ const i = s.instruments[T.inst-1]; return i ? i.samples[clamp(T.smp,0,i.samples.length-1)] : null; }
  return s.samples[T.inst-1] || null;
}
function trkInsCount(song){ return song.instruments ? song.instruments.length : song.samples.length; }
function trkMsg(T, m){ T.msg = m; T.msgT = performance.now(); trkDraw(T); setTimeout(()=>trkDraw(T), 3100); }

// Панели справа: заполнить из песни
function trkPanels(T){
  const U = T.ui; if(!U) return;
  const s = T.song, xm = s.fmt==='xm', mod = s.fmt==='mod';
  T.inst = clamp(T.inst, 1, Math.max(1, trkInsCount(s)));
  T.ord = clamp(T.ord, 0, s.orders.length-1);
  U.root.querySelectorAll('.trk-tab').forEach(b=>b.classList.toggle('on', b.dataset.tab===T.tab));
  U.root.querySelectorAll('.trk-pane').forEach(p=>p.classList.toggle('on', p.dataset.p===T.tab));
  U.root.querySelector('.trk-tab-smp').textContent = xm ? 'Instruments' : 'Samples';
  U.root.querySelector('.trk-savefile').textContent = '⭳ '+TRK_EXT[s.fmt];
  U.conv.hidden = xm;
  U.conv.querySelector('[value=s3m]').hidden = s.fmt!=='mod';
  U.root.querySelector('.trk-letters').hidden = mod;
  U.root.querySelector('.trk-offk').hidden = mod;
  if(document.activeElement!==U.title) U.title.value = s.title;
  const pat = s.patterns[s.orders[T.ord]];
  U.rows.value = pat ? pat.rows : 64; U.rows.parentElement.hidden = !xm;
  const chOpts = mod ? [1,2,3,4,5,6,7,8,10,12,16,24,32] : xm ? [2,4,6,8,10,12,16,20,24,32] : [1,2,4,6,8,10,12,16,20,24,32];
  if(!chOpts.includes(s.ch)) chOpts.push(s.ch);
  U.chn.innerHTML = chOpts.sort((a,b)=>a-b).map(v=>`<option${v===s.ch?' selected':''}>${v}</option>`).join('');
  U.speed.value = s.speed; U.bpm.value = s.bpm; U.gvol.value = s.gvol; U.restart.value = s.restart;
  for(const el of [U.speed, U.bpm, U.gvol]) el.parentElement.hidden = mod;
  U.lin.checked = !!s.linear; U.lin.parentElement.hidden = !xm;
  trkOrders(T);
  trkSampleList(T);
  trkSampleEd(T);
  trkDraw(T, true);
}
function trkOrders(T){
  const s = T.song, box = T.ui.ords, playing = T.pl.playing ? trkShown(T.n).ord : -1;
  let h = '';
  s.orders.forEach((p,i)=>{
    h += `<div class="trk-ord${i===T.ord?' on':''}${i===playing?' pl':''}" data-o="${i}"><span>${modHex(i,2)}</span><b>${modHex(p,2)}</b></div>`;
  });
  box.innerHTML = h;
  if(!box._wired){
    box._wired = true;
    box.addEventListener('click', ev=>{
      const e = ev.target.closest('[data-o]'); if(!e) return;
      T.ord = +e.dataset.o; T.follow = T.follow && !T.pl.playing; T.row = Math.min(T.row, trkRows(T)-1); trkPanels(T);
    });
  }
  box.querySelector('.on')?.scrollIntoView({block:'nearest'});
}
function trkSampleList(T){
  const box = T.ui.slist, s = T.song;
  let h = '';
  const list = s.instruments || s.samples;
  list.forEach((x,i)=>{
    const len = s.instruments ? x.samples.reduce((a,y)=>a+y.data.length,0) : x.data.length;
    h += `<div class="trk-si${i+1===T.inst?' on':''}${len?'':' empty'}" data-i="${i+1}"><span>${trkInstName(s,i+1)}</span>`+
         `<span class="trk-sn">${escapeHtml(x.name||'')}</span><span>${len||''}</span></div>`;
  });
  if(s.instruments || s.fmt==='s3m') h += `<div class="trk-si trk-add" data-i="add">＋ ${s.instruments?'instrument':'sample'}</div>`;
  box.innerHTML = h;
  if(!box._wired){
    box._wired = true;
    box.addEventListener('click', ev=>{
      const e = ev.target.closest('[data-i]'); if(!e) return;
      if(e.dataset.i==='add'){ trkAddIns(T); return; }
      T.inst = +e.dataset.i; T.smp = 0; T.envPt = 0; trkSampleList(T); trkSampleEd(T); trkDraw(T);
    });
  }
  box.querySelector('.on')?.scrollIntoView({block:'nearest'});
}
function trkSampleEd(T){
  const U = T.ui, song = T.song, s = trkCurSmp(T), xm = song.fmt==='xm', ins = trkCurIns(T);
  U.xi.hidden = !xm; U.xe.hidden = !xm;
  U.root.querySelector('.trk-f-pan').hidden = !xm;
  U.root.querySelector('.trk-f-rel').hidden = !xm;
  U.root.querySelector('.trk-f-ft').hidden = song.fmt==='s3m';
  U.root.querySelector('.trk-f-c2').hidden = song.fmt!=='s3m';
  U.sloop.querySelector('[value="2"]').hidden = !xm;
  if(ins){
    if(document.activeElement!==U.iname) U.iname.value = ins.name;
    U.xs.innerHTML = ins.samples.map((x,i)=>`<button class="aed-b${i===T.smp?' on':''}" data-a="xsel" data-v="${i}" title="${escapeHtml(x.name)}">${i}</button>`).join('');
    U.fade.value = ins.fade; U.avt.value = ins.vib.type; U.avs.value = ins.vib.sweep; U.avd.value = ins.vib.depth; U.avr.value = ins.vib.rate;
    const e = T.env==='v' ? ins.venv : ins.penv;
    U.root.querySelectorAll('.trk-envt').forEach(b=>b.classList.toggle('on', b.dataset.a==='env'+T.env));
    U.root.querySelector('[data-a=envon]').classList.toggle('on', e.on);
    U.root.querySelector('[data-a=envsus]').classList.toggle('on', e.sus);
    U.root.querySelector('[data-a=envls]').classList.toggle('on', e.loop);
    trkMap(T); trkEnv(T);
  }
  if(!s) return;
  if(document.activeElement!==U.sname) U.sname.value = s.name;
  U.svol.value = s.vol; U.span.value = s.pan<0 ? 128 : s.pan; U.sft.value = s.ft; U.srel.value = s.rel; U.sc2.value = s.c2spd;
  U.sft.min = song.fmt==='mod' ? -8 : -128; U.sft.max = song.fmt==='mod' ? 7 : 127;
  U.sloop.value = s.loop; U.sls.value = s.ls; U.sll.value = s.ll;
  const rate = trkSmpRate(song, s), bits = s.data instanceof Int16Array ? 16 : 8;
  U.sinfo.textContent = s.data.length+' samples, '+bits+' bit' + (s.data.length ? ' · '+(s.data.length/rate).toFixed(2)+' s at '+trkNoteName(song, 49+(song.fmt==='mod'?12:0)) : '');
  trkWave(T);
}
function trkSmpRate(song, s){                   // частота воспроизведения семпла на C-4 (MOD — на C-3 PT)
  if(song.fmt==='mod') return TRK_CLK.mod/(MOD_PER[(s.ft&15)*MOD_NOTES+36]*4);
  if(song.fmt==='s3m') return s.c2spd||8363;
  return 8363*Math.pow(2, (s.rel+s.ft/128)/12);
}

/* ---------- правки ---------- */
function trkChange(T, fn, merge){
  const now = performance.now();
  if(!(merge && T.lastMerge===merge && now-T.lastMergeT<1500)){
    T.undo.push(trkCloneSong(T.song, true)); if(T.undo.length>300) T.undo.shift();
    T.fresh.clear();
  }
  T.lastMerge = merge; T.lastMergeT = now;
  T.redo.length = 0;
  fn();
  T.song.rev++;
  modPlayerChannels(T.pl);
  trkSaveSoon(T.n);
  trkDraw(T);
  redraw(T.n);
}
function trkUndo(T, redo){
  const from = redo ? T.redo : T.undo, to = redo ? T.undo : T.redo;
  if(!from.length) return;
  to.push(trkCloneSong(T.song, true));
  const sn = from.pop(), fmt = T.song.fmt;
  modAssign(T.song, trkCloneSong(sn, true));
  T.fresh.clear(); T.lastMerge = null;
  if(fmt!==T.song.fmt) trkStopPlay(T.n);
  modPlayerChannels(T.pl);
  trkSaveSoon(T.n);
  trkPanels(T);
}
function trkPatIdx(T){ return T.song.orders[T.ord]; }
function trkRows(T){ return T.song.patterns[trkPatIdx(T)]?.rows || 64; }
function trkPatW(T, idx=trkPatIdx(T)){         // паттерн для записи: копия при первой записи после снимка
  const s = T.song;
  while(s.patterns.length<=idx) s.patterns.push(trkNewPattern(64, s.ch));
  if(!T.fresh.has(idx)){ const p = s.patterns[idx]; s.patterns[idx] = {rows:p.rows, d:p.d.slice()}; T.fresh.add(idx); }
  return s.patterns[idx].d;
}
function trkCell(T, r=T.row, c=T.ch){ return (r*T.song.ch+c)*5; }
function trkSelRect(T){
  if(!T.sel) return {c0:T.ch, c1:T.ch, r0:T.row, r1:T.row};
  const a = T.sel, R = trkRows(T)-1;
  return {c0:Math.min(a.c0,a.c1), c1:Math.max(a.c0,a.c1), r0:clamp(Math.min(a.r0,a.r1),0,R), r1:clamp(Math.max(a.r0,a.r1),0,R)};
}
function trkMove(T, dr, dc, extend){
  const s = T.song, R = trkRows(T), nc = trkCols(s).length;
  if(extend){ if(!T.sel) T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
  else if(!T.anchor) T.sel = null;
  if(dr) T.row = ((T.row+dr)%R+R)%R;
  if(dc){
    let k = T.ch*nc+T.col+dc, tot = s.ch*nc;
    k = ((k%tot)+tot)%tot; T.ch = Math.floor(k/nc); T.col = k%nc;
  }
  if(T.sel && (extend || T.anchor)){ T.sel.c1 = T.ch; T.sel.r1 = T.row; }
  trkDraw(T);
}
function trkNote(T, semi){
  const s = T.song, [a,b] = trkOctRange(s);
  const note = clamp(T.oct*12+semi, a*12, b*12+11);
  modPreview(T.pl, T.ch, note, T.inst);
  trkEnsureEngine();
  if(!T.edit){ trkDraw(T); return; }
  trkChange(T, ()=>{ const d = trkPatW(T), o = trkCell(T); d[o] = note+1; d[o+1] = T.inst; });
  trkMove(T, T.step, 0);
}
function trkNoteOff(T){
  const s = T.song; if(s.fmt==='mod' || !T.edit) return;
  trkChange(T, ()=>{ const d = trkPatW(T), o = trkCell(T); d[o] = s.fmt==='xm' ? TRK_OFF : TRK_CUT; d[o+1] = 0; });
  trkMove(T, T.step, 0);
}
// цифра/буква v (0..35) в текущую подколонку
function trkHex(T, v){
  const s = T.song, cols = trkCols(s), col = cols[T.col];
  if(!T.edit || col.k==='n') return;
  const dec = s.fmt==='s3m';
  if(col.k!=='e' && v>15) return;
  if(col.k==='e'){
    if(s.fmt==='mod' && v>15) return;
    if(s.fmt==='s3m' && v<10) return;
  }
  if(dec && (col.k==='i' || col.k==='v') && v>9) return;
  trkChange(T, ()=>{
    const d = trkPatW(T), o = trkCell(T);
    if(col.k==='i'){
      if(dec){ const cur = d[o+1]; d[o+1] = Math.min(99, col.h ? v*10+cur%10 : Math.floor(cur/10)*10+v); }
      else { const cur = d[o+1]; d[o+1] = Math.min(s.fmt==='xm'?128:31, col.h ? (v<<4)|(cur&15) : (cur&0xF0)|v); }
    } else if(col.k==='v'){
      const cur = d[o+2], isVol = cur>=0x10 && cur<=0x50, val = isVol ? cur-0x10 : 0;
      if(dec){ const nv = Math.min(64, col.h ? v*10+val%10 : Math.floor(val/10)*10+v); d[o+2] = 0x10+nv; }
      else if(col.h){ d[o+2] = v<=4 ? 0x10+Math.min(64,(v<<4)|(val&15)) : v>=6 ? (v<<4)|(isVol?0:cur&15) : cur; }
      else d[o+2] = isVol || !cur ? 0x10+Math.min(64,(val&0xF0)|v) : (cur&0xF0)|v;
    } else if(col.k==='e') d[o+3] = s.fmt==='s3m' ? 100+v-9 : v;
    else if(col.h) d[o+4] = (v<<4)|(d[o+4]&15);
    else d[o+4] = (d[o+4]&0xF0)|v;
  });
  // внутри поля — вправо, после последней цифры поля — вниз на шаг и к началу поля
  const next = cols[T.col+1];
  if(next && next.k===col.k || col.k==='e') T.col++;
  else { T.col = cols.findIndex(c=>c.k===col.k); trkMove(T, T.step, 0); }
  trkDraw(T);
}
function trkClearSel(T){
  const r = trkSelRect(T), whole = !!T.sel, col = trkCols(T.song)[T.col];
  trkChange(T, ()=>{
    const d = trkPatW(T);
    for(let row=r.r0;row<=r.r1;row++) for(let c=r.c0;c<=r.c1;c++){
      const o = trkCell(T,row,c);
      if(whole) d.fill(0,o,o+5);
      else if(col.k==='n' || col.k==='i'){ d[o] = 0; d[o+1] = 0; }
      else if(col.k==='v') d[o+2] = 0;
      else { d[o+3] = 0; d[o+4] = 0; }
    }
  });
  if(!whole) trkMove(T, T.step, 0);
}
function trkShiftRows(T, ins){                // вставка/удаление строки в канале (или в выделенных каналах)
  const r = trkSelRect(T), R = trkRows(T);
  trkChange(T, ()=>{
    const d = trkPatW(T);
    for(let c=r.c0;c<=r.c1;c++){
      if(ins) for(let row=R-1;row>T.row;row--) d.copyWithin(trkCell(T,row,c), trkCell(T,row-1,c), trkCell(T,row-1,c)+5);
      else for(let row=T.row;row<R-1;row++) d.copyWithin(trkCell(T,row,c), trkCell(T,row+1,c), trkCell(T,row+1,c)+5);
      const z = trkCell(T, ins?T.row:R-1, c); d.fill(0, z, z+5);
    }
  });
}
function trkCopy(T, cut){
  const r = trkSelRect(T), w = r.c1-r.c0+1, h = r.r1-r.r0+1, d = T.song.patterns[trkPatIdx(T)].d;
  const cells = new Uint8Array(w*h*5);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const o=trkCell(T,r.r0+y,r.c0+x); cells.set(d.subarray(o,o+5),(y*w+x)*5); }
  TrkClip = {w, h, cells, fmt:T.song.fmt};
  if(cut){ const had = T.sel; T.sel = {c0:r.c0,c1:r.c1,r0:r.r0,r1:r.r1}; trkClearSel(T); T.sel = had; }
  trkMsg(T, (cut?'cut ':'copied ')+w+'×'+h);
}
function trkPaste(T){
  if(!TrkClip) return;
  if(TrkClip.fmt!==T.song.fmt){ trkMsg(T, 'the clipboard holds '+TrkClip.fmt.toUpperCase()+' cells'); return; }
  const {w,h,cells} = TrkClip, R = trkRows(T);
  trkChange(T, ()=>{
    const d = trkPatW(T);
    for(let y=0;y<h && T.row+y<R;y++) for(let x=0;x<w && T.ch+x<T.song.ch;x++)
      d.set(cells.subarray((y*w+x)*5,(y*w+x)*5+5), trkCell(T,T.row+y,T.ch+x));
  });
}
function trkTranspose(T, k){
  const r = trkSelRect(T), [a,b] = trkOctRange(T.song);
  trkChange(T, ()=>{
    const d = trkPatW(T);
    for(let row=r.r0;row<=r.r1;row++) for(let c=r.c0;c<=r.c1;c++){
      const o = trkCell(T,row,c); if(d[o]>0 && d[o]<=120) d[o] = clamp(d[o]+k, a*12+1, b*12+12);
    }
  });
}
function trkSetChannels(T, nc){
  const s = T.song; if(nc===s.ch) return;
  trkChange(T, ()=>{
    const oc = s.ch;
    s.patterns = s.patterns.map(p=>{
      const q = trkNewPattern(p.rows, nc);
      for(let r=0;r<p.rows;r++) for(let c=0;c<Math.min(oc,nc);c++) q.d.set(p.d.subarray((r*oc+c)*5,(r*oc+c)*5+5),(r*nc+c)*5);
      return q;
    });
    s.ch = nc;
    const pans = s.chPan.slice(0,nc); trkDefaultPan(s); pans.forEach((v,k)=>{ s.chPan[k] = v; });
    T.fresh = new Set(s.patterns.map((_,i)=>i));
  });
  modPlayerChannels(T.pl);
  T.pl.chn.forEach((c,k)=>{ c.pan = s.chPan[k]; });
  T.ch = Math.min(T.ch, nc-1); T.sel = null;
  trkPanels(T);
}
function trkSetRows(T, rows){
  const idx = trkPatIdx(T), p = T.song.patterns[idx]; if(!p || p.rows===rows) return;
  const ch = T.song.ch, q = trkNewPattern(rows, ch);
  q.d.set(p.d.subarray(0, Math.min(p.d.length, q.d.length)));
  T.song.patterns[idx] = q; T.fresh.add(idx);
  T.row = Math.min(T.row, rows-1);
}
function trkSelectAll(T){
  const s = T.sel, R = trkRows(T)-1;
  if(s && s.c0===T.ch && s.c1===T.ch && Math.min(s.r0,s.r1)===0 && Math.max(s.r0,s.r1)===R) T.sel = {c0:0,c1:T.song.ch-1,r0:0,r1:R};
  else T.sel = {c0:T.ch,c1:T.ch,r0:0,r1:R};
  trkDraw(T);
}
function trkNewSongUI(T, fmt){
  if(!confirm('Start a new empty '+fmt.toUpperCase()+' song? (Undo brings the old one back)')) return;
  trkStopPlay(T.n);
  trkChange(T, ()=>{ modAssign(T.song, trkNewSong(fmt)); });
  const u = T.undo; trkReset(T); T.undo = u;
  trkSync(T.n);
}
function trkConvertUI(T, fmt){
  trkStopPlay(T.n);
  trkChange(T, ()=>{ modAssign(T.song, trkConvert(T.song, fmt)); });
  T.fresh.clear(); T.sel = null; T.inst = 1; T.smp = 0;
  trkMsg(T, 'converted to '+fmt.toUpperCase()+' — check the effects, not all of them map one to one');
  trkSync(T.n);
}
function trkAddIns(T){
  const s = T.song;
  if(s.instruments){ if(s.instruments.length>=128) return; trkChange(T, ()=>{ s.instruments.push(trkEmptyInstrument()); }); T.inst = s.instruments.length; }
  else { if(s.samples.length>=99) return; trkChange(T, ()=>{ s.samples.push(trkEmptySample()); }); T.inst = s.samples.length; }
  T.smp = 0; trkPanels(T);
}

function trkAction(T, a, v){
  const s = T.song, pl = T.pl, n = T.n, ins = trkCurIns(T);
  switch(a){
    case 'close': return trkClose(T);
    case 'open': T.ui.file.click(); return;
    case 'savefile': {
      trkSave(n);
      dl(new Blob([trkWrite(s)],{type:'application/octet-stream'}), (s.title||'untitled').replace(/[\\/:*?"<>|]/g,'_').trim()+TRK_EXT[s.fmt]);
      return;
    }
    case 'playsong': if(pl.playing) trkStopPlay(n); else trkPlay(n, 'song', T.ord, 0); T.follow = true; break;
    case 'playpat': trkPlay(n, 'pattern', T.ord, T.row); T.follow = true; break;
    case 'stop': trkStopPlay(n); break;
    case 'edit': T.edit = !T.edit; break;
    case 'follow': T.follow = !T.follow; break;
    case 'octdn': T.oct = Math.max(trkOctRange(s)[0], T.oct-1); break;
    case 'octup': T.oct = Math.min(trkOctRange(s)[1], T.oct+1); break;
    case 'stepdn': T.step = Math.max(0, T.step-1); break;
    case 'stepup': T.step = Math.min(16, T.step+1); break;
    case 'undo': return trkUndo(T, false);
    case 'redo': return trkUndo(T, true);
    case 'posins': trkChange(T, ()=>{ if(s.orders.length<256) s.orders.splice(T.ord+1, 0, s.orders[T.ord]); }); T.ord = Math.min(T.ord+1, s.orders.length-1); trkPanels(T); return;
    case 'posdel': if(s.orders.length>1){ trkChange(T, ()=>{ s.orders.splice(T.ord,1); }); T.ord = Math.min(T.ord, s.orders.length-1); trkPanels(T); } return;
    case 'patdn': trkChange(T, ()=>{ s.orders[T.ord] = Math.max(0, s.orders[T.ord]-1); }); trkPanels(T); return;
    case 'patup': trkChange(T, ()=>{ const p = Math.min(s.fmt==='xm'?255:99, s.orders[T.ord]+1); trkPatW(T, p); s.orders[T.ord] = p; }); trkPanels(T); return;
    case 'patnew': trkChange(T, ()=>{ const i = s.patterns.length; if(i>=(s.fmt==='xm'?256:100)) return; s.patterns.push(trkNewPattern(trkRows(T), s.ch)); T.fresh.add(i); s.orders[T.ord] = i; }); trkPanels(T); return;
    case 'patclone': trkChange(T, ()=>{ const i = s.patterns.length; if(i>=(s.fmt==='xm'?256:100)) return; const p = s.patterns[trkPatIdx(T)]; s.patterns.push({rows:p.rows, d:p.d.slice()}); T.fresh.add(i); s.orders[T.ord] = i; }); trkPanels(T); return;
    case 'patclear': trkChange(T, ()=>{ trkPatW(T).fill(0); }); break;
    case 'note': trkNote(T, v); return;
    case 'noteoff': trkNoteOff(T); return;
    case 'hex': trkHex(T, v); return;
    case 'up': trkMove(T, -1, 0); return;
    case 'down': trkMove(T, 1, 0); return;
    case 'left': trkMove(T, 0, -1); return;
    case 'right': trkMove(T, 0, 1); return;
    case 'tab': T.ch = (T.ch+1)%s.ch; T.col = 0; break;
    case 'del': trkClearSel(T); return;
    case 'ins': trkShiftRows(T, true); return;
    case 'bksp': trkShiftRows(T, false); return;
    case 'mark':
      if(T.anchor) T.anchor = null;
      else { T.anchor = true; T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
      break;
    case 'copy': trkCopy(T, false); T.anchor = null; return;
    case 'cut': trkCopy(T, true); T.anchor = null; T.sel = null; return;
    case 'paste': trkPaste(T); return;
    case 'tup': trkTranspose(T, 1); return;
    case 'tdn': trkTranspose(T, -1); return;
    case 'tup12': trkTranspose(T, 12); return;
    case 'tdn12': trkTranspose(T, -12); return;
    case 'splay': {                           // C-4 (MOD — C-3), сам выбранный семпл, даже если карта нот его не выдаёт
      const sm = trkCurSmp(T); if(!sm || !sm.data.length) return; trkEnsureEngine();
      const c = pl.chn[T.ch], note = s.fmt==='mod' ? 60 : 48;
      Object.assign(c, {inst:T.inst, ins, smp:sm, vol:sm.vol, outVol:sm.vol, note, ft:sm.ft, eff:0, prm:0, vcmd:0, delay:null});
      if(sm.pan>=0 && ins) c.pan = sm.pan;
      c.per = c.outPer = trkPer(s, note, sm, sm.ft);
      trkTrigger(pl, c);
      return; }
    case 'sload': T.ui.sfile.click(); return;
    case 'sedit': trkEditSample(T); return;
    case 'swav': {
      const sm = trkCurSmp(T); if(!sm || !sm.data.length) return;
      dl(aedWavBlob(Float32Array.from(modSmpF(sm)), Math.round(trkSmpRate(s, sm))), (sm.name||'sample'+T.inst).replace(/[\\/:*?"<>|]/g,'_').trim()+'.wav');
      return;
    }
    case 'sclear': {
      const sm = trkCurSmp(T); if(!sm) return;
      trkChange(T, ()=>{ Object.assign(sm, trkEmptySample(), s.instruments ? {pan:128} : {}); });
      trkPanels(T); return;
    }
    case 'xsel': T.smp = v; trkSampleEd(T); return;
    case 'xsadd': if(ins && ins.samples.length<16){ trkChange(T, ()=>{ const e = trkEmptySample(); e.pan = 128; ins.samples.push(e); }); T.smp = ins.samples.length-1; trkPanels(T); } return;
    case 'xsdel': if(ins && ins.samples.length>1){
      const k = T.smp;
      trkChange(T, ()=>{ ins.samples.splice(k,1); for(let i=0;i<96;i++){ if(ins.map[i]===k) ins.map[i] = 0; else if(ins.map[i]>k) ins.map[i]--; } });
      T.smp = Math.max(0, k-1); trkPanels(T); } return;
    case 'mapall': if(ins){ trkChange(T, ()=>{ ins.map.fill(T.smp); }); trkMap(T); } return;
    case 'envv': T.env = 'v'; T.envPt = 0; trkSampleEd(T); return;
    case 'envp': T.env = 'p'; T.envPt = 0; trkSampleEd(T); return;
    case 'envon': case 'envsus': case 'envls': case 'envle': case 'envdel': {
      if(!ins) return;
      const e = T.env==='v' ? ins.venv : ins.penv, k = clamp(T.envPt, 0, e.pts.length-1);
      trkChange(T, ()=>{
        if(a==='envon') e.on = !e.on;
        else if(a==='envsus'){ if(e.sus && e.s===k) e.sus = false; else { e.sus = true; e.s = k; } }
        else if(a==='envls'){ if(e.loop && e.ls===k) e.loop = false; else { e.loop = true; e.ls = k; if(e.le<k) e.le = k; } }
        else if(a==='envle'){ e.loop = true; e.le = k; if(e.ls>k) e.ls = k; }
        else if(e.pts.length>2 && k>0){ e.pts.splice(k,1); for(const f of ['s','ls','le']) if(e[f]>=k) e[f] = Math.max(0, e[f]-1); T.envPt = k-1; }
      });
      trkSampleEd(T); return;
    }
  }
  trkDraw(T);
}

/* ---------- семплы ---------- */
function trkQuantize(f, bits16){
  const len = Math.min(f.length, bits16 ? 1<<22 : 131070);
  if(bits16){ const d = new Int16Array(len); for(let i=0;i<len;i++) d[i] = clamp(Math.round(f[i]*32767), -32768, 32767); return d; }
  const d = new Int8Array(len + (len&1));
  for(let i=0;i<len;i++) d[i] = clamp(Math.round(f[i]*127), -128, 127);
  return d;
}
async function trkImportSample(T, file){
  const song = T.song, sm = trkCurSmp(T); if(!sm) return;
  try{
    trkMsg(T, 'decoding '+file.name+'…');
    let {samples, sr} = await decodeAudioFile(file);
    // MOD — пересчёт под C-3 PT; S3M/XM — частота остаётся, высоту задаёт C-4 rate / relative note
    const target = song.fmt==='mod' ? TRK_CLK.mod/(214*4) : Math.min(sr, 96000);
    const rs = aedResample(samples, sr, target);
    let pk = 0; for(let i=0;i<rs.length;i++){ const a=Math.abs(rs[i]); if(a>pk) pk=a; }
    if(pk>1) for(let i=0;i<rs.length;i++) rs[i] /= pk;
    trkChange(T, ()=>{
      sm.data = trkQuantize(rs, song.fmt!=='mod'); sm.name = file.name.replace(/\.[^.]+$/,'').slice(0,22);
      sm.vol = 64; sm.ft = 0; sm.ls = 0; sm.ll = 0; sm.loop = 0;
      if(song.fmt==='s3m') sm.c2spd = Math.round(target);
      if(song.fmt==='xm'){
        const semis = 12*Math.log2(target/8363); sm.rel = Math.round(semis); sm.ft = clamp(Math.round((semis-sm.rel)*128),-128,127);
        const ins = trkCurIns(T); if(ins && !ins.name) ins.name = sm.name;
      }
    });
    trkMsg(T, song.fmt==='mod' && rs.length>131070 ? 'sample cut to 131070 bytes (MOD limit)' : 'loaded '+sm.name);
    trkPanels(T);
  }catch(e){ console.warn(e); trkMsg(T, 'could not decode '+file.name); }
}
function trkEditSample(T){
  const sm = trkCurSmp(T); if(!sm) return;
  const song = T.song, bits16 = sm.data instanceof Int16Array || song.fmt!=='mod';
  const clip = { id:null, folderId:null, name:sm.name||('sample '+T.inst), sr:Math.round(trkSmpRate(song, sm)), samples:Float32Array.from(modSmpF(sm)) };
  T.sub = aedOpen(clip, {
    save:E=>{ trkChange(T, ()=>{ sm.data = trkQuantize(E.s, bits16); sm.name = (E.name||'').slice(0,28); trkFixLoop(sm); }); },
    onClose:()=>{ T.sub = null; trkPanels(T); },
  });
}
function trkCanvas(cv){
  const dpr = window.devicePixelRatio||1, W = cv.clientWidth, H = cv.clientHeight;
  if(!W || !H) return null;
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle = themeColor('--screen'); g.fillRect(0,0,W,H);
  return {g, W, H};
}
function trkWave(T){
  if(!T.ui) return;
  const c = trkCanvas(T.ui.wave); if(!c) return;
  const {g, W, H} = c, s = trkCurSmp(T);
  g.fillStyle = themeColor('--grid'); g.fillRect(0, H/2, W, 1);
  if(!s || !s.data.length){ g.fillStyle = themeColor('--axis'); g.font = '11px '+themeColor('--mono'); g.fillText('empty — load or drop an audio file', 8, H/2-6); return; }
  const f = modSmpF(s), len = f.length;
  if(s.loop){
    const x0 = s.ls/len*W, x1 = (s.ls+s.ll)/len*W;
    g.fillStyle = 'rgba(224,178,60,.16)'; g.fillRect(x0, 0, x1-x0, H);
    g.fillStyle = themeColor('--acc');
    for(const x of [x0,x1]){ g.fillRect(x-1, 0, 2, H); g.beginPath(); g.moveTo(x-7,H); g.lineTo(x+7,H); g.lineTo(x,H-11); g.fill(); }
  }
  g.strokeStyle = themeColor('--acc2'); g.beginPath();
  for(let x=0;x<W;x++){
    const i0 = Math.floor(x/W*len), i1 = Math.max(i0+1, Math.floor((x+1)/W*len));
    let lo = 1, hi = -1;
    for(let i=i0;i<i1 && i<len;i++){ const v=f[i]; if(v<lo) lo=v; if(v>hi) hi=v; }
    g.moveTo(x+.5, H/2 - hi*H/2*0.95); g.lineTo(x+.5, H/2 - lo*H/2*0.95 + 1);
  }
  g.stroke();
  g.fillStyle = themeColor('--hi');                 // где сейчас играет этот семпл
  for(const ch of T.pl.chn) if(ch.active && ch.smp===s) g.fillRect(ch.pos/len*W, 0, 1, H);
}
function trkBindWave(T){                       // перетаскивание краёв петли; с нуля — протянуть по волне
  const cv = T.ui.wave;
  let drag = null;
  const at = ev=>{ const r = cv.getBoundingClientRect(), s = trkCurSmp(T); return clamp((ev.clientX-r.left)/r.width,0,1)*s.data.length; };
  cv.addEventListener('pointerdown', ev=>{
    const s = trkCurSmp(T); if(!s || !s.data.length) return;
    const p = at(ev), tol = s.data.length/cv.clientWidth*14;
    let edge = 'new';
    if(s.loop){ if(Math.abs(p-s.ls)<tol) edge = 'a'; else if(Math.abs(p-(s.ls+s.ll))<tol) edge = 'b'; }
    drag = {edge, p0:p, first:true};
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', ev=>{
    if(!drag) return;
    const s = trkCurSmp(T), p = Math.round(at(ev)), len = s.data.length;
    if(drag.first){ T.undo.push(trkCloneSong(T.song, true)); T.redo.length = 0; T.fresh.clear(); drag.first = false; }
    if(drag.edge==='new'){ const a = Math.min(drag.p0|0, p), b = Math.max(drag.p0|0, p); s.ls = a; s.ll = b-a; s.loop = s.loop||1; }
    else if(drag.edge==='a'){ const end = s.ls+s.ll; s.ls = clamp(p, 0, end-2); s.ll = end-s.ls; }
    else s.ll = clamp(p, s.ls+2, len) - s.ls;
    T.song.rev++; trkSaveSoon(T.n); trkSampleEd(T);
  });
  const end = ()=>{ if(drag){ const s = trkCurSmp(T); if(s) trkFixLoop(s); drag = null; trkSampleEd(T); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
// карта нот инструмента XM: 96 клавиш, цвет — номер семпла
function trkMap(T){
  const ins = trkCurIns(T); if(!ins || !T.ui || T.ui.xi.hidden) return;
  const c = trkCanvas(T.ui.map); if(!c) return;
  const {g, W, H} = c, kw = W/96;
  const cols = ['--acc2','--acc','--t-spec','--t-img','--t-num','--t-bands','--t-rec','--t-blk'];
  for(let i=0;i<96;i++){
    const k = ins.map[i], blk = [1,3,6,8,10].includes(i%12);
    g.fillStyle = themeColor(cols[k%cols.length]); g.globalAlpha = k===T.smp ? .95 : .4;
    g.fillRect(i*kw, blk ? 0 : H*0.35, kw-.5, blk ? H*0.6 : H*0.65);
    g.globalAlpha = 1;
    if(i%12===0){ g.fillStyle = themeColor('--hi'); g.font = '9px '+themeColor('--mono'); g.fillText(i/12, i*kw+1, H-2); }
  }
}
function trkBindMap(T){
  const cv = T.ui.map; let on = false;
  const set = ev=>{
    const ins = trkCurIns(T); if(!ins) return;
    const r = cv.getBoundingClientRect(), i = clamp(Math.floor((ev.clientX-r.left)/r.width*96),0,95);
    if(ins.map[i]===T.smp) return;
    if(!on.snap){ T.undo.push(trkCloneSong(T.song, true)); T.redo.length = 0; on.snap = true; }
    ins.map[i] = T.smp; T.song.rev++; trkSaveSoon(T.n); trkMap(T);
  };
  cv.addEventListener('pointerdown', ev=>{ on = {snap:false}; cv.setPointerCapture(ev.pointerId); set(ev); });
  cv.addEventListener('pointermove', ev=>{ if(on) set(ev); });
  const end = ()=>{ on = false; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
// огибающая XM: точки [тик, 0..64]; тянуть — двигать, двойной клик — новая точка
function trkEnvGeom(T, e, W, H){ const tmax = Math.max(64, e.pts[e.pts.length-1][0]+16); return {tx:t=>t/tmax*W, ty:v=>H-4-v/64*(H-8), tmax}; }
function trkEnv(T){
  const ins = trkCurIns(T); if(!ins || !T.ui || T.ui.xe.hidden) return;
  const c = trkCanvas(T.ui.env); if(!c) return;
  const {g, W, H} = c, e = T.env==='v' ? ins.venv : ins.penv, {tx, ty} = trkEnvGeom(T, e, W, H);
  g.fillStyle = themeColor('--grid'); g.fillRect(0, ty(32), W, 1);
  if(e.loop){ g.fillStyle = 'rgba(224,178,60,.15)'; g.fillRect(tx(e.pts[e.ls][0]), 0, tx(e.pts[e.le][0])-tx(e.pts[e.ls][0]), H); }
  if(e.sus){ g.fillStyle = themeColor('--err'); g.fillRect(tx(e.pts[e.s][0])-.5, 0, 1, H); }
  g.globalAlpha = e.on ? 1 : .45;
  g.strokeStyle = themeColor('--acc2'); g.lineWidth = 1.5; g.beginPath();
  e.pts.forEach((p,i)=>{ i ? g.lineTo(tx(p[0]), ty(p[1])) : g.moveTo(tx(p[0]), ty(p[1])); });
  g.stroke();
  e.pts.forEach((p,i)=>{ g.fillStyle = i===T.envPt ? themeColor('--acc') : themeColor('--hi'); g.fillRect(tx(p[0])-3, ty(p[1])-3, 6, 6); });
  g.globalAlpha = 1;
  const ch = T.pl.chn.find(c=>c.active && c.ins===ins);                      // позиция играющей огибающей
  if(ch){ g.fillStyle = themeColor('--hi'); g.fillRect(tx(T.env==='v'?ch.envVT:ch.envPT), 0, 1, H); }
}
function trkBindEnv(T){
  const cv = T.ui.env; let drag = null;
  const hit = ev=>{
    const ins = trkCurIns(T); if(!ins) return null;
    const e = T.env==='v' ? ins.venv : ins.penv, r = cv.getBoundingClientRect(), G = trkEnvGeom(T, e, r.width, r.height);
    const x = ev.clientX-r.left, y = ev.clientY-r.top;
    let k = -1, bd = 14;
    e.pts.forEach((p,i)=>{ const d = Math.hypot(G.tx(p[0])-x, G.ty(p[1])-y); if(d<bd){ bd = d; k = i; } });
    return {e, k, t:Math.round(x/r.width*G.tmax), v:clamp(Math.round((r.height-4-y)/(r.height-8)*64),0,64)};
  };
  cv.addEventListener('pointerdown', ev=>{
    const h = hit(ev); if(!h || h.k<0) return;
    T.envPt = h.k; drag = {k:h.k, first:true}; cv.setPointerCapture(ev.pointerId); trkSampleEd(T);
  });
  cv.addEventListener('pointermove', ev=>{
    if(!drag) return;
    const h = hit(ev), P = h.e.pts, k = drag.k;
    if(drag.first){ T.undo.push(trkCloneSong(T.song, true)); T.redo.length = 0; drag.first = false; }
    P[k][0] = k===0 ? 0 : clamp(h.t, P[k-1][0]+1, k<P.length-1 ? P[k+1][0]-1 : 0xFFFF);
    P[k][1] = h.v;
    T.song.rev++; trkSaveSoon(T.n); trkEnv(T);
  });
  const end = ()=>{ drag = null; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', ev=>{
    const h = hit(ev); if(!h || h.k>=0 || h.e.pts.length>=12) return;
    const P = h.e.pts; let i = P.findIndex(p=>p[0]>h.t); if(i<0) i = P.length; if(i===0) return;
    trkChange(T, ()=>{ P.splice(i, 0, [h.t, h.v]); for(const f of ['s','ls','le']) if(h.e[f]>=i) h.e[f]++; });
    T.envPt = i; trkSampleEd(T);
  });
}

/* ---------- клавиатура ---------- */
function trkKey(T, ev){
  if(T.sub || !T.ui) return;                 // поверх открыт редактор семпла — клавиши его
  const t = ev.target;
  const typing = t && (t.tagName==='INPUT' && t.type!=='checkbox' && t.type!=='file' || t.tagName==='TEXTAREA' || t.tagName==='SELECT');
  ev.stopPropagation();
  if(typing){ if(ev.key==='Escape' || ev.key==='Enter') t.blur(); return; }
  const code = ev.code, mod = ev.ctrlKey||ev.metaKey, R = trkRows(T);
  const done = ()=>{ ev.preventDefault(); };
  if(mod){
    const m = {KeyZ:ev.shiftKey?'redo':'undo', KeyY:'redo', KeyC:'copy', KeyX:'cut', KeyV:'paste'}[code];
    if(m){ done(); trkAction(T, m); return; }
    if(code==='KeyA'){ done(); trkSelectAll(T); return; }
    if(code==='KeyS'){ done(); trkSave(T.n); trkMsg(T, 'saved in this browser'); return; }
    if(code==='ArrowUp' || code==='ArrowDown'){ done(); trkTranspose(T, (code==='ArrowUp'?1:-1)*(ev.shiftKey?12:1)); return; }
    return;
  }
  if(ev.altKey) return;
  if(/^F[1-9]$/.test(ev.key)){ done(); const [a,b] = trkOctRange(T.song); T.oct = clamp(+ev.key[1]-1+(T.song.fmt==='mod'?2:0), a, b); trkDraw(T); return; }
  switch(code){
    case 'Escape': done(); if(T.sel || T.anchor){ T.sel = null; T.anchor = null; trkDraw(T); } else trkClose(T); return;
    case 'Space': done(); if(ev.repeat) return; trkAction(T, ev.shiftKey ? 'playpat' : (T.pl.playing ? 'stop' : 'playsong')); return;
    case 'Enter': case 'NumpadEnter': done(); trkAction(T, 'edit'); return;
    case 'ArrowUp': done(); trkMove(T, -1, 0, ev.shiftKey); return;
    case 'ArrowDown': done(); trkMove(T, 1, 0, ev.shiftKey); return;
    case 'ArrowLeft': done(); trkMove(T, 0, ev.shiftKey?-trkCols(T.song).length:-1, false); return;
    case 'ArrowRight': done(); trkMove(T, 0, ev.shiftKey?trkCols(T.song).length:1, false); return;
    case 'PageUp': done(); trkMove(T, Math.max(0,T.row-16)-T.row, 0, ev.shiftKey); return;
    case 'PageDown': done(); trkMove(T, Math.min(R-1,T.row+16)-T.row, 0, ev.shiftKey); return;
    case 'Home': done(); trkMove(T, -T.row, 0, ev.shiftKey); return;
    case 'End': done(); trkMove(T, R-1-T.row, 0, ev.shiftKey); return;
    case 'Tab': done(); T.ch = (T.ch+(ev.shiftKey?T.song.ch-1:1))%T.song.ch; T.col = 0; if(!T.anchor) T.sel = null; trkDraw(T); return;
    case 'Delete': done(); trkClearSel(T); return;
    case 'Insert': done(); trkShiftRows(T, true); return;
    case 'Backspace': done(); trkShiftRows(T, false); return;
  }
  if(trkCols(T.song)[T.col].k==='n'){
    if(code==='Digit1' || code==='Backquote' || code==='CapsLock'){ done(); trkNoteOff(T); return; }
    const semi = TRK_PIANO[code];
    if(semi!=null){ done(); if(!ev.repeat) trkNote(T, semi); return; }
  } else {
    let v = -1;
    if(/^(Digit|Numpad)[0-9]$/.test(code)) v = +code.slice(-1);
    else if(/^Key[A-Z]$/.test(code)) v = code.charCodeAt(3)-55;
    if(v>=0){ done(); trkHex(T, v); return; }
  }
  if(code==='NumpadAdd'){ done(); trkAction(T, 'octup'); }
  else if(code==='NumpadSubtract'){ done(); trkAction(T, 'octdn'); }
}

/* ---------- паттерн: геометрия и отрисовка ---------- */
function trkMetrics(T){
  const U = T.ui, W = U.main.clientWidth, H = U.main.clientHeight, cols = trkCols(T.song);
  const fs = TOUCH ? 14 : 13, rh = fs+(TOUCH?8:5), cw = Math.round(fs*0.6*10)/10;
  const HH = 24, numW = 3*cw+8, chW = (cols[cols.length-1].x+1)*cw+14;
  const vis = Math.max(1, Math.floor((W-numW)/chW));
  if(T.ch<T.hs) T.hs = T.ch;
  if(T.ch>=T.hs+vis) T.hs = T.ch-vis+1;
  T.hs = clamp(T.hs, 0, Math.max(0, T.song.ch-vis));
  const cy = HH + Math.floor((H-HH)/2/rh)*rh;       // верх строки курсора
  return {W, H, fs, rh, cw, HH, numW, chW, vis, cy, cols};
}
function trkHit(T, x, y){
  const M = trkMetrics(T);
  const k = Math.floor((x-M.numW)/M.chW);
  const ch = clamp(T.hs+k, 0, T.song.ch-1);
  const cx = (x-M.numW-k*M.chW)/M.cw;
  let col = 0;
  M.cols.forEach((c,i)=>{ if(cx>=c.x-0.5) col = i; });
  const row = T.row + Math.floor((y-M.cy)/M.rh);
  return {ch, col, row, head:y<M.HH, M};
}
function trkDraw(T, now){
  if(!T.ui) return;
  if(now){ cancelAnimationFrame(T.raf); T.raf = 0; trkRender(T); return; }
  if(T.raf) return;
  T.raf = requestAnimationFrame(()=>{ T.raf = 0; trkRender(T); if(T.pl.playing || T.pl.chn.some(c=>c.active)) trkDraw(T); });
}
function trkRender(T){
  const U = T.ui, s = T.song, pl = T.pl;
  if(!U) return;
  if(pl.playing && T.follow){
    const sh = trkShown(T.n);
    if(sh.ord!==T.ord){ T.ord = sh.ord; trkOrders(T); }
    T.row = sh.row;
  }
  T.ord = clamp(T.ord, 0, s.orders.length-1);
  const cols = trkCols(s); if(T.col>=cols.length) T.col = 0;
  const cv = U.cv, dpr = window.devicePixelRatio||1, M = trkMetrics(T), {W,H,rh,cw,HH,numW,chW,cy} = M;
  if(!W || !H) return;
  const R = trkRows(T); T.row = clamp(T.row, 0, R-1);
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  const C = { bg:themeColor('--panel'), bg2:themeColor('--bg'), line:themeColor('--line'), txt:themeColor('--txt'), dim:themeColor('--dim'),
              acc:themeColor('--acc'), acc2:themeColor('--acc2'), fx:themeColor('--t-spec'), vol:themeColor('--t-num'), err:themeColor('--err') };
  g.fillStyle = C.bg2; g.fillRect(0,0,W,H);
  const pat = s.patterns[trkPatIdx(T)], d = pat ? pat.d : new Uint8Array(R*s.ch*5);
  const nch = Math.min(M.vis, s.ch-T.hs), vcol = s.fmt!=='mod', ex = vcol ? 10 : 7;
  g.font = M.fs+'px '+themeColor('--mono'); g.textBaseline = 'middle';
  const r0 = T.row - Math.ceil((cy-HH)/rh), r1 = T.row + Math.ceil((H-cy)/rh);
  const sel = T.sel ? trkSelRect(T) : null;
  const sh = pl.playing ? trkShown(T.n) : null;
  for(let r=Math.max(0,r0); r<=Math.min(R-1,r1); r++){
    const y = cy + (r-T.row)*rh, ym = y+rh/2;
    if(r%16===0){ g.fillStyle = 'rgba(127,127,127,.16)'; g.fillRect(0,y,W,rh); }
    else if(r%4===0){ g.fillStyle = 'rgba(127,127,127,.08)'; g.fillRect(0,y,W,rh); }
    if(sh && sh.ord===T.ord && sh.row===r && !T.follow){ g.fillStyle = 'rgba(78,201,176,.22)'; g.fillRect(0,y,W,rh); }
    g.fillStyle = r%4 ? C.dim : C.acc;
    g.fillText(R>100 ? modHex(r,2) : modHex(r,2), 4, ym);
    for(let k=0;k<nch;k++){
      const c = T.hs+k, x = numW+k*chW, o = (r*s.ch+c)*5;
      const nt = d[o], sm = d[o+1], vv = d[o+2], ef = d[o+3], pr = d[o+4];
      g.globalAlpha = pl.chn[c]?.mute ? .45 : 1;
      g.fillStyle = nt ? (nt>120 ? C.err : C.txt) : C.line; g.fillText(trkNoteName(s, nt), x, ym);
      g.fillStyle = sm ? C.acc2 : C.line; g.fillText(trkInstName(s, sm), x+4*cw, ym);
      if(vcol){ g.fillStyle = vv ? C.vol : C.line; g.fillText(trkVolName(s, vv), x+7*cw, ym); }
      g.fillStyle = ef||pr ? C.fx : C.line; g.fillText(trkEffName(s, ef, pr), x+ex*cw, ym);
      g.globalAlpha = 1;
    }
  }
  if(sel){                                        // выделение
    const k0 = Math.max(sel.c0, T.hs)-T.hs, k1 = Math.min(sel.c1, T.hs+nch-1)-T.hs;
    if(k1>=k0){
      const y0 = cy+(sel.r0-T.row)*rh, y1 = cy+(sel.r1+1-T.row)*rh;
      g.fillStyle = 'rgba(86,156,214,.25)'; g.fillRect(numW+k0*chW-4, y0, (k1-k0+1)*chW, y1-y0);
    }
  }
  g.fillStyle = T.edit ? 'rgba(224,92,92,.20)' : 'rgba(224,178,60,.16)'; g.fillRect(0, cy, W, rh);   // строка курсора
  if(T.ch>=T.hs && T.ch<T.hs+nch){
    const cc = cols[T.col], x = numW+(T.ch-T.hs)*chW+cc.x*cw, w = (cc.w||1)*cw;
    g.strokeStyle = T.edit ? C.err : C.acc; g.lineWidth = 1.5; g.strokeRect(x-1.5, cy+.5, w+3, rh-1);
  }
  g.fillStyle = C.line;                             // разделители каналов и шапка
  for(let k=0;k<=nch;k++) g.fillRect(numW+k*chW-7, HH, 1, H-HH);
  g.fillStyle = C.bg; g.fillRect(0,0,W,HH);
  g.fillStyle = C.line; g.fillRect(0,HH-1,W,1);
  for(let k=0;k<nch;k++){
    const c = T.hs+k, x = numW+k*chW-4, ch = pl.chn[c], w = chW-10;
    const solo = pl.solo===c, mute = ch?.mute, taken = ch && ch.takenAt>=Eng.blocks-2;
    g.fillStyle = C.bg2; g.fillRect(x, 4, w, HH-8);
    g.fillStyle = mute ? C.err : solo ? C.acc : C.acc2;
    g.globalAlpha = .55; g.fillRect(x, 4, w*clamp(ch?.vu||0,0,1), HH-8); g.globalAlpha = 1;
    g.fillStyle = mute ? C.err : C.txt;
    g.fillText((solo?'S ':mute?'M ':'')+'ch '+(c+1)+(taken?' ⇢':''), x+4, HH/2);
  }
  g.fillStyle = C.dim; g.fillText(T.hs>0?'◂':'', 2, HH/2);
  if(T.hs+nch<s.ch) g.fillText('▸', W-10, HH/2);
  trkStatus(T);
}
function trkHintFx(s, e, p){
  if(!e && !p) return '';
  if(s.fmt==='s3m'){
    const L = String.fromCharCode(64+e-100);
    return L==='S' ? 'S'+modHex(p>>4,1)+'x '+(TRK_S3SX[p>>4]||'') : TRK_S3FX[L]||'';
  }
  return e===14 ? 'E'+modHex(p>>4,1)+'x '+TRK_EFX[p>>4] : TRK_FX[e]||'';
}
function trkStatus(T){
  const U = T.ui, s = T.song, pl = T.pl, sh = trkShown(T.n);
  U.oct.textContent = T.oct-(s.fmt==='mod'?2:0); U.step.textContent = T.step;
  U.pos.textContent = pl.playing ? `pos ${modHex(sh.ord,2)}/${modHex(s.orders.length,2)} · row ${modHex(sh.row,2)} · ${pl.bpm} bpm · spd ${pl.speed}`
                                 : `pos ${modHex(T.ord,2)} · pat ${modHex(trkPatIdx(T),2)} · row ${modHex(T.row,2)}/${modHex(trkRows(T),2)}`;
  const nPat = new Set(s.orders).size, used = trkAllSamples(s).filter(x=>x.data.length).length;
  U.info.textContent = `${s.fmt.toUpperCase()} · ${s.ch} ch · ${s.orders.length} pos · ${nPat} pat · ${used} smp`;
  const bset = (a,on)=>U.root.querySelector(`[data-a=${a}]`)?.classList.toggle('on',!!on);
  bset('edit', T.edit); bset('follow', T.follow); bset('playsong', pl.playing && pl.mode==='song'); bset('playpat', pl.playing && pl.mode==='pattern');
  bset('mark', T.anchor);
  U.root.querySelector('[data-a=undo]').disabled = !T.undo.length;
  U.root.querySelector('[data-a=redo]').disabled = !T.redo.length;
  const p = s.patterns[trkPatIdx(T)], o = trkCell(T), col = trkCols(s)[T.col];
  const insList = s.instruments || s.samples;
  let hint = (s.instruments?'ins ':'smp ')+trkInstName(s,T.inst)+' '+(insList[T.inst-1]?.name||'');
  if(p){
    const d = p.d, v = d[o+2];
    if(col.k==='v' && v && !(v>=0x10 && v<=0x50)) hint = trkVolName(s,v)+': '+(TRK_VFX[v>>4]||'');
    else if(d[o+3]||d[o+4]) hint = trkEffName(s,d[o+3],d[o+4])+': '+trkHintFx(s,d[o+3],d[o+4]);
  }
  U.hint.textContent = hint;
  U.msg.textContent = performance.now()-T.msgT<3000 ? T.msg : (T.edit ? 'EDIT — keys write notes' : 'Enter: edit mode · Space: play');
  if(T.tab==='song' && pl.playing) trkOrdersLive(T);
  if(T.tab==='smp' && (pl.playing || pl.chn.some(c=>c.active))){ trkWave(T); trkEnv(T); }
}
function trkOrdersLive(T){                      // подсветка играющей позиции без перестройки списка
  const pos = trkShown(T.n).ord;
  if(T._plOrd===pos) return; T._plOrd = pos;
  T.ui.ords.querySelectorAll('.trk-ord').forEach(e=>e.classList.toggle('pl', +e.dataset.o===pos));
}
function trkBindPattern(T){
  const cv = T.ui.cv;
  cv.addEventListener('pointerdown', ev=>{
    const r = cv.getBoundingClientRect(), x = ev.clientX-r.left, y = ev.clientY-r.top;
    const h = trkHit(T, x, y);
    cv.setPointerCapture(ev.pointerId);
    if(h.head){
      const now = performance.now(), last = T.lastHead;
      T.lastHead = {c:h.ch, t:now};
      const ch = T.pl.chn[h.ch]; if(!ch) return;
      if(last && last.c===h.ch && now-last.t<350){          // двойной — соло вместо приглушения
        ch.mute = false; T.pl.solo = T.pl.solo===h.ch ? -1 : h.ch; T.lastHead = null; }
      else ch.mute = !ch.mute;
      trkDraw(T); return;
    }
    T.g = {x, y, row:T.row, hs:T.hs, h, moved:false, touch:ev.pointerType!=='mouse'};
    if(!T.g.touch && h.row>=0 && h.row<trkRows(T)){
      T.ch = h.ch; T.col = h.col; T.row = h.row;
      if(ev.shiftKey){ if(!T.sel) T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
      else if(!T.anchor) T.sel = null;
      T.follow = T.follow && !T.pl.playing;
    }
    trkDraw(T);
  });
  cv.addEventListener('pointermove', ev=>{
    const G = T.g; if(!G) return;
    const r = cv.getBoundingClientRect(), x = ev.clientX-r.left, y = ev.clientY-r.top, R = trkRows(T);
    if(!G.moved && Math.hypot(x-G.x, y-G.y)<6) return;
    G.moved = true;
    if(G.touch){                              // палец: прокрутка строк и каналов
      T.follow = false;
      T.row = clamp(G.row - Math.round((y-G.y)/G.h.M.rh), 0, R-1);
      T.hs = clamp(G.hs - Math.round((x-G.x)/G.h.M.chW), 0, Math.max(0, T.song.ch-G.h.M.vis));
      if(T.ch<T.hs) T.ch = T.hs; else if(T.ch>=T.hs+G.h.M.vis) T.ch = T.hs+G.h.M.vis-1;
    } else {                                  // мышь: выделение блока
      const h = trkHit(T, x, y);
      if(!T.sel) T.sel = {c0:G.h.ch, r0:G.h.row, c1:h.ch, r1:h.row};
      T.sel.c1 = h.ch; T.sel.r1 = clamp(h.row,0,R-1);
      if(y<G.h.M.HH+8) T.row = Math.max(0, T.row-1);          // у краёв — прокрутка
      else if(y>G.h.M.H-8) T.row = Math.min(R-1, T.row+1);
    }
    trkDraw(T);
  });
  const up = ev=>{
    const G = T.g; T.g = null; if(!G) return;
    if(G.touch && !G.moved){
      const r = cv.getBoundingClientRect(), h = trkHit(T, ev.clientX-r.left, ev.clientY-r.top);
      if(h.row>=0 && h.row<trkRows(T)){ T.ch = h.ch; T.col = h.col; T.row = h.row; T.follow = T.follow && !T.pl.playing;
        if(T.anchor && T.sel){ T.sel.c1 = T.ch; T.sel.r1 = T.row; } }
    }
    trkDraw(T);
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', ev=>{
    ev.preventDefault();
    if(ev.shiftKey || Math.abs(ev.deltaX)>Math.abs(ev.deltaY)){ T.ch = clamp(T.ch+Math.sign(ev.deltaX||ev.deltaY), 0, T.song.ch-1); trkDraw(T); return; }
    T.wheel += ev.deltaMode ? ev.deltaY*16 : ev.deltaY;
    const st = Math.trunc(T.wheel/40); if(!st) return;
    T.wheel -= st*40; T.follow = T.follow && !T.pl.playing;
    T.row = clamp(T.row+st, 0, trkRows(T)-1); trkDraw(T);
  }, {passive:false});
}
