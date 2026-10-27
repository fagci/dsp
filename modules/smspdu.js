"use strict";
/* ============================ SMS PDU ============================
   Собирает и разбирает SMS как по воздуху (3GPP TS 23.040/23.038): SMS-SUBMIT / SMS-DELIVER, оба алфавита (GSM 7 бит, UCS-2),
   заголовок UDH (склейка длинных сообщений, порты — data SMS), срок жизни, флаги. «parse» принимает hex откуда угодно — из
   HEX Structure (схема sms-pdu, modules/hex-formats.js), из Bytes, из входящего rec Phone Actions (SMS с «pdu» — Android даёт сырой
   PDU на incoming) или руками; «build» отдаёт hex, который Phone Actions не отправит сам (SmsManager шлёт текст или data SMS —
   см. phoneact.js), зато годится в HEX Structure / файл / другой канал. Ядро — modules/smspdu-kernels.js (tools/test-smspdu.mjs). */

def({ id:'smspdu', title:'SMS PDU', cat:'Protocols', kw:'sms pdu gsm 7bit ucs2 udh tpdu sms-submit sms-deliver concatenated multipart data sms port 3gpp 23.040 23.038',
  ins:[{n:'hex',t:'txt'},{n:'text',t:'txt'},{n:'go',t:'num'}],
  outs:[{n:'hex',t:'txt'},{n:'tpdu',t:'txt'},{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'parts',t:'num'},{n:'ok',t:'num'}],
  readout:true, tall:true,
  groups:[{n:'Build'},{n:'Parse',open:false}],
  params:[
    {n:'mode',t:'select',opts:['build','parse'],d:'build',label:'mode'},
    {n:'type',t:'select',opts:['submit (phone → network)','deliver (network → phone)'],d:'submit (phone → network)',label:'TPDU type',g:'Build'},
    {n:'smsc',t:'text',d:'',label:'SMSC number (empty — let the network use its default)',g:'Build'},
    {n:'addr',t:'text',d:'+10000000000',label:'to / from number (or a name, up to 11 GSM-7 characters)',g:'Build'},
    {n:'text',t:'text',d:'Hello',label:'text (the «text» input overrides it)',g:'Build'},
    {n:'enc',t:'select',opts:['auto','gsm7','ucs2','8bit (data SMS)'],d:'auto',label:'encoding'},
    {n:'data',t:'text',d:'',label:'8-bit data, hex (enc: 8bit; empty — UTF-8 of the text)',g:'Build'},
    {n:'ports',t:'check',d:false,label:'data SMS: application ports (UDH)',g:'Build'},
    {n:'dport',t:'num',d:2948,label:'destination port',g:'Build'},
    {n:'sport',t:'num',d:2948,label:'source port',g:'Build'},
    {n:'flash',t:'check',d:false,label:'flash (class 0, shown without saving)',g:'Build'},
    {n:'vp',t:'range',min:0,max:43200,step:5,d:0,label:'validity, min (submit; 0 — don\'t set)',g:'Build'},
    {n:'srr',t:'check',d:false,label:'request a delivery report (submit)',g:'Build'},
    {n:'ref',t:'num',d:'',label:'concatenation reference (empty — random)',g:'Build'},
    {n:'withSmsc',t:'select',opts:['auto','with SMSC','TPDU only'],d:'auto',label:'the hex includes',g:'Parse'},
    {n:'join',t:'check',d:true,label:'join concatenated parts (wait for all, by reference + sender)',g:'Parse'},
  ],
  init:n=>{ n.lastSig=''; n.lastHexIn=null; n.join=new Map(); n.recQ=[]; n.hexOut=''; n.tpduOut=''; n.textOut=''; n.partsN=0; n.ok=1; n.err=''; n.prevGo=0; n.info=''; },
  process(n,I){
    if(n.p.mode==='build'){
      const text=typeof I.text==='string' && I.text!=='' ? I.text : String(n.p.text||'');
      const sig=JSON.stringify([n.p.type,n.p.smsc,n.p.addr,text,n.p.enc,n.p.data,n.p.ports,n.p.dport,n.p.sport,n.p.flash,n.p.vp,n.p.srr,n.p.ref]);
      if(sig!==n.lastSig){
        n.lastSig=sig;
        const enc=n.p.enc==='8bit (data SMS)' ? '8bit' : n.p.enc;
        const o={type:n.p.type.startsWith('deliver') ? 'deliver' : 'submit', smsc:n.p.smsc, enc, text, data:n.p.data,
                 flash:n.p.flash, vp:+n.p.vp||0, srr:n.p.srr, ref:n.p.ref!=='' ? +n.p.ref : undefined,
                 ports:n.p.ports ? {dst:+n.p.dport||0,src:+n.p.sport||0} : undefined};
        if(o.type==='submit') o.to=n.p.addr; else o.from=n.p.addr;
        const r=smsBuild(o);
        if(r.error){ n.err=r.error; n.ok=0; n.hexOut=''; n.tpduOut=''; n.textOut=''; n.partsN=0; }
        else { n.err=''; n.ok=1; n.hexOut=r.parts.map(p=>p.hex).join('\n'); n.tpduOut=r.parts.map(p=>p.tpdu).join('\n'); n.textOut=text; n.partsN=r.count; n.parts=r.parts; n.enc=r.enc; }
      }
      return {hex:n.hexOut||null, tpdu:n.tpduOut||null, text:n.textOut||null, rec:null, parts:n.partsN, ok:n.ok};
    }
    // parse
    const go=(I.go||0)>.5, hexIn=typeof I.hex==='string' ? I.hex : '';
    const fire=(go && !n.prevGo) || (hexIn && hexIn!==n.lastHexIn); n.prevGo=go;
    if(fire && hexIn){
      n.lastHexIn=hexIn;
      const withSmsc=n.p.withSmsc==='with SMSC' ? true : n.p.withSmsc==='TPDU only' ? false : 'auto';
      const r=smsParse(hexIn,withSmsc);
      if(r.error){ n.err=r.error; n.ok=0; n.info='error: '+r.error; }
      else {
        n.ok=1; n.err='';
        const rec=smsRec(r);
        if(n.p.join && r.concat){
          const j=smsJoin(n.join,r);
          if(j && j.done){ n.textOut=j.text; rec.joined=true; rec.text=j.text; n.info=(r.from||r.to)+': '+j.text.slice(0,60)+(j.text.length>60?'…':''); }
          else n.info='part '+r.concat.seq+'/'+r.concat.total+' — waiting for the rest';
        } else { n.textOut=r.text; n.info=(r.from||r.to||'')+': '+r.text.slice(0,60)+(r.text.length>60?'…':''); }
        n.recQ.push({t:Date.now(),...rec});
        if(n.recQ.length>1000) n.recQ.splice(0,n.recQ.length-1000);
      }
    }
    const rec=n.recQ.length ? n.recQ.splice(0) : null;
    return {hex:null, tpdu:null, text:n.textOut||null, rec, parts:n.partsN, ok:n.ok};
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    let t;
    if(n.p.mode==='build') t=n.err ? '⚠ '+n.err : n.partsN+' part'+(n.partsN===1?'':'s')+' · '+(n.enc||'')+(n.hexOut ? '\n'+n.hexOut.split('\n')[0].slice(0,100) : '');
    else t=n.err ? '⚠ '+n.err : (n.info||'waiting for hex…');
    if(r.textContent!==t) r.textContent=t; }
});
