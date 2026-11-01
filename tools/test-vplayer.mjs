// Video Player (ядро): node tools/test-vplayer.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({String,Math,Array,Object,isFinite,URL,encodeURIComponent,decodeURIComponent});
vm.runInContext(fs.readFileSync(path.join(root,'modules/vplayer-kernels.js'),'utf8')+';this.T={vpKind,vpSources,vpFind,vpResume,vpPut,vpFmt,vpSeek,vpRec,vpEpisode,vpLabel,vpGroup,vpContinue,vpMark,vpIaSearchUrl,vpIaItems,vpIaId,vpIaFiles,vpFilter,VP_IPTV_URL,VP_SAMPLES,vpIsIaPage,vpMediaErr,vpWmSearchUrl,vpWmItems,vpPtSearchUrl,vpPtItems,vpPtId,vpPtFiles,vpIptvUrl,VP_URL_RE,vpTorrentRef,vpMagnetName,vpTorrentRows,vpTorrentLine,vpIaTorrentUrl,vpMagnetHash,vpTorrentSearchLine};',ctx);
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

// серии
const E=T.vpEpisode;
ok('episode S01E02',E('Show S02E05 title').s===2 && E('Show S02E05 title').e===5);
ok('episode 1x07',E('Show 1x07').s===1 && E('Show 1x07').e===7);
ok('episode ru',E('Сезон 3 серия 12').s===3 && E('Сезон 3 серия 12').e===12 && E('5 серия').e===5);
ok('episode columns win',E('x',{season:'2',episode:'4'}).s===2 && E('x',{season:'2',episode:'4'}).e===4);
ok('no episode',E('Big Buck Bunny').e===null && E('Movie 2010').e===null);
const S=T.vpSources([{name:'Z ep 2',url:'http://h/2',series:'Z'},{name:'Film',url:'http://h/f'},{name:'A S01E02',url:'http://h/a2',series:'A'},{name:'Z ep 1',url:'http://h/1',series:'Z'},{name:'A S01E01',url:'http://h/a1',series:'A'},{name:'Z',url:'http://h/z3',series:'Z',episode:3,season:1}]);
ok('series sorted',S.map(c=>c.name).join('|')==='Film|Z ep 1|Z ep 2|Z|A S01E01|A S01E02',S.map(c=>c.name).join('|'));
ok('label/group',T.vpLabel(S[4])==='S01E01 · A S01E01' && T.vpGroup(S[4])==='A — S1' && T.vpGroup(S[0])==='' && T.vpLabel(S[0])==='Film');
const L2=T.vpSources([{name:'a',url:'http://h/a'},{name:'b',url:'http://h/b'},{name:'c',url:'http://h/c'}]);
ok('no episodes: order kept',L2.map(c=>c.name).join('')==='abc');
ok('continue none',T.vpContinue(L2,{})===null);
let cm={'http://h/a':{pos:50,dur:100,t:5,done:false},'http://h/b':{pos:30,dur:100,t:9,done:false}};
ok('continue latest',JSON.stringify(T.vpContinue(L2,cm))==='{"i":1,"pos":30}');
cm['http://h/b']={pos:99,dur:100,t:9,done:true};
ok('continue next when done',JSON.stringify(T.vpContinue(L2,cm))==='{"i":2,"pos":0}');
cm['http://h/c']={pos:99,dur:100,t:10,done:true};
ok('continue end of list',T.vpContinue(L2,cm)===null);
ok('mark',T.vpMark(null)==='' && T.vpMark({done:true})==='✓ ' && T.vpMark({pos:25,dur:100})==='▸25% ' && T.vpMark({pos:2,dur:100})==='');
ok('rec series meta',T.vpRec('u','N',{pos:5,dur:10,t:1},{series:'S',season:1,episode:2}).episode===2 && !('series' in T.vpRec('u','N',{pos:5,dur:10,t:1},null)));
// Internet Archive
const u=T.vpIaSearchUrl('night "of" the','feature films',20);
ok('ia url',u.startsWith('https://archive.org/advancedsearch.php?q=') && decodeURIComponent(u).includes('collection:feature_films') && decodeURIComponent(u).includes('(night of the)') && u.includes('rows=20') && u.endsWith('output=json'),decodeURIComponent(u));
ok('ia url empty query + unknown kind',decodeURIComponent(T.vpIaSearchUrl('','zzz',0)).includes('mediatype:movies') && T.vpIaSearchUrl('','x',9999).includes('rows=200'));
const it=T.vpIaItems({response:{docs:[{identifier:'abc',title:['T'],year:1950,downloads:7},{title:'no id'},{identifier:'d'}]}});
ok('ia items',it.length===2 && it[0].name==='T' && it[0].url==='https://archive.org/details/abc' && it[1].name==='d' && T.vpIaItems(null).length===0);
ok('ia id',T.vpIaId('https://archive.org/details/My_Show-1?x=1')==='My_Show-1' && T.vpIaId('abc.def')==='abc.def' && T.vpIaId('a b')==='' && T.vpIaId('')==='');
const meta={metadata:{title:'My Show'},files:[
  {name:'My Show - S01E02.mp4',format:'h.264',source:'derivative',size:'20'},{name:'My Show - S01E02.ogv',format:'Ogg Video',source:'derivative'},
  {name:'My Show - S01E01.mp4',format:'h.264',source:'derivative'},{name:'My Show - S01E01.webm',format:'WebM'},
  {name:'My Show - S01E01.avi',format:'AVI',source:'original'},{name:'__ia_thumb.jpg',format:'Item Tile'},{name:'sub dir/Ep 10.mp4',format:'MPEG4'},{name:'My Show - S01E02.gif',format:'Animated GIF'}]};
const F=T.vpIaFiles(meta,'my_show');
ok('ia files: best format, one per episode, sorted',F.length===3 && F[0].file==='My Show - S01E01.mp4' && F[1].file==='My Show - S01E02.mp4' && F[2].file==='sub dir/Ep 10.mp4',F.map(f=>f.file).join('|'));
ok('ia files url encoded',F[0].url==='https://archive.org/download/my_show/My%20Show%20-%20S01E01.mp4' && F[2].url.endsWith('/sub%20dir/Ep%2010.mp4'));
ok('ia files series',F.every(f=>f.series==='My Show'));
const one=T.vpIaFiles({metadata:{title:'Film'},files:[{name:'film.mp4',format:'h.264'}]},'film');
ok('ia single file: no series',one.length===1 && !one[0].series && T.vpIaFiles(null,'x').length===0);
const sorted=T.vpSources(F);
ok('ia files → sources keep episode order',sorted.map(c=>c.episode).join()==='1,2,10',sorted.map(c=>c.episode).join());
// фильтр, iptv-org, примеры
const R=[{name:'News One',group:'News'},{name:'Cartoons',group:'Kids'},{name:'News Kids',group:'Kids'}];
ok('filter',T.vpFilter(R,'').length===3 && T.vpFilter(R,'news').length===2 && T.vpFilter(R,'news -kids').length===1 && T.vpFilter(R,'kids news').length===1 && T.vpFilter(R,'-').length===3);
ok('iptv url',T.VP_IPTV_URL('RU')==='https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ru.m3u' && T.VP_IPTV_URL('../x')==='https://raw.githubusercontent.com/iptv-org/iptv/master/streams/x.m3u');
const SM=T.vpSources(T.VP_SAMPLES);
ok('samples valid',SM.length===T.VP_SAMPLES.length && SM.some(c=>c.series) && SM.filter(c=>c.series).map(c=>c.episode).join()==='1,2,3,4,5' && SM.every(c=>/^(https:|magnet:)/.test(c.url)));
// запасные форматы: производный h.264 важнее оригинала (DivX / MPEG-4 Part 2 браузер не играет)
const m2={metadata:{title:'PP'},files:[
  {name:'PP 1.avi',format:'MPEG4',source:'original'},{name:'PP 1.mp4',format:'h.264',source:'derivative'},{name:'PP 1.ogv',format:'Ogg Video'},{name:'PP 1_512kb.mp4',format:'512Kb MPEG4'},
  {name:'PP 2.mp4',format:'MPEG4',source:'original'},{name:'PP 2.ia.mp4',format:'h.264 IA',source:'derivative'}]};
const F2=T.vpIaFiles(m2,'pp');
ok('ia: h.264 first, others as alt',F2.length===2 && F2[0].url.endsWith('/PP%201.mp4') && F2[0].alt.split(' ').length===2 && F2[0].alt.includes('PP%201_512kb.mp4') && F2[0].alt.includes('PP%201.ogv'),JSON.stringify(F2.map(f=>f.file+'|'+f.alt)));
ok('ia: .ia.mp4 derivative beats original mp4',F2[1].file==='PP 2.ia.mp4' && F2[1].alt.endsWith('PP%202.mp4'),F2[1].file);
const S2=T.vpSources(F2);
ok('alt survives vpSources',S2[0].alt===F2[0].alt);
ok('ia page url',T.vpIsIaPage('https://archive.org/details/ThePinkPanther-cartoons') && T.vpIsIaPage('http://www.archive.org/details/x/?a=1') && !T.vpIsIaPage('https://archive.org/download/x/a.mp4') && !T.vpIsIaPage('https://example.com/details/x'));
ok('media err',/not supported/.test(T.vpMediaErr(4)) && /network/.test(T.vpMediaErr(2)) && T.vpMediaErr(0)==='cannot be played');
// Wikimedia Commons
const wu=T.vpWmSearchUrl('moon landing',10);
ok('wm url',wu.startsWith('https://commons.wikimedia.org/w/api.php?') && decodeURIComponent(wu).includes('filetype:video moon landing') && wu.includes('gsrlimit=10') && wu.endsWith('origin=*'));
const wm=T.vpWmItems({query:{pages:{'2':{index:2,title:'File:B_clip.webm',imageinfo:[{url:'https://upload.wikimedia.org/b.webm',mime:'video/webm',size:5,extmetadata:{LicenseShortName:{value:'CC BY 4.0'}}}]},'1':{index:1,title:'File:A clip.ogv',imageinfo:[{url:'https://upload.wikimedia.org/a.ogv',mime:'application/ogg'}]},'3':{index:3,title:'File:x.pdf',imageinfo:[{url:'u',mime:'application/pdf'}]}}}});
ok('wm items',wm.length===2 && wm[0].name==='A clip' && wm[1].name==='B clip' && wm[1].license==='CC BY 4.0' && wm[0].url.endsWith('a.ogv') && T.vpWmItems(null).length===0);
// PeerTube
const pu=T.vpPtSearchUrl('cats',5);
ok('pt url',pu==='https://sepiasearch.org/api/v1/search/videos?search=cats&count=5&sort=-match');
const pi=T.vpPtItems({data:[{uuid:'u1',name:'V',duration:60,url:'https://tube.example/w/abc',account:{host:'tube.example'},channel:{displayName:'Ch'}},{uuid:'u2',name:'W',url:'https://other.org/w/x'},{name:'no uuid'}]});
ok('pt items',pi.length===2 && pi[0].id==='tube.example/u1' && pi[0].channel==='Ch' && pi[1].id==='other.org/u2',JSON.stringify(pi));
ok('pt id',T.vpPtId('tube.example/u1').host==='tube.example' && T.vpPtId('peertube:a.b.org/xyz-1').uuid==='xyz-1' && T.vpPtId('abc')===null && T.vpPtId('ThePinkPanther-cartoons')===null);
const pf=T.vpPtFiles({name:'V',streamingPlaylists:[{playlistUrl:'https://t/h.m3u8'}],files:[{fileUrl:'https://t/360.mp4',resolution:{id:360}},{fileUrl:'https://t/720.mp4',resolution:{id:720}}]},'t','u');
ok('pt files: hls first, mp4 alt',pf.length===1 && pf[0].url.endsWith('.m3u8') && pf[0].alt.startsWith('https://t/720.mp4'));
const pf2=T.vpPtFiles({name:'V',files:[{fileUrl:'https://t/1080.mp4',resolution:{id:1080}},{fileUrl:'https://t/720.mp4',resolution:{id:720}}]},'t','u');
ok('pt files: mp4 only',pf2[0].url==='https://t/720.mp4' && T.vpPtFiles(null,'t','u').length===0);
// iptv-org: категория / язык / страна
ok('iptv scope',T.vpIptvUrl('Movies')==='https://iptv-org.github.io/iptv/categories/movies.m3u' && T.vpIptvUrl('rus')==='https://iptv-org.github.io/iptv/languages/rus.m3u' && T.vpIptvUrl('ru')===T.VP_IPTV_URL('ru'));
// нативный плеер приложения: multicast, rtsp, контейнеры, которых нет у <video>
ok('kind native: schemes',T.vpKind('udp://@239.1.1.1:1234')==='native' && T.vpKind('rtp://@239.1.1.1:5004')==='native' && T.vpKind('RTSP://cam/stream')==='native');
ok('kind native: containers',T.vpKind('http://h/a.mkv')==='native' && T.vpKind('http://h/a.TS?x=1')==='native' && T.vpKind('http://h/a.avi')==='native' && T.vpKind('http://h/a.mp4')==='file' && T.vpKind('http://h/a.m3u8')==='hls');
const NS=T.vpSources([{name:'Первый',url:'udp://@239.10.0.1:1234'},{name:'RTP',url:'rtp://@239.10.0.2:5004'},{name:'Cam',url:'rtsp://10.0.0.9/live'},{name:'bad',url:'ftp://x'},{name:'web',url:'http://h/a.mp4'}]);
ok('sources accept udp / rtp / rtsp',NS.length===4 && NS[0].url==='udp://@239.10.0.1:1234' && NS.every(c=>T.VP_URL_RE.test(c.url)));
// торренты
const MG='magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=My+Show%20S01&tr=udp%3A%2F%2Ft%3A1';
ok('kind torrent',T.vpKind(MG)==='torrent' && T.vpKind('https://h/a.torrent')==='torrent' && T.vpKind('https://h/a.torrent?x=1')==='torrent' && T.vpKind('https://h/a.mp4')==='file');
ok('torrent ref',JSON.stringify(T.vpTorrentRef(MG+'#file=3'))===JSON.stringify({base:MG,file:3}) && T.vpTorrentRef(MG).file===null);
ok('magnet name',T.vpMagnetName(MG)==='My Show S01' && T.vpMagnetName('magnet:?xt=urn:btih:abc')==='' && T.vpMagnetName('https://h/a')==='');
const TS=T.vpSources([{url:MG},{name:'x',url:'https://h/a.torrent'}]);
ok('sources accept magnet / .torrent, name from dn',TS.length===2 && TS[0].name==='My Show S01' && TS[1].name==='x');
const rep1={name:'Pack',files:[{i:0,name:'Show.S01E02.mkv',size:5,video:true},{i:1,name:'Show.S01E01.mkv',size:6,video:true},{i:2,name:'readme.txt',size:1,video:false},{i:3,name:'Show.S01E01.srt',size:1,video:false}]};
const tr=T.vpTorrentRows(MG,rep1);
ok('torrent rows: video only, #file, series',tr.length===2 && tr[0].url===MG+'#file=0' && tr[0].series==='Pack' && tr[0].name==='Show S01E02',JSON.stringify(tr));
const trs=T.vpSources(tr);
ok('torrent rows → episodes in order',trs.map(c=>c.episode).join()==='1,2' && trs[0].url.endsWith('#file=1'),trs.map(c=>c.episode+c.url.slice(-7)).join());
const one1=T.vpTorrentRows(MG+'#file=9',{name:'Film',files:[{i:0,name:'Film.2010.mkv',size:1,video:true}]});
ok('single video: no series, base without #file',one1.length===1 && !one1[0].series && one1[0].url===MG+'#file=0' && T.vpTorrentRows(MG,null).length===0);
ok('torrent line',T.vpTorrentLine({state:'downloading',progress:.372,down:1258291,peers:14,seeds:3})==='torrent: 37 % of the torrent · ↓ 1.2 MB/s · 14 peers (3 seeds)' && /no peers/.test(T.vpTorrentLine({state:'downloading',progress:0,down:0,peers:0})) && /metadata/.test(T.vpTorrentLine({state:'downloading_metadata'})) && T.vpTorrentLine(null)==='');
ok('torrent line: no peers shows DHT and trackers',T.vpTorrentLine({state:'downloading',progress:0,down:0,peers:0,dht:42,trk:'a: ok; b: timed out'})==='torrent: 0 % of the torrent · ↓ 0 kB/s · 0 peers — no peers yet (DHT nodes: 42)\ntrackers: a: ok; b: timed out',T.vpTorrentLine({state:'downloading',progress:0,down:0,peers:0,dht:42,trk:'a: ok; b: timed out'}));
ok('ia torrent url',T.vpIaTorrentUrl('ThePinkPanther-cartoons')==='https://archive.org/download/ThePinkPanther-cartoons/ThePinkPanther-cartoons_archive.torrent');
ok('samples: magnets valid',T.VP_SAMPLES.filter(c=>c.url.startsWith('magnet:')).length===4 && T.VP_SAMPLES.filter(c=>c.url.startsWith('magnet:')).every(c=>/xt=urn:btih:[0-9a-f]{40}/.test(c.url)));
ok('magnet hash',T.vpMagnetHash(MG)==='0123456789abcdef0123456789abcdef01234567' && T.vpMagnetHash('magnet:?dn=x&xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567')==='0123456789abcdef0123456789abcdef01234567' && T.vpMagnetHash('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')==='0'.repeat(40) && T.vpMagnetHash('https://h')==='');
ok('search line',/DHT nodes: 87 · peers: 2/.test(T.vpTorrentSearchLine({dht:87,peers:2},12)) && /DHT is silent/.test(T.vpTorrentSearchLine({dht:0,peers:0},25)) && /no peers yet/.test(T.vpTorrentSearchLine({dht:50,peers:0},45)));
if(bad){ console.log(bad+' failed'); process.exit(1); }
console.log('all ok');
