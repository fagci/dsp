// Podcasts / Webcams / Free Music: node tools/test-online.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const defs={}, calls=[];
let routes={};
const mkFetch=()=>async(u,o)=>{
  calls.push(String(u));
  const k=Object.keys(routes).find(k=>String(u).includes(k));
  if(!k) throw new TypeError('Failed to fetch');
  const v=routes[k];
  if(v.status && v.status>=400) return {ok:false,status:v.status};
  const body=v.bytes ?? (typeof v.body==='string' ? new TextEncoder().encode(v.body) : new TextEncoder().encode(JSON.stringify(v.body)));
  let sent=false;
  return {ok:true,status:200,json:async()=>JSON.parse(new TextDecoder().decode(body)),text:async()=>new TextDecoder().decode(body),
    blob:async()=>new Blob([body]),body:{getReader:()=>({read:async()=>sent ? {done:true} : (sent=true,{done:false,value:body})})}};
};
const ctx=vm.createContext({URL,URLSearchParams,String,Number,Math,Array,Object,Set,Map,Promise,JSON,Uint8Array,TextEncoder,TextDecoder,Blob,
  AbortController,TypeError,Date,parseInt,isFinite,encodeURIComponent,performance,setTimeout,clearTimeout,
  fetch:(...a)=>ctx.__fetch(...a), __fetch:mkFetch(),
  Net:{url:u=>'PROXY/'+encodeURIComponent(u)}, def:d=>{ defs[d.id]=d; },
  setMod:(n,k,v)=>{ n.p[k]=v; }, recNum:v=>typeof v==='number'&&isFinite(v)?v:null, recList:v=>Array.isArray(v)?v:v?[v]:[],
  GeoMe:{lat:null,lon:null},
  createImageBitmap:async()=>({width:8,height:4,close(){}}),
  document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){},getImageData:(x,y,w,h)=>({width:w,height:h})})})}});
const src=['online-kernels','online'].map(f=>fs.readFileSync(path.join(root,'modules/'+f+'.js'),'utf8')).join('\n');
vm.runInContext(src+';this.K={olFeed,olItunes,olOpenverse,olArchiveItems,olArchiveFiles,olCamKind,olWebcams,olWebcamQuery,olJpegFrame,olFind,olDur,olFmtDur};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const node=(id,p={})=>{ const d=defs[id]; const n={p:{...Object.fromEntries(d.params.filter(q=>q.d!==undefined).map(q=>[q.n,q.d])),...p},el:null}; d.init(n); return n; };
const wait=ms=>new Promise(r=>setTimeout(r,ms));

// --- разбор
ok('duration h:m:s',K.olDur('1:02:03')===3723 && K.olDur('12:30')===750 && K.olDur('90')===90 && K.olDur('x')===0);
ok('format duration',K.olFmtDur(3723)==='1:02:03' && K.olFmtDur(75)==='1:15' && K.olFmtDur(0)==='');
const rss=`<?xml version="1.0"?><rss xmlns:itunes="x"><channel><title>Show &amp; Tell</title><itunes:author>Ann</itunes:author>
<itunes:image href="http://i/x.jpg"/>
<item><title><![CDATA[Ep 2: <b>two</b>]]></title><pubDate>Tue, 02 Jan 2024 10:00:00 GMT</pubDate><itunes:duration>45:10</itunes:duration>
<enclosure url="http://h/2.mp3?x=1&amp;y=2" length="1000" type="audio/mpeg"/></item>
<item><title>Ep 1</title><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><itunes:duration>3600</itunes:duration><enclosure url='https://h/1.mp3' type="audio/mpeg"/></item>
<item><title>No audio</title></item></channel></rss>`;
const f=K.olFeed(rss);
ok('feed title/author/image',f.title==='Show & Tell' && f.author==='Ann' && f.image==='http://i/x.jpg');
ok('feed: 2 episodes with audio',f.items.length===2 && f.items[0].n===1 && f.items[1].n===2);
ok('feed: CDATA kept, entity in url decoded',f.items[0].label==='Ep 2: <b>two</b>' && f.items[0].url==='http://h/2.mp3?x=1&y=2');
ok('feed: date, duration, size',f.items[0].date==='2024-01-02' && f.items[0].dur===2710 && f.items[0].size===1000 && f.items[1].dur===3600);
ok('not a feed',K.olFeed('<html></html>')===null);
const it=K.olItunes({results:[{collectionId:5,collectionName:'A',artistName:'B',feedUrl:'http://f/rss',primaryGenreName:'News',trackCount:9},{collectionId:6,collectionName:'no feed'}]});
ok('itunes: skips shows without feed',it.length===1 && it[0].url==='http://f/rss' && it[0].episodes===9 && it[0].id==='pod:5');
const ov=K.olOpenverse({results:[{id:'u1',title:'T',creator:'C',url:'https://a/x.mp3',duration:61000,genres:['jazz','blues'],license:'by-sa',license_version:'4.0',provider:'jamendo'},{id:'u2',title:'bad',url:'ftp://x'}]});
ok('openverse',ov.length===1 && ov[0].dur===61 && ov[0].license==='BY-SA 4.0' && ov[0].genre==='jazz, blues' && ov[0].source==='jamendo');
const ai=K.olArchiveItems({response:{docs:[{identifier:'abc',title:'Alb',creator:['X','Y'],downloads:7},{title:'no id'}]}});
ok('archive items',ai.length===1 && ai[0].ident==='abc' && ai[0].artist==='X, Y' && ai[0].home==='https://archive.org/details/abc');
const af=K.olArchiveFiles({files:[{name:'a/01 One.mp3',length:'61.5',title:'One'},{name:'02 Two.mp3',length:'3:00'},{name:'x.ogg'},{name:'cover.jpg'},{name:'t_64kb.mp3'},{name:'a_spectrogram.mp3'}],metadata:{title:'Alb',creator:'Z'}},'abc');
ok('archive files: mp3 only, junk dropped',af.length===2 && af[0].n===1);
ok('archive file url encoded',af[0].url==='https://archive.org/download/abc/a/01%20One.mp3',af[0].url);
ok('archive file fields',af[0].dur===61.5 && af[0].artist==='Z' && af[0].album==='Alb' && af[1].dur===180);
ok('archive falls back to ogg',K.olArchiveFiles({files:[{name:'x.ogg'}]},'i')[0].url.endsWith('x.ogg') && K.olArchiveFiles({files:[{name:'c.jpg'}]},'i').length===0);

ok('cam kind',K.olCamKind('http://a/b.jpg?t=1')==='image' && K.olCamKind('http://a/live.m3u8')==='hls' && K.olCamKind('http://a/x.mjpg')==='mjpeg'
  && K.olCamKind('http://a/axis-cgi/mjpg/video.cgi')==='mjpeg' && K.olCamKind('http://a/webcam.html')==='page');
const wc=K.olWebcams({elements:[
  {type:'node',id:1,lat:50.123456789,lon:8.5,tags:{name:'Peak','contact:webcam':'https://c/p.jpg'}},
  {type:'way',id:2,center:{lat:51,lon:9},tags:{'man_made':'surveillance','surveillance:type':'webcam',url:'https://c/live.html',operator:'City'}},
  {type:'node',id:3,lat:1,lon:2,tags:{'contact:webcam':'https://c/p.jpg'}},
  {type:'node',id:4,lat:1,lon:2,tags:{'contact:webcam':'not a url'}},
  {type:'node',id:5,lat:1,lon:2,tags:{'surveillance:type':'webcam'}}]});
ok('webcams: two, duplicates and junk dropped',wc.length===2,JSON.stringify(wc));
ok('webcams: fields',wc[0].id==='cam:n1' && wc[0].kind==='image' && wc[0].lat===50.12346 && wc[1].id==='cam:w2' && wc[1].lat===51 && wc[1].operator==='City' && wc[1].kind==='page');
ok('overpass query',K.olWebcamQuery(50,8,25,300)==='[out:json][timeout:25];(nwr["contact:webcam"](49.7752,7.6502,50.2248,8.3498);nwr["man_made"="surveillance"]["surveillance:type"="webcam"](49.7752,7.6502,50.2248,8.3498););out center tags 300;');
const jpg=[0xFF,0xD8,0xFF,0xE0,1,2,0xFF,0xD9], mj=Uint8Array.from([...Buffer.from('--b\r\nContent-Type: image/jpeg\r\n\r\n'),...jpg,...Buffer.from('\r\n--b')]);
ok('jpeg frame found',K.olJpegFrame(mj).length===8 && K.olJpegFrame(mj)[0]===0xFF);
ok('jpeg frame incomplete',K.olJpegFrame(Uint8Array.from([0xFF,0xD8,0xFF,0xE0,1,2]))===null && K.olJpegFrame(new Uint8Array(5))===null);
const L=[{id:'a:1',label:'Alpha',url:'http://x/1'},{id:'a:2',label:'Beta show',url:'http://x/2'}];
ok('find: number, id, url, name, part',K.olFind(L,2)===2 && K.olFind(L,'2')===2 && K.olFind(L,'a:1')===1 && K.olFind(L,'http://x/2')===2 && K.olFind(L,'alpha')===1 && K.olFind(L,'show')===2 && K.olFind(L,'zzz')===0 && K.olFind(L,5)===0);

// --- узлы с подменённой сетью
routes={'itunes.apple.com':{body:{results:[{collectionId:5,collectionName:'Show & Tell',feedUrl:'http://f/rss',trackCount:2}]}},'f/rss':{body:rss}};
let p=node('podcasts',{query:'tell'});
await defs.podcasts.params.find(q=>q.n==='search').fn(p); await wait(5);
ok('podcasts: search request',calls.at(-1).startsWith('https://itunes.apple.com/search?') && /term=tell/.test(calls.at(-1)) && /country=US/.test(calls.at(-1)) && /media=podcast/.test(calls.at(-1)));
let o=defs.podcasts.process(p,{});
ok('podcasts: rows out',o.rows.length===1 && o.rows[0].url==='http://f/rss' && o.episodes===null && o.url===null);
p.p.show='show'; defs.podcasts.process(p,{}); await wait(5);
o=defs.podcasts.process(p,{});
ok('podcasts: feed loaded by show name',o.episodes?.length===2 && o.count===2 && o.episodes[0].show==='Show & Tell');
o=defs.podcasts.process(p,{episode:2});
ok('podcasts: episode input picks',o.url==='https://h/1.mp3' && o.name==='Ep 1' && p.p.episode===2);
o=defs.podcasts.process(p,{episode:'ep 2'});
ok('podcasts: episode by name',o.url==='http://h/2.mp3?x=1&y=2');
o=defs.podcasts.process(p,{episode:'ep 2',next:1}); o=defs.podcasts.process(p,{episode:'ep 2',next:0});
ok('podcasts: next pulse steps once',o.name==='Ep 1');
p.p.proxy=true; o=defs.podcasts.process(p,{});
ok('podcasts: proxy wraps the audio url',o.url==='PROXY/'+encodeURIComponent('https://h/1.mp3'));
let q=node('podcasts'); routes={'bad/rss':{body:'<html>'}};
defs.podcasts.process(q,{feed:'http://bad/rss'}); await wait(5);
ok('podcasts: not a feed reported',/not a podcast feed/.test(q.msg),q.msg);
q=node('podcasts'); routes={};
defs.podcasts.process(q,{feed:'http://nocors/rss'}); await wait(5);
ok('podcasts: CORS hint',/CORS/.test(q.msg),q.msg);
q=node('podcasts'); q.p.show='ftp://x'; defs.podcasts.process(q,{});
ok('podcasts: unknown name reported',/no podcast/.test(q.msg),q.msg);
q=node('podcasts'); defs.podcasts.process(q,{feed:'ftp://x'});
ok('podcasts: non-http feed refused',/must start with http/.test(q.msg),q.msg);

routes={'overpass-api.de':{status:504},'overpass.kumi.systems':{body:{elements:[{type:'node',id:1,lat:50,lon:8,tags:{name:'Peak','contact:webcam':'https://c/p.jpg'}},{type:'node',id:2,lat:50.2,lon:8.1,tags:{name:'Page','contact:webcam':'https://c/x.html'}}]}},'c/p.jpg':{bytes:new Uint8Array(jpg)}};
let w=node('webcams',{radius:100});
await defs.webcams.params.find(q=>q.n==='search').fn(w);
ok('webcams: no centre',/no centre/.test(w.msg)); 
defs.webcams.process(w,{lat:50,lon:8});
await defs.webcams.params.find(q=>q.n==='search').fn(w); await wait(5);
ok('webcams: second mirror used after a 504',calls.some(c=>c.startsWith('https://overpass.kumi.systems')) && w.cams.length===2);
o=defs.webcams.process(w,{lat:50,lon:8});
ok('webcams: rows with icon',o.rows.length===2 && o.rows[0].icon==='📷' && o.count===2);
o=defs.webcams.process(w,{select:{id:'n:cam:n1'}}); await wait(10);
o=defs.webcams.process(w,{});
ok('webcams: selected image fetched',o.img?.rev===1 && o.name==='Peak' && o.url==='https://c/p.jpg',JSON.stringify([w.shotMsg,o.url]));
defs.webcams.process(w,{select:{id:'cam:n2'}}); o=defs.webcams.process(w,{});
ok('webcams: page kind has no url and says so',o.url===null && /web page/.test(w.shotMsg) && o.rows.find(r=>r.id==='cam:n2').color==='#ffd84a');
defs.webcams.process(w,{url:'https://z/live.m3u8'}); o=defs.webcams.process(w,{});
ok('webcams: direct url',o.url==='https://z/live.m3u8' && o.count===1);
w=node('webcams'); defs.webcams.process(w,{lat:1,lon:2});
ok('webcams: wires beat params',w.lat===1 && w.lon===2);
w=node('webcams',{lat:7,lon:8}); defs.webcams.process(w,{}); ok('webcams: params',w.lat===7);
ctx.GeoMe.lat=3; ctx.GeoMe.lon=4; w=node('webcams'); defs.webcams.process(w,{}); ok('webcams: My Position',w.lat===3 && w.lon===4);
routes={'cam/stream':{bytes:mj}};
w=node('webcams',{refresh:0}); defs.webcams.process(w,{url:'https://cam/stream.mjpg'}); await wait(10); o=defs.webcams.process(w,{});
ok('webcams: mjpeg frame cut out',o.img?.rev===1,w.shotMsg);

routes={'api.openverse.org':{body:{results:[{id:'u1',title:'T',creator:'C',url:'https://a/x.mp3',duration:61000}]}}};
let m=node('freeMusic',{query:'piano',limit:50});
await defs.freeMusic.params.find(q=>q.n==='search').fn(m); await wait(5);
ok('free music: openverse request, page size capped',/api\.openverse\.org\/v1\/audio\/\?/.test(calls.at(-1)) && /page_size=20/.test(calls.at(-1)) && /q=piano/.test(calls.at(-1)));
o=defs.freeMusic.process(m,{});
ok('free music: openverse rows are tracks',o.tracks.length===1 && o.tracks===o.rows && o.count===1);
o=defs.freeMusic.process(m,{track:1});
ok('free music: track pick',o.url==='https://a/x.mp3' && o.name==='C — T');
await defs.freeMusic.params.find(q=>q.n==='more').fn(m);
ok('free music: next page',/page=2/.test(calls.at(-1)));
routes={'archive.org/advancedsearch.php':{body:{response:{docs:[{identifier:'abc',title:'Alb',creator:'Z',downloads:3}]}}},
        'archive.org/metadata/abc':{body:{files:[{name:'01.mp3',length:'10'},{name:'02.mp3'}],metadata:{title:'Alb'}}}};
m=node('freeMusic',{source:'Internet Archive',query:'jazz'});
await defs.freeMusic.params.find(q=>q.n==='search').fn(m); await wait(5);
const au=decodeURIComponent(calls.at(-1));
ok('free music: archive query',/q=\(jazz\) AND mediatype:audio AND \(collection:\(opensource_audio OR netlabels\)\)/.test(au.replace(/\+/g,' ')) && /fl\[\]=identifier/.test(au) && /output=json/.test(au),au);
o=defs.freeMusic.process(m,{});
ok('free music: archive items first, no tracks yet',o.rows.length===1 && o.tracks===null);
m.p.album='alb'; defs.freeMusic.process(m,{}); await wait(5); o=defs.freeMusic.process(m,{});
ok('free music: album opens its files',o.tracks?.length===2 && o.tracks[0].url==='https://archive.org/download/abc/01.mp3');
m.p.proxy=true; o=defs.freeMusic.process(m,{track:2});
ok('free music: proxy wraps audio',o.url==='PROXY/'+encodeURIComponent('https://archive.org/download/abc/02.mp3'));
routes={'api.openverse.org':{status:429}}; m=node('freeMusic',{query:'x'});
await defs.freeMusic.params.find(q=>q.n==='search').fn(m);
ok('free music: rate limit reported',/429/.test(m.msg),m.msg);
m=node('freeMusic'); await defs.freeMusic.params.find(q=>q.n==='search').fn(m); ok('free music: empty query',/enter/.test(m.msg));

for(const id of ['podcasts','webcams','freeMusic']) ok(id+': readout draw',(()=>{ const n=node(id); n.el={querySelector:()=>({textContent:''})}; defs[id].draw(n,{width:10,height:10},{drawImage(){}}); return true; })());
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad?1:0);
