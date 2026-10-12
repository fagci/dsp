"use strict";
/* ============================ Wi-Fi сниффер: разбор строк ============================
   Строка прошивки tools/wifi-sniffer-esp32: WIFI,<канал>,<rssi>,<hex кадра 802.11 без FCS>.
   Кадр разбирается схемой 'wifi' из hex-formats.js (ядро — hex-kernels.js); запись rec несёт hex и hexSchema,
   поэтому её можно отдать в HEX Structure. Проверка: node tools/test-hex.mjs */

const WIFI_SUB={ 0:{0:'assoc-req',1:'assoc-resp',2:'reassoc-req',3:'reassoc-resp',4:'probe-req',5:'probe-resp',8:'beacon',10:'disassoc',11:'auth',12:'deauth',13:'action'},
  1:{8:'block-ack-req',9:'block-ack',10:'ps-poll',11:'rts',12:'cts',13:'ack'},
  2:{0:'data',4:'null',8:'qos-data',12:'qos-null'} };
const WIFI_TYPE=['mgmt','ctrl','data','ext'];
function wifiLine(line){
  const m=/^\s*WIFI,(\d+),(-?\d+),([0-9a-fA-F]+)\s*$/.exec(line);
  if(m) return {chan:+m[1], rssi:+m[2], bytes:hexFromHex(m[3])};
  return null;
}
function wifiBssid(v){
  if(v.type===0) return v.addr3;
  if(v.type===2) return v.tods && v.fromds ? '' : v.tods ? v.addr1 : v.fromds ? v.addr2 : v.addr3;
  return '';
}
// кадр → запись rec
function wifiRec(frame,now){
  const res=hexParse('wifi',frame.bytes), v=res.vals;
  const sub=(WIFI_SUB[v.type]||{})[v.subtype] || 'subtype '+v.subtype;
  const r={t:now||Date.now(), src:'WiFi', kind:sub, ftype:WIFI_TYPE[v.type]||'?', chan:frame.chan, rssi:frame.rssi, len:frame.bytes.length,
    da:v.addr1, sa:v.addr2, bssid:wifiBssid(v), seq:v.seq, retry:v.retry, protected:v.prot,
    hex:hexToHex(frame.bytes), hexSchema:'wifi'};
  if(v.type===0 && (v.subtype===8 || v.subtype===5 || v.subtype===4)){
    let sec=null;
    for(let i=0;v['body.ies['+i+'].id']!==undefined;i++){
      const id=v['body.ies['+i+'].id'];
      if(id===0 && r.ssid===undefined) r.ssid=v['body.ies['+i+'].data.ssid']||'';
      else if(id===3) r.ap_chan=v['body.ies['+i+'].data.channel'];
      else if(id===48) sec='WPA2/3';
      else if(id===221 && !sec && /^0050f2/i.test(String(v['body.ies['+i+'].data']||''))) sec='WPA';
    }
    if(v.subtype!==4){ r.security=sec || ((v['body.capab']&0x10) ? 'WEP' : 'open'); r.interval=v['body.interval']; }
  }
  if(v.type===0 && v.subtype===12 || v.subtype===10 && v.type===0) r.reason=v['body.reason'];
  r.id=(r.bssid||r.sa||'?')+(r.ssid!==undefined && r.kind==='beacon' ? ' '+r.ssid : '');
  r.text=r.kind+' '+(r.sa||r.da||'')+(r.ssid ? ' "'+r.ssid+'"' : '')+' ch'+frame.chan+' '+frame.rssi+' dBm';
  return r;
}
