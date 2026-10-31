// Проверка modules/phoneact-kernels.js: команды приложения DSP по параметрам узла, адрес с ключом, ИК, разбор записей.
import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const ctx = vm.createContext({ URL, Set, Math, Number, String, Object, Array, JSON, Date, RegExp });
const load = f => vm.runInContext(fs.readFileSync(new URL('../modules/' + f, import.meta.url), 'utf8'), ctx);
load('ir-kernels.js'); load('phoneact-kernels.js');
vm.runInContext('this.K={phoneWhen,phoneUrl,phoneSub,phoneButtons,phoneCmd,phoneIrCmd,phoneLine,irParse,irEncode}', ctx);
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
ok('boot.set / run / stop / list',
  K.phoneCmd({ action: 'boot.set', bootPatches: ' A; B ' }).patches === 'A; B' &&
  K.phoneCmd({ action: 'boot.run', bootPatches: '' }).name === undefined && K.phoneCmd({ action: 'boot.run', bootPatches: 'A' }).name === 'A' &&
  K.phoneCmd({ action: 'boot.stop', bootPatches: '' }).cmd === 'boot.stop' && K.phoneCmd({ action: 'boot.list' }).cmd === 'boot.list');
ok('boot lines read well', K.phoneLine({ src: 'boot', name: 'A', boot: true, running: true }) === 'patch A · on boot · running' &&
  K.phoneLine({ src: 'sys', ev: 'boot.started', name: 'A' }) === 'boot.started A');
const base = new Date(2026, 9, 31, 10, 0, 0).getTime();      // 31 октября 2026, 10:00 по часам машины
ok('when: date and time', K.phoneWhen('2026-11-02 09:30') === new Date(2026, 10, 2, 9, 30).getTime() && K.phoneWhen('2026-11-02') === new Date(2026, 10, 2).getTime());
ok('when: today, tomorrow, relative', K.phoneWhen('9:30', base) === new Date(2026, 9, 31, 9, 30).getTime() && K.phoneWhen('tomorrow 9:00', base) === new Date(2026, 10, 1, 9, 0).getTime() &&
  K.phoneWhen('+90m', base) === base + 90 * 60000 && K.phoneWhen('+2h', base) === base + 2 * 3600000 && K.phoneWhen('+1d', base) === base + 86400000 && K.phoneWhen('now', base) === base);
ok('when: ms and garbage', K.phoneWhen('1793431994293') === 1793431994293 && K.phoneWhen('') === null && K.phoneWhen('25:00', base) === null && K.phoneWhen('2026-02-30') === null && K.phoneWhen('soon') === null);
ok('cal.add: start, end from the start, reminders', (c => c.cmd === 'cal.add' && c.title === 'Dentist' && c.start === new Date(2026, 10, 2, 9, 30).getTime() && c.end === c.start + 3600000 && c.remind === '10, 60' && !c.allDay)(
  K.phoneCmd({ action: 'cal.add', calTitle: ' Dentist ', calStart: '2026-11-02 09:30', calEnd: '+1h', calRemind: '10, 60' })));
ok('cal.add: no start — left out (the app answers)', !('start' in K.phoneCmd({ action: 'cal.add', calTitle: 'x', calStart: 'soon' })));
ok('cal.list / remove / calendars', (c => c.cmd === 'cal.list' && c.to - c.from === 3 * 86400000 && c.q === 'tea' && c.calendar === 2)(K.phoneCmd({ action: 'cal.list', calDays: 3, calQuery: 'tea', calId: '2' })) &&
  K.phoneCmd({ action: 'cal.remove', calEvent: '17' }).event === 17 && K.phoneCmd({ action: 'cal.calendars' }).cmd === 'cal.calendars');
ok('cal lines', K.phoneLine({ src: 'cal', kind: 'calendar', id: 3, name: 'Home', account: 'me@x', writable: false }) === 'calendar 3 Home (me@x) · read only' &&
  K.phoneLine({ src: 'cal', kind: 'event', id: 9, start: Date.UTC(2026, 10, 2), allDay: true, title: 'Trip', where: 'Berlin' }) === 'event 9 2026-11-02 all day · Trip @ Berlin');
ok('rec.start: sources, rates, size', (c => c.cmd === 'rec.start' && c.name === 'walk' && c.subs === 'gps,wifi' && c.hz === 50 && c.wifiEvery === 5 && c.maxMb === 10 && !('cellEvery' in c))(
  K.phoneCmd({ action: 'rec.start', recName: ' walk ', recSubs: 'gps,wifi', recHz: 50, recWifi: 5, recMax: 10 })));
ok('rec.read / delete / export / stop / list', (c => c.cmd === 'rec.read' && c.file === 'a.jsonl' && c.offset === 100 && c.limit === 500)(K.phoneCmd({ action: 'rec.read', recFile: ' a.jsonl ', recOffset: '100' })) &&
  K.phoneCmd({ action: 'rec.delete', recFile: 'a.jsonl' }).file === 'a.jsonl' && K.phoneCmd({ action: 'rec.export', recFile: 'a.jsonl' }).cmd === 'rec.export' &&
  K.phoneCmd({ action: 'rec.stop' }).cmd === 'rec.stop' && K.phoneCmd({ action: 'rec.list' }).cmd === 'rec.list' && K.phoneCmd({ action: 'rec.status' }).cmd === 'rec.status');
ok('recording lines', K.phoneLine({ src: 'recording', kind: 'status', on: true, file: 'w.jsonl', lines: 12, bytes: 4096 }) === 'recording ON · w.jsonl · 12 lines, 4 kB' &&
  K.phoneLine({ src: 'recording', kind: 'file', file: 'w.jsonl', bytes: 2048, live: true }) === 'file w.jsonl · 2 kB · recording');
ok('callrec.set / status / stop', (c => c.cmd === 'callrec.set' && c.mode === 'auto' && c.src === 'downlink' && c.rate === 48000 && c.minSec === 5)(K.phoneCmd({ action: 'callrec.set', callMode: 'auto', callSrc: 'downlink', callRate: '48000', callMin: 5 })) &&
  K.phoneCmd({ action: 'callrec.set', callMode: 'off' }).mode === 'off' && K.phoneCmd({ action: 'callrec.status' }).cmd === 'callrec.status' && K.phoneCmd({ action: 'callrec.stop' }).cmd === 'callrec.stop');
ok('callrec lines', K.phoneLine({ src: 'callrec', mode: 'auto', source: 'voice_call', rate: 16000, root: true, active: true, file: 'call-1.wav', minSec: 3 }) === 'call recording on · voice_call 16000 Hz (root) · RECORDING call-1.wav · drops under 3 s' &&
  K.phoneLine({ src: 'sys', ev: 'callrec.stop', file: 'call-1.wav' }) === 'callrec.stop call-1.wav');
ok('media.list: window, EXIF, thumbs', (c => c.cmd === 'media.list' && c.kind === 'video' && c.q === 'trip' && c.exif === true && c.thumbs === true && c.thumbSize === 96 && c.from > 0 && c.limit === 50)(
  K.phoneCmd({ action: 'media.list', mediaKind: 'video', mediaQuery: ' trip ', mediaExif: true, mediaThumbs: true, mediaThumb: 96, mediaDays: 7 })) && !('from' in K.phoneCmd({ action: 'media.list', mediaDays: 0 })));
ok('media.read / thumb / save', (c => c.cmd === 'media.read' && c.media === 42 && c.offset === 100 && c.text === true)(K.phoneCmd({ action: 'media.read', mediaId: '42', fileOffset: '100', fileText: true })) &&
  K.phoneCmd({ action: 'media.thumb', mediaId: '7' }).media === 7 && K.phoneCmd({ action: 'media.save', fileName: 'a.csv', fileMime: 'text/csv', mediaFolder: 'walks' }, 'x,y').text === 'x,y' &&
  K.phoneCmd({ action: 'media.save', fileName: 'a.png', fileData: ' QUJD \n' }).data === 'QUJD');
ok('fs.*: grant, path, read, write', K.phoneCmd({ action: 'fs.pick' }).cmd === 'fs.pick' && K.phoneCmd({ action: 'fs.list', fsGrant: ' g1 ', fsPath: 'a/b' }).path === 'a/b' &&
  (c => c.grant === 'g1' && c.text === true && c.offset === 5)(K.phoneCmd({ action: 'fs.read', fsGrant: 'g1', fsPath: 'x.txt', fileText: true, fileOffset: '5' })) &&
  (c => c.append === true && c.text === 'hi' && c.mime === 'text/plain')(K.phoneCmd({ action: 'fs.write', fsGrant: 'g1', fsPath: 'x.txt', fileAppend: true, fileMime: 'text/plain' }, 'hi')) &&
  K.phoneCmd({ action: 'fs.delete', fsGrant: 'g1', fsPath: 'x.txt' }).cmd === 'fs.delete' && K.phoneCmd({ action: 'fs.mkdir', fsGrant: 'g1', fsPath: 'd' }).path === 'd' && K.phoneCmd({ action: 'fs.revoke', fsGrant: 'g1' }).grant === 'g1');
ok('media / fs lines', K.phoneLine({ src: 'media', kind: 'images', id: 5, name: 'a.jpg', size: 2048, lat: 52.5, lon: 13.4 }) === 'images 5 a.jpg · 2 kB · 52.5, 13.4' &&
  K.phoneLine({ src: 'fs', kind: 'grant', grant: 'g1', name: 'DSP' }) === 'folder g1 DSP' && K.phoneLine({ src: 'fs', kind: 'dir', path: 'a' }) === 'dir a' && K.phoneLine({ src: 'fs', kind: 'file', path: 'a/b.txt', size: 1024 }) === 'file a/b.txt · 1 kB' &&
  K.phoneLine({ src: 'fs', kind: 'data', id: 'a', n: 10, offset: 0, eof: true }) === 'file a · 10 bytes from 0 · end');
ok('ussd.send: code and SIM slot', (c => c.cmd === 'ussd.send' && c.code === '*100#' && c.sim === 1)(K.phoneCmd({ action: 'ussd.send', ussdCode: ' *100# ', ussdSim: '1' })) &&
  !('sim' in K.phoneCmd({ action: 'ussd.send', ussdCode: '*100#', ussdSim: '' })) && K.phoneCmd({ action: 'ussd.send', ussdCode: '*100#', ussdSim: '0' }).sim === 0 && K.phoneCmd({ action: 'ussd.sims' }).cmd === 'ussd.sims');
ok('call.dial / end / answer', (c => c.cmd === 'call.dial' && c.number === '+79001234567' && c.direct === true)(K.phoneCmd({ action: 'call.dial', dialNumber: ' +79001234567 ', dialDirect: true })) &&
  K.phoneCmd({ action: 'call.dial', dialNumber: '112' }).direct === false && K.phoneCmd({ action: 'call.end' }).cmd === 'call.end' && K.phoneCmd({ action: 'call.answer' }).cmd === 'call.answer');
ok('ussd / sim lines', K.phoneLine({ src: 'ussd', code: '*100#', ok: true, text: 'Balance:\n12.50 RUB' }) === 'USSD *100# → Balance: 12.50 RUB' &&
  K.phoneLine({ src: 'ussd', code: '*100#', ok: false, failure: 'service unavailable' }) === 'USSD *100# failed: service unavailable' && K.phoneLine({ src: 'sim', slot: 0, id: 3, name: 'MTS' }) === 'SIM slot 0 (subscription 3) MTS');
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
