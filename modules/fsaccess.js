/* File System Access: открыть файл прямо с диска, без копирования в Files (IndexedDB) и без квоты.
   Дескрипторы лежат в IndexedDB 'dsp-handles', поэтому файл можно открыть заново после перезапуска:
   браузер при этом просит разрешение, а запросить его можно только из жеста (клика) — отсюда два режима file().
   Без showOpenFilePicker (Firefox, Safari) FSA.supported=false, и вызывающий код остаётся на обычном <input type=file>. */
function makeFSA(o){
  const st=o.store, pick=o.picker;
  const FSA={
    supported:!!pick,
    // выбрать файл(ы) на диске → ключ; ключ кладём в параметр узла, дескрипторы — в хранилище
    async pick(opts){
      if(!pick) throw new Error('your browser cannot open files in place');
      let hs;
      try{ hs=await pick({multiple:!!(opts&&opts.multiple), excludeAcceptAllOption:false, ...(opts&&opts.types?{types:opts.types}:{})}); }
      catch(e){ if(e&&e.name==='AbortError') return null; throw e; }
      if(!hs||!hs.length) return null;
      const key='h'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
      await st.put(key,hs);
      return {key, names:hs.map(h=>h.name)};
    },
    // File[] по ключу. prompt=false (автозагрузка при старте) — не просим, а возвращаем {need:true}, если разрешения нет;
    // prompt=true — только из клика: просит разрешение у пользователя
    async files(key, prompt){
      const hs=await st.get(key);
      if(!hs) return {gone:true};
      for(const h of hs){
        let p=h.queryPermission ? await h.queryPermission({mode:'read'}) : 'granted';
        if(p!=='granted' && prompt && h.requestPermission) p=await h.requestPermission({mode:'read'});
        if(p!=='granted') return {need:true, names:hs.map(x=>x.name)};
      }
      try{ return {files:await Promise.all(hs.map(h=>h.getFile()))}; }
      catch(e){ return {gone:true, error:e&&e.message||String(e)}; }       // файл перенесён или удалён
    },
    forget:key=>st.del(key),
  };
  return FSA;
}
// хранилище на IndexedDB; ошибки хранилища (приватный режим) не роняют вызывающего — ключ просто не находится
function fsaIdbStore(){
  const open=()=>new Promise((ok,fail)=>{
    const rq=indexedDB.open('dsp-handles',1);
    rq.onupgradeneeded=()=>rq.result.createObjectStore('h');
    rq.onsuccess=()=>ok(rq.result); rq.onerror=()=>fail(rq.error);
  });
  const tx=(mode,fn)=>open().then(db=>new Promise((ok,fail)=>{
    const t=db.transaction('h',mode), r=fn(t.objectStore('h'));
    t.oncomplete=()=>{ db.close(); ok(r&&r.result); }; t.onerror=t.onabort=()=>{ db.close(); fail(t.error); };
  }));
  return {
    get:k=>tx('readonly',s=>s.get(k)).catch(()=>undefined),
    put:(k,v)=>tx('readwrite',s=>s.put(v,k)),
    del:k=>tx('readwrite',s=>s.delete(k)).catch(()=>{}),
  };
}
const FSA=typeof window!=='undefined' ? makeFSA({store:fsaIdbStore(), picker:window.showOpenFilePicker&&window.showOpenFilePicker.bind(window)}) : null;
if(typeof window!=='undefined') window.FSA=FSA;
