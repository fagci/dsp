"use strict";
/* Ввод и отображение чисел / частоты без DOM (проверяется в tools/test-entry.mjs):
   — калькулятор: разбор выражения (без eval), автомат кнопок, форматирование результата;
   — цифровой ввод (Number Pad): буфер, суффиксы (GHz MHz kHz Hz / k M m µ), единица по умолчанию;
   — разряды частоты (VFO): шаг выбранного разряда, цифры с нулями;
   — форматы вывода: частота (Hz…GHz), инженерный (SI), группы по три. */

const CE_FUN={
  sqrt:Math.sqrt, ln:Math.log, log:Math.log10, log2:Math.log2, exp:Math.exp, abs:Math.abs, floor:Math.floor, ceil:Math.ceil, round:Math.round,
  sin:Math.sin, cos:Math.cos, tan:Math.tan, asin:Math.asin, acos:Math.acos, atan:Math.atan, sinh:Math.sinh, cosh:Math.cosh, tanh:Math.tanh,
  db:x=>20*Math.log10(x), undb:x=>Math.pow(10,x/20), dbm:x=>10*Math.log10(x*1000), cbrt:Math.cbrt, sign:Math.sign };
const CE_TRIG={sin:1,cos:1,tan:1}, CE_ATRIG={asin:1,acos:1,atan:1};
const CE_CONST={pi:Math.PI, e:Math.E};

// Значение выражения. vars — {A:1,B:2,ANS:3,M:4} (без учёта регистра), opts.deg — тригонометрия в градусах.
// Незакрытые скобки закрываются сами (на экране можно набирать и считать «на лету»); ошибка — исключение Error.
function ceEval(src,vars,opts){
  vars=vars||{}; opts=opts||{};
  const s=String(src).replace(/[×·*]/g,'*').replace(/[÷:]/g,'/').replace(/[−–—]/g,'-').replace(/π/g,'pi').replace(/√/g,'sqrt').replace(/,/g,'.');
  const T=[]; let i=0;
  while(i<s.length){
    const c=s[i];
    if(/\s/.test(c)){ i++; continue; }
    const m=/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if(m){ T.push({t:'n',v:parseFloat(m[0])}); i+=m[0].length; continue; }
    const w=/^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
    if(w){ T.push({t:'w',v:w[0].toLowerCase()}); i+=w[0].length; continue; }
    if('+-*/^%!()'.includes(c)){ T.push({t:c}); i++; continue; }
    throw new Error('unexpected «'+c+'»');
  }
  let depth=0; for(const k of T){ if(k.t==='(') depth++; else if(k.t===')') depth--; }
  if(depth<0) throw new Error('extra )');
  while(depth-->0) T.push({t:')'});
  let p=0;
  const peek=()=>T[p] ? T[p].t : '', next=()=>T[p++];
  const V={}; for(const k in vars) V[k.toLowerCase()]=vars[k];
  const fact=n=>{ if(n<0 || n!==Math.floor(n) || n>170) throw new Error('factorial'); let r=1; for(let k=2;k<=n;k++) r*=k; return r; };
  function expr(){ let a=term(); while(peek()==='+' || peek()==='-'){ const o=next().t, b=term(); a=o==='+' ? a+b : a-b; } return a; }
  function term(){ let a=unary(); while(peek()==='*' || peek()==='/'){ const o=next().t, b=unary(); a=o==='*' ? a*b : a/b; } return a; }
  function unary(){
    if(peek()==='-'){ next(); return -unary(); }
    if(peek()==='+'){ next(); return unary(); }
    return power();
  }
  function power(){ const a=post(); if(peek()==='^'){ next(); return Math.pow(a,unary()); } return a; }   // правоассоциативно, -2^2 = -4
  function post(){
    let a=primary();
    for(;;){ if(peek()==='%'){ next(); a/=100; } else if(peek()==='!'){ next(); a=fact(a); } else break; }
    return a;
  }
  function primary(){
    const k=next(); if(!k) throw new Error('incomplete');
    if(k.t==='n'){ if(peek()==='(' || peek()==='w'){ return k.v*primary(); } return k.v; }           // 2(3+4), 2pi
    if(k.t==='('){ const v=expr(); if(next()?.t!==')') throw new Error('missing )'); return v; }
    if(k.t==='w'){
      if(k.v in CE_CONST) return CE_CONST[k.v];
      if(k.v in V){ const x=V[k.v]; if(typeof x!=='number' || !isFinite(x)) throw new Error(k.v.toUpperCase()+' has no value'); return x; }
      const f=CE_FUN[k.v]; if(!f) throw new Error('unknown «'+k.v+'»');
      if(next()?.t!=='(') throw new Error(k.v+' needs ( )');
      let x=expr(); if(next()?.t!==')') throw new Error('missing )');
      if(opts.deg && CE_TRIG[k.v]) x=x*Math.PI/180;
      let r=f(x); if(opts.deg && CE_ATRIG[k.v]) r=r*180/Math.PI;
      return r;
    }
    throw new Error('unexpected '+k.t);
  }
  const r=expr(); if(p<T.length) throw new Error('unexpected '+T[p].t);
  if(!isFinite(r)) throw new Error(Number.isNaN(r) ? 'not a number' : 'division by zero');
  return r;
}

// число → текст калькулятора: до digits значащих цифр, без хвостовых нулей, большие / малые — в степени
function ceFmt(x,digits){
  if(typeof x!=='number' || !isFinite(x)) return '';
  digits=digits||12;
  if(x===0) return '0';
  const a=Math.abs(x);
  let s=a>=1e15 || a<1e-9 ? x.toExponential(digits-1) : String(+x.toPrecision(digits));
  if(/e/.test(s)) s=s.replace(/\.?0+e/,'e').replace('e+','e');
  return s;
}

// Автомат кнопок калькулятора. st = {expr, res, err, mem, fresh, deg}; возвращает тот же объект.
const CE_OPS='+-×÷^';
function calcNew(){ return {expr:'',res:null,err:'',mem:0,fresh:false,deg:true,ans:0}; }
function calcVars(st,ext){ return Object.assign({},ext||{},{ANS:st.ans,M:st.mem}); }
function calcPreview(st,ext,digits){
  if(!st.expr) return null;
  try{ return ceEval(st.expr,calcVars(st,ext),{deg:st.deg}); }catch(e){ return null; }
}
function calcPress(st,key,ext,digits){
  const last=st.expr.slice(-1), isNum=c=>/[0-9.]/.test(c);
  const ins=t=>{ if(st.fresh && /^[0-9.(]|^[a-zπ√]/i.test(t) && !CE_OPS.includes(t)){ st.expr=''; } st.fresh=false; st.expr+=t; };
  const op=t=>{
    if(st.fresh){ st.expr=ceFmt(st.res,digits); st.fresh=false; }
    if(!st.expr){ if(t==='-' ) st.expr='-'; else if(st.ans!==0 || st.res!==null) st.expr=ceFmt(st.ans,digits)+t; return; }
    if(CE_OPS.includes(last) && st.expr.length>1) st.expr=st.expr.slice(0,-1);                 // 5+ → 5×: заменяем знак
    st.expr+=t;
  };
  st.err='';
  if(/^[0-9]$/.test(key)) ins(key);
  else if(key==='.'){ const m=/[0-9.]*$/.exec(st.expr)[0]; if(st.fresh){ st.expr=''; st.fresh=false; } if(!m.includes('.')) st.expr+=(isNum(st.expr.slice(-1)) ? '' : '0')+'.'; }
  else if(CE_OPS.includes(key)) op(key);
  else if(key==='−') op('-');
  else if(key==='(' || key===')') ins(key);
  else if(key==='%'){ if(st.expr && !CE_OPS.includes(last)) st.expr+='%'; }
  else if(key==='x²'){ if(st.fresh){ st.expr=ceFmt(st.res,digits); st.fresh=false; } if(st.expr) st.expr+='^2'; }
  else if(key==='1/x'){ if(st.fresh){ st.expr=ceFmt(st.res,digits); st.fresh=false; } if(st.expr) st.expr='1/('+st.expr+')'; }
  else if(key==='√'){ ins('sqrt('); }
  else if(['sin','cos','tan','asin','acos','atan','ln','log','exp'].includes(key)) ins(key+'(');
  else if(key==='π') ins('π');
  else if(key==='e') ins('e');
  else if(key==='A' || key==='B' || key==='ANS' || key==='M') ins(key);
  else if(key==='MR') ins('M');
  else if(key==='MC') st.mem=0;
  else if(key==='M+' || key==='M−'){
    const v=st.fresh ? st.res : calcPreview(st,ext,digits);
    if(typeof v==='number'){ st.mem+=key==='M+' ? v : -v; }
  }
  else if(key==='DEG') st.deg=!st.deg;
  else if(key==='⌫'){ if(st.fresh){ st.fresh=false; } else st.expr=st.expr.replace(/(sqrt\(|asin\(|acos\(|atan\(|sin\(|cos\(|tan\(|ln\(|log\(|exp\(|ANS|.)$/,''); }
  else if(key==='C'){ st.expr=''; st.fresh=false; }
  else if(key==='AC'){ st.expr=''; st.fresh=false; st.res=null; st.mem=0; st.ans=0; }
  else if(key==='±'){
    if(st.fresh){ st.res=-st.res; st.ans=st.res; st.expr=ceFmt(st.res,digits); }
    else {
      const m=/(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)$/i.exec(st.expr);
      if(!m) st.expr+='-';
      else { const b=st.expr.slice(0,m.index), neg=b.endsWith('-') && (b.length===1 || /[-+×÷^(*\/]$/.test(b.slice(0,-1)));
        st.expr=neg ? b.slice(0,-1)+m[0] : b+'-'+m[0]; }
    }
  }
  else if(key==='='){
    if(!st.expr) return st;
    try{ const r=ceEval(st.expr,calcVars(st,ext),{deg:st.deg}); st.res=r; st.ans=r; st.fresh=true; }
    catch(e){ st.err=e.message; }
  }
  return st;
}

/* ---------- Number Pad: цифровой ввод числа / частоты ---------- */
const NP_MULT_F={GHz:1e9,MHz:1e6,kHz:1e3,Hz:1}, NP_MULT_N={M:1e6,k:1e3,m:1e-3,'µ':1e-6};
const NP_SUFFIX={frequency:['GHz','MHz','kHz','Hz'],number:['M','k','m','µ']};
function npNew(){ return {buf:'',out:null,pulse:0}; }
const npValue=buf=>{ if(!buf || buf==='-' || buf==='.' || buf==='-.') return null; const v=parseFloat(buf); return isFinite(v) ? v : null; };
// o: {mode:'frequency'|'number', unit:'MHz', min, max}; commit-клавиши ставят out и pulse
function npPress(st,key,o){
  o=o||{}; const mode=o.mode==='number' ? 'number' : 'frequency';
  const mult=mode==='frequency' ? NP_MULT_F : NP_MULT_N;
  const commit=m=>{
    const v=npValue(st.buf); if(v===null) return;
    let r=v*m; if(typeof o.min==='number' && isFinite(o.min)) r=Math.max(o.min,r); if(typeof o.max==='number' && isFinite(o.max)) r=Math.min(o.max,r);
    st.out=r; st.pulse=2; st.buf='';
  };
  if(/^[0-9]$/.test(key)){ if(st.buf.replace(/[-.]/g,'').length<15) st.buf=st.buf==='0' ? key : st.buf+key; }
  else if(key==='.'){ if(!st.buf.includes('.')) st.buf+=st.buf==='' || st.buf==='-' ? '0.' : '.'; }
  else if(key==='±'){ st.buf=st.buf.startsWith('-') ? st.buf.slice(1) : '-'+st.buf; }
  else if(key==='⌫') st.buf=st.buf.slice(0,-1);
  else if(key==='C') st.buf='';
  else if(key==='ENT') commit(mode==='frequency' ? (NP_MULT_F[o.unit]||1e6) : 1);
  else if(mult[key]!==undefined) commit(mult[key]);
  return st;
}
// клавиатура компьютера → кнопка Number Pad / калькулятора (null — не наша клавиша)
function keyName(ev){
  const k=ev.key;
  if(/^[0-9.]$/.test(k)) return k;
  if(k===',') return '.';
  if(k==='Enter' || k==='=') return k==='=' ? '=' : 'ENT';
  if(k==='Backspace') return '⌫';
  if(k==='Escape' || k==='Delete') return 'C';
  if(k==='+' || k==='^' || k==='(' || k===')' || k==='%') return k;
  if(k==='-') return '−';
  if(k==='*') return '×';
  if(k==='/') return '÷';
  return null;
}

/* ---------- разряды частоты (VFO) ---------- */
// k — номер разряда от единиц (0 — Hz, 3 — kHz, 6 — MHz); результат зажат в [lo, hi]
function fdStep(f,k,dir,lo,hi){
  const r=Math.round(f)+dir*Math.pow(10,k);
  return Math.min(hi,Math.max(lo,r));
}
// строка из n цифр (с нулями слева)
const fdDigits=(f,n)=>String(Math.min(Math.pow(10,n)-1,Math.max(0,Math.round(f)))).padStart(n,'0');

/* ---------- форматы вывода ---------- */
const SI_PFX=[[-12,'p'],[-9,'n'],[-6,'µ'],[-3,'m'],[0,''],[3,'k'],[6,'M'],[9,'G'],[12,'T']];
function sigFmt(m,digits){ const d=Math.max(0,digits-1-Math.floor(Math.log10(Math.abs(m)||1))); return m.toFixed(Math.min(d,9)); }
// → {text, unit}. mode: frequency (Hz kHz MHz GHz), si (p…T к значению + unit), plain (decimals знаков), groups (14.200.000)
function fmtNum(x,o){
  o=o||{}; const digits=o.digits||6, unit=o.unit||'';
  if(typeof x!=='number' || !isFinite(x)) return {text:'—',unit:''};
  const mode=o.mode||'frequency', a=Math.abs(x);
  if(mode==='plain') return {text:x.toFixed(Math.max(0,Math.min(9,o.decimals==null ? 3 : o.decimals))),unit};
  if(mode==='groups'){
    const s=String(Math.round(Math.abs(x))).replace(/\B(?=(\d{3})+(?!\d))/g,o.sep==null ? '.' : o.sep);
    return {text:(x<0 ? '-' : '')+s,unit:unit||'Hz'};
  }
  if(mode==='frequency'){
    const u=a>=1e9 ? ['GHz',1e9] : a>=1e6 ? ['MHz',1e6] : a>=1e3 ? ['kHz',1e3] : ['Hz',1];
    return {text:x===0 ? '0' : sigFmt(x/u[1],digits),unit:u[0]};
  }
  // si
  if(x===0) return {text:'0',unit};
  let e=Math.floor(Math.log10(a)/3)*3; e=Math.max(-12,Math.min(12,e));
  const m=x/Math.pow(10,e), r=SI_PFX.find(q=>q[0]===e);
  return {text:sigFmt(m,digits),unit:(r ? r[1] : '')+unit};
}
