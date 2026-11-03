"use strict";
/* ============================ Measure Entry ============================
   Ввод типовых замеров для Site Plan: тип замера, имена точек и значение — число или выражение как на калькуляторе («12.4+3.6*2», «hypot(3;4)») —
   кнопкой «＋ Add» или внешним сигналом: Number Pad / Pocket Calculator, лазерный дальномер по BLE (BLE GATT) на входах v и go.
   Журнал замеров — обычный текст (его можно править), на выход — строки для Site Plan (lines) и записи rec (kind, a, b, value, sigma, line) — в Table или сразу в Site Plan.
   Цепочка: после стороны «A-B» следующая начинается в B («B-C») — обход периметра одним числом на сторону. Ядро — measureentry-kernels.js. */

function meAdd(n,value,src){
  const p=n.p, kn=p.kind, K=ME_KINDS[kn];
  const o={a:p.from,b:p.to,c:p.third,value,sigma:+p.sigma,hd:meEval(p.hd),eye:+p.eye};
  const line=meLine(kn,o);
  if(!line){ n.msg='cannot add: '+(!isFinite(value) ? 'no value (type a number or an expression, or wire v + go)' : K?.pts===1 ? 'give the point name' : K?.pts===3 ? 'give three different points: from, to (the vertex), third' : kn.startsWith('clinometer') ? 'give two different points, the angle and the horizontal distance «hd»' : 'give two different points')+' — '+kn; return false; }
  const cur=String(p.log||'').replace(/\s+$/,'');
  const v=(cur ? cur+'\n' : '')+line; if(n.set?.log) n.set.log(v); else p.log=v;
  n.emitRec=[{t:new Date().toISOString(),kind:K.k,a:o.a,b:K.pts>=2 ? o.b : '',c:K.pts===3 ? o.c : '',value,sigma:o.sigma>0 ? o.sigma : '',line,src}];
  n.msg='added: '+line+(src ? ' ('+src+')' : '');
  if(p.chain && (K.k==='d' || K.k==='h' || K.k==='dz' || K.k==='az' || K.k==='tilt')){ setMod(n,'from',meName(p.to)); setMod(n,'to',meNext(meName(p.to))); }
  else if(K.pts===1){ setMod(n,'from',meNext(meName(p.from))); }
  if(p.clear) setMod(n,'value','');
  n.logKey=''; return true;
}
function meUndo(n){
  const L=String(n.p.log||'').split('\n'); while(L.length && !L[L.length-1].trim()) L.pop();
  const gone=L.pop(); const v=L.join('\n'); if(n.set?.log) n.set.log(v); else n.p.log=v; n.msg=gone ? 'removed: '+gone : 'the log is empty'; n.logKey='';
}

def({ id:'measureentry', title:'Measure Entry', cat:'Geo', touch:true, kw:'measure entry tape calculator keypad survey measurements log distance chain walk perimeter laser meter rangefinder input table site plan',
  // v — значение снаружи (Number Pad, Pocket Calculator, BLE GATT дальномер), go — импульс «добавить» (Number Pad enter, BLE GATT new);
  // lines — весь журнал для Site Plan; rec — новый замер записью (kind, a, b, c, value, sigma, line, src) — в Table или в Site Plan; n — число замеров
  ins:[{n:'v',t:'num'},{n:'go',t:'num'}],
  outs:[{n:'lines',t:'txt'},{n:'rec',t:'rec'},{n:'n',t:'num'}],
  w:380, readout:true,
  params:[{n:'kind',t:'select',opts:Object.keys(ME_KINDS),d:'side (tape along the ground)',label:'what is measured'},
          {n:'from',t:'text',d:'A',label:'from point (A)'},
          {n:'to',t:'text',d:'B',label:'to point (B; the vertex of an angle)'},
          {n:'third',t:'text',d:'C',label:'third point (C) — angles only'},
          {n:'value',t:'text',d:'',label:'value: a number or an expression like on a calculator (12.4+3.6*2 · sqrt(3^2+4^2) · hypot(3;4) · sin cos tan atan in degrees · pi · ^ — power; function arguments through «;»)'},
          {n:'add',t:'button',label:'＋ Add',fn:n=>{ const v=meEval(n.p.value); meAdd(n,v,'typed'); }},
          {n:'chain',t:'check',d:true,label:'chain: after A-B the next one is B-C (names go A, B, C … Z, A1, B1 …)'},
          {n:'clear',t:'check',d:true,label:'clear the value after adding'},
          {n:'sigma',t:'range',min:0,max:1,step:.005,d:0,label:'error of this measurement, m or ° (0 — the Site Plan default)'},
          {n:'hd',t:'text',d:'',label:'clinometer: horizontal distance, m (a number or an expression)'},
          {n:'eye',t:'range',min:0,max:2.2,step:.05,d:0,label:'clinometer: eye height, m (0 — the Site Plan default)'},
          {n:'undo',t:'button',label:'Undo the last measurement',fn:n=>meUndo(n)},
          {n:'close',t:'button',label:'Close the contour (poly through the chain)',fn:n=>{ const l=meChainPoly(n.p.log); if(!l){ n.msg='need a chain of 3+ points: A-B, B-C, C-D…'; return; } const cur=String(n.p.log||'').replace(/\s+$/,''); const v=cur+'\n'+l; if(n.set?.log) n.set.log(v); else n.p.log=v; n.msg='added: '+l; n.logKey=''; }},
          {n:'log',t:'code',plain:true,d:'',label:'the log (editable, one measurement per line)',fn:n=>{ n.logKey=''; }}],
  init:n=>{ n.msg=''; n.emitRec=null; n.lastGo=0; n.lastV=null; n.logKey=null; n.nlines=0; },
  process(n,I){
    const go=typeof I.go==='number' && isFinite(I.go) ? I.go : 0, v=typeof I.v==='number' && isFinite(I.v) ? I.v : NaN;
    if(go>0 && n.lastGo<=0){ meAdd(n,isFinite(v) ? v : meEval(n.p.value),'wired'); }
    n.lastGo=go;
    const log=String(n.p.log||''), cnt=log.split('\n').filter(l=>l.replace(/#.*/,'').trim()).length, out=n.emitRec; n.emitRec=null; n.nlines=cnt;
    return {lines:log, rec:out, n:cnt};
  },
  draw(n){
    const p=n.p, K=ME_KINDS[p.kind]||{pts:2}, L=[];
    const val=meEval(p.value), pts=K.pts===1 ? meName(p.from) : K.pts===3 ? [p.from,p.to,p.third].map(meName).join('-') : meName(p.from)+'-'+meName(p.to);
    L.push('next: '+pts+' · '+p.kind+' · value '+(String(p.value||'').trim() ? (isFinite(val) ? '= '+(+val.toFixed(4)) : '⚠ cannot read «'+p.value+'»') : '— (type it, or wire v + go)'));
    if(n.msg) L.push(n.msg);
    L.push(n.nlines+' measurement'+(n.nlines===1 ? '' : 's')+' in the log');
    const t=L.join('\n'), r=n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t;
  }});
