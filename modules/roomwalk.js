"use strict";
/* ============================ Room Walk ============================
   Комната из одной точки: поворачиваете телефон лицом к стене — Echo Ranger даёт расстояние, Orientation (компас) — азимут; кнопка или импульс go
   записывает замер «азимут расстояние». По трём-четырём стенам модуль строит комнату — углы как пересечения линий стен, площадь, периметр, ориентацию —
   и отдаёт строки для Site Plan (углы с погрешностью и контур). Ядро — roomwalk-kernels.js (тест tools/test-roomwalk.mjs). */

function rwTake(n,v,a,src){
  if(!(v>0) || !isFinite(a)){ n.msg='no shot: need a distance > 0 and an azimuth (wire d and az, or type «distance» and «azimuth»)'; redraw(n); return false; }
  const cur=String(n.p.shots||'').replace(/\s+$/,''), line=(+a).toFixed(1)+' '+(+v).toFixed(3), t=(cur ? cur+'\n' : '')+line;
  if(n.set?.shots) n.set.shots(t); else n.p.shots=t; n.msg='shot: azimuth '+(+a).toFixed(1)+'°, '+(+v).toFixed(2)+' m'+(src ? ' ('+src+')' : ''); n.key=''; redraw(n); return true;
}
function rwUndo(n){
  const L=String(n.p.shots||'').split('\n'); while(L.length && !L[L.length-1].trim()) L.pop();
  const g=L.pop(), t=L.join('\n'); if(n.set?.shots) n.set.shots(t); else n.p.shots=t; n.msg=g ? 'removed: '+g : 'no shots'; n.key=''; redraw(n);
}

def({ id:'roomwalk', title:'Room Walk', cat:'Geo', lazy:true, readout:true, view:{h:260}, w:380, resize:true,
  kw:'room walk walls corners floor plan indoor distance compass azimuth echo ranger area measure interior',
  // d — расстояние до стены (Echo Ranger dist); az — азимут телефона, ° от севера (Orientation az); go — импульс «записать замер» (Echo Ranger go);
  // lines — для Site Plan: углы «R1 at x y ± σ» и poly; area — площадь, м²; perim — периметр, м; n — число стен; rec — углы записями
  ins:[{n:'d',t:'num'},{n:'az',t:'num'},{n:'go',t:'num'}],
  outs:[{n:'lines',t:'txt'},{n:'area',t:'num'},{n:'perim',t:'num'},{n:'n',t:'num'},{n:'rec',t:'rec'}],
  params:[{n:'take',t:'button',label:'＋ Wall shot (the wired d and az; else the typed ones)',fn:n=>rwTake(n,n.inD ?? +n.p.dist,n.inAz ?? +n.p.azim,n.inD!=null ? 'wired' : 'typed')},
          {n:'dist',t:'num',d:0,label:'typed distance to the wall, m (when d is not wired)'},
          {n:'azim',t:'num',d:0,label:'typed azimuth, ° from north (when az is not wired)'},
          {n:'rect',t:'check',d:true,label:'rectangular room: snap the walls to one angle + 90° steps (the compass is noisy, the walls are straight)'},
          {n:'merge',t:'range',min:5,max:45,step:1,d:20,label:'shots within … ° of each other are one wall (averaged)'},
          {n:'sd',t:'range',min:.005,max:.3,step:.005,d:.03,label:'distance error, m'},
          {n:'saz',t:'range',min:.5,max:15,step:.5,d:3,label:'compass error, ° (phones: 2–5 near steel and wiring up to 15)'},
          {n:'prefix',t:'text',d:'R',label:'corner name prefix in Site Plan (R → R1, R2…)'},
          {n:'undo',t:'button',label:'Undo the last shot',fn:n=>rwUndo(n)},
          {n:'shots',t:'code',plain:true,d:'',label:'shots, one per line: azimuth distance (editable; # — comment)',fn:n=>{ n.key=''; }}],
  init:n=>{ n.key=''; n.sol=null; n.bad=[]; n.msg=''; n.inD=null; n.inAz=null; n.lastGo=0; n.lines=''; n.emit=null; },
  process(n,I){
    const d=typeof I.d==='number' && isFinite(I.d) && I.d>0 ? I.d : null, az=typeof I.az==='number' && isFinite(I.az) ? I.az : null;
    n.inD=d; n.inAz=az;
    const go=typeof I.go==='number' && isFinite(I.go) ? I.go : 0;
    if(go>0 && n.lastGo<=0) rwTake(n,d ?? +n.p.dist,az ?? +n.p.azim,'wired');
    n.lastGo=go;
    const p=n.p, key=[p.shots,p.rect,p.merge,p.sd,p.saz,p.prefix].join('|');
    if(key!==n.key){
      n.key=key; const P=rwParse(p.shots); n.bad=P.bad;
      n.sol=rwSolve(P.shots,{rect:p.rect,merge:+p.merge}); n.nShots=P.shots.length;
      n.lines=rwLines(n.sol,{prefix:p.prefix,sd:+p.sd,saz:+p.saz});
      const pre=String(p.prefix||'R').replace(/[\s-]+/g,'_'), t=new Date().toISOString();
      n.emit=n.sol.ok ? n.sol.corners.map((c,i)=>({id:'room:'+(i+1),t,kind:'room corner',name:pre+(i+1),label:pre+(i+1),x:+c.x.toFixed(3),y:+c.y.toFixed(3)})) : null;
      redraw(n);
    }
    const S=n.sol, e=n.emit; n.emit=null;
    return {lines:n.lines, area:S?.ok ? S.area : null, perim:S?.ok ? S.perimeter : null, n:S ? S.walls.length : 0, rec:e};
  },
  draw(n,cv,cx){
    const W=cv.width, H=cv.height, S=n.sol, L=[], fg=themeColor('--scr-txt')||'#9fb0b6', pad=28;
    cx.fillStyle=themeColor('--screen')||'#0a0d0e'; cx.fillRect(0,0,W,H); cx.font='10px monospace'; cx.textBaseline='alphabetic';
    if(n.msg) L.push(n.msg);
    for(const b of n.bad.slice(0,3)) L.push('line '+b.line+': cannot read «'+b.text+'» (azimuth distance)');
    if(S && S.walls.length){
      const pts=[[0,0]]; for(const w of S.walls) pts.push([w.d*Math.sin(w.az*Math.PI/180),w.d*Math.cos(w.az*Math.PI/180)]); for(const c of S.corners) pts.push([c.x,c.y]);
      let x0=1e99,x1=-1e99,y0=1e99,y1=-1e99; for(const [x,y] of pts){ x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y); }
      const sc=Math.min((W-2*pad)/Math.max(x1-x0,1e-6),(H-2*pad)/Math.max(y1-y0,1e-6)), ox=(W-(x1-x0)*sc)/2, oy=(H+(y1-y0)*sc)/2, T=(x,y)=>[ox+(x-x0)*sc,oy-(y-y0)*sc];
      if(S.corners.length>=3){ cx.beginPath(); S.corners.forEach((c,i)=>{ const q=T(c.x,c.y); i ? cx.lineTo(q[0],q[1]) : cx.moveTo(q[0],q[1]); }); cx.closePath(); cx.fillStyle=S.ok ? 'rgba(79,195,247,.18)' : 'rgba(255,92,92,.12)'; cx.fill(); cx.strokeStyle='#4fc3f7'; cx.lineWidth=2; cx.stroke(); }
      const o=T(0,0);
      S.walls.forEach(w=>{ const a=w.az*Math.PI/180, f=T(w.d*Math.sin(a),w.d*Math.cos(a)); cx.strokeStyle='rgba(255,183,77,.9)'; cx.lineWidth=1.5; cx.setLineDash([4,3]); cx.beginPath(); cx.moveTo(o[0],o[1]); cx.lineTo(f[0],f[1]); cx.stroke(); cx.setLineDash([]);
        cx.fillStyle='#ffb74d'; cx.beginPath(); cx.arc(f[0],f[1],3,0,7); cx.fill(); cx.fillStyle=fg; cx.textAlign='center'; cx.fillText(w.d.toFixed(2)+' m'+(w.n>1 ? ' ×'+w.n : ''),(o[0]+f[0])/2,(o[1]+f[1])/2-4); });
      S.corners.forEach((c,i)=>{ const q=T(c.x,c.y); cx.fillStyle='#7dff9a'; cx.strokeStyle='#000'; cx.lineWidth=1.5; cx.beginPath(); cx.arc(q[0],q[1],4,0,7); cx.stroke(); cx.fill(); cx.fillStyle=fg; cx.textAlign='left'; cx.fillText((n.p.prefix||'R')+(i+1)+' ('+c.x.toFixed(2)+', '+c.y.toFixed(2)+')',q[0]+6,q[1]-6); });
      cx.fillStyle='#fff'; cx.strokeStyle='#000'; cx.lineWidth=2; cx.beginPath(); cx.arc(o[0],o[1],5,0,7); cx.stroke(); cx.fill();
      cx.strokeStyle=fg; cx.fillStyle=fg; cx.lineWidth=1.5; cx.beginPath(); cx.moveTo(W-16,pad+6); cx.lineTo(W-16,pad-14); cx.stroke(); cx.textAlign='center'; cx.fillText('N',W-16,pad-18);
      const k=n.nShots, w=S.walls.length;
      L.push(k+' shot'+(k===1 ? '' : 's')+' → '+w+' wall'+(w===1 ? '' : 's')+(S.phi!=null ? ' · the room is turned '+S.phi.toFixed(1)+'° from north (rectangular)' : ''));
      if(S.ok){
        const sides=S.corners.map((c,i)=>{ const q=S.corners[(i+1)%S.corners.length]; return Math.hypot(q.x-c.x,q.y-c.y); });
        L.push('area '+S.area.toFixed(2)+' m² · perimeter '+S.perimeter.toFixed(2)+' m · sides '+sides.map(v=>v.toFixed(2)).join(', ')+' m');
        if(!S.inside) L.push('⚠ the standing point is outside the room: check the azimuths and the distances');
      } else if(w<3) L.push('need at least 3 walls (4 for a rectangle): turn to the next wall and add a shot');
      else if(S.open.length) L.push('⚠ two neighbouring walls are almost parallel — no corner between them: add a shot between them');
    } else if(!n.bad.length) L.push('no shots: point the phone at a wall and press «＋ Wall shot» (Echo Ranger d + Orientation az), turn to the next wall…');
    n.el.querySelector('.readout').textContent=L.join('\n');
  }});
