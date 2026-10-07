// Проверка разбора Open Drone ID: node tools/test-odid.mjs
// Векторы собраны по раскладке ASTM F3411 (см. odid-kernels.js), не сняты с реального борта.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'modules/odid-kernels.js'),'utf8')+';this.odidParse=odidParse;this.odidLine=odidLine;this.odidHex=odidHex;',ctx);
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const w32=(b,o,v)=>{ b[o]=v&255; b[o+1]=(v>>8)&255; b[o+2]=(v>>16)&255; b[o+3]=(v>>24)&255; };
const w16=(b,o,v)=>{ b[o]=v&255; b[o+1]=v>>8; };
const str=(b,o,s)=>{ for(let i=0;i<s.length;i++) b[o+i]=s.charCodeAt(i); };
const basic=new Uint8Array(25); basic[0]=0x02; basic[1]=0x12; str(basic,2,'1581F4YRW6C4N0000000');
const loc=new Uint8Array(25); loc[0]=0x12; loc[1]=0x20|0x02; loc[2]=45; loc[3]=40; loc[4]=0xFE;
w32(loc,5,Math.round(55.7558*1e7)); w32(loc,9,Math.round(37.6173*1e7));
w16(loc,13,2*(150+1000)); w16(loc,15,2*(200+1000)); w16(loc,17,2*(50+1000)); w16(loc,21,12345);
const sys=new Uint8Array(25); sys[0]=0x42; sys[1]=0x00; w32(sys,2,Math.round(55.75*1e7)); w32(sys,6,Math.round(37.6*1e7)); sys[12]=5; w32(sys,20,1000);
const op=new Uint8Array(25); op[0]=0x52; str(op,2,'RUS-OP-12345');
const sid=new Uint8Array(25); sid[0]=0x32; str(sid,2,'Race heat 3');
const pack=new Uint8Array(3+25*5); pack[0]=0xF2; pack[1]=25; pack[2]=5;
[basic,loc,sys,op,sid].forEach((m,i)=>pack.set(m,3+i*25));
const hex=b=>[...b].map(x=>x.toString(16).padStart(2,'0')).join('');

let m=ctx.odidParse(basic);
eq('basic', [m[0].kind,m[0].id,m[0].uaName,m[0].idTypeName], ['basic','1581F4YRW6C4N0000000','multirotor','serial']);
m=ctx.odidParse(loc)[0];
eq('location', [m.statusName,m.dir,m.speed,m.vspeed,m.lat.toFixed(4),m.lon.toFixed(4),m.altGeo,m.altBaro,m.height,m.ts],
  ['airborne',225,10,-1,'55.7558','37.6173',200,150,50,1234.5]);
eq('speed multiplier', ctx.odidParse(Object.assign(new Uint8Array(loc),{3:100,1:0x23}))[0].speed, 100*0.75+255*0.25);
eq('unknown speed', ctx.odidParse(Object.assign(new Uint8Array(loc),{3:255}))[0].speed, null);
eq('no position', (()=>{ const l=new Uint8Array(loc); w32(l,5,0); w32(l,9,0); return ctx.odidParse(l)[0].lat; })(), null);
eq('pack', ctx.odidParse(pack).map(x=>x.kind), ['basic','location','system','operator','selfid']);
eq('pack with counter', ctx.odidParse(new Uint8Array([7,...pack])).length, 5);
eq('single with counter', ctx.odidParse(new Uint8Array([9,...loc]))[0].kind, 'location');
m=ctx.odidParse(pack);
eq('system', [m[2].opLat.toFixed(2),m[2].opLon.toFixed(2),m[2].areaRadius,m[2].time], ['55.75','37.60',50,(1546300800+1000)*1000]);
eq('operator id / self id', [m[3].id,m[4].text], ['RUS-OP-12345','Race heat 3']);
eq('serial line', (()=>{ const r=ctx.odidLine('ODID,wifi,-61,aa:bb:cc:dd:ee:ff,'+hex(pack)); return [r.transport,r.rssi,r.mac,r.msgs.length]; })(), ['wifi',-61,'aa:bb:cc:dd:ee:ff',5]);
eq('bare hex line', ctx.odidLine(hex(loc)).msgs.length, 1);
eq('junk', [ctx.odidLine('boot: rst 0x1'), ctx.odidParse(new Uint8Array(30)).length], [null,0]);
process.exit(bad?1:0);
