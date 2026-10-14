"use strict";
/* ============================ IPTV: разбор плейлистов ============================
   M3U со списком каналов, HLS master / media playlist. Без DOM и сети — проверяется tools/test-iptv.mjs. */

function iptvAbs(u,base){ try{ return new URL(u,base||undefined).href; }catch(e){ return u; } }
function iptvAttrs(s){
  const o={}; for(const m of s.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]*))/g)) o[m[1]]=m[2]!==undefined ? m[2] : m[3];
  return o;
}
// {kind:'channels'|'master'|'media'|'none', ...}
function iptvParse(text,base){
  const lines=String(text).replace(/^﻿/,'').split(/\r?\n/).map(s=>s.trim());
  if(!lines.some(l=>l.startsWith('#EXTM3U')) && !lines.some(l=>l.startsWith('#EXTINF'))) return {kind:'none'};
  const hls=lines.some(l=>/^#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF)/.test(l));
  if(!hls){
    const items=[]; let cur=null;
    for(const l of lines){
      if(l.startsWith('#EXTINF')){
        const i=l.indexOf(','), head=i<0 ? l : l.slice(0,i), a=iptvAttrs(head.replace(/^#EXTINF:\S*/,''));
        cur={name:(i<0 ? '' : l.slice(i+1)).trim()||a['tvg-name']||'', group:a['group-title']||'', logo:a['tvg-logo']||'', id:a['tvg-id']||''};
      }else if(l.startsWith('#EXTGRP:') && cur){ cur.group=cur.group||l.slice(8).trim(); }
      else if(l && !l.startsWith('#')){
        const it=cur||{name:'',group:'',logo:'',id:''}; it.url=iptvAbs(l,base); if(!it.name) it.name=it.url;
        items.push(it); cur=null;
      }
    }
    return {kind:'channels', items};
  }
  if(lines.some(l=>l.startsWith('#EXT-X-STREAM-INF'))){
    const items=[]; let a=null;
    for(const l of lines){
      if(l.startsWith('#EXT-X-STREAM-INF:')) a=iptvAttrs(l.slice(18));
      else if(a && l && !l.startsWith('#')){
        const m=/^(\d+)x(\d+)$/.exec(a.RESOLUTION||'');
        items.push({url:iptvAbs(l,base), bw:+a.BANDWIDTH||0, w:m?+m[1]:0, h:m?+m[2]:0, codecs:a.CODECS||''}); a=null;
      }
    }
    return {kind:'master', items};
  }
  let seq=0, target=6, end=false, map=false, enc=false, dur=0; const segs=[];
  for(const l of lines){
    if(l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq=+l.slice(22)||0;
    else if(l.startsWith('#EXT-X-TARGETDURATION:')) target=+l.slice(22)||6;
    else if(l.startsWith('#EXT-X-ENDLIST')) end=true;
    else if(l.startsWith('#EXT-X-MAP')) map=true;
    else if(l.startsWith('#EXT-X-KEY:')){ if((iptvAttrs(l.slice(11)).METHOD||'NONE')!=='NONE') enc=true; }
    else if(l.startsWith('#EXTINF:')) dur=parseFloat(l.slice(8))||0;
    else if(l && !l.startsWith('#')){ segs.push({seq:seq+segs.length, url:iptvAbs(l,base), dur}); dur=0; }
  }
  return {kind:'media', segs, target, end, fmp4:map, encrypted:enc};
}
// вариант мастер-плейлиста по правилу
function iptvPick(items,how){
  if(!items.length) return null;
  if(how==='first') return items[0];
  const s=items.slice().sort((a,b)=>a.bw-b.bw);
  return how==='lowest' ? s[0] : s[s.length-1];
}
// порядковые номера сегментов, которые ещё не скачаны; первый вход — у живого края (последние keep)
function iptvNew(segs,last,keep){
  if(!segs.length) return [];
  if(last==null) return segs.slice(Math.max(0,segs.length-keep));
  return segs.filter(s=>s.seq>last);
}
