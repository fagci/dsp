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
const SRATE_OPTS=['auto','8000','16000','22050','44100','48000','96000'];
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

def({ id:'file', title:'Audio File', cat:'Sources',
  outs:[{n:'out',t:'sig'},{n:'pos',t:'num'},{n:'done',t:'num'}],
  ins:[{n:'seek',t:'num'},{n:'rate',t:'num'},{n:'gain',t:'num'},{n:'loop',t:'num'}], view:{h:44}, resize:true, readout:true,
  params:[{n:'file',t:'file',accept:'audio/*',fn:(n,f)=>{
            n.name=f.name;
            const fr=new FileReader();
            fr.onload=()=>{
              const ac=Eng.ctx||new (window.AudioContext||window.webkitAudioContext)();
              ac.decodeAudioData(fr.result).then(b=>{
                n.data=b.getChannelData(0); n.srcSr=b.sampleRate; n.pos=0; n.play=true; }); };
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
    if(!n.play){ o.fill(0); return {out:o,pos:n.pos/d.length,done:0}; }
    for(let i=0;i<BLOCK;i++){
      if(n.pos>=d.length-1){
        if(n.p.loop) n.pos=0; else { n.play=false; done=1; o[i]=0; continue; } }
      const i0=n.pos|0, fr=n.pos-i0;
      o[i]=(d[i0]*(1-fr)+d[i0+1]*fr)*g; n.pos+=r; }
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
    cx.strokeStyle='#e0b23c'; cx.lineWidth=2;
    cx.beginPath(); cx.moveTo(px,0); cx.lineTo(px,H); cx.stroke(); cx.lineWidth=1;
    const sr=n.srcSr||Eng.sr, t=n.pos/sr, tot=n.data.length/sr;
    n.el.querySelector('.readout').textContent =
      (n.name||'file')+' · '+t.toFixed(1)+' / '+tot.toFixed(1)+' s'+(n.play?'':' · paused'); }});


def({ id:'accel', title:'Accelerometer', cat:'Sources',
  outs:[{n:'x',t:'num'},{n:'y',t:'num'},{n:'z',t:'num'}],
  params:[{n:'on',t:'button',label:'Allow sensor',fn:async n=>{
    if(window.DeviceMotionEvent?.requestPermission) await DeviceMotionEvent.requestPermission();
    window.addEventListener('devicemotion',e=>{ const a=e.accelerationIncludingGravity||{};
      n.v=[a.x||0,a.y||0,a.z||0]; }); }}],
  init:n=>{n.v=[0,0,0];},
  process(n){ return {x:n.v[0],y:n.v[1],z:n.v[2]}; }});


// Generic Sensor API — отдельный от 'accel' набор классов (Accelerometer/Gyroscope/...),
// не пересекается с DeviceMotionEvent. Требует HTTPS и в основном работает только в
// Chrome/Edge на Android — Firefox и Safari эти классы не реализуют вовсе.
const GSENSOR_DEFS = {
  'Accelerometer':      {opts:{frequency:60}, fields:['x','y','z']},
  'Gyroscope':           {opts:{frequency:60}, fields:['x','y','z']},
  'Magnetometer':        {opts:{frequency:60}, fields:['x','y','z']},
  'AmbientLightSensor':  {opts:{}, fields:['illuminance']},
};
function gsensorFields(n){ return (GSENSOR_DEFS[n.p.type]||GSENSOR_DEFS.Accelerometer).fields; }
function gsensorStop(n){
  if(n.sensor){ try{ n.sensor.stop(); }catch(e){} n.sensor=null; }
  n.status='stopped';
}
function gsensorStart(n){
  gsensorStop(n);
  const Cls = window[n.p.type];
  if(!Cls){ n.status='API unavailable (needs Chrome/Edge on Android, or HTTPS)'; return; }
  const def = GSENSOR_DEFS[n.p.type]||GSENSOR_DEFS.Accelerometer;
  try{
    const s = new Cls(def.opts);
    s.addEventListener('reading', ()=>{ n.v = def.fields.map(f=>s[f]??0); n.status='reading'; });
    s.addEventListener('error', e=>{ n.status='error: '+(e.error?.message||e.error?.name||'?'); });
    s.start();
    n.sensor=s; n.status='starting…';
  }catch(e){
    n.status = e.name==='SecurityError' ? 'sensor permission denied' : 'error: '+e.message;
  }
}
def({ id:'gsensor', title:'Sensor (Generic Sensor API)', cat:'Sources',
  outs: n => gsensorFields(n).map(f=>({n:f,t:'num'})),
  readout:true,
  params:[
    {n:'type',t:'select',opts:Object.keys(GSENSOR_DEFS),d:'Accelerometer',
      fn:n=>{ gsensorStop(n); n.v=[0,0,0]; n.initialized=false; rebuildNode(n); markTopoDirty(); }},
    {n:'go',t:'button',label:'Start',fn:n=>gsensorStart(n)},
    {n:'stop',t:'button',label:'Stop',fn:n=>gsensorStop(n)},
  ],
  init:n=>{ n.sensor=null; n.status='not started'; n.v=[0,0,0]; },
  dispose:n=>gsensorStop(n),
  process(n){
    const fields=gsensorFields(n), out={};
    fields.forEach((f,i)=>out[f]=n.v[i]??0);
    return out;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }});


def({ id:'cam', title:'Camera', cat:'Sources', outs:[{n:'img',t:'img'},{n:'bright',t:'num'}],
  ins:[{n:'roiX',t:'num'},{n:'roiY',t:'num'},{n:'roiW',t:'num'},{n:'roiH',t:'num'}],
  params:[{n:'on',t:'button',label:'Turn on camera',fn:async n=>{
            n.video.srcObject?.getTracks?.().forEach(t=>t.stop());
            const s=await navigator.mediaDevices.getUserMedia({video:{width:320,height:240,
              facingMode:n.p.cam==='rear'?{ideal:'environment'}:'user'}});
            n.video.srcObject=s; n.video.play(); }},
          {n:'cam',t:'select',opts:['front','rear'],d:'rear'},
          {n:'w',t:'select',opts:['80','160','320'],d:'160'},
          {n:'roi',t:'check',d:false,label:'brightness zone'},
          {n:'roiX',t:'range',min:0,max:1,step:.01,d:.35,label:'zone: x'},
          {n:'roiY',t:'range',min:0,max:1,step:.01,d:.35,label:'zone: y'},
          {n:'roiW',t:'range',min:.02,max:1,step:.01,d:.3,label:'zone: width'},
          {n:'roiH',t:'range',min:.02,max:1,step:.01,d:.3,label:'zone: height'},
          {n:'roiAuto',t:'check',d:true,label:'zone: auto-contrast'}],
  init(n){ n.video=document.createElement('video'); n.video.playsInline=true; n.video.muted=true;
           n.capCv=document.createElement('canvas'); n.capCx=n.capCv.getContext('2d',{willReadFrequently:true});
           n.brMn=0; n.brMx=1; n.bright=0; },
  dispose:n=>{ n.video?.srcObject?.getTracks?.().forEach(t=>t.stop()); n.video.srcObject=null; },
  view:{h:100}, always:true,
  process(n,I){
    for(const k of ['roiX','roiY','roiW','roiH']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    return {img:n.img||null, bright:n.bright}; },
  draw(n,cv,cx){
    if(!n.video?.videoWidth) return;
    const W=+n.p.w, H=Math.round(W*3/4);
    if(n.capCv.width!==W){ n.capCv.width=W; n.capCv.height=H; }
    n.capCx.drawImage(n.video,0,0,W,H);
    n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false};
    if(n.p.roi){                                    // яркость зоны — переехало сюда из отдельного узла "bright"
      const {w,h}=n.img, px=n.img.data.data;
      const x0=Math.round(n.p.roiX*w), y0=Math.round(n.p.roiY*h);
      const x1=Math.min(w,x0+Math.round(n.p.roiW*w)), y1=Math.min(h,y0+Math.round(n.p.roiH*h));
      let s=0,c=0;
      for(let y=y0;y<y1;y+=2) for(let x=x0;x<x1;x+=2){
        s+=(px[(y*w+x)*4]*.299+px[(y*w+x)*4+1]*.587+px[(y*w+x)*4+2]*.114)/255; c++; }
      let v=c?s/c:0;
      if(n.p.roiAuto){                              // скользящие min/max для контраста, как было в "bright"
        n.brMx=v>n.brMx?v:n.brMx*.999+v*.001;
        n.brMn=v<n.brMn?v:n.brMn*.999+v*.001;
        const d=Math.max(.02,n.brMx-n.brMn); v=clamp((v-n.brMn)/d,0,1); }
      n.bright=v; }
    cx.drawImage(n.capCv,0,0,cv.width,cv.height);
    if(n.p.roi){                                    // рамка зоны прямо на превью — вместо отдельного узла
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
    if(n.capCv.width!==W||n.capCv.height!==H){ n.capCv.width=W; n.capCv.height=H; }
    n.capCx.drawImage(n.video,0,0,W,H);
    try{ n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false}; }
    catch(e){ n.status='cross-origin video without CORS — frame unreadable'; }
    cx.drawImage(n.capCv,0,0,cv.width,cv.height); }});





def({ id:'const', title:'Constant', cat:'Control', outs:[{n:'out',t:'num'}],
  ins:[{n:'v',t:'num'}],
  params:[{n:'v',t:'range',min:-100,max:100,step:.1,d:1}],
  process(n,I){ if(typeof I.v==='number') setMod(n,'v',I.v); return {out:n.p.v}; }});


def({ id:'lfo', title:'LFO', cat:'Control', outs:[{n:'out',t:'num'}],
  ins:[{n:'freq',t:'num'}],
  params:[{n:'freq',t:'range',min:.01,max:20,step:.01,d:.5},
          {n:'min',t:'num',d:0},{n:'max',t:'num',d:1},
          {n:'wave',t:'select',opts:['sine','tri','saw','sq'],d:'sine'}],
  init:n=>{n.ph=0;},
  process(n,I){ if(typeof I.freq==='number') setMod(n,'freq',I.freq);
    const ph=n.ph;
    const v = n.p.wave==='sine'? .5+.5*Math.sin(2*Math.PI*ph)
            : n.p.wave==='tri' ? 1-Math.abs(2*ph-1)
            : n.p.wave==='saw' ? ph : (ph<.5?1:0);
    n.ph=(ph+n.p.freq*BLOCK/Eng.sr)%1;
    return {out:n.p.min+(n.p.max-n.p.min)*v}; }});


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

def({ id:'textsrc', title:'Text Source', cat:'Control',
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

def({ id:'webserial', title:'Serial Port (WebSerial)', cat:'Control',
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


// Строка от 'webserial' приходит целиком в одном пине (txt) — этот узел режет её по
// запятым и раскладывает по именованным пинам (val), чтобы с числами можно было работать
// как с обычными выходами графа. Разбирает csvParse'ом одну "строку-таблицу" за раз.
function csvlineFields(n){
  return String(n.p.names||'value').split(',').map(s=>s.trim()||'value');
}
def({ id:'csvline', title:'Parse CSV Line', cat:'Control',
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
def({ id:'linefilter', title:'Line Filter (regexp)', cat:'Control',
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

// тюнер R820T/R828D: регистры, PLL, gain. i2cAddr: 0x34 у R820T, 0x74 у R828D (Blog V4)
function rtlMakeR820T(com, xtalFreq, i2cAddr){
  i2cAddr = i2cAddr || 0x34;
  const REGISTERS=[0x83,0x32,0x75,0xc0,0x40,0xd6,0x6c,0xf5,0x63,0x75,0x68,0x6c,0x83,0x80,0x00,0x0f,0x00,0xc0,0x30,0x48,0xcc,0x60,0x00,0x54,0xae,0x4a,0xc0];
  const MUX_CFGS=[[0,0x08,0x02,0xdf],[50,0x08,0x02,0xbe],[55,0x08,0x02,0x8b],[60,0x08,0x02,0x7b],[65,0x08,0x02,0x69],[70,0x08,0x02,0x58],[75,0x00,0x02,0x44],[90,0x00,0x02,0x34],[110,0x00,0x02,0x24],[140,0x00,0x02,0x14],[180,0x00,0x02,0x13],[250,0x00,0x02,0x11],[280,0x00,0x02,0x00],[310,0x00,0x41,0x00],[588,0x00,0x40,0x00]];
  const BIT_REVS=[0x0,0x8,0x4,0xc,0x2,0xa,0x6,0xe,0x1,0x9,0x5,0xd,0x3,0xb,0x7,0xf];
  let hasPllLock=false, shadow, curBand=null;
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
    let divNum=Math.min(6,Math.floor(Math.log(1770000000/freq)/Math.LN2));
    const arr=await readRegBuffer(0x00,5);
    const vcoFineTune=(arr[4]&0x30)>>4;
    if(vcoFineTune>vcoPowerRef) divNum--; else if(vcoFineTune<vcoPowerRef) divNum++;
    await writeRegMask(0x10, divNum<<5, 0xe0);
    const mixDiv=1<<(divNum+1), vcoFreq=freq*mixDiv;
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
  async function init(){ await initRegisters(REGISTERS); await initElectronics(); }
  // rfFreq — истинная целевая RF-частота (без добавленного IF), нужна только для выбора входа/нотчей у R828D
  async function setFrequency(freq, rfFreq){
    const rf=rfFreq!=null?rfFreq:freq;
    // Blog V4: аппаратный апконвертер +28.8МГц для КВ (0-28.8МГц) — тюнер физически не
    // настраивается так низко напрямую. Реальную частоту гетеродина сдвигаем вверх, а вход
    // триплексера (setV4Input ниже) всё равно выбираем по ИСХОДНОЙ, не сдвинутой частоте —
    // так его определяет сам чип. Сдвиг считаем от xtalFreq (с учётом ppm), не от круглой
    // константы — так делает и официальный драйвер (dev->tun_xtal).
    const upconvert=(isR828D && rf<=28.8e6) ? xtalFreq : 0;
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
    if(isR828D) await setV4Input(rf);
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
    await writeRegMask(0x05, band===2?0x40:0x00, 0x40); // cable1 — вход VHF
    await writeRegMask(0x05, band===3?0x00:0x20, 0x20); // air — вход UHF
  }
  async function setAutoGain(){ await writeEach([[0x05,0x00,0x10],[0x07,0x10,0x10],[0x0c,0x0b,0x9f]]); }
  async function setManualGain(gain){
    let step = gain<=15
      ? Math.round(1.36+gain*(1.1118+gain*(-0.0786+gain*0.0027)))
      : Math.round(1.2068+gain*(0.6875+gain*(-0.01011+gain*0.0001587)));
    step=Math.max(0,Math.min(30,step));
    await writeEach([[0x05,0x10,0x10],[0x07,0x00,0x10],[0x0c,0x08,0x9f],
      [0x05,Math.floor(step/2),0x0f],[0x07,Math.floor((step-1)/2),0x0f]]);
  }
  async function close(){
    await writeEach([[0x06,0xb1,0xff],[0x05,0xb3,0xff],[0x07,0x3a,0xff],[0x08,0x40,0xff],[0x09,0xc0,0xff],
      [0x0a,0x36,0xff],[0x0c,0x35,0xff],[0x0f,0x68,0xff],[0x11,0x03,0xff],[0x17,0xf4,0xff],[0x19,0x0c,0xff]]);
  }
  return {init, setFrequency, setAutoGain, setManualGain, close};
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
  const tuner=rtlMakeR820T(com, xtalFreq, found.addr);
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
  async function setCenterFrequency(freq){
    await com.i2c.open();
    const actual=await tuner.setFrequency(freq+IF, freq);
    await com.i2c.close();
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
  async function close(){
    await com.i2c.open(); await tuner.close(); await com.i2c.close();
    await com.iface.release();
    await dev.close();
  }
  return {setSampleRate, setCenterFrequency, setGain, resetBuffer, readSamples, close, tunerName:found.name};
}

// ---- узел графа: источник IQ ----

// Во сколько раз воркер прореживает поток (decim ПОСЛЕ канального фильтра chA — см. RTL_WORKER_SRC)
// — используется на главном потоке, чтобы правильно посчитать размер аудио-кольца канала и шаг
// его чтения (сам воркер об этом не сообщает, поэтому формула ЗДЕСЬ ДОЛЖНА ТОЧНО СОВПАДАТЬ с decim
// внутри RTL_WORKER_SRC). demod/bw общие на все 4 канала (не per-канальные параметры, см.
// комментарий у 'demod' в params ниже) — поэтому decim тоже один на узел, а не на канал.
function rtlDecimFor(mode, sr, bwAudio){
  const chanBw=({WFM:200000,NFM:12500,AM:10000})[mode] || bwAudio;
  return Math.max(1, Math.floor(sr/Math.max(chanBw*4, 8000)));
}
// (Пере)создаёт аудио-кольцо одного канала под ТЕКУЩИЙ n.decim — вызывается при первой
// активации канала и при каждой смене decim на лету (demod/bw/sourceRate), иначе кольцо
// остаётся размером под старую децимацию и гистерезис (проценты от size) снова начинает
// значить не те доли секунды, для которых он посчитан — та же болезнь, которую decim лечит.
function rtlResizeChannelRing(n, ch){
  const asize=Math.max(50000, Math.round(n.ring.size/n.decim));
  ch.aring={A:new Float32Array(asize), size:asize, w:0, filled:0, written:0};
  // rebuffering=true с самого начала — свежее кольцо пусто, и это ровно то же состояние, что и
  // после настоящего провала в середине игры (см. rtlReadChannelAudio): пусть тот же самый,
  // уже отлаженный механизм "молчим, пока не накопится безопасный запас" сработает и на самом
  // первом чтении, без отдельного частного случая специально под старт.
  ch.readPos=0; ch.readCount=0; ch.rebuffering=true;
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
  const SPEC_SIZE=1<<16; // с запасом на любой выбранный размер БПФ; пишется независимо от режима демодуляции
  n.specRing={I:new Float32Array(SPEC_SIZE), Q:new Float32Array(SPEC_SIZE), size:SPEC_SIZE, w:0, filled:0};
  n.spec=null; n.specFreqs=null; n.lastSpec=0;
  // аудио-кольца каналов живут на децимированной частоте (sourceRate/decim), а не sourceRate —
  // без этого при большой децимации (узкий NFM на высоком sourceRate) кольцо размером "под 2с
  // сырого потока" реально наполнялось бы эти же 2с×decim секунд, и звук не появлялся бы минутами.
  n.decim=rtlDecimFor(n.p.demod, n.sourceRate, n.p.bw);
  // аудио-кольца УЖЕ АКТИВНЫХ каналов пересоздаём под новый размер — сами воркеры не трогаем,
  // их переконфигурирует hardKey-проверка в process() на следующем тике (sourceRate там учтён)
  for(const ch of n.ch) if(ch.active) rtlResizeChannelRing(n, ch);
}

// Исходник воркера демодуляции — тяжёлая математика (канальный фильтр + atan2-дискриминатор)
// уходит в отдельный поток, чтобы не конкурировать за главный поток с async-циклом чтения USB
// и остальным движком/UI. Тот же приём Blob+createObjectURL, что и у AudioWorklet в core-engine.js.
const RTL_WORKER_SRC = `
let mode='WFM', sr=1024000, bwAudio=15000, deemphTau=null, devScale=75000, chanBw=200000;
// Дискриминатор/audio-фильтры считаются не на КАЖДЫЙ сырой IQ-отсчёт, а после decim (после
// канального ФНЧ chA ниже — тот уже ограничивает полосу, так что алиасинга от прореживания нет).
let decim=1, decimCounter=1;
// Раньше здесь была ещё многоступенчатая "дешёвая" предедецимация (до 3 ступеней треугольного
// FIR перед chA) — идея была снизить число отсчётов, которые видит дорогой 3-полюсный chA.
// Реальный бенчмарк (rtl_worker_bench.js в scratchpad) на настоящем коде воркера показал обратное:
// эти ступени ВЕЗДЕ медленнее, чем просто отдать chA все сырые отсчёты — и на WFM (3.2Msps: 42мс→
// 28мс без них), и на NFM/AM/SSB (в 1.5-2 раза быстрее без них на всех проверенных sourceRate).
// Скорее всего дело не в арифметике самих ступеней (она дешёвая), а в branch-per-sample (continue
// внутри цикла) — JIT явно не любит такой паттерн. Убраны целиком, decim делает всю децимацию сам.
let cI0=0,cI1=0,cI2=0, cQ0=0,cQ1=0,cQ2=0, prevI=0,prevQ=0, lp0=0,lp1=0,lp2=0,lp3=0,lp4=0,de=0,ampDc=0,audDc=0;
// Notch на 19кГц (пилот-тон стерео WFM) — узкополосный биквад поверх дискриминатора, ДО
// lp0..lp4 (те режут по bwAudio, у пользователя может доходить до 16кГц — вплотную к пилоту,
// и одних лишь 5 полюсов там мало, см. wfm_pilot_check.js: суппрессия пилота от них ~21дБ,
// а с добавленным notch — глубокая яма ровно на 19кГц и НОЛЬ влияния на 15-18кГц звука).
// pnOn включается только для WFM (см. applyConfig) — в NFM/AM/SSB пилота нет и notch не нужен.
let pnOn=false, pnB1=0, pnA1=0, pnA2=0, pnX1=0, pnX2=0, pnY1=0, pnY2=0;
// Доп. ФНЧ на фиксированных 21кГц (4 полюса, НЕ завязан на bwAudio) — сам notch бьёт точно
// в пилот (19кГц), но стерео-поднесущая (23-53кГц, DSB-SC с программным звуком, а не чистый
// тон) — широкая полоса, notch её не берёт. Без этого фильтра суппрессия на границе поднесущей
// (23кГц) — единицы+десятки дБ, мало для реального эфира: остаток после грубой линейной
// интерполяции в rtlReadChannelAudio звучит как "хрип"/рассинхрон, коррелирующий с программой
// (см. wfm_pilot_check.js: +12-25дБ в полосе 21-53кГц). Фиксированный, а не от bwAudio — иначе
// пользователь, подняв полосу звука, снова терял бы этот запас.
let fcOn=false, fcA=0, fc0=0, fc1=0, fc2=0, fc3=0;
// Общий NCO "частоты настройки": сдвигает выбранную внутри захваченной полосы точку
// (offsetHz относительно центра тюнера) на 0 Гц ДО канального фильтра — так демодулируется
// сигнал в любом месте полосы обзора без физической перестройки тюнера (без USB round-trip).
let offsetHz=0, offCos=1, offSin=0, offPhI=1, offPhQ=0;
// NCO для выделения боковой полосы (SSB), накладывается ПОСЛЕ общего сдвига — прежняя логика.
let ssbPhI=1, ssbPhQ=0, ssbCos=1, ssbSin=0;
// DC-блок сырых I/Q, срез 150 Гц — гасит LO-паразит гетеродина. Раньше применялся только
// для SSB; теперь общий сдвиг (offset) может увести паразит с 0 Гц в слышимую область для
// ЛЮБОГО режима, поэтому блокируем DC всегда, до всех сдвигов.
let rawI0=0, rawQ0=0;
let bufPool=[]; // буферы результата, отданные обратно главным потоком после использования — переиспользуем

function applyConfig(msg){
mode=msg.mode; sr=msg.sr; bwAudio=msg.bw;
const tauMap={'75':75e-6,'50':50e-6,'off':null};
deemphTau = mode==='WFM' ? tauMap[msg.deemph] : null;
devScale = mode==='WFM'?75000:(mode==='NFM'?5000:1);
// для USB/LSB нет записи в карте — попадаем в фолбэк и берём полосу канала равной аудио-полосе
chanBw = ({WFM:200000,NFM:12500,AM:10000})[mode] || bwAudio;
// decim — во сколько раз прореживаем ПОСЛЕ канального фильтра chA (тот работает на полной sr —
// см. комментарий у объявления decim выше про снятые preStages). ФОРМУЛА ДОЛЖНА СОВПАДАТЬ с
// rtlDecimFor() на главном потоке — та по ней же считает размер аудио-кольца и шаг чтения.
decim = Math.max(1, Math.floor(sr/Math.max(chanBw*4, 8000)));
pnOn = mode==='WFM';
if(pnOn){
  const outRateCfg=sr/decim, w0=2*Math.PI*19000/outRateCfg, r=Math.exp(-2*Math.PI*150/outRateCfg);
  pnB1=-2*Math.cos(w0); pnA1=-2*r*Math.cos(w0); pnA2=r*r;
}
fcOn = mode==='WFM';
if(fcOn){ const outRateCfg=sr/decim; fcA=Math.exp(-2*Math.PI*21000/outRateCfg); }
// сдвиг NCO — половина полосы канала. USB сдвигаем вниз, LSB вверх (см. вывод у цикла ниже)
const ssbDir = mode==='USB' ? -1 : (mode==='LSB' ? 1 : 0);
const ssbInc = 2*Math.PI*(chanBw/2)*ssbDir/sr;
ssbCos=Math.cos(ssbInc); ssbSin=Math.sin(ssbInc);
applyOffset(offsetHz); // sr мог смениться — приращение общего NCO пересчитать под новую sr
}
function applyOffset(hz){
offsetHz=hz;
// Точно 0 — самый частый случай (один канал ровно в центре полосы): схлопываем фазор к
// единице, а не просто останавливаем вращение. Без этого при возврате с ненулевого офсета
// обратно в 0 фазор застревал бы там, где оказался, и молча крутил бы сигнал остаточным
// поворотом вечно — вращение остановится, но накопленный сдвиг не уйдёт. А раз при hz===0
// фазор гарантированно единичный, весь NCO-поворот в цикле ниже можно просто пропускать
// (см. offZero) — экономит комплексное умножение+обновление фазы на КАЖДОМ сыром отсчёте,
// а это самая частая ситуация (один канал, без offset-подстройки внутри полосы).
if(hz===0){ offPhI=1; offPhQ=0; }
const inc=-2*Math.PI*hz/sr; // минус — переносим выбранную частоту настройки на 0 (даунконверсия)
offCos=Math.cos(inc); offSin=Math.sin(inc);
}

self.onmessage = function(e){
const msg=e.data;
if(msg.type==='config'){ applyConfig(msg); return; }
if(msg.type==='offset'){ applyOffset(msg.hz); return; } // лёгкое обновление — без сброса фильтров/фазы
if(msg.type==='reset'){ cI0=cI1=cI2=cQ0=cQ1=cQ2=prevI=prevQ=lp0=lp1=lp2=lp3=lp4=de=ampDc=audDc=0; ssbPhI=1; ssbPhQ=0; offPhI=1; offPhQ=0; rawI0=0; rawQ0=0; decimCounter=1; pnX1=pnX2=pnY1=pnY2=0; fc0=fc1=fc2=fc3=0; return; }
if(msg.type==='giveBuffer'){ bufPool.push(msg.buffer); return; } // главный поток вернул буфер — кладём в пул
if(msg.type!=='demod') return;
const tStart=performance.now();  // время ВНУТРИ воркера, не round-trip с главным потоком (см. workerMs ниже)
const u8=new Uint8Array(msg.buffer), cnt=msg.cnt;
// maxOut с запасом +2 на перенос фазы decim между чанками
const maxOut=Math.floor(cnt/decim)+2;
// берём буфер из пула (вернули с прошлого раза), и только если пусто или размер не совпал — аллоцируем
let outAB=null;
while(bufPool.length){ const b=bufPool.pop(); if(b.byteLength===maxOut*4){ outAB=b; break; } }
const out=outAB ? new Float32Array(outAB) : new Float32Array(maxOut);
const outRate=sr/decim;                             // дорогая часть ниже считается на этой частоте
const lpA=Math.exp(-2*Math.PI*bwAudio/outRate), lpA1=1-lpA; // настоящий ФНЧ на bwAudio
const hpA=Math.exp(-2*Math.PI*20/outRate), hpA1=1-hpA; // DC-блок аудио, фикс. 20 Гц
const rawA=Math.exp(-2*Math.PI*150/sr), rawA1=1-rawA; // сырой DC-блок — на полной частоте, до децимации
const deA=deemphTau ? Math.exp(-1/(deemphTau*outRate)) : null, deA1=deA!=null?1-deA:0;
const chA=Math.exp(-2*Math.PI*(chanBw/2)/sr), chA1=1-chA; // канальный ФНЧ — на полной sr (без preStages)
const discScale=outRate/(2*Math.PI)/devScale, isAM=mode==='AM', isSSB=(mode==='USB'||mode==='LSB');
// offZero — самый частый случай (один канал ровно в центре полосы, без offset-подстройки):
// фазор гарантированно единичный (см. applyOffset), поворот НИЧЕГО не меняет — пропускаем его
// целиком. Комплексное умножение+обновление+ренормализация фазы — это ~16 операций на КАЖДЫЙ
// сырой отсчёт, а на высоком sourceRate (напр. 3.2Msps) именно эта "всегда включённая" часть
// оказалась самой тяжёлой статьёй расхода воркера — тяжелее канального фильтра chA.
const offZero = offsetHz===0;
let wIdx=0;
for(let k=0;k<cnt;k++){
const rawI=(u8[2*k]-127.5)/127.5, rawQ=(u8[2*k+1]-127.5)/127.5;
// DC-блок сырых I/Q — всегда, до любых сдвигов (паразит неподвижен на 0 Гц захваченной полосы)
rawI0=rawI0*rawA+rawI*rawA1; rawQ0=rawQ0*rawA+rawQ*rawA1;
let i=rawI-rawI0, q=rawQ-rawQ0;
// общий сдвиг NCO на выбранную внутри полосы частоту настройки (offsetHz)
if(!offZero){
const oPI=offPhI, oPQ=offPhQ;
const oi=i*oPI-q*oPQ, oq=i*oPQ+q*oPI;
i=oi; q=oq;
const nOPI=oPI*offCos-oPQ*offSin, nOPQ=oPI*offSin+oPQ*offCos;
const oNrm=1.5-0.5*(nOPI*nOPI+nOPQ*nOPQ);
offPhI=nOPI*oNrm; offPhQ=nOPQ*oNrm;
}
let pI=1, pQ=0; // фазор SSB-сдвига этого сэмпла, нужен ниже для обратного вращения
if(isSSB){
// умножаем на фазор NCO — сдвигаем спектр так, чтобы нужная боковая оказалась вокруг нуля.
// Симметричный ФНЧ не различает знак частоты сам по себе, поэтому без этого сдвига
// USB и LSB были неразличимы — обе боковые проходили одинаково.
pI=ssbPhI; pQ=ssbPhQ;
const si=i*pI-q*pQ, sq=i*pQ+q*pI;
i=si; q=sq;
const nPhI=pI*ssbCos-pQ*ssbSin, nPhQ=pI*ssbSin+pQ*ssbCos;
const nrm=1.5-0.5*(nPhI*nPhI+nPhQ*nPhQ); // дешёвая ренормализация вместо sqrt, держит |ph|≈1
ssbPhI=nPhI*nrm; ssbPhQ=nPhQ*nrm;
}
cI0=cI0*chA+i*chA1; cQ0=cQ0*chA+q*chA1;
cI1=cI1*chA+cI0*chA1; cQ1=cQ1*chA+cQ0*chA1;
cI2=cI2*chA+cI1*chA1; cQ2=cQ2*chA+cQ1*chA1;
// Канальный фильтр выше уже ограничил полосу — дальше можно смело прореживать: дискриминатор
// и все audio-фильтры (дорогая часть — atan2/sqrt на каждый отсчёт) считаются не на каждый
// сырой сэмпл, а раз в decim сэмплов, на уже отфильтрованном cI2/cQ2.
if(--decimCounter<=0){
decimCounter=decim;
let v;
if(isSSB){
// зеркальная боковая уже подавлена фильтром выше — но сам сигнал всё ещё сдвинут по
// частоте. Крутим отфильтрованный сигнал обратно (умножаем на сопряжённый фазор pI,-pQ),
// иначе весь звук едет по высоте тона на величину сдвига (а не только несущая).
v=(cI2*pI+cQ2*pQ)*3;
} else if(isAM){
const env=Math.sqrt(cI2*cI2+cQ2*cQ2);
ampDc+=(env-ampDc)*0.0005;
v=(env-ampDc)*3;
} else {
// re/im — разность фаз между ЭТИМ и ПРЕДЫДУЩИМ ДЕЦИМИРОВАННЫМ отсчётом (шаг по времени —
// decim/sr, отсюда discScale считается от outRate=sr/decim, а не от sr)
const re=cI2*prevI+cQ2*prevQ, im=cQ2*prevI-cI2*prevQ;
v=Math.atan2(im,re)*discScale;
prevI=cI2; prevQ=cQ2;
if(pnOn){                            // notch на 19кГц — см. объявление pnOn/pnX../pnY.. выше
  const y=v+pnB1*pnX1+pnX2-pnA1*pnY1-pnA2*pnY2;
  pnX2=pnX1; pnX1=v; pnY2=pnY1; pnY1=y; v=y;
}
if(fcOn){                            // доп. ФНЧ 21кГц/4 полюса — см. объявление fcOn/fcA.. выше
  fc0=fc0*fcA+v*(1-fcA); fc1=fc1*fcA+fc0*(1-fcA);
  fc2=fc2*fcA+fc1*(1-fcA); fc3=fc3*fcA+fc2*(1-fcA);
  v=fc3;
}
}
audDc=audDc*hpA+v*hpA1;
const hp=v-audDc;
// Пять каскадных полюсов режут по bwAudio (обычно 15кГц), но их реальная суппрессия пилота
// (19кГц) сильно зависит от outRate: при decim=1 (типично для WFM на sourceRate~1МГц — см.
// rtlDecimFor) outRate остаётся ~1МГц, и те же
// 5 полюсов дают там лишь ~21дБ вместо ожидаемых ~55дБ (при outRate ближе к 48-96кГц) — пилот
// и поднесущая (23-53кГц) слышны как "трещащий" шум, меняющийся вместе со звуком, именно в
// этом случае. Поэтому отдельно — notch ровно на 19кГц под пилот и доп. ФНЧ на фиксированных
// 21кГц под поднесущую (pnOn/fcOn выше, применяются до этого каскада), не зависящие от bwAudio.
lp0=lp0*lpA+hp*lpA1;
lp1=lp1*lpA+lp0*lpA1;
lp2=lp2*lpA+lp1*lpA1;
lp3=lp3*lpA+lp2*lpA1;
lp4=lp4*lpA+lp3*lpA1;
let outv=lp4;
if(deA!=null){ de=de*deA+outv*deA1; outv=de; }
out[wIdx++]=outv;
}
}
// workerMs — ЧЕСТНОЕ время именно этого цикла внутри воркера, отдельно от round-trip'а через
// главный поток (postMessage/структурное клонирование/ожидание в очереди сообщений) — тот
// round-trip меряет readerLoop сам (wms=tDemodDone-t1), и эти два числа могут сильно разойтись,
// если тормозит не сама математика, а именно доставка сообщений.
self.postMessage({type:'result', id:msg.id, buffer:out.buffer, cnt:wIdx, workerMs:performance.now()-tStart}, [out.buffer]);
};
`;

function rtlMakeDemodWorker(){
  const url=URL.createObjectURL(new Blob([RTL_WORKER_SRC], {type:'application/javascript'}));
  const worker=new Worker(url);
  let nextId=1;
  const pending=new Map(); // несколько параллельных читателей USB могут ждать ответа одновременно
  worker.onmessage=(e)=>{
    const msg=e.data;
    if(msg.type==='result' && pending.has(msg.id)){
      const resolve=pending.get(msg.id); pending.delete(msg.id);
      // buffer — сырой ArrayBuffer (вызывающий сам решает, когда вернуть его через giveBuffer());
      // cnt — сколько АУДИО-отсчётов в нём реально лежит после децимации внутри воркера (может
      // быть заметно меньше числа входных IQ-отсчётов, см. decim в RTL_WORKER_SRC);
      // workerMs — честное время именно вычислений внутри воркера, см. комментарий там же
      resolve({buffer:msg.buffer, cnt:msg.cnt, workerMs:msg.workerMs});
    }
  };
  return {
    config(cfg){ worker.postMessage({type:'config', ...cfg}); },
    reset(){ worker.postMessage({type:'reset'}); },
    setOffset(hz){ worker.postMessage({type:'offset', hz}); }, // дешёвая перестройка частоты настройки — без сброса фильтров/фазы
    demod(u8buffer, cnt){                 // buffer передаётся с переносом владения (zero-copy)
      return new Promise((resolve)=>{
        const id=nextId++;
        pending.set(id, resolve);
        worker.postMessage({type:'demod', id, buffer:u8buffer, cnt}, [u8buffer]);
      });
    },
    giveBuffer(buffer){ worker.postMessage({type:'giveBuffer', buffer}, [buffer]); }, // вернуть буфер воркеру для переиспользования
    terminate(){ worker.terminate(); URL.revokeObjectURL(url); }
  };
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
  ch.worker.config({mode:n.p.demod, sr:n.sourceRate, bw:n.p.bw, deemph:n.p.deemph});
  ch.worker.reset();
  ch.hardKey=n.p.demod+'|'+n.sourceRate; ch.softKey=n.p.bw+'|'+n.p.deemph;
  n.decim=rtlDecimFor(n.p.demod, n.sourceRate, n.p.bw);
  rtlResizeChannelRing(n, ch);
  ch.appliedOffset=0;
  ch.active=true;
}

// Вынесены на уровень модуля — rtlReadIQ/rtlReadChannelAudio согласуют свой запас буфера
// с тем же порогом, что и backpressure на входе (раньше это были две несвязанные константы).
const RTL_MAX_INFLIGHT=6;
const RTL_READS_PER_SEC=20;
// Запас на восстановление после провала, в секундах реального времени (не в "блоках движка",
// как было раньше — то не зависело от sourceRate и потому не лечилось подъёмом Msps). 0.5с, а не
// MAX_INFLIGHT/READS_PER_SEC(=0.3с) — по логам видно, что провалы кольца случаются не от одного
// длинного стопора, а от ПАЧКИ мелких (десятки мс каждый) подряд за доли секунды — 0.3с недостаточно.
const RTL_REBUF_S = 0.5;

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

  // Два параллельных читателя USB имеют смысл, только когда узкое место — само чтение USB
  // (см. IQ-режим ниже: там нет воркера вообще, тянуть данные непрерывно реально важно). Как
  // только на пути есть демод-воркер, всё наоборот: воркер один (на канал), однопоточный, и
  // если он не успевает за sourceRate (см. n.workerMs в статусе), то ВТОРОЙ читатель не даёт
  // никакой дополнительной пропускной способности — он просто вдвое чаще подкидывает чанки в
  // уже переполненную очередь одного и того же воркера. Хуже того: с 2 читателями чанк до
  // воркера в среднем доезжает вдвое чаще (период ~chunkPeriod/2), поэтому воркер, который
  // укладывается в chunkPeriod, но не в chunkPeriod/2, стабильно не успевает именно из-за
  // этого удвоения частоты — не из-за нехватки CPU как таковой. Поэтому читатель для демод-режимов
  // один, а не два — этим удвоением и объясняется.
  // Частоту чтения (READS_PER_SEC), впрочем, срезали тогда же заодно — крупные редкие чтения
  // (100мс вместо 50мс) снижали число диспетчеризаций, но каждый отдельный срыв (пауза GC,
  // всплеск нагрузки) стал длиннее и заметнее на слух: то же суммарное время потерь, но
  // распределённое в более редкие и крупные затыки вместо частых мелких. Теперь, когда воркер
  // сам стал заметно дешевле (многоступенчатая децимация выше — дорогой канальный фильтр видит
  // на порядки меньше отсчётов), возвращаем частые мелкие чтения, оставляя ОДНОГО читателя —
  // так получаем и запас по CPU, и мелкую (менее заметную) гранулярность возможных затыков разом.
  const isIQ=n.p.demod==='IQ';
  const READS_PER_SEC=RTL_READS_PER_SEC;
  const READERS=isIQ?2:1;

  // Порядок данных не теряется: bulk-эндпоинт USB FIFO по своей природе — какой бы читатель
  // ни забрал следующий чанк, это всегда хронологически следующий кусок потока.
  let prevReadEnd=null;   // для диагностики: разрыв ДО чтения = главный поток был занят чем-то другим
  async function readerLoop(){
    // Конвейер чтения: следующий readSamples() запускается СРАЗУ по получении текущего чанка, ДО
    // его обработки (specRing/диспетчеризация в demod) — а не после, как было раньше. При строго
    // последовательном await'е время нашей же JS-обработки (тот самый specRing-цикл и т.п.) добавлялось
    // поверх времени самого USB-трансфера на КАЖДОМ цикле — по логам это давало систематический
    // (не от подвисаний, монотонный) снос запаса кольца на ~0.85%: реальный устойчивый темп чтения
    // оказывался чуть ниже sourceRate именно из-за этой лишней последовательной задержки. Конвейер
    // даёт транспорту крутиться, пока мы заняты обработкой предыдущего чанка, вместо того чтобы
    // ждать нас, а потом нас же ждать снова. Состояние — локальное для КАЖДОГО вызова readerLoop()
    // (а не общее): при READERS=2 (см. ниже, режим IQ) их два одновременно, каждый со своим
    // независимым конвейером — общее состояние свело бы их к одному читателю, ломая параллельность.
    let pendingRead=null, pendingKickT=0;
    function kickRead(){
      const chunkSamples=Math.max(512, Math.min(131072, 512*Math.ceil(n.sourceRate/READS_PER_SEC/512)));
      pendingKickT=performance.now();
      pendingRead=n.dev.readSamples(chunkSamples*2).then(buf=>({buf}), err=>({err}));
    }
    kickRead();
    while(n.reading && n.dev){
      const t0=performance.now();
      // Гэп ДО получения буфера (а не время самого чтения, см. ioMs) — если он большой, значит
      // между предыдущей итерацией и этой главный поток был занят чем-то посторонним (GC, другой
      // код), а не самим RTL-путём. Порог — половина номинального периода чтения.
      if(prevReadEnd!=null){
        const gap=t0-prevReadEnd, nominalMs=1000/READS_PER_SEC;
        if(gap>nominalMs*1.5) console.warn(`[rtlsdr] gap перед USB-чтением ${gap.toFixed(1)}ms (ожидалось ~${nominalMs.toFixed(0)}ms) @ ${t0.toFixed(0)}ms`);
      }
      const kickT=pendingKickT;
      const res=await pendingRead;
      if(res.err){
        errStreak++;
        n.status='read error ('+errStreak+'/5): '+res.err.message;
        if(errStreak>=5){ n.reading=false; break; }
        try{ await n.dev.resetBuffer(); }catch(e2){}
        await new Promise(r=>setTimeout(r,50));
        kickRead();   // старое чтение уже провалилось — конвейер надо перезапустить, не оставлять пустым
        continue;
      }
      errStreak=0;
      const buf=res.buf, t1=performance.now();
      // ioMs — честная длительность ИМЕННО USB-трансфера (от kickT, не от t0 — t0 может быть
      // позже, если предыдущая обработка заняла время, конвейер это и прячет), не round-trip
      // с учётом ожидания на нашей стороне.
      prevReadEnd=t1;   // см. gap-проверку в начале итерации выше
      kickRead();        // следующий трансфер — сразу, не дожидаясь обработки текущего буфера ниже
      const u8=new Uint8Array(buf), cnt=u8.length>>1, mode=n.p.demod, specRing=n.specRing;
      // Циклический индекс — сравнение+обнуление, а не % на каждый отсчёт: при типичных chunkSamples
      // (десятки тысяч на USB-чтение, READS_PER_SEC раз в секунду) деление в modulo было заметной
      // главно-поточной нагрузкой ровно там, где конкурирует с чтением USB/сообщениями демод-воркеру.
      { let w=specRing.w, filled=specRing.filled; const I=specRing.I, Q=specRing.Q, size=specRing.size;
        for(let k=0;k<cnt;k++){
          I[w]=(u8[2*k]-127.5)/127.5; Q[w]=(u8[2*k+1]-127.5)/127.5;
          w++; if(w>=size) w=0;
          if(filled<size) filled++;
        }
        specRing.w=w; specRing.filled=filled; }
      if(mode==='IQ'){
        const ring=n.ring;
        { let w=ring.w, filled=ring.filled; const I=ring.I, Q=ring.Q, size=ring.size;
          for(let k=0;k<cnt;k++){
            I[w]=(u8[2*k]-127.5)/127.5; Q[w]=(u8[2*k+1]-127.5)/127.5;
            w++; if(w>=size) w=0;
            if(filled<size) filled++;
          }
          ring.w=w; ring.filled=filled; }
        ring.written+=cnt;
        rtlTrackMsps(n, cnt, t1-kickT, 0);
        continue;
      }
      // раздаём чанк всем активным каналам параллельно — каждому своя копия (владение буфером
      // передаётся воркеру с переносом, один и тот же ArrayBuffer нельзя transfer'ить дважды)
      const active=n.ch.filter(ch=>ch.active&&ch.worker);
      if(!active.length){ rtlTrackMsps(n, cnt, t1-kickT, 0); continue; }
      if(inFlight>=MAX_INFLIGHT){
        // демод не поспевает за реальным временем (см. комментарий выше про MAX_INFLIGHT) —
        // этот чанк в воркер не идёт, вместо него в кольцо каждого канала честно дописывается
        // тишина ТОЙ ЖЕ длины, что дал бы демод — round(cnt/n.decim) децимированных отсчётов,
        // а не cnt сырых, иначе written разойдётся с реальным временем ровно так же, как раньше
        // расходился на паузе чтения (см. rtlDecimFor).
        const silentN=Math.max(1, Math.round(cnt/(n.decim||1)));
        for(const ch of active){
          const aring=ch.aring; if(!aring) continue;
          const A=aring.A, size=aring.size; let w=aring.w, filled=aring.filled;
          for(let k=0;k<silentN;k++){ A[w]=0; w=(w+1)%size; if(filled<size) filled++; }
          aring.w=w; aring.filled=filled; aring.written+=silentN;
        }
        n.underrunsWorker++;   // демод-воркер не успел — вход, не выход (см. readout)
        console.warn(`[rtlsdr] demod backpressure (inFlight=${inFlight}>=${MAX_INFLIGHT}) @ ${t1.toFixed(0)}ms`);
        rtlTrackMsps(n, cnt, t1-kickT, 0);
        continue;
      }
      // .slice() нужен только чтобы дать КАЖДОМУ каналу свою копию (один ArrayBuffer нельзя
      // transfer'ить дважды) — последнему каналу отдаём оригинал без копии: он и так последний
      // потребитель buf/u8 в этой итерации (при активном канале ровно 1 — самый частый случай —
      // это убирает лишнюю ~100КБ-аллокацию на каждый чанк, то есть на каждые ~50мс, целиком).
      const lastIdx=active.length-1;
      const demodPromise=Promise.all(active.map((ch,i)=>
        ch.worker.demod(i===lastIdx ? buf : u8.slice().buffer, cnt)));
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
          const audio=new Float32Array(res.buffer, 0, outN);
          const aring=ch.aring;
          let w=aring.w, filled=aring.filled;
          const A=aring.A, size=aring.size;
          for(let k=0;k<outN;k++){ A[w]=audio[k]; w=(w+1)%size; if(filled<size) filled++; }
          aring.w=w; aring.filled=filled; aring.written+=outN;
          ch.worker.giveBuffer(res.buffer);
        }
        // сглаживаем — на глаз, не для точных измерений; резкий разовый выброс не должен дёргать цифру в статусе
        n.workerMs = n.workerMs==null ? workerMsMax : n.workerMs*0.8+workerMsMax*0.2;
        n.roundtripMs = n.roundtripMs==null ? wms : n.roundtripMs*0.8+wms*0.2;
        rtlTrackMsps(n, cnt, t1-kickT, wms);
      });
    }
  }

  await Promise.all(Array.from({length:READERS}, readerLoop));
  n.connected=false;
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
let winCache={kind:null,N:0,w:null};
let reBuf=null, imBuf=null, bufN=0; // re/im — внутренние, никуда не отправляются, переиспользование безопасно
self.onmessage=function(e){
  const msg=e.data;
  if(msg.type!=='fft') return;
  const N=msg.N, kind=msg.win;
  if(!winCache.w || winCache.kind!==kind || winCache.N!==N) winCache={kind,N,w:window_(kind,N)};
  if(!reBuf || bufN!==N){ reBuf=new Float32Array(N); imBuf=new Float32Array(N); bufN=N; }
  const w=winCache.w, I=new Float32Array(msg.I), Q=new Float32Array(msg.Q);
  const re=reBuf, im=imBuf;
  for(let i=0;i<N;i++){ re[i]=I[i]*w[i]; im[i]=Q[i]*w[i]; }
  fft(re,im);
  // mag НЕ переиспользуем (в отличие от demod-воркера): n.spec может читаться потребителем
  // (узел sa) несколько тактов подряд, пока не придёт следующий расчёт — если отдать этот же
  // буфер воркеру раньше времени, следующий расчёт молча перезапишет память ещё читаемого спектра.
  const mag=new Float32Array(N);
  const half=N>>1;
  for(let i=0;i<N;i++){ const src=(i+half)%N; mag[i]=Math.hypot(re[src],im[src])/N; }
  // I/Q, в отличие от mag, дальше никому не нужны — отдаём буферы обратно главному потоку, чтобы
  // rtlUpdateSpec не аллоцировал два новых Float32Array(N) на каждый расчёт (~12 раз/с, лишний
  // источник мусора на главном потоке, см. takeBuffers ниже).
  self.postMessage({type:'result', mag:mag.buffer, I:I.buffer, Q:Q.buffer}, [mag.buffer, I.buffer, Q.buffer]);
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
      resolve(new Float32Array(e.data.mag));
    }
  };
  return {
    // буферы нужного размера из пула (или null, если пул пуст/размер сменился, напр. specSize) —
    // вызывающий сам решает, аллоцировать ли в этом случае свежие
    takeBuffers(N){
      while(bufPool.length){ const b=bufPool.pop(); if(b.I.byteLength===N*4) return b; }
      return null;
    },
    compute(iBuf, qBuf, N, win){
      return new Promise((resolve)=>{
        pendingResolve=resolve;
        worker.postMessage({type:'fft', I:iBuf, Q:qBuf, N, win}, [iBuf, qBuf]);
      });
    },
    terminate(){ worker.terminate(); URL.revokeObjectURL(url); }
  };
}

// снэпшот спектра сырого IQ: fftshift, ось частот вокруг центра настройки.
// Расчёт — асинхронно в отдельном воркере (не блокирует ни главный поток, ни цикл чтения USB).
// process() синхронный по контракту движка — просто заказывает расчёт и отдаёт n.spec, какой есть
// (на один тик может быть чуть устаревшим — это лучше, чем тормозить главный поток БПФ на 16384).
function rtlUpdateSpec(n){
  if(!n.connected || !n.specWorker) return;
  const now=performance.now();
  if(n.specBusy || (n.spec && now-n.lastSpec<80)) return;
  const N=+n.p.specSize, ring=n.specRing;
  if(ring.filled<N) return;
  const start=(ring.w-N+ring.size)%ring.size;
  const reuse=n.specWorker.takeBuffers(N);
  const I=reuse?new Float32Array(reuse.I):new Float32Array(N), Q=reuse?new Float32Array(reuse.Q):new Float32Array(N);
  // .set() из непрерывных (максимум двух, на стыке кольца) подмассивов вместо ручного цикла
  // с делением по модулю на КАЖДЫЙ отсчёт — при specSize вроде 32768 это заметная главная-поточная
  // работа на каждый снимок спектра (раз в ~80мс), а TypedArray.set — оптимизированный memmove.
  const first=Math.min(N, ring.size-start);
  I.set(ring.I.subarray(start,start+first)); Q.set(ring.Q.subarray(start,start+first));
  if(first<N){ I.set(ring.I.subarray(0,N-first),first); Q.set(ring.Q.subarray(0,N-first),first); }
  let sumI=0, sumQ=0;
  for(let i=0;i<N;i++){ sumI+=I[i]; sumQ+=Q[i]; }
  // DC-спайк в центре спектра — не сигнал, а самосмешение гетеродина на нулевую ПЧ, типичная
  // болячка RTL2832U (zero-IF архитектура), см. то же самое в gqrx/SDR++ ("DC removal"/"correct IQ").
  // Вычитаем среднее блока — это ТОЧНО зануляет центральный бин БПФ (он и есть эта самая сумма/N),
  // персистентный фильтр (как rawI0/rawQ0 в демод-воркере) тут не нужен: смещение почти константа
  // между блоками, а прямое среднее убирает его сразу, без времени на сходимость IIR. Всегда
  // включено — переключатель убрали, отключать его незачем (спайк — не сигнал ни при каких условиях).
  const mI=sumI/N, mQ=sumQ/N;
  for(let i=0;i<N;i++){ I[i]-=mI; Q[i]-=mQ; }
  n.specBusy=true;
  const centerFreq=n.actualFreq??n.p.freq, binHz=n.sourceRate/N, half=N>>1, win=n.p.specWin;
  n.specWorker.compute(I.buffer, Q.buffer, N, win).then(mag=>{
    n.specBusy=false;
    if(!n.specFreqs || n.specFreqs.length!==N || n.specFreqsCenter!==centerFreq || n.specFreqsSr!==n.sourceRate){
      const fr=new Float32Array(N);
      for(let i=0;i<N;i++) fr[i]=centerFreq+(i-half)*binHz;
      n.specFreqs=fr; n.specFreqsCenter=centerFreq; n.specFreqsSr=n.sourceRate;
    }
    n.spec={mag, sr:n.sourceRate, size:N, freqs:n.specFreqs,
            rev:(n.specRev=(n.specRev|0)+1)};
    n.lastSpec=performance.now();
  }).catch(()=>{ n.specBusy=false; });
}

// подстраховка от протухшего сохранённого значения (например, оставшегося '250000' из старой
// версии узла, когда этот вариант ещё был в списке) — вместо падения setSampleRate() в ошибку
// и полной тишины молча откатываемся на безопасный дефолт.
function rtlSafeSr(v){
  const n=+v;
  return (isFinite(n) && n>450000) ? n : 1024000;
}

// чтение сырого широкополосного IQ (режим demod==='IQ') с интерполяцией под Eng.sr — состояние
// чтения (readPos/readCount/rebuffering) отдельное от каналов демодуляции, у них своё кольцо
function rtlReadIQ(n, oi, oq){
  const ring=n.ring;
  if(!n.connected){ oi.fill(0); oq.fill(0); return; }
  const step=n.sourceRate/Eng.sr, need=step*BLOCK;
  // rebufTarget — RTL_REBUF_S секунд реального времени, не доля от ring.size (кольцо огромное
  // специально про запас на затыки USB, не как желаемая задержка старта/восстановления).
  const rebufTarget = Math.max(need, n.sourceRate*RTL_REBUF_S);
  // честная (несворачиваемая) проверка — ring.written и n.ringReadCount растут монотонно
  // и никогда не оборачиваются, в отличие от круговых индексов w/readPos.
  let lag=ring.written-n.ringReadCount;
  if(lag>ring.size*0.9){
    // consumer (Eng.tick) надолго отстал от продюсера — кольцо почти заполнилось, догоняем
    // прыжком вперёд (роняем старые сэмплы), а не читаем их с опозданием
    const delta=lag-ring.size*0.5;
    n.ringReadPos=(n.ringReadPos+delta)%ring.size; n.ringReadCount+=delta; n.underrunsOverflow++;
    console.warn(`[rtlsdr] IQ ring overflow, dropped ${delta.toFixed(0)} samples @ ${performance.now().toFixed(0)}ms`);
    lag=ring.written-n.ringReadCount;
  }
  if(n.ringRebuffering){
    if(lag<rebufTarget){ oi.fill(0); oq.fill(0); return; }
    n.ringRebuffering=false;
  }
  if(lag<need){ n.ringRebuffering=true; n.underrunsStarve++; oi.fill(0); oq.fill(0);
    console.warn(`[rtlsdr] IQ ring starve, lag=${lag.toFixed(0)} need=${need.toFixed(0)} @ ${performance.now().toFixed(0)}ms`);
    return; } // producer не успел — кольцо пусто, тишина
  for(let k=0;k<BLOCK;k++){
    const p0=Math.floor(n.ringReadPos)%ring.size, p1=(p0+1)%ring.size, fr=n.ringReadPos-Math.floor(n.ringReadPos);
    oi[k]=ring.I[p0]*(1-fr)+ring.I[p1]*fr;
    oq[k]=ring.Q[p0]*(1-fr)+ring.Q[p1]*fr;
    n.ringReadPos+=step; n.ringReadCount+=step;
  }
  n.ringReadPos%=ring.size;
}

// то же самое, но для одного демодулированного аудио-канала (у каждого канала своё кольцо
// и своё состояние чтения — читаются независимо друг от друга и от сырого IQ)
function rtlReadChannelAudio(n, ch, o){
  if(!n.connected || !ch.active || !ch.aring){ o.fill(0); return; }
  // кольцо хранит уже децимированный воркером звук (см. n.decim/rtlDecimFor), не сырые IQ-отсчёты —
  // шаг чтения считаем от реальной частоты содержимого кольца, а не от sourceRate приёмника.
  const ring=ch.aring, step=(n.sourceRate/(n.decim||1))/Eng.sr, need=step*BLOCK;
  let lag=ring.written-ch.readCount;
  // Тренд запаса кольца раз в ~3с — независимо от того, был ли провал: чтобы отличить резкий
  // провал (см. дальше) от медленного, монотонного сноса (реальная скорость USB чуть ниже
  // номинального sourceRate, и т.п.) — по одним только событиями провала это не видно, они
  // просто говорят "кончилось", а не "как долго и как быстро кончалось". mspsIo — для сверки:
  // если он стабильно ниже sourceRate/1e6, это прямое подтверждение нехватки реальной скорости.
  const nowLog=performance.now();
  if(!ch.lastLagLogT || nowLog-ch.lastLagLogT>3000){
    ch.lastLagLogT=nowLog;
    const targetForLog=Math.max(need, (n.sourceRate/(n.decim||1))*RTL_REBUF_S);
    console.log(`[rtlsdr] ring trend: lag=${lag.toFixed(0)}/${targetForLog.toFixed(0)} (${(100*lag/targetForLog).toFixed(0)}%) mspsIo=${(n.mspsIo||0).toFixed(3)} nominal=${(n.sourceRate/1e6).toFixed(3)} @ ${nowLog.toFixed(0)}ms`);
  }
  if(lag>ring.size*0.9){
    // consumer (Eng.tick) надолго отстал от продюсера — кольцо почти заполнилось, догоняем
    // прыжком вперёд (роняем старые сэмплы), а не читаем их с опозданием
    const delta=lag-ring.size*0.5;
    ch.readPos=(ch.readPos+delta)%ring.size; ch.readCount+=delta; n.underrunsOverflow++;
    console.warn(`[rtlsdr] audio ring overflow, dropped ${delta.toFixed(0)} samples @ ${performance.now().toFixed(0)}ms`);
    lag=ring.written-ch.readCount;
  }
  // гистерезис вместо порога впритык: однажды провалившись, не возвращаемся к воспроизведению
  // по первому же блоку, где данных ровно хватило — иначе на границе "впритык" получается
  // частое мигание тишина/звук вместо редких, но нормальных провалов. rebufTarget —
  // RTL_REBUF_S секунд реального времени (не "need*8" — то не зависело от sourceRate/decim,
  // поэтому подъём Msps не лечил провалы). rebuffering изначально true — см. rtlResizeChannelRing.
  const rebufTarget = Math.max(need, (n.sourceRate/(n.decim||1))*RTL_REBUF_S);
  if(ch.rebuffering){
    if(lag<rebufTarget){ o.fill(0); return; }
    ch.rebuffering=false;
  }
  if(lag<need){ ch.rebuffering=true; n.underrunsStarve++; o.fill(0);
    console.warn(`[rtlsdr] audio ring starve, lag=${lag.toFixed(0)} need=${need.toFixed(0)} @ ${performance.now().toFixed(0)}ms`);
    return; } // producer (демод) не успел — кольцо пусто, тишина
  for(let k=0;k<BLOCK;k++){
    const p0=Math.floor(ch.readPos)%ring.size, p1=(p0+1)%ring.size, fr=ch.readPos-Math.floor(ch.readPos);
    o[k]=ring.A[p0]*(1-fr)+ring.A[p1]*fr;
    ch.readPos+=step; ch.readCount+=step;
  }
  ch.readPos%=ring.size;
}

async function rtlConnect(n){
  if(!navigator.usb){ n.status='WebUSB unavailable (needs Chrome/Edge/Opera)'; return; }
  if(n.connected) return;
  try{
    const usbDev=await navigator.usb.requestDevice({filters:[{vendorId:0x0bda,productId:0x2832},{vendorId:0x0bda,productId:0x2838}]});
    const gain=n.p.auto?null:n.p.gainDb;
    n.dev=await rtlOpenDevice(usbDev, 0, gain);
    const srSafe=rtlSafeSr(n.p.sr);
    if(srSafe!==+n.p.sr) n.status='sample rate in settings is stale, using '+srSafe+' Hz';
    n.sourceRate=await n.dev.setSampleRate(srSafe);
    n.actualFreq=await n.dev.setCenterFrequency(+n.p.freq);
    n.appliedFreq=Math.round(n.p.freq); n.appliedGain=gain; n.appliedAuto=!!n.p.auto;
    await n.dev.resetBuffer();
    // отключение/переподключение — каналы поднимаем с нуля; активные до дисконнекта воркеры
    // уже терминированы в rtlDisconnect, но на всякий случай подчистим прежде, чем ресайзить кольца
    for(const ch of n.ch){ if(ch.worker) ch.worker.terminate(); ch.worker=null; ch.aring=null; ch.active=false; }
    rtlResetRing(n);
    rtlActivateChannel(n, 0);                        // channel 1 — always, as before
    // синхронизируем NCO канала 1 с уже выставленным (возможно, отличным от центра) значением
    const tf0=n.ch[0].tuneFreq==null?n.actualFreq:n.ch[0].tuneFreq;
    n.ch[0].appliedOffset=clamp(tf0, n.actualFreq-n.sourceRate/2, n.actualFreq+n.sourceRate/2)-n.actualFreq;
    n.ch[0].worker.setOffset(n.ch[0].appliedOffset);
    if(n.specWorker) n.specWorker.terminate();
    n.specWorker=rtlMakeSpecWorker(); n.specBusy=false;
    n.connected=true; n.reading=true;
    n.underrunsWorker=0; n.underrunsOverflow=0; n.underrunsStarve=0;
    n.status='connected ('+n.dev.tunerName+')';
    rtlReadLoop(n);
  }catch(e){
    n.status='error: '+e.message;
    n.dev=null; n.connected=false;
  }
}

async function rtlDisconnect(n){
  n.reading=false;
  for(const ch of n.ch){ if(ch.worker) ch.worker.terminate(); ch.worker=null; ch.aring=null; ch.active=false; }
  if(n.specWorker){ n.specWorker.terminate(); n.specWorker=null; }
  if(n.dev){ try{ await n.dev.close(); }catch(e){} n.dev=null; }
  n.connected=false; n.busy=false;
  n.status='disconnected';
}

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
  const wantFreq=Math.round(n.p.freq);
  const wantAuto=!!n.p.auto, wantGain=wantAuto?null:n.p.gainDb;
  const freqStale = wantFreq!==n.appliedFreq;
  const gainStale = wantAuto!==n.appliedAuto || (!wantAuto && wantGain!==n.appliedGain);
  if(!freqStale && !gainStale) return;
  n.busy=true;
  try{
    if(freqStale){ n.actualFreq=await n.dev.setCenterFrequency(wantFreq); n.appliedFreq=wantFreq; }
    if(gainStale){ await n.dev.setGain(wantGain); n.appliedGain=wantGain; n.appliedAuto=wantAuto; }
  }catch(e){ n.status='retune error: '+e.message; }
  n.busy=false;
}

def({ id:'rtlsdr', title:'RTL-SDR', cat:'Sources',
  ins:[{n:'freq',t:'num'},{n:'steerFreq',t:'num'},{n:'tuneFreq',t:'num'},{n:'tuneFreq2',t:'num'},{n:'tuneFreq3',t:'num'},{n:'tuneFreq4',t:'num'},
       {n:'gainDb',t:'num'},{n:'bw',t:'num'},{n:'demod',t:'val'}],
  outs:[{n:'I',t:'sig'},{n:'Q',t:'sig'},
        {n:'audio',t:'sig'},{n:'audio2',t:'sig'},{n:'audio3',t:'sig'},{n:'audio4',t:'sig'},
        {n:'spec',t:'spec'},{n:'freqLo',t:'num'},{n:'freqHi',t:'num'},
        {n:'tuneFreq',t:'num'},{n:'tuneFreq2',t:'num'},{n:'tuneFreq3',t:'num'},{n:'tuneFreq4',t:'num'},
        {n:'demod',t:'val'},{n:'bw',t:'num'}],
  readout:true,
  params:[
    {n:'connect',t:'button',label:'Connect',fn:async n=>{ await rtlConnect(n); }},
    {n:'disconnect',t:'button',label:'Disconnect',fn:async n=>{ await rtlDisconnect(n); }},
    {n:'sr',t:'select',opts:['960000','1024000','1920000','2048000','2400000','3200000'],d:'1024000',label:'sample rate',
     fn:async n=>{ if(n.dev){ try{ n.sourceRate=await n.dev.setSampleRate(rtlSafeSr(n.p.sr)); rtlResetRing(n); }
       catch(e){ n.status='sample rate change error: '+e.message; } } }},
    // режим демодуляции/полоса/де-эмфазис — ОБЩИЕ на все 4 канала (проще UI); частота у каждого своя
    {n:'demod',t:'select',opts:DEMOD_OPTS,d:'WFM',label:'demodulation',
     fn:n=>{ rtlResetRing(n); }},
    {n:'bw',t:'range',min:500,max:16000,step:100,d:15000,log:true,label:'audio bandwidth, Hz'},
    {n:'deemph',t:'select',opts:['50','75','off'],d:'50',label:'WFM de-emphasis, µs'},
    {n:'auto',t:'check',d:true,label:'auto gain'},
    {n:'gainDb',t:'range',min:0,max:49.6,step:.1,d:20,label:'gain, dB'},
    {n:'specSize',t:'select',opts:['512','1024','2048','4096','8192','16384','32768','65536'],d:'4096',label:'spectrum FFT size'},
    {n:'specWin',t:'select',opts:['hann','hamming','blackman','rect'],d:'hann',label:'spectrum window'}
  ],
  init:n=>{ n.dev=null; n.connected=false; n.reading=false; n.sourceRate=1024000;
            n.underrunsWorker=0; n.underrunsOverflow=0; n.underrunsStarve=0;
            n.status='not connected'; n.busy=false; n.specWorker=null; n.specBusy=false;
            n.workerMs=null; n.roundtripMs=null;
            n.appliedFreq=null; n.appliedGain=null; n.appliedAuto=null;
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
    const freqInputPresent=typeof I.freq==='number';
    // freqDriven — это факт, что 'freq' СЕЙЧАС МЕНЯЕТСЯ (значение отличается от прошлого тика),
    // а не просто факт, что провод подключён. Раньше было наоборот (freqDriven=подключён), и это
    // мешало пользоваться Тюнером и перетаскиванием спектра ОДНОВРЕМЕННО: как только Тюнер хоть
    // раз подключают к 'freq', tuneFreq (в т.ч. от sa.centerFreq при драге спектра — см. модуль
    // analysis.js) НАВСЕГДА лишался права переставить реальный центр по краю — Тюнер, даже стоя
    // смирно, вечно "побеждал". Раз сравниваем с прошлым тиком: пока Тюнер НЕ крутят (I.freq не
    // меняется), он никому не мешает — tuneFreq свободно постранично переставляет центр сам (см.
    // ниже); а вот в САМ момент, когда Тюнер реально крутят, на этот тик действительно уступаем
    // ему дорогу — иначе 'freq' на следующем же тике перетрёт скачок tuneFreq обратно, и получится
    // бесконечное перетягивание (см. комментарий у самого if(freqDriven) ниже). Значение 'freq'
    // по-прежнему применяется каждый тик, пока провод подключён — Тюнер остаётся единственным
    // хозяином центра, когда сам того хочет.
    const wireChanged=freqInputPresent && I.freq!==n._prevIFreq;
    // 'freq' МОГЛИ подвинуть и без провода вообще — вручную потаскав/вписав число прямо в панели
    // параметров узла (то же самое n.p.freq, тот же setV в core-graph.js). steerFreq об этом
    // никак не узнал бы (у него нет понятия "вход изменился", т.к. это не его вход) и на
    // СЛЕДУЮЩЕМ же тике попробовал бы вернуть частоту к своей же цели — снаружи это выглядит
    // как "не могу ввести центральную частоту руками, она тут же откатывается обратно" (ровно
    // так и сообщили). n._prevPFreq — снимок n.p.freq на конец ПРЕДЫДУЩЕГО тика (пишем в самом
    // низу process()); если сейчас он отличается, а сам этот тик его ещё не трогал — значит,
    // сменили руками между тиками, и на этот тик тоже уступаем дорогу, как и активно крутящемуся
    // Тюнеру.
    const manualEdit=n._prevPFreq!=null && n.p.freq!==n._prevPFreq;
    const freqDriven=wireChanged || manualEdit;
    if(freqInputPresent){ setMod(n,'freq',I.freq); n._prevIFreq=I.freq; }
    // Уступить steerFreq дорогу только на ОДИН тик (см. freqDriven выше) недостаточно: пока сам
    // steerFreq не переменился (fmin/fmax у 'sa' не трогали — там всё ещё старая, уже неактуальная
    // цель), он на СЛЕДУЮЩЕМ же тике возобновляет обычную работу и тащит центр обратно — снаружи
    // это и есть "ввод частоты руками так и не чинится". Вместо одноразовой уступки запоминаем
    // (n._steerFreqHold) само значение steerFreq в момент ручной правки/Тюнера и держим его
    // подавленным, пока оно не изменится — то есть пока пользователь заново не потрогает спектр
    // (drag/zoom подвинут sa.centerFreq). Как только цель реально другая — steerFreq возвращает
    // себе право переставлять центр, никакого постоянного "замка".
    if(freqDriven) n._steerFreqHold = typeof I.steerFreq==='number' ? I.steerFreq : undefined;
    const steerSuppressed = n._steerFreqHold!==undefined && I.steerFreq===n._steerFreqHold;
    const cf0=n.actualFreq??n.p.freq;
    // steerFreq — единственный (не считая 'freq'/Тюнера) вход, которому разрешено дёргать
    // РЕАЛЬНЫЙ центр приёмника: следует за запрошенной целью НЕПРЕРЫВНО (перестраивается на неё
    // напрямую, а не полосами/страницами приёмника) — у него нет своего канала/звука, это чисто
    // "куда смотрит приёмник", для ручной навигации (Тюнер уже занимает 'freq', это — например,
    // drag спектра, см. sa.centerFreq). Раньше сдвигали центр целыми "страницами" (шириной полосы
    // приёмника) при выходе за край — задумывалось как экономия на дорогой USB-перестройке, но на
    // практике ощущалось как рывок/скачок вместо плавной прокрутки (в SDR++/gqrx частота при драге
    // "наматывается" плавно).
    // Троттлинг (тот же интервал, что у rtlUpdateSpec) — ощутимая перестройка PLL тюнера (R820T)
    // требует времени на реколибровку/устаканивание DC-смещения; без троттлинга при непрерывном
    // перетаскивании приёмник перестраивался БЕЗ ПЕРЕРЫВА, одна команда сразу за другой (rtlApply-
    // Pending не шлёт больше одной разом, но как только шина освобождается — тут же летит
    // следующая, свежее значение уже накопилось) — тюнер физически не успевал устаканиться между
    // перестройками ни на миг, и это лезло в поток IQ прямо во время демодуляции ("трещащий звук,
    // будто underflow/overflow" на WFM). Даём тюнеру хотя бы паузу между реальными перестройками;
    // на плавность самой картинки (sa.centerFreq/окно) это не влияет — они по-прежнему обновляются
    // каждый тик, троттлится только физическая перестройка приёмника.
    if(typeof I.steerFreq==='number' && !freqDriven && !steerSuppressed && I.steerFreq!==cf0){
      const now=performance.now();
      if(n._lastSteerRetune==null || now-n._lastSteerRetune>=80){
        n._lastSteerRetune=now;
        n.p.freq=I.steerFreq; n.set.freq?.(I.steerFreq);
      }
    }
    // канал 0 — просто NCO-офсет в пределах уже захваченной полосы, как и 1-3 ниже (см. steerFreq
    // выше про то, кто теперь отвечает за реальную перестройку).
    if(typeof I.tuneFreq==='number') n.ch[0].tuneFreq=I.tuneFreq;
    // каналы 2-4 — то же самое, плюс ленивая активация при первом же числе на их tuneFreqN
    // (одновременно можно слушать только то, что помещается в одну физически настроенную полосу)
    for(let ci=1;ci<4;ci++){
      const want=I['tuneFreq'+RTL_CH_SUFFIX[ci]];
      if(typeof want==='number'){
        if(!n.ch[ci].active) rtlActivateChannel(n,ci);
        n.ch[ci].tuneFreq=want;
      }
    }
    // gainDb/demod/bw — часто одновременно и подключены (например, с выбранной закладки), и хочется
    // покрутить руками поверх — setModWired (processing.js) даёт ручной правке победить, пока сам
    // провод не укажет на другое значение (та же идея, что у freq/steerFreq выше, общим хелпером).
    setModWired(n,'gainDb', I.gainDb, typeof I.gainDb==='number');
    setModWired(n,'demod', I.demod, typeof I.demod==='string' && DEMOD_OPTS.includes(I.demod));
    setModWired(n,'bw', I.bw, typeof I.bw==='number');
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
        ch.worker.config({mode:n.p.demod, sr:n.sourceRate, bw:n.p.bw, deemph:n.p.deemph});
        ch.worker.reset();
        rtlResizeChannelRing(n, ch);   // decim мог смениться вместе с mode — кольцо иначе рассинхронизируется со временем
      } else {
        const softKey=n.p.bw+'|'+n.p.deemph;
        if(softKey!==ch.softKey){
          ch.softKey=softKey;
          ch.worker.config({mode:n.p.demod, sr:n.sourceRate, bw:n.p.bw, deemph:n.p.deemph});
          rtlResizeChannelRing(n, ch);  // bw участвует в decim для SSB (там chanBw==bw) — тот же случай
        }
      }
      const wantTune=clamp(ch.tuneFreq==null?cf:ch.tuneFreq, cf-half, cf+half), wantOffset=wantTune-cf;
      if(Math.abs(wantOffset-ch.appliedOffset)>0.5){
        ch.worker.setOffset(wantOffset);
        ch.appliedOffset=wantOffset;
      }
    }

    rtlUpdateSpec(n);
    const oi=buf(n,'I'), oq=buf(n,'Q');
    const oa=[buf(n,'audio'), buf(n,'audio2'), buf(n,'audio3'), buf(n,'audio4')];
    const tf=n.ch.map(ch=>clamp(ch.tuneFreq==null?cf:ch.tuneFreq, cf-half, cf+half));
    const bounds={freqLo:cf-half, freqHi:cf+half,               // край захваченной полосы + настройка каждого канала
      tuneFreq:tf[0], tuneFreq2:tf[1], tuneFreq3:tf[2], tuneFreq4:tf[3]};

    if(n.p.demod==='IQ') rtlReadIQ(n, oi, oq); else { oi.fill(0); oq.fill(0); }
    for(let ci=0;ci<4;ci++) rtlReadChannelAudio(n, n.ch[ci], oa[ci]);

    n._prevPFreq=n.p.freq; // снимок на конец тика — см. manualEdit в начале process() (demod/bw/gainDb — через setModWired)
    return {I:oi, Q:oq, audio:oa[0], audio2:oa[1], audio3:oa[2], audio4:oa[3], spec:n.spec,
      demod:n.p.demod, bw:n.p.bw, ...bounds}; },
  // Собственная отрисовка спектра/водопада убрана — для этого универсальный узел 'sa'
  // (Спектроанализатор), подключаемый к выходу 'spec'. Здесь остаётся только статус-строка.
  draw(n){
    // Крутилка ввода центральной частоты (та же, что у узла 'tuner', см. drawFreqDial выше) — вместо
    // обычного текстового поля с числом. Не через стандартный d.view (тот канвас движок кладёт
    // ПОСЛЕ всех params — а частота тут самое важное поле, ей место сверху), поэтому канва
    // заводится и позиционируется вручную, первым элементом .mid, с тем же hiDPICanvas для
    // чёткости на ретине/мобиле, что и у обычных view-канвасов.
    // isConnected — не просто "уже создан": rebuildNode (смена sr, и т.п.) выкидывает старый .el
    // целиком и строит новый, а n._dialCv остался бы указывать на канву, которой больше нет в DOM
    if((!n._dialCv || !n._dialCv.isConnected) && n.el){
      const mid=n.el.querySelector('.mid');
      if(mid){
        const cv=document.createElement('canvas'); cv.className='view';
        const dcx=cv.getContext('2d',{willReadFrequently:true});
        mid.insertBefore(cv, mid.firstChild);
        cv.width=200; cv.height=170; cv.style.height='170px';
        hiDPICanvas(cv,dcx,n);
        n._dialCv=cv; n._dialCx=dcx; n._dial={};
      }
    }
    if(n._dialCv) drawFreqDial(n.el, n._dialCv, n._dialCx, n._dial, ()=>n.p.freq, v=>{ n.p.freq=v; });
    const cf=n.actualFreq??n.p.freq;
    const tune=clamp(n.ch[0].tuneFreq==null?cf:n.ch[0].tuneFreq, cf-n.sourceRate/2, cf+n.sourceRate/2);
    const chCount=n.ch.filter(c=>c.active).length;
    const r=n.el.querySelector('.readout');
    if(r) r.textContent = n.connected
      ? `${n.dev?n.dev.tunerName:'?'} · ${n.p.demod} · center ${fmtHz(cf)} · span ${fmtHz(n.sourceRate)} · tune ${fmtHz(tune)} · `+
        `channels ${chCount} · ${(n.msps||0).toFixed(2)}Msps (I/O:${(n.mspsIo||0).toFixed(2)})`+
        (n.workerMs!=null?` · demod ${n.workerMs.toFixed(1)}ms/chunk (roundtrip ${(n.roundtripMs||0).toFixed(1)}ms)`:'')+
        // разбивка по стадии, где реально теряются данные: demod — воркер не успел (вход),
        // ovf — consumer (Eng.tick) отстал, кольцо переполнилось и пришлось прыгнуть вперёд,
        // dry — consumer остался без данных (кольцо опустело быстрее, чем producer его наполнял)
        ((n.underrunsWorker||n.underrunsOverflow||n.underrunsStarve)?
          ` · errors demod:${n.underrunsWorker||0} ovf:${n.underrunsOverflow||0} dry:${n.underrunsStarve||0}`:'')+
        (n.busy?' · …':'')
      : n.status;
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

def({ id:'song', title:'Arrangement (Playlist)', cat:'Music',
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
      cx.fillStyle='#0b0d0e'; cx.font='bold 11px monospace'; cx.textAlign='left';
      cx.fillText('ABCD'[s.bank], x0+4, 13);
      cx.fillStyle='rgba(0,0,0,.65)'; cx.font='10px monospace';
      cx.fillText(songBarsLabel(s.bars), x0+4, H-6);
      if(w>CLOSE+4){ cx.fillStyle='rgba(0,0,0,.3)'; cx.fillRect(x0+w-CLOSE,1,CLOSE-1,CLOSE-1);
        cx.fillStyle='#fff'; cx.textAlign='center'; cx.fillText('×', x0+w-CLOSE/2, CLOSE-4); cx.textAlign='left'; }
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
const VOICE_COL=['#8ab4f8','#7fd17f','#e0b23c','#d18ad1'];  // цвет = дорожка = выход freq/freq2/freq3/freq4
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


def({ id:'pianoroll', title:'Piano Roll', cat:'Music',
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
      cx.font='9px monospace'; cx.fillStyle = b===bi ? '#c9dcff' : '#6c7a80';
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
      const col=VOICE_COL[nt.voice|0];
      cx.fillStyle = sounding.has(nt) ? '#ffffff' : col;
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
const TUNER_DIGITS=10;                                  // до 9 999 999 999 Гц (~10 ГГц) с запасом

// Общая крутилка+табло ввода частоты (изначально была только внутри узла 'tuner') — теперь общий
// виджет, используемый и в 'rtlsdr' для его центральной частоты (см. draw() у 'rtlsdr' выше), вместо
// обычного текстового поля: то же вращение/тап по разряду/клавиатура/колесо, включая мобильную
// поддержку (скрытый text-input под тап по цифре — иначе на мобиле нечем вызвать цифровую
// клавиатуру у canvas). state — объект, который хранит caller (НЕ n.sel/n.ang напрямую) — так одной
// функцией можно завести несколько независимых крутилок на разных узлах без коллизий состояния.
// get/set — доступ к самому значению частоты, el — элемент для фокуса/клавиатуры (обычно n.el).
function drawFreqDial(el,cv,cx,state,get,set){
  if(state.sel==null){ state.sel=8; state.ang=0; }
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
    numInput.style.cssText='position:absolute;opacity:0;width:1px;height:1px;padding:0;border:0;pointer-events:none;';
    el.appendChild(numInput);
    numInput.addEventListener('input',()=>{
      const ch=numInput.value.replace(/\D/g,'').slice(-1);
      numInput.value='';
      if(!ch) return;
      const digits=String(Math.round(get())).padStart(TUNER_DIGITS,'0').split('');
      digits[state.sel]=ch;
      set(clamp(+digits.join(''),0,maxV));
      state.sel=clamp(state.sel+1,0,TUNER_DIGITS-1); });
    el.addEventListener('keydown',ev=>{
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
      if(y<TOP){                                        // клик по табло — выбрать разряд под стрелки
        const x=(ev.clientX-r.left)/r.width*W, cw=W/TUNER_DIGITS;
        state.sel=clamp(Math.floor(x/cw),0,TUNER_DIGITS-1);
        if(ev.pointerType==='touch') numInput.focus(); else el.focus();
      } else {                                          // клик по крутилке — начать вращение
        state.dragY0=ev.clientY; state.dragFreq0=get();   // запоминаем старт драга, а не только предыдущую точку
        state.dragLastY=ev.clientY; state.dragPtr=ev.pointerId; state.dragTouch=ev.pointerType==='touch';
        cv.setPointerCapture(ev.pointerId);
      } });
    cv.addEventListener('pointermove',ev=>{
      if(state.dragY0==null || ev.pointerId!==state.dragPtr) return;
      ev.preventDefault();
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
    const endDrag=()=>{ state.dragY0=null; state.dragPtr=null; };
    cv.addEventListener('pointerup',endDrag); cv.addEventListener('pointercancel',endDrag);
    cv.addEventListener('wheel',ev=>{ ev.preventDefault(); ev.stopPropagation();
      set(clamp(Math.round(get()+(ev.deltaY<0?stepHz():-stepHz())),0,maxV)); },{passive:false});
  }
  cx.clearRect(0,0,W,H);
  // табло
  const digStr=String(Math.round(get())).padStart(TUNER_DIGITS,'0'), cw=W/TUNER_DIGITS;
  cx.font='bold '+Math.round(Math.min(34,cw*.78))+'px monospace'; cx.textAlign='center'; cx.textBaseline='middle';
  for(let i=0;i<TUNER_DIGITS;i++){
    if(i===state.sel){ cx.fillStyle='#e0b23c33'; cx.fillRect(i*cw+1,2,cw-2,TOP-4); }
    cx.fillStyle= i===state.sel? '#e0b23c' : '#cfd6db';
    cx.fillText(digStr[i], i*cw+cw/2, TOP/2);
    if((TUNER_DIGITS-1-i)%3===0 && i<TUNER_DIGITS-1){    // разделитель разрядов по 3 (тысячи/миллионы/…)
      cx.strokeStyle='#333'; cx.beginPath();
      cx.moveTo(i*cw+cw+.5,4); cx.lineTo(i*cw+cw+.5,TOP-4); cx.stroke(); }
  }
  cx.textAlign='left'; cx.font='10px monospace'; cx.fillStyle='#8a9298';
  cx.fillText(fmtHz(get())+'Hz · digit ×'+fmtHz(Math.pow(10,TUNER_DIGITS-1-state.sel)), 4, H-4);
  // крутилка
  const cx0=W/2, cy0=TOP+(H-TOP)/2, r=Math.min(W,H-TOP)/2-8;
  cx.strokeStyle='#333'; cx.fillStyle='#1a2024'; cx.lineWidth=2;
  cx.beginPath(); cx.arc(cx0,cy0,r,0,2*Math.PI); cx.fill(); cx.stroke();
  cx.save(); cx.translate(cx0,cy0); cx.rotate(state.ang*Math.PI/180);
  cx.strokeStyle='#e0b23c'; cx.lineWidth=3; cx.beginPath();
  cx.moveTo(0,-r+6); cx.lineTo(0,-r*0.4); cx.stroke();
  cx.restore();
  cx.fillStyle='#8a9298'; cx.font='9px monospace'; cx.textAlign='center';
  cx.fillText('step ×'+fmtHz(stepHz()), cx0, cy0+r+12);
}

def({ id:'tuner', title:'Tuner', cat:'Radio', outs:[{n:'freq',t:'num'}],
  view:{h:200}, resize:true,
  init:n=>{ n.p.freq=n.p.freq??100000000; n._dial={}; },
  process(n){ return {freq:n.p.freq}; },
  draw(n,cv,cx){
    if(!cv) return;
    drawFreqDial(n.el,cv,cx,n._dial, ()=>n.p.freq, v=>{ n.p.freq=v; });
  }});


/* ---------- Хранилище семплов (IndexedDB) ---------- */
// Две таблицы: folders (id, name, parentId) и clips (id, name, folderId, sr, samples, peaks, duration).
// root-папка имеет parentId/folderId = null.

const SampleDB = (() => {
  let dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const rq = indexedDB.open('dsp-samples', 1);
      rq.onupgradeneeded = e => {
        const db = e.target.result;
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
      return reqP(s.add({name, parentId, created:Date.now()}));
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
      return reqP(s.index('parentId').getAll(parentId));
    },
    async getFolder(id){
      if(id==null) return null;
      const s = await store('folders','readonly');
      return reqP(s.get(id));
    },

    async addClip(clip){
      clip.created = Date.now();
      const s = await store('clips','readwrite');
      return reqP(s.add(clip));
    },
    async updateClip(id, patch){
      const s = await store('clips','readwrite');
      const c = await reqP(s.get(id));
      Object.assign(c, patch);
      return reqP(s.put(c));
    },
    async deleteClip(id){
      const s = await store('clips','readwrite');
      return reqP(s.delete(id));
    },
    async listClips(folderId=null){
      const s = await store('clips','readonly');
      return reqP(s.index('folderId').getAll(folderId));
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
// нужно подключить выход к чему-то вроде dac.
def({ id:'sampleLib', title:'Sample Library', cat:'Music',
  outs:[{n:'out',t:'sig'},{n:'clipId',t:'num'},{n:'pos',t:'num'}],
  ins:[{n:'clipId',t:'num'},{n:'play',t:'num'},{n:'rate',t:'num'},{n:'gain',t:'num'},{n:'loop',t:'num'}],
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
    n.previewCtx = null;         // отдельный контекст только для прослушивания при обрезке
    n.previewSrc = null;
    n.onResize = ln => { if(ln.ui) syncCustomHeight(ln, ln.ui.root, 120); };
  },
  process(n,I){
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

function libEnsurePreviewCtx(n){
  if(!n.previewCtx || n.previewCtx.state==='closed') n.previewCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(n.previewCtx.state==='suspended') n.previewCtx.resume();
  return n.previewCtx;
}
function libStopPreview(n){
  if(n.previewSrc){ try{ n.previewSrc.stop(); }catch(e){} n.previewSrc=null; }
}
function libPlayPreview(n, samples, sr){          // только для прослушивания при обрезке, мимо графа
  libStopPreview(n);
  const ctx = libEnsurePreviewCtx(n);
  const buffer = ctx.createBuffer(1, samples.length, sr);
  buffer.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  n.previewSrc = src;
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
      <input class="lib-file" type="file" accept="audio/*" multiple style="display:none;">
      <span class="lib-crumbs" style="flex:1;color:#6c7a80;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
    </div>
    <div class="lib-list" style="flex:1;overflow-y:auto;border:1px solid #1d2226;border-radius:3px;background:#0e1113;position:relative;"></div>
    <div class="lib-trim" style="display:none;position:absolute;inset:0;background:#0e1113;border:1px solid #2a3136;border-radius:3px;padding:4px;flex-direction:column;gap:4px;z-index:5;"></div>
  `;
  mid.append(root);
  syncCustomHeight(n, root, 120);      // сразу выставить текущий n.size.h, дальше — через onResize

  n.ui = {
    root,
    crumbs: root.querySelector('.lib-crumbs'),
    list: root.querySelector('.lib-list'),
    trim: root.querySelector('.lib-trim'),
  };

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
  row.style.cssText = `display:flex;align-items:center;gap:5px;padding:2px 6px;cursor:pointer;
    border-bottom:1px solid #121619;background:${isSel?'#1d2226':'transparent'};min-width:0;`;

  const canvas = document.createElement('canvas');
  canvas.width=50; canvas.height=18;
  canvas.style.cssText = 'width:50px;height:18px;flex-shrink:0;';
  libDrawPeaks(canvas, c.peaks);

  const name = document.createElement('span');
  name.textContent = c.name;
  name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const dur = document.createElement('span');
  dur.textContent = fmtDur(c.duration);
  dur.style.cssText = 'color:#4ec9b0;width:34px;';

  const playBtn = document.createElement('span');
  playBtn.textContent = (n.selected===c.id && n.play) ? '⏸' : '▶';
  playBtn.style.cssText='cursor:pointer;';
  playBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    if(n.selected===c.id){ n.play = !n.play; libHighlight(n); }
    else await libArmClip(n, c.id, true);
  });

  const trimBtn = document.createElement('span');
  trimBtn.textContent = '✂'; trimBtn.style.cssText='cursor:pointer;color:#6c7a80;';
  trimBtn.addEventListener('click', async ev=>{
    ev.stopPropagation();
    const full = await SampleDB.getClip(c.id);
    libOpenTrim(n, full);
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

  row.append(canvas, name, dur, playBtn, trimBtn, renameBtn, delBtn);

  row.addEventListener('click', ()=>libArmClip(n, c.id, true));
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
  cx.strokeStyle = '#4ec9b0'; cx.lineWidth = 1;
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


/* ---------- Редактор обрезки ---------- */
function libOpenTrim(n, clip){
  const box = n.ui.trim;
  box.style.display = 'flex';
  box.innerHTML = '';

  const state = { clip, a: 0, b: clip.samples.length, dragging: null };
  n.trim = state;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;color:#6c7a80;flex-shrink:0;';
  header.innerHTML = `<span>${escapeHtml(clip.name)}</span><span class="trim-range"></span>`;
  box.appendChild(header);

  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 90;
  canvas.style.cssText = 'width:100%;height:90px;flex:1;cursor:col-resize;';
  box.appendChild(canvas);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
  controls.innerHTML = `
    <button class="trim-play" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:10px;">▶ clip</button>
    <span style="flex:1;"></span>
    <button class="trim-save" style="background:#1d2226;border:1px solid #4ec9b0;color:#4ec9b0;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:10px;">save</button>
    <button class="trim-cancel" style="background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:10px;">cancel</button>
  `;
  box.appendChild(controls);

  const cx = canvas.getContext('2d');
  const redraw = ()=>{
    const W=canvas.width, H=canvas.height, half=H/2, s=clip.samples;
    cx.clearRect(0,0,W,H);
    cx.strokeStyle = '#4ec9b0'; cx.lineWidth = 1; cx.beginPath();
    const step = Math.max(1, Math.floor(s.length/W));
    for(let x=0;x<W;x++){
      const idx = Math.min(x*step, s.length-1);
      const y = half - (s[idx]||0)*half*0.9;
      x===0? cx.moveTo(x,y) : cx.lineTo(x,y);
    }
    cx.stroke();
    const ax = state.a/s.length*W, bx = state.b/s.length*W;
    cx.fillStyle = 'rgba(224,178,60,.12)'; cx.fillRect(ax,0,bx-ax,H);
    cx.strokeStyle = '#e0b23c'; cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(ax,0); cx.lineTo(ax,H); cx.stroke();
    cx.beginPath(); cx.moveTo(bx,0); cx.lineTo(bx,H); cx.stroke();
    header.querySelector('.trim-range').textContent =
      fmtDur(state.a/clip.sr)+' — '+fmtDur(state.b/clip.sr)+' ('+fmtDur((state.b-state.a)/clip.sr)+')';
  };
  redraw();

  const xToSample = x => clamp(Math.round(x/canvas.width*clip.samples.length), 0, clip.samples.length);
  canvas.addEventListener('pointerdown', ev=>{
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX-r.left)/r.width*canvas.width;
    const s = xToSample(x);
    const ax = state.a/clip.samples.length*canvas.width, bx = state.b/clip.samples.length*canvas.width;
    if(Math.abs(x-ax) < 8) state.dragging = 'a';
    else if(Math.abs(x-bx) < 8) state.dragging = 'b';
    else { state.a = s; state.b = s; state.dragging = 'b'; }
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', ev=>{
    if(!state.dragging) return;
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX-r.left)/r.width*canvas.width;
    const s = xToSample(x);
    if(state.dragging==='a') state.a = Math.min(s, state.b);
    else state.b = Math.max(s, state.a);
    redraw();
  });
  canvas.addEventListener('pointerup', ()=>{ state.dragging=null; });

  controls.querySelector('.trim-play').addEventListener('click', ()=>{
    const slice = clip.samples.subarray(state.a, state.b);
    libPlayPreview(n, slice, clip.sr);
  });
  controls.querySelector('.trim-save').addEventListener('click', async ()=>{
    libStopPreview(n);
    const slice = clip.samples.slice(state.a, state.b);
    await SampleDB.updateClip(clip.id, {
      samples: slice, duration: slice.length/clip.sr,
      peaks: SampleDB.computePeaks(slice),
    });
    libCloseTrim(n);
    if(n.selected===clip.id) await libArmClip(n, clip.id, false);   // перезагрузить обрезанный буфер, если клип сейчас в узле
    libRefresh(n);
  });
  controls.querySelector('.trim-cancel').addEventListener('click', ()=>{
    libStopPreview(n); libCloseTrim(n);
  });
}
function libCloseTrim(n){
  n.ui.trim.style.display = 'none';
  n.ui.trim.innerHTML = '';
  n.trim = null;
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
      const rq = indexedDB.open('dsp-lists', 1);
      rq.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains('items')){
          const s = db.createObjectStore('items',{keyPath:'id',autoIncrement:true});
          s.createIndex('listName','listName');
        }
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
      return [...new Set(all.map(x=>x.listName))].sort(); },
    async renameList(oldName,newName){ const s=await store('readwrite');
      const items=await reqP(s.index('listName').getAll(oldName));
      for(const it of items){ it.listName=newName; await reqP(s.put(it)); } },
    async deleteList(listName){ const s=await store('readwrite');
      const items=await reqP(s.index('listName').getAll(listName));
      for(const it of items) await reqP(s.delete(it.id)); },
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

def({ id:'hostlist', title:'List (CSV/DB)', cat:'Sources',
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


/* ============================ CSV-ПРОИГРЫВАТЕЛЬ (построчно) ============================ */
// В отличие от 'hostlist' (там CSV импортируется в IndexedDB и выбирается ОДНА запись
// вручную) — этот узел просто грузит файл в память и проигрывает строки по порядку:
// либо по таймеру (rate>0), либо по внешнему триггеру. Годится под любые табличные
// данные — записанный лог с serial-порта, дамп координат, тестовые векторы для графа и т.п.

function csvsrcAdvance(n){
  if(!n.rows.length) return;
  n.idx++;
  if(n.idx>=n.rows.length) n.idx = n.p.loop ? 0 : n.rows.length-1;
}

function csvsrcLoad(n, file){
  const reader = new FileReader();
  reader.onload = ()=>{
    let table;
    try{ table = csvParse(String(reader.result)); }
    catch(e){ alert('failed to parse CSV: '+e.message); return; }
    if(!table.length){ alert('file is empty'); return; }
    const headers = hostlistDedupFieldNames(table[0]);
    n.rows = table.slice(1).map(r=>{ const o={}; headers.forEach((h,i)=>o[h]=r[i]??''); return o; });
    n.headers = headers.length ? headers : ['value'];
    n.idx=0; n.t=0; n.name=file.name;
    n.initialized=false; rebuildNode(n); markTopoDirty();   // порты пересобираются под новые колонки
  };
  reader.readAsText(file);
}

def({ id:'csvsrc', title:'CSV (File, Row-by-Row)', cat:'Sources',
  ins: n => [{n:'trig',t:'val'}],
  outs: n => (n.headers||['value']).map(f=>({n:f,t:'val'})),
  readout:true,
  params:[
    {n:'file',t:'file',accept:'.csv,text/csv',fn:(n,f)=>csvsrcLoad(n,f)},
    {n:'rate',t:'range',min:0,max:50,step:.1,d:0,label:'rows/sec (0 = trig only)'},
    {n:'loop',t:'check',d:true},
  ],
  init:n=>{
    n.rows=[]; n.headers=['value']; n.idx=0; n.t=0; n.trigPrev=0; n.name='no file selected';
  },
  process(n,I){
    const trig = typeof I.trig==='number' ? I.trig : 0;
    if(trig>0.5 && n.trigPrev<=0.5) csvsrcAdvance(n);
    n.trigPrev = trig;
    if(n.p.rate>0 && n.rows.length){
      n.t += BLOCK/Eng.sr;
      const interval = 1/n.p.rate;
      if(n.t>=interval){ n.t-=interval; csvsrcAdvance(n); }
    }
    const out={}, row=n.rows[n.idx];
    for(const f of n.headers) out[f] = hostlistCoerce(row ? row[f] : '');
    return out;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    r.textContent = n.rows.length ? (n.name+' · row '+(n.idx+1)+'/'+n.rows.length) : n.name; }
});


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
      process(inputs,outputs){
        const inp=inputs[0][0];
        if(inp) this.port.postMessage(inp.slice());   // .slice() — буфер движка переиспользуется
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
    icyMetadataStart(n, url);   // не ждём — читается фоном, пока не остановят поток
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
      for(let i=0;i<value.length;i++){
        if(mode==='audio'){
          sinceMeta++;
          if(sinceMeta===metaint){ mode='metalen'; sinceMeta=0; }
        } else if(mode==='metalen'){
          metaLen=value[i]*16; metaBuf=[];
          mode = metaLen>0 ? 'meta' : 'audio';
        } else {
          metaBuf.push(value[i]);
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

def({ id:'drumseq', title:'Drum Sequencer (Techno)', cat:'Music',
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
      cx.font='9px monospace'; cx.fillStyle = b===bi ? '#c9dcff' : '#6c7a80';
      cx.fillText('ABCD'[b],b*bw+bw/2-3,TABH-4); }
    if(n._bankSelLive){ cx.fillStyle='rgba(224,178,60,.8)'; cx.fillRect(0,TABH-2,W,2); }  // банк задаётся song-узлом
    cx.save(); cx.translate(0,TABH);
    cx.fillStyle='rgba(255,255,255,.04)';
    for(let c=0;c<steps;c+=4) cx.fillRect(c*cw,0,cw,gh);           // подсветка долей — каждый 4-й шаг
    cx.strokeStyle='rgba(255,255,255,.08)'; cx.lineWidth=1;
    for(let c=0;c<=steps;c++){ cx.beginPath(); cx.moveTo(c*cw+.5,0); cx.lineTo(c*cw+.5,gh); cx.stroke(); }
    for(let r=0;r<=n.rows;r++){ cx.beginPath(); cx.moveTo(0,r*rh+.5); cx.lineTo(W,r*rh+.5); cx.stroke(); }
    cx.fillStyle='#8ab4f8';
    const g=drumGrid(n);
    for(let r=0;r<n.rows;r++) for(let c=0;c<steps;c++) if(g[r*32+c])
      cx.fillRect(c*cw+1,r*rh+1,cw-2,rh-2);
    if(n.idx>=0){ cx.fillStyle='rgba(224,178,60,.2)'; cx.fillRect(n.idx*cw,0,cw,gh); }
    cx.font='9px monospace'; cx.fillStyle='#6c7a80';
    for(let r=0;r<n.rows;r++) cx.fillText(DRUM_VOICES[r].label,3,r*rh+rh-3);
    cx.restore();
    n.el.querySelector('.readout').textContent=
      'bank '+'ABCD'[n.bankIdx]+(n._bankSelLive?' (auto)':'')+' · step '+Math.max(n.idx,0)+'/'+steps+
      ' · '+(n._synced?'ext. clock':n.p.bpm+' BPM'); }});
def({ id:'imgsrc', title:'Image (file/URL)', cat:'Sources', outs:[{n:'img',t:'img'}],
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
  try{ n.img={data:n.capCx.getImageData(0,0,W,H),w:W,h:H,gray:false}; n.status='loaded'; }
  catch(e){ n.img=null; n.status='cross-origin without CORS — frame unreadable'; }
}
