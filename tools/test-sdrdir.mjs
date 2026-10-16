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
const real='// KiwiSDR.com receiver list\n// Automatically generated from http://kiwisdr.com/public/\n\nvar kiwisdr_com =\n[\n\t{"id":"1","status":"active","offline":"no","name":"Antenna | Montmorillon 86500 FRANCE","sdr_hw":"KiwiSDR 1 v1.902","bands":"10000-32000000","users":"1","users_max":"4","gps":"(46.427049, 0.888543)","loc":"Montmorillon","snr":"41,38","url":"http://109.220.96.34:8073"},\n\t{"id":"2","status":"offline","offline":"yes","name":"Down","gps":"(10, 10)","url":"http://1.2.3.4:8073"}\n];\n';
l=K.sdParse(real,'kiwisdr');
ok('real kiwisdr_com.js: one online receiver',l.length===1 && l[0].server==='109.220.96.34:8073' && l[0].users===1 && l[0].usersMax===4 && l[0].snr===41 && Math.abs(l[0].lat-46.427049)<1e-9,JSON.stringify(l));
const trail=real.replace('}\n];','},\n]\n;');
ok('trailing comma before ]',K.sdParse(trail,'kiwisdr').length===1);
const ctl=real.replace('Montmorillon','Mont\tmorillon');
ok('raw control char in string: per-object fallback',K.sdParse(ctl,'kiwisdr').length===1);
const rx='<div class="views-row"><div class="geolocation-location js-hide" id="a1" data-lat="44.79" data-lng="-85.96" typeof="Place"><span property="geo"><meta property="latitude" content="44.79" /></span>'+
  '<div class="location-content"><div class="views-field views-field-nothing"><h3>0-30 MHz SDR KF8KK-1 (of 2) | Empire, Michigan, MI USA</h3>\n<a href="http://21662.proxy.kiwisdr.com:8073/" rel="nofollow" target="_blank">http://21662.proxy.kiwisdr.com:8073/</a><br />\nEN74as: (44.79, -85.96)<br />\n<b>US</b>: Beulah<br />\nKiwiSDR</div></div></div>'+
  '<div class="geolocation-location js-hide" id="a2" data-lat="47.85" data-lng="-122.31"><div class="location-content"><div class="views-field"><h3>Web SDR</h3><a href="https://sdr.example/ws">x</a><br />CN87: (47.85, -122.31)<br /><b>US</b>: Seattle<br />WebSDR</div></div></div>'+
  '<div class="geolocation-location" data-lat="1" data-lng="2"><h3>no link</h3></div></div>';
l=K.sdParse(rx,'rxtx');
ok('rxtx: two points, no-link skipped',l.length===2,JSON.stringify(l));
ok('rxtx fields',l[0].server==='21662.proxy.kiwisdr.com:8073' && l[0].lat===44.79 && l[0].lon===-85.96 && l[0].name==='0-30 MHz SDR KF8KK-1 (of 2)' && l[0].loc==='Empire, Michigan, MI USA' && l[0].hw==='KiwiSDR' && l[0].kind==='rxtx',JSON.stringify(l[0]));
ok('rxtx https default port',l[1].server==='sdr.example:443' && l[1].hw==='WebSDR',JSON.stringify(l[1]));
console.log(bad?'FAILED':'all ok'); process.exit(bad?1:0);
