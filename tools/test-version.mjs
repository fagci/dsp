// версия (хэш содержимого) в sw.js и index.html совпадает с актуальной, все модули из L есть в SHELL
// при расхождении: node tools/stamp.mjs
import fs from 'fs';
import { spawnSync } from 'child_process';
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const c=/const CACHE='dsp-shell-v(\w+)'/.exec(sw)?.[1];
const v=/const V='(\w+)'/.exec(html)?.[1];
const css=/styles\.css\?v=(\w+)/.exec(html)?.[1];
let bad=0;
const check=(name,ok)=>{ console.log((ok?'ok   ':'FAIL ')+name); if(!ok) bad++; };
check(`sw CACHE (${c}) = index V (${v})`, c&&c===v);
check(`styles.css ?v (${css}) = index V (${v})`, css&&css===v);
const st=spawnSync(process.execPath,[new URL('./stamp.mjs',import.meta.url).pathname,'--check'],{encoding:'utf8'});
check('version = hash of current files'+(st.status?` (${st.stderr.trim()})`:''), st.status===0);
const L=JSON.parse('['+/L=\[([^\]]*)\]/.exec(html)[1]+']');
const shell=sw.slice(sw.indexOf('const SHELL=['));
const missing=L.filter(f=>!shell.includes(`'./${f}?v='+V`));
check('every module of L is in SHELL'+(missing.length?` (missing: ${missing.join(', ')})`:''), !missing.length);
console.log(bad?'FAILED':'all ok');
process.exit(bad?1:0);
