// BLE-сигнатуры (Flipper, метки, очки): node tools/test-blesig.mjs [csv]
import fs from 'node:fs'; import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Map,Set,isFinite});
vm.runInContext(fs.readFileSync(new URL('../modules/blesig-kernels.js',import.meta.url),'utf8')+';this.K={bsClassify,bsNew,bsSee,bsRows,bsPrune};',ctx);
const K=ctx.K, c=r=>K.bsClassify(r);
ok('flipper by name',c({name:'Flipper Kuzya'})?.kind==='flipper');
ok('flipper by service 0x3082 (16-bit and 128-bit form)',c({uuids:['3082']})?.kind==='flipper' && c({uuids:['00003081-0000-1000-8000-00805f9b34fb']})?.kind==='flipper');
ok('apple find my len 25 → AirTag',c({mfr:{'004c':'121900179d'}})?.label==='Apple AirTag / Find My');
ok('apple find my short',c({mfr:{'004c':'12020001'}})?.label==='Apple Find My accessory');
ok('apple nearby info (0x10) is not a tag',c({mfr:{'004c':'1006341d91536d18'}})===null);
ok('ibeacon is not a tag',c({mfr:{'004c':'02152686f39c'}})===null);
ok('smarttag by service fd5a',c({svc:{'fd5a':'01'}})?.label==='Samsung SmartTag');
ok('tile by service',c({uuids:['feed']})?.label==='Tile');
ok('google find hub frame 0x40',c({svc:{'feaa':'40abcd'}})?.kind==='tracker' && c({svc:{'feaa':'00abcd'}})===null);
ok('meta glasses by company id',c({mfr:{'01ab':'00'}})?.kind==='glasses' && c({mfr:{'058e':'00'}})?.kind==='glasses');
ok('snap by company id',c({mfr:{'03c2':'00'}})?.kind==='glasses');
ok('glasses by name',c({name:'Ray-Ban Meta 1A2B'})?.kind==='glasses' && c({name:'Even G1_88_L'})?.kind==='glasses');
ok('earbuds / speakers are not matched',c({name:'realme Buds Air7'})===null && c({name:'JBL Wave Beam 2-GFP'})===null && c({name:'HOCO EQ33'})===null);
ok('junk input',c(null)===null && c({})===null && c({mfr:'x',svc:5,uuids:'a'})===null);
const st=K.bsNew();
const a=K.bsSee(st,{addr:'AA',name:'Flipper X',rssi:-80},100,null), b=K.bsSee(st,{addr:'AA',name:'Flipper X',rssi:-60},110,null);
ok('see: first is fresh, repeat is not, levels kept',a.fresh && !b.fresh && b.dev.n===2 && b.dev.rssi===-60 && b.dev.best===-60);
ok('kinds filter',K.bsSee(st,{addr:'BB',name:'Flipper Y'},100,['tracker'])===null);
K.bsSee(st,{addr:'CC',mfr:{'01ab':'00'},rssi:-50},120,null);
const rows=K.bsRows(st,125);
ok('rows: strongest first, status near',rows[0].id==='CC' && rows[0].status==='near' && rows.length===2);
K.bsPrune(st,500,5); ok('ttl 5 min forgets',st.dev.size===0);
const f=process.argv[2];
if(f){   // на своих данных: распределение по видам
  const t=fs.readFileSync(f,'utf8').replace(/^﻿/,'').split(/\r?\n/), h=t[0].split(',');
  const cnt={}; let n=0;
  for(const l of t.slice(1)){ const m=l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[]; const v=m.map(x=>x.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')); const o={}; h.forEach((k,i)=>o[k]=v[i]);
    if(o.src!=='ble') continue; n++;
    const r={addr:o.addr,name:o.name}; try{ if(o.mfr) r.mfr=JSON.parse(o.mfr); }catch(e){} try{ if(o.svc) r.svc=JSON.parse(o.svc); }catch(e){} try{ if(o.uuids) r.uuids=JSON.parse(o.uuids); }catch(e){}
    const k=c(r); if(k) cnt[k.label]=(cnt[k.label]||0)+1; }
  console.log('ble records',n,JSON.stringify(cnt));
}
if(bad){ console.log(bad,'failed'); process.exit(1); } else console.log('all ok');
