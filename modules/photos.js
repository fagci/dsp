"use strict";
/* ============================ Фото ============================
   Фото замеров хранятся в базе браузера (dsp-files, пространство images; см. filestore.js) (сжатый JPEG до 1600 px + место и время из EXIF), в ячейке таблицы лежат
   только идентификаторы «ph-…»: список остаётся лёгким, а фото входят в полную копию (Settings → All data).
   Читает Table (колонка photo / photos), пишут Table и Measure Point. Ядро — photo-kernels.js. */

// файл с камеры или из галереи → сжатый JPEG в базе; возвращает {id, exif, w, h}
async function phAdd(file){
  let exif=null;
  try{ exif=phExif(await file.slice(0,262144).arrayBuffer()); }catch(e){}        // EXIF — в первых 256 КБ; сжатие его сотрёт
  const bmp=await createImageBitmap(file);                                          // поворот по EXIF применяется сам
  const [w,h]=phFit(bmp.width,bmp.height), cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  cv.getContext('2d').drawImage(bmp,0,0,w,h); bmp.close?.();
  const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.82));
  const id=phNewId(), t=exif?.t ?? file.lastModified ?? Date.now();
  await FileStore.put({id,space:'images',folderId:0,name:file.name||id,mime:'image/jpeg',blob,meta:{w,h,t,exif}}); phUrls.delete(id);
  return {id,exif,w,h,t};
}
async function phGet(id){
  const r=await FileStore.get(id); if(!r || r.space!=='images') return undefined;
  return {id:r.id,blob:r.blob,name:r.name,added:r.created,w:r.meta?.w,h:r.meta?.h,t:r.meta?.t ?? r.created,exif:r.meta?.exif};
}
async function phRemove(id){ await FileStore.remove(id); phUrls.delete(id); }
const phUrls=new Map();
async function phUrl(id){
  if(phUrls.has(id)) return phUrls.get(id);
  const r=await phGet(id).catch(()=>null); if(!r) return null;
  const u=URL.createObjectURL(r.blob); phUrls.set(id,u); return u;
}
// выбор файлов: на телефоне открывает камеру / галерею
function phPick(multiple=true){
  return new Promise(res=>{
    const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.multiple=multiple; inp.hidden=true;
    inp.onchange=()=>{ const f=[...inp.files]; inp.remove(); res(f); };
    inp.oncancel=()=>{ inp.remove(); res([]); };
    document.body.append(inp); inp.click();
  });
}
// выбрать и добавить; onNew(info) — по каждому; возвращает массив info
async function phPickAdd(onNew){
  const out=[];
  for(const f of await phPick(true)){
    try{ const i=await phAdd(f); out.push(i); onNew?.(i); }catch(e){ alert('Could not add '+f.name+': '+e.message); }
  }
  return out;
}
// просмотр: стрелки, подпись с местом и временем, удаление из базы не делает (фото принадлежит записи)
async function phView(ids,start=0){
  ids=ids.filter(Boolean); if(!ids.length) return;
  let i=Math.max(0,Math.min(ids.length-1,start));
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#c8d2d6;font:12px ui-monospace,monospace';
  const img=document.createElement('img'); img.style.cssText='max-width:94vw;max-height:80vh;object-fit:contain;border:1px solid #2a3136';
  const cap=document.createElement('div'); cap.style.cssText='text-align:center;white-space:pre-wrap;max-width:90vw';
  const nav=document.createElement('div'); nav.style.cssText='display:flex;gap:10px';
  const mk=(t,f)=>{ const b=document.createElement('button'); b.textContent=t; b.style.cssText='background:#1d2226;color:#c8d2d6;border:1px solid #2a3136;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer'; b.onclick=e=>{ e.stopPropagation(); f(); }; return b; };
  const show=async()=>{
    const r=await phGet(ids[i]).catch(()=>null), u=await phUrl(ids[i]);
    img.src=u||''; const x=r?.exif;
    cap.textContent=(i+1)+' / '+ids.length+'  '+ids[i]+(r ? '\n'+new Date(r.t).toLocaleString()+(x?.lat!=null ? '  ·  '+x.lat.toFixed(5)+', '+x.lon.toFixed(5)+(x.alt!=null ? ', '+Math.round(x.alt)+' m' : '') : '')+(x?.model ? '  ·  '+x.model : '') : '\nnot found in this browser (import a backup with the photos)');
  };
  nav.append(mk('◀',()=>{ i=(i+ids.length-1)%ids.length; show(); }),mk('✕',()=>ov.remove()),mk('▶',()=>{ i=(i+1)%ids.length; show(); }));
  ov.append(img,cap,nav); ov.onclick=()=>ov.remove(); document.body.append(ov); show();
}
