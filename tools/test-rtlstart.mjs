// RTL-SDR: надёжный запуск тюнера (R820T / R828D V4) на эмуляторе USB: захват PLL «срывается» заданное число раз.
// Проверка: node tools/test-rtlstart.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'modules/sources.js'),'utf8');
const a=src.indexOf('function rtlMakeR820T('), b=src.indexOf('// проверка чипа по ID-регистру');
const fn=src.slice(a,b);
const consts=['RTL_CMD','RTL_BLOCK','RTL_REG'].map(k=>src.match(new RegExp('^const '+k+' = .*$','m'))?.[0]).join('\n');   // общие константы драйвера (в воркер они уходят отдельной строкой)
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
ok(fn.length>2000 && /setFrequencyRobust/.test(fn) && /reinit/.test(fn),'rtlMakeR820T найден в sources.js');
// без внешних имён: функция целиком уходит в USB-воркер через toString
{ const bare=vm.createContext({Math,Uint8Array,Promise,setTimeout,Number,Array,Object,Error,console});
  let err=null; try{ vm.runInContext(consts+'\n'+fn+';(()=>{ const t=rtlMakeR820T({},28800000,0x74,true); return t; })()',bare); }catch(e){ err=e; }
  ok(!err,'rtlMakeR820T создаётся без внешних имён: '+(err&&err.message)); }
const BR=[0x0,0x8,0x4,0xc,0x2,0xa,0x6,0xe,0x1,0x9,0x5,0xd,0x3,0xb,0x7,0xf];
const rev=x=>(BR[x&0xf]<<4)|BR[x>>4];
// эмулятор: failLock — сколько ближайших проверок захвата (чтение 3 байт с адреса 0) вернут «не захвачено»
function makeCom(failLock){
  const st={locks:failLock, lockReads:0, writes:[], inits:0};
  return {st, com:{
    writeEach:async l=>{ st.inits++; },
    i2c:{
      writeRegister:async(a,r,v)=>{ st.writes.push([r,v]); },
      writeRegisters:async(a,r,vs)=>{ st.writes.push([r,vs[0]]); },
      readRegister:async()=>0x69,
      readRegBuffer:async(a,r,len)=>{
        const buf=new Uint8Array(len);
        if(r===0 && len===3){ st.lockReads++; const lock=st.locks<=0; if(!lock) st.locks--; buf[2]=rev(lock?0x40:0); }
        else if(r===0 && len>=5){ buf[4]=rev(0x10); }          // vco fine tune
        return buf.buffer;
      }
    },
    readRegister:async()=>0, writeRegister:async()=>{}
  }};
}
const sleepReal=vm.createContext({Math,Uint8Array,Promise,Number,Array,Object,Error,console,setTimeout:(f,ms)=>setTimeout(f,0)});   // паузы в тесте не ждём
vm.runInContext(consts+'\n'+fn+';globalThis.MK=rtlMakeR820T;',sleepReal);
async function scenario(failLock,isV4=true,withAfter=true){
  const {st,com}=makeCom(0);
  const t=sleepReal.MK(com,28800000,0x74,isV4);
  await t.init();
  st.locks=failLock; st.lockReads=0;                  // срывы — только на перестройке (калибровка фильтра при init их бы «съела»)
  let reapplied=0;
  const r=await t.setFrequencyRobust(100e6+3570000,100e6,async()=>{ reapplied++; });
  return {locked:t.locked(), reapplied, lockReads:st.lockReads, r};
}
// 1. захват сразу — одна попытка, без переинициализации
let r=await scenario(0);
ok(r.locked && r.reapplied===0,'захват сразу: locked, переинициализации нет');
// 2. захват срывается пару раз — берётся повторными попытками, без переинициализации
r=await scenario(2);
ok(r.locked && r.reapplied===0,'сорван 2 раза: захват получен повторами, без переинициализации ('+JSON.stringify(r)+')');
// 3. срывается много раз — после попыток тюнер переинициализируется (усиление возвращается), и перестройка удаётся
r=await scenario(13);
ok(r.locked && r.reapplied===1,'сорван много раз (13 проверок подряд: повторы кончились): полная переинициализация, усиление возвращено, захват получен ('+JSON.stringify(r)+')');
// 4. не захватывает никогда — честно сообщаем locked=false, и функция не зацикливается
r=await scenario(1e9);
ok(!r.locked && r.reapplied===1 && r.lockReads<100,'не захватывает никогда: locked=false, одна переинициализация, конечное число попыток ('+r.lockReads+')');
// 5. R820T (не V4) работает так же
r=await scenario(13,false);
ok(r.locked && r.reapplied===1,'R820T: то же поведение');
// 6. reinit сбрасывает выбранный вход триплексера: после него вход V4 снова записывается
{ const {st,com}=makeCom(0); const t=sleepReal.MK(com,28800000,0x74,true); await t.init();
  await t.setFrequency(100e6+3570000,100e6); const n1=st.writes.length;
  await t.setFrequency(101e6+3570000,101e6); const d1=st.writes.length-n1;           // тот же диапазон: вход не переключается
  await t.reinit(); const n2=st.writes.length; await t.setFrequency(101e6+3570000,101e6); const d2=st.writes.length-n2;
  ok(d2>d1,'после reinit вход триплексера записывается заново ('+d2+' > '+d1+' записей)'); }
// 7. checkLock читает бит заново
{ const {st,com}=makeCom(0); const t=sleepReal.MK(com,28800000,0x74,true); await t.init(); await t.setFrequency(100e6+3570000,100e6);
  ok(await t.checkLock()===true,'checkLock: захват есть'); st.locks=1; ok(await t.checkLock()===false && t.locked()===false,'checkLock: срыв виден'); ok(await t.checkLock()===true,'checkLock: восстановился'); }
// ---- хост: rtlHealthCheck (самопроверка после подключения) ----
{ const ha=src.indexOf('async function rtlHealthCheck('), hb=src.indexOf('\n}\n',ha)+3;
  ok(ha>0 && hb>ha,'rtlHealthCheck найден');
  const ctx2=vm.createContext({Math,Promise,Number,Object,console,performance,sdrSleep:()=>Promise.resolve(),sdrGainArg:n=>n.p.gainDb});
  vm.runInContext(src.slice(ha,hb)+';globalThis.HC=rtlHealthCheck;',ctx2);
  const mk=(locks,extra={})=>{ const calls=[]; const dev={pllLock:async()=>locks.length ? locks.shift() : locks.last, recover:async(f,g)=>{ calls.push([f,g]); return {f:f+1,locked:true}; }};
    return {calls, n:{dev,connected:true,busy:false,swActive:false,p:{gainDb:38,...extra},actualFreq:162e6,appliedFreq:162e6,appliedGainKey:'x',specRing:{filled:5},tunerMsg:''}}; };
  // захват есть сразу — ничего не трогаем
  let h=mk([true]); await ctx2.HC(h.n); ok(h.calls.length===0 && !h.n.tunerMsg,'захват есть: тюнер не трогаем');
  // сорван дважды — два перезапуска, потом ок; частота и усиление применяются заново обычным путём
  h=mk([false,false,true]); await ctx2.HC(h.n);
  ok(h.calls.length===2 && h.calls[0][0]===162e6 && h.calls[0][1]===38 && h.n.appliedFreq===null && h.n.appliedGainKey===null && h.n.specRing.filled===0 && /restarted ×2/.test(h.n.tunerMsg) && h.n.busy===false,'сорван дважды: два перезапуска, частота/усиление применятся заново ('+h.n.tunerMsg+')');
  // не захватывает никогда — три попытки и честное предупреждение
  h=mk([false]); h.n.dev.pllLock=async()=>false; await ctx2.HC(h.n);
  ok(h.calls.length===3 && /does not lock/.test(h.n.tunerMsg),'не захватывает: три перезапуска, предупреждение ('+h.calls.length+')');
  // автоперезапуск выключен
  h=mk([false],{autoRecover:false}); await ctx2.HC(h.n); ok(h.calls.length===0,'autoRecover выключен — ничего не делаем');
  // не RTL (нет pllLock) и отключение посреди проверки
  h=mk([true]); delete h.n.dev.pllLock; await ctx2.HC(h.n); ok(h.calls.length===0,'устройство без pllLock — пропуск');
  h=mk([false]); h.n.dev.pllLock=async()=>{ h.n.connected=false; return false; }; await ctx2.HC(h.n); ok(h.calls.length===0,'отключили посреди проверки — не перезапускаем');
  // занят перестройкой — ждём, не вмешиваемся
  h=mk([true]); let busyReads=0; Object.defineProperty(h.n,'busy',{get(){ return ++busyReads<3; },set(){ }}); await ctx2.HC(h.n); ok(h.calls.length===0 && busyReads>=3,'пока идёт перестройка — проверка откладывается'); }
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('rtlstart ok');
