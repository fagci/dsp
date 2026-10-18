"use strict";
/* ============================ HEX Structure: ядро ============================
   Схема (JSON) описывает пакет: поля, порядок байт и бит, вложенные схемы, контрольные суммы.
   hexParse(схема, байты) → поля со смещениями; hexBuild(схема, значения) → байты.
   Без DOM, проверяется в Node: node tools/test-hex.mjs.

   Поле: {n, t, w, len, endian, fmt, enum, flags, when, calc, sub, ...}
   t: u8…u64 / i8…i64 (кратно 8 бит), f32 f64, bits (w бит), bytes (len), str (len, enc), rest, list, pad
   endian: 'be' | 'le' (поле или схема); bitorder схемы: 'msb' (первый бит — старший) | 'lsb' (802.11)
   len, count, when, e — выражения над ранее разобранными полями: (ihl-5)*4, type==0 && subtype==8
     имена: поле, sub.поле, список[0].поле; поле.$off / поле.$len — смещение (от начала схемы) и длина в байтах;
     _left — осталось байт (при разборе), _len — размер схемы в байтах (в calc)
   as — короткое имя поля в rec (первое найденное): body.ies[0].data.ssid → ssid
   enumBy + enums — enum зависит от другого поля: enumBy:'type', enums:{0:{…},1:{…}}
   scale/prec/unit — показать число умноженным (v*scale), значение остаётся целым
   xor — маска, накладываемая на сумму (DMR: CSBK 0xA5A5, PI 0x6969)
   calc: 'crc16-x25' | 'crc32' | 'inet16' | 'xor8' | 'sum8' | …  — контрольная сумма (from / to / over:'all')
         любая другая строка — выражение, значение пересчитывается при сборке (длины, ihl)
   sub: имя схемы | схема | {by:'выражение', map:{'17':'udp'}} — разбор вложенных байт */

const HEX_LIB={};                                   // имя → схема (формы заполняют hex-formats.js и пользователь)

/* ---------- выражения ---------- */
const HEX_EXPR=new Map();
const HEX_OPS={
  '||':(a,b)=>a||b?1:0, '&&':(a,b)=>a&&b?1:0, '|':(a,b)=>a|b, '^':(a,b)=>a^b, '&':(a,b)=>a&b,
  '==':(a,b)=>a==b?1:0, '!=':(a,b)=>a!=b?1:0, '<':(a,b)=>a<b?1:0, '<=':(a,b)=>a<=b?1:0, '>':(a,b)=>a>b?1:0, '>=':(a,b)=>a>=b?1:0,
  '<<':(a,b)=>a*Math.pow(2,b), '>>':(a,b)=>Math.floor(a/Math.pow(2,b)), '+':(a,b)=>a+b, '-':(a,b)=>a-b,
  '*':(a,b)=>a*b, '/':(a,b)=>b ? Math.trunc(a/b) : 0, '%':(a,b)=>b ? a%b : 0 };
const HEX_PREC=[['||'],['&&'],['|'],['^'],['&'],['==','!='],['<','<=','>','>='],['<<','>>'],['+','-'],['*','/','%']];
function hexExpr(src){
  let f=HEX_EXPR.get(src); if(f) return f;
  const T=String(src).match(/0x[0-9a-f]+|\d+|[A-Za-z_][\w.\[\]$]*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*\/%&|^~!<>?:()]/gi)||[];
  let i=0;
  const prim=()=>{
    const t=T[i++];
    if(t===undefined) throw new Error('expression ended early: '+src);
    if(t==='('){ const v=top(); if(T[i++]!==')') throw new Error('missing ) in '+src); return v; }
    if(/^(0x[0-9a-f]+|\d+)$/i.test(t)){ const v=Number(t); return ()=>v; }
    if(/^[A-Za-z_]/.test(t)) return e=>{ const v=e(t); return typeof v==='bigint' ? Number(v) : v===undefined ? 0 : v; };
    throw new Error('unexpected "'+t+'" in '+src);
  };
  const un=()=>{
    const t=T[i];
    if(t==='-'||t==='!'||t==='~'){ i++; const a=un(); return t==='-' ? e=>-a(e) : t==='!' ? e=>a(e)?0:1 : e=>~a(e); }
    return prim();
  };
  const bin=l=>{
    if(l>=HEX_PREC.length) return un();
    let a=bin(l+1);
    while(HEX_PREC[l].includes(T[i])){ const fn=HEX_OPS[T[i++]], x=a, y=bin(l+1); a=e=>fn(x(e),y(e)); }
    return a;
  };
  const top=()=>{
    const c=bin(0);
    if(T[i]==='?'){ i++; const a=top(); if(T[i++]!==':') throw new Error('missing : in '+src); const b=top(); return e=>c(e) ? a(e) : b(e); }
    return c;
  };
  f=top();
  if(i<T.length) throw new Error('extra "'+T[i]+'" in '+src);
  HEX_EXPR.set(src,f);
  return f;
}

/* ---------- контрольные суммы ---------- */
const HEX_CRC={
  'crc8':{w:8,poly:0x07,init:0,refin:0,refout:0,xorout:0},
  'crc8-maxim':{w:8,poly:0x31,init:0,refin:1,refout:1,xorout:0},
  'crc16-ccitt':{w:16,poly:0x1021,init:0,refin:0,refout:0,xorout:0},                 // XMODEM
  'crc16-ccitt-false':{w:16,poly:0x1021,init:0xFFFF,refin:0,refout:0,xorout:0},
  'crc16-x25':{w:16,poly:0x1021,init:0xFFFF,refin:1,refout:1,xorout:0xFFFF},         // HDLC, AX.25
  'crc16-gsm':{w:16,poly:0x1021,init:0,refin:0,refout:0,xorout:0xFFFF},                // P25 TSBK / DMR (до маски)
  'crc16-kermit':{w:16,poly:0x1021,init:0,refin:1,refout:1,xorout:0},
  'crc16-arc':{w:16,poly:0x8005,init:0,refin:1,refout:1,xorout:0},
  'crc16-modbus':{w:16,poly:0x8005,init:0xFFFF,refin:1,refout:1,xorout:0},
  'crc32':{w:32,poly:0x04C11DB7,init:0xFFFFFFFF,refin:1,refout:1,xorout:0xFFFFFFFF}, // Ethernet, 802.11 FCS
  'crc24-adsb':{w:24,poly:0xFFF409,init:0,refin:0,refout:0,xorout:0},                // Mode S / ADS-B
  'crc16-m17':{w:16,poly:0x5935,init:0xFFFF,refin:0,refout:0,xorout:0},                // M17 LSF / пакеты
  'crc32c':{w:32,poly:0x1EDC6F41,init:0xFFFFFFFF,refin:1,refout:1,xorout:0xFFFFFFFF} };
function hexReflect(v,w){ let r=0; for(let i=0;i<w;i++){ r=r*2+(v&1); v=Math.floor(v/2); } return r; }
function hexCrc(spec,d,a,b){
  const w=spec.w, mask=w===32 ? 0xFFFFFFFF : (1<<w)-1, top=Math.pow(2,w-1);
  let r=spec.init>>>0;
  for(let i=a;i<b;i++){
    let x=spec.refin ? hexReflect(d[i],8) : d[i];
    r=(r ^ (w>=8 ? x*Math.pow(2,w-8) : x>>(8-w)))>>>0;
    for(let k=0;k<8;k++){ const hi=(r&top)!==0; r=((r<<1)&mask)>>>0; if(hi) r=(r^spec.poly)>>>0; }
  }
  if(spec.refout) r=hexReflect(r,w);
  return ((r^spec.xorout)&mask)>>>0;
}
// имя → {w, f(d,a,b) → число}
function hexSum(name){
  if(HEX_CRC[name]){ const s=HEX_CRC[name]; return {w:s.w, f:(d,a,b)=>hexCrc(s,d,a,b)}; }
  if(name==='inet16') return {w:16, f:(d,a,b)=>{
    let s=0; for(let i=a;i<b;i+=2) s+=(d[i]<<8)|(i+1<b ? d[i+1] : 0);
    while(s>>>16) s=(s&0xFFFF)+(s>>>16);
    return (~s)&0xFFFF; }};
  if(name==='pocsag-bch') return {w:10, f:(d,a)=>{              // BCH(31,21) слова POCSAG: d[a..a+3], старшие 21 бит
    let r=(((d[a]<<24)|(d[a+1]<<16)|(d[a+2]<<8)|(d[a+3]&0)) & 0xFFFFF800)>>>0;
    r>>>=1;
    for(let i=30;i>=10;i--) if((r>>>i)&1) r=(r^(0x769<<(i-10)))>>>0;
    return r&0x3FF; }};
  if(name==='parity32') return {w:1, f:(d,a)=>{                  // чётность слова из 32 бит, сам бит — младший
    let x=((d[a]<<24)|(d[a+1]<<16)|(d[a+2]<<8)|(d[a+3]&0xFE))>>>0, p=0;
    while(x){ p^=1; x&=x-1; }
    return p; }};
  if(name==='xor8') return {w:8, f:(d,a,b)=>{ let x=0; for(let i=a;i<b;i++) x^=d[i]; return x; }};
  if(name==='sum8') return {w:8, f:(d,a,b)=>{ let x=0; for(let i=a;i<b;i++) x=(x+d[i])&255; return x; }};
  if(name==='sum8n') return {w:8, f:(d,a,b)=>{ let x=0; for(let i=a;i<b;i++) x=(x+d[i])&255; return (256-x)&255; }};
  return null;
}

/* ---------- биты и целые ---------- */
const HEX_INT=/^([ui])(\d+)$/;
function hexBitsGet(d,pos,w,order){
  if(w>53){ let v=0n; for(let k=0;k<w;k++){ const p=pos+k, bit=BigInt(order==='lsb' ? (d[p>>3]>>(p&7))&1 : (d[p>>3]>>(7-(p&7)))&1); v=order==='lsb' ? v|(bit<<BigInt(k)) : (v<<1n)|bit; } return v; }
  let v=0;
  for(let k=0;k<w;k++){
    const p=pos+k;
    if(order==='lsb') v+=((d[p>>3]>>(p&7))&1)*Math.pow(2,k);
    else v=v*2+((d[p>>3]>>(7-(p&7)))&1);
  }
  return v;
}
function hexBitsSet(a,pos,w,val,order){
  const big=typeof val==='bigint' || w>53, bv=big ? BigInt(val) : 0n;
  for(let k=0;k<w;k++){
    const p=pos+k, sh=order==='lsb' ? k : w-1-k;
    const bit=big ? Number((bv>>BigInt(sh))&1n) : Math.floor(val/Math.pow(2,sh))%2;
    const m=order==='lsb' ? 1<<(p&7) : 0x80>>(p&7), i=p>>3;
    while(a.length<=i) a.push(0);
    a[i]=bit ? a[i]|m : a[i]&~m&255;
  }
}
function hexIntGet(d,pos,w,endian){
  const n=w>>3, b=[]; for(let i=0;i<n;i++) b.push(d[(pos>>3)+i]);
  if(endian==='le') b.reverse();
  if(n>6){ let v=0n; for(const x of b) v=(v<<8n)|BigInt(x); return v; }
  let v=0; for(const x of b) v=v*256+x;
  return v;
}
function hexIntSet(a,pos,w,val,endian){
  const n=w>>3, b=new Array(n);
  let v=BigInt.asUintN(w,BigInt(typeof val==='bigint' ? val : Math.trunc(val)));
  for(let i=n-1;i>=0;i--){ b[i]=Number(v&255n); v>>=8n; }
  if(endian==='le') b.reverse();
  const o=pos>>3; while(a.length<o+n) a.push(0);
  for(let i=0;i<n;i++) a[o+i]=b[i];
}
const hexSigned=(v,w)=>typeof v==='bigint'
  ? (v>=(1n<<BigInt(w-1)) ? v-(1n<<BigInt(w)) : v)
  : (v>=Math.pow(2,w-1) ? v-Math.pow(2,w) : v);
const hexNorm=v=>typeof v==='bigint' && v>=-9007199254740991n && v<=9007199254740991n ? Number(v) : v;

/* ---------- форматы значений ---------- */
const HEX_M17CS=' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.';
const HEX_FMT_EXT={}, HEX_UNFMT_EXT={};                          // форматы, добавленные другими файлами (hex-gsm.js): имя → функция
const HEX_FIXED={mac:6, ipv4:4, ipv6:16, plmn:3, m17call:6};
const hexByte=b=>b.toString(16).padStart(2,'0');
function hexToHex(b){ let s=''; for(const x of b) s+=hexByte(x); return s; }
function hexFromHex(s){
  s=String(s).replace(/0x/gi,'').replace(/[^0-9a-f]/gi,'');
  if(s.length&1) s='0'+s;
  const o=new Uint8Array(s.length>>1);
  for(let i=0;i<o.length;i++) o[i]=parseInt(s.substr(i*2,2),16);
  return o;
}
function hexFmtBytes(b,fmt){
  switch(fmt){
    case 'mac': return Array.from(b,hexByte).join(':');
    case 'ipv4': return Array.from(b).join('.');
    case 'ipv6': {
      const g=[]; for(let i=0;i+1<b.length;i+=2) g.push(((b[i]<<8)|b[i+1]).toString(16));
      let bs=-1,bl=0; for(let i=0;i<g.length;){ if(g[i]!=='0'){ i++; continue; } let j=i; while(j<g.length && g[j]==='0') j++; if(j-i>bl){ bs=i; bl=j-i; } i=j; }
      return bl>1 ? g.slice(0,bs).join(':')+'::'+g.slice(bs+bl).join(':') : g.join(':'); }
    case 'plmn': {                                         // MCC / MNC в BCD (TS 24.008 10.5.1.3): 3 байта → «250-01»
      const mcc=[b[0]&15,b[0]>>4,b[1]&15], mnc=[b[2]&15,b[2]>>4];
      if((b[1]>>4)!==15) mnc.push(b[1]>>4);
      return mcc.join('')+'-'+mnc.join(''); }
    case 'm17call': {                                       // позывной M17: основание 40, первый символ — младший
      let a=0n; for(const x of b) a=a*256n+BigInt(x);
      if(a===0xFFFFFFFFFFFFn) return 'BROADCAST';
      if(a>=0xEE6B28000000n) return '#'+hexToHex(b);
      let t=''; while(a){ t+=HEX_M17CS[Number(a%40n)]; a/=40n; }
      return t; }
    case 'ascii': return Array.from(b,x=>x>=32&&x<127 ? String.fromCharCode(x) : '.').join('');
    case 'bcd': return Array.from(b,hexByte).join('');
    default: return HEX_FMT_EXT[fmt] ? HEX_FMT_EXT[fmt](b) : hexToHex(b);
  }
}
function hexUnfmtBytes(v,fmt,len){
  if(v instanceof Uint8Array) return v;
  if(Array.isArray(v)) return Uint8Array.from(v);
  v=String(v);
  if(HEX_UNFMT_EXT[fmt]) return HEX_UNFMT_EXT[fmt](v,len);
  if(fmt==='ipv4') return Uint8Array.from(v.split('.').map(x=>(+x)&255));
  if(fmt==='ipv6'){
    const [a,b]=v.split('::'), pa=a ? a.split(':') : [], pb=b!==undefined && b ? b.split(':') : [];
    const g=b===undefined ? pa : pa.concat(new Array(Math.max(0,8-pa.length-pb.length)).fill('0'),pb);
    const o=new Uint8Array(16); g.slice(0,8).forEach((x,i)=>{ const n=parseInt(x||'0',16)||0; o[i*2]=n>>8; o[i*2+1]=n&255; });
    return o;
  }
  if(fmt==='plmn'){
    const [m,n]=v.split('-'), d=x=>+x||0, o=new Uint8Array(3);
    o[0]=d(m[0])|(d(m[1])<<4); o[1]=d(m[2])|((n&&n.length>2 ? d(n[2]) : 15)<<4); o[2]=d(n&&n[0])|(d(n&&n[1])<<4);
    return o;
  }
  if(fmt==='m17call'){
    const o=new Uint8Array(6);
    if(/^BROADCAST$/i.test(v)){ o.fill(255); return o; }
    if(v[0]==='#') return hexFromHex(v.slice(1)).slice(0,6);
    let a=0n; for(let i=Math.min(v.length,9)-1;i>=0;i--){ const k=HEX_M17CS.indexOf(v[i].toUpperCase()); a=a*40n+BigInt(k<0 ? 0 : k); }
    for(let i=5;i>=0;i--){ o[i]=Number(a&255n); a>>=8n; }
    return o;
  }
  if(fmt==='ascii') return Uint8Array.from(v,ch=>ch.charCodeAt(0)&255);
  return hexFromHex(v);
}
const hexEncStr=(s,enc)=>enc==='utf8' ? new TextEncoder().encode(s) : enc==='ucs2' ? Uint8Array.from(Array.from(s).flatMap(c=>[c.charCodeAt(0)>>8,c.charCodeAt(0)&255])) : Uint8Array.from(s,c=>c.charCodeAt(0)&255);
const hexDecStr=(b,enc)=>enc==='utf8' ? new TextDecoder().decode(b) : enc==='ucs2' ? Array.from({length:b.length>>1},(_,i)=>String.fromCharCode((b[2*i]<<8)|b[2*i+1])).join('') : Array.from(b,x=>String.fromCharCode(x)).join('');

function hexFmtInt(v,w,fmt){
  switch(fmt){
    case 'hex': return '0x'+v.toString(16).toUpperCase().padStart(Math.ceil(w/4),'0');
    case 'bin': return '0b'+v.toString(2).padStart(w,'0');
    case 'bcd': return v.toString(16);
    case 'dbm': return v+' dBm';
    case 'time': return new Date(Number(v)*1000).toISOString().replace('.000Z','Z');
    default: return String(v);
  }
}

/* ---------- схемы ---------- */
function hexSchema(s,lib){
  if(typeof s==='string'){ const x=(lib||HEX_LIB)[s]; if(!x) throw new Error('unknown schema: '+s); return x; }
  return s;
}
function hexSubOf(sub,env,lib){
  if(!sub) return null;
  if(typeof sub==='string') return (lib||HEX_LIB)[sub] || null;
  if(sub.fields) return sub;
  if(sub.by){
    const k=String(hexExpr(sub.by)(env)), m=sub.map||{};
    const name=m[k] ?? m[Number(k).toString(16)] ?? sub.default;
    return name ? hexSubOf(name,env,lib) : null;
  }
  return null;
}
const HEX_CS6='#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';
const HEX_SCALAR=new Set(['str6','bits','bytes','str','rest','list','pad','f32','f64']);
// проверка схемы для редактора JSON: список сообщений
function hexSchemaCheck(s,lib,path){
  const e=[]; path=path||'';
  if(!s || !Array.isArray(s.fields)){ e.push((path||'schema')+': "fields" array expected'); return e; }
  if(s.endian && s.endian!=='be' && s.endian!=='le') e.push(path+'endian: "be" or "le"');
  if(s.bitorder && s.bitorder!=='msb' && s.bitorder!=='lsb') e.push(path+'bitorder: "msb" or "lsb"');
  const seen=new Map();
  s.fields.forEach((f,i)=>{
    const p=path+(f&&f.n ? f.n : '#'+i);
    if(!f || typeof f!=='object'){ e.push(p+': object expected'); return; }
    const t=f.t||'u8', m=HEX_INT.exec(t);
    if(!(m && +m[2]%8===0 && +m[2]>0 && +m[2]<=64) && !HEX_SCALAR.has(t)) e.push(p+': unknown type "'+t+'"');
    if(t==='bits' && !(f.w>0)) e.push(p+': bits needs w');
    if(t==='bytes' && f.len==null && !HEX_FIXED[f.fmt]) e.push(p+': bytes needs len');
    if(f.n && t!=='pad'){ if(seen.has(f.n) && (!f.when || !seen.get(f.n))) e.push(p+': duplicate name'); seen.set(f.n,seen.get(f.n)===false ? false : !!f.when); }
    for(const k of ['when','len','count','e']) if(typeof f[k]==='string' && f[k]!=='rest'){ try{ hexExpr(f[k]); }catch(x){ e.push(p+'.'+k+': '+x.message); } }
    if(typeof f.sub==='string' && lib && !lib[f.sub] && !HEX_LIB[f.sub]) e.push(p+': unknown sub-schema "'+f.sub+'"');
    if(f.calc && typeof f.calc==='string' && !hexSum(f.calc)){ try{ hexExpr(f.calc); }catch(x){ e.push(p+'.calc: '+x.message); } }
  });
  return e;
}

/* ---------- общий обход: разбор и сборка ---------- */
function hexNames(c,prefix,name){
  // имя относительно текущей вложенности, затем выше, затем корень
  let p=prefix;
  for(;;){
    if(Object.prototype.hasOwnProperty.call(c.vals,p+name) || c.byName[p+name]) return p+name;
    if(!p) return null;
    const k=p.slice(0,-1).lastIndexOf('.');
    p=k<0 ? '' : p.slice(0,k+1);
  }
}
function hexLookup(c,prefix,ss,se){
  return name=>{
    if(name==='_left') return (c.end-c.bit)>>3;
    if(name==='_len') return se-ss;
    let k=hexNames(c,prefix,name);
    if(k!==null){ const v=c.vals[k]; return typeof v==='string' ? hexStrNum(v) : v; }
    const dot=name.lastIndexOf('.');
    if(dot>0){
      const base=hexNames(c,prefix,name.slice(0,dot)), r=base && c.byName[base], what=name.slice(dot+1);
      if(r && what==='$off') return (r.b0>>3)-ss;
      if(r && what==='$len') return (r.bl+7)>>3;
    }
    return undefined;
  };
}
const hexStrNum=s=>/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : /^0x[0-9a-f]+$/i.test(s) ? parseInt(s,16) : s;

function hexRun(sch,c,prefix,depth,limit){
  const saveEnd=c.end, saveBit0=c.bit&7 ? (c.bit+7)&~7 : c.bit;
  if(limit!=null) c.end=Math.min(c.end,limit);
  if(c.bit&7) c.bit=saveBit0;
  const ss=c.bit>>3, recs=[];
  const env=hexLookup(c,prefix,ss,0);
  for(const f of sch.fields){
    if(c.stop) break;
    if(f.when!=null){
      let ok=true;
      try{ ok=!!hexExpr(String(f.when))(env); }catch(e){ c.warn.push((f.n||'?')+'.when: '+e.message); }
      if(!ok) continue;
    }
    hexField(f,sch,c,prefix,depth,env,recs,ss);
  }
  const se=(c.bit+7)>>3;
  for(const r of recs){ r.ss=ss; r.se=se; r.prefix=prefix; }
  c.end=saveEnd;
}

function hexSub(f,env,c){
  let s=null;
  try{ s=hexSubOf(f.sub,env,c.lib); }catch(e){ c.warn.push((f.n||'?')+'.sub: '+e.message); }
  return s;
}

function hexField(f,sch,c,prefix,depth,env,recs,ss){
  if(f.enumBy){ let k; try{ k=hexExpr(String(f.enumBy))(env); }catch(e){} f=Object.assign({},f,{enum:(f.enums||{})[k]}); }
  const B=c.build, t=f.t||'u8', name=prefix+(f.n||''), order=sch.bitorder||'msb', endian=f.endian||sch.endian||'be';
  const N=(x,d)=>{ if(x==null) return d; if(typeof x==='number') return x; try{ return hexExpr(String(x))(env); }catch(e){ c.warn.push((f.n||'?')+': '+e.message); return d; } };
  const rec={n:name, name:f.n||'', t, depth, b0:0, bl:0, f, ss, se:0, prefix};
  const push=()=>{ recs.push(rec); c.recs.push(rec); if(f.n) c.byName[name]=rec; };
  const trunc=bits=>{
    if(B) return false;
    if(c.bit+bits<=c.end) return false;
    rec.b0=c.bit; rec.bl=Math.max(0,c.end-c.bit); rec.err='truncated'; push(); c.stop=true; c.trunc=true; return true;
  };
  let m;

  if(t==='pad'){
    const bits=f.w!=null ? f.w : N(f.len,0)*8;
    if(f.w==null && (c.bit&7)) c.bit=(c.bit+7)&~7;
    if(trunc(bits)) return;
    rec.b0=c.bit; rec.bl=bits; rec.pad=true; c.bit+=bits;
    if(B) hexEnsure(c.out,c.bit); push(); return;
  }
  if(t==='str6'){                                     // символы по 6 бит (позывной ADS-B / AIS)
    const cs=f.cs || HEX_CS6, nch=Math.max(0,Math.floor(N(f.len,0))), w=nch*6;
    if(trunc(w)) return;
    rec.b0=c.bit; rec.bl=w;
    let sv='';
    if(!B){
      for(let i=0;i<nch;i++) sv+=cs[hexBitsGet(c.d,c.bit+i*6,6,'msb')] || '?';
      if(f.trim) sv=sv.replace(new RegExp('['+(f.pad||'@').replace(/[\\\]^-]/g,'\\$&')+' ]+$'),'');
    } else {
      sv=c.vals[name]===undefined ? '' : String(c.vals[name]);
      if(c.vals[name]===undefined) c.warn.push(name+': no value, empty used');
      sv=sv.toUpperCase().padEnd(nch,f.pad||'_').slice(0,nch);
      for(let i=0;i<nch;i++){ const x=cs.indexOf(sv[i]); hexBitsSet(c.out,c.bit+i*6,6,x<0 ? cs.indexOf('_')>=0 ? cs.indexOf('_') : 0 : x,'msb'); }
      hexEnsure(c.out,c.bit+w);
    }
    c.vals[name]=sv; rec.value=sv; rec.text=sv; c.bit+=w; push();
    return;
  }
  if(t==='bits' || (m=HEX_INT.exec(t)) || t==='f32' || t==='f64'){
    let w;
    if(t==='bits') w=f.w;
    else if(m) w=+m[2];
    else w=t==='f32' ? 32 : 64;
    if(t!=='bits' && (c.bit&7)) c.bit=(c.bit+7)&~7;
    if(trunc(w)) return;
    rec.b0=c.bit; rec.bl=w;
    const aligned=(c.bit&7)===0 && (w&7)===0;
    const signed=t==='bits' ? !!f.signed : (m ? m[1]==='i' : false);
    let v;
    if(!B){
      if(t==='f32'||t==='f64'){
        const dv=new DataView(c.d.buffer,c.d.byteOffset+(c.bit>>3),w>>3);
        v=w===32 ? dv.getFloat32(0,endian==='le') : dv.getFloat64(0,endian==='le');
      } else {
        v=t!=='bits' || (aligned && f.endian==='le') ? hexIntGet(c.d,c.bit,w,endian) : hexBitsGet(c.d,c.bit,w,order);
        if(signed) v=hexSigned(v,w);
        v=hexNorm(v);
      }
      c.vals[name]=v; rec.value=v;
    } else {
      v=hexCoerceNum(c.vals[name],f);
      if(v===undefined){ c.warn.push(name+': no value, 0 used'); v=f.d!=null ? f.d : 0; }
      c.vals[name]=v; rec.value=v;
      hexPutNum(c.out,c.bit,w,v,t,f,endian,order,aligned);
    }
    c.bit+=w;
    rec.text=hexNumText(rec.value,w,f);
    push();
    return;
  }
  if(t==='bytes' || t==='str' || t==='rest'){
    if(c.bit&7) c.bit=(c.bit+7)&~7;
    const fixed=HEX_FIXED[f.fmt];
    let len;
    if(t==='rest') len=(c.end-c.bit)>>3;
    else len=f.len==='rest' ? (c.end-c.bit)>>3 : N(f.len,fixed||0);
    len=Math.max(0,Math.floor(len)||0);
    let bytes=null;
    if(B){
      const raw=c.vals[name], sub=raw===undefined ? hexSub(f,env,c) : null;
      if(raw!==undefined){
        bytes=t==='str' ? hexEncStr(String(raw),f.enc||'ascii') : hexUnfmtBytes(raw,f.fmt,len);
        if(typeof f.len==='number' || fixed){ const L=fixed||f.len, b2=new Uint8Array(L); b2.set(bytes.subarray(0,L)); bytes=b2; }
      } else if(sub){
        rec.b0=c.bit; rec.sub=true; push();
        const start=c.bit;
        c.vals[name]=undefined; delete c.vals[name];
        hexRun(sub,c,name+'.',depth+1,null);
        if(typeof f.len==='number'){ c.bit=Math.max(c.bit,start+f.len*8); hexEnsure(c.out,c.bit); }
        rec.bl=c.bit-start;
        return;
      } else {
        bytes=new Uint8Array(len); if(t!=='rest') c.warn.push(name+': no value, zeros used');
      }
      len=bytes.length;
      rec.b0=c.bit; rec.bl=len*8; rec.value=t==='str' ? hexDecStr(bytes,f.enc||'ascii') : hexFmtBytes(bytes,f.fmt==='ascii'||f.fmt==='bcd' ? f.fmt : f.fmt||'hex');
      for(let i=0;i<len;i++) c.out[(c.bit>>3)+i]=bytes[i];
      c.bit+=len*8; hexEnsure(c.out,c.bit);
      c.vals[name]=rec.value; rec.raw=bytes; push();
      return;
    }
    // разбор
    if(c.bit+len*8>c.end){
      if(t!=='rest'){ rec.b0=c.bit; rec.bl=Math.max(0,c.end-c.bit); rec.err='truncated'; push(); c.stop=true; c.trunc=true; return; }
      len=(c.end-c.bit)>>3;
    }
    const sub=hexSub(f,env,c);
    rec.b0=c.bit; rec.bl=len*8;
    if(sub){
      rec.sub=true; push();
      const start=c.bit;
      hexRun(sub,c,name+'.',depth+1,start+len*8);
      if(t!=='rest') c.bit=Math.max(c.bit,start+len*8);
      rec.bl=c.bit-start;
      return;
    }
    const b=c.d.subarray(c.bit>>3,(c.bit>>3)+len);
    rec.raw=b; rec.value=t==='str' ? hexDecStr(b,f.enc||'ascii') : hexFmtBytes(b,f.fmt||'hex');
    rec.text=t==='str' ? rec.value : f.fmt && f.fmt!=='hex' ? rec.value : Array.from(b.subarray(0,32),hexByte).join(' ')+(b.length>32 ? ' …' : '');
    c.vals[name]=rec.value;
    c.bit+=len*8;
    push();
    return;
  }
  if(t==='list'){
    if(c.bit&7) c.bit=(c.bit+7)&~7;
    rec.b0=c.bit; rec.list=true; push();
    const start=c.bit;
    let cnt;
    if(B){
      const key=name+'[', seen=new Set();
      for(const k of c.keys) if(k.startsWith(key)){ const j=parseInt(k.slice(key.length),10); if(j>=0) seen.add(j); }
      cnt=seen.size ? Math.max(...seen)+1 : 0;
    } else cnt=f.count!=null ? N(f.count,0) : Infinity;
    const sub=hexSub(f,env,c) || (f.item ? {fields:[Object.assign({n:'v'},f.item)], endian:sch.endian, bitorder:sch.bitorder} : null);
    if(sub){
      for(let i=0;i<cnt && !c.stop;i++){
        if(!B && c.bit>=c.end) break;
        const irec={n:name+'['+i+']', name:'['+i+']', t:'struct', depth:depth+1, b0:c.bit, bl:0, f:{}, ss, se:0, prefix, sub:true, item:true};
        recs.push(irec); c.recs.push(irec); c.byName[irec.n]=irec;
        const before=c.bit;
        hexRun(sub,c,name+'['+i+'].',depth+2,null);
        irec.bl=c.bit-before;
        if(!B && c.bit===before) break;
      }
    }
    rec.bl=c.bit-start;
    return;
  }
  c.warn.push((f.n||'?')+': unknown type '+t);
}
function hexEnsure(a,bit){ const n=(bit+7)>>3; while(a.length<n) a.push(0); }

function hexCoerceNum(v,f){
  if(v===undefined || v===null || v==='') return undefined;
  if(typeof v==='number' || typeof v==='bigint') return v;
  if(typeof v==='boolean') return v?1:0;
  if(f.enum){ for(const k in f.enum) if(String(f.enum[k]).toLowerCase()===String(v).toLowerCase()) return Number(k); }
  const n=Number(v);
  if(!isNaN(n)) return n;
  if(/^0b[01]+$/i.test(v)) return parseInt(v.slice(2),2);
  return undefined;
}
function hexPutNum(a,pos,w,v,t,f,endian,order,aligned){
  if(t==='f32'||t==='f64'){
    const buf=new DataView(new ArrayBuffer(w>>3));
    if(w===32) buf.setFloat32(0,v,endian==='le'); else buf.setFloat64(0,v,endian==='le');
    hexEnsure(a,pos+w);
    for(let i=0;i<w>>3;i++) a[(pos>>3)+i]=buf.getUint8(i);
    return;
  }
  if(typeof v==='number') v=Math.trunc(v);
  if(v<0){ v=typeof v==='bigint' ? BigInt.asUintN(w,v) : (w>53 ? BigInt.asUintN(w,BigInt(v)) : v+Math.pow(2,w)); }
  if(t!=='bits' || (aligned && f.endian==='le')){
    if(aligned){ hexIntSet(a,pos,w,v,endian); return; }
  }
  hexBitsSet(a,pos,w,v,order);
}
function hexNumText(v,w,f){
  if(typeof v!=='number' && typeof v!=='bigint') return String(v);
  if(f.enum){
    const k=f.enum[v] ?? f.enum[String(v)];
    return k!==undefined ? k+' ('+v+')' : '? ('+v+')';
  }
  if(f.flags){
    const on=[]; for(const k in f.flags) if((Number(v)>>Number(k))&1) on.push(f.flags[k]);
    return on.length ? on.join(' | ') : '—';
  }
  if(f.scale!==undefined) return (Number(v)*f.scale).toFixed(f.prec!==undefined ? f.prec : 1)+(f.unit ? ' '+f.unit : '');
  if(f.fmt) return hexFmtInt(v,w,f.fmt);
  return String(v);
}

/* ---------- контрольные суммы и вычисляемые поля ---------- */
function hexCalcFields(c){
  const data=c.build ? c.out : c.d;
  for(const pass of [0,1]){
    for(const r of c.recs){
      const f=r.f, calc=f && f.calc;
      if(!calc || r.err || r.value===undefined && !c.build) continue;
      const sum=hexSum(calc);
      if((pass===0) === !!sum) continue;
      let val;
      try{
        if(sum){
          const byName=n=>c.byName[r.prefix+n];
          const a=f.from && byName(f.from) ? byName(f.from).b0>>3 : r.ss;
          const all=f.over==='all' || (!f.to && !f.over && calc==='inet16');
          const e=f.to && byName(f.to) ? byName(f.to).b0>>3 : all ? r.se : r.b0>>3;
          let src=data;
          if(calc==='inet16' || f.over==='all'){            // поле суммы считается нулевым
            src=Array.from(data.subarray ? data.subarray(0,e) : data.slice(0,e));
            for(let i=0;i<(r.bl+7)>>3;i++) src[(r.b0>>3)+i]=0;
          }
          if(f.pseudo){                                       // UDP / TCP / ICMPv6: псевдозаголовок IP из src и dst родителя
            const g=n=>{ const k=hexNames(c,r.prefix,n); return k && c.byName[k] && c.byName[k].raw; };
            const sa=g('src'), da=g('dst');
            if(!sa || !da) throw new Error('no src / dst of the IP header');
            const L=r.se-r.ss, pr=f.pseudo.proto;
            const all=Array.from(sa).concat(Array.from(da), sa.length===16 ? [0,0,(L>>8)&255,L&255,0,0,0,pr] : [0,pr,(L>>8)&255,L&255]);
            const body=Array.from(data.subarray ? data.subarray(r.ss,r.se) : data.slice(r.ss,r.se));
            for(let i=0;i<(r.bl+7)>>3;i++) body[(r.b0>>3)-r.ss+i]=0;
            const m=all.concat(body);
            val=sum.f(m,0,m.length);
            if(f.zeroFF && val===0) val=0xFFFF;
          } else val=sum.f(src,a,e);
          if(f.xor!==undefined) val=(val^f.xor)>>>0;                     // маска поверх суммы (DMR CSBK: 0xA5A5)
        } else {
          const env=hexLookup(c,r.prefix,r.ss,r.se);
          val=hexExpr(String(calc))(env);
          if(f.t==='bits' || HEX_INT.test(f.t||'u8')) val=Math.trunc(val);
        }
      } catch(e){ c.warn.push(r.n+'.calc: '+e.message); continue; }
      if(c.build){
        c.vals[r.n]=val; r.value=val;
        const aligned=(r.b0&7)===0 && (r.bl&7)===0;
        hexPutNum(c.out,r.b0,r.bl,val,r.t,f,f.endian||c.rootEndian[r.prefix]||'be',c.rootOrder[r.prefix]||'msb',aligned);
        r.text=hexNumText(val,r.bl,f);
      } else {
        r.calcExpect=val;
        r.calcOk=Number(val)===Number(r.value) || !!(f.optional && Number(r.value)===0);
        if(sum && !r.calcOk) r.warn='checksum: expected 0x'+Number(val).toString(16).toUpperCase().padStart(sum.w/4,'0');
        else if(!sum && !r.calcOk) r.warn='expected '+val;
      }
    }
  }
}

/* ---------- API ---------- */
function hexParse(schema,data,opts){
  opts=opts||{};
  const lib=opts.lib||HEX_LIB, sch=hexSchema(schema,lib);
  if(!(data instanceof Uint8Array)) data=Uint8Array.from(data);
  const c={d:data, bit:0, end:data.length*8, vals:{}, byName:{}, recs:[], warn:[], lib, build:false, stop:false, trunc:false};
  hexRun(sch,c,'',0,null);
  hexCalcFields(c);
  const used=(c.bit+7)>>3;
  return {schema:sch.name||'', fields:c.recs, vals:c.vals, len:used, rest:data.subarray(Math.min(used,data.length)),
    ok:!c.trunc && !c.recs.some(r=>r.err || r.calcOk===false), trunc:c.trunc, warn:c.warn, size:data.length};
}
function hexBuild(schema,values,opts){
  opts=opts||{};
  const lib=opts.lib||HEX_LIB, sch=hexSchema(schema,lib);
  const vals=Object.assign({},values||{});
  const c={d:null, out:[], bit:0, end:Infinity, vals, byName:{}, recs:[], warn:[], lib, build:true, stop:false, keys:Object.keys(vals),
    rootEndian:{}, rootOrder:{}};
  hexRunB(sch,c,'',0);
  hexCalcFields(c);
  const bytes=Uint8Array.from(c.out);
  return {bytes, fields:c.recs, vals:c.vals, warn:c.warn, len:bytes.length};
}
// запоминает endian / bitorder схемы для пересчёта полей после сборки
function hexRunB(sch,c,prefix,depth){
  c.rootEndian[prefix]=sch.endian; c.rootOrder[prefix]=sch.bitorder;
  hexRun(sch,c,prefix,depth,null);
}
// разбор → плоская запись для rec: поле → значение; рядом имя enum, служебные _len/_ok
function hexToRec(res){
  const o={};
  for(const r of res.fields){
    if(r.pad || r.value===undefined || !r.n) continue;
    o[r.n]=r.value;
    if(r.f.enum) o[r.n+'_name']=r.f.enum[r.value] ?? r.f.enum[String(r.value)] ?? '';
    if(r.f.as && !(r.f.as in o)){ o[r.f.as]=r.value; if(r.f.enum) o[r.f.as+'_name']=o[r.n+'_name']; }
  }
  o._len=res.size; o._ok=res.ok?1:0;
  if(res.schema) o._schema=res.schema;
  return o;
}
// запись со значениями полей для сборки: ключи rec → vals (лишние игнорируются)
function hexFromRec(rec){ const o={}; for(const k in rec) if(k[0]!=='_' && !k.endsWith('_name')) o[k]=rec[k]; return o; }

// выбор схемы по первому полю/условию: [{schema, match:'выражение'}] — проверяется после разбора первой схемы
function hexDump(d,width,from,to){
  width=width||16; from=from||0; to=to==null ? d.length : to;
  const L=[];
  for(let i=from;i<to;i+=width){
    const row=d.subarray(i,Math.min(to,i+width));
    L.push(i.toString(16).padStart(4,'0')+'  '+Array.from(row,hexByte).join(' ').padEnd(width*3-1)+'  '+hexFmtBytes(row,'ascii'));
  }
  return L.join('\n');
}

// !AIVDM / !AIVDO: 6-битная упаковка полезной нагрузки → байты (биты подряд, хвост добит нулями); многочастные сообщения склеиваются
function hexAisPayload(pl,fill){
  const bits=[];
  for(const ch of pl){ let v=ch.charCodeAt(0)-48; if(v>40) v-=8; for(let k=5;k>=0;k--) bits.push((v>>k)&1); }
  const n=bits.length-(fill||0), out=new Uint8Array((n+7)>>3);
  for(let i=0;i<n;i++) if(bits[i]) out[i>>3]|=0x80>>(i&7);
  return {bytes:out, bits:n};
}
class HexAisAsm{
  constructor(){ this.parts=new Map(); }
  push(line){
    const m=/^\s*[!$]..VD[MO],(\d+),(\d+),([^,]*),[^,]*,([^,]*),(\d)/.exec(line);
    if(!m) return null;
    const total=+m[1], idx=+m[2], id=m[3], pl=m[4], fill=+m[5];
    if(total===1) return hexAisPayload(pl,fill);
    let e=this.parts.get(id);
    if(!e || e.total!==total || idx===1){ e={total,got:[]}; this.parts.set(id,e); }
    e.got[idx-1]=pl;
    if(e.got.length===total && e.got.every(x=>x!==undefined)){ this.parts.delete(id); return hexAisPayload(e.got.join(''),fill); }
    return null;
  }
}
// схема по содержимому: перебирает схемы с полем detect (выражение над разобранными полями и _size)
function hexDetect(data,lib){
  lib=lib||HEX_LIB;
  if(!(data instanceof Uint8Array)) data=Uint8Array.from(data);
  let first=null;
  for(const name in lib){
    const s=lib[name];
    if(!s || !s.detect) continue;
    let res; try{ res=hexParse(s,data,{lib}); }catch(e){ continue; }
    if(res.trunc) continue;
    let ok=false;
    try{ ok=!!hexExpr(s.detect)(k=>k==='_size' ? data.length : res.vals[k]); }catch(e){}
    if(!ok) continue;
    if(res.ok) return name;
    if(first===null) first=name;
  }
  return first;
}
