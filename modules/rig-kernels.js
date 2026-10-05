"use strict";
/* ============================ rigctl: ядро ============================
   Протокол Hamlib rigctld, расширенный формат ответа («+» перед командой): каждый ответ — строка «имя:», строки «Ключ: значение»
   и «RPRT n». Поток режется как попало (мост TCP↔WebSocket), поэтому разбор копит буфер. Без DOM и сети. */

class RigParser{
  constructor(){ this.buf=''; this.cur=null; }
  // кусок текста → готовые ответы {name, args, f:{Ключ:значение}, rprt}
  push(chunk){
    this.buf+=chunk; const out=[];
    let i;
    while((i=this.buf.indexOf('\n'))>=0){
      const line=this.buf.slice(0,i).replace(/\r$/,''); this.buf=this.buf.slice(i+1);
      if(line==='') continue;
      const m=/^RPRT\s+(-?\d+)/.exec(line);
      if(m){ const r=this.cur || {name:'',args:'',f:{}}; r.rprt=+m[1]; out.push(r); this.cur=null; continue; }
      if(!this.cur){
        const h=/^([a-z_]+):\s*(.*)$/.exec(line);
        this.cur={name:h ? h[1] : '',args:h ? h[2] : '',f:{}};
        if(h) continue;                                  // заголовок «get_freq:»; иначе первая строка сама поле
      }
      const kv=/^([^:]+):\s*(.*)$/.exec(line);
      if(kv) this.cur.f[kv[1].trim()]=kv[2].trim();
    }
    return out;
  }
}
const RIG_MODES=['USB','LSB','CW','CWR','AM','FM','WFM','RTTY','RTTYR','PKTUSB','PKTLSB','PKTFM','AMS','ECSSUSB','ECSSLSB','FAX','SAM','SAL','SAH','DSB'];
// команды (расширенный формат)
const rigGetFreq=()=>'+f\n', rigGetMode=()=>'+m\n', rigGetLevel=name=>'+l '+name+'\n', rigGetPtt=()=>'+t\n';
const rigSetFreq=hz=>'+F '+Math.round(hz)+'\n';
const rigSetMode=(mode,pb)=>'+M '+mode+' '+(Math.round(pb)||0)+'\n';
const rigSetPtt=on=>'+T '+(on ? 1 : 0)+'\n';
// «Frequency: 14074000» → Гц; «USB»; уровень; PTT — из разобранного ответа
function rigReply(r){
  const o={};
  if(r.name==='get_freq' && 'Frequency' in r.f){ const v=+r.f.Frequency; if(Number.isFinite(v)) o.freq=v; }
  else if(r.name==='get_mode' && 'Mode' in r.f){ o.mode=r.f.Mode; const p=+r.f.Passband; if(Number.isFinite(p)) o.pb=p; }
  else if(r.name==='get_level'){ const k=Object.keys(r.f).find(k=>/value/i.test(k)); const v=k ? +r.f[k] : NaN; if(Number.isFinite(v)) o.level=v; }
  else if(r.name==='get_ptt' && 'PTT' in r.f) o.ptt=+r.f.PTT ? 1 : 0;
  return o;
}
