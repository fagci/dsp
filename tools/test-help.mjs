// Справка: нечёткий поиск, markdown, разбор README и help/*.md, поиск, карточка модуля, «где встречается» (modules/help-kernels.js).
// Проверка: node tools/test-help.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=p=>fs.readFileSync(path.join(root,p),'utf8');
const ctx=vm.createContext({Math,Object,Array,Set,Map,Number,String,JSON,RegExp});
vm.runInContext(rd('modules/help-kernels.js')+';globalThis.K={fzTokens,fzDist,fzWord,fzScoreWords,hlpMd,hlpSlug,hlpSections,hlpBullets,hlpToc,hlpResolve,hlpModCard,hlpUsage,hlpSearch,hlpSentences,hlpSummary};',ctx);
const K=ctx.K, J=x=>JSON.stringify(x);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const eq=(a,b,m)=>ok(J(a)===J(b),m+' (получено '+J(a)+', ждали '+J(b)+')');
const score=(q,t)=>K.fzScoreWords(K.fzTokens(q),K.fzTokens(t),K.fzTokens(t).join(' '));

// нечёткий поиск
ok(score('graph','Graph View')>0,'точное слово');
ok(score('grph','Graph View')>0,'пропуск буквы');
ok(score('grpah','Graph View')>0,'перестановка соседних');
ok(score('gph','Graph View')>0,'сокращение — буквы по порядку');
ok(score('spectrm','Spectrum Analyzer')>0,'опечатка в длинном слове');
ok(score('xyzq','Graph View')===0,'мусор не находится');
ok(score('ab','Graph View')===0,'короткое слово — только точно');
ok(score('graph','Graph View')>score('grph','Graph View'),'точное выше нечёткого');
ok(score('graph view','Graph View')>0 && score('graph zzz','Graph View')===0,'все слова обязательны');
ok(score('граф','Граф связей')>0 && score('грфа','Граф связей')>0,'кириллица');
eq(K.fzDist('kitten','sitting',3),3,'расстояние');
eq(K.fzDist('abcd','abdc',1),1,'перестановка — одна правка');

// markdown
let h=K.hlpMd('# Title\n\nA **bold** and `co<de>` and [x](a.md) and [bad](javascript:alert(1)).\n\n- one\n  - two\n- three\n\n1. a\n2. b\n\n| A | B |\n|---|---|\n| 1 | `x\\|y` |\n\n```\n<b>raw</b>\n```\n> quote');
ok(h.includes('<h1 id="title">Title</h1>'),'заголовок с якорем');
ok(h.includes('<b>bold</b>') && h.includes('<code>co&lt;de&gt;</code>'),'жирный и код с экранированием');
ok(h.includes('<a href="a.md" data-href="a.md">x</a>'),'ссылка');
ok(!h.includes('javascript:'),'опасная ссылка убрана');
ok(h.includes('<ul><li>one<ul><li>two</li></ul></li><li>three</li></ul>'),'вложенный список: '+h);
ok(h.includes('<ol><li>a</li><li>b</li></ol>'),'нумерованный список');
ok(h.includes('<table>') && h.includes('<th>A</th>') && h.includes('<td>1</td>'),'таблица');
ok(h.includes('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>'),'блок кода без разметки');
ok(h.includes('<blockquote>'),'цитата');
ok(!/<script/i.test(K.hlpMd('<script>alert(1)</script>')),'HTML экранируется');

// разделы и пункты README
const sec=K.hlpSections('# A\ntext\n```\n# not a heading\n```\n## B\nbody\n## B\nagain');
eq(sec.map(s=>s.id),['a','b','b-1'],'разделы, повторный заголовок — суффикс; код не заголовок');
const bl=K.hlpBullets('- **Graph** (Output): a graph\n  - sub line\n- **Table**: rows\n```\n- **Fake** x\n```');
eq([...bl.keys()],['graph','table'],'пункты с жирным именем, код пропущен');
ok(bl.get('graph')[0].includes('sub line'),'вложенное идёт с пунктом');
const real=rd('README.md'), rs=K.hlpSections(real), rb=K.hlpBullets(real);
ok(rs.length>50 && rs.some(s=>s.id==='table'),'в README есть раздел Table ('+rs.length+' разделов)');
ok(rb.has('graph') && rb.has('entity card'),'в README есть пункты Graph и Entity Card ('+rb.size+' пунктов)');

// справка help/*.md
const toc=K.hlpToc(rd('help/README.md'));
ok(toc.length>=8,'оглавление справки читается ('+toc.length+')');
for(const t of toc){
  if(t.file==='modules.md' && !fs.existsSync(path.join(root,'help',t.file))) continue;   // создаётся tools/gen-modref.mjs
  ok(fs.existsSync(path.join(root,'help',t.file)),'страница из оглавления существует: '+t.file);
}
// все локальные ссылки страниц указывают на существующие файлы
for(const f of fs.readdirSync(path.join(root,'help')).filter(x=>x.endsWith('.md'))){
  const md=rd('help/'+f);
  for(const m of md.matchAll(/\]\(([^)\s]+)\)/g)){
    const href=m[1]; if(/^(https?:|mailto:|#)/.test(href)) continue;
    const p=K.hlpResolve('help/'+f,href);
    ok(fs.existsSync(path.join(root,p)),'help/'+f+': ссылка '+href+' → '+p);
  }
}
eq(K.hlpResolve('help/data.md','../README.md#table'),'README.md','относительный путь вверх');
eq(K.hlpResolve('help/data.md','run.md'),'help/run.md','сосед');

// карточка и «где встречается»
const card=K.hlpModCard({id:'x',title:'X',cat:'Output',ins:[{n:'a',t:'sig',tip:'t'}],outs:[],params:[{n:'p',t:'select',opts:['a','b'],d:'a'},{n:'go',t:'button',label:'Go'}]});
eq(card.params.length,1,'кнопки не попадают в параметры'); eq(card.buttons,['Go'],'кнопки отдельно');
eq(K.hlpModCard({id:'d',ins:()=>[]}).dynamic,true,'динамические порты помечены');
const use=K.hlpUsage({'P1':"addNode('graphview',1,2,{});addNode('table',3,4)",'P2':"addNode('graphview',0,0)"});
eq(use.get('graphview'),['P1','P2'],'модуль → пресеты'); eq(use.get('table'),['P1'],'один пресет');

// поиск
const E=[{kind:'topic',key:'wires',title:'Wires and port types',text:'connect pins'},{kind:'module',key:'graphview',title:'Graph',text:'network links'},
         {kind:'manual',key:'table',title:'Table',text:'rows of records; graph input'},{kind:'preset',key:'P',title:'Network: Scan the LAN',text:''}];
eq(K.hlpSearch(E,'graph').map(e=>e.key),['graphview','table'],'название выше текста');
eq(K.hlpSearch(E,'grph')[0].key,'graphview','нечёткий поиск по названию');
eq(K.hlpSearch(E,'wire')[0].key,'wires','начало слова');
eq(K.hlpSearch(E,'zzzz'),[],'пусто');
eq(K.hlpSearch(E,'scan lan')[0].key,'P','несколько слов');

// длинный текст — по предложениям
eq(K.hlpSentences('One thing. Two things, e.g. this. Three **bold** here. (Four) done.'),['One thing.','Two things, e.g. this.','Three **bold** here.','(Four) done.'],'предложения, «e.g.» не режет');
const sm=K.hlpSummary('A one. B two. C three. D four. E five.',13,2);
eq(sm.head,'A one. B two.','резюме — первые предложения до порога'); eq(sm.rest,['C three. D four.','E five.'],'остаток — абзацами');
eq(K.hlpSummary('Short.',280,3),{head:'Short.',rest:[]},'короткий текст без остатка');
if(bad){ console.error(bad+' failed'); process.exit(1); }
console.log('help ok');
