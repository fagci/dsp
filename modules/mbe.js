"use strict";
/* ============================ Vocoder (mbelib) ============================
   Голос из сырых кадров вокодера: P25 IMBE, DMR / NXDN / dPMR / YSF (режимы 1 и 2) AMBE+2, D-STAR AMBE. Декодер — mbelib (ISC), собранный в
   vendor/mbelib.wasm (tools/mbelib/build.sh). Кадр из записи `voice` раскладывается в матрицу mbelib по расписаниям dsd-fme (mbe-tables.js),
   декодируется в 160 отсчётов 8 кГц на 20 мс, дальше — очередь, ресемплер до частоты движка и сумма потоков.
   M17 (Codec 2, режимы 3200 и 1600) — отдельный модуль vendor/codec2.wasm (tools/codec2/build.sh), по 8 байт на кадр.
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
// Codec 2 (LGPL): тот же приём, математику даёт браузер
const C2={p:null, ex:null, err:null};
function c2Load(){
  if(C2.p) return C2.p;
  const env={expf:Math.exp, cosf:Math.cos, sinf:Math.sin, log10f:Math.log10, powf:Math.pow, acosf:Math.acos, atan2f:Math.atan2, logf:Math.log,
    roundf:x=>Math.sign(x)*Math.round(Math.abs(x)), pow:Math.pow, exp:Math.exp, log:Math.log, cos:Math.cos, sin:Math.sin, atan2:Math.atan2, log10:Math.log10};
  C2.p=fetch('vendor/codec2.wasm').then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.arrayBuffer(); })
    .then(b=>WebAssembly.instantiate(b,{env}))
    .then(({instance})=>{ C2.ex=instance.exports; return true; })
    .catch(e=>{ C2.err=String(e && e.message || e); return false; });
  return C2.p;
}
const mbeUnhex=s=>Uint8Array.from(s.match(/../g)||[],h=>parseInt(h,16));
const mbeBits=(by,n)=>{ const b=new Uint8Array(n); for(let i=0;i<n;i++) b[i]=(by[i>>3]>>(7-(i&7)))&1; return b; };

// YSF V/D mode 2: 104 бита = 27 бит ×3 (повтор) + 22 бита + 1; голосовой кадр AMBE+2 без FEC — восстанавливаем матрицу mbelib (Golay, PRNG)
const mbeGolay23=d=>{ let r=d<<11; for(let i=22;i>=11;i--) if((r>>i)&1) r^=0xC75<<(i-11); return (d<<11)|(r&0x7FF); };
function mbeYsf2(by){
  const b=mbeBits(by,104), d=new Uint8Array(49);
  for(let i=0;i<27;i++) d[i]=b[3*i]+b[3*i+1]+b[3*i+2]>1 ? 1 : 0;
  for(let i=0;i<22;i++) d[27+i]=b[81+i];
  const num=(o,n)=>{ let v=0; for(let i=0;i<n;i++) v=v*2+d[o+i]; return v; };
  const a=num(0,12), c0=mbeGolay23(a), c1=mbeGolay23(num(12,12)), fr=new Uint8Array(96);
  for(let j=0;j<23;j++) fr[j+1]=(c0>>j)&1;                     // fr[0][j+1]; fr[0][0] — чётность, mbelib её не проверяет
  let x=(16*a)&0xFFFF, k=1;
  const pr=[0]; for(let i=1;i<24;i++){ x=(173*x+13849)&0xFFFF; pr.push(x>>15); }
  for(let j=22;j>=0;j--) fr[24+j]=((c1>>j)&1)^pr[k++];
  for(let j=0;j<11;j++) fr[48+j]=d[24+10-j];
  for(let j=0;j<14;j++) fr[72+j]=d[35+13-j];
  return fr;
}
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
  } else if(r.src==='YSF' && r.kind==='ambe' && r.dt===2 && r.ambe){
    const by=mbeUnhex(r.ambe);
    if(by.length>=13) out.push({k:'a2450', fr:mbeYsf2(by)});
  } else if(r.src==='M17' && r.codec2){
    const by=mbeUnhex(r.codec2), m1600=r.dtype===3;      // TYPE 3 — голос + данные: 64 бита речи (1600) и 64 бита данных; иначе два кадра 3200
    if(by.length>=8) out.push({k:'c2', mode:m1600 ? 1600 : 3200, bytes:by.subarray(0,8)});
    if(!m1600 && by.length>=16) out.push({k:'c2', mode:3200, bytes:by.subarray(8,16)});
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

// кадр Codec 2 → отсчёты int16 (160 на 20 мс в режиме 3200, 320 на 40 мс в 1600)
function c2Decode(h,bytes){
  const ex=C2.ex; new Uint8Array(ex.memory.buffer,ex.c2_bits(),8).set(bytes);
  const n=ex.c2_decode(h);
  return new Int16Array(ex.memory.buffer.slice(ex.c2_pcm(),ex.c2_pcm()+2*n));
}
const MBE_PRE=960, MBE_MAX=12000;                     // до старта — 120 мс, не больше 1,5 с очереди (8 кГц)
function mbeStream(n,key){
  let s=n.streams.get(key);
  if(!s){
    if(n.streams.size>=12){ const old=[...n.streams.entries()].sort((a,b)=>a[1].last-b[1].last)[0]; if(old[1].h>=0) MBE.ex.mbx_free(old[1].h); if(old[1].c2) C2.ex.c2_free(old[1].c2.h); n.streams.delete(old[0]); }
    s={key, h:-1, c2:null, q:new Float32Array(MBE_MAX+2000), w:0, r:0, ph:0, play:false, last:0, frames:0, errs:0};
    n.streams.set(key,s);
  }
  return s;
}
function mbePush(s,pcm,g){
  const N=pcm.length;
  if(s.w+N>s.q.length){                             // сдвиг непрочитанного в начало
    const m=s.w-s.r; s.q.copyWithin(0,s.r,s.w); s.r=0; s.w=m;
    if(s.w+N>s.q.length){ s.r=s.w-MBE_MAX/2; s.q.copyWithin(0,s.r,s.w); s.w-=s.r; s.r=0; }
  }
  for(let i=0;i<N;i++) s.q[s.w++]=pcm[i]/32768*g;
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

def({ id:'mbeVoice', title:'Vocoder (mbelib)', cat:'Decoders', ins:[{n:'voice',t:'rec'}], outs:[{n:'out',t:'sig'},{n:'err',t:'num'}],
  readout:true, resize:true, w:340,
  params:[{n:'gain',t:'range',min:0,max:8,step:.01,d:1,label:'gain'},
          {n:'slot',t:'select',opts:['any','1','2'],d:'any',label:'DMR slot'},
          {n:'uv',t:'range',min:1,max:64,step:1,d:3,label:'unvoiced quality (mbelib uvquality)'}],
  init:n=>{ n.streams=new Map(); n.tot={frames:0, errs:0, skipped:0}; mbeLoad(); c2Load(); },
  process(n,I){
    const o=buf(n,'out'); o.fill(0);
    if(!MBE.ex && !C2.ex) return {out:o, err:0};
    let err=0;
    const g=n.p.gain, q=n.p.uv|0, slot=n.p.slot, now=Date.now();
    for(const r of recList(I.voice)){
      if(slot!=='any' && r.slot && String(r.slot)!==slot) continue;
      const fs=mbeFrames(r);
      if(!fs.length || (fs[0].k==='c2' ? !C2.ex : !MBE.ex)){ n.tot.skipped++; continue; }
      const s=mbeStream(n,r.src+'|'+(r.slot||0));
      if(now-s.last>2000){ if(s.h>=0) MBE.ex.mbx_reset(s.h); }       // новый разговор: состояние предыдущего кадра не нужно
      s.last=now;
      for(const fm of fs){
        if(fm.k==='c2'){
          if(!s.c2 || s.c2.mode!==fm.mode){ if(s.c2) C2.ex.c2_free(s.c2.h); s.c2={h:C2.ex.c2_new(fm.mode), mode:fm.mode}; }
          if(s.c2.h<0) continue;
          mbePush(s,c2Decode(s.c2.h,fm.bytes),g); s.frames++; n.tot.frames++;
        } else {
          if(s.h<0) s.h=MBE.ex.mbx_new();
          const d=mbeDecode(s.h,fm,q); s.frames++; s.errs+=d.errs; n.tot.errs+=d.errs; if(d.errs) err=1; n.tot.frames++; mbePush(s,d.pcm,g);
        }
      }
    }
    const step=8000/Eng.sr;
    for(const s of n.streams.values()) mbePull(s,o,BLOCK,step);
    return {out:o, err};
  },
  draw(n){
    const el=n.el.querySelector('.readout');
    const st=(m,name)=>m.ex ? name+' ready' : m.err ? name+' missing ('+m.err+')' : name+' loading…';
    const rows=[...n.streams.values()].map(s=>s.key.replace(/\|0$/,'').replace('|',' slot ')+' · '+s.frames+' frames'+(s.h>=0 ? ' · '+s.errs+' bit errors' : '')+' · '+((s.w-s.r)/8).toFixed(0)+' ms queued'+(s.play ? ' ▶' : ''));
    el.textContent=st(MBE,'mbelib')+' · '+st(C2,'Codec 2')+' · '+n.tot.frames+' frames'+(n.tot.skipped ? ' · '+n.tot.skipped+' records not decodable' : '')+(rows.length ? '\n'+rows.join('\n') : '\nwaiting for voice records');
  }});
