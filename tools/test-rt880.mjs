// RT-880: Intel HEX, блоки, контрольные суммы и весь сценарий против поддельного радио: node tools/test-rt880.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,Array,Map,Set,Error,String,Number,Object,Date,JSON,Promise,TextDecoder,isNaN,parseInt});
vm.runInContext(fs.readFileSync(path.join(root,'modules','rt880-kernels.js'),'utf8'),ctx,{filename:'rt880-kernels.js'});
vm.runInContext('this.K={rtBlock,rtParseHex,rtPrepare,rtFlash,RT_CMD,RT_SIZE,RT_BLOCK,RT_BASE}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const hx=u=>Buffer.from(u).toString('hex'), enc=s=>new TextEncoder().encode(s);

// ---------- Intel HEX ----------
const rec=(adr,type,data)=>{ const b=[data.length,adr>>8,adr&255,type,...data]; let s=0; for(const x of b) s+=x; return ':'+[...b,(-s)&255].map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase(); };
const hexFile=[rec(0,4,[0x08,0x00]), rec(0x2800,0,[1,2,3,4]), rec(0x27FE,0,[9,9]), rec(0x2C00,0,[0xAA]), rec(0,4,[0x08,0x04]), rec(0,0,[7,7]), rec(0,1,[])].join('\n')+'\n';
let img=K.rtParseHex(hexFile);
ok('hex: image is the flash window',img.length===K.RT_SIZE);
ok('hex: data lands at address − 0x08002800',hx(img.subarray(0,4))==='01020304' && img[0x400]===0xAA);
ok('hex: bootloader area and the rest stay 0xFF',img[4]===0xFF && img.subarray(4,0x400).every(b=>b===0xFF));
ok('hex: segment above the window is dropped (0x08040000 is past 246 KiB)',!img.includes(7));
const edge=K.rtParseHex([rec(0,4,[0x08,0x03]),rec(0xFFFF,0,[0x5A,0x6B]),rec(0,1,[])].join('\n'));
ok('hex: last byte of the window is placed, the next one dropped',edge[K.RT_SIZE-1]===0x5A && !edge.includes(0x6B));
const damaged=hexFile.split('\n'); damaged[1]=damaged[1].slice(0,-2)+(damaged[1].endsWith('00') ? '01' : '00');
ok('hex: checksum error is reported',(()=>{ try{ K.rtParseHex(damaged.join('\n')); return false; }catch(e){ return /line 2: checksum/.test(e.message); } })());
ok('hex: no data in the window is an error',(()=>{ try{ K.rtParseHex(rec(0x100,0,[1])+'\n'+rec(0,1,[])); return false; }catch(e){ return /no data/.test(e.message); } })());
ok('hex: garbage is not a record',(()=>{ try{ K.rtParseHex('hello'); return false; }catch(e){ return /not an Intel HEX/.test(e.message); } })());

// ---------- prepare ----------
const bin=Uint8Array.from({length:3000},(_,i)=>i&255);
img=K.rtPrepare(bin,'auto');
ok('prepare: bin is padded with 0xFF to the window',img.length===K.RT_SIZE && hx(img.subarray(0,3000))===hx(bin) && img[3000]===0xFF);
ok('prepare: auto detects Intel HEX',K.rtPrepare(enc('\n'+hexFile),'auto')[0]===1);
ok('prepare: forced bin keeps text as bytes',K.rtPrepare(enc(hexFile),'bin')[0]===0x3A);
ok('prepare: too large bin',(()=>{ try{ K.rtPrepare(new Uint8Array(K.RT_SIZE+1),'bin'); return false; }catch(e){ return /too large/.test(e.message); } })());

// ---------- блок ----------
const fw=K.rtPrepare(bin,'bin');
let b=K.rtBlock(fw,0x1400,82);
let sum=82; for(let i=0;i<1027;i++) sum+=b[i];
ok('block: layout, address and checksum',b.length===1028 && b[0]===87 && b[1]===0x14 && b[2]===0x00 && b[1027]===(sum&255) && hx(b.subarray(3,7))===hx(fw.subarray(0x1400,0x1404)));
b=K.rtBlock(fw,250880,0);
ok('block: address is the low 16 bits of the offset',b[1]===((250880>>8)&255) && b[2]===(250880&255));
ok('block: the checksum offset differs per variant',K.rtBlock(fw,0,82)[1027]!==K.rtBlock(fw,0,0)[1027]);

// ---------- поддельное радио ----------
// опции: nak {блок:сколько раз}, drop {блок:сколько раз молчать}, silent — не отвечать вовсе, iradio, zeros — слать нули перед ответом
function radio(o={}){
  const R={t:0, out:[], buf:[], cmds:[], blocks:new Map(), badSum:0, naks:{...(o.nak||{})}, drops:{...(o.drop||{})}};
  const c=o.iradio ? K.RT_CMD.iradio : K.RT_CMD.std, ck=o.iradio ? 0 : 82;
  const same=(a,x)=>a.length===x.length && a.every((v,i)=>v===x[i]);
  const send=v=>{ if(!o.silent) R.out.push(...(o.zeros ? [0,0] : []),v); };
  const eat=()=>{
    for(;;){
      if(R.buf[0]===87){
        if(R.buf.length<1028) return;
        const p=R.buf.splice(0,1028), off=p[1]<<8|p[2]; let sm=ck; for(let i=0;i<1027;i++) sm+=p[i];
        if((sm&255)!==p[1027]) R.badSum++;
        R.cmds.push('W');
        const n=R.blocks.size;                                  // номер = число уже принятых блоков
        if(R.drops[n]>0){ R.drops[n]--; continue; }
        if(R.naks[n]>0){ R.naks[n]--; send(255); continue; }
        R.blocks.set(n,{off,data:p.slice(3,1027)}); send(6);
      }else if(R.buf.length>=5){
        const p=R.buf.splice(0,5);
        R.cmds.push(same(p,c.connect) ? 'connect' : same(p,c.update) ? 'update' : same(p,c.end) ? 'end' : 'unknown');
        if(!['end','unknown'].includes(R.cmds.at(-1))) send(6);
      }else return;
    }
  };
  const io={
    now:()=>R.t,
    sleep:async ms=>{ R.t+=ms; },
    flush:()=>{ R.out.length=0; },
    read:async ms=>{
      if(!R.out.length){ R.t+=Math.max(1,ms); return null; }
      const u=Uint8Array.from(R.out); R.out.length=0; return u; },
    write:async u=>{ R.buf.push(...u); eat(); },
  };
  return {R,io};
}
const rep=()=>{ const L=[]; const f=(p,s)=>L.push([p,s]); f.L=L; return f; };
const seqOf=R=>{ const o=[]; for(const x of R.cmds) if(!(x==='W' && o.at(-1)==='W')) o.push(x); return o.join(' '); };

let {R,io}=radio(), pr=rep();
await K.rtFlash(io,fw,{},pr);
ok('flash: connect ×3, update, blocks, end',seqOf(R)==='connect connect connect update W end',seqOf(R));
ok('flash: all 246 blocks, each at its 1 KiB offset',R.blocks.size===246 && [...R.blocks].every(([n,v])=>v.off===((n*1024)&0xFFFF)));
ok('flash: the data equals the image',[...R.blocks].every(([n,v])=>hx(v.data)===hx(fw.subarray(n*1024,n*1024+1024))));
ok('flash: every checksum valid',R.badSum===0);
ok('flash: progress ends at 1',pr.L.at(-1)[0]===1);

({R,io}=radio({iradio:true}));
await K.rtFlash(io,fw,{iradio:true},rep());
ok('iradio: other commands and checksum accepted',seqOf(R)==='connect connect connect update W end' && R.badSum===0 && R.blocks.size===246);
({R,io}=radio({iradio:true}));
let err=''; try{ await K.rtFlash(io,fw,{},rep()); }catch(e){ err=e.message; }
ok('iradio: wrong variant is not understood',/no response|unexpected|no ACK/.test(err) && R.blocks.size===0,err);

({R,io}=radio({nak:{5:2}}));
await K.rtFlash(io,fw,{},rep());
ok('retry: NAK on a block, block resent',R.blocks.size===246);
({R,io}=radio({drop:{7:1}}));
await K.rtFlash(io,fw,{ackMs:300},rep());
ok('retry: lost ACK, block resent',R.blocks.size===246);
({R,io}=radio({zeros:true}));
await K.rtFlash(io,fw,{},rep());
ok('zeros between answers are ignored',R.blocks.size===246);

({R,io}=radio({nak:{3:99}}));
err=''; try{ await K.rtFlash(io,fw,{},rep()); }catch(e){ err=e.message; }
ok('fail: persistent NAK',/NAK on block 3/.test(err) && R.blocks.size===3,err);
({R,io}=radio({silent:true}));
err=''; try{ await K.rtFlash(io,fw,{},rep()); }catch(e){ err=e.message; }
ok('fail: no device',/no response/.test(err) && R.cmds.filter(x=>x==='connect').length===4,err);
({R,io}=radio({drop:{245:99}}));
const p2=rep(); await K.rtFlash(io,fw,{ackMs:300},p2);
ok('last block never acknowledged: end is still sent, with a note',R.cmds.at(-1)==='end' && /not acknowledged/.test(p2.L.at(-1)[1]));

console.log(bad ? bad+' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
