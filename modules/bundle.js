"use strict";
/* ============================ Пакет «граф + офлайн-данные»: окна ============================
   Settings → Patch bundle: Export… (граф + отмеченные файлы Offline data → один .dspbundle), Import… (то же, что Open file).
   Ядро: bundle-kernels.js, проверка: node tools/test-bundle.mjs. */
async function bundleExportUI(){
  let files=[]; try{ files=await OfflineData.list(); }catch(e){}
  const groups=files.map(f=>({id:f.name,label:f.name+' · '+bundleMB(f.size),off:f.size>8*1048576}));
  bkDialog('Export patch bundle\nThe graph is always included; tick the offline data to take with it (default: up to 8 MB). The file is about 1.4× the sum.',groups,'Export',async(sel,say)=>{
    const pick=files.filter(f=>sel.includes(f.name));
    say('Packing…');
    const blob=await bundlePack(serialize(),pick);
    dl(blob,'patch.dspbundle');
    say('Saved: '+bundleMB(blob.size)+' · '+pick.length+' offline file(s)');
  });
}
// объект пакета → граф; файлы ложатся в «Offline data» (одноимённые заменяются)
async function bundleRestore(o){
  const u=bundleUnpack(o);
  for(const f of u.files) await OfflineData.save(f.name,f.blob);
  return u.graph;
}
(()=>{
  const b=document.getElementById('bundleExport'), i=document.getElementById('bundleImport');
  if(b) b.onclick=bundleExportUI;
  if(i) i.onclick=()=>document.getElementById('fpick').click();
})();
