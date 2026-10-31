// Мост Termux и разбор его записей: node tools/test-termux.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const B=await import('./termux/bridge.mjs');
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };

// --- чистые функции моста ---
const got=[]; const feed=B.jsonStream(o=>got.push(o));
feed('{\n "LSM6DSO Accelerometer": {\n  "values": [ 0.1, -0.2, 9.8 ]\n }\n}\n{"a":"}{"'); feed(',"b":[1,{"c":2}]}\n[1,2]');
ok('jsonStream: split chunks, braces inside strings',got.length===3 && got[1].a==='}{' && got[1].b[1].c===2 && got[2].length===2,JSON.stringify(got));
const s=B.sensorRecs({'LSM6DSO Accelerometer':{values:[1,2,3]},'BMI Gyroscope':{values:[4,5,6]},'Gyroscope Uncalibrated':{values:[0,0,0]},
  'Light':{values:[120]},'Magnetometer':{values:[1,2,3]},'Weird':{values:[1]}});
ok('sensorRecs kinds',s.map(r=>r.sensor).join()==='accel,gyro,light,mag',s.map(r=>r.sensor).join());
ok('sensorRecs xyz',s[0].x===1 && s[0].z===3 && s[2].x===120 && s[2].y===undefined);
const g=B.gpsRec({latitude:55.1,longitude:37.2,altitude:150,accuracy:4.5,bearing:90,speed:1.5,provider:'gps',elapsedMs:200});
ok('gpsRec',g.lat===55.1 && g.lon===37.2 && g.id==='me' && g.acc===4.5 && g.speed===1.5 && !('vacc' in g));
ok('gpsRec without fix',B.gpsRec({})===null && B.gpsRec(null)===null);
ok('batteryRec',B.batteryRec({percentage:77,status:'CHARGING',plugged:'PLUGGED_USB',temperature:30.5}).pct===77);
const w=B.wifiRecs([{bssid:'aa:bb',ssid:'Home',rssi:-50,frequency_mhz:2412,timestamp:10000000},{bssid:'cc:dd',ssid:'Old',rssi:-70,frequency_mhz:5180,timestamp:1000000},
  {bssid:'ee:ff',ssid:'Fresh',rssi:-60,frequency_mhz:2437,timestamp:9500000}],{lat:1,lon:2,acc:5});
ok('wifiRecs drops cached old scans, adds position',w.length===2 && w[0].lat===1 && w[0].freq===2412 && w[1].bssid==='ee:ff',JSON.stringify(w));
ok('wifiRecs without fix has no lat',!('lat' in B.wifiRecs([{bssid:'a',rssi:-1}],null)[0]));
const c=B.cellRecs([{type:'lte',registered:true,lte:{cid:5,rsrp:-90},x:{y:1}}]);
ok('cellRecs flatten',c[0].type==='lte' && c[0].cid===5 && c[0].rsrp===-90 && c[0].registered===true,JSON.stringify(c));
ok('originOk',B.originOk(undefined,[]) && B.originOk('http://localhost:8000',[]) && B.originOk('https://fagci.github.io',B.DEFAULT_ORIGINS)
  && !B.originOk('https://evil.example',B.DEFAULT_ORIGINS) && B.originOk('https://x.y',['*']) && !B.originOk('null',[]));
const fr=B.wsFrame('hi'); ok('wsFrame small',fr[0]===0x81 && fr[1]===2 && fr.subarray(2).toString()==='hi');
ok('wsFrame 300 bytes',B.wsFrame('x'.repeat(300)).readUInt16BE(2)===300);

// --- мост с заглушками termux-* в PATH ---
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'termux-'));
const stub=(n,body)=>{ fs.writeFileSync(path.join(dir,n),'#!/bin/sh\n'+body+'\n',{mode:0o755}); };
stub('termux-location','echo \'{"latitude":55.5,"longitude":37.5,"altitude":100,"accuracy":3,"provider":"gps","elapsedMs":10}\'; sleep 30');
stub('termux-battery-status','echo \'{"percentage":88,"status":"DISCHARGING","plugged":"UNPLUGGED","temperature":29.0}\'');
stub('termux-sensor','echo "$@" >&2; while :; do printf \'{\\n "Acc Accelerometer": {\\n  "values": [ 0, 0, 9.81 ]\\n },\\n "Gyro Gyroscope": {"values":[1,2,3]}\\n}\\n\'; sleep 0.1; done');
stub('termux-wifi-scaninfo','echo \'[{"bssid":"aa:bb","ssid":"Home","rssi":-55,"frequency_mhz":2412,"timestamp":5000000}]\'');
// termux-telephony-cellinfo намеренно нет — должна прийти ошибка, а не падение
process.env.PATH=dir+path.delimiter+process.env.PATH;
const br=B.createBridge({port:0,host:'127.0.0.1',token:'k',sources:['gps','battery'],sensorDelay:100,wifiEvery:1});
const addr=await br.listen(), base='ws://127.0.0.1:'+addr.port;
const open=(url,opts)=>new Promise((res,rej)=>{ const ws=new WebSocket(url,opts); ws.msgs=[]; ws.onmessage=e=>ws.msgs.push(JSON.parse(e.data)); ws.onopen=()=>res(ws); ws.onerror=()=>rej(new Error('ws error')); });
const until=async(f,ms=4000)=>{ const t=Date.now(); while(Date.now()-t<ms){ const v=f(); if(v) return v; await new Promise(r=>setTimeout(r,30)); } return null; };
const refused=async url=>{ try{ (await open(url)).close(); return false; }catch(e){ return true; } };
ok('no token → refused',await refused(base));
ok('wrong token → refused',await refused(base+'/?token=x'));
const a=await open(base+'/?token=k');
ok('hello',!!await until(()=>a.msgs.find(m=>m.src==='bridge' && m.level==='hello' && m.ver===1)));
const gp=await until(()=>a.msgs.find(m=>m.src==='gps'));
ok('default sources: gps',gp && gp.lat===55.5 && gp.id==='me',JSON.stringify(gp));
ok('default sources: battery',!!await until(()=>a.msgs.find(m=>m.src==='battery' && m.pct===88)));
ok('no sensors unless asked',!a.msgs.some(m=>m.src==='accel'));
a.send(JSON.stringify({sub:['accel','gyro','wifi','cell']}));
const ac=await until(()=>a.msgs.find(m=>m.src==='sensor' && m.sensor==='accel'));
ok('sub: accelerometer record',ac && ac.z===9.81,JSON.stringify(ac));
ok('sub: gyro record',!!await until(()=>a.msgs.find(m=>m.sensor==='gyro' && m.y===2)));
const gl=a.msgs.length; await new Promise(r=>setTimeout(r,300));
ok('sub replaces defaults (no more gps/battery)',!a.msgs.slice(gl).some(m=>m.src==='gps' || m.src==='battery'));
const wf=await until(()=>a.msgs.find(m=>m.src==='wifi'));
ok('wifi record has the last fix',wf && wf.bssid==='aa:bb' && wf.rssi===-55,JSON.stringify(wf));
ok('missing command is reported, not fatal',!!await until(()=>a.msgs.find(m=>m.src==='bridge' && m.level==='error' && /telephony|cellinfo/.test(m.msg))));
ok('sensor process asked only for accel+gyro',br.running.has('sensor'));
const b2=await open(base+'/?token=k');
b2.send(JSON.stringify({sub:['accel']}));
ok('second client gets only its own sources',!!await until(()=>b2.msgs.find(m=>m.sensor==='accel')) && !b2.msgs.some(m=>m.sensor==='gyro'));
a.close(); b2.close();
ok('sources stop without clients',!!await until(()=>br.running.size===0));
const web=await fetch('http://127.0.0.1:'+addr.port+'/'); ok('http status page',(await web.text()).includes('Termux bridge'));
br.close(); fs.rmSync(dir,{recursive:true,force:true});

// --- разбор записей узлом Termux (общие функции в termux-kernels.js) ---
const kf=path.join(root,'modules/termux-kernels.js');
if(fs.existsSync(kf)){
  const ctx=vm.createContext({atob,Float32Array,Math,Number,String,Object,Array,isFinite,Date,JSON,URL,URLSearchParams});
  vm.runInContext(fs.readFileSync(kf,'utf8')+';this.K={termuxDev,termuxThin,termuxPoint,termuxPcm,termuxEuler,termuxApply,termuxSub,termuxLine,termuxSubMsg,termuxMicLag};',ctx);
  const K=ctx.K, o={};
  K.termuxApply(o,{src:'gps',lat:1,lon:2,alt:3,acc:4,speed:5,bearing:6});
  ok('apply gps',o.lat===1 && o.lon===2 && o.alt===3 && o.acc===4 && o.speed===5 && o.hdg===6);
  K.termuxApply(o,{src:'sensor',sensor:'accel',x:1,y:2,z:3}); K.termuxApply(o,{src:'sensor',sensor:'gyro',x:4,y:5,z:6});
  K.termuxApply(o,{src:'sensor',sensor:'mag',x:7,y:8,z:9}); K.termuxApply(o,{src:'sensor',sensor:'light',x:120}); K.termuxApply(o,{src:'sensor',sensor:'pressure',x:1013});
  K.termuxApply(o,{src:'sensor',sensor:'rotation',x:0,y:0,z:Math.sin(Math.PI/4),w:Math.cos(Math.PI/4)}); K.termuxApply(o,{src:'sensor',sensor:'humidity',x:41}); K.termuxApply(o,{src:'sensor',sensor:'steps',x:1234});
  ok('apply rotation → yaw −90 (CCW 90° about Z), pitch/roll 0',Math.abs(o.yaw+90)<1e-9 && Math.abs(o.pitch)<1e-9 && Math.abs(o.roll)<1e-9 && o.humid===41 && o.steps===1234,JSON.stringify(o));
  const pcm=K.termuxPcm({pcm:Buffer.from(new Int16Array([0,16384,-32768,32767]).buffer).toString('base64')});
  ok('mic pcm decode',pcm.length===4 && pcm[1]===.5 && pcm[2]===-1 && Math.abs(pcm[3]-.99997)<1e-4 && K.termuxPcm({})===null && K.termuxPcm({pcm:'!!'})===null);
  const mm=K.termuxSubMsg({mic:true,micHz:'48000',cell:true,cellEvery:3,pkt:true,iface:' wlan0 ',filter:'tcp port 80',snap:'512',hz:'0'});
  ok('sub message: mic, cell, capture',mm.micHz===48000 && mm.cellEvery===3 && mm.iface==='wlan0' && mm.filter==='tcp port 80' && mm.snap===512 && mm.sub.join()==='cell,mic,pkt',JSON.stringify(mm));
  const ms=K.termuxSubMsg({mic:true,micHz:'96000',micSrc:'unprocessed',micDev:'usb'});
  ok('sub message: microphone source and device',ms.micHz===96000 && ms.micSrc==='unprocessed' && ms.micDev==='usb' && ms.sub.join()==='mic',JSON.stringify(ms))
  const md=K.termuxSubMsg({mic:true,micSrc:'auto',micDev:'auto'});
  ok('sub message: auto source and device are not sent',!('micSrc' in md) && !('micDev' in md))
  ok('sub message: source only with the microphone on',!('micSrc' in K.termuxSubMsg({gps:true,micSrc:'downlink'})))
  ok('sub message: low latency only with the microphone on',K.termuxSubMsg({mic:true,micLow:true}).micLow===true && !('micLow' in K.termuxSubMsg({gps:true,micLow:true})) && !('micLow' in K.termuxSubMsg({mic:true})))
  ok('mic lag: 250 ms normally, micLag in low latency (20…300)',K.termuxMicLag({mic:true})===.25 && K.termuxMicLag({micLow:true})===.06 && K.termuxMicLag({micLow:true,micLag:40})===.04 && K.termuxMicLag({micLow:true,micLag:1})===.02 && K.termuxMicLag({micLow:true,micLag:9999})===.3 && K.termuxMicLag(null)===.25)
  ok('sub message: nothing extra when off',Object.keys(K.termuxSubMsg({gps:true,micHz:'48000',cellEvery:3,iface:'x'})).join()==='sub');
  const oc={}; K.termuxApply(oc,{src:'cell',reg:0,dbm:-120}); K.termuxApply(oc,{src:'cell',reg:1,type:'LTE',dbm:-85,rsrp:-95,rsrq:-9,sinr:12});
  K.termuxApply(oc,{src:'mic',rms:-30}); K.termuxApply(oc,{src:'sensor',sensor:'stationary',x:1}); K.termuxApply(oc,{src:'sensor',sensor:'devorient',x:1});
  ok('apply cell (serving only), mic, motion',oc.cdbm===-85 && oc.crsrp===-95 && oc.csinr===12 && oc.micdb===-30 && oc.still===1 && oc.orient===1,JSON.stringify(oc));
  ok('lines: cell, pkt, mic',K.termuxLine({src:'pkt',iface:'any',ip:'10.0.0.1',sport:1,dip:'1.1.1.1',dport:53,len:60}).includes('10.0.0.1:1 → 1.1.1.1:53') && K.termuxLine({src:'cell',type:'LTE',reg:1,mcc:'250',mnc:'01',cid:5,dbm:-80}).startsWith('cell LTE *') && K.termuxLine({src:'mic',rms:-20}).includes('-20'));
  // --- устройства: ключ, прореживание, точка для карты ---
  ok('dev keys',K.termuxDev({src:'wifi',bssid:'aa:bb',ssid:'Home'}).dev==='wifi:aa:bb' && K.termuxDev({src:'ble',addr:'11:22'}).name==='11:22' && K.termuxDev({src:'bt',addr:'33',name:'Buds'}).dev==='bt:33' && K.termuxDev({src:'gps'})===null && K.termuxDev({src:'wifi'})===null);
  const mb=K.termuxDev({src:'ble',addr:'11:22',mfr:{'004c':'0215','0075':'aa'}});
  ok('ble: company ids as array (rules); none → no field',JSON.stringify(mb.mfrId)==='["004c","0075"]' && !('mfrId' in K.termuxDev({src:'ble',addr:'11:22'})),JSON.stringify(mb));
  const cl=K.termuxDev({src:'cell',type:'LTE',mcc:'250',mnc:'01',cid:777,pci:5,reg:1,rsrp:-95,dbm:-90});
  ok('cell: id and level from RSRP',cl.dev==='cell:LTE:250-01:777' && cl.rssi===-95 && cl.name.endsWith('*'),JSON.stringify(cl));
  ok('cell: neighbour without cid → pci; no ids → null; own rssi kept',K.termuxDev({src:'cell',type:'NR',pci:9,dbm:-100}).dev==='cell:NR::p9' && K.termuxDev({src:'cell',type:'LTE'})===null && !('rssi' in K.termuxDev({src:'cell',type:'LTE',cid:1,rssi:-70,rsrp:-80})));
  const st=new Map(), a={dev:'d',lat:50,lon:30};
  ok('thin: off passes all',K.termuxThin(st,a,0,0,0) && K.termuxThin(st,a,1,0,0) && st.size===0);
  ok('thin: first passes, repeat within 5 s does not, after 5 s does',K.termuxThin(st,a,1000,5,0) && !K.termuxThin(st,a,3000,5,0) && K.termuxThin(st,a,7000,5,0));
  const mv=new Map(); K.termuxThin(mv,a,0,0,10);
  ok('thin: by distance (0.0001° lat ≈ 11 m)',!K.termuxThin(mv,{dev:'d',lat:50.00005,lon:30},1,0,10) && K.termuxThin(mv,{dev:'d',lat:50.0002,lon:30},2,0,10));
  const pt=K.termuxPoint({src:'ble',lat:1,lon:2,rssi:-70,dev:'ble:x',name:'x'},'m1');
  ok('map point',pt.id==='m1' && pt.lat===1 && pt.label==='-70 dBm' && pt.color==='#b07cff' && pt.track===0);
  ok('apply sensors',o.ax===1 && o.az===3 && o.gx===4 && o.gz===6 && o.mx===7 && o.mz===9 && o.light===120 && o.press===1013);
  K.termuxApply(o,{src:'battery',pct:50,status:'CHARGING',temp:31});
  ok('apply battery',o.batt===50 && o.charging===1 && o.temp===31);
  K.termuxApply(o,{src:'battery',pct:49,status:'DISCHARGING'}); ok('discharging → 0',o.charging===0);
  K.termuxApply(o,{src:'power',pct:17,charging:0,saver:1,thermal:2,throttle:2});
  ok('apply power',o.batt===17 && o.charging===0 && o.saver===1 && o.therm===2 && o.thr===2);
  K.termuxApply(o,{src:'power',t:1000,cpu:5000,pct:50,charging:0,wake:1,clients:0,held:'gatt×2'});
  K.termuxApply(o,{src:'power',t:11000,cpu:5500,pct:50,charging:0,wake:0,clients:0,held:''});
  ok('bridge cpu share between two power records',Math.abs(o.cpupct-5)<1e-9 && o.wake===0 && o.nclients===0 && o.held==='');
  K.termuxApply(o,{src:'activity',t:1,state:'walking',cadence:96,locked:1,screen:0,steps:1234});
  ok('apply activity',o.act===2 && o.cadence===96 && o.locked===1 && o.screen===0 && o.steps===1234);
  K.termuxApply(o,{src:'activity',hist:1,t:2,state:'still',locked:1,screen:0}); ok('history record does not change the live state',o.act===2);
  K.termuxApply(o,{src:'sensor',sensor:'pickup',x:1}); K.termuxApply(o,{src:'sensor',sensor:'pickup',x:1}); K.termuxApply(o,{src:'sensor',sensor:'offbody',x:0});
  ok('gesture counters, offbody',o.pick===2 && o.offb===0);
  ok('sub activity / gestures',K.termuxSub({activity:true,pickup:true,tilt:true}).sort().join()==='activity,pickup,tilt');
  ok('line activity',/activity walking.*locked.*96 steps/.test(K.termuxLine({src:'activity',state:'walking',locked:1,cadence:96})));
  K.termuxApply(o,{src:'ext',name:'home',value:1}); K.termuxApply(o,{src:'ext',name:'note',text:'x'});
  ok('apply ext: number kept, text ignored',o.extv===1);
  ok('line power / ext',/thermal 2/.test(K.termuxLine({src:'power',pct:17,thermal:2,throttle:2})) && /ext home 1/.test(K.termuxLine({src:'ext',name:'home',value:1})));
  ok('sub power / ext',K.termuxSub({power:true,ext:true,gps:false}).join()==='power,ext');
  ok('apply ignores junk',(K.termuxApply(o,null),K.termuxApply(o,{src:'x'}),true));
  ok('sub from params',K.termuxSub({gps:true,battery:false,accel:true,gyro:true,wifi:true}).join()==='gps,accel,gyro,wifi');
  const sm=K.termuxSubMsg({gps:true,accel:true,hz:'200'});
  ok('sub message carries the sensor rate',sm.sub.join()==='gps,accel' && sm.hz===200,JSON.stringify(sm));
  ok('sub message without rate has no hz (Termux bridge)',!('hz' in K.termuxSubMsg({gps:true,hz:'0'})) && !('hz' in K.termuxSubMsg({gps:true})));
  K.termuxApply(o,{src:'gnss',kind:'sat',con:'GPS',svid:5,cn0:38});
  ok('gnss sat record does not touch the summary',o.nsat===undefined);
  K.termuxApply(o,{src:'gnss',kind:'fix',n:24,used:11,cn0:34.5});
  ok('gnss summary → nsat, nused, cn0',o.nsat===24 && o.nused===11 && o.cn0===34.5);
  ok('sub: bluetooth, gnss, nmea',K.termuxSub({ble:true,bt:true,gnss:true,gnssraw:true,nmea:true,gps:false}).join()==='ble,bt,gnss,gnssraw,nmea');
  const sw=K.termuxSubMsg({wifi:true,wifiEvery:'20'});
  ok('wifi scan period goes with the subscription',sw.wifiEvery===20 && !('wifiEvery' in K.termuxSubMsg({wifi:false,wifiEvery:20})),JSON.stringify(sw));
  ok('line: ble, bt, gnss, nmea, wifi channel',K.termuxLine({src:'ble',addr:'AA',rssi:-60,name:'Tag'}).includes('Tag') && K.termuxLine({src:'bt',addr:'BB',major:'PHONE'}).includes('PHONE') &&
    K.termuxLine({src:'gnss',kind:'sat',con:'GLONASS',svid:3,cn0:30,el:40,used:1}).includes('GLONASS') && K.termuxLine({src:'gnss',kind:'fix',n:20,used:9,cn0:33}).includes('9/20') &&
    K.termuxLine({src:'nmea',line:'$GPGGA,1'})==='$GPGGA,1' && K.termuxLine({src:'wifi',bssid:'aa',rssi:-5,ch:6,ssid:'H'}).includes('ch 6'));
  ok('line',K.termuxLine({src:'wifi',bssid:'aa',ssid:'H',rssi:-5}).includes('aa'));
}
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
