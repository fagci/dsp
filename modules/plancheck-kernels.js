"use strict";
/* ============================ Plan Editor: проверка плана и слои ============================
   pcCheck(s) — список проблем геометрии и привязки: {sev:'err'|'warn', kind:'wall'|'room'|'obj'|'el'|'hv'|'wire'|'pp', id, x, y, msg}.
   Стены (нулевая длина, толщина, высота, наложение), проёмы (нет стены, шире стены, выше стены, пересекаются), комнаты (меньше 3 точек, самопересечение,
   крошечная площадь, сторона без стены, наложение на комнату того же этажа), устройства (электрика, отопление, вентиляция) вне комнат или выше потолка,
   повторяющиеся имена, провода и трубы без концов, предметы, прошедшие сквозь стену. Слои: pcShow(show,sys) — рисовать ли систему при выбранном виде.
   Грузится после planedit-kernels.js и hvac-kernels.js (pePt, peWall, peInPoly, peRoomPoly, hvRoomZ, hvRoomH, hvEdgeWall…). Ядро чистое: node tools/test-plancheck.mjs */

const PC_SHOW=['all','structure','electrics','heating','ventilation','cameras','radio'];
// система устройства: electrics / heating / ventilation / cameras / radio; структура (стены, комнаты, проёмы) видна всегда
const pcHvSys=t=>t==='ahu'||t==='fan'||t==='supply'||t==='extract' ? 'ventilation' : 'heating';
const pcShow=(show,sys)=>!show || show==='all' || show===sys;

function pcSegX(a,b,c,d){ const o=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]), d1=o(a,b,c), d2=o(a,b,d), d3=o(c,d,a), d4=o(c,d,b); return d1*d2<-1e-9 && d3*d4<-1e-9; }
function pcSelfX(P){ const n=P.length; for(let i=0;i<n;i++) for(let j=i+2;j<n;j++){ if(i===0&&j===n-1) continue; if(pcSegX(P[i],P[(i+1)%n],P[j],P[(j+1)%n])) return [(P[i][0]+P[j][0])/2,(P[i][1]+P[j][1])/2]; } return null; }
function pcCheck(s){
  const out=[], add=(sev,kind,id,x,y,msg)=>out.push({sev,kind,id,x:+x,y:+y,msg});
  const ws=s.walls||[], ro=s.rooms||[];
  // стены
  for(const w of ws){ const [a,b]=peWallEnds(s,w); if(!a||!b){ add('err','wall',w.id,0,0,'a wall without end points'); continue; } const L=Math.hypot(b.x-a.x,b.y-a.y), mx=(a.x+b.x)/2, my=(a.y+b.y)/2, thin=w.mat==='mesh'||w.mat==='cord';
    if(L<.05) add('err','wall',w.id,mx,my,'a wall shorter than 5 cm');
    if(!(w.t>0) || (w.t>1.5 && !thin)) add('warn','wall',w.id,mx,my,'a strange thickness: '+w.t+' m');
    if(!(w.h>0)) add('err','wall',w.id,mx,my,'a wall without height'); }
  if(ws.length<=400) for(let i=0;i<ws.length;i++) for(let j=i+1;j<ws.length;j++){ const A=ws[i], B=ws[j]; if((A.lv||0)!==(B.lv||0)) continue; const [p,q]=peWallEnds(s,A), [r,t]=peWallEnds(s,B); if(!p||!q||!r||!t) continue;
    const dx=q.x-p.x, dy=q.y-p.y, L=Math.hypot(dx,dy); if(L<.05) continue; const ux=dx/L, uy=dy/L, cr=Math.abs((t.x-r.x)*uy-(t.y-r.y)*ux)/(Math.hypot(t.x-r.x,t.y-r.y)||1); if(cr>.02) continue;
    if(Math.abs((r.x-p.x)*uy-(r.y-p.y)*ux)>.05) continue; const s0=(r.x-p.x)*ux+(r.y-p.y)*uy, s1=(t.x-p.x)*ux+(t.y-p.y)*uy, ov=Math.min(L,Math.max(s0,s1))-Math.max(0,Math.min(s0,s1));
    if(ov>.1) add('warn','wall',B.id,(r.x+t.x)/2,(r.y+t.y)/2,'walls '+A.id+' and '+B.id+' lie on top of each other ('+ov.toFixed(2)+' m)'); }
  // проёмы
  const byWall=new Map(); for(const o of s.objs||[]){ if(o.type!=='door'&&o.type!=='window') continue; const w=peWall(s,o.wall); if(!w){ add('err','obj',o.id,0,0,o.type+' without a wall'); continue; }
    const pl=peOpenPlace(s,o), L=pl.L; if(o.w>L+1e-6) add('err','obj',o.id,pl.x,pl.y,o.type+' '+o.w+' m is wider than its wall ('+L.toFixed(2)+' m)');
    if((o.sill||0)+o.h>w.h+.01) add('warn','obj',o.id,pl.x,pl.y,o.type+' is taller than the wall ('+((o.sill||0)+o.h).toFixed(2)+' > '+w.h+' m)');
    if(o.type==='door' && (o.sill||0)>.3) add('warn','obj',o.id,pl.x,pl.y,'a door raised by '+o.sill+' m');
    (byWall.get(w.id)||byWall.set(w.id,[]).get(w.id)).push({o,pl,s0:o.u*L-o.w/2,s1:o.u*L+o.w/2}); }
  for(const [,L] of byWall){ L.sort((a,b)=>a.s0-b.s0); for(let i=1;i<L.length;i++) if(L[i].s0<L[i-1].s1-.02) add('err','obj',L[i].o.id,L[i].pl.x,L[i].pl.y,L[i].o.type+' overlaps '+L[i-1].o.type+' on one wall'); }
  if(typeof peOverlaps==='function'){ try{ const seen=new Set(); for(const q of peOverlaps(s)){ if(seen.has(q.obj)) continue; seen.add(q.obj); const o=(s.objs||[]).find(z=>z.id===q.obj); if(o && o.name!=='stake') add('warn','obj',o.id,o.x||0,o.y||0,(o.name||o.type)+' goes through a wall'); } }catch(e){} }
  // комнаты
  const info=ro.map(r=>{ const P=peRoomPoly(s,r); return {r,P,lv:r.lv||0,area:P.length>2 ? peRoomArea(s,r) : 0}; });
  for(const R of info){ const r=R.r, nm=r.name||r.id, c=R.P.length ? [R.P.reduce((a,q)=>a+q[0],0)/R.P.length,R.P.reduce((a,q)=>a+q[1],0)/R.P.length] : [0,0];
    if(R.P.length<3){ add('err','room',r.id,c[0],c[1],'room '+nm+': fewer than 3 corners'); continue; }
    if(R.area<1) add('warn','room',r.id,c[0],c[1],'room '+nm+': only '+R.area.toFixed(2)+' m²');
    const sx=pcSelfX(R.P); if(sx) add('err','room',r.id,sx[0],sx[1],'room '+nm+': the outline crosses itself');
    if(ws.length){ for(let i=0;i<R.P.length;i++){ const a=R.P[i], b=R.P[(i+1)%R.P.length]; if(Math.hypot(b[0]-a[0],b[1]-a[1])<.3) continue; if(typeof hvEdgeWall==='function' && !hvEdgeWall(s,r,a,b)){ add('warn','room',r.id,(a[0]+b[0])/2,(a[1]+b[1])/2,'room '+nm+': a side without a wall (the room is open there)'); break; } } } }
  for(let i=0;i<info.length;i++) for(let j=i+1;j<info.length;j++){ const A=info[i], B=info[j]; if(A.lv!==B.lv||A.P.length<3||B.P.length<3) continue;
    const cen=P=>[P.reduce((a,q)=>a+q[0],0)/P.length,P.reduce((a,q)=>a+q[1],0)/P.length], ins=(P,Q)=>{ const c=cen(P); return P.some(p=>peInPoly(Q,p[0]+(c[0]-p[0])*.03,p[1]+(c[1]-p[1])*.03)); };
    if(ins(A.P,B.P)||ins(B.P,A.P)){ const c=cen(A.P); add('err','room',B.r.id,c[0],c[1],'rooms '+(A.r.name||A.r.id)+' and '+(B.r.name||B.r.id)+' overlap'); } }
  // устройства: имена и привязка к комнате
  const zi=ro.map(r=>({r,P:peRoomPoly(s,r),z0:typeof hvRoomZ==='function' ? hvRoomZ(s,r) : 0,h:typeof hvRoomH==='function' ? hvRoomH(s,r) : 2.7}));
  const near=[[0,0],[.3,0],[-.3,0],[0,.3],[0,-.3]];                                                 // розетка или радиатор на самой стене — в плоскости стены, не вглубь комнаты
  const where=(x,y,z)=>{ let inXY=false; for(const R of zi){ if(R.P.length<3||!near.some(o=>peInPoly(R.P,x+o[0],y+o[1]))) continue; inXY=true; if(z>=R.z0-.6&&z<=R.z0+R.h+.6) return {ok:true}; } return {ok:false,inXY}; };
  const names=new Map(); const dev=(kind,list)=>{ for(const e of list||[]){ const prev=names.get(e.name); if(prev) add('warn',kind,e.id,e.x,e.y,'the name '+e.name+' is used twice');  else names.set(e.name,e.id);
      if(!zi.length) continue; const q=where(e.x,e.y,e.z||0); if(!q.ok) add('warn',kind,e.id,e.x,e.y,e.name+(q.inXY ? ': the height '+(+e.z||0).toFixed(2)+' m is outside the floor and ceiling of the room' : ' is outside any room')); } };
  dev('el',s.elec); dev('hv',s.hv);
  for(const w of s.wires||[]){ const A=peElOf(s,w.a), B=peElOf(s,w.b); if(!A||!B) add('err','wire',w.id,0,0,'a wire without an end'); else if(Math.hypot(A.x-B.x,A.y-B.y)<1e-6&&!(w.via||[]).length&&Math.abs((A.z||0)-(B.z||0))<1e-6) add('warn','wire',w.id,A.x,A.y,'a wire of zero length'); }
  for(const l of s.pp||[]){ const A=typeof hvDev==='function' ? hvDev(s,l.a) : null, B=typeof hvDev==='function' ? hvDev(s,l.b) : null; if(!A||!B) add('err','pp',l.id,0,0,'a pipe / duct without an end'); }
  return out;
}
