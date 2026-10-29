"use strict";
/* ============================ Traceroute / MTR: чистая логика (без DOM) ============================
   Мост приложения (net.trace) отдаёт записи по одному узлу пути; здесь — статистика по узлам (как у mtr), текстовая таблица
   и записи для графа (с адресом предыдущего узла). Проверка: node tools/test-traceroute.mjs */

function trcNew(){ return {hops:new Map(),reached:false,rounds:0}; }
// r: {hop, ip, ms, ok, final} — одна проба
function trcAdd(st,r){
  const hop=+r.hop; if(!(hop>0)) return;
  let h=st.hops.get(hop);
  if(!h){ h={hop,ip:'',ips:[],sent:0,recv:0,timed:0,sum:0,last:null,best:null,worst:null}; st.hops.set(hop,h); }
  h.sent++;
  if(r.ok && r.ip){
    h.recv++; h.ip=r.ip; if(!h.ips.includes(r.ip)) h.ips.push(r.ip);
    const ms=+r.ms;
    if(Number.isFinite(ms)){ h.timed++; h.sum+=ms; h.last=ms; h.best=h.best==null ? ms : Math.min(h.best,ms); h.worst=h.worst==null ? ms : Math.max(h.worst,ms); }
  }
  if(r.final) st.reached=true;
}
const trcR=(v,d)=>v==null ? null : Math.round(v*d)/d;
function trcRows(st,host){                           // по строке на узел: для Table (ключ id) — живая таблица mtr
  return [...st.hops.values()].sort((a,b)=>a.hop-b.hop).map(h=>({src:'trace',ev:'stat',id:host+'#'+h.hop,host,hop:h.hop,ip:h.ip,
    sent:h.sent,recv:h.recv,loss:trcR(100*(h.sent-h.recv)/h.sent,10),last:trcR(h.last,100),avg:h.timed ? trcR(h.sum/h.timed,100) : null,best:trcR(h.best,100),worst:trcR(h.worst,100),
    changed:h.ips.length>1 ? h.ips.join(' ') : undefined}));
}
function trcText(st,host){
  const rows=trcRows(st,host), pad=(s,n)=>String(s).padEnd(n), num=(v,n)=>(v==null ? '—' : String(v)).padStart(n);
  const out=['traceroute to '+host+(st.rounds>1 ? ' · '+st.rounds+' rounds' : ''),pad('hop',4)+pad('address',18)+num('loss%',6)+num('snt',5)+num('last',8)+num('avg',8)+num('best',8)+num('wrst',8)];
  for(const r of rows) out.push(pad(r.hop,4)+pad(r.ip||'*',18)+num(r.loss,6)+num(r.sent,5)+num(r.last,8)+num(r.avg,8)+num(r.best,8)+num(r.worst,8)+(r.changed ? '  ('+r.changed+')' : ''));
  if(!st.reached) out.push('(the destination did not answer)');
  return out.join('\n');
}
// запись для Rec → Entities: узел пути с адресом предыдущего узла (первый — Phone); молчащие узлы только считаются в gap
// ctx — {prev, gap}, живёт один проход
function trcHopRec(ctx,host,r,round){
  const ok=r.ok===1 || r.ok===true || r.ok==='1';
  const rec={src:'trace',ev:'hop',host,hop:+r.hop,ok:ok ? 1 : 0,final:(r.final===1 || r.final===true || r.final==='1') ? 1 : 0,round};
  if(ok && r.ip){ rec.ip=r.ip; if(r.ms!=null) rec.ms=+r.ms; rec.prev=ctx.prev; rec.gap=ctx.gap; ctx.prev=r.ip; ctx.gap=0; }
  else ctx.gap++;
  if(r.unreachable) rec.unreachable=1;
  return rec;
}
const trcCtx=()=>({prev:'Phone',gap:0});
