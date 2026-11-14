// Частоты дискретизации USB-приёмников: список по донглу и ближайшая допустимая (modules/sdrrates-kernels.js)
// Проверка: node tools/test-sdrrates.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Object,Array,Set,Number});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sdrrates-kernels.js'),'utf8')+';globalThis.K={sdrRateOpts,sdrRateSnap};',ctx);
const K=ctx.K, J=x=>JSON.stringify([...x]);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const G=[960000,1024000,1920000,2048000,2400000,2500000,3000000,3200000,6000000,8000000,10000000,12000000,16000000,20000000];
ok(J(K.sdrRateOpts(null,G))===J(G),'без донгла — вся сетка');
ok(J(K.sdrRateOpts({kind:'file'},G))===J(G),'файл без списка — вся сетка');
ok(J(K.sdrRateOpts({rateRange:[900001,3200000]},G))===J(G.slice(0,8)),'RTL-SDR: до 3.2 МС/с');
ok(J(K.sdrRateOpts({rateRange:[2e6,20e6]},G))===J(G.slice(3)),'HackRF: от 2 МС/с');
ok(J(K.sdrRateOpts({rates:[10000000,2500000]},G))===J([2500000,10000000]),'Airspy: точный список по возрастанию');
ok(J(K.sdrRateOpts({rates:[6e6,3e6,6e6]},G))===J([3e6,6e6]),'дубли убираются');
ok(J(K.sdrRateOpts({rateRange:[30e6,40e6]},G))===J(G),'диапазон без совпадений — вся сетка, а не пустой список');
ok(K.sdrRateSnap([2500000,10000000],3200000)===2500000 && K.sdrRateSnap([2500000,10000000],8e6)===10000000,'ближайшая по отношению частот');
ok(K.sdrRateSnap(G.slice(0,8),20e6)===3200000,'RTL: 20 МС/с от другого донгла → 3.2');
if(bad){ console.error(bad+' failed'); process.exit(1); } console.log('sdrrates: ok');
