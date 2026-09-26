/* ---------- Рекордер с триггером ---------- */
// Записи сохраняются в SampleDB (IndexedDB), в папку "Триггер-записи" в корне библиотеки.
// n.recordings — локальный кэш метаданных+буферов для списка, источник истины — база.
// Проигрывание выбранной записи идёт через сам узел (out:sig), как у 'file' — нужно подключить
// выход к чему-то вроде dac.
// Высота своего HTML-блока держится через n.onResize (см. syncCustomHeight в sample-library.js) —
// canvas движка тут не используется вовсе, вместо него свой маленький canvas для живой волны записи.

let _recFolderPromise = null;
async function ensureRecorderFolder(){
  if(_recFolderPromise) return _recFolderPromise;
  _recFolderPromise = (async()=>{
    const existing = await SampleDB.listFolders(null);
    const found = existing.find(f=>f.name==='Trigger recordings');
    return found ? found.id : await SampleDB.addFolder('Trigger recordings', null);
  })();
  return _recFolderPromise;
}

async function saveRecordingToDB(n, samples, peak, rms){
  const folderId = await ensureRecorderFolder();
  const id = await SampleDB.addClip({
    name: 'recording ' + new Date().toLocaleTimeString(),
    folderId, sr: Eng.sr, samples,
    peaks: SampleDB.computePeaks(samples),
    duration: samples.length / Eng.sr,
    peak, rms,
  });
  await refreshRecorderList(n);
  const rec = n.recordings.find(r=>r.id===id);
  if(rec) recSelect(n, rec, false);      // выбрать новую запись, но не проигрывать сразу
}

async function refreshRecorderList(n){
  const folderId = await ensureRecorderFolder();
  const clips = await SampleDB.listClips(folderId);
  clips.sort((a,b)=>a.created-b.created);
  n.recordings = clips;
  if(n.selected!=null && !clips.some(c=>c.id===n.selected)){ n.selected=-1; n.data=null; n.play=false; }
  updateRecordingList2(n);
  updateRecorderStatus(n);
}

// Делает запись текущим источником воспроизведения узла.
function recSelect(n, rec, autoplay){
  n.data = rec.samples;
  n.dataSr = rec.sr;
  n.pos = 0;
  n.selected = rec.id;
  if(autoplay) n.play = true;
  updateRecordingList2(n);
  updateRecorderStatus(n);
}

def({ id:'triggerRecorder', title:'Trigger Recorder', cat:'Output',
  ins:[{n:'in',t:'sig'},{n:'trig',t:'num'},{n:'threshold',t:'num'},{n:'preTime',t:'num'},
       {n:'postTime',t:'num'},{n:'maxDuration',t:'num'},{n:'trigHold',t:'num'},
       {n:'clipId',t:'num'},{n:'play',t:'num'},{n:'rate',t:'num'},{n:'gain',t:'num'}],
  outs:[{n:'recording',t:'num'},{n:'out',t:'sig'},{n:'clipId',t:'num'}],
  h:280, resize:true, readout:true,
  params:[
    {n:'mode',t:'select',opts:['manual','level','edge'],d:'manual',label:'mode'},
    {n:'threshold',t:'range',min:0.001,max:0.5,step:0.001,d:0.02,label:'threshold'},
    {n:'preTime',t:'range',min:0.1,max:5,step:0.1,d:0.5,label:'pre-record, s'},
    {n:'postTime',t:'range',min:0.1,max:10,step:0.1,d:1,label:'post-record, s'},
    {n:'maxDuration',t:'range',min:1,max:60,step:0.5,d:10,label:'max length, s'},
    {n:'trigHold',t:'range',min:0.1,max:5,step:0.1,d:0.5,label:'trigger hold, s'},
    {n:'rate',t:'range',min:.25,max:4,step:.01,d:1,label:'playback speed'},
    {n:'gain',t:'range',min:0,max:4,step:.01,d:1,label:'playback volume'},
    {n:'loop',t:'check',d:false,label:'loop playback'},
  ],
  init:n=>{
    n.ring = null;
    n.w = 0;
    n.recording = false;
    n.buffer = [];
    n.recordings = [];           // кэш из SampleDB, наполняется асинхронно
    n.trigState = false;
    n.trigTimer = 0;
    n.preBuf = [];
    n.selected = -1;
    n.data = null;                // Float32Array проигрываемой записи
    n.dataSr = Eng.sr;
    n.pos = 0;
    n.play = false;
    n.playGate = false;
    n.silenceTimer = 0;
    n.prevLevel = 0;
    n.initialized = false;
    n.sampleRate = Eng.sr;
    n.listContainer = null;
    n.statusEl = null;
    n.controlsEl = null;
    n.playBtn = null;
    n.infoEl = null;
    n.waveCv = null; n.waveCx = null;
    n.onResize = ln => { if(ln.ui) syncCustomHeight(ln, ln.ui.root, 140); };
    refreshRecorderList(n);      // подтягиваем прошлые записи после перезагрузки страницы
  },
  process(n,I){
    for(const k of ['threshold','preTime','postTime','maxDuration','trigHold'])
      if(typeof I[k]==='number') setMod(n,k,I[k]);
    const dt = BLOCK / Eng.sr;
    const need = Math.round(n.p.maxDuration * Eng.sr);
    const preNeed = Math.round(n.p.preTime * Eng.sr);
    
    if(!n.ring || n.ring.length !== need + preNeed + 100){
      n.ring = new Float32Array(need + preNeed + 100);
      n.w = 0;
    }
    
    const signal = I.in || new Float32Array(BLOCK);
    for(let i=0;i<BLOCK;i++){
      n.ring[n.w] = signal[i];
      n.w = (n.w+1) % n.ring.length;
    }
    
    let triggered = false;
    const trig = I.trig || 0;
    let level = 0;
    for(let i=0;i<BLOCK;i++) level += signal[i]*signal[i];
    level = Math.sqrt(level / BLOCK);
    
    switch(n.p.mode){
      case 'manual':
        if(trig > 0.5 && !n.trigState){ triggered = true; n.trigState = true; }
        if(trig <= 0.5) n.trigState = false;
        break;
      case 'level':
        if(level > n.p.threshold && !n.trigState){
          triggered = true;
          n.trigState = true;
          n.trigTimer = 0;
        }
        if(level <= n.p.threshold){
          n.trigTimer += dt;
          if(n.trigTimer > n.p.trigHold) n.trigState = false;
        }
        break;
      case 'edge':
        if(level > n.p.threshold && n.prevLevel <= n.p.threshold) triggered = true;
        n.prevLevel = level;
        break;
    }
    
    if(triggered && !n.recording){
      n.recording = true;
      n.buffer = [];
      n.recordStart = performance.now();
      n.preBuf = [];
      n.silenceTimer = 0;
      
      const preSamples = Math.min(preNeed, n.ring.length);
      for(let i=0; i<preSamples; i++){
        const idx = (n.w - preSamples + i + n.ring.length) % n.ring.length;
        n.preBuf.push(n.ring[idx]);
      }
      for(let i=0;i<BLOCK;i++) n.buffer.push(signal[i]);
      
      updateRecorderStatus(n);
    }
    
    if(n.recording){
      for(let i=0;i<BLOCK;i++) n.buffer.push(signal[i]);
      
      let stop = false;
      if(n.p.mode === 'manual'){
        stop = trig <= 0.5 && n.buffer.length > preNeed + Eng.sr*0.5;
      } else {
        const duration = (performance.now() - n.recordStart) / 1000;
        stop = duration > n.p.maxDuration;
        if(level < n.p.threshold){
          n.silenceTimer += dt;
          if(n.silenceTimer > n.p.postTime && n.buffer.length > preNeed + Eng.sr*0.5){
            stop = true;
          }
        } else {
          n.silenceTimer = 0;
        }
      }
      
      if(stop){
        n.recording = false;
        n.silenceTimer = 0;
        
        const fullBuffer = new Float32Array(n.preBuf.length + n.buffer.length);
        fullBuffer.set(n.preBuf, 0);
        fullBuffer.set(n.buffer, n.preBuf.length);
        
        let peak = 0, sum = 0;
        for(let i=0;i<fullBuffer.length;i++){
          const a = Math.abs(fullBuffer[i]);
          if(a > peak) peak = a;
          sum += fullBuffer[i]*fullBuffer[i];
        }
        
        saveRecordingToDB(n, fullBuffer, peak, Math.sqrt(sum / fullBuffer.length));  // асинхронно, не блокирует аудиопоток
        updateRecorderStatus(n);
      }
    }
    
    if(n.recording && n.buffer.length % (BLOCK*10) === 0){
      updateRecorderStatus(n);
    }

    // выбор записи для проигрывания извне графа
    if(typeof I.clipId==='number' && I.clipId>=0 && I.clipId!==n.selected){
      const rec = n.recordings.find(r=>r.id===I.clipId);
      if(rec) recSelect(n, rec, false);
    }
    if(typeof I.play==='number'){
      const gv = I.play>0.5;
      if(gv && !n.playGate){ n.pos=0; n.play=true; }
      n.playGate = gv;
    }
    if(typeof I.rate==='number') setMod(n,'rate',I.rate);
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);

    const o = buf(n,'out');
    if(!n.data || !n.play){ o.fill(0); }
    else {
      const d=n.data, g=n.p.gain, r=n.p.rate*((n.dataSr||Eng.sr)/Eng.sr);
      for(let i=0;i<BLOCK;i++){
        if(n.pos>=d.length-1){
          if(n.p.loop) n.pos=0; else { n.play=false; o[i]=0; continue; }
        }
        const i0=n.pos|0, fr=n.pos-i0;
        o[i]=(d[i0]*(1-fr)+d[i0+1]*fr)*g; n.pos+=r;
      }
    }
    
    return {recording: n.recording ? 1 : 0, out:o, clipId: n.selected};
  },
  draw(n){
    if(!n.initialized && n.el){ initRecorderUI4(n); n.initialized = true; }

    if(n.ro) n.ro.textContent = n.recording
      ? '🔴 recording ' + ((n.buffer.length||0)/Eng.sr).toFixed(1) + 's'
      : (n.selected>=0 ? (n.play?'▶ ':'⏸ ')+'recording #'+n.selected : 'waiting');

    // живая волна пишущегося буфера — свой маленький canvas, независимый от n.size.h
    if(!n.waveCv) return;
    const W = n.waveCv.width, H = n.waveCv.height;
    const cx = n.waveCx;
    cx.clearRect(0,0,W,H);
    const signal = n.buffer;
    if(signal && signal.length > 0){
      const step = Math.max(1, Math.floor(signal.length / W));
      cx.strokeStyle = n.recording ? themeColor('--err') : themeColor('--acc2');
      cx.lineWidth = 1;
      cx.beginPath();
      const halfH = H/2;
      for(let i=0;i<W;i++){
        const idx = Math.min(Math.floor(i*step), signal.length-1);
        const val = signal[idx] || 0;
        const y = halfH - val * halfH * 0.9;
        i===0 ? cx.moveTo(i, y) : cx.lineTo(i, y);
      }
      cx.stroke();
    }
    if(n.recording){
      cx.fillStyle = themeColor('--err'); cx.font = 'bold 9px monospace';
      cx.fillText('● '+((n.buffer.length||0)/Eng.sr).toFixed(1)+'s', W-55, 10);
    }
  }
});


// --- Вспомогательные функции ---

function initRecorderUI4(n){
  const el = n.el;
  if(!el) return;
  
  const mid = el.querySelector('.mid');
  if(!mid || mid.querySelector('.recorder-ui')) return;

  const root = document.createElement('div');
  root.className = 'recorder-ui';
  root.style.cssText = 'display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;font-size:11px;color:#c8d2d6;grid-column:1/-1;width:100%;min-width:0;';
  mid.append(root);
  syncCustomHeight(n, root, 140);

  n.waveCv = document.createElement('canvas');
  n.waveCv.width = 300; n.waveCv.height = 28;
  n.waveCv.style.cssText = 'width:100%;height:28px;flex-shrink:0;';
  n.waveCx = n.waveCv.getContext('2d');
  root.append(n.waveCv);

  n.statusEl = document.createElement('div');
  n.statusEl.style.cssText = 'display:flex;gap:8px;padding:2px 0;font-size:11px;color:#6c7a80;flex-shrink:0;';
  n.statusEl.textContent = '⏹ waiting';
  root.appendChild(n.statusEl);
  
  n.controlsEl = document.createElement('div');
  n.controlsEl.style.cssText = 'display:flex;gap:4px;padding:2px 0;flex-wrap:wrap;flex-shrink:0;';
  n.controlsEl.innerHTML = `
    <button class="rec-play" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 10px;border-radius:3px;cursor:pointer;font-size:10px;">▶</button>
    <button class="rec-stop" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 10px;border-radius:3px;cursor:pointer;font-size:10px;">⏹</button>
    <button class="rec-download" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 10px;border-radius:3px;cursor:pointer;font-size:10px;">⬇ WAV</button>
    <button class="rec-clear" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 10px;border-radius:3px;cursor:pointer;font-size:10px;">🗑</button>
    <span style="flex:1;"></span>
    <span class="rec-info" style="color:#6c7a80;font-size:10px;">0 recordings</span>
  `;
  root.appendChild(n.controlsEl);
  
  n.listContainer = document.createElement('div');
  n.listContainer.style.cssText = 'flex:1;overflow-y:auto;margin-top:3px;border:1px solid #1d2226;border-radius:3px;background:#0e1113;font-size:10px;';
  root.appendChild(n.listContainer);

  n.ui = { root };
  
  const playBtn = n.controlsEl.querySelector('.rec-play');
  const stopBtn = n.controlsEl.querySelector('.rec-stop');
  const downloadBtn = n.controlsEl.querySelector('.rec-download');
  const clearBtn = n.controlsEl.querySelector('.rec-clear');
  
  // ▶ — играть/пауза текущей записи через выход узла (out), нужно подключение к dac
  if(playBtn) playBtn.addEventListener('click', () => {
    if(n.selected<0) return;
    n.play = !n.play;
    updateRecorderStatus(n); updateRecordingList2(n);
  });
  // ⏹ — стоп с перемоткой в начало
  if(stopBtn) stopBtn.addEventListener('click', () => {
    n.play = false; n.pos = 0;
    updateRecorderStatus(n); updateRecordingList2(n);
  });
  if(downloadBtn) downloadBtn.addEventListener('click', () => downloadRecording2(n));
  if(clearBtn) clearBtn.addEventListener('click', () => clearAllRecordings2(n));
  
  n.playBtn = playBtn;
  n.infoEl = n.controlsEl.querySelector('.rec-info');
  
  updateRecordingList2(n);
  updateRecorderStatus(n);
}

function updateRecorderStatus(n){
  if(!n.statusEl) return;
  if(n.recording){
    const dur = (n.buffer.length || 0) / Eng.sr;
    n.statusEl.innerHTML = `🔴 <span style="color:#e05c5c;">RECORDING</span> ${dur.toFixed(1)}s  (${n.buffer.length} samples)`;
    n.statusEl.style.color = '#e05c5c';
  } else {
    n.statusEl.innerHTML = `⏹ ${n.p.mode}  |  recordings: ${n.recordings.length}`;
    n.statusEl.style.color = '#6c7a80';
  }
  if(n.infoEl) n.infoEl.textContent = `${n.recordings.length} recordings`;
  if(n.playBtn) n.playBtn.textContent = n.play ? '⏸' : '▶';
}

function updateRecordingList2(n){
  if(!n.listContainer) return;
  n.listContainer.innerHTML = '';
  
  if(n.recordings.length === 0){
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px;text-align:center;color:#2a3136;font-size:11px;';
    empty.textContent = '⏳ no recordings';
    n.listContainer.appendChild(empty);
    return;
  }
  
  for(let i=n.recordings.length-1; i>=0; i--){
    const rec = n.recordings[i];
    const isSelected = (rec.id === n.selected);
    
    const item = document.createElement('div');
    item.style.cssText = `
      display:flex;
      align-items:center;
      gap:5px;
      padding:2px 6px;
      cursor:pointer;
      border-bottom:1px solid #121619;
      background: ${isSelected ? '#1d2226' : 'transparent'};
      font-size:10px;
      color: ${isSelected ? '#e0b23c' : '#c8d2d6'};
    `;
    item.dataset.id = rec.id;
    
    const mark = document.createElement('span');
    mark.textContent = isSelected ? '▸' : ' ';
    mark.style.color = '#e0b23c';
    mark.style.width = '10px';
    mark.style.fontSize = '8px';
    item.appendChild(mark);
    
    const num = document.createElement('span');
    num.textContent = `#${i+1}`;
    num.style.color = '#6c7a80';
    num.style.width = '22px';
    item.appendChild(num);
    
    const time = document.createElement('span');
    time.textContent = new Date(rec.created).toLocaleTimeString();
    time.style.width = '50px';
    time.style.color = '#6c7a80';
    item.appendChild(time);
    
    const dur = document.createElement('span');
    dur.textContent = rec.duration.toFixed(1) + 's';
    dur.style.width = '34px';
    dur.style.color = '#4ec9b0';
    item.appendChild(dur);
    
    const peakDb = 20 * Math.log10((rec.peak||0) + 0.000001);
    const norm = Math.max(0, Math.min(1, (peakDb + 60) / 60));
    const bar = document.createElement('span');
    bar.style.cssText = `
      display:inline-block;
      width:${Math.max(8, norm * 35)}px;
      height:3px;
      border-radius:2px;
      background: ${peakDb > -20 ? '#4ec9b0' : peakDb > -40 ? '#e0b23c' : '#e05c5c'};
    `;
    item.appendChild(bar);
    
    if(n.play && n.selected === rec.id){
      const play = document.createElement('span');
      play.textContent = '🔊';
      play.style.fontSize = '9px';
      item.appendChild(play);
    }

    const del = document.createElement('span');
    del.textContent = '🗑';
    del.style.cssText = 'margin-left:auto;color:#6c7a80;cursor:pointer;';
    del.addEventListener('click', async ev=>{
      ev.stopPropagation();
      await SampleDB.deleteClip(rec.id);
      if(n.selected===rec.id){ n.selected=-1; n.data=null; n.play=false; }
      refreshRecorderList(n);
    });
    item.appendChild(del);
    
    item.addEventListener('click', () => recSelect(n, rec, true));
    
    n.listContainer.appendChild(item);
  }
}

function downloadRecording2(n){
  const rec = n.recordings.find(r=>r.id===n.selected);
  if(!rec || !rec.samples) return;
  
  const data = rec.samples;
  const sr = rec.sr || 48000;
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  
  const writeString = (offset, str) => {
    for(let i=0; i<str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + data.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, data.length * 2, true);
  
  let offset = 44;
  for(let i=0; i<data.length; i++){
    const sample = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, sample * 32767, true);
    offset += 2;
  }
  
  const blob = new Blob([buffer], {type: 'audio/wav'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date(rec.created).toISOString().replace(/[:.]/g,'-');
  a.download = `recording_${ts}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearAllRecordings2(n){
  if(n.recordings.length === 0) return;
  if(!confirm(`Delete all ${n.recordings.length} recordings?`)) return;
  for(const rec of n.recordings) await SampleDB.deleteClip(rec.id);
  n.selected = -1;
  n.data = null;
  n.play = false;
  refreshRecorderList(n);
}

def({ id:'csv', title:'CSV Log', cat:'Output',
  ins:[{n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'},{n:'period',t:'num'},{n:'max',t:'num'}],
  outs:[{n:'rows',t:'num'}], readout:true, tall:true,
  params:[{n:'period',t:'range',min:.05,max:60,step:.05,d:1,label:'period, s'},
          {n:'max',t:'range',min:100,max:100000,step:100,d:10000,label:'max rows'},
          {n:'names',t:'text',d:'a,b,c,d',label:'headers'},
          {n:'rec',t:'button',label:'Record / stop',fn:n=>{n.on=!n.on;}},
          {n:'save',t:'button',label:'Save CSV',fn:n=>csvSave(n)},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.rows=[];}}],
  init:n=>{n.rows=[];n.on=false;n.t=0;n.t0=0;},
  process(n,I){
    if(typeof I.period==='number') setMod(n,'period',I.period);
    if(typeof I.max==='number') setMod(n,'max',I.max);
    const dt=BLOCK/Eng.sr;
    if(!n.on) return {rows:n.rows.length};
    if(!n.t0) n.t0=Date.now();
    n.t+=dt;
    if(n.t>=n.p.period){
      n.t=0;
      const row=[((Date.now()-n.t0)/1000).toFixed(3),
        fmtN(I.a), fmtN(I.b), fmtN(I.c), fmtN(I.d)];
      n.rows.push(row);
      if(n.rows.length>n.p.max) n.rows.shift(); }
    return {rows:n.rows.length}; },
  draw(n){ const r=n.el.querySelector('.readout');
    const tail=n.rows.slice(-6).map(x=>x.join('  ')).join('\n');
    const t=(n.on?'● recording':'stopped')+' · rows '+n.rows.length+'\n'+tail;
    if(r.textContent!==t) r.textContent=t; }});

function fmtN(v){ return (typeof v==='number'&&isFinite(v))? v.toFixed(6) : ''; }
function csvSave(n){
  const names=String(n.p.names).split(',').map(s=>s.trim());
  const head=['t_s',...names].join(',');
  const body=n.rows.map(r=>r.join(',')).join('\n');
  dl(new Blob([head+'\n'+body],{type:'text/csv'}),'log-'+Date.now()+'.csv');
}

def({ id:'geiger', title:'Geiger Counter', cat:'Output',
  ins:[{n:'in',t:'num'},{n:'minRate',t:'num'},{n:'maxRate',t:'num'},{n:'toneFreq',t:'num'},
       {n:'volume',t:'num'},{n:'smooth',t:'num'},{n:'invert',t:'num'}],
  outs:[{n:'audio',t:'sig'},{n:'rate',t:'num'}],
  readout:true,
  params:[
    {n:'minVal',t:'num',d:0,label:'min value'},
    {n:'maxVal',t:'num',d:1,label:'max value'},
    {n:'minRate',t:'range',min:0.1,max:10,step:0.1,d:0.5,label:'min rate, Hz'},
    {n:'maxRate',t:'range',min:1,max:50,step:0.5,d:20,label:'max rate, Hz'},
    {n:'toneFreq',t:'range',min:500,max:4000,step:10,d:1800,label:'tone frequency, Hz'},
    {n:'volume',t:'range',min:0,max:1,step:0.01,d:0.3,label:'volume'},
    {n:'smooth',t:'range',min:0.01,max:0.99,step:0.01,d:0.5,label:'smoothing'},
    {n:'invert',t:'check',d:false,label:'invert'}
  ],
  init:n=>{
    n.smoothVal = 0;
    n.rate = 0;
    n.timer = 0;
    n.pulse = 0;
    n.ph = 0;
    n.history = [];
    n.counter = 0;
    n.prevVal = 0;
  },
  process(n,I){
    for(const k of ['minRate','maxRate','toneFreq','volume','smooth'])
      if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.invert==='number') setMod(n,'invert',I.invert>=0.5);
    const dt = BLOCK / Eng.sr;
    
    // Входное число
    let rawVal = 0;
    if(I && I.in !== undefined && I.in !== null) {
      rawVal = typeof I.in === 'number' ? I.in : 0;
    }
    
    // Сглаживание
    const sm = n.p.smooth || 0.5;
    n.smoothVal = n.smoothVal * sm + rawVal * (1 - sm);
    
    // Нормализация
    const minV = n.p.minVal || 0;
    const maxV = n.p.maxVal || 1;
    const range = maxV - minV;
    let norm = range > 0 ? (n.smoothVal - minV) / range : 0.5;
    if(n.p.invert) norm = 1 - norm;
    norm = Math.max(0, Math.min(1, norm));
    
    // Частота кликов
    const minRate = n.p.minRate || 0.5;
    const maxRate = n.p.maxRate || 20;
    n.rate = minRate + (maxRate - minRate) * norm;
    
    // Аудио-выход
    const audioOut = buf(n,'audio');
    const rateOut = buf(n,'rate');
    const pulseLen = Math.max(1, Math.round(0.004 * Eng.sr));
    const toneFreq = n.p.toneFreq || 1800;
    const volume = n.p.volume || 0.3;
    
    // Генерация
    const period = 1 / Math.max(0.01, n.rate);
    
    for(let i=0;i<BLOCK;i++){
      // Импульс
      if(n.pulse > 0){
        n.pulse--;
        const env = n.pulse / pulseLen;
        audioOut[i] = Math.sin(2 * Math.PI * n.ph) * volume * env * 0.8;
      } else {
        audioOut[i] = 0;
      }
      
      n.ph += toneFreq / Eng.sr;
      if(n.ph >= 1) n.ph -= 1;
      
      // Таймер следующего клика
      n.timer += dt;
      if(n.timer >= period && n.rate > 0.1){
        n.timer = 0;
        n.pulse = pulseLen;
        n.counter++;
      }
      
      rateOut[i] = n.rate;
    }
    
    // История
    n.history.push(n.rate);
    if(n.history.length > 150) n.history.shift();
    
    return {audio: audioOut, rate: n.rate};
  },
  draw(n, cv, cx){
    const W = cv.width || 200;
    const H = cv.height || 80;
    cx.clearRect(0,0,W,H);
    
    // История частоты
    cx.strokeStyle = themeColor('--acc2');
    cx.lineWidth = 1.5;
    cx.beginPath();
    const maxRate = (n.p.maxRate || 20) + 5;
    for(let i=0;i<n.history.length;i++){
      const x = i / n.history.length * W;
      const y = H - (n.history[i] / maxRate) * (H - 30);
      i===0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
    }
    cx.stroke();
    
    // Текущее значение
    const val = n.smoothVal || 0;
    cx.fillStyle = themeColor('--acc');
    cx.font = 'bold 18px monospace';
    const valStr = val.toFixed(3);
    cx.fillText(valStr, W - cx.measureText(valStr).width - 4, 22);
    
    // Частота
    cx.fillStyle = themeColor('--axis');
    cx.font = '10px monospace';
    cx.fillText(`${(n.rate||0).toFixed(1)} clk/s`, 4, 12);
    
    // Шкала
    const minV = n.p.minVal || 0;
    const maxV = n.p.maxVal || 1;
    const norm = Math.max(0, Math.min(1, (val - minV) / (maxV - minV)));
    
    const barH = 6;
    const barY = H - barH - 2;
    cx.fillStyle = themeColor('--scr-panel');
    cx.fillRect(2, barY, W-4, barH);
    
    const grad = cx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0, themeColor('--grid'));
    grad.addColorStop(0.3, themeColor('--acc2'));
    grad.addColorStop(0.7, themeColor('--acc'));
    grad.addColorStop(1, themeColor('--err'));
    cx.fillStyle = grad;
    cx.fillRect(2, barY, (W-4) * norm, barH);
    
    cx.fillStyle = themeColor('--grid');
    cx.font = '8px monospace';
    cx.fillText(minV.toFixed(2), 2, barY-1);
    cx.fillText(maxV.toFixed(2), W-36, barY-1);
    
    // Индикатор клика
    if(n.pulse > 0){
      cx.fillStyle = themeColor('--err');
      cx.fillRect(W-20, 4, 8, 8);
      cx.globalAlpha = 0.2;
      cx.fillStyle = themeColor('--err');
      cx.beginPath();
      cx.arc(W-16, 8, 16, 0, 2*Math.PI);
      cx.fill();
      cx.globalAlpha = 1;
    }
    
    cx.fillStyle = themeColor('--acc2');
    cx.font = '9px monospace';
    cx.fillText((n.rate||0) > 0.5 ? '⚡ active' : '💤 silent', 4, H-4);
  }
});


function ft8Stamp(ms){
  const d=new Date(ms);
  const p=v=>String(v).padStart(2,'0');
  return p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+'Z';
}
function ft8Text(n){
  const head=(n.warn?'⚠ '+n.warn+'\n':'')+'slots in log: '+n.log.length+
    ' · a transmission takes 12.64s from slot start +0.5s\n'+
    'sync below 18/21 usually does not decode\n';
  n.text=head+n.log.map(e=>{
    const lines=[e.stamp+'  '+(e.n?e.n+' sig.':'empty')+'  (parsed in '+e.ms+' ms)'];
    for(const c of e.list){
      const t0=0.5+c.dt;
      lines.push('   '+c.f.toFixed(1).padStart(7)+' Hz  start +'+t0.toFixed(2)+
        ' s  end +'+(t0+12.64).toFixed(2)+' s  strength '+c.sc.toFixed(2)+
        '  sync '+(c.sync!=null?c.sync:'?')+'/21');
      if(c.msg) lines.push('     ► '+c.msg);
      else if(c.hex) lines.push('     packet '+c.hex);
      if(c.syms) lines.push('     tones  '+c.syms); }
    return lines.join('\n');
  }).join('\n');
}
function ft8Save(n){
  const txt=n.log.map(e=>e.stamp+'\t'+e.list.map(c=>
    c.f.toFixed(1)+' Hz\tdt '+c.dt.toFixed(2)+'\tstrength '+c.sc.toFixed(2)+
    '\tsync '+c.sync+'/21\t'+(c.msg||c.hex||'')+
    (c.syms?'\t'+c.syms:'')).join('\n\t')).join('\n');
  dl(new Blob([txt],{type:'text/plain'}),'ft8-log-'+Date.now()+'.txt');
}
function ft8Spec(n){                                 // спектрограмма слота, шаг сетки 3.125 Гц
  const L=n.buf.length, frames=Math.floor((L-FT8_WIN)/FT8_HOP)+1, bins=FT8_FFT/2;
  if(!n.win) n.win=window_('hann',FT8_WIN);
  const re=new Float32Array(FT8_FFT), im=new Float32Array(FT8_FFT);
  const mag=new Float32Array(frames*bins);
  for(let f=0;f<frames;f++){
    const off=(n.wp+f*FT8_HOP)%L;
    re.fill(0); im.fill(0);
    for(let k=0;k<FT8_WIN;k++) re[k]=n.buf[(off+k)%L]*n.win[k];
    fft(re,im);
    for(let b=0;b<bins;b++) mag[f*bins+b]=Math.hypot(re[b],im[b]);
  }
  return {mag,frames,bins};
}
function ft8Run(n,manual,slotMs){
  const t0=performance.now();
  const {mag,frames,bins}=ft8Spec(n);
  const hz=FT8_SR/FT8_FFT;                           // 3.125 Гц, тон = 2 бина
  const b0=Math.max(1,Math.floor(n.p.fmin/hz)), b1=Math.min(bins-9*FT8_TS,Math.ceil(n.p.fmax/hz));
  const maxOff=frames-4*FT8_SYMS-1;
  if(maxOff<1){ n.text='not enough data'; return; }
  const budget=n.p.budget||800;
  const cand=[];
  for(let b=b0;b<=b1;b++) for(let t=0;t<=maxOff;t++){
    let sc=0;
    for(const g of [0,36,72]) for(let k=0;k<7;k++){
      const fr=(t+4*(g+k))*bins;
      let sum=0; for(let q=0;q<8;q++) sum+=mag[fr+b+q*FT8_TS];
      sc += mag[fr+b+FT8_COSTAS[k]*FT8_TS]/(sum/8+1e-12); }
    cand.push([sc/21,b,t]);
  }
  cand.sort((a,c)=>c[0]-a[0]);
  const picked=[];
  for(const c of cand){
    if(c[0]<n.p.thr) break;
    if(picked.some(p=>Math.abs(p[1]-c[1])<4*FT8_TS&&Math.abs(p[2]-c[2])<6)) continue;
    picked.push(c);
    if(picked.length>=n.p.top) break;
  }
  const list=picked.map(([sc,b,t])=>{
    const e={f:b*hz, dt:(t*FT8_HOP/FT8_SR)-0.5, sc};
    {
      const syms=[], conf=[];
      for(let s=0;s<FT8_SYMS;s++){
        const fr=(t+4*s)*bins; let best=0,bv=-1,second=-1;
        for(let q=0;q<8;q++){ const v=mag[fr+b+q*FT8_TS];
          if(v>bv){ second=bv; bv=v; best=q; } else if(v>second) second=v; }
        syms.push(best); conf.push(bv/(second+1e-12)); }
      // качество: во сколько раз выигрывает верный тон, и совпали ли блоки Костаса
      let sync=0;
      for(const g of [0,36,72]) for(let k=0;k<7;k++) if(syms[g+k]===FT8_COSTAS[k]) sync++;
      e.sync=sync;
      const p=ft8Payload(syms);
      e.hex=p.hex; e.bits=p.bits;
      if(n.p.tones) e.syms=syms.join('');
      if(n.p.decode){                                 // мягкие метрики → LDPC → CRC → текст
        const llr=new Float64Array(174);
        for(const dt2 of [0,1,-1,2,-2]){              // мелкая подстройка времени и частоты
          let done=false;
          if(performance.now()-t0>budget) break;       // не залезаем в аудиопоток
          for(const db2 of [0,1,-1]){
            const bb=b+db2, tt=t+dt2;
            if(bb<1||bb+7*FT8_TS>=bins||tt<0||tt+4*FT8_SYMS>=frames) continue;
            let bi2=0;
            for(let s2=0;s2<FT8_SYMS;s2++){
              if((s2<7)||(s2>=36&&s2<43)||(s2>=72)) continue;
              const fr=(tt+4*s2)*bins;
              const lg=[];
              let mean=0;
              for(let q=0;q<8;q++){ const v=Math.log(mag[fr+bb+q*FT8_TS]+1e-12); lg.push(v); mean+=v; }
              mean/=8;
              for(let k=2;k>=0;k--){
                let m0=-1e9, m1=-1e9;
                for(let q=0;q<8;q++){
                  const v=FT8_UNGRAY[q], lv=lg[q]-mean;   // нормировка по символу
                  if((v>>k)&1){ if(lv>m1) m1=lv; } else { if(lv>m0) m0=lv; } }
                llr[bi2++]=(m0-m1)*2.5; } }
            const dec=ft8Ldpc(llr,60);
            if(dec.ok){
              const k91=[...dec.bits].slice(0,91);
              if(ft8CrcOk(k91)){
                e.msg=ft8Unpack(k91.slice(0,77)); e.crc=true;
                e.f=(bb)*hz; e.dt=(tt*FT8_HOP/FT8_SR)-0.5;
                done=true; break; } } }
          if(done) break; }
      } }
    return e; });
  if(list.length){ n.f=list[0].f; n.sc=list[0].sc; n.dt=list[0].dt; }
  else { n.f=0; n.sc=0; }
  if(Eng.turbo>1) n.warn='speed ×'+Eng.turbo+' breaks slot alignment — set it back to ×1';
  else n.warn='';
  n.log.unshift({stamp:ft8Stamp(slotMs!=null?slotMs:Date.now())+(manual?' (manual)':''),
                 n:list.length, list, ms:(performance.now()-t0).toFixed(0)});
  while(n.log.length>n.p.keep) n.log.pop();
  ft8Text(n);
}

/* ---------- вывод ---------- */
def({ id:'dac', title:'Sound Card', cat:'Output', readout:true,
  ins:[{n:'L',t:'sig'},{n:'R',t:'sig'},{n:'vol',t:'num'},{n:'pan',t:'num'},{n:'mute',t:'num'}],
  params:[{n:'dev',t:'select',d:'default',label:'device',
           opts:()=>['default',...Eng.outDevices.map(d=>d.label)]},
          {n:'pick',t:'button',label:'show devices',
           fn:n=>Eng.pickOutput().then(l=>{ if(l){ n.p.dev=l; n.set?.dev?.(); } })},
          {n:'vol',t:'range',min:0,max:1,step:.01,d:.3},
          {n:'mode',t:'select',opts:['mono','stereo','L→both','R→both'],d:'mono'},
          {n:'pan',t:'range',min:-1,max:1,step:.01,d:0},
          {n:'mute',t:'check',d:false}],
  init:n=>{ n.gl=null; n.gr=null; n.peak=0; n.clipT=-1e9; n.status=''; },
  process(n,I){
    if(typeof I.vol==='number') setMod(n,'vol',I.vol);
    if(typeof I.pan==='number') setMod(n,'pan',I.pan);
    if(typeof I.mute==='number') setMod(n,'mute',I.mute>=0.5);
    const bus=dacBus(n);
    const L=I.L, R=I.R, m=n.p.mode, v=n.p.mute?0:n.p.vol;
    let tl=v, tr=v;
    if(m==='mono'){ const p=clamp(n.p.pan,-1,1);   // панорама равной мощности
      tl*=Math.cos((p+1)*Math.PI/4)*1.414; tr*=Math.sin((p+1)*Math.PI/4)*1.414; }
    // усиление плавно ведём за блок — без щелчков при движении vol/pan/mute
    const al=n.gl??tl, ar=n.gr??tr; n.gl=tl; n.gr=tr;
    if(bus<0 || (!al&&!ar&&!tl&&!tr) || (!L&&!R)){ n.peak=0; return {}; }
    const oL=Eng.outs[2*bus], oR=Eng.outs[2*bus+1];
    const dl=(tl-al)/BLOCK, dr=(tr-ar)/BLOCK;
    let pk=0;
    for(let i=0;i<BLOCK;i++){
      const a=L?L[i]:0, b=R?R[i]:0;
      let l,r;
      if(m==='stereo'){ l=a; r=b; }
      else if(m==='L→both'){ l=r=a; }
      else if(m==='R→both'){ l=r=b; }
      else { l=r=a+b; }
      l*=al+dl*(i+1); r*=ar+dr*(i+1);
      const x=Math.max(Math.abs(l),Math.abs(r)); if(x>pk) pk=x;
      oL[i]+=clamp(l,-1,1); oR[i]+=clamp(r,-1,1); }
    n.peak=pk; if(pk>1) n.clipT=performance.now();
    return {}; },
  draw(n){
    const db=n.peak>1e-6? (20*Math.log10(n.peak)).toFixed(1)+' dBFS' : '−∞ dBFS';
    const clip=performance.now()-n.clipT<1000? ' CLIP' : '';
    n.el.querySelector('.readout').textContent=(n.status? n.status+' · ' : '')+db+clip; }});

// шина движка для выбранного устройства; статус — в readout узла
function dacBus(n){
  if(n.p.dev==='default'){ n.status=''; return 0; }
  const d=Eng.outDevices.find(x=>x.label===n.p.dev);
  if(!d){ n.status='device not found → default'; return 0; }
  if(!Eng.sinkSupported){ n.status='device selection unsupported → default'; return 0; }
  const k=Eng.busFor(d.id);
  if(k<0){ n.status='too many devices (max '+(Eng.NBUS-1)+' extra)'; return -1; }
  n.status=Eng.sinkErr(k); return k;
}


def({ id:'flash', title:'Screen Transmitter', cat:'Output', ins:[{n:'in',t:'num'},{n:'lo',t:'num'},{n:'hi',t:'num'}],
  swatch:true,
  params:[{n:'on',t:'button',label:'Fullscreen',fn:n=>{
            if(!n.ov){ n.ov=document.createElement('div');
              n.ov.style.cssText='position:fixed;inset:0;z-index:99;background:#000';
              n.ov.addEventListener('pointerdown',()=>{ n.ov.remove(); n.vis=false; });
              document.body.append(n.ov); n.vis=true; }
            else if(!n.vis){ document.body.append(n.ov); n.vis=true; }
            else { n.ov.remove(); n.vis=false; } }},
          {n:'lo',t:'range',min:0,max:1,step:.01,d:0},
          {n:'hi',t:'range',min:0,max:1,step:.01,d:1}],
  process(n,I){
    if(typeof I.lo==='number') setMod(n,'lo',I.lo);
    if(typeof I.hi==='number') setMod(n,'hi',I.hi);
    n.v=I.in||0; return {}; },
  draw(n){ const t=clamp(n.v,0,1), b=Math.round((n.p.lo+(n.p.hi-n.p.lo)*t)*255);
    const c=`rgb(${b},${b},${b})`;
    n.el.querySelector('.swatch').style.background=c;
    if(n.ov&&n.vis) n.ov.style.background=c; }});


def({ id:'color', title:'Color', cat:'Output', ins:[{n:'in',t:'num'}], swatch:true,
  params:[{n:'min',t:'num',d:0},{n:'max',t:'num',d:1},
          {n:'mode',t:'select',opts:['hue','gray','heat'],d:'hue'}],
  process(n,I){ n.v=I.in||0; return {}; },
  draw(n){ const t=clamp((n.v-n.p.min)/((n.p.max-n.p.min)||1),0,1);
    const sw=n.el.querySelector('.swatch');
    sw.style.background = n.p.mode==='gray'? `rgb(${t*255|0},${t*255|0},${t*255|0})`
      : n.p.mode==='heat'? `rgb(${heat(t).join(',')})`
      : `hsl(${t*300|0} 80% 55%)`; }});


def({ id:'fmtview', title:'Template Indicator', cat:'Output', ins:[{n:'in',t:'num'},{n:'sig',t:'sig'}],
  readout:true, params:[{n:'fmt',t:'text',d:'{v} | rms {r}'}],
  process(n,I){ n.v=I.in; n.r=I.sig?rms(I.sig):null; return {}; },
  draw(n){ n.el.querySelector('.readout').textContent = String(n.p.fmt)
    .replace('{v}', typeof n.v==='number'? n.v.toFixed(3):'—')
    .replace('{r}', n.r!=null? n.r.toFixed(4):'—'); }});


def({ id:'rec', title:'Record WAV', cat:'Output', ins:[{n:'in',t:'sig'}], readout:true,
  params:[{n:'go',t:'button',label:'Record / stop',fn:n=>{
            n.on=!n.on; if(n.on) n.chunks=[]; else wavDownload(n.chunks,Eng.sr); }}],
  init:n=>{n.on=false;n.chunks=[];},
  process(n,I){ if(n.on&&I.in) n.chunks.push(I.in.slice()); return {}; },
  draw(n){ n.el.querySelector('.readout').textContent = n.on
    ? '● '+(n.chunks.length*BLOCK/Eng.sr).toFixed(1)+' s' : 'ready'; }});


function wavDownload(chunks,sr){
  const len=chunks.reduce((a,c)=>a+c.length,0);
  const b=new ArrayBuffer(44+len*2), v=new DataView(b);
  const wr=(o,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4,36+len*2,true); wr(8,'WAVEfmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true);
  v.setUint16(34,16,true); wr(36,'data'); v.setUint32(40,len*2,true);
  let o=44; for(const c of chunks) for(let i=0;i<c.length;i++){
    v.setInt16(o,clamp(c[i],-1,1)*32767,true); o+=2; }
  dl(new Blob([b],{type:'audio/wav'}),'record.wav');
}
function dl(blob,name){ const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000); }

def({ id:'planeMap', title:'Aircraft Map', cat:'Output',
  ins:[{n:'trig',t:'num'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'id',t:'txt'},
       {n:'gsTrig',t:'num'},{n:'gsLat',t:'num'},{n:'gsLon',t:'num'},{n:'gsName',t:'txt'}],
  view:{h:300}, resize:true,
  params:[{n:'ttl',t:'range',min:1,max:120,step:1,d:30,label:'keep, min'},
          {n:'clr',t:'button',label:'Clear',fn:n=>{n.tracks={}; n.stations={};}}],
  init:n=>{n.tracks={}; n.stations={}; n.prevTrig=0; n.prevGsTrig=0;},
  process(n,I){
    // num-порты в этом движке — обычные числа, не поблочные буферы (в отличие от 'sig')
    const trig=typeof I.trig==='number'?I.trig:0;
    if(trig>0.5 && n.prevTrig<=0.5){
      const lat=typeof I.lat==='number'?I.lat:null, lon=typeof I.lon==='number'?I.lon:null;
      const id=(typeof I.id==='string'&&I.id)?I.id:'?';
      if(typeof lat==='number'&&typeof lon==='number'&&isFinite(lat)&&isFinite(lon))
        n.tracks[id]={lat,lon,t:Date.now()};
    }
    n.prevTrig=trig;
    // наземные станции — координаты фиксированные (справочник), просто держим "живой" отметкой
    const gsTrig=typeof I.gsTrig==='number'?I.gsTrig:0;
    if(gsTrig>0.5 && n.prevGsTrig<=0.5){
      const lat=typeof I.gsLat==='number'?I.gsLat:null, lon=typeof I.gsLon==='number'?I.gsLon:null;
      const name=(typeof I.gsName==='string'&&I.gsName)?I.gsName:'📡 ?';
      if(typeof lat==='number'&&typeof lon==='number'&&isFinite(lat)&&isFinite(lon))
        n.stations[name]={lat,lon,t:Date.now()};
    }
    n.prevGsTrig=gsTrig;
    return {};
  },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height;
    cx.fillStyle=themeColor('--screen'); cx.fillRect(0,0,W,H);
    cx.strokeStyle='rgba(255,255,255,.12)'; cx.lineWidth=1;
    for(let lon=-180;lon<=180;lon+=30){ const x=(lon+180)/360*W;
      cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); }
    for(let lat=-90;lat<=90;lat+=30){ const y=(90-lat)/180*H;
      cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke(); }
    cx.strokeStyle='rgba(255,255,255,.35)';               // экватор и нулевой меридиан ярче
    cx.beginPath(); cx.moveTo(W/2,0); cx.lineTo(W/2,H); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke();
    const now=Date.now(), ttl=n.p.ttl*60000;
    // станции — квадратик, фикс. цвет, не протухают по ttl (их положение не меняется,
    // просто убираем совсем старые, если станция давно не упоминалась в трафике)
    for(const name in n.stations){
      const t=n.stations[name];
      if(now-t.t>ttl*4){ delete n.stations[name]; continue; }
      const x=(t.lon+180)/360*W, y=(90-t.lat)/180*H;
      cx.fillStyle=themeColor('--t-img');
      cx.fillRect(x-4,y-4,8,8);
      cx.fillStyle=themeColor('--t-img'); cx.font='11px monospace';
      cx.fillText(name,x+7,y-6);
    }
    // самолёты — кружок, гаснет с возрастом
    for(const id in n.tracks){
      const t=n.tracks[id];
      if(now-t.t>ttl){ delete n.tracks[id]; continue; }    // протухшие цели убираем
      const x=(t.lon+180)/360*W, y=(90-t.lat)/180*H, age=(now-t.t)/ttl;
      cx.fillStyle=`rgba(224,178,60,${1-age*.7})`;
      cx.beginPath(); cx.arc(x,y,4,0,2*Math.PI); cx.fill();
      cx.fillStyle=themeColor('--acc'); cx.font='11px monospace';
      cx.fillText(id,x+6,y-6);
    }
  }});
