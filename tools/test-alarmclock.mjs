// Проверка modules/alarmclock-kernels.js: дни/время, команды alarm.set/test, нормализация записей моста, строки readout, «ближайший».
import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const ctx = vm.createContext({ Math, Number, String, Object, Array, JSON, RegExp });
const load = f => vm.runInContext(fs.readFileSync(new URL('../modules/' + f, import.meta.url), 'utf8'), ctx);
load('alarmclock-kernels.js');
vm.runInContext('this.K={AL_DAYS_OPTS,alDays,alTime,alSetCmd,alToggleCmd,alRow,alLine,alSort,alInText,alNextText}', ctx);
const K = ctx.K;

ok('days: select as is, once — empty', K.alDays({ days: 'weekdays' }) === 'weekdays' && K.alDays({ days: 'once' }) === '' && K.alDays({}) === 'weekdays');
ok('days: custom cleaned, ordered mon..sun, no dupes', K.alDays({ days: 'custom', daysCustom: 'Fri, monday! wed; mon' }) === 'mon,wed,fri' &&
  K.alDays({ days: 'custom', daysCustom: 'sun,sat' }) === 'sat,sun' && K.alDays({ days: 'custom', daysCustom: 'xxx' }) === '');
ok('time: H:MM, leading zero, garbage refused', K.alTime('7:30').join() === '7,30' && K.alTime(' 07:05 ').join() === '7,5' &&
  K.alTime('24:00') === null && K.alTime('7:99') === null && K.alTime('morning') === null && K.alTime('') === null);

const set = K.alSetCmd({ name: ' wake ', time: '6:45', days: 'weekdays', label: 'Good morning', stream: ' https://r.example/live ', sample: 'beep', vol: 70, ramp: 30, loadSec: 8, snoozeMin: 5, maxMin: 10 });
ok('alarm.set: all fields, trimmed, padded', set.cmd === 'alarm.set' && set.name === 'wake' && set.time === '6:45' && set.days === 'weekdays' &&
  set.label === 'Good morning' && set.url === 'https://r.example/live' && set.sample === 'beep' && set.vol === 70 && set.ramp === 30 &&
  set.loadSec === 8 && set.snoozeMin === 5 && set.maxMin === 10, JSON.stringify(set));
ok('alarm.set: defaults, vol 0 not sent, empty name dropped', (c => c.sample === 'default' && !('vol' in c) && !('name' in c) && c.days === '' && c.ramp === 0 && c.loadSec === 12 && c.snoozeMin === 9 && c.maxMin === 15)(
  K.alSetCmd({ time: '7:00', days: 'once', name: ' ', sample: ' ', vol: 0 })));
ok('alarm.set: bad time / bad custom days / bad stream refused', K.alSetCmd({ time: 'soon' }).error && K.alSetCmd({ time: '7:00', days: 'custom', daysCustom: 'zzz' }).error &&
  K.alSetCmd({ time: '7:00', stream: 'ftp://x' }).error && !K.alSetCmd({ time: '7:00', stream: '' }).error);

ok('toggle: off → on and back, only name+enabled', (c => c.cmd === 'alarm.set' && c.name === 'wake' && c.enabled === true && Object.keys(c).length === 3)(K.alToggleCmd({ name: 'wake', enabled: false })) &&
  K.alToggleCmd({ name: 'wake', enabled: true }).enabled === false);

const row = K.alRow({ src: 'alarm', name: 'wake', time: '07:00', days: 'weekdays', label: 'L', url: 'http://x', sample: 'default', enabled: true, next: '12345' });
ok('row: types normalized', row.name === 'wake' && row.enabled === true && row.next === 12345 && K.alRow({ name: 'a', enabled: 'false' }).enabled === false &&
  K.alRow({}).next === 0 && K.alRow({}).sample === '');

ok('lines: cmd ok / failed, row, alarm event, foreign sys skipped', K.alLine({ src: 'cmd', cmd: 'alarm.set', ok: true }) === 'alarm.set ok' &&
  K.alLine({ src: 'cmd', cmd: 'alarm.list', ok: true, n: 3 }) === 'alarm.list ok · 3' &&
  K.alLine({ src: 'cmd', cmd: 'alarm.set', ok: false, msg: 'time: HH:MM' }) === 'alarm.set failed: time: HH:MM' &&
  K.alLine({ src: 'alarm', name: 'wake', time: '07:00', days: 'weekdays', enabled: false, label: 'L' }) === '07:00 wake · weekdays (off) · L' &&
  K.alLine({ src: 'sys', ev: 'alarm.fallback', id: 'wake', why: 'timeout' }) === 'alarm.fallback wake · timeout' &&
  K.alLine({ src: 'sys', ev: 'screen.on' }) === null && K.alLine({ src: 'other' }) === null);

ok('sort by time then name', K.alSort([{ time: '8:00', name: 'b' }, { time: '7:00', name: 'z' }, { time: '8:00', name: 'a' }]).map(a => a.name).join() === 'z,a,b');

const now = Date.UTC(2026, 9, 31, 6, 0);
ok('in: hours and minutes, minutes only, past — empty', K.alInText(now + 6 * 3600000 + 12 * 60000, now) === 'in 6 h 12 min' &&
  K.alInText(now + 6 * 3600000, now) === 'in 6 h' && K.alInText(now + 45 * 60000, now) === 'in 45 min' &&
  K.alInText(now + 1000, now) === 'in less than a minute' && K.alInText(now - 60000, now) === '');
ok('next: nearest enabled, off/zero skipped', K.alNextText([
  { name: 'off', time: '6:00', days: 'daily', enabled: false, next: now + 60000 },
  { name: 'far', time: '9:00', days: 'weekdays', enabled: true, next: now + 3 * 3600000 },
  { name: 'near', time: '7:00', days: 'once', enabled: true, next: now + 3600000 },
], now) === '7:00 · near · in 1 h' && K.alNextText([{ name: 'x', enabled: false, next: 0 }], now) === '');

console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
