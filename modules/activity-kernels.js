"use strict";
/* ============================ Activity Events: занятость каналов → события с длительностью ============================
   actNew() → состояние; actStep(st,lv,now,o) → события, завершившиеся в этом кадре.
   lv — уровни каналов, дБ (null — канал в этом кадре не наблюдался: развёртка SDR); now — мс.
   x = уровень − общий уровень полосы (нижняя треть каналов за кадр; o.common): подъём или спад всей «полки» (АРУ, широкополосный шум)
   вычитается и каналы не срабатывают разом. x сглаживается за o.avg мс.
   Пол канала — следящая нижняя квантиль x (вверх шагает на q·s, вниз на (1−q)·s, s = o.rise дБ/с): шум обходится, а слабый
   сигнал, который занимает меньшую часть времени, пол не поднимает; пока канал занят, пол замирает. Первые o.learn мс пол учится в 8 раз быстрее.
   Занят: x − пол ≥ o.thr; свободен: < o.thr − o.hys дольше o.hold мс (дыры короче склеиваются). Событие короче o.minDur — отбрасывается.
   Событие: {ch,t0,dur,peak,avg,snr}; t0 и now — в одной шкале, dur — мс (последний занятый кадр + период кадра), snr — максимум x − пол.
   Проверка: node tools/test-activity.mjs */

const ACT_Q=.3;
function actNew(){ return {ch:[],t0:null,last:null,fi:50,m:0}; }

function actRef(lv,st){                                   // общий уровень полосы: нижняя треть наблюдаемых каналов
  const a=lv.filter(v=>v!=null && isFinite(v)).sort((x,y)=>x-y);
  if(a.length<4) return st.m;
  return st.m=a[Math.floor((a.length-1)*.33)];
}

function actStep(st,lv,now,o){
  if(st.t0==null) st.t0=now;
  const dt=st.last==null ? 0 : (now-st.last)/1000;
  if(st.last!=null && now>st.last) st.fi=st.fi*.9+Math.min(1000,now-st.last)*.1;
  st.last=now;
  const learning=now-st.t0<o.learn, out=[], m=o.common ? actRef(lv,st) : 0, al=o.avg>0 && dt>0 ? Math.min(1,dt*1000/o.avg) : 1;
  const s=o.rise*dt*(learning ? 8 : 1);
  for(let k=0;k<lv.length;k++){
    const L=lv[k]; if(L==null || !isFinite(L)) continue;
    const c=st.ch[k] || (st.ch[k]={floor:null,on:false,x:null});
    const raw=L-m;
    c.x=c.x==null ? raw : c.x+(raw-c.x)*al;
    if(c.floor==null) c.floor=c.x;
    const d=c.x-c.floor;
    if(!c.on){
      if(!learning && d>=o.thr){ c.on=true; c.t0=now; c.tl=now; c.peak=L; c.sum=L; c.n=1; c.dmax=d; }
      else c.floor+=c.x>c.floor ? s*ACT_Q : -s*(1-ACT_Q);
    } else if(d>=o.thr-o.hys){ c.tl=now; if(L>c.peak) c.peak=L; if(d>c.dmax) c.dmax=d; c.sum+=L; c.n++; }
    else if(now-c.tl>=o.hold){
      c.on=false;
      const dur=c.tl-c.t0+st.fi;
      if(dur>=o.minDur) out.push({ch:k,t0:c.t0,dur,peak:c.peak,avg:c.sum/c.n,snr:c.dmax});
    }
  }
  return out;
}
const actActive=st=>st.ch.reduce((n,c)=>n+(c && c.on ? 1 : 0),0);
