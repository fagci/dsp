// Лист чертежа и спецификация: node tools/test-plansheet.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Float64Array,Float32Array,Set,Map,Number,String,JSON,isFinite,Infinity,Array,Object,RegExp});
const src=['modules/planedit-kernels.js','modules/hvac-kernels.js','modules/plancheck-kernels.js','modules/plansheet-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={peNew,peAddRectRoom,peAddObj,peAddEl,peAddWire,peCopyLevel,peEnsureLevel,hvAdd,hvLink,pcSheet,pcSpec,pcSpecCsv,pcLevelScene,PS_SCALES};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

const s=K.peNew(); const A=K.peAddRectRoom(s,0,0,5,4,{name:'Гостиная',t:.4,h:2.7,mat:'brick'}), B=K.peAddRectRoom(s,5,0,4,4,{name:'Кухня',t:.4,h:2.7,mat:'brick'}); B.room.gas=true;
K.peAddObj(s,'window',{wall:A.walls[0].id,u:.5,w:1.5,h:1.4,sill:.9});
const bo=K.hvAdd(s,'boiler',6,3.5,{watt:24000}), te=K.hvAdd(s,'tee',5,2), r1=K.hvAdd(s,'radiator',2.5,.3,{watt:1800}), r2=K.hvAdd(s,'radiator',7,.3,{watt:1200});
K.hvLink(s,bo.id,te.id); K.hvLink(s,te.id,r1.id); K.hvLink(s,te.id,r2.id);
const u=K.hvAdd(s,'ahu',7,2,{}), sa=K.hvAdd(s,'supply',2.5,2), ex=K.hvAdd(s,'extract',7,3); K.hvLink(s,u.id,sa.id); K.hvLink(s,u.id,ex.id);
const so=K.peAddEl(s,'socket',1,1), pn=K.peAddEl(s,'panel',.3,2); K.peAddWire(s,pn.id,so.id);

const svg=K.pcSheet(s,{paper:'A3',proj:{name:'Дом на Лесной',addr:'Новосибирск',by:'ФИО',date:'2026-11-10'}});
ok('A3 sheet in mm, a frame, nested plan',/width="420mm" height="297mm"/.test(svg) && /<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" viewBox=/.test(svg) && (svg.match(/<svg /g)||[]).length===2);
ok('A4 is 297 × 210',/width="297mm" height="210mm"/.test(K.pcSheet(s,{paper:'A4'})));
ok('the title block carries the project, address, author, date, scale',['Дом на Лесной','Новосибирск','ФИО','2026-11-10','1:'].every(t=>svg.includes(t)));
ok('the room explication and the specification are on the sheet',svg.includes('Room explication') && svg.includes('Гостиная') && svg.includes('Кухня') && svg.includes('Equipment and materials') && svg.includes('radiators') && svg.includes('pipe DN'));
ok('overall dimensions 9.40 (walls 0.4 thick: the axis to axis 9.00 + …) are drawn',/>9\.00</.test(svg) && />4\.00</.test(svg),(svg.match(/font-size="\.2" text-anchor="middle">[\d.]+</g)||[]).join());
ok('systems are drawn: pipes red, ducts blue',svg.includes('stroke="#d32f2f"') && svg.includes('stroke="#2a8ad8"') && svg.includes('stroke="#ef8a3a"'));
{ const m=svg.match(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/); const sc=+(svg.match(/1:(\d+)/)||[])[1]; ok('the scale is a standard one and the plan fits the area',K.PS_SCALES.includes(sc) && +m[3]<420-20-5-96-5 && +m[4]<297-10,sc+' '+m[3]+'×'+m[4]); }
ok('a given scale wins',/1:50\b/.test(K.pcSheet(s,{scale:50})) && !/1:100\b/.test(K.pcSheet(s,{scale:50})));
ok('a bigger plan takes a smaller scale',(()=>{ const q=K.peNew(); K.peAddRectRoom(q,0,0,60,40); const a=+(K.pcSheet(q,{}).match(/\(?1:(\d+)/)||[])[1]; const c=+(K.pcSheet(s,{}).match(/1:(\d+)/)||[])[1]; return a>c; })());
ok('an empty plan gives no sheet',K.pcSheet(K.peNew(),{})==='');
ok('hostile text is escaped',!K.pcSheet(s,{proj:{name:'<script>x</script>'}}).includes('<script>'));
// спецификация
const sp=K.pcSpec(s); const it=n=>sp.items.find(i=>i.name===n);
ok('rooms in the explication',sp.rooms.length===2 && Math.abs(sp.rooms[0].area-20)<1e-9);
ok('radiators 2 pcs, 3000 W rated',it('radiators (rated at ΔT 50 K)').qty===2 && it('radiators (rated at ΔT 50 K)').note==='3000 W');
ok('pipes counted with the return line, by diameter',sp.items.some(i=>/^pipe DN/.test(i.name) && i.unit==='m' && i.qty>0));
ok('ducts by diameter, tees, units',sp.items.some(i=>/^duct Ø/.test(i.name)) && it('tees').qty===1 && it('supply-extract units').qty===1);
ok('cable with the reserve',sp.items.some(i=>/^cable/.test(i.name)));
const csv=K.pcSpecCsv(s); ok('CSV has both sections, quoting works',csv.split('\n')[0].startsWith('section,name,use') && csv.includes('item,heating,boiler,1,pcs') && /room,Гостиная,/.test(csv));
// этаж
{ const q=K.peNew(); K.peAddRectRoom(q,0,0,5,4,{name:'Low'}); K.peCopyLevel(q,0,1); q.rooms.find(r=>r.lv===1).name='Up'; const lo=K.pcLevelScene(q,0), up=K.pcLevelScene(q,1);
  ok('level scene: only the walls and rooms of the floor',lo.walls.length===4 && up.walls.length===4 && lo.rooms[0].name==='Low' && up.rooms[0].name==='Up' && K.pcLevelScene(q,'all')===q);
  ok('a sheet of a floor names it',K.pcSheet(q,{level:1,calc:null}).includes('>2<') && K.pcSheet(q,{level:1,calc:null}).includes('Up')); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
