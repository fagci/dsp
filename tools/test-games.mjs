// Игры по каналу: node tools/test-games.mjs
// Две стороны Реверси через TBSK-модем (звук с потерями и шумом), без браузера: узлы игр и модема гоняются блоками.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const BLOCK=512, SR=48000;
let now=0, bad=0;
const defs={};
const ctx=vm.createContext({Math,Float32Array,Float64Array,Uint8Array,BigInt,Number,Array,Object,String,JSON,TextEncoder,TextDecoder,Set,
  Date:{now:()=>now}, BLOCK, Eng:{sr:SR}, buf:(n,k)=>n['_'+k]||(n['_'+k]=new Float32Array(BLOCK)),
  def:d=>{ defs[d.id]=d; }, document:{}});
const load=f=>fs.readFileSync(path.join(root,f),'utf8');
vm.runInContext(load('modules/tbsk-kernels.js')+'\n'+load('modules/tbsk.js'),ctx);
vm.runInContext(load('modules/games.js')+';this.G={ngSend,rvMoves,rvPlay,rvCount};',ctx);
const G=ctx.G;
const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n,x); };

let sd=777; const rnd=()=>{ sd^=sd<<13; sd^=sd>>>17; sd^=sd<<5; return (sd>>>0)/4294967296; };
const gs=()=>Math.sqrt(-2*Math.log(Math.max(rnd(),1e-12)))*Math.cos(2*Math.PI*rnd());

function node(id,params){
  const d=defs[id], n={p:{}};
  for(const p of d.params||[]) n.p[p.n]=p.d;
  Object.assign(n.p,params||{}); d.init(n); return n;
}
let o_rel=true;
const sideOf=(game)=>({
  game: node(game,{rel:o_rel}),
  tx: node('tbskTx',{auto:false,amp:.5,cycle:16}), rx: node('tbskRx',{fc:4800,cycle:16,max:96}),
  go:0, text:null
});

/* Партия: w — доля блоков, в которых канал «глохнет» (потеря кадра), noise — шум, sec — предел модельного времени. */
function play(o){
  const gid=o.game||'greversi', A=sideOf(gid), B=sideOf(gid);
  if(o.params) for(const s of [A,B]) Object.assign(s.game.p,o.params);
  const P=defs[gid].process;
  let lostUntil=0, frames=0, lost=0, moves=0, st=0;
  const audio={a:new Float32Array(BLOCK), b:new Float32Array(BLOCK)};
  const t0=Date.now();
  const end=Math.floor((o.sec||600)*SR/BLOCK);
  for(let blk=0;blk<end;blk++){
    now=Math.floor(blk*BLOCK/SR*1000);
    // канал: звук одной стороны слышит другая
    const hear=(from,side)=>{
      const x=new Float32Array(BLOCK);
      if(o.drop && from.busy && !side.tx.wb && rnd()<o.drop){ lostUntil=blk+Math.ceil(0.25*SR/BLOCK); lost++; }
      side.tx.wb=from.busy;
      const mute=blk<lostUntil;
      for(let i=0;i<BLOCK;i++) x[i]=(mute ? 0 : from.out[i])+(o.noise||0)*gs();
      return x;
    };
    for(const [me,other] of [[A,B],[B,A]]){
      const r=defs.tbskRx.process(me.rx,{in:hear(other.tx.res||{out:new Float32Array(BLOCK),busy:0},other) });
      const g=P(me.game,{in:r.text,link:1});
      me.gres=g;
      if(me.game.ready && g.turn && !me.game.over){
        const mv=G.rvMoves(me.game.b,me.game.me);
        if(mv.length && rnd()<.3){ const i=mv[Math.floor(rnd()*mv.length)]; if(G.rvPlay(me.game,i,me.game.me)){ G.ngSend(me.game,'m '+i); moves++; } }
      }
      if(me.game.ready && me.game.over && !me.next && rnd()<.01){ me.next=1; }
    }
    for(const s of [A,B]){
      s.tx.res=defs.tbskTx.process(s.tx,{text:s.gres.out,go:s.gres.go});
      s.tx.res.out=s.tx.res.out.slice(); s.tx.res.busy=s.tx.res.busy;
    }
    // обе стороны сыграли до конца
    if(A.game.over && B.game.over){ st=blk; break; }
  }
  return {A:A.game,B:B.game,moves,lost,blocks:st,sec:st*BLOCK/SR,ms:Date.now()-t0};
}
const same=(r)=>JSON.stringify(r.A.b)===JSON.stringify(r.B.b);

let r=play({sec:900});
ok('clean channel: both sides finish a game',r.A.over && r.B.over,'sim '+r.sec.toFixed(1)+' s, '+r.moves+' moves, cpu '+r.ms+' ms');
ok('clean channel: boards equal',same(r));
r=play({sec:900,noise:.15});
ok('noise 0.15: finishes, boards equal',r.A.over && r.B.over && same(r),'sim '+r.sec.toFixed(1)+' s');
r=play({sec:1500,drop:.2});
ok('frame loss: finishes, boards equal',r.A.over && r.B.over && same(r),'lost '+r.lost+', over '+r.A.over+'/'+r.B.over+', sim '+r.sec.toFixed(1)+' s');

/* Прямой провод (WebRTC / MQTT): текст одной стороны сразу на вход другой */
function wire(gid,rel){
  const A=node(gid,{rel}), B=node(gid,{rel}), P=defs[gid].process; let la=null, lb=null;
  for(let k=0;k<400;k++){ now=k*10;
    const a=P(A,{in:lb,link:1}); const b=P(B,{in:la,link:1});
    la=a.go ? a.out : null; lb=b.go ? b.out : null;
    if(rel===false){ la=a.out; lb=b.out; }              // провод держит последнее значение
  }
  return [A,B];
}
for(const gid of ['gtictactoe','gconnect4','gbattleship','greversi']) for(const rel of [false,true]){
  const [A,B]=wire(gid,rel);
  ok(gid+' wire rel='+rel+': handshake, different sides',A.ready && B.ready && A.me!==B.me,'me '+A.me+'/'+B.me);
}
{
  const [A,B]=wire('greversi',false);
  const mv=G.rvMoves(A.b,A.turnP===A.me ? A.me : B.me), who=A.turnP===A.me ? A : B, other=who===A ? B : A;
  G.rvPlay(who,mv[0],who.me); G.ngSend(who,'m '+mv[0]);
  const P=defs.greversi.process; let last=who.outQ.shift(); now+=10;
  P(other,{in:last}); 
  ok('wire rel=false: move arrives',JSON.stringify(A.b)===JSON.stringify(B.b));
}
{
  const [A,B]=wire('greversi',true);
  const who=A.turnP===A.me ? A : B, other=who===A ? B : A, P=defs.greversi.process;
  const mv=G.rvMoves(who.b,who.me); G.rvPlay(who,mv[0],who.me); G.ngSend(who,'m '+mv[0]);
  const txt=who.outQ[who.outQ.length-1], bad1=txt.replace(/m (\d+)/,(x,d)=>'m '+((+d+1)%64));
  P(other,{in:bad1}); ok('rel: corrupted frame rejected',JSON.stringify(who.b)!==JSON.stringify(other.b));
  P(other,{in:null}); P(other,{in:txt}); ok('rel: good frame accepted',JSON.stringify(who.b)===JSON.stringify(other.b));
  P(other,{in:null}); const q=other.outQ.length; P(other,{in:txt}); ok('rel: duplicate not applied twice, acked again',other.outQ.length>q || other.justSent);
}
r=play({sec:60,drop:1});
ok('dead channel: no progress, no crash',!r.A.over && r.moves===0,'lost '+r.lost);
r=play({sec:2400,drop:.6});
ok('60 % of bursts cut: still finishes, boards equal',r.A.over && r.B.over && same(r),'lost '+r.lost+', sim '+r.sec.toFixed(1)+' s');
console.log(bad ? 'FAILED '+bad : 'all ok');
process.exit(bad ? 1 : 0);
