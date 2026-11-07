"use strict";
/* ============================ HEX Structure: сетевые протоколы ============================
   Те же схемы JSON, что и в hex-formats.js: разбор и сборка в обе стороны. Стыковка слоёв — как в Wireshark:
   eth → vlan / mpls / ipv4 / ipv6 / arp / lldp; ipv4 → tcp / udp / gre / igmp; udp.data и tcp.data выбираются по порту
   (dns, dhcp, ntp, tftp, vxlan, coap, rip, radius; http, tls, mqtt, modbus, smtp, ftp, pop3, sip, rtsp, bgp).
   Текстовые протоколы — тип поля http (http-kernels.js: HTTP, SIP, RTSP) и строки через until. Список: help/hex.md */

(function(){
const ETHT={2048:'IPv4',2054:'ARP',2114:'Wake-on-LAN',33024:'VLAN',34525:'IPv6',34887:'MPLS',34915:'PPPoE discovery',34916:'PPPoE session',35020:'LLDP'};
const DNST={1:'A',2:'NS',5:'CNAME',6:'SOA',12:'PTR',15:'MX',16:'TXT',28:'AAAA',33:'SRV',41:'OPT',43:'DS',46:'RRSIG',47:'NSEC',48:'DNSKEY',65:'HTTPS',255:'ANY'};
const ip4=n=>({n,t:'bytes',len:4,fmt:'ipv4'});
const TLV=(n,sub,extra)=>Object.assign({n,t:'list',sub},extra||{});

// порты → схема. Цифра в map — «канонический» порт, к которому сводятся оба направления
const UDP_BY='(sport==53||dport==53) ? 53 : (sport==5353||dport==5353) ? 5353 : (sport==67||sport==68||dport==67||dport==68) ? 67 : (sport==123||dport==123) ? 123 : (sport==69||dport==69) ? 69 : (sport==4789||dport==4789) ? 4789 : (sport==5683||dport==5683) ? 5683 : (sport==520||dport==520) ? 520 : (sport==1812||dport==1812||sport==1813||dport==1813) ? 1812 : (sport==5060||dport==5060) ? 5060 : (sport==1900||dport==1900) ? 1900 : dport';
const UDP_MAP={53:'dns',5353:'dns',67:'dhcp',123:'ntp',69:'tftp',4789:'vxlan',5683:'coap',520:'rip',1812:'radius',5060:'sip',1900:'http',4729:'gsmtap'};
const P=(a)=>'(sport=='+a+'||dport=='+a+')';
const TCP_BY='('+[80,8080,8000,8008,3128,8888].map(P).join('||')+') ? 80 : '+P(443)+' ? 443 : '+P(8443)+' ? 443 : '+P(1883)+' ? 1883 : '+P(502)+' ? 502 : ('+[25,587].map(P).join('||')+') ? 25 : '+P(21)+' ? 21 : '+P(110)+' ? 110 : '+P(143)+' ? 143 : '+P(5060)+' ? 5060 : '+P(554)+' ? 554 : '+P(179)+' ? 179 : '+P(6667)+' ? 6667 : dport';
const TCP_MAP={80:'http',443:'tls-record',1883:'mqtt',502:'modbus',25:'smtp',21:'ftp',110:'pop3',143:'imap',5060:'sip',554:'rtsp',179:'bgp',6667:'irc'};

// стыковка с уже существующими схемами
const eth=HEX_LIB.eth, ipv4=HEX_LIB.ipv4, ipv6=HEX_LIB.ipv6, udp=HEX_LIB.udp, tcp=HEX_LIB.tcp;
if(eth){
  const t=eth.fields.find(f=>f.n==='type'); if(t) Object.assign(t.enum,ETHT);
  const pl=eth.fields.find(f=>f.n==='payload'); if(pl) Object.assign(pl.sub.map,{33024:'vlan',34887:'mpls',35020:'lldp',2114:'wol',34916:'pppoe',34915:'pppoe'});
}
if(ipv4){ const pl=ipv4.fields.find(f=>f.n==='payload'); if(pl) Object.assign(pl.sub.map,{2:'igmp',47:'gre'}); Object.assign(ipv4.fields.find(f=>f.n==='proto').enum,{2:'IGMP',47:'GRE'}); }
if(ipv6){ const pl=ipv6.fields.find(f=>f.n==='payload'); if(pl) Object.assign(pl.sub.map,{47:'gre'}); }
if(udp){ const d=udp.fields.find(f=>f.n==='data'); if(d) d.sub={by:UDP_BY,map:UDP_MAP}; }
if(tcp){ const d=tcp.fields.find(f=>f.n==='data'); if(d) d.sub={by:TCP_BY,map:TCP_MAP}; }

const LINES={n:'lines',t:'list',item:{t:'str',until:'\\r\\n',enc:'utf8',optional:true}};
const LINEPROTO=(title,detect)=>({title,group:'Application',detect,fields:[LINES]});

Object.assign(HEX_LIB,{
  /* ---------- L2 / туннели ---------- */
  vlan:{ title:'802.1Q VLAN tag', group:'Network', fields:[
    {n:'pcp',t:'bits',w:3}, {n:'dei',t:'bits',w:1}, {n:'vid',t:'bits',w:12},
    {n:'type',t:'u16',fmt:'hex',enum:ETHT},
    {n:'payload',t:'rest',sub:{by:'type',map:{2048:'ipv4',2054:'arp',34525:'ipv6',34887:'mpls',35020:'lldp'}}}]},
  mpls:{ title:'MPLS label', group:'Network', fields:[
    {n:'label',t:'bits',w:20}, {n:'tc',t:'bits',w:3}, {n:'s',t:'bits',w:1}, {n:'ttl',t:'u8'}, {n:'payload',t:'rest'}]},
  gre:{ title:'GRE', group:'Network', fields:[
    {n:'ck',t:'bits',w:1}, {n:'rt',t:'bits',w:1}, {n:'ky',t:'bits',w:1}, {n:'sq',t:'bits',w:1}, {n:'ssr',t:'bits',w:1},
    {n:'recur',t:'bits',w:3}, {n:'flags',t:'bits',w:5}, {n:'ver',t:'bits',w:3},
    {n:'proto',t:'u16',fmt:'hex',enum:{2048:'IPv4',34525:'IPv6',25944:'Transparent Ethernet',34827:'PPP'}},
    {n:'csum',t:'u16',fmt:'hex',when:'ck'}, {n:'res',t:'u16',when:'ck'},
    {n:'key',t:'u32',fmt:'hex',when:'ky'}, {n:'seq',t:'u32',when:'sq'},
    {n:'payload',t:'rest',sub:{by:'proto',map:{2048:'ipv4',34525:'ipv6',25944:'eth'}}}]},
  vxlan:{ title:'VXLAN', group:'Network', fields:[
    {n:'flags',t:'u8',fmt:'hex'}, {n:'res1',t:'u24'}, {n:'vni',t:'u24'}, {n:'res2',t:'u8'},
    {n:'payload',t:'rest',sub:'eth'}]},
  lldp:{ title:'LLDP', group:'Network', fields:[ TLV('tlvs','lldp-tlv') ]},
  'lldp-tlv':{ fields:[
    {n:'type',t:'bits',w:7,enum:{0:'End',1:'Chassis ID',2:'Port ID',3:'TTL',4:'Port description',5:'System name',6:'System description',7:'System capabilities',8:'Management address',127:'Organizationally specific'}},
    {n:'len',t:'bits',w:9},
    {n:'value',t:'bytes',len:'len',sub:{by:'type',map:{1:'lldp-id',2:'lldp-id',3:'lldp-ttl',4:'lldp-str',5:'lldp-str',6:'lldp-str'}}}]},
  'lldp-id':{ fields:[ {n:'subtype',t:'u8'}, {n:'id',t:'rest'} ]},
  'lldp-ttl':{ fields:[ {n:'ttl',t:'u16'} ]},
  'lldp-str':{ fields:[ {n:'s',t:'str',len:'rest',enc:'utf8'} ]},
  pppoe:{ title:'PPPoE', group:'Network', fields:[
    {n:'ver',t:'bits',w:4}, {n:'type',t:'bits',w:4},
    {n:'code',t:'u8',fmt:'hex',enum:{0:'session data',7:'PADO',9:'PADI',25:'PADR',101:'PADS',167:'PADT'}},
    {n:'sid',t:'u16',fmt:'hex'}, {n:'len',t:'u16'}, {n:'payload',t:'rest'}]},
  wol:{ title:'Wake-on-LAN magic packet', group:'Network', fields:[
    {n:'sync',t:'bytes',len:6,fmt:'hex'}, {n:'mac',t:'bytes',len:6,fmt:'mac'}, {n:'rest',t:'rest'}]},
  igmp:{ title:'IGMP', group:'Network', fields:[
    {n:'type',t:'u8',fmt:'hex',enum:{0x11:'membership query',0x12:'v1 report',0x16:'v2 report',0x17:'leave group',0x22:'v3 report'}},
    {n:'maxresp',t:'u8'}, {n:'csum',t:'u16',fmt:'hex',calc:'inet16'}, ip4('group')]},
  rip:{ title:'RIP v2', group:'Network', fields:[
    {n:'cmd',t:'u8',enum:{1:'request',2:'response'}}, {n:'ver',t:'u8'}, {n:'zero',t:'u16'}, TLV('entries','rip-entry')]},
  'rip-entry':{ fields:[ {n:'afi',t:'u16'}, {n:'tag',t:'u16'}, ip4('ip'), ip4('mask'), ip4('nexthop'), {n:'metric',t:'u32'} ]},
  bgp:{ title:'BGP message', group:'Network', fields:[
    {n:'marker',t:'bytes',len:16,fmt:'hex'}, {n:'len',t:'u16'},
    {n:'type',t:'u8',enum:{1:'OPEN',2:'UPDATE',3:'NOTIFICATION',4:'KEEPALIVE',5:'ROUTE-REFRESH'}}, {n:'body',t:'rest'}]},

  /* ---------- DNS / DHCP / NTP / TFTP ---------- */
  dns:{ title:'DNS / mDNS', group:'Application', msg:true, fields:[
    {n:'id',t:'u16',fmt:'hex'},
    {n:'qr',t:'bits',w:1,enum:{0:'query',1:'response'}}, {n:'opcode',t:'bits',w:4,enum:{0:'query',1:'inverse',2:'status',4:'notify',5:'update'}},
    {n:'aa',t:'bits',w:1}, {n:'tc',t:'bits',w:1}, {n:'rd',t:'bits',w:1}, {n:'ra',t:'bits',w:1}, {n:'z',t:'bits',w:3},
    {n:'rcode',t:'bits',w:4,enum:{0:'NOERROR',1:'FORMERR',2:'SERVFAIL',3:'NXDOMAIN',4:'NOTIMP',5:'REFUSED'}},
    {n:'qdcount',t:'u16'}, {n:'ancount',t:'u16'}, {n:'nscount',t:'u16'}, {n:'arcount',t:'u16'},
    {n:'qd',t:'list',count:'qdcount',sub:'dns-q'}, {n:'an',t:'list',count:'ancount',sub:'dns-rr'},
    {n:'ns',t:'list',count:'nscount',sub:'dns-rr'}, {n:'ar',t:'list',count:'arcount',sub:'dns-rr'}]},
  'dns-q':{ fields:[ {n:'name',t:'dname'}, {n:'qtype',t:'u16',enum:DNST}, {n:'qclass',t:'u16',enum:{1:'IN',3:'CH',4:'HS',255:'ANY'}} ]},
  'dns-rr':{ fields:[
    {n:'name',t:'dname'}, {n:'type',t:'u16',enum:DNST}, {n:'class',t:'u16',fmt:'hex'}, {n:'ttl',t:'u32'}, {n:'rdlength',t:'u16'},
    {n:'rdata',t:'bytes',len:'rdlength',sub:{by:'type',map:{1:'dns-a',2:'dns-ns',5:'dns-ns',12:'dns-ns',15:'dns-mx',16:'dns-txt',28:'dns-aaaa',6:'dns-soa'}}}]},
  'dns-a':{ fields:[ ip4('addr') ]},
  'dns-aaaa':{ fields:[ {n:'addr',t:'bytes',len:16,fmt:'ipv6'} ]},
  'dns-ns':{ fields:[ {n:'host',t:'dname'} ]},
  'dns-mx':{ fields:[ {n:'pref',t:'u16'}, {n:'host',t:'dname'} ]},
  'dns-txt':{ fields:[ TLV('strings','dns-txt-s') ]},
  'dns-txt-s':{ fields:[ {n:'l',t:'u8'}, {n:'s',t:'str',len:'l',enc:'utf8'} ]},
  'dns-soa':{ fields:[ {n:'mname',t:'dname'}, {n:'rname',t:'dname'}, {n:'serial',t:'u32'}, {n:'refresh',t:'u32'}, {n:'retry',t:'u32'}, {n:'expire',t:'u32'}, {n:'minimum',t:'u32'} ]},

  dhcp:{ title:'DHCP / BOOTP', group:'Application', fields:[
    {n:'op',t:'u8',enum:{1:'request',2:'reply'}}, {n:'htype',t:'u8'}, {n:'hlen',t:'u8'}, {n:'hops',t:'u8'},
    {n:'xid',t:'u32',fmt:'hex'}, {n:'secs',t:'u16'}, {n:'flags',t:'u16',fmt:'hex'},
    ip4('ciaddr'), ip4('yiaddr'), ip4('siaddr'), ip4('giaddr'),
    {n:'chaddr',t:'bytes',len:16,fmt:'hex'}, {n:'sname',t:'bytes',len:64,fmt:'hex'}, {n:'file',t:'bytes',len:128,fmt:'hex'},
    {n:'magic',t:'u32',fmt:'hex'}, TLV('options','dhcp-opt')]},
  'dhcp-opt':{ fields:[
    {n:'code',t:'u8',enum:{0:'Pad',1:'Subnet mask',3:'Router',6:'DNS servers',12:'Host name',15:'Domain name',28:'Broadcast',50:'Requested IP',51:'Lease time',53:'Message type',54:'Server ID',55:'Parameter request list',58:'T1',59:'T2',60:'Vendor class',61:'Client ID',255:'End'}},
    {n:'len',t:'u8',when:'code!=0 && code!=255'},
    {n:'data',t:'bytes',len:'len',fmt:'hex',when:'code!=0 && code!=255',sub:{by:'code',map:{1:'dhcp-ip',3:'dhcp-ips',6:'dhcp-ips',28:'dhcp-ip',50:'dhcp-ip',54:'dhcp-ip',12:'dhcp-str',15:'dhcp-str',60:'dhcp-str',51:'dhcp-u32',58:'dhcp-u32',59:'dhcp-u32',53:'dhcp-type'}}}]},
  'dhcp-ip':{ fields:[ ip4('ip') ]},
  'dhcp-ips':{ fields:[ {n:'ips',t:'list',item:{t:'bytes',len:4,fmt:'ipv4'}} ]},
  'dhcp-str':{ fields:[ {n:'s',t:'str',len:'rest',enc:'utf8'} ]},
  'dhcp-u32':{ fields:[ {n:'v',t:'u32'} ]},
  'dhcp-type':{ fields:[ {n:'type',t:'u8',enum:{1:'DISCOVER',2:'OFFER',3:'REQUEST',4:'DECLINE',5:'ACK',6:'NAK',7:'RELEASE',8:'INFORM'}} ]},

  ntp:{ title:'NTP', group:'Application', fields:[
    {n:'li',t:'bits',w:2,enum:{0:'no warning',1:'+1 s',2:'-1 s',3:'unsynchronized'}}, {n:'vn',t:'bits',w:3},
    {n:'mode',t:'bits',w:3,enum:{1:'symmetric active',2:'symmetric passive',3:'client',4:'server',5:'broadcast',6:'control',7:'private'}},
    {n:'stratum',t:'u8'}, {n:'poll',t:'i8'}, {n:'precision',t:'i8'}, {n:'rootdelay',t:'u32',fmt:'hex'}, {n:'rootdisp',t:'u32',fmt:'hex'},
    {n:'refid',t:'bytes',len:4,fmt:'hex'},
    {n:'ref_s',t:'u32'}, {n:'ref_f',t:'u32'}, {n:'orig_s',t:'u32'}, {n:'orig_f',t:'u32'},
    {n:'rx_s',t:'u32'}, {n:'rx_f',t:'u32'}, {n:'tx_s',t:'u32'}, {n:'tx_f',t:'u32'}, {n:'ext',t:'rest'}]},
  tftp:{ title:'TFTP', group:'Application', fields:[
    {n:'opcode',t:'u16',enum:{1:'RRQ',2:'WRQ',3:'DATA',4:'ACK',5:'ERROR',6:'OACK'}},
    {n:'filename',t:'str',until:'\\0',enc:'utf8',when:'opcode==1||opcode==2'}, {n:'mode',t:'str',until:'\\0',enc:'ascii',when:'opcode==1||opcode==2'},
    {n:'block',t:'u16',when:'opcode==3||opcode==4'}, {n:'data',t:'rest',when:'opcode==3||opcode==6'},
    {n:'errcode',t:'u16',when:'opcode==5'}, {n:'errmsg',t:'str',until:'\\0',enc:'utf8',optional:true,when:'opcode==5'}]},
  radius:{ title:'RADIUS', group:'Application', fields:[
    {n:'code',t:'u8',enum:{1:'Access-Request',2:'Access-Accept',3:'Access-Reject',4:'Accounting-Request',5:'Accounting-Response',11:'Access-Challenge'}},
    {n:'id',t:'u8'}, {n:'len',t:'u16'}, {n:'auth',t:'bytes',len:16,fmt:'hex'}, TLV('attrs','radius-attr')]},
  'radius-attr':{ fields:[
    {n:'type',t:'u8',enum:{1:'User-Name',2:'User-Password',4:'NAS-IP-Address',5:'NAS-Port',6:'Service-Type',8:'Framed-IP-Address',18:'Reply-Message',31:'Calling-Station-Id',32:'NAS-Identifier',79:'EAP-Message',80:'Message-Authenticator'}},
    {n:'len',t:'u8'}, {n:'value',t:'bytes',len:'len-2',fmt:'hex'}]},

  /* ---------- текстовые: HTTP / SIP / RTSP и построчные ---------- */
  http:{ title:'HTTP/1.x (request / response)', group:'Application', fields:[ {n:'http',t:'http'} ]},
  sip:{ title:'SIP', group:'Application', fields:[ {n:'sip',t:'http'} ]},
  rtsp:{ title:'RTSP', group:'Application', fields:[ {n:'rtsp',t:'http'} ]},
  smtp:LINEPROTO('SMTP (commands and replies, line by line)'), ftp:LINEPROTO('FTP control'), pop3:LINEPROTO('POP3'),
  imap:LINEPROTO('IMAP'), irc:LINEPROTO('IRC'),

  /* ---------- TLS ---------- */
  'tls-record':{ title:'TLS record', group:'Security', fields:[
    {n:'type',t:'u8',enum:{20:'ChangeCipherSpec',21:'Alert',22:'Handshake',23:'Application data'}},
    {n:'version',t:'u16',fmt:'hex',enum:{769:'TLS 1.0',770:'TLS 1.1',771:'TLS 1.2',772:'TLS 1.3'}}, {n:'len',t:'u16'},
    {n:'fragment',t:'bytes',len:'len',sub:{by:'type',map:{22:'tls-hs',21:'tls-alert'}}}]},
  'tls-alert':{ fields:[ {n:'level',t:'u8',enum:{1:'warning',2:'fatal'}}, {n:'desc',t:'u8'} ]},
  'tls-hs':{ fields:[
    {n:'msg',t:'u8',enum:{1:'ClientHello',2:'ServerHello',4:'NewSessionTicket',8:'EncryptedExtensions',11:'Certificate',12:'ServerKeyExchange',13:'CertificateRequest',14:'ServerHelloDone',15:'CertificateVerify',16:'ClientKeyExchange',20:'Finished'}},
    {n:'len',t:'u24'}, {n:'body',t:'bytes',len:'len',sub:{by:'msg',map:{1:'tls-ch',2:'tls-sh'}}}]},
  'tls-ch':{ fields:[
    {n:'version',t:'u16',fmt:'hex'}, {n:'random',t:'bytes',len:32,fmt:'hex'},
    {n:'sidlen',t:'u8'}, {n:'sid',t:'bytes',len:'sidlen',fmt:'hex'},
    {n:'cslen',t:'u16'}, {n:'ciphers',t:'bytes',len:'cslen',fmt:'hex'},
    {n:'complen',t:'u8'}, {n:'comp',t:'bytes',len:'complen',fmt:'hex'},
    {n:'extlen',t:'u16'}, TLV('exts','tls-ext')]},
  'tls-sh':{ fields:[
    {n:'version',t:'u16',fmt:'hex'}, {n:'random',t:'bytes',len:32,fmt:'hex'}, {n:'sidlen',t:'u8'}, {n:'sid',t:'bytes',len:'sidlen',fmt:'hex'},
    {n:'cipher',t:'u16',fmt:'hex'}, {n:'comp',t:'u8'}, {n:'exts',t:'rest'}]},
  'tls-ext':{ fields:[
    {n:'type',t:'u16',enum:{0:'server_name',10:'supported_groups',11:'ec_point_formats',13:'signature_algorithms',16:'alpn',23:'extended_master_secret',35:'session_ticket',43:'supported_versions',45:'psk_key_exchange_modes',51:'key_share'}},
    {n:'len',t:'u16'}, {n:'data',t:'bytes',len:'len',fmt:'hex',sub:{by:'type',map:{0:'tls-sni'}}}]},
  'tls-sni':{ fields:[ {n:'listlen',t:'u16'}, {n:'nametype',t:'u8'}, {n:'hostlen',t:'u16'}, {n:'host',t:'str',len:'hostlen',enc:'ascii'} ]},
  'http2-frame':{ title:'HTTP/2 frame', group:'Application', fields:[
    {n:'len',t:'u24'},
    {n:'type',t:'u8',enum:{0:'DATA',1:'HEADERS',2:'PRIORITY',3:'RST_STREAM',4:'SETTINGS',5:'PUSH_PROMISE',6:'PING',7:'GOAWAY',8:'WINDOW_UPDATE',9:'CONTINUATION'}},
    {n:'flags',t:'u8',fmt:'hex'}, {n:'r',t:'bits',w:1}, {n:'sid',t:'bits',w:31}, {n:'payload',t:'bytes',len:'len',fmt:'hex'}]},
  websocket:{ title:'WebSocket frame', group:'Application', fields:[
    {n:'fin',t:'bits',w:1}, {n:'rsv',t:'bits',w:3},
    {n:'opcode',t:'bits',w:4,enum:{0:'continuation',1:'text',2:'binary',8:'close',9:'ping',10:'pong'}},
    {n:'mask',t:'bits',w:1}, {n:'plen',t:'bits',w:7},
    {n:'plen16',t:'u16',when:'plen==126'}, {n:'plen64',t:'u64',when:'plen==127'},
    {n:'key',t:'bytes',len:4,fmt:'hex',when:'mask'}, {n:'payload',t:'rest'}]},

  /* ---------- IoT / промышленные ---------- */
  mqtt:{ title:'MQTT', group:'IoT / industrial', fields:[
    {n:'type',t:'bits',w:4,enum:{1:'CONNECT',2:'CONNACK',3:'PUBLISH',4:'PUBACK',5:'PUBREC',6:'PUBREL',7:'PUBCOMP',8:'SUBSCRIBE',9:'SUBACK',10:'UNSUBSCRIBE',11:'UNSUBACK',12:'PINGREQ',13:'PINGRESP',14:'DISCONNECT',15:'AUTH'}},
    {n:'flags',t:'bits',w:4}, {n:'remlen',t:'varint'},
    {n:'payload',t:'bytes',len:'remlen',sub:{by:'type',map:{1:'mqtt-connect',2:'mqtt-connack',3:'mqtt-publish',8:'mqtt-subscribe',9:'mqtt-suback'}}}]},
  'mqtt-connect':{ fields:[
    {n:'namelen',t:'u16'}, {n:'name',t:'str',len:'namelen',enc:'ascii'}, {n:'level',t:'u8'}, {n:'cflags',t:'u8',fmt:'hex'}, {n:'keepalive',t:'u16'},
    {n:'cidlen',t:'u16'}, {n:'cid',t:'str',len:'cidlen',enc:'utf8'}, {n:'rest',t:'rest'}]},
  'mqtt-connack':{ fields:[ {n:'ackflags',t:'u8'}, {n:'rc',t:'u8',enum:{0:'accepted',1:'bad protocol',2:'id rejected',3:'server unavailable',4:'bad credentials',5:'not authorized'}} ]},
  'mqtt-publish':{ fields:[
    {n:'tlen',t:'u16'}, {n:'topic',t:'str',len:'tlen',enc:'utf8'}, {n:'pid',t:'u16',when:'(flags>>1)&3'}, {n:'message',t:'rest'}]},
  'mqtt-subscribe':{ fields:[ {n:'pid',t:'u16'}, TLV('topics','mqtt-topic') ]},
  'mqtt-topic':{ fields:[ {n:'tlen',t:'u16'}, {n:'filter',t:'str',len:'tlen',enc:'utf8'}, {n:'qos',t:'u8'} ]},
  'mqtt-suback':{ fields:[ {n:'pid',t:'u16'}, {n:'codes',t:'rest'} ]},

  modbus:{ title:'Modbus TCP', group:'IoT / industrial', fields:[
    {n:'tid',t:'u16'}, {n:'pid',t:'u16'}, {n:'len',t:'u16'}, {n:'uid',t:'u8'},
    {n:'func',t:'u8',fmt:'hex',enum:{1:'read coils',2:'read discrete inputs',3:'read holding registers',4:'read input registers',5:'write single coil',6:'write single register',15:'write multiple coils',16:'write multiple registers',23:'read/write multiple registers',43:'encapsulated interface'}},
    {n:'data',t:'rest',sub:{by:'func>=128 ? 128 : func<=4 ? (len==6 ? 1 : 2) : (func==5||func==6) ? 3 : (func==15||func==16) ? (len==6 ? 5 : 4) : 0',
      map:{1:'mb-rd-req',2:'mb-rd-resp',3:'mb-wr1',4:'mb-wrn-req',5:'mb-wrn-resp',128:'mb-exc'}}}]},
  'mb-rd-req':{ fields:[ {n:'addr',t:'u16'}, {n:'qty',t:'u16'} ]},
  'mb-rd-resp':{ fields:[ {n:'bytes',t:'u8'}, {n:'values',t:'bytes',len:'bytes',fmt:'hex'} ]},
  'mb-wr1':{ fields:[ {n:'addr',t:'u16'}, {n:'value',t:'u16',fmt:'hex'} ]},
  'mb-wrn-req':{ fields:[ {n:'addr',t:'u16'}, {n:'qty',t:'u16'}, {n:'bytes',t:'u8'}, {n:'values',t:'bytes',len:'bytes',fmt:'hex'} ]},
  'mb-wrn-resp':{ fields:[ {n:'addr',t:'u16'}, {n:'qty',t:'u16'} ]},
  'mb-exc':{ fields:[ {n:'code',t:'u8',enum:{1:'illegal function',2:'illegal data address',3:'illegal data value',4:'device failure',6:'device busy'}} ]},
  coap:{ title:'CoAP', group:'IoT / industrial', fields:[
    {n:'ver',t:'bits',w:2}, {n:'type',t:'bits',w:2,enum:{0:'CON',1:'NON',2:'ACK',3:'RST'}}, {n:'tkl',t:'bits',w:4},
    {n:'cclass',t:'bits',w:3,enum:{0:'method',2:'success',4:'client error',5:'server error'}}, {n:'cdetail',t:'bits',w:5},
    {n:'mid',t:'u16'}, {n:'token',t:'bytes',len:'tkl',fmt:'hex'}, {n:'options',t:'rest'}]},
  can:{ title:'CAN frame (SocketCAN struct can_frame)', group:'IoT / industrial', endian:'le', fields:[
    {n:'id',t:'u32',fmt:'hex'}, {n:'dlc',t:'u8'}, {n:'pad',t:'bytes',len:3,fmt:'hex'}, {n:'data',t:'bytes',len:8,fmt:'hex'}]}
});
})();
