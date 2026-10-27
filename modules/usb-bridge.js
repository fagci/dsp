"use strict";
/* ============================ WebUSB поверх USB-API моста ============================
   В Android WebView нет navigator.usb. Приложение tools/android отдаёт USB телефона по WebSocket (/usb, двоичный протокол:
   [u32 длина заголовка][заголовок JSON][данные]); здесь из него собирается навигатор WebUSB, который ждут модули (RTL-SDR, HackRF,
   логические анализаторы, WebUSB-Serial…). Адрес со своим ключом страница берёт у приложения (DspApp.usbUrl); в обычном браузере
   модуль ничего не делает. Модуль подключается раньше webusb-serial.js — тот проверяет navigator.usb при загрузке.
   Не поддержано: изохронные передачи (Android не даёт их через UsbDeviceConnection). Тест — tools/test-usbbridge.mjs. */

function usbBridgeMatch(f,d){
  if(f.vendorId!==undefined && f.vendorId!==d.vendorId) return false;
  if(f.productId!==undefined && f.productId!==d.productId) return false;
  if(f.serialNumber!==undefined && f.serialNumber!==d.serialNumber) return false;
  if(f.classCode!==undefined || f.subclassCode!==undefined || f.protocolCode!==undefined){
    const ok=(c,s,p)=>(f.classCode===undefined || f.classCode===c) && (f.subclassCode===undefined || f.subclassCode===s) && (f.protocolCode===undefined || f.protocolCode===p);
    if(ok(d.deviceClass,d.deviceSubclass,d.deviceProtocol)) return true;
    return d.configurations.some(c=>c.interfaces.some(i=>i.alternates.some(a=>ok(a.interfaceClass,a.interfaceSubclass,a.interfaceProtocol))));
  }
  return true;
}

// ui.choose(список строк) → Promise<индекс | -1>; ui не задан — окошко на странице
function usbBridgeInstall(nav,url,WS,ui){
  const enc=new TextEncoder(), dec=new TextDecoder();
  const err=(name,msg)=>typeof DOMException==='function' ? new DOMException(msg||name,name) : Object.assign(new Error(msg||name),{name});
  let ws=null, opening=null, seq=1;
  const pend=new Map(), devs=new Map(), hub=new EventTarget();

  function drop(e){
    ws=null; opening=null;
    for(const p of pend.values()) p.rej(err('NetworkError',e||'the USB bridge is closed'));
    pend.clear();
    for(const d of devs.values()) d.opened=false;
  }
  function connect(){
    if(ws && ws.readyState===1) return Promise.resolve();
    if(opening) return opening;
    return opening=new Promise((res,rej)=>{
      let w; try{ w=new WS(url); }catch(e){ opening=null; rej(err('NetworkError',e.message)); return; }
      w.binaryType='arraybuffer'; ws=w;
      w.onopen=()=>{ opening=null; res(); };
      w.onerror=()=>{};                                  // следом придёт close
      w.onclose=()=>{ if(ws===w){ const had=opening; drop(); if(had) rej(err('NetworkError','cannot reach the USB bridge')); } };
      w.onmessage=e=>message(e.data);
    });
  }
  function message(buf){
    if(!(buf instanceof ArrayBuffer) || buf.byteLength<4) return;
    const hl=new DataView(buf).getUint32(0);
    let h; try{ h=JSON.parse(dec.decode(new Uint8Array(buf,4,hl))); }catch(e){ return; }
    if(h.ev){ event(h); return; }
    const p=pend.get(h.id); if(!p) return;
    pend.delete(h.id);
    if(h.ok) p.res({h,data:buf.slice(4+hl)}); else p.rej(err(h.err||'NetworkError',h.msg));
  }
  async function rpc(op,args,payload){
    await connect();
    const id=seq++, hb=enc.encode(JSON.stringify({id,op,...args})), n=payload ? payload.byteLength : 0;
    const m=new Uint8Array(4+hb.length+n);
    new DataView(m.buffer).setUint32(0,hb.length);
    m.set(hb,4); if(n) m.set(payload,4+hb.length);
    return new Promise((res,rej)=>{ pend.set(id,{res,rej}); try{ ws.send(m); }catch(e){ pend.delete(id); rej(err('NetworkError',e.message)); } });
  }
  const bytes=d=>d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer,d.byteOffset,d.byteLength);

  // ---- модель устройства ----
  class USBEndpoint{ constructor(e){ this.endpointNumber=e.num; this.direction=e.in ? 'in' : 'out'; this.type=e.type; this.packetSize=e.size; } }
  class USBAlternateInterface{ constructor(i){
    this.alternateSetting=i.alt; this.interfaceClass=i.cls; this.interfaceSubclass=i.sub; this.interfaceProtocol=i.proto;
    this.interfaceName=i.name||undefined; this.endpoints=i.eps.map(e=>new USBEndpoint(e)); } }
  class USBInterface{ constructor(num,alts){ this.interfaceNumber=num; this.alternates=alts.map(a=>new USBAlternateInterface(a)); this.alternate=this.alternates[0]; this.claimed=false; } }
  class USBConfiguration{ constructor(c){
    this.configurationValue=c.value; this.configurationName=c.name||undefined;
    const by=new Map(); for(const i of c.ifaces){ if(!by.has(i.num)) by.set(i.num,[]); by.get(i.num).push(i); }
    this.interfaces=[...by].map(([n,a])=>new USBInterface(n,a)); } }
  const ver=s=>{ const m=/^(\d+)\.(\d)(\d)?/.exec(s||''); return m ? [+m[1],+m[2],+(m[3]||0)] : [0,0,0]; };

  class USBDevice{
    constructor(d){ this._id=d.id; this.opened=false; this.configuration=null; this.update(d); }
    update(d){
      if(!this._rawv){ this.usbVersionMajor=2; this.usbVersionMinor=0; this.usbVersionSubminor=0; }
      this.deviceClass=d.cls; this.deviceSubclass=d.sub; this.deviceProtocol=d.proto; this.vendorId=d.vid; this.productId=d.pid;
      [this.deviceVersionMajor,this.deviceVersionMinor,this.deviceVersionSubminor]=ver(d.ver);
      this.manufacturerName=d.mfr||undefined; this.productName=d.prod||undefined; this.serialNumber=d.serial||undefined;
      const old=this.configurations;
      this.configurations=old && old.length===d.configs.length ? old : d.configs.map(c=>new USBConfiguration(c));
    }
    _need(){ if(!this.opened) throw err('InvalidStateError','The device must be opened first.'); }
    _iface(n){
      const i=this.configuration && this.configuration.interfaces.find(x=>x.interfaceNumber===n);
      if(!i) throw err('NotFoundError','The interface number '+n+' is not valid.'); return i;
    }
    async open(){
      if(this.opened) return;
      const r=await rpc('open',{dev:this._id}); this.opened=true;
      if(r.h.configs && r.h.configs.length) this._raw(r.h);
      this.configuration=this.configuration||this.configurations[0]||null;
    }
    // дескрипторы из сырых байт устройства: модель UsbDevice в Android может не показывать альтернативные настройки (alt 3 у Mirics…)
    _raw(h){
      const cur=this.configuration && this.configuration.configurationValue;
      this.configurations=h.configs.map(c=>new USBConfiguration(c));
      this.configuration=this.configurations.find(c=>c.configurationValue===cur)||null;
      [this.usbVersionMajor,this.usbVersionMinor,this.usbVersionSubminor]=ver(h.usb);
      this.speed=h.speed||undefined; this._rawv=true;
    }
    async close(){ if(!this.opened) return; await rpc('close',{dev:this._id}); this.opened=false; for(const c of this.configurations) for(const i of c.interfaces) i.claimed=false; }
    async forget(){ await this.close().catch(()=>{}); devs.delete(this._id); }
    async selectConfiguration(v){
      this._need();
      const c=this.configurations.find(x=>x.configurationValue===v); if(!c) throw err('NotFoundError','The configuration value '+v+' is not valid.');
      await rpc('config',{dev:this._id,value:v}); this.configuration=c;
    }
    async claimInterface(n){ this._need(); const i=this._iface(n); if(i.claimed) return; await rpc('claim',{dev:this._id,num:n}); i.claimed=true; }
    async releaseInterface(n){ this._need(); const i=this._iface(n); if(!i.claimed) return; await rpc('release',{dev:this._id,num:n}); i.claimed=false; }
    async selectAlternateInterface(n,alt){
      this._need(); const i=this._iface(n); if(!i.claimed) throw err('InvalidStateError','The interface must be claimed first.');
      const a=i.alternates.find(x=>x.alternateSetting===alt); if(!a) throw err('NotFoundError','The alternate setting is not valid.');
      await rpc('alt',{dev:this._id,num:n,alt}); i.alternate=a;
    }
    _rt(s,dir){
      const t={standard:0,class:0x20,vendor:0x40}[s.requestType], r={device:0,interface:1,endpoint:2,other:3}[s.recipient];
      if(t===undefined || r===undefined) throw new TypeError('bad control transfer parameters');
      return dir|t|r;
    }
    async controlTransferIn(s,len){
      this._need();
      const r=await rpc('control',{dev:this._id,rt:this._rt(s,0x80),req:s.request,val:s.value,idx:s.index,len});
      return {data:new DataView(r.data),status:'ok'};
    }
    async controlTransferOut(s,data){
      this._need(); const p=data ? bytes(data) : new Uint8Array(0);
      await rpc('control',{dev:this._id,rt:this._rt(s,0),req:s.request,val:s.value,idx:s.index,len:p.length},p);
      return {bytesWritten:p.length,status:'ok'};
    }
    async transferIn(ep,len){ this._need(); const r=await rpc('in',{dev:this._id,ep:0x80|ep,len}); return {data:new DataView(r.data),status:'ok'}; }
    async transferOut(ep,data){ this._need(); const p=bytes(data); const r=await rpc('out',{dev:this._id,ep},p); return {bytesWritten:r.h.written,status:'ok'}; }
    async clearHalt(dir,ep){ this._need(); await rpc('clear',{dev:this._id,ep:(dir==='in' ? 0x80 : 0)|ep}); }
    async reset(){ this._need(); await rpc('reset',{dev:this._id}); }
    async isochronousTransferIn(){ throw err('NotSupportedError','Isochronous transfers are not available in the Android app.'); }
    async isochronousTransferOut(){ throw err('NotSupportedError','Isochronous transfers are not available in the Android app.'); }
  }

  const get=d=>{ let x=devs.get(d.id); if(x) x.update(d); else devs.set(d.id,x=new USBDevice(d)); return x; };
  function event(h){
    if(h.ev==='disconnect'){
      const d=devs.get(h.id); if(!d) return;
      d.opened=false; devs.delete(h.id);
      hub.dispatchEvent(Object.assign(new Event('disconnect'),{device:d}));
    } else if(h.ev==='connect'){
      hub.dispatchEvent(Object.assign(new Event('connect'),{device:get(h)}));
    }
  }

  function pick(lines){
    if(ui && ui.choose) return ui.choose(lines);
    return new Promise(res=>{
      const o=document.createElement('div');
      o.style.cssText='position:fixed;inset:0;z-index:99999;background:#000a;display:flex;align-items:center;justify-content:center';
      const b=document.createElement('div');
      b.style.cssText='background:var(--bg,#222);color:var(--fg,#eee);padding:16px;border-radius:10px;max-width:90vw;min-width:260px;font:14px sans-serif';
      b.innerHTML='<div style="margin-bottom:10px;font-weight:600">Select a USB device</div>';
      const done=i=>{ o.remove(); res(i); };
      lines.forEach((t,i)=>{ const x=document.createElement('button'); x.textContent=t; x.style.cssText='display:block;width:100%;margin:4px 0;padding:10px;text-align:left'; x.onclick=()=>done(i); b.appendChild(x); });
      const c=document.createElement('button'); c.textContent='Cancel'; c.style.cssText='display:block;width:100%;margin-top:8px;padding:10px'; c.onclick=()=>done(-1); b.appendChild(c);
      o.appendChild(b); document.body.appendChild(o);
    });
  }

  const usb=Object.assign(hub,{
    async getDevices(){
      const l=(await rpc('list',{})).h.devices, ids=new Set(l.map(d=>d.id));
      for(const id of [...devs.keys()]) if(!ids.has(id)) devs.delete(id);
      return l.filter(d=>d.perm).map(get);
    },
    async requestDevice(o){
      const fl=(o && o.filters) || [];
      const l=(await rpc('list',{})).h.devices;
      const m=l.filter(d=>!fl.length || fl.some(f=>usbBridgeMatch(f,{vendorId:d.vid,productId:d.pid,serialNumber:d.serial||undefined,deviceClass:d.cls,deviceSubclass:d.sub,deviceProtocol:d.proto,
        configurations:d.configs.map(c=>({interfaces:[{alternates:c.ifaces.map(i=>({interfaceClass:i.cls,interfaceSubclass:i.sub,interfaceProtocol:i.proto}))}]}))})));
      if(!m.length) throw err('NotFoundError','No device selected.');
      const i=m.length===1 ? 0 : await pick(m.map(d=>(d.prod||'USB device')+' ('+d.vid.toString(16).padStart(4,'0')+':'+d.pid.toString(16).padStart(4,'0')+')'));
      if(i<0) throw err('NotFoundError','No device selected.');
      if(!(await rpc('perm',{dev:m[i].id})).h.granted) throw err('NotFoundError','No device selected.');
      const d=(await rpc('list',{})).h.devices.find(x=>x.id===m[i].id);       // после доступа видны название и серийный номер
      if(!d) throw err('NotFoundError','The device is gone.');
      return get(d);
    },
  });
  for(const t of ['connect','disconnect']){            // onconnect / ondisconnect
    let cur=null;
    Object.defineProperty(usb,'on'+t,{configurable:true,get:()=>cur,set:f=>{ if(cur) usb.removeEventListener(t,cur); cur=typeof f==='function' ? f : null; if(cur) usb.addEventListener(t,cur); }});
  }
  Object.defineProperty(nav,'usb',{value:usb,configurable:true});
  return usb;
}

(()=>{
  if(typeof navigator==='undefined' || navigator.usb || typeof WebSocket==='undefined') return;
  let url=''; try{ url=(window.DspApp && DspApp.usbUrl && DspApp.usbUrl()) || localStorage.getItem('dsp-usb-bridge') || ''; }catch(e){}
  if(url) usbBridgeInstall(navigator,url,WebSocket,null);
})();
