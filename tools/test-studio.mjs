// Данные узлов Studio и заготовки композиций: node tools/test-studio.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float32Array,JSON,Object,Number,String,Map,Infinity});
vm.runInContext(fs.readFileSync(path.join(root,'modules/studio-kernels.js'),'utf8')+
 ';this.K={stDemoProject,stLoad,stToNorm,stFromNorm,stNewProject,ST_EXAMPLES,stAddChannel,stAddPattern,stSnapScale,ST_SYNTH,ST_FX,ST_CHDEF,ST_KITS,stSongEnd,stPatchP};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c)=>{ if(!c){ bad++; console.log('FAIL',n); } else console.log('ok  ',n); };
const near=(a,b,e=1e-3)=>Math.abs(a-b)<e;
ok('norm roundtrip',(()=>{ const d=K.ST_SYNTH.find(x=>x.k==='cut'); return near(K.stFromNorm(d,K.stToNorm(d,1000)),1000,2); })());
ok('scale snap',K.stSnapScale(61,60,'major')!==61);
{ // строка-триггер, клип библиотеки и параметры переживают сохранение узла
  const P=K.stNewProject(), e=K.stAddChannel(P,'ext','Trigger',{},1), m=K.stAddChannel(P,'sampler','Smp',{clip:'7: kick',sname:'x.wav'},2);
  const L=K.stLoad(JSON.stringify(P));
  ok('trigger row kept',L.channels.some(c=>c.type==='ext'));
  ok('sampler clip id kept',L.channels.find(c=>c.type==='sampler').p.clip==='7: kick');
}
for(const [name,make] of Object.entries(K.ST_EXAMPLES)){
  const E=make(), L=K.stLoad(JSON.stringify(E)), ids=new Set(E.patterns.map(p=>p.id)), clips=E.playlist.clips.filter(c=>c.kind==='pat');
  ok('song '+name+': loads',L.channels.length===E.channels.length && L.patterns.length===E.patterns.length);
  ok('song '+name+': clips point at patterns',clips.every(c=>ids.has(c.pat)));
  ok('song '+name+': notes inside patterns',E.patterns.every(p=>Object.values(p.notes).every(a=>a.every(n=>n.t>=0&&n.t<p.bars*384&&n.l>0&&n.k>=0&&n.k<128&&n.v>0&&n.v<=127))));
  ok('song '+name+': notes belong to channels',E.patterns.every(p=>Object.keys(p.notes).every(id=>E.channels.some(c=>c.id==id))));
  ok('song '+name+': at most 8 playlist lanes',new Set(clips.map(c=>c.tr)).size<=8 && clips.every(c=>c.tr<8));
  ok('song '+name+': channel inserts within the mixer',E.channels.every(c=>c.mix>=0&&c.mix<=16));
  ok('song '+name+': loops and has an end',E.playlist.loop && K.stSongEnd(E)>0);
}
process.exit(bad?1:0);
