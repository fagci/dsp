"use strict";
/* ============================ M-Bus ============================
   Decoder: телеграмма hex (проводная шина или радио 868 МГц, как её дают rtl_wmbus / приёмники) → записи счётчика.
   Master: опрос счётчиков по проводной M-Bus через преобразователь уровней с USB-serial (2400 8E1): REQ_UD2 каждому адресу. Ядро — mbus-kernels.js. */

function mbRecs(d,t){
  const base={t,id:d.id,manuf:d.manuf,medium:d.mediumName};
  if(d.a!==undefined) base.addr=d.a;
  return (d.records||[]).filter(r=>!r.raw).map(r=>({...base,n:r.n,desc:r.desc,value:r.value,unit:r.unit,storage:r.storage,tariff:r.tariff,func:r.func}));
}
def({ id:'mbusDec', title:'M-Bus Decoder', cat:'Decoders', kw:'mbus m-bus wmbus wireless meter water heat gas electricity energy en13757 868 rtl_wmbus telegram',
  ins:[{n:'text',t:'txt'}],
  outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'value',t:'num'},{n:'id',t:'txt'},{n:'new',t:'num'},{n:'err',t:'txt'}], readout:true, tall:true,
  params:[{n:'pick',t:'text',d:'0',label:'record for the value output: number, or a part of the name (Energy, Volume, Power…)'}],
  init:n=>{ n.lastIn=undefined; n.val=0; n.count=0; n.bad=0; n.last=''; n.status='waiting for a telegram (hex)'; },
  process(n,I){
    let text=null, rec=null, nw=0, err=null, id=null;
    if(typeof I.text==='string' && I.text!==n.lastIn){
      n.lastIn=I.text;
      for(const line of I.text.split(/\n/)){
        if(!line.trim()) continue;
        const b=mbusHex(line.replace(/^.*;\s*(?=(0x)?[0-9A-Fa-f]{10,})/,''));      // «T1;1;1;…;0x2E44…;» от rtl_wmbus: берём поле с hex
        if(!b){ n.bad++; err='not hex'; continue; }
        const d=mbusDecode(b);
        if(!d.records || (!d.records.length && d.error)){ n.bad++; err=d.error||'no records'; n.status=err; if(!d.records) continue; }
        n.count++; nw=1; text=mbusSummary(d); n.last=text; n.status='telegrams '+n.count;
        rec=(rec||[]).concat(mbRecs(d,Date.now()));
        if(d.id!==undefined && d.id!==null) id=String(d.id);
        const vals=(d.records||[]).filter(r=>typeof r.value==='number');
        const pk=String(n.p.pick||'0').trim();
        const r=/^\d+$/.test(pk) ? (d.records||[])[+pk] : vals.find(r=>r.desc.toLowerCase().includes(pk.toLowerCase()));
        if(r && typeof r.value==='number') n.val=r.value;
        if(d.error) err=d.error;
      }
    }
    return {text,rec,value:n.val,id,new:nw,err};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.bad ? ' · bad '+n.bad : '')+(n.last ? '\n'+n.last.slice(0,400) : '');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---------- M-Bus Master ---------- */
async function mmTeardown(n){
  n.want=false; n.ok=false; clearInterval(n.pollT); clearTimeout(n.waitT); n.pollT=n.waitT=null; n.waiting=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
async function mmStop(n){ await mmTeardown(n); n.status='disconnected'; }
async function mmStart(n){
  if(n.connecting) return;
  await mmTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  const addrs=String(n.p.addresses||'').split(/[\s,]+/).filter(Boolean).map(Number).filter(a=>Number.isInteger(a) && a>=0 && a<=250);
  if(!addrs.length){ n.status='enter primary addresses (0…250)'; return; }
  n.addrs=addrs; n.k=-1; n.mp=new MbusParser(); n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||2400,parity:n.p.parity,dataBits:8,stopBits:1});
    n.port=port; n.writer=port.writable.getWriter(); n.ok=true; n.want=true; n.status='connected, '+n.p.baud+' baud '+n.p.parity;
    mmRead(n); n.pollT=setInterval(()=>mmPoll(n),Math.max(.5,n.p.period)*1000); mmPoll(n);
  }catch(e){ n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; }
  n.connecting=false;
}
async function mmRead(n){
  const reader=n.port.readable.getReader(); n.reader=reader;
  try{ for(;;){ const {value,done}=await reader.read(); if(done) break; for(const f of n.mp.push(value)) mmFrame(n,f); } }
  catch(e){ n.status='read error: '+e.message; }
  n.ok=false; if(n.reader===reader) n.reader=null;
}
function mmPoll(n){
  if(!n.ok || n.waiting) return;
  n.k=(n.k+1)%n.addrs.length; const a=n.addrs[n.k]; n.cur=a; n.waiting=true;
  n.chain=n.chain.then(()=>n.writer?.write(mbusShort(MBUS_REQ_UD2,a))).catch(e=>{ n.status='write error: '+e.message; });
  clearTimeout(n.waitT);
  n.waitT=setTimeout(()=>{ if(n.waiting){ n.waiting=false; n.errs++; n.status='no answer from address '+a; } },Math.max(300,+n.p.timeout*1000||2000));
}
function mmFrame(n,f){
  if(f.type!=='long' || !n.waiting) return;
  clearTimeout(n.waitT); n.waiting=false; n.frames++;
  n.q.push(mbusToHex(f.bytes)); if(n.q.length>200) n.q.splice(0,n.q.length-200);
  n.status='answer from address '+f.bytes[5];
}
def({ id:'mbusMaster', title:'M-Bus Master', cat:'Protocols', kw:'mbus m-bus wired master meter heat water gas reader req_ud2 serial level converter',
  outs:[{n:'text',t:'txt'},{n:'new',t:'num'},{n:'ok',t:'num'},{n:'errors',t:'num'}], readout:true, tall:true,
  params:[{n:'baud',t:'select',opts:['300','600','1200','2400','4800','9600'],d:'2400'},
          {n:'parity',t:'select',opts:['even','none','odd'],d:'even'},
          {n:'addresses',t:'text',d:'1',label:'primary addresses to ask (space / comma; 0…250)'},
          {n:'period',t:'range',min:.5,max:3600,step:.5,d:10,label:'one address every, s'},
          {n:'timeout',t:'range',min:.3,max:10,step:.1,d:2,label:'answer timeout, s'},
          {n:'connect',t:'button',label:'Connect',fn:n=>mmStart(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>mmStop(n)}],
  init:n=>{ n.port=n.reader=n.writer=null; n.want=false; n.ok=false; n.connecting=false; n.pollT=n.waitT=null; n.waiting=false; n.chain=Promise.resolve();
            n.mp=new MbusParser(); n.addrs=[]; n.k=-1; n.cur=0; n.q=[]; n.frames=0; n.errs=0; n.status='not connected'; },
  dispose:n=>mmTeardown(n),
  process(n){
    const t=n.q.length ? n.q.shift() : null;
    return {text:t,new:t!==null ? 1 : 0,ok:n.ok ? 1 : 0,errors:n.errs};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · answers '+n.frames+(n.errs ? ' · no answer '+n.errs : '');
    if(r.textContent!==t) r.textContent=t; }
});
