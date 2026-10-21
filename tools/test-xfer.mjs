// Передача файлов по любому каналу: node tools/test-xfer.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,JSON,Map,Set,Promise,Blob,ArrayBuffer,Uint8Array,String,Array,Object,console,Infinity,setTimeout});
vm.runInContext(fs.readFileSync(path.join(root,'modules/xfer-kernels.js'),'utf8')+';this.K={XferPort,XF_CHUNK};',ctx);
const {XferPort,XF_CHUNK}=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

// два порта через память; send завершается, когда сообщение доставлено (как с обратным давлением реального канала)
function pair(oa={},ob={},log=null){
  let a,b;
  const wire=(to)=>x=>{ log?.push(typeof x==='string' ? x : x.byteLength); return new Promise(r=>setTimeout(()=>{ to().onMessage(x); r(); },1)); };
  a=new XferPort(wire(()=>b),oa); b=new XferPort(wire(()=>a),ob);
  return [a,b];
}
const wait=async(f,ms=3000)=>{ const t=Date.now(); while(!f() && Date.now()-t<ms) await new Promise(r=>setTimeout(r,5)); return f(); };
const bytes=n=>{ const u=new Uint8Array(n); for(let i=0;i<n;i++) u[i]=(i*31+7)&255; return u; };
const same=async(blob,u)=>{ const x=new Uint8Array(await blob.arrayBuffer()); return x.length===u.length && x.every((v,i)=>v===u[i]); };

// файл с несколькими кусками доходит целиком, с типом и именем
{
  const got=[]; const [a,b]=pair({},{onFile:(m,bl)=>got.push([m,bl])}); const u=bytes(XF_CHUNK*5+123);
  a.enqueue(new Blob([u]),'clip.mp4','video/mp4',{c:'video'});
  ok('file arrives',await wait(()=>got.length===1));
  ok('content is identical',await same(got[0][1],u));
  ok('name, type, size and extra header fields arrive',got[0][0].name==='clip.mp4' && got[0][0].mime==='video/mp4' && got[0][0].size===u.length && got[0][0].c==='video' && got[0][1].type==='video/mp4');
  ok('sender counted it',a.stat.sent===1 && b.stat.got===1);
}
// пустой файл и несколько подряд, порядок сохраняется
{
  const got=[]; const [a,b]=pair({},{onFile:(m,bl)=>got.push(m.name)});
  a.enqueue(new Blob([]),'empty.bin'); a.enqueue(new Blob([bytes(10)]),'a.bin'); a.enqueue(new Blob([bytes(XF_CHUNK)]),'b.bin');
  ok('several files in order, empty one too',await wait(()=>got.length===3) && got.join()==='empty.bin,a.bin,b.bin',got.join());
}
// слишком большой — отклоняется до передачи содержимого
{
  const sizes=[], got=[]; const [a,b]=pair({},{maxBytes:1000,onFile:(m)=>got.push(m)},sizes); const x=bytes(XF_CHUNK*4);
  a.enqueue(new Blob([x]),'big.bin'); a.enqueue(new Blob([bytes(100)]),'small.bin');
  ok('too large is refused, the next one still arrives',await wait(()=>got.length===1) && got[0].name==='small.bin' && b.stat.refused===1);
  ok('refused file does not send all its chunks',sizes.filter(s=>s===XF_CHUNK).length<4,String(sizes.filter(s=>s===XF_CHUNK).length));
}
// accept отклоняет по заголовку
{
  const got=[]; const [a,b]=pair({},{accept:m=>m.c==='mine',onFile:m=>got.push(m.name)});
  a.enqueue(new Blob([bytes(50)]),'x.bin',null,{c:'other'}); a.enqueue(new Blob([bytes(50)]),'y.bin',null,{c:'mine'});
  ok('accept() filters by the header',await wait(()=>got.length===1) && got[0]==='y.bin');
}
// в обе стороны одновременно
{
  const ga=[], gb=[]; const [a,b]=pair({onFile:m=>ga.push(m.name)},{onFile:m=>gb.push(m.name)});
  a.enqueue(new Blob([bytes(XF_CHUNK*3)]),'to-b'); b.enqueue(new Blob([bytes(XF_CHUNK*3)]),'to-a');
  ok('both directions at once',await wait(()=>ga.length===1 && gb.length===1) && ga[0]==='to-a' && gb[0]==='to-b');
}
// обрыв: close() останавливает отправку и приём
{
  const got=[]; const [a,b]=pair({},{onFile:m=>got.push(m)}); a.enqueue(new Blob([bytes(XF_CHUNK*200)]),'long.bin');
  await new Promise(r=>setTimeout(r,20)); a.close(); b.close();
  await new Promise(r=>setTimeout(r,50));
  ok('close stops the transfer',got.length===0 && !a.enqueue(new Blob([]),'z'));
}
// мусор на входе не ломает порт
{
  const got=[]; const [a,b]=pair({},{onFile:m=>got.push(m)});
  b.onMessage('not json'); b.onMessage('null'); b.onMessage(new ArrayBuffer(5)); b.onMessage(JSON.stringify({t:'end',xid:'nope'}));
  a.enqueue(new Blob([bytes(5)]),'ok.bin');
  ok('garbage is ignored',await wait(()=>got.length===1));
}
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
