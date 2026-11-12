"use strict";
/* ============================ Пробник провода: ядро ============================
   Текст про значение на проводе, частота и «возраст» последнего блока. Без DOM — проверяется tools/test-wireprobe.mjs. */

const WP_NUMS=a=>{ let lo=Infinity, hi=-Infinity, s=0, n=0;
  for(let i=0;i<a.length;i++){ const x=+a[i]; if(x!==x || x===Infinity || x===-Infinity) continue; if(x<lo) lo=x; if(x>hi) hi=x; s+=x*x; n++; }
  return n ? {lo,hi,rms:Math.sqrt(s/n),n} : null; };
const wpNum=x=>!isFinite(x) ? String(x) : Math.abs(x)>=1e5 || (x!==0 && Math.abs(x)<1e-3) ? x.toExponential(2) : String(+x.toPrecision(5));

// значение провода → короткая строка
function wpFmt(v){
  if(v===null || v===undefined) return '—';
  if(typeof v==='number') return wpNum(v);
  if(typeof v==='boolean') return v ? 'true' : 'false';
  if(typeof v==='string') return JSON.stringify(v.length>48 ? v.slice(0,48)+'…' : v);
  if(typeof v==='bigint') return v+'n';
  if(ArrayBuffer.isView(v) && !(v instanceof DataView)){
    const s=WP_NUMS(v), t=v.constructor.name.replace('Array','')+'['+v.length+']';
    return s ? t+' '+wpNum(s.lo)+' … '+wpNum(s.hi)+' · rms '+wpNum(s.rms) : t;
  }
  if(Array.isArray(v)){
    if(!v.length) return 'list[0]';
    if(v.every(x=>typeof x==='number')){ const s=WP_NUMS(v); return 'list['+v.length+'] '+(s ? wpNum(s.lo)+' … '+wpNum(s.hi) : ''); }
    return 'list['+v.length+'] of '+(typeof v[0]==='object' ? 'records' : typeof v[0]);
  }
  if(typeof v==='object'){
    const ks=Object.keys(v), p=ks.slice(0,5).map(k=>{ const x=v[k];
      return k+(ArrayBuffer.isView(x) || Array.isArray(x) ? '['+x.length+']' : typeof x==='number' ? '='+wpNum(x) : typeof x==='string' ? '="'+(x.length>12 ? x.slice(0,12)+'…' : x)+'"' : ''); });
    return '{'+p.join(', ')+(ks.length>5 ? ', …+'+(ks.length-5) : '')+'}';
  }
  return typeof v;
}
// блоков в секунду по счётчику за окно (мс)
const wpRate=(count,ms)=>ms>0 ? count*1000/ms : 0;
function wpRateText(r){ return r>=100 ? Math.round(r)+'/s' : r>=1 ? r.toFixed(1)+'/s' : r>0 ? r.toFixed(2)+'/s' : '0/s'; }
// возраст последнего блока: «сейчас» при ходу, иначе мс/с; running=false — движок стоит
function wpAgeText(ageMs,running){
  if(!running) return 'stopped';
  if(ageMs<50) return 'now';
  return ageMs<1000 ? Math.round(ageMs)+' ms ago' : (ageMs/1000).toFixed(1)+' s ago';
}
