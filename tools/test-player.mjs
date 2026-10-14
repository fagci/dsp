// Ядро плеера: node tools/test-player.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,Uint8Array,Array,TextDecoder,String,isFinite,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/player-kernels.js'),'utf8')+
  ';this.K={WP_EQ,WP_BANDS,wpPeak,wpBalance,wpTime,wpOrder,wpStep,wpId3,wpName};',ctx);
const K=ctx.K;
let bad=0;
const ok=(n,c)=>{ if(!c){ bad++; console.log('FAIL',n); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-6)=>ok(n+' ('+a+' ≈ '+b+')',Math.abs(a-b)<=e);

// пик-фильтр: усиление на центре = gdb, далеко от центра ≈ 0 дБ
const sr=48000;
const resp=(c,f)=>{ const w=2*Math.PI*f/sr, c1=Math.cos(w), s1=Math.sin(w), c2=Math.cos(2*w), s2=Math.sin(2*w);
  const nr=c[0]+c[1]*c1+c[2]*c2, ni=-(c[1]*s1+c[2]*s2), dr=1+c[3]*c1+c[4]*c2, di=-(c[3]*s1+c[4]*s2);
  return 10*Math.log10((nr*nr+ni*ni)/(dr*dr+di*di)); };
let c=K.wpPeak(1000,9,1.6,sr);
near('peak +9 dB at centre',resp(c,1000),9,.01); ok('peak: far away ≈ 0 dB',Math.abs(resp(c,60))<1&&Math.abs(resp(c,15000))<1);
c=K.wpPeak(310,-6,1.6,sr); near('peak −6 dB at centre',resp(c,310),-6,.01);
near('peak 0 dB is transparent',resp(K.wpPeak(3000,0,1.6,sr),777),0,1e-9);
ok('top band is clamped below Nyquist at 22.05 kHz sr',isFinite(resp(K.wpPeak(16000,6,1.6,22050),5000)));
ok('10 bands, presets have 10 gains',K.WP_BANDS.length===10&&Object.values(K.WP_EQ).every(p=>p.g.length===10));

// баланс
ok('balance centre',K.wpBalance(0).join()==='1,1'); ok('balance right fades left',K.wpBalance(1).join()==='0,1');
ok('balance left fades right',K.wpBalance(-.5).join()==='1,0.5'); ok('balance clamped',K.wpBalance(5).join()==='0,1');

// время
ok('time 0',K.wpTime(0)==='00:00'); ok('time 3665.5',K.wpTime(3665.5)==='61:05'); ok('time remaining',K.wpTime(-75)==='-01:15'); ok('time NaN',K.wpTime(NaN)==='--:--');

// порядок и шаги
let o=K.wpOrder(5,false,0); ok('order plain',o.join()==='0,1,2,3,4');
let seed=1; const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
o=K.wpOrder(8,true,3,rnd); ok('shuffle: permutation',[...o].sort().join()==='0,1,2,3,4,5,6,7'); ok('shuffle: current first',o[0]===3);
o=[0,1,2];
ok('step next',K.wpStep(o,0,1,'off',false)===1); ok('step prev wraps (manual)',K.wpStep(o,0,-1,'off',false)===2);
ok('auto at end, repeat off → stop',K.wpStep(o,2,1,'off',true)===-1); ok('auto at end, repeat all → first',K.wpStep(o,2,1,'all',true)===0);
ok('auto, repeat one → same',K.wpStep(o,1,1,'one',true)===1); ok('manual next with repeat one goes on',K.wpStep(o,1,1,'one',false)===2);
ok('empty list',K.wpStep([],0,1,'all',true)===-1);

// ID3v2.3 (UTF-16) + ID3v1
const enc=(s)=>{ const a=[1,0xFF,0xFE]; for(const ch of s){ a.push(ch.charCodeAt(0)&255,ch.charCodeAt(0)>>8); } return a; };
const frame=(id,body)=>[...id].map(x=>x.charCodeAt(0)).concat([body.length>>>24,body.length>>16&255,body.length>>8&255,body.length&255,0,0],body);
const fr=[...frame('TIT2',enc('Привет')),...frame('TPE1',[0,...'Band'].map(x=>typeof x==='string'?x.charCodeAt(0):x))];
const hdr=[0x49,0x44,0x33,3,0,0,0,0,fr.length>>7&127,fr.length&127];
let t=K.wpId3(Uint8Array.from([...hdr,...fr,0,0,0,0]));
ok('id3v2 title (UTF-16)',t.title==='Привет'); ok('id3v2 artist (Latin-1)',t.artist==='Band');
const v1=new Uint8Array(200); v1.set([0x54,0x41,0x47],72); v1.set([...'Song'].map(x=>x.charCodeAt(0)),75); v1.set([...'Who'].map(x=>x.charCodeAt(0)),105);
t=K.wpId3(v1); ok('id3v1 title/artist',t.title==='Song'&&t.artist==='Who');
ok('no tags → empty',K.wpId3(new Uint8Array(50)).title==='');
ok('name from tag',K.wpName({title:'T',artist:'A'},'x.mp3')==='A - T'); ok('name from file',K.wpName(null,'C:\\mus\\my_song.mp3')==='my song');
if(bad){ console.log(bad+' FAILED'); process.exit(1); } console.log('all ok');
