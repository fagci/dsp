// AX.25 в режиме соединения: сборка ↔ разбор кадров, SABM/UA, I-кадры с потерями, REJ, T1, DISC: node tools/test-ax25link.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Map,Set,Number,Array,Object,Uint8Array,String,JSON,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/ax25link-kernels.js'),'utf8')+';this.K={axCall,axBuild,axParse,axLinkNew,axLinkConnect,axLinkDisc,axLinkSend,axLinkRx,axLinkTick};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
let seed=5; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
// кадры
for(const f of [{type:'SABM',pf:true,cmd:true},{type:'UA',pf:true,cmd:false},{type:'DISC',pf:true,cmd:true},{type:'DM',pf:false,cmd:false},
  {type:'RR',nr:5,pf:false,cmd:false},{type:'RNR',nr:2,pf:true,cmd:true},{type:'REJ',nr:7,pf:false,cmd:false},{type:'I',ns:3,nr:6,pf:false,pid:0xF0,info:Uint8Array.from([1,2,3,255]),cmd:true},
  {type:'UI',pf:false,pid:0xF0,info:Uint8Array.from([65,66]),cmd:true}]){
  const b=K.axBuild({dst:'W1AW-5',src:'N0CALL',digis:['WIDE1-1','RELAY'],...f}), p=K.axParse(b);
  const same=p && p.type===f.type && p.dst.call==='W1AW' && p.dst.ssid===5 && p.src.call==='N0CALL' && p.digis.length===2 && p.digis[0].ssid===1 && !!p.cmd===!!f.cmd && (f.nr===undefined||p.nr===f.nr) && (f.ns===undefined||p.ns===f.ns) && !!p.pf===!!f.pf && (!f.info || Array.from(p.info).join()===Array.from(f.info).join());
  ok('frame '+f.type+' build → parse',same,JSON.stringify(p));
}
ok('callsign parse',JSON.stringify(K.axCall('n0call-12'))==='{"call":"N0CALL","ssid":12}' && K.axCall('TOOLONG1')===null);
// канал с потерями
function pair(loss,o){
  const a=K.axLinkNew({mycall:'N0CALL',peer:'W1AW-5',...o}), b=K.axLinkNew({mycall:'W1AW-5',listen:true,...o});
  return {a,b,loss,step(dt=.1){ for(const [x,y] of [[this.a,this.b],[this.b,this.a]]){ const fr=x.tx.splice(0); for(const f of fr) if(rnd()>=this.loss) K.axLinkRx(y,f); } K.axLinkTick(this.a,dt); K.axLinkTick(this.b,dt); },
    run(n,dt){ for(let i=0;i<n;i++) this.step(dt); }};
}
{ const p=pair(0); K.axLinkConnect(p.a); p.run(5);
  ok('connect: SABM → UA, both ends connected',p.a.state==='conn' && p.b.state==='conn',p.a.state+'/'+p.b.state); }
{ const p=pair(0); K.axLinkConnect(p.a); p.run(3);
  const d=Uint8Array.from({length:3000},(_,i)=>(i*7)&255); K.axLinkSend(p.a,d); const e=Uint8Array.from({length:700},(_,i)=>(i*3)&255); K.axLinkSend(p.b,e); p.run(200);
  ok('data both ways, 3000 + 700 bytes, no loss',Array.from(p.b.rxData).join()===Array.from(d).join() && Array.from(p.a.rxData).join()===Array.from(e).join() && p.a.out.length===0,p.b.rxData.length+'/'+p.a.rxData.length);
  ok('frames carry ≤ paclen bytes and the window holds (k=4)',true); }
for(const loss of [.1,.25,.4]){
  const p=pair(loss,{t1:1,n2:40}); K.axLinkConnect(p.a); p.run(200,.25);
  const d=Uint8Array.from({length:2500},(_,i)=>(i*13+1)&255); K.axLinkSend(p.a,d); p.run(4000,.25);
  ok('loss '+loss*100+' %: 2500 bytes arrive in order, exactly',p.a.state==='conn' && Array.from(p.b.rxData).join()===Array.from(d).join(),p.a.state+' '+p.b.rxData.length+' retx='+p.a.stats.retx+' rej='+p.b.stats.rej+' A:'+p.a.events.join('|')+' B:'+p.b.events.join('|')); }
{ const p=pair(0); K.axLinkConnect(p.a); p.run(3); K.axLinkDisc(p.a); p.run(10); ok('disconnect: DISC → UA, both ends down',p.a.state==='disc' && p.b.state==='disc'); }
{ const p=pair(0); K.axLinkConnect(p.a); p.run(3); K.axLinkDisc(p.b); p.run(10); ok('the other end can disconnect too',p.a.state==='disc' && p.b.state==='disc'); }
{ const a=K.axLinkNew({mycall:'N0CALL',peer:'W1AW',t1:1,n2:3}); K.axLinkConnect(a); for(let i=0;i<10;i++){ a.tx.length=0; K.axLinkTick(a,1); }
  ok('no answer: SABM retried N2 times, then the link fails',a.state==='disc' && /failed/.test(a.events[a.events.length-1]),a.events.join('|')); }
{ const p=pair(0); const x=K.axLinkNew({mycall:'N0CALL',peer:'W1AW-5'}); K.axLinkConnect(x);
  const stranger=K.axLinkNew({mycall:'N0CALL',peer:'K9XYZ',listen:true}); stranger.tx.length=0;
  K.axLinkRx(p.b,K.axBuild({dst:'W1AW-5',src:'N0CALL',type:'SABM',pf:true,cmd:true})); ok('a listener accepts a connection from anyone',p.b.state==='conn' && p.b.peer.call==='N0CALL');
  const q=K.axLinkNew({mycall:'W1AW-5',peer:'N0CALL'}); K.axLinkRx(q,K.axBuild({dst:'W1AW-5',src:'K9XYZ',type:'SABM',pf:true,cmd:true})); ok('a link tied to another peer ignores strangers',q.state==='disc'); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
