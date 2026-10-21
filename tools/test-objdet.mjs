// Object Detect: node tools/test-objdet.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Array,Set,Map,String});
vm.runInContext(fs.readFileSync(path.join(root,'modules/objdet-kernels.js'),'utf8')+
  ';this.T={odIou,odClasses,odFilter,odNorm,odTrack,odNewTracker,odSummary,odText,odColor};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const near=(a,b)=>Math.abs(a-b)<1e-9;

ok('iou same',near(T.odIou({x:0,y:0,w:1,h:1},{x:0,y:0,w:1,h:1}),1));
ok('iou none',T.odIou({x:0,y:0,w:.2,h:.2},{x:.5,y:.5,w:.2,h:.2})===0);
ok('iou half',near(T.odIou({x:0,y:0,w:1,h:1},{x:.5,y:0,w:1,h:1}),1/3));
ok('iou empty',T.odIou({x:0,y:0,w:0,h:0},{x:0,y:0,w:0,h:0})===0);

const cls=T.odClasses(' Person, car;dog ');
ok('classes parse',cls.size===3 && cls.has('person') && cls.has('car') && cls.has('dog'));
ok('classes empty',T.odClasses('')===null && T.odClasses('  , ')===null);
const L=[{label:'person'},{label:'Car'},{label:'cat'}];
ok('filter',T.odFilter(L,cls).length===2 && T.odFilter(L,null).length===3);

const n=T.odNorm([{bbox:[50,20,100,40],class:'dog',score:.9}],200,100);
ok('norm',n[0].label==='dog' && near(n[0].x,.25) && near(n[0].y,.2) && near(n[0].w,.5) && near(n[0].h,.4) && n[0].score===.9);

// трекинг: объект сдвигается, второй появляется, потом первый пропадает
const st=T.odNewTracker();
let d=[{label:'person',score:.9,x:.1,y:.1,w:.2,h:.4}];
ok('track new',T.odTrack(st,d,0)===1 && d[0].id===1 && d[0].age===0 && st.total===1);
d=[{label:'person',score:.9,x:.12,y:.1,w:.2,h:.4},{label:'person',score:.8,x:.7,y:.1,w:.2,h:.4}];
ok('track follow + new',T.odTrack(st,d,.5)===1 && d[0].id===1 && d[1].id===2 && near(d[0].age,.5) && st.total===2);
d=[{label:'car',score:.9,x:.12,y:.1,w:.2,h:.4}];
ok('other class is a new track',T.odTrack(st,d,1)===1 && d[0].id===3);
ok('stale dropped',st.tracks.every(t=>t.id===3 || 1-t.last<=1.5) && st.tracks.length===3);
d=[];
T.odTrack(st,d,3);
ok('all expire',st.tracks.length===0 && st.total===3);
d=[{label:'person',score:.9,x:.1,y:.1,w:.2,h:.4}];
ok('re-appear after expiry gets new id',T.odTrack(st,d,4)===1 && d[0].id===4);
// два рядом: каждый держит свой id
const s2=T.odNewTracker();
let a=[{label:'p',score:1,x:.1,y:.1,w:.2,h:.2},{label:'p',score:1,x:.35,y:.1,w:.2,h:.2}];
T.odTrack(s2,a,0);
let b=[{label:'p',score:1,x:.36,y:.1,w:.2,h:.2},{label:'p',score:1,x:.11,y:.1,w:.2,h:.2}];
T.odTrack(s2,b,.2);
ok('ids stay with objects',b[0].id===2 && b[1].id===1);

ok('summary',T.odSummary([{label:'cat'},{label:'person'},{label:'person'}])==='2× person, cat' && T.odSummary([])==='');
ok('text',T.odText([{label:'cat',score:.876,id:3},{label:'dog',score:.5}])==='#3 cat 88%\ndog 50%');
ok('color stable',T.odColor('person')===T.odColor('person') && T.odColor('person')!==T.odColor('car') && /^hsl\(/.test(T.odColor('x')));
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
