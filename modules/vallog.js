"use strict";
/* ============================ VALUE LOG ============================ */
// Числа a–d раз в period секунд (или по фронту trig, или кнопкой) → запись rec: t (мс) и значения под именами names.
// Хранит запись Table: rec → rec таблицы (key там — upsert, а не новая строка).

const vlNames=n=>String(n.p.names||'').split(',').map(s=>s.trim());
function vlRow(n,I){
  const names=vlNames(n), r={t:Date.now()};
  let any=false;
  ['a','b','c','d'].forEach((k,i)=>{ if(typeof I[k]==='number' && isFinite(I[k])){ r[names[i]||k]=I[k]; any=true; } });
  return any ? r : null;
}
def({ id:'vallog', title:'Value Log', cat:'Output', kw:'log csv record sample table numbers timestamp bookmark',
  ins:[{n:'a',t:'num'},{n:'b',t:'num'},{n:'c',t:'num'},{n:'d',t:'num'},{n:'trig',t:'val'}],
  outs:[{n:'rec',t:'rec'},{n:'count',t:'num'}],
  readout:true,
  params:[
    {n:'period',t:'range',min:0,max:60,step:.05,d:1,label:'period, s (0 = trig / button only)'},
    {n:'names',t:'text',d:'a,b,c,d',label:'columns'},
    {n:'capture',t:'button',label:'Add row now',fn:n=>{ n.go=true; }},
  ],
  init:n=>{ n.t=0; n.go=false; n.trigPrev=0; n.count=0; n.last=null; },
  process(n,I){
    const dt=BLOCK/Eng.sr, per=+n.p.period||0;
    const trig=typeof I.trig==='number' ? I.trig : 0, edge=trig>0.5 && n.trigPrev<=0.5;
    n.trigPrev=trig;
    let due=n.go || edge;
    n.go=false;
    if(per>0){ n.t+=dt; if(n.t>=Math.max(.05,per)){ n.t=0; due=true; } }
    const r=due ? vlRow(n,I) : null;
    if(r){ n.count++; n.last=r; }
    return {rec:r ? [r] : null, count:n.count};
  },
  draw(n){
    const el=n.el.querySelector('.readout'); if(!el) return;
    const t=n.count+' rows'+(n.last ? ' · '+Object.keys(n.last).filter(k=>k!=='t').map(k=>k+' '+recFmt(n.last[k])).join(', ') : '');
    if(el.textContent!==t) el.textContent=t;
  }
});
