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
const GV_SHAPES=new Set(['dot','circle','square','box','diamond','triangle','triangleDown','star','hexagon','ellipse','database','text','image','circularImage','icon']);
GV_NAMES.color=/^(color|colour|цвет)$/i;
// поля записи ищутся по списку имён в порядке предпочтения (from раньше src: у записей декодеров src — протокол),
// явное имя колонки из параметров перекрывает автоопределение
const GV_ALIAS={from:['from','source','src','узел1','от'], to:['to','target','dst','dest','узел2','к'],
  w:['weight','w','value','count','вес'], label:['label','name','text','метка'], color:['color','colour','цвет'], dash:['dashes','dash','пунктир'], arrows:['arrows','arrow','стрелки','стрелка']};
const GV_NODEA={id:['id','node','name','key','узел'], label:['label','title','text','метка'], shape:['shape','форма'],
  color:['color','colour','цвет'], size:['size','value','размер'], icon:['icon','значок'], group:['group','grp','cluster','группа'], image:['image','img','picture','картинка'], glyph:['glyph','symbol','глиф'], note:['note','comment','notes','комментарий','заметка']};
// значок карты → форма узла, когда колонки shape нет: один и тот же список рисуется и здесь, и на Map
const GV_ICON_SHAPE={dot:'dot',square:'square',diamond:'diamond',triangle:'triangle',star:'star',flag:'triangle',antenna:'triangle',tx:'triangle',plane:'triangle',ship:'box',sat:'diamond',balloon:'dot'};
// у строк одной таблицы набор колонок один и тот же: разбор имён запоминается по форме строки (alias × ovr), строка сверяется ключами
const GV_SHAPES_C=new Map();
function gvKeys(r,alias,ovr){
  ovr=ovr||null;
  let L=GV_SHAPES_C.get(alias); if(!L) GV_SHAPES_C.set(alias,L=[]);
  for(const e of L){
    if(e.ovr!==ovr) continue;
    let i=0; const ks=e.keys;
    for(const k in r){ if(ks[i++]!==k){ i=-1; break; } }
    if(i===ks.length) return e.f;
  }
  const f=gvKeysScan(r,alias,ovr);
  const e={ovr,keys:Object.keys(r),f}, at=L.findIndex(x=>x.ovr===ovr);
  if(at>=0) L[at]=e; else { L.push(e); if(L.length>6) L.shift(); }
  return f;
}
function gvKeysScan(r,alias,ovr){
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
const gvNodeOvr=n=>gvOvr(n,{id:'nodeCol',label:'nodeLabelCol',group:'groupCol',image:'imageCol'});
const gvKey=(a,b)=>a+'\u0001'+b;
const GV_ALIASF=['alias','from_label','fromname'], GV_ALIASA={a:GV_ALIASF};
// подпись отправителя: поле alias записи (и записи, где есть только from — псевдоним абонента)
function gvAliasOf(r,ovr){
  if(!r || typeof r!=='object') return null;
  const f=gvKeys(r,GV_ALIAS,ovr);
  if(f.from==null) return null;
  const a=gvKeys(r,GV_ALIASA,null).a;
  return a!=null && r[a]!=='' && r[a]!=null ? {id:String(r[f.from]).trim(), label:String(r[a])} : null;
}
function gvEdgeRec(r,ovr){                          // запись → {from,to,w,label,color} или null
  if(!r || typeof r!=='object') return null;
  const f=gvKeys(r,GV_ALIAS,ovr);
  // имён нет вовсе — первые два поля; найдено одно из двух — запись не про связь (псевдоним, голосовой кадр)
  const bare=f.from==null && f.to==null && !(ovr && (ovr.from || ovr.to)), ks=bare ? Object.keys(r) : null;
  const from=f.from ?? (bare ? ks[0] : null), to=f.to ?? (bare ? ks[1] : null);
  if(from==null || to==null) return null;
  const a=String(r[from]??'').trim();
  let b=String(r[to]??'').trim();
  if(!a || !b) return null;
  const tg=ovr && ovr.tag;
  if(tg){ const k=Object.keys(r).find(c=>c.toLowerCase()===tg.col); if(k!==undefined && String(r[k]).toLowerCase()===tg.val) b=tg.prefix+b; }
  const w=f.w!=null && r[f.w]!=='' ? +String(r[f.w]).replace(',','.') : NaN;
  return {from:a,to:b,w:Number.isFinite(w) ? w : NaN,label:f.label!=null ? String(r[f.label]??'') : '',color:f.color!=null ? String(r[f.color]||'') : '',
          dash:f.dash!=null && /^(1|true|yes|dash|dashed)$/i.test(String(r[f.dash]).trim()),
          arrows:f.arrows!=null ? String(r[f.arrows]??'').trim() : ''};
}
// записи набора rows → узлы и связи: связь — запись с непустыми from и to (или их псевдонимами), остальное — узлы;
// разбор кэшируется по самому массиву, поэтому ссылки стабильны, пока набор не сменился
function rowIsEdge(r){
  if(!r || typeof r!=='object') return false;
  const f=gvKeys(r,GV_ALIAS,null);
  return f.from!=null && f.to!=null && String(r[f.from]??'').trim()!=='' && String(r[f.to]??'').trim()!=='';
}
const ROWS_SPLIT=new WeakMap();
function rowsSplit(rows){
  let c=ROWS_SPLIT.get(rows);
  if(!c){ c={nodes:[],edges:[]}; for(const r of rows){ if(r && typeof r==='object') (rowIsEdge(r) ? c.edges : c.nodes).push(r); } ROWS_SPLIT.set(rows,c); }
  return c;
}
function gvPut(map,e){                              // без веса повтор пары утолщает ребро
  const key=gvKey(e.from,e.to), c=map.get(key);
  if(!c) map.set(key,{from:e.from,to:e.to,w:Number.isFinite(e.w) ? e.w : 1,label:e.label,color:e.color,dash:!!e.dash,arrows:e.arrows||''});
  else { c.w=Number.isFinite(e.w) ? e.w : c.w+1; if(e.label) c.label=e.label; if(e.color) c.color=e.color; if(e.arrows) c.arrows=e.arrows; c.dash=c.dash && !!e.dash; }   // пара со сплошной связью рисуется сплошной
}
function gvAdd(n,from,to,w,label,x){             // x — остальные поля связи записи (цвет, пунктир, стрелки)
  const e=gvEdgeRec({from,to,w,label});
  if(!e) return;
  if(x){ e.color=x.color||''; e.dash=!!x.dash; e.arrows=x.arrows||''; }
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
    const e=gvEdgeRec(r,ovr); if(e) gvAdd(n,e.from,e.to,e.w,e.label,e);
  }
}
function gvNodeRec(r,ovr){                          // запись → {id,a:{label,shape,color,note,size}} или null
  const f=gvKeys(r,GV_NODEA,ovr), id=String(r[f.id ?? (ovr.id ? null : Object.keys(r)[0])]??'').trim();
  if(!id) return null;
  const a={};
  if(f.label!=null && r[f.label]!=='') a.label=String(r[f.label]);
  if(f.shape!=null){ const sh=String(r[f.shape]).trim(); if(GV_SHAPES.has(sh)) a.shape=sh; }
  if(a.shape==null && f.icon!=null){ const sh=GV_ICON_SHAPE[String(r[f.icon]).trim()]; if(sh) a.shape=sh; }
  if(f.glyph!=null && gvIsGlyph(r[f.glyph])) a.glyph=String(r[f.glyph]).trim();
  else if(f.icon!=null && !GV_ICON_SHAPE[String(r[f.icon]).trim()] && gvIsGlyph(r[f.icon])) a.glyph=String(r[f.icon]).trim();   // icon=📶 — значок-символ
  if(f.image!=null && String(r[f.image]).trim()) a.image=String(r[f.image]).trim();
  if(!a.image && !a.glyph && !a.shape && typeof dvIconKey==='function'){                     // ни формы, ни картинки: значок устройства по полям (имя, OEM, класс…) или по имени из icon
    const k=dvIconKey(r); if(k) a.image=dvIconUri(k,r[f.color]&&CSS.supports('color',String(r[f.color])) ? String(r[f.color]) : '');
  }
  if(f.group!=null && String(r[f.group]).trim()) a.group=String(r[f.group]).trim();
  if(f.color!=null && r[f.color]) a.color=String(r[f.color]);
  if(f.note!=null && String(r[f.note]).trim()) a.note=String(r[f.note]).trim();
  if(f.size!=null){ const v=+r[f.size]; if(v>0) a.size=v; }
  return {id,a};
}
/* Снимок rows — по разнице. Для каждой строки (ключ — сам объект) помним версию (TBL_REV у строк Table, меняемых на месте)
   и вклад в граф: связь, узел, псевдоним. Новая или изменившаяся строка берётся заново, пропавшая — вычитается;
   неизменные только отмечаются (один проход по Map, без разбора колонок). Рёбра с одной парой from/to складываются:
   вес = сумма строк без своего веса, либо последний заданный; пунктир — пока нет ни одной сплошной. */
function gvIncNew(){ return {rows:new Map(), edges:new Map(), nodes:new Map(), gen:0}; }
function gvEdgeOut(E){ return {from:E.from,to:E.to,w:E.exp!=null ? E.exp : Math.max(1,E.cnt),label:E.label,color:E.color,dash:E.solid===0,arrows:E.arrows}; }
function gvIncApply(n,inc,info,sign){
  if(info.e){
    const e=info.e, key=gvKey(e.from,e.to);
    let E=inc.edges.get(key);
    if(sign>0){
      if(!E) inc.edges.set(key,E={from:e.from,to:e.to,cnt:0,exp:null,solid:0,rows:0,label:'',color:'',arrows:''});
      E.rows++; if(Number.isFinite(e.w)) E.exp=e.w; else E.cnt++;
      if(!e.dash) E.solid++;
      if(e.label) E.label=e.label; if(e.color) E.color=e.color; if(e.arrows) E.arrows=e.arrows;
    } else if(E){
      E.rows--; if(!Number.isFinite(e.w)) E.cnt--; if(!e.dash) E.solid--;
      if(E.rows<=0){ inc.edges.delete(key); n.sEdges.delete(key); E=null; }
    }
    if(E) n.sEdges.set(key,gvEdgeOut(E));
  }
  if(info.al){
    if(sign>0) n.aliasS.set(info.al.id,info.al.label);
    else if(n.aliasS.get(info.al.id)===info.al.label) n.aliasS.delete(info.al.id);
  }
  if(info.nd){
    const id=info.nd.id;
    let m=inc.nodes.get(id);
    if(sign>0){
      if(!m) inc.nodes.set(id,m=new Map());
      m.set(info.row,info.nd.a); n.sNodes.set(id,info.nd.a);
    } else if(m){
      m.delete(info.row);
      if(!m.size){ inc.nodes.delete(id); n.sNodes.delete(id); }
      else { let last; for(const a of m.values()) last=a; n.sNodes.set(id,last); }
    }
  }
}
function gvRows(n,rows){
  const inc=n.inc || (n.inc=gvIncNew()), eo=gvEdgeOvr(n), no=gvNodeOvr(n), g=++inc.gen;
  const rev=typeof TBL_REV!=='undefined' ? TBL_REV : null;
  let seen=0, changed=false;
  for(const r of rows){
    if(!r || typeof r!=='object') continue;
    seen++;
    const v=rev ? rev.get(r)|0 : 0;
    let info=inc.rows.get(r);
    if(info && info.v===v){ info.g=g; continue; }
    if(info) gvIncApply(n,inc,info,-1);
    info={row:r,v,g,e:null,al:null,nd:null};
    if(rowIsEdge(r)){ info.e=gvEdgeRec(r,eo); info.al=gvAliasOf(r,eo); }
    else info.nd=gvNodeRec(r,no);
    inc.rows.set(r,info); gvIncApply(n,inc,info,1); changed=true;
  }
  if(inc.rows.size!==seen){                          // кто-то пропал из набора
    for(const [r,info] of inc.rows) if(info.g!==g){ gvIncApply(n,inc,info,-1); inc.rows.delete(r); changed=true; }
  }
  if(changed) n.dirty=true;
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
  for(const [id,a] of n.sNodes){
    const nd=Object.assign(touch(id),a);
    if(a.note) nd.label=nd.label+'\n✎ '+a.note;       // комментарий из колонки note — под подписью
  }
  const ed=n.p.edits;                                // правки на самом графе (панель по щелчку) — поверх всего
  if(ed) for(const id in ed){
    const nd=nodes.get(id), a=ed[id]; if(!nd) continue;
    for(const k in a) if(k!=='note' && a[k]!=='' && a[k]!=null) nd[k]=a[k];
    const note=a.note || nd.note;
    if(note){ nd.note=note; nd.label=String(nd.label).replace(/\n✎ [\s\S]*$/,'')+'\n✎ '+note; }
  }
  n.dN=nodes; n.dE=edges; n.sync=true;
}
function gvTheme(n){
  const col=themeColor('--acc2'), txt=themeColor('--txt'), line=themeColor('--line'), acc=themeColor('--acc');
  return {col,txt,line,acc,key:col+txt+line+acc};
}
// подсветка: узлы, чьё id встречается в любом поле строк hl (найденное фильтром Table), и их соседи; остальное притушено
function gvHlCalc(n){
  const rows=n.hlRows;
  if(!rows || !rows.length){ n.hl=null; return; }
  const full=new Set(), all=new Set();
  for(let i=0;i<rows.length && i<5000;i++){
    const r=rows[i]; if(!r || typeof r!=='object') continue;
    for(const k in r){ const v=r[k]; if(v==null || v==='') continue; const s=String(v); if(n.dN.has(s)) full.add(s); }
  }
  for(const id of full) all.add(id);
  if(n.p.hlNb) for(const e of n.dE.values()){ if(full.has(e.from)) all.add(e.to); if(full.has(e.to)) all.add(e.from); }
  n.hl=full.size ? {full,all} : null;      // ничего не нашлось — не гасим весь граф
}
function gvNodeItem(n,nd,T){
  const c=nd.color || (nd.group ? gvGroupColor(nd.group) : T.col), sh=gvNodeShape(nd,GV_SHAPES);
  const it={id:nd.id,label:nd.label,shape:sh,color:{background:c,border:c,highlight:{background:T.acc,border:T.acc}},
            font:{color:T.txt,size:11}};
  if(nd.group) it.group=nd.group;
  if(GV_IMG_SHAPES.has(sh)){ it.image=nd.image; it.imagePadding=2; }
  else if(sh==='icon') it.icon={face:'sans-serif',code:nd.glyph,size:44,color:c};
  if(nd.note) it.title=nd.note;
  if(n.hl){
    if(!n.hl.all.has(nd.id)){ it.opacity=.15; it.font={color:T.line,size:11}; }
    else if(n.hl.full.has(nd.id)){ it.borderWidth=4; it.color.border=T.acc; }
  }
  if(nd.size) it.size=nd.size; else if(GV_IMG_SHAPES.has(sh)) it.size=22; else it.value=1+nd.deg;   // картинке нужен свой размер: масштаб по степени делает её точкой
  return it;
}
function gvEdgeItem(n,key,e,T){
  const wl=n.p.weights && e.w!==1 ? String(+e.w.toFixed(3)) : '';
  const c=e.color||T.line;
  const dim=n.hl && !(n.hl.all.has(e.from) && n.hl.all.has(e.to) && (n.hl.full.has(e.from) || n.hl.full.has(e.to)));
  return {id:key,from:e.from,to:e.to,value:Math.abs(e.w)||1,label:dim ? undefined : [e.label,wl].filter(Boolean).join(' ')||undefined,
          color:{color:c,highlight:T.acc,opacity:dim ? .08 : 1},font:{color:T.txt,size:9,strokeWidth:0},
          dashes:e.dash ? [6,5] : false, arrows:gvArrowsSpec(e.arrows,n.p.directed)};
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
    n.net=new vis.Network(box,{nodes:n.vN,edges:n.vE},gvNetOpts(n.p));
    // под CSS-масштабом холста клиентские координаты больше / меньше реальных пикселей канвы
    const fix=g=>{ const r=box.getBoundingClientRect(), s=r.width/(box.offsetWidth||1)||1; return {x:(g.x-r.left)/s,y:(g.y-r.top)/s}; };
    n.net.interactionHandler.getPointer=fix; n.net.body.functions.getPointer=fix;
    n.net.on('click',ev=>{ n.sel=ev.nodes.length ? String(ev.nodes[0]) : ''; gvEditShow(n); });
    n.sigN.clear(); n.sigE.clear(); n.sync=true; redraw(n);
  });
}
// на vis уходит только разница с уже показанным: новые и изменившиеся — update, пропавшие — remove
function gvSync(n){
  if(n.dirty) gvBuild(n);
  if(!n.net || !n.sync) return;
  n.sync=false;
  gvHlCalc(n);
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
function gvIncReset(n){ n.inc=null; n.sEdges=new Map(); n.sNodes=new Map(); n.aliasS=new Map(); n.dirty=true; }
function gvRemap(n){                                // другие колонки — набор читается заново
  if(n.lastRows){ gvIncReset(n); gvRows(n,n.lastRows); }
  redraw(n);
}
function gvRestyle(n){ n.sigN.clear(); n.sigE.clear(); n.sync=true; n.net?.setOptions({physics:{enabled:n.p.physics!==false}}); redraw(n); }
function gvRemount(n){                              // раскладка, решатель, изгиб рёбер: сеть строится заново с новыми опциями
  try{ n.net?.destroy(); }catch(e){}
  n.net=null; n.gv?.remove(); n.gv=null; n.edBox=null; n.sigN.clear(); n.sigE.clear(); n.sync=true; redraw(n);
}
function gvCluster(n,on){                           // свернуть группы в один узел / раскрыть обратно
  const net=n.net; if(!net) return;
  if(on){ for(const g of new Set([...n.dN.values()].map(x=>x.group).filter(Boolean))) net.cluster({joinCondition:o=>o.group===g,clusterNodeProperties:{label:g,shape:'database',borderWidth:3}}); }
  else for(const id of net.body.nodeIndices.slice()) if(net.isCluster(id)) net.openCluster(id);
}
/* Правка узла (как на карте): щелчок открывает панель — подпись, комментарий, группа, цвет, форма, картинка, значок. Правка пишется в
   n.p.edits (видна сразу, лежит в патче) и уходит записью {id,…} на выход edit — в Table (upsert по id), как у карты. */
const GV_EDIT_F=[['label','label'],['note','comment'],['group','group'],['color','colour #rrggbb'],['shape','shape'],['image','image URL'],['glyph','symbol'],['size','size']];
function gvPushEdit(n,rec){
  n.editQ.push(rec);
  if(typeof Eng!=='undefined' && Eng.running && !Eng.paused) return;
  const recs=n.editQ.splice(0);
  for(const e of Graph.edges) if(e.from===n.id && e.fp==='edit'){ const t=Graph.map[e.to]; if(t?.type==='table') tblIngest(t,recs,true); }
}
function gvEditHide(n){ n.edBox?.remove(); n.edBox=null; n.edId=''; }
function gvEditShow(n){
  gvEditHide(n);
  if(!n.p.edit || !n.sel || !n.gv) return;
  const nd=n.dN.get(n.sel); if(!nd) return;
  const id=n.sel, cur=Object.assign({},n.sNodes.get(id),n.p.edits?.[id]);
  if(getComputedStyle(n.gv).position==='static') n.gv.style.position='relative';
  const el=document.createElement('div'); el.className='gv-edit';
  el.style.cssText='position:absolute;left:4px;right:4px;bottom:4px;max-height:70%;overflow:auto;background:var(--panel);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:4px;border-radius:4px;z-index:3;touch-action:auto;';
  for(const ev of ['pointerdown','pointerup','wheel','dblclick','keydown']) el.addEventListener(ev,x=>x.stopPropagation());
  const inp='min-width:0;width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:1px 3px;';
  const t=document.createElement('div'); t.style.cssText='font-weight:bold;margin-bottom:2px;'; t.textContent=id; el.append(t);
  const ins={};
  for(const [k,ph] of GV_EDIT_F){
    const d=document.createElement('div'); d.style.cssText='display:flex;gap:4px;margin:2px 0;align-items:center;';
    const l=document.createElement('span'); l.textContent=k; l.style.cssText='width:30%;flex:none;';
    let i;
    if(k==='note'){ i=document.createElement('textarea'); i.rows=2; }
    else if(k==='shape'){ i=document.createElement('select'); for(const v of ['',...GV_SHAPES]){ const o=document.createElement('option'); o.value=o.textContent=v; i.append(o); } }
    else i=document.createElement('input');
    i.style.cssText=inp; i.placeholder=ph; i.value=cur[k]==null ? '' : String(cur[k]);
    ins[k]=i; d.append(l,i); el.append(d);
  }
  const bar=document.createElement('div'); bar.style.cssText='display:flex;gap:4px;margin-top:3px;';
  const btn=(txt,f)=>{ const b=document.createElement('button'); b.textContent=txt; b.style.cssText='background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;'; b.onclick=f; bar.append(b); };
  btn('Save',()=>{
    const ch={}, ed=Object.assign({},n.p.edits?.[id]);
    for(const [k] of GV_EDIT_F){
      let v=ins[k].value.trim(); if(k==='size') v=v!=='' && +v>0 ? +v : '';
      if(v!==(cur[k]==null ? '' : cur[k])){ ch[k]=v; if(v==='') delete ed[k]; else ed[k]=v; }
    }
    if(!Object.keys(ch).length) return gvEditHide(n);
    n.p.edits=Object.assign({},n.p.edits,{[id]:ed});
    if(!Object.keys(ed).length) delete n.p.edits[id];
    gvPushEdit(n,{id,...ch}); n.dirty=true; gvEditHide(n); redraw(n);
  });
  btn('Reset',()=>{ if(n.p.edits?.[id]){ delete n.p.edits[id]; n.dirty=true; } gvEditHide(n); redraw(n); });
  btn('✕',()=>gvEditHide(n));
  el.append(bar); n.gv.append(el); n.edBox=el; n.edId=id;
}

def({ id:'graphview', title:'Graph', cat:'Output', kw:'network graph links nodes edges csv vis connections', resize:true, gv:true, readout:true, w:420, h:300,
  ins:[{n:'text',t:'txt'},{n:'rec',t:'rec'},{n:'rows',t:'bands'},{n:'hl',t:'bands'}],
  outs:[{n:'nodes',t:'num'},{n:'edges',t:'num'},{n:'sel',t:'txt'},{n:'edit',t:'rec'}],
  params:[{n:'delim',t:'select',opts:['auto',',',';','tab','|'],d:'auto',label:'delimiter',fn:n=>gvClear(n)},
          {n:'directed',t:'check',d:false,label:'arrows',fn:gvRestyle},
          {n:'weights',t:'check',d:false,label:'weights on edges',fn:gvRestyle},
          {n:'physics',t:'check',d:true,label:'physics (layout)',fn:gvRestyle},
          {n:'layout',t:'select',opts:['free','UD','DU','LR','RL'],d:'free',label:'layout: free, or tree (UD down, DU up, LR →, RL ←)',fn:gvRemount},
          {n:'solver',t:'select',opts:GV_SOLVERS,d:'forceAtlas2Based',label:'physics solver (free layout)',fn:gvRemount},
          {n:'smooth',t:'select',opts:GV_SMOOTH,d:'off',label:'edge curve',fn:gvRemount},
          {n:'edit',t:'check',d:true,label:'edit a node on click (comment, group, colour…) → out edit',fn:n=>{ if(!n.p.edit) gvEditHide(n); }},
          {n:'hlNb',t:'check',d:true,label:'highlight neighbours too (hl input)',fn:gvRestyle},
          {n:'max',t:'num',d:500,label:'max nodes',adv:true},
          {n:'fromCol',t:'text',d:'',label:'edge from col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'toCol',t:'text',d:'',label:'edge to col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'weightCol',t:'text',d:'',label:'edge weight col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'labelCol',t:'text',d:'',label:'edge label col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'toTag',t:'text',d:'',label:'prefix for to: col=value:prefix',adv:true,fn:n=>gvRemap(n)},
          {n:'nodeCol',t:'text',d:'',label:'node id col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'nodeLabelCol',t:'text',d:'',label:'node label col (auto)',adv:true,fn:n=>gvRemap(n)},
          {n:'groupCol',t:'text',d:'',label:'node group col (auto: group; e.g. type)',adv:true,fn:n=>gvRemap(n)},
          {n:'imageCol',t:'text',d:'',label:'node image col (auto: image)',adv:true,fn:n=>gvRemap(n)},
          {n:'sort',t:'select',opts:['directed','hubsize'],d:'directed',label:'tree: level order',adv:true,fn:gvRemount},
          {n:'levelSep',t:'num',d:120,label:'tree: level gap',adv:true,fn:gvRemount},
          {n:'nodeSpacing',t:'num',d:100,label:'tree: node gap',adv:true,fn:gvRemount},
          {n:'fit',t:'button',label:'Fit',fn:n=>n.net?.fit({animation:true})},
          {n:'cluster',t:'button',label:'Cluster groups',fn:n=>gvCluster(n,true)},
          {n:'uncluster',t:'button',label:'Open clusters',fn:n=>gvCluster(n,false)},
          {n:'clear',t:'button',label:'Clear',fn:n=>{ n.p.csv=''; gvClear(n); }}],
  init:n=>{ n.aliasA=new Map(); n.aliasS=new Map(); n.edges=new Map(); n.aNodes=new Set(); n.sEdges=new Map(); n.sNodes=new Map(); n.dN=new Map(); n.dE=new Map();
            n.sigN=new Map(); n.sigE=new Map(); n.hdr={}; n.net=null; n.gv=null; n.lastRows=null; n.inc=null;
            n.sel=''; n.dirty=true; n.sync=true; n.gvErr=''; n.fresh=true; n.editQ=[]; n.edBox=null; },
  dispose:n=>{ try{ n.net?.destroy(); }catch(e){} n.net=null; },
  process(n,I){
    if(n.fresh){ n.fresh=false; gvClear(n); }
    if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; gvLines(n,I.text,n.hdr); }
    if(I.rec && I.rec!==n.lastRec){ n.lastRec=I.rec; gvRecs(n,I.rec); }
    // снимок: меняется только вместе с самим набором (по ссылке); отключили провод — слой пуст
    const rows=Array.isArray(I.rows) ? I.rows : null;
    if(rows!==n.lastRows){ n.lastRows=rows; if(rows) gvRows(n,rows); else gvIncReset(n); }
    const hl=Array.isArray(I.hl) ? I.hl : null;
    if(hl!==n.hlRows){ n.hlRows=hl; n.sync=true; }
    if(n.dirty) gvBuild(n);
    return {nodes:n.dN.size, edges:n.dE.size, sel:n.sel||null, edit:n.editQ.length ? n.editQ.splice(0) : null}; },
  draw(n){
    if(!n.gv || !n.gv.isConnected){ try{ n.net?.destroy(); }catch(e){} n.net=null; gvMount(n); }
    gvSync(n);
    const r=n.el.querySelector('.readout');
    if(r){ const t=n.gvErr || 'nodes '+n.dN.size+' · edges '+n.dE.size+(n.sel ? ' · '+n.sel : '');
      if(r.textContent!==t) r.textContent=t; } }
});

/* ============================ ENTITY CARD ============================
   Карточка сущности: строка таблицы (rows, как у Graph) + связи в обе стороны, сгруппированные по метке.
   Выбор — провод sel (Graph.sel), щелчок по связанной сущности или поиск по id / подписи. */
const EC_HIDE=new Set(['id','node','name','label','type','shape','color','size','icon','from','to','source','target','src','dst','weight','count','first','last','t']);
const ecStr=v=>String(v??'').trim();
function ecIndex(rows){
  const sp=rowsSplit(rows), byId=new Map(), out=new Map(), inn=new Map();
  for(const r of sp.nodes){ const id=ecStr(r.id??r.node??r.name); if(id) byId.set(id,r); }
  const seen=new Set(), add=(m,k,v)=>{ let a=m.get(k); if(!a) m.set(k,a=[]); a.push(v); };
  for(const e of sp.edges){
    const a=ecStr(e.from??e.source??e.src), b=ecStr(e.to??e.target??e.dst), l=ecStr(e.label);
    if(!a || !b) continue;
    const k=a+'\u0001'+b+'\u0001'+l; if(seen.has(k)) continue; seen.add(k);
    const w=+e.count||+e.weight||0;
    add(out,a,{id:b,label:l,w}); add(inn,b,{id:a,label:l,w});
  }
  return {byId,out,inn};
}
const ecName=(ix,id)=>{ const r=ix.byId.get(id); return r && ecStr(r.label) || id; };
const ecTime=v=>{ const x=+v; return x>1e11 ? new Date(x).toLocaleString() : ecStr(v); };
function ecSelect(n,id){
  id=ecStr(id); if(!id || id===n.sel) return;
  if(n.sel) n.hist.push(n.sel);
  if(n.hist.length>50) n.hist.shift();
  n.sel=id; n.q=''; if(n.ui) n.ui.q.value=''; n.rev++;
}
function ecLinks(n,title,list,cls){
  const wrap=document.createElement('div'); wrap.className='ec-sec';
  const by=new Map();
  for(const e of list){ const k=e.label||'—'; let a=by.get(k); if(!a) by.set(k,a=[]); a.push(e); }
  for(const [label,arr] of by){
    const h=document.createElement('div'); h.className='ec-h'; h.textContent=title+' '+label+' · '+arr.length; wrap.append(h);
    const box=document.createElement('div'); box.className='ec-chips';
    for(const e of arr.slice(0,40)){
      const c=document.createElement('span'); c.className='ec-chip '+cls; c.dataset.id=e.id;
      const r=n.ix.byId.get(e.id), ty=r && ecStr(r.type);
      c.textContent=ecName(n.ix,e.id)+(e.w>1 ? ' ×'+e.w : '');
      c.title=e.id+(ty ? ' · '+ty : '');
      box.append(c);
    }
    if(arr.length>40){ const m=document.createElement('span'); m.className='ec-more'; m.textContent='+'+(arr.length-40); box.append(m); }
    wrap.append(box);
  }
  return wrap;
}
function ecRender(n){
  const ui=n.ui, body=ui.body, ix=n.ix; body.innerHTML='';
  const q=n.q.trim().toLowerCase();
  if(q){
    let k=0;
    for(const [id,r] of ix.byId){
      if(!(id.toLowerCase().includes(q) || ecStr(r.label).toLowerCase().includes(q))) continue;
      const c=document.createElement('div'); c.className='ec-pick'; c.dataset.id=id;
      c.textContent=(ecStr(r.label)||id)+(r.type ? ' · '+r.type : '')+' · '+id; body.append(c);
      if(++k>=30) break;
    }
    if(!k) body.textContent='nothing found';
    return;
  }
  if(!n.sel){ body.textContent=ix.byId.size ? 'select a node: Graph sel → sel, or search above' : 'wire a Table rows → rows'; return; }
  const row=ix.byId.get(n.sel);
  const head=document.createElement('div'); head.className='ec-title';
  head.textContent=(row && ecStr(row.label)) || n.sel;
  if(row?.type){ const t=document.createElement('span'); t.className='ec-type'; t.textContent=row.type; head.append(t); }
  body.append(head);
  const idl=document.createElement('div'); idl.className='ec-id'; idl.textContent=n.sel; body.append(idl);
  if(!row){ const m=document.createElement('div'); m.className='ec-dim'; m.textContent='no row for this id: it appears only in links'; body.append(m); }
  else {
    if(row.count || row.first){
      const s=document.createElement('div'); s.className='ec-dim';
      s.textContent=(row.count ? '×'+row.count : '')+(row.first ? ' · '+ecTime(row.first)+(row.last && row.last!==row.first ? ' → '+ecTime(row.last) : '') : '');
      body.append(s);
    }
    const dl=document.createElement('div'); dl.className='ec-attrs';
    for(const k of Object.keys(row)){
      if(EC_HIDE.has(k.toLowerCase()) && k!=='alias') continue;
      const v=row[k]; if(v===''||v==null) continue;
      const a=document.createElement('span'); a.className='ec-k'; a.textContent=k;
      const b=document.createElement('span'); b.className='ec-v'; b.textContent=recFmt(v);
      dl.append(a,b);
    }
    if(dl.children.length) body.append(dl);
  }
  const o=ix.out.get(n.sel)||[], i=ix.inn.get(n.sel)||[];
  if(o.length) body.append(ecLinks(n,'→',o,'o'));
  if(i.length) body.append(ecLinks(n,'←',i,'i'));
  if(!o.length && !i.length){ const m=document.createElement('div'); m.className='ec-dim'; m.textContent='no links'; body.append(m); }
}
function ecMount(n){
  const root=document.createElement('div'); root.className='entcard';
  root.innerHTML='<div class="ec-bar"><button class="ec-back" title="back">←</button><input class="ec-q" placeholder="find: id or name"></div><div class="ec-body"></div>';
  ['pointerdown','wheel','keydown'].forEach(ev=>root.addEventListener(ev,e=>e.stopPropagation()));
  n.ui={root, body:root.querySelector('.ec-body'), q:root.querySelector('.ec-q')};
  n.ui.q.addEventListener('input',()=>{ n.q=n.ui.q.value; n.rev++; });
  root.querySelector('.ec-back').addEventListener('click',()=>{ const id=n.hist.pop(); if(id){ n.sel=id; n.rev++; } });
  root.addEventListener('click',e=>{ const t=e.target.closest('[data-id]'); if(t) ecSelect(n,t.dataset.id); });
  n.mid.append(root); if(n.size.h>0) root.style.height=n.size.h+'px';
  n.drawn=-1;
}
def({ id:'entcard', title:'Entity Card', cat:'Output', kw:'entity card details links graph table select node', resize:true, w:320, h:360, readout:true,
  ins:[{n:'rows',t:'bands'},{n:'sel',t:'txt'}],
  outs:[{n:'sel',t:'txt'},{n:'rec',t:'rec'},{n:'links',t:'num'}],
  params:[],
  init:n=>{ n.ix={byId:new Map(),out:new Map(),inn:new Map()}; n.sel=''; n.q=''; n.hist=[]; n.rev=0; n.rowsRef=null; n.lastSel=undefined; n.ui=null; n.drawn=-1; n.t=0; },
  process(n,I){
    if(typeof I.sel==='string' && I.sel!==n.lastSel){ n.lastSel=I.sel; if(I.sel) ecSelect(n,I.sel); }
    const rows=Array.isArray(I.rows) ? I.rows : null;
    if(rows!==n.rowsRef){ n.rowsRef=rows; n.ix=rows ? ecIndex(rows) : {byId:new Map(),out:new Map(),inn:new Map()}; n.rev++; }
    const row=n.sel ? n.ix.byId.get(n.sel) : null;
    return {sel:n.sel||null, rec:row ? [row] : null, links:n.sel ? (n.ix.out.get(n.sel)?.length||0)+(n.ix.inn.get(n.sel)?.length||0) : 0};
  },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected) ecMount(n);
    if(n.drawn!==n.rev){ n.drawn=n.rev; ecRender(n); }
    const r=n.el.querySelector('.readout'); if(r){ const t=n.sel||'—'; if(r.textContent!==t) r.textContent=t; } }
});
