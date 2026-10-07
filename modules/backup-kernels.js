"use strict";
/* ============================ Ядро резервной копии ============================
   Значения из IndexedDB (структурное клонирование: ArrayBuffer, типизированные массивы, Blob, Map, Set, Date, NaN…) ↔ JSON.
   Без DOM — проверяется tools/test-backup.mjs. */

const BK_TA={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array};
function bkB64(u8){
  let s=''; for(let i=0;i<u8.length;i+=0x8000) s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));
  return btoa(s);
}
function bkUnB64(b){ const s=atob(b), u=new Uint8Array(s.length); for(let i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u; }
const bkBytes=a=>new Uint8Array(a.buffer,a.byteOffset,a.byteLength);

// значение → JSON-совместимое; служебные объекты помечены ключом "$"
async function bkEnc(v){
  if(v===null || typeof v==='string' || typeof v==='boolean') return v;
  if(v===undefined) return {$:'u'};
  if(typeof v==='number') return isFinite(v) ? v : {$:'n',v:String(v)};
  if(typeof v==='bigint') return {$:'bi',v:String(v)};
  if(typeof v!=='object') return null;
  if(Array.isArray(v)){ const o=new Array(v.length); for(let i=0;i<v.length;i++) o[i]=await bkEnc(v[i]); return o; }
  if(v instanceof ArrayBuffer) return {$:'ab',b:bkB64(new Uint8Array(v))};
  if(ArrayBuffer.isView(v)){
    const t=v.constructor.name;
    if(!(t in BK_TA)) return {$:'ab',b:bkB64(bkBytes(v))};
    return {$:'ta',t,b:bkB64(bkBytes(v))};
  }
  if(typeof Blob!=='undefined' && v instanceof Blob) return {$:'blob',type:v.type,b:bkB64(new Uint8Array(await v.arrayBuffer()))};
  if(v instanceof Date) return {$:'d',v:v.getTime()};
  if(v instanceof Map){ const e=[]; for(const [k,x] of v) e.push([await bkEnc(k),await bkEnc(x)]); return {$:'map',e}; }
  if(v instanceof Set){ const e=[]; for(const x of v) e.push(await bkEnc(x)); return {$:'set',e}; }
  const o={};
  for(const k of Object.keys(v)) o[k]=await bkEnc(v[k]);
  return '$' in o ? {$:'o',o} : o;
}
function bkDec(v){
  if(v===null || typeof v!=='object') return v;
  if(Array.isArray(v)) return v.map(bkDec);
  switch(v.$){
    case undefined: { const o={}; for(const k of Object.keys(v)) o[k]=bkDec(v[k]); return o; }
    case 'u': return undefined;
    case 'n': return Number(v.v);
    case 'bi': return BigInt(v.v);
    case 'ab': { const u=bkUnB64(v.b); return u.buffer; }
    case 'ta': { const u=bkUnB64(v.b); return new BK_TA[v.t](u.buffer); }
    case 'blob': return new Blob([bkUnB64(v.b)],{type:v.type});
    case 'd': return new Date(v.v);
    case 'map': return new Map(v.e.map(([k,x])=>[bkDec(k),bkDec(x)]));
    case 'set': return new Set(v.e.map(bkDec));
    case 'o': { const o={}; for(const k of Object.keys(v.o)) o[k]=bkDec(v.o[k]); return o; }
  }
  return null;
}

// какие базы и что в них: группы выбора в диалоге экспорта
const BK_GROUPS=[
  {id:'settings', label:'Patches and settings (browser storage)', ls:true},
  {id:'tables',   label:'Tables (lists: your points, geo/airfields, runways, places, band plans…)', db:['dsp-lists']},
  {id:'geo',      label:'Terrain tiles, airport database and map caches (slow to download again)', db:['dsp-geo']},
  {id:'media',    label:'Samples, tracker sessions, spectrum archive (can be large)', db:['dsp-samples','dsp-tracker','dsp-spectra']},
  {id:'tiles',    label:'Map tiles cache (Cache API)', caches:['dsp-tiles']},
];
