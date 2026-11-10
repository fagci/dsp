// Заборы: node tools/test-fence.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/siteplan-kernels.js','modules/planedit-kernels.js','modules/hvac-kernels.js','modules/fence-kernels.js','modules/plancheck-kernels.js','modules/plansheet-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={spSolve,spHouse,SP_FENCE_SPEC,peNew,peAddPoint,peAddWall,peAddObj,peImportPoints,peMatLoss,peWallLen,PE_MAT,PE_MATCOL,PE_MATK,PE_REFL,peWallLoss,fenceItems,fenceSummary,FN_SPEC,FN_KINDS,pcSpec,pcCheck};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');
const base=['A at 0 0','B at 20 0','C at 20 10','D at 0 10','A-B 20','B-C 10','C-D 20','D-A 10','A-C 22.3607'].join('\n');

ok('every Site Plan fence type has the same material, thickness and height as the Plan Editor table',Object.entries(K.SP_FENCE_SPEC).filter(([k])=>K.FN_SPEC[k]).every(([k,v])=>K.FN_SPEC[k].mat===v.mat && K.FN_SPEC[k].t===v.t && (v.h==null || K.FN_SPEC[k].h===v.h)),JSON.stringify(Object.entries(K.SP_FENCE_SPEC).filter(([k])=>K.FN_SPEC[k]&&(K.FN_SPEC[k].mat!==K.SP_FENCE_SPEC[k].mat||K.FN_SPEC[k].t!==K.SP_FENCE_SPEC[k].t))));
ok('every fence material has loss, colour, frequency exponent and reflection',K.FN_KINDS.every(k=>{ const m=K.FN_SPEC[k].mat; return K.PE_MAT[m]!=null && K.PE_MATCOL[m] && K.PE_MATK[m]!=null && K.PE_REFL[m]!=null; }));
// разбор
for(const [w,kind,h] of [['picket','picket',1.5],['euro','euro',1.8],['panel','panel',1.5],['forged','forged',1.5],['gabion','gabion',1.5],['hedge','hedge',1.8],['евроштакетник','euro',1.8],['габион','gabion',1.5],['живая','hedge',1.8],['ковка','forged',1.5],['3d','panel',1.5],['brick','brick',1.8]]){
  const R=K.spSolve(base+'\nfence A B C '+w); ok('fence «'+w+'» → '+kind+', default height '+h,R.errors.length===0 && R.fences[0].kind===kind && Math.abs(R.fences[0].h-h)<1e-9,JSON.stringify(R.errors)+JSON.stringify(R.fences[0]&&R.fences[0].kind)); }
ok('an explicit height wins',K.spSolve(base+'\nfence A B picket h 1.2').fences[0].h===1.2);
// ворота
{ const R=K.spSolve(base+'\nfence A B C D closed picket gate 1 4 wicket 3 gate 2 3 at 0.3'); ok('gate and wicket parse',R.errors.length===0 && R.fences[0].gates.length===3 && R.fences[0].gates[0].w===4 && R.fences[0].gates[1].w===1 && R.fences[0].gates[1].gate===false && R.fences[0].gates[2].u===.3,JSON.stringify(R.errors)+JSON.stringify(R.fences[0].gates));
  const Hs=K.spHouse(R,{}); const d=Hs.opens.filter(o=>o.wall.startsWith('fence:0:')); ok('gates become openings on the fence walls, u kept inside the wall',d.length===3 && d[0].wall==='fence:0:0' && Math.abs(d[0].w-4)<1e-9 && d.every(o=>o.type==='door' && o.u>0 && o.u<1) && d[2].wall==='fence:0:1',JSON.stringify(d));
  ok('the fence walls carry the type (fk) and the signal material',Hs.walls.filter(w=>w.kind==='fence').every(w=>w.fk==='picket' && w.mat==='picket')); }
for(const [bt,msg] of [['fence A B gate 3','fence has 1'],['fence A B stakes gate 1','no gates'],['fence A B gate 1 20','0.5…12'],['fence A B gate x','SEGMENT'],['fence A B gate 1 3 at 2','0…1']]){ const e=K.spSolve(base+'\n'+bt).errors; ok('error: «'+bt+'»',e.some(q=>q.msg.includes(msg)),JSON.stringify(e)); }
// импорт в Plan Editor
{ const R=K.spSolve(base+'\nfence A B euro gate 1 3.5'), Hs=K.spHouse(R,{}), s=K.peNew();
  K.peImportPoints(s,[{id:'sp:walls',kind:'plan walls',walls:Hs.walls.map(w=>({id:w.id,x1:w.x1,y1:w.y1,x2:w.x2,y2:w.y2,t:w.t,h:w.h,mat:w.mat,kind:w.kind,fk:w.fk,z0:0,lv:0})),opens:Hs.opens,hv:[],pp:[],uses:[]}]);
  ok('import keeps the fence type, the material and the gate',s.walls.length===1 && s.walls[0].fk==='euro' && s.walls[0].mat==='euro' && s.objs.length===1 && s.objs[0].type==='door' && s.objs[0].w===3.5,JSON.stringify(s.walls)+JSON.stringify(s.objs));
  const it=K.fenceItems(s); ok('the bill of materials has the fence, pickets, posts, concrete and a gate',['(fence)','metal euro pickets','posts 60×60','concrete for the posts','gates'].every(t=>it.some(i=>i.name.includes(t))),JSON.stringify(it.map(i=>i.name))); }
// затухание
near('euro 3 cm: 12 dB per 10 cm → 3.6 dB at 2.4 GHz',K.peMatLoss('euro',2437,.03),3.6*Math.pow(2437/2400,.15),.01);
{ const L=m=>K.peMatLoss(m.mat,2437,m.t), order=['sheet','gabion','hedge','panel','euro','forged','picket'].map(k=>L(K.FN_SPEC[k])); ok('the loss goes: sheet > gabion > hedge > 3D panel > euro > forged > picket',order.every((v,i)=>i===0||order[i-1]>v),order.map(v=>v.toFixed(2)).join(' ')); }
ok('a higher frequency costs more (gabion 0.8 exponent)',K.peMatLoss('stone',5800,.3)>K.peMatLoss('stone',2437,.3)*1.5);
{ const s=K.peNew(), a=K.peAddPoint(s,0,-5), b=K.peAddPoint(s,0,5), w=K.peAddWall(s,a.id,b.id,{t:.03,h:1.8,mat:'euro'}); w.fk='euro';
  const l=K.peWallLoss(s,-5,0,5,0,2437,0,1); ok('a ray through a euro fence loses about 3.6 dB',l>3 && l<4.2,l); w.mat='metal'; w.t=.1; ok('and through a solid sheet — about 20 dB',K.peWallLoss(s,-5,0,5,0,2437,0,1)>15); }
// ведомость
{ const s=K.peNew(), a=K.peAddPoint(s,0,0), b=K.peAddPoint(s,20,0), w=K.peAddWall(s,a.id,b.id,{t:.03,h:1.5,mat:'picket'}); w.fk='picket'; K.peAddObj(s,'door',{wall:w.id,u:.5,w:3.5,h:1.5,sill:0}); K.peAddObj(s,'door',{wall:w.id,u:.9,w:1,h:1.5,sill:0});
  const it=n=>K.fenceItems(s).find(i=>i.name.includes(n)); near('pickets: net 15.5 m / 0.15',it('pickets').qty,Math.ceil(15.5/.15),0);
  near('posts: ceil(15.5/2.5) = 7, + 1 for the open ends, + 2 per opening (2) = 12',it('posts 60').qty,7+1+4,0); near('concrete 0.05 m³ per post',it('concrete').qty,.6,.05);
  near('rails: 2 rows (h ≤ 1.7)',it('rails').qty,31,.1); ok('a gate (3.5) and a wicket (1.0)',it('gates').qty===1 && it('wickets').qty===1 && it('gates').note==='3.5 m');
  ok('the fence appears in the specification of the sheet',K.pcSpec(s).items.some(i=>i.group==='fence' && /pickets/.test(i.name)));
  ok('the summary line',K.fenceSummary(s)[0]==='picket 20.0 m, 1 gate, 1 wicket',K.fenceSummary(s)); }
{ const s=K.peNew(), a=K.peAddPoint(s,0,0), b=K.peAddPoint(s,10,0), w=K.peAddWall(s,a.id,b.id,{t:.25,h:1.8,mat:'brick'}); w.fk='brick'; const it=n=>K.fenceItems(s).find(i=>i.name.includes(n));
  near('brick: 10 × 1.8 m² × 102 × 1.05',it('bricks').qty,Math.ceil(18*102*1.05),0); near('strip footing 0.15 m³ per m',it('strip footing').qty,1.5,.05); near('pillars every 3 m: 4 + 1',it('pillars').qty,5,0); ok('no post concrete for the brick (it has a strip)',!it('concrete for the posts')); }
{ const s=K.peNew(), a=K.peAddPoint(s,0,0), b=K.peAddPoint(s,10,0), w=K.peAddWall(s,a.id,b.id,{t:.3,h:1.5,mat:'stone'}); w.fk='gabion'; const it=n=>K.fenceItems(s).find(i=>i.name.includes(n));
  near('gabion stone 10 × 1.5 × 0.3 = 4.5 m³',it('stone').qty,4.5,.05); near('baskets 5 × 3',it('baskets').qty,15,0); ok('no posts',!it('posts')); }
{ const s=K.peNew(), a=K.peAddPoint(s,0,0), b=K.peAddPoint(s,10,0), c=K.peAddPoint(s,10,10), d=K.peAddPoint(s,0,10); for(const [p,q] of [[a,b],[b,c],[c,d],[d,a]]) K.peAddWall(s,p.id,q.id,{t:.03,h:1.8,mat:'metal'}).fk='sheet';
  near('a closed fence has no extra end posts: 4 × ceil(10/2.5)',K.fenceItems(s).find(i=>i.name.includes('posts 60')).qty,16,0); }
ok('a plain wall has no fence items',K.fenceItems((()=>{ const s=K.peNew(), a=K.peAddPoint(s,0,0), b=K.peAddPoint(s,3,0); K.peAddWall(s,a.id,b.id); return s; })()).length===0);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
