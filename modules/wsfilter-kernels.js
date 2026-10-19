"use strict";
/* ============================ Фильтр в стиле Wireshark ============================
   wsCompile(текст, num) → r=>bool для строки-объекта; ошибка разбора — исключение с позицией.
   wsLooksLike(текст) — похоже ли на выражение (иначе таблица разбирает старый синтаксис «слова и col:text»).
   Поля — ключи строки без учёта регистра (ie.ssid, body.ts, rssi); значения без кавычек — слово или число (5M, 0x1f, -50).
     поле                         значение непусто
     поле == x   != > < >= <=     (или eq ne gt lt ge le); числа сравниваются как числа, иначе строки без учёта регистра
     поле contains "текст"        подстрока
     поле matches "regex"  ~      регулярное выражение (без учёта регистра)
     поле in {a b "c d" 1..5}     одно из значений / диапазон чисел
     && and   || or   ! not   ( )
   Нет поля — сравнение ложно, а «!=» истинно (как в Wireshark: != это !(==)).
   Проверка: node tools/test-wsfilter.mjs */

const WS_NUM_RE=/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*([kmgt])?(?:hz)?$/i;
function wsNum(x){                                   // 12, -50, 1.5k, 7M, 0x1f → число; иначе NaN
  if(typeof x==='number') return x;
  const s=String(x??'').trim();
  if(/^0x[0-9a-f]+$/i.test(s)) return parseInt(s,16);
  const m=WS_NUM_RE.exec(s); if(!m) return NaN;
  const k=m[1] ? {k:1e3,m:1e6,g:1e9,t:1e12}[m[1].toLowerCase()] : 1;
  return parseFloat(s)*k;
}
// выражение вместо старых «слов»: ==, &&, ||, скобки, кавычки, contains / matches / in {…}, операторы с пробелами
function wsLooksLike(q){
  return /==|&&|\|\||[()"]|\s(?:contains|matches|eq|ne|gt|lt|ge|le)\s|\sin\s*\{|\s(?:>=|<=|>|<|!=|~)\s/i.test(' '+String(q||'')+' ');
}

const WS_KW={and:'&&',or:'||',not:'!',eq:'==',ne:'!=',gt:'>',lt:'<',ge:'>=',le:'<=',contains:'contains',matches:'matches',in:'in'};
function wsTokens(src){
  const T=[]; let i=0;
  const fail=(m,at)=>{ throw new Error(m+' at '+(at+1)); };
  while(i<src.length){
    const c=src[i];
    if(/\s/.test(c)){ i++; continue; }
    if(c==='"' || c==="'"){
      let j=i+1, s='';
      while(j<src.length && src[j]!==c){ if(src[j]==='\\' && j+1<src.length) j++; s+=src[j++]; }
      if(j>=src.length) fail('unterminated string',i);
      T.push({t:'str',v:s,at:i}); i=j+1; continue;
    }
    const two=src.substr(i,2);
    if(two==='=='||two==='!='||two==='>='||two==='<='||two==='&&'||two==='||'){ T.push({t:'op',v:two,at:i}); i+=2; continue; }
    if(c==='>'||c==='<'||c==='!'||c==='~'||c==='('||c===')'||c==='{'||c==='}'){ T.push({t:'op',v:c,at:i}); i++; continue; }
    if(c==='='){ T.push({t:'op',v:'==',at:i}); i++; continue; }          // одиночное «=» — как «==»
    let j=i; while(j<src.length && !/[\s(){}"'=!<>&|~]/.test(src[j])) j++;
    if(j===i) fail('unexpected "'+c+'"',i);
    T.push({t:'word',v:src.slice(i,j),at:i}); i=j;
  }
  return T;
}

function wsCompile(src,num){
  num=num||wsNum;
  const T=wsTokens(String(src)); let p=0;
  const peek=()=>T[p], next=()=>T[p++];
  const opOf=t=>t && (t.t==='op' ? t.v : t.t==='word' ? WS_KW[t.v.toLowerCase()] : undefined);
  const get=(r,name)=>{
    if(name in r) return r[name];
    const l=name.toLowerCase();
    for(const k in r) if(k.toLowerCase()===l) return r[k];
    return undefined;
  };
  const has=v=>v!==undefined && v!==null && v!=='';
  const lit=t=>{
    if(!t || (t.t!=='word' && t.t!=='str')) throw new Error('value expected'+(t ? ' at '+(t.at+1) : ' at the end'));
    return t;
  };
  const eq=(v,L)=>{
    if(!has(v)) return false;
    if(L.t==='word'){ const a=num(v), b=num(L.v); if(isFinite(a) && isFinite(b)) return a===b; }
    return String(v).toLowerCase()===L.v.toLowerCase();
  };
  const ord=(v,L,f)=>{
    if(!has(v)) return false;
    const a=num(v), b=num(L.v);
    if(isFinite(a) && isFinite(b)) return f(a,b);
    const x=String(v).toLowerCase(), y=L.v.toLowerCase();
    return f(x<y ? -1 : x>y ? 1 : 0,0);
  };
  function primary(){
    const t=next();
    if(!t) throw new Error('expression ended early');
    if(t.t==='op' && t.v==='('){ const e=or(); const c=next(); if(!c || c.v!==')') throw new Error('missing ) at '+(c ? c.at+1 : 'the end')); return e; }
    if(t.t==='op' && t.v==='!' || t.t==='word' && t.v.toLowerCase()==='not'){ const e=primary(); return r=>!e(r); }
    if(t.t!=='word' && t.t!=='str') throw new Error('unexpected "'+t.v+'" at '+(t.at+1));
    const name=t.v, o=opOf(peek());
    if(o===undefined || o==='&&' || o==='||' || o===')' || peek().t==='op' && (peek().v===')' )) return r=>has(get(r,name));
    if(o==='in'){
      next();
      const b=next(); if(!b || b.v!=='{' || b.t!=='op') throw new Error('{ expected after in');
      const items=[];
      for(;;){
        const x=next(); if(!x) throw new Error('missing } at the end');
        if(x.t==='op' && x.v==='}') break;
        if(x.t!=='word' && x.t!=='str') throw new Error('unexpected "'+x.v+'" at '+(x.at+1));
        const rg=x.t==='word' ? /^(.+?)\.\.(.+)$/.exec(x.v) : null;
        items.push(rg && isFinite(num(rg[1])) && isFinite(num(rg[2])) ? {lo:num(rg[1]),hi:num(rg[2])} : x);
      }
      return r=>{ const v=get(r,name); return items.some(it=>it.lo!==undefined ? has(v) && num(v)>=it.lo && num(v)<=it.hi : eq(v,it)); };
    }
    next();
    if(o==='==') { const L=lit(next()); return r=>eq(get(r,name),L); }
    if(o==='!=') { const L=lit(next()); return r=>!eq(get(r,name),L); }
    if(o==='>' || o==='<' || o==='>=' || o==='<='){
      const L=lit(next()), f=o==='>' ? (a,b)=>a>b : o==='<' ? (a,b)=>a<b : o==='>=' ? (a,b)=>a>=b : (a,b)=>a<=b;
      return r=>ord(get(r,name),L,f);
    }
    if(o==='contains'){ const s=lit(next()).v.toLowerCase(); return r=>{ const v=get(r,name); return has(v) && String(v).toLowerCase().includes(s); }; }
    if(o==='matches' || o==='~'){
      const L=lit(next()); let re; try{ re=new RegExp(L.v,'i'); }catch(e){ throw new Error('bad regex at '+(L.at+1)); }
      return r=>{ const v=get(r,name); return has(v) && re.test(String(v)); };
    }
    throw new Error('unexpected "'+peek().v+'" at '+(peek().at+1));
  }
  function and(){
    let a=primary();
    while(opOf(peek())==='&&'){ next(); const x=a, y=primary(); a=r=>x(r) && y(r); }
    return a;
  }
  function or(){
    let a=and();
    while(opOf(peek())==='||'){ next(); const x=a, y=and(); a=r=>x(r) || y(r); }
    return a;
  }
  if(!T.length) return null;
  const f=or();
  if(p<T.length) throw new Error('unexpected "'+T[p].v+'" at '+(T[p].at+1));
  return f;
}
