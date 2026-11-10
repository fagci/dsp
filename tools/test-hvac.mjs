// Отопление и вентиляция: node tools/test-hvac.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/planedit-kernels.js','modules/hvac-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={peNew,peAddPoint,peAddWall,peAddRoom,peAddObj,peParse,peImportPoints,peDel,hvAdd,hvLink,hvLinkLen,hvLinkPath,hvCalc,hvStats,hvGuessUse,hvWallU,hvPickPipe,hvPickDuct,hvPipeDrop,hvDuctDrop,HV_DUCTS,HV_PIPES};',ctx);
vm.runInContext(fs.readFileSync(path.join(root,'modules/siteplan-kernels.js'),'utf8')+';this.S={spSolve};',ctx);
const K=ctx.K, S=ctx.S;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const near=(n,a,b,e)=>ok(n,Math.abs(a-b)<=e,a+' ≉ '+b+' (±'+e+')');

// комната 5×4: кирпич 0,4 м, h 2,7, окно 1,5×1,4 в северной стене
function box(s,x0,y0,w,h,name,o={}){ const P=[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h]].map(q=>K.peAddPoint(s,q[0],q[1])); const ids=P.map(p=>p.id);
  const ws=ids.map((a,i)=>K.peAddWall(s,a,ids[(i+1)%4],{t:.4,h:2.7,mat:'brick',...o})); return {ids,ws,room:K.peAddRoom(s,ids,name)}; }
const s=K.peNew(); const A=box(s,0,0,5,4,'Liv');
K.peAddObj(s,'window',{wall:A.ws[2].id,u:.5,w:1.5,h:1.4,sill:.9});
const R0=K.hvCalc(s,{tout:-25}); const r=R0.rooms[0];
near('U of a 40 cm brick wall',K.hvWallU({mat:'brick',t:.4},0),1/(.17+.4/.7),1e-9);
ok('use guessed from the name: Liv → living, Кухня → kitchen, Санузел → wc, Спальня → bedroom',K.hvGuessUse('Liv')==='living' && K.hvGuessUse('Кухня')==='kitchen' && K.hvGuessUse('Санузел')==='wc' && K.hvGuessUse('Спальня 2')==='bedroom');
near('room area 20 m²',r.area,20,1e-9); near('room volume 54 m³',r.vol,54,1e-9);
const Uw=1/(.17+.4/.7), aw=18*2.7-2.1;
near('walls: U·(perimeter·h − window)·ΔT',r.trans.walls,Uw*aw*45,1);
near('window: 1.4 · 2.1 · 45',r.trans.win,1.4*2.1*45,.01);
near('floor to ground (factor 0.6) and roof',r.trans.floor+r.trans.roof,.3*20*45*.6+.25*20*45,.01);
near('ventilation: 60 m³/h (3 m³/h per m²) · 0.335 · 45',r.vent,.335*60*45,.01);
near('total = transmission ×1.1 + ventilation',r.loss,(Uw*aw*45+1.4*2.1*45+.3*20*45*.6+.25*20*45)*1.1+.335*60*45,1);
ok('no heating device is flagged',r.warn.some(w=>/no heating/.test(w)));
const Ri=K.hvCalc(s,{tout:-25,ins:100}).rooms[0]; ok('100 mm of insulation lowers the wall loss ~4 times',Ri.trans.walls<r.trans.walls/3.5,Ri.trans.walls+' vs '+r.trans.walls);

// радиатор: номинал при ΔT 50 пересчитывается в режим 70/50 (средняя 60 − 20 = 40 К → ×0,748)
const rad=K.hvAdd(s,'radiator',2.5,.2,{watt:2000}), boil=K.hvAdd(s,'boiler',2.5,3.8,{watt:24000});
let c=K.hvCalc(s,{tout:-25}).rooms[0]; near('radiator 2000 W at ΔT 50 gives ×0.748 at 70/50',c.rad,2000*Math.pow(40/50,1.3),.01);
ok('the radiator is found in the room, and the shortage is flagged',c.dev.includes('R1') && c.warn.some(w=>/covers only/.test(w)),c.warn.join());
rad.watt=8000; c=K.hvCalc(s,{tout:-25}).rooms[0]; ok('8000 W of radiators cover the loss',c.cover>=1 && !c.warn.length,c.cover+' '+c.warn.join());
ok('radiator without pipes is reported',K.hvCalc(s,{tout:-25}).warns.some(w=>/not connected to a boiler/.test(w)));
// трубы
const l=K.hvLink(s,boil.id,rad.id); ok('a pipe is made between boiler and radiator',!!l && K.hvLink(s,boil.id,rad.id)===l);
let H=K.hvCalc(s,{tout:-25}); const sg=H.heat.segs[0];
near('flow G = P/(1.163·ΔT)/0.977 for the emitted power',sg.G,sg.P/(1.163*20)/.977,1e-6);
ok('a 6 kW radiator: pipe 20 or more, velocity ≤ 0.7 m/s, resistance ≤ 200 Pa/m',sg.dn>=20 && sg.v<=.7 && sg.R<=200,JSON.stringify(sg));
ok('pump head is computed',H.heat.pump && H.heat.pump.dp>8000 && H.heat.pump.G>0,JSON.stringify(H.heat.pump));
ok('no "not connected" warning now',!H.warns.some(w=>/not connected/.test(w)));
ok('pipe length counts the return line',Math.abs(K.hvStats(s).pipe-2*K.hvLinkLen(s,l).len)<1e-9);
ok('a pipe cannot join a radiator and a duct terminal',K.hvLink(s,rad.id,K.hvAdd(s,'extract',1,1).id)===null);
const hr=K.hvAdd(s,'heater',1,1,{watt:500}); ok('a heater takes no pipes',K.hvLink(s,boil.id,hr.id)===null);
H=K.hvCalc(s,{tout:-25}); near('local heater adds to the installed power',H.rooms[0].heater,500,1e-9);
// котёл
boil.watt=3000; H=K.hvCalc(s,{tout:-25}); ok('a small boiler is flagged',H.warns.some(w=>/boiler 3000 W is below/.test(w)),H.warns.join()); boil.watt=24000;
// тёплый пол: потолок 100 Вт/м² и длина контура
const fl=K.hvAdd(s,'floor',2,2,{area:20}); K.hvLink(s,boil.id,fl.id); H=K.hvCalc(s,{tout:-25});
near('floor loop: 20 m² / 0.15 m step = 133 m of pipe, 2 loops',H.heat.loops[0].len,20/.15,.01); ok('2 loops of ≤ 100 m',H.heat.loops[0].loops===2);
ok('70 W/m² on a 20 m² floor = 1400 W counted',Math.abs(H.rooms[0].floorW-1400)<1e-9);
fl.watt=2400; ok('over 100 W/m² of floor is flagged',K.hvCalc(s,{tout:-25}).rooms[0].warn.some(w=>/floor heating gives/.test(w))); K.peDel(s,'hv',fl.id);
ok('deleting a device deletes its pipes',!s.pp.some(p=>p.b===fl.id));

// вентиляция: дом из трёх комнат — гостиная, кухня (газ), санузел
const v=K.peNew(); box(v,0,0,5,4,'Гостиная'); box(v,5.4,0,3,4,'Кухня'); box(v,0,4.4,2,2.5,'Санузел');
v.rooms.find(q=>q.name==='Кухня').gas=true;
let V=K.hvCalc(v,{tout:-25}).house; const rr=n=>K.hvCalc(v,{tout:-25}).rooms.find(q=>q.name===n);
ok('norms: living 3 m³/h·m² = 60, gas kitchen 90, wc/bath 25',rr('Гостиная').norm===60 && rr('Кухня').norm===90 && rr('Санузел').norm===25);
ok('the extract (115) exceeds the supply (60): the house supply is raised to 115',Math.abs(V.Qtot-115)<1e-9 && Math.abs(rr('Гостиная').air-115)<1e-9);
near('air changes per hour of the house',V.ach,115/V.vol,1e-9);
// сеть: установка → приток в гостиную, вытяжка с кухни и санузла
const u=K.hvAdd(v,'ahu',1,5,{m3:200,eff:80,z:2.4}), sa=K.hvAdd(v,'supply',2.5,2,{z:2.6}), e1=K.hvAdd(v,'extract',7,2,{z:2.6}), e2=K.hvAdd(v,'extract',1,5.5,{z:2.6});
for(const [a,b] of [[u,sa],[u,e1],[u,e2]]) K.hvLink(v,a.id,b.id);
let N=K.hvCalc(v,{tout:-25}); const un=N.air.units[0];
near('supply side carries 115 m³/h',un.supply,115,1e-6); near('extract side carries 115 m³/h',un.extract,115,1e-6);
const seg=n=>N.air.segs.find(q=>q.to===n);
near('kitchen grille gets 90/115 of the extract (scaled to the balance)',seg('EA1').q,90,1e-6);
ok('duct diameters come from the air velocity (≤ 3 m/s under 100 m³/h; 115 → ≤ 4 m/s)',N.air.segs.every(q=>q.v<=(q.q>=250?5:q.q>=100?4:3)+1e-9),JSON.stringify(N.air.segs.map(q=>[q.to,q.d,q.v.toFixed(2)])));
ok('recuperator 80 % cuts the ventilation loss',N.house.eta>0 && N.rooms.find(q=>q.name==='Гостиная').vent<.335*115*45*0.5,N.house.eta);
ok('heat recovered is reported',N.house.recov>0);
K.peDel(v,'hv',sa.id); N=K.hvCalc(v,{tout:-25}); ok('a living room without a supply terminal is flagged',N.rooms.find(q=>q.name==='Гостиная').warn.some(w=>/no supply terminal/.test(w)));
u.m3=80; N=K.hvCalc(v,{tout:-25}); ok('an undersized unit is flagged',N.air.units[0].warn.some(w=>/needs/.test(w)),JSON.stringify(N.air.units[0].warn));
ok('duct sizes are on the standard series',N.air.segs.every(q=>K.HV_DUCTS.includes(q.d)));
ok('a smaller flow takes a smaller duct',K.hvPickDuct(50)<K.hvPickDuct(500));
// импорт и сохранение
const t=K.peNew(); const rec={id:'sp:walls',kind:'plan walls',walls:[],opens:[],hv:[{type:'boiler',name:'B1',x:1,y:1,z:.3,watt:24000},{type:'radiator',name:'R1',x:2,y:1,z:.5,watt:1200}],pp:[{a:'B1',b:'R1',dn:25,z:.1}],uses:[]};
K.peImportPoints(t,[rec]); ok('import from Site Plan: devices and a pipe with its diameter',t.hv.length===2 && t.pp.length===1 && t.pp[0].dn===25 && t.pp[0].zr===.1);
rec.hv=[rec.hv[0]]; rec.pp=[]; K.peImportPoints(t,[rec]); ok('re-import replaces the set: the removed radiator and its pipe go',t.hv.length===1 && t.pp.length===0);
const own=K.hvAdd(t,'heater',9,9); K.peImportPoints(t,[rec]); ok('a hand-drawn device survives a re-import',t.hv.includes(own));
ok('old scene without hvac parses',K.peParse(JSON.stringify({pts:[],walls:[]})).hv.length===0 && K.peParse(JSON.stringify(t)).hv.length===2);

// язык Site Plan
const T=['A at 0 0','B at 5 0','C at 5 4','D at 0 4','A-B 5','B-C 4','C-D 5','D-A 4','A-C 6.4031','poly A B C D','room Liv 5 4 5 4','use Liv bedroom people 2 tin 22',
  'boiler B1 A dx 0.5 dy 0.5 kw 24','radiator R1 A-B along 1 off 0.1 w 1500','manifold M1 A dx 1 dy 1','floor F1 C dx -2 dy -2 area 8','heater H1 D dx 1 dy -1 w 2000 fuel gas',
  'pipe B1 M1 R1 dn 25 z 0.1','pipe M1 F1','ahu U1 B dx -1 dy 1 m3 250 eff 85','supply T1 C dx -1 dy -1','extract T2 D dx 1 dy 1.5','duct U1 T1 T2 d 160'].join('\n');
const Rs=S.spSolve(T); ok('Site Plan: no errors',Rs.errors.length===0,JSON.stringify(Rs.errors));
ok('Site Plan: 8 hvac devices, the electrics list stays empty',Rs.hv.length===8 && Rs.elec.length===0,Rs.hv.length+' '+Rs.elec.length);
ok('Site Plan: kW and wall positions',Rs.hv.find(e=>e.name==='B1').watt===24000 && Math.abs(Rs.hv.find(e=>e.name==='R1').x-1)<.05 && Math.abs(Rs.hv.find(e=>e.name==='R1').y-.1)<.15,JSON.stringify(Rs.hv.find(e=>e.name==='R1')));
ok('Site Plan: pipes M1-R1 (dn 25) and B1-M1, F1; duct d 160',Rs.pp.length===5 && Rs.pp.filter(l=>l.dn===25).length===2 && Rs.pp.some(l=>l.a==='U1'&&l.dn===160),JSON.stringify(Rs.pp));
ok('Site Plan: room use',Rs.uses[0].use==='bedroom' && Rs.uses[0].people===2 && Rs.uses[0].tin===22);
ok('Site Plan: fuel and area',Rs.hv.find(e=>e.name==='H1').fuel==='gas' && Rs.hv.find(e=>e.name==='F1').area===8);
for(const [bt,msg] of [['pipe B1 U1','a pipe joins'],['duct B1 R1','a duct joins'],['pipe B1 H1','a pipe joins'],['radiator R9 A fuel coal','fuel'],['use Liv attic','use ROOM'],['pipe B1 Q9','unknown device'],['radiator R2 A foo 1','unknown']]){
  const e=S.spSolve(T+'\n'+bt).errors; ok('Site Plan error: «'+bt+'»',e.some(q=>q.msg.includes(msg)),JSON.stringify(e)); }
ok('the same name twice is refused',S.spSolve(T+'\nradiator B1 A').errors.some(q=>/already used/.test(q.msg)));
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
