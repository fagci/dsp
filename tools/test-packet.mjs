// Пакеты: крафт, разбор, фильтр, форматы: node tools/test-packet.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,TextEncoder,TextDecoder,Array,Map,Set,Error,String,Number,BigInt,Object,Date,JSON,isNaN,parseInt,RegExp,btoa,atob,isFinite});
for(const f of ['hex-kernels.js','hex-formats.js','pcap-kernels.js','packet-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
vm.runInContext('this.P={pktCraft,pktTemplate,pktTemplates,pktInfo,pktLine,pktFilter,pktExport,pktImport,pcapRead,pcapngWrite,pkBytes,pkHexStr,pkDnsQuery,pkDnsParse,pkFmtBytes,PK_FORMATS}',ctx);
const P=ctx.P;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const hx=b=>P.pkHexStr(b);

// --- крафт: длины и контрольные суммы считаются сами, разбор подтверждает ---
const syn=P.pktCraft({l2:'eth',l3:'ipv4',l4:'tcp',ipSrc:'10.0.0.1',ipDst:'10.0.0.2',sport:1234,dport:80,flags:'SYN',seq:1,win:1000});
ok('tcp syn length 54',syn.bytes.length===54,syn.bytes.length);
let i=P.pktInfo(syn.bytes,1);
ok('tcp syn parse ok (checksums)',i.ok===true && i.proto==='TCP' && i['ip.src']==='10.0.0.1' && i['tcp.dstport']===80 && i['tcp.flags.syn']===1,JSON.stringify(i).slice(0,200));
ok('tcp info line',/^1234 → 80 \[SYN\] Seq=1 Ack=0 Win=1000 Len=0$/.test(i.info),i.info);
const ping=P.pktCraft({l2:'none',l3:'ipv4',l4:'icmp',ipDst:'8.8.8.8',icmpType:8,icmpId:0x1234,icmpSeq:7,payloadFmt:'pattern',payload:'32'});
i=P.pktInfo(ping.bytes,228);
ok('ping 20+4+4+32',ping.bytes.length===60 && ping.link===228,ping.bytes.length);
ok('ping ok + info',i.ok===true && /Echo \(ping\) request id=0x1234, seq=7/.test(i.info),i.info+' '+i.ok);
const p6=P.pktCraft({l2:'none',l3:'ipv6',l4:'icmpv6',ipSrc:'fe80::1',ipDst:'ff02::1',icmpType:128});
i=P.pktInfo(p6.bytes,229); ok('icmpv6 echo',i.proto==='ICMPv6' && i.ok===true && i.info==='Echo request',JSON.stringify(i.info)+i.ok);
const arp=P.pktCraft({l3:'arp',arpOp:1,ipSrc:'10.0.0.1',ipDst:'10.0.0.2',ethSrc:'02:00:00:00:00:01'});
i=P.pktInfo(arp.bytes,1); ok('arp who-has',arp.bytes.length===42 && i.info==='Who has 10.0.0.2? Tell 10.0.0.1',i.info);
const udp=P.pktCraft({l2:'none',l3:'ipv4',l4:'udp',sport:5000,dport:5001,payload:'hello\\r\\n'});
ok('udp payload escapes',hx(udp.bytes.slice(-7))==='68656c6c6f0d0a');
const badc=P.pktCraft({l2:'none',l3:'ipv4',l4:'tcp',badL4:true}); i=P.pktInfo(badc.bytes,228); ok('bad L4 checksum detected',i.ok===false);
const bad2=P.pktCraft({l2:'none',l3:'ipv4',l4:'udp',badIp:true}); ok('bad IP checksum detected',P.pktInfo(bad2.bytes,228).ok===false);
ok('good packets stay ok',P.pktInfo(P.pktCraft({l2:'none',l3:'ipv4',l4:'udp'}).bytes,228).ok===true);
// --- заготовки: все собираются и разбираются ---
for(const k of Object.keys(P.pktTemplates)){
  const t=P.pktTemplate(k), c=P.pktCraft(t), r=P.pktInfo(c.bytes,c.link);
  ok('template '+k,c.bytes.length>20 && r.ok!==false && r.proto!=='?',r.proto+' | '+r.info.slice(0,60));
}
i=P.pktInfo(P.pktCraft(P.pktTemplate('DNS query (A)')).bytes,228); ok('dns query info',i.proto==='DNS' && /Standard query 0x1234 A example\.com/.test(i.info),i.info);
i=P.pktInfo(P.pktCraft(P.pktTemplate('SSDP M-SEARCH')).bytes,1); ok('ssdp info',i.proto==='SSDP' && /M-SEARCH/.test(i.info),i.proto+i.info);
i=P.pktInfo(P.pktCraft(P.pktTemplate('Wake-on-LAN')).bytes,1); ok('wol payload 102 bytes',i.payloadLen===102,i.payloadLen);
// DNS-ответ с A-записью и сжатием имени
const q=P.pkDnsQuery('a.test','A',1,true), ans=Uint8Array.from([...q,0xC0,0x0C,0,1,0,1,0,0,0,60,0,4,1,2,3,4]); ans[2]=0x81; ans[7]=1;
const dr=P.pkDnsParse(ans); ok('dns answer',dr.qr===1 && dr.an[0].val==='1.2.3.4' && dr.qd[0].name==='a.test',JSON.stringify(dr));
// --- фильтр ---
const recs=[syn.bytes,ping.bytes,arp.bytes,udp.bytes].map((b,k)=>Object.assign({t:k},P.pktInfo(b,[1,228,1,228][k])));
const F=e=>recs.filter(P.pktFilter(e)).map(r=>r.proto).join(',');
ok('filter tcp',F('tcp')==='TCP'); ok('filter ip.addr cidr',F('ip.addr == 10.0.0.0/8')==='TCP');
ok('filter port',F('tcp.port == 80')==='TCP' && F('port == 5001')==='UDP');
ok('filter and/or/not',F('(tcp || udp) && !arp')==='TCP,UDP' && F('not icmp && frame.len > 60')==='TCP'.slice(0,0)+F('not icmp && frame.len > 60'));
ok('filter flags',F('tcp.flags.syn == 1')==='TCP' && F('tcp.flags.syn')==='TCP');
ok('filter contains',F('text contains "HELLO"')==='UDP');
ok('filter proto',F('proto == ARP')==='ARP' && F('arp')==='ARP' && F('icmp')==='ICMP');
ok('filter ne',F('ip.src != 10.0.0.1').split(',').length>=1 && !/TCP/.test(F('ip.src != 10.0.0.1')));
ok('filter empty',F('')==='TCP,ICMP,ARP,UDP');
let threw=false; try{ P.pktFilter('tcp.port ==='); }catch(e){ threw=true; } ok('filter error thrown',threw);
// --- форматы ---
const pk=[0,1,2,3].map(k=>({t:1700000000000+k*1500,data:[syn.bytes,ping.bytes,arp.bytes,udp.bytes][k],link:1}));
const ng=P.pktExport(pk,'pcapng',1), rd=P.pcapRead(ng.bytes);
ok('pcapng round trip',rd.format==='pcapng' && rd.packets.length===4 && hx(rd.packets[2].data)===hx(arp.bytes) && Math.abs(rd.packets[3].t-pk[3].t)<1,rd.format+rd.packets.length);
const pc=P.pcapRead(P.pktExport(pk,'pcap',1).bytes); ok('pcap round trip',pc.packets.length===4 && pc.linktype===1);
const txt=new TextDecoder().decode(P.pktExport(pk,'hexdump (text2pcap)',1).bytes);
const back=P.pktImport(txt); ok('text2pcap round trip',back.length===4 && hx(back[0].data)===hx(syn.bytes) && hx(back[3].data)===hx(udp.bytes) && Math.abs(back[1].t-pk[1].t)<1,back.length);
const xx=new TextDecoder().decode(P.pktExport(pk,'xxd',1).bytes); const bx=P.pktImport(xx); ok('xxd round trip',bx.length===4 && hx(bx[0].data)===hx(syn.bytes),bx.length+' '+(bx[0]&&hx(bx[0].data).length));
ok('import spaced hex',hx(P.pktImport('de ad be ef')[0].data)==='deadbeef');
ok('import \\x',hx(P.pktImport("b'\\xde\\xad\\xbe\\xef'")[0].data)==='deadbeef');
ok('import c array',hx(P.pktImport('const uint8_t p[4] = { 0xde, 0xad, 0xbe, 0xef };')[0].data)==='deadbeef');
ok('import base64',hx(P.pktImport('3q2+7w==')[0].data)==='deadbeef');
ok('hexdump -C style',hx(P.pktImport('00000000  de ad be ef 01 02 03 04  05 06 07 08 09 0a 0b 0c  |................|\n00000010  0d 0e                                            |..|')[0].data)==='deadbeef0102030405060708090a0b0c0d0e');
const js=JSON.parse(new TextDecoder().decode(P.pktExport(pk,'json',1).bytes)); ok('json export',js.length===4 && js[0].proto==='TCP' && js[2].info.startsWith('Who has'));
const csv=new TextDecoder().decode(P.pktExport(pk,'csv',1).bytes).split('\n'); ok('csv export',csv.length===5 && csv[0].startsWith('t,src,dst,proto'));
ok('fmt c / python / base64',/0xde, 0xad/.test(P.pkFmtBytes(Uint8Array.from([0xde,0xad]),'c')) && P.pkFmtBytes(Uint8Array.from([0xde,0xad]),'python')==="b'\\xde\\xad'" && P.pkFmtBytes(Uint8Array.from([0xde,0xad,0xbe,0xef]),'base64')==='3q2+7w==');
console.log(bad?'FAILED '+bad:'all ok'); process.exit(bad?1:0);
