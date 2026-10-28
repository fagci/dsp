"use strict";
/* ============================ Tunnel: BLE GATT ↔ Network — ядро ============================
   Полноценный туннель, не разовая подмена conn:1 из пресета-моста (modules/flow.js, recMap): отслеживает
   живое TCP/UDP-соединение по его собственным записям open/accept/close и шлёт в него именно его conn,
   а не угаданный номер. Без DOM — проверяется tools/test-tunnel.mjs. Узел — modules/tunnel.js. */

function tnInit(){ return {conn:null}; }

// gattRecs/netRecs — записи rec со входов за такт (в порядке прихода); p — параметры узла (modules/tunnel.js)
// возвращает {gattCmd:[...]|null, netCmd:[...]|null, conn: state.conn} — команды добавляются в исходном порядке записей
function tnStep(state, gattRecs, netRecs, p){
  const svc=String(p.svc||'').trim().toLowerCase(), chr=String(p.chr||'').trim().toLowerCase();
  const udp=p.mode==='udp';
  const gattCmd=[], netCmd=[];
  for(const r of netRecs||[]){
    if(!r || typeof r!=='object') continue;
    if(r.ev==='open' || r.ev==='accept'){ state.conn=r.conn; continue; }
    if(r.ev==='close'){ if(r.conn===state.conn) state.conn=null; continue; }
    if(r.ev==='data' && typeof r.hex==='string' && r.hex){
      gattCmd.push({cmd:'gatt.write', addr:String(p.addr||''), svc:String(p.svc||''), chr:String(p.chr||''), hex:r.hex, resp:!!p.resp});
    }
  }
  for(const r of gattRecs||[]){
    if(!r || typeof r!=='object' || r.src!=='gatt') continue;
    if(r.ev==='disconnected'){
      if(p.closeOnDrop && state.conn!=null){ netCmd.push(udp ? {cmd:'udp.close',conn:state.conn} : {cmd:'tcp.close',conn:state.conn}); state.conn=null; }
      continue;
    }
    if((r.ev==='notify' || r.ev==='read') && typeof r.hex==='string' && r.hex){
      if(svc && String(r.svc||'').toLowerCase()!==svc) continue;
      if(chr && String(r.chr||'').toLowerCase()!==chr) continue;
      if(state.conn==null) continue;                     // нет клиента — некуда слать, тихо пропускаем
      netCmd.push(udp
        ? {cmd:'udp.send', host:String(p.host||''), port:+p.port||0, conn:state.conn, hex:r.hex}
        : {cmd:'tcp.send', conn:state.conn, hex:r.hex});
    }
  }
  return {gattCmd:gattCmd.length ? gattCmd : null, netCmd:netCmd.length ? netCmd : null, conn:state.conn};
}

if(typeof module!=='undefined') module.exports={tnInit,tnStep};
