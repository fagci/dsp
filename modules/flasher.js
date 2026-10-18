"use strict";
/* ============================ Прошивальщики по serial: общая основа ============================
   Узел-прошивальщик = прошивка (файл или провод bin) + порт WebSerial + драйвер протокола. Драйвер — асинхронная
   функция из *-kernels.js: run(io, fw, params, report), где io — {write, read, flush, sleep, now}.
   Так протокол проверяется в node без железа (поддельный io), а здесь только порт, буфер приёма и узел.
   defFlasher({id,title,kw,baud,params,prepare,run}):
     prepare(bytes, p, name) → данные для драйвера (бросает ошибку при плохом файле), run(io, fw, p, report) → Promise.
   Порт выбирается кнопкой Port (нужен жест пользователя) и запоминается; Flash открывает его сам, поэтому
   вход go (передний фронт) тоже запускает прошивку. Abort прерывает на ближайшем шаге. */

// буфер приёма: take(ms) отдаёт всё накопленное или ждёт первые байты не дольше ms
class FlRx{
  constructor(){ this.buf=new Uint8Array(0); this.w=null; this.closed=false; }
  push(u){
    const b=new Uint8Array(this.buf.length+u.length); b.set(this.buf); b.set(u,this.buf.length); this.buf=b;
    this._wake();
  }
  _wake(){ const w=this.w; if(!w) return; this.w=null; clearTimeout(w.timer); w.resolve(this._grab()); }
  _grab(){ if(!this.buf.length) return null; const b=this.buf; this.buf=new Uint8Array(0); return b; }
  take(ms){
    const g=this._grab(); if(g || ms<=0 || this.closed) return Promise.resolve(g);
    return new Promise(resolve=>{ this.w={resolve,timer:setTimeout(()=>{ this.w=null; resolve(null); },ms)}; });
  }
  clear(){ this.buf=new Uint8Array(0); }
  close(){ this.closed=true; this._wake(); }
}

const flSleep=ms=>new Promise(r=>setTimeout(r,ms));

async function flReadLoop(n,reader){
  try{
    for(;;){ const {value,done}=await reader.read(); if(done) break; if(value) n.rx.push(value); }
  }catch(e){ n.rxErr=e; }
  n.rx.close();
}

function flIo(n){
  const chk=()=>{ if(n.abort) throw new Error('aborted'); };
  return {
    write:async u=>{ chk(); await n.writer.write(u); },
    read:async ms=>{
      chk(); const u=await n.rx.take(ms); chk();
      if(!u && n.rx.closed) throw new Error(n.rxErr ? 'port error: '+n.rxErr.message : 'port closed by the device');
      return u; },
    flush:()=>n.rx.clear(),
    sleep:async ms=>{ chk(); await flSleep(ms); chk(); },
    now:()=>performance.now(),
  };
}

async function flClose(n){
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} try{ n.reader.releaseLock(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}

async function flPick(n){
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return false; }
  try{ n.pick=await navigator.serial.requestPort(); n.status='port chosen'; return true; }
  catch(e){ n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message; return false; }
}

async function flStart(n,o){
  if(n.busy) return;
  n.busy=true; n.abort=false; n.progress=0; n.err='';
  try{
    if(!navigator.serial) throw new Error('WebSerial unavailable (needs Chrome/Edge, HTTPS)');
    if(!n.fw) throw new Error('no firmware: choose a file or wire bin');
    const fw=o.prepare(n.fw,n.p,n.fname);
    if(!n.pick){ n.status='choose a port…'; if(!(await flPick(n))) { n.busy=false; return; } }
    n.status='opening…';
    const port=n.pick;
    try{ await port.open({baudRate:+n.p.baud||+o.baud,bufferSize:65536}); }
    catch(e){ n.pick=null; throw e; }
    n.port=port; n.rx=new FlRx(); n.rxErr=null;
    n.writer=port.writable.getWriter(); n.reader=port.readable.getReader();
    flReadLoop(n,n.reader);
    const report=(f,s)=>{ n.progress=Math.max(0,Math.min(1,f)); n.status=s; };
    await o.run(flIo(n),fw,n.p,report);
    n.progress=1; n.okPulse=2; n.status='done';
  }catch(e){
    n.err=String(e.message||e); n.status=n.abort ? 'aborted' : 'failed';
  }finally{
    await flClose(n);
    n.busy=false;
  }
}

function defFlasher(o){
  def({ id:o.id, title:o.title, cat:'Output', kw:'flasher firmware flash upload bootloader serial webserial radio '+(o.kw||''),
    ins:[{n:'bin',t:'bin'},{n:'go',t:'num'}],
    outs:[{n:'progress',t:'num'},{n:'busy',t:'num'},{n:'ok',t:'num'},{n:'status',t:'txt'}],
    readout:true, tall:true,
    params:[
      {n:'file',t:'file',accept:o.accept||'.bin,.hex,.fw,application/octet-stream',fn:(n,f)=>{
        f.arrayBuffer().then(a=>{ n.fw=new Uint8Array(a); n.fname=f.name; n.status=f.name+' · '+f.size+' B'; }); }},
      {n:'pick',t:'button',label:'Port…',fn:n=>{ if(!n.busy) flPick(n); }},
      {n:'flash',t:'button',label:'Flash',fn:n=>flStart(n,o)},
      {n:'abort',t:'button',label:'Abort',fn:n=>{ n.abort=true; n.rx?.close(); }},
      {n:'baud',t:'select',opts:['9600','19200','38400','57600','115200','230400'],d:String(o.baud),label:'baud',adv:true},
      ...(o.params||[]),
    ],
    init:n=>{
      n.fw=null; n.fname=''; n.pick=null; n.port=null; n.reader=null; n.writer=null; n.rx=new FlRx(); n.rxErr=null;
      n.busy=false; n.abort=false; n.progress=0; n.okPulse=0; n.err=''; n.status='choose a firmware file';
      n.lastBin=null; n.prevGo=0;
    },
    dispose:n=>{ n.abort=true; n.rx.close(); },
    process(n,I){
      if(I.bin && I.bin.d && I.bin!==n.lastBin){ n.lastBin=I.bin; n.fw=I.bin.d; n.fname=I.bin.name||'firmware'; if(!n.busy) n.status=n.fname+' · '+n.fw.length+' B'; }
      const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
      if(rise) flStart(n,o);
      const ok=n.okPulse>0 ? 1 : 0; if(n.okPulse>0) n.okPulse--;
      return {progress:n.progress, busy:n.busy ? 1 : 0, ok, status:n.err ? 'error: '+n.err : n.status};
    },
    draw(n){
      const r=n.el.querySelector('.readout'); if(!r) return;
      const t=(n.err ? '⚠ '+n.err+'\n' : '')+n.status+(n.busy || n.progress ? ' · '+Math.round(n.progress*100)+'%' : '');
      if(r.textContent!==t) r.textContent=t;
    }
  });
}
