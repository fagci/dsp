"use strict";
/* ============================ HEX Structure: готовые схемы ============================
   Тот же JSON, что можно написать руками в узле. Ключ — имя в HEX_LIB; sub ссылается на него по имени.
   title/group — для списка в интерфейсе. */

Object.assign(HEX_LIB,{
  /* ---------- Ethernet / IP ---------- */
  eth:{ title:'Ethernet II', group:'Network', fields:[
    {n:'dst',t:'bytes',fmt:'mac'}, {n:'src',t:'bytes',fmt:'mac'},
    {n:'type',t:'u16',fmt:'hex',enum:{2048:'IPv4',2054:'ARP',34525:'IPv6',33024:'VLAN'}},
    {n:'payload',t:'rest',sub:{by:'type',map:{2048:'ipv4',2054:'arp',34525:'ipv6'}}}]},
  arp:{ title:'ARP', group:'Network', fields:[
    {n:'htype',t:'u16'}, {n:'ptype',t:'u16',fmt:'hex'}, {n:'hlen',t:'u8'}, {n:'plen',t:'u8'},
    {n:'op',t:'u16',enum:{1:'request',2:'reply'}},
    {n:'sha',t:'bytes',fmt:'mac'}, {n:'spa',t:'bytes',fmt:'ipv4'}, {n:'tha',t:'bytes',fmt:'mac'}, {n:'tpa',t:'bytes',fmt:'ipv4'}]},
  ipv4:{ title:'IPv4', group:'Network', fields:[
    {n:'ver',t:'bits',w:4}, {n:'ihl',t:'bits',w:4,calc:'payload.off/4'},
    {n:'dscp',t:'bits',w:6}, {n:'ecn',t:'bits',w:2},
    {n:'len',t:'u16',calc:'_len'}, {n:'id',t:'u16',fmt:'hex'},
    {n:'flags',t:'bits',w:3,flags:{1:'MF',2:'DF'}}, {n:'frag',t:'bits',w:13},
    {n:'ttl',t:'u8'}, {n:'proto',t:'u8',enum:{1:'ICMP',6:'TCP',17:'UDP',58:'ICMPv6'}},
    {n:'csum',t:'u16',fmt:'hex',calc:'inet16',to:'payload'},
    {n:'src',t:'bytes',fmt:'ipv4'}, {n:'dst',t:'bytes',fmt:'ipv4'},
    {n:'opts',t:'bytes',len:'ihl>5 ? (ihl-5)*4 : 0'},
    {n:'payload',t:'rest',sub:{by:'proto',map:{1:'icmp',6:'tcp',17:'udp'}}}]},
  ipv6:{ title:'IPv6', group:'Network', fields:[
    {n:'ver',t:'bits',w:4}, {n:'tc',t:'bits',w:8}, {n:'flow',t:'bits',w:20,fmt:'hex'},
    {n:'plen',t:'u16'}, {n:'next',t:'u8',enum:{6:'TCP',17:'UDP',58:'ICMPv6'}}, {n:'hop',t:'u8'},
    {n:'src',t:'bytes',fmt:'ipv6'}, {n:'dst',t:'bytes',fmt:'ipv6'},
    {n:'payload',t:'rest',sub:{by:'next',map:{6:'tcp',17:'udp'}}}]},
  udp:{ title:'UDP', group:'Network', fields:[
    {n:'sport',t:'u16'}, {n:'dport',t:'u16'}, {n:'len',t:'u16',calc:'_len'}, {n:'csum',t:'u16',fmt:'hex'},
    {n:'data',t:'rest'}]},
  tcp:{ title:'TCP', group:'Network', fields:[
    {n:'sport',t:'u16'}, {n:'dport',t:'u16'}, {n:'seq',t:'u32'}, {n:'ack',t:'u32'},
    {n:'off',t:'bits',w:4,calc:'data.off/4'}, {n:'rsv',t:'bits',w:3},
    {n:'flags',t:'bits',w:9,flags:{0:'FIN',1:'SYN',2:'RST',3:'PSH',4:'ACK',5:'URG',6:'ECE',7:'CWR',8:'NS'}},
    {n:'win',t:'u16'}, {n:'csum',t:'u16',fmt:'hex'}, {n:'urg',t:'u16'},
    {n:'opts',t:'bytes',len:'off>5 ? (off-5)*4 : 0'}, {n:'data',t:'rest'}]},
  icmp:{ title:'ICMP', group:'Network', fields:[
    {n:'type',t:'u8',enum:{0:'echo reply',3:'unreachable',8:'echo request',11:'time exceeded'}}, {n:'code',t:'u8'},
    {n:'csum',t:'u16',fmt:'hex',calc:'inet16'}, {n:'body',t:'rest'}]},

  /* ---------- Wi-Fi (IEEE 802.11, кадр как есть: порядок бит LSB, little-endian) ---------- */
  wifi:{ title:'802.11 frame', group:'Wi-Fi', endian:'le', bitorder:'lsb', fields:[
    {n:'ver',t:'bits',w:2}, {n:'type',t:'bits',w:2,enum:{0:'management',1:'control',2:'data'}}, {n:'subtype',t:'bits',w:4},
    {n:'tods',t:'bits',w:1}, {n:'fromds',t:'bits',w:1}, {n:'morefrag',t:'bits',w:1}, {n:'retry',t:'bits',w:1},
    {n:'pwr',t:'bits',w:1}, {n:'moredata',t:'bits',w:1}, {n:'prot',t:'bits',w:1}, {n:'order',t:'bits',w:1},
    {n:'dur',t:'u16'},
    {n:'addr1',t:'bytes',fmt:'mac'},
    {n:'addr2',t:'bytes',fmt:'mac',when:'!(type==1 && (subtype==12 || subtype==13))'},
    {n:'addr3',t:'bytes',fmt:'mac',when:'type!=1'},
    {n:'frag',t:'bits',w:4,when:'type!=1'}, {n:'seq',t:'bits',w:12,when:'type!=1'},
    {n:'addr4',t:'bytes',fmt:'mac',when:'type==2 && tods && fromds'},
    {n:'qos',t:'u16',fmt:'hex',when:'type==2 && (subtype&8)'},
    {n:'body',t:'rest',sub:{by:'type==0 ? subtype : 99',map:{4:'wifi-probe-req',5:'wifi-beacon',8:'wifi-beacon',10:'wifi-reason',11:'wifi-auth',12:'wifi-reason'}}}]},
  'wifi-beacon':{ title:'Beacon / Probe response', group:'Wi-Fi', endian:'le', fields:[
    {n:'ts',t:'u64'}, {n:'interval',t:'u16'},
    {n:'capab',t:'u16',fmt:'hex'}, {n:'ies',t:'list',sub:'wifi-ie'}]},
  'wifi-probe-req':{ title:'Probe request', group:'Wi-Fi', endian:'le', fields:[{n:'ies',t:'list',sub:'wifi-ie'}]},
  'wifi-reason':{ title:'Deauth / Disassoc', group:'Wi-Fi', endian:'le', fields:[{n:'reason',t:'u16'}]},
  'wifi-auth':{ title:'Authentication', group:'Wi-Fi', endian:'le', fields:[
    {n:'algo',t:'u16'}, {n:'seq',t:'u16'}, {n:'status',t:'u16'}, {n:'ies',t:'list',sub:'wifi-ie'}]},
  'wifi-ie':{ title:'Information element', group:'Wi-Fi', fields:[
    {n:'id',t:'u8',enum:{0:'SSID',1:'Rates',3:'DS channel',5:'TIM',7:'Country',48:'RSN',50:'Ext rates',221:'Vendor'}},
    {n:'len',t:'u8'},
    {n:'data',t:'bytes',len:'len',sub:{by:'id',map:{0:'wifi-ie-ssid',3:'wifi-ie-chan'}}}]},
  'wifi-ie-ssid':{ fields:[{n:'ssid',t:'str',len:'rest',enc:'utf8'}]},
  'wifi-ie-chan':{ fields:[{n:'channel',t:'u8'}]},

  /* ---------- DMR (ETSI TS 102 361-2), байты после декодирования FEC ---------- */
  'dmr-slottype':{ title:'DMR Slot Type', group:'DMR', fields:[
    {n:'cc',t:'bits',w:4},
    {n:'dt',t:'bits',w:4,enum:{0:'PI Header',1:'Voice LC Header',2:'Terminator with LC',3:'CSBK',4:'MBC Header',5:'MBC Continuation',
      6:'Data Header',7:'Rate 1/2 Data',8:'Rate 3/4 Data',9:'Idle',10:'Rate 1 Data'}}]},
  'dmr-lc':{ title:'DMR Link Control (9 B + RS)', group:'DMR', fields:[
    {n:'pf',t:'bits',w:1}, {n:'r',t:'bits',w:1},
    {n:'flco',t:'bits',w:6,enum:{0:'Group voice',3:'Unit to unit voice',48:'Terminator: data',49:'Terminator: voice'}},
    {n:'fid',t:'u8',fmt:'hex'}, {n:'svc',t:'u8',fmt:'bin'},
    {n:'dst',t:'u24'}, {n:'src',t:'u24'},
    {n:'rs',t:'bytes',len:3,when:'_left>=3'}]},
  'dmr-csbk':{ title:'DMR CSBK', group:'DMR', fields:[
    {n:'lb',t:'bits',w:1}, {n:'pf',t:'bits',w:1},
    {n:'csbko',t:'bits',w:6,fmt:'hex',enum:{4:'Unit to unit voice request',5:'Unit to unit answer response',7:'BS outbound activation',61:'Preamble'}},
    {n:'fid',t:'u8',fmt:'hex'}, {n:'data',t:'bytes',len:8}, {n:'crc',t:'u16',fmt:'hex'}]},

  'dmr-pi':{ title:'DMR PI header', group:'DMR', fields:[
    {n:'alg',t:'u8',fmt:'hex'}, {n:'fid',t:'u8',fmt:'hex'}, {n:'key',t:'u8'}, {n:'mi',t:'bytes',len:4},
    {n:'dst',t:'u24'}, {n:'crc',t:'u16',fmt:'hex'}]},

  /* ---------- ADS-B / Mode S (112 бит) ---------- */
  adsb:{ title:'ADS-B / Mode S long', group:'Aviation', fields:[
    {n:'df',t:'bits',w:5,enum:{11:'all-call reply',17:'ADS-B',18:'TIS-B / ADS-R',20:'Comm-B altitude',21:'Comm-B identity'}},
    {n:'ca',t:'bits',w:3}, {n:'icao',t:'bytes',len:3},
    {n:'tc',t:'bits',w:5},
    {n:'cat',t:'bits',w:3,when:'tc>=1 && tc<=4'},
    {n:'callsign',t:'str6',len:8,when:'tc>=1 && tc<=4'},
    {n:'ss',t:'bits',w:2,when:'tc>=9 && tc<=18'}, {n:'nicsb',t:'bits',w:1,when:'tc>=9 && tc<=18'},
    {n:'alt',t:'bits',w:12,when:'tc>=9 && tc<=18'}, {n:'time',t:'bits',w:1,when:'tc>=9 && tc<=18'},
    {n:'cpr',t:'bits',w:1,when:'tc>=9 && tc<=18'},
    {n:'lat',t:'bits',w:17,when:'tc>=9 && tc<=18'}, {n:'lon',t:'bits',w:17,when:'tc>=9 && tc<=18'},
    {n:'me',t:'bits',w:51,when:'!((tc>=1 && tc<=4) || (tc>=9 && tc<=18))'},
    {n:'pi',t:'bits',w:24,fmt:'hex',calc:'crc24-adsb',to:'pi'}]},
  'adsb-short':{ title:'Mode S short', group:'Aviation', fields:[
    {n:'df',t:'bits',w:5}, {n:'fs',t:'bits',w:3}, {n:'dr',t:'bits',w:5}, {n:'um',t:'bits',w:6},
    {n:'ac',t:'bits',w:13}, {n:'ap',t:'bits',w:24,fmt:'hex'}]},

  /* ---------- Для проверки и примеров ---------- */
  'esp-pkt':{ title:'ESP32 sniffer record', group:'Wi-Fi', endian:'le', fields:[
    {n:'rssi',t:'i8',fmt:'dbm'}, {n:'chan',t:'u8'}, {n:'len',t:'u16'},
    {n:'frame',t:'bytes',len:'len',sub:'wifi'}]}
});
