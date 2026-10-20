// IP Camera / Camera Archive: node tools/test-camera.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({btoa,unescape,encodeURIComponent,decodeURIComponent,String,Math,Array,Object,Date,Uint8Array,Uint16Array});
vm.runInContext(fs.readFileSync(path.join(root,'modules/camera-kernels.js'),'utf8')+
  ';this.T={camSplitAuth,camKind,camKindByType,camPick,camDiff,camThumb,camShouldSave,camStamp,camFolder,camPrune,camNearest,camDensity};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

const a=T.camSplitAuth('http://admin:p%40ss@10.0.0.5:8080/video.mjpg?x=1');
ok('auth split',a.url==='http://10.0.0.5:8080/video.mjpg?x=1' && a.auth==='Basic '+btoa('admin:p@ss'),JSON.stringify(a));
ok('no auth',T.camSplitAuth('https://h/a.jpg').auth==='' && T.camSplitAuth('https://h/a.jpg').url==='https://h/a.jpg');

const K=T.camKind;
ok('kind hls',K('http://h/live/index.m3u8?t=1')==='hls');
ok('kind snapshot',K('http://h/snapshot.cgi')==='snapshot' && K('http://h/cam.jpg')==='snapshot' && K('http://h/ISAPI/Streaming/channels/101/picture?snapShotImageType=JPEG')==='snapshot');
ok('kind mjpeg',K('http://h/axis-cgi/mjpg/video.cgi')==='mjpeg' && K('http://h/cam/mjpeg')==='mjpeg' && K('http://h:81/stream')==='mjpeg');
ok('kind rtsp',K('rtsp://h/live')==='rtsp');
ok('kind page',K('http://h/index.html')==='page' && K('http://h/')==='page');
ok('kind auto',K('http://h/cgi-bin/foo')==='auto' && K('ftp://h')==='');
ok('kind by type',T.camKindByType('multipart/x-mixed-replace;boundary=x')==='mjpeg' && T.camKindByType('image/jpeg')==='snapshot' &&
  T.camKindByType('application/vnd.apple.mpegurl')==='hls' && T.camKindByType('text/html')==='page' && T.camKindByType('')==='');

const rows=[{id:'a',name:'Gate',url:'http://h/a'},{id:'b',name:'Yard',url:'http://h/b'},{name:'no url'},{id:'c',name:'Garage door',url:'http://h/c'}];
ok('pick first',T.camPick(rows,'')?.id==='a' && T.camPick(rows,0)?.id==='a');
ok('pick number skips rows without url',T.camPick(rows,3)?.id==='c' && T.camPick(rows,'2')?.id==='b' && T.camPick(rows,9)===null);
ok('pick name/id/part/url',T.camPick(rows,'yard')?.id==='b' && T.camPick(rows,'c')?.id==='c' && T.camPick(rows,'garage')?.id==='c' && T.camPick(rows,'http://h/a')?.id==='a' && T.camPick(rows,'zzz')===null);
ok('pick empty list',T.camPick([],1)===null && T.camPick(null,1)===null);

const g1=new Uint8Array(768).fill(100), g2=new Uint8Array(768).fill(100), g3=new Uint8Array(768).fill(200);
ok('diff same/different',T.camDiff(g1,g2)===0 && Math.abs(T.camDiff(g1,g3)-100/255)<1e-9 && T.camDiff(null,g1)===1);
const id={width:64,height:48,data:new Uint8ClampedArray(64*48*4).fill(255)};
const th=T.camThumb(id);
ok('thumb',th.length===768 && th.every(v=>v>=254),th[0]);

const S=o=>T.camShouldSave({interval:10,motion:0,diff:0,...o});
ok('save first',S({now:5,last:null}));
ok('save by interval',!S({now:9,last:0}) && S({now:10,last:0}));
ok('save on motion',S({now:3,last:0,motion:.05,diff:.1}) && !S({now:3,last:0,motion:.05,diff:.01}) && !S({now:.5,last:0,motion:.05,diff:.9}));

ok('stamp',/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/.test(T.camStamp(Date.UTC(2026,9,20,12,0,0))));
ok('folder name',T.camFolder('Front/Door: 1?')==='Front_Door_ 1_' && T.camFolder('  ')==='camera');

const D=864e5, now=100*D;
const fr=[{id:1,t:now-10*D},{id:2,t:now-3*D},{id:3,t:now-2*D},{id:4,t:now-D},{id:5,t:now}];
ok('prune by age',T.camPrune(fr,now,7,0).map(f=>f.id).join()==='1');
ok('prune by count',T.camPrune(fr,now,0,3).map(f=>f.id).join()==='1,2');
ok('prune both, unsorted',T.camPrune([...fr].reverse(),now,7,3).map(f=>f.id).sort().join()==='1,2');
ok('prune none',T.camPrune(fr,now,0,0).length===0);

const ix=[{t:10},{t:20},{t:40},{t:100}];
ok('nearest',T.camNearest(ix,0)===0 && T.camNearest(ix,14)===0 && T.camNearest(ix,16)===1 && T.camNearest(ix,31)===2 && T.camNearest(ix,1000)===3 && T.camNearest([],5)===-1);
const dn=T.camDensity(ix,10,100,3);
ok('density',dn.join()==='2,1,1' || dn.join()==='3,0,1',dn.join());
process.exit(bad ? 1 : 0);
