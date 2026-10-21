"use strict";
/* ============================ Activity Events: занятость каналов → события с длительностью ============================
   actNew() → состояние; actStep(st,lv,now,o) → события, завершившиеся в этом кадре.
   lv — уровни каналов, дБ (null — канал в этом кадре не наблюдался: развёртка SDR); now — мс.
   Пол шума канала: падает сразу, к уровню растёт не быстрее o.rise дБ/с и замирает, пока канал занят; первые o.learn мс только учим пол.
   Занят: уровень − пол ≥ o.thr; свободен: < o.thr − o.hys дольше o.hold мс (дыры короче склеиваются). Событие короче o.minDur — отбрасывается.
   Событие: {ch,t0,dur,peak,avg,snr}; t0 и now — в одной шкале, dur — мс (последний занятый кадр + период кадра).
   Проверка: node tools/test-activity.mjs */

function actNew(){ return {ch:[],t0:null,last:null,fi:50}; }

function actStep(st,lv,now,o){
  if(st.t0==null) st.t0=now;
  const dt=st.last==null ? 0 : (now-st.last)/1000;
  if(st.last!=null && now>st.last) st.fi=st.fi*.9+Math.min(1000,now-st.last)*.1;
  st.last=now;
  const learning=now-st.t0<o.learn, out=[];
  for(let k=0;k<lv.length;k++){
    const L=lv[k]; if(L==null || !isFinite(L)) continue;
    const c=st.ch[k] || (st.ch[k]={floor:null,on:false});
    if(c.floor==null || L<c.floor) c.floor=L;
    const d=L-c.floor;
    if(!c.on){
      if(!learning && d>=o.thr){ c.on=true; c.t0=now; c.tl=now; c.peak=L; c.sum=L; c.n=1; }
      else if(d<o.thr) c.floor=Math.min(L,c.floor+o.rise*dt);
    } else if(d>=o.thr-o.hys){ c.tl=now; if(L>c.peak) c.peak=L; c.sum+=L; c.n++; }
    else if(now-c.tl>=o.hold){
      c.on=false;
      const dur=c.tl-c.t0+st.fi;
      if(dur>=o.minDur) out.push({ch:k,t0:c.t0,dur,peak:c.peak,avg:c.sum/c.n,snr:c.peak-c.floor});
    }
  }
  return out;
}
const actActive=st=>st.ch.reduce((n,c)=>n+(c && c.on ? 1 : 0),0);
