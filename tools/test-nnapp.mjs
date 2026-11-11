// Нейросети на телефоне (TFLite): modules/nn-app.js, разбор выходов Basic Pitch и YAMNet: node tools/test-nnapp.mjs
// Эталоны (tools/fixtures) сняты с настоящих моделей nmp.tflite и yamnet.tflite: аккорд до-мажор (C4 E4 G4) и синус 1 кГц.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sent=[]; let bridge=async()=>({}); const sockets=[]; const offline=[];
class FakeWS{
  constructor(url){ this.url=url; this.readyState=0; sockets.push(this); setTimeout(()=>{ this.readyState=1; this.onopen&&this.onopen(); },1); }
  send(s){ const m=JSON.parse(s); sent.push(m); if(m.cmd) Promise.resolve(bridge(m,this)).then(r=>{ if(r===null) return; setTimeout(()=>this.onmessage({data:JSON.stringify({src:'cmd',cmd:m.cmd,id:m.id,ok:!r.err,...(r.err?{err:'error',msg:r.err}:{}),...r})}),0); }); }
  close(){ this.readyState=3; this.onclose&&this.onclose(); }
}
const ctx=vm.createContext({String,Number,Math,Array,Object,Set,Map,Promise,JSON,Uint8Array,Float32Array,Date,parseInt,isFinite,setTimeout,clearTimeout,Error,performance,
  btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
  WebSocket:FakeWS, window:{DspApp:{appKey:()=>'k'}}, DspApp:{appKey:()=>'k'}, phoneUrl:(u,k)=>u+'/?key='+k, OfflineData:{item:o=>offline.push(o)}});
const read=f=>fs.readFileSync(path.join(root,'modules/'+f),'utf8');
vm.runInContext(['netsock-kernels.js','applink.js','pitchnn-kernels.js','yamnet-kernels.js','yamnet-labels.js','nn-app.js'].map(read).join('\n')+';this.X={NN,NN_BP,NN_YN,nnB64,nnFromB64,nnEnsure,nnRun,nnReady,nnWhere,bpPickNote,bpActive,bpText,BP_FRAMES,BP_BINS,ynTopScores,YN_LABELS,AppLink};',ctx);
const X=ctx.X;

// --- тензоры
const f=new Float32Array([0,1,-1,.5,3.4e8,1e-30]);
const back=X.nnFromB64(X.nnB64(f)); ok('tensor: float32 → base64 → float32',back.length===6 && [...back].every((v,i)=>v===f[i]));
const sub=new Float32Array(10).subarray(2,5); sub[0]=7; ok('tensor: a view of a bigger array is encoded by its own bytes',X.nnFromB64(X.nnB64(sub))[0]===7 && X.nnFromB64(X.nnB64(sub)).length===3);
ok('tensor: a known pattern (1.0 = 00 00 80 3f)',Buffer.from(X.nnB64(new Float32Array([1])),'base64').equals(Buffer.from([0,0,0x80,0x3f])));
ok('tensor: a long window encodes without call-stack limits',X.nnFromB64(X.nnB64(new Float32Array(43844))).length===43844);

// --- Basic Pitch: разбор выходов настоящей модели
const fx=JSON.parse(fs.readFileSync(path.join(root,'tools/fixtures/bp-chord-note.json'),'utf8'));
const note=new Float32Array(172*88); fx.frames.forEach((fr,k)=>{ for(const [b,v] of fr) note[(fx.from+k)*88+b]=v; });
const onset=new Float32Array(172*88); onset[10*88+39]=.9;                  // onset — всплеск в начале окна
const contour=new Float32Array(172*264);
const outs=[{name:'StatefulPartitionedCall:2',shape:[1,172,88],data:onset},{name:'StatefulPartitionedCall:1',shape:[1,172,88],data:note},{name:'StatefulPartitionedCall:0',shape:[1,172,264],data:contour}];
ok('basic pitch: the «note» output is found by name (order of outputs does not matter)',X.bpPickNote(outs)===note && X.bpPickNote([outs[1],outs[0],outs[2]])===note);
ok('basic pitch: without names the denser of the two [172,88] outputs is taken',X.bpPickNote(outs.map(o=>({shape:o.shape,data:o.data})))===note);
ok('basic pitch: nothing suitable → null',X.bpPickNote([outs[2]])===null && X.bpPickNote([])===null && X.bpPickNote(null)===null);
const act=X.bpActive(X.bpPickNote(outs),.3);
ok('basic pitch: the real model on a C major chord → C4 E4 G4',X.bpText(act)==='C4 E4 G4' && act.map(a=>a.midi).join()==='60,64,67',X.bpText(act));
ok('basic pitch: a lower threshold finds no fewer notes',X.bpActive(note,.1).length>=3);

// --- YAMNet
const labels=X.YN_LABELS;
ok('yamnet labels: 521 names in the order of the model',labels.length===521 && labels[0]==='Speech' && labels[494]==='Silence' && labels[495]==='Sine wave' && labels[475]==='Beep, bleep' && labels.every(l=>typeof l==='string' && l.length));
const top=JSON.parse(fs.readFileSync(path.join(root,'tools/fixtures/yn-sine-top.json'),'utf8')); const sc=new Float32Array(521); for(const [i,v] of top) sc[i]=v;
const t=X.ynTopScores(sc,labels,3,.05);
ok('yamnet: scores of the real model on a 1 kHz sine → «Beep, bleep» on top, sorted, limited',t.length===3 && t[0].label==='Beep, bleep' && Math.abs(t[0].score-.738)<1e-3 && t[1].score>=t[2].score,JSON.stringify(t));
ok('yamnet: the minimum share and an unknown index',X.ynTopScores(sc,labels,5,.5).length===1 && X.ynTopScores(sc,null,1,.5)[0].label==='class 475' && X.ynTopScores(new Float32Array(521),labels,5,.1).length===0);

// --- связь: модель на телефоне, запуск
ok('Files → offline: YAMNet on the phone is registered (the app only)',offline.length===1 && offline[0].id==='nn-app-yamnet' && /phone/.test(offline[0].label));
let have=[]; const info={model:'x',delegate:'gpu',note:'',ms:40,inputs:[{name:'in',shape:[1,43844,1],type:'float32'}],outputs:outs.map(o=>({name:o.name,shape:o.shape,type:'float32'}))};
bridge=async(m)=>{
  if(m.cmd==='model.list') return {models:have.map(n=>({name:n,size:1,partial:false}))};
  if(m.cmd==='model.get'){ have.push(m.name); await wait(10); return {name:m.name,size:204448}; }
  if(m.cmd==='nn.load') return {...info,model:m.model};
  if(m.cmd==='nn.run') return {ms:3,outputs:outs.map(o=>({name:o.name,shape:o.shape,data:X.nnB64(o.data)}))};
  return {err:'unknown'};
};
sent.length=0; const r1=await X.nnEnsure(X.NN_BP,true);
const cmds=sent.filter(m=>m.cmd);
ok('ensure (the model is inside the app): list → get from the assets → load, no network address',cmds.map(m=>m.cmd).join()==='model.list,model.get,nn.load' && cmds[1].asset==='vendor/basicpitch/nmp.tflite' && cmds[1].name==='nmp.tflite' && !('url' in cmds[1]));
ok('ensure: GPU asked, the delegate comes back, the node can say where it runs',cmds[2].gpu===true && r1.delegate==='gpu' && X.nnReady(X.NN_BP,true) && !X.nnReady(X.NN_BP,false) && X.nnWhere(X.NN_BP)==='GPU (TFLite)');
sent.length=0; await X.nnEnsure(X.NN_BP,true); ok('ensure: the same settings again — no commands',sent.filter(m=>m.cmd).length===0);
sent.length=0; await X.nnEnsure(X.NN_BP,false); ok('ensure: another delegate → load again, no copy',sent.filter(m=>m.cmd).map(m=>m.cmd).join()==='model.list,nn.load' && sent.find(m=>m.cmd==='nn.load').gpu===false);
const p1=X.nnEnsure(X.NN_YN,true), p2=X.nnEnsure(X.NN_YN,true); await Promise.all([p1,p2]);
ok('ensure (a model by address): one download for two simultaneous callers',sent.filter(m=>m.cmd==='model.get' && m.name==='yamnet.tflite').length===1 && sent.find(m=>m.name==='yamnet.tflite' && m.cmd==='model.get').url.startsWith('https://storage.googleapis.com/mediapipe-models/') );
info.delegate='cpu'; info.note='the GPU delegate does not support this phone — CPU'; X.NN.ready={}; await X.nnEnsure(X.NN_BP,true);
ok('ensure: a GPU refusal is shown in the node (CPU, with the reason)',/^CPU \(TFLite\) · the GPU delegate does not support/.test(X.nnWhere(X.NN_BP)),X.nnWhere(X.NN_BP));
sent.length=0; const o=await X.nnRun('nmp.tflite',[new Float32Array(43844)]);
ok('run: one input tensor goes as base64, outputs come back as arrays',Buffer.from(sent.find(m=>m.cmd==='nn.run').inputs[0],'base64').length===43844*4 && o.length===3 && o[1].data.length===172*88 && o[1].name==='StatefulPartitionedCall:1');
ok('run → pick → decode: the whole way gives the chord',X.bpText(X.bpActive(X.bpPickNote(o),.3))==='C4 E4 G4');
bridge=async(m)=>m.cmd==='nn.load' ? {err:'input «x» is INT8 — only float32 models are supported'} : {models:[{name:'bad.tflite',partial:false}]};
X.NN.ready={}; const e1=await X.nnEnsure({name:'bad.tflite'},true).then(()=>null,e=>e);
ok('ensure: the reason from the phone is passed on, nothing stays «ready»',e1 && /float32/.test(e1.message) && !X.NN.ready['bad.tflite'] && X.NN.prog['bad.tflite']==='' && !X.NN.loading['bad.tflite']);
bridge=async()=>({err:'model «x» is not loaded (nn.load)'}); const e2=await X.nnRun('x.tflite',[new Float32Array(1)]).then(()=>null,e=>e); ok('run: an error from the phone is thrown',e2 && /not loaded/.test(e2.message));
bridge=async()=>({models:[{name:'yamnet.tflite',partial:false}]}); ok('offline item: has() — a finished file',await offline[0].has()===true);
bridge=async()=>({models:[{name:'yamnet.tflite',partial:true}]}); ok('offline item: a partial file does not count',await offline[0].has()===false);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
