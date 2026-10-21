"use strict";
/* ============================ Object Detect: ядро ============================
   Без DOM: пересечение рамок, фильтр классов, трекинг по IoU, подписи. Сама сеть (COCO-SSD) — в objdet.js.
   Проверяется tools/test-objdet.mjs. Рамка: {x,y,w,h}; детекция: {label,score,x,y,w,h} (доли кадра 0…1). */

function odIou(a,b){
  const x0=Math.max(a.x,b.x), y0=Math.max(a.y,b.y), x1=Math.min(a.x+a.w,b.x+b.w), y1=Math.min(a.y+a.h,b.y+b.h);
  const i=Math.max(0,x1-x0)*Math.max(0,y1-y0), u=a.w*a.h+b.w*b.h-i;
  return u>0 ? i/u : 0;
}
// "person, car" → Set; пустая строка — любой класс (null)
function odClasses(s){
  const l=String(s||'').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return l.length ? new Set(l) : null;
}
function odFilter(dets,set){ return set ? dets.filter(d=>set.has(d.label.toLowerCase())) : dets; }
// COCO-SSD {bbox:[x,y,w,h] в пикселях, class, score} → доли кадра
function odNorm(preds,W,H){
  return preds.map(p=>({label:p.class,score:p.score,x:p.bbox[0]/W,y:p.bbox[1]/H,w:p.bbox[2]/W,h:p.bbox[3]/H}));
}
/* Трекинг: жадное сопоставление по IoU среди одного класса. st={tracks:[],nextId:1,total:0}; t — секунды.
   Каждой детекции ставится id и age (сколько секунд трек живёт). Трек без детекции живёт maxAge секунд.
   Возвращает число новых треков. */
function odTrack(st,dets,t,opt={}){
  const thr=opt.iou ?? .3, maxAge=opt.maxAge ?? 1.5;
  const pairs=[];
  st.tracks.forEach((tr,i)=>dets.forEach((d,j)=>{ if(tr.label===d.label){ const v=odIou(tr,d); if(v>=thr) pairs.push([v,i,j]); } }));
  pairs.sort((a,b)=>b[0]-a[0]);
  const ut=new Set(), ud=new Set();
  for(const [,i,j] of pairs){
    if(ut.has(i)||ud.has(j)) continue;
    ut.add(i); ud.add(j);
    const tr=st.tracks[i], d=dets[j];
    tr.x=d.x; tr.y=d.y; tr.w=d.w; tr.h=d.h; tr.last=t; tr.hits++;
    d.id=tr.id; d.age=t-tr.t0;
  }
  let born=0;
  dets.forEach((d,j)=>{
    if(ud.has(j)) return;
    const tr={id:st.nextId++,label:d.label,x:d.x,y:d.y,w:d.w,h:d.h,t0:t,last:t,hits:1};
    st.tracks.push(tr); st.total++; born++;
    d.id=tr.id; d.age=0;
  });
  st.tracks=st.tracks.filter(tr=>t-tr.last<=maxAge);
  return born;
}
const odNewTracker=()=>({tracks:[],nextId:1,total:0});
// "2× person, car"
function odSummary(dets){
  const c=new Map(); for(const d of dets) c.set(d.label,(c.get(d.label)||0)+1);
  return [...c].sort((a,b)=>b[1]-a[1]).map(([l,n])=>n>1 ? n+'× '+l : l).join(', ');
}
function odText(dets){
  return dets.map(d=>(d.id!=null ? '#'+d.id+' ' : '')+d.label+' '+Math.round(d.score*100)+'%').join('\n');
}
// цвет рамки по классу — один и тот же при каждом запуске
function odColor(label){
  let h=0; for(let i=0;i<label.length;i++) h=(h*31+label.charCodeAt(i))>>>0;
  return 'hsl('+(h%360)+',85%,55%)';
}
