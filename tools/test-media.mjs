// Голос и видео в пакетах: node tools/test-media.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,JSON,Map,Set,Uint8Array,Float32Array,Int16Array,ArrayBuffer,String,Array,Object,console,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/link-kernels.js'),'utf8')+';'+fs.readFileSync(path.join(root,'modules/media-kernels.js'),'utf8')+';this.K={MD_CODEC,MD_INFO,MD_HDR,mdTag,mdPack,mdUnpack,mdSeqNewer,mdUlawEnc,mdUlawDec,MdResampler,MdJitter,mdWrap,MD_WRAPS,lkFramer};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const rms=x=>Math.sqrt(x.reduce((a,v)=>a+v*v,0)/x.length);
const sine=(f,sr,n,a=.5,ph=0)=>Float32Array.from({length:n},(_,i)=>a*Math.sin(2*Math.PI*f*(i+ph)/sr));

// ---- заголовок ----
const f8=n=>Uint8Array.from({length:8},(_,i)=>n+i);
let u=K.mdPack(K.MD_CODEC.c2_1600,K.mdTag('voice'),513,[f8(1),f8(20),f8(40)]), m=K.mdUnpack(u);
ok('codec2 packet: header and fixed-size frames',m && m.codec===3 && m.tag===K.mdTag('voice') && m.seq===513 && m.nf===3 && m.frames.every((f,i)=>f.length===8 && f[0]===[1,20,40][i]) && u.length===5+24);
const op=[Uint8Array.from({length:37},(_,i)=>i),Uint8Array.from({length:5},(_,i)=>200+i)];
m=K.mdUnpack(K.mdPack(K.MD_CODEC.opus,7,65535,op));
ok('opus packet: variable frames carry a length',m && m.nf===2 && m.frames[0].length===37 && m.frames[1][4]===204 && m.seq===65535);
const jp=Uint8Array.from({length:3000},(_,i)=>i&255);
m=K.mdUnpack(K.mdPack(K.MD_CODEC.jpeg,9,1,[jp])); ok('jpeg unit: one frame, bytes intact',m && m.codec===16 && m.frames[0].length===3000 && m.frames[0][299]===(299&255));
ok('garbage is not a packet',!K.mdUnpack(new Uint8Array([1,2,3])) && !K.mdUnpack(new Uint8Array([99,0,0,1,1,5,5])) && !K.mdUnpack(K.mdPack(3,0,0,[f8(0)]).subarray(0,9)) && !K.mdUnpack(null));
ok('label tag is stable and differs',K.mdTag('a')===K.mdTag('a') && K.mdTag('voice')!==K.mdTag('video') && K.mdTag('')>=0);
ok('sequence compare wraps',K.mdSeqNewer(2,65534) && !K.mdSeqNewer(65534,2) && !K.mdSeqNewer(5,5) && K.mdSeqNewer(0,null));

// ---- μ-law ----
{
  const x=sine(440,8000,800,.6).map(v=>Math.round(v*32767)); const y=x.map(v=>K.mdUlawDec(K.mdUlawEnc(v)));
  let e=0,s=0; for(let i=0;i<x.length;i++){ e+=(x[i]-y[i])**2; s+=x[i]**2; }
  ok('μ-law: SNR over 30 dB on speech-level sine',10*Math.log10(s/e)>30,(10*Math.log10(s/e)).toFixed(1));
  ok('μ-law: silence and sign',K.mdUlawDec(K.mdUlawEnc(0))===0 && K.mdUlawDec(K.mdUlawEnc(20000))>0 && K.mdUlawDec(K.mdUlawEnc(-20000))<0);
}
// ---- ресемплер ----
{
  const up=new K.MdResampler(8000,48000), y=up.push(sine(1000,8000,4000));
  ok('8k→48k: 6× samples',Math.abs(y.length-24000)<100,String(y.length));
  const mid=y.slice(6000,18000); ok('8k→48k: amplitude kept',Math.abs(rms(mid)-.5/Math.SQRT2)<.02,rms(mid).toFixed(3));
  let zc=0; for(let i=1;i<mid.length;i++) if(mid[i-1]<0 && mid[i]>=0) zc++; ok('8k→48k: tone stays at 1 kHz',Math.abs(zc/(mid.length/48000)-1000)<20,String(zc));
  const dn=new K.MdResampler(48000,8000), a=dn.push(sine(1000,48000,24000)), b=dn.push(sine(1000,48000,24000,.5,24000));
  ok('48k→8k: 1 kHz passes',Math.abs(rms(a.slice(40))-.5/Math.SQRT2)<.03,rms(a.slice(40)).toFixed(3));
  const dn2=new K.MdResampler(48000,8000), h=dn2.push(sine(6000,48000,24000)); ok('48k→8k: 6 kHz (would alias) is suppressed',rms(h.slice(40))<.05,rms(h.slice(40)).toFixed(3));
  const w1=new K.MdResampler(8000,48000), w2=new K.MdResampler(8000,48000), x=sine(700,8000,3000);
  const whole=w1.push(x); const parts=[...w2.push(x.slice(0,777)),...w2.push(x.slice(777,1500)),...w2.push(x.slice(1500))];
  ok('chunked input gives the same output',whole.length===parts.length && whole.every((v,i)=>Math.abs(v-parts[i])<1e-5));
}
// ---- jitter ----
const pk=(seq,len=160)=>Float32Array.from({length:len},(_,i)=>seq+i/1000);     // отсчёты помечены номером пакета
const drain=(j,n)=>{ const o=[]; for(let i=0;i<n;i++) o.push(...j.pull(160)); return Float32Array.from(o); };
{
  const j=new K.MdJitter(8000,60); for(let s=0;s<5;s++) j.push(s,pk(s));
  const o=drain(j,5); ok('in order: all samples come out',o.length===800 && o[0]===0 && o[160]===1 && o[799]>4 && j.stat.lost===0);
}
{
  const j=new K.MdJitter(8000,60); j.push(0,pk(0)); ok('waits for the pre-buffer, silence meanwhile',j.pull(160).every(v=>v===0)); j.push(1,pk(1)); j.push(2,pk(2));
  const o=drain(j,3); ok('then plays from the start',Math.floor(o[0])===0 && Math.floor(o[160])===1 && Math.floor(o[320])===2);
}
{
  const j=new K.MdJitter(8000,60); for(const s of [0,2,1,3,4]) j.push(s,pk(s));
  const o=drain(j,5); ok('reordered packets are put in order',[0,1,2,3,4].every(s=>Math.floor(o[s*160])===s) && j.stat.late===0);
}
{
  const j=new K.MdJitter(8000,60); for(const s of [0,1,3,4,5]) j.push(s,pk(s));
  const o=drain(j,6); ok('a lost packet is concealed: length is kept, the gap fades out',o.length===960 && j.stat.lost===1 && Math.floor(o[480])===3 && o[320]<=1.2*.7+1e-6 && Math.abs(o[479])<.05);
  ok('concealment is not louder than the previous packet',Math.max(...o.slice(320,480).map(Math.abs))<=Math.max(...o.slice(160,320).map(Math.abs)));
}
{
  const j=new K.MdJitter(8000,60); for(let s=0;s<3;s++) j.push(s,pk(s)); drain(j,3); j.push(1,pk(1));
  ok('a late packet is dropped',j.stat.late===1);
  const o=j.pull(160); ok('empty queue: silence and re-buffering',o.every(v=>v===0) && j.stat.under>=1 && !j.playing);
  j.push(3,pk(3)); j.push(4,pk(4)); j.push(5,pk(5)); ok('plays again after the pre-buffer, no concealment for the pause',Math.floor(j.pull(160)[0])===3 && j.stat.lost===0);
}
{
  const j=new K.MdJitter(8000,40,200); for(let s=0;s<30;s++) j.push(s,pk(s)); ok('queue is capped, oldest dropped',j.queued<=200*8+160 && j.stat.dropped>0,String(j.queued));
  ok('and playing continues from the oldest kept',Math.floor(j.pull(160)[0])>0);
}
{
  const j=new K.MdJitter(8000,40); for(let s=500;s<504;s++) j.push(s,pk(s)); drain(j,4);
  for(let s=0;s<40;s++) j.push(s,pk(s));
  ok('sender restart (numbers start again) is accepted after a while',j.stat.late===26 && j.q.size>0 && j.next!==null);
}
{
  const j=new K.MdJitter(8000,40); for(const s of [0,1,500,501,502]) j.push(s,pk(s));
  const o=drain(j,6); ok('a big jump of numbers resyncs, no endless concealment',j.stat.lost<=1 && o.some(v=>Math.floor(v)===500),String(j.stat.lost));
}
{
  const j=new K.MdJitter(8000,40); for(const s of [65534,65535,0,1]) j.push(s,pk(s)); const o=drain(j,4);
  ok('numbers wrap around u16',Math.floor(o[0])===65534 && Math.floor(o[480])===1 && j.stat.lost===0);
}
// ---- обёртка для байтового канала разбирается кадровщиком Packet Link ----
{
  const rnd=(n,seed)=>{ let x=seed; return Uint8Array.from({length:n},()=>(x=(Math.imul(x,1103515245)+12345)>>>0)>>>24); };
  const pk=[rnd(40,1),Uint8Array.from([0xC0,0xDB,0,0xDC,0xDD,0,0,0xC0]),rnd(1,3),rnd(253,4),rnd(254,5),rnd(255,6),Uint8Array.from({length:30},(_,i)=>i%3===0 ? 0 : i)];
  for(const w of K.MD_WRAPS.slice(1)){
    const kind=w.split(' ')[0], fr=K.lkFramer(kind,70000);
    const stream=[]; for(const p of pk) stream.push(...K.mdWrap(kind,p));
    const got=[]; const all=Uint8Array.from(stream);
    for(let i=0;i<all.length;){ const n=1+((i*7)%29); got.push(...fr.push(all.subarray(i,i+n))); i+=n; }      // кусками произвольной длины
    ok('wrap '+kind+': packets come back intact from a byte stream',got.length===pk.length && got.every((g,i)=>g.data.length===pk[i].length && g.data.every((v,j)=>v===pk[i][j])),got.length+'/'+pk.length);
  }
  ok('wrap none keeps the message',K.mdWrap('none (messages)',pk[0])===pk[0]);
  ok('len8 refuses what does not fit',K.mdWrap('len8',new Uint8Array(256))===null && K.mdWrap('len16be',new Uint8Array(256))!==null);
}
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
