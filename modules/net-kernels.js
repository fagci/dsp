"use strict";
/* ============================ Сеть: общее ядро ============================
   Разбор тела ответа (JSON / текст) для HTTP In и SSE In. Без DOM и сети — проверяется отдельно. */

// путь «a.b.0.c» или «a.b[0].c»; пустой путь — сам объект
function netPath(o,path){
  const p=String(path||'').trim(); if(!p) return o;
  for(const k of p.replace(/\[(\d+)\]/g,'.$1').split('.')){
    if(k==='') continue;
    if(o==null || typeof o!=='object') return undefined;
    o=o[k];
  }
  return o;
}
// число из значения: число, числовая строка, булево; иначе null
function netNum(v){
  if(typeof v==='number') return Number.isFinite(v) ? v : null;
  if(typeof v==='boolean') return v ? 1 : 0;
  if(typeof v==='string' && v.trim()!=='' && Number.isFinite(+v)) return +v;
  return null;
}
// вложенный объект → плоский, ключи через точку; массивы остаются строкой JSON
function netFlat(o,pre,out){
  out=out||{};
  for(const k of Object.keys(o)){
    const v=o[k], key=pre ? pre+'.'+k : k;
    if(v && typeof v==='object' && !Array.isArray(v)) netFlat(v,key,out);
    else out[key]=Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
// тело ответа → {text, val, rec}: val — число из field (или всё тело, если оно число), rec — записи по пути records
function netParse(text,field,records,t,extra){
  let val=null, rec=null;
  const s=String(text).trim();
  if(s!=='' && Number.isFinite(+s)) val=+s;
  if(s[0]==='{' || s[0]==='['){
    try{
      const j=JSON.parse(s);
      if(String(field||'').trim()) val=netNum(netPath(j,field));
      const r=netPath(j,records);
      const list=Array.isArray(r) ? r : (r && typeof r==='object' ? [r] : []);
      rec=list.map(o=>({t,...(extra||{}),...(o && typeof o==='object' && !Array.isArray(o) ? netFlat(o) : {value:o})}));
    }catch(e){}
  }
  if(!rec) rec=[{t,...(extra||{}),...(val!==null ? {value:val} : {text:s})}];
  return {text:String(text),val,rec};
}
// «Name: value» через «;» или перевод строки
function netHeaders(s){
  const h={};
  for(const line of String(s||'').split(/[\n;]/)){
    const i=line.indexOf(':'); if(i>0) h[line.slice(0,i).trim()]=line.slice(i+1).trim(); }
  return h;
}

// Server-Sent Events: push(строка) → готовые события {event, data, id}; кусок может резать строку, CRLF / LF / CR
class SseParser{
  constructor(){ this.buf=''; this.ev=''; this.data=[]; this.id=''; this.retry=null; }
  push(chunk){
    this.buf+=chunk; const out=[];
    let m;
    while((m=/\r\n|\n|\r(?!$)/.exec(this.buf))){
      const line=this.buf.slice(0,m.index); this.buf=this.buf.slice(m.index+m[0].length);
      if(line===''){
        if(this.data.length) out.push({event:this.ev||'message',data:this.data.join('\n'),id:this.id});
        this.ev=''; this.data=[]; continue;
      }
      if(line[0]===':') continue;
      const i=line.indexOf(':'), f=i<0 ? line : line.slice(0,i);
      let v=i<0 ? '' : line.slice(i+1); if(v[0]===' ') v=v.slice(1);
      if(f==='data') this.data.push(v);
      else if(f==='event') this.ev=v;
      else if(f==='id') this.id=v;
      else if(f==='retry' && /^\d+$/.test(v)) this.retry=+v;
    }
    return out;
  }
}
