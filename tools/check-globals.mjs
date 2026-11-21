// Сравнение top-level имён новых файлов с остальными классическими скриптами:
// одинаковое const/function в двух файлах — SyntaxError при загрузке страницы.
// node tools/check-globals.mjs modules/new-kernels.js modules/new.js
import fs from 'node:fs';
import path from 'node:path';

const root=path.join(path.dirname(new URL(import.meta.url).pathname),'..');
const args=process.argv.slice(2);
if(!args.length){
  console.error('usage: node tools/check-globals.mjs <js files...>');
  process.exit(2);
}
const namesOf=s=>{
  const out=new Map();
  for(const m of s.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) out.set(m[1],(out.get(m[1])||0)+1);
  return out;
};
const files=args.map(f=>path.resolve(root,f));
const own=new Set(files.map(f=>path.basename(f)));
const target=new Map();
for(const f of files){
  let s;
  try{ s=fs.readFileSync(f,'utf8'); }
  catch(e){ console.error('cannot read '+f+': '+e.message); process.exit(2); }
  for(const [k,n] of namesOf(s)) target.set(k,(target.get(k)||0)+n);
}
const bad=[];
for(const [k,n] of target) if(n>1) bad.push([k,'(два раза в новых файлах)']);
const scan=fs.readdirSync(path.join(root,'modules')).filter(f=>f.endsWith('.js') && !own.has(f)).map(f=>'modules/'+f)
  .concat(fs.readdirSync(root).filter(f=>/^core-.*\.js$/.test(f) || f==='presets.js'));
for(const rel of scan){
  let s;
  try{ s=fs.readFileSync(path.join(root,rel),'utf8'); }
  catch(e){ continue; }
  for(const [k] of namesOf(s)) if(target.has(k)) bad.push([k,rel]);
}
if(bad.length){
  for(const [k,where] of bad) console.log(k+'  ←  '+where);
  console.log(bad.length+' collision(s)');
  process.exit(1);
}
console.log('ok: '+target.size+' top-level names, no collisions');
