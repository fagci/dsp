// Языковые модели на телефоне: modules/llm-app.js и узел Ollama с хостом «app»: node tools/test-llmapp.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const wait=ms=>new Promise(r=>setTimeout(r,ms));

const sent=[]; let bridge=async()=>({}); const sockets=[]; const defs={};
class FakeWS{
  constructor(url){ this.url=url; this.readyState=0; sockets.push(this); setTimeout(()=>{ this.readyState=1; this.onopen&&this.onopen(); },1); }
  send(s){ const m=JSON.parse(s); sent.push(m); if(m.cmd) Promise.resolve(bridge(m,this)).then(r=>{ if(r===null) return; this.recv({src:'cmd',cmd:m.cmd,id:m.id,ok:!r.err,...(r.err?{err:'error',msg:r.err}:{}),...r}); }); }
  recv(rec){ setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify(rec)}),0); }
  close(){ this.readyState=3; this.onclose&&this.onclose(); }
}
const offline=[]; const store={};
const ctx=vm.createContext({String,Number,Math,Array,Object,Set,Map,Promise,JSON,Uint8Array,TextEncoder,TextDecoder,Date,parseInt,parseFloat,isFinite,encodeURIComponent,decodeURIComponent,URL,
  setTimeout,clearTimeout,Error,TypeError,AbortController,performance,btoa:s=>Buffer.from(s,'binary').toString('base64'),
  WebSocket:FakeWS, window:{DspApp:{appKey:()=>'k1'}}, DspApp:{appKey:()=>'k1'}, phoneUrl:(u,k)=>u+'/?key='+k, OfflineData:{item:o=>offline.push(o)},
  localStorage:{getItem:k=>k in store ? store[k] : null,setItem:(k,v)=>{ store[k]=String(v); }},
  fetch:async()=>{ throw new TypeError('Failed to fetch'); }, Net:{app:true,proxy:'',mode:'off',need:new Set(),needs:()=>false,url:u=>u},
  def:d=>{ defs[d.id]=d; }, setMod:(n,k,v)=>{ n.p[k]=v; }, recNum:v=>typeof v==='number'&&isFinite(v)?v:null, recList:v=>Array.isArray(v)?v:v?[v]:[], GeoMe:{lat:null,lon:null}});
const read=f=>fs.readFileSync(path.join(root,'modules/'+f),'utf8');
vm.runInContext(['netsock-kernels.js','applink.js','netdata-kernels.js','llm-app.js','netdata.js'].map(read).join('\n')+';this.X={AppLink,LLMAP,LLM_CATALOG,llmSpec,llmAppModels,llmAppLoad,llmAppRun};',ctx);
const X=ctx.X;
const node=(p={})=>{ const d=defs.ollama; const n={p:{...Object.fromEntries(d.params.filter(q=>q.d!==undefined).map(q=>[q.n,q.d])),host:'app',...p},el:null}; d.init(n); return n; };
const ask=n=>defs.ollama.params.find(p=>p.n==='ask').fn(n);

// --- чистое
const q=X.llmSpec('qwen2.5-3b-instruct-q4_0');
ok('spec: a catalog key → file and address',q.name==='qwen2.5-3b-instruct-q4_0.gguf' && q.url.startsWith('https://huggingface.co/Qwen/') && q.mb>1000 && X.llmSpec('QWEN2.5-1.5B-INSTRUCT-Q4_0.gguf').name==='qwen2.5-1.5b-instruct-q4_0.gguf');
const u=X.llmSpec('https://example.org/m/My%20Model-Q4_0.gguf?download=1'), u2=X.llmSpec('https://h/path/x');
ok('spec: an address → a safe file name',u.name==='My_Model-Q4_0.gguf' && u.url.startsWith('https://example.org') && u2.name==='x.gguf');
ok('spec: a file on the phone (no address)',X.llmSpec('my-model.gguf').url==='' && X.llmSpec('my-model').name==='my-model.gguf');
ok('spec: junk refused',X.llmSpec('')===null && X.llmSpec('../x.gguf')===null && X.llmSpec('a b.gguf')===null && X.llmSpec('a/b')===null);
ok('catalog: Q4_0 models with sizes and notes (Q4_0 is what the Adreno kernels like)',Object.keys(X.LLM_CATALOG).length>=3 && Object.keys(X.LLM_CATALOG).every(k=>/q4_0$/.test(k) && X.LLM_CATALOG[k].mb>0 && X.LLM_CATALOG[k].note));
ok('Files → offline: catalog models are registered',offline.map(o=>o.id).join()===Object.keys(X.LLM_CATALOG).map(k=>'llm-app-'+k).join() && offline.every(o=>/phone/.test(o.label)));

// --- мост: подставной телефон
const caps={arm64:true,dotprod:true,fp16:true,opencl:true,availMb:4000,ramMb:11000};
let have=[]; const answer=['Прив','ет, ','мир!'];
bridge=async(m,ws)=>{
  if(m.cmd==='ai.caps') return caps;
  if(m.cmd==='model.list') return {models:have.map(n=>({name:n,size:5e8,partial:false})).concat([{name:'ggml-x.bin',size:1,partial:false},{name:'half.gguf',size:1,partial:true}])};
  if(m.cmd==='model.get'){ ws.recv({src:'ai',ev:'progress',name:m.name,done:50,total:200}); ws.recv({src:'ai',ev:'progress',name:m.name,done:200,total:200}); await wait(30); have.push(m.name); return {name:m.name,size:200}; }
  if(m.cmd==='llm.load') return {info:'x|1|8192|'+m.ctx,backends:'CPU:CPU;GPU:OpenCL',ms:900,model:m.model,gpu:!!m.gpu,ctx:m.ctx};
  if(m.cmd==='llm.chat'){ for(const t of answer){ await wait(15); ws.recv({src:'ai',ev:'tok',rid:m.id,text:t}); } await wait(40); return {text:answer.join(''),tokens:3,promptTokens:12,ms:400,tps:7.5,ptps:60,trimmed:0,cached:9}; }
  if(m.cmd==='llm.bench') return {best:4,fast:4,rows:[{threads:2,tps:5.1,ptps:20},{threads:4,tps:9.8,ptps:41},{threads:6,tps:8.2,ptps:39}]};
  if(m.cmd==='llm.stop') return {};
  return {err:'unknown'};
};
// --- модели на телефоне
let n=node(); await defs.ollama.params.find(p=>p.n==='list').fn(n);
ok('models: nothing local yet — the catalog is offered, a model is picked',n.models.length===0 && n.cat.length===Object.keys(X.LLM_CATALOG).length && n.p.model===Object.keys(X.LLM_CATALOG)[0] && n.msg==='');
have=['mine-q4_0.gguf']; n=node(); await defs.ollama.params.find(p=>p.n==='list').fn(n);
ok('models: only finished .gguf files count, the first becomes the model',n.models.length===1 && n.models[0].name==='mine-q4_0.gguf' && n.p.model==='mine-q4_0.gguf');
ok('models: the output pin lists the local ones',defs.ollama.process(n,{}).models==='mine-q4_0.gguf');
have=[];

// --- чат: скачать, загрузить, ответ по токенам
sent.length=0; n=node({model:'qwen2.5-1.5b-instruct-q4_0',prompt:'Привет',sys:'Кратко'}); defs.ollama.process(n,{}); const seen=[];
const t=setInterval(()=>{ if(n.text) seen.push(n.text); },5);
await ask(n); clearInterval(t);
const cmds=sent.filter(m=>m.cmd).map(m=>m.cmd);
ok('chat: caps → list → get → load → chat',cmds.join()==='ai.caps,model.list,model.get,llm.load,llm.chat',cmds.join());
ok('chat: the model is fetched by its catalog name and address',sent.find(m=>m.cmd==='model.get').name==='qwen2.5-1.5b-instruct-q4_0.gguf' && /huggingface\.co\/Qwen\//.test(sent.find(m=>m.cmd==='model.get').url));
const cm=sent.find(m=>m.cmd==='llm.chat');
ok('chat: system + question in messages, options go on',cm.messages[0].role==='system' && cm.messages[0].content==='Кратко' && cm.messages.at(-1).content==='Привет' && cm.max===512 && cm.temp===.7);
ok('chat: GPU asked, context 4096 by default',sent.find(m=>m.cmd==='llm.load').gpu===true && sent.find(m=>m.cmd==='llm.load').ctx===4096);
ok('chat: tokens arrive one by one, the answer is assembled',seen.length>=2 && n.last==='Привет, мир!' && n.text==='Привет, мир!' && n.hist.length===2,JSON.stringify([seen,n.last,n.msg]));
ok('chat: speed and counts from the phone',n.stats.tokens===3 && n.stats.tps===7.5 && n.stats.promptTokens===12 && n.stats.total===.4);
const r1=defs.ollama.process(n,{}); ok('chat: record with the model as the author, a pulse, the speed output',r1.rec && r1.rec.from==='qwen2.5-1.5b-instruct-q4_0' && r1.rec.text==='Привет, мир!' && r1.new===1 && r1.tps===7.5);
sent.length=0; await ask(n);
ok('chat: the next question — no download, no reload; the dialogue goes on',sent.filter(m=>m.cmd).map(m=>m.cmd).join()==='llm.chat' && sent[0].messages.some(x=>x.role==='assistant' && x.content==='Привет, мир!'));
ok('chat: the status of the loaded model',X.LLMAP.info.includes('GPU') && X.LLMAP.info.includes('context 4096'));
// другие настройки
sent.length=0; n=node({model:'mine-q4_0.gguf',prompt:'x',appGpu:false,numCtx:2048,maxTok:128,temp:.2}); have=['mine-q4_0.gguf']; defs.ollama.process(n,{}); await ask(n);
ok('chat: CPU, own context and answer length reach the phone',sent.find(m=>m.cmd==='llm.load').gpu===false && sent.find(m=>m.cmd==='llm.load').ctx===2048 && sent.find(m=>m.cmd==='llm.chat').max===128 && sent.find(m=>m.cmd==='llm.chat').temp===.2 && !sent.some(m=>m.cmd==='model.get'));

// скорость: кэш запроса в статусе, потоки, бенчмарк
ok('speed: tokens of the prompt taken from the KV cache are reported by the node',n.stats.cached===9);
sent.length=0; n=node({model:'mine-q4_0.gguf',prompt:'x',threads:4}); have=['mine-q4_0.gguf']; defs.ollama.process(n,{}); await ask(n);
ok('speed: the thread count goes with the request (not into a reload)',sent.find(m=>m.cmd==='llm.chat').threads===4 && !('threads' in sent.find(m=>m.cmd==='llm.load')));
sent.length=0; n=node({model:'mine-q4_0.gguf',prompt:'x'}); defs.ollama.process(n,{}); await ask(n);
ok('speed: threads 0 → the app chooses (the fast cores)',!('threads' in sent.find(m=>m.cmd==='llm.chat')));
sent.length=0; n=node({model:'mine-q4_0.gguf'}); defs.ollama.process(n,{}); await defs.ollama.params.find(p=>p.n==='bench').fn(n);
ok('benchmark: the best thread count is set in the node and the table is shown',sent.some(m=>m.cmd==='llm.bench') && n.p.threads===4 && /4 threads: 9\.8 tok\/s/.test(n.msg) && /◀ best/.test(n.msg) && !n.busy,n.msg);
n=node({host:'http://127.0.0.1:11434',model:'m'}); await defs.ollama.params.find(p=>p.n==='bench').fn(n); ok('benchmark: not for a server host',/host «app» only/.test(n.msg));
n=node({model:''}); await defs.ollama.params.find(p=>p.n==='bench').fn(n); ok('benchmark: needs a model',/choose a model/.test(n.msg));
// отмена
bridge=async(m,ws)=>{ if(m.cmd==='llm.chat'){ ws.recv({src:'ai',ev:'tok',rid:m.id,text:'Нач'}); await wait(300); return {err:'stopped'}; } return {models:[{name:'mine-q4_0.gguf',size:1,partial:false}],gpu:true,ctx:2048,info:'',...(m.cmd==='ai.caps'?caps:{})}; };
sent.length=0; n=node({model:'mine-q4_0.gguf',prompt:'long'}); defs.ollama.process(n,{}); const pa=ask(n); await wait(150);
n.acs.c.abort(); await pa;
ok('stop: llm.stop goes to the phone, the part already written is kept',sent.some(m=>m.cmd==='llm.stop') && n.msg==='stopped' && n.text==='Нач' && n.last==='Нач',n.msg);
// ошибки
bridge=async(m)=>m.cmd==='ai.caps' ? {...caps,dotprod:false} : {};
n=node({model:'mine-q4_0.gguf',prompt:'x'}); defs.ollama.process(n,{}); X.LLMAP.ready=''; await ask(n);
ok('unsupported phone: a clear reason in the status',/dotprod/.test(n.msg) && /failed/.test(n.msg),n.msg);
bridge=async(m)=>m.cmd==='ai.caps' ? caps : m.cmd==='model.list' ? {models:[]} : {};
n=node({model:'nofile.gguf',prompt:'x'}); defs.ollama.process(n,{}); X.LLMAP.ready=''; X.LLMAP.unsupported=false; await ask(n);
ok('a file that is not on the phone and has no address: says what to do',/no file/.test(n.msg) && /Models/.test(n.msg),n.msg);
bridge=async(m)=>m.cmd==='ai.caps' ? caps : m.cmd==='model.list' ? {models:[{name:'mine-q4_0.gguf',size:1,partial:false}]} : m.cmd==='llm.load' ? {err:'not enough memory: the model needs about 2000 MB free'} : {};
n=node({model:'mine-q4_0.gguf',prompt:'x'}); defs.ollama.process(n,{}); X.LLMAP.ready=''; await ask(n);
ok('load error from the phone is shown, no CORS advice',/not enough memory/.test(n.msg) && !/OLLAMA_ORIGINS/.test(n.msg),n.msg);
n=node({model:'bad name',prompt:'x'}); defs.ollama.process(n,{}); await ask(n); ok('bad model name is refused',/not valid/.test(n.msg),n.msg);
// вне приложения
delete ctx.DspApp; ctx.window.DspApp=undefined;
const nn=node({model:'mine-q4_0.gguf',prompt:'x'}); defs.ollama.process(nn,{}); await ask(nn);
ok('host «app» outside the app: a clear message',/only in the DSP app/.test(nn.msg),nn.msg);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
