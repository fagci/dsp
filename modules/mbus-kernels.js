"use strict";
/* ============================ M-Bus / wM-Bus: ядро ============================
   EN 13757: проводная шина (EN 13757-2/3: кадры 0xE5, короткий 0x10, длинный 0x68) и радио 868 МГц (EN 13757-4, формат A с CRC по блокам).
   Разбор записей данных DIF / VIF: целые, BCD, вещественные, дата и время, единицы первичной таблицы VIF. Без DOM и сети.
   Не разбирается: шифрование (AES-128, режим 5), расширенные таблицы VIFE / VIF 0xFB, кроме нескольких кодов. */

// CRC-16/EN-13757: полином 0x3D65, начало 0, без отражения, итог XOR 0xFFFF (контрольное значение для «123456789» — 0xC2B7)
function mbusCrc(b){
  let c=0;
  for(let i=0;i<b.length;i++){ c^=b[i]<<8; for(let k=0;k<8;k++) c=(c&0x8000) ? ((c<<1)^0x3D65)&0xFFFF : (c<<1)&0xFFFF; }
  return c^0xFFFF;
}
const mbusSum=(b,from,to)=>{ let s=0; for(let i=from;i<to;i++) s=(s+b[i])&255; return s; };
// hex-строка («68 1F 1F…», «0x…», с разделителями) → байты; null — не hex
function mbusHex(s){
  const t=String(s||'').replace(/0x/gi,'').replace(/[^0-9a-fA-F]/g,'');
  if(!t || t.length%2) return null;
  const o=new Uint8Array(t.length/2); for(let i=0;i<o.length;i++) o[i]=parseInt(t.substr(i*2,2),16); return o;
}
const mbusToHex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
// кадры проводной шины: запрос REQ_UD2 / SND_NKE (короткий кадр) → байты
function mbusShort(c,a){ return Uint8Array.of(0x10,c,a,(c+a)&255,0x16); }
const MBUS_REQ_UD2=0x5B, MBUS_SND_NKE=0x40;
// поток байт проводной шины → кадры {type:'ack'|'short'|'long', bytes}; рассинхронизацию лечит сдвиг на байт
class MbusParser{
  constructor(){ this.buf=[]; }
  push(bytes){
    for(const x of bytes) this.buf.push(x);
    const out=[], b=this.buf;
    for(;;){
      if(!b.length) break;
      if(b[0]===0xE5){ out.push({type:'ack',bytes:Uint8Array.of(0xE5)}); b.shift(); continue; }
      if(b[0]===0x10){
        if(b.length<5) break;
        if(b[4]===0x16 && b[3]===((b[1]+b[2])&255)){ out.push({type:'short',bytes:Uint8Array.from(b.slice(0,5))}); b.splice(0,5); continue; }
        b.shift(); continue;
      }
      if(b[0]===0x68){
        if(b.length<4) break;
        const L=b[1];
        if(b[2]!==L || b[3]!==0x68){ b.shift(); continue; }
        if(b.length<L+6) break;
        const f=Uint8Array.from(b.slice(0,L+6));
        if(f[L+5]===0x16 && f[L+4]===mbusSum(f,4,L+4)){ out.push({type:'long',bytes:f}); b.splice(0,L+6); continue; }
        b.shift(); continue;
      }
      b.shift();
    }
    if(b.length>600) b.splice(0,b.length-8);
    return out;
  }
}
const MBUS_MEDIUM={0:'other',1:'oil',2:'electricity',3:'gas',4:'heat (outlet)',5:'steam',6:'hot water',7:'water',8:'heat cost allocator',9:'compressed air',10:'cooling (outlet)',11:'cooling (inlet)',12:'heat (inlet)',13:'heat / cooling',14:'bus / system',15:'unknown',
  0x15:'hot water (>=90 °C)',0x16:'cold water',0x17:'dual water',0x18:'pressure',0x19:'A/D converter',0x20:'smoke detector',0x21:'room sensor',0x22:'gas detector',0x25:'breaker (electricity)',0x26:'valve (gas / water)',0x28:'waste water',0x29:'garbage',0x31:'communication controller',0x32:'unidirectional repeater',0x33:'bidirectional repeater',0x37:'radio converter (system)'};
const mbusManuf=v=>String.fromCharCode(((v>>10)&31)+64,((v>>5)&31)+64,(v&31)+64);
const MBUS_FUNC=['','max','min','error'];
// первичная таблица VIF: код (без бита расширения) → [описание, единица, десятичная степень]
function mbusVif(v){
  const c=v&0x7F, n3=c&7, n2=c&3;
  if(c<0x08) return ['Energy','Wh',n3-3];
  if(c<0x10) return ['Energy','J',n3];
  if(c<0x18) return ['Volume','m³',n3-6];
  if(c<0x20) return ['Mass','kg',n3-3];
  if(c<0x24) return ['On time',['s','min','h','d'][n2],0];
  if(c<0x28) return ['Operating time',['s','min','h','d'][n2],0];
  if(c<0x30) return ['Power','W',n3-3];
  if(c<0x38) return ['Power','J/h',n3];
  if(c<0x40) return ['Volume flow','m³/h',n3-6];
  if(c<0x48) return ['Volume flow','m³/min',n3-7];
  if(c<0x50) return ['Volume flow','m³/s',n3-9];
  if(c<0x58) return ['Mass flow','kg/h',n3-3];
  if(c<0x5C) return ['Flow temperature','°C',n2-3];
  if(c<0x60) return ['Return temperature','°C',n2-3];
  if(c<0x64) return ['Temperature difference','K',n2-3];
  if(c<0x68) return ['External temperature','°C',n2-3];
  if(c<0x6C) return ['Pressure','bar',n2-3];
  if(c===0x6C) return ['Date','',0,'G'];
  if(c===0x6D) return ['Date and time','',0,'F'];
  if(c===0x6E) return ['Units for H.C.A.','',0];
  if(c===0x70 || c===0x71 || c===0x72 || c===0x73) return ['Averaging duration',['s','min','h','d'][n2],0];
  if(c===0x74 || c===0x75 || c===0x76 || c===0x77) return ['Actuality duration',['s','min','h','d'][n2],0];
  if(c===0x78) return ['Fabrication number','',0];
  if(c===0x79) return ['Enhanced identification','',0];
  if(c===0x7A) return ['Bus address','',0];
  return null;
}
const bcd=(d,off,len)=>{                                           // BCD младшим вперёд; старший полубайт F — знак минус
  let v=0, neg=false;
  for(let i=len-1;i>=0;i--){
    let hi=d[off+i]>>4; const lo=d[off+i]&15;
    if(i===len-1 && hi===0xF){ neg=true; hi=0; }
    if(hi>9 || lo>9) return null;
    v=v*100+hi*10+lo;
  }
  return neg ? -v : v;
};
const p2=x=>String(x).padStart(2,'0');
function mbusDate(d,off,type){
  if(type==='G'){ const day=d[off]&31, mon=d[off+1]&15, yr=((d[off]&0xE0)>>5)|((d[off+1]&0xF0)>>1); return (2000+yr)+'-'+p2(mon)+'-'+p2(day); }
  const min=d[off]&63, hr=d[off+1]&31, day=d[off+2]&31, mon=d[off+3]&15, yr=((d[off+2]&0xE0)>>5)|((d[off+3]&0xF0)>>1);
  return (2000+yr)+'-'+p2(mon)+'-'+p2(day)+' '+p2(hr)+':'+p2(min);
}
const DIF_LEN={0:0,1:1,2:2,3:3,4:4,5:4,6:6,7:8,8:0,9:1,10:2,11:3,12:4,13:-1,14:6,15:0};
// область данных (после заголовка) → записи
function mbusRecords(d,p,end){
  const recs=[]; let k=0;
  while(p<end){
    const dif=d[p];
    if(dif===0x2F){ p++; continue; }                                // заполнитель
    if((dif&0x0F)===0x0F){                                          // 0x0F — данные производителя до конца, 0x1F — ещё кадры
      recs.push({n:k++,desc:dif===0x1F ? 'more records follow' : 'manufacturer specific',value:mbusToHex(d.subarray(p+1,end)),unit:'',raw:true}); break; }
    p++;
    let storage=(dif>>6)&1, tariff=0, subunit=0, ext=dif&0x80, shift=1;
    while(ext && p<end){ const x=d[p++]; storage|=(x&15)<<shift; tariff|=((x>>4)&3)<<(2*(shift-1)); subunit|=((x>>6)&1)<<(shift-1); shift+=4; ext=x&0x80; }
    if(p>=end) return {recs,error:'truncated record header'};
    const vif=d[p++]; let desc, unit, exp=0, kind='', vtext='';
    if(vif===0x7C || vif===0xFC){ const L=d[p++]; vtext=String.fromCharCode(...Array.from(d.subarray(p,p+L)).reverse()); p+=L; desc=vtext; unit=''; }
    else if(vif===0xFB || vif===0xFD || vif===0x7F || vif===0xFF || vif===0x7E){
      const x=(vif===0xFB || vif===0xFD) ? d[p++] : 0;
      desc=vif===0x7F || vif===0xFF ? 'Manufacturer specific' : vif===0x7E ? 'Any VIF' : 'Extended '+(vif===0xFD ? 'FD ' : 'FB ')+p2((x&0x7F).toString(16).toUpperCase()); unit='';
      if(vif===0xFD && (x&0x7F)===0x17) desc='Error flags';
      if(vif===0xFD && (x&0x7F)===0x08) desc='Access number';
      if(vif===0xFD && (x&0x7F)===0x0A) desc='Customer location';
      if(vif===0xFD && (x&0x7C)===0x48 ) { desc='Voltage'; unit='V'; exp=((x&15)-9); }
      if(vif===0xFD && (x&0x7C)===0x58 ){ desc='Current'; unit='A'; exp=((x&15)-12); }
      if((x&0x80) && p<end){ while(p<end && (d[p++]&0x80)); }
    } else {
      const t=mbusVif(vif); if(!t){ return {recs,error:'unknown VIF 0x'+vif.toString(16)}; }
      [desc,unit,exp,kind]=t;
      if(vif&0x80){ while(p<end && (d[p++]&0x80)); }               // VIFE пропускаем (коды расширения не разбираются)
    }
    let len=DIF_LEN[dif&15]; const t=dif&15;
    if(len<0){ const L=d[p++]; len=L<0xC0 ? L : 0; }               // переменной длины (текст — младшим вперёд)
    if(p+len>end) return {recs,error:'truncated data'};
    let value, raw=d.subarray(p,p+len);
    if(t===0 || t===8) value=null;
    else if(kind){ value=mbusDate(d,p,kind); unit=''; }
    else if(t===5){ value=new DataView(raw.buffer,raw.byteOffset,4).getFloat32(0,true); value=Math.round(value*Math.pow(10,exp)*1e6)/1e6; }
    else if(t===1 || t===2 || t===3 || t===4 || t===6 || t===7){
      let v=0n; for(let i=len-1;i>=0;i--) v=(v<<8n)|BigInt(raw[i]);
      const bits=BigInt(len*8); if(v>>(bits-1n)) v-=1n<<bits;      // знаковое
      value=Number(v)*Math.pow(10,exp);
    }
    else if(t===9 || t===10 || t===11 || t===12 || t===14){ const v=bcd(d,p,len); value=v===null ? null : v*Math.pow(10,exp); }
    else if(t===13){ value=String.fromCharCode(...Array.from(raw).reverse()); }
    if(typeof value==='number') value=Math.round(value*1e9)/1e9;
    p+=len;
    recs.push({n:k++,desc,unit,value,storage,tariff,subunit,func:MBUS_FUNC[(dif>>4)&3]});
  }
  return {recs};
}
// телеграмма → {kind, c, a, id, manuf, version, medium, ci, access, status, sig, encrypted, records, error}
function mbusDecode(b){
  if(!b || b.length<5) return {error:'too short'};
  let o={}, p, end;
  if(b[0]===0x68){
    if(b.length<9 || b[1]!==b[2] || b[3]!==0x68 || b.length!==b[1]+6) return {error:'bad long frame length'};
    if(b[b.length-1]!==0x16 || b[b.length-2]!==mbusSum(b,4,b.length-2)) return {error:'bad checksum'};
    o={kind:'wired',c:b[4],a:b[5]}; const ci=b[6]; o.ci=ci; p=7; end=b.length-2;
    if(ci===0x72){ if(end-p<12) return {...o,error:'short header'}; o.id=bcd(b,p,4); o.manuf=mbusManuf(b[p+4]|(b[p+5]<<8)); o.version=b[p+6]; o.medium=b[p+7]; o.access=b[p+8]; o.status=b[p+9]; o.sig=b[p+10]|(b[p+11]<<8); p+=12; }
    else if(ci===0x78){ }                                         // без заголовка
    else if(ci===0x7A){ if(end-p<4) return {...o,error:'short header'}; o.access=b[p]; o.status=b[p+1]; o.sig=b[p+2]|(b[p+3]<<8); p+=4; }
    else return {...o,error:'CI 0x'+ci.toString(16)+' not decoded'};
  } else {
    // радио: L C M(2) A(6) CI …; формат A с CRC по блокам снимаем, если они сходятся; иначе считаем, что CRC уже убраны
    let f=b; const un=mbusUnCrc(b); if(un) f=un;
    if(f[0]+1!==f.length) return {error:'length byte '+f[0]+' does not match '+f.length+' bytes'};
    o={kind:'wireless',crc:!!un,c:f[1],manuf:mbusManuf(f[2]|(f[3]<<8)),id:bcd(f,4,4),version:f[8],medium:f[9],ci:f[10]};
    p=11; end=f.length; b=f;
    if(o.ci===0x7A){ if(end-p<4) return {...o,error:'short header'}; o.access=b[p]; o.status=b[p+1]; o.sig=b[p+2]|(b[p+3]<<8); p+=4; }
    else if(o.ci===0x72){ if(end-p<12) return {...o,error:'short header'}; o.access=b[p+8]; o.status=b[p+9]; o.sig=b[p+10]|(b[p+11]<<8); p+=12; }
    else if(o.ci===0x78){ }
    else return {...o,error:'CI 0x'+o.ci.toString(16)+' not decoded'};
  }
  if(o.medium!==undefined) o.mediumName=MBUS_MEDIUM[o.medium]||('0x'+o.medium.toString(16));
  const mode=o.sig!==undefined ? (o.sig>>8)&15 : 0;
  if(mode!==0){ o.encrypted=true; o.records=[]; o.error='encrypted (security mode '+mode+'): not decoded'; return o; }
  const r=mbusRecords(b,p,end); o.records=r.recs; if(r.error) o.error=r.error;
  return o;
}
// формат A: первый блок 10 байт + CRC, дальше блоки по 16 байт + CRC, последний — остаток + CRC; null, если CRC не сходятся
function mbusUnCrc(b){
  const out=[]; let p=0, first=true;
  while(p<b.length){
    const n=first ? 10 : 16, take=Math.min(n,b.length-p-2);
    if(take<=0) return null;
    const blk=b.subarray(p,p+take), c=(b[p+take]<<8)|b[p+take+1];
    if(mbusCrc(blk)!==c) return null;
    for(const x of blk) out.push(x); p+=take+2; first=false;
  }
  return out.length && out[0]+1===out.length ? Uint8Array.from(out) : null;
}
// короткая сводка
function mbusSummary(d){
  const h=(d.kind==='wired' ? 'A'+d.a : d.manuf)+(d.id!==undefined && d.id!==null ? ' #'+d.id : '')+(d.manuf && d.kind==='wired' ? ' '+d.manuf : '')+(d.mediumName ? ' '+d.mediumName : '');
  if(d.error && !d.records?.length) return h+': '+d.error;
  return h+': '+(d.records||[]).filter(r=>!r.raw).map(r=>r.desc+(r.func ? ' '+r.func : '')+(r.storage ? ' @'+r.storage : '')+' '+(r.value===null ? '—' : r.value)+(r.unit ? ' '+r.unit : '')).join('; ')+(d.error ? ' ('+d.error+')' : '');
}
