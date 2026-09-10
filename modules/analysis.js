// ---
def({ id:'birdSong', title:'Анализатор пения птиц', cat:'Анализ',
  ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'sensitivity',t:'num'},
       {n:'minDuration',t:'num'},{n:'maxGap',t:'num'},{n:'clusters',t:'num'}],
  outs:[{n:'syllable',t:'txt'},{n:'frequency',t:'num'},{n:'activity',t:'num'}],
  view:{h:200}, resize:true, readout:true,
  params:[{n:'fmin',t:'range',min:500,max:10000,step:50,d:1000,label:'мин. частота, Гц'},
          {n:'fmax',t:'range',min:1000,max:()=>Eng.sr/2,step:50,d:8000,label:'макс. частота, Гц'},
          {n:'sensitivity',t:'range',min:0.01,max:0.5,step:0.01,d:0.05,label:'чувствительность'},
          {n:'minDuration',t:'range',min:10,max:200,step:5,d:30,label:'мин. длительность, мс'},
          {n:'maxGap',t:'range',min:20,max:500,step:10,d:100,label:'макс. пауза, мс'},
          {n:'clusters',t:'range',min:2,max:16,step:1,d:8,label:'количество кластеров'},
          {n:'display',t:'select',opts:['водопад','граф','оба'],d:'оба'}],
  init:n=>{
    n.syllables = [];
    n.currentSyllable = null;
    n.history = [];
    n.clusters = [];
    n.graph = {};
    n.displayText = '';
    n.buffer = null;
    n.w = 0;
    n.lastActivity = 0;
    n.birdActive = false;
    n.syllableId = 0;
    n.spectrogram = [];
    n.patterns = [];
    n.matchedPattern = '';
  },
  process(n,I){
    for(const k of ['fmin','fmax','sensitivity','minDuration','maxGap','clusters'])
      if(typeof I[k]==='number') setMod(n,k,I[k]);
    const dt = BLOCK / Eng.sr;
    const N = 1024;
    
    // Накопление буфера для спектрограммы
    if(!n.buf || n.buf.length !== N){
      n.buf = new Float32Array(N);
      n.w = 0;
    }
    
    // Вычисляем RMS для детекции активности
    let rms = 0;
    let peak = 0;
    for(let i=0;i<BLOCK;i++){
      const v = I.in ? I.in[i] : 0;
      rms += v*v;
      if(Math.abs(v) > peak) peak = Math.abs(v);
      n.buf[n.w] = v;
      n.w = (n.w+1) % N;
    }
    rms = Math.sqrt(rms / BLOCK);
    
    // Детекция активности (птица поёт)
    const threshold = n.p.sensitivity * 0.5;
    const isActive = rms > threshold || peak > threshold * 3;
    
    // --- Сегментация на слоги ---
    const minDurSamples = n.p.minDuration * Eng.sr / 1000;
    const maxGapSamples = n.p.maxGap * Eng.sr / 1000;
    
    if(isActive && !n.birdActive){
      // Начало слога
      n.birdActive = true;
      n.currentSyllable = {
        id: n.syllableId++,
        start: performance.now(),
        chunks: [], len: 0,        // копим блоками, а не поэлементно — склеим в один Float32Array при завершении слога
        freq: 0,
        bandwidth: 0,
        duration: 0
      };
    }
    
    if(n.birdActive){
      // Добавляем отсчёты в текущий слог
      if(n.currentSyllable){
        const chunk = I.in ? I.in.slice(0, BLOCK) : new Float32Array(BLOCK);
        n.currentSyllable.chunks.push(chunk);
        n.currentSyllable.len += chunk.length;
      }
      n.lastActivity = 0;
    } else {
      n.lastActivity += dt;
    }
    
    // Конец слога (тишина или слишком долго)
    if(n.birdActive && (!isActive || n.lastActivity > maxGapSamples/Eng.sr)){
      if(n.currentSyllable && n.currentSyllable.len > minDurSamples){
        // Анализируем слог
        const syl = n.currentSyllable;
        const data = new Float32Array(syl.len);
        let off=0; for(const c of syl.chunks){ data.set(c,off); off+=c.length; }
        
        // БПФ для определения частоты
        const M = 512;
        const re = new Float32Array(M);
        const im = new Float32Array(M);
        const step = Math.max(1, Math.floor(data.length / M));
        for(let i=0; i<M && i*step<data.length; i++){
          re[i] = data[i*step] * (0.5 - 0.5*Math.cos(2*Math.PI*i/M));
        }
        fft(re, im);
        
        // Поиск пика в диапазоне
        const fMinBin = Math.floor(n.p.fmin / Eng.sr * M);
        const fMaxBin = Math.ceil(n.p.fmax / Eng.sr * M);
        let maxAmp = 0, maxIdx = fMinBin;
        for(let i=fMinBin; i<Math.min(M/2, fMaxBin); i++){
          const amp = Math.hypot(re[i], im[i]);
          if(amp > maxAmp){ maxAmp = amp; maxIdx = i; }
        }
        
        syl.freq = maxIdx * Eng.sr / M;
        syl.duration = data.length / Eng.sr * 1000;
        
        // Ширина полосы (BW)
        let halfPower = false;
        let bwLow = maxIdx, bwHigh = maxIdx;
        const target = maxAmp * 0.5;
        for(let i=maxIdx; i>fMinBin; i--){
          const amp = Math.hypot(re[i], im[i]);
          if(amp < target && !halfPower){ bwLow = i; halfPower = true; }
        }
        halfPower = false;
        for(let i=maxIdx; i<Math.min(M/2, fMaxBin); i++){
          const amp = Math.hypot(re[i], im[i]);
          if(amp < target && !halfPower){ bwHigh = i; halfPower = true; }
        }
        syl.bandwidth = (bwHigh - bwLow) * Eng.sr / M;
        
        // Добавляем в историю
        n.syllables.push(syl);
        if(n.syllables.length > 200) n.syllables.shift();
        
        // Обновляем граф переходов
        if(n.syllables.length > 1){
          const prev = n.syllables[n.syllables.length-2];
          const key = `${Math.round(prev.freq/100)}_${Math.round(prev.bandwidth/50)}`;
          const nextKey = `${Math.round(syl.freq/100)}_${Math.round(syl.bandwidth/50)}`;
          if(!n.graph[key]) n.graph[key] = {};
          n.graph[key][nextKey] = (n.graph[key][nextKey] || 0) + 1;
        }
        
        // Кластеризация
        if(n.syllables.length % 5 === 0){
          n.clusters = clusterSyllables(n.syllables, n.p.clusters);
        }
        
        // Попытка распознать паттерн
        const pattern = recognizePattern(n.syllables);
        if(pattern) n.matchedPattern = pattern;
      }
      n.birdActive = false;
      n.currentSyllable = null;
    }
    
    // Обновление активности
    n.lastActivity = isActive ? 0 : n.lastActivity;
    
    return {
      syllable: n.matchedPattern || '...',
      frequency: n.currentSyllable ? n.currentSyllable.freq : 0,
      activity: isActive ? 1 : 0
    };
  },
  draw(n, cv, cx){
    const W = cv.width || 300;
    const H = cv.height || 200;
    cx.clearRect(0,0,W,H);
    
    // Разделяем экран
    const split = 0.6;
    const wfW = W * split;
    const graphW = W * (1 - split);
    const display = n.p.display;
    
    // --- 1. Водопад / спектрограмма (слева) ---
    if(display === 'водопад' || display === 'оба'){
      // Рисуем спектрограмму из истории слогов
      const colors = ['#4ec9b0', '#e0b23c', '#e05c5c', '#569cd6', '#d18ad1', '#7fd17f'];
      
      // Фон
      cx.fillStyle = '#0a0d0e';
      cx.fillRect(0, 0, wfW, H);
      
      // Рисуем слоги
      const syll = n.syllables;
      const start = Math.max(0, syll.length - 60);
      
      for(let i=start; i<syll.length; i++){
        const s = syll[i];
        const x = (i - start) / Math.min(60, syll.length) * wfW;
        const y = (s.freq - n.p.fmin) / (n.p.fmax - n.p.fmin) * H;
        const size = Math.max(2, Math.min(8, s.duration / 20));
        const colorIdx = Math.floor(s.freq / 1000) % colors.length;
        
        cx.fillStyle = colors[colorIdx];
        cx.globalAlpha = 0.6 + 0.4 * (s.bandwidth / 500);
        cx.beginPath();
        cx.arc(x, H - y, size, 0, 2*Math.PI);
        cx.fill();
      }
      cx.globalAlpha = 1;
      
      // Текущий слог (подсветка)
      if(n.currentSyllable){
        const s = n.currentSyllable;
        const x = wfW - 10;
        const y = (s.freq - n.p.fmin) / (n.p.fmax - n.p.fmin) * H;
        cx.strokeStyle = '#ffffff';
        cx.lineWidth = 2;
        cx.beginPath();
        cx.arc(x, H - y, 12, 0, 2*Math.PI);
        cx.stroke();
        cx.fillStyle = '#ffffff44';
        cx.beginPath();
        cx.arc(x, H - y, 8, 0, 2*Math.PI);
        cx.fill();
        
        // Длительность
        cx.fillStyle = '#6c7a80';
        cx.font = '8px monospace';
        cx.fillText(`${s.duration.toFixed(0)} мс`, x-20, H-y-16);
      }
      
      // Шкала частот
      cx.fillStyle = '#2a3136';
      cx.font = '8px monospace';
      const fStep = Math.round((n.p.fmax - n.p.fmin) / 4);
      for(let f=n.p.fmin; f<=n.p.fmax; f+=fStep){
        const y = (f - n.p.fmin) / (n.p.fmax - n.p.fmin) * H;
        cx.fillText(`${(f/1000).toFixed(1)}k`, 2, H-y+3);
      }
    }
    
    // --- 2. Граф переходов (справа) ---
    if(display === 'граф' || display === 'оба'){
      const gx = display === 'оба' ? wfW : 0;
      const gw = display === 'оба' ? graphW : W;
      
      cx.fillStyle = '#0a0d0e';
      cx.fillRect(gx, 0, gw, H);
      
      // Рисуем граф переходов
      const graph = n.graph;
      const keys = Object.keys(graph);
      if(keys.length > 1){
        // Вычисляем позиции узлов (по кругу)
        const centerX = gx + gw/2;
        const centerY = H/2;
        const radius = Math.min(gw, H) * 0.35;
        const nodePos = {};
        
        keys.forEach((key, i) => {
          const angle = (i / keys.length) * 2*Math.PI - Math.PI/2;
          nodePos[key] = {
            x: centerX + radius * Math.cos(angle),
            y: centerY + radius * Math.sin(angle)
          };
        });
        
        // Рисуем связи
        let maxWeight = 0;
        for(const [from, tos] of Object.entries(graph)){
          for(const [to, weight] of Object.entries(tos)){
            if(weight > maxWeight) maxWeight = weight;
          }
        }
        
        for(const [from, tos] of Object.entries(graph)){
          if(!nodePos[from]) continue;
          for(const [to, weight] of Object.entries(tos)){
            if(!nodePos[to]) continue;
            const alpha = 0.2 + 0.8 * (weight / maxWeight);
            const width = 1 + 3 * (weight / maxWeight);
            cx.strokeStyle = `rgba(78, 201, 176, ${alpha})`;
            cx.lineWidth = width;
            cx.beginPath();
            cx.moveTo(nodePos[from].x, nodePos[from].y);
            cx.lineTo(nodePos[to].x, nodePos[to].y);
            cx.stroke();
          }
        }
        
        // Рисуем узлы
        for(const [key, pos] of Object.entries(nodePos)){
          const [freq, bw] = key.split('_').map(Number);
          const colorIdx = Math.floor((freq*100) / 1000) % 6;
          const colors = ['#4ec9b0', '#e0b23c', '#e05c5c', '#569cd6', '#d18ad1', '#7fd17f'];
          
          // Размер = популярность
          let degree = 0;
          if(graph[key]){
            degree = Object.values(graph[key]).reduce((s,v) => s+v, 0);
          }
          const size = 6 + Math.min(12, degree / 2);
          
          cx.fillStyle = colors[colorIdx % colors.length];
          cx.globalAlpha = 0.8;
          cx.beginPath();
          cx.arc(pos.x, pos.y, size, 0, 2*Math.PI);
          cx.fill();
          
          // Частота
          cx.globalAlpha = 1;
          cx.fillStyle = '#6c7a80';
          cx.font = '7px monospace';
          cx.fillText(`${(freq*100).toFixed(0)} Гц`, pos.x-20, pos.y+4);
        }
        
        cx.globalAlpha = 1;
      } else {
        cx.fillStyle = '#2a3136';
        cx.font = '10px monospace';
        cx.fillText('⏳ накопление\nпаттернов...', gx+10, H/2-10);
      }
    }
    
    // --- 3. Информация ---
    cx.fillStyle = '#6c7a80';
    cx.font = '8px monospace';
    const info = `Слогов: ${n.syllables.length}  |  Паттернов: ${Object.keys(n.graph).length}`;
    cx.fillText(info, 4, H-4);
    
    // Распознанный паттерн (сверху)
    if(n.matchedPattern){
      cx.fillStyle = '#e0b23c';
      cx.font = 'bold 10px monospace';
      cx.fillText(`🎵 ${n.matchedPattern}`, 4, 14);
    }
  }
});


// --- Вспомогательные функции для кластеризации и распознавания ---

function clusterSyllables(syllables, k){
  if(syllables.length < k) return [];
  
  // Извлекаем признаки: частота и длительность
  const features = syllables.map(s => [s.freq, s.duration]);
  
  // K-means (упрощённый)
  const clusters = [];
  // Инициализация центров
  const step = Math.floor(features.length / k);
  for(let i=0; i<k; i++){
    clusters.push({
      center: features[Math.min(i*step, features.length-1)].slice(),
      members: []
    });
  }
  
  // 3 итерации
  for(let iter=0; iter<5; iter++){
    // Очистка
    for(const c of clusters) c.members = [];
    
    // Присваивание
    for(const f of features){
      let minDist = Infinity;
      let minIdx = 0;
      for(let i=0; i<clusters.length; i++){
        const d = Math.hypot(f[0] - clusters[i].center[0], 
                             f[1] - clusters[i].center[1]);
        if(d < minDist){ minDist = d; minIdx = i; }
      }
      clusters[minIdx].members.push(f);
    }
    
    // Обновление центров
    for(const c of clusters){
      if(c.members.length === 0) continue;
      const sum = [0, 0];
      for(const m of c.members){
        sum[0] += m[0];
        sum[1] += m[1];
      }
      c.center = [sum[0]/c.members.length, sum[1]/c.members.length];
    }
  }
  
  return clusters.map(c => ({
    freq: c.center[0],
    duration: c.center[1],
    count: c.members.length
  }));
}

function recognizePattern(syllables){
  if(syllables.length < 5) return null;
  
  // Берём последние 10 слогов
  const recent = syllables.slice(-10);
  
  // Анализируем паттерн частот
  const freqs = recent.map(s => Math.round(s.freq / 100) * 100);
  const unique = [...new Set(freqs)];
  
  // Если повторяется паттерн из 3-4 частот
  if(unique.length <= 4 && unique.length >= 2){
    // Проверяем, повторяется ли последовательность
    const pattern = freqs.join(' ');
    const repeats = (pattern.match(/(\d+ \d+ \d+)/g) || []).length;
    if(repeats > 1){
      const names = {
        '1000 1200 1500': '🎵 трель',
        '800 1200 800': '🎶 колокольчик',
        '1000 800 1000 800': '🔔 звоночек',
        '1500 1200 1500': '🎵 свист',
        '2000 1500 1000': '⬇️ нисходящая',
        '1000 1500 2000': '⬆️ восходящая'
      };
      return names[pattern] || `🎵 ${pattern.replace(/ /g, '→')}`;
    }
  }
  
  // Анализируем длительность
  const durations = recent.map(s => Math.round(s.duration / 10) * 10);
  const durPattern = durations.join(' ');
  if(durations.length > 3){
    const short = durations.filter(d => d < 50).length;
    const long = durations.filter(d => d > 100).length;
    if(short > 2 && long > 1){
      return '📯 перелив (короткие+длинные)';
    }
  }
  
  return null;
}
// ---





def({ id:'persist', title:'Персистентный спектр', cat:'Анализ',
  ins:[{n:'spec',t:'spec'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'log',t:'num'},
       {n:'floor',t:'num'},{n:'top',t:'num'},{n:'decay',t:'num'},{n:'gain',t:'num'}],
  outs:[{n:'fsel',t:'num'}], view:{h:220}, resize:true, pick:true,
  params:[{n:'fmin',t:'range',min:0,max:()=>Eng.sr/2,step:1,d:0},
          {n:'fmax',t:'range',min:100,max:()=>Eng.sr/2,step:1,d:4000},
          {n:'log',t:'check',d:false},
          {n:'floor',t:'range',min:-140,max:-20,step:1,d:-120},
          {n:'top',t:'range',min:-60,max:20,step:1,d:0},
          {n:'decay',t:'range',min:.9,max:.9999,step:.0001,d:.995,label:'затухание'},
          {n:'gain',t:'range',min:.5,max:20,step:.1,d:4,label:'яркость'},
          {n:'rst',t:'button',label:'Сбросить',fn:n=>{n.acc&&n.acc.fill(0);}}],
  init:n=>{n.acc=null;n.pickT=null;n.fsel=0;},
  process(n,I){
    for(const k of ['fmin','fmax','floor','top','decay','gain']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.log==='number') setMod(n,'log',I.log>=0.5);
    const s=I.spec; n.s=s; if(!s) return {fsel:n.fsel||null};
    const W=n.aw||0, H=n.ah||0;
    if(!n.acc||!W) return {fsel:n.fsel||null};
    const N=s.mag.length, d=n.p.decay;
    for(let i=0;i<n.acc.length;i++) n.acc[i]*=d;     // плотность попаданий тускнеет со временем
    for(let x=0;x<W;x++){
      const f=n.p.log? persLogF(n,x/(W-1)) : n.p.fmin+(n.p.fmax-n.p.fmin)*x/(W-1);
      const bin=clamp(Math.round(specBin(s,f)),0,N-1);
      const db=20*Math.log10(s.mag[bin]+1e-12);
      const v=clamp((db-n.p.floor)/((n.p.top-n.p.floor)||1),0,1);
      const y=clamp(Math.round((1-v)*(H-1)),0,H-1);
      n.acc[y*W+x]+=1; }
    if(n.pickT!=null){
      n.fsel=n.p.log? persLogF(n,n.pickT) : n.p.fmin+(n.p.fmax-n.p.fmin)*n.pickT;
      n.pickT=null; }
    return {fsel:n.fsel||null}; },
  draw(n,cv,cx){
    const W=cv.pxW||cv.width, H=cv.pxH||cv.height;   // пишем ImageData в физический размер буфера — резче картинка
    if(n.aw!==W||n.ah!==H){ n.aw=W; n.ah=H; n.acc=new Float32Array(W*H); n.id2=null; }
    if(!n.id2) n.id2=cx.createImageData(W,H);
    const d=n.id2.data, a=n.acc, g=n.p.gain;
    let mx=1e-6; for(let i=0;i<a.length;i++) if(a[i]>mx) mx=a[i];
    for(let i=0;i<a.length;i++){
      const v=clamp(a[i]/mx*g,0,1), k=heatIdx(v)*3, j=i*4;
      d[j]=HEAT_LUT[k]; d[j+1]=HEAT_LUT[k+1]; d[j+2]=HEAT_LUT[k+2]; d[j+3]=255; }
    cx.putImageData(n.id2,0,0);
    if(n.fsel){ const t=n.p.log? Math.log(n.fsel/Math.max(1,n.p.fmin||10))/
        Math.log(n.p.fmax/Math.max(1,n.p.fmin||10)) : (n.fsel-n.p.fmin)/(n.p.fmax-n.p.fmin);
      const x=Math.round(clamp(t,0,1)*cv.width);       // putImageData игнорирует transform — маркер после него
      cx.strokeStyle='#e0b23c'; cx.beginPath(); cx.moveTo(x+.5,0); cx.lineTo(x+.5,cv.height); cx.stroke();
      cx.font='10px monospace';
      const s2=n.fsel.toFixed(0)+' Гц', tw=cx.measureText(s2).width, tx=clamp(x+4,2,cv.width-tw-4);
      cx.fillStyle='#0e1113dd'; cx.fillRect(tx-3,2,tw+6,12);
      cx.fillStyle='#e0b23c'; cx.fillText(s2,tx,11); } }});

function persLogF(n,t){ const lo=Math.max(10,n.p.fmin); return lo*Math.pow(n.p.fmax/lo,t); }

def({ id:'cfar', title:'Детектор сигналов (CFAR)', cat:'Анализ',
  ins:[{n:'spec',t:'spec'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'guard',t:'num'},
       {n:'train',t:'num'},{n:'thr',t:'num'},{n:'minW',t:'num'},{n:'top',t:'num'},{n:'hold',t:'num'}],
  outs:[{n:'count',t:'num'},{n:'f1',t:'num'},{n:'l1',t:'num'},{n:'f2',t:'num'},{n:'l2',t:'num'},
        {n:'f3',t:'num'},{n:'l3',t:'num'},{n:'f4',t:'num'},{n:'l4',t:'num'}],
  readout:true, tall:true,
  params:[{n:'auto',t:'check',d:false,label:'авто-диапазон (весь охват источника)'},
          {n:'fmin',t:'range',min:1,max:6e9,step:1,log:true,d:100},
          {n:'fmax',t:'range',min:1,max:6e9,step:1,log:true,d:6000},
          {n:'guard',t:'range',min:1,max:32,step:1,d:4,label:'защитных бинов'},
          {n:'train',t:'range',min:4,max:128,step:1,d:32,label:'обучающих бинов'},
          {n:'thr',t:'range',min:1,max:30,step:.5,d:8,label:'порог, дБ'},
          {n:'minW',t:'range',min:1,max:64,step:1,d:2,label:'мин. ширина'},
          {n:'top',t:'range',min:1,max:30,step:1,d:10,label:'сколько показывать'},
          {n:'hold',t:'range',min:0,max:5000,step:50,d:500,label:'удержание, мс'}],
  init:n=>{n.list=[];n.text='';n.tracks=[];},
  process(n,I){
    const s=I.spec;
    // тот же трюк, что у 'sa': ручной диапазон не пересекается с реальными данными источника
    // (сменили аудио-спектр на RF или наоборот) — подхватываем его целиком, иначе сканируем
    // вырожденный (или вовсе пустой) кусок и ничего разумного не находим
    if(s && !n.p.auto){
      const [lo0,hi0]=specSpan(s);
      if(n.p.fmax<=lo0 || n.p.fmin>=hi0){ n.set.fmin?.(lo0); n.set.fmax?.(hi0); }
    }
    for(const k of ['fmin','fmax','guard','train','thr','minW','top','hold'])
      if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(!s) return {count:0};
    const N=s.mag.length, G=n.p.guard, T=n.p.train;
    const [specLo,specHi]=n.p.auto? specSpan(s) : [n.p.fmin,n.p.fmax];
    const lo=clamp(Math.floor(specBin(s,specLo)),1,N-2),
          hi=clamp(Math.ceil (specBin(s,specHi)),1,N-2);
    const db=n.dbBuf&&n.dbBuf.length===N? n.dbBuf : (n.dbBuf=new Float32Array(N));
    for(let i=lo;i<=hi;i++) db[i]=20*Math.log10(s.mag[i]+1e-12);
    const hits=[];
    let run=null;
    for(let i=lo;i<=hi;i++){
      let sum=0,c=0;                                 // среднее по «обучающим» бинам вокруг цели
      for(let k=G+1;k<=G+T;k++){
        const a=i-k, b=i+k;
        if(a>=lo){ sum+=db[a]; c++; }
        if(b<=hi){ sum+=db[b]; c++; } }
      const noise=c? sum/c : -120;
      if(db[i]-noise>=n.p.thr){
        if(!run) run={a:i,b:i,peak:db[i],pi:i};
        else { run.b=i; if(db[i]>run.peak){ run.peak=db[i]; run.pi=i; } }
      } else if(run){
        if(run.b-run.a+1>=n.p.minW) hits.push(run);
        run=null; } }
    if(run&&run.b-run.a+1>=n.p.minW) hits.push(run);
    hits.sort((a,b)=>b.peak-a.peak);
    const now=performance.now();
    n.tracks=n.tracks||[];
    for(const h of hits){
      const f=specHz(s,h.pi), wid=Math.max(1,specHz(s,h.b)-specHz(s,h.a));
      const tol=Math.max(15,wid);                    // цель та же, если рядом по частоте
      let tr=n.tracks.find(t=>Math.abs(t.f-f)<=tol);
      if(tr){ tr.f=tr.f*.7+f*.3; tr.w=Math.max(tr.w,wid); tr.db=h.peak; tr.t=now; }
      else n.tracks.push({f,w:wid,db:h.peak,t0:now,t:now}); }
    n.tracks=n.tracks.filter(t=>now-t.t<=n.p.hold);
    // трек может физически не помещаться в текущую захваченную полосу — например, центр
    // приёмника уже перестроили (тюнером/вручную), а этот пик остался от старого положения.
    // Снимаем сразу, не дожидаясь hold — иначе он продолжит тянуть tuneFreq к старой частоте
    // и "перетягивать" центр обратно при каждой попытке перестроиться (та же история, что
    // была с маркерами 'sa').
    const [specLo0,specHi0]=specSpan(s);
    n.tracks=n.tracks.filter(t=>t.f>=specLo0 && t.f<=specHi0);
    n.list=n.tracks.slice().sort((a,b)=>b.db-a.db).slice(0,n.p.top);
    n.text='найдено '+n.list.length+'\n'+n.list.map(v=>
      fmtHz(v.f).padStart(8)+'Гц  ширина '+fmtHz(v.w).padStart(4)+
      'Гц  '+v.db.toFixed(0).padStart(4)+' dB  '+((now-v.t0)/1000).toFixed(1)+' с').join('\n');
    const [a,b,c,d]=n.list;
    return {count:n.list.length,
      f1:a?a.f:null, l1:a?a.db:null, f2:b?b.f:null, l2:b?b.db:null,
      f3:c?c.f:null, l3:c?c.db:null, f4:d?d.f:null, l4:d?d.db:null}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text||'…'; }});


def({ id:'chsnr', title:'SNR канала', cat:'Анализ',
  // Считает SNR прямо по спектру (native-rate FFT из rtlsdr/fft), а не по 'sig'-пинам — так
  // не упирается в Eng.sr движка: реальная полоса RTL (сотни кГц — единицы МГц) через 'sig'
  // всё равно не протащить без алиасинга, а спектр её видит целиком.
  // Мощность сигнала — среднее |mag|^2 в полосе канала вокруг f. Шум — среднее |mag|^2 по двум
  // обучающим полосам за пределами защитного интервала (тот же приём, что у CFAR-детектора).
  ins:[{n:'spec',t:'spec'},{n:'f',t:'num'},{n:'bw',t:'num'},{n:'guard',t:'num'},{n:'train',t:'num'}],
  outs:[{n:'snr',t:'num'},{n:'sigDb',t:'num'},{n:'noiseDb',t:'num'}],
  readout:true,
  params:[{n:'f',t:'num',d:100000000,label:'частота канала, Гц'},
          {n:'bw',t:'range',min:100,max:200000,step:100,d:12500,log:true,label:'полоса канала, Гц'},
          {n:'guard',t:'range',min:0,max:200000,step:100,d:3000,log:true,label:'защитный интервал, Гц'},
          {n:'train',t:'range',min:1000,max:500000,step:500,d:50000,log:true,label:'обучающая полоса, Гц'},
          {n:'smooth',t:'range',min:0,max:.95,step:.01,d:.3,label:'сглаживание'}],
  init:n=>{n.snr=null;n.sigDb=null;n.noiseDb=null;},
  process(n,I){
    for(const k of ['f','bw','guard','train','smooth']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const s=I.spec; if(!s) return {snr:n.snr,sigDb:n.sigDb,noiseDb:n.noiseDb};
    const N=s.mag.length, f0=n.p.f, halfBw=n.p.bw/2, halfGuard=halfBw+n.p.guard;
    const sLo=clamp(Math.round(specBin(s,f0-halfBw)),0,N-1), sHi=clamp(Math.round(specBin(s,f0+halfBw)),0,N-1);
    let sigPow=0,sc=0;
    for(let i=sLo;i<=sHi;i++){ sigPow+=s.mag[i]*s.mag[i]; sc++; }
    sigPow=sc?sigPow/sc:0;
    const gLo=clamp(Math.round(specBin(s,f0-halfGuard)),0,N-1), gHi=clamp(Math.round(specBin(s,f0+halfGuard)),0,N-1);
    const tLo=clamp(Math.round(specBin(s,f0-halfGuard-n.p.train)),0,N-1);
    const tHi=clamp(Math.round(specBin(s,f0+halfGuard+n.p.train)),0,N-1);
    let noisePow=0,nc=0;
    for(let i=tLo;i<gLo;i++){ noisePow+=s.mag[i]*s.mag[i]; nc++; }
    for(let i=gHi+1;i<=tHi;i++){ noisePow+=s.mag[i]*s.mag[i]; nc++; }
    noisePow=nc?noisePow/nc:1e-12;
    const sigDb=10*Math.log10(sigPow+1e-24), noiseDb=10*Math.log10(noisePow+1e-24), raw=sigDb-noiseDb;
    const k=n.p.smooth;
    n.snr = n.snr==null?raw:n.snr*k+raw*(1-k);
    n.sigDb = n.sigDb==null?sigDb:n.sigDb*k+sigDb*(1-k);
    n.noiseDb = n.noiseDb==null?noiseDb:n.noiseDb*k+noiseDb*(1-k);
    return {snr:n.snr, sigDb:n.sigDb, noiseDb:n.noiseDb}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = n.snr==null?'—':
      `SNR ${n.snr.toFixed(1)} дБ · сигнал ${n.sigDb.toFixed(1)} · шум ${n.noiseDb.toFixed(1)}`; }});


const OCT_CENTERS=(()=>{ const a=[];
  for(let i=-20;i<=13;i++) a.push(1000*Math.pow(10,i/10)); return a; })();
function weightA(f){
  const f2=f*f;
  const r=(12194*12194*f2*f2)/((f2+20.6*20.6)*Math.sqrt((f2+107.7*107.7)*(f2+737.9*737.9))*(f2+12194*12194));
  return 20*Math.log10(r)+2.00;
}
function weightC(f){
  const f2=f*f;
  const r=(12194*12194*f2)/((f2+20.6*20.6)*(f2+12194*12194));
  return 20*Math.log10(r)+0.06;
}
def({ id:'octave', title:'Третьоктавы', cat:'Анализ', ins:[{n:'spec',t:'spec'},{n:'fmin',t:'num'},{n:'fmax',t:'num'}],
  outs:[{n:'spec',t:'spec'},{n:'total',t:'num'}], readout:true,
  params:[{n:'width',t:'select',opts:['1/3 октавы','1/1 октавы'],d:'1/3 октавы'},
          {n:'weight',t:'select',opts:['без','A','C'],d:'A'},
          {n:'fmin',t:'range',min:10,max:1000,step:1,d:20,log:true},
          {n:'fmax',t:'range',min:1000,max:()=>Eng.sr/2,step:100,d:20000,log:true}],
  init:n=>{n.key='';},
  process(n,I){
    if(typeof I.fmin==='number') setMod(n,'fmin',I.fmin);
    if(typeof I.fmax==='number') setMod(n,'fmax',I.fmax);
    const s=I.spec; if(!s) return {spec:null,total:-120};
    const third=n.p.width==='1/3 октавы';
    const key=n.p.width+'/'+n.p.fmin+'/'+n.p.fmax+'/'+n.p.weight;
    if(n.key!==key){
      n.key=key;
      const cs=OCT_CENTERS.filter(f=>f>=n.p.fmin&&f<=n.p.fmax&&(third||Math.abs(Math.log2(f/1000)%1)<0.05));
      n.fc=Float32Array.from(cs);
      n.mag=new Float32Array(cs.length);
      n.wdb=Float32Array.from(cs.map(f=>n.p.weight==='A'?weightA(f):n.p.weight==='C'?weightC(f):0)); }
    const k=third? Math.pow(2,1/6) : Math.SQRT2;
    let tot=0;
    for(let i=0;i<n.fc.length;i++){
      const f=n.fc[i];
      const a=clamp(Math.floor(specBin(s,f/k)),0,s.mag.length-1),
            b=clamp(Math.ceil (specBin(s,f*k)),0,s.mag.length-1);
      let e=0; for(let j=a;j<=b;j++) e+=s.mag[j]*s.mag[j];
      const lin=Math.sqrt(e)*Math.pow(10,n.wdb[i]/20);
      n.mag[i]=lin; tot+=lin*lin; }
    n.tot=10*Math.log10(tot+1e-24);
    n.sp=n.sp||{}; n.sp.mag=n.mag; n.sp.freqs=n.fc; n.sp.sr=s.sr; n.sp.size=s.size;
    n.sp.rev=(n.sp.rev|0)+1;
    return {spec:n.sp, total:n.tot}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'суммарный '+(n.tot||-120).toFixed(1)+' dBFS'+(n.p.weight!=='без'?' ('+n.p.weight+')':''); }});


def({ id:'ir', title:'Импульсная и RT60', cat:'Анализ',
  ins:[{n:'ref',t:'sig'},{n:'meas',t:'sig'}],
  outs:[{n:'rt60',t:'num'},{n:'delayMs',t:'num'}],
  view:{h:150}, resize:true, readout:true,
  params:[{n:'size',t:'select',opts:['8192','16384','32768','65536'],d:'32768'},
          {n:'go',t:'button',label:'Измерить',fn:n=>irMeasure(n)},
          {n:'range',t:'select',opts:['T20','T30'],d:'T20'}],
  init:n=>{n.N=0;n.text='нажмите «Измерить»';},
  process(n,I){
    const N=+n.p.size;
    if(n.N!==N){ n.N=N; n.rx=new Float32Array(N); n.ry=new Float32Array(N); n.w=0; }
    for(let i=0;i<BLOCK;i++){
      n.rx[n.w]=I.ref?I.ref[i]:0; n.ry[n.w]=I.meas?I.meas[i]:0; n.w=(n.w+1)%N; }
    return {rt60:n.rt||0, delayMs:n.dl||0}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(n.sch){
      cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
      cx.beginPath();
      for(let x=0;x<W;x++){ const k=Math.floor(x/W*n.sch.length);
        const y=H-clamp((n.sch[k]+60)/60,0,1)*H;
        x?cx.lineTo(x,y):cx.moveTo(x,y); }
      cx.stroke();
      cx.strokeStyle='#e05c5c55';
      for(const db of [-5,-25,-35]){ const y=H-clamp((db+60)/60,0,1)*H;
        cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke(); } }
    n.el.querySelector('.readout').textContent=n.text; }});


/* ---------- анализ ---------- */
def({ id:'scope', title:'Осциллограф', cat:'Анализ',
  ins:[{n:'in1',t:'sig'},{n:'in2',t:'sig'},{n:'in3',t:'sig'},{n:'in4',t:'sig'},
       {n:'span',t:'num'},{n:'gain',t:'num'},{n:'ofs',t:'num'},{n:'trig',t:'num'},{n:'stack',t:'num'}],
  view:{h:110},
  params:[{n:'span',t:'range',min:64,max:480000,step:64,d:1024,log:true,label:'окно, отсч.'},
          {n:'gain',t:'range',min:.05,max:50,step:.05,d:1},
          {n:'ofs',t:'range',min:-1,max:1,step:.01,d:0},
          {n:'trig',t:'check',d:true},
          {n:'stack',t:'check',d:false},
          {n:'grid',t:'check',d:true,label:'сетка'}],
  init:n=>{ n.L=16384; n.ring=[0,1,2,3].map(()=>new Float32Array(n.L)); n.w=0; },
  process(n,I){
    // буфер вмещает MAXSEC секунд при текущей sr — пересчитываем размер, только если sr поменялась
    const MAXSEC=10, need=Math.ceil((Eng.sr||48000)*MAXSEC);
    if(need!==n.L){ n.L=need; n.ring=[0,1,2,3].map(()=>new Float32Array(n.L)); n.w=0; }
    for(const k of ['span','gain','ofs']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    for(const k of ['trig','stack']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    const src=[I.in1,I.in2,I.in3,I.in4];
    let w=n.w;
    for(let i=0;i<BLOCK;i++){
      for(let c=0;c<4;c++) n.ring[c][w]=src[c]?src[c][i]:0;
      w=(w+1)%n.L; }
    n.w=w; n.act=src.map(s=>!!s);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height,L=n.L,span=Math.min(+n.p.span,L-1);
    // цвета темы не меняются каждый кадр — обновляем раз в ~30 кадров, а не при каждой отрисовке
    if(!n.cols || ((n.colFrame=(n.colFrame||0)+1)%30===0))
      n.cols=['--t-sig','--t-num','--t-spec','--t-img'].map(v=>
        getComputedStyle(document.body).getPropertyValue(v));
    const cols=n.cols;
    cx.clearRect(0,0,W,H);
    const act=(n.act||[true]).map((v,i)=>v||i===0), nA=Math.max(1,act.filter(Boolean).length);
    if(n.p.grid){
      const totalMs=span/(Eng.sr||48000)*1000;
      cx.strokeStyle='#1e2529'; cx.font='8px monospace'; cx.fillStyle='#5a6469';
      // время слева направо: 0 мс — старый край окна, totalMs — текущий момент
      for(let i=0;i<=10;i++){
        const x=Math.round(i*W/10)+.5, t=i/10*totalMs;
        cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke();
        const lbl=(t<10?t.toFixed(1):Math.round(t))+' мс';
        cx.fillText(lbl, clamp(x-14,2,W-2-lbl.length*5), 9); }
      // уровень в дБ относительно полного размаха — отдельно на каждую активную полосу
      const dbSteps=[0,-6,-12,-18,-24];
      for(let k=0,shown=0;k<4;k++){ if(!act[k]) continue;
        const amp = n.p.stack ? H/(2*nA)*.9 : H/2*.95;
        const yc  = n.p.stack ? H*(shown+.5)/nA : H/2; shown++;
        cx.beginPath();
        for(const db of dbSteps){
          const a=Math.pow(10,db/20), y1=yc-a*amp, y2=yc+a*amp;
          cx.moveTo(0,y1); cx.lineTo(W,y1); cx.moveTo(0,y2); cx.lineTo(W,y2); }
        cx.stroke();
        for(const db of dbSteps){
          const a=Math.pow(10,db/20), y1=yc-a*amp;
          cx.fillText(db+' дБ', 2, y1-2>8?y1-2:y1+9); } } }
    cx.strokeStyle='#1e2529';
    for(let k=0,shown=0;k<4;k++){ if(!act[k]) continue;
      const yc = n.p.stack ? H*(shown+.5)/nA : H/2; shown++;
      cx.beginPath(); cx.moveTo(0,yc); cx.lineTo(W,yc); cx.stroke(); }
    let start=(n.w-span+L)%L;
    if(n.p.trig){                                     // ищем фронт, но не дальше 2 экранов назад
      const act=n.act||[true];
      let ch=0; while(ch<4 && !act[ch]) ch++;         // источник триггера — первый активный канал, не всегда in1
      const r0=n.ring[ch], searchLen=Math.min(L-span, span*2);
      for(let k=0;k<searchLen;k++){ const i=(n.w-span-k+L*2)%L, j=(i-1+L)%L;
        if(r0[j]<=0&&r0[i]>0){ start=i; break; } } }
    const spp=span/W;                                 // отсчётов на пиксель
    for(let c=0,shown=0;c<4;c++){ if(!act[c]) continue;
      const amp = n.p.stack ? H/(2*nA)*.9 : H/2*.95;
      const yc  = n.p.stack ? H*(shown+.5)/nA : H/2; shown++;
      cx.strokeStyle=cols[c]; cx.lineWidth=1; cx.beginPath();
      const r=n.ring[c];
      // при spp>1 отсчётов больше, чем пикселей — сводим их в столбец через min/max (иначе рисовать нечем).
      // при spp<=1 отсчётов меньше, чем пикселей — соединяем сами отсчёты линией, а не столбцами:
      // столбец в этом случае почти всегда попадает в один и тот же отсчёт и рисует "полку", отсюда ступеньки.
      if(spp<=1){
        for(let k=0;k<=span;k++){
          const v=r[(start+Math.min(k,span-1))%L]*n.p.gain+n.p.ofs;
          const x=k/spp, y=yc-clamp(v,-1,1)*amp;
          k===0? cx.moveTo(x,y) : cx.lineTo(x,y); }
      } else {
        for(let x=0;x<W;x++){
          const i0=(x*spp)|0, i1=Math.max(i0+1,((x+1)*spp)|0);
          let mn=1,mx=-1;
          for(let i=i0;i<i1;i++){ const v=r[(start+i)%L]*n.p.gain+n.p.ofs; if(v<mn)mn=v; if(v>mx)mx=v; }
          const y1=yc-clamp(mn,-1,1)*amp, y2=yc-clamp(mx,-1,1)*amp;
          x===0? cx.moveTo(x,y1) : cx.lineTo(x,y1);
          cx.lineTo(x,y2); }
      }
      cx.stroke(); } }});


function binAt(t,N,log){ return log ? Math.pow(N,t)-1 : t*(N-1); }

// спектр может нести собственную ось частот (freqs) — тогда шаг бинов неравномерный
function specHz(s,i){
  if(!s) return 0;
  if(s.freqs){ const F=s.freqs, k=clamp(Math.round(i),0,F.length-1); return F[k]; }
  return i*s.sr/s.size;
}
function specBin(s,f){
  if(!s) return 0;
  if(!s.freqs) return f/(s.sr/s.size);
  const F=s.freqs, N=F.length;
  if(f<=F[0]) return 0;
  if(f>=F[N-1]) return N-1;
  let lo=0, hi=N-1;                                 // ось монотонна — двоичный поиск
  while(hi-lo>1){ const m=(lo+hi)>>1; if(F[m]<=f) lo=m; else hi=m; }
  const d=(f-F[lo])/((F[hi]-F[lo])||1);
  return lo+d;
}
function specSpan(s){                               // границы оси спектра
  if(!s) return [0,Eng.sr/2];
  if(s.freqs) return [s.freqs[0], s.freqs[s.freqs.length-1]];
  return [0, s.sr/2];
}
function axisT(bin,N,log){ return log ? Math.log(bin+1)/Math.log(N) : bin/(N-1); }

const MK_COL=['#e0b23c','#4ec9b0','#e05c5c','#569cd6'];

def({ id:'sa', title:'Спектроанализатор', cat:'Анализ',
  ins:[{n:'spec',t:'spec'},{n:'m1',t:'num'},{n:'m2',t:'num'},{n:'m3',t:'num'},{n:'m4',t:'num'},
       {n:'bLo',t:'num'},{n:'bHi',t:'num'},{n:'floor',t:'num'},{n:'top',t:'num'},
       {n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'split',t:'num'},{n:'tol',t:'num'},
       {n:'log',t:'num'},{n:'grid',t:'num'}],
  outs:[{n:'f1',t:'num'},{n:'l1',t:'num'},{n:'f2',t:'num'},{n:'l2',t:'num'},
        {n:'f3',t:'num'},{n:'l3',t:'num'},{n:'f4',t:'num'},{n:'l4',t:'num'},
        {n:'fr1',t:'num'},{n:'fr2',t:'num'},{n:'fr3',t:'num'},{n:'fr4',t:'num'}],
  view:{h:280}, pick:true, resize:true,
  params:[{n:'auto',t:'check',d:false,label:'авто-диапазон (весь охват источника)'},
          {n:'frange',t:'range2',keys:['fmin','fmax'],min:1,max:6e9,step:1,log:true,d:[0,4000],label:'диапазон, Гц'},
          {n:'dbrange',t:'range2',keys:['floor','top'],min:-140,max:20,step:1,d:[-100,-20],label:'диапазон, дБ'},
          {n:'split',t:'range',min:.15,max:.85,step:.01,d:.4,label:'доля спектра'},
          {n:'log',t:'check',d:false},
          {n:'grid',t:'check',d:true},
          {n:'mode',t:'select',opts:['амплитуда','фаза','мощность','СПМ'],d:'амплитуда',label:'вид спектра'},
          {n:'active',t:'buttons',opts:['1','2','3','4'],d:'1',label:'маркер'},
          {n:'tol',t:'range',min:5,max:50000,step:5,log:true,d:50,label:'окно уровня, Гц'},
          {n:'band',t:'select',opts:['нет','по входам','1–2','3–4'],d:'по входам',label:'полоса'},
          {n:'ref',t:'select',opts:['нет','показать','разность'],d:'нет',label:'эталон'},
          {n:'take',t:'button',label:'Снять эталон',fn:n=>{
            if(n.s) n.refMag=Float32Array.from(n.s.mag); }},
          {n:'clr',t:'button',label:'Снять активный маркер',fn:n=>{n.mk[+n.p.active-1]=null;}},
          {n:'clrAll',t:'button',label:'Снять все',fn:n=>{n.mk=[null,null,null,null];}}],
  // Номер маркера выбирается кнопками (active), тап по графику ставит/двигает именно его.
  // mkPhase/mkBin/mkRev — состояние фазового уточнения частоты (fr1..fr4): сравниваем фазу
  // пика с предыдущим кадром спектра и по сдвигу фазы меряем частоту точнее ширины бина —
  // работает, только если источник спектра отдаёт sp.phase/sp.hop ('fft'/'zfft' это делают).
  init:n=>{n.mk=[null,null,null,null];n.lv=[0,0,0,0];n.db=[-120,-120,-120,-120];
           n.ext=[0,0,0,0];n.pickT=null;
           n.mkPhase=[0,0,0,0];n.mkBin=[null,null,null,null];n.mkRev=[-1,-1,-1,-1];},
  process(n,I){
    const sp=I.spec;
    // ручной диапазон вообще не пересекается с реальными данными — источник сменил масштаб
    // (например, подключили RF-спектр rtlsdr вместо аудио с fft) — подхватываем его целиком,
    // иначе окно клэмпится в вырожденную точку у края, и клик по графику всегда даёт одну и ту
    // же частоту независимо от места клика. Если диапазон пересекается — это осознанный
    // ручной зум пользователя, не трогаем.
    if(sp){
      const [lo0,hi0]=specSpan(sp);
      if(n.p.auto){                                   // авто — синхронизируем параметры с реальным охватом,
        if(n.p.fmin!==lo0) n.set.fmin?.(lo0);          // иначе при снятии галочки слайдер откатится
        if(n.p.fmax!==hi0) n.set.fmax?.(hi0);          // к старым ручным значениям, а не к видимому диапазону
      } else if(n.p.fmax<=lo0 || n.p.fmin>=hi0){
        n.set.fmin?.(lo0); n.set.fmax?.(hi0);
      }
    }
    n.s=sp;
    saTake(n);                                       // тап мог случиться между блоками
    for(const k of ['fmin','fmax','floor','top','split','tol'])   // прямая передача значения
      if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.log==='number')  setMod(n,'log', I.log>=0.5);     // галочки — порог 0.5
    if(typeof I.grid==='number') setMod(n,'grid',I.grid>=0.5);
    for(let k=0;k<4;k++){                            // внешний вход задаёт свой маркер
      const v=I['m'+(k+1)];
      if(typeof v==='number'&&v>0){ n.mk[k]=v; n.ext[k]=1; } else n.ext[k]=0; }
    // маркер, поставленный кликом (не внешним входом), но вылетевший за пределы реально
    // захваченной полосы — например, источник (rtlsdr) перестроили вручную в другое место —
    // снимаем. Иначе он продолжит держать tuneFreq на старой частоте и будет "передёргивать"
    // центр обратно при каждой попытке перестроиться руками: приёмник не даёт себя перетюнить.
    if(sp){
      const [lo0,hi0]=specSpan(sp);
      for(let k=0;k<4;k++)
        if(!n.ext[k] && n.mk[k]!=null && (n.mk[k]<lo0 || n.mk[k]>hi0)) n.mk[k]=null;
    }
    n.band=(typeof I.bLo==='number'&&typeof I.bHi==='number')?[I.bLo,I.bHi]:null;
    const o={};
    const N=sp? sp.mag.length : 0;
    for(let k=0;k<4;k++){
      const f=n.mk[k];
      if(f==null||!sp){ o['f'+(k+1)]=f==null?null:f; o['l'+(k+1)]=null; o['fr'+(k+1)]=null;
                         n.mkRev[k]=-1; continue; }
      const lo=clamp(Math.floor(specBin(sp,f-n.p.tol)),0,N-1),
            hi=clamp(Math.ceil (specBin(sp,f+n.p.tol)),0,N-1);
      let mx=0, bin=lo; for(let i=lo;i<=hi;i++) if(sp.mag[i]>mx){ mx=sp.mag[i]; bin=i; }
      n.db[k]=20*Math.log10(mx+1e-12);
      n.lv[k]=clamp((n.db[k]-n.p.floor)/((n.p.top-n.p.floor)||1),0,1);
      o['f'+(k+1)]=f; o['l'+(k+1)]=n.lv[k];
      // фазовое уточнение: только между соседними кадрами (rev не пропущен) и если пик
      // не перескочил больше чем на 1 бин — иначе это, скорее всего, другой сигнал, не дрейф
      let fr=specHz(sp,bin);
      if(sp.phase && sp.rev===n.mkRev[k]+1 && n.mkBin[k]!=null && Math.abs(bin-n.mkBin[k])<=1){
        const hop=sp.hop||sp.size, sr=sp.sr;
        const expected=2*Math.PI*fr*hop/sr;
        let delta=(sp.phase[bin]-n.mkPhase[k])-expected;
        delta-=2*Math.PI*Math.round(delta/(2*Math.PI));   // заворачиваем в (-π,π]
        fr=fr+delta*sr/(2*Math.PI*hop);
      }
      if(sp.phase){ n.mkPhase[k]=sp.phase[bin]; n.mkBin[k]=bin; n.mkRev[k]=sp.rev; }
      o['fr'+(k+1)]=fr; }
    return o; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height;
    const hs=Math.round(H*n.p.split), hw=H-hs;
    saTake(n);                                       // маркер ставится и без запущенного звука
    cx.clearRect(0,0,W,H);
    if(!n._zoomWired){
      n._zoomWired=true;
      // колесо: зум вокруг курсора, Shift+колесо — панорама. Зум переключает auto→false и
      // подхватывает текущие (в т.ч. авто-) границы как стартовые — иначе первый же тик зума
      // прыгнул бы от старых ручных fmin/fmax, а не от того, что реально видно на экране.
      cv.addEventListener('wheel', ev=>{
        ev.preventDefault(); ev.stopPropagation();
        if(!n.s) return;
        const [fullLo,fullHi]=specSpan(n.s);
        const curLo=saFreq(n,0), curHi=saFreq(n,1), curRange=curHi-curLo||1;
        const rc=cv.getBoundingClientRect(), x=(ev.clientX-rc.left)/rc.width;
        const fAtCursor=saFreq(n,x);                 // курсор — по текущей (лог или линейной) шкале
        if(n.p.auto) n.set.auto?.(false);
        if(ev.shiftKey){
          const pan=curRange*0.15*(ev.deltaY>0?1:-1);
          const newLo=clamp(curLo+pan, fullLo, fullHi-curRange);
          n.set.fmin?.(newLo); n.set.fmax?.(newLo+curRange);
        } else {
          const zoom=ev.deltaY>0?1.09:1/1.09;         // втрое медленнее прежнего (1.3 → 1.3^(1/3))
          const newRange=clamp(curRange*zoom, 10, fullHi-fullLo);
          // репозиция — линейная пропорция от курсора; в лог-режиме центровка чуть неточная,
          // но для целей зума колесом это не критично
          const ratio=(fAtCursor-curLo)/curRange;
          let newLo=fAtCursor-ratio*newRange, newHi=newLo+newRange;
          if(newLo<fullLo){ newLo=fullLo; newHi=newLo+newRange; }
          if(newHi>fullHi){ newHi=fullHi; newLo=newHi-newRange; }
          n.set.fmin?.(newLo); n.set.fmax?.(newHi);
          if(Math.abs(newLo-fullLo)<1 && Math.abs(newHi-fullHi)<1) n.set.auto?.(true);
        }
      }, {passive:false});
      cv.addEventListener('dblclick', ev=>{
        ev.preventDefault();
        n.set.auto?.(true);                          // сброс зума — во всю полосу источника
      });
    }
    if(n.s){
      const dpr=(cv.pxW&&cv.width)?cv.pxW/cv.width:1, Wp=cv.pxW||W, hwP=Math.max(1,Math.round(hw*dpr));
      if(!n.off||n.off.width!==Wp||n.off.height!==hwP){
        n.off=document.createElement('canvas'); n.off.width=Wp; n.off.height=hwP;
        n.ocx=n.off.getContext('2d',{willReadFrequently:true});
        n._line=n.ocx.createImageData(Wp,1);          // строка водопада — переиспользуем, размер завязан на ту же канву
        n._lastRev=undefined; n._lastSpecRef=null;    // канва пересоздана — продавить свежую строку ниже
      }
      const m=n.s.mag,N=m.length;
      const ox=n.ocx;

      // индекс бина на столбец пикселя раньше считался заново для водопада, эталона и кривой спектра —
      // до 3 бинарных поисков (specBin) на столбец за кадр. Пересчитываем только при смене параметров оси.
      // n.p.auto добавлен в ключ: в авто-режиме fmin/fmax не меняются, а реальные границы (specSpan)
      // могут — но при их смене меняется и ссылка n.s.freqs (см. rtlUpdateSpec), так что она это ловит.
      // Два кэша: _binX — логический, под кривую спектра (векторная отрисовка); _binXwf — под водопад,
      // на разрешении физического буфера (может быть в devicePixelRatio раз гуще).
      if(n._bW!==W || n._bWp!==Wp || n._bN!==N || n._bLog!==n.p.log || n._bAuto!==n.p.auto ||
         n._bFmin!==n.p.fmin || n._bFmax!==n.p.fmax || n._bFreqs!==(n.s.freqs||null)){
        n._bW=W; n._bWp=Wp; n._bN=N; n._bLog=n.p.log; n._bAuto=n.p.auto;
        n._bFmin=n.p.fmin; n._bFmax=n.p.fmax; n._bFreqs=n.s.freqs||null;
        n._binX=new Float32Array(W);                  // дробный бин, не округляем — ниже линейная интерполяция
        for(let x=0;x<W;x++) n._binX[x]=clamp(specBin(n.s,saFreq(n,x/(W-1))),0,N-1);
        n._binXwf=new Float32Array(Wp);
        for(let x=0;x<Wp;x++) n._binXwf[x]=clamp(specBin(n.s,saFreq(n,x/(Wp-1))),0,N-1);
      }
      const binX=n._binX;
      // при редких бинах (вейвлет/октавный анализатор) соседние пиксели часто попадают в один и
      // тот же бин, а на стыке — резко скачут в следующий; линейная интерполяция превращает
      // лесенку в гладкую кривую, для частых бинов (fft) эффекта почти не заметно
      const magAt=(arr,bf)=>{ const i0=bf|0, i1=Math.min(N-1,i0+1), t=bf-i0;
        return arr[i0]+(arr[i1]-arr[i0])*t; };

      // спектр может обновляться медленнее кадров отрисовки (например, у rtlsdr — раз в ~80мс,
      // а draw идёт на каждый rAF) — без проверки свежести один и тот же спектр продавливался бы
      // в водопад несколько раз подряд, и картина "размазывалась" по времени. У части узлов
      // (fft/octave/wavelet/cepstrum) объект спектра переиспользуется (мутируется на месте, без
      // лишних аллокаций в реальном времени) — для них сверяем счётчик rev, а не ссылку;
      // у кого rev нет (на всякий случай) — сверяем ссылку самого объекта.
      const fresh = n.s.rev!=null ? n.s.rev!==n._lastRev : n.s!==n._lastSpecRef;
      if(fresh || !n._wfInited){
        ox.drawImage(n.off,0,1);                     // сдвигаем водопад на строку только на новых данных
        const binXwf=n._binXwf;
        const line=n._line, d=line.data;
        for(let x=0;x<Wp;x++){
          const v=clamp((20*Math.log10(magAt(m,binXwf[x])+1e-12)-n.p.floor)/((n.p.top-n.p.floor)||1),0,1);
          const hk=heatIdx(v)*3, k=x*4;
          d[k]=HEAT_LUT[hk]; d[k+1]=HEAT_LUT[hk+1]; d[k+2]=HEAT_LUT[hk+2]; d[k+3]=255; }
        ox.putImageData(line,0,0);
        n._lastRev=n.s.rev; n._lastSpecRef=n.s; n._wfInited=true;
      }
      if(n.p.grid) saGrid(n,cx,W,hs,H);
      const R=n.refMag&&n.refMag.length===N? n.refMag : null;
      const diff=R&&n.p.ref==='разность';
      if(R&&n.p.ref==='показать'){                    // эталон бледной линией под текущим
        cx.strokeStyle='#8ab4f8'; cx.globalAlpha=.55; cx.beginPath();
        for(let x=0;x<W;x++){
          const y=hs-clamp((20*Math.log10(magAt(R,binX[x])+1e-12)-n.p.floor)/((n.p.top-n.p.floor)||1),0,1)*(hs-2)-1;
          x?cx.lineTo(x,y):cx.moveTo(x,y); }
        cx.stroke(); cx.globalAlpha=1; }
      if(!n.colTS || ((n.colFrame=(n.colFrame||0)+1)%30===0))  // цвет темы — тоже не каждый кадр
        n.colTS=getComputedStyle(document.body).getPropertyValue('--t-spec');
      const mode=n.p.mode;
      if(mode==='фаза' && n.s.phase){
        // фаза бина — то же значение, что использует фазовое уточнение fr1..fr4, просто нарисованное.
        // Скачки на стыке ±π — это заворачивание фазы (принцип. значение), а не баг отрисовки:
        // так её везде рисуют, для развёрнутой (unwrap) фазы нужен отдельный режим.
        cx.strokeStyle='#e0b23c'; cx.lineWidth=1; cx.beginPath();
        const ph=n.s.phase;
        for(let x=0;x<W;x++){
          const pv=magAt(ph,binX[x]);
          const y=hs-((pv+Math.PI)/(2*Math.PI))*(hs-2)-1;
          x?cx.lineTo(x,y):cx.moveTo(x,y); }
        cx.stroke();
        cx.strokeStyle='#ffffff18'; cx.beginPath();               // ось 0 рад — для ориентира
        cx.moveTo(0,hs/2); cx.lineTo(W,hs/2); cx.stroke();
      } else if(mode==='СПМ' && n.s.psd){
        // спектральная плотность мощности — та же кривая, что и амплитуда, только своя нормировка
        // (Вт/Гц вместо просто амплитуды): шумовой пол не гуляет при смене размера окна БПФ,
        // амплитуда/мощность (в дБ) — гуляет, это и есть разница между ними по сути, а не по картинке
        cx.strokeStyle='#4ec9b0'; cx.lineWidth=1; cx.beginPath();
        const psd=n.s.psd;
        for(let x=0;x<W;x++){
          const v=10*Math.log10(magAt(psd,binX[x])+1e-20);
          const y=hs-clamp((v-n.p.floor)/((n.p.top-n.p.floor)||1),0,1)*(hs-2)-1;
          x?cx.lineTo(x,y):cx.moveTo(x,y); }
        cx.stroke();
      } else {
      // 'амплитуда' и 'мощность' — буквально одна и та же кривая (20·log|X| ≡ 10·log|X|²),
      // разница только в подписи единиц, отдельного кода для 'мощность' поэтому нет
      cx.strokeStyle=n.colTS;
      cx.lineWidth=1; cx.beginPath();
      for(let x=0;x<W;x++){
        const mv=magAt(m,binX[x]);
        const v=diff? 20*Math.log10((mv+1e-12)/(magAt(R,binX[x])+1e-12))
                    : 20*Math.log10(mv+1e-12);
        const lo=diff? -40 : n.p.floor, hiv=diff? 40 : n.p.top;
        const y=hs-clamp((v-lo)/((hiv-lo)||1),0,1)*(hs-2)-1;
        x?cx.lineTo(x,y):cx.moveTo(x,y); }
      cx.stroke();
      if(diff){ cx.strokeStyle='#ffffff22'; cx.beginPath();
        cx.moveTo(0,hs/2); cx.lineTo(W,hs/2); cx.stroke(); }
      }
      cx.drawImage(n.off,0,hs,W,hw);       // без dw/dh источник (физ. пиксели) масштабируется на dpr лишний раз
    } else if(n.p.grid) saGrid(n,cx,W,hs,H);
    cx.strokeStyle='#2a3136'; cx.beginPath(); cx.moveTo(0,hs+.5); cx.lineTo(W,hs+.5); cx.stroke();
    saBands(n,cx,W,H);
    saMarkers(n,cx,W,hs); }});


// Опорные точки палитры водопада (t от 0 до 1) — та же цветовая идея, что у gqrx/SDR++
// (тёмный → синий → голубой → зелёный → жёлтый → оранжевый → белый), но переходы между
// точками — по smoothstep, а не жёсткой прямой: убирает заметные изломы/"грубость" на стыках.
const HEAT_STOPS=[[0,0,0,0],[.08,0,0,140],[.28,0,180,255],[.42,0,255,140],[.62,220,255,0],[.85,255,120,0],[1,255,255,255]];
// таблица 256 цветов вместо пересчёта (гамма+поиск+smoothstep+аллокация) на каждый пиксель каждого кадра
const HEAT_LUT=(()=>{
  const N=256, t=new Uint8ClampedArray(N*3);
  for(let i=0;i<N;i++){
    const v=Math.pow(i/(N-1),0.6);
    let k=0; while(k<HEAT_STOPS.length-2 && v>HEAT_STOPS[k+1][0]) k++;
    const [t0,r0,g0,b0]=HEAT_STOPS[k], [t1,r1,g1,b1]=HEAT_STOPS[k+1];
    let tt=clamp((v-t0)/((t1-t0)||1),0,1); tt=tt*tt*(3-2*tt);
    t[i*3]=r0+(r1-r0)*tt; t[i*3+1]=g0+(g1-g0)*tt; t[i*3+2]=b0+(b1-b0)*tt;
  }
  return t;
})();
function heatIdx(v){ return (clamp(v,0,1)*255)|0; }   // индекс в HEAT_LUT, без аллокаций
function heat(v){ const k=heatIdx(v)*3; return [HEAT_LUT[k],HEAT_LUT[k+1],HEAT_LUT[k+2]]; } // на случай внешних вызовов

def({ id:'const2', title:'Созвездие', cat:'Анализ', ins:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'dec',t:'num'},{n:'scale',t:'num'},{n:'fade',t:'num'}],
  view:{h:150},
  params:[{n:'dec',t:'range',min:1,max:64,step:1,d:8},
          {n:'scale',t:'range',min:.2,max:10,step:.1,d:2},
          {n:'fade',t:'range',min:.01,max:.5,step:.01,d:.08}],
  init:n=>{n.pts=[];},
  process(n,I){
    for(const k of ['dec','scale','fade']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(!I.I||!I.Q) return {};
    const d=+n.p.dec;
    for(let i=0;i<BLOCK;i+=d){ n.pts.push(I.I[i],I.Q[i]); }
    while(n.pts.length>4000) n.pts.splice(0,400);
    return {}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height,R=Math.min(W,H)/2*.9;
    cx.fillStyle=`rgba(10,13,14,${n.p.fade})`; cx.fillRect(0,0,W,H);
    cx.strokeStyle='#1e2529'; cx.beginPath();
    cx.moveTo(W/2,0);cx.lineTo(W/2,H);cx.moveTo(0,H/2);cx.lineTo(W,H/2);cx.stroke();
    cx.fillStyle=getComputedStyle(document.body).getPropertyValue('--t-num');
    const s=n.p.scale;
    for(let i=Math.max(0,n.pts.length-1200);i<n.pts.length;i+=2){
      const x=W/2+clamp(n.pts[i]*s,-1,1)*R, y=H/2-clamp(n.pts[i+1]*s,-1,1)*R;
      cx.fillRect(x,y,1.5,1.5); } }});


def({ id:'peak', title:'Пик частоты', cat:'Анализ',
  ins:[{n:'spec',t:'spec'},{n:'fc',t:'num'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},
       {n:'floor',t:'num'},{n:'top',t:'num'},{n:'thr',t:'num'},{n:'hold',t:'num'},
       {n:'track',t:'num'},{n:'tol',t:'num'}],
  outs:[{n:'freq',t:'num'},{n:'level',t:'num'},{n:'gate',t:'num'},
        {n:'fLo',t:'num'},{n:'fHi',t:'num'}],
  readout:true, view:{h:40},
  params:[{n:'fmin',t:'range',min:20,max:()=>Eng.sr/2,step:1,d:300,log:true},
          {n:'fmax',t:'range',min:20,max:()=>Eng.sr/2,step:1,d:8000,log:true},
          {n:'floor',t:'range',min:-140,max:-20,step:1,d:-80},
          {n:'top',t:'range',min:-60,max:20,step:1,d:-20},
          {n:'thr',t:'range',min:-120,max:0,step:1,d:-55},
          {n:'hold',t:'range',min:0,max:2000,step:5,d:60},
          {n:'track',t:'check',d:false},
          {n:'tol',t:'range',min:5,max:2000,step:5,d:150,log:true}],
  init:n=>{n.f=0;n.lock=0;n.db=-120;n.lv=0;n.holdT=0;n.hist=[];},
  process(n,I){
    for(const k of ['fmin','fmax','floor','top','thr','hold','tol']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.track==='number') setMod(n,'track',I.track>=0.5);
    const s=I.spec; if(!s) return {freq:n.lock,level:0,gate:0,fLo:null,fHi:null};
    const dt=BLOCK/Eng.sr*1000, N=s.mag.length;
    const tune=(typeof I.fc==='number'&&I.fc>20)?I.fc:null;
    let lo,hi;
    if(tune!=null){                               // задан центр снаружи: окно ±tol вокруг него
      lo=Math.max(1,Math.floor(specBin(s,tune-n.p.tol)));
      hi=Math.min(N-2,Math.ceil(specBin(s,tune+n.p.tol)));
      n.win=[tune-n.p.tol,tune+n.p.tol];
    } else {
      lo=Math.max(1,Math.floor(specBin(s,n.p.fmin)));
      hi=Math.min(N-2,Math.ceil(specBin(s,n.p.fmax)));
      if(n.p.track && n.lock){                    // сузить поиск вокруг захваченной частоты
        lo=Math.max(lo,Math.floor(specBin(s,n.lock-n.p.tol)));
        hi=Math.min(hi,Math.ceil(specBin(s,n.lock+n.p.tol))); }
      n.win=[specHz(s,lo),specHz(s,hi)]; }
    if(hi<=lo) hi=lo+1;
    let bi=lo,bv=-1;
    for(let i=lo;i<=hi;i++) if(s.mag[i]>bv){ bv=s.mag[i]; bi=i; }
    const l0=Math.log(s.mag[bi-1]+1e-12), l1=Math.log(bv+1e-12), l2=Math.log(s.mag[bi+1]+1e-12);
    const d=.5*(l0-l2)/(l0-2*l1+l2||1e-9);        // параболическая интерполяция вершины
    const dd=clamp(d,-.5,.5);
    n.f = s.freqs ? specHz(s,bi)*Math.pow(specHz(s,Math.min(N-1,bi+1))/specHz(s,bi), dd)
                  : (bi+dd)*s.sr/s.size;
    n.db=20*Math.log10(bv+1e-12);
    n.lv=clamp((n.db-n.p.floor)/((n.p.top-n.p.floor)||1),0,1);
    if(n.db>n.p.thr){ n.holdT=n.p.hold; n.lock=n.f; } else n.holdT=Math.max(0,n.holdT-dt);
    const gate=(n.db>n.p.thr||n.holdT>0)?1:0;
    n.hist.push(gate?n.lv:0); if(n.hist.length>200) n.hist.shift();
    return {freq:n.lock||n.f, level:n.lv, gate, fLo:n.win[0], fHi:n.win[1]}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    const thrN=clamp((n.p.thr-n.p.floor)/((n.p.top-n.p.floor)||1),0,1);
    cx.strokeStyle='#e05c5c55'; cx.beginPath();
    cx.moveTo(0,H-thrN*H); cx.lineTo(W,H-thrN*H); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-spec');
    cx.beginPath();
    for(let i=0;i<n.hist.length;i++){ const x=i/200*W,y=H-n.hist[i]*H; i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    n.el.querySelector('.readout').textContent =
      (n.lock||n.f).toFixed(1)+' Гц · '+n.db.toFixed(0)+' dB'+
      (n.win?' · окно '+n.win[0].toFixed(0)+'–'+n.win[1].toFixed(0):''); }});


const MORSE={'.-':'A','-...':'B','-.-.':'C','-..':'D','.':'E','..-.':'F','--.':'G','....':'H',
'..':'I','.---':'J','-.-':'K','.-..':'L','--':'M','-.':'N','---':'O','.--.':'P','--.-':'Q',
'.-.':'R','...':'S','-':'T','..-':'U','...-':'V','.--':'W','-..-':'X','-.--':'Y','--..':'Z',
'-----':'0','.----':'1','..---':'2','...--':'3','....-':'4','.....':'5','-....':'6','--...':'7',
'---..':'8','----.':'9','.-.-.-':'.','--..--':',','..--..':'?','-..-.':'/','-....-':'-',
'-.--.':'(','-.--.-':')','---...':':','.-.-.':'+','.--.-.':'@','...-.-':'<SK>','-...-':'='};

def({ id:'morseRx', title:'Морзе: приём', cat:'Декодеры',
  ins:[{n:'level',t:'num'},{n:'sig',t:'sig'},{n:'thr',t:'num'},{n:'auto',t:'num'},{n:'minRun',t:'num'}],
  outs:[{n:'gate',t:'num'},{n:'wpm',t:'num'}],
  readout:true, tall:true, view:{h:44},
  params:[{n:'thr',t:'range',min:.05,max:.95,step:.01,d:.5},
          {n:'auto',t:'check',d:true},
          {n:'minRun',t:'range',min:0,max:120,step:1,d:20},
          {n:'clr',t:'button',label:'Очистить текст',fn:n=>{n.text='';n.cur=[];n.pool=[];n.gaps=[];}}],
  init:n=>{ n.on=false; n.t=0; n.candT=0; n.pool=[]; n.gaps=[]; n.cur=[]; n.text=''; n.space=false;
            n.mn=0; n.mx=1; n.hist=[]; n.thrShow=.5; },
  process(n,I){
    if(typeof I.thr==='number') setMod(n,'thr',I.thr);
    if(typeof I.minRun==='number') setMod(n,'minRun',I.minRun);
    if(typeof I.auto==='number') setMod(n,'auto',I.auto>=0.5);
    let lv=(typeof I.level==='number')? I.level : (I.sig? clamp(rms(I.sig)*4,0,1) : 0);
    let thr=n.p.thr, hys=.06;
    if(n.p.auto){                                  // порог между скользящими min/max
      n.mx = lv>n.mx ? lv : n.mx*.998+lv*.002;
      n.mn = lv<n.mn ? lv : n.mn*.998+lv*.002;
      const d=Math.max(.05,n.mx-n.mn); thr=n.mn+d*n.p.thr; hys=d*.08; }
    n.thrShow=thr;
    const raw = n.on ? lv>thr-hys : lv>thr+hys;
    n.t += BLOCK/Eng.sr*1000;
    if(raw===n.on) n.candT=0;                      // дребезг короче minRun игнорируется
    else { n.candT += BLOCK/Eng.sr*1000;
      if(n.candT>=n.p.minRun){ mCommit(n,n.on,n.t-n.candT); n.on=raw; n.t=n.candT; n.candT=0; } }
    if(!n.on) mIdle(n);
    n.hist.push([lv,thr,n.on?1:0]); if(n.hist.length>240) n.hist.shift();
    return {gate:n.on?1:0, wpm:1200/mEst(n.pool).unit}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height,hs=n.hist; cx.clearRect(0,0,W,H);
    cx.fillStyle='#4ec9b022';
    for(let i=0;i<hs.length;i++) if(hs[i][2]) cx.fillRect(i/240*W,0,W/240+.6,H);
    cx.strokeStyle='#e05c5c88'; cx.beginPath();
    for(let i=0;i<hs.length;i++){ const x=i/240*W,y=H-clamp(hs[i][1],0,1)*H; i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-num'); cx.beginPath();
    for(let i=0;i<hs.length;i++){ const x=i/240*W,y=H-clamp(hs[i][0],0,1)*H; i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    const u=mEst(n.pool).unit, r=n.el.querySelector('.readout');
    const txt=(n.text||'…')+`\n[точка ${u.toFixed(0)} мс · ${(1200/u).toFixed(1)} WPM]`;
    if(r.textContent!==txt){ r.textContent=txt; r.scrollTop=r.scrollHeight; } }});


const mMean = v => v.reduce((s,x)=>s+x,0)/v.length;
function mEst(pool){                               // 2 средних: кластеры точек и тире
  if(!pool.length) return {unit:100,thr:200};
  const a=[...pool].sort((x,y)=>x-y);
  let lo=a[0], hi=a[a.length-1];
  if(hi<lo*1.9) return {unit:mMean(a),thr:mMean(a)*2};
  for(let it=0;it<12;it++){ const L=[],H=[];
    for(const v of a) (Math.abs(v-lo)<=Math.abs(v-hi)?L:H).push(v);
    if(L.length) lo=mMean(L); if(H.length) hi=mMean(H); }
  return {unit:lo, thr:(lo+hi)/2};
}
function mFlush(n){
  if(!n.cur.length) return;
  const {thr}=mEst(n.pool);
  n.text += (MORSE[n.cur.map(d=>d>thr?'-':'.').join('')]||'#'); n.cur=[];
  if(n.text.length>2000) n.text=n.text.slice(-1500);
}
function mGap(n){                                  // единица по паузам, а не по посылкам
  if(n.gaps.length>=3) return mEst(n.gaps).unit;
  return mEst(n.pool).unit;
}
function mCommit(n,wasOn,d){
  if(wasOn){ n.pool.push(d); if(n.pool.length>120) n.pool.shift(); n.cur.push(d); n.space=false; }
  else { const g=mGap(n);
    if(d<g*10){ n.gaps.push(d); if(n.gaps.length>120) n.gaps.shift(); }
    if(d>g*2) mFlush(n);
    if(d>g*5&&!n.space&&n.text&&!n.text.endsWith(' ')){ n.text+=' '; n.space=true; } }
}
function mIdle(n){                                 // добить символ, не дожидаясь нового тона
  const g=mGap(n), t=n.t-n.candT;
  if(n.cur.length && t>g*2) mFlush(n);
  if(!n.space && t>g*5 && n.text && !n.text.endsWith(' ')){ n.text+=' '; n.space=true; }
}

def({ id:'meter', title:'Уровень', cat:'Анализ', ins:[{n:'in',t:'sig'}], outs:[{n:'db',t:'num'}],
  view:{h:26}, readout:true,
  init:n=>{n.db=-120;},
  process(n,I){ const r=I.in?rms(I.in):0;
    const db=20*Math.log10(r+1e-9); n.db=Math.max(db,n.db-3); return {db:n.db}; },
  draw(n,cv,cx){ const W=cv.width,H=cv.height,v=clamp((n.db+80)/80,0,1);
    cx.clearRect(0,0,W,H);
    const g=cx.createLinearGradient(0,0,W,0);
    g.addColorStop(0,'#4ec9b0'); g.addColorStop(.75,'#e0b23c'); g.addColorStop(1,'#e05c5c');
    cx.fillStyle=g; cx.fillRect(0,0,W*v,H);
    n.el.querySelector('.readout').textContent=n.db.toFixed(1)+' dB'; }});


def({ id:'numview', title:'Число', cat:'Анализ', ins:[{n:'in',t:'num'},{n:'digits',t:'num'}], readout:true,
  params:[{n:'digits',t:'range',min:0,max:6,step:1,d:2}],
  process(n,I){ if(typeof I.digits==='number') setMod(n,'digits',I.digits); n.v=I.in; return {}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    (typeof n.v==='number'? n.v.toFixed(n.p.digits) : '—'); }});


def({ id:'imgview', title:'Кадр', cat:'Анализ', ins:[{n:'img',t:'img'}], view:{h:110}, resize:true,
  params:[{n:'png',t:'button',label:'Сохранить снимок',fn:n=>{
    n.tmp && n.tmp.toBlob(b=>dl(b,'frame-'+Date.now()+'.png'),'image/png'); }}],
  process(n,I){ n.i=I.img; return {}; },
  draw(n,cv,cx){ if(!n.i) return;
    n.tmp=n.tmp||document.createElement('canvas');
    if(n.tmp.width!==n.i.w){ n.tmp.width=n.i.w; n.tmp.height=n.i.h;
      n.tcx=n.tmp.getContext('2d'); n.id2=null; }
    if(n.i.gray){                                   // серый буфер растра
      if(!n.id2) n.id2=n.tcx.createImageData(n.i.w,n.i.h);
      const d=n.id2.data, b=n.i.buf;
      for(let k=0;k<b.length;k++){ const v=b[k]*255, j=k*4; d[j]=d[j+1]=d[j+2]=v; d[j+3]=255; }
      n.tcx.putImageData(n.id2,0,0);
    } else n.tcx.putImageData(n.i.data,0,0);
    cx.imageSmoothingEnabled=false;
    cx.drawImage(n.tmp,0,0,cv.width,cv.height); }});


def({ id:'specstat', title:'Статистика спектра', cat:'Анализ', ins:[{n:'spec',t:'spec'},{n:'thr',t:'num'},{n:'tau',t:'num'},{n:'floor',t:'num'},{n:'log',t:'num'}],
  outs:[{n:'stat',t:'spec'}], view:{h:120}, pick:true, resize:true,
  params:[{n:'mode',t:'select',opts:['среднее','максимум','занятость'],d:'занятость'},
          {n:'thr',t:'range',min:-140,max:-20,step:1,d:-85},
          {n:'tau',t:'range',min:1,max:600,step:1,d:60},
          {n:'floor',t:'range',min:-140,max:-20,step:1,d:-110},
          {n:'log',t:'check',d:false},
          {n:'rst',t:'button',label:'Сбросить накопление',fn:n=>{n.acc=null;n.frames=0;}}],
  init:n=>{n.acc=null;n.frames=0;n.pickT=null;n.fsel=0;},
  process(n,I){
    for(const k of ['thr','tau','floor']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    if(typeof I.log==='number') setMod(n,'log',I.log>=0.5);
    const s=I.spec; if(!s) return {stat:null};
    const N=s.mag.length;
    if(!n.acc||n.acc.length!==N){ n.acc=new Float32Array(N); n.frames=0; }
    const dt=BLOCK/Eng.sr, k=Math.exp(-dt/n.p.tau);   // постоянная времени в секундах
    for(let i=0;i<N;i++){
      const db=20*Math.log10(s.mag[i]+1e-12);
      if(n.p.mode==='максимум') n.acc[i]=Math.max(n.acc[i]||n.p.floor, db);
      else if(n.p.mode==='среднее') n.acc[i]=n.acc[i]*k+db*(1-k);
      else n.acc[i]=n.acc[i]*k+(db>n.p.thr?1:0)*(1-k); }
    n.frames++; n.s=s;
    n.stat=n.stat||{}; n.stat.mag=n.acc; n.stat.sr=s.sr; n.stat.size=s.size; n.stat.stat=true;
    if(n.pickT!=null) n.fsel=specHz(s,binAt(n.pickT,N,n.p.log));
    return {stat:n.stat}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(!n.acc||!n.s) return;
    const N=n.acc.length, occ=n.p.mode==='занятость';
    cx.fillStyle='#4ec9b033'; cx.strokeStyle=getComputedStyle(document.body)
      .getPropertyValue(occ?'--t-sig':'--t-spec');
    cx.beginPath(); cx.moveTo(0,H);
    for(let x=0;x<W;x++){
      const b=clamp(Math.round(binAt(x/(W-1),N,n.p.log)),0,N-1);
      const v=occ? clamp(n.acc[b],0,1) : clamp((n.acc[b]-n.p.floor)/(0-n.p.floor),0,1);
      cx.lineTo(x,H-v*H); }
    cx.lineTo(W,H); cx.fill(); cx.stroke();
    cx.fillStyle='#6c7a80'; cx.font='9px monospace';
    cx.fillText(n.p.mode+' · '+(n.frames*BLOCK/Eng.sr).toFixed(0)+' с',3,10);
    if(n.pickT!=null){ const x=n.pickT*W;
      cx.strokeStyle='#e0b23c'; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke();
      const t=n.fsel.toFixed(0)+' Гц', tw=cx.measureText(t).width;
      const tx=clamp(x+4,2,W-tw-4);
      cx.fillStyle='#0e1113cc'; cx.fillRect(tx-3,H-15,tw+6,13);
      cx.fillStyle='#e0b23c'; cx.fillText(t,tx,H-5); } }});


def({ id:'goertzel', title:'Гёрцель', cat:'Анализ',
  ins:[{n:'in',t:'sig'},{n:'f',t:'num'},{n:'ms',t:'num'},{n:'floor',t:'num'},{n:'top',t:'num'}],
  outs:[{n:'mag',t:'num'},{n:'db',t:'num'},{n:'env',t:'sig'},{n:'level',t:'sig'}],
  view:{h:40}, readout:true,
  params:[{n:'f',t:'range',min:20,max:()=>Eng.sr/2,step:1,d:1000,log:true},
          {n:'ms',t:'range',min:2,max:200,step:1,d:20,label:'окно, мс'},
          {n:'floor',t:'range',min:-140,max:-20,step:1,d:-90},
          {n:'top',t:'range',min:-60,max:20,step:1,d:0}],
  init:n=>{n.s1=0;n.s2=0;n.k=0;n.mag=0;n.db=-120;n.hist=[];},
  process(n,I){
    for(const k of ['ms','floor','top']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const oe=buf(n,'env'), ol=buf(n,'level'), f=pv(n,I,'f');
    const N=Math.max(4,Math.round(n.p.ms*Eng.sr/1000));
    const c=2*Math.cos(2*Math.PI*f/Eng.sr);         // один бин ДПФ рекуррентно
    for(let i=0;i<BLOCK;i++){
      const s0=(I.in?I.in[i]:0)+c*n.s1-n.s2; n.s2=n.s1; n.s1=s0;
      if(++n.k>=N){                                  // окно закончилось — снимаем оценку
        n.mag=2*Math.sqrt(Math.max(0,n.s1*n.s1+n.s2*n.s2-c*n.s1*n.s2))/N;
        n.db=20*Math.log10(n.mag+1e-12);
        n.s1=0; n.s2=0; n.k=0; }
      oe[i]=n.mag;
      ol[i]=clamp((n.db-n.p.floor)/((n.p.top-n.p.floor)||1),0,1); }
    n.hist.push(ol[BLOCK-1]); if(n.hist.length>120) n.hist.shift();
    return {mag:n.mag, db:n.db, env:oe, level:ol}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.lineWidth=1; cx.beginPath();
    for(let i=0;i<n.hist.length;i++){ const x=i/120*W, y=H-n.hist[i]*H;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    n.el.querySelector('.readout').textContent=n.db.toFixed(1)+' dB'; }});


def({ id:'autocorr', title:'Автокоррелятор', cat:'Анализ', ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'norm',t:'num'}],
  outs:[{n:'f',t:'num'},{n:'lagMs',t:'num'},{n:'conf',t:'num'}],
  view:{h:120}, resize:true, readout:true,
  params:[{n:'win',t:'select',opts:['0.05','0.1','0.25','0.5','1','2','4'],d:'0.1',label:'окно, с'},
          {n:'fmin',t:'range',min:10,max:5000,step:1,d:50,log:true},
          {n:'fmax',t:'range',min:50,max:()=>Eng.sr/2,step:1,d:5000,log:true},
          {n:'norm',t:'check',d:true,label:'нормировать'}],
  init:n=>{n.ring=null;n.w=0;n.filled=0;n.r=null;n.f=0;n.conf=0;n.lag=0;n.cnt=0;},
  process(n,I){
    if(typeof I.fmin==='number') setMod(n,'fmin',I.fmin);
    if(typeof I.fmax==='number') setMod(n,'fmax',I.fmax);
    if(typeof I.norm==='number') setMod(n,'norm',I.norm>=0.5);
    const need=Math.round(+n.p.win*Eng.sr);
    if(!n.ring||n.ring.length!==need){ n.ring=new Float32Array(need); n.w=0; n.filled=0; }
    for(let i=0;i<BLOCK;i++){ n.ring[n.w]=I.in?I.in[i]:0; n.w=(n.w+1)%need; }
    n.filled=Math.min(need,n.filled+BLOCK);
    if(n.filled>=need && ++n.cnt%4===0) acCompute(n);
    return {f:n.f, lagMs:n.lag/Eng.sr*1000, conf:n.conf}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(!n.r) return;
    cx.strokeStyle='#1e2529'; cx.beginPath(); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-spec');
    cx.lineWidth=1; cx.beginPath();
    for(let i=0;i<n.r.length;i++){ const x=i/(n.r.length-1)*W, y=H/2-clamp(n.r[i],-1,1)*H/2*.95;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    if(n.lag){                                       // отметка найденного периода
      const t=(n.lag-n.lo)/Math.max(1,n.hi-n.lo);
      const x=clamp(t,0,1)*W;
      cx.strokeStyle='#e0b23c'; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); }
    n.el.querySelector('.readout').textContent =
      (n.f? n.f.toFixed(2)+' Гц · '+(n.lag/Eng.sr*1000).toFixed(2)+' мс':'—')+
      ' ('+(n.conf*100).toFixed(0)+'%)'; }});


def({ id:'scanner', title:'Авто-сканер частот', cat:'Анализ',
  ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'step',t:'num'},
       {n:'threshold',t:'num'},{n:'hold',t:'num'},{n:'speed',t:'num'}],
  outs:[{n:'freq',t:'num'},{n:'level',t:'num'},{n:'active',t:'num'}],
  readout:true, tall:true,
  params:[{n:'fmin',t:'range',min:100,max:()=>Eng.sr/2,step:100,d:1000,log:true},
          {n:'fmax',t:'range',min:200,max:()=>Eng.sr/2,step:100,d:3000,log:true},
          {n:'step',t:'range',min:50,max:1000,step:50,d:100,label:'шаг, Гц'},
          {n:'threshold',t:'range',min:0.001,max:0.1,step:0.001,d:0.01,label:'чувствительность'},
          {n:'hold',t:'range',min:0.1,max:5,step:0.1,d:1,label:'удержание, с'},
          {n:'speed',t:'range',min:1,max:100,step:1,d:20,label:'скорость сканирования'}],
  init:n=>{ 
    n.freq = 0;
    n.hits = [];
    n.phase = 0;
    n.holdTimer = 0;
    n.currentFreq = 0;
    n.signalLevel = 0;
    n.scanning = true;
    n.lastFound = '';
  },
  process(n,I){
    for(const k of ['fmin','fmax','step','threshold','hold','speed'])
      if(typeof I[k]==='number') setMod(n,k,I[k]);
    const dt = BLOCK / Eng.sr;
    const fmin = n.p.fmin;
    const fmax = n.p.fmax;
    const step = n.p.step;
    const speed = n.p.speed;
    const N = 2048;
    
    // Быстрый детектор уровня на заданной частоте
    if(!n.buf || n.buf.length !== N){
      n.buf = new Float32Array(N);
      n.w = 0;
      n.levels = [];
      n.re = new Float32Array(N); n.im = new Float32Array(N);   // переиспользуем — раньше аллоцировались на каждый БПФ
      n.win = window_('hann', N);
    }
    
    for(let i=0;i<BLOCK;i++){
      n.buf[n.w] = I.in ? I.in[i] : 0;
      n.w = (n.w+1) % N;
    }
    
    // БПФ каждые 512 отсчётов
    if(n.w % 512 < BLOCK){
      const re = n.re, im = n.im, win = n.win;
      im.fill(0);                                    // im мог остаться грязным с прошлого БПФ (fft считает in-place)
      for(let i=0;i<N;i++){
        re[i] = n.buf[(n.w+i)%N] * win[i];
      }
      fft(re, im);
      
      // Сканируем текущую частоту
      const bin = Math.floor(n.currentFreq / Eng.sr * N);
      const bw = Math.floor(step * 2 / Eng.sr * N);
      let sum = 0;
      for(let i=Math.max(1, bin-bw); i<Math.min(N/2, bin+bw); i++){
        sum += Math.hypot(re[i], im[i]);
      }
      n.signalLevel = sum / (bw*2 + 1);
      
      // Движемся дальше
      if(n.signalLevel < n.p.threshold){
        n.holdTimer = 0;
        n.currentFreq += step * speed / 10;
        if(n.currentFreq > fmax) n.currentFreq = fmin;
        n.scanning = true;
      } else {
        n.holdTimer += dt;
        if(n.holdTimer > n.p.hold){
          // Нашли сигнал!
          const foundFreq = Math.round(n.currentFreq / 10) * 10;
          if(!n.hits.some(h => Math.abs(h.freq - foundFreq) < step*2)){
            n.hits.push({
              freq: foundFreq,
              level: n.signalLevel,
              time: Date.now()
            });
            if(n.hits.length > 20) n.hits.shift();
          }
          n.currentFreq += step * 2; // перешагиваем
          if(n.currentFreq > fmax) n.currentFreq = fmin;
          n.scanning = true;
          n.holdTimer = 0;
        }
      }
      
      n.freq = n.currentFreq;
    }
    
    // Формируем текст для вывода
    let text = `🔍 Сканирование: ${Math.round(n.currentFreq)} Гц\n`;
    text += `📊 Уровень: ${(n.signalLevel*1000).toFixed(0)} мВ\n`;
    text += n.scanning ? '⏳ Поиск...\n' : '🔒 Удержание\n';
    text += '\n📡 Найдено сигналов:\n';
    const now = Date.now();
    const recent = n.hits.filter(h => now - h.time < 60000);
    recent.slice(-10).forEach(h => {
      text += `  ${h.freq} Гц  (${(h.level*1000).toFixed(0)} мВ)\n`;
    });
    n.text = text;
    
    return {
      freq: n.currentFreq,
      level: n.signalLevel,
      active: n.signalLevel > n.p.threshold ? 1 : 0
    };
  },
  draw(n){
    const r = n.el.querySelector('.readout');
    if(r.textContent !== n.text) r.textContent = n.text || 'сканирование...';
  }
});


def({ id:'signalID', title:'Распознавание сигнала', cat:'Анализ',
  ins:[{n:'in',t:'sig'},{n:'sensitivity',t:'num'}],
  outs:[{n:'type',t:'txt'},{n:'prob',t:'num'}],
  readout:true,
  params:[{n:'sensitivity',t:'range',min:0.1,max:2,step:0.1,d:1,label:'чувствительность'}],
  init:n=>{ 
    n.history=[];
    n.lastType='';
    n.prob=0;
    n.text='ожидание...';
  },
  process(n,I){
    if(typeof I.sensitivity==='number') setMod(n,'sensitivity',I.sensitivity);
    const dt = BLOCK / Eng.sr;
    const N = 2048;
    
    // Накопление буфера
    if(!n.buf){ n.buf = new Float32Array(N); n.w=0;
      n.re = new Float32Array(N); n.im = new Float32Array(N);   // переиспользуем — раньше аллоцировались на каждый БПФ
      n.win = window_('hann', N); }
    for(let i=0;i<Math.min(BLOCK,N);i++){
      n.buf[n.w] = I.in ? I.in[i] : 0;
      n.w = (n.w+1) % N;
    }
    
    // Анализ каждые 2048 отсчётов
    if(n.w % 512 < BLOCK){
      // 1. БПФ для анализа спектра
      const re = n.re, im = n.im, win = n.win;
      im.fill(0);                                    // im мог остаться грязным с прошлого БПФ (fft считает in-place)
      for(let i=0;i<N;i++) re[i] = n.buf[(n.w+i)%N] * win[i];
      fft(re, im);
      
      // 2. Извлечение признаков
      let energy = 0;
      let peakFreq = 0;
      let peakAmp = 0;
      let harmonics = 0;
      let bandwidth = 0;
      let entropy = 0;
      
      const half = N/2;
      let totalEnergy = 0;
      let mean = 0;
      
      // Первый проход: энергия и пик
      for(let i=1; i<half; i++){
        const amp = Math.hypot(re[i], im[i]);
        energy += amp*amp;
        if(amp > peakAmp){ peakAmp = amp; peakFreq = i * Eng.sr / N; }
        mean += amp;
      }
      mean /= half;
      
      // Второй проход: статистика
      let sumVar = 0;
      let peakCount = 0;
      let spectralCentroid = 0;
      
      for(let i=1; i<half-1; i++){
        const amp = Math.hypot(re[i], im[i]);
        const amp2 = Math.hypot(re[i+1], im[i+1]);
        const amp0 = Math.hypot(re[i-1], im[i-1]);
        
        // Локальные пики (гармоники)
        if(amp > amp0 * 1.2 && amp > amp2 * 1.2 && amp > mean*3) {
          peakCount++;
          const f = i * Eng.sr / N;
          if(f > peakFreq * 1.8 && f < peakFreq * 2.2) harmonics++;
        }
        
        spectralCentroid += amp * i;
        sumVar += (amp - mean) * (amp - mean);
        bandwidth += amp * Math.abs(i - peakFreq * N / Eng.sr);
      }
      
      const variance = sumVar / half;
      bandwidth /= (energy + 0.001);
      spectralCentroid /= (energy + 0.001);
      
      // 3. Классификация
      const s = n.p.sensitivity;
      let type = 'неизвестно';
      let prob = 0;
      
      // CW: узкая полоса, много гармоник, высокий пик/шум
      if(peakAmp > mean*10 && bandwidth < 200 && peakFreq < 3000){
        if(harmonics > 3 && peakFreq > 300 && peakFreq < 2000){
          type = '📡 CW (морзе)';
          prob = 0.9;
        } else {
          type = '🔊 Тон';
          prob = 0.8;
        }
      }
      // RTTY/FSK: два пика
      else if(peakCount > 1 && peakCount < 4 && bandwidth > 100 && bandwidth < 500){
        type = '📟 RTTY / FSK';
        prob = 0.8;
      }
      // PSK: спектр с двумя боковыми
      else if(peakCount > 2 && peakCount < 6 && variance > 1000){
        type = '📶 PSK / QPSK';
        prob = 0.75;
      }
      // Голос: широкий спектр, плавный спад
      else if(energy > 0.1 && bandwidth > 1000 && bandwidth < 4000 && variance < 10000){
        type = '🎤 Голос / музыка';
        prob = 0.85;
      }
      // Шум: плоский спектр
      else if(energy < 0.01 && variance < 100){
        type = '❄️ Шум / тишина';
        prob = 0.9;
      }
      // SSTV: периодические пики
      else if(peakCount > 5 && peakCount < 15 && variance > 10000 && bandwidth > 1000){
        type = '🖼️ SSTV / факс';
        prob = 0.7;
      }
      // Модулированный сигнал (AM/FM)
      else if(bandwidth > 3000 && bandwidth < 8000 && peakAmp > mean*5){
        type = '📻 AM / FM';
        prob = 0.75;
      }
      // OFDM (DRM/DAB): множество пиков
      else if(peakCount > 10 && bandwidth > 5000){
        type = '📶 OFDM (DRM/DAB)';
        prob = 0.8;
      }
      
      // Усреднение истории для стабильности
      n.history.push({type, prob});
      if(n.history.length > 20) n.history.shift();
      
      // Сглаженный вывод
      const types = {};
      for(const h of n.history){
        types[h.type] = (types[h.type] || 0) + h.prob;
      }
      let bestType = 'неизвестно';
      let bestProb = 0;
      for(const [t,p] of Object.entries(types)){
        if(p > bestProb){ bestProb = p; bestType = t; }
      }
      
      n.lastType = bestType;
      n.prob = Math.min(1, bestProb / n.history.length);
      n.text = `${bestType} (${(n.prob*100).toFixed(0)}%)`;
    }
    
    return {type: n.lastType, prob: n.prob};
  },
  draw(n){
    const r = n.el.querySelector('.readout');
    if(r.textContent !== n.text) r.textContent = n.text || 'ожидание...';
  }
});


def({ id:'xcorr', title:'Взаимная корреляция', cat:'Анализ',
  ins:[{n:'A',t:'sig'},{n:'B',t:'sig'},{n:'maxMs',t:'num'},{n:'smooth',t:'num'}],
  outs:[{n:'lagMs',t:'num'},{n:'lagN',t:'num'},{n:'peak',t:'num'}],
  view:{h:110}, resize:true, readout:true,
  params:[{n:'maxMs',t:'range',min:.1,max:200,step:.1,d:10,label:'диапазон, мс'},
          {n:'win',t:'select',opts:['0.05','0.1','0.25','0.5'],d:'0.1',label:'окно, с'},
          {n:'smooth',t:'range',min:0,max:.99,step:.01,d:.7,label:'усреднение'}],
  init:n=>{n.a=null;n.b=null;n.w=0;n.r=null;n.lag=0;n.peak=0;n.cnt=0;},
  process(n,I){
    if(typeof I.maxMs==='number') setMod(n,'maxMs',I.maxMs);
    if(typeof I.smooth==='number') setMod(n,'smooth',I.smooth);
    const need=Math.round(+n.p.win*Eng.sr);
    if(!n.a||n.a.length!==need){ n.a=new Float32Array(need); n.b=new Float32Array(need); n.w=0; }
    for(let i=0;i<BLOCK;i++){
      n.a[n.w]=I.A?I.A[i]:0; n.b[n.w]=I.B?I.B[i]:0; n.w=(n.w+1)%need; }
    if(++n.cnt%4===0) xcCompute(n);
    return {lagMs:n.lag/Eng.sr*1000, lagN:n.lag, peak:n.peak}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(!n.r) return;
    cx.strokeStyle='#1e2529';
    cx.beginPath(); cx.moveTo(W/2,0); cx.lineTo(W/2,H); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-spec');
    cx.beginPath();
    for(let i=0;i<n.r.length;i++){ const x=i/(n.r.length-1)*W, y=H/2-clamp(n.r[i],-1,1)*H/2*.95;
      i?cx.lineTo(x,y):cx.moveTo(x,y); }
    cx.stroke();
    const M=n.M||1, x=(n.lag+M)/(2*M)*W;
    cx.strokeStyle='#e0b23c'; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke();
    n.el.querySelector('.readout').textContent =
      (n.lag/Eng.sr*1000).toFixed(3)+' мс · '+n.lag.toFixed(1)+' отсч · r='+n.peak.toFixed(2); }});


function xcCompute(n){
  const N=n.a.length, M=Math.min(N>>2,Math.round(n.p.maxMs*Eng.sr/1000));
  const A=new Float32Array(N), B=new Float32Array(N);
  let ma=0,mb=0;
  for(let i=0;i<N;i++){ A[i]=n.a[(n.w+i)%N]; B[i]=n.b[(n.w+i)%N]; ma+=A[i]; mb+=B[i]; }
  ma/=N; mb/=N;
  let ea=0,eb=0;
  for(let i=0;i<N;i++){ A[i]-=ma; B[i]-=mb; ea+=A[i]*A[i]; eb+=B[i]*B[i]; }
  const nrm=Math.sqrt(ea*eb)+1e-12;
  const len=2*M+1, step=N>8192?2:1;
  if(!n.r||n.r.length!==len) n.r=new Float32Array(len);
  const sm=n.p.smooth;
  let best=0,bi=0;
  for(let L=-M;L<=M;L++){
    let acc=0;
    const i0=Math.max(0,-L), i1=Math.min(N,N-L);
    for(let i=i0;i<i1;i+=step) acc+=A[i]*B[i+L];
    const v=acc*step/nrm;
    const k=L+M;
    n.r[k]=n.r[k]*sm+v*(1-sm);
    if(Math.abs(n.r[k])>Math.abs(best)){ best=n.r[k]; bi=L; } }
  n.M=M;
  const k=bi+M;                                      // уточнение вершины параболой
  if(k>0&&k<len-1){
    const y0=n.r[k-1], y1=n.r[k], y2=n.r[k+1];
    n.lag=bi+clamp(.5*(y0-y2)/(y0-2*y1+y2||1e-9),-.5,.5);
  } else n.lag=bi;
  n.peak=best;
}

def({ id:'tf', title:'АЧХ / когерентность', cat:'Анализ',
  ins:[{n:'ref',t:'sig'},{n:'meas',t:'sig'},{n:'avg',t:'num'}],
  outs:[{n:'H',t:'spec'},{n:'coh',t:'spec'},{n:'delayMs',t:'num'}],
  readout:true,
  params:[{n:'size',t:'select',opts:['512','1024','2048','4096','8192'],d:'2048'},
          {n:'avg',t:'range',min:.5,max:.999,step:.001,d:.95,label:'усреднение'},
          {n:'rst',t:'button',label:'Сбросить накопление',fn:n=>{n.N=0;}}],
  init:n=>{n.N=0;},
  process(n,I){
    if(typeof I.avg==='number') setMod(n,'avg',I.avg);
    const N=Math.max(+n.p.size,BLOCK);
    if(n.N!==N){ n.N=N; n.bx=new Float32Array(N); n.by=new Float32Array(N);
      n.fill=0; n.win=window_('hann',N);
      n.xx=new Float32Array(N/2); n.yy=new Float32Array(N/2);
      n.xyr=new Float32Array(N/2); n.xyi=new Float32Array(N/2);
      n.H=new Float32Array(N/2); n.C=new Float32Array(N/2);
      n.re1=new Float32Array(N); n.im1=new Float32Array(N);
      n.re2=new Float32Array(N); n.im2=new Float32Array(N); }
    for(let i=0;i<BLOCK;i++){
      n.bx[n.fill]=I.ref?I.ref[i]:0; n.by[n.fill]=I.meas?I.meas[i]:0;
      if(++n.fill>=N){ n.fill=0; tfBlock(n); } }
    n.sp1=n.sp1||{}; n.sp1.mag=n.H; n.sp1.sr=Eng.sr; n.sp1.size=N; n.sp1.freqs=null;
    n.sp2=n.sp2||{}; n.sp2.mag=n.C; n.sp2.sr=Eng.sr; n.sp2.size=N; n.sp2.freqs=null;
    return {H:n.sp1, coh:n.sp2, delayMs:n.dl||0}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'усреднено кадров: '+(n.frames||0)+' · средняя когерентность '+(n.cavg||0).toFixed(2); }});


def({ id:'harm', title:'Гармоники и КНИ', cat:'Анализ',
  ins:[{n:'spec',t:'spec'},{n:'f0',t:'num'},{n:'auto',t:'num'},{n:'nh',t:'num'},{n:'tol',t:'num'}],
  outs:[{n:'thd',t:'num'},{n:'f0',t:'num'},{n:'h2',t:'num'},{n:'h3',t:'num'}],
  readout:true, tall:true,
  params:[{n:'f0',t:'range',min:20,max:5000,step:.1,d:1000,log:true},
          {n:'auto',t:'check',d:true,label:'искать основную'},
          {n:'nh',t:'range',min:2,max:16,step:1,d:8,label:'сколько гармоник'},
          {n:'tol',t:'range',min:2,max:200,step:1,d:20,label:'окно, Гц'}],
  init:n=>{n.text='';n.thd=0;},
  process(n,I){
    if(typeof I.auto==='number') setMod(n,'auto',I.auto>=0.5);
    if(typeof I.nh==='number') setMod(n,'nh',I.nh);
    if(typeof I.tol==='number') setMod(n,'tol',I.tol);
    const s=I.spec; if(!s) return {thd:0};
    const N=s.mag.length;
    let f0=(typeof I.f0==='number'&&I.f0>10)? I.f0 : n.p.f0;
    if(n.p.auto&&!(typeof I.f0==='number'&&I.f0>10)){
      let bv=0,bi=1;
      const lo=clamp(Math.floor(specBin(s,20)),1,N-2), hi=clamp(Math.ceil(specBin(s,5000)),1,N-2);
      for(let i=lo;i<=hi;i++) if(s.mag[i]>bv){ bv=s.mag[i]; bi=i; }
      f0=specHz(s,bi); }
    const amp=k=>{                                    // максимум в окне вокруг k-й гармоники
      const f=f0*k;
      const a=clamp(Math.floor(specBin(s,f-n.p.tol)),0,N-1),
            b=clamp(Math.ceil (specBin(s,f+n.p.tol)),0,N-1);
      let m=0; for(let i=a;i<=b;i++) if(s.mag[i]>m) m=s.mag[i];
      return m; };
    const a1=amp(1); const hs=[];
    let sq=0;
    for(let k=2;k<=n.p.nh;k++){ const v=amp(k); hs.push(v); sq+=v*v; }
    n.thd=a1>0? Math.sqrt(sq)/a1*100 : 0;
    n.f0v=f0; n.h2=hs[0]||0; n.h3=hs[1]||0;
    const db=v=>20*Math.log10(v+1e-12);
    n.text='f0 = '+f0.toFixed(1)+' Гц   КНИ = '+n.thd.toFixed(2)+' %\n'+
      '  1  '+(f0).toFixed(0).padStart(6)+' Гц  '+db(a1).toFixed(1).padStart(7)+' dB   0.0 dBc\n'+
      hs.map((v,i)=>('  '+(i+2)).slice(-3)+' '+(f0*(i+2)).toFixed(0).padStart(6)+' Гц  '+
        db(v).toFixed(1).padStart(7)+' dB  '+(db(v)-db(a1)).toFixed(1).padStart(6)+' dBc').join('\n');
    return {thd:n.thd, f0:f0, h2:n.h2, h3:n.h3}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text||'…'; }});


def({ id:'stats', title:'Статистика уровня', cat:'Анализ', ins:[{n:'in',t:'sig'},{n:'tau',t:'num'}],
  outs:[{n:'rms',t:'num'},{n:'peak',t:'num'},{n:'crest',t:'num'},{n:'dbfs',t:'num'}],
  view:{h:100}, resize:true, readout:true, tall:true,
  params:[{n:'tau',t:'range',min:.05,max:10,step:.05,d:1,label:'постоянная, с'},
          {n:'bins',t:'select',opts:['32','64','128','256'],d:'64'},
          {n:'rst',t:'button',label:'Сбросить',fn:n=>{n.h&&n.h.fill(0);n.pk=0;}}],
  init:n=>{n.h=null;n.ms=0;n.pk=0;n.text='';},
  process(n,I){
    if(typeof I.tau==='number') setMod(n,'tau',I.tau);
    const B=+n.p.bins;
    if(!n.h||n.h.length!==B) n.h=new Float32Array(B);
    const x=I.in; if(!x) return {rms:0,peak:0,crest:0,dbfs:-120};
    const a=Math.exp(-BLOCK/Eng.sr/n.p.tau);
    let ms=0,pk=0;
    for(let i=0;i<BLOCK;i++){
      const v=x[i], av=Math.abs(v);
      ms+=v*v; if(av>pk) pk=av;
      const k=clamp(Math.floor((v*.5+.5)*B),0,B-1);   // распределение мгновенных значений
      n.h[k]+=1; }
    ms/=BLOCK;
    n.ms=n.ms*a+ms*(1-a);
    n.pk=Math.max(pk,n.pk*0.999);
    const rms=Math.sqrt(n.ms), crest=rms>0? n.pk/rms : 0;
    n.text='RMS '+(20*Math.log10(rms+1e-12)).toFixed(1)+' dBFS   пик '+
      (20*Math.log10(n.pk+1e-12)).toFixed(1)+' dBFS\nкрест-фактор '+crest.toFixed(2)+
      ' ('+(20*Math.log10(crest+1e-12)).toFixed(1)+' dB)';
    return {rms, peak:n.pk, crest, dbfs:20*Math.log10(rms+1e-12)}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(!n.h) return;
    let mx=1e-9; for(const v of n.h) if(v>mx) mx=v;
    const B=n.h.length, bw=W/B;
    cx.fillStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    for(let k=0;k<B;k++){ const h=n.h[k]/mx*H;
      cx.fillRect(k*bw,H-h,Math.max(1,bw-1),h); }
    const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text; }});


def({ id:'eye', title:'Глазковая диаграмма', cat:'Анализ',
  ins:[{n:'in',t:'sig'},{n:'clk',t:'sig'},{n:'spans',t:'num'},{n:'gain',t:'num'},{n:'fade',t:'num'},{n:'baud',t:'num'}],
  view:{h:180}, resize:true,
  params:[{n:'spans',t:'range',min:1,max:4,step:1,d:2,label:'символов в окне'},
          {n:'gain',t:'range',min:.1,max:10,step:.1,d:1},
          {n:'fade',t:'range',min:.01,max:.5,step:.01,d:.06,label:'затухание'},
          {n:'baud',t:'range',min:1,max:4800,step:.01,d:1200,label:'бод (без clk)'}],
  init:n=>{n.ring=new Float32Array(65536);n.w=0;n.traces=[];n.prev=0;n.acc=0;},
  process(n,I){
    for(const k of ['spans','gain','fade','baud']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const x=I.in; if(!x) return {};
    const sps=Eng.sr/n.p.baud, span=Math.round(sps*n.p.spans);
    for(let i=0;i<BLOCK;i++){
      n.ring[n.w]=x[i]; n.w=(n.w+1)%n.ring.length;
      let tick=false;
      if(I.clk){ const c=I.clk[i]; tick=(c>.5&&n.prev<=.5); n.prev=c; }
      else { n.acc+=1; if(n.acc>=sps){ n.acc-=sps; tick=true; } }
      if(tick && span>2 && span<n.ring.length/2){
        const t=new Float32Array(span);               // окно вокруг момента символа
        const start=(n.w-Math.round(span/2)+n.ring.length*2)%n.ring.length;
        for(let k=0;k<span;k++) t[k]=n.ring[(start+k)%n.ring.length];
        n.traces.push(t); if(n.traces.length>60) n.traces.shift(); } }
    return {}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height;
    cx.fillStyle='rgba(10,13,14,'+n.p.fade+')'; cx.fillRect(0,0,W,H);
    cx.strokeStyle='#1e2529'; cx.beginPath();
    cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.moveTo(W/2,0); cx.lineTo(W/2,H); cx.stroke();
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.globalAlpha=.35;
    for(const t of n.traces){
      cx.beginPath();
      for(let k=0;k<t.length;k++){
        const x=k/(t.length-1)*W, y=H/2-clamp(t[k]*n.p.gain,-1,1)*H/2*.95;
        k?cx.lineTo(x,y):cx.moveTo(x,y); }
      cx.stroke(); }
    cx.globalAlpha=1; }});


def({ id:'freqmeter', title:'Частотомер', cat:'Анализ', ins:[{n:'in',t:'sig'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'digits',t:'num'}],
  outs:[{n:'f',t:'num'},{n:'conf',t:'num'}], readout:true, view:{h:30},
  params:[{n:'fmin',t:'range',min:10,max:5000,step:1,d:100,log:true},
          {n:'fmax',t:'range',min:50,max:()=>Eng.sr/2,step:1,d:5000,log:true},
          {n:'win',t:'select',opts:['0.1','0.25','0.5','1.0'],d:'0.25'},
          {n:'digits',t:'range',min:0,max:4,step:1,d:2}],
  init:n=>{n.ring=null;n.w=0;n.f=0;n.conf=0;n.hist=[];},
  process(n,I){
    for(const k of ['fmin','fmax','digits']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const need=Math.round(+n.p.win*Eng.sr);
    if(!n.ring||n.ring.length!==need){ n.ring=new Float32Array(need); n.w=0; n.filled=0; }
    for(let i=0;i<BLOCK;i++){ n.ring[n.w]=I.in?I.in[i]:0; n.w=(n.w+1)%need; }
    n.filled=Math.min(need,(n.filled||0)+BLOCK);
    if(n.filled>=need && (n.cnt=(n.cnt||0)+1)%4===0) freqMeasure(n);
    return {f:n.f, conf:n.conf}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    cx.fillStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.fillRect(0,0,W*clamp(n.conf,0,1),H);
    n.el.querySelector('.readout').textContent =
      (n.f? n.f.toFixed(n.p.digits)+' Гц' : '—')+'  ('+(n.conf*100).toFixed(0)+'%)'; }});


def({ id:'blkview', title:'Просмотр блока', cat:'Анализ',
  ins:[{n:'blk',t:'blk'},{n:'wrap',t:'num'}], outs:[{n:'text',t:'txt'},{n:'len',t:'num'}],
  readout:true, tall:true,
  params:[{n:'fmt',t:'select',opts:['hex','биты','мягкие','текст'],d:'hex'},
          {n:'wrap',t:'range',min:8,max:128,step:8,d:64,label:'символов в строке'}],
  init:n=>{n.bid=-1;n.text='';},
  process(n,I){
    if(typeof I.wrap==='number') setMod(n,'wrap',I.wrap);
    const b=I.blk; if(!b||b.id===n.bid) return {text:n.text,len:b?b.n:0};
    n.bid=b.id;
    let str='';
    if(n.p.fmt==='мягкие') str=[...b.d].slice(0,600).map(v=>v.toFixed(2)).join(' ');
    else { let bits='';
      for(let i=0;i<b.n;i++) bits+= b.d[i]>0?'1':'0';
      if(n.p.fmt==='биты') str=bits;
      else if(n.p.fmt==='hex'){ for(let i=0;i<bits.length;i+=4)
        str+=parseInt(bits.substr(i,4).padEnd(4,'0'),2).toString(16); }
      else { for(let i=0;i+8<=bits.length;i+=8){ const c=parseInt(bits.substr(i,8),2);
        str+= (c>=32&&c<127)? String.fromCharCode(c):'·'; } } }
    const w=n.p.wrap, lines=[];
    for(let i=0;i<str.length;i+=w) lines.push(str.substr(i,w));
    n.text='блок #'+b.id+' · '+b.n+'\n'+lines.join('\n');
    return {text:n.text,len:b.n}; },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r.textContent!==n.text) r.textContent=n.text||'…'; }});


// K-взвешивание по методике ITU-R BS.1770 (не сертифицированный измеритель, но та же формула):
// пре-фильтр (высокая полка) + RLB-фильтр (ВЧ). Параметры — стандартные значения из спецификации.
function hiShelfCoef(f0,gainDb,Q,sr){
  const A=Math.pow(10,gainDb/40), w0=2*Math.PI*f0/sr, cw=Math.cos(w0), sw=Math.sin(w0);
  const alpha=sw/(2*Q), sA=2*Math.sqrt(A)*alpha;
  const b0=A*((A+1)+(A-1)*cw+sA), b1=-2*A*((A-1)+(A+1)*cw), b2=A*((A+1)+(A-1)*cw-sA);
  const a0=(A+1)-(A-1)*cw+sA, a1=2*((A-1)-(A+1)*cw), a2=(A+1)-(A-1)*cw-sA;
  return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function hpCoef(f0,Q,sr){
  const w0=2*Math.PI*f0/sr, cw=Math.cos(w0), sw=Math.sin(w0), alpha=sw/(2*Q);
  const b0=(1+cw)/2, b1=-(1+cw), b2=(1+cw)/2;
  const a0=1+alpha, a1=-2*cw, a2=1-alpha;
  return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function biq2(s,c,x){
  const y=c[0]*x+c[1]*s.x1+c[2]*s.x2-c[3]*s.y1-c[4]*s.y2;
  s.x2=s.x1; s.x1=x; s.y2=s.y1; s.y1=y;
  return y;
}
function loudHop(n){
  const sum=n.hopSum, cnt=n.hopN; n.hopSum=0; n.hopN=0;
  n.mSlices[n.mIdx]=sum; n.mCounts[n.mIdx]=cnt; n.mIdx=(n.mIdx+1)%4; n.mFilled=Math.min(4,n.mFilled+1);
  let ms=0,mn=0; for(let k=0;k<n.mFilled;k++){ ms+=n.mSlices[k]; mn+=n.mCounts[k]; }
  n.mL=-0.691+10*Math.log10(ms/mn+1e-24);                  // momentary, окно 400 мс
  n.sSlices[n.sIdx]=sum; n.sCounts[n.sIdx]=cnt; n.sIdx=(n.sIdx+1)%30; n.sFilled=Math.min(30,n.sFilled+1);
  let ss=0,sn=0; for(let k=0;k<n.sFilled;k++){ ss+=n.sSlices[k]; sn+=n.sCounts[k]; }
  n.sL=-0.691+10*Math.log10(ss/sn+1e-24);                  // short-term, окно 3 с
  if(n.mL>-70){                                            // абсолютный гейт
    n.gated.push({sum,cnt});
    if(n.gated.length>18000) n.gated.shift();              // ~30 минут истории хватает для сессии
  }
  if(n.gated.length){
    let gs=0,gn=0; for(const b of n.gated){ gs+=b.sum; gn+=b.cnt; }
    const ambient=-0.691+10*Math.log10(gs/gn+1e-24);
    const relThr=ambient-10;                                // относительный гейт: -10 LU от среднего
    let rs=0,rn=0;
    for(const b of n.gated){
      const bl=-0.691+10*Math.log10(b.sum/b.cnt+1e-24);
      if(bl>relThr){ rs+=b.sum; rn+=b.cnt; } }
    n.iL = rn? -0.691+10*Math.log10(rs/rn+1e-24) : ambient;
  }
}

def({ id:'loud', title:'Громкость (LUFS-подобная)', cat:'Анализ', ins:[{n:'in',t:'sig'}],
  outs:[{n:'m',t:'num'},{n:'s',t:'num'},{n:'i',t:'num'}],
  readout:true, view:{h:60},
  params:[{n:'rst',t:'button',label:'Сбросить интегральную',fn:n=>{n.gated=[];}}],
  init:n=>{
    n.k1={x1:0,x2:0,y1:0,y2:0}; n.k2={x1:0,x2:0,y1:0,y2:0};
    n.sr=0; n.hopSum=0; n.hopN=0;
    n.mSlices=new Float32Array(4); n.mCounts=new Float32Array(4); n.mIdx=0; n.mFilled=0;
    n.sSlices=new Float32Array(30); n.sCounts=new Float32Array(30); n.sIdx=0; n.sFilled=0;
    n.gated=[]; n.mL=-70; n.sL=-70; n.iL=-70; },
  process(n,I){
    const sr=Eng.sr;
    if(n.sr!==sr){                                          // коэффициенты зависят от sr — считаем один раз
      n.sr=sr;
      n.cShelf=hiShelfCoef(1681.9744509555319, 3.99984385397333, 0.7071752369554196, sr);
      n.cHP=hpCoef(38.13547087602444, 0.5003270373238773, sr);
      n.hop=Math.max(1,Math.round(sr*0.1)); }
    const x=I.in;
    for(let i=0;i<BLOCK;i++){
      let v=x?x[i]:0;
      v=biq2(n.k1,n.cShelf,v); v=biq2(n.k2,n.cHP,v);
      n.hopSum+=v*v; n.hopN++;
      if(n.hopN>=n.hop) loudHop(n); }
    return {m:n.mL, s:n.sL, i:n.iL}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    const bars=[['M',n.mL],['S',n.sL],['I',n.iL]];
    const bw=W/bars.length;
    cx.fillStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    bars.forEach(([lbl,v],k)=>{
      const h=clamp((v+70)/70,0,1)*H;                       // шкала -70…0 LUFS
      cx.fillRect(k*bw+2,H-h,bw-4,h); });
    n.el.querySelector('.readout').textContent =
      'M '+n.mL.toFixed(1)+' · S '+n.sL.toFixed(1)+' · I '+n.iL.toFixed(1)+' LUFS'; }});


def({ id:'spectral', title:'Спектральные дескрипторы', cat:'Анализ',
  ins:[{n:'spec',t:'spec'},{n:'fmin',t:'num'},{n:'fmax',t:'num'},{n:'rolloff',t:'num'}],
  outs:[{n:'centroid',t:'num'},{n:'spread',t:'num'},{n:'flux',t:'num'},{n:'rolloff',t:'num'}],
  readout:true,
  params:[{n:'fmin',t:'range',min:20,max:5000,step:1,d:20,log:true,label:'нижняя граница, Гц'},
          {n:'fmax',t:'range',min:500,max:()=>Eng.sr/2,step:1,d:8000,log:true,label:'верхняя граница, Гц'},
          {n:'rolloff',t:'range',min:.5,max:.99,step:.01,d:.85,label:'порог rolloff, доля энергии'},
          {n:'smooth',t:'range',min:0,max:.99,step:.01,d:.3,label:'сглаживание'}],
  init:n=>{n.prevMag=null; n.centroid=0; n.spread=0; n.flux=0; n.rolloff=0;},
  process(n,I){
    for(const k of ['fmin','fmax','rolloff']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const s=I.spec; if(!s) return {centroid:0,spread:0,flux:0,rolloff:0};
    const N=s.mag.length;
    const lo=clamp(Math.floor(specBin(s,n.p.fmin)),0,N-1), hi=clamp(Math.ceil(specBin(s,n.p.fmax)),0,N-1);
    let sumMag=0, sumFM=0;
    for(let i=lo;i<=hi;i++){ const m=s.mag[i]; sumMag+=m; sumFM+=m*specHz(s,i); }
    const centroid = sumMag>1e-12? sumFM/sumMag : 0;
    let sumDev=0;
    for(let i=lo;i<=hi;i++){ const m=s.mag[i], d=specHz(s,i)-centroid; sumDev+=m*d*d; }
    const spread = sumMag>1e-12? Math.sqrt(sumDev/sumMag) : 0;
    let flux=0;                                             // положительная часть разницы спектров — только "прирост" энергии
    if(n.prevMag && n.prevMag.length===N){
      for(let i=lo;i<=hi;i++){ const d=s.mag[i]-n.prevMag[i]; if(d>0) flux+=d*d; }
      flux=Math.sqrt(flux); }
    if(!n.prevMag||n.prevMag.length!==N) n.prevMag=new Float32Array(N);
    n.prevMag.set(s.mag);
    let energyTotal=0; for(let i=lo;i<=hi;i++) energyTotal+=s.mag[i]*s.mag[i];
    let acc=0, rf=specHz(s,hi);
    for(let i=lo;i<=hi;i++){ acc+=s.mag[i]*s.mag[i]; if(acc>=energyTotal*n.p.rolloff){ rf=specHz(s,i); break; } }
    const a=n.p.smooth;
    n.centroid=n.centroid*a+centroid*(1-a);
    n.spread=n.spread*a+spread*(1-a);
    n.flux=n.flux*a+flux*(1-a);
    n.rolloff=n.rolloff*a+rf*(1-a);
    return {centroid:n.centroid, spread:n.spread, flux:n.flux, rolloff:n.rolloff}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    'центр '+n.centroid.toFixed(0)+' Гц · разброс '+n.spread.toFixed(0)+' Гц · flux '+
    n.flux.toFixed(3)+' · rolloff '+n.rolloff.toFixed(0)+' Гц'; }});
