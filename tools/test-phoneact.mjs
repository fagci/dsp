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
ok('torch commands', K.phoneCmd({ action: 'torch on', level: 0 }).on === true && K.phoneCmd({ action: 'torch on', level: 3 }).level === 3 && K.phoneCmd({ action: 'torch off' }).on === false && !('level' in K.phoneCmd({ action: 'torch on', level: 0 })));
ok('root camera commands go as they are, the readout shows the camera count change', ['cam.probe','cam.root.info','cam.root.sysuid','cam.root.unhide','cam.root.restore'].every(a => K.phoneCmd({ action: a }).cmd === a) && K.phoneLine({ src: 'cmd', cmd: 'cam.root.unhide', ok: true, before: 3, after: 5 }) === 'cam.root.unhide ok · cameras 3 → 5');
ok('list commands', K.phoneCmd({ action: 'sms.list', box: 'inbox', q: 'bank', limit: 20 }).box === 'inbox' && K.phoneCmd({ action: 'contacts.find', q: 'Ann' }).limit === 50 && K.phoneCmd({ action: 'cam.list' }).cmd === 'cam.list' && K.phoneCmd({ action: 'nope' }) === null);

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
