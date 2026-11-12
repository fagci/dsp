"use strict";
/* ============================ Protocol Codec: реестр протоколов + универсальный кодер/декодер ============================
   Один узел на все протоколы из реестра (modules/protoreg-kernels.js): выбери протокол и режим —
     loopback — поля → байты → поля, показывает, что круг сошёлся (или чем отличается);
     encode   — поля (JSON) → hex;   decode — hex → поля (JSON);
     list     — таблица всех протоколов реестра со статусом «есть ли зеркальная пара» (выход rec — в Table).
   Поля пусты — берётся образец протокола (он же на выходе «sample»). У протоколов без адаптера узел показывает, какие функции
   ядра есть с какой стороны. Ядро — protoreg-kernels.js (tools/test-protoreg.mjs). */

const PROTO_TITLES=protoList().map(d=>d.title);
const protoByTitle=t=>protoList().find(d=>d.title===t)||protoList()[0];
const protoJson=v=>JSON.stringify(v,(k,x)=>x instanceof Uint8Array ? Array.from(x) : (typeof x==='number' && !Number.isFinite(x)) ? null : x,1);

def({ id:'protoCodec', title:'Protocol Codec (encode / decode / registry)', cat:'Protocols', kw:'protocol codec encoder decoder registry loopback roundtrip mirror pair adsb odid rds ntp tftp dns ble syslog sms dcf77 lzhuf',
  ins:[{n:'fields',t:'txt'},{n:'hex',t:'txt'}],
  outs:[{n:'hex',t:'txt'},{n:'fields',t:'txt'},{n:'sample',t:'txt'},{n:'ok',t:'num'},{n:'rec',t:'rec'}],
  readout:true, tall:true, w:420, resize:true,
  params:[
    {n:'proto',t:'select',opts:PROTO_TITLES,d:PROTO_TITLES[0],label:'protocol'},
    {n:'mode',t:'select',opts:['loopback','encode','decode','list'],d:'loopback',label:'mode'},
    {n:'fields',t:'text',d:'',label:'fields, JSON (empty — the protocol\'s sample; the «fields» input overrides it)'}],
  init:n=>{ n.sig=''; n.o={hex:null,fields:null,sample:null,ok:0,rec:null}; n.txt=''; },
  process(n,I){
    const d=protoByTitle(n.p.proto), mode=n.p.mode;
    const inF=typeof I.fields==='string' && I.fields.trim() ? I.fields : String(n.p.fields||''), inH=typeof I.hex==='string' ? I.hex : '';
    const sig=JSON.stringify([d.id,mode,inF,inH]);
    if(sig===n.sig) return n.o;
    n.sig=sig;
    const st=protoStatus(d), A=d.adapter;
    const head=d.title+' — '+PROTO_STATUS_TXT[st]+'\n  decode: '+(d.dec.join(', ')||'—')+'\n  encode: '+(d.enc.join(', ')||'—')+(d.gen.length ? '\n  test generator: '+d.gen.join(', ') : '')+(d.note ? '\n  note: '+d.note : '');
    const o={hex:null,fields:null,sample:A ? protoJson(A.sample()) : null,ok:0,rec:null};
    try{
      if(mode==='list'){
        const s=protoSummary(); o.rec=s.rows.map(r=>({...r})); o.ok=1;
        n.txt=Object.entries(s.cnt).map(([k,v])=>PROTO_STATUS_TXT[k]+': '+v).join('\n')+'\n'+s.rows.length+' protocols';
      } else if(!A){
        n.txt=head+'\n\n⚠ no codec adapter yet — no encode / decode here (the functions above are in the kernel).';
      } else if(mode==='decode'){
        const r=A.parse(protoBytesOf(inH),A.sample());
        o.fields=protoJson(r); o.ok=r ? 1 : 0; n.txt=head+'\n\n'+(r ? o.fields : '⚠ not a '+d.title+' frame');
      } else {
        const f=inF ? JSON.parse(inF) : A.sample();
        if(mode==='encode'){
          const b=A.build(f); o.hex=protoHexOf(b); o.ok=1; n.txt=head+'\n\n'+b.length+' bytes\n'+o.hex;
        } else {
          const r=protoRoundtrip(d.id,f);
          o.hex=r.hex||null; o.fields=r.back ? protoJson(r.back) : null; o.ok=r.ok ? 1 : 0;
          n.txt=head+'\n\n'+(r.error ? '⚠ '+r.error : (r.ok ? '✓ round trip OK · ' : '✗ differs: '+r.diff.join('; ')+' · ')+r.hex.length/2+' bytes\n'+r.hex);
        }
      }
    }catch(e){ n.txt=head+'\n\n⚠ '+(e && e.message || e); o.ok=0; }
    n.o=o; return o;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return; const t=n.txt||'…'; if(r.textContent!==t) r.textContent=t; }
});
