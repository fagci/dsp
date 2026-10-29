// Graph: стрелки рёбер, цвет группы, форма узла (картинка / значок), параметры раскладки vis-network (modules/graphview-kernels.js).
// Проверка: node tools/test-graphview.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Object,Array,Set,Map,Number,String,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/graphview-kernels.js'),'utf8')+';globalThis.K={gvArrowsSpec,gvGroupColor,gvIsGlyph,gvNodeShape,gvNetOpts,GV_SOLVERS,GV_SMOOTH};',ctx);
const K=ctx.K, J=x=>JSON.stringify(x);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const eq=(a,b,m)=>ok(J(a)===J(b),m+' (получено '+J(a)+', ждали '+J(b)+')');

// стрелки
eq(K.gvArrowsSpec('',false),undefined,'пусто, общий флаг выключен — undefined');
eq(K.gvArrowsSpec('',true),{to:{enabled:true}},'пусто, общий флаг — to');
eq(K.gvArrowsSpec('to'),{to:{enabled:true}},'to');
eq(K.gvArrowsSpec('<-'),{from:{enabled:true}},'<-');
eq(K.gvArrowsSpec('both'),{to:{enabled:true},from:{enabled:true}},'both');
eq(K.gvArrowsSpec('to:circle,from:bar'),{to:{enabled:true,type:'circle'},from:{enabled:true,type:'bar'}},'разные концы');
eq(K.gvArrowsSpec('middle:diamond'),{middle:{enabled:true,type:'diamond'}},'middle');
eq(K.gvArrowsSpec('<->'),{to:{enabled:true},from:{enabled:true}},'<->');
eq(K.gvArrowsSpec('to:nope'),{to:{enabled:true}},'неизвестный тип — обычная стрелка');
eq(K.gvArrowsSpec('none',true),{to:{enabled:false},from:{enabled:false},middle:{enabled:false}},'none гасит общий флаг');
eq(K.gvArrowsSpec('чепуха',false),undefined,'мусор — undefined');

// группы
ok(/^#[0-9a-f]{6}$/.test(K.gvGroupColor('ap')),'цвет группы — #rrggbb');
eq(K.gvGroupColor('ap'),K.gvGroupColor('ap'),'цвет группы стабилен');
ok(K.gvGroupColor('ap')!==K.gvGroupColor('station'),'разные группы — разные цвета');

// значок и форма
ok(K.gvIsGlyph('📶') && K.gvIsGlyph('★') && K.gvIsGlyph('Ж'),'символы — значки');
ok(!K.gvIsGlyph('antenna') && !K.gvIsGlyph('') && !K.gvIsGlyph('A1'),'имя значка карты — не символ');
const SH=new Set(['dot','star','image','circularImage','icon']);
eq(K.gvNodeShape({},SH),'dot','без всего — точка');
eq(K.gvNodeShape({shape:'star'},SH),'star','явная форма');
eq(K.gvNodeShape({image:'a.png'},SH),'circularImage','картинка без shape — круглая');
eq(K.gvNodeShape({shape:'image',image:'a.png'},SH),'image','shape=image');
eq(K.gvNodeShape({shape:'image'},SH),'dot','image без адреса — точка');
eq(K.gvNodeShape({glyph:'📶'},SH),'icon','значок без shape — icon');
eq(K.gvNodeShape({shape:'icon'},SH),'dot','icon без символа — точка');
eq(K.gvNodeShape({shape:'bogus',glyph:'★'},SH),'icon','неизвестная форма — по значку');

// раскладка
let o=K.gvNetOpts({});
eq(o.layout,{hierarchical:false},'по умолчанию — свободная раскладка');
eq(o.physics.solver,'forceAtlas2Based','решатель по умолчанию');
eq(o.edges.smooth,false,'рёбра прямые');
o=K.gvNetOpts({layout:'LR',levelSep:200,nodeSpacing:10,solver:'barnesHut',smooth:'curvedCW'});
eq(o.layout.hierarchical,{enabled:true,direction:'LR',sortMethod:'directed',levelSeparation:200,nodeSpacing:20},'дерево слева направо (зазоры не меньше минимума)');
eq(o.physics.solver,'hierarchicalRepulsion','у дерева — hierarchicalRepulsion');
eq(o.edges.smooth,{enabled:true,type:'curvedCW',roundness:.4},'изгиб рёбер');
eq(K.gvNetOpts({layout:'UD',sort:'hubsize'}).layout.hierarchical.sortMethod,'hubsize','sort hubsize');
eq(K.gvNetOpts({solver:'repulsion'}).physics.solver,'repulsion','выбранный решатель');
eq(K.gvNetOpts({solver:'мусор'}).physics.solver,'forceAtlas2Based','неизвестный решатель — по умолчанию');
eq(K.gvNetOpts({physics:false}).physics.enabled,false,'физика выключена');
eq(K.gvNetOpts({layout:'мусор'}).layout,{hierarchical:false},'неизвестная раскладка — свободная');

if(bad){ console.error(bad+' failed'); process.exit(1); }
console.log('graphview ok');
