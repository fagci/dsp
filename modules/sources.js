def({ id:'osc', title:'Oscillator', cat:'Sources',
  outs:[{n:'out',t:'sig'},{n:'sync',t:'sig'}],
  ins:[{n:'freq',t:'num'},{n:'amp',t:'num'},{n:'fmHz',t:'num'},{n:'phase',t:'num'},
       {n:'fm',t:'sig'},{n:'sync',t:'sig'}],
  params:[{n:'wave',t:'select',opts:['sine','square','saw','tri','noise'],d:'sine'},
          {n:'freq',t:'range',min:1,max:()=>Eng.sr/2,step:1,d:440,log:true},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.2},
          {n:'fmHz',t:'range',min:0,max:()=>Eng.sr/2,step:1,d:0},
          {n:'phase',t:'range',min:0,max:1,step:.001,d:0,label:'phase'}],
  init:n=>{n.ph=0;n.f0=null;n.a0=null;n.pv=0;},
  process(n,I){
    const o=buf(n,'out'), os=buf(n,'sync');
    if(typeof I.fmHz==='number') setMod(n,'fmHz',I.fmHz);
    if(typeof I.phase==='number') setMod(n,'phase',I.phase);
    const fT=pv(n,I,'freq'), aT=pv(n,I,'amp'), w=n.p.wave, dev=n.p.fmHz;
    if(n.f0==null){ n.f0=fT; n.a0=aT; }
    const df=(fT-n.f0)/BLOCK, da=(aT-n.a0)/BLOCK;   // управление интерполируется по отсчётам
    for(let i=0;i<BLOCK;i++){
      if(I.sync){                                   // жёсткая синхронизация по фронту
        const sv=I.sync[i];
        if(sv>0 && n.pv<=0) n.ph=n.p.phase;
        n.pv=sv; }
      const f=n.f0+df*i+(I.fm?I.fm[i]*dev:0), a=n.a0+da*i, ph=n.ph;
      let v;
      if(w==='sine') v=Math.sin(2*Math.PI*ph);
      else if(w==='square') v=ph<.5?1:-1;
      else if(w==='saw') v=2*ph-1;
      else if(w==='tri') v=4*Math.abs(ph-.5)-1;
      else v=Math.random()*2-1;
      o[i]=v*a;
      const nx=ph+f/Eng.sr;
      n.ph=nx%1; if(n.ph<0) n.ph+=1;
      os[i]=(nx>=1||nx<0)?1:0;                      // импульс в начале периода
    }
    n.f0=fT; n.a0=aT;
    return {out:o, sync:os}; }});

function voiceWave(w,ph){
  if(w==='sine') return Math.sin(2*Math.PI*ph);
  if(w==='square') return ph<.5?1:-1;
  if(w==='saw') return 2*ph-1;
  if(w==='tri') return 4*Math.abs(ph-.5)-1;
  return Math.random()*2-1;                            // noise
}

def({ id:'voice', title:'Synth (2 osc)', cat:'Music',
  ins:[{n:'freq',t:'num'},{n:'gate',t:'sig'},{n:'vel',t:'num'}],
  outs:[{n:'out',t:'sig'}], readout:true,
  params:[
    {n:'freq',t:'range',min:20,max:5000,step:1,d:220,log:true,label:'freq'},
    {n:'wave1',t:'select',opts:['sine','square','saw','tri','noise'],d:'saw',label:'osc.1 wave'},
    {n:'semi1',t:'range',min:-24,max:24,step:1,d:0,label:'osc.1 semitones'},
    {n:'fine1',t:'range',min:-50,max:50,step:1,d:0,label:'osc.1 cents'},
    {n:'level1',t:'range',min:0,max:1,step:.01,d:.6,label:'osc.1 level'},
    {n:'wave2',t:'select',opts:['sine','square','saw','tri','noise'],d:'square',label:'osc.2 wave'},
    {n:'semi2',t:'range',min:-24,max:24,step:1,d:-12,label:'osc.2 semitones'},
    {n:'fine2',t:'range',min:-50,max:50,step:1,d:7,label:'osc.2 cents'},
    {n:'level2',t:'range',min:0,max:1,step:.01,d:.4,label:'osc.2 level'},
    {n:'attack',t:'range',min:.001,max:3,step:.001,d:.01,log:true,label:'A'},
    {n:'decay',t:'range',min:.001,max:3,step:.001,d:.15,log:true,label:'D'},
    {n:'sustain',t:'range',min:0,max:1,step:.01,d:.6,label:'S'},
    {n:'release',t:'range',min:.001,max:5,step:.001,d:.25,log:true,label:'R'}],
  init:n=>{ n.ph1=0; n.ph2=0; n.stage='idle'; n.lvl=0; n.pv=0; n.relFrom=0; },
  process(n,I){
    const o=buf(n,'out'), g=I.gate, p=n.p, sr=Eng.sr;
    const f0=pv(n,I,'freq'), velAmt=typeof I.vel==='number'?I.vel:1;   // vel not connected — play at full
    const f1=f0*Math.pow(2,(p.semi1+p.fine1/100)/12);
    const f2=f0*Math.pow(2,(p.semi2+p.fine2/100)/12);
    for(let i=0;i<BLOCK;i++){
      const gv=g?g[i]:0;
      if(gv>0&&n.pv<=0) n.stage='a';
      else if(gv<=0&&n.pv>0){ n.stage='r'; n.relFrom=n.lvl; }
      n.pv=gv;
      if(n.stage==='a'){ n.lvl+=1/(p.attack*sr); if(n.lvl>=1){ n.lvl=1; n.stage='d'; } }
      else if(n.stage==='d'){ n.lvl-=(1-p.sustain)/(p.decay*sr); if(n.lvl<=p.sustain){ n.lvl=p.sustain; n.stage='s'; } }
      else if(n.stage==='s'){ n.lvl=p.sustain; }
      else if(n.stage==='r'){ n.lvl-=n.relFrom/(p.release*sr); if(n.lvl<=0){ n.lvl=0; n.stage='idle'; } }
      const v1=voiceWave(p.wave1,n.ph1)*p.level1, v2=voiceWave(p.wave2,n.ph2)*p.level2;
      o[i]=(v1+v2)*n.lvl*velAmt;
      n.ph1=(n.ph1+f1/sr)%1; n.ph2=(n.ph2+f2/sr)%1; }
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent = n.stage+' · '+n.lvl.toFixed(2); }});


// один голос = осциллятор + ADSR, как у voice, но без второго осциллятора — чтобы 4 штуки
// не были избыточно тяжёлыми. Берёт freq/gate..freq4/gate4 пиано-ролла напрямую, без
// внешних osc+adsr+mixer — если голос не подключён (freq2 и т.п. отсутствуют), просто молчит.
def({ id:'poly4', title:'Synth (4 voices)', cat:'Music',
  ins:[{n:'freq',t:'num'},{n:'gate',t:'sig'},{n:'freq2',t:'num'},{n:'gate2',t:'sig'},
       {n:'freq3',t:'num'},{n:'gate3',t:'sig'},{n:'freq4',t:'num'},{n:'gate4',t:'sig'}],
  outs:[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'}],
  readout:true,
  params:[
    {n:'wave',t:'select',opts:['sine','square','saw','tri','noise'],d:'saw',label:'wave'},
    {n:'attack',t:'range',min:.001,max:3,step:.001,d:.01,log:true,label:'A'},
    {n:'decay',t:'range',min:.001,max:3,step:.001,d:.15,log:true,label:'D'},
    {n:'sustain',t:'range',min:0,max:1,step:.01,d:.6,label:'S'},
    {n:'release',t:'range',min:.001,max:5,step:.001,d:.25,log:true,label:'R'},
    {n:'spread',t:'range',min:0,max:1,step:.01,d:.6,label:'stereo spread'}],
  init:n=>{ n.v=[0,1,2,3].map(()=>({ph:0,stage:'idle',lvl:0,pv:0,relFrom:0})); },
  process(n,I){
    const o=buf(n,'out'), oL=buf(n,'L'), oR=buf(n,'R'), p=n.p, sr=Eng.sr;
    const fr=[I.freq,I.freq2,I.freq3,I.freq4], ga=[I.gate,I.gate2,I.gate3,I.gate4];
    const pans=[-1,-1/3,1/3,1].map(x=>x*p.spread);
    for(let i=0;i<BLOCK;i++){
      let m=0,l=0,r=0;
      for(let k=0;k<4;k++){
        const vs=n.v[k], gv=ga[k]?ga[k][i]:0, f=fr[k]||440;
        if(gv>0&&vs.pv<=0) vs.stage='a';
        else if(gv<=0&&vs.pv>0){ vs.stage='r'; vs.relFrom=vs.lvl; }
        vs.pv=gv;
        if(vs.stage==='a'){ vs.lvl+=1/(p.attack*sr); if(vs.lvl>=1){ vs.lvl=1; vs.stage='d'; } }
        else if(vs.stage==='d'){ vs.lvl-=(1-p.sustain)/(p.decay*sr); if(vs.lvl<=p.sustain){ vs.lvl=p.sustain; vs.stage='s'; } }
        else if(vs.stage==='s') vs.lvl=p.sustain;
        else if(vs.stage==='r'){ vs.lvl-=vs.relFrom/(p.release*sr); if(vs.lvl<=0){ vs.lvl=0; vs.stage='idle'; } }
        const s=voiceWave(p.wave,vs.ph)*vs.lvl*0.6;
        vs.ph=(vs.ph+f/sr)%1; if(vs.ph<0) vs.ph+=1;
        const ang=(pans[k]+1)*Math.PI/4;                    // pan — equal-power law
        m+=s; l+=s*Math.cos(ang); r+=s*Math.sin(ang);
      }
      o[i]=clamp(m,-2,2); oL[i]=clamp(l,-2,2); oR[i]=clamp(r,-2,2);
    }
    return {out:o, L:oL, R:oR}; },
  draw(n){ const active=n.v.filter(v=>v.stage!=='idle').length;
    n.el.querySelector('.readout').textContent=active+'/4 voice'+(active===1?'':'s'); }});


def({ id:'sweep', title:'Sweep / Jammer', cat:'Sources', outs:[{n:'out',t:'sig'},{n:'f',t:'num'}],
  ins:[{n:'f0',t:'num'},{n:'f1',t:'num'},{n:'rate',t:'num'},{n:'amp',t:'num'}],
  params:[{n:'f0',t:'range',min:20,max:()=>Eng.sr/2,step:1,d:300,log:true},
          {n:'f1',t:'range',min:20,max:()=>Eng.sr/2,step:1,d:8000,log:true},
          {n:'rate',t:'range',min:.1,max:2000,step:.1,d:20,log:true},
          {n:'mode',t:'select',opts:['saw','tri','random','log'],d:'saw'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.2}],
  init:n=>{n.ph=0;n.sw=0;n.hop=0;},
  process(n,I){
    for(const k of ['f0','f1','amp']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'out'), p=n.p, r=pv(n,I,'rate'), dsw=r/Eng.sr;
    let f=p.f0;
    for(let i=0;i<BLOCK;i++){
      const s=n.sw;
      if(p.mode==='tri') f=p.f0+(p.f1-p.f0)*(1-Math.abs(2*s-1));
      else if(p.mode==='log') f=p.f0*Math.pow(p.f1/p.f0,s);
      else if(p.mode==='random') f=n.hop;
      else f=p.f0+(p.f1-p.f0)*s;
      o[i]=Math.sin(2*Math.PI*n.ph)*p.amp;
      n.ph=(n.ph+f/Eng.sr)%1;
      n.sw+=dsw; if(n.sw>=1){ n.sw-=1; n.hop=p.f0+Math.random()*(p.f1-p.f0); } }
    return {out:o,f}; }});


// Один узел — оба физических входа сразу, два выхода (a/b). Раньше это было либо два разных
// модуля, либо один с переключателем канала (и тогда для фазовых замеров всё равно нужны были
// два экземпляра) — а канал A и B и так снимаются в один и тот же момент, незачем городить
// второй узел ради второй дорожки. echo/ns/agc были общими для обоих микрофонов и раньше
// (см. Eng.fx — единый на все enableMic), просто это не было видно из двух копий одного
// параметра, которые молча перетирали друг друга; тут это честно один набор, а не иллюзия выбора.
// Больше двух каналов (условные «6 микрофонов») этот узел не потянет — не потому что лень
// дописать третий выход, а потому что Eng целиком сшит под стерео на уровне ниже: воркет
// объявлен с channelCount:2, а второй физический вход сводится ChannelMergerNode(2). Чтобы
// снимать N микрофонов, пришлось бы менять сам движок (динамический мерджер, N слотов вместо
// двух фиксированных буферов), это не косметика поверх этого узла.
// Режим "stereo device" — не второй способ подключить два девайса, а честное разделение
// L/R одного устройства (см. Eng.enableStereoMic: один getUserMedia + ChannelSplitterNode),
// для случаев когда одно физическое устройство и есть оба канала (напр. встроенный массив
// микрофонов ноутбука вроде ThinkPad T480).
// частота — просьба к getUserMedia (ideal), браузер может дать не точно её; 'auto' — без constraint
const SRATE_OPTS=['auto','8000','16000','22050','44100','48000','96000','192000'];
function srOf(n){ return n.p.srate==='auto' ? undefined : +n.p.srate; }

def({ id:'mic', title:'Microphone (A+B)', cat:'Sources',
  outs:[{n:'a',t:'sig'},{n:'b',t:'sig'}],
  ins:[{n:'gainA',t:'num'},{n:'gainB',t:'num'},{n:'echo',t:'num'},{n:'ns',t:'num'},{n:'agc',t:'num'}],
  params:[{n:'unlock',t:'button',label:'show device names',fn:n=>Eng.unlockLabels()},
          {n:'mode',t:'select',d:'separate',label:'mode',
           opts:()=>['separate','stereo device'], fn:n=>armAll(n)},
          {n:'devA',t:'select',d:'default',label:'input A',
           opts:()=>['default',...Eng.devices.map(d=>d.label)],
           fn:n=>{ n.armed=true; micFx(n);
                   if(n.p.mode==='stereo device') armStereo(n);
                   else{ const d=Eng.devices.find(x=>x.label===n.p.devA);
                         Eng.enableMic(d?d.id:undefined,0,srOf(n)).then(()=>reportSettings(n)); } }},
          {n:'gainA',t:'range',min:0,max:8,step:.1,d:1,label:'gain A'},
          {n:'devB',t:'select',d:'default',label:'input B (mode "separate" only)',
           opts:()=>['default',...Eng.devices.map(d=>d.label)],
           fn:n=>{ if(n.p.mode==='stereo device') return;   // в стерео Б берётся из devA
                   n.armed=true; micFx(n);
                   const d=Eng.devices.find(x=>x.label===n.p.devB);
                   Eng.enableMic(d?d.id:undefined,1,srOf(n)).then(()=>reportSettings(n)); }},
          {n:'gainB',t:'range',min:0,max:8,step:.1,d:1,label:'gain B'},
          {n:'srate',t:'select',d:'auto',label:'sample rate', opts:()=>SRATE_OPTS, fn:n=>armAll(n)},
          // эффекты — это constraints getUserMedia, общие на оба входа (см. Eng.fx); сперва
          // пробуем применить живьём (applyConstraints), без пересоздания потока
          {n:'echo',t:'check',d:false,label:'echo cancellation',fn:n=>reapplyFx(n)},
          {n:'ns',t:'check',d:false,label:'noise suppression',fn:n=>reapplyFx(n)},
          {n:'agc',t:'check',d:false,label:'auto gain control',fn:n=>reapplyFx(n)}],
  init:n=>{ n.armed=false; n.status=''; },
  process(n,I){
    if(typeof I.gainA==='number') setMod(n,'gainA',I.gainA);
    if(typeof I.gainB==='number') setMod(n,'gainB',I.gainB);
    for(const k of ['echo','ns','agc']) if(typeof I[k]==='number') setMod(n,k,I[k]>=0.5);
    // отдельной кнопки "Вкл" нет — включаем сами при первом же тике движка
    if(!n.armed) armAll(n);
    const oa=buf(n,'a'), ob=buf(n,'b'), ga=n.p.gainA, gb=n.p.gainB;
    for(let i=0;i<BLOCK;i++){ oa[i]=Eng.micBuf[i]*ga; ob[i]=Eng.micB[i]*gb; }
    return {a:oa, b:ob}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status||''; }});

function micFx(n){ Eng.fx={echo:n.p.echo, ns:n.p.ns, agc:n.p.agc}; }

// что реально согласовал браузер — ideal частота/каналы могут не совпасть с запрошенным
function reportSettings(n){
  const s = n.p.mode==='stereo device' ? Eng.stereoSettings() : Eng.micSettings(0);
  n.status = s ? [s.sampleRate&&s.sampleRate+' Hz', s.channelCount&&s.channelCount+' ch.']
                    .filter(Boolean).join(', ') : '';
}

// стерео-устройство: канал Б в выходе узла — это правый канал того же потока, что и А
// (Eng.micB приходит из ChannelSplitter), gainB продолжает работать как обычно
function armStereo(n){
  const d=Eng.devices.find(x=>x.label===n.p.devA);
  Eng.enableStereoMic(d?d.id:undefined, srOf(n)).then(()=>reportSettings(n));
}
function armAll(n){
  n.armed=true; micFx(n);
  if(n.p.mode==='stereo device') armStereo(n);
  else{
    const dA=Eng.devices.find(x=>x.label===n.p.devA);
    const dB=Eng.devices.find(x=>x.label===n.p.devB);
    Promise.all([
      Eng.enableMic(dA?dA.id:undefined,0,srOf(n)),
      Eng.enableMic(dB?dB.id:undefined,1,srOf(n))
    ]).then(()=>reportSettings(n));
  }
}
// переподключаем поток только если уже заармлен — иначе чекбокс до первого тика
// не должен сам просить разрешение на запись. Сначала пробуем applyConstraints — если браузер
// откажется (не все это поддерживают), тогда уже переподключаемся.
async function reapplyFx(n){
  micFx(n);
  if(!n.armed) return;
  const ok = await Eng.applyFx();
  if(!ok){
    if(n.p.mode==='stereo device') armStereo(n);
    else{
      if(Eng.mics[0]) Eng.enableMic(Eng.micIds[0]||undefined,0,srOf(n));
      if(Eng.mics[1]) Eng.enableMic(Eng.micIds[1]||undefined,1,srOf(n));
    }
  }
}

def({ id:'file', lazy:'manual', title:'Audio File', cat:'Sources',
  outs:[{n:'out',t:'sig'},{n:'pos',t:'num'},{n:'done',t:'num'}],
  ins:[{n:'seek',t:'num'},{n:'rate',t:'num'},{n:'gain',t:'num'},{n:'loop',t:'num'}], view:{h:44}, resize:true, readout:true,
  params:[{n:'file',t:'file',accept:'audio/*',fn:(n,f)=>{
            n.name=f.name;
            const fr=new FileReader();
            fr.onload=()=>{
              const ac=Eng.ctx||new (window.AudioContext||window.webkitAudioContext)();
              ac.decodeAudioData(fr.result).then(b=>{
                n.data=b.getChannelData(0); n.srcSr=b.sampleRate; n.pos=0; n.play=true; n.env=null; redraw(n); }); };
            fr.readAsArrayBuffer(f); }},
          {n:'rate',t:'range',min:.25,max:4,step:.01,d:1},
          {n:'gain',t:'range',min:0,max:4,step:.01,d:1},
          {n:'loop',t:'check',d:true},
          {n:'seek',t:'range',min:0,max:1,step:.0001,d:0,label:'position',
           fn:n=>{ if(n.data) n.pos=n.p.seek*n.data.length; }},
          {n:'pp',t:'button',label:'Play / pause',fn:n=>{ n.play=!n.play; }},
          {n:'home',t:'button',label:'To start',fn:n=>{ n.pos=0; }}],
  init:n=>{n.pos=0;n.play=true;n.data=null;},
  process(n,I){
    const o=buf(n,'out');
    if(!n.data){ o.fill(0); return {out:o,pos:0,done:0}; }
    if(typeof I.seek==='number'&&I.seek>=0&&I.seek<=1&&Math.abs(I.seek-(n.seekPrev??-1))>1e-6){
      n.pos=I.seek*n.data.length; n.seekPrev=I.seek; }
    if(typeof I.rate==='number') setMod(n,'rate',I.rate);
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);
    const d=n.data, g=n.p.gain;
    const r=n.p.rate*((n.srcSr||Eng.sr)/Eng.sr);     // пересчёт под частоту движка
    let done=0;
    if(!n.play){ o.fill(0); fileRedraw(n); return {out:o,pos:n.pos/d.length,done:0}; }
    for(let i=0;i<BLOCK;i++){
      if(n.pos>=d.length-1){
        if(n.p.loop) n.pos=0; else { n.play=false; done=1; o[i]=0; continue; } }
      const i0=n.pos|0, fr=n.pos-i0;
      o[i]=(d[i0]*(1-fr)+d[i0+1]*fr)*g; n.pos+=r; }
    fileRedraw(n);
    return {out:o, pos:n.pos/d.length, done}; },
  draw(n,cv,cx){
    const W=cv.width,H=cv.height; cx.clearRect(0,0,W,H);
    if(!n.data){ n.el.querySelector('.readout').textContent='no file selected'; return; }
    if(!n.env||n.envW!==W){                          // огибающая всего файла, считаем один раз
      n.envW=W; n.env=new Float32Array(W);
      const step=Math.max(1,Math.floor(n.data.length/W));
      for(let x=0;x<W;x++){ let m=0;
        for(let k=0;k<step;k+=Math.max(1,step>>7)){ const v=Math.abs(n.data[x*step+k]||0); if(v>m) m=v; }
        n.env[x]=m; } }
    cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-sig');
    cx.beginPath();
    for(let x=0;x<W;x++){ const h=n.env[x]*H/2*.95;
      cx.moveTo(x+.5,H/2-h); cx.lineTo(x+.5,H/2+h); }
    cx.stroke();
    const px=Math.round(n.pos/n.data.length*W);
    cx.strokeStyle=themeColor('--acc'); cx.lineWidth=2;
    cx.beginPath(); cx.moveTo(px,0); cx.lineTo(px,H); cx.stroke(); cx.lineWidth=1;
    const sr=n.srcSr||Eng.sr, t=n.pos/sr, tot=n.data.length/sr;
    n.el.querySelector('.readout').textContent =
      (n.name||'file')+' · '+t.toFixed(1)+' / '+tot.toFixed(1)+' s'+(n.play?'':' · paused'); }});


// плейхед (1/2000 длины) и время в readout (0.1 с)
function fileRedraw(n){
  redrawIf(n,Math.floor(n.pos/n.data.length*2000)+'|'+Math.floor(n.pos/(n.srcSr||Eng.sr)*10)+'|'+n.play);
}

// Поток отсчётов датчика с метками времени. Датчики приходят событиями на главном потоке
// с неровным шагом и пропусками, а num-выход просто держит последнее значение на блок —
// для спектра это мусор. Здесь отсчёты копятся с метками и выдаются по часам блоков движка
// (как у камеры): num — последний отсчёт, sig — линейная интерполяция между отсчётами на
// частоте движка. Дальше его можно проредить узлом 'lfft'.
function ssInit(n,K){
  n.sK=K; n.sq=[]; n.sP=new Float64Array(K+1); n.sClk=null; n.sLastT=0; n.sDt=0;
  n.sGaps=0; n.sRate=0; n.sRT0=0; n.sRN=0;
  n.mW0=0; n.mLast=null; n.mEvRate=null; n.mDup=0; n.tsBad=false;
}
// Метки событий бывают грубыми: Firefox округляет timeStamp (защита от фингерпринтинга,
// вплоть до 16.7 мс), и при сотнях событий в секунду у многих одна и та же метка. Поэтому
// частота считается по числу событий за ~1 с, а время отсчёта — по сетке с этим шагом,
// медленно подтягиваемой к наблюдаемым меткам. Скачок больше нескольких шагов — пропуск.
function ssPush(n,obs,vals){                        // obs — секунды, в часах performance.now
  if(!n.sRT0){ n.sRT0=obs; n.sRN=0; }
  else { n.sRN++; const w=obs-n.sRT0;
    if(w>=1){ const r=n.sRN/w;
      n.sRate=n.sRate? n.sRate*.7+r*.3 : r; n.sDt=1/n.sRate; n.sRT0=obs; n.sRN=0; } }
  let t;
  if(n.sExact){                                     // точные метки датчика — как есть
    if(obs<=n.sLastT) return;
    if(n.sDt && obs-n.sLastT>1.8*n.sDt) n.sGaps++;
    t=obs;
  }
  else if(!n.sDt) t=Math.max(obs,n.sLastT+1e-4);   // первая секунда — как есть
  else {
    const pred=n.sLastT+n.sDt, err=obs-pred;
    if(err>Math.max(.05,4*n.sDt)){ t=obs; n.sGaps++; }
    else if(err<-Math.max(.1,8*n.sDt)) t=obs;        // сбой часов
    else t=pred+err*.02;
    if(t<=n.sLastT) t=n.sLastT+n.sDt*.5;
  }
  n.sLastT=t;
  n.sq.push(t,...vals);
  const cap=(n.sK+1)*16384; if(n.sq.length>cap) n.sq.splice(0,n.sq.length-cap);
}
// заполнить sig-выходы (массив буферов на K полей) и вернуть последний выданный отсчёт
function ssProcess(n,outs){
  const K=n.sK, S=K+1, q=n.sq, P=n.sP, sr=Eng.sr;
  if(!n.sLastT){ for(const o of outs) o.fill(0); return P; }
  const lag=Math.max(n.sLag||.06,3*n.sDt);          // запас на неровный приход событий
  const err=n.sLastT-lag-n.sClk;
  if(n.sClk==null || Math.abs(err)>.5) n.sClk=n.sLastT-lag;
  else n.sClk+=err*.0005;                           // медленно: подстройка часов = частотная ошибка спектра
  const c0=n.sClk; let j=0;
  for(let i=0;i<BLOCK;i++){
    const ti=c0+i/sr;
    while(j<q.length && q[j]<=ti){ for(let k=0;k<S;k++) P[k]=q[j+k]; j+=S; }
    if(j<q.length && P[0]){ const a=(ti-P[0])/(q[j]-P[0]);
      for(let k=0;k<K;k++) outs[k][i]=P[k+1]+(q[j+1+k]-P[k+1])*a; }
    else for(let k=0;k<K;k++) outs[k][i]=P[k+1];
  }
  if(j) q.splice(0,j);
  n.sClk+=BLOCK/sr;
  return P;
}
function ssStatus(n){
  if(!n.sLastT) return '';
  return `${n.sRate.toFixed(1)} Hz`+(n.sGaps?` · gaps ${n.sGaps}`:'')+
    (n.mEvRate!=null?` · events ${n.mEvRate.toFixed(0)}/s`:'')+(n.mDup?` · repeats ${n.mDup}`:'')+
    (n.tsBad?` · timeStamp ×${n.tsRatio.toFixed(2)}, using arrival time`:'');
}
// devicemotion: одно событие — не обязательно новый отсчёт. Браузер может слать событие на
// обновление любого из датчиков (ускорение/гироскоп) с теми же значениями остальных — такие
// повторы отбрасываем, иначе спектр получает ступеньки. timeStamp сверяем с performance.now:
// если его масштаб/часы другие, частоты спектра поедут — тогда берём время прихода.
function ssMotion(n,e,v){
  const wall=performance.now()/1000, ts=e.timeStamp/1000;
  if(!n.mW0){ n.mW0=wall; n.mT0=ts; n.mEv=0; n.mDup=0; n.tsBad=false; }
  n.mEv++;
  const dw=wall-n.mW0;
  if(dw>=2){
    n.mEvRate=n.mEv/dw; n.tsRatio=(ts-n.mT0)/dw;
    const bad=!(Math.abs(n.tsRatio-1)<.05);
    if(bad!==n.tsBad){ n.tsBad=bad;                  // смена шкалы времени — тайминг потока заново
      n.sq=[]; n.sClk=null; n.sLastT=0; n.sDt=0; n.sRate=0; n.sRT0=0; }
    n.mW0=wall; n.mT0=ts; n.mEv=0; }
  const L=n.mLast;
  if(L && L[0]===v[0] && L[1]===v[1] && L[2]===v[2]){ n.mDup++; return; }
  n.mLast=v;
  ssPush(n,n.tsBad?wall:ts,v);
}
const SS_XYZ=[{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'},
              {n:'sx',t:'sig'},{n:'sy',t:'sig'},{n:'sz',t:'sig'},{n:'smag',t:'sig'}];
function ssXYZOut(n){
  const ox=buf(n,'sx'), oy=buf(n,'sy'), oz=buf(n,'sz'), om=buf(n,'smag');
  const P=ssProcess(n,[ox,oy,oz]);
  for(let i=0;i<BLOCK;i++) om[i]=Math.hypot(ox[i],oy[i],oz[i]);
  return {x:P[1],y:P[2],z:P[3],sx:ox,sy:oy,sz:oz,smag:om};
}

function accelStop(n){ if(n.onMotion){ window.removeEventListener('devicemotion',n.onMotion); n.onMotion=null; } }
def({ id:'accel', title:'Accelerometer', cat:'Sources',
  outs:SS_XYZ, readout:true,
  params:[{n:'on',t:'button',label:'Allow sensor',fn:async n=>{
    try{ if(window.DeviceMotionEvent?.requestPermission) await DeviceMotionEvent.requestPermission(); }
    catch(e){ n.status='error: '+e.message; return; }
    accelStop(n); ssInit(n,3); n.status='waiting for events…';
    n.onMotion=e=>{
      const a=(n.p.grav?e.accelerationIncludingGravity:e.acceleration)||{};
      if(a.x==null) return;
      n.status=''; n.iv=e.interval;
      ssMotion(n,e,[a.x,a.y,a.z]); };
    window.addEventListener('devicemotion',n.onMotion); }},
    {n:'grav',t:'check',d:true,label:'include gravity (raw)'}],
  init:n=>{ ssInit(n,3); n.status='not started'; },
  dispose:n=>accelStop(n),
  process:n=>ssXYZOut(n),
  draw(n){ const r=n.el.querySelector('.readout');
    if(r) r.textContent=n.status||ssStatus(n)+(n.iv?` · interval ${Math.round(n.iv)} ms`:''); }});


// Generic Sensor API — отдельный от 'accel' набор классов (Accelerometer/Gyroscope/...),
// не пересекается с DeviceMotionEvent. Требует HTTPS и в основном работает только в
// Chrome/Edge на Android — Firefox и Safari эти классы не реализуют вовсе.
// Частоту браузер ограничивает сам (Chrome — обычно до 60 Гц); реальная — в строке состояния.
const GSENSOR_DEFS = {
  'Accelerometer':               {fields:['x','y','z']},
  'LinearAccelerationSensor':    {fields:['x','y','z']},
  'Gyroscope':                   {fields:['x','y','z']},
  'Magnetometer':                {fields:['x','y','z']},
  'AmbientLightSensor':          {fields:['illuminance']},
};
function gsensorFields(n){ return (GSENSOR_DEFS[n.p.type]||GSENSOR_DEFS.Accelerometer).fields; }
function gsensorStop(n){
  if(n.sensor){ try{ n.sensor.stop(); }catch(e){} n.sensor=null; }
  if(n.onMotion){ window.removeEventListener('devicemotion',n.onMotion); n.onMotion=null; }
  n.via=''; n.status='stopped';
}
// Без Generic Sensor API (Firefox, Safari) движение берём из devicemotion — в Firefox он ещё
// и заметно чаще (сотни Гц против 60 у Chrome). Гироскоп: rotationRate в °/с, оси beta/gamma/alpha.
const GSENSOR_MOTION={
  Accelerometer:           e=>{ const a=e.accelerationIncludingGravity; return a&&a.x!=null&&[a.x,a.y,a.z]; },
  LinearAccelerationSensor:e=>{ const a=e.acceleration; return a&&a.x!=null&&[a.x,a.y,a.z]; },
  Gyroscope:               e=>{ const r=e.rotationRate, k=Math.PI/180;
                                return r&&r.alpha!=null&&[r.beta*k,r.gamma*k,r.alpha*k]; },
};
async function gsensorMotion(n){
  const get=GSENSOR_MOTION[n.p.type];
  if(!get || !window.DeviceMotionEvent){ n.status='API unavailable (needs Chrome/Edge on Android, or HTTPS)'; return; }
  try{ if(DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission(); }
  catch(e){ n.status='error: '+e.message; return; }
  ssInit(n,3); n.via='devicemotion'; n.status='waiting for devicemotion…';
  n.onMotion=e=>{ const v=get(e); if(!v) return;
    n.v=v; n.status=''; ssMotion(n,e,v); };
  window.addEventListener('devicemotion',n.onMotion);
}
function gsensorStart(n){
  gsensorStop(n);
  const Cls = window[n.p.type];
  if(!Cls){ gsensorMotion(n); return; }
  const def = GSENSOR_DEFS[n.p.type]||GSENSOR_DEFS.Accelerometer;
  ssInit(n,def.fields.length);
  try{
    const s = new Cls({frequency:+n.p.freq});
    s.addEventListener('reading', ()=>{
      n.v = def.fields.map(f=>s[f]??0); n.status='';
      ssPush(n,(s.timestamp??performance.now())/1000,n.v); });
    s.addEventListener('error', e=>{ n.status='error: '+(e.error?.message||e.error?.name||'?'); });
    s.start();
    n.sensor=s; n.status='starting…';
  }catch(e){
    n.status = e.name==='SecurityError' ? 'sensor permission denied' : 'error: '+e.message;
  }
}
def({ id:'gsensor', title:'Sensor (Generic Sensor API)', cat:'Sources',
  outs: n => { const f=gsensorFields(n);
    return [...f.map(x=>({n:x,t:'num'})), ...f.map(x=>({n:'s'+x,t:'sig'})),
            ...(f.length===3?[{n:'smag',t:'sig'}]:[])]; },
  readout:true,
  params:[
    {n:'type',t:'select',opts:Object.keys(GSENSOR_DEFS),d:'Accelerometer',
      fn:n=>{ gsensorStop(n); n.v=[0,0,0]; ssInit(n,gsensorFields(n).length); n.initialized=false; rebuildNode(n); markTopoDirty(); }},
    {n:'freq',t:'select',opts:['10','30','60','100','200','500'],d:'60',label:'requested rate, Hz',
      fn:n=>{ if(n.sensor) gsensorStart(n); }},
    {n:'go',t:'button',label:'Start',fn:n=>gsensorStart(n)},
    {n:'stop',t:'button',label:'Stop',fn:n=>gsensorStop(n)},
  ],
  init:n=>{ n.sensor=null; n.status='not started'; n.v=[0,0,0]; ssInit(n,gsensorFields(n).length); },
  dispose:n=>gsensorStop(n),
  process(n){
    const fields=gsensorFields(n), out={};
    if(n.sK!==fields.length) ssInit(n,fields.length);
    const sigs=fields.map(f=>buf(n,'s'+f)), P=ssProcess(n,sigs);
    fields.forEach((f,i)=>{ out[f]=P[i+1]; out['s'+f]=sigs[i]; });
    if(fields.length===3){ const om=buf(n,'smag');
      for(let i=0;i<BLOCK;i++) om[i]=Math.hypot(sigs[0][i],sigs[1][i],sigs[2][i]);
      out.smag=om; }
    return out;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status||ssStatus(n)+(n.via?' · '+n.via:''); }});


// Датчики телефона по WebSocket — протокол приложения SensorServer (Android, F-Droid):
// ws://<ip>:<port>/sensor/connect?type=android.sensor.accelerometer, сообщения
// {"values":[x,y,z],"timestamp":<нс, часы датчика>,"accuracy":n}. Приложение само читает
// SensorManager с заданным в нём периодом (сотни Гц), метки — от датчика, поэтому они
// берутся как есть. Сеть и Android отдают пачками — запас выдачи больше, чем у devicemotion.
const WSS_TYPES=['accelerometer','linear_acceleration','gyroscope','magnetic_field','gravity',
  'accelerometer_uncalibrated','gyroscope_uncalibrated','magnetic_field_uncalibrated'];
function wssStop(n){
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function wssStart(n){
  wssStop(n);
  const base=String(n.p.url||'').trim().replace(/\/+$/,'');
  const url=/\/sensors?\/connect/.test(base)? base
    : base+'/sensor/connect?type=android.sensor.'+n.p.type;
  ssInit(n,3); n.sExact=true; n.sLag=.25; n.msgs=0;
  let ws;
  const insecure=netInsecure(url);
  try{ ws=new WebSocket(url); }catch(e){ n.status='error: '+e.message+(insecure?'\n'+NET_INSECURE_MSG:''); return; }
  n.ws=ws; n.status='connecting…';
  ws.onopen=()=>{ n.status='waiting for data…'; };
  ws.onerror=()=>{ n.status=insecure ? NET_INSECURE_MSG : 'connection error (is SensorServer running? '+url+')'; };
  ws.onclose=e=>{ if(n.ws===ws){ n.ws=null; n.status='closed'+(e.code!==1000?' ('+e.code+')':''); } };
  ws.onmessage=e=>{
    let m; try{ m=JSON.parse(e.data); }catch(err){ return; }
    const v=m.values; if(!v || v.length<1) return;
    const x=[+v[0]||0,+v[1]||0,+v[2]||0];
    n.msgs++; n.status='';
    ssPush(n,(+m.timestamp||performance.now()*1e6)/1e9,x);
  };
}
def({ id:'wssensor', title:'Sensor (WebSocket)', cat:'Sources',
  outs:SS_XYZ, readout:true,
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8080',label:'SensorServer address'},
    {n:'type',t:'select',opts:WSS_TYPES,d:'accelerometer',fn:n=>{ if(n.ws) wssStart(n); }},
    {n:'go',t:'button',label:'Connect',fn:n=>wssStart(n)},
    {n:'stop',t:'button',label:'Disconnect',fn:n=>wssStop(n)},
  ],
  init:n=>{ n.ws=null; n.status='not connected'; ssInit(n,3); n.sExact=true; n.sLag=.25; },
  dispose:n=>wssStop(n),
  process:n=>ssXYZOut(n),
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status||ssStatus(n); }});


// Камера. Яркость зоны меряется на КАЖДОМ кадре камеры, а не в draw() (rAF режется до 30 к/с
// на тач-экранах и замирает при пан/зуме). Путь по убыванию качества:
//  mstp — MediaStreamTrackProcessor: VideoFrame с меткой захвата, Y-плоскость читается напрямую;
//  rvfc — requestVideoFrameCallback: по кадру видео, метка captureTime;
//  raf  — из draw(), дубли отсекаются по счётчику декодированных кадров.
// Значения с метками кладутся в очередь, process() выдаёт их по часам блоков движка —
// так фронты не сбиваются в пачки по тактам tick() и длительности импульсов сохраняются.
// Rolling shutter: строки сенсора экспонируются по очереди за время кадра, поэтому профиль
// яркости по строкам — это отсчёты во времени (сотни на кадр). Выход rows — такой сигнал,
// пересчитанный на частоту движка; так видно мерцание 50/100 Гц и при камере на 30 к/с.
const CAM_LAG=.06;                                  // запас часов выдачи от свежего кадра, с
function camStop(n){
  n.gen=(n.gen|0)+1;
  try{ n.reader?.cancel(); }catch(e){}
  n.reader=null;
  n.video?.srcObject?.getTracks?.().forEach(t=>t.stop());
  if(n.video) n.video.srcObject=null;
  n.track=null; n.mode=''; n.fps=0; n.q=[]; n.rq=[]; n.clk=null; n.qT=null; n.fdt=0; n.drop=0;
}
async function camStart(n){
  camStop(n);
  const gen=n.gen, [w,h]=n.p.res.split('x').map(Number), fps=+n.p.fps;
  n.base={width:{ideal:w},height:{ideal:h},frameRate:{ideal:fps}};
  n.status='opening…';
  let s;
  try{
    s=await navigator.mediaDevices.getUserMedia({video:{...n.base,zoom:true,
      facingMode:n.p.cam==='rear'?{ideal:'environment'}:'user'}});
  }catch(e){ n.status='error: '+(e.message||e.name); return; }
  if(gen!==n.gen){ s.getTracks().forEach(t=>t.stop()); return; }
  const tr=s.getVideoTracks()[0];
  n.track=tr; n.caps=tr.getCapabilities?.()||{}; n.ctlKey='';
  // ideal по частоте браузер легко жертвует ради разрешения — ищем режим, где частота
  // выдерживается как min, начиная с выбранного разрешения
  const got=()=>tr.getSettings?.().frameRate||0;
  if(got()<fps*.95 && (n.caps.frameRate?.max??fps)>=fps*.95){
    n.status='searching '+fps+' fps…';
    const list=[[w,h],[640,480],[320,240],[1280,720],[160,120],[1920,1080]]
      .filter((r,i,a)=>a.findIndex(q=>q[0]===r[0]&&q[1]===r[1])===i);
    let ok=false;
    for(const [rw,rh] of list){
      if(gen!==n.gen) return;
      const c={width:{ideal:rw},height:{ideal:rh},frameRate:{min:fps*.95,ideal:fps}};
      try{ await tr.applyConstraints(c); if(got()>=fps*.95){ n.base=c; ok=true; break; } }catch(e){}
    }
    if(!ok) try{ await tr.applyConstraints(n.base); }catch(e){}
    if(gen!==n.gen) return;
  }
  n.status='';
  n.video.srcObject=s; n.video.play().catch(()=>{});
  n.fpsT0=0; n.fpsN=0; n.lastFrameAt=0; n.prevT=0;
  if(typeof MediaStreamTrackProcessor==='function'){
    let rd=null;
    try{ rd=new MediaStreamTrackProcessor({track:tr,maxBufferSize:4}).readable.getReader(); }catch(e){}
    if(rd){ n.mode='mstp'; n.reader=rd; camPumpMSTP(n,rd,gen); return; }
  }
  if(n.video.requestVideoFrameCallback){
    n.mode='rvfc';
    const cb=(now,md)=>{
      if(gen!==n.gen) return;
      const t=(md.captureTime??md.expectedDisplayTime??now)/1000;
      camArrive(n,t);
      const r=camMeasureSrc(n,n.video,n.video.videoWidth,n.video.videoHeight,0);
      if(r) camPush(n,r,t);
      n.video.requestVideoFrameCallback(cb); };
    n.video.requestVideoFrameCallback(cb);
  } else n.mode='raf';
}
// копирование кадра (readback) может длиться дольше периода кадра — держим несколько в работе
// параллельно, а в очередь кладём строго по порядку
async function camPumpMSTP(n,rd,gen){
  let chain=Promise.resolve(), busy=0;
  while(gen===n.gen){
    let r; try{ r=await rd.read(); }catch(e){ break; }
    if(r.done) break;
    const f=r.value, t=f.timestamp/1e6;
    camArrive(n,t);
    if(busy>=3){ f.close(); n.drop++; continue; }
    busy++;
    const job=camMeasureFrame(n,f)
      .catch(()=>camMeasureSrc(n,f,f.displayWidth,f.displayHeight,f.rotation|0))
      .catch(()=>null);
    chain=chain.then(()=>job).then(res=>{ f.close(); busy--; if(res && gen===n.gen) camPush(n,res,t); });
  }
}
// ROI превью (как видит пользователь) -> нормированный прямоугольник кадра с учётом поворота
function camRoi(n,rot){
  let u0=0,v0=0,u1=1,v1=1;
  if(n.p.roi){ u0=n.p.roiX; v0=n.p.roiY; u1=Math.min(1,u0+n.p.roiW); v1=Math.min(1,v0+n.p.roiH); }
  switch(rot){
    case 90:  return [v0,1-u1,v1,1-u0];
    case 180: return [1-u1,1-v1,1-u0,1-v0];
    case 270: return [1-v1,u0,1-v0,u1];
    default:  return [u0,v0,u1,v1];
  }
}
// профиль вдоль оси развёртки (rows — по строкам, cols — по столбцам) и средняя яркость
function camProfile(n,W,H,get){
  const scan=n.p.scan, rows=scan==='rows', L=scan==='off'?0:(rows?H:W);
  const st=Math.max(1,Math.round(Math.sqrt(W*H/2048)));   // ~2к точек на среднее хватает
  let s=0,cnt=0;
  for(let y=0;y<H;y+=st) for(let x=0;x<W;x+=st){ s+=get(x,y); cnt++; }
  let prof=null;
  if(L){
    prof=new Float32Array(L);
    const M=rows?W:H, sm=Math.max(1,Math.round(M/48));
    for(let i=0;i<L;i++){ let a=0,c=0;
      for(let j=0;j<M;j+=sm){ a+=rows?get(j,i):get(i,j); c++; }
      prof[i]=a/c/255; }
  }
  return {v:cnt?s/cnt/255:0, prof};
}
const CAM_YUV=new Set(['I420','I420A','I422','I444','NV12']);
const CAM_RGB={RGBA:[0,1,2],RGBX:[0,1,2],BGRA:[2,1,0],BGRX:[2,1,0]};
async function camMeasureFrame(n,f){
  const vr=f.visibleRect, fmt=f.format;
  if(!vr || !(CAM_YUV.has(fmt)||CAM_RGB[fmt])) throw 0;
  const [a,b,c,d]=camRoi(n,f.rotation|0);
  let x=vr.x+Math.floor(a*vr.width), y=vr.y+Math.floor(b*vr.height);
  let x1=vr.x+Math.ceil(c*vr.width), y1=vr.y+Math.ceil(d*vr.height);
  x&=~1; y&=~1; x1=Math.max(x+2,(x1+1)&~1); y1=Math.max(y+2,(y1+1)&~1);
  x1=Math.min(x1,vr.x+vr.width); y1=Math.min(y1,vr.y+vr.height);
  const rect={x,y,width:x1-x,height:y1-y};
  const sz=f.allocationSize({rect});
  let p=(n.bufs||(n.bufs=[])).pop();
  if(!p||p.length<sz) p=new Uint8Array(sz);
  try{
    const lay=await f.copyTo(p,{rect}), {offset,stride}=lay[0];
    let get;
    if(CAM_YUV.has(fmt)) get=(xx,yy)=>p[offset+yy*stride+xx];
    else { const [ri,gi,bi]=CAM_RGB[fmt];
      get=(xx,yy)=>{ const k=offset+yy*stride+xx*4; return p[k+ri]*.299+p[k+gi]*.587+p[k+bi]*.114; }; }
    const r=camProfile(n,rect.width,rect.height,get);
    // положение зоны вдоль оси развёртки — в строках сенсора (кадр до поворота)
    const rows=n.p.scan==='rows';
    r.p0=rows?(y-vr.y)/vr.height:(x-vr.x)/vr.width;
    r.p1=rows?(y1-vr.y)/vr.height:(x1-vr.x)/vr.width;
    return r;
  } finally { if(n.bufs.length<4) n.bufs.push(p); }
}
// запасной путь: обрезать зону в маленький холст и прочитать его
function camMeasureSrc(n,src,sw,sh,rot){
  if(!sw||!sh) return null;
  const [a,b,c,d]=camRoi(n,rot);
  const rw=(rot===90||rot===270), W=rw?sh:sw, H=rw?sw:sh;   // VideoFrame рисуется без поворота
  const sx=a*W, sy=b*H, w=Math.max(1,(c-a)*W), h=Math.max(1,(d-b)*H);
  const scan=n.p.scan;
  let mw=Math.max(1,Math.min(32,Math.round(w))), mh=Math.max(1,Math.min(32,Math.round(h)));
  if(scan==='rows') mh=Math.max(1,Math.min(1080,Math.round(h)));
  if(scan==='cols') mw=Math.max(1,Math.min(1920,Math.round(w)));
  if(n.mCv.width!==mw||n.mCv.height!==mh){ n.mCv.width=mw; n.mCv.height=mh; }
  n.mCx.drawImage(src,sx,sy,w,h,0,0,mw,mh);
  const px=n.mCx.getImageData(0,0,mw,mh).data;
  const r=camProfile(n,mw,mh,(x,y)=>{ const k=(y*mw+x)*4; return px[k]*.299+px[k+1]*.587+px[k+2]*.114; });
  r.p0=scan==='rows'?b:a; r.p1=scan==='rows'?d:c;
  return r;
}
function camArrive(n,t){                            // частота кадров — по приходу, до обработки
  n.lastFrameAt=performance.now(); n.frameN=(n.frameN|0)+1;
  if(n.prevT){ const d=t-n.prevT;                   // период кадра для развёртки; пропуски не учитываем
    if(d>0 && d<.5 && (!n.fdt || d<n.fdt*1.5)) n.fdt=n.fdt?n.fdt*.95+d*.05:d; }
  n.prevT=t;
  if(!n.fpsT0||t<n.fpsT0){ n.fpsT0=t; n.fpsN=0; }
  else { n.fpsN++; const dt=t-n.fpsT0; if(dt>=1){ n.fps=n.fpsN/dt; n.fpsT0=t; n.fpsN=0; } }
}
function camPush(n,r,t){
  let v=r.v;
  if(n.p.roiAuto){                                  // скользящие min/max для контраста
    n.brMx=v>n.brMx?v:n.brMx*.999+v*.001;
    n.brMn=v<n.brMn?v:n.brMn*.999+v*.001;
    const d=Math.max(.02,n.brMx-n.brMn); v=clamp((v-n.brMn)/d,0,1); }
  n.q.push(t,v); n.qT=t; if(n.q.length>512) n.q.splice(0,n.q.length-512);
  const pr=r.prof; if(!pr) return;
  // строка i экспонируется в t + позиция·(время считывания); считывание = кадр минус гашение
  const L=pr.length, read=(n.fdt||1/30)*(1-n.p.blank), norm=n.p.rsNorm;
  if(norm && (!n.rAvg || n.rAvg.length!==L)) n.rAvg=Float32Array.from(pr);
  const rq=n.rq;
  for(let i=0;i<L;i++){
    let x=pr[i];
    if(norm){ const a=n.rAvg[i]+=(x-n.rAvg[i])*.03;   // медленное среднее строки = сцена, делим на него
      x=clamp(x/Math.max(a,.004)-1,-1,1); }
    rq.push(t+(r.p0+(r.p1-r.p0)*(i+.5)/L)*read, x);
  }
  if(rq.length>262144) rq.splice(0,rq.length-262144);
}
// ручные режимы камеры: автоэкспозиция держит длинную выдержку и роняет fps в полутьме
function camCtlKey(n){ return [n.p.ae,n.p.exp,n.p.af,n.p.awb,n.p.zoom].join(); }
async function camApplyCtl(n){
  const tr=n.track, C=n.caps||{}; if(!tr) return;
  const key=camCtlKey(n); n.ctlKey=key; n.ctlBusy=true;
  const adv={}, miss=[];
  const pick=(k,want)=>{ const m=C[k+'Mode']; if(!m) return false;
    const v=want.find(x=>m.includes(x)); if(v) adv[k+'Mode']=v; return !!v; };
  if(n.p.ae) pick('exposure',['continuous']);
  else if(pick('exposure',['manual']) && C.exposureTime){
    const lo=Math.max(C.exposureTime.min||0,1), hi=Math.max(lo,Math.min(C.exposureTime.max,10000/(+n.p.fps)));
    adv.exposureTime=lo*Math.pow(hi/lo,n.p.exp);    // единицы — 100 мкс; верх — период кадра
  } else miss.push('exposure');
  if(!pick('focus',n.p.af?['continuous']:['single-shot','manual']) && !n.p.af) miss.push('focus');
  if(!pick('whiteBalance',n.p.awb?['continuous']:['manual','single-shot']) && !n.p.awb) miss.push('WB');
  if(C.zoom) adv.zoom=clamp(+n.p.zoom,C.zoom.min,C.zoom.max);
  else if(+n.p.zoom>1) miss.push('zoom');
  try{ await tr.applyConstraints({...n.base,advanced:[adv]}); }
  catch(e){                                          // по одному — чтобы отказ одного не рушил остальные
    for(const [k,v] of Object.entries(adv)){
      try{ await tr.applyConstraints({...n.base,advanced:[{[k]:v}]}); }catch(e2){ miss.push(k); } } }
  n.ctlNote=miss.length?'no '+miss.join('/'):'';
  n.ctlBusy=false;
}
def({ id:'cam', title:'Camera', cat:'Sources', outs:[{n:'img',t:'img'},{n:'bright',t:'num'},{n:'rows',t:'sig'}],
  ins:[{n:'roiX',t:'num'},{n:'roiY',t:'num'},{n:'roiW',t:'num'},{n:'roiH',t:'num'}],
  params:[{n:'on',t:'button',label:'Turn on camera',fn:n=>camStart(n)},
          {n:'cam',t:'select',opts:['front','rear'],d:'rear',fn:n=>{ if(n.track) camStart(n); }},
          {n:'res',t:'select',opts:['160x120','320x240','640x480','1280x720'],d:'320x240',label:'capture',
            fn:n=>{ if(n.track) camStart(n); }},
          {n:'fps',t:'select',opts:['30','60','120','240'],d:'60',label:'frame rate',
            fn:n=>{ if(n.track) camStart(n); }},
          {n:'ae',t:'check',d:true,label:'auto exposure'},
          {n:'exp',t:'range',min:0,max:1,step:.01,d:.5,label:'exposure (manual)'},
          {n:'af',t:'check',d:true,label:'auto focus'},
          {n:'awb',t:'check',d:true,label:'auto white balance'},
          {n:'zoom',t:'range',min:1,max:10,step:.1,d:1,label:'zoom'},
          {n:'w',t:'select',opts:['80','160','320'],d:'160',label:'img width'},
          {n:'roi',t:'check',d:false,label:'brightness zone'},
          {n:'roiX',t:'range',min:0,max:1,step:.01,d:.35,label:'zone: x'},
          {n:'roiY',t:'range',min:0,max:1,step:.01,d:.35,label:'zone: y'},
          {n:'roiW',t:'range',min:.02,max:1,step:.01,d:.3,label:'zone: width'},
          {n:'roiH',t:'range',min:.02,max:1,step:.01,d:.3,label:'zone: height'},
          {n:'roiAuto',t:'check',d:true,label:'zone: auto-contrast'},
          {n:'scan',t:'select',opts:['off','rows','cols'],d:'off',label:'rolling shutter → rows'},
          {n:'blank',t:'range',min:0,max:.6,step:.01,d:.1,label:'rolling: frame blanking',adv:true},
          {n:'rsNorm',t:'check',d:true,label:'rolling: remove scene',adv:true}],
  init(n){ n.video=document.createElement('video'); n.video.playsInline=true; n.video.muted=true;
           n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
           n.mCv=document.createElement('canvas'); n.mCx=n.mCv.getContext('2d',{willReadFrequently:true});
           n.brMn=0; n.brMx=1; n.bright=0; n.rv=0; n.q=[]; n.rq=[]; n.clk=null; n.qT=null;
           n.fps=0; n.fdt=0; n.drop=0; n.mode=''; n.status='off'; },
  dispose:n=>camStop(n),
  view:{h:100}, readout:true, always:true,
  process(n,I){
    for(const k of ['roiX','roiY','roiW','roiH']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=buf(n,'rows'), q=n.q, rq=n.rq, sr=Eng.sr;
    if(n.qT==null){ o.fill(n.rv); return {img:n.img||null, bright:n.bright, rows:o}; }
    const err=n.qT-CAM_LAG-n.clk;
    if(n.clk==null || Math.abs(err)>.3) n.clk=n.qT-CAM_LAG;   // старт/обрыв/смена часов
    else n.clk+=err*.005;                           // медленная подстройка под дрейф часов камеры
    const c0=n.clk;
    let j=0, rv=n.rv;                               // строки — посэмплово, с удержанием в гашении
    for(let i=0;i<BLOCK;i++){ const ti=c0+i/sr;
      while(j<rq.length && rq[j]<=ti){ rv=rq[j+1]; j+=2; }
      o[i]=rv; }
    n.rv=rv; if(j) rq.splice(0,j);
    n.clk+=BLOCK/sr;
    let i=0; while(i<q.length && q[i]<=n.clk){ n.bright=q[i+1]; i+=2; }
    if(i) q.splice(0,i);
    return {img:n.img||null, bright:n.bright, rows:o}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout'), v=n.video;
    if(n.track && n.track.readyState==='ended'){ n.status='camera stopped'; camStop(n); }
    if(n.track && !n.ctlBusy && camCtlKey(n)!==n.ctlKey) camApplyCtl(n);
    if(n.track && v.videoWidth && (n.mode==='raf' || performance.now()-n.lastFrameAt>700)){
      const tf=v.getVideoPlaybackQuality?.().totalVideoFrames;   // без rVFC/MSTP: только новые кадры
      if(tf==null || tf!==n.lastTf){ n.lastTf=tf; const t=performance.now()/1000;
        camArrive(n,t); const res=camMeasureSrc(n,v,v.videoWidth,v.videoHeight,0); if(res) camPush(n,res,t); }
    }
    if(r){
      if(!n.track || n.status) r.textContent=n.status||'off';
      else { const st=n.track.getSettings?.()||{}, fr=st.frameRate, mx=n.caps?.frameRate?.max;
        r.textContent=`${n.fps.toFixed(1)} fps`+(fr?` / ${Math.round(fr)}`:'')+(mx?` (max ${Math.round(mx)})`:'')+
          ` · ${st.width||v.videoWidth}×${st.height||v.videoHeight} · ${n.mode}`+
          (n.drop?` · drop ${n.drop}`:'')+
          (!n.p.ae&&st.exposureTime?` · ${(st.exposureTime/10).toFixed(1)} ms`:'')+
          (n.ctlNote?` · ${n.ctlNote}`:''); }
    }
    if(!v.videoWidth) return;
    // кадр камеры приходит реже кадров экрана — getImageData/превью только на новый кадр
    const fresh=n.frameN!==n._capN; n._capN=n.frameN;
    if(Graph.edges.some(e=>e.from===n.id&&e.fp==='img')){   // полный кадр читаем, только если он кому-то нужен
      const W=+n.p.w, H=Math.round(W*(v.videoHeight/v.videoWidth||3/4));
      if(fresh || !n.img || n.img.w!==W || n.img.h!==H){
        if(n.capCv.width!==W||n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
        n.capCx.drawImage(v,0,0,W,H);
        n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1};
      }
    } else n.img=null;
    const pk=cv.width+'|'+cv.height+'|'+cv.pxGen+'|'+n.p.roi+'|'+n.p.roiX+'|'+n.p.roiY+'|'+n.p.roiW+'|'+n.p.roiH;
    if(!fresh && pk===n._prevKey) return;
    n._prevKey=pk;
    cx.drawImage(v,0,0,cv.width,cv.height);
    if(n.p.roi){                                    // рамка зоны прямо на превью
      cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--t-num');
      cx.lineWidth=2;
      cx.strokeRect(n.p.roiX*cv.width,n.p.roiY*cv.height,n.p.roiW*cv.width,n.p.roiH*cv.height); } }});


// <video> как источник кадров — файл или URL, в отличие от 'cam' не живая камера.
// crossOrigin='anonymous' нужен, иначе getImageData на чужом URL кинет SecurityError
// (canvas "запятнан") — сработает только если сервер видео отдаёт CORS-заголовки.
def({ id:'vidsrc', title:'Video (file/URL)', cat:'Sources', outs:[{n:'img',t:'img'}],
  params:[
    {n:'url',t:'text',d:'',label:'URL'},
    {n:'load',t:'button',label:'Load URL',fn:n=>{
      if(!n.p.url) return; n.video.src=n.p.url; n.video.load(); }},
    {n:'file',t:'file',accept:'video/*',fn:(n,f)=>{ n.video.src=URL.createObjectURL(f); n.video.load(); }},
    {n:'play',t:'button',label:'▶',fn:n=>n.video.play().catch(e=>{n.status='error: '+e.message;})},
    {n:'pause',t:'button',label:'⏸',fn:n=>n.video.pause()},
    {n:'loop',t:'check',d:true},
    {n:'w',t:'select',opts:['80','160','320'],d:'160'},
  ],
  init(n){ n.video=document.createElement('video'); n.video.playsInline=true; n.video.muted=true;
           n.video.crossOrigin='anonymous'; n.video.loop=true;
           n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
           n.status='no source'; },
  view:{h:100}, readout:true, always:true,
  process(n){ if(n.video.loop!==!!n.p.loop) n.video.loop=!!n.p.loop; return {img:n.img||null}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout');
    if(r) r.textContent = n.video.error ? 'load error'
      : n.video.readyState<2 ? n.status : (n.video.paused?'paused':'playing');
    if(!n.video?.videoWidth) return;
    const W=+n.p.w, H=Math.round(W*(n.video.videoHeight/n.video.videoWidth||3/4));
    // новый кадр: счётчик показанных кадров, на паузе — позиция (перемотка)
    const v=n.video, tf=v.getVideoPlaybackQuality?.().totalVideoFrames;
    const fk=(tf??(v.paused?'':performance.now()))+'|'+(v.paused?v.currentTime:'')+'|'+v.readyState+'|'+v.seeking+'|'+W+'x'+H+
      '|'+cv.width+'|'+cv.height+'|'+cv.pxGen;
    if(fk===n._frameKey) return;
    n._frameKey=fk;
    if(n.capCv.width!==W||n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
    n.capCx.drawImage(n.video,0,0,W,H);
    try{ n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1}; }
    catch(e){ n.status='cross-origin video without CORS — frame unreadable'; }
    cx.drawImage(n.capCv,0,0,cv.width,cv.height); }});





def({ id:'const', title:'Constant', cat:'Control', outs:[{n:'out',t:'num'}],
  ins:[{n:'v',t:'num'}],
  params:[{n:'v',t:'range',min:-100,max:100,step:.1,d:1}],
  process(n,I){ if(typeof I.v==='number') setMod(n,'v',I.v); return {out:n.p.v}; }});


def({ id:'lfo', title:'LFO', cat:'Control', outs:[{n:'out',t:'num'},{n:'sync',t:'sig'}],
  ins:[{n:'freq',t:'num'},{n:'sync',t:'sig'}],
  params:[{n:'freq',t:'range',min:.01,max:20,step:.01,d:.5},
          {n:'min',t:'num',d:0},{n:'max',t:'num',d:1},
          {n:'wave',t:'select',opts:['sine','tri','saw','sq'],d:'sine'},
          {n:'phase',t:'range',min:0,max:1,step:.001,d:0,label:'phase'}],
  init:n=>{n.ph=0;n.pv=0;},
  process(n,I){ if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    const os=buf(n,'sync'); os.fill(0);
    if(I.sync){                                     // жёсткая синхронизация по фронту: фаза на старт
      for(let i=0;i<BLOCK;i++){ const sv=I.sync[i]; if(sv>0 && n.pv<=0){ n.ph=n.p.phase; break; } n.pv=sv; }
      n.pv=I.sync[BLOCK-1]; }
    const ph=n.ph;
    const v = n.p.wave==='sine'? .5+.5*Math.sin(2*Math.PI*ph)
            : n.p.wave==='tri' ? 1-Math.abs(2*ph-1)
            : n.p.wave==='saw' ? ph : (ph<.5?1:0);
    const inc=n.p.freq/Eng.sr, nx=ph+inc*BLOCK;
    if(nx>=1) os[Math.min(BLOCK-1,Math.ceil((1-ph)/inc))]=1;   // импульс в начале периода
    n.ph=nx%1;
    return {out:n.p.min+(n.p.max-n.p.min)*v, sync:os}; }});


function uartQueue(n){
  const st=parseFloat(n.p.stop), baudot=n.p.code==='Baudot (RTTY)';
  const q=[[1,8]];                                 // холостой марк на прогрев приёмника
  let figs=null;
  pushChar(q,31,baudot?5:8,st); pushChar(q,31,baudot?5:8,st);
  for(const ch of String(n.src!=null?n.src:n.p.text).toUpperCase()){
    let code;
    if(baudot){
      const e=ita2enc(ch); if(!e) continue;
      if(figs===null||e[0]!==figs){ figs=e[0]; pushChar(q,figs?27:31,5,st); }
      code=e[1];
    } else code=ch.charCodeAt(0)&0xff;
    pushChar(q,code,baudot?5:8,st);
  }
  q.push([1,3]); n.q=q;
}
function pushChar(q,code,bits,st){
  q.push([-1,1]);                                  // start bit (space)
  for(let i=0;i<bits;i++) q.push([(code>>i)&1?1:-1,1]);
  q.push([1,st]);                                  // stop (mark)
}

def({ id:'textsrc', title:'Text Source', cat:'Sources',
  outs:[{n:'text',t:'txt'},{n:'go',t:'num'}], readout:true, tall:true,
  ins:[{n:'repeat',t:'num'}],
  params:[{n:'text',t:'text',d:'CQ CQ DE R1ABC K'},
          {n:'repeat',t:'range',min:0,max:60,step:.5,d:0},
          {n:'send',t:'button',label:'Send',fn:n=>{n.pulse=2;}},
          {n:'file',t:'file',accept:'.txt,text/plain',fn:(n,f)=>{
            const r=new FileReader();
            r.onload=()=>{ n.p.text=String(r.result).slice(0,20000);
              if(n.set&&n.set.text) n.set.text(n.p.text); };
            r.readAsText(f); }}],
  init:n=>{n.pulse=0;n.t=0;},
  process(n,I){
    if(typeof I.repeat==='number') setMod(n,'repeat',I.repeat);
    const dt=BLOCK/Eng.sr;
    if(n.p.repeat>0){ n.t+=dt; if(n.t>=n.p.repeat){ n.t=0; n.pulse=2; } }
    const go=n.pulse>0?1:0; if(n.pulse>0) n.pulse--;
    return {text:String(n.p.text), go}; },
  draw(n){ const r=n.el.querySelector('.readout'), t=String(n.p.text);
    if(r.textContent!==t) r.textContent=t; }});


/* ============================ WEBSERIAL ============================ */
// GPS/NMEA-модули, самодельные платы на Arduino/ESP с ADC, простые UART-SDR — всё это
// на входе просто текстовые строки. Дальше их можно парсить уже в графе (NMEA, CSV и т.п.),
// этот узел сам ничего не разбирает — только читает порт и отдаёт строку целиком.

async function serialTeardown(n){
  n.connected=false; n.connecting=false; n.reading=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} n.reader=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
function serialDisconnect(n){ n.status='disconnected'; serialTeardown(n); }

// Границы чтения из порта не совпадают с границами строк — копим в буфер и режем по \n.
async function serialReadLoop(n){
  n.reading=true;
  const reader = n.port.readable.pipeThrough(new TextDecoderStream()).getReader();
  n.reader = reader;
  let buf='';
  try{
    while(n.reading){
      const {value,done} = await reader.read();
      if(done) break;
      buf += value;
      let idx;
      while((idx=buf.indexOf('\n'))>=0){
        const line = buf.slice(0,idx).replace(/\r$/,''); buf=buf.slice(idx+1);
        if(line){ n.lastLine=line; n.linePulse=2; }
      }
    }
    if(n.reading) n.status='port closed by device';   // done без явного disconnect()
  }catch(e){
    n.status='read error: '+e.message;
  }finally{
    n.reading=false;
  }
}

async function serialConnect(n){
  if(n.connecting) return;
  await serialTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port = await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||9600});
    n.port=port; n.connecting=false; n.connected=true; n.status='connected, '+n.p.baud+' baud';
    serialReadLoop(n);
  }catch(e){
    n.connecting=false; n.connected=false;
    n.status = e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
  }
}

def({ id:'webserial', title:'Serial Port (WebSerial)', cat:'Sources',
  outs:[{n:'line',t:'txt'},{n:'go',t:'num'}], readout:true, tall:true,
  params:[
    {n:'baud',t:'select',opts:['4800','9600','19200','38400','57600','115200'],d:'9600'},
    {n:'connect',t:'button',label:'Connect',fn:n=>serialConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>serialDisconnect(n)},
  ],
  init:n=>{
    n.port=null; n.reader=null; n.connected=false; n.connecting=false; n.reading=false;
    n.lastLine=''; n.linePulse=0; n.status='not connected';
  },
  dispose:n=>{ serialTeardown(n).catch(e=>console.error('serial dispose:',e)); },
  process(n){
    const go = n.linePulse>0?1:0; if(n.linePulse>0) n.linePulse--;
    return {line:n.lastLine, go};
  },
  draw(n){ const r=n.el.querySelector('.readout');
    if(r) r.textContent = n.status+(n.lastLine?(' | '+n.lastLine):''); }
});


// Со страницы, открытой по https, браузер не пускает ws:// и http:// к другим хостам (mixed
// content) — ошибка случается до сети, обойти из JS нельзя. Исключение — localhost/127.x/::1.
function netInsecure(url){
  if(location.protocol!=='https:') return false;
  let u; try{ u=new URL(url); }catch(e){ return false; }
  if(u.protocol!=='ws:' && u.protocol!=='http:') return false;
  return !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname);
}
const NET_INSECURE_MSG='this page is https — the browser blocks ws:// and http:// to other hosts (mixed content). '+
  'Use wss:// / https:// on the device, or open this app over http:// (local copy), '+
  'or allow «Insecure content» for this site in the browser settings (Chrome).';

// Текст по сети: WebSocket (каждое сообщение) или HTTP(S)-опрос с периодом. Строки — по одной
// на блок в line (как у Serial Port), JSON-объекты и массивы объектов — сразу записями в rec.
// Пример (Termux на Android, Wi-Fi скан): websocat -t ws-l:0.0.0.0:8765 sh-c:'while :; do termux-wifi-scaninfo | jq -c .; sleep 30; done'
function netTextFeed(n,text){
  const t=String(text).trim(); if(!t) return;
  n.msgs++;
  const asRec=v=>v && typeof v==='object' && !Array.isArray(v) ? v : {value:v};
  if(t[0]==='{' || t[0]==='['){
    try{
      const j=JSON.parse(t), now=Date.now();
      for(const v of Array.isArray(j) ? j : [j]) n.recQ.push({t:now, ...asRec(v)});
      n.lineQ.push(t.length>2000 ? t.slice(0,2000)+'…' : t);
      return;
    }catch(e){}
  }
  for(const line of t.split(/\r?\n/)){
    const l=line.trim(); if(!l) continue;
    n.lineQ.push(l);
    if(l[0]==='{'){ try{ n.recQ.push({t:Date.now(), ...asRec(JSON.parse(l))}); }catch(e){} }
  }
  if(n.lineQ.length>5000) n.lineQ.splice(0,n.lineQ.length-5000);
  if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
}
function netTextStop(n){
  n.want=false;
  clearTimeout(n.timer); n.timer=null;
  n.abort?.abort(); n.abort=null;
  const ws=n.ws; n.ws=null;
  if(ws){ ws.onclose=ws.onerror=ws.onmessage=null; try{ ws.close(); }catch(e){} }
  n.status='disconnected';
}
function netTextStart(n){
  netTextStop(n);
  const url=String(n.p.url||'').trim();
  if(!url){ n.status='enter a URL'; return; }
  n.want=true;
  if(netInsecure(url)) n.warn=NET_INSECURE_MSG; else n.warn='';
  if(/^wss?:/i.test(url)) netTextWs(n,url);
  else if(/^https?:/i.test(url)) netTextPoll(n,url);
  else n.status='URL must start with ws://, wss://, http:// or https://';
}
function netTextRetry(n,fn,ms){ if(n.want && n.p.reconnect){ clearTimeout(n.timer); n.timer=setTimeout(fn,ms); } }
function netTextWs(n,url){
  let ws;
  try{ ws=new WebSocket(url); }
  catch(e){ n.status='error: '+e.message; netTextRetry(n,()=>netTextWs(n,url),5000); return; }
  n.ws=ws; n.status='connecting…';
  ws.onopen=()=>{ n.status='connected'; };
  ws.onerror=()=>{ n.status='connection error'; };
  ws.onclose=e=>{
    if(n.ws!==ws) return;
    n.ws=null; n.status='closed'+(e.code!==1000?' ('+e.code+')':'')+(n.p.reconnect?' — reconnecting…':'');
    netTextRetry(n,()=>{ if(n.want) netTextWs(n,url); },2000);
  };
  ws.onmessage=e=>{
    if(typeof e.data==='string') netTextFeed(n,e.data);
    else if(e.data?.text) e.data.text().then(t=>netTextFeed(n,t));
  };
}
async function netTextPoll(n,url){
  if(!n.want) return;
  const ac=n.abort=new AbortController();
  try{
    const r=await fetch(url,{cache:'no-store', signal:ac.signal});
    if(!r.ok) throw new Error('HTTP '+r.status);
    netTextFeed(n,await r.text());
    n.status='polling every '+n.p.poll+' s · ok';
  }catch(e){
    if(e.name==='AbortError') return;
    n.status='fetch failed: '+e.message+(e instanceof TypeError ? ' (no CORS headers on the server, or blocked)' : '');
  }
  if(n.want){ clearTimeout(n.timer); n.timer=setTimeout(()=>netTextPoll(n,url),Math.max(0.2,+n.p.poll||5)*1000); }
}
def({ id:'nettext', title:'Text over Network', cat:'Sources',
  ins:[{n:'send',t:'txt'}],                            // по WebSocket: новое значение — отправить
  outs:[{n:'line',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true, tall:true,
  params:[
    {n:'url',t:'text',d:'ws://127.0.0.1:8765',label:'ws:// wss:// http:// https://'},
    {n:'poll',t:'range',min:0.2,max:600,step:0.1,d:5,label:'HTTP poll every, s'},
    {n:'reconnect',t:'check',d:true,label:'reconnect'},
    {n:'connect',t:'button',label:'Connect',fn:n=>netTextStart(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>netTextStop(n)},
  ],
  init:n=>{ n.ws=null; n.want=false; n.timer=null; n.abort=null; n.lineQ=[]; n.recQ=[]; n.lastLine='';
            n.msgs=0; n.count=0; n.status='not connected'; n.warn=''; n.lastSend=undefined; },
  dispose:n=>netTextStop(n),
  process(n,I){
    if(typeof I.send==='string' && I.send!==n.lastSend){
      n.lastSend=I.send;
      if(n.ws && n.ws.readyState===1) n.ws.send(I.send);
    }
    let go=0;
    if(n.lineQ.length){ n.lastLine=n.lineQ.shift(); go=1; n.count++; }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {line:n.lastLine, go, rec, count:n.count};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent=(n.warn&&!n.ws&&n.status!=='connected' ? '⚠ '+n.warn+'\n' : '')+n.status+' · messages '+n.msgs+
      (n.lineQ.length?' · queued '+n.lineQ.length:'')+(n.lastLine?'\n'+n.lastLine.slice(0,400):''); }
});


// Строка от 'webserial' приходит целиком в одном пине (txt) — этот узел режет её по
// запятым и раскладывает по именованным пинам (val), чтобы с числами можно было работать
// как с обычными выходами графа. Разбирает csvParse'ом одну "строку-таблицу" за раз.
function csvlineFields(n){
  return String(n.p.names||'value').split(',').map(s=>s.trim()||'value');
}
def({ id:'csvline', title:'Parse CSV Line', cat:'Data',
  ins:[{n:'line',t:'txt'}],
  outs: n => csvlineFields(n).map(f=>({n:f,t:'val'})),
  readout:true,
  params:[
    {n:'names',t:'text',d:'a,b,c',label:'field names, comma-separated'},
    {n:'apply',t:'button',label:'Apply fields',fn:n=>{ n.initialized=false; rebuildNode(n); markTopoDirty(); }},
  ],
  init:n=>{ n.lastLine=null; n.vals={}; },
  process(n,I){
    if(typeof I.line==='string' && I.line!==n.lastLine){
      n.lastLine=I.line;
      let row=[]; try{ row=csvParse(I.line)[0]||[]; }catch(e){}
      csvlineFields(n).forEach((f,i)=>n.vals[f]=hostlistCoerce(row[i]??''));
    }
    return {...n.vals};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent = n.lastLine||'no data'; }
});


// Фильтрует поток строк по регулярке до того, как они дойдут до 'csvline' и т.п. —
// например, отсеять мусор и оставить только $GPGGA из общего NMEA-потока.
// group>0 — вернуть не всю строку, а захват-группу из неё (напр. только время из GPGGA).
function linefilterCompile(n){
  if(n.reCache && n.reCache.src===n.p.pattern && n.reCache.flags===n.p.flags) return n.reCache.re;
  try{
    const re = new RegExp(n.p.pattern||'', n.p.flags||'');
    n.reCache={src:n.p.pattern,flags:n.p.flags,re}; n.status='';
    return re;
  }catch(e){
    n.reCache={src:n.p.pattern,flags:n.p.flags,re:null};
    n.status='regexp error: '+e.message;
    return null;
  }
}
def({ id:'linefilter', title:'Line Filter (regexp)', cat:'Data',
  ins:[{n:'line',t:'txt'}],
  outs:[{n:'line',t:'txt'},{n:'go',t:'num'}],
  readout:true,
  params:[
    {n:'pattern',t:'text',d:'^\\$GPGGA',label:'regexp'},
    {n:'flags',t:'text',d:'',label:'flags (i, g…)'},
    {n:'group',t:'num',d:0,label:'group (0 = whole line)'},
    {n:'invert',t:'check',d:false,label:'pass NON-matching'},
  ],
  init:n=>{ n.lastIn=null; n.out=''; n.pulse=0; n.status=''; n.reCache=null; },
  process(n,I){
    if(typeof I.line==='string' && I.line!==n.lastIn){
      n.lastIn=I.line;
      const re=linefilterCompile(n);
      if(re){
        const m=re.exec(I.line);
        const pass = n.p.invert ? !m : !!m;
        if(pass){
          n.out = (m && n.p.group>0) ? (m[n.p.group]??'') : I.line;
          n.pulse=2;
        }
      }
    }
    const go=n.pulse>0?1:0; if(n.pulse>0) n.pulse--;
    return {line:n.out, go};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent = n.status || (n.out||'no matches'); }
});


// На Linux донгл сначала отвязать от ядра: rmmod dvb_usb_rtl28xxu rtl2832_sdr rtl2832.
// Регистры/PLL — портировано из librtlsdr/rtlsdrjs, USB — напрямую через navigator.usb.

const RTL_CMD = {REG:1, REGMASK:2, DEMODREG:3, I2CREG:4};
const RTL_BLOCK = {DEMOD:0x000, USB:0x100, SYS:0x200, I2C:0x600};
const RTL_REG = {SYSCTL:0x2000, EPA_CTL:0x2148, EPA_MAXPKT:0x2158, DEMOD_CTL:0x3000, DEMOD_CTL_1:0x300b};

function rtlNumToBuf(value, len, be){
  const b = new ArrayBuffer(len), dv = new DataView(b);
  if(len===1) dv.setUint8(0,value);
  else if(len===2) dv.setUint16(0,value,!be);
  else if(len===4) dv.setUint32(0,value,!be);
  return b;
}
function rtlBufToNum(buf){
  const len=buf.byteLength, dv=new DataView(buf);
  if(len===1) return dv.getUint8(0);
  if(len===2) return dv.getUint16(0,true);
  if(len===4) return dv.getUint32(0,true);
  return null;
}

// регистры/I2C поверх control- и bulk-transfer WebUSB
function rtlMakeCom(dev){
  const WRITE_FLAG=0x10;
  async function writeCtrl(value,index,buffer){
    await dev.controlTransferOut({requestType:'vendor',recipient:'device',request:0,value,index}, buffer);
  }
  async function readCtrl(value,index,length){
    const res = await dev.controlTransferIn({requestType:'vendor',recipient:'device',request:0,value,index}, Math.max(8,length));
    return res.data.buffer.slice(0,length);
  }
  async function writeReg(block,reg,value,length){ await writeCtrl(reg, block|WRITE_FLAG, rtlNumToBuf(value,length)); }
  async function readReg(block,reg,length){ return rtlBufToNum(await readCtrl(reg,block,length)); }
  async function writeRegBuffer(block,reg,buffer){ await writeCtrl(reg, block|WRITE_FLAG, buffer); }
  async function readRegBuffer(block,reg,length){ return await readCtrl(reg,block,length); }
  async function writeRegMask(block,reg,value,mask){
    if(mask===0xff){ await writeReg(block,reg,value,1); return; }
    const old=await readReg(block,reg,1);
    await writeReg(block,reg,(value&mask)|(old&~mask),1);
  }
  async function readDemodReg(page,addr){ return await readReg(page,(addr<<8)|0x20,1); }
  async function writeDemodReg(page,addr,value,len){
    await writeRegBuffer(page,(addr<<8)|0x20, rtlNumToBuf(value,len,true));
    return await readDemodReg(0x0a,0x01);
  }
  async function openI2C(){ await writeDemodReg(1,1,0x18,1); }
  async function closeI2C(){ await writeDemodReg(1,1,0x10,1); }
  async function readI2CReg(addr,reg){ await writeRegBuffer(RTL_BLOCK.I2C, addr, new Uint8Array([reg]).buffer); return await readReg(RTL_BLOCK.I2C, addr, 1); }
  async function writeI2CReg(addr,reg,value){ await writeRegBuffer(RTL_BLOCK.I2C, addr, new Uint8Array([reg,value]).buffer); }
  async function readI2CRegBuffer(addr,reg,len){ await writeRegBuffer(RTL_BLOCK.I2C, addr, new Uint8Array([reg]).buffer); return await readRegBuffer(RTL_BLOCK.I2C, addr, len); }
  async function readBulk(length){ const res=await dev.transferIn(1,length); return res.data.buffer; }
  async function writeEach(arr){
    for(const line of arr){
      if(line[0]===RTL_CMD.REG) await writeReg(line[1],line[2],line[3],line[4]);
      else if(line[0]===RTL_CMD.REGMASK) await writeRegMask(line[1],line[2],line[3],line[4]);
      else if(line[0]===RTL_CMD.DEMODREG) await writeDemodReg(line[1],line[2],line[3],line[4]);
      else if(line[0]===RTL_CMD.I2CREG) await writeI2CReg(line[1],line[2],line[3]);
    }
  }
  return {
    writeRegister:writeReg, readRegister:readReg, writeRegMask,
    demod:{readRegister:readDemodReg, writeRegister:writeDemodReg},
    i2c:{open:openI2C, close:closeI2C, readRegister:readI2CReg, writeRegister:writeI2CReg, readRegBuffer:readI2CRegBuffer},
    bulk:{readBuffer:readBulk},
    iface:{claim:()=>dev.claimInterface(0), release:()=>dev.releaseInterface(0).catch(()=>{})},
    writeEach
  };
}

const R82XX_LNA_STEPS=[0,9,13,40,38,13,31,22,26,31,26,14,19,5,35,13];
const R82XX_MIX_STEPS=[0,5,10,10,19,9,10,25,17,10,8,16,13,6,3,-8];
// как r82xx_set_gain (librtlsdr / rtl-sdr-blog): ступени LNA и смесителя по очереди, пока сумма
// (десятые дБ) не дойдёт до заданной; VGA фиксирован 16.3 дБ. Итог — одна из 29 ступеней 0…49.6 дБ.
function r82xxGainSteps(gain){
  const want=Math.round(gain*10);
  let total=0, lna=0, mix=0;
  for(let i=0;i<15;i++){
    if(total>=want) break;
    total+=R82XX_LNA_STEPS[++lna];
    if(total>=want) break;
    total+=R82XX_MIX_STEPS[++mix];
  }
  return {lna, mix, db:total/10};
}
// тюнер R820T/R828D: регистры, PLL, gain. i2cAddr: 0x34 у R820T, 0x74 у R828D.
// isV4 — RTL-SDR Blog V4 (триплексер, апконвертер КВ); прочие R828D (Astrometa) — вход air/cable1
function rtlMakeR820T(com, xtalFreq, i2cAddr, isV4){
  i2cAddr = i2cAddr || 0x34;
  const REGISTERS=[0x83,0x32,0x75,0xc0,0x40,0xd6,0x6c,0xf5,0x63,0x75,0x68,0x6c,0x83,0x80,0x00,0x0f,0x00,0xc0,0x30,0x48,0xcc,0x60,0x00,0x54,0xae,0x4a,0xc0];
  const MUX_CFGS=[[0,0x08,0x02,0xdf],[50,0x08,0x02,0xbe],[55,0x08,0x02,0x8b],[60,0x08,0x02,0x7b],[65,0x08,0x02,0x69],[70,0x08,0x02,0x58],[75,0x00,0x02,0x44],[90,0x00,0x02,0x34],[110,0x00,0x02,0x24],[140,0x00,0x02,0x14],[180,0x00,0x02,0x13],[250,0x00,0x02,0x11],[280,0x00,0x02,0x00],[310,0x00,0x41,0x00],[588,0x00,0x40,0x00]];
  const BIT_REVS=[0x0,0x8,0x4,0xc,0x2,0xa,0x6,0xe,0x1,0x9,0x5,0xd,0x3,0xb,0x7,0xf];
  let hasPllLock=false, shadow, curBand=null, curInput=null;
  const isR828D = i2cAddr===0x74;

  async function readRegBuffer(addr,length){
    const buf=new Uint8Array(await com.i2c.readRegBuffer(i2cAddr,addr,length));
    for(let i=0;i<buf.length;i++){ const b=buf[i]; buf[i]=(BIT_REVS[b&0xf]<<4)|BIT_REVS[b>>4]; }
    return buf;
  }
  async function writeRegMask(addr,value,mask){
    const val=(shadow[addr-5]&~mask)|(value&mask);
    shadow[addr-5]=val;
    await com.i2c.writeRegister(i2cAddr,addr,val);
  }
  async function writeEach(arr){ for(const l of arr) await writeRegMask(l[0],l[1],l[2]); }

  async function initRegisters(regs){
    shadow=new Uint8Array(regs);
    await com.writeEach(regs.map((v,i)=>[RTL_CMD.I2CREG,i2cAddr,i+5,v]));
  }
  async function initElectronics(){
    await writeEach([[0x0c,0x00,0x0f],[0x13,49,0x3f],[0x1d,0x00,0x38]]);
    await writeRegMask(0x12,0x00,0xe0); // максимальный VCO current — правка RTL-SDR Blog для стабильной блокировки PLL
    const filterCap=await calibrateFilter(true);
    await writeEach([[0x0a,0x10|filterCap,0x1f],[0x0b,0x6b,0xef],[0x07,0x00,0x80],[0x06,0x10,0x30],
      [0x1e,0x40,0x60],[0x05,0x00,0x80],[0x1f,0x00,0x80],[0x0f,0x00,0x80],[0x19,0x60,0x60],
      [0x1d,0xe5,0xc7],[0x1c,0x24,0xf8],[0x0d,0x53,0xff],[0x0e,0x75,0xff],[0x05,0x00,0x60],
      [0x06,0x00,0x08],[0x11,0x38,0x08],[0x17,0x30,0x30],[0x0a,0x40,0x60],[0x1d,0x00,0x38],
      [0x1c,0x00,0x04],[0x06,0x00,0x40],[0x1a,0x30,0x30],[0x1d,0x18,0x38],[0x1c,0x24,0x04],
      [0x1e,0x0d,0x1f],[0x1a,0x20,0x30]]);
  }
  async function calibrateFilter(firstTry){
    await writeEach([[0x0b,0x6b,0x60],[0x0f,0x04,0x04],[0x10,0x00,0x03]]);
    // на холодном старте PLL иногда не успевает устаканиться с первой попытки (отсюда
    // "шипит после первого подключения, реконнект чинит" — реконнект просто даёт больше
    // времени пройти между инициализацией и калибровкой). Пробуем несколько раз с паузой,
    // прежде чем смиряться с некалиброванным фильтром.
    for(let attempt=0; attempt<3 && !hasPllLock; attempt++){
      if(attempt>0) await new Promise(r=>setTimeout(r,25));
      await setPll(56000000);
    }
    if(!hasPllLock){
      console.warn('[rtlsdr] PLL lock warning при калибровке фильтра (56МГц) после 3 попыток — продолжаю с фильтром по умолчанию');
      return 0;
    }
    await writeEach([[0x0b,0x10,0x10],[0x0b,0x00,0x10],[0x0f,0x00,0x04]]);
    const arr=await readRegBuffer(0x00,5);
    let filterCap=arr[4]&0x0f;
    if(filterCap===0x0f) filterCap=0;
    return (filterCap!==0 && firstTry) ? await calibrateFilter(false) : filterCap;
  }
  async function setMux(freq){
    const mhz=freq/1e6; let i=0;
    for(i=0;i<MUX_CFGS.length-1;i++) if(mhz<MUX_CFGS[i+1][0]) break;
    const c=MUX_CFGS[i];
    await writeEach([[0x17,c[1],0x08],[0x1a,c[2],0xc3],[0x1b,c[3],0xff],[0x10,0x00,0x0b],[0x08,0x00,0x3f],[0x09,0x00,0x3f]]);
  }
  async function setPll(freq){
    const pllRef=Math.floor(xtalFreq), vcoPowerRef=isR828D?1:2; // у R828D другое опорное значение VCO fine-tune
    await writeEach([[0x10,0x00,0x10],[0x1a,0x00,0x0c]]);
    await writeRegMask(0x12, 0x06, 0xff);              // максимальный ток VCO — как в драйвере RTL-SDR Blog
    // делитель: наименьший mixDiv, при котором VCO попадает в 1.77–3.54 ГГц
    let mixDiv=2, divNum=0;
    while(mixDiv<=64 && !(freq*mixDiv>=1770000000 && freq*mixDiv<3540000000)) mixDiv<<=1;
    for(let d=mixDiv; d>2; d>>=1) divNum++;
    const arr=await readRegBuffer(0x00,5);
    const vcoFineTune=(arr[4]&0x30)>>4;
    if(vcoFineTune>vcoPowerRef) divNum--; else if(vcoFineTune<vcoPowerRef) divNum++;
    await writeRegMask(0x10, divNum<<5, 0xe0);
    // VCO считается по исходному mixDiv, без поправки fine tune — так в librtlsdr
    const vcoFreq=freq*mixDiv;
    const nint=Math.floor(vcoFreq/(2*pllRef)), vcoFra=vcoFreq%(2*pllRef);
    if(nint>(128/vcoPowerRef-1)){ hasPllLock=false; return null; }
    const ni=Math.floor((nint-13)/4), si=(nint-13)%4;
    await writeEach([[0x14, ni+(si<<6), 0xff],[0x12, vcoFra===0?0x08:0x00, 0x08]]);
    const sdm=Math.min(65535, Math.floor(32768*vcoFra/pllRef));
    await writeEach([[0x16, sdm>>8, 0xff],[0x15, sdm&0xff, 0xff]]);
    await getPllLock(true);
    await writeRegMask(0x1a, 0x08, 0x08);
    return 2*pllRef*(nint+sdm/65536)/mixDiv;
  }
  async function getPllLock(firstTry){
    const arr=await readRegBuffer(0x00,3);
    if(arr[2]&0x40){ hasPllLock=true; return; }
    hasPllLock=false;
  }
  // GPIO RTL2832U (блок SYS): GPO 0x3001, GPOE 0x3003, GPD 0x3004 — как rtlsdr_set_bias_tee_gpio
  async function setGpio(bit, on){
    const m=1<<bit;
    const gpd=await com.readRegister(RTL_BLOCK.SYS, 0x3004, 1);
    await com.writeRegister(RTL_BLOCK.SYS, 0x3004, gpd&~m, 1);
    const gpoe=await com.readRegister(RTL_BLOCK.SYS, 0x3003, 1);
    await com.writeRegister(RTL_BLOCK.SYS, 0x3003, gpoe|m, 1);
    const gpo=await com.readRegister(RTL_BLOCK.SYS, 0x3001, 1);
    await com.writeRegister(RTL_BLOCK.SYS, 0x3001, on?(gpo|m):(gpo&~m), 1);
  }
  async function init(){ await initRegisters(REGISTERS); await initElectronics(); }
  // rfFreq — истинная целевая RF-частота (без добавленного IF), нужна только для выбора входа/нотчей у R828D
  async function setFrequency(freq, rfFreq){
    const rf=rfFreq!=null?rfFreq:freq;
    // Blog V4: аппаратный апконвертер +28.8МГц для КВ (0-28.8МГц) — тюнер физически не
    // настраивается так низко напрямую. Реальную частоту гетеродина сдвигаем вверх, а вход
    // триплексера (setV4Input ниже) всё равно выбираем по ИСХОДНОЙ, не сдвинутой частоте —
    // так его определяет сам чип. Сдвиг считаем от xtalFreq (с учётом ppm), не от круглой
    // константы — так делает и официальный драйвер (dev->tun_xtal).
    const upconvert=(isV4 && rf<=28.8e6) ? xtalFreq : 0;
    const loFreq=freq+upconvert;
    await setMux(loFreq);
    let r=await setPll(loFreq);
    // та же засада, что была с калибровкой фильтра: PLL иногда не успевает заблокироваться
    // с первой попытки на реальной частоте приёма, не только на калибровочных 56МГц. Раньше
    // ретрай стоял только в calibrateFilter — отсюда "шипит после коннекта, чисто после
    // ручной перестройки" (перестройка = ещё одна попытка setPll, которая обычно уже проходит).
    for(let attempt=0; attempt<2 && !hasPllLock; attempt++){
      await new Promise(res=>setTimeout(res,15));
      r=await setPll(loFreq);
    }
    if(isV4) await setV4Input(rf);
    else if(isR828D) await setR828DInput(rf);
    // КВ через апконвертер: трекинг-фильтр в обход (меньше потерь), setMux его возвращает при каждой перестройке
    if(upconvert){ await writeRegMask(0x1a, 0x40, 0xc3); await writeRegMask(0x1b, 0x00, 0xff); }
    return r!=null ? r-upconvert : r; // вычитаем сдвиг обратно — вызывающий код не должен знать про апконвертер
  }
  // Blog V4: R828D разведён через триплексер на три физических входа (HF/VHF/UHF) —
  // без явного переключения регистров антенна не подключена к активному тракту тюнера.
  async function setV4Input(freq){
    const openD = (freq<=2.2e6 || (freq>=85e6&&freq<=112e6) || (freq>=172e6&&freq<=242e6)) ? 0x00 : 0x08;
    await writeRegMask(0x17, openD, 0x08);
    const band = freq<=28.8e6 ? 1 : (freq<250e6 ? 2 : 3); // 1=HF 2=VHF 3=UHF
    if(band===curBand) return;
    curBand=band;
    await writeRegMask(0x06, band===1?0x08:0x00, 0x08); // cable2 — вход HF (апконвертер)
    await setGpio(5, band!==1);                          // ключ апконвертера на V4 новых партий: 0 — КВ
    await writeRegMask(0x05, band===2?0x40:0x00, 0x40); // cable1 — вход VHF
    await writeRegMask(0x05, band===3?0x00:0x20, 0x20); // air — вход UHF
  }
  // R828D без триплексера (Astrometa): выше 345МГц вход air, ниже cable1 — как в librtlsdr
  async function setR828DInput(freq){
    const v=freq>345e6 ? 0x00 : 0x60;
    if(v===curInput) return;
    curInput=v;
    await writeRegMask(0x05, v, 0x60);
  }
  async function setAutoGain(){ await writeEach([[0x05,0x00,0x10],[0x07,0x10,0x10],[0x0c,0x0b,0x9f]]); }
  async function setManualGain(gain){
    const {lna,mix,db}=r82xxGainSteps(gain);
    await writeEach([[0x05,0x10,0x10],[0x07,0x00,0x10],[0x0c,0x08,0x9f],[0x05,lna,0x0f],[0x07,mix,0x0f]]);
    return db;
  }
  async function close(){
    await writeEach([[0x06,0xb1,0xff],[0x05,0xb3,0xff],[0x07,0x3a,0xff],[0x08,0x40,0xff],[0x09,0xc0,0xff],
      [0x0a,0x36,0xff],[0x0c,0x35,0xff],[0x0f,0x68,0xff],[0x11,0x03,0xff],[0x17,0xf4,0xff],[0x19,0x0c,0xff]]);
  }
  return {init, setFrequency, setAutoGain, setManualGain, setGpio, close};
}
// проверка чипа по ID-регистру на конкретном I2C-адресе (0x69 у обеих версий R82xx)
rtlMakeR820T.checkAt = async function(com, addr){
  try { return (await com.i2c.readRegister(addr,0)) === 0x69; }
  catch(e){ return false; }
};
// перебирает известные адреса тюнера: 0x34 — R820T, 0x74 — R828D (RTL-SDR Blog V4 и клоны)
rtlMakeR820T.detect = async function(com){
  if(await rtlMakeR820T.checkAt(com, 0x34)) return {addr:0x34, name:'R820T'};
  if(await rtlMakeR820T.checkAt(com, 0x74)) return {addr:0x74, name:'R828D'};
  return null;
};

// открывает и настраивает донгл целиком, отдаёт команды верхнего уровня
async function rtlOpenDevice(dev, ppm, gain){
  const XTAL=28800000, IF=3570000;
  await dev.open();
  await dev.selectConfiguration(1);
  const com=rtlMakeCom(dev);
  await com.writeEach([
    [RTL_CMD.REG, RTL_BLOCK.USB, RTL_REG.SYSCTL, 0x09, 1],
    [RTL_CMD.REG, RTL_BLOCK.USB, RTL_REG.EPA_MAXPKT, 0x0200, 2],
    [RTL_CMD.REG, RTL_BLOCK.USB, RTL_REG.EPA_CTL, 0x0210, 2]
  ]);
  await com.iface.claim();
  await com.writeEach([
    [RTL_CMD.REG, RTL_BLOCK.SYS, RTL_REG.DEMOD_CTL_1, 0x22, 1],
    [RTL_CMD.REG, RTL_BLOCK.SYS, RTL_REG.DEMOD_CTL, 0xe8, 1],
    [RTL_CMD.DEMODREG,1,0x01,0x14,1],[RTL_CMD.DEMODREG,1,0x01,0x10,1],
    [RTL_CMD.DEMODREG,1,0x15,0x00,1],[RTL_CMD.DEMODREG,1,0x16,0x0000,2],
    [RTL_CMD.DEMODREG,1,0x16,0x00,1],[RTL_CMD.DEMODREG,1,0x17,0x00,1],
    [RTL_CMD.DEMODREG,1,0x18,0x00,1],[RTL_CMD.DEMODREG,1,0x19,0x00,1],
    [RTL_CMD.DEMODREG,1,0x1a,0x00,1],[RTL_CMD.DEMODREG,1,0x1b,0x00,1],
    [RTL_CMD.DEMODREG,1,0x1c,0xca,1],[RTL_CMD.DEMODREG,1,0x1d,0xdc,1],
    [RTL_CMD.DEMODREG,1,0x1e,0xd7,1],[RTL_CMD.DEMODREG,1,0x1f,0xd8,1],
    [RTL_CMD.DEMODREG,1,0x20,0xe0,1],[RTL_CMD.DEMODREG,1,0x21,0xf2,1],
    [RTL_CMD.DEMODREG,1,0x22,0x0e,1],[RTL_CMD.DEMODREG,1,0x23,0x35,1],
    [RTL_CMD.DEMODREG,1,0x24,0x06,1],[RTL_CMD.DEMODREG,1,0x25,0x50,1],
    [RTL_CMD.DEMODREG,1,0x26,0x9c,1],[RTL_CMD.DEMODREG,1,0x27,0x0d,1],
    [RTL_CMD.DEMODREG,1,0x28,0x71,1],[RTL_CMD.DEMODREG,1,0x29,0x11,1],
    [RTL_CMD.DEMODREG,1,0x2a,0x14,1],[RTL_CMD.DEMODREG,1,0x2b,0x71,1],
    [RTL_CMD.DEMODREG,1,0x2c,0x74,1],[RTL_CMD.DEMODREG,1,0x2d,0x19,1],
    [RTL_CMD.DEMODREG,1,0x2e,0x41,1],[RTL_CMD.DEMODREG,1,0x2f,0xa5,1],
    [RTL_CMD.DEMODREG,0,0x19,0x05,1],[RTL_CMD.DEMODREG,1,0x93,0xf0,1],
    [RTL_CMD.DEMODREG,1,0x94,0x0f,1],[RTL_CMD.DEMODREG,1,0x11,0x00,1],
    [RTL_CMD.DEMODREG,1,0x04,0x00,1],[RTL_CMD.DEMODREG,0,0x61,0x60,1],
    [RTL_CMD.DEMODREG,0,0x06,0x80,1],[RTL_CMD.DEMODREG,1,0xb1,0x1b,1],
    [RTL_CMD.DEMODREG,0,0x0d,0x83,1]
  ]);

  const xtalFreq=Math.floor(XTAL*(1+ppm/1e6));
  await com.i2c.open();
  const found=await rtlMakeR820T.detect(com);
  if(!found){ await com.i2c.close(); throw new Error('tuner is not R820T/R828D — unsupported'); }
  // V4 определяем по USB-строкам, как librtlsdr. У остальных R828D свой кварц тюнера 16МГц
  const isV4=found.addr===0x74 && dev.manufacturerName==='RTLSDRBlog' && dev.productName==='Blog V4';
  const tunXtal=(found.addr===0x74 && !isV4) ? Math.floor(16e6*(1+ppm/1e6)) : xtalFreq;
  const tuner=rtlMakeR820T(com, tunXtal, found.addr, isV4);
  const mult=-1*Math.floor(IF*(1<<22)/xtalFreq);
  await com.writeEach([
    [RTL_CMD.DEMODREG,1,0xb1,0x1a,1],[RTL_CMD.DEMODREG,0,0x08,0x4d,1],
    [RTL_CMD.DEMODREG,1,0x19,(mult>>16)&0x3f,1],[RTL_CMD.DEMODREG,1,0x1a,(mult>>8)&0xff,1],
    [RTL_CMD.DEMODREG,1,0x1b,mult&0xff,1],[RTL_CMD.DEMODREG,1,0x15,0x01,1]
  ]);
  await tuner.init();
  if(gain==null) await tuner.setAutoGain(); else await tuner.setManualGain(gain);
  await com.i2c.close();

  async function setSampleRate(rate){
    rate=Math.min(rate, 3200000);
    // коэффициент ресемплинга — 28-битный регистр; для XTAL=28.8МГц это требует rate>450000.
    // Ниже этого порога коэффициент не влезает, маска обрезает старший бит, и реально
    // настроенная частота получается совсем другой (например, для 250000 — внезапно 562500),
    // а resampling-математика выше по стеку продолжит думать, что частота осталась запрошенной —
    // рассинхрон и "ускоренный голос". Явно отказываемся, а не тихо конфигурируем не то.
    const ratioRaw=XTAL*(1<<22)/rate;
    if(ratioRaw>=(1<<28)) throw new Error('sample rate '+rate+' Hz too low for this XTAL — minimum ~450000 Hz');
    const ratio=Math.floor(ratioRaw) & 0x0ffffffc;
    const real=Math.floor(XTAL*(1<<22)/ratio);
    const ppmOff=-1*Math.floor(ppm*(1<<24)/1e6);
    await com.writeEach([
      [RTL_CMD.DEMODREG,1,0x9f,(ratio>>16)&0xffff,2],[RTL_CMD.DEMODREG,1,0xa1,ratio&0xffff,2],
      [RTL_CMD.DEMODREG,1,0x3e,(ppmOff>>8)&0x3f,1],[RTL_CMD.DEMODREG,1,0x3f,ppmOff&0xff,1]
    ]);
    await com.writeEach([[RTL_CMD.DEMODREG,1,0x01,0x14,1],[RTL_CMD.DEMODREG,1,0x01,0x10,1]]);
    return real;
  }
  // эпоха перестройки: трансферы, запущенные до её конца, несут отсчёты старой частоты
  let tuneEpoch=0;
  async function setCenterFrequency(freq){
    await com.i2c.open();
    const actual=await tuner.setFrequency(freq+IF, freq);
    await com.i2c.close();
    tuneEpoch++;
    return actual-IF;
  }
  async function setGain(g){
    await com.i2c.open();
    if(g==null) await tuner.setAutoGain(); else await tuner.setManualGain(g);
    await com.i2c.close();
  }
  async function resetBuffer(){
    await com.writeEach([[RTL_CMD.REG,RTL_BLOCK.USB,RTL_REG.EPA_CTL,0x0210,2],[RTL_CMD.REG,RTL_BLOCK.USB,RTL_REG.EPA_CTL,0x0000,2]]);
  }
  async function readSamples(nBytes){ return await com.bulk.readBuffer(nBytes); }
  async function setBiasTee(on){ await tuner.setGpio(0, on); }   // GPIO0 — как rtlsdr_set_bias_tee
  async function close(){
    await com.i2c.open(); await tuner.close(); await com.i2c.close();
    await com.iface.release();
    await dev.close();
  }
  return {setSampleRate, setCenterFrequency, setGain, setBiasTee, resetBuffer, readSamples, close,
    tunerName:found.name+(isV4?' (Blog V4)':''), kind:'rtl', fmt:'u8', bps:2, epoch:()=>tuneEpoch};
}

// ---- HackRF и Airspy: тот же API, что у rtlOpenDevice ----
// fmt — формат отсчётов в буферах readSamples: 'u8' (IQ по байту, смещение 127.5) или 's16'
// (IQ по int16); bps — байт на комплексный отсчёт. Протоколы — по libhackrf и libairspy.
function sdrVendorIn(dev, request, index, length){
  return dev.controlTransferIn({requestType:'vendor',recipient:'device',request,value:0,index}, length);
}
function sdrVendorOut(dev, request, value, index, data){
  return dev.controlTransferOut({requestType:'vendor',recipient:'device',request,value,index}, data);
}

// HackRF: MAX2837 с нулевой ПЧ, int8 IQ. На Linux: rmmod hackrf
async function hackrfOpenDevice(dev, gain){
  const REQ={MODE:1, SAMPLE_RATE:6, BB_FILTER:7, SET_FREQ:16, AMP:17, LNA:19, VGA:20, ANT_POWER:23, TXVGA:21};
  // полосы baseband-фильтра MAX2837, Гц
  const BB=[1750000,2500000,3500000,5000000,5500000,6000000,7000000,8000000,9000000,10000000,
    12000000,14000000,15000000,20000000,24000000,28000000];
  await dev.open();
  await dev.selectConfiguration(1);
  await dev.claimInterface(0);
  let tuneEpoch=0, rxOn=false;
  const u32pair=(a,b)=>{ const v=new DataView(new ArrayBuffer(8)); v.setUint32(0,a,true); v.setUint32(4,b,true); return v.buffer; };
  const setMode=m=>sdrVendorOut(dev, REQ.MODE, m, 0);

  async function setSampleRate(rate){
    rate=Math.round(Math.max(2e6, Math.min(20e6, rate)));
    await sdrVendorOut(dev, REQ.SAMPLE_RATE, 0, 0, u32pair(rate, 1));
    // фильтр — наибольшая полоса не шире 0.75·rate, как hackrf_compute_baseband_filter_bw
    let bw=BB[0]; for(const b of BB) if(b<=0.75*rate) bw=b;
    await sdrVendorOut(dev, REQ.BB_FILTER, bw&0xffff, bw>>>16);
    return rate;
  }
  async function setCenterFrequency(freq){
    freq=Math.round(freq);
    const mhz=Math.floor(freq/1e6);
    await sdrVendorOut(dev, REQ.SET_FREQ, 0, 0, u32pair(mhz, freq-mhz*1e6));
    tuneEpoch++;
    return freq;
  }
  // АРУ в HackRF нет: auto — средние LNA/VGA. Ручной gain 0..49.6 растягиваем на LNA 0-40 (шаг 8) + VGA 0-62 (шаг 2)
  async function setGain(g){
    let lna=24, vga=24;
    if(g!=null){
      const t=Math.max(0, Math.min(1, g/49.6))*102;
      lna=Math.min(40, Math.round(t*40/102/8)*8);
      vga=Math.min(62, Math.max(0, Math.round((t-lna)/2)*2));
    }
    await setHackrfGain(lna, vga, false);
  }
  // отдельные ступени: LNA 0-40 шаг 8, VGA 0-62 шаг 2, усилитель +14 дБ
  async function setHackrfGain(lna, vga, amp){
    lna=Math.max(0, Math.min(40, Math.round(lna/8)*8));
    vga=Math.max(0, Math.min(62, Math.round(vga/2)*2));
    await sdrVendorOut(dev, REQ.AMP, amp?1:0, 0);
    await sdrVendorIn(dev, REQ.LNA, lna, 1);
    await sdrVendorIn(dev, REQ.VGA, vga, 1);
  }
  async function setBiasTee(on){ await sdrVendorOut(dev, REQ.ANT_POWER, on?1:0, 0); }
  async function resetBuffer(){ await setMode(0); await setMode(1); rxOn=true; }
  async function readSamples(nBytes){
    const res=await dev.transferIn(1, nBytes);
    const u8=new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    for(let i=0;i<u8.length;i++) u8[i]^=0x80;       // int8 → смещённый u8, как у RTL
    return res.data.buffer;
  }
  // передача: int8 IQ в bulk OUT 2. Кольцо добирается из txPush, цикл держит 4 трансфера в полёте;
  // пока кольцо не набрало 4 чанка (и после опустошения) уходят нули — несущая выключена
  const TX_CHUNK=32768, TX_RING=1<<24;
  let txOn=false, txRing=null, txR=0, txW=0, txUnder=0, txOver=0, txErr='', txLoopP=null;
  async function setTxGain(vga, amp){
    vga=Math.max(0, Math.min(47, Math.round(vga)));
    await sdrVendorOut(dev, REQ.AMP, amp?1:0, 0);
    await sdrVendorIn(dev, REQ.TXVGA, vga, 1);
  }
  // нет данных дольше TX_IDLE_MS — передатчик выключается совсем: поток нулей оставил бы несущую (утечка гетеродина)
  const TX_IDLE_MS=400;
  async function txLoop(){
    const pend=[]; let primed=false, idleT=performance.now(), idle=false;
    while(txOn){
      while(txOn && pend.length<4){
        const b=new Int8Array(TX_CHUNK), avail=txW-txR;
        if(avail>=TX_CHUNK && (primed || avail>=4*TX_CHUNK)){
          primed=true; idleT=performance.now();
          const r=txR&(TX_RING-1), f=Math.min(TX_CHUNK, TX_RING-r);
          b.set(txRing.subarray(r, r+f)); b.set(txRing.subarray(0, TX_CHUNK-f), f);
          txR+=TX_CHUNK;
        } else {
          if(primed){ primed=false; txUnder++; }
          if(performance.now()-idleT>TX_IDLE_MS){ idle=true; txErr='no data: RF off'; txOn=false; break; }
        }
        pend.push(dev.transferOut(2, b));
      }
      try{ await pend.shift(); }catch(e){ txErr=e.message; txOn=false; }
    }
    await Promise.allSettled(pend);
    if(idle) await setMode(0).catch(()=>{});
  }
  async function txStart(){
    if(txOn) return;
    txRing=new Int8Array(TX_RING); txR=txW=txUnder=txOver=0; txErr='';
    await setMode(0); await setMode(2);
    txOn=true; rxOn=false;
    txLoopP=txLoop();
  }
  async function txStop(){
    const was=txOn||txLoopP;
    txOn=false;
    if(txLoopP){ await txLoopP; txLoopP=null; }
    if(was) await setMode(0).catch(()=>{});
  }
  function txPush(a){
    if(!txOn) return;
    let k=a.length; const free=TX_RING-(txW-txR);
    if(k>free){ txOver+=k-free; k=free; }
    const w=txW&(TX_RING-1), f=Math.min(k, TX_RING-w);
    txRing.set(a.subarray(0,f), w); txRing.set(a.subarray(f,k), 0);
    txW+=k;
  }
  const txStats=()=>({on:txOn, queued:(txW-txR)/TX_RING, under:txUnder, over:txOver, err:txErr});
  async function close(){
    await txStop();
    if(rxOn) await setMode(0).catch(()=>{});
    await dev.releaseInterface(0).catch(()=>{});
    await dev.close();
  }
  await setMode(0);
  await setGain(gain);
  return {setSampleRate, setCenterFrequency, setGain, setHackrfGain, setBiasTee, resetBuffer, readSamples, close,
    setTxGain, txStart, txStop, txPush, txStats,
    tunerName:dev.productName||'HackRF', kind:'hackrf', fmt:'u8', bps:2, epoch:()=>tuneEpoch};
}

// Airspy R2/Mini: АЦП отдаёт вещественные 12-битные отсчёты (uint16, смещение 2048) на удвоенной
// частоте, ПЧ = fs/4. В IQ переводим сами, как iqconverter в libairspy: сдвиг на fs/4
// последовательностью знаков -,-,+,+ (чётные — I, нечётные — Q), полуполосный ФНЧ, прореживание на 2.
// На Linux: rmmod airspy
function airspyMakeConv(){
  const M=24, N=2*M+1, beta=6;
  const i0=x=>{ let s=1, t=1; for(let k=1;k<30;k++){ t*=(x/(2*k))*(x/(2*k)); s+=t; } return s; };
  // h[j] — отвод на смещении j от центра; у полуполосного ненулевые только центр и нечётные j
  const h=new Float32Array(M+1);
  let sum=0;
  for(let j=1;j<=M;j+=2){ const r=j/M; h[j]=Math.sin(Math.PI*j/2)/(Math.PI*j)*i0(beta*Math.sqrt(1-r*r))/i0(beta); sum+=2*h[j]; }
  for(let j=1;j<=M;j+=2) h[j]*=0.5/sum;             // усиление на нуле = 1
  const hist=new Float32Array(2*N);
  let pos=0, n=0, dc=2048;
  return {
    reset(){ hist.fill(0); pos=0; n=0; },
    // raw — Uint16Array вещественных отсчётов, out — Int16Array IQ той же длины (можно на месте)
    process(raw, out){
      let w=0;
      for(let k=0;k<raw.length;k++){
        const v=raw[k]&0x0fff;
        dc+=(v-dc)*1e-4;
        const x=(n&2) ? v-dc : dc-v;
        hist[pos]=x; hist[pos+N]=x;
        if(++pos===N) pos=0;
        if(n&1){
          // окно hist[pos..pos+N-1], центр — pos+M; задержка чётной длины — отсчёт Q, нечётные отводы — I
          const c=pos+M;
          let si=0;
          for(let j=1;j<=M;j+=2) si+=h[j]*(hist[c-j]+hist[c+j]);
          const sq=0.5*hist[c];
          out[w++]=Math.max(-32768, Math.min(32767, Math.round(si*16)));
          out[w++]=Math.max(-32768, Math.min(32767, Math.round(sq*16)));
        }
        n=(n+1)&3;
      }
    }
  };
}
async function airspyOpenDevice(dev, gain){
  const REQ={MODE:1, SET_SAMPLERATE:12, SET_FREQ:13, LNA:14, MIXER:15, VGA:16, LNA_AGC:17, MIXER_AGC:18,
    GPIO_WRITE:21, GET_SAMPLERATES:25, PACKING:26};
  await dev.open();
  await dev.selectConfiguration(1);
  await dev.claimInterface(0);
  let tuneEpoch=0, rxOn=false;
  const setMode=m=>sdrVendorOut(dev, REQ.MODE, m, 0);
  const conv=airspyMakeConv();
  await setMode(0);
  try{ await sdrVendorIn(dev, REQ.PACKING, 0, 1); }catch(e){}   // упаковка 12 бит выключена — uint16 на отсчёт
  // список частот IQ из прошивки; старые прошивки его не отдают
  let rates=[10000000, 2500000];
  try{
    const c=await sdrVendorIn(dev, REQ.GET_SAMPLERATES, 0, 4), cnt=c.data.getUint32(0,true);
    if(cnt>0 && cnt<16){
      const r=await sdrVendorIn(dev, REQ.GET_SAMPLERATES, cnt, cnt*4);
      rates=[]; for(let i=0;i<cnt;i++) rates.push(r.data.getUint32(i*4,true));
    }
  }catch(e){}

  async function setSampleRate(rate){
    let idx=0;
    for(let i=1;i<rates.length;i++) if(Math.abs(Math.log(rates[i]/rate))<Math.abs(Math.log(rates[idx]/rate))) idx=i;
    const was=rxOn;
    if(was) await setMode(0);
    await sdrVendorIn(dev, REQ.SET_SAMPLERATE, idx, 1);
    if(was){ conv.reset(); await setMode(1); }
    return rates[idx];
  }
  async function setCenterFrequency(freq){
    freq=Math.round(freq);
    const b=new DataView(new ArrayBuffer(4)); b.setUint32(0, freq, true);
    await sdrVendorOut(dev, REQ.SET_FREQ, 0, 0, b.buffer);
    tuneEpoch++;
    return freq;
  }
  // auto — АРУ LNA и смесителя, VGA фиксирован. Ручной gain 0..49.6 — 0..44 шагов поровну на LNA/смеситель/VGA
  async function setGain(g){
    if(g==null){
      await sdrVendorIn(dev, REQ.LNA_AGC, 1, 1); await sdrVendorIn(dev, REQ.MIXER_AGC, 1, 1);
      await sdrVendorIn(dev, REQ.VGA, 8, 1);
      return;
    }
    const s=Math.round(Math.max(0, Math.min(1, g/49.6))*44);
    const lna=Math.min(14, Math.ceil(s/3)), mix=Math.min(15, Math.round(s/3)), vga=Math.max(0, Math.min(15, s-lna-mix));
    await sdrVendorIn(dev, REQ.LNA_AGC, 0, 1); await sdrVendorIn(dev, REQ.MIXER_AGC, 0, 1);
    await sdrVendorIn(dev, REQ.LNA, lna, 1); await sdrVendorIn(dev, REQ.MIXER, mix, 1); await sdrVendorIn(dev, REQ.VGA, vga, 1);
  }
  // bias-tee — GPIO порт 1 пин 13, как airspy_set_rf_bias
  async function setBiasTee(on){ await sdrVendorOut(dev, REQ.GPIO_WRITE, on?1:0, (1<<5)|13); }
  async function resetBuffer(){
    await setMode(0);
    await dev.clearHalt('in', epIn).catch(()=>{});
    conv.reset();
    await setMode(1); rxOn=true;
  }
  // nBytes IQ int16 = столько же байт сырых uint16 (два вещественных на комплексный)
  async function readSamples(nBytes){
    const res=await dev.transferIn(1, nBytes);
    const buf=res.data.buffer, len=res.data.byteLength>>1;
    conv.process(new Uint16Array(buf, res.data.byteOffset, len), new Int16Array(buf, res.data.byteOffset, len));
    return buf;
  }
  async function close(){
    if(rxOn) await setMode(0).catch(()=>{});
    await dev.releaseInterface(0).catch(()=>{});
    await dev.close();
  }
  await setGain(gain);
  return {setSampleRate, setCenterFrequency, setGain, setBiasTee, resetBuffer, readSamples, close,
    tunerName:rates.includes(6000000)?'Airspy Mini':'Airspy', kind:'airspy', fmt:'s16', bps:4, epoch:()=>tuneEpoch};
}

// SDRplay RSP1 и донглы на Mirics MSi2500 + MSi001. Протокол — по libmirisdr-4 (Slugen, SM5BSZ).
// Поток — блоки по 1024 байта: 16 байт заголовка + отсчёты в одном из 4 форматов, формат зависит
// от частоты дискретизации. Переводим в int16 IQ. На Linux: rmmod msi001 msi2500
function mirisdrMakeConv(){
  // отсчётов IQ на 1024-байтный блок по формату
  const SPB={252:252, 336:336, 384:384, 504:504};
  const v8=new Int16Array(8);
  let fmt=252, carry=new Uint8Array(0);
  function block(s, o, dst, w){
    if(fmt===252){
      for(let j=o+16;j<o+1024;j+=2,w++) dst[w]=(s[j]<<2)|(s[j+1]<<10);
    }else if(fmt===336){
      for(let j=o+16;j<o+1024;j+=3,w+=2){
        dst[w]=(s[j]<<4)|((s[j+1]&0x0f)<<12);
        dst[w+1]=(s[j+1]&0xf0)|(s[j+2]<<8);
      }
    }else if(fmt===384){
      // 6 групп по 164 байта: 16×10 байт (8 отсчётов по 10 бит) + 4 байта сдвигов
      let p=o+16;
      for(let g=0;g<6;g++,p+=4){
        const sh=s[p+160]|(s[p+161]<<8)|(s[p+162]<<16)|(s[p+163]<<24);
        for(let k=0;k<16;k++,p+=10,w+=8){
          const d=2-Math.min(2, (sh>>>(2*k))&3);
          v8[0]=(s[p]<<6)|((s[p+1]&0x03)<<14); v8[1]=((s[p+1]&0xfc)<<4)|((s[p+2]&0x0f)<<12);
          v8[2]=((s[p+2]&0xf0)<<2)|((s[p+3]&0x3f)<<10); v8[3]=(s[p+3]&0xc0)|(s[p+4]<<8);
          v8[4]=(s[p+5]<<6)|((s[p+6]&0x03)<<14); v8[5]=((s[p+6]&0xfc)<<4)|((s[p+7]&0x0f)<<12);
          v8[6]=((s[p+7]&0xf0)<<2)|((s[p+8]&0x3f)<<10); v8[7]=(s[p+8]&0xc0)|(s[p+9]<<8);
          for(let i=0;i<8;i++) dst[w+i]=v8[i]>>d;
        }
      }
    }else{
      for(let j=o+16;j<o+1024;j++,w++) dst[w]=s[j]<<8;
    }
  }
  return {
    get spb(){ return SPB[fmt]; },
    setFormat(f){ fmt=f; carry=new Uint8Array(0); },
    reset(){ carry=new Uint8Array(0); },
    // сырые байты → Int16Array IQ; неполный блок ждёт следующего чтения
    process(u8){
      let s=u8;
      if(carry.length){ s=new Uint8Array(carry.length+u8.length); s.set(carry); s.set(u8, carry.length); }
      const nb=s.length>>10, out=new Int16Array(nb*2*SPB[fmt]);
      for(let b=0;b<nb;b++) block(s, b<<10, out, b*2*SPB[fmt]);
      carry=s.slice(nb<<10);
      return out;
    }
  };
}
async function mirisdrOpenDevice(dev, gain){
  const CMD={WREG:0x41, START:0x43, STOP:0x45};
  // план диапазонов: от МГц, режим MSi001, повышающий смеситель, AM-порт, делитель LO, слово reg8 (GPIO фильтров)
  const PLAN=[
    [0,1,1,1,16,0xf780],[12,1,1,1,16,0xff80],[30,1,1,1,16,0xf280],[50,2,0,0,32,0xf380],
    [108,4,0,0,16,0xfa80],[250,4,0,0,16,0xf680],[259,6,0,0,8,0xf680],[330,8,0,0,4,0xf380],[960,16,0,0,2,0xfa80]];
  const BW=[200000,300000,600000,1536000,5000000,6000000,7000000,8000000];
  await dev.open();
  if(!dev.configuration) await dev.selectConfiguration(1);
  // alt 3 с bulk на EP1 у RSP1/MSi2500; у остальных ищем bulk IN по дескрипторам всех конфигураций
  const bulkIn=al=>al.endpoints.find(e=>e.type==='bulk' && e.direction==='in');
  const cfgs=[dev.configuration, ...dev.configurations.filter(c=>c.configurationValue!==dev.configuration.configurationValue)];
  let found=null;
  for(const cfg of cfgs){
    for(const i of cfg.interfaces){
      const al=i.alternates.find(a=>a.alternateSetting===3 && bulkIn(a)) || i.alternates.find(bulkIn);
      if(al){ found={cfg:cfg.configurationValue, itf:i.interfaceNumber, alt:al.alternateSetting, ep:bulkIn(al).endpointNumber}; break; }
    }
    if(found) break;
  }
  if(!found) throw new Error('no streaming endpoint (the browser sees no alternate settings; Android Chrome, or a full-speed USB port/hub — try a direct OTG cable or a desktop); '+JSON.stringify(dev.configurations.map(c=>({cfg:c.configurationValue,
    itf:c.interfaces.map(i=>({n:i.interfaceNumber, alts:i.alternates.map(a=>({alt:a.alternateSetting, ep:a.endpoints.map(e=>e.type+' '+e.direction+e.endpointNumber)}))}))}))));
  if(found.cfg!==dev.configuration.configurationValue) await dev.selectConfiguration(found.cfg);
  const itf=found.itf, epIn=found.ep;
  await dev.claimInterface(itf);
  const wreg=(reg,val)=>sdrVendorOut(dev, CMD.WREG, ((val&0xff)<<8)|reg, (val>>>8)&0xffff);
  const conv=mirisdrMakeConv();
  let tuneEpoch=0, rxOn=false, freq=100000000, rate=2000000, bwIdx=7, band='vhf', reg8=0xf380, bias=false;
  let gr={lna:0, mixbuf:0, mixer:0, bb:59};

  // частота дискретизации и формат пакетов (mirisdr_set_hard)
  async function hard(){
    const fmt=rate<=6048000 ? 252 : rate<=8064000 ? 336 : rate<=9216000 ? 384 : 504;
    await wreg(0x07, {252:0x000094, 336:0x000085, 384:0x0000a5, 504:0x000c94}[fmt]);
    conv.setFormat(fmt);
    let i=4, vco=0;
    for(;i<16;i+=2){ vco=rate*i*12; if(vco>=202000000) break; }
    const n=Math.floor(vco/48000000), fract=Math.floor(0x200000*(vco%48000000)/48000000);
    const reg3=3 | (((i/2-1)&7)<<2) | (((fract>>20)&1)<<7) | ((n&0xf)<<8) |
      ({252:1, 336:5, 384:9, 504:0xd}[fmt]<<12) | (1<<16);
    await wreg(0x04, fract&0xfffff);
    await wreg(0x03, reg3);
  }
  // синтезатор MSi001, полоса ПЧ-фильтра, переключатели диапазонов (mirisdr_set_soft)
  async function soft(){
    let k=0; while(k+1<PLAN.length && freq>=PLAN[k+1][0]*1e6) k++;
    const [, mode, up, port, div, word]=PLAN[k];
    let reg0=(mode<<4) | (1<<10) | (3<<12) | (bwIdx<<14) | (2<<17), offset=0n, loDiv=BigInt(div);
    if(mode===1){
      reg0|=(up<<9)|(port<<11);
      if(up) offset=120000000n;
      loDiv=16n; band=port ? 'am2' : 'am1';
    }else band={2:'vhf',4:'b3',6:'b3',8:'b45',16:'bl'}[mode];
    const F=BigInt(Math.round(freq))+offset, R=96000000n;
    const fvco=F*loDiv, n=fvco/R;
    let thresh=R/loDiv, frac=(fvco%R)/loDiv, a=thresh, b=frac;
    while(a!==0n){ const c=a; a=b%a; b=c; }
    thresh/=b; frac/=b;
    a=(thresh+4094n)/4095n;
    thresh=(thresh+a/2n)/a; frac=(frac+a/2n)/a;
    let rfvco=(R*(n*thresh*4096n+frac*4096n))/(thresh*4096n*loDiv);
    if(F<rfvco && frac>0n) frac--;
    rfvco=(R*(n*thresh*4096n+frac*4096n))/(thresh*4096n*loDiv);
    const afc=Number(((F-rfvco)*thresh*4096n*loDiv)/R);
    reg8=word;
    await wreg(0x08, reg8|(bias?1<<11:0));
    await wreg(0x09, 0x0e);
    await wreg(0x09, 3|((afc&4095)<<4));
    await wreg(0x09, reg0);
    await wreg(0x09, 5|(Number(thresh&0xfffn)<<4)|(0x28<<16));
    await wreg(0x09, 2|(Number(frac&0xfffn)<<4)|(Number(n&0x3fn)<<16));
  }
  // усиление: снижение LNA (24 дБ), смесителя (19 дБ), baseband 0-59 дБ; на AM-входах вместо LNA mixbuffer
  async function writeGain(){
    let reg1=1|(gr.bb<<4);
    if(band==='am1') reg1|=(gr.mixbuf&3)<<10;
    else if(band==='am2') reg1|=(gr.mixbuf?3:0)<<10;
    reg1|=gr.mixer<<12;
    if(band!=='am1' && band!=='am2') reg1|=gr.lna<<13;
    reg1|=2<<14;                                     // периодическая DC-калибровка
    await wreg(0x09, reg1);
    await wreg(0x09, 6|(0x1f<<4)|(0x800<<10));
  }
  // общий 0..102 дБ, как mirisdr_set_tuner_gain
  function splitGain(g){
    g=Math.max(0, Math.min(102, Math.round(g)));
    if(g>=43) gr={lna:0, mixbuf:0, mixer:0, bb:59-(g-43)};
    else if(g>=19) gr={lna:1, mixbuf:3, mixer:0, bb:59-(g-19)};
    else gr={lna:1, mixbuf:3, mixer:1, bb:59-g};
  }
  const stream=on=>sdrVendorOut(dev, on?CMD.START:CMD.STOP, 0, 0);

  async function setSampleRate(r){
    rate=Math.round(Math.max(1300000, Math.min(15000000, r)));
    // фильтр ПЧ — наименьший не уже 0.75·rate
    bwIdx=BW.findIndex(b=>b>=0.75*rate); if(bwIdx<0) bwIdx=BW.length-1;
    if(rxOn) await stream(false);
    await hard();
    await soft(); await writeGain();
    if(rxOn){ conv.reset(); await stream(true); }
    return rate;
  }
  async function setCenterFrequency(f){
    freq=Math.round(f);
    await soft(); await writeGain();
    tuneEpoch++;
    return freq;
  }
  // АРУ нет: auto — 62 дБ, как режим auto в libmirisdr. Ручной gain 0..49.6 растягиваем на 0..102
  async function setGain(g){
    splitGain(g==null ? 62 : g/49.6*102);
    await writeGain();
  }
  async function setBiasTee(on){ bias=!!on; await wreg(0x08, reg8|(bias?1<<11:0)); }
  async function resetBuffer(){
    await stream(false);
    await dev.clearHalt('in', epIn).catch(()=>{});
    conv.reset();
    await stream(true); rxOn=true;
  }
  // nBytes IQ int16 → целые блоки по 1024 сырых байта; вернуть может чуть больше или меньше
  async function readSamples(nBytes){
    const res=await dev.transferIn(epIn, Math.max(1, Math.ceil(nBytes/4/conv.spb))*1024);
    return conv.process(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength)).buffer;
  }
  async function close(){
    if(rxOn) await stream(false).catch(()=>{});
    await wreg(0x03, 0x010000).catch(()=>{});      // усыпить ADC
    await dev.releaseInterface(itf).catch(()=>{});
    await dev.close();
  }
  // стоп потока и ADC, мог остаться от прошлого сеанса
  await stream(false).catch(()=>{});
  await wreg(0x03, 0x010000);
  await dev.selectAlternateInterface(itf, found.alt);
  // инициализация ADC (как драйвер ядра)
  await wreg(0x08, 0x006080); await wreg(0x05, 0x00000c); await wreg(0x00, 0x000200);
  await wreg(0x02, 0x004801); await wreg(0x08, 0x00f380);
  await setSampleRate(rate);
  await setGain(gain);
  return {setSampleRate, setCenterFrequency, setGain, setBiasTee, resetBuffer, readSamples, close,
    tunerName:dev.productName||'MSi2500', kind:'miri', fmt:'s16', bps:4, epoch:()=>tuneEpoch};
}

// RX-888 (и прочие SDDC на Cypress FX3): 16-битный АЦП без тюнера на КВ, R8xx/RDA5815 — на УКВ.
// Протокол и прошивка — ExtIO_sddc (ik1xpv, MIT). После включения устройство — загрузчик FX3
// 04b4:00f3, после заливки vendor/SDDC_FX3.img переподключается как 04b4:00f1.
const RX888_BOOT=[0x04b4,0x00f3], RX888_APP=[0x04b4,0x00f1];
const RX888_FW_URL='vendor/SDDC_FX3.img';
const rx888Is=(d,id)=>d.vendorId===id[0] && d.productId===id[1];
// заливка прошивки в RAM через загрузчик FX3 (как fx3_load_ram в libsddc)
async function rx888LoadFirmware(dev){
  const resp=await fetch(RX888_FW_URL);
  if(!resp.ok) throw new Error('firmware '+RX888_FW_URL+': HTTP '+resp.status);
  const buf=await resp.arrayBuffer(), img=new DataView(buf);
  if(img.getUint8(0)!==0x43 || img.getUint8(1)!==0x59 || img.getUint8(3)!==0xb0) throw new Error('bad FX3 firmware image');
  await dev.open();
  try{ if(!dev.configuration) await dev.selectConfiguration(1); }catch(e){}
  try{ await dev.claimInterface(0); }catch(e){}
  const wr=(addr, data)=>dev.controlTransferOut({requestType:'vendor',recipient:'device',request:0xa0,value:addr&0xffff,index:addr>>>16}, data);
  let o=4, sum=0, entry;
  for(;;){
    const len=img.getUint32(o,true), addr=img.getUint32(o+4,true); o+=8;
    if(!len){ entry=addr; break; }
    for(let i=0;i<len;i++) sum=(sum+img.getUint32(o+4*i,true))>>>0;
    const bytes=new Uint8Array(buf, o, len*4);
    for(let p=0;p<bytes.length;p+=4096){
      const part=bytes.slice(p, p+4096), r=await wr(addr+p, part);
      if(r.status!=='ok' || r.bytesWritten!==part.length) throw new Error('firmware write failed at 0x'+(addr+p).toString(16));
    }
    o+=len*4;
  }
  if(img.getUint32(o,true)!==sum) throw new Error('firmware checksum mismatch');
  await wr(entry).catch(()=>{});                   // переход на точку входа, загрузчик отваливается
  await dev.close().catch(()=>{});
}
// после заливки: ждём новое устройство среди разрешённых, иначе — новое окно выбора
async function rx888Boot(n, dev){
  n.status='RX-888: loading firmware…';
  await rx888LoadFirmware(dev);
  for(let t=0;t<30;t++){
    await new Promise(r=>setTimeout(r,200));
    const d=(await navigator.usb.getDevices()).find(d=>rx888Is(d,RX888_APP));
    if(d) return d;
  }
  try{ return await navigator.usb.requestDevice({filters:[{vendorId:RX888_APP[0],productId:RX888_APP[1]}]}); }
  catch(e){ throw new Error('RX-888 firmware loaded: press Connect again and pick the device'); }
}

// Вещественные отсчёты АЦП → комплексный IQ: NCO по таблице (центр округляется до fs/65536),
// затем k полуполосных ФНЧ с прореживанием на 2. Порядок ступени — по Кайзеру на 80 дБ: полоса
// ±0.4 выходной частоты, чем дальше от выхода, тем фильтр короче. Чанк считается независимо:
// перед ним — хвост прошлого (hist отсчётов), выходы от хвоста отбрасываются. Поэтому чанки
// можно раздавать нескольким воркерам, а результат совпадает с непрерывной обработкой.
function rx888DdcKernel(){
  const TL=65536, tab=new Float32Array(2*TL);
  for(let i=0;i<TL;i++){ tab[2*i]=Math.cos(2*Math.PI*i/TL); tab[2*i+1]=Math.sin(2*Math.PI*i/TL); }
  const i0=x=>{ let s=1, t=1; for(let k=1;k<30;k++){ t*=(x/(2*k))*(x/(2*k)); s+=t; } return s; };
  function halfband(q){                            // q — отношение входной частоты ступени к выходной
    const A=80, beta=0.1102*(A-8.7), dw=2*Math.PI*(0.5-0.8/q);
    let M=Math.ceil((A-8)/(2.285*dw)/2); if(!(M&1)) M++;
    const K=(M+1)>>1, h=new Float32Array(K);
    let sum=0;
    for(let t=0;t<K;t++){ const j=2*t+1, r=j/(M+1); h[t]=Math.sin(Math.PI*j/2)/(Math.PI*j)*i0(beta*Math.sqrt(1-r*r))/i0(beta); sum+=2*h[t]; }
    for(let t=0;t<K;t++) h[t]*=0.5/sum;             // усиление на нуле = 1
    return {h, M};
  }
  // b — комплексные (I,Q подряд) n отсчётов; выход m — центр на входе 2m+1-M, первые M выходов — нули
  function run(st, b, n, o){
    const h=st.h, K=h.length, M=st.M;
    o.fill(0, 0, 2*M);
    for(let e=2*M+1, w=2*M; e<n; e+=2, w+=2){
      const c=2*(e-M);
      let sr=0.5*b[c], si=0.5*b[c+1];
      for(let t=0, j=2;t<K;t++, j+=4){ const g=h[t]; sr+=g*(b[c-j]+b[c+j]); si+=g*(b[c-j+1]+b[c+j+1]); }
      o[w]=sr; o[w+1]=si;
    }
    return n>>1;
  }
  let bufs=[];
  const buf=(i,len)=>bufs[i]&&bufs[i].length>=len ? bufs[i] : (bufs[i]=new Float32Array(len));
  return {
    TL,
    // hist — сколько отсчётов истории нужно, чтобы выходы после неё были точными (кратно 2^k)
    design(k){
      const st=[]; let v=0;
      for(let i=0;i<k;i++){ const s=halfband(2**(k-i)); st.push(s); v=Math.ceil((v+2*s.M-1)/2); }
      return {k, st, skip:v, hist:v*2**k};
    },
    // raw — Int16Array, длина кратна 2^k; p0 — фаза NCO первого отсчёта; выход — Int16Array IQ новых отсчётов
    run(cfg, raw, p0, step, inv){
      let n=raw.length, b=buf(0, 2*n), p=p0;
      for(let i=0;i<n;i++){ const x=raw[i]; b[2*i]=x*tab[2*p]; b[2*i+1]=-x*tab[2*p+1]; p=(p+step)&(TL-1); }
      for(let i=0;i<cfg.k;i++){ const o=buf(1+(i&1), n); n=run(cfg.st[i], b, n, o); b=o; }
      const m=n-cfg.skip, out=new Int16Array(2*m), sq=inv ? -2 : 2;   // ×2: вещественный тон полной шкалы → комплексный полной шкалы
      for(let i=0, j=2*cfg.skip;i<m;i++, j+=2){
        const a=b[j]*2, q=b[j+1]*sq;
        out[2*i]=a>32767 ? 32767 : a<-32768 ? -32768 : Math.round(a);
        out[2*i+1]=q>32767 ? 32767 : q<-32768 ? -32768 : Math.round(q);
      }
      return out;
    }
  };
}
// пул воркеров DDC; без Worker — считаем на месте
function rx888DdcPool(){
  const ker=rx888DdcKernel();
  const W=typeof Worker==='undefined' ? 0 : Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency||4)-2));
  const src=`${rx888DdcKernel}
const ker=rx888DdcKernel(); let cfg=null;
onmessage=e=>{ const m=e.data;
  if(m.k!=null){ cfg=ker.design(m.k); return; }
  const out=ker.run(cfg, m.raw, m.p0, m.step, m.inv); postMessage({id:m.id, buf:out.buffer}, [out.buffer]); };`;
  const url=W ? URL.createObjectURL(new Blob([src], {type:'application/javascript'})) : null;
  const pend=new Map(), ws=[];
  for(let i=0;i<W;i++){
    const w=new Worker(url);
    w.onmessage=e=>{ const r=pend.get(e.data.id); pend.delete(e.data.id); r?.(e.data.buf); };
    ws.push(w);
  }
  let cfg=null, seq=0;
  return {
    TL:ker.TL,
    setup(k){ cfg=ker.design(k); for(const w of ws) w.postMessage({k}); return cfg; },
    run(raw, p0, step, inv){
      if(!W) return Promise.resolve(ker.run(cfg, raw, p0, step, inv).buffer);
      const id=++seq;
      return new Promise(r=>{ pend.set(id, r); ws[id%W].postMessage({id, raw, p0, step, inv}, [raw.buffer]); });
    },
    close(){ for(const w of ws) w.terminate(); if(url) URL.revokeObjectURL(url); for(const r of pend.values()) r(new ArrayBuffer(0)); pend.clear(); }
  };
}
async function rx888OpenDevice(dev, gain){
  const CMD={START:0xaa, STOP:0xab, TEST:0xac, GPIO:0xad, STARTADC:0xb2, TUNERINIT:0xb4, TUNERTUNE:0xb5, SETARG:0xb6, TUNERSTDBY:0xb8};
  const ARG={R82XX_ATT:1, R82XX_VGA:2, DAT31_ATT:10, AD8340_VGA:11, PRESELECTOR:12};
  const G={SHDWN:1<<5, BIAS_HF:1<<8, BIAS_VHF:1<<9, ATT_SEL0:1<<13, ATT_SEL1:1<<14, VHF_EN:1<<15};
  // модели прошивки: 1 BBRF103, 2 HF103, 3 RX888, 4 RX888r2, 7 RX888r3
  const NAMES={1:'BBRF103', 2:'HF103', 3:'RX888', 4:'RX888 mkII', 7:'RX888 mkIII'};
  // ступени R82xx (дБ), индекс — аргумент R82XX_ATTENUATOR
  const R82_STEPS=[0,0.9,1.4,2.7,3.7,7.7,8.7,12.5,14.4,15.7,16.6,19.7,20.7,22.9,25.4,28,29.7,32.8,33.8,36.4,37.2,38.6,40.2,42.1,43.4,43.9,44.5,48,49.6];
  // трансфер — кратно DMA-буферу FX3 (16 КБ); по USB 2 больше ~40 МБ/с не пролезет
  const XFER=16384, ADC_MAX=dev.usbVersionMajor>=3 ? 66e6 : 16e6;
  await dev.open();
  if(!dev.configuration) await dev.selectConfiguration(1);
  await dev.claimInterface(0);
  const u32=v=>{ const b=new DataView(new ArrayBuffer(4)); b.setUint32(0,v>>>0,true); return b.buffer; };
  const u64=v=>{ const b=new DataView(new ArrayBuffer(8)); b.setBigUint64(0,BigInt(Math.round(v)),true); return b.buffer; };
  const ctl=(cmd,data)=>sdrVendorOut(dev, cmd, 0, 0, data??u32(0));
  const arg=(idx,val)=>sdrVendorOut(dev, CMD.SETARG, val, idx, new Uint8Array(1));
  const info=await sdrVendorIn(dev, CMD.TEST, 0, 4);
  const model=info.data.getUint8(0), fw=info.data.getUint8(1)+'.'+info.data.getUint8(2);
  if(!NAMES[model]) throw new Error('SDDC: unsupported or unknown hardware (model '+model+')');
  const r2=model===4, r3=model===7, mk1=model===1 || model===3, hasVhf=model!==2;
  const ddc=rx888DdcPool();
  let cfg=null, tail=new Int16Array(0), cnt=0, step=0, inv=false;
  // сдвиг вниз на f; возвращает фактическую частоту NCO
  const nco=(f, invert)=>{ step=((Math.round(f/fs*ddc.TL)%ddc.TL)+ddc.TL)%ddc.TL; inv=invert; return step*fs/ddc.TL; };
  let gpios=0, mode=null, fs=0, k=1, freq=0, gainDb=gain, bias=false, tuneEpoch=0, rxOn=false;
  const setGpio=()=>{
    let g=gpios&~(G.BIAS_HF|G.BIAS_VHF);
    if(bias) g|=mode==='vhf' ? G.BIAS_VHF : G.BIAS_HF;
    return ctl(CMD.GPIO, u32(g));
  };
  await ctl(CMD.STOP);

  async function applyGain(){
    const g=gainDb;
    if(mode==='vhf'){
      if(r3) return;                               // RDA5815: усиление прошивка не задаёт
      let idx=14;                                  // auto — середина шкалы R82xx
      if(g!=null){ idx=0; for(let i=1;i<R82_STEPS.length;i++) if(Math.abs(R82_STEPS[i]-g)<Math.abs(R82_STEPS[idx]-g)) idx=i; }
      await arg(ARG.R82XX_ATT, idx);
      await arg(ARG.R82XX_VGA, 8);
      return;
    }
    if(mk1){
      // аттенюатор -20/-10/0 дБ переключателями ATT_SEL
      const a=g==null ? 0 : g<10 ? -20 : g<20 ? -10 : 0;
      gpios&=~(G.ATT_SEL0|G.ATT_SEL1);
      gpios|=a===-20 ? G.ATT_SEL0 : a===-10 ? G.ATT_SEL0|G.ATT_SEL1 : G.ATT_SEL1;
      await setGpio();
      return;
    }
    // шкала 0..49.6: сначала снимается аттенюатор (-31.5..0 дБ), дальше растёт VGA AD8370
    const att=g==null ? 0 : Math.max(0, 31.5-g), vgaDb=g==null ? 10 : Math.max(0, g-31.5);
    await arg(ARG.DAT31_ATT, Math.round(att*2));
    if(r2 || r3){
      const v=Math.max(1, Math.min(127, Math.round(Math.pow(10, vgaDb/20)/0.409)));
      await arg(ARG.AD8340_VGA, 0x80|v);
    }
  }
  async function setMode(m){
    if(m===mode) return;
    mode=m;
    if(m==='vhf'){
      if(mk1){ gpios&=~(G.ATT_SEL0|G.ATT_SEL1); await setGpio(); await ctl(CMD.TUNERINIT, u32(32000000)); }
      else{
        await arg(ARG.DAT31_ATT, 63);              // КВ-вход — максимальное ослабление
        gpios|=G.VHF_EN; await setGpio();
        await arg(ARG.AD8340_VGA, 0x80|3);
        await ctl(CMD.TUNERINIT, u32(r3 ? 27000000 : 16000000));
      }
    } else {
      if(hasVhf) await ctl(CMD.TUNERSTDBY);
      if(mk1) gpios|=G.ATT_SEL0|G.ATT_SEL1; else gpios&=~G.VHF_EN;
      await setGpio();
    }
    await applyGain();
  }
  // КВ — всё ниже fs/2 напрямую с АЦП, выше — через тюнер; ПЧ тюнера инвертирована
  async function tune(f){
    if(f<fs/2 || !hasVhf){
      if(f>=fs/2) throw new Error('frequency above ADC Nyquist ('+(fs/2e6).toFixed(1)+' MHz)');
      await setMode('hf');
      if(r3) await arg(ARG.PRESELECTOR, fs<32e6 ? 0b101 : 0b011);
      return nco(f, false);
    }
    if(r3 && f<220e6) throw new Error('RX888 mkIII: '+(fs/2e6).toFixed(1)+'–220 MHz not covered');
    await setMode('vhf');
    let ifHz;
    if(r3){
      const vco=f+20e6, mhz=Math.floor(vco/1e6);
      await ctl(CMD.TUNERTUNE, u32(mhz));
      ifHz=20e6-(vco-mhz*1e6);
    } else {
      await ctl(CMD.TUNERTUNE, u64(f));
      ifHz=4570000;
    }
    return f+ifHz-nco(ifHz, true);
  }

  // частота АЦП — rate·2^k, не выше ADC_MAX
  async function setSampleRate(rate){
    rate=Math.round(Math.max(250000, Math.min(ADC_MAX/2, rate)));
    k=1; while(rate*2**(k+1)<=ADC_MAX) k++;
    const f=rate*2**k;
    if(f!==fs){ fs=f; await ctl(CMD.STARTADC, u32(fs)); }
    if(cfg?.k!==k){ cfg=ddc.setup(k); tail=new Int16Array(cfg.hist); }
    if(freq) await tune(freq);
    tuneEpoch++;
    return rate;
  }
  async function setCenterFrequency(f){
    freq=Math.round(f);
    const act=Math.round(await tune(freq));
    tuneEpoch++;
    return act;
  }
  async function setGain(g){ gainDb=g; if(mode) await applyGain(); }
  async function setBiasTee(on){ bias=!!on; await setGpio(); }
  async function resetBuffer(){
    await ctl(CMD.STOP);
    await dev.clearHalt('in', 1).catch(()=>{});
    tail.fill(0);
    await ctl(CMD.START); rxOn=true;
  }
  // nBytes IQ int16 → сырых байт в 2^k/2 раз больше; трансфер не больше 1 МБ, отдаёт сколько вышло
  async function readSamples(nBytes){
    const raw=Math.min(1<<20, Math.max(XFER, Math.ceil(nBytes/4*2**k*2/XFER)*XFER));
    const res=await dev.transferIn(1, raw);
    // чанк DDC: хвост прошлого + новые отсчёты (целое число выходных); фаза NCO — от номера отсчёта
    const D=2**k, got=res.data.byteLength>>1, n=got-got%D, H=tail.length;
    const inp=new Int16Array(H+n);
    inp.set(tail); inp.set(new Int16Array(res.data.buffer, res.data.byteOffset, n), H);
    tail=inp.slice(n);
    const p0=(((cnt-H)%ddc.TL+ddc.TL)%ddc.TL*step)%ddc.TL;
    cnt=(cnt+n)%ddc.TL;
    return ddc.run(inp, p0, step, inv);
  }
  async function close(){
    if(rxOn) await ctl(CMD.STOP).catch(()=>{});
    if(mode==='vhf') await ctl(CMD.TUNERSTDBY).catch(()=>{});
    gpios|=G.SHDWN; bias=false; await setGpio().catch(()=>{});   // АЦП в сон
    ddc.close();
    await dev.releaseInterface(0).catch(()=>{});
    await dev.close();
  }
  return {setSampleRate, setCenterFrequency, setGain, setBiasTee, resetBuffer, readSamples, close,
    tunerName:NAMES[model]+' fw '+fw, kind:'sddc', fmt:'s16', bps:4, epoch:()=>tuneEpoch};
}

// MSi2500: SDRplay RSP1 (2500/3000), RSP2 (3010), RSP1A (3020) — последние два не проверены, ТВ-донглы Hauppauge/AverMedia/IO-DATA/Logitec
const MIRI_USB_IDS=[[0x1df7,0x2500],[0x1df7,0x3000],[0x1df7,0x3010],[0x1df7,0x3020],[0x2040,0xd300],[0x07ca,0x8591],[0x04bb,0x0537],[0x0511,0x0037]];
// VID:PID поддерживаемых устройств
const SDR_USB_FILTERS=[
  {vendorId:0x0bda,productId:0x2832},{vendorId:0x0bda,productId:0x2838},
  {vendorId:0x15f4,productId:0x0131},                          // Astrometa DVB-T2
  {vendorId:0x1d50,productId:0x6089},{vendorId:0x1d50,productId:0x604b},{vendorId:0x1d50,productId:0xcc15}, // HackRF One, Jawbreaker, rad1o
  {vendorId:0x1d50,productId:0x60a1},                          // Airspy R2/Mini
  {vendorId:0x04b4,productId:0x00f3},{vendorId:0x04b4,productId:0x00f1}, // RX-888 / SDDC: загрузчик FX3, с прошивкой
  ...MIRI_USB_IDS.map(([vendorId,productId])=>({vendorId,productId}))
];
function sdrOpenDevice(dev, ppm, gain){
  if(MIRI_USB_IDS.some(([v,p])=>v===dev.vendorId && p===dev.productId)) return mirisdrOpenDevice(dev, gain);
  if(rx888Is(dev, RX888_APP)) return rx888OpenDevice(dev, gain);
  if(dev.vendorId===0x1d50) return dev.productId===0x60a1 ? airspyOpenDevice(dev, gain) : hackrfOpenDevice(dev, gain);
  return rtlOpenDevice(dev, ppm, gain);
}

// ---- чтение USB в отдельном воркере ----
// Драйвер целиком (регистры, тюнер, очередь transferIn) живёт в dedicated worker: подвисания главного
// потока (GC, отрисовка, граф) больше не задерживают перезапуск трансферов — чанки просто копятся
// в очереди сообщений. Главный поток видит прокси с тем же интерфейсом, что у rtlOpenDevice.
// Доступ к устройству воркер получает через getDevices() — разрешение уже выдано requestDevice().
const RTL_USB_WORKER_SRC = `
const RTL_CMD=${JSON.stringify(RTL_CMD)}, RTL_BLOCK=${JSON.stringify(RTL_BLOCK)}, RTL_REG=${JSON.stringify(RTL_REG)};
const R82XX_LNA_STEPS=${JSON.stringify(R82XX_LNA_STEPS)}, R82XX_MIX_STEPS=${JSON.stringify(R82XX_MIX_STEPS)};
${r82xxGainSteps}
${rtlNumToBuf}
${rtlBufToNum}
${rtlMakeCom}
${rtlMakeR820T}
rtlMakeR820T.checkAt=${rtlMakeR820T.checkAt};
rtlMakeR820T.detect=${rtlMakeR820T.detect};
${rtlOpenDevice}
${sdrVendorIn}
${sdrVendorOut}
${hackrfOpenDevice}
${airspyMakeConv}
${airspyOpenDevice}
${mirisdrMakeConv}
${mirisdrOpenDevice}
const MIRI_USB_IDS=${JSON.stringify(MIRI_USB_IDS)};
const RX888_APP=${JSON.stringify(RX888_APP)};
const rx888Is=${rx888Is};
${rx888DdcKernel}
${rx888DdcPool}
${rx888OpenDevice}
${sdrOpenDevice}
let usb=null, api=null, rate=1024000, streaming=false, rps=40;
async function stream(readsPerSec, depth){
  const q=[]; rps=readsPerSec;
  const chunk=()=>Math.max(512, Math.min(131072, 512*Math.ceil(rate/rps/512)));
  const fill=()=>{ while(streaming && api && q.length<depth){ const e=api.epoch(); q.push(api.readSamples(chunk()*api.bps).then(b=>({b,e}), err=>({err}))); } };
  fill();
  while(streaming && q.length){
    const p=q.shift(); fill();
    const r=await p;
    if(!streaming) break;
    if(r.err){
      self.postMessage({type:'chunk', err:r.err.message});
      while(q.length) await q.shift();       // остаток очереди после сбоя не нужен
      try{ await api.resetBuffer(); }catch(e){}
      await new Promise(s=>setTimeout(s,50));
      fill();
      continue;
    }
    self.postMessage({type:'chunk', buf:r.b, epoch:r.e}, [r.b]);
  }
  while(q.length) await q.shift();
}
self.onmessage=async e=>{
  const {id, cmd, args}=e.data;
  try{
    let r;
    if(cmd==='probe') r=!!(self.navigator && navigator.usb && navigator.usb.getDevices);
    else if(cmd==='open'){
      const devs=await navigator.usb.getDevices();
      usb=devs.find(d=>d.vendorId===args.vendorId && d.productId===args.productId && (!args.serial || d.serialNumber===args.serial));
      if(!usb) throw new Error('device is not visible from the worker');
      try{ api=await sdrOpenDevice(usb, 0, args.gain); }
      catch(err){ try{ await usb.close(); }catch(e2){} usb=null; throw err; }
      r={tunerName:api.tunerName, kind:api.kind, fmt:api.fmt, bps:api.bps};
    }
    else if(cmd==='setSampleRate'){ rate=await api.setSampleRate(args.rate); r=rate; }
    else if(cmd==='setCenterFrequency'){ const f=await api.setCenterFrequency(args.freq); r={f, epoch:api.epoch()}; }
    else if(cmd==='setGain') await api.setGain(args.gain);
    else if(cmd==='dev') r=await api[args.m](...args.a);
    else if(cmd==='resetBuffer') await api.resetBuffer();
    else if(cmd==='start'){ if(!streaming){ streaming=true; stream(args.readsPerSec, args.depth); } }
    else if(cmd==='readRate') rps=args.readsPerSec;
    else if(cmd==='stop') streaming=false;
    else if(cmd==='close'){ streaming=false; if(api){ const a=api; api=null; await a.close(); } }
    self.postMessage({id, ok:true, r});
  }catch(err){ self.postMessage({id, ok:false, err:err.message}); }
};
`;

// null — WebUSB в воркере недоступен (старый браузер), тогда вызывающий открывает донгл сам
async function rtlOpenInWorker(usbDev, gain){
  if(typeof Worker==='undefined') return null;
  const url=URL.createObjectURL(new Blob([RTL_USB_WORKER_SRC], {type:'application/javascript'}));
  const w=new Worker(url);
  let seq=1, onChunk=null, epoch=0;
  const pend=new Map();
  w.onmessage=e=>{
    const m=e.data;
    if(m.type==='chunk'){ onChunk?.(m); return; }
    const p=pend.get(m.id); if(!p) return;
    pend.delete(m.id); m.ok ? p.res(m.r) : p.rej(new Error(m.err));
  };
  const call=(cmd,args)=>new Promise((res,rej)=>{ const id=seq++; pend.set(id,{res,rej}); w.postMessage({id,cmd,args}); });
  const drop=()=>{ w.terminate(); URL.revokeObjectURL(url); };
  let info;
  try{
    if(!await call('probe')){ drop(); return null; }
    info=await call('open', {vendorId:usbDev.vendorId, productId:usbDev.productId, serial:usbDev.serialNumber, gain});
  }catch(e){ drop(); throw e; }
  return {
    worker:true, tunerName:info.tunerName, kind:info.kind, fmt:info.fmt, bps:info.bps,
    setSampleRate:rate=>call('setSampleRate',{rate}),
    setCenterFrequency:async freq=>{ const r=await call('setCenterFrequency',{freq}); epoch=r.epoch; return r.f; },
    epoch:()=>epoch,
    setGain:gain=>call('setGain',{gain}),
    setBiasTee:on=>call('dev',{m:'setBiasTee',a:[on]}),
    setHackrfGain:(lna,vga,amp)=>call('dev',{m:'setHackrfGain',a:[lna,vga,amp]}),
    setTxGain:(vga,amp)=>call('dev',{m:'setTxGain',a:[vga,amp]}),
    txStart:()=>call('dev',{m:'txStart',a:[]}),
    txStop:()=>call('dev',{m:'txStop',a:[]}),
    txStats:()=>call('dev',{m:'txStats',a:[]}),
    // без ответа: буфер уходит в воркер передачей, id 0 никто не ждёт
    txPush:i8=>{ w.postMessage({id:0, cmd:'dev', args:{m:'txPush', a:[i8]}}, [i8.buffer]); },
    resetBuffer:()=>call('resetBuffer'),
    // cb получает {buf} | {err} | {end}
    startStream(readsPerSec, depth, cb){ onChunk=cb; return call('start',{readsPerSec, depth}); },
    setReadRate:readsPerSec=>call('readRate',{readsPerSec}),
    stopStream:()=>call('stop'),
    async close(){
      try{ await call('close'); }
      finally{ const cb=onChunk; onChunk=null; cb?.({end:true}); drop(); }
    }
  };
}

// ---- файлы IQ: запись и воспроизведение ----
// WAV IQ: 2 канала PCM 16 бит со знаком (I — левый, Q — правый), заголовок ровно 44 байта (fmt + data):
// SDR++ читает заголовок фиксированной структурой и 8 бит не понимает. Чанк auxi (SDR#/HDSDR) —
// после data, частота ещё и в имени файла ("_<Гц>Hz_", SDR++).
// SigMF — архив .sigmf (tar: <имя>.sigmf-data + <имя>.sigmf-meta) в формате источника; перестройка
// во время записи добавляет сегмент captures. Читаем также пару .sigmf-meta + .sigmf-data и сырые файлы.
const IQ_WAV_MAX=0xffffffff-1024;          // предел RIFF
const IQ_TAR_MAX=0o77777777777;            // предел поля size в ustar
const IQ_AUXI=68;

const iqFmtTime=t=>{ t=Math.floor(t); return Math.floor(t/60)+':'+String(t%60).padStart(2,'0'); };
function iqStamp(d){
  const p=v=>String(v).padStart(2,'0');
  return {date:`${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`, time:`${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`};
}
// SYSTEMTIME для auxi
function iqSysTime(dv, o, d){
  [d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    .forEach((v,i)=>dv.setUint16(o+2*i, v, true));
}
const iqStr=(dv,p,s)=>{ for(let i=0;i<s.length;i++) dv.setUint8(p+i, s.charCodeAt(i)); };
// заголовок WAV: fmt + data, 16 бит
function iqWavHeader(o){
  const b=new ArrayBuffer(44), dv=new DataView(b);
  iqStr(dv,0,'RIFF'); dv.setUint32(4, 36+o.bytes+8+IQ_AUXI, true); iqStr(dv,8,'WAVE');
  iqStr(dv,12,'fmt '); dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,2,true);
  dv.setUint32(24,o.rate,true); dv.setUint32(28,o.rate*4,true); dv.setUint16(32,4,true); dv.setUint16(34,16,true);
  iqStr(dv,36,'data'); dv.setUint32(40,o.bytes,true);
  return b;
}
// чанк auxi — в конец файла
function iqWavAuxi(o){
  const b=new ArrayBuffer(8+IQ_AUXI), dv=new DataView(b);
  iqStr(dv,0,'auxi'); dv.setUint32(4,IQ_AUXI,true);
  iqSysTime(dv, 8, o.start); iqSysTime(dv, 24, o.stop||o.start);
  dv.setUint32(40, Math.round(o.freq)>>>0, true); dv.setUint32(44, o.rate, true);   // CenterFreq, ADFrequency
  return new Uint8Array(b);
}
// u8 (смещение 127.5) → s16
function iqU8toS16(buf){
  const u=new Uint8Array(buf), o=new Int16Array(u.length);
  for(let i=0;i<u.length;i++) o[i]=Math.round((u[i]-127.5)*256);
  return new Uint8Array(o.buffer);
}
// заголовок записи ustar; size > 8 ГБ не нужен — запись останавливается раньше
function iqTarHeader(name, size, mtime){
  const b=new Uint8Array(512), str=(p,s,len)=>{ for(let i=0;i<Math.min(s.length,len);i++) b[p+i]=s.charCodeAt(i); };
  str(0, name, 100); str(100,'0000644\0',8); str(108,'0000000\0',8); str(116,'0000000\0',8);
  str(124, size.toString(8).padStart(11,'0')+'\0', 12); str(136, Math.floor(mtime/1000).toString(8).padStart(11,'0')+'\0', 12);
  str(148,'        ',8); b[156]=0x30; str(257,'ustar\0',6); str(263,'00',2);
  let sum=0; for(let i=0;i<512;i++) sum+=b[i];
  str(148, sum.toString(8).padStart(6,'0')+'\0 ', 8);
  return b;
}
function iqSigmfMeta(r){
  return JSON.stringify({
    global:{'core:datatype':r.fmt==='u8'?'cu8':'ci16_le', 'core:sample_rate':r.rate, 'core:version':'1.0.0',
      'core:recorder':'DSP workbench', 'core:hw':r.hw||''},
    captures:r.captures.map(c=>({'core:sample_start':c.start, 'core:frequency':c.freq, 'core:datetime':c.datetime})),
    annotations:[]
  }, null, 2);
}

// Запись: чанки пишутся во временный файл OPFS (хранилище сайта на диске), без него — в память
// (до IQ_MEM_MAX). По «Стоп» — окно сохранения (или обычное скачивание) и копия в выбранный файл.
const IQ_MEM_MAX=1<<30;
const iqTmpBusy=new Set();                 // временные файлы активных и несохранённых записей
async function iqTmpOpen(){
  try{
    const dir=await navigator.storage.getDirectory();
    // остатки прошлых записей (перезагрузка, скачивание через ссылку) — удаляем
    for await(const [k] of dir.entries()) if(/^iq-rec-/.test(k) && !iqTmpBusy.has(k)) await dir.removeEntry(k).catch(()=>{});
    const name='iq-rec-'+Date.now()+'.tmp', h=await dir.getFileHandle(name, {create:true});
    if(!h.createWritable){ await dir.removeEntry(name); return null; }
    iqTmpBusy.add(name);
    return {dir, name, h, w:await h.createWritable()};
  }catch(e){ return null; }
}
function iqTmpDrop(r, remove){
  if(!r.tmp) return;
  iqTmpBusy.delete(r.tmp.name);
  if(remove) r.tmp.dir.removeEntry(r.tmp.name).catch(()=>{});
}
function iqRecMsg(n, s){ n.status=s; n.recMsg=s; }
async function iqRecStart(n){
  if(!n.connected || !n.dev) throw new Error('not connected');
  if(n.recDone){ iqTmpDrop(n.recDone, true); n.recDone=null; }
  n.recMsg='';
  const kind=n.p.recFmt==='SigMF' ? 'sigmf' : 'wav', start=new Date(), st=iqStamp(start);
  const freq=Math.round(n.actualFreq??n.p.freq), fmt=n.dev.fmt, rate=Math.round(n.sourceRate);
  const base=kind==='wav' ? `baseband_${freq}Hz_${st.date}_${st.time}Z` : `iq_${freq}Hz_${st.date}_${st.time}Z`;
  const name=base+(kind==='wav' ? '.wav' : '.sigmf');
  // место под заголовок: WAV — сам заголовок, SigMF — заголовок tar записи данных
  const head=kind==='wav' ? 44 : 512;
  const r={kind, name, base, fmt, rate, freq, start, head, bytes:0, pos:head, chunks:[], chain:Promise.resolve(), pending:0,
    bps:kind==='wav'||fmt!=='u8' ? 4 : 2, captures:[{start:0, freq, datetime:start.toISOString()}],
    hw:n.dev.tunerName, epoch:n.dev.epoch?.()||0, err:null, tmp:null};
  n.rec=r;
  const tmp=await iqTmpOpen();
  if(n.rec!==r){ if(tmp){ r.tmp=tmp; tmp.w.close().catch(()=>{}); iqTmpDrop(r, true); } return; }
  if(tmp){
    // чанки, пришедшие пока открывался файл, — туда же
    r.tmp=tmp;
    const pre=r.chunks; r.chunks=[];
    let pos=head; const w=tmp.w;
    r.chain=w.write({type:'write', position:0, data:new Uint8Array(head)});
    for(const d of pre){ const p=pos; r.chain=r.chain.then(()=>w.write({type:'write', position:p, data:d})); pos+=d.length; }
    r.chain=r.chain.catch(e=>{ r.err=e.message; });
  }
}
// чанк из readerLoop; buf копируется — дальше его забирает демод-воркер
function iqRecWrite(n, buf, epoch){
  const r=n.rec; if(!r || r.err) return;
  if(epoch!=null && epoch<r.epoch) return;          // чанк до начала записи — ещё старая частота
  // первый чанк после перестройки — новый сегмент captures (в WAV частота одна — остаётся начальная)
  if(epoch!=null && epoch>r.epoch){
    r.epoch=epoch;
    const f=Math.round(n.actualFreq??r.freq), last=r.captures[r.captures.length-1], s=r.bytes/r.bps;
    if(f!==last.freq){ if(s===last.start) last.freq=f; else r.captures.push({start:s, freq:f, datetime:new Date().toISOString()}); }
  }
  const data=r.kind==='wav' && r.fmt==='u8' ? iqU8toS16(buf) : new Uint8Array(buf.slice(0));
  const max=r.kind==='wav' ? IQ_WAV_MAX : IQ_TAR_MAX;
  if(r.bytes+data.length>max || (!r.tmp && r.bytes+data.length>IQ_MEM_MAX)){
    r.err=r.tmp ? 'file size limit reached' : 'memory limit reached (1 GB)'; iqRecStop(n); return;
  }
  if(r.tmp){
    if(r.pending>256e6){ r.err='disk too slow'; iqRecStop(n); return; }
    const pos=r.pos, w=r.tmp.w; r.pending+=data.length;
    r.chain=r.chain.then(()=>w.write({type:'write', position:pos, data})).then(()=>{ r.pending-=data.length; }, e=>{ r.err=e.message; });
  }else r.chunks.push(data);
  r.pos+=data.length; r.bytes+=data.length;
}
// окно сохранения — до первого await, пока действует нажатие кнопки; без него — скачивание ссылкой
function iqPickSave(r){
  if(!window.showSaveFilePicker) return null;
  const p=window.showSaveFilePicker({suggestedName:r.name,
    types:[r.kind==='wav' ? {description:'WAV IQ', accept:{'audio/wav':['.wav']}} : {description:'SigMF archive', accept:{'application/x-tar':['.sigmf']}}]});
  p.catch(()=>{});
  return p;
}
async function iqRecStop(n){
  const r=n.rec;
  if(!r){ if(n.recDone?.blob) await iqRecSave(n, iqPickSave(n.recDone)); return; }
  n.rec=null;
  const pick=iqPickSave(r), stop=new Date();
  iqRecMsg(n, 'finishing '+r.name+'…');
  let head, tail;
  if(r.kind==='wav'){
    head=new Uint8Array(iqWavHeader({rate:r.rate, bytes:r.bytes}));
    tail=iqWavAuxi({rate:r.rate, freq:r.freq, start:r.start, stop});
  }else{
    head=iqTarHeader(`${r.base}/${r.base}.sigmf-data`, r.bytes, r.start.getTime());
    const meta=new TextEncoder().encode(iqSigmfMeta(r)), pad=n=>(512-n%512)%512;
    tail=new Uint8Array(pad(r.bytes)+512+meta.length+pad(meta.length)+1024);
    tail.set(iqTarHeader(`${r.base}/${r.base}.sigmf-meta`, meta.length, stop.getTime()), pad(r.bytes));
    tail.set(meta, pad(r.bytes)+512);
  }
  const type=r.kind==='wav' ? 'audio/wav' : 'application/x-tar';
  try{
    if(r.tmp){
      await r.chain;
      const w=r.tmp.w;
      await w.write({type:'write', position:r.pos, data:tail});
      await w.write({type:'write', position:0, data:head});
      await w.close();
      r.blob=await r.tmp.h.getFile();
    }else r.blob=new Blob([head, ...r.chunks, tail], {type});
  }catch(e){
    iqTmpDrop(r, true);
    iqRecMsg(n, 'recording failed: '+e.message);
    return;
  }
  r.chunks=null;
  n.recDone=r;
  await iqRecSave(n, pick);
}
async function iqRecSave(n, pick){
  const r=n.recDone, info=r.name+' ('+(r.bytes/1e6).toFixed(1)+' MB)', pre=r.err ? 'recording stopped: '+r.err+', ' : '';
  try{
    if(pick){
      const h=await pick;
      iqRecMsg(n, 'saving '+info+'…');
      await r.blob.stream().pipeTo(await h.createWritable());
      iqTmpDrop(r, true);
    }else{
      const a=document.createElement('a');
      a.href=URL.createObjectURL(r.blob); a.download=r.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 60000);
      iqTmpDrop(r, false);                           // файл удалится при следующей записи
    }
    n.recDone=null;
    iqRecMsg(n, pre+'saved '+info);
  }catch(e){
    // отмена или нет жеста (остановка по ошибке/отключению) — запись ждёт повторного «Стоп»
    iqRecMsg(n, pre+(e.name==='AbortError' ? 'not saved' : e.name==='SecurityError' ? 'finished' : 'save error: '+e.message)+
      ' — press Stop recording to save '+info);
  }
}

// ---- разбор файлов ----
// → {blob, off, size, dtype ('cu8'|'ci8'|'ci16_le'|'cf32_le'|'cf64_le'), rate, captures:[{start, freq}], name}
function iqFreqFromName(name){
  const m=name.match(/(\d+(?:\.\d+)?)\s*(k|M|G)?Hz/i);
  return m ? Math.round(+m[1]*({k:1e3,m:1e6,g:1e9}[(m[2]||'').toLowerCase()]||1)) : null;
}
function iqRateFromName(name){
  const m=name.match(/(\d+(?:\.\d+)?)\s*(k|M)?sps/i);
  return m ? Math.round(+m[1]*({k:1e3,m:1e6}[(m[2]||'').toLowerCase()]||1)) : null;
}
// auxi после data (так пишем мы — ради SDR++)
async function iqWavTailFreq(f, o){
  if(o+8>f.size) return null;
  const b=await f.slice(o, Math.min(f.size, o+4096)).arrayBuffer(), dv=new DataView(b);
  for(let p=0; p+8<=b.byteLength;){
    const id=String.fromCharCode(...new Uint8Array(b, p, 4)), len=dv.getUint32(p+4,true);
    if(id==='auxi' && len>=36 && p+8+36<=b.byteLength) return dv.getUint32(p+8+32,true)||null;
    p+=8+len+(len&1);
  }
  return null;
}
async function iqParseWav(f){
  const hb=await f.slice(0, Math.min(f.size, 1<<16)).arrayBuffer(), dv=new DataView(hb);
  const tag=o=>String.fromCharCode(dv.getUint8(o),dv.getUint8(o+1),dv.getUint8(o+2),dv.getUint8(o+3));
  if(tag(0)!=='RIFF' || tag(8)!=='WAVE') throw new Error('not a WAV file');
  let o=12, fmt=null, freq=null;
  while(o+8<=hb.byteLength){
    const id=tag(o), len=dv.getUint32(o+4,true);
    if(id==='fmt ') fmt={tag:dv.getUint16(o+8,true), ch:dv.getUint16(o+10,true), rate:dv.getUint32(o+12,true), bits:dv.getUint16(o+22,true)};
    else if(id==='auxi' && len>=36) freq=dv.getUint32(o+8+32,true)||null;
    else if(id==='data'){
      if(!fmt) break;
      if(fmt.ch!==2) throw new Error('WAV must have 2 channels (I/Q), got '+fmt.ch);
      const tg=fmt.tag===0xfffe ? (fmt.bits===32 ? 3 : 1) : fmt.tag;   // WAVE_FORMAT_EXTENSIBLE — по разрядности
      const dtype=tg===1&&fmt.bits===8 ? 'cu8' : tg===1&&fmt.bits===16 ? 'ci16_le' : tg===3&&fmt.bits===32 ? 'cf32_le' : tg===3&&fmt.bits===64 ? 'cf64_le' : null;
      if(!dtype) throw new Error(`unsupported WAV sample format (${fmt.bits} bit, tag ${fmt.tag})`);
      const size=Math.min(len>0 && len<0xffffffff ? len : f.size, f.size-(o+8));
      if(freq==null) freq=await iqWavTailFreq(f, o+8+size+(size&1));
      return {blob:f, off:o+8, size, dtype, rate:fmt.rate, captures:[{start:0, freq:freq??iqFreqFromName(f.name)}], name:f.name};
    }
    o+=8+len+(len&1);
  }
  throw new Error('WAV without data chunk');
}
function iqFromMeta(meta, blob, off, size, name){
  const g=meta.global||{}, dt=g['core:datatype']||'';
  const dtype={cu8:'cu8', ci8:'ci8', ci16_le:'ci16_le', ci16:'ci16_le', cf32_le:'cf32_le', cf32:'cf32_le', cf64_le:'cf64_le', cf64:'cf64_le'}[dt];
  if(!dtype) throw new Error('unsupported SigMF datatype '+dt);
  const caps=(meta.captures||[]).map(c=>({start:+c['core:sample_start']||0, freq:c['core:frequency']??null}));
  return {blob, off, size, dtype, rate:+g['core:sample_rate'], captures:caps.length?caps:[{start:0, freq:null}], name};
}
async function iqParseTar(f){
  let o=0, data=null, meta=null;
  while(o+512<=f.size){
    const h=new Uint8Array(await f.slice(o, o+512).arrayBuffer());
    if(!h[0]) break;
    const name=new TextDecoder().decode(h.subarray(0,100)).replace(/\0.*$/s,'');
    const size=parseInt(new TextDecoder().decode(h.subarray(124,136)).replace(/[\0 ]/g,'')||'0', 8);
    if(/\.sigmf-data$/.test(name) && !data) data={off:o+512, size, name};
    if(/\.sigmf-meta$/.test(name) && !meta) meta=JSON.parse(await f.slice(o+512, o+512+size).text());
    o+=512+Math.ceil(size/512)*512;
  }
  if(!data || !meta) throw new Error('SigMF archive without .sigmf-data/.sigmf-meta');
  return iqFromMeta(meta, f, data.off, data.size, data.name.split('/').pop());
}
// fmt — формат сырых отсчётов из настроек узла ('auto' — по расширению)
async function iqParseFiles(files, fmt){
  files=[...files];
  const ext=f=>(f.name.match(/\.([^.]+)$/)||[])[1]?.toLowerCase()||'';
  const metaF=files.find(f=>ext(f)==='sigmf-meta'), dataF=files.find(f=>ext(f)==='sigmf-data');
  if(metaF){
    if(!dataF) throw new Error('select the .sigmf-data file together with .sigmf-meta');
    return iqFromMeta(JSON.parse(await metaF.text()), dataF, 0, dataF.size, dataF.name);
  }
  const f=files[0];
  if(!f) throw new Error('no file');
  const e=ext(f);
  if(e==='wav') return iqParseWav(f);
  if(e==='sigmf') return iqParseTar(f);
  // сырые отсчёты: тип — выбранный или по расширению, частоты — из имени файла, иначе из настроек узла
  const dtype=IQ_RAW_FMT[fmt] || IQ_RAW_EXT[e];
  if(!dtype) throw new Error('unknown IQ file type .'+e+' — choose IQ file format');
  return {blob:f, off:0, size:f.size, dtype, rate:iqRateFromName(f.name), captures:[{start:0, freq:iqFreqFromName(f.name)}], name:f.name, raw:true};
}

const IQ_RAW_FMT={cu8:'cu8', cs8:'ci8', cs16:'ci16_le', cf32:'cf32_le', cf64:'cf64_le'};
const IQ_RAW_EXT={cu8:'cu8', u8:'cu8', bin:'cu8', cs8:'ci8', ci8:'ci8', s8:'ci8', i8:'ci8', cs16:'ci16_le', ci16:'ci16_le', sc16:'ci16_le', s16:'ci16_le', i16:'ci16_le',
  cf32:'cf32_le', fc32:'cf32_le', f32:'cf32_le', cfile:'cf32_le', raw:'cf32_le', 'sigmf-data':'cf32_le', cf64:'cf64_le', fc64:'cf64_le', f64:'cf64_le'};

// Устройство-проигрыватель с API USB-драйверов: отдаёт отсчёты в реальном времени, центр — из файла.
function iqFileDevice(src, defRate, defFreq){
  const bytesPer={cu8:2, ci8:2, ci16_le:4, cf32_le:8, cf64_le:16}[src.dtype];
  const fmt=src.dtype==='cu8'||src.dtype==='ci8' ? 'u8' : 's16', bps=fmt==='u8' ? 2 : 4;
  const rate=src.rate>0 ? src.rate : defRate, total=Math.floor(src.size/bytesPer);
  const caps=src.captures.map(c=>({start:c.start, freq:c.freq??defFreq})).sort((a,b)=>a.start-b.start);
  let pos=0, tuneEpoch=0, t0=0, sent=0, chain=Promise.resolve(), capIdx=0, closed=false;
  // упреждающее чтение блоками ~0.5 с (не больше 8 МБ): чтение Blob на мобильных медленное,
  // по чанку на 25 мс оно не успевало
  const blkN=Math.max(1<<14, Math.min(Math.round(rate/2), Math.floor((8<<20)/bytesPer)));
  const lead=()=>RTL_FILE_TARGET_S*1000;         // старт с запасом кольца, без паузы на наполнение
  let cur=null, ahead=null;
  const load=a=>{ const b=Math.min(total, a+blkN);
    const p=src.blob.slice(src.off+a*bytesPer, src.off+b*bytesPer).arrayBuffer().then(buf=>({a, b, buf}));
    p.catch(()=>{}); return {a, p}; };
  const dev={kind:'file', fixedFreq:true, fmt, bps, tunerName:src.name, loop:true, onFreq:null, ended:false,
    rate, total, get pos(){ return pos; },
    epoch:()=>tuneEpoch,
    async setSampleRate(){ return rate; },
    async setCenterFrequency(){ return caps[capIdx].freq; },
    async setGain(){}, async setBiasTee(){},
    async resetBuffer(){ t0=performance.now()-lead(); sent=0; },
    seek(frac){ pos=Math.max(0, Math.min(total-1, Math.floor(frac*total))); dev.ended=false; t0=performance.now()-lead(); sent=0; syncCap(); },
    readSamples(nBytes){ const p=chain.then(()=>read(nBytes/bps)); chain=p.catch(()=>{}); return p; },
    async close(){ closed=true; cur=ahead=null; }
  };
  function syncCap(){
    let i=0; while(i+1<caps.length && caps[i+1].start<=pos) i++;
    if(i!==capIdx){ capIdx=i; tuneEpoch++; dev.onFreq?.(caps[i].freq); }
  }
  async function read(ns){
    // темп — по часам: чанк отдаётся не раньше, чем он "прозвучал" бы в эфире
    while(dev.ended && !closed) await new Promise(r=>setTimeout(r, 100));
    if(closed) throw new Error('closed');
    while(!(cur && pos>=cur.a && pos<cur.b)){
      if(!ahead || ahead.a!==pos) ahead=load(pos);
      const p=ahead.p; ahead=null;
      cur=await p;
      if(closed) throw new Error('closed');
      ahead=load(cur.b>=total ? 0 : cur.b);
    }
    // не пересекаем границу сегмента captures, блока и конец файла
    const next=caps[capIdx+1]?.start??total, take=Math.max(1, Math.min(ns, next-pos, total-pos, cur.b-pos));
    if(!t0) t0=performance.now()-lead();
    let wait=t0+(sent+take)/rate*1000-performance.now();
    if(wait<-500){ t0=performance.now()-sent/rate*1000-lead(); wait=0; }   // вкладка спала — не догоняем рывком
    if(wait>0) await new Promise(r=>setTimeout(r, wait));
    sent+=take;
    const o=(pos-cur.a)*bytesPer, raw=cur.buf.slice(o, o+take*bytesPer);
    pos+=take;
    if(pos>=total){ if(dev.loop){ pos=0; } else dev.ended=true; }
    syncCap();
    return iqConvert(raw, src.dtype, fmt);
  }
  return dev;
}
// в формат конвейера: u8 (смещение 127.5) или s16
function iqConvert(raw, dtype, fmt){
  if(dtype==='cu8') return raw;
  if(dtype==='ci8'){ const u=new Uint8Array(raw); for(let i=0;i<u.length;i++) u[i]^=0x80; return raw; }
  if(dtype==='ci16_le') return raw;
  const f=dtype==='cf64_le' ? new Float64Array(raw) : new Float32Array(raw), o=new Int16Array(f.length);
  for(let i=0;i<f.length;i++){ const v=f[i]*32767; o[i]=v>32767?32767:v<-32768?-32768:v; }
  return o.buffer;
}

// ---- узел графа: источник IQ ----

// План децимации демод-воркера: sr → ir (канальный FIR, прореживание d1) → демодуляция →
// ar (аудио-FIR, прореживание d2). Общий для воркера и главного потока (вставляется в
// RTL_WORKER_SRC через toString) — главный поток по нему сайзит кольцо и считает темп чтения.
// bw — ширина полосы канала (ПЧ), как единственный "bandwidth" в SDR++: звуковая полоса выводится
// из неё (WFM — 15 кГц моно, NFM — половина полуполосы, AM/SAM — полуполоса, SSB — сама полоса).
// AM/SAM: decA только прореживает, соседей режет крутой канальный FIR на ir (cStop — его полоса
// задержания); stop у decA выбран так, чтобы алиасы ложились не ближе cStop.
function rtlPlan(mode, sr, bw){
  const w = bw>0 ? bw : ({WFM:190000,NFM:16000,AM:10000,SAM:10000}[mode]||2800);
  const isAm = mode==='AM' || mode==='SAM';
  let ir, pass;
  if(mode==='WFM'){ pass=w/2; ir=Math.max(240000, 2.5*pass); }
  else if(mode==='NFM'){ pass=w/2; ir=Math.max(48000, 2.5*pass); }
  else if(isAm){ pass=w/2; ir=Math.max(24000, 2.5*pass); }
  else { pass=w; ir=Math.max(24000, 3*w); }          // USB/LSB: канал покрывает обе боковые, выбор — на ir
  const d1=Math.max(1, Math.floor(sr/ir)), irReal=sr/d1;
  const d2=mode==='WFM' ? Math.max(1, Math.floor(irReal/64000)) : 1;
  const ar=irReal/d2;
  let aPass, aStop;
  if(mode==='WFM'){ aPass=Math.min(15000, pass*0.6); aStop=Math.min(19000, aPass+4000); }   // стоп до пилота 19 кГц
  else if(mode==='NFM'){ aPass=Math.min(Math.max(2500, pass*0.5), 0.4*ar); aStop=Math.min(ar/2, aPass*1.25+500); }
  else if(isAm){ aPass=Math.min(pass, 0.4*ar); aStop=Math.min(ar/2, aPass+1000); }
  else { aPass=Math.min(pass, 0.4*ar); aStop=Math.min(ar/2, aPass+Math.max(500, aPass*0.25)); }
  const cStop = isAm ? pass+1000 : pass;
  return {d1, d2, decim:d1*d2, ir:irReal, ar, pass, cStop, stop:irReal-cStop, aPass, aStop};
}
function rtlDecimFor(mode, sr, bw){ return rtlPlan(mode, sr, bw).decim; }
// пределы ширины канала и значения по умолчанию для каждого режима
const RTL_BW_LIMITS={WFM:[50000,300000], NFM:[3000,40000], AM:[2000,20000], SAM:[2000,20000], USB:[500,16000], LSB:[500,16000]};
const RTL_BW_DEF={WFM:190000, NFM:16000, AM:10000, SAM:10000, USB:2800, LSB:2800};
// конфиг демод-воркера канала
const rtlWorkerCfg=n=>({mode:n.p.demod, sr:n.sourceRate, bw:n.p.bw, deemph:n.p.deemph, agc:n.p.agc!==false,
  stereo:n.p.stereo!==false, samSb:n.p.samSb, nb:n.p.nb, anf:!!n.p.anf});
const rtlSoftKey=n=>[n.p.bw,n.p.deemph,n.p.agc,n.p.stereo,n.p.samSb,n.p.nb,n.p.anf].join('|');
// Полоса пропускания канального фильтра (ПЧ) каждого активного канала, в абсолютных частотах:
// WFM/NFM/AM — симметрично ±pass, USB/LSB — одна боковая шириной bw. Для IQ каналов нет.
function rtlChanBands(n, cf, half){
  const mode=n.p.demod; if(mode==='IQ') return [];
  const pl=rtlPlan(mode, n.sourceRate, n.p.bw), out=[];
  for(let ci=0;ci<4;ci++){
    const ch=n.ch[ci]; if(!ch.active) continue;
    const f=clamp(ch.tuneFreq==null?sdrCenter(n):ch.tuneFreq, cf-half, cf+half);
    const lo = mode==='USB' ? f : f-pl.pass, hi = mode==='LSB' ? f : f+pl.pass;
    out.push({idx:ci, f, lo, hi, mode});
  }
  return out;
}
const rtlChanOuts=n=>{
  const o={sqOpen:n.ch[0].sqOpen===false?0:1};
  n.ch.forEach((ch,i)=>{ const sfx=i?String(i+1):'', on=ch.active&&n.connected;
    o['rssi'+sfx]=on? ch.rssi??null : null; o['snr'+sfx]=on? ch.snr??null : null; });
  return o;
};
// SNR канала по спектру: средняя мощность бинов в полосе [lo,hi] против меньшей из двух соседних
// полос за защитным интервалом (занятый сосед с одной стороны оценку шума не завышает).
// Шумовой пол по минимуму RSSI тут не годится: на постоянной несущей он сам станет "шумом".
function rtlChanSnr(sp, lo, hi){
  const F=sp.freqs, m=sp.mag, N=F.length, b=(F[N-1]-F[0])/(N-1);
  if(!(b>0)) return null;
  const bin=f=>Math.round((f-F[0])/b), w=Math.max(hi-lo, b), g=Math.max(2*b, 0.1*w), t=Math.max(8*b, w);
  const pw=(a,z)=>{ a=Math.max(1,a); z=Math.min(N-2,z); let s=0,c=0; for(let i=a;i<=z;i++){ s+=m[i]*m[i]; c++; } return c? s/c : null; };
  const sig=pw(bin(lo),bin(hi)), L=pw(bin(lo-g-t),bin(lo-g)), R=pw(bin(hi+g),bin(hi+g+t));
  const nz = L!=null && R!=null ? Math.min(L,R) : (L??R);
  if(sig==null || !(nz>0)) return null;
  const sigDb=10*Math.log10(sig+1e-24), nzDb=10*Math.log10(nz+1e-24);
  return {snr:sigDb-nzDb, nzDb};                      // nzDb — уровень шума на бин, в шкале спектра
}
// шумовая полоса окна в бинах: мощность шума на бин = плотность × ENBW
const RTL_WIN_ENBW={hann:1.5, hamming:1.363, blackman:1.727, rect:1};
// Для 'sa': то, с чем сравнивает шумоподавитель, в шкале спектра (дБ на бин, среднее по полосе
// канала). SNR: шум + SNR и шум + порог. level: RSSI и порог минус K, где K — во сколько раз
// мощность в полосе больше средней мощности бина (бинов в полосе / ENBW окна).
function rtlChanMeter(n, c, lines){
  const ch=n.ch[c.idx], mode=n.p.sql;
  c.rssi=ch.rssi??null; c.snr=ch.snr??null;
  c.sql = mode==='SNR'||mode==='level' ? mode : null; c.sqOpen=ch.sqOpen!==false;
  if(lines && c.sql==='SNR' && ch.noiseDb!=null && ch.snr!=null){ c.lvDb=ch.noiseDb+ch.snr; c.thrDb=ch.noiseDb+(+n.p.sqlSnr); }
  else if(lines && c.sql==='level' && ch.rssi!=null){
    const binHz=n.sourceRate/(+n.p.specSize||4096);
    const K=10*Math.log10(Math.max(1,(c.hi-c.lo)/binHz)/(RTL_WIN_ENBW[n.p.specWin]||1.5));
    c.lvDb=ch.rssi-K; c.thrDb=(+n.p.sqlLvl)-K;
  }
  return c;
}
// RSSI очередного чанка канала (dBFS в полосе канала) и решение шумоподавителя:
// открыт при уровне >= порога, закрывается ниже порога−гистерезис спустя hang мс
const RTL_SQL_HYST=3;
function rtlChanLevel(n, ch, db){
  ch.rssiChunk=db;
  ch.rssi = ch.rssi==null ? db : ch.rssi*0.7+db*0.3;
  const mode=n.p.sql;
  if(mode!=='SNR' && mode!=='level'){ ch.sqOpen=true; return; }
  const v = mode==='level' ? db : ch.snr, thr = mode==='level' ? +n.p.sqlLvl : +n.p.sqlSnr;
  if(v==null) return;
  const now=performance.now();
  if(ch.sqOpen===undefined) ch.sqOpen=v>=thr;      // первое решение — сразу, без hang
  if(v>=thr || (ch.sqOpen && v>=thr-RTL_SQL_HYST)){ ch.sqOpen=true; ch.sqT=now; }
  else if(ch.sqOpen!==false && now-(ch.sqT||0)>(+n.p.sqlHang||0)) ch.sqOpen=false;
}
// (Пере)создаёт аудио-кольцо одного канала под ТЕКУЩИЙ n.decim — вызывается при первой
// активации канала и при каждой смене decim на лету (demod/bw/sourceRate), иначе кольцо
// остаётся размером под старую децимацию и гистерезис (проценты от size) снова начинает
// значить не те доли секунды, для которых он посчитан — та же болезнь, которую decim лечит.
function rtlResizeChannelRing(n, ch){
  const asize=Math.max(50000, Math.round(n.ring.size/n.decim));
  ch.aring={A:new Float32Array(asize), B:new Float32Array(asize), size:asize, w:0, filled:0, written:0};   // A — левый, B — правый
  // rebuffering=true с самого начала — свежее кольцо пусто, и это ровно то же состояние, что и
  // после настоящего провала в середине игры (см. rtlReadChannelAudio): пусть тот же самый,
  // уже отлаженный механизм "молчим, пока не накопится безопасный запас" сработает и на самом
  // первом чтении, без отдельного частного случая специально под старт.
  ch.readPos=0; ch.readCount=0; ch.rebuffering=true;
  ch.ringDecim=n.decim;
}
function rtlResetRing(n){
  // размер кольца — под ~2с реального времени на ТЕКУЩЕМ sourceRate, а не фиксированное число
  // сэмплов: иначе на низком sample rate то же кольцо покрывает намного больше реального
  // времени, и порог гистерезиса (в процентах от размера) превращается в секунды ожидания.
  const SIZE=Math.max(500000, Math.min(8000000, Math.round((n.sourceRate||1024000)*2)));
  n.ring={I:new Float32Array(SIZE), Q:new Float32Array(SIZE), size:SIZE, w:0, filled:0, written:0};
  // rebuffering=true с самого начала — то же "молчим, пока не накопится безопасный запас", что и
  // после настоящего провала в середине игры (см. rtlReadIQ), без отдельного случая под старт.
  n.ringReadPos=0; n.ringReadCount=0; n.ringRebuffering=true;   // чтение сырого IQ — отдельно от каналов
  // ~150мс потока (Уэлч берёт всё пришедшее между расчётами), не меньше максимального БПФ;
  // пишется независимо от режима демодуляции
  const SPEC_SIZE=clamp(Math.round((n.sourceRate||1024000)*0.15), 1<<17, 1<<22);
  n.specRing={I:new Float32Array(SPEC_SIZE), Q:new Float32Array(SPEC_SIZE), size:SPEC_SIZE, w:0, filled:0, written:0};
  n.specTaken=0;
  n.spec=null; n.specFreqs=null; n.lastSpec=0;
  // аудио-кольца каналов живут на децимированной частоте (sourceRate/decim), а не sourceRate —
  // без этого при большой децимации (узкий NFM на высоком sourceRate) кольцо размером "под 2с
  // сырого потока" реально наполнялось бы эти же 2с×decim секунд, и звук не появлялся бы минутами.
  n.decim=rtlDecimFor(n.p.demod, n.sourceRate, n.p.bw);
  // аудио-кольца УЖЕ АКТИВНЫХ каналов пересоздаём под новый размер — сами воркеры не трогаем,
  // их переконфигурирует hardKey-проверка в process() на следующем тике (sourceRate там учтён)
  for(const ch of n.ch) if(ch.active) rtlResizeChannelRing(n, ch);
}

// Исходник демод-воркера. Цепочка: u8 → DC-блок → NCO сдвига → комплексный FIR-дециматор (канал,
// sr→ir) → дискриминатор/огибающая/SSB-фильтр → аудио-FIR-дециматор (ir→ar) → DC/де-эмфазис.
// FIR с окном Кайзера (~60 дБ) вместо прежних IIR на полной sr: нет алиасинга при прореживании,
// пилот/поднесущая WFM режутся самим аудио-фильтром, дорогая часть считается на ir, а не на sr.
const RTL_WORKER_SRC = rtlPlan.toString()+`
function besselI0(x){ let s=1, t=1; for(let k=1;k<30;k++){ t*=(x/(2*k))*(x/(2*k)); s+=t; if(t<1e-10*s) break; } return s; }
// ФНЧ с окном Кайзера, β=5.65 (~60 дБ); число отводов — по ширине перехода, нечётное
function makeLP(fs, pass, stop, maxN){
  const tw=Math.max(1, stop-pass), fc=(pass+stop)/2/fs;
  let N=Math.min(maxN, Math.ceil(3.6*fs/tw)); N|=1;
  const M=(N-1)/2, beta=5.65, i0b=besselI0(beta), h=new Float32Array(N);
  let s=0;
  for(let k=0;k<N;k++){
    const x=k-M, r=M?x/M:0;
    const sinc = x===0 ? 2*fc : Math.sin(2*Math.PI*fc*x)/(Math.PI*x);
    h[k]=sinc*besselI0(beta*Math.sqrt(Math.max(0,1-r*r)))/i0b; s+=h[k];
  }
  for(let k=0;k<N;k++) h[k]/=s;
  return h;
}
// дециматор: история удвоенной длины — окно всегда непрерывно, без % в свёртке
function mkDec(h, D, cplx){
  const N=h.length;
  return {h, N, D, pos:0, cnt:D, bi:new Float32Array(2*N), bq:cplx?new Float32Array(2*N):null};
}

let plan=null, mode='WFM', sr=1024000, bw=15000, deemph='50', agcOn=true, stereoOn=true, isWFM=false;
let decA=null, decB=null, decC=null, decS=null, decR=null, ssbHr=null, ssbHi=null, ssbN=0;
// RSSI: у FM/SSB decA — только антиалиасный (переход до ir−pass), соседи режутся уже после детектора.
// Для уровня — отдельный крутой фильтр полосы канала (у SSB — комплексный, одна боковая), считается
// на каждом mStep-м отсчёте: для оценки мощности каждый выход не нужен. AM/SAM — после decC.
let decM=null, mHi=null, mStep=1, mCnt=1;
// WFM-стерео и RDS считаются на ir по MPX (выход дискриминатора). Пилот 19 кГц ловит ФАПЧ на
// фазоре p=e^{jφ} (без sin/cos на отсчёт): поднесущая L-R — sin 2φ, RDS 57 кГц — 3φ.
let pbB0=0,pbA1=0,pbA2=0, pbX1=0,pbX2=0,pbY1=0,pbY2=0;           // полосовой биквад на 19 кГц
let plRe=1, plIm=0, plW0c=1, plW0s=0, plInt=0, plKp=0, plKi=0, plAmp=0.05, plAmpA=0, plLock=0, plLockA=0;
let stG=0, deR=0, audDcR=0;                                        // плавное включение стерео, состояния правого канала
// RDS: смеситель на 57 кГц → комплексный ФНЧ с прореживанием → оценка фазы BPSK → согласованный
// фильтр бифазного символа → тактовая синхронизация → дифференциальное декодирование → блоки/группы
let rdsFs=0, rdsH=5, rdsTb=10, rdsY=null, rdsYi=0, rdsN=0, rdsM=null, rdsNext=0;
let rdsCII=0, rdsCQQ=0, rdsCIQ=0, rdsPrevBit=0, rdsReg=0, rdsSync=false, rdsLastHit=-1, rdsLastOff=-1, rdsBitN=0;
let rdsExp=0, rdsBlk=[0,0,0,0], rdsOk=[false,false,false,false], rdsErr=[], rdsPI=-1, rdsPTY=0, rdsTP=0;
let rdsPS=new Array(8).fill(' '), rdsRT=new Array(64).fill(' '), rdsAB=-1, rdsDirty=false, rdsPostT=0;
const RDS_OFF=[0x0FC,0x198,0x168,0x1B4], RDS_OFFC2=0x350;           // A B C D, C'
// SAM: ФАПЧ на несущую, когерентный детектор; samSb 0 — обе боковые, ±1 — верхняя/нижняя
let isSAM=false, samSb=0, samPh=0, samW=0, samWmax=0, samLock=0, samLockA=0, samKpN=0, samKiN=0, samKpW=0, samKiW=0, samWide=true;
let samCar=0.01, samCarA=0, samPostT=0, samFi=0, samFq=0, samF2i=0, samF2q=0, samFA=0, samDcR=0;
// подавитель импульсов на сырых IQ (sr): порог по мощности относительно средней, задержка nbD —
// чтобы бланкировать и фронт импульса, который ещё не перешёл порог
let nbK=0, nbAvg=0, nbA=0, nbD=1, nbPost=0, nbCnt=0, nbPos=0, nbI=null, nbQ=null;
// автонотч: NLMS-предсказатель с задержкой; периодическое (несущие, свисты) предсказуемо и вычитается,
// речь/шум с задержкой почти не коррелируют и проходят в ошибке
const ANF_N=64, ANF_D=24, ANF_MU=0.01, ANF_LEAK=1e-5;
let anfOn=false, anfL=null, anfR=null;
function anfMake(){ const L=ANF_N+ANF_D+1; return {w:new Float32Array(ANF_N), x:new Float32Array(2*L), L, pos:0, pw:0}; }
function anfStep(a, v){
  const L=a.L, x=a.x, w=a.w;
  a.pos=a.pos===0 ? L-1 : a.pos-1;             // x[pos+j] — отсчёт j шагов назад
  const p=a.pos; x[p]=v; x[p+L]=v;
  const xin=x[p+ANF_D], xout=x[p+ANF_D+ANF_N];
  a.pw+=xin*xin-xout*xout; if(a.pw<0) a.pw=0;
  let y=0;
  for(let k=0;k<ANF_N;k++) y+=w[k]*x[p+ANF_D+k];
  const e=v-y, g=ANF_MU*e/(a.pw+1e-9), lk=1-ANF_LEAK;
  for(let k=0;k<ANF_N;k++) w[k]=w[k]*lk+g*x[p+ANF_D+k];
  return e;
}
let isAM=false, isSSB=false, isFM=false, discScale=1, deA=null, deA1=0, hpA=0, hpA1=0, rawA=0, rawA1=0;
let rawI0=0, rawQ0=0, prevI=0, prevQ=0, ampDc=0, audDc=0, de=0;
// АРУ для SSB: мгновенная атака по пику, удержание, затем спад; предел усиления — чтобы шум не раздувать бесконечно
const AGC_TARGET=0.3, AGC_MAXGAIN=1000;
let agcPk=AGC_TARGET/AGC_MAXGAIN, agcHold=0, agcHoldN=0, agcRel=0;
let offsetHz=0, offCos=1, offSin=0, offPhI=1, offPhQ=0;
let bufPool=[];

function rdsSyn(w){ let r=0; for(let i=25;i>=0;i--){ r=(r<<1)|((w>>>i)&1); if(r&0x400) r^=0x5B9; } return r&0x3FF; }
function rdsReset(){
  rdsYi=0; rdsN=0; rdsNext=rdsTb; rdsCII=rdsCQQ=rdsCIQ=0; rdsPrevBit=0; rdsReg=0; rdsSync=false; rdsLastHit=-1; rdsLastOff=-1; rdsBitN=0;
  rdsErr=[]; rdsPI=-1; rdsPTY=0; rdsTP=0; rdsPS.fill(' '); rdsRT.fill(' '); rdsAB=-1; rdsDirty=true;
  if(rdsY) rdsY.fill(0); if(rdsM) rdsM.fill(0);
}
function rdsChar(c){ return c>=0x20&&c<0x7f ? String.fromCharCode(c) : c===0x0d ? '\\r' : ' '; }
function rdsGroup(){
  const [a,b,c,d]=rdsBlk;
  if(rdsOk[0] && rdsPI!==a){ rdsPI=a; rdsDirty=true; }
  if(!rdsOk[1]) return;
  const type=b>>>12, ver=(b>>>11)&1;
  const pty=(b>>>5)&0x1f, tp=(b>>>10)&1;
  if(pty!==rdsPTY||tp!==rdsTP){ rdsPTY=pty; rdsTP=tp; rdsDirty=true; }
  if(type===0 && rdsOk[3]){                                       // 0A/0B — название станции (PS), по 2 символа
    const i=(b&3)*2; rdsPS[i]=rdsChar(d>>>8); rdsPS[i+1]=rdsChar(d&0xff); rdsDirty=true;
  } else if(type===2){                                            // 2A/2B — радиотекст
    const ab=(b>>>4)&1;
    if(ab!==rdsAB){ rdsAB=ab; rdsRT.fill(' '); }
    const addr=b&0xf;
    if(ver===0 && rdsOk[2] && rdsOk[3]){
      const t=[c>>>8,c&0xff,d>>>8,d&0xff];
      for(let k=0;k<4;k++) rdsRT[addr*4+k]=rdsChar(t[k]);
    } else if(ver===1 && rdsOk[3]){
      rdsRT[addr*2]=rdsChar(d>>>8); rdsRT[addr*2+1]=rdsChar(d&0xff);
    }
    rdsDirty=true;
  }
}
// очередной бит после дифференциального декодирования: поиск/удержание синхронизации блоков
function rdsBit(bit){
  rdsReg=((rdsReg<<1)|bit)&0x3FFFFFF; rdsBitN++;
  if(!rdsSync){
    const sy=rdsSyn(rdsReg);
    let off=RDS_OFF.indexOf(sy); if(off<0 && sy===RDS_OFFC2) off=2;
    if(off<0) return;
    // два блока подряд на правильном расстоянии и в правильном порядке — синхронизация есть
    if(rdsLastHit>=0){
      const dist=rdsBitN-rdsLastHit, steps=((off-rdsLastOff)+4)%4||4;
      if(dist===steps*26){ rdsSync=true; rdsExp=(off+1)%4; rdsBitN=0; rdsErr=[];
        rdsBlk[off]=(rdsReg>>>10)&0xffff; rdsOk.fill(false); rdsOk[off]=true; rdsLastHit=-1; return; }
    }
    rdsLastHit=rdsBitN; rdsLastOff=off; return;
  }
  if(rdsBitN<26) return;
  rdsBitN=0;
  const sy=rdsSyn(rdsReg), want=RDS_OFF[rdsExp];
  const ok = sy===want || (rdsExp===2 && sy===RDS_OFFC2);
  rdsBlk[rdsExp]=(rdsReg>>>10)&0xffff; rdsOk[rdsExp]=ok;
  rdsErr.push(ok?0:1); if(rdsErr.length>50) rdsErr.shift();
  if(rdsExp===3){ rdsGroup(); rdsOk.fill(false); }
  rdsExp=(rdsExp+1)%4;
  if(rdsErr.length>=10 && rdsErr.reduce((x,y)=>x+y,0)>rdsErr.length*0.4){ rdsSync=false; rdsLastHit=-1; }
}
// отсчёт RDS-бейзбенда на rdsFs: фаза BPSK → согласованный бифазный фильтр → тактовая синхронизация
function rdsSample(ri,rq){
  const a=0.002;
  rdsCII+=(ri*ri-rdsCII)*a; rdsCQQ+=(rq*rq-rdsCQQ)*a; rdsCIQ+=(ri*rq-rdsCIQ)*a;
  const th=0.5*Math.atan2(2*rdsCIQ, rdsCII-rdsCQQ);
  const y=ri*Math.cos(th)+rq*Math.sin(th);
  const L=2*rdsH;
  rdsY[rdsYi]=y; rdsYi=(rdsYi+1)%L;
  // m[n] = сумма первой половины бита минус сумма второй (бифазный символ +,-)
  let m=0; for(let k=0;k<L;k++){ const v=rdsY[(rdsYi+k)%L]; m += k<rdsH ? v : -v; }
  rdsM[rdsN%3]=m; rdsN++;
  if(rdsN<rdsNext+1) return;
  // решение по m в момент rdsNext, подстройка такта по разнице соседних |m| (ранний/поздний)
  const mc=rdsM[(rdsN-2)%3], me=rdsM[(rdsN-3+3)%3], ml=rdsM[(rdsN-1)%3];
  const err=(Math.abs(ml)-Math.abs(me))/(Math.abs(mc)+1e-12);
  rdsNext+=rdsTb+Math.max(-0.5,Math.min(0.5,0.25*err));
  const bit=mc>0?1:0, dbit=bit^rdsPrevBit; rdsPrevBit=bit;
  rdsBit(dbit);
}

function applyConfig(msg){
  mode=msg.mode; sr=msg.sr; bw=msg.bw; deemph=msg.deemph; agcOn=msg.agc!==false; stereoOn=msg.stereo!==false;
  plan=rtlPlan(mode, sr, bw);
  isAM=mode==='AM'; isSAM=mode==='SAM'; isSSB=(mode==='USB'||mode==='LSB'); isFM=!isAM&&!isSAM&&!isSSB;
  decA=mkDec(makeLP(sr, plan.pass, plan.stop, 2047), plan.d1, true);
  decB=isSSB||isSAM ? null : mkDec(makeLP(plan.ir, plan.aPass, plan.aStop, 1023), plan.d2, false);
  decC=isAM||isSAM ? mkDec(makeLP(plan.ir, plan.pass, plan.cStop, 1023), 1, true) : null;
  decM=null; mHi=null;
  if(!decC){
    const half=isSSB ? plan.pass/2 : plan.pass, h=makeLP(plan.ir, half, half+Math.max(300, 0.15*half), 1023);
    decM=mkDec(h, 1, true);
    if(isSSB){                                     // сдвиг на ±bw/2: полоса [0,bw] у USB, [−bw,0] у LSB
      const N=h.length, M=(N-1)/2, w=2*Math.PI*(mode==='USB'?-1:1)*half/plan.ir;   // знак — история идёт от старых к новым
      decM.h=new Float32Array(N); mHi=new Float32Array(N);
      for(let k=0;k<N;k++){ decM.h[k]=h[k]*Math.cos(w*(k-M)); mHi[k]=h[k]*Math.sin(w*(k-M)); }
    }
    mStep=Math.max(1, Math.round(plan.ir/12000)); mCnt=mStep;
  }
  isWFM=mode==='WFM';
  if(isWFM){
    decS=mkDec(decB.h, plan.d2, false);                            // L-R — тот же аудиофильтр, что у L+R: задержки совпадают
    const ir=plan.ir, w0=2*Math.PI*19000/ir, Q=12, al=Math.sin(w0)/(2*Q), a0=1+al;
    pbB0=al/a0; pbA1=-2*Math.cos(w0)/a0; pbA2=(1-al)/a0;
    plW0c=Math.cos(w0); plW0s=Math.sin(w0);
    const wn=2*Math.PI*15/ir, z=0.707;                             // полоса ФАПЧ ~15 Гц
    plKp=2*z*wn/0.5; plKi=wn*wn/0.5;
    plAmpA=Math.exp(-1/(0.05*ir)); plLockA=Math.exp(-1/(0.2*ir));
    const rD=Math.max(1,Math.round(ir/12000));
    decR=mkDec(makeLP(ir, 2400, 4500, 1023), rD, true);
    rdsFs=ir/rD; rdsTb=rdsFs/1187.5; rdsH=Math.max(2,Math.round(rdsFs/2375));
    rdsY=new Float32Array(2*rdsH); rdsM=new Float32Array(3); rdsReset();
  } else { decS=null; decR=null; }
  if(isSSB) mkSideband(bw/2, mode==='USB'?1:-1);
  // NB: порог в разах от средней мощности; off — 0
  nbK={low:36, mid:20, high:9}[msg.nb]||0;
  if(nbK){
    const d=Math.max(2, Math.round(sr*10e-6));
    if(!nbI || nbD!==d){ nbD=d; nbI=new Float32Array(d); nbQ=new Float32Array(d); nbPos=0; nbCnt=0; }
    nbPost=Math.round(sr*20e-6); nbA=1-Math.exp(-1/(0.01*sr));
  }
  const anfWas=anfOn;
  anfOn=!!msg.anf && (isAM||isSAM||isSSB);
  if(anfOn && !anfWas){ anfL=anfMake(); anfR=anfMake(); }
  if(isSAM){
    samSb={USB:1,LSB:-1,ISB:2}[msg.samSb]||0;
    if(samSb) mkSideband(plan.pass/2, 1);          // фильтр верхней; нижняя — сопряжённый, считается тем же проходом
    else decB=mkDec(new Float32Array(1), 1, true);   // не используется, нужен только как объект
    // ФАПЧ 2-го порядка, ζ=0.707: широкая (~100 Гц) на захват, узкая (~20 Гц) в захвате —
    // держит фазу через замирания несущей. Детектор — atan2, от амплитуды не зависит.
    const kk=(bn)=>{ const wn=2*Math.PI*bn/0.53/plan.ir; return [2*0.707*wn, wn*wn]; };
    [samKpW,samKiW]=kk(100); [samKpN,samKiN]=kk(20);
    samWmax=2*Math.PI*plan.pass/plan.ir;
    // ФНЧ перед детектором: модуляция и помехи меньше качают фазу (иначе утечка в чужую боковую).
    // При захвате — одна ступень (биения несущей должны доходить до детектора), в захвате — две
    samFA=Math.exp(-2*Math.PI*400/plan.ir);
    samLockA=Math.exp(-1/(0.15*plan.ir)); samCarA=Math.exp(-1/(0.5*plan.ir));
  }
  const dev = mode==='WFM' ? 75000 : 5000;
  discScale=plan.ir/(2*Math.PI)/dev;
  const tau={'75':75e-6,'50':50e-6}[deemph];
  deA = mode==='WFM'&&tau ? Math.exp(-1/(tau*plan.ar)) : null; deA1=deA!=null?1-deA:0;
  hpA=Math.exp(-2*Math.PI*20/plan.ar); hpA1=1-hpA;
  rawA=Math.exp(-2*Math.PI*150/sr); rawA1=1-rawA;
  agcHoldN=Math.round(0.3*plan.ar); agcRel=Math.exp(-1/(0.4*plan.ar));   // удержание 0.3 с, спад τ=0.4 с
  applyOffset(offsetHz);
}
// комплексный полосовой: ФНЧ half (переход 300 Гц у нуля), сдвинутый на sgn·half → 0..2·half одной стороны
function mkSideband(half, sgn){
  const lp=makeLP(plan.ir, half-150, half+150, 1023), N=lp.length, M=(N-1)/2;
  const f0=sgn*half/plan.ir;
  ssbN=N; ssbHr=new Float32Array(N); ssbHi=new Float32Array(N);
  // свёртка идёт по окну от старого к новому, поэтому ядро разворачиваем по времени
  for(let k=0;k<N;k++){ const t=M-k; ssbHr[k]=lp[k]*Math.cos(2*Math.PI*f0*t); ssbHi[k]=lp[k]*Math.sin(2*Math.PI*f0*t); }
  decB=mkDec(new Float32Array(1), 1, true);    // только как кольцо истории для фильтра
  decB.N=N; decB.bi=new Float32Array(2*N); decB.bq=new Float32Array(2*N);
}
function applyOffset(hz){
  offsetHz=hz;
  if(hz===0){ offPhI=1; offPhQ=0; }
  const inc=-2*Math.PI*hz/sr;
  offCos=Math.cos(inc); offSin=Math.sin(inc);
}
function resetState(){
  rawI0=rawQ0=prevI=prevQ=ampDc=audDc=de=0; offPhI=1; offPhQ=0; agcPk=AGC_TARGET/AGC_MAXGAIN; agcHold=0;
  samPh=0; samW=0; samLock=0; samWide=true; samCar=0.01; samFi=samFq=samF2i=samF2q=0; samDcR=0;
  nbAvg=0; nbCnt=0; if(nbI){ nbI.fill(0); nbQ.fill(0); }
  if(anfOn){ anfL=anfMake(); anfR=anfMake(); }
  for(const d of [decA,decB,decC,decS,decR,decM]) if(d){ d.bi.fill(0); if(d.bq) d.bq.fill(0); d.pos=0; d.cnt=d.D; }
  pbX1=pbX2=pbY1=pbY2=0; plRe=1; plIm=0; plInt=0; plAmp=0.05; plLock=0; stG=0; deR=0; audDcR=0;
  if(isWFM) rdsReset();
}

self.onmessage=function(e){
  const msg=e.data;
  if(msg.type==='config'){ applyConfig(msg); return; }
  if(msg.type==='offset'){ applyOffset(msg.hz); return; }
  if(msg.type==='reset'){ resetState(); return; }
  if(msg.type==='rdsReset'){ if(isWFM) rdsReset(); return; }
  if(msg.type==='giveBuffer'){ bufPool.push(msg.buffer); return; }
  if(msg.type!=='demod' || !plan) return;
  const tStart=performance.now();
  const u8=new Uint8Array(msg.buffer), cnt=msg.cnt, s16=msg.fmt==='s16' ? new Int16Array(msg.buffer, 0, 2*cnt) : null;
  const maxOut=Math.floor(cnt/plan.decim)+3;
  let outAB=null;
  while(bufPool.length){ const b=bufPool.pop(); if(b.byteLength===maxOut*8){ outAB=b; break; } }
  const outBuf=outAB ? new Float32Array(outAB) : new Float32Array(2*maxOut);
  const out=outBuf.subarray(0,maxOut), outR=outBuf.subarray(maxOut);
  const offZero=offsetHz===0;
  // локальные копии горячего состояния
  const hA=decA.h, NA=decA.N, DA=decA.D, biA=decA.bi, bqA=decA.bq;
  let posA=decA.pos, cntA=decA.cnt;
  const B=decB, hB=B.h, NB=B.N, DB=B.D, biB=B.bi, bqB=B.bq;
  let posB=B.pos, cntB=B.cnt;
  const S=decS, biS=S?S.bi:null, R=decR, hR=R?R.h:null, NR=R?R.N:0, DR=R?R.D:0, biR=R?R.bi:null, bqR=R?R.bq:null;
  let posR=R?R.pos:0, cntR=R?R.cnt:0, vS=0;
  const C=decC, hC=C?C.h:null, NC=C?C.N:0, biC=C?C.bi:null, bqC=C?C.bq:null;
  let posC=C?C.pos:0;
  let wIdx=0, chPw=0, chPn=0;
  for(let k=0;k<cnt;k++){
    const rawI=s16 ? s16[2*k]/32768 : (u8[2*k]-127.5)/127.5, rawQ=s16 ? s16[2*k+1]/32768 : (u8[2*k+1]-127.5)/127.5;
    rawI0=rawI0*rawA+rawI*rawA1; rawQ0=rawQ0*rawA+rawQ*rawA1;
    let i=rawI-rawI0, q=rawQ-rawQ0;
    if(nbK){
      const p=i*i+q*q, th=nbK*nbAvg;
      if(nbAvg<1e-12) nbAvg=p;
      else if(p>th) nbCnt=nbD+nbPost;
      nbAvg+=((p>th?th:p)-nbAvg)*nbA;              // импульсы в среднее — только по порогу
      const di=nbI[nbPos], dq=nbQ[nbPos]; nbI[nbPos]=i; nbQ[nbPos]=q;
      if(++nbPos===nbD) nbPos=0;
      if(nbCnt>0){ nbCnt--; i=0; q=0; } else { i=di; q=dq; }
    }
    if(!offZero){
      const oi=i*offPhI-q*offPhQ, oq=i*offPhQ+q*offPhI; i=oi; q=oq;
      const nI=offPhI*offCos-offPhQ*offSin, nQ=offPhI*offSin+offPhQ*offCos;
      const nrm=1.5-0.5*(nI*nI+nQ*nQ); offPhI=nI*nrm; offPhQ=nQ*nrm;
    }
    biA[posA]=i; biA[posA+NA]=i; bqA[posA]=q; bqA[posA+NA]=q;
    if(++posA===NA) posA=0;
    if(--cntA>0) continue;
    cntA=DA;
    // канальный FIR на выходной частоте ir
    let ci=0, cq=0;
    for(let t=0;t<NA;t++){ const c=hA[t]; ci+=c*biA[posA+t]; cq+=c*bqA[posA+t]; }
    if(C){                                       // AM/SAM: крутой канальный фильтр перед детектором
      biC[posC]=ci; biC[posC+NC]=ci; bqC[posC]=cq; bqC[posC+NC]=cq;
      if(++posC===NC) posC=0;
      ci=0; cq=0;
      for(let t=0;t<NC;t++){ const c=hC[t]; ci+=c*biC[posC+t]; cq+=c*bqC[posC+t]; }
    }
    if(decM){                                      // мощность в полосе канала — для RSSI
      const hM=decM.h, NM=decM.N, bi=decM.bi, bq=decM.bq; let pM=decM.pos;
      bi[pM]=ci; bi[pM+NM]=ci; bq[pM]=cq; bq[pM+NM]=cq;
      if(++pM===NM) pM=0;
      decM.pos=pM;
      if(--mCnt<=0){
        mCnt=mStep;
        let yi=0, yq=0;
        if(mHi) for(let t=0;t<NM;t++){ const hr=hM[t], hi=mHi[t], xi=bi[pM+t], xq=bq[pM+t]; yi+=hr*xi-hi*xq; yq+=hr*xq+hi*xi; }
        else    for(let t=0;t<NM;t++){ const c=hM[t]; yi+=c*bi[pM+t]; yq+=c*bq[pM+t]; }
        chPw+=yi*yi+yq*yq; chPn++;
      }
    } else { chPw+=ci*ci+cq*cq; chPn++; }
    let v;
    if(isSAM){
      // перенос на несущую: z = c·e^{-jφ}; в захвате несущая — на I, модуляция — тоже на I
      const pc=Math.cos(samPh), ps=Math.sin(samPh);
      const zi=ci*pc+cq*ps, zq=cq*pc-ci*ps;
      const fa=samFA, fb=1-fa;
      samFi=samFi*fa+zi*fb; samFq=samFq*fa+zq*fb; samF2i=samF2i*fa+samFi*fb; samF2q=samF2q*fa+samFq*fb;
      const di=samWide?samFi:samF2i, dq=samWide?samFq:samF2q;
      const e=Math.atan2(dq, di), mag=Math.sqrt(di*di+dq*dq);
      samLock=samLock*samLockA+(mag>0 ? di/mag : 0)*(1-samLockA);
      if(samWide && samLock>0.7) samWide=false; else if(!samWide && samLock<0.4) samWide=true;
      samW+=(samWide?samKiW:samKiN)*e;
      if(samW>samWmax) samW=samWmax; else if(samW<-samWmax) samW=-samWmax;
      samPh+=samW+(samWide?samKpW:samKpN)*e;
      if(samPh>Math.PI) samPh-=2*Math.PI; else if(samPh<-Math.PI) samPh+=2*Math.PI;
      let x=zi, xr=0;
      if(samSb){
        biB[posB]=zi; biB[posB+NB]=zi; bqB[posB]=zq; bqB[posB+NB]=zq;
        if(++posB===NB) posB=0;
        let a=0, b=0;
        for(let t=0;t<NB;t++){ a+=ssbHr[t]*biB[posB+t]; b+=ssbHi[t]*bqB[posB+t]; }
        // Re аналитического сигнала одной боковой ×2 = несущая + m(t); верхняя a−b, нижняя a+b
        x = samSb===-1 ? 2*(a+b) : 2*(a-b); xr=2*(a+b);
      }
      ampDc+=(x-ampDc)*0.0005;
      samCar=samCar*samCarA+(zi>0?zi:0)*(1-samCarA);
      // АРУ — по несущей с медленным τ=0.5 с: короткие провалы несущей при замираниях не раскачивают громкость
      const g = agcOn ? 0.5/Math.max(samCar,1e-5) : 3;
      v=(x-ampDc)*g;
      if(samSb===2){ samDcR+=(xr-samDcR)*0.0005; vS=(xr-samDcR)*g; }   // ISB: L — верхняя, R — нижняя
    } else if(isSSB){
      biB[posB]=ci; biB[posB+NB]=ci; bqB[posB]=cq; bqB[posB+NB]=cq;
      if(++posB===NB) posB=0;
      let y=0;
      for(let t=0;t<NB;t++) y+=ssbHr[t]*biB[posB+t]-ssbHi[t]*bqB[posB+t];
      v=y*3;
    } else {
      if(isAM){
        const env=Math.sqrt(ci*ci+cq*cq);
        ampDc+=(env-ampDc)*0.0005;
        // с АРУ — глубина модуляции относительно несущей: громкость не зависит от силы станции
        v = agcOn ? (env-ampDc)/Math.max(ampDc,1e-5)*0.5 : (env-ampDc)*3;
      } else {
        const re=ci*prevI+cq*prevQ, im=cq*prevI-ci*prevQ;
        v=Math.atan2(im,re)*discScale;
        prevI=ci; prevQ=cq;
      }
      if(isWFM){
        // ФАПЧ по пилоту: биквад 19 кГц → нормировка → фазовый детектор pb·cosφ → ПИ-фильтр
        const pb=pbB0*v-pbB0*pbX2-pbA1*pbY1-pbA2*pbY2;
        pbX2=pbX1; pbX1=v; pbY2=pbY1; pbY1=pb;
        plAmp=plAmp*plAmpA+(pb<0?-pb:pb)*(1-plAmpA);
        const pn=pb/(plAmp*1.5708+1e-9), e=pn*plRe;
        plLock=plLock*plLockA+pn*plIm*(1-plLockA);
        // sin2φ, cos3φ, sin3φ — из фазора ЭТОГО отсчёта, до шага вперёд (иначе опережение на отсчёт:
        // на 38 кГц это ~50° и почти половина разделения каналов)
        const c2=plRe*plRe-plIm*plIm, s2=2*plRe*plIm, c3=c2*plRe-s2*plIm, s3=s2*plRe+c2*plIm;
        plInt+=plKi*e;
        const d=plKp*e+plInt;                                      // поправка фазы к номинальным 19 кГц
        let nr=plRe*plW0c-plIm*plW0s, ni=plRe*plW0s+plIm*plW0c;
        const dr=1-d*d*0.5; const tr=nr*dr-ni*d; ni=nr*d+ni*dr; nr=tr;
        const nn=1.5-0.5*(nr*nr+ni*ni); plRe=nr*nn; plIm=ni*nn;
        vS=v*2*s2;
        biS[S.pos]=vS; biS[S.pos+NB]=vS; if(++S.pos===NB) S.pos=0;
        // RDS
        const ri=v*c3, rq=v*s3;
        biR[posR]=ri; biR[posR+NR]=ri; bqR[posR]=rq; bqR[posR+NR]=rq;
        if(++posR===NR) posR=0;
        if(--cntR<=0){
          cntR=DR;
          let si=0, sq=0;
          for(let t=0;t<NR;t++){ const c=hR[t]; si+=c*biR[posR+t]; sq+=c*bqR[posR+t]; }
          rdsSample(si,sq);
        }
      }
      biB[posB]=v; biB[posB+NB]=v;
      if(++posB===NB) posB=0;
      if(--cntB>0) continue;
      cntB=DB;
      let y=0;
      for(let t=0;t<NB;t++) y+=hB[t]*biB[posB+t];
      v=y;
      if(isWFM){
        let ys=0;
        for(let t=0;t<NB;t++) ys+=hB[t]*biS[S.pos+t];
        // стерео — только при захваченном пилоте, включается/выключается плавно
        const want=(stereoOn && plLock>0.3 && plAmp>0.01)?1:0;
        stG+=(want-stG)*0.002;
        vS=ys*stG;
      }
    }
    let oR;
    if(isWFM){
      // L = M+S, R = M-S; у каждого канала свой DC-блок и де-эмфазис
      const l=v+vS, r=v-vS;
      audDc=audDc*hpA+l*hpA1; audDcR=audDcR*hpA+r*hpA1;
      let ol=l-audDc, orr=r-audDcR;
      if(deA!=null){ de=de*deA+ol*deA1; ol=de; deR=deR*deA+orr*deA1; orr=deR; }
      out[wIdx]=ol; outR[wIdx++]=orr;
      continue;
    }
    audDc=audDc*hpA+v*hpA1;
    let o=v-audDc;
    if(deA!=null){ de=de*deA+o*deA1; o=de; }
    const isb=isSAM && samSb===2;
    if(isb){ audDcR=audDcR*hpA+vS*hpA1; oR=vS-audDcR; }
    if(anfOn){ o=anfStep(anfL, o); if(isb) oR=anfStep(anfR, oR); }
    if(isSSB && agcOn){
      const a=o<0?-o:o;
      if(a>=agcPk){ agcPk=a; agcHold=agcHoldN; }
      else if(agcHold>0) agcHold--;
      else agcPk=Math.max(AGC_TARGET/AGC_MAXGAIN, agcPk*agcRel);
      o*=AGC_TARGET/agcPk;
    }
    out[wIdx]=o; outR[wIdx++]=isb ? oR : o;
  }
  decA.pos=posA; decA.cnt=cntA; B.pos=posB; B.cnt=cntB;
  if(C) C.pos=posC;
  if(isSAM){
    const now=performance.now();
    if(now-samPostT>250){ samPostT=now; self.postMessage({type:'sam', lock:samLock>0.6, hz:samW*plan.ir/(2*Math.PI)}); }
  }
  if(R){ R.pos=posR; R.cnt=cntR; }
  if(isWFM){
    const now=performance.now();
    if(rdsDirty && now-rdsPostT>250){
      rdsDirty=false; rdsPostT=now;
      self.postMessage({type:'rds', pi:rdsPI, pty:rdsPTY, tp:rdsTP, ps:rdsPS.join(''),
        rt:rdsRT.join('').split('\\r')[0].replace(/\\s+$/,''), sync:rdsSync});
    }
    if(now-(self._stPostT||0)>500){ self._stPostT=now; self.postMessage({type:'stereo', stereo:stG>0.5, pilot:plLock}); }
  }
  // workerMs — время самого цикла, без доставки сообщений (её меряет readerLoop отдельно)
  self.postMessage({type:'result', id:msg.id, buffer:outBuf.buffer, cnt:wIdx, stride:maxOut, workerMs:performance.now()-tStart,
    chPw, chPn}, [outBuf.buffer]);
};
`;

function rtlMakeDemodWorker(){
  const url=URL.createObjectURL(new Blob([RTL_WORKER_SRC], {type:'application/javascript'}));
  const worker=new Worker(url);
  let nextId=1;
  const pending=new Map(); // несколько чанков могут ждать ответа одновременно
  const api={onInfo:null};
  worker.onmessage=(e)=>{
    const msg=e.data;
    if(msg.type==='rds' || msg.type==='stereo' || msg.type==='sam'){ api.onInfo?.(msg); return; }
    if(msg.type==='result' && pending.has(msg.id)){
      const resolve=pending.get(msg.id); pending.delete(msg.id);
      // buffer — сырой ArrayBuffer (вызывающий сам решает, когда вернуть его через giveBuffer());
      // cnt — сколько АУДИО-отсчётов в нём реально лежит после децимации внутри воркера (может
      // быть заметно меньше числа входных IQ-отсчётов, см. decim в RTL_WORKER_SRC);
      // workerMs — честное время именно вычислений внутри воркера, см. комментарий там же
      resolve({buffer:msg.buffer, cnt:msg.cnt, stride:msg.stride, workerMs:msg.workerMs, chPw:msg.chPw, chPn:msg.chPn});
    }
  };
  return Object.assign(api, {
    config(cfg){ worker.postMessage({type:'config', ...cfg}); },
    reset(){ worker.postMessage({type:'reset'}); },
    setOffset(hz){ worker.postMessage({type:'offset', hz}); }, // дешёвая перестройка частоты настройки — без сброса фильтров/фазы
    rdsReset(){ worker.postMessage({type:'rdsReset'}); },
    demod(u8buffer, cnt, fmt){            // buffer передаётся с переносом владения (zero-copy)
      return new Promise((resolve)=>{
        const id=nextId++;
        pending.set(id, resolve);
        worker.postMessage({type:'demod', id, buffer:u8buffer, cnt, fmt}, [u8buffer]);
      });
    },
    giveBuffer(buffer){ worker.postMessage({type:'giveBuffer', buffer}, [buffer]); }, // вернуть буфер воркеру для переиспользования
    terminate(){ worker.terminate(); URL.revokeObjectURL(url); }
  });
}

// Многоканальный приём: до 4 независимых NCO-демодуляторов над одним сырым потоком USB.
// Индекс 0 — «основной» канал (порты 'tuneFreq'/'audio' без цифры), он же единственный, кто
// умеет физически переставлять центр (см. rtlsdr.process()) — активен всегда, как и раньше,
// для обратной совместимости со старыми патчами. Каналы 1-3 ('tuneFreq2..4'/'audio2..4') —
// просто NCO-офсет в пределах уже захваченной полосы, без переустановки центра: одновременно
// можно слушать только то, что помещается в одну физически настроенную полосу приёма.
// Поднимаются лениво — воркер и кольцо создаются только когда на их tuneFreq реально пришло число.
const RTL_CH_SUFFIX=['','2','3','4'];
function rtlActivateChannel(n, ci){
  const ch=n.ch[ci];
  if(ch.active && ch.worker) return;
  ch.worker=rtlMakeDemodWorker();
  ch.rds=null; ch.stereo=false; ch.sam=null;
  ch.worker.onInfo=m=>{ if(m.type==='rds') ch.rds=m; else if(m.type==='sam') ch.sam=m; else ch.stereo=m.stereo; };
  ch.worker.config(rtlWorkerCfg(n));
  ch.worker.reset();
  ch.hardKey=n.p.demod+'|'+n.sourceRate; ch.softKey=rtlSoftKey(n);
  n.decim=rtlDecimFor(n.p.demod, n.sourceRate, n.p.bw);
  rtlResizeChannelRing(n, ch);
  ch.appliedOffset=0;
  ch.active=true;
}

const RTL_MAX_INFLIGHT=8;
const RTL_READS_PER_SEC=40;  // чанк 25мс — меньше пила уровня кольца, можно держать меньший запас
const RTL_USB_QUEUE=8;       // трансферов в полёте, ~200мс запаса на стопор главного потока
// Темп чтения колец (rtlPace): держим запас около RTL_TARGET_S — это и есть задержка звука от кольца.
// Дрейф часов донгла относительно звуковой карты (десятки ppm) выбирается подстройкой шага чтения
// в пределах ±RTL_SERVO_PPM — тайминг символов цифровых протоколов это не ломает. Если запас вырос
// выше RTL_DROP_S (стопор главного потока, после которого данные накопились), лишнее роняем сразу,
// иначе сервоприводу пришлось бы съедать его минутами.
const RTL_TARGET_S=0.08;
const RTL_FILE_TARGET_S=0.3;  // файл: задержка не важна, нужен запас на заминки чтения и главного потока
const RTL_DROP_S=0.3;
const RTL_SERVO_PPM=500;
const RTL_EXCESS=2;         // средний запас выше target×RTL_EXCESS — сброс до target
const RTL_SERVO_G=0.01;      // EMA уровня кольца на блок движка, τ ≈ 1с при BLOCK=512/48к

// Перегруз АЦП за окно ~0.5 с: доля компонент I/Q на рельсах (u8 — 0/255, s16 — >=97% шкалы),
// пик компоненты и средняя мощность в dBFS (0 дБ — комплексный тон полной шкалы, как у 'spec').
// У Airspy IQ идёт после полуполосного конвертера: полная шкала АЦП там — половина int16.
const SDR_ADC_WIN_MS=500, SDR_ADC_HOLD_MS=3000, SDR_ADC_CLIP=1e-4;
function sdrAdcStat(n, u8, s16){
  const st=n.adcAcc||(n.adcAcc={cnt:0, clip:0, pk:0, pw:0, t0:performance.now()});
  let clip=0, pk=0, pw=0, len;
  if(s16){
    const fs=n.dev?.kind==='airspy' ? 16384 : 32768, thr=0.97*fs;
    len=s16.length;
    for(let i=0;i<len;i++){ const v=s16[i], a=v<0?-v:v; if(a>pk) pk=a; if(a>=thr) clip++; pw+=v*v; }
    pk/=fs; pw/=fs*fs;
  } else {
    len=u8.length;
    for(let i=0;i<len;i++){ const b=u8[i], d=b-127.5; if(b===0||b===255) clip++; const a=d<0?-d:d; if(a>pk) pk=a; pw+=d*d; }
    pk/=127.5; pw/=127.5*127.5;
  }
  st.cnt+=len; st.clip+=clip; st.pw+=pw; if(pk>st.pk) st.pk=pk;
  const now=performance.now();
  if(now-st.t0<SDR_ADC_WIN_MS || !st.cnt) return;
  n.adcPk=20*Math.log10(st.pk+1e-9);
  n.adcRms=10*Math.log10(2*st.pw/st.cnt+1e-18);      // I²+Q² на комплексный отсчёт
  n.adcClip=st.clip/st.cnt;
  if(n.adcClip>=SDR_ADC_CLIP){ n.adcOvlT=now; n.adcOvlClip=n.adcClip; }
  st.cnt=0; st.clip=0; st.pw=0; st.pk=0; st.t0=now;
}
const sdrAdcOvl=n=>n.adcOvlT!=null && performance.now()-n.adcOvlT<SDR_ADC_HOLD_MS;

async function rtlReadLoop(n){
  let errStreak=0;
  n.mspsAcc=0; n.mspsIoMs=0; n.mspsWorkerMs=0; n.mspsWinStart=performance.now(); n.msps=0; n.mspsIo=0;

  // Демодуляция чанка запускается в воркере и НЕ ждётся здесь же — иначе время round-trip'а
  // до воркера (структурное клонирование буфера, планировщик, сама математика фильтра) прямо
  // вычиталось бы из бюджета на следующее USB-чтение: любая заминка воркера (пауза GC, всплеск
  // нагрузки от остального UI) била бы по непрерывности чтения из USB, а не только по итоговому
  // звуку — и именно тут раньше рвался поток, хотя визуально спектр (снимается отдельно, чуть
  // раньше, синхронно) успевал остаться на вид ровным.
  // Запись демодулированного аудио в кольцо канала при этом всё равно СТРОГО по порядку прихода
  // чанков, а не по порядку завершения демодуляции — appendChain навешивается на чанк сразу по
  // приходу (пока порядок ещё гарантирован тем же аргументом про FIFO ниже), поэтому даже если
  // демод чанка N закончится позже чанка N+1 (два воркера, разная сиюминутная загрузка), в кольцо
  // они всё равно лягут в правильном порядке — без этого возможна перестановка кусков звука
  // местами, которая на слух звучит как случайные щелчки/затыки, а не как чистая тишина.
  let appendChain=Promise.resolve();
  let inFlight=0;
  // Бэкпрешер НИКОГДА не тормозит само чтение USB — это живой АЦП, который передаёт данные
  // независимо от того, готов ли софт их принять. Пауза здесь — это не "подождать немного",
  // это реальная потеря сэмплов на стороне хоста/устройства, причём НЕЗАМЕЧЕННАЯ: n.written
  // в кольце просто продолжит расти на cnt за чанк, как ни в чём не бывало, и потребитель
  // (который переводит время через n.sourceRate) склеит разрыв как непрерывный поток — на слух
  // это будет звучать не как затык, а как ускорение/писк (кусок реального времени пропал, но
  // отсчитывается как будто прошёл). Поэтому вместо паузы, когда демод не поспевает, чанк
  // просто НЕ уходит в воркер — на его место в кольцо честно пишется тишина той же длины
  // (cnt), чтобы n.written по-прежнему отражал реальное время, а не альтернативную историю.
  const MAX_INFLIGHT=RTL_MAX_INFLIGHT;

  // Очередь из RTL_USB_QUEUE трансферов в полёте, как у librtlsdr/webrtlsdr. При одном трансфере
  // донгл простаивает между завершением и следующим transferIn (IPC браузера + занятость главного
  // потока), его FIFO переполняется и отсчёты теряются — отсюда был устойчивый дефицит mspsIo
  // в 1-3% от nominal. Порядок сохраняется: bulk-эндпоинт FIFO, трансферы завершаются по очереди.
  const READS_PER_SEC=RTL_READS_PER_SEC;
  const chunkPeriodMs=1000/READS_PER_SEC;
  let prevReadEnd=null;   // для диагностики: разрыв ДО чтения = главный поток был занят чем-то другим
  // цикл привязан к своему устройству: после быстрого переподключения старый цикл не должен читать новое
  const dev=n.dev;
  async function readerLoop(){
    const src=dev.worker ? rtlWorkerSource(n) : rtlLocalSource(n);
    while(n.reading && n.dev===dev){
      const t0=performance.now();
      // на локальном пути разрыв, близкий к ёмкости очереди, = донгл мог потерять данные
      if(prevReadEnd!=null && !n.dev.worker){
        const gap=t0-prevReadEnd;
        if(gap>chunkPeriodMs*(RTL_USB_QUEUE-1)) console.warn(`[rtlsdr] gap перед USB-чтением ${gap.toFixed(1)}ms (ожидалось ~${chunkPeriodMs.toFixed(0)}ms) @ ${t0.toFixed(0)}ms`);
      }
      const res=await src.next();
      if(!res || n.dev!==dev) break;
      if(res.err){
        errStreak++;
        n.status='read error ('+errStreak+'/5): '+res.err.message;
        if(errStreak>=5){ n.reading=false; break; }
        await src.recover();
        prevReadEnd=null;
        continue;
      }
      errStreak=0;
      const buf=res.buf, t1=performance.now();
      // ioMs — интервал между приходами чанков, в среднем = реальное время чанка
      const ioMs=prevReadEnd!=null ? t1-prevReadEnd : chunkPeriodMs;
      prevReadEnd=t1;
      if(n.rec && !n.swActive) iqRecWrite(n, buf, res.epoch);
      const u8=new Uint8Array(buf), fmt=n.dev.fmt, s16=fmt==='s16' ? new Int16Array(buf) : null;
      sdrAdcStat(n, u8, s16);
      if(n.swActive){
        const cap=n.swCap;
        if(cap && res.epoch===cap.epoch) sdrSweepFeed(n, cap, u8, s16);
        rtlTrackMsps(n, s16 ? s16.length>>1 : u8.length>>1, ioMs, 0);
        continue;
      }
      const cnt=s16 ? s16.length>>1 : u8.length>>1, mode=n.p.demod, specRing=n.specRing;
      // Циклический индекс — сравнение+обнуление, а не % на каждый отсчёт: при типичных chunkSamples
      // (десятки тысяч на USB-чтение, READS_PER_SEC раз в секунду) деление в modulo было заметной
      // главно-поточной нагрузкой ровно там, где конкурирует с чтением USB/сообщениями демод-воркеру.
      // чанк, запущенный до последней перестройки, несёт отсчёты старой частоты — в спектр его не пускаем,
      // иначе картинка мечется между старым и новым местом, а за ней и окно 'sa' со steerFreq
      if(res.epoch==null || res.epoch>=(n._specEpoch||0))
      { let w=specRing.w, filled=specRing.filled; const I=specRing.I, Q=specRing.Q, size=specRing.size;
        for(let k=0;k<cnt;k++){
          if(s16){ I[w]=s16[2*k]/32768; Q[w]=s16[2*k+1]/32768; } else { I[w]=(u8[2*k]-127.5)/127.5; Q[w]=(u8[2*k+1]-127.5)/127.5; }
          w++; if(w>=size) w=0;
          if(filled<size) filled++;
        }
        specRing.w=w; specRing.filled=filled; specRing.written+=cnt;
        // выход 'iq' — копия сырого буфера; во float его переводит тот, кто читает (часто воркер острова)
        if(n.iqQ){
          n.iqQ.push({raw:s16 ? s16.slice() : u8.slice(), fmt:s16 ? 's16' : 'u8'}); n.iqQN+=cnt;
          while(n.iqQN>n.sourceRate && n.iqQ.length>1){ n.iqQN-=n.iqQ.shift().raw.length>>1; n.iqGap=true; }   // граф стоит
        } }
      if(mode==='IQ'){
        const ring=n.ring;
        { let w=ring.w, filled=ring.filled; const I=ring.I, Q=ring.Q, size=ring.size;
          for(let k=0;k<cnt;k++){
            if(s16){ I[w]=s16[2*k]/32768; Q[w]=s16[2*k+1]/32768; } else { I[w]=(u8[2*k]-127.5)/127.5; Q[w]=(u8[2*k+1]-127.5)/127.5; }
            w++; if(w>=size) w=0;
            if(filled<size) filled++;
          }
          ring.w=w; ring.filled=filled; }
        ring.written+=cnt;
        rtlTrackMsps(n, cnt, ioMs, 0);
        continue;
      }
      // раздаём чанк всем активным каналам параллельно — каждому своя копия (владение буфером
      // передаётся воркеру с переносом, один и тот же ArrayBuffer нельзя transfer'ить дважды)
      const active=n.ch.filter(ch=>ch.active&&ch.worker);
      if(!active.length){ rtlTrackMsps(n, cnt, ioMs, 0); continue; }
      if(inFlight>=MAX_INFLIGHT){
        // демод не поспевает за реальным временем (см. комментарий выше про MAX_INFLIGHT) —
        // этот чанк в воркер не идёт, вместо него в кольцо каждого канала честно дописывается
        // тишина ТОЙ ЖЕ длины, что дал бы демод — round(cnt/n.decim) децимированных отсчётов,
        // а не cnt сырых, иначе written разойдётся с реальным временем ровно так же, как раньше
        // расходился на паузе чтения (см. rtlDecimFor).
        const silentN=Math.max(1, Math.round(cnt/(n.decim||1)));
        for(const ch of active){
          const aring=ch.aring; if(!aring) continue;
          const A=aring.A, Bq=aring.B, size=aring.size; let w=aring.w, filled=aring.filled;
          for(let k=0;k<silentN;k++){ A[w]=0; Bq[w]=0; w=(w+1)%size; if(filled<size) filled++; }
          aring.w=w; aring.filled=filled; aring.written+=silentN;
        }
        n.underrunsWorker++;   // демод-воркер не успел — вход, не выход (см. readout)
        console.warn(`[rtlsdr] demod backpressure (inFlight=${inFlight}>=${MAX_INFLIGHT}) @ ${t1.toFixed(0)}ms`);
        rtlTrackMsps(n, cnt, ioMs, 0);
        continue;
      }
      // .slice() нужен только чтобы дать КАЖДОМУ каналу свою копию (один ArrayBuffer нельзя
      // transfer'ить дважды) — последнему каналу отдаём оригинал без копии: он и так последний
      // потребитель buf/u8 в этой итерации (при активном канале ровно 1 — самый частый случай —
      // это убирает лишнюю ~100КБ-аллокацию на каждый чанк, то есть на каждые ~50мс, целиком).
      const lastIdx=active.length-1;
      const demodPromise=Promise.all(active.map((ch,i)=>
        ch.worker.demod(i===lastIdx ? buf : u8.slice().buffer, cnt, fmt)));
      let tDemodDone=0;
      demodPromise.then(()=>{ tDemodDone=performance.now(); }, ()=>{});
      inFlight++;
      // .then() вешается СРАЗУ по приходу чанка (пока порядок ещё известен), но результат
      // пишется в кольцо только после того, как это же самое сделает предыдущий чанк —
      // appendChain и есть та самая гарантия порядка, о которой комментарий выше.
      appendChain=appendChain.then(async ()=>{
        let results;
        try{ results=await demodPromise; }
        catch(e){ inFlight--; return; }
        inFlight--;
        if(!n.reading) return;                    // отключились, пока чанк ждал своей очереди
        // wms — весь round-trip до воркера и обратно (структурное клонирование, доставка сообщения,
        // ожидание, пока главный поток дойдёт до обработки ответа) — НЕ то же самое, что реальное
        // время вычислений внутри воркера; для этого есть отдельно res.workerMs с каждого канала
        // (честно измерено там же, см. RTL_WORKER_SRC) — если wms заметно больше max(workerMs),
        // тормозит доставка/расписание, а не сама математика демодуляции.
        const wms=tDemodDone-t1;
        let workerMsMax=0;
        for(let ci=0;ci<active.length;ci++){
          const ch=active[ci], res=results[ci];
          if(res.workerMs>workerMsMax) workerMsMax=res.workerMs;
          if(!ch.active || !ch.aring){ ch.worker?.giveBuffer(res.buffer); continue; }  // канал сняли/пересобрали, пока чанк ждал
          const outN=res.cnt;                       // уже децимированное число отсчётов, не cnt (сырых)
          const audio=new Float32Array(res.buffer, 0, outN), audioR=new Float32Array(res.buffer, res.stride*4, outN);
          const aring=ch.aring;
          if(res.chPn) rtlChanLevel(n, ch, 10*Math.log10(res.chPw/res.chPn+1e-20));
          // шумоподавитель — здесь, а не при чтении: RSSI этого чанка относится ровно к этим отсчётам,
          // а чтение отстаёт от записи на запас кольца
          const g0=ch.sqG??1, g1=ch.sqOpen===false?0:1, rampN=Math.max(1,Math.min(outN, Math.round(n.sourceRate/(n.decim||1)*0.005)));
          if(g0!==1 || g1!==1) for(let k=0;k<outN;k++){ const g=k<rampN? g0+(g1-g0)*(k+1)/rampN : g1; audio[k]*=g; audioR[k]*=g; }
          ch.sqG=g1;
          let w=aring.w, filled=aring.filled;
          const A=aring.A, Bq=aring.B, size=aring.size;
          for(let k=0;k<outN;k++){ A[w]=audio[k]; Bq[w]=audioR[k]; w=(w+1)%size; if(filled<size) filled++; }
          aring.w=w; aring.filled=filled; aring.written+=outN;
          ch.worker.giveBuffer(res.buffer);
        }
        // сглаживаем — на глаз, не для точных измерений; резкий разовый выброс не должен дёргать цифру в статусе
        n.workerMs = n.workerMs==null ? workerMsMax : n.workerMs*0.8+workerMsMax*0.2;
        n.roundtripMs = n.roundtripMs==null ? wms : n.roundtripMs*0.8+wms*0.2;
        rtlTrackMsps(n, cnt, ioMs, wms);
      });
    }
  }

  await readerLoop();
  if(n.dev!==dev) return;                          // уже другое устройство — его состояние не трогаем
  if(dev.worker) dev.stopStream().catch(()=>{});
  n.connected=false;
}

// Источники чанков для readerLoop: next() → {buf} | {err} | null (конец), recover() — после ошибки.
// Локальный: очередь RTL_USB_QUEUE трансферов на главном потоке (браузер без WebUSB в воркерах).
function rtlLocalSource(n){
  const queue=[], dev=n.dev;
  const fill=()=>{
    while(n.reading && n.dev===dev && queue.length<RTL_USB_QUEUE){
      const cs=Math.max(512, Math.min(131072, 512*Math.ceil(n.sourceRate/(n.usbRps||RTL_READS_PER_SEC)/512)));
      const epoch=dev.epoch();
      queue.push(dev.readSamples(cs*dev.bps).then(buf=>({buf, epoch}), err=>({err})));
    }
  };
  fill();
  return {
    next(){ const p=queue.shift(); fill(); return p || Promise.resolve(null); },
    async recover(){
      while(queue.length) await queue.shift();       // остаток очереди после сбоя не нужен
      try{ if(n.dev===dev) await dev.resetBuffer(); }catch(e){}
      await new Promise(r=>setTimeout(r,50));
      fill();
    }
  };
}
// Воркерный: очередь трансферов крутит сам воркер, сюда приходят готовые чанки; сбой он тоже
// обрабатывает сам, поэтому recover() пустой.
function rtlWorkerSource(n){
  const ready=[], waiters=[];
  const push=r=>{ if(waiters.length) waiters.shift()(r); else ready.push(r); };
  n.dev.startStream(RTL_READS_PER_SEC, RTL_USB_QUEUE, m=>{
    if(m.end) push(null);
    else push(m.err ? {err:new Error(m.err)} : {buf:m.buf, epoch:m.epoch});
  }).catch(e=>push({err:e}));
  return {
    next(){ return ready.length ? Promise.resolve(ready.shift()) : new Promise(r=>waiters.push(r)); },
    async recover(){}
  };
}

// скользящее окно ~0.5с: честная сквозная скорость, раздельно I/O (само USB-чтение)
// и воркер (round-trip postMessage) — чтобы понимать, где именно теряется время
function rtlTrackMsps(n, cnt, ioMs, workerMs){
  n.mspsAcc+=cnt; n.mspsIoMs+=ioMs; n.mspsWorkerMs+=workerMs;
  const now=performance.now();
  if(now-n.mspsWinStart>500){
    const totalMs=n.mspsIoMs+n.mspsWorkerMs;
    n.msps=totalMs>0 ? (n.mspsAcc/totalMs/1000) : 0;
    n.mspsIo=n.mspsIoMs>0 ? (n.mspsAcc/n.mspsIoMs/1000) : 0;
    n.mspsAcc=0; n.mspsIoMs=0; n.mspsWorkerMs=0; n.mspsWinStart=now;
  }
}

// снэпшот спектра сырого IQ: fftshift, ось частот вокруг центра настройки.
// Считается не чаще ~25 раз/с — на бОльшую частоту водопад всё равно не смотрит,
// а БПФ на 2МГц-потоке каждый блок (~каждые 2-3мс) было бы лишней тратой CPU.
// Воркер под БПФ спектра — тот же приём, что и demod-воркер: fft()/window_() глобальны
// в core-engine.js и недоступны внутри Worker, поэтому копии встроены сюда же.
const RTL_SPEC_WORKER_SRC = `
function fft(re,im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let bit=n>>1;
    for(;j&bit;bit>>=1) j^=bit; j^=bit;
    if(i<j){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang), h=len>>1;
    for(let i=0;i<n;i+=len){ let cr=1,ci=0;
      for(let k=0;k<h;k++){
        const ur=re[i+k], ui=im[i+k];
        const vr=re[i+k+h]*cr-im[i+k+h]*ci, vi=re[i+k+h]*ci+im[i+k+h]*cr;
        re[i+k]=ur+vr; im[i+k]=ui+vi; re[i+k+h]=ur-vr; im[i+k+h]=ui-vi;
        const t=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=t; } } }
}
function window_(kind,N){
  const w=new Float32Array(N);
  for(let i=0;i<N;i++){ const x=i/(N-1);
    w[i] = kind==='hann'? 0.5-0.5*Math.cos(2*Math.PI*x)
         : kind==='hamming'? 0.54-0.46*Math.cos(2*Math.PI*x)
         : kind==='blackman'? 0.42-0.5*Math.cos(2*Math.PI*x)+0.08*Math.cos(4*Math.PI*x)
         : 1; }
  return w;
}
let winCache={kind:null,N:0,w:null,sum:1};
let reBuf=null, imBuf=null, pwBuf=null, bufN=0; // внутренние, никуда не отправляются, переиспользование безопасно
// Уэлч: L отсчётов режутся на K кадров по N с перекрытием 50%, мощность усредняется —
// разброс пола шума падает ~в sqrt(K) раз. Делим на сумму окна, а не на N: 0 дБ = комплексный
// тон полной шкалы (|I+jQ|=1) при любом окне.
self.onmessage=function(e){
  const msg=e.data;
  if(msg.type!=='fft') return;
  const N=msg.N, L=msg.L, kind=msg.win;
  if(!winCache.w || winCache.kind!==kind || winCache.N!==N){
    const w=window_(kind,N); let sum=0; for(let i=0;i<N;i++) sum+=w[i];
    winCache={kind,N,w,sum}; }
  if(!reBuf || bufN!==N){ reBuf=new Float32Array(N); imBuf=new Float32Array(N); pwBuf=new Float64Array(N); bufN=N; }
  const w=winCache.w, I=new Float32Array(msg.I), Q=new Float32Array(msg.Q);
  const re=reBuf, im=imBuf, pw=pwBuf;
  // DC-спайк гетеродина (zero-IF RTL2832U): вычитаем среднее всего блока — это и есть центральный бин
  let mI=0, mQ=0;
  for(let i=0;i<L;i++){ mI+=I[i]; mQ+=Q[i]; }
  mI/=L; mQ/=L;
  // кадры выровнены по концу блока — последний кадр всегда самые свежие отсчёты
  const hop=N>>1, K=Math.max(1, Math.floor((L-N)/hop)+1), o0=L-N-(K-1)*hop;
  pw.fill(0);
  for(let k=0;k<K;k++){
    const o=o0+k*hop;
    for(let i=0;i<N;i++){ re[i]=(I[o+i]-mI)*w[i]; im[i]=(Q[o+i]-mQ)*w[i]; }
    fft(re,im);
    for(let i=0;i<N;i++) pw[i]+=re[i]*re[i]+im[i]*im[i];
  }
  // mag НЕ переиспользуем (в отличие от demod-воркера): n.spec может читаться потребителем
  // (узел sa) несколько тактов подряд, пока не придёт следующий расчёт — если отдать этот же
  // буфер воркеру раньше времени, следующий расчёт молча перезапишет память ещё читаемого спектра.
  const mag=new Float32Array(N);
  const half=N>>1, sc=1/(K*winCache.sum*winCache.sum);
  for(let i=0;i<N;i++) mag[i]=Math.sqrt(pw[(i+half)%N]*sc);
  // I/Q дальше никому не нужны — отдаём буферы обратно главному потоку для переиспользования
  self.postMessage({type:'result', mag:mag.buffer, K, I:I.buffer, Q:Q.buffer}, [mag.buffer, I.buffer, Q.buffer]);
};
`;

function rtlMakeSpecWorker(){
  const url=URL.createObjectURL(new Blob([RTL_SPEC_WORKER_SRC], {type:'application/javascript'}));
  const worker=new Worker(url);
  let pendingResolve=null;
  let bufPool=[];   // {I,Q} буферы, отданные воркером обратно после расчёта — переиспользуем
  worker.onmessage=(e)=>{
    if(e.data.type==='result' && pendingResolve){
      const resolve=pendingResolve; pendingResolve=null;
      if(e.data.I && e.data.Q) bufPool.push({I:e.data.I, Q:e.data.Q});
      resolve({mag:new Float32Array(e.data.mag), K:e.data.K});
    }
  };
  return {
    // буферы не меньше L отсчётов из пула (или null, если пул пуст/кольцо выросло) —
    // вызывающий сам решает, аллоцировать ли в этом случае свежие
    takeBuffers(L){
      while(bufPool.length){ const b=bufPool.pop(); if(b.I.byteLength>=L*4) return b; }
      return null;
    },
    compute(iBuf, qBuf, N, L, win){
      return new Promise((resolve)=>{
        pendingResolve=resolve;
        worker.postMessage({type:'fft', I:iBuf, Q:qBuf, N, L, win}, [iBuf, qBuf]);
      });
    },
    terminate(){ worker.terminate(); URL.revokeObjectURL(url); }
  };
}

// спектр сырого IQ: fftshift, ось частот вокруг центра настройки.
// Берутся все отсчёты, пришедшие с прошлого расчёта (до specAvg кадров), а не последние N —
// воркер усредняет их по Уэлчу. process() синхронный по контракту движка: заказывает расчёт
// и отдаёт n.spec, какой есть. Не успевает воркер — обновления реже, кадров в каждом больше.
const RTL_SPEC_MAX_FRAMES=256;
function rtlUpdateSpec(n){
  if(!n.connected || !n.specWorker) return;
  const now=performance.now();
  if(n.specBusy || (n.spec && now-n.lastSpec<80)) return;
  const N=+n.p.specSize, ring=n.specRing;
  if(ring.filled<N) return;
  const av=n.p.specAvg, frames=av==='off'? 1 : av==='all'? RTL_SPEC_MAX_FRAMES : (+av||1);
  const fresh=ring.written-(n.specTaken||0);
  // свежих меньше кадра — берём последние N (перекрытие с прошлым расчётом, как раньше)
  const L=Math.max(N, Math.min(ring.filled, N+(frames-1)*(N>>1), fresh));
  n.specTaken=ring.written;
  const start=(ring.w-L+ring.size)%ring.size;
  // свежие буферы — сразу под всё кольцо, чтобы пул подходил при любом L
  const reuse=n.specWorker.takeBuffers(L);
  const I=reuse?new Float32Array(reuse.I):new Float32Array(ring.size), Q=reuse?new Float32Array(reuse.Q):new Float32Array(ring.size);
  // .set() из непрерывных (максимум двух, на стыке кольца) подмассивов — оптимизированный memmove
  const first=Math.min(L, ring.size-start);
  I.set(ring.I.subarray(start,start+first)); Q.set(ring.Q.subarray(start,start+first));
  if(first<L){ I.set(ring.I.subarray(0,L-first),first); Q.set(ring.Q.subarray(0,L-first),first); }
  n.specBusy=true;
  const centerFreq=n.actualFreq??n.p.freq, binHz=n.sourceRate/N, half=N>>1, win=n.p.specWin;
  n.specWorker.compute(I.buffer, Q.buffer, N, L, win).then(({mag,K})=>{
    n.specBusy=false; n.specK=K;
    if(!n.specFreqs || n.specFreqs.length!==N || n.specFreqsCenter!==centerFreq || n.specFreqsSr!==n.sourceRate){
      const fr=new Float32Array(N);
      for(let i=0;i<N;i++) fr[i]=centerFreq+(i-half)*binHz;
      n.specFreqs=fr; n.specFreqsCenter=centerFreq; n.specFreqsSr=n.sourceRate;
    }
    // iq — сырой поток на родной частоте для анализаторов ('sigid'): 0 Гц IQ = centerFreq
    n.spec={mag, sr:n.sourceRate, size:N, freqs:n.specFreqs,
            rev:(n.specRev=(n.specRev|0)+1), iq:{ring:n.specRing, sr:n.sourceRate, fc:centerFreq}};
    n.lastSpec=performance.now();
  }).catch(()=>{ n.specBusy=false; });
}

// Выход 'iq': сырой поток на родной частоте — буферы USB с прошлого такта (readerLoop копирует их,
// только пока выход подключён; чанки старой частоты после перестройки туда не попадают).
function rtlIqOut(n){
  if(n._iqOrd!==Graph.order){ n._iqOrd=Graph.order; n._iqWired=Graph.edges.some(e=>e.from===n.id && e.fp==='iq'); }
  const fc=n.actualFreq??n.p.freq;
  if(!n._iqWired || !n.connected || n.swActive){ n.iqQ=null; return null; }
  const s=iqStream(n,'iq',n.sourceRate,fc);
  if(!n.iqQ){ n.iqQ=[]; n.iqQN=0; n.iqGap=false; n.iqFc=fc; return s; }
  let tag=n.iqGap ? 'gap' : null;
  if(fc!==n.iqFc){ tag='retune'; n.iqFc=fc; }
  for(const q of n.iqQ){ iqPushRaw(s,q.raw,q.fmt,tag); tag=null; }
  n.iqQ=[]; n.iqQN=0; n.iqGap=false;
  return s;
}

// подстраховка от протухшего сохранённого значения (например, оставшегося '250000' из старой
// версии узла, когда этот вариант ещё был в списке) — вместо падения setSampleRate() в ошибку
// и полной тишины молча откатываемся на безопасный дефолт.
function rtlSafeSr(v){
  const n=+v;
  return (isFinite(n) && n>450000) ? n : 1024000;
}

// Общий регулятор чтения кольца. st: {rebuffering, lagAvg}; lag и need — в отсчётах кольца,
// rateIn — их частота. Возвращает {k, drop}: k — множитель шага (0 = отдать тишину),
// drop — сколько отсчётов пропустить перед чтением.
const rtlTargetS=n=>n.dev?.kind==='file' ? RTL_FILE_TARGET_S : RTL_TARGET_S;
function rtlPace(n, st, lag, rateIn, need, tag){
  const target=Math.max(need*2, rateIn*rtlTargetS(n));
  let drop=0;
  if(lag>Math.max(target*2, rateIn*RTL_DROP_S)){
    drop=lag-target; lag=target; st.lagAvg=target; n.underrunsOverflow++;
    console.warn(`[rtlsdr] ${tag} ring: запас ${(1000*(lag+drop)/rateIn).toFixed(0)}мс, сброшено до ${(1000*target/rateIn).toFixed(0)}мс @ ${performance.now().toFixed(0)}ms`);
  }
  if(st.rebuffering){
    if(lag<target) return {k:0, drop};
    st.rebuffering=false; st.lagAvg=lag;
  }
  if(lag<need){
    st.rebuffering=true; n.underrunsStarve++;
    console.warn(`[rtlsdr] ${tag} ring starve, lag=${lag.toFixed(0)} need=${need.toFixed(0)} @ ${performance.now().toFixed(0)}ms`);
    return {k:0, drop};
  }
  st.lagAvg=(st.lagAvg??lag)+(lag-(st.lagAvg??lag))*RTL_SERVO_G;
  // устойчивый избыток (стопор при старте и т.п.) серво съедал бы минутами — роняем сразу
  if(st.lagAvg>target*RTL_EXCESS){
    const d=lag-target;
    if(d>0){
      drop+=d; n.underrunsOverflow++;
      console.warn(`[rtlsdr] ${tag} ring: устойчивый запас ${(1000*st.lagAvg/rateIn).toFixed(0)}мс, сброшено до ${(1000*target/rateIn).toFixed(0)}мс @ ${performance.now().toFixed(0)}ms`);
    }
    st.lagAvg=target;
  }
  const err=clamp((st.lagAvg-target)/target, -1, 1);
  st.ppm=err*RTL_SERVO_PPM;
  return {k:1+st.ppm*1e-6, drop};
}

// чтение сырого широкополосного IQ (режим demod==='IQ') с интерполяцией под Eng.sr — состояние
// чтения отдельное от каналов демодуляции, у них своё кольцо
function rtlReadIQ(n, oi, oq){
  const ring=n.ring;
  if(!n.connected){ oi.fill(0); oq.fill(0); return; }
  const rate=n.sourceRate, need=rate/Eng.sr*BLOCK;
  // ring.written и n.ringReadCount растут монотонно, в отличие от круговых индексов
  const lag=ring.written-n.ringReadCount;
  const st=n.iqPace||(n.iqPace={rebuffering:n.ringRebuffering, lagAvg:null});
  if(n.ringRebuffering){ st.rebuffering=true; n.ringRebuffering=false; }  // сброс из rtlResetRing
  const {k, drop}=rtlPace(n, st, lag, rate, need, 'IQ');
  if(drop){ n.ringReadPos=(n.ringReadPos+drop)%ring.size; n.ringReadCount+=drop; }
  if(!k){ oi.fill(0); oq.fill(0); return; }
  const step=rate/Eng.sr*k;
  for(let k2=0;k2<BLOCK;k2++){
    const p0=Math.floor(n.ringReadPos)%ring.size, p1=(p0+1)%ring.size, fr=n.ringReadPos-Math.floor(n.ringReadPos);
    oi[k2]=ring.I[p0]*(1-fr)+ring.I[p1]*fr;
    oq[k2]=ring.Q[p0]*(1-fr)+ring.Q[p1]*fr;
    n.ringReadPos+=step; n.ringReadCount+=step;
  }
  n.ringReadPos%=ring.size;
}

// то же для одного демодулированного канала; кольцо хранит уже децимированный звук (sourceRate/decim)
// o — моно (L+R)/2; oL/oR (необязательные) — стерео-пара для канала с выходами audioL/audioR
function rtlReadChannelAudio(n, ch, o, oL, oR){
  const mute=()=>{ o.fill(0); oL?.fill(0); oR?.fill(0); };
  if(!n.connected || !ch.active || !ch.aring){ mute(); return; }
  const rate=n.sourceRate/(n.decim||1), ring=ch.aring, need=rate/Eng.sr*BLOCK+3;   // +3 — хвост для 4-точечной интерполяции
  const lag=ring.written-ch.readCount;
  const {k, drop}=rtlPace(n, ch, lag, rate, need, 'audio');
  if(drop){ ch.readPos=(ch.readPos+drop)%ring.size; ch.readCount+=drop; }
  const nowLog=performance.now();
  if(!ch.lastLagLogT || nowLog-ch.lastLagLogT>3000){
    ch.lastLagLogT=nowLog;
    console.log(`[rtlsdr] ring trend: lag=${(1000*lag/rate).toFixed(0)}мс avg=${(1000*(ch.lagAvg||0)/rate).toFixed(0)}мс target=${(1000*rtlTargetS(n)).toFixed(0)}мс servo=${(ch.ppm||0).toFixed(0)}ppm mspsIo=${(n.mspsIo||0).toFixed(3)} nominal=${(n.sourceRate/1e6).toFixed(3)} @ ${nowLog.toFixed(0)}ms`);
  }
  if(!k){ mute(); return; }
  const step=rate/Eng.sr*k;
  // Катмулл-Ром по 4 точкам: звук в кольце уже ограничен аудио-FIR, линейная интерполяция
  // заметно заваливала верх и давала зеркала при небольшом запасе ar над Eng.sr
  const A=ring.A, Bq=ring.B, size=ring.size;
  const cr=(X,im,i0,i1,i2,f)=>{ const xm=X[im], x0=X[i0], x1=X[i1], x2=X[i2];
    const c1=0.5*(x1-xm), c2=xm-2.5*x0+2*x1-0.5*x2, c3=0.5*(x2-xm)+1.5*(x0-x1);
    return ((c3*f+c2)*f+c1)*f+x0; };
  for(let k2=0;k2<BLOCK;k2++){
    const fl=Math.floor(ch.readPos), f=ch.readPos-fl;
    const i0=fl%size, im=(i0+size-1)%size, i1=(i0+1)%size, i2=(i0+2)%size;
    const l=cr(A,im,i0,i1,i2,f), r=cr(Bq,im,i0,i1,i2,f);
    o[k2]=(l+r)*0.5;
    if(oL){ oL[k2]=l; oR[k2]=r; }
    ch.readPos+=step; ch.readCount+=step;
  }
  ch.readPos%=ring.size;
}

const sdrUsbId=d=>d.vendorId.toString(16)+':'+d.productId.toString(16)+':'+(d.serialNumber||'');
// прошлое устройство из уже разрешённых — без окна выбора; choose — выбрать заново
async function sdrPickDevice(n, choose){
  if(!choose && n.p.usbId){
    const d=(await navigator.usb.getDevices()).find(d=>sdrUsbId(d)===n.p.usbId);
    if(d) return d;
    // RX-888 после выключения снова загрузчик — берём его, если уже разрешён
    if(n.p.usbId.startsWith('4b4:f1:')){
      const b=(await navigator.usb.getDevices()).find(d=>rx888Is(d, RX888_BOOT));
      if(b) return b;
    }
  }
  return navigator.usb.requestDevice({filters:SDR_USB_FILTERS});
}
// центр железа: ppm — поправка частоты, dcShift — центр на sr/4 выше, чтобы станция не сидела на DC.
// AM/SAM/SSB — всегда: DC-блок воркера (до NCO) иначе вырезает несущую/низы канала, стоящего в центре,
// а переносить его после NCO нельзя — там в нуле уже несущая самого канала
const SDR_DC_MODES=['AM','SAM','USB','LSB'];
const sdrDcOff=n=>(n.p.dcShift || SDR_DC_MODES.includes(n.p.demod)) && !n.dev?.fixedFreq ? Math.round(n.sourceRate/4) : 0;
// смещение конвертера, Гц; у файла частота уже эфирная
const sdrConv=n=>n.dev?.fixedFreq ? 0 : Math.round((+n.p.conv||0)*1e6);
// всё вне этих двух функций — в эфирных частотах, в железо уходит частота тюнера (без смещения)
async function sdrTune(n){
  const want=Math.round(n.p.freq), ppm=+n.p.ppm||0, k=n.dev.fixedFreq ? 1 : 1+ppm*1e-6;
  const off=sdrDcOff(n), conv=sdrConv(n);
  if(want+off-conv<=0) throw new Error(`tuner frequency ${fmtHz(want+off-conv)}Hz out of range (check converter offset)`);
  const hw=await n.dev.setCenterFrequency(Math.round((want+off-conv)/k));
  n.actualFreq=hw*k+conv; n.dcOff=off; n.appliedFreq=want; n.appliedPpm=ppm; n.appliedConv=conv;
  if(n.dev.fixedFreq){ n.p.freq=hw; n.appliedFreq=hw; }   // у файла центр не перестраивается
}
// логический центр — куда встаёт канал, следующий за центром
const sdrCenter=n=>(n.actualFreq??n.p.freq)-(n.dcOff||0);
const sdrGainKey=n=>n.dev?.kind==='hackrf' ? `h${n.p.lna}|${n.p.vga}|${!!n.p.amp}` : (n.p.auto ? 'auto' : 'g'+n.p.gainDb);

async function rtlConnect(n, choose){
  if(!navigator.usb){ n.status='WebUSB unavailable (needs Chrome/Edge/Opera)'; return; }
  if(n.connected && n.dev?.kind==='file') await rtlDisconnect(n);
  if(n.connected) return;
  try{
    let usbDev=await sdrPickDevice(n, choose);
    if(rx888Is(usbDev, RX888_BOOT)) usbDev=await rx888Boot(n, usbDev);
    const gain=n.p.auto?null:n.p.gainDb;
    // сначала пробуем открыть донгл в USB-воркере; без WebUSB в воркерах — по-старому, на главном потоке
    n.dev=await rtlOpenInWorker(usbDev, gain).catch(e=>{
      console.warn('[rtlsdr] USB-воркер не открыл донгл, читаем с главного потока:', e.message); return null; })
      || await sdrOpenDevice(usbDev, 0, gain);
    const srSafe=rtlSafeSr(n.p.sr);
    if(srSafe!==+n.p.sr) n.status='sample rate in settings is stale, using '+srSafe+' Hz';
    n.p.usbId=sdrUsbId(usbDev);
    await rtlStart(n, srSafe);
  }catch(e){
    n.status='error: '+e.message;
    n.dev=null; n.connected=false;
  }
}

// общий запуск для открытого n.dev (USB или файл)
async function rtlStart(n, sr){
  n.p.devKind=n.dev.kind; n.usbRps=null;
  n.sourceRate=await n.dev.setSampleRate(sr);
  await sdrTune(n);
  // у HackRF свои ступени — применит rtlApplyPending; bias-tee после открытия выключен, GPIO не трогаем
  n.appliedGainKey=n.dev.kind==='hackrf' ? null : sdrGainKey(n); n.appliedBias=false;
  await n.dev.resetBuffer();
  // отключение/переподключение — каналы поднимаем с нуля; активные до дисконнекта воркеры
  // уже терминированы в rtlDisconnect, но на всякий случай подчистим прежде, чем ресайзить кольца
  for(const ch of n.ch){ if(ch.worker) ch.worker.terminate(); ch.worker=null; ch.aring=null; ch.active=false; }
  rtlResetRing(n);
  n._specEpoch=0;
  rtlActivateChannel(n, 0);                        // channel 1 — always, as before
  // синхронизируем NCO канала 1 с уже выставленным (возможно, отличным от центра) значением
  const tf0=n.ch[0].tuneFreq==null?sdrCenter(n):n.ch[0].tuneFreq;
  n.ch[0].appliedOffset=clamp(tf0, n.actualFreq-n.sourceRate/2, n.actualFreq+n.sourceRate/2)-n.actualFreq;
  n.ch[0].worker.setOffset(n.ch[0].appliedOffset);
  if(n.specWorker) n.specWorker.terminate();
  n.specWorker=rtlMakeSpecWorker(); n.specBusy=false;
  n.connected=true; n.reading=true;
  n.underrunsWorker=0; n.underrunsOverflow=0; n.underrunsStarve=0;
  n.adcAcc=null; n.adcPk=null; n.adcRms=null; n.adcClip=null; n.adcOvlT=null;
  for(const ch of n.ch){ ch.rssi=null; ch.rssiChunk=null; ch.snr=null; ch.noiseDb=null; ch.sqOpen=undefined; ch.sqG=1; }
  n.status='connected ('+n.dev.tunerName+(n.dev.worker?', USB in worker':'')+')';
  rtlReadLoop(n);
}

// воспроизведение файла IQ вместо устройства
async function iqOpenFile(n){
  const files=await new Promise(res=>{
    const f=document.createElement('input'); f.type='file'; f.multiple=true;
    if(n.p.iqFmt==='auto') f.accept='.wav,.sigmf,.sigmf-meta,'+Object.keys(IQ_RAW_EXT).map(e=>'.'+e).join(',');
    f.onchange=()=>res(f.files); f.click();
  });
  if(!files.length) return;
  try{
    const src=await iqParseFiles(files, n.p.iqFmt);
    if(n.connected) await rtlDisconnect(n);
    const dev=iqFileDevice(src, rtlSafeSr(n.p.sr), Math.round(n.p.freq));
    dev.onFreq=f=>{ n.actualFreq=f; n.p.freq=f; n.appliedFreq=f; };
    n.p.freq=await dev.setCenterFrequency(); n.p.seek=0; n.appliedSeek=0;
    if(src.raw && (!iqRateFromName(src.name) || !iqFreqFromName(src.name))) dev.tunerName+=' (rate/freq from node settings)';
    n.dev=dev;
    await rtlStart(n, dev.rate);
  }catch(e){
    n.status='error: '+e.message;
    n.dev=null; n.connected=false;
  }
}

async function rtlDisconnect(n){
  if(n.rec) await iqRecStop(n);
  n.reading=false;
  for(const ch of n.ch){ if(ch.worker) ch.worker.terminate(); ch.worker=null; ch.aring=null; ch.active=false; }
  if(n.specWorker){ n.specWorker.terminate(); n.specWorker=null; }
  if(n.dev){ try{ await n.dev.close(); }catch(e){} n.dev=null; }
  n.connected=false; n.busy=false;
  n.status='disconnected';
}

// ---- HackRF TX: передача IQ-потока ----
// Приёмник потока 'iq': центр и частота дискретизации берутся из потока (2–20 МС/с). HackRF не умеет
// принимать и передавать одновременно и занимает устройство целиком — не держите его же открытым в USB SDR.
const HACKRF_TX_WARN='You must comply with local radio regulations: transmit only where and how the law allows.';
const HACKRF_USB_FILTERS=[{vendorId:0x1d50,productId:0x6089},{vendorId:0x1d50,productId:0x604b},{vendorId:0x1d50,productId:0xcc15}];
async function hackrfTxConnect(n, choose){
  if(!navigator.usb){ n.status='WebUSB unavailable (needs Chrome/Edge/Opera)'; return false; }
  if(n.dev) return true;
  try{
    let usbDev=!choose && n.p.usbId ? (await navigator.usb.getDevices()).find(d=>sdrUsbId(d)===n.p.usbId) : null;
    if(!usbDev) usbDev=await navigator.usb.requestDevice({filters:HACKRF_USB_FILTERS});
    n.dev=await rtlOpenInWorker(usbDev, null).catch(e=>{
      console.warn('[hackrfTx] USB-воркер не открыл устройство, работаем с главного потока:', e.message); return null; })
      || await hackrfOpenDevice(usbDev, null);
    n.p.usbId=sdrUsbId(usbDev); n.status='connected: '+n.dev.tunerName;
    return true;
  }catch(e){
    n.dev=null; n.status=e.name==='NotFoundError' ? 'no device selected' : 'error: '+e.message;
    return false;
  }
}
async function hackrfTxStop(n){
  n.txOn=false;
  if(n.dev){ try{ await n.dev.txStop(); }catch(e){} }
  n.txRun=false; n.appliedSr=n.appliedFc=n.appliedGain=null; n.stats=null;
}
async function hackrfTxDisconnect(n){
  await hackrfTxStop(n);
  if(n.dev){ try{ await n.dev.close(); }catch(e){} n.dev=null; }
  n.status='disconnected';
}
// USB медленный — только из process() через n.busy; частота и усиление меняются на ходу, rate — перезапуском
async function hackrfTxApply(n, sr, fc){
  const d=n.dev, gain=Math.round(n.p.vga)+'|'+!!n.p.amp;
  if(n.appliedSr!==sr){
    if(n.txRun){ await d.txStop(); n.txRun=false; }
    await d.setSampleRate(sr); n.appliedSr=sr; n.appliedFc=null;
  }
  if(n.appliedFc!==fc){ await d.setCenterFrequency(fc); n.appliedFc=fc; }
  if(n.appliedGain!==gain){ await d.setTxGain(+n.p.vga, !!n.p.amp); n.appliedGain=gain; }
  if(!n.txRun){ await d.txStart(); n.txRun=true; }
  if(!n.txOn){ await d.txStop(); n.txRun=false; }     // стоп пришёл, пока шла настройка
}
// пин tx: передача стартует по фронту 0→1 (уже поднятый при загрузке патча не включает ничего), по спаду — стоп
async function hackrfTxPinOn(n){
  if(!n.sr){ n.status='no IQ input'; return; }
  if(await hackrfTxConnect(n) && n.pinTx){ n.txOn=true; n.status='starting…'; }
}
// последняя страховка при закрытии вкладки: без явного txStop прошивка остаётся в режиме TX
function hackrfTxPageClose(){
  if(typeof Graph==='undefined') return;
  for(const n of Graph.nodes) if(n.type==='hackrfTx' && n.dev){ n.txOn=false; try{ n.dev.txStop(); }catch(e){} }
}
addEventListener('pagehide', hackrfTxPageClose);
addEventListener('beforeunload', hackrfTxPageClose);

def({ id:'hackrfTx', title:'HackRF TX', cat:'IQ',
  ins:[{n:'in',t:'iq'},{n:'tx',t:'num'}], outs:[], readout:true,
  params:[
    {n:'connect',t:'button',label:'Connect',fn:async n=>{ await hackrfTxConnect(n); }},
    {n:'choose',t:'button',label:'Choose…',fn:async n=>{ if(n.dev) await hackrfTxDisconnect(n); await hackrfTxConnect(n, true); }},
    {n:'disconnect',t:'button',label:'Disconnect',fn:async n=>{ await hackrfTxDisconnect(n); }},
    {n:'vga',t:'range',min:0,max:47,step:1,d:0,label:'TX VGA, dB'},
    {n:'amp',t:'check',d:false,label:'amp +14 dB'},
    {n:'start',t:'button',label:'● Transmit (obey local law)',fn:async n=>{
      if(n.txOn) return;
      if(!n.sr){ n.status='no IQ input'; return; }
      if(!await hackrfTxConnect(n)) return;
      n.txOn=true; n.status='starting…'; }},
    {n:'stop',t:'button',label:'■ Stop',fn:async n=>{ await hackrfTxStop(n); n.status=n.dev ? 'stopped' : 'not connected'; }},
    {n:'usbId',t:'text',d:'',hidden:true}],
  init:n=>{ n.dev=null; n.txOn=false; n.txRun=false; n.busy=false; n.sr=0; n.fc=0; n.stats=null; n.statT=0; n.pinTx=null;
            n.appliedSr=n.appliedFc=n.appliedGain=null; n.status='not connected'; },
  process(n,I){
    const s=iqIn(I,'in');
    if(s){ n.sr=s.sr; n.fc=s.fc; }
    if(typeof I.tx==='number'){
      const on=I.tx>=0.5, was=n.pinTx;
      n.pinTx=on;
      if(was===false && on) hackrfTxPinOn(n);
      else if(was===true && !on){ hackrfTxStop(n).then(()=>{ n.status=n.dev ? 'stopped' : 'not connected'; }); }
    } else if(n.pinTx){ n.pinTx=null; hackrfTxStop(n); }   // пин отключили проводом — передача выключается
    else n.pinTx=null;
    if(!n.txOn && n.txRun && !n.busy) hackrfTxStop(n);      // передатчик не должен работать без txOn
    if(!n.txOn || !n.dev || !s) return;
    if(s.sr<2e6 || s.sr>20e6){ n.status='stream is '+(s.sr/1e6).toFixed(3)+' MS/s, HackRF needs 2–20'; return; }
    const sr=Math.round(s.sr), fc=Math.round(s.fc);
    if(!s.chunks.length) return;
    if(!n.busy && (n.appliedSr!==sr || n.appliedFc!==fc || n.appliedGain!==Math.round(n.p.vga)+'|'+!!n.p.amp || !n.txRun)){
      n.busy=true;
      hackrfTxApply(n, sr, fc).catch(e=>{ n.status='error: '+e.message; hackrfTxStop(n); }).finally(()=>{ n.busy=false; });
    }
    if(!n.txRun || n.busy) return;
    for(const c of s.chunks){
      const re=c.re, im=c.im, L=re.length, b=new Int8Array(2*L);
      for(let i=0;i<L;i++){
        const a=re[i]*127, q=im ? im[i]*127 : 0;
        b[2*i]=a>127?127:a<-127?-127:a; b[2*i+1]=q>127?127:q<-127?-127:q;
      }
      n.dev.txPush(b);
    }
    const now=performance.now();
    if(now-n.statT>500){ n.statT=now; n.dev.txStats().then(st=>{
      n.stats=st;
      if(!st.on && n.txRun){ n.txRun=false; n.status=st.err||'RF off'; }   // драйвер сам выключил передатчик, вернётся с данными
    }, ()=>{}); }
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const st=n.stats;
    r.textContent=n.txOn && n.txRun
      ? 'ON AIR '+(n.appliedFc/1e6).toFixed(4)+' MHz · '+(n.appliedSr/1e6).toFixed(2)+' MS/s'+
        (st ? ' · buffer '+Math.round(st.queued*100)+'% · underruns '+st.under+(st.over ? ' · dropped '+st.over : '')+(st.err ? ' · '+st.err : '') : '')+' · '+HACKRF_TX_WARN
      : n.status+' · '+HACKRF_TX_WARN; },
  dispose:n=>{ hackrfTxDisconnect(n).catch(()=>{}); }});

// компактный формат частоты: 172300000 → "172.3М", 17500 → "17.5к"
function fmtHz(v,dp){                               // dp — знаков после запятой (по умолчанию 1)
  const a=Math.abs(v);
  dp=dp??1;
  if(a>=1e9) return (v/1e9).toFixed(dp)+'G';
  if(a>=1e6) return (v/1e6).toFixed(dp)+'M';
  if(a>=1e3) return (v/1e3).toFixed(dp)+'k';
  return String(Math.round(v));
}

// USB-обращения медленные (мс), нельзя дёргать их каждый блок из process().
// process() только обновляет n.p через setMod (дёшево); эта функция раз в тик
// проверяет, разошлось ли применённое с желаемым, и если да — асинхронно
// подтягивает железо, не блокируя аудио. Один общий busy-флаг на freq+gain,
// потому что оба ходят по общему I2C-репитеру тюнера — параллелить нельзя.
async function rtlApplyPending(n){
  if(!n.dev || n.busy) return;
  if(n.dev.kind==='file'){
    n.dev.loop=!!n.p.loop;
    if(n.dev.loop && n.dev.ended) n.dev.seek(0);
    if(+n.p.seek!==n.appliedSeek){ n.appliedSeek=+n.p.seek; n.dev.seek(n.appliedSeek/100); n.specRing.filled=0; }
  }
  const off=sdrDcOff(n);
  // во время прохода тюнером владеет sdrSweepLoop
  const freqStale = !n.swActive && (Math.round(n.p.freq)!==n.appliedFreq || (+n.p.ppm||0)!==n.appliedPpm || off!==n.dcOff || sdrConv(n)!==n.appliedConv);
  const gainKey=sdrGainKey(n), gainStale=gainKey!==n.appliedGainKey;
  const biasStale=!!n.p.bias!==n.appliedBias;
  if(!freqStale && !gainStale && !biasStale) return;
  n.busy=true;
  try{
    if(freqStale){
      await sdrTune(n);
      // спектр — только с отсчётов новой частоты: кольцо с нуля, старые чанки отсекает эпоха
      n._specEpoch=n.dev.epoch?.()||0; n.specRing.filled=0;
    }
    if(gainStale){
      if(n.dev.kind==='hackrf') await n.dev.setHackrfGain(+n.p.lna, +n.p.vga, !!n.p.amp);
      else await n.dev.setGain(n.p.auto?null:n.p.gainDb);
      n.appliedGainKey=gainKey;
    }
    if(biasStale){ await n.dev.setBiasTee(!!n.p.bias); n.appliedBias=!!n.p.bias; }
  }catch(e){ n.status='retune error: '+e.message; }
  n.busy=false;
}

// ---- широкополосное сканирование: перестройка шагами, склейка спектров в одну панораму ----
// Шаг — центральная часть полосы (края завалены антиалиасинговым фильтром). Сетка бинов общая
// для всех шагов: freqs[j]=lo+j*binHz, шаг k покрывает j∈[k·use, (k+1)·use).
// Строка водопада 'sa' — по смене rev, т.е. одна на полный проход.
const SDR_SWEEP_RPS=400;         // мелкие трансферы: старые (до перестройки) быстрее вычерпываются
const SDR_SWEEP_MAX_BINS=4e6;
const sdrSleep=ms=>new Promise(r=>setTimeout(r,ms));
function sdrSetReadRate(n, rps){
  n.usbRps=rps;
  n.dev?.setReadRate?.(rps)?.catch?.(()=>{});
}
// частота первого канала с маркером — слушаем её, проход на паузе
function sdrListenFreq(n){
  for(const ch of n.ch) if(ch.active && ch.tuneFreq!=null) return ch.tuneFreq;
  return null;
}
function sdrSweepPlan(n){
  const N=+n.p.swFft||1024, sr=n.sourceRate, binHz=sr/N;
  const use=Math.max(2, Math.round(N*clamp(+n.p.swUse||.8,.3,1)/2)*2);
  const a=(+n.p.swLo||0)*1e6, b=(+n.p.swHi||0)*1e6, lo=Math.min(a,b), hi=Math.max(a,b);
  const hops=Math.max(1, Math.ceil((hi-lo)/(use*binHz)));
  const key=[N,sr,use,lo,hi].join('|');
  if(n.sw && n.sw.key===key) return n.sw;
  const total=hops*use;
  if(total>SDR_SWEEP_MAX_BINS) throw new Error(`too many bins (${(total/1e6).toFixed(1)}M): narrow the range or reduce sweep FFT size`);
  const mag=new Float32Array(total), freqs=new Float64Array(total);
  for(let j=0;j<total;j++) freqs[j]=lo+j*binHz;
  const win=window_('hann',N); let wsum=0; for(let i=0;i<N;i++) wsum+=win[i];
  n.sw={key, N, use, binHz, lo, hops, k:0, win, wsum,
        re:new Float32Array(N), im:new Float32Array(N), pw:new Float64Array(N),
        spec:{mag, freqs, sr, size:total, rev:1}, tLine:performance.now(), lineMs:null};
  return n.sw;
}
async function sdrSweepTune(n, f){
  while(n.busy) await sdrSleep(2);
  n.busy=true;
  try{
    const k=1+(+n.p.ppm||0)*1e-6;
    await n.dev.setCenterFrequency(Math.round((f-sdrConv(n))/k));
    return n.dev.epoch();
  }finally{ n.busy=false; }
}
// отсчёты эпохи epoch: сначала skip на установку PLL, потом need в буфер
function sdrSweepCapture(n, epoch, skip, need){
  return new Promise(done=>{
    const cap={epoch, skip, need, I:n.sw.capI, Q:n.sw.capQ, w:0, done};
    cap.timer=setTimeout(()=>{ if(n.swCap===cap){ n.swCap=null; done(null); } }, 1500);
    n.swCap=cap;
  });
}
function sdrSweepFeed(n, cap, u8, s16){
  const cnt=s16 ? s16.length>>1 : u8.length>>1;
  let k=Math.min(cap.skip, cnt); cap.skip-=k;
  const I=cap.I, Q=cap.Q; let w=cap.w;
  if(s16) for(;k<cnt && w<cap.need;k++,w++){ I[w]=s16[2*k]/32768; Q[w]=s16[2*k+1]/32768; }
  else    for(;k<cnt && w<cap.need;k++,w++){ I[w]=(u8[2*k]-127.5)/127.5; Q[w]=(u8[2*k+1]-127.5)/127.5; }
  cap.w=w;
  if(w>=cap.need){ clearTimeout(cap.timer); n.swCap=null; cap.done(cap); }
}
// M кадров БПФ шага k → средняя (или максимальная) мощность → центральные use бинов в панораму
function sdrSweepPlace(n, sw, cap, k){
  const N=sw.N, half=N>>1, M=Math.floor(cap.need/N), re=sw.re, im=sw.im, pw=sw.pw, win=sw.win;
  const peak=n.p.swMode==='max';
  pw.fill(0);
  for(let m=0;m<M;m++){
    const o=m*N; let mI=0, mQ=0;
    for(let i=0;i<N;i++){ mI+=cap.I[o+i]; mQ+=cap.Q[o+i]; }
    mI/=N; mQ/=N;                                  // DC гетеродина
    for(let i=0;i<N;i++){ re[i]=(cap.I[o+i]-mI)*win[i]; im[i]=(cap.Q[o+i]-mQ)*win[i]; }
    fft(re,im);
    for(let i=0;i<N;i++){
      const src=(i+half)%N, v=re[src]*re[src]+im[src]*im[src];
      if(peak){ if(v>pw[i]) pw[i]=v; } else pw[i]+=v;
    }
  }
  // остаток DC-выброса — интерполяция по соседям
  if(N>=8){ const v=(pw[half-2]+pw[half+2])/2; pw[half-1]=pw[half]=pw[half+1]=v; }
  const mag=sw.spec.mag, j0=k*sw.use, i0=half-sw.use/2, sc=peak?1:1/M;
  for(let i=0;i<sw.use;i++) mag[j0+i]=Math.sqrt(pw[i0+i]*sc)/sw.wsum;   // 0 дБ = полная шкала, как в живом спектре
}
// живой спектр (при прослушивании) — поверх своего участка панорамы; мощность интегрируется
// по пересечению бинов, так что уровень шума не зависит от разницы размеров БПФ
function sdrSweepOverlay(n, sw, sp){
  const F=sp.freqs, L=F.length; if(L<4) return;
  const lb=F[1]-F[0], b=sw.binHz, mag=sw.spec.mag, total=mag.length;
  const e=Math.floor(L*.1), i0=e, i1=L-e;          // края полосы не берём
  const a0=(F[i0]-lb/2-sw.lo)/b+.5, a1=(F[i1-1]+lb/2-sw.lo)/b+.5;
  const j0=Math.max(0,Math.ceil(a0)), j1=Math.min(total,Math.floor(a1));
  if(j1<=j0) return;
  const acc=sw.ovAcc&&sw.ovAcc.length>=j1-j0 ? sw.ovAcc : (sw.ovAcc=new Float64Array(j1-j0));
  acc.fill(0,0,j1-j0);
  for(let i=i0;i<i1;i++){
    const p=sp.mag[i]*sp.mag[i];
    let x0=(F[i]-lb/2-sw.lo)/b+.5, x1=(F[i]+lb/2-sw.lo)/b+.5, w=lb/b;
    for(let j=Math.max(j0,Math.floor(x0)); j<Math.min(j1,Math.ceil(x1)); j++){
      const ov=Math.min(x1,j+1)-Math.max(x0,j);
      if(ov>0) acc[j-j0]+=p*ov/w;
    }
  }
  for(let j=j0;j<j1;j++) mag[j]=Math.sqrt(acc[j-j0]);
}
async function sdrSweepLoop(n){
  if(n.swRunning) return;
  n.swRunning=true;
  const dev=n.dev;
  const alive=()=>n.dev===dev && n.connected && n.p.sweep && sdrListenFreq(n)==null;
  try{
    let sw=sdrSweepPlan(n);
    sdrSetReadRate(n, SDR_SWEEP_RPS);
    n.swActive=true; n.swErr=null;
    const center=(sw,k)=>sw.lo+(k*sw.use+sw.use/2)*sw.binHz;
    let epoch=await sdrSweepTune(n, center(sw,sw.k));
    while(alive()){
      const need=sw.N*Math.max(1,Math.round(+n.p.swAvg||8));
      if(!sw.capI || sw.capI.length<need){ sw.capI=new Float32Array(need); sw.capQ=new Float32Array(need); }
      const skip=Math.round((+n.p.swSettle||0)/1000*n.sourceRate);
      const cap=await sdrSweepCapture(n, epoch, skip, need);
      if(!alive()) break;
      const sw2=sdrSweepPlan(n);
      if(sw2!==sw){ sw=sw2; epoch=await sdrSweepTune(n, center(sw,sw.k)); continue; }   // параметры сменились
      if(!cap){ epoch=await sdrSweepTune(n, center(sw,sw.k)); continue; }             // таймаут — повтор шага
      const kDone=sw.k;
      sw.k=(sw.k+1)%sw.hops;
      const tuneP=sdrSweepTune(n, center(sw,sw.k));  // перестройка идёт, пока считаем БПФ
      sdrSweepPlace(n, sw, cap, kDone);
      if(kDone===sw.hops-1){
        const now=performance.now();
        sw.lineMs=now-sw.tLine; sw.tLine=now; sw.spec.rev++;
      }
      epoch=await tuneP;
    }
  }catch(e){
    n.swErr=e.message; n.sw=null;
    n.p.sweep=false; n.set?.sweep?.(false);
  }finally{
    if(n.swCap){ clearTimeout(n.swCap.timer); n.swCap=null; }
    n.swActive=false; n.swRunning=false;
    if(n.dev===dev){
      sdrSetReadRate(n, RTL_READS_PER_SEC);
      n.appliedFreq=null;                          // rtlApplyPending вернёт тюнер на n.p.freq
    }
  }
}

def({ id:'rtlsdr', title:'USB SDR', cat:'Sources',
  ins:[{n:'freq',t:'num'},{n:'steerFreq',t:'num'},{n:'tuneFreq',t:'num'},{n:'tuneFreq2',t:'num'},{n:'tuneFreq3',t:'num'},{n:'tuneFreq4',t:'num'},
       {n:'gainDb',t:'num'},{n:'bw',t:'num'},{n:'demod',t:'val'}],
  outs:[{n:'I',t:'sig'},{n:'Q',t:'sig'},{n:'iq',t:'iq'},
        {n:'audio',t:'sig'},{n:'audio2',t:'sig'},{n:'audio3',t:'sig'},{n:'audio4',t:'sig'},
        {n:'audioL',t:'sig'},{n:'audioR',t:'sig'},{n:'ps',t:'val'},{n:'rt',t:'val'},
        {n:'spec',t:'spec'},{n:'freqLo',t:'num'},{n:'freqHi',t:'num'},
        {n:'tuneFreq',t:'num'},{n:'tuneFreq2',t:'num'},{n:'tuneFreq3',t:'num'},{n:'tuneFreq4',t:'num'},
        {n:'demod',t:'val'},{n:'bw',t:'num'},
        {n:'adcPk',t:'num'},{n:'adcRms',t:'num'},{n:'clip',t:'num'},{n:'ovl',t:'num'},
        {n:'rssi',t:'num'},{n:'snr',t:'num'},{n:'sqOpen',t:'num'},
        {n:'rssi2',t:'num'},{n:'snr2',t:'num'},{n:'rssi3',t:'num'},{n:'snr3',t:'num'},{n:'rssi4',t:'num'},{n:'snr4',t:'num'}],
  readout:true,
  params:[
    {n:'connect',t:'button',label:'Connect',fn:async n=>{ await rtlConnect(n); }},
    {n:'choose',t:'button',label:'Choose…',fn:async n=>{ await rtlConnect(n, true); }},
    {n:'disconnect',t:'button',label:'Disconnect',fn:async n=>{ await rtlDisconnect(n); }},
    {n:'openFile',t:'button',label:'Open IQ file…',fn:async n=>{ await iqOpenFile(n); }},
    {n:'iqFmt',t:'select',opts:['auto','cu8','cs8','cs16','cf32','cf64'],d:'auto',label:'IQ file format (raw)',adv:true},
    {n:'recFmt',t:'select',opts:['WAV','SigMF'],d:'WAV',label:'IQ record format',adv:true},
    {n:'rec',t:'button',label:'● Record IQ',fn:async n=>{
      if(n.rec) return;
      try{ await iqRecStart(n); }catch(e){ if(e.name!=='AbortError') n.status='record error: '+e.message; } }},
    {n:'recStop',t:'button',label:'■ Stop recording',fn:async n=>{ await iqRecStop(n); }},
    // только файл: повтор и позиция
    {n:'loop',t:'check',d:true,label:'loop playback'},
    {n:'seek',t:'range',min:0,max:100,step:.1,d:0,label:'position, %'},
    {n:'sr',t:'select',opts:['960000','1024000','1920000','2048000','2400000','2500000','3000000','3200000','6000000','8000000','10000000','12000000','16000000','20000000'],d:'1024000',label:'sample rate',
     fn:async n=>{ if(n.dev){ try{ n.sourceRate=await n.dev.setSampleRate(rtlSafeSr(n.p.sr)); rtlResetRing(n); }
       catch(e){ n.status='sample rate change error: '+e.message; } } }},
    // режим демодуляции/полоса/де-эмфазис — ОБЩИЕ на все 4 канала (проще UI); частота у каждого своя
    {n:'demod',t:'select',opts:DEMOD_OPTS,d:'WFM',label:'demodulation',
     fn:n=>{ rtlResetRing(n); }},
    // ширина полосы канала (ПЧ) — одна на режим, как в SDR++; её же тянут края шторки на спектре 'sa'
    {n:'bw',t:'range',min:500,max:300000,step:100,d:190000,log:true,label:'bandwidth, Hz'},
    {n:'deemph',t:'select',opts:['50','75','off'],d:'50',label:'WFM de-emphasis, µs'},
    {n:'agc',t:'check',d:true,label:'AGC'},
    // SAM: какую боковую слушать после когерентного детектора (обе — DSB, ISB — верхняя в L, нижняя в R)
    {n:'samSb',t:'select',opts:['DSB','USB','LSB','ISB'],d:'DSB',label:'SAM sideband (ISB: L upper, R lower)'},
    {n:'nb',t:'select',opts:['off','low','mid','high'],d:'off',label:'noise blanker'},
    {n:'anf',t:'check',d:false,label:'auto notch'},
    // шумоподавитель на каждый канал: SNR — по спектру вокруг канала (не зависит от усиления), level — RSSI, dBFS
    {n:'sql',t:'select',opts:['off','SNR','level'],d:'off',label:'squelch'},
    {n:'sqlSnr',t:'range',min:0,max:40,step:.5,d:6,label:'squelch SNR, dB'},
    {n:'sqlLvl',t:'range',min:-120,max:0,step:1,d:-50,label:'squelch level, dBFS'},
    {n:'sqlHang',t:'range',min:0,max:3000,step:50,d:300,label:'squelch hang, ms',adv:true},
    {n:'stereo',t:'check',d:true,label:'WFM stereo'},
    // запомненная ширина для каждого режима — при смене режима ползунок bw переключается на неё
    ...['WFM','NFM','AM','SAM','USB','LSB'].map(m=>({n:'if'+m,t:'range',min:500,max:300000,d:RTL_BW_DEF[m],hidden:true})),
    {n:'auto',t:'check',d:true,label:'auto gain'},
    // ручное усиление действует только без auto — движение ползунка само его снимает
    {n:'gainDb',t:'range',min:0,max:49.6,step:.1,d:20,label:'gain, dB',fn:n=>{ if(n.p.auto){ if(n.set?.auto) n.set.auto(false); else n.p.auto=false; } }},
    // только HackRF — вместо auto/gainDb, строки переключает draw()
    {n:'lna',t:'range',min:0,max:40,step:8,d:24,label:'LNA, dB'},
    {n:'vga',t:'range',min:0,max:62,step:2,d:24,label:'VGA, dB'},
    {n:'amp',t:'check',d:false,label:'amp +14 dB'},
    {n:'bias',t:'check',d:false,label:'bias-tee',adv:true},
    {n:'dcShift',t:'check',d:false,label:'shift center off DC (always for AM/SAM/SSB)',adv:true},
    {n:'ppm',t:'range',min:-100,max:100,step:.1,d:0,label:'frequency correction, ppm',adv:true},
    // up/down-конвертер: эфирная частота = частота тюнера + смещение (−125 для апконвертера 125 МГц, +9750 для LNB)
    {n:'conv',t:'num',d:0,label:'converter offset, MHz (RF = tuner + offset)',adv:true},
    {n:'usbId',t:'text',d:'',hidden:true},
    {n:'devKind',t:'text',d:'',hidden:true},
    {n:'specSize',t:'select',opts:['512','1024','2048','4096','8192','16384','32768','65536'],d:'4096',label:'spectrum FFT size'},
    {n:'specWin',t:'select',opts:['hann','hamming','blackman','rect'],d:'hann',label:'spectrum window',adv:true},
    // Уэлч: сколько кадров (с перекрытием 50%) усреднять за одно обновление; all — весь поток
    {n:'specAvg',t:'select',opts:['off','4','16','64','all'],d:'all',label:'spectrum averaging, frames',adv:true},
    // широкополосное сканирование: 'spec' — панорама всего диапазона; маркер на tuneFreq — пауза и прослушивание
    {n:'sweep',t:'check',d:false,label:'wideband sweep'},
    {n:'swLo',t:'range',min:.1,max:30000,step:.1,d:88,log:true,label:'sweep from, MHz'},
    {n:'swHi',t:'range',min:.1,max:30000,step:.1,d:108,log:true,label:'sweep to, MHz'},
    {n:'swFft',t:'select',opts:['256','512','1024','2048','4096','8192'],d:'1024',label:'sweep FFT size',adv:true},
    {n:'swAvg',t:'range',min:1,max:64,step:1,d:8,label:'sweep averages per step',adv:true},
    {n:'swMode',t:'select',opts:['avg','max'],d:'avg',label:'sweep detector',adv:true},
    {n:'swUse',t:'range',min:.3,max:1,step:.05,d:.8,label:'sweep usable band fraction',adv:true},
    {n:'swSettle',t:'range',min:0,max:50,step:1,d:5,label:'sweep settle time, ms',adv:true}
  ],
  init:n=>{ n.p.freq=n.p.freq??100000000;              // новый узел — без частоты крутилка показывала NaN
            n.dev=null; n.connected=false; n.reading=false; n.sourceRate=1024000;
            n.underrunsWorker=0; n.underrunsOverflow=0; n.underrunsStarve=0;
            n.status='not connected'; n.busy=false; n.specWorker=null; n.specBusy=false;
            n.workerMs=null; n.roundtripMs=null;
            n.appliedFreq=null; n.appliedPpm=null; n.appliedGainKey=null; n.appliedBias=null; n.dcOff=0;
            // 4 канала демодуляции; канал 0 без цифрового суффикса в портах, активен всегда
            // (обратная совместимость), 1-3 поднимаются лениво при первом числе на их tuneFreqN.
            // частота настройки каждого канала — НЕ параметр с текстовым полем (умышленно: поле
            // визуально не обновляется при программной установке кликом/пином, а только при вводе
            // руками — как и с маркерами в 'sa'/'persist'). null = "следовать за центром".
            n.ch=[0,1,2,3].map(()=>({worker:null,aring:null,active:false,
              readPos:0,readCount:0,rebuffering:false,appliedOffset:0,
              hardKey:null,softKey:null,tuneFreq:null}));
            rtlResetRing(n); },
  dispose:n=>{ rtlDisconnect(n).catch(e=>console.error('rtlsdr dispose:',e)); },
  process(n,I){
    // Центр приёмника (n.p.freq) меняют четыре источника, по приоритету:
    //   1. ручной ввод (крутилка/поле узла);
    //   2. вход 'freq' — только в момент смены значения;
    //   3. 'steerFreq' (перетаскивание спектра в 'sa') — только при смене значения;
    //   4. 'tuneFreq..4' — смена значения за пределами захваченной полосы.
    // Все срабатывают по фронту, а не каждый тик: держащий старое значение провод не тянет центр обратно.
    const cf0=n.actualFreq??n.p.freq, half0=n.sourceRate/2, now=performance.now();
    const binHz=n.sourceRate/(+n.p.specSize||4096);
    let target=null, prio=0;
    if(n._prevPFreq!=null && n.p.freq!==n._prevPFreq){ target=n.p.freq; prio=1; }
    const freqEdge=typeof I.freq==='number' && I.freq!==n._inFreq;
    n._inFreq=I.freq;
    if(freqEdge && !target){ target=I.freq; prio=2; }
    // steerFreq: отсекаем эхо — 'sa' сам сдвигает окно вслед за новым спектром после перестройки
    // (центр окна отличается от центра приёмника на доли бина), и паузу после приоритетов 1-2,
    // пока спектр со старой частотой ещё может встретиться в 'sa'
    if(typeof I.steerFreq==='number' && I.steerFreq!==n._inSteer){
      const first=n._inSteer===undefined;             // первое значение после загрузки — точка отсчёта, не команда
      n._inSteer=I.steerFreq;
      if(first) n._steerPending=null;
      else {
        // 'sa' идёт за центром спектра, а он при dcShift не совпадает с n.p.freq
        const tol=Math.max(2*binHz, 50), echo=Math.abs(I.steerFreq-(n.p.freq??cf0))<=tol || Math.abs(I.steerFreq-cf0)<=tol;
        n._steerPending = (echo || now<(n._steerMuteUntil||0)) ? null : I.steerFreq;
      }
    } else if(typeof I.steerFreq!=='number') n._inSteer=I.steerFreq;
    if(n.p.sweep) n._steerPending=null;             // панорама не "ведёт" приёмник
    if(!target && n._steerPending!=null && now-(n._lastSteerRetune||0)>=80){
      target=n._steerPending-(n.dcOff||0); prio=3; n._steerPending=null; n._lastSteerRetune=now;   // троттлинг физической перестройки при драге
    }
    // tuneFreq: смена значения — новая частота канала; за пределами полосы — ещё и перестройка центра
    for(let ci=0;ci<4;ci++){
      const ch=n.ch[ci], v=I['tuneFreq'+RTL_CH_SUFFIX[ci]];
      if(v===ch._inTune) continue;
      ch._inTune=v;
      if(typeof v==='number'){
        if(ci>0 && !ch.active) rtlActivateChannel(n,ci);
        ch.tuneFreq=v;
        if(!target && Math.abs(v-cf0)>half0){ target=v; prio=4; }
      } else ch.tuneFreq=null;                       // маркер сняли — канал снова следует за центром
    }
    // сканирование: появился маркер — центр на него (проход встанет на паузу сам)
    const lf=n.p.sweep ? sdrListenFreq(n) : null;
    if(lf!=null && n._swListen==null && target==null){ target=lf; prio=4; }
    n._swListen=lf;
    if(target!=null){
      if(target!==n.p.freq){ n.p.freq=target; n.set.freq?.(target); }
      if(prio<=2) n._steerMuteUntil=now+600;
      // каналы, чья частота не попадает в новую полосу, возвращаем к центру
      for(const ch of n.ch) if(ch.tuneFreq!=null && Math.abs(ch.tuneFreq-target-(n.dcOff||0))>half0) ch.tuneFreq=null;
    }
    // gainDb/demod/bw — часто одновременно и подключены (например, с выбранной закладки), и хочется
    // покрутить руками поверх — setModWired (processing.js) даёт ручной правке победить, пока сам
    // провод не укажет на другое значение (та же идея, что у freq/steerFreq выше, общим хелпером).
    setModWired(n,'gainDb', I.gainDb, typeof I.gainDb==='number');
    if(typeof I.gainDb==='number' && n.p.auto){ if(n.set?.auto) n.set.auto(false); else n.p.auto=false; }   // провод на gain — ручной режим
    setModWired(n,'demod', I.demod, typeof I.demod==='string' && DEMOD_OPTS.includes(I.demod));
    setModWired(n,'bw', I.bw, typeof I.bw==='number');
    { const mode=n.p.demod, lim=RTL_BW_LIMITS[mode];
      if(lim){
        const key='if'+mode;
        if(n._bwMode!==mode){                       // сменили режим — ползунок на ширину этого режима
          n._bwMode=mode;
          const v=n.p[key]>0 ? n.p[key] : RTL_BW_DEF[mode];
          if(n.p.bw!==v) setMod(n,'bw',v);
        } else if(n.p.bw!==n.p[key]){               // ползунок/провод/край шторки — запоминаем для режима
          const v=Math.round(clamp(n.p.bw,lim[0],lim[1]));
          n.p[key]=v; if(v!==n.p.bw) setMod(n,'bw',v);
        }
      }
    }
    const cf=n.actualFreq??n.p.freq, half=n.sourceRate/2;
    rtlApplyPending(n); // не await — асинхронно применится, когда сможет (только 'freq'/gain — через USB)
    n.decim=rtlDecimFor(n.p.demod, n.sourceRate, n.p.bw); // дёшево, держим свежим каждый тик — читает rtlReadChannelAudio и readerLoop

    // конфиг и дешёвая NCO-перестройка для всех АКТИВНЫХ каналов разом
    for(let ci=0;ci<4;ci++){
      const ch=n.ch[ci]; if(!ch.active || !ch.worker) continue;
      // demod/sourceRate поменялись — жёсткий сброс состояния фильтра в воркере (иначе звучит
      // как каша из старого и нового режима). bw/deemph — просто пересчёт коэффициентов на лету.
      const hardKey=n.p.demod+'|'+n.sourceRate;
      if(hardKey!==ch.hardKey){
        ch.hardKey=hardKey;
        ch.worker.config(rtlWorkerCfg(n));
        ch.worker.reset();
        rtlResizeChannelRing(n, ch);   // decim мог смениться вместе с mode — кольцо иначе рассинхронизируется со временем
      } else {
        const softKey=rtlSoftKey(n);
        if(softKey!==ch.softKey){
          ch.softKey=softKey;
          ch.worker.config(rtlWorkerCfg(n));
          // кольцо — только если сменилась децимация (bw у SSB, широкая полоса ПЧ у WFM); иначе
          // при перетаскивании края шторки звук обрывался бы на каждом шаге
          if(ch.ringDecim!==n.decim) rtlResizeChannelRing(n, ch);
        }
      }
      const wantTune=clamp(ch.tuneFreq==null?sdrCenter(n):ch.tuneFreq, cf-half, cf+half), wantOffset=wantTune-cf;
      if(Math.abs(wantOffset-ch.appliedOffset)>0.5){
        ch.worker.setOffset(wantOffset);
        ch.appliedOffset=wantOffset;
      }
      // другая станция — RDS прежней больше не показываем, декодер начинает с нуля
      if(ch._rdsF==null || Math.abs(wantTune-ch._rdsF)>2000){
        ch._rdsF=wantTune;
        if(ch.rds){ ch.rds=null; ch.worker.rdsReset(); }
      }
    }

    const sweepOn=n.p.sweep && n.connected && !n.dev?.fixedFreq;
    if(!n.p.sweep && n.sw){ n.sw=null; n.swErr=null; }
    if(sweepOn && lf==null && !n.swRunning) sdrSweepLoop(n);
    if(!n.swActive) rtlUpdateSpec(n);
    // при прослушивании живой спектр ложится на свой участок панорамы
    if(sweepOn && n.sw && !n.swActive && n.spec && n.spec.rev!==n._swOvRev && !n.busy && n.appliedFreq!=null){
      n._swOvRev=n.spec.rev; sdrSweepOverlay(n, n.sw, n.spec);
    }
    const spOut=sweepOn && n.sw ? n.sw.spec : n.spec;
    // полосы канальных фильтров активных каналов — 'sa' рисует их шторками вокруг частот каналов
    if(spOut){
      // линии порога — только на живом спектре: у панорамы sweep своя шкала бинов
      spOut.chans=n.swActive ? null : rtlChanBands(n, cf, half).map(c=>rtlChanMeter(n, c, !sweepOn));
      // обратный канал для 'sa': перетаскивание края шторки задаёт новую ширину полосы ПЧ
      spOut.setChanBw=n._setChanBw||(n._setChanBw=(mode,w)=>{
        const lim=RTL_BW_LIMITS[mode]; if(lim) setMod(n,'bw',Math.round(clamp(w,lim[0],lim[1])));
      });
    }
    // SNR каналов — по живому спектру, раз на его кадр
    if(n.spec && n.spec.rev!==n._snrRev && !n.swActive){
      n._snrRev=n.spec.rev;
      for(const b of rtlChanBands(n, cf, half)){
        const ch=n.ch[b.idx], v=rtlChanSnr(n.spec, b.lo, b.hi);
        if(v==null){ ch.snr=null; ch.noiseDb=null; continue; }
        ch.snr = ch.snr==null ? v.snr : ch.snr*0.5+v.snr*0.5;
        ch.noiseDb = ch.noiseDb==null ? v.nzDb : ch.noiseDb*0.5+v.nzDb*0.5;
      }
    }
    const oi=buf(n,'I'), oq=buf(n,'Q');
    const oa=[buf(n,'audio'), buf(n,'audio2'), buf(n,'audio3'), buf(n,'audio4')];
    const tf=n.ch.map(ch=>clamp(ch.tuneFreq==null?sdrCenter(n):ch.tuneFreq, cf-half, cf+half));
    const bounds={freqLo:cf-half, freqHi:cf+half,               // край захваченной полосы + настройка каждого канала
      tuneFreq:tf[0], tuneFreq2:tf[1], tuneFreq3:tf[2], tuneFreq4:tf[3]};

    if(n.p.demod==='IQ') rtlReadIQ(n, oi, oq); else { oi.fill(0); oq.fill(0); }
    const oL=buf(n,'audioL'), oR=buf(n,'audioR');
    rtlReadChannelAudio(n, n.ch[0], oa[0], oL, oR);  // канал 1 — ещё и стерео
    for(let ci=1;ci<4;ci++) rtlReadChannelAudio(n, n.ch[ci], oa[ci]);
    const rds=n.ch[0].rds;

    n._prevPFreq=n.p.freq; // снимок на конец тика — см. manualEdit в начале process() (demod/bw/gainDb — через setModWired)
    return {I:oi, Q:oq, iq:rtlIqOut(n), audio:oa[0], audio2:oa[1], audio3:oa[2], audio4:oa[3], audioL:oL, audioR:oR,
      ps:rds&&rds.sync!==undefined&&rds.ps.trim()?rds.ps.trim():null, rt:rds&&rds.rt?rds.rt:null, spec:spOut,
      demod:n.p.demod, bw:n.p.bw, ...bounds,
      adcPk:n.adcPk??null, adcRms:n.adcRms??null, clip:n.adcClip!=null?100*n.adcClip:null, ovl:sdrAdcOvl(n)?1:0,
      ...rtlChanOuts(n)}; },
  // Собственная отрисовка спектра/водопада убрана — для этого универсальный узел 'sa'
  // (Спектроанализатор), подключаемый к выходу 'spec'. Здесь остаётся только статус-строка.
  draw(n){
    // Табло ввода центральной частоты (drawFreqDial, как у 'tuner', но без крутилки: разряд меняется
    // ведением пальца вверх-вниз) — вместо обычного текстового поля с числом. Не через стандартный d.view (тот канвас движок кладёт
    // ПОСЛЕ всех params — а частота тут самое важное поле, ей место сверху), поэтому канва
    // заводится и позиционируется вручную, первым элементом .mid, с тем же hiDPICanvas для
    // чёткости на ретине/мобиле, что и у обычных view-канвасов.
    // проверяем принадлежность текущему .el, а не isConnected: rebuildNode строит новый .el,
    // а временно отсоединённый от документа узел (тайлы) иначе получал новую канву каждый кадр
    if((!n._dialCv || !n.el?.contains(n._dialCv)) && n.el){
      const mid=n.el.querySelector('.mid');
      if(mid){
        const cv=document.createElement('canvas'); cv.className='view';
        const dcx=cv.getContext('2d',{willReadFrequently:true});
        mid.insertBefore(cv, mid.firstChild);
        cv.width=200; cv.height=46; cv.style.height='46px';
        hiDPICanvas(cv,dcx,n);
        n._dialCv=cv; n._dialCx=dcx; n._dial={};
      }
    }
    if(n._dialCv) drawFreqDial(n.el, n._dialCv, n._dialCx, n._dial, ()=>n.p.freq, v=>{ n.p.freq=v; }, {dial:false});
    const cf=n.actualFreq??n.p.freq;
    const tune=clamp(n.ch[0].tuneFreq==null?sdrCenter(n):n.ch[0].tuneFreq, cf-n.sourceRate/2, cf+n.sourceRate/2);
    // HackRF: ступени LNA/VGA/amp вместо auto/gainDb
    const hk=n.p.devKind==='hackrf', fl=n.p.devKind==='file', dm=n.p.demod;
    const sq=n.p.sql;
    if(n.el && (n._rowsEl!==n.el || n._rowsHk!==hk || n._rowsFl!==fl || n._rowsDm!==dm || n._rowsSq!==sq)){
      n._rowsEl=n.el; n._rowsHk=hk; n._rowsFl=fl; n._rowsDm=dm; n._rowsSq=sq;
      // настройки демодулятора — только те, что действуют в текущем режиме
      const wfm=dm==='WFM', hf=['AM','SAM','USB','LSB'].includes(dm);
      for(const [k,show] of [['deemph',wfm],['stereo',wfm],['agc',hf],['anf',hf],['samSb',dm==='SAM'],['nb',dm!=='IQ'],
          ['sql',dm!=='IQ'],['sqlSnr',dm!=='IQ'&&sq==='SNR'],['sqlLvl',dm!=='IQ'&&sq==='level'],['sqlHang',dm!=='IQ'&&sq!=='off'],
          ['lna',hk],['vga',hk],['amp',hk],['auto',!hk&&!fl],['gainDb',!hk&&!fl],
          ['bias',!fl],['ppm',!fl],['conv',!fl],['dcShift',!fl],['loop',fl],['seek',fl],
          ...['sweep','swLo','swHi','swFft','swAvg','swMode','swUse','swSettle'].map(k=>[k,!fl])]){
        const e=n.el.querySelector(`.prm[data-param="${k}"]`); if(e) e.style.display=show?'':'none';
      }
    }
    // строка состояния — не чаще 4 раз/с и только при изменении: каждая запись — layout и paint
    const now=performance.now();
    if(now-(n._roT||0)<250) return;
    n._roT=now;
    const chCount=n.ch.filter(c=>c.active).length;
    const r=n.el.querySelector('.readout');
    const txt = n.connected
      ? `${n.dev?n.dev.tunerName:'?'} · ${n.p.demod} · ${fmtHz(cf,3)} ±${fmtHz(n.sourceRate/2)} · tune ${fmtHz(tune,3)} · `+
        `${(n.mspsIo||0).toFixed(2)} Msps · ch ${chCount}`+
        (n.specK>1 ? ` · fft avg ×${n.specK}` : '')+
        (sdrConv(n) ? ` · conv ${sdrConv(n)>0?'+':''}${fmtHz(sdrConv(n),3)}` : '')+
        (n.p.demod==='WFM' ? (n.ch[0].stereo?' · ST':' · mono') : '')+
        (n.p.demod==='SAM' && n.ch[0].sam ? (n.ch[0].sam.lock ? ` · lock ${n.ch[0].sam.hz>=0?'+':''}${n.ch[0].sam.hz.toFixed(0)} Hz` : ' · no lock') : '')+
        (n.p.demod==='WFM' && n.ch[0].rds && n.ch[0].rds.pi>=0
          ? ` · RDS ${n.ch[0].rds.pi.toString(16).toUpperCase().padStart(4,'0')} "${n.ch[0].rds.ps.trim()}"`+(n.ch[0].rds.rt?` ${n.ch[0].rds.rt}`:'') : '')+
        (n.ch[0].rssi!=null ? ` · RSSI ${n.ch[0].rssi.toFixed(0)} dBFS` : '')+
        (n.ch[0].snr!=null ? ` · SNR ${n.ch[0].snr.toFixed(0)} dB` : '')+
        (n.p.sql!=='off' ? (n.ch[0].sqOpen===false ? ' · SQL closed' : ' · SQL open') : '')+
        (n.workerMs!=null?` · dsp ${n.workerMs.toFixed(1)}/${(n.roundtripMs||0).toFixed(1)} ms`:'')+
        // разбивка по стадии, где реально теряются данные: demod — воркер не успел (вход),
        // ovf — consumer (Eng.tick) отстал, кольцо переполнилось и пришлось прыгнуть вперёд,
        // dry — consumer остался без данных (кольцо опустело быстрее, чем producer его наполнял)
        ((n.underrunsWorker||n.underrunsOverflow||n.underrunsStarve)?
          ` · errors demod:${n.underrunsWorker||0} ovf:${n.underrunsOverflow||0} dry:${n.underrunsStarve||0}`:'')+
        (n.adcPk!=null ? ` · ADC pk ${n.adcPk.toFixed(1)} rms ${n.adcRms.toFixed(0)} dBFS` : '')+
        (sdrAdcOvl(n) ? ` · ⚠ OVERLOAD ${(100*n.adcOvlClip).toFixed(2)}% — reduce gain` : '')+
        (n.busy?' · …':'')+
        (n.dev?.kind==='file' ? ` · ${iqFmtTime(n.dev.pos/n.dev.rate)} / ${iqFmtTime(n.dev.total/n.dev.rate)}`+(n.dev.ended?' (end)':'') : '')+
        (n.rec ? ` · ● REC ${iqFmtTime((Date.now()-n.rec.start)/1000)} ${(n.rec.bytes/1e6).toFixed(0)} MB` : n.recMsg ? ' · '+n.recMsg : '')+
        (n.swErr ? ' · sweep error: '+n.swErr : n.p.sweep && n.sw ? ` · sweep ${fmtHz(n.sw.lo,1)}–${fmtHz(n.sw.lo+n.sw.spec.size*n.sw.binHz,1)} `+
          (n.swActive ? `step ${n.sw.k+1}/${n.sw.hops}`+(n.sw.lineMs ? ` · ${(n.sw.lineMs/1000).toFixed(1)} s/line` : '') : '(paused, listening)') : '')
      : n.status;
    if(r && r.textContent!==(txt??'')) r.textContent=txt??'';
  }});


// ---- KiwiSDR — обычный браузерный WebSocket (без WebUSB, работает по сети).
// Протокол восстановлен по референсному Python-клиенту kiwiclient (jks-prv/kiwiclient,
// kiwi/client.py) — официальной текстовой спецификации у KiwiSDR нет.
// SND-сокет: ws://host:port/<ts>/SND. После открытия: 'SET auth t=kiwi p=<pass>',
// затем 'SET compression=0' (просим НЕсжатый PCM — так не нужен декодер IMA-ADPCM),
// затем 'SET mod=<mod> low_cut=<Гц> high_cut=<Гц> freq=<кГц>' (частота — в кГц!),
// раз в секунду — 'SET keepalive' (иначе сервер рвёт соединение по таймауту).
// Кадр SND: [flags:u8][seq:u32 LE][smeter:u16 BE][...PCM16 BE моно...] — 7 байт заголовка.
// Демодуляция и АРУ — на стороне приёмника, нам отдают уже готовое аудио на audio_rate
// (обычно 12000 Гц), которое ресемплируем в Eng.sr так же, как для rtl-sdr.
// wss (TLS) для публичных Kiwi — редкость, большинство слушает на обычном ws://.
// Если страница открыта по https, браузер заблокирует ws:// как небезопасный контент —
// тогда нужен http (или сервер с TLS).

// список публичных приёмников не тянется живьём: официального JSON API у kiwisdr.com/public/
// нет (это html-страница), а стабильного CORS-доступа к сторонним каталогам (receiverbook.de
// и т.п.) из браузера ждать нельзя. Так что это просто стартовый набор для быстрого выбора —
// адреса могут устареть, актуальный список смотреть на kiwisdr.com/public/ и вписывать вручную.
const KIWI_PUBLIC_LIST=[
  'sdr1.on1aff.be:8073','kiwisdr.oh6ai.fi:8073','iw3hbx.ddns.net:5555',
  'canadian-prairies-shortwave.ddns.net:8073','sm2byc.ddns.net:8073',
  'db0bbb.dnshome.de:8073','f5nkp.freeboxos.fr:8073'
];

function kiwiParseHostPort(s){
  s=String(s||'').trim().replace(/^wss?:\/\//,'').replace(/^https?:\/\//,'').replace(/\/.*$/,'');
  const m=s.match(/^([^:]+):(\d+)$/);
  return m? {host:m[1],port:+m[2]} : {host:s,port:8073};
}

// низкая/высокая граница полосы относительно несущей — упрощённо, по мотивам таблицы
// default_passbands из kiwiclient (300 Гц сдвиг для SSB/CW, симметрично для AM/NFM).
// Жёстко ограничиваем итоговый край полосы MAXHZ: аудио-поток идёт на 12 кГц, его физический
// Найквист — 6000 Гц, а запрошенный high_cut/low_cut за его пределами Kiwi-сервер молча
// отвергает и остаётся на дефолтной (обычно ~2.7 кГц у SSB) полосе — снаружи это выглядит
// так, будто ширина полосы вообще ни на что не влияет.
function kiwiPassband(mod,bw){
  bw=Math.max(50,+bw||4900);
  const MAXHZ=5400;
  if(mod==='usb') return [300, Math.min(300+bw,MAXHZ)];
  if(mod==='lsb') return [-Math.min(300+bw,MAXHZ),-300];
  if(mod==='cw')  return [300,300+Math.min(bw,500)];
  const half=Math.min(bw/2,MAXHZ); return [-half,half]; // am, nbfm
}
const KIWI_ZC=12;   // половина ширины окна sinc-интерполятора, в отсчётах исходного потока

function kiwiResetRing(n){
  const SIZE=Math.max(200000,Math.round((n.audioRate||12000)*4));
  n.ring={A:new Float32Array(SIZE),size:SIZE,w:0,filled:0,written:0};
  n.readPos=0; n.readCount=0; n.rebuffering=false;
}

function kiwiSend(n,msg){ if(n.ws && n.ws.readyState===1) n.ws.send(msg); }

function kiwiSetMod(n){
  const [lc,hc]=kiwiPassband(n.p.mod,n.p.bw);
  kiwiSend(n,`SET mod=${n.p.mod} low_cut=${Math.round(lc)} high_cut=${Math.round(hc)} freq=${(n.p.freq/1000).toFixed(3)}`);
}

// со страницы на https WebSocket обязан быть wss — это mixed content, браузер режет жёстче
// CSP и без обходов на стороне JS. Почти все публичные Kiwi слушают только голый ws://, так
// что при https-хостинге инструмента нужен свой wss-прокси с TLS-терминацией (см. комментарий
// у параметра 'proxy' ниже) — без него узел с https-страницы принципиально не подключится.
function kiwiWsUrl(n,host,port,path){
  if(location.protocol==='https:'){
    const base=String(n.p.proxy||'/kiwiproxy').replace(/\/+$/,'');
    return `wss://${location.host}${base}/${host}/${port}/${path}`;
  }
  return `ws://${host}:${port}/${path}`;
}

function kiwiConnect(n){
  if(n.connected||n.connecting) return;
  const {host,port}=kiwiParseHostPort(n.p.server);
  if(!host){ n.status='server address not set'; return; }
  n.connecting=true; n.status='connecting…';
  let ws;
  try{ ws=new WebSocket(kiwiWsUrl(n,host,port,`${Date.now()}/SND`)); }
  catch(e){ n.connecting=false; n.status='error: '+e.message; return; }
  ws.binaryType='arraybuffer';
  n.ws=ws; n.audioRate=12000; n.rssi=0; kiwiResetRing(n);
  // если открытие вообще не произойдёт (недоступный хост, фаервол, нет прокси) — не виснуть
  const openTimeout=setTimeout(()=>{
    if(n.connecting){ n.status='no response from server (timeout)'; try{ ws.close(); }catch(e){} }
  },8000);
  ws.onopen=()=>{
    clearTimeout(openTimeout);
    kiwiSend(n,'SET auth t=kiwi p=');
    kiwiSend(n,'SET compression=0');
    kiwiSetMod(n);
    kiwiSend(n,'SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
    n.appliedFreq=n.p.freq; n.appliedMod=n.p.mod; n.appliedBw=n.p.bw;
    n.connecting=false; n.connected=true; n.status='connected';
    n.kaTimer=setInterval(()=>kiwiSend(n,'SET keepalive'),1000);
  };
  ws.onmessage=(ev)=>{
    if(!(ev.data instanceof ArrayBuffer) || ev.data.byteLength<3) return;
    const u8=new Uint8Array(ev.data);
    const tag=String.fromCharCode(u8[0],u8[1],u8[2]);
    const body=u8.subarray(3);
    if(tag==='MSG'){
      const text=new TextDecoder().decode(body.subarray(1)); // 1й байт тела MSG — служебный, пропускаем
      for(const pair of text.split(' ')){
        const eq=pair.indexOf('=');
        const name=eq<0?pair:pair.slice(0,eq), value=eq<0?null:pair.slice(eq+1);
        if(name==='audio_rate'){ n.audioRate=+value||12000; kiwiResetRing(n); kiwiSend(n,`SET AR OK in=${n.audioRate} out=44100`); }
        else if(name==='too_busy') n.status='server busy (all slots taken)';
        else if(name==='badp') n.status='auth error ('+value+')';
        else if(name==='down') n.status='server currently unavailable';
        else if(name==='redirect') n.status='server is redirecting connection';
      }
    } else if(tag==='SND'){
      if(body.length<7) return;
      const dv=new DataView(body.buffer,body.byteOffset,body.length);
      const smeter=dv.getUint16(5,false);
      n.rssi=0.1*smeter-127;
      const data=body.subarray(7), count=data.length>>1;
      const dvA=new DataView(data.buffer,data.byteOffset,data.length);
      const ring=n.ring; let w=ring.w, filled=ring.filled;
      for(let i=0;i<count;i++){
        ring.A[w]=dvA.getInt16(i*2,false)/32768; // без compression=0 пришёл бы IMA-ADPCM — просили raw PCM16 BE
        w=(w+1)%ring.size; if(filled<ring.size) filled++;
      }
      ring.w=w; ring.filled=filled; ring.written+=count;
    }
  };
  ws.onclose=(ev)=>{ n.connected=false; n.connecting=false;
    if(n.status==='connected'||n.status==='connecting…') n.status=`disconnected (code ${ev.code}${ev.reason?': '+ev.reason:''})`;
    if(n.kaTimer){ clearInterval(n.kaTimer); n.kaTimer=null; } };
  ws.onerror=()=>{ n.status='connection error (see browser console for details)'; };
}

function kiwiDisconnect(n){
  if(n.kaTimer){ clearInterval(n.kaTimer); n.kaTimer=null; }
  if(n.ws){ try{ n.ws.close(); }catch(e){} n.ws=null; }
  n.connected=false; n.connecting=false; n.status='disconnected';
}

def({ id:'kiwisdr', title:'KiwiSDR', cat:'Sources',
  ins:[{n:'freq',t:'num'}], outs:[{n:'audio',t:'sig'},{n:'rssi',t:'num'}],
  view:{h:40}, readout:true,
  params:[
    {n:'preset',t:'select',opts:['— custom —',...KIWI_PUBLIC_LIST],d:'— custom —',label:'public receivers',
     fn:n=>{ if(n.p.preset!=='— custom —'){ n.p.server=n.p.preset; if(n.set&&n.set.server) n.set.server(n.p.server); } }},
    {n:'server',t:'text',d:'sdr1.on1aff.be:8073',label:'host:port'},
    {n:'proxy',t:'text',d:'/kiwiproxy',label:'wss proxy (path on your server, see nginx config)'},
    {n:'connect',t:'button',label:'Connect',fn:n=>kiwiConnect(n)},
    {n:'disconnect',t:'button',label:'Disconnect',fn:n=>kiwiDisconnect(n)},
    {n:'freq',t:'num',d:7000000,label:'frequency, Hz'},
    {n:'mod',t:'select',opts:['am','lsb','usb','cw','nbfm'],d:'am',label:'demodulation',
     fn:n=>{ if(n.connected) kiwiSetMod(n); }},
    {n:'bw',t:'range',min:200,max:5400,step:100,d:4900,log:true,label:'bandwidth, Hz',
     fn:n=>{ if(n.connected) kiwiSetMod(n); }}
  ],
  init:n=>{ n.ws=null; n.connected=false; n.connecting=false; n.status='not connected';
            n.audioRate=12000; n.rssi=0; n.appliedFreq=null; kiwiResetRing(n); },
  dispose:n=>kiwiDisconnect(n),
  process(n,I){
    if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    // перестройка частоты у Kiwi — цифровая на стороне сервера и дешёвая, шлём сразу при изменении
    if(n.connected && Math.round(n.p.freq)!==Math.round(n.appliedFreq)){ n.appliedFreq=n.p.freq; kiwiSetMod(n); }
    const oa=buf(n,'audio'), ring=n.ring;
    if(!n.connected || ring.filled<ring.size*0.2){ oa.fill(0); return {audio:oa,rssi:n.rssi}; }
    const step=n.audioRate/Eng.sr, need=step*BLOCK;
    let lag=ring.written-n.readCount;
    if(lag>ring.size*0.9){ const delta=lag-ring.size*0.5; n.readPos=(n.readPos+delta)%ring.size; n.readCount+=delta; lag=ring.written-n.readCount; }
    if(n.rebuffering){
      if(lag<ring.size*0.2){ oa.fill(0); return {audio:oa,rssi:n.rssi}; }
      n.rebuffering=false;
    }
    if(lag<need){ n.rebuffering=true; oa.fill(0); return {audio:oa,rssi:n.rssi}; }
    // Полосовая (sinc) интерполяция вместо линейной: у линейной анти-imaging слишком слабый
    // (первый ноль ровно на Найквисте потока), а переходная полоса тут узкая — между краем
    // реальной SSB-полосы и её зеркалом от Найквиста часто меньше октавы, IIR-каскадом это
    // не выцепить (нужен порядок ~15-20). Windowed sinc с шириной окна ZC даёт нужную крутизну
    // без нестабильных высоких порядков.
    const [lc,hc]=kiwiPassband(n.p.mod,n.p.bw), edge=Math.max(Math.abs(lc),Math.abs(hc));
    const fc=Math.min(edge*1.05, n.audioRate*0.48), fcNorm=fc/n.audioRate;   // доля от исходной частоты (не Найквиста)
    for(let k=0;k<BLOCK;k++){
      const base=Math.floor(n.readPos);
      let acc=0;
      for(let j=-KIWI_ZC+1;j<=KIWI_ZC;j++){
        const d=n.readPos-(base+j);
        if(Math.abs(d)>=KIWI_ZC) continue;
        const x=2*fcNorm*d, s=x===0?1:Math.sin(Math.PI*x)/(Math.PI*x);
        const t=(d+KIWI_ZC)/(2*KIWI_ZC), w=0.42-0.5*Math.cos(2*Math.PI*t)+0.08*Math.cos(4*Math.PI*t);
        const idx=(((base+j)%ring.size)+ring.size)%ring.size;
        acc += ring.A[idx]*2*fcNorm*s*w;
      }
      oa[k]=acc;
      n.readPos+=step; n.readCount+=step;
    }
    n.readPos%=ring.size;
    return {audio:oa,rssi:n.rssi}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = n.connected
      ? `${n.p.server} · ${n.p.mod} · ${fmtHz(n.p.freq)} · RSSI ${n.rssi.toFixed(0)} dB`
      : n.status; }});

const KBD_MAP={a:0,w:1,s:2,e:3,d:4,f:5,t:6,g:7,y:8,h:9,u:10,j:11,k:12,o:13,l:14,p:15};

function midiNoteOn(n,note,vel){ n.notes=n.notes.filter(x=>x.note!==note); n.notes.push({note,vel}); }
function midiNoteOff(n,note){ n.notes=n.notes.filter(x=>x.note!==note); }
function midiHandle(n,ev){
  const [st,d1,d2]=ev.data, cmd=st&0xf0;
  if(cmd===0x90&&d2>0) midiNoteOn(n,d1,d2/127);
  else if(cmd===0x80||(cmd===0x90&&d2===0)) midiNoteOff(n,d1);
  else if(cmd===0xb0&&d1===n.p.ccNum) n.cc=d2/127;
}

def({ id:'midi', title:'MIDI Keyboard', cat:'Music',
  outs:[{n:'freq',t:'num'},{n:'gate',t:'sig'},{n:'vel',t:'num'},{n:'cc',t:'num'}],
  readout:true,
  params:[
    {n:'dev',t:'select',d:'none',label:'input',
     opts:()=>['none',...(n=>n?[...n.inputs.values()].map(i=>i.name):[])(navigator._midiAccess)],
     fn:n=>{ const a=navigator._midiAccess; if(!a) return;
             for(const i of a.inputs.values()) i.onmidimessage=(i.name===n.p.dev)?(ev=>midiHandle(n,ev)):null; }},
    {n:'on',t:'button',label:'Allow MIDI',fn:async n=>{
       try{ const a=await navigator.requestMIDIAccess();
            navigator._midiAccess=a; if(n.set&&n.set.dev) n.set.dev(); }
       catch(e){ n.status='no access: '+e.message; } }},
    {n:'kbd',t:'check',d:true,label:'computer keys (a-l = C-...)'},
    {n:'oct',t:'range',min:-3,max:3,step:1,d:0,label:'octave'},
    {n:'ccNum',t:'num',d:1,label:'CC number'}],
  init:n=>{ n.notes=[]; n.vel=0; n.cc=0; n.freqOut=440; n.kbdDown=new Set(); n.status='no MIDI device';
    if(!midi._kbdBound){                              // один глобальный слушатель на все midi-узлы
      midi._kbdBound=true;
      window.addEventListener('keydown',ev=>{
        const t=ev.target; if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
        const k=ev.key.toLowerCase(); if(!(k in KBD_MAP)||ev.repeat) return;
        for(const nn of Graph.nodes) if(nn.type==='midi'&&nn.p.kbd&&!nn.kbdDown.has(k)){
          nn.kbdDown.add(k); midiNoteOn(nn,60+nn.p.oct*12+KBD_MAP[k],1); } });
      window.addEventListener('keyup',ev=>{
        const k=ev.key.toLowerCase(); if(!(k in KBD_MAP)) return;
        for(const nn of Graph.nodes) if(nn.type==='midi'&&nn.kbdDown.has(k)){
          nn.kbdDown.delete(k); midiNoteOff(nn,60+nn.p.oct*12+KBD_MAP[k]); } }); } },
  process(n){
    const gate=buf(n,'gate'), cur=n.notes[n.notes.length-1];
    const target=cur? 440*Math.pow(2,(cur.note-69)/12) : n.freqOut;
    n.freqOut+=(target-n.freqOut)*(cur?0.35:0);        // лёгкий глайд только к новой ноте, не к отпусканию
    if(cur) n.vel=cur.vel;
    const g=n.notes.length?1:0;
    gate.fill(g);
    return {freq:n.freqOut, gate, vel:n.vel, cc:n.cc}; },
  draw(n){ n.el.querySelector('.readout').textContent =
    n.notes.length ? 'note '+n.notes[n.notes.length-1].note+' · '+n.notes.length+' held' : n.status; }});
const midi={};                                          // общий флаг привязки клавиатурного слушателя

def({ id:'clock', title:'Master Clock', cat:'Music',
  outs:[{n:'pulse',t:'sig'},{n:'step',t:'num'},{n:'bpm',t:'num'}],
  readout:true,
  params:[
    {n:'bpm',t:'range',min:20,max:300,step:1,d:120},
    {n:'div',t:'select',opts:['1/4','1/8','1/16','1/32'],d:'1/16'},
    {n:'run',t:'check',d:true,label:'play'},
    {n:'reset',t:'button',label:'Reset',fn:n=>{ n.step=0; n.samplesLeft=0; }}],
  init:n=>{ n.step=0; n.samplesLeft=0; n.stepLen=0; },
  process(n){
    const pulse=buf(n,'pulse'), p=n.p;
    const div={'1/4':1,'1/8':2,'1/16':4,'1/32':8}[p.div]||4;
    n.stepLen=Math.round(Eng.sr*60/p.bpm/div);
    if(!n.samplesLeft) n.samplesLeft=n.stepLen;
    for(let i=0;i<BLOCK;i++){
      pulse[i]=0;
      if(!p.run) continue;
      if(n.samplesLeft<=0){ n.step++; n.samplesLeft=n.stepLen; pulse[i]=1; }
      n.samplesLeft--; }
    return {pulse, step:n.step, bpm:p.bpm}; },
  draw(n){ n.el.querySelector('.readout').textContent='step '+n.step+' · '+n.p.bpm+' BPM · '+n.p.div; }});

// формат секций: "A:4,B:4,A:2,C:8" — банк:число тактов, через запятую
function parseSongSeq(s){
  const out=[];
  if(s) for(const part of s.split(',')){
    const m=part.trim().match(/^([abcdABCD]):(\d+)$/);
    if(m) out.push({bank:'ABCD'.indexOf(m[1].toUpperCase()), bars:Math.max(1,+m[2])});
  }
  return out.length?out:[{bank:0,bars:4}];
}
function songBarsLabel(n){
  return n+' bar'+(n===1?'':'s');
}

def({ id:'song', lazy:'manual', title:'Arrangement (Playlist)', cat:'Music',
  ins:[{n:'clk',t:'sig'}],
  outs:[{n:'bank',t:'num'},{n:'bar',t:'num'},{n:'section',t:'num'}],
  view:{h:90}, resize:true, readout:true,
  params:[
    {n:'stepsPerBar',t:'range',min:1,max:64,step:1,d:16,label:'steps per bar'},
    {n:'loop',t:'check',d:true,label:'loop'},
    {n:'run',t:'check',d:true,label:'play'},
    {n:'reset',t:'button',label:'Reset',fn:n=>{ n.step=0; n.secIdx=0; n.barInSec=0; n._queued=null; }}],
  init:n=>{ n.secs=parseSongSeq(n.p.seq); n.p.seq=n.secs.map(s=>'ABCD'[s.bank]+':'+s.bars).join(',');
    n.step=0; n.secIdx=0; n.barInSec=0; n._queued=null; n.drag=null; },
  process(n,I){
    const p=n.p, clk=I.clk;
    if(!n.secs.length) n.secs.push({bank:0,bars:4});
    if(p.run && clk){
      for(let i=0;i<BLOCK;i++){
        if(clk[i]<=0.5) continue;
        n.step++;
        if(n.step%p.stepsPerBar!==0) continue;                    // такт ещё не закончился
        n.barInSec++;
        const cur=n.secs[Math.min(n.secIdx,n.secs.length-1)];
        if(n.barInSec>=cur.bars || n._queued!=null){               // такт кончился, либо очередь на переход
          n.barInSec=0;
          if(n._queued!=null){ n.secIdx=n._queued; n._queued=null; }
          else if(n.secIdx<n.secs.length-1) n.secIdx++;             // следующая секция
          else if(p.loop) n.secIdx=0;                                // конец — сначала
          // иначе остаёмся на последней секции и крутим её дальше
        } } }
    const cur=n.secs[Math.min(n.secIdx,n.secs.length-1)];
    redrawIf(n,n.secIdx+'|'+n.barInSec+'|'+n._queued+'|'+n.secs.length);
    return {bank:cur.bank, bar:n.barInSec, section:n.secIdx}; },
  // Горизонтальный таймлайн вместо списка со стрелочками — жесты как в пиано-ролле:
  // тащим тело блока — переставляем секцию местами с соседом, тащим правый край — меняем
  // длину в тактах, тап без движения — ставим секцию в очередь на переход, пустое место
  // справа — новая секция, значок банка/× — смена банка/удаление.
  draw(n){
    const cv=n.cv, cx=n.cx; if(!cv) return;
    const secs=n.secs;
    const bankColors=['#8ab4f8','#7fd17f','#e0b23c','#d18ad1'];
    const BADGE=16, CLOSE=14, HANDLE=8;
    const syncSeq=()=>{ n.p.seq=secs.map(s=>'ABCD'[s.bank]+':'+s.bars).join(','); };
    // геометрия — считаем заново на каждый вызов (не кэшируем в замыкании), иначе после
    // ресайза/реордера события ловились бы по старым координатам
    const geom=w=>{ const total=secs.reduce((a,s)=>a+s.bars,0)||1;
      const px=w/Math.max(total,8);
      const offs=[]; let c=0; for(const s of secs){ offs.push(c); c+=s.bars; }
      return {px,offs}; };
    const hitTest=(x,y,w,h)=>{
      const {px,offs}=geom(w);
      for(let i=0;i<secs.length;i++){
        const x0=offs[i]*px, x1=x0+secs[i].bars*px;
        if(x<x0||x>=x1) continue;
        if(x<x0+BADGE && y<BADGE) return {idx:i,zone:'badge'};
        if(x>x1-CLOSE && y<CLOSE) return {idx:i,zone:'close'};
        if(x>x1-HANDLE) return {idx:i,zone:'resize'};
        return {idx:i,zone:'body'};
      }
      return null;
    };
    const ZONE_CUR={badge:'pointer',close:'pointer',resize:'ew-resize',body:'grab'};
    if(!n._wired){
      n._wired=true;
      // clientX/Y минус rect.left/top — обе величины гарантированно в одной, экранной системе
      // координат (в отличие от offsetX/Y, который в части браузеров не учитывает CSS-scale
      // графа так же, как getBoundingClientRect()) — и пересчитываем пропорцию в логику канвы:
      // BADGE/CLOSE/HANDLE и вся геометрия посчитаны в логических пикселях, а не экранных.
      const toLocal=ev=>{ const r=cv.getBoundingClientRect();
        return [(ev.clientX-r.left)/r.width*cv.width, (ev.clientY-r.top)/r.height*cv.height]; };
      cv.addEventListener('pointerdown',ev=>{
        ev.stopPropagation();
        const [x,y]=toLocal(ev);
        const hit=hitTest(x,y,cv.width,cv.height);
        cv.setPointerCapture(ev.pointerId);
        if(!hit){ secs.push({bank:0,bars:4}); syncSeq(); return; }         // пусто справа — новая секция
        if(hit.zone==='badge'){ secs[hit.idx].bank=(secs[hit.idx].bank+1)%4; syncSeq(); return; }
        if(hit.zone==='close'){ secs.splice(hit.idx,1); if(!secs.length) secs.push({bank:0,bars:4}); syncSeq(); return; }
        if(hit.zone==='resize'){ n.drag={mode:'resize',idx:hit.idx}; cv.style.cursor='ew-resize'; return; }
        n.drag={mode:'move',idx:hit.idx,startPx:x,moved:false}; cv.style.cursor='grabbing'; });
      cv.addEventListener('pointermove',ev=>{
        const [x,y]=toLocal(ev);
        if(!n.drag){                                                        // не тащим — просто подсказываем курсором, что под ним
          const hit=hitTest(x,y,cv.width,cv.height);
          cv.style.cursor = hit ? ZONE_CUR[hit.zone] : 'copy'; return; }
        ev.stopPropagation();
        const {px,offs}=geom(cv.width), d=n.drag;
        if(d.mode==='resize'){
          secs[d.idx].bars=clamp(Math.round((x-offs[d.idx]*px)/px),1,999);
        } else if(Math.abs(x-d.startPx)>px*0.6){                            // переступили половину такта — меняем местами с соседом
          const i=d.idx;
          if(x>d.startPx && i<secs.length-1){ [secs[i],secs[i+1]]=[secs[i+1],secs[i]]; d.idx=i+1; d.startPx=x; d.moved=true; }
          else if(x<d.startPx && i>0){ [secs[i],secs[i-1]]=[secs[i-1],secs[i]]; d.idx=i-1; d.startPx=x; d.moved=true; }
        } });
      const endDrag=()=>{
        if(n.drag) cv.style.cursor='grab';
        if(!n.drag) return;
        if(n.drag.mode==='move' && !n.drag.moved) n._queued=n.drag.idx;    // клик без движения — в очередь на переход
        n.drag=null; syncSeq(); };
      cv.addEventListener('pointerup',endDrag);
      cv.addEventListener('pointercancel',endDrag); }
    const W=cv.width, H=cv.height;
    cx.clearRect(0,0,W,H);
    const {px,offs}=geom(W);
    if(px>=4){                                                             // сетка тактов — не рисуем, если сольётся в кашу
      cx.strokeStyle='rgba(255,255,255,.06)';
      const total=offs.length?offs[offs.length-1]+secs[secs.length-1].bars:0;
      for(let b=0;b<=total;b++){ const x=Math.round(b*px)+.5; cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); } }
    for(let i=0;i<secs.length;i++){
      const s=secs[i], x0=offs[i]*px, w=Math.max(2,s.bars*px);
      const isCur=i===n.secIdx, isQueued=n._queued===i;
      cx.globalAlpha=isCur?1:.55;
      cx.fillStyle=bankColors[s.bank]; cx.fillRect(x0+1,1,w-2,H-2);
      cx.globalAlpha=1;
      if(isQueued){ cx.strokeStyle='rgba(224,178,60,.9)'; cx.lineWidth=2; cx.strokeRect(x0+1,1,w-2,H-2); }
      cx.fillStyle=themeColor('--screen'); cx.font='bold 11px monospace'; cx.textAlign='left';
      cx.fillText('ABCD'[s.bank], x0+4, 13);
      cx.fillStyle='rgba(0,0,0,.65)'; cx.font='10px monospace';
      cx.fillText(songBarsLabel(s.bars), x0+4, H-6);
      if(w>CLOSE+4){ cx.fillStyle='rgba(0,0,0,.3)'; cx.fillRect(x0+w-CLOSE,1,CLOSE-1,CLOSE-1);
        cx.fillStyle=themeColor('--scr-hi'); cx.textAlign='center'; cx.fillText('×', x0+w-CLOSE/2, CLOSE-4); cx.textAlign='left'; }
      cx.fillStyle='rgba(255,255,255,.25)'; cx.fillRect(x0+w-HANDLE,0,HANDLE-1,H); }
    if(secs.length && n.secIdx<secs.length){                               // плейхед — прогресс по всей аранжировке
      const x=(offs[n.secIdx]+n.barInSec)*px;
      cx.fillStyle='rgba(255,255,255,.85)'; cx.fillRect(x-1,0,2,H); }
    const cur=secs[Math.min(n.secIdx,secs.length-1)];
    n.el.querySelector('.readout').textContent=
      'section '+(n.secIdx+1)+'/'+secs.length+' · bank '+'ABCD'[cur.bank]+
      ' · bar '+(n.barInSec+1)+'/'+cur.bars+(n._queued!=null?' · queued: #'+(n._queued+1):''); }});

// общий шаг для секвенсоров: свой bpm, либо внешний clk-вход (single-sample импульсы 0/1).
// возвращает true в сэмпле начала нового шага; n.stepLen/n._pos — для расчёта длины ноты.
function seqTick(n,I,i,ownStepLen){
  const clk=I.clk;
  if(clk){
    if(!n.stepLen) n.stepLen=ownStepLen;                // до первого импульса — своя оценка
    const now=clk[i]>0.5;
    if(now){ if(n._clkAge) n.stepLen=n._clkAge; n._clkAge=0; }
    else n._clkAge=(n._clkAge||0)+1;
    n._pos=n._clkAge;
    return now;
  }
  n.stepLen=ownStepLen;
  const now=n.samplesLeft<=0;
  if(now) n.samplesLeft=n.stepLen;
  n._pos=n.stepLen-n.samplesLeft;
  n.samplesLeft--;
  return now;
}

const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const GEN_SCALES={
  'major':[0,2,4,5,7,9,11],
  'natural minor':[0,2,3,5,7,8,10],
  'harmonic minor':[0,2,3,5,7,8,11],
  'minor pentatonic':[0,3,5,7,10],
  'major pentatonic':[0,2,4,7,9],
  'lydian':[0,2,4,6,7,9,11],
  'dorian':[0,2,3,5,7,9,10]};

function genDegrees(root,scaleName,octaves){              // ступени лада в MIDI-нотах на N октав вверх от root
  const s=GEN_SCALES[scaleName]||GEN_SCALES['minor pentatonic'];
  const out=[];
  for(let o=0;o<octaves;o++) for(const semi of s) out.push(root+semi+12*o);
  return out;
}
// ближайшая нота лада (key — тоника 0..11) к произвольному MIDI-номеру; при равном расстоянии — вниз
function quantizeToScale(note,key,scaleName){
  const s=GEN_SCALES[scaleName]||GEN_SCALES['major'];
  const rel=((note-key)%12+12)%12, oct=Math.floor((note-key)/12);
  let best=s[0], bestD=99;
  for(const deg of s){ const d=Math.abs(deg-rel); if(d<bestD){ bestD=d; best=deg; } }
  return key+oct*12+best;
}

def({ id:'seq', title:'Sequencer', cat:'Music',
  ins:[{n:'clk',t:'sig'}],
  outs:[{n:'freq',t:'num'},{n:'gate',t:'sig'},{n:'step',t:'num'}],
  readout:true,
  params:[{n:'pattern',t:'code',d:'60,62,64,65,67,65,64,62',label:'notes (x = rest)'},
          {n:'bpm',t:'range',min:20,max:300,step:1,d:120},
          {n:'div',t:'select',opts:['1/4','1/8','1/16'],d:'1/8'},
          {n:'gatelen',t:'range',min:.05,max:1,step:.01,d:.6,label:'note length'},
          {n:'run',t:'check',d:true,label:'play'}],
  init:n=>{ n.idx=-1; n.samplesLeft=0; n.stepLen=0; n.freqOut=440; n.curNote=null; },
  process(n,I){
    n._synced=!!I.clk;
    const gate=buf(n,'gate'), p=n.p;
    const notes=p.pattern.split(',').map(s=>s.trim()).filter(s=>s.length);
    const div={'1/4':1,'1/8':2,'1/16':4}[p.div]||2;
    const ownStepLen=Math.round(Eng.sr*60/p.bpm/div);
    for(let i=0;i<BLOCK;i++){
      if(!p.run){ gate[i]=0; continue; }
      if(seqTick(n,I,i,ownStepLen)){
        n.idx=(n.idx+1)%(notes.length||1);
        const tok=notes[n.idx];
        n.curNote=(tok!=='x'&&tok!==''&&!isNaN(+tok))?+tok:null;
        if(n.curNote!=null) n.freqOut=440*Math.pow(2,(n.curNote-69)/12); }
      gate[i]=(n.curNote!=null && n._pos<n.stepLen*p.gatelen)?1:0; }
    return {freq:n.freqOut, gate, step:n.idx}; },
  draw(n){ n.el.querySelector('.readout').textContent=
    'step '+n.idx+' · '+(n._synced?'ext. clock':n.p.bpm+' BPM'); }});

// формат ноты: {note,start,len,vel,voice}; храним в grid-строке как "note:start:len:vel:voice;...".
// старые форматы (без voice, и совсем старый однонотный "note,note,...") распознаём и мигрируем.
function pianoDecode(s){
  const notes=[];
  if(!s) return notes;
  if(s.indexOf(':')<0 && s.indexOf(',')>=0){
    const a=s.split(',').map(Number);
    for(let i=0;i<a.length;i++) if(isFinite(a[i]) && a[i]>=0) notes.push({note:a[i],start:i,len:1,vel:100,voice:undefined});
    pianoAssignVoices(notes); return notes;
  }
  let needVoices=false;
  for(const part of s.split(';')){
    if(!part) continue;
    const [note,start,len,vel,voice]=part.split(':').map(Number);
    if(isFinite(note) && isFinite(start) && isFinite(len)){
      if(!isFinite(voice)) needVoices=true;
      notes.push({note,start,len:Math.max(1,len),vel:isFinite(vel)?vel:100,voice:isFinite(voice)?clamp(voice,0,3):undefined}); }
  }
  if(needVoices) pianoAssignVoices(notes);              // патч сохранён до появления голосов — доназначаем дорожки
  return notes;
}
function pianoEncode(notes){ return notes.map(nt=>nt.note+':'+nt.start+':'+nt.len+':'+Math.round(nt.vel)+':'+(nt.voice|0)).join(';'); }
// жадная раскраска нот по 4 дорожкам: не трогает уже назначенные (voice!=null), заполняет только пустые —
// так голос ноты стабилен и виден на гриде цветом, а не гадается по тому, что играло рядом в рантайме.
function pianoAssignVoices(notes){
  const laneEnd=[0,0,0,0];
  for(const nt of notes) if(nt.voice!=null) laneEnd[nt.voice]=Math.max(laneEnd[nt.voice],nt.start+nt.len);
  for(const nt of notes.slice().sort((a,b)=>a.start-b.start)){
    if(nt.voice!=null) continue;
    let lane=laneEnd.findIndex(e=>e<=nt.start);
    if(lane<0) lane=laneEnd.indexOf(Math.min(...laneEnd));   // все заняты — перекроет наименее «свежую» дорожку
    nt.voice=lane; laneEnd[lane]=nt.start+nt.len;
  }
}
function pianoFreeVoice(notes,start,len){                   // первая дорожка, свободная на интервале [start,start+len)
  const busy=[false,false,false,false];
  for(const nt of notes) if(nt.start<start+len && start<nt.start+nt.len) busy[nt.voice|0]=true;
  const free=busy.indexOf(false);
  return free<0?0:free;
}
const VOICE_COL_VARS=['--t-img','--t-blk','--acc','--t-txt'];  // цвет = дорожка = выход freq/freq2/freq3/freq4
const VOICE_COL=k=>themeColor(VOICE_COL_VARS[k]);
// 4 банка паттернов через '|' — как у drumseq. Старый однобанковый grid (без '|') читается как банк A.
function pianoDecodeAll(s){
  const parts=(s||'').split('|');
  const banks=[];
  for(let i=0;i<4;i++) banks.push(pianoDecode(parts[i]||''));
  return banks;
}
function pianoEncodeAll(banks){ return banks.map(pianoEncode).join('|'); }
function pianoBankIdx(p){ return {A:0,B:1,C:2,D:3}[p.bank]||0; }
let PIANO_CLIPBOARD=null;                                       // буфер копипаста банка (не сохраняется в патч)


def({ id:'pianoroll', lazy:'manual', title:'Piano Roll', cat:'Music',
  ins:[{n:'clk',t:'sig'},{n:'bankSel',t:'num'}],
  outs:[{n:'freq',t:'num'},{n:'gate',t:'sig'},{n:'step',t:'num'},
        {n:'freq2',t:'num'},{n:'gate2',t:'sig'},
        {n:'freq3',t:'num'},{n:'gate3',t:'sig'},
        {n:'freq4',t:'num'},{n:'gate4',t:'sig'},
        {n:'vel',t:'num'}],
  view:{h:180}, resize:true, readout:true,
  params:[{n:'bank',t:'select',opts:['A','B','C','D'],d:'A',label:'bank'},
          {n:'steps',t:'range',min:4,max:32,step:1,d:16,label:'steps'},
          {n:'bpm',t:'range',min:20,max:300,step:1,d:120},
          {n:'div',t:'select',opts:['1/4','1/8','1/16'],d:'1/16'},
          {n:'gatelen',t:'range',min:.05,max:1,step:.01,d:.85,label:'note length'},
          {n:'key',t:'select',opts:NOTE_NAMES,d:'C',label:'key'},
          {n:'scale',t:'select',opts:Object.keys(GEN_SCALES),d:'major',label:'scale'},
          {n:'quantize',t:'check',d:false,label:'quantize to scale'},
          {n:'run',t:'check',d:true,label:'play'},
          {n:'copy',t:'button',label:'Copy',fn:n=>{ PIANO_CLIPBOARD=n.banks[n.bankIdx].map(nt=>({...nt})); }},
          {n:'paste',t:'button',label:'Paste',fn:n=>{
            if(PIANO_CLIPBOARD){ n.banks[n.bankIdx]=PIANO_CLIPBOARD.map(nt=>({...nt}));
              n.p.grid=pianoEncodeAll(n.banks); } }},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.banks[n.bankIdx].length=0; n.p.grid=pianoEncodeAll(n.banks); }}],
  init:n=>{ n.banks=pianoDecodeAll(n.p.grid); n.p.grid=pianoEncodeAll(n.banks);
    n.bankIdx=pianoBankIdx(n.p); n._prevBankIdx=n.bankIdx;
    n.pitchLo=60; n.rows=16; n.idx=-1; n.samplesLeft=0; n.stepLen=0;
    // 4 фиксированные дорожки (voice ноты → индекс) — независимые, без кражи чужих голосов
    n.voiceNote=[null,null,null,null]; n.voiceAge=[0,0,0,0];
    n.freqOut=[440,440,440,440]; n.velOut=0; n.drag=null; },
  process(n,I){
    n._synced=!!I.clk;
    n._bankSelLive=typeof I.bankSel==='number';
    n.bankIdx = n._bankSelLive ? clamp(Math.round(I.bankSel),0,3) : pianoBankIdx(n.p);
    if(n.bankIdx!==n._prevBankIdx){                                 // сменился банк — обрываем старые голоса
      n.voiceNote=[null,null,null,null]; n._prevBankIdx=n.bankIdx; }
    const notes=n.banks[n.bankIdx];
    const p=n.p, steps=p.steps|0;
    const div={'1/4':1,'1/8':2,'1/16':4}[p.div]||4;
    const ownStepLen=Math.round(Eng.sr*60/p.bpm/div);
    const gb=[buf(n,'gate'),buf(n,'gate2'),buf(n,'gate3'),buf(n,'gate4')];
    for(let i=0;i<BLOCK;i++){
      if(!p.run){ for(const g of gb) g[i]=0; continue; }
      if(seqTick(n,I,i,ownStepLen)){
        n.idx=(n.idx+1)%steps;
        for(let k=0;k<4;k++){
          const vn=n.voiceNote[k];
          if(vn && (n.idx>=vn.start+vn.len || vn.start+vn.len>steps)) n.voiceNote[k]=null; }  // нота кончилась/паттерн укоротили
        for(const nt of notes){                                     // старт ноты — прямиком в её собственную дорожку
          if(nt.start!==n.idx || nt.start>=steps) continue;
          const k=nt.voice|0; n.voiceNote[k]=nt; n.voiceAge[k]=0; }
        for(let k=0;k<4;k++) if(n.voiceNote[k]) n.freqOut[k]=440*Math.pow(2,(n.voiceNote[k].note-69)/12);
        n.velOut = n.voiceNote[0]? n.voiceNote[0].vel/127 : 0; }
      for(let k=0;k<4;k++){
        const vn=n.voiceNote[k];
        gb[k][i]=(vn && n.voiceAge[k]<vn.len*n.stepLen*p.gatelen)?1:0;
        if(vn) n.voiceAge[k]++; } }
    redrawIf(n,n.idx+'|'+n.bankIdx+'|'+n._synced+'|'+n._bankSelLive+'|'+n.voiceNote.map(v=>v?v.note:'').join());
    return {freq:n.freqOut[0], gate:gb[0], step:n.idx,
            freq2:n.freqOut[1], gate2:gb[1], freq3:n.freqOut[2], gate3:gb[2],
            freq4:n.freqOut[3], gate4:gb[3], vel:n.velOut}; },
  draw(n){
    const cv=n.cv, cx=n.cx; if(!cv) return;
    const TABH=14;                                                  // полоса вкладок банков сверху
    const notes=n.banks[n.bankIdx];
    const noteAt=(col,row)=>{ const note=n.pitchLo+(n.rows-1-row);
      return notes.find(nt=>nt.note===note && col>=nt.start && col<nt.start+nt.len); };
    if(!n._wired){
      n._wired=true;
      // Курсор переводим в логические координаты канвы (те же W/H, что и у draw()) сразу при
      // чтении события. offsetX/Y тут не годятся — в части браузеров они не учитывают CSS-scale
      // графа (Panzoom) так же, как getBoundingClientRect(), и на зуме != 1 расходятся с ним.
      // clientX/Y относительно rect.left/top — надёжнее: оба гарантированно в одной, экранной,
      // системе координат, а дальше просто пересчитываем пропорцию в логические пиксели канвы.
      const toLocal=ev=>{ const r=cv.getBoundingClientRect();
        return [(ev.clientX-r.left)/r.width*cv.width, (ev.clientY-r.top)/r.height*cv.height]; };
      const cellCursor=(px,py)=>{
        if(py<TABH) return 'pointer';
        const steps=n.p.steps|0, cw=cv.width/steps, rh=(cv.height-TABH)/n.rows;
        const col=clamp(Math.floor(px/cw),0,steps-1), row=clamp(Math.floor((py-TABH)/rh),0,n.rows-1);
        const hit=noteAt(col,row);
        if(!hit) return 'crosshair';                                // пусто — тут можно поставить ноту
        const py0=TABH+row*rh, rightPx=(hit.start+hit.len)*cw;
        if(px > rightPx-Math.min(8,cw*0.35)) return 'ew-resize';
        if((py-py0) > rh-Math.min(4,rh*0.35)) return 'pointer';
        return 'grab'; };
      cv.addEventListener('pointerdown',ev=>{
        ev.stopPropagation();
        const [px,py]=toLocal(ev);
        if(py<TABH){                                                // клик по вкладке — переключить банк
          const tw=cv.width/4, bi=clamp(Math.floor(px/tw),0,3);
          n.p.bank='ABCD'[bi]; return; }
        const steps=n.p.steps|0, cw=cv.width/steps, rh=(cv.height-TABH)/n.rows;
        const col=clamp(Math.floor(px/cw),0,steps-1);
        const row=clamp(Math.floor((py-TABH)/rh),0,n.rows-1);
        const hit=noteAt(col,row);
        cv.setPointerCapture(ev.pointerId);
        if(hit){
          const py0=TABH+row*rh, rightPx=(hit.start+hit.len)*cw;
          const nearEdge=px > rightPx-Math.min(8,cw*0.35);
          const nearBottom=(py-py0) > rh-Math.min(4,rh*0.35);
          if(nearBottom && !nearEdge){                              // нижняя полоска ноты — цикл дорожки/голоса
            hit.voice=(hit.voice+1)%4; n.p.grid=pianoEncodeAll(n.banks); return; }
          n.drag = nearEdge
            ? {mode:'resize', note:hit}
            : {mode:'move', note:hit, origStart:hit.start, origVel:hit.vel,
               startPx:px, startPy:py, moved:false};
          cv.style.cursor = nearEdge ? 'ew-resize' : 'grabbing';
        } else {
          let pitch=n.pitchLo+(n.rows-1-row);
          if(n.p.quantize) pitch=quantizeToScale(pitch,NOTE_NAMES.indexOf(n.p.key),n.p.scale);
          const note={note:pitch, start:col, len:1, vel:100, voice:pianoFreeVoice(notes,col,1)};
          notes.push(note);
          n.drag={mode:'resize', note, isNew:true};
          cv.style.cursor='ew-resize';
        } });
      cv.addEventListener('pointermove',ev=>{
        const [px,py]=toLocal(ev);
        if(!n.drag){ cv.style.cursor=cellCursor(px,py); return; }
        ev.stopPropagation();
        const steps=n.p.steps|0, cw=cv.width/steps;
        const d=n.drag, nt=d.note;
        if(d.mode==='resize'){
          const col=clamp(Math.floor(px/cw),0,steps-1);
          nt.len=clamp(col-nt.start+1,1,steps-nt.start);
        } else {
          const dx=px-d.startPx, dy=py-d.startPy;                    // дельта уже в логических пикселях — от зума не зависит
          if(Math.abs(dx)>=cw*0.5){                                          // горизонталь — сдвиг ноты
            const newStart=clamp(d.origStart+Math.round(dx/cw),0,steps-nt.len);
            if(newStart!==nt.start){ nt.start=newStart; d.moved=true; } }
          if(Math.abs(dy)>4){                                                // вертикаль — велосити
            nt.vel=clamp(Math.round(d.origVel-dy*0.6),1,127); d.moved=true; }
        } });
      const endDrag=()=>{
        if(!n.drag) return;
        if(n.drag.mode==='move' && !n.drag.moved){                          // клик без движения — удалить ноту
          const idx=notes.indexOf(n.drag.note); if(idx>=0) notes.splice(idx,1); }
        n.drag=null; cv.style.cursor='default'; n.p.grid=pianoEncodeAll(n.banks); };
      cv.addEventListener('pointerup',endDrag);
      cv.addEventListener('pointercancel',endDrag);
      cv.addEventListener('wheel',ev=>{
        ev.preventDefault(); ev.stopPropagation();
        n.pitchLo=clamp(n.pitchLo+(ev.deltaY>0?-1:1),0,127-n.rows); },{passive:false}); }
    const W=cv.width, H=cv.height, steps=n.p.steps|0, cw=W/steps, gh=H-TABH, rh=gh/n.rows;
    cx.clearRect(0,0,W,H);
    const bi=n.bankIdx, bw=W/4, auto=!!n._bankSelLive;                       // вкладки банков
    for(let b=0;b<4;b++){
      cx.fillStyle = b===bi ? 'rgba(138,180,248,.35)' : 'rgba(255,255,255,.05)';
      cx.fillRect(b*bw,0,bw-1,TABH-1);
      cx.font='9px monospace'; cx.fillStyle = b===bi ? themeColor('--t-img') : themeColor('--axis');
      cx.fillText('ABCD'[b],b*bw+bw/2-3,TABH-4); }
    if(auto){ cx.fillStyle='rgba(224,178,60,.8)'; cx.fillRect(0,TABH-2,W,2); }  // банк задаётся song-узлом
    cx.save(); cx.translate(0,TABH);
    const key=NOTE_NAMES.indexOf(n.p.key), scaleSet=new Set(GEN_SCALES[n.p.scale]||GEN_SCALES['major']);
    cx.fillStyle='rgba(255,255,255,.04)';
    for(let row=0;row<n.rows;row++){
      const note=n.pitchLo+(n.rows-1-row), rel=((note-key)%12+12)%12;
      if(!scaleSet.has(rel)) cx.fillRect(0,row*rh,W,rh); }
    cx.strokeStyle='rgba(255,255,255,.08)'; cx.lineWidth=1;
    for(let c=0;c<=steps;c++){ cx.beginPath(); cx.moveTo(c*cw+.5,0); cx.lineTo(c*cw+.5,gh); cx.stroke(); }
    for(let r=0;r<=n.rows;r++){ cx.beginPath(); cx.moveTo(0,r*rh+.5); cx.lineTo(W,r*rh+.5); cx.stroke(); }
    const sounding=new Set(n.voiceNote.filter(Boolean));
    for(const nt of notes){
      if(nt.start>=steps) continue;
      const len=Math.min(nt.len,steps-nt.start);
      const row=n.rows-1-(nt.note-n.pitchLo); if(row<0||row>=n.rows) continue;
      const col=VOICE_COL(nt.voice|0);
      cx.fillStyle = sounding.has(nt) ? themeColor('--scr-hi') : col;
      cx.globalAlpha = sounding.has(nt) ? 1 : (0.35+0.55*(nt.vel/127));
      cx.fillRect(nt.start*cw+1,row*rh+1,len*cw-2,rh-2);
      cx.globalAlpha=1;
      cx.fillStyle='rgba(0,0,0,.25)';                                        // ручка растягивания справа
      cx.fillRect((nt.start+len)*cw-4,row*rh+1,3,rh-2);
      cx.fillStyle='rgba(0,0,0,.35)';                                        // полоска-переключатель дорожки снизу
      cx.fillRect(nt.start*cw+1,row*rh+rh-3,len*cw-2,2); }
    if(n.idx>=0){ cx.fillStyle='rgba(224,178,60,.2)'; cx.fillRect(n.idx*cw,0,cw,gh); }
    cx.restore();
    n.el.querySelector('.readout').textContent =
      'bank '+'ABCD'[n.bankIdx]+(n._bankSelLive?' (auto)':'')+' · step '+Math.max(n.idx,0)+'/'+steps+' · '+
      (n._synced?'ext. clock':n.p.bpm+' BPM')+' · notes: '+notes.length+
      (n.p.quantize?' · '+n.p.key+' '+n.p.scale:''); }});


def({ id:'genseq', title:'Generative Melody', cat:'Music',
  ins:[{n:'clk',t:'sig'}],
  outs:[{n:'freq',t:'num'},{n:'gate',t:'sig'},{n:'step',t:'num'}],
  readout:true,
  params:[
    {n:'scale',t:'select',opts:Object.keys(GEN_SCALES),d:'minor pentatonic',label:'scale'},
    {n:'root',t:'range',min:24,max:72,step:1,d:45,label:'root (note)'},
    {n:'octaves',t:'range',min:1,max:3,step:1,d:2,label:'octaves'},
    {n:'bpm',t:'range',min:20,max:300,step:1,d:120},
    {n:'div',t:'select',opts:['1/4','1/8','1/16'],d:'1/8'},
    {n:'gatelen',t:'range',min:.05,max:1,step:.01,d:.6,label:'note length'},
    {n:'restProb',t:'range',min:0,max:.9,step:.01,d:.2,label:'rest probability'},
    {n:'leapProb',t:'range',min:0,max:1,step:.01,d:.2,label:'leap probability (±2)'},
    {n:'run',t:'check',d:true,label:'play'},
    {n:'reseed',t:'button',label:'Reseed',fn:n=>{
      n.melIdx=Math.floor(genDegrees(n.p.root,n.p.scale,n.p.octaves).length/2); }}],
  init:n=>{
    n.idx=-1; n.samplesLeft=0; n.stepLen=0; n.freqOut=440; n.curNote=null;
    n.melIdx=Math.floor(genDegrees(n.p.root,n.p.scale,n.p.octaves).length/2); },
  process(n,I){
    n._synced=!!I.clk;
    const gate=buf(n,'gate'), p=n.p;
    const div={'1/4':1,'1/8':2,'1/16':4}[p.div]||2;
    const ownStepLen=Math.round(Eng.sr*60/p.bpm/div);
    for(let i=0;i<BLOCK;i++){
      if(!p.run){ gate[i]=0; continue; }
      if(seqTick(n,I,i,ownStepLen)){
        n.idx++;
        const degrees=genDegrees(p.root,p.scale,p.octaves);
        const step=(Math.random()<p.leapProb?2:1)*(Math.random()<0.5?-1:1);   // random walk ±1/±2
        n.melIdx=clamp(n.melIdx+step,0,degrees.length-1);
        n.curNote=Math.random()<p.restProb?null:degrees[n.melIdx];           // изредка пауза
        if(n.curNote!=null) n.freqOut=440*Math.pow(2,(n.curNote-69)/12); }
      gate[i]=(n.curNote!=null && n._pos<n.stepLen*p.gatelen)?1:0; }
    return {freq:n.freqOut, gate, step:n.idx}; },
  draw(n){ n.el.querySelector('.readout').textContent=
    'step '+n.idx+' · note '+(n.curNote??'—')+(n._synced?' · ext. clock':''); }});


// ---- Тюнер: одна большая крутилка + табло по разрядам (как у классических приёмников).
// Шаг вращения и колеса — это шаг выбранного разряда (тот же, что и у стрелок ↑/↓ и цифр);
// отдельного контрола "шаг" больше нет — разряд один на всё.
// Цифровая клавиша заменяет выбранный разряд и переходит на разряд ниже (как ввод суммы на кассе).
// Перенос между разрядами не эмулируется вручную — n.p.freq обычное число, обычное сложение
// само переносит в старший разряд (99→100), поэтому отдельной carry-логики не нужно.
const TUNER_DIGITS=11;                                  // до ~100 ГГц — эфирные частоты за конвертером (LNB)

// Общая крутилка+табло ввода частоты (изначально была только внутри узла 'tuner') — теперь общий
// виджет, используемый и в 'rtlsdr' для его центральной частоты (см. draw() у 'rtlsdr' выше), вместо
// обычного текстового поля: то же вращение/тап по разряду/клавиатура/колесо, включая мобильную
// поддержку (скрытый text-input под тап по цифре — иначе на мобиле нечем вызвать цифровую
// клавиатуру у canvas). state — объект, который хранит caller (НЕ n.sel/n.ang напрямую) — так одной
// функцией можно завести несколько независимых крутилок на разных узлах без коллизий состояния.
// get/set — доступ к самому значению частоты, el — элемент для фокуса/клавиатуры (обычно n.el).
// opts.dial===false — без крутилки, только табло: разряд меняется ведением пальца/мыши вверх-вниз
// прямо по его цифре, тап без сдвига — выбор разряда и цифровая клавиатура.
function drawFreqDial(el,cv,cx,state,get,set,opts={}){
  const dial=opts.dial!==false;
  if(state.sel==null){ state.sel=TUNER_DIGITS-2; state.ang=0; }
  const W=cv.width, H=cv.height, TOP=46, maxV=Math.pow(10,TUNER_DIGITS)-1;
  const stepHz=()=>Math.pow(10,TUNER_DIGITS-1-state.sel);   // шаг = вес выбранного разряда
  const bumpDigit=d=>{ set(clamp(Math.round(get()+stepHz()*d),0,maxV)); };
  const DRAG_SENS=0.6;                                  // чуть медленнее, чем 1px = 1 шаг
  if(!state.wired){
    state.wired=true;
    el.tabIndex=0;                                      // фокус нужен, чтобы ловить стрелки/цифры клавиатуры
    cv.style.touchAction='none';                         // без этого мобилка скроллит страницу вместо вращения крутилки
    // скрытый инпут — только чтобы на тап по цифре мобилка показала цифровую клавиатуру
    const numInput=document.createElement('input');
    numInput.type='tel'; numInput.inputMode='numeric'; numInput.autocomplete='off';
    // в body и fixed поверх табло: внутри узла при фокусе браузер прокручивал тайл дашборда
    // (и холст графа) к инпуту в конце узла; 16px — иначе iOS зумит страницу при фокусе
    numInput.style.cssText='position:fixed;opacity:0;width:1px;height:1px;padding:0;border:0;pointer-events:none;font-size:16px;';
    const focusNum=()=>{
      if(!numInput.isConnected) document.body.appendChild(numInput);
      const r=cv.getBoundingClientRect();
      numInput.style.left=Math.max(0,r.left)+'px'; numInput.style.top=Math.max(0,r.top)+'px';
      numInput.focus({preventScroll:true});
    };
    numInput.addEventListener('blur',()=>numInput.remove());
    numInput.addEventListener('input',()=>{
      const ch=numInput.value.replace(/\D/g,'').slice(-1);
      numInput.value='';
      if(!ch) return;
      const digits=String(Math.round(get())).padStart(TUNER_DIGITS,'0').split('');
      digits[state.sel]=ch;
      set(clamp(+digits.join(''),0,maxV));
      state.sel=clamp(state.sel+1,0,TUNER_DIGITS-1); });
    el.addEventListener('keydown',ev=>{
      if(ev.target!==el) return;                        // клавиши из полей внутри узла — не табло
      if(/^[0-9]$/.test(ev.key)){                        // ввод цифры прямо в выбранный разряд
        ev.preventDefault(); ev.stopPropagation();
        const digits=String(Math.round(get())).padStart(TUNER_DIGITS,'0').split('');
        digits[state.sel]=ev.key;
        set(clamp(+digits.join(''),0,maxV));
        state.sel=clamp(state.sel+1,0,TUNER_DIGITS-1);    // и сразу на разряд ниже, как на калькуляторе
        return;
      }
      if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(ev.key)) return;
      ev.preventDefault(); ev.stopPropagation();
      if(ev.key==='ArrowLeft') state.sel=clamp(state.sel-1,0,TUNER_DIGITS-1);
      else if(ev.key==='ArrowRight') state.sel=clamp(state.sel+1,0,TUNER_DIGITS-1);
      else if(ev.key==='ArrowUp') bumpDigit(1);
      else if(ev.key==='ArrowDown') bumpDigit(-1); });
    cv.addEventListener('pointerdown',ev=>{
      ev.stopPropagation(); ev.preventDefault();          // preventDefault и тут — иначе браузер после тапа сам фокусирует canvas и закрывает клавиатуру
      const r=cv.getBoundingClientRect(), y=(ev.clientY-r.top)/r.height*H;
      if(!dial){                                        // табло без крутилки: разряд под пальцем, дальше решит move/up
        const x=(ev.clientX-r.left)/r.width*W;
        state.sel=clamp(Math.floor(x/(W/TUNER_DIGITS)),0,TUNER_DIGITS-1);
        state.dragY0=ev.clientY; state.dragFreq0=get(); state.moved=false;
        state.dragPtr=ev.pointerId; state.dragTouch=ev.pointerType==='touch';
        cv.setPointerCapture(ev.pointerId);
      } else if(y<TOP){                                        // клик по табло — выбрать разряд под стрелки
        const x=(ev.clientX-r.left)/r.width*W, cw=W/TUNER_DIGITS;
        state.sel=clamp(Math.floor(x/cw),0,TUNER_DIGITS-1);
        if(ev.pointerType==='touch') focusNum(); else el.focus({preventScroll:true});
      } else {                                          // клик по крутилке — начать вращение
        state.dragY0=ev.clientY; state.dragFreq0=get();   // запоминаем старт драга, а не только предыдущую точку
        state.dragLastY=ev.clientY; state.dragPtr=ev.pointerId; state.dragTouch=ev.pointerType==='touch';
        cv.setPointerCapture(ev.pointerId);
      } });
    cv.addEventListener('pointermove',ev=>{
      if(state.dragY0==null || ev.pointerId!==state.dragPtr) return;
      ev.preventDefault();
      if(!dial){                                        // ~1 шаг разряда на 14px (тач) / 8px (мышь), вверх = больше
        const dy=state.dragY0-ev.clientY;
        if(!state.moved && Math.abs(dy)<6) return;      // мелкая дрожь пальца — ещё тап
        state.moved=true;
        const steps=Math.trunc(dy/(state.dragTouch?14:8));
        set(clamp(state.dragFreq0+steps*stepHz(),0,maxV)); return; }
      // частота считается от точки СТАРТА драга (не от предыдущего события) — так не плывёт от
      // того, сколько именно move-событий прислал браузер. Тач заметно менее чувствительный, чем
      // мышь: палец физически проезжает по экрану куда больше при том же "ощущаемом" усилии.
      const sens=state.dragTouch?DRAG_SENS/8:DRAG_SENS;
      const stepDy=state.dragLastY-ev.clientY; state.dragLastY=ev.clientY;   // только для вращения стрелки
      state.ang=(state.ang+stepDy*4*sens)%360;
      // округляем именно КОЛИЧЕСТВО ШАГОВ, а не итоговую частоту — иначе Math.round бьёт
      // до целого герца, а не до кратного весу разряда, и в младших разрядах остаётся мусор
      const steps=Math.round((state.dragY0-ev.clientY)*sens);
      set(clamp(state.dragFreq0+steps*stepHz(),0,maxV)); },{passive:false});
    const endDrag=ev=>{
      if(!dial && state.dragY0!=null && !state.moved && ev.type==='pointerup'){   // тап — ввод цифр с клавиатуры
        if(state.dragTouch) focusNum(); else el.focus({preventScroll:true}); }
      state.dragY0=null; state.dragPtr=null; };
    cv.addEventListener('pointerup',endDrag); cv.addEventListener('pointercancel',endDrag);
    cv.addEventListener('wheel',ev=>{ ev.preventDefault(); ev.stopPropagation();
      if(!dial){ const r=cv.getBoundingClientRect();     // колесо крутит разряд под курсором
        state.sel=clamp(Math.floor((ev.clientX-r.left)/r.width*TUNER_DIGITS),0,TUNER_DIGITS-1); }
      set(clamp(Math.round(get()+(ev.deltaY<0?stepHz():-stepHz())),0,maxV)); },{passive:false});
  }
  // табло меняется редко — без изменений не перерисовываем
  const digStr=String(Math.round(get())).padStart(TUNER_DIGITS,'0'), cw=W/TUNER_DIGITS;
  const key=W+'|'+H+'|'+cv.pxGen+'|'+digStr+'|'+state.sel+'|'+(dial?state.ang:'')+'|'+themeColor('--acc')+'|'+themeColor('--grid');
  if(key===state.key) return; state.key=key;
  cx.clearRect(0,0,W,H);
  // табло
  cx.font='bold '+Math.round(Math.min(34,cw*.78))+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
  for(let i=0;i<TUNER_DIGITS;i++){
    if(i===state.sel){ cx.fillStyle=themeColor('--acc')+'33'; cx.fillRect(i*cw+1,2,cw-2,TOP-4); }
    // #cfd6db — не по теме нарочно: табло всегда на тёмном --screen (см. --grid/--axis в
    // styles.css), а --txt для контраста с чёрным экраном в светлой теме уходит в почти чёрный
    cx.fillStyle= i===state.sel? themeColor('--acc') : '#cfd6db';
    cx.fillText(digStr[i], i*cw+cw/2, TOP/2);
    if((TUNER_DIGITS-1-i)%3===0 && i<TUNER_DIGITS-1){    // разделитель разрядов по 3 (тысячи/миллионы/…)
      cx.strokeStyle=themeColor('--grid'); cx.beginPath();
      cx.moveTo(i*cw+cw+.5,4); cx.lineTo(i*cw+cw+.5,TOP-4); cx.stroke(); }
  }
  if(!dial) return;                                     // без крутилки — только табло, без подписи
  cx.textAlign='left'; cx.font='10px monospace'; cx.fillStyle=themeColor('--axis');
  cx.fillText(fmtHz(get())+'Hz · digit ×'+fmtHz(Math.pow(10,TUNER_DIGITS-1-state.sel)), 4, H-4);
  // крутилка
  const cx0=W/2, cy0=TOP+(H-TOP)/2, r=Math.min(W,H-TOP)/2-8;
  cx.strokeStyle=themeColor('--grid'); cx.fillStyle=themeColor('--scr-panel'); cx.lineWidth=2;
  cx.beginPath(); cx.arc(cx0,cy0,r,0,2*Math.PI); cx.fill(); cx.stroke();
  cx.save(); cx.translate(cx0,cy0); cx.rotate(state.ang*Math.PI/180);
  cx.strokeStyle=themeColor('--acc'); cx.lineWidth=3; cx.beginPath();
  cx.moveTo(0,-r+6); cx.lineTo(0,-r*0.4); cx.stroke();
  cx.restore();
  cx.fillStyle=themeColor('--axis'); cx.font='9px monospace'; cx.textAlign='center';
  cx.fillText('step ×'+fmtHz(stepHz()), cx0, cy0+r+12);
}

def({ id:'tuner', lazy:'manual', title:'Tuner', cat:'Radio', outs:[{n:'freq',t:'num'}],
  view:{h:200}, resize:true,
  init:n=>{ n.p.freq=n.p.freq??100000000; n._dial={}; },
  process(n){ return {freq:n.p.freq}; },
  draw(n,cv,cx){
    if(!cv) return;
    drawFreqDial(n.el,cv,cx,n._dial, ()=>n.p.freq, v=>{ n.p.freq=v; });
  }});


/* ---------- Хранилище семплов (IndexedDB) ---------- */
// Две таблицы: folders (id, name, parentId) и clips (id, name, folderId, sr, samples, peaks, duration).
// Корень снаружи — null, в базе — 0: null не попадает в индекс IndexedDB, и корень был бы пуст.

const SampleDB = (() => {
  let dbp = null;
  const ROOT = 0;                                 // автоинкрементные id начинаются с 1
  const key = v => v==null ? ROOT : v;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const rq = indexedDB.open('dsp-samples', 2);
      rq.onupgradeneeded = e => {
        const db = e.target.result;
        if(e.oldVersion===1){                     // v1 хранила корень как null — переводим в 0
          const tx = e.target.transaction;
          for(const [st, k] of [['folders','parentId'],['clips','folderId']]){
            tx.objectStore(st).openCursor().onsuccess = ev=>{
              const c = ev.target.result; if(!c) return;
              if(c.value[k]==null){ c.value[k] = ROOT; c.update(c.value); }
              c.continue();
            };
          }
        }
        if(!db.objectStoreNames.contains('folders')){
          const fs = db.createObjectStore('folders',{keyPath:'id',autoIncrement:true});
          fs.createIndex('parentId','parentId');
        }
        if(!db.objectStoreNames.contains('clips')){
          const cs = db.createObjectStore('clips',{keyPath:'id',autoIncrement:true});
          cs.createIndex('folderId','folderId');
        }
      };
      rq.onsuccess = e => res(e.target.result);
      rq.onerror = e => rej(e.target.error);
    });
    return dbp;
  }

  async function store(name, mode){
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }
  function reqP(rq){
    return new Promise((res,rej)=>{ rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); });
  }

  function computePeaks(samples, buckets=400){
    const peaks = new Float32Array(buckets*2);
    const step = samples.length/buckets;
    for(let i=0;i<buckets;i++){
      const start=Math.floor(i*step), end=Math.floor((i+1)*step);
      let lo=0, hi=0;
      for(let j=start;j<end;j++){ const v=samples[j]; if(v<lo) lo=v; if(v>hi) hi=v; }
      peaks[i*2]=lo; peaks[i*2+1]=hi;
    }
    return peaks;
  }

  return {
    computePeaks,

    async addFolder(name, parentId=null){
      const s = await store('folders','readwrite');
      return reqP(s.add({name, parentId:key(parentId), created:Date.now()}));
    },
    async renameFolder(id, name){
      const s = await store('folders','readwrite');
      const f = await reqP(s.get(id)); f.name=name;
      return reqP(s.put(f));
    },
    async deleteFolder(id){
      const subs = await this.listFolders(id);
      for(const f of subs) await this.deleteFolder(f.id);   // рекурсивно чистим вложенное
      const clips = await this.listClips(id);
      for(const c of clips) await this.deleteClip(c.id);
      const s = await store('folders','readwrite');
      return reqP(s.delete(id));
    },
    async listFolders(parentId=null){
      const s = await store('folders','readonly');
      return reqP(s.index('parentId').getAll(key(parentId)));
    },
    async getFolder(id){
      if(id==null || id===ROOT) return null;
      const s = await store('folders','readonly');
      return reqP(s.get(id));
    },

    async addClip(clip){
      clip.created = Date.now();
      clip.folderId = key(clip.folderId);
      const s = await store('clips','readwrite');
      return reqP(s.add(clip));
    },
    async updateClip(id, patch){
      const s = await store('clips','readwrite');
      const c = await reqP(s.get(id));
      Object.assign(c, patch);
      if('folderId' in patch) c.folderId = key(c.folderId);
      return reqP(s.put(c));
    },
    async deleteClip(id){
      const s = await store('clips','readwrite');
      return reqP(s.delete(id));
    },
    async listClips(folderId=null){
      const s = await store('clips','readonly');
      return reqP(s.index('folderId').getAll(key(folderId)));
    },
    async getClip(id){
      const s = await store('clips','readonly');
      return reqP(s.get(id));
    },
  };
})();

// Декодирует File в моно Float32Array через AudioContext.
async function decodeAudioFile(file){
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext||window.webkitAudioContext)();
  const ab = await ctx.decodeAudioData(buf);
  const ch = ab.numberOfChannels;
  const out = new Float32Array(ab.length);
  for(let c=0;c<ch;c++){
    const d = ab.getChannelData(c);
    for(let i=0;i<d.length;i++) out[i]+=d[i]/ch;
  }
  const sr = ab.sampleRate;
  ctx.close();
  return {samples:out, sr};
}

function fmtDur(s){
  if(!isFinite(s)) return '0:00';
  const m=Math.floor(s/60), r=Math.floor(s%60);
  return m+':'+String(r).padStart(2,'0');
}

// Общий хелпер для узлов с собственным HTML вместо canvas: держит высоту блока
// синхронной с n.size.h (движок дёргает n.onResize сам, в т.ч. вживую при перетаскивании ручки).
function syncCustomHeight(n, root, minH){
  root.style.height = Math.max(minH, n.size.h||minH) + 'px';
}


/* ---------- Узел: Библиотека семплов ---------- */
// Проигрывание идёт через сам узел графа (out:sig), как у обычного 'file' — чтобы услышать,
// нужно подключить выход к чему-то вроде dac. Клик по клипу открывает редактор (modules/audioeditor.js).
// Запись: с входа in, если он подключён и граф запущен, иначе с микрофона.
def({ id:'sampleLib', title:'Sample Library', cat:'Music',
  outs:[{n:'out',t:'sig'},{n:'clipId',t:'num'},{n:'pos',t:'num'}],
  ins:[{n:'clipId',t:'num'},{n:'play',t:'num'},{n:'rate',t:'num'},{n:'gain',t:'num'},{n:'loop',t:'num'},{n:'in',t:'sig'}],
  h:340, resize:true, readout:true,
  params:[
    {n:'rate',t:'range',min:.25,max:4,step:.01,d:1},
    {n:'gain',t:'range',min:0,max:4,step:.01,d:1},
    {n:'loop',t:'check',d:true},
  ],
  init:n=>{
    n.folderId = null;          // текущая папка (null = корень)
    n.path = [];                // хлебные крошки [{id,name}]
    n.selected = null;          // id клипа, чей буфер сейчас в n.data
    n.data = null;               // Float32Array проигрываемого клипа
    n.dataSr = Eng.sr;
    n.pos = 0;
    n.play = false;
    n.playGate = false;
    n.rec = null;                // идущая запись {src:'graph'|'mic', chunks, sr, t0}
    n.onResize = ln => { if(ln.ui) syncCustomHeight(ln, ln.ui.root, 120); };
  },
  process(n,I){
    n.inWired = I.in!=null;
    if(n.rec && n.rec.src==='graph' && I.in) n.rec.chunks.push(Float32Array.from(I.in));
    if(typeof I.clipId==='number' && I.clipId>=0 && I.clipId!==n.selected){
      libArmClip(n, I.clipId, false);            // источник сменился — играть или нет решает play-gate/старое состояние
    }
    if(typeof I.play==='number'){
      const gv = I.play>0.5;
      if(gv && !n.playGate){ n.pos=0; n.play=true; }
      n.playGate = gv;
    }
    if(typeof I.rate==='number') setMod(n,'rate',I.rate);
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    if(typeof I.loop==='number') setMod(n,'loop',I.loop>=0.5);

    const o = buf(n,'out');
    if(!n.data || !n.play){ o.fill(0); return {out:o, clipId:n.selected??-1, pos:n.data?n.pos/n.data.length:0}; }
    const d=n.data, g=n.p.gain, r=n.p.rate*((n.dataSr||Eng.sr)/Eng.sr);
    for(let i=0;i<BLOCK;i++){
      if(n.pos>=d.length-1){
        if(n.p.loop) n.pos=0; else { n.play=false; o[i]=0; continue; }
      }
      const i0=n.pos|0, fr=n.pos-i0;
      o[i]=(d[i0]*(1-fr)+d[i0+1]*fr)*g; n.pos+=r;
    }
    return {out:o, clipId:n.selected, pos:n.pos/d.length};
  },
  draw(n){
    if(!n.initialized && n.el){ libInit(n); n.initialized = true; }
    if(n.ui) libHighlight(n);
    if(n.ro) n.ro.textContent = n.selected!=null
      ? (n.play?'▶ ':'⏸ ')+(n.armedName||'clip #'+n.selected)
      : 'nothing selected';
  }
});

// Загружает клип из базы и делает его текущим источником узла (n.data/n.pos).
async function libArmClip(n, id, autoplay){
  const clip = await SampleDB.getClip(id);
  if(!clip) return;
  n.data = clip.samples;
  n.dataSr = clip.sr;
  n.pos = 0;
  n.selected = id;
  n.armedName = clip.name;
  if(autoplay) n.play = true;
  libHighlight(n);
}

function libInit(n){
  const mid = n.el.querySelector('.mid');
  if(!mid || mid.querySelector('.lib-ui')) return;

  const root = document.createElement('div');
  root.className = 'lib-ui';
  root.style.cssText = 'position:relative;display:flex;flex-direction:column;font-size:11px;'+
    'color:#c8d2d6;box-sizing:border-box;overflow:hidden;grid-column:1/-1;width:100%;min-width:0;';
  root.innerHTML = `
    <div class="lib-toolbar" style="display:flex;gap:4px;padding:2px 0;align-items:center;flex-shrink:0;">
      <button class="lib-newfolder" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:10px;">+ folder</button>
      <button class="lib-import" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:10px;">import</button>
      <button class="lib-rec" title="Record from the in port (when wired and running) or from the microphone" style="background:#1d2226;border:1px solid #2a3136;color:#e05c5c;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:10px;">● rec</button>
      <input class="lib-file" type="file" accept="audio/*" multiple style="display:none;">
      <span class="lib-crumbs" style="flex:1;color:#6c7a80;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
    </div>
    <div class="lib-list" style="flex:1;overflow-y:auto;border:1px solid #1d2226;border-radius:3px;background:#0e1113;position:relative;"></div>
  `;
  mid.append(root);
  syncCustomHeight(n, root, 120);      // сразу выставить текущий n.size.h, дальше — через onResize

  n.ui = {
    root,
    crumbs: root.querySelector('.lib-crumbs'),
    list: root.querySelector('.lib-list'),
    rec: root.querySelector('.lib-rec'),
  };
  n.ui.rec.addEventListener('click', ()=>libRecToggle(n));

  root.querySelector('.lib-newfolder').addEventListener('click', async ()=>{
    const name = prompt('Folder name:');
    if(!name) return;
    await SampleDB.addFolder(name, n.folderId);
    libRefresh(n);
  });

  const fileInput = root.querySelector('.lib-file');
  root.querySelector('.lib-import').addEventListener('click', ()=>fileInput.click());
  fileInput.addEventListener('change', async ()=>{
    for(const f of fileInput.files) await libImportFile(n, f);
    fileInput.value='';
    libRefresh(n);
  });

  // drag&drop файлов прямо на панель
  root.addEventListener('dragover', ev=>{ ev.preventDefault(); });
  root.addEventListener('drop', async ev=>{
    ev.preventDefault();
    const files = [...(ev.dataTransfer.files||[])].filter(f=>f.type.startsWith('audio/'));
    for(const f of files) await libImportFile(n, f);
    libRefresh(n);
  });

  libRefresh(n);
}

async function libImportFile(n, file){
  try{
    const {samples, sr} = await decodeAudioFile(file);
    await SampleDB.addClip({
      name: file.name.replace(/\.[^.]+$/,''),
      folderId: n.folderId,
      sr, samples,
      peaks: SampleDB.computePeaks(samples),
      duration: samples.length/sr,
    });
  }catch(e){ console.warn('import error', e); alert('Failed to read file: '+file.name); }
}

async function libRefresh(n){
  const [folders, clips] = await Promise.all([
    SampleDB.listFolders(n.folderId),
    SampleDB.listClips(n.folderId),
  ]);
  await libBuildCrumbs(n);
  libRenderList(n, folders, clips);
}

async function libBuildCrumbs(n){
  const path = [];
  let id = n.folderId;
  while(id!=null){
    const f = await SampleDB.getFolder(id);
    if(!f) break;
    path.unshift(f);
    id = f.parentId;
  }
  n.path = path;
  const parts = ['root', ...path.map(f=>f.name)];
  n.ui.crumbs.textContent = parts.join(' / ');
}

function libRenderList(n, folders, clips){
  const list = n.ui.list;
  list.innerHTML = '';

  if(n.folderId!=null){
    const up = document.createElement('div');
    up.textContent = '.. up';
    up.style.cssText = 'padding:3px 6px;cursor:pointer;color:#6c7a80;border-bottom:1px solid #121619;';
    up.addEventListener('click', ()=>{
      const parent = n.path.length>1 ? n.path[n.path.length-2].id : null;
      n.folderId = parent;
      libRefresh(n);
    });
    list.appendChild(up);
  }

  for(const f of folders){
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #121619;';
    row.innerHTML = `<span>📁</span><span class="lib-fname" style="flex:1;">${escapeHtml(f.name)}</span>
      <span class="lib-frename" style="cursor:pointer;color:#6c7a80;">✎</span>
      <span class="lib-fdel" style="cursor:pointer;color:#6c7a80;">🗑</span>`;
    row.addEventListener('click', (ev)=>{
      if(ev.target.classList.contains('lib-frename')||ev.target.classList.contains('lib-fdel')) return;
      n.folderId = f.id; libRefresh(n);
    });
    row.querySelector('.lib-frename').addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      const name = prompt('New name:', f.name);
      if(name){ await SampleDB.renameFolder(f.id, name); libRefresh(n); }
    });
    row.querySelector('.lib-fdel').addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      if(!confirm('Delete folder "'+f.name+'" and everything in it?')) return;
      await SampleDB.deleteFolder(f.id); libRefresh(n);
    });
    // перетаскивание клипов в папку
    row.addEventListener('dragover', ev=>{ ev.preventDefault(); row.style.background='#1d2226'; });
    row.addEventListener('dragleave', ()=>{ row.style.background=''; });
    row.addEventListener('drop', async ev=>{
      ev.preventDefault(); row.style.background='';
      const id = +ev.dataTransfer.getData('application/x-dsp-clip-id');
      if(id) { await SampleDB.updateClip(id, {folderId:f.id}); libRefresh(n); }
    });
    list.appendChild(row);
  }

  for(const c of clips){
    list.appendChild(libClipRow(n, c));
  }

  if(!folders.length && !clips.length){
    const empty = document.createElement('div');
    empty.textContent = 'empty — import a file or record a sample';
    empty.style.cssText = 'padding:12px;text-align:center;color:#2a3136;';
    list.appendChild(empty);
  }
}

function libClipRow(n, c){
  const row = document.createElement('div');
  row.draggable = true;
  row.dataset.clipId = c.id;
  const isSel = n.selected===c.id;
  row.style.cssText = `display:flex;align-items:center;gap:5px;padding:2px 6px;min-height:28px;cursor:pointer;
    border-bottom:1px solid #121619;background:${isSel?'#1d2226':'transparent'};min-width:0;`;

  const canvas = document.createElement('canvas');
  canvas.width=36; canvas.height=18;
  canvas.style.cssText = 'width:36px;height:18px;flex-shrink:0;';
  libDrawPeaks(canvas, c.peaks);

  const name = document.createElement('span');
  name.textContent = c.name;
  name.style.cssText = 'flex:1;min-width:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const dur = document.createElement('span');
  dur.textContent = fmtDur(c.duration);
  dur.style.cssText = 'color:#4ec9b0;width:30px;flex-shrink:0;';

  const playBtn = document.createElement('span');
  playBtn.textContent = (n.selected===c.id && n.play) ? '⏸' : '▶';
  playBtn.style.cssText='cursor:pointer;';
  playBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    if(n.selected===c.id){ n.play = !n.play; libHighlight(n); }
    else await libArmClip(n, c.id, true);
  });

  const renameBtn = document.createElement('span');
  renameBtn.textContent = '✎'; renameBtn.style.cssText='cursor:pointer;color:#6c7a80;';
  renameBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    const nm = prompt('New name:', c.name);
    if(nm){ await SampleDB.updateClip(c.id, {name:nm}); libRefresh(n); }
  });

  const delBtn = document.createElement('span');
  delBtn.textContent = '🗑'; delBtn.style.cssText='cursor:pointer;color:#6c7a80;';
  delBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    if(!confirm('Delete sample "'+c.name+'"?')) return;
    await SampleDB.deleteClip(c.id);
    if(n.selected===c.id){ n.selected=null; n.data=null; n.play=false; }
    libRefresh(n);
  });

  for(const b of [playBtn, renameBtn, delBtn]) b.style.padding = '4px 3px';   // палец должен попадать
  row.append(canvas, name, dur, playBtn, renameBtn, delBtn);

  row.addEventListener('click', ()=>libOpenEditor(n, c.id));
  row.addEventListener('dragstart', ev=>{
    ev.dataTransfer.setData('application/x-dsp-clip-id', String(c.id));
    ev.dataTransfer.setData('text/plain', c.name);
  });

  return row;
}

// Лёгкое обновление подсветки/иконки play без полной перерисовки списка — вызывается на каждый draw().
function libHighlight(n){
  if(!n.ui) return;
  const rows = n.ui.list.querySelectorAll('[data-clip-id]');
  rows.forEach(r=>{
    const id = +r.dataset.clipId;
    const sel = id===n.selected;
    r.style.background = sel ? '#1d2226' : 'transparent';
    const btn = r.children[3];
    if(btn) btn.textContent = (sel && n.play) ? '⏸' : '▶';
  });
}

function libDrawPeaks(canvas, peaks){
  const cx = canvas.getContext('2d');
  const W=canvas.width, H=canvas.height, half=H/2;
  cx.clearRect(0,0,W,H);
  if(!peaks || !peaks.length) return;
  const n = peaks.length/2;
  cx.strokeStyle = themeColor('--acc2'); cx.lineWidth = 1;
  cx.beginPath();
  for(let i=0;i<n;i++){
    const x = i/n*W;
    const lo = peaks[i*2], hi = peaks[i*2+1];
    cx.moveTo(x, half - hi*half*0.9);
    cx.lineTo(x, half - lo*half*0.9);
  }
  cx.stroke();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}


/* ---------- Редактор и запись ---------- */
async function libOpenEditor(n, id){
  if(n.editor) return;
  const clip = await SampleDB.getClip(id);
  if(!clip) return;
  n.editor = aedOpen(clip, {
    onSaved: async sid=>{ if(n.selected===sid) await libArmClip(n, sid, false); libRefresh(n); },
    onClose: ()=>{ n.editor = null; },
  });
}

async function libRecToggle(n){
  if(n.rec) return libRecStop(n);
  if(n.inWired && Eng.running){
    n.rec = { src:'graph', chunks:[], sr:Eng.sr, t0:performance.now() };
  } else {
    // контекст создаём до await — иначе iOS не даст запустить его вне жеста
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    ctx.resume();
    let st;
    try{ st = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}); }
    catch(e){ ctx.close(); alert('Microphone unavailable: '+e.message); return; }
    const src = ctx.createMediaStreamSource(st), sp = ctx.createScriptProcessor(4096, 1, 1);
    const rec = n.rec = { src:'mic', chunks:[], sr:ctx.sampleRate, t0:performance.now(), ctx, st, sp };
    sp.onaudioprocess = e=>{ if(n.rec===rec) rec.chunks.push(e.inputBuffer.getChannelData(0).slice()); };
    src.connect(sp); sp.connect(ctx.destination);      // без подключения к выходу обработчик не вызывается; выход — тишина
  }
  n.recTimer = setInterval(()=>libRecUI(n), 250);
  libRecUI(n);
}
async function libRecStop(n){
  const rec = n.rec; n.rec = null;
  clearInterval(n.recTimer); libRecUI(n);
  if(rec.src==='mic'){ rec.sp.disconnect(); rec.st.getTracks().forEach(t=>t.stop()); rec.ctx.close(); }
  const len = rec.chunks.reduce((a,c)=>a+c.length, 0);
  if(!len){ alert(rec.src==='graph' ? 'Nothing recorded — is the graph running?' : 'Nothing recorded'); return; }
  const samples = new Float32Array(len);
  let o = 0; for(const c of rec.chunks){ samples.set(c, o); o += c.length; }
  const id = await SampleDB.addClip({
    name: 'rec '+new Date().toLocaleTimeString(), folderId: n.folderId, sr: rec.sr, samples,
    peaks: SampleDB.computePeaks(samples), duration: len/rec.sr,
  });
  await libRefresh(n);
  await libArmClip(n, id, false);
}
function libRecUI(n){
  const b = n.ui?.rec; if(!b) return;
  if(n.rec){
    b.textContent = '■ '+fmtDur((performance.now()-n.rec.t0)/1000)+(n.rec.src==='graph'?' in':' mic');
    b.style.background = '#e05c5c'; b.style.color = '#111';
  } else { b.textContent = '● rec'; b.style.background = '#1d2226'; b.style.color = '#e05c5c'; }
}


/* ============================ СПИСКИ (IndexedDB + CSV) ============================ */
// Хранилище именованных списков "имя → значение" (адреса SDR, URL потоков и т.п.).
// Один список = все записи с одинаковым listName. Ключ хранения — имя списка,
// а не n.id узла, чтобы список переживал пересборку/копирование узла.

const ListDB = (() => {
  let dbp = null;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const rq = indexedDB.open('dsp-lists', 2);
      rq.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains('items')){
          const s = db.createObjectStore('items',{keyPath:'id',autoIncrement:true});
          s.createIndex('listName','listName');
        }
        if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'listName'});   // порядок колонок списка
      };
      rq.onsuccess = e => res(e.target.result);
      rq.onerror = e => rej(e.target.error);
    });
    return dbp;
  }
  async function store(mode){ const db=await open(); return db.transaction('items',mode).objectStore('items'); }
  function reqP(rq){ return new Promise((res,rej)=>{ rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }
  // fields — объект {имяПоля:значение}; value дублируется из fields.value для чтения старым кодом
  return {
    async add(listName,name,fields){ const s=await store('readwrite');
      return reqP(s.add({listName,name,fields,value:fields?.value??'',created:Date.now()})); },
    async update(id,patch){ const s=await store('readwrite'); const it=await reqP(s.get(id)); Object.assign(it,patch); return reqP(s.put(it)); },
    async remove(id){ const s=await store('readwrite'); return reqP(s.delete(id)); },
    async list(listName){ const s=await store('readonly');
      const items=await reqP(s.index('listName').getAll(listName));
      // старые записи (до появления fields) — доопределяем как одно поле value
      return items.map(it=>({...it, fields: it.fields || {value: it.value}}));
    },
    async listNames(){ const s=await store('readonly'); const all=await reqP(s.getAll());
      const meta=await ListDB.metaNames();               // пустой список с колонками тоже существует
      return [...new Set([...all.map(x=>x.listName),...meta])].sort(); },
    async renameList(oldName,newName){ const s=await store('readwrite');
      const items=await reqP(s.index('listName').getAll(oldName));
      for(const it of items){ it.listName=newName; await reqP(s.put(it)); }
      const m=await ListDB.getMeta(oldName);
      if(m){ await ListDB.delMeta(oldName); await ListDB.setMeta(newName,m); } },
    async deleteList(listName){ const s=await store('readwrite');
      const items=await reqP(s.index('listName').getAll(listName));
      for(const it of items) await reqP(s.delete(it.id));
      await ListDB.delMeta(listName); },
    // пакетная запись одной транзакцией — для потока записей и импорта
    async addMany(listName,rows){
      const db=await open();
      return new Promise((res,rej)=>{
        const tx=db.transaction('items','readwrite'), s=tx.objectStore('items'), ids=[];
        for(const r of rows){
          const rq=s.add({listName,name:r.name,fields:r.fields,value:r.fields?.value??'',created:Date.now()});
          rq.onsuccess=()=>ids.push(rq.result);
        }
        tx.oncomplete=()=>res(ids); tx.onerror=tx.onabort=()=>rej(tx.error);
      });
    },
    async removeMany(ids){
      const db=await open();
      return new Promise((res,rej)=>{
        const tx=db.transaction('items','readwrite'), s=tx.objectStore('items');
        for(const id of ids) s.delete(id);
        tx.oncomplete=()=>res(); tx.onerror=tx.onabort=()=>rej(tx.error);
      });
    },
    async getMeta(listName){ const db=await open(); return reqP(db.transaction('meta','readonly').objectStore('meta').get(listName)); },
    async setMeta(listName,meta){ const db=await open(); return reqP(db.transaction('meta','readwrite').objectStore('meta').put({...meta,listName})); },
    async delMeta(listName){ const db=await open(); return reqP(db.transaction('meta','readwrite').objectStore('meta').delete(listName)); },
    async metaNames(){ const db=await open(); return reqP(db.transaction('meta','readonly').objectStore('meta').getAllKeys()); },
  };
})();

// Простой CSV-парсер с поддержкой кавычек и экранированных "" внутри поля.
function csvParse(text){
  const rows=[]; let i=0, field='', row=[], inQ=false; const N=text.length;
  while(i<N){
    const c=text[i];
    if(inQ){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i+=2; continue; } inQ=false; i++; continue; }
      field+=c; i++; continue;
    }
    if(c==='"'){ inQ=true; i++; continue; }
    if(c===','){ row.push(field); field=''; i++; continue; }
    if(c==='\r'){ i++; continue; }
    if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; i++; continue; }
    field+=c; i++;
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length>1 || r[0]!=='');
}

// Строка из БД/CSV может быть и адресом, и частотой — отдаём числом, если она чисто числовая,
// иначе как есть строкой. Само хранилище всегда хранит текст (так проще редактировать).
function hostlistCoerce(v){
  const s=String(v??'').trim();
  if(s==='') return s;
  if(/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)){ const num=Number(s); if(isFinite(num)) return num; }
  return s;
}

def({ id:'hostlist', title:'List (CSV/DB)', cat:'Sources', legacy:true,   // заменён узлом 'table'
  // порты формируются динамически по набору полей списка (n.p.fields) — движок уже
  // поддерживает ins/outs как функцию узла (см. portsOf в core-engine.js)
  ins: n => (n.p.fields||['value']).map(f=>({n:f,t:'val'})).concat([{n:'trig',t:'val'}]),
  outs: n => (n.p.fields||['value']).map(f=>({n:f,t:'val'})),
  h:260, resize:true, readout:true,
  params:[],   // весь UI — кастомный (hostlistInit), стандартные params не нужны
  init:n=>{
    n.p.listName = n.p.listName || 'my list';
    n.p.fields = (n.p.fields && n.p.fields.length) ? n.p.fields : ['value'];
    if(n.p.selectedId===undefined) n.p.selectedId = null;
    n.items=[]; n.selected=n.p.selectedId; n.selectedName='';
    n.rowFields={}; n.lastIn={}; n.trigPrev=0; n.loadedListName=null;
    n.onResize = ln => { if(ln.ui) syncCustomHeight(ln, ln.ui.root, 140); };
  },
  process(n,I){
    if(n.p.listName!==n.loadedListName) hostlistRefresh(n);   // список сменили извне (десериализация/undo)
    n.lastIn = I;
    const trig = typeof I.trig==='number' ? I.trig : 0;       // сохранение по фронту триггера
    if(trig>0.5 && n.trigPrev<=0.5) hostlistCapture(n,false);
    n.trigPrev = trig;
    const out={};
    for(const f of n.p.fields) out[f] = hostlistCoerce(n.rowFields[f] ?? '');
    return out;
  },
  draw(n){
    if(!n.initialized && n.el){ hostlistInit(n); n.initialized=true; }
    const r=n.el.querySelector('.readout');
    if(r) r.textContent = n.selected!=null ? ('selected: '+n.selectedName) : 'nothing selected';
  }});

// применяет выбранную запись к выходам узла
function hostlistApplyRow(n, it){
  n.selected = it.id; n.p.selectedId = it.id; n.selectedName = it.name;
  const f={};
  for(const key of n.p.fields) f[key] = it.fields[key] ?? '';
  n.rowFields = f;
}

// смена состава полей: пересобирает порты узла, отвязывает провода от исчезнувших портов
function hostlistApplyFields(n, newFields){
  n.p.fields = newFields.length ? newFields : ['value'];
  const validIn = new Set(n.p.fields.concat(['trig']));
  const validOut = new Set(n.p.fields);
  Graph.edges.filter(e=>(e.to===n.id && !validIn.has(e.tp)) || (e.from===n.id && !validOut.has(e.fp)))
    .forEach(delEdge);
  n.rowFields = {};
  n.initialized = false;                  // draw() пересоздаст n.ui на новом DOM
  rebuildNode(n);
  markTopoDirty();
}

// сохраняет текущие значения входов как новую запись; askName — спросить название через prompt
async function hostlistCapture(n, askName){
  const fields={};
  for(const f of n.p.fields) fields[f] = n.lastIn[f];
  let name = 'entry '+(n.items.length+1);
  if(askName){ const nm=prompt('Entry name:', name); if(nm==null) return; name=nm; }
  await ListDB.add(n.p.listName, name, fields);
  await hostlistRefresh(n);
}

async function hostlistRefresh(n){
  n.loadedListName = n.p.listName;
  const items = await ListDB.list(n.p.listName);
  n.items = items;
  if(n.p.selectedId!=null){
    const it = items.find(x=>x.id===n.p.selectedId);
    if(it) hostlistApplyRow(n, it);
    else { n.selected=null; n.p.selectedId=null; n.rowFields={}; n.selectedName=''; }
  }
  if(n.ui) await hostlistRenderAll(n);
}

function hostlistFieldCell(it,n,f){
  return it.fields[f] ?? '';
}

function csvCell(v){
  const s=String(v??'');
  return /[",\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}

function hostlistExportCsv(n){
  const rows=[['name',...n.p.fields]];
  for(const it of n.items) rows.push([it.name, ...n.p.fields.map(f=>hostlistFieldCell(it,n,f))]);
  const csv = rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=(n.p.listName||'list')+'.csv';
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

function hostlistInit(n){
  const mid = n.el.querySelector('.mid');
  if(!mid || mid.querySelector('.hl-ui')) return;

  const root = document.createElement('div');
  root.className = 'hl-ui';
  root.style.cssText = 'position:relative;display:flex;flex-direction:column;font-size:11px;'+
    'color:#c8d2d6;box-sizing:border-box;overflow:hidden;grid-column:1/-1;width:100%;min-width:0;gap:2px;';
  root.innerHTML = `
    <div class="hl-row" style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
      <select class="hl-select" style="flex:1;min-width:0;background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;font-size:10px;padding:1px 2px;"></select>
      <span class="hl-new" title="new list" style="cursor:pointer;color:#6c7a80;">＋</span>
      <span class="hl-ren" title="rename list" style="cursor:pointer;color:#6c7a80;">✎</span>
      <span class="hl-delL" title="delete list" style="cursor:pointer;color:#6c7a80;">🗑</span>
    </div>
    <div class="hl-fields" style="display:flex;gap:3px;flex-wrap:wrap;flex-shrink:0;font-size:10px;"></div>
    <div class="hl-row" style="display:flex;gap:4px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
      <button class="hl-add" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;">+ entry</button>
      <button class="hl-read" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;" title="save current input values as an entry">read input</button>
      <button class="hl-import" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;">import CSV</button>
      <button class="hl-export" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;">export CSV</button>
      <input class="hl-file" type="file" accept=".csv,text/csv" style="display:none;">
      <span class="hl-count" style="flex:1;text-align:right;color:#6c7a80;font-size:10px;"></span>
    </div>
    <div class="hl-list" style="flex:1;overflow-y:auto;border:1px solid #1d2226;border-radius:3px;background:#0e1113;position:relative;"></div>
    <div class="hl-csv" style="display:none;position:absolute;inset:0;background:#0e1113;border:1px solid #2a3136;border-radius:3px;padding:4px;flex-direction:column;gap:4px;z-index:5;"></div>
  `;
  mid.append(root);
  syncCustomHeight(n, root, 140);

  n.ui = { root, list: root.querySelector('.hl-list'), csv: root.querySelector('.hl-csv'),
    count: root.querySelector('.hl-count'), select: root.querySelector('.hl-select'),
    fields: root.querySelector('.hl-fields') };

  n.ui.select.addEventListener('change', async ()=>{
    const v = n.ui.select.value;
    n.p.selectedId=null; n.selected=null; n.rowFields={}; n.selectedName='';
    n.p.listName = v;
    await hostlistRefresh(n);
  });
  root.querySelector('.hl-new').addEventListener('click', async ()=>{
    const nm = prompt('New list name:'); if(!nm) return;
    n.p.listName = nm; n.p.fields=['value']; n.p.selectedId=null; n.selected=null; n.rowFields={};
    await hostlistRefresh(n);
  });
  root.querySelector('.hl-ren').addEventListener('click', async ()=>{
    const nm = prompt('New list name:', n.p.listName); if(!nm || nm===n.p.listName) return;
    await ListDB.renameList(n.p.listName, nm);
    n.p.listName = nm;
    await hostlistRefresh(n);
  });
  root.querySelector('.hl-delL').addEventListener('click', async ()=>{
    if(!confirm('Delete list "'+n.p.listName+'" entirely?')) return;
    await ListDB.deleteList(n.p.listName);
    n.p.listName='my list'; n.p.fields=['value']; n.p.selectedId=null; n.selected=null; n.rowFields={};
    await hostlistRefresh(n);
  });

  root.querySelector('.hl-add').addEventListener('click', async ()=>{
    const name = prompt('Name:'); if(!name) return;
    const fields={};
    for(const f of n.p.fields) fields[f] = prompt('Value for field "'+f+'":','') ?? '';
    await ListDB.add(n.p.listName, name, fields);
    await hostlistRefresh(n);
  });
  root.querySelector('.hl-read').addEventListener('click', ()=>hostlistCapture(n,true));

  const fileInput = root.querySelector('.hl-file');
  root.querySelector('.hl-import').addEventListener('click', ()=>fileInput.click());
  fileInput.addEventListener('change', ()=>{
    const f = fileInput.files[0]; fileInput.value='';
    if(f) hostlistOpenCsv(n,f);
  });
  root.querySelector('.hl-export').addEventListener('click', ()=>hostlistExportCsv(n));

  hostlistRefresh(n);
}

async function hostlistRenderAll(n){
  const names = await ListDB.listNames();
  if(!names.includes(n.p.listName)) names.push(n.p.listName);   // список ещё пуст, но уже выбран
  const sel = n.ui.select;
  sel.innerHTML = names.map(nm=>`<option value="${escapeHtml(nm)}"${nm===n.p.listName?' selected':''}>${escapeHtml(nm)}</option>`).join('');
  hostlistRenderFields(n);
  hostlistRender(n);
}

function hostlistRenderFields(n){
  const box = n.ui.fields;
  box.innerHTML = '';
  for(const f of n.p.fields){
    const chip = document.createElement('span');
    chip.style.cssText = 'background:#1d2226;border:1px solid #2a3136;border-radius:3px;padding:0 4px;display:flex;align-items:center;gap:3px;';
    chip.innerHTML = `<span>${escapeHtml(f)}</span><span class="hl-fdel" style="cursor:pointer;color:#6c7a80;">×</span>`;
    chip.querySelector('.hl-fdel').addEventListener('click', ()=>{
      if(n.p.fields.length<=1) return;                          // хотя бы одно поле должно остаться
      if(!confirm('Remove field "'+f+'"? Values in entries stay in the DB but won\'t be shown.')) return;
      hostlistApplyFields(n, n.p.fields.filter(x=>x!==f));
    });
    box.appendChild(chip);
  }
  const addBtn = document.createElement('span');
  addBtn.textContent = '+ field'; addBtn.style.cssText='cursor:pointer;color:#4ec9b0;';
  addBtn.addEventListener('click', ()=>{
    const nm = prompt('New field name:'); if(!nm) return;
    if(n.p.fields.includes(nm)) return;
    hostlistApplyFields(n, n.p.fields.concat([nm]));
  });
  box.appendChild(addBtn);
}

function hostlistRender(n){
  const list = n.ui.list;
  list.innerHTML = '';
  n.ui.count.textContent = n.items.length+' entries';
  if(!n.items.length){
    const empty = document.createElement('div');
    empty.textContent = 'empty — add an entry or import CSV';
    empty.style.cssText = 'padding:12px;text-align:center;color:#2a3136;';
    list.appendChild(empty);
    return;
  }
  for(const it of n.items) list.appendChild(hostlistRow(n,it));
}

function hostlistRow(n,it){
  const row = document.createElement('div');
  row.dataset.itemId = it.id;
  const isSel = n.selected===it.id;
  row.style.cssText = `display:flex;align-items:center;gap:5px;padding:2px 6px;cursor:pointer;
    border-bottom:1px solid #121619;background:${isSel?'#1d2226':'transparent'};min-width:0;`;

  const name = document.createElement('span');
  name.textContent = it.name;
  name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const val = document.createElement('span');
  val.textContent = n.p.fields.map(f=>hostlistFieldCell(it,n,f)).join(' / ');
  val.style.cssText = 'color:#4ec9b0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;';

  const renameBtn = document.createElement('span');
  renameBtn.textContent = '✎'; renameBtn.style.cssText='cursor:pointer;color:#6c7a80;';
  renameBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    const nm = prompt('Name:', it.name); if(nm==null) return;
    const fields={};
    for(const f of n.p.fields) fields[f] = prompt('Value for field "'+f+'":', hostlistFieldCell(it,n,f)) ?? hostlistFieldCell(it,n,f);
    await ListDB.update(it.id, {name:nm, fields, value:fields.value??it.value});
    await hostlistRefresh(n);
  });

  const delBtn = document.createElement('span');
  delBtn.textContent = '🗑'; delBtn.style.cssText='cursor:pointer;color:#6c7a80;';
  delBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    if(!confirm('Delete entry "'+it.name+'"?')) return;
    await ListDB.remove(it.id);
    if(n.selected===it.id){ n.selected=null; n.p.selectedId=null; n.rowFields={}; n.selectedName=''; }
    await hostlistRefresh(n);
  });

  row.append(name, val, renameBtn, delBtn);
  row.addEventListener('click', ()=>{
    hostlistApplyRow(n, it);
    hostlistRender(n);
  });
  return row;
}

// уникализирует имена полей из заголовков CSV (пустые/дублирующиеся получают суффикс)
function hostlistDedupFieldNames(names){
  const seen=new Map(), out=[];
  names.forEach((raw,i)=>{
    let nm = String(raw||'').trim() || ('field'+(i+1));
    if(seen.has(nm)){ const k=seen.get(nm)+1; seen.set(nm,k); nm=nm+'_'+k; }
    else seen.set(nm,0);
    out.push(nm);
  });
  return out;
}

function hostlistOpenCsv(n,file){
  const reader = new FileReader();
  reader.onload = ()=>{
    let rows;
    try{ rows = csvParse(String(reader.result)); }
    catch(e){ alert('failed to parse CSV: '+e.message); return; }
    if(!rows.length){ alert('file is empty'); return; }
    hostlistShowCsvPicker(n, rows);
  };
  reader.readAsText(file);
}

function hostlistShowCsvPicker(n, rows){
  const box = n.ui.csv;
  box.style.display = 'flex';
  box.innerHTML = '';

  const header = rows[0];
  const dataRows = rows.slice(1);

  const guessCol = names => {
    const idx = header.findIndex(h=>names.includes(String(h).trim().toLowerCase()));
    return idx>=0 ? idx : 0;
  };
  const nameIdx0 = guessCol(['name','название','имя']); // recognize Russian legacy CSV headers too

  const top = document.createElement('div');
  top.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:10px;flex-shrink:0;';
  top.innerHTML = `<label>name column: <select class="hl-colname"></select></label>
    <div class="hl-cols" style="display:flex;gap:6px;flex-wrap:wrap;"></div>`;
  box.appendChild(top);
  const selName = top.querySelector('.hl-colname'), colsBox = top.querySelector('.hl-cols');
  header.forEach((h,i)=>{
    const o=document.createElement('option'); o.value=i; o.textContent=h||('column '+(i+1)); selName.append(o);
    const lab=document.createElement('label'); lab.style.cssText='display:flex;gap:2px;align-items:center;';
    lab.innerHTML = `<input type="checkbox" class="hl-colcheck" data-idx="${i}" checked> ${escapeHtml(h||'column '+(i+1))}`;
    colsBox.append(lab);
  });
  selName.value = nameIdx0;

  const preview = document.createElement('div');
  preview.style.cssText = 'flex:1;overflow:auto;border:1px solid #1d2226;border-radius:3px;font-size:10px;';
  box.appendChild(preview);
  const renderPreview = ()=>{
    const ni=+selName.value;
    const vis=[...colsBox.querySelectorAll('.hl-colcheck:checked')].map(c=>+c.dataset.idx);
    preview.innerHTML = dataRows.slice(0,8).map(r=>
      `<div style="padding:2px 6px;border-bottom:1px solid #121619;">${escapeHtml(r[ni]||'')} → <span style="color:#4ec9b0;">${vis.map(i=>escapeHtml(r[i]||'')).join(' / ')}</span></div>`
    ).join('') || '<div style="padding:8px;color:#6c7a80;">no data rows</div>';
  };
  renderPreview();
  selName.addEventListener('change', renderPreview);
  colsBox.addEventListener('change', renderPreview);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:4px;flex-shrink:0;align-items:center;';
  controls.innerHTML = `
    <span style="flex:1;font-size:10px;color:#6c7a80;">rows: ${dataRows.length}</span>
    <button class="hl-csv-ok" style="background:#1d2226;border:1px solid #4ec9b0;color:#4ec9b0;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:10px;">import</button>
    <button class="hl-csv-cancel" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:10px;">cancel</button>
  `;
  box.appendChild(controls);

  controls.querySelector('.hl-csv-ok').addEventListener('click', async ()=>{
    const ni=+selName.value;
    const valIdx=[...colsBox.querySelectorAll('.hl-colcheck:checked')].map(c=>+c.dataset.idx);
    if(!valIdx.length){ alert('select at least one value column'); return; }
    const newFields = hostlistDedupFieldNames(valIdx.map(i=>header[i]));
    hostlistApplyFields(n, newFields);
    for(let ri=0; ri<dataRows.length; ri++){
      const r = dataRows[ri];
      const name=(r[ni]||'').trim();
      const fields={};
      valIdx.forEach((ci,k)=>{ fields[newFields[k]] = (r[ci]||'').trim(); });
      if(!name && Object.values(fields).every(v=>!v)) continue;
      await ListDB.add(n.p.listName, name||('entry '+(ri+1)), fields);
    }
    hostlistCloseCsv(n);
    await hostlistRefresh(n);
  });
  controls.querySelector('.hl-csv-cancel').addEventListener('click', ()=>hostlistCloseCsv(n));
}
function hostlistCloseCsv(n){
  n.ui.csv.style.display = 'none';
  n.ui.csv.innerHTML = '';
}


/* ============================ ПРОИГРЫВАТЕЛЬ АУДИОПОТОКА (URL) ============================ */
// MediaElementSource из <audio> тянем в отдельный AudioWorklet-тап, который просто
// пересылает сэмплы в главный поток — движок читает их из кольцевого буфера, как rtl-sdr/kiwi.
// Тап сам ничего не выводит (out.fill(0)), звук наружу идёт только через выход узла графа.
// CORS: без Access-Control-Allow-Origin на сервере потока MediaElementSource отдаёт тишину —
// это ограничение браузера, а не баг узла; для приватных стримов нужен прокси с нужными заголовками.

function streamRegisterWorklet(ctx){
  if(ctx._streamTapReady) return ctx._streamTapReady;
  const src = `
    class StreamTap extends AudioWorkletProcessor{
      constructor(){ super(); this.b=new Float32Array(512); this.k=0; }
      process(inputs,outputs){
        const inp=inputs[0][0];
        if(inp){                                      // копим 512 отсчётов — в 4 раза меньше сообщений
          this.b.set(inp,this.k); this.k+=inp.length;
          if(this.k>=512){ this.port.postMessage(this.b); this.b=new Float32Array(512); this.k=0; } }
        const o=outputs[0][0]; if(o) o.fill(0);
        return true; } }
    registerProcessor('stream-tap',StreamTap);`;
  const url = URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
  ctx._streamTapReady = ctx.audioWorklet.addModule(url).finally(()=>URL.revokeObjectURL(url));
  return ctx._streamTapReady;
}

function streamResetRing(n){
  const SIZE = Math.max(50000, Math.round((Eng.sr||48000)*3));
  n.ring = {A:new Float32Array(SIZE), size:SIZE, w:0, filled:0, written:0};
  n.readPos=0; n.readCount=0; n.rebuffering=false;
}

function streamPush(n, chunk){
  const ring=n.ring; let w=ring.w, filled=ring.filled;
  for(let i=0;i<chunk.length;i++){ ring.A[w]=chunk[i]; w=(w+1)%ring.size; if(filled<ring.size) filled++; }
  ring.w=w; ring.filled=filled; ring.written+=chunk.length;
}

// Ждёт, пока <audio> реально сможет играть, либо словит ошибку источника/таймаут.
// play() сам по себе не всегда достаточен: при "no supported source" он может либо
// отклониться, либо просто зависнуть без явного отказа — событие error надёжнее.
function streamTryLoad(audio, timeoutMs){
  return new Promise((resolve,reject)=>{
    let done=false;
    const cleanup=()=>{ audio.removeEventListener('canplay',onOk); audio.removeEventListener('error',onErr); clearTimeout(t); };
    const onOk=()=>{ if(done) return; done=true; cleanup(); resolve(); };
    const onErr=()=>{ if(done) return; done=true; cleanup();
      reject(new Error(audio.error ? 'error code '+audio.error.code : 'failed to load source')); };
    audio.addEventListener('canplay',onOk,{once:true});
    audio.addEventListener('error',onErr,{once:true});
    const t=setTimeout(()=>{ if(done) return; done=true; cleanup(); reject(new Error('load timeout')); }, timeoutMs||8000);
  });
}

function streamTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.audioEl){ try{ n.audioEl.pause(); n.audioEl.src=''; n.audioEl.load(); }catch(e){} n.audioEl=null; }
  if(n.tapNode){ try{ n.tapNode.port.onmessage=null; n.tapNode.disconnect(); }catch(e){} n.tapNode=null; }
  if(n.srcNode){ try{ n.srcNode.disconnect(); }catch(e){} n.srcNode=null; }
  if(n.sink){ try{ n.sink.disconnect(); }catch(e){} n.sink=null; }
  icyMetadataStop(n);
  n.icyRaw=null; n.icyArtist=''; n.icyTitle='';
}

// Захват в граф (MediaElementSource) требует crossOrigin='anonymous' И правильных CORS-заголовков
// от сервера потока — без них браузер либо отдаёт тишину, либо (чаще) вовсе отказывается
// грузить источник. Без обхода: раз сервер не отвечает нужными заголовками — просто ошибка.
async function streamPlay(n){
  if(n.connecting) return;
  streamTeardown(n);
  const url=(n.p.url||'').trim();
  if(!url){ n.status='enter a URL'; return; }
  n.connecting=true; n.status='connecting…';
  try{
    if(!Eng.running) await Eng.start();
    else if(Eng.paused) await Eng.ctx.resume();
    const ctx = Eng.ctx;

    const audio=new Audio();
    audio.crossOrigin='anonymous';        // обязательно ДО src
    audio.preload='auto'; audio.src=url;
    try{ await streamTryLoad(audio); }
    catch(e){
      try{ audio.removeAttribute('src'); audio.load(); }catch(e2){}
      n.connecting=false; n.connected=false;
      n.status='blocked (server does not send CORS headers)';
      return;
    }

    await streamRegisterWorklet(ctx);
    const srcNode = ctx.createMediaElementSource(audio);
    const tap = new AudioWorkletNode(ctx,'stream-tap',{numberOfInputs:1,numberOfOutputs:1,
      channelCount:1, channelCountMode:'explicit', channelInterpretation:'speakers'});
    tap.port.onmessage = e => streamPush(n, e.data);
    const sink = ctx.createGain(); sink.gain.value = 0;   // тянем граф до destination неслышно
    srcNode.connect(tap); tap.connect(sink); sink.connect(ctx.destination);
    n.audioEl=audio; n.srcNode=srcNode; n.tapNode=tap; n.sink=sink; n.ctxRef=ctx;
    streamResetRing(n);
    await audio.play();
    n.connected=true; n.connecting=false; n.status='playing';
    if(n.p.meta!==false) icyMetadataStart(n, url);   // не ждём — читается фоном, пока не остановят поток
  }catch(e){
    console.error('stream:',e);
    n.connecting=false; n.connected=false;
    n.status='error: '+e.message;
    streamTeardown(n);
  }
}

function streamStop(n){
  n.status='stopped';
  streamTeardown(n);
}

// Останавливает фоновое чтение ICY-метаданных (отдельный fetch, см. icyMetadataStart).
function icyMetadataStop(n){
  if(n.icyAbort){ try{ n.icyAbort.abort(); }catch(e){} n.icyAbort=null; }
  n.icyReading=false;
}

function icyMetadataApply(n, meta){
  const m = /StreamTitle=['"]([^'"]*)['"]/.exec(meta);
  const title = m ? m[1] : '';
  if(title===n.icyRaw) return;               // трек не сменился — событие не дёргаем
  n.icyRaw = title;
  let artist='', track=title;
  const parts = title.split(' - ');
  if(parts.length>=2){ artist=parts[0].trim(); track=parts.slice(1).join(' - ').trim(); }
  n.icyArtist=artist; n.icyTitle=track;
  n.trackPulse=2;                             // фронт на выход trackChange, как go у textsrc
  n.icyStatus=title || 'untitled track';
}

// ICY-метаданные (Icecast/SHOUTcast) браузерный <audio> не отдаёт вообще — качаем поток
// ещё раз отдельным fetch с заголовком Icy-MetaData:1 и вручную парсим бинарный формат
// (каждые icy-metaint байт аудио идёт 1 байт длины*16 + сама метадата). Требует, чтобы
// сервер согласился на CORS-preflight по этому заголовку и отдал Access-Control-Expose-Headers
// с icy-metaint — большинство станций так не умеет, тогда просто остаёмся без метаданных.
async function icyMetadataStart(n, url){
  icyMetadataStop(n);
  const ac = new AbortController();
  n.icyAbort = ac; n.icyReading = true;
  try{
    const resp = await fetch(url, {headers:{'Icy-MetaData':'1'}, signal:ac.signal, mode:'cors'});
    const metaint = parseInt(resp.headers.get('icy-metaint')||'', 10);
    if(!metaint || !resp.body){ n.icyStatus='metadata unavailable (server does not send it)'; return; }
    const reader = resp.body.getReader();
    let sinceMeta=0, mode='audio', metaLen=0, metaBuf=[];
    while(n.icyReading){
      const {value,done} = await reader.read();
      if(done) break;
      let i=0;
      while(i<value.length){
        if(mode==='audio'){                          // аудиобайты пропускаем целиком, без цикла по байту
          const k=Math.min(metaint-sinceMeta,value.length-i);
          sinceMeta+=k; i+=k;
          if(sinceMeta===metaint){ mode='metalen'; sinceMeta=0; }
        } else if(mode==='metalen'){
          metaLen=value[i++]*16; metaBuf=[];
          mode = metaLen>0 ? 'meta' : 'audio';
        } else {
          const k=Math.min(metaLen-metaBuf.length,value.length-i);
          for(let j=0;j<k;j++) metaBuf.push(value[i+j]);
          i+=k;
          if(metaBuf.length>=metaLen){
            icyMetadataApply(n, new TextDecoder('utf-8').decode(new Uint8Array(metaBuf)));
            mode='audio'; sinceMeta=0;
          }
        }
      }
    }
  }catch(e){
    if(e.name!=='AbortError') n.icyStatus='metadata unavailable (CORS/network)';
  }finally{
    n.icyReading=false;
  }
}

def({ id:'stream', title:'Audio Stream (URL)', cat:'Sources',
  ins:[{n:'url',t:'txt'}],
  outs:[{n:'audio',t:'sig'},{n:'artist',t:'val'},{n:'title',t:'val'},{n:'trackChange',t:'val'}],
  readout:true,
  params:[
    {n:'url',t:'text',d:'https://ice1.somafm.com/groovesalad-128-mp3',label:'stream URL'},
    {n:'play',t:'button',label:'▶ Play',fn:n=>streamPlay(n)},
    {n:'stop',t:'button',label:'■ Stop',fn:n=>streamStop(n)},
    {n:'gain',t:'range',min:0,max:4,step:.01,d:1},
    {n:'auto',t:'check',d:true,label:'play when the URL input changes'},
    {n:'meta',t:'check',d:true,label:'track info (ICY, opens a second connection)',adv:true},
  ],
  init:n=>{
    n.audioEl=null; n.srcNode=null; n.tapNode=null; n.sink=null; n.ctxRef=null;
    n.connected=false; n.connecting=false; n.status='not connected';
    n.icyAbort=null; n.icyReading=false; n.icyRaw=null;
    n.icyArtist=''; n.icyTitle=''; n.icyStatus=''; n.trackPulse=0;
    streamResetRing(n);
  },
  dispose:n=>streamTeardown(n),
  process(n,I){
    if(typeof I.url==='string' && I.url && I.url!==n.p.url){
      n.p.url = I.url; if(n.set && n.set.url) n.set.url(I.url);
      if(n.p.auto) streamPlay(n);                    // новая станция с провода (например, выбор на карте)
    }
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    // AudioContext мог быть пересоздан движком (смена размера блока/частоты) — граф протух
    if(n.connected && n.ctxRef!==Eng.ctx){
      n.status='context recreated — press «Play» again';
      streamTeardown(n);
    }
    const trackChange = n.trackPulse>0?1:0; if(n.trackPulse>0) n.trackPulse--;
    const meta = {artist:n.icyArtist||'', title:n.icyTitle||'', trackChange};
    const o=buf(n,'audio'), ring=n.ring, g=n.p.gain;
    if(!n.connected || ring.filled<ring.size*0.2){ o.fill(0); return {audio:o, ...meta}; }
    let lag=ring.written-n.readCount;
    if(lag>ring.size*0.9){ const delta=lag-ring.size*0.5; n.readPos=(n.readPos+delta)%ring.size; n.readCount+=delta; lag=ring.written-n.readCount; }
    if(n.rebuffering){
      if(lag<ring.size*0.2){ o.fill(0); return {audio:o, ...meta}; }
      n.rebuffering=false;
    }
    if(lag<BLOCK){ n.rebuffering=true; o.fill(0); return {audio:o, ...meta}; }
    for(let i=0;i<BLOCK;i++){
      o[i]=ring.A[Math.floor(n.readPos)%ring.size]*g;
      n.readPos++; n.readCount++;
    }
    n.readPos%=ring.size;
    return {audio:o, ...meta};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = n.icyRaw ? (n.status+' | track: '+n.icyRaw) : n.status; }
});


/* ============================ ЗАХВАТ ВКЛАДКИ/ЭКРАНА (getDisplayMedia) ============================ */
// Chrome не даёт запросить только звук — getDisplayMedia всегда просит video:true, поэтому
// видеодорожку сразу останавливаем. Пользователю нужно отметить чекбокс "Поделиться звуком"
// в системном пикере, иначе аудиодорожки не будет вовсе. Тап в граф — тот же, что у 'stream'.

function dispTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.stream){ try{ n.stream.getTracks().forEach(t=>t.stop()); }catch(e){} n.stream=null; }
  if(n.tapNode){ try{ n.tapNode.port.onmessage=null; n.tapNode.disconnect(); }catch(e){} n.tapNode=null; }
  if(n.srcNode){ try{ n.srcNode.disconnect(); }catch(e){} n.srcNode=null; }
  if(n.sink){ try{ n.sink.disconnect(); }catch(e){} n.sink=null; }
}
function dispStop(n){ n.status='stopped'; dispTeardown(n); }
async function dispCapture(n){
  if(n.connecting) return;
  dispTeardown(n);
  n.connecting=true; n.status='choose a tab/screen…';
  try{
    if(!Eng.running) await Eng.start();
    else if(Eng.paused) await Eng.ctx.resume();
    const ctx = Eng.ctx;
    const stream = await navigator.mediaDevices.getDisplayMedia({video:true, audio:true});
    stream.getVideoTracks().forEach(t=>t.stop());     // видео не нужно — сразу освобождаем
    const atrack = stream.getAudioTracks()[0];
    if(!atrack){
      stream.getTracks().forEach(t=>t.stop());
      n.connecting=false; n.status='source has no audio — "Share audio" was not checked';
      return;
    }
    await streamRegisterWorklet(ctx);
    const srcNode = ctx.createMediaStreamSource(new MediaStream([atrack]));
    const tap = new AudioWorkletNode(ctx,'stream-tap',{numberOfInputs:1,numberOfOutputs:1,
      channelCount:1, channelCountMode:'explicit', channelInterpretation:'speakers'});
    tap.port.onmessage = e => streamPush(n, e.data);
    const sink = ctx.createGain(); sink.gain.value=0;
    srcNode.connect(tap); tap.connect(sink); sink.connect(ctx.destination);
    atrack.addEventListener('ended', ()=>{ n.status='capture stopped by source'; dispTeardown(n); });
    n.stream=stream; n.srcNode=srcNode; n.tapNode=tap; n.sink=sink; n.ctxRef=ctx;
    streamResetRing(n);
    n.connected=true; n.connecting=false; n.status='capturing';
  }catch(e){
    n.connecting=false; n.connected=false;
    n.status = e.name==='NotAllowedError' ? 'cancelled by user' : 'error: '+e.message;
    dispTeardown(n);
  }
}

def({ id:'dispaudio', title:'Capture Tab/Screen (Audio)', cat:'Sources',
  outs:[{n:'audio',t:'sig'}],
  readout:true,
  params:[
    {n:'go',t:'button',label:'▶ Capture',fn:n=>dispCapture(n)},
    {n:'stop',t:'button',label:'■ Stop',fn:n=>dispStop(n)},
    {n:'gain',t:'range',min:0,max:4,step:.01,d:1},
  ],
  init:n=>{
    n.stream=null; n.srcNode=null; n.tapNode=null; n.sink=null; n.ctxRef=null;
    n.connected=false; n.connecting=false; n.status='not captured';
    streamResetRing(n);
  },
  dispose:n=>dispTeardown(n),
  process(n,I){
    if(typeof I.gain==='number') setMod(n,'gain',I.gain);
    if(n.connected && n.ctxRef!==Eng.ctx){
      n.status='context recreated — capture again';
      dispTeardown(n);
    }
    const o=buf(n,'audio'), ring=n.ring, g=n.p.gain;
    if(!n.connected || ring.filled<ring.size*0.2){ o.fill(0); return {audio:o}; }
    let lag=ring.written-n.readCount;
    if(lag>ring.size*0.9){ const delta=lag-ring.size*0.5; n.readPos=(n.readPos+delta)%ring.size; n.readCount+=delta; lag=ring.written-n.readCount; }
    if(n.rebuffering){
      if(lag<ring.size*0.2){ o.fill(0); return {audio:o}; }
      n.rebuffering=false;
    }
    if(lag<BLOCK){ n.rebuffering=true; o.fill(0); return {audio:o}; }
    for(let i=0;i<BLOCK;i++){
      o[i]=ring.A[Math.floor(n.readPos)%ring.size]*g;
      n.readPos++; n.readCount++;
    }
    n.readPos%=ring.size;
    return {audio:o};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }
});



/* ============================================================
   Добавить в sources.js (рядом с другими узлами cat:'Источники').
   Используют глобальные def/buf/pv/setMod/clamp/biquadCoef/BLOCK/Eng —
   те же, что и остальные узлы файла, отдельно не объявляются.
   ============================================================ */

/* ---------- acid-бас (303-style) ---------- */
const ACID_MOD_KEYS=['accent','cutoff','reso','envAmt','decay','slide'];  // модулируемые извне параметры

def({ id:'acid', title:'Acid Bass (303)', cat:'Music',
  ins:[{n:'freq',t:'num'},{n:'gate',t:'sig'},
       {n:'accent',t:'num'},{n:'cutoff',t:'num'},{n:'reso',t:'num'},
       {n:'envAmt',t:'num'},{n:'decay',t:'num'},{n:'slide',t:'num'}],
  outs:[{n:'out',t:'sig'}], readout:true,
  params:[
    {n:'wave',t:'select',opts:['saw','square'],d:'saw'},
    {n:'freq',t:'range',min:20,max:2000,step:1,d:110,log:true,label:'freq'},
    {n:'cutoff',t:'range',min:100,max:8000,step:1,d:600,log:true,label:'cutoff'},
    {n:'reso',t:'range',min:0,max:.97,step:.01,d:.75,label:'resonance'},
    {n:'envAmt',t:'range',min:0,max:6000,step:10,d:2200,label:'envelope depth'},
    {n:'decay',t:'range',min:.02,max:1.5,step:.01,d:.2,log:true,label:'decay'},
    {n:'accent',t:'range',min:0,max:1,step:.01,d:0,label:'accent'},
    {n:'slide',t:'range',min:0,max:.3,step:.005,d:.06,label:'slide, s'}],
  init:n=>{ n.ph=0; n.f0=null; n.env=0; n.pv=0; n.z=[0,0,0,0]; },
  process(n,I){
    for(const k of ACID_MOD_KEYS) if(typeof I[k]==='number') setMod(n,k,I[k]);  // подхватить входы, если подключены
    const o=buf(n,'out'), p=n.p, sr=Eng.sr, g=I.gate;
    const fT=pv(n,I,'freq');
    if(n.f0==null) n.f0=fT;
    const slideK=p.slide>0.001?Math.exp(-1/(p.slide*sr)):0;
    const decK=Math.exp(-1/(p.decay*sr));
    let [x1,x2,y1,y2]=n.z;
    for(let i=0;i<BLOCK;i++){
      const gv=g?g[i]:0;
      if(gv>0 && n.pv<=0) n.env=1;                        // новый удар — огибающая заново вверх
      n.pv=gv; n.env*=decK;
      n.f0+=(fT-n.f0)*(1-slideK);                           // портаменто к целевой частоте
      const raw=p.wave==='saw'?(2*n.ph-1):(n.ph<.5?1:-1);
      n.ph=(n.ph+n.f0/sr)%1;
      const cutoff=clamp(p.cutoff+p.envAmt*n.env*(1+p.accent),60,sr*.45);
      const Q=0.5+p.reso*p.reso*18;
      const [b0,b1,b2,a1,a2]=biquadCoef('lp',cutoff,Q,sr);
      const x=raw*n.env*(1+p.accent*.6);
      const y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2;
      x2=x1; x1=x; y2=y1; y1=y;
      o[i]=Math.tanh(y*1.4)*.8; }
    n.z=[x1,x2,y1,y2];
    return {out:o}; },
  draw(n){ n.el.querySelector('.readout').textContent='env '+n.env.toFixed(2); }});


/* ---------- драм-секвенсор (техно) ---------- */
const DRUM_VOICES=[
  {key:'kick', label:'kick'},
  {key:'snare',label:'snare'},
  {key:'clap', label:'clap'},
  {key:'chh',  label:'chh'},
  {key:'ohh',  label:'ohh'},
  {key:'perc', label:'perc'}];

function drumDecode(s,rows){
  const g=new Uint8Array(rows*32);
  if(!s) return g;
  const lines=s.split(';');
  for(let r=0;r<Math.min(rows,lines.length);r++){
    const row=lines[r];
    for(let c=0;c<Math.min(32,row.length);c++) if(row[c]==='1') g[r*32+c]=1; }
  return g;
}
function drumEncode(g,rows){
  const lines=[];
  for(let r=0;r<rows;r++){ let s=''; for(let c=0;c<32;c++) s+=g[r*32+c]?'1':'0'; lines.push(s); }
  return lines.join(';');
}
// 4 банка паттернов, разделённые '|'. Старый однобанковый формат (без '|') читается как банк A.
function drumDecodeAll(s,rows){
  const parts=(s||'').split('|');
  const banks=[];
  for(let i=0;i<4;i++) banks.push(drumDecode(parts[i]||'',rows));
  return banks;
}
function drumEncodeAll(banks,rows){ return banks.map(g=>drumEncode(g,rows)).join('|'); }
function drumBankIdx(p){ return {A:0,B:1,C:2,D:3}[p.bank]||0; }
function drumGrid(n){ return n.banks[n.bankIdx??drumBankIdx(n.p)]; }
let DRUM_CLIPBOARD=null;                                       // буфер копипаста паттерна (не сохраняется в патч)

// голоса — простые синтезированные удары, состояние (фаза/фильтры) хранится в n по индексу голоса
function drumKick(n,t,p){
  if(t>0.5) return 0;
  const f=p.kickTune+(280-p.kickTune)*Math.exp(-t*55);    // питч-свип сверху вниз
  n.ph[0]=(n.ph[0]+f/Eng.sr)%1;
  return Math.sin(2*Math.PI*n.ph[0])*Math.exp(-t/p.kickDecay);
}
function drumSnare(n,t,p){
  if(t>0.3) return 0;
  n.ph[1]=(n.ph[1]+p.snareTone/Eng.sr)%1;
  const tone=Math.sin(2*Math.PI*n.ph[1]);
  const noise=Math.random()*2-1, y=noise-n.hp1[1]; n.hp1[1]=noise;
  return (tone*(1-p.snareNoise)+y*p.snareNoise)*Math.exp(-t/0.12);
}
function drumClap(n,t){
  if(t>0.25) return 0;
  const noise=Math.random()*2-1, y=noise-n.hp1[2]; n.hp1[2]=noise;
  const burst=Math.exp(-(t%0.03)*35);                     // повторяющиеся всплески — имитация хлопка
  const tail=t<0.1?1:Math.exp(-(t-0.1)*10);
  return y*burst*tail;
}
function drumHat(n,t,decay,slot){
  if(t>decay*4) return 0;
  const noise=Math.random()*2-1;
  const y1=noise-n.hp1[slot]; n.hp1[slot]=noise;
  const y2=y1-n.hp2[slot]; n.hp2[slot]=y1;                 // второе звено ВЧ-фильтра — резче срез
  return y2*Math.exp(-t/decay);
}
function drumPerc(n,t){
  if(t>0.3) return 0;
  const f=180*Math.exp(-t*15)+90;
  n.ph[5]=(n.ph[5]+f/Eng.sr)%1;
  return Math.sin(2*Math.PI*n.ph[5])*Math.exp(-t/0.15);
}

def({ id:'drumseq', lazy:'manual', title:'Drum Sequencer (Techno)', cat:'Music',
  ins:[{n:'clk',t:'sig'},{n:'bankSel',t:'num'}],
  outs:[{n:'out',t:'sig'},{n:'step',t:'num'}],
  view:{h:200}, resize:true, readout:true,
  params:[
    {n:'bank',t:'select',opts:['A','B','C','D'],d:'A',label:'bank'},
    {n:'steps',t:'range',min:4,max:32,step:1,d:16,label:'steps'},
    {n:'bpm',t:'range',min:60,max:200,step:1,d:130},
    {n:'div',t:'select',opts:['1/8','1/16','1/32'],d:'1/16'},
    {n:'swing',t:'range',min:0,max:.5,step:.01,d:0,label:'swing'},
    {n:'run',t:'check',d:true,label:'play'},
    {n:'kickTune',t:'range',min:30,max:120,step:1,d:55,label:'kick: tone'},
    {n:'kickDecay',t:'range',min:.05,max:.8,step:.01,d:.3,label:'kick: decay'},
    {n:'snareTone',t:'range',min:100,max:400,step:1,d:180,label:'snare: tone'},
    {n:'snareNoise',t:'range',min:0,max:1,step:.01,d:.6,label:'snare: noise'},
    {n:'hatDecayC',t:'range',min:.01,max:.15,step:.005,d:.05,label:'chh: decay'},
    {n:'hatDecayO',t:'range',min:.05,max:.6,step:.01,d:.25,label:'ohh: decay'},
    {n:'lvKick',t:'range',min:0,max:1.5,step:.01,d:1,label:'lvl kick'},
    {n:'lvSnare',t:'range',min:0,max:1.5,step:.01,d:.8,label:'lvl snare'},
    {n:'lvClap',t:'range',min:0,max:1.5,step:.01,d:.7,label:'lvl clap'},
    {n:'lvChh',t:'range',min:0,max:1.5,step:.01,d:.6,label:'lvl chh'},
    {n:'lvOhh',t:'range',min:0,max:1.5,step:.01,d:.6,label:'lvl ohh'},
    {n:'lvPerc',t:'range',min:0,max:1.5,step:.01,d:.5,label:'lvl perc'},
    {n:'copy',t:'button',label:'Copy',fn:n=>{ DRUM_CLIPBOARD=drumGrid(n).slice(); }},
    {n:'paste',t:'button',label:'Paste',fn:n=>{
      if(DRUM_CLIPBOARD){ drumGrid(n).set(DRUM_CLIPBOARD); n.p.grid=drumEncodeAll(n.banks,n.rows); } }},
    {n:'clear',t:'button',label:'Clear',fn:n=>{ drumGrid(n).fill(0); n.p.grid=drumEncodeAll(n.banks,n.rows); }}],
  init:n=>{
    n.rows=DRUM_VOICES.length;
    n.banks=drumDecodeAll(n.p.grid,n.rows); n.p.grid=drumEncodeAll(n.banks,n.rows);
    n.bankIdx=drumBankIdx(n.p);
    n.idx=-1; n.samplesLeft=0; n.stepLen=0;
    n.age=new Float32Array(n.rows).fill(1e9);
    n.ph=new Float32Array(n.rows);
    n.hp1=new Float32Array(n.rows); n.hp2=new Float32Array(n.rows);
    n.paint=null; },
  process(n,I){
    n._synced=!!I.clk;
    n._bankSelLive=typeof I.bankSel==='number';
    n.bankIdx = n._bankSelLive ? clamp(Math.round(I.bankSel),0,3) : drumBankIdx(n.p);
    const o=buf(n,'out'), p=n.p, steps=p.steps|0, g=drumGrid(n);
    const div={'1/8':2,'1/16':4,'1/32':8}[p.div]||4;
    const ownStepLen=Math.round(Eng.sr*60/p.bpm/div);
    const lv=[p.lvKick,p.lvSnare,p.lvClap,p.lvChh,p.lvOhh,p.lvPerc];
    const dt=1/Eng.sr;
    for(let i=0;i<BLOCK;i++){
      if(!p.run){ o[i]=0; continue; }
      // свинг — только на своём таймере: при внешнем клоке тайминг целиком задаёт он
      let stepNow;
      if(n._synced) stepNow=seqTick(n,I,i,ownStepLen);
      else{
        stepNow=n.samplesLeft<=0;
        if(stepNow){ const swingOff=(((n.idx+1)%steps)%2)?Math.round(ownStepLen*p.swing):0;
          n.stepLen=ownStepLen; n.samplesLeft=ownStepLen+swingOff; } }
      if(stepNow){
        n.idx=(n.idx+1)%steps;
        for(let v=0;v<n.rows;v++) if(g[v*32+n.idx]){ n.age[v]=0; n.ph[v]=0; } }
      let s=0;
      s+=drumKick(n,n.age[0],p)*lv[0];
      s+=drumSnare(n,n.age[1],p)*lv[1];
      s+=drumClap(n,n.age[2])*lv[2];
      s+=drumHat(n,n.age[3],p.hatDecayC,3)*lv[3];
      s+=drumHat(n,n.age[4],p.hatDecayO,4)*lv[4];
      s+=drumPerc(n,n.age[5])*lv[5];
      for(let v=0;v<n.rows;v++) n.age[v]+=dt;
      o[i]=clamp(s*0.9,-1.5,1.5);
      if(!n._synced) n.samplesLeft--; }
    redrawIf(n,n.idx+'|'+n.bankIdx+'|'+n._synced+'|'+n._bankSelLive);
    return {out:o, step:n.idx}; },
  draw(n){
    const cv=n.cv, cx=n.cx; if(!cv) return;
    const TABH=14;                                                // полоса вкладок банков сверху
    if(!n._wired){
      n._wired=true;
      // r.width/height — экранные (домноженные на зум графа), TABH и число шагов — логические;
      // переводим курсор в логику канвы сразу. clientX/Y-rect.left/top, а не offsetX/Y — офсеты
      // в части браузеров не учитывают CSS-scale графа так же, как getBoundingClientRect().
      const toLocal=ev=>{ const r=cv.getBoundingClientRect();
        return [(ev.clientX-r.left)/r.width*cv.width, (ev.clientY-r.top)/r.height*cv.height]; };
      cv.addEventListener('pointerdown',ev=>{
        ev.stopPropagation();
        const [px,py]=toLocal(ev);
        if(py<TABH){                                              // клик по вкладке — переключить банк
          const tw=cv.width/4, bi=clamp(Math.floor(px/tw),0,3);
          n.p.bank='ABCD'[bi]; return; }
        const steps=n.p.steps|0, cw=cv.width/steps, rh=(cv.height-TABH)/n.rows;
        const col=clamp(Math.floor(px/cw),0,steps-1);
        const row=clamp(Math.floor((py-TABH)/rh),0,n.rows-1);
        const g=drumGrid(n), cell=row*32+col;
        const val=g[cell]?0:1;                                    // была пуста — рисуем, была полна — стираем
        g[cell]=val; n.paint={val,last:cell};
        cv.setPointerCapture(ev.pointerId);
        n.p.grid=drumEncodeAll(n.banks,n.rows); });
      cv.addEventListener('pointermove',ev=>{
        if(!n.paint) return;
        ev.stopPropagation();
        const [px,py]=toLocal(ev);
        if(py<TABH) return;
        const steps=n.p.steps|0, cw=cv.width/steps, rh=(cv.height-TABH)/n.rows;
        const col=clamp(Math.floor(px/cw),0,steps-1);
        const row=clamp(Math.floor((py-TABH)/rh),0,n.rows-1);
        const cell=row*32+col; if(cell===n.paint.last) return;
        drumGrid(n)[cell]=n.paint.val; n.paint.last=cell;
        n.p.grid=drumEncodeAll(n.banks,n.rows); });
      const endPaint=()=>{ n.paint=null; };
      cv.addEventListener('pointerup',endPaint);
      cv.addEventListener('pointercancel',endPaint); }
    const W=cv.width, H=cv.height, steps=n.p.steps|0, cw=W/steps, gh=H-TABH, rh=gh/n.rows;
    cx.clearRect(0,0,W,H);
    const bi=n.bankIdx, bw=W/4;                                     // вкладки банков
    for(let b=0;b<4;b++){
      cx.fillStyle = b===bi ? 'rgba(138,180,248,.35)' : 'rgba(255,255,255,.05)';
      cx.fillRect(b*bw,0,bw-1,TABH-1);
      cx.font='9px monospace'; cx.fillStyle = b===bi ? themeColor('--t-img') : themeColor('--axis');
      cx.fillText('ABCD'[b],b*bw+bw/2-3,TABH-4); }
    if(n._bankSelLive){ cx.fillStyle='rgba(224,178,60,.8)'; cx.fillRect(0,TABH-2,W,2); }  // банк задаётся song-узлом
    cx.save(); cx.translate(0,TABH);
    cx.fillStyle='rgba(255,255,255,.04)';
    for(let c=0;c<steps;c+=4) cx.fillRect(c*cw,0,cw,gh);           // подсветка долей — каждый 4-й шаг
    cx.strokeStyle='rgba(255,255,255,.08)'; cx.lineWidth=1;
    for(let c=0;c<=steps;c++){ cx.beginPath(); cx.moveTo(c*cw+.5,0); cx.lineTo(c*cw+.5,gh); cx.stroke(); }
    for(let r=0;r<=n.rows;r++){ cx.beginPath(); cx.moveTo(0,r*rh+.5); cx.lineTo(W,r*rh+.5); cx.stroke(); }
    cx.fillStyle=themeColor('--t-img');
    const g=drumGrid(n);
    for(let r=0;r<n.rows;r++) for(let c=0;c<steps;c++) if(g[r*32+c])
      cx.fillRect(c*cw+1,r*rh+1,cw-2,rh-2);
    if(n.idx>=0){ cx.fillStyle='rgba(224,178,60,.2)'; cx.fillRect(n.idx*cw,0,cw,gh); }
    cx.font='9px monospace'; cx.fillStyle=themeColor('--axis');
    for(let r=0;r<n.rows;r++) cx.fillText(DRUM_VOICES[r].label,3,r*rh+rh-3);
    cx.restore();
    n.el.querySelector('.readout').textContent=
      'bank '+'ABCD'[n.bankIdx]+(n._bankSelLive?' (auto)':'')+' · step '+Math.max(n.idx,0)+'/'+steps+
      ' · '+(n._synced?'ext. clock':n.p.bpm+' BPM'); }});
def({ id:'imgsrc', lazy:'manual', title:'Image (file/URL)', cat:'Sources', outs:[{n:'img',t:'img'}],
  params:[
    {n:'url',t:'text',d:'',label:'URL'},
    {n:'load',t:'button',label:'Load URL',fn:n=>{
      if(!n.p.url) return; n.status='loading…'; n.imgEl.src=n.p.url; }},
    {n:'file',t:'file',accept:'image/*',fn:(n,f)=>{ n.status='loading…'; n.imgEl.src=URL.createObjectURL(f); }},
    {n:'w',t:'select',opts:['80','160','320','640','960','1280'],d:'320'},
  ],
  init(n){
    n.imgEl=document.createElement('img'); n.imgEl.crossOrigin='anonymous';
    n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
    n.img=null; n.status='no source'; n.wCache=null;
    n.imgEl.onerror=()=>{ n.status='load error'; };
    n.imgEl.onload=()=>{ n.wCache=null; captureImgSrc(n); };
  },
  view:{h:100}, readout:true,
  drawKey:n=>n.status+'|'+n.img?.rev,
  process(n){                                       // W можно сменить и после загрузки — перезахватим при первом же тике
    if(n.imgEl.complete && n.imgEl.naturalWidth && n.wCache!==n.p.w) captureImgSrc(n);
    return {img:n.img}; },
  draw(n,cv,cx){
    const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status;
    if(n.img) cx.drawImage(n.capCv,0,0,cv.width,cv.height); }});

function captureImgSrc(n){                          // картинка статична — захватываем один раз (не на каждый кадр, как vidsrc)
  const W=+n.p.w, H=Math.round(W*(n.imgEl.naturalHeight/n.imgEl.naturalWidth||3/4));
  n.wCache=n.p.w;
  n.capCv.width=W; n.capCv.height=H;
  n.capCx.drawImage(n.imgEl,0,0,W,H);
  try{ n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false,rev:(n.img?.rev|0)+1}; n.status='loaded'; }
  catch(e){ n.img=null; n.status='cross-origin without CORS — frame unreadable'; }
}
