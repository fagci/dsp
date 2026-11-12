"use strict";
/* ============================ Emmet-цепочки палитры (Ctrl+K) ============================
   usb>(dac,sa,iqshift>iqdec>demod>digvo>mbe>dac) — «>» ведёт дальше, «( , )» — ветви от одного узла, «>…» в начале — от выделенного.
   После имени модуля: «[A>B, A<B]» — какие пины соединить с ПРЕДЫДУЩИМ модулем (A — пин предыдущего, B — этого; «>» — из A в B, «<» — из B в A:
   sa[spec>spec2, freq<f1] — spec предыдущего → spec2 у sa, а f1 у sa → freq предыдущего), «{k:v, …}» — параметры (433.9M, 2.4M, 100k — с приставками),
   «*» — точка выхода chunk-а (без неё выходы — хвосты цепочки). Chunk — сохранённая цепочка с именем: «mysdr = rtlsdr*>sa[spec>spec,freq<f1]{sr:2.4M}»,
   дальше «mysdr>demod» раскрывает её на месте. Здесь только разбор, раскладка и сериализация (без DOM) — tools/test-chain.mjs; узлы и провода строит core-graph.js (cmdkPreview). */

const CHAIN_MAX=40;                                  // не больше стольких модулей за раз (защита от случайной «простыни»)

// «spec>spec2, freq<f1» → {pins:[{from,to,dir}], bad:[строки без стрелки]}; from — пин предыдущего модуля, to — пин этого
function chainPinsParse(body){
  const pins=[], bad=[];
  for(const it of String(body||'').split(',')){
    const t=it.trim(); if(!t) continue;
    const m=/^([^<>]+?)\s*([<>])\s*([^<>]+)$/.exec(t);
    if(m) pins.push({from:m[1].trim(),to:m[3].trim(),dir:m[2]}); else bad.push(t);
  }
  return {pins,bad};
}
// «sr:2.4M, freq:433.9M, mode:'FM', on:true» → {sr:2400000, freq:433900000, mode:'FM', on:true}; k=v тоже можно
function chainValue(v){
  v=String(v).trim();
  if(/^(true|false)$/i.test(v)) return v.toLowerCase()==='true';
  let m=/^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)([kMG]?)$/.exec(v);
  if(m) return +m[1]*(m[2]==='k'?1e3:m[2]==='M'?1e6:m[2]==='G'?1e9:1);
  m=/^(["'])(.*)\1$/.exec(v); return m ? m[2] : v;
}
function chainParamsParse(body){
  const out={}, b=String(body||''); let a=0, q='';
  const items=[];
  for(let i=0;i<=b.length;i++){ const ch=b[i]; if(q){ if(ch===q) q=''; } else if(ch==='"'||ch==="'") q=ch; else if(ch===','||i===b.length){ items.push(b.slice(a,i)); a=i+1; } }
  for(const it of items){ const m=/^\s*([\w.-]+)\s*[:=]\s*(.*?)\s*$/.exec(it); if(m) out[m[1]]=chainValue(m[2]); }
  return out;
}
// значение → текст для {…}: числа как есть, строки в кавычках, если не «слово»
function chainValueText(v){
  if(typeof v==='boolean') return v ? 'true' : 'false';
  if(typeof v==='number') return String(v);
  const t=String(v); return /^[\w.\-]+$/.test(t) && !/^-?\d/.test(t) && !/^(true|false)$/i.test(t) ? t : "'"+t.replace(/'/g,'')+"'";
}

// строка → {cont, ast}; ast: {k:'seq',items:[…]} | {k:'grp',branches:[seq,…]} | {k:'mod',seg}. Незакрытые скобки закрываются сами, лишние «)» игнорируются.
function chainParse(str){
  const s=String(str||''); let i=0, cnt=0;
  const cont=/^\s*>/.test(s); if(cont) i=s.indexOf('>')+1;
  const name=()=>{ let j=i; while(j<s.length && !'>,()[{*'.includes(s[j])) j++; const t=s.slice(i,j).trim(); i=j; return t; };
  const until=(open,close)=>{                          // содержимое скобок до парной (кавычки внутри не считаются); незакрытая — до конца строки
    const a=++i; let q='';
    while(i<s.length){ const ch=s[i]; if(q){ if(ch===q) q=''; } else if(ch==='"'||ch==="'") q=ch; else if(ch===close) break; i++; }
    const body=s.slice(a,i); if(s[i]===close) i++; return body;
  };
  const seq=depth=>{
    const items=[];
    for(;;){
      while(i<s.length && /\s/.test(s[i])) i++;
      if(i>=s.length) break;
      const c=s[i];
      if(c==='('){ i++; items.push(grp(depth+1)); }
      else if(c==='>'){ i++; }                       // «a>>b», «a>» — лишнее игнорируем
      else if(c===','||c===')') break;
      else {
        const t=name(); let mark=false, pins=[], params=null, bad=[];
        for(;;){                                       // суффиксы: * [пины] {параметры} в любом порядке
          while(i<s.length && /\s/.test(s[i])) i++;
          if(s[i]==='*'){ mark=true; i++; }
          else if(s[i]==='['){ const r=chainPinsParse(until('[',']')); pins=pins.concat(r.pins); bad=bad.concat(r.bad); }
          else if(s[i]==='{'){ params=Object.assign(params||{},chainParamsParse(until('{','}'))); }
          else break;
        }
        if(t && ++cnt<=CHAIN_MAX) items.push({k:'mod',seg:t,pins,params,mark,bad});
      }
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
  if(a.k==='chunk') return chainResolve(a.ast,find);
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
  if(a.k==='chunk') chainLeaves(a.ast,out);
  else if(a.k==='mod') out.push(a);
  else if(a.k==='seq') a.items.forEach(x=>chainLeaves(x,out));
  else a.branches.forEach(x=>chainLeaves(x,out));
  return out;
}

// раскладка: каждому листу — col (по ходу цепочки) и row (ветви друг под другом)
function chainLayout(a,col=0,row=0){
  if(a.k==='chunk') return chainLayout(a.ast,col,row);
  if(a.k==='mod'){ a.col=col; a.row=row; return {w:1,h:1}; }
  if(a.k==='seq'){ let c=col, h=1; for(const it of a.items){ const r=chainLayout(it,c,row); c+=r.w; h=Math.max(h,r.h); } return {w:c-col,h}; }
  let r0=row, w=0; for(const b of a.branches){ const r=chainLayout(b,col,r0); r0+=r.h; w=Math.max(w,r.w); }
  return {w,h:Math.max(1,r0-row)};
}

// провода: connect(fromLeaf,toLeaf) для каждого стыка «хвосты предыдущего → головы следующего». prev — листья, из которых идём (например, выделенный узел).
function chainEdges(a,prev,connect){
  if(a.k==='chunk'){                                   // chunk: входы — как у его цепочки (пины на самом chunk-е важнее), выход — листья с «*», иначе хвосты
    const mine=a.pins&&a.pins.length ? a.pins : null, from=new Set(prev);
    const r=chainEdges(a.ast,prev,(f,t,pins)=>connect(f,t,from.has(f)&&mine ? mine : pins));
    const marked=chainLeaves(a.ast).filter(l=>l.mark);
    return {heads:r.heads,tails:marked.length ? marked : r.tails};
  }
  if(a.k==='mod'){ for(const p of prev) connect(p,a,a.pins); return {heads:[a],tails:[a]}; }
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
  if(a.k==='chunk') return a.name+' ['+chainText(a.ast,label)+']';
  if(a.k==='mod') return label(a);
  if(a.k==='seq') return a.items.map(x=>chainText(x,label)).join(' → ');
  return '( '+a.branches.map(x=>chainText(x,label)).join(' | ')+' )';
}

// y листьев по настоящей высоте узлов: ветви друг под другом без пустот (а не по самой высокой строке всей цепочки).
// size(лист) → {w,h}; возвращает высоту поддерева.
function chainPlaceY(a,size,gap,y=0){
  if(a.k==='chunk') return chainPlaceY(a.ast,size,gap,y);
  if(a.k==='mod'){ a.y=y; return size(a).h; }
  if(a.k==='seq'){ let h=0; for(const it of a.items) h=Math.max(h,chainPlaceY(it,size,gap,y)); return h; }
  let acc=0; for(const b of a.branches){ acc+=chainPlaceY(b,size,gap,y+acc)+gap; }
  return Math.max(0,acc-gap);
}

/* ============================ chunk-и: имена цепочек ============================ */
// get(имя в нижнем регистре) → строка цепочки или null. Лист с именем chunk-а заменяется его разобранной цепочкой (до 4 уровней, без петель).
function chainExpand(a,get,depth=0,stack=[]){
  if(a.k==='mod'){
    const key=a.seg.trim().toLowerCase(), def=depth<4 && !stack.includes(key) ? get(key) : null;
    if(!def) return a;
    const sub=chainParse(def);
    return {k:'chunk', name:a.seg.trim(), ast:chainExpand(sub.ast,get,depth+1,[...stack,key]), pins:a.pins||[], params:a.params, mark:a.mark};
  }
  if(a.k==='seq') return {k:'seq',items:a.items.map(x=>chainExpand(x,get,depth,stack))};
  if(a.k==='grp') return {k:'grp',branches:a.branches.map(x=>chainExpand(x,get,depth,stack))};
  return a;
}
// «имя = цепочка» → {name, src}; без «=» или с пустым именем — null. Имя: буквы, цифры, _ - . и пробелы внутри
function chainDefSplit(str){
  const m=/^\s*([^=<>()\[\]{},*]+?)\s*=\s*(.*)$/s.exec(String(str||''));
  return m && m[1].trim() ? {name:m[1].trim(), src:m[2].trim()} : null;
}
// нечёткое имя пина: точное → по началу → по вхождению (без регистра); из pins [{n,t}], ok(p) — подходит ли (направление/тип). → пин или null
function chainFindPin(pins,name,ok){
  const q=String(name||'').trim().toLowerCase(); if(!q) return null;
  const c=(pins||[]).filter(p=>!ok||ok(p));
  return c.find(p=>p.n.toLowerCase()===q) || c.find(p=>p.n.toLowerCase().startsWith(q)) || c.find(p=>p.n.toLowerCase().includes(q)) || null;
}

/* Выделение → строка цепочки. nodes: [{id,type,x,y,params}] (params — только то, что отличается от умолчаний),
   edges: [{from,fp,to,tp}] внутри выделения; opt.auto(fromId,toId) → [fp,tp] — какую пару выберет автоподбор (тогда пины не пишем),
   opt.isSource(type) — модуль без входов (его помечаем «*»: выход chunk-а — источник), opt.id(type) → то, что пишем как имя.
   Дерево строим обходом от корней (узлов без входящих проводов, слева направо); провод туда-обратно между соседями — пины,
   остальные (слияния, «через узел») в цепочке не выразить — они в lost. → {text, lost:[{from,to}], nodes} */
function chainFromGraph(nodes,edges,opt){
  const o=opt||{}, byId=new Map(nodes.map(n=>[n.id,n])), inc=new Map(nodes.map(n=>[n.id,[]])), out=new Map(nodes.map(n=>[n.id,[]]));
  for(const e of edges){ if(!byId.has(e.from)||!byId.has(e.to)||e.from===e.to) continue; out.get(e.from).push(e); inc.get(e.to).push(e); }
  const pos=n=>n.x*1e4+n.y;
  const roots=nodes.filter(n=>!inc.get(n.id).length).sort((a,b)=>pos(a)-pos(b));
  const seen=new Set(), kids=new Map(nodes.map(n=>[n.id,[]])), used=new Set(), rootsUsed=[];
  const dfs=n=>{                                       // дерево — по направлению проводов; кто успел первым, тот и родитель (слияния потом в lost)
    seen.add(n.id);
    for(const c of [...new Set(out.get(n.id).map(e=>e.to))].map(i=>byId.get(i)).sort((a,b)=>pos(a)-pos(b))){
      if(seen.has(c.id)) continue;
      kids.get(n.id).push(c); dfs(c);
    }
  };
  for(const r of roots){ rootsUsed.push(r); dfs(r); }
  for(const n of nodes.slice().sort((a,b)=>pos(a)-pos(b))) if(!seen.has(n.id)){ rootsUsed.push(n); dfs(n); }   // остатки: циклы без корня — с самого левого
  const tok=(n,parent)=>{
    let t=o.id ? o.id(n.type) : n.type;
    if(!parent && o.isSource && o.isSource(n.type) && kids.get(n.id).length) t+='*';     // выход chunk-а — источник (SDR), а не конец цепочки
    if(parent){
      const fw=edges.filter(e=>e.from===parent.id&&e.to===n.id), bk=edges.filter(e=>e.from===n.id&&e.to===parent.id);
      for(const e of fw.concat(bk)) used.add(e);
      const auto=o.auto ? o.auto(parent.id,n.id) : null;
      const same=fw.length===1 && !bk.length && auto && auto[0]===fw[0].fp && auto[1]===fw[0].tp;     // автоподбор и так выберет эту пару
      if(!same) t+='['+fw.map(e=>e.fp+'>'+e.tp).concat(bk.map(e=>e.tp+'<'+e.fp)).join(', ')+']';     // вперёд: пин родителя > пин этого; назад: пин родителя < пин этого
    }
    if(n.params){ const ks=Object.keys(n.params); if(ks.length) t+='{'+ks.map(k=>k+':'+chainValueText(n.params[k])).join(',')+'}'; }
    return t;
  };
  const ser=(n,parent)=>{
    const ks=kids.get(n.id), head=tok(n,parent);
    if(!ks.length) return head;
    return head+'>'+(ks.length===1 ? ser(ks[0],n) : '('+ks.map(k=>ser(k,n)).join(',')+')');
  };
  const text=rootsUsed.map(r=>ser(r,null)).join(',');
  const lost=edges.filter(e=>byId.has(e.from)&&byId.has(e.to)&&e.from!==e.to&&!used.has(e)).map(e=>({from:e.from,to:e.to,fp:e.fp,tp:e.tp}));
  return {text,lost,nodes:nodes.length};
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
