"use strict";
/* ============================ GRAPH VIEW (vis-network) ============================
   Граф связей: запись = ребро (from,to[,weight[,label]]). Данные приходят только по проводам: rec (записи с полями
   from/to/weight/label — по одной с узла 'table') и text (кусок CSV, добавляется при смене строки). Старый параметр csv
   из сохранённых патчей ещё читается, но в интерфейсе его нет. Библиотека — vendor/vis-network.min.js,
   грузится при первом показе. */

const GV_SRC='vendor/vis-network.min.js?v=9.1.9';
const GV_NAMES={from:/^(from|source|src|узел1|от)$/i, to:/^(to|target|dst|dest|узел2|к)$/i,
                w:/^(weight|w|value|count|вес)$/i, label:/^(label|name|text|метка)$/i};
let gvReady=null;
function gvLoad(){
  if(gvReady) return gvReady;
  return gvReady=new Promise(res=>{
    if(window.vis) return res(window.vis);
    const s=document.createElement('script'); s.src=GV_SRC;
    s.onload=()=>res(window.vis); s.onerror=()=>{ gvReady=null; res(null); };
    document.head.append(s); });
}
function gvSplit(line,d){                           // разбор строки CSV с кавычками
  const out=[]; let cur='', q=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(q){ if(c==='"'){ if(line[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=c; }
    else if(c==='"' && !cur) q=true;
    else if(c===d){ out.push(cur); cur=''; }
    else cur+=c; }
  out.push(cur); return out.map(s=>s.trim());
}
function gvDelim(n,line){
  const d=n.p.delim;
  if(d==='tab') return '\t';
  if(d!=='auto') return d;
  let best=',', bc=0;
  for(const c of [',',';','\t','|']){ const k=line.split(c).length; if(k>bc){ bc=k; best=c; } }
  return best;
}
// Граф собирается из двух слоёв. Накопление (rec, text, старый csv): записи только добавляют рёбра.
// Снимок (входы set и nodes, тип bands): весь набор целиком — что пропало из набора, исчезает с графа.
// Итог = объединение слоёв; на vis уходит только разница (gvSync), без пересборки всего графа.
const GV_SHAPES=new Set(['dot','circle','square','box','diamond','triangle','triangleDown','star','hexagon','ellipse','database','text']);
GV_NAMES.color=/^(color|colour|цвет)$/i;
// поля записи ищутся по списку имён в порядке предпочтения (from раньше src: у записей декодеров src — протокол),
// явное имя колонки из параметров перекрывает автоопределение
const GV_ALIAS={from:['from','source','src','узел1','от'], to:['to','target','dst','dest','узел2','к'],
  w:['weight','w','value','count','вес'], label:['label','name','text','метка'], color:['color','colour','цвет']};
const GV_NODEA={id:['id','node','name','key','узел'], label:['label','title','text','метка'], shape:['shape','форма'],
  color:['color','colour','цвет'], size:['size','value','размер'], icon:['icon','значок']};
// значок карты → форма узла, когда колонки shape нет: один и тот же список рисуется и здесь, и на Map
const GV_ICON_SHAPE={dot:'dot',square:'square',diamond:'diamond',triangle:'triangle',star:'star',flag:'triangle',antenna:'triangle',tx:'triangle',plane:'triangle',ship:'box',sat:'diamond',balloon:'dot'};
function gvKeys(r,alias,ovr){
  const low={}; for(const k in r) low[k.toLowerCase()]=k;
  // у записей декодеров src — имя протокола (рядом kind / msg), а не источник связи
  if(low.src!==undefined && (low.kind!==undefined || low.msg!==undefined)) delete low.src;
  const f={};
  for(const nm in alias){
    const o=ovr && ovr[nm];
    if(o){ const k=low[String(o).trim().toLowerCase()]; if(k!==undefined) f[nm]=k; continue; }
    for(const a of alias[nm]) if(low[a]!==undefined){ f[nm]=low[a]; break; }
  }
  return f;
}
const gvOvr=(n,pre)=>{ const o={}; for(const k of Object.keys(pre)) if(n.p[pre[k]]) o[k]=n.p[pre[k]]; return o; };
const gvEdgeOvr=n=>{                                // + toTag: «col=value:префикс» — к id адресата добавляется префикс
  const o=gvOvr(n,{from:'fromCol',to:'toCol',w:'weightCol',label:'labelCol'});
  const m=String(n.p.toTag||'').match(/^([^=]+)=([^:]*):(.*)$/);
  if(m) o.tag={col:m[1].trim().toLowerCase(),val:m[2].trim().toLowerCase(),prefix:m[3]};
  return o;
};
const gvNodeOvr=n=>gvOvr(n,{id:'nodeCol',label:'nodeLabelCol'});
const gvKey=(a,b)=>a+'\u0001'+b;
const GV_ALIASF=['alias','from_label','fromname'];
// подпись отправителя: поле alias записи (и записи, где есть только from — псевдоним абонента)
function gvAliasOf(r,ovr){
  if(!r || typeof r!=='object') return null;
  const f=gvKeys(r,GV_ALIAS,ovr), low={};
  for(const k in r) low[k.toLowerCase()]=k;
  if(f.from==null) return null;
  const a=GV_ALIASF.find(x=>low[x]!==undefined && r[low[x]]!=='' && r[low[x]]!=null);
  return a ? {id:String(r[f.from]).trim(), label:String(r[low[a]])} : null;
}
function gvEdgeRec(r,ovr){                          // запись → {from,to,w,label,color} или null
  if(!r || typeof r!=='object') return null;
  const f=gvKeys(r,GV_ALIAS,ovr), ks=Object.keys(r);
  // имён нет вовсе — первые два поля; найдено одно из двух — запись не про связь (псевдоним, голосовой кадр)
  const bare=f.from==null && f.to==null && !(ovr && (ovr.from || ovr.to));
  const from=f.from ?? (bare ? ks[0] : null), to=f.to ?? (bare ? ks[1] : null);
  if(from==null || to==null) return null;
  const a=String(r[from]??'').trim();
  let b=String(r[to]??'').trim();
  if(!a || !b) return null;
  const tg=ovr && ovr.tag;
  if(tg){ const k=Object.keys(r).find(c=>c.toLowerCase()===tg.col); if(k!==undefined && String(r[k]).toLowerCase()===tg.val) b=tg.prefix+b; }
  const w=f.w!=null && r[f.w]!=='' ? +String(r[f.w]).replace(',','.') : NaN;
  return {from:a,to:b,w:Number.isFinite(w) ? w : NaN,label:f.label!=null ? String(r[f.label]??'') : '',color:f.color!=null ? String(r[f.color]||'') : ''};
}
function gvPut(map,e){                              // без веса повтор пары утолщает ребро
  const key=gvKey(e.from,e.to), c=map.get(key);
  if(!c) map.set(key,{from:e.from,to:e.to,w:Number.isFinite(e.w) ? e.w : 1,label:e.label,color:e.color});
  else { c.w=Number.isFinite(e.w) ? e.w : c.w+1; if(e.label) c.label=e.label; if(e.color) c.color=e.color; }
}
function gvAdd(n,from,to,w,label){
  const e=gvEdgeRec({from,to,w,label});
  if(!e) return;
  for(const id of [e.from,e.to]) if(!n.aNodes.has(id)){
    if(n.aNodes.size>=Math.max(10,+n.p.max||500)) return;
    n.aNodes.add(id); }
  gvPut(n.edges,e); n.dirty=true;
}
function gvLines(n,text,hdr){                       // hdr: объект раскладки столбцов, живёт между вызовами (поток строк)
  for(const raw of String(text).split(/\r?\n/)){
    const line=raw.trim(); if(!line || line[0]==='#') continue;
    const c=gvSplit(line,gvDelim(n,line));
    if(!hdr.done){
      hdr.done=true;
      const m={}; c.forEach((s,i)=>{ for(const k in GV_NAMES) if(m[k]==null && GV_NAMES[k].test(s)) m[k]=i; });
      if(m.from!=null && m.to!=null){ hdr.m=m; continue; }
    }
    const m=hdr.m||{from:0,to:1,w:2,label:3};
    const w=m.w!=null && c[m.w]!=='' ? parseFloat(String(c[m.w]).replace(',','.')) : NaN;
    gvAdd(n,c[m.from],c[m.to],w,m.label!=null ? c[m.label] : (!hdr.m && c.length>3 ? c[3] : ''));
  }
}
function gvRecs(n,recs){
  const ovr=gvEdgeOvr(n);
  for(const r of Array.isArray(recs) ? recs : [recs]){
    const al=gvAliasOf(r,ovr); if(al && n.aliasA.get(al.id)!==al.label){ n.aliasA.set(al.id,al.label); n.dirty=true; }
    const e=gvEdgeRec(r,ovr); if(e) gvAdd(n,e.from,e.to,e.w,e.label);
  }
}
function gvSetEdges(n,recs){                        // снимок рёбер
  const m=new Map();
  const ovr=gvEdgeOvr(n), al=new Map();
  for(const r of recs){
    const a=gvAliasOf(r,ovr); if(a) al.set(a.id,a.label);
    const e=gvEdgeRec(r,ovr); if(e) gvPut(m,e);
  }
  n.sEdges=m; n.aliasS=al; n.dirty=true;
}
function gvSetNodes(n,recs){                        // снимок узлов: id[,label,shape,color,size]
  const m=new Map(), ovr=gvNodeOvr(n);
  for(const r of recs){
    if(!r || typeof r!=='object') continue;
    const f=gvKeys(r,GV_NODEA,ovr), id=String(r[f.id ?? (ovr.id ? null : Object.keys(r)[0])]??'').trim();
    if(!id) continue;
    const a={};
    if(f.label!=null && r[f.label]!=='') a.label=String(r[f.label]);
    if(f.shape!=null){ const sh=String(r[f.shape]).trim(); if(GV_SHAPES.has(sh)) a.shape=sh; }
    if(a.shape==null && f.icon!=null){ const sh=GV_ICON_SHAPE[String(r[f.icon]).trim()]; if(sh) a.shape=sh; }
    if(f.color!=null && r[f.color]) a.color=String(r[f.color]);
    if(f.size!=null){ const v=+r[f.size]; if(v>0) a.size=v; }
    m.set(id,a);
  }
  n.sNodes=m; n.dirty=true;
}
function gvClear(n){                                // накопленное; снимки принадлежат проводам и остаются
  n.edges=new Map(); n.aNodes=new Set(); n.aliasA=new Map(); n.hdr={}; n.dirty=true;
  if(n.p.csv) gvLines(n,n.p.csv,n.hdr);
  n.lastText=undefined; n.lastRec=undefined; n.sel='';
  redraw(n);
}
// желаемый состав графа: n.dN (id → узел), n.dE (ключ → ребро)
function gvBuild(n){
  n.dirty=false;
  const edges=new Map(n.edges);
  for(const [k,e] of n.sEdges) edges.set(k,e);
  const nodes=new Map();
  const touch=id=>{ let nd=nodes.get(id); if(!nd){ nd={id,label:id,deg:0}; nodes.set(id,nd); } return nd; };
  for(const e of edges.values()){ touch(e.from).deg++; touch(e.to).deg++; }
  for(const al of [n.aliasA,n.aliasS]) for(const [id,label] of al){     // псевдонимы — подпись по умолчанию
    const nd=nodes.get(id); if(nd) nd.label=label+'\n'+id;
  }
  for(const [id,a] of n.sNodes) Object.assign(touch(id),a);
  n.dN=nodes; n.dE=edges; n.sync=true;
}
function gvTheme(n){
  const col=themeColor('--acc2'), txt=themeColor('--txt'), line=themeColor('--line'), acc=themeColor('--acc');
  return {col,txt,line,acc,key:col+txt+line+acc};
}
function gvNodeItem(n,nd,T){
  const c=nd.color||T.col;
  const it={id:nd.id,label:nd.label,shape:nd.shape||'dot',color:{background:c,border:c,highlight:{background:T.acc,border:T.acc}},
            font:{color:T.txt,size:11}};
  if(nd.size) it.size=nd.size; else it.value=1+nd.deg;
  return it;
}
function gvEdgeItem(n,key,e,T){
  const wl=n.p.weights && e.w!==1 ? String(+e.w.toFixed(3)) : '';
  const c=e.color||T.line;
  return {id:key,from:e.from,to:e.to,value:Math.abs(e.w)||1,label:[e.label,wl].filter(Boolean).join(' ')||undefined,
          color:{color:c,highlight:T.acc},font:{color:T.txt,size:9,strokeWidth:0},
          arrows:n.p.directed ? 'to' : undefined};
}
function gvMount(n){
  const box=document.createElement('div'); box.className='graphview';
  box.addEventListener('pointerdown',e=>e.stopPropagation());
  box.addEventListener('wheel',e=>e.stopPropagation());
  box.addEventListener('keydown',e=>e.stopPropagation());
  n.mid.append(box); n.gv=box; if(n.size.h>0) box.style.height=n.size.h+'px'; n.net=null; n.sigN.clear(); n.sigE.clear(); n.sync=true;
  gvLoad().then(vis=>{
    if(!vis){ n.gvErr='vis-network failed to load'; return; }
    if(n.gv!==box || !box.isConnected) return;
    n.vN=new vis.DataSet(); n.vE=new vis.DataSet();
    n.net=new vis.Network(box,{nodes:n.vN,edges:n.vE},{
      autoResize:true, interaction:{hover:true,tooltipDelay:200},
      nodes:{shape:'dot',scaling:{min:5,max:18}}, edges:{scaling:{min:1,max:5},smooth:false,arrows:{to:{scaleFactor:.5}}},
      physics:{enabled:!!n.p.physics,solver:'forceAtlas2Based',stabilization:{iterations:80}}});
    // под CSS-масштабом холста клиентские координаты больше / меньше реальных пикселей канвы
    const fix=g=>{ const r=box.getBoundingClientRect(), s=r.width/(box.offsetWidth||1)||1; return {x:(g.x-r.left)/s,y:(g.y-r.top)/s}; };
    n.net.interactionHandler.getPointer=fix; n.net.body.functions.getPointer=fix;
    n.net.on('click',ev=>{ n.sel=ev.nodes.length ? String(ev.nodes[0]) : ''; });
    n.sigN.clear(); n.sigE.clear(); n.sync=true; redraw(n);
  });
}
// на vis уходит только разница с уже показанным: новые и изменившиеся — update, пропавшие — remove
function gvSync(n){
  if(n.dirty) gvBuild(n);
  if(!n.net || !n.sync) return;
  n.sync=false;
  const T=gvTheme(n);
  if(n.themeKey!==T.key){ n.themeKey=T.key; n.sigN.clear(); n.sigE.clear(); }
  const diff=(want,sigs,ds,make)=>{
    const upd=[];
    for(const [k,v] of want){
      const it=make(k,v), sig=JSON.stringify(it);
      if(sigs.get(k)!==sig){ sigs.set(k,sig); upd.push(it); }
    }
    const gone=ds.getIds().filter(k=>!want.has(k));
    for(const k of gone) sigs.delete(k);
    if(gone.length) ds.remove(gone);
    if(upd.length) ds.update(upd);
  };
  diff(n.dN,n.sigN,n.vN,(k,nd)=>gvNodeItem(n,nd,T));    // узлы раньше рёбер
  diff(n.dE,n.sigE,n.vE,(k,e)=>gvEdgeItem(n,k,e,T));
}
function gvRemap(n){                                // другие колонки — снимки читаются заново
  if(n.lastSet) gvSetEdges(n,n.lastSet);
  if(n.lastNodes) gvSetNodes(n,n.lastNodes);
  redraw(n);
}
function gvRestyle(n){ n.sigN.clear(); n.sigE.clear(); n.sync=true; n.net?.setOptions({physics:{enabled:!!n.p.physics}}); redraw(n); }

def({ id:'graphview', title:'Graph', cat:'Output', kw:'network graph links nodes edges csv vis connections', resize:true, gv:true, readout:true, w:420, h:300,
  ins:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'set',t:'bands'},{n:'nodes',t:'bands'}],
  outs:[{n:'nodes',t:'num'},{n:'edges',t:'num'},{n:'sel',t:'txt'}],
  params:[{n:'delim',t:'select',opts:['auto',',',';','tab','|'],d:'auto',label:'delimiter',fn:n=>gvClear(n)},
          {n:'directed',t:'check',d:false,label:'arrows',fn:gvRestyle},
          {n:'weights',t:'check',d:false,label:'weights on edges',fn:gvRestyle},
          {n:'physics',t:'check',d:true,label:'physics (layout)',fn:gvRestyle},
          {n:'max',t:'num',d:500,label:'max nodes',adv:true},
          {n:'fromCol',t:'text',d:'',label:'edge from col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'toCol',t:'text',d:'',label:'edge to col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'weightCol',t:'text',d:'',label:'edge weight col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'labelCol',t:'text',d:'',label:'edge label col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'toTag',t:'text',d:'',label:'prefix for to: col=value:prefix',adv:true,fn:n=>gvRemap(n)},
          {n:'nodeCol',t:'text',d:'',label:'node id col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'nodeLabelCol',t:'text',d:'',label:'node label col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'fit',t:'button',label:'Fit',fn:n=>n.net?.fit({animation:true})},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.p.csv=''; gvClear(n); }}],
  init:n=>{ n.aliasA=new Map(); n.aliasS=new Map(); n.edges=new Map(); n.aNodes=new Set(); n.sEdges=new Map(); n.sNodes=new Map(); n.dN=new Map(); n.dE=new Map();
            n.sigN=new Map(); n.sigE=new Map(); n.hdr={}; n.net=null; n.gv=null; n.lastSet=null; n.lastNodes=null;
            n.sel=''; n.dirty=true; n.sync=true; n.gvErr=''; n.fresh=true; },
  dispose:n=>{ try{ n.net?.destroy(); }catch(e){} n.net=null; },
  process(n,I){
    if(n.fresh){ n.fresh=false; gvClear(n); }
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; gvLines(n,I.text,n.hdr); }
    if(I.rec && I.rec!==n.lastRec){ n.lastRec=I.rec; gvRecs(n,I.rec); }
    // снимок: меняется только вместе с самим набором (по ссылке); отключили провод — слой пуст
    for(const [port,key,set] of [['set','lastSet',gvSetEdges],['nodes','lastNodes',gvSetNodes]]){
      if(Array.isArray(I[port])){ if(I[port]!==n[key]){ n[key]=I[port]; set(n,I[port]); } }
      else if(n[key]){ n[key]=null; set(n,[]); }
    }
    if(n.dirty) gvBuild(n);
    return {nodes:n.dN.size, edges:n.dE.size, sel:n.sel||null}; },
  draw(n){
    if(!n.gv || !n.gv.isConnected){ try{ n.net?.destroy(); }catch(e){} n.net=null; gvMount(n); }
    gvSync(n);
    const r=n.el.querySelector('.readout');
    if(r){ const t=n.gvErr || 'nodes '+n.dN.size+' · edges '+n.dE.size+(n.sel ? ' · '+n.sel : '');
      if(r.textContent!==t) r.textContent=t; } }
});
