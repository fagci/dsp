// Ядро фото: node tools/test-photo.mjs
// Идентификаторы, размер, EXIF из синтетических JPEG (little- и big-endian).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Date,String,Number,isFinite,DataView,Object,Map,parseInt});
vm.runInContext(fs.readFileSync(path.join(root,'modules/photo-kernels.js'),'utf8')+';this.K={phNewId,phIds,phJoin,phFit,phExif};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

ok('id looks like an id and differs',/^ph-[a-z0-9]+$/.test(K.phNewId()) && K.phNewId()!==K.phNewId());
ok('ids: spaces, commas, junk',K.phIds('ph-a1 ph-b2, ph-c3;xx foo.jpg ph-')+''==='ph-a1,ph-b2,ph-c3');
ok('ids: empty and numbers',K.phIds('').length===0 && K.phIds(null).length===0 && K.phIds(12).length===0);
ok('join',K.phJoin(['ph-a','ph-b'])==='ph-a ph-b');
ok('fit: big photo shrinks keeping the aspect',K.phFit(4000,3000)+''==='1600,1200' && K.phFit(3000,4000)+''==='1200,1600');
ok('fit: small photo stays',K.phFit(800,600)+''==='800,600' && K.phFit(1,1)+''==='1,1');

// синтетический JPEG с EXIF
function build(le,{lat,lon,alt,latRef='N',lonRef='E',altRef=0,date}){
  const parts=[]; const W16=v=>{ const b=Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; }, W32=v=>{ const b=Buffer.alloc(4); le ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return b; };
  const rat=(n,d)=>Buffer.concat([W32(n),W32(d)]);
  const dms=x=>{ const d=Math.floor(x), m=Math.floor((x-d)*60), s=Math.round(((x-d)*60-m)*60*100); return Buffer.concat([rat(d,1),rat(m,1),rat(s,100)]); };
  // раскладка: TIFF header (8) · IFD0 (3 записи) · Exif IFD (1) · GPS IFD (6) · данные
  const hdr=Buffer.concat([Buffer.from(le?'II':'MM'),W16(42),W32(8)]);
  const ifd0Len=2+3*12+4, exifOff=8+ifd0Len, exifLen=2+1*12+4, gpsOff=exifOff+exifLen, gpsLen=2+6*12+4, dataOff=gpsOff+gpsLen;
  const entry=(tag,type,cnt,val)=>Buffer.concat([W16(tag),W16(type),W32(cnt),val]);
  const dateStr=Buffer.from(date+'\0'), data=[];
  let dp=dataOff; const put=b=>{ const off=dp; data.push(b); dp+=b.length; return off; };
  const offDate=put(dateStr), offLat=put(dms(lat)), offLon=put(dms(lon)), offAlt=put(rat(Math.round(alt*10),10));
  const ifd0=Buffer.concat([W16(3),entry(0x0112,3,1,Buffer.concat([W16(6),W16(0)])),entry(0x8769,4,1,W32(exifOff)),entry(0x8825,4,1,W32(gpsOff)),W32(0)]);
  const exif=Buffer.concat([W16(1),entry(0x9003,2,dateStr.length,W32(offDate)),W32(0)]);
  const ref=c=>Buffer.concat([Buffer.from(c+'\0'),Buffer.alloc(2)]);
  const gps=Buffer.concat([W16(6),entry(1,2,2,ref(latRef)),entry(2,5,3,W32(offLat)),entry(3,2,2,ref(lonRef)),entry(4,5,3,W32(offLon)),entry(5,1,1,Buffer.from([altRef,0,0,0])),entry(6,5,1,W32(offAlt)),W32(0)]);
  const tiff=Buffer.concat([hdr,ifd0,exif,gps,...data]);
  const app1=Buffer.concat([Buffer.from([0xFF,0xE1]),Buffer.from([(tiff.length+8)>>8,(tiff.length+8)&255]),Buffer.from('Exif\0\0'),tiff]);
  const jpg=Buffer.concat([Buffer.from([0xFF,0xD8]),app1,Buffer.from([0xFF,0xDA,0,2,0xFF,0xD9])]);
  return jpg.buffer.slice(jpg.byteOffset,jpg.byteOffset+jpg.length);
}
for(const le of [true,false]){
  const e=K.phExif(build(le,{lat:55.0125,lon:82.6501,alt:123.4,date:'2026:10:07 12:34:56'}));
  const nm=le?'little-endian':'big-endian';
  ok(nm+': found',!!e);
  near(nm+': latitude',e.lat,55.0125,.0003); near(nm+': longitude',e.lon,82.6501,.0003); near(nm+': altitude',e.alt,123.4,.01);
  ok(nm+': time',e.t===new Date(2026,9,7,12,34,56).getTime()); ok(nm+': orientation',e.orient===6);
}
const s=K.phExif(build(true,{lat:33.9,lon:70.7,alt:50,latRef:'S',lonRef:'W',altRef:1,date:'2020:01:02 03:04:05'}));
ok('southern / western hemisphere and below sea level',s.lat<0 && s.lon<0 && s.alt<0 && Math.abs(s.lat+33.9)<.001 && Math.abs(s.lon+70.7)<.001,JSON.stringify(s));
ok('not a JPEG',K.phExif(new ArrayBuffer(20))===null && K.phExif(new Uint8Array([1,2,3]).buffer)===null);
ok('JPEG without EXIF',K.phExif(new Uint8Array([0xFF,0xD8,0xFF,0xDA,0,2,0xFF,0xD9,0,0,0,0]).buffer)===null);
const trunc=build(true,{lat:1,lon:2,alt:3,date:'2020:01:02 03:04:05'}).slice(0,60);
ok('a truncated file does not throw',(()=>{ try{ K.phExif(trunc); return true; }catch(e){ return false; } })());
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
