/* ============================ ТРЕКЕР: СЕССИЯ РЕДАКТОРА ============================ */
// Состояние редактора живёт в узле Tracker Song (n.T): курсор, выделение, текущий инструмент,
// октава, отмена. Панели (tracker-panels.js) — только вид: полноэкранный редактор и узлы-тайлы
// показывают одну и ту же сессию, правка в любой панели видна во всех.
// Правки идут в n.song на месте — плеер слышит их сразу. Отмена — снимки песни; паттерны
// копируются при первой записи после снимка (copy-on-write), данные семплов не меняются на месте.
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

function trkSession(n){
  if(n.T) return n.T;
  const T = { n, song:n.song, pl:n.pl, ord:0, row:0, ch:0, col:0, oct:4, step:1, edit:false, follow:true,
              inst:1, smp:0, sel:null, anchor:null, undo:[], redo:[], fresh:new Set(), raf:0,
              msg:'', msgT:0, sub:null, env:'v', envPt:0, panels:new Set(), full:null };
  const pick = accept=>{ const f = document.createElement('input'); f.type = 'file'; f.accept = accept; f.hidden = true; document.body.append(f); return f; };
  T.file = pick('.mod,.s3m,.xm,.MOD,.S3M,.XM,.nst,.m15,.stk');
  T.sfile = pick('audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff');
  T.file.addEventListener('change', ()=>{ const f=T.file.files[0]; T.file.value=''; if(f) trkLoadFile(n, f); });
  T.sfile.addEventListener('change', ()=>{ const f=T.sfile.files[0]; T.sfile.value=''; if(f) trkImportSample(T, f); });
  n.T = T;
  return T;
}
function trkSessionDispose(T){
  for(const p of [...T.panels]) trkPanelDetach(p);
  if(T.full) trkClose(T, true);
  cancelAnimationFrame(T.raf); T.raf = 0;
  T.file.remove(); T.sfile.remove();
  if(TRK_FOCUS===T) TRK_FOCUS = null;
}
function trkReset(T){
  T.ord = 0; T.row = 0; T.ch = 0; T.col = 0; T.sel = null; T.anchor = null;
  T.undo = []; T.redo = []; T.fresh.clear(); T.inst = 1; T.smp = 0; T.envPt = 0;
  const [a,b] = trkOctRange(T.song); T.oct = clamp(T.oct, a, b);
}
function trkCurIns(T){ return T.song.instruments ? T.song.instruments[T.inst-1] : null; }
function trkCurSmp(T){
  const s = T.song;
  if(s.instruments){ const i = s.instruments[T.inst-1]; return i ? i.samples[clamp(T.smp,0,i.samples.length-1)] : null; }
  return s.samples[T.inst-1] || null;
}
function trkInsCount(song){ return song.instruments ? song.instruments.length : song.samples.length; }
function trkMsg(T, m){ T.msg = m; T.msgT = performance.now(); trkDraw(T); setTimeout(()=>trkDraw(T), 3100); }
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
  trkRefresh(T);
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
  trkRefresh(T);
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
  T.smp = 0; trkRefresh(T);
}

function trkAction(T, a, v){
  const s = T.song, pl = T.pl, n = T.n, ins = trkCurIns(T);
  switch(a){
    case 'close': return trkClose(T);
    case 'open': T.file.click(); return;
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
    case 'posins': trkChange(T, ()=>{ if(s.orders.length<256) s.orders.splice(T.ord+1, 0, s.orders[T.ord]); }); T.ord = Math.min(T.ord+1, s.orders.length-1); trkRefresh(T); return;
    case 'posdel': if(s.orders.length>1){ trkChange(T, ()=>{ s.orders.splice(T.ord,1); }); T.ord = Math.min(T.ord, s.orders.length-1); trkRefresh(T); } return;
    case 'patdn': trkChange(T, ()=>{ s.orders[T.ord] = Math.max(0, s.orders[T.ord]-1); }); trkRefresh(T); return;
    case 'patup': trkChange(T, ()=>{ const p = Math.min(s.fmt==='xm'?255:99, s.orders[T.ord]+1); trkPatW(T, p); s.orders[T.ord] = p; }); trkRefresh(T); return;
    case 'patnew': trkChange(T, ()=>{ const i = s.patterns.length; if(i>=(s.fmt==='xm'?256:100)) return; s.patterns.push(trkNewPattern(trkRows(T), s.ch)); T.fresh.add(i); s.orders[T.ord] = i; }); trkRefresh(T); return;
    case 'patclone': trkChange(T, ()=>{ const i = s.patterns.length; if(i>=(s.fmt==='xm'?256:100)) return; const p = s.patterns[trkPatIdx(T)]; s.patterns.push({rows:p.rows, d:p.d.slice()}); T.fresh.add(i); s.orders[T.ord] = i; }); trkRefresh(T); return;
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
    case 'sload': T.sfile.click(); return;
    case 'sedit': trkEditSample(T); return;
    case 'swav': {
      const sm = trkCurSmp(T); if(!sm || !sm.data.length) return;
      dl(aedWavBlob(Float32Array.from(modSmpF(sm)), Math.round(trkSmpRate(s, sm))), (sm.name||'sample'+T.inst).replace(/[\\/:*?"<>|]/g,'_').trim()+'.wav');
      return;
    }
    case 'sclear': {
      const sm = trkCurSmp(T); if(!sm) return;
      trkChange(T, ()=>{ Object.assign(sm, trkEmptySample(), s.instruments ? {pan:128} : {}); });
      trkRefresh(T); return;
    }
    case 'xsel': T.smp = v; trkRefresh(T,'smp'); return;
    case 'xsadd': if(ins && ins.samples.length<16){ trkChange(T, ()=>{ const e = trkEmptySample(); e.pan = 128; ins.samples.push(e); }); T.smp = ins.samples.length-1; trkRefresh(T); } return;
    case 'xsdel': if(ins && ins.samples.length>1){
      const k = T.smp;
      trkChange(T, ()=>{ ins.samples.splice(k,1); for(let i=0;i<96;i++){ if(ins.map[i]===k) ins.map[i] = 0; else if(ins.map[i]>k) ins.map[i]--; } });
      T.smp = Math.max(0, k-1); trkRefresh(T); } return;
    case 'mapall': if(ins){ trkChange(T, ()=>{ ins.map.fill(T.smp); }); trkDraw(T); } return;
    case 'envv': T.env = 'v'; T.envPt = 0; trkRefresh(T,'smp'); return;
    case 'envp': T.env = 'p'; T.envPt = 0; trkRefresh(T,'smp'); return;
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
      trkRefresh(T,'smp'); return;
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
  try{
    trkMsg(T, 'decoding '+file.name+'…');
    const {samples, sr} = await decodeAudioFile(file);
    trkPutAudio(T, samples, sr, file.name.replace(/\.[^.]+$/,''));
  }catch(e){ console.warn(e); trkMsg(T, 'could not decode '+file.name); }
}
// звук (float, любая частота) в текущий слот: MOD — пересчёт под C-3 PT;
// S3M/XM — частота остаётся, высоту задаёт C-4 rate / relative note
function trkPutAudio(T, samples, sr, name){
  const song = T.song, sm = trkCurSmp(T); if(!sm) return;
  const target = song.fmt==='mod' ? TRK_CLK.mod/(214*4) : Math.min(sr, 96000);
  const rs = aedResample(samples, sr, target);
  let pk = 0; for(let i=0;i<rs.length;i++){ const a=Math.abs(rs[i]); if(a>pk) pk=a; }
  if(pk>1) for(let i=0;i<rs.length;i++) rs[i] /= pk;
  trkChange(T, ()=>{
    sm.data = trkQuantize(rs, song.fmt!=='mod'); sm.name = String(name||'').slice(0,22);
    sm.vol = 64; sm.ft = 0; sm.ls = 0; sm.ll = 0; sm.loop = 0;
    if(song.fmt==='s3m') sm.c2spd = Math.round(target);
    if(song.fmt==='xm'){
      const semis = 12*Math.log2(target/8363); sm.rel = Math.round(semis); sm.ft = clamp(Math.round((semis-sm.rel)*128),-128,127);
      const ins = trkCurIns(T); if(ins && !ins.name) ins.name = sm.name;
    }
  });
  trkMsg(T, song.fmt==='mod' && rs.length>131070 ? 'sample cut to 131070 bytes (MOD limit)' : 'loaded '+sm.name);
  trkRefresh(T);
}
function trkEditSample(T){
  const sm = trkCurSmp(T); if(!sm) return;
  const song = T.song, bits16 = sm.data instanceof Int16Array || song.fmt!=='mod';
  const clip = { id:null, folderId:null, name:sm.name||('sample '+T.inst), sr:Math.round(trkSmpRate(song, sm)), samples:Float32Array.from(modSmpF(sm)) };
  T.sub = aedOpen(clip, {
    save:E=>{ trkChange(T, ()=>{ sm.data = trkQuantize(E.s, bits16); sm.name = (E.name||'').slice(0,28); trkFixLoop(sm); }); },
    onClose:()=>{ T.sub = null; trkRefresh(T); },
  });
}


/* ---------- клавиатура: к той сессии, в чьей панели был последний клик ---------- */
let TRK_FOCUS = null;
document.addEventListener('pointerdown', ev=>{
  const p = ev.target.closest?.('.trk-panel, .trk');
  if(!p) TRK_FOCUS = null;
}, true);
window.addEventListener('keydown', ev=>{
  const T = TRK_FOCUS;
  if(!T || T.sub) return;                        // поверх открыт редактор семпла — клавиши его
  if(!T.full && ![...T.panels].some(p=>p.kind==='pat' || p.kind==='keys')) return;
  trkKey(T, ev);
}, true);
function trkKey(T, ev){
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
    case 'Escape': done(); if(T.sel || T.anchor){ T.sel = null; T.anchor = null; trkDraw(T); } else if(T.full) trkClose(T); return;
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
