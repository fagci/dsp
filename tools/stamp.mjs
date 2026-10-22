// Версия приложения = хэш содержимого файлов оболочки (список SHELL в sw.js).
// node tools/stamp.mjs          — пересчитать и прописать в sw.js (CACHE) и index.html (V, styles.css?v=)
// node tools/stamp.mjs --check  — только проверить, код возврата 1 при расхождении
import fs from 'fs';
import crypto from 'crypto';
const root=new URL('../',import.meta.url);
const rd=p=>fs.readFileSync(new URL(p,root));
const swRe=/(const CACHE='dsp-shell-v)\w*(')/, vRe=/(const V=')\w*(')/, cssRe=/(styles\.css\?v=)\w*(")/, hRe=/^const H=\{.*\};$/m;

let sw=rd('sw.js').toString(), html=rd('index.html').toString();
const shell=sw.slice(sw.indexOf('const SHELL=['),sw.indexOf('];',sw.indexOf('const SHELL=[')));
const files=[...new Set([...shell.matchAll(/'\.\/([^'?]+)/g)].map(m=>m[1]))].sort();

// хэши отдельных файлов — по ним сервис-воркер понимает, что файл не менялся (index.html и сам sw.js не в счёте)
const fh={};
for(const f of files) if(f!=='index.html' && f!=='') fh[f]=crypto.createHash('sha256').update(rd(f)).digest('hex').slice(0,12);
const hLine='const H='+JSON.stringify(fh)+';';
const h=crypto.createHash('sha256');
for(const f of files){
  let b=rd(f);
  if(f==='sw.js') b=sw.replace(swRe,'$1$2').replace(hRe,'');
  if(f==='index.html') b=html.replace(vRe,'$1$2').replace(cssRe,'$1$2');
  h.update(f+'\0'); h.update(b); h.update('\0');
}
// сам sw.js в SHELL не входит, но его правка тоже меняет версию
h.update('sw.js\0'); h.update(sw.replace(swRe,'$1$2').replace(hRe,''));
const ver=h.digest('hex').slice(0,8);

const nsw=sw.replace(swRe,`$1${ver}$2`).replace(hRe,()=>hLine);
const nhtml=html.replace(vRe,`$1${ver}$2`).replace(cssRe,`$1${ver}$2`);
if(process.argv.includes('--check')){
  if(nsw!==sw || nhtml!==html){ console.error(`stale version stamp, expected ${ver} — run: node tools/stamp.mjs`); process.exit(1); }
  console.log('stamp ok '+ver);
}else{
  fs.writeFileSync(new URL('sw.js',root),nsw);
  fs.writeFileSync(new URL('index.html',root),nhtml);
  console.log('stamped '+ver);
}
