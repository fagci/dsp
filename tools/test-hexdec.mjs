// Записи декодеров с hex / hexSchema против схем HEX Structure: node tools/test-hexdec.mjs
// Те же ядра, что у iq-worker.js (изолированный vm), плюс модули hex-*.js.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=fs.readFileSync(path.join(root,'iq-worker.js'),'utf8');
const files=[...worker.match(/importScripts\((.*)\);/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\+Q$/,''));
const ctx=vm.createContext({console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Map,Set,Date,JSON,Array,Object,String,Number,parseInt,parseFloat,isFinite,isNaN,Symbol,Promise,BigInt,DataView,WebAssembly,atob,ArrayBuffer,TextEncoder,TextDecoder,Error});
ctx.self=ctx;
for(const f of files) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
for(const f of ['hex-kernels.js','hex-formats.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
const ev=s=>vm.runInContext(s,ctx);
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// ACARS: блок, как его собирает генератор ядра (чётность, BCS), через done() декодера
{
  const r=ev(`(()=>{
    const m={mode:'2',reg:'.D-AIBA',ack:0x15,label:'H1',blk:'3',flight:'LH1234',body:'#M1BPOS N55123E037456,FL350'};
    const c=[m.mode.charCodeAt(0)]; for(const ch of m.reg) c.push(ch.charCodeAt(0));
    c.push(m.ack,m.label.charCodeAt(0),m.label.charCodeAt(1),m.blk.charCodeAt(0));
    const txt='M07A'+m.flight+m.body; c.push(2); for(const ch of txt) c.push(ch.charCodeAt(0)); c.push(3);
    const by=c.map(vacPar), crc=vacCrc(by,by.length); by.push(crc&0xFF,crc>>8);
    const n={p:{fix:false},seen:[],sps:10,frames:0,fixed:0,bad:0,recent:[],pk:.5,badTe:-1e9}, recs=[];
    IQK.acarsRx.done(n,{by,pe:[],ip:0},100,recs);
    return recs;
  })()`);
  const rec=r[0];
  ok('acars record emitted',r.length===1 && rec.hexSchema==='acars' && typeof rec.hex==='string',JSON.stringify(rec));
  const p=ev(`hexParse(${JSON.stringify(rec.hexSchema)},hexFromHex(${JSON.stringify(rec.hex)}))`);
  const v=p.vals;
  ok('acars block parsed',v.mode==='2' && v.reg==='.D-AIBA' && v.label==='H1' && v.blk===51 && v.msgno==='M07A' && v.flight==='LH1234' && v.text==='#M1BPOS N55123E037456,FL350' && v.end===3,JSON.stringify(v));
  ok('acars matches decoder fields',rec.reg==='D-AIBA' && rec.flight==='LH1234' && rec.label==='H1');
}

// BLE: событие рекламы → AD → схема (iBeacon, Eddystone-URL, имя, TX power)
{
  vm.runInContext(fs.readFileSync(path.join(root,'modules/ble-kernels.js'),'utf8'),ctx,{filename:'ble-kernels.js'});
  const ib=new Uint8Array([2,0x15,0xB9,0x40,0x7F,0x30,0xF5,0xF8,0x46,0x6E,0xAF,0xF9,0x25,0x55,0x6B,0x57,0xFE,0x6D,0,1,0,2,0xC5]);
  ctx.ib=ib; ctx.ev1={name:'Tag',txPower:-12,manufacturerData:new Map([[0x4C,new DataView(ib.buffer)]]),serviceData:new Map([['0000feaa-0000-1000-8000-00805f9b34fb',new DataView(new Uint8Array([0x10,0xEB,0x02,0x67,0x6F,0x6F,0x67,0x6C,0x65,0x07]).buffer)]])};
  const hexs=ev('hexToHex(bleAdBytes(ev1))');
  const p=ev(`hexParse('ble-adv',hexFromHex('${hexs}'))`), v=p.vals;
  ok('ble adv parsed',p.ok && v['ad[0].data.name']==='Tag' && v['ad[1].data.tx']===-12,JSON.stringify(v));
  ok('ibeacon',v['ad[2].data.company']===76 && v['ad[2].data.major']===1 && v['ad[2].data.minor']===2 && v['ad[2].data.tx']===-59 && v['ad[2].data.uuid']==='b9407f30f5f8466eaff925556b57fe6d',JSON.stringify(v));
  ok('eddystone url',v['ad[3].data.uuid']===0xFEAA && v['ad[3].data.etype']===16 && v['ad[3].data.etx']===-21 && v['ad[3].data.scheme']===2 && v['ad[3].data.url']==='google\x07',JSON.stringify(v));
  // эталонная реклама iBeacon целиком: flags + manufacturer (из спецификации Apple), сырой пакет
  const raw=ev("hexParse('ble-adv',hexFromHex('020106 1aff4c000215b9407f30f5f8466eaff925556b57fe6d00010002c5'))");
  ok('ibeacon raw advertisement',raw.ok && raw.vals['ad[0].data.flags']===6 && raw.vals['ad[1].data.major']===1,JSON.stringify(raw.vals));
}

// GSM: L2-сообщения SI3 / SI4 / SI1 — схема против разбора gsmParseSI самого декодера
{
  ctx.def=()=>{}; ctx.defIQ=()=>{};
  vm.runInContext(fs.readFileSync(path.join(root,'modules/gsm.js'),'utf8'),ctx,{filename:'gsm.js'});
  const si3=[0x59,0x06,0x1b, 0x12,0x34, 0x52,0xf0,0x10, 0x01,0xf4, 0x01,0x02,0x03, 0x45, 0x2a,0x3b, 0x04,0x05,0x06, 0x2b,0x2b,0x2b,0x2b];
  const si4=[0x31,0x06,0x1c, 0x25,0xf0,0x11, 0x00,0x7b, 0x2a,0x3b, 0x04,0x05,0x06, 0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b,0x2b];
  ctx.si3=si3; ctx.si4=si4;
  const d3=ev('gsmParseSI(si3)'), p3=ev(`hexParse('gsm-l2',Uint8Array.from(si3))`);
  ok('gsm si3 matches the decoder',d3.type==='SI3' && p3.vals.ci===d3.ci && p3.vals.lac===d3.lac && p3.vals.plmn===ev('gsmMccMncStr(gsmParseSI(si3))') && p3.vals.mt===0x1b,JSON.stringify([d3.ci,d3.lac,ev('gsmMccMncStr(gsmParseSI(si3))'),p3.vals]));
  const d4=ev('gsmParseSI(si4)'), p4=ev(`hexParse('gsm-l2',Uint8Array.from(si4))`);
  ok('gsm si4 matches the decoder',d4.type==='SI4' && p4.vals.lac===d4.lac && p4.vals.plmn===ev('gsmMccMncStr(gsmParseSI(si4))'),JSON.stringify([d4.lac,ev('gsmMccMncStr(gsmParseSI(si4))'),p4.vals]));
  ctx.b3=ev(`hexBuild('gsm-l2',{li:22,m:0,el:1,skip:0,pd:6,mt:27,ci:4660,plmn:'250-01',lac:500}).bytes`);
  const rt=ev('hexParse("gsm-l2",b3)');
  ok('plmn build round trip',rt.vals.plmn==='250-01' && rt.vals.ci===4660 && rt.vals.lac===500 && ev('gsmParseSI(b3)').mcc===250,JSON.stringify(rt.vals));
}

// M17: LSF от генератора ядра → схема; позывные основания 40 и CRC-16 против m17Crc / m17CallDec
{
  const meta=new Uint8Array(14);
  ctx.lsfb=ev("(()=>{ const m=new Uint8Array(14); m.set(m17CallEnc('SP5WWP'),0); m.set(m17CallEnc('M17-M17 C'),6); return m17MakeLsf('SP5WWP','W2FBI',0x0005|(3<<7)|(2<<5),m); })()");
  const p=ev('hexParse("m17-lsf",lsfb)'), v=p.vals;
  ok('m17 lsf parsed',v.src==='SP5WWP' && v.dst==='W2FBI' && v.can===3 && v.dtype===2 && v.stream===1 && v.sub===2 && p.ok,JSON.stringify(v));
  ok('m17 crc agrees with the decoder',ev('m17Crc(lsfb,30)')===0 && p.fields.find(f=>f.n==='crc').calcOk===true);
  const bc=ev(`hexBuild('m17-lsf',{dst:'BROADCAST',src:'SP5WWP',can:3,dtype:2,stream:1,sub:2,enc:0,meta:'00'})`);
  ctx.bcb=bc.bytes; 
  ok('m17 build: broadcast, crc',ev('m17Crc(bcb,30)')===0 && ev('m17CallDec(bcb.subarray(0,6))')==='BROADCAST' && ev('m17CallDec(bcb.subarray(6,12))')==='SP5WWP',ev('bytesHex(bcb)'));
  const pk=ev('hexParse("m17-pkt",hexFromHex("0548454c4c4f"))');
  ok('m17 packet: SMS',pk.vals.proto===5 && pk.vals.data==='48454c4c4f');
}

// P25: TSBK / LC / HDU — поля схемы против разбора p25Tsbk / p25Lc декодера, CRC-16 блока
{
  const mk=(b0,mf,data)=>{ const a=new Uint8Array(12); a[0]=b0; a[1]=mf; a.set(data,2); const c=ev(`dmrCrc16(Uint8Array.from([${Array.from(a.subarray(0,10))}]),10)`); a[10]=c>>8; a[11]=c&255; return a; };
  const cases=[
    ['grant',mk(0x80|0x00,0,[0x40,0x12,0x34,0x00,0x64,0x00,0xAB,0xCD]),{ch:0x1234,to:100,from:0xABCD,opts:0x40}],
    ['unit reg response',mk(0x2C,0,[0x08,0x30,0x12,0x34,0x56,0x00,0x00,0x07]),{}],
    ['rfss status',mk(0x3A,0,[0x01,0x00,0x31,0xAB,0x02,0x03,0x12,0x34,0x00,0x00].slice(0,8)),{}]];
  for(const [name,a,exp] of cases){
    ctx.tb=a;
    const d=ev('p25Tsbk({idens:{}},bitsMsb(tb))'), p=ev('hexParse("p25-tsbk",tb)'), v=p.vals;
    let agree=p.ok && v.op===d.f.op && v.mfid===d.f.mfid;
    for(const k of ['to','from','ch','opts','sysid','rfss','site','lra','sid']) if(d.f[k]!==undefined && v[k]!==undefined && d.f[k]!==v[k]) agree=false;
    ok('p25 tsbk '+name+': schema agrees with the decoder',agree && Object.entries(exp).every(([k,x])=>v[k]===x),JSON.stringify([d.f,v]));
  }
  ctx.lcb=Uint8Array.from([0,0,0x80,0,0x00,0x64,0x00,0x12,0x34]);
  const lc=ev('p25Lc(bitsMsb(lcb))'), lp=ev('hexParse("p25-lc",lcb)');
  ok('p25 lc: group call',lc.type==='group' && lc.to===lp.vals.to && lc.from===lp.vals.from && lp.vals.lcf===0 && lc.hexSchema==='p25-lc' && lc.hex==='000080000064001234',JSON.stringify([lc,lp.vals]));
  ctx.lcp=Uint8Array.from([3,0,0x40,0,0,5,0,0,6]);
  const lc3=ev('p25Lc(bitsMsb(lcp))'), lp3=ev('hexParse("p25-lc",lcp)');
  ok('p25 lc: private call',lc3.type==='private' && lc3.to===lp3.vals.to && lc3.from===lp3.vals.from && lp3.vals.svc===0x40,JSON.stringify([lc3,lp3.vals]));
  const hd=ev('hexParse("p25-hdu",hexFromHex("0102030405060708090aa0aaaa0123"))');
  ok('p25 hdu fields',hd.vals.mfid===0x0a && hd.vals.algid===0xa0 && hd.vals.kid===0xaaaa && hd.vals.tgid===0x123 && hd.fields.find(f=>f.n==='algid').text.startsWith('DVI-XL'),JSON.stringify(hd.vals));
}

// NXDN: сообщения слоя 3 от генератора ядра (nxdnVcall / nxdnBitsOf) — схема против nxdnL3 декодера
{
  const chk=(name,expr,keys)=>{
    ctx.nb=ev(`(()=>{ const b=${expr}; return b; })()`);
    ctx.nbytes=ev('bytesFromBits(nb.subarray(0,nb.length&~7))');
    const d=ev('nxdnL3(nb)'), p=ev('hexParse("nxdn-l3",nbytes)'), v=p.vals;
    ok('nxdn '+name+': schema agrees with the decoder',p.ok && v.type===d.type && keys.every(k=>k==='location' ? v[k]===parseInt(d[k],16) : v[k]===d[k]),JSON.stringify([d,v]));
  };
  chk('VCALL','nxdnVcall(1,1234,5678,4,3,2,9)',['from','to','ctype','opt','cipher','key']);
  chk('VCALL_ASSGN','nxdnBitsOf([[4,6,2],[0,8,8],[4,3,16],[0,5,19],[1234,16,24],[5678,16,40],[10,6,56],[321,10,62]],72)',['from','to','timer','channel']);
  chk('SITE_INFO','nxdnBitsOf([[0x18,6,2],[0x123456,24,8],[0xABCD,16,32],[0x1234,16,48],[0x654321,24,64],[0x112233,24,88],[7,8,112],[3,4,120],[100,10,124],[200,10,134]],144)',['location','cs','svc','rst','ca','version','adj','ch1','ch2']);
}

// TETRA: SYNC и SYSINFO от кодеров ядра (tetraSyncBits / tetraSysinfoBits) — схема против tetraSync / tetraSysinfo декодера
{
  ctx.sb=ev('tetraSyncBits({sys:1,cc:21,tn:3,fn:7,mn:42,sharing:2,mcc:262,mnc:1010,nbr:1,svc:2,late:1})');
  const hx=ev('tetraHexB(sb,0,60)'), d=ev('tetraSync(sb)'), p=ev(`hexParse("tetra-sync",hexFromHex("${hx}"))`), v=p.vals;
  ok('tetra sync: schema agrees with the decoder',v.cc===d.cc && v.tn+1===d.tn && v.fn===d.fn && v.mn===d.mn && v.mcc===d.mcc && v.mnc===d.mnc && v.late===d.late && v.svc===d.svc && hx.length===16,JSON.stringify([d,v,hx]));
  ctx.si=ev('tetraSysinfoBits({carrier:1500,band:4,off:1,duplex:0,reverse:0,ncs:1,txpwr:3,rxmin:5,access:7,timeout:9,cckValid:1,cck:4660,opt:2,la:1234,subscr:43690,serv:0xC00|0x0A0})');
  const hs=ev('tetraHexB(si,0,124)'), ds=ev('tetraSysinfo(si)'), ps=ev(`hexParse("tetra-sysinfo",hexFromHex("${hs}"))`), vs=ps.vals;
  ok('tetra sysinfo: schema agrees with the decoder',vs.carrier===ds.carrier && vs.band===ds.band && vs.off===ds.off && vs.la===ds.la && vs.subscr===ds.subscr && vs.serv===ds.serv && vs.cck===ds.cck && vs.access===ds.access && vs.timeout===ds.timeout,JSON.stringify([ds,vs]));
}

// DMR: сигнальный бёрст из байт (dmrSigBurst): декодер ядра возвращает те же байты, слот-тип и синхро на месте
{
  const lcb=[0,0,0, 0,0,100, 0,0x0c,0x8a];
  ctx.lcIn=Uint8Array.from(lcb);
  for(const [type,mask] of [['Voice LC header',0x96],['Terminator LC',0x99]]){
    ctx.sbt=type;
    const r=ev('dmrSigBurst(sbt,lcIn,5,"repeater (BS)")');
    ctx.sbits=r.bits;
    const lc=ev(`dmrLc(dmrBptcDec(dmrRaw196(sbits)),${mask})`), st=ev('dmrSlotType(sbits,1)');
    ok('dmr '+type+' burst: LC, colour code and type decode',!!lc && Array.from(lc).slice(0,9).join()===lcb.join() && st.cc===5 && st.dt===(type==='Voice LC header' ? 1 : 2) && r.dib.length===132,JSON.stringify([lc&&Array.from(lc),st]));
    ok('dmr '+type+' burst: schema reads the decoded LC',ev('hexParse("dmr-lc",dmrLc(dmrBptcDec(dmrRaw196(sbits)),'+mask+'))').vals.dst===100);
  }
  ctx.cs=Uint8Array.from([0xBD,0,0xC0,3,0,0x0f,0xa0,0,0x27,0x10]);
  const rc=ev('dmrSigBurst("CSBK",cs,1,"inbound (MS)")'); ctx.cbits=rc.bits;
  const dec=ev('dmrMasked(dmrBptcDec(dmrRaw196(cbits)),0xA5A5)');
  ok('dmr CSBK burst: CRC-16 and BPTC decode',!!dec && Array.from(dec).slice(0,10).join()===Array.from(ctx.cs).join() && ev('dmrSlotType(cbits,1)').dt===3,JSON.stringify(dec&&Array.from(dec)));
  const hb=ev('hexBuild("dmr-csbk",{lb:1,pf:0,csbko:61,fid:0,data:"c003000fa0002710"})');
  ok('dmr-csbk schema: the CRC (with the 0xA5A5 mask) equals the encoder input CRC',hb.bytes.length===12 && hb.bytes.slice(0,10).join()===Array.from(ctx.cs).join() && ((hb.bytes[10]<<8)|hb.bytes[11])===(ev('dmrCrc16(cs,10)')^0xA5A5),Array.from(hb.bytes).map(x=>x.toString(16)).join(' '));
  ctx.csb=hb.bytes;
  ok('dmr-csbk schema parses its own bytes clean',ev('hexParse("dmr-csbk",csb)').ok);
  const pi=ev('hexBuild("dmr-pi",{alg:0x21,fid:0,key:5,mi:"01020304",dst:100})');
  ctx.pib=pi.bytes;
  ok('dmr-pi schema: CRC with the 0x6969 mask',((pi.bytes[10]<<8)|pi.bytes[11])===(ev('dmrCrc16(pib,10)')^0x6969) && ev('hexParse("dmr-pi",pib)').ok,Array.from(pi.bytes).map(x=>x.toString(16)).join(' ')+' '+JSON.stringify(pi.warn));
  let thr=false; try{ ev('dmrSigBurst("CSBK",Uint8Array.from([1,2,3]),1)'); }catch(e){ thr=true; }
  ok('dmr burst rejects short input',thr);
}
console.log(bad ? bad+' failed' : 'all ok');
process.exit(bad?1:0);
