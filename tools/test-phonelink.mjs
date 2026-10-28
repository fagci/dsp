// Команды Bluetooth / сети приложения DSP: node tools/test-phonelink.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,Uint8Array,DataView,TextDecoder,TextEncoder,parseInt,isFinite,Error,Infinity});
const load=f=>vm.runInContext(fs.readFileSync(new URL('../modules/'+f,import.meta.url),'utf8'),ctx);
load('ble-kernels.js'); load('dnsq-kernels.js'); load('phonelink-kernels.js');
vm.runInContext('this.K={plGattCmd,plNetCmd,plScanOpts,plDecode,plLine,plAdvCmd,plDnsReply,dnsParse,plSysCmd,PL_SYS_ACTIONS,plSrvDef,plNsdType}',ctx);
const K=ctx.K, J=o=>JSON.stringify(o);

// скан
ok('scan options: defaults send nothing',K.plScanOpts({})===null && K.plScanOpts({bleMode:'low_latency',blePhy:'all',bleMatch:'default'})===null);
const so=K.plScanOpts({bleMode:'low_power',bleLegacy:'extended only',blePhy:'coded',bleDelay:2000,bleName:' Mi ',bleAddr:'aa:bb:cc:dd:ee:ff',bleUuid:'180d',bleMfr:'0x004C'});
ok('scan options: mode, extended, coded PHY, batching, filters',so.mode==='low_power' && so.legacy===false && so.phy==='coded' && so.delay===2000 && so.name==='Mi' && so.addr==='AA:BB:CC:DD:EE:FF' && so.uuid==='180d' && so.mfr==='004C',J(so));
ok('scan options: bad address / company ignored',K.plScanOpts({bleAddr:'zz',bleMfr:'xyz'})===null);

// GATT
const base={action:'connect',addr:'aa:bb:cc:dd:ee:ff',svc:'180d',chr:'2a37',wfmt:'hex',data:'',resp:true,phy:'1m',mtu:0};
ok('connect: address upper-cased, auto flags',(c=>c.cmd==='gatt.connect' && c.addr==='AA:BB:CC:DD:EE:FF' && c.read===false)(K.plGattCmd(base)));
ok('connect needs an address',K.plGattCmd({...base,addr:''}).error && K.plGattCmd({...base,addr:'12'}).error);
ok('the addr input overrides the field',K.plGattCmd(base,{addr:'11:22:33:44:55:66'}).addr==='11:22:33:44:55:66');
ok('autoRead / autoNotify / readMax',(c=>c.read && c.notify && c.max===5)(K.plGattCmd({...base,autoRead:true,autoNotify:true,readMax:5})));
ok('read / notify need UUIDs',K.plGattCmd({...base,action:'read',svc:''}).error && K.plGattCmd({...base,action:'read'}).cmd==='gatt.read' && K.plGattCmd({...base,action:'notify off'}).on===false && K.plGattCmd({...base,action:'notify on'}).on===true);
ok('write: hex normalised, response flag',(c=>c.cmd==='gatt.write' && c.hex==='0a0bff' && c.resp===true)(K.plGattCmd({...base,action:'write',data:'0A 0b:FF'})));
ok('write: bad hex / empty refused, text goes as text',K.plGattCmd({...base,action:'write',data:'xyz'}).error && K.plGattCmd({...base,action:'write',data:''}).error && K.plGattCmd({...base,action:'write',wfmt:'text',data:'AT\r\n'}).text==='AT\r\n');
ok('the data input overrides the field',K.plGattCmd({...base,action:'write',data:'00'},{data:'ff'}).hex==='ff');
ok('rfcomm and bonding',K.plGattCmd({...base,action:'rfcomm connect',secure:true}).cmd==='bt.connect' && K.plGattCmd({...base,action:'rfcomm connect',uuid:'6e400001-b5a3-f393-e0a9-e50e24dcca9e'}).uuid && K.plGattCmd({...base,action:'bonded'}).cmd==='bt.bonded' && K.plGattCmd({...base,action:'bond'}).cmd==='bt.bond' && K.plGattCmd({...base,action:'rfcomm listen'}).cmd==='bt.listen');
const adv=K.plGattCmd({action:'adv start',advName:true,advUuids:'180d, fe95',advMfr:'004c=0215aabb;ffff=01',advSvc:'fe95=0102',advMode:'low_latency',advExt:true,phy:'coded',advConn:true});
ok('advertising: name, UUIDs, manufacturer / service data, extended + coded PHY',adv.cmd==='ble.adv.start' && adv.name && adv.uuids.join()==='180d,fe95' && adv.mfr['004c']==='0215aabb' && adv.mfr.ffff==='01' && adv.svc.fe95==='0102' && adv.ext && adv.phy==='coded' && adv.mode==='low_latency',J(adv));
ok('advertising: plain one is legacy 1M',(c=>c.ext===false && c.phy==='1m')(K.plGattCmd({action:'adv start',phy:'coded'})));
ok('unknown action',K.plGattCmd({action:'zzz'}).error);

// значения
ok('decode: battery level 87 %',(r=>r.value===87 && r.unit==='%')(K.plDecode('57','auto','2a19')));
ok('decode: Environmental temperature 23.45 °C (sint16 ×0.01)',Math.abs(K.plDecode('2909','auto','2a6e').value-23.45)<1e-9);
ok('decode: humidity 55.5 %',Math.abs(K.plDecode('ae15','auto','2a6f').value-55.5)<1e-9);
ok('decode: heart rate 72 bpm (8-bit format)',K.plDecode('0048','auto','2a37').value===72);
ok('decode: text, trailing NULs dropped',K.plDecode('546573740000','auto','2a24').text==='Test' && K.plDecode('68656c6c6f','text').text==='hello');
ok('decode: unknown UUID → hex only, explicit format works',K.plDecode('0102','auto','1234').value===null && K.plDecode('0102','uint16 LE').value===0x0201 && K.plDecode('0102','uint16 LE','',0.5).value===0x0201*0.5);
ok('decode: a UUID of Nordic UART TX is text',K.plDecode('4f4b','auto','6e400003-b5a3-f393-e0a9-e50e24dcca9e').text==='OK');

// сеть
const nb={action:'tcp connect',host:'example.com',port:80,conn:0,data:'',dfmt:'text',timeout:5000};
ok('tcp connect / listen',K.plNetCmd(nb).cmd==='tcp.connect' && K.plNetCmd({...nb,host:''}).error && K.plNetCmd({...nb,action:'tcp listen',port:8080,lan:true}).lan===true && K.plNetCmd({...nb,action:'tcp listen',port:0}).error);
ok('tcp send: text escapes, hex, needs conn',K.plNetCmd({...nb,action:'tcp send',conn:3,data:'GET / HTTP/1.0\\r\\n\\r\\n'}).text==='GET / HTTP/1.0\r\n\r\n' && K.plNetCmd({...nb,action:'tcp send',conn:3,dfmt:'hex',data:'48 49'}).hex==='4849' && K.plNetCmd({...nb,action:'tcp send',data:'x'}).error);
ok('udp: send / open / request',K.plNetCmd({...nb,action:'udp send',port:9,data:'hi'}).cmd==='udp.send' && K.plNetCmd({...nb,action:'udp open',port:5000}).cmd==='udp.open' && K.plNetCmd({...nb,action:'udp request',port:123,dfmt:'hex',data:'1b'+'00'.repeat(47)}).cmd==='udp.request');
ok('ping, one traceroute step',(c=>c.cmd==='ping' && c.count===4 && c.size===56 && c.timeout===2)(K.plNetCmd({...nb,action:'ping',count:4,size:56,timeout:2000})) && K.plNetCmd({...nb,action:'traceroute step',ttl:3}).ttl===3 && K.plNetCmd({...nb,action:'traceroute step'},{ttl:99}).ttl===64);
const dq=K.plNetCmd({...nb,action:'dns',dnsName:'example.com',dnsType:'MX',dnsServer:'@dns',dnsPort:53});
ok('dns: a query packet sent as udp.request to the network DNS',dq.cmd==='udp.request' && dq.host==='@dns' && dq.port===53 && dq.hex.endsWith('00000f0001') && dq._dns.type==='MX' && dq.hex.length%2===0,J(dq));
ok('dns: bad label refused, PTR of an address is reversed',K.plNetCmd({...nb,action:'dns',dnsName:'a'.repeat(70)+'.com'}).error && K.plNetCmd({...nb,action:'dns',dnsName:'8.8.4.4',dnsType:'PTR'}).hex.includes(Buffer.from('in-addr').toString('hex')));
ok('raw: hex only',K.plNetCmd({...nb,action:'raw send',dfmt:'hex',data:'45000014'}).cmd==='raw.send' && K.plNetCmd({...nb,action:'raw send',data:'xyz'}).error);
// ответ на DNS
const rr=K.plDnsReply({hex:'123481800001000100000000076578616d706c6503636f6d0000010001c00c000100010000012c00045db8d822',server:'8.8.8.8',ms:12.5},{});
ok('dns reply → rec rows',rr.rows.length===1 && rr.rows[0].data==='93.184.216.34' && rr.rows[0].src==='dns' && rr.rows[0].ms===12.5 && rr.rows[0].server==='8.8.8.8',J(rr.rows));
// строки
ok('lines for readouts',K.plLine({src:'gatt',ev:'char',svc:'180d',chr:'2a37',props:['notify']}).includes('2a37') && K.plLine({src:'net',ev:'ping',host:'h',ok:1,ms:12.34,ttl:64,seq:1}).includes('12.3') && K.plLine({src:'speech',final:0,text:'hel'}).startsWith('…') && K.plLine({src:'sys',ev:'screen',on:1}).includes('screen'));

// автоматизация, речь, управление
ok('PL_SYS_ACTIONS has the basics',K.PL_SYS_ACTIONS.includes('speech start') && K.PL_SYS_ACTIONS.includes('ui tap') && K.PL_SYS_ACTIONS.includes('tts speak'));
ok('speech start/stop',K.plSysCmd({action:'speech start',lang:'ru-RU',partial:true}).cmd==='speech.start' && K.plSysCmd({action:'speech start',lang:'ru-RU'}).lang==='ru-RU' && K.plSysCmd({action:'speech stop'}).cmd==='speech.stop');
ok('volume: pct or level, ringer',(c=>c.cmd==='vol.set' && c.pct===50)(K.plSysCmd({action:'vol set',stream:'music',volPct:50})) && K.plSysCmd({action:'vol ringer',ringer:'silent'}).mode==='silent');
ok('tts: needs text, rate/pitch pass through',K.plSysCmd({action:'tts speak',text:''}).error && K.plSysCmd({action:'tts speak',text:'hi',rate:1.5}).rate===1.5);
ok('clipboard',K.plSysCmd({action:'clip set',text:'x'}).cmd==='clip.set' && K.plSysCmd({action:'clip get'}).cmd==='clip.get');
ok('the text input overrides the field',K.plSysCmd({action:'toast',text:'field'},{text:'wire'}).text==='wire');
ok('app launch needs pkg',K.plSysCmd({action:'app launch',pkg:''}).error && K.plSysCmd({action:'app launch',pkg:'com.example'}).cmd==='app.launch');
ok('intent kinds',K.plSysCmd({action:'intent broadcast',intentAction:'android.intent.action.VIEW'}).kind==='broadcast' && K.plSysCmd({action:'intent activity',pkg:'com.x'}).kind==='activity' && K.plSysCmd({action:'intent broadcast'}).error);
ok('ui: tap/swipe use wire coordinates, click/text need text',K.plSysCmd({action:'ui tap',x:1,y:2},{x:10,y:20}).x===10 && K.plSysCmd({action:'ui swipe',x:0,y:0,x2:5,y2:5}).cmd==='ui.swipe' && K.plSysCmd({action:'ui click',text:''}).error && K.plSysCmd({action:'ui back'}).action==='back');
ok('broadcast listen: actions split, comma or newline',(c=>c.cmd==='sys.bcast.listen' && c.actions.join()==='a.B,c.D')(K.plSysCmd({action:'broadcast listen',bcastActions:'a.B, c.D'})) && K.plSysCmd({action:'broadcast listen',bcastActions:''}).error && K.plSysCmd({action:'broadcast stop'}).cmd==='sys.bcast.stop');
ok('shell exec: field or wire, root/timeout pass through, command type stays "cmd"',(c=>c.cmd==='sys.shell.exec' && c.script==='ls -la' && c.root===true && c.timeout===5000)(K.plSysCmd({action:'shell exec',shellCmd:'ls -la',shellRoot:true,shellTimeout:5000})) && K.plSysCmd({action:'shell exec',shellCmd:'a'},{text:'b'}).script==='b' && K.plSysCmd({action:'shell exec',shellCmd:''}).error);

// сервер GATT
{
  const d=K.plSrvDef('180d/2a37 read,notify = 06 00\n# комментарий\n180d/2a38 write,manual\nfff0/fff1 read,secure = "hi"\n');
  ok('srv def: lines of one service are grouped, order kept',d.services.length===2 && d.services[0].uuid==='180d' && d.services[0].chars.length===2 && d.services[1].uuid==='fff0',J(d));
  ok('srv def: props, hex / text value, manual → auto:false, secure',(c=>c.props.join()==='read,notify' && c.hex==='0600')(d.services[0].chars[0]) && d.services[0].chars[1].auto===false && d.services[1].chars[0].text==='hi' && d.services[1].chars[0].secure===true);
  ok('srv def: errors are named',K.plSrvDef('').error && K.plSrvDef('nonsense').error && /bad property/.test(K.plSrvDef('180d/2a37 fly').error) && /bad value/.test(K.plSrvDef('180d/2a37 read = zz').error));
  const sv=K.plGattCmd({action:'srv start',srvDef:'180d/2a37 read = 01'});
  ok('srv start builds gattsrv.start',sv.cmd==='gattsrv.start' && sv.services[0].chars[0].hex==='01' && K.plGattCmd({action:'srv start',srvDef:''}).error);
  const q={svc:'180d',chr:'2a37',wfmt:'hex',data:'0a ff'};
  ok('srv set / notify: UUIDs and data, notify may target one address',K.plGattCmd({...q,action:'srv set'}).cmd==='gattsrv.set' && K.plGattCmd({...q,action:'srv notify'}).hex==='0aff' && K.plGattCmd({...q,action:'srv notify',addr:'aa:bb:cc:dd:ee:ff'}).addr==='AA:BB:CC:DD:EE:FF' && K.plGattCmd({...q,action:'srv set',svc:''}).error && K.plGattCmd({...q,action:'srv set',data:''}).error);
  ok('srv respond: needs req; status without data, else data',K.plGattCmd({action:'srv respond'}).error && K.plGattCmd({action:'srv respond',srvReq:3,srvStatus:3}).status===3 && K.plGattCmd({action:'srv respond',srvReq:3,wfmt:'hex',data:'01'}).hex==='01');
  ok('srv stop / list / disconnect',K.plGattCmd({action:'srv stop'}).cmd==='gattsrv.stop' && K.plGattCmd({action:'srv list'}).cmd==='gattsrv.list' && K.plGattCmd({action:'srv disconnect'}).error && K.plGattCmd({action:'srv disconnect',addr:'aa:bb:cc:dd:ee:ff'}).cmd==='gattsrv.disconnect');
  ok('srv records → lines',K.plLine({src:'gattsrv',ev:'write',addr:'A',chr:'2a38',hex:'01',req:4})==='srv: A wrote 2a38 = 01 (req 4)' && /subscribed/.test(K.plLine({src:'gattsrv',ev:'sub',addr:'A',chr:'2a37',mode:'notify'})));
}

// L2CAP
{
  const b={addr:'aa:bb:cc:dd:ee:ff',psm:128,secure:true,wfmt:'hex',data:'0102'};
  ok('l2cap connect: address and PSM needed',K.plGattCmd({...b,action:'l2cap connect'}).psm===128 && K.plGattCmd({...b,action:'l2cap connect',psm:0}).error && K.plGattCmd({...b,action:'l2cap connect',addr:''}).error);
  ok('l2cap listen / send / close',K.plGattCmd({action:'l2cap listen',secure:false}).secure===false && K.plGattCmd({...b,action:'l2cap send'}).hex==='0102' && K.plGattCmd({...b,action:'l2cap send',data:''}).error && K.plGattCmd({action:'l2cap close'}).cmd==='l2cap.close');
  ok('l2cap records → lines',K.plLine({src:'l2cap',ev:'listen',psm:129})==='l2cap listen  psm 129' && /data A/.test(K.plLine({src:'l2cap',ev:'data',addr:'A',hex:'01'})));
}

// NSD / RTT / Aware
{
  const b={port:8080,nsdType:'_http._tcp',nsdName:'DSP',nsdTxt:'',wfmt:'hex',dfmt:'text',data:''};
  ok('nsd type: normalised, bad refused',K.plNsdType(' _ipp._tcp. ')==='_ipp._tcp' && K.plNsdType('_http._tcp,_x')==='_http._tcp' && K.plNsdType('http')==='' && K.plNsdType('_http._icmp')==='');
  ok('nsd discover / stop / unregister',(c=>c.cmd==='nsd.discover' && c.type==='_http._tcp' && c.resolve===true)(K.plNetCmd({...b,action:'nsd discover'})) && K.plNetCmd({...b,action:'nsd discover',nsdType:'x'}).error && K.plNetCmd({...b,action:'nsd stop'}).cmd==='nsd.stop' && K.plNetCmd({...b,action:'nsd unregister'}).cmd==='nsd.unregister');
  ok('nsd register: name, port, TXT',(c=>c.cmd==='nsd.register' && c.port===8080 && c.txt.path==='/x' && c.txt.v==='1' && c.name==='DSP')(K.plNetCmd({...b,action:'nsd register',nsdTxt:'path=/x; v=1; toolongkeyname=2'})) && K.plNetCmd({...b,action:'nsd register',port:0}).error);
  ok('rtt: list of BSSIDs, rounds clamped, bad one refused',(c=>c.cmd==='wifi.rtt' && c.bssids.join()==='AA:BB:CC:DD:EE:FF,11:22:33:44:55:66' && c.count===50 && c.every===500)(K.plNetCmd({action:'wifi rtt',rttBssids:'aa:bb:cc:dd:ee:ff, 11-22-33-44-55-66',rttCount:99,rttEvery:10})) && K.plNetCmd({action:'wifi rtt',rttBssids:'zz'}).error && !('bssids' in K.plNetCmd({action:'wifi rtt'})));
  ok('rtt: the host input overrides',K.plNetCmd({action:'wifi rtt',rttBssids:'aa:bb:cc:dd:ee:ff'},{host:'11:22:33:44:55:66'}).bssids[0]==='11:22:33:44:55:66');
  const aw={awareService:'dsp.chat',dfmt:'hex',data:''};
  ok('aware publish / subscribe: service name checked, info optional',K.plNetCmd({...aw,action:'aware publish',awareSolicited:true}).solicited===true && K.plNetCmd({...aw,action:'aware subscribe'}).active===true && K.plNetCmd({...aw,action:'aware publish',awareService:'bad name'}).error && K.plNetCmd({...aw,action:'aware publish',data:'0a'}).hex==='0a' && K.plNetCmd({...aw,action:'aware publish',data:'zz'}).error);
  ok('aware send: peer and data needed',K.plNetCmd({awarePeer:2,dfmt:'text',data:'hi',action:'aware send'}).text==='hi' && K.plNetCmd({awarePeer:0,dfmt:'text',data:'hi',action:'aware send'}).error && K.plNetCmd({awarePeer:2,dfmt:'text',data:'',action:'aware send'}).error && K.plNetCmd({action:'aware stop'}).cmd==='aware.stop');
  ok('nsd / rtt / aware records → lines',/nsd resolved Printer _ipp._tcp 10\.0\.0\.5:631/.test(K.plLine({src:'net',ev:'nsd',kind:'resolved',name:'Printer',type:'_ipp._tcp',host:'10.0.0.5',port:631})) &&
    K.plLine({src:'net',ev:'rtt',ok:true,ssid:'Lab',bssid:'A',dist:3.2,std:0.1,good:7,tried:8,rssi:-50})==='rtt Lab 3.20 m ±0.10 (7/8, -50 dBm)' && /failed/.test(K.plLine({src:'net',ev:'rtt',ok:false,bssid:'A',status:1})) &&
    K.plLine({src:'net',ev:'aware',kind:'message',peer:2,text:'hi'})==='aware message peer 2 hi');
}

// монитор-режим
{
  const m={monIface:'wlan0',monChannel:6,monFreq:0,monWidth:'',monHop:'',monDwell:500};
  ok('monitor on: channel, no hop',(c=>c.cmd==='wifi.monitor' && c.on===true && c.iface==='wlan0' && c.channel===6 && !('hop' in c))(K.plNetCmd({...m,action:'monitor on'})));
  ok('monitor on: frequency wins, width passes',(c=>c.freq===5180 && !('channel' in c) && c.width==='80MHz')(K.plNetCmd({...m,action:'monitor on',monFreq:5180,monWidth:'80MHz'})));
  ok('monitor on: hop list with dwell floor',(c=>c.hop.join()==='1,6,11' && c.dwell===250)(K.plNetCmd({...m,action:'monitor on',monHop:'1, 6 11',monDwell:100})) && K.plNetCmd({...m,action:'monitor on',monHop:'1,x'}).error && K.plNetCmd({...m,action:'monitor on',monHop:'999'}).error);
  ok('monitor: bad interface / width refused',K.plNetCmd({...m,action:'monitor on',monIface:'wlan0;reboot'}).error && K.plNetCmd({...m,action:'monitor on',monWidth:'HT20; x'}).error);
  ok('monitor off / channel',(c=>c.cmd==='wifi.monitor' && c.on===false)(K.plNetCmd({...m,action:'monitor off'})) && K.plNetCmd({...m,action:'monitor channel'}).cmd==='wifi.channel' && K.plNetCmd({...m,action:'monitor channel',monChannel:0}).error);
}
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
