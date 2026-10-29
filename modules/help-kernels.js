"use strict";
/* ============================ HELP + НЕЧЁТКИЙ ПОИСК: чистая логика (без DOM) ============================
   Нечёткий поиск (опечатки, сокращения: «gph» → Graph) — общий для палитры модулей, списка патчей и справки.
   Справка: разбор markdown страниц help/*.md и README.md, оглавление, поиск, карточка модуля, где модуль встречается в пресетах.
   Проверка: node tools/test-help.mjs */

// ---- нечёткий поиск ----
const fzTokens=s=>String(s==null ? '' : s).toLocaleLowerCase('ru').split(/[^a-zа-яё0-9]+/).filter(Boolean);
function fzDist(a,b,max){                           // расстояние Дамерау — Левенштейна (перестановка соседних — одна правка); больше max — max+1
  if(Math.abs(a.length-b.length)>max) return max+1;
  let p2=null, p=Array.from({length:b.length+1},(_,j)=>j);
  for(let i=1;i<=a.length;i++){
    const c=[i]; let lo=i;
    for(let j=1;j<=b.length;j++){
      let v=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1] ? 0 : 1));
      if(p2 && i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]) v=Math.min(v,p2[j-2]+1);
      c.push(v); if(v<lo) lo=v;
    }
    if(lo>max) return max+1;
    p2=p; p=c;
  }
  return p[b.length];
}
const fzSubseq=(w,t)=>{ let i=0; for(const c of t) if(c===w[i] && ++i===w.length) return true; return w.length===0; };
// слово против токенов: 0 — нет; иначе доля (0..1): опечатка в слове или его начале (1 правка до 6 букв, 2 — длиннее) или сокращение (буквы по порядку, не короче 3)
function fzWord(w,tokens){
  if(w.length<3) return 0;
  const max=w.length>=7 ? 2 : 1;
  let best=0;
  for(const t of tokens){
    if(t.length<2) continue;
    const d=Math.min(fzDist(w,t,max),t.length>w.length ? fzDist(w,t.slice(0,w.length),max) : max+1);
    if(d<=max) best=Math.max(best,1-d*.3-Math.abs(t.length-w.length)*.03);      // при равных правках ближе по длине — выше
    else if(t.length>w.length && fzSubseq(w,t) && w[0]===t[0]) best=Math.max(best,.35);
  }
  return best;
}
// все слова запроса должны найтись: в начале токена — 3, внутри текста — 2, нечётко — до 1; иначе 0. tokens — токены текста, text — он же в нижнем регистре
function fzScoreWords(words,tokens,text){
  if(!words.length) return 1;
  let sc=0;
  for(const w of words){
    if(tokens.some(t=>t.startsWith(w))) sc+=3;
    else if(text.includes(w)) sc+=2;
    else { const f=fzWord(w,tokens); if(!f) return 0; sc+=f; }
  }
  return sc;
}

// ---- markdown (минимум для справки: заголовки, абзацы, списки, код, таблицы, цитаты, **, *, `, ссылки) ----
const hlpEsc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const hlpSlug=s=>String(s).toLowerCase().replace(/<[^>]*>/g,'').replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s/g,'-');   // как якоря GitHub
const hlpSafeHref=h=>/^(https?:|mailto:|#|[^:]*$)/i.test(h.trim()) ? h.trim() : '';
function hlpInline(s){
  const codes=[];
  s=String(s).replace(/`([^`]+)`/g,(m,c)=>{ codes.push(c); return '\u0000'+(codes.length-1)+'\u0000'; });
  s=hlpEsc(s);
  s=s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,'$1')                         // картинки справке не нужны — остаётся подпись
     .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^)]*&quot;)?\)/g,(m,t,h)=>{ h=hlpSafeHref(h.replace(/&amp;/g,'&')); return h ? '<a href="'+hlpEsc(h)+'" data-href="'+hlpEsc(h)+'">'+t+'</a>' : t; })
     .replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>')
     .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g,'$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g,(m,i)=>'<code>'+hlpEsc(codes[+i])+'</code>');
}
const hlpIsRow=l=>/^\s*\|.*\|\s*$/.test(l), hlpIsSep=l=>/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const hlpCells=l=>l.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
function hlpMd(src){
  const L=String(src).replace(/\r/g,'').split('\n'), out=[];
  let i=0;
  const listItem=l=>/^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
  while(i<L.length){
    const l=L[i];
    if(!l.trim()){ i++; continue; }
    let m;
    if((m=/^\s*(```|~~~)/.exec(l))){                       // блок кода до закрывающего забора
      const f=m[1], buf=[]; i++;
      while(i<L.length && !L[i].trim().startsWith(f)) buf.push(L[i++]);
      i++; out.push('<pre><code>'+hlpEsc(buf.join('\n'))+'</code></pre>'); continue;
    }
    if((m=/^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))){
      const lv=m[1].length; out.push('<h'+lv+' id="'+hlpEsc(hlpSlug(m[2]))+'">'+hlpInline(m[2])+'</h'+lv+'>'); i++; continue; }
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)){ out.push('<hr>'); i++; continue; }
    if(hlpIsRow(l) && i+1<L.length && hlpIsSep(L[i+1])){   // таблица
      const head=hlpCells(l); i+=2; const rows=[];
      while(i<L.length && hlpIsRow(L[i])) rows.push(hlpCells(L[i++]));
      out.push('<table><thead><tr>'+head.map(c=>'<th>'+hlpInline(c)+'</th>').join('')+'</tr></thead><tbody>'+
               rows.map(r=>'<tr>'+head.map((_,k)=>'<td>'+hlpInline(r[k]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table>');
      continue;
    }
    if(/^\s*>/.test(l)){ const buf=[]; while(i<L.length && /^\s*>/.test(L[i])) buf.push(L[i++].replace(/^\s*>\s?/,'')); out.push('<blockquote>'+hlpMd(buf.join('\n'))+'</blockquote>'); continue; }
    if(listItem(l)){                                       // список: вложенность — по отступу
      const stack=[]; let html='';
      while(i<L.length){
        const li=listItem(L[i]);
        if(!li){
          if(L[i].trim() && /^\s{2,}\S/.test(L[i]) && stack.length){ html+=' '+hlpInline(L[i].trim()); i++; continue; }   // продолжение пункта
          if(!L[i].trim() && i+1<L.length && listItem(L[i+1])){ i++; continue; }
          break;
        }
        const ind=li[1].replace(/\t/g,'    ').length, tag=/\d/.test(li[2]) ? 'ol' : 'ul';
        if(!stack.length || ind>stack[stack.length-1].ind){ html+='<'+tag+'><li>'; stack.push({ind,tag}); }
        else {
          while(stack.length>1 && ind<stack[stack.length-1].ind) html+='</li></'+stack.pop().tag+'>';
          const top=stack[stack.length-1];
          if(top.tag!==tag){ html+='</li></'+top.tag+'><'+tag+'><li>'; top.tag=tag; } else html+='</li><li>';   // ul сменился на ol на том же уровне
        }
        html+=hlpInline(li[3]); i++;
      }
      while(stack.length) html+='</li></'+stack.pop().tag+'>';
      out.push(html); continue;
    }
    const buf=[];                                          // абзац до пустой строки или начала другого блока
    while(i<L.length && L[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>)/.test(L[i]) && !listItem(L[i]) && !(hlpIsRow(L[i]) && i+1<L.length && hlpIsSep(L[i+1]))) buf.push(L[i++].trim());
    out.push('<p>'+hlpInline(buf.join(' '))+'</p>');
  }
  return out.join('\n');
}

// ---- README и страницы ----
const hlpStrip=s=>String(s).replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[`*_]/g,'');
function hlpSections(text){                          // [{id,title,level,body}] — по заголовкам вне блоков кода
  const L=String(text).replace(/\r/g,'').split('\n'), out=[], seen=new Map();
  let cur=null, fence=false;
  for(const l of L){
    if(/^\s*(```|~~~)/.test(l)) fence=!fence;
    const m=!fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if(m){
      let id=hlpSlug(m[2]); const k=seen.get(id)|0; seen.set(id,k+1); if(k) id+='-'+k;   // повтор — суффикс, как у GitHub
      cur={id,title:hlpStrip(m[2]),level:m[1].length,body:[]}; out.push(cur);
    } else if(cur) cur.body.push(l);
  }
  for(const s of out) s.body=s.body.join('\n').trim();
  return out;
}
// пункты README «- **Имя** …» (и вложенные) → имя в нижнем регистре → [markdown]; вложенные строки глубже пункта идут вместе с ним
function hlpBullets(text){
  const L=String(text).replace(/\r/g,'').split('\n'), map=new Map();
  let fence=false;
  for(let i=0;i<L.length;i++){
    if(/^\s*(```|~~~)/.test(L[i])){ fence=!fence; continue; }
    if(fence) continue;
    const m=/^(\s*)[-*]\s+\*\*([^*]+)\*\*/.exec(L[i]); if(!m) continue;
    const ind=m[1].length, buf=[L[i].trim().replace(/^[-*]\s+/,'')];
    for(let j=i+1;j<L.length && (!L[j].trim() || L[j].search(/\S/)>ind);j++){ if(L[j].trim()) buf.push(L[j].trim()); }
    const key=hlpNorm(m[2]); if(!map.has(key)) map.set(key,[]);
    map.get(key).push(buf.join('\n'));
  }
  return map;
}
const hlpNorm=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
// оглавление help/README.md: «- [Название](файл.md) — описание»
function hlpToc(md){
  const out=[];
  for(const l of String(md).split('\n')){
    const m=/^\s*[-*]\s+\[([^\]]+)\]\(([^)#\s]+\.md)\)\s*(?:[—–-]\s*(.*))?$/.exec(l);
    if(m && !m[2].startsWith('..') && !/^https?:/.test(m[2])) out.push({title:hlpStrip(m[1]),file:m[2],desc:hlpStrip(m[3]||'')});
  }
  return out;
}
// путь ссылки относительно страницы: ('help/data.md','../README.md') → 'README.md'
function hlpResolve(from,href){
  const base=String(from).split('/').slice(0,-1), parts=String(href).split('#')[0].split('/'), out=base.slice();
  for(const p of parts){ if(p==='..') out.pop(); else if(p && p!=='.') out.push(p); }
  return out.join('/');
}

// длинный пункт README читать тяжело: делим на предложения (не после «e.g.», «i.e.», «etc.», «vs.») и собираем в короткие абзацы
function hlpSentences(md){
  const t=String(md).replace(/\s+/g,' ').trim(), out=[];
  let start=0;
  for(const m of t.matchAll(/[.!?](?=\s+[A-ZА-Я*`(\[«])/g)){
    const end=m.index+1;
    if(/\b(e\.g|i\.e|etc|vs|approx|incl)\.$/i.test(t.slice(Math.max(0,end-8),end))) continue;
    out.push(t.slice(start,end).trim()); start=end;
  }
  if(start<t.length) out.push(t.slice(start).trim());
  return out.filter(Boolean);
}
// резюме — первые предложения, пока не набралось chars знаков; rest — остальное абзацами по per предложений
function hlpSummary(md,chars,per){
  const S=hlpSentences(md); let n=0, len=0;
  while(n<S.length && (n===0 || len+S[n].length<=chars)){ len+=S[n].length; n++; }
  const rest=[]; for(let i=n;i<S.length;i+=per||3) rest.push(S.slice(i,i+(per||3)).join(' '));
  return {head:S.slice(0,n).join(' '),rest};
}

// ---- карточка модуля и «где встречается» ----
function hlpModCard(d){
  const arr=x=>Array.isArray(x) ? x : [];
  return {id:d.id,title:d.title||d.id,cat:d.cat||'',kw:d.kw||'',
    ins:arr(d.ins).map(p=>({n:p.n,t:p.t||'',tip:p.tip||''})),
    outs:arr(d.outs).map(p=>({n:p.n,t:p.t||'',tip:p.tip||''})),
    params:arr(d.params).filter(s=>s && s.n && s.t!=='button').map(s=>({n:s.n,label:s.label||'',t:s.t||'',d:s.d,tip:s.tip||'',opts:Array.isArray(s.opts) ? s.opts.map(o=>Array.isArray(o) ? o[0] : o && typeof o==='object' ? (o.v ?? o.value ?? o.n) : o) : null,adv:!!s.adv})),
    buttons:arr(d.params).filter(s=>s && s.t==='button').map(s=>s.label||s.n),
    dynamic:typeof d.ins==='function' || typeof d.outs==='function'};
}
// пресеты: {имя: исходник функции-сборщика} → {тип модуля: [имена]}
function hlpUsage(sources){
  const by=new Map();
  for(const name in sources){
    for(const m of String(sources[name]).matchAll(/addNode\(\s*['"]([\w.-]+)['"]/g)){
      let a=by.get(m[1]); if(!a) by.set(m[1],a=[]); if(a[a.length-1]!==name && !a.includes(name)) a.push(name);
    }
  }
  return by;
}

// ---- поиск по справке ----
// entries: [{kind,key,title,text}] — kind: topic | module | manual | preset; совпадение в названии весит больше, чем в тексте
function hlpSearch(entries,query,limit){
  const words=fzTokens(query);
  if(!words.length) return [];
  const res=[];
  for(const e of entries){
    if(!e._t){ e._t=fzTokens(e.title); e._ts=e._t.join(' '); e._b=String(e.text||'').toLocaleLowerCase('ru'); }
    let sc=fzScoreWords(words,e._t,e._ts)*4, body=0;
    if(!sc){                                           // не в названии: все слова должны быть в тексте (точно)
      for(const w of words){ if(!e._b.includes(w)){ body=-1; break; } body+=1; }
      if(body<=0) continue;
      sc=body*.5;
    }
    if(e.kind==='topic') sc*=1.5; else if(e.kind==='module') sc*=1.2;
    res.push({e,sc});
  }
  res.sort((a,b)=>b.sc-a.sc||a.e.title.length-b.e.title.length);
  return res.slice(0,limit||60).map(x=>x.e);
}
