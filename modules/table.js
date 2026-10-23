"use strict";
/* ============================ TABLE ============================ */
// Единый узел-таблица вместо Data Sequencer, Band Plan, Bookmarks, List (CSV/DB) и CSV Log.
// Список = таблица записей. Хранится в одном из мест (параметр list):
//   имя        — локальная БД браузера (ListDB), "папка/имя" — папка; список переживает патч и перезагрузку;
//   @patch     — таблица в самом патче (параметр data): патч переносим вместе с данными;
//   presets/…  — встроенные band plan'ы (папки, modules/bandplan-data.js), только чтение (копируются кнопкой copy).
// Списки — дерево папок с галочками (p.show): bands = объединение отмеченных списков (общий фильтр), редактируется и
// отдаётся построчно активный список (p.list).
// Вход: файл (CSV/TSV/TXT/JSON/KML/GPX/GeoJSON), провода rec и text, числовые входы a–d (лог).
// Выход: по одной записи (секвенсор из modules/sequencer.js), поля — отдельными проводами,
// весь список (отмеченные списки) как bands (для 'sa') и rows (для Graph / Map), выбранная запись — lo/mid/hi/span/step.

const TBL_PATCH='@patch', TBL_PRE='presets/', TBL_ROWS=matchMedia('(pointer:coarse)').matches?120:300, TBL_SAVE_MS=3000;
const TBL_FIXED=new Set([...SEQ_FIXED,'rows','mid','span']);
const TBL_LO=['lo','low','start','freq','frequency'], TBL_HI=['hi','high','end'],
  TBL_LABEL=['name','label','title'], TBL_COLOR=['color','colour'], TBL_STEP=['step'];
const TBL_HZ=/^(lo|hi|low|high|start|end|freq|frequency|step)$/i;
const tblCol=(cl,list)=>{ for(const k of list){ const h=cl.find(x=>x.toLowerCase()===k); if(h) return h; } return null; };
const tblKind=name=>name===TBL_PATCH ? 'patch' : name.startsWith(TBL_PRE) && BANDPLAN_PRESETS[name.slice(TBL_PRE.length)] ? 'preset' : 'db';
// старые имена пресетов (до раскладки по папкам) → новые
const tblCanon=name=>{ const a=name.startsWith(TBL_PRE) && window.BP_ALIAS && BP_ALIAS[name.slice(TBL_PRE.length)]; return a ? TBL_PRE+a : name; };
const tblDir=name=>name.slice(0,name.lastIndexOf('/')+1);          // «папка/» или ''
const tblLeaf=name=>name.slice(name.lastIndexOf('/')+1);
// отмеченные для показа списки; без p.show (старые патчи) — только активный
const tblShow=n=>new Set((Array.isArray(n.p.show) ? n.p.show : [n.p.list]).map(tblCanon));
const tblRO=n=>tblKind(n.p.list)==='preset';
const tblHz=v=>typeof v==='number' ? v : parseHzCell(v);
const tblSame=(a,b)=>a.length===b.length && a.every((x,i)=>x===b[i]);

/* ---------- разбор файлов ---------- */
// → таблица [[заголовки],[строка],…]
function tblParse(text,ext){
  const t=String(text).replace(/^﻿/,''), head=t.trimStart();
  if(ext==='json' || ext==='jsonl' || ext==='ndjson' || head[0]==='[' || head[0]==='{'){
    let o;
    try{ o=JSON.parse(t); }
    catch(e){
      const lines=t.split(/\r?\n/).filter(l=>l.trim());     // JSON Lines
      try{ o=lines.map(l=>JSON.parse(l)); }catch(e2){ throw new Error('invalid JSON'); }
    }
    if(o && (o.type==='FeatureCollection' || o.type==='Feature')) return seqGeoJson(t);
    if(o && !Array.isArray(o)){
      const arr=Object.values(o).find(v=>Array.isArray(v) && v.length && typeof v[0]==='object');
      o=arr || [o];
    }
    if(!o.length) throw new Error('no data');
    if(Array.isArray(o[0])) return o.map(r=>r.map(v=>v==null ? '' : recFmt(v,true)));
    const keys=[], seen=new Set();
    for(const r of o) for(const k in r) if(!seen.has(k)){ seen.add(k); keys.push(k); }
    return [keys,...o.map(r=>keys.map(k=>r[k]==null ? '' : recFmt(r[k],true)))];
  }
  if(ext==='txt'){
    const nl=t.indexOf('\n'), first=nl<0 ? t : t.slice(0,nl);
    if(!/[,;\t]/.test(first)){                            // обычный текст: строка — запись
      const lines=t.split(/\r?\n/).filter(l=>l.trim());
      if(!lines.length) throw new Error('no data');
      return [['text'],...lines.map(l=>[l])];
    }
  }
  return seqParse(t,ext,true);
}
// таблица → {cols, rows:[{col:value}]}; числа приводятся к числам
function tblFromTable(table){
  const cols=hostlistDedupFieldNames(table[0]);
  const hz=cols.map(c=>TBL_HZ.test(c));                   // частотные поля: 7.1M, 433k, 14 MHz → число
  const rows=table.slice(1).map(r=>{
    const o={};
    cols.forEach((c,i)=>{ const v=hostlistCoerce(r[i]??''); const h=hz[i] && typeof v==='string' && v ? parseHzCell(v) : NaN; o[c]=isFinite(h) ? h : v; });
    return o;
  });
  return {cols,rows};
}
// поля пакета → колонки. p.pfields: «col=src, src2», src — путь a.b.c в записи или поле разбора hex по её hexSchema
// (hexSchema нет — схема по содержимому); «*» — все поля разбора. Без «col=» колонка зовётся как src (точки → _)
function tblPspec(n){
  const t=String(n.p.pfields||'');
  if(n._pfSrc!==t){
    n._pfSrc=t;
    n._pf=t.split(/[,;\n]/).map(x=>x.trim()).filter(Boolean).map(x=>{
      const i=x.indexOf('='), src=(i<0 ? x : x.slice(i+1)).trim();
      return {src, col:i<0 ? src.replace(/\./g,'_') : x.slice(0,i).trim(), alias:i>=0};
    }).filter(x=>x.src && x.col);
  }
  return n._pf;
}
function tblHexRec(r){
  try{
    const h=r.hex;
    const b=h instanceof Uint8Array ? h : typeof h==='string' && h ? hexFromHex(h) : null;
    if(!b || !b.length) return null;
    const name=r.hexSchema && HEX_LIB[r.hexSchema] ? r.hexSchema : hexDetect(b) || null;
    return name ? hexToRec(hexParse(hexSchema(name),b)) : null;
  }catch(e){ return null; }
}
function tblPacket(n,r){
  const spec=tblPspec(n);
  if(!spec.length || !r || typeof r!=='object') return r;
  let pk;                                               // разбор hex — только если он понадобился
  const parsed=()=>pk===undefined ? (pk=tblHexRec(r)) : pk;
  const o={...r};
  for(const f of spec){
    if(f.src==='*'){ const p=parsed(); if(p) for(const k in p) if(k[0]!=='_' && !(k in o)) o[k]=p[k]; continue; }
    if(!f.alias && f.col in o) continue;
    let v=r;
    for(const k of f.src.split('.')){
      if(typeof v==='string' && /^\s*[{[]/.test(v)) try{ v=JSON.parse(v); }catch(e){}     // в списке объекты хранятся текстом
      v=v!=null && typeof v==='object' && !(v instanceof Uint8Array) ? v[k] : undefined;
    }
    if(v===undefined){ const p=parsed(); v=p ? p[f.src] : undefined; }
    if(v!==undefined) o[f.col]=v;
  }
  return o;
}
// поля пакета — в уже записанные строки (пустые ячейки), новые колонки добавляются
async function tblBackfill(n){
  if(tblRO(n) || n.loaded!==n.p.list || !tblPspec(n).length || !n.all.length) return;
  const dirty=[]; let grown=false;
  n.all.forEach((row,i)=>{
    const src={}; for(const c in row) if(row[c]!=='' && row[c]!=null) src[c]=row[c];
    const res=tblClean(tblPacket(n,src));
    let hit=false;
    for(const k in res){
      if(row[k]!=='' && row[k]!=null) continue;
      if(!n.cl.includes(k)){ n.cl.push(k); grown=true; }
      if(res[k]!=='' && res[k]!=null){ row[k]=res[k]; hit=true; tblBump(row); }
    }
    if(hit) dirty.push(i);
  });
  if(!dirty.length && !grown) return;
  for(const r of n.all) for(const c of n.cl) if(r[c]===undefined) r[c]='';
  if(tblKind(n.p.list)==='db'){
    try{
      for(const i of dirty){ const it=tblToItem(n.all[i],n.cl,n.virt); await ListDB.update(n.ids[i],{name:it.name,fields:it.fields,value:it.fields.value??''}); }
      if(grown) await tblMetaSet(n.p.list,{cols:n.cl});
    }catch(e){ alert('storage: '+(e.message||e)); return; }
  } else await tblSave(n);
  if(grown) tblSetCols(n,n.cl.slice(),false);
  tblDerive(n);
  if(n.ui) tblRenderAll(n);
}
// запись для хранения: объекты и байты — в текст
// правила полей (table-rules.js) для новых записей: strict — исключение при нарушении, иначе нарушившие пропускаются
function tblCheck(n,recs,strict,except=-1){
  const pr=trPrepare(n,recs,except,except<0);
  if(pr.bad.length){
    if(strict) throw new Error(pr.bad[0].why);
    n.rejected=(n.rejected||0)+pr.bad.length; n.lastReject=pr.bad[0].why;
  }
  return pr.ok;
}
const tblClean=r=>{ const o={}; for(const k in r){ const v=r[k]; o[k]=v==null ? '' : typeof v==='object' ? recFmt(v,true) : v; } return o; };

/* ---------- фильтр ---------- */
// узел с проводом filter (Graph.sel…): строки, где любое поле целиком равно тексту; вместе с набранным фильтром
function tblFilterOf(n,err){
  const f=tblFilter(n.p.filter,err), w=String(n.wf||'').trim().toLowerCase();
  if(!w) return f;
  const g=r=>{ for(const k in r) if(String(r[k]??'').toLowerCase()===w) return true; return false; };
  return f ? r=>f(r) && g(r) : g;
}
// слова через пробел, все должны совпасть: «20m» — с начала слова любого поля, «col:text» — в конкретном поле,
// «col>5M», «col<=100», «col=x» — сравнение (числа с k/M/G понимаются); «a|b» — любое из,
// НЕ: «-слово», «!слово», «not слово», «-col:x», «col!=x», «col!:x» — исключить,
// «col:» без значения — поле не пусто (to: — записи, где есть адресат)
// выражение в стиле Wireshark (kind == "beacon" && rssi > -50, wsfilter-kernels.js) — вместо слов; ошибка разбора — в err.msg, фильтр не применяется
function tblFilter(q,err){
  if(err) err.msg='';
  if(wsLooksLike(q)){
    try{ return wsCompile(q,tblHz); }catch(e){ if(err) err.msg=e.message; return null; }
  }
  q=String(q||'').trim().toLowerCase(); if(!q) return null;
  const terms=[]; let not=false;
  for(let w of q.split(/\s+/)){
    if(w==='not' || w==='!'){ not=!not; continue; }
    let neg=not; not=false;
    while(w.length>1 && (w[0]==='-' || w[0]==='!')){ neg=!neg; w=w.slice(1); }
    const m=w.match(/^([^:<>=!]+)(!=|!:|:|>=|<=|>|<|=)(.*)$/);
    const t=m ? {col:m[1],op:m[2],val:m[3]} : {val:w};
    if(t.op==='!=' || t.op==='!:'){ neg=!neg; t.op=t.op==='!=' ? '=' : ':'; }
    t.neg=neg; t.alts=t.val.split('|');
    terms.push(t);
  }
  const words=v=>String(v??'').toLowerCase().split(/[\s/()]+/);
  const startsWord=(v,s)=>{ const str=String(v??'').toLowerCase(); return str.startsWith(s) || words(v).some(w=>w.startsWith(s)); };
  const cmp=(v,op,s)=>{
    const a=tblHz(v), b=tblHz(s);
    if(isFinite(a) && isFinite(b)) return op==='>' ? a>b : op==='<' ? a<b : op==='>=' ? a>=b : op==='<=' ? a<=b : a===b;
    const x=String(v??'').toLowerCase(); return op==='=' || op===':' ? x===s : false;
  };
  const test=t=>{
    if(t.col===undefined) return t.alts.some(a=>Object.values(r0).some(v=>startsWord(v,a)));
    const k=Object.keys(r0).find(c=>c.toLowerCase()===t.col);
    if(k===undefined) return false;
    if(t.op===':'){
      if(t.val==='') return r0[k]!=='' && r0[k]!=null;
      const s=String(r0[k]??'').toLowerCase(); return t.alts.some(a=>s.includes(a));
    }
    return t.alts.some(a=>cmp(r0[k],t.op,a));
  };
  let r0;
  if(!terms.length) return null;
  return r=>{ r0=r; return terms.every(t=>test(t)!==t.neg); };
}

/* ---------- хранилище ---------- */
function tblSplit(name){ const i=name.indexOf('/'); return i<0 ? ['',name] : [name.slice(0,i),name.slice(i+1)]; }
// DB-запись ↔ строка таблицы: name — поле 'name', остальное — fields
const tblToItem=(r,cl,virt)=>{ const f={}; for(const k of cl) if(k!=='name' && !virt?.has(k)) f[k]=r[k]??''; return {name:virt?.has('name') ? '' : String(r.name??''),fields:f}; };
function tblPresetRows(name){
  const src=BANDPLAN_PRESETS[name], kd=src.some(r=>r[6]), nt=src.some(r=>r[5]);
  const rows=src.map(([lo,hi,label,step,color,note,kind])=>{
    const o={name:label,lo,hi,step:step||0,color:color||''};
    if(kd) o.kind=kind||'';
    if(nt) o.note=note||'';
    return o;
  });
  return {cols:['name','lo','hi','step','color',...(kd?['kind']:[]),...(nt?['note']:[])],rows};
}
// список из DB: колонки и строки (общий разбор для активного и отмеченных списков)
function tblDbRows(items,meta){
  const keys=[], seen=new Set(); let hasName=false;
  for(const it of items){
    if(it.name) hasName=true;
    for(const k in it.fields) if(k!=='name' && !seen.has(k)){ seen.add(k); keys.push(k); }
  }
  const cols=meta?.cols ? meta.cols.slice() : (hasName ? ['name'] : []).concat(keys);
  if(hasName && !cols.includes('name')) cols.unshift('name');
  for(const k of keys) if(!cols.includes(k)) cols.push(k);
  const rows=items.map(it=>{ const o={}; for(const c of cols) o[c]=hostlistCoerce(c==='name' ? it.name : it.fields[c] ?? ''); return o; });
  return {cols,rows};
}
// любой список → {cols,rows} без касания состояния узла
async function tblReadList(n,name){
  const kind=tblKind(name);
  if(kind==='preset') return tblPresetRows(name.slice(TBL_PRE.length));
  if(kind==='patch'){ const text=String(n.p.data||'').trim(); return text ? tblFromTable(seqParse(text,'',true)) : {cols:[],rows:[]}; }
  const [items,meta]=await Promise.all([ListDB.list(name),ListDB.getMeta(name)]);
  return tblDbRows(items,meta);
}

async function tblLoad(n){
  n.p.list=tblCanon(n.p.list);
  n.loading=true;
  try{ await tblLoadRun(n); } finally{ n.loading=false; }
  n._chkRev=ListDB.rev; await tcChkRoll(n);
}
async function tblLoadRun(n){
  const list=n.p.list, kind=tblKind(list), tok=n.loadTok=(n.loadTok||0)+1;
  let cols=[], rows=[], ids=[], schema={types:{},card:{}};
  if(kind==='preset'){ const t=tblPresetRows(list.slice(TBL_PRE.length)); cols=t.cols; rows=t.rows; ids=rows.map((_,i)=>i); }
  else if(kind==='patch'){
    const text=String(n.p.data||'').trim();
    n.err='';
    if(text) try{ const t=tblFromTable(seqParse(text,'',true)); cols=t.cols; rows=t.rows; }catch(e){ n.err=e.message; }
    ids=rows.map((_,i)=>i); schema=tcSchemaOf(n.p.schema);
  } else {
    let items=[], meta=null;
    try{ [items,meta]=await Promise.all([ListDB.list(list),ListDB.getMeta(list)]); }
    catch(e){ n.err='storage: '+(e.message||e); }
    if(tok!==n.loadTok) return;
    ({cols,rows}=tblDbRows(items,meta));
    ids=items.map(it=>it.id); schema=tcSchemaOf(meta);
  }
  n.loaded=list; n.loadedData=kind==='patch' ? n.p.data : null;
  n.all=rows; n.ids=ids; n.cl=cols; n.schema=schema;
  trCalcAll(n);
  // стартовая загрузка не трогает провода: их порты задаёт сохранённый p.cols; смена списка — пользователем
  if(n.wantCols){ n.wantCols=false; tblSetCols(n,cols,true); }
  else if(!n.p.cols.length && cols.length) tblSetCols(n,cols,false);
  tblDerive(n);
  seqReset(n);
  if(n.p.sel!=null){ const j=n.rowIds.indexOf(n.p.sel); if(j>=0){ n.pick=j; n.idx=j; n.cur={...n.rows[j]}; } }
  tblSyncExtra(n);
  tblRefLoad(n);
  if(n.ui) tblRenderAll(n);
}
// p.cols (порты) := cols. prune — убрать провода к исчезнувшим портам
function tblSetCols(n,cols,prune){
  if(tblSame(cols,n.p.cols)) return;
  n.p.cols=cols.slice();
  tblPorts(n);
  tblRebuild(n,prune);
}
function tblRebuild(n,prune){
  if(!n.el) return;                                     // init: DOM ещё не собран, порты возьмутся из n.cols
  if(prune){
    const vi=new Set(portsOf(n,'ins').map(p=>p.n)), vo=new Set(portsOf(n,'outs').map(p=>p.n));
    Graph.edges.filter(e=>(e.to===n.id && !vi.has(e.tp)) || (e.from===n.id && !vo.has(e.fp))).forEach(delEdge);
  }
  // UI таблицы живёт в .mid: при смене одних портов пересобираем только колонки пинов, список не мигает
  if(!(n.ui && n.initialized && !n.ghost && !dashMode && rebuildPorts(n))){ n.initialized=false; rebuildNode(n); }
  markTopoDirty();
}
// порты полей: p.pout — отмеченные колонки (нет — все, как в старых патчах); p.pref {связь:[поля]} — поля связанной записи «Связь.Поле»
function tblPorts(n){
  const used=new Set(TBL_FIXED), cols=n.p.cols||[], out=n.p.pout, pref=n.p.pref||{};
  const hs=(Array.isArray(out) ? cols.filter(h=>out.includes(h)) : cols).map(h=>({h}));
  for(const c in pref) if(cols.includes(c)) for(const f of pref[c]) hs.push({h:c+'.'+f,ref:[c,f]});
  n.cols=hs.map(x=>{ let port=x.h; while(used.has(port)) port+='_'; used.add(port); return {...x,port}; });
}
function tblPortsApply(n){
  tblPorts(n);
  tblRebuild(n,true);
  Undo.push();
}
function tblOutSet(n,c,on){
  const s=new Set(Array.isArray(n.p.pout) ? n.p.pout : n.p.cols);
  on ? s.add(c) : s.delete(c);
  n.p.pout=n.p.cols.filter(k=>s.has(k));
  tblPortsApply(n);
}
function tblRefSet(n,c,f,on){
  const pr={...(n.p.pref||{})}, a=new Set(pr[c]||[]);
  on ? a.add(f) : a.delete(f);
  if(a.size) pr[c]=[...a]; else delete pr[c];
  n.p.pref=pr;
  tblRefLoad(n);
  tblPortsApply(n);
}
// записи целевых списков связей по подписи — для портов «Связь.Поле»
async function tblRefLoad(n){
  const m=new Map();
  for(const c in n.p.pref||{}){
    const list=tcDef(n,c).to;
    if(!list || m.has(list)) continue;
    try{
      const t=list===n.p.list ? {cols:n.cl,rows:n.all} : await tblReadList(n,list);
      const lf=tcLabelFn(t.cols,await tcCardOf(n,list)), idx=new Map();
      for(const r of t.rows){ const k=lf(r); if(k && !idx.has(k)) idx.set(k,r); }
      m.set(list,idx);
    }catch(e){}
  }
  n.refIdx=m;
}
function tblRefVal(n,c){
  const row=n.cur||n.rows[n.idx], nm=row && tcLinks(row[c.ref[0]])[0];
  const r=nm ? n.refIdx?.get(tcDef(n,c.ref[0]).to)?.get(nm) : null;
  return r ? r[c.ref[1]]??'' : '';
}
// фильтр, столбцы времени/координат, bands
function tblDerive(n){
  const E={}, f=tblFilterOf(n,E);
  n.ferr=E.msg||''; n.fOn=!!(String(n.p.filter||'').trim() || n.wf);
  if(f){
    n.rows=[]; n.rowIds=[];
    n.all.forEach((r,i)=>{ if(f(r)){ n.rows.push(r); n.rowIds.push(n.ids[i]); } });
  } else { n.rows=n.all.slice(); n.rowIds=n.ids.slice(); }      // новая ссылка: потребители ключуют кэш по массиву, а n.all дописывается на месте
  const sc=n.p.sortCol;
  if(sc && n.cl.includes(sc)){                                  // сортировка по клику на заголовок колонки; пустые — в конец
    const dir=n.p.sortDir<0 ? -1 : 1, cmp=(a,b)=>{
      const x=a[sc], y=b[sc], ex=x===''||x==null, ey=y===''||y==null;
      if(ex||ey) return ex-ey;
      const nx=typeof x==='number' ? x : parseFloat(x), ny=typeof y==='number' ? y : parseFloat(y);
      return (isFinite(nx) && isFinite(ny) && String(nx)===String(x).trim() && String(ny)===String(y).trim() ? nx-ny : String(x).localeCompare(String(y),undefined,{numeric:true}))*dir;
    };
    const ix=n.rows.map((_,i)=>i).sort((i,j)=>cmp(n.rows[i],n.rows[j])||i-j);
    n.rows=ix.map(i=>n.rows[i]); n.rowIds=ix.map(i=>n.rowIds[i]);
  }
  if(n.p.rev){ n.rows.reverse(); n.rowIds.reverse(); }          // новые сверху: записи всегда дописываются в конец списка
  n.headers=n.cl;
  n.nameCol=tblCol(n.cl,TBL_LABEL); n.colorCol=tblCol(n.cl,TBL_COLOR);
  n.labelFn=tcLabelFn(n.cl,n.schema?.card);
  tblPorts(n);
  n.timeCol=seqFind(n.cl,n.p.tcol,SEQ_TIME_COLS);
  n.latCol=seqFind(n.cl,n.p.latCol,SEQ_LAT_COLS);
  n.lonCol=seqFind(n.cl,n.p.lonCol,SEQ_LON_COLS);
  n.tt=null;
  if(n.timeCol){ let prev=0; n.tt=n.rows.map(r=>{ const v=seqTime(r[n.timeCol]); if(v!=null) prev=v; return prev; }); }
  n.geo=!!(n.latCol && n.lonCol);
  tblBands(n);
  n.uiDirty=true;                                              // что изменилось в строках — видно по сигнатурам в tblRenderList
  tblFilterMark(n);
}
// записи списка для выхода rows: строка как есть, а у строк с частотой — ещё и числовые lo / hi / step и label / color
// (диапазон для спектра и сканеров; потребителям записей без lo они просто не видны)
function tblRowsOut(cl,rows){
  const lo=tblCol(cl,TBL_LO);
  if(!lo) return rows;
  const hi=tblCol(cl,TBL_HI), lb=tblCol(cl,TBL_LABEL), co=tblCol(cl,TBL_COLOR), st=tblCol(cl,TBL_STEP);
  return rows.map(r=>{
    const l=tblHz(r[lo]); if(!isFinite(l)) return r;
    let h=hi ? tblHz(r[hi]) : l; if(!isFinite(h)) h=l;
    const s=st ? tblHz(r[st]) : 0;
    const o={...r, lo:l, hi:Math.max(l,h), label:lb ? String(r[lb]??'') : fmtHz(l)+'Hz', step:isFinite(s) ? s : 0};
    if(co) o.color=String(r[co]||'');
    return o;
  });
}
function tblBands(n){
  n.loCol=tblCol(n.cl,TBL_LO); n.hiCol=tblCol(n.cl,TBL_HI);
  n.rowsOwn=tblRowsOut(n.cl,n.rows);
  n.rowsAllOwn=n.fOn ? tblRowsOut(n.cl,n.all) : n.rowsOwn;              // все строки списка, без фильтра
  const f=tblFilterOf(n);                               // тот же фильтр — и для остальных отмеченных списков
  for(const e of n.extra.values()){ e.rowsF=f ? e.rows.filter(f) : e.rows; e.out=tblRowsOut(e.cols,e.rowsF); }
  tblMerge(n);
}
// rows = активный список (если отмечен) + остальные отмеченные
function tblMerge(n){
  const sh=tblShow(n), rp=[];
  if(sh.has(n.p.list)) rp.push(n.rowsOwn);
  for(const [k,e] of n.extra) if(sh.has(k) && k!==n.p.list) rp.push(e.out||e.rowsF||e.rows);
  n.rowsOut=rp.length===1 ? rp[0] : [].concat(...rp);                            // записи всех отмеченных списков; новая ссылка на каждое изменение — потребитель видит смену набора
  n.onCount=sh.size;
}
// загрузить отмеченные, но ещё не прочитанные списки; убрать снятые
function tblSyncExtra(n){
  n._showRef=n.p.show;
  const sh=tblShow(n);
  for(const k of [...n.extra.keys()]) if(!sh.has(k) || k===n.p.list) n.extra.delete(k);
  const need=[...sh].filter(k=>k!==n.p.list && !n.extra.has(k));
  tblMerge(n);
  if(!need.length) return;
  const tok=n.extraTok=(n.extraTok||0)+1;
  Promise.all(need.map(async k=>[k,await tblReadList(n,k).catch(()=>null)])).then(res=>{
    if(tok!==n.extraTok) return;
    const now=tblShow(n);
    for(const [k,t] of res) if(t && now.has(k) && k!==n.p.list) n.extra.set(k,{cols:t.cols,rows:t.rows,rowsF:t.rows,out:[]});
    tblBands(n); n.uiDirty=true;
  });
}

/* ---------- изменения ---------- */
async function tblSave(n){                              // записать итог в хранилище
  const kind=tblKind(n.p.list);
  if(kind==='patch'){
    const csv=n.cl.length ? seqToCsv([n.cl,...n.all.map(r=>n.cl.map(c=>r[c]))]) : '';
    n.p.data=csv; n.loadedData=csv;
    if(n.set?.data) n.set.data(csv);
  }
}
async function tblSaveCols(n){
  if(tblKind(n.p.list)==='db') await tblMetaSet(n.p.list,{cols:n.cl});
  else await tblSave(n);
}
// upsert по ключевой колонке: повтор обновляет строку (непустые поля), count/first/last ведутся сами; → новые строки
const TBL_STAT=['count','first','last'];
// версия строки, меняемой на месте (upsert, sync, backfill): Graph по ней узнаёт, какие строки набора разбирать заново
const TBL_REV=new WeakMap(), tblBump=r=>TBL_REV.set(r,(TBL_REV.get(r)|0)+1);
async function tblUpsert(n,recs,key){
  let grown=false;
  for(const c of [key,...TBL_STAT]) if(!n.cl.includes(c)){ n.cl.push(c); grown=true; }
  const kind=tblKind(n.p.list), now=Date.now();
  const at=new Map(); n.all.forEach((r,i)=>{ const k=r[key]; if(k!=='' && k!=null) at.set(String(k),i); });
  const fresh=new Map(), dirty=new Set();
  for(const r of recs){
    const kv=r[key]; if(kv===''||kv==null) continue;
    const k=String(kv), t=typeof r.t==='number' ? r.t : now;
    const row=at.has(k) ? n.all[at.get(k)] : fresh.get(k);
    if(row){
      for(const c in r) if(r[c]!=='' && !TBL_STAT.includes(c)){ row[c]=r[c]; if(!n.cl.includes(c)){ n.cl.push(c); grown=true; } }
      row.count=(+row.count||1)+1; row.last=t; if(row.first===''||row.first==null) row.first=t;
      tblBump(row);
      if(at.has(k)) dirty.add(at.get(k));
    } else {
      for(const c in r) if(!n.cl.includes(c)){ n.cl.push(c); grown=true; }
      fresh.set(k,{...r,count:1,first:t,last:t});
    }
  }
  for(const i of dirty) trCalcRow(n,n.all[i]);
  if(kind==='db') for(const i of dirty){
    const it=tblToItem(n.all[i],n.cl,n.virt);
    await ListDB.update(n.ids[i],{name:it.name,fields:it.fields,value:it.fields.value??''});
  }
  return {fresh:[...fresh.values()],grown};
}
// добавление записей; новые поля расширяют колонки (и порты — без потери проводов)
async function tblAdd(n,recs,strict){                  // strict (форма): нарушение правил — исключение; иначе такие записи пропускаются
  if(tblRO(n) || !recs.length) return;
  recs=recs.map(r=>tblClean(tblPacket(n,r)));
  let grown=false;
  if(n.p.key && n.p.key.trim()){
    const u=await tblUpsert(n,recs,n.p.key.trim());
    recs=u.fresh; grown=u.grown;
    if(!recs.length){
      await tblSaveCols(n);
      if(grown) tblSetCols(n,n.cl.slice(),false);
      tblDerive(n); return;
    }
  }
  for(const r of recs) for(const k in r) if(!n.cl.includes(k)){ n.cl.push(k); grown=true; }
  recs=tblCheck(n,recs,strict); if(!recs.length) return;
  const kind=tblKind(n.p.list);
  const rows=recs.map(r=>{ const o={}; for(const c of n.cl) o[c]=r[c]??''; return o; });
  let ids;
  if(kind==='db'){
    try{
      ids=await ListDB.addMany(n.p.list,rows.map(r=>tblToItem(r,n.cl,n.virt)));
      if(grown) await tblMetaSet(n.p.list,{cols:n.cl});
    }catch(e){ alert('storage: '+(e.message||e)); return; }
  } else ids=rows.map((_,i)=>n.all.length+i);
  n.all.push(...rows); n.ids.push(...ids);
  // потолок: старые записи уходят (лог не растёт бесконечно)
  const cap=kind==='patch' ? Math.min(+n.p.maxRows||1000,1000) : +n.p.maxRows||0;
  if(cap>0 && n.all.length>cap){
    const drop=n.ids.splice(0,n.all.length-cap); n.all.splice(0,drop.length);
    if(kind==='db') await ListDB.removeMany(drop).catch(()=>{});
    n.idx=Math.max(0,n.idx-drop.length);
  }
  // CSV всех строк (до 1000) + запись параметра на каждый сброс — O(N) дважды в секунду; при потоке записей копим и пишем реже
  if(kind==='patch'){
    if(grown || performance.now()-(n.saveT||0)>TBL_SAVE_MS){ n.saveT=performance.now(); n.saveLate=false; await tblSave(n); }
    else if(!n.saveLate){ n.saveLate=true; setTimeout(()=>{ if(n.saveLate && !n.disposed){ n.saveLate=false; n.saveT=performance.now(); tblSave(n); } },TBL_SAVE_MS); }
  }
  if(grown) tblSetCols(n,n.cl.slice(),false);
  tblDerive(n);
}
async function tblUpdate(n,i,rec){
  if(tblRO(n)) return;
  const row=n.rows[i], k=n.all.indexOf(row), id=n.rowIds[i];
  rec=tblCheck(n,[rec],true,k)[0];
  const o={}; for(const c of n.cl) o[c]=rec[c]??'';
  n.all[k]=o;
  if(tblKind(n.p.list)==='db'){
    const it=tblToItem(o,n.cl,n.virt);
    await ListDB.update(id,{name:it.name,fields:it.fields,value:it.fields.value??''});
    const was=n.labelFn(row), now=n.labelFn(o);
    if(was && now && was!==now && await tcRelink(n.p.list,was,now)){ await tblLoad(n); return; }   // связи на запись следуют за её именем
  } else await tblSave(n);
  tblDerive(n);
}
async function tblRemove(n,i){
  if(tblRO(n)) return;
  const row=n.rows[i], k=n.all.indexOf(row), id=n.ids[k];
  n.all.splice(k,1); n.ids.splice(k,1);
  if(tblKind(n.p.list)==='db') await ListDB.remove(id);
  else { n.ids=n.all.map((_,j)=>j); await tblSave(n); }
  if(n.p.sel===id) n.p.sel=null;
  tblDerive(n);
  n.idx=Math.min(n.idx,Math.max(0,n.rows.length-1));
}
// записи с rec: обычные — в очередь (upsert по ключу); _delete — удалить строку; _was — переименовать (ключ был _was, стал значением в колонке key).
// flush — сразу записать (вызов напрямую, когда движок остановлен и по проводу ничего не идёт)
function tblIngest(n,recs,flush){
  if(tblRO(n) || !n.p.collect) return;
  const del=[], ren=[];
  for(const r of recs) if(r && typeof r==='object') (r._delete ? del : r._was!=null ? ren : n.pend).push(r);
  if(del.length) tblDelRecs(n,del);
  if(ren.length) tblRenameRecs(n,ren);
  if(flush && n.pend.length) tblFlush(n);
}
async function tblRenameRecs(n,recs){
  const key=String(n.p.key||'').trim();
  for(const r of recs){
    const {_was,...rest}=r, k=key ? n.all.findIndex(x=>String(x[key])===String(_was)) : -1;
    if(k>=0 && String(rest[key])!==String(_was) && !n.loading && !tblRO(n)){
      const row=n.all[k], o={...row,[key]:rest[key]}, was=n.labelFn(row);
      n.all[k]=o;
      if(tblKind(n.p.list)==='db'){
        const it=tblToItem(o,n.cl,n.virt);
        await ListDB.update(n.ids[k],{name:it.name,fields:it.fields,value:it.fields.value??''});
        const now=n.labelFn(o);
        if(was && now && was!==now && await tcRelink(n.p.list,was,now)){ await tblLoad(n); n.pend.push(rest); continue; }
      } else await tblSave(n);
      tblDerive(n); n.uiDirty=true; n.uiFull=true;
    }
    n.pend.push(rest);                                    // остальные поля — обычным upsert по новому ключу
  }
  if(n.pend.length) tblFlush(n);
}
// запись с _delete на rec: удаляет строку с тем же значением в колонке upsert key (так карта удаляет точки)
async function tblDelRecs(n,recs){
  const key=String(n.p.key||'').trim();
  if(!key || tblRO(n) || n.loading) return;
  for(const r of recs){
    const k=n.all.findIndex(x=>String(x[key])===String(r[key]));
    if(k<0) continue;
    const id=n.ids[k];
    n.all.splice(k,1); n.ids.splice(k,1);
    if(tblKind(n.p.list)==='db') await ListDB.remove(id);
    else { n.ids=n.all.map((_,j)=>j); await tblSave(n); }
    if(n.p.sel===id) n.p.sel=null;
  }
  tblDerive(n); n.uiDirty=true; n.uiFull=true;
}
async function tblClear(n){
  if(tblRO(n)) return;
  if(tblKind(n.p.list)==='db') await ListDB.removeMany(n.ids);
  n.all=[]; n.ids=[]; n.p.sel=null;
  if(n.schema?.card?.seq){ delete n.schema.card.seq; await trSeqSave(n); }      // счётчик автонумерации начинается заново
  if(tblKind(n.p.list)==='patch') await tblSave(n);
  tblDerive(n); seqReset(n);
}
// набор на входе rows → в активный список: заменить строки или дописать (станции после поиска, любой набор записей)
// rows in «sync» / «new only»: набор приводится к списку по ключевой колонке на месте, без очистки — выбор строки и позиция не сбиваются
async function tblSync(n,list,onlyNew){
  const key=(n.p.key||'').trim() || 'id';
  const recs=list.filter(r=>r && typeof r==='object').map(r=>tblClean(tblPacket(n,r)));
  let grown=false;
  for(const c of [key,...recs.flatMap(r=>Object.keys(r))]) if(!n.cl.includes(c)){ n.cl.push(c); grown=true; }
  const db=tblKind(n.p.list)==='db';
  const at=new Map(); n.all.forEach((r,i)=>{ const k=r[key]; if(k!=='' && k!=null) at.set(String(k),i); });
  const seen=new Set(), fresh=[], dirty=[];
  for(const r of recs){
    const kv=r[key]; if(kv==='' || kv==null) continue;
    const k=String(kv); if(seen.has(k)) continue;
    seen.add(k);
    const i=at.get(k);
    if(i===undefined){ fresh.push(r); continue; }
    if(onlyNew) continue;
    const row=n.all[i]; let ch=false;
    for(const c in r) if(String(row[c]??'')!==String(r[c]??'')){ row[c]=r[c]; ch=true; }
    if(ch){ trCalcRow(n,row); tblBump(row); dirty.push(i); }
  }
  const stale=[];
  if(!onlyNew) n.all.forEach((r,i)=>{ const k=r[key]; if(k!=='' && k!=null && !seen.has(String(k))) stale.push(i); });
  if(!dirty.length && !stale.length && !fresh.length && !grown) return;
  if(db){
    try{
      for(const i of dirty){ const it=tblToItem(n.all[i],n.cl,n.virt); await ListDB.update(n.ids[i],{name:it.name,fields:it.fields,value:it.fields.value??''}); }
      if(stale.length) await ListDB.removeMany(stale.map(i=>n.ids[i]));
    }catch(e){ alert('storage: '+(e.message||e)); return; }
  }
  for(let j=stale.length-1;j>=0;j--){ const i=stale[j]; if(n.p.sel===n.ids[i]) n.p.sel=null; n.all.splice(i,1); n.ids.splice(i,1); }
  const rows=tblCheck(n,fresh).map(r=>{ const o={}; for(const c of n.cl) o[c]=r[c]??''; return o; });
  if(rows.length){
    let ids;
    if(db){
      try{ ids=await ListDB.addMany(n.p.list,rows.map(r=>tblToItem(r,n.cl,n.virt))); }
      catch(e){ alert('storage: '+(e.message||e)); return; }
    }
    n.all.push(...rows); if(ids) n.ids.push(...ids);
  }
  if(db){ if(grown) await tblMetaSet(n.p.list,{cols:n.cl}); }
  else{ n.ids=n.all.map((_,j)=>j); await tblSave(n); }
  if(grown) tblSetCols(n,n.cl.slice(),false);
  tblDerive(n);
  n.idx=Math.min(n.idx,Math.max(0,n.rows.length-1));
}
async function tblFromRows(n,list){
  if(tblRO(n) || n.loaded!==n.p.list){ n.rowsAgain=list; return; }
  if(n.rowsBusy){ n.rowsAgain=list; return; }
  n.rowsBusy=true;
  try{
    if(n.p.rowsIn==='sync' || n.p.rowsIn==='new only') await tblSync(n,list,n.p.rowsIn==='new only');
    else{
      if(n.p.rowsIn!=='add') await tblClear(n);
      await tblAdd(n,list.filter(r=>r && typeof r==='object'));
    }
    n.uiDirty=true;
  }catch(e){ console.warn('table rows in:',e); }
  finally{
    n.rowsBusy=false;
    if(n.rowsAgain){ const a=n.rowsAgain; n.rowsAgain=null; tblFromRows(n,a); }
  }
}
async function tblColsEdit(n,cl,ren,fill){             // переименование/добавление/удаление колонок; ren — {новое имя: старое}, fill — {колонка: значения по строкам}
  if(tblRO(n)) return;
  const old=n.cl;
  const rows=n.all.map((r,k)=>{ const o={}; for(const c of cl) o[c]=fill?.[c] ? fill[c][k]??'' : r[ren?.[c]??c]??''; return o; });
  const gone=old.filter(c=>!cl.includes(c));
  n.cl=cl.slice(); n.all=rows; n.virt=trVirtual(n);
  if(tblKind(n.p.list)==='db'){
    if(gone.length || fill) for(let k=0;k<rows.length;k++){ const it=tblToItem(rows[k],n.cl,n.virt); await ListDB.update(n.ids[k],{name:it.name,fields:it.fields}); }
    await tblMetaSet(n.p.list,{cols:n.cl});
  } else await tblSave(n);
  tblSetCols(n,n.cl.slice(),true);
  tblDerive(n);
}

// новый или существующий список: записи добавляются в конец
async function tblPut(listName,cols,rows,extra){
  const meta=await ListDB.getMeta(listName), have=meta?.cols || [];
  const cl=have.slice(); for(const c of cols) if(!cl.includes(c)) cl.push(c);
  await ListDB.addMany(listName,rows.map(r=>tblToItem(r,cl)));
  await tblMetaSet(listName,{cols:cl,...extra});
}
async function tblUse(n,list){                          // переключить узел на список
  n.p.list=list; n.p.sel=null; n.wantCols=true;
  await tblLoad(n);
}

/* ---------- импорт / экспорт ---------- */
const tblBase=name=>name.replace(/\.[^.]+$/,'');
// файл → список (или несколько, если это набор dsp-lists); возвращает имя последнего списка
async function tblImportFile(f,prefix){
  const text=await f.text(), ext=f.name.toLowerCase().split('.').pop();
  if(ext==='json'){
    let bundle=null;
    try{ const o=JSON.parse(text.replace(/^﻿/,'')); if(o && o['dsp-lists']) bundle=o; }catch(e){}
    if(bundle){
      let last=null;
      for(const name in bundle.lists){ const t=bundle.lists[name]; await tblPut(name,t.cols,t.rows,{...(t.types ? {types:t.types} : {}),...(t.card ? {card:t.card} : {})}); last=name; }
      return last;
    }
  }
  const t=tblFromTable(tblParse(text,ext)), name=prefix+tblBase(f.name);
  await tblPut(name,t.cols,t.rows);
  return name;
}
async function tblImport(n,files){
  const prefix=tblKind(n.p.list)==='db' ? tblDir(n.p.list) : '';
  let last=null;
  for(const f of files){
    try{ last=await tblImportFile(f,prefix) || last; }
    catch(e){ alert('failed to read '+f.name+': '+e.message); }
  }
  if(last) await tblUse(n,last);
}
// список из хранилища → CSV-файл (для файлового менеджера)
async function tblListFile(name){
  const {cols,rows}=await tblReadList(null,name);
  return {name:(tblLeaf(name)||'table').replace(/[^\w.-]+/g,'_')+'.csv',
    blob:new Blob(['\ufeff'+[cols,...rows.map(r=>cols.map(c=>r[c]))].map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})};
}
function tblExportFile(n){
  const cl=n.cl, rows=n.all, fmt=n.p.fmt, base=(tblSplit(n.p.list)[1]||'table').replace(/[^\w.-]+/g,'_');
  if(fmt==='json') return {name:base+'.json', blob:new Blob([JSON.stringify(rows.map(r=>{ const o={}; for(const c of cl) o[c]=r[c]; return o; }),null,1)],{type:'application/json'})};
  if(fmt==='tsv'){
    const cell=v=>String(v??'').replace(/[\t\r\n]+/g,' ');
    return {name:base+'.tsv', blob:new Blob(['\ufeff'+[cl,...rows.map(r=>cl.map(c=>r[c]))].map(r=>r.map(cell).join('\t')).join('\r\n')],{type:'text/tab-separated-values;charset=utf-8'})};
  }
  return {name:base+'.csv', blob:new Blob(['\ufeff'+[cl,...rows.map(r=>cl.map(c=>r[c]))].map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})};
}
function tblExport(n,share){ const f=tblExportFile(n); if(share) shareFile(f.blob,f.name); else dl(f.blob,f.name); }
async function tblExportAll(){
  const lists={};
  for(const name of await ListDB.listNames()){
    const items=await ListDB.list(name), meta=await ListDB.getMeta(name), keys=[];
    for(const it of items) for(const k in it.fields) if(k!=='name' && !keys.includes(k)) keys.push(k);
    const cols=meta?.cols || ((items.some(i=>i.name) ? ['name'] : []).concat(keys));
    lists[name]={cols,rows:items.map(it=>{ const o={}; for(const c of cols) o[c]=c==='name' ? it.name : it.fields[c] ?? ''; return o; })};
    if(meta?.types) lists[name].types=meta.types;
    if(meta?.card) lists[name].card=meta.card;
  }
  dl(new Blob([JSON.stringify({'dsp-lists':1,lists})],{type:'application/json'}),'dsp-lists.json');
}
async function tblCopy(n){
  const to=prompt('Copy "'+n.p.list+'" to (name, folder/name, or '+TBL_PATCH+' to keep it in the patch):',
    tblKind(n.p.list)==='preset' ? 'my '+tblLeaf(n.p.list) : n.p.list==='@patch' ? 'table' : n.p.list+' copy');
  if(!to) return;
  if(to.startsWith(TBL_PRE)){ alert('"'+TBL_PRE+'" is reserved for built-in lists'); return; }
  const cl=n.cl.slice(), rows=n.all.map(r=>({...r}));
  if(to===TBL_PATCH){
    n.p.list=TBL_PATCH; n.cl=cl; n.all=rows; n.ids=rows.map((_,i)=>i); n.wantCols=true;
    await tblSave(n); n.loaded=null; await tblLoad(n);   // перечитать из data
  } else {
    await tblPut(to,cl,rows,{types:{...n.schema.types},card:{...n.schema.card}});
    await tblUse(n,to);
  }
}

/* ---------- запись потока ---------- */
function tblTextRows(n,text){
  const lines=String(text).split(/\r?\n/).filter(l=>l.trim());
  if(!n.p.textCsv) return lines.map(l=>({text:l}));
  const t=geoCsvParse(String(text),'');
  let cl=n.cl.length ? n.cl : null, body=t;
  if(!cl){ cl=hostlistDedupFieldNames(t[0]); body=t.slice(1); }
  else if(t[0] && String(t[0][0]).trim().toLowerCase()===String(cl[0]).toLowerCase()) body=t.slice(1);
  return body.map(r=>{ const o={}; r.forEach((v,i)=>o[cl[i] ?? 'col'+(i+1)]=hostlistCoerce(v)); return o; });
}
function tblLogRow(n,I){
  const names=String(n.p.names||'').split(',').map(s=>s.trim()), r={t:Date.now()};
  ['a','b','c','d'].forEach((k,i)=>{ if(typeof I[k]==='number' && isFinite(I[k])) r[names[i]||k]=I[k]; });
  return r;
}
function tblFlush(n){
  if(n.flushing || !n.pend.length || n.loaded!==n.p.list) return;
  n.flushing=true;
  const rows=n.pend; n.pend=[];
  tblAdd(n,rows).catch(e=>console.warn('table:',e)).finally(()=>{ n.flushing=false; n.lastFlush=performance.now(); });
}

/* ---------- узел ---------- */
const tblIns=n=>[{n:'trig',t:'val'},{n:'row',t:'val'},{n:'t',t:'num'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'rows',t:'bands'},{n:'sigs',t:'bands'},{n:'hits',t:'bands'},{n:'filter',t:'txt'}]
  .concat(n.p.log ? ['a','b','c','d'].map(k=>({n:k,t:'num'})) : []);
const tblOuts=n=>{
  const o=[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'row',t:'num'},{n:'count',t:'num'},{n:'next',t:'num'},
    {n:'done',t:'num'},{n:'dist',t:'num'},{n:'bearing',t:'num'},{n:'progress',t:'num'},{n:'rows',t:'bands'},{n:'all',t:'bands'},{n:'match',t:'bands'}];
  if(tblCol(n.p.cols||[],TBL_LO)) o.push({n:'mid',t:'num'},{n:'span',t:'num'});
  return o.concat((n.cols||[]).map(c=>({n:c.port,t:'val'})));
};

def({ id:'table', title:'Table', cat:'Sources', kw:'list csv tsv json bookmarks band plan sequencer data log records rows folder import export',
  ins:tblIns, outs:tblOuts,
  readout:true, resize:true, w:360, h:420, bare:true,
  params:[
    {n:'list',t:'text',d:'table',hidden:true},
    {n:'filter',t:'text',d:'',hidden:true},
    {n:'advance',t:'select',opts:['rate','dwell','time','distance'],d:'rate',label:'advance'},
    {n:'follow',t:'check',d:false,label:'follow the end',tip:'show the last rows and keep scrolling to new ones while the list is scrolled to the bottom (like Wireshark); scroll up to stop following'},
    {n:'rev',t:'check',d:false,label:'newest first',tip:'show the list in reverse: the last added row is at the top (this is also the order the rows are played in)'},
    {n:'order',t:'select',opts:['sequential','ping-pong','random','shuffle'],d:'sequential',adv:true},
    {n:'rate',t:'range',min:0,max:50,step:.1,d:0,label:'rows/s'},
    {n:'speed',t:'range',min:0,max:1000,step:.1,d:50,label:'speed',adv:true},
    {n:'tscale',t:'range',min:.01,max:1000,step:.01,log:true,d:1,label:'time ×',adv:true},
    {n:'loop',t:'check',d:true,adv:true},
    {n:'interp',t:'check',d:false,label:'interpolate',adv:true},
    {n:'initial',t:'check',d:true,label:'first row at start',adv:true},
    {n:'reset',t:'button',label:'Reset',fn:n=>seqReset(n),adv:true},
    {n:'collect',t:'check',d:true,label:'store rec / text wires',adv:true},
    {n:'rowsIn',t:'select',opts:['replace','add','sync','new only'],d:'replace',label:'rows in (wire)',tip:'a set on the rows input is stored in the active list: replace its rows, add to them, sync (rows are matched by the upsert key column — default id — and changed, added or removed in place: nothing flickers, the selected row stays) or new only (add the rows whose key is not in the list yet, leave the rest alone)'},
    {n:'key',t:'text',d:'',adv:true,label:'upsert key col',tip:'if set, a wired rec with the same value in this column updates its row instead of adding one (a rec with _delete removes it); count / first / last columns are kept'},
    {n:'pfields',t:'text',d:'',adv:true,label:'packet fields → columns',tip:'extra columns from a wired rec: "col=src, src2". src is a path into the record (a.b.c) or a field of its hex parsed by hexSchema (HEX Structure: mtype_name, body.devaddr …); * — all parsed fields'},
    {n:'pfillBtn',t:'button',label:'Fill packet fields into existing rows',adv:true,fn:n=>tblBackfill(n)},
    {n:'textCsv',t:'check',d:false,label:'text wire: split into columns',adv:true},
    {n:'log',t:'check',d:false,label:'log inputs a–d',adv:true,fn:n=>{ tblRebuild(n,true); }},
    {n:'period',t:'range',min:.05,max:60,step:.05,d:1,label:'log period, s',adv:true},
    {n:'names',t:'text',d:'a,b,c,d',label:'log columns',adv:true},
    {n:'capture',t:'button',label:'Add row from a–d',adv:true,fn:n=>{ n.pend.push(tblLogRow(n,n.lastIn||{})); }},
    {n:'maxRows',t:'num',min:0,max:1e7,step:100,d:0,label:'max rows (0=∞)',tip:'oldest rows are dropped above this count; 0 — no limit (a list in the patch itself keeps at most 1000)',adv:true},
    {n:'fmt',t:'select',opts:['csv','tsv','json'],d:'csv',label:'export format',adv:true},
    {n:'first',t:'num',min:1,max:1e6,step:1,d:1,adv:true,label:'first row'},
    {n:'last',t:'num',min:0,max:1e6,step:1,d:0,adv:true,label:'last row (0=end)'},
    {n:'unit',t:'select',opts:['km/h','m/s','knots'],d:'km/h',adv:true,label:'speed unit'},
    {n:'tcol',t:'text',d:'',adv:true,label:'time col (auto)'},
    {n:'dwellCol',t:'text',d:'dwell',adv:true,label:'dwell col, s'},
    {n:'speedCol',t:'text',d:'speed',adv:true,label:'speed col'},
    {n:'latCol',t:'text',d:'',adv:true,label:'lat col (auto)'},
    {n:'lonCol',t:'text',d:'',adv:true,label:'lon col (auto)'},
    {n:'textCol',t:'text',d:'',adv:true,label:'text col (row)'},
    {n:'data',t:'code',d:'',adv:true,label:'patch table (list = @patch)',plain:true,fn:n=>{ if(n.p.list===TBL_PATCH) tblLoad(n); }},
  ],
  init:n=>{
    n.p.list=tblCanon(n.p.list||'table');
    n.p.cols=Array.isArray(n.p.cols) ? n.p.cols : [];
    if(!Array.isArray(n.p.rules)) n.p.rules=[];
    if(+n.p.maxRows===10000) n.p.maxRows=0;                // прежнее значение по умолчанию: лимита нет
    if(n.p.sel===undefined) n.p.sel=null;
    n.all=[]; n.ids=[]; n.cl=[]; n.rows=[]; n.rowIds=[]; n.headers=[]; n.cols=[]; n.rowsOwn=[]; n.rowsOut=[];
    n.extra=new Map(); n.onCount=0; n._rev=!!n.p.rev;
    n.err=''; n.loaded=null; n.loadedData=null; n.pend=[]; n.lastFlush=0; n.flushing=false;
    n.lastRec=undefined; n.lastText=undefined; n.lastIn={}; n.logT=0; n.pick=null;
    n._pfSeen=n.p.pfields; n._pfPend=false; n._pfAt=0;
    n.trigPrev=0; n.rowPrev=null; n.pulse=0; n.initialized=false; n.uiDirty=true;
    n.onResize=ln=>{ if(ln.ui) syncCustomHeight(ln,ln.ui.root,150); };
    tblPorts(n); seqReset(n);
    if(!n.p.cols.length){                                 // порты нужны до загрузки: из data или из пресета
      if(n.p.list===TBL_PATCH){
        const t=String(n.p.data||'').trim();
        if(t) try{ n.p.cols=tblFromTable(seqParse(t,'',true)).cols; }catch(e){}
      } else if(tblKind(n.p.list)==='preset') n.p.cols=tblPresetRows(n.p.list.slice(TBL_PRE.length)).cols;
      tblPorts(n);
    }
    tblLoad(n);
  },
  process(n,I){
    const p=n.p, dt=BLOCK/Eng.sr;
    // список/таблицу сменили извне (undo, десериализация, правка data)
    if((n.loaded!==p.list || (p.list===TBL_PATCH && n.loadedData!==p.data)) && !n.loading) tblLoad(n);
    else if(n._showRef!==p.show && !n.loading) tblSyncExtra(n);       // галочки изменили извне (undo, патч)
    if(n._chkRev!==ListDB.rev && !n.loading && n.loaded===p.list){      // правка хранилища: пункты чеклистов могли измениться
      n._chkRev=ListDB.rev;
      if(n.chkCols?.length || n.extra.size){ clearTimeout(n._chkT); n._chkT=setTimeout(()=>tcChkRoll(n),150); }
    }
    n.lastIn=I;
    const wf=typeof I.filter==='string' ? I.filter : '';
    if(wf!==(n.wf||'') && n.loaded===p.list){ n.wf=wf; n.hlSel=false; tblDerive(n); seqReset(n); n.initDone=true; n.uiDirty=true; n.uiFull=true; }
    // packet fields изменили — заполнить ими уже записанные строки, когда ввод затих
    if(p.pfields!==n._pfSeen){ n._pfSeen=p.pfields; n._pfAt=performance.now(); n._pfPend=true; }
    else if(n._pfPend && performance.now()-n._pfAt>1000 && !n.loading && n.loaded===p.list){ n._pfPend=false; tblBackfill(n); }
    if(p.collect && !tblRO(n)){
      if(I.rec && I.rec!==n.lastRec){ n.lastRec=I.rec; tblIngest(n,Array.isArray(I.rec) ? I.rec : [I.rec],false); }
      if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; if(I.text) n.pend.push(...tblTextRows(n,I.text)); }
    }
    if(p.log){ n.logT+=dt; if(n.logT>=Math.max(.05,+p.period||1)){ n.logT=0; n.pend.push(tblLogRow(n,I)); } }
    if(Array.isArray(I.rows) && I.rows!==n.lastRowsIn){ n.lastRowsIn=I.rows; if(!tblRO(n)) tblFromRows(n,I.rows); }
    else if(n.rowsAgain && !n.rowsBusy && n.loaded===n.p.list && !tblRO(n)){ const a=n.rowsAgain; n.rowsAgain=null; tblFromRows(n,a); }
    if(n.pend.length>5000) n.pend.splice(0,n.pend.length-5000);
    if(n.pend.length && performance.now()-n.lastFlush>500) tblFlush(n);

    const o=seqProcess(n,I);
    for(const c of n.cols) if(c.ref) o[c.port]=tblRefVal(n,c);
    const sigs=Array.isArray(I.sigs) && I.sigs.length ? I.sigs : null;
    if(n._mI!==n.rowsOut || n._mS!==sigs){ n._mI=n.rowsOut; n._mS=sigs; n._merged=sigs ? n.rowsOut.concat(sigs) : n.rowsOut; }
    const hits=Array.isArray(I.hits) ? I.hits : null, pickRow=n.hlSel && n.cur ? n.cur : null;
    if(n._mM!==n.rows || n._mH!==hits || n._mC!==pickRow){                // match: найденное фильтром, выбранная щелчком строка и hits соседей — для Graph hl
      n._mM=n.rows; n._mH=hits; n._mC=pickRow;
      const own=(n.fOn ? n.rowsOwn : []).concat(pickRow ? [pickRow] : []);
      n._match=hits ? own.concat(hits) : own;
    }
    if(n._aA!==n.rowsAllOwn || n._aS!==sigs){ n._aA=n.rowsAllOwn; n._aS=sigs; n._all=sigs ? n.rowsAllOwn.concat(sigs) : n.rowsAllOwn; }
    o.all=n._all;                                          // rows без фильтра: граф не теряет узлы, когда в таблице набран фильтр
    o.match=n._match;
    o.rows=n._merged;                                      // записи всех отмеченных списков с общим фильтром (Graph / Map: set, nodes)
    if(!n.started) for(const c of n.cols) delete o[c.port];   // ничего не выбрано — поля не выдаём (как band plan)
    else if(n.loCol && n.cur){
      const lo=tblHz(n.cur[n.loCol]), hi=n.hiCol ? tblHz(n.cur[n.hiCol]) : lo;
      if(isFinite(lo)){ const h=isFinite(hi) ? Math.max(lo,hi) : lo; o.mid=(lo+h)/2; o.span=h-lo; }
    }
    return o;
  },
  draw(n){
    if(!n.initialized && n.el){ tblInit(n); n.initialized=true; }
    const r=n.el.querySelector('.readout');
    if(r){
      const N=n.rows.length;
      const warn=n.err ? n.err : n.p.advance==='time' && N && !n.tt ? 'no time column' : n.p.advance==='distance' && N && !n.geo ? 'no lat/lon columns' : '';
      const t=warn ? '⚠ '+warn : (n.p.list)+(n.onCount>1 ? ' (+'+(n.onCount-1)+' on)' : '')+' · '+(N ? 'row '+(n.idx+1)+'/'+N : 'empty')+' · '+n.p.advance+(n.done?' · done':'')+
        (n.pend.length ? ' · +'+n.pend.length : '');
      if(r.textContent!==t) r.textContent=t;
    }
    if(n.ui){
      const tl=!!n.p.follow && !n.p.rev;                          // при «newest first» конец списка — старые записи: следим за началом
      if(tl!==!!n.ui.tail){ n.ui.tail=tl; n.ui.jump=tl; n.uiDirty=true; }
      if(!!n.p.rev!==!!n._rev){ n._rev=!!n.p.rev; if(n.loaded!==null){ tblDerive(n); seqReset(n); } }
      const vk=[n.p.vcols,n.p.rules,n.p.tint,n.p.vmode,n.p.tz];
      if(!n._vk || vk.some((x,i)=>x!==n._vk[i])){ n._vk=vk; n.uiDirty=true; n.uiFull=true; if(n.ui.view && !n.ui.view.hidden) tblRenderView(n); }
      // полная перерисовка до 300 строк × колонок — реже на длинном списке
      if(n.uiDirty && performance.now()-(n.uiT||0)>500){ n.uiDirty=false; n.uiT=performance.now(); tblRenderList(n,true); }
      tblMark(n);
    }
  },
  dispose:n=>{ n.pend=[]; n.disposed=true; if(n.saveLate){ n.saveLate=false; tblSave(n); } }
});

/* ---------- интерфейс ---------- */
// значки карты (geoIcon): имя или любой короткий текст / эмодзи; в форме записи — выбор из списка
const TBL_ICONS=['dot','square','diamond','triangle','star','flag','cross','plus','antenna','tx','rx','me','plane','ship','car','truck','bus','train','tram','bike','moto','heli','drone','walk','sat','balloon','📍','🏠','🚩','⚠','📡','🔊','📷','⛰','🚗','🔋'];
const TBL_AUDIO=/^audio$/;                            // колонка со звуком: в ячейке id клипов «sm-…» (Sample Library, audioattach.js)
const TBL_PHOTO=/^photos?$/;                           // колонка с фото: в ячейке id «ph-…» (хранилище photos.js)
const TBL_BTN='background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;';
const TBL_IN='min-width:0;background:var(--bg);border:1px solid var(--line);color:var(--txt);font-size:11px;padding:1px 3px;';
async function tblNames(){
  const db=await ListDB.listNames().catch(()=>[]);
  const legacy=window.BP_LEGACY;                          // старые плоские имена — только для совместимости патчей
  return [TBL_PATCH,...Object.keys(BANDPLAN_PRESETS).filter(k=>!legacy?.has(k)).map(k=>TBL_PRE+k),...db.filter(x=>x!==TBL_PATCH && !x.startsWith(TBL_PRE))];
}
/* Вид: сверху выбор списка (папки — группы выпадающего списка) и «⋯» со всеми действиями, ниже фильтр,
   две частые кнопки, список строк фиксированной высоты. Правка строки — панелью снизу поверх списка:
   она не прокручивается вместе со строками и не меняет высоту списка. Дерево списков (для показа
   нескольких списков на bands) и колонки — по запросу из «⋯». */
function tblInit(n){
  const mid=n.el.querySelector('.mid');
  if(!mid || mid.querySelector('.tbl-ui')) return;
  const root=document.createElement('div');
  root.className='tbl-ui';
  root.innerHTML=`
    <div class="tbl-head">
      <select class="tbl-pick" title="active list: rows, edit, sequencer"></select>
      <button class="tbl-btn tbl-shown" title="lists shown on the map and the bands output — tick as many as you need"></button>
      <button class="tbl-btn tbl-new" title="new list">＋</button>
      <button class="tbl-btn tbl-menub" title="actions">⋯</button>
    </div>
    <div class="tbl-tree" hidden></div>
    <div class="tbl-bar">
      <button class="tbl-btn tbl-crumb" hidden></button>
      <input class="tbl-filter" placeholder="filter: kind == &quot;beacon&quot; &amp;&amp; rssi > -50   ·   20m  demod:am  -fm" title="Wireshark-style: field == x, != > < >= <=, contains, matches (~), in {a b 1..5}, &amp;&amp; || !, ( ); fields are column names. Also words: 20m, col:text, col>5M, -word, not word">
      <span class="tbl-count"></span>
    </div>
    <div class="tbl-view" hidden></div>
    <div class="tbl-acts">
      <button class="tbl-btn pri tbl-add">+ row</button>
      <button class="tbl-btn tbl-vm" title="view"></button>
      <button class="tbl-btn tbl-viewb" title="fields (add, rename, remove, type, links), columns, their format and row colour rules">▦ view</button>
      <button class="tbl-btn tbl-here" title="new row at my current position (GPS) — with the icon, a photo and a sound in the same form">📍 here</button>
    </div>
    <div class="tbl-list" tabindex="0"></div>
    <div class="tbl-edit" hidden></div>
    <input class="tbl-file" type="file" multiple accept=".csv,.tsv,.txt,.json,.jsonl,.kml,.gpx,.geojson,text/*" hidden>
  `;
  mid.append(root);
  syncCustomHeight(n,root,150);
  const q=s=>root.querySelector(s);
  n.ui={root, list:q('.tbl-list'), count:q('.tbl-count'), tree:q('.tbl-tree'), pick:q('.tbl-pick'), shown:q('.tbl-shown'),
    vmBtn:q('.tbl-vm'), crumb:q('.tbl-crumb'), filter:q('.tbl-filter'), view:q('.tbl-view'), edit:q('.tbl-edit'), tail:!!n.p.follow && !n.p.rev, jump:!!n.p.follow && !n.p.rev, marked:-1, markEl:null, rh:0, hdh:0, vh:0, st:0, atEnd:false};
  n.ui.view.hidden=!n.viewOpen;                           // пересборка узла (смена колонок) не должна прятать панель
  q('.tbl-viewb').classList.toggle('on',!!n.viewOpen);
  const vw=n.ui.view;                                     // прокрутка и фокус поля «new field» переживают пересборку узла
  vw.addEventListener('scroll',()=>{ if(!n._vr && !vw.hidden) n.viewScroll=vw.scrollTop; });
  vw.addEventListener('focusin',e=>{ n.viewNew=e.target.classList.contains('tv-new'); });
  if(n.viewOpen && n.schema) tblRenderView(n);            // сразу, а не после асинхронной tblRenderAll: панель не схлопывается на пересборке
  n._open=new Set(Array.isArray(n.p.open) ? n.p.open : []);
  if(!Array.isArray(n.p.open)) for(const k of new Set([...tblShow(n),n.p.list])){            // раскрыть пути отмеченных
    const parts=k.split('/'); parts.pop();
    parts.reduce((a,x)=>{ const path=a ? a+'/'+x : x; n._open.add(path); return path; },'');
  }
  n.ui.list.addEventListener('keydown',e=>tblKey(n,e));
  let sq=0;                                               // прокрутка и размер — раз в кадр
  const onScroll=()=>{ if(!sq) sq=requestAnimationFrame(()=>{ sq=0; if(!n.disposed && n.ui) tblScrolled(n); }); };
  n.ui.list.addEventListener('scroll',onScroll,{passive:true});
  if(typeof ResizeObserver!=='undefined') new ResizeObserver(onScroll).observe(n.ui.list);
  n.ui.list.addEventListener('pointerover',e=>{
    const row=e.target.closest?.('.tbl-row');
    if(row && !row.title && n.rows[+row.dataset.i]) row.title=tblRowTip(n,n.rows[+row.dataset.i]);
  });
  // один набор обработчиков на список, а не по три на каждую строку
  n.ui.list.addEventListener('click',e=>{
    const hc=e.target.closest('.tbl-hd > span[data-c]');
    if(hc){                                               // ▲ → ▼ → без сортировки
      const c=hc.dataset.c;
      if(n.p.sortCol!==c){ n.p.sortCol=c; n.p.sortDir=1; } else if(n.p.sortDir>0) n.p.sortDir=-1; else n.p.sortCol='';
      tblDerive(n); tblRenderList(n); Undo.push(); return;
    }
    const row=e.target.closest('.tbl-row'); if(!row) return;
    const ch=e.target.closest('.tc-chip');
    if(ch?.dataset.to){ tcGo(n,ch.dataset.to,ch.dataset.name); return; }
    const i=+row.dataset.i;
    const ck=e.target.closest('.tc-chk');
    if(ck){ tblSelect(n,i); tcChkDrill(n,ck.dataset.c,n.labelFn(n.rows[i])); return; }
    const tg=e.target.closest('.tc-tog');
    if(tg){ const r=n.rows[i], c=tg.dataset.c; tblUpdate(n,i,{...r,[c]:tcIsTrue(r[c]) ? 0 : 1}).then(()=>tblRenderList(n)); return; }
    const b=e.target.closest('.tbl-ico[data-act]');
    if(b?.dataset.act==='edit'){ tblEditForm(n,i,row); return; }
    if(b?.dataset.act==='del'){
      const label=tcHasName(n) && n.rows[i] ? n.labelFn(n.rows[i]) : '';
      if(!confirm('Delete row "'+(label||i+1)+'"?')) return;
      tblRemove(n,i).then(()=>tblRenderList(n));
      return;
    }
    if(b) return;                                         // фото / звук — свои обработчики
    tblSelect(n,i); n.ui.list.focus({preventScroll:true});
    if(tcCardish(n)){ n.navBack=[]; tcDetail(n,i); }
  });
  n.ui.list.addEventListener('dblclick',e=>{
    const row=e.target.closest('.tbl-row');
    if(row && !tblRO(n) && !tcCardish(n)) tblEditForm(n,+row.dataset.i,row);
  });
  n.ui.pick.addEventListener('change',()=>tblPick(n,n.ui.pick.value));
  n.ui.shown.addEventListener('click',()=>tblTreeToggle(n));
  n.ui.tree.addEventListener('click',e=>tblTreeClick(n,e));
  n.ui.filter.value=n.p.filter||'';
  n.ui.filter.dataset.tip=n.ui.filter.title; tblFilterMark(n);
  n.ui.filter.addEventListener('keydown',e=>e.stopPropagation());
  n.ui.filter.addEventListener('input',()=>{
    n.p.filter=n.ui.filter.value;
    tblDerive(n); seqReset(n); n.initDone=true;           // новый набор — без повторной выдачи первой строки
    tblFilterMark(n);
    tblRenderList(n);
  });
  q('.tbl-new').addEventListener('click',()=>tblNewMenu(n));
  q('.tbl-menub').addEventListener('click',()=>tblMainMenu(n));
  q('.tbl-add').addEventListener('click',()=>tblAddForm(n,n.drill ? {[n.drill.via]:n.drill.label} : null));
  n.ui.crumb.addEventListener('click',()=>tcChkBack(n));
  q('.tbl-here').addEventListener('click',()=>tblHereForm(n));
  q('.tbl-viewb').addEventListener('click',()=>tblViewToggle(n));
  q('.tbl-vm').addEventListener('click',()=>tcViewNext(n));
  const file=q('.tbl-file');
  n.ui.fileEl=file;
  file.addEventListener('change',()=>{ const fs=[...file.files]; file.value=''; if(fs.length) tblImport(n,fs); });
  tblRenderAll(n);
}
// действия над списком / данными — из меню «⋯»
async function tblRenameList(n){
  if(tblKind(n.p.list)!=='db'){ alert('only lists in the browser DB can be renamed'); return; }
  const nm=(prompt('List name:',tblLeaf(n.p.list))||'').trim(); if(!nm) return;
  const full=nm.includes('/') ? nm : tblDir(n.p.list)+nm;        // «папка/имя» целиком — тоже можно
  if(full===n.p.list) return;
  if(full===TBL_PATCH || full.startsWith(TBL_PRE)){ alert('this name is reserved'); return; }
  await ListDB.renameList(n.p.list,full); await tcRenameTarget(n.p.list,full);
  n.p.list=full; n.loaded=full; tblRenderAll(n);
}
async function tblMoveList(n){
  if(tblKind(n.p.list)!=='db'){ alert('only lists in the browser DB can be moved'); return; }
  const dirs=[...new Set((n.treeNames||[]).filter(x=>tblKind(x)==='db' && x.includes('/')).map(x=>tblDir(x).slice(0,-1)))].sort(tblByName);
  const f=prompt('Folder (empty — no folder)'+(dirs.length ? '\nexisting: '+dirs.join(', ') : '')+':',tblDir(n.p.list).slice(0,-1));
  if(f==null) return;
  const dir=f.trim().replace(/^\/+|\/+$/g,'');
  const full=(dir ? dir+'/' : '')+tblLeaf(n.p.list);
  if(full===n.p.list) return;
  if(full.startsWith(TBL_PRE)){ alert('this name is reserved'); return; }
  await ListDB.renameList(n.p.list,full); await tcRenameTarget(n.p.list,full);
  n.p.list=full; n.loaded=full; tblRenderAll(n);
}
async function tblDeleteList(n){
  if(tblKind(n.p.list)!=='db'){ alert('only lists in the browser DB can be deleted'); return; }
  if(!confirm('Delete list "'+tblLeaf(n.p.list)+'" entirely?')) return;
  await ListDB.deleteList(n.p.list);
  await tblPick(n,'table');
}
async function tblClearRows(n){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  if(!n.all.length || !confirm('Delete all '+n.all.length+' rows of "'+tblLeaf(n.p.list)+'"?')) return;
  await tblClear(n); tblRenderAll(n);
}
// выпадающее меню над списком: заголовки групп и пункты (подсказка — описание)
function tblMenuEl(n){
  const root=n.ui.root; root.querySelector('.tbl-menu')?.remove();
  const m=document.createElement('div'); m.className='tbl-menu';
  root.append(m);
  const off=e=>{ if(!m.contains(e.target)){ m.remove(); document.removeEventListener('pointerdown',off,true); } };
  setTimeout(()=>document.addEventListener('pointerdown',off,true));
  return m;
}
function tblMenuHead(m,t){ const h=document.createElement('div'); h.className='tm-h'; h.textContent=t; m.append(h); }
function tblMenuItem(m,title,desc,fn,cols,compact){
  const d=document.createElement('div'); d.className='tm-i';
  d.innerHTML='<div class="tm-t">'+escapeHtml(title)+'</div>'+(cols ? '<div class="tm-c">'+escapeHtml(cols)+'</div>' : '')+
    (desc && !compact ? '<div class="tm-d">'+escapeHtml(desc)+'</div>' : '');
  if(desc && compact) d.title=desc;
  d.addEventListener('click',()=>{ m.remove(); fn(); }); m.append(d);
}
function tblMainMenu(n){
  const m=tblMenuEl(n), it=(t,d,f)=>tblMenuItem(m,t,d,f,null,true);
  tblMenuHead(m,'Rows');
  it('Clear all rows','delete every row of the active list',()=>tblClearRows(n));
  tblMenuHead(m,'Data');
  it('Import file…','CSV, TSV, TXT, JSON, KML, GPX, GeoJSON — each file becomes a list',()=>n.ui.fileEl.click());
  it('Open data…','objects from open sources (cell towers, masts, repeaters, peaks, own Overpass query) and terrain elevation for rows with lat / lon',()=>gdOpenMenu(n));
  it('Export this list','format in advanced',()=>tblExport(n));
  it('Share this list…','send it through the system share menu',()=>tblExport(n,true));
  it('Export all lists','all lists in one JSON file (import brings them back)',()=>tblExportAll());
  tblMenuHead(m,'List');
  it('Copy to…','another list, the patch or the browser DB',()=>tblCopy(n));
  it('Rename…','',()=>tblRenameList(n));
  it('Move to folder…','',()=>tblMoveList(n));
  it('Add template columns…','the data stays',()=>tblTplMenu(n,'apply'));
  it('Delete list','',()=>tblDeleteList(n));
  tblMenuHead(m,'View');
  it('Fields & colors…','add, rename, remove fields; type, shown columns, their order and format; row colour rules',()=>tblViewToggle(n));
  it('Shown lists…','tick several lists to show them on the map and the bands output',()=>tblTreeToggle(n));
  it(n.p.follow ? 'Stop following the end' : 'Follow the end','show the last rows and scroll to new ones',()=>{ n.p.follow=!n.p.follow; Undo.push(); });
}
function tblNewMenu(n){
  const m=tblMenuEl(n);
  tblMenuItem(m,'Empty list','columns appear from the first rows you add or import',()=>tblNewList(n,null));
  tblMenuHead(m,'From a template');
  for(const t of TBL_TEMPLATES) tblMenuItem(m,t.title,t.desc,()=>tblNewList(n,t),t.cols.join(', '));
}
// меню шаблонов: new — создать список (с колонками шаблона или пустой), apply — добавить недостающие колонки в активный
async function tblNewList(n,t){
  const dir=t ? t.dir+'/' : (tblKind(n.p.list)==='db' ? tblDir(n.p.list) : '');
  const nm0=(prompt('New list name:','')||'').trim(); if(!nm0) return;
  const nm=nm0.includes('/') ? nm0 : dir+nm0;                 // имя в текущей папке (или папке шаблона); «папка/имя» — своя
  if(nm===TBL_PATCH || nm.startsWith(TBL_PRE)){ alert('this name is reserved'); return; }
  const have=(await ListDB.listNames()).includes(nm);
  if(!have) await ListDB.setMeta(nm,{cols:t ? t.cols.slice() : [],...(t?.types ? {types:{...t.types}} : {})});
  await tblPick(n,nm);
  if(t?.types && !have) n.p.vmode='cards';
  if(have && t) await tblApplyTemplate(n,t);                  // список уже есть — шаблон только дополняет колонки
}
async function tblApplyTemplate(n,t){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  await tblColsEdit(n,tblTemplateCols(n.cl,t));
  if(t.types){ for(const c in t.types) if(!n.schema.types[c]) n.schema.types[c]={...t.types[c]}; await tcSchemaSave(n); }
  if(t.types && !n.p.vmode) n.p.vmode='cards';
  tblRenderAll(n);
}
// шаблоны колонок для активного списка (mode 'apply')
function tblTplMenu(n){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  const m=tblMenuEl(n);
  for(const t of TBL_TEMPLATES) tblMenuItem(m,t.title,t.desc,()=>tblApplyTemplate(n,t),t.cols.join(', '));
}
async function tblRenderAll(n){
  if(!n.ui) return;
  const ui=n.ui;
  ui.filter.value=n.p.filter||'';
  tblRenderList(n);                                     // строки не ждут имён списков
  if(n.viewOpen) tblRenderView(n);
  const names=await tblNames();
  if(n.disposed || n.ui!==ui) return;
  if(!names.includes(n.p.list)) names.push(n.p.list);   // пустой, ещё не записанный
  n.treeNames=names;
  tblRenderTree(n);
  tcOpenPending(n);
}
/* ---------- дерево списков ---------- */
function tblBuildTree(names){
  const root={dirs:new Map(),files:[],path:'',name:''};
  for(const full of names){
    const parts=full.split('/'), leaf=parts.pop();
    let d=root;
    for(const x of parts){
      if(!d.dirs.has(x)) d.dirs.set(x,{dirs:new Map(),files:[],path:d.path ? d.path+'/'+x : x,name:x});
      d=d.dirs.get(x);
    }
    d.files.push({name:full,leaf});
  }
  return root;
}
const tblFilesOf=d=>[...d.files.map(f=>f.name),...[...d.dirs.values()].flatMap(tblFilesOf)];
const tblByName=(a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});
function tblRenderTree(n){
  const ui=n.ui, sh=tblShow(n), html=[];
  if(ui.tree.hidden){ tblRenderPick(n); return; }       // дерево строится при открытии
  const walk=(d,depth)=>{
    for(const sub of [...d.dirs.values()].sort((a,b)=>tblByName(a.name,b.name))){
      const all=tblFilesOf(sub), on=all.filter(f=>sh.has(f)).length, open=n._open.has(sub.path);
      html.push(`<div class="tt-dir" data-path="${escapeHtml(sub.path)}" style="padding-left:${depth*12+2}px">`+
        `<span class="tt-car">${open?'▾':'▸'}</span><input type="checkbox" class="tt-cb" data-ind="${on&&on<all.length?1:0}"${on&&on===all.length?' checked':''}>`+
        `<span class="tt-name">${escapeHtml(sub.path==='presets' ? 'presets (built-in)' : sub.name)}</span><span class="tt-cnt">${on?on+'/':''}${all.length}</span></div>`);
      if(open) walk(sub,depth+1);
    }
    for(const f of d.files.slice().sort((a,b)=>tblByName(a.leaf,b.leaf)))
      html.push(`<div class="tt-file${f.name===n.p.list?' act':''}" data-name="${escapeHtml(f.name)}" style="padding-left:${depth*12+14}px">`+
        `<input type="checkbox" class="tt-cb"${sh.has(f.name)?' checked':''}><span class="tt-name" title="${escapeHtml(f.name)}">${escapeHtml(f.leaf)}</span></div>`);
  };
  walk(tblBuildTree(n.treeNames||[]),0);
  const keep=ui.tree.scrollTop;
  ui.tree.innerHTML='<div class="tt-top"><span class="tt-ttl">Shown on the map / bands · '+sh.size+'</span><span class="tt-none" title="untick all">none</span><span class="tt-close" title="close">✕</span></div>'+html.join('');
  ui.tree.querySelectorAll('[data-ind="1"]').forEach(c=>{ c.indeterminate=true; });
  ui.tree.scrollTop=keep;
  tblRenderPick(n);
}
// выбор активного списка: папки — группы, видно только имя без пути
function tblRenderPick(n){
  const ui=n.ui, sel=ui.pick, names=(n.treeNames||[n.p.list]).slice().sort(tblByName);
  const groups=new Map();
  for(const f of names){
    const g=tblKind(f)==='db' ? tblDir(f).slice(0,-1) : tblKind(f)==='patch' ? '' : tblDir(f).slice(0,-1);
    if(!groups.has(g)) groups.set(g,[]);
    groups.get(g).push(f);
  }
  const label=g=>g==='' ? 'Lists' : g==='presets' ? 'Built-in (read-only)' : g.startsWith('presets/') ? 'Built-in · '+g.slice(8) : g;
  const many=groups.size>1;
  sel.innerHTML='';
  for(const g of [...groups.keys()].sort((a,b)=>(a==='')?-1:(b==='')?1:(a.startsWith('presets')-b.startsWith('presets'))||tblByName(a,b))){
    const host=many ? Object.assign(document.createElement('optgroup'),{label:label(g)}) : sel;
    for(const f of groups.get(g)){
      const o=document.createElement('option'); o.value=f; o.textContent=tblKind(f)==='patch' ? 'This patch' : tblLeaf(f); host.append(o);
    }
    if(many) sel.append(host);
  }
  sel.value=n.p.list;
  ui.shown.textContent='☑ '+tblShow(n).size;
  ui.shown.classList.toggle('on',!ui.tree.hidden);
}
function tblTreeToggle(n){ n.ui.tree.hidden=!n.ui.tree.hidden; if(!n.ui.tree.hidden) tblRenderTree(n); n.ui.shown.classList.toggle('on',!n.ui.tree.hidden); }
function tblTreeClick(n,e){
  if(e.target.closest('.tt-close')){ tblTreeToggle(n); return; }
  if(e.target.closest('.tt-none')){ tblSetShow(n,[]); return; }
  const row=e.target.closest('.tt-dir,.tt-file'); if(!row) return;
  const isCb=e.target.classList.contains('tt-cb');
  if(row.classList.contains('tt-file')){
    if(isCb) tblToggleShow(n,[row.dataset.name],e.target.checked);
    else tblPick(n,row.dataset.name);
    return;
  }
  const path=row.dataset.path;
  if(isCb){
    const d=[...n.treeNames].filter(x=>x.startsWith(path+'/'));
    tblToggleShow(n,d,e.target.checked);
  } else {
    if(n._open.has(path)) n._open.delete(path); else n._open.add(path);
    n.p.open=[...n._open]; tblRenderTree(n);
  }
}
function tblSetShow(n,list){ n.p.show=list; tblSyncExtra(n); tblRenderTree(n); }
function tblToggleShow(n,names,on){
  const sh=tblShow(n);
  for(const k of names) on ? sh.add(k) : sh.delete(k);
  tblSetShow(n,[...sh]);
}
// выбор активного списка; если «показывался» только прежний активный — галочка переходит на новый
async function tblPick(n,list){
  tblCloseEditor(n);
  if(n.drill && list!==n.drill.to){                        // ушли из подсписка чеклиста: фильтр, как был
    n.p.filter=n.drill.prevFilter; n.drill=null;
    if(n.ui) n.ui.filter.value=n.p.filter;
  }
  const sh=n.p.show;
  if(Array.isArray(sh) && (!sh.length || (sh.length===1 && tblCanon(sh[0])===n.p.list))) n.p.show=[list];
  await tblUse(n,list);
}
// Старые строки окна → новые. Окно сдвигается прокруткой (hint — сдвиг индексов), потолок maxRows сбрасывает старые строки сверху
// (старая строка off+j стала новой j). off<0 — окно ушло вверх: строки дописываются перед старыми. Принимаем, если отличаются не больше
// половины перекрытия (иначе одна пересборка дешевле сотни замен); NaN — не совмещается.
function tblAlign(old,cur,hint){
  const miss=off=>{ let d=0,m=0; for(let j=Math.max(0,-off);j<cur.length && j+off<old.length;j++){ m++; if(old[off+j]!==cur[j]) d++; } return [d,m]; };
  const ok=(d,m)=>m>0 && (d<=16 || d*2<=m);
  { const [d,m]=miss(hint); if(ok(d,m)) return hint; }
  let best=NaN, bd=Infinity, tries=0;
  for(let off=0;off<old.length && tries<48;off++){
    if(old[off]!==cur[0]) continue;
    tries++;
    const [d,m]=miss(off); if(ok(d,m) && d<bd){ bd=d; best=off; }
  }
  return best;
}
// Виртуализация: в DOM — видимые строки и буфер, остальное — распорки по высоте (строки однострочные, высота одна: --rh)
const TBL_BUF=12, TBL_Q=8, TBL_W0=60;
function tblWindow(n,N){
  const ui=n.ui, rh=ui.rh, W=rh ? Math.ceil((ui.vh||300)/rh)+2*TBL_BUF : TBL_W0;
  let s=0;
  if(ui.tail && (ui.jump || ui.atEnd)) s=N-W;
  else if(rh) s=Math.floor(Math.max(0,Math.floor(Math.max(0,(ui.st||0)-(ui.hdh||0))/rh)-TBL_BUF)/TBL_Q)*TBL_Q;
  s=Math.max(0,Math.min(s,N-W));
  return [s,Math.min(N,s+W)];
}
// положение прокрутки и размер видимой области — из события, а не чтением layout на каждой перерисовке
function tblScrolled(n){
  const ui=n.ui, list=ui.list;
  ui.st=list.scrollTop; ui.vh=list.clientHeight; ui.atEnd=ui.st+ui.vh>=list.scrollHeight-4;
  if(!ui.rend || tcCardish(n)) return;
  const [s,e]=tblWindow(n,n.rows.length);
  if(s!==ui.rend.s || e!==ui.rend.e) tblRenderList(n);
}
function tblRenderList(n,inc){
  const ui=n.ui, list=ui.list, N=n.rows.length, ro=tblRO(n), grid=tcView(n)==='grid';
  // перерисовка при новых записях не должна сбрасывать прокрутку: запоминаем позицию, у низа в режиме tail — остаёмся у низа
  // чтение scrollTop / scrollHeight форсирует layout — только там, где позиция реально нужна
  const atEndNow=()=>list.scrollTop+list.clientHeight>=list.scrollHeight-4;
  list.classList.toggle('grid',grid); list.classList.toggle('cards',tcView(n)==='cards'); list.classList.toggle('icons',tcView(n)==='icons'); tcViewBtn(n);
  ui.count.textContent=(n.p.filter ? N+'/' : '')+n.all.length+' rows';
  ui.crumb.hidden=!n.drill || n.drill.to!==n.p.list;
  if(n.drill) ui.crumb.textContent='← '+n.drill.label;
  if(!N){
    const e=document.createElement('div');
    e.textContent=n.all.length ? 'nothing matches' : ro ? 'empty' : 'empty — add a row, import a file or wire rec / text';
    e.className='tbl-empty';
    list.replaceChildren(e); ui.marked=-1; ui.rend=null; return;
  }
  n.bgCtx=tblTintCtx(n);
  if(tcCardish(n)){ const keep=list.scrollTop; tcCards(n); list.scrollTop=keep; return; }
  // Окно строк [s,e) — видимые и буфер: дописанные записи, сдвиг прокруткой и потолком maxRows (сверху убираются, снизу достраиваются),
  // изменившиеся ячейки — точечно; список пересобирается только при смене колонок / сортировки / режима. Ширины колонок только растут.
  let base=ui.rend;
  if(!base || base.grid!==grid){ ui.rh=0; list.style.removeProperty('--rh'); }     // режим другой — высоту строки измерить заново
  const [s,e]=tblWindow(n,N);
  let vc=null, texts=null, wid=null, tc='', hk='';
  if(grid){
    vc=tblViewCols(n).filter(x=>!x.hide);
    hk=vc.map(x=>x.c).join('\n')+'\n'+n.p.sortCol+n.p.sortDir;
    const prev=base && base.grid && base.hk===hk ? base.wid : null;
    wid=vc.map((x,k)=>Math.max(x.c.length,2,prev ? prev[k] : 0));
    texts=[];
    for(let i=s;i<e;i++){
      const t=vc.map(x=>tblCell(x,n.rows[i][x.c],n.p.tz==='local'));
      t.forEach((v,k)=>{ if(v.length>wid[k]) wid[k]=v.length; });
      texts.push(t);
    }
    tc='5ch '+vc.map((x,k)=>x.w>0 ? x.w+'px' : Math.min(28,wid[k]+2)+'ch').join(' ')+' 56px';
  }
  const sigs=[], named=tcHasName(n);                  // без имени подпись «#номер» — от позиции, в подпись строки не входит
  for(let i=s;i<e;i++){
    const r=n.rows[i], bg=tblRowBg(n,r);
    sigs.push(grid ? texts[i-s].join('\u0001')+'\u0002'+bg : (named ? n.labelFn(r) : '')+'\u0002'+tblSummary(n,r)+'\u0002'+bg+'\u0002'+(n.colorCol ? r[n.colorCol] : '')+'\u0002'+n.cl.filter(c=>{ const t=tblType(n,c); return t==='photo' || t==='audio' || t==='file'; }).map(c=>r[c]).join(','));
  }
  const rowAt=i=>tblRow(n,i,ro,grid ? {vc,t:texts[i-s]} : null);
  const spacers=sp=>{ const rh=ui.rh||0; sp.sp0.style.height=s*rh+'px'; sp.sp1.style.height=(N-e)*rh+'px'; };
  const atEnd=ui.tail && (ui.jump || ui.atEnd);
  const toEnd=()=>{ list.scrollTop=list.scrollHeight; ui.jump=false; ui.st=list.scrollTop; ui.atEnd=true; };
  const off=!n.uiFull && base && base.els && base.els.length && base.sp0 && base.grid===grid && base.ro===ro && base.hk===hk && list.contains(base.els[0])
    ? tblAlign(base.sigs,sigs,s-base.s) : NaN;
  if(off===off){
    const sp0=base.sp0, sp1=base.sp1, len=e-s;
    let els=base.els.slice(), old=base.sigs.slice(), changed=off!==0 || len!==els.length;
    if(off>0){ for(let k=0;k<off;k++) els[k].remove(); els.splice(0,off); old.splice(0,off); }
    else if(off<0){
      const fr=document.createDocumentFragment(), pe=[];
      for(let j=0;j<-off && j<len;j++){ const row=rowAt(s+j); pe.push(row); fr.append(row); }
      sp0.after(fr); els=pe.concat(els); old=sigs.slice(0,pe.length).concat(old);
    }
    while(els.length>len){ els.pop().remove(); old.pop(); }
    for(let k=0;k<els.length;k++){
      const el=els[k], i=s+k;
      if(sigs[k]!==old[k] && !el.classList.contains('edit')){      // строка в правке: форму не рвём
        const row=rowAt(i);
        el.replaceWith(row); els[k]=row; old[k]=sigs[k]; changed=true;
      } else if(+el.dataset.i!==i){                                   // строка уехала на другую позицию: только номер
        el.dataset.i=i; el.removeAttribute('title');
        if(grid) el.firstChild.textContent=i+1;
        else if(!named) el.querySelector('.tbl-rname').textContent='#'+(i+1);
        changed=true;
      }
    }
    if(grid && tc!==base.tc) list.style.setProperty('--tc',tc);
    for(let i=s+els.length;i<e;i++){
      const row=rowAt(i);
      sp1.before(row);
      els.push(row); old.push(sigs[i-s]);
    }
    ui.rend={grid,s,e,vc,wid,tc,hk,ro,sp0,sp1,els,sigs:old};
    spacers(ui.rend);
    if(changed) ui.marked=-1;
    if(atEnd) toEnd();
    tblMark(n,true);
    return;
  }
  const keep=list.scrollTop;
  const frag=document.createDocumentFragment();
  let hd=null;
  if(grid){
    list.style.setProperty('--tc',tc);
    hd=document.createElement('div'); hd.className='tbl-hd';
    hd.append(Object.assign(document.createElement('span'),{textContent:'#',className:'tbl-no'}));
    for(const x of vc){
      const on=n.p.sortCol===x.c, h=Object.assign(document.createElement('span'),{textContent:x.c+(on ? (n.p.sortDir<0 ? ' ▼' : ' ▲') : ''),title:x.c+' — click to sort'});
      h.dataset.c=x.c; h.style.cursor='pointer'; hd.append(h);
    }
    hd.append(document.createElement('span'));
    frag.append(hd);
  } else list.style.removeProperty('--tc');
  const sp0=document.createElement('div'), sp1=document.createElement('div');
  sp0.className=sp1.className='tbl-sp';
  frag.append(sp0);
  const els=[];
  for(let i=s;i<e;i++){ const row=rowAt(i); els.push(row); frag.append(row); }
  frag.append(sp1);
  ui.rend={grid,s,e,vc,wid,tc,hk,ro,sp0,sp1,els,sigs};
  n.uiFull=false;
  list.replaceChildren(frag);                            // одна атомарная замена: прокрутка не сбрасывается
  if(!ui.rh){                                            // высота строки: измеряем один раз на режим, дальше строкам задаётся --rh
    const k=list.offsetHeight ? list.getBoundingClientRect().height/list.offsetHeight : 1;      // холст может быть в масштабе: нужны layout-пиксели
    let h=0; for(const r of els.slice(0,6)) h=Math.max(h,r.getBoundingClientRect().height/k);
    if(h>0){
      ui.rh=h; list.style.setProperty('--rh',h+'px'); ui.hdh=hd ? hd.getBoundingClientRect().height/k : 0; ui.vh=list.clientHeight;
      list.scrollTop=keep; ui.st=keep;
      return tblRenderList(n);                           // окно теперь считается по настоящей высоте
    }
  }
  spacers(ui.rend);
  list.scrollTop=atEnd ? list.scrollHeight : keep;
  if(atEnd) toEnd(); else ui.st=keep;
  ui.marked=-1; tblMark(n,true);
}
/* ---------- вид: колонки, форматы, раскраска ---------- */
// p.vcols = [{c, fmt, w, hide}] — порядок, формат ячейки, ширина (px, 0 — по содержимому), скрытие;
// колонки списка, которых там нет, дописываются в конец. p.rules = [{q, bg, on}] — первое совпавшее правило красит строку
// (q — тот же язык, что у фильтра). Не совпало ни одно — цвет по умолчанию (p.tint): колонка color → ошибка (err ≠ 0) → severity (err / warn) →
// значение колонки типа (proto, type, kind, mode…), у каждого значения свой оттенок; '-' — без раскраски.
const TBL_FMTS=['auto','text','hz','time','hex','num','swatch'];
const TBL_ERR=['err','error','errors','crc_err','crc_fail','bad'];
const TBL_SEV=['level','severity','lvl','sev','status'], TBL_CAT=['proto','protocol','type','kind','mode','service','modulation','demod','class','category','dir'];
function tblViewCols(n){
  const spec=Array.isArray(n.p.vcols) ? n.p.vcols : [], seen=new Set(), out=[];
  for(const x of spec) if(x && n.cl.includes(x.c) && !seen.has(x.c)){ seen.add(x.c); out.push({fmt:'auto',w:0,...x,ty:tblType(n,x.c)}); }
  for(const c of n.cl) if(!seen.has(c)) out.push({c,fmt:'auto',w:0,ty:tblType(n,c)});
  return out;
}
const tblTime=(v,local)=>{
  const ms=v>1e11 ? v : v>1e8 ? v*1000 : null;
  if(ms==null) return +v.toFixed(3)+'s';
  if(!local) return new Date(ms).toISOString().slice(11,23);
  const d=new Date(ms), z=(k,w=2)=>String(k).padStart(w,'0');
  return z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds())+'.'+z(d.getMilliseconds(),3);
};
function tblCell(x,v,local){
  if(v===''||v==null) return '';
  const low=x.c.toLowerCase(), f=x.fmt||'auto';
  if(f==='auto'){
    if(x.ty==='photo'){ const k=phIds(v).length; return k ? '📷'+k : ''; }
    if(x.ty==='audio'){ const k=auIds(v).length; return k ? '🔊'+k : ''; }
    if(x.ty==='file'){ const k=tcFileIds(v).length; return k ? '📎'+k : ''; }
    if(x.ty==='checklist') return '☑ '+v;
    if(x.ty==='bool' || x.ty==='link') return x.ty==='bool' ? (tcIsTrue(v) ? '✓' : '✗') : tcLinks(v).join(', ');
    if(TBL_HZ.test(x.c)){ const h=tblHz(v); return isFinite(h) ? fmtHz(h,3) : recFmt(v); }
    if(/^(t|ts|time|date|datetime)$/.test(low) && typeof v==='number') return tblTime(v,local);
    return recFmt(v);
  }
  if(f==='hz'){ const h=tblHz(v); return isFinite(h) ? fmtHz(h,3)+'Hz' : recFmt(v); }
  if(f==='time') return typeof v==='number' ? tblTime(v,local) : recFmt(v);
  if(f==='hex') return typeof v==='number' && Number.isInteger(v) ? (v<0?'-':'')+'0x'+Math.abs(v).toString(16) : recFmt(v,true);
  if(f==='num'){ const k=typeof v==='number' ? v : parseFloat(v); return isFinite(k) ? String(+k.toFixed(3)) : recFmt(v); }
  return recFmt(v);
}
function tblCellEl(n,x,v,text){
  const el=document.createElement('span'), low=x.c.toLowerCase();
  el.className='tbl-c'; el.title=text;
  const ph=x.ty==='photo', fl=x.ty==='file', ids=ph ? phIds(v) : fl ? tcFileIds(v) : x.ty==='audio' ? auIds(v) : null;
  if(ids && x.fmt==='auto'){
    if(ids.length){
      el.textContent=text; el.classList.add('tbl-ico','warn');
      el.title=ph ? 'Show the photos' : fl ? 'Open the file' : 'Play the audio';
      el.dataset.act='media';
      el.addEventListener('click',e=>{ e.stopPropagation(); ph ? phView(ids) : fl ? tcFileOpen(ids[0]) : auView(ids); });
    }
    return el;
  }
  if(x.ty==='checklist'){ el.textContent=text; el.classList.add('tc-chk','tbl-ico'); el.dataset.c=x.c; el.title='Open the checklist'; return el; }
  if(x.ty==='bool' && x.fmt==='auto' && n.drill && !tblRO(n)){ el.textContent=text; el.classList.add('tc-tog'); el.dataset.c=x.c; el.title='Tick / untick'; el.style.cursor='pointer'; return el; }
  if(x.ty==='progress' && x.fmt==='auto' && tcFrac(n,x.c,v)!=null){ el.classList.add('tbl-bar'); el.append(tcBar(n,x.c,v,text)); return el; }
  if((x.fmt==='swatch' || (x.fmt==='auto' && TBL_COLOR.includes(low))) && v && CSS.supports('color',String(v))){
    const sw=document.createElement('i'); sw.className='tbl-sw'; sw.style.background=String(v); el.append(sw);
  }
  el.append(text);
  if(typeof v==='number') el.classList.add('r');
  return el;
}
const tblHue=s=>{ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0)%360; };
function tblTintCtx(n){
  const t=n.p.tint;
  if(t==='-') return {off:true};
  if(t) return {cat:n.cl.includes(t) ? t : null};
  return {color:n.colorCol, err:tblCol(n.cl,TBL_ERR), sev:tblCol(n.cl,TBL_SEV), cat:tblCol(n.cl,TBL_CAT)};
}
function tblRules(n){
  const rs=Array.isArray(n.p.rules) ? n.p.rules : [];
  if(n._rcRef!==rs){
    n._rcRef=rs;
    n._rc=rs.filter(x=>x && x.on!==false && x.q && x.bg).map(x=>({f:tblFilter(x.q),bg:x.bg})).filter(x=>x.f);
  }
  return n._rc;
}
function tblRowBg(n,r){
  for(const x of tblRules(n)) if(x.f(r)) return x.bg;
  const c=n.bgCtx; if(!c || c.off) return '';
  if(c.color){ const v=r[c.color]; if(v && CSS.supports('color',String(v))) return String(v); }
  if(c.err){ const v=r[c.err]; if(v!=='' && v!=null && v!==0 && !/^(0|false|no|ok)$/i.test(String(v))) return '#e05c5c'; }
  if(c.sev){
    const v=String(r[c.sev]??'');
    if(/^(err|fail|crit|fatal|bad|alarm)/i.test(v)) return '#e05c5c';
    if(/^warn/i.test(v)) return '#e0b23c';
  }
  if(c.cat){ const v=r[c.cat]; if(v!=='' && v!=null) return 'hsl('+tblHue(String(v))+' 65% 50%)'; }
  return '';
}
// строка: цвет · имя · значения; диапазон частот — в виде 7.0M-7.2M
function tblSummary(n,r){
  const skip=new Set([n.nameCol,n.colorCol].filter(Boolean));
  const lo=n.loCol, hi=n.hiCol;
  const parts=[];
  if(lo){
    const l=tblHz(r[lo]);
    if(isFinite(l)){ const h=hi ? tblHz(r[hi]) : l; parts.push(isFinite(h) && h>l ? fmtHz(l,3)+'-'+fmtHz(h,3) : fmtHz(l,3)); skip.add(lo); if(hi) skip.add(hi); }
  }
  if(lo) skip.add(tblCol(n.cl,TBL_STEP));                // шаг сетки — в подсказке
  for(const c of n.cl) if(!skip.has(c) && !tcMetaType(tblType(n,c)) && r[c]!=='' && r[c]!=null) parts.push(tcText(n,c,r[c]));
  return parts.join(' / ');
}
// подсказка строки — при наведении, а не на каждую из сотен строк при каждой перерисовке (строки и GC)
const tblRowTip=(n,r)=>n.cl.filter(c=>r[c]!=='' && r[c]!=null).map(c=>c+': '+(TBL_HZ.test(c)&&isFinite(tblHz(r[c])) ? fmtHz(tblHz(r[c]),4)+'Hz' : recFmt(r[c]))).join('\n');
function tblRow(n,i,ro,g){
  const r=n.rows[i];
  const row=document.createElement('div');
  row.dataset.i=i;
  row.className='tbl-row';
  const label=tcTitle(n,r,i);
  const bg=tblRowBg(n,r);
  if(bg) row.style.setProperty('--rb','color-mix(in srgb,'+bg+' 24%,transparent)');
  if(g){
    row.append(Object.assign(document.createElement('span'),{className:'tbl-no',textContent:i+1}));
    g.vc.forEach((x,k)=>row.append(tblCellEl(n,x,r[x.c],g.t[k])));
  } else {
    if(n.colorCol){
      const sw=document.createElement('span');
      sw.style.cssText=`width:9px;height:9px;border-radius:2px;flex-shrink:0;background:${escapeHtml(String(r[n.colorCol]||'#c9c9c9'))};`;
      row.append(sw);
    }
    const name=document.createElement('span');
    name.textContent=label;
    name.className='tbl-rname';
    const val=document.createElement('span');
    val.textContent=tblSummary(n,r);
    val.className='tbl-rval';
    row.append(name,val);
    const pc=n.cl.find(c=>tblType(n,c)==='photo'), pids=pc ? phIds(r[pc]) : [];
    if(pids.length){
      const ph=document.createElement('span');
      ph.textContent='📷'+pids.length; ph.title='Show the photos'; ph.className='tbl-ico warn'; ph.dataset.act='media';
      ph.addEventListener('click',e=>{ e.stopPropagation(); phView(pids); });
      row.append(ph);
    }
    const ac=n.cl.find(c=>tblType(n,c)==='audio'), aids=ac ? auIds(r[ac]) : [];
    if(aids.length){
      const au=document.createElement('span');
      au.textContent='🔊'+aids.length; au.title='Play the audio'; au.className='tbl-ico warn'; au.dataset.act='media';
      au.addEventListener('click',e=>{ e.stopPropagation(); auView(aids); });
      row.append(au);
    }
  }
  if(g){ const tail=document.createElement('span'); tail.className='tbl-tail'; row.append(tail); row._tail=tail; }
  if(!ro){
    const ed=document.createElement('span');
    ed.textContent='✎'; ed.className='tbl-ico'; ed.title='Edit'; ed.dataset.act='edit';
    const del=document.createElement('span');
    del.textContent='🗑'; del.className='tbl-ico'; del.title='Delete'; del.dataset.act='del';
    (row._tail||row).append(ed,del);
  }
  return row;
}
function tblSelect(n,i){                                // выбор записи: уходит на выходы
  n.pick=i; n.idx=i; n.cur={...n.rows[i]}; n.p.sel=n.rowIds[i]; n.hlSel=true;
  tblMark(n);
}
// ↑ ↓ PgUp PgDn Home End по списку; без выбора ↓ берёт первую запись, ↑ — последнюю
function tblFilterMark(n){                              // ошибка выражения — красная рамка и текст в подсказке
  const el=n.ui?.filter; if(!el) return;
  el.classList.toggle('bad',!!n.ferr);
  if(n.ferr) el.dataset.err='1'; else delete el.dataset.err;
  if(n.ferr) el.title='filter: '+n.ferr;
  else if(el.dataset.tip) el.title=el.dataset.tip;
}
function tblKey(n,e){
  const N=n.rows.length;
  if(!N || e.altKey || e.ctrlKey || e.metaKey) return;
  const s=0, last=N-1;
  const cur=n.ui.marked, page=Math.max(1,Math.floor(n.ui.list.clientHeight/(n.ui.rh||24))-1);
  let i;
  switch(e.key){
    case 'ArrowDown': i=cur<0 ? s : cur+1; break;
    case 'ArrowUp': i=cur<0 ? last : cur-1; break;
    case 'PageDown': i=cur<0 ? s : cur+page; break;
    case 'PageUp': i=cur<0 ? last : cur-page; break;
    case 'Home': i=s; break;
    case 'End': i=last; break;
    default: return;
  }
  e.preventDefault(); e.stopPropagation();
  tblSelect(n,clamp(i,s,last));
}
// подсветка текущей записи (выбранной или выданной секвенсором); строки вне окна прокрутка подтягивает, перерисовка отметит
function tblMark(n,still){
  const ui=n.ui, want=n.rows.length && (n.started || n.p.sel!=null) ? n.idx : -1;
  if(ui.marked===want) return;
  ui.marked=want;
  ui.markEl?.classList.remove('on'); ui.markEl=null;
  const rd=ui.rend, list=ui.list;
  if(want<0 || !rd) return;
  const el=want>=rd.s && want<rd.e ? rd.els[want-rd.s] : null;
  if(el){
    el.classList.add('on'); ui.markEl=el;
    if(!still){ const t=el.offsetTop-list.clientHeight/2; if(el.offsetTop<list.scrollTop+(ui.hdh||0) || el.offsetTop+el.offsetHeight>list.scrollTop+list.clientHeight) list.scrollTop=Math.max(0,t); }
  } else if(!still && ui.rh) list.scrollTop=Math.max(0,want*ui.rh+(ui.hdh||0)-list.clientHeight/2);
}
// панель «▦ view»: колонки (показ, порядок, формат, ширина), раскладка и правила раскраски строк
function tblViewToggle(n){
  const v=n.ui.view; v.hidden=!v.hidden; n.viewOpen=!v.hidden;
  n.ui.root.querySelector('.tbl-viewb').classList.toggle('on',!v.hidden);
  if(!v.hidden) tblRenderView(n);
}
function tblViewApply(n,key,val,panel){
  n.p[key]=val;
  tblRenderList(n);
  if(panel) tblRenderView(n);
  Undo.push();
}
function tblViewColEdit(n,fn){ const v=tblViewCols(n).map(x=>({...x})); fn(v); tblViewApply(n,'vcols',v,true); }
function tblRenderView(n){
  const box=n.ui.view;
  n._vr=true; box.innerHTML='';
  const mk=(tag,cls,txt,ev)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; if(ev) for(const k in ev) e.addEventListener(k,ev[k]); return e; };
  const sel=(opts,val,fn)=>{ const e=mk('select'); for(const o of opts){ const op=mk('option',null,Array.isArray(o) ? o[1] : o); op.value=Array.isArray(o) ? o[0] : o; e.append(op); } e.value=val; e.addEventListener('change',()=>fn(e.value)); return e; };
  const top=mk('div','tv-top');
  top.append(mk('span','tv-ttl','Fields & colors'),
    sel([['cards','cards (photo, fields)'],['grid','full list (columns)'],['compact','brief list (name · values)'],['icons','list with icons (avatar, online, typing)']],tcView(n),x=>tblViewApply(n,'vmode',x,true)),
    sel([['utc','time: UTC'],['local','time: local']],n.p.tz==='local' ? 'local' : 'utc',x=>tblViewApply(n,'tz',x,true)),
    mk('span','tv-x','✕',{click:()=>tblViewToggle(n)}));
  box.append(top);
  tblFieldsPanel(n,box,mk,sel);
  const rules=Array.isArray(n.p.rules) ? n.p.rules : [];
  const rh=mk('div','tv-sec tv-fold',(n.rulesOpen ? '▾ ' : '▸ ')+'Row colors'+(rules.length ? ' ('+rules.length+')' : '')+' — the first matching rule wins',{click:()=>{ n.rulesOpen=!n.rulesOpen; tblRenderView(n); }});
  box.append(rh);
  if(n.rulesOpen){
  const setRules=(fn,panel)=>{ const r=rules.map(x=>({...x})); fn(r); tblViewApply(n,'rules',r,panel); };
  rules.forEach((x,i)=>{
    const row=mk('div','tv-rule');
    const cb=mk('input'); cb.type='checkbox'; cb.checked=x.on!==false;
    cb.addEventListener('change',()=>setRules(r=>{ r[i].on=cb.checked; },false));
    const q=mk('input','tv-q'); q.value=x.q||''; q.placeholder='filter: err>0  level:warn  proto:tcp';
    q.title='same syntax as the list filter';
    q.addEventListener('keydown',e=>e.stopPropagation());
    q.addEventListener('input',()=>setRules(r=>{ r[i].q=q.value; },false));
    const c=mk('input'); c.type='color'; c.value=/^#[0-9a-f]{6}$/i.test(x.bg) ? x.bg : '#e05c5c';
    c.addEventListener('input',()=>setRules(r=>{ r[i].bg=c.value; },false));
    row.append(cb,q,c,
      mk('span','tv-mv','▲',{click:()=>{ if(i) setRules(r=>{ [r[i-1],r[i]]=[r[i],r[i-1]]; },true); }}),
      mk('span','tv-mv','✕',{click:()=>setRules(r=>{ r.splice(i,1); },true)}));
    box.append(row);
  });
  const acts=mk('div','tv-acts');
  acts.append(mk('button','tbl-btn pri','+ rule',{click:()=>setRules(r=>{ r.push({q:'',bg:'#e05c5c',on:true}); },true)}));
  const cols=['',...n.cl];
  const tintVal=n.p.tint==null ? '' : n.p.tint;
  acts.append(mk('span','tv-lbl','otherwise colour by'),
    sel([['','auto (color, severity, type…)'],['-','nothing'],...n.cl.map(c=>[c,'value of '+c])],cols.includes(tintVal) || tintVal==='-' ? tintVal : '',x=>tblViewApply(n,'tint',x,false)));
  box.append(acts);
  }
  const settle=()=>{ box.scrollTop=n.viewScroll||0; if(n.viewNew) box.querySelector('.tv-new')?.focus({preventScroll:true}); };
  settle(); requestAnimationFrame(()=>{ settle(); n._vr=false; });             // узел мог ещё не попасть в DOM
}
// список колонок одним действием: cl — новый набор, ren — {новое имя: старое}; схема, порядок колонок и раскраска следуют за именами
async function tblColsApply(n,cl,ren={},fill){
  if(tblRO(n)) return;
  const fwd={}; for(const k in ren) fwd[ren[k]]=k;
  const nm=c=>fwd[c]??c, live=c=>cl.includes(nm(c));
  const sc=n.schema, types={};
  for(const k in sc.types) if(live(k)) types[nm(k)]=sc.types[k];
  sc.types=types; sc.card.show=(sc.card.show||[]).filter(live).map(nm);
  if(sc.card.lines) sc.card.lines=sc.card.lines.map(l=>l.filter(live).map(nm));
  if(sc.card.unique) sc.card.unique=sc.card.unique.filter(a=>a.every(live)).map(a=>a.map(nm));
  if(sc.card.seq){ const q={}; for(const k in sc.card.seq) if(live(k)) q[nm(k)]=sc.card.seq[k]; sc.card.seq=q; }
  for(const k in ren) for(const c in types) if(types[c].expr) types[c]={...types[c],expr:trRenameRef(types[c].expr,ren[k],k)};
  if(sc.card.label){                                      // шаблон названия следует за переименованием, убранные поля выпадают
    sc.card.label=sc.card.label.replace(/\{([^{}]+)\}/g,(m,c)=>live(c) ? '{'+nm(c)+'}' : '');
    if(!/\{[^{}]+\}/.test(sc.card.label)) delete sc.card.label;
  }
  if(Array.isArray(n.p.vcols)) n.p.vcols=n.p.vcols.filter(x=>x && live(x.c)).map(x=>({...x,c:nm(x.c)}));
  if(Array.isArray(n.p.pout)) n.p.pout=n.p.pout.filter(live).map(nm);
  if(n.p.pref){ const q={}; for(const k in n.p.pref) if(live(k)) q[nm(k)]=n.p.pref[k]; n.p.pref=q; }
  if(n.p.tint) n.p.tint=nm(n.p.tint);
  const sv=tcSchemaSave(n), done=tblColsEdit(n,cl,ren,fill);   // n.cl уже новый — панель можно перерисовать, не дожидаясь базы
  tblRenderView(n);
  await Promise.all([sv,done]);
  tblRenderList(n);
}
// «Fields» панели view: строка — показ, имя (клик — переименовать), тип, ⋯ (подробности), ✕; порядок — перетаскиванием.
// «Показ» — один флажок и для карточки, и для колонки списка; формат, ширина, варианты и связь — под ⋯
function tblFieldsPanel(n,box,mk,sel){
  const ro=tblRO(n), grid=tcView(n)==='grid';
  n.fieldOpen=n.fieldOpen||new Set();
  box.append(mk('div','tv-sec','Fields'));
  const bar=mk('div','tv-acts'); box.append(bar);
  if(!ro){
    const row=mk('div','tv-col'), inp=mk('input','tv-q'); inp.placeholder='new field name';
    const add=async()=>{
      const v=inp.value.trim(); if(!v) return;
      if(n.cl.includes(v)){ inp.select(); return; }
      n.viewNew=true;
      await tblColsApply(n,n.cl.concat([v]));
    };
    inp.classList.add('tv-new');
    inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') add(); });
    row.append(inp,mk('button','tbl-btn pri','+ field',{click:add}));
    box.append(row);
  }
  {
    const row=mk('div','tv-col'), q=mk('input','tv-q');
    q.value=n.schema.card.label||''; q.placeholder=n.nameCol ? '{'+n.nameCol+'}' : '{field} {field}';
    q.title='record name in links and cards: fields in braces, e.g. {Surname} {Name} {Patronymic}; empty — the name column'; q.disabled=ro;
    q.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') q.blur(); });
    q.addEventListener('change',()=>tcSetLabel(n,q.value.trim()));
    row.append(mk('span','tv-lbl','record name'),q);
    if(!ro) row.append(sel([['','＋ field'],...n.cl.map(c=>[c,c])],'',c=>{ if(c) tcSetLabel(n,((q.value.trim()+' ').trimStart()+'{'+c+'}')); }));
    box.append(row);
    {                                                    // уникальность по набору полей: «Surname, Name; Phone»
      const ur=mk('div','tv-col'), u=mk('input','tv-q');
      u.value=(n.schema.card.unique||[]).map(a=>a.join(', ')).join('; '); u.placeholder='Surname, Name; Phone'; u.disabled=ro;
      u.title='unique: groups of fields separated by ; — no two rows may repeat the same group (an empty field in a group is ignored)';
      u.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') u.blur(); });
      u.addEventListener('change',async()=>{
        const sets=trParseUnique(n,u.value), bad=trDupes(n,sets);
        if(bad && !confirm(bad+' existing row(s) already repeat these fields; they stay, new duplicates will be refused. Continue?')){ u.value=(n.schema.card.unique||[]).map(a=>a.join(', ')).join('; '); return; }
        if(sets.length) n.schema.card.unique=sets; else delete n.schema.card.unique;
        await tcSchemaSave(n); tblRenderView(n);
      });
      ur.append(mk('span','tv-lbl','unique'),u); box.append(ur);
    }
  }
  if(tcView(n)==='cards') tcLayoutPanel(n,box,mk,sel);
  const lists=(n.treeNames||[]).filter(x=>tblKind(x)!=='preset');
  const vc=tblViewCols(n), card=new Set(tcShowCols(n));
  {
    const anyOn=vc.some(x=>grid ? !x.hide : card.has(x.c));
    bar.append(mk('button','tbl-btn',anyOn ? '👁 Hide all' : '👁 Show all',{click:()=>{
      n.schema.card.show=anyOn ? [] : n.cl.slice();
      if(!ro) tcSchemaSave(n);
      tblViewColEdit(n,v=>{ for(const x of v) x.hide=anyOn; });
    }}));
    if(!ro) bar.append(mk('button','tbl-btn','🗑 Clear fields',{click:async()=>{
      if(!n.cl.length) return;
      if(!confirm('Remove all '+n.cl.length+' fields and the '+n.all.length+' row(s) of "'+tblLeaf(n.p.list)+'"? The structure can then be set anew.')) return;
      await tblClear(n);
      await tblColsApply(n,[]);
    }}));
  }
  let drag=-1;
  vc.forEach((x,i)=>{
    const c=x.c, d=tcDef(n,c), t=d.t||(tblType(n,c)==='text' ? 'text' : tblType(n,c)), open=n.fieldOpen.has(c);
    const on=grid ? !x.hide : card.has(c);
    const row=mk('div','tv-col'+(on ? '' : ' off'));
    const cb=mk('input'); cb.type='checkbox'; cb.checked=on; cb.title='show';
    cb.addEventListener('change',()=>{
      const s=new Set(tcShowCols(n)); cb.checked ? s.add(c) : s.delete(c);
      n.schema.card.show=n.cl.filter(k=>s.has(k));
      if(!ro) tcSchemaSave(n);
      tblViewColEdit(n,v=>{ v[i].hide=!cb.checked; });
    });
    row.append(cb);
    const name=mk('span','tv-name',c);
    if(!ro){
      name.title='click to rename'; name.classList.add('tv-ren');
      name.addEventListener('click',()=>{
        const e=mk('input','tv-q'); e.value=c;
        let fin=false;
        const end=async ok=>{
          if(fin) return; fin=true;
          const v=e.value.trim();
          if(ok && v && v!==c && !n.cl.includes(v)) await tblColsApply(n,n.cl.map(k=>k===c ? v : k),{[v]:c});
          else tblRenderView(n);
        };
        e.addEventListener('keydown',ev=>{ ev.stopPropagation(); if(ev.key==='Enter') end(true); else if(ev.key==='Escape') end(false); });
        e.addEventListener('blur',()=>end(true));
        name.replaceWith(e); e.focus(); e.select();
      });
    }
    row.append(name);
    if(!ro) row.append(sel(TC_TYPES,t,v=>{
      const nd={...d,t:v}; if(v!=='choice') delete nd.opts; if(v!=='link' && v!=='checklist'){ delete nd.to; } if(v!=='link'){ delete nd.multi; } if(v!=='progress'){ delete nd.min; delete nd.max; } if(v!=='calc'){ delete nd.expr; delete nd.mat; } if(v==='calc' || v==='auto'){ delete nd.def; delete nd.req; }
      if(v==='checklist' && !nd.to){ tcChkCreate(n,c).then(to=>tcSetDef(n,c,{...nd,to})).then(()=>{ tblRenderView(n); tblRenderList(n); }); return; }
      tcSetDef(n,c,nd); tblRenderView(n); tblRenderList(n);
    }));
    const po=mk('input'); po.type='checkbox'; po.checked=!Array.isArray(n.p.pout) || n.p.pout.includes(c);
    po.title='output port: this field as a wire'; po.addEventListener('change',()=>tblOutSet(n,c,po.checked));
    row.append(mk('span','tv-lbl','→'),po);
    row.append(mk('span','tv-mv',open ? '▾' : '⋯',{click:()=>{ open ? n.fieldOpen.delete(c) : n.fieldOpen.add(c); tblRenderView(n); }}));
    // порядок: тащить за строку
    row.draggable=true;
    row.addEventListener('dragstart',e=>{ drag=i; e.dataTransfer.effectAllowed='move'; });
    row.addEventListener('dragover',e=>{ if(drag>=0){ e.preventDefault(); row.classList.add('over'); } });
    row.addEventListener('dragleave',()=>row.classList.remove('over'));
    row.addEventListener('drop',e=>{ e.preventDefault(); const from=drag; drag=-1; if(from>=0 && from!==i) tblViewColEdit(n,v=>{ v.splice(i,0,v.splice(from,1)[0]); }); });
    box.append(row);
    if(!open) return;
    const more=mk('div','tv-more');
    if(!ro && t==='choice'){
      const o=mk('input','tv-q'); o.value=(d.opts||[]).join(', '); o.placeholder='choice 1, choice 2, …';
      o.addEventListener('keydown',e=>e.stopPropagation());
      o.addEventListener('change',()=>tcSetDef(n,c,{...d,opts:o.value.split(',').map(s=>s.trim()).filter(Boolean)}));
      more.append(o);
    }
    if(!ro && t==='checklist'){
      more.append(sel([['','— list of items —'],...lists.map(k=>[k,tblKind(k)==='patch' ? 'This patch' : k])],d.to||'',v=>tcSetDef(n,c,{...d,to:v})));
      more.append(mk('span','tv-lbl','items of this list with a link to the record and a checkbox'));
    }
    if(!ro && t==='link'){
      more.append(sel([['','— list —'],...lists.map(k=>[k,tblKind(k)==='patch' ? 'This patch' : k])],d.to||'',v=>tcSetDef(n,c,{...d,to:v})));
      const m=mk('input'); m.type='checkbox'; m.checked=!!d.multi; m.title='several entries';
      m.addEventListener('change',()=>tcSetDef(n,c,{...d,multi:m.checked}));
      more.append(m,mk('span','tv-lbl','many'));
    }
    if(t==='link' && d.to){
      const rf=mk('div','tv-refs'); more.append(rf);
      (d.to===n.p.list ? Promise.resolve({cols:n.cl}) : tblReadList(n,d.to)).then(tg=>{
        rf.append(mk('span','tv-lbl','linked record → outputs:'));
        for(const f of tg.cols){
          const cb=mk('input'); cb.type='checkbox'; cb.checked=(n.p.pref?.[c]||[]).includes(f);
          cb.addEventListener('change',()=>tblRefSet(n,c,f,cb.checked));
          rf.append(cb,mk('span','tv-lbl',f));
        }
      }).catch(()=>{});
    }
    if(!ro && t==='progress'){
      for(const k of ['min','max']){
        const e=mk('input','tv-w'); e.type='number'; e.step='any'; e.value=d[k]??''; e.placeholder=k==='min' ? '0' : '100'; e.title=k+' of the scale (empty — '+e.placeholder+')';
        e.addEventListener('keydown',ev=>ev.stopPropagation());
        e.addEventListener('change',()=>{ const nd={...d}; e.value.trim()==='' ? delete nd[k] : nd[k]=+e.value; tcSetDef(n,c,nd); tblRenderList(n); });
        more.append(mk('span','tv-lbl',k),e);
      }
    }
    if(!ro && t==='calc'){
      const e=mk('input','tv-q'); e.value=d.expr||''; e.placeholder='[price] * [qty]   round([a]/[b],2)   if([x]>5,\'big\',\'small\')';
      e.title='[Field] — value of a field; + - * / %, == != < > <= >=, && || !, a ? b : c; functions: round floor ceil abs sqrt pow min max if coalesce concat upper lower trim len substr contains num text now year month day';
      e.addEventListener('keydown',ev=>ev.stopPropagation());
      e.addEventListener('change',()=>tcSetDef(n,c,{...d,expr:e.value.trim()}));
      const m=mk('input'); m.type='checkbox'; m.checked=!!d.mat; m.title='stored in the list (frozen until the row is edited or recalculated); otherwise computed on load and not stored';
      m.addEventListener('change',()=>tcSetDef(n,c,{...d,mat:m.checked}));
      more.append(e,m,mk('span','tv-lbl','stored'),mk('button','tbl-btn','recalc',{click:async()=>{ await trRecalc(n); tblRenderView(n); tblRenderList(n); }}));
      if(n.calcErr?.[c]) more.append(mk('span','tv-lbl','⚠ '+n.calcErr[c]));
    }
    if(!ro && t!=='calc' && t!=='auto'){
      if(t!=='photo' && t!=='audio' && t!=='link' && t!=='file'){
        const df=mk('input','tv-q'); df.value=d.def??''; df.placeholder='default for new rows'; df.addEventListener('keydown',ev=>ev.stopPropagation());
        df.addEventListener('change',()=>tcSetDef(n,c,{...d,def:df.value}));
        more.append(df);
      }
      const rq=mk('input'); rq.type='checkbox'; rq.checked=!!d.req; rq.addEventListener('change',()=>tcSetDef(n,c,{...d,req:rq.checked}));
      more.append(rq,mk('span','tv-lbl','required'));
    }
    if(grid){
      const w=mk('input','tv-w'); w.type='number'; w.min=0; w.step=10; w.value=x.w||''; w.placeholder='auto'; w.title='width, px (empty — by content)';
      w.addEventListener('keydown',e=>e.stopPropagation());
      w.addEventListener('change',()=>tblViewColEdit(n,v=>{ v[i].w=Math.max(0,+w.value||0); }));
      more.append(sel(TBL_FMTS,x.fmt||'auto',f=>tblViewColEdit(n,v=>{ v[i].fmt=f; })),w);
    }
    if(!ro){
      more.append(mk('button','tbl-btn','⧉ duplicate',{click:()=>tblFieldDup(n,c)}),
        mk('button','tbl-btn','✕ remove',{click:()=>tblFieldDel(n,c)}));
    }
    box.append(more);
  });
  if(grid){ const ra=mk('div','tv-acts'); ra.append(mk('button','tbl-btn','Reset columns',{click:()=>tblViewApply(n,'vcols',null,true)})); box.append(ra); }
}
// копия поля со значениями, типом и настройками колонки — справа от исходного
async function tblFieldDup(n,c){
  let nm=c+' copy'; for(let k=2;n.cl.includes(nm);k++) nm=c+' copy '+k;
  const vals=n.all.map(r=>r[c]), def=tcDef(n,c), vcol=(n.p.vcols||[]).find(x=>x.c===c);
  const cl=n.cl.slice(); cl.splice(cl.indexOf(c)+1,0,nm);
  if(def.t) n.schema.types[nm]={...def};
  if(Array.isArray(n.p.vcols) && vcol) n.p.vcols=[...n.p.vcols,{...vcol,c:nm}];
  n.fieldOpen?.delete(c);
  await tblColsApply(n,cl,{},{[nm]:vals});
}
// узел после смены колонок собирается заново и не сразу попадает в DOM: тост ждёт живой интерфейс
function tblToast(n,text,undo,tries=30){
  if(n.ui?.root.isConnected) dspToast(n.ui.root,text,undo);
  else if(tries>0) setTimeout(()=>tblToast(n,text,undo,tries-1),100);
}
// удаление поля без вопросов — с отменой: значения, тип и настройки колонки возвращаются на то же место
async function tblFieldDel(n,c){
  const at=n.cl.indexOf(c), vals=n.all.map(r=>r[c]), def=tcDef(n,c), vcol=(n.p.vcols||[]).find(x=>x.c===c), card=(n.schema.card.show||[]).includes(c);
  await tblColsApply(n,n.cl.filter(k=>k!==c));
  tblToast(n,'Removed field "'+c+'".',async()=>{
    const cl=n.cl.slice(); cl.splice(Math.min(at,cl.length),0,c);
    if(def.t || def.opts || def.to) n.schema.types[c]=def;
    if(card) n.schema.card.show=cl.filter(k=>k===c || (n.schema.card.show||[]).includes(k));
    if(Array.isArray(n.p.vcols) && vcol) n.p.vcols=[...n.p.vcols,vcol];
    await tblColsApply(n,cl,{},{[c]:vals});
  });
}
function tblForm(n,rec,onSave,onCancel){
  const form=document.createElement('div');
  form.className='tbl-form';
  const ins={};
  const cl=n.cl.length ? n.cl : ['name'];
  for(const c of cl){
    const l=document.createElement('label');
    const ty=tblType(n,c);
    l.className=ty==='photo'||ty==='audio' ? 'wide' : '';
    let inp;
    const low=c.toLowerCase(), tf=TBL_COLOR.includes(low) ? null : tcFormField(n,c,rec,ty);
    if(tf){
      inp=tf.inp; if(tf.wide) l.className='wide';
      ins[c]=inp; l.append(Object.assign(document.createElement('span'),{textContent:c}),inp,...(tf.bar ? [tf.bar] : [])); form.append(l); continue;
    } else if(TBL_COLOR.includes(low)){
      inp=document.createElement('input'); inp.type='color'; inp.value=/^#[0-9a-f]{6}$/i.test(rec[c]) ? rec[c] : '#c9c9c9';
      inp.style.cssText='';
    } else if(ty==='photo'){                            // фото: добавить с камеры / из галереи, посмотреть; координаты и время из EXIF — в пустые поля
      inp=document.createElement('input'); inp.type='hidden'; inp.value=phJoin(phIds(rec[c]));
      const bar=document.createElement('span'); bar.className='tf-bar';
      const cnt=document.createElement('span'), mkb=(t,f)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=t; b.style.cssText=TBL_BTN; b.addEventListener('click',e=>{ e.preventDefault(); f(); }); return b; };
      const upd=()=>{ cnt.textContent=phIds(inp.value).length+' photos'; };
      bar.append(cnt,mkb('📷 add',async()=>{
        const got=await phPickAdd(); if(!got.length) return;
        inp.value=phJoin([...phIds(inp.value),...got.map(g=>g.id)]); upd();
        const x=got.find(g=>g.exif?.lat!=null)?.exif;
        if(x) for(const [k,v] of [['lat',x.lat],['lon',x.lon],['alt',x.alt],['t',x.t]]){ const f=ins[k]; if(f && v!=null && !String(f.value).trim()) f.value=k==='t' ? v : +v.toFixed(6); }
      }),mkb('view',()=>phView(phIds(inp.value))),mkb('clear',()=>{ inp.value=''; upd(); }));
      upd(); l.append(Object.assign(document.createElement('span'),{textContent:c}),inp,bar); ins[c]=inp; form.append(l); continue;
    } else if(low==='icon'){                            // значок точки на карте
      inp=document.createElement('select');
      const cur=String(rec[c]??''), opts=['',...TBL_ICONS]; if(cur && !opts.includes(cur)) opts.push(cur);
      for(const o of opts){ const op=document.createElement('option'); op.value=o; op.textContent=o||'(default)'; inp.append(op); }
      inp.value=cur; 
    } else if(ty==='audio'){                            // звук: записать, файл, клип из библиотеки; прослушать
      inp=document.createElement('input'); inp.type='hidden'; inp.value=auJoin(auIds(rec[c]));
      const bar=document.createElement('span'); bar.className='tf-bar';
      const cnt=document.createElement('span'), mkb=(t,f)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=t; b.style.cssText=TBL_BTN; b.addEventListener('click',e=>{ e.preventDefault(); f(b); }); return b; };
      const upd=()=>{ cnt.textContent=auIds(inp.value).length+' clips'; }, add=ids=>{ inp.value=auJoin([...auIds(inp.value),...ids.filter(Boolean)]); upd(); };
      let stopRec=null;
      bar.append(cnt,mkb('🎤 rec',async b=>{
        try{
          if(!stopRec){ stopRec=await auRecStart(); b.textContent='⏹ stop'; }
          else { const s=stopRec; stopRec=null; b.textContent='🎤 rec'; add([await s()]); }
        }catch(e){ stopRec=null; b.textContent='🎤 rec'; alert('Recording failed: '+e.message); }
      }),mkb('📁 file',async()=>add(await auPickAdd())),mkb('🎵 library',async()=>add([await auChoose()])),
        mkb('▶',()=>auView(auIds(inp.value))),mkb('clear',()=>{ inp.value=''; upd(); }));
      upd(); l.append(Object.assign(document.createElement('span'),{textContent:c}),inp,bar); ins[c]=inp; form.append(l); continue;
    } else if(low==='demod'){
      inp=document.createElement('select');
      for(const o of DEMOD_OPTS){ const op=document.createElement('option'); op.value=op.textContent=o; inp.append(op); }
      inp.value=DEMOD_OPTS.includes(rec[c]) ? rec[c] : DEMOD_OPTS[0];
      
    } else {
      inp=document.createElement('input'); inp.value=rec[c]??'';
      
      inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') save.click(); });
    }
    ins[c]=inp; l.append(Object.assign(document.createElement('span'),{textContent:c}),inp); form.append(l);
  }
  const save=document.createElement('button'); save.textContent='save'; save.className='tbl-btn pri';
  const cancel=document.createElement('button'); cancel.textContent='cancel'; cancel.className='tbl-btn';
  form.save=save; form.cancel=cancel;
  // поле под клавиатурой: после её появления прокрутить форму и страницу к полю
  form.addEventListener('focusin',e=>{
    const t=e.target; if(!t.matches?.('input,select')) return;
    const go=()=>t.scrollIntoView({block:'center',behavior:'smooth'});
    setTimeout(go,50);
    if(window.visualViewport) visualViewport.addEventListener('resize',go,{once:true});
  });
  save.addEventListener('click',async()=>{
    const o={};
    for(const c of cl){
      const v=ins[c].value, tv=tcValue(tblType(n,c),ins[c]);
      o[c]=tv!==undefined ? tv : TBL_HZ.test(c) && v.trim() && isFinite(parseHzCell(v)) ? parseHzCell(v) : hostlistCoerce(v);
    }
    try{ await onSave(o); }catch(e){ alert(e.message); }       // нарушено правило поля — форма остаётся открытой
  });
  cancel.addEventListener('click',onCancel);
  return form;
}
// правка — панелью снизу поверх списка: не прокручивается со строками, высота списка не меняется
function tblOpenEditor(n,title,form,rowEl){
  const ui=n.ui, ed=ui.edit;
  ed.innerHTML='';
  const h=document.createElement('div'); h.className='te-h';
  const t=document.createElement('span'); t.className='te-t'; t.textContent=title;
  h.append(...(form.lead ? [form.lead] : []),t,form.cancel,form.save);
  ed.append(h,form);
  ed.hidden=false;
  ui.list.style.paddingBottom=ed.offsetHeight+'px';           // последние строки не прячутся под панелью
  ui.list.querySelectorAll('.tbl-row.edit').forEach(r=>r.classList.remove('edit'));
  if(rowEl){ rowEl.classList.add('edit'); rowEl.scrollIntoView({block:'nearest'}); }
  // на сенсорных экранах без автофокуса: иначе клавиатура сразу закрывает поля
  if(!matchMedia('(pointer:coarse)').matches){
    const f=form.querySelector('input:not([type=hidden]):not([type=color]),select'); f?.focus({preventScroll:true});
  }
}
function tblCloseEditor(n){
  const ui=n.ui; if(!ui?.edit) return;
  ui.edit.hidden=true; ui.edit.innerHTML=''; ui.list.style.paddingBottom=''; n.curCard=null;
  ui.list.querySelectorAll('.tbl-row.edit').forEach(r=>r.classList.remove('edit'));
}
function tblEditForm(n,i,row){
  const close=()=>{ tblCloseEditor(n); };
  const form=tblForm(n,n.rows[i],async o=>{ await tblUpdate(n,i,o); close(); tblRenderList(n); },close);
  const nm=tcHasName(n) ? n.labelFn(n.rows[i]) : '';
  tblOpenEditor(n,'Edit row '+(i+1)+(nm ? ' · '+nm : ''),form,row);
}
// текущая позиция: GPS браузера, при отказе — последняя известная (My Position)
function tblPosition(){
  return new Promise(res=>{
    const last=()=>res(typeof GeoMe!=='undefined' && GeoMe.lat!=null ? {lat:GeoMe.lat,lon:GeoMe.lon} : null);
    if(!navigator.geolocation) return last();
    navigator.geolocation.getCurrentPosition(p=>res({lat:+p.coords.latitude.toFixed(6),lon:+p.coords.longitude.toFixed(6),
      alt:p.coords.altitude!=null ? Math.round(p.coords.altitude) : null}),last,{enableHighAccuracy:true,timeout:8000,maximumAge:5000});
  });
}
// «📍 here»: форма новой строки с позицией и временем; значок, фото и звук — в той же форме
async function tblHereForm(n){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  if(!tblCol(n.cl,['lat']) || !tblCol(n.cl,['lon'])){
    if(!confirm('This list has no lat / lon columns. Add the columns of «Map points» (name, lat, lon, alt, h, icon, color, note, photo, audio)?')) return;
    await tblColsEdit(n,tblTemplateCols(n.cl,TBL_TEMPLATES.find(t=>t.id==='points'))); tblRenderAll(n);
  }
  const pos=await tblPosition();
  if(!pos) alert('Position unknown (no GPS access): type lat / lon by hand, or take them from the photo');
  const set=(c,v)=>{ const k=tblCol(n.cl,c); if(k && v!=null) rec[k]=v; }, rec={};
  set(['lat'],pos?.lat); set(['lon'],pos?.lon); set(['alt','altitude'],pos?.alt); set(['t','time'],Date.now());
  const nm=tblCol(n.cl,TBL_LABEL); if(nm) rec[nm]='P'+(n.all.length+1);
  tblAddForm(n,rec);
}
function tblAddForm(n,init){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  const form=tblForm(n,init||{},async o=>{
    await tblAdd(n,[o],true); tblCloseEditor(n); tblRenderList(n);
  },()=>tblCloseEditor(n));
  tblOpenEditor(n,'New row',form,null);
}
defGroups('table',[
  {n:'Playback', p:'speed tscale loop interp initial reset unit', open:false},
  {n:'Rows', p:'order first last maxRows fmt', open:false},
  {n:'Log', p:'collect key textCsv log period names capture', open:false},
  {n:'Columns', p:'tcol dwellCol speedCol latCol lonCol textCol', open:false},
  {n:'Patch data', p:'data', open:false}]);
