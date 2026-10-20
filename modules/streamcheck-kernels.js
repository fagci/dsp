"use strict";
/* ============================ Stream Check: разбор ответа и пул потоков ============================
   Без DOM и сети — проверяется tools/test-streamcheck.mjs. Плейлисты разбирает iptvParse (iptv-kernels.js). */

// ответ сервера → {ok, kind, why}; head — первые байты тела, ct — content-type, text — head как текст
function scClassify(status,ct,head){
  ct=String(ct||'').toLowerCase();
  if(status>=400) return {ok:false, kind:'', why:'HTTP '+status};
  if(!head || !head.length) return {ok:false, kind:'', why:'empty answer'};
  const txt=new TextDecoder().decode(head.subarray(0,Math.min(head.length,512))).replace(/^﻿/,'').trimStart();
  if(txt.startsWith('#EXTM3U') || txt.startsWith('#EXTINF') || /mpegurl/.test(ct)) return {ok:true, kind:'playlist', why:''};
  if(head[0]===0x47 && (head.length<189 || head[188]===0x47)) return {ok:true, kind:'TS', why:''};
  if(/text\/html|application\/json|text\/plain|xml/.test(ct) || /^<(!doctype|html)/i.test(txt)) return {ok:false, kind:'', why:'not a stream ('+(ct.split(';')[0]||'text')+')'};
  if(/^(video|audio)\//.test(ct) || /octet-stream|mpeg|ogg|aac/.test(ct)) return {ok:true, kind:ct.split(';')[0].split('/')[1]||'data', why:''};
  return {ok:false, kind:'', why:'unknown data'+(ct ? ' ('+ct.split(';')[0]+')' : '')};
}
// для HLS: адрес, который проверяем глубже (первый сегмент выбранного варианта); null — глубже нечего
function scDeepUrl(text,base){
  const pl=iptvParse(text,base);
  if(pl.kind==='master'){ const v=iptvPick(pl.items,'lowest'); return v ? {url:v.url, playlist:true} : null; }
  if(pl.kind==='media'){
    if(pl.fmp4) return {fail:'fMP4 / CMAF segments are not supported'};
    if(pl.encrypted) return {fail:'encrypted HLS is not supported'};
    const s=pl.segs[pl.segs.length-1]; return s ? {url:s.url, playlist:false} : {fail:'empty playlist'};
  }
  return null;
}
// пул: fn(item,i) для каждого элемента не более lim() одновременно; stop() — прекратить раздачу
function scPool(items,lim,fn,stop){
  return new Promise(res=>{
    let next=0, run=0, done=0;
    const pump=()=>{
      while(!stop() && run<Math.max(1,lim()) && next<items.length){
        const i=next++; run++;
        Promise.resolve().then(()=>fn(items[i],i)).catch(()=>{}).finally(()=>{ run--; done++; pump(); });
      }
      if(run===0 && (next>=items.length || stop())) res(done);
    };
    pump();
  });
}
