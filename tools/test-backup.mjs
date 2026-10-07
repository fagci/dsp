// Ядро резервной копии: node tools/test-backup.mjs
// Значения IndexedDB ↔ JSON без потерь.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,isFinite,Number,Object,Array,String,Boolean,BigInt,Date,Map,Set,Blob,ArrayBuffer,Uint8Array,Int8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,btoa,atob,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/backup-kernels.js'),'utf8')+';this.K={bkEnc,bkDec,bkB64,bkUnB64,BK_GROUPS};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const rt=async v=>K.bkDec(JSON.parse(JSON.stringify(await K.bkEnc(v))));

ok('base64 round trip',K.bkUnB64(K.bkB64(new Uint8Array([0,1,2,250,255]))).join()==='0,1,2,250,255');
const big=new Uint8Array(100000).map((_,i)=>i*7); ok('base64 of a large array',Buffer.from(K.bkUnB64(K.bkB64(big))).equals(Buffer.from(big)));
ok('plain values',JSON.stringify(await rt({a:1,b:'x',c:[1,2,{d:null}],e:true}))===JSON.stringify({a:1,b:'x',c:[1,2,{d:null}],e:true}));
const sp=await rt({n:NaN,i:Infinity,m:-Infinity,u:undefined,z:0});
ok('NaN, Infinity, undefined',Number.isNaN(sp.n) && sp.i===Infinity && sp.m===-Infinity && 'u' in sp && sp.u===undefined && sp.z===0);
const f=await rt(new Float32Array([1.5,-2.25,NaN]));
ok('Float32Array',f instanceof ctx.Float32Array && f[0]===1.5 && f[1]===-2.25 && Number.isNaN(f[2]) && f.length===3);
const sub=new Float32Array([1,2,3,4]).subarray(1,3);
const f2=await rt(sub); ok('typed array view keeps only its own part',f2.length===2 && f2[0]===2 && f2[1]===3);
const ab=await rt(new Uint8Array([9,8,7]).buffer); ok('ArrayBuffer',ab instanceof ArrayBuffer && new Uint8Array(ab).join()==='9,8,7');
const i16=await rt(new Int16Array([-5,300])); ok('Int16Array',i16.constructor===ctx.Int16Array && i16.join()==='-5,300');
const bl=await rt(new Blob([new Uint8Array([1,2,3])],{type:'image/png'})); ok('Blob',bl.type==='image/png' && Buffer.from(await bl.arrayBuffer()).join()==='1,2,3');
const dt=await rt(new Date(1700000000000)); ok('Date',dt instanceof Date && dt.getTime()===1700000000000);
const mp=await rt(new Map([['a',1],[2,new Float32Array([3])]])); ok('Map',mp.get('a')===1 && mp.get(2)[0]===3);
const st=await rt(new Set([1,'x'])); ok('Set',st.has(1) && st.has('x') && st.size===2);
const tricky=await rt({$:'ab',b:'x',deep:{$:'n'}}); ok('an object that uses the service key stays an object',tricky.$==='ab' && tricky.b==='x' && tricky.deep.$==='n',JSON.stringify(tricky));
const rec=await rt({id:7,listName:'geo/places',name:'X',fields:{lat:55.1,lon:82.9,pop:''},created:1});
ok('a list record',rec.fields.lat===55.1 && rec.listName==='geo/places');
const tile=new ArrayBuffer(65536*4); new Float32Array(tile)[100]=1234.5;
ok('a terrain tile (256 KB)',new Float32Array(await rt(tile))[100]===1234.5);
ok('groups: every database appears once',new Set(K.BK_GROUPS.flatMap(g=>g.db||[])).size===K.BK_GROUPS.flatMap(g=>g.db||[]).length && K.BK_GROUPS.some(g=>g.ls) && K.BK_GROUPS.some(g=>g.caches));
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
