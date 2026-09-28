/* ============================ ТРЕКЕР: ПАНЕЛИ ============================ */
// Каждая панель — вид одной сессии (tracker-session.js): transport, pattern, seq (последовательность
// паттернов и настройки песни), ins (список инструментов), smp (семпл/инструмент), keys (экранные
// клавиши), mix (каналы). Полноэкранный редактор собирает их все в одно окно; узлы-тайлы
// (tracker.js) показывают по одной — из них раскладывается свой редактор на дашборде.

const trkBtn = (a,t,title,cls='')=>`<button class="aed-b ${cls}" data-a="${a}" title="${title}">${t}</button>`;
const trkNum = (cls, label, min, max, step=1)=>`<label>${label}<input type="number" class="${cls}" min="${min}" max="${max}" step="${step}"></label>`;

function trkPanel(T, kind){
  const el = document.createElement('div');
  el.className = 'trk-panel trk-p-'+kind;
  const P = {T, kind, el, U:{}, hs:0};
  // кнопки не забирают фокус — иначе пробел/стрелки уходят в кнопку, а не в редактор
  el.addEventListener('pointerdown', ev=>{ TRK_FOCUS = T; if(ev.target.closest('button')) ev.preventDefault(); }, true);
  el.addEventListener('click', ev=>{
    const b = ev.target.closest('[data-a]');
    if(b && el.contains(b)) trkAction(T, b.dataset.a, b.dataset.v!=null ? +b.dataset.v : undefined);
  });
  TRK_PANELS[kind](P);
  T.panels.add(P);
  if(P.ro) for(const c of P.ro.els) P.ro.obs.observe(c);
  P.refresh?.();
  trkDraw(T);
  return P;
}
function trkPanelDetach(P){
  P.ro?.obs.disconnect();
  P.T.panels.delete(P);
  P.el.remove();
}
function trkResizeWatch(P, els){ P.ro = {obs:new ResizeObserver(()=>{ P.draw?.(); }), els}; }
function trkRefresh(T, kind){
  for(const P of T.panels) if(!kind || P.kind===kind) P.refresh?.();
  trkDraw(T, true);
}
// перерисовка всех панелей сессии; пока идёт звук — каждый кадр
function trkDraw(T, now){
  if(!T.panels.size) return;
  const run = ()=>{
    T.raf = 0;
    const pl = T.pl;
    if(pl.playing && T.follow){
      const sh = trkShown(T.n);
      if(sh.ord!==T.ord){ T.ord = sh.ord; for(const P of T.panels) if(P.kind==='seq') P.refresh(); }
      T.row = sh.row;
    }
    T.ord = clamp(T.ord, 0, T.song.orders.length-1);
    T.row = clamp(T.row, 0, trkRows(T)-1);
    if(T.col>=trkCols(T.song).length) T.col = 0;
    for(const P of T.panels) P.draw?.();
    if(pl.playing || pl.chn.some(c=>c.active)) trkDraw(T);
  };
  if(now){ cancelAnimationFrame(T.raf); run(); return; }
  if(!T.raf) T.raf = requestAnimationFrame(run);
}
function trkCanvas(cv){
  const dpr = window.devicePixelRatio||1, W = cv.clientWidth, H = cv.clientHeight;
  if(!W || !H) return null;
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle = themeColor('--screen'); g.fillRect(0,0,W,H);
  return {g, W, H};
}

const TRK_PANELS = {};

/* ---------- транспорт и файл ---------- */
TRK_PANELS.bar = P=>{
  const T = P.T;
  P.el.innerHTML = `
    <div class="aed-row trk-head">
      <input class="aed-name trk-title" type="text" spellcheck="false" maxlength="28" title="Song title">
      <span class="aed-info trk-info"></span>
      ${trkBtn('open','⭱ open','Open a .mod / .s3m / .xm file')}
      ${trkBtn('savefile','⭳','Download in the song\'s format','aed-pri trk-savefile')}
      <select class="trk-new aed-b" title="New empty song"><option value="">new…</option><option value="mod">new MOD (4 ch)</option><option value="s3m">new S3M (8 ch)</option><option value="xm">new XM (8 ch)</option></select>
      <select class="trk-conv aed-b" title="Convert the song to another format"><option value="">convert…</option><option value="s3m">to S3M</option><option value="xm">to XM</option></select>
    </div>
    <div class="aed-row trk-tr">
      ${trkBtn('playsong','▶ song','Play song from this position (Space)','aed-play')}
      ${trkBtn('playpat','▶ pat','Loop this pattern from the cursor row (Shift+Space)')}
      ${trkBtn('stop','■','Stop')}
      ${trkBtn('edit','● edit','Edit mode: keys write notes (Enter)')}
      ${trkBtn('follow','⇣ follow','Cursor follows playback')}
      <span class="trk-lab">oct</span>${trkBtn('octdn','−','Octave down (F1…F8 set it)')}<b class="trk-oct"></b>${trkBtn('octup','+','Octave up')}
      <span class="trk-lab">step</span>${trkBtn('stepdn','−','Rows to advance after a note')}<b class="trk-step"></b>${trkBtn('stepup','+','Edit step up')}
      ${trkBtn('undo','↶','Undo (Ctrl+Z)')}${trkBtn('redo','↷','Redo (Ctrl+Shift+Z)')}
      <span class="trk-pos"></span>
    </div>`;
  const q = s=>P.el.querySelector(s), U = P.U;
  Object.assign(U, {title:q('.trk-title'), info:q('.trk-info'), pos:q('.trk-pos'), oct:q('.trk-oct'), step:q('.trk-step'),
                    save:q('.trk-savefile'), nw:q('.trk-new'), conv:q('.trk-conv')});
  U.title.addEventListener('input', ()=>trkChange(T, ()=>{ T.song.title = U.title.value; }, 'title'));
  U.nw.addEventListener('change', ()=>{ const f = U.nw.value; U.nw.value = ''; if(f) trkNewSongUI(T, f); });
  U.conv.addEventListener('change', ()=>{ const f = U.conv.value; U.conv.value = ''; if(f) trkConvertUI(T, f); });
  P.refresh = ()=>{
    const s = T.song;
    if(document.activeElement!==U.title) U.title.value = s.title;
    U.save.textContent = '⭳ '+TRK_EXT[s.fmt];
    U.conv.hidden = s.fmt==='xm';
    U.conv.querySelector('[value=s3m]').hidden = s.fmt!=='mod';
  };
  P.draw = ()=>{
    const s = T.song, pl = T.pl, sh = trkShown(T.n);
    U.oct.textContent = T.oct-(s.fmt==='mod'?2:0); U.step.textContent = T.step;
    U.pos.textContent = pl.playing ? `pos ${modHex(sh.ord,2)}/${modHex(s.orders.length,2)} · row ${modHex(sh.row,2)} · ${pl.bpm} bpm · spd ${pl.speed}`
                                   : `pos ${modHex(T.ord,2)} · pat ${modHex(trkPatIdx(T),2)} · row ${modHex(T.row,2)}/${modHex(trkRows(T),2)}`;
    const nPat = new Set(s.orders).size, used = trkAllSamples(s).filter(x=>x.data.length).length;
    U.info.textContent = `${s.fmt.toUpperCase()} · ${s.ch} ch · ${s.orders.length} pos · ${nPat} pat · ${used} smp`;
    const bset = (a,on)=>P.el.querySelector(`[data-a=${a}]`)?.classList.toggle('on',!!on);
    bset('edit', T.edit); bset('follow', T.follow); bset('playsong', pl.playing && pl.mode==='song'); bset('playpat', pl.playing && pl.mode==='pattern');
    P.el.querySelector('[data-a=undo]').disabled = !T.undo.length;
    P.el.querySelector('[data-a=redo]').disabled = !T.redo.length;
  };
};

/* ---------- паттерн ---------- */
TRK_PANELS.pat = P=>{
  const T = P.T;
  P.el.innerHTML = `<div class="trk-main"><canvas class="trk-cv"></canvas></div><div class="aed-stat"><span class="trk-msg"></span><span class="trk-hint"></span></div>`;
  P.U = {main:P.el.querySelector('.trk-main'), cv:P.el.querySelector('.trk-cv'), msg:P.el.querySelector('.trk-msg'), hint:P.el.querySelector('.trk-hint')};
  trkResizeWatch(P, [P.U.main]);
  P.draw = ()=>{ trkRenderPat(P); trkPatStatus(P); };
  trkBindPattern(P);
};
function trkMetrics(P){
  const T = P.T, U = P.U, W = U.main.clientWidth, H = U.main.clientHeight, cols = trkCols(T.song);
  const fs = TOUCH ? 14 : 13, rh = fs+(TOUCH?8:5), cw = Math.round(fs*0.6*10)/10;
  const HH = 24, numW = 3*cw+8, chW = (cols[cols.length-1].x+1)*cw+14;
  const vis = Math.max(1, Math.floor((W-numW)/chW));
  if(T.ch<P.hs) P.hs = T.ch;
  if(T.ch>=P.hs+vis) P.hs = T.ch-vis+1;
  P.hs = clamp(P.hs, 0, Math.max(0, T.song.ch-vis));
  const cy = HH + Math.floor((H-HH)/2/rh)*rh;       // верх строки курсора
  return {W, H, fs, rh, cw, HH, numW, chW, vis, cy, cols};
}
function trkHit(P, x, y){
  const T = P.T, M = trkMetrics(P);
  const k = Math.floor((x-M.numW)/M.chW);
  const ch = clamp(P.hs+k, 0, T.song.ch-1);
  const cx = (x-M.numW-k*M.chW)/M.cw;
  let col = 0;
  M.cols.forEach((c,i)=>{ if(cx>=c.x-0.5) col = i; });
  const row = T.row + Math.floor((y-M.cy)/M.rh);
  return {ch, col, row, head:y<M.HH, M};
}
function trkRenderPat(P){
  const T = P.T, U = P.U, s = T.song, pl = T.pl;
  const cols = trkCols(s);
  const cv = U.cv, dpr = window.devicePixelRatio||1, M = trkMetrics(P), {W,H,rh,cw,HH,numW,chW,cy} = M;
  if(!W || !H) return;
  const R = trkRows(T);
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  const C = { bg:themeColor('--panel'), bg2:themeColor('--bg'), line:themeColor('--line'), txt:themeColor('--txt'), dim:themeColor('--dim'),
              acc:themeColor('--acc'), acc2:themeColor('--acc2'), fx:themeColor('--t-spec'), vol:themeColor('--t-num'), err:themeColor('--err'), trk:themeColor('--t-trk') };
  g.fillStyle = C.bg2; g.fillRect(0,0,W,H);
  const pat = s.patterns[trkPatIdx(T)], d = pat ? pat.d : new Uint8Array(R*s.ch*5);
  const nch = Math.min(M.vis, s.ch-P.hs), vcol = s.fmt!=='mod', ex = vcol ? 10 : 7;
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
    g.fillText(modHex(r,2), 4, ym);
    for(let k=0;k<nch;k++){
      const c = P.hs+k, x = numW+k*chW, o = (r*s.ch+c)*5;
      const nt = d[o], sm = d[o+1], vv = d[o+2], ef = d[o+3], pr = d[o+4];
      g.globalAlpha = pl.chn[c]?.mute ? .45 : 1;
      g.fillStyle = nt ? (nt>120 ? C.err : C.txt) : C.line; g.fillText(trkNoteName(s, nt), x, ym);
      g.fillStyle = sm ? (trkIsExt(pl, sm) ? C.trk : C.acc2) : C.line; g.fillText(trkInstName(s, sm), x+4*cw, ym);
      if(vcol){ g.fillStyle = vv ? C.vol : C.line; g.fillText(trkVolName(s, vv), x+7*cw, ym); }
      g.fillStyle = ef||pr ? C.fx : C.line; g.fillText(trkEffName(s, ef, pr), x+ex*cw, ym);
      g.globalAlpha = 1;
    }
  }
  if(sel){                                        // выделение
    const k0 = Math.max(sel.c0, P.hs)-P.hs, k1 = Math.min(sel.c1, P.hs+nch-1)-P.hs;
    if(k1>=k0){
      const y0 = cy+(sel.r0-T.row)*rh, y1 = cy+(sel.r1+1-T.row)*rh;
      g.fillStyle = 'rgba(86,156,214,.25)'; g.fillRect(numW+k0*chW-4, y0, (k1-k0+1)*chW, y1-y0);
    }
  }
  g.fillStyle = T.edit ? 'rgba(224,92,92,.20)' : 'rgba(224,178,60,.16)'; g.fillRect(0, cy, W, rh);   // строка курсора
  if(T.ch>=P.hs && T.ch<P.hs+nch){
    const cc = cols[T.col], x = numW+(T.ch-P.hs)*chW+cc.x*cw, w = (cc.w||1)*cw;
    g.strokeStyle = T.edit ? C.err : C.acc; g.lineWidth = 1.5; g.strokeRect(x-1.5, cy+.5, w+3, rh-1);
  }
  g.fillStyle = C.line;                             // разделители каналов и шапка
  for(let k=0;k<=nch;k++) g.fillRect(numW+k*chW-7, HH, 1, H-HH);
  g.fillStyle = C.bg; g.fillRect(0,0,W,HH);
  g.fillStyle = C.line; g.fillRect(0,HH-1,W,1);
  for(let k=0;k<nch;k++){
    const c = P.hs+k, x = numW+k*chW-4, ch = pl.chn[c], w = chW-10;
    const solo = pl.solo===c, mute = ch?.mute, taken = ch && ch.takenAt>=Eng.blocks-2;
    g.fillStyle = C.bg2; g.fillRect(x, 4, w, HH-8);
    g.fillStyle = mute ? C.err : solo ? C.acc : C.acc2;
    g.globalAlpha = .55; g.fillRect(x, 4, w*clamp(ch?.vu||0,0,1), HH-8); g.globalAlpha = 1;
    g.fillStyle = mute ? C.err : C.txt;
    g.fillText((solo?'S ':mute?'M ':'')+'ch '+(c+1)+(taken?' ⇢':''), x+4, HH/2);
  }
  g.fillStyle = C.dim; g.fillText(P.hs>0?'◂':'', 2, HH/2);
  if(P.hs+nch<s.ch) g.fillText('▸', W-10, HH/2);
}
function trkHintFx(s, e, p){
  if(!e && !p) return '';
  if(s.fmt==='s3m'){
    const L = String.fromCharCode(64+e-100);
    return L==='S' ? 'S'+modHex(p>>4,1)+'x '+(TRK_S3SX[p>>4]||'') : TRK_S3FX[L]||'';
  }
  return e===14 ? 'E'+modHex(p>>4,1)+'x '+TRK_EFX[p>>4] : TRK_FX[e]||'';
}
function trkPatStatus(P){
  const T = P.T, U = P.U, s = T.song;
  const p = s.patterns[trkPatIdx(T)], o = trkCell(T), col = trkCols(s)[T.col];
  const insList = s.instruments || s.samples;
  let hint = (s.instruments?'ins ':'smp ')+trkInstName(s,T.inst)+' '+(insList[T.inst-1]?.name||'')+(trkIsExt(T.pl,T.inst)?' ⇢ module':'');
  if(p){
    const d = p.d, v = d[o+2];
    if(col.k==='v' && v && !(v>=0x10 && v<=0x50)) hint = trkVolName(s,v)+': '+(TRK_VFX[v>>4]||'');
    else if(d[o+3]||d[o+4]) hint = trkEffName(s,d[o+3],d[o+4])+': '+trkHintFx(s,d[o+3],d[o+4]);
  }
  U.hint.textContent = hint;
  U.msg.textContent = performance.now()-T.msgT<3000 ? T.msg : (T.edit ? 'EDIT — keys write notes' : 'Enter: edit mode · Space: play');
}
function trkBindPattern(P){
  const T = P.T, cv = P.U.cv;
  cv.addEventListener('pointerdown', ev=>{
    ev.stopPropagation();
    const r = cv.getBoundingClientRect(), x = ev.clientX-r.left, y = ev.clientY-r.top;
    const h = trkHit(P, x, y);
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
    P.g = {x, y, row:T.row, hs:P.hs, h, moved:false, touch:ev.pointerType!=='mouse'};
    if(!P.g.touch && h.row>=0 && h.row<trkRows(T)){
      T.ch = h.ch; T.col = h.col; T.row = h.row;
      if(ev.shiftKey){ if(!T.sel) T.sel = {c0:T.ch, r0:T.row, c1:T.ch, r1:T.row}; }
      else if(!T.anchor) T.sel = null;
      T.follow = T.follow && !T.pl.playing;
    }
    trkDraw(T);
  });
  cv.addEventListener('pointermove', ev=>{
    const G = P.g; if(!G) return;
    ev.stopPropagation();
    const r = cv.getBoundingClientRect(), x = ev.clientX-r.left, y = ev.clientY-r.top, R = trkRows(T);
    if(!G.moved && Math.hypot(x-G.x, y-G.y)<6) return;
    G.moved = true;
    if(G.touch){                              // палец: прокрутка строк и каналов
      T.follow = false;
      T.row = clamp(G.row - Math.round((y-G.y)/G.h.M.rh), 0, R-1);
      P.hs = clamp(G.hs - Math.round((x-G.x)/G.h.M.chW), 0, Math.max(0, T.song.ch-G.h.M.vis));
      if(T.ch<P.hs) T.ch = P.hs; else if(T.ch>=P.hs+G.h.M.vis) T.ch = P.hs+G.h.M.vis-1;
    } else {                                  // мышь: выделение блока
      const h = trkHit(P, x, y);
      if(!T.sel) T.sel = {c0:G.h.ch, r0:G.h.row, c1:h.ch, r1:h.row};
      T.sel.c1 = h.ch; T.sel.r1 = clamp(h.row,0,R-1);
      if(y<G.h.M.HH+8) T.row = Math.max(0, T.row-1);          // у краёв — прокрутка
      else if(y>G.h.M.H-8) T.row = Math.min(R-1, T.row+1);
    }
    trkDraw(T);
  });
  const up = ev=>{
    const G = P.g; P.g = null; if(!G) return;
    if(G.touch && !G.moved){
      const r = cv.getBoundingClientRect(), h = trkHit(P, ev.clientX-r.left, ev.clientY-r.top);
      if(h.row>=0 && h.row<trkRows(T)){ T.ch = h.ch; T.col = h.col; T.row = h.row; T.follow = T.follow && !T.pl.playing;
        if(T.anchor && T.sel){ T.sel.c1 = T.ch; T.sel.r1 = T.row; } }
    }
    trkDraw(T);
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  P.wheel = 0;
  cv.addEventListener('wheel', ev=>{
    ev.preventDefault(); ev.stopPropagation();
    if(ev.shiftKey || Math.abs(ev.deltaX)>Math.abs(ev.deltaY)){ T.ch = clamp(T.ch+Math.sign(ev.deltaX||ev.deltaY), 0, T.song.ch-1); trkDraw(T); return; }
    P.wheel += ev.deltaMode ? ev.deltaY*16 : ev.deltaY;
    const st = Math.trunc(P.wheel/40); if(!st) return;
    P.wheel -= st*40; T.follow = T.follow && !T.pl.playing;
    T.row = clamp(T.row+st, 0, trkRows(T)-1); trkDraw(T);
  }, {passive:false});
}

/* ---------- последовательность паттернов и песня ---------- */
TRK_PANELS.seq = P=>{
  const T = P.T;
  P.el.innerHTML = `
    <div class="aed-row trk-wrap">
      ${trkBtn('posins','+ pos','Insert a position after this one')}${trkBtn('posdel','− pos','Delete this position')}
      ${trkBtn('patdn','pat −','Previous pattern number at this position')}${trkBtn('patup','pat +','Next pattern number (a new empty one after the last)')}
      ${trkBtn('patnew','new pat','Put a new empty pattern at this position')}${trkBtn('patclone','clone','Copy of this pattern as a new one, put here')}
      ${trkBtn('patclear','clear','Clear this pattern')}
    </div>
    <div class="trk-ords"></div>
    <div class="trk-grid">
      ${trkNum('trk-rows','rows in this pattern',1,256)}
      <label>channels<select class="trk-chn"></select></label>
      ${trkNum('trk-speed','initial speed',1,31)}
      ${trkNum('trk-bpm','initial tempo, bpm',32,255)}
      ${trkNum('trk-gvol','global volume',0,64)}
      ${trkNum('trk-restart','restart position',0,255)}
      <label class="trk-chk"><input type="checkbox" class="trk-lin"> linear frequencies</label>
    </div>`;
  const q = s=>P.el.querySelector(s), U = P.U, S = ()=>T.song;
  Object.assign(U, {ords:q('.trk-ords'), rows:q('.trk-rows'), chn:q('.trk-chn'), speed:q('.trk-speed'), bpm:q('.trk-bpm'),
                    gvol:q('.trk-gvol'), restart:q('.trk-restart'), lin:q('.trk-lin')});
  const songNum = (el, fn)=>el.addEventListener('change', ()=>{ trkChange(T, ()=>fn(+el.value|0)); trkRefresh(T); });
  songNum(U.speed, v=>{ S().speed = clamp(v,1,31); });
  songNum(U.bpm, v=>{ S().bpm = clamp(v,32,255); });
  songNum(U.gvol, v=>{ S().gvol = clamp(v,0,64); });
  songNum(U.restart, v=>{ S().restart = clamp(v,0,255); });
  songNum(U.rows, v=>trkSetRows(T, clamp(v,1,256)));
  U.lin.addEventListener('change', ()=>{ trkChange(T, ()=>{ S().linear = U.lin.checked; }); });
  U.chn.addEventListener('change', ()=>trkSetChannels(T, +U.chn.value));
  U.ords.addEventListener('click', ev=>{
    const e = ev.target.closest('[data-o]'); if(!e) return;
    T.ord = +e.dataset.o; T.follow = T.follow && !T.pl.playing; T.row = Math.min(T.row, trkRows(T)-1); trkRefresh(T);
  });
  P.refresh = ()=>{
    const s = T.song, xm = s.fmt==='xm', mod = s.fmt==='mod';
    T.ord = clamp(T.ord, 0, s.orders.length-1);
    const pat = s.patterns[s.orders[T.ord]];
    U.rows.value = pat ? pat.rows : 64; U.rows.parentElement.hidden = !xm;
    const chOpts = mod ? [1,2,3,4,5,6,7,8,10,12,16,24,32] : xm ? [2,4,6,8,10,12,16,20,24,32] : [1,2,4,6,8,10,12,16,20,24,32];
    if(!chOpts.includes(s.ch)) chOpts.push(s.ch);
    U.chn.innerHTML = chOpts.sort((a,b)=>a-b).map(v=>`<option${v===s.ch?' selected':''}>${v}</option>`).join('');
    U.speed.value = s.speed; U.bpm.value = s.bpm; U.gvol.value = s.gvol; U.restart.value = s.restart;
    for(const el of [U.speed, U.bpm, U.gvol]) el.parentElement.hidden = mod;
    U.lin.checked = !!s.linear; U.lin.parentElement.hidden = !xm;
    const playing = T.pl.playing ? trkShown(T.n).ord : -1;
    U.ords.innerHTML = s.orders.map((p,i)=>`<div class="trk-ord${i===T.ord?' on':''}${i===playing?' pl':''}" data-o="${i}"><span>${modHex(i,2)}</span><b>${modHex(p,2)}</b></div>`).join('');
    P.plOrd = playing;
    U.ords.querySelector('.on')?.scrollIntoView({block:'nearest'});
  };
  P.draw = ()=>{                                    // играющая позиция — без перестройки списка
    const pos = T.pl.playing ? trkShown(T.n).ord : -1;
    if(P.plOrd===pos) return; P.plOrd = pos;
    U.ords.querySelectorAll('.trk-ord').forEach(e=>e.classList.toggle('pl', +e.dataset.o===pos));
  };
};

/* ---------- список инструментов ---------- */
TRK_PANELS.ins = P=>{
  const T = P.T;
  P.el.innerHTML = `<div class="trk-slist"></div>`;
  const box = P.U.list = P.el.querySelector('.trk-slist');
  box.addEventListener('click', ev=>{
    const e = ev.target.closest('[data-i]'); if(!e) return;
    if(e.dataset.i==='add'){ trkAddIns(T); return; }
    T.inst = +e.dataset.i; T.smp = 0; T.envPt = 0; trkRefresh(T);
  });
  P.refresh = ()=>{
    const s = T.song, list = s.instruments || s.samples;
    T.inst = clamp(T.inst, 1, Math.max(1, list.length));
    let h = '';
    list.forEach((x,i)=>{
      const len = s.instruments ? x.samples.reduce((a,y)=>a+y.data.length,0) : x.data.length, ext = trkIsExt(T.pl, i+1);
      h += `<div class="trk-si${i+1===T.inst?' on':''}${len||ext?'':' empty'}" data-i="${i+1}"><span>${trkInstName(s,i+1)}</span>`+
           `<span class="trk-sn">${escapeHtml(x.name||'')}</span><span>${ext ? '⇢ module' : len||''}</span></div>`;
    });
    if(s.instruments || s.fmt==='s3m') h += `<div class="trk-si trk-add" data-i="add">＋ ${s.instruments?'instrument':'sample'}</div>`;
    box.innerHTML = h;
    box.querySelector('.on')?.scrollIntoView({block:'nearest'});
  };
};

/* ---------- семпл и инструмент ---------- */
TRK_PANELS.smp = P=>{
  const T = P.T;
  P.el.innerHTML = `
    <div class="trk-xi">
      <input class="aed-name trk-iname" type="text" spellcheck="false" maxlength="22" placeholder="instrument name">
      <div class="aed-row trk-wrap"><span class="trk-lab">samples</span><span class="trk-xs"></span>${trkBtn('xsadd','+','Add a sample to the instrument')}${trkBtn('xsdel','−','Remove this sample from the instrument')}</div>
      <div class="trk-lab">note map — tap keys to give them this sample</div>
      <canvas class="trk-map"></canvas>
      ${trkBtn('mapall','all notes → this sample','Map every note to the selected sample')}
    </div>
    <div class="trk-sed">
      <input class="aed-name trk-sname" type="text" spellcheck="false" maxlength="28" placeholder="sample name">
      <canvas class="trk-wave"></canvas>
      <div class="trk-grid">
        ${trkNum('trk-svol','volume',0,64)}
        <label class="trk-f-pan">panning<input type="number" class="trk-span" min="0" max="255"></label>
        <label class="trk-f-ft">finetune<input type="number" class="trk-sft"></label>
        <label class="trk-f-rel">relative note<input type="number" class="trk-srel" min="-96" max="95"></label>
        <label class="trk-f-c2">C-4 rate, Hz<input type="number" class="trk-sc2" min="1000" max="192000"></label>
        <label>loop<select class="trk-sloop"><option value="0">off</option><option value="1">forward</option><option value="2">ping-pong</option></select></label>
        ${trkNum('trk-sls','loop start',0,1e7)}
        ${trkNum('trk-sll','loop length',0,1e7)}
      </div>
      <div class="aed-row trk-wrap">
        ${trkBtn('splay','▶','Play the sample on the cursor channel')}
        ${trkBtn('sload','load','Load an audio file into this slot')}
        <select class="trk-lib aed-b" title="Take a clip from the Sample Library"><option value="">library…</option></select>
        ${trkBtn('sedit','✎ edit','Open in the sample editor')}
        ${trkBtn('swav','⭳ wav','Download as WAV')}
        ${trkBtn('sclear','clear','Empty this slot')}
        <span class="trk-sinfo"></span>
      </div>
    </div>
    <div class="trk-xe">
      <div class="aed-row trk-wrap">
        <button class="aed-b trk-envt" data-a="envv">volume env</button><button class="aed-b trk-envt" data-a="envp">panning env</button>
        ${trkBtn('envon','on','Envelope on/off')}${trkBtn('envsus','sus','Sustain at the selected point')}
        ${trkBtn('envls','loop ⟦','Loop start at the selected point')}${trkBtn('envle','⟧','Loop end at the selected point')}
        ${trkBtn('envdel','del pt','Delete the selected point')}
      </div>
      <canvas class="trk-env"></canvas>
      <div class="trk-grid">
        ${trkNum('trk-fade','fadeout',0,4095)}
        <label>auto-vibrato<select class="trk-avt"><option value="0">sine</option><option value="1">square</option><option value="2">ramp down</option><option value="3">ramp up</option></select></label>
        ${trkNum('trk-avs','vib sweep',0,255)}${trkNum('trk-avd','vib depth',0,15)}${trkNum('trk-avr','vib rate',0,63)}
      </div>
    </div>
    <div class="trk-extnote">This instrument is played by a <b>Tracker Instrument</b> node — its notes go to the graph, samples are not used.</div>`;
  const q = s=>P.el.querySelector(s), U = P.U;
  Object.assign(U, {xi:q('.trk-xi'), iname:q('.trk-iname'), xs:q('.trk-xs'), map:q('.trk-map'), sname:q('.trk-sname'), wave:q('.trk-wave'),
    svol:q('.trk-svol'), span:q('.trk-span'), sft:q('.trk-sft'), srel:q('.trk-srel'), sc2:q('.trk-sc2'), sloop:q('.trk-sloop'),
    sls:q('.trk-sls'), sll:q('.trk-sll'), sinfo:q('.trk-sinfo'), lib:q('.trk-lib'), xe:q('.trk-xe'), env:q('.trk-env'),
    fade:q('.trk-fade'), avt:q('.trk-avt'), avs:q('.trk-avs'), avd:q('.trk-avd'), avr:q('.trk-avr'), extnote:q('.trk-extnote')});
  const smpField = (el, fn)=>el.addEventListener('change', ()=>{ const s=trkCurSmp(T); if(!s) return; trkChange(T, ()=>{ fn(s, +el.value); trkFixLoop(s); }); trkRefresh(T); });
  U.sname.addEventListener('input', ()=>{ const s=trkCurSmp(T); if(!s) return; trkChange(T, ()=>{ s.name = U.sname.value; }, 'sname'+T.inst+':'+T.smp); trkRefresh(T,'ins'); });
  smpField(U.svol, (s,v)=>{ s.vol = clamp(v|0,0,64); });
  smpField(U.span, (s,v)=>{ s.pan = clamp(v|0,0,255); });
  smpField(U.sft, (s,v)=>{ s.ft = T.song.fmt==='mod' ? clamp(v|0,-8,7) : clamp(v|0,-128,127); });
  smpField(U.srel, (s,v)=>{ s.rel = clamp(v|0,-96,95); });
  smpField(U.sc2, (s,v)=>{ s.c2spd = clamp(v|0,1000,192000); });
  smpField(U.sloop, (s,v)=>{ s.loop = v; if(v && s.ll<2){ s.ls = 0; s.ll = s.data.length; } });
  smpField(U.sls, (s,v)=>{ const end = s.ls+s.ll; s.ls = clamp(v|0,0,Math.max(0,s.data.length-2)); s.ll = Math.max(2, end-s.ls); if(!s.loop) s.loop = 1; });
  smpField(U.sll, (s,v)=>{ s.ll = clamp(v|0,0,s.data.length-s.ls); if(!s.loop && s.ll>=2) s.loop = 1; });
  U.iname.addEventListener('input', ()=>{ const i=trkCurIns(T); if(!i) return; trkChange(T, ()=>{ i.name = U.iname.value; }, 'iname'+T.inst); trkRefresh(T,'ins'); });
  const insNum = (el, fn)=>el.addEventListener('change', ()=>{ const i=trkCurIns(T); if(!i) return; trkChange(T, ()=>fn(i, +el.value|0)); trkRefresh(T); });
  insNum(U.fade, (i,v)=>{ i.fade = clamp(v,0,4095); });
  insNum(U.avt, (i,v)=>{ i.vib.type = clamp(v,0,3); });
  insNum(U.avs, (i,v)=>{ i.vib.sweep = clamp(v,0,255); });
  insNum(U.avd, (i,v)=>{ i.vib.depth = clamp(v,0,15); });
  insNum(U.avr, (i,v)=>{ i.vib.rate = clamp(v,0,63); });
  U.lib.addEventListener('pointerdown', ()=>trkLibOptions(U.lib));
  U.lib.addEventListener('focus', ()=>trkLibOptions(U.lib));
  U.lib.addEventListener('change', ()=>{ const id = +U.lib.value; U.lib.value = ''; if(id) trkFromLibrary(T, id); });
  trkResizeWatch(P, [U.wave, U.map, U.env]);
  trkBindWave(P); trkBindMap(P); trkBindEnv(P);
  P.refresh = ()=>{
    const song = T.song, s = trkCurSmp(T), xm = song.fmt==='xm', ins = trkCurIns(T);
    U.xi.hidden = !xm; U.xe.hidden = !xm;
    U.extnote.hidden = !trkIsExt(T.pl, T.inst);
    P.el.querySelector('.trk-f-pan').hidden = !xm;
    P.el.querySelector('.trk-f-rel').hidden = !xm;
    P.el.querySelector('.trk-f-ft').hidden = song.fmt==='s3m';
    P.el.querySelector('.trk-f-c2').hidden = song.fmt!=='s3m';
    U.sloop.querySelector('[value="2"]').hidden = !xm;
    if(ins){
      if(document.activeElement!==U.iname) U.iname.value = ins.name;
      U.xs.innerHTML = ins.samples.map((x,i)=>`<button class="aed-b${i===T.smp?' on':''}" data-a="xsel" data-v="${i}" title="${escapeHtml(x.name)}">${i}</button>`).join('');
      U.fade.value = ins.fade; U.avt.value = ins.vib.type; U.avs.value = ins.vib.sweep; U.avd.value = ins.vib.depth; U.avr.value = ins.vib.rate;
      const e = T.env==='v' ? ins.venv : ins.penv;
      P.el.querySelectorAll('.trk-envt').forEach(b=>b.classList.toggle('on', b.dataset.a==='env'+T.env));
      P.el.querySelector('[data-a=envon]').classList.toggle('on', e.on);
      P.el.querySelector('[data-a=envsus]').classList.toggle('on', e.sus);
      P.el.querySelector('[data-a=envls]').classList.toggle('on', e.loop);
    }
    if(!s) return;
    if(document.activeElement!==U.sname) U.sname.value = s.name;
    U.svol.value = s.vol; U.span.value = s.pan<0 ? 128 : s.pan; U.sft.value = s.ft; U.srel.value = s.rel; U.sc2.value = s.c2spd;
    U.sft.min = song.fmt==='mod' ? -8 : -128; U.sft.max = song.fmt==='mod' ? 7 : 127;
    U.sloop.value = s.loop; U.sls.value = s.ls; U.sll.value = s.ll;
    const rate = trkSmpRate(song, s), bits = s.data instanceof Int16Array ? 16 : 8;
    U.sinfo.textContent = s.data.length+' samples, '+bits+' bit' + (s.data.length ? ' · '+(s.data.length/rate).toFixed(2)+' s at '+trkNoteName(song, 49+(song.fmt==='mod'?12:0)) : '');
  };
  P.draw = ()=>{ trkWave(P); trkMap(P); trkEnv(P); };
};
async function trkLibOptions(sel){              // клипы Sample Library по всем папкам
  if(sel._busy) return; sel._busy = true;
  try{
    const out = [], walk = async (fid, path)=>{
      for(const c of await SampleDB.listClips(fid)) out.push({id:c.id, name:path+c.name});
      for(const f of await SampleDB.listFolders(fid)) await walk(f.id, path+f.name+'/');
    };
    await walk(null, '');
    sel.innerHTML = '<option value="">library…</option>' + (out.length ? out.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') : '<option value="" disabled>(the Sample Library is empty)</option>');
  }catch(e){ console.warn(e); }
  sel._busy = false;
}
async function trkFromLibrary(T, id){
  const clip = await SampleDB.getClip(id); if(!clip) return;
  trkPutAudio(T, clip.samples, clip.sr, clip.name);
}
function trkWave(P){
  const T = P.T, c = trkCanvas(P.U.wave); if(!c) return;
  const {g, W, H} = c, s = trkCurSmp(T);
  g.fillStyle = themeColor('--grid'); g.fillRect(0, H/2, W, 1);
  if(!s || !s.data.length){ g.fillStyle = themeColor('--axis'); g.font = '11px '+themeColor('--mono'); g.fillText('empty — load, pick from the library or drop an audio file', 8, H/2-6); return; }
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
function trkBindWave(P){                       // перетаскивание краёв петли; с нуля — протянуть по волне
  const T = P.T, cv = P.U.wave;
  let drag = null;
  const at = ev=>{ const r = cv.getBoundingClientRect(), s = trkCurSmp(T); return clamp((ev.clientX-r.left)/r.width,0,1)*s.data.length; };
  cv.addEventListener('pointerdown', ev=>{
    ev.stopPropagation();
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
    T.song.rev++; trkSaveSoon(T.n); trkRefresh(T,'smp');
  });
  const end = ()=>{ if(drag){ const s = trkCurSmp(T); if(s) trkFixLoop(s); drag = null; trkRefresh(T,'smp'); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
// карта нот инструмента XM: 96 клавиш, цвет — номер семпла
function trkMap(P){
  const T = P.T, ins = trkCurIns(T); if(!ins || P.U.xi.hidden) return;
  const c = trkCanvas(P.U.map); if(!c) return;
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
function trkBindMap(P){
  const T = P.T, cv = P.U.map; let on = false;
  const set = ev=>{
    const ins = trkCurIns(T); if(!ins) return;
    const r = cv.getBoundingClientRect(), i = clamp(Math.floor((ev.clientX-r.left)/r.width*96),0,95);
    if(ins.map[i]===T.smp) return;
    if(!on.snap){ T.undo.push(trkCloneSong(T.song, true)); T.redo.length = 0; on.snap = true; }
    ins.map[i] = T.smp; T.song.rev++; trkSaveSoon(T.n); trkMap(P);
  };
  cv.addEventListener('pointerdown', ev=>{ ev.stopPropagation(); on = {snap:false}; cv.setPointerCapture(ev.pointerId); set(ev); });
  cv.addEventListener('pointermove', ev=>{ if(on) set(ev); });
  const end = ()=>{ on = false; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
// огибающая XM: точки [тик, 0..64]; тянуть — двигать, двойной клик — новая точка
function trkEnvGeom(e, W, H){ const tmax = Math.max(64, e.pts[e.pts.length-1][0]+16); return {tx:t=>t/tmax*W, ty:v=>H-4-v/64*(H-8), tmax}; }
function trkEnv(P){
  const T = P.T, ins = trkCurIns(T); if(!ins || P.U.xe.hidden) return;
  const c = trkCanvas(P.U.env); if(!c) return;
  const {g, W, H} = c, e = T.env==='v' ? ins.venv : ins.penv, {tx, ty} = trkEnvGeom(e, W, H);
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
function trkBindEnv(P){
  const T = P.T, cv = P.U.env; let drag = null;
  const hit = ev=>{
    const ins = trkCurIns(T); if(!ins) return null;
    const e = T.env==='v' ? ins.venv : ins.penv, r = cv.getBoundingClientRect(), G = trkEnvGeom(e, r.width, r.height);
    const x = ev.clientX-r.left, y = ev.clientY-r.top;
    let k = -1, bd = 14;
    e.pts.forEach((p,i)=>{ const d = Math.hypot(G.tx(p[0])-x, G.ty(p[1])-y); if(d<bd){ bd = d; k = i; } });
    return {e, k, t:Math.round(x/r.width*G.tmax), v:clamp(Math.round((r.height-4-y)/(r.height-8)*64),0,64)};
  };
  cv.addEventListener('pointerdown', ev=>{
    ev.stopPropagation();
    const h = hit(ev); if(!h || h.k<0) return;
    T.envPt = h.k; drag = {k:h.k, first:true}; cv.setPointerCapture(ev.pointerId); trkRefresh(T,'smp');
  });
  cv.addEventListener('pointermove', ev=>{
    if(!drag) return;
    const h = hit(ev), E = h.e.pts, k = drag.k;
    if(drag.first){ T.undo.push(trkCloneSong(T.song, true)); T.redo.length = 0; drag.first = false; }
    E[k][0] = k===0 ? 0 : clamp(h.t, E[k-1][0]+1, k<E.length-1 ? E[k+1][0]-1 : 0xFFFF);
    E[k][1] = h.v;
    T.song.rev++; trkSaveSoon(T.n); trkEnv(P);
  });
  const end = ()=>{ drag = null; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', ev=>{
    const h = hit(ev); if(!h || h.k>=0 || h.e.pts.length>=12) return;
    const E = h.e.pts; let i = E.findIndex(p=>p[0]>h.t); if(i<0) i = E.length; if(i===0) return;
    trkChange(T, ()=>{ E.splice(i, 0, [h.t, h.v]); for(const f of ['s','ls','le']) if(h.e[f]>=i) h.e[f]++; });
    T.envPt = i; trkRefresh(T,'smp');
  });
}

/* ---------- экранные клавиши ---------- */
TRK_PANELS.keys = P=>{
  const T = P.T, keys = [];
  for(let o=0;o<2;o++) for(let k=0;k<12;k++){
    const nm = MOD_NN[k].replace('-','');
    keys.push(`<button class="trk-pk${[1,3,6,8,10].includes(k)?' blk':''}" data-a="note" data-v="${o*12+k}">${o ? nm.toLowerCase() : nm}</button>`);
  }
  P.el.innerHTML = `
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
    </div>`;
  P.refresh = ()=>{
    const mod = T.song.fmt==='mod';
    P.el.querySelector('.trk-letters').hidden = mod;
    P.el.querySelector('.trk-offk').hidden = mod;
  };
  P.draw = ()=>{ P.el.querySelector('[data-a=mark]').classList.toggle('on', !!T.anchor); };
};

/* ---------- микшер каналов ---------- */
TRK_PANELS.mix = P=>{
  const T = P.T;
  P.el.innerHTML = `<div class="trk-mix"></div>`;
  const box = P.U.box = P.el.querySelector('.trk-mix');
  box.addEventListener('click', ev=>{
    const b = ev.target.closest('[data-m]'); if(!b) return;
    const k = +b.dataset.k, c = T.pl.chn[k]; if(!c) return;
    if(b.dataset.m==='mute') c.mute = !c.mute;
    else T.pl.solo = T.pl.solo===k ? -1 : k;
    P.refresh();
  });
  box.addEventListener('input', ev=>{
    const el = ev.target, k = +el.dataset.k, s = T.song;
    if(el.dataset.f==='pan'){ s.chPan[k] = +el.value; T.pl.chn[k].pan = +el.value; }
    else { trkFixChVol(s); s.chVol[k] = +el.value/100; }
    trkSaveSoon(T.n);
  });
  P.refresh = ()=>{
    const s = T.song, pl = T.pl; trkFixChVol(s);
    box.innerHTML = pl.chn.map((c,k)=>`<div class="trk-strip">
        <b>${k+1}</b><i class="trk-vu"><i></i></i>
        <input type="range" min="0" max="100" value="${Math.round((s.chVol[k]??1)*100)}" data-k="${k}" data-f="vol" title="Volume" orient="vertical">
        <input type="range" min="0" max="255" value="${s.chPan[k]??128}" data-k="${k}" data-f="pan" title="Panning">
        <button class="aed-b${c.mute?' on':''}" data-m="mute" data-k="${k}" title="Mute">M</button>
        <button class="aed-b${pl.solo===k?' on':''}" data-m="solo" data-k="${k}" title="Solo">S</button>
      </div>`).join('');
    P.vus = [...box.querySelectorAll('.trk-vu>i')];
  };
  P.draw = ()=>{
    if(!P.vus || P.vus.length!==T.pl.chn.length) P.refresh();
    T.pl.chn.forEach((c,k)=>{ const v = P.vus[k]; if(v) v.style.height = Math.round(clamp(c.vu,0,1)*100)+'%'; });
  };
};

/* ---------- полноэкранный редактор: все панели в одном окне ---------- */
function trkOpen(n){
  const T = trkSession(n);
  if(T.full) return T;
  const root = document.createElement('div');
  root.className = 'trk';
  root.innerHTML = `
    <div class="trk-top"><button class="aed-b trk-close" title="Close (Esc)">✕</button></div>
    <div class="trk-body">
      <div class="trk-center"></div>
      <div class="trk-side">
        <div class="trk-tabs">
          <button class="trk-tab" data-tab="song">Song</button>
          <button class="trk-tab trk-tab-smp" data-tab="smp">Samples</button>
          <button class="trk-tab" data-tab="keys">Keys</button>
          <button class="trk-tab" data-tab="mix">Mixer</button>
        </div>
        <div class="trk-pane" data-p="song"></div><div class="trk-pane" data-p="smp"></div>
        <div class="trk-pane" data-p="keys"></div><div class="trk-pane" data-p="mix"></div>
      </div>
    </div>`;
  document.body.append(root);
  const q = s=>root.querySelector(s);
  T.full = {root, tab:'song', panels:[]};
  const add = (kind, where)=>{ const P = trkPanel(T, kind); q(where).append(P.el); T.full.panels.push(P); return P; };
  add('bar', '.trk-top'); add('pat', '.trk-center');
  add('seq', '[data-p=song]'); add('ins', '[data-p=smp]'); add('smp', '[data-p=smp]');
  add('keys', '[data-p=keys]'); add('mix', '[data-p=mix]');
  q('.trk-close').addEventListener('click', ()=>trkClose(T));
  root.addEventListener('pointerdown', ()=>{ TRK_FOCUS = T; }, true);
  root.addEventListener('click', ev=>{ const tb = ev.target.closest('.trk-tab'); if(tb){ T.full.tab = tb.dataset.tab; trkFullTabs(T); } });
  root.addEventListener('dragover', ev=>ev.preventDefault());
  root.addEventListener('drop', ev=>{
    ev.preventDefault();
    const f = ev.dataTransfer.files?.[0]; if(!f) return;
    if(/\.(mod|s3m|xm|nst|m15|stk)$/i.test(f.name)) trkLoadFile(n, f);
    else trkImportSample(T, f);
  });
  TRK_FOCUS = T;
  trkFullTabs(T);
  trkRefresh(T);
  return T;
}
function trkFullTabs(T){
  const F = T.full; if(!F) return;
  F.root.querySelectorAll('.trk-tab').forEach(b=>b.classList.toggle('on', b.dataset.tab===F.tab));
  F.root.querySelectorAll('.trk-pane').forEach(p=>p.classList.toggle('on', p.dataset.p===F.tab));
  F.root.querySelector('.trk-tab-smp').textContent = T.song.instruments ? 'Instruments' : 'Samples';
  trkDraw(T);
}
function trkClose(T, force){
  if(!T.full || (T.sub && !force)) return;
  if(T.sub){ try{ aedClose(T.sub); }catch(e){} T.sub = null; }
  for(const P of T.full.panels) trkPanelDetach(P);
  T.full.root.remove(); T.full = null;
  if(TRK_FOCUS===T) TRK_FOCUS = null;
  if(T.n.saveT) trkSave(T.n);
  redraw(T.n);
}
