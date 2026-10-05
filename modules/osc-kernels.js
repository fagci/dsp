"use strict";
/* ============================ OSC: ядро ============================
   Open Sound Control 1.0: сообщение = адрес, строка типов «,ifs…», аргументы (всё выровнено по 4 байта, числа big-endian); пакет «#bundle» —
   метка времени и вложенные элементы с длиной. Типы: i f s b h d t T F N I c r m. Без DOM и сети — проверяется отдельно. */

const OSC_TD=new TextDecoder(), OSC_TE=new TextEncoder();
const oscPad=n=>(4-(n&3))&3;
function oscStr(s){ const b=OSC_TE.encode(s); const o=new Uint8Array(b.length+1+oscPad(b.length+1)); o.set(b); return o; }
function oscConcat(parts){ let n=0; for(const p of parts) n+=p.length; const o=new Uint8Array(n); let k=0; for(const p of parts){ o.set(p,k); k+=p.length; } return o; }
// args: [{t:'i'|'f'|'s'|'d'|'h'|'T'|'F'|'N'|'b', v}] → пакет
function oscEncode(addr,args){
  if(typeof addr!=='string' || addr[0]!=='/') throw new Error('OSC address must start with /');
  const tags=[','], bodies=[];
  for(const a of args||[]){
    tags.push(a.t);
    const dv=(len,fn)=>{ const b=new Uint8Array(len); fn(new DataView(b.buffer)); return b; };
    if(a.t==='i') bodies.push(dv(4,d=>d.setInt32(0,a.v|0)));
    else if(a.t==='f') bodies.push(dv(4,d=>d.setFloat32(0,a.v)));
    else if(a.t==='d') bodies.push(dv(8,d=>d.setFloat64(0,a.v)));
    else if(a.t==='h') bodies.push(dv(8,d=>d.setBigInt64(0,BigInt(a.v))));
    else if(a.t==='s') bodies.push(oscStr(String(a.v)));
    else if(a.t==='b'){ const b=a.v, o=new Uint8Array(4+b.length+oscPad(b.length)); new DataView(o.buffer).setInt32(0,b.length); o.set(b,4); bodies.push(o); }
    else if(!'TFNI'.includes(a.t)) throw new Error('OSC type '+a.t);
  }
  return oscConcat([oscStr(addr),oscStr(tags.join('')),...bodies]);
}
// пакет → [{addr, args:[{t,v}]}] (бандл раскрывается); ошибка в одном элементе не роняет остальные
function oscDecode(b){
  const out=[];
  if(!(b instanceof Uint8Array)) b=new Uint8Array(b);
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const str=p=>{ let e=p; while(e<b.length && b[e]!==0) e++; if(e>=b.length) throw new Error('unterminated string'); const s=OSC_TD.decode(b.subarray(p,e)); return [s,p+((e-p+4)&~3)]; };
  if(b.length>=8 && OSC_TD.decode(b.subarray(0,7))==='#bundle'){
    let p=16;
    while(p+4<=b.length){
      const len=dv.getInt32(p); p+=4;
      if(len<=0 || p+len>b.length) break;
      try{ out.push(...oscDecode(b.subarray(p,p+len))); }catch(e){}
      p+=len;
    }
    return out;
  }
  let [addr,p]=str(0);
  if(addr[0]!=='/') throw new Error('not an OSC message');
  const args=[];
  if(p<b.length){
    let tags; [tags,p]=str(p);
    if(tags[0]===',') for(const t of tags.slice(1)){
      if(t==='i'){ args.push({t,v:dv.getInt32(p)}); p+=4; }
      else if(t==='f'){ args.push({t,v:dv.getFloat32(p)}); p+=4; }
      else if(t==='d'){ args.push({t,v:dv.getFloat64(p)}); p+=8; }
      else if(t==='h'){ args.push({t,v:Number(dv.getBigInt64(p))}); p+=8; }
      else if(t==='t'){ args.push({t,v:dv.getUint32(p)+dv.getUint32(p+4)/4294967296}); p+=8; }
      else if(t==='s' || t==='S'){ let s; [s,p]=str(p); args.push({t:'s',v:s}); }
      else if(t==='b'){ const n=dv.getInt32(p); args.push({t,v:b.slice(p+4,p+4+n)}); p+=4+n+oscPad(n); }
      else if(t==='c'){ args.push({t,v:String.fromCharCode(dv.getInt32(p))}); p+=4; }
      else if(t==='r' || t==='m'){ args.push({t,v:dv.getUint32(p)}); p+=4; }
      else if(t==='T') args.push({t,v:1}); else if(t==='F') args.push({t,v:0});
      else if(t==='N') args.push({t,v:null}); else if(t==='I') args.push({t,v:Infinity});
      else throw new Error('OSC type '+t);
    }
  }
  out.push({addr,args}); return out;
}
// «/a 1 2.5 hello "two words"» → {addr, args}: целые — i, дробные — f, true / false — T / F, остальное — строка
function oscFromText(s){
  const toks=[]; String(s).trim().replace(/"([^"]*)"|(\S+)/g,(_,q,w)=>{ toks.push(q!==undefined ? {q} : {w}); return ''; });
  if(!toks.length || toks[0].q!==undefined || toks[0].w[0]!=='/') return null;
  const args=toks.slice(1).map(t=>{
    if(t.q!==undefined) return {t:'s',v:t.q};
    if(/^-?\d+$/.test(t.w) && Math.abs(+t.w)<=2147483647) return {t:'i',v:+t.w};
    if(/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t.w)) return {t:'f',v:+t.w};
    if(t.w==='true') return {t:'T'}; if(t.w==='false') return {t:'F'};
    return {t:'s',v:t.w};
  });
  return {addr:toks[0].w,args};
}
const oscArgText=a=>a.t==='b' ? '<'+a.v.length+' bytes>' : a.t==='T' ? 'true' : a.t==='F' ? 'false' : a.t==='N' ? 'nil' : String(a.v);
function oscToText(m){ return m.addr+m.args.map(a=>' '+(a.t==='s' && /[\s"]/.test(a.v) ? '"'+a.v+'"' : oscArgText(a))).join(''); }
// OSC-шаблон адреса (? * [] {}) → RegExp; фильтр узла — «префикс» или шаблон
function oscMatch(pattern,addr){
  const p=String(pattern||'').trim(); if(!p || p==='/' ) return true;
  if(!/[?*\[\]{}]/.test(p)) return addr===p || addr.startsWith(p.replace(/\/?$/,'/'));
  const re=p.replace(/[.+^$()|\\]/g,'\\$&').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]').replace(/\{([^}]*)\}/g,(_,x)=>'('+x.split(',').join('|')+')');
  try{ return new RegExp('^'+re+'$').test(addr); }catch(e){ return false; }
}
