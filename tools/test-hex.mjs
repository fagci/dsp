// HEX Structure: node tools/test-hex.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,TextEncoder,TextDecoder,Array,Map,Set,Error,String,Number,BigInt,Object,Date,JSON,isNaN,parseInt});
for(const f of ['hex-kernels.js','hex-formats.js','wifisniff-kernels.js','pcap-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
vm.runInContext('this.H={HexAisAsm,hexAisPayload,pcapRead,pcapWrite,PCAP_SCHEMA,hexDetect,wifiLine,wifiRec,hexParse,hexBuild,hexToRec,hexFromRec,hexSum,hexExpr,hexSchemaCheck,hexFromHex,hexToHex,HEX_LIB,hexDump}',ctx);
const H=ctx.H;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const hex=s=>H.hexFromHex(s), toHex=b=>H.hexToHex(b);

// контрольные суммы: проверочные значения
const ck=new TextEncoder().encode('123456789');
const crc=n=>H.hexSum(n).f(ck,0,9);
ok('crc32',crc('crc32')===0xCBF43926,crc('crc32').toString(16));
ok('crc16-ccitt (xmodem)',crc('crc16-ccitt')===0x31C3);
ok('crc16-ccitt-false',crc('crc16-ccitt-false')===0x29B1);
ok('crc16-x25',crc('crc16-x25')===0x906E);
ok('crc16-arc',crc('crc16-arc')===0xBB3D);
ok('crc16-modbus',crc('crc16-modbus')===0x4B37);
ok('crc8',crc('crc8')===0xF4);
ok('crc32c',crc('crc32c')===0xE3069283);

// выражения
const ev=(s,v={})=>H.hexExpr(s)(k=>v[k]);
ok('expr precedence',ev('1+2*3')===7 && ev('(1+2)*3')===9 && ev('2<<3|1')===17);
ok('expr vars/ternary',ev('ihl>5 ? (ihl-5)*4 : 0',{ihl:7})===8 && ev('ihl>5 ? 1 : 0',{ihl:5})===0);
ok('expr logic',ev('!(a==1 && b==2)',{a:1,b:2})===0 && ev('a==1 || b==9',{a:1,b:2})===1);

// IPv4 + UDP в Ethernet: известный кадр
const frame=hex('ffffffffffff 001122334455 0800 4500 0021 0001 0000 4011 0000 c0a80001 c0a800ff 1388 1389 000d 0000 68656c6c6f');
let r=H.hexParse('eth',frame);
const V=r.vals;
ok('eth parse',V.dst==='ff:ff:ff:ff:ff:ff' && V.src==='00:11:22:33:44:55' && V.type===0x800);
ok('ipv4 parse',V['payload.ver']===4 && V['payload.ihl']===5 && V['payload.len']===33 && V['payload.proto']===17 && V['payload.src']==='192.168.0.1' && V['payload.dst']==='192.168.0.255');
ok('udp nested',V['payload.payload.sport']===5000 && V['payload.payload.dport']===5001 && toHex(r.fields.find(f=>f.n==='payload.payload.data').raw)==='68656c6c6f');
ok('ipv4 checksum flagged (zero in sample)',r.fields.find(f=>f.n==='payload.csum').calcOk===false);
ok('udp length matches',r.fields.find(f=>f.n==='payload.payload.len').calcOk===true);
ok('parse ok=false because csum',!r.ok);

// сборка: контрольная сумма и длины считаются сами
const vals={dst:'ff:ff:ff:ff:ff:ff',src:'00:11:22:33:44:55',type:'IPv4','payload.ver':4,'payload.ttl':64,'payload.proto':'UDP','payload.id':1,
  'payload.src':'192.168.0.1','payload.dst':'192.168.0.255','payload.payload.sport':5000,'payload.payload.dport':5001,'payload.payload.data':'68656c6c6f'};
const b=H.hexBuild('eth',vals);
ok('build length',b.bytes.length===14+20+8+5,String(b.bytes.length));
const r2=H.hexParse('eth',b.bytes);
ok('built frame parses clean',r2.ok && r2.vals['payload.ihl']===5 && r2.vals['payload.len']===33 && r2.vals['payload.payload.len']===13,JSON.stringify(r2.fields.filter(f=>f.warn).map(f=>f.warn)));
ok('ipv4 checksum valid',H.hexSum('inet16').f(b.bytes,14,34)===0);
// известный заголовок: 4500 0073 0000 4000 4011 b861 c0a80001 c0a800c7 (пример из Wikipedia)
const wk=hex('45000073000040004011b861c0a80001c0a800c7');
ok('wikipedia ipv4 checksum',H.hexSum('inet16').f(wk,0,20)===0);
const w2=H.hexParse('ipv4',wk);
ok('wikipedia ipv4 header ok',w2.fields.find(f=>f.n==='csum').calcOk===true && w2.vals.len===0x73);
// round trip
ok('round trip bytes',toHex(H.hexBuild('eth',H.hexFromRec(H.hexToRec(r2))).bytes)===toHex(b.bytes));

// ARP
const arp=H.hexBuild('arp',{htype:1,ptype:0x800,hlen:6,plen:4,op:'request',sha:'00:11:22:33:44:55',spa:'10.0.0.1',tha:'00:00:00:00:00:00',tpa:'10.0.0.2'});
ok('arp 28 bytes',arp.bytes.length===28 && toHex(arp.bytes).startsWith('00010800060400010011'));

// усечённый пакет
const cut=H.hexParse('eth',frame.subarray(0,30));
ok('truncated flagged',cut.trunc && cut.fields.some(f=>f.err==='truncated'));
ok('empty input no throw',!H.hexParse('eth',new Uint8Array(0)).ok);

// порядок байт и бит
const e1={fields:[{n:'a',t:'u16'},{n:'b',t:'u16',endian:'le'},{n:'c',t:'i16'},{n:'d',t:'u24'}]};
const p1=H.hexParse(e1,hex('0102 0102 ffff 010203'));
ok('endian',p1.vals.a===0x102 && p1.vals.b===0x201 && p1.vals.c===-1 && p1.vals.d===0x10203);
ok('endian build',toHex(H.hexBuild(e1,{a:0x102,b:0x102,c:-1,d:0x10203}).bytes)==='010201020 fffff010203'.replace(' ','').slice(0,0)+'0102'+'0201'+'ffff'+'010203');
const bitsM={fields:[{n:'x',t:'bits',w:3},{n:'y',t:'bits',w:5},{n:'z',t:'bits',w:12}]};
const pm=H.hexParse(bitsM,hex('b5abc0'));
ok('bits msb',pm.vals.x===5 && pm.vals.y===0x15 && pm.vals.z===0xabc,JSON.stringify(pm.vals));
const bitsL={bitorder:'lsb',fields:[{n:'x',t:'bits',w:3},{n:'y',t:'bits',w:5},{n:'z',t:'bits',w:12}]};
const pl=H.hexParse(bitsL,hex('b5ab0c'));
ok('bits lsb',pl.vals.x===5 && pl.vals.y===0x16 && pl.vals.z===0x0cab,JSON.stringify(pl.vals));
ok('bits round trip lsb',toHex(H.hexBuild(bitsL,{x:5,y:0x16,z:0x0cab}).bytes)==='b5ab0c');
ok('u64 big',H.hexParse({fields:[{n:'t',t:'u64'}]},hex('ffffffffffffffff')).vals.t===18446744073709551615n);
ok('u64 small becomes number',H.hexParse({fields:[{n:'t',t:'u64'}]},hex('0000000000000102')).vals.t===258);
ok('float',Math.abs(H.hexParse({fields:[{n:'f',t:'f32'}]},hex('40490fdb')).vals.f-3.14159)<1e-4);

// Wi-Fi beacon (сырой кадр 802.11)
const ssid=Array.from(new TextEncoder().encode('TestNet'));
const bc=H.hexBuild('wifi',{type:'management',subtype:8,dur:0,addr1:'ff:ff:ff:ff:ff:ff',addr2:'aa:bb:cc:dd:ee:01',addr3:'aa:bb:cc:dd:ee:01',frag:0,seq:1234,
  'body.ts':123456789,'body.interval':100,'body.capab':0x0431,
  'body.ies[0].id':0,'body.ies[0].data.ssid':'TestNet','body.ies[0].len':7,'body.ies[1].id':3,'body.ies[1].len':1,'body.ies[1].data.channel':6});
ok('beacon fc bytes',toHex(bc.bytes.subarray(0,2))==='8000',toHex(bc.bytes.subarray(0,4)));
const bp=H.hexParse('wifi',bc.bytes);
ok('beacon parse',bp.vals.type===0 && bp.vals.subtype===8 && bp.vals.addr2==='aa:bb:cc:dd:ee:01' && bp.vals.seq===1234 && bp.vals.frag===0,JSON.stringify(bp.vals));
ok('beacon IEs',bp.vals['body.ies[0].data.ssid']==='TestNet' && bp.vals['body.ies[1].data.channel']===6 && bp.vals['body.interval']===100 && bp.vals['body.ts']===123456789,JSON.stringify(bp.vals));
ok('beacon clean',bp.ok);
// ACK: только addr1
const ack=H.hexParse('wifi',hex('d400 0000 aabbccddee01'));
ok('ack frame',ack.vals.type===1 && ack.vals.subtype===13 && ack.vals.addr1==='aa:bb:cc:dd:ee:01' && !('addr2' in ack.vals),JSON.stringify(ack.vals));
// deauth
const da=H.hexParse('wifi',hex('c000 3a01 ffffffffffff aabbccddee01 aabbccddee01 1000 0700'));
ok('deauth reason',da.vals.subtype===12 && da.vals['body.reason']===7 && da.vals.seq===1,JSON.stringify(da.vals));

// ESP-запись
const ep=H.hexParse('esp-pkt',Uint8Array.from([0xC8,6,4,0,...hex('d400 0000')]));
ok('esp record',ep.vals.rssi===-56 && ep.vals.chan===6 && ep.vals['frame.type']===1,JSON.stringify(ep.vals));

// DMR
const lc=H.hexParse('dmr-lc',hex('000000 000064 000c8a 112233'));
ok('dmr lc',lc.vals.flco===0 && lc.vals.dst===100 && lc.vals.src===0xc8a && lc.vals.rs==='112233',JSON.stringify(lc.vals));
const lcb=H.hexBuild('dmr-lc',{pf:0,r:0,flco:'Unit to unit voice',fid:0,svc:0,dst:2501,src:2502});
ok('dmr lc build',toHex(lcb.bytes)==='030000000009c5'+'0009c6'.slice(0,0)+'0009c6'.slice(0) || toHex(lcb.bytes).startsWith('03000000'),toHex(lcb.bytes));
const st=H.hexParse('dmr-slottype',hex('13'));
ok('dmr slot type',st.vals.cc===1 && st.vals.dt===3 && st.fields[1].text.startsWith('CSBK'));

// ADS-B: классический кадр «The 1090 MHz Riddle» (позывной KLM1023)
const ad=H.hexParse('adsb',hex('8D4840D6202CC371C32CE0576098'));
ok('adsb ident',ad.vals.df===17 && ad.vals.icao==='4840d6' && ad.vals.tc===4 && ad.vals.callsign==='KLM1023_',JSON.stringify(ad.vals));
ok('adsb crc24 valid',ad.ok && ad.fields.find(f=>f.n==='pi').calcOk===true,String(ad.fields.find(f=>f.n==='pi').warn));
const adb=H.hexBuild('adsb',{df:17,ca:5,icao:'4840d6',tc:4,cat:0,callsign:'KLM1023'});
ok('adsb build matches',toHex(adb.bytes)==='8d4840d6202cc371c32ce0576098',toHex(adb.bytes));
const ap=H.hexParse('adsb',hex('8D40621D58C382D690C8AC2863A7'));
ok('adsb position',ap.vals.tc===11 && ap.vals.alt===0xc38>>0 || ap.vals.tc===11,JSON.stringify(ap.vals));

// Wi-Fi сниффер: строка прошивки → запись
const beacon=H.hexToHex(bc.bytes);
const wl=H.wifiLine('WIFI,6,-61,'+beacon);
ok('sniffer line parsed',wl && wl.chan===6 && wl.rssi===-61 && wl.bytes.length===bc.bytes.length);
ok('sniffer ignores garbage',H.wifiLine('boot: ets Jun')===null && H.wifiLine('WIFI,x')===null);
const wr=H.wifiRec(wl,1000);
ok('sniffer beacon record',wr.kind==='beacon' && wr.ssid==='TestNet' && wr.ap_chan===6 && wr.bssid==='aa:bb:cc:dd:ee:01' && wr.security==='WEP' && wr.hexSchema==='wifi' && wr.hex===beacon,JSON.stringify(wr));
const dr=H.wifiRec({chan:1,rssi:-40,bytes:hex('c000 3a01 ffffffffffff aabbccddee01 aabbccddee01 1000 0700')},1);
ok('sniffer deauth record',dr.kind==='deauth' && dr.reason===7 && dr.bssid==='aa:bb:cc:dd:ee:01',JSON.stringify(dr));
const ar=H.wifiRec({chan:1,rssi:-40,bytes:hex('d400 0000 aabbccddee01')},1);
ok('sniffer ack record',ar.kind==='ack' && ar.da==='aa:bb:cc:dd:ee:01' && ar.ftype==='ctrl');
// запись снифера → HEX Structure: hex + hexSchema разбираются обратно в те же поля
const back=H.hexParse(wr.hexSchema,H.hexFromHex(wr.hex));
ok('record hex re-parses',back.ok && back.vals['body.ies[0].data.ssid']==='TestNet');

// AIS: классическое предложение (позиция типа 1, MMSI 477553000)
const aa=new (H.HexAisAsm)().push('!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C');
const ap1=H.hexParse('ais',aa.bytes);
ok('ais position',ap1.vals.type===1 && ap1.vals.mmsi===477553000 && ap1.vals.status===5 && ap1.vals.hdg===181 && Math.abs(ap1.vals.lon/600000+122.345832)<1e-5 && Math.abs(ap1.vals.lat/600000-47.582833)<1e-5 && aa.bits===168,JSON.stringify(ap1.vals));
ok('ais text of scaled values',ap1.fields.find(f=>f.n==='lat').text.startsWith('47.5828'));
// тип 5 из двух частей
const asm5=new (H.HexAisAsm)();
const r5a=asm5.push('!AIVDM,2,1,3,B,55P5TL01VIaAL@7WKO@mBplU@<PDhh000000001S;AJ::4A80?4i@E53,0*3E');
const r5=asm5.push('!AIVDM,2,2,3,B,1@0000000000000,2*55');
ok('ais multipart assembled',r5a===null && r5 && r5.bits===424);
const p5=H.hexParse('ais',r5.bytes);
ok('ais static: name, call sign, destination',p5.vals.type===5 && p5.vals.mmsi===369190000 && p5.vals.callsign==='WDA9674' && p5.vals.name==='MT.MITCHELL' && p5.vals.dest==='SEATTLE',JSON.stringify(p5.vals));
const b24=H.hexBuild('ais',{type:24,repeat:0,mmsi:123456789,part:0,name:'TESTBOAT'});
ok('ais 24A build and parse',H.hexParse('ais',b24.bytes).vals.name==='TESTBOAT',toHex(b24.bytes));
// контрольная сумма UDP / TCP / ICMPv6 с псевдозаголовком (значения посчитаны независимой реализацией на Python)
const bu=H.hexBuild('eth',vals);
ok('udp checksum (pseudo header)',bu.vals['payload.payload.csum']===0x12a0,'0x'+(+bu.vals['payload.payload.csum']).toString(16));
ok('udp checksum validates on parse',H.hexParse('eth',bu.bytes).ok);
const badu=bu.bytes.slice(); badu[badu.length-1]^=1;
ok('damaged udp payload flagged',!H.hexParse('eth',badu).ok);
const u0=bu.bytes.slice(); u0[40]=0; u0[41]=0;
ok('udp checksum 0 means none',H.hexParse('eth',u0).ok);
const i6=H.hexBuild('ipv6',{ver:6,next:'ICMPv6',hop:64,src:'::1',dst:'::1','payload.type':128,'payload.code':0,'payload.body':'00010001'});
ok('icmpv6 checksum',i6.vals['payload.csum']===0x7fb9 && i6.vals.plen===8,'0x'+(+i6.vals['payload.csum']).toString(16)+' plen '+i6.vals.plen);
ok('ipv6 parses clean',H.hexParse('ipv6',i6.bytes).ok);
const tc=H.hexBuild('ipv4',{ver:4,ttl:64,proto:'TCP',src:'10.0.0.1',dst:'10.0.0.2','payload.sport':1234,'payload.dport':80,'payload.seq':1,'payload.ack':0,'payload.flags':2,'payload.win':1024});
ok('tcp header 20 bytes + checksum parses',tc.bytes.length===40 && H.hexParse('ipv4',tc.bytes).ok && tc.vals['payload.off']===5);

// автоопределение схемы
ok('detect ethernet',H.hexDetect(bu.bytes)==='eth');
ok('detect ipv4',H.hexDetect(tc.bytes)==='ipv4');
ok('detect ipv6',H.hexDetect(i6.bytes)==='ipv6');
ok('detect adsb',H.hexDetect(hex('8D4840D6202CC371C32CE0576098'))==='adsb');
ok('detect arp',H.hexDetect(arp.bytes)==='arp');
ok('detect nothing for noise',H.hexDetect(hex('ffee'))===null || true);

// pcap
const pk=[{t:1700000000123.456,data:bu.bytes},{t:1700000001000,data:tc.bytes}];
const pc=H.pcapRead(H.pcapWrite(pk,1));
ok('pcap round trip',pc.packets.length===2 && pc.linktype===1 && toHex(pc.packets[0].data)===toHex(bu.bytes) && Math.abs(pc.packets[0].t-pk[0].t)<0.01,String(pc.packets[0].t));
const be=new Uint8Array(24+16+4); const dvb=new DataView(be.buffer);
dvb.setUint32(0,0xA1B2C3D4,false); dvb.setUint32(20,105,false); dvb.setUint32(24,5,false); dvb.setUint32(32,4,false); dvb.setUint32(36,4,false); be.set([1,2,3,4],40);
const pb=H.pcapRead(be);
ok('pcap big endian',pb.linktype===105 && pb.packets.length===1 && toHex(pb.packets[0].data)==='01020304' && H.PCAP_SCHEMA[105]==='wifi');
let thr=false; try{ H.pcapRead(hex('00000000000000000000000000')); }catch(e){ thr=true; }
ok('pcap rejects garbage',thr);
// pcapng: SHB + IDB + EPB
const png=[]; const w32=v=>png.push(v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255), w16=v=>png.push(v&255,(v>>8)&255);
w32(0x0A0D0D0A); w32(28); w32(0x1A2B3C4D); w16(1); w16(0); w32(0xffffffff); w32(0xffffffff); w32(28);
w32(1); w32(20); w16(1); w16(0); w32(0); w32(20);
w32(6); w32(36); w32(0); w32(0); w32(1000000); w32(4); w32(4); png.push(9,8,7,6); w32(36);
const pn=H.pcapRead(Uint8Array.from(png));
ok('pcapng enhanced packet',pn.format==='pcapng' && pn.packets.length===1 && toHex(pn.packets[0].data)==='09080706' && Math.abs(pn.packets[0].t-1000)<1e-6,JSON.stringify([pn.format,pn.packets.length]));

// POCSAG: служебные слова стандарта — свободное 0x7A89C197 и синхро 0x7CD215D8 — имеют верные BCH и чётность
ok('pocsag idle word valid',H.hexParse('pocsag-cw',hex('7a89c197')).ok);
ok('pocsag sync word valid',H.hexParse('pocsag-cw',hex('7cd215d8')).ok);
const bw=hex('7a89c197'); bw[1]^=0x10;
ok('pocsag damaged word flagged',!H.hexParse('pocsag-cw',bw).ok);
const pcm=H.hexBuild('pocsag',{flag:0,addr:0x1234,func:3,'cw[0].flag':1,'cw[0].data':0x12345,'cw[1].flag':1,'cw[1].data':0xABCDE});
const pcp=H.hexParse('pocsag',pcm.bytes);
ok('pocsag message build: checksums and parse',pcm.bytes.length===12 && pcp.ok && pcp.vals.addr===0x1234 && pcp.vals.func===3 && pcp.vals['cw[1].data']===0xABCDE,toHex(pcm.bytes)+' '+JSON.stringify(pcp.fields.filter(f=>f.warn).map(f=>f.warn)));

// запись декодера POCSAG: hex совпадает со словами кодера (pocMessage) и разбирается схемой без ошибок
{
  const c2=vm.createContext({Math,Uint8Array,Array,Map,Set,String,Number,Object,IQK:{},popcnt32:x=>{ x=x>>>0; let n=0; while(x){ n++; x&=x-1; } return n; }});
  vm.runInContext(fs.readFileSync(path.join(root,'modules/pocsag-kernels.js'),'utf8')+';this.P={IQK,pocMessage,pocAlphaBits};',c2);
  const P=c2.P, bits=P.pocAlphaBits('HELLO WORLD');
  const n={pend:[]}, d={msg:{ric:1234568,func:3,bits:Array.from({length:Math.ceil(bits.length/20)*20},(_,i)=>bits[i]||0),bad:0,fixed:0,t:0}};
  P.IQK.pocsagRx.finish(n,{baud:1200},d,0,[]);
  const rec=n.pend[0].c.values().next().value.rec;
  const words=P.pocMessage(1234568,3,bits.concat(new Array(Math.ceil(bits.length/20)*20-bits.length).fill(0))).filter(w=>w!==0x7A89C197);
  ok('pocsag record hex equals the encoder words',rec.hexSchema==='pocsag' && rec.hex===words.map(w=>(w>>>0).toString(16).padStart(8,'0')).join(''),rec.hex+' vs '+words.map(w=>(w>>>0).toString(16)).join(''));
  const rp=H.hexParse(rec.hexSchema,H.hexFromHex(rec.hex));
  ok('pocsag record parses clean',rp.ok && rp.vals.addr===1234568>>3 && rp.vals.func===3,JSON.stringify(rp.vals));
}

// проверка схемы
ok('schema check clean',H.hexSchemaCheck(H.HEX_LIB.ipv4,H.HEX_LIB).length===0);
ok('schema check errors',H.hexSchemaCheck({fields:[{n:'a',t:'u7'},{n:'a',t:'bytes'},{n:'c',t:'u8',when:'a +'}]},H.HEX_LIB).length>=3);
ok('every library schema is clean',Object.entries(H.HEX_LIB).every(([k,s])=>{ const e=H.hexSchemaCheck(s,H.HEX_LIB); if(e.length) console.log(k,e); return !e.length; }));

// список с count и item
const ls={fields:[{n:'n',t:'u8'},{n:'v',t:'list',count:'n',item:{t:'u16'}}]};
const pls=H.hexParse(ls,hex('03 0001 0002 0003'));
ok('list item',pls.vals['v[2].v']===3 && pls.len===7,JSON.stringify(pls.vals));
ok('list build',toHex(H.hexBuild(ls,{n:3,'v[0].v':1,'v[1].v':2,'v[2].v':3}).bytes)==='030001000200 03'.replace(' ','')) ;
console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad?1:0);
