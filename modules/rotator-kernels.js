"use strict";
/* ======================= ПОВОРОТНИК — ядро ======================= */
// Углы, пределы, протоколы rotctld / GS-232 / EasyComm II, круговой скан и виртуальный поворотник, без DOM: node tools/test-rotator.mjs.

const rtNorm=a=>((a%360)+360)%360;
// кратчайшая разность to−from, −180..180
const rtDelta=(from,to)=>{ const d=rtNorm(to-from); return d>180 ? d-360 : d; };

// Цель в пределах [min,max] (хоть 0…360, хоть 0…450 с перехлёстом): из target+360·k берётся допустимая, ближайшая к текущему
// положению cur; если ни одной нет — ближайший край.
function rtPick(target,cur,min,max){
  const base=rtNorm(target); let best=null;
  for(let k=-2;k<=3;k++){
    const v=base+360*k; if(v<min-1e-9 || v>max+1e-9) continue;
    if(best===null || Math.abs(v-cur)<Math.abs(best-cur)) best=v;
  }
  if(best!==null) return best;
  return Math.abs(base-min)<Math.abs(base-max) ? min : max;
}
const rtClampEl=(el,min,max)=>Math.max(min,Math.min(max,el));

/* ---- протоколы: команды и разбор ответов ---- */
// rotctld (Hamlib): P az el / p → «az\nel\n» / S стоп / K парковка. Ответы: числа или RPRT n.
const rtRotctld={
  set:(az,el)=>'P '+az.toFixed(2)+' '+el.toFixed(2)+'\n',
  get:'p\n', getLines:2, stop:'S\n', park:'K\n', ack:1,
  parse:ls=>{ const az=parseFloat(ls[0]), el=parseFloat(ls[1]); return Number.isFinite(az) ? {az,el:Number.isFinite(el) ? el : 0} : null; }
};
// Yaesu GS-232A/B: Waaa eee — оба угла, C2 — запрос обоих (+0aaa+0eee), S — стоп. Ответ строкой на \r.
const rtGs232={
  set:(az,el,elOn)=>elOn ? 'W'+String(Math.round(az)).padStart(3,'0')+' '+String(Math.round(el)).padStart(3,'0')+'\r'
                         : 'M'+String(Math.round(az)).padStart(3,'0')+'\r',
  get:'C2\r', getAz:'C\r', getLines:1, stop:'S\r', park:null,
  parse:ls=>{
    const s=ls[0]||'';
    let m=/AZ\s*=\s*(-?\d+)\s+EL\s*=\s*(-?\d+)/i.exec(s);
    if(m) return {az:+m[1],el:+m[2]};
    m=/\+0*(\d+)\s*\+0*(\d+)/.exec(s);
    if(m) return {az:+m[1],el:+m[2]};
    m=/(?:\+0*|AZ\s*=\s*)(\d+)/i.exec(s);
    return m ? {az:+m[1],el:0} : null;
  }
};
// EasyComm II (SatNOGS и др.): «AZ123.4 EL45.6» — установить; «AZ EL» — запрос, ответ «AZ123.4 EL45.6»; «SA SE» — стоп.
const rtEasycomm={
  set:(az,el)=>'AZ'+az.toFixed(1)+' EL'+el.toFixed(1)+'\n',
  get:'AZ EL\n', getLines:1, stop:'SA SE\n', park:null,
  parse:ls=>{ const m=/AZ\s*(-?[\d.]+)\s+EL\s*(-?[\d.]+)/i.exec(ls[0]||''); return m ? {az:parseFloat(m[1]),el:parseFloat(m[2])} : null; }
};
const RT_PROTO={rotctld:rtRotctld,'GS-232':rtGs232,'EasyComm II':rtEasycomm};

/* ---- круговой скан: поворот шагами, замер уровня на каждом ---- */
// span градусов от start шагом step (последний шаг не выходит за span); bins — [{az,sum,n,max}]
function rtScanPlan(start,span,step){
  step=Math.max(1,step); span=Math.max(0,Math.min(360,span));
  const out=[]; for(let a=0;a<=span+1e-9;a+=step) out.push(rtNorm(start+a));
  if(span>=360-1e-9) out.pop();                  // полный круг: 0° и 360° — одна точка
  return out;
}
const rtScanInit=plan=>plan.map(az=>({az,sum:0,n:0,max:-Infinity}));
function rtScanAdd(bin,lvl){ if(!Number.isFinite(lvl)) return; bin.sum+=lvl; bin.n++; if(lvl>bin.max) bin.max=lvl; }
const rtBinMean=b=>b.n ? b.sum/b.n : NaN;
// лучший азимут по среднему; с centroid=true — взвешенный центр вершины (по линейной мощности вокруг максимума)
function rtScanBest(bins,centroid){
  let bi=-1, bv=-Infinity;
  bins.forEach((b,i)=>{ const v=rtBinMean(b); if(v>bv){ bv=v; bi=i; } });
  if(bi<0) return null;
  let az=bins[bi].az;
  if(centroid){
    let sx=0, sy=0, w=0;
    for(let k=-1;k<=1;k++){
      const b=bins[(bi+k+bins.length)%bins.length]; if(!b.n) continue;
      const lw=Math.pow(10,(rtBinMean(b)-bv)/10), r=b.az*Math.PI/180;
      sx+=Math.cos(r)*lw; sy+=Math.sin(r)*lw; w+=lw;
    }
    if(w>0) az=rtNorm(Math.atan2(sy,sx)*180/Math.PI);
  }
  return {az,lvl:bv,i:bi};
}

/* ---- виртуальный поворотник с тем же текстом rotctld ---- */
function rtSim(opts){
  const s={az:0,el:0,tAz:0,tEl:0,rate:opts?.rate||6,azMax:opts?.azMax||360};
  s.step=dt=>{
    const dz=s.tAz-s.az, de=s.tEl-s.el, m=s.rate*dt;
    s.az+=Math.max(-m,Math.min(m,dz)); s.el+=Math.max(-m,Math.min(m,de));
  };
  s.moving=()=>Math.abs(s.tAz-s.az)>.05 || Math.abs(s.tEl-s.el)>.05;
  s.respond=cmd=>{
    const a=cmd.trim().split(/\s+/), c=a[0];
    if(c==='p') return s.az.toFixed(2)+'\n'+s.el.toFixed(2)+'\n';
    if(c==='P'){ const az=parseFloat(a[1]), el=parseFloat(a[2]); if(!Number.isFinite(az)||!Number.isFinite(el)) return 'RPRT -1\n'; s.tAz=az; s.tEl=el; return 'RPRT 0\n'; }
    if(c==='S'){ s.tAz=s.az; s.tEl=s.el; return 'RPRT 0\n'; }
    if(c==='K'){ s.tAz=0; s.tEl=0; return 'RPRT 0\n'; }
    return 'RPRT -11\n';
  };
  return s;
}

/* ---- раскладка и попадание на компасе: центр, радиус; угол от севера по часовой ---- */
function rtDial(W,H){
  const pad=10, r=Math.max(20,Math.min(W,H)/2-pad-10);
  return {cx:W/2, cy:H/2, r};
}
// точка (x,y) → азимут и возвышение: радиус r — горизонт (0°), центр — зенит (90°); вне круга возвышение зажато
function rtDialPoint(d,x,y){
  const dx=x-d.cx, dy=y-d.cy, az=rtNorm(Math.atan2(dx,-dy)*180/Math.PI);
  const el=90*(1-Math.min(1,Math.hypot(dx,dy)/d.r));
  return {az,el};
}
// азимут/возвышение → точка на круге радиуса k·r (по возвышению, если useEl, иначе на ободе)
function rtDialXY(d,az,el,useEl){
  const rr=useEl ? d.r*(1-Math.max(0,Math.min(90,el))/90) : d.r, a=az*Math.PI/180;
  return {x:d.cx+Math.sin(a)*rr, y:d.cy-Math.cos(a)*rr};
}

// Уровень виртуального маяка на азимуте beam, дБ, через луч антенны шириной ±sigma° (гаусс) с шумом noise·rnd (rnd — 0…1)
function rtSimBeam(az,beam,sigma,noise,rnd){
  const d=rtDelta(az,beam);
  return 28*Math.exp(-(d*d)/(2*sigma*sigma))-6+(rnd-.5)*noise;
}
