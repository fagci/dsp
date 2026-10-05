"use strict";
/* ============================ POCSAG (пейджеры) ============================
   POCSAG Decoder (ядро в pocsag-kernels.js): IQ (или ЧМ-звук) → 2-FSK 512 / 1200 / 2400 Бод → пакеты с BCH(31,21) →
   адрес (RIC), функция, текст или цифры; записи для журнала и узла Messages. */

defIQ({ id:'pocsagRx', title:'POCSAG Decoder', cat:'Decoders', tall:true, resize:true, w:460,
  ins:[{n:'in',t:'iq'}], outs:[{n:'rec',t:'rec'}],
  params:[{n:'baud',t:'select',opts:['auto','512','1200','2400'],d:'auto',label:'baud rate (auto tries all three)'},
          {n:'fix',t:'select',opts:['2','1','0'],d:'2',label:'correct up to N bit errors per codeword (2 = full BCH power, more false messages in noise)'}]},
  n=>{ const u=n.ui; if(!u) return 'no input';
    const head=(u.fs/1000).toFixed(1)+' kS/s'+(u.M>1 ? ' (÷'+u.M+')' : '')+' · '+u.msgs+' messages · '+u.cws+' codewords ('+u.fixed+' fixed, '+u.bad+' bad)'+
      (u.baud ? ' · '+u.baud+' Bd' : '')+(u.age!=null ? ' · last '+(u.age/1000).toFixed(0)+' s ago' : '');
    return head+(u.recent.length ? '\n'+u.recent.join('\n') : '\nno sync yet'); });

/* ============================ POCSAG: передатчик ============================
   POCSAG Encode: сообщение (RIC, функция, текст / цифры / тональный вызов) → преамбула, пакеты, BCH → сигнал ±1 (1 — нижняя
   частота) на частоте движка. Дальше: IQ Modulator (NFM, девиация 4500 Гц) → HackRF TX; `tx` включает передачу на время
   сообщения. Биты строит pocTxBits (pocsag-kernels.js), здесь только очередь и выдача по отсчётам. */

function pocsagTxQueue(n,ric,text){
  const ricV=Math.round(ric ?? +n.p.ric), kind=n.p.type, func=+n.p.func|0;
  const err=pocTxCheck(ricV,func);
  if(err){ n.status=err; return; }
  const bits=pocTxBits(ricV,func,kind,text ?? n.p.text,Math.max(64,+n.p.pre|0));
  n.q.push({bits, ric:ricV, func, kind, text:kind==='tone' ? '' : String(text ?? n.p.text), baud:+n.p.baud});
  n.status='queued: '+ricV;
}
def({ id:'pocsagTx', title:'POCSAG: Transmit', cat:'Protocols', readout:true,
  ins:[{n:'go',t:'num'},{n:'text',t:'txt'},{n:'ric',t:'num'}], outs:[{n:'out',t:'sig'},{n:'tx',t:'num'},{n:'done',t:'num'}],
  params:[{n:'text',t:'text',d:'TEST'},
          {n:'ric',t:'num',d:1234567,label:'RIC (pager address), 0…2097151'},
          {n:'func',t:'select',opts:['0','1','2','3'],d:'3',label:'function (0 numeric, 3 text are the usual; the pager decides)'},
          {n:'type',t:'select',opts:['alpha','numeric','tone'],d:'alpha',label:'message type'},
          {n:'baud',t:'select',opts:['512','1200','2400'],d:'1200',label:'baud rate'},
          {n:'invert',t:'check',d:false,label:'invert (standard: 1 = lower frequency; try if the pager stays silent)'},
          {n:'pre',t:'range',min:64,max:2048,step:32,d:576,label:'preamble, bits'},
          {n:'lead',t:'range',min:0,max:1000,step:10,d:150,label:'carrier before the data, ms'},
          {n:'tail',t:'range',min:0,max:1000,step:10,d:100,label:'carrier after the data, ms'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:1,label:'level (±1 = full deviation of the modulator)'},
          {n:'auto',t:'check',d:false,label:'send every new text on the wire'},
          {n:'send',t:'button',label:'Send',fn:n=>pocsagTxQueue(n)}],
  init:n=>{ n.q=[]; n.cur=null; n.prevGo=0; n.lastText=undefined; n.status='waiting'; n.sent=0; n.done=0; n.lp=0; n.ph=0; },
  process(n,I){
    const sr=Eng.sr, o=buf(n,'out');
    const ric=typeof I.ric==='number' && isFinite(I.ric) ? I.ric : undefined;
    const go=I.go||0;
    if(go>.5 && n.prevGo<=.5) pocsagTxQueue(n,ric);
    n.prevGo=go;
    if(typeof I.text==='string'){
      if(I.text!==n.lastText){ n.lastText=I.text; n.p.text=I.text; if(n.p.auto && I.text) pocsagTxQueue(n,ric,I.text); }
    }
    let tx=0, done=0;
    const a=Math.min(1,2*Math.PI*0.65*(+n.p.baud||1200)/sr), amp=+n.p.amp, sgn=n.p.invert ? -1 : 1;
    for(let i=0;i<BLOCK;i++){
      if(!n.cur && n.q.length){
        const m=n.q.shift(), lead=Math.round(sr*n.p.lead/1000), tail=Math.round(sr*n.p.tail/1000);
        n.cur={m, pos:0, lead, tail, spb:sr/m.baud};
        n.status='sending '+m.ric+' · '+m.baud+' Bd · '+(m.bits.length/m.baud).toFixed(1)+' s';
      }
      const c=n.cur;
      let v=0;
      if(c){
        tx=1;
        if(c.lead>0){ c.lead--; }
        else if(c.pos<c.m.bits.length){ v=(c.m.bits[Math.floor(c.pos)] ? -1 : 1)*sgn; c.pos+=1/c.spb; }
        else if(c.tail>0){ c.tail--; }
        else { n.cur=null; n.sent++; done=1; n.status='sent '+c.m.ric+(c.m.text ? ': '+c.m.text.slice(0,40) : ' (tone)'); }
      }
      n.lp+=(v-n.lp)*a;
      o[i]=n.lp*amp;
    }
    return {out:o, tx, done};
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.status+(n.q.length ? ' · '+n.q.length+' queued' : '')+(n.sent ? ' · sent '+n.sent : ''); }});
