"use strict";
/* ============================ USB-логический анализатор (fx2lafw) для Logic Analyzer ============================
   Дешёвые 8-канальные «Saleae-клоны» на Cypress FX2 (CY7C68013A) и совместимые платы с прошивкой fx2lafw проекта sigrok.
   Канал 1…8 = D0…D7, 8 бит на отсчёт, потоком по bulk IN 2, дальше отсчёты идут в узел logan как обычные дорожки
   (запуск по фронту, декодеры UART / SPI / I²C, окно). Прошивка fx2lafw (GPL-2.0+) в репозиторий не входит: у платы без
   прошивки (при подключении ответа на команду версии нет) её берут из пакета sigrok-firmware-fx2lafw или из PulseView
   и грузят кнопкой «USB: load firmware (.fw)» — прошивка живёт в ОЗУ до отключения питания.
   Сам файл ничего не делает при загрузке: функции зовёт logican.js. */

const LUSB_RATES=[['20 kHz',2e4],['25 kHz',25e3],['50 kHz',5e4],['100 kHz',1e5],['200 kHz',2e5],['250 kHz',25e4],['500 kHz',5e5],['1 MHz',1e6],
                  ['2 MHz',2e6],['3 MHz',3e6],['4 MHz',4e6],['6 MHz',6e6],['8 MHz',8e6],['12 MHz',12e6],['16 MHz',16e6],['24 MHz',24e6]];
const LUSB_IDS=[[0x0925,0x3881],[0x04b4,0x8613],[0x1d50,0x608c],[0x08a9,0x0014]];      // Saleae и клоны, FX2 «из коробки», sigrok-fx2, Saleae Logic
const LUSB_MAX_DELAY=6*256, LUSB_EP=2, LUSB_CHUNK=4096, LUSB_QMAX=16<<20;
const lusbRate=n=>{ const r=LUSB_RATES.find(x=>x[0]===n.p.urate); return r ? r[1] : 1e6; };

// команда старта fx2lafw: флаги (бит 6 — тактирование 48 МГц, иначе 30 МГц; 8-битные отсчёты) и делитель
function lusbStartCmd(hz){
  let flags=0, delay;
  if(48e6%hz===0 && 48e6/hz-1<=LUSB_MAX_DELAY){ flags|=1<<6; delay=48e6/hz-1; }
  else if(30e6%hz===0 && 30e6/hz-1<=LUSB_MAX_DELAY) delay=30e6/hz-1;
  else return null;
  return {flags,delay,bytes:Uint8Array.of(flags,delay>>8,delay&255)};
}
const lusbVendor=(request,value=0)=>({requestType:'vendor',recipient:'device',request,value,index:0});

function lusbInit(n){
  n.udev=null; n.usbRun=false; n.uq=[]; n.uqLen=0; n.uoff=0; n.ubuf=null; n.ugen=0; n.udrop=0; n.ucount=0; n.ustat='USB: not connected';
}
// отсчёты за блок: не больше ~50 мс; очередь длиннее LUSB_QMAX — старое выбрасываем (счётчик udrop)
function lusbTake(n){
  const cap=Math.min(1<<20,Math.max(4096,Math.round(lusbRate(n)*.05)));
  if(!n.ubuf || n.ubuf.length<cap) n.ubuf=new Uint8Array(cap);
  let k=0;
  while(k<cap && n.uq.length){
    const c=n.uq[0], take=Math.min(c.length-n.uoff,cap-k);
    n.ubuf.set(c.subarray(n.uoff,n.uoff+take),k); k+=take; n.uoff+=take; n.uqLen-=take;
    if(n.uoff>=c.length){ n.uq.shift(); n.uoff=0; }
  }
  while(n.uqLen>LUSB_QMAX && n.uq.length>1){ const c=n.uq.shift(); n.uqLen-=c.length-n.uoff; n.udrop+=c.length-n.uoff; n.uoff=0; }
  n.ucount+=k;
  if(n.usbRun) n.ustat='USB: '+(n.ufw||'capturing')+' · '+(lusbRate(n)/1e6)+' MS/s · '+(n.ucount/1e6).toFixed(2)+' MS'+(n.udrop ? ' · dropped '+(n.udrop/1e6).toFixed(2)+' MS (too fast for the page — lower the rate)' : '');
  return {d:n.ubuf,n:k};
}
async function lusbProbe(d){                          // версия прошивки fx2lafw (команда 0xB0); у платы без прошивки ответа нет
  try{
    const r=await d.controlTransferIn(lusbVendor(0xB0),2);
    if(r.status==='ok' && r.data.byteLength>=2) return r.data.getUint8(0)+'.'+r.data.getUint8(1);
  }catch(e){}
  return null;
}
async function lusbOpen(n,d){
  n.udev=d; if(!d.opened) await d.open();
  if(d.configuration===null) await d.selectConfiguration(1);
  const fw=await lusbProbe(d);
  n.ufw=fw ? 'fx2lafw '+fw : '';
  n.ustat=fw ? 'USB: '+(d.productName||'device')+', fx2lafw '+fw+' — press «USB: start»'
             : 'USB: '+(d.productName||'device')+' has no fx2lafw firmware — press «USB: load firmware (.fw)» and pick a sigrok fx2lafw file';
}
async function lusbConnect(n){
  if(!navigator.usb){ n.ustat='WebUSB unavailable (needs Chrome/Edge/Opera)'; return; }
  await lusbStop(n);
  n.ustat='USB: choose a device…';
  try{
    const isOurs=x=>LUSB_IDS.some(f=>f[0]===x.vendorId && f[1]===x.productId);
    let d=(await navigator.usb.getDevices()).find(isOurs);
    if(!d) d=await navigator.usb.requestDevice({filters:LUSB_IDS.map(([vendorId,productId])=>({vendorId,productId}))});
    await lusbOpen(n,d);
  }catch(e){ n.ustat=e.name==='NotFoundError' ? 'USB: no device selected' : 'USB error: '+e.message; }
}
// прошивка: сброс ядра (CPUCS=1), запись образа с адреса 0 кусками, запуск (CPUCS=0); плата перечисляется заново
async function lusbUpload(d,img){
  const out=(addr,data)=>d.controlTransferOut(lusbVendor(0xA0,addr),data);
  await out(0xE600,Uint8Array.of(1));
  for(let off=0;off<img.length;off+=LUSB_CHUNK) await out(off,img.subarray(off,Math.min(img.length,off+LUSB_CHUNK)));
  try{ await out(0xE600,Uint8Array.of(0)); }catch(e){}                              // плата уходит на перезапуск посреди этого запроса — ошибка здесь не в счёт
}
function lusbFirmware(n){
  if(!n.udev){ n.ustat='USB: connect first, then load the firmware'; return; }
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.fw,application/octet-stream';
  inp.onchange=async()=>{
    const f=inp.files&&inp.files[0]; if(!f) return;
    try{
      const img=new Uint8Array(await f.arrayBuffer());
      if(img.length<256 || img.length>16384*2) throw new Error('not a fx2lafw image ('+img.length+' bytes)');
      const d=n.udev; n.ustat='USB: uploading '+f.name+'…';
      await lusbUpload(d,img);
      try{ await d.close(); }catch(e){}
      n.udev=null; n.ustat='USB: firmware loaded, the board restarts — wait a second and press «USB: connect»';
      setTimeout(()=>lusbAfterFirmware(n),1800);
    }catch(e){ n.ustat='USB firmware error: '+e.message; }
  };
  inp.click();
}
async function lusbAfterFirmware(n){                  // если браузер уже знает перезапущенную плату — подключиться сам
  if(n.udev || !navigator.usb) return;
  try{
    for(const d of await navigator.usb.getDevices()){
      if(!LUSB_IDS.some(f=>f[0]===d.vendorId && f[1]===d.productId)) continue;
      await lusbOpen(n,d); if(n.ufw) return;
      try{ await d.close(); }catch(e){}
    }
    n.udev=null; n.ustat='USB: firmware loaded — press «USB: connect» and choose the board again';
  }catch(e){}
}
async function lusbStart(n){
  if(!n.udev){ n.ustat='USB: not connected'; return; }
  if(n.usbRun) await lusbStop(n,true);
  const c=lusbStartCmd(lusbRate(n)); if(!c){ n.ustat='USB: rate not supported'; return; }
  const d=n.udev;
  try{
    if(!d.opened) await d.open();
    if(d.configuration===null) await d.selectConfiguration(1);
    await d.claimInterface(0);
    laReset(n);
    n.uq=[]; n.uqLen=0; n.uoff=0; n.ucount=0; n.udrop=0; n.usbRun=true; n.ugen++;
    await d.controlTransferOut(lusbVendor(0xB1),c.bytes);
    lusbRead(n,n.ugen);
  }catch(e){ n.usbRun=false; n.ustat='USB error: '+e.message; }
}
async function lusbRead(n,gen){                       // три запроса в полёте, чтобы FIFO платы не переполнялся между ними
  const d=n.udev, SZ=32768, pend=[], go=()=>{ const p=d.transferIn(LUSB_EP,SZ); p.catch(()=>{}); return p; };     // catch — чтобы запросы, оборванные закрытием, не давали unhandled rejection
  try{ for(let i=0;i<3;i++) pend.push(go()); }catch(e){ n.ustat='USB error: '+e.message; n.usbRun=false; return; }
  while(n.usbRun && n.ugen===gen){
    let r;
    try{ r=await pend.shift(); }
    catch(e){ if(n.ugen===gen){ n.usbRun=false; n.ustat='USB error: '+e.message; } return; }
    if(n.ugen!==gen) return;
    if(r.status==='ok' && r.data.byteLength){ n.uq.push(new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength)); n.uqLen+=r.data.byteLength; }
    else if(r.status==='stall'){ try{ await d.clearHalt('in',LUSB_EP); }catch(e){} }
    if(n.usbRun && n.ugen===gen) pend.push(go());
  }
}
async function lusbStop(n,keep){                      // закрытие обрывает висящие запросы; плату потом можно запустить снова
  const was=n.usbRun; n.usbRun=false; n.ugen++;
  const d=n.udev;
  if(d && d.opened){ try{ await d.close(); }catch(e){} }
  if(was && !keep) n.ustat='USB: stopped';
}
function lusbDispose(n){ lusbStop(n); n.udev=null; }

if(typeof module!=='undefined') module.exports={lusbStartCmd,LUSB_RATES,lusbUpload,LUSB_IDS};
