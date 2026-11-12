"use strict";
/* ============================ Подписи строк параметров ============================
   Чистая логика без DOM: что написать в строке «подпись — значение» узла (core-graph.js, renderParamRows).
   Длинная подпись укорачивается, полный текст остаётся в подсказке (на тач-экране — долгое нажатие на строку).
   Проверка: node tools/test-rowlabel.mjs. */
// длинная подпись → короткое имя (без скобок и пояснения после «:» / « — »)
function shortLabel(t){
  let s=t.replace(/\s*\([^)]*\)/g,'');
  const i=s.search(/:\s/); if(i>3) s=s.slice(0,i);
  const j=s.indexOf(' — '); if(j>3) s=s.slice(0,j);
  s=s.replace(/[\s,…]+$/,'');
  return s||t;
}
// «alarm: time» в секции «Alarm» — имя секции уже сказано заголовком: префикс до «: » убираем, если он совпадает с одним из слов заголовка
function rowLabelNoGroup(label,group){
  if(!group) return label;
  const m=/^([^:]{2,28}):\s+(\S.*)$/.exec(label); if(!m) return label;
  const norm=s=>s.toLowerCase().replace(/[^a-zа-я0-9]+/gi,' ').trim();
  const pre=norm(m[1]), parts=norm(group.replace(/[\/·&,]/g,'|')).split('|').map(s=>s.trim()).filter(Boolean);
  const stem=(a,b)=>{ let k=0; while(k<a.length && k<b.length && a[k]===b[k]) k++; return k; };
  // целое слово заголовка: «alarm» = «Alarm», «notification» ~ «Notify», «SMS list / contacts» ~ «SMS / contacts»
  const hit=parts.some(g=>{ const k=stem(pre,g); return k>=Math.min(5,g.length) && (k===g.length || k===pre.length || k>=5); });
  return hit ? m[2] : label;
}
// params — строки одного блока (секции); → [{text, unit, full, more}] в том же порядке:
// text — подпись, unit — единица из хвоста («, Hz») тусклым после значения, full — полный текст, more — есть что показать сверх подписи
function paramRowLabels(params,group){
  const UNIT=/^(.+?),\s*([^\s,]{1,8})$/;
  const rows=params.map(p=>{
    const full=String(p.label||p.n), base=rowLabelNoGroup(full,group);
    return {p, full, base, text:p.short ? String(p.short) : base.length>24 ? shortLabel(base) : base, unit:''};
  });
  // хвост полной подписи после короткой части — чем различать одинаковые короткие
  const tail=r=>{ let t=r.base.startsWith(r.text) ? r.base.slice(r.text.length) : r.base;
    t=t.replace(/\s*\([^)]*\)/g,'').replace(/^[\s:—,;.·-]+/,''); const w=t.split(/\s+/).filter(Boolean); let o='';
    for(const x of w){ if((o+' '+x).length>22) break; o+=(o?' ':'')+x; } return o.replace(/[\s,:;—-]+$/,''); };
  for(const r of rows) if(['range','range2','num'].includes(r.p.t)){ const um=UNIT.exec(r.text); if(um){ r.text=um[1]; r.unit=um[2]; } }
  const by=new Map(); for(const r of rows){ const k=r.text.toLowerCase(); (by.get(k)||by.set(k,[]).get(k)).push(r); }
  for(const g of by.values()){
    if(g.length<2) continue;
    const units=g.map(r=>r.unit);
    if(units.every(Boolean) && new Set(units).size===g.length){ for(const r of g){ r.text+=', '+r.unit; r.unit=''; } continue; }   // «range, Hz» и «range, dB»
    const used=new Set();
    for(const r of g){
      if(r.p.short){ used.add(r.text.toLowerCase()); continue; }
      const t=tail(r); let x=t ? r.text+' · '+t : r.unit ? r.text+', '+r.unit : r.text;
      if(!t && r.unit) r.unit='';
      if(used.has(x.toLowerCase())) x=r.text+' · '+r.p.n;
      used.add(x.toLowerCase()); r.text=x;
    }
  }
  return rows.map(r=>({text:r.text, unit:r.unit, full:r.full, more:!!r.p.tip || r.full!==(r.unit ? r.text+', '+r.unit : r.text)}));
}
