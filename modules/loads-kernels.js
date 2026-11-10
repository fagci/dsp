"use strict";
/* ============================ Нагрузки на конструкцию: ядро ============================
   Предварительная оценка по сцене Plan Editor (не заменяет расчёт конструктора): постоянные (собственный вес стен по материалу, перекрытий, кровли), полезные по назначению
   комнат (СП 20.13330, табл. 8.3, упрощённо), снег (μ = 1 до 30°, линейно до 0 на 60°; район или город) → линейная нагрузка на несущие стены сверху вниз по этажам
   (стена опирается на стену под собой, иначе помечается «на перекрытии»), проверка кладки на сжатие с учётом простенков и гибкости, перемычки над проёмами (момент → двутавр),
   перекрытия (пролёт, толщина и арматура монолитной плиты / сечение деревянных балок), стропила, фундамент (ширина ленты по грунту, сваи, среднее давление плитой).
   Коэффициенты надёжности: постоянные 1,1, полезные 1,3 (1,2 при ≥ 2 кПа), снег 1,4; фундамент — по нормативным (без коэффициентов).
   Берёт готовые функции planedit-kernels.js и hvac-kernels.js (pePt, peInPoly, peRoomPoly, peWallEnds, peOpenPlace, hvEdgeWall, hvRoomUse…). Ядро чистое: node tools/test-loads.mjs */

const LD_GAMMA={brick:18,concrete:25,block:6,drywall:9,wood:5,glass:25,metal:78,picket:5,euro:78,weld:78,bars:78,stone:17,hedge:1};   // плотность стены, кН/м³ (кирпич — сплошной 1800 кг/м³, газоблок D600)
const LD_RM={brick:1.5,block:1.0,concrete:14.5,wood:13};                                           // расчётное сопротивление сжатию, МПа (кладка М100 / М50; блок D600 B2,5; бетон B25)
const LD_LIVE={living:1.5,bedroom:1.5,kitchen:1.5,bath:1.5,wc:1.5,laundry:1.5,boiler:2,hall:3,office:2,garage:2.5,store:2};     // кПа
const LD_SOIL={'gravel / coarse sand':400,'sand, medium dense':300,'clay, semi-solid':250,'loam':200,'clay, plastic':150,'silty / wet sand':100,'peat / soft':60};   // расчётное сопротивление грунта R0, кПа
const LD_SNOW={'Moscow':1.5,'Saint Petersburg':1.5,'Novosibirsk':2.0,'Yekaterinburg':2.0,'Kazan':2.0,'Samara':1.5,'Krasnoyarsk':1.5,'Irkutsk':1.0,'Vladivostok':1.0,'Krasnodar':.5,'Kyiv':1.5,'Minsk':1.2,'Almaty':1.5};   // кПа, приближённо
const LD_FLOORS={timber:{label:'timber beams',g:1.2},hollow:{label:'hollow-core slab',g:3.3},mono:{label:'monolithic RC slab',g:null}};
const LD_TIMBER=[[.05,.15],[.05,.2],[.05,.25],[.1,.2],[.1,.25],[.15,.25],[.2,.25]];                // сечения балок, b × h, м
const LD_IBEAM=[[10,39.7],[12,58.4],[14,81.7],[16,109],[18,143],[20,184],[22,232],[24,289],[27,371],[30,472],[33,597],[36,743],[40,953]];   // двутавр: номер, W, см³
const LD_DEF={snow:1.5,R0:300,depth:1.0,floor:'mono',roofG:.6,found:'strip',pile:100,floorFinish:1.7};
const ldGq=p=>p>=2 ? 1.2 : 1.3, LD_GG=1.1, LD_GS=1.4;
const ldMu=a=>a<=30 ? 1 : a>=60 ? 0 : (60-a)/30;
const ldCeil=(v,s)=>Math.ceil(v/s-1e-9)*s;

function ldCalc(s,o={}){
  const opt={...LD_DEF,...o}, warns=[], lvOf=x=>x.lv||0;
  const rooms=(s.rooms||[]).map(r=>{ const P=peRoomPoly(s,r); const xs=P.map(p=>p[0]), ys=P.map(p=>p[1]); return {r,P,lv:lvOf(r),area:P.length>2 ? peRoomArea(s,r) : 0,use:hvRoomUse(r),per:0,cen:hvCentroid(P),bw:Math.min(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))}; }).filter(R=>R.P.length>2);
  const W=(s.walls||[]).filter(w=>!w.fk && w.mat!=='mesh' && w.mat!=='cord' && peWallLen(s,w)>.05);
  // стены: длина, этаж, роль (наружная / внутренняя), несущая ли, проёмы
  const walls=W.map(w=>{ const [a,b]=peWallEnds(s,w), L=peWallLen(s,w), t=w.t>0 ? w.t : .2, h=w.h>0 ? w.h : 2.7, ux=(b.x-a.x)/L, uy=(b.y-a.y)/L, mx=(a.x+b.x)/2, my=(a.y+b.y)/2, off=t/2+.15; let n=0;
    for(const sg of [1,-1]) if(rooms.some(R=>R.lv===lvOf(w) && peInPoly(R.P,mx-uy*off*sg,my+ux*off*sg))) n++;
    const ops=(s.objs||[]).filter(o=>o.wall===w.id && (o.type==='door'||o.type==='window')), opA=ops.reduce((q,o)=>q+Math.max(0,o.w*o.h),0), opW=ops.reduce((q,o)=>q+o.w,0);
    const masonry=!['drywall','glass','metal','wood'].includes(w.mat) || (w.mat==='wood' && t>=.15), auto=n>=1 && masonry && (n===1 || t>=.18);
    const bear=w.bear==='yes' ? true : w.bear==='no' ? false : auto;
    return {w,id:w.id,lv:lvOf(w),L,t,h,a,b,ux,uy,mx,my,mat:w.mat,n,role:n===1 ? 'outer' : n===2 ? 'inner' : 'free',bear,ops,opA,opW,top:{g:0,v:0,s:0},own:0,up:{g:0,v:0,s:0},unsup:0}; });
  for(const k of walls) k.own=LD_GAMMA[k.mat]*k.t*Math.max(0,k.h-k.opA/k.L)||0;
  const byId=new Map(walls.map(k=>[k.id,k]));
  // перекрытия: комната → нагрузка сверху (этаж над ней или чердачное перекрытие) → поровну на несущие стороны
  const slabs=[], roomsAbove=R=>rooms.filter(U=>U.lv>R.lv && peInPoly(U.P,R.cen[0],R.cen[1])).sort((u,v)=>u.lv-v.lv)[0]||null;
  const slabRec=(s.slabs||[]).find(q=>q.mat==='concrete'||q.t>0), slabT=slabRec ? slabRec.t : .22;
  const fl=LD_FLOORS[opt.floor]||LD_FLOORS.mono, slabG=opt.floor==='mono' ? 25*slabT : fl.g;
  for(const R of rooms){ const U=roomsAbove(R), g=(U ? slabG+opt.floorFinish : .8), v=U ? LD_LIVE[U.use] ?? 1.5 : .7;
    const edges=[]; for(let i=0;i<R.P.length;i++){ const A=R.P[i], B=R.P[(i+1)%R.P.length], L=Math.hypot(B[0]-A[0],B[1]-A[1]); if(L<.05) continue; const w=hvEdgeWall(s,R.r,A,B), k=w ? byId.get(w.id) : null; edges.push({L,k}); R.per+=L; }
    const bearing=edges.filter(e=>e.k && e.k.bear), Lb=bearing.reduce((q,e)=>q+e.L,0);
    if(!bearing.length){ if(U) warns.push('the slab of '+(R.r.name||R.r.id)+' bears on no bearing wall'); continue; }
    for(const e of bearing){ e.k.top.g+=g*R.area/Lb; e.k.top.v+=v*R.area/Lb; }
    if(U) slabs.push({room:R.r.name||R.r.id,span:R.bw,g,v,above:U.r.name||U.r.id,lv:R.lv}); }
  // кровля: стропила, снег на проекции, нагрузка на стены у свесов (нижние кромки скатов)
  const roofs=[]; let roofG=0, roofS=0, roofA=0, roofP=0; const top=walls.length ? Math.max(...walls.map(k=>k.lv)) : 0, topW=walls.filter(k=>k.lv===top && k.bear);
  const snowSg=+opt.snow;
  for(const rf of s.roofs||[]){ const F=(rf.faces||[]).filter(f=>f.kind==='roof' && f.pts && f.pts.length>=3); if(!F.length) continue; let gR=0, sR=0, A3=0; const eaves=[];
    for(const f of F){ const P=f.pts; let nx=0,ny=0,nz=0; for(let i=0;i<P.length;i++){ const p=P[i], q=P[(i+1)%P.length]; nx+=(p[1]-q[1])*(p[2]+q[2]); ny+=(p[2]-q[2])*(p[0]+q[0]); nz+=(p[0]-q[0])*(p[1]+q[1]); }
      const nl=Math.hypot(nx,ny,nz), A=nl/2, ca=nl>0 ? Math.abs(nz)/nl : 1, al=Math.acos(Math.min(1,ca))*180/Math.PI, zmin=Math.min(...P.map(p=>p[2]));
      gR+=A*opt.roofG; sR+=ldMu(al)*snowSg*A*ca; A3+=A; roofA+=A; roofP+=A*ca; let el=0; for(let i=0;i<P.length;i++){ const p=P[i], q=P[(i+1)%P.length]; if(Math.abs(p[2]-zmin)<.03 && Math.abs(q[2]-zmin)<.03){ eaves.push([p,q]); el+=Math.hypot(q[0]-p[0],q[1]-p[1]); } }
      roofs.push({kind:rf.type,angle:al,area:A,len:el,slope:el>0 ? A/el : 0,mu:ldMu(al),snow:ldMu(al)*snowSg,cos:ca}); }
    // стены под свесами
    const E=topW.filter(k=>eaves.some(([p,q])=>{ const dx=q[0]-p[0], dy=q[1]-p[1], l=Math.hypot(dx,dy)||1, cr=Math.abs(dx*k.uy-dy*k.ux)/l; if(cr>.15) return false; const d=Math.abs((k.mx-p[0])*dy-(k.my-p[1])*dx)/l, u=((k.mx-p[0])*dx+(k.my-p[1])*dy)/l; return d<=1.4 && u>-.5 && u<l+.5; }));
    const T=E.length ? E : topW.filter(k=>k.role==='outer'), LE=T.reduce((q,k)=>q+k.L,0);
    if(!T.length){ warns.push('the roof has no bearing wall under its eaves'); continue; }
    roofG+=gR; roofS+=sR; for(const k of T){ k.top.g+=gR/LE; k.top.s+=sR/LE; } }
  if(!(s.roofs||[]).length && walls.length) warns.push('no roof in the scene: the roof and the snow are not counted (a ceiling load is)');
  // сверху вниз: полная нагрузка у основания и передача на стены этажом ниже
  const lvls=[...new Set(walls.map(k=>k.lv))].sort((a,b)=>b-a);
  for(let li=0;li<lvls.length;li++){ const cur=walls.filter(k=>k.lv===lvls[li] && k.bear), low=lvls[li+1]!=null ? walls.filter(k=>k.lv===lvls[li+1] && k.bear) : [];
    for(const k of cur){ for(const q of ['g','v','s']) k.up[q]=k.top[q]+(q==='g' ? k.own : 0); if(!low.length) continue;
      const F={g:k.up.g*k.L,v:k.up.v*k.L,s:k.up.s*k.L}; const ov=[]; let sum=0;
      for(const l of low){ const cr=Math.abs(k.ux*l.uy-k.uy*l.ux); if(cr>.08) continue; const d=Math.abs((l.mx-k.mx)*k.uy-(l.my-k.my)*k.ux); if(d>Math.max(k.t,l.t)/2+.12) continue;
        const s0=((k.a.x-l.a.x)*l.ux+(k.a.y-l.a.y)*l.uy), s1=((k.b.x-l.a.x)*l.ux+(k.b.y-l.a.y)*l.uy), a0=Math.max(0,Math.min(s0,s1)), a1=Math.min(l.L,Math.max(s0,s1)), len=a1-a0; if(len>.05){ ov.push([l,len]); sum+=len; } }
      if(sum<.7*k.L){ k.unsup=1-sum/k.L; warns.push('wall '+k.id+' (floor '+peLvName(k.lv)+') rests on the slab over '+Math.round(k.unsup*100)+'% of its length: a beam or a wall under it is needed'); }
      for(const [l,len] of ov) for(const q of ['g','v','s']) l.top[q]+=F[q]*(len/Math.max(sum,k.L))/l.L; } }
  // проверка кладки и перемычки
  const res=[]; const lintels=[];
  for(const k of walls.filter(k=>k.bear)){ const base={g:k.top.g+k.own,v:k.top.v,s:k.top.s}, Nk=base.g+base.v+base.s, Nd=LD_GG*base.g+1.3*base.v+LD_GS*base.s;
    const Rm=LD_RM[k.mat]||0, lam=k.h/k.t, phi=Math.max(.5,1-.4*Math.max(0,lam-6)/19), pf=k.opW<k.L ? k.L/(k.L-k.opW) : 99, cap=phi*Rm*1000*k.t, ratio=cap>0 ? Nd*pf/cap : 0;
    // простенки
    const ops=k.ops.map(o=>[o.u*k.L-o.w/2,o.u*k.L+o.w/2]).sort((a,b)=>a[0]-b[0]); let prev=0, pier=k.L; for(const [x0,x1] of ops){ pier=Math.min(pier,Math.max(0,x0-prev)); prev=x1; } pier=Math.min(pier,Math.max(0,k.L-prev)); if(!ops.length) pier=k.L;
    const bad=[]; if(Rm===0) bad.push('the material «'+k.mat+'» is not for a bearing wall'); if(ratio>1) bad.push('the masonry is overstressed ('+Math.round(ratio*100)+'%): thicker wall, a stronger material or an extra wall'); else if(ratio>.85) bad.push('the margin is thin ('+Math.round(ratio*100)+'% of the capacity)');
    if(ops.length && pier<.64) bad.push('a pier of '+pier.toFixed(2)+' m between openings is narrower than 0.64 m');
    res.push({id:k.id,lv:k.lv,role:k.role,mat:k.mat,t:k.t,h:k.h,L:k.L,Nk,Nd,own:k.own,top:{...k.top},up:{...k.up},phi,cap,ratio,pier,openings:k.ops.length,unsup:k.unsup,x:k.mx,y:k.my,warn:bad});
    for(const bd of bad) if(!/thin/.test(bd)) warns.push('wall '+k.id+': '+bd);
    // перемычки над проёмами
    for(const o of k.ops){ const Le=o.w+.3, qd=LD_GG*k.top.g+1.3*k.top.v+LD_GS*k.top.s, Ptri=LD_GG*(LD_GAMMA[k.mat]||18)*k.t*o.w*o.w/4, M=qd*Le*Le/8+Ptri*Le/6, V=qd*Le/2+Ptri/2, Wr=M*100/24, n=Math.max(1,Math.round(k.t/.19)), per=Wr/n, I=LD_IBEAM.find(x=>x[1]>=per);
      lintels.push({wall:k.id,kind:o.type,w:o.w,span:Le,M,V,Wreq:Wr,n,ibeam:I ? I[0] : null,warn:I ? '' : 'a span this wide needs a calculated steel or RC beam'}); } }
  // перекрытия: толщина и арматура / сечение балки
  const floors=slabs.map(sl=>{ const L=Math.max(.5,sl.span), g=sl.g, v=sl.v, q=LD_GG*g+ldGq(v)*v, M=q*L*L/8, out={...sl,q,M,type:opt.floor};
    if(opt.floor==='mono'){ const tmin=Math.max(.1,ldCeil(L/30,.01)), t=Math.max(slabT,tmin), h0=t-.03, As=M/(.9*h0*435000)*1e4; Object.assign(out,{tmin,t,As,note:'t ≥ L/30 = '+(tmin*100).toFixed(0)+' cm; the slab is '+(t*100).toFixed(0)+' cm: A500 ≈ '+As.toFixed(1)+' cm²/m'}); if(slabT<tmin-1e-9) warns.push('slab over '+sl.room+': '+(slabT*100).toFixed(0)+' cm is thinner than L/30 = '+(tmin*100).toFixed(0)+' cm for a span of '+L.toFixed(1)+' m'); }
    else if(opt.floor==='hollow'){ Object.assign(out,{note:'a hollow-core slab for ≥ '+q.toFixed(1)+' kPa (design) over '+L.toFixed(1)+' m'}); }
    else { const sec=ldTimber(q*.6,(g+v)*.6,L); Object.assign(out,{sec,note:sec ? 'beams '+(sec[0]*1000)+'×'+(sec[1]*1000)+' mm at 0.6 m' : 'a span of '+L.toFixed(1)+' m is too much for timber beams: add a support'}); if(!sec) warns.push('floor over '+sl.room+': '+out.note); }
    return out; });
  // стропила
  const rafters=roofs.filter(r=>r.slope>0).map(r=>{ const qn=(LD_GG*opt.roofG+LD_GS*r.snow*r.cos)*r.cos, qk=(opt.roofG+r.snow*r.cos)*r.cos, sec=ldTimber(qn*.6,qk*.6,r.slope); if(!sec) warns.push('rafters of the '+r.kind+' roof: a slope of '+r.slope.toFixed(1)+' m needs a purlin or a truss');
    return {kind:r.kind,angle:r.angle,slope:r.slope,snow:r.snow,mu:r.mu,qn,sec}; });
  // фундамент
  const bot=walls.length ? Math.min(...walls.filter(k=>k.bear).map(k=>k.lv)) : 0, base=res.filter(r=>r.lv===bot), R0=+opt.R0, d=+opt.depth, foot=[];
  for(const r of base){ const Nk=r.Nk, bq=R0-20*d; let b=bq>0 ? Nk/bq : Infinity; b=Math.max(ldCeil(b,.05),ldCeil(r.t+.1,.05),.4);
    const sp=Math.max(.6,Math.min(3,opt.pile/Math.max(Nk,1))); foot.push({id:r.id,L:r.L,Nk,b,vol:isFinite(b) ? b*d*r.L : 0,piles:Math.ceil(r.L/sp)+1,pileStep:sp,perPile:Nk*r.L/(Math.ceil(r.L/sp)+1),warn:!isFinite(b) ? 'the soil is too weak for a strip footing at this depth' : b>1.2 ? 'a strip of '+b.toFixed(2)+' m: a raft or piles are better' : ''}); }
  const Wk=base.reduce((q,r)=>q+r.Nk*r.L,0), foot0=rooms.filter(R=>R.lv===bot).reduce((q,R)=>q+R.area,0), raft=foot0>0 ? Wk/foot0 : 0;
  for(const f of foot) if(f.warn) warns.push('wall '+f.id+': '+f.warn);
  const house={weight:Wk,mass:Wk/9.81,footprint:foot0,raft,R0,depth:d,strip:foot.reduce((q,f)=>q+(isFinite(f.vol) ? f.vol : 0),0),piles:foot.reduce((q,f)=>q+f.piles,0),snow:snowSg,roofG,roofS,roofArea:roofA,roofProj:roofP,walls:res.length,maxRatio:res.reduce((q,r)=>Math.max(q,r.ratio),0)};
  return {opt,walls:res,lintels,floors,rafters,foundation:foot,house,warns}; }

// подбор балки / стропила: первая секция, проходящая по прочности (Rи = 13 МПа × 0,85) и прогибу (L/250, E = 10 ГПа); q — кН/м
function ldTimber(qd,qk,L){ for(const [b,h] of LD_TIMBER){ const Wd=b*h*h/6, I=b*h*h*h/12, Mcap=Wd*13000*.85, f=5*qk*Math.pow(L,4)/(384*10e6*I); if(qd*L*L/8<=Mcap && f<=L/250) return [b,h]; } return null; }
