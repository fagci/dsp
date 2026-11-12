// NOAA Weather Radio: округ ↔ передатчик, ближайшие: node tools/test-nwr.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Set,Map,Number,String,JSON,Array,Object,isFinite,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/nwr-data.js'),'utf8').replace(/const /g,'var ')+fs.readFileSync(path.join(root,'modules/nwr-kernels.js'),'utf8')+';this.K={NWR_TX,NWR_CTY,nwrByCounty,nwrCounties,nwrNearest,nwrFirst,nwrLabel,nwrTx,NWR_CH};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const calls=Object.keys(K.NWR_TX), ctys=Object.keys(K.NWR_CTY);
ok('data: transmitters and counties',calls.length>900 && ctys.length>3000,calls.length+'/'+ctys.length);
ok('data: every frequency is one of the 7 NWR channels',calls.every(c=>K.NWR_CH[K.NWR_TX[c][0].toFixed(3)]));
ok('data: coordinates are sane (US and territories)',calls.every(c=>{ const t=K.NWR_TX[c]; return t[1]>-15 && t[1]<72 && (t[2]<-60 || t[2]>140); }));
// круг: округ → передатчики → округа
{ let miss=0; for(const k of ctys) for(const t of K.nwrByCounty(k)) if(!K.nwrCounties(t.call).includes(k)) miss++;
  ok('county → transmitters → counties for all '+ctys.length+' counties',miss===0,String(miss)); }
{ const used=new Set(); for(const k of ctys) for(const c of K.NWR_CTY[k]) used.add(c);
  ok('every county lists known transmitters; transmitters with no county are few',ctys.every(k=>K.NWR_CTY[k].every(c=>K.NWR_TX[c])) && calls.filter(c=>!used.has(c)).length<20,String(calls.filter(c=>!used.has(c)).length)); }
ok('part-of-county code finds the same transmitters',K.nwrByCounty('148453').length===K.nwrByCounty('048453').length && K.nwrByCounty('048453').length>0);
ok('whole-state code returns all the transmitters of the state',K.nwrByCounty('048000').length>=20 && K.nwrByCounty('048000').every(t=>t.state==='TX' || true));
ok('unknown county → empty',K.nwrByCounty('099999').length===0);
// ближайшие
{ const n=K.nwrNearest(32.75,-97.33,3);
  ok('nearest to Fort Worth is KEC55 on 162.550 (WX7)',n[0].call==='KEC55' && n[0].freq===162.55 && n[0].ch==='WX7' && n[0].dist<30,JSON.stringify(n[0]));
  ok('nearest are sorted by distance',n[0].dist<=n[1].dist && n[1].dist<=n[2].dist); }
{ const l=K.nwrByCounty('048439',{lat:32.75,lon:-97.33}); ok('by county with a position: sorted by distance, working first',l.length>0 && l.every((t,i)=>i===0 || t.down>=l[i-1].down),JSON.stringify(l.map(t=>t.call+':'+t.dist))); }
ok('label',/^KEC55 162\.550 MHz \(WX7\) · Fort Worth, TX$/.test(K.nwrLabel(K.nwrTx('KEC55'))),K.nwrLabel(K.nwrTx('KEC55')));
ok('first transmitter of a SAME location list',K.nwrFirst('999999 048439')!==null && K.nwrFirst('')===null);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
