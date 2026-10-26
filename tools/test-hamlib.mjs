// Ядро rigctld: node tools/test-hamlib.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Number,Array,String,Object,parseFloat,JSON});
vm.runInContext(fs.readFileSync(path.join(root,'modules/hamlib-kernels.js'),'utf8')+';this.K={HL_MODES,hlQueue,hlCmd,hlSUnits,hlSText,hlFmtFreq,hlDigits,hlStepFreq,hlLayout,hlHit,hlSimRig};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const J=x=>JSON.stringify(x);

// формат и разряды
ok('fmt 14.074.000',K.hlFmtFreq(14074000)==='14.074.000',K.hlFmtFreq(14074000));
ok('fmt 145.500.000',K.hlFmtFreq(145500000)==='145.500.000');
ok('fmt small',K.hlFmtFreq(7000)==='0.007.000',K.hlFmtFreq(7000));
ok('fmt NaN',K.hlFmtFreq(NaN)==='–');
ok('digits',J(K.hlDigits(14074000,10).map(x=>x.d).join(''))==='"0014074000"');
ok('digits dim leading',K.hlDigits(14074000,10)[0].dim && !K.hlDigits(14074000,10)[2].dim && !K.hlDigits(0,10)[9].dim);
ok('step up carry',K.hlStepFreq(14099999,1,1,10)===14100000);
ok('step down at 0 stays',K.hlStepFreq(500,1000,-1,10)===0);
ok('step 1 kHz',K.hlStepFreq(14074000,1000,1,10)===14075000);
ok('step max',K.hlStepFreq(9999999999,1,1,10)===9999999999);

// S-метр
ok('S9 = 0 dB',K.hlSText(0)==='S9' && K.hlSUnits(0)===9);
ok('S9+20',K.hlSText(20)==='S9+20');
ok('S5 = −24 dB',K.hlSText(-24)==='S5',K.hlSText(-24));
ok('S0 floor',K.hlSUnits(-100)===0);
ok('S NaN',K.hlSText(NaN)==='–' && Number.isNaN(K.hlSUnits(NaN)));

// очередь: запрос с двумя строками, ответ кусками
const q=K.hlQueue(500); let got=null, err='e';
q.add(...K.hlCmd.getMode(),(ls,e)=>{ got=ls; err=e; });
ok('pump gives command',q.pump(0)==='m\n');
ok('one in flight',q.pump(1)===null);
q.feed('US'); q.feed('B\n24'); ok('half reply waits',got===null);
q.feed('00\n'); ok('mode reply',J(got)==='["USB","2400"]' && err===null,J(got));
// RPRT 0 на запись, RPRT -n — ошибка
let r1=null,e1='x'; q.add('F 7074000\n',1,(ls,e)=>{ r1=ls; e1=e; });
ok('set cmd sent',q.pump(10)==='F 7074000\n'); q.feed('RPRT 0\n'); ok('set ok',J(r1)==='[]' && e1===null);
let e2=null; q.add('M XXX 0\n',1,(ls,e)=>{ e2=e; });
q.pump(20); q.feed('RPRT -1\n'); ok('set error',e2==='RPRT -1',e2);
// RPRT посреди ответа на чтение (rig не поддерживает) прерывает ожидание второй строки
let e3=null,g3='x'; q.add('m\n',2,(ls,e)=>{ g3=ls; e3=e; }); q.pump(30); q.feed('RPRT -11\n'); ok('error short-circuits multi-line',g3===null && e3==='RPRT -11');
// таймаут
let e4=null; q.add('f\n',1,(ls,e)=>{ e4=e; }); q.pump(100); q.pump(700); ok('timeout releases',e4==='timeout',e4);
ok('after timeout next goes',(()=>{ q.add('f\n',1); return q.pump(710)==='f\n'; })());
// CRLF и пустые строки
let g5=null; const q2=K.hlQueue(); q2.add('f\n',1,ls=>{ g5=ls; }); q2.pump(0); q2.feed('\r\n7074000\r\n'); ok('crlf and blank lines',J(g5)==='["7074000"]',J(g5));
// reset
let e6=null; const q3=K.hlQueue(); q3.add('f\n',1,(l,e)=>{ e6=e; }); q3.pump(0); q3.reset('closed'); ok('reset fails pending',e6==='closed' && q3.pending()===0);
// n=0 уходит сразу
const q4=K.hlQueue(); let fired=false; q4.add('x\n',0,()=>{ fired=true; }); ok('n=0 fire and forget',q4.pump(0)==='x\n' && fired && q4.pump(1)===null);

// виртуальный rig через очередь
const sim=K.hlSimRig(), q5=K.hlQueue(), rs={};
const run=(c,n,k)=>{ q5.add(c,n,(ls,e)=>{ rs[k]=e?{e}:ls; }); const s=q5.pump(0); q5.feed(sim.respond(s)); };
run(...K.hlCmd.setFreq(7074000),'sf'); run(...K.hlCmd.getFreq(),'gf'); run(...K.hlCmd.setMode('USB',2400),'sm'); run(...K.hlCmd.getMode(),'gm');
run(...K.hlCmd.setPtt(true),'sp'); run(...K.hlCmd.getPtt(),'gp'); run(...K.hlCmd.getStrength(),'gl'); run('X\n',1,'bad');
ok('sim freq',rs.gf[0]==='7074000' && sim.f===7074000);
ok('sim mode',J(rs.gm)==='["USB","2400"]',J(rs.gm));
ok('sim ptt',rs.gp[0]==='1');
ok('sim strength is a number',Number.isFinite(parseFloat(rs.gl[0])));
ok('sim unknown → error',rs.bad.e==='RPRT -11');
ok('sim rejects bad mode',(()=>{ let e; q5.add('M BOGUS 0\n',1,(l,er)=>{ e=er; }); q5.feed(sim.respond(q5.pump(0))); return e==='RPRT -1'; })());

// раскладка и попадания
const L=K.hlLayout(420,160,10,10);
ok('layout 10 digits, 10 modes',L.digits.length===10 && L.modes.length===10);
ok('digits inside the canvas',L.digits.every(d=>d.x>=0 && d.x+d.w<=420),J(L.digits.at(-1)));
ok('hit digit centre',K.hlHit(L.digits[3],L.digits[3].x+2,L.digits[3].y+2) && !K.hlHit(L.digits[3],-5,-5));
ok('modes inside',L.modes.at(-1).x+L.modes.at(-1).w<=420+1,J(L.modes.at(-1)));
ok('layout fits height',L.sm.y+L.sm.h<=160,J(L.sm));
console.log(bad?bad+' FAILED':'all passed'); process.exit(bad?1:0);
