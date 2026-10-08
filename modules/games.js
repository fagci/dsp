"use strict";
/* ============================ NET GAMES ============================
   Игры на двоих по проводам, как Chat: вход in — ходы соперника, выход out — мои ходы (текст).
   Транспорт любой: WebRTC Data (line → in, out → send) или MQTT (общий топик). Свои сообщения узел
   игнорирует по nonce, так что общий топик не зацикливается. Формат: <игра>:<nonce>:<seq>:<команда>.
   Рукопожатие hello выбирает, кто первый; каждая следующая партия начинается с другого. */

const NG_BIT={auto:'a',first:'f',second:'s'};
const ngRnd=()=>Math.random().toString(36).slice(2,10).padEnd(8,'0');

function ngSend(n,cmd){ n.seq++; n.outQ.push(n.gid+':'+n.nonce+':'+n.seq+':'+cmd); }
function ngHello(n,re){ n.lastHello=Date.now(); ngSend(n,'hello '+(NG_BIT[n.p.side]||'a')+(re ? ' r' : '')); }
function ngParse(n,text){
  const m=/^([a-z0-9]+):([a-z0-9]+):(\d+):(.*)$/.exec(String(text).trim());
  return m && m[1]===n.gid && m[2]!==n.nonce ? {nonce:m[2],seq:+m[3],cmd:m[4]} : null;
}
function ngResolve(n){                               // 1 — первый игрок, 2 — второй; обе стороны считают одинаково
  const a=NG_BIT[n.p.side]||'a', b=n.peerSide;
  if(a==='f' && b!=='f') return 1;
  if(a==='s' && b!=='s') return 2;
  if(b==='f' && a!=='f') return 2;
  if(b==='s' && a!=='s') return 1;
  return n.nonce<n.peer ? 1 : 2;
}
function ngStart(n,k){
  n.k=k; n.over=false; n.res=0; n.turnP=k%2 ? 2 : 1;
  n.spec.reset(n); n.dirty=true;
}
function ngFinish(n,w){                              // w: номер победителя или 3 — ничья
  if(n.over) return;
  n.over=true; n.res=w===3 ? 2 : w===n.me ? 1 : -1;
  n.sc[n.res===1 ? 'w' : n.res===-1 ? 'l' : 'd']++; n.dirty=true;
}
function ngAgain(n){
  if(!n.ready) return;
  ngStart(n,n.k+1); ngSend(n,'new '+n.k);
}
function ngRecv(n,m){
  let fresh=false;
  if(m.nonce!==n.peer){ n.peer=m.nonce; n.peerSeq=0; n.peerSide='a'; fresh=true; }
  if(m.seq<=n.peerSeq) return;
  n.peerSeq=m.seq;
  const a=m.cmd.split(' '), cmd=a.shift();
  if(cmd==='hello'){
    n.peerSide=a[0]||'a';
    const me=ngResolve(n);
    const re=a[1]==='r';                             // ответ на hello — не отвечаем, иначе пинг-понг
    if(fresh || !n.ready || me!==n.me || !re){ n.me=me; n.ready=true; ngStart(n,0); }
    if(!re) ngHello(n,true);
    return;
  }
  if(fresh) ngHello(n);
  if(!n.ready) return;
  if(cmd==='new'){ const k=+a[0]|0; if(k>n.k) ngStart(n,k); return; }
  n.spec.msg(n,cmd,a); n.dirty=true;
}
function ngInit(n,gid,spec){
  n.gid=gid; n.spec=spec; n.nonce=ngRnd(); n.seq=0; n.outQ=[]; n.last='';
  n.lastIn=undefined; n.lastNew=false; n.lastLink=0; n.peer=null; n.peerSeq=0; n.peerSide='a';
  n.me=1; n.ready=false; n.k=0; n.sc={w:0,l:0,d:0}; n.lastHello=0;
  n.box=null; n.dirty=true; n.over=false; n.res=0; n.turnP=1;
  spec.reset(n);
}
function ngProcess(n,I){
  if(typeof I.in==='string' && I.in!==n.lastIn){ n.lastIn=I.in; const m=ngParse(n,I.in); if(m) ngRecv(n,m); }
  const nw=+I.new>.5; if(nw && !n.lastNew) ngAgain(n); n.lastNew=nw;
  const lk=+I.link>.5;                               // канал поднялся заново (после обрыва): обе стороны начинают партию с нуля, счёт остаётся
  if(lk && !n.lastLink){ if(n.ready) ngStart(n,0); ngHello(n); }
  n.lastLink=lk;
  if(!n.ready && Date.now()-n.lastHello>2000) ngHello(n);
  let go=0;
  if(n.outQ.length){ n.last=n.outQ.shift(); go=1; }
  return {out:n.last, go, turn:n.ready && !n.over && n.turnP===n.me ? 1 : 0, result:n.res===1 ? 1 : n.res===-1 ? -1 : 0};
}

/* ---- интерфейс ---- */
function ngGrid(parent,cols,rows,onClick){
  const g=document.createElement('div'); g.className='ng-g'; g.style.gridTemplateColumns='repeat('+cols+',1fr)';
  const cells=[];
  for(let i=0;i<cols*rows;i++){ const c=document.createElement('div'); c.className='ng-c'; c.dataset.i=i; cells.push(c); g.append(c); }
  g.addEventListener('click',e=>{ const c=e.target.closest('.ng-c'); if(c) onClick(+c.dataset.i); });
  parent.append(g); return cells;
}
function ngBtn(bar,label,fn){
  const b=document.createElement('button'); b.textContent=label; b.addEventListener('click',fn); bar.append(b); return b;
}
function ngMount(n){
  const box=document.createElement('div'); box.className='ng';
  const bar=document.createElement('div'); bar.className='ng-bar';
  const st=document.createElement('span'); st.className='ng-st'; bar.append(st);
  const bd=document.createElement('div'); bd.className='ng-bd';
  box.addEventListener('pointerdown',e=>e.stopPropagation());
  box.addEventListener('wheel',e=>e.stopPropagation());
  box.append(bar,bd);
  n.stEl=st; n.btns={};
  n.spec.mount(n,bd,bar);
  ngBtn(bar,'New game',()=>ngAgain(n));
  n.mid.append(box); n.box=box; n.dirty=true;
}
function ngStatus(n){
  const s=n.sc, tally=' ['+s.w+'–'+s.l+(s.d ? ', '+s.d+' draw' : '')+']';
  if(!n.ready) return 'waiting for opponent… (wire in / out to a channel)';
  return n.spec.status(n)+tally;
}
function ngDraw(n){
  if(!n.box || !n.box.isConnected) ngMount(n);
  if(!n.dirty) return;
  n.spec.render(n); n.stEl.textContent=ngStatus(n); n.dirty=false;
}
function ngDef(o){
  def({ id:o.id, title:o.title, cat:'Output', w:o.w||340, resize:true,
    kw:'game multiplayer two players network '+o.kw,
    ins:[{n:'in',t:'txt'},{n:'new',t:'num'},{n:'link',t:'num'}],
    outs:[{n:'out',t:'txt'},{n:'go',t:'num'},{n:'turn',t:'num'},{n:'result',t:'num'}],
    params:[{n:'side',t:'select',opts:['auto','first','second'],d:'auto',label:'first player in game 1',
             fn:n=>{ if(n.peer){ ngHello(n); const me=ngResolve(n); if(me!==n.me){ n.me=me; ngStart(n,0); } } }}],
    init:n=>ngInit(n,o.id,o.spec),
    process:ngProcess,
    draw:ngDraw });
}
const ngWho=n=>n.turnP===n.me ? 'your move' : "opponent's move";
const ngEnd=n=>n.res===1 ? 'you win!' : n.res===-1 ? 'you lose' : 'draw';

/* ---- крестики-нолики ---- */
const TTT_L=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttLine(b){ return TTT_L.find(l=>b[l[0]] && b[l[0]]===b[l[1]] && b[l[0]]===b[l[2]]) || null; }
function tttPlay(n,i,p){
  if(n.over || n.turnP!==p || n.b[i]) return false;
  n.b[i]=p; n.line=tttLine(n.b);
  if(n.line) ngFinish(n,p); else if(n.b.every(Boolean)) ngFinish(n,3); else n.turnP=3-p;
  n.dirty=true; return true;
}
const TTT={
  reset(n){ n.b=Array(9).fill(0); n.line=null; },
  msg(n,cmd,a){ const i=+a[0]; if(cmd==='m' && i>=0 && i<9) tttPlay(n,i,3-n.me); },
  mount(n,bd){ n.cells=ngGrid(bd,3,3,i=>{ if(n.ready && tttPlay(n,i,n.me)) ngSend(n,'m '+i); }); },
  render(n){ n.cells.forEach((c,i)=>{ const v=n.b[i];
    c.textContent=v===1 ? 'X' : v===2 ? 'O' : ''; c.className='ng-c'+(v ? ' p'+v : '')+(n.line && n.line.includes(i) ? ' win' : ''); }); },
  status:n=>n.over ? ngEnd(n) : ngWho(n)+' ('+(n.turnP===1 ? 'X' : 'O')+')'
};
ngDef({id:'gtictactoe',title:'Tic-Tac-Toe (2 players)',kw:'tictactoe noughts crosses xo',w:260,spec:TTT});

/* ---- четыре в ряд ---- */
const C4_W=7, C4_H=6;
function c4Drop(b,c){ for(let r=C4_H-1;r>=0;r--) if(!b[r*C4_W+c]) return r*C4_W+c; return -1; }
function c4Win(b,i,p){                              // линия из 4+ через клетку i или null
  const r0=Math.floor(i/C4_W), c0=i%C4_W;
  for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]){
    const cells=[i];
    for(const s of [1,-1]) for(let k=1;k<4;k++){
      const r=r0+dr*k*s, c=c0+dc*k*s;
      if(r<0||r>=C4_H||c<0||c>=C4_W||b[r*C4_W+c]!==p) break;
      cells.push(r*C4_W+c);
    }
    if(cells.length>=4) return cells;
  }
  return null;
}
function c4Play(n,c,p){
  if(n.over || n.turnP!==p || c<0 || c>=C4_W) return false;
  const i=c4Drop(n.b,c); if(i<0) return false;
  n.b[i]=p; n.line=c4Win(n.b,i,p); n.last4=i;
  if(n.line) ngFinish(n,p); else if(n.b.every(Boolean)) ngFinish(n,3); else n.turnP=3-p;
  n.dirty=true; return true;
}
const C4={
  reset(n){ n.b=Array(C4_W*C4_H).fill(0); n.line=null; n.last4=-1; },
  msg(n,cmd,a){ if(cmd==='m') c4Play(n,+a[0],3-n.me); },
  mount(n,bd){ n.cells=ngGrid(bd,C4_W,C4_H,i=>{ const c=i%C4_W; if(n.ready && c4Play(n,c,n.me)) ngSend(n,'m '+c); }); },
  render(n){ n.cells.forEach((c,i)=>{ const v=n.b[i];
    c.className='ng-c ng-disc'+(v ? ' f'+v : '')+(n.line && n.line.includes(i) ? ' win' : '')+(i===n.last4 ? ' last' : ''); }); },
  status:n=>n.over ? ngEnd(n) : ngWho(n)+' ('+(n.turnP===1 ? 'amber' : 'teal')+')'
};
ngDef({id:'gconnect4',title:'Connect Four (2 players)',kw:'connect4 four in a row',w:340,spec:C4});

/* ---- морской бой ---- */
const BS_N=10, BS_SHIPS=[5,4,3,3,2];
function bsPlace(){                                  // флот, корабли не касаются друг друга
  for(;;){
    const g=Array(BS_N*BS_N).fill(0); let ok=true;
    for(let s=0;s<BS_SHIPS.length && ok;s++){
      ok=false;
      for(let t=0;t<200 && !ok;t++){
        const h=Math.random()<.5, L=BS_SHIPS[s];
        const r=Math.floor(Math.random()*(h ? BS_N : BS_N-L+1)), c=Math.floor(Math.random()*(h ? BS_N-L+1 : BS_N));
        const cells=Array.from({length:L},(_,k)=>(h ? r : r+k)*BS_N+(h ? c+k : c));
        const free=cells.every(i=>{ const y=Math.floor(i/BS_N), x=i%BS_N;
          for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
            const yy=y+dy, xx=x+dx; if(yy>=0&&yy<BS_N&&xx>=0&&xx<BS_N && g[yy*BS_N+xx]) return false; }
          return true; });
        if(free){ cells.forEach(i=>{ g[i]=s+1; }); ok=true; }
      }
    }
    if(ok) return g;
  }
}
function bsReady(n){
  if(n.phase==='place' && n.imReady && n.oppReady) n.phase='play';
  n.dirty=true;
}
const BS={
  reset(n){
    n.phase='place'; n.mine=bsPlace(); n.hit=Array(BS_N*BS_N).fill(0); n.opp=Array(BS_N*BS_N).fill(0);
    n.hp=BS_SHIPS.slice(); n.imReady=false; n.oppReady=false; n.pend=-1; n.sunk=0;
  },
  msg(n,cmd,a){
    if(cmd==='ready'){ n.oppReady=true; bsReady(n); return; }
    if(cmd==='shot'){
      const i=+a[0];
      if(n.phase!=='play' || n.over || n.turnP===n.me || !(i>=0 && i<BS_N*BS_N) || n.hit[i]) return;
      const s=n.mine[i]; let code='m';
      if(s){ n.hit[i]=2; code=--n.hp[s-1]===0 ? 's' : 'h'; } else n.hit[i]=1;
      const lost=n.hp.every(h=>h===0);
      ngSend(n,'res '+i+' '+code+(lost ? ' e' : ''));
      n.turnP=n.me; if(lost) ngFinish(n,3-n.me);
      return;
    }
    if(cmd==='res'){
      const i=+a[0];
      if(n.pend!==i) return;
      n.pend=-1; n.opp[i]=a[1]==='m' ? 1 : 2; n.turnP=3-n.me;
      if(a[1]==='s') n.sunk++;
      if(a[2]==='e') ngFinish(n,n.me);
    }
  },
  mount(n,bd,bar){
    const wrap=(t,cb)=>{ const d=document.createElement('div'); d.className='ng-bw'; const l=document.createElement('div'); l.className='ng-cap'; l.textContent=t; d.append(l); bd.append(d); return cb(d); };
    n.cells=wrap('enemy waters',d=>ngGrid(d,BS_N,BS_N,i=>{
      if(!n.ready || n.phase!=='play' || n.over || n.turnP!==n.me || n.pend>=0 || n.opp[i]) return;
      n.pend=i; ngSend(n,'shot '+i); n.dirty=true; }));
    n.own=wrap('my fleet',d=>ngGrid(d,BS_N,BS_N,()=>{}));
    n.btns.shuffle=ngBtn(bar,'Shuffle',()=>{ if(n.phase==='place' && !n.imReady){ n.mine=bsPlace(); n.dirty=true; } });
    n.btns.ready=ngBtn(bar,'Ready',()=>{ if(n.ready && n.phase==='place' && !n.imReady){ n.imReady=true; ngSend(n,'ready'); bsReady(n); } });
  },
  render(n){
    n.cells.forEach((c,i)=>{ const v=n.opp[i]; c.textContent=v===1 ? '·' : v===2 ? '✕' : ''; c.className='ng-c'+(v===1 ? ' miss' : v===2 ? ' hit' : '')+(i===n.pend ? ' win' : ''); });
    n.own.forEach((c,i)=>{ const v=n.hit[i], s=n.mine[i]; c.textContent=v===1 ? '·' : v===2 ? '✕' : ''; c.className='ng-c'+(s ? ' ship' : '')+(v===1 ? ' miss' : v===2 ? ' hit' : ''); });
    const pl=n.phase==='place' && !n.imReady;
    n.btns.shuffle.hidden=n.btns.ready.hidden=!pl;
  },
  status(n){
    if(n.over) return ngEnd(n);
    if(n.phase==='place') return n.imReady ? 'waiting for opponent to get ready' : 'place your fleet: Shuffle, then Ready';
    return (n.turnP===n.me ? (n.pend>=0 ? 'shot sent…' : 'fire!') : "opponent's move")+' (sunk '+n.sunk+'/'+BS_SHIPS.length+')';
  }
};
ngDef({id:'gbattleship',title:'Battleship (2 players)',kw:'battleship sea battle ships',w:380,spec:BS});
