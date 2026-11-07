// Emmet-цепочки палитры: node tools/test-chain.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/chain-kernels.js'),'utf8')+';this.C={chainParse,chainResolve,chainLeaves,chainLayout,chainEdges,chainText};',ctx);
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
if(bad){ console.log(bad+' FAIL'); process.exit(1); }
