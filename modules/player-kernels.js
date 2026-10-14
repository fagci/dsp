"use strict";
/* ============================ PLAYER KERNELS ============================ */
// Ядро плеера (Winamp): 10-полосный эквалайзер, баланс, порядок треков, теги ID3, формат времени. Без DOM.

const WP_BANDS=[60,170,310,600,1000,3000,6000,12000,14000,16000];
const WP_BAND_NAMES=['60','170','310','600','1K','3K','6K','12K','14K','16K'];
// пресеты в духе Winamp: pre — предусилитель, g — десять полос, дБ
const WP_EQ={
  'Flat':{pre:0,g:[0,0,0,0,0,0,0,0,0,0]},
  'Classical':{pre:0,g:[0,0,0,0,0,0,-4,-4,-4,-6]},
  'Club':{pre:0,g:[0,0,3,4,4,4,3,0,0,0]},
  'Dance':{pre:0,g:[6,4,2,0,0,-3,-4,-4,0,0]},
  'Full Bass':{pre:0,g:[6,6,6,3,1,-3,-5,-6,-6,-6]},
  'Full Treble':{pre:0,g:[-6,-6,-6,-3,2,6,9,9,9,10]},
  'Large Hall':{pre:0,g:[6,6,3,3,0,-3,-3,-3,0,0]},
  'Live':{pre:0,g:[-3,0,2,3,3,3,2,1,1,1]},
  'Party':{pre:0,g:[5,5,0,0,0,0,0,0,5,5]},
  'Pop':{pre:0,g:[-1,3,5,6,4,0,-1,-1,-1,-1]},
  'Reggae':{pre:0,g:[0,0,0,-3,0,4,4,0,0,0]},
  'Rock':{pre:0,g:[5,3,-3,-5,-2,2,5,6,6,6]},
  'Ska':{pre:0,g:[-2,-3,-2,0,3,4,6,6,7,6]},
  'Soft':{pre:0,g:[3,1,0,-1,0,3,5,6,7,8]},
  'Soft Rock':{pre:0,g:[3,3,1,0,-3,-4,-2,0,2,6]},
  'Techno':{pre:0,g:[5,4,0,-3,-3,0,5,6,6,5]}
};

// пик-фильтр RBJ → [b0,b1,b2,a1,a2] (a0 уже учтён)
function wpPeak(f0,gdb,Q,sr){
  f0=Math.min(f0,sr*.45);
  const A=Math.pow(10,gdb/40), w=2*Math.PI*f0/sr, c=Math.cos(w), al=Math.sin(w)/(2*Q), a0=1+al/A;
  return [(1+al*A)/a0,-2*c/a0,(1-al*A)/a0,-2*c/a0,(1-al/A)/a0];
}
// баланс -1…1: сторона, от которой уходим, убавляется, другая остаётся (как в Winamp)
function wpBalance(b){ b=Math.max(-1,Math.min(1,b)); return [Math.min(1,1-b),Math.min(1,1+b)]; }
// 3665.5 → '61:05'; отрицательное — с минусом (оставшееся время)
function wpTime(s){
  if(!isFinite(s)) return '--:--';
  const neg=s<0; s=Math.floor(Math.abs(s)); const m=Math.floor(s/60), r=s%60;
  return (neg?'-':'')+(m<10?'0':'')+m+':'+(r<10?'0':'')+r;
}

// порядок воспроизведения: без shuffle — 0..n-1, с shuffle — перемешанный (Фишер—Йейтс), cur идёт первым
function wpOrder(len,shuffle,cur,rnd){
  const o=[]; for(let i=0;i<len;i++) o.push(i);
  if(!shuffle) return o;
  rnd=rnd||Math.random;
  for(let i=len-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [o[i],o[j]]=[o[j],o[i]]; }
  const k=o.indexOf(cur); if(k>0){ o.splice(k,1); o.unshift(cur); }
  return o;
}
// следующий трек в порядке order: dir ±1; repeat 'off' | 'all' | 'one' (one — только для автоперехода, ручной шаг идёт дальше)
// → индекс трека или -1 (конец списка)
function wpStep(order,cur,dir,repeat,auto){
  if(!order.length) return -1;
  if(auto && repeat==='one') return cur;
  const k=order.indexOf(cur);
  if(k<0) return order[0];
  let j=k+dir;
  if(j<0||j>=order.length){ if(repeat==='off' && auto) return -1; j=(j+order.length)%order.length; }
  return order[j];
}

// теги: ID3v2 (заголовок в начале) и ID3v1 (128 байт в конце); u8 — Uint8Array файла
function wpSyncSafe(u,o){ return (u[o]&127)<<21|(u[o+1]&127)<<14|(u[o+2]&127)<<7|(u[o+3]&127); }
function wpText(u,a,b){
  if(b<=a) return '';
  const enc=u[a]; a++;
  const dec=(from,to,lbl)=>{ try{ return new TextDecoder(lbl).decode(u.subarray(from,to)); }catch(e){ return ''; } };
  let s=enc===0 ? dec(a,b,'windows-1252') : enc===3 ? dec(a,b,'utf-8') : enc===2 ? dec(a,b,'utf-16be')
      : (u[a]===0xFE&&u[a+1]===0xFF) ? dec(a+2,b,'utf-16be') : (u[a]===0xFF&&u[a+1]===0xFE) ? dec(a+2,b,'utf-16le') : dec(a,b,'utf-16le');
  return s.replace(/\0+$/,'').replace(/\0/g,' / ').trim();
}
function wpId3(u){
  const t={title:'',artist:'',album:'',year:''};
  if(u.length>10 && u[0]===0x49&&u[1]===0x44&&u[2]===0x33){
    const ver=u[3], end=Math.min(u.length,10+wpSyncSafe(u,6));
    let o=10;
    if(u[5]&0x40){ o+= ver===4 ? wpSyncSafe(u,10) : (u[10]<<24|u[11]<<16|u[12]<<8|u[13])>>>0; }
    const map={TIT2:'title',TPE1:'artist',TALB:'album',TYER:'year',TDRC:'year',TT2:'title',TP1:'artist',TAL:'album',TYE:'year'};
    const v22=ver===2, hl=v22?6:10;
    while(o+hl<=end && u[o]){
      const id=String.fromCharCode(u[o],u[o+1],u[o+2])+(v22?'':String.fromCharCode(u[o+3]));
      const sz=v22 ? u[o+3]<<16|u[o+4]<<8|u[o+5] : ver===4 ? wpSyncSafe(u,o+4) : (u[o+4]<<24|u[o+5]<<16|u[o+6]<<8|u[o+7])>>>0;
      if(sz<=0||o+hl+sz>end) break;
      const k=map[id]; if(k&&!t[k]) t[k]=wpText(u,o+hl,o+hl+sz);
      o+=hl+sz; }
  }
  if(!t.title && u.length>=128){
    const b=u.length-128;
    if(u[b]===0x54&&u[b+1]===0x41&&u[b+2]===0x47){
      const f=(a,l)=>{ let e=a+l; while(e>a&&(u[e-1]===0||u[e-1]===32)) e--; return new TextDecoder('windows-1252').decode(u.subarray(a,e)); };
      t.title=f(b+3,30); t.artist=f(b+33,30); t.album=f(b+63,30); t.year=f(b+93,4); }
  }
  return t;
}
// «Артист - Название», иначе имя файла без расширения
function wpName(tag,file){
  const base=String(file||'').replace(/^.*[\\/]/,'').replace(/\.[A-Za-z0-9]{1,5}$/,'').replace(/[_]+/g,' ');
  if(tag && tag.title) return tag.artist ? tag.artist+' - '+tag.title : tag.title;
  return base;
}
