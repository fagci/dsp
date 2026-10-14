// DVB-драйверы (modules/dvb-kernels.js): node tools/test-dvb.mjs [путь к tuner_ref]
// Тюнер R828D сверяется с функциями ядра Linux (r820t.c), скомпилированными в C с записью обращений к I2C:
// собрать tuner_ref можно командой из tools/dvb-ref/README.md. Без него проверяются только демодуляторы и RTL2832.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Array,Error,Promise,Object,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/dvb-kernels.js'),'utf8')+';this.K={R82xxDvb,Mn8847x,DvbRtl,DVB_SYS,dvbChannel,XC_20P,R82_INIT};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

/* ---- тюнер против ядра ---- */
const ref=process.argv[2] && fs.existsSync(process.argv[2]) ? process.argv[2] : null;
if(!ref) console.log('skip tuner reference (no tuner_ref binary given)');
else{
  const SYS={[K.DVB_SYS.T]:1,[K.DVB_SYS.T2]:2,[K.DVB_SYS.C]:4};
  for(const [sys,f,bw] of [[K.DVB_SYS.T,474e6,8],[K.DVB_SYS.T2,506e6,8],[K.DVB_SYS.T,177.5e6,7],[K.DVB_SYS.T2,666e6,8],[K.DVB_SYS.T,818e6,8],[K.DVB_SYS.C,346e6,8],[K.DVB_SYS.T,226.5e6,6],[K.DVB_SYS.T2,858e6,8],[K.DVB_SYS.T,60e6,7]]){
    const want=execFileSync(ref,[String(SYS[sys]),String(f),String(bw)]).toString().split('\n').filter(l=>/^[WR] /.test(l));
    const got=[]; let rdn=0;
    const bus={ w:async(a,b)=>{ got.push('W '+b[0].toString(16).padStart(2,'0')+' '+b[1].toString(16).padStart(2,'0')); },
      r:async(a,reg,len)=>{ got.push('R '+reg.toString(16).padStart(2,'0')+' '+len); const o=new Uint8Array(len); for(let i=0;i<len;i++) o[i]=(0x5a+37*i+11*rdn)&255; rdn++; return o; },
      gate(){}, sleep:async()=>{} };
    const t=new K.R82xxDvb(bus,{addr:0x74,xtal:16e6,chip:'R828D'});
    t.xtalCap=K.XC_20P; t.initDone=true;
    await t.write(0x05,Array.from(K.R82_INIT));
    await t.tune(sys,f,bw*1e6);
    // в ядре write идёт по одному регистру, как и у нас
    let same=got.length===want.length, at=-1;
    for(let i=0;same && i<got.length;i++) if(got[i]!==want[i]){ same=false; at=i; }
    ok(`tuner ${sys} ${f/1e6} MHz ${bw} MHz: ${want.length} bus operations as in the kernel`,same, same?'':`first difference at ${at}: js "${got[at]}" kernel "${want[at]}" (${got.length} vs ${want.length})`);
  }
}

/* ---- эмулятор шины: MN88473, тюнер и RTL2832 ---- */
function mkChip(kind){
  const banks=[new Uint8Array(256),new Uint8Array(256),new Uint8Array(256)], log=[], fwBytes=[];
  banks[2][0xff]= kind===473 ? 0x03 : 0x02;
  banks[0][0xf5]=0x01;                                           // прошивка не загружена
  let fwMode=false;
  return {banks, log, fwBytes,
    w(addr,bytes){
      const b=addr===0x30?0:addr===0x34?1:addr===0x38?2:-1;
      if(b<0) return;
      if(b===0 && bytes[0]===0xf5){ fwMode= bytes[1]===0x03; if(bytes[1]===0x00) banks[0][0xf5]=0x00; }
      if(b===0 && bytes[0]===0xf6){ for(let i=1;i<bytes.length;i++) fwBytes.push(bytes[i]); return; }
      if(b===2 && bytes.length>2) throw new Error('bank 2 accepts one register only');
      for(let i=1;i<bytes.length;i++) banks[b][bytes[0]+i-1]=bytes[i];
      log.push([b,bytes[0],bytes[1]]);
    },
    r(addr,reg,len){
      const b=addr===0x30?0:addr===0x34?1:2, o=new Uint8Array(len);
      for(let i=0;i<len;i++) o[i]=banks[b][reg+i];
      return o; }
  };
}
for(const kind of [473,472]){
  const chip=mkChip(kind), bus={ w:async(a,b)=>chip.w(a,b), r:async(a,r,l)=>chip.r(a,r,l), gate(){}, sleep:async()=>{} };
  const d=new K.Mn8847x(bus,kind);
  ok(`MN8847${kind===473?3:2}: chip id`,(await d.chipId())===(kind===473?3:2));
  const fw=Uint8Array.from({length:1000},(_,i)=>i*7&255);
  await d.init(fw);
  ok(`MN8847${kind===473?3:2}: firmware sent in full`,chip.fwBytes.length===1000 && chip.fwBytes.every((v,i)=>v===fw[i]));
  let err=null; try{ const c2=mkChip(kind); await new K.Mn8847x({w:async(a,b)=>c2.w(a,b),r:async(a,r,l)=>c2.r(a,r,l),gate(){},sleep:async()=>{}},kind).init(null); }catch(e){ err=e; }
  ok(`MN8847${kind===473?3:2}: no firmware → error`,!!err && /firmware/.test(err.message));
  await d.tune(K.DVB_SYS.T2,8e6,4570000,0);
  const ifv=Math.round(4570000*0x1000000/d.clk);
  ok(`MN8847${kind===473?3:2}: IF registers`,chip.banks[2][0x10]===(ifv>>16&255) && chip.banks[2][0x11]===(ifv>>8&255) && chip.banks[2][0x12]===(ifv&255),`IF ${ifv.toString(16)}`);
  ok(`MN8847${kind===473?3:2}: DVB-T2 selected`,chip.banks[2][0x03]===0x03);
  ok(`MN8847${kind===473?3:2}: state machine reset last`,chip.log[chip.log.length-1][1]===0xf8 && chip.log[chip.log.length-1][2]===0x9f);
  let e2=null; try{ await d.tune(K.DVB_SYS.T,5e6,4570000,0); }catch(e){ e2=e; }
  ok(`MN8847${kind===473?3:2}: unsupported bandwidth`,kind===473 ? !!e2 : !e2);
}
{ // статус: DVB-T захвачен
  const chip=mkChip(473), bus={ w:async(a,b)=>chip.w(a,b), r:async(a,r,l)=>chip.r(a,r,l), gate(){}, sleep:async()=>{} };
  const d=new K.Mn8847x(bus,473);
  chip.banks[0][0x62]=0x0b; chip.banks[0][0x8f]=0x01; chip.banks[0][0x90]=0x00; chip.banks[2][0x86]=0x80; chip.banks[2][0x87]=0x40;
  const s=await d.status(K.DVB_SYS.T);
  ok('MN88473 status: lock',s.lock && s.viterbi && s.strength===((0x80<<8)|0x40|(0x80>>2)),JSON.stringify(s));
  ok('MN88473 status: CNR 10·(log10(65536/256)+0.2)',Math.abs(s.cnr-10*(Math.log10(65536/256)+0.2))<1e-9,String(s.cnr));
  chip.banks[0][0x62]=0xa5; ok('MN88473 status: no signal',!(await d.status(K.DVB_SYS.T)).signal);
  chip.banks[2][0x8b]=0x0d; ok('MN88473 status: DVB-T2 lock',(await d.status(K.DVB_SYS.T2)).lock);
}

/* ---- RTL2832: порядок обращений ---- */
{
  const ops=[], mem={};
  const io={ rd:async r=>mem[r]||0, wr:async(r,v)=>{ mem[r]=v; ops.push(`wr ${r.toString(16)} ${v.toString(16)}`); },
    wrMask:async(r,v,m)=>{ mem[r]=((mem[r]||0)&~m)|(v&m); ops.push(`mask ${r.toString(16)} ${v.toString(16)}/${m.toString(16)}`); },
    wrBytes:async(r,b)=>{ ops.push(`bytes ${r.toString(16)} ${b.map(x=>x.toString(16)).join(',')}`); }, sleep:async()=>{}, clearHalt:async()=>ops.push('clearHalt'),
    demodR:async(p,a)=>0x04, demodW:async(p,a,v,l)=>ops.push(`demod ${p}:${a.toString(16)} ${v.toString(16)}/${l}`) };
  await K.DvbRtl.initEp(io);
  ok('RTL2832: endpoint set up',ops.includes('wr 2000 9') && ops.includes('bytes 2158 0,2,0,0') && ops.includes('bytes 2160 14,0,0,0'));
  ops.length=0; await K.DvbRtl.power(io,true);
  ok('RTL2832: power on (GPIO3, PLL, reset off, endpoint, clear halt)',ops.join('|')==='mask 3001 8/18|mask 300b 0/10|mask 3000 80/80|mask 3000 20/20|bytes 2148 0,0|clearHalt',ops.join('|'));
  ops.length=0; await K.DvbRtl.slaveTs(io,true);
  ok('RTL2832: TS pass-through registers',ops.join('|')==='demod 1:1 0/1|demod 1:c 5fff/2|demod 0:21 c/1|demod 0:bc 18/1|demod 1:92 7ff7ff/3',ops.join('|'));
}
ok('channels',K.dvbChannel(21).f===474e6 && K.dvbChannel(30).f===546e6 && K.dvbChannel(5).f===177.5e6 && K.dvbChannel(12).f===226.5e6 && K.dvbChannel(1)===null);
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
