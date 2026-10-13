// Ядро каталога SDR: node tools/test-sdrdir.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,isFinite,Set,parseFloat,Number,String,JSON,Array,Object});
vm.runInContext(fs.readFileSync(path.join(root,'modules/sdrdir-kernels.js'),'utf8')+';this.K={sdParse,sdFilter,sdGps,sdHostPort};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };

ok('gps string',JSON.stringify(K.sdGps('(55.9, 37.6)'))==='{"lat":55.9,"lon":37.6}');
ok('gps 0,0 rejected',K.sdGps('(0, 0)')===null);
ok('host:port from url',JSON.stringify(K.sdHostPort('http://a.b:8074/x'))==='{"host":"a.b","port":8074}');

const kiwi='var kiwisdr_com = [{"name":"Test Kiwi","sdr_hw":"KiwiSDR 2","gps":"(55.9, 37.6)","url":"http://k1.example:8073","users":4,"users_max":4,"loc":"Moscow"},'+
  '{"name":"No gps","url":"http://k2.example:8073"},{"name":"Dup","gps":"(1, 2)","url":"http://k1.example:8073"}];';
let l=K.sdParse(kiwi,'kiwisdr');
ok('kiwi json: skips no-gps and duplicates',l.length===1,JSON.stringify(l));
ok('kiwi fields',l[0].server==='k1.example:8073' && l[0].lat===55.9 && l[0].users===4 && l[0].usersMax===4 && l[0].kind==='kiwisdr');
ok('free filter drops full',K.sdFilter(l,{free:true}).length===0);
ok('text filter',K.sdFilter(l,{q:'moscow'}).length===1 && K.sdFilter(l,{q:'berlin'}).length===0);

const html='<div><!--\nname=Html Kiwi\ngps=(48.1, 11.5)\nusers=1\nusers_max=8\nhttp://k3.example:8074\n--></div>';
l=K.sdParse(html,'kiwisdr');
ok('kiwi html comment',l.length===1 && l[0].server==='k3.example:8074' && l[0].lon===11.5 && l[0].usersMax===8,JSON.stringify(l));

const spy='{"servers":[{"name":"Spy 1","streamingHost":"spy.example","port":5555,"latitude":52.5,"longitude":13.4}]}';
l=K.sdParse(spy,'spyserver');
ok('spyserver nested array',l.length===1 && l[0].server==='spy.example:5555' && l[0].kind==='spyserver',JSON.stringify(l));
ok('default port',K.sdParse('[{"name":"x","host":"h.example","lat":1,"lon":2}]','spyserver')[0].port===5555);
ok('garbage → empty',K.sdParse('not a list','kiwisdr').length===0);
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
