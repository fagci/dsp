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
      if(res[k]!=='' && res[k]!=null){ row[k]=res[k]; hit=true; }
    }
    if(hit) dirty.push(i);
  });
  if(!dirty.length && !grown) return;
  for(const r of n.all) for(const c of n.cl) if(r[c]===undefined) r[c]='';
  if(tblKind(n.p.list)==='db'){
    try{
      for(const i of dirty){ const it=tblToItem(n.all[i],n.cl); await ListDB.update(n.ids[i],{name:it.name,fields:it.fields,value:it.fields.value??''}); }
      if(grown) await ListDB.setMeta(n.p.list,{cols:n.cl});
    }catch(e){ alert('storage: '+(e.message||e)); return; }
  } else await tblSave(n);
  if(grown) tblSetCols(n,n.cl.slice(),false);
  tblDerive(n);
  if(n.ui) tblRenderAll(n);
}
// запись для хранения: объекты и байты — в текст
const tblClean=r=>{ const o={}; for(const k in r){ const v=r[k]; o[k]=v==null ? '' : typeof v==='object' ? recFmt(v,true) : v; } return o; };

/* ---------- фильтр ---------- */
// слова через пробел, все должны совпасть: «20m» — с начала слова любого поля, «col:text» — в конкретном поле,
// «col>5M», «col<=100», «col=x» — сравнение (числа с k/M/G понимаются); «a|b» — любое из,
// НЕ: «-слово», «!слово», «not слово», «-col:x», «col!=x», «col!:x» — исключить,
// «col:» без значения — поле не пусто (to: — записи, где есть адресат)
function tblFilter(q){
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
const tblToItem=(r,cl)=>{ const f={}; for(const k of cl) if(k!=='name') f[k]=r[k]??''; return {name:String(r.name??''),fields:f}; };
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
  const keys=[]; let hasName=false;
  for(const it of items){
    if(it.name) hasName=true;
    for(const k in it.fields) if(k!=='name' && !keys.includes(k)) keys.push(k);
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
}
async function tblLoadRun(n){
  const list=n.p.list, kind=tblKind(list), tok=n.loadTok=(n.loadTok||0)+1;
  let cols=[], rows=[], ids=[];
  if(kind==='preset'){ const t=tblPresetRows(list.slice(TBL_PRE.length)); cols=t.cols; rows=t.rows; ids=rows.map((_,i)=>i); }
  else if(kind==='patch'){
    const text=String(n.p.data||'').trim();
    n.err='';
    if(text) try{ const t=tblFromTable(seqParse(text,'',true)); cols=t.cols; rows=t.rows; }catch(e){ n.err=e.message; }
    ids=rows.map((_,i)=>i);
  } else {
    let items=[], meta=null;
    try{ [items,meta]=await Promise.all([ListDB.list(list),ListDB.getMeta(list)]); }
    catch(e){ n.err='storage: '+(e.message||e); }
    if(tok!==n.loadTok) return;
    ({cols,rows}=tblDbRows(items,meta));
    ids=items.map(it=>it.id);
  }
  n.loaded=list; n.loadedData=kind==='patch' ? n.p.data : null;
  n.all=rows; n.ids=ids; n.cl=cols;
  // стартовая загрузка не трогает провода: их порты задаёт сохранённый p.cols; смена списка — пользователем
  if(n.wantCols){ n.wantCols=false; tblSetCols(n,cols,true); }
  else if(!n.p.cols.length && cols.length) tblSetCols(n,cols,false);
  tblDerive(n);
  seqReset(n);
  if(n.p.sel!=null){ const j=n.rowIds.indexOf(n.p.sel); if(j>=0){ n.pick=j; n.idx=j; n.cur={...n.rows[j]}; } }
  tblSyncExtra(n);
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
  n.initialized=false;
  rebuildNode(n);
  markTopoDirty();
}
function tblPorts(n){
  const used=new Set(TBL_FIXED);
  n.cols=(n.p.cols||[]).map(h=>{ let port=h; while(used.has(port)) port+='_'; used.add(port); return {h,port}; });
}
// фильтр, столбцы времени/координат, bands
function tblDerive(n){
  const f=tblFilter(n.p.filter);
  if(f){
    n.rows=[]; n.rowIds=[];
    n.all.forEach((r,i)=>{ if(f(r)){ n.rows.push(r); n.rowIds.push(n.ids[i]); } });
  } else { n.rows=n.all.slice(); n.rowIds=n.ids.slice(); }      // новая ссылка: потребители ключуют кэш по массиву, а n.all дописывается на месте
  n.headers=n.cl;
  n.nameCol=tblCol(n.cl,TBL_LABEL); n.colorCol=tblCol(n.cl,TBL_COLOR);
  tblPorts(n);
  n.timeCol=seqFind(n.cl,n.p.tcol,SEQ_TIME_COLS);
  n.latCol=seqFind(n.cl,n.p.latCol,SEQ_LAT_COLS);
  n.lonCol=seqFind(n.cl,n.p.lonCol,SEQ_LON_COLS);
  n.tt=null;
  if(n.timeCol){ let prev=0; n.tt=n.rows.map(r=>{ const v=seqTime(r[n.timeCol]); if(v!=null) prev=v; return prev; }); }
  n.geo=!!(n.latCol && n.lonCol);
  tblBands(n);
  n.uiDirty=true; n.uiFull=true;
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
  const f=tblFilter(n.p.filter);                        // тот же фильтр — и для остальных отмеченных списков
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
  if(tblKind(n.p.list)==='db') await ListDB.setMeta(n.p.list,{cols:n.cl});
  else await tblSave(n);
}
// upsert по ключевой колонке: повтор обновляет строку (непустые поля), count/first/last ведутся сами; → новые строки
const TBL_STAT=['count','first','last'];
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
      if(at.has(k)) dirty.add(at.get(k));
    } else {
      for(const c in r) if(!n.cl.includes(c)){ n.cl.push(c); grown=true; }
      fresh.set(k,{...r,count:1,first:t,last:t});
    }
  }
  if(kind==='db') for(const i of dirty){
    const it=tblToItem(n.all[i],n.cl);
    await ListDB.update(n.ids[i],{name:it.name,fields:it.fields,value:it.fields.value??''});
  }
  return {fresh:[...fresh.values()],grown};
}
// добавление записей; новые поля расширяют колонки (и порты — без потери проводов)
async function tblAdd(n,recs){
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
  const kind=tblKind(n.p.list);
  const rows=recs.map(r=>{ const o={}; for(const c of n.cl) o[c]=r[c]??''; return o; });
  let ids;
  if(kind==='db'){
    try{
      ids=await ListDB.addMany(n.p.list,rows.map(r=>tblToItem(r,n.cl)));
      if(grown) await ListDB.setMeta(n.p.list,{cols:n.cl});
    }catch(e){ alert('storage: '+(e.message||e)); return; }
  } else ids=rows.map((_,i)=>n.all.length+i);
  const wasFull=n.uiFull || !!(n.p.key && n.p.key.trim());     // upsert правит старые строки на месте
  n.all.push(...rows); n.ids.push(...ids);
  let dropped=false;
  // потолок: старые записи уходят (лог не растёт бесконечно)
  const cap=kind==='patch' ? Math.min(+n.p.maxRows||1000,1000) : +n.p.maxRows||0;
  if(cap>0 && n.all.length>cap){
    dropped=true;
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
  n.uiFull=!!(wasFull || dropped || grown);              // иначе список только дописан: DOM достраивается без перерисовки
}
async function tblUpdate(n,i,rec){
  if(tblRO(n)) return;
  const row=n.rows[i], k=n.all.indexOf(row), id=n.rowIds[i];
  const o={}; for(const c of n.cl) o[c]=rec[c]??'';
  n.all[k]=o;
  if(tblKind(n.p.list)==='db'){
    const it=tblToItem(o,n.cl);
    await ListDB.update(id,{name:it.name,fields:it.fields,value:it.fields.value??''});
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
async function tblClear(n){
  if(tblRO(n)) return;
  if(tblKind(n.p.list)==='db') await ListDB.removeMany(n.ids);
  n.all=[]; n.ids=[]; n.p.sel=null;
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
    if(ch) dirty.push(i);
  }
  const stale=[];
  if(!onlyNew) n.all.forEach((r,i)=>{ const k=r[key]; if(k!=='' && k!=null && !seen.has(String(k))) stale.push(i); });
  if(!dirty.length && !stale.length && !fresh.length && !grown) return;
  if(db){
    try{
      for(const i of dirty){ const it=tblToItem(n.all[i],n.cl); await ListDB.update(n.ids[i],{name:it.name,fields:it.fields,value:it.fields.value??''}); }
      if(stale.length) await ListDB.removeMany(stale.map(i=>n.ids[i]));
    }catch(e){ alert('storage: '+(e.message||e)); return; }
  }
  for(let j=stale.length-1;j>=0;j--){ const i=stale[j]; if(n.p.sel===n.ids[i]) n.p.sel=null; n.all.splice(i,1); n.ids.splice(i,1); }
  const rows=fresh.map(r=>{ const o={}; for(const c of n.cl) o[c]=r[c]??''; return o; });
  if(rows.length){
    let ids;
    if(db){
      try{ ids=await ListDB.addMany(n.p.list,rows.map(r=>tblToItem(r,n.cl))); }
      catch(e){ alert('storage: '+(e.message||e)); return; }
    }
    n.all.push(...rows); if(ids) n.ids.push(...ids);
  }
  if(db){ if(grown) await ListDB.setMeta(n.p.list,{cols:n.cl}); }
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
async function tblColsEdit(n,cl){                       // переименование/добавление/удаление колонок
  if(tblRO(n)) return;
  const old=n.cl;
  const rows=n.all.map(r=>{ const o={}; for(const c of cl) o[c]=r[c]??''; return o; });
  const gone=old.filter(c=>!cl.includes(c));
  n.cl=cl.slice(); n.all=rows;
  if(tblKind(n.p.list)==='db'){
    if(gone.length) for(let k=0;k<rows.length;k++){ const it=tblToItem(rows[k],n.cl); await ListDB.update(n.ids[k],{name:it.name,fields:it.fields}); }
    await ListDB.setMeta(n.p.list,{cols:n.cl});
  } else await tblSave(n);
  tblSetCols(n,n.cl.slice(),true);
  tblDerive(n);
}

// новый или существующий список: записи добавляются в конец
async function tblPut(listName,cols,rows){
  const meta=await ListDB.getMeta(listName), have=meta?.cols || [];
  const cl=have.slice(); for(const c of cols) if(!cl.includes(c)) cl.push(c);
  await ListDB.addMany(listName,rows.map(r=>tblToItem(r,cl)));
  await ListDB.setMeta(listName,{cols:cl});
}
async function tblUse(n,list){                          // переключить узел на список
  n.p.list=list; n.p.sel=null; n.wantCols=true;
  await tblLoad(n);
}

/* ---------- импорт / экспорт ---------- */
const tblBase=name=>name.replace(/\.[^.]+$/,'');
async function tblImport(n,files){
  const prefix=tblKind(n.p.list)==='db' ? tblDir(n.p.list) : '';
  let last=null;
  for(const f of files){
    try{
      const text=await f.text(), ext=f.name.toLowerCase().split('.').pop();
      let bundle=null;
      if(ext==='json') try{ const o=JSON.parse(text.replace(/^﻿/,'')); if(o && o['dsp-lists']) bundle=o; }catch(e){}
      if(bundle){
        for(const name in bundle.lists){ const t=bundle.lists[name]; await tblPut(name,t.cols,t.rows); last=name; }
        continue;
      }
      const t=tblFromTable(tblParse(text,ext));
      const name=prefix+tblBase(f.name);
      await tblPut(name,t.cols,t.rows); last=name;
    }catch(e){ alert('failed to read '+f.name+': '+e.message); }
  }
  if(last) await tblUse(n,last);
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
    await tblPut(to,cl,rows);
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
const tblIns=n=>[{n:'trig',t:'val'},{n:'row',t:'val'},{n:'t',t:'num'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'rows',t:'bands'},{n:'sigs',t:'bands'}]
  .concat(n.p.log ? ['a','b','c','d'].map(k=>({n:k,t:'num'})) : []);
const tblOuts=n=>{
  const o=[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'row',t:'num'},{n:'count',t:'num'},{n:'next',t:'num'},
    {n:'done',t:'num'},{n:'dist',t:'num'},{n:'bearing',t:'num'},{n:'progress',t:'num'},{n:'rows',t:'bands'}];
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
    {n:'key',t:'text',d:'',adv:true,label:'upsert key col',tip:'if set, a wired rec with the same value in this column updates its row instead of adding one; count / first / last columns are kept'},
    {n:'pfields',t:'text',d:'',adv:true,label:'packet fields → columns',tip:'extra columns from a wired rec: "col=src, src2". src is a path into the record (a.b.c) or a field of its hex parsed by hexSchema (HEX Structure: mtype_name, body.devaddr …); * — all parsed fields'},
    {n:'pfillBtn',t:'button',label:'Fill packet fields into existing rows',adv:true,fn:n=>tblBackfill(n)},
    {n:'textCsv',t:'check',d:false,label:'text wire: split into columns',adv:true},
    {n:'log',t:'check',d:false,label:'log inputs a–d',adv:true,fn:n=>{ tblRebuild(n,true); }},
    {n:'period',t:'range',min:.05,max:60,step:.05,d:1,label:'log period, s',adv:true},
    {n:'names',t:'text',d:'a,b,c,d',label:'log columns',adv:true},
    {n:'capture',t:'button',label:'Add row from a–d',adv:true,fn:n=>{ n.pend.push(tblLogRow(n,n.lastIn||{})); }},
    {n:'maxRows',t:'num',min:0,max:1e6,step:100,d:10000,label:'max rows (0=∞)',adv:true},
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
    if(n.p.sel===undefined) n.p.sel=null;
    n.all=[]; n.ids=[]; n.cl=[]; n.rows=[]; n.rowIds=[]; n.headers=[]; n.cols=[]; n.rowsOwn=[]; n.rowsOut=[];
    n.extra=new Map(); n.onCount=0;
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
    n.lastIn=I;
    // packet fields изменили — заполнить ими уже записанные строки, когда ввод затих
    if(p.pfields!==n._pfSeen){ n._pfSeen=p.pfields; n._pfAt=performance.now(); n._pfPend=true; }
    else if(n._pfPend && performance.now()-n._pfAt>1000 && !n.loading && n.loaded===p.list){ n._pfPend=false; tblBackfill(n); }
    if(p.collect && !tblRO(n)){
      if(I.rec && I.rec!==n.lastRec){ n.lastRec=I.rec; for(const r of Array.isArray(I.rec) ? I.rec : [I.rec]) if(r && typeof r==='object') n.pend.push(r); }
      if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; if(I.text) n.pend.push(...tblTextRows(n,I.text)); }
    }
    if(p.log){ n.logT+=dt; if(n.logT>=Math.max(.05,+p.period||1)){ n.logT=0; n.pend.push(tblLogRow(n,I)); } }
    if(Array.isArray(I.rows) && I.rows!==n.lastRowsIn){ n.lastRowsIn=I.rows; if(!tblRO(n)) tblFromRows(n,I.rows); }
    else if(n.rowsAgain && !n.rowsBusy && n.loaded===n.p.list && !tblRO(n)){ const a=n.rowsAgain; n.rowsAgain=null; tblFromRows(n,a); }
    if(n.pend.length>5000) n.pend.splice(0,n.pend.length-5000);
    if(n.pend.length && performance.now()-n.lastFlush>500) tblFlush(n);

    const o=seqProcess(n,I);
    const sigs=Array.isArray(I.sigs) && I.sigs.length ? I.sigs : null;
    if(n._mI!==n.rowsOut || n._mS!==sigs){ n._mI=n.rowsOut; n._mS=sigs; n._merged=sigs ? n.rowsOut.concat(sigs) : n.rowsOut; }
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
      const vk=[n.p.vcols,n.p.rules,n.p.tint,n.p.vmode,n.p.tz];
      if(!n._vk || vk.some((x,i)=>x!==n._vk[i])){ n._vk=vk; n.uiDirty=true; n.uiFull=true; if(n.ui.view && !n.ui.view.hidden) tblRenderView(n); }
      // полная перерисовка до 300 строк × колонок — реже на длинном списке
      if(n.uiDirty && performance.now()-(n.uiT||0)>400+2*Math.min(n.rows.length,TBL_ROWS)){ n.uiDirty=false; n.uiT=performance.now(); tblRenderList(n,true); }
      tblMark(n);
    }
  },
  dispose:n=>{ n.pend=[]; n.disposed=true; if(n.saveLate){ n.saveLate=false; tblSave(n); } }
});

/* ---------- интерфейс ---------- */
// значки карты (geoIcon): имя или любой короткий текст / эмодзи; в форме записи — выбор из списка
const TBL_ICONS=['dot','square','diamond','triangle','star','flag','cross','plus','antenna','tx','rx','me','plane','ship','sat','balloon','📍','🏠','🚩','⚠','📡','🔊','📷','⛰','🚗','🔋'];
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
      <input class="tbl-filter" placeholder="filter: 20m  demod:am  lo>7M  -fm  not proto:tcp" title="words match from the start of any field; col:text, col>5M, col<=100; NOT: -word, !word, not word, col!=x">
      <span class="tbl-count"></span>
    </div>
    <div class="tbl-cols" hidden></div>
    <div class="tbl-view" hidden></div>
    <div class="tbl-acts">
      <button class="tbl-btn pri tbl-add">+ row</button>
      <button class="tbl-btn tbl-viewb" title="columns, their format and row colour rules">▦ view</button>
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
    filter:q('.tbl-filter'), cols:q('.tbl-cols'), view:q('.tbl-view'), edit:q('.tbl-edit'), tail:false, marked:-1};
  n.ui.cols.hidden=!n.colsOpen;                           // пересборка узла (смена колонок) не должна прятать редактор
  n._open=new Set(Array.isArray(n.p.open) ? n.p.open : []);
  if(!Array.isArray(n.p.open)) for(const k of new Set([...tblShow(n),n.p.list])){            // раскрыть пути отмеченных
    const parts=k.split('/'); parts.pop();
    parts.reduce((a,x)=>{ const path=a ? a+'/'+x : x; n._open.add(path); return path; },'');
  }
  n.ui.list.addEventListener('keydown',e=>tblKey(n,e));
  // один набор обработчиков на список, а не по три на каждую строку
  n.ui.list.addEventListener('click',e=>{
    const row=e.target.closest('.tbl-row'); if(!row) return;
    const i=+row.dataset.i, b=e.target.closest('.tbl-ico[data-act]');
    if(b?.dataset.act==='edit'){ tblEditForm(n,i,row); return; }
    if(b?.dataset.act==='del'){
      const label=n.nameCol ? String(n.rows[i]?.[n.nameCol]??'') : '';
      if(!confirm('Delete row "'+(label||i+1)+'"?')) return;
      tblRemove(n,i).then(()=>tblRenderList(n));
      return;
    }
    if(b) return;                                         // фото / звук — свои обработчики
    tblSelect(n,i); n.ui.list.focus({preventScroll:true});
  });
  n.ui.list.addEventListener('dblclick',e=>{
    const row=e.target.closest('.tbl-row');
    if(row && !tblRO(n)) tblEditForm(n,+row.dataset.i,row);
  });
  n.ui.pick.addEventListener('change',()=>tblPick(n,n.ui.pick.value));
  n.ui.shown.addEventListener('click',()=>tblTreeToggle(n));
  n.ui.tree.addEventListener('click',e=>tblTreeClick(n,e));
  n.ui.filter.value=n.p.filter||'';
  n.ui.filter.addEventListener('keydown',e=>e.stopPropagation());
  n.ui.filter.addEventListener('input',()=>{
    n.p.filter=n.ui.filter.value;
    tblDerive(n); seqReset(n); n.initDone=true;           // новый набор — без повторной выдачи первой строки
    tblRenderList(n);
  });
  q('.tbl-new').addEventListener('click',()=>tblNewMenu(n));
  q('.tbl-menub').addEventListener('click',()=>tblMainMenu(n));
  q('.tbl-add').addEventListener('click',()=>tblAddForm(n));
  q('.tbl-here').addEventListener('click',()=>tblHereForm(n));
  q('.tbl-viewb').addEventListener('click',()=>tblViewToggle(n));
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
  await ListDB.renameList(n.p.list,full);
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
  await ListDB.renameList(n.p.list,full);
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
  it('Columns & colors…','which columns to show, their order and format; row colour rules',()=>tblViewToggle(n));
  it(n.ui.cols.hidden ? 'Edit data columns…' : 'Hide data columns','add and remove the columns of the list itself',()=>{ n.ui.cols.hidden=!n.ui.cols.hidden; n.colsOpen=!n.ui.cols.hidden; });
  it('Shown lists…','tick several lists to show them on the map and the bands output',()=>tblTreeToggle(n));
  it(n.ui.tail ? 'Show first rows' : 'Show last rows','',()=>{ n.ui.tail=!n.ui.tail; tblRenderList(n); });
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
  if(!have) await ListDB.setMeta(nm,{cols:t ? t.cols.slice() : []});
  await tblPick(n,nm);
  if(have && t) await tblApplyTemplate(n,t);                  // список уже есть — шаблон только дополняет колонки
}
async function tblApplyTemplate(n,t){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  await tblColsEdit(n,tblTemplateCols(n.cl,t)); tblRenderAll(n);
}
// шаблоны колонок для активного списка (mode 'apply')
function tblTplMenu(n){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  const m=tblMenuEl(n);
  for(const t of TBL_TEMPLATES) tblMenuItem(m,t.title,t.desc,()=>tblApplyTemplate(n,t),t.cols.join(', '));
}
async function tblRenderAll(n){
  if(!n.ui) return;
  const names=await tblNames(), ui=n.ui;
  if(!names.includes(n.p.list)) names.push(n.p.list);   // пустой, ещё не записанный
  n.treeNames=names;
  tblRenderTree(n);
  ui.filter.value=n.p.filter||'';
  tblRenderCols(n);
  tblRenderList(n);
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
function tblTreeToggle(n){ n.ui.tree.hidden=!n.ui.tree.hidden; n.ui.shown.classList.toggle('on',!n.ui.tree.hidden); }
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
  const sh=n.p.show;
  if(Array.isArray(sh) && (!sh.length || (sh.length===1 && tblCanon(sh[0])===n.p.list))) n.p.show=[list];
  await tblUse(n,list);
}
function tblRenderCols(n){
  const box=n.ui.cols, ro=tblRO(n);
  box.innerHTML='';
  for(const c of n.cl){
    const chip=document.createElement('span');
    chip.className='tbl-chip';
    chip.innerHTML=`<span>${escapeHtml(c)}</span>`+(ro ? '' : '<span class="x">×</span>');
    chip.querySelector('.x')?.addEventListener('click',async()=>{
      if(!confirm('Remove column "'+c+'" from all rows?')) return;
      await tblColsEdit(n,n.cl.filter(x=>x!==c)); tblRenderAll(n);
    });
    box.append(chip);
  }
  if(!ro){
    const add=document.createElement('span');
    add.textContent='+ col'; add.className='tbl-chip add';
    add.addEventListener('click',async()=>{
      const nm=(prompt('New column name:')||'').trim(); if(!nm || n.cl.includes(nm)) return;
      await tblColsEdit(n,n.cl.concat([nm])); tblRenderAll(n);
    });
    box.append(add);
  }
}
function tblRenderList(n,inc){
  const ui=n.ui, list=ui.list, N=n.rows.length, ro=tblRO(n), grid=n.p.vmode!=='compact';
  // перерисовка при новых записях не должна сбрасывать прокрутку: запоминаем позицию, у низа в режиме tail — остаёмся у низа
  const keep=list.scrollTop, atEnd=list.scrollTop+list.clientHeight>=list.scrollHeight-4;
  list.classList.toggle('grid',grid);
  ui.count.textContent=(n.p.filter ? N+'/' : '')+n.all.length+' rows';
  if(!N){
    const e=document.createElement('div');
    e.textContent=n.all.length ? 'nothing matches' : ro ? 'empty' : 'empty — add a row, import a file or wire rec / text';
    e.className='tbl-empty';
    list.replaceChildren(e); ui.marked=-1; ui.rend=null; return;
  }
  n.bgCtx=tblTintCtx(n);
  // только дописанные строки: достраиваем хвост, остальное не трогаем (без мигания и пересборки 300 строк)
  const rd=ui.rend, oe=rd ? rd.e : 0;
  if(inc && !n.uiFull && rd && rd.grid===grid && N>oe && (!ui.tail || N<=TBL_ROWS) && ui.tail===rd.tail
     && n.rows[0]===rd.first && n.rows[oe-1]===rd.last){
    const e=Math.min(N,TBL_ROWS);
    let vc=null, texts=null, fit=true;
    if(grid){
      vc=rd.vc; texts=[];
      for(let i=oe;i<e && fit;i++){
        const t=vc.map(x=>tblCell(x,n.rows[i][x.c],n.p.tz==='local'));
        t.forEach((v,k)=>{ if(v.length>rd.wid[k]) fit=false; });
        texts.push(t);
      }
    }
    if(fit){
      rd.foot?.remove();
      const frag=document.createDocumentFragment();
      for(let i=oe;i<e;i++) frag.append(tblRow(n,i,ro,grid ? {vc,t:texts[i-oe]} : null));
      rd.foot=null;
      if(N>TBL_ROWS){
        const m=document.createElement('div');
        m.textContent='… '+(N-e)+' more rows — narrow with the filter';
        m.className='tbl-empty sm';
        frag.append(m); rd.foot=m;
      }
      list.append(frag);
      rd.e=e; rd.last=n.rows[e-1];
      if(ui.tail && atEnd) list.scrollTop=list.scrollHeight;
      tblMark(n,true);
      return;
    }
  }
  const frag=document.createDocumentFragment();
  const s=ui.tail ? Math.max(0,N-TBL_ROWS) : 0, e=Math.min(N,s+TBL_ROWS);
  let vc=null, texts=null, wid=null, foot=null;
  if(grid){
    vc=tblViewCols(n).filter(x=>!x.hide);
    wid=vc.map(x=>Math.max(x.c.length,2));
    texts=[];
    for(let i=s;i<e;i++){
      const t=vc.map(x=>tblCell(x,n.rows[i][x.c],n.p.tz==='local'));
      t.forEach((v,k)=>{ if(v.length>wid[k]) wid[k]=v.length; });
      texts.push(t);
    }
    list.style.setProperty('--tc','5ch '+vc.map((x,k)=>x.w>0 ? x.w+'px' : Math.min(28,wid[k]+2)+'ch').join(' ')+' 56px');
    const hd=document.createElement('div'); hd.className='tbl-hd';
    hd.append(Object.assign(document.createElement('span'),{textContent:'#',className:'tbl-no'}));
    for(const x of vc) hd.append(Object.assign(document.createElement('span'),{textContent:x.c,title:x.c}));
    hd.append(document.createElement('span'));
    frag.append(hd);
  } else list.style.removeProperty('--tc');
  for(let i=s;i<e;i++) frag.append(tblRow(n,i,ro,grid ? {vc,t:texts[i-s]} : null));
  if(N>TBL_ROWS){
    const m=document.createElement('div');
    m.textContent=(ui.tail?'… '+s+' earlier rows hidden':'… '+(N-e)+' more rows')+' — narrow with the filter';
    m.className='tbl-empty sm';
    frag.append(m); foot=m;
  }
  ui.rend={grid,tail:ui.tail,e,first:n.rows[s],last:n.rows[e-1],vc,wid,foot};
  n.uiFull=false;
  list.replaceChildren(frag);                            // одна атомарная замена: прокрутка не сбрасывается
  list.scrollTop=ui.tail && atEnd ? list.scrollHeight : keep;
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
  for(const x of spec) if(x && n.cl.includes(x.c) && !seen.has(x.c)){ seen.add(x.c); out.push({fmt:'auto',w:0,...x}); }
  for(const c of n.cl) if(!seen.has(c)) out.push({c,fmt:'auto',w:0});
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
    if(TBL_PHOTO.test(low)){ const k=phIds(v).length; return k ? '📷'+k : ''; }
    if(TBL_AUDIO.test(low)){ const k=auIds(v).length; return k ? '🔊'+k : ''; }
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
  const ids=TBL_PHOTO.test(low) ? phIds(v) : TBL_AUDIO.test(low) ? auIds(v) : null;
  if(ids && x.fmt==='auto'){
    if(ids.length){
      el.textContent=text; el.classList.add('tbl-ico','warn');
      el.title=TBL_PHOTO.test(low) ? 'Show the photos' : 'Play the audio';
      el.dataset.act='media';
      el.addEventListener('click',e=>{ e.stopPropagation(); TBL_PHOTO.test(low) ? phView(ids) : auView(ids); });
    }
    return el;
  }
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
  for(const c of n.cl) if(!skip.has(c) && !TBL_PHOTO.test(c.toLowerCase()) && r[c]!=='' && r[c]!=null) parts.push(recFmt(r[c]));
  return parts.join(' / ');
}
function tblRow(n,i,ro,g){
  const r=n.rows[i];
  const row=document.createElement('div');
  row.dataset.i=i;
  row.className='tbl-row';
  const label=n.nameCol ? String(r[n.nameCol]??'') : '#'+(i+1);
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
    const pc=n.cl.find(c=>TBL_PHOTO.test(c.toLowerCase())), pids=pc ? phIds(r[pc]) : [];
    if(pids.length){
      const ph=document.createElement('span');
      ph.textContent='📷'+pids.length; ph.title='Show the photos'; ph.className='tbl-ico warn'; ph.dataset.act='media';
      ph.addEventListener('click',e=>{ e.stopPropagation(); phView(pids); });
      row.append(ph);
    }
    const ac=n.cl.find(c=>TBL_AUDIO.test(c.toLowerCase())), aids=ac ? auIds(r[ac]) : [];
    if(aids.length){
      const au=document.createElement('span');
      au.textContent='🔊'+aids.length; au.title='Play the audio'; au.className='tbl-ico warn'; au.dataset.act='media';
      au.addEventListener('click',e=>{ e.stopPropagation(); auView(aids); });
      row.append(au);
    }
  }
  row.title=n.cl.filter(c=>r[c]!=='' && r[c]!=null).map(c=>c+': '+(TBL_HZ.test(c)&&isFinite(tblHz(r[c])) ? fmtHz(tblHz(r[c]),4)+'Hz' : recFmt(r[c]))).join('\n');
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
  n.pick=i; n.idx=i; n.cur={...n.rows[i]}; n.p.sel=n.rowIds[i];
  tblMark(n);
}
// ↑ ↓ PgUp PgDn Home End по списку; без выбора ↓ берёт первую запись, ↑ — последнюю
function tblKey(n,e){
  const N=n.rows.length;
  if(!N || e.altKey || e.ctrlKey || e.metaKey) return;
  const s=n.ui.tail ? Math.max(0,N-TBL_ROWS) : 0, last=Math.min(N,s+TBL_ROWS)-1;
  const cur=n.ui.marked, page=Math.max(1,Math.floor(n.ui.list.clientHeight/24)-1);
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
// подсветка текущей записи (выбранной или выданной секвенсором)
function tblMark(n,still){
  const ui=n.ui, want=n.rows.length && (n.started || n.p.sel!=null) ? n.idx : -1;
  if(ui.marked===want) return;
  ui.marked=want;
  for(const el of ui.list.children){
    if(el.dataset.i===undefined) continue;
    const on=+el.dataset.i===want;
    el.classList.toggle('on',on);
    if(on && !still){ const t=el.offsetTop-ui.list.clientHeight/2; if(el.offsetTop<ui.list.scrollTop || el.offsetTop+el.offsetHeight>ui.list.scrollTop+ui.list.clientHeight) ui.list.scrollTop=Math.max(0,t); }
  }
}
// панель «▦ view»: колонки (показ, порядок, формат, ширина), раскладка и правила раскраски строк
function tblViewToggle(n){
  const v=n.ui.view; v.hidden=!v.hidden;
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
  const box=n.ui.view; box.innerHTML='';
  const mk=(tag,cls,txt,ev)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; if(ev) for(const k in ev) e.addEventListener(k,ev[k]); return e; };
  const sel=(opts,val,fn)=>{ const e=mk('select'); for(const o of opts){ const op=mk('option',null,Array.isArray(o) ? o[1] : o); op.value=Array.isArray(o) ? o[0] : o; e.append(op); } e.value=val; e.addEventListener('change',()=>fn(e.value)); return e; };
  const top=mk('div','tv-top');
  top.append(mk('span','tv-ttl','Columns & colors'),
    sel([['grid','grid (columns)'],['compact','compact (name · values)']],n.p.vmode==='compact' ? 'compact' : 'grid',x=>tblViewApply(n,'vmode',x,true)),
    sel([['utc','time: UTC'],['local','time: local']],n.p.tz==='local' ? 'local' : 'utc',x=>tblViewApply(n,'tz',x,true)),
    mk('span','tv-x','✕',{click:()=>tblViewToggle(n)}));
  box.append(top);
  const grid=n.p.vmode!=='compact';
  if(grid){
    box.append(mk('div','tv-sec','Columns'));
    const vc=tblViewCols(n);
    vc.forEach((x,i)=>{
      const row=mk('div','tv-col'+(x.hide?' off':''));
      const cb=mk('input'); cb.type='checkbox'; cb.checked=!x.hide;
      cb.addEventListener('change',()=>tblViewColEdit(n,v=>{ v[i].hide=!cb.checked; }));
      const w=mk('input','tv-w'); w.type='number'; w.min=0; w.step=10; w.value=x.w||''; w.placeholder='auto'; w.title='width, px (empty — by content)';
      w.addEventListener('keydown',e=>e.stopPropagation());
      w.addEventListener('change',()=>tblViewColEdit(n,v=>{ v[i].w=Math.max(0,+w.value||0); }));
      row.append(cb,mk('span','tv-name',x.c),sel(TBL_FMTS,x.fmt||'auto',f=>tblViewColEdit(n,v=>{ v[i].fmt=f; })),w,
        mk('span','tv-mv','▲',{click:()=>{ if(i) tblViewColEdit(n,v=>{ [v[i-1],v[i]]=[v[i],v[i-1]]; }); }}),
        mk('span','tv-mv','▼',{click:()=>{ if(i<vc.length-1) tblViewColEdit(n,v=>{ [v[i+1],v[i]]=[v[i],v[i+1]]; }); }}));
      box.append(row);
    });
    const ra=mk('div','tv-acts'); ra.append(mk('button','tbl-btn','Reset columns',{click:()=>tblViewApply(n,'vcols',null,true)})); box.append(ra);
  }
  box.append(mk('div','tv-sec','Row colors — the first matching rule wins'));
  const rules=Array.isArray(n.p.rules) ? n.p.rules : [];
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
function tblForm(n,rec,onSave,onCancel){
  const form=document.createElement('div');
  form.className='tbl-form';
  const ins={};
  const cl=n.cl.length ? n.cl : ['name'];
  for(const c of cl){
    const l=document.createElement('label');
    l.className=TBL_PHOTO.test(c.toLowerCase())||TBL_AUDIO.test(c.toLowerCase()) ? 'wide' : '';
    let inp;
    const low=c.toLowerCase();
    if(TBL_COLOR.includes(low)){
      inp=document.createElement('input'); inp.type='color'; inp.value=/^#[0-9a-f]{6}$/i.test(rec[c]) ? rec[c] : '#c9c9c9';
      inp.style.cssText='';
    } else if(TBL_PHOTO.test(low)){                     // фото: добавить с камеры / из галереи, посмотреть; координаты и время из EXIF — в пустые поля
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
    } else if(TBL_AUDIO.test(low)){                     // звук: записать, файл, клип из библиотеки; прослушать
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
      const v=ins[c].value;
      o[c]=TBL_HZ.test(c) && v.trim() && isFinite(parseHzCell(v)) ? parseHzCell(v) : hostlistCoerce(v);
    }
    await onSave(o);
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
  h.append(t,form.cancel,form.save);
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
  ui.edit.hidden=true; ui.edit.innerHTML=''; ui.list.style.paddingBottom='';
  ui.list.querySelectorAll('.tbl-row.edit').forEach(r=>r.classList.remove('edit'));
}
function tblEditForm(n,i,row){
  const close=()=>{ tblCloseEditor(n); };
  const form=tblForm(n,n.rows[i],async o=>{ await tblUpdate(n,i,o); close(); tblRenderList(n); },close);
  const nm=n.nameCol ? String(n.rows[i][n.nameCol]??'') : '';
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
    await tblAdd(n,[o]); tblCloseEditor(n); tblRenderList(n);
  },()=>tblCloseEditor(n));
  tblOpenEditor(n,'New row',form,null);
}
defGroups('table',[
  {n:'Playback', p:'speed tscale loop interp initial reset unit', open:false},
  {n:'Rows', p:'order first last maxRows fmt', open:false},
  {n:'Log', p:'collect key textCsv log period names capture', open:false},
  {n:'Columns', p:'tcol dwellCol speedCol latCol lonCol textCol', open:false},
  {n:'Patch data', p:'data', open:false}]);
