// My Position, источник «wire»: координаты с проводов. node tools/test-geome-wire.mjs
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const defs={}; const noop=()=>{};
const ctx=vm.createContext(new Proxy({Math,Array,Number,String,JSON,Date,isFinite,parseFloat,Object,Set,Map,RegExp,def:d=>{ defs[d.id]=d; },OfflineData:{fileItem:noop,item:noop},document:{addEventListener:noop},window:{addEventListener:noop},matchMedia:()=>({matches:false}),setMod:(n,k,v)=>{ n.p[k]=v; },console},
  {get:(t,k)=>k in t?t[k]:(k==='navigator'?{}:noop), has:()=>true, set:(t,k,v)=>{ t[k]=v; return true; }}));
for(const f of ['modules/geofix-kernels.js','modules/geo.js']) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const d=defs.geoMe; let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
ok('входы lat/lon есть',['lat','lon'].every(k=>d.ins.some(i=>i.n===k)));
ok('источник wire в списке',d.params[0].opts.includes('wire'));
const n={p:{src:'wire',id:'me',avg:0,maxacc:0}}; d.init(n);
let r=d.process(n,{});
ok('без проводов — нет координат',r.lat===undefined && r.rec===null && /waiting/.test(n.msg));
r=d.process(n,{lat:55.75,lon:37.6,acc:12,heading:90});
ok('lat/lon с проводов проходят на выход',r.lat===55.75 && r.lon===37.6 && r.acc===12 && r.heading===90);
ok('запись rec одна на новую точку',r.rec && r.rec[0].lat===55.75 && r.rec[0].acc===12 && r.rec[0].heading===90);
ok('GeoMe обновлён (его читают Satellites, ADS-B…)',vm.runInContext('GeoMe.lat+","+GeoMe.lon',ctx)==='55.75,37.6');
r=d.process(n,{lat:55.75,lon:37.6,acc:12,heading:90}); ok('та же точка — без новой записи',r.rec===null);
r=d.process(n,{lat:55.76,lon:37.6}); ok('новая точка — новая запись',r.rec && r.rec[0].lat===55.76 && !('acc' in r.rec[0]));
r=d.process(n,{lat:95,lon:0}); ok('широта вне диапазона отвергается',r.lat===undefined);
if(bad){ console.log(bad+' FAIL'); process.exit(1); } console.log('all ok');
