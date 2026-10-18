// UV-K5: кадры, CRC, XOR и весь сценарий прошивки против поддельного радио: node tools/test-uvk5.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,Array,Map,Set,Error,String,Number,Object,Date,JSON,Promise,isNaN,parseInt});
vm.runInContext(fs.readFileSync(path.join(root,'modules','uvk5-kernels.js'),'utf8'),ctx,{filename:'uvk5-kernels.js'});
vm.runInContext('this.K={k5Crc,k5Pack,K5Rx,k5Version,k5Hello,k5Prepare,k5Flash,K5_MAX}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const U=a=>Uint8Array.from(a), hx=u=>Buffer.from(u).toString('hex');

// CRC-16/XMODEM: контрольное значение каталога
ok('crc16 xmodem check value',K.k5Crc(new TextEncoder().encode('123456789'),0,9)===0x31C3);

// кадр: маркеры открыты, данные и CRC гаммированы; разбор возвращает то же
const msg=U([0x30,0x05,4,0,0x31,0x2E,0x30,0x31]);
const pk=K.k5Pack(msg);
ok('frame: markers and size',hx(pk.subarray(0,4))==='abcd0800' && hx(pk.subarray(pk.length-2))==='dcba' && pk.length===16);
ok('frame: payload is obfuscated',hx(pk.subarray(4,12))!==hx(msg));
let r=new K.K5Rx().push(pk);
ok('frame: round trip, CRC ok',r.length===1 && r[0].type===0x0530 && r[0].len===4 && r[0].crcOk && hx(r[0].body.subarray(0,4))==='312e3031');
ok('frame: odd length is padded to even',K.k5Pack(U([1,2,3])).length===8+4);

// поток: мусор, кадр кусками, два кадра подряд, порча маркера
const rx=new K.K5Rx(), two=Uint8Array.from([...pk,...pk]);
r=[...rx.push(U([1,2,0xAB])),...rx.push(two.subarray(0,5)),...rx.push(two.subarray(5,20)),...rx.push(two.subarray(20))];
ok('stream: garbage skipped, chunks joined, two frames',r.length===2 && r.every(m=>m.crcOk));
const broken=pk.slice(); broken[broken.length-1]^=1;
const rb=new K.K5Rx(); r=rb.push(Uint8Array.from([...broken,...pk]));
ok('stream: broken trailer dropped, next frame found',r.length===1 && rb.bad===1);
const flip=pk.slice(); flip[6]^=0xFF;
r=new K.K5Rx().push(flip);
ok('stream: damaged payload reports crcOk=false',r.length===1 && !r[0].crcOk);

// ---------- поддельное радио в виртуальном времени ----------
// опции: failAck — {страница:сколько раз не отвечать}, errPage — {страница:сколько раз ответить ошибкой}, noBeacon
function radio(o={}){
  const R={t:0, out:[], rx:new K.K5Rx(), pages:new Map(), hello:null, writes:0, beaconAt:0, fails:{...(o.failAck||{})}, errs:{...(o.errPage||{})}, total:0, crcBad:0};
  const ver='2.00.06';
  const beacon=()=>{ const m=new Uint8Array(40), dv=new DataView(m.buffer); dv.setUint16(0,0x0518,true); dv.setUint16(2,36,true);
    for(let i=0;i<ver.length;i++) m[20+i]=ver.charCodeAt(i); return K.k5Pack(m); };
  const emit=u=>R.out.push(u);
  const advance=dt=>{ R.t+=dt; if(!o.noBeacon && !R.hello) while(R.beaconAt<=R.t){ emit(beacon()); R.beaconAt+=100; } };
  const answer=(page,err)=>{ const m=new Uint8Array(12), dv=new DataView(m.buffer); dv.setUint16(0,0x051A,true); dv.setUint16(2,8,true); dv.setUint16(8,page,true); dv.setUint16(10,err,true); emit(K.k5Pack(m)); };
  const io={
    now:()=>R.t,
    sleep:async ms=>{ advance(ms); },
    flush:()=>{ R.out.length=0; },
    read:async ms=>{
      if(!R.out.length) advance(Math.max(1,ms));
      if(!R.out.length) return null;
      const u=Uint8Array.from(R.out.flatMap(x=>[...x])); R.out.length=0; return u; },
    write:async u=>{
      R.writes++;
      for(const m of R.rx.push(u)){
        if(!m.crcOk) R.crcBad++;
        if(m.type===0x0530){ R.hello=String.fromCharCode(...m.body.subarray(0,4)); }
        else if(m.type===0x0519){
          const dv=new DataView(m.body.buffer,m.body.byteOffset,m.body.byteLength), idx=dv.getUint16(4,true);
          R.total=dv.getUint16(6,true);
          if(R.fails[idx]>0){ R.fails[idx]--; continue; }
          if(R.errs[idx]>0){ R.errs[idx]--; answer(idx,2); continue; }
          R.pages.set(idx,m.body.slice(12,12+256)); answer(idx,0);
        }
      }
    },
  };
  return {R,io};
}
const rep=()=>{ const L=[]; const f=(p,s)=>L.push([p,s]); f.L=L; return f; };
const fw=Uint8Array.from({length:1000},(_,i)=>(i*7+3)&255);
const joined=R=>{ const o=new Uint8Array(R.pages.size*256); for(const [i,b] of R.pages) o.set(b,i*256); return o; };

let {R,io}=radio(), pr=rep();
await K.k5Flash(io,fw,{},pr);
ok('flash: handshake echoes the bootloader version',R.hello==='2.00');
ok('flash: 4 pages of 256, total announced',R.pages.size===4 && R.total===4);
ok('flash: contents equal the file, tail zero-padded',hx(joined(R).subarray(0,1000))===hx(fw) && joined(R).subarray(1000).every(b=>b===0));
ok('flash: every host frame had a valid CRC',R.crcBad===0);
ok('flash: progress ends at 1',pr.L.at(-1)[0]===1);

({R,io}=radio({errPage:{1:2}}));
await K.k5Flash(io,fw,{},rep());
ok('retry: device error on a page, then ok',R.pages.size===4);

({R,io}=radio({failAck:{2:1}}));
await K.k5Flash(io,fw,{ackMs:300},rep());
ok('retry: lost acknowledgement, page resent',R.pages.size===4);

({R,io}=radio({failAck:{2:99}}));
let err=''; try{ await K.k5Flash(io,fw,{ackMs:300},rep()); }catch(e){ err=e.message; }
ok('fail: page never acknowledged',/page 2/.test(err) && R.pages.size===2,err);

({R,io}=radio({errPage:{0:99}}));
err=''; try{ await K.k5Flash(io,fw,{},rep()); }catch(e){ err=e.message; }
ok('fail: persistent device error is reported',/device error 2 on page 0/.test(err),err);

({R,io}=radio({noBeacon:true}));
err=''; try{ await K.k5Flash(io,fw,{beaconMs:1000},rep()); }catch(e){ err=e.message; }
ok('fail: no radio',/not detected/.test(err) && R.writes===0,err);

ok('prepare: size limit',(()=>{ try{ K.k5Prepare(new Uint8Array(K.K5_MAX+1)); return false; }catch(e){ return /too large/.test(e.message); } })());
ok('prepare: empty file rejected',(()=>{ try{ K.k5Prepare(new Uint8Array(0)); return false; }catch(e){ return true; } })());

console.log(bad ? bad+' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
