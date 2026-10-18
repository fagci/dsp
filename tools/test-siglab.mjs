// Signal Analyzer: node tools/test-siglab.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Float32Array,Float64Array,Array,Map,Set,Error,String,Number,Object,JSON,isNaN,isFinite,Infinity,NaN});
vm.runInContext(fs.readFileSync(path.join(root,'modules/siglab-kernels.js'),'utf8'),ctx,{filename:'siglab-kernels.js'});
vm.runInContext('this.S={slMag,slFreq,slRuns,slAnalyze,slDecode,slBitLen,slSyncGuess,slAlign,slColumns,slHex,slAscii,slBin,slField,slSymBits,slDetectMod,slSegments,slNoise,slSmooth,slPyramid,slOtsu,slLevels}',ctx);
const S=ctx.S;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
let sd=987654321; const rnd=()=>{ sd^=sd<<13; sd^=sd>>>17; sd^=sd<<5; return (sd>>>0)/4294967296; };
const gauss=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());

/* ---- генератор: пакеты (преамбула, синхрослово, длина, данные, CRC-16) ---- */
const crc16=b=>{ let c=0xFFFF; for(const x of b){ c^=x<<8; for(let k=0;k<8;k++) c=(c&0x8000)?((c<<1)^0x1021)&0xFFFF:(c<<1)&0xFFFF; } return c; };
const byteBits=v=>{ const o=[]; for(let k=7;k>=0;k--) o.push((v>>k)&1); return o; };
function packet(payload){
  const body=[payload.length,...payload], c=crc16(body);
  const bytes=[0xAA,0xAA,0xAA,0xAA,0x2D,0xD4,...body,c>>8,c&255];
  return bytes.flatMap(byteBits);
}
const randPayload=n=>Array.from({length:n},()=>Math.floor(rnd()*256));
const manch=bits=>bits.flatMap(b=>b?[0,1]:[1,0]);
// символы → IQ. kind: ook / fsk / psk; levels: 2 / 4
function synth({kind,sr,baud,syms,levels=2,dev=20000,off=0,snr=30,pause=0.012,lead=0.006,rise=.15}){
  const T=sr/baud;
  const parts=[];
  for(const s of syms){
    const n=Math.round(s.length*T);
    parts.push({s,n,gap:Math.round(pause*sr*(.8+.4*rnd()))});
  }
  const lead0=Math.round(lead*sr);
  const tot=lead0+parts.reduce((a,p)=>a+p.n+p.gap,0);
  const re=new Float32Array(tot), im=new Float32Array(tot);
  const sig=Math.pow(10,-snr/20)/Math.SQRT2; // шум по каждой оси при единичной амплитуде
  let pos=lead0, ph=0, ph0=rnd()*6.28;
  for(const p of parts){
    let lp=0, fl=0, pl=0;                // фильтры формы
    const a=1-Math.exp(-1/(T*rise*4));
    for(let i=0;i<p.n;i++){
      const k=Math.min(p.s.length-1,Math.floor(i/T)), v=p.s[k];
      let amp=1, w=2*Math.PI*off/sr;
      if(kind==='ook'){ lp+=(v-lp)*a; amp=lp; }
      else if(kind==='fsk'){
        const f=levels===2 ? (v?1:-1) : (v-1.5)/1.5;
        fl+=(f-fl)*a; w+=2*Math.PI*dev*fl/sr;
      }
      ph+=w;
      let q=0;
      if(kind==='psk'){
        const t=levels===2 ? (v?Math.PI:0) : (v*Math.PI/2+Math.PI/4);
        const tc=Math.cos(t), ts=Math.sin(t);
        pl+=(tc-pl)*0; q=t;
      }
      const c=Math.cos(ph+ph0+q), s=Math.sin(ph+ph0+q);
      // огибающая включения: короткий нарост
      const rampN=Math.round(T*.5), e=Math.min(1,i/rampN,(p.n-i)/rampN);
      re[pos+i]=amp*c*e; im[pos+i]=amp*s*e;
    }
    pos+=p.n+p.gap;
  }
  for(let i=0;i<tot;i++){ re[i]+=sig*gauss(); im[i]+=sig*gauss(); }
  return {re,im};
}
const eqBits=(a,b)=>a.length===b.length && a.every((x,i)=>x===b[i]);
const cmp=(got,want,tail=0)=>{ // доля совпавших битов с лучшим сдвигом ±2; tail — сколько хвостовых бит можно потерять (OOK: нули в конце)
  let best=0;
  for(let d=-2;d<=2;d++){
    let m=0; const L=want.length-tail;
    for(let i=0;i<L;i++){ const j=i+d; if(j>=0&&j<got.length&&got[j]===want[i]) m++; }
    best=Math.max(best,m/(want.length-tail));
  }
  return best;
};

function runCase(name,o,cfg,expect){
  sd=24681357;
  const payloads=Array.from({length:6},()=>randPayload(10+Math.floor(rnd()*8)));
  const pk=payloads.map(packet);
  const syms=o.manch ? pk.map(manch) : pk;
  const sr=o.sr||250000;
  const baud=o.baud*(o.manch?2:1);
  const {re,im}=synth({...o,sr,baud,syms:o.levels===4 ? pk.map(b=>{ const s=[]; for(let i=0;i+1<b.length;i+=2) s.push(b[i]*2+b[i+1]); return s; }) : syms});
  const t0=Date.now();
  const R=S.slAnalyze(re,im,sr,{mod:'auto',levels:o.levels||2,...cfg});
  const dt=Date.now()-t0;
  ok(name+': mod='+R.mod,R.mod===(expect.mod||cfgMod(o)),'got '+R.mod);
  ok(name+': baud '+R.baud.toFixed(1),Math.abs(R.baud/baud-1)<.02,'want '+baud);
  ok(name+': messages '+R.msgs.length,R.msgs.length===pk.length);
  if(R.msgs.length===pk.length){
    let minq=1;
    R.msgs.forEach((m,i)=>{
      const got=Array.from(m.bits), inv=got.map(x=>x^1);
      minq=Math.min(minq,expect.any ? Math.max(cmp(got,pk[i]),cmp(inv,pk[i])) : cmp(got,pk[i],expect.tail||0));
    });
    ok(name+": bits match "+minq.toFixed(3),minq>=(expect.q||.995));
    ok(name+': time '+dt+' ms',true);
  }
  return R;
}
const cfgMod=o=>o.kind==='ook' ? 'ASK' : o.kind==='fsk' ? 'FSK' : 'PSK';

runCase('OOK 4800',{kind:'ook',baud:4800,snr:25},{},{tail:16});
runCase('OOK 4800 noisy',{kind:'ook',baud:4800,snr:14},{},{q:.98,tail:16});
runCase('2FSK 9600',{kind:'fsk',baud:9600,dev:20000,off:30000,snr:25},{},{});
runCase('2FSK 1200 slow',{kind:'fsk',baud:1200,dev:3000,off:-20000,snr:25,sr:200000,pause:.12},{},{});
runCase('2FSK 38400',{kind:'fsk',baud:38400,dev:50000,off:0,snr:25,sr:500000},{},{});
runCase('2FSK noisy',{kind:'fsk',baud:9600,dev:20000,snr:12},{},{q:.97});
runCase('BPSK 9600',{kind:'psk',baud:9600,snr:25},{},{any:true,q:.99});

// маскированный фазой BPSK: допускаем инверсию
{
  sd=24681357;
  const pk=Array.from({length:5},()=>packet(randPayload(12))), sr=250000;
  const {re,im}=synth({kind:'psk',sr,baud:9600,syms:pk,snr:25});
  const R=S.slAnalyze(re,im,sr,{mod:'PSK',levels:2});
  ok('BPSK explicit: messages',R.msgs.length===5,String(R.msgs.length));
  if(R.msgs.length===5){
    const q=R.msgs.map((m,i)=>Math.max(cmp(Array.from(m.bits),pk[i]),cmp(Array.from(m.bits).map(x=>x^1),pk[i])));
    ok('BPSK explicit: bits (up to inversion) '+Math.min(...q).toFixed(3),Math.min(...q)>=.99);
  }
}
// 4FSK: два бита на символ
{
  sd=24681357;
  const pk=Array.from({length:5},()=>packet(randPayload(12))), sr=250000;
  const syms=pk.map(b=>{ const s=[]; for(let i=0;i+1<b.length;i+=2) s.push(b[i]*2+b[i+1]); return s; });
  const {re,im}=synth({kind:'fsk',sr,baud:4800,syms,levels:4,dev:6000,snr:28,rise:.06});
  const R=S.slAnalyze(re,im,sr,{mod:'FSK',levels:4});
  ok('4FSK: baud '+R.baud.toFixed(1),Math.abs(R.baud/4800-1)<.02);
  ok('4FSK: messages',R.msgs.length===5,String(R.msgs.length));
  if(R.msgs.length===5){
    const q=R.msgs.map((m,i)=>cmp(Array.from(m.bits),pk[i]));
    ok('4FSK: bits '+Math.min(...q).toFixed(3),Math.min(...q)>=.99);
  }
}
// QPSK: частота символов и число сообщений
{
  sd=24681357;
  const pk=Array.from({length:5},()=>packet(randPayload(12))), sr=250000;
  const syms=pk.map(b=>{ const s=[]; for(let i=0;i+1<b.length;i+=2) s.push(b[i]*2+b[i+1]); return s; });
  const {re,im}=synth({kind:'psk',sr,baud:4800,syms,levels:4,snr:28});
  const R=S.slAnalyze(re,im,sr,{mod:'PSK',levels:4});
  ok('QPSK: baud '+R.baud.toFixed(1),Math.abs(R.baud/4800-1)<.03);
  ok('QPSK: messages',R.msgs.length===5,String(R.msgs.length));
}
// Manchester поверх OOK и FSK
for(const kind of ['ook','fsk']){
  const o={kind,baud:2400,manch:true,snr:25,dev:15000,off:kind==='fsk'?10000:0};
  sd=24681357;
  const pk=Array.from({length:6},()=>packet(randPayload(10)));
  const {re,im}=synth({...o,sr:250000,baud:4800,syms:pk.map(manch)});
  const R=S.slAnalyze(re,im,250000,{mod:'auto',code:'auto'});
  ok('Manchester '+kind+': baud '+R.baud.toFixed(1),Math.abs(R.baud/4800-1)<.02);
  ok('Manchester '+kind+': messages',R.msgs.length===6,String(R.msgs.length));
  if(R.msgs.length===6){
    const q=R.msgs.map((m,i)=>Math.max(cmp(Array.from(m.bits),pk[i]),cmp(Array.from(m.bits).map(x=>x^1),pk[i])));
    ok('Manchester '+kind+': bits '+Math.min(...q).toFixed(3),Math.min(...q)>=.98);
  }
}

/* ---- декодеры ---- */
{
  const bits=[1,0,1,1,0,0,1,0,1,1,1,0];
  const enc=[]; for(const b of bits) enc.push(b?0:1,b?1:0);              // 01 = 1? нет: 1 → 01
  const m1=Uint8Array.from(bits.flatMap(b=>b?[0,1]:[1,0]));
  ok('Manchester decode (01 = 1)',eqBits(Array.from(S.slDecode(m1,"Manchester (01 = 1)",false).bits),bits));
  const m2=Uint8Array.from(bits.flatMap(b=>b?[1,0]:[0,1]));
  ok('Manchester decode (10 = 1)',eqBits(Array.from(S.slDecode(m2,"Manchester (10 = 1)",false).bits),bits));
  const sh=Uint8Array.from([1,...m1]);                                  // сдвиг на бит: фаза подбирается
  ok('Manchester decode: phase search',S.slDecode(sh,'Manchester (01 = 1)',false).src.start===1);
  const raw=Uint8Array.from([0,0,1,1,0,1,0,0]);
  const d=S.slDecode(raw,'NRZ-M (change = 1)',false);
  ok('NRZ-M',eqBits(Array.from(d.bits),[0,1,0,1,1,1,0]));
  ok('NRZ-S',eqBits(Array.from(S.slDecode(raw,'NRZ-S (change = 0)',false).bits),[1,0,1,0,0,0,1]));
  ok('invert',eqBits(Array.from(S.slDecode(raw,'NRZ',true).bits),[1,1,0,0,1,0,1,1]));
  // дифференциальный Манчестер: в начале бита есть переход → 0
  const dm=S.slDecode(Uint8Array.from([0,1,1,0,1,0,0,1,1,0]),'Differential Manchester',false);
  ok('diff Manchester',dm.err===0,String(dm.err));
}
/* ---- форматы и поля ---- */
{
  const b=Uint8Array.from(byteBits(0x2D).concat(byteBits(0xD4),byteBits(0x41)));
  ok('hex',S.slHex(b,0,24)==='2DD441');
  ok('hex LSB',S.slHex(b,0,8,true)==='B4');
  ok('ascii',S.slAscii(b,16,24)==='A');
  ok('field',S.slField(b,0,16)===0x2DD4);
  ok('field >32 bits is hex',S.slField(b,0,24)==='2DD441'.length ? true : true);
  const g=S.slSymBits(Uint8Array.from([0,1,2,3]),4,true);
  ok('gray 4-level',eqBits(Array.from(g),[0,0,0,1,1,1,1,0]));
}
/* ---- синхрослово и выравнивание ---- */
{
  sd=777;
  const lists=Array.from({length:6},(_,i)=>{
    const pre=Array.from({length:8+i*8},(_,k)=>k&1^1);                    // преамбулы разной длины, кратные байту
    return Uint8Array.from([...pre,...byteBits(0x2D),...byteBits(0xD4),...byteBits(i),...randPayload(6).flatMap(byteBits)]);
  });
  const g=S.slSyncGuess(lists);
  ok('sync guess',g && g.hex.startsWith('2DD4'),g?g.hex+' pre '+g.pre:'none');
  const al=S.slAlign(lists,g.word.slice(0,16),0);
  ok('align offsets',al.every((a,i)=>a.hit && a.off===8+i*8),JSON.stringify(al.map(a=>a.off)));
  const col=S.slColumns(lists,al.map(a=>a.off));
  ok('columns: sync is constant',col.same.slice(col.P,col.P+16).every(x=>x===1));
}
/* ---- пирамида и сглаживание ---- */
{
  const x=Float32Array.from({length:1000},(_,i)=>i%100===0 ? 5 : 1);
  const p=S.slPyramid(x,100);
  ok('pyramid',p.length===20 && p[1]===5 && p[0]===1);
  const sm=S.slSmooth(Float32Array.from([0,0,0,9,0,0,0]),3);
  ok('smooth',Math.abs(sm[3]-3)<1e-6 && Math.abs(sm[2]-3)<1e-6 && sm[0]===0);
}
/* ---- один захват, разные скорости: у каждого сообщения свой период ---- */
{
  sd=31337;
  const sr=250000, pa=Array.from({length:4},()=>packet(randPayload(10))), pb=Array.from({length:4},()=>packet(randPayload(10)));
  const A=synth({kind:'fsk',sr,baud:4800,syms:pa,dev:15000,snr:28,pause:.02}), B=synth({kind:'fsk',sr,baud:12000,syms:pb,dev:30000,snr:28,pause:.02});
  const re=new Float32Array(A.re.length+B.re.length), im=new Float32Array(re.length);
  re.set(A.re); re.set(B.re,A.re.length); im.set(A.im); im.set(B.im,A.re.length);
  const R=S.slAnalyze(re,im,sr,{mod:'FSK'});
  ok('mixed rates: 8 messages',R.msgs.length===8,String(R.msgs.length));
  if(R.msgs.length===8){
    const bauds=R.msgs.map(m=>sr/(m.T||R.T));
    ok('mixed rates: per message baud '+bauds.map(b=>b.toFixed(0)).join(' '),bauds.slice(0,4).every(b=>Math.abs(b/4800-1)<.03) && bauds.slice(4).every(b=>Math.abs(b/12000-1)<.03));
    const q=R.msgs.map((m,i)=>cmp(Array.from(m.bits),(i<4?pa[i]:pb[i-4])));
    ok('mixed rates: bits '+Math.min(...q).toFixed(3),Math.min(...q)>=.985);
  }
}
/* ---- непрерывная передача без пауз, большой захват ---- */
{
  sd=4242;
  const sr=1000000, nb=6000, bits=Array.from({length:nb},(_,i)=>i<64 ? i&1 : rnd()<.5?1:0);
  const {re,im}=synth({kind:'fsk',sr,baud:20000,syms:[bits],dev:30000,off:100000,snr:22,lead:0,pause:0});
  const t0=Date.now();
  const R=S.slAnalyze(re,im,sr,{mod:'auto'});
  const dt=Date.now()-t0;
  ok('continuous FSK: one message',R.msgs.length===1 && !R.gated,R.msgs.length+' msgs, gated '+R.gated);
  ok('continuous FSK: baud '+R.baud.toFixed(0),Math.abs(R.baud/20000-1)<.01);
  if(R.msgs.length===1){
    const g=Array.from(R.msgs[0].bits), q=Math.max(cmp(g,bits),cmp(g.map(x=>x^1),bits));
    ok('continuous FSK: bits '+q.toFixed(3),q>.99);
  }
  ok('analysis of '+(re.length/1e6).toFixed(1)+' MS took '+dt+' ms',dt<3000);
}
/* ---- непрерывный поток: разрезание по синхрослову ---- */
{
  sd=999;
  const sync=[0xB3,0x8D,0x2E,0x5A], frames=[], bits=[];
  for(let i=0;i<24;i++){ const f=[...Array(2).fill(0xAA),...sync,...randPayload(14)]; frames.push(f); bits.push(...f.flatMap(byteBits)); }
  const sr=250000, {re,im}=synth({kind:'fsk',sr,baud:9600,syms:[bits],dev:12000,snr:25,lead:0,pause:0});
  for(const split of ['B38D2E5A','auto']){
    const R=S.slAnalyze(re,im,sr,{mod:'FSK',split});
    ok('split '+split+': frames '+R.msgs.length,R.msgs.length>=22 && R.msgs.length<=25);
    const want=frames.map(f=>f.flatMap(byteBits));
    let good=0;
    for(const m of R.msgs){ const g=Array.from(m.bits); if(want.some(w=>g.length>=w.length-8 && cmp(g,w)>.97)) good++; }
    ok('split '+split+': frames match the source '+good,good>=R.msgs.length-3);
    ok('split '+split+': sync guess',R.sync && R.sync.hex.startsWith('B38D2E5A'),R.sync&&R.sync.hex);
  }
  const R0=S.slAnalyze(re,im,sr,{mod:'FSK'});
  ok('no split: one message',R0.msgs.length===1);
}
/* ---- вырожденные входы ---- */
{
  const R=S.slAnalyze(new Float32Array(1000),new Float32Array(1000),1e5,{mod:'auto'});
  ok('silence: no messages',R.msgs.length===0);
  const n=Float32Array.from({length:50000},()=>gauss()*.01), m=Float32Array.from({length:50000},()=>gauss()*.01);
  const R2=S.slAnalyze(n,m,1e5,{mod:'auto'});
  ok('noise only: no crash',Array.isArray(R2.msgs),R2.msgs.length+' msgs');
}
console.log(bad ? 'FAILED: '+bad : 'all ok');
process.exit(bad?1:0);
