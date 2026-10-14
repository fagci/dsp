// IPTV: node tools/test-iptv.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({URL,String,Math,Array,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/iptv-kernels.js'),'utf8')+';this.T={iptvParse,iptvPick,iptvNew};',ctx);
const T=ctx.T;
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

const ch=T.iptvParse('#EXTM3U\n#EXTINF:-1 tvg-id="a" tvg-logo="http://x/l.png" group-title="News",Channel A\nhttp://h/a.ts\n#EXTINF:-1,Channel B\n#EXTGRP:Kids\n/b.m3u8\nhttp://h/c.ts\n','http://srv/list.m3u');
ok('channels',ch.kind==='channels' && ch.items.length===3);
ok('attrs',ch.items[0].name==='Channel A' && ch.items[0].group==='News' && ch.items[0].id==='a' && ch.items[0].logo==='http://x/l.png');
ok('relative url + EXTGRP',ch.items[1].url==='http://srv/b.m3u8' && ch.items[1].group==='Kids');
ok('no EXTINF → url as name',ch.items[2].name==='http://h/c.ts');

const ms=T.iptvParse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nhi/p.m3u8\n','http://h/m.m3u8');
ok('master',ms.kind==='master' && ms.items.length===2 && ms.items[1].h===720 && ms.items[1].url==='http://h/hi/p.m3u8');
ok('pick',T.iptvPick(ms.items,'highest').bw===2500000 && T.iptvPick(ms.items,'lowest').bw===800000 && T.iptvPick(ms.items,'first').bw===800000);

const md=T.iptvParse('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4.0,\ns100.ts\n#EXTINF:3.5,\ns101.ts\n#EXTINF:4,\ns102.ts\n#EXTINF:4,\ns103.ts\n','http://h/v/p.m3u8');
ok('media',md.kind==='media' && md.segs.length===4 && md.segs[0].seq===100 && md.segs[3].seq===103 && md.target===4 && !md.end);
ok('segment url + dur',md.segs[1].url==='http://h/v/s101.ts' && md.segs[1].dur===3.5);
ok('first entry near live edge',T.iptvNew(md.segs,null,3).map(s=>s.seq).join()==='101,102,103');
ok('only new segments',T.iptvNew(md.segs,102,3).map(s=>s.seq).join()==='103');
ok('nothing new',T.iptvNew(md.segs,103,3).length===0);

const vod=T.iptvParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n','http://h/');
ok('endlist',vod.end===true && vod.segs[0].seq===0);
ok('fmp4 flag',T.iptvParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6,\na.m4s\n','http://h/').fmp4===true);
ok('encrypted flag',T.iptvParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts\n','http://h/').encrypted===true);
ok('KEY NONE is clear',T.iptvParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\na.ts\n','http://h/').encrypted===false);
ok('not a playlist',T.iptvParse('<html>','http://h/').kind==='none');
process.exit(bad ? 1 : 0);
