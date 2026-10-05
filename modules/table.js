"use strict";
/* ============================ TABLE ============================ */
// Единый узел-таблица вместо Data Sequencer, Band Plan, Bookmarks, List (CSV/DB) и CSV Log.
// Список = таблица записей. Хранится в одном из мест (параметр list):
//   имя        — локальная БД браузера (ListDB), "папка/имя" — папка; список переживает патч и перезагрузку;
//   @patch     — таблица в самом патче (параметр data): патч переносим вместе с данными;
//   presets/…  — встроенные band plan'ы, только чтение (копируются в свой список кнопкой copy).
// Вход: файл (CSV/TSV/TXT/JSON/KML/GPX/GeoJSON), провода rec и text, числовые входы a–d (лог).
// Выход: по одной записи (секвенсор из modules/sequencer.js), поля — отдельными проводами,
// весь список как bands (для 'sa'), выбранная запись — lo/mid/hi/span/step.

const TBL_PATCH='@patch', TBL_PRE='presets/', TBL_ROWS=300;
const TBL_FIXED=new Set([...SEQ_FIXED,'bands','mid','span']);
const TBL_LO=['lo','low','start','freq','frequency'], TBL_HI=['hi','high','end'],
  TBL_LABEL=['name','label','title'], TBL_COLOR=['color','colour'], TBL_STEP=['step'];
const TBL_HZ=/^(lo|hi|low|high|start|end|freq|frequency|step)$/i;
const tblCol=(cl,list)=>{ for(const k of list){ const h=cl.find(x=>x.toLowerCase()===k); if(h) return h; } return null; };
const tblKind=name=>name===TBL_PATCH ? 'patch' : name.startsWith(TBL_PRE) && BANDPLAN_PRESETS[name.slice(TBL_PRE.length)] ? 'preset' : 'db';
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
// запись для хранения: объекты и байты — в текст
const tblClean=r=>{ const o={}; for(const k in r){ const v=r[k]; o[k]=v==null ? '' : typeof v==='object' ? recFmt(v,true) : v; } return o; };

/* ---------- фильтр ---------- */
// слова через пробел, все должны совпасть: «20m» — с начала слова любого поля, «col:text» — в конкретном поле,
// «col>5M», «col<=100», «col=x» — сравнение (числа с k/M/G понимаются)
function tblFilter(q){
  q=String(q||'').trim().toLowerCase(); if(!q) return null;
  const terms=q.split(/\s+/).map(w=>{
    const m=w.match(/^([^:<>=]+)(:|>=|<=|>|<|=)(.*)$/);
    return m ? {col:m[1],op:m[2],val:m[3]} : {val:w};
  });
  const words=v=>String(v??'').toLowerCase().split(/[\s/()]+/);
  const startsWord=(v,s)=>{ const str=String(v??'').toLowerCase(); return str.startsWith(s) || words(v).some(w=>w.startsWith(s)); };
  const cmp=(v,op,s)=>{
    const a=tblHz(v), b=tblHz(s);
    if(isFinite(a) && isFinite(b)) return op==='>' ? a>b : op==='<' ? a<b : op==='>=' ? a>=b : op==='<=' ? a<=b : a===b;
    const x=String(v??'').toLowerCase(); return op==='=' || op===':' ? x===s : false;
  };
  return r=>terms.every(t=>{
    if(t.col===undefined) return Object.values(r).some(v=>startsWord(v,t.val));
    const k=Object.keys(r).find(c=>c.toLowerCase()===t.col);
    if(k===undefined) return false;
    return t.op===':' ? String(r[k]??'').toLowerCase().includes(t.val) : cmp(r[k],t.op,t.val);
  });
}

/* ---------- хранилище ---------- */
function tblSplit(name){ const i=name.indexOf('/'); return i<0 ? ['',name] : [name.slice(0,i),name.slice(i+1)]; }
// DB-запись ↔ строка таблицы: name — поле 'name', остальное — fields
const tblToItem=(r,cl)=>{ const f={}; for(const k of cl) if(k!=='name') f[k]=r[k]??''; return {name:String(r.name??''),fields:f}; };
function tblPresetRows(name){
  const rows=BANDPLAN_PRESETS[name].map(([lo,hi,label,step,color])=>({name:label,lo,hi,step:step||0,color:color||''}));
  return {cols:['name','lo','hi','step','color'],rows};
}

async function tblLoad(n){
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
    const keys=[]; let hasName=false;
    for(const it of items){
      if(it.name) hasName=true;
      for(const k in it.fields) if(k!=='name' && !keys.includes(k)) keys.push(k);
    }
    cols=meta?.cols ? meta.cols.slice() : (hasName ? ['name'] : []).concat(keys);
    if(hasName && !cols.includes('name')) cols.unshift('name');
    for(const k of keys) if(!cols.includes(k)) cols.push(k);
    rows=items.map(it=>{ const o={}; for(const c of cols) o[c]=hostlistCoerce(c==='name' ? it.name : it.fields[c] ?? ''); return o; });
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
  } else { n.rows=n.all; n.rowIds=n.ids; }
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
  n.uiDirty=true;
}
function tblBands(n){
  const cl=n.cl, lo=tblCol(cl,TBL_LO), hi=tblCol(cl,TBL_HI), lb=tblCol(cl,TBL_LABEL),
    co=tblCol(cl,TBL_COLOR), st=tblCol(cl,TBL_STEP), out=[];
  if(lo) for(const r of n.rows){
    const l=tblHz(r[lo]); if(!isFinite(l)) continue;
    let h=hi ? tblHz(r[hi]) : l; if(!isFinite(h)) h=l;
    const s=st ? tblHz(r[st]) : 0;
    out.push({lo:l, hi:Math.max(l,h), label:lb ? String(r[lb]??'') : fmtHz(l)+'Hz',
      color:co ? String(r[co]||'') : '', step:isFinite(s) ? s : 0});
  }
  n.bands=out; n.loCol=lo; n.hiCol=hi;
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
// добавление записей; новые поля расширяют колонки (и порты — без потери проводов)
async function tblAdd(n,recs){
  if(tblRO(n) || !recs.length) return;
  recs=recs.map(tblClean);
  let grown=false;
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
  n.all.push(...rows); n.ids.push(...ids);
  // потолок: старые записи уходят (лог не растёт бесконечно)
  const cap=kind==='patch' ? Math.min(+n.p.maxRows||1000,1000) : +n.p.maxRows||0;
  if(cap>0 && n.all.length>cap){
    const drop=n.ids.splice(0,n.all.length-cap); n.all.splice(0,drop.length);
    if(kind==='db') await ListDB.removeMany(drop).catch(()=>{});
    n.idx=Math.max(0,n.idx-drop.length);
  }
  if(kind==='patch') await tblSave(n);
  if(grown) tblSetCols(n,n.cl.slice(),false);
  tblDerive(n);
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
  const [folder]=tblSplit(n.p.list), prefix=folder && tblKind(n.p.list)==='db' ? folder+'/' : '';
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
function tblExport(n){
  const cl=n.cl, rows=n.all, fmt=n.p.fmt, base=(tblSplit(n.p.list)[1]||'table').replace(/[^\w.-]+/g,'_');
  if(fmt==='json') dl(new Blob([JSON.stringify(rows.map(r=>{ const o={}; for(const c of cl) o[c]=r[c]; return o; }),null,1)],{type:'application/json'}),base+'.json');
  else if(fmt==='tsv'){
    const cell=v=>String(v??'').replace(/[\t\r\n]+/g,' ');
    dl(new Blob(['﻿'+[cl,...rows.map(r=>cl.map(c=>r[c]))].map(r=>r.map(cell).join('\t')).join('\r\n')],{type:'text/tab-separated-values;charset=utf-8'}),base+'.tsv');
  } else dl(new Blob(['﻿'+[cl,...rows.map(r=>cl.map(c=>r[c]))].map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),base+'.csv');
}
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
    tblKind(n.p.list)==='preset' ? 'my '+tblSplit(n.p.list)[1] : n.p.list==='@patch' ? 'table' : n.p.list+' copy');
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
const tblIns=n=>[{n:'trig',t:'val'},{n:'row',t:'val'},{n:'t',t:'num'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'sigs',t:'bands'}]
  .concat(n.p.log ? ['a','b','c','d'].map(k=>({n:k,t:'num'})) : []);
const tblOuts=n=>{
  const o=[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'row',t:'num'},{n:'count',t:'num'},{n:'next',t:'num'},
    {n:'done',t:'num'},{n:'dist',t:'num'},{n:'bearing',t:'num'},{n:'progress',t:'num'},{n:'bands',t:'bands'}];
  if(tblCol(n.p.cols||[],TBL_LO)) o.push({n:'mid',t:'num'},{n:'span',t:'num'});
  return o.concat((n.cols||[]).map(c=>({n:c.port,t:'val'})));
};

def({ id:'table', title:'Table', cat:'Sources', kw:'list csv tsv json bookmarks band plan sequencer data log records rows folder import export',
  ins:tblIns, outs:tblOuts,
  readout:true, resize:true, w:340, h:330,
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
    n.p.list=n.p.list||'table';
    n.p.cols=Array.isArray(n.p.cols) ? n.p.cols : [];
    if(n.p.sel===undefined) n.p.sel=null;
    n.all=[]; n.ids=[]; n.cl=[]; n.rows=[]; n.rowIds=[]; n.headers=[]; n.cols=[]; n.bands=[];
    n.err=''; n.loaded=null; n.loadedData=null; n.pend=[]; n.lastFlush=0; n.flushing=false;
    n.lastRec=undefined; n.lastText=undefined; n.lastIn={}; n.logT=0; n.pick=null;
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
    n.lastIn=I;
    if(p.collect && !tblRO(n)){
      if(I.rec && I.rec!==n.lastRec){ n.lastRec=I.rec; for(const r of Array.isArray(I.rec) ? I.rec : [I.rec]) if(r && typeof r==='object') n.pend.push(r); }
      if(typeof I.text==='string' && I.text!==n.lastText){ n.lastText=I.text; if(I.text) n.pend.push(...tblTextRows(n,I.text)); }
    }
    if(p.log){ n.logT+=dt; if(n.logT>=Math.max(.05,+p.period||1)){ n.logT=0; n.pend.push(tblLogRow(n,I)); } }
    if(n.pend.length>5000) n.pend.splice(0,n.pend.length-5000);
    if(n.pend.length && performance.now()-n.lastFlush>500) tblFlush(n);

    const o=seqProcess(n,I);
    const sigs=Array.isArray(I.sigs) && I.sigs.length ? I.sigs : null;
    if(n._mI!==n.bands || n._mS!==sigs){ n._mI=n.bands; n._mS=sigs; n._merged=sigs ? n.bands.concat(sigs) : n.bands; }
    o.bands=n._merged;
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
      const t=warn ? '⚠ '+warn : (n.p.list)+' · '+(N ? 'row '+(n.idx+1)+'/'+N : 'empty')+' · '+n.p.advance+(n.done?' · done':'')+
        (n.pend.length ? ' · +'+n.pend.length : '');
      if(r.textContent!==t) r.textContent=t;
    }
    if(n.ui){
      if(n.uiDirty && performance.now()-(n.uiT||0)>400){ n.uiDirty=false; n.uiT=performance.now(); tblRenderList(n); }
      tblMark(n);
    }
  },
  dispose:n=>{ n.pend=[]; }
});

/* ---------- интерфейс ---------- */
const TBL_BTN='background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px;';
const TBL_IN='min-width:0;background:#1d2226;border:1px solid #2a3136;color:#c8d2d6;font-size:10px;padding:1px 3px;';
async function tblNames(){
  const db=await ListDB.listNames().catch(()=>[]);
  return [TBL_PATCH,...Object.keys(BANDPLAN_PRESETS).map(k=>TBL_PRE+k),...db.filter(x=>x!==TBL_PATCH && !x.startsWith(TBL_PRE))];
}
function tblInit(n){
  const mid=n.el.querySelector('.mid');
  if(!mid || mid.querySelector('.tbl-ui')) return;
  const root=document.createElement('div');
  root.className='tbl-ui';
  root.style.cssText='position:relative;display:flex;flex-direction:column;font-size:11px;'+
    'color:#c8d2d6;box-sizing:border-box;overflow:hidden;grid-column:1/-1;width:100%;min-width:0;gap:2px;';
  root.innerHTML=`
    <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
      <select class="tbl-folder" title="folder" style="${TBL_IN}flex:0 1 38%;"></select>
      <select class="tbl-select" title="list" style="${TBL_IN}flex:1;"></select>
      <span class="tbl-new" title="new list (folder/name)" style="cursor:pointer;color:#6c7a80;">＋</span>
      <span class="tbl-ren" title="rename / move list" style="cursor:pointer;color:#6c7a80;">✎</span>
      <span class="tbl-delL" title="delete list" style="cursor:pointer;color:#6c7a80;">🗑</span>
    </div>
    <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
      <input class="tbl-filter" placeholder="filter: 20m  demod:am  lo>7M" title="words match from the start of any field; col:text, col>5M, col<=100" style="${TBL_IN}flex:1;">
      <span class="tbl-tail" title="show the last rows" style="cursor:pointer;color:#6c7a80;font-size:10px;">tail</span>
      <span class="tbl-count" style="color:#6c7a80;font-size:10px;white-space:nowrap;"></span>
    </div>
    <div class="tbl-cols" style="display:flex;gap:3px;flex-wrap:wrap;flex-shrink:0;font-size:10px;"></div>
    <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
      <button class="tbl-add" style="${TBL_BTN}">+ row</button>
      <button class="tbl-import" style="${TBL_BTN}" title="CSV, TSV, TXT, JSON, KML, GPX, GeoJSON — each file becomes a list">import</button>
      <button class="tbl-export" style="${TBL_BTN}" title="export this list (format in advanced)">export</button>
      <button class="tbl-all" style="${TBL_BTN}" title="all lists in one JSON file (import brings them back)">export all</button>
      <button class="tbl-copy" style="${TBL_BTN}" title="copy to another list, the patch or the browser DB">copy</button>
      <button class="tbl-clear" style="${TBL_BTN}">clear</button>
      <input class="tbl-file" type="file" multiple accept=".csv,.tsv,.txt,.json,.jsonl,.kml,.gpx,.geojson,text/*" style="display:none;">
    </div>
    <div class="tbl-list" style="flex:1;overflow-y:auto;border:1px solid #1d2226;border-radius:3px;background:#0e1113;"></div>
  `;
  mid.append(root);
  syncCustomHeight(n,root,150);
  const q=s=>root.querySelector(s);
  n.ui={root, list:q('.tbl-list'), count:q('.tbl-count'), folder:q('.tbl-folder'), select:q('.tbl-select'),
    filter:q('.tbl-filter'), cols:q('.tbl-cols'), tail:false, marked:-1};
  n.ui.filter.value=n.p.filter||'';
  n.ui.filter.addEventListener('keydown',e=>e.stopPropagation());
  n.ui.filter.addEventListener('input',()=>{
    n.p.filter=n.ui.filter.value;
    tblDerive(n); seqReset(n); n.initDone=true;           // новый набор — без повторной выдачи первой строки
    tblRenderList(n);
  });
  q('.tbl-tail').addEventListener('click',e=>{ n.ui.tail=!n.ui.tail; e.target.style.color=n.ui.tail?'#4ec9b0':'#6c7a80'; tblRenderList(n); });
  n.ui.folder.addEventListener('change',async()=>{
    const f=n.ui.folder.value, names=(await tblNames()).filter(x=>tblSplit(x)[0]===f);
    const pick=names.find(x=>x!==TBL_PATCH) ?? names[0];
    if(pick) await tblUse(n,pick);
  });
  n.ui.select.addEventListener('change',()=>tblUse(n,n.ui.select.value));
  q('.tbl-new').addEventListener('click',async()=>{
    const f=tblSplit(n.p.list)[0], nm=prompt('New list name (folder/name):',f && tblKind(n.p.list)==='db' ? f+'/' : ''); if(!nm) return;
    if(nm===TBL_PATCH || nm.startsWith(TBL_PRE)){ alert('this name is reserved'); return; }
    await ListDB.setMeta(nm,{cols:[]});
    await tblUse(n,nm);
  });
  q('.tbl-ren').addEventListener('click',async()=>{
    if(tblKind(n.p.list)!=='db'){ alert('only lists in the browser DB can be renamed'); return; }
    const nm=prompt('List name (folder/name):',n.p.list); if(!nm || nm===n.p.list) return;
    if(nm===TBL_PATCH || nm.startsWith(TBL_PRE)){ alert('this name is reserved'); return; }
    await ListDB.renameList(n.p.list,nm);
    n.p.list=nm; n.loaded=nm; tblRenderAll(n);
  });
  q('.tbl-delL').addEventListener('click',async()=>{
    if(tblKind(n.p.list)!=='db'){ alert('only lists in the browser DB can be deleted'); return; }
    if(!confirm('Delete list "'+n.p.list+'" entirely?')) return;
    await ListDB.deleteList(n.p.list);
    await tblUse(n,'table');
  });
  q('.tbl-add').addEventListener('click',()=>tblAddForm(n));
  const file=q('.tbl-file');
  q('.tbl-import').addEventListener('click',()=>file.click());
  file.addEventListener('change',()=>{ const fs=[...file.files]; file.value=''; if(fs.length) tblImport(n,fs); });
  q('.tbl-export').addEventListener('click',()=>tblExport(n));
  q('.tbl-all').addEventListener('click',()=>tblExportAll());
  q('.tbl-copy').addEventListener('click',()=>tblCopy(n));
  q('.tbl-clear').addEventListener('click',async()=>{
    if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
    if(!n.all.length || !confirm('Delete all '+n.all.length+' rows of "'+n.p.list+'"?')) return;
    await tblClear(n); tblRenderAll(n);
  });
  tblRenderAll(n);
}
async function tblRenderAll(n){
  if(!n.ui) return;
  const names=await tblNames();
  if(!names.includes(n.p.list)) names.push(n.p.list);   // пустой, ещё не записанный
  const folders=[...new Set(names.map(x=>tblSplit(x)[0]))].sort((a,b)=>a===''?-1:b===''?1:a<b?-1:1);
  const [cf,cn]=tblSplit(n.p.list), ui=n.ui;
  ui.folder.innerHTML=folders.map(f=>`<option value="${escapeHtml(f)}"${f===cf?' selected':''}>${f===''?'(root)':escapeHtml(f)}</option>`).join('');
  ui.select.innerHTML=names.filter(x=>tblSplit(x)[0]===cf).map(x=>{
    const leaf=tblSplit(x)[1];
    return `<option value="${escapeHtml(x)}"${x===n.p.list?' selected':''}>${escapeHtml(leaf)}</option>`; }).join('');
  ui.filter.value=n.p.filter||'';
  tblRenderCols(n);
  tblRenderList(n);
}
function tblRenderCols(n){
  const box=n.ui.cols, ro=tblRO(n);
  box.innerHTML='';
  for(const c of n.cl){
    const chip=document.createElement('span');
    chip.style.cssText='background:#1d2226;border:1px solid #2a3136;border-radius:3px;padding:0 4px;display:flex;align-items:center;gap:3px;';
    chip.innerHTML=`<span>${escapeHtml(c)}</span>`+(ro ? '' : '<span class="x" style="cursor:pointer;color:#6c7a80;">×</span>');
    chip.querySelector('.x')?.addEventListener('click',async()=>{
      if(!confirm('Remove column "'+c+'" from all rows?')) return;
      await tblColsEdit(n,n.cl.filter(x=>x!==c)); tblRenderAll(n);
    });
    box.append(chip);
  }
  if(!ro){
    const add=document.createElement('span');
    add.textContent='+ col'; add.style.cssText='cursor:pointer;color:#4ec9b0;';
    add.addEventListener('click',async()=>{
      const nm=(prompt('New column name:')||'').trim(); if(!nm || n.cl.includes(nm)) return;
      await tblColsEdit(n,n.cl.concat([nm])); tblRenderAll(n);
    });
    box.append(add);
  }
}
function tblRenderList(n){
  const ui=n.ui, list=ui.list, N=n.rows.length, ro=tblRO(n);
  list.innerHTML='';
  ui.count.textContent=(n.p.filter ? N+'/' : '')+n.all.length+' rows';
  if(!N){
    const e=document.createElement('div');
    e.textContent=n.all.length ? 'nothing matches' : ro ? 'empty' : 'empty — add a row, import a file or wire rec / text';
    e.style.cssText='padding:12px;text-align:center;color:#2a3136;';
    list.append(e); ui.marked=-1; return;
  }
  const s=ui.tail ? Math.max(0,N-TBL_ROWS) : 0, e=Math.min(N,s+TBL_ROWS);
  for(let i=s;i<e;i++) list.append(tblRow(n,i,ro));
  if(N>TBL_ROWS){
    const m=document.createElement('div');
    m.textContent=(ui.tail?'… '+s+' earlier rows hidden':'… '+(N-e)+' more rows')+' — narrow with the filter';
    m.style.cssText='padding:4px;text-align:center;color:#6c7a80;font-size:10px;';
    list.append(m);
  }
  ui.marked=-1; tblMark(n);
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
  for(const c of n.cl) if(!skip.has(c) && r[c]!=='' && r[c]!=null) parts.push(recFmt(r[c]));
  return parts.join(' / ');
}
function tblRow(n,i,ro){
  const r=n.rows[i];
  const row=document.createElement('div');
  row.dataset.i=i;
  row.style.cssText='display:flex;align-items:center;gap:5px;padding:2px 6px;cursor:pointer;border-bottom:1px solid #121619;min-width:0;';
  if(n.colorCol){
    const sw=document.createElement('span');
    sw.style.cssText=`width:9px;height:9px;border-radius:2px;flex-shrink:0;background:${escapeHtml(String(r[n.colorCol]||'#c9c9c9'))};`;
    row.append(sw);
  }
  const name=document.createElement('span');
  name.textContent=n.nameCol ? String(r[n.nameCol]??'') : '#'+(i+1);
  name.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const val=document.createElement('span');
  val.textContent=tblSummary(n,r);
  val.style.cssText='color:#4ec9b0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%;';
  row.append(name,val);
  if(!ro){
    const ed=document.createElement('span');
    ed.textContent='✎'; ed.style.cssText='cursor:pointer;color:#6c7a80;';
    ed.addEventListener('click',e=>{ e.stopPropagation(); tblEditForm(n,i,row); });
    const del=document.createElement('span');
    del.textContent='🗑'; del.style.cssText='cursor:pointer;color:#6c7a80;';
    del.addEventListener('click',async e=>{
      e.stopPropagation();
      if(!confirm('Delete row "'+(name.textContent||i+1)+'"?')) return;
      await tblRemove(n,i); tblRenderList(n);
    });
    row.append(ed,del);
  }
  row.addEventListener('click',()=>{                    // выбор записи: уходит на выходы
    n.pick=i; n.idx=i; n.cur={...n.rows[i]}; n.p.sel=n.rowIds[i];
    tblMark(n);
  });
  return row;
}
// подсветка текущей записи (выбранной или выданной секвенсором)
function tblMark(n){
  const ui=n.ui, want=n.rows.length && (n.started || n.p.sel!=null) ? n.idx : -1;
  if(ui.marked===want) return;
  ui.marked=want;
  for(const el of ui.list.children){
    if(el.dataset.i===undefined) continue;
    const on=+el.dataset.i===want;
    el.style.background=on ? '#1f3a36' : '';
    if(on){ const t=el.offsetTop-ui.list.clientHeight/2; if(el.offsetTop<ui.list.scrollTop || el.offsetTop+el.offsetHeight>ui.list.scrollTop+ui.list.clientHeight) ui.list.scrollTop=Math.max(0,t); }
  }
}
function tblForm(n,rec,onSave,onCancel){
  const form=document.createElement('div');
  form.style.cssText='display:flex;flex-direction:column;gap:2px;padding:3px 6px;border-bottom:1px solid #121619;background:#161b1e;';
  const ins={};
  const cl=n.cl.length ? n.cl : ['name'];
  for(const c of cl){
    const l=document.createElement('label');
    l.style.cssText='display:flex;gap:4px;align-items:center;font-size:10px;color:#6c7a80;';
    let inp;
    const low=c.toLowerCase();
    if(TBL_COLOR.includes(low)){
      inp=document.createElement('input'); inp.type='color'; inp.value=/^#[0-9a-f]{6}$/i.test(rec[c]) ? rec[c] : '#c9c9c9';
      inp.style.cssText='flex:0 0 44px;height:16px;padding:0;background:none;border:1px solid #2a3136;';
    } else if(low==='demod'){
      inp=document.createElement('select');
      for(const o of DEMOD_OPTS){ const op=document.createElement('option'); op.value=op.textContent=o; inp.append(op); }
      inp.value=DEMOD_OPTS.includes(rec[c]) ? rec[c] : DEMOD_OPTS[0];
      inp.style.cssText=TBL_IN+'flex:1;';
    } else {
      inp=document.createElement('input'); inp.value=rec[c]??'';
      inp.style.cssText=TBL_IN+'flex:1;';
      inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') save.click(); });
    }
    ins[c]=inp; l.append(c,inp); form.append(l);
  }
  const btns=document.createElement('div'); btns.style.cssText='display:flex;gap:4px;justify-content:flex-end;margin-top:2px;';
  const save=document.createElement('button'); save.textContent='save';
  save.style.cssText=TBL_BTN+'border-color:#4ec9b0;color:#4ec9b0;';
  const cancel=document.createElement('button'); cancel.textContent='cancel'; cancel.style.cssText=TBL_BTN;
  btns.append(save,cancel); form.append(btns);
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
function tblEditForm(n,i,row){
  const form=tblForm(n,n.rows[i],async o=>{ await tblUpdate(n,i,o); tblRenderList(n); },()=>tblRenderList(n));
  row.replaceWith(form);
}
function tblAddForm(n){
  if(tblRO(n)){ alert('built-in list is read-only: copy it first'); return; }
  const ui=n.ui; ui.list.querySelector('.tbl-newrow')?.remove();
  const form=tblForm(n,{},async o=>{
    await tblAdd(n,[o]); tblRenderList(n);
  },()=>form.remove());
  form.classList.add('tbl-newrow');
  ui.list.prepend(form);
}
