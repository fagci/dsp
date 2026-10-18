"use strict";
/* ============================ Radtel RT-890 / RT-4D: загрузчик, ядро ============================
   Один протокол (115200 8N1), радио отвечает байтом: 6 — ACK, 0xFF в ответ на пробное чтение — режим загрузчика.
   Команда = код | 2 байта | данные | сумма (сумма байтов + смещение профиля) & 255:
     0x52 чтение (проба: 52 00 00), 0x39 стирание, 0x57 запись блока: 57 | адрес hi | адрес lo (младшие 16 бит) | блок.
   Профиль задаёт размер блока, смещение суммы, команды стирания и размер памяти.
   Драйвер rtbFlash(io, fw, profile, opts, report) — см. flasher.js. Проверка: node tools/test-rtboot.mjs */

const RTB_ACK=6, RTB_FLASH_MODE=0xFF;
const RTB_PROFILES={
  rt890:{block:0x80, ck:0, erase:[[0x39,0,0,0x55]], size:0xEC00, full:false},
  rt4d: {block:0x400, ck:72, erase:[[0x39,0x33,0x05,0x10],[0x39,0x33,0x05,0x55]], size:0x3D800, full:true},
};
const RTB_DEF={ackMs:3000, eraseMs:10000, retries:3};

function rtbCmd(bytes,ck){
  const p=new Uint8Array(bytes.length+1); p.set(bytes);
  let s=ck; for(const b of bytes) s+=b;
  p[bytes.length]=s&255;
  return p;
}
function rtbWrite(off,chunk,ck){
  const b=new Uint8Array(3+chunk.length); b[0]=0x57; b[1]=(off>>8)&255; b[2]=off&255; b.set(chunk,3);
  return rtbCmd(b,ck);
}
// прошивка → образ: до целого числа блоков (full — до всего размера памяти), добивка нулями
function rtbPrepare(bytes,prof){
  if(!bytes.length) throw new Error('empty file');
  if(bytes.length>prof.size) throw new Error('firmware too large: '+bytes.length+' > '+prof.size);
  const n=prof.full ? prof.size : Math.ceil(bytes.length/prof.block)*prof.block;
  const img=new Uint8Array(n); img.set(bytes);
  return img;
}

async function rtbFlash(io,fw,prof,o,report){
  o={...RTB_DEF,...o};
  const total=fw.length/prof.block;
  const first=async ms=>{ const u=await io.read(ms); return u ? u[0] : -1; };

  report(0,'probing the bootloader…');
  io.flush();
  await io.write(rtbCmd([0x52,0,0],prof.ck));
  const r=await io.read(o.ackMs);
  if(!r) throw new Error('no response: put the radio into the flashing mode');
  await io.sleep(100); io.flush();
  if(r[0]!==RTB_FLASH_MODE) throw new Error('radio is not in the flashing mode');

  for(let i=0;i<prof.erase.length;i++){
    report(0,'erasing'+(prof.erase.length>1 ? ' '+(i+1)+'/'+prof.erase.length : '')+'…');
    await io.write(rtbCmd(prof.erase[i],prof.ck));
    const b=await first(o.eraseMs);
    if(b!==RTB_ACK) throw new Error(b<0 ? 'no ACK to erase' : 'erase refused (0x'+b.toString(16)+')');
  }

  for(let blk=0;blk<total;blk++){
    report(blk/total,'block '+(blk+1)+'/'+total);
    const off=blk*prof.block, pkt=rtbWrite(off,fw.subarray(off,off+prof.block),prof.ck);
    for(let tries=0;;){
      await io.write(pkt);
      const b=await first(o.ackMs);
      if(b===RTB_ACK) break;
      if(++tries>o.retries) throw new Error(b<0 ? 'no ACK at 0x'+off.toString(16) : 'write refused at 0x'+off.toString(16)+' (0x'+b.toString(16)+')');
    }
  }
  report(1,'done: '+fw.length+' bytes'+(fw.length<prof.size ? ' · the firmware does not fill the memory, the radio will not restart by itself' : ''));
}

if(typeof module!=='undefined') module.exports={rtbCmd,rtbWrite,rtbPrepare,rtbFlash,RTB_PROFILES};
