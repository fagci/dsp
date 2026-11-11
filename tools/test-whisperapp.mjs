// Whisper на телефоне: связь с мостом и движок «app» (modules/applink.js, whisper-app.js): node tools/test-whisperapp.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const wait=ms=>new Promise(r=>setTimeout(r,ms));

// «мост»: сценарий ответов по командам; ws.send разбирает JSON и отвечает записями
const sent=[]; let bridge=async()=>({}); const sockets=[];
class FakeWS{
  constructor(url){ this.url=url; this.readyState=0; sockets.push(this); setTimeout(()=>{ this.readyState=1; this.onopen&&this.onopen(); },1); }
  send(s){ const m=JSON.parse(s); sent.push(m); if(m.cmd) Promise.resolve(bridge(m,this)).then(r=>{ if(r===null) return; this.recv({src:'cmd',cmd:m.cmd,id:m.id,ok:!r.err,...(r.err?{err:'error',msg:r.err}:{}),...r}); }); }
  recv(rec){ setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify(rec)}),0); }
  close(){ this.readyState=3; this.onclose&&this.onclose(); }
}
const offline=[];
const ctx=vm.createContext({String,Number,Math,Array,Object,Set,Map,Promise,JSON,Uint8Array,Int16Array,Float32Array,TextEncoder,TextDecoder,Date,parseInt,isFinite,encodeURIComponent,decodeURIComponent,URL,
  setTimeout,clearTimeout,Error,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
  WebSocket:FakeWS, window:{DspApp:{appKey:()=>'k1'}}, DspApp:{appKey:()=>'k1'}, phoneUrl:(u,k)=>u+'/?key='+k, OfflineData:{item:o=>offline.push(o)}, performance});
const read=f=>fs.readFileSync(path.join(root,'modules/'+f),'utf8');
vm.runInContext(read('netsock-kernels.js')+'\n'+read('applink.js')+'\n'+read('whisper-app.js')+';this.X={AppLink,WAP,WAP_MODELS,wapFile,wapUrl,wapCustom,wapB64,wapCapsLine,wapLoad,wapRun,wapGet,wapHas,wapFastOn};',ctx);
const X=ctx.X;

// --- чистое
ok('model files and urls',X.wapFile('large-v3-turbo-q5_0')==='ggml-large-v3-turbo-q5_0.bin' && X.wapUrl('small-q5_1')==='https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin');
ok('the list has the Russian-capable models with sizes',X.WAP_MODELS['large-v3-turbo-q5_0'].mb>500 && X.WAP_MODELS['medium-q5_0'] && X.WAP_MODELS['small-q5_1'].mb<200);
const c1=X.wapCustom('https://example.org/models/my%20model%20v2.bin?x=1'), c2=X.wapCustom('https://h/path/ggml-x');
ok('custom model: a safe name from the address',c1.name==='my_model_v2.bin' && c1.url.startsWith('https://example.org') && c2.name==='ggml-x.bin' && X.wapCustom('file:///x.bin')===null && X.wapCustom('')===null && X.wapCustom('https://h/../../x.bin').name==='x.bin');
const f=new Float32Array([0,.5,-.5,1,-1,2,-2]); const b=Buffer.from(X.wapB64(f),'base64'); const i16=new Int16Array(b.buffer,b.byteOffset,b.length/2);
ok('pcm: float → s16le → base64 (clipped, symmetric)',i16.length===7 && i16[0]===0 && i16[1]===16384 && i16[2]===-16384 && i16[3]===32767 && i16[4]===-32768 && i16[5]===32767 && i16[6]===-32768,String([...i16]));
const big=X.wapB64(new Float32Array(300000)); ok('pcm: a long phrase encodes without call-stack limits',Buffer.from(big,'base64').length===600000);
ok('caps line',X.wapCapsLine({soc:'Qualcomm SM8650',dotprod:true,i8mm:true,opencl:true,availMb:3000,ramMb:11000}).includes('OpenCL ✓') && X.wapCapsLine({dotprod:false,opencl:false,availMb:100,ramMb:2000}).includes('dotprod ✗') && X.wapCapsLine(null)==='');

// --- связь
ok('Files → offline: the three phone models are registered (the app only)',offline.map(o=>o.id).join()==='whisper-app-large-v3-turbo-q5_0,whisper-app-medium-q5_0,whisper-app-small-q5_1' && offline.every(o=>o.mb>0 && /phone/.test(o.label)));
const caps={arm64:true,dotprod:true,i8mm:false,fp16:true,opencl:true,cores:8,ramMb:11000,availMb:4000,soc:'Qualcomm SM8650'};
let have=[]; const ev=[]; let gpuReply=null;
bridge=async(m,ws)=>{
  if(m.cmd==='ai.caps') return caps;
  if(m.cmd==='model.list') return {models:have.map(n=>({name:n,size:1,partial:false}))};
  if(m.cmd==='model.get'){ ws.recv({src:'ai',ev:'progress',name:m.name,done:100,total:400}); ws.recv({src:'ai',ev:'progress',name:m.name,done:400,total:400}); await wait(30); have.push(m.name); return {name:m.name,size:400}; }
  if(m.cmd==='asr.load') return {backends:'CPU:CPU|x',ms:2500,model:m.model,gpu:gpuReply===null ? !!m.gpu : gpuReply};
  if(m.cmd==='asr.run') return {text:'  Привет, мир.  ',segs:1,ms:1500,audioMs:3000};
  return {err:'unknown'};
};
const un=X.AppLink.on(r=>ev.push(r));
const cc=await X.AppLink.call('ai.caps'); 
ok('link: one connection, subscribes to net and ai, key from the app',sockets.length===1 && sockets[0].url.endsWith('?key=k1') && sent[0].sub.join()==='net,ai',JSON.stringify([sockets.length,sockets[0]?.url,sent[0]]));
ok('link: a command gets its reply',cc.dotprod===true && cc.soc==='Qualcomm SM8650');
await X.AppLink.call('model.list'); ok('link: the connection is reused',sockets.length===1);
sockets[0].recv({src:'ai',ev:'seg',text:'x'}); await wait(10);
ok('link: non-net records go to the hooks',ev.length===1 && ev[0].ev==='seg');
un(); sockets[0].recv({src:'ai',ev:'seg',text:'y'}); await wait(10); ok('link: a hook can be removed',ev.length===1);
sockets[0].close(); await X.AppLink.call('ai.caps'); ok('link: reconnects after the bridge closed',sockets.length===2);

// --- загрузка модели и распознавание
sent.length=0; const app={name:'ggml-medium-q5_0.bin',url:X.wapUrl('medium-q5_0'),gpu:true,beam:3,fastMode:'auto',prompt:'Привет'};
const progs=[]; const t=setInterval(()=>progs.push(X.WAP.prog),5);
await X.wapLoad(app); clearInterval(t);
const cmds=sent.filter(m=>m.cmd).map(m=>m.cmd);
ok('load: caps → list → get → load, in this order',cmds.join()==='ai.caps,model.list,model.get,asr.load' || cmds.join()==='model.list,model.get,asr.load',cmds.join());
ok('load: the model is fetched by its name and address',sent.find(m=>m.cmd==='model.get').name===app.name && sent.find(m=>m.cmd==='model.get').url===app.url);
ok('load: asks for the GPU',sent.find(m=>m.cmd==='asr.load').gpu===true && sent.find(m=>m.cmd==='asr.load').model===app.name);
ok('load: progress of the download is shown',progs.some(s=>/downloading .*\d+% · /.test(s)),JSON.stringify([...new Set(progs)]));
ok('load: ready, the engine says GPU',X.WAP.ready===app.name+'|gpu' && /GPU/.test(X.WAP.info) && X.WAP.prog==='');
sent.length=0; await X.wapLoad(app); ok('load: the same settings again — no commands',sent.filter(m=>m.cmd).length===0);
await X.wapLoad({...app,gpu:false}); ok('load: switching the backend loads again, without a download',sent.filter(m=>m.cmd).map(m=>m.cmd).join()==='model.list,asr.load' && X.WAP.ready===app.name+'|cpu',sent.map(m=>m.cmd).join());
sent.length=0; const r=await X.wapRun(new Float32Array(48000),{language:'ru',task:'transcribe',app});
const rm=sent.find(m=>m.cmd==='asr.run');
ok('run: phrase sent as base64 with the options',rm && Buffer.from(rm.pcm,'base64').length===96000 && rm.lang==='ru' && rm.translate===false && rm.beam===3 && rm.prompt==='Привет' && rm.fast===false);
ok('run: text trimmed, time and audio length come back',r.text==='Привет, мир.' && r.ms===1500 && r.audioMs===3000);
await X.wapRun(new Float32Array(16000),{language:'auto',task:'translate',app}); ok('run: translate goes to the phone',sent.filter(m=>m.cmd==='asr.run').at(-1).translate===true);

// --- короткое окно энкодера: auto — когда GPU не подключён; почему CPU при просьбе о GPU
ok('fast window: auto follows the backend (full window on the GPU, short on the CPU), on / off are respected, a forced draft always short',
   (()=>{ X.WAP.gpuOn=true; const g=[X.wapFastOn({fastMode:'auto'}),X.wapFastOn({fastMode:'off'}),X.wapFastOn({fastMode:'on'}),X.wapFastOn({fastMode:'off',fast:true})];
          X.WAP.gpuOn=false; const c=[X.wapFastOn({fastMode:'auto'}),X.wapFastOn({fastMode:'off'}),X.wapFastOn({fastMode:'on'}),X.wapFastOn({})]; return g.join()==='false,false,true,true' && c.join()==='true,false,true,true'; })());
X.WAP.ready=''; gpuReply=true; sent.length=0; await X.wapLoad({...app,gpu:true}); await X.wapRun(new Float32Array(16000),{language:'ru',task:'transcribe',app:{...app,gpu:true}});
ok('fast window: on the GPU (auto) the phrase goes with the full window',sent.find(m=>m.cmd==='asr.run').fast===false && X.WAP.why==='' && /GPU/.test(X.WAP.info));
X.WAP.ready=''; gpuReply=false; X.WAP.caps={...X.WAP.caps,opencl:false}; sent.length=0; await X.wapLoad({...app,gpu:true}); await X.wapRun(new Float32Array(16000),{language:'ru',task:'transcribe',app:{...app,gpu:true}});
ok('fast window: no GPU (auto) → the short window, and the reason is told (no OpenCL on this phone)',sent.find(m=>m.cmd==='asr.run').fast===true && /no OpenCL library/.test(X.WAP.why) && /^CPU \(no OpenCL library/.test(X.WAP.info),X.WAP.info);
X.WAP.ready=''; X.WAP.caps={...X.WAP.caps,opencl:true}; await X.wapLoad({...app,gpu:true});
ok('fast window: OpenCL present but no supported GPU → another reason (Adreno 7xx / 8xx)',/Adreno 7xx/.test(X.WAP.why));
sent.length=0; await X.wapRun(new Float32Array(16000),{language:'ru',task:'transcribe',app:{...app,gpu:true,fastMode:'off'}});
ok('fast window: «off» keeps the full window even on the CPU',sent.find(m=>m.cmd==='asr.run').fast===false);
X.WAP.ready=''; gpuReply=null;

// --- смена модели во время загрузки предыдущей: загрузки идут по очереди, последняя побеждает, ничего не зависает
{ const order=[]; const old=bridge; let slow=true;
  bridge=async(m,ws)=>{ if(m.cmd==='asr.load'){ order.push('load:'+m.model); if(slow){ slow=false; await wait(60); } return {backends:'CPU:CPU|x',ms:10,model:m.model,gpu:false}; } return old(m,ws); };
  X.WAP.ready=''; X.WAP.loading=null; gpuReply=null;
  const A={...app,name:'ggml-small-q5_1.bin',url:X.wapUrl('small-q5_1'),gpu:false}, B={...app,name:'ggml-medium-q5_0.bin',gpu:false};
  const pa=X.wapLoad(A), pb=X.wapLoad(B); await Promise.all([pa,pb]);
  ok('model change while another loads: both loads happen one after the other (the phone takes them in turn), the last one stays',order.join()==='load:ggml-small-q5_1.bin,load:ggml-medium-q5_0.bin' && X.WAP.ready==='ggml-medium-q5_0.bin|cpu' && X.WAP.loading===null,order.join()+' ready='+X.WAP.ready);
  const p3=X.wapLoad(B); ok('the same model again is instant',await Promise.race([p3.then(()=>'done'),wait(20).then(()=>'slow')])==='done');
  bridge=old; }
// две фразы подряд — по очереди
const order=[]; bridge=async(m)=>{ if(m.cmd==='asr.run'){ order.push('start'); await wait(30); order.push('end'); return {text:'a',ms:1,audioMs:1}; } return {models:[{name:app.name,partial:false}],gpu:true,backends:'',ms:0}; };
await Promise.all([X.wapRun(new Float32Array(16000),{app}),X.wapRun(new Float32Array(16000),{app})]);
ok('run: phrases are processed one at a time',order.join()==='start,end,start,end',order.join());
// телефон без dotprod
X.WAP.ready=''; X.WAP.caps=null; bridge=async(m)=>m.cmd==='ai.caps' ? {...caps,dotprod:false} : {};
const e1=await X.wapLoad(app).then(()=>null,e=>e);
ok('unsupported phone: a clear error, and the node can fall back to the browser',e1 && /dotprod/.test(e1.message) && X.WAP.unsupported===true);
// ошибка движка
X.WAP.unsupported=false; X.WAP.caps=null; bridge=async(m)=>m.cmd==='ai.caps' ? caps : m.cmd==='model.list' ? {models:[{name:app.name,partial:false}]} : {err:'not enough memory: the model needs about 650 MB free'};
const e2=await X.wapLoad(app).then(()=>null,e=>e); ok('load error from the phone is passed on, nothing stays «ready»',e2 && /not enough memory/.test(e2.message) && X.WAP.ready==='' && X.WAP.loading===null);
// has()
bridge=async()=>({models:[{name:'ggml-medium-q5_0.bin',partial:false},{name:'ggml-small-q5_1.bin',partial:true}]});
ok('offline item: has() — a finished file only',await offline[1].has()===true && await offline[2].has()===false && await offline[0].has()===false);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
