"use strict";
/* ============================ Web NFC ============================
   Чтение и запись NFC-меток (NDEF): серийный номер, текст, ссылки, MIME / JSON. Chrome на Android (89+) по https:
   десктопные браузеры Web NFC не поддерживают. Чтение запускается только по клику (Scan); пока вкладка видна, метка
   у задней панели телефона читается сама. Запись: поднести метку после кнопки Write или фронта на go. */

function nfcDecode(r){
  const dv=r.data;
  const text=enc=>{ try{ return new TextDecoder(enc||'utf-8').decode(dv); }catch(e){ return ''; } };
  const hex=()=>dv ? Array.from(new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength),b=>b.toString(16).padStart(2,'0')).join(' ') : '';
  if(!dv) return {type:r.recordType,data:''};
  switch(r.recordType){
    case 'text': return {type:'text',data:text(r.encoding),lang:r.lang};
    case 'url': case 'absolute-url': return {type:r.recordType,data:text()};
    case 'mime': return {type:'mime',mediaType:r.mediaType,data:/^(text\/|application\/json)/.test(r.mediaType||'') ? text() : hex()};
    default: return {type:r.recordType,data:hex()};
  }
}
function nfcStop(n){
  n.scanning=false;
  if(n.abort){ try{ n.abort.abort(); }catch(e){} n.abort=null; }
  n.reader=null; n.status='stopped';
}
async function nfcScan(n){
  nfcStop(n);
  if(typeof NDEFReader==='undefined'){ n.status='Web NFC unavailable (needs Chrome on Android over https)'; return; }
  try{
    const r=new NDEFReader(); n.reader=r; n.abort=new AbortController();
    r.onreading=e=>{
      const recs=(e.message && e.message.records||[]).map(nfcDecode);
      n.tags++; n.serial=e.serialNumber||''; n.recs=recs;
      n.q.push({serial:n.serial,recs}); if(n.q.length>500) n.q.shift();
    };
    r.onreadingerror=()=>{ n.status='tag found but cannot be read (not NDEF or another format)'; };
    await r.scan({signal:n.abort.signal});
    n.scanning=true; n.status='scanning — hold a tag to the phone';
  }catch(e){ n.scanning=false; n.status=e.name==='NotAllowedError' ? 'permission denied (allow NFC for the site)' : e.name==='NotSupportedError' ? 'NFC is off or not available on this device' : 'error: '+e.message; }
}
async function nfcWrite(n,text){
  if(typeof NDEFReader==='undefined'){ n.status='Web NFC unavailable (needs Chrome on Android over https)'; return; }
  if(n.writing) return;
  const data=String(text||n.p.wtext||''); if(!data){ n.status='nothing to write'; return; }
  n.writing=true; n.status='hold a tag to the phone to write…';
  try{
    const w=n.reader || new NDEFReader();
    const rec=n.p.wtype==='url' ? {recordType:'url',data} : n.p.wtype==='json' ? {recordType:'mime',mediaType:'application/json',data:new TextEncoder().encode(data)} : {recordType:'text',data};
    await w.write({records:[rec]},{overwrite:!!n.p.overwrite,signal:AbortSignal.timeout(30000)});
    n.wrote++; n.status='written: '+data.slice(0,60);
  }catch(e){ n.status=e.name==='NotAllowedError' ? 'write refused (permission)' : e.name==='AbortError' || e.name==='TimeoutError' ? 'write timed out — no tag' : 'write error: '+e.message; }
  n.writing=false;
}
def({ id:'nfc', title:'NFC (Web NFC)', cat:'Sources', kw:'nfc ndef tag card rfid read write android phone',
  ins:[{n:'write',t:'txt'},{n:'go',t:'num'}], outs:[{n:'serial',t:'txt'},{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'new',t:'num'}], readout:true, tall:true,
  params:[{n:'scan',t:'button',label:'Scan',fn:n=>nfcScan(n)},
          {n:'stop',t:'button',label:'Stop',fn:n=>nfcStop(n)},
          {n:'wtext',t:'text',d:'',label:'write: text (the `write` input overrides it)'},
          {n:'wtype',t:'select',opts:['text','url','json'],d:'text',label:'write: record type (json — MIME application/json)'},
          {n:'overwrite',t:'check',d:true,label:'write: replace the tag content'},
          {n:'wnow',t:'button',label:'Write',fn:n=>{ n.fire=1; }}],
  init:n=>{ n.reader=null; n.abort=null; n.scanning=false; n.writing=false; n.q=[]; n.tags=0; n.wrote=0; n.serial=''; n.recs=[]; n.fire=0; n.prevGo=0;
            n.status='not started — press Scan'; },
  dispose:n=>{ nfcStop(n); },
  process(n,I){
    const go=(I.go||0)>.5; if(go && !n.prevGo) n.fire=1; n.prevGo=go;
    if(n.fire){ n.fire=0; nfcWrite(n,typeof I.write==='string' ? I.write : ''); }
    let o={serial:null,text:null,rec:null,new:0};
    if(n.q.length){
      const t=Date.now(), rec=[];
      let text=null, serial=null;
      for(const m of n.q.splice(0)){
        serial=m.serial;
        if(!m.recs.length) rec.push({t,serial:m.serial,type:'empty',data:''});
        for(const r of m.recs){ rec.push({t,serial:m.serial,...r}); if(text===null && (r.type==='text' || r.type==='url' || r.type==='absolute-url' || r.type==='mime')) text=r.data; }
      }
      o={serial,text,rec,new:1};
    }
    return o;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.tags ? ' · tags '+n.tags : '')+(n.wrote ? ' · written '+n.wrote : '')+(n.serial ? '\n'+n.serial+(n.recs.length ? '\n'+n.recs.map(x=>x.type+': '+String(x.data).slice(0,80)).join('\n') : '') : '');
    if(r.textContent!==t) r.textContent=t; }
});
