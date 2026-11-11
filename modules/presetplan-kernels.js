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
