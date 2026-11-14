// R820T/R828D: перестройка конвейером (передачи без ожидания каждой) на эмуляторе USB-устройства.
// Эмулятор: передачи EP0 выполняются строго по порядку, у каждой задержка; запись в демодулятор «защёлкивается» чтением 0x0a:0x01;
// записи тюнера доходят, только пока I2C-шлюз открыт. Проверка: node tools/test-r820tpipe.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'modules/sources.js'),'utf8');
const a=src.indexOf('function rtlNumToBuf('), b=src.indexOf('const R82XX_LNA_STEPS');
const c=src.indexOf('function rtlMakeR820T('), d=src.indexOf('// проверка чипа по ID-регистру');
const consts=['RTL_CMD','RTL_BLOCK','RTL_REG'].map(k=>src.match(new RegExp('^const '+k+' = .*$','m'))?.[0]).join('\n');
const REGS=JSON.parse(src.slice(c,d).match(/const REGISTERS=(\[[^\]]*\])/)[1].replace(/0x([0-9a-f]+)/gi,(m,h)=>parseInt(h,16)));
let bad=0; const ok=(v,m)=>{ console.log((v?'ok   ':'FAIL ')+m); if(!v) bad++; };
const BR=[0x0,0x8,0x4,0xc,0x2,0xa,0x6,0xe,0x1,0x9,0x5,0xd,0x3,0xb,0x7,0xf];
const rev=x=>(BR[x&0xf]<<4)|BR[x>>4];
const DELAY=4;                                            // мс на передачу туда-обратно — как в WebUSB (наши замеры)
function makeDev(fine){
  const st={hw:new Uint8Array(40), open:false, pendOpen:null, queue:Promise.resolve(), n:0, dropped:0, order:[]};
  REGS.forEach((v,i)=>st.hw[i+5]=v);
  // задержка хоста (IPC/планировщик) по 2 мс на отправку и на возврат; на самом устройстве передачи идут по очереди, по 1 мс
  let lastExec=0;
  const run=(fn)=>{ const now=Date.now(), exec=Math.max(now+DELAY/2,lastExec+1); lastExec=exec;
    return new Promise(res=>setTimeout(()=>{ const r=fn(); setTimeout(()=>res(r),DELAY/2); }, exec-now)); };
  // fn выполняется в момент «исполнения» передачи; порядок — порядок вызова
  return {st, dev:{
    controlTransferOut:(setup,buf)=>{ const idx=setup.index, val=setup.value, u=new Uint8Array(buf); st.n++;
      return run(()=>{ st.order.push('w');
        if((idx&~0x10)===0x600){                         // I2C тюнера
          if(!st.open){ st.dropped++; return {status:'ok'}; }
          if(u.length>1) for(let i=1;i<u.length;i++) st.hw[u[0]+i-1]=u[i];
        } else if((idx&~0x10)===0x1 && val===0x120){ st.pendOpen=(u[0]===0x18); }   // демодулятор, страница 1, адрес 1
        return {status:'ok'}; }); },
    controlTransferIn:(setup,len)=>{ const idx=setup.index, val=setup.value; st.n++;
      return run(()=>{ st.order.push('r');
        const out=new Uint8Array(Math.max(8,len));
        if(idx===0x0a && val===0x120){ if(st.pendOpen!==null){ st.open=st.pendOpen; st.pendOpen=null; } }   // защёлка
        else if(idx===0x600){ out[2]=rev(0x40); out[4]=rev(fine); }      // код всегда просит 8 байт и режет сам: отдаём и бит захвата, и fine tune
        return {data:{buffer:out.buffer}}; }); },
    transferIn:async()=>({data:{buffer:new ArrayBuffer(0)}})
  }};
}
const ctx=vm.createContext({Math,Uint8Array,Uint32Array,DataView,ArrayBuffer,Promise,Number,Array,Object,Error,console,performance,setTimeout});
vm.runInContext(consts+'\n'+src.slice(a,b)+'\n'+src.slice(c,d)+';globalThis.COM=rtlMakeCom;globalThis.MK=rtlMakeR820T;',ctx);
const FREQS=[100e6,100.2e6,145.5e6,433.92e6,868e6,1090e6,7e6,50e6,162.5e6,100e6];
for(const [name,addr,isV4,fine] of [['V4 (R828D)',0x74,true,0x10],['R820T',0x34,false,0x20]]){
  const run=async pipeOn=>{
    const {st,dev}=makeDev(fine), com=ctx.COM(dev), t=ctx.MK(com,28800000,addr,isV4);
    await com.withI2C(()=>t.init(),false);
    t.setFast(true);
    st.n=0; st.dropped=0; const t0=Date.now(), snaps=[];
    for(const f of FREQS){ const r=await com.withI2C(()=>t.setFrequencyRobust(f+3570000,f,async()=>{}),pipeOn); snaps.push({r,hw:Array.from(st.hw.subarray(5,0x20)),lock:t.locked(),open:st.open}); }
    return {snaps,ms:Date.now()-t0,n:st.n,dropped:st.dropped};
  };
  const seq=await run(false), pip=await run(true);
  let same=true, why='';
  FREQS.forEach((f,i)=>{ const s=seq.snaps[i], q=pip.snaps[i];
    if(JSON.stringify(s.hw)!==JSON.stringify(q.hw)){ same=false; why=`${f}: регистры различаются`; }
    if(s.r!==q.r || !q.lock){ same=false; why=`${f}: частота ${s.r} ≠ ${q.r}, lock=${q.lock}`; }
    if(q.open){ same=false; why=`${f}: шлюз остался открытым`; } });
  ok(same,name+': конвейер даёт те же регистры и частоту, шлюз закрыт после каждой перестройки'+(why?' — '+why:''));
  ok(pip.dropped===0,name+': ни одна запись тюнера не потеряна (шлюз был открыт) — '+pip.dropped);
  ok(pip.n===seq.n,name+': то же число передач ('+pip.n+')');
  ok(pip.ms<seq.ms*0.75,name+': 10 перестроек быстрее: '+pip.ms+' мс вместо '+seq.ms+' мс');
}
// ошибка в середине конвейера доходит до вызывающего, конвейер закрывается
{ const {dev}=makeDev(0x10); let k=0; const old=dev.controlTransferOut; dev.controlTransferOut=(s,b)=>(++k===3 ? Promise.reject(new Error('usb fail')) : old(s,b));
  const com=ctx.COM(dev); let err=null;
  try{ await com.withI2C(async()=>{ await com.i2c.writeRegisters(0x74,0x10,[1,2]); await com.i2c.writeRegisters(0x74,0x12,[3]); },true); }catch(e){ err=e; }
  ok(err && /usb fail/.test(err.message),'ошибка передачи в конвейере доходит до вызывающего');
  const {dev:d2,st}=makeDev(0x10); const com2=ctx.COM(d2); await com2.withI2C(async()=>{},false); ok(st.open===false,'после обычного withI2C шлюз закрыт'); }
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('r820tpipe ok');
