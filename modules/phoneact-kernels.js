"use strict";
/* Phone Actions: команды приложения DSP (tools/android) и разбор его записей. Без DOM — проверяется в tools/test-phoneact.mjs */

const PHONE_ACTIONS=['notify','torch on','torch off','vibrate','vibrate stop','sms.send','sms.data','sms.send_raw','sms.list','contacts.find','ir.info','crash.last','alarm.set','alarm.remove','alarm.list','alarm.stop','alarm.snooze','alarm.test','boot.set','boot.list','boot.run','boot.stop','cal.calendars','cal.list','cal.add','cal.remove','rec.start','rec.stop','rec.status','rec.list','rec.read','rec.delete','rec.export','callrec.set','callrec.status','callrec.stop'];

// адрес моста; в приложении к адресу этого телефона добавляется ключ приложения (?k=…) — с ним открыты SMS и контакты
function phoneUrl(url,key){
  if(typeof gwUrl==='function' && String(url||'').trim()[0]==='@') url=gwUrl(url);          // «@имя» из списка устройств (Settings → Devices)
  let u; try{ u=new URL(String(url||'').trim()); }catch(e){ return ''; }
  if(u.protocol!=='ws:' && u.protocol!=='wss:') return '';
  if(key && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname) && !u.searchParams.has('k')) u.searchParams.set('k',key);
  return u.toString();
}

// какие источники просить: входящие SMS, нажатия на уведомления, состояние фонаря
function phoneSub(p){ return ['sms','notify','torch','sys'].filter(k=>p[{sms:'smsIn',notify:'notifyEv',torch:'torchState',sys:'alarmEv'}[k]]); }

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

// Время для календаря → мс; null — не время. «2026-11-02 09:30», «2026-11-02» (с полуночи), «9:30» / «tomorrow 9:30» (по часам телефона),
// «now», «+90m» / «+2h» / «+3d» (от base — от начала события для конца), число из 11+ цифр — уже мс.
function phoneWhen(s,base){
  s=String(s==null ? '' : s).trim().toLowerCase(); if(!s) return null;
  if(!(base>0)) base=Date.now();
  if(s==='now') return base;
  let m=/^\+(\d+(?:\.\d+)?)\s*(m|min|h|d)$/.exec(s);
  if(m) return base+Math.round(+m[1]*({m:6e4,min:6e4,h:36e5,d:864e5})[m[2]]);
  if(/^\d{11,}$/.test(s)) return +s;
  m=/^(today|tomorrow)?\s*(\d{1,2}):(\d{2})$/.exec(s);
  if(m){ if(+m[2]>23 || +m[3]>59) return null; const t=new Date(base); if(m[1]==='tomorrow') t.setDate(t.getDate()+1); t.setHours(+m[2],+m[3],0,0); return t.getTime(); }
  m=/^(\d{4})-(\d{2})-(\d{2})(?:[ t]+(\d{1,2}):(\d{2}))?$/.exec(s);
  if(m){ const y=+m[1], mo=+m[2]-1, d=+m[3], h=+(m[4]||0), mi=+(m[5]||0); if(h>23 || mi>59) return null;
    const t=new Date(y,mo,d,h,mi,0,0); return t.getFullYear()===y && t.getMonth()===mo && t.getDate()===d ? t.getTime() : null; }
  return null;
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
    // будильник живёт в приложении (AlarmManager): time «7:30», days «mon,wed» / weekdays / weekend / daily / пусто = один раз;
    // url — радио (http/https, .pls/.m3u/HLS), sample — запасной звук (путь, content://, адрес; default — системный рингтон, beep — встроенные бипы)
    case 'alarm.set': { const c={cmd:'alarm.set', name:String(p.alarmName||'').trim(), time:String(p.alarmTime||'7:00').trim(), days:String(p.alarmDays||'').trim(), label:String(p.alarmLabel||''),
      url:String(p.alarmUrl||'').trim(), sample:String(p.alarmSample||'default').trim()||'default', ramp:+p.alarmRamp||0, loadSec:+p.alarmLoad||12, snoozeMin:+p.alarmSnooze||9, maxMin:+p.alarmMax||15};
      if(+p.alarmVol>0) c.vol=+p.alarmVol; if(!c.name) delete c.name; return c; }
    case 'alarm.remove': return String(p.alarmName||'').trim() ? {cmd:'alarm.remove', name:String(p.alarmName).trim()} : {cmd:'alarm.remove', all:true};
    case 'alarm.list': case 'alarm.stop': case 'alarm.snooze': return {cmd:p.action};
    // патчи без окна после перезагрузки (приложение держит страницу в окне 1×1 пиксель): bootPatches — имена через «;»
    case 'boot.set': return {cmd:'boot.set', patches:String(p.bootPatches||'').trim()};
    case 'boot.run': case 'boot.stop': return String(p.bootPatches||'').trim() ? {cmd:p.action, name:String(p.bootPatches).trim()} : {cmd:p.action};
    case 'boot.list': return {cmd:'boot.list'};
    // запись из службы на диск без страницы (JSON Lines в папке приложения): recSubs — источники через запятую (sms, mic, pkt не пишутся);
    // rec.read возвращает записи файла обратно на rec (поле _t — время приёма), порциями: recOffset — с какого байта, ответ next / eof
    case 'rec.start': return {cmd:'rec.start', name:String(p.recName||'rec').trim()||'rec', subs:String(p.recSubs||'').trim(), ...(+p.recHz>0 ? {hz:+p.recHz} : {}), ...(+p.recWifi>0 ? {wifiEvery:+p.recWifi} : {}), ...(+p.recCell>0 ? {cellEvery:+p.recCell} : {}), ...(+p.recMax>0 ? {maxMb:+p.recMax} : {})};
    case 'rec.stop': case 'rec.status': case 'rec.list': return {cmd:p.action};
    case 'rec.read': return {cmd:'rec.read', file:String(p.recFile||'').trim(), offset:+p.recOffset||0, limit:+p.limit||500};
    case 'rec.delete': case 'rec.export': return {cmd:p.action, file:String(p.recFile||'').trim()};
    // запись звонков службой (WAV в папке записей): callMode auto / off; callSrc — auto (с root voice_call, иначе микрофон), voice_call / downlink / uplink (root), mic …
    case 'callrec.set': return {cmd:'callrec.set', mode:p.callMode==='off' ? 'off' : 'auto', ...(p.callSrc ? {src:String(p.callSrc)} : {}), ...(+p.callRate>0 ? {rate:+p.callRate} : {}), minSec:Math.max(0,+p.callMin||0)};
    case 'callrec.status': case 'callrec.stop': return {cmd:p.action};
    // календарь телефона (CalendarContract): calStart / calEnd — см. phoneWhen; calRemind — минуты до начала через запятую; calDays — окно списка от «сейчас»
    case 'cal.calendars': return {cmd:'cal.calendars'};
    case 'cal.list': { const now=Date.now(); return {cmd:'cal.list', from:now, to:now+(+p.calDays>0 ? +p.calDays : 7)*864e5, q:String(p.calQuery||'').trim(), limit:+p.limit||50, ...(+p.calId>0 ? {calendar:+p.calId} : {})}; }
    case 'cal.add': { const st=phoneWhen(p.calStart), en=phoneWhen(p.calEnd,st||undefined);
      const c={cmd:'cal.add', title:String(p.calTitle||'').trim(), allDay:!!p.calAllDay, where:String(p.calWhere||''), note:String(p.calNote||''), remind:String(p.calRemind||'').trim()};
      if(st) c.start=st; if(en && st && en>st) c.end=en; if(+p.calId>0) c.calendar=+p.calId; return c; }
    case 'cal.remove': return {cmd:'cal.remove', event:+p.calEvent||-1};
    case 'alarm.test': return {cmd:'alarm.test', ...(String(p.alarmName||'').trim() ? {name:String(p.alarmName).trim()} : {url:String(p.alarmUrl||'').trim(), sample:String(p.alarmSample||'default').trim()||'default', ramp:3})};
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
    case 'alarm': return 'alarm '+r.name+' '+r.time+' '+r.days+(r.enabled ? '' : ' (off)')+(r.label ? ' · '+r.label : '')+(r.url ? ' · radio' : '');
    case 'cal': return r.kind==='calendar' ? 'calendar '+r.id+' '+r.name+(r.account ? ' ('+r.account+')' : '')+(r.writable ? '' : ' · read only')
      : 'event '+r.id+' '+(r.allDay ? new Date(+r.start).toISOString().slice(0,10)+' all day' : new Date(+r.start).toLocaleString())+' · '+(r.title||'(no title)')+(r.where ? ' @ '+r.where : '');
    case 'recording': return r.kind==='file' ? 'file '+r.file+' · '+Math.round((r.bytes||0)/1024)+' kB'+(r.live ? ' · recording' : '')
      : 'recording '+(r.on ? 'ON' : 'off')+(r.file ? ' · '+r.file : '')+' · '+(r.lines||0)+' lines, '+Math.round((r.bytes||0)/1024)+' kB'+(r.err ? ' · '+r.err : '');
    case 'callrec': return 'call recording '+(r.mode==='off' ? 'off' : 'on · '+r.source+' '+r.rate+' Hz'+(r.root ? ' (root)' : ''))+(r.active ? ' · RECORDING '+(r.file||'') : '')+' · drops under '+r.minSec+' s';
    case 'boot': return 'patch '+r.name+(r.boot ? ' · on boot' : '')+(r.running ? ' · running' : ' · stopped');
    case 'sys': return String(r.ev||'').startsWith('alarm.') || String(r.ev||'').startsWith('boot.') || String(r.ev||'').startsWith('callrec.') ? r.ev+(r.id||r.name||r.file ? ' '+(r.id||r.name||r.file) : '')+(r.why ? ' · '+r.why : '')+(r.kind ? ' · '+r.kind : '') : 'sys '+r.ev;
    case 'bridge': return r.level+': '+r.msg;
  }
  return r.src+'';
}
