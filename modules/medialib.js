"use strict";
/* ============================ MEDIA LIBRARY ============================
   Дерево медиабиблиотеки (как слева в Winamp): Local files → Music / Recently added / Artists / Albums и Network services →
   Internet Radio (станции с провода rows). Файлы — папка Music пространства files (FileStore), теги ID3 берутся из записей.
   Клик по категории кладёт её дорожки на выход list (JSON) — провод в set плейлиста заменяет его список; двойной клик
   ещё и даёт импульс play (в req плейлиста). Ядро: modules/medialib-kernels.js. */

async function mlScan(){
  const all=await FileStore.allFolders('files'), root=all.find(f=>f.name==='Music' && (f.parentId==null || f.parentId===FS_ROOT));
  if(!root) return [];
  const ids=[root.id], q=[root.id];
  while(q.length){ const p=q.pop(); for(const f of all) if(f.parentId===p){ ids.push(f.id); q.push(f.id); } }
  const out=[];
  for(const id of ids) for(const r of await FileStore.list('files',id)) if(waIsAudio(r)) out.push({id:r.id,name:r.name,created:r.created,meta:r.meta});
  return out;
}
function mlRefresh(n){
  if(n.scan) return;
  n.scan=true;
  mlScan().then(r=>{ n.recs=r; n.tree=null; n.dirty=true; },()=>{}).finally(()=>{ n.scan=false; });
}
function mlOpen(n){ try{ return new Set(JSON.parse(n.p.open||'[]')); }catch(e){ return new Set(); } }

function mlMount(n){
  const root=waEl('div','ml'); root.tabIndex=0;
  const tree=waEl('div','ml-tree'); root.append(tree);
  root.addEventListener('pointerdown',e=>e.stopPropagation());
  root.addEventListener('wheel',e=>e.stopPropagation());
  root.addEventListener('keydown',e=>e.stopPropagation());
  const pick=(id,play)=>{
    const node=mlFind(n.tree||[],id); if(!node) return;
    n.p.sel=id; n.outList=JSON.stringify(mlCollect(node)); n.playV=play?1:0; n.dirty=true; };
  tree.addEventListener('click',e=>{
    const row=e.target.closest('.ml-row'); if(!row) return;
    const id=row.dataset.id;
    if(e.target.closest('.tg')){
      const s=mlOpen(n); s.has(id)?s.delete(id):s.add(id); n.p.open=JSON.stringify([...s]); n.dirty=true; return; }
    pick(id,false); });
  tree.addEventListener('dblclick',e=>{
    const row=e.target.closest('.ml-row'); if(row && !e.target.closest('.tg')) pick(row.dataset.id,true); });
  n.mid.append(root);
  n.off=FileStore.onChange(sp=>{ if(!sp || sp==='files') mlRefresh(n); });
  mlRefresh(n);
  n.ui={root,tree,key:''};
}
function mlRender(n){
  if(!n.tree) n.tree=mlTree(n.recs||[],n.rowsIn);
  const open=mlOpen(n), sel=n.p.sel;
  const key=sel+'|'+[...open].join()+'|'+JSON.stringify(n.tree,(k,v)=>k==='tracks'?v.length:v);
  if(key===n.ui.key) return;
  n.ui.key=key; n.dirty=false;
  const keep=n.ui.tree.scrollTop; n.ui.tree.textContent='';
  const walk=(a,d)=>{
    for(const x of a){
      const row=waEl('div','ml-row'+(x.id===sel?' sel':'')); row.dataset.id=x.id; row.style.paddingLeft=(6+d*14)+'px';
      const tg=waEl('span','tg',x.kids ? (open.has(x.id)?'▼':'▶') : '');
      const cnt=x.tracks ? x.tracks.length : 0;
      row.append(tg,waEl('span','t',x.label)); if(x.tracks) row.append(waEl('span','c',String(cnt)));
      n.ui.tree.append(row);
      if(x.kids && open.has(x.id)) walk(x.kids,d+1); } };
  walk(n.tree,0);
  n.ui.tree.scrollTop=keep;
}

def({ id:'medialib', title:'Media Library', cat:'Music', resize:true, w:260, h:300, readout:false,
  kw:'media library winamp music files tree artists albums recently added internet radio stations playlist',
  ins:[{n:'rows',t:'bands'}],
  outs:[{n:'list',t:'txt'},{n:'play',t:'num'},{n:'count',t:'num'}],
  params:[{n:'sel',t:'text',d:'',hidden:true},{n:'open',t:'text',d:'["local","net"]',hidden:true}],
  init:n=>{ n.recs=[]; n.tree=null; n.rowsIn=null; n.rowsKey=''; n.outList=''; n.playV=0; n.dirty=true; n.ui=null; n.scan=false; n.off=null; },
  dispose:n=>{ if(n.off) n.off(); },
  process(n,I){
    if(Array.isArray(I.rows)){
      const k=I.rows.length+'|'+(I.rows[0]&&I.rows[0].url||'')+'|'+(I.rows[I.rows.length-1]&&I.rows[I.rows.length-1].url||'');
      if(k!==n.rowsKey){ n.rowsKey=k; n.rowsIn=I.rows; n.tree=null; n.dirty=true; } }
    const p=n.playV; n.playV=0;
    return {list:n.outList, play:p, count:n.outList ? mlParse(n.outList).length : 0}; },
  draw(n){
    if(!n.ui || !n.ui.root.isConnected) mlMount(n);
    mlRender(n); }
});
