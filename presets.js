/* ---- пресеты ---- */
// Загружается раньше core-graph.js, поэтому serialize/deserialize/autoLayout/stat
// используются только внутри обработчиков и вызываются уже после их определения.
const PKEY='dsp-presets', AKEY='dsp-autosave', VKEY='dsp-presets-ver', PRESET_VER=26;
const LS={ get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
set(k,v){ try{ localStorage.setItem(k,v); }catch(e){ stat.textContent='хранилище недоступно'; } } };
const patchListEl=document.getElementById('patchList');
const patchSearchEl=document.getElementById('patchSearch');
const readP=()=>{ try{ return JSON.parse(LS.get(PKEY))||{}; }catch(e){ return {}; } };
const writeP=o=>LS.set(PKEY,JSON.stringify(o));
let currentPatchName='', patchQuery='';
const openPatchCats=new Set(['own','temp']);          // свои патчи и temp раскрыты сразу, встроенные — свёрнуты
const TEMP_PREFIX='temp:', TEMP_MAX=5;
// Вместо "несохранённое пропадёт" — тихо откладываем текущий граф в раздел temp и едем дальше.
function stashIfDirty(){
if(!graphDirty || !Graph.nodes.length) return;
const p=readP();
const ts=new Date().toISOString().slice(0,19).replace('T',' ');
const key=TEMP_PREFIX+ts+' — '+(currentPatchName||'без имени');
p[key]=serialize();
const temps=Object.keys(p).filter(k=>k.startsWith(TEMP_PREFIX)).sort();
while(temps.length>TEMP_MAX) delete p[temps.shift()];
writeP(p);
}
function makePatchItem(name,count){
const b=document.createElement('button'); b.className='pitem'+(name===currentPatchName?' on':'');
b.innerHTML= `<span class="ptxt"><b>${name}</b><i>${count} узлов</i></span><span class="pdel" title="Удалить патч">✕</span>` ;
const doDelete=e=>{ e.preventDefault(); e.stopPropagation();
if(confirm('Удалить патч «'+name+'»?')){ const p=readP(); delete p[name]; writeP(p);
if(currentPatchName===name) currentPatchName='';
buildPatchList(); stat.textContent='патч удалён'; } };
b.addEventListener('click',e=>{ if(e.target.closest('.pdel')) return; openPatch(name); });
b.querySelector('.pdel').addEventListener('click',doDelete);      // тап/клик по крестику — работает и на мобиле
b.addEventListener('contextmenu',doDelete);                       // на десктопе правый клик — тоже как раньше
return b;
}
function makePatchDetails(key,label,open){
const det=document.createElement('details'); det.className='pcat'; det.open=open;
det.addEventListener('toggle',()=>{ det.open?openPatchCats.add(key):openPatchCats.delete(key); });
const sum=document.createElement('summary'); sum.textContent=label;
det.append(sum);
return det;
}
function buildPatchList(){
patchListEl.innerHTML='';
const p=readP();
const q=patchQuery.trim().toLocaleLowerCase('ru');
const match=name=>!q || name.toLocaleLowerCase('ru').includes(q);
const custom=Object.keys(p).filter(k=>!(k in PRESETS) &&match(k));
const temp=custom.filter(k=>k.startsWith(TEMP_PREFIX)).sort().reverse();     // новые сверху
const own=custom.filter(k=>!k.startsWith(TEMP_PREFIX)).sort();
const builtin=Object.keys(p).filter(k=>(k in PRESETS) &&match(k));
let matches=0;
const addGroup=(key,label,keys)=>{
if(!keys.length) return;
const det=makePatchDetails(key,label,q?true:openPatchCats.has(key));
det.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="cnt">${keys.length}</span>` );
for(const name of keys){ matches++; det.append(makePatchItem(name,p[name].nodes.length)); }
patchListEl.append(det);
};
addGroup('temp','TEMP (автосохранение)',temp);
addGroup('own','СВОИ',own);
const byCat={};                                       // встроенные — по категориям, не одним списком
for(const name of builtin){ const cat=PRESET_CATS[name]||'Разное'; (byCat[cat]||(byCat[cat]=[])).push(name); }
for(const cat of PRESET_CAT_ORDER) if(byCat[cat]) addGroup('builtin:'+cat, cat, byCat[cat].sort());
for(const cat of Object.keys(byCat).sort())            // категории вне PRESET_CAT_ORDER — в конец списком
if(!PRESET_CAT_ORDER.includes(cat)) addGroup('builtin:'+cat, cat, byCat[cat].sort());
patchListEl.classList.toggle('empty',matches===0);
}
function openPatch(name){
stashIfDirty();
const p=readP(); if(!p[name]) return;
deserialize(p[name]); currentPatchName=name; graphDirty=false;
stat.textContent='открыт: '+name;
buildPatchList(); closeSide();
}
document.getElementById('psave').onclick=()=>{
const name=prompt('Имя патча',currentPatchName||'патч '+new Date().toLocaleString('ru'));
if(!name) return;
const p=readP(); p[name]=serialize(); writeP(p);
currentPatchName=name; graphDirty=false;
stat.textContent='патч сохранён: '+name;
buildPatchList();
};
patchSearchEl.addEventListener('input',e=>{ patchQuery=e.target.value; buildPatchList(); });
document.getElementById('patchClear').addEventListener('click',()=>{
patchSearchEl.value=''; patchQuery=''; buildPatchList(); patchSearchEl.focus(); });
// Строит недостающие/устаревшие встроенные пресеты и обновляет версию хранилища.
// Сами пресеты регистрируются ниже через preset(имя, функция-строитель), см. PRESETS.
function buildBuiltinPresets(){
const p=readP(), ver=+(LS.get(VKEY)||0);
for(const [name,fn] of Object.entries(PRESETS)){
if(ver <PRESET_VER || !p[name]){
try{ fn(); autoLayout(); p[name]=serialize(); }
catch(err){ console.error('пресет  "'+name+' " не построился:',err); }
}
}
writeP(p); LS.set(VKEY,String(PRESET_VER)); buildPatchList();
}
/* ---- реестр встроенных пресетов ---- */
// preset(имя, функция) — по аналогии с def(...) у модулей: функция просто строит граф
// узлов (addNode/addEdge), как будто пользователь собрал его вручную.
/* ---- категории встроенных пресетов ---- */
// имя пресета → категория; используется только для группировки списка,
// сам preset(имя, функция) ничего о категориях не знает.
const PRESET_CAT_ORDER=['Демо','Быстрые сценарии','Секвенсоры и аранжировка','Синтез и техно',
                         'Радиопротоколы','Фаза и квадратура','Массивы микрофонов','Анализ сигналов'];
const PRESET_CATS={
  'Демо: свип и водопад':'Демо',

  'Быстрая запись звука':'Быстрые сценарии',
  'Поиск источника звука (по частоте)':'Быстрые сценарии',
  'КВ: быстрое декодирование всех протоколов':'Быстрые сценарии',
  'Морзе с камеры':'Быстрые сценарии',
  'Быстрый шумомер':'Быстрые сценарии',
  'Быстрая проверка тракта':'Быстрые сценарии',

  'Пиано-ролл: длина и велосити':'Секвенсоры и аранжировка',
  'Пиано-ролл: аккорды на 4 голоса':'Секвенсоры и аранжировка',
  'Драм-машина: банки A/B':'Секвенсоры и аранжировка',
  'Синхронизация: мастер-клок':'Секвенсоры и аранжировка',
  'Пиано-ролл: квантование по ладу':'Секвенсоры и аранжировка',
  'Аранжировка: интро → куплет → припев':'Секвенсоры и аранжировка',
  'Микшер на 12 каналов: полный бэнд':'Секвенсоры и аранжировка',

  'Синтезатор: acid-бас (303)':'Синтез и техно',
  'Техно: драм-машина':'Синтез и техно',
  'Техно: генеративный acid':'Синтез и техно',
  'Техно: полный трек':'Синтез и техно',

  'Морзе с микрофона':'Радиопротоколы',
  'RTTY: передача и приём':'Радиопротоколы',
  'RTTY: приём из эфира':'Радиопротоколы',
  'SSTV / факс: растр':'Радиопротоколы',
  'Разбор протокола растром':'Радиопротоколы',
  'Морзе: кодер + декодер':'Радиопротоколы',
  'HFDL: приёмный тракт (до символов)':'Радиопротоколы',
  'FT8: поиск сигналов в слоте':'Радиопротоколы',
  'Метео-факс WEFAX 120':'Радиопротоколы',
  'Передача WEFAX (демо)':'Радиопротоколы',
  'NOAA APT (АМ-огибающая)':'Радиопротоколы',
  'DTMF':'Радиопротоколы',
  'PSK31 (7035–7040 кГц)':'Радиопротоколы',
  'Feld Hell':'Радиопротоколы',
  'SSB: перенос на ноль':'Радиопротоколы',
  'APRS / AX.25':'Радиопротоколы',
  'APRS: передача и приём (петля)':'Радиопротоколы',
  'DTMF: кодер + декодер':'Радиопротоколы',
  'Olivia: передача и приём (петля)':'Радиопротоколы',
  'Contestia: передача и приём (петля)':'Радиопротоколы',
  'HFDL: обнаружение и кадр':'Радиопротоколы',
  'Чирп-модем: шум и переотражение':'Радиопротоколы',

  'Текст → биты → текст (кодировки)':'Анализ сигналов',
  'OFDM: текст через многочастотную модуляцию':'Радиопротоколы',

  'Два микрофона':'Массивы микрофонов',
  'Пеленгация лучом (2 мик.)':'Массивы микрофонов',
  'TDOA: разность хода (2 мик.)':'Массивы микрофонов',
  'Чирп-радар 2D (2 мик.)':'Массивы микрофонов',

  'Фазоскоп: корреляция и фигуры Лиссажу':'Фаза и квадратура',
  'Гильберт: огибающая и мгновенная частота':'Фаза и квадратура',
  'Сонар: один микрофон, чирп 18–22 кГц':'Фаза и квадратура',
  'Осциллограф с триггером: видна разница фаз':'Фаза и квадратура',

  'Занятость диапазона':'Анализ сигналов',
  'Текст → сигнал → текст':'Анализ сигналов',
  'Вейвлет против БПФ':'Анализ сигналов',
  'Вибрации (акселерометр)':'Анализ сигналов',
  'Захват события':'Анализ сигналов',
  'Обзор диапазона':'Анализ сигналов',
  'Поиск преамбулы':'Анализ сигналов',
  'АЧХ и задержка тракта':'Анализ сигналов',
  'Гармоники и кепстр':'Анализ сигналов',
  'Помехоустойчивый кадр':'Анализ сигналов',
  'Шумомер с журналом':'Анализ сигналов',
  'Разбор записи (офлайн)':'Анализ сигналов',
  'Подавление помехи':'Анализ сигналов',
  'Акустика помещения':'Анализ сигналов',
};
const PRESETS={};
function preset(name,fn){
if(PRESETS[name]) console.warn('дублирующееся имя пресета: '+name);
PRESETS[name]=fn;
if(!(name in PRESET_CATS)) console.warn('у пресета "'+name+'" нет категории — попадёт в «Разное»');
}
/* ---- демо-патч ---- */
function buildDemo(){
clearAll();
const o1=addNode('osc',40,40,{freq:400,amp:.3,wave:'saw'});
const lf=addNode('lfo',40,260,{freq:.3,min:300,max:3000});
const f =addNode('biquad',300,40,{type:'lp',freq:1200,Q:6});
const sc=addNode('scope',560,40);
const ff=addNode('fft',300,300,{size:'2048'});
const wf=addNode('sa',560,300,{fmin:0,fmax:6000,split:.4});
const dc=addNode('dac',820,40,{vol:.25});
const mt=addNode('meter',820,220);
addEdge(o1.id,'out',f.id,'in');
addEdge(lf.id,'out',f.id,'freq');
addEdge(f.id,'out',sc.id,'in1');
addEdge(f.id,'out',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');
addEdge(f.id,'out',dc.id,'L');
addEdge(f.id,'out',mt.id,'in');
markWiresDirty();
}
preset('Демо: свип и водопад', buildDemo);
/* ---- быстрые сценарии ---- */
preset('Быстрая запись звука', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Ловит звук по уровню — не надо жать «запись» точно в момент.\n'+
  'Предзапись/постзапись компенсируют реакцию.\nЭхоподавление/шумодав/АРУ выключены — чтобы не портили запись.'});
nt.size.w=380; nt.size.h=160; applySize(nt);
const m =addNode('mic',40,240,{gainA:1,echo:false,ns:false,agc:false});
const tr=addNode('triggerRecorder',420,40,{mode:'по уровню',threshold:.02,preTime:.5,postTime:1.5,maxDuration:20});
tr.size.w=460; tr.size.h=280; applySize(tr);
const mt=addNode('meter',420,360);
const sc=addNode('scope',900,40,{span:4096,gain:2});
sc.size.w=480; sc.size.h=200; applySize(sc);
addEdge(m.id,'a',tr.id,'in');
addEdge(m.id,'a',mt.id,'in');
addEdge(m.id,'a',sc.id,'in1');
markWiresDirty();
});
preset('Поиск источника звука (по частоте)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Тапни по пику на спектре — маркер 1 встанет туда,\n'+
  'справа появится уровень именно этой частоты во времени.\n'+
  'Двигай микрофон/источник и смотри, где уровень выше — так и находится направление.'});
nt.size.w=420; nt.size.h=160; applySize(nt);
const m =addNode('mic',40,240,{gainA:2});
const ff=addNode('fft',40,440,{size:'4096'});
const sa=addNode('sa',420,40,{fmin:20,fmax:8000,split:.4});
sa.size.w=560; sa.size.h=320; applySize(sa);
const ns=addNode('numsig',420,400,{dc:false,gain:1});
const sc=addNode('scope',420,540,{span:16384,gain:1});
sc.size.w=560; sc.size.h=200; applySize(sc);
const nvF=addNode('numview',1020,40,{digits:0});
const nvL=addNode('numview',1020,200,{digits:3});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(sa.id,'f1',nvF.id,'in');
addEdge(sa.id,'l1',nvL.id,'in');
addEdge(sa.id,'l1',ns.id,'in');
addEdge(ns.id,'out',sc.id,'in1');
markWiresDirty();
});
preset('КВ: быстрое декодирование всех протоколов', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Выход КВ-приёмника — на микрофонный вход.\n'+
  'sigid внизу — эвристический определитель типа сигнала: подскажет, какой\n'+
  'декодер справа вообще имеет смысл смотреть (не гарантия, но экономит время).\n'+
  'Настрой приёмник на диапазон, смотри по спектру, где есть активность.'});
nt.size.w=460; nt.size.h=200; applySize(nt);
const m =addNode('mic',40,280,{gainA:2});
const ff=addNode('fft',40,480,{size:'4096'});
const sa=addNode('sa',460,40,{fmin:100,fmax:3000,split:.4});
sa.size.w=560; sa.size.h=280; applySize(sa);
const si=addNode('sigid',40,640,{fftSize:'8192',period:2});
si.size.w=440; si.size.h=220; applySize(si);
const mo=addNode('morseRx',1080,40,{auto:true,thr:.5,minRun:20});
mo.size.w=340; mo.size.h=160; applySize(mo);
const af=addNode('afskRx',1080,240,{fmin:300,fmax:3000,baudMin:20,baudMax:300});
af.size.w=340; af.size.h=160; applySize(af);
const hd=addNode('ax25Rx',1080,440,{baud:1200,nrzi:true,ax25:true});
hd.size.w=340; hd.size.h=200; applySize(hd);
const dt=addNode('dtmfRx',1080,680);
dt.size.w=340; dt.size.h=120; applySize(dt);
const f8=addNode('ft8Rx',1460,40);
f8.size.w=380; f8.size.h=260; applySize(f8);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',si.id,'in');
addEdge(m.id,'a',mo.id,'sig');
addEdge(m.id,'a',af.id,'in');
addEdge(af.id,'soft',hd.id,'in');
addEdge(m.id,'a',dt.id,'in');
addEdge(m.id,'a',f8.id,'in');
markWiresDirty();
});
preset('Быстрый шумомер', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Быстрая оценка громкости: полоса уровня + LUFS-подобные метрики.\n'+
  '«Сбросить интегральную» в узле громкости — начать замер заново.'});
nt.size.w=380; nt.size.h=140; applySize(nt);
const m =addNode('mic',40,220,{gainA:1});
const mt=addNode('meter',420,40);
const ld=addNode('loud',420,120);
const sc=addNode('scope',420,220,{span:8192,gain:2});
sc.size.w=460; sc.size.h=200; applySize(sc);
addEdge(m.id,'a',mt.id,'in');
addEdge(m.id,'a',ld.id,'in');
addEdge(m.id,'a',sc.id,'in1');
markWiresDirty();
});
preset('Быстрая проверка тракта', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Свип через динамик, микрофон слушает обратно —\n'+
  'быстро видно завалы АЧХ, дребезг, обрывы в тракте.'});
nt.size.w=380; nt.size.h=140; applySize(nt);
const sw=addNode('sweep',40,220,{f0:40,f1:16000,rate:.3,mode:'log',amp:.3});
const dc=addNode('dac',40,420,{vol:.4});
const m =addNode('mic',420,40,{gainA:2});
const ff=addNode('fft',420,240,{size:'4096'});
const sa=addNode('sa',780,40,{fmin:20,fmax:16000,split:.4});
sa.size.w=560; sa.size.h=280; applySize(sa);
const sc=addNode('scope',780,340,{span:4096,gain:2});
sc.size.w=560; sc.size.h=200; applySize(sc);
addEdge(sw.id,'out',dc.id,'L');
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',sc.id,'in1');
markWiresDirty();
});
/* ---- готовые патчи ---- */
preset('Морзе с микрофона', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,300,{size:'2048',win:'blackman'});   // окно 43 мс: короче точки
const wf=addNode('sa',40,460,{fmin:200,fmax:2000,floor:-100,top:-30,tol:60,split:.35});
wf.size.w=620; wf.size.h=320; applySize(wf);
const mo=addNode('morseRx',700,40,{auto:true,thr:.6,minRun:25});
mo.size.w=380; mo.size.h=240; applySize(mo);
const mo2=addNode('morseRx',700,320,{auto:true,thr:.6,minRun:25});
mo2.size.w=380; mo2.size.h=200; applySize(mo2);
const bp=addNode('biquad',360,40,{type:'bp',freq:700,Q:20});
const dc=addNode('dac',360,260,{vol:.3,mode:'моно'});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(wf.id,'l1',mo.id,'level');                // маркер 1 — первый корреспондент
addEdge(wf.id,'l2',mo2.id,'level');               // маркер 2 — второй, параллельно
addEdge(m.id,'a',bp.id,'in');
addEdge(wf.id,'f1',bp.id,'freq');                 // в наушники — тон под маркером 1
addEdge(bp.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Морзе с камеры', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Приём: наведи камеру на мигающий источник\\n'+
  '(например, экран другого устройства с этим же пресетом) —\\n'+
  'рамка на превью камеры — это зона, по которой меряется яркость.\\n\\n'+
  'Передача: впиши текст в «Передача Морзе», жми «Передать»,\\n'+
  'затем «Во весь экран» у экрана-передатчика — он замигает Морзе.'});
nt.size.w=420; nt.size.h=220; applySize(nt);
const c =addNode('cam',40,300,{roi:true,roiX:.4,roiY:.4,roiW:.2,roiH:.2,roiAuto:true});
const g =addNode('thresh',420,300,{thr:.55,hys:.08,hold:0});
const mo=addNode('morseRx',680,300,{auto:true,thr:.5,minRun:30});
mo.size.w=320; mo.size.h=180; applySize(mo);
const tx=addNode('morseTx',420,40,{text:'CQ CQ DE TEST',wpm:12});
const fl=addNode('flash',680,40);
addEdge(c.id,'bright',g.id,'num');
addEdge(g.id,'num',mo.id,'level');
addEdge(tx.id,'key',fl.id,'in');
markWiresDirty();
});
preset('RTTY: передача и приём', function(){
clearAll();
const tx=addNode('serialTx',40,40,{text:'RYRY DE TEST',baud:45.45,loop:true});
const md=addNode('mod',300,40,{mode:'FSK',f0:1275,shift:170,amp:.3});
const nz=addNode('osc',300,300,{wave:'noise',amp:.02});
const mx=addNode('sum',560,40,{ka:1,kb:1});
const ff=addNode('fft',560,200,{size:'4096'});
const wf=addNode('sa',560,340,{fmin:900,fmax:1800,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const dm=addNode('fsk',1060,40,{f0:1275,shift:170,bw:60,center:true});
const rx=addNode('serialRx',1060,300,{baud:45.45,code:'Бодо (RTTY)'});
rx.size.w=320; rx.size.h=200; applySize(rx);
addEdge(tx.id,'bit',md.id,'bit');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',dm.id,'in');
addEdge(wf.id,'f1',dm.id,'f0');                 // маркер 1 = частота настройки
addEdge(dm.id,'fLo',wf.id,'m3'); addEdge(dm.id,'fHi',wf.id,'m4');
addEdge(dm.id,'soft',rx.id,'soft');
markWiresDirty();
});
preset('RTTY: приём из эфира', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',300,40,{size:'8192'});
const wf=addNode('sa',560,40,{fmin:800,fmax:2600,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const dm=addNode('fsk',1140,40,{f0:1275,shift:170,bw:60,center:true});
const rx=addNode('serialRx',1140,320,{baud:45.45,code:'Бодо (RTTY)'});
rx.size.w=360; rx.size.h=260; applySize(rx);
const sc=addNode('scope',1140,540,{span:8192,gain:1});
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',dm.id,'in');
addEdge(wf.id,'f1',dm.id,'f0');
addEdge(dm.id,'fLo',wf.id,'m3'); addEdge(dm.id,'fHi',wf.id,'m4');
addEdge(dm.id,'bLo',wf.id,'bLo'); addEdge(dm.id,'bHi',wf.id,'bHi');
addEdge(dm.id,'soft',rx.id,'soft'); addEdge(dm.id,'soft',sc.id,'in1');
markWiresDirty();
});
preset('SSTV / факс: растр', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'4096'});
const wf=addNode('sa',40,400,{fmin:1000,fmax:2500,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const pk=addNode('peak',340,40,{fmin:1300,fmax:2500,tol:150});
const mp=addNode('sigmap',600,40,{inMin:1500,inMax:2300,outMin:0,outMax:1});
const sy=addNode('sigwin',600,260,{lo:1100,hi:1300,minMs:3});
const pa=addNode('paint',880,40,{std:'Martin M1',lineMs:446.446,width:'960',height:'256',
rgb:true,sync:'по фронту'});
pa.size.w=420; pa.size.h=320; applySize(pa);
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec'); addEdge(ff.id,'spec',pk.id,'spec');
addEdge(pk.id,'freq',mp.id,'in');
addEdge(pk.id,'freq',sy.id,'in');
addEdge(mp.id,'out',pa.id,'level');
addEdge(sy.id,'out',pa.id,'sync');
markWiresDirty();
});
preset('Разбор протокола растром', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',300,40,{size:'4096'});
const wf=addNode('sa',560,40,{fmin:0,fmax:4000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const pk=addNode('peak',300,340,{fmin:900,fmax:2900,tol:150});
const mp=addNode('sigmap',560,340,{inMin:1000,inMax:2800,outMin:0,outMax:1});
const pa=addNode('paint',840,340,{lineMs:500,width:'512',height:'256',sync:'свободно'});
pa.size.w=440; pa.size.h=300; applySize(pa);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec'); addEdge(ff.id,'spec',pk.id,'spec');
addEdge(wf.id,'f1',pk.id,'fc');
addEdge(pk.id,'freq',mp.id,'in'); addEdge(mp.id,'out',pa.id,'level');
markWiresDirty();
});
preset('Морзе: кодер + декодер', function(){
clearAll();
const tx=addNode('morseTx',40,40,{text:'CQ DE R1ABC',wpm:15,loop:true});
const md=addNode('mod',300,40,{mode:'OOK',f0:800,amp:.3,rise:4});
const nz=addNode('osc',300,300,{wave:'noise',amp:.03});
const mx=addNode('sum',560,140);
const ff=addNode('fft',820,140,{size:'2048'});
const pk=addNode('peak',1080,140,{fmin:500,fmax:1200,thr:-55,hold:40,track:true});
const mo=addNode('morseRx',1340,140,{auto:true,thr:.45});
mo.size.w=320; mo.size.h=180; applySize(mo);
const fl=addNode('flash',40,320);
const dac=addNode('dac',560,340,{vol:.2});
addEdge(tx.id,'bit',md.id,'bit');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',pk.id,'spec');
addEdge(pk.id,'level',mo.id,'level');
addEdge(tx.id,'key',fl.id,'in');
addEdge(mx.id,'out',dac.id,'L');
markWiresDirty();
});
preset('HFDL: приёмный тракт (до символов)', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'8192'});
const wf=addNode('sa',40,400,{fmin:300,fmax:3300,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const bp=addNode('biquad',320,40,{type:'bp',freq:1800,Q:1.2});
const co=addNode('costas',580,40,{f0:1800,order:'8PSK',loopHz:5,lp:2500});
const fi=addNode('rrc',840,40,{baud:1800,beta:.35,span:8});
const fq=addNode('rrc',840,260,{baud:1800,beta:.35,span:8});
const ga=addNode('gardner',1100,40,{baud:1800,gain:.02});
const sl=addNode('pskdec',1360,40,{order:'8',diff:true,fmt:'hex'});
sl.size.w=320; sl.size.h=220; applySize(sl);
const cn=addNode('const2',1360,320,{dec:1,scale:3});
cn.size.w=320; cn.size.h=240; applySize(cn);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',bp.id,'in'); addEdge(wf.id,'f1',bp.id,'freq');
addEdge(bp.id,'out',co.id,'in'); addEdge(wf.id,'f1',co.id,'f0');
addEdge(co.id,'I',fi.id,'in'); addEdge(co.id,'Q',fq.id,'in');
addEdge(fi.id,'out',ga.id,'I'); addEdge(fq.id,'out',ga.id,'Q');
addEdge(ga.id,'sI',sl.id,'I'); addEdge(ga.id,'sQ',sl.id,'Q'); addEdge(ga.id,'clk',sl.id,'clk');
addEdge(ga.id,'sI',cn.id,'I'); addEdge(ga.id,'sQ',cn.id,'Q');
markWiresDirty();
});
preset('FT8: поиск сигналов в слоте', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'16384'});
const wf=addNode('sa',40,400,{fmin:200,fmax:2800,floor:-110,top:-30,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const f8=addNode('ft8Rx',600,40,{fmin:200,fmax:2800,top:10,thr:1.6});
f8.size.w=460; f8.size.h=320; applySize(f8);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',f8.id,'in');
addEdge(f8.id,'f',wf.id,'m3');
markWiresDirty();
});
preset('Метео-факс WEFAX 120', function(){
  clearAll();
  const m =addNode('mic',40,40,{gainA:2});
  const ff=addNode('fft',40,240,{size:'8192'});
  const wf=addNode('sa',40,400,{fmin:1000,fmax:2600,split:.4});
  wf.size.w=560; wf.size.h=300; applySize(wf);
  // demod вместо fft+peak: посэмпловый ЧМ-дискриминатор вместо поблочного FFT-пика.
  // peak пересчитывал частоту раз в аудио-блок (~10.6мс при block=512) — это в разы
  // медленнее пикселя WEFAX (~0.28мс при 1810 столбцах / 500мс), картинка размазывалась
  // в блоки по ~38 столбцов независимо от подбора fmin/fmax/tol.
  const dm=addNode('demod',340,40,{mode:'FM',freq:1900,bw:800,gain:1});
  const mp=addNode('sigmap',600,40,{inMin:-1,inMax:1,outMin:0,outMax:1});
  const pa=addNode('paint',880,40,{std:'WEFAX 120 lpm IOC576',lineMs:500,width:'1810',
  height:'600',sync:'свободно',palette:'серый'});
  pa.size.w=620; pa.size.h=420; applySize(pa);
  addEdge(m.id,'a',ff.id,'in');
  addEdge(ff.id,'spec',wf.id,'spec');   // водопад — только для визуальной настройки, на демод не влияет
  addEdge(m.id,'a',dm.id,'in');
  addEdge(dm.id,'out',mp.id,'in');
  addEdge(mp.id,'out',pa.id,'level');
  markWiresDirty();
});
preset('Передача WEFAX (демо)', function(){
  clearAll();
  const v =addNode('vidsrc',40,40,{});                 // картинку задать через URL/файл в самом узле
  const tx=addNode('paintTx',340,40,{std:'WEFAX 120 lpm IOC576'});
  const o =addNode('osc',600,40,{wave:'sine',freq:1900,fmHz:400,amp:.3});
  addEdge(v.id,'img',tx.id,'img');
  addEdge(tx.id,'level',o.id,'fm');
  // addEdge(o.id,'out', <твой узел вывода на динамики>.id, 'in');  ← подставь свой id узла категории «Вывод»,
  // этого файла у меня нет, я не знаю его имя в твоём проекте.
  markWiresDirty();
});
preset('NOAA APT (АМ-огибающая)', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const bp=addNode('biquad',300,40,{type:'bp',freq:2400,Q:1.5});
const en=addNode('env',560,40,{atk:.2,rel:.4});
const mp=addNode('sigmap',820,40,{inMin:0,inMax:.5,outMin:0,outMax:1});
const pa=addNode('paint',1080,40,{std:'NOAA APT',lineMs:500,width:'2080',
height:'600',sync:'свободно'});
pa.size.w=640; pa.size.h=420; applySize(pa);
addEdge(m.id,'a',bp.id,'in'); addEdge(bp.id,'out',en.id,'in');
addEdge(en.id,'out',mp.id,'in'); addEdge(mp.id,'out',pa.id,'level');
markWiresDirty();
});
preset('DTMF', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const dt=addNode('dtmfRx',300,40,{thr:6,minMs:40});
dt.size.w=320; dt.size.h=160; applySize(dt);
const ff=addNode('fft',300,300,{size:'2048'});
const sp=addNode('sa',560,300,{fmin:600,fmax:1800,floor:-90,split:.4});
sp.size.w=520; sp.size.h=300; applySize(sp);
addEdge(m.id,'a',dt.id,'in'); addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',sp.id,'spec');
markWiresDirty();
});
preset('PSK31 (7035–7040 кГц)', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,240,{size:'16384'});
const wf=addNode('sa',40,400,{fmin:200,fmax:2600,floor:-110,top:-40,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const bp=addNode('biquad',340,40,{type:'bp',freq:1000,Q:8});
const co=addNode('costas',600,40,{f0:1000,order:'BPSK',loopHz:4,lp:80});
const ga=addNode('gardner',880,40,{baud:31.25,gain:0,free:true});
const sl=addNode('pskdec',1140,40,{order:'2',diff:true,fmt:'PSK31 varicode'});
const cn=addNode('const2',880,300,{dec:1,scale:2});
cn.size.w=320; cn.size.h=220; applySize(cn);
sl.size.w=360; sl.size.h=280; applySize(sl);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',bp.id,'in');
addEdge(wf.id,'f1',bp.id,'freq'); addEdge(wf.id,'f1',co.id,'f0');
addEdge(bp.id,'out',co.id,'in');
addEdge(co.id,'I',ga.id,'I'); addEdge(co.id,'Q',ga.id,'Q');
addEdge(ga.id,'sI',sl.id,'I'); addEdge(ga.id,'sQ',sl.id,'Q'); addEdge(ga.id,'clk',sl.id,'clk');
addEdge(ga.id,'sI',cn.id,'I'); addEdge(ga.id,'sQ',cn.id,'Q');
markWiresDirty();
});
preset('Feld Hell', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,300,{size:'8192'});
const wf=addNode('sa',40,460,{fmin:300,fmax:2000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const bp=addNode('biquad',340,40,{type:'bp',freq:1000,Q:12});
const en=addNode('env',600,40,{atk:1,rel:2});
const mp=addNode('sigmap',860,40,{inMin:0,inMax:.3,outMin:0,outMax:1});
const pa=addNode('paint',1120,40,{std:'Feld Hell',lineMs:114.2857,width:'640',height:'14',
dir:'столбцы',sync:'свободно'});
pa.size.w=620; pa.size.h=200; applySize(pa);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',bp.id,'in'); addEdge(wf.id,'f1',bp.id,'freq');
addEdge(bp.id,'out',en.id,'in'); addEdge(en.id,'out',mp.id,'in');
addEdge(mp.id,'out',pa.id,'level');
markWiresDirty();
});
preset('SSB: перенос на ноль', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'16384'});
const wf=addNode('sa',40,420,{fmin:0,fmax:12000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const sb=addNode('demod',340,40,{mode:'SSB',freq:10000,bw:2400,side:'USB',gain:3});
const fm=addNode('freqmeter',620,40,{fmin:100,fmax:4000,win:'0.5',digits:2});
const sc=addNode('scope',620,240,{span:4096,gain:2});
const dc=addNode('dac',900,40,{vol:.3,mode:'моно',pan:0});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(m.id,'a',sb.id,'in');
addEdge(wf.id,'f1',sb.id,'freq');                // маркер 1 = частота настройки на несущую
addEdge(sb.id,'out',fm.id,'in'); addEdge(sb.id,'out',sc.id,'in1');
addEdge(sb.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Занятость диапазона', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',300,40,{size:'16384'});
const wf=addNode('sa',560,40,{fmin:0,fmax:4000,split:.4});
wf.size.w=560; wf.size.h=300; applySize(wf);
const st=addNode('specstat',560,340,{mode:'занятость',thr:-85,tau:120});
st.size.w=560; st.size.h=200; applySize(st);
const pk=addNode('specstat',560,580,{mode:'максимум',floor:-120});
pk.size.w=560; pk.size.h=160; applySize(pk);
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',wf.id,'spec');
addEdge(ff.id,'spec',st.id,'spec');
addEdge(ff.id,'spec',pk.id,'spec');
markWiresDirty();
});
preset('Текст → сигнал → текст', function(){
clearAll();
const ts=addNode('textsrc',40,40,{text:'CQ CQ DE R1ABC K',repeat:0});
ts.size.w=320; ts.size.h=120; applySize(ts);
const tc=addNode('textcode',40,340,{mode:'кодировать',coding:'Морзе'});
tc.size.w=320; tc.size.h=140; applySize(tc);
const tx=addNode('morseTx',420,40,{wpm:18});
const md=addNode('mod',680,40,{mode:'OOK',f0:800,amp:.3,rise:4});
const nz=addNode('osc',680,260,{wave:'noise',amp:.02});
const mx=addNode('sum',920,40);
const dc=addNode('dac',920,260,{vol:.25,mode:'моно',pan:0});
const ff=addNode('fft',1160,40,{size:'2048'});
const pk=addNode('peak',1160,240,{fmin:500,fmax:1200,thr:-55,hold:40,track:true});
const mo=addNode('morseRx',1420,40,{auto:true,thr:.45});
mo.size.w=320; mo.size.h=200; applySize(mo);
const fl=addNode('flash',420,340);
addEdge(ts.id,'text',tx.id,'text'); addEdge(ts.id,'go',tx.id,'go');
addEdge(ts.id,'text',tc.id,'text');
addEdge(tx.id,'bit',md.id,'bit'); addEdge(tx.id,'key',fl.id,'in');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',dc.id,'L'); addEdge(mx.id,'out',ff.id,'in');
addEdge(ff.id,'spec',pk.id,'spec'); addEdge(pk.id,'level',mo.id,'level');
markWiresDirty();
});
preset('Вейвлет против БПФ', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const wv=addNode('wavelet',40,300,{fmin:80,fmax:8000,bands:'288',Q:16});
const ff=addNode('fft',40,560,{size:'4096'});
const sa1=addNode('sa',420,40,{fmin:80,fmax:8000,log:true,split:.35});
sa1.size.w=620; sa1.size.h=340; applySize(sa1);
const sa2=addNode('sa',420,420,{fmin:80,fmax:8000,log:true,split:.35});
sa2.size.w=620; sa2.size.h=340; applySize(sa2);
addEdge(m.id,'a',wv.id,'in'); addEdge(m.id,'a',ff.id,'in');
addEdge(wv.id,'spec',sa1.id,'spec');              // сверху — постоянная добротность
addEdge(ff.id,'spec',sa2.id,'spec');              // снизу — тот же сигнал через БПФ
markWiresDirty();
});
preset('Вибрации (акселерометр)', function(){
clearAll();
const ac=addNode('accel',40,40);
const nx=addNode('numsig',320,40,{gain:1,dc:true,dcHz:.3});
const ny=addNode('numsig',320,240,{gain:1,dc:true,dcHz:.3});
const nz=addNode('numsig',320,440,{gain:1,dc:true,dcHz:.3});
const s1=addNode('sum',600,40,{ka:1,kb:1});
const s2=addNode('sum',600,240,{ka:1,kb:1});
const wv=addNode('wavelet',880,40,{fmin:.5,fmax:40,bands:'144',Q:8,floor:-60,top:10});
const sa=addNode('sa',880,260,{fmin:.5,fmax:40,log:true,floor:-60,top:10,split:.4,tol:1});
sa.size.w=640; sa.size.h=360; applySize(sa);
const sc=addNode('scope',600,460,{span:16384,gain:1,stack:true});
sc.size.w=520; sc.size.h=220; applySize(sc);
const ac2=addNode('autocorr',1560,40,{win:'4',fmin:.5,fmax:40});
ac2.size.w=380; ac2.size.h=200; applySize(ac2);
addEdge(ac.id,'x',nx.id,'in'); addEdge(ac.id,'y',ny.id,'in'); addEdge(ac.id,'z',nz.id,'in');
addEdge(nx.id,'out',s1.id,'a'); addEdge(ny.id,'out',s1.id,'b');
addEdge(s1.id,'out',s2.id,'a'); addEdge(nz.id,'out',s2.id,'b');
addEdge(s2.id,'out',wv.id,'in');                  // сумма осей — общая вибрация
addEdge(wv.id,'spec',sa.id,'spec');
addEdge(nx.id,'out',sc.id,'in1'); addEdge(ny.id,'out',sc.id,'in2');
addEdge(nz.id,'out',sc.id,'in3'); addEdge(s2.id,'out',sc.id,'in4');
addEdge(s2.id,'out',ac2.id,'in');
markWiresDirty();
});
preset('Захват события', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const cp=addNode('capture',360,40,{sec:5,mode:'по уровню',thr:.03,loop:true});
cp.size.w=520; cp.size.h=140; applySize(cp);
const ff=addNode('fft',360,320,{size:'8192'});
const sa=addNode('sa',700,320,{fmin:0,fmax:6000,split:.4});
sa.size.w=620; sa.size.h=340; applySize(sa);
const sc=addNode('scope',700,40,{span:8192,gain:1});
sc.size.w=460; sc.size.h=200; applySize(sc);
const dc=addNode('dac',360,180,{vol:.3});
addEdge(m.id,'a',cp.id,'in');
addEdge(cp.id,'out',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(cp.id,'out',sc.id,'in1'); addEdge(cp.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Два микрофона', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Два разных физических входа (разные микрофоны\n'+
'или два канала звуковой карты) — в параметре «вход»\nу каждого узла «Микрофон» выбери свой источник.'});
nt.size.w=420; nt.size.h=140; applySize(nt);
const m1=addNode('mic',40,220,{gainA:2});
const m2=addNode('mic',40,420,{gainA:2});
const sc=addNode('scope',440,40,{span:4096,gain:2,stack:true});
sc.size.w=520; sc.size.h=240; applySize(sc);
const f1=addNode('fft',440,320,{size:'4096'});
const f2=addNode('fft',440,480,{size:'4096'});
const s1=addNode('sa',800,320,{fmin:0,fmax:8000,split:.4});
s1.size.w=560; s1.size.h=300; applySize(s1);
const s2=addNode('sa',800,660,{fmin:0,fmax:8000,split:.4});
s2.size.w=560; s2.size.h=300; applySize(s2);
const df=addNode('sum',440,620,{ka:1,kb:-1});       // разность каналов — проверка фазировки пары
const sd=addNode('meter',440,760);
addEdge(m1.id,'a',sc.id,'in1'); addEdge(m2.id,'a',sc.id,'in2');
addEdge(m1.id,'a',f1.id,'in'); addEdge(m2.id,'a',f2.id,'in');
addEdge(f1.id,'spec',s1.id,'spec'); addEdge(f2.id,'spec',s2.id,'spec');
addEdge(m1.id,'a',df.id,'a'); addEdge(m2.id,'a',df.id,'b');
addEdge(df.id,'out',sd.id,'in'); addEdge(df.id,'out',sc.id,'in3');
markWiresDirty();
});
preset('Пеленгация лучом (2 мик.)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Формирователь луча со сканированием угла.\n\n'+
'Два микрофона на известной базе (см. «база, см» в beam).\n'+
'LFO крутит угол ±90°, meter/scope показывают громкость луча —\n'+
'пик совпадает с направлением на источник звука.'});
nt.size.w=420; nt.size.h=180; applySize(nt);
const m1=addNode('mic',40,280,{gainA:2});
const m2=addNode('mic',40,480,{gainA:2});
const lf=addNode('lfo',40,680,{freq:.15,min:-90,max:90,wave:'tri'});
const bm=addNode('beam',420,280,{dist:15,useManual:false});
const mt=addNode('meter',420,480);
const nv=addNode('numview',420,560,{digits:0});
const sc=addNode('scope',780,40,{span:4096,gain:3,stack:true});
sc.size.w=520; sc.size.h=200; applySize(sc);
const dc=addNode('dac',780,320,{vol:.25});
addEdge(m1.id,'a',bm.id,'A'); addEdge(m2.id,'a',bm.id,'B');
addEdge(lf.id,'out',bm.id,'ang'); addEdge(lf.id,'out',nv.id,'in');
addEdge(bm.id,'sum',mt.id,'in'); addEdge(bm.id,'sum',sc.id,'in1');
addEdge(bm.id,'sum',dc.id,'L');
markWiresDirty();
});
preset('TDOA: разность хода (2 мик.)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Разность хода звука между двумя микрофонами\n'+
'по взаимной корреляции. Хлопни в стороне —\n'+
'lagMs покажет, к какому микрофону звук пришёл раньше.'});
nt.size.w=420; nt.size.h=140; applySize(nt);
const m1=addNode('mic',40,220,{gainA:2});
const m2=addNode('mic',40,420,{gainA:2});
const xc=addNode('xcorr',420,40,{maxMs:5,win:'0.05',smooth:.5});
xc.size.w=460; xc.size.h=200; applySize(xc);
const nv=addNode('numview',420,300,{digits:3});
const sc=addNode('scope',900,40,{span:4096,gain:3,stack:true,trig:true});
sc.size.w=480; sc.size.h=220; applySize(sc);
addEdge(m1.id,'a',xc.id,'A'); addEdge(m2.id,'a',xc.id,'B');
addEdge(xc.id,'lagMs',nv.id,'in');
addEdge(m1.id,'a',sc.id,'in1'); addEdge(m2.id,'a',sc.id,'in2');
markWiresDirty();
});
preset('Чирп-радар 2D (2 мик.)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'2D чирп-радар по времени прихода эха.\n\n'+
'Динамик по центру базы, микрофон A слева, B справа\n'+
'(геометрия — см. описание узла). x,y на узле — координаты цели.'});
nt.size.w=420; nt.size.h=180; applySize(nt);
const m1=addNode('mic',40,280,{gainA:3});
const m2=addNode('mic',40,480,{gainA:3});
const cr=addNode('chirpRadar',420,40,{fLo:17000,fHi:20500,dur:3,period:80,baseline:12,maxRange:1.5});
cr.size.w=460; cr.size.h=280; applySize(cr);
const dc=addNode('dac',420,360,{vol:.5});
const sc=addNode('scope',900,40,{span:8192,gain:3,stack:true});
sc.size.w=520; sc.size.h=200; applySize(sc);
addEdge(m1.id,'a',cr.id,'A'); addEdge(m2.id,'a',cr.id,'B');
addEdge(cr.id,'out',dc.id,'L'); addEdge(cr.id,'out',dc.id,'R');
addEdge(m1.id,'a',sc.id,'in1'); addEdge(m2.id,'a',sc.id,'in2');
markWiresDirty();
});
preset('Обзор диапазона', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'16384'});
const sa=addNode('sa',360,40,{fmin:0,fmax:6000,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const pe=addNode('persist',360,420,{fmin:0,fmax:6000,decay:.995,gain:4});
pe.size.w=600; pe.size.h=300; applySize(pe);
const cf=addNode('cfar',1000,40,{fmin:100,fmax:6000,thr:10,minW:2,top:12,hold:1000});
cf.size.w=420; cf.size.h=280; applySize(cf);
const pk=addNode('peak',1000,380,{fmin:100,fmax:6000,thr:-70});
addEdge(m.id,'a',ff.id,'in');
addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',pe.id,'spec');
addEdge(ff.id,'spec',cf.id,'spec');
addEdge(ff.id,'spec',pk.id,'spec');
addEdge(cf.id,'f1',sa.id,'m3'); addEdge(cf.id,'f2',sa.id,'m4');
markWiresDirty();
});
preset('Поиск преамбулы', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'4096'});
const sa=addNode('sa',360,40,{fmin:200,fmax:3000,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const dm=addNode('fsk',360,380,{f0:1275,shift:170,bw:120,center:true});
const co=addNode('corr',740,380,{pat:'М-послед. 63',baud:1200,thr:.8,abs:true,dead:50});
co.size.w=460; co.size.h=180; applySize(co);
const cp=addNode('capture',1240,40,{sec:2,mode:'по триггеру',loop:true});
cp.size.w=480; cp.size.h=160; applySize(cp);
const sc=addNode('scope',1240,300,{span:8192,gain:1});
sc.size.w=460; sc.size.h=200; applySize(sc);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',dm.id,'in'); addEdge(sa.id,'f1',dm.id,'f0');
addEdge(dm.id,'fLo',sa.id,'m3'); addEdge(dm.id,'fHi',sa.id,'m4');
addEdge(dm.id,'soft',co.id,'in');
addEdge(dm.id,'soft',cp.id,'in');
addEdge(co.id,'peak',cp.id,'trig');                // найден образец — сохраняем кадр
addEdge(dm.id,'soft',sc.id,'in1'); addEdge(co.id,'corr',sc.id,'in2');
markWiresDirty();
});
preset('АЧХ и задержка тракта', function(){
clearAll();
const sw=addNode('sweep',40,40,{f0:20,f1:20000,rate:.5,mode:'log',amp:.3});
const nz=addNode('osc',40,300,{wave:'noise',amp:.3});
const dc=addNode('dac',360,40,{vol:.3,mode:'моно'});
const m =addNode('mic',360,240,{gainA:2});
const tf=addNode('tf',700,40,{size:'4096',avg:.97});
const sa=addNode('sa',1000,40,{fmin:20,fmax:20000,log:true,floor:-60,top:20,split:.5});
sa.size.w=620; sa.size.h=340; applySize(sa);
const sc=addNode('sa',1000,420,{fmin:20,fmax:20000,log:true,floor:-40,top:0,split:.5});
sc.size.w=620; sc.size.h=300; applySize(sc);
const xc=addNode('xcorr',700,300,{maxMs:50,win:'0.25'});
xc.size.w=460; xc.size.h=200; applySize(xc);
addEdge(sw.id,'out',dc.id,'L');
addEdge(sw.id,'out',tf.id,'ref'); addEdge(m.id,'a',tf.id,'meas');
addEdge(tf.id,'H',sa.id,'spec');                   // АЧХ тракта
addEdge(tf.id,'coh',sc.id,'spec');                 // когерентность
addEdge(sw.id,'out',xc.id,'A'); addEdge(m.id,'a',xc.id,'B');
markWiresDirty();
});
preset('Гармоники и кепстр', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:2});
const ff=addNode('fft',40,260,{size:'16384'});
const cp=addNode('cepstrum',40,440,{size:'16384',fmin:40,fmax:2000});
const sa=addNode('sa',360,40,{fmin:0,fmax:6000,floor:-110,top:-10,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const hm=addNode('harm',1000,40,{auto:false,nh:10,tol:20});
hm.size.w=420; hm.size.h=280; applySize(hm);
const st=addNode('stats',1000,380,{tau:1});
st.size.w=420; st.size.h=200; applySize(st);
addEdge(m.id,'a',ff.id,'in'); addEdge(m.id,'a',cp.id,'in');
addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',hm.id,'spec');
addEdge(cp.id,'f0',hm.id,'f0');                    // основная берётся из кепстра
addEdge(cp.id,'f0',sa.id,'m3'); addEdge(hm.id,'h2',sa.id,'m4');
addEdge(m.id,'a',st.id,'in');
markWiresDirty();
});
preset('Помехоустойчивый кадр', function(){
clearAll();
const ts=addNode('textsrc',40,40,{text:'TEST FRAME 12345'});
ts.size.w=340; ts.size.h=100; applySize(ts);
const tx=addNode('serialTx',40,240,{baud:1200,code:'ASCII 8N1'});
const fr=addNode('frame',400,40,{len:120,src:'каждый отсчёт',fmt:'биты'});
fr.size.w=380; fr.size.h=160; applySize(fr);
const en=addNode('convEnc',400,300,{K:7,g1:'171',g2:'133',tail:true});
const il=addNode('interleaveTx',700,300,{rows:9,cols:20});
const nz=addNode('osc',700,480,{wave:'noise',amp:.4});
const dl=addNode('interleaveRx',1000,300,{rows:9,cols:20});
const vi=addNode('viterbiDec',1300,40,{K:7,g1:'171',g2:'133',tail:true,fmt:'текст'});
vi.size.w=420; vi.size.h=220; applySize(vi);
const bv=addNode('blkview',1300,320,{fmt:'hex',wrap:48});
bv.size.w=420; bv.size.h=200; applySize(bv);
addEdge(ts.id,'text',tx.id,'text'); addEdge(ts.id,'go',tx.id,'go');
addEdge(tx.id,'bit',fr.id,'in'); addEdge(ts.id,'go',fr.id,'trig');
addEdge(fr.id,'blk',en.id,'blk');
addEdge(en.id,'blk',il.id,'blk');
addEdge(il.id,'blk',dl.id,'blk');
addEdge(dl.id,'blk',vi.id,'blk');
addEdge(vi.id,'blk',bv.id,'blk');
markWiresDirty();
});
preset('Шумомер с журналом', function(){
clearAll();
const m =addNode('mic',40,40,{gainA:1});
const ff=addNode('fft',40,260,{size:'8192'});
const sa=addNode('sa',360,40,{fmin:20,fmax:20000,log:true,split:.45});
sa.size.w=620; sa.size.h=340; applySize(sa);
const st=addNode('stats',360,420,{tau:1});
st.size.w=420; st.size.h=200; applySize(st);
const cl=addNode('cal',820,420,{mode:'дБ смещение',ref:94,unit:'дБ SPL'});
const lg=addNode('csv',1120,40,{period:1,names:'дБ_SPL,крест,f_пик,уровень'});
lg.size.w=420; lg.size.h=260; applySize(lg);
const pk=addNode('peak',1120,360,{fmin:20,fmax:20000,thr:-90});
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',pk.id,'spec');
addEdge(m.id,'a',st.id,'in');
addEdge(st.id,'dbfs',cl.id,'in');
addEdge(cl.id,'out',lg.id,'a'); addEdge(st.id,'crest',lg.id,'b');
addEdge(pk.id,'freq',lg.id,'c'); addEdge(pk.id,'level',lg.id,'d');
markWiresDirty();
});
preset('Разбор записи (офлайн)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Разбор записи\n\n1. Выберите файл в узле ниже\n'+
'2. Поставьте скорость ×8…×32 в тулбаре\n3. Ползунком «позиция» листайте запись\n'+
'Звук на скорости выше ×1 искажён — это нормально.'});
nt.size.w=380; nt.size.h=180; applySize(nt);
const fl=addNode('file',40,280,{rate:1,gain:1,loop:false});
fl.size.w=460; fl.size.h=120; applySize(fl);
const ff=addNode('fft',40,520,{size:'8192'});
const sa=addNode('sa',540,40,{fmin:0,fmax:6000,split:.4});
sa.size.w=620; sa.size.h=340; applySize(sa);
const pe=addNode('persist',540,420,{fmin:0,fmax:6000,decay:.997,gain:4});
pe.size.w=620; pe.size.h=280; applySize(pe);
const cf=addNode('cfar',1200,40,{fmin:100,fmax:6000,thr:10,top:12,hold:2000});
cf.size.w=420; cf.size.h=300; applySize(cf);
const cp=addNode('capture',1200,380,{sec:5,mode:'вручную',loop:true});
cp.size.w=420; cp.size.h=160; applySize(cp);
const dc=addNode('dac',1200,600,{vol:.3});
addEdge(fl.id,'out',ff.id,'in');
addEdge(ff.id,'spec',sa.id,'spec');
addEdge(ff.id,'spec',pe.id,'spec');
addEdge(ff.id,'spec',cf.id,'spec');
addEdge(cf.id,'f1',sa.id,'m3'); addEdge(cf.id,'f2',sa.id,'m4');
addEdge(fl.id,'out',cp.id,'in'); addEdge(cp.id,'out',dc.id,'L');
markWiresDirty();
});
preset('APRS / AX.25', function(){
clearAll();
const nt=addNode('note',40,40,{text:'APRS / AX.25, Bell 202 1200 бод\n'+
'Тоны 1200 (mark) и 2200 (space) Гц.\nМаркером 1 на анализаторе можно подстроить приём.'});
nt.size.w=380; nt.size.h=140; applySize(nt);
const m =addNode('mic',40,240,{gainA:2});
const ff=addNode('fft',40,440,{size:'2048'});
const sa=addNode('sa',420,40,{fmin:600,fmax:3000,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const dm=addNode('fsk',420,380,{f0:1200,shift:1000,bw:600,center:false});
const hd=addNode('ax25Rx',1020,40,{baud:1200,nrzi:true,ax25:true});
hd.size.w=480; hd.size.h=320; applySize(hd);
const bv=addNode('blkview',1020,400,{fmt:'hex',wrap:48});
bv.size.w=480; bv.size.h=180; applySize(bv);
const sc=addNode('scope',420,600,{span:4096,gain:2});
sc.size.w=460; sc.size.h=180; applySize(sc);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',dm.id,'in');
addEdge(dm.id,'fLo',sa.id,'m3'); addEdge(dm.id,'fHi',sa.id,'m4');
addEdge(dm.id,'bLo',sa.id,'bLo'); addEdge(dm.id,'bHi',sa.id,'bHi');
addEdge(dm.id,'soft',hd.id,'in');
addEdge(hd.id,'blk',bv.id,'blk');
addEdge(dm.id,'soft',sc.id,'in1');
markWiresDirty();
});
preset('Подавление помехи', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Подавление помехи по опорному каналу\n\n'+
'Микрофон A — полезный сигнал с помехой,\nмикрофон B — только помеха (второй, отдельный микрофон).\n'+
'Фильтр вычитает то, что коррелирует с B.'});
nt.size.w=380; nt.size.h=160; applySize(nt);
const mA=addNode('mic',40,260,{gainA:2});
const mB=addNode('mic',40,460,{gainA:2});
const ad=addNode('nlms',420,40,{taps:'256',mu:.3});
const bm=addNode('beam',420,240,{dist:15,ang:0,useManual:false});
const nt2=addNode('notch',420,440,{f0:50,n:5,Q:40});
const ag=addNode('agc',420,600,{target:.3});
const ff=addNode('fft',760,600,{size:'4096'});
const sa=addNode('sa',760,40,{fmin:0,fmax:8000,split:.4});
sa.size.w=600; sa.size.h=320; applySize(sa);
const sc=addNode('scope',760,400,{span:4096,gain:2,stack:true});
sc.size.w=520; sc.size.h=180; applySize(sc);
const dc=addNode('dac',1400,40,{vol:.3});
addEdge(mA.id,'a',ad.id,'d'); addEdge(mB.id,'a',ad.id,'x');
addEdge(mA.id,'a',bm.id,'A'); addEdge(mB.id,'a',bm.id,'B');
addEdge(ad.id,'out',nt2.id,'in'); addEdge(nt2.id,'out',ag.id,'in');
addEdge(ag.id,'out',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(mA.id,'a',sc.id,'in1'); addEdge(ad.id,'out',sc.id,'in2');
addEdge(bm.id,'sum',sc.id,'in3');
addEdge(ag.id,'out',dc.id,'L');
markWiresDirty();
});
preset('Акустика помещения', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Акустика помещения\n\n'+
'Свип в динамик, микрофон обратно.\nКнопка «Измерить» в узле импульсной —\n'+
'после того как свип отыграл целиком.'});
nt.size.w=380; nt.size.h=160; applySize(nt);
const sw=addNode('sweep',40,260,{f0:30,f1:18000,rate:.25,mode:'log',amp:.3});
const dc=addNode('dac',40,460,{vol:.4});
const m =addNode('mic',40,620,{gainA:2});
const ff=addNode('fft',420,620,{size:'16384'});
const oc=addNode('octave',760,620,{width:'1/3 октавы',weight:'A',fmin:20,fmax:20000});
const sa=addNode('sa',420,40,{fmin:20,fmax:20000,log:true,floor:-100,top:-20,split:.5});
sa.size.w=600; sa.size.h=320; applySize(sa);
const irn=addNode('ir',420,400,{size:'32768',range:'T20'});
irn.size.w=560; irn.size.h=200; applySize(irn);
const st=addNode('stats',1060,620,{tau:1});
addEdge(sw.id,'out',dc.id,'L');
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',oc.id,'spec');
addEdge(oc.id,'spec',sa.id,'spec');
addEdge(sw.id,'out',irn.id,'ref'); addEdge(m.id,'a',irn.id,'meas');
addEdge(m.id,'a',st.id,'in');
markWiresDirty();
});
preset('HFDL: обнаружение и кадр', function(){
clearAll();
const nt=addNode('note',40,40,{text:'HFDL, приёмный тракт\n\n'+
'Несущая SSB смещена на 1440 Гц, 1800 бод.\n'+
'Преамбула: A (127 бит) → A → M1 (127 бит).\n'+
'Вариант M1 задаёт скорость: крутите «вариант M1»\n'+
'и смотрите, на каком пик корреляции.\n\n'+
'Что есть: обнаружение, скорость, деинтерливер,\nВитерби, дескремблер, CRC.\n'+
'Чего нет: обучение эквалайзера по T-символам\nи разбор MPDU/LPDU.'});
nt.size.w=420; nt.size.h=260; applySize(nt);
const m =addNode('mic',40,340,{gainA:2});
const ff=addNode('fft',40,540,{size:'8192'});
const sa=addNode('sa',480,40,{fmin:0,fmax:3500,split:.4});
sa.size.w=560; sa.size.h=300; applySize(sa);
const sb=addNode('demod',480,380,{mode:'SSB',freq:1440,bw:2600,side:'USB',gain:3});
const co=addNode('costas',480,560,{f0:1800,order:'8PSK',loopHz:5,lp:2500});
const ga=addNode('gardner',800,560,{baud:1800,gain:.005});
const sl=addNode('pskdec',1080,560,{order:'8',diff:true,fmt:'биты'});
sl.size.w=340; sl.size.h=180; applySize(sl);
const cr=addNode('corr',1080,40,{pat:'HFDL: преамбула A',baud:1800,thr:.6,abs:true,dead:100});
cr.size.w=420; cr.size.h=180; applySize(cr);
const cm=addNode('corr',1080,260,{pat:'HFDL: M1 (скорость)',baud:1800,thr:.5,abs:true,shift:0});
cm.size.w=420; cm.size.h=200; applySize(cm);
const fr=addNode('frame',1560,40,{len:2160,src:'по clk',fmt:'биты'});
fr.size.w=380; fr.size.h=160; applySize(fr);
const di=addNode('hfdlDeint',1560,260,{shiftCols:17});
const vi=addNode('viterbiDec',1560,420,{K:7,g1:'155',g2:'117',tail:false,fmt:'hex'});
vi.size.w=380; vi.size.h=200; applySize(vi);
const ds=addNode('hfdlDescr',1560,680,{baud:1800});
const bv=addNode('blkview',1960,420,{fmt:'hex',wrap:48});
bv.size.w=400; bv.size.h=220; applySize(bv);
addEdge(m.id,'a',ff.id,'in'); addEdge(ff.id,'spec',sa.id,'spec');
addEdge(m.id,'a',sb.id,'in'); addEdge(sa.id,'f1',sb.id,'freq');
addEdge(sb.id,'out',co.id,'in');
addEdge(co.id,'I',ga.id,'I'); addEdge(co.id,'Q',ga.id,'Q');
addEdge(ga.id,'sI',sl.id,'I'); addEdge(ga.id,'sQ',sl.id,'Q'); addEdge(ga.id,'clk',sl.id,'clk');
addEdge(co.id,'I',cr.id,'in'); addEdge(co.id,'I',cm.id,'in');
addEdge(co.id,'I',fr.id,'in'); addEdge(ga.id,'clk',fr.id,'clk');
addEdge(cm.id,'peak',fr.id,'trig');
addEdge(fr.id,'blk',di.id,'blk');
addEdge(di.id,'blk',vi.id,'blk');
addEdge(vi.id,'blk',bv.id,'blk');
markWiresDirty();
});


/* ============================================================
   Добавить в presets.js (рядом с остальными preset(...) вызовами,
   до вызова buildBuiltinPresets()). Требует узлов acid/drumseq
   из dsp-techno-nodes.js.
   ============================================================ */

function stepPattern(hits,len=32){                        // список индексов шагов → битовая строка
  const a=new Array(len).fill('0');
  for(const h of hits) a[h]='1';
  return a.join('');
}

preset('Синтезатор: acid-бас (303)', function(){
  clearAll();
  const sq=addNode('seq',40,40,{pattern:'45,45,x,48,45,43,45,x,45,45,x,50,45,43,41,x',bpm:130,div:'1/16',gatelen:.5});
  sq.size.w=420; applySize(sq);
  const ac=addNode('acid',520,40,{cutoff:500,envAmt:2600,reso:.8,decay:.18,slide:.05});
  const ds=addNode('dist',520,260,{type:'tanh',drive:3,mix:.6});
  const dl=addNode('delay',780,260,{ms:180,fb:.25,mix:.25});
  const dc=addNode('dac',1040,40,{vol:.4,mode:'моно'});
  addEdge(sq.id,'freq',ac.id,'freq'); addEdge(sq.id,'gate',ac.id,'gate');
  addEdge(ac.id,'out',ds.id,'in'); addEdge(ds.id,'out',dl.id,'in'); addEdge(dl.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Техно: драм-машина', function(){
  clearAll();
  const grid=[stepPattern([0,4,8,12]), stepPattern([]), stepPattern([4,12]),
              stepPattern([2,6,10]), stepPattern([14]), stepPattern([])].join(';');
  const dr=addNode('drumseq',40,40,{grid,bpm:130,steps:16});
  dr.size.w=520; applySize(dr);
  const dc=addNode('dac',620,40,{vol:.5,mode:'моно'});
  addEdge(dr.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Техно: генеративный acid', function(){
  clearAll();
  const gs=addNode('genseq',40,40,{root:33,scale:'пентатоника, минор',octaves:2,bpm:130,div:'1/16',
                                    gatelen:.5,restProb:.25,leapProb:.15});
  const ac=addNode('acid',520,40,{cutoff:480,envAmt:2500,reso:.8,decay:.17,slide:.05});
  const ds=addNode('dist',520,260,{drive:2.5,mix:.5});
  const dl=addNode('delay',780,260,{ms:180,fb:.25,mix:.25});
  const dc=addNode('dac',1040,40,{vol:.4,mode:'моно'});
  addEdge(gs.id,'freq',ac.id,'freq'); addEdge(gs.id,'gate',ac.id,'gate');
  addEdge(ac.id,'out',ds.id,'in'); addEdge(ds.id,'out',dl.id,'in'); addEdge(dl.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Техно: полный трек', function(){
  clearAll();
  const grid=[stepPattern([0,4,8,12]), stepPattern([]), stepPattern([4,12]),
              stepPattern([2,6,10]), stepPattern([14]), stepPattern([])].join(';');
  const dr=addNode('drumseq',40,40,{grid,bpm:130,steps:16});
  dr.size.w=520; applySize(dr);
  const sq=addNode('seq',40,320,{pattern:'33,33,x,36,33,31,33,x,33,33,x,38,33,31,29,x',bpm:130,div:'1/16',gatelen:.5});
  sq.size.w=420; applySize(sq);
  const ac=addNode('acid',620,320,{cutoff:450,envAmt:2400,reso:.82,decay:.16,slide:.04});
  const ds=addNode('dist',620,480,{drive:2.5,mix:.5});
  const mx=addNode('mixer4',900,180,{ka:1,pa:0,kb:.9,pb:0});
  const cp=addNode('comp',1160,180,{threshold:-10,ratio:4});
  const dc=addNode('dac',1400,180,{vol:.45,mode:'моно'});
  addEdge(dr.id,'out',mx.id,'a');
  addEdge(sq.id,'freq',ac.id,'freq'); addEdge(sq.id,'gate',ac.id,'gate');
  addEdge(ac.id,'out',ds.id,'in'); addEdge(ds.id,'out',mx.id,'b');
  addEdge(mx.id,'out',cp.id,'in'); addEdge(cp.id,'out',dc.id,'L');
  markWiresDirty();
});

/* ---- демо новых фич пиано-ролла / драм-машины / мастер-клока ---- */

preset('Пиано-ролл: длина и велосити', function(){
  clearAll();
  // трезвучие длиной 2 шага, затем одиночные ноты разной длины (1–4 шага) и громкости (60–120)
  const grid='60:0:2:90;64:0:2:90;67:0:2:90;65:3:1:70;67:4:1:70;69:5:3:120;'+
             '65:9:1:60;64:10:1:60;62:11:1:60;60:12:4:100';
  const pr=addNode('pianoroll',40,40,{grid,steps:16,bpm:110,div:'1/8',gatelen:.85});
  pr.size.w=560; applySize(pr);
  const vc=addNode('voice',660,40,{wave1:'saw',level1:.7,wave2:'square',level2:0,
                                    attack:.01,decay:.15,sustain:.6,release:.25});
  const dc=addNode('dac',940,40,{vol:.4,mode:'моно'});
  addEdge(pr.id,'freq',vc.id,'freq'); addEdge(pr.id,'gate',vc.id,'gate'); addEdge(pr.id,'vel',vc.id,'vel');
  addEdge(vc.id,'out',dc.id,'L');
  markWiresDirty();
});

preset('Пиано-ролл: аккорды на 4 голоса', function(){
  clearAll();
  // 4 квартаккорда по 4 ноты — каждая нота идёт на свой freq/gate выход (freq..freq4)
  const grid=[
    '48:0:4:90','52:0:4:80','55:0:4:80','60:0:4:70',
    '50:4:4:90','53:4:4:80','57:4:4:80','60:4:4:70',
    '45:8:4:90','48:8:4:80','52:8:4:80','57:8:4:70',
    '48:12:4:100','52:12:4:90','55:12:4:90','60:12:4:80'
  ].join(';');
  const pr=addNode('pianoroll',40,40,{grid,steps:16,bpm:90,div:'1/4',gatelen:.9});
  pr.size.w=560; applySize(pr);
  const py=addNode('poly4',660,40,{wave:'tri',attack:.02,decay:.3,sustain:.7,release:.4,spread:.7});
  const dc=addNode('dac',940,40,{vol:.35});
  addEdge(pr.id,'freq',py.id,'freq'); addEdge(pr.id,'gate',py.id,'gate');
  addEdge(pr.id,'freq2',py.id,'freq2'); addEdge(pr.id,'gate2',py.id,'gate2');
  addEdge(pr.id,'freq3',py.id,'freq3'); addEdge(pr.id,'gate3',py.id,'gate3');
  addEdge(pr.id,'freq4',py.id,'freq4'); addEdge(pr.id,'gate4',py.id,'gate4');
  addEdge(py.id,'L',dc.id,'L'); addEdge(py.id,'R',dc.id,'R');      // панорама голосов — по-настоящему стерео
  markWiresDirty();
});

preset('Драм-машина: банки A/B', function(){
  clearAll();
  const A=[stepPattern([0,4,8,12],16), stepPattern([],16), stepPattern([4,12],16),
           stepPattern([1,3,5,7,9,11,13,15],16), stepPattern([14],16), stepPattern([6],16)].join(';');
  const B=[stepPattern([0,8],16), stepPattern([],16), stepPattern([12,13,14,15],16),
           stepPattern([2,6,10,14],16), stepPattern([],16), stepPattern([],16)].join(';');
  const grid=[A,B,'',''].join('|');                                // банк A — качалка, банк B — брейк с хлоп-роллом
  const dr=addNode('drumseq',40,40,{grid,steps:16,bpm:130,div:'1/16',bank:'A'});
  dr.size.w=560; applySize(dr);
  const dc=addNode('dac',680,40,{vol:.5,mode:'моно'});
  addEdge(dr.id,'out',dc.id,'L');
  markWiresDirty();
});
// Переключай банк вкладками A/B/C/D в шапке узла, рисуй перетаскиванием,
// «Копировать»/«Вставить» — гоняет паттерн между банками (и между разными узлами).

preset('Синхронизация: мастер-клок', function(){
  clearAll();
  const ck=addNode('clock',40,40,{bpm:128,div:'1/16',run:true});
  const A=[stepPattern([0,4,8,12],16), stepPattern([],16), stepPattern([4,12],16),
           stepPattern([1,3,5,7,9,11,13,15],16), stepPattern([14],16), stepPattern([],16)].join(';');
  const dr=addNode('drumseq',40,220,{grid:[A,'','',''].join('|'),steps:16});
  dr.size.w=520; applySize(dr);
  const grid='60:0:2:100;63:2:2:90;65:4:2:100;60:6:2:80;58:8:2:100;60:10:2:90;63:12:2:100;65:14:2:110';
  const pr=addNode('pianoroll',40,460,{grid,steps:16,gatelen:.7});
  pr.size.w=520; applySize(pr);
  const vc =addNode('voice',620,460,{wave1:'saw',level1:.7,wave2:'square',level2:0,
                                      attack:.005,decay:.2,sustain:.4,release:.15});
  const mx =addNode('mixer4',1140,300,{ka:1,pa:-.3,kb:1,pb:.3});
  const dc =addNode('dac',1400,300,{vol:.4,mode:'моно'});
  addEdge(ck.id,'pulse',dr.id,'clk'); addEdge(ck.id,'pulse',pr.id,'clk');   // оба секвенсора — от одного клока
  addEdge(dr.id,'out',mx.id,'a');
  addEdge(pr.id,'freq',vc.id,'freq'); addEdge(pr.id,'gate',vc.id,'gate'); addEdge(vc.id,'out',mx.id,'b');
  addEdge(mx.id,'out',dc.id,'L');
  markWiresDirty();
});
// Свой bpm у drumseq/pianoroll теперь не используется — весь тайминг задаёт clock.
// Смени bpm или div на clock — оба секвенсора перестроятся синхронно, без расхождения по фазе.

preset('Пиано-ролл: квантование по ладу', function(){
  clearAll();
  // риф в D натуральный минор (D,E,F,G,A,B♭,C) — все ноты уже попадают в лад
  const grid='62:0:2:100;65:2:2:90;69:4:2:100;67:6:1:80;65:7:1:80;64:8:2:90;62:10:2:100;60:12:4:110';
  const pr=addNode('pianoroll',40,40,{grid,steps:16,gatelen:.8,
                                       key:'D',scale:'натуральный минор',quantize:true});
  pr.size.w=560; applySize(pr);
  const vc=addNode('voice',660,40,{wave1:'tri',level1:.7,wave2:'square',level2:0,
                                    attack:.01,decay:.2,sustain:.5,release:.3});
  const dc=addNode('dac',940,40,{vol:.4,mode:'моно'});
  addEdge(pr.id,'freq',vc.id,'freq'); addEdge(pr.id,'gate',vc.id,'gate'); addEdge(pr.id,'vel',vc.id,'vel');
  addEdge(vc.id,'out',dc.id,'L');
  markWiresDirty();
});
// Фон сетки затемняет ступени вне лада — при «квантовать по ладу» клик в затемнённую
// клетку всё равно ставит ближайшую ноту лада, мимо не промахнёшься. Уже расставленные
// ноты не переезжают сами — квантуются только новые, при создании.

preset('Аранжировка: интро → куплет → припев', function(){
  clearAll();
  const ck=addNode('clock',40,40,{bpm:128,div:'1/16',run:true});
  const sg=addNode('song',40,220,{seq:'A:2,B:4,B:4,C:4,C:4,B:2,A:2',stepsPerBar:16,loop:true});
  sg.size.w=340; applySize(sg);

  // банк A — интро (только хэты), B — куплет (качалка), C — припев (плотнее)
  const drGrid=
    '0000000000000000;0000000000000000;0000000000000000;0010001000100010;0000000000000000;0000000000000000|'+
    '1000100010001000;0000000000000000;0000100000001000;0101010101010101;0000000000000010;0000001000000000|'+
    '1010101010101010;0000000000000000;0000100000001000;0101010101010101;0010000000100000;0000001100000011|';
  const dr=addNode('drumseq',40,460,{grid:drGrid,steps:16});
  dr.size.w=560; applySize(dr);

  // банк A — выдержанный пад-аккорд, B — риф, C — аккордовые удары на каждую долю
  const prGrid=[
    '45:0:16:70;48:0:16:70;52:0:16:70',
    '62:0:2:100;65:2:2:90;69:4:2:100;67:6:1:80;65:7:1:80;64:8:2:90;62:10:2:100;60:12:4:110',
    '57:0:2:120;60:0:2:120;64:0:2:120;55:4:2:115;59:4:2:115;62:4:2:115;'+
    '57:8:2:120;60:8:2:120;64:8:2:120;60:12:2:127;64:12:2:127;67:12:2:127',
    ''
  ].join('|');
  const pr=addNode('pianoroll',700,460,{grid:prGrid,steps:16,gatelen:.85});
  pr.size.w=560; applySize(pr);

  // все 4 голоса пиано-ролла — один poly4 вместо ручной сборки osc+adsr+mul на каждый
  const py=addNode('poly4',1320,460,{wave:'tri',attack:.015,decay:.25,sustain:.6,release:.3,spread:.5});

  const mx=addNode('mixer4',1620,300,{ka:1,pa:-.3,kb:.9,pb:.2});
  const dc=addNode('dac',1900,300,{vol:.4,mode:'моно'});

  addEdge(ck.id,'pulse',dr.id,'clk'); addEdge(ck.id,'pulse',pr.id,'clk'); addEdge(ck.id,'pulse',sg.id,'clk');
  addEdge(sg.id,'bank',dr.id,'bankSel'); addEdge(sg.id,'bank',pr.id,'bankSel');   // один и тот же банк на оба узла
  addEdge(pr.id,'freq',py.id,'freq'); addEdge(pr.id,'gate',py.id,'gate');
  addEdge(pr.id,'freq2',py.id,'freq2'); addEdge(pr.id,'gate2',py.id,'gate2');
  addEdge(pr.id,'freq3',py.id,'freq3'); addEdge(pr.id,'gate3',py.id,'gate3');
  addEdge(pr.id,'freq4',py.id,'freq4'); addEdge(pr.id,'gate4',py.id,'gate4');
  addEdge(dr.id,'out',mx.id,'a');
  addEdge(py.id,'out',mx.id,'b');
  addEdge(mx.id,'out',dc.id,'L');
  markWiresDirty();
});
// У song-узла над клеткой каждого секвенсора появляется жёлтая полоска — значит банк
// сейчас переключает не UI, а song. Сам song теперь — плейлист: клик по бейджу A/B/C/D
// меняет банк секции, «−»/«+» — число тактов, ▲/▼ — переставить, «×» — удалить,
// «+ секция» сверху — добавить. Клик по телу строки ставит секцию в очередь — переход
// произойдёт на следующем такте, не обрывая текущий.

preset('Микшер на 12 каналов: полный бэнд', function(){
  clearAll();
  const ck=addNode('clock',40,40,{bpm:128,div:'1/16',run:true});

  // барабаны — обычная качалка (без банков, тут показываем именно микшер)
  const drGrid=[stepPattern([0,4,8,12],16), stepPattern([],16), stepPattern([4,12],16),
                stepPattern([1,3,5,7,9,11,13,15],16), stepPattern([14],16), stepPattern([6],16)].join(';');
  const dr=addNode('drumseq',40,220,{grid:drGrid,steps:16});
  dr.size.w=520; applySize(dr);

  // пэд-аккорды на 4 голоса
  const prGrid=[
    '48:0:4:90','52:0:4:80','55:0:4:80','60:0:4:70',
    '50:4:4:90','53:4:4:80','57:4:4:80','60:4:4:70',
    '45:8:4:90','48:8:4:80','52:8:4:80','57:8:4:70',
    '48:12:4:100','52:12:4:90','55:12:4:90','60:12:4:80'
  ].join(';');
  const pr=addNode('pianoroll',40,460,{grid:prGrid,steps:16,bpm:90,div:'1/4',gatelen:.9});
  pr.size.w=520; applySize(pr);
  const py=addNode('poly4',40,700,{wave:'tri',attack:.02,decay:.3,sustain:.7,release:.4,spread:.4});

  // бас — генеративная мелодия через acid-фильтр
  const gs=addNode('genseq',620,220,{root:33,scale:'пентатоника, минор',octaves:1,
                                      div:'1/16',gatelen:.5,restProb:.2,leapProb:.15});
  const ac=addNode('acid',620,380,{cutoff:450,envAmt:2200,reso:.75,decay:.16,slide:.05});

  // лид — короткий секвенированный рифф через voice
  const sq=addNode('seq',620,540,{pattern:'72,x,75,72,x,79,77,x',div:'1/8',gatelen:.5});
  const vc=addNode('voice',620,700,{wave1:'square',level1:.5,wave2:'sine',level2:.3,
                                     attack:.005,decay:.15,sustain:.4,release:.15});

  const mx=addNode('mixer12',1120,300,{
    ka:1,pa:0,                 // барабаны — по центру
    kb:.8,pb:-.4,              // аккорды — влево
    kc:.9,pc:0,                // бас — по центру
    kd:.7,pd:.45});            // лид — вправо
  const dc=addNode('dac',1420,300,{vol:.35});

  addEdge(ck.id,'pulse',dr.id,'clk'); addEdge(ck.id,'pulse',pr.id,'clk');
  addEdge(ck.id,'pulse',gs.id,'clk'); addEdge(ck.id,'pulse',sq.id,'clk');

  addEdge(pr.id,'freq',py.id,'freq'); addEdge(pr.id,'gate',py.id,'gate');
  addEdge(pr.id,'freq2',py.id,'freq2'); addEdge(pr.id,'gate2',py.id,'gate2');
  addEdge(pr.id,'freq3',py.id,'freq3'); addEdge(pr.id,'gate3',py.id,'gate3');
  addEdge(pr.id,'freq4',py.id,'freq4'); addEdge(pr.id,'gate4',py.id,'gate4');
  addEdge(gs.id,'freq',ac.id,'freq'); addEdge(gs.id,'gate',ac.id,'gate');
  addEdge(sq.id,'freq',vc.id,'freq'); addEdge(sq.id,'gate',vc.id,'gate');

  addEdge(dr.id,'out',mx.id,'a');
  addEdge(py.id,'out',mx.id,'b');
  addEdge(ac.id,'out',mx.id,'c');
  addEdge(vc.id,'out',mx.id,'d');
  addEdge(mx.id,'L',dc.id,'L'); addEdge(mx.id,'R',dc.id,'R');
  markWiresDirty();
});
// Использованы только 4 из 12 каналов (a—d) — остальные 8 (e…l) свободны, подключай
// что угодно ещё: перкуссию, вторую мелодию, шумовую текстуру. У каждого канала свои
// уровень/панорама/мьют в параметрах узла, имя канала — первая буква в названии параметра.

preset('Фазоскоп: корреляция и фигуры Лиссажу', function(){
  clearAll();
  const o1=addNode('osc',40,40,{wave:'sine',freq:220,amp:.3});
  const lf=addNode('lfo',40,260,{freq:.15,min:80,max:4000});          // медленно крутит частоту фазовращателя
  const ap=addNode('biquad',360,40,{type:'ap',freq:220,Q:.9});        // АЧХ не трогает, только сдвигает фазу
  const xy=addNode('xyscope',680,40,{gain:1,persist:.85});
  xy.size.w=420; xy.size.h=300; applySize(xy);
  const sm=addNode('sum',360,260,{ka:.6,kb:.6});                      // сухой + сдвинутый по фазе сигнал вместе
  const dc=addNode('dac',680,400,{vol:.3,mode:'моно'});
  addEdge(lf.id,'out',ap.id,'freq'); addEdge(o1.id,'out',ap.id,'in');
  addEdge(o1.id,'out',xy.id,'x'); addEdge(ap.id,'out',xy.id,'y');
  addEdge(o1.id,'out',sm.id,'a'); addEdge(ap.id,'out',sm.id,'b'); addEdge(sm.id,'out',dc.id,'L');
  markWiresDirty();
});
// Пока LFO гоняет частоту allpass-фильтра, фигура на фазоскопе плывёт от прямой линии
// (сигналы синфазны, корреляция около +1) через эллипс/окружность (сдвиг ~90°, корреляция
// около 0) до обратной линии (противофаза, корреляция около −1). Полоса снизу — то же самое
// числом. На слух сумма сухого и сдвинутого сигналов даёт лёгкий фейзерный эффект.

preset('Гильберт: огибающая и мгновенная частота', function(){
  clearAll();
  const lf=addNode('lfo',40,40,{freq:.5,min:0,max:.35});               // амплитудная огибающая тона
  const o1=addNode('osc',40,260,{wave:'sine',freq:600,amp:.3});
  const hb=addNode('hilbert',360,260,{taps:127});
  const pl=addNode('polar',680,260);
  const sc=addNode('scope',1000,40,{span:4096,gain:1,stack:true});
  sc.size.w=480; sc.size.h=280; applySize(sc);
  const dc=addNode('dac',1000,400,{vol:.25,mode:'моно'});
  addEdge(lf.id,'out',o1.id,'amp');
  addEdge(o1.id,'out',hb.id,'in');
  addEdge(hb.id,'I',pl.id,'I'); addEdge(hb.id,'Q',pl.id,'Q');
  addEdge(pl.id,'mag',sc.id,'in1'); addEdge(pl.id,'dphase',sc.id,'in2');
  addEdge(o1.id,'out',dc.id,'L');
  markWiresDirty();
});
// hilbert строит аналитический сигнал прямо из чистого тона (без настройки на несущую,
// в отличие от iq); polar.mag — огибающая, повторяющая форму LFO, которым модулируется
// амплитуда; polar.dphase — мгновенная частота, у чистого тона должна держаться ровной
// линией около 600/24000≈0.025. Подключи вместо чистого тона что угодно ещё (голос,
// AM-сигнал с радио) — mag/dphase сразу покажут его огибающую и девиацию частоты.

preset('Сонар: один микрофон, чирп 18–22 кГц', function(){
  clearAll();
  const nt=addNode('note',40,40,{text:
    'Моностатический сонар: динамик и микрофон одного устройства.\n\n'+
    'Обязательно: echo/ns/agc у mic — выключены (уже так по умолчанию в этом пресете,\n'+
    'но если раньше включал(а) их вручную — проверь). Иначе браузер сам вырежет\n'+
    'адаптивной обработкой ровно тот сигнал, который тут измеряется.\n\n'+
    'Профиль дальности рисуется прямо на узле sonar. Пик — найденное эхо,\n'+
    'range1/range2/range3 — расстояния в метрах (путь туда-обратно уже поделен на 2).\n'+
    'motion1 — накопленное микросмещение сильнейшего эха по фазе; приближённая величина,\n'+
    'полезна для относительных изменений (дыхание, дрожь), не для абсолютной дальности.\n\n'+
    'На старте направь телефон на стену/ладонь в 0.5–1.5 м и не двигай — первое эхо\n'+
    'должно быть стабильным.'});
  nt.size.w=460; nt.size.h=260; applySize(nt);
  const m=addNode('mic',40,340,{gainA:3,echo:false,ns:false,agc:false});
  const sn=addNode('sonar',420,40,{fLo:18000,fHi:22000,dur:12,period:100,maxDelay:25,amp:.5,thr:.15});
  sn.size.w=520; sn.size.h=260; applySize(sn);
  const dc=addNode('dac',420,340,{vol:1,mode:'моно'});
  addEdge(m.id,'a',sn.id,'in'); addEdge(sn.id,'out',dc.id,'L');
  markWiresDirty();
});
// dac.vol стоит на 1 неспроста: если тише — на многих телефонных динамиках 18–22 кГц
// и так на грани слышимости/чувствительности микрофона, эхо будет слабым и потонет
// в шуме. thr (порог пика) и maxDelay (окно поиска) — первое, что крутить, если эхо
// не находится: слишком высокий порог режет слабые отражения, слишком узкое окно
// не достаёт до цели.

preset('Осциллограф с триггером: видна разница фаз', function(){
  clearAll();
  const nt=addNode('note',40,40,{text:
    'trig у scope — включён (по умолчанию). Триггер ищет фронт по первому АКТИВНОМУ\n'+
    'каналу — это in1. Все каналы рисуются от одного и того же найденного старта,\n'+
    'просто in1 из-за этого выглядит неподвижным.\n\n'+
    'ВАЖНО про параметр "фаза" у osc: сам по себе он ничего не делает. Он читается\n'+
    'только в момент прихода sync-импульса на вход sync (n.ph=n.p.phase внутри\n'+
    'if(I.sync)). Без sync фаза просто свободно бежит своим счётчиком. Поэтому здесь\n'+
    'o1.sync подключён на o2.sync: при равной частоте (200=200 Гц) o2 каждый оборот\n'+
    'принудительно перескакивает на свой параметр "фаза" — крути его у o2, сдвиг сразу\n'+
    'виден на экране как устойчивое (не дрейфующее) расхождение волн.\n\n'+
    'Если сделать частоты разными — вернётся дрейф: sync каждый раз переустанавливает\n'+
    'фазу, но между импульсами она всё равно бежит со своей скоростью.'});
  nt.size.w=460; nt.size.h=320; applySize(nt);
  const o1=addNode('osc',40,400,{wave:'sine',freq:200,amp:.4,phase:0});
  const o2=addNode('osc',40,580,{wave:'sine',freq:200,amp:.4,phase:.25});
  const sc=addNode('scope',420,400,{span:2400,gain:1,trig:true,stack:true});
  sc.size.w=560; sc.size.h=280; applySize(sc);
  addEdge(o1.id,'sync',o2.id,'sync');
  addEdge(o1.id,'out',sc.id,'in1'); addEdge(o2.id,'out',sc.id,'in2');
  markWiresDirty();
});
preset('Чирп-модем: шум и переотражение', function(){
clearAll();
// символ качается 0..63 медленной пилой — просто чтобы на глаз увидеть, что приёмник
// действительно отслеживает меняющееся значение, а не просто выдаёт одно и то же число
const src=addNode('lfo',40,40,{freq:.15,min:0,max:63,wave:'saw'});
const tx=addNode('chirpTx',300,40,{sf:'6',bw:2000,f0:1000,amp:.5});
const dl=addNode('delay',300,260,{ms:6,fb:0,mix:.35});         // короткое эхо — имитация переотражения
const nz=addNode('osc',300,420,{wave:'noise',amp:.05});
const mx=addNode('sum',560,140,{ka:1,kb:1});
const ff=addNode('fft',820,40,{size:'2048',win:'hann'});
const wf=addNode('sa',820,220,{fmin:0,fmax:3200,split:.4});
wf.size.w=480; wf.size.h=300; applySize(wf);
const rx=addNode('chirpRx',1340,40,{sf:'6',bw:2000,f0:1000});
const nvSym=addNode('numview',1340,260,{digits:0});
const nvLvl=addNode('numview',1340,360,{digits:2});
const nt=addNode('note',40,540,{text:
  'Символ = циклический сдвиг одного и того же ЛЧМ-импульса по времени, не частота/фаза.\n\n'+
  'Приёмник де-чирпит (умножает на обратный опорный чирп) и ищет пик БПФ — сдвинутый чирп\n'+
  'после де-чирпа превращается в обычный тон k·bw/M, найти его — то же самое, что найти\n'+
  'символ. Проверено численно (не на глаз): чисто/с шумом/с переотражением — декодирует\n'+
  'без единой ошибки; при желании отключите dl/nz по одному, чтобы увидеть эффект каждого\n'+
  'отдельно. Смотрите на sa — видно чередование восходящих ЛЧМ-импульсов.'});
nt.size.w=460; nt.size.h=220; applySize(nt);
addEdge(src.id,'out',tx.id,'sym');
addEdge(tx.id,'out',dl.id,'in');
addEdge(dl.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
addEdge(rx.id,'sym',nvSym.id,'in'); addEdge(rx.id,'level',nvLvl.id,'in');
markWiresDirty();
});

preset('APRS: передача и приём (петля)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Собирает AX.25-кадр (UI, Bell202 1200 бод) и сразу же\n'+
'принимает его обратно через ax25Rx — проверка сборки/CRC без эфира.\n'+
'Для реальной передачи выход mod идёт на "spk" вместо sum+noise.'});
nt.size.w=420; nt.size.h=140; applySize(nt);
const tx=addNode('ax25Tx',40,220,{src:'RA1ABC-1',dst:'APRS',path:'WIDE1-1,WIDE2-1',
  text:'!5540.00N/03730.00E>тест из DSP-верстака',baud:1200,loop:true});
tx.size.w=400; tx.size.h=300; applySize(tx);
const md=addNode('mod',480,220,{mode:'FSK',f0:1200,shift:1000,amp:.3,rise:.5});
const nz=addNode('osc',480,480,{wave:'noise',amp:.01});
const mx=addNode('sum',760,220,{ka:1,kb:1});
const dm=addNode('fsk',1000,220,{f0:1200,shift:1000,bw:600,center:false});
const hd=addNode('ax25Rx',1000,480,{baud:1200,nrzi:true,ax25:true});
hd.size.w=440; hd.size.h=280; applySize(hd);
const bv=addNode('blkview',1480,220,{fmt:'hex',wrap:48});
bv.size.w=380; bv.size.h=280; applySize(bv);
addEdge(tx.id,'bit',md.id,'bit');
addEdge(md.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',dm.id,'in');
addEdge(dm.id,'soft',hd.id,'in');
addEdge(hd.id,'blk',bv.id,'blk');
markWiresDirty();
});

preset('DTMF: кодер + декодер', function(){
clearAll();
const nt=addNode('note',40,40,{text:'dtmfTx генерирует тоны, dtmfRx их же и распознаёт —\n'+
'петля для проверки, без реального эфира.'});
nt.size.w=380; nt.size.h=100; applySize(nt);
const tx=addNode('dtmfTx',40,180,{text:'123A456B',toneMs:100,gapMs:60,loop:true});
const rx=addNode('dtmfRx',480,180,{thr:6,minMs:40});
rx.size.w=360; rx.size.h=160; applySize(rx);
const sc=addNode('scope',480,400,{span:4096,gain:1});
addEdge(tx.id,'out',rx.id,'in');
addEdge(tx.id,'out',sc.id,'in1');
markWiresDirty();
});

preset('Текст → биты → текст (кодировки)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Обобщённый слой текст↔биты (blk), отдельно от тайминга.\n'+
'Смените "coding" на обоих узлах одинаково — RTTY/PSK31/UTF-8.'});
nt.size.w=420; nt.size.h=100; applySize(nt);
const t2=addNode('txt2bits',40,180,{text:'CQ CQ DE TEST',coding:'Бодо ITA2'});
const b2=addNode('bits2txt',480,180,{coding:'Бодо ITA2'});
b2.size.w=380; b2.size.h=160; applySize(b2);
addEdge(t2.id,'blk',b2.id,'blk');
markWiresDirty();
});

preset('Olivia: передача и приём (петля)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Olivia 8/250: MFSK + Уолш-Адамар FEC (64-символьный блок).\n'+
'Попробуйте увеличить шум nz — Olivia держит шум даже сильнее сигнала.'});
nt.size.w=420; nt.size.h=100; applySize(nt);
const tx=addNode('oliviaTx',40,180,{text:'CQ CQ DE TEST OLIVIA',tones:'8',bw:'250',f0:1000,amp:.5,loop:true});
tx.size.w=380; tx.size.h=260; applySize(tx);
const nz=addNode('osc',480,180,{wave:'noise',amp:.15});
const mx=addNode('sum',480,400,{ka:1,kb:1});
const ff=addNode('fft',760,40,{size:'4096'});
const wf=addNode('sa',760,220,{fmin:800,fmax:1200,split:.4});
wf.size.w=480; wf.size.h=280; applySize(wf);
const rx=addNode('oliviaRx',1300,40,{tones:'8',bw:'250',f0:1000});
rx.size.w=380; rx.size.h=220; applySize(rx);
addEdge(tx.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
markWiresDirty();
});

preset('Contestia: передача и приём (петля)', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Contestia 8/500 — тот же движок MFSK+FEC, что и Olivia,\n'+
'просто другой набор Тонов/Полосы (быстрее, но чуть менее устойчива к шуму).'});
nt.size.w=420; nt.size.h=100; applySize(nt);
const tx=addNode('contestiaTx',40,180,{text:'CQ CQ DE TEST CONTESTIA',tones:'8',bw:'500',f0:1000,amp:.5,loop:true});
tx.size.w=380; tx.size.h=260; applySize(tx);
const nz=addNode('osc',480,180,{wave:'noise',amp:.15});
const mx=addNode('sum',480,400,{ka:1,kb:1});
const ff=addNode('fft',760,40,{size:'4096'});
const wf=addNode('sa',760,220,{fmin:700,fmax:1300,split:.4});
wf.size.w=480; wf.size.h=280; applySize(wf);
const rx=addNode('contestiaRx',1300,40,{tones:'8',bw:'500',f0:1000});
rx.size.w=380; rx.size.h=220; applySize(rx);
addEdge(tx.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
markWiresDirty();
});

preset('OFDM: текст через многочастотную модуляцию', function(){
clearAll();
const nt=addNode('note',40,40,{text:'Обобщённая OFDM-модуляция: 16 поднесущих, дифф. BPSK — сама\n'+
'на каждой поднесущей, без пилотов. txt2bits → ofdmTx → канал → ofdmRx → bits2txt.\n'+
'На стыке циклов текст будет ~на 1-2 "мусорных" байта — это скачок фазы при\n'+
'перезапуске петли, не баг протокола.'});
nt.size.w=460; nt.size.h=140; applySize(nt);
const t2=addNode('txt2bits',40,220,{text:'CQ CQ DE TEST OFDM WORKBENCH',coding:'UTF-8'});
const tx=addNode('ofdmTx',420,220,{carriers:16,spacing:31.25,f0:800,cp:25,mod:'BPSK',amp:.5,loop:true});
tx.size.w=380; tx.size.h=260; applySize(tx);
const nz=addNode('osc',420,520,{wave:'noise',amp:.1});
const mx=addNode('sum',820,220,{ka:1,kb:1});
const ff=addNode('fft',1080,40,{size:'4096'});
const wf=addNode('sa',1080,220,{fmin:700,fmax:1400,split:.4});
wf.size.w=460; wf.size.h=260; applySize(wf);
const rx=addNode('ofdmRx',1080,520,{carriers:16,spacing:31.25,f0:800,cp:25,mod:'BPSK'});
const b2=addNode('bits2txt',1600,520,{coding:'UTF-8'});
b2.size.w=380; b2.size.h=200; applySize(b2);
addEdge(t2.id,'blk',tx.id,'blk');
addEdge(tx.id,'out',mx.id,'a'); addEdge(nz.id,'out',mx.id,'b');
addEdge(mx.id,'out',ff.id,'in'); addEdge(ff.id,'spec',wf.id,'spec');
addEdge(mx.id,'out',rx.id,'in');
addEdge(rx.id,'blk',b2.id,'blk');
markWiresDirty();
});


/* ==========================================================================================
 * ПРЕСЕТ (отдельно от hfdl-all.js — подключай оба файла).
 *
 * НОВОЕ: costas теперь переключает order (BPSK/QPSK/8PSK) НА ЛЕТУ синхронно с фреймером —
 * преамбула/тренировка в HFDL всегда BPSK, целевая схема (тут 8PSK) — только во время данных
 * (см. current_mod_arity в hfdl.c). Раньше costas молотил один фиксированный order весь кадр,
 * из-за чего фаза грубо отслеживалась во время данных даже при верно определённом M1 —
 * подтверждено на реальном сигнале: c BPSK-преамбулой ловится чистый пик M1, но дальше
 * по кадру фаза плывёт без переключения.
 *
 * Планировщик (hfdlOrderSched) — copy той же state-machine, что в hfdlSymToBits, сидит на
 * тех же go/m1/clk. Получается цикл в графе (costas→...→hfdlOrderSched→costas.order) —
 * в этом движке циклы штатно поддерживаются (читают предыдущий блок, ~10мс задержка,
 * не критично на масштабах кадра).
 *
 * hfdlChipAvg — усредняет chip-пары для BPSK-скоростей (M1=0,1,4,5, codeRate=4).
 *
 * Проверено на реальной записи: структура (M1-детектор, деперемежитель, полином Витерби
 * "raw"=155/117) подтверждена отдельно, метрика Витерби падает до единиц-сотен от максимума
 * на настоящих кадрах, когда costas реально захватывает преамбулу.
 * hfdlDeint получает 'shiftCols' с hfdlShiftFromM1 (тот же приём, что и в hfdlChipAvg) —
 * сдвиг деперемежителя переключается на лету по M1, одно- и двухслотовые кадры (M1=0-3
 * vs 4-7) идут через один и тот же граф без ручной подстройки.
 * ========================================================================================== */
preset('HFDL: приём и карта самолётов', function(){
  clearAll();
  const nt=addNode('note',40,40,{text:
    'costas.order теперь переключается на лету (hfdlOrderSched) — преамбула/тренировка BPSK,\n'+
    'данные — целевая схема. Это цикл в графе (нормально для этого движка, ~1 блок задержки).\n'+
    'hfdlChipAvg — обязателен для BPSK-скоростей (M1=0,1,4,5), иначе Витерби получает вдвое\n'+
    'больше бит, чем нужно.\n'+
    'f0/freq=1455 — подтверждено x²-методом на ТРЁХ разных файлах (~1450-1456 Гц), НЕ 1800.\n'+
    'Несущая берётся из факта записи, а не бита в эфире — на другом файле её нужно перемерить.\n'+
    'eqBw по умолчанию 0.1 — сверено с настоящим hfdl.c (eqlms_cccf_set_bw(c->eq, 0.1f)), было 0.05.\n'+
    'ИЗВЕСТНАЯ НЕРЕШЁННАЯ ПРОБЛЕМА: даже с этими правками train-BER у нашей цепочки держится\n'+
    '~40-50% на реальных записях (проверено на очень чистом файле, SNR не виновник). Настоящий\n'+
    'dumphfdl декодирует те же файлы без проблем — расхождение в нашей архитектуре демода\n'+
    '(Костас/Гарднер/эквалайзер), не в параметрах и не в протокольном стеке выше. См. SESSION_NOTES.md.\n'+
    'Если что-то не так — смотри readout каждого узла по цепочке слева направо, там видно,\n'+
    'на каком шаге застряло (ждём кадр / M2 / TRAIN / DATA / bad_fcs).'});
  nt.size.w=560; nt.size.h=270; applySize(nt);

  const m =addNode('mic',40,300,{gainA:2});
  const bp=addNode('biquad',320,300,{type:'bp',freq:1455,Q:1.2});
  const co=addNode('costas',580,300,{f0:1455,order:'BPSK',loopHz:20,lp:2500});
  const fi=addNode('rrc',840,220,{baud:1800,beta:.35,span:8});
  const fq=addNode('rrc',840,400,{baud:1800,beta:.35,span:8});
  const ga=addNode('gardner',1100,300,{baud:1800,gain:.02});

  const m1=addNode('hfdlM1Match',1360,80,{baud:1800,thr:.5,dead:1500});
  const sched=addNode('hfdlOrderSched',1360,500,{m1:3});

  const s2b=addNode('hfdlSymToBits',1360,300,{descramble:true});
  const deint=addNode('hfdlDeint',1660,300,{shiftCols:17});
  const shiftM1=addNode('hfdlShiftFromM1',1660,500,{m1:3});
  const avg=addNode('hfdlChipAvg',1960,300,{});
  const vit=addNode('viterbiDec',2260,300,{K:7,g1:'155',g2:'117',tail:true,fmt:'hex'});
  vit.size.w=360; vit.size.h=240; applySize(vit);
  const stack=addNode('hfdlStack',2660,300,{freq:11384});
  const map=addNode('planeMap',2960,300,{ttl:30});
  map.size.w=560; map.size.h=340; applySize(map);

  addEdge(m.id,'a',bp.id,'in');
  addEdge(bp.id,'out',co.id,'in');
  addEdge(sched.id,'order',co.id,'order');             // ЦИКЛ: order по фреймеру, а не фикс. параметр
  addEdge(co.id,'I',fi.id,'in'); addEdge(co.id,'Q',fq.id,'in');
  addEdge(fi.id,'out',ga.id,'I'); addEdge(fq.id,'out',ga.id,'Q');

  addEdge(fi.id,'out',m1.id,'in');

  addEdge(ga.id,'sI',s2b.id,'I'); addEdge(ga.id,'sQ',s2b.id,'Q'); addEdge(ga.id,'clk',s2b.id,'clk');
  addEdge(m1.id,'go',s2b.id,'go'); addEdge(m1.id,'m1',s2b.id,'m1'); addEdge(m1.id,'flip',s2b.id,'flip');

  addEdge(ga.id,'clk',sched.id,'clk');
  addEdge(m1.id,'go',sched.id,'go'); addEdge(m1.id,'m1',sched.id,'m1');

  addEdge(s2b.id,'blk',deint.id,'blk');
  addEdge(s2b.id,'m1',shiftM1.id,'m1');
  addEdge(shiftM1.id,'shiftCols',deint.id,'shiftCols');
  addEdge(deint.id,'blk',avg.id,'blk');
  addEdge(s2b.id,'m1',avg.id,'m1');                    // из hfdlSymToBits (синхронизирован с blk), НЕ напрямую из hfdlM1Match!
  addEdge(avg.id,'blk',vit.id,'blk');
  addEdge(vit.id,'blk',stack.id,'blk');

  addEdge(stack.id,'lat',map.id,'lat');
  addEdge(stack.id,'lon',map.id,'lon');
  addEdge(stack.id,'trig',map.id,'trig');
  addEdge(stack.id,'id',map.id,'id');
  addEdge(stack.id,'gsLat',map.id,'gsLat');
  addEdge(stack.id,'gsLon',map.id,'gsLon');
  addEdge(stack.id,'gsTrig',map.id,'gsTrig');
  addEdge(stack.id,'gsName',map.id,'gsName');
  markWiresDirty();
});
