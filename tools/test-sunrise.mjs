// modules/sunrise-kernels.js: расписание побудки, фазы, кривые света и звука, цвет неба (без DOM)
import fs from 'fs';
import vm from 'vm';
const g={module:{exports:{}},Date,Math}; vm.createContext(g);
vm.runInContext(fs.readFileSync(new URL('../modules/sunrise-kernels.js',import.meta.url),'utf8'),g);
const K=g.module.exports; let bad=0;
const ok=(n,c)=>{ console.log((c?'ok   ':'FAIL ')+n); if(!c) bad++; };
const T=(y,mo,d,h,mi,s=0)=>new Date(y,mo-1,d,h,mi,s).getTime();   // местное время — как в узле

ok('время: 7:00, 07.30, 6h15, мусор → 7:00, 25:99 зажато', K.sunParseTime('7:00')===420 && K.sunParseTime('07.30')===450 && K.sunParseTime('6h15')===375 && K.sunParseTime('abc')===420 && K.sunParseTime('25:99')===23*60+59);
ok('формат времени', K.sunFmtTime(450)==='7:30' && K.sunFmtTime(5)==='0:05');
// 2026-11-12 — четверг
const cfg={time:'7:00',days:'every day',lead:30,hold:10};
let st=K.sunState(T(2026,11,12,5,0),cfg);
ok('до рассвета — wait, left = до начала рассвета не считается: left до побудки', st.phase==='wait' && st.left===2*3600 && st.frac===0);
st=K.sunState(T(2026,11,12,6,45),cfg);
ok('за 15 минут до побудки — ramp, середина', st.phase==='ramp' && Math.abs(st.frac-.5)<1e-9 && st.left===900);
st=K.sunState(T(2026,11,12,6,30),cfg);
ok('граница начала: ramp, frac 0', st.phase==='ramp' && st.frac===0);
st=K.sunState(T(2026,11,12,7,5),cfg);
ok('после побудки — hold, полный свет', st.phase==='hold' && st.frac===1 && st.left===0);
st=K.sunState(T(2026,11,12,7,10),cfg);
ok('hold кончился — ждём следующее утро', st.phase==='wait' && st.wake===T(2026,11,13,7,0) && st.left===(T(2026,11,13,7,0)-T(2026,11,12,7,10))/1000);
// дни недели: пятница 13-е → суббота 14-е
const wk={...cfg,days:'weekdays'};
st=K.sunState(T(2026,11,13,8,0),wk);
ok('weekdays: после пятницы следующая побудка — понедельник', st.phase==='wait' && new Date(st.wake).getDay()===1 && st.wake===T(2026,11,16,7,0));
const we={...cfg,days:'weekends'};
st=K.sunState(T(2026,11,12,12,0),we);
ok('weekends: из четверга — суббота', new Date(st.wake).getDay()===6 && st.wake===T(2026,11,14,7,0));
// рассвет через полночь: побудка 0:10, рассвет 30 мин — начинается 23:40 накануне
st=K.sunState(T(2026,11,12,23,50),{...cfg,time:'0:10'});
ok('рассвет, начавшийся накануне вечером', st.phase==='ramp' && Math.abs(st.frac-1/3)<1e-9 && st.left===1200);
// «я проснулся»: отказ гасит этот рассвет, но не следующий
const W=T(2026,11,12,7,0);
st=K.sunState(T(2026,11,12,6,50),{...cfg,dismissed:W});
ok('dismissed: этот рассвет пропущен, следующий — завтра', st.phase==='wait' && st.wake===T(2026,11,13,7,0));
// ручной запуск (тест / вход start)
st=K.sunState(1000000,{...cfg,over:{W:1000000+120000,lead:120000}});
ok('override: рассвет по заданной длине', st.phase==='ramp' && st.frac===0 && st.left===120);
st=K.sunState(1000000+60000,{...cfg,over:{W:1000000+120000,lead:120000}});
ok('override: середина', Math.abs(st.frac-.5)<1e-9);
// кривые
const mono=(f)=>{ let p=-1; for(let i=0;i<=20;i++){ const v=f(i/20); if(v<p-1e-12) return false; p=v; } return true; };
for(const c of K.SUN_CURVES) ok('свет «'+c+'»: 0→1 и растёт', K.sunLight(0,c)===0 && Math.abs(K.sunLight(1,c)-1)<1e-12 && mono(f=>K.sunLight(f,c)));
ok('gamma: начало тише линейной', K.sunLight(.3,'gamma',2)<.3 && K.sunLight(.3,'linear')===.3);
ok('вне диапазона зажимается', K.sunLight(-1,'linear')===0 && K.sunLight(7,'linear')===1);
ok('звук: до soundAt тишина, после растёт, в конце 1', K.sunGain(.3,.4)===0 && K.sunGain(.4,.4)===0 && K.sunGain(.7,.4)>0 && K.sunGain(1,.4)===1 && mono(f=>K.sunGain(f,.4)));
ok('soundAt=1: звук только на пике, без деления на ноль', K.sunGain(.99,1)===0 && Number.isFinite(K.sunGain(1,1)));
// цвет
ok('цвет: старт чёрный, финал тёплый белый', K.sunHex(K.sunColor(0))==='#000000' && K.sunHex(K.sunColor(1))==='#fff0d8');
const warm=K.sunColor(.35); ok('цвет на 35%: красно-оранжевый (R≫G>B)', warm[0]>150 && warm[0]>warm[1]*2 && warm[1]>warm[2]);
ok('цвет: синий канал растёт монотонно (небо теплеет к белому)', mono(f=>K.sunColor(f)[2]) && mono(f=>K.sunColor(f)[1]));
ok('кельвины 1500…5500', K.sunKelvin(0)===1500 && K.sunKelvin(1)===5500 && K.sunKelvin(.5)===3500);
// сборка
let m=K.sunMix(K.sunState(T(2026,11,12,6,45),cfg),{curve:'linear',soundAt:.4,vol:.8,maxLight:1});
ok('mix на середине: свет .5, звук ещё да (0.5>0.4), громкость × vol', m.light===.5 && m.gain>0 && m.gain<=.8 && /^#[0-9a-f]{6}$/.test(m.hex));
m=K.sunMix(K.sunState(T(2026,11,12,7,5),cfg),{curve:'gamma',soundAt:.4,vol:.8,maxLight:.9});
ok('mix в hold: свет = maxLight, звук = vol', Math.abs(m.light-.9)<1e-9 && Math.abs(m.gain-.8)<1e-9);
m=K.sunMix(K.sunState(T(2026,11,12,5,0),cfg),{curve:'gamma',soundAt:.4,vol:1});
ok('mix в wait: тихо и темно', m.light===0 && m.gain===0);
ok('подпись остатка', K.sunLeftTxt(3725)==='1:02:05' && K.sunLeftTxt(74)==='1:14' && K.sunLeftTxt(Infinity)==='—');
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
