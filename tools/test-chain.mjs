// Emmet-цепочки палитры: node tools/test-chain.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String,Set,Map,Object,JSON,Number,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/chain-kernels.js'),'utf8')+';this.C={chainParse,chainResolve,chainLeaves,chainLayout,chainEdges,chainText,chainPlaceY,arrangeLayout,chainPinsParse,chainParamsParse,chainValue,chainExpand,chainDefSplit,chainFindPin,chainFromGraph};',ctx);
const C=ctx.C;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const txt=(s,have)=>{ const r=C.chainParse(s); C.chainResolve(r.ast,seg=>have===undefined||have.includes(seg)?{id:seg}:null); return (r.cont?'>':'')+C.chainText(r.ast,l=>l.seg); };

ok('простая цепочка',txt('mic>fft>sa')==='mic → fft → sa');
ok('продолжение',C.chainParse('>fft>sa').cont===true && txt('>fft>sa')==='>fft → sa');
ok('пустая строка',txt('')==='' && C.chainParse('>').cont);
ok('группа',txt('usb>(dac,sa,iqshift>iqdec)')==='usb → ( dac | sa | iqshift → iqdec )');
ok('пример из задачи',txt('usb>(dac,sa,iqshift>iqdec>demod>digvo>mbe>dac)')==='usb → ( dac | sa | iqshift → iqdec → demod → digvo → mbe → dac )');
ok('вложенная группа',txt('a>(b>(c,d),e)>f')==='a → ( b → ( c | d ) | e ) → f');
ok('верхняя запятая',txt('mic>fft,usb>sa')==='( mic → fft | usb → sa )');
ok('незакрытая скобка',txt('a>(b,c')==='a → ( b | c )');
ok('лишняя скобка',txt('a>b)>c')==='a → b | c' || txt('a>b)>c').includes('a → b'));
ok('пробелы в именах',txt('spectrum analyzer > fft')==='spectrum analyzer → fft');
ok('лишние «>»',txt('a>>b>')==='a → b');
// несовпавший лист обрывает свою ветку, соседние живут
ok('обрыв ветки',txt('a>(b>zzz>c,d)',['a','b','c','d'])==='a → ( b | d )');
ok('весь хвост пропал',txt('a>zzz>c',['a','c'])==='a');
// раскладка
{ const r=C.chainParse('usb>(dac,sa,x>y)'); C.chainResolve(r.ast,seg=>({id:seg})); const w=C.chainLayout(r.ast); const L=C.chainLeaves(r.ast).map(l=>l.seg+':'+l.col+','+l.row).join(' ');
  ok('раскладка',L==='usb:0,0 dac:1,0 sa:1,1 x:1,2 y:2,2' && w.w===3 && w.h===3,L); }
// провода
{ const r=C.chainParse('(a,b)>c>(d,e)'); C.chainResolve(r.ast,seg=>({id:seg})); const E=[]; C.chainEdges(r.ast,[],(f,t)=>E.push(f.seg+t.seg));
  ok('провода',E.join()==='ac,bc,cd,ce',E.join()); }
{ const r=C.chainParse('>x>(y,z)'); C.chainResolve(r.ast,seg=>({id:seg})); const E=[]; C.chainEdges(r.ast,[{seg:'S'}],(f,t)=>E.push(f.seg+t.seg));
  ok('от выделенного',E.join()==='Sx,xy,xz',E.join()); }
{ const r=C.chainParse(Array.from({length:100},(_, i)=>'m'+i).join('>')); ok('предел',C.chainLeaves(r.ast).length===40); }
// высоты ветвей: sa (300) и соседи без пустот
{ const r=C.chainParse('usb>(dac,sa,x)'); C.chainResolve(r.ast,seg=>({id:seg})); const H={usb:100,dac:80,sa:300,x:60};
  C.chainPlaceY(r.ast,l=>({w:100,h:H[l.seg]}),20); const Y=C.chainLeaves(r.ast).map(l=>l.seg+':'+l.y).join(' ');
  ok('y по высоте',Y==='usb:0 dac:0 sa:100 x:420',Y); }
// упорядочить граф
{ const N=[{id:'a',x:500,y:500,w:100,h:50},{id:'b',x:0,y:0,w:100,h:50},{id:'c',x:900,y:20,w:100,h:50},{id:'d',x:10,y:900,w:100,h:50},{id:'z',x:5,y:5,w:100,h:50}];
  const P=C.arrangeLayout(N,[{from:'a',to:'b'},{from:'b',to:'c'},{from:'a',to:'c'},{from:'a',to:'d'}]);
  ok('слои',P.a.x<P.b.x && P.b.x<P.c.x && P.d.x===P.b.x,JSON.stringify(P));
  const PC=C.arrangeLayout(N,[{from:'a',to:'b'},{from:'b',to:'c'},{from:'c',to:'a'}]); ok('цикл не виснет',Object.keys(PC).length===5);
  ok('одиночка под графом',P.z.y>Math.max(P.a.y,P.b.y,P.c.y,P.d.y));
  ok('без наложений',N.every((u,i)=>N.every((v,j)=>i>=j||P[u.id].x+100<=P[v.id].x||P[v.id].x+100<=P[u.id].x||P[u.id].y+50<=P[v.id].y||P[v.id].y+50<=P[u.id].y))); }

// ---- пины [A>B, A<B], параметры {k:v}, метка * ----
{ const r=C.chainParse('usb>sa[spec>spec2, freq<f1]'); const sa=C.chainLeaves(r.ast)[1];
  ok('пины: вперёд и назад',sa.seg==='sa' && sa.pins.length===2 && sa.pins[0].from==='spec' && sa.pins[0].to==='spec2' && sa.pins[0].dir==='>' && sa.pins[1].dir==='<' && sa.pins[1].from==='freq' && sa.pins[1].to==='f1',JSON.stringify(sa.pins));
  ok('пины не ломают текст цепочки',txt('usb>sa[spec>spec2, freq<f1]>fft')==='usb → sa → fft'); }
ok('запятая в [] — не ветка',C.chainLeaves(C.chainParse('a>b[x>y,z<w]>c').ast).length===3);
ok('«[» и «{» в имени не нужны: пробел перед скобкой',C.chainLeaves(C.chainParse('usb > sa [spec>spec2] {f:1}').ast)[1].pins.length===1);
ok('пины без стрелки — в bad',C.chainLeaves(C.chainParse('a>b[spec]').ast)[1].bad.join()==='spec');
ok('незакрытая [ дочитывается до конца',C.chainLeaves(C.chainParse('a>b[x>y').ast)[1].pins[0].to==='y');
{ const p=C.chainParamsParse("sr:2.4M, freq:433.9M, gain:-3, mode:'FM, wide', on:true, off=false, name:abc");
  ok('параметры: приставки k/M/G, числа, строки с запятой, bool, «=»',p.sr===2400000 && p.freq===433900000 && p.gain===-3 && p.mode==='FM, wide' && p.on===true && p.off===false && p.name==='abc',JSON.stringify(p)); }
ok('100k и 1.5G',C.chainValue('100k')===100000 && C.chainValue('1.5G')===1.5e9 && C.chainValue('1e6')===1e6 && C.chainValue('12abc')==='12abc');
{ const l=C.chainLeaves(C.chainParse('rtlsdr*>sa{fmin:100M}').ast); ok('метка * и параметры',l[0].mark===true && l[1].mark===false && l[1].params.fmin===100000000); }
{ const r=C.chainParse('a>(b[x>y],c{k:1})'); const L=C.chainLeaves(r.ast); C.chainResolve(r.ast,seg=>({id:seg}));
  const E=[]; C.chainEdges(r.ast,[],(f,t,pins)=>E.push(f.seg+t.seg+(pins&&pins.length?'#'+pins.length:'')));
  ok('пины и параметры в ветках; connect получает пины',E.join()==='ab#1,ac' && L[2].params.k===1,E.join()); }
// ---- chunk-и ----
{ const defs={mysdr:'rtlsdr*>sa[spec>spec,freq<f1]{sr:2.4M}', two:'mysdr>iqshift'};
  const get=k=>defs[k]||null;
  const r=C.chainParse('MySDR>demod'); const e=C.chainExpand(r.ast,get); C.chainResolve(e,seg=>({id:seg}));
  ok('chunk раскрывается на месте',C.chainLeaves(e).map(l=>l.seg).join()==='rtlsdr,sa,demod');
  const E=[]; C.chainEdges(e,[],(f,t,pins)=>E.push(f.seg+'>'+t.seg+(pins&&pins.length?'#'+pins.length:'')));
  ok('выход chunk-а — лист с «*» (SDR), а не хвост (sa)',E.join()==='rtlsdr>sa#2,rtlsdr>demod',E.join());
  ok('параметры и пины внутри chunk-а сохраняются',C.chainLeaves(e)[1].params.sr===2400000 && C.chainLeaves(e)[1].pins[1].dir==='<');
  const e2=C.chainExpand(C.chainParse('two>x').ast,get); C.chainResolve(e2,seg=>({id:seg}));
  ok('chunk в chunk-е',C.chainLeaves(e2).map(l=>l.seg).join()==='rtlsdr,sa,iqshift,x');
  const loop={a:'b>x',b:'a>y'}; const e3=C.chainExpand(C.chainParse('a').ast,k=>loop[k]||null);
  ok('петля chunk-ов не виснет',C.chainLeaves(e3).length>0 && C.chainLeaves(e3).length<10);
  const e4=C.chainExpand(C.chainParse('mysdr[spec>spec2]>x').ast,get); const E4=[]; C.chainResolve(e4,seg=>({id:seg}));
  C.chainEdges(e4,[{seg:'SRC'}],(f,t,pins)=>E4.push(f.seg+'>'+t.seg+(pins&&pins.length?'#'+pins[0].to:'')));
  ok('пины на самом chunk-е — на входной провод',E4[0]==='SRC>rtlsdr#spec2',E4.join()); }
ok('chunk-ов нет — лист как был',C.chainExpand(C.chainParse('a>b').ast,()=>null).items.length===2);
{ const d=C.chainDefSplit('mysdr = rtlsdr>sa'); ok('имя = цепочка',d.name==='mysdr' && d.src==='rtlsdr>sa');
  ok('без = или пустое имя — не определение',C.chainDefSplit('rtlsdr>sa')===null && C.chainDefSplit(' = a>b')===null && C.chainDefSplit('a>b[x=y]')===null);
  ok('имя с пробелом и пустая правая часть',C.chainDefSplit('my sdr =').name==='my sdr' && C.chainDefSplit('my sdr =').src===''); }
// ---- нечёткий пин ----
{ const pins=[{n:'spec',t:'spec'},{n:'spec2',t:'spec'},{n:'centerFreq',t:'num'},{n:'f1',t:'num'}];
  ok('пин: точное важнее начала',C.chainFindPin(pins,'spec').n==='spec' && C.chainFindPin(pins,'SPEC2').n==='spec2');
  ok('пин: по началу и по вхождению',C.chainFindPin(pins,'cent').n==='centerFreq' && C.chainFindPin(pins,'Freq').n==='centerFreq');
  ok('пин: нет — null, фильтр по типу',C.chainFindPin(pins,'zzz')===null && C.chainFindPin(pins,'spec',p=>p.t==='num')===null); }
// ---- выделение → строка и обратно ----
{ const nodes=[{id:1,type:'rtlsdr',x:0,y:0,params:{sr:2400000}},{id:2,type:'sa',x:300,y:0}];
  const edges=[{from:1,fp:'spec',to:2,tp:'spec'},{from:2,fp:'f1',to:1,tp:'freq'}];
  const g=C.chainFromGraph(nodes,edges,{isSource:t=>t==='rtlsdr',auto:()=>['iq','in']});
  ok('SDR+SA с обратным проводом',g.text==='rtlsdr*{sr:2400000}>sa[spec>spec, freq<f1]' && g.lost.length===0,g.text);
  const back=C.chainParse(g.text); const l=C.chainLeaves(back.ast);
  ok('строка читается обратно: пины и параметры те же',l[0].mark && l[0].params.sr===2400000 && l[1].pins.length===2 && l[1].pins[1].dir==='<' && l[1].pins[1].from==='freq'); }
{ // провод совпал с автоподбором — пины не пишем
  const g=C.chainFromGraph([{id:1,type:'mic',x:0,y:0},{id:2,type:'fft',x:1,y:0},{id:3,type:'sa',x:2,y:0}],[{from:1,fp:'out',to:2,tp:'in'},{from:2,fp:'spec',to:3,tp:'spec'}],{auto:(a,b)=>a===1?['out','in']:['spec','spec']});
  ok('автоподбор — без пинов',g.text==='mic>fft>sa',g.text); }
{ // ветвление: sdr → dac, sa, iqshift>iqdec
  const N=[{id:1,type:'usb',x:0,y:0},{id:2,type:'dac',x:1,y:0},{id:3,type:'sa',x:1,y:1},{id:4,type:'iqshift',x:1,y:2},{id:5,type:'iqdec',x:2,y:2}];
  const E=[1,2,3,4].map(i=>({from:1,fp:'o',to:i+1,tp:'i'})).slice(0,3).concat([{from:4,fp:'o',to:5,tp:'i'}]);
  const g=C.chainFromGraph(N,E,{auto:()=>['o','i']}); ok('ветви',g.text==='usb>(dac,sa,iqshift>iqdec)',g.text); }
{ // слияние двух входов — второй провод в цепочке не выразить
  const g=C.chainFromGraph([{id:1,type:'a',x:0,y:0},{id:2,type:'b',x:0,y:1},{id:3,type:'c',x:1,y:0}],[{from:1,fp:'o',to:3,tp:'x'},{from:2,fp:'o',to:3,tp:'y'}],{auto:()=>['o','x']});
  ok('слияние: один провод в lost, оба корня в строке',g.lost.length===1 && g.text==='a>c,b',g.text+' lost '+g.lost.length); }
{ const g=C.chainFromGraph([{id:1,type:'a',x:0,y:0},{id:2,type:'b',x:1,y:0}],[],{}); ok('без проводов — ветки через запятую',g.text==='a,b'); }
ok('цикл без корня: корень — левый',C.chainFromGraph([{id:1,type:'a',x:5,y:0},{id:2,type:'b',x:1,y:0}],[{from:1,fp:'o',to:2,tp:'i'},{from:2,fp:'o',to:1,tp:'i'}],{auto:()=>null}).text.startsWith('b'));

if(bad){ console.log(bad+' FAIL'); process.exit(1); }
