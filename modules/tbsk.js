"use strict";
/* ============================ TBSK (nyatla/TBSKmodem): узлы ============================
   Ядро — tbsk-kernels.js. Приём: звук → корреляция символа с предыдущим → преамбула → биты → байты. Конца пакета в сигнале нет:
   кадр закрывается, когда корреляция падает (стоп-символ передатчика, тишина) или набрано «max bytes». */

def({ id:'tbskRx', title:'TBSK Decoder', cat:'Decoders', readout:true, tall:true, resize:true, w:420,
  kw:'tbsk tbskmodem nyatla spread spectrum dpsk delay detection acoustic modem data over sound',
  ins:[{n:'in',t:'sig'}], outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'new',t:'num'},{n:'level',t:'num'}],
  params:[{n:'fc',t:'range',min:200,max:12000,step:1,d:4800,label:'carrier, Hz (as in the transmitter)'},
          {n:'cycle',t:'range',min:2,max:100,step:1,d:10,label:'tone length, carrier periods (as in the transmitter; bit rate = carrier / cycle)'},
          {n:'th',t:'range',min:.05,max:.6,step:.01,d:.2,label:'end of frame: correlation below this'},
          {n:'det',t:'range',min:.2,max:.9,step:.01,d:.4,label:'preamble detection threshold'},
          {n:'max',t:'range',min:0,max:1024,step:1,d:0,label:'max bytes per frame (0 = until the signal ends)'}],
  init:n=>{ n.key=''; n.rx=null; n.lvl=0; n.frames=0; n.recent=[]; n.last=''; },
  process(n,I){
    const sr=Eng.sr, p=n.p, key=[sr,p.fc,p.cycle,p.th,p.det,p.max].join('|');
    if(n.key!==key){
      n.key=key; n.tone=tbskTone(sr,+p.fc,+p.cycle);
      n.rx=tbskRxNew(n.tone.length,{th:+p.th, det:+p.det, maxBytes:+p.max});
    }
    const x=I.in, recs=[], texts=[], out=[];
    let e=0;
    if(x){ for(let i=0;i<BLOCK;i++) e+=x[i]*x[i]; tbskRxFeed(n.rx,x,BLOCK,out); }
    else tbskRxFeed(n.rx,new Float32Array(BLOCK),BLOCK,out);
    n.lvl=n.lvl*.9+Math.sqrt(e/BLOCK)*.1;
    for(const f of out){
      if(!f.bytes.length) continue;
      const text=new TextDecoder().decode(f.bytes).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'·'), hex=[...f.bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
      n.frames++;
      recs.push({t:Date.now(), src:'TBSK', kind:'frame', id:hex.slice(0,16), bytes:f.bytes.length, bits:f.bits, hex, text, quality:+f.quality.toFixed(2), bps:Math.round(sr/n.tone.length)});
      texts.push(text);
      n.last=text;
      n.recent.push(f.bytes.length+' B · q '+f.quality.toFixed(2)+' · '+text.replace(/\n/g,' ').slice(0,60)); if(n.recent.length>20) n.recent.shift();
    }
    return {rec:recs.length ? recs : null, text:texts.length ? texts.join('\n') : null, new:recs.length ? 1 : 0, level:n.lvl};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const bps=n.tone ? Eng.sr/n.tone.length : 0;
    const t=n.frames+' frames · '+bps.toFixed(0)+' bit/s · '+(n.rx && n.rx.mode ? 'receiving '+n.rx.bits.length+' bits' : 'searching preamble')+' · input '+(n.lvl>1e-4 ? (20*Math.log10(n.lvl)).toFixed(0)+' dBFS' : '—')+
      (n.recent.length ? '\n'+n.recent.slice(-8).join('\n') : '\nwaiting for a TBSK burst');
    if(r.textContent!==t) r.textContent=t; }
});

/* ---- Передатчик ---- */
function tbskTxQueue(n,text,lead){
  const sr=Eng.sr, tone=tbskTone(sr,+n.p.fc,+n.p.cycle), bytes=new TextEncoder().encode(String(text).slice(0,1024));
  if(!bytes.length){ n.status='nothing to send'; return; }
  const w=tbskModulate(tone,tbskBits(bytes),{amp:+n.p.amp, stop:n.p.stop!==false});
  if(lead){ const z=new Float32Array(lead+w.length); z.set(w,lead); n.tq={w:z, i:0}; } else n.tq={w, i:0};
  n.status='sending '+bytes.length+' B · '+(sr/tone.length).toFixed(0)+' bit/s · '+(n.tq.w.length/sr).toFixed(2)+' s\n"'+String(text).slice(0,60)+'"';
}
def({ id:'tbskTx', title:'TBSK Modulator', cat:'Protocols', readout:true, tall:true,
  kw:'tbsk tbskmodem nyatla spread spectrum dpsk transmit modulator acoustic modem data over sound',
  ins:[{n:'text',t:'txt'},{n:'go',t:'num'}], outs:[{n:'out',t:'sig'},{n:'busy',t:'num'}],
  params:[{n:'msg',t:'text',d:'Hello, TBSK!',label:'message (if the text input is empty)'},
          {n:'fc',t:'range',min:200,max:12000,step:1,d:4800,label:'carrier, Hz'},
          {n:'cycle',t:'range',min:2,max:100,step:1,d:10,label:'tone length, carrier periods (bit rate = carrier / cycle)'},
          {n:'amp',t:'range',min:0,max:1,step:.01,d:.5},
          {n:'stop',t:'check',d:true,label:'stop symbol at the end (the receiver closes the frame on it)'},
          {n:'auto',t:'check',d:false,label:'send when the text input changes'},
          {n:'send',t:'button',label:'Send',fn:n=>{ n.send=true; }}],
  init:n=>{ n.tq=null; n.pend=[]; n.prevGo=0; n.send=false; n.lastIn=undefined; n.status='waiting'; },
  process(n,I){
    const o=buf(n,'out'), go=I.go||0, inText=typeof I.text==='string' && I.text ? I.text : null;
    let want=(go>.5 && n.prevGo<=.5) || n.send; n.prevGo=go; n.send=false;
    if(inText!==null && inText!==n.lastIn){ n.lastIn=inText; if(n.p.auto) want=true; }
    if(want){                                        // идёт передача — кадр ждёт в очереди, а не затирает текущий
      const t=inText!==null ? inText : n.p.msg;
      if(n.tq){ if(n.pend.length<32) n.pend.push(t); } else tbskTxQueue(n,t);
    }
    const q=n.tq;
    if(q){
      const k=Math.min(BLOCK,q.w.length-q.i);
      for(let i=0;i<k;i++) o[i]=q.w[q.i+i];
      for(let i=k;i<BLOCK;i++) o[i]=0;
      q.i+=k;
      if(q.i>=q.w.length){
        n.tq=null; n.status='sent';
        if(n.pend.length) tbskTxQueue(n,n.pend.shift(),Math.round(Eng.sr*.15));   // пауза, чтобы приёмник закрыл прошлый кадр
      }
      return {out:o, busy:1};
    }
    o.fill(0);
    return {out:o, busy:0};
  },
  draw(n){ n.el.querySelector('.readout').textContent=n.status; }});
