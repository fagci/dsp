// Проверка modules/rowlabel-kernels.js: подписи строк параметров — укорачивание, префикс секции, дубли.
import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../modules/rowlabel-kernels.js', import.meta.url), 'utf8') + '\nthis.K={shortLabel,rowLabelNoGroup,paramRowLabels}', ctx);
const K = ctx.K, L = (ps, g) => K.paramRowLabels(ps, g), T = (ps, g) => L(ps, g).map(r => r.text + (r.unit ? ' [' + r.unit + ']' : '')).join(' | ');

ok('short label: brackets and explanations go', K.shortLabel('hold time, s (0 — off): how long the squelch stays open') === 'hold time, s' && K.shortLabel('mode — pick one of the three') === 'mode');
ok('a short label stays, unit moves out', T([{ n: 'bw', t: 'range', label: 'bandwidth, Hz' }, { n: 'm', t: 'select', label: 'mode' }]) === 'bandwidth [Hz] | mode');
ok('same name, different units: the unit stays in the label', T([{ n: 'f', t: 'range2', label: 'range, Hz' }, { n: 'd', t: 'range2', label: 'range, dB' }]) === 'range, Hz | range, dB');
ok('same name, no units: the tail tells them apart', T([{ n: 'tiles', t: 'select', label: 'tiles' }, { n: 'fb', t: 'check', label: 'tiles: if the server refuses (403 / 429), take a spare map' }]) === 'tiles | tiles · if the server refuses');
ok('same unit twice: tails, not units', T([{ n: 'a', t: 'range', label: 'set volume, % (empty — use the level below)' }, { n: 'b', t: 'num', label: 'set volume, level (phone-specific steps)' }]) === 'set volume, % | set volume, level');
ok('short wins and is not renamed', T([{ n: 'a', t: 'check', label: 'tiles', short: 'tiles' }, { n: 'b', t: 'check', label: 'tiles: a spare map when the server refuses to answer' }]) === 'tiles | tiles · a spare map when the');
ok('nothing left to tell apart: the param name', T([{ n: 'a', t: 'check', label: 'gain' }, { n: 'b', t: 'check', label: 'gain' }]) === 'gain | gain · b');
ok('group prefix goes', K.rowLabelNoGroup('alarm: time HH:MM', 'Alarm') === 'time HH:MM' && K.rowLabelNoGroup('notification: title', 'Notify / vibrate / torch') === 'title' &&
  K.rowLabelNoGroup('speech: interim results', 'Speech') === 'interim results' && K.rowLabelNoGroup('screen recording: bitrate', 'Screen recording') === 'bitrate');
ok('a foreign prefix stays', K.rowLabelNoGroup('vibrate: duration', 'Alarm') === 'vibrate: duration' && K.rowLabelNoGroup('mode: fast', '') === 'mode: fast' && K.rowLabelNoGroup('read: from byte', 'Folders / files') === 'read: from byte');
ok('more: only when something is hidden', (r => r[0].more === false && r[1].more === true && r[2].more === true && r[3].more === false)(L([{ n: 'a', t: 'check', label: 'grid' },
  { n: 'b', t: 'check', label: 'labels of the points on the map (name and time)' }, { n: 'c', t: 'check', label: 'x', tip: 'long text' }, { n: 'd', t: 'range', label: 'bandwidth, Hz' }])));
ok('full text is kept', L([{ n: 'a', t: 'text', label: 'alarm: days — mon,wed,fri / weekdays' }], 'Alarm')[0].full === 'alarm: days — mon,wed,fri / weekdays' && T([{ n: 'a', t: 'text', label: 'alarm: days — mon,wed,fri / weekdays' }], 'Alarm') === 'days');
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
