const Graph = { nodes:[], edges:[], map:{}, order:[], seq:1, sel:null,
  dashPages:[{name:'',tree:null}], dashPage:0,       // страницы дашборда: у каждой своё дерево тайлов
  get dashTree(){ return this.dashPages[this.dashPage].tree; },
  set dashTree(v){ this.dashPages[this.dashPage].tree=v; } };
const content = document.getElementById('content');
const wires = document.getElementById('wires');
const view = {x:60,y:40,k:1};
// ---- батчинг пересчёта топологии и перерисовки проводов ----
// Синхронные операции (addNode/addEdge/...) только ставят флаги,
// а в конце микрозадачи выполняется один retopo() + один drawWires().
// Это даёт ~30× ускорение на массовых операциях (пресеты, paste, deserialize).
let topoDirty = false, wiresDirty = false, flushScheduled = false;
function markTopoDirty(){
  topoDirty = true;
  scheduleFlush();
}
function markWiresDirty(){
  wiresDirty = true;
  scheduleFlush();
}
function scheduleFlush(){
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}
function flush(){
  flushScheduled = false;
  if (topoDirty)  { retopo();    topoDirty  = false; }
  if (wiresDirty) { drawWires(); wiresDirty = false; }
}
// Слой для наведённого провода: те же координаты, что у #wires, но стоит в DOM после #content —
// поэтому рисуется поверх узлов. На проводе — клон path, сам провод остаётся кликабельным в #wires.
const wiresFront=document.createElementNS('http://www.w3.org/2000/svg','svg');
wiresFront.id='wiresFront';
content.insertAdjacentElement('afterend',wiresFront);
function fillParamDefaults(n,d){                     // дефолты для параметров, которых ещё нет в n.p —
for(const s of (d.params||[])){                     // при первом создании у зла и при смене состава параметров
if(s.t==='button'||s.t==='file') continue;
if(s.t==='knob' &&s.get) continue;
if(s.t==='range2'){
if(!(s.keys[0] in n.p)) n.p[s.keys[0]]=s.d[0];
if(!(s.keys[1] in n.p)) n.p[s.keys[1]]=s.d[1];
} else if(!(s.n in n.p)) n.p[s.n]=s.d; }
}
function makeNode(type,params,id,x,y){               // узел без DOM — для внутренностей групп
const d=MOD[type]; if(!d) return null;
// старые сохранения могли содержать мусор в x/y (узел fft затирал n.x буфером)
x=x??0; y=y??0;
if(!Number.isFinite(x) || !Number.isFinite(y)){ console.warn('узел '+type+': битые координаты, ставлю в (40,40)'); x=40; y=40; }
const n={id:id||('n'+(Graph.seq++)), type, x,  y, p:{}, out:{}, b:{}, lod:0,
size:{w:d.w||((d.view||d.tall)?320:210), h:d.h||(d.tall? 96 : (d.view? d.view.h : 0))}};
fillParamDefaults(n,d);
if(params) Object.assign(n.p,params);
const myId=n.id;
d.init?.(n);
for(const k of ['id','type','p','size','el','ports']){          // служебные поля модулю нельзя
if(k==='id' &&n.id!==myId){ console.error('узел '+type+' затёр n.id в init'); n.id=myId; } }
if('out' in n  && n.out!==undefined  && typeof n.out!=='object')
console.error('узел '+type+' использует n.out — это поле движка');
n.out={};
return n;
}
function addNode(type,x,y,params,id){
const n=makeNode(type,params,id,x,y);
if(!n){ console.error('addNode: неизвестный тип узла "'+type+'"'); return null; }
Graph.nodes.push(n); Graph.map[n.id]=n;
buildNodeEl(n); markTopoDirty(); return n;
}
function delNode(n){
const d=MOD[n.type];
try{ d?.dispose?.(n); }catch(e){ console.error('dispose '+n.type+':',e); }
n.roCv?.disconnect();                               // иначе ResizeObserver держит канву живой
visIO.unobserve(n.el);
Graph.edges.filter(e=>e.from===n.id||e.to===n.id).forEach(delEdge);
Graph.nodes=Graph.nodes.filter(x=>x!==n); delete Graph.map[n.id];
if(dashForget(n.id) && dashMode) dashRenderRoot();
ghostDrop(n);
n.el.remove();
markTopoDirty();
}
function addEdge(from,fp,to,tp){
if(from===to) return;
if(!Graph.map[from] || !Graph.map[to]) return;    // узел не создался (неизвестный тип и т.п.) — тихо пропускаем связь
const ft=portsOf(Graph.map[from],'outs').find(o=>o.n===fp)?.t;
const tt=portsOf(Graph.map[to],'ins').find(o=>o.n===tp)?.t;
if(ft!==tt && ft!=='val' && tt!=='val') return;   // val — универсальный пин, совместим с любым типом
Graph.edges.filter(e=>e.to===to &&e.tp===tp).forEach(delEdge);   // один вход — одна связь
const e={id:'e'+(Graph.seq++),from,fp,to,tp};
const path=document.createElementNS('http://www.w3.org/2000/svg','path');
path.setAttribute('fill','none'); path.setAttribute('stroke',TYPE_COLOR[ft]);
// non-scaling-stroke — иначе на зуме (view.k до 2.5×) толщина провода растёт вместе с
// содержимым канвы, а не остаётся постоянной в экранных пикселях, как остальной UI
path.setAttribute('vector-effect','non-scaling-stroke');
path.setAttribute('stroke-width','1.6'); path.style.cursor='pointer';
path.addEventListener('click',()=>{ delEdge(e); Undo.push(); });
const hit=document.createElementNS('http://www.w3.org/2000/svg','path');
hit.setAttribute('fill','none'); hit.setAttribute('stroke','transparent');
hit.setAttribute('vector-effect','non-scaling-stroke');    // так и хитбокс не "худеет" при отдалении
hit.setAttribute('stroke-width','10'); hit.style.cursor='pointer';
hit.addEventListener('click',()=>{ delEdge(e); Undo.push(); });
hit.addEventListener('pointerenter',()=>{                        // клон поверх узлов, сам провод не трогаем
e.hoverClone=path.cloneNode(); e.hoverClone.setAttribute('stroke-width','2.6');
e.hoverClone.style.pointerEvents='none'; wiresFront.append(e.hoverClone); });
hit.addEventListener('pointerleave',()=>{ e.hoverClone?.remove(); e.hoverClone=null; });
wires.append(hit,path); e.path=path; e.hit=hit;
Graph.edges.push(e); markTopoDirty(); markWiresDirty();
syncLinkedParams(Graph.map[to]); syncLinkedParams(Graph.map[from]);
if(!Undo.busy  && !pasting) Undo.push();
}
/* Соединение из UI: iq ↔ sig соединяется через автоадаптер (IQ → Audio / I/Q → IQ) — отдельные I/Q-модули не нужны.
   Пин Q (или q) идёт на второй канал адаптера, остальные — на первый; адаптер от того же источника переиспользуется. */
const IQ_ADAPT={ iqSig:{type:'iqAudio', inp:'in', main:'out', second:'q'},
                 sigIq:{type:'iqMerge', inp:'I', second:'Q', out:'iq'} };
function portT(n,dir,name){ return portsOf(n,dir).find(o=>o.n===name)?.t; }
function isQPin(name){ return name==='Q' || name==='q'; }
function connect(from,fp,to,tp){
const a=Graph.map[from], b=Graph.map[to]; if(!a||!b||from===to) return;
const ft=portT(a,'outs',fp), tt=portT(b,'ins',tp);
const kind=ft==='iq' && tt==='sig' ? IQ_ADAPT.iqSig : ft==='sig' && tt==='iq' ? IQ_ADAPT.sigIq : null;
if(!kind) return addEdge(from,fp,to,tp);
const was=Undo.busy; Undo.busy=true;
try{
let ad;
if(kind.type==='iqAudio') ad=Graph.edges.filter(e=>e.from===from && e.fp===fp).map(e=>Graph.map[e.to]).find(n=>n.type==='iqAudio' && n.id!==to);
else ad=Graph.edges.filter(e=>e.to===to && e.tp===tp).map(e=>Graph.map[e.from]).find(n=>n?.type==='iqMerge');
if(!ad){
const x=((a.x+(a.el?.offsetWidth||a.size.w))+b.x)/2-17, y=(a.y+b.y)/2;
ad=addNodeUI(kind.type,x,y);
if(!ad) return;
}
if(kind.type==='iqAudio'){
addEdge(from,fp,ad.id,kind.inp);
addEdge(ad.id,isQPin(tp)?kind.second:kind.main,to,tp);
} else {
addEdge(from,fp,ad.id,isQPin(fp)?kind.second:kind.inp);
addEdge(ad.id,kind.out,to,tp);
}
} finally { Undo.busy=was; }
Undo.push();
}
function delEdge(e){ e.path?.remove(); e.hit?.remove(); e.hoverClone?.remove();
Graph.edges=Graph.edges.filter(x=>x!==e); markTopoDirty(); markWiresDirty();
syncLinkedParams(Graph.map[e.to]); syncLinkedParams(Graph.map[e.from]); }
function syncLinkedParams(n){                        // гасим поле параметра, если его перебивает провод (linked),
const d=n &&MOD[n.type]; if(!d) return;             // и раскрываем схлопнутый пин контрола в ci/co, если он подключён (см. .port.ctrl)
const insNames=new Set(portsOf(n,'ins').map(p=>p.n));
const outsNames=new Set(portsOf(n,'outs').map(p=>p.n));
const mark=(rowEl,key)=>{
if(insNames.has(key)){
const wired=Graph.edges.some(e=>e.to===n.id  && e.tp===key);
rowEl?.classList.toggle('linked', wired);
n.ports?.i?.[key]?.classList.toggle('wired', wired);
n.ghostPorts?.i?.[key]?.classList.toggle('wired', wired);
}
if(outsNames.has(key)){
const wired=Graph.edges.some(e=>e.from===n.id  && e.fp===key);
rowEl?.classList.toggle('linkedOut', wired);
n.ports?.o?.[key]?.classList.toggle('wired', wired);
n.ghostPorts?.o?.[key]?.classList.toggle('wired', wired);
}
};
for(const s of (d.params||[])){
if(s.t==='range2'){
for(const key of s.keys) mark(n.el?.querySelector( `.slidernum[data-param="${key}"]` ),key);
continue;
}
mark(n.el?.querySelector( `.prm[data-param="${s.n}"]` ),s.n);
}
for(const dir of ['ins','outs']) for(const p of portsOf(n,dir)) if(p.hide) mark(null,p.n);    // скрытые пины (старые I/Q) — видны, пока подключены
}
function retopo(){
Graph.order=topoOrder(Graph.nodes,Graph.edges,Graph.map);
const idx=new Map();                                // "узел+порт → провод" — см. комментарий в evalNode
for(const e of Graph.edges) idx.set(e.to+'\u0001'+e.tp, e);
Graph.inIndex=idx;
Islands.rebuild();                                  // состав островов зависит от проводов
}
/* ---- DOM узла ---- */
function catColor(cat){                             // единый цвет категории — для узлов и палитры
return cat==='Sources'?'var(--t-num)':cat==='Processing'?'var(--t-sig)'
: cat==='Analysis'?'var(--t-spec)':cat==='Misc'?'var(--dim)'
: cat==='Indicators'?'var(--t-rec)':cat==='Data'?'var(--t-txt)':cat==='Geo'?'var(--t-bands)':'var(--t-img)';
}
function posNode(n){                                // position через transform, не left/top —
n.el.style.transform=`translate3d(${n.x}px,${n.y}px,0)`;   // так двигаем узел без layout-reflow всей страницы
if(n.ghost) n.ghost.style.transform=n.el.style.transform;
}
// Canvas исторически создавался в CSS-пикселях без поправки на плотность экрана —
// на hiDPI (2x/3x) браузер растягивает низкорезкий битмап под физические пиксели,
// отсюда общая нерезкость и цветная кайма на стыке перерисованных областей.
// Перехватываем .width/.height на уровне DOM-узла (тот же приём, что и для readout):
// модуль как ставил/читал логический размер — так и продолжает, а реальный буфер
// под капотом в devicePixelRatio раз крупнее, и матрица контекста это компенсирует.
// Настоящий размер буфера (нужен для putImageData/getImageData — водопады sa/persist)
// доступен через cv.pxW/cv.pxH.
const HiDPICanvases=new Map();                      // канва -> restretch
const HiDPI_CAP=matchMedia('(pointer:coarse)').matches?2.5e6:8e6;   // пикселей буфера на канву
function hiDPICanvas(cv,cx,n){
const nativeW=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');
const nativeH=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'height');
let logW=cv.width, logH=cv.height;
// плотность буфера = devicePixelRatio × масштаб холста (panzoom, по фактической ширине на экране),
// иначе на зуме браузер растягивает битмап и всё мылится. Потолок — по числу пикселей.
const restretch=(force,rw0)=>{ const dpr=window.devicePixelRatio||1;
const rw=rw0!=null ? rw0 : cv.isConnected?cv.getBoundingClientRect().width:0;
let s=Math.max(.5, dpr*(rw>0&&logW>0 ? rw/logW : 1));
// на мобилках общий лимит памяти канв мал (iOS молча очищает канвы сверх него) — потолок ниже
const cap=HiDPI_CAP;
if(logW*logH*s*s>cap) s=Math.sqrt(cap/(logW*logH));
const pw=Math.max(1,Math.round(logW*s)), ph=Math.max(1,Math.round(logH*s));
if(!force && pw===cv.pxW && ph===cv.pxH) return;     // смена размера буфера стирает канву — только по делу
nativeW.set.call(cv, cv.pxW=pw);
nativeH.set.call(cv, cv.pxH=ph);
cv.pxGen=(cv.pxGen|0)+1;                             // буфер стёрт — кэширующим draw() надо перерисовать
cx.setTransform(pw/logW,0,0,ph/logH,0,0); };
HiDPICanvases.set(cv,restretch);
// Chrome на Android сбрасывает 2D-контекст в фоне; после восстановления матрица сброшена
cv.addEventListener('contextrestored',()=>restretch(true));
Object.defineProperty(cv,'width',{configurable:true, get:()=>logW,
set:v=>{ logW=v; restretch(true); }});
Object.defineProperty(cv,'height',{configurable:true, get:()=>logH,
set:v=>{ logH=v; restretch(true); }});
// В панельном режиме canvas.view растянут через CSS (width:100%), а ширина .node
// плавает вслед за окном — attribute-размер (и DPR-буфер) этого не видит, отсюда
// размытие при ресайзе. ResizeObserver держит logW/logH в реальном CSS-размере.
const ro=new ResizeObserver(entries=>{
const box=entries[0].contentBoxSize?.[0];
const w=Math.round(box?box.inlineSize:cv.clientWidth);
const h=Math.round(box?box.blockSize:cv.clientHeight);
if(w>0 && h>0 && (w!==logW||h!==logH)){ logW=w; logH=h; restretch(); }
});
ro.observe(cv);
if(n) n.roCv=ro;
// devicePixelRatio (зум страницы, окно на другом мониторе) меняется без изменения
// CSS-размера — ResizeObserver это не ловит, досматриваем через matchMedia отдельно.
const watchDpr=()=>{ restretch();
matchMedia(`(resolution:${window.devicePixelRatio}dppx)`).addEventListener('change',watchDpr,{once:true}); };
matchMedia(`(resolution:${window.devicePixelRatio}dppx)`).addEventListener('change',watchDpr,{once:true});
}
function buildNodeEl(n){
const d=MOD[n.type];
const el=document.createElement('div'); el.className='node panzoom-exclude'+(n.type==='note'?' note':''); el.dataset.type=n.type; el.dataset.id=n.id;
el.style.setProperty('--cat',catColor(d.cat)); el.dataset.title=d.title;
el.innerHTML=`<div class="nhead" title="Double-tap to fold" style="--cat:${catColor(d.cat)}"><span class="ttl" data-ini="${nodeInitials(d.title)}" title="${d.cat||''}">${d.title}</span><span class="x">✕</span></div> <div class="nbody"></div>`;
const body=el.querySelector('.nbody');
const io=document.createElement('div'); io.className='io3';
const ci=document.createElement('div'); ci.className='col';
const mid=document.createElement('div'); mid.className='mid';
const co=document.createElement('div'); co.className='col o';
n.ports={i:{},o:{}}; n.set={};
const wire=(e,p,dir)=>{ e.dataset.node=n.id; e.dataset.port=p.n; e.dataset.dir=dir;
e.addEventListener('pointerdown',ev=>startLink(ev,n,p.n,dir)); };
// Порт с именем как у параметра — тот же пин в колонке ci/co, что и у обычных портов (слева —
// вход, справа — выход: провода всегда в привычном месте), но пока не подключён — схлопнут
// (см. styles.css .port.ctrl) и не ест место. Строка параметра остаётся простым полем без джека.
// Базовые (всегда видимые) порты — всегда сверху колонки, контрольные — под ними: иначе
// появление/исчезновение пина параметра сдвигало бы соседние базовые порты туда-сюда.
const paramNames=mergeableParamNames(d);
// .sort() стабилен (ES2019+) — внутри каждой группы относительный порядок из module.ins/outs сохраняется
const lowPri=p=>paramNames.has(p.n) || !!p.hide;               // hide:true — пин скрыт, пока не подключён (старые I/Q при едином iq)
const baseFirst=ps=>[...ps].sort((a,b)=>lowPri(a)-lowPri(b));
for(const p of baseFirst(portsOf(n,'ins'))){
const e=portEl(p,'i'); ci.append(e); n.ports.i[p.n]=e; wire(e,p,'i');
if(lowPri(p)) e.classList.add('ctrl'); }
for(const p of baseFirst(portsOf(n,'outs'))){
const e=portEl(p,'o'); co.append(e); n.ports.o[p.n]=e; wire(e,p,'o');
if(lowPri(p)) e.classList.add('ctrl'); }
io.append(ci,mid,co); body.append(io); n.mid=mid;
{ const params=d.params||[];
// params с hidden:true вообще не рисуются рядом — значение/дефолт/провод (mergeableParamNames
// её всё равно видит) остаются рабочими, просто узел сам управляет им иначе (см. 'split' у sa —
// это теперь перетаскивание границы спектр/водопад прямо на графике, отдельный слайдер лишний).
// adv:true — редко трогаемые настройки (палитра водопада, tol, capture/clear...) — у "богатых"
// узлов (sa — 16 контролов, drumseq — 21) иначе съедают экран ещё до собственно холста/readout.
// Прячем их за один сворачиваемый хедер, а не превращаем в отдельный узел — логика/значения не
// меняются, только то, что показано сразу.
const shown=params.filter(p=>!p.hidden);
const main=shown.filter(p=>!p.adv), adv=shown.filter(p=>p.adv);
renderParamRows(mid,n,main);
if(adv.length){
const tgl=document.createElement('div'); tgl.className='prm wide advToggle';
tgl.innerHTML=`<span class="advLbl">${n.advOpen?'▾':'▸'} advanced (${adv.length})</span>`;
const wrap=document.createElement('div'); wrap.className='advWrap'; wrap.hidden=!n.advOpen;
wrap.dataset.count=adv.length;
renderParamRows(wrap,n,adv);
tgl.addEventListener('click',()=>setAdvOpen(n,!n.advOpen));
mid.append(tgl,wrap);
} }
if(d.view){ const  c=document.createElement('canvas'); c.className='view main'+(d.pick?' pick':'');
// без willReadFrequently — этот канвас только пишут (drawImage/putImageData), ни один draw()
// не читает его обратно через getImageData (это отдельный n.capCx у видео-узлов, см. sources.js).
// Флаг форсирует программный (CPU) рендер канвы вместо GPU-композитинга — на крупных канвах
// (водопад/спектр) это заметно медленнее и не даёт main thread'у обслуживать USB/демод rtlsdr.
mid.append(c); n.cv=c; n.cx=c.getContext('2d');
hiDPICanvas(c,n.cx,n);
if(d.pick){
let tap=null;
c.addEventListener('pointerdown',ev=>{ ev.stopPropagation();
tap={x:ev.clientX,y:ev.clientY}; });
c.addEventListener('pointerup',ev=>{
if(!tap) return;
const moved=Math.hypot(ev.clientX-tap.x,ev.clientY-tap.y); tap=null;
if(moved >6) return;                          // это было перетаскивание, а не выбор
const r=c.getBoundingClientRect();
n.pickT=clamp((ev.clientX-r.left)/r.width,0,1); });
c.addEventListener('pointercancel',()=>{ tap=null; }); } }
if(d.view||d.resize||d.tall){ const rz=document.createElement('div'); rz.className='rz'; el.append(rz);
bindResize(rz,n); }
if(d.readout){ const r=document.createElement('div'); r.className='readout'+(d.tall?' tall':'');
r.textContent='—'; mid.append(r); n.ro=r;
// Модули пишут в readout каждый кадр (до 60 fps), даже если текст не изменился.
// Перехватываем textContent на уровне DOM-узла — фикс сразу работает для всех
// модулей, без правки каждого draw() по отдельности.
const nativeTC=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
let roVal=r.textContent;
Object.defineProperty(r,'textContent',{configurable:true,
get:()=>roVal,
set:v=>{ if(v===roVal) return; roVal=v; nativeTC.set.call(r,v); }});
r.addEventListener('pointerdown',ev=>ev.stopPropagation());   // не таскать узел за текст
r.addEventListener('click',()=>{
navigator.clipboard?.writeText(r.textContent);
r.classList.add('copied'); setTimeout(()=>r.classList.remove('copied'),400); });
if(d.tall){
const cp=document.createElement('button'); cp.className='copy'; cp.textContent='Copy';
cp.addEventListener('click',()=>{ navigator.clipboard?.writeText(r.textContent);
cp.textContent='copied'; setTimeout(()=>cp.textContent='Copy',900); });
mid.append(cp); } }
if(d.swatch){ const s=document.createElement('div'); s.className='swatch'; mid.append(s); }
el.querySelector('.x').addEventListener('click',e=>{e.stopPropagation();
delNode(n); Sel.delete(n.id); Undo.push();});
// двойной тап/клик по заголовку — свернуть/развернуть (свой счётчик: dblclick на тач-экранах ненадёжен)
{ const head=el.querySelector('.nhead'); let t0=0,x0=0,y0=0;
head.addEventListener('pointerdown',e=>{ x0=e.clientX; y0=e.clientY; });
head.addEventListener('pointerup',e=>{
if(e.target.closest('.x') || Math.hypot(e.clientX-x0,e.clientY-y0)>5){ t0=0; return; }
if(e.timeStamp-t0<350){ t0=0; setLod(n,n.lod ? 0 : collapsedLod(n)); Undo.push(); } else t0=e.timeStamp; }); }
if(n.lod) setLod(n,n.lod);
bindDrag(el.querySelector('.nhead'),n);
el.addEventListener('pointerdown',ev=>{
if(!Sel.has(n.id)||ev.shiftKey) selSet(n.id,ev.shiftKey); });
// ввод по узлу (наведение, клик, колесо, правка поля) — lazy-узлу перерисоваться
for(const ev of ['pointerdown','pointermove','pointerup','pointerleave','wheel','click','dblclick','input','change','keydown'])
el.addEventListener(ev,()=>{ n._dirty=true; },{capture:true,passive:true});
el._node=n; n._vis=undefined; visIO.observe(el);
n.el=el; content.append(el); el.style.zIndex=++zCounter; posNode(n); applySize(n); // новый узел сразу поверх остальных
}
function mergeableParamNames(d){                     // имена параметров, что могут слиться со строкой порта —
return new Set((d.params||[]).flatMap(s=>            // кроме button/file: у них своя разметка без места под джек (см. paramEl)
s.t==='range2' ? s.keys : (s.t==='button'||s.t==='file') ? [] : [s.n]));
}
function midWidth(n){
const d=MOD[n.type];
const paramNames=mergeableParamNames(d);
const insShown=portsOf(n,'ins').some(p=>!paramNames.has(p.n));
const outsShown=portsOf(n,'outs').some(p=>!paramNames.has(p.n));
const lw=insShown?58:0, rw=outsShown?58:0;
return Math.max(90, n.size.w-2-lw-rw-18);
}
/* Уровни детализации узла: 0 — полный, 1 — карточка (только заголовок), 2 — точка (кружок с инициалами).
   Модуль с lod:'dot' сворачивается в точку, остальные — в карточку; двойной тап по заголовку переключает. */
const LOD_FULL=0, LOD_CARD=1, LOD_DOT=2;
function nodeInitials(title){
const w=String(title).split(/[^A-Za-z0-9А-Яа-я]+/).filter(Boolean);
return (w.length>1 ? w[0][0]+w[1][0] : (w[0]||'?').slice(0,2)).toUpperCase();
}
function collapsedLod(n){ return MOD[n.type].lod==='dot' ? LOD_DOT : LOD_CARD; }
function setLod(n,v){
n.lod=v|0;
n.el.classList.toggle('folded',n.lod===LOD_CARD);
n.el.classList.toggle('lod-dot',n.lod===LOD_DOT);
markWiresDirty();
}
function foldNode(n,v){ setLod(n,v ? LOD_CARD : LOD_FULL); }
function addNodeUI(type,x,y){                         // узел, добавленный пользователем: служебные модули — сразу точкой
const n=addNode(type,x,y);
if(n && MOD[type].lod==='dot') setLod(n,LOD_DOT);
return n;
}
// подряд идущие кнопки/галочки — в один ряд; общая раскладка для основных и adv-параметров
function renderParamRows(container,n,params){
// строки «подпись — значение» (по умолчанию; rows:false у модуля — прежняя раскладка): числа, выборы,
// галочки, поля ввода — строками в сетке до 4 колонок; подряд идущие кнопки — одним рядом;
// остальное (code, file, бесконечная крутилка) — как раньше
if(MOD[n.type].rows!==false){
let grp=null;
for(let i=0;i<params.length;i++){
const p=params[i];
if(p.t==='button'){
grp=null; const row=document.createElement('div'); row.className='prm wide btnrow pr-btns';
for(;i<params.length && params[i].t==='button';i++) row.append(paramBtn(n,params[i]));
i--; container.append(row); continue; }
if(!['range','range2','check','select','buttons','num','text'].includes(p.t)){ grp=null; renderParamRowsPlain(container,n,[p]); continue; }
if(!grp){ grp=document.createElement('div'); grp.className='prm wide prmrows'; container.append(grp); }
// сегменты — выпадающим списком, ручки — полоской-строкой
const q= p.t==='range' ? {...p,knob:false} : p.t==='buttons' ? {...p,t:'select'} : p;
const r=paramEl(n,q); r.classList.add('pr','pr-'+q.t);
const lab=r.querySelector(':scope>label');
// единица из хвоста подписи («bandwidth, Hz») — тусклым текстом после значения, подпись короче
const um=lab && ['range','range2','num'].includes(q.t) && /^(.+?),\s*([^\s,]{1,8})$/.exec(lab.textContent);
if(um){ lab.textContent=um[1]; const u=document.createElement('span'); u.className='pr-unit'; u.textContent=um[2];
(q.t==='range' ? r.querySelector('.slidernum') : r).append(u); }
if(q.t==='range'){ const box=r.querySelector('.slidernum'); if(box && lab) box.prepend(lab); }   // подпись внутри полоски: тащится вся строка
const sel=r.querySelector(':scope>select');
// подпись + значение (+ единица) длиннее ~23 символов — 2 ячейки, пока ячейки узкие
const valLen= sel ? (Array.isArray(q.opts) ? Math.max(...q.opts.map(o=>String(o).length)) : 10)+5   // + стрелка
: q.t==='range2' ? 20 : q.t==='check' ? 5 : 7;
if(lab && lab.textContent.length+valLen+(um?um[2].length+1:0)>23) r.classList.add('pr-long');
// выбор из двух — переключение кликом, без списка
if(sel && Array.isArray(q.opts) && q.opts.length===2){ r.classList.add('pr-two');
sel.addEventListener('mousedown',e=>{ e.preventDefault(); sel.selectedIndex=1-sel.selectedIndex; sel.dispatchEvent(new Event('change')); }); }
if(sel) sel.addEventListener('wheel',e=>{ e.preventDefault(); e.stopPropagation();   // колесо — соседнее значение
const now=performance.now(); if(sel._lastWheelT!=null && now-sel._lastWheelT<120) return; sel._lastWheelT=now;
const k=clamp(sel.selectedIndex+(e.deltaY>0?1:-1),0,sel.options.length-1);
if(k!==sel.selectedIndex){ sel.selectedIndex=k; sel.dispatchEvent(new Event('change')); } },{passive:false});
grp.append(r); }
return; }
renderParamRowsPlain(container,n,params);
}
function renderParamRowsPlain(container,n,params){
let i=0;
while(i<params.length){
if(params[i].t==='button' && params[i+1] && params[i+1].t==='button'){
const grp=document.createElement('div'); grp.className='prm wide btnrow';
while(i<params.length && params[i].t==='button'){ grp.append(paramBtn(n,params[i])); i++; }
container.append(grp);
} else if(params[i].t==='range' && params[i].knob){ // подряд идущие ручки — в один ряд
const grp=document.createElement('div'); grp.className='prm wide knobrow';
while(i<params.length && params[i].t==='range' && params[i].knob){ grp.append(paramEl(n,params[i])); i++; }
container.append(grp);
} else if(params[i].t==='check'){
const grp=document.createElement('div'); grp.className='prm  wide checkrow';
while(i<params.length && params[i].t==='check'){ grp.append(paramEl(n,params[i])); i++; }
container.append(grp);
} else { container.append(paramEl(n,params[i])); i++; }
} }
function setAdvOpen(n,v){
n.advOpen=!!v;
const wrap=n.el?.querySelector('.advWrap'); if(!wrap) return;
wrap.hidden=!n.advOpen;
const lbl=n.el.querySelector('.advToggle .advLbl');
if(lbl) lbl.textContent=(n.advOpen?'▾':'▸')+' advanced ('+wrap.dataset.count+')';
}
function applySize(n){
const d=MOD[n.type];
n.el.style.width=n.size.w+'px';
if(n.cv  && !d.tall){ n.cv.width=midWidth(n); n.cv.height=n.size.h;
n.cv.style.height=n.size.h+'px'; n.resized=true; }
else if(n.cv){ n.cv.width=midWidth(n); n.cv.height=d.view.h;
n.cv.style.height=d.view.h+'px'; n.resized=true; }
if(n.ro  && d.tall) n.ro.style.height=n.size.h+'px';
if(n.gv && n.size.h >0) n.gv.style.height=n.size.h+'px';
else if(n.ta  && n.size.h >0 && !d.gv) n.ta.style.height=n.size.h+'px';
}
function rebuildNode(n){                            // пересобрать DOM, сохранив состояние модуля
const sel=n.el.classList.contains('sel');
fillParamDefaults(n,MOD[n.type]);                  // добить дефолтами новые/переименованные параметры
n.roCv?.disconnect();                               // старая канва уходит вместе с el, наблюдатель — тоже
visIO.unobserve(n.el);
n.el.remove(); buildNodeEl(n);
n._drawGen=-1;                                      // новый DOM — lazy-узлу нарисоваться заново
if(sel) n.el.classList.add('sel');
markWiresDirty();
}
function portEl(p,dir){
const e=document.createElement('div'); e.className='port'; e.dataset.dir=dir;
e.innerHTML= `<span class="pin" style="background:${TYPE_COLOR[p.t]}">${p.n}</span>` ;
return e;
}
function paramBtn(n,s){
const b=document.createElement('button'); b.textContent=s.label||s.n;
b.addEventListener('click',()=>s.fn(n)); return b;
}
const JS_TOK=/(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|\b(\d[\w.]*)\b|\b(const|let|var|function|return|if|else|for|while|do|break|continue|new|this|typeof|of|in|true|false|null|undefined|switch|case|default|throw|try|catch|class)\b/g;
function hlJs(src){                                 // минимальная подсветка JS для слоя под textarea
const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;');
let out='', i=0, m; JS_TOK.lastIndex=0;
while((m=JS_TOK.exec(src))){
out+=esc(src.slice(i,m.index));
const c=m[1]!=null?'c':m[2]!=null?'s':m[3]!=null?'n':'k';
out+=`<span class="hl-${c}">${esc(m[0])}</span>`; i=m.index+m[0].length;
if(m[0]==='') JS_TOK.lastIndex++; }
return out+esc(src.slice(i));
}
function paramEl(n,s){
const row=document.createElement('div'); row.className='prm'; row.dataset.param=s.n; row.dataset.node=n.id;
const lab=document.createElement('label'); lab.textContent=s.label||s.n;
lab.title=s.label||s.n;
if(s.t==='button'){
row.className='prm '+(n.type==='mic' &&['on','onB'].includes(s.n)?'mic-button':'wide');
row.append(paramBtn(n,s)); return row;
}
if(s.t==='file'){ row.className='prm wide';
const f=document.createElement('input'); f.type='file'; f.accept=s.accept||'';
f.addEventListener('change',()=>{ if(f.files[0]) s.fn(n,f.files[0]); }); row.append(f); return row; }
if(s.t!=='range2') bindPendingComplete(row,n,s.n);   // второй тап (клик-клик) — довязать провод прямо на строку контрола
row.append(lab);
if(s.t==='range'){
// Ползунок-число в духе Blender: тащить — меняет значение, клик — точный ввод текстом.
const box=document.createElement('div'); box.className='slidernum'; box.tabIndex=0;
box.title='Drag left/right to change, Shift for fine control, click to type, double-click to reset, wheel to step';
// min/max можно задать числом или функцией n=>число (например, Eng.sr/2 — привязка к частоте
// движка) — резолвим один раз при сборке; при смене sr узлы пересобираются (см. srSel.onchange).
const smin=typeof s.min==='function'?s.min(n):s.min, smax=typeof s.max==='function'?s.max(n):s.max;
const fillEl=document.createElement('div'); fillEl.className='sn-fill';
const valEl=document.createElement('span'); valEl.className='sn-val';
box.append(fillEl,valEl);
// knob:true — та же логика, но вид ручки: дуга 270°, тянуть в любую сторону
let arc=null;
if(s.knob){
row.classList.add('kn'); box.classList.add('kn');
box.title='Drag up/right to increase, Shift for fine control, click to type, double-click to reset, wheel to step';
const NS='http://www.w3.org/2000/svg', svg=document.createElementNS(NS,'svg');
svg.setAttribute('viewBox','0 0 40 40'); svg.classList.add('kn-svg');
const mk=cls=>{ const e=document.createElementNS(NS,'path'); e.setAttribute('class',cls);
e.setAttribute('d','M 9.39 30.61 A 15 15 0 1 1 30.61 30.61'); e.setAttribute('pathLength','100'); return e; };
arc=mk('kn-val'); svg.append(mk('kn-track'),arc); box.prepend(svg); }
const pct=v=> s.log
? clamp(Math.log(v/smin)/Math.log(smax/smin),0,1)*100
: clamp((v-smin)/((smax-smin)||1),0,1)*100;
const disp=v=> (s.step &&s.step >=1)
? (Math.abs(v) >=1000 ? (Math.round(v/10)/100)+'k' : String(Math.round(v)))
: fmt(v);
const render=v=>{ if(arc) arc.style.strokeDasharray=pct(v)+' 100'; else fillEl.style.width=pct(v)+'%';
valEl.textContent=disp(v); };
const setV=v=>{ v=clamp(v,smin,smax); n.p[s.n]=v; render(v); };
render(n.p[s.n]);
(n.set||(n.set={}))[s.n]=setV;
let dragging=false, sx=0, sy=0, sv=0, moved=false, pid=null;
box.addEventListener('pointerdown',e=>{
if(e.target.closest('input')) return;             // не мешать текстовому вводу
e.stopPropagation(); pid=e.pointerId; box.setPointerCapture(pid);
dragging=true; moved=false; sx=e.clientX; sy=e.clientY; sv=n.p[s.n];
});
box.addEventListener('pointermove',e=>{
if(!dragging) return;
const dx=s.knob ? (e.clientX-sx)-(e.clientY-sy) : e.clientX-sx;
if(Math.abs(dx)>3) moved=true;
if(!moved) return;
const slow=e.shiftKey?8:1, w=s.knob ? 200 : Math.max(60,box.offsetWidth);
let v = s.log ? sv*Math.exp(dx*Math.log(smax/smin)/w/slow)
: sv+dx*(smax-smin)/w/slow;
if(s.step) v=Math.round(v/s.step)*s.step;         // не тащить хвост из десятков знаков
setV(v);
});
const endDrag=e=>{
if(!dragging) return; dragging=false;
if(pid!=null) box.releasePointerCapture(pid);
if(!moved) openEdit();
};
box.addEventListener('pointerup',endDrag);
box.addEventListener('pointercancel',endDrag);
function openEdit(){
if(box.querySelector('input')) return;
const inp=document.createElement('input'); inp.type='number';
const cur=n.p[s.n];
inp.value=s.step? cur : (Math.round(cur*1000)/1000);
inp.step=s.step||'any';
inp.addEventListener('pointerdown',ev=>ev.stopPropagation());
box.append(inp); inp.focus(); inp.select();
// применяем прямо по мере ввода — на мобильном виртуальная клавиатура часто не даёт Enter,
// а тап "мимо", чтобы убрать её, не всегда доходит до blur так, как на десктопе. Без этого
// правка технически вводилась, но эффективно "не применялась", пока как-то не поймать blur.
inp.addEventListener('input',()=>{
const v=parseFloat(String(inp.value).replace(',','.')); if(isFinite(v)) setV(v); });
let finished=false;
const done=ok=>{ if(finished) return; finished=true;
if(ok){ const v=parseFloat(String(inp.value).replace(',','.')); if(isFinite(v)) setV(v); }
inp.remove(); };
inp.addEventListener('keydown',ev=>{ ev.stopPropagation();
if(ev.key==='Enter') done(true); if(ev.key==='Escape') done(false); });
inp.addEventListener('blur',()=>done(true));
}
box.addEventListener('dblclick',()=>{ box.querySelector('input')?.blur(); setV(s.d); });   // сброс к умолчанию
box.addEventListener('wheel',e=>{
e.preventDefault(); e.stopPropagation();
// троттлинг: трекпад на один "свайп" шлёт десятки-сотни wheel-событий подряд (не одно, как
// нотч физического колеса), а шаг для лог-параметра — процент от ТЕКУЩЕГО значения за событие,
// то есть множится на каждое из них. Только троттлинг интервала (без снижения шага) всё ещё
// давал заметный разгон: на всплеске ~100 событий/с сквозь 40мс-троттлинг проходит ~1 из 3,
// и даже так 640мс свайпа (реалистичная длительность одного жеста) давали ×2.2 — как раз то,
// что и словили ("крутится сильно... за одну прокрутку"). Оба параметра снижены вместе — так
// на типичный непрерывный жест (сотни мс — секунда) набегает разумных ~×1.3, а не ×2+, но
// отдельные редкие нотчи настоящего колеса мыши (события заведомо реже троттлинга) всё ещё
// шагают на полный процент за раз, не становясь медленнее.
const now=performance.now();
if(box._lastWheelT!=null && now-box._lastWheelT<80) return;
box._lastWheelT=now;
const v=n.p[s.n], step=s.log
? Math.max(Math.abs(v)*.03,(smax-smin)/1000)
: (s.step||1);
setV(v+(e.deltaY <0?step:-step));
},{passive:false});
row.append(box);
} else if(s.t==='knob'){
row.className='prm wide';
const box=document.createElement('div'); box.className='knob'; box.tabIndex=0;
box.style.cssText='width:48px;height:48px;border-radius:50%;background:#1a2024;'+
'border:1px solid #333;position:relative;touch-action:none;cursor:grab;margin:2px auto';
box.title='Drag up/down to change, Shift for fine control, wheel to step ×10';
const needle=document.createElement('div');
needle.style.cssText='position:absolute;left:50%;top:3px;width:2px;height:18px;'+
'background:var(--acc,#e0b23c);transform-origin:50% 21px;pointer-events:none';
const valEl=document.createElement('div'); valEl.className='sn-val';
valEl.style.cssText='text-align:center;font-size:10px;margin-top:2px';
box.append(needle);
// get/set — необязательные переопределения: по умолчанию читаем/пишем n.p[s.n],
// но крутилке иногда нужно управлять внешним полем узла, не обычным параметром (см. rtlsdr.tuneKnob)
const getV=()=> s.get? s.get(n) : n.p[s.n];
const disp=v=> s.fmt? s.fmt(v) : fmt(v);
const render=()=>{ valEl.textContent=disp(getV()); };
const setV=v=>{ if(s.min!=null) v=Math.max(s.min,v); if(s.max!=null) v=Math.min(s.max,v);
if(s.set) s.set(n,v); else n.p[s.n]=v; render(); s.fn &&s.fn(n); };
render();
if(!s.get) (n.set||(n.set={}))[s.n]=setV;           // программная установка — только для обычных n.p-параметров
let sy=0, pid=null, ang=0;
box.addEventListener('pointerdown',e=>{ e.stopPropagation(); pid=e.pointerId;
box.setPointerCapture(pid); sy=e.clientY; box.style.cursor='grabbing'; });
box.addEventListener('pointermove',e=>{
if(pid==null) return;
const dy=sy-e.clientY; sy=e.clientY;
ang=(ang+dy*6)%360; needle.style.transform=`rotate(${ang}deg)`;
setV(getV()+dy*(e.shiftKey?s.step/10:s.step)); });
const end=()=>{ pid=null; box.style.cursor='grab'; };
box.addEventListener('pointerup',end); box.addEventListener('pointercancel',end);
box.addEventListener('wheel',e=>{ e.preventDefault(); e.stopPropagation();
// тот же троттлинг, что и у 'range'/'range2' — трекпад может прислать десятки событий на
// один свайп; тут шаг фиксированный (не множится), но незачем позволять и ему разгоняться.
const now=performance.now();
if(box._lastWheelT!=null && now-box._lastWheelT<80) return;
box._lastWheelT=now;
setV(getV()+(e.deltaY <0?s.step:-s.step)*10); },{passive:false});
row.append(box,valEl);
} else if(s.t==='code'){
row.className='prm wide';
const wrap=document.createElement('div'); wrap.className='code';
const ta=document.createElement('textarea'); ta.value=n.p[s.n]; ta.spellcheck=false; ta.wrap='off';
let pre=null, code=null;
if(!s.plain){
pre=document.createElement('pre'); pre.setAttribute('aria-hidden','true'); code=document.createElement('code'); pre.append(code);
wrap.append(pre); }
const paint=()=>{ if(!code) return; code.innerHTML=hlJs(ta.value)+'\n'; pre.scrollTop=ta.scrollTop; pre.scrollLeft=ta.scrollLeft; };
ta.addEventListener('input',()=>{ n.p[s.n]=ta.value; paint(); s.fn &&s.fn(n); });
ta.addEventListener('scroll',()=>{ if(pre){ pre.scrollTop=ta.scrollTop; pre.scrollLeft=ta.scrollLeft; } });
ta.addEventListener('pointerdown',e=>e.stopPropagation());
ta.addEventListener('keydown',e=>{ e.stopPropagation();
if(e.key==='Tab' && !s.plain){                      // отступ вместо смены фокуса
e.preventDefault(); ta.setRangeText('  ',ta.selectionStart,ta.selectionEnd,'end'); ta.dispatchEvent(new Event('input')); } });
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=v; ta.value=v; paint(); };
n.ta=ta; wrap.append(ta); row.append(wrap); paint();
} else if(s.t==='range2'){
// Диапазон одной строкой: два мини-слайдера с взаимным клампом (нижний не может обогнать верхний)
const wrap=document.createElement('div'); wrap.className='range2';
const mkBox=(key,isLo)=>{
const min=s.min,max=s.max,step=s.step,log=s.log;
const box=document.createElement('div'); box.className='slidernum'; box.tabIndex=0;
box.dataset.param=key; box.dataset.node=n.id;
box.title='Drag left/right to change, click to type, double-click to reset, wheel to step';
bindPendingComplete(box,n,key);                  // второй тап — довязать провод прямо на половину диапазона
const fillEl=document.createElement('div'); fillEl.className='sn-fill';
const valEl=document.createElement('span'); valEl.className='sn-val';
box.append(fillEl,valEl);
const pct=v=> log? clamp(Math.log(v/min)/Math.log(max/min),0,1)*100
: clamp((v-min)/((max-min)||1),0,1)*100;
const disp=v=> Math.abs(v) >=1000? (Math.round(v/10)/100)+'k' : String(Math.round(v));
const render=v=>{ fillEl.style.width=pct(v)+'%'; valEl.textContent=disp(v); };
const setV=v=>{
v=clamp(v,min,max);
const other=n.p[isLo?s.keys[1]:s.keys[0]];
v=isLo? Math.min(v,other-(step||1)) : Math.max(v,other+(step||1));
n.p[key]=v; render(v); };
render(n.p[key]); (n.set||(n.set={}))[key]=setV;
box.addEventListener('dblclick',()=>{ box.querySelector('input')?.blur(); setV(s.d[isLo?0:1]); });   // сброс к умолчанию
let dragging=false,sx=0,sv=0,moved=false,pid=null;
box.addEventListener('pointerdown',e=>{
if(e.target!==box  && e.target!==fillEl  && e.target!==valEl) return;
e.stopPropagation(); pid=e.pointerId; box.setPointerCapture(pid);
dragging=true; moved=false; sx=e.clientX; sv=n.p[key]; });
box.addEventListener('pointermove',e=>{
if(!dragging) return;
const dx=e.clientX-sx;
if(Math.abs(dx) >3) moved=true;
if(!moved) return;
const slow=e.shiftKey?8:1, w=Math.max(60,box.offsetWidth);
let v=log? sv*Math.exp(dx*Math.log(max/min)/w/slow) : sv+dx*(max-min)/w/slow;
if(step) v=Math.round(v/step)*step;
setV(v); });
const endDrag=()=>{ if(!dragging) return; dragging=false;
if(pid!=null) box.releasePointerCapture(pid); if(!moved) openEdit(); };
box.addEventListener('pointerup',endDrag);
box.addEventListener('pointercancel',endDrag);
function openEdit(){
if(box.querySelector('input')) return;
const inp=document.createElement('input'); inp.type='number';
inp.value=Math.round(n.p[key]); inp.step=step||'any';
inp.addEventListener('pointerdown',ev=>ev.stopPropagation());
box.append(inp); inp.focus(); inp.select();
// применяем прямо по мере ввода — см. комментарий у openEdit() в 'range' выше (та же причина)
inp.addEventListener('input',()=>{
const v=parseFloat(String(inp.value).replace(',','.')); if(isFinite(v)) setV(v); });
let finished=false;
const done=ok=>{ if(finished) return; finished=true;
if(ok){ const v=parseFloat(String(inp.value).replace(',','.')); if(isFinite(v)) setV(v); }
inp.remove(); };
inp.addEventListener('keydown',ev=>{ ev.stopPropagation();
if(ev.key==='Enter') done(true); if(ev.key==='Escape') done(false); });
inp.addEventListener('blur',()=>done(true)); }
box.addEventListener('wheel',e=>{
e.preventDefault(); e.stopPropagation();
// троттлинг + сниженный шаг — та же история и те же числа, что у обычного 'range' выше (см.
// комментарий там подробно про то, почему троттлинга интервала одного было мало).
const now=performance.now();
if(box._lastWheelT!=null && now-box._lastWheelT<80) return;
box._lastWheelT=now;
const v=n.p[key], st=log? Math.max(Math.abs(v)*.03,(max-min)/1000) : (step||1);
setV(v+(e.deltaY <0?st:-st)); },{passive:false});
return box; };
wrap.append(mkBox(s.keys[0],true));
const dash=document.createElement('span'); dash.className='r2dash'; dash.textContent='–';
wrap.append(dash);
wrap.append(mkBox(s.keys[1],false));
row.append(wrap);
} else if(s.t==='buttons'){
const box=document.createElement('div'); box.className='seg';
const btns=s.opts.map(o=>{ const b=document.createElement('button'); b.textContent=o;
b.addEventListener('click',e=>{ e.stopPropagation(); n.p[s.n]=o; upd(); s.fn &&s.fn(n); });
b.addEventListener('pointerdown',e=>e.stopPropagation());
box.append(b); return b; });
const upd=()=>btns.forEach((b,i)=>b.classList.toggle('on',s.opts[i]===n.p[s.n]));
upd(); (n.set||(n.set={}))[s.n]=v=>{ if(v!=null) n.p[s.n]=v; upd(); };
row.append(box);
} else if(s.t==='select'){
const sel=document.createElement('select');
const fill=()=>{ const cur=n.p[s.n];
const opts=(typeof s.opts==='function')? s.opts(n) : s.opts;
sel.innerHTML='';
for(const o of opts){ const op=document.createElement('option');
op.value=op.textContent=o; sel.append(op); }
sel.value=opts.includes(cur)?cur:opts[0]; };
fill();
if(typeof s.opts==='function'){                  // список устройств строится при открытии
sel.addEventListener('pointerdown',fill);
(n.set||(n.set={}))[s.n]=fill; }
else (n.set||(n.set={}))[s.n]=v=>{ if(v!=null) n.p[s.n]=v; fill(); };
sel.addEventListener('change',()=>{ n.p[s.n]=sel.value; s.fn &&s.fn(n); });
row.append(sel);
} else if(s.t==='num'){
const i=document.createElement('input'); i.type='number'; i.step='any'; i.value=n.p[s.n];
// 'change', а не 'input': иначе КАЖДАЯ цифра при наборе (1, 10, 105, 1050, …) сразу же уходит в
// n.p[s.n] — а для чего-то вроде частоты приёмника это на каждой цифре реальная (через USB)
// перестройка на бессмысленное промежуточное значение. 'change' коммитит один раз — по Enter,
// по клику на спиннер, или по потере фокуса — ровно то число, что реально ввели.
i.addEventListener('change',()=>n.p[s.n]=+i.value); row.append(i);
// Пока поле в фокусе — программные обновления (например, непрерывно следующий steerFreq у
// rtlsdr) не трогают i.value: иначе они стирают то, что человек ещё только печатает, СРАЗУ, даже
// не дожидаясь commit'а по 'change' — "сбрасывается на текущую даже при начале ввода". n.p[s.n]
// всё равно обновляем — как дойдёт до 'change' (blur/Enter), в него уйдёт то, что реально ввели.
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=v; if(document.activeElement!==i) i.value=v; };
} else if(s.t==='check'){
const i=document.createElement('input'); i.type='checkbox'; i.checked=!!n.p[s.n];
i.addEventListener('change',()=>{ n.p[s.n]=i.checked; s.fn &&s.fn(n); }); row.append(i);
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=!!v; i.checked=!!v; s.fn &&s.fn(n); };
} else {
const i=document.createElement('input'); i.type='text'; i.value=n.p[s.n];
i.addEventListener('input',()=>n.p[s.n]=i.value);
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=v; i.value=v; };
row.append(i); }
n.pel=n.pel||{}; n.pel[s.n]=row;
return row;
}
const fmt=v=>{ v=+v||0;                              // на случай пропущенного значения — не падать, а показать 0
return Math.abs(v) >=1000?(v/1000).toFixed(2)+'k':Math.abs(v) >=10?v.toFixed(1):v.toFixed(3); };
function editVal(span,cur,setV,s){                 // точный ввод по клику на значение
if(span.querySelector('input')) return;
const old=span.textContent;
const i=document.createElement('input'); i.value=cur; i.title=`${s.min} … ${s.max}`;
span.textContent=''; span.append(i); i.focus(); i.select();
let finished=false;
const done=ok=>{ if(finished) return; finished=true;
const v=parseFloat(String(i.value).replace(',','.').replace(/k$/i,'e3'));
span.textContent=old; if(ok&&isFinite(v)) setV(v); };
i.addEventListener('keydown',e=>{ e.stopPropagation();
if(e.key==='Enter') done(true); if(e.key==='Escape') done(false); });
i.addEventListener('blur',()=>done(true));
i.addEventListener('pointerdown',e=>e.stopPropagation());
}
/* ---- провода ---- */
function portPos(n,el,dir){
if(n.lod && !n.ghost){                             // свёрнутый узел: слева входы, справа выходы
const w=n.el.offsetWidth||n.size.w;
return {x:n.x+(dir==='o'?w:0), y:n.y+(n.lod===LOD_DOT ? (n.el.offsetHeight||34)/2 : 14)};
}
// .pin ищем один раз на элемент и кэшируем на нём же — иначе querySelector дважды на каждый провод
// на каждой перерисовке (порты не пересоздаются иначе как через rebuildNode, который даёт новый el).
const pin=el._pinEl || (el._pinEl = el.querySelector('.pin')||el);
const root=n.ghost&&n.ghost.contains(el) ? n.ghost : n.el;
let px=0,e=pin;
while(e &&e!==root){ px+=e.offsetLeft; e=e.offsetParent; }   // x — от пина, transform его не сдвигает
let py=0; e=el;
while(e &&e!==root){ py+=e.offsetTop; e=e.offsetParent; }    // y — от .port: пин центрируется в нём CSS-transform'ом
const r=pin.offsetHeight/2;
const cx = dir==='o' ? px+pin.offsetWidth-r  : px+r;
return {x:n.x+cx, y:n.y+py+el.offsetHeight/2};
}
function drawWires(){
if(typeof dashMode!=='undefined' && uiLocked()) return;
// Сначала все чтения геометрии (portPos читает offsetLeft/offsetParent — это layout reads),
// и только потом все записи атрибута d. Если чередовать чтение и запись по одному проводу за раз,
// браузер вынужден на каждой итерации форсировать синхронный reflow, чтобы отдать актуальный offset.
wires.style.transform=content.style.transform ;        // держим в синхроне на каждый вызов, а не только по panzoomchange
wiresFront.style.transform=content.style.transform;
const jobs=[];
for(const e of Graph.edges){
const a= Graph.map[e.from], b=Graph.map[e.to]; if(!a||!b) continue;
const p1=portPos(a,nodePorts(a).o[e.fp],'o'), p2=portPos(b,nodePorts(b).i[e.tp],'i');
jobs.push([e,curve(p1,p2)]);
}
for(const [e,d ] of jobs){
e.path.setAttribute('d',d); e.hit.setAttribute('d',d);
if(e.hoverClone) e.hoverClone.setAttribute('d',d);
}
}
function curve(p1,p2){
const ddx=p2.x-p1.x;
// вперёд: вылет контрольных точек не больше половины расстояния — на близких узлах (точки) кривая
// остаётся плавной S, а не петлёй; назад — вылет не меньше 40
const dx=ddx>=0 ? Math.max(ddx*.5,12) : Math.max(40,-ddx*.5);
// "обратная" связь (вход левее выхода) — чисто горизонтальный вылет контрольных точек не
// разводит кривую, они почти сходятся, и провод петлёй ложится прямо на узлы между портами.
// back растёт от 0 (обычная связь) до 1 (полностью назад) — на этот вес добавляем ОБЕИМ
// контрольным точкам одинаковый вертикальный вынос (в ту сторону, куда уже идёт связь по Y) —
// вместо тесной петли провод обходит узлы дугой сверху/снизу.
const back=clamp(-ddx/60,0,1);
const dy=back*(60+Math.abs(p2.y-p1.y)*.3)*(p2.y>=p1.y?1:-1);
return  `M${p1.x+8000},${p1.y+8000} C${p1.x+dx+8000},${p1.y+dy+8000} ${p2.x-dx+8000},${p2.y+dy+8000} ${p2.x+8000},${p2.y+8000}` ;
}
/* ---- история, выделение, буфер обмена ---- */
let graphDirty=false;                                // есть ли несохранённые изменения с последней загрузки/сохранения патча
const Undo={
stack:[], idx:-1, busy:false,
push(){
if(this.busy) return;
flush();                                          // ← синхронизируем граф перед сериализацией
const s=JSON.stringify(serialize());
if(this.stack[this.idx]===s) return;
graphDirty=true;
this.stack=this.stack.slice(0,this.idx+1);
this.stack.push(s);
if(this.stack.length>60) this.stack.shift();
this.idx=this.stack.length-1;
updUndo();
scheduleAutosave();                              // реальное изменение графа — единственный триггер сохранения
},
go(i){
if(i<0||i>=this.stack.length) return;
this.busy=true;
deserialize(JSON.parse(this.stack[i]));
this.idx=i; this.busy=false; updUndo();
graphDirty=true;                                  // откат/повтор тоже уводит от сохранённого состояния
},
undo(){ this.go(this.idx-1); },
redo(){ this.go(this.idx+1); }
};
function updUndo(){
const u=document.getElementById('undo'), r=document.getElementById('redo');
if(u) u.disabled=Undo.idx<=0;
if(r) r.disabled=Undo.idx>=Undo.stack.length-1;
}
const Sel=new Set();
function syncSel(){ for(const n of Graph.nodes) n.el.classList.toggle('sel',Sel.has(n.id));
const cb=document.getElementById('chain'); if(cb) cb.disabled=Sel.size!==1 || (typeof dashMode!=='undefined' && dashMode); }
function selSet(id,add){
if(!add){ Sel.clear(); Sel.add(id); }
else { Sel.has(id)? Sel.delete(id) : Sel.add(id); }
syncSel();
}
function delSel(){
if(!Sel.size) return;
[...Sel].map(id=>Graph.map[id]).filter(Boolean).forEach(delNode);
Sel.clear(); markWiresDirty(); Undo.push();
}
let clip=null;
function copySel(){
if(!Sel.size) return;
clip={
nodes:Graph.nodes.filter(n=>Sel.has(n.id)).map(n=>{
const o={id:n.id,type:n.type,x:n.x,y:n.y,w:n.size.w,h:n.size.h,p:{...n.p}};
return o; }),
edges:Graph.edges.filter(e=>Sel.has(e.from) &&Sel.has(e.to)).map(e=>
({from:e.from,fp:e.fp,to:e.to,tp:e.tp}))
};
stat.textContent='copied nodes: '+clip.nodes.length;
}
let pasting=false;
function pasteData(data,dx,dy){
if(!data||!data.nodes.length) return;
pasting=true;
const map={};
Sel.clear();
for(const nd of data.nodes){
const nn=addNode(nd.type,nd.x+dx,nd.y+dy,nd.p);
if(!nn) continue;
map[nd.id]=nn.id;
if(nd.f) setLod(nn,nd.f===LOD_DOT ? LOD_DOT : LOD_CARD);
if(nd.w){ nn.size.w=nd.w; nn.size.h=nd.h||nn.size.h; applySize(nn); }
Sel.add(nn.id); }
for(const e of data.edges)
if(map[e.from] &&map[e.to]) addEdge(map[e.from],e.fp,map[e.to],e.tp);
pasting=false; syncSel(); markWiresDirty(); Undo.push();
}
/* ---- взаимодействие (мышь + тач) ---- */
let link=null, zCounter=1, activeInteractions=0;
const cv=document.getElementById('canvas');
// Видимость узла (в пределах холста, в дашборде — в показанном тайле) — от IntersectionObserver:
// раньше каждый кадр читали getBoundingClientRect/offsetWidth, а это принудительный layout
// поверх того, что браузер и так делает при отрисовке кадра.
const visIO=new IntersectionObserver(es=>{
for(const e of es){ const n=e.target._node; if(n && n.el===e.target) n._vis=e.isIntersecting; }
},{root:cv, rootMargin:'40px'});
const TOUCH=matchMedia('(pointer:coarse)').matches;
function toCanvas(ev){ const r=cv.getBoundingClientRect();
return {x:(ev.clientX-r.left+cv.scrollLeft)/view.k-view.x,
y:(ev.clientY-r.top +cv.scrollTop)/view.k-view.y}; }
/* ---- пан/зум/пинч канваса — отдан Panzoom, узлы (.panzoom-exclude) им не трогаются ---- */
let panzooming=false;
const panzoom=Panzoom(content,{canvas:true,maxScale:2.5,minScale:.25,step:.1,excludeClass:'panzoom-exclude'});
content.addEventListener('panzoomstart',()=>{ panzooming=true; cv.classList.add('grab'); });
content.addEventListener('panzoomend',  ()=>{ panzooming=false; cv.classList.remove('grab'); });
// Зум колесом/пинчем: panzoomstart/end не приходят. Пока идёт зум — не рисуем узлы и держим
// слои с will-change: браузер масштабирует готовый растр, а не перерисовывает всё на каждом шаге.
// Через 200 мс после последнего шага слои снимаются и один раз перерастеризуются в чёткость.
let zooming=false, zoomEndT=0;
function zoomTouch(){
if(!zooming){ zooming=true; for(const e of [content,wires,wiresFront]) e.style.willChange='transform'; }
clearTimeout(zoomEndT);
zoomEndT=setTimeout(()=>{ zooming=false; for(const e of [content,wires,wiresFront]) e.style.willChange=''; },200);
}
let rescaleT=0, rescaleK=null;
content.addEventListener('panzoomchange',ev=>{
view.x=ev.detail.x; view.y=ev.detail.y; view.k=ev.detail.scale;
if(view.k!==rescaleK){ rescaleK=view.k; clearTimeout(rescaleT); rescaleT=setTimeout(rescaleCanvases,250); }
wires.style.transform=content.style.transform; wiresFront.style.transform=content.style.transform;
syncGridBg(); });
function rescaleCanvases(){                          // буферы канв под новый масштаб холста
if(zooming){ clearTimeout(rescaleT); rescaleT=setTimeout(rescaleCanvases,250); return; }
// сначала все чтения размеров, потом все записи — иначе reflow на каждой канве
const jobs=[];
for(const [c,f] of HiDPICanvases){ if(c.isConnected) jobs.push([f,c.getBoundingClientRect().width]); else HiDPICanvases.delete(c); }   // отсоединённые — удалённые/пересобранные узлы
for(const [f,w] of jobs) f(false,w);
}
function syncGridBg(){                                // точки фона двигаются и масштабируются вместе с холстом
syncGraphClip();
}
// Плавный зум колесом: цель копится пропорционально deltaY (тачпад — мелко, колесо — щелчками),
// масштаб догоняет её по кадрам. panzoom.zoomWithWheel прыгал фиксированным шагом на событие.
let wz=null;
function wzStep(){
const k=panzoom.getScale(), t=wz.k;
const nk=Math.abs(t-k)<t*.002 ? t : k+(t-k)*.3;
panzoom.zoomToPoint(nk,{clientX:wz.x,clientY:wz.y},{animate:false});
zoomTouch();
if(nk!==t) wz.raf=requestAnimationFrame(wzStep); else wz=null;
}
cv.addEventListener('wheel',e=>{
if(uiLocked() || e.target.closest?.('.panzoom-exclude.dash-pane,.dash-tools')) return;   // колесо над обычной панелью — её прокрутка
e.preventDefault();
let dy=e.deltaY||e.deltaX;
if(e.deltaMode===1) dy*=16; else if(e.deltaMode===2) dy*=400;   // строки/страницы (Firefox)
dy=clamp(dy,-120,120);
if(!wz) wz={k:panzoom.getScale(), x:0, y:0, raf:0};
wz.k=clamp(wz.k*Math.exp(-dy*.0015),.25,2.5); wz.x=e.clientX; wz.y=e.clientY;
zoomTouch();
if(!wz.raf) wz.raf=requestAnimationFrame(wzStep);
},{passive:false});
/* ---- два пальца — пан/зум даже поверх узла; один палец — обычное поведение (drag узла / пан по пустому месту) ---- */
function stopAllDrags(){                              // второй палец не должен параллельно тащить узел
(interact.interactions?.list||[]).forEach(i=>{ try{ i.stop(); }catch(e){} });
}
const touches=new Map();
let pinch=null;
function relPt(e){ const r=cv.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; }
function midDist(pts){ const [a,b]=pts; return {mx:(a.x+b.x)/2,my:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)}; }
cv.addEventListener('pointerdown',e=>{
if(e.pointerType!=='touch') return;
// в дашборде холст скрыт; .ownpinch — канва со своим pinch (спектр sa)
if(uiLocked() || e.target.closest?.('.ownpinch,.panzoom-exclude.dash-pane,.dash-tools')) return;
touches.set(e.pointerId,relPt(e));
if(touches.size===2){
stopAllDrags();
const {mx,my,d}=midDist([...touches.values()]);
pinch={ d0:d, cx:mx/view.k-view.x, cy:my/view.k-view.y };   // точка контента, что должна остаться под пальцами
e.stopPropagation(); }
},{capture:true});
cv.addEventListener('pointermove',e=>{
if(!touches.has(e.pointerId)) return;
touches.set(e.pointerId,relPt(e));
if(touches.size===2 &&pinch){
const {mx,my,d}=midDist([...touches.values()]);
view.k=Math.min(2.5,Math.max(.25,view.k*(d/pinch.d0))); pinch.d0=d;
view.x=mx/view.k-pinch.cx; view.y=my/view.k-pinch.cy;
zoomTouch(); applyView();
e.preventDefault(); e.stopPropagation(); }
},{capture:true,passive:false});
function endTouch(e){
if(e.pointerType!=='touch') return;
touches.delete(e.pointerId);
if(touches.size<2) pinch=null;
}
cv.addEventListener('pointerup',endTouch,{capture:true});
cv.addEventListener('pointercancel',endTouch,{capture:true});
syncGridBg();                                         // синхронизировать фон с начальным view
/* ---- перетаскивание и ресайз узлов — отдано interact.js ---- */
function bindDrag(headEl,n){
interact(headEl).draggable({ ignoreFrom:'.x', listeners:{
start(ev){ if(uiLocked()){ ev.interaction.stop(); return; }
if(!Sel.has(n.id)) selSet(n.id,ev.shiftKey);
const group=[...Sel].map(id=>Graph.map[id]).filter(Boolean);
group.forEach(g=>g.el.style.zIndex=++zCounter);
n.__x0=n.x; n.__y0=n.y;                        // абсолютный отсчёт от старта — без накопления ошибки округления
n.__grp=group.map(g=>({g,ox:g.x-n.x,oy:g.y-n.y})); n.__moved=false; activeInteractions++; },
move(ev){ if(uiLocked()) return;
n.x=Math.round(n.__x0+(ev.clientX-ev.clientX0)/view.k);
n.y=Math.round(n.__y0+(ev.clientY-ev.clientY0)/view.k);
for(const it of n.__grp){ it.g.x=n.x+it.ox; it.g.y=n.y+it.oy;
posNode(it.g); }
n.__moved=true; drawWires(); },
end(){ activeInteractions--; if(n.__moved) Undo.push(); n.__grp=null; }
}});
}
function bindResize(rzEl,n){
interact(rzEl).draggable({ listeners:{
start(ev){ if(uiLocked()){ ev.interaction.stop(); return; }
n.__rw=n.size.w; n.__rh=n.size.h; activeInteractions++; },
move(ev){ if(uiLocked()) return;
n.size.w=clamp(Math.round(n.__rw+(ev.clientX-ev.clientX0)/view.k),160,1400);
n.size.h=clamp(Math.round(n.__rh+(ev.clientY-ev.clientY0)/view.k),40,2000);
applySize(n); drawWires(); },
end(){ activeInteractions--; Undo.push(); }
}});
}
function startLink(ev,n,port,dir){ if(uiLocked()) return;
ev.preventDefault(); ev.stopPropagation();
if(pending){                                       // второй тап завершает связь
if(pending.dir!==dir){
if(pending.dir==='o') connect(pending.n.id,pending.port,n.id,port);
else connect(n.id,port,pending.n.id,pending.port);
stat.textContent='connection created'; }
clearPending(); return; }
const el=nodePorts(n)[dir][port]; el.classList.add('lit');
link={n,port,dir,el,x0:ev.clientX,y0:ev.clientY};
const t=document.createElementNS('http://www.w3.org/2000/svg','path');
t.setAttribute('fill','none'); t.setAttribute('stroke','var(--acc)');
t.setAttribute('vector-effect','non-scaling-stroke');
t.setAttribute('stroke-dasharray','4 3'); t.setAttribute('stroke-width','1.5');
wires.append(t); link.tmp=t; }
let pending=null;
function clearPending(){ if(pending){ pending.el.classList.remove('lit'); pending=null; } }
function bindPendingComplete(el,n,param){            // второй тап (клик-клик, без удержания) — довязать провод прямо
el.addEventListener('pointerdown',ev=>{              // на контрол; ловим в capture — раньше, чем свой драг поля у box
if(!pending) return;
const target = pending.dir==='o' ? n.ports.i[param] : n.ports.o[param];
if(!target) return;
ev.preventDefault(); ev.stopPropagation();
if(pending.dir==='o') connect(pending.n.id,pending.port,n.id,param);
else connect(n.id,param,pending.n.id,pending.port);
stat.textContent='connection created';
clearPending();
},true);
}
function cancelLink(){ if(!link) return;
if(link.el!==(pending &&pending.el)) link.el.classList.remove('lit');
link.tmp.remove(); link=null; }
function controlPortEl(el){                          // бросили провод не на пин, а прямо на контрол — свой ли это узел
if(!el) return null;
const nodeId=el.dataset.node, param=el.dataset.param; if(!nodeId||!param) return null;
const cn=Graph.map[nodeId]; if(!cn) return null;
return link.dir==='o' ? cn.ports.i[param] : cn.ports.o[param];   // ищем пин противоположного направления
}
function dropLink(ev){                              // порт определяем по точке отпускания
if(!link)  return;
const moved=Math.hypot(ev.clientX-link.x0,ev.clientY-link.y0);
const hit=document.elementFromPoint(ev.clientX,ev.clientY);
let el=hit?.closest?.('.port');
// у контрола (схлопнутого в ci/co, пока не подключён — см. .port.ctrl) может быть сразу два пина
// в одной колонке; если попали точно на «не тот» (или вообще мимо любого пина), пробуем найти
// нужный по всей строке контрола, на которой он висит.
if(!el || el.dataset.dir===link.dir){
const alt=controlPortEl(hit?.closest?.('.prm[data-param],.slidernum[data-param]'));
if(alt) el=alt;
}
if(el  && el.dataset.dir  && el.dataset.dir!==link.dir){
if(link.dir==='o') connect(link.n.id,link.port,el.dataset.node,el.dataset.port);
else connect(el.dataset.node,el.dataset.port,link.n.id,link.port);
clearPending();
} else if(moved <8){                                // это был тап — ждём второй
clearPending();
pending={n:link.n,port:link.port,dir:link.dir,el:link.el};
link.el.classList.add('lit');
stat.textContent='port selected: '+link.port+' — tap the second one, or an empty spot to pick a module';
} else if(moved>=8 && (hit===cv || hit===content)){   // провод отпущен на пустом месте — модули, подходящие этому порту
const t=portT(link.n,link.dir==='o'?'outs':'ins',link.port);
if(t) openModPicker(ev.clientX,ev.clientY,toCanvas(ev),{n:link.n,port:link.port,dir:link.dir,type:t});
}
cancelLink();
}
cv.addEventListener('pointerdown',ev=>{
if(uiLocked()) return;
if(ev.target===cv||ev.target===content){
if(!ev.shiftKey &&Sel.size){ Sel.clear(); syncSel(); }
tapFrom=pending ? {n:pending.n,port:pending.port,dir:pending.dir,x:ev.clientX,y:ev.clientY,t:ev.timeStamp} : null;
clearPending(); }
},true);
// выбран порт, затем тап по пустому месту — выбор модуля для него (отпускание рядом с точкой нажатия, не панорама)
let tapFrom=null;
cv.addEventListener('pointerup',ev=>{
const f=tapFrom; tapFrom=null;
if(!f || ev.timeStamp-f.t>500 || Math.hypot(ev.clientX-f.x,ev.clientY-f.y)>8) return;
const t=portT(f.n,f.dir==='o'?'outs':'ins',f.port);
if(t) openModPicker(ev.clientX,ev.clientY,toCanvas(ev),{n:f.n,port:f.port,dir:f.dir,type:t});
});                                              // capture — отработать раньше Panzoom
window.addEventListener('pointermove',ev=>{
if(uiLocked()) return;
if(link){ const p=toCanvas(ev), a=portPos(link.n,link.el,link.dir);
link.tmp.setAttribute('d', link.dir==='o'?curve(a,p):curve(p,a)); }
},{passive:false});
function endPointer(ev){
if(link) dropLink(ev);
}
window.addEventListener('pointerup',endPointer);
window.addEventListener('pointercancel',endPointer);
function applyView(){                                 // программная установка вида (fitView и т.п.)
panzoom.zoom(view.k,{animate:false});
panzoom.pan(view.x,view.y,{animate:false});
wires.style.transform=content.style.transform; wiresFront.style.transform=content.style.transform;
syncGridBg();
}
function fitView(box){                              // вписать весь патч в экран (или в box — область холста)
flush();                                            // ← синхронизируем граф перед замерами offsetWidth/Height
if(!Graph.nodes.length) return;
const cr=cv.getBoundingClientRect(), r=box&&box.w?{width:box.w,height:box.h}:cr, ox=box?.x||0, oy=box?.y||0, pad=24;
let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
for(const n of Graph.nodes){ const el=n.ghost||n.el; x0=Math.min(x0,n.x); y0=Math.min(y0,n.y);
x1=Math.max(x1,n.x+el.offsetWidth); y1=Math.max(y1,n.y+el.offsetHeight); }
const sx=Math.max(1,x1-x0), sy=Math.max(1,y1-y0);
if(r.width<50||r.height<50) return;
const k=clamp(Math.min((r.width-pad*2)/sx,(r.height-pad*2)/sy),.25,1.2);
view.k=k; view.x=(ox+pad+(r.width-pad*2-sx*k)/2)/k-x0;
view.y=(oy+pad+(r.height-pad*2-sy*k)/2)/k-y0; applyView();
}
// На старте некоторые узлы (кодовые поля, канвасы) досчитывают свой реальный размер
// на следующих кадрах — из-за этого fitView сразу после deserialize мерил их «сжатыми»,
// а потом лейаут менялся и патч визуально «уезжал». Меряем после двух rAF, когда всё устаканилось.
function fitViewWhenReady(){
requestAnimationFrame(()=>requestAnimationFrame(()=>fitView()));
}
document.getElementById('fit').onclick=()=>fitView();
// кнопка детализации: все узлы разом — полные → карточки → точки → полные
document.getElementById('lod').onclick=()=>{
const next=((Graph.nodes.reduce((m,n)=>Math.max(m,n.lod|0),0))+1)%3;
for(const n of Graph.nodes) setLod(n,next);
showToast(['detail: full','detail: compact','detail: dots'][next]);
Undo.push(); fitView();
};
let dashMode=false;
// свёрнутый сайдбар (десктоп): выбор пользователя по ☰; в тайлах прячется независимо от него
let sideCollapsedPref=false;
try{ sideCollapsedPref=localStorage.getItem('dsp-side-collapsed')==='1'; }catch(e){}
function setSideCollapsed(on){ document.getElementById('side').classList.toggle('collapsed',!!on); }
setSideCollapsed(sideCollapsedPref);
function uiLocked(){ return dashMode && !dashGraphOn(); }   // в тайлах без панели графа холст закрыт
/* ---- дашборд: тайловая раскладка закреплённых (📌) узлов, дерево произвольных сплитов (как в tiling WM) ---
   Graph.dashTree — либо null, либо {t:'leaf',id,node} с id узла или null (пустой слот),
   либо {t:'split',id,dir:'row'|'col',children:[...],sizes:[...]} (проценты, sum=100).
   dashGridEl/dashBtn могут отсутствовать, если у пользователя закэширован старый index.html без
   них (index.html, в отличие от .js/.css, не версионируется query-параметром) — тогда просто тихо
   не заводим дашборд, вместо необработанного исключения, роняющего остальную инициализацию. */
const dashGridEl=document.getElementById('dashGrid');
const dashBtn=document.getElementById('dash');
let dashSeq=1;
function dashId(){ return 'd'+(dashSeq++); }
// id в загруженном дереве начинаются с d1 — без сдвига счётчика новый сплит получал чужой id
function dashSyncSeq(){
  const walk=t=>{ if(!t) return;
    const k=+String(t.id).slice(1); if(k>=dashSeq) dashSeq=k+1;
    if(t.t==='split') t.children.forEach(walk); };
  for(const pg of Graph.dashPages) walk(pg.tree);
}
/* лист — {t:'leaf',id,tabs:[{node,view?,bare?}],cur}: вкладки в одном тайле, видна tabs[cur].
   Старый формат {node,view,bare} (сохранения, пресеты) переводится при первом обращении. */
function dashNormLeaf(l){
  if(!l.tabs){ const x={node:l.node??null}; if(l.view) x.view=l.view; if(l.bare) x.bare=true;
    l.tabs=[x]; l.cur=0; delete l.node; delete l.view; delete l.bare; }
  if(!l.tabs.length) l.tabs.push({node:null});
  l.cur=clamp(l.cur|0,0,l.tabs.length-1);
  return l;
}
function dashTab(l){ return dashNormLeaf(l).tabs[l.cur]; }
function dashLeaf(nodeId){ return {t:'leaf', id:dashId(), tabs:[{node:nodeId??null}], cur:0}; }
function dashEnsureTree(){ if(!Graph.dashTree) Graph.dashTree=dashLeaf(null); return Graph.dashTree; }
function dashFind(t,id,parent,idx){                  // {leaf,parent,idx} по id узла дерева, либо null
  if(!t) return null;
  if(t.id===id) return {leaf:t,parent,idx};
  if(t.t==='split') for(let i=0;i<t.children.length;i++){ const r=dashFind(t.children[i],id,t,i); if(r) return r; }
  return null;
}
function dashLeaves(t,out){ out=out||[];
  if(!t) return out;
  if(t.t==='leaf') out.push(dashNormLeaf(t)); else t.children.forEach(c=>dashLeaves(c,out));
  return out;
}
// модуль занимает не больше одной вкладки на странице, на разных страницах может повторяться
function dashLeafOf(nodeId){ return dashLeaves(Graph.dashTree).find(l=>l.tabs.some(x=>x.node===nodeId))||null; }
function dashForget(nodeId){                          // удалённый узел — из вкладок всех страниц
  let hit=false;
  for(const pg of Graph.dashPages) for(const l of dashLeaves(pg.tree)){
    const i=l.tabs.findIndex(x=>x.node===nodeId); if(i<0) continue;
    hit=true;
    if(l.tabs.length>1){ l.tabs.splice(i,1); if(l.cur>=i && l.cur>0) l.cur--; }
    else l.tabs[0]={node:null};
  }
  return hit;
}
function dashAutoPlace(n){                            // первая пустая вкладка (обход в глубину)
  for(const l of dashLeaves(dashEnsureTree())){
    const x=l.tabs.find(x=>x.node==null && !x.view);
    if(x){ x.node=n.id; delete x.bare; return true; }
  }
  return false;
}
// развёрнутая на всю сетку панель (id листа) — только вид, не сохраняется
let dashMax=null;
function dashToggleMax(leafId){
  dashMax= dashMax===leafId? null : leafId;
  dashRenderRoot();
  if(dashGraphLeaf()) dashGraphFit();
}
function dashSplit(leafId,dir){
  dashMax=null;
  const f=dashFind(Graph.dashTree,leafId); if(!f||f.leaf.t!=='leaf') return;
  const split={t:'split', id:dashId(), dir, children:[f.leaf,dashLeaf(null)], sizes:[50,50]};   // лист как есть — со вкладками
  if(f.parent) f.parent.children[f.idx]=split; else Graph.dashTree=split;
  dashRenderRoot(); Undo.push();
}
function dashCollapse(t){                             // сплит с 1 ребёнком → сам этот ребёнок (рекурсивно)
  if(!t||t.t!=='split') return t;
  t.children=t.children.map(dashCollapse);
  return t.children.length===1? t.children[0] : t;
}
function dashRemoveLeaf(leafId){                       // убрать панель, отдав её место соседям
  const f=dashFind(Graph.dashTree,leafId); if(!f||f.leaf.t!=='leaf') return;
  if(!f.parent){ Graph.dashTree=null; dashRenderRoot(); Undo.push(); return; }
  f.parent.children.splice(f.idx,1); f.parent.sizes.splice(f.idx,1);
  const sum=f.parent.sizes.reduce((a,b)=>a+b,0)||1;
  f.parent.sizes=f.parent.sizes.map(s=>s*100/sum);
  Graph.dashTree=dashCollapse(Graph.dashTree);
  dashRenderRoot(); Undo.push();
}
function dashRenderRoot(){
  // узлы вне дерева — обратно на холст, иначе после очистки сетки они выпадают из DOM
  const leaves=dashLeaves(Graph.dashTree), placed=new Set(), hidden=new Set();
  const maxLeaf=dashMax!=null? leaves.find(l=>l.id===dashMax)||null : null;
  if(!maxLeaf) dashMax=null;
  for(const l of leaves) l.tabs.forEach((x,i)=>{ if(x.node==null) return; placed.add(x.node);
    if(i!==l.cur || (maxLeaf && l!==maxLeaf)) hidden.add(x.node); });
  for(const n of Graph.nodes){
    if(!placed.has(n.id)){ if(n.el.parentNode!==content){ content.appendChild(n.el); applySize(n); n.onResize?.(n); } }
    else if(hidden.has(n.id)) n.el.remove();            // фоновая вкладка: вне DOM, на графе — заглушка
  }
  dashGridEl.innerHTML='';
  if(!Graph.dashTree){
    const hint=document.createElement('div'); hint.className='dash-empty';
    hint.textContent="No panes";
    dashGridEl.append(hint); dashSyncGhosts(); dashPagesRender(); return;
  }
  dashGridEl.append(maxLeaf? dashRenderLeaf(maxLeaf) : dashRenderNode(Graph.dashTree));
  dashSyncGhosts();
  dashPagesRender();
  dashFitSoon();
}
// основная канва (или список bandplan/bookmarks) узла в панели — до низа панели: контролы над ней
// переносятся по ширине, поэтому её верх плавает и чистым CSS высоту не задать
const DASH_FILL='canvas.view.main, .bp-ui, .bm-ui, .trk-tile';
function dashFit(){
  if(!dashMode) return;
  for(const body of dashGridEl.querySelectorAll('.dash-body')){
    const el=body.querySelector(DASH_FILL); if(!el) continue;
    const mid=el.closest('.mid'), padB=mid?parseFloat(getComputedStyle(mid).paddingBottom)||0:12;
    const h=Math.max(110, Math.floor(body.getBoundingClientRect().bottom-el.getBoundingClientRect().top-padB));
    if(Math.abs((parseFloat(el.style.height)||0)-h)>1) el.style.height=h+'px';
  }
  for(const body of dashGridEl.querySelectorAll('.dash-body')) dashRailSync(body);
  syncGraphClip();                                      // размер/место панели графа могли измениться
}
// своя полоса прокрутки панели для тача: тащим бегунок или тапаем по полосе
function dashRailSync(body){
  const pane=body.parentElement, rail=pane.querySelector('.dash-rail'); if(!rail) return;
  const over=body.scrollHeight-body.clientHeight>1;
  pane.classList.toggle('scroll',over);
  if(!over) return;
  rail.style.top=body.offsetTop+'px';
  const H=body.clientHeight, th=Math.max(36,H*H/body.scrollHeight);
  const max=body.scrollHeight-H;
  rail.firstChild.style.height=th+'px';
  rail.firstChild.style.top=(max>0?body.scrollTop/max*(H-th):0)+'px';
}
function bindDashRail(rail,body){
  body.addEventListener('scroll',()=>dashRailSync(body),{passive:true});
  rail.addEventListener('pointerdown',ev=>{
    ev.preventDefault(); ev.stopPropagation(); rail.setPointerCapture(ev.pointerId);
    const thumb=rail.firstChild, r=rail.getBoundingClientRect(), t=thumb.getBoundingClientRect();
    // тап мимо бегунка — бегунок центрируется под пальцем, дальше тащим
    const grab=(ev.clientY>=t.top && ev.clientY<=t.bottom) ? ev.clientY-t.top : t.height/2;
    const move=e=>{
      const H=r.height, th=thumb.getBoundingClientRect().height, max=body.scrollHeight-body.clientHeight;
      body.scrollTop=clamp((e.clientY-r.top-grab)/Math.max(1,H-th),0,1)*max;
    };
    const up=()=>{ rail.classList.remove('active');
      rail.removeEventListener('pointermove',move); rail.removeEventListener('pointerup',up); rail.removeEventListener('pointercancel',up); };
    rail.classList.add('active'); move(ev);
    rail.addEventListener('pointermove',move); rail.addEventListener('pointerup',up); rail.addEventListener('pointercancel',up);
  });
}
let dashFitRaf=0;
function dashFitSoon(){ if(!dashFitRaf) dashFitRaf=requestAnimationFrame(()=>{ dashFitRaf=0; dashFit(); dashObserve(); }); }
const dashRO=typeof ResizeObserver!=='undefined' ? new ResizeObserver(()=>dashFitSoon()) : null;
const dashObserved=new Set();
function dashObserve(){                                 // панель и сам узел (ширина -> перенос контролов, advanced)
  if(!dashRO) return;
  // diff вместо disconnect+observe: повторный observe шлёт начальное уведомление и зацикливает dashFit
  const want=new Set();
  for(const body of dashGridEl.querySelectorAll('.dash-body')){
    want.add(body);
    const mid=body.querySelector('.mid'); if(mid) want.add(mid);
  }
  for(const el of dashObserved) if(!want.has(el)){ dashRO.unobserve(el); dashObserved.delete(el); }
  for(const el of want) if(!dashObserved.has(el)){ dashRO.observe(el); dashObserved.add(el); }
}
function dashRenderNode(t){
  if(t.t==='leaf') return dashRenderLeaf(t);
  const wrap=document.createElement('div'); wrap.className='dash-split '+t.dir;
  t.children.forEach((c,i)=>{
    const el=dashRenderNode(c); el.style.flex='0 1 '+t.sizes[i]+'%';   // shrink — место под разделители
    wrap.append(el);
    if(i<t.children.length-1){
      const rz=document.createElement('div'); rz.className='dash-resizer panzoom-exclude';
      bindDashResizer(rz,t,i); wrap.append(rz);
    }
  });
  return wrap;
}
function dashDetach(n){                                 // узел уезжает из своей вкладки обратно на холст, 📌 не трогаем
  const leaf=dashLeafOf(n.id); if(leaf) for(const x of leaf.tabs) if(x.node===n.id) x.node=null;
  if(dashMode){ content.appendChild(n.el); applySize(n); n.onResize?.(n); }
}
function dashTabLabel(x){
  if(x.view==='graph') return '◇ Graph';
  const n=x.node!=null?Graph.map[x.node]:null;
  return n? dashShort(n) : '·';
}
// подпись вкладки без семейства («Tracker: Mixer» → «Mixer»), #id — только если модулей такого типа несколько
function dashShort(n){
  const t=MOD[n.type].title, i=t.indexOf(': ');
  let s=i>0? t.slice(i+2) : t;
  if(Graph.nodes.some(x=>x!==n && x.type===n.type)) s+=' #'+n.id;
  return s;
}
function dashBtn2(txt,title,fn,cls){
  const b=document.createElement('button'); b.textContent=txt; b.title=title; b.onclick=fn;
  if(cls) b.className=cls; return b;
}
function dashRenderLeaf(t){
  dashNormLeaf(t);
  const tab=t.tabs[t.cur];
  const pane=document.createElement('div');
  pane.className='dash-pane'+(tab.view==='graph'?'':' panzoom-exclude');   // мимо панелей Panzoom холст не тащит
  const tools=document.createElement('div'); tools.className='dash-tools panzoom-exclude';
  const n=tab.node!=null?Graph.map[tab.node]:null;
  // выбор/смена модуля в активной вкладке — всегда доступен, не только для пустых панелей
  const sel=document.createElement('select'); sel.className='dash-pick';
  const isGraph=tab.view==='graph';
  sel.append(new Option(n||isGraph?'— clear —':'— pick module —',''));
  const graphElsewhere=dashLeaves(Graph.dashTree).some(l=>l.tabs.some(x=>x!==tab && x.view==='graph'));
  if(!graphElsewhere) sel.append(new Option('◇ Module graph','@graph'));   // одна на страницу
  const cand=Graph.nodes.filter(x=>x===n || !dashLeafOf(x.id));   // любой модуль, ещё не занявший вкладку
  for(const pn of cand) sel.append(new Option(pn===n? dashShort(pn) : MOD[pn.type].title+' #'+pn.id, pn.id));   // выбранный — коротко, как вкладка
  if(n) sel.title=MOD[n.type].title+' #'+n.id;
  if(n) sel.value=n.id; else if(isGraph) sel.value='@graph';
  sel.addEventListener('pointerdown',e=>e.stopPropagation());
  sel.onchange=()=>{ if(n) dashDetach(n);
    const toGraph=sel.value==='@graph';
    if(toGraph){ tab.node=null; tab.view='graph'; }
    else { tab.node=sel.value||null; delete tab.view; }
    delete tab.bare;
    dashRenderRoot(); Undo.push();
    if(toGraph) dashGraphFit(); };
  // вкладки: активная — сам селект, остальные — кнопки; полоса прокручивается по горизонтали
  const strip=document.createElement('div'); strip.className='dash-tabs';
  t.tabs.forEach((x,i)=>{
    if(i===t.cur){ strip.append(sel); return; }
    const b=dashBtn2(dashTabLabel(x),x.node!=null&&Graph.map[x.node]? MOD[Graph.map[x.node].type].title+' #'+x.node : 'Switch to tab',()=>{
      t.cur=i; dashRenderRoot(); scheduleAutosave();
      if(x.view==='graph') dashGraphFit(); },'dash-tab');
    strip.append(b);
  });
  strip.append(dashBtn2('+','New tab in this pane',()=>{
    t.tabs.push({node:null}); t.cur=t.tabs.length-1; dashRenderRoot(); Undo.push(); },'dash-tadd'));
  tools.append(strip);
  if(t.tabs.length>1) requestAnimationFrame(()=>{           // активная вкладка в зоне видимости
    const l=sel.offsetLeft-strip.offsetLeft, r=l+sel.offsetWidth;
    if(l<strip.scrollLeft || r>strip.scrollLeft+strip.clientWidth) strip.scrollLeft=l-24; });
  // действия панели; в узкой панели прячутся под «⋯» (см. @container в styles.css)
  const acts=document.createElement('div'); acts.className='dash-acts';
  if(n?.cv){                                            // только канва: контролы и заголовок узла спрятаны
    const bb=dashBtn2('⛶','Canvas only (hide controls)',()=>{ tab.bare=!tab.bare; dashRenderRoot(); Undo.push(); });
    bb.classList.toggle('on',!!tab.bare);
    acts.append(bb);
    pane.classList.toggle('bare',!!tab.bare);
  }
  if(isGraph){
    acts.append(dashBtn2('⊕','Add module (or double-click the canvas)',e=>dashGraphAdd(e.currentTarget)),
      dashBtn2('⤢','Fit patch',dashGraphFit));
    pane.classList.add('graph');
  }
  const many=t.tabs.length>1, isMax=dashMax===t.id;
  const bm=dashBtn2('⊡',isMax?'Restore layout (Esc, double-click header)':'Maximize pane (double-click header)',()=>dashToggleMax(t.id));
  bm.classList.toggle('on',isMax); pane.classList.toggle('max',isMax);
  if(!isMax) acts.append(bm);                            // развёрнута — кнопка возврата всегда на виду, не под «⋯»
  acts.append(dashBtn2('⬌','Split right',()=>dashSplit(t.id,'row')),
    dashBtn2('⬍','Split down',()=>dashSplit(t.id,'col')),
    dashBtn2(many?'⨯':'✕',many?'Close tab':'Remove pane',()=>{
      if(n) dashDetach(n);
      if(!many){ dashRemoveLeaf(t.id); return; }
      t.tabs.splice(t.cur,1); t.cur=Math.min(t.cur,t.tabs.length-1);
      dashRenderRoot(); Undo.push(); }));
  const more=dashBtn2('⋯','Pane actions',()=>tools.classList.toggle('acts'),'dash-more');
  tools.append(...(isMax?[bm]:[]),more,acts);
  // двойной клик/тап по пустому месту шапки — развернуть/вернуть
  tools.addEventListener('dblclick',e=>{ if(e.target===tools || e.target===strip) dashToggleMax(t.id); });
  pane.append(tools);
  const body=document.createElement('div'); body.className='dash-body';
  if(n) body.append(n.el);
  else if(!isGraph){ const ph=document.createElement('div'); ph.className='dash-empty';
    ph.textContent=cand.length? 'Pick a module above' : 'No free modules';
    body.append(ph); }
  pane.append(body);
  const rail=document.createElement('div'); rail.className='dash-rail'; rail.append(document.createElement('i'));
  bindDashRail(rail,body); pane.append(rail);
  return pane;
}
addEventListener('pointerdown',e=>{                     // «⋯» закрывается тапом мимо
  if(!dashMode) return;
  for(const t of dashGridEl.querySelectorAll('.dash-tools.acts')) if(!t.contains(e.target)) t.classList.remove('acts');
},true);
/* ---- панель «граф модулей»: окно в обычный холст ----
   Холст (#content/#wires) остаётся под сеткой тайлов, панель графа прозрачна и не ловит события —
   узлы, провода, пан/зум работают как вне тайлов. Узел, занявший другую панель, на холсте
   заменяется заглушкой (n.ghost) с теми же пинами: провода к нему видны, связи можно тянуть. */
function dashGraphLeaf(){ return dashLeaves(Graph.dashTree).find(l=>dashTab(l).view==='graph')||null; }   // граф в активной вкладке
function dashGraphOn(){ return dashMode && !!dashGraphLeaf(); }
function nodePorts(n){ return n.ghost ? n.ghostPorts : n.ports; }
function ghostBuild(n){
  const d=MOD[n.type], g=document.createElement('div');
  g.className='node ghost panzoom-exclude'; g.dataset.id=n.id; g.style.width=n.size.w+'px';
  g.innerHTML=`<div class="nhead" style="--cat:${catColor(d.cat)}"><span class="ttl">${d.title}</span></div>
<div class="nbody"><div class="io3"><div class="col"></div><div class="mid"><div class="ghostNote">▣ in pane</div></div><div class="col o"></div></div></div>`;
  const [ci,co]=g.querySelectorAll('.col'), gp={i:{},o:{}};
  for(const dir of ['i','o']) for(const k in n.ports[dir]){
    const e=n.ports[dir][k].cloneNode(true); e.classList.remove('lit');
    e.addEventListener('pointerdown',ev=>startLink(ev,n,k,dir));
    (dir==='i'?ci:co).append(e); gp[dir][k]=e; }
  bindDrag(g.querySelector('.nhead'),n);
  n.ghost=g; n.ghostPorts=gp; content.append(g); posNode(n);
}
function ghostDrop(n){ if(!n.ghost) return; n.ghost.remove(); n.ghost=null; n.ghostPorts=null; }
function dashSyncGhosts(){
  const on=dashGraphOn();
  for(const n of Graph.nodes){
    const need=on && n.el.parentNode!==content;
    if(need && !n.ghost) ghostBuild(n); else if(!need) ghostDrop(n);
  }
  cv.classList.toggle('graphOn',on);
  syncGraphClip();
  markWiresDirty();
}
function dashGraphBox(){                               // прямоугольник панели графа относительно холста
  const el=dashGridEl.querySelector('.dash-pane.graph>.dash-body'); if(!el) return null;
  const r=el.getBoundingClientRect(), c=cv.getBoundingClientRect();
  return {x:r.left-c.left, y:r.top-c.top, w:r.width, h:r.height};
}
// холст виден только в панели графа: между панелями зазоры, сквозь них узлы видны быть не должны.
// clip-path — в локальных координатах слоя (до его transform), поэтому пересчёт на каждый пан/зум.
function syncGraphClip(){
  const b=cv.classList.contains('graphOn') && dashGraphBox(), layers=[content,wires,wiresFront];
  if(!b){ for(const e of layers) e.style.clipPath=''; return; }
  const k=view.k, x0=b.x/k-view.x, y0=b.y/k-view.y, x1=x0+b.w/k, y1=y0+b.h/k;
  const poly=o=>`polygon(${x0+o}px ${y0+o}px,${x1+o}px ${y0+o}px,${x1+o}px ${y1+o}px,${x0+o}px ${y1+o}px)`;
  content.style.clipPath=poly(0);
  wires.style.clipPath=wiresFront.style.clipPath=poly(8000);   // слои проводов сдвинуты на -8000px
}
function dashGraphFit(){ requestAnimationFrame(()=>requestAnimationFrame(()=>{ const b=dashGraphBox(); if(b) fitView(b); })); }
/* ---- выбор модуля прямо на холсте: двойной клик по пустому месту или «+» панели графа ----
   Поиск по названию/id/категории, стрелки + Enter, Esc — закрыть. at — точка холста для узла. */
let modPickEl=null;
function closeModPicker(){ modPickEl?.remove(); modPickEl=null; }
function openModPicker(clientX,clientY,at,from){
  closeModPicker();
  const box=document.createElement('div'); box.className='modpick panzoom-exclude';
  const inp=document.createElement('input'); inp.type='search'; inp.placeholder='Add module…';
  const list=document.createElement('div'); list.className='mp-list';
  if(from){ const h=document.createElement('div'); h.className='mp-from';          // провод ищет, к чему подключиться
    h.innerHTML=`<span class="pin" style="background:${TYPE_COLOR[from.type]}"></span>${from.type} ${from.dir==='o'?'→':'←'} <i></i>`;
    h.querySelector('i').textContent=from.port; box.append(h); }
  box.append(inp,list); document.body.append(box); modPickEl=box;
  const mods=Object.values(MOD).filter(m=>!m.legacy && !String(m.id).startsWith('custom:'))
    .sort((a,b)=>catRank(a.cat)-catRank(b.cat)||a.title.localeCompare(b.title));
  let items=[], cur=0;
  const pick=m=>{ closeModPicker();
    const cp=from && compatPort(m,from.type,from.dir);
    const n=addNodeUI(m.id,Math.round(at.x-(from&&from.dir==='i'?220:0)),Math.round(at.y)); if(!n) return;
    if(cp){ const was=Undo.busy; Undo.busy=true;
      try{ if(from.dir==='o') connect(from.n.id,from.port,n.id,cp.n); else connect(n.id,cp.n,from.n.id,from.port); }
      finally{ Undo.busy=was; } }
    Sel.clear(); Sel.add(n.id); syncSel(); markWiresDirty(); Undo.push(); };
  const hl=()=>items.forEach((it,k)=>{ it.el.classList.toggle('on',k===cur); if(k===cur) it.el.scrollIntoView({block:'nearest'}); });
  const build=()=>{
    const q=inp.value.trim();
    list.innerHTML=''; items=[]; cur=0; let cat=null;
    // с поиском — плоский список по релевантности, без — по категориям
    // порт того же типа — выше, чем через автоадаптер (iq ↔ sig)
    const exact=m=>!from || compatPort(m,from.type,from.dir)?.t===from.type;
    let shown=mods.filter(m=>(!from || compatPort(m,from.type,from.dir)) && (!q || modScore(m,q)>0));
    if(q) shown=shown.map(m=>[m,modScore(m,q)+(exact(m)?10:0)]).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
    else if(from) shown=[...shown.filter(exact),...shown.filter(m=>!exact(m))];
    let viaHdr=false;
    for(const m of shown){
      if(!q && from && !exact(m) && !viaHdr){ viaHdr=true; cat=null; const h=document.createElement('div'); h.className='mp-cat'; h.textContent='via auto adapter'; list.append(h); }
      if(!q && m.cat!==cat){ cat=m.cat; const h=document.createElement('div'); h.className='mp-cat'; h.textContent=cat; list.append(h); }
      const b=document.createElement('button'); b.className='mp-item';
      const cp=from && compatPort(m,from.type,from.dir);
      b.innerHTML=`${modIcon(m)}<b></b>${cp ? '<i class="mp-port"></i>' : ioDots(m)}`;
      b.querySelector('b').textContent=m.title; b.title=m.id;
      if(cp) b.querySelector('.mp-port').textContent=(from.dir==='o'?'→ ':'← ')+cp.n;
      b.onclick=()=>pick(m); list.append(b); items.push({m,el:b});
    }
    if(!items.length){ const e=document.createElement('div'); e.className='mp-cat'; e.textContent='nothing found'; list.append(e); }
    hl();
  };
  inp.addEventListener('input',build);
  inp.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){ e.preventDefault(); cur=Math.min(items.length-1,cur+1); hl(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); cur=Math.max(0,cur-1); hl(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(items[cur]) pick(items[cur].m); }
    else if(e.key==='Escape'){ e.preventDefault(); closeModPicker(); }
  });
  build();
  const W=Math.min(300,innerWidth-16), H=Math.min(380,innerHeight-16);
  box.style.width=W+'px'; box.style.maxHeight=H+'px';
  box.style.left=clamp(clientX,8,innerWidth-W-8)+'px';
  box.style.top=clamp(clientY,8,innerHeight-H-8)+'px';
  if(!TOUCH) inp.focus();                            // на тач клавиатура только по тапу в поле — список виден сразу
}
addEventListener('pointerdown',e=>{ if(modPickEl && !modPickEl.contains(e.target)) closeModPicker(); },true);
cv.addEventListener('dblclick',e=>{                   // пустое место холста — выбрать модуль в эту точку
  if(uiLocked() || (e.target!==cv && e.target!==content)) return;
  e.preventDefault();
  openModPicker(e.clientX,e.clientY,toCanvas(e));
});
function dashGraphAdd(btn){                           // «+» панели графа: узел в центр панели
  const b=dashGraphBox(); if(!b) return;
  const r=btn.getBoundingClientRect();
  openModPicker(r.left,r.bottom+4,{x:(b.x+b.w/2)/view.k-view.x-100, y:(b.y+b.h/3)/view.k-view.y});
}
function bindDashResizer(rz,t,i){                       // тащим границу между t.children[i] и [i+1]
  rz.addEventListener('pointerdown',ev=>{
    ev.preventDefault(); rz.setPointerCapture(ev.pointerId); rz.classList.add('active');
    const wrap=rz.parentElement, horiz=t.dir==='row';
    const total=horiz?wrap.getBoundingClientRect().width:wrap.getBoundingClientRect().height;
    const s0=t.sizes[i], s1=t.sizes[i+1], start=horiz?ev.clientX:ev.clientY;
    const panes=[...wrap.children].filter(el=>el!==rz && !el.classList.contains('dash-resizer'));
    const move=e=>{
      const d=((horiz?e.clientX:e.clientY)-start)/total*100, min=5;
      const a=clamp(s0+d,min,s0+s1-min), b=s0+s1-a;
      t.sizes[i]=a; t.sizes[i+1]=b;
      panes[i].style.flex='0 1 '+a+'%'; panes[i+1].style.flex='0 1 '+b+'%';
    };
    const up=()=>{ rz.classList.remove('active');
      window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); Undo.push(); };
    window.addEventListener('pointermove',move); window.addEventListener('pointerup',up);
  });
}
function setDash(on){
  if(on && !dashGridEl) return;                        // старый закэшированный index.html без #dashGrid — тихо выходим
  dashMode=on; redrawAll();
  LS.set('dsp-dash',on?'1':'');                        // режим переживает перезагрузку страницы
  cv.classList.toggle('dashboard',on);
  setSideCollapsed(on ? true : sideCollapsedPref);     // в тайлах сайдбар мешает — прячем, при выходе возвращаем как было
  dashBtn?.classList.toggle('on',on);
  dashPagesEl?.classList.toggle('on',on);
  document.getElementById('fit').disabled=on; document.getElementById('lod').disabled=on; syncSel();
  if(on){
    dashEnsureTree();
    for(const n of Graph.nodes) if(n.dash && !dashLeafOf(n.id)) dashAutoPlace(n);
    dashRenderRoot();
    if(dashGraphLeaf()) dashGraphFit();
  } else {
    for(const n of Graph.nodes) if(n.el.parentNode!==content){   // все, не только из дерева
      content.appendChild(n.el); applySize(n); n.onResize?.(n); }  // вернуть высоты холстового режима
    for(const n of Graph.nodes) ghostDrop(n);
    cv.classList.remove('graphOn');
    markWiresDirty();
    dashGridEl.innerHTML='';
    dashRO?.disconnect(); dashObserved.clear();
  }
}
if(dashBtn) dashBtn.onclick=()=>setDash(!dashMode);
/* ---- страницы дашборда: наборы тайлов, переключаются вкладками рядом с ▦ ----
   Одна страница — только «+». Тап по активной — меню (имя, копия, порядок, удалить). Alt+1…9 — переход. */
const dashPagesEl=dashBtn? document.createElement('span') : null;
if(dashPagesEl){ dashPagesEl.id='dashPages'; dashBtn.after(dashPagesEl); }
function dashPageName(i){ return Graph.dashPages[i].name || String(i+1); }
function dashPageGo(i){
  if(i<0 || i>=Graph.dashPages.length || !dashMode) return;
  closeDashMenu();
  Graph.dashPage=i; dashMax=null; dashEnsureTree(); dashRenderRoot();
  if(dashGraphLeaf()) dashGraphFit();
  scheduleAutosave();
}
function dashPageAdd(tree){
  Graph.dashPages.push({name:'',tree:tree||null});
  dashPageGo(Graph.dashPages.length-1); Undo.push();
}
function dashCloneTree(t){                             // копия раскладки с новыми id (модули те же)
  if(!t) return null;
  const c=JSON.parse(JSON.stringify(t));
  const walk=x=>{ x.id=dashId(); if(x.t==='split') x.children.forEach(walk); };
  walk(c); return c;
}
function dashPagesRender(){
  if(!dashPagesEl) return;
  dashPagesEl.innerHTML='';
  const many=Graph.dashPages.length>1;
  if(many) Graph.dashPages.forEach((pg,i)=>{
    const b=document.createElement('button'); b.className='dpg'+(i===Graph.dashPage?' on':'');
    b.textContent=dashPageName(i); b.title=i===Graph.dashPage?'Page menu':'Page '+dashPageName(i)+' (Alt+'+(i+1)+')';
    b.onclick=()=>i===Graph.dashPage? openDashMenu(b) : dashPageGo(i);
    dashPagesEl.append(b);
  });
  const add=document.createElement('button'); add.className='dpg add'; add.textContent='+';
  add.title='New tile page';
  add.onclick=()=>dashPageAdd();
  dashPagesEl.append(add);
}
let dashMenuEl=null;
function closeDashMenu(){ dashMenuEl?.remove(); dashMenuEl=null; }
function openDashMenu(btn){
  closeDashMenu();
  const m=document.createElement('div'); m.className='dash-menu';
  const item=(txt,fn,dis)=>{ const b=document.createElement('button'); b.textContent=txt; b.disabled=!!dis;
    b.onclick=()=>{ closeDashMenu(); fn(); }; m.append(b); };
  const i=Graph.dashPage, single=Graph.dashPages.length<2;
  item('Rename…',()=>{
    const v=prompt('Page name',Graph.dashPages[i].name||''); if(v==null) return;
    Graph.dashPages[i].name=v.trim().slice(0,24); dashPagesRender(); Undo.push(); });
  item('Duplicate',()=>dashPageAdd(dashCloneTree(Graph.dashTree)));
  item('◀ Move left',()=>dashPageMove(-1),i===0);
  item('Move right ▶',()=>dashPageMove(1),i===Graph.dashPages.length-1);
  item('Delete page',()=>{
    if(!confirm('Delete tile page "'+dashPageName(i)+'"? Modules stay in the patch.')) return;
    Graph.dashPages.splice(i,1); Graph.dashPage=Math.min(i,Graph.dashPages.length-1);
    dashEnsureTree(); dashRenderRoot(); Undo.push(); },single);
  document.body.append(m); dashMenuEl=m;
  const r=btn.getBoundingClientRect(), W=m.offsetWidth, H=m.offsetHeight;
  m.style.left=clamp(r.left,8,innerWidth-W-8)+'px';
  // панель снизу (телефон) — меню над кнопкой
  m.style.top=(r.bottom+H+8>innerHeight? r.top-H-4 : r.bottom+4)+'px';
}
function dashPageMove(d){
  const i=Graph.dashPage, j=i+d, P=Graph.dashPages;
  if(j<0||j>=P.length) return;
  [P[i],P[j]]=[P[j],P[i]]; Graph.dashPage=j; dashPagesRender(); Undo.push();
}
addEventListener('pointerdown',e=>{ if(dashMenuEl && !dashMenuEl.contains(e.target)) closeDashMenu(); },true);
addEventListener('keydown',e=>{
  if(dashMode && dashMax!=null && e.key==='Escape' && !e.target.closest?.('input,textarea,select')){ dashToggleMax(dashMax); return; }
  if(!dashMode || !e.altKey || e.ctrlKey || e.metaKey) return;
  const k=+e.key; if(k>=1 && k<=9 && k<=Graph.dashPages.length){ e.preventDefault(); dashPageGo(k-1); }
});
document.getElementById('undo').onclick=()=>Undo.undo();
document.getElementById('redo').onclick=()=>Undo.redo();
document.getElementById('dup').onclick=()=>{ copySel(); pasteData(clip,30,30); };
// «→+»: к выбранному узлу — модуль, подходящий его свободному выходу (нет выходов — входу); новый узел сразу соединён и выбран,
// так что цепочку можно наращивать тапами (удобно на телефоне, где тянуть провода трудно)
document.getElementById('chain').onclick=ev=>{
  if(Sel.size!==1){ showToast('select one module first'); return; }
  const n=Graph.map[[...Sel][0]]; if(!n) return;
  const used=(p,dir)=>Graph.edges.some(e=>dir==='o' ? e.from===n.id && e.fp===p.n : e.to===n.id && e.tp===p.n);
  const outs=portsOf(n,'outs'), ins=portsOf(n,'ins');
  // сначала свободный сигнальный выход, затем свободный сигнальный вход (приёмник: звуковая карта, журнал), потом числа и что есть
  const free=(ps,dir,num)=>ps.find(p=>!used(p,dir) && (num || (p.t!=='num' && p.t!=='val')));
  let port=free(outs,'o',false), dir='o';
  if(!port){ port=free(ins,'i',false); dir='i'; }
  if(!port){ port=free(outs,'o',true); dir='o'; }
  if(!port){ port=free(ins,'i',true); dir='i'; }
  if(!port){ port=outs[0]; dir='o'; }
  if(!port){ port=ins[0]; dir='i'; }
  if(!port){ showToast('this module has no ports'); return; }
  const r=ev.currentTarget.getBoundingClientRect(), w=n.el.offsetWidth||212;
  openModPicker(r.left,r.bottom+4,{x:dir==='o' ? n.x+w+70 : n.x-290, y:n.y},{n,port:port.n,dir,type:port.t});
};
document.getElementById('turbo').onchange=e=>{
Eng.turbo=+e.target.value;
stat.textContent = Eng.turbo >1? 'running ×'+Eng.turbo+' — audio distorted' : 'real time'; };
document.getElementById('blk').onchange=async e=>{
const v=+e.target.value;
stat.textContent='block size '+v+', engine restarting';
await Eng.setBlock(v);
stat.textContent='block size '+v+' · inputs need to be re-enabled '; };
window.addEventListener('keydown',ev=>{
const t=ev.target;
if(t &&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
const mod=ev.ctrlKey||ev.metaKey, k=(ev.key||'').toLowerCase();
if(mod &&k==='z'){ ev.preventDefault(); ev.shiftKey?Undo.redo():Undo.undo(); }
else if(mod &&k==='y'){ ev.preventDefault(); Undo.redo(); }
else if(mod &&k==='c'){ copySel(); }
else if(mod &&k==='v'){ pasteData(clip,30,30); }
else if(!mod &&k==='d' &&Sel.size){ ev.preventDefault(); copySel(); pasteData(clip,30,30); }
else if(mod &&k==='a'){ ev.preventDefault();
Graph.nodes.forEach(n=>Sel.add(n.id)); syncSel(); }
else if(k==='delete'||k==='backspace'){ ev.preventDefault(); delSel(); }
else if(k==='escape'){ Sel.clear(); syncSel(); }
});
const side=document.getElementById('side'), scrim=document.getElementById('scrim');
const closeSide=()=>{ side.classList.remove('open'); scrim.classList.remove('open'); };
const narrowUI=matchMedia('(max-width:820px), (pointer:coarse)');
document.getElementById('menu').onclick=()=>{
if(!narrowUI.matches){ sideCollapsedPref=!side.classList.contains('collapsed'); setSideCollapsed(sideCollapsedPref);
  try{ localStorage.setItem('dsp-side-collapsed',sideCollapsedPref?'1':''); }catch(e){}
  return; }
side.classList.toggle('open'); scrim.classList.toggle('open',side.classList.contains('open')); };
scrim.addEventListener('pointerdown',closeSide);
document.querySelectorAll('.sidetab').forEach(t=>t.addEventListener('click',()=>{
document.querySelectorAll('.sidetab').forEach(x=>x.classList.toggle('on',x===t));
document.getElementById('panelModules').classList.toggle('on',t.dataset.tab==='modules');
document.getElementById('panelPatches').classList.toggle('on',t.dataset.tab==='patches');
}));
/* ---- палитра ---- */
const pal=document.getElementById('palette');
let showLegacy=false;
let paletteQuery='';
const openCats=new Set();                            // какие категории раскрыты вручную — переживает перестройку палитры
const catRank=c=>{ const i=CAT_ORDER.indexOf(c); return i<0?999:i; };
const cats=[...new Set(Object.values(MOD).map(m=>m.cat))].sort((a,b)=>catRank(a)-catRank(b));
/* Поиск: все слова запроса должны найтись в названии / id / категории / m.kw; названия, начинающиеся со слова, — выше */
function modScore(m,q){
const words=q.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
if(!words.length) return 1;
const title=m.title.toLocaleLowerCase('ru'), rest=`${m.id} ${m.cat} ${m.kw||''}`.toLocaleLowerCase('ru');
let sc=0;
for(const w of words){
if(title.split(/[^a-zа-я0-9]+/).some(t=>t.startsWith(w))) sc+=3;
else if(title.includes(w)) sc+=2;
else if(rest.includes(w)) sc+=1;
else return 0; }
return sc;
}
/* Совместимость портов: тот же тип, val (универсальный) или iq ↔ sig через автоадаптер (см. connect) */
function typeCompat(a,b){ return a===b || a==='val' || b==='val' || (a==='iq' && b==='sig') || (a==='sig' && b==='iq'); }
// порт модуля m, к которому можно подключить провод, идущий от порта типа t (dir 'o' — провод начат с выхода → ищем вход)
function compatPort(m,t,dir){
const ps=(dir==='o' ? m.ins : m.outs); if(!Array.isArray(ps)) return null;
return ps.find(p=>p.t===t) || ps.find(p=>typeCompat(t,p.t)) || null;
}
// значок модуля без рисования: инициалы на цвете категории, форма — по типу основного выхода
function modIcon(m){
const outs=Array.isArray(m.outs)?m.outs:[], t=outs[0]?.t;
const shape=!outs.length ? 'hex' : t==='iq' ? 'circle' : t==='spec' ? 'diamond' : ['rec','txt','blk','bands','trk','img'].includes(t) ? 'square' : 'round';
return `<span class="mi" data-shape="${shape}" style="--c:${catColor(m.cat)}">${nodeInitials(m.title)}</span>`;
}
function ioDots(m){                                  // строка типов портов — точка + подпись типа
const ins=Array.isArray(m.ins)?m.ins:[], outs=Array.isArray(m.outs)?m.outs:[];
const insT=[...new Set(ins.map(p=>p.t))], outsT=[...new Set(outs.map(p=>p.t))];
if(!insT.length  && !outsT.length) return '';
const chip=t=> `<span class="grp"><span class="pin" style="background:${TYPE_COLOR[t]}"></span>${t}</span>` ;
return  `<span class="pio">${insT.map(chip).join('')}`
+ (insT.length &&outsT.length?' <i class="arr">→</i>':'')
+  `${outsT.map(chip).join('')}</span>` ;
}
// Точка добавления узла кликом — центр экрана. Для drag-n-drop координаты берутся из события (см. ниже).
function dropAt(clientX,clientY){
const r=cv.getBoundingClientRect();
return { x:(clientX-r.left)/view.k-view.x, y:(clientY-r.top)/view.k-view.y };
}
const isCoarse=matchMedia('(pointer:coarse)').matches;
const toastEl=document.getElementById('toast');       // нет в index.php — showToast тогда просто ничего не делает
let toastTimer=null;
function showToast(text){                            // короткое уведомление поверх канваса
if(!toastEl) return;
toastEl.textContent=text; toastEl.classList.add('show');
clearTimeout(toastTimer);
toastTimer=setTimeout(()=>toastEl.classList.remove('show'),1300);
}
function makeCatItem(m){
const b=document.createElement('button'); b.className='pitem'; b.draggable=true;
b.innerHTML= `${modIcon(m)}<span class="ptxt"><b>${m.title}</b><span class="prow"><i>${m.id}</i>${ioDots(m)}</span></span>` ;
b.addEventListener('click',()=>{
const r=cv.getBoundingClientRect();
addNodeUI(m.id,(r.width/2)/view.k-view.x-100+Math.random()*50,
(r.height/3)/view.k-view.y+Math.random()*120);
markWiresDirty();
if(isCoarse) showToast('added: '+m.title);  // панель остаётся открытой — можно накидать несколько подряд
else closeSide();
Undo.push(); });
b.addEventListener('dragstart',e=>{ e.dataTransfer.setData('text/x-dsp-module',m.id);
e.dataTransfer.effectAllowed='copy'; b.classList.add('dragging'); });
b.addEventListener('dragend',()=>b.classList.remove('dragging'));
return b;
}
function makeDetails(key,label,open){
const det=document.createElement('details'); det.className='pcat'; det.open=open;
det.addEventListener('toggle',()=>{
if(paletteQuery.trim()) return;                  // раскрытие поиском не должно переживать его очистку
det.open?openCats.add(key):openCats.delete(key); });
const sum=document.createElement('summary'); sum.textContent=label;
det.append(sum);
return det;
}
function buildPalette(){
pal.innerHTML='';
const q=paletteQuery.trim().toLocaleLowerCase('ru');
let matches=0;
for(const c of cats){
const list=Object.values(MOD).filter(m=>{
if(m.cat!==c || (!showLegacy &&m.legacy)) return false;
return !q || modScore(m,q)>0;
});
if(q) list.sort((a,b)=>modScore(b,q)-modScore(a,q)||a.title.localeCompare(b.title));
if(!list.length) continue;
const det=makeDetails(c,c.toUpperCase(),q?true:openCats.has(c));      // при поиске раскрыто всегда
det.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="cnt">${list.length}</span>` );
for(const m of list){ matches++; det.append(makeCatItem(m)); }
pal.append(det);
}
if(Object.values(MOD).some(m=>m.legacy)){
const t=document.createElement('button'); t.className='pitem';
t.innerHTML=' <b>'+(showLegacy?'hide':'show')+' legacy </b>';
t.addEventListener('click',()=>{ showLegacy=!showLegacy; buildPalette(); });
pal.append(t); }
pal.classList.toggle('empty',matches===0);
}
buildPalette();
// ---- drag-n-drop модуля из палитры на холст ----
cv.addEventListener('dragover',e=>{
if(!e.dataTransfer.types.includes('text/x-dsp-module')) return;
e.preventDefault(); e.dataTransfer.dropEffect='copy'; cv.classList.add('dropok');
});
cv.addEventListener('dragleave',()=>cv.classList.remove('dropok'));
cv.addEventListener('drop',e=>{
cv.classList.remove('dropok');
const modId=e.dataTransfer.getData('text/x-dsp-module');
if(!modId) return;
e.preventDefault();
const p=dropAt(e.clientX,e.clientY);
addNodeUI(modId,p.x-100,p.y-20); markWiresDirty(); Undo.push();
});
const paletteSearch=document.getElementById('paletteSearch');
paletteSearch.addEventListener('input',e=>{ paletteQuery=e.target.value; buildPalette(); });
document.addEventListener('keydown',e=>{
if((e.ctrlKey||e.metaKey) &&e.key.toLowerCase()==='k'){
e.preventDefault(); paletteSearch.focus(); paletteSearch.select();
}
});
/* ---- сохранение ---- */
function serialize(){
flush();                                            // ← синхронизируем граф перед сериализацией
return {v:1, view:{...view},
nodes:Graph.nodes.map(n=>{ const o={id:n.id,type:n.type,x:n.x,y:n.y,
w:n.size.w,h:n.size.h,p:{...n.p},f:n.lod|0,a:n.advOpen?1:0};
if(n.dash) o.dash=1;                                // закреплён (📌) для дашборда
return o; }),
edges:Graph.edges.map(e=>({from:e.from,fp:e.fp,to:e.to,tp:e.tp})),
dashTree:Graph.dashTree,                            // раскладка активной страницы тайлов (старые версии читают только её)
dashPages:Graph.dashPages.map(pg=>({name:pg.name||'',tree:pg.tree})), dashPage:Graph.dashPage};
}
const MIGRATE={                                     // старые узлы → их замена
dmrRx:   {type:'fskRx', p:{proto:'dmr'}, ports:{}},     // DMR Decoder — тот же движок, протокол dmr
water:   {type:'sa', ports:{fsel:'f1'}},
spectrum:{type:'sa', ports:{fsel:'f1', lsel:'snr1'}},
// l1..l4 (уровень 0..1 между floor/top) убраны — провода переносим на snr1..snr4
sa:      {type:'sa', ports:{fsel:'f1', l1:'snr1', l2:'snr2', l3:'snr3', l4:'snr4'}},
gate:    {type:'thresh', ports:{in:'num', out:'num'}},
slice:   {type:'thresh', ports:{in:'sig', out:'sig'}}
};
function migrate(o){
const map={};
for(const n of o.nodes){
const m=MIGRATE[n.type];
if(m){ map[n.id]=m; n.type=m.type; if(m.p) n.p={...m.p,...(n.p||{})}; continue; }
// 'mic' успел дважды сменить форму (mic/mic2 → один узел с выбором канала → оба канала сразу
// одним узлом с двумя выходами) — старые сохранения отличаем по отсутствию devA и досаживаем.
if((n.type==='mic'||n.type==='mic2') && (!n.p || n.p.devA===undefined)){
const old=n.p||{}, oldSlot = n.type==='mic2' || old.slot==='B' ? 1 : 0;
map[n.id]={type:'mic', ports:{out: oldSlot===0?'a':'b'}};
n.type='mic';
n.p={devA: oldSlot===0?(old.dev||'default'):'default', gainA: oldSlot===0?(old.gain??1):1,
     devB: oldSlot===1?(old.dev||'default'):'default', gainB: oldSlot===1?(old.gain??1):1,
     echo:!!old.echo, ns:!!old.ns, agc:!!old.agc};
}
}
for(const e of o.edges){
const a=map[e.from], b=map[e.to];
if(a &&a.ports &&a.ports[e.fp]) e.fp=a.ports[e.fp];
if(b &&b.ports &&b.ports[e.tp]) e.tp=b.ports[e.tp];
}
return o;
}
function deserialize(o){
migrate(o);
const wasBusy=Undo.busy; Undo.busy=true;
Sel.clear();
clearAll();
let max=1;
for(const n of o.nodes){ const nn=addNode(n.type,n.x,n.y,n.p,n.id);
if(nn &&n.f) setLod(nn,n.f===LOD_DOT ? LOD_DOT : LOD_CARD);
if(nn &&n.a) setAdvOpen(nn,true);
if(nn &&n.w){ nn.size.w=n.w; nn.size.h=n.h||nn.size.h; applySize(nn); }
// n.dash — старые сохранения с 📌: такие узлы сами занимают свободные панели при входе в тайлы
if(nn &&n.dash) nn.dash=true;
max=Math.max(max,+String(n.id).slice(1)||0); }
Graph.seq=max+1;
// страницы тайлов; старые сохранения — одна страница из dashTree
Graph.dashPages=Array.isArray(o.dashPages)&&o.dashPages.length
  ? o.dashPages.map(pg=>({name:pg?.name||'',tree:pg?.tree||null})) : [{name:'',tree:o.dashTree||null}];
Graph.dashPage=clamp(o.dashPage|0,0,Graph.dashPages.length-1);
dashSyncSeq();
for(const e of o.edges) addEdge(e.from,e.fp,e.to,e.tp);
if(o.view){ Object.assign(view,o.view); applyView(); }
markWiresDirty();
if(dashMode) setDash(true);
Undo.busy=wasBusy;
if(!wasBusy) Undo.push();
}
function clearAll(){
[...Graph.nodes].forEach(delNode);
// В исходном HTML есть статический снимок патча, у которого нет записи в Graph.
// Удаляем и такие осиротевшие узлы, иначе после «очистить» они остаются на холсте.
content.querySelectorAll(':scope > .node').forEach(el=>el.remove());
// По той же причине чистим SVG-провода, оставшиеся в статическом снимке.
while(wires.firstChild) wires.firstChild.remove();
Graph.nodes=[]; Graph.edges=[]; Graph.map={}; Graph.seq=1; Graph.dashPages=[{name:'',tree:null}]; Graph.dashPage=0;
}
document.getElementById('save').onclick=()=>
dl(new Blob([JSON.stringify(serialize(),null,1)],{type:'application/json'}),'patch.json');
document.getElementById('load').onclick=()=>document.getElementById('fpick').click();
document.getElementById('fpick').onchange=e=>{ const f=e.target.files[0]; if(!f) return;
const r=new FileReader(); r.onload=()=>{ try{ stashIfDirty(); deserialize(JSON.parse(r.result)); fitViewWhenReady(); graphDirty=false; }catch(err){ alert('Could not read file: '+err.message); } };
r.readAsText(f); e.target.value=''; };
document.getElementById('clear').onclick=()=>{
stashIfDirty();
clearAll(); markWiresDirty(); currentPatchName=''; buildPatchList(); graphDirty=false;
};
// Обычная очистка кэша браузера чистит HTTP-кэш, но не localStorage/IndexedDB —
// поэтому пресеты и патчи «не удаляются». Эта кнопка стирает именно данные сайта.
// Кнопки нет в index.php (тестовая, только в index.html) — элемент может отсутствовать.
document.getElementById('wipe')?.addEventListener('click',async()=>{
if(!confirm('Erase all presets, patches and local app data on this site?')) return;
try{ localStorage.clear(); }catch(e){}
try{
const names=indexedDB.databases ? (await indexedDB.databases()).map(d=>d.name) : ['dsp-samples','dsp-lists','dsp-tracker'];
await Promise.all(names.filter(Boolean).map(n=>new Promise(res=>{
const rq=indexedDB.deleteDatabase(n); rq.onsuccess=rq.onerror=rq.onblocked=res; })));
}catch(e){}
try{ if('caches' in window) for(const k of await caches.keys()) await caches.delete(k); }catch(e){}
try{ if(navigator.serviceWorker) for(const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); }catch(e){}
location.href=location.pathname+'?_='+Date.now();
});
// Автосейв раньше сериализовал весь граф по таймеру каждые 4с, даже если ничего не менялось —
// на холостом ходу это лишняя нагрузка. Теперь сохраняем с задержкой после реального изменения.
let autosaveTimer=null;
function scheduleAutosave(){
clearTimeout(autosaveTimer);
autosaveTimer=setTimeout(()=>LS.set(AKEY,JSON.stringify(serialize())),2000);
}
window.addEventListener('beforeunload',()=>{ clearTimeout(autosaveTimer); LS.set(AKEY,JSON.stringify(serialize())); });
const RUN_PLAY='<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>', RUN_STOP='<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
const runBtn=document.getElementById('run'), stat=document.getElementById('stat');
// Общая точка синхронизации кнопки — дергается и по клику, и из движка (например, когда
// узел микрофона сам стартует/резюмирует контекст в обход этой кнопки).
function syncRunBtn(){
const on=Eng.running&&!Eng.paused;
runBtn.innerHTML = on?RUN_STOP:RUN_PLAY;
runBtn.classList.toggle('on',on);
}
Eng.onRunChange=()=>{ syncRunBtn(); wakeDraw(); };
runBtn.onclick=async()=>{
const on=await Eng.toggle();
if(!on){ stat.textContent='paused'; stat.classList.remove('warn','crit'); }
};
const srSel=document.getElementById('sr');
if(srSel) srSel.onchange=async e=>{
const v=+e.target.value||null;
stat.textContent=(v?'sample rate '+v+' Hz':'default sample rate')+', engine restarting';
await Eng.setSampleRate(v);
for(const n of Graph.nodes) rebuildNode(n);   // границы ползунков вида max:()=>Eng.sr/2 — освежить
stat.textContent='sample rate '+Eng.sr+' Hz · inputs need to be re-enabled';
};
function nodeH(n){                                   // высота узла: из DOM либо по составу
const h=n.el &&n.el.offsetHeight;
if(h >10) return h;
const d=MOD[n.type];
const rows=(d.params||[]).length;
return 34+rows*24+(d.view?n.size.h+8:0)+(d.readout?(d.tall?n.size.h:26):0)+(d.swatch?50:0);
}
function autoLayout(gap){                            // раздвигаем пересекающиеся узлы вниз
gap=gap||24;
const list=Graph.nodes.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
const done=[];
for(const n of list){
let moved=true, guard=0;
while(moved &&guard++ <200){
moved=false;
for(const m of done){
const ax1=n.x, ax2=n.x+n.size.w, ay1=n.y, ay2=n.y+nodeH(n);
const bx1=m.x, bx2=m.x+m.size.w, by1=m.y, by2=m.y+nodeH(m);
if(ax1 <bx2+gap &&ax2+gap >bx1 &&ay1 <by2+gap &&ay2+gap >by1){
n.y=by2+gap; moved=true; } }
}
posNode(n);
done.push(n); }
markWiresDirty();
}
/* ---- цикл отрисовки ---- */
let lastDraw=0;
const fpsSel=document.getElementById('fps');
try{ const v=LS.get('dsp-fps'); if(v==='max'||v==='min') fpsSel.value=v; }catch(e){}
fpsSel.onchange=()=>{ try{ LS.set('dsp-fps',fpsSel.value); }catch(e){} wakeDraw(); };
let lastStatText='', lastStatTs=0;
function visible(n){ return n._vis!==false; }       // до первого отчёта — считаем видимым
// Простой: движок не обрабатывает блоки и нет ввода — перерисовка раз в IDLE_MS через
// setTimeout, без rAF на каждый vsync. Асинхронные данные (скриншот tinySA, тайлы и т.п.)
// всё равно появятся, с задержкой не больше IDLE_MS.
const IDLE_MS=250;
let lastInput=0, lastBlocks=-1, lastBlockT=0, idleT=0;
function wakeDraw(){
lastInput=performance.now();
if(idleT){ clearTimeout(idleT); idleT=0; requestAnimationFrame(frame); }
}
for(const ev of ['pointerdown','pointermove','pointerup','wheel','keydown','input','change','resize'])
addEventListener(ev,wakeDraw,{capture:true,passive:true});
function needsDraw(n,ts){
const dk=MOD[n.type].drawKey;
if(dk){ n._dkNow=dk(n); if(n._dkNow!==n._dk) return true; }
if(n._dirty || n._drawGen!==drawGen || ts-n._drawT>=LAZY_MAX_MS) return true;
const c=n.cv;
if(c && (c!==n._cvRef || c.pxGen!==n._pxGen || c.width!==n._cvW || c.height!==n._cvH)) return true;
const p=n.p, ps=n._pSnap;
for(const k in p) if(p[k]!==ps[k]) return true;
return false;
}
function drawnLazy(n,ts){
n._dirty=false; n._drawGen=drawGen; n._drawT=ts; n._dk=n._dkNow;
const c=n.cv;
if(c){ n._cvRef=c; n._pxGen=c.pxGen; n._cvW=c.width; n._cvH=c.height; }
n._pSnap=Object.assign(n._pSnap||{},n.p);
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change',redrawAll);
function frame(ts){
// пока активен живой высокоскоростной источник (rtlsdr) — растягиваем кадр отрисовки. Сама
// отрисовка (особенно водопад/спектр) синхронно грузит главный поток, а от него же зависит
// обслуживание промисов USB-чтения и сообщений воркера демодуляции: то, что интерфейс реже
// перерисовывается в фоновой вкладке (там rAF браузер сам душит), а звук rtlsdr при этом
// меньше затыкается — прямое доказательство именно этой конкуренции. Водопаду 60 к/с не
// нужно (SDR-программы обычно рисуют его на 10-20 к/с), а вот главному потоку эти освободившиеся
// миллисекунды нужны для звука.
const rtlBusy=Graph.nodes.some(n=>n.type==='rtlsdr' && n.connected);
// 20 к/с (было) всё ещё регулярно давало 15-50мс подряд простоев главного потока (см. [Eng]
// main-thread stall в консоли) — ровно в эти простои rtlReadLoop не успевает подкидывать новые
// чтения USB/сообщения демод-воркеру (обе стадии продвигаются промисами на главном потоке),
// и звук rtlsdr затыкается (audio ring starve), хотя сам USB успевал бы. 10 к/с даёт вдвое больше
// пробелов между кадрами отрисовки — тот же компромисс, что и раньше, просто сильнее в пользу звука.
// без ввода интерфейс только показывает данные: после 2 с — 30 к/с, после 10 с — 20 к/с
const still = ts-lastInput>2000 && !activeInteractions && !panzooming && !zooming;
const autoDt = TOUCH?33 : (rtlBusy?100 : still ? (ts-lastInput>10000?50:33) : 16);   // на тач-экранах хватает 30 к/с
const fpsMode=fpsSel.value;                         // переключатель в панели: max — всегда 60 к/с, min — 10 к/с
const minDt = fpsMode==='max' ? 16 : fpsMode==='min' ? 100 : autoDt;
if(ts-lastDraw >=minDt  && !activeInteractions  && !panzooming  && !zooming){
lastDraw=ts;
const toDraw=[];
for(const n of Graph.nodes){
const d=MOD[n.type];
if(!d.draw) continue;
if(d.lazy && !needsDraw(n,ts)) continue;
if(!d.always  && !visible(n)) continue;
toDraw.push(n);
}
for(const n of toDraw){
const d=MOD[n.type];
if(d.lazy) drawnLazy(n,ts);                        // до draw(): он может сам попросить следующий кадр
try{ d.draw(n,n.cv,n.cx); }
catch(e){ if(!n.drawErr){ n.drawErr=1; console.error('draw '+n.type+':',e); } }
}
if(Eng.running &&!Eng.paused){
// статус — ≤4 раз/с и только при изменении строки: ms меняются почти каждый блок
if(ts-lastStatTs>=250){
lastStatTs=ts;
const load=Math.round(Eng.load*100);
const statText= `${Eng.sr} Hz` +(Eng.turbo >1? ` · ×${Eng.turbo}` :'')+
` · ${Eng.t.toFixed(2)} ms · load ${load}% · nodes ${Graph.nodes.length}`;
if(statText!==lastStatText){ stat.textContent=statText; lastStatText=statText; }
// предупреждение имеет смысл только в реальном времени — при turbo>1 движок нарочно бежит быстрее звука
stat.classList.toggle('warn', Eng.turbo===1 &&Eng.load>=.85 &&Eng.load<1);
stat.classList.toggle('crit', Eng.turbo===1 &&Eng.load>=1);
}
}
}
// блоки приходят пачками (аудио-буфер телефона крупнее кадра) — простой только когда их нет заметное время
if(Eng.blocks!==lastBlocks){ lastBlocks=Eng.blocks; lastBlockT=ts; }
const busy=ts-lastBlockT<IDLE_MS || ts-lastInput<2000 || activeInteractions || panzooming || zooming;
if(busy && minDt<33) requestAnimationFrame(frame);
else if(busy){                                       // кадры реже vsync — будим таймером, а не rAF на каждый vsync вхолостую
idleT=setTimeout(()=>{ idleT=0; requestAnimationFrame(frame); },Math.max(0,minDt-(performance.now()-lastDraw)-6));
} else idleT=setTimeout(()=>{ idleT=0; requestAnimationFrame(frame); },IDLE_MS);
}
applyView();
(function boot(){
buildBuiltinPresets();
const a=LS.get(AKEY)||LS.get('dsp-patch');
if(a){ try{ deserialize(JSON.parse(a)); }catch(e){ buildDemo(); } } else buildDemo();
if(LS.get('dsp-dash')==='1') setDash(true);
fitViewWhenReady();                                 // сразу видно весь патч, а не дефолтный центр холста
Undo.stack=[]; Undo.idx=-1; Undo.push();
graphDirty=false;                                   // старт приложения — не пользовательское изменение
currentPatchName='';
})();
// Совместимость со старым сохранённым DOM: в нём могли остаться нативные range-поля.
document.querySelectorAll('#content input[type="range"]').forEach(old=>{
const i=document.createElement('input'); i.type='number';
for(const a of ['min','max','step','value']) if(old.hasAttribute(a)) i.setAttribute(a,old.getAttribute(a));
i.title='Arrow keys or mouse wheel to change the value';
old.replaceWith(i);
});
requestAnimationFrame(frame);


