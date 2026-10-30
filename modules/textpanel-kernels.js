"use strict";
/* ============================ Text Panel: язык строк, цвета по условию, графики ============================
   Чистая логика без DOM (проверка: node tools/test-textpanel.mjs); условия считает свой разбор выражений tpExpr.
   Строка панели:   [# | ## | -#] текст со {значениями} [красным]… | правила
     {a}  {a:0.0}  {a:+0.0}  {a:%}  {a:si}  {a:hms}  {a:bytes}  {a:hex}  {a:onoff}  {s1}  {now:HH:mm:ss}  — значения с пинов a…h, s1…s4
     [red]текст[/]   [red if a>100]текст[/]   [#ff8800 if a>1 && b<2]…[/]   **жирный**   — цвет участка, в том числе по условию
     … | red if a>100; amber if a>60; green     — правила цвета для всей строки: первое выполнившееся, последнее без «if» — запасное
   Особые строки:   @bar a 0..100 подпись | правила     — полоса;   @graph a,b 60 0..100 | red, cyan   — график за 60 с (диапазон auto — по данным);
                    @sep — черта;   пустая строка — отступ;   // — комментарий. */

const TP_COL={red:'#ff5a4a',amber:'#ffb23a',orange:'#ff8a3a',yellow:'#ffe14a',green:'#4fe08a',lime:'#b6f04a',cyan:'#4fd8e8',blue:'#5aa0ff',
  violet:'#b08aff',pink:'#ff7ab8',white:'#f2f2f2',gray:'#8c949c',dim:'#8c949c'};
const TP_SERIES=['#4fd8e8','#ffb23a','#4fe08a','#ff7ab8','#b08aff','#ff5a4a'];
function tpColor(s){ s=String(s==null ? '' : s).trim().toLowerCase(); return TP_COL[s] || (/^#[0-9a-f]{3,8}$/.test(s) ? s : null); }

// выражение условия: числа с дробной частью, строки "…", pins, + - * / %, сравнения, && || !, скобки; нет данных → NaN (сравнения ложны)
function tpExpr(src){
  const T=String(src).match(/\d+\.?\d*|\.\d+|"[^"]*"|'[^']*'|[A-Za-z_]\w*|&&|\|\||==|!=|<=|>=|[-+*\/%<>!()]/g)||[];
  let i=0;
  const num=v=>typeof v==='number' ? v : v===undefined ? NaN : v;
  const prim=()=>{
    const t=T[i++];
    if(t===undefined) throw new Error('expression ended early');
    if(t==='('){ const v=or(); if(T[i++]!==')') throw new Error('missing )'); return v; }
    if(/^[\d.]/.test(t)){ const v=Number(t); return ()=>v; }
    if(t[0]==='"' || t[0]==="'"){ const v=t.slice(1,-1); return ()=>v; }
    if(/^[A-Za-z_]/.test(t)) return g=>num(g(t));
    throw new Error('unexpected '+t);
  };
  const un=()=>{ const t=T[i]; if(t==='-'||t==='!'){ i++; const a=un(); return t==='-' ? g=>-a(g) : g=>{ const v=a(g); return typeof v==='number' && isNaN(v) ? NaN : v ? 0 : 1; }; } return prim(); };
  const lvl=(ops,next)=>()=>{ let a=next(); while(ops.includes(T[i])){ const o=T[i++], x=a, y=next(); a=g=>BIN[o](x(g),y(g)); } return a; };
  const BIN={'*':(a,b)=>a*b,'/':(a,b)=>a/b,'%':(a,b)=>a%b,'+':(a,b)=>a+b,'-':(a,b)=>a-b,'<':(a,b)=>a<b?1:0,'<=':(a,b)=>a<=b?1:0,'>':(a,b)=>a>b?1:0,'>=':(a,b)=>a>=b?1:0,
    '==':(a,b)=>a===b?1:0,'!=':(a,b)=>a!==b?1:0,'&&':(a,b)=>a&&b?1:0,'||':(a,b)=>a||b?1:0};
  const mul=lvl(['*','/','%'],un), add=lvl(['+','-'],mul), cmp=lvl(['<','<=','>','>='],add), eq=lvl(['==','!='],cmp), and=lvl(['&&'],eq), or=lvl(['||'],and);
  const f=or();
  if(i<T.length) throw new Error('extra '+T[i]);
  return f;
}
function tpCond(src){                                   // «a>100 && b<2» → функция(get) → bool; пустое — всегда истина; ошибка в записи — всегда ложь
  src=String(src||'').trim(); if(!src) return ()=>true;
  let f; try{ f=tpExpr(src); }catch(e){ return ()=>false; }
  return get=>{ try{ const v=f(get); return !!v && !(typeof v==='number' && isNaN(v)); }catch(e){ return false; } };
}
function tpRules(s){                                    // «red if a>100; amber if a>60; green» → [{color, test}]
  const o=[];
  for(const part of String(s||'').split(';')){
    const m=/^\s*(#[0-9a-f]{3,8}|[a-z]+)(?:\s+if\s+(.+))?\s*$/i.exec(part);
    if(m && tpColor(m[1])) o.push({color:tpColor(m[1]),test:tpCond(m[2])});
  }
  return o;
}
const tpPick=(rules,get)=>{ for(const r of rules) if(r.test(get)) return r.color; return null; };

// ---- форматы значений ----
function tpSi(v){ const a=Math.abs(v); const u=[['G',1e9],['M',1e6],['k',1e3]]; for(const [s,k] of u) if(a>=k) return +(v/k).toPrecision(3)+s; return String(+v.toPrecision(3)); }
function tpNow(fmt,d){
  const p=(x,n)=>String(x).padStart(n||2,'0');
  return (fmt||'HH:mm:ss').replace(/YYYY|MM|DD|HH|mm|ss/g,t=>({YYYY:d.getFullYear(),MM:p(d.getMonth()+1),DD:p(d.getDate()),HH:p(d.getHours()),mm:p(d.getMinutes()),ss:p(d.getSeconds())}[t]));
}
function tpFormat(v,fmt){
  fmt=String(fmt==null ? '' : fmt).trim();
  if(v===undefined || v===null || v==='') return '—';
  if(typeof v==='string') return fmt==='upper' ? v.toUpperCase() : fmt==='lower' ? v.toLowerCase() : v;
  if(!isFinite(v)) return '—';
  let m;
  if(!fmt) return String(+v.toPrecision(5));
  if((m=/^(0{2,})$/.exec(fmt))) return String(Math.round(v)).padStart(m[1].length,'0');
  if((m=/^([+]?)0(?:\.(0+))?$/.exec(fmt))){ const s=Math.abs(v).toFixed(m[2] ? m[2].length : 0); return (v<0 && +s!==0 ? '-' : m[1] ? '+' : '')+s; }
  if((m=/^%(\d)?$/.exec(fmt))) return (v*100).toFixed(m[1] ? +m[1] : 0)+'%';
  switch(fmt){
    case 'si': return tpSi(v);
    case 'hms': { const t=Math.max(0,Math.round(v)), h=Math.floor(t/3600), mi=Math.floor(t%3600/60), s=t%60; return (h ? h+':'+String(mi).padStart(2,'0') : String(mi))+':'+String(s).padStart(2,'0'); }
    case 'hex': return '0x'+Math.round(v).toString(16).toUpperCase();
    case 'bin': return '0b'+Math.round(v).toString(2);
    case 'onoff': return v>.5 ? 'ON' : 'OFF';
    case 'yesno': return v>.5 ? 'yes' : 'no';
    case 'bytes': { const u=['B','KB','MB','GB','TB']; let x=Math.abs(v), i=0; while(x>=1024 && i<4){ x/=1024; i++; } return (v<0 ? '-' : '')+(i ? x.toFixed(x<10 ? 2 : 1) : String(Math.round(x)))+' '+u[i]; }
  }
  return String(+v.toPrecision(5));
}

// ---- разбор ----
const TP_TOK=/\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}|\[(#[0-9a-fA-F]{3,8}|[A-Za-z]+)(?:\s+if\s+([^\]]*))?\]|\[\/\]|\*\*/g;
function tpText(s){                                      // текст строки → токены: lit / val / open / close / bold
  const out=[]; let last=0, m; TP_TOK.lastIndex=0;
  while((m=TP_TOK.exec(s))){
    const tag=m[0];
    if(m[1]!==undefined){ if(m.index>last) out.push({t:'lit',s:s.slice(last,m.index)}); out.push({t:'val',name:m[1],fmt:m[2]}); }
    else if(tag==='[/]'){ if(m.index>last) out.push({t:'lit',s:s.slice(last,m.index)}); out.push({t:'close'}); }
    else if(tag==='**'){ if(m.index>last) out.push({t:'lit',s:s.slice(last,m.index)}); out.push({t:'bold'}); }
    else if(m[3]!==undefined && tpColor(m[3])){ if(m.index>last) out.push({t:'lit',s:s.slice(last,m.index)}); out.push({t:'open',color:tpColor(m[3]),test:tpCond(m[4])}); }
    else continue;                                       // [ok] и подобное — обычный текст
    last=m.index+tag.length;
  }
  if(last<s.length) out.push({t:'lit',s:s.slice(last)});
  return out;
}
function tpRange(s){ const m=/^(-?[\d.]+)\.\.(-?[\d.]+)$/.exec(s||''); return m ? [+m[1],+m[2]] : null; }
function tpParse(src){
  const out=[];
  for(const raw of String(src||'').split('\n')){
    const t=raw.trim();
    if(!t){ out.push({k:'space'}); continue; }
    if(t.startsWith('//')) continue;
    if(t==='@sep'){ out.push({k:'sep'}); continue; }
    if(t.startsWith('@graph')){                          // @graph a,b 60 0..100 | red, cyan — после « | » цвета рядов
      const q=t.split(' | '), m=/^@graph\s+(\S+)\s*(\d+)?\s*(\S+)?$/.exec(q[0].trim());
      if(m){ const cols=(q[1]||'').split(',').map(tpColor).filter(Boolean);
        out.push({k:'graph',pins:m[1].split(',').filter(Boolean),sec:+m[2]||60,range:m[3] && m[3]!=='auto' ? tpRange(m[3]) : null,colors:cols.length ? cols : TP_SERIES}); }
      continue;
    }
    let body=t, rules=[], ruleSrc='';
    const bar=body.lastIndexOf(' | ');
    if(bar>=0){                                          // « | » — правила, только если после него действительно правила цвета (иначе это просто текст)
      const rs=body.slice(bar+3), parts=rs.split(';'), rr=tpRules(rs);
      if(rr.length && rr.length===parts.length){ ruleSrc=rs; body=body.slice(0,bar).trim(); rules=rr; }
    }
    let m;
    if((m=/^@bar\s+([A-Za-z_]\w*)\s+(\S+)\s*(.*)$/.exec(body))){ const r=tpRange(m[2]); out.push({k:'bar',pin:m[1],lo:r ? r[0] : 0,hi:r ? r[1] : 1,label:m[3]||'',rules}); continue; }
    let scale=1, dim=false;
    if(body.startsWith('## ')){ scale=1.25; body=body.slice(3); } else if(body.startsWith('# ')){ scale=1.6; body=body.slice(2); } else if(body.startsWith('-# ')){ scale=.8; dim=true; body=body.slice(3); }
    out.push({k:'text',tok:tpText(body),rules,scale,dim});
  }
  return out;
}
// имена пинов, которые нужны графикам (история)
const tpGraphPins=ast=>{ const s=new Set(); for(const l of ast) if(l.k==='graph') for(const p of l.pins) s.add(p); return [...s]; };

// ---- вычисление: AST + значения → то, что рисовать ----
// get(name) → число | строка | undefined;  now — Date;  hist(name) → [[t,v],…] для графиков
function tpEval(ast,get,now,hist){
  const out=[], G=name=>name==='now' ? now.getTime()/1000 : get(name);
  for(const l of ast){
    if(l.k==='space' || l.k==='sep'){ out.push({k:l.k}); continue; }
    if(l.k==='bar'){ const v=get(l.pin); out.push({k:'bar',label:l.label,v:typeof v==='number' ? v : null,lo:l.lo,hi:l.hi,color:tpPick(l.rules,G),text:typeof v==='number' && isFinite(v) ? String(+v.toPrecision(3)) : '—'}); continue; }
    if(l.k==='graph'){
      const series=l.pins.map((p,i)=>({name:p,color:l.colors[i%l.colors.length],pts:(hist && hist(p,l.sec))||[],last:get(p)}));
      let lo=Infinity, hi=-Infinity;
      if(l.range){ lo=l.range[0]; hi=l.range[1]; }
      else for(const s of series) for(const q of s.pts){ if(q[1]<lo) lo=q[1]; if(q[1]>hi) hi=q[1]; }
      if(!isFinite(lo)){ lo=0; hi=1; } if(hi-lo<1e-9){ lo-=.5; hi+=.5; }
      out.push({k:'graph',sec:l.sec,lo,hi,series}); continue;
    }
    const base=tpPick(l.rules,G), spans=[], stack=[]; let bold=false;
    const cur=()=>{ for(let i=stack.length-1;i>=0;i--) if(stack[i].test(G)) return stack[i].color; return base; };
    for(const t of l.tok){
      if(t.t==='open') stack.push(t); else if(t.t==='close') stack.pop(); else if(t.t==='bold') bold=!bold;
      else if(t.t==='lit') spans.push({s:t.s,color:cur(),bold});
      else if(t.t==='val') spans.push({s:t.name==='now' ? tpNow(t.fmt,now) : tpFormat(get(t.name),t.fmt),color:cur(),bold});
    }
    out.push({k:'text',spans,scale:l.scale,dim:l.dim});
  }
  return out;
}
// история: добавить точку и срезать старше sec секунд
function tpPush(h,name,t,v,keep){
  if(typeof v!=='number' || !isFinite(v)) return;
  const a=h[name]||(h[name]=[]); a.push([t,v]);
  const cut=t-keep; let i=0; while(i<a.length && a[i][0]<cut) i++; if(i) a.splice(0,i);
}
