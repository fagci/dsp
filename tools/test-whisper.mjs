// Whisper (логика без сети и модели): node tools/test-whisper.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array,Set,String,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/whisper-kernels.js'),'utf8')+';this.T={wsTo16k,wsSegmenter,wsJunk,wsLoop,wsAppend,wsFileName,wsStamp};',ctx);
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
ok('loop',T.wsLoop(Array(20).fill('ha').join(' '))&&!T.wsLoop('one two three four five six seven eight nine ten eleven twelve'));
ok('append caps and cuts on a word',T.wsAppend('aaa bbb ccc','ddd',9)==='ccc ddd' && T.wsAppend('','x',9)==='x',T.wsAppend('aaa bbb ccc','ddd',9));
ok('file name',T.wsFileName('https://huggingface.co/onnx-community/whisper-tiny/resolve/main/onnx/encoder_model_quantized.onnx')==='Whisper · onnx-community/whisper-tiny · onnx/encoder_model_quantized.onnx'
  && T.wsFileName('https://example.com/a')===null);
ok('stamp',T.wsStamp(65)==='[1:05]' && T.wsStamp(-3)==='[0:00]');
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
