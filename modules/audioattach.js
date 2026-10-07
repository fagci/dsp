"use strict";
/* ============================ Аудио к записи ============================
   Колонка audio в Table: запись с микрофона, файл или готовый клип из Sample Library; в ячейке — только id клипов.
   Звук лежит в dsp-samples. Ядро — audio-kernels.js. */

let auFolderP=null;
function auFolder(){
  return auFolderP || (auFolderP=(async()=>{
    const f=(await SampleDB.listFolders(null)).find(x=>x.name==='Attachments');
    return f ? f.id : SampleDB.addFolder('Attachments',null);
  })().catch(e=>{ auFolderP=null; throw e; }));
}
async function auSave(file,name){
  const {samples,sr}=await decodeAudioFile(file);
  return SampleDB.addClip({name:name||file.name||'audio '+new Date().toLocaleString(), folderId:await auFolder(), sr, samples,
    peaks:SampleDB.computePeaks(samples), duration:samples.length/sr});
}
// файлы с диска / телефона → id клипов
async function auPickAdd(){
  const files=await new Promise(res=>{
    const inp=document.createElement('input'); inp.type='file'; inp.accept='audio/*'; inp.multiple=true; inp.hidden=true;
    inp.onchange=()=>{ const f=[...inp.files]; inp.remove(); res(f); };
    inp.oncancel=()=>{ inp.remove(); res([]); };
    document.body.append(inp); inp.click();
  });
  const ids=[];
  for(const f of files){ try{ ids.push(await auSave(f)); }catch(e){ alert('Could not add '+f.name+': '+e.message); } }
  return ids;
}
// запись с микрофона: start() → stop() возвращает id клипа
async function auRecStart(){
  const stream=await navigator.mediaDevices.getUserMedia({audio:true}), mr=new MediaRecorder(stream), chunks=[];
  mr.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  mr.start();
  return ()=>new Promise((res,rej)=>{
    mr.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());
      try{ res(await auSave(new Blob(chunks,{type:mr.mimeType}),'recording '+new Date().toLocaleString())); }catch(e){ rej(e); }
    };
    mr.stop();
  });
}
// все клипы библиотеки: [{id, name: «папка/имя»}]
async function auList(){
  const out=[], walk=async(fid,path)=>{
    for(const c of await SampleDB.listClips(fid)) out.push({id:c.id,name:path+c.name,dur:c.duration});
    for(const f of await SampleDB.listFolders(fid)) await walk(f.id,path+f.name+'/');
  };
  await walk(null,''); return out;
}
let auCtx=null, auSrc=null;
function auStop(){ try{ auSrc?.stop(); }catch(e){} auSrc=null; }
async function auPlay(id){
  auStop();
  const c=await SampleDB.getClip(id).catch(()=>null);
  if(!c) return false;
  auCtx=auCtx||new (window.AudioContext||window.webkitAudioContext)();
  if(auCtx.state==='suspended') await auCtx.resume();
  const b=auCtx.createBuffer(1,c.samples.length,c.sr); b.copyToChannel(c.samples,0);
  const s=auCtx.createBufferSource(); s.buffer=b; s.connect(auCtx.destination); s.onended=()=>{ if(auSrc===s) auSrc=null; };
  s.start(); auSrc=s; return true;
}
// список клипов записи: имя, длительность, ▶ — «not found», если клип удалён из библиотеки
async function auView(ids){
  ids=ids.filter(Boolean); if(!ids.length) return;
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#c8d2d6;font:12px ui-monospace,monospace';
  const close=()=>{ auStop(); ov.remove(); };
  for(const id of ids){
    const c=await SampleDB.getClip(id).catch(()=>null), row=document.createElement('div');
    row.style.cssText='display:flex;gap:8px;align-items:center;min-width:240px;max-width:90vw';
    const b=document.createElement('button'); b.textContent='▶';
    b.style.cssText='background:#1d2226;color:#c8d2d6;border:1px solid #2a3136;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer';
    b.onclick=e=>{ e.stopPropagation(); auPlay(id); };
    const t=document.createElement('span'); t.textContent=c ? c.name+' · '+fmtDur(c.duration) : 'sm-'+id+' — not found in the library (import a backup with the samples)';
    if(!c) b.disabled=true;
    row.append(b,t); ov.append(row);
  }
  const x=document.createElement('button'); x.textContent='✕'; x.style.cssText='margin-top:6px;background:#1d2226;color:#c8d2d6;border:1px solid #2a3136;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer';
  x.onclick=e=>{ e.stopPropagation(); close(); };
  ov.append(x); ov.onclick=close; document.body.append(ov);
}
// выбор готового клипа из библиотеки → id или null
async function auChoose(){
  const list=await auList();
  if(!list.length){ alert('The Sample Library is empty'); return null; }
  return new Promise(res=>{
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#c8d2d6;font:12px ui-monospace,monospace';
    const sel=document.createElement('select'); sel.size=Math.min(12,list.length); sel.style.cssText='min-width:260px;max-width:90vw;background:#1d2226;color:#c8d2d6;border:1px solid #2a3136;font:inherit';
    for(const c of list){ const o=document.createElement('option'); o.value=c.id; o.textContent=c.name+' · '+fmtDur(c.dur); sel.append(o); }
    sel.selectedIndex=0;
    const bar=document.createElement('div'); bar.style.cssText='display:flex;gap:8px';
    const mk=(t,f)=>{ const b=document.createElement('button'); b.textContent=t; b.style.cssText='background:#1d2226;color:#c8d2d6;border:1px solid #2a3136;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer'; b.onclick=e=>{ e.stopPropagation(); f(); }; return b; };
    const done=v=>{ auStop(); ov.remove(); res(v); };
    bar.append(mk('▶',()=>auPlay(+sel.value)),mk('add',()=>done(+sel.value)),mk('cancel',()=>done(null)));
    ov.append(sel,bar); document.body.append(ov);
  });
}
