// Ядро слоя «съёмка» карты: node tools/test-geosurvey.mjs
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,Number,isFinite,String,Set,Map});
vm.runInContext(fs.readFileSync(path.join(root,'modules/geosurvey-kernels.js'),'utf8')+';this.K={svIngest,svMatch,svList,svColor,svSpread};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const rows=[
 {t:'3000',src:'wifi',dev:'wifi:aa',ssid:'Home',ch:'6',lat:'50.1',lon:'85.0003',acc:'10',rssi:'-60'},
 {t:'1000',src:'wifi',dev:'wifi:aa',ssid:'Home',ch:'6',lat:'50.1',lon:'85.0',acc:'10',rssi:'-80'},
 {t:'2000',src:'ble',dev:'ble:bb',name:'Tag',lat:'50.1',lon:'85.0',acc:'80',rssi:'-70'},
 {t:'4000',src:'cell',dev:'cell:LTE::1',lat:'',lon:'',rssi:'-90'},
 {t:'5000',src:'wifi',dev:'wifi:cc',lat:'50.2',lon:'85.2',acc:'5'}];
const S=K.svIngest(rows);
ok('devices: 2 Wi-Fi/BLE; cell without a position and the row without a level are dropped',S.devs.size===2 && S.tech.wifi===1 && S.tech.ble===1 && S.bad===2,JSON.stringify([S.devs.size,S.bad]));
ok('rows are ordered by time: the first Wi-Fi point is the weaker one',S.devs.get('wifi:aa').pts[0].rssi===-80);
ok('best level is remembered',S.devs.get('wifi:aa').best===-60 && S.devs.get('wifi:aa').bestAt===1);
ok('name comes from ssid / name',S.devs.get('wifi:aa').name==='Home' && S.devs.get('ble:bb').name==='Tag' && S.devs.get('wifi:aa').ch===6);
ok('track: only fixes with acc ≤ 30 m, no repeats in a row (the 80 m BLE fix and the 11 km jump are skipped)',S.track.length===2 && S.track[0].lon===85.0 && S.track[1].lon===85.0003,JSON.stringify(S.track));
ok('filter by technology',K.svList(S,{tech:new Set(['ble'])}).length===1);
ok('filter by text (name, mac, channel)',K.svList(S,{q:'home'}).length===1 && K.svList(S,{q:'bb'}).length===1 && K.svList(S,{q:'ch6'}).length===1 && K.svList(S,{q:'zzz'}).length===0);
ok('filter: min points / min level',K.svList(S,{minPts:2}).length===1 && K.svList(S,{minRssi:-65}).length===1);
ok('sort by level: strongest first',K.svList(S,{},'best')[0].dev==='wifi:aa');
ok('colour: weak is blue, strong is red',/hsl\(240/.test(K.svColor(-100)) && /hsl\(0,/.test(K.svColor(-40)));
ok('spread: two points 0.0003° apart in longitude is about 21 m',Math.abs(K.svSpread(S.devs.get('wifi:aa'))-21.4)<2,K.svSpread(S.devs.get('wifi:aa')));
const J=K.svIngest([{t:'1000',dev:'a',lat:'50',lon:'85',acc:'5',rssi:'-50'},{t:'2000',dev:'a',lat:'50.0001',lon:'85',acc:'5',rssi:'-50'},{t:'3000',dev:'a',lat:'50.02',lon:'85',acc:'5',rssi:'-50'},{t:'4000',dev:'a',lat:'50.0002',lon:'85',acc:'5',rssi:'-50'}]);
ok('GPS jump (2 km in 1 s) is dropped from the track, the walk goes on; the marks are kept',J.track.length===3 && J.track[2].lat===50.0002 && J.devs.get('a').pts.length===4,JSON.stringify(J.track));
console.log(bad?bad+' failed':'all ok'); process.exit(bad?1:0);
