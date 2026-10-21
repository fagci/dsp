"use strict";
/* ============================ MJPEG по каналу данных: ядро ============================
   Без DOM и сети. Кадр = одно сообщение: [0xF1][длина имени][имя UTF-8][номер кадра u16][JPEG]. Имя — метка потока (как track у WebRTC):
   принимает узел с той же меткой. Номер нужен, чтобы запоздавший кадр не затирал более новый. Качество подстраивается под размер
   кадра, чтобы канал не копил очередь. Проверяется tools/test-mjpeg.mjs. */

const MJ_MAGIC=0xF1, MJ_MAX_LABEL=60;
function mjPack(label,seq,jpeg){
  const nm=new TextEncoder().encode(String(label||'video')).slice(0,MJ_MAX_LABEL);
  const out=new Uint8Array(4+nm.length+jpeg.length);
  out[0]=MJ_MAGIC; out[1]=nm.length; out.set(nm,2); out[2+nm.length]=(seq>>8)&255; out[3+nm.length]=seq&255; out.set(jpeg,4+nm.length);
  return out.buffer;
}
function mjUnpack(buf){
  const u=buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if(u.length<5 || u[0]!==MJ_MAGIC) return null;
  const l=u[1]; if(u.length<4+l+1) return null;
  return {label:new TextDecoder().decode(u.subarray(2,2+l)),seq:(u[2+l]<<8)|u[3+l],jpeg:u.subarray(4+l)};
}
const mjNewer=(a,b)=>b===null || b===undefined || ((a-b)&0xFFFF)<0x8000 && a!==b;     // a новее b с учётом переполнения u16
// следующее качество JPEG: кадр больше цели — ниже, заметно меньше — выше (но не выше желаемого)
function mjAdapt(q,bytes,target,qmax){
  if(bytes>target) return Math.max(.3,q-(bytes>target*1.6 ? .1 : .04));
  if(bytes<target*.6) return Math.min(qmax,q+.03);
  return q;
}
