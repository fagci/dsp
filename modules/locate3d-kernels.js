"use strict";
/* ============================ Ядро Source Locator 3D ============================
   Высота найденного источника: по углам места замеров (elevation) или «земля + предполагаемая высота мачты»,
   лучи от замеров к источнику как связи для карты и 3D. Без DOM — проверяется tools/test-locate3d.mjs. */

const L3_D=Math.PI/180;
// высота точки замера над уровнем моря: alt (GPS) или земля + h антенны
const l3MeasAlt=(m,ground)=>m.alt!=null ? m.alt : (ground==null || ground!==ground ? 0 : ground)+(m.h>0 ? m.h : 0);
// высота по углам места: каждый замер даёт z = z_замера + d·tan(el); вес — обратный квадрату ошибки (растёт с дальностью и наклоном)
// M: {x,y (км в локальной плоскости), z (м), el (°)}; S: {x,y}; sigEl — ошибка угла, °
function l3FromElev(M,S,sigEl){
  let sw=0, sz=0, n=0; const zs=[];
  for(const m of M){
    if(m.el==null || m.z==null) continue;
    const d=Math.max(1,Math.hypot(S.x-m.x,S.y-m.y)*1000), e=Math.max(-89,Math.min(89,m.el))*L3_D;
    const z=m.z+d*Math.tan(e), sd=Math.max(1,d/(Math.cos(e)*Math.cos(e))*(sigEl||2)*L3_D), w=1/(sd*sd);
    sw+=w; sz+=w*z; n++; zs.push([z,w]);
  }
  if(!n) return null;
  const alt=sz/sw; let v=0; for(const [z,w] of zs) v+=w*(z-alt)*(z-alt);
  return {alt, sd:Math.max(Math.sqrt(1/sw), n>1 ? Math.sqrt(v/sw) : 0), n};
}
// итог по источнику: земля в его точке, высота над землёй (не ниже 0), как получена
function l3Source(M,S,ground,o){
  const g=ground==null || ground!==ground ? null : ground, e=l3FromElev(M,S,o.sigEl);
  if(e && g!=null){ const h=Math.max(0,e.alt-g); return {ground:g, h, alt:g+h, sd:e.sd, how:'elevation', n:e.n}; }
  if(e) return {ground:null, h:null, alt:e.alt, sd:e.sd, how:'elevation', n:e.n};
  if(g!=null) return {ground:g, h:o.h0, alt:g+o.h0, sd:Math.max(o.h0,5), how:'assumed', n:0};
  return null;
}
// лучи замер → источник как записи-связи (alt, alt2 над уровнем моря); берутся последние max замеров
function l3Rays(M,S,id,o){
  const out=[], list=M.slice(-(o.max||40));
  list.forEach((m,i)=>{
    if(m.lat==null || m.alt3==null) return;
    out.push({id:id+':'+i,kind:'ray',color:o.color||'#6fd0ff',label:'',lat:+m.lat.toFixed(6),lon:+m.lon.toFixed(6),alt:+m.alt3.toFixed(1),
      lat2:+S.lat.toFixed(6),lon2:+S.lon.toFixed(6),alt2:+S.alt.toFixed(1)});
  });
  return {rays:out, n:list.length};
}
