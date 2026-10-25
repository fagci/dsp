"use strict";
/* ============================ Table: загрузка индексов для lookup() / between() ============================
   Расчёт вычисляемых полей синхронный, а список читается из ListDB асинхронно — поэтому индекс строится заранее:
   luPrepare(n) разбирает выражения вычисляемых полей узла (trCompile собирает deps — списки и колонки из литералов), грузит недостающие индексы
   постранично (ListDB.each — звук SDR не рвётся на большом справочнике). Индексы общие для всех узлов и живут, пока список не изменился
   (LU.touched из ListDB). Изменился справочник — узлы, которые на него опираются, перечитываются (с паузой, поток записей их не дёргает).
   Источник — любой список Table: свой, «Reference/…» (modules/reflists.js), встроенный presets/…, @patch этого узла. */

const TBL_LU=new Set();                                  // узлы с lookup() в вычисляемых полях

// имя списка из выражения → настоящее: полное, без регистра, либо последнее звено пути, если оно одно такое
async function luResolve(name){
  if(tblKind(name)!=='db') return name;
  const names=await ListDB.listNames();
  if(names.includes(name)) return name;
  let c=names.filter(x=>luSame(name,x));
  if(c.length>1) throw new Error('list name "'+name+'" is ambiguous: '+c.slice(0,3).join(', '));
  return c.length ? c[0] : name;
}
async function luLoadOne(n,k,d){
  try{
    const name=await luResolve(d.list), ix=luIndex(d.mode), cols=d.mode==='range' ? [d.c1,d.c2] : [d.c1], have=new Set(['name']);
    let total=0, found=0;
    const feed=(r,f)=>{
      total++; if(cols.every(c=>c in f)) found++;
      if(d.mode==='range') ix.add(f[d.c1],f[d.c2],f); else ix.add(f[d.c1],f);
    };
    if(tblKind(name)==='db'){
      const meta=await ListDB.getMeta(name);
      if(!meta && !(await ListDB.listNames()).includes(name)) throw new Error('list "'+d.list+'" not found — download it in Files → ⇩ offline, or create it');
      for(const c of meta?.cols||[]) have.add(c);
      await ListDB.each(name,it=>{
        const f=it.fields||{}; if(it.name && f.name===undefined) f.name=it.name;     // имя записи — колонка name
        for(const c in f) have.add(c);
        feed(it,f);
      },2000);
    } else {
      const t=await tblReadList(n,name);
      for(const c of t.cols) have.add(c);
      for(const r of t.rows) feed(r,r);
    }
    for(const c of cols) if(!have.has(c) && !(total && found)) throw new Error('no column "'+c+'" in list "'+name+'"');
    ix.done();
    LU.set(k,ix,name,have);
  }catch(e){ LU.fail(k,e.message||String(e)); }
}
function luLoad(n,k,d){
  if(LU.get(k)) return null;
  let p=LU.busy.get(k);
  if(!p){ p=luLoadOne(n,k,d).finally(()=>LU.busy.delete(k)); LU.busy.set(k,p); }
  return p;
}
// перед расчётом вычисляемых полей узла: все нужные индексы готовы (нет списка — lookup() вернёт ошибку в calcErr, а не пустоту)
async function luPrepare(n){
  const need=new Map();
  for(const c of trCalcCols(n)){
    let f; try{ f=trCompile(tcDef(n,c).expr); }catch(e){ continue; }              // ошибку разбора покажет сам расчёт
    for(const d of f.deps||[]) need.set(LU.key(d.list,d.mode,d.c1,d.c2),d);
  }
  if(need.size) TBL_LU.add(n); else TBL_LU.delete(n);
  await Promise.all([...need].map(([k,d])=>luLoad(n,k,d)));
  n.luDeps=[...need].map(([k,d])=>LU.get(k)?.list||d.list);
}

// справочник изменился: опирающиеся на него узлы пересчитываются
let luTimer=0;
const luPending=new Set();
LU.watch.add((list,gone)=>{
  for(const n of TBL_LU){
    if(n.disposed){ TBL_LU.delete(n); continue; }
    if((n.luDeps||[]).some(d=>gone.includes(d) || (list!=null && (d===list || luSame(d,list))))) luPending.add(n);
  }
  if(!luPending.size) return;
  clearTimeout(luTimer);
  luTimer=setTimeout(()=>{ const a=[...luPending]; luPending.clear(); for(const n of a) if(!n.disposed && !n.loading && n.loaded===n.p.list) tblLoad(n).catch(()=>{}); },700);
});
