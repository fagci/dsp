// Реестр протоколов: функции из записей существуют в ядрах, круг «поля → байты → поля» проходит для каждого адаптера: node tools/test-protoreg.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console,Math,Array,Map,Set,String,Number,Date,Object,JSON,Uint8Array,Uint16Array,Uint32Array,Int32Array,DataView,ArrayBuffer,Float32Array,Float64Array,TextEncoder,TextDecoder,parseInt,isFinite,setTimeout,clearTimeout,Promise,BigInt,Symbol,Error,RegExp,Infinity,NaN});
ctx.window=ctx; ctx.self=ctx; ctx.globalThis=ctx;
// ядра грузим в порядке списка L из index.html (как в браузере); не загрузившиеся без DOM пропускаем
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const L=JSON.parse('['+/L=\[([^\]]*)\]/.exec(html)[1]+']').filter(f=>/^modules\/.*-kernels\.js$/.test(f)&&f!=='modules/protoreg-kernels.js');
const failed=[];
for(const f of L){ try{ vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f}); }catch(e){ failed.push(f+': '+e.message.split('\n')[0]); } }
vm.runInContext(fs.readFileSync(path.join(root,'modules/protoreg-kernels.js'),'utf8'),ctx,{filename:'protoreg-kernels.js'});
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } else console.log('ok  ',m); };
const run=s=>vm.runInContext(s,ctx);
const list=run('protoList()');
ok(list.length>=40,'в реестре '+list.length+' протоколов');
ok(new Set(list.map(d=>d.id)).size===list.length,'id не повторяются');
// каждая названная функция существует
const missing=[];
for(const d of list) for(const fn of [...d.dec,...d.enc,...d.gen]) if(run('typeof '+fn)!=='function') missing.push(d.id+':'+fn);
ok(!missing.length,'названные функции существуют'+(missing.length ? ' — нет: '+missing.join(', ') : ''));
if(failed.length) console.log('note: не загрузились в vm (нет DOM):',failed.join(' | '));
// круг по каждому адаптеру
for(const d of list.filter(d=>d.adapter)){
  const r=run(`protoRoundtrip(${JSON.stringify(d.id)})`);
  ok(r.ok,'круг '+d.id+(r.ok ? ' ('+r.hex.length/2+' байт)' : ' — '+(r.error||r.diff.join('; '))));
}
// порча байта ломает круг (проверка, что сравнение не «всегда ок»)
{
  const r=run(`(()=>{const a=PROTO_REG.get('tftp').adapter, f=a.sample(); const b=a.build(f); b[3]^=0x20; return protoDiff(f,a.parse(b),0).length;})()`);
  ok(r>0,'испорченный пакет даёт расхождение');
}
const s=run('protoSummary()'); console.log('статусы:',JSON.stringify(s.cnt));
ok(s.cnt.pair>=10,'проверенных пар: '+s.cnt.pair);
process.exit(bad?1:0);
