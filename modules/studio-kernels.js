"use strict";
/* ============================ STUDIO: ЯДРО (без DOM и Web Audio) ============================
   Модель проекта, время в тиках, огибающие, шкалы и аккорды, сбор нот плейлиста, WAV, пресеты, демо-проект.
   Проект — чистый JSON: каналы (синт / драм / сэмплер), паттерны (ноты по каналам), плейлист (клипы),
   микшер (мастер + вставки с цепочкой эффектов). Время везде в тиках: 96 на четвертную, шаг 1/16 = 24. */

const ST_PPQ=96, ST_STEP=24, ST_BAR=384, ST_INSERTS=16;
const ST_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const stNoteName=k=>ST_NAMES[((k%12)+12)%12]+(Math.floor(k/12)-1);
const stIsBlack=k=>[1,3,6,8,10].includes(((k%12)+12)%12);
const stHz=k=>440*Math.pow(2,(k-69)/12);
const stClamp=(v,a,b)=>v<a?a:v>b?b:v;
const stSec=(ticks,bpm)=>ticks*60/(bpm*ST_PPQ);
const stTicks=(sec,bpm)=>sec*bpm*ST_PPQ/60;
// качание: нечётные шестнадцатые сдвигаются вперёд (swing 0..1 → до трети шага)
const stSwing=(t,sw)=>(sw>0 && Math.floor(t/ST_STEP)%2===1) ? t+Math.round(sw*ST_STEP*.33) : t;

const ST_SCALES={chromatic:[0,1,2,3,4,5,6,7,8,9,10,11],major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],
  dorian:[0,2,3,5,7,9,10],phrygian:[0,1,3,5,7,8,10],lydian:[0,2,4,6,7,9,11],mixolydian:[0,2,4,5,7,9,10],
  'harm. minor':[0,2,3,5,7,8,11],'minor pent.':[0,3,5,7,10],'major pent.':[0,2,4,7,9],blues:[0,3,5,6,7,10]};
const ST_CHORDS={maj:[0,4,7],min:[0,3,7],'7':[0,4,7,10],maj7:[0,4,7,11],min7:[0,3,7,10],sus2:[0,2,7],sus4:[0,5,7],
  dim:[0,3,6],aug:[0,4,8],power:[0,7,12],add9:[0,4,7,14],min9:[0,3,7,10,14],oct:[0,12]};
const stInScale=(k,root,scale)=>(ST_SCALES[scale]||ST_SCALES.chromatic).includes((((k-root)%12)+12)%12);
const stSnapScale=(k,root,scale)=>{ for(let d=0;d<7;d++){ if(stInScale(k-d,root,scale)) return k-d; if(stInScale(k+d,root,scale)) return k+d; } return k; };

/* ---------- огибающая ADSR: аналитическое значение 0..1 ---------- */
// a,d,r — секунды, s — уровень; off — момент отпускания (сек от старта) или null, пока нота держится
function stAdsrAt(t,a,d,s,r,off){
  a=Math.max(a,.002);
  const held=u=>u<a ? u/a : s+(1-s)*Math.exp(-(u-a)/Math.max(d/4,.001));
  if(off==null || t<off) return held(t);
  return held(off)*Math.exp(-(t-off)/Math.max(r/4,.001));
}
const stRelEnd=r=>r*1.3+.05;            // когда после отпускания хвост можно обрывать

/* ---------- параметры инструментов и эффектов: описание для UI, движка и пресетов ---------- */
const ST_SYNTH=[
  {g:'Osc 1',k:'w1',t:'sel',o:['saw','square','sine','tri'],d:'saw',label:'wave'},
  {g:'Osc 1',k:'o1',min:-3,max:3,step:1,d:0,label:'oct'},{g:'Osc 1',k:'s1',min:-12,max:12,step:1,d:0,label:'semi'},
  {g:'Osc 1',k:'l1',min:0,max:1,step:.01,d:.8,label:'level'},
  {g:'Osc 2',k:'w2',t:'sel',o:['saw','square','sine','tri'],d:'saw',label:'wave'},
  {g:'Osc 2',k:'o2',min:-3,max:3,step:1,d:0,label:'oct'},{g:'Osc 2',k:'s2',min:-12,max:12,step:1,d:0,label:'semi'},
  {g:'Osc 2',k:'dt2',min:-50,max:50,step:1,d:7,label:'detune'},{g:'Osc 2',k:'l2',min:0,max:1,step:.01,d:0,label:'level'},
  {g:'Osc 2',k:'fm',min:0,max:1,step:.01,d:0,label:'FM 2→1'},
  {g:'Mix',k:'sub',min:0,max:1,step:.01,d:0,label:'sub'},{g:'Mix',k:'noi',min:0,max:1,step:.01,d:0,label:'noise'},
  {g:'Unison',k:'uni',min:1,max:7,step:1,d:1,label:'voices'},{g:'Unison',k:'det',min:0,max:100,step:1,d:20,label:'detune'},
  {g:'Unison',k:'spr',min:0,max:1,step:.01,d:.6,label:'stereo'},
  {g:'Filter',k:'ft',t:'sel',o:['lp','hp','bp','notch'],d:'lp',label:'type'},
  {g:'Filter',k:'cut',min:30,max:18000,log:1,d:9000,label:'cutoff',u:'Hz'},{g:'Filter',k:'res',min:.1,max:20,log:1,d:1,label:'reso'},
  {g:'Filter',k:'fenv',min:-6,max:6,step:.05,d:0,label:'env oct'},{g:'Filter',k:'fkey',min:0,max:1,step:.01,d:0,label:'key track'},
  {g:'Filter Env',k:'fa',min:.002,max:3,log:1,d:.005,label:'A',u:'s'},{g:'Filter Env',k:'fd',min:.005,max:3,log:1,d:.25,label:'D',u:'s'},
  {g:'Filter Env',k:'fs',min:0,max:1,step:.01,d:.2,label:'S'},{g:'Filter Env',k:'fr',min:.005,max:4,log:1,d:.2,label:'R',u:'s'},
  {g:'Amp Env',k:'a',min:.002,max:3,log:1,d:.005,label:'A',u:'s'},{g:'Amp Env',k:'d',min:.005,max:3,log:1,d:.2,label:'D',u:'s'},
  {g:'Amp Env',k:'s',min:0,max:1,step:.01,d:.7,label:'S'},{g:'Amp Env',k:'r',min:.005,max:6,log:1,d:.15,label:'R',u:'s'},
  {g:'LFO',k:'lt',t:'sel',o:['off','pitch','cutoff','amp'],d:'off',label:'target'},
  {g:'LFO',k:'lw',t:'sel',o:['sine','tri','square','saw'],d:'sine',label:'wave'},
  {g:'LFO',k:'lr',min:.05,max:30,log:1,d:4,label:'rate',u:'Hz'},{g:'LFO',k:'ld',min:0,max:1,step:.01,d:.3,label:'depth'},
  {g:'Out',k:'mono',t:'chk',d:0,label:'mono'},{g:'Out',k:'gl',min:0,max:1,step:.005,d:0,label:'glide',u:'s'},
  {g:'Out',k:'drv',min:0,max:1,step:.01,d:0,label:'drive'},{g:'Out',k:'vol',min:0,max:1,step:.01,d:.6,label:'gain'}];
const ST_DRUM_KINDS=['kick','snare','clap','chat','ohat','tom','rim','perc','crash'];
const ST_DRUM=[
  {g:'Drum',k:'kind',t:'sel',o:ST_DRUM_KINDS,d:'kick',label:'sound'},
  {g:'Drum',k:'pit',min:-12,max:12,step:.1,d:0,label:'pitch',u:'st'},{g:'Drum',k:'dec',min:.3,max:3,step:.01,d:1,label:'decay',u:'x'},
  {g:'Drum',k:'tone',min:0,max:1,step:.01,d:.5,label:'tone'},{g:'Drum',k:'pun',min:0,max:1,step:.01,d:.5,label:'punch'},
  {g:'Drum',k:'drv',min:0,max:1,step:.01,d:0,label:'drive'},{g:'Drum',k:'vol',min:0,max:1,step:.01,d:.8,label:'gain'}];
const ST_SAMPLER=[
  {g:'Sample',k:'root',min:24,max:96,step:1,d:60,label:'root key'},{g:'Sample',k:'pit',min:-12,max:12,step:.1,d:0,label:'pitch',u:'st'},
  {g:'Sample',k:'start',min:0,max:.95,step:.001,d:0,label:'start'},
  {g:'Sample',k:'rev',t:'chk',d:0,label:'reverse'},{g:'Sample',k:'loop',t:'chk',d:0,label:'loop'},
  {g:'Sample',k:'one',t:'chk',d:1,label:'full length'},
  {g:'Env',k:'a',min:.002,max:2,log:1,d:.002,label:'A',u:'s'},{g:'Env',k:'r',min:.005,max:4,log:1,d:.08,label:'R',u:'s'},
  {g:'Out',k:'vol',min:0,max:1,step:.01,d:.8,label:'gain'}];
const ST_CHDEF={synth:ST_SYNTH,drum:ST_DRUM,sampler:ST_SAMPLER};

const ST_FX={
  eq:{name:'EQ',p:[{k:'lo',min:-18,max:18,step:.1,d:0,label:'low',u:'dB'},{k:'mid',min:-18,max:18,step:.1,d:0,label:'mid',u:'dB'},
    {k:'mf',min:200,max:6000,log:1,d:1000,label:'mid freq',u:'Hz'},{k:'q',min:.3,max:6,log:1,d:1,label:'mid Q'},
    {k:'hi',min:-18,max:18,step:.1,d:0,label:'high',u:'dB'},{k:'lf',min:40,max:400,log:1,d:120,label:'low freq',u:'Hz'},
    {k:'hf',min:2000,max:14000,log:1,d:6000,label:'high freq',u:'Hz'}]},
  filter:{name:'Filter',p:[{k:'type',t:'sel',o:['lp','hp','bp','notch'],d:'lp',label:'type'},
    {k:'cut',min:30,max:18000,log:1,d:2000,label:'cutoff',u:'Hz'},{k:'res',min:.1,max:20,log:1,d:1,label:'reso'},
    {k:'mix',min:0,max:1,step:.01,d:1,label:'mix'}]},
  comp:{name:'Compressor',p:[{k:'thr',min:-60,max:0,step:.5,d:-18,label:'threshold',u:'dB'},{k:'ratio',min:1,max:20,step:.1,d:4,label:'ratio'},
    {k:'att',min:.001,max:.2,log:1,d:.01,label:'attack',u:'s'},{k:'rel',min:.02,max:1,log:1,d:.15,label:'release',u:'s'},
    {k:'knee',min:0,max:30,step:1,d:6,label:'knee'},{k:'gain',min:0,max:18,step:.5,d:3,label:'makeup',u:'dB'}]},
  delay:{name:'Delay',p:[{k:'div',t:'sel',o:['1/4','1/8','1/8.','1/16','1/2','3/16'],d:'1/8.',label:'time'},
    {k:'fb',min:0,max:.95,step:.01,d:.4,label:'feedback'},{k:'tone',min:500,max:16000,log:1,d:5000,label:'tone',u:'Hz'},
    {k:'pp',t:'chk',d:1,label:'ping-pong'},{k:'mix',min:0,max:1,step:.01,d:.3,label:'mix'}]},
  reverb:{name:'Reverb',p:[{k:'size',min:.3,max:6,log:1,d:2.2,label:'size',u:'s'},{k:'damp',min:0,max:1,step:.01,d:.5,label:'damping'},
    {k:'pre',min:0,max:.15,step:.001,d:.01,label:'pre-delay',u:'s'},{k:'lc',min:20,max:800,log:1,d:120,label:'low cut',u:'Hz'},
    {k:'mix',min:0,max:1,step:.01,d:.25,label:'mix'}]},
  chorus:{name:'Chorus',p:[{k:'rate',min:.05,max:6,log:1,d:.6,label:'rate',u:'Hz'},{k:'depth',min:0,max:1,step:.01,d:.5,label:'depth'},
    {k:'mix',min:0,max:1,step:.01,d:.5,label:'mix'}]},
  phaser:{name:'Phaser',p:[{k:'rate',min:.05,max:8,log:1,d:.4,label:'rate',u:'Hz'},{k:'depth',min:0,max:1,step:.01,d:.6,label:'depth'},
    {k:'fb',min:0,max:.9,step:.01,d:.4,label:'feedback'},{k:'mix',min:0,max:1,step:.01,d:.5,label:'mix'}]},
  dist:{name:'Distortion',p:[{k:'type',t:'sel',o:['soft','hard','fold','tube'],d:'soft',label:'type'},
    {k:'drive',min:0,max:1,step:.01,d:.4,label:'drive'},{k:'tone',min:400,max:16000,log:1,d:8000,label:'tone',u:'Hz'},
    {k:'mix',min:0,max:1,step:.01,d:1,label:'mix'},{k:'out',min:0,max:1.5,step:.01,d:.8,label:'output'}]},
  crush:{name:'Bitcrusher',p:[{k:'bits',min:2,max:16,step:1,d:8,label:'bits'},{k:'mix',min:0,max:1,step:.01,d:1,label:'mix'}]},
  pump:{name:'Pump (sidechain)',p:[{k:'div',t:'sel',o:['1/4','1/8','1/2'],d:'1/4',label:'rate'},{k:'depth',min:0,max:1,step:.01,d:.8,label:'depth'},
    {k:'rel',min:.05,max:1,step:.01,d:.45,label:'release',u:'beat'},{k:'off',min:0,max:.5,step:.01,d:0,label:'offset',u:'beat'}]},
  gate:{name:'Trance Gate',p:[{k:'div',t:'sel',o:['1/8','1/16','1/4'],d:'1/16',label:'rate'},{k:'depth',min:0,max:1,step:.01,d:1,label:'depth'},
    {k:'len',min:.1,max:.95,step:.01,d:.5,label:'length'},{k:'pat',t:'sel',o:['even','offbeat','x.xx','xx.x','roll'],d:'even',label:'pattern'}]},
  width:{name:'Stereo',p:[{k:'width',min:0,max:2,step:.01,d:1,label:'width'},{k:'pan',min:-1,max:1,step:.01,d:0,label:'pan'}]}};
const ST_FX_ORDER=['eq','comp','filter','dist','crush','chorus','phaser','delay','reverb','pump','gate','width'];
const ST_DIV={'1/2':2,'1/4':1,'1/8':.5,'1/8.':.75,'1/16':.25,'3/16':.75};   // длина в четвертных

const stDefs=(defs)=>{ const p={}; for(const d of defs) p[d.k]=d.d; return p; };
const stFillP=(defs,p)=>{ const o=stDefs(defs); if(p) for(const k in o) if(p[k]!==undefined) o[k]=p[k]; return o; };
// нормировка параметра в 0..1 и обратно (для ручек и автоматизации)
function stToNorm(d,v){
  if(d.t==='sel') return Math.max(0,d.o.indexOf(v))/Math.max(1,d.o.length-1);
  if(d.t==='chk') return v?1:0;
  return d.log ? Math.log(v/d.min)/Math.log(d.max/d.min) : (v-d.min)/(d.max-d.min);
}
function stFromNorm(d,x){
  x=stClamp(x,0,1);
  if(d.t==='sel') return d.o[Math.round(x*(d.o.length-1))];
  if(d.t==='chk') return x>=.5?1:0;
  let v=d.log ? d.min*Math.pow(d.max/d.min,x) : d.min+x*(d.max-d.min);
  if(d.step){ v=Math.round(v/d.step)*d.step; v=+v.toFixed(4); }
  return stClamp(v,d.min,d.max);
}
const stFmt=(d,v)=>{
  if(d.t==='sel') return String(v); if(d.t==='chk') return v?'on':'off';
  const a=Math.abs(v), s=a>=1000?(v/1000).toFixed(a>=10000?1:2)+'k':a>=100?v.toFixed(0):a>=10?v.toFixed(1):a>=1?v.toFixed(2):v.toFixed(3);
  return s+(d.u&&d.u!=='Hz'?' '+d.u:d.u==='Hz'&&a<1000?' Hz':'');
};

/* ---------- кривые для WaveShaper ---------- */
function stDriveCurve(amount,type,n){
  n=n||2048; const c=new Float32Array(n), k=1+amount*(type==='hard'?60:type==='fold'?8:type==='tube'?14:30);
  for(let i=0;i<n;i++){
    const x=i/(n-1)*2-1; let y;
    if(type==='hard') y=stClamp(x*k,-1,1);
    else if(type==='fold'){ y=Math.sin(x*k*1.2); }
    else if(type==='tube') y=Math.tanh(x*k*.5+.15*amount)-Math.tanh(.15*amount);
    else y=Math.tanh(x*k*.5);
    c[i]=y;
  }
  const mx=Math.max(...c.map(Math.abs))||1;
  if(type!=='fold') for(let i=0;i<n;i++) c[i]/=mx;
  return c;
}
function stCrushCurve(bits,n){
  n=n||4096; const c=new Float32Array(n), q=Math.pow(2,bits-1);
  for(let i=0;i<n;i++){ const x=i/(n-1)*2-1; c[i]=Math.round(x*q)/q; }
  return c;
}

/* ---------- импульс ревербератора (детерминированный шум с затуханием и демпфированием) ---------- */
function stReverbIR(sr,size,damp){
  const n=Math.max(1,Math.floor(sr*size)), out=[new Float32Array(n),new Float32Array(n)];
  let seed=1337; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296*2-1; };
  const decay=6.9/size;                         // -60 дБ к концу импульса
  for(let ch=0;ch<2;ch++){
    let lp=0; const o=out[ch];
    for(let i=0;i<n;i++){
      const t=i/sr, env=Math.exp(-decay*t), a=stClamp(1-damp*(.2+.75*Math.min(1,t/size*1.5)),.04,1);
      lp+=a*(rnd()-lp); o[i]=lp*env*(i<sr*.004?i/(sr*.004):1);
    }
  }
  return out;
}

/* ---------- WAV ---------- */
function stWav(L,R,sr,float32){
  const n=L.length, ch=2, bps=float32?4:2, data=n*ch*bps, buf=new ArrayBuffer(44+data), v=new DataView(buf);
  const w=(o,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
  w(0,'RIFF'); v.setUint32(4,36+data,true); w(8,'WAVE'); w(12,'fmt '); v.setUint32(16,16,true);
  v.setUint16(20,float32?3:1,true); v.setUint16(22,ch,true); v.setUint32(24,sr,true); v.setUint32(28,sr*ch*bps,true);
  v.setUint16(32,ch*bps,true); v.setUint16(34,bps*8,true); w(36,'data'); v.setUint32(40,data,true);
  let o=44;
  for(let i=0;i<n;i++) for(const s of [L[i],R[i]]){
    if(float32){ v.setFloat32(o,s,true); o+=4; }
    else{ const x=stClamp(s,-1,1); v.setInt16(o,x<0?x*32768:x*32767,true); o+=2; }
  }
  return buf;
}

/* ---------- проект ---------- */
function stBlankMixer(){
  const m=[];
  for(let i=0;i<=ST_INSERTS;i++) m.push({name:i?'Insert '+i:'Master',vol:i?.8:.85,pan:0,mute:false,solo:false,fx:[],sends:{}});
  return m;
}
function stNewProject(){
  return {v:1,name:'Untitled',bpm:128,swing:0,ids:1,
    channels:[],patterns:[],playlist:{clips:[],loop:null,tracks:12},mixer:stBlankMixer(),samples:{}};
}
const stNextId=P=>P.ids++;
const ST_COLORS=['#e0875f','#e0b23c','#7fd17f','#4ec9b0','#5fb8d1','#569cd6','#b48ade','#e07fb0','#d4d46a','#9ab0b8'];
function stAddChannel(P,type,name,p,mix){
  const defs=ST_CHDEF[type], ch={id:stNextId(P),name:name||type,type,p:stFillP(defs,p),vol:.8,pan:0,mute:false,solo:false,
    mix:mix==null?0:mix,color:ST_COLORS[(P.channels.length)%ST_COLORS.length]};
  P.channels.push(ch); return ch;
}
function stAddPattern(P,name,bars){
  const pat={id:stNextId(P),name:name||'Pattern '+(P.patterns.length+1),bars:bars||1,notes:{}};
  P.patterns.push(pat); return pat;
}
const stPatLen=pat=>pat.bars*ST_BAR;
const stPatNotes=(pat,chId)=>pat.notes[chId]||(pat.notes[chId]=[]);
function stAddClip(P,pat,tr,t,bars){
  const c={id:stNextId(P),kind:'pat',pat:pat.id,tr,t,l:(bars||pat.bars)*ST_BAR}; P.playlist.clips.push(c); return c;
}
function stRemoveChannel(P,id){
  P.channels=P.channels.filter(c=>c.id!==id);
  for(const p of P.patterns) delete p.notes[id];
  P.playlist.clips=P.playlist.clips.filter(c=>!(c.kind==='auto' && c.target.startsWith('ch:'+id+':')));
}
function stRemovePattern(P,id){
  P.patterns=P.patterns.filter(p=>p.id!==id);
  P.playlist.clips=P.playlist.clips.filter(c=>!(c.kind==='pat' && c.pat===id));
}
function stClonePattern(P,pat){
  const c=JSON.parse(JSON.stringify(pat)); c.id=stNextId(P); c.name=pat.name+' copy'; P.patterns.push(c); return c;
}
function stSongEnd(P){ let e=0; for(const c of P.playlist.clips) e=Math.max(e,c.t+c.l); return e; }

// не-JSON-данные (буферы сэмплов) в проект не входят: P.samples хранит только имена
function stLoad(json){
  const o=typeof json==='string' ? JSON.parse(json) : json, P=Object.assign(stNewProject(),o);
  P.mixer=stBlankMixer().map((m,i)=>Object.assign(m,(o.mixer||[])[i]||{}));
  for(const m of P.mixer){ m.sends=m.sends||{}; for(const f of m.fx) f.p=stFillP(ST_FX[f.type].p,f.p); }
  for(const c of P.channels) c.p=stFillP(ST_CHDEF[c.type],c.p);
  P.playlist=Object.assign({clips:[],loop:null,tracks:12},o.playlist||{});
  let mx=0; const see=x=>{ if(x.id>mx) mx=x.id; };
  P.channels.forEach(see); P.patterns.forEach(see); P.playlist.clips.forEach(see);
  P.ids=Math.max(P.ids||1,mx+1);
  return P;
}

/* ---------- сбор нот для планировщика ---------- */
// view: {mode:'song'} или {mode:'pat', pat:id}. Возвращает ноты со стартом в [a,b) тиков:
// {t, l, k, v, ch}. В режиме паттерна он повторяется бесконечно.
function stCollect(P,view,a,b){
  const out=[], byId=new Map(P.patterns.map(p=>[p.id,p]));
  const emit=(pat,base,limit,from,to)=>{              // pat на позиции base, обрезка по limit (абс. тик)
    const L=stPatLen(pat);
    for(const chId in pat.notes){
      for(const n of pat.notes[chId]){
        const rep0=Math.max(0,Math.floor((from-base-n.t)/L)),
          reps=Math.ceil((limit-base)/L);
        for(let r=rep0;r<reps;r++){
          const t=base+r*L+n.t; if(t>=to) break; if(t<from) continue; if(t>=limit) break;
          out.push({t:stSwing(t,P.swing),l:Math.min(n.l,limit-t,L-n.t),k:n.k,v:n.v,ch:+chId});
        }
      }
    }
  };
  if(view.mode==='pat'){
    const pat=byId.get(view.pat); if(pat) emit(pat,0,Infinity,a,b);
  }else{
    for(const c of P.playlist.clips){
      if(c.kind!=='pat' || c.t+c.l<=a || c.t>=b) continue;
      const pat=byId.get(c.pat); if(pat) emit(pat,c.t,c.t+c.l,Math.max(a,c.t),b);
    }
  }
  out.sort((x,y)=>x.t-y.t);
  return out;
}

/* ---------- автоматизация ---------- */
// клип auto: {kind:'auto', tr, t, l, target:'mix:3:vol' | 'fx:3:0:cut' | 'ch:5:cut', pts:[[t,v01],…]}, t — от начала клипа
function stAutoAt(clip,tick){
  const p=clip.pts, x=tick-clip.t;
  if(!p.length) return null;
  if(x<=p[0][0]) return p[0][1];
  for(let i=1;i<p.length;i++) if(x<=p[i][0]){
    const a=p[i-1], b=p[i], f=b[0]===a[0]?1:(x-a[0])/(b[0]-a[0]); return a[1]+(b[1]-a[1])*f;
  }
  return p[p.length-1][1];
}
// последняя в плейлисте автоматизация цели в тике (клип действует только на своём отрезке)
function stAutoValue(P,target,tick){
  let best=null;
  for(const c of P.playlist.clips) if(c.kind==='auto' && c.target===target && tick>=c.t && tick<c.t+c.l){
    const v=stAutoAt(c,tick); if(v!=null && (!best || c.t>=best.t)) best={t:c.t,v};
  }
  return best?best.v:null;
}
// определение параметра по адресу цели
function stTargetDef(P,target){
  const s=target.split(':');
  if(s[0]==='mix'){ const d={vol:{k:'vol',min:0,max:1.25,step:.01,d:.8,label:'volume'},pan:{k:'pan',min:-1,max:1,step:.01,d:0,label:'pan'}}[s[2]]; return d||null; }
  if(s[0]==='fx'){ const f=P.mixer[+s[1]]?.fx[+s[2]]; return f ? ST_FX[f.type].p.find(d=>d.k===s[3])||null : null; }
  if(s[0]==='ch'){ const c=P.channels.find(c=>c.id===+s[1]); return c ? ST_CHDEF[c.type].find(d=>d.k===s[2])||null : null; }
  return null;
}

/* ---------- пресеты синтезатора ---------- */
const ST_PATCHES={
  'Init':{},
  'Supersaw Lead':{w1:'saw',w2:'saw',l2:.7,dt2:12,uni:5,det:28,spr:.8,cut:6500,res:1.2,a:.01,d:.3,s:.75,r:.25,vol:.5},
  'Trance Pluck':{w1:'saw',w2:'square',l2:.4,uni:3,det:14,cut:900,res:3,fenv:3,fd:.18,fs:0,fr:.2,a:.003,d:.22,s:0,r:.18,vol:.6},
  'Reese Bass':{w1:'saw',w2:'saw',l2:.9,dt2:18,o1:-1,o2:-1,uni:3,det:16,cut:1100,res:2.5,lt:'cutoff',lr:.25,ld:.35,a:.005,d:.2,s:.9,r:.12,mono:1,drv:.35,vol:.6},
  'Sub Bass':{w1:'sine',l1:.9,sub:.5,o1:-1,cut:700,res:.7,a:.005,d:.1,s:1,r:.08,mono:1,vol:.8},
  'Acid 303':{w1:'saw',l1:.9,o1:-1,cut:350,res:14,fenv:3.2,fd:.22,fs:0,fr:.15,a:.002,d:.18,s:.55,r:.06,mono:1,gl:.06,drv:.4,vol:.55},
  'Warm Pad':{w1:'saw',w2:'tri',l2:.7,dt2:9,uni:4,det:22,spr:1,cut:2200,res:.8,fenv:1,fa:1.2,fd:1.5,fs:.5,fr:1.5,a:.9,d:1,s:.8,r:1.6,vol:.45},
  'Soft Keys':{w1:'tri',w2:'sine',l2:.6,o2:1,cut:5200,res:.6,a:.004,d:.9,s:.25,r:.4,vol:.7},
  'Hoover':{w1:'saw',w2:'saw',l2:1,dt2:30,uni:5,det:45,spr:.9,o1:-1,cut:3800,res:2,lt:'pitch',lr:5,ld:.08,a:.02,d:.3,s:.9,r:.25,drv:.5,vol:.4},
  'FM Bell':{w1:'sine',w2:'sine',l2:0,o2:2,s2:7,fm:.35,cut:12000,a:.002,d:1.2,s:0,r:1,vol:.7},
  'Arp Square':{w1:'square',l1:.7,w2:'saw',l2:.3,cut:3200,res:2,fenv:2,fd:.15,fs:.1,a:.002,d:.15,s:.2,r:.1,vol:.55},
  'Wobble':{w1:'saw',w2:'square',l2:.6,o1:-1,o2:-1,cut:500,res:6,lt:'cutoff',lr:3,ld:.8,a:.003,d:.1,s:1,r:.1,mono:1,drv:.5,vol:.55}
};
const stPatchP=name=>stFillP(ST_SYNTH,ST_PATCHES[name]);

/* ---------- пресеты ударных ---------- */
const ST_KITS={
  'Kick 909':{kind:'kick',pit:0,dec:1,tone:.4,pun:.6,drv:.1},'Kick Deep':{kind:'kick',pit:-4,dec:1.6,tone:.2,pun:.4,drv:.0},
  'Kick Hard':{kind:'kick',pit:2,dec:.8,tone:.7,pun:.9,drv:.5},
  'Snare':{kind:'snare',tone:.5,dec:1},'Clap':{kind:'clap',dec:1,tone:.5},
  'Closed Hat':{kind:'chat',dec:1,tone:.6},'Open Hat':{kind:'ohat',dec:1,tone:.6},
  'Tom':{kind:'tom',pit:0,dec:1},'Rim':{kind:'rim'},'Cowbell':{kind:'perc'},'Crash':{kind:'crash',dec:1}};

/* ---------- демо-проект: техно/хаус, слышно сразу ---------- */
function stDemoProject(){
  const P=stNewProject(); P.name='Demo: Night Drive'; P.bpm=126;
  const kick=stAddChannel(P,'drum','Kick',ST_KITS['Kick 909'],1);
  const clap=stAddChannel(P,'drum','Clap',ST_KITS.Clap,2);
  const hat=stAddChannel(P,'drum','Hat',ST_KITS['Closed Hat'],3);
  const oh=stAddChannel(P,'drum','Open Hat',ST_KITS['Open Hat'],3);
  const bass=stAddChannel(P,'synth','Bass',stPatchP('Reese Bass'),4);
  const pad=stAddChannel(P,'synth','Pad',stPatchP('Warm Pad'),5);
  const lead=stAddChannel(P,'synth','Lead',stPatchP('Trance Pluck'),6);
  const arp=stAddChannel(P,'synth','Arp',stPatchP('Arp Square'),7);
  kick.vol=.95; bass.vol=.8; pad.vol=.6; lead.vol=.7; arp.vol=.55; hat.vol=.55; oh.vol=.5; clap.vol=.75;
  const names=['Kick','Drums','Bass','Chords','Lead','Arp'];
  const m=P.mixer; const set=(i,n,v)=>{ m[i].name=n; m[i].vol=v; };
  set(1,'Kick',.9); set(2,'Clap',.75); set(3,'Hats',.6); set(4,'Bass',.8); set(5,'Pad',.7); set(6,'Lead',.75); set(7,'Arp',.6);
  set(8,'Reverb',.75); set(9,'Delay',.7);
  const fx=(i,type,p)=>m[i].fx.push({id:stNextId(P),type,on:true,p:stFillP(ST_FX[type].p,p)});
  fx(1,'comp',{thr:-14,ratio:3}); fx(4,'pump',{depth:.85,rel:.5}); fx(4,'eq',{hi:-4}); fx(5,'pump',{depth:.7,rel:.55}); fx(5,'chorus',{mix:.35});
  fx(6,'dist',{drive:.15,mix:.5,type:'tube'}); fx(7,'pump',{depth:.5});
  fx(8,'reverb',{size:3.2,mix:1,damp:.6}); fx(9,'delay',{div:'1/8.',fb:.45,mix:1});
  m[6].sends[8]=.25; m[6].sends[9]=.3; m[5].sends[8]=.3; m[7].sends[9]=.35; m[2].sends[8]=.2; m[3].sends[8]=.1;
  fx(0,'eq',{lo:1,hi:1.5}); fx(0,'comp',{thr:-10,ratio:2,gain:2,att:.03});
  const N=(arr,ch,t,l,k,v)=>arr.notes[ch.id].push({t,l,k,v:v||100});
  const pat=(name,bars,chs)=>{ const p=stAddPattern(P,name,bars); chs.forEach(c=>p.notes[c.id]=[]); return p; };
  const ps=ST_STEP;
  const drums=pat('Drums',1,[kick,clap,hat,oh]);
  for(let i=0;i<4;i++) N(drums,kick,i*4*ps,ps,60,120);
  N(drums,clap,4*ps,ps,60,105); N(drums,clap,12*ps,ps,60,105);
  for(let i=0;i<16;i++) if(i%4!==2) N(drums,hat,i*ps,ps,60,i%2?55:80);
  for(let i=2;i<16;i+=4) N(drums,oh,i*ps,ps,60,90);
  const kickOnly=pat('Kick only',1,[kick]); for(let i=0;i<4;i++) N(kickOnly,kick,i*4*ps,ps,60,120);
  // Am – F – C – G
  const roots=[45,41,48,43], chords=[[57,60,64],[53,57,60],[55,60,64],[55,59,62]];
  const bp=pat('Bass',4,[bass]), cp=pat('Chords',4,[pad]), lp=pat('Lead',4,[lead]), ap=pat('Arp',4,[arp]);
  for(let c=0;c<4;c++){
    const b=c*ST_BAR;
    for(let i=0;i<16;i++) if(i%4!==0) N(bp,bass,b+i*ps,ps*(i%4===3?1:1),roots[c]+(i%8===7?12:0),i%4===2?100:85);
    for(const k of chords[c]) N(cp,pad,b,ST_BAR,k,80);
    const lk=[chords[c][2]+12,chords[c][1]+12,chords[c][2]+12,chords[c][0]+19];
    [0,3,6,10,12].forEach((s,j)=>N(lp,lead,b+s*ps,ps*2,lk[j%4],95));
    for(let i=0;i<16;i++) N(ap,arp,b+i*ps,ps,chords[c][i%3]+12+(i%8>=4?12:0),i%4===0?100:70);
  }
  const pl=P.playlist.clips, add=(pt,tr,bar,bars)=>stAddClip(P,pt,tr,bar*ST_BAR,bars);
  add(kickOnly,0,0,4); add(drums,0,4,28); add(bp,1,4,24); add(cp,2,0,28); add(lp,3,12,16); add(ap,4,8,20);
  add(bp,1,4+24,4);
  P.playlist.loop=[0,32*ST_BAR];
  return P;
}
