// Video Player (ядро): node tools/test-vplayer.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({String,Math,Array,Object,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/vplayer-kernels.js'),'utf8')+';this.T={vpKind,vpSources,vpFind,vpResume,vpPut,vpFmt,vpSeek,vpRec};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

ok('kind',T.vpKind('http://h/a.m3u8?t=1')==='hls' && T.vpKind('http://h/a.mpd')==='dash' && T.vpKind('http://h/a.mp4')==='file' && T.vpKind('')==='file');
const L=T.vpSources([{name:'A',url:'http://h/a.mp4'},{title:'B',link:' https://h/b.m3u8 '},{name:'bad',url:'ftp://x'},{url:'http://h/c.webm'},null,{name:'no'}]);
ok('sources',L.length===3 && L[1].name==='B' && L[1].url==='https://h/b.m3u8' && L[2].name==='h/c.webm',JSON.stringify(L.map(x=>x.name)));
ok('sources not array',T.vpSources(null).length===0);
ok('find number/name/url',T.vpFind(L,2)===1 && T.vpFind(L,'2')===1 && T.vpFind(L,'b')===1 && T.vpFind(L,'http://h/a.mp4')===0 && T.vpFind(L,9)===-1 && T.vpFind(L,'')===-1 && T.vpFind(L,'zzz')===-1);
ok('resume',T.vpResume(null)===0 && T.vpResume({pos:3,dur:100})===0 && T.vpResume({pos:40,dur:100})===40 && T.vpResume({pos:96,dur:100})===0 && T.vpResume({pos:90,dur:100})===0 && T.vpResume({pos:600,dur:0})===600);
const m={};
const e=T.vpPut(m,'u1',42.34,100,'A',1000,3);
ok('put',e && e.pos===42.3 && e.dur===100 && !e.done && m.u1===e);
ok('put done',T.vpPut(m,'u1',97,100,'A',1001,3).done===true);
ok('put bad',T.vpPut(m,'',5,100,'A',1,3)===null && T.vpPut(m,'u',-1,100,'A',1,3)===null && T.vpPut(m,'u',NaN,100,'A',1,3)===null);
T.vpPut(m,'u2',1,0,'',1002,3); T.vpPut(m,'u3',1,0,'',1003,3); T.vpPut(m,'u4',1,0,'',1004,3);
ok('cap drops oldest',Object.keys(m).length===3 && !m.u1 && m.u4,JSON.stringify(Object.keys(m)));
ok('fmt',T.vpFmt(65)==='1:05' && T.vpFmt(3725)==='1:02:05' && T.vpFmt(0)==='0:00' && T.vpFmt(NaN)==='0:00' && T.vpFmt(Infinity)==='0:00');
ok('seek',T.vpSeek(50,10,100)===60 && T.vpSeek(5,-10,100)===0 && T.vpSeek(95,10,100)===100 && T.vpSeek(95,10,0)===105);
const r=T.vpRec('u','N',{pos:50,dur:200,done:false,t:5});
ok('rec',r.pct===25 && r.done===0 && r.name==='N' && r.url==='u');
if(bad){ console.log(bad+' failed'); process.exit(1); }
console.log('all ok');
