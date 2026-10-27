"use strict";
/* Phone Actions: команды приложения DSP (tools/android) и разбор его записей. Без DOM — проверяется в tools/test-phoneact.mjs */

const PHONE_ACTIONS=['notify','torch on','torch off','vibrate','vibrate stop','sms.send','sms.data','sms.send_raw','sms.list','contacts.find','ir.info','crash.last'];

// адрес моста; в приложении к адресу этого телефона добавляется ключ приложения (?k=…) — с ним открыты SMS и контакты
function phoneUrl(url,key){
  let u; try{ u=new URL(String(url||'').trim()); }catch(e){ return ''; }
  if(u.protocol!=='ws:' && u.protocol!=='wss:') return '';
  if(key && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname) && !u.searchParams.has('k')) u.searchParams.set('k',key);
  return u.toString();
}

// какие источники просить: входящие SMS, нажатия на уведомления, состояние фонаря
function phoneSub(p){ return ['sms','notify','torch'].filter(k=>p[{sms:'smsIn',notify:'notifyEv',torch:'torchState'}[k]]); }

// кнопки уведомления «Open, Snooze» → [{id:'open',label:'Open'},…]; id — по подписи, он придёт в записи {src:'notify', action}
function phoneButtons(s){
  const seen=new Set(), out=[];
  for(const part of String(s||'').split(',')){
    const label=part.trim(); if(!label) continue;
    let id=label.toLowerCase().replace(/[^a-z0-9а-яё]+/gi,'_').replace(/^_+|_+$/g,'')||'a'+out.length;
    while(seen.has(id)) id+='_';
    seen.add(id); out.push({id,label});
    if(out.length>=3) break;                                  // Android показывает до трёх кнопок
  }
  return out;
}

// команда по параметрам узла; textIn — текст с входа text (если подключён) вместо поля body
function phoneCmd(p,textIn){
  const text=textIn!=null && textIn!=='' ? String(textIn) : String(p.body||'');
  switch(p.action){
    case 'notify': return {cmd:'notify', title:String(p.title||'DSP'), text, actions:phoneButtons(p.buttons), open:!!p.open};
    case 'torch on': return {cmd:'torch', on:true, ...(+p.level>0 ? {level:+p.level} : {})};
    case 'torch off': return {cmd:'torch', on:false};
    case 'vibrate': return {cmd:'vibrate', ms:+p.vibMs||200, ...(+p.vibAmp>0 ? {amp:+p.vibAmp} : {})};
    case 'vibrate stop': return {cmd:'vibrate.stop'};
    case 'sms.send': return {cmd:'sms.send', to:String(p.to||'').trim(), text};
    case 'sms.data': return {cmd:'sms.data', to:String(p.to||'').trim(), hex:String(p.dataHex||'').replace(/[^0-9a-f]/ig,'').toLowerCase(), port:+p.dport||2948};
    case 'sms.send_raw': return {cmd:'sms.send_raw', pdu:String(p.rawPdu||textIn||'').replace(/[^0-9a-f]/ig,'').toLowerCase(), smsc:String(p.rawSmsc||'').replace(/[^0-9a-f]/ig,'').toLowerCase()};
    case 'sms.list': return {cmd:'sms.list', box:p.box||'all', q:String(p.q||''), limit:+p.limit||50};
    case 'contacts.find': return {cmd:'contacts.find', q:String(p.q||''), limit:+p.limit||50};
    case 'ir.info': return {cmd:'ir.info'};
    case 'crash.last': return {cmd:p.action};
  }
  return null;
}

// ИК: строка «F:38000 9000 4500 …» (или другой формат узлов IR) → команда; parse — irParse из ir-kernels.js
function phoneIrCmd(raw,parse){
  const r=parse(raw); if(!r || !r.dur || r.dur.length<2) return null;
  return {cmd:'ir.send', freq:r.freq||38000, pattern:r.dur.map(x=>Math.max(1,Math.round(x)))};
}

// запись моста → строка для readout и значения выходов
function phoneLine(r){
  switch(r.src){
    case 'cmd': return r.cmd+(r.ok ? ' ok' : ' failed: '+(r.msg||r.err||''))+(r.n!=null ? ' · '+r.n : '')+(r.nid!=null ? ' · nid '+r.nid : '');
    case 'sms': return 'sms '+(r.dir==='in' ? 'from ' : 'to ')+(r.addr||'?')+': '+String(r.body||'').slice(0,80);
    case 'contact': return 'contact '+(r.name||'?')+' '+((r.phones||[]).join(', '));
    case 'notify': return 'notification '+r.nid+': '+r.action;
    case 'torch': return 'torch '+(r.on ? 'on' : 'off');
    case 'bridge': return r.level+': '+r.msg;
  }
  return r.src+'';
}
