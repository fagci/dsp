"use strict";
/* ============================ Notes (Basic Pitch, neural) ============================
   Нейросеть Basic Pitch (Spotify, Apache-2.0, ~0.9 МБ) слышит несколько нот сразу — аккорды, мелодию, голос, любой инструмент.
   Работает на TF.js (общий с Object Detect) в браузере. Раз в period секунд берётся последние ≈2 с звука, пересчитываются в 22050 Гц и
   прогоняются через модель; звучащие ноты — по последним кадрам окна (≈0.1 с назад). Логика — pitchnn-kernels.js, тест tools/test-pitchnn.mjs.
   Файлы (vendor/basicpitch/, запасного адреса нет) один раз попадают в Files → Offline data вместе с TF.js. */

const BPN_FILES=[['Basic Pitch model.json','vendor/basicpitch/model.json'],['Basic Pitch weights (group1-shard1of1.bin)','vendor/basicpitch/group1-shard1of1.bin']];
OfflineData.fileItem({id:'basicpitch',label:'Notes: Basic Pitch model and TF.js',mb:2,
  files:[[OD_LOCAL[0][0],[OD_LOCAL[0][1],OD_LOCAL[0][2]]], ...BPN_FILES.map(f=>[f[0],[f[1]]])]});

const BPN={p:null, model:null, err:'', backend:''};
function bpnLoad(backend){
  if(BPN.p) return BPN.p;
  return BPN.p=(async()=>{
    await odTf();
    if(backend && backend!=='auto' && tf.getBackend()!==backend) await tf.setBackend(backend);
    await tf.ready();
    const fs=[new File([await OfflineData.blob(BPN_FILES[0][0],[BPN_FILES[0][1]])],'model.json'),
              new File([await OfflineData.blob(BPN_FILES[1][0],[BPN_FILES[1][1]])],'group1-shard1of1.bin')];
    BPN.model=await tf.loadGraphModel(tf.io.browserFiles(fs));
    BPN.backend=tf.getBackend();
  })().catch(e=>{ BPN.err=String(e.message||e); BPN.p=null; });
}
// окно → кадры [172 × 88]; вызов тяжёлый (десятки-сотни мс), поэтому только раз в period
function bpnRun(x22){
  return tf.tidy(()=>{
    const out=BPN.model.execute(tf.tensor(x22,[1,BP_N,1]),'Identity_1');      // frames
    return out.dataSync();
  });
}

def({ id:'pitchnn', title:'Notes (Basic Pitch, neural)', cat:'Analysis', readout:true, tall:true, w:260, resize:true,
  kw:'notes pitch midi chord polyphonic music transcription basic pitch spotify neural network ai melody tuner',
  // in — звук; text — звучащие ноты («C4 E4 G4»); n — их число; midi, hz — самая сильная; rec — событие при появлении ноты
  ins:[{n:'in',t:'sig'}],
  outs:[{n:'text',t:'txt'},{n:'n',t:'num'},{n:'midi',t:'num'},{n:'hz',t:'num'},{n:'rec',t:'rec'}],
  params:[{n:'period',t:'range',min:.25,max:4,step:.05,d:.5,label:'analyse every, s'},
          {n:'thr',t:'range',min:.1,max:.9,step:.01,d:.3,label:'note threshold (lower — more notes)'},
          {n:'backend',t:'select',opts:['auto','webgl','cpu'],d:'auto',label:'compute (cpu — slower, no GPU driver)',adv:true}],
  init(n){ n.ring=null; n.rsr=0; n.t=0; n.list=[]; n.q=[]; n.busy=false; n.status='loading Basic Pitch…'; n.rev=0; n.gen=0; },
  dispose(n){ n.gen++; n.ring=null; },
  process(n,I){
    const sr=Eng.sr;
    if(!n.ring || n.rsr!==sr){ n.ring=ynRing(Math.round(sr*BP_N/BP_SR)); n.rsr=sr; }
    n.ring.push(I.in||buf(n,'z'));
    if(!BPN.model){ bpnLoad(n.p.backend); n.status=BPN.err ? 'error: '+BPN.err : 'loading TF.js and the model (about 2 MB, once — then kept in Files → Offline data)…'; }
    else{
      n.t+=BLOCK/sr;
      if(n.t>=n.p.period && n.ring.filled>=n.ring.N && !n.busy){
        n.t=0; n.busy=true;
        const x=ynTo16k(n.ring.get(),BP_N), gen=n.gen, t0=performance.now();      // ynTo16k(x,N) — окно ровно N отсчётов любой частоты
        setTimeout(()=>{                                                           // тяжёлое — вне блока обработки
          try{
            if(gen!==n.gen) return;
            const act=bpActive(bpnRun(x),n.p.thr), fresh=bpNew(n.list,act);
            for(const a of fresh) n.q.push({t:Date.now(),src:'pitchnn',label:a.name,midi:a.midi,hz:+a.hz.toFixed(2),score:+a.p.toFixed(3)});
            n.list=act; n.rev++;
            n.status=bpText(act)+'\n· '+(performance.now()-t0).toFixed(0)+' ms · '+BPN.backend;
          }catch(e){ n.status='error: '+(e.message||e); }
          finally{ n.busy=false; }
        },0);
      }
    }
    const top=n.list.reduce((a,b)=>!a||b.p>a.p ? b : a,null), rec=n.q.length ? n.q.splice(0) : null;
    return {text:bpText(n.list), n:n.list.length, midi:top?top.midi:0, hz:top?top.hz:0, rec}; },
  drawKey:n=>n.status,
  draw(n){ const r=n.el.querySelector('.readout'); if(r) r.textContent=n.status; }});
