"use strict";
/* ============================ Vocoder (mbelib) ============================
   Голос из сырых кадров вокодера: P25 IMBE, DMR / NXDN / dPMR / YSF (режим 1) AMBE+2, D-STAR AMBE. Декодер — mbelib (ISC), собранный в
   vendor/mbelib.wasm (tools/mbelib/build.sh). Кадр из записи `voice` раскладывается в матрицу mbelib по расписаниям dsd-fme (mbe-tables.js),
   декодируется в 160 отсчётов 8 кГц на 20 мс, дальше — очередь, ресемплер до частоты движка и сумма потоков.
   Внимание: IMBE / AMBE могут быть запатентованы (DVSI) — см. README (Vocoder). */

const MBE={p:null, ex:null, err:null};
function mbeLoad(){
  if(MBE.p) return MBE.p;
  MBE.p=fetch('vendor/mbelib.wasm').then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.arrayBuffer(); })
    .then(b=>WebAssembly.instantiate(b,{env:{cosf:Math.cos, powf:Math.pow, log:Math.log, exp:Math.exp}}))
    .then(({instance})=>{ MBE.ex=instance.exports; return true; })
    .catch(e=>{ MBE.err=String(e && e.message || e); return false; });
  return MBE.p;
}
const mbeUnhex=s=>Uint8Array.from(s.match(/../g)||[],h=>parseInt(h,16));
const mbeBits=(by,n)=>{ const b=new Uint8Array(n); for(let i=0;i<n;i++) b[i]=(by[i>>3]>>(7-(i&7)))&1; return b; };

// запись voice → кадры вокодера {k: 'imbe' | 'a2450' | 'a2400', fr: матрица одним рядом (8×23 или 4×24)}
function mbeFrames(r){
  const out=[];
  const dib=(b,o,n,k,W,X,Y,Z,cols,size)=>{           // n дибитов с o: старший бит → [W][X], младший → [Y][Z]
    const fr=new Uint8Array(size);
    for(let j=0;j<n;j++){ fr[W[j]*cols+X[j]]=b[o+2*j]; fr[Y[j]*cols+Z[j]]=b[o+2*j+1]; }
    out.push({k,fr});
  };
  if(r.src==='P25' && r.imbe) dib(mbeBits(mbeUnhex(r.imbe),144),0,72,'imbe',MBE_IW,MBE_IX,MBE_IY,MBE_IZ,23,184);
  else if(r.ambe && (r.src==='DMR' || r.src==='NXDN' || r.src==='dPMR' || (r.src==='YSF' && r.kind==='ambe' && r.dt===0))){
    const by=mbeUnhex(r.ambe), n=(by.length*8)/72|0, b=mbeBits(by,by.length*8);
    for(let f=0;f<n;f++) dib(b,72*f,36,'a2450',MBE_RW,MBE_RX,MBE_RY,MBE_RZ,24,96);
  } else if(r.src==='D-STAR' && r.ambe){
    const by=mbeUnhex(r.ambe), fr=new Uint8Array(96);
    for(let i=0;i<72;i++) fr[MBE_DW[i]*24+MBE_DX[i]]=(by[i>>3]>>(i&7))&1;       // биты в порядке приёма: младший бит байта первым
    out.push({k:'a2400',fr});
  }
  return out;
}
// кадр → 160 отсчётов int16 (Int16Array, копия) и число исправленных ошибок; h — дескриптор состояния
function mbeDecode(h,fm,q){
  const ex=MBE.ex, mem=new Uint8Array(ex.memory.buffer);
  mem.set(fm.fr,ex.mbx_frame());
  const e=fm.k==='imbe' ? ex.mbx_imbe(h,q) : fm.k==='a2450' ? ex.mbx_ambe2450(h,q) : ex.mbx_ambe2400(h,q);
  return {errs:e, pcm:new Int16Array(ex.memory.buffer.slice(ex.mbx_pcm(),ex.mbx_pcm()+320))};
}

const MBE_PRE=960, MBE_MAX=12000;                     // до старта — 120 мс, не больше 1,5 с очереди (8 кГц)
function mbeStream(n,key){
  let s=n.streams.get(key);
  if(!s){
    if(n.streams.size>=12){ const old=[...n.streams.entries()].sort((a,b)=>a[1].last-b[1].last)[0]; MBE.ex.mbx_free(old[1].h); n.streams.delete(old[0]); }
    s={key, h:MBE.ex.mbx_new(), q:new Float32Array(MBE_MAX+2000), w:0, r:0, ph:0, play:false, last:0, frames:0, errs:0};
    n.streams.set(key,s);
  }
  return s;
}
function mbePush(s,pcm,g){
  if(s.w+160>s.q.length){                             // сдвиг непрочитанного в начало
    const m=s.w-s.r; s.q.copyWithin(0,s.r,s.w); s.r=0; s.w=m;
    if(s.w+160>s.q.length){ s.r=s.w-MBE_MAX/2; s.q.copyWithin(0,s.r,s.w); s.w-=s.r; s.r=0; }
  }
  for(let i=0;i<160;i++) s.q[s.w++]=pcm[i]/32768*g;
  if(s.w-s.r>MBE_MAX){ s.r=s.w-MBE_MAX/2|0; s.ph=0; }
}
// n выходных отсчётов из очереди 8 кГц: кубическая (Catmull-Rom) интерполяция; false — очереди не хватило
function mbePull(s,o,B,step){
  const q=s.q;
  if(!s.play){ if(s.w-s.r<MBE_PRE) return false; s.play=true; }
  for(let i=0;i<B;i++){
    const p=s.r;
    if(p+3>=s.w){ s.play=false; s.ph=0; return true; }   // очередь кончилась: дальше тишина до нового накопления
    const t=s.ph, a=q[p], b=q[p+1], c=q[p+2], d=q[p+3];    // между b и c
    o[i]+=b+.5*t*(c-a+t*(2*a-5*b+4*c-d+t*(3*(b-c)+d-a)));
    s.ph+=step;
    while(s.ph>=1){ s.ph-=1; s.r++; }
  }
  return true;
}

def({ id:'mbeVoice', title:'Vocoder (mbelib)', cat:'Decoders', ins:[{n:'voice',t:'rec'}], outs:[{n:'out',t:'sig'}],
  readout:true, resize:true, w:340,
  params:[{n:'gain',t:'range',min:0,max:8,step:.01,d:1,label:'gain'},
          {n:'slot',t:'select',opts:['any','1','2'],d:'any',label:'DMR slot'},
          {n:'uv',t:'range',min:1,max:64,step:1,d:3,label:'unvoiced quality (mbelib uvquality)'}],
  init:n=>{ n.streams=new Map(); n.tot={frames:0, errs:0, skipped:0}; mbeLoad(); },
  process(n,I){
    const o=buf(n,'out'); o.fill(0);
    if(!MBE.ex) return {out:o};
    const g=n.p.gain, q=n.p.uv|0, slot=n.p.slot, now=Date.now();
    for(const r of recList(I.voice)){
      if(slot!=='any' && r.slot && String(r.slot)!==slot) continue;
      const fs=mbeFrames(r);
      if(!fs.length){ n.tot.skipped++; continue; }
      const s=mbeStream(n,r.src+'|'+(r.slot||0));
      if(now-s.last>2000) MBE.ex.mbx_reset(s.h);       // новый разговор: состояние предыдущего кадра не нужно
      s.last=now;
      for(const fm of fs){ const d=mbeDecode(s.h,fm,q); s.frames++; s.errs+=d.errs; n.tot.frames++; n.tot.errs+=d.errs; mbePush(s,d.pcm,g); }
    }
    const step=8000/Eng.sr;
    for(const s of n.streams.values()) mbePull(s,o,BLOCK,step);
    return {out:o};
  },
  draw(n){
    const el=n.el.querySelector('.readout');
    if(!MBE.ex){ el.textContent=MBE.err ? 'mbelib.wasm not loaded: '+MBE.err+'\n(build it with tools/mbelib/build.sh)' : 'loading mbelib.wasm…'; return; }
    const rows=[...n.streams.values()].map(s=>s.key.replace(/\|0$/,'').replace('|',' slot ')+' · '+s.frames+' frames · '+s.errs+' bit errors · '+((s.w-s.r)/8).toFixed(0)+' ms queued'+(s.play ? ' ▶' : ''));
    el.textContent='mbelib ready · '+n.tot.frames+' frames'+(n.tot.skipped ? ' · '+n.tot.skipped+' records not decodable' : '')+(rows.length ? '\n'+rows.join('\n') : '\nwaiting for voice records');
  }});
