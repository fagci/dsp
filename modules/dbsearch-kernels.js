"use strict";
/* ============================ Table как база данных: умный поиск (без DOM) ============================
   Слово запроса сравнивается со словами полей без учёта регистра, «ё» = «е», без диакритики и с латинской «раскладкой»
   (имя набрано в другой раскладке: «ghbdtn» ↔ «привет»). ФИО — по словам в любом порядке («петров анна» найдёт «Анна Петрова»,
   слова — с начала). Номер телефона: из запроса берутся цифры (от 4), и они ищутся в цифрах полей-телефонов где угодно
   («4567», «916 123», «+7 (916) 123-45-67», «8916…» — одно и то же); «полем-телефоном» считается колонка типа phone или с именем
   phone / tel / mobile / тел / моб / gsm / msisdn. Остальные колонки с числами (частоты и т.п.) этим правилом не затрагиваются.
   Проверяется tools/test-dbsearch.mjs. */

const DB_PHONE_COL=/(^|[^a-z])(phone|phones|tel|mobile|cell|gsm|msisdn|fax)([^a-z]|$)|тел|моб|факс/i;
const DB_LAYOUT={q:'й',w:'ц',e:'у',r:'к',t:'е',y:'н',u:'г',i:'ш',o:'щ',p:'з','[':'х',']':'ъ',a:'ф',s:'ы',d:'в',f:'а',g:'п',h:'р',j:'о',k:'л',l:'д',';':'ж',"'":'э',z:'я',x:'ч',c:'с',v:'м',b:'и',n:'т',m:'ь',',':'б','.':'ю','`':'ё'};

// сворачивание: регистр, ё→е, диакритика (é→e), ъ/ь остаются
function dbFold(s){
  s=String(s==null?'':s).toLowerCase().replace(/ё/g,'е');
  try{ s=s.normalize('NFD').replace(/[̀-ͯ]/g,''); }catch(e){ /* без normalize — как есть */ }
  return s;
}
// латиница → русская раскладка (для «ghbdtn»); только если слово целиком из клавиш раскладки
function dbLayout(w){
  if(!/^[a-z\[\];',.`]+$/.test(w)) return '';
  let o=''; for(const ch of w){ const r=DB_LAYOUT[ch]; if(!r) return ''; o+=r; }
  return o;
}
const dbWords=v=>dbFold(v).split(/[^0-9a-zа-яa-zЀ-ӿ@+_.-]+|(?<![0-9])[._-](?![0-9])/).filter(Boolean);
const dbDigits=v=>String(v==null?'':v).replace(/\D/g,'');
// цифры телефона к общему виду: 8XXXXXXXXXX (11) → 7XXXXXXXXXX; 00… убирается
function dbPhoneDigits(v){
  let d=dbDigits(v); if(d.startsWith('00')) d=d.slice(2);
  if(d.length===11 && d[0]==='8') d='7'+d.slice(1);
  return d;
}
const dbIsPhoneCol=name=>DB_PHONE_COL.test(String(name||''));

// запрос из одного слова: {kind:'phone', digits} (≥4 цифр, остальное — разделители телефона) | {kind:'text', alts:[свёрнутое, раскладка?], part} (part — цифры короткого куска номера)
function dbTerm(raw){
  const s=String(raw||'').trim(); if(!s) return null;
  const d=dbPhoneDigits(s);
  if(d.length>=4 && /^[+\d\s().-]+$/.test(s)) return {kind:'phone',digits:d};
  const f=dbFold(s), alts=[f], lay=dbLayout(f); if(lay) alts.push(lay);
  const part=/^[+\d().-]+$/.test(s) && d.length>=1 ? d : '';              // «916», «(916)», «+7» — кусок номера: в колонках-телефонах ищется в цифрах где угодно
  return {kind:'text',alts,part};
}
// совпадает ли значение поля с термом; col — имя колонки (для правила телефона)
function dbMatch(term,value,col,isPhoneCol){
  if(!term) return false;
  if(term.kind==='phone'){
    const phoneCol=isPhoneCol ? isPhoneCol(col) : dbIsPhoneCol(col);
    if(phoneCol){ for(const part of String(value==null?'':value).split('|')){ const d=dbPhoneDigits(part); if(d.length>=4 && (d.includes(term.digits) || term.digits.includes(d) && d.length>=7)) return true; } return false; }
    // не телефонная колонка: цифры как слово (частота 145.5 и т.п.), как раньше — с начала слова
    const f=dbFold(value); return f.startsWith(term.digits) || dbWords(value).some(w=>w.startsWith(term.digits));
  }
  if(term.part){ const phoneCol=isPhoneCol ? isPhoneCol(col) : dbIsPhoneCol(col); if(phoneCol){ for(const p of String(value==null?'':value).split('|')) if(dbPhoneDigits(p).includes(term.part)) return true; return false; } }
  const ws=dbWords(value);
  return term.alts.some(a=>ws.some(w=>w.startsWith(a)) || dbFold(value).startsWith(a));
}

