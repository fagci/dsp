"use strict";
/* ============================ Пробник провода ============================
   Курсор над проводом → подсказка: откуда и куда, тип, последнее значение, блоков в секунду и «возраст» последнего блока.
   Считает только источник под курсором (probeSet в core-engine.js) — вне наведения никаких накладных расходов.
   Ядро (форматы) — wireprobe-kernels.js, проверка: node tools/test-wireprobe.mjs. */
(()=>{
  let tip=null, cur=null, timer=0, win=0;
  const el=()=>tip||(tip=Object.assign(document.createElement('div'),{className:'wprobe'}));
  const nm=n=>{ const d=MOD[n.type]; return (d&&d.title||n.type)+' #'+n.id; };
  function paint(){
    const e=cur; if(!e) return;
    const A=Graph.map[e.from], B=Graph.map[e.to]; if(!A||!B){ wireProbeOff(e); return; }
    const now=performance.now();
    if(now-probeSt.t0>2000){ win=wpRate(probeSt.n,probeSt.last>probeSt.t0 ? now-probeSt.t0 : 0); probeSet(A); if(!win) win=0; }
    const rate=probeSt.n>2 && now-probeSt.t0>300 ? wpRate(probeSt.n,now-probeSt.t0) : win;
    const t=portsOf(A,'outs').find(o=>o.n===e.fp)?.t||'';
    const v=A.out?.[e.fp];
    const h='<b>'+hlpEsc(nm(A))+'.'+hlpEsc(e.fp)+'</b> → <b>'+hlpEsc(nm(B))+'.'+hlpEsc(e.tp)+'</b> <i>'+hlpEsc(t)+'</i>';
    const stale=Eng.running && now-probeSt.last>1500;
    el().innerHTML=h+'<br>'+hlpEsc(wpFmt(v))+'<br>'+(Eng.running ? 'blocks '+wpRateText(rate)+' · '+wpAgeText(now-probeSt.last,true)+(stale ? ' — source is not producing' : '')
      : 'engine stopped')+(A.err ? '<br><span class="werr">'+hlpEsc(String(A.err.message||A.err))+'</span>' : '');
  }
  function place(ev){
    const t=el(), w=t.offsetWidth, hgt=t.offsetHeight;
    t.style.left=Math.max(4,Math.min(innerWidth-w-4,ev.clientX+14))+'px';
    t.style.top=Math.max(4,Math.min(innerHeight-hgt-4,ev.clientY+16))+'px';
  }
  window.wireProbeOn=(e,ev)=>{
    const A=Graph.map[e.from]; if(!A) return;
    cur=e; win=0; probeSet(A);
    document.body.append(el()); paint(); place(ev);
    clearInterval(timer); timer=setInterval(paint,250);
  };
  window.wireProbeMove=ev=>{ if(cur) place(ev); };
  window.wireProbeOff=e=>{
    if(e && e!==cur) return;
    cur=null; clearInterval(timer); probeSet(null); tip?.remove();
  };
})();
