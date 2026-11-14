// R820T/R828D: пакетная перестройка (fast) должна дать те же регистры, что обычная, за меньшее число USB-передач
// Проверка: node tools/test-r820tbatch.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'modules/sources.js'),'utf8');
const a=src.indexOf('function rtlMakeR820T('), b=src.indexOf('// проверка чипа по ID-регистру');
const fn=src.slice(a,b);
const consts=['RTL_CMD','RTL_BLOCK','RTL_REG'].map(k=>src.match(new RegExp('^const '+k+' = .*$','m'))?.[0]).join('\n');
const REGS=JSON.parse(fn.match(/const REGISTERS=(\[[^\]]*\])/)[1].replace(/0x([0-9a-f]+)/gi,(m,h)=>parseInt(h,16)));
let bad=0; const ok=(c,m)=>{ console.log((c?'ok   ':'FAIL ')+m); if(!c) bad++; };
const BR=[0x0,0x8,0x4,0xc,0x2,0xa,0x6,0xe,0x1,0x9,0x5,0xd,0x3,0xb,0x7,0xf];
const rev=x=>(BR[x&0xf]<<4)|BR[x>>4];
function makeCom(fine){
  const hw=new Uint8Array(40); REGS.forEach((v,i)=>hw[i+5]=v);
  const st={hw, xfers:0, maxLen:0};
  return {st, com:{
    writeEach:async()=>{},
    i2c:{
      writeRegister:async(ad,r,v)=>{ st.xfers++; hw[r]=v; },
      writeRegisters:async(ad,r,vs)=>{ st.xfers++; st.maxLen=Math.max(st.maxLen,vs.length); vs.forEach((v,i)=>hw[r+i]=v); },
      readRegister:async()=>0x69,
      readRegBuffer:async(ad,r,len)=>{ st.xfers++; const buf=new Uint8Array(len);
        if(r===0 && len===3) buf[2]=rev(0x40); else if(r===0 && len>=5) buf[4]=rev(fine);
        return buf.buffer; }
    },
    readRegister:async()=>0, writeRegister:async()=>{}
  }};
}
const ctx=vm.createContext({Math,Uint8Array,Promise,Number,Array,Object,Error,console,setTimeout:(f)=>setTimeout(f,0)});
vm.runInContext(consts+'\n'+fn+';globalThis.MK=rtlMakeR820T;',ctx);
const FREQS=[100e6,100.2e6,145.5e6,433.92e6,433.95e6,868e6,1090e6,1690e6,7e6,50e6,162.5e6,100e6];
for(const [name,addr,isV4,fine] of [['V4 (R828D)',0x74,true,0x10],['R828D',0x74,false,0x10],['R820T',0x34,false,0x20]]){
  const run=async fast=>{
    const {st,com}=makeCom(fine), t=ctx.MK(com,28800000,addr,isV4); await t.init(); t.setFast?.(fast);
    const snaps=[]; let x0=st.xfers, per=[];
    for(const f of FREQS){ const x=st.xfers; const r=await t.setFrequency(f+3570000,f); per.push(st.xfers-x); snaps.push({r,hw:Array.from(st.hw.subarray(5,0x20)),lock:t.locked()}); }
    return {snaps,per,st};
  };
  const slow=await run(false), fast=await run(true);
  let same=true, why='';
  FREQS.forEach((f,i)=>{ const s=slow.snaps[i], q=fast.snaps[i];
    if(JSON.stringify(s.hw)!==JSON.stringify(q.hw)){ same=false; why=`${f}: ${s.hw.map(v=>v.toString(16)).join(' ')} ≠ ${q.hw.map(v=>v.toString(16)).join(' ')}`; }
    if(s.r!==q.r || !q.lock){ same=false; why=`${f}: частота ${s.r} ≠ ${q.r}, lock=${q.lock}`; } });
  ok(same,name+': регистры и частота после каждой перестройки совпадают с обычным путём'+(why?' — '+why:''));
  const sum=a=>a.reduce((x,y)=>x+y,0);
  ok(sum(fast.per)<sum(slow.per),name+': передач за 12 перестроек: '+sum(fast.per)+' вместо '+sum(slow.per));
  ok(fast.st.maxLen<=7,name+': пачка не длиннее 7 байт ('+fast.st.maxLen+')');
}
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('r820tbatch ok');
