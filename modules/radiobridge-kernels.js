"use strict";
/* ============================ Radio Bridge (ESP32-C5): разбор строк ============================
   Строки прошивки tools/radio-bridge-esp32c5 (hex без FCS):
     RX WIFI <канал> <rssi> <hex>                       RX WIFI! — кадр обрезан по SNAP
     RX BLE <адрес> <rssi> <тип события> <тип адреса> <hex рекламных данных>
     RX ZB <канал> <rssi> <lqi> <hex>                   802.15.4: Zigbee, Thread, Matter-over-Thread
     STAT <канал> <мс> <кадров> <байт> <rssi max> <rssi avg> <занятость ‰> <потеряно>   окно по каналу (rssi -127 — тишина)
     CSI <канал> <rssi> <mac> <hex int8: мнимая, вещественная часть на поднесущую>
   Расширения (включаются командами META ON, BLEEXT ON, FTM …):
     RXM WIFI[!] <канал> <rssi> <фмт> <mcs> <bw МГц> <шум> <метка мкс> <hex>   то же, что RX WIFI, плюс поля rx_ctrl
         фмт: 0 11b, 1 11a/g, 2 11n, 3 11ac, 4 11ax (HE)
     RX BLEX <адрес> <rssi> <props> <тип адреса> <phy1> <phy2> <sid> <статус> <hex>   расширенная реклама BLE 5
         props: 1 connectable, 2 scannable, 4 directed, 8 scan response, 16 legacy; phy: 1 1M, 2 2M, 3 coded; статус: 0 полные данные, 1 есть продолжение, 2 обрезано
     FTM <mac> <статус> <rtt_raw 0.1 нс> <rtt_est 0.1 нс> <дистанция см>   измерение дальности 802.11mc
   Кадр разбирается схемой из hex-formats.js (ядро — hex-kernels.js); запись rec несёт hex и hexSchema,
   поэтому её можно отдать в HEX Structure. Имена полей одинаковы для всех протоколов:
   proto, kind, src, dst, net (BSSID / PAN), chan, rssi, + поля пакета (ie.ssid, ad.name, zb_cluster …).
   Проверка: node tools/test-hex.mjs */

const RADIO_SCHEMA={wifi:'wifi', ble:'ble-adv', zb:'ieee802154'};
const RADIO_BLE_EVT=['adv_ind','adv_direct_ind','adv_scan_ind','adv_nonconn_ind','scan_rsp'];
const RADIO_TX_PROTO=['WIFI','BLE','ZB'];
const RADIO_PHY=['11b','11a/g','11n','11ac','11ax'];
const RADIO_BLE_PHY=['','1M','2M','coded'];
const RADIO_FTM_STATUS=['success','unsupported','conf-rejected','no-response','fail','no-valid-measurement'];
const RADIO_C_M_PER_NS=0.299792458;
// legacy-тип события из битов props расширенного отчёта: scan_rsp → 4, connectable+directed → 1, connectable → 0, scannable → 2, иначе 3
const radioLegacyEv=p=>(p&8) ? 4 : (p&1) ? ((p&4) ? 1 : 0) : (p&2) ? 2 : 3;
const _radMac='((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})';

function radioLine(line){
  let m=/^\s*RX WIFI(!?) (\d+) (-?\d+) ([0-9a-fA-F]+)\s*$/.exec(line);
  if(m) return {proto:'wifi', trunc:m[1]==='!', chan:+m[2], rssi:+m[3], bytes:hexFromHex(m[4])};
  m=/^\s*RXM WIFI(!?) (\d+) (-?\d+) (\d) (\d+) (\d+) (-?\d+) (\d+) ([0-9a-fA-F]+)\s*$/.exec(line);
  if(m) return {proto:'wifi', trunc:m[1]==='!', chan:+m[2], rssi:+m[3], bytes:hexFromHex(m[9]),
    meta:{fmt:+m[4], mcs:+m[5], bw:+m[6], noise:+m[7], ts:+m[8]}};
  m=new RegExp('^\\s*RX BLEX '+_radMac+' (-?\\d+) (\\d+) (\\d+) (\\d+) (\\d+) (\\d+) (\\d+) ([0-9a-fA-F]*)\\s*$').exec(line);
  if(m) return {proto:'ble', addr:m[1].toLowerCase(), rssi:+m[2], ext:{props:+m[3], phy1:+m[5], phy2:+m[6], sid:+m[7], status:+m[8]},
    atype:+m[4], evtype:radioLegacyEv(+m[3]), bytes:hexFromHex(m[9])};
  m=new RegExp('^\\s*FTM '+_radMac+' (\\d+) (-?\\d+) (-?\\d+) (-?\\d+)\\s*$').exec(line);
  if(m) return {ftm:true, peer:m[1].toLowerCase(), status:+m[2], rttRaw:+m[3], rttEst:+m[4], distCm:+m[5]};
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

// зеркало radioLine: строка прошивки из полей (для проверки круга «собрали → разобрали» и для Loopback-пресета; в эфир не излучает)
function radioLineBuild(f){
  const hex=hexToHex(f.bytes||[]);
  if(f.ftm) return 'FTM '+f.peer+' '+f.status+' '+f.rttRaw+' '+f.rttEst+' '+f.distCm;
  if(f.proto==='wifi' && f.meta){ const m=f.meta;
    return 'RXM WIFI'+(f.trunc?'!':'')+' '+f.chan+' '+f.rssi+' '+m.fmt+' '+m.mcs+' '+m.bw+' '+m.noise+' '+m.ts+' '+hex; }
  if(f.proto==='ble' && f.ext){ const x=f.ext;
    return 'RX BLEX '+f.addr+' '+f.rssi+' '+x.props+' '+f.atype+' '+x.phy1+' '+x.phy2+' '+x.sid+' '+x.status+' '+hex; }
  if(f.proto==='wifi') return 'RX WIFI'+(f.trunc?'!':'')+' '+f.chan+' '+f.rssi+' '+hex;
  if(f.proto==='ble') return 'RX BLE '+f.addr+' '+f.rssi+' '+f.evtype+' '+f.atype+' '+hex;
  if(f.proto==='zb') return 'RX ZB '+f.chan+' '+f.rssi+' '+f.lqi+' '+hex;
  return null;
}
// FTM: расстояние по SDK (см → м) за вычетом калибровочной поправки offsetM; dist_rtt_m — по сырому RTT (c·t/2) для сверки
function radioFtmRec(f,offsetM,now){
  const ok=f.status===0, off=+offsetM||0;
  const dist=ok ? Math.max(0, Math.round((f.distCm/100-off)*100)/100) : null;
  const rttNs=f.rttEst/10, rawM=ok ? Math.max(0, Math.round((f.rttRaw/10*RADIO_C_M_PER_NS/2-off)*100)/100) : null;
  const st=RADIO_FTM_STATUS[f.status] || 'status '+f.status;
  return {t:now||Date.now(), proto:'wifi', kind:'ftm', id:f.peer, src:f.peer, status:st, ok:ok ? 1 : 0,
    dist_m:dist, dist_rtt_m:rawM, rtt_ns:ok ? Math.round(rttNs*10)/10 : null,
    text:'ftm '+f.peer+' '+(ok ? dist+' m ('+rttNs.toFixed(1)+' ns)' : st)};
}
// команда измерения: «aa:bb:cc:dd:ee:ff [кадров] [канал]» или запись с mac/src/id → «FTM <mac> <кадров> <канал>» (кадров 8…64, канал 0 — текущий)
function radioFtmCmd(src,frames,chan){
  let mac='';
  if(src && typeof src==='object'){ mac=String(src.mac||src.src||src.id||''); if(src.frames) frames=+src.frames; if(src.chan) chan=+src.chan; }
  else { const m=/((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})(?:\s+(\d+))?(?:\s+(\d+))?/.exec(String(src||'')); if(m){ mac=m[1]; if(m[2]) frames=+m[2]; if(m[3]) chan=+m[3]; } }
  if(!/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac)) return null;
  frames=Math.max(8,Math.min(64,Math.round(+frames||16))); chan=Math.max(0,Math.min(200,Math.round(+chan||0)));
  return 'FTM '+mac.toLowerCase()+' '+frames+(chan ? ' '+chan : '');
}

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

// шифрование точки доступа как в airodump-ng: ENC (OPN / WEP / WPA / WPA2 / WPA3 / WPA2/WPA3 / OWE), CIPHER (CCMP / TKIP / GCMP …), AUTH (PSK / SAE / MGT / OWE / OPN)
// по полям Beacon / Probe response: RSN (ie.rsn.akm / pairwise — списки наборов по 4 байта подряд), вендорный WPA и бит Privacy в capabilities
const RADIO_AKM={1:'MGT',2:'PSK',3:'MGT',4:'PSK',5:'MGT',6:'PSK',8:'SAE',9:'SAE',11:'MGT',12:'MGT',18:'OWE'};
const RADIO_CIPHER={1:'WEP40',2:'TKIP',4:'CCMP',5:'WEP104',8:'GCMP',9:'GCMP-256',10:'CCMP-256'};
function radioSuites(hex,names){
  const out=[], s=String(hex||'').toLowerCase();
  for(let i=0;i+8<=s.length;i+=8){ if(s.slice(i,i+6)!=='000fac') continue; const n=names[parseInt(s.slice(i+6,i+8),16)]; if(n && !out.includes(n)) out.push(n); }
  return out;
}
function radioWifiEnc(o){
  const rsn=o['ie.rsn.version']!==undefined, wpa=Object.keys(o).some(k=>/^ie\.wpa\./.test(k));
  const akm=rsn ? radioSuites(o['ie.rsn.akm'],RADIO_AKM) : [], ciph=rsn ? radioSuites(o['ie.rsn.pairwise'],RADIO_CIPHER) : [];
  let enc;
  if(rsn){
    enc=akm.includes('OWE') ? 'OWE' : akm.includes('SAE') ? (akm.includes('PSK') || akm.includes('MGT') ? 'WPA2/WPA3' : 'WPA3') : 'WPA2';
    if(wpa && enc==='WPA2') enc='WPA2/WPA';
  } else if(wpa) enc='WPA';
  else enc=(+o['body.capab']||0)&0x10 ? 'WEP' : 'OPN';
  return {enc, cipher:ciph.join('/'), auth:akm.length ? akm.join('/') : enc==='OPN' ? 'OPN' : ''};
}

function radioRec(f,now){
  const res=hexParse(RADIO_SCHEMA[f.proto],f.bytes), o=hexToRec(res);
  const r={t:now||Date.now(), proto:f.proto, chan:f.chan, rssi:f.rssi, len:f.bytes.length};
  if(f.lqi!==undefined) r.lqi=f.lqi;
  if(f.trunc) r.trunc=1;
  if(f.meta){ const m=f.meta;
    r.phy=RADIO_PHY[m.fmt] || '?'; r.mcs=m.mcs; r.bw=m.bw; r.noise=m.noise; r.snr=f.rssi-m.noise; r.ts_us=m.ts; }
  if(f.ext){ const x=f.ext;
    r.phy=RADIO_BLE_PHY[x.phy1]||'?'; r.phy2=RADIO_BLE_PHY[x.phy2]||''; r.sid=x.sid; r.ext=(x.props&16) ? 0 : 1;
    r.conn=x.props&1 ? 1 : 0; r.scannable=x.props&2 ? 1 : 0; r.partial=x.status===1 ? 1 : 0; if(x.status===2) r.trunc=1; }
  for(const k in o){ if(k[0]==='_' || /\[\d+\]/.test(k)) continue; r[k]=o[k]; }      // без позиционных имён body.ies[3]…
  if(f.proto==='ble'){
    r.src=f.addr; r.addr_type=f.atype ? 'random' : 'public';
    r.kind=f.ext && !(f.ext.props&16) ? (f.ext.props&8 ? 'ext_scan_rsp' : 'ext_adv') : RADIO_BLE_EVT[f.evtype] || 'event '+f.evtype;
    r.name=o['ad.name'] || o['ad.short_name'] || '';
  } else if(f.proto==='wifi' && o['ie.ssid']!==undefined) r.ssid=o['ie.ssid'];
  if(f.proto==='wifi' && (r.kind==='beacon' || r.kind==='probe-resp')) Object.assign(r,radioWifiEnc(o));
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
