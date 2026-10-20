// Байты и файлы: node tools/test-bytes.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Uint8ClampedArray,Uint32Array,DataView,TextEncoder,TextDecoder,btoa,atob,Array,Map,Error,String,Date});
vm.runInContext(fs.readFileSync(path.join(root,'modules/bytes-kernels.js'),'utf8')+';this.B={binCrc32,binToText,binFromText,binLineToFrame,binPack,binParse,BinStream,BinAssembler,binCat,binSniff,BinJpegSplitter,binRawToRGBA};',ctx);
const B=ctx.B;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const same=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);
let sd=7; const rnd=()=>{ sd^=sd<<13; sd^=sd>>>17; sd^=sd<<5; return (sd>>>0)/4294967296; };
const rand=n=>Uint8Array.from({length:n},()=>rnd()*256|0);

ok('crc32 check value',B.binCrc32(new TextEncoder().encode('123456789'))===0xCBF43926);
const data=rand(1000);
for(const e of ['base64','base64url','hex','latin1']) ok('text round trip '+e,same(B.binFromText(B.binToText(data,e),e),data));
ok('utf8 round trip',B.binToText(B.binFromText('Привет, мир','utf8'),'utf8')==='Привет, мир');

const fr=B.binPack(data,{pay:100,name:'файл.bin',mime:'application/octet-stream',xid:77});
ok('frame count',fr.length===11,String(fr.length));
ok('every frame parses',fr.every(f=>B.binParse(f)));
const bump=fr[3].slice(); bump[20]^=1;
ok('damaged frame rejected',B.binParse(bump)===null);

// кадр за кадром, в произвольном порядке, с повторами
const asm=new B.BinAssembler(); let res=null, n=0;
const order=[...fr, ...fr.slice(0,4)].sort(()=>rnd()-.5);
for(const f of order){ const r=asm.push(B.binParse(f)); if(r){ res=r; n++; } }
ok('assembled once',n===1 && same(res.data,data) && res.name==='файл.bin' && res.mime==='application/octet-stream');
ok('repeat of a finished transfer is ignored',asm.push(B.binParse(fr[2]))===null && asm.files===1);

// карусель: приём начинается с середины, потеряны кадры, второй круг добирает
const asm2=new B.BinAssembler(); let got=null;
for(let round=0;round<2;round++) for(let i=0;i<fr.length;i++){
  if(round===0 && (i<5 || i===8)) continue;
  const r=asm2.push(B.binParse(fr[i])); if(r) got=r;
}
ok('carousel fills the gaps',got && same(got.data,data));

// поток: мусор, нарезка по 7 байт, порча одного кадра
const stream=B.binCat(rand(33),...fr.slice(0,3),bump,...fr.slice(4),rand(5));
const st=new B.BinStream(), asm3=new B.BinAssembler(); let g3=null, cnt=0;
for(let i=0;i<stream.length;i+=7) for(const p of st.push(stream.subarray(i,i+7))){ cnt++; const r=asm3.push(p); if(r) g3=r; }
ok('stream resync past garbage and a damaged frame',cnt===fr.length-1 && g3===null && st.bad>=1,cnt+' frames, bad '+st.bad);
const st2=new B.BinStream(); let g4=null; const asm4=new B.BinAssembler();
for(let rep=0;rep<2;rep++) for(const p of st2.push(B.binCat(...fr))){ const r=asm4.push(p); if(r) g4=r; }
ok('stream complete',g4 && same(g4.data,data));

// строки: hex и base64 распознаются сами
const line=B.binToText(fr[0],'hex'), line2=B.binToText(fr[1],'base64');
ok('line decode hex+base64',B.binParse(B.binLineToFrame(line)) && B.binParse(B.binLineToFrame(line2)));

// пустой файл и один байт
for(const d of [new Uint8Array(0),Uint8Array.of(42)]){
  const a=new B.BinAssembler(); let r=null; for(const f of B.binPack(d,{pay:64,xid:5})) r=a.push(B.binParse(f))||r;
  ok('size '+d.length,r && same(r.data,d));
}
// две передачи вперемешку
const d1=rand(300), d2=rand(500), f1=B.binPack(d1,{pay:50,xid:1}), f2=B.binPack(d2,{pay:50,xid:2});
const a5=new B.BinAssembler(), outs=[];
for(let i=0;i<Math.max(f1.length,f2.length);i++) for(const f of [f1[i],f2[i]]) if(f){ const r=a5.push(B.binParse(f)); if(r) outs.push(r); }
ok('two transfers interleaved',outs.length===2 && same(outs.find(o=>o.xid===1).data,d1) && same(outs.find(o=>o.xid===2).data,d2));
// повреждённое содержимое при верной CRC кадров: подмена тела
const f6=B.binPack(data,{pay:100,xid:9}), a6=new B.BinAssembler(); let r6=null;
f6[4]=B.binPack(rand(100),{pay:100,xid:9})[1];                 // кадр с другим телом, но верным CRC кадра
for(const f of f6) r6=a6.push(B.binParse(f))||r6;
ok('wrong file CRC rejected',r6===null && a6.badFile===1);
// ---- картинки ----
const sig=(...a)=>Uint8Array.from(a);
ok('sniff jpeg/png/gif',B.binSniff(sig(0xFF,0xD8,0xFF,0xE0))==='jpeg' && B.binSniff(sig(0x89,0x50,0x4E,0x47,13,10,26,10))==='png' && B.binSniff(new TextEncoder().encode('GIF89a'))==='gif');
ok('sniff webp/bmp',B.binSniff(new TextEncoder().encode('RIFF\0\0\0\0WEBP'))==='webp' && B.binSniff(new TextEncoder().encode('BM\0\0'))==='bmp');
ok('sniff not an image',B.binSniff(sig(1,2,3,4,5,6,7,8,9,10,11,12))==='');

// синтетический JPEG: EXIF-миниатюра внутри APP1, DQT, SOS с FF00 и RST в данных
const seg=(m,body)=>[0xFF,m,(body.length+2)>>8,(body.length+2)&255,...body];
const thumb=[0xFF,0xD8,0xFF,0xDB,0,4,1,2,0xFF,0xD9];
function jpg(k){
  const ent=[]; for(let i=0;i<200+k;i++){ const v=rnd()*256|0; ent.push(v); if(v===0xFF) ent.push(0); }
  ent.push(0xFF,0xD0,5,6,0xFF);
  return Uint8Array.from([0xFF,0xD8,...seg(0xE1,[69,120,105,102,0,0,...thumb]),...seg(0xDB,[0,1,2,3]),...seg(0xDA,[1,1,0,0,63,0]),...ent,0xFF,0xD9]);
}
const j=[jpg(0),jpg(50),jpg(300)];
const mjStream=B.binCat(sig(1,2,3,0xFF),j[0],sig(9,9),j[1],j[2]);
{ const sp=new B.BinJpegSplitter(); const got=[];
  for(let i=0;i<mjStream.length;i+=7) got.push(...sp.push(mjStream.subarray(i,i+7)));
  ok('mjpeg: 3 frames from 7-byte chunks',got.length===3 && got.every((g,i)=>same(g,j[i])),String(got.length));
  ok('mjpeg: junk counted',sp.junk>=6,String(sp.junk)); }
{ const sp=new B.BinJpegSplitter(); const got=sp.push(mjStream);
  ok('mjpeg: one big chunk',got.length===3 && same(got[1],j[1])); }
{ const sp=new B.BinJpegSplitter(); const cut=j[0].slice(0,j[0].length-1);
  const got=sp.push(B.binCat(cut,j[1],j[2]));
  ok('mjpeg: truncated frame does not kill the mjStream',got.length>=2 && same(got[got.length-1],j[2]) && got.some(g=>same(g,j[1])),String(got.length)); }
{ const sp=new B.BinJpegSplitter(); sp.push(j[0].slice(0,40));
  ok('mjpeg: partial frame is held back',sp.frames===0 && sp.push(j[0].slice(40)).length===1); }

const px=B.binRawToRGBA(sig(0,128,255),3,1,'gray8');
ok('raw gray8',px.length===12 && px[0]===0 && px[4]===128 && px[8]===255 && px[3]===255);
const p5=B.binRawToRGBA(sig(0x1F,0x00, 0xE0,0x07, 0x00,0xF8),3,1,'rgb565');
ok('raw rgb565',p5[0]===0&&p5[2]===255 && p5[5]===255&&p5[4]===0 && p5[8]===255&&p5[10]===0);
const p8=B.binRawToRGBA(sig(1,2,3,4,5,6),2,1,'rgb888');
ok('raw rgb888',p8[0]===1&&p8[2]===3&&p8[4]===4&&p8[6]===6&&p8[7]===255);

console.log(bad ? bad+' failed' : 'all passed'); process.exit(bad ? 1 : 0);
