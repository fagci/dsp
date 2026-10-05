"use strict";
/* ============================ WebHID ============================
   Любое USB / Bluetooth HID-устройство без драйвера: педали, пульты, USB-весы и датчики, сканеры, свои платы на 32U4 / RP2040.
   Входные отчёты — текстом (hex) и числом из выбранного поля, выходные и feature-отчёты пишет вход send.
   Chrome / Edge / Opera на https или localhost. Клавиатуры и мыши браузер закрывает от WebHID. */

const HID_FMT=['uint8','int8','uint16 LE','int16 LE','uint16 BE','int16 BE','uint32 LE','bit'];
const hidHex=dv=>Array.from(new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength),b=>b.toString(16).padStart(2,'0')).join(' ');
const hidNum=s=>{ const t=String(s||'').trim().replace(/^0x/i,''); return /^[0-9a-f]+$/i.test(t) ? parseInt(t,16) : null; };       // все идентификаторы — в hex
function hidParseBytes(s){
  const t=String(s||'').replace(/0x/ig,' ').replace(/[^0-9a-f]/ig,' ').trim(); if(!t) return null;
  const parts=t.split(/\s+/), flat=parts.length===1 && parts[0].length>2 ? parts[0].match(/.{1,2}/g) : parts;
  return flat.some(p=>p.length>2) ? null : Uint8Array.from(flat.map(p=>parseInt(p,16)));
}
function hidField(dv,fmt,off,bit){
  const o=off|0, size={'uint8':1,'int8':1,'uint16 LE':2,'int16 LE':2,'uint16 BE':2,'int16 BE':2,'uint32 LE':4,'bit':1}[fmt]||1;
  if(o<0 || o+size>dv.byteLength) return null;
  switch(fmt){
    case 'int8': return dv.getInt8(o);
    case 'uint16 LE': return dv.getUint16(o,true);
    case 'int16 LE': return dv.getInt16(o,true);
    case 'uint16 BE': return dv.getUint16(o,false);
    case 'int16 BE': return dv.getInt16(o,false);
    case 'uint32 LE': return dv.getUint32(o,true);
    case 'bit': return (dv.getUint8(o)>>(bit&7))&1;
    default: return dv.getUint8(o);
  }
}
async function hidClose(n){
  n.connected=false; n.connecting=false;
  const d=n.dev; n.dev=null;
  if(d){ d.removeEventListener('inputreport',n.onRep); try{ if(d.opened) await d.close(); }catch(e){} }
}
async function hidConnect(n){
  if(n.connecting) return;
  await hidClose(n);
  if(!navigator.hid){ n.status='WebHID unavailable (needs Chrome/Edge/Opera on https or localhost)'; return; }
  n.connecting=true; n.status='choose a device…';
  try{
    const f={}, v=hidNum(n.p.vid), p=hidNum(n.p.pid), up=hidNum(n.p.page), us=hidNum(n.p.usage);
    if(v!==null) f.vendorId=v; if(p!==null) f.productId=p; if(up!==null) f.usagePage=up; if(us!==null) f.usage=us;
    const filters=Object.keys(f).length ? [f] : [];
    const have=(await navigator.hid.getDevices()).filter(d=>(v===null||d.vendorId===v)&&(p===null||d.productId===p));
    const d=have.length===1 && filters.length ? have[0] : (await navigator.hid.requestDevice({filters}))[0];
    if(!d) throw Object.assign(new Error('none'),{name:'NotFoundError'});
    if(!d.opened) await d.open();
    n.dev=d; d.addEventListener('inputreport',n.onRep);
    n.info=(d.productName||'HID device')+' ('+d.vendorId.toString(16).padStart(4,'0')+':'+d.productId.toString(16).padStart(4,'0')+')'+
      (d.collections&&d.collections.length ? ' · usage page 0x'+d.collections[0].usagePage.toString(16)+' usage 0x'+d.collections[0].usage.toString(16)+
       ', input reports '+d.collections.reduce((a,c)=>a+(c.inputReports?c.inputReports.length:0),0) : '');
    n.connecting=false; n.connected=true; n.status='connected: '+n.info;
  }catch(e){ n.connecting=false; n.connected=false; n.status=e.name==='NotFoundError' ? 'no device selected' : 'error: '+e.message; }
}
def({ id:'hid', title:'HID Device (WebHID)', cat:'Sources', kw:'usb hid report pedal remote scale sensor scanner custom board feature output',
  ins:[{n:'send',t:'txt'}], outs:[{n:'report',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true, tall:true,
  params:[{n:'vid',t:'text',d:'',label:'vendor id, hex (empty — any)'},
          {n:'pid',t:'text',d:'',label:'product id, hex (empty — any)'},
          {n:'page',t:'text',d:'',label:'usage page, hex (empty — any)',adv:true},
          {n:'usage',t:'text',d:'',label:'usage, hex (empty — any)',adv:true},
          {n:'rid',t:'num',d:-1,label:'value: report id (−1 — any)'},
          {n:'fmt',t:'select',opts:HID_FMT,d:'uint8',label:'value: format'},
          {n:'off',t:'num',d:0,label:'value: byte offset in the data (after the report id)'},
          {n:'bit',t:'range',min:0,max:7,step:1,d:0,label:'value: bit (format «bit»)'},
          {n:'k',t:'num',d:1,label:'value: scale'},
          {n:'sid',t:'num',d:0,label:'send: report id (0 — none)'},
          {n:'kind',t:'select',opts:['output report','feature report'],d:'output report',label:'send: kind'},
          {n:'connect',t:'button',label:'Connect',fn:n=>hidConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; hidClose(n); }}],
  init:n=>{ n.dev=null; n.connected=n.connecting=false; n.q=[]; n.val=0; n.last=''; n.got=0; n.sent=0; n.info=''; n.status='not connected';
            n.lastSend=undefined; n.chain=Promise.resolve();
            n.onRep=e=>{ const hex=hidHex(e.data); n.got++; n.q.push({id:e.reportId,hex,dv:new DataView(e.data.buffer.slice(e.data.byteOffset,e.data.byteOffset+e.data.byteLength))}); if(n.q.length>2000) n.q.shift(); };
            n.onDisc=e=>{ if(n.dev && e.device===n.dev){ n.connected=false; n.status='device disconnected'; } };
            if(navigator.hid) navigator.hid.addEventListener('disconnect',n.onDisc); },
  dispose:n=>{ if(navigator.hid) navigator.hid.removeEventListener('disconnect',n.onDisc); hidClose(n); },
  process(n,I){
    if(typeof I.send==='string' && I.send && I.send!==n.lastSend){
      n.lastSend=I.send; const b=hidParseBytes(I.send), d=n.dev;
      if(!b) n.status='bad hex in send';
      else if(n.connected && d){
        const id=(+n.p.sid)|0, feat=n.p.kind==='feature report';
        n.chain=n.chain.then(()=>feat ? d.sendFeatureReport(id,b) : d.sendReport(id,b)).then(()=>{ n.sent++; },e=>{ n.status='send error: '+e.message; });
      }
    } else if(!I.send) n.lastSend=undefined;
    let rep=null, nw=0, rec=null;
    if(n.q.length){
      rec=[]; const t=Date.now(), want=+n.p.rid;
      for(const r of n.q.splice(0)){
        n.last='['+r.id+'] '+r.hex; rep=n.last; nw=1;
        const v=want<0 || want===r.id ? hidField(r.dv,n.p.fmt,+n.p.off,+n.p.bit) : null;
        if(v!==null) n.val=v*(+n.p.k||0);
        rec.push({t,reportId:r.id,hex:r.hex,...(v!==null ? {value:v*(+n.p.k||0)} : {})});
      }
    }
    return {report:rep,value:n.val,rec,new:nw};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.got||n.sent ? ' · reports '+n.got+(n.sent ? ' · sent '+n.sent : '') : '')+(n.last ? '\n'+n.last.slice(0,200)+'\nvalue '+(Math.round(n.val*1e4)/1e4) : '');
    if(r.textContent!==t) r.textContent=t; }
});
