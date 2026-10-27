// SMS PDU: node tools/test-smspdu.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad=0; const ok=(n,c,x='')=>{ if(!c){ bad++; console.log('FAIL',n,x); } else console.log('ok  ',n); };
const ctx=vm.createContext({Math,Number,String,Object,Array,JSON,Date,Map,Uint8Array,TextEncoder,isFinite});
vm.runInContext(fs.readFileSync(new URL('../modules/smspdu-kernels.js',import.meta.url),'utf8')+';this.K={smsBuild,smsParse,smsRec,smsJoin,smsGsm7Encode,smsGsm7Decode,smsPack7,smsUnpack7,smsAddrEncode,smsVpEncode,smsVpDecode,SMS_GSM7};',ctx);
const K=ctx.K;
ok('GSM 7-bit alphabet has 128 entries',K.SMS_GSM7.length===128,K.SMS_GSM7.length);
ok('pack "hellohello" = E8329BFD4697D9EC37',K.smsPack7(K.smsGsm7Encode('hellohello')).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase()==='E8329BFD4697D9EC37');
ok('unpack back',K.smsGsm7Decode(K.smsUnpack7([0xE8,0x32,0x9B,0xFD,0x46,0x97,0xD9,0xEC,0x37],10))==='hellohello');
ok('extension table: € { } [ ] ~ ^ \\ |',K.smsGsm7Decode(K.smsGsm7Encode('€{}[]~^\\|'))==='€{}[]~^\\|' && K.smsGsm7Encode('€').length===2);
ok('cyrillic is not GSM 7-bit',K.smsGsm7Encode('привет')===null);
const a=K.smsAddrEncode('+79001234567'); ok('address: international, swapped nibbles, F filler',a.len===11 && a.toa===0x91 && a.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('')==='970021436 5F7'.replace(' ',''),JSON.stringify(a));
ok('address: national / alphanumeric',K.smsAddrEncode('0123').toa===0x81 && K.smsAddrEncode('DSP').toa===0xD0 && K.smsAddrEncode('DSP').len===6);

// сборка SUBMIT и разбор обратно
const b=K.smsBuild({type:'submit',smsc:'+79168999100',to:'+79001234567',text:'hellohello',mr:0});
ok('submit: one part, GSM 7-bit',b.count===1 && b.enc==='gsm7');
ok('submit: exact bytes',b.parts[0].hex==='07919761989901F001000B919700214365F700000AE8329BFD4697D9EC37',b.parts[0].hex);
const p=K.smsParse(b.parts[0].hex);
ok('parse back: smsc, number, text, kind',p.smsc==='+79168999100' && p.to==='+79001234567' && p.text==='hellohello' && p.mti==='submit' && p.enc==='gsm7',JSON.stringify(p));
ok('parse the TPDU alone (no SMSC)',K.smsParse(b.parts[0].tpdu,false).text==='hellohello' && K.smsParse(b.parts[0].tpdu).text==='hellohello');

// UCS-2 и авто-выбор
const u=K.smsBuild({type:'submit',to:'+79001234567',text:'Привет, мир'});
ok('cyrillic → UCS-2',u.enc==='ucs2' && K.smsParse(u.parts[0].hex).text==='Привет, мир');
// длинное: GSM 7 — 153 символа на часть, UCS-2 — 67
const long=K.smsBuild({type:'submit',to:'+1555',text:'a'.repeat(400),ref:7});
ok('long GSM 7-bit: 153 + 153 + 94',long.count===3 && long.parts.map(x=>K.smsParse(x.hex).text.length).join()==='153,153,94');
const pj=long.parts.map(x=>K.smsParse(x.hex));
ok('concat header: ref, total, sequence',pj.every((r,i)=>r.concat.ref===7 && r.concat.total===3 && r.concat.seq===i+1 && r.udhi));
const st=new Map(); let j; for(const r of pj.reverse()) j=K.smsJoin(st,r);
ok('join in any order',j.done && j.text==='a'.repeat(400) && j.parts===3,JSON.stringify(j).slice(0,80));
const lu=K.smsBuild({type:'submit',to:'+1555',text:'я'.repeat(150),ref:1});
ok('long UCS-2: 67 per part',lu.count===3 && lu.parts.map(x=>K.smsParse(x.hex).text.length).join()==='67,67,16');
ok('escape pair is never split across parts',(()=>{ const t='a'.repeat(152)+'€'+'b'.repeat(10); const r=K.smsBuild({type:'submit',to:'1',text:t,ref:1}); return r.count===2 && r.parts.map(x=>K.smsParse(x.hex).text).join('')===t; })());

// data-SMS: порты, 8 бит
const d=K.smsBuild({type:'submit',to:'+1555',enc:'8bit',data:'DEADBEEF',ports:{dst:9200,src:9200}});
const dp=K.smsParse(d.parts[0].hex);
ok('data SMS: ports in UDH, 8-bit data',dp.enc==='8bit' && dp.ports.dst===9200 && dp.data==='DEADBEEF' && dp.udhi,JSON.stringify(dp));
ok('data SMS: small ports use the 8-bit IE',K.smsParse(K.smsBuild({type:'submit',to:'1',enc:'8bit',data:'01',ports:{dst:80,src:81}}).parts[0].hex).ports.src===81);
// flash, срок жизни, запрос отчёта
const f=K.smsBuild({type:'submit',to:'1234',text:'hi',flash:true,vp:60,srr:true,rd:true});
const fp=K.smsParse(f.parts[0].hex);
ok('flash SMS (class 0), validity 60 min, report request',fp.flash && fp.vpMin===60 && fp.srr && fp.rd && fp.cls===0,JSON.stringify(fp));
ok('validity encode / decode',[5,60,720,1440,10080].every(m=>K.smsVpDecode(K.smsVpEncode(m))>=m && K.smsVpDecode(K.smsVpEncode(m))<=m*1.1+30));

// DELIVER: отправитель-имя, отметка времени, пояс
const dl=K.smsBuild({type:'deliver',smsc:'+79168999100',from:'MegaFon',text:'Код: 1234',date:new Date(Date.UTC(2026,9,27,12,30,45)),tzMin:180});
const dr=K.smsParse(dl.parts[0].hex);
ok('deliver: alphanumeric sender, cyrillic text',dr.mti==='deliver' && dr.from==='MegaFon' && dr.fromAlpha && dr.text==='Код: 1234',JSON.stringify(dr));
ok('deliver: SCTS local time and zone',dr.scts.local==='2026-10-27T15:30:45' && dr.scts.tz==='+03:00' && dr.scts.ts===Date.UTC(2026,9,27,12,30,45),JSON.stringify(dr.scts));
const dn=K.smsBuild({type:'deliver',from:'+79001234567',text:'Hello world',date:new Date(Date.UTC(2026,0,2,3,4,5)),tzMin:-90});
ok('deliver: negative zone',K.smsParse(dn.parts[0].hex).scts.tz==='-01:30',JSON.stringify(K.smsParse(dn.parts[0].hex).scts));

// отчёт о доставке (SMSC 00 — пусто), разбор вручную собранного TPDU
const sr=K.smsParse('00'+'06'+'2A'+'0B91'+'9700214365F7'+'62015030140480'.slice(0,14)+'62015030841480'+'00');
ok('status report decode',sr.mti==='status-report' && sr.status===0 && sr.statusText==='delivered' && sr.to==='+79001234567' && sr.mr===42,JSON.stringify(sr));
ok('garbage and bad input',K.smsParse('zz').error && K.smsParse('0791').error && K.smsParse('').error);
ok('plain GSM text with the unsupported char is refused in gsm7 mode',K.smsBuild({type:'submit',to:'1',text:'я',enc:'gsm7'}).error);
const rec=K.smsRec(dr); ok('rec: flat fields',rec.kind==='deliver' && rec.from==='MegaFon' && rec.text==='Код: 1234' && rec.sent==='2026-10-27T15:30:45+03:00',JSON.stringify(rec));
console.log(bad?bad+' FAILED':'all ok'); process.exit(bad?1:0);
