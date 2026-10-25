// Band plan: вид модуляции / полоса по правилам (bpModeOf), разбор значений (bpHz), выбор самой специфичной строки по признакам (bpPick).
// Проверка: node tools/test-bandmode.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Object,Array,Set,Number,String,JSON,isFinite,parseFloat});
vm.runInContext(fs.readFileSync(path.join(root,'modules/bandmode-kernels.js'),'utf8')+';globalThis.K={bpModeOf,bpHz,bpNorm,bpPick,bpPickAttr};',ctx);
const K=ctx.K;
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const M=(label,lo,hi,step=0,note='',kind='',plan='')=>K.bpModeOf(label,note,kind,lo,hi,plan,step);
const is=(r,d,b)=>r && r.demod===d && r.bw===b;
ok(is(M('FM broadcast',87.5e6,108e6,100e3,'','','Broadcast/FM'),'WFM',180000),'FM broadcast → WFM 180 кГц');
ok(is(M('Airband (AM voice)',118e6,137e6,25e3),'AM',10000),'Airband → AM 10 кГц');
ok(is(M('Marine VHF',156e6,162.025e6,25e3),'NFM',16000),'Marine VHF → NFM');
ok(is(M('AIS 1',161.975e6,161.975e6,25e3),'IQ',25000),'AIS → IQ 25 кГц');
ok(is(M('PMR446 ch9 446.1063',446.10625e6,446.10625e6,12500,'12.5 kHz (EU 2018+) / dPMR/DMR Tier I 6.25 kHz'),'NFM',12500),'PMR446 с dPMR/DMR в заметке — всё равно NFM');
ok(is(M('TETRA civil / PMR',410e6,430e6,0,'','','Cellular/GSM-R, TETRA, P25, trunking'),'IQ',25000),'TETRA в названии — IQ, а не PMR');
ok(is(M('Railway VHF (RU)',151.725e6,156e6,0,'','','Cellular/GSM-R, TETRA, P25, trunking'),'NFM',16000)||M('Railway VHF (RU)',151.725e6,156e6,25e3)!==null,'название плана («trunking») не делает строку цифровой');
ok(is(M('40m SSB',7.053e6,7.2e6,100,'','','Amateur/By mode'),'LSB',2800) && is(M('20m SSB',14.101e6,14.35e6,100),'USB',2800),'SSB: LSB ниже 10 МГц, USB выше');
ok(is(M('2m SSB',144.15e6,144.4e6,0,'','','Amateur/By mode'),'USB',2800) && is(M('6m CW/BCN',50e6,50.1e6),'USB',500),'SSB и CW выше 30 МГц в любительских планах');
ok(is(M('80m DIGI',3.57e6,3.6e6),'USB',3000),'цифровые виды КВ → USB 3 кГц');
ok(is(M('2m FM simplex',145.194e6,145.594e6,12500,'','','Amateur/By mode'),'NFM',12500),'2m FM → NFM 12.5 кГц');
ok(is(M('MW broadcast',0.526e6,1.607e6,9000),'AM',9000) && is(M('49m BC',5.9e6,6.2e6,5000,'','','Broadcast/HF 5 kHz channels'),'AM',6000),'вещание: MW 9 кГц, КВ с шагом 5 кГц — 6 кГц');
ok(is(M('CB ch9 27.065',27.065e6,27.065e6,0),'AM',10000),'CB → AM');
ok(is(M('ADS-B 1090',1089e6,1091e6),'IQ',2000000) && is(M('ACARS 131.550',131.55e6,131.55e6),'IQ',25000),'ADS-B и ACARS → IQ');
ok(is(M('NOAA 19 APT 137.1',137.1e6,137.1e6),'NFM',40000) && is(M('Meteor-M LRPT 137.9',137.9e6,137.9e6,0,'QPSK 72 kBd'),'IQ',150000),'APT → NFM 40 кГц, LRPT → IQ');
ok(M('Marker beacon 75',75e6,75e6)===null,'маркерный маяк 75 МГц не CW');
ok(is(M('COSPAS-SARSAT',406e6,406.1e6),'IQ',25000),'COSPAS-SARSAT → IQ');
ok(M('LTE band 3 DL',1805e6,1880e6)===null && M('Wi-Fi ch1',2412e6,2412e6)===null && M('GPS L1',1575.42e6,1575.42e6)===null,'сотовая, Wi-Fi, GNSS — без вида модуляции');
ok(is(M('Railway',151e6,152e6,25000),'NFM',16000) && M('something',300e6,301e6,0)===null,'по частоте — только каналы с шагом; прочее — null');
// bpHz
ok(K.bpHz('12.5k')===12500 && K.bpHz('180 kHz')===180000 && K.bpHz('2M')===2e6 && K.bpHz(5000)===5000 && K.bpHz('1,5k')===1500 && isNaN(K.bpHz('abc')),'bpHz: k / M / запятая / число / мусор');
// bpNorm / bpPick: самая узкая строка для каждого признака отдельно
const plan=K.bpNorm([
  {lo:0,hi:6e9,label:'default',gain:30},
  {lo:87.5e6,hi:108e6,label:'FM broadcast',demod:'WFM',bw:'180k',gain:20},
  {lo:118e6,hi:137e6,label:'Airband',demod:'am',bw:10000},
  {lo:121.5e6,hi:121.5e6,label:'Guard',demod:'AM',bw:'12.5k',step:25000},
  {lo:118e6,hi:137e6,label:'Airband gain',gain:36},
  {lo:144e6,hi:146e6,label:'2m',gain:'38'},
  {lo:1,hi:2,label:'пустая'},{lo:'x',label:'мусор',demod:'AM'},{lo:100e6,hi:101e6,demod:'ZZZ',label:'неверный режим'},{sig:true,lo:1e6,hi:2e6,demod:'AM'}]);
ok(plan.length===6,'bpNorm отбрасывает строки без признаков, с мусором и метки sigid ('+plan.length+')');
let r=K.bpPick(plan,100e6); ok(r.demod?.label==='FM broadcast' && r.bw?.label==='FM broadcast' && r.gain?.label==='FM broadcast','100 МГц → строка FM broadcast по всем признакам');
r=K.bpPick(plan,125e6); ok(r.demod?.label==='Airband' && r.gain?.label==='Airband gain','125 МГц: режим из Airband, усиление из «Airband gain» (разные строки)');
r=K.bpPick(plan,121.5e6); ok(r.demod?.label==='Guard' && r.bw?.bw===12500 && r.gain?.label==='Airband gain','121.5 МГц: точечная строка Guard уже диапазона Airband');
r=K.bpPick(plan,121.51e6); ok(r.demod?.label==='Guard','точечная строка берёт допуск в пол-шага (12.5 кГц)');
r=K.bpPick(plan,121.6e6); ok(r.demod?.label==='Airband','вне допуска — снова диапазон');
r=K.bpPick(plan,145e6); ok(r.demod===null && r.bw===null && r.gain?.label==='2m' && r.gain.gain===38,'145 МГц: режима нет, усиление из «2m» (и строка-строкой «38» разобрана)');
r=K.bpPick(plan,500e6); ok(r.gain?.label==='default' && r.demod===null,'вне специфичных — общее усиление');
r=K.bpPick(K.bpNorm([]),100e6); ok(!r.demod && !r.bw && !r.gain,'пустой план — ничего');
if(bad){ console.error(bad+' ошибок'); process.exit(1); }
console.log('bandmode ok');
