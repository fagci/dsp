// Проверка modules/phoneact-kernels.js: команды приложения DSP по параметрам узла, адрес с ключом, ИК, разбор записей.
import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const ctx = vm.createContext({ URL, Set, Math, Number, String, Object, Array, JSON });
const load = f => vm.runInContext(fs.readFileSync(new URL('../modules/' + f, import.meta.url), 'utf8'), ctx);
load('ir-kernels.js'); load('phoneact-kernels.js');
vm.runInContext('this.K={phoneUrl,phoneSub,phoneButtons,phoneCmd,phoneIrCmd,phoneLine,irParse,irEncode}', ctx);
const K = ctx.K;

ok('url: the app key is added for this phone only', K.phoneUrl('ws://127.0.0.1:8765', 'KEY') === 'ws://127.0.0.1:8765/?k=KEY' && K.phoneUrl('ws://localhost:8765/', 'KEY').includes('k=KEY') &&
  !K.phoneUrl('ws://192.168.1.5:8765', 'KEY').includes('k=') && !K.phoneUrl('ws://127.0.0.1:8765', '').includes('k='));
ok('url: a key already in the address stays, bad schemes refused', K.phoneUrl('ws://127.0.0.1:8765/?k=mine', 'KEY').includes('k=mine') && K.phoneUrl('http://127.0.0.1', 'KEY') === '' && K.phoneUrl('nonsense', 'K') === '');
ok('subscriptions from the checkboxes', K.phoneSub({ smsIn: true, notifyEv: false, torchState: true }).join() === 'sms,torch' && K.phoneSub({}).length === 0);
const b = K.phoneButtons('Open, Snooze 5 min, , Open, Done, Extra');
ok('buttons: ids from labels, unique, at most three', b.length === 3 && b[0].id === 'open' && b[1].id === 'snooze_5_min' && b[2].id === 'open_' && b[2].label === 'Open', JSON.stringify(b));
ok('notify command', JSON.stringify(K.phoneCmd({ action: 'notify', title: 'T', body: 'hello', buttons: 'A', open: false })) === JSON.stringify({ cmd: 'notify', title: 'T', text: 'hello', actions: [{ id: 'a', label: 'A' }], open: false }));
ok('the text input overrides the field', K.phoneCmd({ action: 'sms.send', to: ' +79001234567 ', body: 'field' }, 'from wire').text === 'from wire' && K.phoneCmd({ action: 'sms.send', to: ' +79001234567 ', body: 'field' }, '').text === 'field' && K.phoneCmd({ action: 'sms.send', to: ' +79001234567 ' }, null).to === '+79001234567');
ok('alarm.set: radio, fallback, days',(c=>c.cmd==='alarm.set' && c.time==='6:45' && c.days==='weekdays' && c.url==='http://r.example/live' && c.sample==='beep' && c.loadSec===8 && c.vol===70 && !('name' in c))(K.phoneCmd({action:'alarm.set',alarmTime:' 6:45 ',alarmDays:'weekdays',alarmUrl:' http://r.example/live ',alarmSample:'beep',alarmLoad:8,alarmVol:70,alarmRamp:30})));
ok('alarm.remove / list / test',K.phoneCmd({action:'alarm.remove',alarmName:''}).all===true && K.phoneCmd({action:'alarm.remove',alarmName:'wake'}).name==='wake' && K.phoneCmd({action:'alarm.list'}).cmd==='alarm.list' && K.phoneCmd({action:'alarm.test',alarmName:'wake'}).name==='wake' && K.phoneCmd({action:'alarm.test',alarmUrl:'http://x',alarmSample:''}).sample==='default');
ok('alarm events subscribe to sys, lines read well',K.phoneSub({alarmEv:true}).join()==='sys' && K.phoneLine({src:'sys',ev:'alarm.fallback',id:'wake',why:'timeout',to:'ringtone'}).startsWith('alarm.fallback wake') && K.phoneLine({src:'alarm',name:'wake',time:'07:00',days:'weekdays',enabled:true,url:'http://x'}).includes('radio'));
ok('torch commands', K.phoneCmd({ action: 'torch on', level: 0 }).on === true && K.phoneCmd({ action: 'torch on', level: 3 }).level === 3 && K.phoneCmd({ action: 'torch off' }).on === false && !('level' in K.phoneCmd({ action: 'torch on', level: 0 })));
ok('vibrate: ms, amplitude only when set', K.phoneCmd({ action: 'vibrate', vibMs: 500 }).ms === 500 && !('amp' in K.phoneCmd({ action: 'vibrate', vibMs: 500, vibAmp: 0 })) && K.phoneCmd({ action: 'vibrate', vibAmp: 200 }).amp === 200 && K.phoneCmd({ action: 'vibrate stop' }).cmd === 'vibrate.stop');
ok('sms.data: hex cleaned, port', K.phoneCmd({ action: 'sms.data', to: '123', dataHex: 'de:ad BE-EF', dport: 9200 }).hex === 'deadbeef' && K.phoneCmd({ action: 'sms.data', to: '123', dport: 9200 }).port === 9200);
ok('sms.send_raw: PDU from the field or the text input, SMSC optional', K.phoneCmd({ action: 'sms.send_raw', rawPdu: 'DE:AD BE-EF' }).pdu === 'deadbeef' && K.phoneCmd({ action: 'sms.send_raw' }, 'C0FFEE').pdu === 'c0ffee' && K.phoneCmd({ action: 'sms.send_raw', rawPdu: 'AB', rawSmsc: '07 91 97' }).smsc === '079197');
ok('list commands', K.phoneCmd({ action: 'sms.list', box: 'inbox', q: 'bank', limit: 20 }).box === 'inbox' && K.phoneCmd({ action: 'contacts.find', q: 'Ann' }).limit === 50 && K.phoneCmd({ action: 'nope' }) === null);

// ИК: кадр кодека → команда излучателю
const e = K.irEncode('NEC', 4, 8, {});
const wire = 'F:' + e.freq + ' ' + e.dur.join(' ');
const c = K.phoneIrCmd(wire, K.irParse);
ok('IR: a NEC frame from the codec becomes ir.send', c && c.cmd === 'ir.send' && c.freq === 38000 && c.pattern.length === e.dur.length && c.pattern[0] === e.dur[0] && c.pattern.every(x => x >= 1), JSON.stringify(c).slice(0, 120));
ok('IR: foreign formats (Flipper, Tasmota) and garbage', K.phoneIrCmd('IRsend 36000,9000,4500,560,560', K.irParse).freq === 36000 && K.phoneIrCmd('hello', K.irParse) === null && K.phoneIrCmd('', K.irParse) === null);

ok('lines for readout', K.phoneLine({ src: 'cmd', cmd: 'torch', ok: true }) === 'torch ok' && K.phoneLine({ src: 'cmd', cmd: 'sms.send', ok: false, msg: 'bad number' }) === 'sms.send failed: bad number' &&
  K.phoneLine({ src: 'sms', dir: 'in', addr: '+7900', body: 'hi' }) === 'sms from +7900: hi' && K.phoneLine({ src: 'notify', nid: 5, action: 'open' }) === 'notification 5: open' && K.phoneLine({ src: 'torch', on: 1 }) === 'torch on' &&
  K.phoneLine({ src: 'contact', name: 'Ann', phones: ['1', '2'] }) === 'contact Ann 1, 2' && K.phoneLine({ src: 'cmd', cmd: 'sms.list', ok: true, n: 3 }) === 'sms.list ok · 3');
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
