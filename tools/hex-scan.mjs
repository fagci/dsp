// HEX Field Finder из командной строки: node tools/hex-scan.mjs файл.csv [--col hex|raw|data] [--group-by kind,rate] [--min 12] [--ref col [--unit °C]] [--schema]
// CSV с заголовком (как у Table / Rec Log): столбец с hex, по желанию t — время приёма (мс).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), file=args.find(a=>!a.startsWith('--') && fs.existsSync(a));
const opt=(k,d)=>{ const i=args.indexOf('--'+k); return i>=0 ? args[i+1] : d; };
if(!file){ console.log('usage: node tools/hex-scan.mjs file.csv [--col hex|raw|data] [--group-by kind,rate] [--min 12] [--ref col [--unit °C]] [--schema]'); process.exit(1); }
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,TextEncoder,TextDecoder,Array,Map,Set,Error,String,Number,BigInt,Object,Date,JSON,isNaN,isFinite,parseInt,Float64Array});
for(const f of ['hex-kernels.js','hex-scan-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
vm.runInContext('this.S={hexScan,hexScanSchema}',ctx);
const S=ctx.S;
// минимальный CSV: кавычки, запятые внутри
function parseCsv(t){
  const rows=[]; let row=[], cur='', q=false;
  for(let i=0;i<t.length;i++){ const c=t[i];
    if(q){ if(c==='"'){ if(t[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=c; }
    else if(c==='"') q=true; else if(c===',') { row.push(cur); cur=''; }
    else if(c==='\n'){ row.push(cur.replace(/\r$/,'')); rows.push(row); row=[]; cur=''; }
    else cur+=c; }
  if(cur||row.length){ row.push(cur); rows.push(row); }
  return rows;
}
const tbl=parseCsv(fs.readFileSync(file,'utf8').replace(/^﻿/,'')), head=tbl[0], recs=tbl.slice(1).filter(r=>r.length===head.length).map(r=>Object.fromEntries(head.map((h,i)=>[h,r[i]])));
const refcol=opt('ref'), cols=(opt('col','hex,raw,data')).split(','), by=(opt('group-by','kind,rate')).split(',').filter(Boolean), minN=+opt('min',12);
const buckets=new Map();
for(const r of recs){
  const col=cols.find(c=>r[c] && /^[0-9a-fA-F]+$/.test(r[c]) && r[c].length%2===0); if(!col) continue;
  const key=[col,...by.map(k=>r[k])].join(' | ');
  if(!buckets.has(key)) buckets.set(key,[]);
  buckets.get(key).push({d:Uint8Array.from(r[col].match(/../g).map(h=>parseInt(h,16))),t:r.t!==undefined && r.t!=='' ? +r.t : undefined,ref:refcol && r[refcol]!==undefined && r[refcol]!=='' && isFinite(+r[refcol]) ? +r[refcol] : undefined});
}
console.log(file+': '+recs.length+' records, '+buckets.size+' kinds with hex');
for(const [key,pk] of buckets){
  const res=S.hexScan(pk,{minN,refName:refcol||'value',refUnit:opt('unit','')});
  if(!res.length){ console.log('\n['+key+'] '+pk.length+' packets — fewer than '+minN+' of one length, skipped'); continue; }
  for(const g of res){
    console.log('\n['+key+'] length '+g.len+' B · '+g.n+' packets · '+g.verdict+(g.randomShare ? ' (random bytes: '+Math.round(100*g.randomShare)+'%)' : ''));
    for(const c of g.candidates.filter(c=>c.kind!=='random' || g.candidates.length<4).slice(0,10))
      console.log('  '+String(c.off).padStart(3)+'+'+c.w+'  '+c.kind.padEnd(8)+c.score.toFixed(2)+'  '+c.label+(c.example!==undefined ? '  e.g. '+c.example : ''));
    if(args.includes('--schema')) console.log(JSON.stringify(S.hexScanSchema(g)));
  }
}
