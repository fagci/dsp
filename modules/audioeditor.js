/* ============================ АУДИОРЕДАКТОР КЛИПОВ ============================ */
// Полноэкранный редактор клипа из SampleDB (моно Float32Array). Открывается из библиотеки семплов.
// Правки не мутируют массив: каждая операция строит новый, прежний уходит в стек отмены по ссылке.
// Исключение — карандаш: снимок берётся на pointerdown, дальше рисуем в копии.
// Вид: x0 — семпл у левого края, spp — семплов на CSS-пиксель, vz — вертикальное увеличение.
// Семпл i занимает ячейку [i, i+1) по оси времени, границы выделения — между семплами.

const AED_MAX_PX = 64;            // пикселей на семпл при максимальном увеличении
const AED_UNDO_BYTES = 300e6;     // потолок памяти стека отмены
const AED_PYR = 256;              // размер корзины min/max-пирамиды для дальнего масштаба
let AedClip = null;               // буфер обмена {s, sr}, общий для всех клипов
let AedProfile = null;            // профиль шума {sr, N, pow, dur}
const AedSpecCfg = { fft:2048, log:false, floor:-110, ceil:-20, pal:'default' };
const AedNrCfg = { red:18, sens:6, fsm:3, tsm:80, residue:false };

function aedOpen(clip, opts={}){
  const E = {
    clip, opts, sr:clip.sr, s:clip.samples, name:clip.name,
    undo:[], redo:[], undoBytes:0, dirty:false, ver:0,
    x0:0, spp:1, vz:1,
    a:0, b:0,                     // выделение; a===b — просто курсор
    tool:'sel', view:'wave',      // view: wave | both | spec
    loop:false, ctx:null, src:null, playing:false, ab:null, abVer:-1,
    ptr:new Map(), g:null,        // активные указатели и текущий жест
    spec:null, specJob:null, specTimer:0,
    hover:null, raf:0, msg:'', msgT:0,
  };
  aedBuildUI(E);
  aedRebuildPyr(E);
  aedFit(E);
  aedDraw(E);
  return E;
}

/* ---------- UI ---------- */
function aedBuildUI(E){
  const root = document.createElement('div');
  root.className = 'aed';
  root.innerHTML = `
    <div class="aed-head">
      <button class="aed-b" data-a="close" title="Close (Esc)">✕</button>
      <input class="aed-name" type="text" spellcheck="false">
      <span class="aed-info"></span>
      <button class="aed-b" data-a="saveas" title="Save as a new clip">＋copy</button>
      <button class="aed-b aed-pri" data-a="save" title="Save (Ctrl+S)">💾 save</button>
    </div>
    <canvas class="aed-over"></canvas>
    <div class="aed-main"><canvas class="aed-cv"></canvas></div>
    <div class="aed-stat"><span class="aed-sel"></span><span class="aed-hov"></span></div>
    <div class="aed-sheet" data-s="nr">
      <div class="aed-row">
        <button class="aed-b" data-a="nrprof" title="Take the noise model from the selection (a piece with noise only)">① noise profile ← selection</button>
        <span class="aed-nrinfo"></span>
      </div>
      <div class="aed-grid">
        <label>reduction, dB<input type="range" data-k="red" min="0" max="48" step="1"><b></b></label>
        <label>sensitivity, dB<input type="range" data-k="sens" min="0" max="24" step="0.5"><b></b></label>
        <label>freq smoothing, bins<input type="range" data-k="fsm" min="0" max="12" step="1"><b></b></label>
        <label>time smoothing, ms<input type="range" data-k="tsm" min="0" max="500" step="10"><b></b></label>
      </div>
      <div class="aed-row">
        <label class="aed-chk"><input type="checkbox" data-k="residue"> residue (hear what is removed)</label>
        <span class="aed-sp"></span>
        <button class="aed-b" data-a="nrprev" title="Listen without changing the clip">▶ preview</button>
        <button class="aed-b aed-pri" data-a="nrapply" title="Apply to the selection (or the whole clip)">② apply</button>
      </div>
    </div>
    <div class="aed-sheet" data-s="spec">
      <div class="aed-grid">
        <label>FFT<select data-k="fft">${[256,512,1024,2048,4096,8192].map(v=>`<option>${v}</option>`).join('')}</select></label>
        <label>scale<select data-k="log"><option value="0">linear</option><option value="1">log</option></select></label>
        <label>palette<select data-k="pal">${['default',...Object.keys(typeof PALETTES==='object'?PALETTES:{})].map(v=>`<option>${v}</option>`).join('')}</select></label>
        <label>floor, dB<input type="range" data-k="floor" min="-160" max="-40" step="1"><b></b></label>
        <label>ceiling, dB<input type="range" data-k="ceil" min="-80" max="0" step="1"><b></b></label>
      </div>
      <div class="aed-row"><button class="aed-b" data-a="specauto" title="Fit the dB range to the clip">auto range</button></div>
    </div>
    <div class="aed-bar">
      <div class="aed-row aed-tr">
        <button class="aed-b" data-a="home" title="To start (Home)">⏮</button>
        <button class="aed-b aed-play" data-a="play" title="Play selection / from cursor (Space)">▶</button>
        <button class="aed-b" data-a="stop" title="Stop">⏹</button>
        <button class="aed-b" data-a="loop" title="Loop (L)">🔁</button>
        <button class="aed-b" data-a="undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="aed-b" data-a="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        <button class="aed-b" data-a="zin" title="Zoom in (+)">＋</button>
        <button class="aed-b" data-a="zout" title="Zoom out (−)">－</button>
        <button class="aed-b" data-a="zsel" title="Zoom to selection">[ ]</button>
        <button class="aed-b" data-a="zfit" title="Fit whole clip (0)">⤢</button>
      </div>
      <div class="aed-row aed-ed">
        <button class="aed-b" data-a="all" title="Select all (Ctrl+A)">all</button>
        <button class="aed-b" data-a="crop" title="Trim to selection (T)">crop</button>
        <button class="aed-b" data-a="del" title="Delete selection (Del)">delete</button>
        <button class="aed-b" data-a="cut" title="Cut (Ctrl+X)">cut</button>
        <button class="aed-b" data-a="copy" title="Copy (Ctrl+C)">copy</button>
        <button class="aed-b" data-a="paste" title="Paste at cursor / over selection (Ctrl+V)">paste</button>
        <button class="aed-b" data-a="silence" title="Silence selection">silence</button>
        <button class="aed-b" data-a="fadein" title="Fade in selection">fade in</button>
        <button class="aed-b" data-a="fadeout" title="Fade out selection">fade out</button>
        <button class="aed-b" data-a="norm" title="Normalize peak to −1 dBFS and remove DC">normalize</button>
        <button class="aed-b" data-a="gain" title="Amplify by dB">gain</button>
        <button class="aed-b" data-a="rev" title="Reverse">reverse</button>
        <button class="aed-b" data-a="draw" title="Pencil: draw samples (zoom in until single samples are visible)">✏ draw</button>
        <button class="aed-b" data-a="vzin" title="Amplitude zoom in">↕＋</button>
        <button class="aed-b" data-a="vzout" title="Amplitude zoom out">↕－</button>
        <button class="aed-b" data-a="view" title="Waveform / waveform+spectrogram / spectrogram (S)">〰</button>
        <button class="aed-b" data-a="specset" title="Spectrogram settings">⚙ spec</button>
        <button class="aed-b" data-a="nr" title="Noise reduction by profile">noise</button>
        <button class="aed-b" data-a="wav" title="Download WAV">⭳ wav</button>
      </div>
    </div>`;
  document.body.append(root);
  const q = s => root.querySelector(s);
  E.ui = { root, cv:q('.aed-cv'), main:q('.aed-main'), over:q('.aed-over'), name:q('.aed-name'),
    info:q('.aed-info'), sel:q('.aed-sel'), hov:q('.aed-hov'), nrinfo:q('.aed-nrinfo'),
    sheets:{ nr:q('[data-s=nr]'), spec:q('[data-s=spec]') } };
  E.ui.name.value = E.name;
  E.ui.name.addEventListener('input', ()=>{ E.name = E.ui.name.value; E.dirty = true; aedStatus(E); });

  root.addEventListener('click', ev=>{
    const b = ev.target.closest('[data-a]');
    if(b){ b.blur(); aedAction(E, b.dataset.a); }   // blur — чтобы пробел не нажимал кнопку повторно
  });
  aedBindCfg(E.ui.sheets.nr, AedNrCfg, ()=>{});
  aedBindCfg(E.ui.sheets.spec, AedSpecCfg, ()=>{ aedSpecSchedule(E, 0); });

  E.onKey = ev=>aedKey(E, ev);
  window.addEventListener('keydown', E.onKey, true);   // capture: горячие клавиши графа не должны срабатывать под редактором
  E.ro = new ResizeObserver(()=>{ aedClampView(E); aedDraw(E); });
  E.ro.observe(E.ui.main);
  aedBindPointer(E);
  aedBindOverview(E);
  aedNrInfo(E);
}

// Привязка полей листа настроек к объекту cfg: data-k — ключ, <b> рядом — значение.
function aedBindCfg(box, cfg, onChange){
  box.querySelectorAll('[data-k]').forEach(el=>{
    const k = el.dataset.k, lab = el.parentElement.querySelector('b');
    const show = ()=>{ if(lab) lab.textContent = cfg[k]; };
    el.sync = ()=>{
      if(el.type==='checkbox') el.checked = !!cfg[k];
      else if(k==='log') el.value = cfg[k]?'1':'0';
      else el.value = cfg[k];
      show();
    };
    el.sync();
    el.addEventListener('input', ()=>{
      cfg[k] = el.type==='checkbox' ? el.checked : k==='log' ? el.value==='1' : k==='pal' ? el.value : +el.value;
      show(); onChange();
    });
  });
}

function aedToggleSheet(E, name){
  for(const [k,el] of Object.entries(E.ui.sheets)) el.classList.toggle('on', k===name && !el.classList.contains('on'));
  aedDraw(E);
}

function aedAction(E, a){
  const len = E.s.length, hasSel = E.b>E.a;
  switch(a){
    case 'close': return aedClose(E);
    case 'save': return aedSave(E, false);
    case 'saveas': return aedSave(E, true);
    case 'home': E.a=E.b=0; E.x0=0; aedClampView(E); if(E.playing) aedPlay(E); break;
    case 'play': E.playing ? aedStop(E) : aedPlay(E); break;
    case 'stop': aedStop(E); break;
    case 'loop': E.loop=!E.loop; if(E.playing) aedPlay(E, aedPlayPos(E)); break;
    case 'undo': aedUndo(E); break;
    case 'redo': aedRedo(E); break;
    case 'zin': aedZoom(E, 1/2, aedFocusX(E)); break;
    case 'zout': aedZoom(E, 2, aedFocusX(E)); break;
    case 'zfit': aedFit(E); break;
    case 'zsel': if(hasSel){ const W=aedW(E); E.spp=(E.b-E.a)/W*1.1; E.x0=E.a-(E.b-E.a)*0.05; aedClampView(E); } break;
    case 'all': E.a=0; E.b=len; break;
    case 'crop': if(hasSel) aedEdit(E,'crop', E.s.slice(E.a,E.b), 0, E.b-E.a); break;
    case 'del': if(hasSel) aedDelete(E,'delete'); break;
    case 'cut': if(hasSel){ AedClip={s:E.s.slice(E.a,E.b), sr:E.sr}; aedDelete(E,'cut'); } break;
    case 'copy': if(hasSel){ AedClip={s:E.s.slice(E.a,E.b), sr:E.sr}; aedMsg(E,'copied '+aedFmtT(E,(E.b-E.a))); } break;
    case 'paste': aedPaste(E); break;
    case 'silence': if(hasSel) aedMap(E,'silence', ()=>0); break;
    case 'fadein': if(hasSel){ const n=E.b-E.a; aedMap(E,'fade in', (v,i)=>v*(i/n)); } break;
    case 'fadeout': if(hasSel){ const n=E.b-E.a; aedMap(E,'fade out', (v,i)=>v*(1-(i+1)/n)); } break;
    case 'norm': aedNormalize(E); break;
    case 'gain': {
      const r = prompt('Gain, dB (negative — quieter):', '6');
      const db = parseFloat(r); if(!isFinite(db)) break;
      const k = Math.pow(10, db/20); aedMap(E,'gain '+db+' dB', v=>v*k, !hasSel); break;
    }
    case 'rev': {
      const [a,b] = hasSel?[E.a,E.b]:[0,len];
      const out = E.s.slice(); for(let i=a,j=b-1;i<b;i++,j--) out[i]=E.s[j];
      aedEdit(E,'reverse', out, E.a, E.b); break;
    }
    case 'draw': E.tool = E.tool==='draw'?'sel':'draw';
      if(E.tool==='draw' && E.spp>1) aedMsg(E,'zoom in until single samples are visible to draw');
      break;
    case 'vzin': E.vz = Math.min(E.vz*2, 65536); break;
    case 'vzout': E.vz = Math.max(E.vz/2, 1); break;
    case 'view': E.view = {wave:'both', both:'spec', spec:'wave'}[E.view]; aedSpecFirst(E); aedSpecSchedule(E,0); break;
    case 'specset': aedToggleSheet(E,'spec'); if(E.view==='wave'){ E.view='both'; aedSpecFirst(E); aedSpecSchedule(E,0); } break;
    case 'specauto': aedSpecAuto(E); aedSpecSchedule(E,0); break;
    case 'nr': aedToggleSheet(E,'nr'); break;
    case 'nrprof': aedNrProfile(E); break;
    case 'nrprev': aedNrPreview(E); break;
    case 'nrapply': aedNrApply(E); break;
    case 'wav': aedDownloadWav(E); break;
  }
  aedDraw(E);
}

function aedKey(E, ev){
  const t = ev.target;
  const typing = t && (t.tagName==='INPUT' && t.type==='text' || t.tagName==='TEXTAREA');
  ev.stopPropagation();                  // под оверлеем граф клавиш не видит
  if(typing){ if(ev.key==='Escape') t.blur(); return; }
  const mod = ev.ctrlKey||ev.metaKey, k = (ev.key||'').toLowerCase();
  const map = mod ? { z: ev.shiftKey?'redo':'undo', y:'redo', a:'all', x:'cut', c:'copy', v:'paste', s:'save' }
                  : { ' ':'play', l:'loop', t:'crop', delete:'del', backspace:'del', home:'home', '+':'zin', '=':'zin',
                      '-':'zout', '0':'zfit', s:'view', escape:'close' };
  if(!mod && k==='end'){ ev.preventDefault(); E.a=E.b=E.s.length; aedShow(E, E.a); aedDraw(E); return; }
  if(!mod && (k==='arrowleft'||k==='arrowright')){
    ev.preventDefault();
    const d = Math.max(1, Math.round(E.spp*(ev.shiftKey?1:20))) * (k==='arrowleft'?-1:1);
    E.a = E.b = clamp(E.a+d, 0, E.s.length); aedShow(E, E.a); aedDraw(E); return;
  }
  const a = map[k];
  if(a){ ev.preventDefault(); aedAction(E, a); }
}

/* ---------- Геометрия вида ---------- */
function aedW(E){ return Math.max(1, E.ui.main.clientWidth); }
function aedFit(E){ E.spp = Math.max(E.s.length,1)/aedW(E); E.x0 = 0; aedClampView(E); }
function aedClampView(E){
  const W = aedW(E), len = Math.max(E.s.length, 1);
  E.spp = clamp(E.spp, 1/AED_MAX_PX, Math.max(len/W, 1/AED_MAX_PX));
  E.x0 = clamp(E.x0, 0, Math.max(0, len - W*E.spp));
}
function aedZoom(E, k, xCss){
  const at = E.x0 + xCss*E.spp;
  E.spp *= k; aedClampView(E);
  E.x0 = at - xCss*E.spp; aedClampView(E);
  aedSpecSchedule(E);
}
function aedFocusX(E){                    // точка, вокруг которой масштабировать кнопками
  const W = aedW(E), p = E.playing ? aedPlayPos(E) : (E.b>E.a ? (E.a+E.b)/2 : E.a);
  const x = (p-E.x0)/E.spp;
  return x>=0 && x<=W ? x : W/2;
}
function aedShow(E, pos){                 // прокрутить так, чтобы pos был виден
  const W = aedW(E), x = (pos-E.x0)/E.spp;
  if(x<0 || x>W){ E.x0 = pos - W*E.spp*0.1; aedClampView(E); aedSpecSchedule(E); }
}
// Разбиение высоты холста на полосы: линейка, волна, спектрограмма.
function aedLayout(E, H){
  const R = 22, body = H - R;
  if(E.view==='wave') return { R, wy:R, wh:body, sy:H, sh:0 };
  if(E.view==='spec') return { R, wy:R, wh:0, sy:R, sh:body };
  const wh = Math.round(body*0.4);
  return { R, wy:R, wh, sy:R+wh, sh:body-wh };
}

/* ---------- Отрисовка ---------- */
function aedDraw(E){
  if(E.raf) return;
  E.raf = requestAnimationFrame(()=>{ E.raf=0; aedRender(E); if(E.playing || E.g?.auto) aedDraw(E); });
}

function aedRender(E){
  if(!E.ui) return;
  const cv = E.ui.cv, main = E.ui.main, dpr = window.devicePixelRatio||1;
  const W = main.clientWidth, H = main.clientHeight;
  if(!W || !H) return;
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle = themeColor('--screen') || '#0a0d0e'; g.fillRect(0,0,W,H);
  if(E.g?.auto) aedAutoScroll(E);
  const L = aedLayout(E, H);
  if(L.sh>0) aedDrawSpec(E, g, W, L);
  if(L.wh>0) aedDrawWave(E, g, W, L);
  aedDrawRuler(E, g, W, L);

  // выделение, курсор, плейхед
  const xa = (E.a-E.x0)/E.spp, xb = (E.b-E.x0)/E.spp;
  const acc = themeColor('--acc') || '#e0b23c';
  if(E.b>E.a){
    g.fillStyle = 'rgba(224,178,60,.18)'; g.fillRect(xa, L.R, xb-xa, H-L.R);
    g.fillStyle = acc;
    for(const x of [xa,xb]){                       // ручки краёв — треугольники под палец
      g.fillRect(x-0.5, L.R, 1, H-L.R);
      g.beginPath(); g.moveTo(x-8,H); g.lineTo(x+8,H); g.lineTo(x,H-12); g.fill();
      g.beginPath(); g.moveTo(x-7,L.R); g.lineTo(x+7,L.R); g.lineTo(x,L.R+10); g.fill();
    }
  } else {
    g.fillStyle = acc; g.fillRect(xa-0.5, L.R, 1, H-L.R);
  }
  if(E.playing){
    const xp = (aedPlayPos(E)-E.x0)/E.spp;
    g.fillStyle = '#fff'; g.fillRect(xp-1, 0, 2, H);
    if(!E.g && (xp>W || xp<0)){ E.x0 = aedPlayPos(E); aedClampView(E); aedSpecSchedule(E); }
  }
  if(E.hover && E.hover.x>=0){ g.fillStyle='rgba(255,255,255,.25)'; g.fillRect(E.hover.x, L.R, 1, H-L.R); }
  aedDrawOver(E);
  aedStatus(E);
  aedButtons(E);
}

function aedDrawWave(E, g, W, L){
  const s = E.s, len = s.length, cy = L.wy + L.wh/2, amp = L.wh/2*0.95*E.vz;
  g.save(); g.beginPath(); g.rect(0, L.wy, W, L.wh); g.clip();
  g.fillStyle = themeColor('--grid') || '#1e2529';
  g.fillRect(0, Math.round(cy), W, 1);
  if(E.vz>1){                                       // уровни ±0.5 от видимой шкалы
    for(const f of [-0.5,0.5]) g.fillRect(0, Math.round(cy - f*L.wh/2*0.95), W, 1);
  }
  const col = themeColor('--acc2') || '#4ec9b0';
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
  if(E.spp > 1){
    // min/max по колонке; при дальнем масштабе — по пирамиде
    const usePyr = E.pyr && E.spp >= AED_PYR*2;
    g.beginPath();
    for(let x=0;x<W;x++){
      const i0 = Math.floor(E.x0 + x*E.spp), i1 = Math.min(len, Math.floor(E.x0 + (x+1)*E.spp));
      if(i0>=len) break;
      let lo=Infinity, hi=-Infinity;
      if(usePyr){
        const p = E.pyr, b0 = Math.floor(i0/AED_PYR), b1 = Math.max(b0+1, Math.ceil(i1/AED_PYR));
        for(let b=b0;b<b1 && b<p.n;b++){ if(p.lo[b]<lo) lo=p.lo[b]; if(p.hi[b]>hi) hi=p.hi[b]; }
      } else {
        for(let i=i0;i<i1;i++){ const v=s[i]; if(v<lo) lo=v; if(v>hi) hi=v; }
      }
      if(lo===Infinity) continue;
      const y0 = cy - hi*amp, y1 = cy - lo*amp;
      g.rect(x, y0, 1, Math.max(1, y1-y0));
    }
    g.fill();
  } else {
    // отдельные семплы: линия через центры ячеек, точки и стебли при крупном масштабе
    const px = 1/E.spp, i0 = Math.max(0, Math.floor(E.x0)-1), i1 = Math.min(len, Math.ceil(E.x0 + W*E.spp)+1);
    g.beginPath();
    for(let i=i0;i<i1;i++){
      const x = (i+0.5-E.x0)*px, y = cy - s[i]*amp;
      i===i0 ? g.moveTo(x,y) : g.lineTo(x,y);
    }
    g.stroke();
    if(px>=6){
      g.globalAlpha = 0.35; g.beginPath();
      for(let i=i0;i<i1;i++){ const x=(i+0.5-E.x0)*px; g.moveTo(x,cy); g.lineTo(x, cy-s[i]*amp); }
      g.stroke(); g.globalAlpha = 1;
      const r = Math.min(4, px/4);
      for(let i=i0;i<i1;i++){ const x=(i+0.5-E.x0)*px; g.beginPath(); g.arc(x, cy-s[i]*amp, r, 0, 7); g.fill(); }
    }
  }
  g.restore();
  g.fillStyle = themeColor('--axis') || '#6c7a80'; g.font = '10px '+(themeColor('--mono')||'monospace');
  g.fillText(E.vz>1 ? '±'+aedNum(1/E.vz) : '±1', 3, L.wy+11);
}

function aedDrawRuler(E, g, W, L){
  const pxStep = 80, secPerPx = E.spp/E.sr;
  const raw = pxStep*secPerPx;
  const useSmp = raw < 0.0005;                      // при глубоком масштабе — номера семплов
  const unit = useSmp ? 1/E.sr : 1;
  const r = raw/unit, p = Math.pow(10, Math.floor(Math.log10(r)));
  const step = (r/p<=1?1:r/p<=2?2:r/p<=5?5:10)*p*unit;
  g.fillStyle = themeColor('--scr-panel') || '#1d2226'; g.fillRect(0,0,W,L.R);
  g.fillStyle = themeColor('--axis') || '#6c7a80'; g.font = '10px '+(themeColor('--mono')||'monospace');
  const t0 = E.x0/E.sr, t1 = (E.x0+W*E.spp)/E.sr;
  const dec = Math.max(0, -Math.floor(Math.log10(step)+1e-9));
  for(let t=Math.ceil(t0/step)*step; t<=t1; t+=step){
    const x = (t*E.sr-E.x0)/E.spp;
    g.fillRect(Math.round(x), L.R-6, 1, 6);
    const lab = useSmp ? '#'+Math.round(t*E.sr) : aedClock(t, dec);
    g.fillText(lab, x+3, 13);
  }
  g.fillStyle = themeColor('--grid') || '#1e2529'; g.fillRect(0, L.R-1, W, 1);
}

function aedClock(t, dec){
  const m = Math.floor(t/60), s = t - m*60;
  const ss = s.toFixed(Math.min(dec, 6)).padStart(dec>0 ? dec+3 : 2, '0');
  return m ? m+':'+ss : ss;
}
function aedNum(v){ return v>=0.01 ? +v.toPrecision(3)+'' : v.toExponential(1); }
function aedFmtT(E, n){ const t=n/E.sr; return t<1 ? (t*1000).toFixed(t<0.01?2:1)+' ms' : t.toFixed(3)+' s'; }

function aedDrawOver(E){
  const cv = E.ui.over, dpr = window.devicePixelRatio||1, W = cv.clientWidth, H = cv.clientHeight;
  if(!W) return;
  if(cv.width!==Math.round(W*dpr) || cv.height!==Math.round(H*dpr)){ cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr); E.overPk=null; }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  const len = Math.max(1, E.s.length);
  if(!E.overPk || E.overPk.ver!==E.ver || E.overPk.W!==W) E.overPk = { ver:E.ver, W, pk:SampleDB.computePeaks(E.s, W) };
  g.fillStyle = themeColor('--screen') || '#0a0d0e'; g.fillRect(0,0,W,H);
  g.fillStyle = themeColor('--acc2') || '#4ec9b0'; g.globalAlpha = 0.7;
  const pk = E.overPk.pk, half = H/2;
  for(let x=0;x<W;x++){ const lo=pk[x*2]||0, hi=pk[x*2+1]||0; g.fillRect(x, half-hi*half, 1, Math.max(1,(hi-lo)*half)); }
  g.globalAlpha = 1;
  if(E.b>E.a){ g.fillStyle='rgba(224,178,60,.3)'; g.fillRect(E.a/len*W, 0, (E.b-E.a)/len*W, H); }
  const vx = E.x0/len*W, vw = Math.max(3, aedW(E)*E.spp/len*W);
  g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(vx+0.75, 0.75, vw-1.5, H-1.5);
  if(E.playing){ g.fillStyle='#fff'; g.fillRect(aedPlayPos(E)/len*W, 0, 1.5, H); }
}

function aedStatus(E){
  const len = E.s.length;
  E.ui.info.textContent = aedFmtT(E,len)+' · '+E.sr+' Hz'+(E.dirty?' · ●':'');
  let t;
  if(E.msg && performance.now()-E.msgT < 2500) t = E.msg;
  else if(E.b>E.a) t = 'sel '+aedClock(E.a/E.sr,3)+' – '+aedClock(E.b/E.sr,3)+' ('+aedFmtT(E,E.b-E.a)+', '+(E.b-E.a)+' smp)';
  else t = 'cursor '+aedClock(E.a/E.sr,3)+' · #'+E.a;
  if(E.ui.sel.textContent!==t) E.ui.sel.textContent = t;
  let h = '';
  if(E.hover){
    const i = Math.floor(E.hover.s);
    h = aedClock(E.hover.s/E.sr,3);
    if(E.hover.f!=null) h += ' · '+(E.hover.f>=1000?(E.hover.f/1000).toFixed(2)+' kHz':Math.round(E.hover.f)+' Hz');
    else if(E.spp<=1 && i>=0 && i<len) h += ' · #'+i+' = '+E.s[i].toFixed(5);
  }
  if(E.ui.hov.textContent!==h) E.ui.hov.textContent = h;
}
function aedMsg(E, m){ E.msg = m; E.msgT = performance.now(); aedDraw(E); setTimeout(()=>aedDraw(E), 2600); }

function aedButtons(E){
  const r = E.ui.root, on = (a,v)=>r.querySelector(`[data-a="${a}"]`)?.classList.toggle('on', !!v);
  const dis = (a,v)=>{ const b=r.querySelector(`[data-a="${a}"]`); if(b) b.disabled=!!v; };
  r.querySelector('.aed-play').textContent = E.playing ? '⏸' : '▶';
  on('loop', E.loop); on('draw', E.tool==='draw'); on('view', E.view!=='wave');
  on('nr', E.ui.sheets.nr.classList.contains('on')); on('specset', E.ui.sheets.spec.classList.contains('on'));
  const noSel = !(E.b>E.a);
  for(const a of ['crop','del','cut','copy','silence','fadein','fadeout','zsel']) dis(a, noSel);
  dis('undo', !E.undo.length); dis('redo', !E.redo.length); dis('paste', !AedClip);
  dis('nrapply', !AedProfile); dis('nrprev', !AedProfile);
}

/* ---------- Спектрограмма ---------- */
// Рисуется в отдельный холст с разрешением CSS-пикселей, по колонке на пиксель, частями по ~10 мс.
// Пока идёт жест, старое изображение растягивается под текущий вид (пересчёт — после паузы).
function aedSpecKey(E, W, H){
  const c = AedSpecCfg;
  return [E.ver, E.x0.toFixed(3), E.spp.toPrecision(8), W, H, c.fft, c.log, c.floor, c.ceil, c.pal, E.sr].join('|');
}
function aedSpecSchedule(E, delay=140){
  clearTimeout(E.specTimer);
  E.specPending = false;
  if(E.view==='wave') return;
  E.specPending = true;
  E.specTimer = setTimeout(()=>{ E.specPending = false; aedSpecStart(E); }, delay);
}
function aedSpecFirst(E){ if(!E.specAuto && E.view!=='wave'){ E.specAuto = true; aedSpecAuto(E); } }
// Диапазон дБ по перцентилям спектра ~200 кадров клипа (или выделения).
function aedSpecAuto(E){
  const N = AedSpecCfg.fft, [a,b] = E.b>E.a ? [E.a,E.b] : [0,E.s.length];
  if(b-a < 16) return;
  const w = aedHann(N), re = new Float32Array(N), im = new Float32Array(N), ref = (N/4)*(N/4);
  const nfr = Math.min(200, Math.max(1, Math.floor((b-a)/(N/2)))), vals = [];
  for(let f=0; f<nfr; f++){
    const st = Math.round(a + (b-a-N)*(nfr>1 ? f/(nfr-1) : 0));
    for(let i=0;i<N;i++){ const ii=st+i; re[i] = (ii>=a && ii<b) ? E.s[ii]*w[i] : 0; im[i]=0; }
    fft(re,im);
    for(let k=1;k<=N/2;k+=2) vals.push(10*Math.log10((re[k]*re[k]+im[k]*im[k])/ref + 1e-30));
  }
  vals.sort((x,y)=>x-y);
  const q = p=>vals[Math.min(vals.length-1, Math.floor(p*vals.length))];
  AedSpecCfg.floor = clamp(Math.round(q(0.1)-6), -160, -40);
  AedSpecCfg.ceil = clamp(Math.round(Math.max(q(0.9995), AedSpecCfg.floor+30)), -80, 0);
  E.ui.sheets.spec.querySelectorAll('[data-k]').forEach(el=>el.sync?.());
}
function aedSpecFreqs(E){
  const ny = E.sr/2, fmin = Math.max(20, E.sr/AedSpecCfg.fft);
  return { ny, fmin, yToF: (u)=> AedSpecCfg.log ? fmin*Math.pow(ny/fmin, u) : ny*u };  // u: 0 — низ, 1 — верх
}
function aedSpecStart(E){
  const main = E.ui.main, W = main.clientWidth, H = main.clientHeight;
  const L = aedLayout(E, H), SH = Math.max(1, Math.round(L.sh));
  if(!W || L.sh<=0) return;
  const key = aedSpecKey(E, W, SH);
  if(E.spec && E.spec.key===key) return;
  if(E.specJob) E.specJob.cancel = true;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = SH;
  const g = cv.getContext('2d');
  if(E.spec && E.spec.H===SH && E.spec.ver===E.ver) aedSpecBlit(E, g, E.spec, 0, W, SH);
  const sp = E.spec = { key, cv, x0:E.x0, spp:E.spp, H:SH, ver:E.ver };
  const N = AedSpecCfg.fft, win = window_('hann', N), re = new Float32Array(N), im = new Float32Array(N);
  const nb = N/2, pw = new Float32Array(nb+1);
  const ref = (N/4)*(N/4), lut = paletteLut(AedSpecCfg.pal);
  const fl = AedSpecCfg.floor, span = Math.max(1, AedSpecCfg.ceil - fl);
  const F = aedSpecFreqs(E);
  // для каждой строки — диапазон бинов [lo, hi)
  const rowLo = new Int32Array(SH), rowHi = new Int32Array(SH);
  for(let y=0;y<SH;y++){
    const fTop = F.yToF(1 - y/SH), fBot = F.yToF(1 - (y+1)/SH);
    let lo = Math.floor(fBot/E.sr*N), hi = Math.ceil(fTop/E.sr*N);
    lo = clamp(lo, 0, nb); hi = clamp(Math.max(hi, lo+1), 1, nb+1);
    rowLo[y] = lo; rowHi[y] = hi;
  }
  const img = g.createImageData(W, SH), d = img.data, s = E.s, len = s.length;
  const job = E.specJob = { cancel:false };
  let x = 0;
  const step = ()=>{
    if(job.cancel || !E.ui) return;
    const t0 = performance.now(), c0 = x;
    while(x<W && performance.now()-t0 < 10){
      const c = sp.x0 + (x+0.5)*sp.spp;
      const k = clamp(Math.ceil(sp.spp/(N/2)), 1, 4);   // при дальнем масштабе — среднее нескольких кадров
      pw.fill(0);
      for(let j=0;j<k;j++){
        const st = Math.round(c - sp.spp/2 + (j+0.5)*sp.spp/k - N/2);
        for(let i=0;i<N;i++){ const ii=st+i; re[i] = (ii>=0 && ii<len) ? s[ii]*win[i] : 0; im[i]=0; }
        fft(re, im);
        for(let b=0;b<=nb;b++) pw[b] += (re[b]*re[b]+im[b]*im[b])/k;
      }
      for(let y=0;y<SH;y++){
        let m = 0; for(let b=rowLo[y]; b<rowHi[y]; b++) if(pw[b]>m) m=pw[b];
        const db = 10*Math.log10(m/ref + 1e-30);
        const li = (clamp((db-fl)/span, 0, 1)*255|0)*3, o = (y*W+x)*4;
        d[o]=lut[li]; d[o+1]=lut[li+1]; d[o+2]=lut[li+2]; d[o+3]=255;
      }
      x++;
    }
    g.putImageData(img, 0, 0, c0, 0, x-c0, SH);
    aedDraw(E);
    if(x<W) setTimeout(step, 0); else E.specJob = null;
  };
  step();
}
// Переносит готовое изображение sp в текущий вид (сдвиг/растяжение по времени).
function aedSpecBlit(E, g, sp, y, W, H){
  const k = sp.spp/E.spp, dx = (sp.x0 - E.x0)/E.spp;
  g.imageSmoothingEnabled = false;
  g.drawImage(sp.cv, 0, 0, sp.cv.width, sp.H, dx, y, sp.cv.width*k, H);
}
function aedDrawSpec(E, g, W, L){
  if(E.spec && E.spec.ver===E.ver) aedSpecBlit(E, g, E.spec, L.sy, W, L.sh);
  if(!E.spec || E.spec.key!==aedSpecKey(E, W, Math.max(1,Math.round(L.sh)))){
    if(!E.specPending) aedSpecSchedule(E);
  }
  // шкала частот
  const F = aedSpecFreqs(E);
  g.font = '10px '+(themeColor('--mono')||'monospace');
  const ticks = [];
  if(AedSpecCfg.log){
    for(let dcd=10; dcd<F.ny; dcd*=10) for(const m of [1,2,5]){ const f=dcd*m; if(f>=F.fmin && f<F.ny) ticks.push(f); }
  } else {
    const want = Math.max(2, Math.floor(L.sh/40)), r = F.ny/want, p = Math.pow(10, Math.floor(Math.log10(r)));
    const st = (r/p<2?2:r/p<5?5:10)*p;
    for(let f=st; f<F.ny; f+=st) ticks.push(f);
  }
  for(const f of ticks){
    const u = AedSpecCfg.log ? Math.log(f/F.fmin)/Math.log(F.ny/F.fmin) : f/F.ny;
    const y = Math.round(L.sy + L.sh*(1-u));
    if(y<L.sy+8 || y>L.sy+L.sh-2) continue;
    const lab = f>=1000 ? (f/1000)+'k' : f+'';
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, y-6, lab.length*6.2+10, 12);
    g.fillStyle = 'rgba(255,255,255,.8)'; g.fillRect(0, y, 5, 1); g.fillText(lab, 7, y+4);
  }
  g.fillStyle = themeColor('--grid') || '#1e2529'; g.fillRect(0, L.sy, W, 1);
}

/* ---------- Ввод: выделение, жесты, карандаш ---------- */
function aedBindPointer(E){
  const cv = E.ui.cv;
  const loc = ev=>{ const r=cv.getBoundingClientRect(); return { x:ev.clientX-r.left, y:ev.clientY-r.top }; };
  const smp = x=>clamp(Math.round(E.x0 + x*E.spp), 0, E.s.length);

  cv.addEventListener('pointerdown', ev=>{
    try{ cv.setPointerCapture(ev.pointerId); }catch(e){}
    const p = loc(ev); E.ptr.set(ev.pointerId, p);
    if(E.ptr.size===2){                      // второй палец — щипок, выделение первого отменяем
      if(E.g && E.g.kind==='sel' && E.g.prev){ E.a=E.g.prev[0]; E.b=E.g.prev[1]; }
      if(E.g && E.g.kind==='draw') aedDrawEnd(E);
      const [p1,p2] = [...E.ptr.values()];
      const sx = Math.abs(p1.x-p2.x), sy = Math.abs(p1.y-p2.y);
      E.g = { kind:'pinch', axis: sx>=sy?'t':'a', sx:Math.max(sx,20), sy:Math.max(sy,20), spp:E.spp, vz:E.vz,
              at:E.x0 + (p1.x+p2.x)/2*E.spp };
      aedDraw(E); return;
    }
    if(E.ptr.size>2) return;
    const H = cv.clientHeight, L = aedLayout(E, H);
    if(p.y < L.R){ E.g = { kind:'pan', x:p.x, x0:E.x0, moved:false }; return; }   // линейка — прокрутка одним пальцем
    if(E.tool==='draw' && p.y>=L.wy && p.y<L.wy+L.wh){
      if(E.spp>1){ aedMsg(E,'zoom in until single samples are visible to draw'); return; }
      E.g = { kind:'draw', L, orig:E.s, last:null }; E.s = E.s.slice(); aedDrawAt(E, p); return;
    }
    const tol = ev.pointerType==='touch' ? 22 : 8;
    const xa = (E.a-E.x0)/E.spp, xb = (E.b-E.x0)/E.spp;
    let edge = null;
    if(E.b>E.a){ if(Math.abs(p.x-xb)<=tol) edge='b'; else if(Math.abs(p.x-xa)<=tol) edge='a'; }
    E.g = { kind:'sel', edge, anchor: edge==='a'?E.b : edge==='b'?E.a : smp(p.x), x:p.x, moved:!!edge,
            prev:[E.a,E.b], px:p.x, auto:false };
  });

  cv.addEventListener('pointermove', ev=>{
    const p = loc(ev);
    const H = cv.clientHeight, L = aedLayout(E, H);
    E.hover = { x:p.x, s:E.x0 + p.x*E.spp,
      f: (p.y>=L.sy && L.sh>0) ? aedSpecFreqs(E).yToF(1-(p.y-L.sy)/L.sh) : null };
    if(!E.ptr.has(ev.pointerId)){ aedDraw(E); return; }
    E.ptr.set(ev.pointerId, p);
    const G = E.g; if(!G){ aedDraw(E); return; }
    if(G.kind==='pinch' && E.ptr.size>=2){
      const [p1,p2] = [...E.ptr.values()];
      const cx = (p1.x+p2.x)/2;
      if(G.axis==='t'){
        E.spp = G.spp * G.sx/Math.max(20, Math.abs(p1.x-p2.x));
        aedClampView(E); E.x0 = G.at - cx*E.spp; aedClampView(E); aedSpecSchedule(E);
      } else {
        E.vz = clamp(G.vz * Math.max(20, Math.abs(p1.y-p2.y))/G.sy, 1, 65536);
      }
    } else if(G.kind==='pan'){
      if(Math.abs(p.x-G.x)>3) G.moved = true;
      E.x0 = G.x0 - (p.x-G.x)*E.spp; aedClampView(E); aedSpecSchedule(E);
    } else if(G.kind==='sel'){
      if(!G.moved && Math.abs(p.x-G.x)<5) return;
      G.moved = true; G.px = p.x;
      const W = cv.clientWidth; G.auto = p.x<16 || p.x>W-16;
      const v = smp(p.x); E.a = Math.min(G.anchor, v); E.b = Math.max(G.anchor, v);
    } else if(G.kind==='draw'){
      aedDrawAt(E, p);
    }
    aedDraw(E);
  });

  const up = ev=>{
    if(!E.ptr.has(ev.pointerId)) return;
    E.ptr.delete(ev.pointerId);
    const G = E.g;
    if(G && G.kind==='pinch'){ if(E.ptr.size===0) E.g=null; aedSpecSchedule(E); return; }
    if(G && G.kind==='sel'){
      if(!G.moved){                            // тап — курсор
        E.a = E.b = G.anchor;
        if(E.playing) aedPlay(E);
      } else if(E.playing && E.loop) aedPlay(E, aedPlayPos(E));
    }
    if(G && G.kind==='pan' && !G.moved){ const v = smp(G.x); E.a=E.b=v; if(E.playing) aedPlay(E); }
    if(G && G.kind==='draw') aedDrawEnd(E);
    E.g = null; aedDraw(E);
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', ()=>{ if(!E.ptr.size){ E.hover=null; aedDraw(E); } });
  cv.addEventListener('dblclick', ev=>{                 // двойной клик — выделить видимое
    E.a = clamp(Math.floor(E.x0),0,E.s.length); E.b = clamp(Math.ceil(E.x0+aedW(E)*E.spp),0,E.s.length); aedDraw(E);
  });

  cv.addEventListener('wheel', ev=>{
    ev.preventDefault();
    const p = loc(ev);
    const dy = ev.deltaMode===1 ? ev.deltaY*30 : ev.deltaY, dx = ev.deltaMode===1 ? ev.deltaX*30 : ev.deltaX;
    if(ev.altKey){ E.vz = clamp(E.vz*Math.pow(1.002, -dy), 1, 65536); }
    else if(ev.shiftKey || Math.abs(dx)>Math.abs(dy)){ E.x0 += (dx||dy)*E.spp; aedClampView(E); aedSpecSchedule(E); }
    else aedZoom(E, Math.pow(1.0025, dy), p.x);
    aedDraw(E);
  }, {passive:false});
}

function aedAutoScroll(E){                  // выделение у края — вид едет сам
  const G = E.g, W = aedW(E);
  if(!G || G.kind!=='sel' || !G.auto) return;
  const d = G.px<16 ? -(16-G.px) : G.px>W-16 ? G.px-(W-16) : 0;
  if(!d){ G.auto=false; return; }
  E.x0 += d*E.spp*0.8; aedClampView(E); aedSpecSchedule(E);
  const v = clamp(Math.round(E.x0 + G.px*E.spp), 0, E.s.length);
  E.a = Math.min(G.anchor, v); E.b = Math.max(G.anchor, v);
}

function aedDrawAt(E, p){
  const G = E.g, L = G.L, cy = L.wy + L.wh/2, amp = L.wh/2*0.95*E.vz;
  const i = Math.floor(E.x0 + p.x*E.spp), v = clamp((cy-p.y)/amp, -1, 1);
  if(i<0 || i>=E.s.length) return;
  if(G.last && G.last.i!==i){                   // заполнить пропущенные семплы линейно
    const [ia, va] = [G.last.i, G.last.v], n = i-ia, st = Math.sign(n);
    for(let j=ia+st; j!==i; j+=st) E.s[j] = va + (v-va)*(j-ia)/n;
  }
  E.s[i] = v; G.last = { i, v };
  E.ver++; E.dirty = true;
}
function aedDrawEnd(E){
  const G = E.g;
  if(!G || G.kind!=='draw') return;
  const cur = E.s; E.s = G.orig;
  if(G.last) aedEdit(E, 'draw', cur, E.a, E.b); else E.ver++;
  E.g = null;
}

function aedBindOverview(E){
  const cv = E.ui.over;
  let drag = null;
  const go = ev=>{
    const r = cv.getBoundingClientRect(), len = Math.max(1,E.s.length);
    const c = (ev.clientX-r.left)/r.width*len;
    E.x0 = (drag ? c - drag : c - aedW(E)*E.spp/2); aedClampView(E); aedSpecSchedule(E); aedDraw(E);
  };
  cv.addEventListener('pointerdown', ev=>{
    try{ cv.setPointerCapture(ev.pointerId); }catch(e){}
    const r = cv.getBoundingClientRect(), len = Math.max(1,E.s.length);
    const c = (ev.clientX-r.left)/r.width*len, vis = aedW(E)*E.spp;
    drag = (c>=E.x0 && c<=E.x0+vis) ? c-E.x0 : null;   // тащим за окно или центрируем на точке
    go(ev); if(drag==null) drag = vis/2;
  });
  cv.addEventListener('pointermove', ev=>{ if(drag!=null) go(ev); });
  cv.addEventListener('pointerup', ()=>{ drag=null; });
  cv.addEventListener('pointercancel', ()=>{ drag=null; });
}

/* ---------- Правки и отмена ---------- */
function aedRebuildPyr(E){
  const s = E.s, n = Math.ceil(s.length/AED_PYR), lo = new Float32Array(n), hi = new Float32Array(n);
  for(let b=0;b<n;b++){
    let l=Infinity, h=-Infinity; const e = Math.min(s.length, (b+1)*AED_PYR);
    for(let i=b*AED_PYR;i<e;i++){ const v=s[i]; if(v<l) l=v; if(v>h) h=v; }
    lo[b]=l; hi[b]=h;
  }
  E.pyr = { n, lo, hi };
}
function aedEdit(E, label, next, a, b){
  E.undo.push({ s:E.s, a:E.a, b:E.b, label, name:E.name });
  E.undoBytes += E.s.byteLength;
  while(E.undoBytes > AED_UNDO_BYTES && E.undo.length>1){ E.undoBytes -= E.undo.shift().s.byteLength; }
  E.redo = [];
  E.s = next; E.a = clamp(a,0,next.length); E.b = clamp(b,E.a,next.length);
  aedChanged(E);
  aedMsg(E, label);
}
function aedChanged(E){
  E.ver++; E.dirty = true; E.ab = null;
  aedRebuildPyr(E); aedClampView(E); aedSpecSchedule(E, 60);
  if(E.playing) aedPlay(E, Math.min(aedPlayPos(E), E.s.length));
}
function aedUndo(E){
  const u = E.undo.pop(); if(!u) return;
  E.undoBytes -= u.s.byteLength;
  E.redo.push({ s:E.s, a:E.a, b:E.b, label:u.label });
  E.s = u.s; E.a = u.a; E.b = u.b;
  aedChanged(E); aedMsg(E, 'undo '+u.label);
}
function aedRedo(E){
  const r = E.redo.pop(); if(!r) return;
  E.undo.push({ s:E.s, a:E.a, b:E.b, label:r.label }); E.undoBytes += E.s.byteLength;
  E.s = r.s; E.a = r.a; E.b = r.b;
  aedChanged(E); aedMsg(E, 'redo '+r.label);
}
function aedDelete(E, label){
  const out = new Float32Array(E.s.length - (E.b-E.a));
  out.set(E.s.subarray(0,E.a)); out.set(E.s.subarray(E.b), E.a);
  aedEdit(E, label, out, E.a, E.a);
}
// Поэлементная операция над выделением (или всем клипом при whole): f(v, i-от-начала).
function aedMap(E, label, f, whole){
  const [a,b] = whole ? [0,E.s.length] : [E.a,E.b];
  const out = E.s.slice();
  for(let i=a;i<b;i++) out[i] = f(E.s[i], i-a);
  aedEdit(E, label, out, E.a, E.b);
}
function aedNormalize(E){
  const whole = !(E.b>E.a), [a,b] = whole?[0,E.s.length]:[E.a,E.b];
  if(b<=a) return;
  let dc = 0; for(let i=a;i<b;i++) dc += E.s[i]; dc /= (b-a);
  let pk = 0; for(let i=a;i<b;i++){ const v=Math.abs(E.s[i]-dc); if(v>pk) pk=v; }
  if(!pk) return;
  const k = Math.pow(10,-1/20)/pk;
  aedMap(E, 'normalize', v=>(v-dc)*k, whole);
}
function aedResample(s, from, to){
  if(from===to) return s;
  const n = Math.max(1, Math.round(s.length*to/from)), out = new Float32Array(n), r = from/to;
  for(let i=0;i<n;i++){ const p=i*r, i0=p|0, f=p-i0; out[i] = (s[i0]||0)*(1-f) + (s[Math.min(i0+1,s.length-1)]||0)*f; }
  return out;
}
function aedPaste(E){
  if(!AedClip) return;
  const c = aedResample(AedClip.s, AedClip.sr, E.sr);
  const out = new Float32Array(E.s.length - (E.b-E.a) + c.length);
  out.set(E.s.subarray(0,E.a)); out.set(c, E.a); out.set(E.s.subarray(E.b), E.a+c.length);
  aedEdit(E, 'paste', out, E.a, E.a+c.length);
}

/* ---------- Воспроизведение ---------- */
// Свой AudioContext мимо графа — чтобы слушать в редакторе без подключения к dac.
function aedCtx(E){
  if(!E.ctx || E.ctx.state==='closed') E.ctx = new (window.AudioContext||window.webkitAudioContext)();
  if(E.ctx.state==='suspended') E.ctx.resume();
  return E.ctx;
}
function aedBuffer(E, s){
  const ctx = aedCtx(E), ab = ctx.createBuffer(1, Math.max(1,s.length), E.sr);
  ab.getChannelData(0).set(s);
  return ab;
}
function aedPlay(E, from){
  aedStop(E, true);
  const len = E.s.length; if(!len) return;
  const ctx = aedCtx(E);
  if(!E.ab || E.abVer!==E.ver){ E.ab = aedBuffer(E, E.s); E.abVer = E.ver; }
  const sel = E.b>E.a;
  const lo = sel ? E.a : 0, hi = sel ? E.b : len;
  let st = from ?? E.a;
  if(st>=hi || st<lo) st = lo;
  const src = ctx.createBufferSource(); src.buffer = E.ab; src.connect(ctx.destination);
  if(E.loop){ src.loop = true; src.loopStart = lo/E.sr; src.loopEnd = hi/E.sr; src.start(0, st/E.sr); }
  else src.start(0, st/E.sr, (hi-st)/E.sr);
  src.onended = ()=>{ if(E.src===src){ E.src=null; E.playing=false; aedDraw(E); } };
  E.src = src; E.playing = true;
  E.pl = { t0:ctx.currentTime, st, lo, hi, loop:E.loop };
  aedDraw(E);
}
function aedStop(E, quiet){
  if(E.src){ const s=E.src; E.src=null; try{ s.onended=null; s.stop(); }catch(e){} }
  if(E.pv){ try{ E.pv.stop(); }catch(e){} E.pv=null; }
  E.playing = false;
  if(!quiet) aedDraw(E);
}
function aedPlayPos(E){
  const P = E.pl; if(!P || !E.ctx) return 0;
  let p = P.st + (E.ctx.currentTime - P.t0)*E.sr;
  if(P.loop && p>=P.hi){ const span = Math.max(1,P.hi-P.lo); p = P.lo + (p-P.hi)%span; }
  return Math.min(p, P.hi);
}

/* ---------- Шумоподавление по профилю ---------- */
// Спектральный гейт как в Audacity: профиль — средняя мощность шума по бинам; бин ниже
// профиль·чувствительность приглушается на red дБ. Маска сглаживается по времени (атака — назад,
// спад — вперёд, пиковое удержание) и по частоте, затем STFT-синтез с перекрытием 75%.
// Обработка идёт один раз от исходника, без накопления искажений.
function aedHann(N){ const w=new Float32Array(N); for(let i=0;i<N;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/N); return w; }
function aedNrN(sr){ return sr>=32000 ? 2048 : sr>=16000 ? 1024 : 512; }
function aedNrProfile(E){
  if(!(E.b>E.a)){ aedMsg(E,'select a piece with noise only'); return; }
  const N = aedNrN(E.sr), hop = N/4, nb = N/2+1;
  if(E.b-E.a < N){ aedMsg(E,'selection too short for a profile'); return; }
  const w = aedHann(N), re = new Float32Array(N), im = new Float32Array(N), pow = new Float64Array(nb);
  let fr = 0;
  for(let st=E.a; st+N<=E.b; st+=hop, fr++){
    for(let i=0;i<N;i++){ re[i]=E.s[st+i]*w[i]; im[i]=0; }
    fft(re,im);
    for(let k=0;k<nb;k++) pow[k] += re[k]*re[k]+im[k]*im[k];
  }
  AedProfile = { sr:E.sr, N, pow:Float32Array.from(pow, v=>v/fr), dur:(E.b-E.a)/E.sr };
  aedNrInfo(E); aedMsg(E,'noise profile taken'); aedDraw(E);
}
function aedNrInfo(E){
  const P = AedProfile;
  E.ui.nrinfo.textContent = !P ? 'no profile' : P.sr!==E.sr ? 'profile is from '+P.sr+' Hz — take a new one'
    : 'profile: '+P.dur.toFixed(2)+' s';
}
function aedNrProcess(seg, sr, cfg){
  const P = AedProfile, N = P.N, hop = N/4, nb = N/2+1;
  const len = seg.length, total = len + 2*N;
  const x = new Float32Array(total); x.set(seg, N);
  const nf = Math.floor((total-N)/hop)+1;
  const w = aedHann(N), re = new Float32Array(N), im = new Float32Array(N);
  const thr = new Float32Array(nb), sens = Math.pow(10, cfg.sens/10);
  for(let k=0;k<nb;k++) thr[k] = P.pow[k]*sens;
  // проход 1: бинарная маска «сигнал». Решение — по минимуму мощности за ~40 мс, иначе
  // одиночные всплески шума над порогом открывают гейт («музыкальный» шум)
  const K = Math.max(1, Math.round(0.04*sr/hop)), h = K>>1;
  const ring = Array.from({length:K}, ()=>new Float32Array(nb));
  const m = new Uint8Array(nf*nb);
  for(let f=0;f<nf;f++){
    const st = f*hop, pw = ring[f%K];
    for(let i=0;i<N;i++){ re[i]=x[st+i]*w[i]; im[i]=0; }
    fft(re,im);
    for(let k=0;k<nb;k++) pw[k] = re[k]*re[k]+im[k]*im[k];
    const c = f-(K-1)+h;
    if(f<K-1) continue;
    for(let k=0;k<nb;k++){
      let mn = Infinity; for(let j=0;j<K;j++){ const v=ring[j][k]; if(v<mn) mn=v; }
      m[c*nb+k] = mn > thr[k] ? 255 : 0;
    }
  }
  // сглаживание по времени (пиковое удержание с экспоненциальным спадом в обе стороны)
  const tau = Math.max(1e-3, cfg.tsm/1000), dec = cfg.tsm>0 ? Math.exp(-hop/(sr*tau)) : 0;
  const col = new Float32Array(nf);
  for(let k=0;k<nb;k++){
    for(let f=0;f<nf;f++) col[f] = m[f*nb+k];
    for(let f=1;f<nf;f++) col[f] = Math.max(col[f], col[f-1]*dec);
    for(let f=nf-2;f>=0;f--) col[f] = Math.max(col[f], col[f+1]*dec);
    for(let f=0;f<nf;f++) m[f*nb+k] = col[f];
  }
  // проход 2: сглаживание по частоте, применение, синтез
  const floor = Math.pow(10, -cfg.red/20), fs = cfg.fsm|0, gk = new Float32Array(nb);
  const y = new Float32Array(total), norm = 1/1.5;       // сумма w² для Hann с шагом N/4
  for(let f=0;f<nf;f++){
    const st = f*hop, row = f*nb;
    for(let k=0;k<nb;k++){
      let s=0, c=0; const lo=Math.max(0,k-fs), hi=Math.min(nb-1,k+fs);
      for(let j=lo;j<=hi;j++){ s+=m[row+j]; c++; }
      const g = s/c/255;
      gk[k] = floor + (1-floor)*g;
    }
    for(let i=0;i<N;i++){ re[i]=x[st+i]*w[i]; im[i]=0; }
    fft(re,im);
    for(let k=0;k<nb;k++){ re[k]*=gk[k]; im[k]*=gk[k]; }
    for(let k=1;k<N/2;k++){ re[N-k]=re[k]; im[N-k]=-im[k]; }   // эрмитова симметрия
    for(let i=0;i<N;i++) im[i]=-im[i];                           // обратное БПФ через сопряжение
    fft(re,im);
    for(let i=0;i<N;i++) y[st+i] += re[i]/N*w[i]*norm;
  }
  const out = y.subarray(N, N+len);
  if(cfg.residue) for(let i=0;i<len;i++) out[i] = seg[i]-out[i];
  return out;
}
function aedNrRange(E){ return E.b>E.a ? [E.a,E.b] : [0,E.s.length]; }
function aedNrCheck(E){
  if(!AedProfile){ aedMsg(E,'take a noise profile first'); return false; }
  if(AedProfile.sr!==E.sr){ aedMsg(E,'noise profile is from another sample rate'); return false; }
  return true;
}
function aedNrPreview(E){
  if(!aedNrCheck(E)) return;
  let [a,b] = aedNrRange(E);
  b = Math.min(b, a + E.sr*15);                 // превью — не длиннее 15 с
  const out = aedNrProcess(E.s.subarray(a,b), E.sr, AedNrCfg);
  aedStop(E);
  const ctx = aedCtx(E), src = ctx.createBufferSource();
  src.buffer = aedBuffer(E, out); src.connect(ctx.destination); src.loop = E.loop; src.start();
  E.pv = src; aedMsg(E, 'preview — press ⏹ to stop');
}
function aedNrApply(E){
  if(!aedNrCheck(E)) return;
  const [a,b] = aedNrRange(E);
  aedMsg(E,'processing…');
  setTimeout(()=>{
    const out = aedNrProcess(E.s.subarray(a,b), E.sr, AedNrCfg);
    const next = E.s.slice(); next.set(out, a);
    const xf = Math.min(256, (b-a)>>2);              // короткие стыки с необработанной частью
    if(a>0) for(let i=0;i<xf;i++){ const t=i/xf; next[a+i] = E.s[a+i]*(1-t) + out[i]*t; }
    if(b<E.s.length) for(let i=0;i<xf;i++){ const t=i/xf, j=b-1-i; next[j] = E.s[j]*(1-t) + out[j-a]*t; }
    aedEdit(E, AedNrCfg.residue ? 'noise residue' : 'noise reduction', next, E.a, E.b);
  }, 30);
}

/* ---------- Сохранение, экспорт, закрытие ---------- */
async function aedSave(E, asNew){
  aedDrawEnd(E);
  const s = E.s;
  if(!s.length){ aedMsg(E,'clip is empty'); return; }
  const rec = { name:E.name || 'clip', samples:s, sr:E.sr, peaks:SampleDB.computePeaks(s), duration:s.length/E.sr };
  try{
    if(asNew){
      const id = await SampleDB.addClip({ ...rec, name:rec.name+' (edit)', folderId:E.clip.folderId ?? null });
      aedMsg(E,'saved as a new clip');
      E.opts.onSaved?.(id);
    } else {
      await SampleDB.updateClip(E.clip.id, rec);
      E.dirty = false; aedMsg(E,'saved');
      E.opts.onSaved?.(E.clip.id);
    }
  }catch(e){ console.warn(e); aedMsg(E,'save error: '+e.message); }
}
function aedWavBlob(s, sr){
  const n = s.length, buf = new ArrayBuffer(44+n*2), v = new DataView(buf);
  const wr = (o,t)=>{ for(let i=0;i<t.length;i++) v.setUint8(o+i, t.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4,36+n*2,true); wr(8,'WAVEfmt '); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true); wr(36,'data'); v.setUint32(40,n*2,true);
  for(let i=0;i<n;i++) v.setInt16(44+i*2, clamp(Math.round(s[i]*32767), -32768, 32767), true);
  return new Blob([buf], {type:'audio/wav'});
}
function aedDownloadWav(E){
  const s = E.b>E.a ? E.s.subarray(E.a,E.b) : E.s;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(aedWavBlob(s, E.sr));
  a.download = (E.name||'clip').replace(/[\\/:*?"<>|]/g,'_') + '.wav';
  a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
}
function aedClose(E){
  if(E.dirty && !confirm('Discard unsaved changes?')) return;
  aedStop(E, true);
  if(E.specJob) E.specJob.cancel = true;
  clearTimeout(E.specTimer);
  if(E.ctx) E.ctx.close().catch(()=>{});
  window.removeEventListener('keydown', E.onKey, true);
  E.ro.disconnect();
  E.ui.root.remove(); E.ui = null;
  E.opts.onClose?.();
}
