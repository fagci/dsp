"use strict";
/* Ядро медиабиблиотеки: дерево категорий из записей FileStore и станций. Без DOM, тест: node tools/test-medialib.mjs
   Дорожка: {fs,name} (файл хранилища) или {url,name} (поток). Узел дерева: {id,label,tracks?,kids?}. */

const mlCmp=(a,b)=>String(a).localeCompare(String(b),undefined,{sensitivity:'base',numeric:true});
const mlArtist=r=>(r.meta&&r.meta.tag&&r.meta.tag.artist)||'';
const mlAlbum=r=>(r.meta&&r.meta.tag&&r.meta.tag.album)||'';
const mlTitle=r=>{
  const t=r.meta&&r.meta.tag;
  if(t&&t.title) return t.artist ? t.artist+' - '+t.title : t.title;
  return String(r.name||'').replace(/\.[A-Za-z0-9]{1,5}$/,'').replace(/_+/g,' ');
};
const mlTrack=r=>({fs:r.id,name:mlTitle(r)});

// записи: {id,name,created,meta:{tag}}; станции: строки с полем url (label / name)
function mlTree(recs,rows,recent){
  recent=recent||50;
  const sorted=recs.slice().sort((a,b)=>mlCmp(mlArtist(a),mlArtist(b))||mlCmp(mlAlbum(a),mlAlbum(b))||mlCmp(mlTitle(a),mlTitle(b)));
  const group=(key,empty)=>{
    const m=new Map();
    for(const r of sorted){ const k=key(r)||empty; if(!m.has(k)) m.set(k,[]); m.get(k).push(mlTrack(r)); }
    return [...m].sort((a,b)=>mlCmp(a[0],b[0])).map(([k,t])=>({id:'g:'+k,label:k,tracks:t}));
  };
  const newest=recs.slice().sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,recent);
  const st=[];
  for(const r of rows||[]) if(r && typeof r.url==='string' && r.url) st.push({url:r.url,name:String(r.label||r.name||r.url)});
  return [
    {id:'local',label:'Local files',kids:[
      {id:'music',label:'Music',tracks:sorted.map(mlTrack)},
      {id:'recent',label:'Recently added',tracks:newest.map(mlTrack)},
      {id:'artists',label:'Artists',kids:group(mlArtist,'Unknown artist')},
      {id:'albums',label:'Albums',kids:group(mlAlbum,'Unknown album')}]},
    {id:'net',label:'Network services',kids:[
      {id:'radio',label:'Internet Radio',tracks:st}]}];
}
function mlFind(tree,id){
  for(const n of tree){ if(n.id===id) return n; const k=n.kids&&mlFind(n.kids,id); if(k) return k; }
  return null;
}
// все дорожки узла: у ветки без своего списка — дорожки потомков
function mlCollect(n){
  if(!n) return [];
  if(n.tracks) return n.tracks;
  return (n.kids||[]).flatMap(mlCollect);
}
// плейлист из JSON (вход set): только корректные дорожки
function mlParse(s){
  let a=[]; try{ a=JSON.parse(s); }catch(e){}
  return Array.isArray(a) ? a.filter(x=>x&&(x.url||typeof x.fs==='number')).map(x=>x.url?{url:String(x.url),name:String(x.name||'')}:{fs:x.fs,name:String(x.name||'')}) : [];
}
