"use strict";
/* ============================ Gamepad (Gamepad API) ============================
   Геймпад, джойстик, руль, педали — оси и кнопки числами на проводах, вибрация входом. Браузер показывает устройство
   только после нажатия на нём любой кнопки. Число осей и кнопок — параметры (порты пересобираются). */

const GP_AXES=['2','4','6','8'], GP_BTNS=['4','8','12','17'];
const gpN=(n,k,d)=>+n.p[k]||d;
function gpResize(n){                                // после смены числа осей / кнопок — убрать провода к исчезнувшим портам
  const valid=new Set(portsOf(n,'outs').map(p=>p.n));
  Graph.edges.filter(e=>e.from===n.id && !valid.has(e.fp)).forEach(delEdge);
  rebuildNode(n); markTopoDirty();
}
function gpPick(n){
  const pads=(navigator.getGamepads ? navigator.getGamepads() : []) || [];
  if(n.p.pad==='first') return Array.from(pads).find(p=>p && p.connected) || null;
  const p=pads[(+n.p.pad||1)-1]; return p && p.connected ? p : null;
}
const gpDead=(v,d)=>Math.abs(v)<d ? 0 : (v-Math.sign(v)*d)/(1-d);
def({ id:'gamepad', title:'Gamepad', cat:'Sources', kw:'joystick controller xbox playstation steering wheel pedals axes buttons rumble vibration',
  ins:[{n:'rumble',t:'num'},{n:'weak',t:'num'}],
  outs:n=>[...Array.from({length:gpN(n,'axes',4)},(_,k)=>({n:'a'+(k+1),t:'num'})),
           ...Array.from({length:gpN(n,'btns',12)},(_,k)=>({n:'b'+(k+1),t:'num'})),
           {n:'id',t:'txt'},{n:'on',t:'num'}],
  readout:true, tall:true,
  params:[{n:'pad',t:'select',opts:['first','1','2','3','4'],d:'first',label:'gamepad (first connected, or by index)'},
          {n:'axes',t:'select',opts:GP_AXES,d:'4',label:'axes (a1…)',fn:gpResize},
          {n:'btns',t:'select',opts:GP_BTNS,d:'12',label:'buttons (b1…, analog triggers give 0…1)',fn:gpResize},
          {n:'dead',t:'range',min:0,max:.5,step:.01,d:.08,label:'dead zone of the axes'}],
  init:n=>{ n.pad=null; n.vib=0; n.vals=[]; n.status='press a button on the gamepad'; },
  process(n,I){
    const p=gpPick(n), o={}, na=gpN(n,'axes',4), nb=gpN(n,'btns',12), dz=+n.p.dead||0;
    n.pad=p; n.vals=[];
    if(!p){ n.status='no gamepad — press a button on it'+(navigator.getGamepads ? '' : ' (Gamepad API unavailable)');
      for(let k=0;k<na;k++) o['a'+(k+1)]=0; for(let k=0;k<nb;k++) o['b'+(k+1)]=0; o.id=null; o.on=0; return o; }
    n.status=p.id;
    for(let k=0;k<na;k++){ const v=gpDead(p.axes[k]||0,dz); o['a'+(k+1)]=v; n.vals.push(v); }
    for(let k=0;k<nb;k++){ const b=p.buttons[k]; o['b'+(k+1)]=b ? (b.value!==undefined ? b.value : b.pressed ? 1 : 0) : 0; }
    o.id=p.id; o.on=1;
    const st=Math.max(0,Math.min(1,+I.rumble||0)), wk=Math.max(0,Math.min(1,+I.weak||0)), now=performance.now();
    if((st>.01 || wk>.01) && now-n.vib>80 && p.vibrationActuator && p.vibrationActuator.playEffect){
      n.vib=now; p.vibrationActuator.playEffect('dual-rumble',{startDelay:0,duration:120,weakMagnitude:wk,strongMagnitude:st}).catch(()=>{});
    }
    return o;
  },
  draw(n){ const r=n.el.querySelector('.readout'); if(!r) return;
    const t=n.status+(n.pad ? '\n'+n.vals.map((v,k)=>'a'+(k+1)+' '+v.toFixed(2)).join('  ')+'\n'+Array.from(n.pad.buttons).slice(0,gpN(n,'btns',12)).map((b,k)=>b.pressed ? 'b'+(k+1) : '').filter(Boolean).join(' ') : '');
    if(r.textContent!==t) r.textContent=t; }
});
