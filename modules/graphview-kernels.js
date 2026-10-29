"use strict";
/* ============================ GRAPH VIEW: чистая логика (без DOM) ============================
   Стрелки рёбер, группы, вид узла (картинка / значок / форма), параметры раскладки vis-network. Проверка: node tools/test-graphview.mjs */

// стрелка у ребра: «to», «from», «both», «to:circle,from:bar», «middle», «->», «<-», «<->», «-» / «none»; пусто → undefined (берётся общий флаг)
const GV_ARROW_TYPES=new Set(['arrow','bar','circle','box','diamond','curve','inv_curve','triangle','vee']);
function gvArrowsSpec(spec,dflt){
  const s=String(spec==null ? '' : spec).trim().toLowerCase();
  if(!s) return dflt ? {to:{enabled:true}} : undefined;
  const out={}, put=(end,type)=>{ out[end]={enabled:true,...(type && type!=='arrow' ? {type} : {})}; };
  const norm={'->':'to','→':'to','<-':'from','←':'from','<->':'both','↔':'both','-':'none','--':'none','0':'none','none':'none','off':'none',
              'to':'to','from':'from','both':'both','middle':'middle','mid':'middle','на':'to','от':'from'};
  let any=false;
  for(const tok of s.split(/[,;\s]+/)){
    if(!tok) continue;
    const [e0,t0]=tok.split(':'), e=norm[e0], t=GV_ARROW_TYPES.has(t0) ? t0 : '';
    if(!e) continue;
    any=true;
    if(e==='none') return {to:{enabled:false},from:{enabled:false},middle:{enabled:false}};
    if(e==='both'){ put('to',t); put('from',t); } else put(e,t);
  }
  return any ? out : (dflt ? {to:{enabled:true}} : undefined);
}
// группа без цвета — цвет по хэшу имени: одна группа — один цвет на любой раскладке
function gvGroupColor(g){
  let h=2166136261; for(const c of String(g)) h=Math.imul(h^c.codePointAt(0),16777619);
  const hue=((h>>>0)%360), s=62, l=52, a=s*Math.min(l,100-l)/10000;
  const f=n=>{ const k=(n+hue/30)%12, v=l/100-a*Math.max(-1,Math.min(k-3,9-k,1)); return Math.round(255*v).toString(16).padStart(2,'0'); };
  return '#'+f(0)+f(8)+f(4);
}
const GV_IMG_SHAPES=new Set(['image','circularImage']);
// значок — один символ (эмодзи, ★, буква) до четырёх кодовых точек; имя вроде «antenna» значком не считается
function gvIsGlyph(s){ s=String(s==null ? '' : s).trim(); return s!=='' && [...s].length<=4 && !/^[a-z0-9_ -]+$/i.test(s); }
// форма, которую получит узел: явная shape, иначе по картинке / значку; без картинки или значка форма-картинка падает в точку
function gvNodeShape(a,shapes){
  let sh=a.shape && shapes.has(a.shape) ? a.shape : '';
  if(!sh) sh=a.image ? 'circularImage' : a.glyph ? 'icon' : '';
  if(GV_IMG_SHAPES.has(sh) && !a.image) sh=a.glyph ? 'icon' : 'dot';
  if(sh==='icon' && !a.glyph) sh=a.image ? 'circularImage' : 'dot';
  return sh||'dot';
}
// параметры vis.Network из настроек узла: раскладка (свободная / иерархия), решатель физики, изгиб рёбер
const GV_SOLVERS=['forceAtlas2Based','barnesHut','repulsion','hierarchicalRepulsion'];
const GV_SMOOTH=['off','dynamic','continuous','curvedCW','curvedCCW','cubicBezier'];
const GV_DIRS=['UD','DU','LR','RL'];
function gvNetOpts(p){
  const hier=GV_DIRS.includes(p.layout);
  const solver=hier ? 'hierarchicalRepulsion' : (GV_SOLVERS.includes(p.solver) ? p.solver : 'forceAtlas2Based');
  const sm=GV_SMOOTH.includes(p.smooth) && p.smooth!=='off';
  const o={
    autoResize:true, interaction:{hover:true,tooltipDelay:200},
    nodes:{shape:'dot',scaling:{min:5,max:18}},
    edges:{scaling:{min:1,max:5},smooth:sm ? {enabled:true,type:p.smooth,roundness:.4} : false,arrows:{to:{scaleFactor:.5},from:{scaleFactor:.5},middle:{scaleFactor:.5}}},
    physics:{enabled:p.physics!==false,solver,stabilization:{iterations:80}},
    layout:hier ? {hierarchical:{enabled:true,direction:p.layout,sortMethod:p.sort==='hubsize' ? 'hubsize' : 'directed',
                               levelSeparation:Math.max(30,+p.levelSep||120),nodeSpacing:Math.max(20,+p.nodeSpacing||100)}}
                : {hierarchical:false}};
  return o;
}
