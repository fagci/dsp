// Emmet-цепочки палитры: node tools/test-chain.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/chain-kernels.js'),'utf8')+';this.C={chainParse,chainResolve,chainLeaves,chainLayout,chainEdges,chainText,chainPlaceY,arrangeLayout};',ctx);
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
if(bad){ console.log(bad+' FAIL'); process.exit(1); }
