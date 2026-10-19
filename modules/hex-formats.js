"use strict";
/* ============================ HEX Structure: готовые схемы ============================
   Тот же JSON, что можно написать руками в узле. Ключ — имя в HEX_LIB; sub ссылается на него по имени.
   title/group — для списка в интерфейсе. */

// Wi-Fi: имена IE в rec (ie.channel, ie.p2p …); вендорский IE и Extension выбираются по OUI+тип / ext id
const WIFI_IE_NAMES={0:'SSID',1:'Rates',3:'DS channel',5:'TIM',7:'Country',11:'BSS load',32:'Power constraint',33:'Power capability',36:'Supported channels',42:'ERP',45:'HT capabilities',48:'RSN',50:'Ext rates',54:'Mobility domain',59:'Supported op classes',61:'HT operation',70:'RM capabilities',74:'Overlap BSS scan',107:'Interworking',127:'Ext capabilities',191:'VHT capabilities',192:'VHT operation',221:'Vendor',255:'Extension'};
const WIFI_VENDOR_SUB={[0x0050f201]:'wifi-ie-rsn',[0x0050f202]:'wifi-vendor-wmm',[0x0050f204]:'wifi-vendor-wps',[0x506f9a09]:'wifi-vendor-p2p',[0x18fe3404]:'wifi-vendor-espnow'};
const WIFI_IE_KEYS={3:'channel',11:'bss_load',32:'power_constraint',33:'power_cap',36:'supp_channels',45:'ht_cap',50:'ext_rates',54:'mobility_domain',59:'op_classes',61:'ht_op',70:'rm_caps',127:'ext_cap',191:'vht_cap',192:'vht_op',
  221:{by:'data.oui*256+data.vtype',def:'vendor',map:{[0x0050f201]:'wpa',[0x0050f202]:'wmm',[0x0050f204]:'wps',[0x506f9a09]:'p2p',[0x506f9a0a]:'wfd',[0x506f9a10]:'hs20',[0x506f9a1c]:'owe',[0x18fe3404]:'espnow'}},
  255:{by:'data.ext_id',def:'ext',map:{35:'he_cap',36:'he_op',38:'mu_edca',39:'spatial_reuse',106:'eht_op',108:'eht_cap'}}};
const WIFI_IES={n:'ies',t:'list',sub:'wifi-ie',key:'id',val:'data',as:'ie',keys:WIFI_IE_KEYS};
const WIFI_CAPAB={0:'ESS',1:'IBSS',4:'privacy',5:'short preamble',8:'spectrum mgmt',10:'short slot',12:'APSD',15:'immediate block ack'};
const WIFI_STATUS={0:'success',1:'unspecified failure',10:'cannot support all capabilities',12:'denied',13:'algorithm not supported',14:'bad auth sequence',15:'challenge failure',16:'timeout',17:'AP cannot handle more stations',18:'rates not supported',23:'SPP not supported',30:'try again later',31:'MFP violation',53:'invalid PMKID',77:'SAE hash to element',126:'SAE anti-clogging'};
// адреса 802.15.4: по воздуху младший байт первым, показываем старшим вперёд
HEX_FIXED.addr16=2; HEX_FIXED.eui64=8;
HEX_FMT_EXT.addr16=b=>hexToHex(Array.from(b).reverse());
HEX_FMT_EXT.eui64=b=>Array.from(b).reverse().map(hexByte).join(':');
HEX_UNFMT_EXT.addr16=HEX_UNFMT_EXT.eui64=v=>hexFromHex(v).reverse();
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
    {n:'data',t:'rest',sub:{by:'dport',map:{4729:'gsmtap'}}}]},
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
  wifi:{ title:'802.11 frame', group:'Wi-Fi', detect:'ver==0 && _size>=10', endian:'le', bitorder:'lsb',
    derive:{ kind:[['1','subtype_name']], da:[['1','addr1']], sa:[['1','addr2']],
      bssid:[['type==0','addr3'],['type==2 && tods && fromds',''],['type==2 && tods','addr1'],['type==2 && fromds','addr2'],['type==2','addr3']],
      dst:[['1','addr1']], src:[['1','addr2']], net:[['1','bssid']],
      action:[['type==0 && (subtype==13 || subtype==14)','body.category_name']] }, fields:[
    {n:'ver',t:'bits',w:2}, {n:'type',t:'bits',w:2,enum:{0:'management',1:'control',2:'data',3:'extension'}}, {n:'subtype',t:'bits',w:4,enumBy:'type',enums:{
      0:{0:'assoc-req',1:'assoc-resp',2:'reassoc-req',3:'reassoc-resp',4:'probe-req',5:'probe-resp',6:'timing-adv',8:'beacon',9:'atim',10:'disassoc',11:'auth',12:'deauth',13:'action',14:'action-noack'},
      1:{4:'beamforming-report-poll',5:'vht-ndp',6:'control-ext',7:'control-wrapper',8:'block-ack-req',9:'block-ack',10:'ps-poll',11:'rts',12:'cts',13:'ack',14:'cf-end',15:'cf-end-ack'},
      2:{0:'data',1:'data-cf-ack',2:'data-cf-poll',3:'data-cf-ack-poll',4:'null',5:'cf-ack',6:'cf-poll',7:'cf-ack-poll',8:'qos-data',9:'qos-data-cf-ack',10:'qos-data-cf-poll',11:'qos-data-cf-ack-poll',12:'qos-null',14:'qos-cf-poll',15:'qos-cf-ack-poll'}}},
    {n:'tods',t:'bits',w:1}, {n:'fromds',t:'bits',w:1}, {n:'morefrag',t:'bits',w:1}, {n:'retry',t:'bits',w:1},
    {n:'pwr',t:'bits',w:1}, {n:'moredata',t:'bits',w:1}, {n:'prot',t:'bits',w:1}, {n:'order',t:'bits',w:1},
    {n:'dur',t:'u16'},
    {n:'addr1',t:'bytes',fmt:'mac'},
    {n:'addr2',t:'bytes',fmt:'mac',when:'!(type==1 && (subtype==12 || subtype==13))'},
    {n:'addr3',t:'bytes',fmt:'mac',when:'type!=1'},
    {n:'frag',t:'bits',w:4,when:'type!=1'}, {n:'seq',t:'bits',w:12,when:'type!=1'},
    {n:'addr4',t:'bytes',fmt:'mac',when:'type==2 && tods && fromds'},
    {n:'qos',t:'u16',fmt:'hex',when:'type==2 && (subtype&8)'},
    {n:'htc',t:'u32',fmt:'hex',when:'order && (type==0 || type==2 && (subtype&8))'},
    {n:'body',t:'rest',sub:{by:'type==0 ? subtype : type==1 ? 100+subtype : type==2 ? ((subtype&4) ? 99 : prot ? 202 : 201) : 99',map:{
      0:'wifi-assoc-req',1:'wifi-assoc-resp',2:'wifi-reassoc-req',3:'wifi-assoc-resp',4:'wifi-probe-req',5:'wifi-beacon',8:'wifi-beacon',
      10:'wifi-reason',11:'wifi-auth',12:'wifi-reason',13:'wifi-action',14:'wifi-action',
      108:'wifi-bar',109:'wifi-ba',201:'wifi-llc',202:'wifi-data-prot'}}}]},
  'wifi-beacon':{ title:'Beacon / Probe response', group:'Wi-Fi', endian:'le', fields:[
    {n:'ts',t:'u64'}, {n:'interval',t:'u16',as:'beacon_interval'},
    {n:'capab',t:'u16',fmt:'hex',flags:WIFI_CAPAB}, WIFI_IES]},
  'wifi-probe-req':{ title:'Probe request', group:'Wi-Fi', endian:'le', fields:[WIFI_IES]},
  'wifi-assoc-req':{ title:'Association request', group:'Wi-Fi', endian:'le', fields:[
    {n:'capab',t:'u16',fmt:'hex',flags:WIFI_CAPAB}, {n:'listen',t:'u16'}, WIFI_IES]},
  'wifi-reassoc-req':{ title:'Reassociation request', group:'Wi-Fi', endian:'le', fields:[
    {n:'capab',t:'u16',fmt:'hex',flags:WIFI_CAPAB}, {n:'listen',t:'u16'}, {n:'ap',t:'bytes',fmt:'mac'}, WIFI_IES]},
  'wifi-assoc-resp':{ title:'Association / reassociation response', group:'Wi-Fi', endian:'le', fields:[
    {n:'capab',t:'u16',fmt:'hex',flags:WIFI_CAPAB}, {n:'status',t:'u16',enum:WIFI_STATUS}, {n:'aid',t:'u16'}, WIFI_IES]},
  'wifi-reason':{ title:'Deauth / Disassoc', group:'Wi-Fi', endian:'le', fields:[{n:'reason',t:'u16',as:'reason',enum:{1:'unspecified',2:'auth no longer valid',3:'station leaving',4:'inactivity',5:'AP overloaded',6:'class 2 frame from non-auth',7:'class 3 frame from non-assoc',8:'station left BSS',9:'assoc before auth',15:'4-way handshake timeout',23:'802.1X failed'}}]},
  'wifi-auth':{ title:'Authentication', group:'Wi-Fi', endian:'le', fields:[
    {n:'algo',t:'u16',enum:{0:'open',1:'shared key',2:'FT',3:'SAE'}}, {n:'seq',t:'u16'}, {n:'status',t:'u16',as:'auth_status',enum:WIFI_STATUS}, WIFI_IES]},
  'wifi-action':{ title:'Action frame', group:'Wi-Fi', endian:'le', fields:[
    {n:'category',t:'u8',enum:{0:'Spectrum mgmt',1:'QoS',2:'DLS',3:'Block ack',4:'Public',5:'Radio measurement',6:'Fast BSS transition',7:'HT',8:'SA query',9:'Protected dual',10:'WNM',14:'Mesh',15:'Multihop',17:'VHT',18:'S1G',21:'Protected FTM',126:'Vendor protected',127:'Vendor'}},
    {n:'act',t:'u8',when:'category!=127',enumBy:'category',enums:{
      3:{0:'ADDBA request',1:'ADDBA response',2:'DELBA'}, 4:{0:'ext channel switch',4:'TDLS discovery',6:'GAS request',9:'vendor specific',10:'GAS response',11:'GAS comeback request',12:'GAS comeback response',13:'TDLS discovery response',20:'FILS discovery'},
      5:{0:'measurement request',1:'measurement report',2:'link measurement request',3:'link measurement report',4:'neighbor report request',5:'neighbor report response'},
      6:{1:'FT request',2:'FT response',3:'FT confirm',4:'FT ack'}, 8:{0:'SA query request',1:'SA query response'},
      10:{0:'event request',1:'event report',2:'diagnostic request',4:'BSS transition query',7:'BSS transition request',8:'BSS transition response',26:'notification response'}}},
    {n:'oui',t:'u24',endian:'be',fmt:'hex',when:'category==127 || category==4 && act==9'},
    {n:'body',t:'rest',when:'_left>0',sub:{by:'category==127 ? (oui==1637940 ? 1 : oui==5271450 ? 2 : 0) : (category==4 && act==9 && oui==5271450) ? 2 : 0',map:{1:'wifi-espnow',2:'wifi-p2p-action'}}}]},
  'wifi-espnow':{ title:'ESP-NOW (vendor action)', group:'Wi-Fi', endian:'le', fields:[
    {n:'rnd',t:'bytes',len:4}, {n:'id',t:'u8',when:'_left>0'}, {n:'len',t:'u8',when:'_left>0'},
    {n:'oui',t:'u24',endian:'be',fmt:'hex',when:'_left>=3'}, {n:'type',t:'u8',when:'_left>0'}, {n:'version',t:'u8',when:'_left>0'},
    {n:'payload',t:'rest',as:'espnow'}]},
  'wifi-p2p-action':{ title:'Wi-Fi Direct (P2P) action', group:'Wi-Fi', endian:'le', fields:[
    {n:'otype',t:'u8'}, {n:'subtype',t:'u8',as:'p2p_subtype',enum:{0:'GO negotiation request / NoA',1:'GO negotiation response / presence request',2:'GO negotiation confirm / presence response',3:'invitation request / GO discoverability',4:'invitation response',5:'device discoverability request',6:'device discoverability response',7:'provision discovery request',8:'provision discovery response'}},
    {n:'dialog',t:'u8'}, WIFI_IES]},
  'wifi-bar':{ title:'Block ack request', group:'Wi-Fi', endian:'le', fields:[{n:'ctl',t:'u16',fmt:'hex'}, {n:'ssc',t:'u16',fmt:'hex'}]},
  'wifi-ba':{ title:'Block ack', group:'Wi-Fi', endian:'le', fields:[{n:'ctl',t:'u16',fmt:'hex'}, {n:'ssc',t:'u16',fmt:'hex'}, {n:'bitmap',t:'rest'}]},
  'wifi-data-prot':{ title:'Protected data (CCMP/TKIP header + ciphertext)', group:'Wi-Fi', endian:'le', fields:[
    {n:'pn0',t:'u8',fmt:'hex'}, {n:'pn1',t:'u8',fmt:'hex'}, {n:'rsv',t:'u8',fmt:'hex'}, {n:'keyid',t:'u8',fmt:'hex'},
    {n:'pn2',t:'u32',fmt:'hex',when:'keyid&32'}, {n:'enc',t:'rest'}]},
  'wifi-llc':{ title:'LLC / SNAP', group:'Wi-Fi', endian:'be', fields:[
    {n:'dsap',t:'u8',fmt:'hex'}, {n:'ssap',t:'u8',fmt:'hex'}, {n:'ctl',t:'u8',fmt:'hex'},
    {n:'oui',t:'u24',fmt:'hex',when:'dsap==170'},
    {n:'ethertype',t:'u16',fmt:'hex',as:'ethertype',when:'dsap==170',enum:{2048:'IPv4',2054:'ARP',34525:'IPv6',34958:'EAPOL',35085:'TDLS',34915:'PPPoE discovery',34916:'PPPoE session'}},
    {n:'payload',t:'rest',sub:{by:'dsap==170 ? ethertype : 0',map:{2048:'ipv4',2054:'arp',34525:'ipv6',34958:'eapol'}}}]},
  eapol:{ title:'EAPOL / 4-way handshake key', group:'Wi-Fi', endian:'be', fields:[
    {n:'ver',t:'u8'}, {n:'type',t:'u8',enum:{0:'EAP packet',1:'start',2:'logoff',3:'key',4:'ASF alert'}}, {n:'len',t:'u16'},
    {n:'desc',t:'u8',when:'type==3',enum:{2:'RSN',254:'WPA'}},
    {n:'keyinfo',t:'u16',fmt:'hex',when:'type==3',flags:{3:'pairwise',6:'install',7:'ack',8:'mic',9:'secure',10:'error',11:'request',12:'encrypted data'}},
    {n:'keylen',t:'u16',when:'type==3'}, {n:'replay',t:'u64',when:'type==3'},
    {n:'nonce',t:'bytes',len:32,when:'type==3'}, {n:'iv',t:'bytes',len:16,when:'type==3'}, {n:'rsc',t:'bytes',len:8,when:'type==3'}, {n:'keyid',t:'bytes',len:8,when:'type==3'},
    {n:'mic',t:'bytes',len:16,when:'type==3'}, {n:'datalen',t:'u16',when:'type==3'}, {n:'data',t:'rest'}]},
  'wifi-ie':{ title:'Information element', group:'Wi-Fi', fields:[
    {n:'id',t:'u8',enum:WIFI_IE_NAMES},
    {n:'len',t:'u8'},
    {n:'data',t:'bytes',len:'len',sub:{by:'id',map:{0:'wifi-ie-ssid',3:'wifi-ie-chan',5:'wifi-ie-tim',7:'wifi-ie-country',11:'wifi-ie-load',45:'wifi-ie-ht',48:'wifi-ie-rsn',61:'wifi-ie-htop',221:'wifi-ie-vendor',255:'wifi-ie-ext'}}}]},
  'wifi-ie-ssid':{ fields:[{n:'ssid',t:'str',len:'rest',enc:'utf8',as:'ssid'}]},
  'wifi-ie-chan':{ fields:[{n:'channel',t:'u8',as:'ds_channel'}]},
  'wifi-ie-tim':{ fields:[{n:'dtim_count',t:'u8'}, {n:'dtim_period',t:'u8',when:'_left>0'}, {n:'bmap_ctrl',t:'u8',when:'_left>0'}, {n:'bitmap',t:'rest'}]},
  'wifi-ie-country':{ fields:[{n:'cc',t:'str',len:2,enc:'ascii'}, {n:'env',t:'u8',when:'_left>0'}, {n:'triplets',t:'rest'}]},
  'wifi-ie-load':{ endian:'le', fields:[{n:'stations',t:'u16'}, {n:'util',t:'u8',when:'_left>0'}, {n:'admission',t:'u16',when:'_left>=2'}]},
  'wifi-ie-ht':{ endian:'le', fields:[{n:'info',t:'u16',fmt:'hex'}, {n:'ampdu',t:'u8',fmt:'hex',when:'_left>0'}, {n:'mcs',t:'bytes',len:16,when:'_left>=16'},
    {n:'ext',t:'u16',fmt:'hex',when:'_left>=2'}, {n:'txbf',t:'u32',fmt:'hex',when:'_left>=4'}, {n:'asel',t:'u8',fmt:'hex',when:'_left>0'}]},
  'wifi-ie-htop':{ fields:[{n:'primary',t:'u8'}, {n:'rest',t:'rest'}]},
  'wifi-ie-rsn':{ title:'RSN / WPA element', endian:'le', fields:[
    {n:'version',t:'u16'}, {n:'group',t:'bytes',len:4,when:'_left>=4'},
    {n:'pcount',t:'u16',when:'_left>=2'}, {n:'pairwise',t:'bytes',len:'pcount*4',when:'pcount>0 && _left>=pcount*4'},
    {n:'acount',t:'u16',when:'_left>=2'}, {n:'akm',t:'bytes',len:'acount*4',when:'acount>0 && _left>=acount*4'},
    {n:'caps',t:'u16',fmt:'hex',when:'_left>=2'}, {n:'rest',t:'rest'}]},
  'wifi-ie-ext':{ fields:[{n:'ext_id',t:'u8'}, {n:'rest',t:'rest'}]},
  'wifi-ie-vendor':{ title:'Vendor element', endian:'le', fields:[
    {n:'oui',t:'u24',endian:'be',fmt:'hex'}, {n:'vtype',t:'u8',when:'_left>0'},
    {n:'body',t:'rest',when:'_left>0',sub:{by:'oui*256+vtype',map:WIFI_VENDOR_SUB}}]},
  'wifi-vendor-wmm':{ fields:[{n:'subtype',t:'u8'}, {n:'version',t:'u8',when:'_left>0'}, {n:'qos',t:'u8',fmt:'hex',when:'_left>0'}, {n:'rest',t:'rest'}]},
  'wifi-vendor-espnow':{ fields:[{n:'version',t:'u8'}, {n:'payload',t:'rest'}]},
  'wifi-vendor-wps':{ endian:'be', fields:[{n:'attrs',t:'list',sub:'wps-attr',key:'type',val:'val',as:'wps'}]},
  'wps-attr':{ endian:'be', fields:[
    {n:'type',t:'u16',fmt:'hex',enum:{0x104a:'version',0x1044:'state',0x1008:'config methods',0x1047:'uuid',0x1054:'primary device type',0x1011:'device name',0x1021:'manufacturer',0x1023:'model name',0x1024:'model number',0x1042:'serial',0x103b:'response type',0x1057:'ap setup locked',0x1012:'device password id',0x103c:'rf bands',0x1049:'vendor extension'}},
    {n:'len',t:'u16'},
    {n:'val',t:'bytes',len:'len',sub:{by:'type',map:{0x1011:'wps-str',0x1021:'wps-str',0x1023:'wps-str',0x1024:'wps-str',0x1042:'wps-str'}}}]},
  'wps-str':{ fields:[{n:'v',t:'str',len:'rest',enc:'utf8'}]},
  'wifi-vendor-p2p':{ endian:'le', fields:[{n:'attrs',t:'list',sub:'p2p-attr',key:'id',val:'val',as:'p2p'}]},
  'p2p-attr':{ endian:'le', fields:[
    {n:'id',t:'u8',enum:{0:'status',1:'minor reason',2:'capability',3:'device id',4:'go intent',5:'config timeout',6:'listen channel',7:'group bssid',8:'ext listen timing',9:'interface address',10:'manageability',11:'channel list',12:'notice of absence',13:'device info',14:'group info',15:'group id',16:'interface',17:'operating channel',18:'invitation flags'}},
    {n:'len',t:'u16'},
    {n:'val',t:'bytes',len:'len',sub:{by:'id',map:{0:'p2p-u8',2:'p2p-cap',3:'p2p-mac',4:'p2p-u8',7:'p2p-mac',9:'p2p-mac',6:'p2p-chan',17:'p2p-chan',13:'p2p-devinfo',15:'p2p-groupid'}}}]},
  'p2p-u8':{ fields:[{n:'v',t:'u8'}]},
  'p2p-mac':{ fields:[{n:'mac',t:'bytes',len:6,fmt:'mac'}]},
  'p2p-cap':{ fields:[{n:'device',t:'u8',fmt:'hex'}, {n:'group',t:'u8',fmt:'hex',when:'_left>0'}]},
  'p2p-chan':{ fields:[{n:'country',t:'str',len:3,enc:'ascii'}, {n:'op_class',t:'u8',when:'_left>0'}, {n:'channel',t:'u8',when:'_left>0'}]},
  'p2p-groupid':{ fields:[{n:'mac',t:'bytes',len:6,fmt:'mac'}, {n:'ssid',t:'str',len:'rest',enc:'utf8'}]},
  'p2p-devinfo':{ endian:'be', fields:[
    {n:'mac',t:'bytes',len:6,fmt:'mac'}, {n:'config_methods',t:'u16',fmt:'hex'}, {n:'primary_type',t:'bytes',len:8,when:'_left>=8'},
    {n:'nsec',t:'u8',when:'_left>0'}, {n:'secondary',t:'bytes',len:'nsec*8',when:'nsec>0 && _left>=nsec*8'},
    {n:'name_type',t:'u16',fmt:'hex',when:'_left>=4'}, {n:'name_len',t:'u16',when:'_left>=2'}, {n:'name',t:'str',len:'name_len',enc:'utf8',when:'name_len>0 && _left>=name_len'}]},

  /* ---------- IEEE 802.15.4 / Zigbee (кадр без FCS, адреса показаны в привычном порядке — старший байт первым) ---------- */
  ieee802154:{ title:'IEEE 802.15.4 MAC', group:'802.15.4', endian:'le', bitorder:'lsb',
    derive:{ kind:[['ftype==3 && !sec','body.id_name'],['1','ftype_name']],
      dst:[['dstmode==2','dst16'],['dstmode==3','dst64']], src:[['srcmode==2','src16'],['srcmode==3','src64']],
      net:[['srcmode!=0 && !(pancomp && dstmode!=0)','srcpan'],['dstmode!=0','dstpan']] }, fields:[
    {n:'ftype',t:'bits',w:3,enum:{0:'beacon',1:'data',2:'ack',3:'command',4:'multipurpose',5:'fragment',6:'extended'}},
    {n:'sec',t:'bits',w:1}, {n:'pending',t:'bits',w:1}, {n:'ackreq',t:'bits',w:1}, {n:'pancomp',t:'bits',w:1}, {n:'rsv',t:'bits',w:1},
    {n:'seqsup',t:'bits',w:1}, {n:'ieprs',t:'bits',w:1}, {n:'dstmode',t:'bits',w:2,enum:{0:'none',2:'short',3:'extended'}}, {n:'ver',t:'bits',w:2},
    {n:'srcmode',t:'bits',w:2,enum:{0:'none',2:'short',3:'extended'}},
    {n:'seq',t:'u8',when:'!seqsup'},
    {n:'dstpan',t:'bytes',fmt:'addr16',when:'dstmode!=0'},
    {n:'dst16',t:'bytes',fmt:'addr16',when:'dstmode==2'}, {n:'dst64',t:'bytes',fmt:'eui64',when:'dstmode==3'},
    {n:'srcpan',t:'bytes',fmt:'addr16',when:'srcmode!=0 && !(pancomp && dstmode!=0)'},
    {n:'src16',t:'bytes',fmt:'addr16',when:'srcmode==2'}, {n:'src64',t:'bytes',fmt:'eui64',when:'srcmode==3'},
    {n:'sec_ctl',t:'u8',fmt:'hex',when:'sec'}, {n:'fcnt',t:'u32',when:'sec'},
    {n:'keyid',t:'bytes',len:'((sec_ctl>>3)&3)==1 ? 1 : ((sec_ctl>>3)&3)==2 ? 5 : ((sec_ctl>>3)&3)==3 ? 9 : 0',when:'sec'},
    {n:'body',t:'rest',sub:{by:'sec ? 0 : ftype==0 ? 1 : ftype==1 ? ((_peek&60)==8 ? 2 : ((_peek&224)==96 || _peek==65) ? 3 : 0) : ftype==3 ? 4 : 0',
      map:{1:'ieee802154-beacon',2:'zbee-nwk',3:'lowpan',4:'ieee802154-cmd'}}}]},
  'ieee802154-beacon':{ title:'802.15.4 beacon', group:'802.15.4', endian:'le', fields:[
    {n:'superframe',t:'u16',fmt:'hex'}, {n:'gts',t:'u8',fmt:'hex'}, {n:'paddr',t:'u8',fmt:'hex'},
    {n:'payload',t:'rest',sub:{by:'_peek==0 ? 1 : 0',map:{1:'zbee-beacon'}}}]},
  'zbee-beacon':{ title:'Zigbee beacon payload', group:'Zigbee', endian:'le', bitorder:'lsb', fields:[
    {n:'protocol',t:'u8'}, {n:'stack',t:'bits',w:4,as:'zb_stack'}, {n:'nwkver',t:'bits',w:4},
    {n:'rsv',t:'bits',w:2}, {n:'router_cap',t:'bits',w:1}, {n:'depth',t:'bits',w:4}, {n:'ed_cap',t:'bits',w:1},
    {n:'epid',t:'bytes',fmt:'eui64',as:'zb_epid'}, {n:'txoffset',t:'bytes',len:3}, {n:'update_id',t:'u8'}]},
  'ieee802154-cmd':{ title:'802.15.4 MAC command', group:'802.15.4', endian:'le', fields:[
    {n:'id',t:'u8',enum:{1:'association request',2:'association response',3:'disassociation notification',4:'data request',5:'PAN ID conflict',6:'orphan notification',7:'beacon request',8:'coordinator realignment',9:'GTS request'}},
    {n:'rest',t:'rest'}]},
  lowpan:{ title:'6LoWPAN dispatch (Thread / Matter)', group:'802.15.4', fields:[{n:'dispatch',t:'u8',fmt:'hex'}, {n:'data',t:'rest'}]},
  'zbee-nwk':{ title:'Zigbee NWK', group:'Zigbee', endian:'le', bitorder:'lsb', fields:[
    {n:'nwktype',t:'bits',w:2,enum:{0:'data',1:'command',3:'inter-pan'}}, {n:'nwkver',t:'bits',w:4}, {n:'discover',t:'bits',w:2},
    {n:'mcast',t:'bits',w:1}, {n:'nwksec',t:'bits',w:1}, {n:'srcroute',t:'bits',w:1}, {n:'dstieee',t:'bits',w:1}, {n:'srcieee',t:'bits',w:1},
    {n:'edinit',t:'bits',w:1}, {n:'rsv',t:'bits',w:2},
    {n:'dst',t:'bytes',len:2,fmt:'addr16',as:'nwk_dst'}, {n:'src',t:'bytes',len:2,fmt:'addr16',as:'nwk_src'},
    {n:'radius',t:'u8'}, {n:'nwkseq',t:'u8'},
    {n:'dst64',t:'bytes',fmt:'eui64',when:'dstieee'}, {n:'src64',t:'bytes',fmt:'eui64',when:'srcieee'},
    {n:'mcctl',t:'u8',fmt:'hex',when:'mcast'},
    {n:'relays',t:'u8',when:'srcroute'}, {n:'relay_idx',t:'u8',when:'srcroute'}, {n:'relay_list',t:'bytes',len:'relays*2',when:'srcroute && relays>0'},
    {n:'sec_ctl',t:'u8',fmt:'hex',when:'nwksec'}, {n:'fcnt',t:'u32',when:'nwksec'}, {n:'sec_src',t:'bytes',fmt:'eui64',when:'nwksec'}, {n:'key_seq',t:'u8',when:'nwksec'},
    {n:'payload',t:'rest',sub:{by:'nwksec ? 0 : nwktype==0 ? 1 : nwktype==1 ? 2 : 0',map:{1:'zbee-aps',2:'zbee-nwk-cmd'}}}]},
  'zbee-nwk-cmd':{ title:'Zigbee NWK command', group:'Zigbee', fields:[
    {n:'id',t:'u8',as:'zb_cmd',enum:{1:'route request',2:'route reply',3:'network status',4:'leave',5:'route record',6:'rejoin request',7:'rejoin response',8:'link status',9:'network report',10:'network update',11:'end device timeout request',12:'end device timeout response'}},
    {n:'rest',t:'rest'}]},
  'zbee-aps':{ title:'Zigbee APS', group:'Zigbee', endian:'le', bitorder:'lsb', fields:[
    {n:'apstype',t:'bits',w:2,enum:{0:'data',1:'command',2:'ack',3:'inter-pan'}}, {n:'delivery',t:'bits',w:2,enum:{0:'unicast',2:'broadcast',3:'group'}},
    {n:'ackfmt',t:'bits',w:1}, {n:'apssec',t:'bits',w:1}, {n:'ackreq',t:'bits',w:1}, {n:'exthdr',t:'bits',w:1},
    {n:'dstep',t:'u8',when:'(apstype==0 || apstype==2 && !ackfmt) && delivery!=3'},
    {n:'group',t:'u16',fmt:'hex',when:'apstype==0 && delivery==3'},
    {n:'cluster',t:'u16',fmt:'hex',as:'zb_cluster',when:'apstype==0 || apstype==2 && !ackfmt'},
    {n:'profile',t:'u16',fmt:'hex',as:'zb_profile',when:'apstype==0 || apstype==2 && !ackfmt',enum:{0:'ZDP',260:'Home Automation',49246:'Light Link',41440:'Green Power',49413:'Smart Energy'}},
    {n:'srcep',t:'u8',when:'apstype==0 || apstype==2 && !ackfmt'}, {n:'apscnt',t:'u8'},
    {n:'payload',t:'rest',sub:{by:'(apssec || apstype!=0) ? 0 : profile==0 ? 1 : (profile==260 || profile==49246) ? 2 : 0',map:{1:'zbee-zdo',2:'zbee-zcl'}}}]},
  'zbee-zdo':{ title:'Zigbee device object (ZDP)', group:'Zigbee', fields:[{n:'tsn',t:'u8'}, {n:'payload',t:'rest'}]},
  'zbee-zcl':{ title:'Zigbee cluster library', group:'Zigbee', endian:'le', bitorder:'lsb', fields:[
    {n:'ftype',t:'bits',w:2,enum:{0:'global',1:'cluster-specific'}}, {n:'manuf',t:'bits',w:1}, {n:'dir',t:'bits',w:1,enum:{0:'client to server',1:'server to client'}},
    {n:'disdef',t:'bits',w:1}, {n:'rsv',t:'bits',w:3},
    {n:'mfr',t:'u16',fmt:'hex',when:'manuf'}, {n:'tsn',t:'u8'},
    {n:'cmd',t:'u8',as:'zcl_cmd',enumBy:'ftype',enums:{0:{0:'read attributes',1:'read attributes response',2:'write attributes',3:'write attributes undivided',4:'write attributes response',5:'write attributes no response',6:'configure reporting',7:'configure reporting response',8:'read reporting configuration',9:'read reporting configuration response',10:'report attributes',11:'default response',12:'discover attributes',13:'discover attributes response'}}},
    {n:'payload',t:'rest'}]},

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
    {n:'fid',t:'u8',fmt:'hex'}, {n:'data',t:'bytes',len:8}, {n:'crc',t:'u16',fmt:'hex',calc:'crc16-gsm',xor:0xA5A5,to:'crc'}]},

  'dmr-pi':{ title:'DMR PI header', group:'DMR', fields:[
    {n:'alg',t:'u8',fmt:'hex'}, {n:'fid',t:'u8',fmt:'hex'}, {n:'key',t:'u8'}, {n:'mi',t:'bytes',len:4},
    {n:'dst',t:'u24'}, {n:'crc',t:'u16',fmt:'hex',calc:'crc16-gsm',xor:0x6969,to:'crc'}]},

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
  'ble-adv':{ title:'BLE advertising data', group:'Bluetooth', fields:[{n:'ad',t:'list',sub:'ble-ad',key:'type',val:'data',as:'ad'}]},
  'ble-ad':{ title:'BLE AD structure', group:'Bluetooth', endian:'le', fields:[
    {n:'len',t:'u8'},
    {n:'type',t:'u8',fmt:'hex',when:'len>0',enum:{1:'Flags',2:'UUID16 (more)',3:'UUID16',4:'UUID32 (more)',5:'UUID32',6:'UUID128 (more)',7:'UUID128',8:'Short name',9:'Name',10:'TX power',13:'Class of device',22:'Service data 16',23:'Public target address',24:'Random target address',25:'Appearance',26:'Adv interval',27:'LE address',28:'LE role',32:'Service data 32',33:'Service data 128',36:'URI',42:'Mesh PB-ADV',43:'Mesh message',44:'Mesh beacon',255:'Manufacturer'}},
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

  /* ---------- LoRaWAN 1.0.x (кадр PHYPayload) и Meshtastic ---------- */
  lorawan:{ title:'LoRaWAN PHYPayload', group:'LoRa', detect:'mtype==0 && rfu==0 && major==0 && _size==23', fields:[
    {n:'mtype',t:'bits',w:3,enum:{0:'Join Request',1:'Join Accept',2:'Unconfirmed Up',3:'Unconfirmed Down',4:'Confirmed Up',5:'Confirmed Down',6:'Rejoin Request',7:'Proprietary'}},
    {n:'rfu',t:'bits',w:3}, {n:'major',t:'bits',w:2,enum:{0:'LoRaWAN R1'}},
    {n:'body',t:'rest',sub:{by:'mtype',map:{0:'lorawan-join',2:'lorawan-data',3:'lorawan-data',4:'lorawan-data',5:'lorawan-data'}}}]},
  'lorawan-join':{ endian:'le', fields:[
    {n:'joineui',t:'u64',fmt:'hex'}, {n:'deveui',t:'u64',fmt:'hex'}, {n:'devnonce',t:'u16'}, {n:'mic',t:'bytes',len:4}]},
  'lorawan-data':{ endian:'le', fields:[
    {n:'devaddr',t:'u32',fmt:'hex'},
    {n:'adr',t:'bits',w:1}, {n:'adrackreq',t:'bits',w:1}, {n:'ack',t:'bits',w:1}, {n:'classb_fpending',t:'bits',w:1}, {n:'foptslen',t:'bits',w:4},
    {n:'fcnt',t:'u16'}, {n:'fopts',t:'bytes',len:'foptslen'},
    {n:'fport',t:'u8',when:'_left>4'}, {n:'frmpayload',t:'bytes',len:'_left-4',when:'_left>4'},
    {n:'mic',t:'bytes',len:4}]},
  meshtastic:{ title:'Meshtastic packet header', group:'LoRa', endian:'le', fields:[
    {n:'dest',t:'u32',fmt:'hex',enum:{4294967295:'broadcast'}}, {n:'sender',t:'u32',fmt:'hex'}, {n:'id',t:'u32',fmt:'hex'},
    {n:'hop_start',t:'bits',w:3}, {n:'via_mqtt',t:'bits',w:1}, {n:'want_ack',t:'bits',w:1}, {n:'hop_limit',t:'bits',w:3},
    {n:'channel',t:'u8',fmt:'hex'}, {n:'next_hop',t:'u8',fmt:'hex'}, {n:'relay_node',t:'u8',fmt:'hex'},
    {n:'payload',t:'rest'}]},
  /* MeshCore: docs/packet_format.md, docs/payloads.md (meshcore-dev/MeshCore); sync word private 0x12 */
  meshcore:{ title:'MeshCore packet', group:'LoRa', endian:'le', fields:[
    {n:'ver',t:'bits',w:2}, {n:'ptype',t:'bits',w:4,enum:{0:'REQ',1:'RESPONSE',2:'TXT_MSG',3:'ACK',4:'ADVERT',5:'GRP_TXT',6:'GRP_DATA',7:'ANON_REQ',8:'PATH',9:'TRACE',10:'MULTIPART',11:'CONTROL',15:'RAW_CUSTOM'}},
    {n:'route',t:'bits',w:2,enum:{0:'transport flood',1:'flood',2:'direct',3:'transport direct'}},
    {n:'tcode1',t:'u16',fmt:'hex',when:'route==0 || route==3'}, {n:'tcode2',t:'u16',fmt:'hex',when:'route==0 || route==3'},
    {n:'hashsz',t:'bits',w:2}, {n:'hops',t:'bits',w:6},
    {n:'path',t:'bytes',len:'hops*(hashsz+1)'},
    {n:'payload',t:'rest',sub:{by:'ptype',map:{0:'meshcore-enc',1:'meshcore-enc',2:'meshcore-enc',8:'meshcore-enc',3:'meshcore-ack',4:'meshcore-advert',5:'meshcore-grp',6:'meshcore-grp',7:'meshcore-anon',11:'meshcore-ctl'}}}]},
  'meshcore-enc':{ endian:'le', fields:[
    {n:'dst',t:'u8',fmt:'hex'}, {n:'src',t:'u8',fmt:'hex'}, {n:'mac',t:'bytes',len:2}, {n:'ciphertext',t:'rest'}]},
  'meshcore-grp':{ endian:'le', fields:[
    {n:'channel',t:'u8',fmt:'hex'}, {n:'mac',t:'bytes',len:2}, {n:'ciphertext',t:'rest'}]},
  'meshcore-anon':{ endian:'le', fields:[
    {n:'dst',t:'u8',fmt:'hex'}, {n:'pubkey',t:'bytes',len:32}, {n:'mac',t:'bytes',len:2}, {n:'ciphertext',t:'rest'}]},
  'meshcore-ack':{ endian:'le', fields:[{n:'checksum',t:'u32',fmt:'hex'}]},
  'meshcore-ctl':{ endian:'le', fields:[{n:'flags',t:'u8',fmt:'hex'}, {n:'data',t:'rest'}]},
  'meshcore-advert':{ endian:'le', fields:[
    {n:'pubkey',t:'bytes',len:32}, {n:'time',t:'u32',fmt:'time'}, {n:'sig',t:'bytes',len:64},
    {n:'hasname',t:'bits',w:1,when:'_left>0'}, {n:'hasf2',t:'bits',w:1,when:'_left>0'}, {n:'hasf1',t:'bits',w:1,when:'_left>0'}, {n:'hasloc',t:'bits',w:1,when:'_left>0'},
    {n:'ntype',t:'bits',w:4,when:'_left>0',enum:{1:'chat',2:'repeater',3:'room server',4:'sensor'}},
    {n:'lat',t:'i32',when:'hasloc==1'}, {n:'lon',t:'i32',when:'hasloc==1'},
    {n:'f1',t:'u16',when:'hasf1==1'}, {n:'f2',t:'u16',when:'hasf2==1'},
    {n:'name',t:'str',len:'rest',enc:'utf8',when:'hasname==1'}]},

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

  /* ---------- NXDN (TS 1-A), сообщение слоя 3 ---------- */
  'nxdn-l3':{ title:'NXDN layer 3 message', group:'NXDN', fields:(()=>{
    const b=(n,w,when,o)=>Object.assign({n,t:'bits',w,when},o||{});
    const V='type==1||type==7||type==8||type==17||type==9||type==11||type==56||type==4||type==5||type==14||type==13', AS='type==4||type==5||type==14||type==13', SI='type==24';
    return [
      b('f1',1), b('f2',1),
      b('type',6,undefined,{enum:{0:'CALL_RESP',1:'VCALL',2:'VCALL_REC_REQ',3:'VCALL_IV',4:'VCALL_ASSGN',5:'VCALL_ASSGN_DUP',6:'CALL_CONN_RESP',7:'TX_REL_EX',8:'TX_REL',9:'DCALL_HEADER',
        10:'DCALL_REC_REQ',11:'DCALL_DATA',12:'DCALL_ACK',13:'DCALL_ASSGN_DUP',14:'DCALL_ASSGN',15:'HEAD_DLY',16:'IDLE',17:'DISC',23:'DST_ID_INFO',24:'SITE_INFO',25:'SRV_INFO',26:'CCH_INFO',
        27:'ADJ_SITE_INFO',28:'FAIL_STAT_INFO',32:'REG_RESP',34:'REG_C_RESP',35:'REG_COMM',36:'GRP_REG_RESP',40:'AUTH_INQ_REQ',41:'AUTH_INQ_RESP',48:'STAT_INQ_REQ',49:'STAT_INQ_RESP',
        50:'STAT_REQ',51:'STAT_RESP',52:'REM_CON_REQ',53:'REM_CON_RESP',56:'SDCALL_REQ_HEADER',57:'SDCALL_REQ_DATA',58:'SDCALL_IV',59:'SDCALL_RESP',63:'PROP_FORM'}}),
      b('emergency',1,V), b('ccopt',7,V),
      b('ctype',3,V,{enum:{0:'broadcast',1:'conference',2:'unspecified',4:'individual',6:'interconnect',7:'speed dial'}}), b('opt',5,V),
      b('from',16,V), b('to',16,V),
      b('timer',6,AS), b('channel',10,AS),
      b('cipher',2,'('+V+') && !('+AS+')',{enum:{0:'none',1:'scrambler',2:'DES',3:'AES'}}), b('key',6,'('+V+') && !('+AS+')'),
      b('location',24,SI,{fmt:'hex'}), b('cs',16,SI,{fmt:'hex'}), b('svc',16,SI,{fmt:'hex'}), b('rst',24,SI,{fmt:'hex'}), b('ca',24,SI,{fmt:'hex'}),
      b('version',8,SI), b('adj',4,SI), b('ch1',10,SI), b('ch2',10,SI),
      {n:'iv',t:'bytes',len:8,when:'type==3'},
      {n:'data',t:'bytes',len:'_left',when:'!('+V+') && !('+SI+') && type!=3'}
    ];
  })()},

  /* ---------- TETRA (ETSI EN 300 392-2): SYNC (BSCH) и SYSINFO (MAC-BROADCAST) ---------- */
  'tetra-sync':{ title:'TETRA SYNC PDU (BSCH, 60 bit)', group:'TETRA', fields:[
    {n:'sys',t:'bits',w:4}, {n:'cc',t:'bits',w:6}, {n:'tn',t:'bits',w:2}, {n:'fn',t:'bits',w:5}, {n:'mn',t:'bits',w:6},
    {n:'sharing',t:'bits',w:2}, {n:'reserved',t:'bits',w:3}, {n:'dtx',t:'bits',w:1}, {n:'f18ext',t:'bits',w:1}, {t:'pad',w:1},
    {n:'mcc',t:'bits',w:10}, {n:'mnc',t:'bits',w:14}, {n:'nbr',t:'bits',w:2}, {n:'svc',t:'bits',w:2}, {n:'late',t:'bits',w:1}]},
  'tetra-sysinfo':{ title:'TETRA SYSINFO (MAC-BROADCAST, 124 bit)', group:'TETRA', fields:[
    {n:'pdu',t:'bits',w:2,enum:{2:'MAC-BROADCAST'}}, {n:'bt',t:'bits',w:2,enum:{0:'SYSINFO',1:'ACCESS-DEFINE'}},
    {n:'carrier',t:'bits',w:12}, {n:'band',t:'bits',w:4}, {n:'off',t:'bits',w:2,enum:{0:'0',1:'+6.25 kHz',2:'−6.25 kHz',3:'+12.5 kHz'}},
    {n:'duplex',t:'bits',w:3}, {n:'reverse',t:'bits',w:1}, {n:'ncs',t:'bits',w:2}, {n:'txpwr',t:'bits',w:3}, {n:'rxmin',t:'bits',w:4},
    {n:'access',t:'bits',w:4}, {n:'timeout',t:'bits',w:4}, {n:'cckvalid',t:'bits',w:1}, {n:'cck',t:'bits',w:16,fmt:'hex'}, {n:'opt',t:'bits',w:2},
    {t:'pad',w:20}, {n:'la',t:'bits',w:14}, {n:'subscr',t:'bits',w:16,fmt:'hex'},
    {n:'serv',t:'bits',w:12,flags:{11:'registration mandatory',10:'de-registration mandatory',9:'priority cell',8:'no minimum mode',7:'migration',6:'system-wide services',5:'voice',4:'circuit data',2:'SNDCP data',1:'air encryption',0:'advanced link'}}]},

  /* ---------- Для проверки и примеров ---------- */
  'esp-pkt':{ title:'ESP32 sniffer record', group:'Wi-Fi', endian:'le', fields:[
    {n:'rssi',t:'i8',fmt:'dbm'}, {n:'chan',t:'u8'}, {n:'len',t:'u16'},
    {n:'frame',t:'bytes',len:'len',sub:'wifi'}]}
});
