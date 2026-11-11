// Whisper (логика без сети и модели): node tools/test-whisper.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array,Set,String,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/whisper-kernels.js'),'utf8')+';this.T={wsTo16k,wsSegmenter,wsDraftDue,wsDraftNext,wsMergeJobs,wsQueueSec,wsJunk,wsLoop,wsDeloop,wsAppend,wsFileName,wsStamp,wsManualName,wsFileUrl,WS_FILES};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// пересчёт: длина, частота синуса, постоянная составляющая
for(const sr of [48000,44100,16000,8000]){
  const N=sr, x=new Float32Array(N); for(let i=0;i<N;i++) x[i]=.5*Math.sin(2*Math.PI*440*i/sr)+.1;
  const y=T.wsTo16k(x,sr);
  let zc=0, dc=0, pk=0; for(let i=1;i<y.length;i++){ dc+=y[i]; if(y[i-1]-.1<0 && y[i]-.1>=0) zc++; pk=Math.max(pk,Math.abs(y[i]-.1)); }
  ok('16k from '+sr,y.length===16000 && Math.abs(zc-440)<=2 && Math.abs(dc/y.length-.1)<.01 && pk>.4 && pk<.55,'len '+y.length+' f '+zc+' dc '+(dc/y.length).toFixed(3)+' pk '+pk.toFixed(2));
}
ok('16k copies',T.wsTo16k(Float32Array.of(1,2,3),16000).join()==='1,2,3');

// нарезка: 1 с тишины, 2 с «речи», 1.5 с тишины, 1 с речи, тишина
const sr=8000, B=128;
const seg=T.wsSegmenter(sr,{thr:.02,pre:.3,hang:.6,max:25,min:.3});
const got=[]; let t=0;
const feed=(sec,amp)=>{ for(let k=0;k<Math.round(sec*sr/B);k++){ const b=new Float32Array(B); for(let i=0;i<B;i++) b[i]=amp*Math.sin(2*Math.PI*300*(t++)/sr)+(Math.random()-.5)*.0005; for(const s of seg.push(b)) got.push(s); } };
feed(1,0); feed(2,.3); feed(1.5,0); feed(1,.3); feed(1.5,0);
ok('two phrases',got.length===2,got.length+' '+got.map(s=>(s.length/sr).toFixed(2)).join(','));
if(got.length===2){
  const d0=got[0].length/sr, d1=got[1].length/sr;
  ok('phrase 1 length = pre + speech + hang',d0>2.5 && d0<3.2,d0.toFixed(2));
  ok('phrase 2 length',d1>1.6 && d1<2.2,d1.toFixed(2));
}
// слишком долгая речь режется по max
const s2=T.wsSegmenter(sr,{thr:.02,pre:.2,hang:.6,max:3,min:.3}), g2=[]; t=0;
for(let k=0;k<Math.round(7*sr/B);k++){ const b=new Float32Array(B); for(let i=0;i<B;i++) b[i]=.3*Math.sin(2*Math.PI*300*(t++)/sr); for(const s of s2.push(b)) g2.push(s); }
ok('long speech is cut at max',g2.length===2 && g2.every(s=>s.length/sr<=3.05),g2.length+': '+g2.map(s=>s.length/sr).join(','));
ok('flush ends the current phrase',s2.flush().length===1 && s2.flush().length===0);
// щелчок короче min выбрасывается
const s3=T.wsSegmenter(sr,{thr:.02,pre:0,hang:.5,max:25,min:.3}), g3=[];
for(let k=0;k<40;k++) for(const s of s3.push(new Float32Array(B))) g3.push(s);
{ const b=new Float32Array(B).fill(.5); for(const s of s3.push(b)) g3.push(s); }
for(let k=0;k<80;k++) for(const s of s3.push(new Float32Array(B))) g3.push(s);
ok('click is dropped',g3.length===0,String(g3.length));
// постоянный шум не считается речью: полка поднимается вместе с ним
const s4=T.wsSegmenter(sr,{thr:.001,pre:.2,hang:.5,max:25,min:.3}), g4=[]; t=0;
for(let k=0;k<Math.round(10*sr/B);k++){ const b=new Float32Array(B); for(let i=0;i<B;i++) b[i]=(Math.random()-.5)*.1; for(const s of s4.push(b)) g4.push(s); }
ok('steady noise gives few phrases',g4.length<=1,String(g4.length));

ok('junk',['', ' . ',' [BLANK_AUDIO] ','(music)','Thank you.','Thanks for watching!','Спасибо за просмотр','♪♪'].every(T.wsJunk));
ok('real text is not junk',!T.wsJunk('Thank you for the report, we are moving on')&&!T.wsJunk('Привет, как дела')&&!T.wsJunk('Break one, over'));
ok('deloop',T.wsDeloop('Сегодня в Москве слово слово слово слово слово дальше')==='Сегодня в Москве слово дальше'&&T.wsDeloop('да нет да нет да нет да нет конец')==='да нет конец'&&T.wsDeloop('очень очень хорошо')==='очень очень хорошо'&&T.wsDeloop('Привет, как дела')==='Привет, как дела');
ok('loop',T.wsLoop(Array(20).fill('ha').join(' '))&&!T.wsLoop('one two three four five six seven eight nine ten eleven twelve'));
ok('append caps and cuts on a word',T.wsAppend('aaa bbb ccc','ddd',9)==='ccc ddd' && T.wsAppend('','x',9)==='x',T.wsAppend('aaa bbb ccc','ddd',9));
ok('file name',T.wsFileName('https://huggingface.co/onnx-community/whisper-tiny/resolve/main/onnx/encoder_model_quantized.onnx')==='Whisper · onnx-community/whisper-tiny · onnx/encoder_model_quantized.onnx'
  && T.wsFileName('https://example.com/a')===null);
ok('stamp',T.wsStamp(65)==='[1:05]' && T.wsStamp(-3)==='[0:00]');
ok('manual name: onnx goes to onnx/',T.wsManualName('a/b','encoder_model_quantized (1).onnx')==='Whisper · a/b · onnx/encoder_model_quantized.onnx'
  && T.wsManualName('a/b','C:\\x\\tokenizer.json')==='Whisper · a/b · tokenizer.json');
ok('manual names match the automatic ones',T.WS_FILES.every(f=>T.wsFileName(T.wsFileUrl('a/b',f))===T.wsManualName('a/b',f.split('/').pop())));
// --- черновик идущей фразы (peek, wsDraftDue, wsDraftNext)
{ const sr=16000, sg=T.wsSegmenter(sr,{thr:.02,pre:.2,hang:.7,max:25,min:.3});
  const tone=n=>{ const a=new Float32Array(n); for(let i=0;i<n;i++) a[i]=.3*Math.sin(i*.2); return a; };
  ok('draft: no phrase → nothing to peek',sg.peek()===null && !sg.speaking && sg.seconds===0 && sg.quiet===0);
  for(let i=0;i<5;i++) sg.push(tone(3200));                                   // 1 с речи
  const pk=sg.peek();
  ok('draft: the running phrase is available as a copy, with its length',sg.speaking && pk && pk.length>=16000 && Math.abs(sg.seconds-pk.length/sr)<1e-6);
  pk[0]=99; ok('draft: peek is a copy (the phrase is not changed)',sg.peek()[0]!==99);
  sg.push(new Float32Array(3200)); ok('draft: the pause so far is counted',Math.abs(sg.quiet-.2)<1e-6);
  const done=[]; for(let i=0;i<5;i++) done.push(...sg.push(new Float32Array(3200)));
  ok('draft: after the phrase ends nothing is left to peek, the phrase came out whole',sg.peek()===null && done.length===1 && done[0].length>=16000);
}
const due={on:true,ready:true,draftBusy:false,busy:false,jobs:0,speaking:true,seconds:2,minSec:1.2,quiet:0,hang:.7,now:10,at:5};
ok('draft due: all conditions met',T.wsDraftDue(due)===true);
ok('draft not due: off / model not loaded / a draft already runs',!T.wsDraftDue({...due,on:false}) && !T.wsDraftDue({...due,ready:false}) && !T.wsDraftDue({...due,draftBusy:true}));
ok('draft not due: a final phrase is being recognised or waits',!T.wsDraftDue({...due,busy:true}) && !T.wsDraftDue({...due,jobs:2}));
ok('draft not due: nobody speaks, phrase too short, pause about to end it',!T.wsDraftDue({...due,speaking:false}) && !T.wsDraftDue({...due,seconds:.8}) && !T.wsDraftDue({...due,quiet:.5}) && T.wsDraftDue({...due,quiet:.3}));
ok('draft not due: too early',!T.wsDraftDue({...due,now:4.9}) && T.wsDraftDue({...due,now:5}));
ok('draft next: at least «every» s, and 1.3× what the last one took',T.wsDraftNext(1000,200,1.5)===2500 && T.wsDraftNext(1000,4000,1.5)===1000+5200);

// --- очередь отстаёт: склейка фраз (wsMergeJobs), отброс только за две минуты звука
{ const job=(sec,v)=>({audio:new Float32Array(sec*16000).fill(v),sec:0});
  ok('merge: nothing queued → null',T.wsMergeJobs([],28,.3)===null);
  const one=T.wsMergeJobs([job(3,1)],28,.3); ok('merge: one job stays as it is',one.taken===1 && one.job.audio.length===48000 && !one.job.merged);
  const m3=T.wsMergeJobs([job(3,1),job(2,2),job(4,3)],28,.3);
  ok('merge: phrases one after another with a 0.3 s gap of silence, in order',m3.taken===3 && m3.job.merged===3 && m3.job.audio.length===(3+2+4)*16000+2*4800 && m3.job.audio[0]===1 && m3.job.audio[3*16000+100]===0 && m3.job.audio[3*16000+4800+10]===2 && m3.job.audio.at(-1)===3);
  const lim=T.wsMergeJobs([job(10,1),job(10,2),job(10,3),job(2,4)],28,.3);
  ok('merge: not longer than the window (28 s): two phrases fit, the rest wait for the next round',lim.taken===2 && lim.job.audio.length===20*16000+4800);
  const big=T.wsMergeJobs([job(20,1),job(20,2)],28,.3); ok('merge: a phrase that does not fit is left alone',big.taken===1 && big.job.audio.length===20*16000);
  const fst=T.wsMergeJobs([job(3,1),job(2,2)],28,.3); ok('merge: the time of the first phrase is kept (for the stamps)',fst.job.sec===0);
  ok('queue length in seconds',Math.abs(T.wsQueueSec([job(3,0),job(2.5,0)])-5.5)<1e-9 && T.wsQueueSec([])===0);
  // как узел: 7 фраз по 3 с ждут — две склейки вместо семи распознаваний
  const q=Array.from({length:7},(_,i)=>job(3,i+1)); let runs=0, merged=0, left=0;
  while(q.length){ const mm=q.length>=2 ? T.wsMergeJobs(q,28,.3) : {job:q[0],taken:1}; q.splice(0,mm.taken); runs++; merged+=mm.job.merged||0; left+=mm.job.audio.length; }
  ok('merge: seven 3 s phrases in the queue are recognised in 1 round (they fit in 28 s) — none is lost',runs===1 && merged===7 && left===7*3*16000+6*4800);
}

console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
