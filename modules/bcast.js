"use strict";
/* ============================ Tab Link ============================
   BroadcastChannel: обмен текстом и числами между вкладками и окнами одного сайта в одном браузере (без сети).
   Принятое разбирает netParse (net-kernels.js), как HTTP In. Вкладка не слышит сама себя, а два узла в одной вкладке — слышат. */

function blClose(n){ if(n.bc){ n.bc.onmessage=null; try{ n.bc.close(); }catch(e){} n.bc=null; } n.ok=false; }
function blOpen(n){
  blClose(n);
  const name=String(n.p.channel||'').trim();
  if(!name){ n.status='enter a channel name'; return; }
  if(typeof BroadcastChannel==='undefined'){ n.status='BroadcastChannel is not supported'; return; }
  const bc=new BroadcastChannel('dsp:'+name); n.bc=bc; n.ok=true; n.status='listening on «'+name+'»';
  bc.onmessage=e=>{
    const text=typeof e.data==='string' ? e.data : String(e.data);
    const m=netParse(text,n.p.field,'',Date.now(),{channel:name});
    n.msgs++; n.q.push(m); n.recQ.push(...m.rec);
    if(n.q.length>5000) n.q.splice(0,n.q.length-5000);
    if(n.recQ.length>20000) n.recQ.splice(0,n.recQ.length-20000);
  };
}
function blSend(n,s){ if(n.bc){ n.bc.postMessage(s); n.sent++; return true; } return false; }
def({ id:'tabLink', title:'Tab Link', cat:'Data', kw:'broadcastchannel tabs windows share between same browser sync dashboard second window',
  ins:[{n:'text',t:'txt'},{n:'value',t:'num'}],
  outs:[{n:'text',t:'txt'},{n:'value',t:'num'},{n:'rec',t:'rec'},{n:'new',t:'num'},{n:'ok',t:'num'}], readout:true,
  params:[{n:'channel',t:'text',d:'main',label:'channel (the same name in the other tab)',fn:n=>blOpen(n)},
          {n:'field',t:'text',d:'',label:'JSON field for the value output (a.b.0.c)'}],
  init:n=>{ n.bc=null; n.ok=false; n.q=[]; n.recQ=[]; n.msgs=0; n.sent=0; n.lastText=undefined; n.lastVal=undefined;
            n.last={text:'',val:0}; n.status='closed'; blOpen(n); },
  dispose:n=>blClose(n),
  process(n,I){
    if(typeof I.text==='string' && I.text!==n.lastText){ if(!I.text || blSend(n,I.text)) n.lastText=I.text; }
    if(typeof I.value==='number' && isFinite(I.value) && I.value!==n.lastVal){ if(blSend(n,String(I.value))) n.lastVal=I.value; }
    const m=n.q.length ? n.q.shift() : null;
    if(m) n.last={text:m.text,val:m.val!==null ? m.val : n.last.val};
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {text:m ? m.text : null, value:n.last.val, rec, new:m ? 1 : 0, ok:n.ok ? 1 : 0};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+' · in '+n.msgs+' · out '+n.sent+(n.last.text ? '\n'+n.last.text.slice(0,300) : '');
    if(r.textContent!==t) r.textContent=t; }
});
