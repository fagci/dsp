// Video Player (ядро): node tools/test-vplayer.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({String,Math,Array,Object,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/vplayer-kernels.js'),'utf8')+';this.T={vpKind,vpSources,vpFind,vpResume,vpPut,vpFmt,vpSeek,vpRec,vpEpisode,vpLabel,vpGroup,vpContinue,vpMark,vpIaSearchUrl,vpIaItems,vpIaId,vpIaFiles,vpFilter,VP_IPTV_URL,VP_SAMPLES};',ctx);
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
ok('samples valid',SM.length===T.VP_SAMPLES.length && SM.some(c=>c.series) && SM.filter(c=>c.series).map(c=>c.episode).join()==='1,2,3,4,5' && SM.every(c=>/^https:/.test(c.url)));
if(bad){ console.log(bad+' failed'); process.exit(1); }
console.log('all ok');
