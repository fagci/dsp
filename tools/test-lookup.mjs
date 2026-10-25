// Lookup: индексы eq / mac / prefix / contains / между, функции lookup() / between() в выражениях Table, разбор справочников (OUI, intercept).
// Проверка: node tools/test-lookup.mjs   (OUI из сети подгружается, если есть: NMAP_MAC=путь к nmap-mac-prefixes — взять оттуда)
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const rd=p=>fs.readFileSync(path.join(root,p),'utf8');
const ctx=vm.createContext({Math,Object,Array,Set,Map,Number,String,JSON,isFinite,Float64Array,Date,
  hostlistCoerce:v=>{ const s=String(v??'').trim(); return s!=='' && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; },
  parseHzCell:s=>{ const m=/^([\d.]+)\s*([kMG]?)(?:Hz)?$/i.exec(String(s).trim()); return m ? +m[1]*({'':1,k:1e3,m:1e6,g:1e9}[m[2].toLowerCase()]) : NaN; }});
vm.runInContext(rd('modules/lookup-kernels.js')+rd('modules/table-rules.js')+';globalThis.K={LU,luIndex,luLookup,luBetween,luParseNmapMac,luParseSignals,luParseWefax,luParseIds,luParseSpy,trCompile,luSame};',ctx);
const K=ctx.K;
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const eq=(a,b,m)=>ok(a===b,m+' (получено '+JSON.stringify(a)+', ждали '+JSON.stringify(b)+')');
const build=(list,mode,c1,c2,rows,cols)=>{
  const ix=K.luIndex(mode);
  for(const r of rows) mode==='range' ? ix.add(r[c1],r[c2],r) : ix.add(r[c1],r);
  ix.done(); K.LU.set(K.LU.key(list,mode,c1,c2),ix,list,new Set(cols));
};

// eq: без регистра, пробелы, первая запись при дубле
build('L','eq','k','',[{k:'Alpha',v:1},{k:' beta ',v:2},{k:'alpha',v:3}],['k','v']);
eq(K.luLookup('L','k','ALPHA','v'),1,'eq: регистр, первая запись');
eq(K.luLookup('L','k','beta','v'),2,'eq: пробелы по краям ключа');
eq(K.luLookup('L','k','gamma','v'),'','eq: нет совпадения → пусто');
eq(K.luLookup('L','k',5,'v'),'','eq: число без записи');

// mac: самый длинный ключ, разделители не важны
build('M','mac','p','',[{p:'00:1B:C5',v:'MA-L'},{p:'00:1B:C5:0A:B',v:'MA-S'},{p:'C4:E7',v:'Tile'}],['p','v']);
eq(K.luLookup('M','p','00-1b-c5-0a-b1-23','v','mac'),'MA-S','mac: 36 бит длиннее 24');
eq(K.luLookup('M','p','00:1B:C5:FF:00:00','v','mac'),'MA-L','mac: короткий ключ, если длинный не подошёл');
eq(K.luLookup('M','p','c4e7.1234.5678','v','mac'),'Tile','mac: 16 бит, точки');
eq(K.luLookup('M','p','00:1B','v','mac'),'','mac: короче любого ключа');
eq(K.luLookup('M','p','','v','mac'),'','mac: пустое значение');

// prefix / contains
build('P','prefix','k','',[{k:'DJI-',v:'dji'},{k:'DJI-MAV',v:'mavic'}],['k','v']);
eq(K.luLookup('P','k','dji-mavic3','v','prefix'),'mavic','prefix: длиннейший');
eq(K.luLookup('P','k','xDJI-1','v','prefix'),'','prefix: только с начала');
build('C','contains','k','',[{k:'cam',v:'camera'},{k:'ipcam',v:'ipcam'}],['k','v']);
eq(K.luLookup('C','k','HOME_IPCAM_5G','v','contains'),'ipcam','contains: длиннейший');
eq(K.luLookup('C','k','printer','v','contains'),'','contains: нет');

// between: узкий интервал, перекрытия, вне диапазона, частоты строкой
build('R','range','lo','hi',[{lo:0,hi:6e9,n:'всё'},{lo:87.5e6,hi:108e6,n:'FM'},{lo:100e6,hi:101e6,n:'узко'},{lo:'433.05M',hi:'434.79M',n:'ISM'},{lo:2e6,hi:'',n:'точка'}],['lo','hi','n']);
eq(K.luBetween('R','lo','hi',100.5e6,'n'),'узко','between: самый узкий из перекрытий');
eq(K.luBetween('R','lo','hi',90e6,'n'),'FM','between: FM внутри «всё»');
eq(K.luBetween('R','lo','hi','433.92M','n'),'ISM','between: значение строкой, границы строками');
eq(K.luBetween('R','lo','hi',2e6,'n'),'точка','between: нет верхней границы — точка');
eq(K.luBetween('R','lo','hi',7e9,'n'),'','between: вне всех');
eq(K.luBetween('R','lo','hi','abc','n'),'','between: не число');

// ошибки: нет списка / колонки
let msg=''; try{ K.luLookup('NOPE','k','x','v'); }catch(e){ msg=e.message; }
ok(/not loaded/.test(msg),'нет индекса → исключение: '+msg);
K.LU.fail(K.LU.key('X','eq','k',''),'list "X" not found'); msg=''; try{ K.luLookup('X','k','x','v'); }catch(e){ msg=e.message; }
eq(msg,'list "X" not found','текст ошибки загрузки доходит до ячейки');
msg=''; try{ K.luLookup('L','k','alpha','zzz'); }catch(e){ msg=e.message; }
ok(/no column "zzz"/.test(msg),'опечатка в колонке результата: '+msg);

// выражения: deps из литералов, вычисление, ошибки разбора
const f=K.trCompile("lookup('M','p',[mac],'v','mac')");
eq(JSON.stringify(f.deps),JSON.stringify([{list:'M',mode:'mac',c1:'p',c2:''}]),'deps lookup');
eq(f({mac:'C4:E7:00:11:22:33'}),'Tile','lookup в выражении');
eq(K.trCompile("lookup('L','k',[a],'v')").deps[0].mode,'eq','режим по умолчанию eq');
eq(JSON.stringify(K.trCompile("between('R','lo','hi',[f],'n')").deps),JSON.stringify([{list:'R',mode:'range',c1:'lo',c2:'hi'}]),'deps between');
eq(K.trCompile("if(lookup('L','k',[a],'v')==1,'yes','no')")({a:'alpha'}),'yes','lookup внутри if, число из списка');
const bads=["lookup([x],'k',[a],'v')","lookup('L','k',[a])","lookup('L','k',[a],'v','mac','x')","between('R','lo',[a],'n')","lookup('L',[c],[a],'v')"];
for(const b of bads){ let e=''; try{ K.trCompile(b); }catch(x){ e=x.message; } ok(e,'ошибка разбора: '+b); }
ok(K.luSame('MAC vendors (OUI)','Reference/mac vendors (oui)') && !K.luSame('vendors','Reference/MAC vendors (OUI)'),'luSame: звено пути целиком');

// скорость и разбор настоящих справочников
const nm=process.env.NMAP_MAC||'/home/user/nm.tmp';
if(fs.existsSync(nm)){
  const t=K.luParseNmapMac(fs.readFileSync(nm,'utf8'));
  ok(t.rows.length>40000,'OUI: строк '+t.rows.length);
  eq(t.rows[0].prefix,'00:00:00','OUI: показ префикса');
  ok(t.rows.some(r=>r.bits===36 && /^..:..:..:..:.$/.test(r.prefix)),'OUI: 36-битные записи');
  build('OUI','mac','prefix','',t.rows,t.cols);
  const t0=performance.now(); let hit=0; const N=200000;
  for(let i=0;i<N;i++) if(K.luLookup('OUI','prefix','F4:5C:89:'+(i&255).toString(16).padStart(2,'0')+':00:01','vendor','mac')) hit++;
  const dt=performance.now()-t0;
  console.log('OUI '+t.rows.length+' записей, '+N+' поисков: '+dt.toFixed(0)+' мс ('+(dt/N*1000).toFixed(2)+' мкс/поиск), найдено '+hit);
  ok(hit===N && dt<1500,'OUI: скорость');
  eq(K.luLookup('OUI','prefix','00:1B:C5:00:00:00','vendor','mac')!=='',true,'OUI: Converging Systems найден');
}
const sig=K.luParseSignals(fs.readFileSync(path.join(root,'data/intercept-signals.json'),'utf8'));
ok(sig.rows.length>900,'signals: строк '+sig.rows.length);
build('S','range','lo','hi',sig.rows,sig.cols);
eq(String(K.luBetween('S','lo','hi',98e6,'name')).length>0,true,'signals: 98 МГц опознан → '+K.luBetween('S','lo','hi',98e6,'name'));
const wf=K.luParseWefax(fs.readFileSync(path.join(root,'data/intercept-wefax.json'),'utf8'));
ok(wf.rows.length>80 && wf.rows[0].hz===2054000,'wefax: '+wf.rows.length+' частот, первая '+wf.rows[0].hz);
const ids=K.luParseIds(fs.readFileSync(path.join(root,'data/intercept-ids.json'),'utf8'));
ok(ids.tscm.rows.length>20 && ids.ssid.rows.length>40 && ids.mac.rows.length>20 && ids.ble.rows.length===5,'ids: размеры таблиц');
build('T','range','lo','hi',ids.tscm.rows,ids.tscm.cols);
eq(K.luBetween('T','lo','hi',433.92e6,'risk')!=='',true,'TSCM: 433.92 МГц есть');
build('SS','contains','pattern','',ids.ssid.rows,ids.ssid.cols);
eq(K.luLookup('SS','pattern','DJI-MAVIC3-AB12','kind','contains'),'drone','SSID: DJI → drone');
build('MM','mac','prefix','',ids.mac.rows,ids.mac.cols);
eq(K.luLookup('MM','prefix','48:1c:b9:11:22:33','vendor','mac'),'DJI','MAC дрона: DJI');
const spy=K.luParseSpy(fs.readFileSync(path.join(root,'data/intercept-spy.json'),'utf8'));
ok(spy.rows.length===135,'spy: 135 частот, получено '+spy.rows.length);
build('SP','eq','hz','',spy.rows,spy.cols);
eq(K.luLookup('SP','hz',4625000,'nickname'),'The Buzzer','spy: 4625 кГц → UVB-76');
let e=''; try{ K.luParseNmapMac('# only comments'); }catch(x){ e=x.message; } ok(e,'пустой OUI-файл → ошибка');
e=''; try{ K.luParseSignals('{}'); }catch(x){ e=x.message; } ok(e,'не тот JSON → ошибка');

if(bad){ console.error(bad+' failed'); process.exit(1); }
console.log('lookup: ok');
