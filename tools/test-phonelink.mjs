// Команды Bluetooth / сети приложения DSP: node tools/test-phonelink.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,Uint8Array,DataView,TextDecoder,TextEncoder,parseInt,isFinite,Error,Infinity});
const load=f=>vm.runInContext(fs.readFileSync(new URL('../modules/'+f,import.meta.url),'utf8'),ctx);
load('ble-kernels.js'); load('dnsq-kernels.js'); load('phonelink-kernels.js');
vm.runInContext('this.K={plGattCmd,plNetCmd,plScanOpts,plDecode,plLine,plAdvCmd,plDnsReply,dnsParse}',ctx);
const K=ctx.K, J=o=>JSON.stringify(o);

// скан
ok('scan options: defaults send nothing',K.plScanOpts({})===null && K.plScanOpts({bleMode:'low_latency',blePhy:'all',bleMatch:'default'})===null);
const so=K.plScanOpts({bleMode:'low_power',bleLegacy:'extended',blePhy:'coded',bleDelay:2000,bleName:' Mi ',bleAddr:'aa:bb:cc:dd:ee:ff',bleUuid:'180d',bleMfr:'0x004C'});
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
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
