"use strict";
/* VPN-монитор (приложение DSP, модуль DspVpnService): какое приложение куда ходит. Записи моста → строки для таблиц,
   агрегация по приложению, команды узла. Без TLS-перехвата — имя сервера только из DNS / SNI / HTTP Host, без расшифровки.
   Без DOM — проверяется в tools/test-vpnmon.mjs. */

// какие приложения идут через туннель
const VPN_MODES=['all apps','only these','all except these'];
const VPN_MODE_ID={'all apps':'all','only these':'only','all except these':'except'};
/* Выбор из строк таблицы (установленные приложения vpn.apps или сводка по приложениям из трафика) и из текста: пакеты или uid.
   У строки с pkgs берутся они все (общий uid), иначе pkg, иначе uid — мост сам превратит uid в пакеты. */
function vpnPicks(rows,text){
  const pk=new Set(), ud=new Set();
  for(const r of Array.isArray(rows) ? rows : []){
    if(!r || typeof r!=='object') continue;
    if(Array.isArray(r.pkgs) && r.pkgs.length) for(const x of r.pkgs) pk.add(String(x));
    else if(typeof r.pkg==='string' && r.pkg) pk.add(r.pkg);
    else if(r.uid!=null && r.uid!=='' && Number.isInteger(+r.uid) && +r.uid>=0) ud.add(+r.uid);
  }
  for(const t of String(text||'').split(/[,;\s]+/)){ if(!t) continue; if(/^\d+$/.test(t)) ud.add(+t); else pk.add(t); }
  return {apps:[...pk],uids:[...ud]};
}
// команда запуска/остановки/переключения полного потока пакетов; rows — выбор из таблицы. {error} — режим требует список, а его нет
function vpnCmd(action,p,rows){
  if(action==='start'){
    const mode=VPN_MODE_ID[p.mode]||'all', c={cmd:'vpn.start',packets:!!p.packets,mode};
    if(mode==='all') return c;
    const pick=vpnPicks(rows,p.apps);
    if(!pick.apps.length && !pick.uids.length) return {error:'pick the apps: fill «apps» or wire a Table with apps to «rows» (mode «'+p.mode+'»)'};
    if(pick.apps.length) c.apps=pick.apps; if(pick.uids.length) c.uids=pick.uids;
    return c;
  }
  if(action==='stop') return {cmd:'vpn.stop'};
  if(action==='packets') return {cmd:'vpn.packets',on:!!p.packets};
  if(action==='apps') return {cmd:'vpn.apps',system:!!p.system};
  return null;
}

const vpnApp=r=>r.app || (r.uid!=null ? 'uid '+r.uid : 'unknown');
const vpnEndpoint=r=>r.host ? r.host : r.dst;

// одна строка-сводка по записи — для Ticker / лога
function vpnLine(r){
  switch(r.ev){
    case 'state': return r.on ? 'VPN monitor is on' : 'VPN monitor is off'+(r.msg ? ' ('+r.msg+')' : '');
    case 'open': return vpnApp(r)+' → '+vpnEndpoint(r)+(r.dport!=null ? ':'+r.dport : '')+' ('+r.proto+')'+(r.l7 ? ' '+r.l7 : '');
    case 'close': return vpnApp(r)+' ✕ '+vpnEndpoint(r)+' — '+vpnFmtBytes(r.up)+' up, '+vpnFmtBytes(r.down)+' down';
    case 'stat': return vpnApp(r)+' ↔ '+vpnEndpoint(r)+' — '+vpnFmtBytes(r.up)+' up, '+vpnFmtBytes(r.down)+' down';
    case 'dns': return 'dns '+r.name+' → '+(r.ips||[]).join(', ');
    case 'summary': return r.open+' open · '+r.flows+' total · '+vpnFmtBytes(r.bytesUp)+' up, '+vpnFmtBytes(r.bytesDown)+' down';
    case 'pkt': return (r.dir==='out' ? '→ ' : '← ')+r.n+' B';
    default: return r.ev||'';
  }
}
const vpnFmtBytes=b=>{ b=+b||0; return b<1024 ? b+' B' : b<1048576 ? (b/1024).toFixed(1)+' KB' : b<1073741824 ? (b/1048576).toFixed(1)+' MB' : (b/1073741824).toFixed(2)+' GB'; };

// запись потока (open/stat/close) → строка для таблицы «Flows»
function vpnFlowRow(r){
  if(!['open','stat','close'].includes(r.ev)) return null;
  return {id:r.id,app:vpnApp(r),uid:r.uid??null,pkgs:r.pkgs||null,proto:r.proto,dst:r.dst,dport:r.dport,
    host:r.host||'',l7:r.l7||'',state:r.ev==='close' ? 'closed' : r.state,up:+r.up||0,down:+r.down||0,dur:+r.dur||0,t:r.t};
}

/* Агрегация по приложению: st — Map app → {app,uid,pkgs,flows,open,up,down,hosts:Set,last}. Возвращает затронутую строку (для diff-таблицы). */
function vpnAppAgg(st,r){
  if(!['open','stat','close'].includes(r.ev)) return null;
  const key=vpnApp(r);
  let a=st.get(key);
  if(!a){ a={id:key,app:key,uid:r.uid??null,pkgs:r.pkgs||null,flows:0,open:0,up:0,down:0,hostsSet:new Set(),last:r.t}; st.set(key,a); }
  if(r.ev==='open'){ a.flows++; a.open++; }
  else if(r.ev==='close') a.open=Math.max(0,a.open-1);
  if(r.host) a.hostsSet.add(r.host);
  // счётчики по разнице с прошлым значением этого потока (stat/close несут текущие суммарные up/down потока, не дельту)
  const prev=a._flowBytes||(a._flowBytes=new Map()), p=prev.get(r.id)||{up:0,down:0};
  a.up+=Math.max(0,(+r.up||0)-p.up); a.down+=Math.max(0,(+r.down||0)-p.down);
  prev.set(r.id,{up:+r.up||0,down:+r.down||0});
  if(r.ev==='close') prev.delete(r.id);
  a.last=r.t; a.hosts=[...a.hostsSet].slice(0,8).join(', ')+(a.hostsSet.size>8 ? ' …' : '');
  return a;
}
function vpnAppRow(a){ return {id:a.id,app:a.app,uid:a.uid,pkgs:a.pkgs,flows:a.flows,open:a.open,up:a.up,down:a.down,hosts:a.hosts,last:a.last}; }
