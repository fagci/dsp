"use strict";
/* ============================ Модем (V.8 / V.34-подобный) и телефонная линия ============================
   Modem — одна сторона дозвона (V.8 + V.34-подобный режим или V.22bis / V.22 по спецификации): звонящий набирает номер (DTMF) и проходит V.8, обмен INFO, зондирование линии, обучение QAM и
   выходит на данные; отвечающий слышит набор, «звонит» ringS секунд, берёт трубку тоном ANSam и ведёт ту же последовательность.
   Две стороны соединяются через блок Telephone Line (полоса 300–3400 Гц, шум, задержка, µ-law): скорость подключения
   зависит от линии, как у настоящего модема. spk — то, что слышно в динамике модема (гудок, набор, свисты, шипение; после
   CONNECT динамик по умолчанию выключается). Логика и протокол — modem-kernels.js / modem-dsp-kernels.js. Не V.90 / V.92
   (PCM вниз требует цифрового конца) и не совместим по проводу с настоящими модемами. Не излучать в эфир. */

const mdmUiShow=(n,t)=>{ const r=n.el && n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t; };
const mdmUiRates=['33600','31200','28800','26400','24000','21600','19200','14400','9600','4800','2400','1200'];
const mdmUiProto={'auto':'auto','V.34-like':'v34','V.22bis':'v22'};
function mdmUiIo(n){                                  // ресемплеры и очереди на текущую частоту движка
  if(n.sr!==Eng.sr){ n.sr=Eng.sr; n.rin=mdmResamp(Eng.sr,MDM_FS); n.rup=mdmResamp(MDM_FS,Eng.sr); n.rupM=mdmResamp(MDM_FS,Eng.sr);
    n.oq=new Array(BLOCK).fill(0); n.mq=new Array(BLOCK).fill(0); n.xb=new Float32Array(512); n.yb=new Float32Array(512); n.mb=new Float32Array(512); }
}
function mdmUiPop(q,len){ if(q.length>len*6) q.splice(0,q.length-len*2); const o=new Float32Array(len), k=Math.min(len,q.length); for(let i=0;i<k;i++) o[i]=q[i]; q.splice(0,k); return o; }

def({ id:'modem', title:'Modem (V.8 / V.34-like)', cat:'Protocols', readout:true, tall:true, w:340,
  kw:'modem dial-up dialup 56k 33600 28800 v90 v34 v8 handshake ansam dtmf connect nostalgia fsk qam telephone call answer',
  ins:[{n:'line',t:'sig'},{n:'dial',t:'num'},{n:'hang',t:'num'},{n:'tx',t:'txt'}],
  outs:[{n:'line',t:'sig'},{n:'spk',t:'sig'},{n:'rx',t:'txt'},{n:'iq',t:'iq',pair:['cI','cQ']},{n:'cI',t:'sig',hide:true},{n:'cQ',t:'sig',hide:true},{n:'connected',t:'num'},{n:'rate',t:'num'}],
  params:[{n:'role',t:'select',opts:['caller','answerer'],d:'caller',label:'caller dials and starts V.8; answerer picks up after the ring'},
          {n:'proto',t:'select',opts:['auto','V.34-like','V.22bis'],d:'auto',label:'auto: V.8 → V.34-like if the other end answers with ANSam, else V.22bis / V.22 (the 90s 2400 / 1200 bit/s); the other two force one'},
          {n:'number',t:'text',d:'5551234',label:'number to dial (digits, * # A–D)'},
          {n:'ringS',t:'range',min:0,max:8,step:.1,d:3,label:'answerer: ring time before it picks up, s'},
          {n:'pace',t:'range',min:.5,max:8,step:.5,d:3,label:'time scale of the probing and training (1 ≈ 8 s in all, 3 ≈ a real modem, ~15 s)'},
          {n:'maxRate',t:'select',opts:mdmUiRates,d:'33600',label:'highest rate this modem offers, bit/s'},
          {n:'spk',t:'select',opts:['until connect','always','off'],d:'until connect',label:'modem speaker: until the carrier (as ATM1), always, off'},
          {n:'vol',t:'range',min:0,max:8,step:.1,d:2,label:'speaker volume'},
          {n:'greet',t:'text',d:'Hello from the DSP workbench modem!\r\n',label:'text sent once after CONNECT (empty — none)'},
          {n:'autoDial',t:'check',d:false,label:'caller: dial 1 s after start'},
          {n:'dialBtn',t:'button',label:'Dial / answer line',fn:n=>{ n.wantDial=true; }},
          {n:'hangBtn',t:'button',label:'Hang up',fn:n=>{ n.wantHang=true; }},
          {n:'sendBtn',t:'button',label:'Send text',fn:n=>{ n.wantSend=true; }}],
  init:n=>{ n.m=null; n.role=''; n.t0=0; n.auto=false; n.wantDial=false; n.wantHang=false; n.wantSend=false; n.prevD=0; n.prevH=0; n.lastTx=''; n.greeted=false; n.sr=0; n.cI=0; n.cQ=0; n.fade=1; n.rxN=0; n.show=''; },
  process(n,I){
    const p=n.p; mdmUiIo(n);
    if(!n.m || n.role!==p.role){ n.role=p.role; n.m=mdmNew({role:p.role==='answerer'?'ans':'call',digits:p.number,pace:+p.pace,maxRate:+p.maxRate,ringS:+p.ringS,dialToneMs:1000,proto:mdmUiProto[p.proto]||'auto'}); n.greeted=false; n.auto=false; n.t0=0; }
    const m=n.m, o=m.o; o.proto=mdmUiProto[p.proto]||'auto'; o.digits=String(p.number); o.ringS=+p.ringS; o.maxRate=+p.maxRate; m.pace=Math.max(.5,+p.pace);
    n.t0+=BLOCK/Eng.sr;
    if(!n.auto){ n.auto=true; }
    if(p.autoDial && p.role==='caller' && !n.dialed && n.t0>1){ n.dialed=true; n.wantDial=true; }
    const d=I.dial||0; if(d>.5 && n.prevD<=.5) n.wantDial=true; n.prevD=d;
    const h=I.hang||0; if(h>.5 && n.prevH<=.5) n.wantHang=true; n.prevH=h;
    if(n.wantDial){ n.wantDial=false; if(m.role==='call') mdmDial(m); }
    if(n.wantHang){ n.wantHang=false; mdmHang(m,'Hang up'); }
    const tx=(typeof I.tx==='string' && I.tx && I.tx!==n.lastTx) ? I.tx : null; if(tx!==null) n.lastTx=tx;
    if(n.wantSend){ n.wantSend=false; if(m.connected) mdmSend(m,Array.from(new TextEncoder().encode(String(p.greet)))); }
    if(tx!==null && m.connected) mdmSend(m,Array.from(new TextEncoder().encode(tx)));
    if(m.connected && !n.greeted){ n.greeted=true; if(p.greet) mdmSend(m,Array.from(new TextEncoder().encode(String(p.greet)))); }
    if(!m.connected) n.greeted=false;
    // вход линии → 12 кГц, ядро кусками, выход → частота движка
    const xin=I.line||new Float32Array(BLOCK), x12=n.rin.run(xin,BLOCK), len=x12.length;
    const y12=[], mon12=[];
    for(let off=0;off<len;off+=n.xb.length){ const k=Math.min(n.xb.length,len-off);
      for(let i=0;i<k;i++) n.xb[i]=x12[off+i];
      mdmRun(m,n.xb,k,n.yb,n.mb); for(let i=0;i<k;i++){ y12.push(n.yb[i]); mon12.push(n.mb[i]); } }
    n.rup.run(y12,y12.length,n.oq); n.rupM.run(mon12,mon12.length,n.mq);
    const line=mdmUiPop(n.oq,BLOCK), spk=mdmUiPop(n.mq,BLOCK);
    const gTarget=p.spk==='off' ? 0 : p.spk==='always' ? 1 : (m.connected ? 0 : 1);
    n.fade+=(gTarget-n.fade)*0.08; const g=n.fade*(+p.vol);
    for(let i=0;i<BLOCK;i++) spk[i]*=g;
    // новые принятые байты → текст
    let rx=null; if(m.rxq.length){ const bytes=Uint8Array.from(m.rxq.splice(0)); try{ rx=new TextDecoder('utf-8',{fatal:false}).decode(bytes); }catch(e){ rx=String.fromCharCode(...bytes); } n.rxN+=bytes.length; }
    // созвездие эквалайзера
    const cI=new Float32Array(BLOCK), cQ=new Float32Array(BLOCK), q=m.v22||m.qrx;
    if(q && q.pts.length){ const pts=q.pts.splice(0), k=pts.length>>1; if(k>0){ for(let i=0;i<BLOCK;i++){ const j=Math.min(k-1,Math.floor(i*k/BLOCK)); cI[i]=pts[2*j]; cQ[i]=pts[2*j+1]; } n.cI=cI[BLOCK-1]; n.cQ=cQ[BLOCK-1]; } }
    else { cI.fill(n.cI); cQ.fill(n.cQ); }
    return {line, spk, rx, cI, cQ, connected:m.connected?1:0, rate:m.connected?m.rate.rx:0}; },
  drawKey:n=>{ const m=n.m; return m ? m.logs.length+'|'+m.ph+'|'+m.connected+'|'+n.rxN+'|'+(m.qrx&&m.qrx.st) : ''; },
  draw(n){ const m=n.m; if(!m) return;
    const ph={idle:'idle',dialtone:'dial tone',dial:'dialing',waitans:'ringing',ring:'ringing',ansam:'ANSam',v8a:'V.8',jm:'V.8',cm:'V.8',cj:'V.8',info0:'INFO0',probe:'probing',info1:'INFO1',train:'training',data0:'start',data:'DATA',v22:'V.22bis'}[m.ph]||m.ph;
    const head=(m.role==='call'?'CALLER ':'ANSWERER ')+(m.role==='call'?m.o.digits:'')+' · '+ph+(m.connected?' · '+m.rate.tx+' / '+m.rate.rx+' bit/s':'')+((m.v22&&m.v22.rx.evm)||(m.qrx&&m.qrx.evm)?' · EVM '+(((m.v22&&m.v22.rx.evm)||m.qrx.evm)).toFixed(0)+' dB':'');
    const lg=m.logs.slice(-9).map(l=>'['+(l.ms/1000).toFixed(1)+'] '+l.t).join('\n');
    mdmUiShow(n,head+'\n'+lg+(m.rxText?'\n⇐ '+m.rxText.slice(-120).replace(/\r?\n/g,' ⏎ '):'')); }});

def({ id:'phoneline', title:'Telephone Line (band, noise, delay)', cat:'Processing', ins:[{n:'in',t:'sig'}], outs:[{n:'out',t:'sig'}],
  kw:'telephone line pstn band 300 3400 noise delay mu-law codec modem channel',
  params:[{n:'lo',t:'range',min:50,max:1000,step:10,d:300,label:'low edge of the band, Hz'},
          {n:'hi',t:'range',min:1500,max:4000,step:50,d:3400,label:'high edge of the band, Hz'},
          {n:'snr',t:'range',min:10,max:60,step:1,d:42,label:'SNR of a nominal modem signal, dB (60 — almost clean)'},
          {n:'delayMs',t:'range',min:0,max:300,step:1,d:12,label:'one-way delay, ms'},
          {n:'gainDb',t:'range',min:-40,max:6,step:1,d:-6,label:'line loss, dB'},
          {n:'law',t:'check',d:true,label:'µ-law codec (8-bit companding, as on digital trunks)'}],
  init:n=>{ n.ln=null; n.key=''; n.sr=0; },
  process(n,I){
    const p=n.p; mdmUiIo(n);
    const key=[p.lo,p.hi,p.snr,p.delayMs,p.gainDb,p.law].join('|');
    if(n.key!==key || !n.ln){ n.key=key; n.ln=mdmLineNew({lo:+p.lo,hi:+p.hi,snr:+p.snr,delayMs:+p.delayMs,gainDb:+p.gainDb,law:!!p.law,seed:5}); }
    const x12=n.rin.run(I.in||new Float32Array(BLOCK),BLOCK), len=x12.length, y12=new Float32Array(len);
    n.ln.run(x12,len,y12); n.rup.run(y12,len,n.oq);
    return {out:mdmUiPop(n.oq,BLOCK)}; }});
