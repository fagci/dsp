"use strict";
/* ============================ Голос и видео в пакетах: ядро ============================
   Без DOM и сети. Кодеки отдают «единицы» (пакет из нескольких аудиокадров, JPEG-кадр), единица = одно сообщение провода bin, а
   везёт её любой канал: Sync Data, MQTT, Bytes → Frames → модем. Заголовок единицы 5 байт: [кодек][метка потока][номер u16][кадров];
   номер растёт на каждую отправленную единицу, поэтому приёмник видит потери и перестановки. Аудио принимает jitter-буфер
   (перестановки, потерянный пакет маскируется, очередь не растёт), частоты приводит MdResampler. Проверяется tools/test-media.mjs. */

const MD_HDR=5;
const MD_CODEC={opus:1,c2_3200:2,c2_1600:3,ulaw:4,jpeg:16};
// частота дискретизации, длительность кадра (мс) и размер кадра в байтах (0 — переменный, перед кадром байт длины)
const MD_INFO={1:{rate:48000,ms:20,size:0},2:{rate:8000,ms:20,size:8},3:{rate:8000,ms:40,size:8},4:{rate:8000,ms:20,size:160}};

function mdTag(label){ let h=0x811c9dc5; for(const c of String(label||'')){ h^=c.charCodeAt(0); h=Math.imul(h,16777619); } return (h>>>0)&255; }
// frames — массив Uint8Array; переменные кадры получают байт длины
function mdPack(codec,tag,seq,frames){
  const v=!MD_INFO[codec] || !MD_INFO[codec].size;
  let n=MD_HDR; for(const f of frames) n+=f.length+(v && codec!==MD_CODEC.jpeg ? 1 : 0);
  const o=new Uint8Array(n); o[0]=codec; o[1]=tag&255; o[2]=(seq>>8)&255; o[3]=seq&255; o[4]=frames.length;
  let p=MD_HDR;
  for(const f of frames){ if(v && codec!==MD_CODEC.jpeg) o[p++]=f.length; o.set(f,p); p+=f.length; }
  return o;
}
function mdUnpack(u){
  if(!u || u.length<MD_HDR) return null;
  const codec=u[0], tag=u[1], seq=(u[2]<<8)|u[3], nf=u[4], info=MD_INFO[codec], frames=[];
  if(codec===MD_CODEC.jpeg){ if(u.length===MD_HDR) return null; return {codec,tag,seq,nf:1,frames:[u.subarray(MD_HDR)]}; }
  if(!info || !nf) return null;
  let p=MD_HDR;
  for(let i=0;i<nf;i++){
    const l=info.size || u[p++];
    if(l===undefined || p+l>u.length || !l) return null;
    frames.push(u.subarray(p,p+l)); p+=l;
  }
  return {codec,tag,seq,nf,frames};
}
const mdSeqNewer=(a,b)=>b===null || b===undefined || (a!==b && ((a-b)&0xFFFF)<0x8000);

// ---------- μ-law (G.711), без wasm и WebCodecs: запасной путь для любого браузера ----------
function mdUlawEnc(s){                                 // int16 → байт
  let x=s<0 ? (s===-32768 ? 32767 : -s) : s; const sign=s<0 ? 0 : 0x80;
  x=Math.min(x,32635)+132;
  let e=7; for(let m=0x4000;(x&m)===0 && e>0;m>>=1) e--;
  return ~(sign|(e<<4)|((x>>(e+3))&15))&255;
}
function mdUlawDec(b){
  b=~b&255; const e=(b>>4)&7, m=b&15, x=(((m<<3)+132)<<e)-132;
  return b&0x80 ? x : -x;
}

// ---------- ресемплер: оконный sinc, потоковый ----------
class MdResampler {
  constructor(inRate,outRate,H=12){
    this.step=inRate/outRate; this.H=H; this.fc=Math.min(1,outRate/inRate)*.46;      // срез в долях входной частоты дискретизации
    this.buf=new Float32Array(0); this.base=0; this.t=0;
  }
  push(x){                                             // → Float32Array выходных отсчётов
    const nb=new Float32Array(this.buf.length+x.length); nb.set(this.buf); nb.set(x,this.buf.length); this.buf=nb;
    const H=this.H, fc=this.fc, top=this.base+nb.length, out=[];
    for(;;){
      const t=this.t, i0=Math.floor(t);
      if(i0+H>=top) break;
      let y=0;
      for(let k=i0-H+1;k<=i0+H;k++){
        const d=k-t, j=k-this.base; if(j<0) continue;
        const a=2*Math.PI*fc*d, s=Math.abs(a)<1e-9 ? 1 : Math.sin(a)/a;
        y+=nb[j]*2*fc*s*(.5+.5*Math.cos(Math.PI*d/H));
      }
      out.push(y); this.t+=this.step;
    }
    const keep=Math.max(0,Math.floor(this.t)-H-this.base);
    if(keep>0){ this.buf=nb.slice(keep); this.base+=keep; }
    return Float32Array.from(out);
  }
}

// ---------- jitter-буфер аудио ----------
// push(seq, pcm) — декодированный пакет (Float32Array); pull(n) — ровно n отсчётов. Потерянный пакет заменяется затухающим
// повтором предыдущего, пока ждать нечего — тишина; после опустошения новое воспроизведение начинается с пред-накопления.
class MdJitter {
  constructor(rate,preMs=120,maxMs=600){
    this.pre=Math.round(rate*preMs/1000); this.max=Math.round(rate*maxMs/1000);
    this.q=new Map(); this.next=null; this.cur=null; this.ofs=0; this.fill=0; this.playing=false; this.last=null; this.plen=0; this.lateRun=0;
    this.stat={got:0,late:0,lost:0,dropped:0,under:0};
  }
  push(seq,pcm){
    if(this.next===null) this.next=seq;
    if(seq!==this.next && !mdSeqNewer(seq,this.next)){
      this.stat.late++;
      if(++this.lateRun<=25) return;                      // много «старых» подряд — отправитель начал заново
      this.reset(); this.next=seq;
    }
    this.lateRun=0;
    if(this.q.has(seq)) return;
    this.q.set(seq,pcm); this.fill+=pcm.length; this.plen=pcm.length; this.stat.got++;
    while(this.fill>this.max && this.q.size>1){            // отстали: выбрасываем самый старый
      let k=this.next; while(!this.q.has(k)) k=(k+1)&0xFFFF;
      this.fill-=this.q.get(k).length; this.q.delete(k); this.next=(k+1)&0xFFFF; this.stat.dropped++;
    }
  }
  get queued(){ return this.fill; }                       // отсчётов в очереди
  pull(n){
    const o=new Float32Array(n);
    if(!this.playing){
      if(this.fill<Math.max(this.pre,Math.round(this.plen*1.5))) return o;     // и не меньше полутора пакетов: иначе буфер пуст каждый раз, когда ждём следующий
      this.playing=true;
    }
    let i=0;
    while(i<n){
      if(!this.cur || this.ofs>=this.cur.length){
        this.cur=null;
        if(this.q.has(this.next)){ this.cur=this.q.get(this.next); this.q.delete(this.next); this.fill-=this.cur.length; this.last=this.cur; this.next=(this.next+1)&0xFFFF; this.ofs=0; }
        else if(this.q.size){                              // за пропуском есть пакеты: этот потерян
          let near=65536; for(const k of this.q.keys()) near=Math.min(near,(k-this.next)&0xFFFF);
          if(near>30){ this.next=(this.next+near)&0xFFFF; continue; }       // далеко: отправитель прыгнул, не маскируем десятки пакетов
          const L=this.last, len=L ? L.length : this.plen, c=new Float32Array(len);
          if(L) for(let k=0;k<len;k++) c[k]=L[k]*(1-(k+1)/len)*.7;
          this.cur=c; this.last=null; this.ofs=0; this.next=(this.next+1)&0xFFFF; this.stat.lost++;
        } else { this.playing=false; this.stat.under++; this.last=null; return o; }   // очередь пуста: тишина до нового накопления
      }
      const m=Math.min(n-i,this.cur.length-this.ofs);
      o.set(this.cur.subarray(this.ofs,this.ofs+m),i); this.ofs+=m; i+=m;
    }
    return o;
  }
  reset(){ this.q.clear(); this.next=null; this.cur=null; this.fill=0; this.playing=false; this.last=null; }
}

// ---------- обёртка единицы для байтового канала (радиомодем по UART, TNC, BLE-UART): разбирает Packet Link с тем же frame ----------
const MD_WRAPS=['none (messages)','len8','len16be','slip','kiss','cobs'];
function mdWrap(kind,u){
  const k=String(kind||'').split(' ')[0];
  if(k==='none' || !k) return u;
  if(k==='len8'){ if(u.length>255) return null; const o=new Uint8Array(u.length+1); o[0]=u.length; o.set(u,1); return o; }
  if(k==='len16be'){ if(u.length>65535) return null; const o=new Uint8Array(u.length+2); o[0]=u.length>>8; o[1]=u.length&255; o.set(u,2); return o; }
  if(k==='slip' || k==='kiss'){
    const o=[0xC0]; if(k==='kiss') o.push(0);             // KISS: FEND, команда «данные, порт 0»
    for(const b of u){ if(b===0xC0) o.push(0xDB,0xDC); else if(b===0xDB) o.push(0xDB,0xDD); else o.push(b); }
    o.push(0xC0); return Uint8Array.from(o);
  }
  if(k==='cobs'){
    const o=[]; let at=0; o.push(0);
    for(const b of u){
      if(b===0){ o[at]=o.length-at; at=o.length; o.push(0); }
      else { o.push(b); if(o.length-at===255){ o[at]=255; at=o.length; o.push(0); } }
    }
    o[at]=o.length-at; o.push(0); return Uint8Array.from(o);
  }
  return u;
}
