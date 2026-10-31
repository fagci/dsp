"use strict";
/* Какие встроенные пресеты пересобирать при запуске. Пересборка — это построение живого графа и сериализация, около 30 мс на пресет:
   все ~700 разом — десятки секунд на телефоне (экран загрузки «висит»). Поэтому пересобираются только пресеты, у которых изменился
   код построения (хэш исходника функции) или которых нет, а полностью — когда поднят PRESET_VER (изменились дефолты модулей, формат).
   Без DOM — tools/test-presetplan.mjs */

// короткий хэш исходника функции-строителя (djb2) + длина
function presetHash(fn){
  const s=String(fn); let h=5381;
  for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0;
  return (h>>>0).toString(36)+'.'+s.length.toString(36);
}

// presets — {имя: строитель}; stored — сохранённые патчи {имя: …}; hashes — {имя: хэш} с прошлой сборки; ver / cur — сохранённая и текущая PRESET_VER
// → {todo: имена к пересборке, hashes: хэши тех, что остаются как есть, full: полная ли пересборка}
function presetPlan(presets,stored,hashes,ver,cur){
  const full=ver<cur, todo=[], keep={};
  for(const name of Object.keys(presets)){
    const h=presetHash(presets[name]);
    if(full || !stored[name] || (hashes||{})[name]!==h) todo.push(name);
    else keep[name]=h;
  }
  return {todo, hashes:keep, full};
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
