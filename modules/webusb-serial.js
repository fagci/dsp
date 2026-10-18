"use strict";
/* ============================ WebSerial поверх WebUSB ============================
   В Chrome на Android нет navigator.serial, зато есть WebUSB: порт собирается из USB-устройства (OTG-кабель).
   Драйверы: CDC-ACM (tinySA, Flipper, Pico, ESP32-C3/S3/C5 по родному USB), CH340/CH341, CP210x.
   Ставится там, где navigator.serial нет, и на Android поверх родного: родной показывает системный диалог, а нужен выбор USB. Не проверялось на железе. */
(()=>{
if(typeof navigator==='undefined' || !navigator.usb) return;
if(navigator.serial && !/Android/i.test(navigator.userAgent)) return;

const bitsOf=o=>({data:o.dataBits||8, stop:o.stopBits===2?2:1, parity:o.parity==='even'?2:o.parity==='odd'?1:0});

// драйверы: init(dev,io,o) настраивает скорость и формат, lines(dev,io,dtr,rts) — DTR/RTS
const out=(dev,type,req,value,index,data)=>dev.controlTransferOut({requestType:type,recipient:type==='class'?'interface':'device',request:req,value,index},data);
const inp=(dev,req,value,index,len)=>dev.controlTransferIn({requestType:'vendor',recipient:'device',request:req,value,index},len);

const DRV={
  cdc:{
    async init(dev,io,o){
      const b=bitsOf(o), d=new DataView(new ArrayBuffer(7));
      d.setUint32(0,o.baudRate,true); d.setUint8(4,b.stop===2?2:0); d.setUint8(5,b.parity); d.setUint8(6,b.data);
      await dev.controlTransferOut({requestType:'class',recipient:'interface',request:0x20,value:0,index:io.comm},d);
    },
    lines:(dev,io,dtr,rts)=>dev.controlTransferOut({requestType:'class',recipient:'interface',request:0x22,value:(dtr?1:0)|(rts?2:0),index:io.comm}),
  },
  ch34x:{
    async init(dev,io,o){
      const b=bitsOf(o);
      await inp(dev,0x5f,0,0,2);
      await out(dev,'vendor',0xa1,0,0);
      let f=Math.floor(1532620800/o.baudRate), div=3;
      while(f>0xfff0 && div>0){ f>>=3; div--; }
      f=0x10000-f;
      const lcr=0xc0|(b.data-5)|(b.stop===2?4:0)|(b.parity?0x08|(b.parity===2?0x10:0):0);
      await out(dev,'vendor',0x9a,0x1312,((f&0xff00)|div|0x80));
      await out(dev,'vendor',0x9a,0x0f2c,f&0xff);
      await out(dev,'vendor',0x9a,0x2518,lcr);
    },
    lines:(dev,io,dtr,rts)=>out(dev,'vendor',0xa4,(~((dtr?0x20:0)|(rts?0x40:0)))&0xffff,0),
  },
  cp210x:{
    async init(dev,io,o){
      const b=bitsOf(o), d=new DataView(new ArrayBuffer(4));
      const v=(req,value,data)=>dev.controlTransferOut({requestType:'vendor',recipient:'interface',request:req,value,index:io.iface},data);
      await v(0x00,1);
      d.setUint32(0,o.baudRate,true);
      await v(0x1e,0,d);
      await v(0x03,(b.data<<8)|(b.parity<<4)|(b.stop===2?2:0));
    },
    lines:(dev,io,dtr,rts)=>dev.controlTransferOut({requestType:'vendor',recipient:'interface',request:0x07,value:0x0300|(dtr?1:0)|(rts?2:0),index:io.iface}),
  },
};

// какой драйвер и какие конечные точки у устройства
function probe(dev){
  const cfg=dev.configuration; if(!cfg) throw new Error('no USB configuration');
  const kind=dev.vendorId===0x1a86?'ch34x':dev.vendorId===0x10c4?'cp210x':'cdc';
  const io={kind, comm:0, iface:-1};
  for(const itf of cfg.interfaces){
    const a=itf.alternates[0];
    if(a.interfaceClass===2) io.comm=itf.interfaceNumber;
    const i=a.endpoints.find(e=>e.type==='bulk'&&e.direction==='in'), o=a.endpoints.find(e=>e.type==='bulk'&&e.direction==='out');
    if(i && o && (io.iface<0 || a.interfaceClass===10)){ io.iface=itf.interfaceNumber; io.epIn=i.endpointNumber; io.epOut=o.endpointNumber; io.size=i.packetSize||64; }
  }
  if(io.iface<0) throw new Error('no bulk endpoints (not a serial device)');
  if(kind!=='cdc') io.comm=io.iface;
  return io;
}

class UsbSerialPort extends EventTarget{
  constructor(dev){
    super(); this.dev=dev; this.readable=null; this.writable=null;
    this.dtr=true; this.rts=true; this.io=null; this.alive=false;
  }
  getInfo(){ return {usbVendorId:this.dev.vendorId, usbProductId:this.dev.productId}; }
  async open(o){
    o=o||{}; const dev=this.dev;
    if(!o.baudRate) throw new TypeError('baudRate is required');
    if(this.alive) throw new DOMException('The port is already open.','InvalidStateError');
    try{
      await dev.open();
      if(!dev.configuration) await dev.selectConfiguration(1);
      const io=this.io=probe(dev);
      await dev.claimInterface(io.iface);
      if(io.comm!==io.iface) await dev.claimInterface(io.comm);
      await DRV[io.kind].init(dev,io,o);
      this.dtr=this.rts=true;
      await DRV[io.kind].lines(dev,io,true,true);
    }catch(e){
      try{ await dev.close(); }catch(_){}
      throw new DOMException('Failed to open serial port: '+(e&&e.message||e),'NetworkError');
    }
    this.alive=true;
    const io=this.io, size=Math.max(o.bufferSize||0,io.size,4096);
    this.readable=new ReadableStream({
      pull:async ctl=>{
        try{
          const r=await dev.transferIn(io.epIn,Math.max(io.size,512));
          if(r.status==='stall') await dev.clearHalt('in',io.epIn);
          else if(r.status==='babble') throw new DOMException('Buffer overrun','BufferOverrunError');
          else if(r.data && r.data.byteLength) ctl.enqueue(new Uint8Array(r.data.buffer.slice(r.data.byteOffset,r.data.byteOffset+r.data.byteLength)));
        }catch(e){
          if(!this.alive) return;
          this.alive=false; ctl.error(e);
          this.dispatchEvent(new Event('disconnect'));
        }
      },
    },{highWaterMark:size, size:c=>c.byteLength});
    this.writable=new WritableStream({
      write:async chunk=>{
        const u=ArrayBuffer.isView(chunk)?new Uint8Array(chunk.buffer,chunk.byteOffset,chunk.byteLength):new Uint8Array(chunk);
        const r=await dev.transferOut(io.epOut,u);
        if(r.status==='stall') await dev.clearHalt('out',io.epOut);
      },
    });
  }
  async close(){
    if(!this.alive && !this.readable) return;
    if((this.readable&&this.readable.locked) || (this.writable&&this.writable.locked))
      throw new TypeError('Cannot close a port with locked streams');
    this.alive=false;
    const {dev,io}=this;
    try{ await dev.releaseInterface(io.iface); if(io.comm!==io.iface) await dev.releaseInterface(io.comm); }catch(_){}
    try{ await dev.close(); }catch(_){}
    this.readable=this.writable=null;
  }
  async setSignals(s){
    if(!this.alive) throw new DOMException('The port is closed.','InvalidStateError');
    if('dataTerminalReady' in s) this.dtr=!!s.dataTerminalReady;
    if('requestToSend' in s) this.rts=!!s.requestToSend;
    await DRV[this.io.kind].lines(this.dev,this.io,this.dtr,this.rts);
  }
  async getSignals(){ return {dataCarrierDetect:false, clearToSend:false, ringIndicator:false, dataSetReady:false}; }
  async forget(){ try{ await this.close(); }catch(_){} try{ await this.dev.forget(); }catch(_){} }
}

class UsbSerial extends EventTarget{
  constructor(){
    super(); this.ports=new Map();
    navigator.usb.addEventListener('disconnect',e=>{
      const p=this.ports.get(e.device); if(!p) return;
      p.alive=false; p.dispatchEvent(new Event('disconnect',{bubbles:true}));
      this.dispatchEvent(new Event('disconnect'));
    });
  }
  port(dev){ let p=this.ports.get(dev); if(!p){ p=new UsbSerialPort(dev); this.ports.set(dev,p); } return p; }
  async getPorts(){ return (await navigator.usb.getDevices()).filter(d=>d.vendorId!==undefined).map(d=>this.port(d)); }
  async requestPort(opt){
    // любой последовательный адаптер: CDC (в т.ч. составной), CH34x, CP210x
    let f=((opt&&opt.filters)||[]).map(x=>{ const r={}; if(x.usbVendorId!==undefined) r.vendorId=x.usbVendorId; if(x.usbProductId!==undefined) r.productId=x.usbProductId; return r; });
    if(!f.length) f=[{classCode:2},{classCode:10},{vendorId:0x1a86},{vendorId:0x10c4}];
    return this.port(await navigator.usb.requestDevice({filters:f}));
  }
}

Object.defineProperty(navigator,'serial',{value:new UsbSerial(), configurable:true});
})();
