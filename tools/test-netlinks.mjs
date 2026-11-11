// Network Links: скорости, привязка сокетов к сетям, строки для Graph, текст и разница сетей (modules/netlinks-kernels.js).
// Проверка: node tools/test-netlinks.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Object,Array,Set,Map,Number,String,JSON,RegExp,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/netlinks-kernels.js'),'utf8')+';globalThis.K={nlkNetId,nlkRates,nlkNew,nlkSpeed,nlkBytes,nlkNetOf,nlkText,nlkRows,nlkDiff,nlkGraph};',ctx);
const K=ctx.K, J=x=>JSON.stringify(x);
let bad=0; const ok=(c,m)=>{ if(!c){ bad++; console.error('FAIL: '+m); } };
const eq=(a,b,m)=>ok(J(a)===J(b),m+' (получено '+J(a)+', ждали '+J(b)+')');

const net=(id,kind,o={})=>({id,kind,iface:'if'+id,ips:['10.0.0.'+id],dns:['1.1.1.1'],gateway:'10.0.0.1',validated:true,metered:false,default:false,down:0,up:0,...o});
const nets=[net(100,'wifi',{default:true,down:866000}),net(101,'cell',{metered:true,down:50000})];
const sk=(id,kind,addr,netl,o={})=>({id,kind,addr,net:netl,server:null,age:1000,rx:0,tx:0,...o});

eq([K.nlkNetId('wifi#101'),K.nlkNetId('default'),K.nlkNetId(null)],[101,null,null],'номер сети из метки');
eq([K.nlkSpeed(10),K.nlkSpeed(2500),K.nlkSpeed(3e6)],['10 B/s','2.5 kB/s','3.00 MB/s'],'скорость');
eq(K.nlkBytes(2048),'2.0 kB','байты');

// скорости: первый снимок — нули, второй — приращение за секунду; закрытый сокет забывается
const st=K.nlkNew();
let r=K.nlkRates(st,[sk(1,'tcp','a:1','wifi#100',{rx:100,tx:0})],1000);
eq(r.get(1),{rx:0,tx:0},'первый снимок без скорости');
r=K.nlkRates(st,[sk(1,'tcp','a:1','wifi#100',{rx:1100,tx:500})],2000);
eq(r.get(1),{rx:1000,tx:500},'скорость по приращению');
r=K.nlkRates(st,[sk(1,'tcp','a:1','wifi#100',{rx:900,tx:500})],3000);
eq(r.get(1).rx,0,'счётчик не идёт назад');
K.nlkRates(st,[],4000); ok(!st.hist.has(1) && !st.last.has(1),'закрытый сокет забыт');

// привязка
const a=sk(1,'tcp','h:80','cell#101'), b=sk(2,'udp','*:5000','default'), c=sk(3,'tcp','h:81','wifi#999');
eq(K.nlkNetOf(nets,a).id,101,'по метке');
eq(K.nlkNetOf(nets,b).id,100,'default — сеть системы');
eq(K.nlkNetOf(nets,c),null,'сети уже нет');

// строки для Graph
const srv=sk(10,'tcp-server','0.0.0.0:8080','wifi#100'), conn=sk(11,'tcp','1.2.3.4:5555','wifi#100',{server:10,rx:5000});
const rates=new Map([[10,{rx:0,tx:0}],[11,{rx:2000,tx:0}],[1,{rx:0,tx:0}]]);
const cache=new Map();
const rows=K.nlkGraph(nets,[srv,conn,a],rates,cache);
const ids=rows.filter(x=>x.id).map(x=>x.id), edges=rows.filter(x=>x.from);
eq(ids,['phone','net:100','net:101','sock:10','sock:11','sock:1'],'узлы');
const E=(f,t)=>edges.find(e=>e.from===f && e.to===t);
ok(E('phone','net:100') && E('phone','net:101'),'телефон → сети');
ok(E('net:100','sock:10'),'сервер под сетью');
ok(E('sock:10','sock:11') && !E('net:100','sock:11'),'принятое соединение под своим сервером');
ok(E('net:101','sock:1'),'сокет сотовой под сотовой');
eq(E('sock:10','sock:11').label,'2.0 kB/s','подпись связи — скорость');
eq(E('net:100','sock:10').dashes,'dash','без трафика — пунктир');
ok(rows.find(x=>x.id==='net:100').label.startsWith('★'),'сеть по умолчанию отмечена');
// неизменившиеся строки — те же объекты (Graph не разбирает их заново)
const rows2=K.nlkGraph(nets,[srv,conn,a],rates,cache);
ok(rows2.every((x,i)=>x===rows[i]),'кэш строк');
const rows3=K.nlkGraph(nets,[srv,a],rates,cache);
ok(!rows3.some(x=>x.id==='sock:11') && cache.size===rows3.length,'пропавший сокет убран из кэша');
// сокет без сети привязывается к телефону
const rows4=K.nlkGraph(nets,[c],new Map(),new Map());
ok(rows4.some(x=>x.from==='phone' && x.to==='sock:3'),'сокет без сети — к телефону');

// разница
const nets2=[net(100,'wifi',{validated:false,default:false}),net(102,'eth',{default:true})];
const d=K.nlkDiff(nets,nets2).map(x=>x.what+':'+x.id).sort();
eq(d,['down:101','offline:100','up:102'],'изменения сетей');
eq(K.nlkDiff(nets,nets),[],'без изменений');

// записи и текст
const rec=K.nlkRows(nets,[a],new Map([[1,{rx:10.4,tx:0}]]));
eq(rec.map(x=>x.ev),['net','net','sock'],'записи');
eq(rec[2].rx_bps,10,'скорость в записи');
ok(K.nlkText(nets,[a],new Map()).includes('★ wifi#100'),'текст: сеть по умолчанию');

if(bad){ console.error(bad+' failed'); process.exit(1); }
console.log('netlinks: all ok');
