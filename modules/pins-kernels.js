"use strict";
/* ============================ Pins: кадры для вывода пинов наружу ============================
   Чистая логика без DOM (грузится страницей и тестами, мост tools/termux/bridge.mjs кадры не разбирает; тест — tools/test-pins.mjs).
   Один формат кадра на любой тип данных: бинарное WebSocket-сообщение, все числа little-endian.
     0  u8   kind   1 sig · 2 iq · 3 spec (комплексный, центр fc) · 4 spec (вещественный 0…sr/2) · 5 json
     1  u8   длина имени
     2  u16  0
     4  f64  fc   (iq: центр, spec: частота бина N/2)
     12 f64  sr   (iq / sig: частота дискретизации, spec: полоса всех бинов, а у вещественного — частота исходного потока)
     20 u32  seq  (счётчик отправленных кадров этого пина; пропуск = потеря)
     24      имя UTF-8, добор нулями до кратного 4 — дальше данные
   Данные: sig — float32; iq — float32 I,Q,I,Q…; spec — float32 мощность по бинам; json — UTF-8 от JSON.stringify.
   Управление — текстовые JSON-сообщения (см. tools/termux/bridge.mjs). */

const PIN_SIG=1, PIN_IQ=2, PIN_SPEC=3, PIN_SPECR=4, PIN_JSON=5;
const PIN_KIND_NAME={1:'sig',2:'iq',3:'spec',4:'spec',5:'json'};
const PIN_MAX_BYTES=512*1024;                          // данных в одном кадре; ws-разбор моста режет всё, что больше 1 МиБ
const PIN_ENC=new TextEncoder(), PIN_DEC=new TextDecoder();

const pinIsF32=v=>Object.prototype.toString.call(v)==='[object Float32Array]';
const pinHdrLen=nameLen=>24+((nameLen+3)&~3);

// имя пина: без пробелов и запятых по краям, не длиннее 64 символов
function pinName(s,fb){ const t=String(s==null ? '' : s).trim().replace(/[,\s]+/g,'_').slice(0,64); return t||fb||''; }
// «a, b, c» → ['a','b','c'], недостающие — по умолчанию prefix+номер
function pinNames(text,count,prefix){
  const L=String(text||'').split(',').map(s=>s.trim());
  return Array.from({length:count},(_,k)=>pinName(L[k],(prefix||'pin')+(k+1)));
}

function pinEncode(f){
  const name=PIN_ENC.encode(f.name), hl=pinHdrLen(name.length);
  let body;
  if(f.kind===PIN_JSON) body=PIN_ENC.encode(JSON.stringify(f.data===undefined ? null : f.data));
  else body=new Uint8Array(f.data.buffer,f.data.byteOffset,f.data.byteLength);
  const out=new Uint8Array(hl+body.length), dv=new DataView(out.buffer);
  out[0]=f.kind; out[1]=name.length;
  dv.setFloat64(4,+f.fc||0,true); dv.setFloat64(12,+f.sr||0,true); dv.setUint32(20,f.seq>>>0,true);
  out.set(name,24); out.set(body,hl);
  return out;
}

// → {kind,name,fc,sr,seq,data} | null (битый кадр)
function pinDecode(u8){
  if(!u8 || u8.length<24) return null;
  const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength), kind=u8[0], nl=u8[1], hl=pinHdrLen(nl);
  if(kind<1 || kind>5 || u8.length<hl) return null;
  const f={kind, name:PIN_DEC.decode(u8.subarray(24,24+nl)), fc:dv.getFloat64(4,true), sr:dv.getFloat64(12,true), seq:dv.getUint32(20,true), data:null};
  const n=u8.length-hl;
  if(kind===PIN_JSON){ try{ f.data=JSON.parse(PIN_DEC.decode(u8.subarray(hl))); }catch(e){ return null; } }
  else{
    if(n&3) return null;
    f.data=((u8.byteOffset+hl)&3)===0 ? new Float32Array(u8.buffer,u8.byteOffset+hl,n>>2) : new Float32Array(u8.slice(hl).buffer);
  }
  return f;
}

// значение с пина графа → {kind,fc,sr,data[,rev]} | null (нечего отправлять / тип не поддержан)
function pinClassify(v,engSr){
  if(v==null) return null;
  if(typeof v==='number') return isFinite(v) ? {kind:PIN_JSON,fc:0,sr:0,data:v} : null;
  if(typeof v==='string' || typeof v==='boolean') return {kind:PIN_JSON,fc:0,sr:0,data:v};
  if(pinIsF32(v)) return v.length ? {kind:PIN_SIG,fc:0,sr:+engSr||0,data:v} : null;
  if(ArrayBuffer.isView(v)) return null;
  if(Array.isArray(v)) return v.length ? {kind:PIN_JSON,fc:0,sr:0,data:v} : null;
  if(typeof v!=='object') return null;
  if(Array.isArray(v.chunks)){                          // поток IQ (iqStream)
    let tot=0; for(const c of v.chunks) tot+=c.re.length;
    if(!tot) return null;
    const d=new Float32Array(tot*2); let o=0;
    for(const c of v.chunks){ const re=c.re, im=c.im; for(let i=0;i<re.length;i++){ d[o++]=re[i]; d[o++]=im ? im[i] : 0; } }
    return {kind:PIN_IQ,fc:+v.fc||0,sr:+v.sr||0,data:d};
  }
  if(v.mag && pinIsF32(v.mag)){                         // спектр
    const N=v.mag.length;
    if(N<2) return null;
    if(v.freqs){
      const step=(v.freqs[N-1]-v.freqs[0])/(N-1);
      return {kind:PIN_SPEC,fc:v.freqs[0]+step*(N>>1),sr:step*N,data:v.mag,rev:v.rev};
    }
    return {kind:PIN_SPECR,fc:0,sr:+v.sr||0,data:v.mag,rev:v.rev};
  }
  try{ JSON.stringify(v); }catch(e){ return null; }
  return {kind:PIN_JSON,fc:0,sr:0,data:v};
}

// кадры для отправки: IQ длиннее PIN_MAX_BYTES режется по отсчётам. seq0 — номер первого кадра
function pinFrames(name,c,seq0){
  if(c.kind===PIN_IQ && c.data.length*4>PIN_MAX_BYTES){
    const step=(PIN_MAX_BYTES>>3)*2, out=[];
    for(let o=0,s=seq0;o<c.data.length;o+=step,s++) out.push(pinEncode({kind:PIN_IQ,name,fc:c.fc,sr:c.sr,seq:s,data:c.data.subarray(o,o+step)}));
    return out;
  }
  return [pinEncode({kind:c.kind,name,fc:c.fc,sr:c.sr,seq:seq0,data:c.data})];
}

// кадр спектра → объект, который понимают модули со входом spec
function pinSpecOf(f){
  const N=f.data.length;
  if(f.kind===PIN_SPECR) return {mag:f.data,sr:f.sr,size:N,freqs:null,rev:0};
  const bin=f.sr/N, freqs=new Float64Array(N);
  for(let i=0;i<N;i++) freqs[i]=f.fc+(i-(N>>1))*bin;
  return {mag:f.data,sr:f.sr,size:N,freqs,rev:0};
}

// Очередь звука: кадры sig приходят не в такт блокам движка. pull(n) отдаёт ровно n отсчётов (нехватку добивает нулями)
class PinRing{
  constructor(cap){ this.buf=new Float32Array(cap||48000); this.r=0; this.w=0; this.n=0; this.over=0; this.under=0; }
  push(a){
    if(a.length>this.buf.length) a=a.subarray(a.length-this.buf.length);
    const drop=this.n+a.length-this.buf.length;
    if(drop>0){ this.r=(this.r+drop)%this.buf.length; this.n-=drop; this.over++; }
    for(let i=0;i<a.length;i++){ this.buf[this.w]=a[i]; this.w=(this.w+1)%this.buf.length; }
    this.n+=a.length;
  }
  pull(out){
    const k=Math.min(out.length,this.n);
    for(let i=0;i<k;i++){ out[i]=this.buf[this.r]; this.r=(this.r+1)%this.buf.length; }
    this.n-=k;
    if(k<out.length){ out.fill(0,k); this.under++; }
    return out;
  }
}

/* ---------- узел Pins (custom): список пинов одной строкой ----------
   «>имя» — вход узла (данные из графа уходят наружу), «<имя» — выход узла (данные приходят снаружи); через запятую.
   Имя пина = id пина, поэтому провода переживают добавление и перестановку. */
const PINX_MAX=64;
const PINX_RESERVED=new Set(['rtc','on','grow','url','transport','pins','count','names']);   // это id служебных пинов и контролов узла
function pinxName(s){ return String(s==null ? '' : s).trim().replace(/[^\w.\-\/@]+/g,'_').slice(0,48); }
function pinxParse(text){
  const send=[], recv=[];
  for(const raw of String(text||'').split(',')){
    const t=raw.trim(), d=t[0];
    if(d!=='>' && d!=='<') continue;
    const name=pinxName(t.slice(1)), L=d==='>' ? send : recv;
    if(name && !PINX_RESERVED.has(name) && !L.includes(name) && send.length+recv.length<PINX_MAX) L.push(name);
  }
  return {send,recv};
}
// text + новый пин → новый text; null — такой уже есть / имя нельзя / список полон
function pinxWith(text,dir,name){
  name=pinxName(name);
  const x=pinxParse(text), L=dir==='send' ? x.send : x.recv;
  if(!name || PINX_RESERVED.has(name) || L.includes(name) || x.send.length+x.recv.length>=PINX_MAX) return null;
  const t=String(text||'').trim().replace(/,+$/,'');
  return (t ? t+', ' : '')+(dir==='send' ? '>' : '<')+name;
}
