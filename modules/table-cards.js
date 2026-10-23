"use strict";
/* ============================ Table: типы полей, карточки, связи между списками ============================
   Схема списка: ListDB-meta {cols, types:{колонка:{t, opts, to, multi}}, card:{show:[колонки]}}; у списка в патче (@patch) — n.p.schema.
   Типы: text, long, num, progress (min / max — границы шкалы, по умолчанию 0…100), bool, date, choice (opts), photo, audio, link (to — другой список; в ячейке имена записей через « | »).
   file — в ячейке id файлов из Files: «fl-12 fl-15» (или «ph-…» для фото из пространства images); сами файлы остаются в dsp-files.
   card.lines — раскладка карточки: [[колонки строки 1],[строки 2]…] под названием; нет — по одному полю из show на строку. card.keys — подписи полей, card.cover=='none' — без блока фото.
   Колонки без типа ведут себя как раньше (photo / audio — по имени). Виды: cards (карточки с фото), grid (полный список), compact (краткий).
   Карточка записи — панель с большим фото, всеми полями, связями и обратными связями («кто ссылается на эту запись»). */

const TC_TYPES=[['text','text'],['long','long text'],['num','number'],['bool','checkbox'],['progress','progress bar'],['date','date'],['choice','choice'],
  ['photo','photo'],['image','avatar / image (URL or photo)'],['online','online status'],['typing','typing'],['audio','audio'],['file','file (from Files)'],['link','link to a list'],['checklist','checklist (items from another list)'],['auto','auto number'],['calc','calculated']];
const TC_VIEWS=[['cards','🃏','cards'],['grid','☰','full list (columns)'],['compact','≡','brief list (name · values)'],['icons','👤','list with icons (avatar, online, typing)']];
const TC_SEP=' | ';

const tcView=n=>n.p.vmode==='cards' ? 'cards' : n.p.vmode==='compact' ? 'compact' : n.p.vmode==='icons' ? 'icons' : 'grid';
const tcCardish=n=>{ const v=tcView(n); return v==='cards' || v==='icons'; };
const tcSchemaOf=m=>({types:{...(m?.types||{})},card:{...(m?.card||{})}});
const tcDef=(n,c)=>n.schema?.types?.[c]||{};
// тип колонки: из схемы, иначе по имени (photo / audio, как раньше)
function tblType(n,c){
  const t=n.schema?.types?.[c]?.t; if(t) return t;
  const low=c.toLowerCase();
  return TBL_PHOTO.test(low) ? 'photo' : TBL_AUDIO.test(low) ? 'audio' : /^avatars?$/.test(low) ? 'image' : low==='online' ? 'online' : low==='typing' ? 'typing' : 'text';
}
// колонки, которые не выводятся значением: показываются аватаркой, точкой статуса, «печатает…»
const tcMetaType=t=>t==='photo' || t==='image' || t==='online' || t==='typing';

/* ---------- аватарки и статусы (общие с Chat) ---------- */
// src: URL (http / https / data / blob / путь), id фото «ph-…», эмодзи; иначе — буква на цветном фоне
function tcAvatar(src,label,px){
  const w=document.createElement('span'); w.className='av-w';
  const el=document.createElement('span'); el.className='av'; w.append(el);
  if(px) w.style.setProperty('--av',px+'px');
  const s=String(src??'').trim(), name=String(label??'').trim();
  const ini=()=>{ el.textContent=(name[0]||'·').toUpperCase(); el.classList.add('none'); el.style.setProperty('--h',tblHue(name||'?')); };
  const img=u=>{
    const im=document.createElement('img'); im.alt=''; im.loading='lazy'; im.referrerPolicy='no-referrer';
    im.onerror=()=>{ im.remove(); ini(); };
    im.src=u; el.append(im);
  };
  if(/^(https?:\/\/|data:image\/|blob:|\.{0,2}\/)/i.test(s)) img(s);
  else if(phIds(s).length) phUrl(phIds(s)[0]).then(u=>{ if(u) img(u); else ini(); });
  else if(s && [...s].length<=2 && !/^[\w.-]+$/.test(s)){ el.textContent=s; el.classList.add('emo'); }
  else ini();
  return w;
}
// online / away / busy / '' (нет или offline); true / 1 / «да» = online
function tcPresence(v){
  if(v===''||v==null||v===false) return '';
  const t=String(v).trim().toLowerCase();
  if(/^(away|idle|afk)$/.test(t)) return 'away';
  if(/^(busy|dnd|occupied)$/.test(t)) return 'busy';
  if(/^(offline|off|0|false|no|нет|-)$/.test(t)) return '';
  return 'online';
}
function tcDot(w,st){
  if(!st) return;
  const d=document.createElement('i'); d.className='av-dot st-'+st; d.title=st; w.append(d);
}
function tcTypingEl(){
  const e=document.createElement('span'); e.className='tc-typing'; e.title='typing';
  e.append(document.createElement('i'),document.createElement('i'),document.createElement('i'));
  return e;
}
// участник из записи: имя, аватарка, статус, «печатает» — по именам полей (name / avatar / online / typing)
function tcPerson(r){
  if(!r || typeof r!=='object') return null;
  const key=re=>Object.keys(r).find(k=>re.test(k));
  const get=re=>{ const k=key(re); return k ? r[k] : undefined; };
  const name=String(get(/^(name|label|title|nick|user)$/i) ?? Object.values(r)[0] ?? '');
  return {name, avatar:get(/^(avatar|icon|image|img|picture|pic|photo)$/i), online:tcPresence(get(/^(online|presence|status)$/i)), typing:tcIsTrue(get(/^typing$/i))};
}
// progress: доля значения на шкале min…max (0…1); не число — null
function tcFrac(n,c,v){
  const d=tcDef(n,c), lo=isFinite(+d.min) && d.min!=='' ? +d.min : 0, hi=isFinite(+d.max) && d.max!=='' ? +d.max : 100, k=typeof v==='number' ? v : parseFloat(v);
  return isFinite(k) && hi>lo ? Math.min(1,Math.max(0,(k-lo)/(hi-lo))) : null;
}
function tcBar(n,c,v,text){
  const f=tcFrac(n,c,v), el=document.createElement('span');
  el.className='tc-bar'; el.title=text;
  if(f==null){ el.textContent=text; return el; }
  const i=document.createElement('i'); i.style.width=(f*100).toFixed(1)+'%';
  el.append(i,Object.assign(document.createElement('b'),{textContent:text}));
  return el;
}
const tcLinks=v=>String(v??'').split('|').map(s=>s.trim()).filter(Boolean);
const tcJoin=a=>a.join(TC_SEP);
const tcIsTrue=v=>v===true || v===1 || /^(1|true|yes|y|да)$/i.test(String(v??'').trim());
/* ---------- файлы из Files ---------- */
const tcFileTok=s=>/^(fl-\d+|ph-[a-z0-9]+)$/i.test(s);
const tcFileIds=v=>[...new Set(String(v??'').split(/[\s,;]+/).filter(tcFileTok))];
const tcFileRec=id=>FileStore.get(/^fl-/i.test(id) ? +id.slice(3) : id).catch(()=>null);
const tcFileOf=r=>'fl-'+r.id;
// выбор файлов в менеджере: двойной клик или «＋ selected»; Promise<[id…]|undefined>
function tcFilePick(multi){
  return new Promise(res=>{
    const got=[], ov=document.createElement('div'); ov.className='fm-ov';
    const box=document.createElement('div'); box.className='fm-pick'; box.style.cssText+='width:min(560px,92vw);height:70vh';
    const host=document.createElement('div'); host.style.cssText='flex:1;min-height:0;display:flex;flex-direction:column';
    const bar=document.createElement('div'); bar.style.cssText='display:flex;gap:6px;align-items:center;justify-content:flex-end';
    const cnt=document.createElement('span'); cnt.className='fm-info'; cnt.style.marginRight='auto';
    const done=v=>{ fm.destroy?.(); ov.remove(); res(v); };
    const add=r=>{
      if(!r) return;
      const id=r.space==='images' && !/^\d+$/.test(String(r.id)) ? String(r.id) : tcFileOf(r);
      if(!multi) return done([id]);
      if(!got.includes(id)) got.push(id);
      cnt.textContent=got.length+' picked';
    };
    const mk=(t,f)=>{ const b=document.createElement('button'); b.textContent=t; b.onclick=f; return b; };
    bar.append(cnt,mk('＋ selected',()=>add(fm.selected)),...(multi ? [mk('OK',()=>done(got))] : []),mk('Cancel',()=>done(undefined)));
    box.append(host,bar); ov.append(box); document.body.append(ov);
    ov.onclick=e=>{ if(e.target===ov) done(undefined); };
    const fm=fmMount(host,{spaces:['files','audio','images'],space:'files',onOpen:add});
  });
}
// имя, значок, просмотр / скачивание; имя подставляется, когда файл прочитан
function tcFileOpen(id){
  tcFileRec(id).then(async r=>{
    if(!r){ alert(id+' is not in this browser (import a backup with the files)'); return; }
    const m=r.mime||'';
    if(m.startsWith('image/')){ phView([id]); return; }
    if(m.startsWith('audio/')){
      const ov=document.createElement('div'); ov.className='fm-ov';
      const box=document.createElement('div'); box.className='fm-pick';
      const a=document.createElement('audio'); a.controls=true; a.autoplay=true; a.src=URL.createObjectURL(r.blob);
      box.append(Object.assign(document.createElement('b'),{textContent:r.name}),a);
      const x=document.createElement('button'); x.textContent='Close'; box.append(x);
      const close=()=>{ a.pause(); URL.revokeObjectURL(a.src); ov.remove(); };
      x.onclick=close; ov.onclick=e=>{ if(e.target===ov) close(); };
      ov.append(box); document.body.append(ov); return;
    }
    fmDownload(r);
  });
}
function tcFileEl(v,preview){
  const box=document.createElement('span'); box.className='tc-chips';
  for(const id of tcFileIds(v)){
    const el=document.createElement('span'); el.className='tc-file'; el.textContent='📎 …'; el.title=id;
    el.onclick=e=>{ e.stopPropagation(); tcFileOpen(id); };
    box.append(el);
    tcFileRec(id).then(async r=>{
      if(!r){ el.textContent='📎 '+id+' (missing)'; return; }
      el.textContent='📎 '+r.name; el.title=r.name+' · '+fmSize(r.size ?? r.blob?.size ?? 0);
      if(preview && (r.mime||'').startsWith('image/')){ const im=document.createElement('img'); im.className='tc-prev'; im.alt=''; phUrl(id).then(u=>{ if(u) im.src=u; }); box.append(im); }
    });
  }
  return box;
}
// подпись записи в связях: колонка имени, иначе первая непустая
const tcKeyCol=cols=>tblCol(cols,TBL_LABEL)||cols[0];
// шаблон названия записи card.label: «{Фамилия} {Имя}»; пусто — колонка имени
const tcTplCols=(cols,card)=>[...String(card?.label||'').matchAll(/\{([^{}]+)\}/g)].map(m=>m[1]).filter(c=>cols.includes(c));
function tcLabelFn(cols,card){
  const tpl=String(card?.label||'');
  if(!tcTplCols(cols,card).length){ const kc=tcKeyCol(cols); return r=>String(r[kc]??''); }
  return r=>tpl.replace(/\{([^{}]+)\}/g,(_,c)=>String(r[c]??'').replace(/\|/g,'/')).replace(/\s+/g,' ').trim();
}
const tcKey=(n,r)=>n.labelFn(r);
// заголовок записи в списке и карточке
const tcHasName=n=>!!(n.nameCol || tcTplCols(n.cl,n.schema?.card).length);
const tcTitle=(n,r,i)=>tcHasName(n) ? n.labelFn(r) : '#'+(i+1);
// card целевого списка связи
async function tcCardOf(n,list){
  if(list===n.p.list) return n.schema?.card;
  const k=tblKind(list);
  return k==='db' ? (await ListDB.getMeta(list))?.card : k==='patch' ? n.p.schema?.card : null;
}
// текст значения для списков и карточек
function tcText(n,c,v){
  if(v===''||v==null) return '';
  const t=tblType(n,c);
  if(t==='bool') return tcIsTrue(v) ? '✓' : '✗';
  if(t==='link') return tcLinks(v).join(', ');
  if(t==='checklist') return '☑ '+v;
  if(t==='file') return tcFileIds(v).length ? '📎'+tcFileIds(v).length : '';
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
  const t=n.schema.types, was=t[c]?.t;
  if(!def || (!def.t || def.t==='text') && !def.opts && !def.to && !def.def && !def.req && !def.src) delete t[c]; else t[c]=def;
  const sv=tcSchemaSave(n);
  // вычисляемое или автонумерация включены / выключены / изменены: значения пересчитываются
  if(was==='calc' || was==='auto' || def?.t==='calc' || def?.t==='auto') return sv.then(()=>trRecalc(n)).then(()=>{ tblRenderView(n); tblRenderList(n); });
  if(was==='checklist' || def?.t==='checklist') return sv.then(()=>tblLoad(n));
  return sv;
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
const tcRelink=(list,oldName,newName)=>tcRelinkMap(list,new Map([[oldName,newName]]));
async function tcRelinkMap(list,map){
  let self=false;
  for(const L of await tcLinkCols(list)){
    for(const it of await ListDB.list(L.list)){
      const v=tcLinks(it.fields[L.col]);
      if(!v.some(x=>map.has(x))) continue;
      it.fields[L.col]=tcJoin(v.map(x=>map.get(x)??x));
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
    const m=await ListDB.getMeta(L.list), cols=m?.cols||[], kc=tcKeyCol(cols), lf=tcLabelFn(cols,m?.card);
    const tpl=tcTplCols(cols,m?.card).length>0;
    for(const it of await ListDB.list(L.list))
      if(tcLinks(it.fields[L.col]).includes(name)) out.push({list:L.list,col:L.col,name:tpl ? lf({...it.fields,name:it.name}) : kc==='name' ? it.name : String(it.fields[kc]??it.name)});
  }
  return out;
}

/* ---------- выбор связанной записи ---------- */
async function tcTargetNames(n,list){
  const t=list===n.p.list ? {cols:n.cl,rows:n.all} : await tblReadList(n,list);
  const lf=tcLabelFn(t.cols,await tcCardOf(n,list));
  return t.rows.map(lf).filter(Boolean);
}
// смена шаблона: ссылки на записи следуют за новыми названиями
async function tcSetLabel(n,tpl){
  if(tblRO(n)) return;
  const old=n.labelFn;
  if(tpl) n.schema.card.label=tpl; else delete n.schema.card.label;
  n.labelFn=tcLabelFn(n.cl,n.schema.card);
  await tcSchemaSave(n);
  if(tblKind(n.p.list)==='db'){
    const map=new Map();
    for(const r of n.all){ const a=old(r), b=n.labelFn(r); if(a && b && a!==b) map.set(a,b); }
    if(map.size) await tcRelinkMap(n.p.list,map);
    await tblLoad(n);
  } else tblRenderList(n);
  tblRenderView(n);
}
// Promise<имена|undefined>; можно создать новую запись в целевом списке
function tcPick(n,list,multi,cur){
  return new Promise(async res=>{
    let names, card, tcCols=[];
    try{ names=await tcTargetNames(n,list); card=await tcCardOf(n,list); tcCols=list===n.p.list ? n.cl : (await tblReadList(n,list)).cols; }catch(e){ alert('Could not read "'+list+'": '+e.message); return res(undefined); }
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
          const fc=tcTplCols(tcCols,card)[0];                  // текст идёт в первую колонку шаблона
          try{ if(list===n.p.list) await tblAdd(n,[{[fc||n.nameCol||'name']:nm}]); else if(fc && fc!=='name') await ListDB.add(list,'',{[fc]:nm}); else await ListDB.add(list,nm,{}); }
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
  if(ty==='auto' || ty==='calc'){                         // значение даёт сама таблица
    const inp=document.createElement('input'); inp.value=v??''; inp.disabled=true; inp.placeholder=ty==='auto' ? 'auto number' : 'calculated';
    return {inp};
  }
  if(ty==='num' || ty==='progress'){
    const inp=document.createElement('input'); inp.type='number'; inp.step='any'; inp.value=v??'';
    if(ty==='progress'){ inp.min=def.min??0; inp.max=def.max??100; }
    inp.addEventListener('keydown',e=>e.stopPropagation());
    return {inp};
  }
  if(ty==='online'){
    const inp=document.createElement('select'), cur=String(v??'');
    for(const o of ['','online','away','busy','offline',...(cur && !['online','away','busy','offline'].includes(cur) ? [cur] : [])]){ const op=document.createElement('option'); op.value=o; op.textContent=o||'—'; inp.append(op); }
    inp.value=cur;
    return {inp};
  }
  if(ty==='bool' || ty==='typing'){
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
  if(ty==='file'){
    const inp=document.createElement('input'); inp.type='hidden'; inp.value=tcFileIds(v).join(' ');
    const bar=document.createElement('span'); bar.className='tf-bar';
    const box=document.createElement('span');
    const upd=()=>{ box.textContent=''; if(tcFileIds(inp.value).length) box.append(tcFileEl(inp.value)); else box.textContent='—'; };
    upd();
    bar.append(box,mkb('📁 pick',async()=>{
      const got=await tcFilePick(true); if(!got) return;
      inp.value=[...new Set([...tcFileIds(inp.value),...got])].join(' '); upd();
    }),mkb('clear',()=>{ inp.value=''; upd(); }));
    return {inp,bar,wide:true};
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
    case 'num': case 'progress': return String(v).trim()==='' ? '' : isFinite(+v) ? +v : v;
    case 'bool': case 'typing': return inp.checked ? 1 : 0;
    case 'date': case 'choice': case 'online': case 'long': case 'link': case 'file': return v;
  }
  return undefined;
}

/* ---------- карточки ---------- */
// поля на карточке: выбранные в схеме, иначе первые заполненные (кроме имени, фото, звука и цвета)
function tcShowCols(n){
  const own=(n.schema?.card?.show||[]).filter(c=>n.cl.includes(c));
  if(own.length) return own;
  return n.cl.filter(c=>c!==n.nameCol && c!==n.colorCol && !['photo','audio','long','image','online','typing'].includes(tblType(n,c))).slice(0,3);
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
// значение поля для карточки: связи — чипы, шкала, файлы, обычный текст
function tcValEl(n,c,v){
  const t=tblType(n,c);
  if(t==='link') return tcChips(n,c,v);
  if(t==='progress') return tcBar(n,c,v,tcText(n,c,v));
  if(t==='checklist') return Object.assign(document.createElement('span'),{className:'tc-v',textContent:tcText(n,c,v)});
  if(t==='file') return tcFileEl(v);
  return Object.assign(document.createElement('span'),{className:'tc-v',textContent:TBL_HZ.test(c)&&isFinite(tblHz(v)) ? fmtHz(tblHz(v),3) : tcText(n,c,v)});
}
const tcHasLines=n=>Array.isArray(n.schema?.card?.lines) && n.schema.card.lines.length>0;
function tcCard(n,i,ro,show){
  const r=n.rows[i], el=document.createElement('div');
  el.dataset.i=i; el.className='tbl-row tbl-card';
  const bg=tblRowBg(n,r);
  if(bg) el.style.setProperty('--rb','color-mix(in srgb,'+bg+' 24%,transparent)');
  const label=tcTitle(n,r,i);
  const cv=document.createElement('div'); cv.className='tc-cover';
  const ids=tcCover(n,r), lines=tcHasLines(n), keys=!lines || !!n.schema.card.keys;
  if(n.schema?.card?.cover==='none') cv.hidden=true;
  else if(ids.length){
    const im=document.createElement('img'); im.loading='lazy'; im.alt=''; cv.append(im);
    phUrl(ids[0]).then(u=>{ if(u) im.src=u; else { im.remove(); cv.textContent='📷'; } });
    if(ids.length>1) cv.append(Object.assign(document.createElement('span'),{className:'tc-n',textContent:'📷'+ids.length}));
  } else {
    cv.classList.add('none'); cv.style.setProperty('--h',tblHue(label||'?'));
    cv.textContent=(label.trim()[0]||'·').toUpperCase();
  }
  const body=document.createElement('div'); body.className='tc-body';
  body.append(Object.assign(document.createElement('div'),{className:'tc-t',textContent:label||'(no name)'}));
  for(const cs of lines ? n.schema.card.lines : show.map(c=>[c])){
    const line=document.createElement('div'); line.className='tc-l'+(lines ? ' tc-ln' : '');
    for(const c of cs){
      const v=r[c]; if(v===''||v==null || !n.cl.includes(c)) continue;
      if(keys) line.append(Object.assign(document.createElement('span'),{className:'tc-k',textContent:c}));
      line.append(tcValEl(n,c,v));
    }
    if(line.children.length) body.append(line);
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
// колонка по роли: тип из схемы (image / online / typing); для статуса ещё «status»
function tcRoleCol(n,t){
  return n.cl.find(c=>tblType(n,c)===t) || (t==='image' ? n.cl.find(c=>tblType(n,c)==='photo') : t==='online' ? n.cl.find(c=>/^(status|presence)$/i.test(c)) : undefined);
}
// строка «список с иконками»: аватарка с точкой статуса · имя · значения или «печатает…»
function tcIconRow(n,i,ro,cols){
  const r=n.rows[i], el=document.createElement('div');
  el.dataset.i=i; el.className='tbl-row tbl-irow';
  const bg=tblRowBg(n,r);
  if(bg) el.style.setProperty('--rb','color-mix(in srgb,'+bg+' 24%,transparent)');
  const label=tcTitle(n,r,i);
  const av=tcAvatar(cols.img ? r[cols.img] : '',label,38);
  if(cols.on) tcDot(av,tcPresence(r[cols.on]));
  const body=document.createElement('div'); body.className='ir-body';
  body.append(Object.assign(document.createElement('div'),{className:'ir-t',textContent:label||'(no name)'}));
  const sub=document.createElement('div'); sub.className='ir-s';
  if(cols.ty && tcIsTrue(r[cols.ty])){ sub.classList.add('typ'); sub.append(tcTypingEl(),' typing'); }
  else sub.textContent=tblSummary(n,r);
  body.append(sub);
  el.append(av,body);
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
  const ui=n.ui, list=ui.list, ro=tblRO(n), N=n.rows.length, e=Math.min(N,TBL_ROWS), icons=tcView(n)==='icons', show=icons ? null : tcShowCols(n);
  const cols=icons ? {img:tcRoleCol(n,'image'),on:tcRoleCol(n,'online'),ty:tcRoleCol(n,'typing')} : null;
  const frag=document.createDocumentFragment();
  for(let i=0;i<e;i++) frag.append(icons ? tcIconRow(n,i,ro,cols) : tcCard(n,i,ro,show));
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

/* ---------- раскладка карточки (панель view) ---------- */
// строки под названием: поля в нужных местах; ▲ ▼ — порядок строк, клик по полю — убрать его
function tcLayoutPanel(n,box,mk,sel){
  const ro=tblRO(n), card=n.schema.card, lines=tcHasLines(n) ? card.lines : null;
  box.append(mk('div','tv-sec','Card layout — title, then lines'));
  const set=fn=>{
    const l=(card.lines||[]).map(x=>x.slice()); fn(l);
    if(l.length) card.lines=l; else delete card.lines;
    tcSchemaSave(n); tblRenderView(n); tblRenderList(n);
  };
  const flag=(txt,title,on,fn)=>{
    const cb=mk('input'); cb.type='checkbox'; cb.checked=on; cb.disabled=ro; cb.addEventListener('change',()=>fn(cb.checked));
    const l=mk('span','tv-lbl',txt); l.title=title; return [cb,l];
  };
  const acts=mk('div','tv-acts');
  if(!lines){
    acts.append(mk('span','tv-lbl','fields from the checkboxes below, one per line'));
    if(!ro) acts.append(mk('button','tbl-btn','customize',{click:()=>set(l=>{ for(const c of tcShowCols(n)) l.push([c]); if(!l.length) l.push([]); })}));
  } else {
    const cols=n.cl.filter(c=>!tcMetaType(tblType(n,c)));
    lines.forEach((ln,i)=>{
      const row=mk('div','tv-lay');
      row.append(mk('span','tv-lbl',(i+1)+'.'));
      for(const c of ln) if(n.cl.includes(c)) { const ch=mk('span','tc-chip',c,{click:()=>{ if(!ro) set(l=>{ l[i]=l[i].filter(x=>x!==c); }); }}); ch.title='remove from the line'; row.append(ch); }
      if(!ro){
        row.append(sel([['','＋ field'],...cols.filter(c=>!ln.includes(c)).map(c=>[c,c])],'',c=>{ if(c) set(l=>{ l.forEach((x,k)=>{ l[k]=x.filter(y=>y!==c); }); l[i].push(c); }); }),
          mk('span','tv-mv','▲',{click:()=>{ if(i) set(l=>{ [l[i-1],l[i]]=[l[i],l[i-1]]; }); }}),
          mk('span','tv-mv','▼',{click:()=>{ if(i<lines.length-1) set(l=>{ [l[i+1],l[i]]=[l[i],l[i+1]]; }); }}),
          mk('span','tv-mv','✕',{click:()=>set(l=>{ l.splice(i,1); })}));
      }
      box.append(row);
    });
    if(!ro) acts.append(mk('button','tbl-btn pri','+ line',{click:()=>set(l=>{ l.push([]); })}),mk('button','tbl-btn','reset',{click:()=>set(l=>{ l.length=0; })}));
    acts.append(...flag('captions','field names before the values',!!card.keys,v=>{ if(v) card.keys=true; else delete card.keys; tcSchemaSave(n); tblRenderList(n); }));
  }
  acts.append(...flag('photo block','the cover (photo or the first letter) on top of a card',card.cover!=='none',v=>{ if(v) delete card.cover; else card.cover='none'; tcSchemaSave(n); tblRenderList(n); }));
  box.append(acts);
}

/* ---------- карточка записи ---------- */
async function tcGo(n,list,name,back){                // перейти к связанной записи; back — возврат по стрелке, в стопку не кладётся
  if(!list) return;
  if(!back){
    n.navBack=n.navBack||[];
    n.navBack.push({list:n.p.list,name:n.curCard?.name??null});
    if(n.navBack.length>30) n.navBack.shift();
  }
  tblCloseEditor(n);
  n.openName=name;                                     // смена списка пересобирает узел: открыть карточку, когда вид готов
  if(list!==n.p.list) await tblPick(n,list);
  tcOpenPending(n);
}
async function tcBack(n){
  const e=n.navBack?.pop(); if(!e) return;
  if(e.name!=null) return tcGo(n,e.list,e.name,true);
  tblCloseEditor(n);
  if(e.list!==n.p.list) await tblPick(n,e.list);
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
  const ro=tblRO(n), label=tcTitle(n,r,i);
  const form=document.createElement('div'); form.className='tbl-form tc-detail';
  const mkb=(t,title,f,cls)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=t; b.title=title; b.className='tbl-btn'+(cls?' '+cls:''); b.addEventListener('click',f); return b; };
  form.cancel=mkb('✕','Close',()=>{ n.navBack=[]; tblCloseEditor(n); });
  const prev=n.navBack?.[n.navBack.length-1];
  if(prev) form.lead=mkb('←','Back to '+(prev.name!=null ? prev.name+' · ' : '')+tblLeaf(prev.list),()=>tcBack(n),'tc-back-btn');
  n.curCard={list:n.p.list,name:label};
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
    const l=document.createElement('div'); l.className='tc-f'+(t==='long' || t==='link' || t==='file' || t==='checklist' ? ' wide' : '');
    l.append(Object.assign(document.createElement('span'),{className:'tc-k',textContent:c}));
    let val;
    if(t==='link') val=tcChips(n,c,v);
    else if(t==='checklist') val=tcChkPanel(n,c,label);
    else if(t==='audio'){ const a=auIds(v); val=mkb('🔊 '+a.length,'Play the audio',()=>auView(a)); }
    else if(t==='progress') val=tcBar(n,c,v,tcText(n,c,v));
    else if(t==='file') val=tcFileEl(v,true);
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
  if(form.lead) nav.append(mkb('←','Back',()=>tcBack(n),'tc-back-btn'));
  nav.append(mkb('◀','Previous entry',()=>tcStep(n,i,-1)),Object.assign(document.createElement('span'),{className:'tc-k',textContent:(i+1)+' / '+n.rows.length}),mkb('▶','Next entry',()=>tcStep(n,i,1)));
  if(!ro) nav.append(mkb('🗑','Delete this entry',async()=>{
    if(!confirm('Delete "'+(label||i+1)+'"?')) return;
    await tblRemove(n,i); tblCloseEditor(n); tblRenderList(n);
  }));
  form.addEventListener('click',e=>{ const ch=e.target.closest('.tc-chip'); if(ch?.dataset.to) tcGo(n,ch.dataset.to,ch.dataset.name); });
  tblOpenEditor(n,'Card',form,n.ui.list.querySelector('.tbl-row[data-i="'+i+'"]'));
}
/* ============================ Чеклист записи ============================
   Колонка типа checklist {to} не хранится: «сделано / всего» считается из записей списка to, у которых связь (link) указывает на
   эту запись, а bool-колонка — «сделано». Значение «3/7» идёт в rows (вместе с check_done / check_total и check_list / check_via /
   check_col / check_key — по ним Map показывает значок и пункты). Нажатие на «☑ 3/7» — пункты в карточке или провал в подсписок:
   список to с фильтром по записи, «←» над списком возвращает на карточку. */
// пункты списка to: {cols, key, via, done, items:[{id, title, done, link:[имена], fields}]}; via / done — явно или по схеме списка
async function tcChkItems(to,via,done,parent){
  if(!to || tblKind(to)!=='db') return null;
  const [items,meta]=await Promise.all([ListDB.list(to),ListDB.getMeta(to)]);
  const {cols,rows}=tblDbRows(items,meta), types=meta?.types||{};
  via=via && cols.includes(via) ? via : cols.find(c=>types[c]?.t==='link' && (!parent || types[c].to===parent));
  done=done && cols.includes(done) ? done : cols.find(c=>types[c]?.t==='bool') || cols.find(c=>/^(done|checked|ok)$/i.test(c));
  if(!via || !done) return null;
  const key=tcKeyCol(cols), lf=tcLabelFn(cols,meta?.card);
  return {to,cols,key,via,done,items:items.map((it,i)=>({id:it.id,fields:it.fields,title:lf(rows[i])||'…',done:tcIsTrue(rows[i][done]),link:tcLinks(rows[i][via])}))};
}
async function tcChkToggle(s,it,val){
  const fields={...it.fields,[s.done]:val ? 1 : 0};
  await ListDB.update(it.id,{fields});
  it.fields=fields; it.done=!!val;
}
async function tcChkAdd(s,label,title){
  title=String(title||'').trim(); if(!title) return;
  const f={[s.via]:label,[s.done]:0};
  if(s.key!=='name') f[s.key]=title;
  await ListDB.add(s.to,s.key==='name' ? title : '',f);
}
// считает колонки checklist записей rows списка list (meta — его схема); true — что-то изменилось
async function tcChkApply(list,meta,cols,rows){
  const cc=cols.filter(c=>meta?.types?.[c]?.t==='checklist');
  if(!cc.length || !rows.length) return false;
  const lf=tcLabelFn(cols,meta?.card), sums=[];
  for(const c of cc){
    const d=meta.types[c], s=await tcChkItems(d.to,d.via,d.done,list), m=new Map();
    if(s) for(const it of s.items) for(const k of it.link){ const e=m.get(k)||{d:0,t:0}; e.t++; if(it.done) e.d++; m.set(k,e); }
    sums.push({c,s,m});
  }
  let ch=false;
  const put=(r,k,v)=>{ if(r[k]!==v){ r[k]=v; ch=true; } };
  for(const r of rows){
    const key=lf(r); let D=0,T=0,first=null;
    for(const x of sums){
      const e=x.m.get(key)||{d:0,t:0};
      put(r,x.c,x.s ? e.d+'/'+e.t : ''); put(r,x.c+'_done',e.d); put(r,x.c+'_total',e.t);
      D+=e.d; T+=e.t; if(!first && x.s) first=x.s;
    }
    put(r,'check_done',D); put(r,'check_total',T);
    if(first){ put(r,'check_list',first.to); put(r,'check_via',first.via); put(r,'check_col',first.done); put(r,'check_key',key); }
  }
  return ch;
}
// пересчёт для активного списка и отмеченных (extra); вызывается после загрузки и при каждой правке хранилища
async function tcChkRoll(n){
  if(n.loading || n.loaded!==n.p.list || tblKind(n.p.list)==='preset') return;
  const tok=n.loadTok, list=n.p.list;
  n.chkCols=n.cl.filter(c=>tcDef(n,c).t==='checklist');
  let ch=false, chx=false;
  try{
    if(n.chkCols.length) ch=await tcChkApply(list,n.schema,n.cl,n.all);
    for(const [k,e] of [...n.extra]){
      if(k===list || tblKind(k)!=='db') continue;
      const m=await ListDB.getMeta(k);
      if(m && await tcChkApply(k,m,e.cols,e.rows)) chx=true;
    }
  }catch(e){ return; }
  if(tok!==n.loadTok) return;
  if(ch){ tblDerive(n); n.uiDirty=true; }
  else if(chx){ tblBands(n); n.uiDirty=true; }
}
// панель пунктов в карточке записи и на карте: галочки, добавление, провал в подсписок
function tcChkView(s,label,opts){
  const box=document.createElement('div'); box.className='tc-chkp'; box.style.cssText='display:flex;flex-direction:column;gap:3px;';
  const head=document.createElement('div'); head.style.cssText='display:flex;gap:6px;align-items:center;';
  const sum=document.createElement('span'), bar=document.createElement('span'), fill=document.createElement('i');
  bar.style.cssText='flex:1;height:6px;border-radius:3px;background:var(--line);overflow:hidden;min-width:40px;';
  fill.style.cssText='display:block;height:100%;background:#4c4;';
  bar.append(fill); head.append(sum,bar);
  if(opts?.open){ const b=document.createElement('button'); b.type='button'; b.className='tbl-btn'; b.textContent='open list ▸'; b.title='Open the items as a list'; b.onclick=opts.open; head.append(b); }
  const list=document.createElement('div');
  const add=document.createElement('div'); add.style.cssText='display:flex;gap:4px;';
  const inp=document.createElement('input'); inp.placeholder='new item'; inp.style.cssText='flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:1px 3px;';
  const go=document.createElement('button'); go.type='button'; go.className='tbl-btn'; go.textContent='＋';
  add.append(inp,go); box.append(head,list,add);
  let cur=s;
  const draw=()=>{
    const mine=cur.items.filter(it=>it.link.includes(label)), d=mine.filter(it=>it.done).length;
    sum.textContent=d+'/'+mine.length; fill.style.width=(mine.length ? d/mine.length*100 : 0)+'%';
    list.replaceChildren(...mine.map(it=>{
      const l=document.createElement('label'); l.style.cssText='display:flex;gap:5px;align-items:center;cursor:pointer;';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=it.done;
      cb.onchange=async()=>{ cb.disabled=true; try{ await tcChkToggle(cur,it,cb.checked); }finally{ draw(); opts?.changed?.(); } };
      const t=document.createElement('span'); t.textContent=it.title; if(it.done) t.style.cssText='text-decoration:line-through;opacity:.6;';
      l.append(cb,t); return l;
    }));
  };
  const reload=async()=>{ const x=await tcChkItems(cur.to,cur.via,cur.done); if(x){ cur=x; draw(); } };
  const addIt=async()=>{ const t=inp.value; if(!t.trim()) return; inp.value=''; await tcChkAdd(cur,label,t); await reload(); opts?.changed?.(); };
  go.onclick=addIt;
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') addIt(); });
  draw();
  return box;
}
function tcChkPanel(n,c,label){
  const w=document.createElement('div'); w.style.cssText='display:flex;flex-direction:column;gap:2px;';
  const d=tcDef(n,c);
  tcChkItems(d.to,d.via,d.done,n.p.list).then(s=>{
    if(!w.isConnected && !s) return;
    if(!s){ w.append(Object.assign(document.createElement('span'),{className:'tc-v',textContent:'set the list of items for this field (⋯ → fields → '+c+')'})); return; }
    w.append(tcChkView(s,label,{open:()=>tcChkDrill(n,c,label),changed:()=>tcChkRoll(n)}));
  }).catch(()=>{});
  return w;
}
// провал в подсписок: список пунктов с фильтром по записи; n.drill — крошка «← запись» над списком
async function tcChkDrill(n,c,label){
  const d=tcDef(n,c), s=await tcChkItems(d.to,d.via,d.done,n.p.list);
  if(!s){ alert('Set the list of items for "'+c+'" first'); return; }
  tblCloseEditor(n);
  n.navBack=n.navBack||[];
  n.navBack.push({list:n.p.list,name:label});
  if(n.navBack.length>30) n.navBack.shift();
  const re='(^| \\| )'+String(label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'( \\| |$)';
  n.drill={to:s.to,via:s.via,label,parent:n.p.list,prevFilter:n.p.filter||''};
  n.p.filter=s.via+' matches "'+re.replace(/[\\"]/g,'\\$&')+'"';
  if(n.ui) n.ui.filter.value=n.p.filter;
  if(s.to!==n.p.list) await tblPick(n,s.to); else { tblDerive(n); tblRenderList(n); }
}
// «←» над подсписком: на карточку записи, из которой провалились
async function tcChkBack(n){
  const d=n.drill; if(!d) return;
  const k=(n.navBack||[]).map(e=>e.list===d.parent && e.name===d.label).lastIndexOf(true);
  if(k>=0) n.navBack.length=k+1;
  else (n.navBack||(n.navBack=[])).push({list:d.parent,name:d.label});
  await tcBack(n);
}
// новый подсписок для checklist: name, связь на этот список, done (bool); возвращает его имя
async function tcChkCreate(n,c){
  const parent=n.p.list, to=parent+' '+c, via=tblLeaf(parent);
  const m=await ListDB.getMeta(to);
  if(!m){
    await tblPut(to,['name',via,'done'],[],{types:{[via]:{t:'link',to:parent},done:{t:'bool'}}});
  }
  return to;
}
function tcStep(n,i,d){
  const N=n.rows.length; if(!N) return;
  const j=(i+d+N)%N; tblSelect(n,j); tcDetail(n,j);
}

