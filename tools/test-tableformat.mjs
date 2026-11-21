// Форматы полей Table (datetime, money, rating, url): node tools/test-tableformat.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({console});
vm.runInContext(fs.readFileSync(path.join(root,'modules/table-cards.js'),'utf8')+';this.K={tcFmtDate,tcFmtMoney,tcMoneyNum,tcRating,tcUrlHref};',ctx);
const K=ctx.K;
let bad=0; const ok=(n,c,info='')=>{ if(!c){ bad++; console.log('FAIL',n,info); } else console.log('ok  ',n); };
const num=(v,dec,grp=true)=>new Intl.NumberFormat(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec,useGrouping:grp}).format(v);

ok('datetime: a local string is shown as written',K.tcFmtDate('2026-11-21T17:42','YYYY-MM-DD HH:mm',false)==='2026-11-21 17:42');
ok('datetime: custom tokens and seconds',K.tcFmtDate('2026-01-02 03:04:05','DD.MM.YYYY H:mm:ss',false)==='02.01.2026 3:04:05');
ok('datetime: milliseconds',K.tcFmtDate('2026-01-02T03:04:05.123Z','YYYY-MM-DD HH:mm:ss.SSS',false)==='2026-01-02 03:04:05.123');
ok('datetime: epoch milliseconds in UTC',K.tcFmtDate(Date.UTC(2026,10,21,17,42),'YYYY-MM-DD HH:mm',false)==='2026-11-21 17:42');
ok('datetime: empty and bad values stay as they are',K.tcFmtDate('','YYYY',false)==='' && K.tcFmtDate('nonsense','YYYY',false)==='nonsense');

ok('money: default pattern, two decimals',K.tcFmtMoney(1234.5,{})===num(1234.5,2));
ok('money: no grouping and no decimals',K.tcFmtMoney(1234.5,{fmt:'0'})===num(1234.5,0,false));
ok('money: symbols and grouping from the pattern',K.tcFmtMoney(1234.5,{fmt:'#,##0.00'})===num(1234.5,2));
ok('money: currency symbol at the front',K.tcFmtMoney(1234.5,{cur:'USD',fmt:'¤#,##0.00'}).endsWith(num(1234.5,2)) && K.tcFmtMoney(1234.5,{cur:'USD',fmt:'¤#,##0.00'}).length>num(1234.5,2).length);
ok('money: currency at the end',K.tcFmtMoney(1234.5,{cur:'EUR',fmt:'#,##0.00 ¤'}).startsWith(num(1234.5,2)));
ok('money: a formatted string is parsed',K.tcMoneyNum('1 234,50')===1234.5 && K.tcMoneyNum('$1,234.50')===1234.5);
ok('money: empty and bad values stay as they are',K.tcFmtMoney('',{})==='' && K.tcFmtMoney('n/a',{})==='n/a');

ok('rating: stars up to the scale',K.tcRating(3,{max:5})==='★★★☆☆' && K.tcRating(9,{max:5})==='★★★★★');
ok('rating: a non-number is not swallowed',K.tcRating('x',{max:5})==='x');

ok('url: bare hosts get https, unsafe schemes do not',K.tcUrlHref('example.com')==='https://example.com' && K.tcUrlHref('javascript:alert(1)')==='' && K.tcUrlHref('mailto:a@b.c')==='mailto:a@b.c');
console.log(bad ? bad+' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
