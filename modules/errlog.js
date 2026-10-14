// Журнал ошибок: значок «⚠ N» на панели и окно со списком. Собирает window.DSPErr (index.html); отчёт копируется
// или уходит черновиком в GitHub Issues — отправляет сам пользователь, приложение ничего не шлёт.
(()=>{
  const E=window.DSPErr, badge=document.getElementById('errBadge');
  if(!E || !badge) return;
  const ISSUES='https://github.com/fagci/dsp/issues/new';
  let panel=null, listEl=null;
  const el=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
  const copy=async text=>{
    try{ await navigator.clipboard.writeText(text); return true; }catch(e){}
    try{ const t=el('textarea'); t.value=text; document.body.appendChild(t); t.select(); const ok=document.execCommand('copy'); t.remove(); return ok; }catch(e){ return false; }
  };
  const flash=(b,text)=>{ const o=b.dataset.t||(b.dataset.t=b.textContent); b.textContent=text; setTimeout(()=>{ b.textContent=o; },1500); };
  function fill(){
    listEl.textContent='';
    const rows=E.list.slice().reverse();
    if(!rows.length) listEl.appendChild(el('div','ee-empty','No errors'));
    for(const e of rows){
      const d=el('details','ee'+(e.old?' old':''));
      const s=el('summary',null,e.msg||'(no message)');
      d.appendChild(s);
      d.appendChild(el('div','ee-meta',e.kind+(e.n>1?' ×'+e.n:'')+' · '+new Date(e.t).toLocaleTimeString()+(e.old?' · previous session':'')+(e.src?' · '+e.src:'')));
      if(e.stack) d.appendChild(el('pre',null,e.stack));
      listEl.appendChild(d);
    }
  }
  function close(){ if(panel){ panel.remove(); panel=null; } }
  function open(){
    if(panel) return close();
    panel=el('div'); panel.id='errPanel';
    const head=el('div','ep-head');
    head.appendChild(el('b',null,'Errors'));
    head.appendChild(el('span','ep-v','DSP '+E.v));
    const x=el('button',null,'×'); x.title='Close'; x.onclick=close; head.appendChild(x);
    listEl=el('div','ep-list');
    const foot=el('div','ep-foot');
    const bCopy=el('button',null,'Copy report'), bGh=el('button',null,'Report on GitHub'), bClr=el('button',null,'Clear');
    bCopy.onclick=async()=>flash(bCopy,(await copy(E.report()))?'Copied':'Copy failed');
    bGh.onclick=async()=>{
      const rep=E.report(), cut=rep.length>4500, last=E.list[E.list.length-1];
      const ok=await copy(rep);
      const body='What I was doing:\n\n\n```\n'+rep.slice(0,4500)+(cut?'\n…':'')+'\n```\n'+(cut&&ok?'\nThe full report is in the clipboard — paste it here.\n':'');
      window.open(ISSUES+'?title='+encodeURIComponent('Error: '+(last?last.msg:'').slice(0,80))+'&body='+encodeURIComponent(body),'_blank','noopener');
    };
    bClr.onclick=()=>{ E.clear(); close(); };
    foot.append(bCopy,bGh,bClr);
    panel.append(head,listEl,foot);
    document.body.appendChild(panel);
    fill();
  }
  const update=()=>{
    const k=E.list.filter(e=>!e.old).length;
    badge.hidden=!k; badge.textContent='⚠ '+k;
    if(panel) fill();
  };
  badge.addEventListener('click',open);
  addEventListener('keydown',ev=>{ if(ev.key==='Escape') close(); });
  E.subs.push(update);
  update();
})();
