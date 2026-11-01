// Модули не должны присваивать n.x / n.y: это координаты узла на холсте. Буфер состояния в n.x ломал провода (NaN в path) и сохранение.
import fs from 'fs';
const dir=new URL('../modules/',import.meta.url);
let bad=0;
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.js'))){
  fs.readFileSync(new URL(f,dir),'utf8').split('\n').forEach((l,i)=>{
    const code=l.replace(/\/\/.*$/,'');
    if(/\bn\.(x|y|el|id|type|ports|lod)\s*(=(?!=)|\+=|-=)/.test(code) && !/studio-playlist/.test(f)){ bad++; console.log(`FAIL modules/${f}:${i+1}: ${l.trim().slice(0,100)}`); }
  });
}
console.log(bad?'FAILED':'ok   no module writes n.x / n.y / n.el / n.id / n.type / n.ports / n.lod');
process.exit(bad?1:0);
