"use strict";
/* ============================ Quansheng UV-K5: загрузчик, ядро ============================
   Протокол бутлоадера UV-K5 (38400 8N1, радио включено с зажатой PTT). Кадр:
     AB CD | длина u16 | данные (длина чётная) | CRC-16/XMODEM u16 | DC BA, числа little-endian.
   Данные и CRC (но не маркеры) гаммируются XOR с 16-байтной таблицей, счёт с начала данных.
   Данные кадра: тип u16 | длина тела u16 | тело. Радио шлёт маяк 0x0518 (версия бутлоадера в теле со смещения 16),
   в ответ — рукопожатие 0x0530 (первые 4 символа версии), затем страницы по 256 Б: 0x0519 → подтверждение 0x051A.
   Драйвер k5Flash(io, data, opts, report) — см. flasher.js. Проверка: node tools/test-uvk5.mjs */

const K5_BAUD=38400, K5_MAX=120*1024, K5_PAGE=256;
const K5_OBFUS=Uint8Array.from([0x16,0x6c,0x14,0xe6,0x2e,0x91,0x0d,0x40,0x21,0x35,0xd5,0x40,0x13,0x03,0xe9,0x80]);
const K5_BEACON=0x0518, K5_PAGE_MSG=0x0519, K5_ACK=0x051A, K5_HELLO=0x0530;
const K5_DEF={beacons:5, beaconMs:10000, ackMs:3000, retries:3};

function k5Crc(u,off,size){
  let c=0;
  for(let i=0;i<size;i++){
    c^=u[off+i]<<8;
    for(let k=0;k<8;k++) c=(c&0x8000 ? (c<<1)^0x1021 : c<<1)&0xFFFF;
  }
  return c;
}
function k5Xor(u,off,size){ for(let i=0;i<size;i++) u[off+i]^=K5_OBFUS[i&15]; }

// данные кадра (тип, длина, тело…) → байты на провод
function k5Pack(msg){
  const ln=msg.length+(msg.length&1), p=new Uint8Array(8+ln), dv=new DataView(p.buffer);
  dv.setUint16(0,0xCDAB,true); dv.setUint16(2,ln,true); p.set(msg,4);
  dv.setUint16(4+ln,k5Crc(p,4,ln),true); dv.setUint16(6+ln,0xBADC,true);
  k5Xor(p,4,2+ln);
  return p;
}

// поток байтов → кадры {type, len, body, crcOk}; body — всё после заголовка данных (вместе с дополнением и CRC)
class K5Rx{
  constructor(){ this.buf=new Uint8Array(0); this.bad=0; }
  reset(){ this.buf=new Uint8Array(0); }
  push(u){
    if(u && u.length){ const b=new Uint8Array(this.buf.length+u.length); b.set(this.buf); b.set(u,this.buf.length); this.buf=b; }
    const out=[];
    for(;;){
      const b=this.buf; let i=0;
      while(i+1<b.length && !(b[i]===0xAB && b[i+1]===0xCD)) i++;
      if(i+1>=b.length){ this.buf=b.length && b[b.length-1]===0xAB ? b.slice(-1) : new Uint8Array(0); break; }
      if(b.length-i<8){ this.buf=b.slice(i); break; }
      const ln=b[i+2]|b[i+3]<<8, end=i+6+ln;
      if(ln>2048){ this.bad++; this.buf=b.slice(i+2); continue; }
      if(b.length<end+2){ this.buf=b.slice(i); break; }
      if(b[end]!==0xDC || b[end+1]!==0xBA){ this.bad++; this.buf=b.slice(i+2); continue; }
      const msg=b.slice(i+4,i+4+ln+2);
      k5Xor(msg,0,ln+2);
      out.push({type:msg[0]|msg[1]<<8, len:msg[2]|msg[3]<<8, body:msg.subarray(4), crcOk:k5Crc(msg,0,ln)===(msg[ln]|msg[ln+1]<<8)});
      this.buf=b.slice(end+2);
    }
    return out;
  }
}

// версия бутлоадера из маяка: строка в теле со смещения 16
function k5Version(body){
  if(body.length<32) return '';
  let s=''; for(let i=16;i<32 && body[i];i++) s+=String.fromCharCode(body[i]);
  return s;
}
function k5Hello(ver){
  const m=new Uint8Array(8), dv=new DataView(m.buffer);
  dv.setUint16(0,K5_HELLO,true); dv.setUint16(2,4,true);
  for(let i=0;i<4;i++) m[4+i]=ver.charCodeAt(i)||0;
  return m;
}
function k5PageMsg(ts,idx,pages,data){
  const m=new Uint8Array(16+K5_PAGE), dv=new DataView(m.buffer);
  dv.setUint16(0,K5_PAGE_MSG,true); dv.setUint16(2,268,true); dv.setUint32(4,ts>>>0,true); dv.setUint16(8,idx,true); dv.setUint16(10,pages,true);
  m.set(data.subarray(idx*K5_PAGE,(idx+1)*K5_PAGE),16);
  return m;
}
const k5Ack=body=>({page:body[4]|body[5]<<8, err:body[6]|body[7]<<8});

function k5Prepare(bytes){
  if(!bytes.length) throw new Error('empty file');
  if(bytes.length>K5_MAX) throw new Error('firmware too large: '+bytes.length+' > '+K5_MAX);
  return bytes;
}

async function k5Flash(io,data,o,report){
  o={...K5_DEF,...o};
  const pages=Math.ceil(data.length/K5_PAGE), rx=new K5Rx();
  const pump=async ms=>{ const u=await io.read(ms); return u ? rx.push(u) : []; };

  report(0,'waiting for the bootloader: power the radio on with PTT held…');
  let ver='', cnt=0;
  for(const t0=io.now(); cnt<o.beacons; ){
    if(io.now()-t0>o.beaconMs) throw new Error('radio not detected');
    for(const m of await pump(50)) if(m.type===K5_BEACON){
      const v=k5Version(m.body);
      if(v && v===ver) cnt++; else { ver=v; cnt=v ? 1 : 0; }
    }
  }
  report(0,'bootloader '+ver+', handshake…');

  let hello=0;
  for(let i=0;i<3;i++){
    await io.sleep(50);
    if((await pump(0)).some(m=>m.type===K5_BEACON)){ await io.write(k5Pack(k5Hello(ver))); hello++; }
  }
  if(!hello) await io.write(k5Pack(k5Hello(ver)));
  await io.sleep(200); io.flush(); rx.reset();

  const ts=Date.now()>>>0;
  let idx=0, retry=0;
  while(idx<pages){
    report(idx/pages,'page '+(idx+1)+'/'+pages);
    await io.write(k5Pack(k5PageMsg(ts,idx,pages,data)));
    let res=null;
    for(const t0=io.now(); res===null && io.now()-t0<o.ackMs; ){
      for(const m of await pump(Math.max(1,o.ackMs-(io.now()-t0)))){
        if(m.type!==K5_ACK) continue;
        const a=k5Ack(m.body);
        if(a.page===idx){ res=a.err; break; }
      }
    }
    if(res===0){ idx++; retry=0; continue; }
    if(++retry>o.retries) throw new Error(res ? 'device error '+res+' on page '+idx : 'no acknowledgement for page '+idx);
  }
  report(1,'done: '+pages+' pages');
}

if(typeof module!=='undefined') module.exports={k5Crc,k5Pack,K5Rx,k5Version,k5Hello,k5PageMsg,k5Ack,k5Prepare,k5Flash,K5_MAX,K5_PAGE};
