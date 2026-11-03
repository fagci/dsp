"use strict";
/* ============================ Measure Entry: ядро ============================
   Ввод типовых замеров для Site Plan: тип замера + имена точек + значение (число или выражение, как на калькуляторе) → строка «A-B 12.4».
   Чистая логика без DOM: node tools/test-measureentry.mjs */

// тип → {ключ в строке, нужные точки, подпись}
const ME_KINDS={
  'side (tape along the ground)':{k:'d',pts:2},
  'horizontal distance (level, plumb)':{k:'h',pts:2},
  'height difference (B above A)':{k:'dz',pts:2},
  'compass bearing A→B':{k:'az',pts:2},
  'angle at B (A-B-C)':{k:'ang',pts:3},
  'clinometer: angle up, horizontal distance, eye':{k:'tilt',pts:2},
  'height of point A':{k:'z',pts:1}
};
// выражение как на калькуляторе: + − × ÷ ^ ( ), sqrt, hypot(a;b), sin cos tan atan (в градусах), pi; запятая — десятичная; аргументы функций — через «;»
function meEval(src){
  const s=String(src??'').trim().replace(/(\d),(\d)/g,'$1.$2').replace(/[×·]/g,'*').replace(/[÷:]/g,'/').replace(/−/g,'-').replace(/(?<!\d)\s+|\s+(?!\d)/g,'');      // пробелы вокруг знаков не мешают, «2 3» — не 23
  if(!s) return NaN;
  let i=0; const fail=()=>{ throw new Error('bad expression'); };
  const peek=()=>s[i];
  function num(){ const m=/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i)); if(!m) fail(); i+=m[0].length; return +m[0]; }
  function args(){ const a=[]; if(peek()!=='(') fail(); i++; if(peek()===')'){ i++; return a; } for(;;){ a.push(add()); if(peek()===';'){ i++; continue; } if(peek()===')'){ i++; return a; } fail(); } }
  function atom(){
    const c=peek();
    if(c==='('){ i++; const v=add(); if(peek()!==')') fail(); i++; return v; }
    if(c==='-'){ i++; return -pow(); }
    if(c==='+'){ i++; return pow(); }
    if(/[a-z]/i.test(c)){
      const m=/^[a-z]+/i.exec(s.slice(i))[0].toLowerCase(); i+=m.length; const D=Math.PI/180;
      if(m==='pi') return Math.PI;
      const a=args(); const F={sqrt:x=>Math.sqrt(x),sin:x=>Math.sin(x*D),cos:x=>Math.cos(x*D),tan:x=>Math.tan(x*D),atan:x=>Math.atan(x)/D,abs:Math.abs,hypot:(x,y)=>Math.hypot(x,y)}[m];
      if(!F || a.length<1 || (m==='hypot' && a.length!==2) || (m!=='hypot' && a.length!==1)) fail(); return F(...a);
    }
    return num();
  }
  function pow(){ const b=atom(); if(peek()==='^'){ i++; return Math.pow(b,pow()); } return b; }
  function mul(){ let v=pow(); for(;;){ if(peek()==='*'){ i++; v*=pow(); } else if(peek()==='/'){ i++; v/=pow(); } else return v; } }
  function add(){ let v=mul(); for(;;){ if(peek()==='+'){ i++; v+=mul(); } else if(peek()==='-'){ i++; v-=mul(); } else return v; } }
  try{ const v=add(); if(i!==s.length) return NaN; return isFinite(v) ? v : NaN; }catch(e){ return NaN; }
}
// следующее имя точки: A→B … Z→A1, A1→B1 …; «house»→«house2»
function meNext(name){
  const m=/^([A-Z])(\d*)$/.exec(String(name||'').trim());
  if(m) return m[1]==='Z' ? 'A'+((+m[2]||0)+1) : String.fromCharCode(m[1].charCodeAt(0)+1)+m[2];
  const t=/^(.*?)(\d+)$/.exec(String(name||'').trim()); if(t) return t[1]+(+t[2]+1);
  return (String(name||'P').trim()||'P')+'2';
}
const meName=s=>String(s??'').trim().replace(/[\s-]+/g,'_');
// строка замера; o: {a,b,c,value,sigma,hd,eye}; '' — не хватает данных
function meLine(kindName,o){
  const K=ME_KINDS[kindName]; if(!K) return '';
  const a=meName(o.a), b=meName(o.b), c=meName(o.c), v=+o.value, f=x=>String(+(+x).toFixed(4)), sg=o.sigma>0 ? ' ± '+f(o.sigma) : '';
  if(!isFinite(v)) return '';
  switch(K.k){
    case 'd': return a&&b&&a!==b ? a+'-'+b+' '+f(v)+sg : '';
    case 'h': return a&&b&&a!==b ? a+'-'+b+' h '+f(v)+sg : '';
    case 'dz': return a&&b&&a!==b ? a+'-'+b+' dz '+f(v)+sg : '';
    case 'az': return a&&b&&a!==b ? a+'-'+b+' az '+f(v)+sg : '';
    case 'ang': return a&&b&&c ? a+'-'+b+'-'+c+' '+f(v)+sg : '';
    case 'tilt': return a&&b&&a!==b&&o.hd>0 ? a+'-'+b+' tilt '+f(v)+' '+f(o.hd)+(o.eye>0 ? ' eye '+f(o.eye) : '')+sg : '';
    case 'z': return a ? a+' z '+f(v)+sg : '';
  }
  return '';
}
// контур по цепочке «A-B 5», «B-C 7»…: имена в порядке прохода
function meChainPoly(log){
  const names=[]; for(const l of String(log||'').split('\n')){ const m=/^\s*([^\s-]+)-([^\s-]+)\s+[-+]?[\d.]/.exec(l.replace(/#.*/,'')); if(!m) continue; if(!names.length) names.push(m[1]); if(!names.includes(m[2])) names.push(m[2]); }
  return names.length>=3 ? 'poly '+names.join(' ') : '';
}
