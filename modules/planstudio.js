"use strict";
/* Plan Studio: Site Plan, Plan Editor, Map и Image on Map (своё фото-слой) — в одном узле, вкладками Plan / Editor / Map / Photo.
   Внутри — те же модули siteplan / planedit / geoMap / geoImage, без копий кода: у каждой вкладки свой «подузел» (Object.create(узла)) со своим состоянием
   и параметрами, лежащими в n.p с префиксом (sp_, pe_, mp_, im_). Провода между ними (как в пресете «Image on Map») замкнуты внутри process():
   Plan.rec/poly → Photo, Editor, Map; Photo.rec → Editor, Map; Map.edit → Plan.rec (следующий такт). Общий холст показывает активную вкладку,
   жесты неактивных вкладок отключены (обёртка канвы). Параметры других вкладок скрыты (группы «Plan · …», «Editor · …»…). */

const PS_TABS=[{k:'plan',pre:'sp_',type:'siteplan',label:'Plan'},{k:'editor',pre:'pe_',type:'planedit',label:'Editor'},
               {k:'map',pre:'mp_',type:'geoMap',label:'Map'},{k:'photo',pre:'im_',type:'geoImage',label:'Photo'}];
const psTabOf=n=>PS_TABS.find(t=>t.label===n.p.tab)||PS_TABS[0];
const psArr=v=>v==null ? [] : Array.isArray(v) ? v : [v];

function psSub(n,t){                                                         // подузел вкладки: чужие поля узла видит, свои пишет у себя; n.p / n.set — с префиксом
  const m=n.ps||(n.ps={}); if(m[t.k]) return m[t.k];
  const pre=t.pre, s=Object.create(n);
  s.p=new Proxy({},{
    get:(_,k)=>typeof k==='string' ? n.p[pre+k] : undefined,
    set:(_,k,v)=>{ n.p[pre+k]=v; return true; },
    has:(_,k)=>(pre+String(k)) in n.p,
    deleteProperty:(_,k)=>delete n.p[pre+k],
    ownKeys:()=>Object.keys(n.p).filter(k=>k.startsWith(pre)).map(k=>k.slice(pre.length)),
    getOwnPropertyDescriptor:(_,k)=>(pre+String(k)) in n.p ? {value:n.p[pre+k],writable:true,enumerable:true,configurable:true} : undefined});
  s.set=new Proxy({},{get:(_,k)=>typeof k==='string' ? n.set?.[pre+k] : undefined, has:(_,k)=>!!n.set?.[pre+String(k)]});
  Object.defineProperty(s,'_dirty',{get:()=>n._dirty,set:v=>{ n._dirty=v; },configurable:true});          // redraw(подузел) будит весь узел
  return m[t.k]=s;
}
function psCv(n,t){                                                          // канва для вкладки: обработчики жестов срабатывают, только пока вкладка активна
  const real=n.cv, c=n.psCv||(n.psCv={}); if(c[t.k] && c[t.k].real===real) return c[t.k].px;
  const px=new Proxy(real,{
    get:(o,k)=>{
      if(k==='addEventListener') return (type,h,opt)=>o.addEventListener(type,ev=>{ if(psTabOf(n)===t) return h.call(o,ev); },opt);
      const v=o[k]; return typeof v==='function' ? v.bind(o) : v; },
    set:(o,k,v)=>{ o[k]=v; return true; }});
  c[t.k]={real,px}; return px;
}

// параметры вкладок — те же описания, имена с префиксом, группы «Вкладка · группа»; функции от узла получают подузел
function psParams(){
  const out=[], groups=[];
  for(const t of PS_TABS){
    const d=MOD[t.type]; if(!d){ console.warn('planStudio: нет модуля '+t.type); continue; }
    const sub=n=>psSub(n,t), gname=g=>t.label+' · '+(g||'main');
    if(!(d.groups||[]).length || d.params.some(s=>!s.g)) groups.push({n:gname(''),open:true});              // основные параметры вкладки — первыми
    for(const g of (d.groups||[])) groups.push({n:gname(g.n),open:g.open!==false});
    for(const s of d.params){
      const q={...s,n:t.pre+s.n,g:gname(s.g)};
      delete q.pri;
      if(s.fn) q.fn=(n,...a)=>s.fn(sub(n),...a);
      for(const k of ['min','max','step','opts','label','d','tip','get','set']) if(typeof s[k]==='function') q[k]=(n,...a)=>s[k](sub(n),...a);
      if(s.keys) q.keys=s.keys.map(k=>t.pre+k);
      out.push(q);
    }
  }
  // порядок групп: по вкладкам; повторы убираем
  const seen=new Set(), gs=groups.filter(g=>!seen.has(g.n) && seen.add(g.n));
  return {params:out,groups:gs};
}

// показываем группы только активной вкладки; вкладки-кнопки над холстом
function psUi(n){
  const host=n.cv?.parentElement; if(!host) return;
  const t=psTabOf(n);
  if(!n.psBar){
    const bar=document.createElement('div'); bar.className='psTabs vtabs';                 // вид — styles.css (.vtabs): под палец на телефоне, остаётся в режиме «только холст»
    for(const q of PS_TABS){ const b=document.createElement('button'); b.textContent=q.label; b.dataset.t=q.label;
      b.addEventListener('pointerdown',ev=>ev.stopPropagation());
      b.addEventListener('click',ev=>{ ev.stopPropagation(); setMod(n,'tab',q.label); redraw(n); });
      bar.append(b); }
    host.insertBefore(bar,host.firstChild); n.psBar=bar; n.psKey='';
  }
  const secs=host.querySelectorAll('.pgrp'), key=t.label+'|'+secs.length;
  if(key!==n.psKey){
    n.psKey=key;
    for(const sec of secs){ const g=sec.dataset.g||''; sec.style.display=g.startsWith(t.label+' · ') ? '' : 'none'; }
    for(const b of n.psBar.children){ const on=b.dataset.t===t.label; b.classList.toggle('on',on); }
    // всплывающие панели карты (инструменты, формы) живут рядом с канвой — прячем, пока вкладка не Map
    const sm=n.ps?.map; if(sm) for(const k of ['_pickEl','_formEl','_linkEl','_toolsEl','_drawEl','_svEl','_vecEl']){ const e=sm[k]; if(e && e.style){ if(t.k==='map'){ if(e.dataset.psd!==undefined){ e.style.display=e.dataset.psd; delete e.dataset.psd; } } else if(e.dataset.psd===undefined){ e.dataset.psd=e.style.display; e.style.display='none'; } } }
  }
}

def({ id:'planStudio', title:'Plan Studio', cat:'Geo', touch:true, viewTop:true, lazy:true, readout:true, view:{h:520}, w:640, resize:true,
  kw:'plan studio site plan editor map photo image layer house floor plot satellite drone ortho underlay trace one place tabs',
  // rec — внешние записи: GPS-замеры (name, lat, lon, acc), точки, слои; lat / lon / acc / alt — позиция (My Position); lines, file — как у Site Plan; az / el / fov — камера (Editor);
  // rows / links / meas — как у Map. Выходы: Site Plan (area, perim, slope, rms, n, rec, poly), Editor (lines, loss, vent, cover, sig, ncam, nant, margin, room_area), Map (pick, sel, edit, link, pick_lat, pick_lon, count), Photo (mpp)
  ins:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'acc',t:'num'},{n:'alt',t:'num'},{n:'lines',t:'txt'},{n:'file',t:'txt'},{n:'az',t:'num'},{n:'el',t:'num'},{n:'fov',t:'num'},
       {n:'rows',t:'bands'},{n:'links',t:'bands'},{n:'meas',t:'bands'}],
  outs:[{n:'area',t:'num'},{n:'perim',t:'num'},{n:'slope',t:'num'},{n:'rms',t:'num'},{n:'n',t:'num'},{n:'rec',t:'rec'},{n:'poly',t:'rec'},
        {n:'lines',t:'txt'},{n:'loss',t:'num'},{n:'vent',t:'num'},{n:'room_area',t:'num'},{n:'cover',t:'num'},{n:'sig',t:'num'},{n:'ncam',t:'num'},{n:'nant',t:'num'},{n:'margin',t:'num'},
        {n:'pick',t:'rec'},{n:'sel',t:'rec'},{n:'edit',t:'rec'},{n:'link',t:'rec'},{n:'pick_lat',t:'num'},{n:'pick_lon',t:'num'},{n:'count',t:'num'},{n:'mpp',t:'num'}],
  w:640, view:{h:520}, resize:true,
  params:[{n:'tab',t:'select',hidden:true,opts:PS_TABS.map(t=>t.label),d:'Plan',label:'tab: Plan (measurements, 3D) · Editor (walls, rooms, devices) · Map (tiles, your shapes) · Photo (your own aerial image as a layer)',fn:n=>{ n.psKey=''; redraw(n); }},
          ...psParams().params],
  init:n=>{ for(const t of PS_TABS){ const s=psSub(n,t); MOD[t.type].init?.(s); } n.psKey=''; n.fbEdit=null; },
  dispose:n=>{ for(const t of PS_TABS){ try{ MOD[t.type].dispose?.(psSub(n,t)); }catch(e){ console.error('planStudio dispose '+t.type+':',e); } } n.psBar?.remove(); },
  drawKey:n=>{ const t=psTabOf(n), d=MOD[t.type]; return t.k+'|'+(d.drawKey ? d.drawKey(psSub(n,t)) : ''); },
  process(n,I,g){
    const S=k=>psSub(n,PS_TABS.find(t=>t.k===k)), ext=psArr(I.rec), run=(k,inp)=>{ const t=PS_TABS.find(q=>q.k===k); try{ return MOD[t.type].process(S(k),inp,g)||{}; }catch(e){ console.error('planStudio '+k+':',e); return {}; } };
    const fb=n.fbEdit; n.fbEdit=null;                                                      // то, что нарисовали на карте, вернётся в план со следующим тактом
    const sp=run('plan',{lat:I.lat,lon:I.lon,acc:I.acc,alt:I.alt,lines:I.lines,file:I.file,rec:[...ext,...psArr(fb)]});
    const im=run('photo',{rec:[...ext,...psArr(sp.rec)]});
    const pe=run('editor',{rec:[...ext,...psArr(sp.rec),...psArr(im.rec)],lat:I.lat,lon:I.lon,alt:I.alt,az:I.az,el:I.el,fov:I.fov});
    const mp=run('map',{rec:[...ext,...psArr(sp.poly),...psArr(sp.rec),...psArr(im.rec)],rows:I.rows,links:I.links,meas:I.meas});
    if(mp.edit) n.fbEdit=mp.edit;
    return {area:sp.area,perim:sp.perim,slope:sp.slope,rms:sp.rms,n:sp.n,rec:sp.rec,poly:sp.poly,
      lines:pe.lines,loss:pe.loss,vent:pe.vent,room_area:pe.area,cover:pe.cover,sig:pe.sig,ncam:pe.ncam,nant:pe.nant,margin:pe.margin,
      pick:mp.pick,sel:mp.sel,edit:mp.edit,link:mp.link,pick_lat:mp.lat,pick_lon:mp.lon,count:mp.count,mpp:im.mpp};
  },
  draw(n,cv,cx){
    const t=psTabOf(n); psUi(n);
    const d=MOD[t.type]; if(!d.draw) return;
    if(t.k==='map'){ const r=n.el.querySelector('.readout'); if(r) r.textContent=''; }               // у Map своего readout нет — не оставляем текст соседней вкладки
    d.draw(psSub(n,t),psCv(n,t),cx);
  }});

// группы: порядок и раскрытость
{ const G=psParams().groups; if(MOD.planStudio) MOD.planStudio.groups=G.map(g=>({n:g.n,open:g.open})); }
