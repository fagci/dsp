"use strict";
/* ============================ Table Chart: модель графика из строк ============================
   tcModel(rows,{kind,x,y,by,last,hold,peak}) → {ok,err,kind,vector,xName,yNames,xs,xl,series[{name,v,pk,age}],rows,lo,hi,max}
   Скаляр: x → y по строкам (столбики при ≤64 разных x, иначе линии), серии — по колонке by или по колонкам y.
   Вектор («3,5,4» или массив в ячейке): индекс → значение, последние N строк (или по одной на значение by).
   Проверка: node tools/test-tblchart.mjs */

const TC_XAUTO=['chan','t','time','x','id','name'], TC_YAUTO=['rssi_max','busy','csi','rssi','value','y'];
const TC_NUM=/^\s*-?\d[\d.eE+-]*\s*$/, TC_VEC=/^\s*-?\d[\d.eE+-]*(\s*[,;\s]\s*-?\d[\d.eE+-]*)+\s*$/;

function tcVec(c){
  if(Array.isArray(c)) return c.length>1 ? c.map(Number) : null;
  if(typeof c==='string' && TC_VEC.test(c)) return c.split(/[,;\s]+/).filter(Boolean).map(Number);
  return null;
}
const tcNum=c=>typeof c==='number' ? c : typeof c==='string' && TC_NUM.test(c) ? +c : null;
function tcTime(v){ const d=new Date(v); return d.toTimeString().slice(0,8); }

function tcModel(rows,o){
  const bad=err=>({ok:false,err});
  if(!rows || !rows.length) return bad('no rows');
  const cols=new Set(); for(const r of rows.slice(0,20)) for(const k in r) cols.add(k);
  const list=(s)=>String(s||'').split(',').map(t=>t.trim()).filter(Boolean);
  const cell=(c)=>{ for(const r of rows){ const v=r[c]; if(v!=='' && v!=null) return v; } return null; };
  let xName=o.x && o.x.trim() || TC_XAUTO.find(c=>cols.has(c) && c!==(o.y||'')) || '';
  if(xName && !cols.has(xName)) return bad('no column «'+xName+'»');
  let yNames=list(o.y);
  if(!yNames.length){
    const c=TC_YAUTO.find(k=>cols.has(k) && k!==xName) || [...cols].find(k=>k!==xName && (tcVec(cell(k)) || tcNum(cell(k))!==null));
    if(c) yNames=[c];
  }
  if(!yNames.length) return bad('no number column — set «y»');
  for(const y of yNames) if(!cols.has(y)) return bad('no column «'+y+'»');
  const by=(o.by||'').trim();
  if(by && !cols.has(by)) return bad('no column «'+by+'»');
  const vector=!!tcVec(cell(yNames[0]));
  const m={ok:true, vector, xName:vector ? 'index' : xName || 'row', yNames, series:[]};
  let lo=Infinity, hi=-Infinity;
  const see=v=>{ if(v!=null && isFinite(v)){ if(v<lo) lo=v; if(v>hi) hi=v; } };

  if(vector){
    const y=yNames[0], last=Math.max(1,o.last|0||1), pick=[];
    if(by){ const seen=new Set(); for(let i=rows.length-1;i>=0 && pick.length<8;i--){ const k=String(rows[i][by]); const v=tcVec(rows[i][y]); if(v && !seen.has(k)){ seen.add(k); pick.push({name:k,v,age:1}); } } pick.reverse(); }
    else { for(let i=rows.length-1;i>=0 && pick.length<last;i--){ const v=tcVec(rows[i][y]); if(v) pick.push({name:'#'+i,v,ci:0}); } pick.reverse(); pick.forEach((s,k)=>{ s.age=(k+1)/pick.length; }); }
    if(!pick.length) return bad('no vector in «'+y+'»');
    const L=Math.max(...pick.map(s=>s.v.length));
    m.xs=Array.from({length:L},(_,i)=>i); m.xl=m.xs.map(String);
    for(const s of pick) for(const v of s.v) see(v);
    m.series=pick;
    m.kind=o.kind==='heat' ? 'heat' : 'line';
    if(m.kind==='heat') m.rows=pick.map(s=>s.v);
  } else {
    const src=rows.length>2000 ? rows.slice(-2000) : rows;
    const xr=src.map((r,i)=>xName ? r[xName] : i);
    const numX=xr.every(v=>tcNum(v)!==null);
    const keyOf=v=>numX ? +tcNum(v) : String(v);
    const xs=[...new Set(xr.map(keyOf))];
    if(numX) xs.sort((a,b)=>a-b);
    const at=new Map(xs.map((x,i)=>[x,i]));
    const isTime=xName==='t' || xName==='time';
    m.xs=xs; m.xl=xs.map(v=>isTime && numX && v>1e11 ? tcTime(v) : String(typeof v==='number' ? Math.round(v*100)/100 : v));
    const groups=[];                                          // [имя серии, колонка y, строки]
    if(by){ const g=new Map(); src.forEach((r,i)=>{ const k=String(r[by]); (g.get(k)||g.set(k,[]).get(k)).push(i); }); let c=0;
      for(const [k,idx] of g){ if(c++>=8) break; groups.push([k,yNames[0],idx]); } }
    else for(const y of yNames) groups.push([y,y,src.map((_,i)=>i)]);
    for(const [name,y,idx] of groups){
      const v=new Array(xs.length).fill(null);
      for(const i of idx){ const val=tcNum(src[i][y]); if(val!==null) v[at.get(keyOf(xr[i]))]=val; }
      const s={name,v};
      if(o.hold && o.peak){
        s.pk=v.map((val,j)=>{ const k=name+'\0'+xs[j], old=o.peak.get(k); const nv=val==null ? old : old==null || val>old ? val : old; if(nv!=null) o.peak.set(k,nv); return nv==null ? null : nv; });
        s.pk.forEach(see);
      }
      v.forEach(see); m.series.push(s);
    }
    m.kind=o.kind==='bar' || o.kind==='line' ? o.kind : (!isTime && xs.length<=64 ? 'bar' : 'line');
  }
  if(!isFinite(lo)) return bad('no numbers in «'+yNames.join(', ')+'»');
  if(m.kind==='bar' && lo>=0) lo=0;
  m.lo=lo; m.hi=hi; m.max=hi;
  return m;
}
