// sigid: слабые сигналы в шуме, нужная полоса, учёт диапазона. Проверка: node tools/test-sigid.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=f=>fs.readFileSync(path.join(root,f),'utf8');
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };

// ---- ядро: sidWeakFind / sidRefine / sidNeedBw ----
const kc=vm.createContext({Math,Float32Array,Float64Array,Object,Array});
vm.runInContext(rd('modules/sigid-kernels.js')+';globalThis.K={sidWeakFind,sidRefine,sidNeedBw,sidStdBw,sidDemodOf};',kc);
const K=kc.K;
let seed=12345; const rnd=()=>{ seed=(seed+0x6D2B79F5)|0; let t=Math.imul(seed^(seed>>>15),1|seed); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };   // mulberry32
const gauss=()=>Math.sqrt(-2*Math.log(rnd()+1e-12))*Math.cos(2*Math.PI*rnd());
// спектр мощности: шум (K усреднённых кадров → хи-квадрат 2K степеней), сигнал — прямоугольник шириной w бинов с превышением snr дБ над шумом в каждом бине
function spec(N,frames,sigs){
  const pw=new Float32Array(N);
  for(let i=0;i<N;i++){
    let p=1; for(const s of sigs) if(i>=s.a && i<s.a+s.w) p+=Math.pow(10,s.db/10);
    let acc=0; for(let k=0;k<frames;k++){ const a=gauss(), b=gauss(); acc+=(a*a+b*b)/2; }
    pw[i]=p*acc/frames;
  }
  return pw;
}
const flat=new Float32Array(8192).fill(1);
const wide=spec(8192,64,[{a:3000,w:200,db:-8}]);        // −8 дБ на бин, 200 бинов: в одном кадре не виден
const one=spec(8192,1,[{a:3000,w:200,db:-8}]);
const rw=K.sidWeakFind(wide,flat,1,8190,5);
ok(rw.length===1,'слабый широкий сигнал найден один раз, найдено '+rw.length);
if(rw.length){ const c=(rw[0].a+rw[0].b)/2; ok(Math.abs(c-3100)<120,'центр слабого сигнала ≈3100, получено '+c.toFixed(0));
  const [a,b]=K.sidRefine(wide,flat,1,8190,rw[0].a,rw[0].b,rw[0].snr); ok(Math.abs((b-a+1)-200)<60 && Math.abs((a+b)/2-3100)<40,'уточнённая ширина ≈200: '+(b-a+1)); }
const noise=spec(8192,64,[]); let fa=0; for(let t=0;t<20;t++) fa+=K.sidWeakFind(spec(8192,64,[]),flat,1,8190,5).length;
ok(fa===0,'ложных срабатываний на чистом шуме: '+fa);
// узкая несущая в шуме
const car=spec(8192,64,[{a:5000,w:3,db:2}]); const rc=K.sidWeakFind(car,flat,1,8190,5);
ok(rc.length===1 && Math.abs(rc[0].a-5001)<8,'узкая слабая несущая найдена');
ok(K.sidStdBw(13e3)===15e3 && K.sidStdBw(11e3)===12.5e3 && K.sidStdBw(30e3)===30e3,'округление до стандартной ширины');
ok(K.sidNeedBw(10e3,{bw:25e3})===25e3 && K.sidNeedBw(10e3,null)===12.5e3,'нужная полоса: каталог, иначе измеренная + запас');

ok(K.sidDemodOf('NFM')==='NFM' && K.sidDemodOf('SSB')==='USB' && K.sidDemodOf('FSK')==='' && K.sidDemodOf('?')==='','вид сигнала → режим демодулятора');

// ---- учёт диапазона: sidRangeCtx ----
const m=rd('modules/sigid.js'), fn=m.match(/const SID_GENERIC=[\s\S]*?\n\}\n/);
ok(!!fn,'sidRangeCtx найден в sigid.js');
const ctx=vm.createContext({Math,Object,Array,Set,Number,String,JSON,IQK:{},fmtHz:(h)=>String(h)});
vm.runInContext(rd('modules/sigcat-kernels.js')+rd('modules/sigdb-kernels.js')+fn[0]+';globalThis.R=sidRangeCtx;',ctx);
const R=ctx.R;
let r=R({fc:161.975e6,obw:16e3},{t:'DIG',conf:.35,tag:'data'},'');
ok(/AIS/.test(r.c.tag) && r.cat && r.cat.decoder==='aisRx' && /aisRx/.test(r.hint),'161.975 МГц, 16 кГц → служба AIS/морская УКВ с aisRx: '+r.c.tag+' | '+r.hint);
r=R({fc:433.92e6,obw:60e3},{t:'FSK',conf:.3,tag:'FSK'},'');
ok(/ISM|PMR/.test(r.c.tag),'433.92 МГц → ISM/LPD: '+r.c.tag);
r=R({fc:7.1e6,obw:2.7e3},{t:'SSB',conf:.3,tag:'SSB'},'');
ok(r.c.t==='LSB','7.1 МГц, SSB → LSB по обычаю');
r=R({fc:14.2e6,obw:2.7e3},{t:'SSB',conf:.3,tag:'SSB'},'');
ok(r.c.t==='USB','14.2 МГц, SSB → USB по обычаю');
r=R({fc:300e6,obw:180e3},{t:'WFM',conf:.55,tag:'WFM',det:''},'');
ok(r.c.tag==='wide FM' && r.c.conf<=.35,'WFM вне 64–108 МГц понижается');
r=R({fc:98e6,obw:180e3},{t:'WFM',conf:.55,tag:'WFM',det:''},'');
ok(r.c.tag==='WFM' && r.c.conf===.55,'WFM в диапазоне вещания не трогаем');
r=R({fc:1.5e6,obw:9e3},{t:'AM',conf:.8,tag:'AM'},'AM broadcast');
ok(r.c.tag==='AM' && r.c.conf===.8,'уверенный вид остаётся');
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('sigid ok');
