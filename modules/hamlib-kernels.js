"use strict";
/* ======================= HAMLIB rigctld — ядро ======================= */
// Протокол rigctld (текстовый, короткие команды) и очередь запросов, без DOM: node tools/test-hamlib.mjs.
// rigctld по TCP, а браузер TCP не открывает: между ними мост в WebSocket (websockify 8768 127.0.0.1:4532).

const HL_MODES=['USB','LSB','CW','CWR','AM','FM','WFM','RTTY','PKTUSB','PKTLSB'];

// Очередь «команда → N строк ответа». Ответ rigctld на ошибку — одна строка RPRT -n, на запись — RPRT 0.
// pump(now) отдаёт следующую команду для отправки (одна в полёте); feed(text) складывает ответ; зависший запрос снимается по таймауту.
function hlQueue(timeoutMs){
  const q={items:[], cur:null, buf:'', lines:[], timeout:timeoutMs||1500};
  q.add=(cmd,nLines,cb)=>{ q.items.push({cmd,n:nLines,cb}); };
  q.pending=()=>q.items.length+(q.cur?1:0);
  q.pump=now=>{
    if(q.cur && now-q.cur.t>q.timeout){ const c=q.cur; q.cur=null; q.lines=[]; q.buf=''; c.cb&&c.cb(null,'timeout'); }
    if(q.cur) return null;
    const it=q.items.shift(); if(!it) return null;
    q.lines=[];
    if(it.n===0){ it.cb&&it.cb([],null); return it.cmd; }
    q.cur={...it,t:now}; return it.cmd;
  };
  q.feed=text=>{
    q.buf+=text;
    const parts=q.buf.split(/\r\n|\r|\n/); q.buf=parts.pop();
    for(const l of parts){
      if(!l || !q.cur) continue;
      q.lines.push(l);
      const c=q.cur, rp=/^RPRT\s+(-?\d+)/.exec(l);
      if(rp){ const code=+rp[1]; q.cur=null; q.lines=[]; c.cb&&c.cb(code===0 ? [] : null, code===0 ? null : 'RPRT '+code); }
      else if(q.lines.length>=c.n){ const ls=q.lines; q.cur=null; q.lines=[]; c.cb&&c.cb(ls,null); }
    }
  };
  q.reset=err=>{
    const all=[...(q.cur?[q.cur]:[]),...q.items]; q.cur=null; q.items=[]; q.lines=[]; q.buf='';
    for(const c of all) c.cb&&c.cb(null,err||'closed');
  };
  return q;
}

// Команды: чтение возвращает [команда, число строк ответа]
const hlCmd={
  getFreq:()=>['f\n',1], setFreq:hz=>['F '+Math.round(hz)+'\n',1],
  getMode:()=>['m\n',2], setMode:(m,bw)=>['M '+m+' '+(bw>=0 ? Math.round(bw) : 0)+'\n',1],
  getPtt:()=>['t\n',1], setPtt:on=>['T '+(on?1:0)+'\n',1],
  getStrength:()=>['l STRENGTH\n',1]
};
const hlNum=s=>{ const v=parseFloat(s); return Number.isFinite(v) ? v : NaN; };

// STRENGTH — дБ относительно S9. S1…S9 по 6 дБ; выше S9 — «S9+дБ».
function hlSUnits(db){ return Number.isFinite(db) ? Math.max(0,Math.min(9,9+db/6)) : NaN; }
function hlSText(db){
  if(!Number.isFinite(db)) return '–';
  if(db>=0) return db<1 ? 'S9' : 'S9+'+Math.round(db);
  return 'S'+Math.max(0,Math.round(9+db/6));
}
// 14074000 → «14.074.000»
function hlFmtFreq(hz){
  if(!Number.isFinite(hz) || hz<0) return '–';
  const s=String(Math.round(hz)).padStart(7,'0'), g=[];
  for(let i=s.length;i>0;i-=3) g.unshift(s.slice(Math.max(0,i-3),i));
  return g.join('.');
}
// Цифры частоты для табло: n позиций слева с ведущими пробелами; возвращает [{d,pow}]
function hlDigits(hz,n){
  const s=String(Math.max(0,Math.round(hz))).padStart(n,'0').slice(-n), out=[];
  let lead=true;
  for(let i=0;i<n;i++){ if(s[i]!=='0') lead=false; out.push({d:s[i],pow:Math.pow(10,n-1-i),dim:lead && i<n-1}); }
  return out;
}
// шаг по разряду pow: вверх/вниз с переносом; не ниже 0 и не выше 10^n−1
function hlStepFreq(hz,pow,dir,n){
  const max=Math.pow(10,n)-1;
  return Math.max(0,Math.min(max,Math.round(hz)+dir*pow));
}

// Раскладка табло (для рисования и попаданий мышью). W,H — размер канвы; nd — число цифр.
function hlLayout(W,H,nd,nModes){
  const pad=8, top=pad, dh=Math.max(24,Math.min(H*.36,W/(nd+3)*1.6)), dw=Math.min(dh*.62,(W-pad*2)/(nd+nd/3)), gap=dw*.12;
  const digits=[]; let x=pad, grp=0;
  for(let i=0;i<nd;i++){
    const left=nd-i; if(i && left%3===0) x+=dw*.45;
    digits.push({x,y:top,w:dw,h:dh,i}); x+=dw+gap; grp++;
  }
  const y2=top+dh+pad, ch=Math.max(18,Math.min(26,H*.13)), modes=[];
  const mw=Math.max(34,Math.min(58,(W-pad*2-60)/nModes));
  for(let i=0;i<nModes;i++) modes.push({x:pad+i*(mw+3),y:y2,w:mw,h:ch,i});
  const y3=y2+ch+pad, ptt={x:pad,y:y3,w:64,h:ch+4}, sm={x:pad+72,y:y3,w:Math.max(40,W-pad*2-72),h:ch+4};
  return {digits,modes,ptt,sm,dh};
}
const hlHit=(r,x,y)=>x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h;

// Виртуальный rigctld: тот же текст, что у настоящего, — для пресетов без железа и для тестов.
function hlSimRig(){
  const s={f:145500000, mode:'FM', bw:15000, ptt:0, rssi:-30, t:0};
  s.step=dt=>{ s.t+=dt; s.rssi=-36+18*Math.sin(s.t*.7)+6*Math.sin(s.t*2.3); };
  s.respond=cmd=>{
    const a=cmd.trim().split(/\s+/), c=a[0];
    if(c==='f') return s.f+'\n';
    if(c==='F'){ const v=hlNum(a[1]); if(!(v>=0)) return 'RPRT -1\n'; s.f=Math.round(v); return 'RPRT 0\n'; }
    if(c==='m') return s.mode+'\n'+s.bw+'\n';
    if(c==='M'){ if(!HL_MODES.includes(a[1])) return 'RPRT -1\n'; s.mode=a[1]; s.bw=hlNum(a[2])||0; return 'RPRT 0\n'; }
    if(c==='t') return s.ptt+'\n';
    if(c==='T'){ s.ptt=a[1]==='1' ? 1 : 0; return 'RPRT 0\n'; }
    if(c==='l' && a[1]==='STRENGTH') return Math.round(s.rssi)+'\n';
    return 'RPRT -11\n';
  };
  return s;
}
