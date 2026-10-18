"use strict";
/* ============================ Table: типы полей, карточки, связи между списками ============================
   Схема списка: ListDB-meta {cols, types:{колонка:{t, opts, to, multi}}, card:{show:[колонки]}}; у списка в патче (@patch) — n.p.schema.
   Типы: text, long, num, bool, date, choice (opts), photo, audio, link (to — другой список; в ячейке имена записей через « | »).
   Колонки без типа ведут себя как раньше (photo / audio — по имени). Виды: cards (карточки с фото), grid (полный список), compact (краткий).
   Карточка записи — панель с большим фото, всеми полями, связями и обратными связями («кто ссылается на эту запись»). */

const TC_TYPES=[['text','text'],['long','long text'],['num','number'],['bool','checkbox'],['date','date'],['choice','choice'],
  ['photo','photo'],['audio','audio'],['link','link to a list']];
const TC_VIEWS=[['cards','🃏','cards'],['grid','☰','full list (columns)'],['compact','≡','brief list (name · values)']];
const TC_SEP=' | ';

const tcView=n=>n.p.vmode==='cards' ? 'cards' : n.p.vmode==='compact' ? 'compact' : 'grid';
const tcSchemaOf=m=>({types:{...(m?.types||{})},card:{...(m?.card||{})}});
const tcDef=(n,c)=>n.schema?.types?.[c]||{};
// тип колонки: из схемы, иначе по имени (photo / audio, как раньше)
function tblType(n,c){
  const t=n.schema?.types?.[c]?.t; if(t) return t;
  const low=c.toLowerCase();
  return TBL_PHOTO.test(low) ? 'photo' : TBL_AUDIO.test(low) ? 'audio' : 'text';
}
const tcLinks=v=>String(v??'').split('|').map(s=>s.trim()).filter(Boolean);
const tcJoin=a=>a.join(TC_SEP);
const tcIsTrue=v=>v===true || v===1 || /^(1|true|yes|y|да)$/i.test(String(v??'').trim());
// подпись записи в связях: колонка имени, иначе первая непустая
const tcKeyCol=cols=>tblCol(cols,TBL_LABEL)||cols[0];
const tcKey=(n,r)=>String(r[n.nameCol||n.cl[0]]??'');
// текст значения для списков и карточек
function tcText(n,c,v){
  if(v===''||v==null) return '';
  const t=tblType(n,c);
  if(t==='bool') return tcIsTrue(v) ? '✓' : '✗';
  if(t==='link') return tcLinks(v).join(', ');
  return recFmt(v);
}

/* ---------- хранение схемы ---------- */
async function tblMetaSet(list,patch){                 // слияние: правка колонок не стирает типы
  const m=(await ListDB.getMeta(list))||{};
  await ListDB.setMeta(list,{...m,...patch});
}
async function tcSchemaSave(n){
  if(tblRO(n)) return;
  const kind=tblKind(n.p.list);
  if(kind==='db') await tblMetaSet(n.p.list,{types:n.schema.types,card:n.schema.card});
  else if(kind==='patch') n.p.schema={types:n.schema.types,card:n.schema.card};
  Undo.push();
}
function tcSetDef(n,c,def){
  const t=n.schema.types;
  if(!def || (!def.t || def.t==='text') && !def.opts && !def.to) delete t[c]; else t[c]=def;
  return tcSchemaSave(n);
}
// другие списки, в схеме которых есть связь с list: [{list, col, def}]
async function tcLinkCols(list){
  const out=[];
  for(const ln of await ListDB.metaNames()){
    const m=await ListDB.getMeta(ln);
    for(const [c,d] of Object.entries(m?.types||{})) if(d.t==='link' && d.to===list) out.push({list:ln,col:c,def:d});
  }
  return out;
}
// запись переименована: связи на неё в других списках (и в этом) следуют за ней; true — этот список менялся
async function tcRelink(list,oldName,newName){
  let self=false;
  for(const L of await tcLinkCols(list)){
    for(const it of await ListDB.list(L.list)){
      const v=tcLinks(it.fields[L.col]);
      if(!v.includes(oldName)) continue;
      it.fields[L.col]=tcJoin(v.map(x=>x===oldName ? newName : x));
      await ListDB.update(it.id,{fields:it.fields});
      if(L.list===list) self=true;
    }
  }
  return self;
}
// список переименован / перенесён: поля-связи указывают на новое имя
async function tcRenameTarget(oldName,newName){
  for(const L of await tcLinkCols(oldName)){
    const m=await ListDB.getMeta(L.list), types={...m.types};
    types[L.col]={...types[L.col],to:newName};
    await tblMetaSet(L.list,{types});
  }
}
// кто ссылается на запись name списка list: [{list, name, col}]
async function tcBacklinks(list,name){
  const out=[];
  for(const L of await tcLinkCols(list)){
    const m=await ListDB.getMeta(L.list), kc=tcKeyCol(m?.cols||[]);
    for(const it of await ListDB.list(L.list))
      if(tcLinks(it.fields[L.col]).includes(name)) out.push({list:L.list,col:L.col,name:kc==='name' ? it.name : String(it.fields[kc]??it.name)});
  }
  return out;
}

/* ---------- выбор связанной записи ---------- */
async function tcTargetNames(n,list){
  const t=list===n.p.list ? {cols:n.cl,rows:n.all} : await tblReadList(n,list);
  const kc=tcKeyCol(t.cols);
  return t.rows.map(r=>String(r[kc]??'')).filter(Boolean);
}
// Promise<имена|undefined>; можно создать новую запись в целевом списке
function tcPick(n,list,multi,cur){
  return new Promise(async res=>{
    let names;
    try{ names=await tcTargetNames(n,list); }catch(e){ alert('Could not read "'+list+'": '+e.message); return res(undefined); }
    const sel=new Set(cur), canNew=tblKind(list)==='db' || list===n.p.list && !tblRO(n);
    const ov=document.createElement('div'); ov.className='fm-ov';
    const box=document.createElement('div'); box.className='fm-pick'; box.style.minWidth='min(320px,90vw)';
    const t=document.createElement('b'); t.textContent=tblLeaf(list)+(multi ? ' — pick several' : ' — pick one'); box.append(t);
    const q=document.createElement('input'); q.placeholder='search…'; q.style.cssText=TBL_IN+'height:26px;';
    q.addEventListener('keydown',e=>e.stopPropagation());
    const lst=document.createElement('div'); lst.style.cssText='display:flex;flex-direction:column;gap:3px;max-height:50vh;overflow:auto';
    const draw=()=>{
      lst.textContent='';
      const f=q.value.trim().toLowerCase(), have=new Set(names);
      const shown=[...new Set([...cur,...names])].filter(x=>!f || x.toLowerCase().includes(f));
      for(const nm of shown.slice(0,300)){
        const b=document.createElement('button');
        b.textContent=(sel.has(nm) ? '☑ ' : multi ? '☐ ' : '')+nm+(have.has(nm) ? '' : ' (missing)');
        b.onclick=()=>{ if(!multi){ ov.remove(); res([nm]); return; } sel.has(nm) ? sel.delete(nm) : sel.add(nm); draw(); };
        lst.append(b);
      }
      if(canNew && f && !names.some(x=>x.toLowerCase()===f)){
        const b=document.createElement('button'); b.textContent='＋ create "'+q.value.trim()+'"';
        b.onclick=async()=>{
          const nm=q.value.trim().replace(/\|/g,'/');
          try{ if(list===n.p.list) await tblAdd(n,[{[n.nameCol||'name']:nm}]); else await ListDB.add(list,nm,{}); }
          catch(e){ alert(e.message); return; }
          names.push(nm); sel.add(nm); q.value='';
          if(!multi){ ov.remove(); res([nm]); return; }
          draw();
        };
        lst.append(b);
      }
      if(!lst.children.length){ const e=document.createElement('div'); e.className='fm-info'; e.textContent='nothing'; lst.append(e); }
    };
    q.oninput=draw;
    const bar=document.createElement('div'); bar.style.cssText='display:flex;gap:6px;justify-content:flex-end';
    const ok=document.createElement('button'); ok.textContent='OK'; ok.onclick=()=>{ ov.remove(); res([...sel]); };
    const clr=document.createElement('button'); clr.textContent='clear'; clr.onclick=()=>{ ov.remove(); res([]); };
    const no=document.createElement('button'); no.textContent='Cancel'; no.onclick=()=>{ ov.remove(); res(undefined); };
    bar.append(...(multi ? [ok] : []),clr,no);
    ov.onclick=e=>{ if(e.target===ov){ ov.remove(); res(undefined); } };
    box.append(q,lst,bar); ov.append(box); document.body.append(ov); draw(); q.focus();
  });
}

/* ---------- поля формы ---------- */
// {inp, bar?, wide?} для типов long / num / bool / date / choice / link; иначе null (общая ветка формы)
function tcFormField(n,c,rec,ty){
  const def=tcDef(n,c), v=rec[c];
  const mkb=(t,f)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=t; b.style.cssText=TBL_BTN; b.addEventListener('click',e=>{ e.preventDefault(); f(); }); return b; };
  if(ty==='long'){
    const inp=document.createElement('textarea'); inp.rows=3; inp.value=v??''; inp.style.cssText=TBL_IN+'resize:vertical;font-family:inherit;';
    inp.addEventListener('keydown',e=>e.stopPropagation());
    return {inp,wide:true};
  }
  if(ty==='num'){
    const inp=document.createElement('input'); inp.type='number'; inp.step='any'; inp.value=v??'';
    inp.addEventListener('keydown',e=>e.stopPropagation());
    return {inp};
  }
  if(ty==='bool'){
    const inp=document.createElement('input'); inp.type='checkbox'; inp.checked=tcIsTrue(v); inp.style.cssText='width:18px;height:18px;';
    return {inp};
  }
  if(ty==='date'){
    const inp=document.createElement('input'); inp.type='date'; inp.value=/^\d{4}-\d\d-\d\d$/.test(String(v)) ? v : '';
    return {inp};
  }
  if(ty==='choice'){
    const inp=document.createElement('select'), opts=['',...(def.opts||[])], cur=String(v??'');
    if(cur && !opts.includes(cur)) opts.push(cur);
    for(const o of opts){ const op=document.createElement('option'); op.value=o; op.textContent=o||'—'; inp.append(op); }
    inp.value=cur;
    return {inp};
  }
  if(ty==='link'){
    const inp=document.createElement('input'); inp.type='hidden'; inp.value=tcJoin(tcLinks(v));
    const bar=document.createElement('span'); bar.className='tf-bar';
    const chips=document.createElement('span'); chips.className='tc-chips';
    const upd=()=>{
      chips.textContent='';
      const a=tcLinks(inp.value);
      if(!a.length) chips.textContent='—';
      for(const nm of a) chips.append(Object.assign(document.createElement('span'),{className:'tc-chip',textContent:nm}));
    };
    upd();
    bar.append(chips,mkb(def.to ? '＋ pick' : 'set the list first',async()=>{
      if(!def.to){ alert('Choose the linked list in ▦ view → Fields'); return; }
      const got=await tcPick(n,def.to,!!def.multi,tcLinks(inp.value));
      if(got){ inp.value=tcJoin(got); upd(); }
    }),mkb('clear',()=>{ inp.value=''; upd(); }));
    return {inp,bar,wide:true};
  }
  return null;
}
// значение из поля формы для типизированных колонок; undefined — как у обычных
function tcValue(ty,inp){
  const v=inp.value;
  switch(ty){
    case 'num': return String(v).trim()==='' ? '' : isFinite(+v) ? +v : v;
    case 'bool': return inp.checked ? 1 : 0;
    case 'date': case 'choice': case 'long': case 'link': return v;
  }
  return undefined;
}

/* ---------- карточки ---------- */
// поля на карточке: выбранные в схеме, иначе первые заполненные (кроме имени, фото, звука и цвета)
function tcShowCols(n){
  const own=(n.schema?.card?.show||[]).filter(c=>n.cl.includes(c));
  if(own.length) return own;
  return n.cl.filter(c=>c!==n.nameCol && c!==n.colorCol && !['photo','audio','long'].includes(tblType(n,c))).slice(0,3);
}
function tcCover(n,r){
  const c=n.cl.find(x=>tblType(n,x)==='photo');
  return c ? phIds(r[c]) : [];
}
function tcChips(n,c,v){
  const d=tcDef(n,c), box=document.createElement('span'); box.className='tc-chips';
  for(const nm of tcLinks(v)){
    const ch=document.createElement('span'); ch.className='tc-chip'; ch.textContent=nm; ch.dataset.to=d.to||''; ch.dataset.name=nm; ch.title='Open '+nm;
    box.append(ch);
  }
  return box;
}
function tcCard(n,i,ro,show){
  const r=n.rows[i], el=document.createElement('div');
  el.dataset.i=i; el.className='tbl-row tbl-card';
  const bg=tblRowBg(n,r);
  if(bg) el.style.setProperty('--rb','color-mix(in srgb,'+bg+' 24%,transparent)');
  const label=n.nameCol ? String(r[n.nameCol]??'') : '#'+(i+1);
  const cv=document.createElement('div'); cv.className='tc-cover';
  const ids=tcCover(n,r);
  if(ids.length){
    const im=document.createElement('img'); im.loading='lazy'; im.alt=''; cv.append(im);
    phUrl(ids[0]).then(u=>{ if(u) im.src=u; else { im.remove(); cv.textContent='📷'; } });
    if(ids.length>1) cv.append(Object.assign(document.createElement('span'),{className:'tc-n',textContent:'📷'+ids.length}));
  } else {
    cv.classList.add('none'); cv.style.setProperty('--h',tblHue(label||'?'));
    cv.textContent=(label.trim()[0]||'·').toUpperCase();
  }
  const body=document.createElement('div'); body.className='tc-body';
  body.append(Object.assign(document.createElement('div'),{className:'tc-t',textContent:label||'(no name)'}));
  for(const c of show){
    const v=r[c]; if(v===''||v==null) continue;
    const line=document.createElement('div'); line.className='tc-l';
    line.append(Object.assign(document.createElement('span'),{className:'tc-k',textContent:c}));
    if(tblType(n,c)==='link') line.append(tcChips(n,c,v));
    else line.append(Object.assign(document.createElement('span'),{className:'tc-v',textContent:TBL_HZ.test(c)&&isFinite(tblHz(v)) ? fmtHz(tblHz(v),3) : tcText(n,c,v)}));
    body.append(line);
  }
  el.append(cv,body);
  if(!ro){
    const tail=document.createElement('span'); tail.className='tc-tail';
    for(const [t,title,act] of [['✎','Edit','edit'],['🗑','Delete','del']]){
      const b=Object.assign(document.createElement('span'),{className:'tbl-ico',textContent:t,title});
      b.dataset.act=act; tail.append(b);
    }
    el.append(tail);
  }
  return el;
}
function tcCards(n){
  const ui=n.ui, list=ui.list, ro=tblRO(n), N=n.rows.length, e=Math.min(N,TBL_ROWS), show=tcShowCols(n);
  const frag=document.createDocumentFragment();
  for(let i=0;i<e;i++) frag.append(tcCard(n,i,ro,show));
  if(N>e){
    const m=document.createElement('div'); m.textContent='… '+(N-e)+' more — narrow with the filter'; m.className='tbl-empty sm'; frag.append(m);
  }
  ui.rend=null; n.uiFull=false;
  list.replaceChildren(frag);
  ui.marked=-1; tblMark(n,true);
}
// переключатель вида в нижней панели: карточки → список → краткий
function tcViewBtn(n){
  const b=n.ui.vmBtn; if(!b) return;
  const v=TC_VIEWS.find(x=>x[0]===tcView(n));
  b.textContent=v[1]; b.title='View: '+v[2]+' — click to switch';
}
function tcViewNext(n){
  const i=TC_VIEWS.findIndex(x=>x[0]===tcView(n));
  tblViewApply(n,'vmode',TC_VIEWS[(i+1)%TC_VIEWS.length][0],!n.ui.view.hidden);
}

/* ---------- карточка записи ---------- */
async function tcGo(n,list,name){                     // перейти к связанной записи
  if(!list) return;
  tblCloseEditor(n);
  n.openName=name;                                     // смена списка пересобирает узел: открыть карточку, когда вид готов
  if(list!==n.p.list) await tblPick(n,list);
  tcOpenPending(n);
}
function tcOpenPending(n){
  if(n.openName==null || !n.ui || n.loaded!==n.p.list || !n.ui.root.isConnected) return;
  const name=n.openName; n.openName=null;
  const find=()=>n.rows.findIndex(r=>tcKey(n,r)===name);
  let i=find();
  if(i<0 && n.p.filter){ n.p.filter=''; n.ui.filter.value=''; tblDerive(n); i=find(); }
  if(i<0){ tblRenderList(n); alert('"'+name+'" is not in '+tblLeaf(n.p.list)); return; }
  tblSelect(n,i); tblRenderList(n); tcDetail(n,i);
}
function tcDetail(n,i){
  const r=n.rows[i]; if(!r) return;
  const ro=tblRO(n), label=n.nameCol ? String(r[n.nameCol]??'') : '#'+(i+1);
  const form=document.createElement('div'); form.className='tbl-form tc-detail';
  const mkb=(t,title,f,cls)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=t; b.title=title; b.className='tbl-btn'+(cls?' '+cls:''); b.addEventListener('click',f); return b; };
  form.cancel=mkb('✕','Close',()=>tblCloseEditor(n));
  form.save=ro ? mkb('◀','Previous',()=>tcStep(n,i,-1)) : mkb('✎ edit','Edit this entry',()=>tblEditForm(n,i,null),'pri');
  const wide=el=>{ el.classList.add('wide'); form.append(el); return el; };
  const ph=n.cl.filter(c=>tblType(n,c)==='photo').flatMap(c=>phIds(r[c]));
  if(ph.length){
    const g=wide(document.createElement('div')); g.className='tc-gal wide';
    const big=document.createElement('img'); big.className='tc-big'; big.alt='';
    phUrl(ph[0]).then(u=>{ if(u) big.src=u; });
    big.onclick=()=>phView(ph,0);
    g.append(big);
    if(ph.length>1){
      const row=document.createElement('div'); row.className='tc-thumbs';
      ph.forEach((id,k)=>{ const im=document.createElement('img'); im.alt=''; phUrl(id).then(u=>{ if(u) im.src=u; }); im.onclick=()=>{ phUrl(id).then(u=>{ if(u) big.src=u; }); big.onclick=()=>phView(ph,k); }; row.append(im); });
      g.append(row);
    }
  }
  wide(Object.assign(document.createElement('div'),{className:'tc-title',textContent:label||'(no name)'}));
  for(const c of n.cl){
    const v=r[c], t=tblType(n,c);
    if(c===n.nameCol || t==='photo' || v===''||v==null) continue;
    const l=document.createElement('div'); l.className='tc-f'+(t==='long' || t==='link' ? ' wide' : '');
    l.append(Object.assign(document.createElement('span'),{className:'tc-k',textContent:c}));
    let val;
    if(t==='link') val=tcChips(n,c,v);
    else if(t==='audio'){ const a=auIds(v); val=mkb('🔊 '+a.length,'Play the audio',()=>auView(a)); }
    else {
      val=document.createElement('span'); val.className='tc-v'+(t==='long' ? ' pre' : '');
      if(TBL_COLOR.includes(c.toLowerCase()) && CSS.supports('color',String(v))){ const sw=document.createElement('i'); sw.className='tbl-sw'; sw.style.background=String(v); val.append(sw); }
      val.append(TBL_HZ.test(c)&&isFinite(tblHz(v)) ? fmtHz(tblHz(v),4)+'Hz' : tcText(n,c,v));
    }
    l.append(val); form.append(l);
  }
  // обратные связи — кто ссылается на эту запись
  const back=wide(document.createElement('div')); back.className='tc-back wide';
  if(label && tblKind(n.p.list)==='db') tcBacklinks(n.p.list,label).then(a=>{
    if(!a.length || !back.isConnected) return;
    back.append(Object.assign(document.createElement('span'),{className:'tc-k',textContent:'linked from'}));
    const box=document.createElement('span'); box.className='tc-chips';
    for(const b of a){
      const ch=document.createElement('span'); ch.className='tc-chip'; ch.textContent=tblLeaf(b.list)+' · '+b.name; ch.dataset.to=b.list; ch.dataset.name=b.name; ch.title='Open '+b.name+' ('+b.col+')';
      box.append(ch);
    }
    back.append(box);
  }).catch(()=>{});
  const nav=wide(document.createElement('div')); nav.className='tc-nav wide';
  nav.append(mkb('◀','Previous entry',()=>tcStep(n,i,-1)),Object.assign(document.createElement('span'),{className:'tc-k',textContent:(i+1)+' / '+n.rows.length}),mkb('▶','Next entry',()=>tcStep(n,i,1)));
  if(!ro) nav.append(mkb('🗑','Delete this entry',async()=>{
    if(!confirm('Delete "'+(label||i+1)+'"?')) return;
    await tblRemove(n,i); tblCloseEditor(n); tblRenderList(n);
  }));
  form.addEventListener('click',e=>{ const ch=e.target.closest('.tc-chip'); if(ch?.dataset.to) tcGo(n,ch.dataset.to,ch.dataset.name); });
  tblOpenEditor(n,'Card',form,n.ui.list.querySelector('.tbl-row[data-i="'+i+'"]'));
}
function tcStep(n,i,d){
  const N=n.rows.length; if(!N) return;
  const j=(i+d+N)%N; tblSelect(n,j); tcDetail(n,j);
}

/* ---------- схема в панели «▦ view» ---------- */
function tcFieldsPanel(n,box,mk,sel){
  if(tblRO(n)) return;
  box.append(mk('div','tv-sec','Fields — type, choices, links, shown on the card'));
  const lists=(n.treeNames||[]).filter(x=>tblKind(x)!=='preset');
  const show=new Set(n.schema.card.show||[]);
  for(const c of n.cl){
    const d=tcDef(n,c), t=d.t||(tblType(n,c)==='text' ? 'text' : tblType(n,c));
    const row=mk('div','tv-col');
    const card=mk('input'); card.type='checkbox'; card.checked=show.has(c); card.title='show on the card';
    card.addEventListener('change',()=>{ const s=new Set(n.schema.card.show||[]); card.checked ? s.add(c) : s.delete(c);
      n.schema.card.show=n.cl.filter(x=>s.has(x)); tcSchemaSave(n); tblRenderList(n); });
    row.append(card,mk('span','tv-name',c),sel(TC_TYPES,t,v=>{
      const nd={...d,t:v}; if(v!=='choice') delete nd.opts; if(v!=='link'){ delete nd.to; delete nd.multi; }
      tcSetDef(n,c,nd).then(()=>{ tblRenderView(n); tblRenderList(n); });
    }));
    if(t==='choice'){
      const o=mk('input','tv-q'); o.value=(d.opts||[]).join(', '); o.placeholder='choice 1, choice 2, …';
      o.addEventListener('keydown',e=>e.stopPropagation());
      o.addEventListener('change',()=>tcSetDef(n,c,{...d,opts:o.value.split(',').map(s=>s.trim()).filter(Boolean)}));
      row.append(o);
    }
    if(t==='link'){
      row.append(sel([['','— list —'],...lists.map(x=>[x,tblKind(x)==='patch' ? 'This patch' : x])],d.to||'',v=>tcSetDef(n,c,{...d,to:v})));
      const m=mk('input'); m.type='checkbox'; m.checked=!!d.multi; m.title='several entries';
      m.addEventListener('change',()=>tcSetDef(n,c,{...d,multi:m.checked}));
      row.append(m,mk('span','tv-lbl','many'));
    }
    box.append(row);
  }
}
