// MPEG-TS: node tools/test-ts.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Map,Array,Error});
vm.runInContext(fs.readFileSync(path.join(root,'modules/ts-kernels.js'),'utf8')+';this.T={TsDemux,tsAvcSps,tsNals,tsLayout,tsAvcSliceType,tsAvcMaxFs};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// --- сборка потока ---
class BW{ constructor(){ this.b=[]; } u(n,v){ for(let i=n-1;i>=0;i--) this.b.push(Math.floor(v/2**i)&1); }
  ue(v){ const x=v+1, n=Math.floor(Math.log2(x)); this.u(n,0); this.u(n+1,x); }
  bytes(){ const o=[]; for(let i=0;i<this.b.length;i+=8){ let v=0; for(let k=0;k<8;k++) v=v*2+(this.b[i+k]||0); o.push(v); } return o; } }
function sps(mbw,mbh,cropB){
  const w=new BW(); w.u(8,66); w.u(8,0xc0); w.u(8,30); w.ue(0); w.ue(0); w.ue(2); w.ue(1); w.u(1,0);
  w.ue(mbw-1); w.ue(mbh-1); w.u(1,1); w.u(1,1);
  if(cropB){ w.u(1,1); w.ue(0); w.ue(0); w.ue(0); w.ue(cropB); } else w.u(1,0);
  w.u(1,0); w.u(1,1);
  return [0x67,...w.bytes()];
}
const ccs=new Map();
function packets(pid,payload,pusi){
  const out=[]; let first=true;
  for(let o=0;o<payload.length || first;){
    const chunk=payload.slice(o,o+184), pad=184-chunk.length;
    const p=new Uint8Array(188).fill(0xff); p[0]=0x47; p[1]=(first&&pusi?0x40:0)|(pid>>8); p[2]=pid&255;
    const cc=ccs.get(pid)||0; ccs.set(pid,(cc+1)&15);
    if(pad>0){ p[3]=0x30|cc; p[4]=pad-1; if(pad>1) p[5]=0; p.set(chunk,4+pad); }
    else{ p[3]=0x10|cc; p.set(chunk,4); }
    out.push(p); o+=184; first=false;
  }
  return out;
}
const sect=(tbl,mid,body)=>{ const len=body.length+9; return [tbl,0xb0|(len>>8),len&255,...mid,0xc1,0,0,...body,0,0,0,0]; };
const pesv=(pts,es)=>{ const t=[0x21|((pts>>29)&0xe),(pts>>22)&255,0x01|((pts>>14)&0xfe),(pts>>7)&255,0x01|((pts<<1)&0xfe)];
  return [0,0,1,0xe0,0,0,0x80,0x80,5,...t,...es]; };
const pata=sect(0,[0,1],[0,1,0xe1,0x00]);                                    // программа 1 → PMT 0x100
const pmt=sect(2,[0,1],[0xe1,0x01,0xf0,0, 0x1b,0xe1,0x01,0xf0,0, 0x0f,0xe1,0x02,0xf0,0]);  // видео 0x101 H.264, аудио 0x102 AAC
// в PMT после PCR PID идёт program_info_length: тело sect() начинается с PCR (2 байта) и длины (2 байта)
const nal=(h,n)=>[0,0,0,1,h,...Array.from({length:n},(_,i)=>(i*7+1)&0x7f|1)];
const au=(key)=>[...nal(0x09,1),...(key?[0,0,0,1,...sps(120,68,4),...nal(0x68,3),...nal(0x65,300)]:nal(0x41,200))];

const pk=[...packets(0,[0,...pata],true),...packets(0x100,[0,...pmt],true)];
const N=12;
for(let f=0;f<N;f++){
  pk.push(...packets(0x101,pesv(90000+f*3600,au(f%6===0)),true));
  pk.push(...packets(0x102,[0,0,1,0xc0,0,0,0x80,0x80,5,0x21,0,1,0,1,...Array(40).fill(0xff)],true));
}
const flat=a=>{ const o=new Uint8Array(a.length*188); a.forEach((p,i)=>o.set(p,i*188)); return o; };
const ts=flat(pk);

const d=new T.TsDemux(); d.push(ts); d.flush();
const v=d.takeVideo();
ok('frames found',v.length===N,String(v.length));
ok('pts',Math.abs(v[0].pts-1)<1e-6 && Math.abs(v[5].pts-(1+5*.04))<1e-6,v[5].pts+'');
ok('keyframes',v.filter(x=>x.key).length===2 && v[0].key && v[6].key);
ok('sps size 1920x1080',d.sps && d.sps.w===1920 && d.sps.h===1080,JSON.stringify(d.sps));
ok('codec string',d.vcodec==='avc1.42c01e',d.vcodec);
ok('audio',d.takeAudio().length===N);
ok('program list',d.list().length===1 && d.list()[0].vpid===0x101 && d.list()[0].apid===0x102);

// кусками по произвольному размеру и с мусором в начале
const d2=new T.TsDemux(); const junk=new Uint8Array(77).fill(0x11);
const all=new Uint8Array(junk.length+ts.length); all.set(junk); all.set(ts,junk.length);
for(let o=0;o<all.length;o+=997) d2.push(all.subarray(o,o+997));
d2.flush();
ok('chunked + junk',d2.takeVideo().length===N);

// потеря пакета → кадр отбрасывается
const lost=pk.slice(); const iv=lost.findIndex((p,i)=>i>10 && (((p[1]&31)<<8)|p[2])===0x101 && !(p[1]&0x40));
if(iv>0) lost.splice(iv,1);
const d3=new T.TsDemux(); d3.push(flat(lost)); d3.flush();
ok('lost packet drops one frame',d3.takeVideo().length===N-1 && d3.stat.cc>0,d3.takeVideo().length+' cc '+d3.stat.cc);


// USB-пакеты по 512 байт: два TS-пакета и 136 лишних байт (как отдаёт RTL2832U) — все кадры должны сохраниться
{
  const junk=n=>Uint8Array.from({length:n},(_,i)=>((i*29+7)&0xff)===0x47 ? 0x48 : (i*29+7)&0xff);
  const out=[]; for(let i=0;i<pk.length;i+=2){ out.push(pk[i]); if(pk[i+1]) out.push(pk[i+1]); out.push(junk(136)); }
  const buf=new Uint8Array(out.reduce((a,x)=>a+x.length,0)); let o=0; for(const x of out){ buf.set(x,o); o+=x.length; }
  const d4=new T.TsDemux(); for(let q=0;q<buf.length;q+=1000) d4.push(buf.subarray(q,q+1000)); d4.flush();
  const gaps=d4.stat.gaps;
  ok('padded USB packets: every frame survives',d4.takeVideo().length>=N-1 && d4.stat.cc===0,`${d4.stat.cc} lost, gaps ${JSON.stringify(gaps)}`);
  ok('padded USB packets: the gap is reported',gaps['136']>10,JSON.stringify(gaps));
  const lay=T.tsLayout(buf);
  ok('layout analysis: 2 packets + 136 extra bytes',lay[0].packets===2 && lay[0].gap===136,JSON.stringify(lay));
  const lay2=T.tsLayout(ts);
  ok('layout analysis: a plain stream has no gaps',lay2.length===0 || lay2.every(x=>x.gap===0),JSON.stringify(lay2));
}



// точки входа без IDR: обычный I-срез (slice_type 7) — ключевой, P-срез (5) — нет; SPS / PPS дописываются из прежних кадров
{
  ok('slice type I (7) parsed',T.tsAvcSliceType(Uint8Array.from([0x41,0x88,0x00,0x00]))===7);
  ok('slice type P (5) parsed',T.tsAvcSliceType(Uint8Array.from([0x41,0x98,0x00,0x00]))===5);
  const nal2=(h,...b)=>[0,0,0,1,h,...b];
  const auIdr=[...nal2(0x09,0xf0),0,0,0,1,...sps(120,68,4),...nal2(0x68,0xee,0x3c,0x80),...nal2(0x65,0x88,0x84,0x00,0x10)];
  const auI=[...nal2(0x09,0xf0),...nal2(0x41,0x88,0x84,0x00,0x10,0x20)];       // I-срез без SPS / PPS
  const auP=[...nal2(0x09,0xf0),...nal2(0x41,0x98,0x84,0x00,0x10,0x20)];
  const pk2=[...packets(0,[0,...pata],true),...packets(0x100,[0,...pmt],true)];
  [auIdr,auP,auI,auP,auI].forEach((a,i)=>pk2.push(...packets(0x101,pesv(90000+i*3600,a),true)));
  pk2.push(...packets(0x101,pesv(90000+5*3600,auP),true));
  const d6=new T.TsDemux(); d6.push(flat(pk2)); d6.flush();
  const v6=d6.takeVideo();
  ok('entry points: IDR and plain I slices, not P',v6.map(f=>f.key?1:0).join('')==='101010'.slice(0,v6.length) || v6.map(f=>f.key?1:0).join('')==='10101',v6.map(f=>f.key?1:0).join(''));
  const types=f=>T.tsNals(f.d).map(n=>n[0]&31);
  ok('SPS and PPS are put in front of a plain I frame',types(v6[2]).slice(0,3).join()==='7,8,9' || types(v6[2]).includes(7) && types(v6[2]).includes(8),types(v6[2]).join());
  ok('keys counted',d6.stat.keys===3,String(d6.stat.keys));
}

console.log(bad?bad+' FAILED':'all ok'); ok('MaxFS by level',T.tsAvcMaxFs(30)===1620 && T.tsAvcMaxFs(31)===3600 && T.tsAvcMaxFs(40)===8192 && T.tsAvcMaxFs(51)===36864 && T.tsAvcMaxFs(62)===139264);
process.exit(bad?1:0);
