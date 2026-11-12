// Winlink: LZHUF, сообщение, упаковка B2, предложения B2F, блоки данных и сессия «клиент ↔ шлюз»: node tools/test-winlink.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Map,Set,Number,Array,Object,Uint8Array,Int32Array,Error,String,JSON,RegExp,parseInt});
const src=['modules/lzhuf-kernels.js','modules/winlink-kernels.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
vm.runInContext(src+';this.K={lzEncode,lzDecode,wlMsgBuild,wlMsgParse,wlPack,wlUnpack,wlCrc16,wlPropose,wlParseProposals,wlFsBuild,wlFsParse,wlFrame,wlDeframe,wlSessNew,wlSessStart,wlSessRx,wlSessOut,wlEnc,wlStr};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const eq=(a,b)=>a&&b&&a.length===b.length&&Array.from(a).every((x,i)=>x===b[i]);
let seed=99; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };

// LZHUF
const samples={empty:new Uint8Array(0), one:Uint8Array.of(65), text:K.wlEnc('Hello Winlink. '.repeat(60)), noise:Uint8Array.from({length:6000},()=>rnd()*256|0),
  runs:new Uint8Array(30000).fill(7), mixed:Uint8Array.from({length:100000},(_,i)=>(i%97<50?65+(i%26):rnd()*256)|0)};
for(const [k,v] of Object.entries(samples)) ok('LZHUF: '+k+' ('+v.length+' B) round trip',eq(K.lzDecode(K.lzEncode(v)),v));
ok('LZHUF: text and runs shrink a lot, noise does not blow up',K.lzEncode(samples.text).length<samples.text.length/4 && K.lzEncode(samples.runs).length<800 && K.lzEncode(samples.noise).length<6000*1.05);
ok('LZHUF: a damaged stream does not hang or crash',(()=>{ const z=K.lzEncode(samples.text); z[10]^=0xFF; z[z.length-3]^=0x55; try{ K.lzDecode(z); return true; }catch(e){ return false; } })());
ok('LZHUF: a truncated stream → null',K.lzDecode(K.lzEncode(samples.text).subarray(0,20))===null);

// сообщение
const M={mid:'ABCDEF123456',date:'2026/05/20 17:00',type:'Private',from:'N0CALL',to:['W1AW','K1ABC@winlink.org'],cc:['NA6X'],subject:'Status report',body:'Line 1\r\nLine 2 with Ünïcode? no — latin-1 only: é\r\n',p2p:false,
  files:[{name:'map.png',data:Uint8Array.from({length:700},()=>rnd()*256|0)},{name:'a.txt',data:K.wlEnc('abc')}]};
{ const m=K.wlMsgParse(K.wlMsgBuild(M));
  ok('message: build → parse keeps the headers',m && m.mid===M.mid && m.from==='N0CALL' && m.subject==='Status report' && m.to.join()==='W1AW,K1ABC@winlink.org' && m.cc.join()==='NA6X' && m.date===M.date && m.type==='Private',JSON.stringify(m&&{...m,files:0,body:0}));
  ok('message: body and attachments are exact',m && m.body===M.body.replace(/[^\x00-\xff]/g,c=>String.fromCharCode(c.charCodeAt(0)&255)) && m.files.length===2 && eq(m.files[0].data,M.files[0].data) && m.files[1].name==='a.txt');
  ok('message: garbage and a short body → null',K.wlMsgParse(K.wlEnc('nonsense'))===null && K.wlMsgParse(K.wlEnc('Mid: 1\r\nFrom: a\r\nBody: 50\r\n\r\nshort'))===null); }
// упаковка B2
{ const raw=K.wlMsgBuild(M), z=K.wlPack(raw);
  ok('B2 pack ↔ unpack',eq(K.wlUnpack(z),raw));
  const z2=z.slice(); z2[z2.length>>1]^=1; ok('B2: a wrong CRC is detected',K.wlUnpack(z2)===null);
  ok('CRC-16/XMODEM check value 0x31C3',K.wlCrc16(K.wlEnc('123456789'))===0x31C3); }
// предложения
{ const list=[{mid:'AAAAAAAAAAAA',usize:1200,csize:700},{mid:'BBBBBBBBBBBB',usize:90,csize:80}];
  const t=K.wlPropose(list), lines=t.split('\r').filter(Boolean);
  ok('proposals: build → parse',JSON.stringify(K.wlParseProposals(lines))===JSON.stringify(list),t);
  ok('proposals: a changed byte breaks the checksum',K.wlParseProposals(lines.map((l,i)=>i===0?l.replace('1200','1201'):l))===null);
  ok('FS: build ↔ parse',JSON.stringify(K.wlFsParse(K.wlFsBuild(['accept','reject','defer']).trim()))===JSON.stringify(['accept','reject','defer']) && K.wlFsBuild(['accept','reject','defer'])==='FS +-=\r'); }
// блоки данных
{ for(const n of [0,1,249,250,251,700]){ const d=Uint8Array.from({length:n},()=>rnd()*256|0); const f=K.wlFrame('Hello',d), r=K.wlDeframe(f);
    if(!(r.done && r.ok && r.title==='Hello' && eq(r.data,d) && r.used===f.length)) { ok('frame '+n+' B',false); } }
  ok('frames: 0…700 bytes round trip',true);
  const f=K.wlFrame('T',Uint8Array.from({length:300},(_,i)=>i&255)); ok('frames: a partial stream waits',K.wlDeframe(f.subarray(0,f.length-1)).done===false);
  const g=f.slice(); g[40]^=1; ok('frames: a flipped byte → checksum fails',K.wlDeframe(g).ok===false); }

// сессия клиент ↔ шлюз: кусками случайной длины
function link(a,b,maxChunk=40){
  for(let guard=0;guard<4000 && !(a.done && b.done);guard++){
    for(const [x,y] of [[a,b],[b,a]]){ const o=K.wlSessOut(x); for(let i=0;i<o.length;){ const n=1+Math.floor(rnd()*maxChunk); K.wlSessRx(y,o.subarray(i,i+n)); i+=n; } }
    if(!a.out.length && !b.out.length && (a.done || b.done)) break;
  }
}
const mk=(mid,from,to,subj,body,files)=>({mid,date:'2026/05/20 17:00',type:'Private',from,to:[to],subject:subj,body,files:files||[]});
{ const cl=K.wlSessNew('client',{call:'N0CALL',outbox:[mk('M0000000001A','N0CALL','W1AW','one','Hello 1'),mk('M0000000002B','N0CALL','W1AW','two','x'.repeat(3000),[{name:'f.bin',data:Uint8Array.from({length:900},()=>rnd()*256|0)}])]});
  const gw=K.wlSessNew('server',{call:'W1AW',outbox:[mk('G0000000001C','W1AW','N0CALL','reply','Got it')]});
  K.wlSessStart(gw); K.wlSessStart(cl); link(cl,gw);
  ok('session: both sides finish',cl.done && gw.done,JSON.stringify({c:cl.log,g:gw.log}));
  ok('session: the gateway got the 2 messages exactly',gw.inbox.length===2 && gw.inbox[0].subject==='one' && gw.inbox[1].body.length===3000 && eq(gw.inbox[1].files[0].data,cl.outbox.length===0 ? gw.inbox[1].files[0].data : null));
  ok('session: the client got the reply',cl.inbox.length===1 && cl.inbox[0].body==='Got it' && cl.inbox[0].from==='W1AW');
  ok('session: outboxes are empty, no damaged messages',cl.outbox.length===0 && gw.outbox.length===0 && cl.bad===0 && gw.bad===0); }
{ const cl=K.wlSessNew('client',{call:'N0CALL',outbox:[mk('DUP000000001','N0CALL','W1AW','dup','again')]});
  const gw=K.wlSessNew('server',{call:'W1AW',seen:['DUP000000001']});
  K.wlSessStart(gw); K.wlSessStart(cl); link(cl,gw);
  ok('session: a message the gateway already has is rejected (no data sent)',gw.inbox.length===0 && cl.outbox.length===0 && cl.done && gw.done,JSON.stringify(cl.log)); }
{ const cl=K.wlSessNew('client',{call:'N0CALL'}), gw=K.wlSessNew('server',{call:'W1AW'});
  K.wlSessStart(gw); K.wlSessStart(cl); link(cl,gw); ok('session: nothing to send on either side → FF / FQ',cl.done && gw.done && cl.inbox.length===0); }
{ const cl=K.wlSessNew('client',{call:'N0CALL'}), gw=K.wlSessNew('server',{call:'W1AW',outbox:[mk('ONLY0000001G','W1AW','N0CALL','only gateway','Gw→cl')]});
  K.wlSessStart(gw); K.wlSessStart(cl); link(cl,gw,7); ok('session: only the gateway has mail (7-byte chunks)',cl.inbox.length===1 && cl.done && gw.done && gw.outbox.length===0); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
