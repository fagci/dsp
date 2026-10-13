// Packet Link: кадровщики и запись rec: node tools/test-link.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,TextEncoder,TextDecoder,Array,Map,Set,Error,String,Number,BigInt,Object,Date,JSON,isNaN,parseInt});
for(const f of ['hex-kernels.js','pcap-kernels.js','link-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root,'modules',f),'utf8'),ctx,{filename:f});
vm.runInContext('this.K={lkFramer,lkRec,lkLineHex,lkCobsDecode,pcapWrite,LK_FRAMES,hexToHex}',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const U=a=>Uint8Array.from(a), hx=u=>K.hexToHex(u), enc=s=>new TextEncoder().encode(s);
const run=(kind,chunks,max)=>{ const f=K.lkFramer(kind,max); return chunks.flatMap(c=>f.push(c)); };

ok('every framing is known',K.LK_FRAMES.every(k=>run(k,[]).length===0));
ok('message: one chunk — one packet',run('message',[U([1,2,3]),U([]),U([4])]).map(p=>hx(p.data)).join()==='010203,04');

let r=run('hex lines',[enc('WIFI,6,-60,80000000ffffffffffff\n'),enc('ab cd:ef-01 23\r\ndata: 0102030405060708\nnothing here\n')]);
ok('hex lines: wifi sniffer line, prefix kept',r[0] && hx(r[0].data)==='80000000ffffffffffff' && r[0].prefix==='WIFI,6,-60');
ok('hex lines: separators ok',r[1] && hx(r[1].data)==='abcdef0123');
ok('hex lines: SSE data: prefix, garbage line skipped',r.length===3 && hx(r[2].data)==='0102030405060708');
r=run('hex lines',[enc('0102'),enc('030405\n')]);
ok('hex lines: a line split across chunks',r.length===1 && hx(r[0].data)==='0102030405');

r=run('json lines',[enc('{"rssi":-50,"hex":"deadbeef"}\n{"a":1}\n[1]\nbad\n')]);
ok('json lines: rec fields and hex',r.length===2 && r[0].rec.rssi===-50 && hx(r[0].data)==='deadbeef' && r[1].data.length===0);
r=run('text lines',[enc('hello\nworld\n')]);
ok('text lines',r.length===2 && r[1].rec.line==='world');

r=run('slip',[U([0xC0,1,0xDB,0xDC,2,0xC0,0xC0,3,0xDB,0xDD,0xC0])]);
ok('slip: escapes and empty frames',r.length===2 && hx(r[0].data)==='01c002' && hx(r[1].data)==='03db');
r=run('kiss',[U([0xC0,0x00,0x82,0xA0,0xC0,0xC0,0x01,0x99,0xC0])]);
ok('kiss: data frames only, port from the command byte',r.length===1 && hx(r[0].data)==='82a0' && r[0].rec.port===0);
r=run('kiss',[U([0xC0,0x10,0x41,0xC0])]);
ok('kiss: port 1',r.length===1 && r[0].rec.port===1);
r=run('hdlc',[U([0x7E,1,0x7D,0x5E,2,0x7E,0x7E,3,0x7E])]);
ok('hdlc: byte stuffing',r.length===2 && hx(r[0].data)==='017e02' && hx(r[1].data)==='03');

ok('cobs decode',hx(K.lkCobsDecode(U([3,0x11,0x22,2,0x33])))==='11220033');
r=run('cobs',[U([3,0x11,0x22,2,0x33,0,1,1,0])]);
ok('cobs: frames split by zero',r.length===2 && hx(r[0].data)==='11220033' && hx(r[1].data)==='00');
ok('cobs: broken block dropped',run('cobs',[U([9,1,2,0])]).length===0);

r=run('len8',[U([2,0xAA,0xBB,1]),U([0xCC,0,3,1,2,3])]);
ok('len8: across chunks, zero length skipped',r.map(p=>hx(p.data)).join()==='aabb,cc,010203');
r=run('len16be',[U([0,2,9,8,0,1,7])]);
ok('len16be',r.map(p=>hx(p.data)).join()==='0908,07');
r=run('len16le',[U([2,0,9,8])]);
ok('len16le',r.map(p=>hx(p.data)).join()==='0908');
r=run('len16be',[U([0xFF,0xFF,0,1,5])],100);
ok('length: absurd value — resync byte by byte',r.length===1 && hx(r[0].data)==='05');

const pk=K.pcapWrite([{t:1700000000123,data:U([1,2,3,4])},{t:1700000001000,data:U([5,6])}],105);
let f=K.lkFramer('pcap'), got=[];
for(let i=0;i<pk.length;i+=7) got.push(...f.push(pk.slice(i,i+7)));            // кусками по 7 байт
ok('pcap stream: split anywhere',got.length===2 && hx(got[0].data)==='01020304' && hx(got[1].data)==='0506');
ok('pcap stream: time and link type',Math.abs(got[0].t-1700000000123)<2 && got[0].link===105);
ok('pcap stream: not a pcap — dropped',K.lkFramer('pcap').push(U(new Array(40).fill(7))).length===0);

let rec=K.lkRec(got[0],{src:'cap',seq:3,schema:'auto'});
ok('rec: hex, schema from the link type, text',rec.hex==='01020304' && rec.hexSchema==='wifi' && rec.src==='cap' && rec.n===3 && /^#3 4 B/.test(rec.text));
rec=K.lkRec({data:U([1,2,3,4,5,6,7,8]),prefix:'WIFI,6',rec:{rssi:-40,len:99}},{src:'x',seq:1,schema:'eth',now:1700000000000});
ok('rec: schema param, prefix, JSON fields do not override service ones',rec.hexSchema==='eth' && rec.prefix==='WIFI,6' && rec.rssi===-40 && rec.len===8 && rec.time==='2023-11-14T22:13:20.000Z');
rec=K.lkRec({data:U([]),rec:{t:1700000005000,a:1}},{src:'x',seq:2,now:1});
ok('rec: JSON t is used; no hex for an empty packet',rec.t===1700000005000 && rec.hex===undefined && rec.a===1);

if(bad){ console.log(bad,'failed'); process.exit(1); } console.log('all ok');
