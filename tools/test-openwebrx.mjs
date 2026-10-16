// Клиент OpenWebRX: node tools/test-openwebrx.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

// ---- ядро
const kc=vm.createContext({Math,JSON,Int16Array,Uint8Array,String,Number,Object});
vm.runInContext(rd('modules/openwebrx-kernels.js')+';this.K={owrxAdpcm,owrxFft,owrxPlan,owrxModeNames,owrxFindProfile,owrxMsgText,owrxParseAddr,owrxPassband,owrxText,owrxDb,OWRX_STEP,OWRX_IDX};',kc);
const K=kc.K;
ok('step table: 89 entries',K.OWRX_STEP.length===89 && K.OWRX_STEP[0]===7 && K.OWRX_STEP[88]===32767);

// кодер IMA-ADPCM по той же таблице, кадр как у сервера: SYNC + stepIndex + predictor + 1001 байт;
// шаг первого отсчёта после SYNC — прежний (0 в начале), как в референсном декодере
function encode(pcm){
  let idx=0,pred=0,step=0; const out=[...'SYNC'].map(c=>c.charCodeAt(0));
  const hdr=new Uint8Array(new Int16Array([idx,pred]).buffer); out.push(...hdr);
  const nibs=[];
  for(const x of pcm){
    let d=x-pred, nb=0;
    if(d<0){ nb=8; d=-d; }
    if(d>=step){ nb|=4; d-=step; }
    if(d>=step>>1){ nb|=2; d-=step>>1; }
    if(d>=step>>2){ nb|=1; }
    let df=step>>3; if(nb&1) df+=step>>2; if(nb&2) df+=step>>1; if(nb&4) df+=step; if(nb&8) df=-df;
    pred=Math.min(32767,Math.max(-32768,pred+df)); idx=Math.min(88,Math.max(0,idx+K.OWRX_IDX[nb])); step=K.OWRX_STEP[idx];
    nibs.push(nb);
  }
  for(let i=0;i<nibs.length;i+=2) out.push(nibs[i]|(nibs[i+1]<<4));
  return Uint8Array.from(out);
}
const N=2002, src=new Int16Array(N); for(let i=0;i<N;i++) src[i]=Math.round(8000*Math.sin(2*Math.PI*i*440/12000));
const enc=encode(src);
const dec=K.owrxAdpcm().decode(enc);
let err=0; for(let i=64;i<dec.length;i++) err=Math.max(err,Math.abs(dec[i]-src[i]));   // первые отсчёты — разгон шага
ok('adpcm: one frame length',dec.length===N,dec.length);
ok('adpcm: roundtrip error small',err<600,err);
// два кадра подряд, второй разрезан на части посреди данных — состояние держится между вызовами
const c=K.owrxAdpcm(), two=new Uint8Array([...enc,...enc]); let tot=0;
for(let i=0;i<two.length;i+=137) tot+=c.decode(two.subarray(i,i+137)).length;
ok('adpcm: two frames, chunked input',tot===2*N,tot);
ok('adpcm: garbage before SYNC skipped',K.owrxAdpcm().decode(new Uint8Array([1,2,3,...enc])).length===N);

const f32=new Float32Array([-90,-60.5,-30]); const fr=K.owrxFft(new Uint8Array(f32.buffer),'none');
ok('fft: float32 dB',fr.length===3 && fr[1]===-60.5);
const q=new Int16Array(10+4); for(let i=0;i<4;i++) q[10+i]=Math.round((-70+i*10)*100);
const qe=encode(q).subarray(8);                          // без SYNC/заголовка: чистые полубайты
const fd=K.owrxFft(qe,'adpcm',K.owrxAdpcm());
ok('fft: adpcm length minus pad',fd.length===qe.length*2-10,fd.length);
const MODES=[{modulation:'usb',type:'analog',bandpass:{low_cut:300,high_cut:2700},requirements:[]},
  {modulation:'ft8',type:'digimode',underlying:['usb','lsb'],bandpass:{low_cut:0,high_cut:3000},requirements:['wsjt-x'],secondaryFft:false},
  {modulation:'packet',type:'digimode',underlying:['nfm'],requirements:['packet'],secondaryFft:true},
  {modulation:'am',type:'analog',requirements:[]}];
let pl=K.owrxPlan('ft8',MODES,'auto',2700);
ok('plan: digital mode = underlying + secondary',pl.mod==='usb' && pl.sec==='ft8' && pl.lo===0 && pl.hi===3000,JSON.stringify(pl));
ok('plan: chosen underlying',K.owrxPlan('ft8',MODES,'lsb',2700).mod==='lsb' && K.owrxPlan('ft8',MODES,'nfm',2700).mod==='usb');
pl=K.owrxPlan('packet',MODES,'auto',2700);
ok('plan: no bandpass anywhere → none sent, secondary fft flag',pl.mod==='nfm' && pl.lo===null && pl.sub===true,JSON.stringify(pl));
ok('plan: analog uses own bandwidth',K.owrxPlan('usb',MODES,'auto',2700).lo===150);
ok('plan: unknown mode on server',/no mode/.test(K.owrxPlan('dmr',MODES,'auto',0).err));
ok('plan: no server list → digital over usb',K.owrxPlan('ft8',null,'auto',0).sec==='ft8' && K.owrxPlan('am',null,'auto',6000).sec===false);
ok('mode names filtered by features',JSON.stringify(K.owrxModeNames(MODES,{'wsjt-x':true,packet:false}))==='["usb","ft8","am"]');
ok('mode names fallback has analog + digital',K.owrxModeNames(null).includes('ft8') && K.owrxModeNames(null).includes('wfm'));
const PR=[{id:'a|1',name:'20m'},{id:'a|2',name:'40m band'},{id:'b|1',name:'2m FM'}];
ok('profile lookup: exact, id, substring',K.owrxFindProfile(PR,'20M').id==='a|1' && K.owrxFindProfile(PR,'b|1').name==='2m FM' && K.owrxFindProfile(PR,'40m').id==='a|2' && K.owrxFindProfile(PR,'zz')===null);
ok('message text',K.owrxMsgText({mode:'FT8',msg:'CQ DX'})==='FT8 CQ DX' && K.owrxMsgText('abc')==='abc' && K.owrxMsgText({mode:'DMR',slot:1})==='DMR {"mode":"DMR","slot":1}');
ok('addr: host only',JSON.stringify(K.owrxParseAddr('sdr.example'))==='{"host":"sdr.example","port":8073,"tls":false}');
ok('addr: url with port and path',JSON.stringify(K.owrxParseAddr('http://a.b:8074/x'))==='{"host":"a.b","port":8074,"tls":false}');
ok('addr: wss default port',JSON.stringify(K.owrxParseAddr('wss://a.b/ws/'))==='{"host":"a.b","port":443,"tls":true}');
ok('passband usb/lsb',JSON.stringify(K.owrxPassband('usb',2700))==='[150,2850]' && JSON.stringify(K.owrxPassband('lsb',2700))==='[-2850,-150]');
ok('passband am symmetric',JSON.stringify(K.owrxPassband('am',6000))==='[-3000,3000]');
const h=K.owrxText('CLIENT DE SERVER server=openwebrx version=v1.2.3');
ok('hello parsed',h.type==='hello' && h.server==='openwebrx' && h.version==='v1.2.3');
ok('json parsed',K.owrxText('{"type":"smeter","value":0.001}').value===0.001 && K.owrxText('{bad')===null);
ok('smeter dB',Math.abs(K.owrxDb(0.001)+30)<1e-9 && K.owrxDb(0)===-150);

// ---- узел против поддельного WebSocket
const sent=[]; let wsi;
class WS{ constructor(u){ this.url=u; this.readyState=0; wsi=this; } send(m){ sent.push(m); } close(){ this.readyState=3; } }
const defs={};
const ctx=vm.createContext({Math,JSON,Int16Array,Uint8Array,Float32Array,DataView,ArrayBuffer,String,Number,Object,Array,RegExp,URL,setTimeout,clearTimeout,
  WebSocket:WS, location:{protocol:'http:',href:'http://x/'}, Net:{proxy:false,url:u=>u}, Eng:{sr:48000}, BLOCK:128,
  def:d=>{ defs[d.id]=d; }, buf:(n,k)=>(n.b||(n.b={}))[k]||(n.b[k]=new Float32Array(128)), setMod:(n,k,v)=>{ n.p[k]=v; },
  fmtHz:v=>v+' Hz'});
vm.runInContext(rd('modules/openwebrx-kernels.js'),ctx);
vm.runInContext('const KIWI_ZC=12; function kiwiResetRing(n){ const SIZE=Math.max(200000,Math.round((n.audioRate||12000)*4)); n.ring={A:new Float32Array(SIZE),size:SIZE,w:0,filled:0,written:0}; n.readPos=0; n.readCount=0; n.rebuffering=false; }',ctx);
// netAudioRead берём из sources.js как есть
const s=rd('modules/sources.js'); const a=s.indexOf('function netAudioRead'), b=s.indexOf('function kiwiSend');
vm.runInContext(s.slice(a,b),ctx);
vm.runInContext(rd('modules/openwebrx.js'),ctx);
const D=defs.openwebrx;
const n={p:{server:'rx.example:8073',freq:7100000,mod:'usb',bw:2700}}; D.init(n);
ok('registered',!!D && D.outs.length===6);
vm.runInContext('owrxConnect',ctx)(n);
ok('ws url',wsi.url==='ws://rx.example:8073/ws/',wsi.url);
wsi.readyState=1; wsi.onopen();
ok('handshake sent',sent[0]==='SERVER DE CLIENT client=openwebrx.js type=receiver' && JSON.parse(sent[1]).type==='connectionproperties' && JSON.parse(sent[1]).params.output_rate===12000);
sent.length=0;
wsi.onmessage({data:'CLIENT DE SERVER server=openwebrx version=v1.2.3'});
wsi.onmessage({data:JSON.stringify({type:'config',value:{center_freq:7050000,samp_rate:2400000,audio_compression:'none'}})});
ok('start + tune: offset relative to center',sent.length===2 && JSON.parse(sent[0]).action==='start' && JSON.parse(sent[1]).params.offset_freq===50000 && JSON.parse(sent[1]).params.mod==='usb',JSON.stringify(sent));
ok('usb passband sent',JSON.parse(sent[1]).params.low_cut===150 && JSON.parse(sent[1]).params.high_cut===2850);
sent.length=0; n.p.freq=7110000; D.process(n,{});
ok('retune sends only dspcontrol params',sent.length===1 && JSON.parse(sent[0]).params.offset_freq===60000,JSON.stringify(sent));
sent.length=0; n.p.freq=50000000; D.process(n,{});
ok('out of range: nothing sent, status says why',sent.length===0 && /out of range/.test(n.status),n.status);
n.p.freq=7100000; D.process(n,{});
wsi.onmessage({data:JSON.stringify({type:'smeter',value:0.0001})});
ok('smeter → rssi',Math.abs(n.rssi+40)<1e-9);
// звук: 12000 отсчётов int16 LE, тип 2
const pcm=new Int16Array(12000); for(let i=0;i<pcm.length;i++) pcm[i]=Math.round(10000*Math.sin(2*Math.PI*1000*i/12000));
const frame=new Uint8Array(1+pcm.length*2); frame[0]=2; frame.set(new Uint8Array(pcm.buffer),1);
for(let i=0;i<5;i++) wsi.onmessage({data:frame.buffer});
let peak=0; for(let k=0;k<40;k++){ const r=D.process(n,{}); for(const v of r.audio) peak=Math.max(peak,Math.abs(v)); }
ok('audio reaches output after buffering',peak>0.2 && peak<0.6,peak);
ok('delay: backlog trimmed to the buffer, not seconds',n.ring.written-n.readCount<=3*0.3*12000+1,n.ring.written-n.readCount);
{ const q={p:{...n.p,buf:300},connected:true}; D.init(q); q.connected=true; q.cfg={center:7050000,sr:2400000};
  q.ring.written=2000; q.ring.filled=2000; q.ring.A.fill(0.5);
  vm.runInContext('netAudioRead',ctx)(q,new Float32Array(128),3000,0.3);
  ok('delay: silent below the buffer',q.readCount===0);
  q.ring.written=3700; q.ring.filled=3700;
  const o=new Float32Array(128); vm.runInContext('netAudioRead',ctx)(q,o,3000,0.3);
  ok('delay: plays once 300 ms are in',q.readCount>0 && Math.abs(o[100])>0.1,q.readCount); }
// ADPCM-режим
wsi.onmessage({data:JSON.stringify({type:'config',value:{audio_compression:'adpcm'}})});
const ef=new Uint8Array(1+enc.length); ef[0]=2; ef.set(enc,1);
const before=n.ring.written; wsi.onmessage({data:ef.buffer});
ok('adpcm frame decoded into ring',n.ring.written-before===N,n.ring.written-before);
wsi.onmessage({data:new Uint8Array([1,0,0,0,0]).buffer});
ok('fft frame does not touch audio',n.ring.written-before===N);
const fb=new Float32Array(8).fill(-60); fb[3]=-20; const ff=new Uint8Array(1+fb.length*4); ff[0]=1; ff.set(new Uint8Array(fb.buffer),1);
wsi.onmessage({data:ff.buffer});
const out=D.process(n,{});
ok('spec output: abs axis, linear mag',out.spec && out.spec.size===8 && Math.abs(out.spec.mag[3]-0.1)<1e-6 && Math.abs(out.spec.mag[0]-0.001)<1e-9 && Math.abs(out.spec.freqs[0]-(7050000-1200000+150000))<1,JSON.stringify(out.spec&&out.spec.freqs[0]));
const r0=out.spec.rev; wsi.onmessage({data:ff.buffer}); ok('spec rev grows',n.spec.rev===r0+1);
D.dispose(n);
ok('disconnect',!n.connected);

// ---- профили, режимы, цифровые сообщения
const k={p:{server:'rx.example:8073',freq:14074000,mod:'ft8',under:'auto',bw:2700,subfreq:0,profile:'40m'}}; D.init(k);
sent.length=0; const O=vm.runInContext('owrxConnect',ctx); O(k); const w2=wsi; w2.readyState=1; w2.onopen(); sent.length=0;
w2.onmessage({data:JSON.stringify({type:'config',value:{center_freq:14100000,samp_rate:2400000,sdr_id:'a',profile_id:'1'}})});
w2.onmessage({data:JSON.stringify({type:'profiles',value:PR})});
const selp=sent.map(x=>JSON.parse(x)).find(x=>x.type==='selectprofile');
ok('profile from the patch selected once, after config+profiles',selp && selp.params.profile==='a|2',JSON.stringify(sent));
sent.length=0; w2.onmessage({data:JSON.stringify({type:'profiles',value:PR})});
ok('no repeated selectprofile',!sent.some(x=>/selectprofile/.test(x)));
w2.onmessage({data:JSON.stringify({type:'modes',value:MODES})});
sent.length=0;
w2.onmessage({data:JSON.stringify({type:'config',value:{center_freq:7100000,samp_rate:2400000,sdr_id:'a',profile_id:'2'}})});
let ds=sent.map(x=>JSON.parse(x)); const tp=ds.find(x=>x.params);
ok('new profile: start again; band out of range → status lists other profiles',ds.some(x=>x.action==='start')===false && /out of range/.test(k.status),JSON.stringify(ds)+k.status);
k.p.freq=7074000; D.process(k,{});
ds=sent.map(x=>JSON.parse(x)); const tq=ds.filter(x=>x.params).pop();
ok('ft8 tune: mod usb + secondary ft8 + bandpass from server',tq && tq.params.mod==='usb' && tq.params.secondary_mod==='ft8' && tq.params.low_cut===0 && tq.params.offset_freq===-26000,JSON.stringify(ds));
ok('profile output carries current profile name',D.process(k,{}).profile==='40m band');
w2.onmessage({data:JSON.stringify({type:'secondary_demod',value:{mode:'FT8',msg:'CQ DX K1ABC FN42',db:-12}})});
w2.onmessage({data:JSON.stringify({type:'metadata',value:{mode:'DMR',slot:1}})});
w2.onmessage({data:JSON.stringify({type:'metadata',value:{mode:'DMR',slot:1}})});
const od=D.process(k,{});
ok('decoded message → rec with kind, text line',od.rec.length===2 && od.rec[0].kind==='decoded' && od.rec[0].msg==='CQ DX K1ABC FN42' && od.rec[1].kind==='metadata' && /DMR/.test(od.text),JSON.stringify(od.rec));
ok('rec drained after one block, unchanged metadata not repeated',D.process(k,{}).rec===null);
sent.length=0; k.p.mod='am'; D.process(k,{});
const ta=sent.map(x=>JSON.parse(x)).find(x=>x.params);
ok('back to analog: secondary_mod false',ta && ta.params.mod==='am' && ta.params.secondary_mod===false,JSON.stringify(sent));
sent.length=0; D.process(k,{profile:'b|1'}); ok('profile input selects',sent.some(x=>/"profile":"b\|1"/.test(x)),JSON.stringify(sent));
D.dispose(k);

// https-страница без прокси — понятная ошибка
ctx.location.protocol='https:'; const m={p:{server:'rx.example:8073',freq:1e6,mod:'am',bw:6000}}; D.init(m); vm.runInContext('owrxConnect',ctx)(m);
ok('https page without proxy: error in status',/proxy/.test(m.status),m.status);
process.exit(bad?1:0);
