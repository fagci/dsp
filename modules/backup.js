"use strict";
/* ============================ Резервная копия: экспорт и импорт всех данных ============================
   Один файл .dspbackup (JSON): настройки и патчи (localStorage), все базы IndexedDB приложения (списки Table, рельеф и кэши,
   образцы, трекер, архив спектров) и кэш тайлов карты. Импорт ничего не стирает: записи с теми же ключами заменяются,
   остальное остаётся; списки Table заменяются по имени списка. Ядро кодирования — backup-kernels.js. */

const BK_FORMAT='dsp-backup', BK_VER=1;
const bkReq=r=>new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
// открыть существующую базу; null — такой базы нет (пустую не создаём)
function bkOpenExisting(name){
  return new Promise(res=>{
    const rq=indexedDB.open(name);
    rq.onupgradeneeded=()=>rq.transaction.abort();
    rq.onsuccess=()=>res(rq.result); rq.onerror=()=>res(null); rq.onblocked=()=>res(null);
  });
}
const bkDone=tx=>new Promise((res,rej)=>{ tx.oncomplete=()=>res(); tx.onerror=tx.onabort=()=>rej(tx.error||new Error('transaction aborted')); });

// ---------- экспорт ----------
async function bkExport(sel,onMsg){
  const parts=[], w=s=>parts.push(s);
  w('{"format":"'+BK_FORMAT+'","v":'+BK_VER+',"t":'+JSON.stringify(new Date().toISOString())+',"groups":'+JSON.stringify(sel));
  if(sel.includes('settings')){
    const ls={}; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); ls[k]=localStorage.getItem(k); }
    w(',"ls":'+JSON.stringify(ls));
  }
  const dbs=BK_GROUPS.filter(g=>sel.includes(g.id)).flatMap(g=>g.db||[]);
  if(dbs.length){
    w(',"idb":{'); let firstDb=true;
    for(const name of dbs){
      const db=await bkOpenExisting(name); if(!db) continue;
      if(!firstDb) w(','); firstDb=false;
      w(JSON.stringify(name)+':{"version":'+db.version+',"stores":{'); let firstSt=true;
      for(const sn of db.objectStoreNames){
        onMsg('exporting '+name+' / '+sn+'…');
        const st=db.transaction(sn,'readonly').objectStore(sn);
        const keys=await bkReq(st.getAllKeys()), vals=await bkReq(st.getAll());
        const meta={keyPath:st.keyPath, autoIncrement:st.autoIncrement,
          indexes:[...st.indexNames].map(n=>{ const i=st.index(n); return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry}; })};
        w((firstSt?'':',')+JSON.stringify(sn)+':'+JSON.stringify(meta).slice(0,-1)+',"rows":['); firstSt=false;
        for(let i=0;i<keys.length;i++){
          w((i ? ',' : '')+JSON.stringify([await bkEnc(keys[i]),await bkEnc(vals[i])])); vals[i]=undefined;
          if(i%500===499) onMsg('exporting '+name+' / '+sn+' '+(i+1)+'/'+keys.length);
        }
        w(']}');
      }
      w('}}'); db.close();
    }
    w('}');
  }
  const cn=BK_GROUPS.filter(g=>sel.includes(g.id)).flatMap(g=>g.caches||[]);
  if(cn.length && 'caches' in window){
    w(',"caches":{'); let firstC=true;
    for(const name of cn){
      if(!(await caches.has(name))) continue;
      const c=await caches.open(name), reqs=await c.keys();
      if(!firstC) w(','); firstC=false;
      w(JSON.stringify(name)+':['); let n=0;
      for(const rq of reqs){
        const r=await c.match(rq); if(!r) continue;
        w((n?',':'')+JSON.stringify([rq.url,r.status,r.headers.get('content-type')||'',bkB64(new Uint8Array(await r.arrayBuffer()))]));
        if(++n%200===0) onMsg('exporting map tiles '+n+'/'+reqs.length);
      }
      w(']');
    }
    w('}');
  }
  w('}');
  return new Blob(parts,{type:'application/json'});
}

// ---------- импорт ----------
function bkCreateStores(db,stores){
  for(const sn in stores){
    const m=stores[sn], st=db.createObjectStore(sn,m.keyPath!==null && m.keyPath!==undefined ? {keyPath:m.keyPath,autoIncrement:m.autoIncrement} : {autoIncrement:m.autoIncrement});
    for(const ix of m.indexes||[]) st.createIndex(ix.name,ix.keyPath,{unique:ix.unique,multiEntry:ix.multiEntry});
  }
}
// база: есть — пишем в существующие хранилища (версию не трогаем: приложение открывает базы с фиксированной версией); нет — создаём как в файле
async function bkOpenForRestore(name,d){
  let db=await bkOpenExisting(name);
  if(db) return db;
  return new Promise((res,rej)=>{
    const rq=indexedDB.open(name,d.version||1);
    rq.onupgradeneeded=()=>bkCreateStores(rq.result,d.stores);
    rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error);
  });
}
async function bkRestoreDb(name,d,onMsg){
  const db=await bkOpenForRestore(name,d), skipped=[]; let rows=0;
  for(const sn in d.stores){
    const m=d.stores[sn];
    if(!db.objectStoreNames.contains(sn)){ skipped.push(sn); continue; }
    onMsg('importing '+name+' / '+sn+'…');
    const tx=db.transaction(sn,'readwrite'), st=tx.objectStore(sn), inline=st.keyPath!==null;
    if(name==='dsp-lists' && sn==='items'){               // списки Table: список из файла заменяет одноимённый, ключи записей новые
      const names=new Set(m.rows.map(r=>bkDec(r[1]).listName));
      const ix=st.index('listName');
      for(const ln of names){ const ks=await bkReq(ix.getAllKeys(ln)); for(const k of ks) st.delete(k); }
      for(const r of m.rows){ const it=bkDec(r[1]); delete it.id; st.add(it); rows++; }
    } else {
      for(const r of m.rows){ if(inline) st.put(bkDec(r[1])); else st.put(bkDec(r[1]),bkDec(r[0])); rows++; }
    }
    await bkDone(tx);
  }
  db.close();
  return {rows,skipped};
}
async function bkImport(text,sel,onMsg){
  const o=JSON.parse(text);
  if(o.format!==BK_FORMAT) throw new Error('not a DSP backup file');
  const res={ls:0,rows:0,tiles:0,skipped:[]}; let legacy=false;
  if(o.ls && sel.includes('settings')){ for(const k in o.ls){ localStorage.setItem(k,o.ls[k]); res.ls++; } }
  for(const name in (o.idb||{})){
    const g=BK_GROUPS.find(g=>g.db?.includes(name) || g.imp?.includes(name));
    if(g && !sel.includes(g.id)) continue;
    const r=await bkRestoreDb(name,o.idb[name],onMsg); res.rows+=r.rows; res.skipped.push(...r.skipped.map(s=>name+'/'+s));
    if(name==='dsp-samples' || name==='dsp-photos') legacy=true;       // старая копия: перенести в dsp-files
  }
  if(legacy && typeof FileStore!=='undefined') await FileStore.migrateLegacy();
  if(o.caches && sel.includes('tiles') && 'caches' in window){
    for(const name in o.caches){
      const c=await caches.open(name);
      for(const [url,status,type,b] of o.caches[name]){ await c.put(url,new Response(bkUnB64(b),{status,headers:type ? {'content-type':type} : {}})); res.tiles++; }
    }
  }
  return res;
}

// ---------- окно ----------
function bkDialog(title,groups,goLabel,go){
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:200;background:var(--scrim);display:flex;align-items:center;justify-content:center';
  const box=document.createElement('div');
  box.style.cssText='background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:14px;max-width:min(460px,92vw);font-size:12px;display:flex;flex-direction:column;gap:8px';
  box.innerHTML='<b style="font-size:13px">'+title+'</b>';
  const checks=groups.map(g=>{
    const l=document.createElement('label'); l.style.cssText='display:flex;gap:8px;align-items:flex-start;cursor:pointer';
    const c=document.createElement('input'); c.type='checkbox'; c.checked=true; c.style.marginTop='2px';
    const s=document.createElement('span'); s.textContent=g.label;
    l.append(c,s); box.append(l); return [g,c];
  });
  const msg=document.createElement('div'); msg.style.cssText='color:var(--dim);min-height:1.4em;white-space:pre-wrap';
  const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end';
  const bc=document.createElement('button'), bg=document.createElement('button');
  bc.textContent='Close'; bg.textContent=goLabel;
  for(const b of [bc,bg]) b.style.cssText='background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:6px 12px;font:inherit;cursor:pointer';
  bg.style.borderColor='var(--acc)';
  row.append(bc,bg); box.append(msg,row); ov.append(box); document.body.append(ov);
  let busy=false;
  bc.onclick=()=>{ if(!busy) ov.remove(); };
  bg.onclick=async()=>{
    if(busy) return; busy=true; bg.disabled=true;
    try{ await go(checks.filter(([,c])=>c.checked).map(([g])=>g.id),t=>{ msg.textContent=t; }); }
    catch(e){ msg.textContent='Failed: '+(e.message||e); msg.style.color='var(--err)'; }
    busy=false; bg.disabled=false;
  };
}
function bkExportUI(){
  bkDialog('Export all data',BK_GROUPS,'Export',async(sel,say)=>{
    if(!sel.length){ say('Nothing selected'); return; }
    const blob=await bkExport(sel,say);
    dl(blob,'dsp-backup-'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')+'.dspbackup');
    say('Saved: '+(blob.size/1048576).toFixed(1)+' MB');
  });
}
function bkImportUI(){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.dspbackup,.json,application/json'; inp.hidden=true;
  inp.onchange=async()=>{
    const f=inp.files[0]; inp.remove(); if(!f) return;
    let o; try{ o=JSON.parse(await f.text()); }catch(e){ alert('Could not read the file: '+e.message); return; }
    if(o.format!==BK_FORMAT){ alert('This is not a DSP backup file'); return; }
    const groups=BK_GROUPS.filter(g=>(g.ls && o.ls) || (g.db||[]).some(d=>o.idb?.[d]) || (g.caches||[]).some(c=>o.caches?.[c]));
    bkDialog('Import data from '+f.name+' ('+(o.t||'').slice(0,16).replace('T',' ')+')\nExisting records with the same key are replaced, the rest stays.',groups,'Import',async(sel,say)=>{
      if(!sel.length){ say('Nothing selected'); return; }
      wiping=true; clearTimeout(autosaveTimer);             // иначе выгрузка страницы перезапишет импортированный патч текущим графом
      try{
        const r=await bkImport(JSON.stringify(o),sel,say);
        say('Imported: '+r.rows+' records, '+r.ls+' settings, '+r.tiles+' tiles'+(r.skipped.length ? '\nSkipped (no such store in this version): '+r.skipped.join(', ') : '')+'\nReloading…');
        setTimeout(()=>location.reload(),900);
      }catch(e){ wiping=false; throw e; }
    });
  };
  document.body.append(inp); inp.click();
}
(()=>{
  const b1=document.getElementById('bkExport'), b2=document.getElementById('bkImport');
  if(b1) b1.onclick=bkExportUI;
  if(b2) b2.onclick=bkImportUI;
})();
