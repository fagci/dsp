"use strict";
/* Сервер rtl_tcp (имитация поверх любого SDR): протокол без DOM — проверяется в tools/test-rtlserve.mjs.
   Сервер → клиент: 12 байт заголовка («RTL0», тип тюнера, число ступеней усиления; всё big-endian), дальше поток
   uint8 I,Q,I,Q… (смещение 127.5). Клиент → сервер: команды по 5 байт — [код][uint32 BE параметр]. */

const RTLS_TUNERS=['unknown','E4000','FC0012','FC0013','FC2580','R820T','R828D'];
// код → {k: имя поля, d: описание}; поля идут на выходы узла, по ним же строится hex-лог
const RTLS_CMDS={
  0x01:{k:'freq',   d:'set center frequency, Hz'},
  0x02:{k:'sr',     d:'set sample rate, Hz'},
  0x03:{k:'gainMode',d:'set gain mode (0 auto, 1 manual)'},
  0x04:{k:'gain',   d:'set tuner gain, tenths of dB'},
  0x05:{k:'ppm',    d:'set frequency correction, ppm (signed)'},
  0x06:{k:'ifGain', d:'set IF gain (stage<<16 | gain int16)'},
  0x07:{k:'test',   d:'test mode'},
  0x08:{k:'agc',    d:'RTL AGC'},
  0x09:{k:'direct', d:'direct sampling (0 off, 1 I, 2 Q)'},
  0x0a:{k:'offset', d:'offset tuning'},
  0x0b:{k:'rtlXtal',d:'RTL xtal, Hz'},
  0x0c:{k:'tunXtal',d:'tuner xtal, Hz'},
  0x0d:{k:'gainIdx',d:'set gain by index'},
  0x0e:{k:'bias',   d:'bias-T'},
  0x40:{k:'bw',     d:'tuner bandwidth, Hz (forks)'},
  0x41:{k:'gainIdx2',d:'gain index (forks)'}
};
const RTLS_SIGNED={5:1};                                                            // ppm приходит как int32

// заголовок 12 байт
function rtlsHeader(tuner,gains){
  const b=new Uint8Array(12), dv=new DataView(b.buffer);
  b[0]=0x52; b[1]=0x54; b[2]=0x4c; b[3]=0x30;
  dv.setUint32(4,tuner>>>0,false); dv.setUint32(8,gains>>>0,false);
  return b;
}
const rtlsTunerId=name=>{ const i=RTLS_TUNERS.indexOf(String(name)); return i<0 ? 0 : i; };

// команда → 5 байт (для тестов и клиентской стороны)
function rtlsCmd(code,val){
  const b=new Uint8Array(5); b[0]=code; new DataView(b.buffer).setUint32(1,val>>>0,false); return b;
}

// Потоковый разбор: байты приходят порциями любой длины, команда может быть разрезана пополам.
// feed(u8) → [{code, val (uint32), sval (int32), k, d, hex}]
class RtlsParser{
  constructor(){ this.buf=new Uint8Array(0); this.bad=0; }
  feed(u){
    let m=u;
    if(this.buf.length){ m=new Uint8Array(this.buf.length+u.length); m.set(this.buf); m.set(u,this.buf.length); }
    const out=[], dv=new DataView(m.buffer,m.byteOffset,m.byteLength);
    let o=0;
    for(; o+5<=m.length; o+=5){
      const code=m[o], val=dv.getUint32(o+1,false), c=RTLS_CMDS[code];
      if(!c) this.bad++;
      out.push({code, val, sval:val|0, k:c ? c.k : 'unknown', d:c ? c.d : 'unknown command', hex:rtlsHex(m.subarray(o,o+5))});
    }
    this.buf=m.slice(o);
    return out;
  }
}
const rtlsHex=u=>Array.from(u,x=>(x<16 ? '0' : '')+x.toString(16)).join(' ').toUpperCase();

// состояние сервера по командам клиента: то, что надо отдать железу
function rtlsNewState(){ return {freq:0, sr:0, gainMode:0, gain:0, ppm:0, agc:0, direct:0, offset:0, bias:0, bw:0, gainIdx:-1, ifGain:0, test:0}; }
function rtlsApply(st,cmd){
  const k=cmd.k==='gainIdx2' ? 'gainIdx' : cmd.k;
  if(!(k in st)) return false;
  if(k==='gain') st.gain=cmd.sval/10;                                              // десятые дБ → дБ
  else st[k]=RTLS_SIGNED[cmd.code] ? cmd.sval : cmd.val;
  return true;
}

// Чанк IQ потока → uint8 I,Q (смещение 127.5, как у RTL-SDR). Если чанк уже u8 — копия без пересчёта.
function rtlsToU8(c){
  if(c.raw && c.fmt==='u8') return c.raw.slice();
  const re=c.re, im=c.im, n=re.length, o=new Uint8Array(n*2);
  for(let i=0;i<n;i++){
    let a=re[i]*127.5+127.5, b=im ? im[i]*127.5+127.5 : 127.5;
    o[2*i]=a<0 ? 0 : a>255 ? 255 : (a+.5)|0;
    o[2*i+1]=b<0 ? 0 : b>255 ? 255 : (b+.5)|0;
  }
  return o;
}

// Ближайшая из допустимых частот дискретизации железа (по логарифму): клиент просит любую, USB SDR умеет не всякую.
function rtlsPick(want,list){
  let b=list[0];
  for(const r of list) if(Math.abs(Math.log(r/want))<Math.abs(Math.log(b/want))) b=r;
  return b;
}
