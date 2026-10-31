"use strict";
/* Phone Alarm Clock: сборка команд будильника приложения DSP (tools/android → Alarms.kt) и нормализация его записей.
   Без DOM — проверяется в tools/test-alarmclock.mjs. Адрес моста (и ключ приложения) — phoneUrl из phoneact-kernels.js. */

const AL_DAY_CODES=['mon','tue','wed','thu','fri','sat','sun'];
const AL_DAYS_OPTS=['weekdays','daily','weekend','once','custom'];

// строка дней для протокола приложения: weekdays / weekend / daily / '' (один раз) / 'mon,wed' (custom из поля)
function alDays(p){
  const sel=String(p.days||'weekdays');
  if(sel==='once') return '';
  if(sel!=='custom') return sel;
  const seen=[];
  for(const w of String(p.daysCustom||'').toLowerCase().split(/[^a-z]+/)){
    const c=w.slice(0,3);
    if(AL_DAY_CODES.includes(c) && !seen.includes(c)) seen.push(c);
  }
  return AL_DAY_CODES.filter(c=>seen.includes(c)).join(',');
}

// проверка времени «7:30» → [h,m] или null
function alTime(s){
  const m=/^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(String(s||''));
  if(!m) return null;
  const h=+m[1]; if(h>23) return null;
  return [h,+m[2]];
}

// команда alarm.set из параметров узла; error — понятное сообщение вместо отправки мусора в мост
function alSetCmd(p){
  const t=alTime(p.time);
  if(!t) return {error:'time: HH:MM, e.g. 7:30'};
  const days=alDays(p);
  if(String(p.days)==='custom' && !days) return {error:'custom days: mon,tue,wed…'};
  const url=String(p.stream||'').trim();
  if(url && !/^https?:\/\/.+/i.test(url)) return {error:'stream: http(s):// address of the radio'};
  const c={cmd:'alarm.set', name:String(p.name||'').trim(), time:t[0]+':'+String(t[1]).padStart(2,'0'), days,
    label:String(p.label||''), url, sample:String(p.sample||'default').trim()||'default',
    ramp:+p.ramp||0, loadSec:+p.loadSec||12, snoozeMin:+p.snoozeMin||9, maxMin:+p.maxMin||15};
  if(+p.vol>0) c.vol=+p.vol;
  if(!c.name) delete c.name;                              // приложение само назовёт по времени («a0730»)
  return c;
}

// включить/выключить строку списка: в alarm.set без остальных полей приложение берёт их из сохранённого будильника
const alToggleCmd=row=>({cmd:'alarm.set', name:row.name, enabled:!row.enabled});

// запись {src:'alarm',…} моста → строка списка узла
function alRow(r){
  return {name:String(r.name||''), time:String(r.time||''), days:String(r.days||''),
    label:String(r.label||''), url:String(r.url||''), sample:String(r.sample||''),
    enabled:r.enabled===true||r.enabled==='true', next:+r.next||0};
}

// запись моста → строка для readout (ответы cmd, строки списка alarm, события sys alarm.*); null — не наше
function alLine(r){
  switch(r.src){
    case 'cmd': return r.cmd+(r.ok ? ' ok' : ' failed: '+(r.msg||r.err||''))+(r.n!=null ? ' · '+r.n : '');
    case 'alarm': { const a=alRow(r); return a.time+' '+a.name+(a.days&&a.days!=='once' ? ' · '+a.days : '')+(a.enabled ? '' : ' (off)')+(a.label ? ' · '+a.label : ''); }
    case 'sys': return String(r.ev||'').startsWith('alarm.') ? r.ev+(r.id ? ' '+r.id : '')+(r.why ? ' · '+r.why : '')+(r.kind ? ' · '+r.kind : '') : null;
    case 'bridge': return r.level+': '+r.msg;
  }
  return null;
}

// сортировка списка по времени, потом по имени
const alSort=rows=>rows.slice().sort((a,b)=>a.time===b.time ? (a.name<b.name?-1:a.name>b.name?1:0) : a.time<b.time?-1:1);

// «in 6 h 12 min» от now (мс) до ts (мс); просроченное — ''
function alInText(ts,now){
  const d=Math.round((ts-now)/60000);
  if(d<0) return '';
  if(d<1) return 'in less than a minute';
  const h=Math.floor(d/60), m=d%60;
  return 'in '+(h ? h+' h'+(m?' '+m+' min':'') : d+' min');
}

// ближайший включённый: «07:00 · wake · weekdays · in 6 h 12 min» или ''
function alNextText(rows,now){
  const on=rows.filter(a=>a.enabled && a.next>0);
  if(!on.length) return '';
  const a=on.reduce((x,y)=>x.next<=y.next?x:y);
  return a.time+(a.name ? ' · '+a.name : '')+(a.days && a.days!=='once' ? ' · '+a.days : '')+' · '+alInText(a.next,now);
}
