"use strict";
/* ============================ Radio Bridge (ESP32-C5): разбор строк ============================
   Строки прошивки tools/radio-bridge-esp32c5 (hex без FCS):
     RX WIFI <канал> <rssi> <hex>                       RX WIFI! — кадр обрезан по SNAP
     RX BLE <адрес> <rssi> <тип события> <тип адреса> <hex рекламных данных>
     RX ZB <канал> <rssi> <lqi> <hex>                   802.15.4: Zigbee, Thread, Matter-over-Thread
     STAT <канал> <мс> <кадров> <байт> <rssi max> <rssi avg> <занятость ‰> <потеряно>   окно по каналу (rssi -127 — тишина)
     CSI <канал> <rssi> <mac> <hex int8: мнимая, вещественная часть на поднесущую>
   Кадр разбирается схемой из hex-formats.js (ядро — hex-kernels.js); запись rec несёт hex и hexSchema,
   поэтому её можно отдать в HEX Structure. Имена полей одинаковы для всех протоколов:
   proto, kind, src, dst, net (BSSID / PAN), chan, rssi, + поля пакета (ie.ssid, ad.name, zb_cluster …).
   Проверка: node tools/test-hex.mjs */

const RADIO_SCHEMA={wifi:'wifi', ble:'ble-adv', zb:'ieee802154'};
const RADIO_BLE_EVT=['adv_ind','adv_direct_ind','adv_scan_ind','adv_nonconn_ind','scan_rsp'];
const RADIO_TX_PROTO=['WIFI','BLE','ZB'];

function radioLine(line){
  let m=/^\s*RX WIFI(!?) (\d+) (-?\d+) ([0-9a-fA-F]+)\s*$/.exec(line);
  if(m) return {proto:'wifi', trunc:m[1]==='!', chan:+m[2], rssi:+m[3], bytes:hexFromHex(m[4])};
  m=/^\s*RX BLE ((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}) (-?\d+) (\d+) (\d+) ([0-9a-fA-F]*)\s*$/.exec(line);
  if(m) return {proto:'ble', addr:m[1].toLowerCase(), rssi:+m[2], evtype:+m[3], atype:+m[4], bytes:hexFromHex(m[5])};
  m=/^\s*RX ZB (\d+) (-?\d+) (\d+) ([0-9a-fA-F]+)\s*$/.exec(line);
  if(m) return {proto:'zb', chan:+m[1], rssi:+m[2], lqi:+m[3], bytes:hexFromHex(m[4])};
  m=/^\s*STAT (\d+) (\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+)\s*$/.exec(line);
  if(m) return {stat:true, chan:+m[1], ms:+m[2], frames:+m[3], bytes:+m[4], rmax:+m[5], ravg:+m[6], busy:+m[7], drop:+m[8]};
  m=/^\s*CSI (\d+) (-?\d+) ((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}) ([0-9a-fA-F]+)\s*$/.exec(line);
  if(m) return {csi:true, chan:+m[1], rssi:+m[2], src:m[3].toLowerCase(), bytes:hexFromHex(m[4])};
  return null;
}
// ответы прошивки на команды: OK … / ERR … / WARN … / TXZB … / MODE …
const radioStatus=line=>{ const s=String(line).trim(); return /^(OK|ERR|WARN|TXZB|MODE|ESP32)/.test(s) ? s : null; };

// окно STAT → запись: на таблицу с ключом chan ложится последнее окно канала; занятость в % и доля потерь
function radioStatRec(f,now){
  const heard=f.frames>0;
  return {t:now||Date.now(), proto:'wifi', kind:'chan-stat', id:'ch'+f.chan, chan:f.chan, ms:f.ms, frames:f.frames, bytes:f.bytes,
    rssi_max:heard ? f.rmax : -127, rssi_avg:heard ? f.ravg : -127, busy:Math.round(f.busy)/10, fps:f.ms ? Math.round(f.frames*1e4/f.ms)/10 : 0,
    drop:f.drop, text:'ch'+f.chan+' max '+(heard ? f.rmax : '—')+' dBm · busy '+(f.busy/10).toFixed(1)+'% · '+f.frames+' frames'};
}
// CSI: амплитуда и фаза по поднесущим (пары int8 мнимая, вещественная); csi / csi_ph — списки через запятую для графика
function radioCsiRec(f,now){
  const b=f.bytes, n=b.length>>1, amp=[], ph=[];
  for(let i=0;i<n;i++){
    const im=b[2*i]<<24>>24, re=b[2*i+1]<<24>>24;
    amp.push(Math.round(Math.hypot(re,im)*10)/10); ph.push(Math.round(Math.atan2(im,re)*573)/10);
  }
  return {t:now||Date.now(), proto:'wifi', kind:'csi', id:f.src, src:f.src, chan:f.chan, rssi:f.rssi, sc:n,
    csi:amp.join(','), csi_ph:ph.join(','), text:'csi '+f.src+' ch'+f.chan+' '+n+' subcarriers'};
}

function radioRec(f,now){
  const res=hexParse(RADIO_SCHEMA[f.proto],f.bytes), o=hexToRec(res);
  const r={t:now||Date.now(), proto:f.proto, chan:f.chan, rssi:f.rssi, len:f.bytes.length};
  if(f.lqi!==undefined) r.lqi=f.lqi;
  if(f.trunc) r.trunc=1;
  for(const k in o){ if(k[0]==='_' || /\[\d+\]/.test(k)) continue; r[k]=o[k]; }      // без позиционных имён body.ies[3]…
  if(f.proto==='ble'){
    r.src=f.addr; r.addr_type=f.atype ? 'random' : 'public';
    r.kind=RADIO_BLE_EVT[f.evtype] || 'event '+f.evtype;
    r.name=o['ad.name'] || o['ad.short_name'] || '';
  } else if(f.proto==='wifi' && o['ie.ssid']!==undefined) r.ssid=o['ie.ssid'];
  r.id=r.src || r.net || '?';
  r.text=f.proto+' '+(r.kind||'')+' '+(r.src||'')+(r.dst ? ' → '+r.dst : '')+(r.ssid ? ' "'+r.ssid+'"' : r.name ? ' "'+r.name+'"' : '')+
    (f.chan!==undefined ? ' ch'+f.chan : '')+' '+f.rssi+' dBm';
  r.hex=hexToHex(f.bytes); r.hexSchema=RADIO_SCHEMA[f.proto];
  return r;
}

// команда передачи: «WIFI <hex>», «ZB <hex> csma» или голый hex (протокол по умолчанию — proto)
function radioTx(src,proto,csma){
  let bytes=null;
  if(src instanceof Uint8Array) bytes=src;
  else if(src && typeof src==='object'){ bytes=hexFromHex(src.hex||''); if(src.proto) proto=String(src.proto); if(src.csma!==undefined) csma=!!src.csma; }
  else if(typeof src==='string'){
    const m=/^\s*(wifi|ble|zb)\b\s*(.*)$/i.exec(src);
    if(m){ proto=m[1]; src=m[2]; }
    const t=/\bcsma\b/i.exec(src); if(t){ csma=true; src=src.replace(/\bcsma\b/i,''); }
    bytes=hexFromHex(src);
  }
  proto=String(proto||'').toUpperCase();
  if(!bytes || !bytes.length || RADIO_TX_PROTO.indexOf(proto)<0) return null;
  return 'TX '+proto+' '+hexToHex(bytes)+(proto==='ZB' && csma ? ' CSMA' : '');
}

// ответ на Probe request: Probe response с нашим SSID и BSSID (кадр без FCS) или null, если запрос не нам
function radioProbeResp(r,o){
  if(!r || r.proto!=='wifi' || r.kind!=='probe-req' || !o || !o.ssid) return null;
  const want=r['ie.ssid'];
  if(want!==undefined && want!=='' && want!==o.ssid) return null;                 // пустой SSID — широковещательный запрос
  const bssid=String(o.bssid || '02:00:00:00:00:01').toLowerCase();
  if(!r.src || r.src===bssid) return null;
  const v={type:0, subtype:5, dur:0, addr1:r.src, addr2:bssid, addr3:bssid, frag:0, seq:(o.seq||0)&4095,
    'body.ts':0, 'body.interval':100, 'body.capab':0x0421, 'ie.ssid':o.ssid, 'ie.rates':'82848b960c121824'};
  const ch=r.chan || o.chan; if(ch>=1 && ch<=14) v['ie.channel']=ch;
  return hexBuild('wifi',v).bytes;
}
