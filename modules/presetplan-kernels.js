"use strict";
/* Два слоя патчей. Встроенные пресеты — это код (PRESETS: имя → функция-строитель), в хранилище их не копируем: список строится из имён,
   а граф собирается при открытии и кэшируется в памяти. В хранилище (localStorage) лежат только патчи пользователя и temp-копии;
   пользовательский патч с именем встроенного перекрывает его. Так старт не зависит от числа пресетов, а правка умолчаний модулей
   не требует пересборки. Без DOM — tools/test-presetplan.mjs */

// Одноразовая миграция старого хранилища: там лежали готовые копии всех встроенных пресетов — убираем их (и снятые с поставки),
// остаются патчи пользователя. builtin — {имя: …} или Set имён; gone — префиксы снятых пресетов. → {user, dropped}
function patchMigrate(stored,builtin,gone){
  const has=n=>typeof builtin.has==='function' ? builtin.has(n) : Object.prototype.hasOwnProperty.call(builtin,n);
  const user={}; let dropped=0;
  for(const k of Object.keys(stored||{})){
    if(has(k) || (gone||[]).some(g=>k.startsWith(g))){ dropped++; continue; }
    user[k]=stored[k];
  }
  return {user, dropped};
}

// Имена в списке: встроенные + пользовательские (без дублей), порядок — встроенные, затем остальные
function patchNames(builtin,user){
  const out=Object.keys(builtin||{});
  for(const k of Object.keys(user||{})) if(!(builtin && Object.prototype.hasOwnProperty.call(builtin,k))) out.push(k);
  return out;
}

// Какие слова в кавычках встречаются в исходнике строителя — по ним решаем, нужны ли пресету спрятанные на этом устройстве модули,
// не собирая граф. Лишние совпадения безвредны: берём только id из known (набор / объект).
function presetSrcIds(src,known){
  const has=n=>typeof known.has==='function' ? known.has(n) : Object.prototype.hasOwnProperty.call(known,n);
  const out=new Set(); const re=/['"`]([A-Za-z0-9_]+)['"`]/g; let m;
  while((m=re.exec(String(src)))) if(has(m[1])) out.add(m[1]);
  return out;
}

/* ---- поиск по пресетам не только по имени ----
   Пресет — код, и запускать его ради поиска незачем: из исходника строителя берём то, что о нём известно. Текст заметок (text:'…'+'…'),
   модули, которые он создаёт (addNode('rtlsdr',…) → «USB SDR»), категорию. Слово запроса ищется во всех полях, у каждого свой вес:
   имя 1, категория .8, модули .7, заметка .5; все слова должны найтись (в любом поле). Нужны fzTokens / fzScoreWords (help-kernels.js). */
const PS_W={name:1, cat:.8, mods:.7, note:.5};
// текст всех заметок (литералы строк после «text:», в том числе склеенные «+»), одной строкой, не длиннее max
function presetNoteOf(src,max){
  const out=[], lit=/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const re=/\btext\s*:\s*((?:(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*\+?\s*)+)/g;
  let m; const S=String(src||'');
  while((m=re.exec(S))){ lit.lastIndex=0; let k; while((k=lit.exec(m[1]))) out.push((k[1] ?? k[2] ?? k[3] ?? '').replace(/\\n/g,' ').replace(/\\(.)/g,'$1')); }
  return out.join(' ').replace(/\s+/g,' ').trim().slice(0,max||900);
}
// описание пресета для поиска: имя (с подгруппой), категория, названия и id модулей, заметка. known — {id: модуль}; titleOf(id) → название
function presetDocOf(name,sub,cat,src,known,titleOf){
  const ids=[...presetSrcIds(src,known)], titles=[...new Set(ids.map(id=>{ const t=titleOf ? titleOf(id) : ''; return String(t||id).replace(/\s*\([^)]*\)/g,''); }))];
  const nm=(sub ? sub+' ' : '')+name, txt={name:nm+(/[-_]/.test(nm) ? ' '+nm.replace(/[-_]/g,'') : ''), cat:cat||'', mods:titles.join(' ')+' '+ids.join(' '), note:presetNoteOf(src)};
  const d={name,titles,note:txt.note,cat:cat||''};
  for(const k of Object.keys(txt)){ d[k+'Txt']=txt[k].toLocaleLowerCase('ru'); d[k+'Tok']=fzTokens(txt[k]); }
  return d;
}
// сумма по словам лучшего (вес поля × оценка слова в поле); слово нигде не нашлось — 0 (все слова обязательны)
function presetScoreDoc(words,d){
  if(!words.length) return 1;
  let sum=0;
  for(const w of words){
    let b=0;
    for(const k of Object.keys(PS_W)){ const s=fzScoreWords([w],d[k+'Tok'],d[k+'Txt'])*PS_W[k]; if(s>b) b=s; }
    if(!b) return 0; sum+=b;
  }
  return sum;
}
// почему найдено, когда слова нет в имени: «category Maps», «uses USB SDR, Table», «…кусок заметки…»; пусто — совпало по имени
function presetWhy(words,d){
  for(const w of words){
    if(fzScoreWords([w],d.nameTok,d.nameTxt)>=2) continue;
    if(fzScoreWords([w],d.catTok,d.catTxt)>=2) return 'category: '+d.cat;
    const mt=d.titles.filter(t=>t.toLocaleLowerCase('ru').includes(w) || fzScoreWords([w],fzTokens(t),t.toLocaleLowerCase('ru'))>=2);
    if(mt.length) return 'uses: '+mt.slice(0,3).join(', ');
    const i=d.noteTxt.indexOf(w);
    if(i>=0){                                                       // кусок вокруг слова, края — по границам слов
      let a=Math.max(0,i-28), b=Math.min(d.note.length,i+w.length+36);
      if(a>0){ const sp=d.note.indexOf(' ',a); if(sp>=0 && sp<i) a=sp+1; }
      if(b<d.note.length){ const sp=d.note.lastIndexOf(' ',b); if(sp>i+w.length) b=sp; }
      return (a?'…':'')+d.note.slice(a,b).trim()+(b<d.note.length?'…':'');
    }
  }
  return '';
}

// ---- temp-копии: несохранённый граф, отложенный при переходе к другому патчу ----
// Имя: «temp:<патч, с которого начали> · ГГГГ-ММ-ДД ЧЧ:ММ» — время последней правки (минуты), а не момента перехода.
// Старый формат «temp:ГГГГ-ММ-ДД ЧЧ:ММ:СС — <патч>» тоже читается.
const TEMP_PREFIX='temp:', TEMP_MAX=10;
function tempStamp(ms){
  const d=new Date(ms), z=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+' '+z(d.getHours())+':'+z(d.getMinutes());
}
const tempKey=(base,ms)=>TEMP_PREFIX+(base||'untitled')+' · '+tempStamp(ms);
// имя temp-копии → {base: исходный патч, stamp: время правки}; не temp — null
function tempParse(key){
  if(typeof key!=='string' || !key.startsWith(TEMP_PREFIX)) return null;
  let m=/^temp:(.*) · (\d{4}-\d\d-\d\d \d\d:\d\d)$/.exec(key);
  if(m) return {base:m[1],stamp:m[2]};
  m=/^temp:(\d{4}-\d\d-\d\d \d\d:\d\d)(?::\d\d)? — (.*)$/.exec(key);
  if(m) return {base:m[2],stamp:m[1]};
  return {base:key.slice(TEMP_PREFIX.length),stamp:''};
}
// Какие temp-копии стереть после записи newKey: прежние копии того же патча (остаётся последняя правка; у «untitled» копии
// не связаны между собой) и самые старые сверх max. newKey не стирается никогда.
function tempPrune(keys,newKey,max){
  const nb=tempParse(newKey)?.base, drop=new Set();
  const temps=[...new Set([...keys,newKey])].filter(k=>tempParse(k));
  if(nb && nb!=='untitled') for(const k of temps) if(k!==newKey && tempParse(k).base===nb) drop.add(k);
  const left=temps.filter(k=>!drop.has(k)&&k!==newKey).sort((a,b)=>tempParse(a).stamp.localeCompare(tempParse(b).stamp)||a.localeCompare(b));
  while(left.length+1>(max||TEMP_MAX)) drop.add(left.shift());
  return [...drop];
}

// Избранные пресеты (звезда в списке; в приложении Android первые становятся ярлыками при долгом нажатии на иконку).
// Список имён: новая звезда — в начало, повторное нажатие снимает; без дублей, не длиннее max.
function favToggle(list,name,max){
  const l=(Array.isArray(list) ? list : []).filter(x=>typeof x==='string' && x);
  const i=l.indexOf(name);
  if(i>=0){ l.splice(i,1); return l; }
  l.unshift(name);
  return l.slice(0,max||50);
}
// Убрать из списка то, чего больше нет (удалённый патч), и повторы; exists(имя) → есть ли такой патч.
function favClean(list,exists){
  const seen=new Set();
  return (Array.isArray(list) ? list : []).filter(n=>typeof n==='string' && n && exists(n) && !seen.has(n) && (seen.add(n),true));
}
