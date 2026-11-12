// Контроллер репитера (команды DTMF, пароль, TOT, хвост, позывной, экстренный режим): node tools/test-repctl.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Set,Map,Number,String,JSON,Array,Object,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/repctl-kernels.js'),'utf8')+';this.K={RC_CMD,rcParse,rcBuild,rcNew,rcStep};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,i='')=>{ if(!c){ bad++; console.log('FAIL',n,i); } else console.log('ok  ',n); };
const KEYS='0123456789ABCD*#';
// «нажать» последовательность: каждая цифра 80 мс, пауза 60 мс; возвращает все события
function press(st,seq,cos=1,dt=.01){ const ev=[];
  for(const ch of seq){ const d=KEYS.indexOf(ch); for(let i=0;i<8;i++) ev.push(...K.rcStep(st,dt,d,cos)); for(let i=0;i<6;i++) ev.push(...K.rcStep(st,dt,-1,cos)); }
  return ev; }
const run=(st,sec,cos,dt=.05)=>{ const ev=[]; for(let t=0;t<sec;t+=dt) ev.push(...K.rcStep(st,dt,-1,cos)); return ev; };
const kinds=ev=>ev.map(e=>e.kind).join(',');

// парсер ↔ сборщик
for(const [cmd,args] of [['link','05'],['unlink','05'],['unlink',''],['emergency on',''],['emergency off',''],['id now',''],['disable',''],['enable','']]){
  const s=K.rcBuild(cmd,args,'1234'), r=K.rcParse(s,'1234');
  ok('build → parse: '+cmd+(args ? ' '+args : '')+'  ('+s+')',r.ok && r.cmd===cmd && r.args===args,JSON.stringify(r));
}
ok('parse: wrong password / format / unknown command / missing argument',
  K.rcParse('*9999105#','1234').why==='password' && K.rcParse('1234105#','1234').why==='format' && K.rcParse('*12342#','1234').why==='command' && K.rcParse('*12341#','1234').why==='argument' && K.rcParse('*1234#','1234').why==='empty');
ok('parse: an argument to a command that takes none',K.rcParse('*123485#','1234').why==='argument');

// команды через автомат
{ const st=K.rcNew({pass:'1234'}); const ev=press(st,K.rcBuild('link','05','1234'));
  ok('link command: event and state',ev.some(e=>e.kind==='cmd' && e.cmd==='link') && ev.some(e=>e.kind==='link' && e.node==='05' && e.on) && st.linked.has('05'),kinds(ev));
  press(st,K.rcBuild('link','07','1234')); press(st,K.rcBuild('unlink','05','1234'));
  ok('unlink one, then all',st.linked.has('07') && !st.linked.has('05') && (press(st,K.rcBuild('unlink','','1234')),st.linked.size===0)); }
{ const st=K.rcNew({}); press(st,K.rcBuild('emergency on','','1234'));
  ok('emergency mode on/off',st.emergency===true && (press(st,K.rcBuild('emergency off','','1234')),st.emergency===false)); }
{ const st=K.rcNew({}); const e1=press(st,'*9999'+'1'+'05#'); ok('wrong password: denied',e1.some(e=>e.kind==='denied' && e.why==='password') && st.linked.size===0);
  press(st,'*1111105#'); const e3=press(st,'*2222105#');
  ok('three wrong passwords lock the commands',e3.some(e=>e.why==='lockout') && st.lockT>0);
  const e4=press(st,K.rcBuild('link','05','1234')); ok('locked: even the right password is refused',e4.some(e=>e.kind==='denied') && st.linked.size===0);
  run(st,61,1); ok('the lock ends after the lockout time',st.lockT===0 && (press(st,K.rcBuild('link','05','1234')),st.linked.has('05'))); }
{ const st=K.rcNew({digitTimeout:2}); press(st,'*12341'); const ev=run(st,2.5,0);
  ok('a pause longer than the digit timeout drops the half-typed command',ev.some(e=>e.kind==='timeout') && st.buf===''); }
{ const st=K.rcNew({}); const ev=press(st,'12341050#'); ok('digits without a leading * are ignored',ev.filter(e=>e.kind!=='ptt').length===0); }
{ const st=K.rcNew({}); press(st,K.rcBuild('disable','','1234')); run(st,1,1); ok('disable: no PTT even with a carrier',!st.ptt);
  press(st,K.rcBuild('enable','','1234'),0); const ev=run(st,.5,1); ok('enable: PTT again',st.ptt && !st.disabled); }
// PTT, хвост, TOT
{ const st=K.rcNew({hang:2,tot:10}); let ev=run(st,1,1); ok('carrier → PTT on',st.ptt && ev.some(e=>e.kind==='ptt' && e.on));
  ev=run(st,1.5,0); ok('hang time keeps PTT',st.ptt); ev=run(st,1,0); ok('PTT off after the hang time',!st.ptt && ev.some(e=>e.kind==='ptt' && !e.on)); }
{ const st=K.rcNew({hang:1,tot:5}); const ev=run(st,7,1); ok('TOT: transmitter off after the time-out',ev.some(e=>e.kind==='tot') && !st.ptt);
  run(st,.2,0); run(st,.2,1); ok('TOT: released when the carrier drops',st.ptt); }
{ const st=K.rcNew({hang:1,tot:5}); press(st,K.rcBuild('emergency on','','1234')); const ev=run(st,30,1); ok('emergency: no TOT',!ev.some(e=>e.kind==='tot') && st.ptt);
  run(st,1.5,0); ok('emergency: hang time at least 5 s',st.ptt); run(st,4,0); ok('…then PTT off',!st.ptt); }
// позывной
{ const st=K.rcNew({idEvery:60,idMin:10,tot:0}); const ev=run(st,125,1); const ids=ev.filter(e=>e.kind==="id").length; ok("periodic ID every 60 s during use (2 in 125 s)",ids===2,String(ids));
  const e2=run(st,5,0); ok('no ID at the end if one has just been sent',!e2.some(e=>e.kind==='id')); }
{ const st=K.rcNew({idEvery:600,idMin:10,tot:0}); run(st,20,1); const ev=run(st,5,0); ok('ID at the end of a transmission after ≥ idMin',ev.some(e=>e.kind==='id')); }
{ const st=K.rcNew({idEvery:600,idMin:10}); const ev=press(st,K.rcBuild('id now','','1234')); ok('ID now',ev.some(e=>e.kind==='id' && /command/.test(e.text))); }
{ const st=K.rcNew({idEvery:60,tot:0}); press(st,K.rcBuild('emergency on','','1234')); const ev=run(st,65,1); ok('emergency: ID twice as often',ev.filter(e=>e.kind==='id').length>=2); }
console.log(bad ? bad+' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
