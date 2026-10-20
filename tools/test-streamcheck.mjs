// Stream Check: node tools/test-streamcheck.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let defd=null;
const ctx=vm.createContext({URL,String,Math,Array,Object,Set,Map,Promise,Uint8Array,TextDecoder,AbortController,TypeError,fetch,setTimeout,clearTimeout,Date,
  Net:{url:u=>u}, def:d=>{ defd=d; }});
const src=['iptv-kernels','streamcheck-kernels','streamcheck'].map(f=>fs.readFileSync(path.join(root,'modules/'+f+'.js'),'utf8')).join('\n');
vm.runInContext(src+';this.T={scClassify,scDeepUrl,scPool,scProbe,scRun,scBuild};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };
const ts=new Uint8Array(400); ts[0]=0x47; ts[188]=0x47;
const enc=s=>new TextEncoder().encode(s);

ok('TS sync bytes',T.scClassify(200,'video/mp2t',ts).kind==='TS');
ok('TS: second sync byte missing → not TS',T.scClassify(200,'',Object.assign(new Uint8Array(400),{0:0x47})).ok===false);
ok('HTTP 404',T.scClassify(404,'',ts).why==='HTTP 404');
ok('empty',T.scClassify(200,'',new Uint8Array(0)).why==='empty answer');
ok('m3u8',T.scClassify(200,'application/vnd.apple.mpegurl',enc('#EXTM3U\n')).kind==='playlist');
ok('HTML page is not a stream',!T.scClassify(200,'text/html',enc('<html>')).ok);
ok('audio stream',T.scClassify(200,'audio/mpeg',enc('ID3xxxx')).ok);
ok('unknown binary',!T.scClassify(200,'',enc('abc')).ok);

const md='#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n';
ok('deep: last segment',T.scDeepUrl(md,'http://h/v/p.m3u8').url==='http://h/v/b.ts');
ok('deep: master → variant',T.scDeepUrl('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlo.m3u8\n','http://h/m.m3u8').url==='http://h/lo.m3u8');
ok('deep: fMP4 refused',!!T.scDeepUrl('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:4,\na.m4s\n','http://h/').fail);

// пул: не больше lim одновременно, все элементы обработаны
let cur=0, peak=0, seen=0;
const done=await T.scPool(Array.from({length:40},(_,i)=>i),()=>5,async()=>{ cur++; peak=Math.max(peak,cur); await new Promise(r=>setTimeout(r,5)); cur--; seen++; },()=>false);
ok('pool limit',peak===5 && seen===40 && done===40,'peak '+peak);
let cnt=0;
await T.scPool(Array.from({length:50},(_,i)=>i),()=>2,async()=>{ cnt++; await new Promise(r=>setTimeout(r,2)); },()=>cnt>=10);
ok('pool stop',cnt>=10 && cnt<14,'ran '+cnt);

// настоящие запросы к локальному серверу
const srv=http.createServer((q,r)=>{
  const h={'access-control-allow-origin':'*'};
  if(q.url==='/ts'){ r.writeHead(200,{...h,'content-type':'video/mp2t'}); const t=Buffer.alloc(188*4); for(let i=0;i<4;i++) t[i*188]=0x47; r.write(t); const iv=setInterval(()=>r.write(t),20); q.on('close',()=>clearInterval(iv)); return; }
  if(q.url==='/404'){ r.writeHead(404,h); r.end('no'); return; }
  if(q.url==='/html'){ r.writeHead(200,{...h,'content-type':'text/html'}); r.end('<html>hi</html>'); return; }
  if(q.url==='/slow'){ return; }
  if(q.url==='/hls.m3u8'){ r.writeHead(200,{...h,'content-type':'application/vnd.apple.mpegurl'}); r.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns1.ts\n'); return; }
  if(q.url==='/bad.m3u8'){ r.writeHead(200,{...h,'content-type':'application/vnd.apple.mpegurl'}); r.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nmissing.ts\n'); return; }
  if(q.url==='/s1.ts'){ r.writeHead(200,{...h,'content-type':'video/mp2t'}); const t=Buffer.alloc(188*3); for(let i=0;i<3;i++) t[i*188]=0x47; r.end(t); return; }
  r.writeHead(404,h); r.end();
});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const B='http://127.0.0.1:'+srv.address().port;
const mk=p=>({p:{threads:4,timeout:1,mode:'auto',deep:false,proxy:false,bytes:1024,...p},acs:new Set(),job:0,res:new Map(),rows:null});
const P=async(n,path)=>T.scProbe(n,B+path);
let n=mk({});
ok('probe: TS stream',(await P(n,'/ts')).kind==='TS');
ok('probe: 404',(await P(n,'/404')).why==='HTTP 404');
ok('probe: html',!(await P(n,'/html')).ok);
const t0=Date.now(), sl=await P(n,'/slow');
ok('probe: timeout',sl.why==='timeout' && Date.now()-t0<2000,sl.why);
ok('probe: playlist',(await P(n,'/hls.m3u8')).kind==='playlist');
ok('probe: closed port → dead',!(await T.scProbe(n,'http://127.0.0.1:1/x')).ok);
n=mk({deep:true});
ok('deep: good HLS',(await P(n,'/hls.m3u8')).kind==='HLS');
ok('deep: missing segment',(await P(n,'/bad.m3u8')).why.startsWith('segment:'));
n=mk({});
ok('no leaked controllers',n.acs.size===0);

// весь прогон: строки живые / мёртвые, повтор адреса, строка без url
n=mk({threads:3});
const rows=[{name:'a',url:B+'/ts',n:1},{name:'b',url:B+'/404',n:2},{name:'c',url:B+'/ts',n:3},{name:'d',n:4},{name:'e',url:B+'/hls.m3u8',n:5}];
n.rows=rows; await T.scRun(n,rows); T.scBuild(n);
ok('run: alive',n.outAlive.map(r=>r.name).join()==='a,c,e' && n.outAlive[0].alive===1 && n.outAlive[0].check==='TS');
ok('run: dead with reason',n.outDead.map(r=>r.name+':'+r.why).join()==='b:HTTP 404,d:no http(s) url');
ok('run: row keeps its fields',n.outAlive[1].n===3);
ok('run: same url probed once',n.res.size===3);
srv.close(); srv.closeAllConnections?.();
console.log(bad ? bad+' failed' : 'all ok'); process.exit(bad ? 1 : 0);
