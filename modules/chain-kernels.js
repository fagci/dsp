"use strict";
/* ============================ Emmet-цепочки палитры (Ctrl+K) ============================
   usb>(dac,sa,iqshift>iqdec>demod>digvo>mbe>dac) — «>» ведёт дальше, «( , )» — ветви от одного узла, «>…» в начале — от выделенного.
   Здесь только разбор и раскладка (без DOM) — tools/test-chain.mjs; узлы и провода строит core-graph.js (cmdkPreview). */

const CHAIN_MAX=40;                                  // не больше стольких модулей за раз (защита от случайной «простыни»)

// строка → {cont, ast}; ast: {k:'seq',items:[…]} | {k:'grp',branches:[seq,…]} | {k:'mod',seg}. Незакрытые скобки закрываются сами, лишние «)» игнорируются.
function chainParse(str){
  const s=String(str||''); let i=0, cnt=0;
  const cont=/^\s*>/.test(s); if(cont) i=s.indexOf('>')+1;
  const name=()=>{ let j=i; while(j<s.length && !'>,()'.includes(s[j])) j++; const t=s.slice(i,j).trim(); i=j; return t; };
  const seq=depth=>{
    const items=[];
    for(;;){
      while(i<s.length && /\s/.test(s[i])) i++;
      if(i>=s.length) break;
      const c=s[i];
      if(c==='('){ i++; items.push(grp(depth+1)); }
      else if(c==='>'){ i++; }                       // «a>>b», «a>» — лишнее игнорируем
      else if(c===','||c===')') break;
      else { const t=name(); if(t && ++cnt<=CHAIN_MAX) items.push({k:'mod',seg:t}); }
    }
    return {k:'seq',items};
  };
  const grp=depth=>{
    const branches=[];
    for(;;){
      branches.push(seq(depth));
      if(s[i]===','){ i++; continue; }
      if(s[i]===')'){ i++; break; }
      break;                                          // конец строки
    }
    return {k:'grp',branches:branches.filter(b=>b.items.length)};
  };
  const top=grp(0);                                   // верхний уровень тоже допускает запятую: «mic>fft, usb>sa»
  while(i<s.length){ if(s[i]===')') i++; else { const g=grp(0); top.branches.push(...g.branches); } }   // хвост после лишней «)»
  const ast=top.branches.length===1 ? top.branches[0] : top.branches.length ? top : {k:'seq',items:[]};
  return {cont,ast};
}

// find(seg) → модуль или null. Дописывает в каждый лист .m и обрезает непрерывный префикс:
// после первого несовпавшего листа в последовательности ничего не строим. Возвращает {empty, complete}.
function chainResolve(a,find){
  if(a.k==='mod'){ a.m=find(a.seg)||null; return {empty:!a.m, complete:!!a.m}; }
  if(a.k==='seq'){
    let complete=true, any=false; const keep=[];
    for(const it of a.items){
      const r=chainResolve(it,find);
      if(!r.empty){ keep.push(it); any=true; }
      if(!r.complete){ complete=false; break; }
    }
    a.items=keep; return {empty:!any, complete};
  }
  let complete=true; const keep=[];
  for(const b of a.branches){ const r=chainResolve(b,find); if(!r.empty) keep.push(b); if(!r.complete) complete=false; }
  a.branches=keep; return {empty:!keep.length, complete};
}

// все листья-модули по порядку
function chainLeaves(a,out=[]){
  if(a.k==='mod') out.push(a);
  else if(a.k==='seq') a.items.forEach(x=>chainLeaves(x,out));
  else a.branches.forEach(x=>chainLeaves(x,out));
  return out;
}

// раскладка: каждому листу — col (по ходу цепочки) и row (ветви друг под другом)
function chainLayout(a,col=0,row=0){
  if(a.k==='mod'){ a.col=col; a.row=row; return {w:1,h:1}; }
  if(a.k==='seq'){ let c=col, h=1; for(const it of a.items){ const r=chainLayout(it,c,row); c+=r.w; h=Math.max(h,r.h); } return {w:c-col,h}; }
  let r0=row, w=0; for(const b of a.branches){ const r=chainLayout(b,col,r0); r0+=r.h; w=Math.max(w,r.w); }
  return {w,h:Math.max(1,r0-row)};
}

// провода: connect(fromLeaf,toLeaf) для каждого стыка «хвосты предыдущего → головы следующего». prev — листья, из которых идём (например, выделенный узел).
function chainEdges(a,prev,connect){
  if(a.k==='mod'){ for(const p of prev) connect(p,a); return {heads:[a],tails:[a]}; }
  if(a.k==='seq'){
    let tails=prev, heads=null;
    for(const it of a.items){ const r=chainEdges(it,tails,connect); if(!heads) heads=r.heads; tails=r.tails; }
    return {heads:heads||[],tails};
  }
  const heads=[], tails=[];
  for(const b of a.branches){ const r=chainEdges(b,prev,connect); heads.push(...r.heads); tails.push(...r.tails); }
  return {heads,tails};
}

// подпись для строки подсказки: «USB SDR → ( Audio | Spectrum Analyzer )»
function chainText(a,label){
  if(a.k==='mod') return label(a);
  if(a.k==='seq') return a.items.map(x=>chainText(x,label)).join(' → ');
  return '( '+a.branches.map(x=>chainText(x,label)).join(' | ')+' )';
}

// y листьев по настоящей высоте узлов: ветви друг под другом без пустот (а не по самой высокой строке всей цепочки).
// size(лист) → {w,h}; возвращает высоту поддерева.
function chainPlaceY(a,size,gap,y=0){
  if(a.k==='mod'){ a.y=y; return size(a).h; }
  if(a.k==='seq'){ let h=0; for(const it of a.items) h=Math.max(h,chainPlaceY(it,size,gap,y)); return h; }
  let acc=0; for(const b of a.branches){ acc+=chainPlaceY(b,size,gap,y+acc)+gap; }
  return Math.max(0,acc-gap);
}

/* ============================ «Упорядочить граф» ============================
   Слоистая раскладка: слой = самый длинный путь от источника (циклы разрываются), порядок в слое — по среднему положению соседей,
   слои центруются по высоте; узлы без проводов — рядами под графом. nodes: [{id,x,y,w,h}], edges: [{from,to}] → {id:{x,y}}. */
function arrangeLayout(nodes,edges,opt){
  const gx=opt?.gapX??70, gy=opt?.gapY??28;
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const succ=new Map(nodes.map(n=>[n.id,new Set()])), pred=new Map(nodes.map(n=>[n.id,new Set()]));
  for(const e of edges){ if(e.from===e.to||!byId.has(e.from)||!byId.has(e.to)) continue; succ.get(e.from).add(e.to); pred.get(e.to).add(e.from); }
  const linked=nodes.filter(n=>succ.get(n.id).size||pred.get(n.id).size), loose=nodes.filter(n=>!succ.get(n.id).size&&!pred.get(n.id).size);
  const order0=[...linked].sort((a,b)=>a.y-b.y||a.x-b.x), rank=new Map(order0.map((n,i)=>[n.id,i]));
  // слои: глубина от источников; DFS с цветами — обратные рёбра (цикл) пропускаем
  const depth=new Map(), state=new Map();
  const dfs=id=>{
    if(depth.has(id)) return depth.get(id);
    state.set(id,1); let d=0;
    for(const p of [...pred.get(id)].sort((a,b)=>rank.get(a)-rank.get(b))){ if(state.get(p)===1) continue; d=Math.max(d,dfs(p)+1); }
    state.set(id,2); depth.set(id,d); return d;
  };
  for(const n of order0) dfs(n.id);
  const L=[]; for(const n of order0){ const d=depth.get(n.id); (L[d]||(L[d]=[])).push(n); }
  const layers=L.filter(Boolean);
  const pos=new Map(); const reindex=()=>layers.forEach(l=>l.forEach((n,i)=>pos.set(n.id,i)));
  reindex();
  const sweep=(ls,nb)=>{ for(const l of ls){
    const key=n=>{ const s=[...nb.get(n.id)].filter(i=>pos.has(i)); return s.length ? s.reduce((t,i)=>t+pos.get(i),0)/s.length : pos.get(n.id); };
    const k=new Map(l.map(n=>[n.id,key(n)])); l.sort((a,b)=>k.get(a.id)-k.get(b.id)||pos.get(a.id)-pos.get(b.id)); reindex(); } };
  for(let it=0;it<4;it++){ sweep(layers,pred); sweep([...layers].reverse(),succ); }
  const ox=Math.min(...nodes.map(n=>n.x)), oy=Math.min(...nodes.map(n=>n.y)), out={};
  let x=ox, totalH=0, totalW=0;
  const heights=layers.map(l=>l.reduce((t,n)=>t+n.h,0)+gy*(l.length-1)), maxH=Math.max(0,...heights);
  layers.forEach((l,i)=>{
    let y=oy+(maxH-heights[i])/2; const w=Math.max(...l.map(n=>n.w));
    for(const n of l){ out[n.id]={x:x+(w-n.w)/2*0,y}; y+=n.h+gy; }
    x+=w+gx;
  });
  totalW=layers.length ? x-gx-ox : 0; totalH=maxH;
  // одиночки — рядами под графом, перенос по ширине графа (не уже 1200)
  const wrap=Math.max(1200,totalW); let cx=ox, cy=oy+totalH+(layers.length?60:0), rowH=0;
  for(const n of [...loose].sort((a,b)=>a.y-b.y||a.x-b.x)){
    if(cx>ox && cx+n.w>ox+wrap){ cx=ox; cy+=rowH+gy; rowH=0; }
    out[n.id]={x:cx,y:cy}; cx+=n.w+gx; rowH=Math.max(rowH,n.h);
  }
  return out;
}
