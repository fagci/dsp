// Нагрузки на конструкцию: node tools/test-loads.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/siteplan-kernels.js','modules/planedit-kernels.js','modules/hvac-kernels.js','modules/loads-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={spSolve,spHouse,peNew,peAddPoint,peAddWall,peAddRoom,peAddObj,peImportPoints,peAddRectRoom,peCopyLevel,ldCalc,ldTimber,ldMu,LD_SOIL,LD_LIVE,LD_IBEAM,LD_GAMMA};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// сцена из текста Site Plan через записи (как в приложении)
function fromText(T){ const R=K.spSolve(T), H=K.spHouse(R,{}), s=K.peNew(), rec=[];
  for(const p of R.pts) rec.push({id:'sp:'+p.name,kind:'plan point',label:p.name,x:p.x,y:p.y,z:p.z});
  R.polys.forEach((pl,i)=>{ const nm0=pl.names.map(x=>x.replace(/\d+$/,'')), lv=(R.levels||[]).find(q=>q.name===(pl.level??'1')); if(!pl.plot) rec.push({id:'sp:room:'+i,kind:'plan poly',nowalls:true,name:nm0.every(x=>x===nm0[0]) ? nm0[0] : '',z0:lv ? lv.z : 0,lv:lv ? lv.idx : 0,names:pl.names.slice(),...(pl.h>0 ? {h:pl.h} : {})}); });
  rec.push({id:'sp:walls',kind:'plan walls',walls:H.walls.map(w=>({id:w.id,x1:w.x1,y1:w.y1,x2:w.x2,y2:w.y2,t:w.t,h:w.h,mat:w.mat,kind:w.kind,z0:w.z0||0,lv:w.lv||0})),opens:H.opens,slabs:H.slabs,roofs:H.roofs,levels:H.levels,grounds:[],stakes:[],hv:[],pp:[],uses:[]});
  K.peImportPoints(s,rec); return s; }
const BASE='outer 0.40 brick\ninner block\nslab 0.22 concrete\nheight 2.70\nroom Liv 5 4 5 4\nLiv1 at 0 0\nLiv2 at 5 0\n';

// один этаж, без кровли: потолок 0,8 + 0,7 кПа на 18 м периметра
{ const s=fromText(BASE), C=K.ldCalc(s,{snow:1.5}), w=C.walls[0];
  ok('four bearing outer walls',C.walls.length===4 && C.walls.every(x=>x.role==='outer'),JSON.stringify(C.walls.map(x=>x.role)));
  near('the own weight: 18 kN/m³ × 0.4 m × 2.7 m = 19.44 kN/m (the wall has no openings)',w.own,19.44,.2);
  near('the ceiling dead load per metre: 0.8 kPa × 20 m² / 18 m',w.top.g,.8*20/18,.02); near('the live load of the attic: 0.7 kPa',w.top.v,.7*20/18,.02);
  near('the design value: 1.1 g + 1.3 v',w.Nd,1.1*(w.top.g+w.own)+1.3*w.top.v,.05);
  near('the capacity: φ · 1.5 MPa · 0.4 m, φ from h/t = 6.75',w.cap,(1-.4*.75/19)*1500*.4,.5); ok('the ratio is small',w.ratio<.06);
  ok('no roof: a warning, no snow',C.warns.some(x=>/no roof/.test(x)) && C.house.roofS===0);
  near('the strip: N = ' + w.Nk.toFixed(1) + ' kN/m on 300 kPa at 1 m → under 0.1 m, the minimum is wall + 0.1 = 0.5',C.foundation[0].b,.5,1e-9);
  const w2=K.ldCalc(s,{R0:60,depth:1}).foundation[0]; ok('soil 60 kPa: the strip grows (N / (R0 − 20 d))',w2.b>=w.Nk/40-1e-9 && w2.b<w.Nk/40+.06,w2.b+' vs '+(w.Nk/40));
  ok('the soil weaker than 20·depth: no strip',!isFinite(K.ldCalc(s,{R0:15,depth:1}).foundation[0].b)); }
// два этажа: монолитная плита 0,22 м
{ const s=fromText(BASE+'level 2\nroom Up 5 4 5 4\nsame Liv1 Up1\nsame Liv2 Up2\n'), C=K.ldCalc(s,{floor:'mono'}), lo=C.walls.filter(x=>x.lv===0), up=C.walls.filter(x=>x.lv===1);
  ok('walls on two floors',lo.length===4 && up.length===4);
  const u=up[0], l=lo.find(x=>Math.abs(x.x-u.x)<.5 && Math.abs(x.y-u.y)<.5); near('the lower wall carries the upper one: the load goes down 1:1',l.top.g,25*.22*20/18+1.7*20/18+u.up.g,.4);
  near('the floor: slab 25 × 0.22 + finish 1.7 kPa, over 18 m of perimeter, live 1.5 kPa',l.top.g-u.up.g,(5.5+1.7)*20/18,.05); near('live load of the floor: 1.5 kPa (living room)',l.top.v-0,1.5*20/18+ .7*20/18,.05);
  ok('the foundation reads the lower floor',C.foundation.length===4 && C.foundation[0].Nk>C.walls.find(x=>x.lv===1).Nk);
  ok('the slab: span 4 m, thickness ≥ L/30 = 14 cm, the slab is 22 cm; reinforcement counted',C.floors.length===1 && Math.abs(C.floors[0].span-4)<1e-6 && C.floors[0].t===.22 && C.floors[0].As>0,JSON.stringify(C.floors[0]));
  const T=K.ldCalc(s,{floor:'timber'}).floors[0]; ok('timber beams: the first section that holds 4 m at 0.6 m',T.sec && T.note.includes('mm at 0.6 m'),JSON.stringify(T));
  ok('hollow-core: only the load to order',K.ldCalc(s,{floor:'hollow'}).floors[0].note.includes('hollow-core')); }
// кровля: двускатная 30°, снег 1,5 кПа, μ = 1
{ const s=fromText(BASE+'roof gable 30 overhang 0.5'), C=K.ldCalc(s,{snow:1.5,roofG:.6});
  near('snow = 1.5 kPa × the horizontal projection of the slopes (6.8 × 5.8 m with the overhang)',C.house.roofS,1.5*6.8*5.8,.6); near('roof dead load 0.6 kPa over the slope area',C.house.roofG,.6*C.house.roofArea,.01);
  ok('the roof load goes to the two eave walls only',C.walls.filter(w=>w.top.s>0).length===2,JSON.stringify(C.walls.map(w=>w.top.s)));
  ok('a rafter section is chosen for the slope',C.rafters.length===2 && C.rafters[0].sec && Math.abs(C.rafters[0].angle-30)<.5,JSON.stringify(C.rafters[0]));
  ok('the roof has no «no roof» warning now',!C.warns.some(x=>/no roof/.test(x)));
  const C2=K.ldCalc(s,{snow:4}); ok('a snowier region: more load on the eave walls and on the foundation',C2.house.roofS>C.house.roofS*2.5 && C2.house.weight>C.house.weight); }
ok('snow factor μ: 1 up to 30°, 0 at 60°, 0.5 at 45°',K.ldMu(20)===1 && K.ldMu(60)===0 && Math.abs(K.ldMu(45)-.5)<1e-9);
// проёмы: простенки, перемычки
{ const s=fromText(BASE+'window Liv1-Liv2 1.0 1.5 h 1.4 sill 0.9\nwindow Liv1-Liv2 3.0 1.5 h 1.4 sill 0.9\nroof gable 30 overhang 0.5'), C=K.ldCalc(s,{});
  ok('two lintels over the windows (and none elsewhere)',C.lintels.length===2 && C.lintels.every(l=>l.kind==='window' && l.span>1.5 && l.M>0 && l.ibeam),JSON.stringify(C.lintels[0]));
  const wl=C.walls.find(w=>w.openings===2); near('a wall with windows: the narrowest pier is the 0.5 m between the windows',wl.pier,.5,.01); ok('openings raise the stress by L / (L − Σ openings)',wl.ratio>C.walls.find(w=>w.openings===0).ratio);
  ok('a pier narrower than 0.64 m is flagged: windows 1.0 and 3.0 wide 1.5 leave 0.5 at the corner',C.warns.some(x=>/pier of 0\.\d+ m/.test(x))||wl.warn.some(x=>/pier/.test(x)),JSON.stringify(wl.warn)); }
// слабые материалы и слабые места
{ const s=fromText('outer 0.12 drywall\ninner drywall\nheight 2.7\nroom Liv 5 4 5 4\nLiv1 at 0 0\nLiv2 at 5 0\n'), C=K.ldCalc(s,{}); ok('drywall walls are not bearing: no load path, no walls checked',C.walls.length===0); }
{ const s=fromText(BASE), C0=K.ldCalc(s,{}); s.walls[0].mat='block'; s.walls[0].t=.2; const C=K.ldCalc(s,{}); ok('block 20 cm: lower capacity than brick 40 cm',C.walls.find(w=>w.id===s.walls[0].id).cap<C0.walls.find(w=>w.id===s.walls[0].id).cap/2);
  s.walls[1].bear='no'; ok('a wall marked non-bearing is out of the checks, its edge load goes to the others',K.ldCalc(s,{}).walls.length===3); }
// стена на перекрытии
{ const s=fromText(BASE+'level 2\nroom Up 3 2 3 2\nUp1 at 1 1\n'); const C=K.ldCalc(s,{}); ok('an upper wall with nothing under it rests on the slab: a warning',C.warns.some(x=>/rests on the slab/.test(x)),JSON.stringify(C.warns)); }
// балки
ok('timber: 4 m at a light load takes a small section, 6 m a bigger one, 12 m none',(()=>{ const a=K.ldTimber(1.5,1.0,3), b=K.ldTimber(1.5,1.0,6), c=K.ldTimber(1.5,1.0,12); return a && b && a[1]<=b[1] && c===null; })());
// грунты и города
ok('soil table: gravel > sand > clay > peat',K.LD_SOIL['gravel / coarse sand']>K.LD_SOIL['sand, medium dense'] && K.LD_SOIL['sand, medium dense']>K.LD_SOIL['clay, plastic'] && K.LD_SOIL['clay, plastic']>K.LD_SOIL['peat / soft']);
ok('a pile spacing from the capacity: 100 kN piles under 50 kN/m → 2 m',Math.abs(K.ldCalc(fromText(BASE),{pile:100}).foundation[0].pileStep-Math.max(.6,Math.min(3,100/K.ldCalc(fromText(BASE),{}).foundation[0].Nk)))<1e-9);
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
