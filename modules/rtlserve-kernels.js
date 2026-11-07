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

// байты → hex без пробелов (поле hex команд приложения tcp.send)
const rtlsHexC=u=>{ let s=''; for(let i=0;i<u.length;i++) s+=(u[i]<16 ? '0' : '')+u[i].toString(16); return s; };
const rtlsFromHex=h=>{ const o=new Uint8Array(h.length>>1); for(let i=0;i<o.length;i++) o[i]=parseInt(h.substr(i*2,2),16); return o; };

/* Пересэмплирование потока под частоту, которую попросил клиент (SDR++ просит 250 kS/s, а USB SDR умеет от 960 kS/s).
   Каскад: ФНЧ (окно Блэкмана, срез 0.47·Fout) + прореживание в D = ⌊Fin/Fout⌋ раз, затем кубическая интерполяция (4 точки, Лагранж)
   до Fout — линейная на 75 кГц при 256 кС/с занижала амплитуду на четверть. Поточный: состояние (история фильтра, 3 последних
   отсчёта, фаза) переходит между чанками любой длины. Fin < Fout (клиент просит чуть больше, чем даёт железо, — 0.96 → 1.024) —
   только интерполяция, без ФНЧ: полоса исходного потока уже уже новой. */
class RtlsResampler{
  constructor(fin,fout,tpp){
    this.fin=fin; this.fout=fout;
    const up=fin<fout*0.9999;
    this.D=up ? 1 : Math.max(1,Math.floor(fin/fout+1e-9));
    const D=this.D, L=up ? 1 : D*(tpp||24)+1, fc=0.47*fout/fin, mid=(L-1)/2, h=new Float32Array(L);
    let sum=0;
    if(up) h[0]=1;
    else for(let i=0;i<L;i++){
      const x=i-mid, sinc=x===0 ? 2*fc : Math.sin(2*Math.PI*fc*x)/(Math.PI*x);
      h[i]=sinc*(0.42-0.5*Math.cos(2*Math.PI*i/(L-1))+0.08*Math.cos(4*Math.PI*i/(L-1))); sum+=h[i];
    }
    if(!up) for(let i=0;i<L;i++) h[i]/=sum;
    this.h=h; this.hr=new Float32Array(L-1); this.hi=new Float32Array(L-1); this.ph=0;       // история фильтра, фаза прореживания
    this.ratio=(fin/D)/fout; this.pos=2;                                                     // шаг интерполяции; положение в буфере [3 прошлых | новые]
    this.tr=new Float32Array(3); this.ti=new Float32Array(3);                                // три последних отсчёта после прореживания
  }
  // re, im — Float32Array одной длины (im может быть null — вещественный поток) → {re, im}
  push(re,im){
    const h=this.h, L=h.length, H=L-1, D=this.D, K=re.length;
    const br=new Float32Array(H+K), bi=new Float32Array(H+K);
    br.set(this.hr); br.set(re,H); bi.set(this.hi); if(im) bi.set(im,H);
    const cnt=this.ph<K ? Math.floor((K-1-this.ph)/D)+1 : 0, m=cnt;
    const ar=new Float32Array(3+m), ai=new Float32Array(3+m);
    ar.set(this.tr); ai.set(this.ti);
    let p=this.ph;
    for(let k=0;k<cnt;k++,p+=D){
      let sr=0, si=0;
      for(let j=0;j<L;j++){ const g=h[j]; sr+=g*br[p+j]; si+=g*bi[p+j]; }
      ar[3+k]=sr; ai[3+k]=si;
    }
    this.ph=p-K; this.hr.set(br.subarray(K)); this.hi.set(bi.subarray(K));
    const maxOut=Math.ceil(m/this.ratio)+2, or=new Float32Array(maxOut), oi=new Float32Array(maxOut), len=3+m;
    let n=0, pos=this.pos;
    // между отсчётами i и i+1 нужны i-1 … i+2: пока i+2 не пришёл, ждём
    while(pos<len-2 && n<maxOut){
      const i=Math.floor(pos), f=pos-i;
      const w0=-f*(f-1)*(f-2)/6, w1=(f+1)*(f-1)*(f-2)/2, w2=-(f+1)*f*(f-2)/2, w3=(f+1)*f*(f-1)/6;
      or[n]=w0*ar[i-1]+w1*ar[i]+w2*ar[i+1]+w3*ar[i+2]; oi[n]=w0*ai[i-1]+w1*ai[i]+w2*ai[i+1]+w3*ai[i+2]; n++; pos+=this.ratio;
    }
    this.pos=pos-m; this.tr.set(ar.subarray(m)); this.ti.set(ai.subarray(m));
    return {re:or.subarray(0,n), im:oi.subarray(0,n)};
  }
}
