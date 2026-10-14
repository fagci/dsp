// MPEG-2 video decoder (vendor/mpeg2.wasm) against ffmpeg: node tools/test-mpeg2.mjs [keep]
// Needs ffmpeg with the mpeg2video encoder. Streams are made on the fly, decoded by ffmpeg (reference) and by the wasm module;
// the pictures are compared as RGBA made with the same integer formula.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const wasm=fs.readFileSync(path.join(root,'vendor/mpeg2.wasm'));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'m2-'));
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

// ES → access units (a picture with the headers before it)
function split(es){
  const au=[]; let start=0, seenSlice=false;
  for(let i=0;i+3<es.length;i++){
    if(es[i]===0 && es[i+1]===0 && es[i+2]===1){
      const c=es[i+3];
      if(c>=1 && c<=0xaf) seenSlice=true;
      else if(seenSlice && (c===0xb3 || c===0xb8 || c===0)){ au.push(es.subarray(start,i)); start=i; seenSlice=false; }
    }
  }
  au.push(es.subarray(start)); return au;
}
async function decode(es){
  const {instance}=await WebAssembly.instantiate(wasm,{});
  const x=instance.exports; const frames=[];
  const take=n=>{ for(let i=0;i<n;i++){ const w=x.m2_w(), h=x.m2_h();
    frames.push({pts:x.m2_pts(i), d:new Uint8Array(x.memory.buffer,x.m2_frame(i),w*h*4).slice()}); } };
  let t=0;
  for(const a of split(es)){ new Uint8Array(x.memory.buffer,x.m2_in(),a.length).set(a); take(x.m2_decode(a.length,t/25)); t++; }
  take(x.m2_flush());
  return {frames, w:x.m2_w(), h:x.m2_h(), err:x.m2_err(), bad:x.m2_bad()};
}
// the same conversion as the module: BT.601 limited, nearest chroma
function rgba(yuv,w,h,f){
  const fs_=w*h*3/2, o=new Uint8Array(w*h*4), Y=f*fs_, U=Y+w*h, V=U+w*h/4; let k=0;
  const cl=v=>v<0?0:v>255?255:v;
  const m709=h>=720, cr=m709?459:409, gu=m709?55:100, gv=m709?136:208, cb=m709?541:516;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const yy=298*(yuv[Y+y*w+x]-16), u=yuv[U+(y>>1)*(w>>1)+(x>>1)]-128, v=yuv[V+(y>>1)*(w>>1)+(x>>1)]-128;
    o[k++]=cl((yy+cr*v+128)>>8); o[k++]=cl((yy-gu*u-gv*v+128)>>8); o[k++]=cl((yy+cb*u+128)>>8); o[k++]=255; }
  return o;
}
function ff(args){ execFileSync('ffmpeg',['-loglevel','error','-y',...args],{stdio:['ignore','inherit','inherit']}); }

async function run(name,size,enc,frames=30){
  const es=path.join(tmp,name+'.m2v'), ref=path.join(tmp,name+'.yuv'), [w,h]=size.split('x').map(Number);
  ff(['-f','lavfi','-i',`testsrc2=size=${size}:rate=25,noise=alls=12:allf=t`,'-frames:v',String(frames),'-pix_fmt','yuv420p','-c:v','mpeg2video',...enc,'-f','mpeg2video',es]);
  ff(['-i',es,'-f','rawvideo','-pix_fmt','yuv420p',ref]);
  const yuv=fs.readFileSync(ref), n=yuv.length/(w*h*3/2);
  const r=await decode(fs.readFileSync(es));
  ok(name+': frame count',r.frames.length===n && r.w===w && r.h===h,`${r.frames.length}/${n} ${r.w}x${r.h} err ${r.err} bad ${r.bad}`);
  let worst=1e9, maxd=0, pics=0;
  for(let f=0;f<Math.min(n,r.frames.length);f++){
    const a=rgba(yuv,w,h,f), b=r.frames[f].d; let se=0;
    for(let i=0;i<a.length;i++){ if(i%4===3) continue; const d=a[i]-b[i]; se+=d*d; if(Math.abs(d)>maxd) maxd=Math.abs(d); }
    const psnr=se===0 ? 99 : 10*Math.log10(255*255/(se/(w*h*3))); worst=Math.min(worst,psnr); pics++;
    if(process.env.V) console.log('  frame',f,psnr.toFixed(1),'dB');
  }
  ok(name+': matches ffmpeg',worst>45,`worst PSNR ${worst.toFixed(1)} dB, max diff ${maxd}, ${pics} pictures`);
}
// MP2 audio against ffmpeg
async function audio(name,args){
  const es=path.join(tmp,name+'.mp2'), ref=path.join(tmp,name+'.f32');
  ff(['-f','lavfi','-i','aevalsrc=0.4*sin(2*PI*440*t)+0.3*sin(2*PI*3100*t*(1+0.2*sin(t)))|0.4*sin(2*PI*660*t):s=48000:d=3','-c:a','mp2',...args,'-f','mp2',es]);
  ff(['-i',es,'-f','f32le',...(args.includes('1')&&args.includes('-ac') ? [] : ['-ac','2']),ref]);
  const r=fs.readFileSync(ref), want=new Float32Array(r.buffer,r.byteOffset,r.length/4);
  const {instance}=await WebAssembly.instantiate(wasm,{}); const x=instance.exports;
  const data=fs.readFileSync(es), out=[]; let rate=0;
  for(let o=0;o<data.length;o+=1500){
    const c=data.subarray(o,o+1500); new Uint8Array(x.memory.buffer,x.a2_in(),c.length).set(c);
    const n=x.a2_feed(c.length); if(n) out.push(...new Float32Array(x.memory.buffer,x.a2_pcm(),n*2)); rate=x.a2_rate()||rate;
  }
  const mono=args.includes('-ac') && args.includes('1'), W=mono ? Float32Array.from(want,v=>v).reduce((a,v)=>{ a.push(v,v); return a; },[]) : want;
  const n=Math.min(out.length,W.length); let se=0, sp=0;
  for(let i=0;i<n;i++){ const d=out[i]-W[i]; se+=d*d; sp+=W[i]*W[i]; }
  ok(name+': length',Math.abs(out.length-W.length)<=2304*2,`${out.length/2} / ${W.length/2} pairs, ${rate} Hz`);
  ok(name+': matches ffmpeg',se/sp<1e-6,`error ${(10*Math.log10(se/sp)).toFixed(1)} dB`);
}
const only=process.argv[2];
if(!only || only==='audio' || only==='keep'){ await audio('mp2-192',['-b:a','192k']); await audio('mp2-64-mono',['-b:a','64k','-ac','1']); await audio('mp2-joint',['-b:a','128k','-joint_stereo','1']); }
if(only==='audio'){ fs.rmSync(tmp,{recursive:true,force:true}); console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0); }
const cases=[
  ['prog','352x288',['-g','12','-bf','2','-b:v','1500k']],
  ['intra','352x288',['-g','1','-b:v','3M']],
  ['pframes','352x288',['-g','30','-bf','0','-b:v','1M']],
  ['interlaced','720x576',['-g','12','-bf','2','-b:v','4M','-flags','+ildct+ilme','-top','1']],
  ['altscan','352x288',['-g','12','-bf','2','-b:v','2M','-alternate_scan','1','-flags','+ildct+ilme']],
  ['altscan-p','352x288',['-g','12','-bf','2','-b:v','2M','-alternate_scan','1']],
  ['intravlc','352x288',['-g','12','-bf','2','-b:v','2M','-intra_vlc','1']],
  ['nonlinq','352x288',['-g','12','-bf','2','-b:v','4M','-non_linear_quant','1','-qmax','28']],
  ['dcprec','352x288',['-g','12','-bf','2','-b:v','2M','-dc','10']],
  ['matrix','352x288',['-g','12','-bf','2','-b:v','2M','-intra_matrix','8,16,19,22,26,27,29,34,16,16,22,24,27,29,34,37,19,22,26,27,29,34,34,38,22,22,26,27,29,34,37,40,22,26,27,29,32,35,40,48,26,27,29,32,35,40,48,58,26,27,29,34,38,46,56,69,27,29,35,38,46,56,69,83','-inter_matrix','16,17,18,19,20,21,22,23,17,18,19,20,21,22,23,24,18,19,20,21,22,23,24,25,19,20,21,22,23,24,25,26,20,21,22,23,24,25,26,27,21,22,23,24,25,26,27,28,22,23,24,25,26,27,28,29,23,24,25,26,27,28,29,30']],
  ['hd','1920x1080',['-g','12','-bf','2','-b:v','8M','-flags','+ildct+ilme'],12],
];
for(const [n,s,e,f] of cases) if(!only || only==='keep' || only===n) await run(n,s,e,f);
if(process.argv.includes('keep')) console.log('kept',tmp); else fs.rmSync(tmp,{recursive:true,force:true});
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
