"use strict";
/* ============================ Отопление и вентиляция: ядро ============================
   Надстройка над сценой Plan Editor (planedit-kernels.js грузится раньше: pePt, peWall, peId, peInPoly…).
   Устройства — s.hv: {id,type,name,x,y,z,watt,…}; трассы — s.pp: {id,a,b,via:[[x,y]…],zr,dn} (труба или воздуховод — по типам концов).
     отопление (вода):  boiler (watt — мощность), radiator (watt — номинал при ΔT 50 К), floor (тёплый пол: area, м²), manifold (коллектор)
     местное отопление (без труб): heater (watt; fuel electric | gas | wood — конвектор, ИК-панель, печь, камин)
     вентиляция (воздух): ahu (приточно-вытяжная установка: m3 — м³/ч, eff — рекуперация, %, pa — напор, Па), fan (вытяжной вентилятор),
                          supply (приточный диффузор), extract (вытяжная решётка); m3 у решётки 0 — расход берётся из нормы комнаты
   Комнаты (s.rooms) получают назначение (use: living bedroom kitchen bath wc laundry boiler hall office garage store), людей (people), температуру (tin), gas (плита на газе).
   Расчёт hvCalc(s,opt): теплопотери каждой комнаты (стены по материалу и толщине, окна и двери, пол, кровля, вентиляция), нормы воздухообмена
   (СП 54 / СП 60: жилая — 3 м³/ч на м² или 30 м³/ч на человека; кухня 60 / 90 (газ); ванная, уборная 25; котельная — 3 кратности), подбор радиаторов, котла,
   диаметров труб (скорость воды) и воздуховодов (скорость воздуха), напор насоса и вентилятора, годовой расход. Ядро чистое, без DOM: node tools/test-hvac.mjs */

const HV_T={
  boiler:{z:.3,pre:'B',watt:24000},
  radiator:{z:.5,pre:'R',watt:1200},
  floor:{z:0,pre:'F',watt:0,area:10},
  heater:{z:.3,pre:'H',watt:1500,fuel:'electric'},
  manifold:{z:.8,pre:'M',watt:0},
  tee:{z:.1,pre:'TE',watt:0},
  ahu:{z:2.4,pre:'AHU',watt:0,m3:300,eff:80,pa:150},
  fan:{z:2.4,pre:'FN',watt:0,m3:100,pa:100},
  supply:{z:2.6,pre:'SA',watt:0,m3:0},
  extract:{z:2.6,pre:'EA',watt:0,m3:0}
};
const HV_HEAT=new Set(['boiler','radiator','floor','manifold','tee']), HV_AIR=new Set(['ahu','fan','supply','extract']);
const HV_USES=['living','bedroom','kitchen','bath','wc','laundry','boiler','hall','office','garage','store'];
// температура в комнате по назначению, °C (СП 60 / ГОСТ 30494)
const HV_TIN={living:20,bedroom:20,kitchen:20,bath:24,wc:18,laundry:18,boiler:18,hall:18,office:20,garage:5,store:16};
// теплопроводность материала стены, Вт/(м·К); стекло и сетка — отдельно
const HV_LAM={brick:.7,concrete:1.7,block:.18,drywall:.21,wood:.14,metal:45};
const HV_PIPES=[[16,12],[20,16],[25,20.4],[32,26],[40,32.6],[50,40.8],[63,51.4]];                    // труба (PEX / PP-R): наружный и внутренний диаметры, мм
const HV_DUCTS=[80,100,125,160,200,250,315,400,500,630];                                              // круглые воздуховоды, мм
// города: расчётная наружная температура (наиболее холодной пятидневки, °C) и градусо-сутки отопительного периода (±5 К·сут) — приближённо; точные значения — по таблицам СП 131.13330 для вашего города
const HV_CITIES={'Moscow':[-25,4600],'Saint Petersburg':[-24,4800],'Novosibirsk':[-37,6100],'Yekaterinburg':[-32,5700],'Kazan':[-30,5300],'Samara':[-27,4900],'Krasnoyarsk':[-37,6000],'Irkutsk':[-33,6300],'Vladivostok':[-24,4800],'Krasnodar':[-19,3100],'Kyiv':[-22,3900],'Minsk':[-25,4500],'Almaty':[-23,3800]};
const HV_PIPE_U=.15, HV_PIPE_H=10;                                                                         // Вт/(м·К): утеплённая труба; голая — h·π·d (конвекция и излучение, h = 10 Вт/(м²·К))
const HV_DEF={tout:-25,ts:70,tr:50,uw:1.4,ud:1.8,ins:0,floorU:.3,roofU:.25,kb:1.1,qf:70,vmax:.7,dhw:0,gd:5000};

// ---------- устройства и трассы ----------
const hvDev=(s,id)=>(s.hv||[]).find(d=>d.id===id);
const hvIsHeat=t=>HV_HEAT.has(t), hvIsAir=t=>HV_AIR.has(t);
function hvAdd(s,type,x,y,o={}){ const b=HV_T[type]; if(!b) return null; (s.hv??=[]);
  const d={id:peId(s,'h'),type,name:b.pre+(s.hv.filter(q=>q.type===type).length+1),x,y,z:b.z,watt:b.watt,...(b.area!=null?{area:b.area}:{}),...(b.m3!=null?{m3:b.m3}:{}),...(b.eff!=null?{eff:b.eff}:{}),...(b.pa!=null?{pa:b.pa}:{}),...(b.fuel?{fuel:b.fuel}:{}),...o}; s.hv.push(d); return d; }
function hvDel(s,id){ s.hv=(s.hv||[]).filter(d=>d.id!==id); s.pp=(s.pp||[]).filter(l=>l.a!==id&&l.b!==id); }
// трасса: вода (оба конца отопительные) или воздух (оба воздушные); heater и смесь систем не соединяются
function hvLink(s,a,b,o={}){ const A=hvDev(s,a), B=hvDev(s,b); if(!A||!B||a===b) return null;
  if(!((hvIsHeat(A.type)&&hvIsHeat(B.type))||(hvIsAir(A.type)&&hvIsAir(B.type)))) return null; (s.pp??=[]);
  let l=s.pp.find(l=>(l.a===a&&l.b===b)||(l.a===b&&l.b===a)); if(l) return l;
  l={id:peId(s,'t'),a,b,via:[],dn:0,...o}; s.pp.push(l); return l; }
const hvLinkKind=(s,l)=>{ const A=hvDev(s,l.a); return A&&hvIsAir(A.type) ? 'duct' : 'pipe'; };
// высота трассы: заданная; трубы — у пола (0,1 м, в стяжке), воздуховоды — под потолком (по верхнему из концов)
const hvRunZ=(s,A,B,l)=>l.zr>0 ? l.zr : hvIsAir(A.type) ? Math.max(A.z||0,B.z||0) : Math.min(.1,A.z||0,B.z||0)+0;
function hvLinkLen(s,l){ const A=hvDev(s,l.a), B=hvDev(s,l.b); if(!A||!B) return {plan:0,drop:0,len:0};
  const P=[[A.x,A.y],...(l.via||[]),[B.x,B.y]]; let plan=0; for(let i=1;i<P.length;i++) plan+=Math.hypot(P[i][0]-P[i-1][0],P[i][1]-P[i-1][1]);
  const zr=hvRunZ(s,A,B,l), drop=Math.abs(zr-(A.z||0))+Math.abs(zr-(B.z||0)); return {plan,drop,len:plan+drop}; }
function hvLinkPath(s,l){ const A=hvDev(s,l.a), B=hvDev(s,l.b); if(!A||!B) return null; const zr=hvRunZ(s,A,B,l);
  return [[A.x,A.y,A.z||0],[A.x,A.y,zr],...(l.via||[]).map(q=>[q[0],q[1],zr]),[B.x,B.y,zr],[B.x,B.y,B.z||0]]; }

// ---------- комнаты ----------
// назначение по названию комнаты (русские и английские слова)
function hvGuessUse(name){ const t=String(name||'').toLowerCase();
  const T=[[/kitchen|кухн|столов/,'kitchen'],[/bath|shower|ванн|душ/,'bath'],[/wc|toilet|туалет|санузел|уборн/,'wc'],[/laundry|прачеч|стираль/,'laundry'],[/boiler|furnace|котельн|топочн/,'boiler'],
    [/bed|nursery|спальн|детск/,'bedroom'],[/hall|corr|lobby|vest|коридор|прихож|холл|тамбур|вестибюл/,'hall'],[/garage|гараж/,'garage'],[/pantry|store|кладов/,'store'],[/office|study|кабинет/,'office']];
  for(const [re,u] of T) if(re.test(t)) return u; return 'living'; }
const hvRoomUse=r=>HV_USES.includes(r.use) ? r.use : hvGuessUse(r.name);
function hvRoomZ(s,r){ if(r.z0!=null && isFinite(+r.z0)) return +r.z0; const L=(s.levels||[]).find(q=>q.idx===(r.lv||0)); return L ? +L.z : 0; }
function hvRoomH(s,r){ let h=0; for(let i=0;i<r.pts.length;i++){ const a=r.pts[i], b=r.pts[(i+1)%r.pts.length]; for(const w of s.walls) if(w.h>0 && ((w.a===a&&w.b===b)||(w.a===b&&w.b===a))) h=Math.max(h,w.h); }
  if(!h){ const P=peRoomPoly(s,r); let cx=0,cy=0; for(const q of P){ cx+=q[0]/P.length; cy+=q[1]/P.length; }
    for(const w of s.walls){ if((w.lv||0)!==(r.lv||0)) continue; const [a,b]=peWallEnds(s,w); if(a&&b&&peInPoly(P,(a.x+b.x)/2+(cx-(a.x+b.x)/2)*.02,(a.y+b.y)/2+(cy-(a.y+b.y)/2)*.02)) h=Math.max(h,w.h); } }
  return h>0 ? h : (r.h>0 ? r.h : 2.7); }
const hvCentroid=P=>{ let x=0,y=0; for(const q of P){ x+=q[0]; y+=q[1]; } return [x/P.length,y/P.length]; };
function hvRoomOf(infos,x,y,z){ let best=null; for(const R of infos){ if(!peInPoly(R.P,x,y)) continue; if(z<R.z0-.6||z>R.z0+R.h+.6) continue; if(!best||Math.abs(z-R.z0)<Math.abs(z-best.z0)) best=R; } return best; }

// сопротивление теплопередаче стены → U, Вт/(м²·К)
function hvWallU(w,ins){ const m=w.mat;
  if(m==='glass') return 5.8; if(m==='mesh'||m==='cord') return 0;
  const lam=HV_LAM[m]||.7; return 1/(.17+(w.t>0 ? w.t : .2)/lam+(ins>0 ? ins/1000/.04 : 0)); }

// стена, на которую опирается сторона i комнаты (по геометрии: параллельна, середина стороны — у оси стены)
function hvEdgeWall(s,r,a,b){ const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2, ex=b[0]-a[0], ey=b[1]-a[1], el=Math.hypot(ex,ey)||1; let best=null;
  for(const w of s.walls){ if((w.lv||0)!==(r.lv||0)) continue; const [p,q]=peWallEnds(s,w); if(!p||!q) continue;
    const dx=q.x-p.x, dy=q.y-p.y, L=Math.hypot(dx,dy)||1; if(Math.abs(dx*ey-dy*ex)/(L*el)>.12) continue;
    const u=Math.max(0,Math.min(1,((mx-p.x)*dx+(my-p.y)*dy)/(L*L))), d=Math.hypot(mx-(p.x+dx*u),my-(p.y+dy*u)); if(d>(w.t||.2)/2+.3) continue;
    if(!best||d<best.d) best={w,d}; }
  return best ? best.w : null; }

// ---------- вентиляция: норма по назначению комнаты, м³/ч ----------
function hvNorm(R,boilerKW){ const u=R.use, A=R.area, V=R.vol;
  if(u==='living'||u==='bedroom'||u==='office') return {q:Math.max(3*A,30*R.people),dir:'supply'};
  if(u==='kitchen') return {q:R.gas ? 90 : 60,dir:'extract'};
  if(u==='bath'||u==='wc'||u==='laundry') return {q:25,dir:'extract'};
  if(u==='boiler') return {q:Math.max(3*V,1.2*boilerKW),dir:'extract'};
  return {q:0,dir:'none'}; }                                                                           // коридор, гараж, кладовая — переток

// ---------- труба / воздуховод ----------
const HV_NU_W=.478e-6, HV_RHO_W=977;                                                                  // вода 60 °C
function hvPipeDrop(G,di){ const v=G/3600/1000/(Math.PI*di*di/4e6), Re=v*di/1000/HV_NU_W, lam=Re<2300 ? 64/Math.max(Re,1) : .3164/Math.pow(Re,.25); return {v,R:lam/(di/1000)*HV_RHO_W*v*v/2}; }   // G — л/ч, di — мм; R — Па/м
function hvDuctDrop(q,d){ const v=q/3600/(Math.PI*d*d/4e6), Re=v*d/1000/15e-6, lam=.11*Math.pow(.1/d+68/Math.max(Re,1),.25); return {v,R:lam/(d/1000)*1.2*v*v/2}; }                   // q — м³/ч, d — мм
const hvDuctVmax=q=>q>=250 ? 5 : q>=100 ? 4 : 3;
function hvPickPipe(G,vmax){ for(const [dn,di] of HV_PIPES){ const d=hvPipeDrop(G,di); if(d.v<=vmax && d.R<=200) return {dn,di}; }                 // и скорость, и удельное сопротивление (≤ 200 Па/м)
   const l=HV_PIPES[HV_PIPES.length-1]; return {dn:l[0],di:l[1]}; }
function hvPickDuct(q){ const vm=hvDuctVmax(q); for(const d of HV_DUCTS) if(hvDuctDrop(q,d).v<=vm) return d; return HV_DUCTS[HV_DUCTS.length-1]; }
const hvDnDi=dn=>{ const r=HV_PIPES.find(p=>p[0]===dn); return r ? r[1] : dn*.8; };

// ---------- сеть: обход от корней по дереву ----------
function hvTree(s,rootId,pred){ const adj=new Map(); for(const l of s.pp||[]){ const A=hvDev(s,l.a), B=hvDev(s,l.b); if(!A||!B||!pred(A)||!pred(B)) continue; (adj.get(l.a)||adj.set(l.a,[]).get(l.a)).push([l.b,l]); (adj.get(l.b)||adj.set(l.b,[]).get(l.b)).push([l.a,l]); }
  const order=[rootId], par=new Map([[rootId,null]]);
  for(let i=0;i<order.length;i++){ for(const [nb,l] of adj.get(order[i])||[]){ if(par.has(nb)) continue; par.set(nb,{from:order[i],link:l}); order.push(nb); } }
  return {order,par}; }

// ---------- расчёт ----------
function hvCalc(s,o={}){
  const opt={...HV_DEF,...o}, dT=Math.max(5,opt.ts-opt.tr), tmean=(opt.ts+opt.tr)/2, warns=[];
  s.hv??=[]; s.pp??=[];
  const infos=s.rooms.map(r=>{ const P=peRoomPoly(s,r), use=hvRoomUse(r), area=peRoomArea(s,r), h=hvRoomH(s,r);
    const people=r.people>=0&&r.people!=null&&r.people!=='' ? +r.people : use==='bedroom' ? (area>=14 ? 2 : 1) : use==='living' ? Math.max(1,Math.round(area/18)) : use==='office' ? 1 : 0;
    return {r,id:r.id,name:r.name||r.id,P,use,area,h,vol:area*h,z0:hvRoomZ(s,r),lv:r.lv||0,tin:r.tin>0||r.tin<0 ? +r.tin : HV_TIN[use],gas:!!r.gas,people,cen:hvCentroid(P),dev:[],trans:{walls:0,win:0,door:0,floor:0,roof:0},vent:0,pipe:0,warn:[]}; });
  // устройства по комнатам
  for(const d of s.hv){ d.room=undefined; const R=hvRoomOf(infos,d.x,d.y,d.z||0); if(R){ R.dev.push(d); d.room=R.id; } }
  const roomDev=(R,t)=>R.dev.filter(d=>d.type===t);
  // трансмиссия: стены (наружные — к наружному воздуху, внутренние — к соседней комнате), окна и двери, пол по грунту, кровля
  for(const R of infos){ const P=R.P, dTo=R.tin-opt.tout;
    for(let i=0;i<P.length;i++){ const a=P[i], b=P[(i+1)%P.length], L=Math.hypot(b[0]-a[0],b[1]-a[1]); if(L<.05) continue;
      const w=hvEdgeWall(s,R.r,a,b); if(!w){ continue; }
      const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2, ex=(b[0]-a[0])/L, ey=(b[1]-a[1])/L; let nx=ey, ny=-ex; if(peInPoly(P,mx+nx*.05,my+ny*.05)){ nx=-nx; ny=-ny; }
      const q=[mx+nx*((w.t||.2)+.3),my+ny*((w.t||.2)+.3)], nb=infos.find(Q=>Q!==R&&Q.lv===R.lv&&peInPoly(Q.P,q[0],q[1]));
      const dTe=nb ? R.tin-nb.tin : dTo; if(Math.abs(dTe)<.01) continue;
      let aw=L*R.h, aWin=0, aDoor=0;
      for(const ob of s.objs){ if(ob.wall!==w.id||(ob.type!=='door'&&ob.type!=='window')) continue; const pl=peOpenPlace(s,ob); if(!pl) continue;
        const u=(pl.x-a[0])*ex+(pl.y-a[1])*ey, dn=Math.abs((pl.x-a[0])*ey-(pl.y-a[1])*ex); if(u<-.05||u>L+.05||dn>(w.t||.2)/2+.3) continue;
        const ar=Math.max(0,ob.w*ob.h); if(ob.type==='window') aWin+=ar; else aDoor+=ar; }
      const aOp=Math.min(aWin+aDoor,aw*.9); if(aWin+aDoor>0){ const k=aOp/(aWin+aDoor); aWin*=k; aDoor*=k; } aw=Math.max(0,aw-aOp);
      R.trans.walls+=hvWallU(w,nb ? 0 : opt.ins)*aw*dTe; R.trans.win+=opt.uw*aWin*dTe; R.trans.door+=opt.ud*aDoor*dTe; }
    // пол по грунту: на нижнем уровне (b-фактор 0,6); кровля — если над комнатой нет другой
    if(R.lv<=0 && !R.r.nofloor) R.trans.floor+=opt.floorU*R.area*(R.tin-opt.tout)*.6;
    if(!infos.some(Q=>Q.lv>R.lv && peInPoly(Q.P,R.cen[0],R.cen[1])) && !R.r.noroof) R.trans.roof+=opt.roofU*R.area*(R.tin-opt.tout);
    R.trans.sum=(R.trans.walls+R.trans.win+R.trans.door+R.trans.floor+R.trans.roof)*opt.kb; }
  // воздухообмен: норма комнат → баланс (приток = вытяжка = большее из двух)
  const boilerKW=s.hv.filter(d=>d.type==='boiler').reduce((a,d)=>a+(+d.watt||0),0)/1000;
  let Ssup=0, Sext=0; for(const R of infos){ const n=hvNorm(R,R.use==='boiler' ? boilerKW : 0); R.norm=n.q; R.dir=n.dir; if(n.dir==='supply') Ssup+=n.q; else if(n.dir==='extract') Sext+=n.q; }
  const Qtot=Math.max(Ssup,Sext);
  for(const R of infos){ R.air=R.dir==='supply' && Ssup>0 ? R.norm*Qtot/Ssup : R.dir==='extract' && Sext>0 ? R.norm*Qtot/Sext : 0; R.ach=R.vol>0 ? R.air/R.vol : 0; }
  const ahu=s.hv.filter(d=>d.type==='ahu'), eta=ahu.length ? Math.max(0,Math.min(.95,(+ahu[0].eff||0)/100))*Math.min(1,(ahu.reduce((a,d)=>a+(+d.m3||0),0))/Math.max(Qtot,1)) : 0;
  const supRooms=infos.filter(R=>R.dir==='supply');
  for(const R of infos){ const inflow=supRooms.length ? (R.dir==='supply' ? R.air : 0) : (R.dir==='extract' ? R.air : 0);        // приточный воздух греется в приточных комнатах (нет их — в вытяжных)
    R.vent=.335*inflow*(R.tin-opt.tout)*(1-eta); R.loss=R.trans.sum+R.vent; R.wm2=R.area>0 ? R.loss/R.area : 0; }
  // приборы отопления в комнате
  for(const R of infos){ const kr=Math.pow(Math.max(0,(tmean-R.tin)/50),1.3);
    R.rad=roomDev(R,'radiator').reduce((a,d)=>a+(+d.watt||0)*kr,0);
    R.floorW=roomDev(R,'floor').reduce((a,d)=>a+(+d.watt>0 ? +d.watt : (+d.area||0)*opt.qf),0);
    R.heater=roomDev(R,'heater').reduce((a,d)=>a+(+d.watt||0),0);
    R.inst=R.rad+R.floorW+R.heater; R.cover=R.loss>0 ? R.inst/R.loss : 1;
    R.need=R.loss>0 ? R.loss/Math.max(kr,.05) : 0;                                                     // номинал радиаторов (ΔT 50 К), покрывающий потери
    if(R.floorW>0 && R.area>0 && R.floorW/R.area>100) R.warn.push('floor heating gives '+Math.round(R.floorW/R.area)+' W/m² — above the comfort limit of ~100 W/m² (29 °C floor)');
    if(R.norm>0 && s.hv.some(d=>hvIsAir(d.type))){ const want=R.dir==='supply' ? 'supply' : 'extract'; if(!roomDev(R,want).length) R.warn.push('no '+want+' terminal for '+Math.round(R.air)+' m³/h'); } }
  // водяная сеть
  const heat={segs:[],pump:null,loops:[],boilers:s.hv.filter(d=>d.type==='boiler').map(d=>d.name)}, seenH=new Set();
  const emit=d=>d.type==='radiator' ? (+d.watt||0)*Math.pow(Math.max(0,(tmean-((hvRoomOf(infos,d.x,d.y,d.z||0)||{tin:20}).tin))/50),1.3) : d.type==='floor' ? (+d.watt>0 ? +d.watt : (+d.area||0)*opt.qf) : 0;
  for(const B of s.hv.filter(d=>d.type==='boiler')){ const T=hvTree(s,B.id,d=>hvIsHeat(d.type)); const cur=new Map(T.order.map(id=>[id,emit(hvDev(s,id))]));
    for(let i=T.order.length-1;i>0;i--){ const p=T.par.get(T.order[i]); cur.set(p.from,(cur.get(p.from)||0)+cur.get(T.order[i])); }
    const pathDp=new Map([[B.id,0]]); let worst=0, worstName='';
    for(let i=1;i<T.order.length;i++){ const id=T.order[i], p=T.par.get(id), l=p.link, P=cur.get(id)||0, G=P/(1.163*dT)/.977; seenH.add(id);
      const auto=hvPickPipe(G,opt.vmax), dn=l.dn>0 ? l.dn : auto.dn, di=l.dn>0 ? hvDnDi(l.dn) : auto.di, dp=hvPipeDrop(G,di), Ls=hvLinkLen(s,l).len, dPa=dp.R*Ls*2*1.3;           // подача + обратка, местные +30 %
      pathDp.set(id,(pathDp.get(p.from)||0)+dPa);
      const bad=[]; if(dp.v>opt.vmax*1.15 && P>0) bad.push('velocity '+dp.v.toFixed(2)+' m/s is above '+opt.vmax+' m/s (noise): take a larger pipe');
      heat.segs.push({link:l.id,from:hvDev(s,p.from).name,to:hvDev(s,id).name,P,G,dn,auto:auto.dn,v:dp.v,R:dp.R,len:Ls,dPa,warn:bad,ok:!bad.length}); }
    for(const id of T.order){ const d=hvDev(s,id); if(d.type!=='radiator'&&d.type!=='floor') continue; const dd=(pathDp.get(id)||0)+(d.type==='floor' ? 15000 : 8000); if(dd>worst){ worst=dd; worstName=d.name; } }
    const Ptot=cur.get(B.id)||0, Gtot=Ptot/(1.163*dT)/.977; if(T.order.length>1) heat.pump=heat.pump ? {...heat.pump,G:heat.pump.G+Gtot} : {G:Gtot,dp:worst,far:worstName,head:worst/(HV_RHO_W*9.81)};
    if(T.order.length>1 && Ptot>B.watt+1) warns.push('boiler '+B.name+' is smaller than the emitters on its pipes ('+Math.round(Ptot)+' W)'); }
  // тепло самих труб: по трассе шагом 0,25 м — в комнату, где она проходит (подача и обратка); в неотапливаемую (tin < 12) и вне комнат — потери
  heat.pipeGain=0; heat.pipeLoss=0; heat.pipeRooms=[];
  { const byRoom=new Map(); for(const g of heat.segs){ const l=s.pp.find(x=>x.id===g.link), pa=l&&hvLinkPath(s,l); if(!pa) continue; const A=hvDev(s,l.a), B=hvDev(s,l.b), zl=((A.z||0)+(B.z||0))/2, d=g.dn*Math.PI/1000, U=l.ins ? HV_PIPE_U : HV_PIPE_H*d; g.q=0; g.ins=!!l.ins;
      const P=[]; for(let i=1;i<pa.length-1;i++) P.push(pa[i]);                                                                  // горизонтальная часть: от высоты трассы у A до высоты у B
      for(let i=1;i<P.length;i++){ const x0=P[i-1][0], y0=P[i-1][1], x1=P[i][0], y1=P[i][1], L=Math.hypot(x1-x0,y1-y0), n=Math.max(1,Math.ceil(L/.25)), st=L/n;
        for(let k=0;k<n;k++){ const u=(k+.5)/n, x=x0+(x1-x0)*u, y=y0+(y1-y0)*u, R=hvRoomOf(infos,x,y,zl)||[[.3,0],[-.3,0],[0,.3],[0,-.3]].map(o=>hvRoomOf(infos,x+o[0],y+o[1],zl)).find(Boolean), Ta=R ? R.tin : opt.tout, w=U*st*((opt.ts-Ta)+(opt.tr-Ta)); if(w<=0) continue; g.q+=w;
          const heated=R && R.tin>=12; if(heated){ R.pipe+=w; heat.pipeGain+=w; } else { heat.pipeLoss+=w; const key=R ? R.id : '—'; byRoom.set(key,(byRoom.get(key)||0)+w); } } } }
    heat.pipeRooms=[...byRoom].map(([id,w])=>({room:id==='—' ? 'outside the rooms' : (infos.find(R=>R.id===id)||{name:id}).name,W:w})); }
  for(const R of infos){ R.inst+=R.pipe; R.cover=R.loss>0 ? R.inst/R.loss : 1;
    if(R.loss>1 && R.tin>=12 && R.inst<=0) R.warn.unshift('no heating device');
    else if(R.loss>1 && R.cover<.95) R.warn.unshift('heating covers only '+Math.round(R.cover*100)+'% of the loss (needs '+Math.round(R.loss)+' W, has '+Math.round(R.inst)+' W'+(R.pipe>0 ? ', of them pipes '+Math.round(R.pipe)+' W' : '')+')'); }
  // котёл
  const hydro=infos.filter(R=>R.rad>0||R.floorW>0||R.pipe>0), demand=hydro.reduce((a,R)=>a+R.loss,0)+heat.pipeLoss+(+opt.dhw||0);
  const boilerW=s.hv.filter(d=>d.type==='boiler').reduce((a,d)=>a+(+d.watt||0),0), boilerNeed=demand*1.1;
  if(hydro.length && !boilerW) warns.push('radiators without a boiler: add a boiler and connect it with pipes'); else if(boilerW && boilerW<boilerNeed-1) warns.push('boiler '+Math.round(boilerW)+' W is below the demand '+Math.round(boilerNeed)+' W (loss '+Math.round(demand)+' W + 10%)');
  for(const d of s.hv) if((d.type==='radiator'||d.type==='floor') && !seenH.has(d.id)) warns.push((d.type==='radiator' ? 'radiator ' : 'floor loop ')+d.name+' is not connected to a boiler by pipes');
  for(const d of s.hv.filter(d=>d.type==='floor')){ const len=(+d.area||0)/.15, n=Math.max(1,Math.ceil(len/100)); heat.loops.push({name:d.name,area:+d.area||0,len,loops:n,each:len/n}); }
  // воздушная сеть
  const air={segs:[],units:[],terminals:[]}, termQ=new Map(), seenA=new Set();
  for(const R of infos){ for(const dir of ['supply','extract']){ const T=roomDev(R,dir); if(!T.length) continue; const want=R.dir===dir ? R.air : 0; const fixed=T.reduce((a,d)=>a+(+d.m3||0),0), free=T.filter(d=>!(+d.m3>0)).length;
      for(const d of T) termQ.set(d.id,+d.m3>0 ? +d.m3 : free ? Math.max(0,want-fixed)/free : 0); } }
  for(const d of s.hv.filter(d=>d.type==='supply'||d.type==='extract')) if(!termQ.has(d.id)) termQ.set(d.id,+d.m3||0);
  const roots=s.hv.filter(d=>d.type==='ahu'||d.type==='fan');
  for(const U of roots){ const T=hvTree(s,U.id,d=>hvIsAir(d.type)), cur={supply:new Map(),extract:new Map()};
    for(const id of T.order){ const d=hvDev(s,id); for(const k of ['supply','extract']) cur[k].set(id,d.type===k ? termQ.get(id)||0 : 0); }
    for(const k of ['supply','extract']) for(let i=T.order.length-1;i>0;i--){ const p=T.par.get(T.order[i]); cur[k].set(p.from,(cur[k].get(p.from)||0)+cur[k].get(T.order[i])); }
    const path={supply:new Map([[U.id,0]]),extract:new Map([[U.id,0]])}; const need={supply:0,extract:0};
    for(let i=1;i<T.order.length;i++){ const id=T.order[i], p=T.par.get(id), l=p.link; seenA.add(id);
      const qs=cur.supply.get(id)||0, qe=cur.extract.get(id)||0, kind=qs>0&&qe>0 ? 'mixed' : qs>0 ? 'supply' : qe>0 ? 'extract' : (hvDev(s,id).type==='extract' ? 'extract' : 'supply'), q=qs+qe;
      const d=l.dn>0 ? l.dn : hvPickDuct(q), dp=hvDuctDrop(q,d), Ls=hvLinkLen(s,l).len, dPa=dp.R*Ls*1.4;
      for(const k of ['supply','extract']) path[k].set(id,(path[k].get(p.from)||0)+dPa);
      const bad=[]; if(dp.v>hvDuctVmax(q)*1.15 && q>0) bad.push('velocity '+dp.v.toFixed(1)+' m/s is above '+hvDuctVmax(q)+' m/s (noise): take a larger duct'); if(kind==='mixed') bad.push('a duct carries supply and extract air at once');
      air.segs.push({link:l.id,unit:U.name,from:hvDev(s,p.from).name,to:hvDev(s,id).name,kind,q,d,auto:hvPickDuct(q),v:dp.v,R:dp.R,len:Ls,dPa,warn:bad,ok:!bad.length}); }
    for(const id of T.order){ const d=hvDev(s,id); if(d.type==='supply') need.supply=Math.max(need.supply,(path.supply.get(id)||0)+25); if(d.type==='extract') need.extract=Math.max(need.extract,(path.extract.get(id)||0)+25); }
    const qS=cur.supply.get(U.id)||0, qE=cur.extract.get(U.id)||0, q=U.type==='ahu' ? Math.max(qS,qE) : qE||qS, bad=[];
    if(+U.m3>0 && q>+U.m3*1.001) bad.push('needs '+Math.round(q)+' m³/h, the unit gives '+Math.round(U.m3));
    for(const k of ['supply','extract']) if(need[k]>(+U.pa||0)+1e-6 && need[k]>25) bad.push(k+' side loses '+Math.round(need[k])+' Pa, the unit gives '+Math.round(U.pa||0)+' Pa');
    air.units.push({name:U.name,type:U.type,supply:qS,extract:qE,q,rated:+U.m3||0,eff:+U.eff||0,pa:+U.pa||0,needSup:need.supply,needExt:need.extract,warn:bad,ok:!bad.length}); }
  for(const d of s.hv) if((d.type==='supply'||d.type==='extract') && !seenA.has(d.id) && roots.length) warns.push((d.type==='supply' ? 'supply terminal ' : 'extract grille ')+d.name+' is not connected to a unit by ducts');
  const mechSup=air.units.reduce((a,u)=>a+u.supply,0), mechExt=air.units.reduce((a,u)=>a+u.extract,0);
  // итоги
  const sum=k=>infos.reduce((a,R)=>a+R[k],0), loss=sum('loss'), trans=infos.reduce((a,R)=>a+R.trans.sum,0), vent=sum('vent'), Vtot=sum('vol'), Atot=sum('area');
  const heated=infos.filter(R=>R.tin>=12), dRef=heated.length ? heated.reduce((a,R)=>a+R.tin*R.area,0)/heated.reduce((a,R)=>a+R.area,0)-opt.tout : 20-opt.tout;
  const kwh=dRef>0 ? (loss+heat.pipeLoss)/dRef*24*opt.gd/1000 : 0, recov=ahu.length ? .335*Math.min(Qtot,ahu.reduce((a,d)=>a+(+d.m3||0),0))*(20-opt.tout)*Math.max(0,Math.min(.95,(+ahu[0].eff||0)/100)) : 0;
  const house={pipeGain:heat.pipeGain,pipeLoss:heat.pipeLoss,rooms:infos.length,area:Atot,vol:Vtot,loss,trans,vent,wm2:Atot>0 ? loss/Atot : 0,demand,boilerW,boilerNeed,Qtot,Qsup:Ssup,Qext:Sext,ach:Vtot>0 ? Qtot/Vtot : 0,mechSup,mechExt,recov,kwh,gas:kwh/(9.3*.92),eta,dRef,
    local:infos.reduce((a,R)=>a+R.heater,0)};
  if(Math.abs(mechSup-mechExt)>Math.max(20,.1*Math.max(mechSup,mechExt)) && mechSup>0 && mechExt>0) warns.push('supply '+Math.round(mechSup)+' and extract '+Math.round(mechExt)+' m³/h are unbalanced (house under '+(mechSup<mechExt ? 'negative' : 'positive')+' pressure)');
  return {opt,rooms:infos.map(R=>({id:R.id,name:R.name,use:R.use,area:R.area,h:R.h,vol:R.vol,tin:R.tin,people:R.people,gas:R.gas,trans:R.trans,vent:R.vent,loss:R.loss,wm2:R.wm2,rad:R.rad,floorW:R.floorW,heater:R.heater,inst:R.inst,pipe:R.pipe,cover:R.cover,need:R.need,norm:R.norm,dir:R.dir,air:R.air,ach:R.ach,cen:R.cen,dev:R.dev.map(d=>d.name),warn:R.warn})),house,heat,air,warns};
}

// сводка: числа устройств, длины трасс (труб — с подачей и обраткой)
function hvStats(s){ const n={}, len={pipe:0,duct:0}; for(const d of s.hv||[]) n[d.type]=(n[d.type]||0)+1; for(const l of s.pp||[]){ const k=hvLinkKind(s,l), L=hvLinkLen(s,l).len; len[k]+=k==='pipe' ? L*2 : L; } return {n,pipe:len.pipe,duct:len.duct}; }

// назначение комнат и устройства из Site Plan: r.hv [{type,name,x,y,z,watt,…}], r.pp [{a,b,dn,z}], r.uses [{name,use,people,tin,gas}]
function hvImport(s,r,pre){ s.hv??=[]; s.pp??=[];
  const keep=new Set(); for(const q of r.hv||[]){ if(!HV_T[q.type]) continue; const src=pre+'hv:'+q.name; keep.add(src); let d=s.hv.find(x=>x.src===src);
    if(!d){ d=hvAdd(s,q.type,+q.x,+q.y,{}); d.src=src; }
    Object.assign(d,{name:String(q.name),x:+q.x,y:+q.y,z:+q.z,watt:+q.watt||0}); for(const k of ['area','m3','eff','pa']) if(q[k]!=null) d[k]=+q[k]; if(q.fuel) d.fuel=q.fuel; }
  s.hv=s.hv.filter(d=>!d.src||!d.src.startsWith(pre)||keep.has(d.src));
  const lk=new Set(); for(const q of r.pp||[]){ const A=s.hv.find(d=>d.src===pre+'hv:'+q.a), B=s.hv.find(d=>d.src===pre+'hv:'+q.b); if(!A||!B||A===B) continue;
    const src=pre+'pp:'+q.a+'-'+q.b; let l=s.pp.find(x=>x.src===src); if(!l){ l=hvLink(s,A.id,B.id,{}); if(!l) continue; l.src=src; } lk.add(src);
    if(q.ins) l.ins=true; else delete l.ins; if(+q.dn>0) l.dn=+q.dn; else l.dn=0; if(+q.z>0) l.zr=+q.z; else delete l.zr; }
  s.pp=s.pp.filter(l=>(!l.src||!l.src.startsWith(pre)||lk.has(l.src)) && hvDev(s,l.a) && hvDev(s,l.b));
  for(const u of r.uses||[]){ const room=s.rooms.find(q=>q.name===u.name); if(!room) continue; if(HV_USES.includes(u.use)) room.use=u.use; if(u.people>=0&&u.people!=null) room.people=+u.people; if(u.tin>0) room.tin=+u.tin; if(u.gas) room.gas=true; }
}
