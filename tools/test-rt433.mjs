// Проверка декодеров rtl_433 на записях из github.com/merbanan/rtl_433_tests:
//   node tools/test-rt433.mjs <путь к rtl_433_tests/tests> [фильтр по пути] [-v] [-m модель]
// Каждая запись (.cu8 / .cs8 / .cs16 + .json с ожидаемым выводом rtl_433) пропускается через детектор импульсов и
// декодеры; событие засчитано, если все поля ожидаемой записи совпали (время, уровни и служебные поля не сравниваются).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const flag=f=>{ const i=args.indexOf(f); if(i<0) return null; return args.splice(i,1)[0]; };
const verbose=!!flag('-v');
let onlyModel=null; { const i=args.indexOf('-m'); if(i>=0){ onlyModel=args[i+1]; args.splice(i,2); } }
const dir=args[0], filter=args[1]||'';
if(!dir){ console.error('usage: node tools/test-rt433.mjs <rtl_433_tests/tests> [filter] [-v] [-m model]'); process.exit(2); }

const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,BigInt,RegExp,Error,TextDecoder,WebAssembly});
vm.runInContext(fs.readFileSync(path.join(root,'modules/rt433-kernels.js'),'utf8')+';globalThis.Rt433=Rt433;',ctx,{filename:'rt433-kernels.js'});
const rt=new ctx.Rt433(new WebAssembly.Module(fs.readFileSync(path.join(root,'vendor/rtl433.wasm'))));

function walk(d,out=[]){
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const p=path.join(d,e.name);
    if(e.isDirectory()) walk(p,out);
    else if(/\.(cu8|cs8|cs16)$/.test(e.name)) out.push(p);
  }
  return out;
}
function dirFile(p,name){
  for(let d=path.dirname(p);d.length>=dir.length;d=path.dirname(d)){
    const f=path.join(d,name);
    if(fs.existsSync(f)) return fs.readFileSync(f,'utf8').trim();
  }
  return null;
}
function loadIq(p){
  const b=fs.readFileSync(p), ext=path.extname(p).slice(1), n=ext==='cs16' ? b.length>>2 : b.length>>1;
  const re=new Float32Array(n), im=new Float32Array(n);
  if(ext==='cu8') for(let i=0;i<n;i++){ re[i]=b[2*i]-128; im[i]=b[2*i+1]-128; }
  else if(ext==='cs8') for(let i=0;i<n;i++){ re[i]=b.readInt8(2*i); im[i]=b.readInt8(2*i+1); }
  else for(let i=0;i<n;i++){ re[i]=b.readInt16LE(4*i)/256; im[i]=b.readInt16LE(4*i+2)/256; }
  return {re,im,n};
}
const IGNORE=new Set(['time','protocol','mod','freq','freq1','freq2','rssi','snr','noise','codes','rows','num_rows','bits','count','len']);
const near=(a,b)=>typeof a==='number' && typeof b==='number' ? Math.abs(a-b)<=1e-3*Math.max(1,Math.abs(a),Math.abs(b))+1e-6 : a===b;
function same(exp,got){
  for(const k in exp){
    if(IGNORE.has(k)) continue;
    if(!(k in got) || !near(exp[k],got[k])) return false;
  }
  return true;
}

const devList=rt.devices();
let lastKey=null;
const files=walk(dir).filter(f=>f.includes(filter)).sort();
const stat=new Map();      // модель → {exp, ok, files, fail}
let nFiles=0, nOkFiles=0, nExp=0, nOk=0;
const t0=Date.now();
for(const f of files){
  const jf=f.replace(/\.[^.]+$/,'.json');
  if(!fs.existsSync(jf)) continue;
  if(dirFile(f,'ignore')!==null) continue;
  const expected=fs.readFileSync(jf,'utf8').split(/\r?\n/).filter(l=>l.trim().startsWith('{')).map(l=>{ try{ return JSON.parse(l); }catch(e){ return null; } }).filter(Boolean);
  if(!expected.length) continue;
  if(onlyModel && !expected.some(e=>e.model===onlyModel)) continue;
  let sr=250000, freq=433.92e6;
  const m=/_(\d+(?:\.\d+)?)M_(\d+(?:\.\d+)?)k/.exec(path.basename(f));
  if(m){ freq=+m[1]*1e6; sr=Math.round(+m[2]*1e3); }
  else { const s=dirFile(f,'samplerate'); if(s && +s>0) sr=+s; }
  const pf=dirFile(f,'protocol'), want=pf && /^\d+/.test(pf) ? new Set(pf.split(/[\s,]+/).map(Number)) : null;
  if(!pf || want){                                    // файл protocol: как rtl_433 -R N — только эти устройства
    const key=want ? [...want].join(',') : '';
    if(key!==lastKey){ lastKey=key; for(const d of devList) rt.setDevice(d.i, want ? want.has(d.proto) : !d.disabled); }
  } else continue;                                    // flex-конфиг (.conf) — не поддерживается
  const iq=loadIq(f);
  const ch=rt.chan(sr,freq,false);
  const B=16384, got=[];
  for(let i=0;i<iq.n;i+=B){
    const e=Math.min(iq.n,i+B), k=e-i, u=new Uint8Array(2*k);
    for(let j=0;j<k;j++){ u[2*j]=Math.max(0,Math.min(255,iq.re[i+j]+128)); u[2*j+1]=Math.max(0,Math.min(255,iq.im[i+j]+128)); }
    rt.feed8(ch,u,k);
  }
  rt.flush(ch); rt.free(ch);
  for(const g of rt.take()) got.push(g);
  nFiles++;
  let okAll=true;
  for(const e of expected){
    const st=stat.get(e.model)||{exp:0,ok:0,files:new Set(),fail:new Set()}; stat.set(e.model,st);
    st.exp++; nExp++; st.files.add(f);
    const hit=got.some(g=>same(e,g));
    if(hit){ st.ok++; nOk++; } else { okAll=false; st.fail.add(f); if(verbose) console.log('MISS',path.relative(dir,f),JSON.stringify(e),'\n   got:',got.map(g=>JSON.stringify(g)).join(' | ')||'-'); }
  }
  if(okAll) nOkFiles++;
}
const rows=[...stat.entries()].sort((a,b)=>b[1].exp-a[1].exp);
for(const [model,s] of rows) console.log(String(s.ok).padStart(4)+'/'+String(s.exp).padEnd(4)+' '+(s.ok===s.exp ? 'ok  ' : s.ok ? 'part' : 'FAIL')+' '+model);
console.log(`\nfiles ${nOkFiles}/${nFiles} fully matched; events ${nOk}/${nExp}; devices ${rt.nDev}; ${((Date.now()-t0)/1000).toFixed(1)} s`);
