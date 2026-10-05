"use strict";
/* ============================ ИК: узлы ============================
   Ядра и форматы — в ir-kernels.js. Кадр по проводу — строка «F:38000 9000 4500 …» (мкс), событие: непустая только в блоке,
   где кадр пришёл. Кодеки (Encode / Decode / Learn) не знают про железо; железо — адаптеры: звуковая карта (Sound TX / RX)
   и последовательный порт (Arduino / ESP / Flipper Zero). */

// свежее событие: строка пришла (непустая и отличается от предыдущего блока) — одинаковые кадры подряд разделены пустым блоком
function irEvent(n,k,v){
  const s=typeof v==='string' ? v.trim() : '', st=n.ev||(n.ev={}), fresh=s && st[k]!==s;
  st[k]=s; return fresh ? s : null;
}
const irSetP=(n,k,v)=>{ if(n.set && n.set[k]) n.set[k](v); else n.p[k]=v; };
const irH=v=>'0x'+(v|0).toString(16).toUpperCase().padStart(2,'0');
const irReadout=(n,s)=>{ const r=n.el.querySelector('.readout'); if(r && r.textContent!==s) r.textContent=s; };
const irSum=(dur,freq)=>dur.length+' pulses · '+Math.round(dur.reduce((a,b)=>a+b,0)/1000)+' ms · '+Math.round(freq/100)/10+' kHz';

/* ---------- Encode ---------- */
def({ id:'irEnc', title:'IR Encode', cat:'IR', kw:'infrared remote control nec rc5 rc6 sony samsung jvc panasonic command send',
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'}], outs:[{n:'raw',t:'txt'},{n:'text',t:'txt'},{n:'new',t:'num'}], readout:true,
  params:[{n:'proto',t:'select',opts:IR_PROTOS,d:'NEC',label:'protocol'},
          {n:'addr',t:'num',d:4,label:'address'},
          {n:'cmd',t:'num',d:8,label:'command'},
          {n:'tgl',t:'check',d:true,label:'flip the toggle bit on every send (RC5 / RC6)'},
          {n:'fmt',t:'select',opts:IR_FORMATS,d:'wire',label:'output format'},
          {n:'send',t:'button',label:'Send',fn:n=>{ n.fire=1; }},
          {n:'rep',t:'button',label:'NEC repeat frame',fn:n=>{ n.fire=2; }}],
  init:n=>{ n.fire=0; n.tg=0; n.last=''; n.prevGo=0; },
  process(n,I){
    let fire=n.fire; n.fire=0;
    const go=(I.go||0)>.5; if(go && !n.prevGo) fire=fire||1; n.prevGo=go;
    const spec=irEvent(n,'text',I.text);
    let e=null, label='';
    if(spec){ e=irEncodeText(spec); label=spec; if(!e) n.last='cannot parse «'+spec+'»'; }
    else if(fire){
      const tg=n.p.tgl ? n.tg ^= 1 : 0;
      e=irEncode(n.p.proto,+n.p.addr,+n.p.cmd,{repeat:fire===2,toggle:tg});
      label=n.p.proto+' addr '+irH(n.p.addr)+' cmd '+irH(n.p.cmd)+(fire===2 ? ' repeat' : '');
    }
    if(!e || !e.dur) return {raw:null,text:null,new:0};
    n.last=label+'\n'+irSum(e.dur,e.freq);
    return {raw:irFormat(n.p.fmt,e.dur,e.freq), text:label, new:1};
  },
  draw(n){ irReadout(n,n.last||'Send, or give a command as text: NEC 0x04 0x08'); }
});

/* ---------- Decode ---------- */
def({ id:'irDec', title:'IR Decode', cat:'IR', kw:'infrared remote control nec rc5 rc6 sony samsung jvc panasonic decode unknown',
  ins:[{n:'raw',t:'txt'}], outs:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'addr',t:'num'},{n:'cmd',t:'num'},{n:'new',t:'num'},{n:'info',t:'txt'}],
  readout:true, tall:true,
  params:[{n:'clr',t:'button',label:'Clear',fn:n=>{ n.log=[]; n.cnt=0; }}],
  init:n=>{ n.log=[]; n.cnt=0; n.addr=0; n.cmd=0; n.lastRec=null; },
  process(n,I){
    const raw=irEvent(n,'raw',I.raw);
    if(!raw) return {text:null,rec:null,addr:n.addr,cmd:n.cmd,new:0,info:null};
    const p=irParse(raw); if(!p) return {text:null,rec:null,addr:n.addr,cmd:n.cmd,new:0,info:null};
    let r=irDecode(p.dur), text, info=null;
    if(r && r.repeat && n.lastRec){ r={...n.lastRec,repeat:true}; text=irDescribe(r)+' (repeat)'; }
    else if(r && r.repeat){ text='NEC repeat'; }
    else if(r){ text=irDescribe(r); n.lastRec=r; n.addr=r.addr; n.cmd=r.cmd; }
    else { text='unknown · '+irSum(p.dur,p.freq); info=irAnalyzeText(p.dur); }
    n.cnt++; n.log.push(n.cnt+'  '+text+(info ? '\n'+info.split('\n').map(l=>'    '+l).join('\n') : ''));
    if(n.log.length>12) n.log.shift();
    const rec=r ? {t:Date.now(),proto:r.proto,addr:r.addr,cmd:r.cmd,bits:r.bits,hex:r.hex,repeat:!!r.repeat,toggle:r.toggle,pulses:p.dur.length,text}
                : {t:Date.now(),proto:'unknown',pulses:p.dur.length,text};
    return {text, rec:[rec], addr:n.addr, cmd:n.cmd, new:1, info};
  },
  draw(n){ irReadout(n,n.log.length ? n.log.join('\n') : 'waiting for a frame'); }
});

/* ---------- Learn / Replay ---------- */
def({ id:'irLearn', title:'IR Learn', cat:'IR', kw:'infrared remote record replay air conditioner learn capture',
  ins:[{n:'raw',t:'txt'},{n:'go',t:'num'}], outs:[{n:'raw',t:'txt'},{n:'text',t:'txt'},{n:'new',t:'num'}], readout:true, tall:true,
  params:[{n:'code',t:'text',d:'',label:'stored code (saved with the patch; paste any format)'},
          {n:'auto',t:'check',d:true,label:'capture the first frame by itself while empty'},
          {n:'times',t:'range',min:1,max:10,step:1,d:1,label:'send count per replay'},
          {n:'gap',t:'range',min:10,max:500,step:5,d:45,label:'gap between repeats, ms'},
          {n:'fmt',t:'select',opts:IR_FORMATS,d:'wire',label:'output format'},
          {n:'cap',t:'button',label:'Capture next',fn:n=>{ n.armed=true; }},
          {n:'play',t:'button',label:'Replay',fn:n=>{ n.fire=1; }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ irSetP(n,'code',''); n.armed=false; n.ui=null; }}],
  init:n=>{ n.armed=false; n.fire=0; n.left=0; n.wait=0; n.prevGo=0; n.ui=null; n.ck=''; },
  process(n,I){
    const raw=irEvent(n,'raw',I.raw), has=!!irParse(n.p.code);
    if(raw && (n.armed || (n.p.auto && !has))){
      const p=irParse(raw);
      if(p){ irSetP(n,'code',irFormat('wire',p.dur,p.freq)); n.armed=false; }
    }
    if(n.p.code!==n.ck){ n.ck=n.p.code; const p=irParse(n.p.code);
      n.ui=p ? irSum(p.dur,p.freq)+'\n'+(irDescribe(irDecode(p.dur))||'unknown frame')+'\n'+irAnalyzeText(p.dur) : null; }
    const go=(I.go||0)>.5; if(go && !n.prevGo) n.fire=1; n.prevGo=go;
    if(n.fire){ n.fire=0; if(has){ n.left=+n.p.times||1; n.wait=0; } }
    let out=null;
    if(n.left>0 && (n.wait-=BLOCK/Eng.sr*1000)<=0){
      const p=irParse(n.p.code);
      if(p){ out=irFormat(n.p.fmt,p.dur,p.freq); n.left--; n.wait=p.dur.reduce((a,b)=>a+b,0)/1000+(+n.p.gap||45); } else n.left=0;
    }
    return {raw:out, text:out ? 'replay' : null, new:out ? 1 : 0};
  },
  draw(n){ irReadout(n,(n.armed ? 'waiting for a frame…\n' : '')+(n.ui||'empty — press a key on the remote'+(n.p.auto ? ' (auto capture is on)' : ' and press Capture next'))); }
});

/* ---------- Merge ---------- */
// Несколько источников кадров (Encode, Learn, …) в один адаптер: у входа адаптера только один провод.
def({ id:'irMix', title:'IR Merge', cat:'IR', kw:'infrared remote combine sources frames',
  ins:[{n:'a',t:'txt'},{n:'b',t:'txt'},{n:'c',t:'txt'},{n:'d',t:'txt'}], outs:[{n:'raw',t:'txt'},{n:'new',t:'num'}],
  init:n=>{ n.q=[]; },
  process(n,I){
    for(const k of 'abcd'){ const e=irEvent(n,k,I[k]); if(e) n.q.push(e); }
    const out=n.q.shift()||null;
    return {raw:out,new:out?1:0};
  }
});

/* ---------- Sound card: передатчик ---------- */
// Несущая синусом прямо в звуковую карту: нужна частота 96 кВ и выше (дискретизация ≥ 2,5 × несущая),
// ИК-светодиод — через транзистор. «envelope» — только огибающая, для внешнего модулятора (несущая 36–40 кГц на 555 / МК).
def({ id:'irSoundTx', title:'IR Sound TX', cat:'IR', kw:'infrared remote sound card led carrier modulate transmit',
  ins:[{n:'raw',t:'txt'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}], readout:true,
  params:[{n:'mode',t:'select',opts:['modulated','envelope'],d:'modulated',label:'output (modulated needs 96 kHz or more)'},
          {n:'freq',t:'num',d:0,label:'carrier, Hz (0 — from the code)'},
          {n:'level',t:'range',min:0,max:1,step:.01,d:.9,label:'level'}],
  init:n=>{ n.q=[]; n.cur=null; n.i=0; n.left=0; n.ph=0; n.frames=0; },
  process(n,I){
    const raw=irEvent(n,'raw',I.raw);
    if(raw){ const p=irParse(raw); if(p){ n.q.push(p); if(n.q.length>20) n.q.shift(); } }
    const o=buf(n,'out'), sr=Eng.sr, lv=+n.p.level, env=n.p.mode==='envelope';
    for(let k=0;k<BLOCK;k++){
      if(!n.cur && n.q.length){ n.cur=n.q.shift(); n.i=0; n.left=n.cur.dur[0]*sr/1e6; n.ph=0; n.frames++; }
      if(!n.cur){ o[k]=0; continue; }
      const f=+n.p.freq>0 ? +n.p.freq : n.cur.freq, mark=!(n.i&1);
      o[k]=mark ? lv*(env ? 1 : Math.sin(n.ph)) : 0;
      n.ph+=2*Math.PI*f/sr; if(n.ph>6.2831853) n.ph-=6.2831853;
      if(--n.left<=0){
        if(++n.i>=n.cur.dur.length){ n.cur=null; }
        else n.left+=n.cur.dur[n.i]*sr/1e6;
      }
    }
    n.lowSr=!env && Eng.sr<2.4*(+n.p.freq>0 ? +n.p.freq : (n.cur ? n.cur.freq : 38000));
    return {out:o, busy:n.cur||n.q.length ? 1 : 0};
  },
  draw(n){ irReadout(n,(n.lowSr ? 'sample rate '+Math.round(Eng.sr/1000)+' kHz is too low for the carrier — set 96 kHz or more, or use envelope\n' : '')+
    'frames sent '+n.frames+(n.cur||n.q.length ? ' · sending' : '')); }
});

/* ---------- Sound card: приёмник ---------- */
// carrier — сырой сигнал с фотодиода (смешиваем с несущей и фильтруем), baseband — выход демодулятора TSOP / огибающая.
function irClean(segs,glitch){                       // [[уровень, длина в отсчётах]]; короче glitch — слить с соседями
  for(let i=1;i<segs.length-1;){
    if(segs[i][1]<glitch){ segs[i-1][1]+=segs[i][1]+segs[i+1][1]; segs.splice(i,2); if(i>1) i--; } else i++;
  }
  return segs;
}
def({ id:'irSoundRx', title:'IR Sound RX', cat:'IR', kw:'infrared remote sound card photodiode tsop receive demodulate',
  ins:[{n:'in',t:'sig'}], outs:[{n:'raw',t:'txt'},{n:'new',t:'num'},{n:'level',t:'num'}], readout:true,
  params:[{n:'mode',t:'select',opts:['carrier','baseband'],d:'baseband',label:'input: carrier (photodiode + amplifier, 96 kHz or more) or baseband (TSOP output)'},
          {n:'freq',t:'num',d:38000,label:'carrier, Hz'},
          {n:'gap',t:'range',min:3,max:100,step:1,d:20,label:'frame ends after a pause, ms'},
          {n:'glitch',t:'range',min:10,max:400,step:5,d:80,label:'ignore pulses shorter than, µs'},
          {n:'floor',t:'range',min:.001,max:.5,step:.001,d:.02,log:true,label:'minimum level'}],
  init:n=>{ n.ph=0; n.mr=0; n.mi=0; n.m2r=0; n.m2i=0; n.env=0; n.pk=0; n.dc=0; n.on=0; n.segs=[]; n.run=0; n.t=0; n.evq=[]; n.cnt=0; n.last=''; n.lv=0; },
  process(n,I){
    const x=I.in, sr=Eng.sr, car=n.p.mode==='carrier', fc=+n.p.freq||38000;
    const aLp=1-Math.exp(-2*Math.PI*(car ? 3000 : 20000)/sr), aDc=1-Math.exp(-1/(.3*sr)), dec=Math.exp(-1/(.5*sr));
    const glitch=+n.p.glitch*sr/1e6, gapS=+n.p.gap*sr/1e3, floor=+n.p.floor;
    for(let k=0;k<BLOCK;k++){
      const v=x ? x[k] : 0;
      let e;
      if(car){
        n.ph+=2*Math.PI*fc/sr; if(n.ph>6.2831853) n.ph-=6.2831853;
        n.mr+=(v*Math.cos(n.ph)-n.mr)*aLp; n.mi+=(v*Math.sin(n.ph)-n.mi)*aLp;
        n.m2r+=(n.mr-n.m2r)*aLp; n.m2i+=(n.mi-n.m2i)*aLp;          // два каскада — 2·fc после смесителя гасится
        e=2*Math.hypot(n.m2r,n.m2i);
      } else { n.dc+=(v-n.dc)*aDc; n.mr+=(Math.abs(v-n.dc)-n.mr)*aLp; e=n.mr; }
      n.env=e; n.pk=Math.max(e,n.pk*dec);
      const hi=Math.max(floor,n.pk*.5), lo=Math.max(floor*.6,n.pk*.3);
      const on=n.on ? e>lo : e>hi;
      n.run++;
      if(on!==!!n.on){
        if(n.segs.length || n.on) n.segs.push([n.on,n.run]);
        n.on=on?1:0; n.run=0;
      } else if(!on && n.segs.length && n.run>gapS){                       // кадр закончился
        const s=irClean(n.segs.slice(),glitch); n.segs=[]; n.run=0;
        const dur=s.map(g=>Math.round(g[1]*1e6/sr));
        if(dur.length>=3){ n.evq.push(irFormat('wire',dur,fc)); n.cnt++; n.last=dur.length+' pulses'; }
      }
    }
    n.lv=n.pk>0 ? Math.min(1,n.env/n.pk) : 0;
    const out=n.evq.shift()||null;
    return {raw:out,new:out?1:0,level:Math.min(1,n.pk)};
  },
  draw(n){ irReadout(n,'level '+Math.round(Math.min(1,n.pk)*100)+'%'+(n.env>Math.max(+n.p.floor,n.pk*.5) ? ' · mark' : '')+'\nframes '+n.cnt+(n.last ? ' · last '+n.last : '')); }
});

/* ---------- Последовательный порт (Arduino / ESP / Flipper Zero) ---------- */
// wire: строки «F:38000 µs…» в обе стороны. sketch — tools/ir/ir-serial.ino: «TX 38000 µs…» в устройство, «RX µs…» из него.
// flipper: «ir tx RAW F:38000 DC:33 µs…» в консоль; для приёма при подключении отправляется «ir rx raw».
const IR_SER_DEV=['wire','sketch (tools/ir)','flipper'];
async function irSerTeardown(n){
  n.connected=false; n.connecting=false; n.reading=false;
  if(n.reader){ try{ await n.reader.cancel(); }catch(e){} n.reader=null; }
  if(n.writer){ try{ n.writer.releaseLock(); }catch(e){} n.writer=null; }
  if(n.port){ try{ await n.port.close(); }catch(e){} n.port=null; }
}
function irSerLine(n,line){
  const l=line.trim(); if(!l) return;
  n.line=l; n.rxLines++;
  const dev=n.p.dev, nums=(l.match(/\d+/g)||[]);
  if(dev==='flipper'){                                 // кадр может идти несколькими строками — копим, сбрасываем по паузе
    if(/^RAW/i.test(l)){ n.acc=''; n.accT=performance.now(); return; }
    if(/^[\d\s]+$/.test(l) && nums.length>=2){ n.acc=(n.acc||'')+' '+l; n.accT=performance.now(); }
    return;
  }
  if(dev==='sketch (tools/ir)' && !/^RX\b/i.test(l)) return;
  if(nums.length>=6) n.rxQ.push(l.replace(/^RX\b/i,''));
}
async function irSerRead(n){
  n.reading=true;
  const reader=n.port.readable.pipeThrough(new TextDecoderStream()).getReader(); n.reader=reader;
  let buf='';
  try{
    for(;;){
      const {value,done}=await reader.read(); if(done) break;
      buf+=value; let m;
      while((m=/\r?\n/.exec(buf))){ const line=buf.slice(0,m.index); buf=buf.slice(m.index+m[0].length); irSerLine(n,line); }
      if(buf.length>20000) buf='';
    }
  }catch(e){ n.status='read error: '+e.message; }
  n.reading=false;
}
async function irSerConnect(n){
  if(n.connecting) return;
  await irSerTeardown(n);
  if(!navigator.serial){ n.status='WebSerial unavailable (needs Chrome/Edge, HTTPS)'; return; }
  n.connecting=true; n.status='choose a port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:+n.p.baud||115200});
    n.port=port; n.connecting=false; n.connected=true; n.status='connected, '+n.p.baud+' baud';
    n.writer=port.writable.getWriter();
    irSerRead(n);
    if(n.p.dev==='flipper') irSerWrite(n,'ir rx raw\r\n');
  }catch(e){
    n.connecting=false; n.connected=false;
    n.status=e.name==='NotFoundError' ? 'no port selected' : 'error: '+e.message;
  }
}
function irSerWrite(n,str){
  if(!n.writer) return;
  const data=new TextEncoder().encode(str);
  n.chain=n.chain.then(()=>n.writer?.write(data)).then(()=>{ n.sent++; },e=>{ n.status='write error: '+e.message; });
}
function irSerFormat(n,p){
  const d=n.p.dev;
  if(d==='flipper') return irFormat('flipper',p.dur,p.freq)+'\r\n';
  if(d==='sketch (tools/ir)') return 'TX '+(p.freq|0)+' '+p.dur.join(' ')+'\n';
  return irFormat('wire',p.dur,p.freq)+'\n';
}
def({ id:'irSerial', title:'IR Serial (WebSerial)', cat:'IR', kw:'infrared remote arduino esp32 flipper zero serial transceiver',
  ins:[{n:'raw',t:'txt'}], outs:[{n:'raw',t:'txt'},{n:'new',t:'num'},{n:'line',t:'txt'}], readout:true,
  params:[{n:'dev',t:'select',opts:IR_SER_DEV,d:'wire',label:'device protocol',
           fn:n=>{ if(n.connected && n.p.dev==='flipper') irSerWrite(n,'ir rx raw\r\n'); }},
          {n:'baud',t:'select',opts:['9600','19200','38400','57600','115200','230400'],d:'115200'},
          {n:'connect',t:'button',label:'Connect',fn:n=>irSerConnect(n)},
          {n:'disconnect',t:'button',label:'Disconnect',fn:n=>{ n.status='disconnected'; irSerTeardown(n); }}],
  init:n=>{ n.port=n.reader=n.writer=null; n.connected=n.connecting=n.reading=false; n.chain=Promise.resolve();
            n.rxQ=[]; n.acc=''; n.accT=0; n.line=''; n.sent=0; n.rxLines=0; n.frames=0; n.status='not connected'; },
  dispose:n=>{ irSerTeardown(n); },
  process(n,I){
    const raw=irEvent(n,'raw',I.raw);
    if(raw && n.connected){ const p=irParse(raw); if(p) irSerWrite(n,irSerFormat(n,p)); }
    if(n.acc && performance.now()-n.accT>250){ n.rxQ.push(n.acc); n.acc=''; }
    const out=n.rxQ.shift()||null;
    let w=null;
    if(out){ const p=irParse(out); if(p){ w=irFormat('wire',p.dur,p.freq); n.frames++; } }
    return {raw:w,new:w?1:0,line:n.line||null};
  },
  draw(n){ irReadout(n,n.status+' · sent '+n.sent+' · frames received '+n.frames+(n.line ? '\n'+n.line.slice(0,120) : '')); }
});
