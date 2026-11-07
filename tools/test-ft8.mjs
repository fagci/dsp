// FT8: приём в слоте (USB и зеркальный LSB), имя файла записи: node tools/test-ft8.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
const pr=rd('modules/protocols.js'), out=rd('modules/output.js'), fst=rd('modules/filestore.js');
const ctx=vm.createContext({Math,Float32Array,Float64Array,Array,Set,Number,String,Date,console,performance,BLOCK:128});
const cut=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b));
vm.runInContext(`function setMod(){} const Eng={turbo:1}; function def(){} function ft8Stamp(){return ''} function ft8Text(){}`+
  rd('core-dsp.js')+cut(pr,'/* ---------- FT8: LDPC',"def({ id:'ft8Rx'")+cut(pr,'/* ---------- FT8: упаковка',"def({ id:'ft8Tx'")+
  cut(out,'function ft8Spec','/* ---------- вывод')+';this.K={ft8Run,ft8Pack,ft8Tones,FT8_SR};this.ft8Unpack=ft8Unpack;this.ft8Hash=ft8Hash;this.ft8GridMsg=ft8GridMsg;this.FT8_H12=FT8_H12',ctx,{filename:'ft8'});
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };

let seed=7; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
const gauss=()=>Math.sqrt(-2*Math.log(rnd()+1e-12))*Math.cos(2*Math.PI*rnd());
function slot(msgs,mirror,noise){                      // 15 с при 6400 Гц: тоны без GFSK-сглаживания, старт +0.5 с
  const L=K.FT8_SR*15, x=new Float32Array(L);
  for(const [text,f0,dt] of msgs){
    const tones=K.ft8Tones(K.ft8Pack(text)); let ph=0;
    for(let s=0;s<79;s++) for(let i=0;i<1024;i++){
      const f=f0+6.25*tones[s], a=mirror ? K.FT8_SR/2-f : f, k=Math.round((0.5+dt)*K.FT8_SR)+s*1024+i;
      ph+=2*Math.PI*a/K.FT8_SR; if(k>=0&&k<L) x[k]+=0.1*Math.sin(ph); } }
  for(let i=0;i<L;i++) x[i]+=noise*gauss();
  return x;
}
function run(x,side){
  const n={buf:x,wp:0,p:{fmin:200,fmax:2800,top:20,thr:1.6,budget:5000,side,tones:false,decode:true,keep:5},recQ:[],log:[],grids:new Map()};
  ctx.n=n; vm.runInContext('K.ft8Run(n,true,0)',ctx); return n.log[0].list.filter(e=>e.msg);
}
{ // тип 4: нестандартный позывной (R6HABA — 4 буквы суффикса), локатор не передаётся
  const un=t=>{ const b=K.ft8Pack(t); return b && ctx.ft8Unpack(b); };
  ok('type 4: CQ R6HABA KO85 packs (grid dropped)',un('CQ R6HABA KO85')==='CQ R6HABA',un('CQ R6HABA KO85'));
  ok('type 4: CQ PJ4/K1ABC',un('CQ PJ4/K1ABC')==='CQ PJ4/K1ABC',un('CQ PJ4/K1ABC'));
  ok('type 1 still wins for standard',un('CQ K1ABC FN42')==='CQ K1ABC FN42');
  const rt=t=>{ const b=K.ft8Pack(t); return b && ctx.ft8Unpack(K.ft8Pack(t)); };
  ok('type 4: <hash> CALL RR73',(un('<K1ABC> R6HABA RR73')||'')==='<K1ABC> R6HABA RR73',un('<K1ABC> R6HABA RR73'));
  ok('type 4: CALL <hash> RRR',un('PJ4/K1ABC <W9XYZ> RRR')==='PJ4/K1ABC <W9XYZ> RRR',un('PJ4/K1ABC <W9XYZ> RRR'));
  ok('type 4: <hash> CALL',un('<W9XYZ> R6HABA')==='<W9XYZ> R6HABA',un('<W9XYZ> R6HABA'));
  ok('type 1 with <hash> (22 bit)',un('<K1ABC> W9XYZ -12')==='<K1ABC> W9XYZ -12',un('<K1ABC> W9XYZ -12'));
  { const b=K.ft8Pack('CQ R6HABA'); let n=0n; for(let i=12;i<70;i++) n=n*2n+BigInt(b[i]);
    ok('type 4: c58 right-justified (WSJT-X adjustr)',n%38n===BigInt(' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/'.indexOf('A')) && b[73]===1 && b[70]===0 && b.slice(0,12).every(x=>x===0)); }
  ok('hash is 12 bit',(()=>{ const h=ctx.ft8Hash('K1ABC',12); return h>=0&&h<4096; })());
  ok('unknown hash shows <...>',(()=>{ const b=K.ft8Pack('<K1ABC> R6HABA'); ctx.FT8_H12.clear(); return ctx.ft8Unpack(b)==='<...> R6HABA'; })());
  ok('grid goes in a second slot as free text',ctx.ft8GridMsg('CQ R6HABA KO85')==='R6HABA KO85' && un('R6HABA KO85')==='R6HABA KO85' && ctx.ft8GridMsg('CQ K1ABC FN42')===null && ctx.ft8GridMsg('CQ R6HABA')===null);
  ok('garbage still refused',K.ft8Pack('CQ R6HABA @@@')===null);
}
const M=[['CQ K1ABC FN42',1000,0],['K1ABC W9XYZ -12',1800,0.2]];
let got=run(slot(M,false,0.05),'auto');
ok('USB, auto: both decoded',got.length===2 && got.some(e=>e.msg==='CQ K1ABC FN42') && got.some(e=>e.msg==='K1ABC W9XYZ -12'),JSON.stringify(got.map(e=>e.msg)));
ok('USB: not marked LSB',got.every(e=>!e.inv));
got=run(slot(M,true,0.05),'auto');
ok('LSB (mirrored), auto: both decoded',got.length===2,JSON.stringify(got.map(e=>e.msg)));
ok('LSB: marked, f in the mirrored band',got.every(e=>e.inv) && got.some(e=>Math.abs(e.f-1000)<4),JSON.stringify(got.map(e=>[e.f,e.inv])));
ok('LSB with side=USB: nothing',run(slot(M,true,0.05),'USB').length===0);
ok('USB with side=LSB: nothing',run(slot(M,false,0.05),'LSB').length===0);
ok('LSB with side=LSB',run(slot(M,true,0.05),'LSB').length===2);
ok('noise only: nothing decoded',run(slot([],false,0.05),'auto').length===0);

// имя файла записи: «rec 21.39.46» не принимается за расширение, дата в имени
const vm2=vm.createContext({Date,String});
vm.runInContext(cut(fst,'const fsStamp','const fsExt')+cut(fst,'const FM_EXT','const fmBlob')+';this.F={fsStamp,fmFileName}',vm2,{filename:'filestore'});
const F=vm2.F;
ok('stamp has date and no dots',/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/.test(F.fsStamp()),F.fsStamp());
ok('legacy name with dots gets .wav',F.fmFileName({name:'rec 21.39.46',mime:'audio/wav'})==='rec 21.39.46.wav');
ok('name with extension unchanged',F.fmFileName({name:'a.wav',mime:'audio/wav'})==='a.wav' && F.fmFileName({name:'a.JPG',mime:'image/jpeg'})==='a.JPG');
ok('unknown mime unchanged',F.fmFileName({name:'x',mime:'application/octet-stream'})==='x');
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
