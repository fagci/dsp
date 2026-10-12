"use strict";
/* ============================ HEX Structure: готовые схемы ============================
   Тот же JSON, что можно написать руками в узле. Ключ — имя в HEX_LIB; sub ссылается на него по имени.
   title/group — для списка в интерфейсе. */

Object.assign(HEX_LIB,{
  /* ---------- Ethernet / IP ---------- */
  eth:{ title:'Ethernet II', group:'Network', detect:'_size>=14 && (type==2048 || type==2054 || type==34525)', fields:[
    {n:'dst',t:'bytes',fmt:'mac'}, {n:'src',t:'bytes',fmt:'mac'},
    {n:'type',t:'u16',fmt:'hex',enum:{2048:'IPv4',2054:'ARP',34525:'IPv6',33024:'VLAN'}},
    {n:'payload',t:'rest',sub:{by:'type',map:{2048:'ipv4',2054:'arp',34525:'ipv6'}}}]},
  arp:{ title:'ARP', group:'Network', detect:'htype==1 && ptype==2048 && hlen==6 && plen==4 && _size==28', fields:[
    {n:'htype',t:'u16'}, {n:'ptype',t:'u16',fmt:'hex'}, {n:'hlen',t:'u8'}, {n:'plen',t:'u8'},
    {n:'op',t:'u16',enum:{1:'request',2:'reply'}},
    {n:'sha',t:'bytes',fmt:'mac'}, {n:'spa',t:'bytes',fmt:'ipv4'}, {n:'tha',t:'bytes',fmt:'mac'}, {n:'tpa',t:'bytes',fmt:'ipv4'}]},
  ipv4:{ title:'IPv4', group:'Network', detect:'ver==4 && ihl>=5 && len==_size', fields:[
    {n:'ver',t:'bits',w:4}, {n:'ihl',t:'bits',w:4,calc:'payload.$off/4'},
    {n:'dscp',t:'bits',w:6}, {n:'ecn',t:'bits',w:2},
    {n:'len',t:'u16',calc:'_len'}, {n:'id',t:'u16',fmt:'hex'},
    {n:'flags',t:'bits',w:3,flags:{1:'MF',2:'DF'}}, {n:'frag',t:'bits',w:13},
    {n:'ttl',t:'u8'}, {n:'proto',t:'u8',enum:{1:'ICMP',6:'TCP',17:'UDP',58:'ICMPv6'}},
    {n:'csum',t:'u16',fmt:'hex',calc:'inet16',to:'payload'},
    {n:'src',t:'bytes',fmt:'ipv4'}, {n:'dst',t:'bytes',fmt:'ipv4'},
    {n:'opts',t:'bytes',len:'ihl>5 ? (ihl-5)*4 : 0'},
    {n:'payload',t:'rest',sub:{by:'proto',map:{1:'icmp',6:'tcp',17:'udp'}}}]},
  ipv6:{ title:'IPv6', group:'Network', detect:'ver==6 && plen+40==_size', fields:[
    {n:'ver',t:'bits',w:4}, {n:'tc',t:'bits',w:8}, {n:'flow',t:'bits',w:20,fmt:'hex'},
    {n:'plen',t:'u16',calc:'payload.$len'}, {n:'next',t:'u8',enum:{6:'TCP',17:'UDP',58:'ICMPv6'}}, {n:'hop',t:'u8'},
    {n:'src',t:'bytes',fmt:'ipv6'}, {n:'dst',t:'bytes',fmt:'ipv6'},
    {n:'payload',t:'rest',sub:{by:'next',map:{6:'tcp',17:'udp',58:'icmpv6'}}}]},
  udp:{ title:'UDP', group:'Network', fields:[
    {n:'sport',t:'u16'}, {n:'dport',t:'u16'}, {n:'len',t:'u16',calc:'_len'},
    {n:'csum',t:'u16',fmt:'hex',calc:'inet16',pseudo:{proto:17},zeroFF:true,optional:true},
    {n:'data',t:'rest'}]},
  tcp:{ title:'TCP', group:'Network', fields:[
    {n:'sport',t:'u16'}, {n:'dport',t:'u16'}, {n:'seq',t:'u32'}, {n:'ack',t:'u32'},
    {n:'off',t:'bits',w:4,calc:'data.$off/4'}, {n:'rsv',t:'bits',w:3},
    {n:'flags',t:'bits',w:9,flags:{0:'FIN',1:'SYN',2:'RST',3:'PSH',4:'ACK',5:'URG',6:'ECE',7:'CWR',8:'NS'}},
    {n:'win',t:'u16'}, {n:'csum',t:'u16',fmt:'hex',calc:'inet16',pseudo:{proto:6}}, {n:'urg',t:'u16'},
    {n:'opts',t:'bytes',len:'off>5 ? (off-5)*4 : 0'}, {n:'data',t:'rest'}]},
  icmpv6:{ title:'ICMPv6', group:'Network', fields:[
    {n:'type',t:'u8',enum:{1:'unreachable',3:'time exceeded',128:'echo request',129:'echo reply',133:'router solicitation',134:'router advertisement',135:'neighbor solicitation',136:'neighbor advertisement'}},
    {n:'code',t:'u8'}, {n:'csum',t:'u16',fmt:'hex',calc:'inet16',pseudo:{proto:58}}, {n:'body',t:'rest'}]},
  icmp:{ title:'ICMP', group:'Network', fields:[
    {n:'type',t:'u8',enum:{0:'echo reply',3:'unreachable',8:'echo request',11:'time exceeded'}}, {n:'code',t:'u8'},
    {n:'csum',t:'u16',fmt:'hex',calc:'inet16'}, {n:'body',t:'rest'}]},

  /* ---------- Wi-Fi (IEEE 802.11, кадр как есть: порядок бит LSB, little-endian) ---------- */
  wifi:{ title:'802.11 frame', group:'Wi-Fi', detect:'ver==0 && _size>=10', endian:'le', bitorder:'lsb', fields:[
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
  adsb:{ title:'ADS-B / Mode S long', group:'Aviation', detect:'_size==14 && (df==17 || df==18)', fields:[
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
  'adsb-short':{ title:'Mode S short', group:'Aviation', detect:'_size==7', fields:[
    {n:'df',t:'bits',w:5}, {n:'fs',t:'bits',w:3}, {n:'dr',t:'bits',w:5}, {n:'um',t:'bits',w:6},
    {n:'ac',t:'bits',w:13}, {n:'ap',t:'bits',w:24,fmt:'hex'}]},

  /* ---------- AIS (ITU-R M.1371), биты сообщения без CRC ---------- */
  ais:{ title:'AIS message', group:'Marine', fields:(()=>{
    const A='@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';
    const b=(n,w,when,o)=>Object.assign({n,t:'bits',w,when},o||{});
    const pad=(w,when)=>({t:'pad',w,when});
    const s6=(n,len,when)=>({n,t:'str6',len,cs:A,pad:'@',trim:true,when});
    const lon=(n,when)=>b(n,28,when,{signed:true,scale:1/600000,prec:5,unit:'°'});
    const lat=(n,when)=>b(n,27,when,{signed:true,scale:1/600000,prec:5,unit:'°'});
    const P='type>=1 && type<=3', B='type==18', S='type==5', BS='type==4 || type==11', A24='type==24', N21='type==21';
    return [
      {n:'type',t:'bits',w:6,enum:{1:'position A',2:'position A (assigned)',3:'position A (interrogated)',4:'base station',5:'static and voyage',9:'SAR aircraft',11:'UTC response',18:'position B',19:'position B extended',21:'aid to navigation',24:'static B'}},
      b('repeat',2), b('mmsi',30),
      // 1–3
      b('status',4,P,{enum:{0:'under way (engine)',1:'at anchor',2:'not under command',3:'restricted manoeuvrability',4:'constrained by draught',5:'moored',6:'aground',7:'fishing',8:'under way (sailing)',15:'not defined'}}),
      b('rot',8,P,{signed:true}), b('sog',10,P,{scale:.1,unit:'kn'}), b('acc',1,P),
      lon('lon',P), lat('lat',P), b('cog',12,P,{scale:.1,unit:'°'}), b('hdg',9,P), b('ts',6,P),
      b('maneuver',2,P), pad(3,P), b('raim',1,P), b('radio',19,P,{fmt:'hex'}),
      // 4, 11
      b('year',14,BS), b('month',4,BS), b('day',5,BS), b('hour',5,BS), b('min',6,BS), b('sec',6,BS), b('acc',1,BS),
      lon('lon',BS), lat('lat',BS), b('epfd',4,BS), pad(10,BS), b('raim',1,BS), b('radio',19,BS,{fmt:'hex'}),
      // 5
      b('version',2,S), b('imo',30,S), s6('callsign',7,S), s6('name',20,S),
      b('shiptype',8,S), b('bow',9,S), b('stern',9,S), b('port',6,S), b('stbd',6,S), b('epfd',4,S),
      b('etamon',4,S), b('etaday',5,S), b('etahour',5,S), b('etamin',6,S), b('draught',8,S,{scale:.1,unit:'m'}),
      s6('dest',20,S), b('dte',1,S), pad(1,S),
      // 18
      b('reserved',8,B), b('sog',10,B,{scale:.1,unit:'kn'}), b('acc',1,B), lon('lon',B), lat('lat',B),
      b('cog',12,B,{scale:.1,unit:'°'}), b('hdg',9,B), b('ts',6,B), b('regional',2,B), b('cs',1,B), b('display',1,B),
      b('dsc',1,B), b('band',1,B), b('msg22',1,B), b('assigned',1,B), b('raim',1,B), b('radio',20,B,{fmt:'hex'}),
      // 21
      b('aton',5,N21), s6('name',20,N21), b('acc',1,N21), lon('lon',N21), lat('lat',N21),
      b('bow',9,N21), b('stern',9,N21), b('port',6,N21), b('stbd',6,N21), b('epfd',4,N21), b('ts',6,N21),
      // 24
      b('part',2,A24), s6('name',20,A24+' && part==0'),
      b('shiptype',8,'type==24 && part==1'), pad(42,'type==24 && part==1'),
      s6('callsign',7,'type==24 && part==1'), b('bow',9,'type==24 && part==1'), b('stern',9,'type==24 && part==1'),
      b('port',6,'type==24 && part==1'), b('stbd',6,'type==24 && part==1'),
    ]; })()},
  raw:{ title:'Raw bytes', group:'Other', fields:[{n:'data',t:'rest'}]},
  radiotap:{ title:'Radiotap + 802.11', group:'Wi-Fi', endian:'le', fields:[
    {n:'ver',t:'u8'}, {n:'pad',t:'u8'}, {n:'len',t:'u16'}, {n:'hdr',t:'bytes',len:'len-4'},
    {n:'frame',t:'rest',sub:'wifi'}]},

  /* ---------- POCSAG: кодовые слова сообщения (адресное, затем слова данных) ---------- */
  pocsag:{ title:'POCSAG message', group:'Paging', fields:[
    {n:'flag',t:'bits',w:1}, {n:'addr',t:'bits',w:18}, {n:'func',t:'bits',w:2,enum:{0:'numeric / A',1:'tone / B',2:'C',3:'alpha / D'}},
    {n:'bch',t:'bits',w:10,fmt:'hex',calc:'pocsag-bch'}, {n:'par',t:'bits',w:1,calc:'parity32'},
    {n:'cw',t:'list',sub:'pocsag-cw'}]},
  'pocsag-cw':{ title:'POCSAG codeword', group:'Paging', detect:'_size==4', fields:[
    {n:'flag',t:'bits',w:1}, {n:'data',t:'bits',w:20,fmt:'hex'},
    {n:'bch',t:'bits',w:10,fmt:'hex',calc:'pocsag-bch'}, {n:'par',t:'bits',w:1,calc:'parity32'}]},

  /* ---------- ACARS (VHF), блок без битов чётности + BCS ---------- */
  acars:{ title:'ACARS block', group:'Aviation', endian:'le', fields:[
    {n:'mode',t:'str',len:1}, {n:'reg',t:'str',len:7}, {n:'ack',t:'u8',fmt:'hex'}, {n:'label',t:'str',len:2}, {n:'blk',t:'u8',fmt:'hex'},
    {n:'stx',t:'u8',fmt:'hex',when:'_left>3'},
    {n:'msgno',t:'str',len:4,when:'_left>3 && blk>=48 && blk<=57'}, {n:'flight',t:'str',len:6,when:'_left>3 && blk>=48 && blk<=57'},
    {n:'text',t:'str',len:'_left>3 ? _left-3 : 0',when:'_left>3'},
    {n:'end',t:'u8',fmt:'hex',enum:{3:'ETX',23:'ETB'}}, {n:'bcs',t:'u16',fmt:'hex'}]},

  /* ---------- Bluetooth LE: структуры AD рекламы (Core Spec Part A, GAP) ---------- */
  'ble-adv':{ title:'BLE advertising data', group:'Bluetooth', fields:[{n:'ad',t:'list',sub:'ble-ad'}]},
  'ble-ad':{ title:'BLE AD structure', group:'Bluetooth', endian:'le', fields:[
    {n:'len',t:'u8'},
    {n:'type',t:'u8',fmt:'hex',when:'len>0',enum:{1:'Flags',2:'UUID16 (more)',3:'UUID16',6:'UUID128 (more)',7:'UUID128',8:'Short name',9:'Name',10:'TX power',22:'Service data 16',25:'Appearance',33:'Service data 128',255:'Manufacturer'}},
    {n:'data',t:'bytes',len:'len-1',when:'len>0',sub:{by:'type',map:{1:'ble-ad-flags',8:'ble-ad-name',9:'ble-ad-name',10:'ble-ad-tx',22:'ble-ad-svc16',255:'ble-ad-mfr'}}}]},
  'ble-ad-flags':{ fields:[{n:'flags',t:'u8',flags:{0:'LE limited discoverable',1:'LE general discoverable',2:'BR/EDR not supported',3:'LE+BR/EDR controller',4:'LE+BR/EDR host'}}]},
  'ble-ad-name':{ fields:[{n:'name',t:'str',len:'rest',enc:'utf8'}]},
  'ble-ad-tx':{ fields:[{n:'tx',t:'i8',fmt:'dbm'}]},
  'ble-ad-mfr':{ endian:'le', fields:[
    {n:'company',t:'u16',fmt:'hex',enum:{6:'Microsoft',76:'Apple',117:'Samsung',224:'Google',89:'Nordic Semiconductor',741:'Espressif',301:'Xiaomi'}},
    {n:'b0',t:'u8',fmt:'hex',when:'_left>0'},
    {n:'blen',t:'u8',when:'company==76 && b0==2 && _left>0'},
    {n:'uuid',t:'bytes',len:16,when:'company==76 && b0==2 && blen==21 && _left>=21'},
    {n:'major',t:'u16',endian:'be',when:'company==76 && b0==2 && blen==21 && _left>=5'},
    {n:'minor',t:'u16',endian:'be',when:'company==76 && b0==2 && blen==21 && _left>=3'},
    {n:'tx',t:'i8',fmt:'dbm',when:'company==76 && b0==2 && blen==21 && _left>=1'},
    {n:'rest',t:'bytes',len:'_left'}]},
  'ble-ad-svc16':{ endian:'le', fields:[
    {n:'uuid',t:'u16',fmt:'hex',enum:{65194:'Eddystone',64791:'Exposure Notification',65197:'Tile'}},
    {n:'etype',t:'u8',fmt:'hex',when:'uuid==65194 && _left>0',enum:{0:'UID',16:'URL',32:'TLM',48:'EID'}},
    {n:'etx',t:'i8',fmt:'dbm',when:'uuid==65194 && (etype==0 || etype==16) && _left>0'},
    {n:'ns',t:'bytes',len:10,when:'uuid==65194 && etype==0 && _left>=16'}, {n:'inst',t:'bytes',len:6,when:'uuid==65194 && etype==0 && _left>=6'},
    {n:'scheme',t:'u8',when:'uuid==65194 && etype==16 && _left>0',enum:{0:'http://www.',1:'https://www.',2:'http://',3:'https://'}},
    {n:'url',t:'str',len:'rest',when:'uuid==65194 && etype==16'},
    {n:'rest',t:'bytes',len:'_left'}]},

  /* ---------- GSM: L2-сообщение BCCH (23 байта после деперемежения и FIRE CRC), TS 44.018 ---------- */
  'gsm-l2':{ title:'GSM BCCH L2 message (System Information)', group:'GSM', fields:[
    {n:'li',t:'bits',w:6}, {n:'m',t:'bits',w:1}, {n:'el',t:'bits',w:1},
    {n:'skip',t:'bits',w:4}, {n:'pd',t:'bits',w:4,enum:{6:'RR'}},
    {n:'mt',t:'u8',fmt:'hex',enum:{0:'SI13',2:'SI2bis',3:'SI2ter',7:'SI2quater',25:'SI1',26:'SI2',27:'SI3',28:'SI4'}},
    {n:'ci',t:'u16',when:'mt==27'},
    {n:'plmn',t:'bytes',fmt:'plmn',when:'mt==27 || mt==28'}, {n:'lac',t:'u16',when:'mt==27 || mt==28'},
    {n:'ctrl',t:'bytes',len:3,when:'mt==27'}, {n:'copt',t:'u8',fmt:'hex',when:'mt==27'},
    {n:'csel',t:'bytes',len:2,when:'mt==27 || mt==28'},
    {n:'freqs',t:'bytes',len:16,when:'mt==25 || mt==26'}, {n:'ncc',t:'u8',fmt:'hex',when:'mt==26'},
    {n:'rach',t:'bytes',len:3,when:'mt==25 || mt==26 || mt==27 || mt==28'},
    {n:'rest',t:'bytes',len:'_left'}]},

  /* ---------- M17 (M17 Specification v2) ---------- */
  'm17-lsf':{ title:'M17 link setup frame (LSF)', group:'M17', fields:[
    {n:'dst',t:'bytes',fmt:'m17call'}, {n:'src',t:'bytes',fmt:'m17call'},
    {n:'rsv',t:'bits',w:4}, {n:'signed',t:'bits',w:1}, {n:'can',t:'bits',w:4}, {n:'sub',t:'bits',w:2,enum:{0:'text',1:'GNSS position',2:'extended callsigns'}},
    {n:'enc',t:'bits',w:2,enum:{0:'none',1:'scrambler',2:'AES',3:'other'}}, {n:'dtype',t:'bits',w:2,enum:{1:'data',2:'voice',3:'voice + data'}},
    {n:'stream',t:'bits',w:1,enum:{0:'packet',1:'stream'}},
    {n:'meta',t:'bytes',len:14}, {n:'crc',t:'u16',fmt:'hex',calc:'crc16-m17',to:'crc'}]},
  'm17-pkt':{ title:'M17 packet', group:'M17', fields:[
    {n:'proto',t:'u8',enum:{0:'RAW',1:'AX.25',2:'APRS',3:'6LoWPAN',4:'IPv4',5:'SMS',6:'Winlink'}},
    {n:'data',t:'rest',sub:{by:'proto',map:{4:'ipv4'}}}]},

  /* ---------- P25 Phase 1 (TIA-102.BAAA) ---------- */
  'p25-tsbk':{ title:'P25 TSBK', group:'P25', fields:(()=>{
    const b=(n,w,when,o)=>Object.assign({n,t:'bits',w,when},o||{}), pad=(w,when)=>({t:'pad',w,when});
    const G='op==0', U='op==2', X='op==3', C='op==31 || op==32', R='op==44', S='op==58', N='op==59', A='op==60', V='op==56', J='op==57 || op==41';
    const known='op==0||op==2||op==3||op==31||op==32||op==44||op==58||op==59||op==60||op==56||op==57||op==41';
    return [
      b('lb',1), b('prot',1),
      b('op',6,undefined,{fmt:'hex',enum:{0:'GRP_V_CH_GRANT',2:'GRP_V_CH_GRANT_UPDT',3:'GRP_V_CH_GRANT_UPDT_EXP',4:'UU_V_CH_GRANT',5:'UU_ANS_REQ',6:'UU_V_CH_GRANT_UPDT',8:'TELE_INT_CH_GRANT',
        20:'SN-DAT_CHN_GNT',22:'SN-DAT_CHN_ANN',31:'CALL_ALERT',32:'ACK_RSP_FNE',33:'QUE_RSP',36:'EXT_FNCT_CMD',39:'DENY_RSP',40:'GRP_AFF_RSP',41:'SCCB_EXP',42:'GRP_AFF_Q',
        43:'LOC_REG_RSP',44:'U_REG_RSP',45:'U_REG_CMD',46:'AUTH_CMD',47:'U_DE_REG_ACK',51:'IDEN_UP_TDMA',52:'IDEN_UP_VU',53:'TIME_DATE_ANN',56:'SYS_SRV_BCST',57:'SCCB',
        58:'RFSS_STS_BCST',59:'NET_STS_BCST',60:'ADJ_STS_BCST',61:'IDEN_UP'}}),
      b('mfid',8,undefined,{fmt:'hex'}),
      // 0x00 GRP_V_CH_GRANT
      b('opts',8,G,{fmt:'hex'}), b('ch',16,G,{fmt:'hex'}), b('to',16,G), b('from',24,G),
      // 0x02 GRP_V_CH_GRANT_UPDT
      b('ch1',16,U,{fmt:'hex'}), b('to1',16,U), b('ch2',16,U,{fmt:'hex'}), b('to2',16,U),
      // 0x03 explicit
      b('opts',8,X,{fmt:'hex'}), pad(8,X), b('ch',16,X,{fmt:'hex'}), b('chrx',16,X,{fmt:'hex'}), b('to',16,X),
      // 0x1F CALL_ALERT / 0x20 ACK_RSP_FNE
      pad(8,C+' && op==31'), b('svc',8,'op==32',{fmt:'hex'}), pad(8,C), b('to',24,C), b('from',24,C),
      // 0x2C U_REG_RSP
      pad(2,R), b('rv',2,R), b('sysid',12,R,{fmt:'hex'}), b('sid',24,R), b('from',24,R),
      // 0x3A RFSS_STS_BCST
      b('lra',8,S), pad(4,S), b('sysid',12,S,{fmt:'hex'}), b('rfss',8,S), b('site',8,S), b('ch',16,S,{fmt:'hex'}), b('svc',8,S,{fmt:'hex'}),
      // 0x3B NET_STS_BCST
      b('lra',8,N), b('wacn',20,N,{fmt:'hex'}), b('sysid',12,N,{fmt:'hex'}), b('ch',16,N,{fmt:'hex'}), b('svc',8,N,{fmt:'hex'}),
      // 0x3C ADJ_STS_BCST
      b('lra',8,A), b('cfva',4,A), b('sysid',12,A,{fmt:'hex'}), b('rfss',8,A), b('site',8,A), b('ch',16,A,{fmt:'hex'}), pad(8,A),
      // 0x38 SYS_SRV_BCST
      pad(8,V), b('svcavail',24,V,{fmt:'hex'}), b('svcsupp',24,V,{fmt:'hex'}), b('prio',8,V),
      // 0x39 SCCB
      b('rfss',8,J), b('site',8,J), b('ch1',16,J,{fmt:'hex'}), pad(8,J), b('ch2',16,J,{fmt:'hex'}), pad(8,J),
      // остальные
      {n:'data',t:'bytes',len:8,when:'!('+known+')'}
    ];
  })().concat([{n:'crc',t:'u16',fmt:'hex',calc:'crc16-gsm',to:'crc',when:'1'}])},
  'p25-lc':{ title:'P25 Link Control', group:'P25', fields:[
    {n:'prot',t:'bits',w:1}, {n:'explicit',t:'bits',w:1},
    {n:'lcf',t:'bits',w:6,enum:{0:'group voice',3:'unit-to-unit voice',15:'call termination'}}, {n:'mfid',t:'u8',fmt:'hex'},
    {n:'svc',t:'u8',fmt:'hex',when:'lcf==0 || lcf==3',flags:{7:'emergency',6:'encrypted',5:'duplex',4:'packet'}},
    {n:'rsv',t:'u8',when:'lcf==0'}, {n:'to',t:'u16',when:'lcf==0'},
    {n:'to',t:'u24',when:'lcf==3 || lcf==15'}, {n:'from',t:'u24',when:'lcf==0 || lcf==3 || lcf==15'},
    {n:'data',t:'bytes',len:'_left',when:'lcf!=0 && lcf!=3 && lcf!=15'}]},
  'p25-hdu':{ title:'P25 header data unit', group:'P25', fields:[
    {n:'mi',t:'bytes',len:9}, {n:'mfid',t:'u8',fmt:'hex'},
    {n:'algid',t:'u8',fmt:'hex',enum:{128:'clear',129:'DES-OFB',131:'3DES',132:'AES-256',170:'ADP RC4',159:'DES-XL',160:'DVI-XL'}},
    {n:'kid',t:'u16',fmt:'hex'}, {n:'tgid',t:'u16'}]},

  /* ---------- Для проверки и примеров ---------- */
  'esp-pkt':{ title:'ESP32 sniffer record', group:'Wi-Fi', endian:'le', fields:[
    {n:'rssi',t:'i8',fmt:'dbm'}, {n:'chan',t:'u8'}, {n:'len',t:'u16'},
    {n:'frame',t:'bytes',len:'len',sub:'wifi'}]}
});
