"use strict";
/* ============================ STUDIO: ОБЩИЕ ВИДЖЕТЫ ============================
   Ручка, список, переключатель, панель параметров по описанию, всплывающее меню, основа панели. */

/* ---------- мелкие виджеты ---------- */
const stuEl=(tag,cls,html)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; };
const stuEsc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stuCss=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ручка: вертикальное перетаскивание, колесо, двойной клик — значение по умолчанию, правая кнопка — автоматизация
function stuKnob(o){
  const d=o.d, el=stuEl('div','stu-knob'+(o.small?' sm':'')), cv=stuEl('canvas'), lb=stuEl('div','stu-kl',stuEsc(o.label||d.label||d.k)), vl=stuEl('div','stu-kv');
  const S=o.small?24:38, dpr=Math.min(2,window.devicePixelRatio||1);
  cv.width=cv.height=S*dpr; cv.style.width=cv.style.height=S+'px'; el.append(cv,vl,lb);
  let v=o.v, norm=stToNorm(d,v);
  const draw=()=>{
    const c=cv.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,S,S);
    const r=S/2-3, a0=Math.PI*.75, a1=Math.PI*2.25, bi=d.min<0 && d.max>0, z=bi?stToNorm(d,0):0;
    c.lineWidth=3; c.lineCap='round'; c.strokeStyle=stuCss('--line')||'#444'; c.beginPath(); c.arc(S/2,S/2,r,a0,a1); c.stroke();
    c.strokeStyle=stuCss('--acc')||'#e0b23c'; c.beginPath();
    const ang=a0+(a1-a0)*norm, az=a0+(a1-a0)*z; c.arc(S/2,S/2,r,Math.min(ang,az),Math.max(ang,az)); c.stroke();
    c.strokeStyle=stuCss('--txt')||'#ccc'; c.lineWidth=2; c.beginPath(); c.moveTo(S/2+Math.cos(ang)*(r-7),S/2+Math.sin(ang)*(r-7)); c.lineTo(S/2+Math.cos(ang)*r,S/2+Math.sin(ang)*r); c.stroke();
    vl.textContent=stFmt(d,v);
  };
  const set=(nv,fire)=>{ v=nv; norm=stToNorm(d,v); draw(); };
  let dragging=null;
  el.addEventListener('pointerdown',ev=>{
    if(ev.button!==0) return; ev.preventDefault(); el.setPointerCapture(ev.pointerId); dragging={y:ev.clientY,n:norm}; el.classList.add('on'); });
  el.addEventListener('pointermove',ev=>{
    if(!dragging) return;
    norm=stClamp(dragging.n+(dragging.y-ev.clientY)/(ev.shiftKey?600:160),0,1); v=stFromNorm(d,norm); draw(); o.onInput&&o.onInput(v); });
  const end=()=>{ if(dragging){ dragging=null; el.classList.remove('on'); o.onChange&&o.onChange(v); } };
  el.addEventListener('pointerup',end); el.addEventListener('pointercancel',end);
  el.addEventListener('dblclick',()=>{ set(d.d); o.onInput&&o.onInput(v); o.onChange&&o.onChange(v); });
  el.addEventListener('wheel',ev=>{ ev.preventDefault(); norm=stClamp(norm-Math.sign(ev.deltaY)*(ev.shiftKey?.005:.03),0,1); v=stFromNorm(d,norm); draw();
    o.onInput&&o.onInput(v); clearTimeout(el._wt); el._wt=setTimeout(()=>o.onChange&&o.onChange(v),250); },{passive:false});
  if(o.target && o.auto) el.addEventListener('contextmenu',ev=>{ ev.preventDefault();
    stuMenu(ev.clientX,ev.clientY,[{label:'Create automation clip',fn:()=>o.auto(o.target)}]); });
  el.title=(o.label||d.label||d.k)+(o.target&&o.auto?' — right click: automation':'');
  el.set=set; draw(); return el;
}
function stuSelect(o){
  const d=o.d, el=stuEl('div','stu-sel'), s=stuEl('select'); el.append(s,stuEl('div','stu-kl',stuEsc(o.label||d.label||d.k)));
  for(const x of d.o) s.append(new Option(x,x));
  s.value=o.v; s.addEventListener('change',()=>{ o.onInput&&o.onInput(s.value); o.onChange&&o.onChange(s.value); });
  el.set=v=>{ s.value=v; }; return el;
}
function stuCheck(o){
  const d=o.d, el=stuEl('button','stu-chk'+(o.v?' on':''),stuEsc(o.label||d.label||d.k));
  el.addEventListener('click',()=>{ const v=el.classList.toggle('on')?1:0; o.onInput&&o.onInput(v); o.onChange&&o.onChange(v); });
  el.set=v=>el.classList.toggle('on',!!v); return el;
}
// панель параметров по описанию: группы, ручки, списки; get/set — значения, fin — после отпускания
function stuParams(defs,p,onInput,onChange,targetOf,auto){
  const root=stuEl('div','stu-params'), groups=new Map(), ctl={};
  for(const d of defs){
    if(d.hidden) continue;
    let g=groups.get(d.g||''); if(!g){ g=stuEl('div','stu-grp'); if(d.g) g.append(stuEl('h4',null,stuEsc(d.g))); const kn=stuEl('div','stu-knobs'); g.append(kn); g._k=kn; groups.set(d.g||'',g); root.append(g); }
    const o={d,v:p[d.k],onInput:v=>onInput(d.k,v),onChange:v=>onChange&&onChange(d.k,v),target:targetOf?targetOf(d.k):null,auto};
    const e=d.t==='sel'?stuSelect(o):d.t==='chk'?stuCheck(o):stuKnob(o);
    g._k.append(e); ctl[d.k]=e;
  }
  root.ctl=ctl; return root;
}
function stuMenu(x,y,items){
  document.querySelectorAll('.stu-menu').forEach(m=>m.remove());
  const m=stuEl('div','stu-menu'); document.body.append(m);
  for(const it of items){
    if(it.sep){ m.append(stuEl('div','sep')); continue; }
    const b=stuEl('button',it.on?'on':'',stuEsc(it.label)); if(it.dis) b.disabled=true;
    b.addEventListener('click',()=>{ m.remove(); it.fn&&it.fn(); }); m.append(b);
  }
  const r=m.getBoundingClientRect(); m.style.left=Math.max(4,Math.min(x,innerWidth-r.width-4))+'px'; m.style.top=Math.max(4,Math.min(y,innerHeight-r.height-4))+'px';
  const away=ev=>{ if(!m.contains(ev.target)){ m.remove(); removeEventListener('pointerdown',away,true); } };
  setTimeout(()=>addEventListener('pointerdown',away,true),0);
  return m;
}
const stuPick=(accept)=>new Promise(res=>{ const i=document.createElement('input'); i.type='file'; i.accept=accept; i.onchange=()=>res(i.files[0]||null); i.click(); });


// основа панели: свой корневой элемент, регистрация в сессии; refresh — пересобрать, frame — покадровая отрисовка
class StuPanel{
  constructor(app,kind){
    this.app=app; this.kind=kind; this.el=document.createElement('div'); this.el.className='stu-panel stu-p-'+kind;
    app.attach(this);
  }
  refresh(){}
  frame(){}
  destroy(){ this.app.detach(this); this.el.remove(); }
}
