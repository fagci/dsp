"use strict";
/* ============================ IP Camera / Camera Archive: разбор адресов и выбор записей ============================
   Без DOM и сети — проверяется tools/test-camera.mjs. */

// http://user:pass@host/x → адрес без учётных данных + заголовок Basic (fetch не принимает адрес с паролем)
function camSplitAuth(raw){
  raw=String(raw||'').trim();
  const m=raw.match(/^(https?:\/\/)([^\/?#@]*)@(.*)$/i);
  if(!m) return {url:raw,auth:''};
  const cred=decodeURIComponent(m[2]);
  return {url:m[1]+m[3],auth:'Basic '+btoa(unescape(encodeURIComponent(cred)))};
}

// по адресу: mjpeg (поток), snapshot (одна картинка, опрос), hls (для IPTV), rtsp (в браузере нельзя), page, auto (решит ответ сервера)
function camKind(url){
  const u=String(url||'').trim();
  if(/^rtsp[s]?:|^rtmp:|^udp:|^rtp:/i.test(u)) return 'rtsp';
  if(!/^https?:\/\//i.test(u)) return '';
  const p=u.replace(/^https?:\/\/[^\/]*/i,'').toLowerCase();
  if(/\.m3u8?(\?|$)/.test(p)) return 'hls';
  if(/\.(jpe?g|png|webp|bmp|gif)(\?|$)/.test(p) || /snapshot|snap\.cgi|image\.cgi|jpgimage|shot\.jpg|capture/.test(p)) return 'snapshot';
  if(/mjpe?g|video\.cgi|videostream\.cgi|stream\.cgi|axis-cgi\/mjpg|\/stream(\?|$)|action=stream/.test(p)) return 'mjpeg';
  if(/\.(html?|php|aspx?)(\?|$)|\/$/.test(p) && !/\.cgi/.test(p)) return 'page';
  return 'auto';
}
// по ответу сервера: что на самом деле пришло
function camKindByType(ct){
  ct=String(ct||'').toLowerCase();
  if(/multipart\/x-mixed-replace/.test(ct)) return 'mjpeg';
  if(/^image\//.test(ct)) return 'snapshot';
  if(/mpegurl/.test(ct)) return 'hls';
  if(/text\/html/.test(ct)) return 'page';
  return '';
}

// камера из строк таблицы: номер (с 1), id / название / адрес; пустое — первая
function camPick(rows,v){
  const L=(rows||[]).filter(r=>r && r.url);
  if(!L.length) return null;
  if(v==null || v==='' || v===0) return L[0];
  if(typeof v==='number' || /^\d+$/.test(String(v).trim())){ const i=+v; return i>=1 && i<=L.length ? L[i-1] : null; }
  const s=String(v).trim().toLowerCase();
  return L.find(r=>String(r.id||'').toLowerCase()===s || String(r.name||r.label||'').toLowerCase()===s || r.url===v)
      || L.find(r=>String(r.name||r.label||'').toLowerCase().includes(s)) || null;
}

// Движение: средняя абсолютная разница двух серых превью (0…1). Превью — Uint8Array одной длины.
function camDiff(a,b){
  if(!a || !b || a.length!==b.length || !a.length) return 1;
  let s=0; for(let i=0;i<a.length;i++) s+=Math.abs(a[i]-b[i]);
  return s/a.length/255;
}
// ImageData-подобный {data,width,height} → серое превью w×h (выборка по сетке)
function camThumb(id,w=32,h=24){
  const out=new Uint8Array(w*h), W=id.width, H=id.height, d=id.data;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(Math.min(H-1,((y+.5)*H/h)|0)*W+Math.min(W-1,((x+.5)*W/w)|0))*4;
    out[y*w+x]=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8;
  }
  return out;
}

// запись пора сохранять? interval — секунды между кадрами, motion — порог движения (0 — выкл.): тогда кадр берётся при движении, но не чаще раза в секунду, и обязательно раз в interval
function camShouldSave(o){
  const dt=o.now-o.last;
  if(o.last==null || dt>=o.interval) return true;
  return o.motion>0 && dt>=1 && o.diff>=o.motion;
}

// имя файла по времени: 2026-10-20_19-44-12.jpg (местное время)
function camStamp(t){
  const d=new Date(t), z=(v,n=2)=>String(v).padStart(n,'0');
  return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+'_'+z(d.getHours())+'-'+z(d.getMinutes())+'-'+z(d.getSeconds());
}
// безопасное имя папки камеры
const camFolder=s=>String(s||'').replace(/[\/\\:*?"<>|]+/g,'_').trim().slice(0,60) || 'camera';

// какие записи убрать: старше days суток и сверх max штук (самые старые). frames — [{id,t}], любой порядок
function camPrune(frames,now,days,max){
  const sorted=[...frames].sort((a,b)=>a.t-b.t), del=[];
  const cut=days>0 ? now-days*864e5 : -Infinity;
  const keep=[];
  for(const f of sorted) (f.t<cut ? del : keep).push(f);
  if(max>0) while(keep.length>max) del.push(keep.shift());
  return del;
}
// ближайший к моменту t кадр (frames отсортирован по t) → индекс, -1 если пусто
function camNearest(frames,t){
  if(!frames.length) return -1;
  let lo=0, hi=frames.length-1;
  while(lo<hi){ const m=(lo+hi)>>1; if(frames[m].t<t) lo=m+1; else hi=m; }
  if(lo>0 && t-frames[lo-1].t<=frames[lo].t-t) lo--;
  return lo;
}
// плотность кадров по шкале времени: bins счётчиков между t0 и t1
function camDensity(frames,t0,t1,bins){
  const o=new Uint16Array(bins), span=Math.max(1,t1-t0);
  for(const f of frames){ const k=Math.min(bins-1,Math.max(0,((f.t-t0)/span*bins)|0)); if(o[k]<65535) o[k]++; }
  return o;
}
