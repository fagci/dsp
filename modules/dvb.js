"use strict";
/* ============================ DVB-T / T2 / C: USB-донгл Astrometa (RTL2832U + R828D + MN88473 / MN88472) ============================
   Узел «DVB USB (Astrometa)»: WebUSB, настройка по драйверам Linux (dvb-kernels.js), транспортный поток на порт bin.
   Дальше — TS → Video. Прошивку демодулятора (dvb-demod-mn88473-01.fw / mn88472-02.fw из linux-firmware) пользователь выбирает
   файлом: она запоминается в браузере (IndexedDB). Без железа не проверялось: каждый шаг пишется в журнал узла. */

const DVBU={vid:[0x15f4,0x0bda], filters:[{vendorId:0x15f4,productId:0x0131},{vendorId:0x0bda,productId:0x2832},{vendorId:0x0bda,productId:0x2838}]};
let DVB_SEQ=0;

/* ---- прошивка в IndexedDB ---- */
function dvbFwDb(){
  return new Promise((res,rej)=>{ const rq=indexedDB.open('dsp-dvb',1);
    rq.onupgradeneeded=()=>rq.result.createObjectStore('fw');
    rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); });
}
async function dvbFwPut(name,bytes){ const db=await dvbFwDb(); return new Promise((res,rej)=>{ const t=db.transaction('fw','readwrite'); t.objectStore('fw').put(bytes,name); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); }); }
async function dvbFwGet(name){ const db=await dvbFwDb(); return new Promise((res,rej)=>{ const q=db.transaction('fw').objectStore('fw').get(name); q.onsuccess=()=>res(q.result||null); q.onerror=()=>rej(q.error); }); }
async function dvbFwFind(kind){
  const name= kind===473 ? 'dvb-demod-mn88473-01.fw' : 'dvb-demod-mn88472-02.fw';
  try{ const b=await dvbFwGet(name); if(b) return {name, data:new Uint8Array(b)}; }catch(e){}
  try{ const r=await fetch('vendor/'+name); if(r.ok) return {name, data:new Uint8Array(await r.arrayBuffer())}; }catch(e){}
  return {name, data:null};
}

/* ---- шина: I2C RTL2832U теми же командами, что и ядро (rtl28xxu_i2c_xfer) ---- */
const dvbSleep=ms=>new Promise(r=>setTimeout(r,ms));
function dvbBus(com){
  return {
    // запись < 23 байт — «старый» I2C (регистр в value), длиннее — прямой (CMD_I2C_DA_WR)
    async w(addr8,b){
      if(b.length<23) await com.raw.write(0x300,(b[0]<<8)|addr8,new Uint8Array(b.slice(1)).buffer);
      else await com.raw.write(0x600,addr8,new Uint8Array(b).buffer);
    },
    async r(addr8,reg,len){
      const d=new Uint8Array(await com.raw.read(0x300,(reg<<8)|addr8,len));
      if(d.length<len) throw new Error('I2C 0x'+addr8.toString(16)+' reg 0x'+reg.toString(16)+': no answer ('+d.length+' of '+len+' bytes)');
      return d;
    },
    async gate(on){ if(on) await com.i2c.open(); else await com.i2c.close(); },
    sleep:dvbSleep
  };
}
function dvbIo(com,dev,bus){
  const blk=r=>r<0x3000 ? RTL_BLOCK.USB : RTL_BLOCK.SYS;
  return {
    rd:r=>com.readRegister(blk(r),r,1),
    wr:(r,v)=>com.writeRegister(blk(r),r,v,1),
    wrMask:(r,v,m)=>com.writeRegMask(blk(r),r,v,m),
    wrBytes:(r,b)=>com.raw.write(blk(r)+0x0,r,new Uint8Array(b).buffer),
    demodR:(p,a)=>com.demod.readRegister(p,a),
    // многобайтная запись демодулятора (в том числе 3 байта, которых нет у com.demod): адрес (addr << 8) | 0x20, старший байт первым
    demodW:async(p,a,v,l)=>{
      const b=new Uint8Array(l); for(let i=0;i<l;i++) b[i]=(v>>>((l-1-i)*8))&255;
      await com.raw.write(p,(a<<8)|0x20,b.buffer);
      await com.demod.readRegister(0x0a,0x01);
    },
    sleep:dvbSleep,
    clearHalt:()=>dev.clearHalt('in',1)
  };
}

function dvbLog(n,s){
  const t=((performance.now()-n.dv_t0)/1000).toFixed(1).padStart(5);
  n.dv_logTxt.push(t+' '+s); if(n.dv_logTxt.length>60) n.dv_logTxt.shift();
  n.dv_status=s; n.dv_dirty=true;
}

/* ---- подключение ---- */
async function dvbConnect(n){
  if(n.dv_busy) return;
  n.dv_busy=true; n.dv_t0=performance.now(); n.dv_logTxt=[];
  try{
    await dvbDisconnect(n,true);
    if(!navigator.usb) throw new Error('WebUSB is not available (Chrome / Edge, https)');
    const dev=await navigator.usb.requestDevice({filters:DVBU.filters});
    dvbLog(n,'device '+dev.productName+' '+dev.vendorId.toString(16)+':'+dev.productId.toString(16));
    await dev.open();
    if(dev.configuration===null) await dev.selectConfiguration(1);
    await dev.claimInterface(0);
    n.dv_dev=dev;
    const com=rtlMakeCom(dev), bus=dvbBus(com), io=dvbIo(com,dev,bus);
    n.dv_com=com; n.dv_bus=bus; n.dv_io=io;
    // питание и пробы — порядок rtl28xxu: power_ctrl, read_config
    await DvbRtl.power(io,true); dvbLog(n,'power on');
    await DvbRtl.gpioProbe(io);
    await bus.gate(true);
    const probe=async(a8,reg)=>{ try{ return (await bus.r(a8,reg,1))[0]; }catch(e){ return null; } };
    const hex=v=>v==null ? 'no answer' : '0x'+v.toString(16);
    const tid=await probe(0x74,0);
    if(tid!==0x69){ await bus.gate(false); throw new Error('no R828D tuner on the bus (id '+hex(tid)+'): this is not an Astrometa DVB-T2 stick'); }
    dvbLog(n,'tuner R828D');
    await DvbRtl.slavePower(io);
    // как rtl2832u_read_config: MN88472 / MN88473 (банк 2, регистр 0xff), затем Sony CXD2837ER (0xd8, регистр 0xfd)
    let sid=null, cid=null;
    for(let i=0;i<3 && sid==null;i++){ sid=await probe(0x38,0xff); if(sid==null) await dvbSleep(50); }
    if(sid!==0x02 && sid!==0x03) cid=await probe(0xd8,0xfd);
    await bus.gate(false);
    dvbLog(n,'slave probe: 0x38/0xff → '+hex(sid)+(cid!=null || sid==null ? ', 0xd8/0xfd → '+hex(cid) : ''));
    const kind= sid===0x03 ? 473 : sid===0x02 ? 472 : 0;
    if(cid===0xb1) throw new Error('this stick has a Sony CXD2837ER demodulator — not supported yet (the log above is what it answered)');
    if(!kind) throw new Error('no MN88473 / MN88472 demodulator: it answered '+hex(sid)+' (expected 0x03 or 0x02)');
    dvbLog(n,'demodulator MN8847'+(kind===473?3:2));
    await DvbRtl.initEp(io);
    n.dv_tuner=new R82xxDvb(bus,{addr:0x74,xtal:16000000,chip:'R828D'});
    n.dv_demod=new Mn8847x(bus,kind);
    await n.dv_demod.probeSleep();
    await DvbRtl.slaveTs(io,true); dvbLog(n,'TS passes through RTL2832');
    const fw=await dvbFwFind(kind); n.dv_fwName=fw.name;
    if(!fw.data) dvbLog(n,'firmware '+fw.name+' not loaded yet — choose the file in the node (from linux-firmware)');
    await n.dv_demod.init(fw.data,p=>{ n.dv_status='firmware '+Math.round(p*100)+' %'; n.dv_dirty=true; });
    dvbLog(n,'demodulator ready'+(fw.data ? ', firmware '+fw.data.length+' bytes' : ''));
    await bus.gate(true); try{ await n.dv_tuner.init(); } finally{ await bus.gate(false); }
    dvbLog(n,'tuner ready (crystal capacitor '+n.dv_tuner.xtalCap+')');
    n.dv_connected=true;
    await dvbTune(n);
    dvbStream(n);
  }catch(e){
    dvbLog(n,'error: '+(e&&e.message||e)); console.error('dvb',e);
    await dvbDisconnect(n,true);
  }finally{ n.dv_busy=false; }
}

async function dvbDisconnect(n,quiet){
  n.dv_run=false;
  const dev=n.dv_dev;
  n.dv_connected=false; n.dv_locked=false;
  try{ if(n.dv_demod && dev){ await n.dv_demod.sleep(); } }catch(e){}
  try{ if(n.dv_tuner && dev){ await n.dv_bus.gate(true); await n.dv_tuner.standby(); await n.dv_bus.gate(false); } }catch(e){}
  try{ if(n.dv_io && dev) await DvbRtl.slaveTs(n.dv_io,false); }catch(e){}
  try{ if(n.dv_io && dev) await DvbRtl.power(n.dv_io,false); }catch(e){}
  try{ if(dev){ await dev.releaseInterface(0).catch(()=>{}); await dev.close().catch(()=>{}); } }catch(e){}
  n.dv_dev=n.dv_com=n.dv_bus=n.dv_io=n.dv_tuner=n.dv_demod=null;
  if(!quiet) dvbLog(n,'disconnected');
}

/* ---- настройка ---- */
function dvbSystems(n){
  const p=n.p.sys;
  if(p==='DVB-T2') return [DVB_SYS.T2];
  if(p==='DVB-T') return [DVB_SYS.T];
  if(p==='DVB-C') return [DVB_SYS.C];
  return [DVB_SYS.T2,DVB_SYS.T];                                // auto: сперва T2
}
async function dvbTune(n){
  if(!n.dv_connected || n.dv_tuning) return;
  n.dv_tuning=true;
  try{
    const list=dvbSystems(n);
    n.dv_sysIdx=(n.dv_sysIdx||0)%list.length;
    const sys=list[n.dv_sysIdx], f=Math.round(+n.p.freq*1e6), bw=Math.round(+n.p.bw*1e6);
    n.dv_sys=sys; n.dv_locked=false; n.dv_tuneAt=performance.now(); n.dv_freq=f; n.dv_bw=bw;
    const t=await n.dv_tuner.tune(sys,f,bw);
    if(!t.lock){ dvbLog(n,sys+' '+(f/1e6)+' MHz: tuner PLL did not lock'); }
    await n.dv_demod.tune(sys,bw,t.ifHz,+n.p.plp);
    dvbLog(n,'tuned '+sys+' '+(f/1e6)+' MHz, '+(bw/1e6)+' MHz, IF '+(t.ifHz/1000)+' kHz');
  }catch(e){ dvbLog(n,'tune error: '+(e&&e.message||e)); }
  finally{ n.dv_tuning=false; }
}

/* ---- поток и состояние ---- */
function dvbStream(n){
  if(n.dv_run) return;
  n.dv_run=true; n.dv_rx=[]; n.dv_rxBytes=0; n.dv_rate=0; n.dv_rateAt=performance.now(); n.dv_rateB=0;
  const dev=n.dv_dev;
  const loop=async()=>{
    while(n.dv_run && n.dv_dev===dev){
      try{
        const r=await dev.transferIn(1,32768);
        if(r.status==='ok' && r.data.byteLength){ n.dv_rx.push(new Uint8Array(r.data.buffer.slice(r.data.byteOffset,r.data.byteOffset+r.data.byteLength))); n.dv_rxBytes+=r.data.byteLength; if(n.dv_rx.length>400) n.dv_rx.splice(0,n.dv_rx.length-200); }   // узел не опрашивают: не копить
        else if(r.status==='stall'){ await dev.clearHalt('in',1); }
      }catch(e){ if(n.dv_run){ dvbLog(n,'USB read: '+e.message); await dvbSleep(200); } }
    }
  };
  for(let i=0;i<3;i++) loop();
  const poll=async()=>{
    while(n.dv_run && n.dv_dev===dev){
      await dvbSleep(400);
      if(n.dv_tuning || !n.dv_connected) continue;
      try{
        const st=await n.dv_demod.status(n.dv_sys);
        n.dv_st=st;
        if(st.lock && !n.dv_locked){ n.dv_locked=true; dvbLog(n,'LOCK '+n.dv_sys+(st.cnr!=null ? ', C/N '+st.cnr.toFixed(1)+' dB' : '')); }
        if(!st.lock && n.dv_locked){ n.dv_locked=false; dvbLog(n,'lock lost'); }
        // auto: нет захвата за 3 с — другой стандарт
        if(!st.lock && performance.now()-n.dv_tuneAt>3000 && dvbSystems(n).length>1){ n.dv_sysIdx=(n.dv_sysIdx||0)+1; await dvbTune(n); }
        n.dv_dirty=true;
      }catch(e){ dvbLog(n,'status: '+e.message); }
    }
  };
  poll();
}

def({ id:'dvbUsb', title:'DVB USB (Astrometa)', cat:'Sources', kw:'dvb t2 dvb-t dvb-c astrometa rtl2832 r828d mn88473 mn88472 tv television usb stick receiver transport stream', readout:true, always:true, resize:true, w:340,
  ins:[{n:'freq',t:'num'}],
  outs:[{n:'bin',t:'bin'},{n:'lock',t:'num'},{n:'cnr',t:'num'},{n:'level',t:'num'}],
  params:[{n:'connect',t:'button',label:'Connect USB…',fn:n=>dvbConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>dvbDisconnect(n)},
          {n:'fw',t:'file',accept:'.fw,application/octet-stream',fn:async(n,f)=>{
              const b=new Uint8Array(await f.arrayBuffer());
              const nm= /88472/.test(f.name) ? 'dvb-demod-mn88472-02.fw' : 'dvb-demod-mn88473-01.fw';
              await dvbFwPut(nm,b); n.dv_logTxt.push('firmware '+nm+' saved ('+b.length+' bytes): connect again'); n.dv_dirty=true; }},
          {n:'freq',t:'num',d:474,label:'frequency, MHz (channel centre; UHF ch 21 = 474, step 8)'},
          {n:'bw',t:'select',opts:['8','7','6'],d:'8',label:'channel bandwidth, MHz'},
          {n:'sys',t:'select',opts:['auto','DVB-T2','DVB-T','DVB-C'],d:'auto',label:'standard (auto: T2, then T after 3 s without lock)'},
          {n:'plp',t:'num',d:0,label:'DVB-T2: PLP (stream) number'},
          {n:'tune',t:'button',label:'Tune',fn:n=>{ n.dv_sysIdx=0; dvbTune(n); }}],
  init(n){ n.dv_logTxt=[]; n.dv_t0=performance.now(); n.dv_status='not connected'; n.dv_rx=[]; n.dv_rxBytes=0; n.dv_run=false; n.dv_connected=false; n.dv_dirty=true; n.dv_pf=null; },
  dispose:n=>{ dvbDisconnect(n,true); },
  process(n,I){
    if(typeof I.freq==='number' && I.freq>0 && Math.abs(I.freq-n.dv_pf)>1e-6){ n.dv_pf=I.freq; setMod(n,'freq',I.freq); if(n.dv_connected){ n.dv_sysIdx=0; dvbTune(n); } }
    let bin=null;
    if(n.dv_rx && n.dv_rx.length){
      let len=0; for(const c of n.dv_rx) len+=c.length;
      const d=new Uint8Array(len); let o=0; for(const c of n.dv_rx){ d.set(c,o); o+=c.length; }
      n.dv_rx=[]; bin={d, name:'', mime:'video/mp2t', id:++DVB_SEQ};
    }
    const st=n.dv_st;
    return {bin, lock:n.dv_locked ? 1 : 0, cnr:st&&st.cnr!=null ? st.cnr : 0, level:st&&st.strength!=null ? st.strength/1023 : 0};
  },
  draw(n){
    const r=n.el.querySelector('.readout'); if(!r) return;
    const now=performance.now();
    if(now-n.dv_rateAt>1000){ n.dv_rate=(n.dv_rxBytes-n.dv_rateB)*8/((now-n.dv_rateAt)/1000); n.dv_rateB=n.dv_rxBytes; n.dv_rateAt=now; }
    let h= n.dv_connected ? (n.dv_locked ? '● LOCK ' : '○ searching ')+(n.dv_sys||'')+' '+(n.dv_freq?n.dv_freq/1e6:'')+' MHz'+(n.dv_st&&n.dv_st.cnr!=null ? ' · C/N '+n.dv_st.cnr.toFixed(1)+' dB' : '')+(n.dv_st&&n.dv_st.strength!=null ? ' · level '+Math.round(n.dv_st.strength/10.23)+' %' : '')+' · TS '+(n.dv_rate/1e6).toFixed(2)+' Mbit/s' : n.dv_status;
    const t=h+'\n'+n.dv_logTxt.slice(-8).join('\n');
    if(r.textContent!==t) r.textContent=t; }
});
