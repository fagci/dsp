"use strict";
/* ============================ Заборы: типы и расчёт материалов ============================
   Забор — стена Plan Editor с признаком fk (вид: sheet mesh wood picket euro panel forged brick concrete block gabion hedge) и своим материалом сигнала
   (picket / euro / weld / bars / stone / hedge — таблицы затухания в planedit-kernels.js). Из Site Plan приходит строкой «fence A B C … picket h 1.5 gate 1 3.5»,
   в Plan Editor вид задаётся на полосе выбранной стены (fence type). Ворота и калитки — двери в стене забора (шире 2 м — ворота).
   fenceItems(s) — ведомость материалов: длина, столбы (по шагу вида и по концам цепочек, +2 у каждых ворот и калитки), полотно (м² / штук), лаги, бетон под столбы,
   кирпич и блоки с запасом 5 %, ленточный фундамент, габионные корзины, саженцы. Грузится после planedit-kernels.js. Ядро чистое: node tools/test-fence.mjs */

// kind → вид стены (мат. сигнала, толщина, высота по умолчанию), название, шаг столбов (0 — без столбов)
const FN_SPEC={sheet:{mat:'metal',t:.1,h:1.8,label:'profiled sheet',post:2.5},mesh:{mat:'mesh',t:.05,h:1.8,label:'chain-link mesh',post:3},wood:{mat:'wood',t:.03,h:1.8,label:'wooden boards',post:2.5},
  picket:{mat:'picket',t:.03,h:1.5,label:'picket fence',post:2.5},euro:{mat:'euro',t:.03,h:1.8,label:'metal euro picket',post:2.5},panel:{mat:'weld',t:.05,h:1.5,label:'welded 3D panels',post:2.5},
  forged:{mat:'bars',t:.02,h:1.5,label:'forged / bars',post:2.5},brick:{mat:'brick',t:.25,h:1.8,label:'brick wall',post:3},concrete:{mat:'concrete',t:.15,h:2,label:'concrete panels',post:2},
  block:{mat:'block',t:.2,h:1.8,label:'block wall',post:3},gabion:{mat:'stone',t:.3,h:1.5,label:'gabion',post:0},hedge:{mat:'hedge',t:.6,h:1.8,label:'hedge',post:0}};
const FN_KINDS=Object.keys(FN_SPEC);
const fnGate=o=>o.w>=2 ? 'gate' : 'wicket';

function fenceItems(s){
  const W=(s.walls||[]).filter(w=>w.fk && FN_SPEC[w.fk]); if(!W.length) return [];
  const out=[], by={}; for(const w of W) (by[w.fk]||(by[w.fk]=[])).push(w);
  const gates={gate:[],wicket:[]};
  for(const k of FN_KINDS){ const L=by[k]; if(!L) continue; const sp=FN_SPEC[k], ids=new Set(L.map(w=>w.id));
    // ворота и калитки на заборе этого вида
    const go=(s.objs||[]).filter(o=>ids.has(o.wall) && o.type==='door'); for(const o of go) gates[fnGate(o)].push(o);
    const gw=new Map(); for(const o of go) gw.set(o.wall,(gw.get(o.wall)||0)+o.w);
    let gross=0, net=0, hw=0, posts=0; const deg=new Map();
    for(const w of L){ const len=peWallLen(s,w), n=Math.max(0,len-(gw.get(w.id)||0)); gross+=len; net+=n; hw+=len*(w.h||sp.h); if(sp.post>0) posts+=Math.ceil(n/sp.post-1e-9); deg.set(w.a,(deg.get(w.a)||0)+1); deg.set(w.b,(deg.get(w.b)||0)+1); }
    const ends=[...deg.values()].filter(d=>d===1).length; if(sp.post>0) posts+=Math.ceil(ends/2)+go.length*2;
    const h=gross>0 ? hw/gross : sp.h, A=net*h, I=(name,qty,unit,note)=>out.push({group:'fence',name,qty:+(+qty).toFixed(unit==='m³'||unit==='m²' ? 1 : unit==='m' ? 1 : 0),unit:unit||'pcs',note:note||''});
    I(sp.label+' (fence)',gross,'m','h '+h.toFixed(2)+' m'+(go.length ? ', net of gates '+net.toFixed(1)+' m' : ''));
    const rails=h>1.7 ? 3 : 2, ft=net*.15;
    if(k==='sheet'){ I('profiled sheet',A,'m²'); I('rails 40×20',net*rails,'m',rails+' rows'); }
    else if(k==='wood'){ I('boards',Math.ceil(net/.12),'pcs','pitch 0.12 m'); I('rails',net*rails,'m',rails+' rows'); }
    else if(k==='picket'){ I('pickets',Math.ceil(net/.15),'pcs','pitch 0.15 m (50 mm gap)'); I('rails',net*rails,'m',rails+' rows'); }
    else if(k==='euro'){ I('metal euro pickets',Math.ceil(net/.13),'pcs','pitch 0.13 m'); I('rails',net*rails,'m',rails+' rows'); }
    else if(k==='mesh'){ I('chain-link mesh',A,'m²'); I('tension wire',net*3,'m','3 rows'); }
    else if(k==='panel'){ I('welded panels 2.5 m',Math.ceil(net/2.5),'pcs'); I('panel clamps',Math.ceil(net/2.5)*4,'pcs'); }
    else if(k==='forged'){ I('forged sections 2.5 m',Math.ceil(net/2.5),'pcs'); }
    else if(k==='brick'){ I('bricks (1 brick thick, +5 %)',Math.ceil(A*102*1.05),'pcs'); I('strip footing 0.3 × 0.5 m',net*.15,'m³'); I('caps for the pillars',posts,'pcs'); }
    else if(k==='concrete'){ I('concrete sections 2 m',Math.ceil(net/2),'pcs'); }
    else if(k==='block'){ I('blocks 200×200×400 (+5 %)',Math.ceil(A*12.5*1.05),'pcs'); I('strip footing 0.3 × 0.4 m',net*.12,'m³'); }
    else if(k==='gabion'){ I('stone fill',A*sp.t,'m³'); I('gabion baskets 2 × 0.5 m',Math.ceil(net/2)*Math.ceil(h/.5),'pcs'); }
    else if(k==='hedge'){ I('plants',Math.ceil(net/.5),'pcs','one per 0.5 m'); }
    if(sp.post>0){ I(k==='brick' ? 'pillars (pitch '+sp.post+' m)' : k==='concrete' ? 'concrete posts' : 'posts 60×60 (pitch '+sp.post+' m)',posts,'pcs','length '+(h+1).toFixed(1)+' m'+(k==='brick'||k==='concrete'||k==='block' ? '' : ', 1 m in the ground')); if(!(k==='brick'||k==='block')) I('concrete for the posts',posts*.05,'m³','Ø 0.25 × 1 m each'); }
  }
  if(gates.gate.length) out.push({group:'fence',name:'gates',qty:gates.gate.length,unit:'pcs',note:gates.gate.map(o=>o.w.toFixed(1)).join(' + ')+' m'});
  if(gates.wicket.length) out.push({group:'fence',name:'wickets',qty:gates.wicket.length,unit:'pcs',note:gates.wicket.map(o=>o.w.toFixed(1)).join(' + ')+' m'});
  return out; }
// сводка одной строкой на вид: «picket 24.0 m (h 1.5), 1 gate»
function fenceSummary(s){ const W=(s.walls||[]).filter(w=>w.fk && FN_SPEC[w.fk]), by={}; for(const w of W){ const b=by[w.fk]||(by[w.fk]={L:0,g:0,w:0}); b.L+=peWallLen(s,w); }
  for(const o of s.objs||[]){ if(o.type!=='door') continue; const w=W.find(q=>q.id===o.wall); if(w){ by[w.fk][fnGate(o)==='gate' ? 'g' : 'w']++; } }
  return Object.entries(by).map(([k,b])=>k+' '+b.L.toFixed(1)+' m'+(b.g ? ', '+b.g+' gate'+(b.g>1 ? 's' : '') : '')+(b.w ? ', '+b.w+' wicket'+(b.w>1 ? 's' : '') : '')); }
