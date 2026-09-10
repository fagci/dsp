const Graph = { nodes:[], edges:[], map:{}, order:[], seq:1, sel:null };
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
const n={id:id||('n'+(Graph.seq++)), type, x:x||0,  y:y||0, p:{}, out:{}, b:{},
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
Graph.edges.filter(e=>e.from===n.id||e.to===n.id).forEach(delEdge);
Graph.nodes=Graph.nodes.filter(x=>x!==n); delete Graph.map[n.id];
n.el.remove(); markTopoDirty();
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
path.setAttribute('stroke-width','1.6'); path.style.cursor='pointer';
path.addEventListener('click',()=>{ delEdge(e); Undo.push(); });
const hit=document.createElementNS('http://www.w3.org/2000/svg','path');
hit.setAttribute('fill','none'); hit.setAttribute('stroke','transparent');
hit.setAttribute('stroke-width','10'); hit.style.cursor='pointer';
hit.addEventListener('click',()=>{ delEdge(e); Undo.push(); });
hit.addEventListener('pointerenter',()=>{                        // клон поверх узлов, сам провод не трогаем
e.hoverClone=path.cloneNode(); e.hoverClone.setAttribute('stroke-width','2.6');
e.hoverClone.style.pointerEvents='none'; wiresFront.append(e.hoverClone); });
hit.addEventListener('pointerleave',()=>{ e.hoverClone?.remove(); e.hoverClone=null; });
wires.append(hit,path); e.path=path; e.hit=hit;
Graph.edges.push(e); markTopoDirty(); markWiresDirty();
syncLinkedParams(Graph.map[to]);
if(!Undo.busy  && !pasting) Undo.push();
}
function delEdge(e){ e.path?.remove(); e.hit?.remove(); e.hoverClone?.remove();
Graph.edges=Graph.edges.filter(x=>x!==e); markTopoDirty(); markWiresDirty();
syncLinkedParams(Graph.map[e.to]); }
function syncLinkedParams(n){                        // гасим поле параметра, если его перебивает провод
const d=n &&MOD[n.type]; if(!d) return;
const insNames=new Set(portsOf(n,'ins').map(p=>p.n));
for(const s of (d.params||[])){
if(s.t==='range2'){
for(const key of s.keys){
if(!insNames.has(key)) continue;
const box=n.el?.querySelector( `.slidernum[data-param="${key}"]` ); if(!box) continue;
box.classList.toggle('linked', Graph.edges.some(e=>e.to===n.id  && e.tp===key));
}
continue;
}
if(!insNames.has(s.n)) continue;
const row=n.el?.querySelector( `.prm[data-param="${s.n}"]` ); if(!row) continue;
row.classList.toggle('linked', Graph.edges.some(e=>e.to===n.id  && e.tp===s.n));
}
}
function retopo(){
Graph.order=topoOrder(Graph.nodes,Graph.edges,Graph.map);
const idx=new Map();                                // "узел+порт → провод" — см. комментарий в evalNode
for(const e of Graph.edges) idx.set(e.to+'\u0001'+e.tp, e);
Graph.inIndex=idx;
}
/* ---- DOM узла ---- */
function catColor(cat){                             // единый цвет категории — для узлов и палитры
return cat==='Источники'?'var(--t-num)':cat==='Обработка'?'var(--t-sig)'
: cat==='Анализ'?'var(--t-spec)':cat==='Прочее'?'var(--dim)':'var(--t-img)';
}
function posNode(n){                                // position через transform, не left/top —
n.el.style.transform=`translate3d(${n.x}px,${n.y}px,0)`;   // так двигаем узел без layout-reflow всей страницы
}
// Canvas исторически создавался в CSS-пикселях без поправки на плотность экрана —
// на hiDPI (2x/3x) браузер растягивает низкорезкий битмап под физические пиксели,
// отсюда общая нерезкость и цветная кайма на стыке перерисованных областей.
// Перехватываем .width/.height на уровне DOM-узла (тот же приём, что и для readout):
// модуль как ставил/читал логический размер — так и продолжает, а реальный буфер
// под капотом в devicePixelRatio раз крупнее, и матрица контекста это компенсирует.
// Настоящий размер буфера (нужен для putImageData/getImageData — водопады sa/persist)
// доступен через cv.pxW/cv.pxH.
function hiDPICanvas(cv,cx,n){
const nativeW=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');
const nativeH=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'height');
let logW=cv.width, logH=cv.height;
const restretch=()=>{ const dpr=window.devicePixelRatio||1;
nativeW.set.call(cv, cv.pxW=Math.max(1,Math.round(logW*dpr)));
nativeH.set.call(cv, cv.pxH=Math.max(1,Math.round(logH*dpr)));
cx.setTransform(dpr,0,0,dpr,0,0); };
Object.defineProperty(cv,'width',{configurable:true, get:()=>logW,
set:v=>{ logW=v; restretch(); }});
Object.defineProperty(cv,'height',{configurable:true, get:()=>logH,
set:v=>{ logH=v; restretch(); }});
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
const el=document.createElement('div'); el.className='node panzoom-exclude'+(n.type==='note'?' note':''); el.dataset.type=n.type;
el.innerHTML=`<div class="nhead"><span class="dot" style="background:${catColor(d.cat)}"></span> <span class="ttl">${d.title}</span><span class="cl">▾</span><span class="x">✕</span></div> <div class="nbody"></div>`;
const body=el.querySelector('.nbody');
const io=document.createElement('div'); io.className='io3';
const ci=document.createElement('div'); ci.className='col';
const mid=document.createElement('div'); mid.className='mid';
const co=document.createElement('div'); co.className='col o';
n.ports={i:{},o:{}}; n.set={};
const wire=(e,p,dir)=>{ e.dataset.node=n.id; e.dataset.port=p.n; e.dataset.dir=dir;
e.addEventListener('pointerdown',ev=>startLink(ev,n,p.n,dir)); };
// Вход с именем как у параметра — не отдельная строка порта, а джек прямо в строке параметра (см. paramEl).
// Для range2 совпадение проверяем по обоим ключам (fmin/fmax), не по имени всей строки.
const paramNames=new Set((d.params||[]).flatMap(s=> s.t==='range2'? s.keys : [s.n]));
const modIns=new Map(portsOf(n,'ins').filter(p=>paramNames.has(p.n)).map(p=>[p.n,p]));
for(const p of portsOf(n,'ins')){
if(modIns.has(p.n)) continue;
const e=portEl(p,'i'); ci.append(e); n.ports.i[p.n]=e; wire(e,p,'i'); }
for(const p of portsOf(n,'outs')){ const e=portEl(p,'o'); co.append(e); n.ports.o[p.n]=e; wire(e,p,'o'); }
io.append(ci,mid,co); body.append(io); n.mid=mid;
{ const params=d.params||[]; let i=0;                // подряд идущие кнопки/галочки — в один ряд
while(i <params.length){
if(params[i].t==='button'  && params[i+1]  && params[i+1].t==='button'){
const grp=document.createElement('div'); grp.className='prm wide btnrow';
while(i <params.length  && params[i].t==='button'){ grp.append(paramBtn(n,params[i])); i++; }
mid.append(grp);
} else if(params[i].t==='check'){
const grp=document.createElement('div'); grp.className='prm  wide checkrow';
while(i <params.length  && params[i].t==='check'){ grp.append(paramEl(n,params[i],modIns,wire)); i++; }
mid.append(grp);
} else { mid.append(paramEl(n,params[i],modIns,wire)); i++; }
} }
if(d.view){ const  c=document.createElement('canvas'); c.className='view'+(d.pick?' pick':'');
mid.append(c); n.cv=c; n.cx=c.getContext('2d',{willReadFrequently:true});
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
const cp=document.createElement('button'); cp.className='copy'; cp.textContent='Копировать';
cp.addEventListener('click',()=>{ navigator.clipboard?.writeText(r.textContent);
cp.textContent='скопировано'; setTimeout(()=>cp.textContent='Копировать',900); });
mid.append(cp); } }
if(d.swatch){ const s=document.createElement('div'); s.className='swatch'; mid.append(s); }
el.querySelector('.x').addEventListener('click',e=>{e.stopPropagation();
delNode(n); Sel.delete(n.id); Undo.push();});
const cl=el.querySelector('.cl');
cl.addEventListener('click',e=>{ e.stopPropagation(); foldNode(n,!n.folded); Undo.push(); });
cl.addEventListener('pointerdown',e=>e.stopPropagation());
if(n.folded) foldNode(n,true);
bindDrag(el.querySelector('.nhead'),n);
el.addEventListener('pointerdown',ev=>{
if(!Sel.has(n.id)||ev.shiftKey) selSet(n.id,ev.shiftKey); });
n.el=el; content.append(el); el.style.zIndex=++zCounter; posNode(n); applySize(n); // новый узел сразу поверх остальных
if(typeof panelMode!=='undefined' &&panelMode) markPanel();
}
function midWidth(n){
const d=MOD[n.type];
const paramNames=new Set((d.params||[]).flatMap(s=> s.t==='range2'? s.keys : [s.n]));
const insShown=portsOf(n,'ins').some(p=>!paramNames.has(p.n));
const lw=insShown?58:0, rw=portsOf(n,'outs').length?58:0;
return Math.max(90, n.size.w-2-lw-rw-18);
}
function foldNode(n,v){
n.folded=!!v;
n.el.classList.toggle('folded',n.folded);
const cl=n.el.querySelector('.cl'); if(cl) cl.textContent=n.folded?'▸':'▾';
markWiresDirty();
}
function applySize(n){
const d=MOD[n.type];
n.el.style.width=n.size.w+'px';
if(n.cv  && !d.tall){ n.cv.width=midWidth(n); n.cv.height=n.size.h;
n.cv.style.height=n.size.h+'px'; n.resized=true; }
else if(n.cv){ n.cv.width=midWidth(n); n.cv.height=d.view.h;
n.cv.style.height=d.view.h+'px'; n.resized=true; }
if(n.ro  && d.tall) n.ro.style.height=n.size.h+'px';
if(n.cm) n.cm.setSize(null, n.size.h >0? n.size.h : null);      // CodeMirror, если поле кода апгрейднулось
else if(n.ta  && n.size.h >0) n.ta.style.height=n.size.h+'px';
}
function rebuildNode(n){                            // пересобрать DOM, сохранив состояние модуля
const sel=n.el.classList.contains('sel');
fillParamDefaults(n,MOD[n.type]);                  // добить дефолтами новые/переименованные параметры
n.roCv?.disconnect();                               // старая канва уходит вместе с el, наблюдатель — тоже
n.el.remove(); buildNodeEl(n);
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
let cmReady=null;
function loadCodeMirror(){                           // ленивая загрузка с CDN, кэш на всё приложение
if(cmReady) return cmReady;
cmReady=new Promise(res=>{
if(window.CodeMirror) return res(window.CodeMirror);
const base='https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/';
for(const href of [base+'codemirror.min.css', base+'theme/dracula.min.css']){
const l=document.createElement('link'); l.rel='stylesheet'; l.href=href; document.head.append(l); }
const s=document.createElement('script'); s.src=base+'codemirror.min.js';
s.onerror=()=>res(null);
s.onload=()=>{
const m=document.createElement('script'); m.src=base+'mode/javascript/javascript.min.js';
m.onload=()=>res(window.CodeMirror); m.onerror=()=>res(window.CodeMirror);   // подсветка не критична
document.head.append(m); };
document.head.append(s); });
return cmReady;
}
function paramEl(n,s,modIns,wire){
const row=document.createElement('div'); row.className='prm'; row.dataset.param=s.n;
const lab=document.createElement('label'); lab.textContent=s.label||s.n;
lab.title=s.label||s.n;
if(s.t==='button'){
row.className='prm '+(n.type==='mic' &&['on','onB'].includes(s.n)?'mic-button':'wide');
row.append(paramBtn(n,s)); return row;
}
if(s.t==='file'){ row.className='prm wide';
const f=document.createElement('input'); f.type='file'; f.accept=s.accept||'';
f.addEventListener('change',()=>{ if(f.files[0]) s.fn(n,f.files[0]); }); row.append(f); return row; }
const modPort=s.t==='range2'? null : modIns?.get(s.n);   // range2 — джеки внутри mkBox, по ключам
if(modPort){                                        // джек модуляции — вместо отдельной строки порта
const pin=document.createElement('span'); pin.className='pin mpin';
pin.style.setProperty('--pc',TYPE_COLOR[modPort.t]);
pin.title='Перетащите сюда провод — параметр будет управляться извне';
row.classList.add('modable'); row.append(pin);
n.ports.i[modPort.n]=pin; wire(pin,modPort,'i');
}
row.append(lab);
if(s.t==='range'){
// Ползунок-число в духе Blender: тащить — меняет значение, клик — точный ввод текстом.
const box=document.createElement('div'); box.className='slidernum'; box.tabIndex=0;
box.title='Тащить ↔ — изменить, Shift — точнее, клик — ввести число, колесо — шаг';
// min/max можно задать числом или функцией n=>число (например, Eng.sr/2 — привязка к частоте
// движка) — резолвим один раз при сборке; при смене sr узлы пересобираются (см. srSel.onchange).
const smin=typeof s.min==='function'?s.min(n):s.min, smax=typeof s.max==='function'?s.max(n):s.max;
const fillEl=document.createElement('div'); fillEl.className='sn-fill';
const valEl=document.createElement('span'); valEl.className='sn-val';
box.append(fillEl,valEl);
const pct=v=> s.log
? clamp(Math.log(v/smin)/Math.log(smax/smin),0,1)*100
: clamp((v-smin)/((smax-smin)||1),0,1)*100;
const disp=v=> (s.step &&s.step >=1)
? (Math.abs(v) >=1000 ? (Math.round(v/10)/100)+'k' : String(Math.round(v)))
: fmt(v);
const render=v=>{ fillEl.style.width=pct(v)+'%'; valEl.textContent=disp(v); };
const setV=v=>{ v=clamp(v,smin,smax); n.p[s.n]=v; render(v); };
render(n.p[s.n]);
(n.set||(n.set={}))[s.n]=setV;
let dragging=false, sx=0, sv=0, moved=false, pid=null;
box.addEventListener('pointerdown',e=>{
if(e.target!==box && e.target!==fillEl && e.target!==valEl) return; // не мешать текстовому вводу
e.stopPropagation(); pid=e.pointerId; box.setPointerCapture(pid);
dragging=true; moved=false; sx=e.clientX; sv=n.p[s.n];
});
box.addEventListener('pointermove',e=>{
if(!dragging) return;
const dx=e.clientX-sx;
if(Math.abs(dx)>3) moved=true;
if(!moved) return;
const slow=e.shiftKey?8:1, w=Math.max(60,box.offsetWidth);
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
let finished=false;
const done=ok=>{ if(finished) return; finished=true;
if(ok){ const v=parseFloat(String(inp.value).replace(',','.')); if(isFinite(v)) setV(v); }
inp.remove(); };
inp.addEventListener('keydown',ev=>{ ev.stopPropagation();
if(ev.key==='Enter') done(true); if(ev.key==='Escape') done(false); });
inp.addEventListener('blur',()=>done(true));
}
box.addEventListener('wheel',e=>{
e.preventDefault(); e.stopPropagation();
const v=n.p[s.n], step=s.log
? Math.max(Math.abs(v)*.05,(smax-smin)/1000)
: (s.step||1);
setV(v+(e.deltaY <0?step:-step));
},{passive:false});
row.append(box);
} else if(s.t==='knob'){
row.className='prm wide';
const box=document.createElement('div'); box.className='knob'; box.tabIndex=0;
box.style.cssText='width:48px;height:48px;border-radius:50%;background:#1a2024;'+
'border:1px solid #333;position:relative;touch-action:none;cursor:grab;margin:2px auto';
box.title='Тащить вверх/вниз — изменить, Shift — точнее, колесо — шаг ×10';
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
setV(getV()+(e.deltaY <0?s.step:-s.step)*10); },{passive:false});
row.append(box,valEl);
} else if(s.t==='code'){
row.className='prm wide'; n.cm=null;               // сброс — на случай пересборки узла
const ta=document.createElement('textarea'); ta.value=n.p[s.n]; ta.spellcheck=false;
ta.addEventListener('input',()=>{ n.p[s.n]=ta.value; s.fn &&s.fn(n); });
ta.addEventListener('pointerdown',e=>e.stopPropagation());
ta.addEventListener('keydown',e=>e.stopPropagation());
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=v; if(n.cm) n.cm.setValue(v); else ta.value=v; };
n.ta=ta; row.append(ta);
loadCodeMirror().then(CM=>{
if(!CM || !ta.isConnected) return;              // офлайн, либо узел уже пересобран/удалён — оставляем textarea
const cm=CM.fromTextArea(ta,{mode:'javascript',theme:'dracula',lineNumbers:true,
tabSize:2,indentUnit:2,viewportMargin:Infinity});
cm.on('change',()=>{ n.p[s.n]=cm.getValue(); s.fn &&s.fn(n); });
const w=cm.getWrapperElement();
w.addEventListener('pointerdown',e=>e.stopPropagation());
w.addEventListener('keydown',e=>e.stopPropagation());
n.cm=cm; if(n.size.h >0) cm.setSize(null,n.size.h);
});
} else if(s.t==='range2'){
// Диапазон одной строкой: два мини-слайдера с взаимным клампом (нижний не может обогнать верхний)
const wrap=document.createElement('div'); wrap.className='range2';
const mkBox=(key,isLo)=>{
const min=s.min,max=s.max,step=s.step,log=s.log;
const box=document.createElement('div'); box.className='slidernum'; box.tabIndex=0;
box.dataset.param=key;
box.title='Тащить ↔ — изменить, клик — ввести число, колесо — шаг';
const fillEl=document.createElement('div'); fillEl.className='sn-fill';
const valEl=document.createElement('span'); valEl.className='sn-val';
box.append(fillEl,valEl);
const mp=modIns?.get(key);
if(mp){                                         // своя точка на каждую половину — провод не может задать обе
const pin=document.createElement('span'); pin.className='pin mpin';
pin.style.setProperty('--pc',TYPE_COLOR[mp.t]);
pin.title='Перетащите сюда провод — параметр будет управляться извне';
box.append(pin); n.ports.i[mp.n]=pin; wire(pin,mp,'i');
}
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
let finished=false;
const done=ok=>{ if(finished) return; finished=true;
if(ok){ const v=parseFloat(String(inp.value).replace(',','.')); if(isFinite(v)) setV(v); }
inp.remove(); };
inp.addEventListener('keydown',ev=>{ ev.stopPropagation();
if(ev.key==='Enter') done(true); if(ev.key==='Escape') done(false); });
inp.addEventListener('blur',()=>done(true)); }
box.addEventListener('wheel',e=>{
e.preventDefault(); e.stopPropagation();
const v=n.p[key], st=log? Math.max(Math.abs(v)*.05,(max-min)/1000) : (step||1);
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
sel.addEventListener('change',()=>{ n.p[s.n]=sel.value; s.fn &&s.fn(n); });
row.append(sel);
} else if(s.t==='num'){
const i=document.createElement('input'); i.type='number'; i.step='any'; i.value=n.p[s.n];
i.addEventListener('input',()=>n.p[s.n]=+i.value); row.append(i);
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=v; i.value=v; };
} else if(s.t==='check'){
const i=document.createElement('input'); i.type='checkbox'; i.checked=!!n.p[s.n];
i.addEventListener('change',()=>n.p[s.n]=i.checked); row.append(i);
(n.set||(n.set={}))[s.n]=v=>{ n.p[s.n]=!!v; i.checked=!!v; };
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
if(n.folded){                                      // свёрнутый узел: слева входы, справа выходы
const w=n.el.offsetWidth||n.size.w;
return {x:n.x+(dir==='o'?w:0), y:n.y+14};
}
// .pin ищем один раз на элемент и кэшируем на нём же — иначе querySelector дважды на каждый провод
// на каждой перерисовке (порты не пересоздаются иначе как через rebuildNode, который даёт новый el).
const pin=el._pinEl || (el._pinEl = el.querySelector('.pin')||el);
let px=0,e=pin;
while(e &&e!==n.el){ px+=e.offsetLeft; e=e.offsetParent; }   // x — от пина, transform его не сдвигает
let py=0; e=el;
while(e &&e!==n.el){ py+=e.offsetTop; e=e.offsetParent; }    // y — от .port: пин центрируется в нём CSS-transform'ом
const r=pin.offsetHeight/2;
const cx = dir==='o' ? px+pin.offsetWidth-r  : px+r;
return {x:n.x+cx, y:n.y+py+el.offsetHeight/2};
}
function drawWires(){
if(typeof panelMode!=='undefined'  && panelMode) return;
// Сначала все чтения геометрии (portPos читает offsetLeft/offsetParent — это layout reads),
// и только потом все записи атрибута d. Если чередовать чтение и запись по одному проводу за раз,
// браузер вынужден на каждой итерации форсировать синхронный reflow, чтобы отдать актуальный offset.
wires.style.transform=content.style.transform ;        // держим в синхроне на каждый вызов, а не только по panzoomchange
wiresFront.style.transform=content.style.transform;
const jobs=[];
for(const e of Graph.edges){
const a= Graph.map[e.from], b=Graph.map[e.to]; if(!a||!b) continue;
const p1=portPos(a,a.ports.o[e.fp],'o'), p2=portPos(b,b.ports.i[e.tp],'i');
jobs.push([e,curve(p1,p2)]);
}
for(const [e,d ] of jobs){
e.path.setAttribute('d',d); e.hit.setAttribute('d',d);
if(e.hoverClone) e.hoverClone.setAttribute('d',d);
}
}
function curve(p1,p2){
const dx=Math.max(40,Math.abs(p2.x-p1.x)*.5);
return  `M${p1.x+8000},${p1.y+8000} C${p1.x+dx+8000},${p1.y+8000} ${p2.x-dx+8000},${p2.y+8000} ${p2.x+8000},${p2.y+8000}` ;
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
function syncSel(){ for(const n of Graph.nodes) n.el.classList.toggle('sel',Sel.has(n.id)); }
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
stat.textContent='скопировано узлов: '+clip.nodes.length;
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
if(nd.w){ nn.size.w=nd.w; nn.size.h=nd.h||nn.size.h; applySize(nn); }
Sel.add(nn.id); }
for(const e of data.edges)
if(map[e.from] &&map[e.to]) addEdge(map[e.from],e.fp,map[e.to],e.tp);
pasting=false; syncSel(); markWiresDirty(); Undo.push();
}
/* ---- взаимодействие (мышь + тач) ---- */
let link=null, zCounter=1, activeInteractions=0;
const cv=document.getElementById('canvas');
const TOUCH=matchMedia('(pointer:coarse)').matches;
function toCanvas(ev){ const r=cv.getBoundingClientRect();
return {x:(ev.clientX-r.left+cv.scrollLeft)/view.k-view.x,
y:(ev.clientY-r.top +cv.scrollTop)/view.k-view.y}; }
/* ---- пан/зум/пинч канваса — отдан Panzoom, узлы (.panzoom-exclude) им не трогаются ---- */
let panzooming=false;
const panzoom=Panzoom(content,{canvas:true,maxScale:2.5,minScale:.25,step:.1,excludeClass:'panzoom-exclude'});
content.addEventListener('panzoomstart',()=>{ panzooming=true; cv.classList.add('grab'); });
content.addEventListener('panzoomend',  ()=>{ panzooming=false; cv.classList.remove('grab'); });
content.addEventListener('panzoomchange',ev=>{
view.x=ev.detail.x; view.y=ev.detail.y; view.k=ev.detail.scale;
wires.style.transform=content.style.transform; wiresFront.style.transform=content.style.transform;
syncGridBg(); });
function syncGridBg(){                                // точки фона двигаются и масштабируются вместе с холстом
cv.style.backgroundSize=(24*view.k)+'px '+(24*view.k)+'px';
cv.style.backgroundPosition=(view.x*view.k)+'px '+(view.y*view.k)+'px';
}
cv.addEventListener('wheel',panzoom.zoomWithWheel,{passive:false});
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
applyView();
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
interact(headEl).draggable({ ignoreFrom:'.x,.cl', listeners:{
start(ev){ if(panelMode){ ev.interaction.stop(); return; }
if(!Sel.has(n.id)) selSet(n.id,ev.shiftKey);
const group=[...Sel].map(id=>Graph.map[id]).filter(Boolean);
group.forEach(g=>g.el.style.zIndex=++zCounter);
n.__x0=n.x; n.__y0=n.y;                        // абсолютный отсчёт от старта — без накопления ошибки округления
n.__grp=group.map(g=>({g,ox:g.x-n.x,oy:g.y-n.y})); n.__moved=false; activeInteractions++; },
move(ev){ if(panelMode) return;
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
start(ev){ if(panelMode){ ev.interaction.stop(); return; }
n.__rw=n.size.w; n.__rh=n.size.h; activeInteractions++; },
move(ev){ if(panelMode) return;
n.size.w=clamp(Math.round(n.__rw+(ev.clientX-ev.clientX0)/view.k),160,1400);
n.size.h=clamp(Math.round(n.__rh+(ev.clientY-ev.clientY0)/view.k),40,2000);
applySize(n); drawWires(); },
end(){ activeInteractions--; Undo.push(); }
}});
}
function startLink(ev,n,port,dir){ if(panelMode) return;
ev.preventDefault(); ev.stopPropagation();
if(pending){                                       // второй тап завершает связь
if(pending.dir!==dir){
if(pending.dir==='o') addEdge(pending.n.id,pending.port,n.id,port);
else addEdge(n.id,port,pending.n.id,pending.port);
stat.textContent='связь создана'; }
clearPending(); return; }
const el=dir==='o'?n.ports.o[port]:n.ports.i[port]; el.classList.add('lit');
link={n,port,dir,el,x0:ev.clientX,y0:ev.clientY};
const t=document.createElementNS('http://www.w3.org/2000/svg','path');
t.setAttribute('fill','none'); t.setAttribute('stroke','var(--acc)');
t.setAttribute('stroke-dasharray','4 3'); t.setAttribute('stroke-width','1.5');
wires.append(t); link.tmp=t; }
let pending=null;
function clearPending(){ if(pending){ pending.el.classList.remove('lit'); pending=null; } }
function cancelLink(){ if(!link) return;
if(link.el!==(pending &&pending.el)) link.el.classList.remove('lit');
link.tmp.remove(); link=null; }
function dropLink(ev){                              // порт определяем по точке отпускания
if(!link)  return;
const moved=Math.hypot(ev.clientX-link.x0,ev.clientY-link.y0);
const el=document.elementFromPoint(ev.clientX,ev.clientY)?.closest?.('.port,.mpin');
if(el  && el.dataset.dir  && el.dataset.dir!==link.dir){
if(link.dir==='o') addEdge(link.n.id,link.port,el.dataset.node,el.dataset.port);
else addEdge(el.dataset.node,el.dataset.port,link.n.id,link.port);
clearPending();
} else if(moved <8){                                // это был тап — ждём второй
clearPending();
pending={n:link.n,port:link.port,dir:link.dir,el:link.el};
link.el.classList.add('lit');
stat.textContent='выбран порт '+link.port+' — коснитесь второго';
}
cancelLink();
}
cv.addEventListener('pointerdown',ev=>{
if(panelMode) return;
if(ev.target===cv||ev.target===content){
if(!ev.shiftKey &&Sel.size){ Sel.clear(); syncSel(); }
clearPending(); }
},true);                                              // capture — отработать раньше Panzoom
window.addEventListener('pointermove',ev=>{
if(panelMode) return;
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
function fitView(){                                 // вписать весь патч в экран
flush();                                            // ← синхронизируем граф перед замерами offsetWidth/Height
if(!Graph.nodes.length) return;
const r=cv.getBoundingClientRect(), pad=24;
let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
for(const n of Graph.nodes){ x0=Math.min(x0,n.x); y0=Math.min(y0,n.y);
x1=Math.max(x1,n.x+n.el.offsetWidth); y1=Math.max(y1,n.y+n.el.offsetHeight); }
const sx=Math.max(1,x1-x0), sy=Math.max(1,y1-y0);
if(r.width<50||r.height<50) return;
const k=clamp(Math.min((r.width-pad*2)/sx,(r.height-pad*2)/sy),.25,1.2);
view.k=k; view.x=(pad+(r.width-pad*2-sx*k)/2)/k-x0;
view.y=(pad+(r.height-pad*2-sy*k)/2)/k-y0; applyView();
}
// На старте некоторые узлы (кодовые поля, канвасы) досчитывают свой реальный размер
// на следующих кадрах — из-за этого fitView сразу после deserialize мерил их «сжатыми»,
// а потом лейаут менялся и патч визуально «уезжал». Меряем после двух rAF, когда всё устаканилось.
function fitViewWhenReady(){
requestAnimationFrame(()=>requestAnimationFrame(fitView));
}
document.getElementById('fit').onclick=fitView;
let panelMode=false;
function markPanel(){                                // прибор = узел, которому есть что показать
for(const n of Graph.nodes){
const d=MOD[n.type];
const show  = d.view||d.readout||d.swatch||(d.params||[]).some(p=>p.t==='button');
n.el.classList.toggle('hidden', panelMode  && !show);
}
}
function setPanel(on){
panelMode=on;
cv.classList.toggle('panel',on);
document.getElementById('panel').classList.toggle('on',on);
document.getElementById('fit').disabled=on;
for(const n of Graph.nodes) n.el.style.width = on? '' : n.size.w+'px';
markPanel();
if(!on){ cv.scrollTop=0; cv.scrollLeft=0;
for(const n of Graph.nodes) applySize(n); markWiresDirty(); }
}
document.getElementById('panel').onclick=()=>setPanel(!panelMode);
document.getElementById('undo').onclick=()=>Undo.undo();
document.getElementById('redo').onclick=()=>Undo.redo();
document.getElementById('dup').onclick=()=>{ copySel(); pasteData(clip,30,30); };
document.getElementById('turbo').onchange=e=>{
Eng.turbo=+e.target.value;
stat.textContent = Eng.turbo >1? 'прогон ×'+Eng.turbo+' — звук искажён' : 'реальное время'; };
document.getElementById('blk').onchange=async e=>{
const v=+e.target.value;
stat.textContent='размер блока '+v+', движок перезапускается';
await Eng.setBlock(v);
stat.textContent='размер блока '+v+' · входы нужно включить заново '; };
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
document.getElementById('menu').onclick=()=>{
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
const toastEl=document.getElementById('toast');
let toastTimer=null;
function showToast(text){                            // короткое уведомление поверх канваса
toastEl.textContent=text; toastEl.classList.add('show');
clearTimeout(toastTimer);
toastTimer=setTimeout(()=>toastEl.classList.remove('show'),1300);
}
function makeCatItem(m){
const b=document.createElement('button'); b.className='pitem'; b.draggable=true;
b.innerHTML= `<span class="ptxt"><b>${m.title}</b><span class="prow"><i>${m.id}</i>${ioDots(m)}</span></span>` ;
b.addEventListener('click',()=>{
const r=cv.getBoundingClientRect();
addNode(m.id,(r.width/2)/view.k-view.x-100+Math.random()*50,
(r.height/3)/view.k-view.y+Math.random()*120);
markWiresDirty();
if(isCoarse) showToast('добавлено: '+m.title);  // панель остаётся открытой — можно накидать несколько подряд
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
return !q ||  `${m.title} ${m.id} ${m.cat}`.toLocaleLowerCase('ru').includes(q);
});
if(!list.length) continue;
const det=makeDetails(c,c.toUpperCase(),q?true:openCats.has(c));      // при поиске раскрыто всегда
det.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="cnt">${list.length}</span>` );
for(const m of list){ matches++; det.append(makeCatItem(m)); }
pal.append(det);
}
if(Object.values(MOD).some(m=>m.legacy)){
const t=document.createElement('button'); t.className='pitem';
t.innerHTML=' <b>'+(showLegacy?'скрыть':'показать')+' устаревшие </b>';
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
addNode(modId,p.x-100,p.y-20); markWiresDirty(); Undo.push();
});
const paletteSearch=document.getElementById('paletteSearch');
paletteSearch.addEventListener('input',e=>{ paletteQuery=e.target.value; buildPalette(); });
document.getElementById('paletteClear').addEventListener('click',()=>{
paletteSearch.value=''; paletteQuery=''; buildPalette(); paletteSearch.focus(); });
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
w:n.size.w,h:n.size.h,p:{...n.p},f:n.folded?1:0};
return o; }),
edges:Graph.edges.map(e=>({from:e.from,fp:e.fp,to:e.to,tp:e.tp}))};
}
const MIGRATE={                                     // старые узлы → их замена
water:   {type:'sa', ports:{fsel:'f1'}},
spectrum:{type:'sa', ports:{fsel:'f1', lsel:'l1'}},
sa:      {type:'sa', ports:{fsel:'f1'}},
gate:    {type:'thresh', ports:{in:'num', out:'num'}},
slice:   {type:'thresh', ports:{in:'sig', out:'sig'}}
};
function migrate(o){
const map={};
for(const n of o.nodes){
const m=MIGRATE[n.type];
if(m){ map[n.id]=m; n.type=m.type; continue; }
// 'mic' успел дважды сменить форму (mic/mic2 → один узел с выбором канала → оба канала сразу
// одним узлом с двумя выходами) — старые сохранения отличаем по отсутствию devA и досаживаем.
if((n.type==='mic'||n.type==='mic2') && (!n.p || n.p.devA===undefined)){
const old=n.p||{}, oldSlot = n.type==='mic2' || old.slot==='B' ? 1 : 0;
map[n.id]={type:'mic', ports:{out: oldSlot===0?'a':'b'}};
n.type='mic';
n.p={devA: oldSlot===0?(old.dev||'по умолчанию'):'по умолчанию', gainA: oldSlot===0?(old.gain??1):1,
     devB: oldSlot===1?(old.dev||'по умолчанию'):'по умолчанию', gainB: oldSlot===1?(old.gain??1):1,
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
if(nn &&n.f) foldNode(nn,true);
if(nn &&n.w){ nn.size.w=n.w; nn.size.h=n.h||nn.size.h; applySize(nn); }
max=Math.max(max,+String(n.id).slice(1)||0); }
Graph.seq=max+1;
for(const e of o.edges) addEdge(e.from,e.fp,e.to,e.tp);
if(o.view){ Object.assign(view,o.view); applyView(); }
markWiresDirty();
if(panelMode) setPanel(true);
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
Graph.nodes=[]; Graph.edges=[]; Graph.map={}; Graph.seq=1;
}
document.getElementById('save').onclick=()=>
dl(new Blob([JSON.stringify(serialize(),null,1)],{type:'application/json'}),'patch.json');
document.getElementById('load').onclick=()=>document.getElementById('fpick').click();
document.getElementById('fpick').onchange=e=>{ const f=e.target.files[0]; if(!f) return;
const r=new FileReader(); r.onload=()=>{ try{ stashIfDirty(); deserialize(JSON.parse(r.result)); fitViewWhenReady(); graphDirty=false; }catch(err){ alert('Файл не читается: '+err.message); } };
r.readAsText(f); e.target.value=''; };
document.getElementById('clear').onclick=()=>{
stashIfDirty();
clearAll(); markWiresDirty(); currentPatchName=''; buildPatchList(); graphDirty=false;
};
// Обычная очистка кэша браузера чистит HTTP-кэш, но не localStorage/IndexedDB —
// поэтому пресеты и патчи «не удаляются». Эта кнопка стирает именно данные сайта.
document.getElementById('wipe').onclick=async()=>{
if(!confirm('Стереть все пресеты, патчи и локальные данные приложения на этом сайте?')) return;
try{ localStorage.clear(); }catch(e){}
try{
const names=indexedDB.databases ? (await indexedDB.databases()).map(d=>d.name) : ['dsp-samples','dsp-lists'];
await Promise.all(names.filter(Boolean).map(n=>new Promise(res=>{
const rq=indexedDB.deleteDatabase(n); rq.onsuccess=rq.onerror=rq.onblocked=res; })));
}catch(e){}
try{ if('caches' in window) for(const k of await caches.keys()) await caches.delete(k); }catch(e){}
try{ if(navigator.serviceWorker) for(const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); }catch(e){}
location.href=location.pathname+'?_='+Date.now();
};
// Автосейв раньше сериализовал весь граф по таймеру каждые 4с, даже если ничего не менялось —
// на холостом ходу это лишняя нагрузка. Теперь сохраняем с задержкой после реального изменения.
let autosaveTimer=null;
function scheduleAutosave(){
clearTimeout(autosaveTimer);
autosaveTimer=setTimeout(()=>LS.set(AKEY,JSON.stringify(serialize())),2000);
}
window.addEventListener('beforeunload',()=>{ clearTimeout(autosaveTimer); LS.set(AKEY,JSON.stringify(serialize())); });
const runBtn=document.getElementById('run'), stat=document.getElementById('stat');
// Общая точка синхронизации кнопки — дергается и по клику, и из движка (например, когда
// узел микрофона сам стартует/резюмирует контекст в обход этой кнопки).
function syncRunBtn(){
const on=Eng.running&&!Eng.paused;
runBtn.textContent = on?'■':'▶';
runBtn.classList.toggle('on',on);
}
Eng.onRunChange=syncRunBtn;
runBtn.onclick=async()=>{
const on=await Eng.toggle();
if(!on){ stat.textContent='пауза'; stat.classList.remove('warn','crit'); }
};
const srSel=document.getElementById('sr');
if(srSel) srSel.onchange=async e=>{
const v=+e.target.value||null;
stat.textContent=(v?'частота '+v+' Гц':'частота по умолчанию')+', движок перезапускается';
await Eng.setSampleRate(v);
for(const n of Graph.nodes) rebuildNode(n);   // границы ползунков вида max:()=>Eng.sr/2 — освежить
stat.textContent='частота '+Eng.sr+' Гц · входы нужно включить заново';
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
let lastStatText='';
function visible(n,r){                              // узел в пределах экрана?
const x=(n.x+view.x)*view.k, y=(n.y+view.y)*view.k;
const w=n.el.offsetWidth*view.k, h=n.el.offsetHeight*view.k;
return x+w >-40  && x <r.width+40  && y+h >-40  && y <r.height+40;
}
function frame(ts){
const minDt = TOUCH?33:16;                        // на тач-экранах хватает 30 к/с
if(ts-lastDraw >=minDt  && !activeInteractions  && !panzooming){
lastDraw=ts;
const r=cv.getBoundingClientRect();
// сначала все чтения layout-свойств (visible() читает offsetWidth/offsetHeight) одним
// проходом, потом все d.draw() — иначе чередование чтение/запись на каждом узле даёт
// forced reflow на КАЖДОЙ итерации вместо одного пересчёта layout за весь кадр.
const toDraw=[];
for(const n of Graph.nodes){
const d=MOD[n.type];
if(!d.draw) continue;
if(!d.always  && !visible(n,r)) continue;
toDraw.push(n);
}
for(const n of toDraw){
const d=MOD[n.type];
try{ d.draw(n,n.cv,n.cx); }
catch(e){ if(!n.drawErr){ n.drawErr=1; console.error('draw '+n.type+':',e); } }
}
if(Eng.running &&!Eng.paused){
// пишем в DOM только если строка реально изменилась — иначе rAF (до 60 к/с) переписывает
// textContent даже на кадрах, где Eng.tick() ещё не успел отработать заново
const load=Math.round(Eng.load*100);
const statText= `${Eng.sr} Гц · блок ${BLOCK}` +(Eng.turbo >1? `· ×${Eng.turbo}` :'')+
`· ${Eng.t.toFixed(2)} мс · нагрузка ${load}% · узлов ${Graph.nodes.length}`;
if(statText!==lastStatText){ stat.textContent=statText; lastStatText=statText; }
// предупреждение имеет смысл только в реальном времени — при turbo>1 движок нарочно бежит быстрее звука
stat.classList.toggle('warn', Eng.turbo===1 &&Eng.load>=.85 &&Eng.load<1);
stat.classList.toggle('crit', Eng.turbo===1 &&Eng.load>=1);
}
}
requestAnimationFrame(frame);
}
applyView();
(function boot(){
buildBuiltinPresets();
const a=LS.get(AKEY)||LS.get('dsp-patch');
if(a){ try{ deserialize(JSON.parse(a)); }catch(e){ buildDemo(); } } else buildDemo();
fitViewWhenReady();                                 // сразу видно весь патч, а не дефолтный центр холста
Undo.stack=[]; Undo.idx=-1; Undo.push();
graphDirty=false;                                   // старт приложения — не пользовательское изменение
currentPatchName='';
})();
// Совместимость со старым сохранённым DOM: в нём могли остаться нативные range-поля.
document.querySelectorAll('#content input[type="range"]').forEach(old=>{
const i=document.createElement('input'); i.type='number';
for(const a of ['min','max','step','value']) if(old.hasAttribute(a)) i.setAttribute(a,old.getAttribute(a));
i.title='Стрелки ↑↓ или колесо мыши — изменить значение';
old.replaceWith(i);
});
requestAnimationFrame(frame);

