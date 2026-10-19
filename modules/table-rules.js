"use strict";
/* ============================ Table: правила полей ============================
   Схема списка (types / card, см. table-cards.js) дополняется:
   types[c] = {t:'auto'}                    автонумерация: следующее число, счётчик в card.seq[c]
   types[c] = {t:'calc', expr, mat}         вычисляемое поле; mat — значение хранится в базе (иначе считается при загрузке)
   types[c].def / .req                      значение по умолчанию и обязательность
   card.unique = [[колонки], …]             уникальность по набору полей (пустая часть набора — не участвует, как NULL в SQL)
   Выражения: свои, без eval (CSP): числа, 'строки', [Поле], + - * / %, сравнения, && || !, ?:, функции TR_FN. */

/* ---------- выражения ---------- */
const trNum=v=>typeof v==='number' ? v : typeof v==='string' && v.trim()!=='' ? Number(v) : NaN;
const trTrue=v=>v!=='' && v!=null && v!==false && trNum(v)!==0;
const TR_FN={
  round:(x,d=0)=>{ const k=Math.pow(10,trNum(d)||0), v=trNum(x); return isFinite(v) ? Math.round(v*k)/k : ''; },
  floor:x=>isFinite(trNum(x)) ? Math.floor(trNum(x)) : '', ceil:x=>isFinite(trNum(x)) ? Math.ceil(trNum(x)) : '',
  abs:x=>isFinite(trNum(x)) ? Math.abs(trNum(x)) : '', sqrt:x=>trNum(x)>=0 ? Math.sqrt(trNum(x)) : '',
  pow:(a,b)=>{ const v=Math.pow(trNum(a),trNum(b)); return isFinite(v) ? v : ''; },
  min:(...a)=>{ const v=a.map(trNum).filter(isFinite); return v.length ? Math.min(...v) : ''; },
  max:(...a)=>{ const v=a.map(trNum).filter(isFinite); return v.length ? Math.max(...v) : ''; },
  if:(c,a,b)=>trTrue(c) ? a : b,
  coalesce:(...a)=>a.find(v=>v!=='' && v!=null) ?? '',
  concat:(...a)=>a.map(v=>v??'').join(''),
  upper:s=>String(s??'').toUpperCase(), lower:s=>String(s??'').toLowerCase(), trim:s=>String(s??'').trim(),
  len:s=>String(s??'').length,
  substr:(s,from,len)=>{ s=String(s??''); const f=Math.max(0,trNum(from)-1||0); return len==null ? s.slice(f) : s.substr(f,trNum(len)); },
  contains:(s,x)=>String(s??'').toLowerCase().includes(String(x??'').toLowerCase()) ? 1 : 0,
  num:x=>isFinite(trNum(x)) ? trNum(x) : '', text:x=>String(x??''),
  now:()=>Date.now(),
  year:t=>{ const d=new Date(trNum(t)||t); return isNaN(d) ? '' : d.getFullYear(); },
  month:t=>{ const d=new Date(trNum(t)||t); return isNaN(d) ? '' : d.getMonth()+1; },
  day:t=>{ const d=new Date(trNum(t)||t); return isNaN(d) ? '' : d.getDate(); },
};
const TR_PREC=[['||'],['&&'],['==','!='],['<','<=','>','>='],['+','-'],['*','/','%']];
const trArith=f=>(a,b)=>{ const x=trNum(a), y=trNum(b); if(!isFinite(x) || !isFinite(y)) return ''; const v=f(x,y); return isFinite(v) ? v : ''; };
const trCmp=f=>(a,b)=>{ const x=trNum(a), y=trNum(b); return (isFinite(x) && isFinite(y) ? f(x,y) : f(String(a??''),String(b??''))) ? 1 : 0; };
const TR_OPS={
  '||':(a,b)=>trTrue(a) || trTrue(b) ? 1 : 0, '&&':(a,b)=>trTrue(a) && trTrue(b) ? 1 : 0,
  '==':trCmp((a,b)=>a===b), '!=':trCmp((a,b)=>a!==b), '<':trCmp((a,b)=>a<b), '<=':trCmp((a,b)=>a<=b), '>':trCmp((a,b)=>a>b), '>=':trCmp((a,b)=>a>=b),
  '+':(a,b)=>{ const x=trNum(a), y=trNum(b); return isFinite(x) && isFinite(y) ? x+y : String(a??'')+String(b??''); },
  '-':trArith((a,b)=>a-b), '*':trArith((a,b)=>a*b), '/':trArith((a,b)=>a/b), '%':trArith((a,b)=>a%b) };
const trRef=(r,c)=>Object.hasOwn(r,c) ? r[c] ?? '' : '';
const TR_CACHE=new Map();
// → функция row => значение; ошибка разбора — исключение
function trCompile(src){
  src=String(src||'');
  let f=TR_CACHE.get(src); if(f) return f;
  const T=src.match(/\[[^\]]+\]|'[^']*'|"[^"]*"|\d+\.?\d*(?:e[-+]?\d+)?|[A-Za-z_][\w.]*|<=|>=|==|!=|&&|\|\||[-+*\/%!<>?:(),]|\S/gi)||[];
  let i=0;
  const prim=()=>{
    const t=T[i++];
    if(t===undefined) throw new Error('expression ended early');
    if(t==='('){ const v=top(); if(T[i++]!==')') throw new Error('missing )'); return v; }
    if(t[0]==='[') { const c=t.slice(1,-1).trim(); return r=>trRef(r,c); }
    if(t[0]==="'" || t[0]==='"'){ const s=t.slice(1,-1); return ()=>s; }
    if(/^\d/.test(t)){ const v=Number(t); return ()=>v; }
    if(/^[A-Za-z_]/.test(t)){
      if(T[i]==='('){
        i++; const fn=Object.hasOwn(TR_FN,t.toLowerCase()) ? TR_FN[t.toLowerCase()] : null; if(!fn) throw new Error('unknown function '+t);
        const args=[];
        if(T[i]===')') i++; else for(;;){ args.push(top()); const s=T[i++]; if(s===')') break; if(s!==',') throw new Error('expected , or ) in '+t+'()'); }
        return r=>fn(...args.map(a=>a(r)));
      }
      return r=>trRef(r,t);
    }
    throw new Error('unexpected "'+t+'"');
  };
  const un=()=>{
    const t=T[i];
    if(t==='-'){ i++; const a=un(); return r=>{ const v=trNum(a(r)); return isFinite(v) ? -v : ''; }; }
    if(t==='!'){ i++; const a=un(); return r=>trTrue(a(r)) ? 0 : 1; }
    return prim();
  };
  const bin=l=>{
    if(l>=TR_PREC.length) return un();
    let a=bin(l+1);
    while(TR_PREC[l].includes(T[i])){ const fn=TR_OPS[T[i++]], x=a, y=bin(l+1); a=r=>fn(x(r),y(r)); }
    return a;
  };
  const top=()=>{
    const c=bin(0);
    if(T[i]==='?'){ i++; const a=top(); if(T[i++]!==':') throw new Error('missing :'); const b=top(); return r=>trTrue(c(r)) ? a(r) : b(r); }
    return c;
  };
  if(!T.length) throw new Error('empty expression');
  f=top();
  if(i<T.length) throw new Error('extra "'+T[i]+'"');
  if(TR_CACHE.size>500) TR_CACHE.clear();
  TR_CACHE.set(src,f);
  return f;
}

/* ---------- вычисляемые поля ---------- */
const trCalcCols=n=>n.cl.filter(c=>tcDef(n,c).t==='calc');
// считаются при загрузке и не лежат в базе; mat-поля хранятся
const trVirtual=n=>new Set(trCalcCols(n).filter(c=>!tcDef(n,c).mat));
// значения вычисляемых полей строки на месте; два прохода — поле может ссылаться на соседнее вычисляемое; ошибки → n.calcErr
function trCalcRow(n,row,cols=trCalcCols(n)){
  for(let pass=0;pass<2;pass++) for(const c of cols){
    try{ const v=trCompile(tcDef(n,c).expr)(row); row[c]=v===undefined || (typeof v==='number' && !isFinite(v)) ? '' : v; delete n.calcErr?.[c]; }
    catch(e){ (n.calcErr||(n.calcErr={}))[c]=e.message; row[c]=''; }
  }
}
// после загрузки: все вычисляемые; mat-поля с готовым значением остаются как были
function trCalcAll(n){
  n.virt=trVirtual(n); n.calcErr={};
  const all=trCalcCols(n); if(!all.length) return;
  for(const row of n.all) trCalcRow(n,row,all.filter(c=>n.virt.has(c) || row[c]==='' || row[c]==null));
}
// пересчёт и запись (mat-поля попадают в базу)
async function trRecalc(n){
  if(tblRO(n)) return;
  n.virt=trVirtual(n);
  for(const c of trAutoCols(n)){                           // пустым строкам — номера по порядку
    let m=trNextAuto(n,c,[])-1;
    for(const row of n.all) if(row[c]==='' || row[c]==null) row[c]=++m;
    (n.schema.card.seq||(n.schema.card.seq={}))[c]=m;
  }
  await trSeqSave(n);
  for(const row of n.all) trCalcRow(n,row);
  if(tblKind(n.p.list)==='db') for(let k=0;k<n.all.length;k++){ const it=tblToItem(n.all[k],n.cl,n.virt); await ListDB.update(n.ids[k],{name:it.name,fields:it.fields,value:it.fields.value??''}); }
  else await tblSave(n);
  tblDerive(n);
}

/* ---------- автонумерация ---------- */
const trAutoCols=n=>n.cl.filter(c=>tcDef(n,c).t==='auto');
async function trSeqSave(n){
  if(tblKind(n.p.list)==='db') await tblMetaSet(n.p.list,{card:n.schema.card});
  else if(tblKind(n.p.list)==='patch') n.p.schema={types:n.schema.types,card:n.schema.card};
}
// следующий номер: счётчик не откатывается при удалении записей
function trNextAuto(n,c,used){
  const seq=n.schema.card.seq||(n.schema.card.seq={});
  let m=+seq[c]||0;
  for(const r of n.all){ const v=trNum(r[c]); if(isFinite(v) && v>m) m=v; }
  for(const v of used) if(v>m) m=v;
  return m+1;
}

/* ---------- ограничения ---------- */
const trUniqueSets=n=>(n.schema?.card?.unique||[]).map(s=>s.filter(c=>n.cl.includes(c))).filter(s=>s.length);
const trKeyOf=(row,cols)=>{ const p=cols.map(c=>String(row[c]??'').trim().toLowerCase()); return p.some(x=>x==='') ? null : p.join('\u0001'); };
// записи перед записью: умолчания (только новым), номера, вычисляемые; проверка обязательных и уникальных.
// except — индекс строки в n.all, которую правят. → {ok:[…], bad:[{rec,why}]}
function trPrepare(n,recs,except=-1,adding=true){
  const ok=[], bad=[], auto=trAutoCols(n), calc=trCalcCols(n), uniq=trUniqueSets(n);
  const sets=[...auto.map(c=>[c]),...uniq];
  const seen=sets.map(()=>new Set());
  sets.forEach((cols,s)=>{ n.all.forEach((r,k)=>{ if(k===except) return; const key=trKeyOf(r,cols); if(key!=null) seen[s].add(key); }); });
  const used=new Map(auto.map(c=>[c,[]]));
  let bumped=false;
  for(const r of recs){
    const o={...r};
    for(const c of n.cl){ const d=tcDef(n,c); if(d.def!=null && d.def!=='' && adding && (o[c]===''||o[c]==null) && d.t!=='auto' && d.t!=='calc') o[c]=d.t==='num' && isFinite(+d.def) ? +d.def : d.def; }
    for(const c of auto){
      if(o[c]!=='' && o[c]!=null && isFinite(trNum(o[c]))) used.get(c).push(trNum(o[c]));
    }
    for(const c of auto) if(o[c]==='' || o[c]==null || !isFinite(trNum(o[c]))){
      const v=trNextAuto(n,c,used.get(c)); o[c]=v; used.get(c).push(v); bumped=true;
    }
    if(calc.length) trCalcRow(n,o,calc);
    let why='';
    for(const c of n.cl){ const d=tcDef(n,c); if(d.req && d.t!=='auto' && d.t!=='calc' && (o[c]===''||o[c]==null)){ why='"'+c+'" is required'; break; } }
    if(!why) for(let s=0;s<sets.length;s++){
      const key=trKeyOf(o,sets[s]); if(key==null) continue;
      if(seen[s].has(key)){ why='duplicate '+sets[s].map(c=>c+' = '+o[c]).join(', '); break; }
    }
    if(why){ bad.push({rec:r,why}); continue; }
    sets.forEach((cols,s)=>{ const key=trKeyOf(o,cols); if(key!=null) seen[s].add(key); });
    ok.push(o);
  }
  if(bumped){
    const seq=n.schema.card.seq||(n.schema.card.seq={});
    for(const c of auto) seq[c]=Math.max(+seq[c]||0,...used.get(c));
    trSeqSave(n);
  }
  return {ok,bad};
}

/* ---------- настройка из панели ---------- */
// «Имя, Фамилия; Телефон» → [[…],[…]] по существующим колонкам
const trParseUnique=(n,text)=>String(text||'').split(';').map(g=>g.split(',').map(x=>x.trim()).filter(c=>n.cl.includes(c))).filter(g=>g.length);
// сколько строк уже нарушают наборы (для предупреждения при включении)
function trDupes(n,sets){
  let bad=0;
  for(const cols of sets){
    const seen=new Set();
    for(const r of n.all){ const k=trKeyOf(r,cols); if(k==null) continue; if(seen.has(k)) bad++; else seen.add(k); }
  }
  return bad;
}
// колонка переименована: ссылки на неё в выражении следуют за ней
function trRenameRef(expr,from,to){
  const esc=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  let out=String(expr).split('['+from+']').join('['+to+']');
  if(/^[A-Za-z_][\w.]*$/.test(from)) out=out.replace(new RegExp('(?<![\\w.\\[\'"])'+esc+'(?![\\w(\\]\'"])','g'),to);
  return out;
}
