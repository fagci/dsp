// версия кэша sw.js, const V и ссылка на styles.css в index.html должны совпадать
import fs from 'fs';
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const c=/const CACHE='dsp-shell-v(\d+)'/.exec(sw)?.[1];
const v=/const V='(\d+)'/.exec(html)?.[1];
const css=/styles\.css\?v=(\d+)/.exec(html)?.[1];
let bad=0;
const check=(name,ok)=>{ console.log((ok?'ok   ':'FAIL ')+name); if(!ok) bad++; };
check(`sw CACHE (${c}) = index V (${v})`, c&&c===v);
check(`styles.css ?v (${css}) = index V (${v})`, css&&css===v);
console.log(bad?'FAILED':'all ok');
process.exit(bad?1:0);
