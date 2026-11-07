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
