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
function gvAdd(n,from,to,w,label){
  from=String(from).trim(); to=String(to).trim();
  if(!from || !to) return;
  const nodes=n.nodes, key=from+'\u0001'+to;
  for(const id of [from,to]) if(!nodes.has(id)){
    if(nodes.size>=Math.max(10,+n.p.max||500)) return;
    nodes.set(id,{id,label:id,deg:0}); n.pendN.add(id); }
  let e=n.edges.get(key);
  if(!e){ e={id:key,from,to,w:0,label:''}; n.edges.set(key,e); nodes.get(from).deg++; nodes.get(to).deg++; n.pendN.add(from); n.pendN.add(to); }
  e.w=Number.isFinite(w) ? w : e.w+1;
  if(label) e.label=label;
  n.pendE.add(key);
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
  for(const r of Array.isArray(recs) ? recs : [recs]){
    if(!r || typeof r!=='object') continue;
    const f={}; for(const k in r) for(const nm in GV_NAMES) if(f[nm]==null && GV_NAMES[nm].test(k)) f[nm]=k;
    const ks=Object.keys(r);
    const from=f.from ?? ks[0], to=f.to ?? ks[1];
    if(from==null || to==null) continue;
    const w=f.w!=null ? +r[f.w] : NaN;
    gvAdd(n,r[from],r[to],w,f.label!=null ? r[f.label] : '');
  }
}
function gvClear(n){
  n.nodes=new Map(); n.edges=new Map(); n.pendN=new Set(); n.pendE=new Set(); n.hdr={}; n.reset=true;
  if(n.p.csv) gvLines(n,n.p.csv,n.hdr);
  n.lastText=undefined; n.lastRec=undefined; n.sel='';
  redraw(n);
}
function gvTheme(n){
  const col=themeColor('--acc2'), txt=themeColor('--txt'), line=themeColor('--line');
  return {col,txt,line};
}
function gvNodeItem(n,nd,T){
  return {id:nd.id,label:nd.label,value:1+nd.deg,color:{background:T.col,border:T.col,highlight:{background:themeColor('--acc'),border:themeColor('--acc')}},
          font:{color:T.txt,size:11}};
}
function gvEdgeItem(n,e,T){
  const wl=n.p.weights && e.w!==1 ? String(+e.w.toFixed(3)) : '';
  return {id:e.id,from:e.from,to:e.to,value:Math.abs(e.w)||1,label:[e.label,wl].filter(Boolean).join(' ')||undefined,
          color:{color:T.line,highlight:themeColor('--acc')},font:{color:T.txt,size:9,strokeWidth:0},
          arrows:n.p.directed ? 'to' : undefined};
}
function gvMount(n){
  const box=document.createElement('div'); box.className='graphview';
  box.addEventListener('pointerdown',e=>e.stopPropagation());
  box.addEventListener('wheel',e=>e.stopPropagation());
  box.addEventListener('keydown',e=>e.stopPropagation());
  n.mid.append(box); n.gv=box; if(n.size.h>0) box.style.height=n.size.h+'px'; n.net=null; n.reset=true;
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
    n.reset=true; redraw(n);
  });
}
function gvSync(n){
  if(!n.net) return;
  const T=gvTheme(n);
  if(n.reset){ n.vN.clear(); n.vE.clear(); n.pendN=new Set(n.nodes.keys()); n.pendE=new Set(n.edges.keys()); n.reset=false; }
  if(!n.pendN.size && !n.pendE.size) return;
  const ni=[], ei=[];
  for(const id of n.pendN){ const nd=n.nodes.get(id); if(nd) ni.push(gvNodeItem(n,nd,T)); }
  for(const k of n.pendE){ const e=n.edges.get(k); if(e) ei.push(gvEdgeItem(n,e,T)); }
  n.pendN.clear(); n.pendE.clear();
  n.vN.update(ni); n.vE.update(ei);
}
function gvRestyle(n){ n.reset=true; n.net?.setOptions({physics:{enabled:!!n.p.physics}}); redraw(n); }

def({ id:'graphview', title:'Graph', cat:'Output', kw:'network graph links nodes edges csv vis connections', resize:true, gv:true, readout:true, w:420, h:300,
  ins:[{n:'text',t:'txt'},{n:'rec',t:'rec'}],
  outs:[{n:'nodes',t:'num'},{n:'edges',t:'num'},{n:'sel',t:'txt'}],
  params:[{n:'delim',t:'select',opts:['auto',',',';','tab','|'],d:'auto',label:'delimiter',fn:n=>gvClear(n)},
          {n:'directed',t:'check',d:false,label:'arrows',fn:gvRestyle},
          {n:'weights',t:'check',d:false,label:'weights on edges',fn:gvRestyle},
          {n:'physics',t:'check',d:true,label:'physics (layout)',fn:gvRestyle},
          {n:'max',t:'num',d:500,label:'max nodes',adv:true},
          {n:'fit',t:'button',label:'Fit',fn:n=>n.net?.fit({animation:true})},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.p.csv=''; gvClear(n); }}],
  init:n=>{ n.nodes=new Map(); n.edges=new Map(); n.pendN=new Set(); n.pendE=new Set(); n.hdr={}; n.net=null; n.gv=null;
            n.sel=''; n.reset=true; n.gvErr=''; n.fresh=true; },
  dispose:n=>{ try{ n.net?.destroy(); }catch(e){} n.net=null; },
  process(n,I){
    if(n.fresh){ n.fresh=false; gvClear(n); }
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; gvLines(n,I.text,n.hdr); }
    if(I.rec && I.rec!==n.lastRec){ n.lastRec=I.rec; gvRecs(n,I.rec); }
    return {nodes:n.nodes.size, edges:n.edges.size, sel:n.sel||null}; },
  draw(n){
    if(!n.gv || !n.gv.isConnected){ try{ n.net?.destroy(); }catch(e){} n.net=null; gvMount(n); }
    gvSync(n);
    const r=n.el.querySelector('.readout');
    if(r){ const t=n.gvErr || 'nodes '+n.nodes.size+' · edges '+n.edges.size+(n.sel ? ' · '+n.sel : '');
      if(r.textContent!==t) r.textContent=t; } }
});
