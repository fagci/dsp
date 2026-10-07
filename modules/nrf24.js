"use strict";
/* ============================ nRF24L01+ (USB-мост по WebSerial) ============================
   Радиомодуль nRF24L01+ подключён к плате с USB-UART (Arduino Nano / Uno, RP2040, ESP32), на плате — прошивка моста
   tools/nrf24-bridge. Браузер говорит с мостом строками (115200): CFG / TX / RXON / SCAN, мост отвечает RX / TXOK / TXFAIL / SCAN.
   Разбор — control-kernels.js. Модуль принимает и передаёт на своём канале и адресе и сканирует занятость 126 каналов 2.4 ГГц;
   чужие устройства не перехватывает. (nRF52 / nRF Connect по BLE — модули BLE UART и BLE GATT.) */

async function nrfTeardown(n){
  n.connected=false; n.connecting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function nrfConnect(n){
  if(n.connecting) return;
  await nrfTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:115200, bufferSize:65536});
    n.port=port; n.writer=port.writable.getWriter(); n.connecting=false; n.connected=true; n.status='connected, waiting for the bridge…';
    nrfReadLoop(n);
    setTimeout(()=>{ if(n.connected){ nrfSend(n,'PING'); nrfApply(n); } },1800);        // Arduino перезагружается при открытии порта
  }catch(e){
    n.connecting=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
    await nrfTeardown(n);
  }
}
async function nrfReadLoop(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  const dec=new TextDecoder(); let buf='';
  try{
    while(n.connected){
      const {value,done}=await reader.read();
      if(done) break;
      if(!value) continue;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n'))>=0){ nrfLine(n,buf.slice(0,i)); buf=buf.slice(i+1); }
      if(buf.length>4096) buf='';
    }
    if(n.connected){ n.status='port closed by device'; nrfTeardown(n); }
  }catch(e){
    if(n.connected){ n.status='read error: '+e.message; nrfTeardown(n); }
  }
}
function nrfSend(n,line){
  if(!n.connected || !n.writer) return false;
  n.writer.write(new TextEncoder().encode(line+'\n')).catch(()=>{});
  return true;
}
function nrfApply(n){                                   // настройки радио и режим приёма
  if(!n.connected) return;
  nrfSend(n,nrfCfgLine(n.p));
  nrfSend(n,n.p.mode==='receive' ? 'RXON' : 'RXOFF');
}
function nrfLine(n,line){
  const m=nrfParseLine(line); if(!m) return;
  const now=Date.now();
  if(m.k==='rx'){
    n.rxCount++; n.last={t:now,ch:m.ch,hex:m.hex};
    n.rxPend.push({t:now, id:n.p.id||'nrf24', label:'nRF24 ch '+m.ch, ch:m.ch, freq_mhz:2400+m.ch, addr:nrfHex(n.p.addr)||'', len:m.hex.length>>1, hex:m.hex, text:nrfHexToText(m.hex)});
    if(n.rxPend.length>200) n.rxPend.shift();
  } else if(m.k==='txok'){ n.txOk++; n.ack=1; }
  else if(m.k==='txfail'){ n.txFail++; n.ack=0; }
  else if(m.k==='scan'){ n.spec=nrfScanSpec(m.counts,+n.scanPasses||1,(n.spec?.rev|0)+1); n.scanning=false; n.status='scan done'; }
  else if(m.k==='pong'){ n.status='bridge: '+m.info; }
  else if(m.k==='err'){ n.status='bridge error: '+m.msg; }
}
// payload из текста провода: hex или обычный текст; в статический размер — обрезаем / добиваем нулями
function nrfPayload(n,s){
  let hex=n.p.fmt==='hex' ? nrfHex(s) : nrfTextToHex(s);
  if(!hex) return null;
  const pay=+n.p.pay|0, max=pay>0 ? pay : 32;
  hex=hex.slice(0,max*2);
  if(pay>0) hex=hex.padEnd(pay*2,'0');
  return hex;
}

def({ id:'nrf24', lazy:'manual', title:'nRF24L01+ (USB bridge)', cat:'Sources', kw:'nrf24 nrf24l01 radio 2.4 ghz transceiver rc remote control link bridge arduino rf24 scan channel',
  ins:[{n:'send',t:'txt'},{n:'ch',t:'num'}],
  outs:[{n:'rx',t:'txt'},{n:'hex',t:'txt'},{n:'go',t:'num'},{n:'rec',t:'rec'},{n:'count',t:'num'},{n:'ok',t:'num'},{n:'spec',t:'spec'}],
  readout:true, tall:true, w:400, resize:true,
  params:[{n:'connect',t:'button',label:'Connect bridge',fn:n=>nrfConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; nrfTeardown(n); }},
          {n:'mode',t:'select',opts:['transmit','receive'],d:'transmit',label:'mode (the radio is either sending or listening)',fn:n=>nrfApply(n)},
          {n:'ch',t:'range',min:0,max:125,step:1,d:76,label:'channel (2400 + ch MHz; a wire on ch overrides)',fn:n=>nrfApply(n)},
          {n:'rate',t:'select',opts:['250K','1M','2M'],d:'1M',label:'data rate',fn:n=>nrfApply(n)},
          {n:'addr',t:'text',d:'E7E7E7E7E7',label:'address, 3–5 bytes hex',fn:n=>nrfApply(n)},
          {n:'pay',t:'range',min:0,max:32,step:1,d:8,label:'payload bytes (0 — dynamic)',fn:n=>nrfApply(n)},
          {n:'pwr',t:'range',min:0,max:3,step:1,d:3,label:'TX power 0 (−18 dBm) … 3 (0 dBm)',fn:n=>nrfApply(n)},
          {n:'crc',t:'select',opts:['0','1','2'],d:'2',label:'CRC bytes',fn:n=>nrfApply(n)},
          {n:'ack',t:'check',d:true,label:'auto-acknowledge (the receiver must answer)',fn:n=>nrfApply(n)},
          {n:'retry',t:'range',min:0,max:15,step:1,d:5,label:'retries',fn:n=>nrfApply(n)},
          {n:'fmt',t:'select',opts:['text','hex'],d:'text',label:'send input as'},
          {n:'passes',t:'range',min:1,max:100,step:1,d:20,label:'scan: passes per channel'},
          {n:'scan',t:'button',label:'Scan 2.4 GHz channels',fn:n=>{ if(nrfSend(n,'SCAN '+(+n.p.passes|0))){ n.scanning=true; n.scanPasses=+n.p.passes|0; n.status='scanning…'; } else n.status='connect the bridge first'; }},
          {n:'id',t:'text',d:'nrf24',label:'record id',adv:true}],
  init:n=>{ n.port=null; n.reader=null; n.writer=null; n.connected=false; n.connecting=false; n.status='not connected';
            n.rxPend=[]; n.rxCount=0; n.txOk=0; n.txFail=0; n.ack=null; n.last=null; n.spec=null; n.scanning=false; n.scanPasses=20;
            n.lastSend=undefined; n.lastCh=null; n.pulse=0; n.sentN=0; },
  dispose:n=>{ nrfTeardown(n).catch(e=>console.error('nrf24 dispose:',e)); },
  process(n,I){
    const ch=recNum(I.ch);
    if(ch!=null && Math.round(ch)!==n.lastCh && ch>=0 && ch<=125){ n.lastCh=Math.round(ch); setMod(n,'ch',n.lastCh); nrfApply(n); }
    if(typeof I.send==='string' && I.send!==n.lastSend){
      n.lastSend=I.send;
      if(I.send && n.connected && n.p.mode==='transmit'){
        const hex=nrfPayload(n,I.send);
        if(hex){ nrfSend(n,'TX '+hex); n.sentN++; }
      }
    }
    const rx=n.rxPend; n.rxPend=[];
    if(rx.length) n.pulse=1;
    const go=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
    const l=rx[rx.length-1];
    return {rx:l ? l.text : (n.last ? nrfHexToText(n.last.hex) : null), hex:l ? l.hex : (n.last ? n.last.hex : null), go,
            rec:rx.length ? rx : null, count:n.rxCount, ok:n.ack, spec:n.spec};
  },
  drawKey:n=>n.status+'|'+n.rxCount+'|'+n.txOk+'|'+n.txFail+'|'+n.sentN+'|'+n.spec?.rev+'|'+Math.floor(Date.now()/500),
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const rows=[n.status+(n.scanning ? ' …' : ''),
      `ch ${n.p.ch} (${2400+ +n.p.ch} MHz) · ${n.p.rate} · ${n.p.mode} · addr ${nrfHex(n.p.addr)||'?'} · payload ${+n.p.pay||'dynamic'}`,
      `sent ${n.sentN} (ok ${n.txOk}, failed ${n.txFail}) · received ${n.rxCount}`+(n.last ? ` · last ${n.last.hex.slice(0,32)}` : '')];
    const t=rows.join('\n'); if(el.textContent!==t) el.textContent=t;
  }});
