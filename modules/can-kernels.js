"use strict";
/* ============================ CAN / OBD-II: ядро ============================
   SLCAN (Lawicel): «t1232AABB\r» — кадр, 11 бит; «T…» — 29 бит; «r» / «R» — запрос. Текстовый вид кадра — как у candump / cansend:
   «123#DEADBEEF» (11 бит — 3 hex, 29 бит — 8 hex, «123#R» — запрос). OBD-II режим 01: запрос на 7DF, ответ с 7E8…7EF.
   Без DOM и сети — проверяется отдельно. */

const SLCAN_RATES={'10k':'S0','20k':'S1','50k':'S2','100k':'S3','125k':'S4','250k':'S5','500k':'S6','800k':'S7','1M':'S8'};
const canHex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
// строка SLCAN (без \r) → {id, ext, rtr, data}; null — не кадр (ответы на команды, мусор)
function slcanParse(line){
  const m=/^([tTrR])([0-9A-Fa-f]+)$/.exec(String(line).trim()); if(!m) return null;
  const ext=m[1]==='T' || m[1]==='R', rtr=m[1]==='r' || m[1]==='R', idLen=ext ? 8 : 3, s=m[2];
  if(s.length<idLen+1) return null;
  const id=parseInt(s.slice(0,idLen),16), dlc=parseInt(s[idLen],16), hex=s.slice(idLen+1);
  if(dlc>8 || (ext ? id>0x1FFFFFFF : id>0x7FF)) return null;
  if(rtr) return {id,ext,rtr,data:new Uint8Array(0),dlc};
  if(hex.length<dlc*2) return null;                              // хвост после данных (метка времени) отбрасываем
  const data=new Uint8Array(dlc); for(let i=0;i<dlc;i++) data[i]=parseInt(hex.substr(i*2,2),16);
  return {id,ext,rtr:false,data,dlc};
}
// кадр → строка SLCAN с \r
function slcanEncode(f){
  const idS=f.ext ? f.id.toString(16).toUpperCase().padStart(8,'0') : f.id.toString(16).toUpperCase().padStart(3,'0');
  const dlc=f.rtr ? (f.dlc||0) : f.data.length;
  return (f.rtr ? (f.ext ? 'R' : 'r') : (f.ext ? 'T' : 't'))+idS+dlc.toString(16)+(f.rtr ? '' : canHex(f.data))+'\r';
}
// «123#DEADBEEF» / «12345678#00» / «123#R» → кадр; null — не разбирается
function canParse(s){
  const m=/^\s*([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})#(R|[0-9A-Fa-f.]*)\s*$/.exec(String(s)); if(!m) return null;
  const ext=m[1].length===8, id=parseInt(m[1],16);
  if(ext ? id>0x1FFFFFFF : id>0x7FF) return null;
  if(m[2]==='R') return {id,ext,rtr:true,data:new Uint8Array(0),dlc:0};
  const h=m[2].replace(/\./g,''); if(h.length%2 || h.length>16) return null;
  const data=new Uint8Array(h.length/2); for(let i=0;i<data.length;i++) data[i]=parseInt(h.substr(i*2,2),16);
  return {id,ext,rtr:false,data,dlc:data.length};
}
function canFormat(f){
  const idS=f.ext ? f.id.toString(16).toUpperCase().padStart(8,'0') : f.id.toString(16).toUpperCase().padStart(3,'0');
  return idS+'#'+(f.rtr ? 'R' : canHex(f.data));
}
// байты из порта → строки SLCAN; «\r» конец строки, «\a» (0x07) — ошибка адаптера
class SlcanParser{
  constructor(){ this.buf=''; }
  push(text){
    const out=[]; this.buf+=text; let i;
    while((i=this.buf.search(/[\r\x07]/))>=0){
      const ch=this.buf[i], line=this.buf.slice(0,i); this.buf=this.buf.slice(i+1);
      if(ch==='\x07') out.push({err:true}); else if(line) out.push({line});
    }
    if(this.buf.length>200) this.buf='';
    return out;
  }
}
/* ---------- OBD-II, режим 01 ---------- */
// PID → [имя, единица, функция(A,B)]
const OBD_PIDS={
  0x04:['load','%',(A)=>A*100/255],
  0x05:['coolant','°C',(A)=>A-40],
  0x0A:['fuel pressure','kPa',(A)=>A*3],
  0x0B:['MAP','kPa',(A)=>A],
  0x0C:['rpm','rpm',(A,B)=>(256*A+B)/4],
  0x0D:['speed','km/h',(A)=>A],
  0x0E:['timing','°',(A)=>A/2-64],
  0x0F:['intake temp','°C',(A)=>A-40],
  0x10:['MAF','g/s',(A,B)=>(256*A+B)/100],
  0x11:['throttle','%',(A)=>A*100/255],
  0x2F:['fuel level','%',(A)=>A*100/255],
  0x42:['module voltage','V',(A,B)=>(256*A+B)/1000],
  0x46:['ambient temp','°C',(A)=>A-40],
  0x5C:['oil temp','°C',(A)=>A-40]
};
const obdPids=s=>String(s||'').split(/[\s,]+/).filter(Boolean).map(x=>parseInt(x,16)).filter(p=>Number.isInteger(p) && p>=0 && p<=0xFF);
function obdRequest(pid){ return {id:0x7DF,ext:false,rtr:false,data:Uint8Array.from([2,1,pid,0,0,0,0,0]),dlc:8}; }
// кадр-ответ ECU (7E8…7EF, режим 01) → {ecu, pid, name, value, unit}; null — иной кадр или неизвестный PID
function obdDecode(f){
  if(f.ext || f.rtr || f.id<0x7E8 || f.id>0x7EF || f.data.length<4) return null;
  const d=f.data, len=d[0];
  if(len<3 || len>7 || d[1]!==0x41) return null;
  const pid=d[2], def=OBD_PIDS[pid]; if(!def) return null;
  const v=def[2](d[3],d[4]||0);
  return {ecu:f.id-0x7E8,pid,name:def[0],value:Math.round(v*100)/100,unit:def[1]};
}
