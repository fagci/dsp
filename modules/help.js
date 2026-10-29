"use strict";
/* ============================ СПРАВКА ============================
   Панель справа: кнопка «?» в тулбаре, F1 (справка по выделенному модулю), «?» в заголовке модуля.
   Источники одни и те же в репозитории и в приложении: help/*.md (оглавление — help/README.md), README.md (руководство),
   карточка модуля строится из самого определения модуля (MOD) — порты и параметры всегда актуальны, а «где встречается» — из кода пресетов.
   Файлы лежат в SHELL, поэтому справка работает без сети. Логика без DOM — modules/help-kernels.js (node tools/test-help.mjs). */

const HP_DOCS=new Map();                              // путь → Promise<текст | null>
const hpDoc=path=>{
  let p=HP_DOCS.get(path);
  if(!p) HP_DOCS.set(path,p=fetch(path).then(r=>r.ok ? r.text() : null).catch(()=>null).then(t=>{ if(t==null) HP_DOCS.delete(path); return t; }));
  return p;
};
const hp={el:null,q:'',hist:[],cur:null,toc:null,readme:null,sections:null,bullets:null,entries:null,usage:null,ui:null};

function hpModules(){ return Object.values(MOD).filter(m=>typeof hostcapsHidden!=='function' || !hostcapsHidden(m.id)); }
function hpUsage(){                                    // тип модуля → пресеты, где он есть (разбор кода сборщиков, один раз)
  if(!hp.usage){
    const src={}; try{ for(const k in PRESETS) src[k]=String(PRESETS[k]); }catch(e){}
    hp.usage=hlpUsage(src);
  }
  return hp.usage;
}
async function hpLoad(){                               // оглавление страниц и README (разделы и пункты по модулям)
  if(!hp.toc){ const t=await hpDoc('help/README.md'); hp.toc=t ? hlpToc(t) : []; }
  if(!hp.readme){
    const t=await hpDoc('README.md');
    hp.readme=t||''; hp.sections=t ? hlpSections(t) : []; hp.bullets=t ? hlpBullets(t) : new Map();
  }
}
async function hpEntries(){                            // всё, по чему ищем: темы, модули, разделы руководства, пресеты
  if(hp.entries) return hp.entries;
  await hpLoad();
  const E=[];
  for(const t of hp.toc){ const txt=t.file==='modules.md' ? '' : await hpDoc('help/'+t.file); E.push({kind:'topic',key:'help/'+t.file,title:t.title,text:(t.desc||'')+' '+(txt||'')}); }
  for(const m of hpModules()) E.push({kind:'module',key:m.id,title:m.title,text:m.id+' '+m.cat+' '+(m.kw||'')+' '+(hp.bullets.get(hlpNorm(m.title))||[]).join(' ')});
  for(const s of hp.sections) if(s.body) E.push({kind:'manual',key:s.id,title:s.title,text:s.body});
  const names=(typeof readP==='function' ? Object.keys(readP()) : Object.keys(PRESETS));
  for(const n of names) E.push({kind:'preset',key:n,title:n,text:''});
  return hp.entries=E;
}

// ---- отображение ----
const hpEl=(tag,cls,html)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; };
const hpEsc=s=>String(s).replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';');
function hpBody(){ const b=hp.ui.body; b.innerHTML=''; b.scrollTop=0; return b; }
function hpGo(view,arg,noHist){
  if(hp.cur && !noHist) hp.hist.push(hp.cur);
  if(hp.hist.length>40) hp.hist.shift();
  hp.cur={view,arg}; hpRender();
}
function hpBack(){ const p=hp.hist.pop(); if(p){ hp.cur=p; hpRender(); } else if(hp.cur?.view!=='home'){ hp.cur={view:'home'}; hpRender(); } }
async function hpRender(){
  const ui=hp.ui, c=hp.cur||{view:'home'}, token=hp.tok=(hp.tok|0)+1;
  ui.back.disabled=!hp.hist.length && c.view==='home';
  const b=hpBody();
  b.append(hpEl('div','hp-dim','Loading…'));
  try{ await hpLoad(); }catch(e){}
  if(token!==hp.tok) return;
  const body=hpBody();
  if(c.view==='home') hpHome(body);
  else if(c.view==='search') await hpResults(body,c.arg,token);
  else if(c.view==='module') hpModule(body,c.arg);
  else if(c.view==='page') await hpPage(body,c.arg,token);
  else if(c.view==='manual') hpManual(body,c.arg);
  else if(c.view==='modules') hpModuleList(body);
}
function hpHome(b){
  b.append(hpEl('h2',null,'Help'));
  b.append(hpEl('p',null,'Type in the search: topics, modules, the manual and presets are searched together, with typos and abbreviations («grph», «wfall»).'));
  if(!hp.toc.length) b.append(hpEl('p','hp-dim','The help pages could not be loaded (no network and not cached yet). The module cards below still work.'));
  const ul=hpEl('div','hp-list');
  for(const t of hp.toc){ const a=hpEl('button','hp-item','<b>'+hpEsc(t.title)+'</b>'+(t.desc ? '<span>'+hpEsc(t.desc)+'</span>' : '')); a.onclick=()=>hpOpenPage('help/'+t.file); ul.append(a); }
  b.append(ul);
  const sel=hpSelType();
  if(sel){ const a=hpEl('button','hp-item hp-sel','<b>About the selected module: '+hpEsc(MOD[sel].title)+'</b>'); a.onclick=()=>hpGo('module',sel); b.prepend(a); }
}
function hpSelType(){ const id=[...Sel][0]; const n=id!=null && Graph.map[id]; return n && MOD[n.type] ? n.type : ''; }
async function hpPage(b,file,token){
  const t=await hpDoc(file);
  if(token!==hp.tok) return;
  b=hpBody();
  if(t==null){ b.append(hpEl('p','hp-dim','This page could not be loaded: '+hpEsc(file))); return; }
  const d=hpEl('div','hp-md',hlpMd(t)); d.dataset.file=file; hpLinks(d,file); b.append(d);
}
const hpOpenPage=f=>f==='help/modules.md' ? hpGo('modules') : hpGo('page',f);     // список модулей строится из самих модулей, а не из файла
function hpModuleList(b){
  b.append(hpEl('h2',null,'Module reference'));
  b.append(hpEl('p','hp-dim','Every module of this build, by category. Tap one for its pins, parameters, manual text and the presets that use it.'));
  const by=new Map();
  for(const m of hpModules()){ if(!by.has(m.cat)) by.set(m.cat,[]); by.get(m.cat).push(m); }
  for(const [cat,list] of [...by].sort((a,b)=>String(a[0]).localeCompare(String(b[0])))){
    b.append(hpEl('h3','hp-gh',hpEsc(cat||'Other')+' · '+list.length));
    const ul=hpEl('div','hp-list');
    for(const m of list.sort((a,b)=>a.title.localeCompare(b.title))){ const a=hpEl('button','hp-item','<b>'+hpEsc(m.title)+'</b><span>'+hpEsc(m.id)+'</span>'); a.onclick=()=>hpGo('module',m.id); ul.append(a); }
    b.append(ul);
  }
}
function hpManual(b,id){
  const s=hp.sections.find(x=>x.id===id);
  if(!s){ b.append(hpEl('p','hp-dim','Section not found.')); return; }
  const d=hpEl('div','hp-md',hlpMd('#'.repeat(Math.min(3,s.level))+' '+s.title+'\n\n'+s.body)); d.dataset.file='README.md'; hpLinks(d,'README.md'); b.append(d);
  b.prepend(hpEl('div','hp-dim','From the README'));
}
// ссылки внутри страниц: другая страница help, раздел README, внешний адрес
function hpLinks(root,file){
  root.addEventListener('click',e=>{
    const a=e.target.closest('a[data-href]'); if(!a) return;
    const h=a.dataset.href; e.preventDefault();
    if(/^(https?:|mailto:)/i.test(h)){ window.open(h,'_blank','noopener'); return; }
    const [path,anchor]=h.split('#'), to=path ? hlpResolve(file,path) : file;
    if(to==='README.md' || (path==='' && file==='README.md')){
      const s=hp.sections.find(x=>x.id===anchor); if(s) hpGo('manual',s.id);
      else if(!anchor) hpGo('page','README.md');
      return;
    }
    if(/\.md$/.test(to)){
      hpOpenPage(to);
      return;
    }
    if(anchor){ const t=root.querySelector('[id="'+CSS.escape(anchor)+'"]'); t?.scrollIntoView({block:'start'}); }
  });
}
async function hpResults(b,q,token){
  const E=await hpEntries();
  if(token!==hp.tok) return;
  b=hpBody();
  const hits=hlpSearch(E,q,80);
  if(!hits.length){ b.append(hpEl('p','hp-dim','Nothing found for «'+hpEsc(q)+'».')); return; }
  const groups=[['topic','Topics'],['module','Modules'],['manual','Manual (README)'],['preset','Presets']];
  for(const [k,label] of groups){
    const list=hits.filter(h=>h.kind===k).slice(0,k==='manual' ? 12 : 20); if(!list.length) continue;
    b.append(hpEl('h3','hp-gh',label));
    const ul=hpEl('div','hp-list');
    for(const h of list){
      const sub=k==='module' ? MOD[h.key]?.cat||'' : k==='manual' ? hpSnippet(h.text,q) : k==='topic' ? hpSnippet(h.text,q) : '';
      const a=hpEl('button','hp-item','<b>'+hpEsc(h.title)+'</b>'+(sub ? '<span>'+hpEsc(sub)+'</span>' : ''));
      a.onclick=()=>k==='topic' ? hpOpenPage(h.key) : hpGo(k,h.key);
      if(k==='preset') a.onclick=()=>{ if(typeof openPatch==='function'){ openPatch(h.key); hpClose(); } };
      ul.append(a);
    }
    b.append(ul);
  }
}
function hpSnippet(text,q){                            // фрагмент вокруг первого найденного слова
  const t=String(text).replace(/[#*`|\[\]]/g,' ').replace(/\s+/g,' '), low=t.toLocaleLowerCase('ru');
  for(const w of fzTokens(q)){ const i=low.indexOf(w); if(i>=0){ const a=Math.max(0,i-40); return (a ? '… ' : '')+t.slice(a,a+120)+' …'; } }
  return t.slice(0,110);
}

// ---- карточка модуля ----
function hpModule(b,id){
  const d=MOD[id]; if(!d){ b.append(hpEl('p','hp-dim','Unknown module: '+hpEsc(id))); return; }
  const c=hlpModCard(d), role=typeof modRole==='function' ? (ROLE_NAME[modRole(d)]||'') : '';
  b.append(hpEl('h2',null,hpEsc(c.title)));
  b.append(hpEl('div','hp-meta','<span>'+hpEsc(c.cat)+'</span>'+(role ? '<span>'+hpEsc(role)+'</span>' : '')+'<code>'+hpEsc(c.id)+'</code>'));
  const add=hpEl('button','hp-btn','Add to canvas');
  add.onclick=()=>{ const r=cv.getBoundingClientRect(); addNodeUI(id,(r.width/2)/view.k-view.x-100+Math.random()*50,(r.height/3)/view.k-view.y+Math.random()*120); markWiresDirty(); Undo.push(); showToast('added: '+c.title); };
  b.append(add);
  const bl=hp.bullets && hp.bullets.get(hlpNorm(c.title));
  if(bl && bl.length){
    b.append(hpEl('h3','hp-gh','From the manual'));
    let first=true;
    for(const x of bl){
      const text=(x.replace(/^\*\*[^*]+\*\*\s*(\([^)]*\))?:?\s*/,'')||x).replace(/^./,c=>c.toUpperCase()), sm=hlpSummary(text,280,3);
      const head=hpEl('div','hp-md hp-sum',hlpMd(sm.head)); hpLinks(head,'README.md'); b.append(head);
      if(sm.rest.length){
        const more=hpEl('div','hp-md hp-more',sm.rest.map(r=>hlpMd(r)).join('')); more.hidden=true; hpLinks(more,'README.md');
        const btn=hpEl('button','hp-btn','More ('+sm.rest.length+')');
        btn.onclick=()=>{ more.hidden=!more.hidden; btn.textContent=more.hidden ? 'More ('+sm.rest.length+')' : 'Less'; };
        b.append(btn,more);
      }
      first=false;
    }
  }
  else b.append(hpEl('p','hp-dim','No description of this module in the manual yet — the pins and parameters below come from the module itself.'));
  if(c.dynamic) b.append(hpEl('p','hp-dim','The pins of this module depend on its settings; the lists show the base set.'));
  const pins=(title,list)=>{
    if(!list.length) return;
    b.append(hpEl('h3','hp-gh',title));
    b.append(hpEl('table','hp-tab','<tbody>'+list.map(p=>'<tr><td><code>'+hpEsc(p.n)+'</code></td><td class="t-'+hpEsc(p.t)+'">'+hpEsc(p.t)+'</td><td>'+hpEsc(p.tip)+'</td></tr>').join('')+'</tbody>'));
  };
  pins('Inputs',c.ins); pins('Outputs',c.outs);
  if(c.params.length){
    b.append(hpEl('h3','hp-gh','Parameters'));
    b.append(hpEl('table','hp-tab','<tbody>'+c.params.map(p=>'<tr><td><code>'+hpEsc(p.n)+'</code>'+(p.adv ? ' <i>adv</i>' : '')+'</td><td>'+hpEsc(p.label||p.n)+(p.opts ? '<br><span class="hp-dim">'+hpEsc(p.opts.join(' · '))+'</span>' : '')+(p.tip ? '<br><span class="hp-dim">'+hpEsc(p.tip)+'</span>' : '')+'</td><td>'+(p.d==null||p.d==='' ? '' : hpEsc(String(p.d)))+'</td></tr>').join('')+'</tbody>'));
  }
  if(c.buttons.length) b.append(hpEl('p','hp-dim','Buttons: '+hpEsc(c.buttons.join(', '))));
  const used=hpUsage().get(id)||[];
  if(used.length){
    b.append(hpEl('h3','hp-gh','Used in presets ('+used.length+')'));
    const ul=hpEl('div','hp-list');
    for(const n of used.slice(0,15)){ const a=hpEl('button','hp-item','<b>'+hpEsc(n)+'</b>'); a.onclick=()=>{ if(typeof openPatch==='function'){ openPatch(n); hpClose(); } }; ul.append(a); }
    b.append(ul);
  }
}

// ---- панель ----
function hpOpen(arg){
  hpMount();
  hp.el.hidden=false; document.getElementById('helpBtn')?.setAttribute('aria-expanded','true');
  if(arg && arg.module) hpGo('module',arg.module);
  else if(!hp.cur) hpGo('home',null,true);
  else hpRender();
  setTimeout(()=>hp.ui.q.focus({preventScroll:true}),0);
}
function hpClose(){ if(hp.el){ hp.el.hidden=true; document.getElementById('helpBtn')?.setAttribute('aria-expanded','false'); } }
function hpMount(){
  if(hp.el) return;
  const el=hpEl('div'); el.id='helpPanel'; el.hidden=true;
  el.innerHTML='<div class="hp-bar"><button class="hp-b hp-back" title="Back">←</button><input class="hp-q" type="search" placeholder="Search help, modules, presets…" autocomplete="off" spellcheck="false"><button class="hp-b hp-home" title="Contents">☰</button><button class="hp-b hp-x" title="Close (Esc)">✕</button></div><div class="hp-body"></div>';
  document.body.append(el); hp.el=el;
  hp.ui={body:el.querySelector('.hp-body'),q:el.querySelector('.hp-q'),back:el.querySelector('.hp-back')};
  for(const ev of ['pointerdown','wheel','keydown','keyup','dblclick']) el.addEventListener(ev,e=>e.stopPropagation());
  let t=0;
  hp.ui.q.addEventListener('input',()=>{ clearTimeout(t); t=setTimeout(()=>{ const q=hp.ui.q.value.trim(); if(q) hpGo('search',q,hp.cur?.view==='search'); else hpGo('home',null,hp.cur?.view==='search'); },120); });
  hp.ui.q.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); if(hp.ui.q.value){ hp.ui.q.value=''; hpGo('home',null,true); } else hpClose(); } });
  el.querySelector('.hp-x').onclick=hpClose;
  el.querySelector('.hp-home').onclick=()=>{ hp.ui.q.value=''; hpGo('home'); };
  hp.ui.back.onclick=hpBack;
}
// «?» в заголовке модуля и F1: справка по модулю; без выделения — главная
function hpForNode(n){ if(n && MOD[n.type]) hpOpen({module:n.type}); else hpOpen(); }
(function(){
  const btn=document.getElementById('helpBtn');
  if(btn) btn.onclick=()=>{ if(hp.el && !hp.el.hidden) hpClose(); else { const t=hpSelType(); t ? hpOpen({module:t}) : hpOpen(); } };
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape' && hp.el && !hp.el.hidden){ hpClose(); return; }
    if(e.key!=='F1') return;
    const t=e.target; if(t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    e.preventDefault(); const s=hpSelType(); s ? hpOpen({module:s}) : hpOpen();
  });
})();
