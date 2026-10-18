// RT-890 / RT-4D: команды, суммы и весь сценарий против поддельного радио: node tools/test-rtboot.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Array,Map,Set,Error,String,Number,Object,Promise});
vm.runInContext(fs.readFileSync(path.join(root,'modules','rt890-kernels.js'),'utf8'),ctx,{filename:'rt890-kernels.js'});
vm.runInContext('this.K={rtbCmd,rtbWrite,rtbPrepare,rtbFlash,RTB_PROFILES}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const hx=u=>Buffer.from(u).toString('hex');

// радио: разбирает команды профиля, шлёт ACK. Опции: nak {блок:раз}, drop {блок:раз}, notBoot, silent, noErase
function radio(prof,o={}){
  const R={t:0,out:[],buf:[],log:[],blocks:new Map(),badSum:0,naks:{...(o.nak||{})},drops:{...(o.drop||{})},erased:0};
  const send=(...v)=>{ if(!o.silent) R.out.push(...v); };
  const eat=()=>{
    for(;;){
      const c=R.buf[0];
      if(c===0x52){ if(R.buf.length<4) return; R.buf.splice(0,4); R.log.push('read'); send(o.notBoot ? 0 : 0xFF,0,0,0); }
      else if(c===0x39){ if(R.buf.length<5) return; const p=R.buf.splice(0,5); R.log.push('erase'); R.erased++; send(o.noErase ? 0xFF : 6); }
      else if(c===0x57){
        const n=3+prof.block+1; if(R.buf.length<n) return;
        const p=R.buf.splice(0,n); let s=prof.ck; for(let i=0;i<n-1;i++) s+=p[i];
        if((s&255)!==p[n-1]) R.badSum++;
        R.log.push('W'); const k=R.blocks.size;
        if(R.drops[k]>0){ R.drops[k]--; continue; }
        if(R.naks[k]>0){ R.naks[k]--; send(0xFF); continue; }
        R.blocks.set(k,{off:p[1]<<8|p[2],data:p.slice(3,n-1)}); send(6);
      }else{ if(R.buf.length) R.buf.shift(); else return; }
    }
  };
  const io={ now:()=>R.t, sleep:async ms=>{ R.t+=ms; }, flush:()=>{ R.out.length=0; },
    read:async ms=>{ if(!R.out.length){ R.t+=Math.max(1,ms); return null; } const u=Uint8Array.from(R.out); R.out.length=0; return u; },
    write:async u=>{ R.buf.push(...u); eat(); } };
  return {R,io};
}
const rep=()=>{ const L=[]; const f=(p,s)=>L.push([p,s]); f.L=L; return f; };
const seq=R=>{ const o=[]; for(const x of R.log) if(!(x==='W' && o.at(-1)==='W')) o.push(x); return o.join(' '); };

function suite(name,prof,fwLen){
  const fw0=Uint8Array.from({length:fwLen},(_,i)=>(i*13+5)&255), fw=K.rtbPrepare(fw0,prof);
  ok(name+' prepare: block-aligned image, zero padded',fw.length%prof.block===0 && hx(fw.subarray(0,fwLen))===hx(fw0) && fw.subarray(fwLen).every(b=>b===0));
  ok(name+' prepare: too large',(()=>{ try{ K.rtbPrepare(new Uint8Array(prof.size+1),prof); return false; }catch(e){ return /too large/.test(e.message); } })());
  const w=K.rtbWrite(0x1234,fw.subarray(0,prof.block),prof.ck);
  let s=prof.ck; for(let i=0;i<w.length-1;i++) s+=w[i];
  ok(name+' write command: 57 hi lo data sum',w[0]===0x57 && w[1]===0x12 && w[2]===0x34 && w.length===prof.block+4 && w.at(-1)===(s&255));

  let {R,io}=radio(prof), pr=rep();
  return (async()=>{
    await K.rtbFlash(io,fw,prof,{},pr);
    const erases='erase '.repeat(prof.erase.length);
    ok(name+' flash: read, erase, blocks',seq(R)==='read '+erases+'W',seq(R));
    ok(name+' flash: every block at its offset with the right data and checksum',R.blocks.size===fw.length/prof.block && R.badSum===0 &&
      [...R.blocks].every(([k,v])=>v.off===((k*prof.block)&0xFFFF) && hx(v.data)===hx(fw.subarray(k*prof.block,(k+1)*prof.block))));
    ok(name+' flash: progress ends at 1',pr.L.at(-1)[0]===1);
    ({R,io}=radio(prof,{nak:{1:2}})); await K.rtbFlash(io,fw,prof,{},rep());
    ok(name+' retry: refused block is resent',R.blocks.size===fw.length/prof.block);
    ({R,io}=radio(prof,{drop:{1:1}})); await K.rtbFlash(io,fw,prof,{ackMs:300},rep());
    ok(name+' retry: lost ACK, block resent',R.blocks.size===fw.length/prof.block);
    ({R,io}=radio(prof,{nak:{1:99}})); let err=''; try{ await K.rtbFlash(io,fw,prof,{},rep()); }catch(e){ err=e.message; }
    ok(name+' fail: persistent refusal',/refused at 0x/.test(err) && R.blocks.size===1,err);
    ({R,io}=radio(prof,{notBoot:true})); err=''; try{ await K.rtbFlash(io,fw,prof,{},rep()); }catch(e){ err=e.message; }
    ok(name+' fail: not in the flashing mode, nothing erased',/not in the flashing mode/.test(err) && R.erased===0,err);
    ({R,io}=radio(prof,{silent:true})); err=''; try{ await K.rtbFlash(io,fw,prof,{ackMs:300},rep()); }catch(e){ err=e.message; }
    ok(name+' fail: no radio',/no response/.test(err),err);
    ({R,io}=radio(prof,{noErase:true})); err=''; try{ await K.rtbFlash(io,fw,prof,{},rep()); }catch(e){ err=e.message; }
    ok(name+' fail: erase refused, nothing written',/erase refused/.test(err) && R.blocks.size===0,err);
  })();
}

await suite('rt890',K.RTB_PROFILES.rt890,1000);
{ const {R,io}=radio(K.RTB_PROFILES.rt890), pr=rep(); await K.rtbFlash(io,K.rtbPrepare(new Uint8Array(256).fill(1),K.RTB_PROFILES.rt890),K.RTB_PROFILES.rt890,{},pr);
  ok('rt890: note about the radio not restarting',/will not restart/.test(pr.L.at(-1)[1])); }

await suite('rt4d',K.RTB_PROFILES.rt4d,5000);
{ const prof=K.RTB_PROFILES.rt4d, img=K.rtbPrepare(new Uint8Array(10).fill(7),prof);
  ok('rt4d: image always fills the whole memory',img.length===0x3D800 && img[9]===7 && img[10]===0);
  const {R,io}=radio(prof), pr=rep(); await K.rtbFlash(io,img,prof,{},pr);
  ok('rt4d: 246 blocks, address is the low 16 bits of the offset',R.blocks.size===246 && R.blocks.get(100).off===((100*1024)&0xFFFF) && R.badSum===0);
  ok('rt4d: no restart note for a full image',!/not restart/.test(pr.L.at(-1)[1])); }

console.log(bad ? bad+' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
