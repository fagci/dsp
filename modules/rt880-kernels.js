"use strict";
/* ============================ Radtel RT-880: загрузчик, ядро ============================
   Протокол бутлоадера RT-880 (115200 8N1). Хост шлёт короткие команды, радио отвечает одним байтом: 6 — ACK, 255 — NAK.
   Порядок: connect → ACK, connect → ACK, connect → ACK, update → ACK, затем 246 блоков по 1 КиБ, каждый подтверждается;
   в конце команда end. Блок: 'W' | адрес hi | адрес lo (младшие 16 бит смещения) | 1024 Б | сумма байтов (первые 1027) + смещение.
   Команды и смещение суммы у варианта iRadio другие. Прошивка — .bin или Intel HEX (адреса от 0x08002800, размер 246 КиБ, пустое — 0xFF).
   Драйвер rtFlash(io, fw, opts, report) — см. flasher.js. Проверка: node tools/test-rt880.mjs */

const RT_BAUD=115200, RT_BLOCK=1024, RT_SIZE=251904, RT_BASE=0x08002800;
const RT_CMD={
  std:   {connect:Uint8Array.from([57,51,5,16,211]), end:Uint8Array.from([57,51,5,238,177]), update:Uint8Array.from([57,51,5,85,24]),  ck:82},
  iradio:{connect:Uint8Array.from([57,51,5,16,129]), end:Uint8Array.from([57,51,5,238,95]),  update:Uint8Array.from([57,51,5,85,198]), ck:0},
};
const RT_DEF={ackMs:3000, connectMs:200, retries:3};

function rtBlock(fw,off,ck){
  const p=new Uint8Array(1028); p[0]=87; p[1]=(off>>8)&255; p[2]=off&255;
  p.set(fw.subarray(off,off+RT_BLOCK),3);
  let s=ck; for(let i=0;i<1027;i++) s+=p[i];
  p[1027]=s&255;
  return p;
}

// Intel HEX → образ RT_SIZE; записи вне окна [RT_BASE, RT_BASE+RT_SIZE) пропускаются
function rtParseHex(text){
  const img=new Uint8Array(RT_SIZE).fill(0xFF);
  let ext=0, placed=0, eof=false, line=0;
  for(const raw of text.split(/\r?\n/)){
    line++;
    const l=raw.trim(); if(!l) continue;
    if(l[0]!==':' || l.length<11 || l.length%2===0 || /[^0-9a-fA-F]/.test(l.slice(1))) throw new Error('line '+line+': not an Intel HEX record');
    const b=Uint8Array.from({length:(l.length-1)/2},(_,i)=>parseInt(l.substr(1+i*2,2),16));
    if(b[0]!==b.length-5) throw new Error('line '+line+': wrong length');
    let sum=0; for(const x of b) sum+=x;
    if(sum&255) throw new Error('line '+line+': checksum');
    const type=b[3], adr=b[1]<<8|b[2];
    if(type===0){
      const base=ext+adr-RT_BASE;
      for(let i=0;i<b[0];i++){ const pos=base+i; if(pos>=0 && pos<RT_SIZE){ img[pos]=b[4+i]; placed++; } }
    }else if(type===1){ eof=true; break; }
    else if(type===2) ext=(b[4]<<8|b[5])*16;
    else if(type===4) ext=(b[4]<<8|b[5])*65536;
  }
  if(!placed) throw new Error('no data in 0x'+RT_BASE.toString(16)+'…0x'+(RT_BASE+RT_SIZE).toString(16)+(eof ? '' : ' (no end record)'));
  return img;
}
function rtPrepare(bytes,fmt){
  if(!bytes.length) throw new Error('empty file');
  let hex=fmt==='hex';
  if(fmt==='auto'||!fmt){ let i=0; while(i<bytes.length && bytes[i]<=32) i++; hex=bytes[i]===0x3A; }
  if(hex) return rtParseHex(new TextDecoder('latin1').decode(bytes));
  if(bytes.length>RT_SIZE) throw new Error('firmware too large: '+bytes.length+' > '+RT_SIZE);
  const img=new Uint8Array(RT_SIZE).fill(0xFF); img.set(bytes);
  return img;
}

async function rtFlash(io,fw,o,report){
  o={...RT_DEF,...o};
  const c=o.iradio ? RT_CMD.iradio : RT_CMD.std, total=RT_SIZE/RT_BLOCK;
  let q=[], qi=0;
  // следующий значимый байт ответа или -1 по тайм-ауту; нули (покой загрузчика) пропускаются
  const byte=async ms=>{
    for(;;){
      while(qi<q.length){ const b=q[qi++]; if(b!==0) return b; }
      const u=await io.read(ms);
      if(!u) return -1;
      q=Array.from(u); qi=0;
    }
  };
  const expect=async(what,ms)=>{
    const b=await byte(ms);
    if(b===6) return;
    throw new Error(b===255 ? 'NAK on '+what : b<0 ? 'no ACK on '+what : 'unexpected byte '+b+' on '+what);
  };

  report(0,'connecting: put the radio into the bootloader…');
  let up=false;
  for(let i=0;i<4 && !up;i++){
    await io.write(c.connect);
    const b=await byte(o.connectMs);
    if(b===6) up=true;
    else if(b===255) throw new Error('NAK on connect');
  }
  if(!up) throw new Error('no response from the device');
  for(let i=2;i<=3;i++){ await io.write(c.connect); await expect('connect '+i,o.ackMs); }
  await io.write(c.update); await expect('update',o.ackMs);

  let lastUnacked=false;
  for(let blk=0;blk<total;blk++){
    report(blk/total,'block '+(blk+1)+'/'+total);
    for(let tries=0;;){
      await io.write(rtBlock(fw,blk*RT_BLOCK,c.ck));
      const b=await byte(o.ackMs);
      if(b===6) break;
      if(++tries>o.retries){
        // радио может перезагрузиться, не ответив на последний блок: команду end всё равно шлём
        if(blk===total-1 && b<0){ lastUnacked=true; break; }
        throw new Error(b===255 ? 'NAK on block '+blk : b<0 ? 'no ACK on block '+blk : 'unexpected byte '+b+' on block '+blk);
      }
    }
  }
  await io.write(c.end);
  await byte(500);
  await io.sleep(100);
  report(1,'done: '+total+' blocks'+(lastUnacked ? ' (the last block was not acknowledged)' : ''));
}

if(typeof module!=='undefined') module.exports={rtBlock,rtParseHex,rtPrepare,rtFlash,RT_CMD,RT_SIZE,RT_BLOCK,RT_BASE};
